import { useCallback, useSyncExternalStore } from "react";

/** 工具 diff 的展示方式（行内 / 分栏）；全局偏好，对照参考实现的全局 ViewModeToggle。 */
export type AiDiffViewMode = "inline" | "split";
const KEY = "forge:ai-diff-view:v1";

function load(): AiDiffViewMode {
  try {
    return localStorage.getItem(KEY) === "split" ? "split" : "inline";
  } catch {
    return "inline";
  }
}

let mode: AiDiffViewMode = load();
const listeners = new Set<() => void>();

export function setAiDiffViewMode(next: AiDiffViewMode) {
  if (mode === next) return;
  mode = next;
  try { localStorage.setItem(KEY, next); } catch { /* 存不进只丢偏好 */ }
  listeners.forEach((listener) => listener());
}

export function useAiDiffViewMode(): [AiDiffViewMode, (next: AiDiffViewMode) => void] {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  const snapshot = useCallback(() => mode, []);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return [mode, setAiDiffViewMode];
}

/** 供测试重置。 */
export function __resetAiDiffViewForTest() {
  mode = "inline";
  listeners.forEach((listener) => listener());
}
