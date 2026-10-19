import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { procKill, procStart } from "../lib/proc";
import type { ProcChunk, ProcExit, ProcSessionId } from "../lib/proc";
import { ensureHelper, missingTool, resolveCommand } from "../lib/runConfigs";
import type { RunConfiguration } from "../lib/runConfigs";
import { joinPath, samePath } from "../lib/format";
import { ChunkBuffer } from "../lib/chunkBuffer";
import { decodeChunk } from "../lib/term";
import { formatStamp, stampBytes } from "../lib/runStamps";
import type { StampState } from "../lib/runStamps";
import { useI18n } from "../i18n";
import { useSettings } from "./useSettings";
import { codedError, describeError } from "../lib/errors";
import type { RunConfigController } from "./useRunConfigs";

/** 跑完的会话也留在列表里，直到手动关掉，跟 IDEA 一样。 */
export type SessionStatus = "running" | "done" | "failed" | "stopped";

export interface RunSession {
  id: ProcSessionId;
  /** 所属的工作区根目录。 */
  root: string;
  /** 配置名，会话标签上显示的就是它。 */
  name: string;
  kind: RunConfiguration["kind"];
  /** 实际跑的那一行：占位已经按本机展开过。 */
  command: string;
  /** 是哪条配置跑出来的；页签上的「重新运行」要拿它重发一次。 */
  config: RunConfiguration;
  /** 进程实际跑在哪个目录（相对工作目录已按根展开）。运行输出里的相对路径按它解析。 */
  dir: string;
  status: SessionStatus;
  /** 结束时的退出码；被终止时拿不到码为 null。 */
  exit: number | null;
}

/** 输出订阅：控制台只在被看着的那一个会话上写字。 */
export type AppendListener = (id: ProcSessionId, chunk: Uint8Array) => void;

const ENCODER = new TextEncoder();

/**
 * 每个会话留着的输出上限，按字节算。
 *
 * 原来按块数封顶（500 块），而后端一块最多 32KB，跑得久的 dev server 就是 16MB 一条会话，
 * 且每条会话各占一份——多项目常驻时这部分是跟着会话数线性涨的。
 * 改成按字节封顶：1MB 已经比 xterm 那 8000 行滚屏能显示的多，切会话重放看到的仍是完整的一屏。
 */
const MAX_SESSION_BYTES = 1_000_000;
/** 块数上限：输出碎成几十字节一块时，兜住数组本身的长度。 */
const MAX_SESSION_CHUNKS = 4_000;

/** 归一化工作区根键，大小写与斜杠不敏感。 */
function rootKey(root: string | null): string {
  return root ? root.replaceAll("\\", "/").toLocaleLowerCase() : "";
}

/**
 * 运行会话的全部状态。控件在主工具栏、输出在底部工具窗口，两边都要拿到同一份，
 * 所以状态挂在 App 上，面板收起也不影响进程继续跑。
 *
 * 只管跑与不跑。「有哪些配置、选哪条」在 `useRunConfigs`，那一份是配置层的事。
 * 多工作区常驻时，各根的运行会话并存，切根不杀进程，只按当前激活根过滤展示。
 */
