import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { stopWorkspaceWatch, watchWorkspace } from "../lib/fs";

/** 后端已经并过一次批，这里再并一次：一次保存会连着来好几条事件，别让它抖着手感。 */
const COALESCE_MS = 120;

interface FsChangePayload {
  /** 受影响的路径，绝对路径，分隔符按平台原样。 */
  paths: string[];
}

/**
 * 盯住工作区目录，把磁盘上发生的改动成批交给调用方。
 * 换目录就重新起一次监听，卸载或没有工作区时停掉。
 */
export function useFileWatch(root: string | null, onChange: (paths: string[]) => void) {
  const handler = useRef(onChange);
  handler.current = onChange;

  useEffect(() => {
    if (!root) {
      void stopWorkspaceWatch();
      return;
    }
    void watchWorkspace(root);

    let batch: string[] = [];
    let timer: number | undefined;
    let detach: (() => void) | null = null;
    let cancelled = false;

    void listen<FsChangePayload>("fs://change", (event) => {
      batch.push(...event.payload.paths);
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const paths = batch;
        batch = [];
        timer = undefined;
        handler.current(paths);
      }, COALESCE_MS);
    }).then((off) => {
      // 订阅建立前组件已经卸载或换了目录，那就当场解掉，别留一个没人收的监听。
      if (cancelled) off();
      else detach = off;
    });

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (detach) detach();
      // 这里不碰 fs_watch_stop：换目录时后端起新的会顺手把旧的丢掉，
      // 而自己发一次「停」反而可能比新的一次「起」晚到，把刚装好的监听掐死。
    };
  }, [root]);
}
