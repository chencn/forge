import { useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { stopWorkspaceWatch, watchWorkspace } from "../lib/fs";

/** 后端已经并过一次批，这里再并一次：一次保存会连着来好几条事件，别让它抖着手感。 */
const COALESCE_MS = 120;

interface FsChangePayload {
  /** 变更所属的工作区根目录（与 watchWorkspace 入参一致）。 */
  root: string;
  /** 受影响的路径，绝对路径，分隔符按平台原样。 */
  paths: string[];
}

/**
 * 同时盯住所有已打开的工作区目录，把磁盘上发生的改动按所属根成批交给调用方。
 * 新增根启动监听、移除根停止监听，已存在的根不重复重启，卸载时全部停掉。
 */
export function useFileWatch(
  roots: string[],
  onChange: (root: string, paths: string[]) => void
) {
  const handler = useRef(onChange);
  handler.current = onChange;
  /** 本轮监听的代号：每次新监听递增，start/stop 都带着它，后端只认不落伍的请求。 */
  const generation = useRef(0);
  /** 当前已注册监听的根 → 代号，用于增量增删。 */
  const activeMap = useRef<Map<string, number>>(new Map());
  const rootsKey = useMemo(() => roots.join("\n"), [roots]);

  // 订阅一份全局 `fs://change`，按 payload.root 分桶防抖派发。
  useEffect(() => {
    const batches = new Map<string, string[]>();
    const timers = new Map<string, number>();
    let detach: (() => void) | null = null;
    let cancelled = false;

    void listen<FsChangePayload>("fs://change", (event) => {
      const { root, paths } = event.payload;
      if (!root || paths.length === 0) return;
      const existing = batches.get(root);
      if (existing) existing.push(...paths);
      else batches.set(root, [...paths]);

      const prevTimer = timers.get(root);
      if (prevTimer !== undefined) window.clearTimeout(prevTimer);
      timers.set(
        root,
        window.setTimeout(() => {
          const collected = batches.get(root) ?? [];
          batches.delete(root);
          timers.delete(root);
          if (collected.length > 0) {
            handler.current(root, collected);
          }
        }, COALESCE_MS)
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