export function useRunSessions(configs: RunConfigController) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const cwd = configs.workspace;
  // 事件回调只在挂载时注册一次，取文案要走最新的翻译。
  const tRef = useRef(t);
  tRef.current = t;
  /** 每块输出收到时刻的盖章开关，跟着设置走；读最新值不重挂 effect。 */
  const stampsOnRef = useRef(settings.run.timestamps);
  stampsOnRef.current = settings.run.timestamps;
  /** 每个会话盖到第几行了（块边界落在行中间时靠它续上）。见 `stampBytes`。 */
  const stampsRef = useRef(new Map<ProcSessionId, StampState>());
  /** 「输出被清空」的订阅者：面板擦画面上那份，控制器管的是缓冲。 */
  const clearedListenersRef = useRef(new Set<(id: ProcSessionId) => void>());
  /** 每个会话收到过的原始字节，切会话时整体重放进唯一的终端。按字节封顶，见 `ChunkBuffer`。 */
  const buffersRef = useRef(new Map<ProcSessionId, ChunkBuffer>());
  const listenersRef = useRef(new Set<AppendListener>());
  /** 用户主动终止过的会话，退出事件靠它区分「已停止」和「跑挂了」。 */
  const killedRef = useRef(new Set<ProcSessionId>());
  const [allSessions, setAllSessions] = useState<RunSession[]>([]);
  const sessionsRef = useRef<RunSession[]>([]);
  sessionsRef.current = allSessions;
  const [activeIdByRoot, setActiveIdByRoot] = useState<Record<string, ProcSessionId | null>>({});
  /** 启动失败的原因，按根存放；跑起来后清空。 */
  const [errorByRoot, setErrorByRoot] = useState<Record<string, string | null>>({});

  const append = useCallback((id: ProcSessionId, raw: Uint8Array) => {
    // 收到时刻先盖章再入缓冲：缓冲和画面看到的是同一份字节，切会话重放也不掉戳。
    let chunk = raw;
    if (stampsOnRef.current) {
      let state = stampsRef.current.get(id);
      if (!state) {
        state = { atLineStart: true };
        stampsRef.current.set(id, state);
      }
      chunk = stampBytes(raw, state, formatStamp(new Date()));
    }
    const buffer = buffersRef.current.get(id);
    if (buffer) {
      // 上限淘汰最老的块：切会话时重放的是"最近一段"而不是全部历史。
      buffer.append(chunk);
    } else {
      buffersRef.current.set(id, new ChunkBuffer(MAX_SESSION_BYTES, MAX_SESSION_CHUNKS));
      buffersRef.current.get(id)?.append(chunk);
    }
    for (const listener of listenersRef.current) listener(id, chunk);
  }, []);

  const appendText = useCallback(
    (id: ProcSessionId, text: string) => append(id, ENCODER.encode(text)),
    [append]
  );

  /** 会话没了：输出缓冲和盖章状态一起丢，别在 map 里留空壳。 */
  const dropBuffer = useCallback((id: ProcSessionId) => {
    buffersRef.current.delete(id);
    stampsRef.current.delete(id);
  }, []);

  const onAppend = useCallback((listener: AppendListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  /** 订阅「某条会话的输出被清空」；返回退订函数。 */
  const onClear = useCallback((listener: (id: ProcSessionId) => void) => {
    clearedListenersRef.current.add(listener);
    return () => {
      clearedListenersRef.current.delete(listener);
    };
  }, []);

  // 输出事件与退出事件跟着应用注册一次，不跟着面板的开关走。
  useEffect(() => {
    let disposed = false;
    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    void listen<ProcChunk>("proc://output", (event) => {
      append(event.payload.id, decodeChunk(event.payload.data));
    }).then((off) => {
      if (disposed) off();
      else unlistenOutput = off;
    });
    void listen<ProcExit>("proc://exit", (event) => {
      const { id, code } = event.payload;
      const stopped = killedRef.current.has(id);
      appendText(
        id,
        `\r\n${code === null || stopped ? tRef.current("run.killed") : tRef.current("run.finished", { code })}\r\n`
      );
      setAllSessions((list) =>
        list.map((session) =>
          session.id === id
            ? {
                ...session,
                status: stopped ? "stopped" : code === 0 ? "done" : "failed",
                exit: code,
              }
            : session
        )
      );
    }).then((off) => {
      if (disposed) off();
      else unlistenExit = off;
    });
    return () => {
      disposed = true;
      unlistenOutput?.();
      unlistenExit?.();
    };
  }, [append, appendText]);

  const stop = useCallback((id: ProcSessionId | null) => {
    if (!id) return;
    killedRef.current.add(id);
    void procKill(id);
  }, []);

  /**
   * 跑一条配置。先把占位展开、辅助文件落盘，再交给进程通道。
   * 这两步任一步失败都不该留下一个跑了一半的会话，所以都在 invoke 之前做完。
   *
   * 同一工作区下的同一个启动项（按 `config.id` 识别）永远复用已有的会话窗口/页签：
   * 若已有同名同 ID 的会话（无论正在运行还是已结束），先停掉旧进程并就地替换，不重复开新窗口。
   */
  const startInto = useCallback(
    (config: RunConfiguration, replaceId: ProcSessionId | null, explicitRoot?: string) => {
      const targetRoot = explicitRoot ?? cwd;
      if (!targetRoot) return;
      const key = rootKey(targetRoot);
      setErrorByRoot((prev) => ({ ...prev, [key]: null }));
      const missing = missingTool(config.command, configs.tools);
      if (missing) {
        setErrorByRoot((prev) => ({
          ...prev,
          [key]: describeError(codedError("NO_TOOL", missing.replace(/[${}]/g, "")), t),
        }));
        return;
      }

      // 查找当前工作区下属于同一启动项的已有会话：停掉还在跑的旧实例并准备复用槽位。
      // 注意：不要在启动前过早删除旧会话终端 Buffer，避免异步期间终端白屏闪烁或启动失败导致历史丢失。
      const existingSameConfig = sessionsRef.current.filter(
        (item) => samePath(item.root, targetRoot) && item.config.id === config.id
      );
      for (const old of existingSameConfig) {
        if (old.status === "running") stop(old.id);
      }
      const effectiveReplaceId = replaceId ?? existingSameConfig[0]?.id ?? null;

      const command = resolveCommand(config.command, configs.tools);
      const dir = config.workingDir ? joinPath(targetRoot, config.workingDir) : targetRoot;
      void (async () => {
        if (config.helper) await ensureHelper(config.helper);
        return procStart(dir, command, config.env);
      })().then(
        (id) => {
          // 后端可能在 promise 落地前就吐了首块输出，命令行补在最前面，保留已到达的输出。
          const existing = buffersRef.current.get(id);
          const buffer = existing ?? new ChunkBuffer(MAX_SESSION_BYTES, MAX_SESSION_CHUNKS);
          buffer.prepend(ENCODER.encode(`$ ${command}\r\n`));
          buffersRef.current.set(id, buffer);
          const entry: RunSession = {
            id,
            root: targetRoot,
            name: config.name,
            kind: config.kind,
            command,
            config,
            dir,
            status: "running",
            exit: null,
          };
          setAllSessions((list) => {
            // 优先按 effectiveReplaceId 或同一工作区 + 同一 config.id 原位替换，同时剔除可能残留的重复项。
            const index = list.findIndex(
              (session) =>
                (effectiveReplaceId !== null && session.id === effectiveReplaceId) ||
                (samePath(session.root, targetRoot) && session.config.id === config.id)
            );
            if (index < 0) return [...list, entry];
            const next: RunSession[] = [];
            let replaced = false;
            for (let i = 0; i < list.length; i++) {
              const item = list[i];
              const isSameTarget =
                (effectiveReplaceId !== null && item.id === effectiveReplaceId) ||
                (samePath(item.root, targetRoot) && item.config.id === config.id);
              if (isSameTarget) {
                if (!replaced) {
                  next.push(entry);
                  replaced = true;
                  // 新实例成功上屏后，再安全清理旧会话的终端缓存
                  if (item.id !== id) {
                    dropBuffer(item.id);
                  }
                } else {
                  if (item.status === "running") stop(item.id);
                  dropBuffer(item.id);
                }
              } else {
                next.push(item);
              }
            }
            return next;
          });
          setActiveIdByRoot((prev) => ({ ...prev, [key]: id }));
        },
        (cause: unknown) =>
          setErrorByRoot((prev) => ({
            ...prev,
            [key]: describeError(cause instanceof Error ? cause.message : String(cause), t),
          }))
      );
    },
    [configs, cwd, dropBuffer, stop, t]
  );

  const start = useCallback(
    (config: RunConfiguration, explicitRoot?: string) => startInto(config, null, explicitRoot),
    [startInto]
  );

  /**
   * 重开一条会话：先停掉它，再在同一位置起一条新的。
   *
   * 与 IDEA 的 `performRestart` 一致——复用原来的那个运行槽位（标签页），不是新开一个。
   */
  const restartSession = useCallback(
    (id: ProcSessionId) => {
      const session = sessionsRef.current.find((item) => item.id === id);
      if (!session) return;
      if (session.status === "running") stop(id);
      dropBuffer(id);
      startInto(session.config, id, session.root);
    },
    [dropBuffer, startInto, stop]
  );

  const closeSession = useCallback(
    (id: ProcSessionId) => {
      const list = sessionsRef.current;
      const session = list.find((item) => item.id === id);
      if (!session) return;
      if (session.status === "running") stop(id);
      dropBuffer(id);
      // kill 标记也要跟着会话走，不然手动关签后这条 id 永久留在集合里。
      killedRef.current.delete(id);
      const rest = list.filter((item) => item.id !== id);
      const restSameRoot = rest.filter((item) => samePath(item.root, session.root));
      const key = rootKey(session.root);
      setAllSessions(rest);
      setActiveIdByRoot((prev) =>
        prev[key] === id
          ? {
              ...prev,
              [key]: restSameRoot.length > 0 ? restSameRoot[restSameRoot.length - 1].id : null,
            }
          : prev
      );
    },
    [dropBuffer, stop]
  );

  /** 清空指定工作区根下的全部运行会话（关闭文件夹或点击当前根「清空全部」时调用）。 */
  const closeSessionsForRoot = useCallback(
    (targetRoot: string) => {
      const doomed = sessionsRef.current.filter((item) => samePath(item.root, targetRoot));
      for (const session of doomed) {
        if (session.status === "running") stop(session.id);
        dropBuffer(session.id);
        killedRef.current.delete(session.id);
      }
      const key = rootKey(targetRoot);
      setAllSessions((list) => list.filter((item) => !samePath(item.root, targetRoot)));
      setActiveIdByRoot((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setErrorByRoot((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [dropBuffer, stop]
  );

  const clearAll = useCallback(() => {
    if (!cwd) return;
    closeSessionsForRoot(cwd);
  }, [closeSessionsForRoot, cwd]);

  /**
   * 清空某条会话已经攒下的输出，会话本身留着继续跑（照 IDEA 的「Clear run output」）。
   * 缓冲整个丢掉，下一条输出来了从头记；面板订阅 `onClear` 把画面上那份也擦掉。
   */
  const clearOutput = useCallback(
    (id: ProcSessionId) => {
      buffersRef.current.delete(id);
      stampsRef.current.set(id, { atLineStart: true });
      for (const listener of clearedListenersRef.current) listener(id);
    },
    []
  );

  /** 指定工作区根下是否有正在运行的任务（供顶栏工程切换器绿点与关闭前确认使用）。 */
  const hasRunningSessionsForRoot = useCallback(
    (targetRoot: string) =>
      allSessions.some((item) => samePath(item.root, targetRoot) && item.status === "running"),
    [allSessions]
  );

  const sessions = useMemo(
    () => (cwd ? allSessions.filter((item) => samePath(item.root, cwd)) : []),
    [allSessions, cwd]
  );

  const currentKey = rootKey(cwd);
  const rawActiveId = cwd ? (activeIdByRoot[currentKey] ?? null) : null;
  const activeId =
    rawActiveId && sessions.some((item) => item.id === rawActiveId)
      ? rawActiveId
      : (sessions[sessions.length - 1]?.id ?? null);

  const setActiveId = useCallback(
    (next: ProcSessionId | null | ((prev: ProcSessionId | null) => ProcSessionId | null)) => {
      if (!cwd) return;
      const key = rootKey(cwd);
      setActiveIdByRoot((prev) => {
        const cur = prev[key] ?? null;
        const resolved = typeof next === "function" ? next(cur) : next;
        return { ...prev, [key]: resolved };
      });
    },
    [cwd]
  );

  const error = cwd ? (errorByRoot[currentKey] ?? null) : null;
  const activeSession = sessions.find((session) => session.id === activeId) ?? null;
  const activeRunning = activeSession?.status === "running";

  // 主动停止的会话哪怕拿到了退出码，也按「已停止」报，不说成是脚本自己跑挂。
  const notice =
    error ??
    (activeSession
      ? activeSession.status === "running"
        ? t("run.running")
        : activeSession.status === "stopped" || activeSession.exit === null
          ? t("run.stopped")
          : t("run.exited", { code: activeSession.exit })
      : null);

  /** 某个会话收到过的全部输出，控制台重放用。 */
  const bufferOf = useCallback(
    (id: ProcSessionId) => buffersRef.current.get(id)?.toArray() ?? [],
    []
  );

  return useMemo(
    () => ({
      sessions,
      allSessions,
      activeId,
      setActiveId,
      activeSession,
      activeRunning,
      notice,
      error,
      start,
      stop,
      restartSession,
      clearAll,
      clearOutput,
      closeSession,
      closeSessionsForRoot,
      hasRunningSessionsForRoot,
      onAppend,
      onClear,
      bufferOf,
    }),
    [
      activeId,
      activeRunning,
      activeSession,
      allSessions,
      bufferOf,
      clearAll,
      clearOutput,
      closeSession,
      closeSessionsForRoot,
      error,
      hasRunningSessionsForRoot,
      notice,
      onAppend,
      onClear,
      restartSession,
      sessions,
      setActiveId,
      start,
      stop,
    ]
  );
}

export type RunController = ReturnType<typeof useRunSessions>;
