/**
 * 桌面右键守卫（browserGuards 语义）：
 * - WebView2 原生右键菜单（刷新/打印/检查）在桌面应用里一律禁用；
 * - 组件自己接手的右键（弹了自绘菜单）不重复兜底；
 * - 未接手的右键落在可读文本（显式放开选中的区域，如通知标题/正文）上时，
 *   弹自绘「复制」菜单——选区有内容则可复制，否则菜单置灰，而不是什么都不给。
 */
import { EditorView } from "@codemirror/view";
import { selectAll } from "@codemirror/commands";
import type { MenuItem } from "../components/ContextMenu";

/** 可编辑元素选择器：这些落点交给组件自己处理，不兜底。 */
const EDITABLE = "input, textarea, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']";

/**
 * 判定选区是否覆盖了目标节点（可交互式判定「复制」是否可用）。
 *
 * @param sel - 当前窗口的原生选区对象
 * @param target - 右键点击的 DOM 节点
 * @returns 选区是否包含或与目标节点相交
 */
function selectionCovers(sel: Selection | null, target: Node): boolean {
  if (!sel || sel.isCollapsed || !sel.toString()) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    if (range.intersectsNode(target) || target.contains(range.commonAncestorContainer)) return true;
  }
  return false;
}

/**
 * 落点是否处于可读文本：祖链上任一层显式放开选中（user-select: text）即算。
 *
 * @param el - 待判定的 DOM 元素
 * @returns 元素链是否允许文本选中
 */
function isSelectableText(el: Element): boolean {
  let node: Element | null = el;
  while (node && node !== document.body) {
    if (getComputedStyle(node).userSelect === "text") return true;
    node = node.parentElement;
  }
  return false;
}

/**
 * 为 CodeMirror 6 编辑器/比对器生成上下文菜单项。
 *
 * @param editorEl - CodeMirror 6 根元素（.cm-editor）
 * @returns 包含复制、全选（及非只读时的粘贴）的菜单项列表，无法解析时返回 null
 */
function cmMenuFor(editorEl: HTMLElement): MenuItem[] | null {
  const view = EditorView.findFromDOM(editorEl);
  if (!view) return null;
  const selection = view.state.selection.main;
  const text = selection.empty ? "" : view.state.sliceDoc(selection.from, selection.to);
  const readOnly = view.state.readOnly;
  const items: MenuItem[] = [
    {
      label: "复制",
      disabled: !text,
      onSelect: () => void copyText(text),
    },
  ];
  if (!readOnly) {
    items.push({
      label: "粘贴",
      onSelect: () => {
        void navigator.clipboard
          .readText()
          .then((val) => {
            view.dispatch(view.state.replaceSelection(val));
          })
          .catch(() => {});
      },
    });
  }
  items.push({
    label: "全选",
    onSelect: () => {
      selectAll(view);
      view.focus();
    },
  });
  return items;
}

/**
 * 右键落点的「复制」菜单；不在可读文本上时返回 null（保持无菜单）。
 *
 * @param target - 触发 contextmenu 的事件目标
 * @returns 匹配的右键菜单项数组，无适用的复制操作时返回 null
 */
export function copyMenuFor(target: EventTarget | null): MenuItem[] | null {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el) return null;

  // 1. 若落在 CodeMirror 6 内部（比对视图、只读文件预览、未拦截的主编辑器等）：直接读取 CM6 真实状态
  const cmEditor = el.closest<HTMLElement>(".cm-editor");
  if (cmEditor) {
    const cmItems = cmMenuFor(cmEditor);
    if (cmItems) return cmItems;
  }

  // 2. 原生输入框/文本域：由它们自身原生处理或特定组件自绘处理，不在此兜底
  if (el.closest(EDITABLE)) return null;

  // 3. 检查是否有快捷复制文本声明（如文件路径栏、代码头部标签等）
  const copyCarrier = el.closest<HTMLElement>("[data-copy-text]");
  const copyValue = copyCarrier?.getAttribute("data-copy-text");

  // 4. 原生文本选区判定
  const sel = window.getSelection();
  const text = selectionCovers(sel, el) ? sel!.toString() : "";
  if (text) {
    return [
      {
        label: "复制",
        disabled: false,
        onSelect: () => void copyText(text),
      },
    ];
  }

  // 若无选区但落点在声明了 data-copy-text 的容器上，提供直接复制
  if (copyValue) {
    return [
      {
        label: "复制路径",
        disabled: false,
        onSelect: () => void copyText(copyValue),
      },
    ];
  }

  // 若处于可读文本区域（如通知正文）但未选中文本，按设计提供置灰的复制项
  if (!isSelectableText(el)) return null;
  return [
    {
      label: "复制",
      disabled: true,
      onSelect: () => {},
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

/** 守卫当前弹出的兜底菜单（位置 + 菜单项）。 */
interface GuardMenu {
  x: number;
  y: number;
  items: MenuItem[];
}

/** 当前兜底菜单单例。 */
let guardMenu: GuardMenu | null = null;
/** 菜单开关订阅者。 */
const listeners = new Set<() => void>();

/** 广播菜单开关。 */
function emit() {
  for (const listener of listeners) listener();
}

/** 兜底菜单的响应式单例总线（读/开/关/订阅）。 */
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

/** 浏览器专属快捷键：桌面应用里没有意义，拦掉。 */
const BLOCKED = new Set([
  "Meta+P", "Ctrl+P", "Meta+S", "Meta+Shift+S", "Meta+O", "Meta+G", "Meta+Shift+G",
  "Meta+[", "Meta+]", "Meta+Alt+I", "Meta+U",
]);
/** 刷新/硬刷新：WebView2 的 F5 会重载整个应用，生产环境拦截。 */
const RELOAD = new Set(["Meta+R", "Meta+Shift+R", "Ctrl+R", "Ctrl+Shift+R", "F5", "Shift+F5"]);

/** 把键盘事件归一成 `Ctrl+Shift+R` 形态的快捷键串。 */
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

/**
 * 安装全局守卫：右键兜底菜单、浏览器快捷键拦截、文件拖入导航拦截。
 *
 * @returns 卸载函数，移除全部监听
 */
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
