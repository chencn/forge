import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { procKill, procStart } from "../lib/proc";
import type { ProcChunk, ProcExit, ProcSessionId } from "../lib/proc";
import { ensureHelper, missingTool, resolveCommand } from "../lib/runConfigs";
import type { RunConfiguration } from "../lib/runConfigs";
import { joinPath } from "../lib/format";
import { decodeChunk } from "../lib/term";
import { useI18n } from "../i18n";
import { codedError, describeError } from "../lib/errors";
import type { RunConfigController } from "./useRunConfigs";

/** 跑完的会话也留在列表里，直到手动关掉，跟 IDEA 一样。 */
export type SessionStatus = "running" | "done" | "failed" | "stopped";

export interface RunSession {
  id: ProcSessionId;
  /** 配置名，会话标签上显示的就是它。 */
  name: string;
  kind: RunConfiguration["kind"];
  /** 实际跑的那一行：占位已经按本机展开过。 */
  command: string;
  /** 是哪条配置跑出来的；页签上的「重新运行」要拿它重发一次。 */
  config: RunConfiguration;
  status: SessionStatus;
  /** 结束时的退出码；被终止时拿不到码为 null。 */
  exit: number | null;
}

/** 输出订阅：控制台只在被看着的那一个会话上写字。 */
export type AppendListener = (id: ProcSessionId, chunk: Uint8Array) => void;

const ENCODER = new TextEncoder();

/** 每个会话的输出块上限：dev server 挂几小时的话，无上限的 push 会把 WebView 撑爆。
 * 与 termStore 的 MAX_SESSION_CHUNKS 同一套取舍——留最新的，老的淘汰。 */
const MAX_SESSION_CHUNKS = 500;

/**
 * 运行会话的全部状态。控件在主工具栏、输出在底部工具窗口，两边都要拿到同一份，
 * 所以状态挂在 App 上，面板收起也不影响进程继续跑。
 *
 * 只管跑与不跑。「有哪些配置、选哪条」在 `useRunConfigs`，那一份是配置层的事。
 */
export function useRunSessions(configs: RunConfigController) {
  const { t } = useI18n();
  const cwd = configs.workspace;
  // 事件回调只在挂载时注册一次，取文案要走最新的翻译。
  const tRef = useRef(t);
  tRef.current = t;
  /** 每个会话收到过的原始字节，切会话时整体重放进唯一的终端。 */
  const buffersRef = useRef(new Map<ProcSessionId, Uint8Array[]>());
  const listenersRef = useRef(new Set<AppendListener>());
  /** 用户主动终止过的会话，退出事件靠它区分「已停止」和「跑挂了」。 */
  const killedRef = useRef(new Set<ProcSessionId>());
  const [sessions, setSessions] = useState<RunSession[]>([]);
  const sessionsRef = useRef<RunSession[]>([]);
  sessionsRef.current = sessions;
  const [activeId, setActiveId] = useState<ProcSessionId | null>(null);
  /** 启动失败的原因；跑起来后清空。 */
  const [error, setError] = useState<string | null>(null);

  const append = useCallback((id: ProcSessionId, chunk: Uint8Array) => {
    const buffer = buffersRef.current.get(id);
    if (buffer) {
      buffer.push(chunk);
      // 上限淘汰最老的块：切会话时重放的是"最近一段"而不是全部历史。
      if (buffer.length > MAX_SESSION_CHUNKS) {
        buffer.splice(0, buffer.length - MAX_SESSION_CHUNKS);
      }
    } else {
      buffersRef.current.set(id, [chunk]);
    }
    for (const listener of listenersRef.current) listener(id, chunk);
  }, []);

  const appendText = useCallback(
    (id: ProcSessionId, text: string) => append(id, ENCODER.encode(text)),
    [append]
  );

  const onAppend = useCallback((listener: AppendListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
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
      setSessions((list) =>
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

  // 换工程：上一批进程先终止，缓冲区清空。配置层自己会重扫。
  useEffect(() => {
    for (const session of sessionsRef.current) {
      if (session.status === "running") stop(session.id);
    }
    buffersRef.current.clear();
    killedRef.current.clear();
    setSessions([]);
    setActiveId(null);
    setError(null);
  }, [cwd, stop]);

  /**
   * 跑一条配置。先把占位展开、辅助文件落盘，再交给进程通道。
   * 这两步任一步失败都不该留下一个跑了一半的会话，所以都在 invoke 之前做完。
   */
  const startInto = useCallback(
    (config: RunConfiguration, replaceId: ProcSessionId | null) => {
      if (!cwd) return;
      setError(null);
      const missing = missingTool(config.command, configs.tools);
      if (missing) {
        setError(describeError(codedError("NO_TOOL", missing.replace(/[${}]/g, "")), t));
        return;
      }
      const command = resolveCommand(config.command, configs.tools);
      const dir = config.workingDir ? joinPath(cwd, config.workingDir) : cwd;
      void (async () => {
        if (config.helper) await ensureHelper(config.helper);
        return procStart(dir, command, config.env);
      })().then(
        (id) => {
          // 后端可能在 promise 落地前就吐了首块输出，命令行只能补在前面。
          buffersRef.current.set(id, [ENCODER.encode(`$ ${command}\r\n`)]);
          const entry: RunSession = {
            id,
            name: config.name,
            kind: config.kind,
            command,
            config,
            status: "running",
            exit: null,
          };
          setSessions((list) => {
            if (replaceId === null) return [...list, entry];
            // 重跑就地替换：IDEA 的 restart 在原标签页上重开，不新开一个。
            const index = list.findIndex((session) => session.id === replaceId);
            if (index < 0) return [...list, entry];
            const next = list.slice();
            next[index] = entry;
            return next;
          });
          setActiveId(id);
        },
        (cause: unknown) =>
          setError(
            describeError(cause instanceof Error ? cause.message : String(cause), t)
          )
      );
    },
    [configs, cwd, t]
  );

  const start = useCallback(
    (config: RunConfiguration) => startInto(config, null),
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
      buffersRef.current.delete(id);
      startInto(session.config, id);
    },
    [startInto, stop]
  );

  const closeSession = useCallback(
    (id: ProcSessionId) => {
      const list = sessionsRef.current;
      const session = list.find((item) => item.id === id);
      if (session?.status === "running") stop(id);
      buffersRef.current.delete(id);
      const rest = list.filter((item) => item.id !== id);
      setSessions(rest);
      setActiveId((current) =>
        current === id ? (rest.length > 0 ? rest[rest.length - 1].id : null) : current
      );
    },
    [stop]
  );

  const clearAll = useCallback(() => {
    for (const session of sessionsRef.current) {
      if (session.status === "running") stop(session.id);
      buffersRef.current.delete(session.id);
    }
    killedRef.current.clear();
    setSessions([]);
    setActiveId(null);
  }, [stop]);

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
    (id: ProcSessionId) => buffersRef.current.get(id) ?? [],
    []
  );

  return useMemo(
    () => ({
      sessions,
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
      closeSession,
      onAppend,
      bufferOf,
    }),
    [
      activeId,
      activeRunning,
      activeSession,
      bufferOf,
      clearAll,
      closeSession,
      error,
      notice,
      onAppend,
      restartSession,
      sessions,
      start,
      stop,
    ]
  );
}

export type RunController = ReturnType<typeof useRunSessions>;
