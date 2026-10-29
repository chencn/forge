/**
 * 全局浮层层级栈管理（Popups, Menus, Dialogs, Speed Search）
 *
 * 保证只有最顶层响应 Escape 关闭，点击上层不会关闭下层。
 */

interface Layer {
  id: number;
  el: () => HTMLElement | null;
}

const layers: Layer[] = [];
let seq = 0;
let anonymous = 0;

export interface LayerHandle {
  isTop(): boolean;
  /** 目标节点是否落在当前层或当前层之上的任何层内 */
  containsFromHere(target: Node): boolean;
  release(): void;
}

export function openLayer(el: () => HTMLElement | null): LayerHandle {
  const layer = { id: ++seq, el };
  layers.push(layer);
  let released = false;
  return {
    isTop: () => layers[layers.length - 1]?.id === layer.id,
    containsFromHere(target) {
      const idx = layers.findIndex((l) => l.id === layer.id);
      for (let i = Math.max(0, idx); i < layers.length; i++) {
        if (layers[i]?.el()?.contains(target)) return true;
      }
      return false;
    },
    release() {
      if (released) return;
      released = true;
      const i = layers.findIndex((l) => l.id === layer.id);
      if (i >= 0) layers.splice(i, 1);
    },
  };
}

/** 标记占据键盘焦点的无 DOM 浮动态 */
export function acquirePopup(): () => void {
  anonymous++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    anonymous = Math.max(0, anonymous - 1);
  };
}

/** 窗口失去焦点时调用（IDEA 风格失焦关闭浮层） */
export function onWindowDeactivate(fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onBlur = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!document.hasFocus()) fn();
    }, 0);
  };
  window.addEventListener("blur", onBlur);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("blur", onBlur);
  };
}

export function isPopupOpen(): boolean {
  return layers.length + anonymous > 0;
}

export const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 锁定 Tab 键焦点在 root 内部循环 */
export function trapTab(e: KeyboardEvent, root: HTMLElement): boolean {
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0);
  if (!items.length) return false;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault();
    last.focus();
    return true;
  }
  if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}
