/** 判断 Ctrl/Cmd+C 时用得到的按键字段。 */
export interface CopySelectionKey {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

/** 焦点所在元素里和「是不是输入控件」有关的那一点。 */
export interface CopySelectionTarget {
  tagName: string;
  isContentEditable: boolean;
}

/**
 * 焦点在输入框、文本域或可编辑区域。
 * 这些地方的复制留给浏览器，以及 Monaco、终端各自的处理。
 */
export function isTextEditingTarget(target: CopySelectionTarget | null): boolean {
  if (!target) return false;
  return (
    target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable
  );
}

/**
 * 这次 Ctrl/Cmd+C 是否该把 DOM 选区写入系统剪贴板。
 *
 * 选区为空、带了 Alt 或 Shift、焦点在输入控件上时返回 false，按键继续交给别的命令
 * （资源管理器复制文件、日志里的复制修订号、编辑器自己的复制）。
 */
export function shouldCopyDomSelection(
  event: CopySelectionKey,
  target: CopySelectionTarget | null,
  selectedText: string,
): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (!(event.ctrlKey || event.metaKey)) return false;
  if (event.key.toLowerCase() !== "c") return false;
  if (isTextEditingTarget(target)) return false;
  return selectedText.length > 0;
}
