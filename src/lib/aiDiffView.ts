import { useCallback, useSyncExternalStore } from "react";

/** 工具 diff 的展示方式（行内 / 分栏）；全局偏好。 */
export type AiDiffViewMode = "inline" | "split";
/** localStorage 键。 */
const KEY = "forge:ai-diff-view:v1";

/** 从 localStorage 读回持久化的展示模式（坏值当 inline）。 */
function load(): AiDiffViewMode {
  try {
    return localStorage.getItem(KEY) === "split" ? "split" : "inline";
  } catch {
    return "inline";
  }
}

/** 当前模式（模块级单例，启动时从 localStorage 装载）。 */
let mode: AiDiffViewMode = load();
/** 模式变化订阅者。 */
const listeners = new Set<() => void>();

/** 切换展示模式并写回 localStorage（相同值不动作、不广播）。 */
export function setAiDiffViewMode(next: AiDiffViewMode) {
  if (mode === next) return;
  mode = next;
  try { localStorage.setItem(KEY, next); } catch { /* 存不进只丢偏好 */ }
  listeners.forEach((listener) => listener());
}

/** React hook：订阅当前模式，返回 `[mode, setMode]`。 */
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
