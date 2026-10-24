import { useCallback, useSyncExternalStore } from "react";

/**
 * 聊天列宽的持久化与钳制（对照 codeg 的 chat-content-width）。
 *
 * 会话页与欢迎页共用同一条内容轴；宽度按「100% 缩放时的像素」存储，与参考实现
 * 一致——换算成 rem 交给 CSS 变量时由这里统一做，调用方不各自除 16。
 */

/** 参考实现的默认列宽：48rem。 */
export const AI_CHAT_WIDTH_DEFAULT = 768;
/** 再窄正文就换行过密；参考实现同值。 */
export const AI_CHAT_WIDTH_MIN = 640;
/** 方向键一次步进的距离；参考实现同值。 */
export const AI_CHAT_WIDTH_KEY_STEP = 32;
const KEY = "forge:ai-chat-width:v1";
/** 列两侧永远留出的空隙；手柄不能压到窗口 resize 边上。 */
const GUTTER = 12;

function clamp(value: number, hostWidth: number | undefined): number {
  const max = hostWidth !== undefined ? Math.max(AI_CHAT_WIDTH_MIN, Math.floor((hostWidth - 2 * GUTTER))) : AI_CHAT_WIDTH_DEFAULT;
  return Math.min(max, Math.max(AI_CHAT_WIDTH_MIN, Math.round(value)));
}

function load(): number | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

let state: { width: number | null; host: number | undefined } = { width: load(), host: undefined };
const listeners = new Set<() => void>();
function commit(next: Partial<typeof state>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

/** 拖拽/键盘调整后的落值；null 表示回到默认。拖动中的预览传 `persist: false`。 */
export function setAiChatWidth(px: number | null, persist = true) {
  if (px === null) {
    if (persist) {
      try { localStorage.removeItem(KEY); } catch { /* 存不进只丢偏好 */ }
      commit({ width: null });
    }
    return;
  }
  const clamped = clamp(px, state.host);
  if (persist) {
    try { localStorage.setItem(KEY, String(clamped)); } catch { /* 存不进只丢偏好 */ }
  }
  commit({ width: clamped });
}

/** 宿主宽度变化时收窄上限；存着的值超了上限就先夹住显示，不改动存的值。 */
export function setAiChatHostWidth(hostWidth: number | undefined) {
  if (state.host === hostWidth) return;
  commit({ host: hostWidth });
}

/**
 * 生效宽度：用户调整过（有固化值）用固化值；没调整过就是**宿主宽的 80%**——
 * 跟着窗口动态走，不落盘。复位（双击/Esc/Home）删掉固化值，回到动态档。
 */
export function aiChatWidthClamped(): number {
  const host = state.host;
  if (state.width === null) {
    return host !== undefined ? clamp(host * 0.8, host) : AI_CHAT_WIDTH_DEFAULT;
  }
  return clamp(state.width, host);
}

export function useAiChatWidth(): { width: number; custom: boolean } {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  const snapshot = useCallback(() => state, []);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return { width: aiChatWidthClamped(), custom: state.width !== null };
}

/** 供测试重置。 */
export function __resetAiChatWidthForTest() {
  state = { width: null, host: undefined };
  listeners.forEach((listener) => listener());
}
