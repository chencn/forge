import { useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { stopWorkspaceWatch, watchWorkspace } from "../lib/fs";
import { isBulkArtifactPath } from "../lib/watchBatch";

/** 后端已经并过一次批，这里再并一次：一次保存会连着来好几条事件，别让它抖着手感。 */
const COALESCE_MS = 120;

/**
 * 批量新增/删除风暴（如 `npm install`、大目录删除、构建产物写入）时的静默等待窗口：
 * 后端每 1000ms（MAX_WAIT）会推送一次积攒批次，静默期设为 1200ms 可确保在持续写入/删除期间
 * 暂停刷新，等整个安装或删除事件流结束后再一次性触发文件管理器刷新。
 */
const STORM_SETTLE_MS = 1200;
/** 持续写入风暴下的最长挂起上限，防止无限期不刷新。 */
const STORM_MAX_WAIT_MS = 6000;
/** 单批路径数达到该阈值即视为批量文件增删事件。 */
const STORM_PATH_THRESHOLD = 10;

interface FsChangePayload {
  /** 变更所属的工作区根目录（与 watchWorkspace 入参一致）。 */
  root: string;
  /** 受影响的路径，绝对路径，分隔符按平台原样。 */
  paths: string[];
}

interface RootBatchState {
  paths: Set<string>;
  chunks: number;
  firstAt: number;
  bulk: boolean;
}

/**
 * 同时盯住所有已打开的工作区目录，把磁盘上发生的改动按所属根成批交给调用方。
 * 新增根启动监听、移除根停止监听，已存在的根不重复重启，卸载时全部停掉。
 */
export function useFileWatch(
  roots: string[],
  onChange: (root: string, paths: string[], bulk: boolean) => void
) {
  const handler = useRef(onChange);
  handler.current = onChange;
  /** 本轮监听的代号：每次新监听递增，start/stop 都带着它，后端只认不落伍的请求。 */
  const generation = useRef(0);
  /** 当前已注册监听的根 → 代号，用于增量增删。 */
  const activeMap = useRef<Map<string, number>>(new Map());
  const rootsKey = useMemo(() => roots.join("\n"), [roots]);

  // 订阅一份全局 `fs://change`，按 payload.root 分桶防抖派发；遇到批量增删风暴时自动延后到事件结束。
  useEffect(() => {
    const batches = new Map<string, RootBatchState>();
    const timers = new Map<string, number>();
    let detach: (() => void) | null = null;
    let cancelled = false;

    const flushRoot = (root: string) => {
      const state = batches.get(root);
      batches.delete(root);
      timers.delete(root);
      if (state && state.paths.size > 0) {
        handler.current(root, [...state.paths], state.bulk);
      }
    };

    void listen<FsChangePayload>("fs://change", (event) => {
      const { root, paths } = event.payload;
      if (!root || paths.length === 0) return;
      const now = Date.now();
      let state = batches.get(root);
      if (!state) {
        state = {
          paths: new Set(paths),
          chunks: 1,
          firstAt: now,
          bulk: paths.length >= STORM_PATH_THRESHOLD || paths.some(isBulkArtifactPath),
        };
        batches.set(root, state);
      } else {
        for (const p of paths) state.paths.add(p);
        state.chunks += 1;
        // 仅依据去重后的路径总数达到阈值，或命中构建产物特征路径时，才判定为批量写入风暴；
        // 严禁将批次数量 (chunks >= 2) 视为风暴，避免单文件保存分批通知误触发 1.2s 延迟与全量刷新。
        if (
          state.paths.size >= STORM_PATH_THRESHOLD ||
          paths.some(isBulkArtifactPath)
        ) {
          state.bulk = true;
        }
      }

      const prevTimer = timers.get(root);
      if (prevTimer !== undefined) window.clearTimeout(prevTimer);

      // 批量增删期间暂停高频刷新，等待 STORM_SETTLE_MS 静默后再派发；达到最长上限则放行一次。
      const elapsed = now - state.firstAt;
      const delay = state.bulk
        ? Math.max(0, Math.min(STORM_SETTLE_MS, STORM_MAX_WAIT_MS - elapsed))
        : COALESCE_MS;

      timers.set(
        root,
        window.setTimeout(() => flushRoot(root), delay)
      );
    }).then((off) => {
      if (cancelled) off();
      else detach = off;
    });

    return () => {
      cancelled = true;
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
      batches.clear();
      if (detach) detach();
    };
  }, []);

  // 按 roots 增量启停各根的后端 watcher。
  useEffect(() => {
    const currentSet = new Set(roots.filter((r) => r.length > 0));
    const map = activeMap.current;

    // 停掉已不在列表中的根
    for (const [root, gen] of [...map.entries()]) {
      if (!currentSet.has(root)) {
        map.delete(root);
        void stopWorkspaceWatch(root, gen);
      }
    }

    // 为新加入的根启动监听
    for (const root of currentSet) {
      if (!map.has(root)) {
        const gen = ++generation.current;
        map.set(root, gen);
        void watchWorkspace(root, gen);
      }
    }
  }, [rootsKey, roots]);

  // 组件卸载时停掉全部残余监听
  useEffect(() => {
    const map = activeMap.current;
    return () => {
      for (const [root, gen] of [...map.entries()]) {
        void stopWorkspaceWatch(root, gen);
      }
      map.clear();
    };
  }, []);
}
