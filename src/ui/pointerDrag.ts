/**
 * 组件间基于指针事件（Pointer Events）驱动的拖拽系统。
 * HTML5 原生拖拽在开启窗口原生文件 drop 时，Webview 内部发起的拖拽往往无法正常捕获 dragover / drop。
 * 拖拽源通过 `startPointerDrag` 发起，目标容器通过 `registerDropTarget` 注册并接收位置通知。
 */
import styles from "./pointerDrag.module.css";

/** 拖拽载荷：`type` 用于目标类型匹配（如 `application/x-forge-editor-tab`） */
export interface DragData {
  type: string;
  payload: string;
}

/** 项目文件拖拽 MIME 类型：`payload` 是用 `\n` 连接的文件绝对路径 */
export const FILES_DRAG = "application/x-forge-files";

export interface DropTarget {
  accepts(type: string): boolean;
  /** 指针移动到目标上方 */
  over(data: DragData, x: number, y: number): void;
  /** 指针移出目标，或者拖拽在别处结束 / 取消 */
  leave(): void;
  drop(data: DragData, x: number, y: number): void;
}

const targets = new Map<Element, DropTarget>();

export function registerDropTarget(el: Element, target: DropTarget): () => void {
  targets.set(el, target);
  return () => {
    if (targets.get(el) === target) targets.delete(el);
  };
}

/** 获取 (x, y) 处能接收 `type` 的最深层目标 */
function targetAt(type: string, x: number, y: number): DropTarget | null {
  for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
    const t = targets.get(el);
    if (t?.accepts(type)) return t;
  }
  return null;
}

export interface DragSession {
  /** 更新悬停反馈；如果 (x, y) 处有目标接受该拖拽则返回 true */
  move(x: number, y: number): boolean;
  /** 在 (x, y) 处目标上释放；无目标时返回 false */
  drop(x: number, y: number): boolean;
  cancel(): void;
}

export function dragSession(data: DragData): DragSession {
  let current: DropTarget | null = null;
  const enter = (t: DropTarget | null) => {
    if (t === current) return;
    current?.leave();
    current = t;
  };
  return {
    move(x, y) {
      enter(targetAt(data.type, x, y));
      current?.over(data, x, y);
      return !!current;
    },
    drop(x, y) {
      const t = targetAt(data.type, x, y);
      enter(null);
      t?.drop(data, x, y);
      return !!t;
    },
    cancel: () => enter(null),
  };
}

/** 超过此像素阈值才触发拖拽，避免误触普通点击 */
const DRAG_THRESHOLD = 4;

let requiresAlt = () => false;
export function setDragRequiresAlt(fn: () => boolean) {
  requiresAlt = fn;
}
export const dragRequiresAlt = () => requiresAlt();

/**
 * 在 `source` 元素上发生主键点击并移动超过阈值后启动拖拽；克隆出的幽灵节点跟随指针。
 * 按 Escape 键取消。`onEnd` 回调告知是否发生了拖拽（用于阻断单击事件）。
 */
export function startPointerDrag(
  e: { button: number; clientX: number; clientY: number; altKey: boolean },
  source: HTMLElement,
  data: DragData,
  opts: { onStart?: () => void; onEnd?: (dragged: boolean) => void } = {}
) {
  if (e.button !== 0 || (requiresAlt() && !e.altKey)) return;
  const start = { x: e.clientX, y: e.clientY };
  let ghost: HTMLElement | null = null;
  const session = dragSession(data);

  const onMove = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
      const r = source.getBoundingClientRect();
      ghost = source.cloneNode(true) as HTMLElement;
      ghost.removeAttribute("id");
      ghost.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
      ghost.classList.add(styles.ghost!);
      ghost.setAttribute("aria-hidden", "true");
      Object.assign(ghost.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
      document.body.appendChild(ghost);
      document.documentElement.classList.add(styles.dragging!);
      opts.onStart?.();
    }
    ghost.style.transform = `translate(${ev.clientX - start.x}px, ${ev.clientY - start.y}px)`;
    ghost.classList.toggle(styles.noTarget!, !session.move(ev.clientX, ev.clientY));
  };

  const onUp = (ev: PointerEvent) => {
    const dragged = !!ghost;
    cleanup();
    if (dragged) session.drop(ev.clientX, ev.clientY);
    opts.onEnd?.(dragged);
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !ghost) return;
    ev.preventDefault();
    ev.stopPropagation();
    session.cancel();
    cleanup();
    opts.onEnd?.(true);
  };

  const cleanup = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    ghost?.remove();
    document.documentElement.classList.remove(styles.dragging!);
  };

  const onCancel = () => {
    session.cancel();
    const dragged = !!ghost;
    cleanup();
    opts.onEnd?.(dragged);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
}
