/**
 * 桌面右键守卫（1:1 抄 openidea browserGuards 语义）：
 * - WebView2 原生右键菜单（刷新/打印/检查）在桌面应用里一律禁用；
 * - 组件自己接手的右键（弹了自绘菜单）不重复兜底；
 * - 未接手的右键落在可读文本（显式放开选中的区域，如通知标题/正文）上时，
 *   弹自绘「复制」菜单——选区有内容则可复制，否则菜单置灰，而不是什么都不给。
 */
import type { MenuItem } from "../components/ContextMenu";

const EDITABLE = "input, textarea, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']";

function selectionCovers(sel: Selection | null, target: Node): boolean {
  if (!sel || sel.isCollapsed || !sel.toString()) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    if (range.intersectsNode(target) || target.contains(range.commonAncestorContainer)) return true;
  }
  return false;
}

/** 落点是否处于可读文本：祖链上任一层显式放开选中（user-select: text）即算。 */
function isSelectableText(el: Element): boolean {
  let node: Element | null = el;
  while (node && node !== document.body) {
    if (getComputedStyle(node).userSelect === "text") return true;
    node = node.parentElement;
  }
  return false;
}

/** 右键落点的「复制」菜单；不在可读文本上时返回 null（保持无菜单）。 */
export function copyMenuFor(target: EventTarget | null): MenuItem[] | null {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el || el.closest(EDITABLE)) return null;
  const sel = window.getSelection();
  const text = selectionCovers(sel, el) ? sel!.toString() : "";
  if (!text && !isSelectableText(el)) return null;
  return [
    {
      label: "复制",
      disabled: !text,
      onSelect: () => void copyText(text),
    },
  ];
}

/** 写剪贴板；Clipboard API 被拒时回退到复制当前选区。 */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // 权限被拒：选区还在，走 execCommand 兜底
  }
  document.execCommand("copy");
}

interface GuardMenu {
  x: number;
  y: number;
  items: MenuItem[];
}

let guardMenu: GuardMenu | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export const contextMenuGuard = {
  get: () => guardMenu,
  show: (menu: GuardMenu) => {
    guardMenu = menu;
    emit();
  },
  close: () => {
    if (guardMenu === null) return;
    guardMenu = null;
    emit();
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** 浏览器专属快捷键：桌面应用里没有意义，拦掉（对齐 openidea BLOCKED）。 */
const BLOCKED = new Set([
  "Meta+P", "Ctrl+P", "Meta+S", "Meta+Shift+S", "Meta+O", "Meta+G", "Meta+Shift+G",
  "Meta+[", "Meta+]", "Meta+Alt+I", "Meta+U",
]);
/** 刷新/硬刷新：WebView2 的 F5 会重载整个应用（对齐 openidea RELOAD，PROD 拦截）。 */
const RELOAD = new Set(["Meta+R", "Meta+Shift+R", "Ctrl+R", "Ctrl+Shift+R", "F5", "Shift+F5"]);

function keyId(e: KeyboardEvent): string {
  const key = e.code.startsWith("Key")
    ? e.code.slice(3)
    : e.code === "BracketLeft"
      ? "["
      : e.code === "BracketRight"
        ? "]"
        : e.key;
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta", key]
    .filter(Boolean)
    .join("+");
}

export function installContextMenuGuard(opts: { blockReload?: boolean } = {}): () => void {
  const blockReload = opts.blockReload ?? import.meta.env.PROD;
  let menuBefore: unknown = null;
  // capture 阶段只记快照；preventDefault 挪到 bubble 阶段——
  // 若在 capture 就拦下，React 冒泡处理器里弹的自绘菜单会被误判成「未处理」。
  const beforeContextMenu = () => {
    menuBefore = contextMenuGuard.get();
  };
  const onContextMenu = (e: MouseEvent) => {
    const handled = e.defaultPrevented || contextMenuGuard.get() !== menuBefore;
    e.preventDefault();
    if (handled) return;
    const items = copyMenuFor(e.target);
    if (items) contextMenuGuard.show({ x: e.clientX, y: e.clientY, items });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const id = keyId(e);
    if (BLOCKED.has(id) || (blockReload && RELOAD.has(id))) e.preventDefault();
  };
  // 文件拖进窗口默认是导航（整个应用被页面替换），没有 data-drop-target 标记的落点一律拦掉。
  const onDrag = (e: DragEvent) => {
    if (!(e.target as Element | null)?.closest?.("[data-drop-target]")) e.preventDefault();
  };
  window.addEventListener("contextmenu", beforeContextMenu, true);
  window.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("dragover", onDrag);
  window.addEventListener("drop", onDrag);
  return () => {
    window.removeEventListener("contextmenu", beforeContextMenu, true);
    window.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("dragover", onDrag);
    window.removeEventListener("drop", onDrag);
  };
}
