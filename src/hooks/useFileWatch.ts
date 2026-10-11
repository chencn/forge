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
  /** 本轮监听的代号：每次换根递增，start/stop 都带着它，后端只认不落伍的请求。 */
  const generation = useRef(0);

  useEffect(() => {
    if (!root) {
      // 上一个 effect 的 cleanup 已经带着当时的 root 与代号发过 stop 了，这里没事可做。
      return;
    }
    // 代号先递增再随请求发出：后端命令在阻塞线程池里执行顺序没有保证，
    // 两条 start 乱序到达时，代号落后的那次会被后端拒掉，槽里永远是最新那轮。
    const gen = ++generation.current;
    void watchWorkspace(root, gen);

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
      // 带着本次闭包里的 root 与代号发 stop：两者都对得上后端才清槽。
      // 就算这条 stop 比换目录后那次新 start 晚到，也对不上号，掐不死新监听；
      // 卸载时由此真正停掉监听，不再依赖「下次 start 顺手覆盖」。
      void stopWorkspaceWatch(root, gen);
    };
  }, [root]);
}
