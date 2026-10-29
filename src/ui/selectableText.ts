/**
 * 用户可以选中文本并复制的只读文本区域（如 Markdown 预览、快速文档和消息窗格）。
 * 编辑器外的普通工作区默认禁止选中；内容区通过 `selectableText` 类名启用文本选择。
 * 在选区或只读内容上右键，会提供复制上下文菜单选项（`copyMenuFor`）。
 */
import { MOD_LABEL } from "../lib/sys";
import type { MenuItem } from "./Menu";
import styles from "./SelectableText.module.css";

export const selectableText = styles.selectable!;

const EDITABLE = "input, textarea, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']";

function selectionCovers(sel: Selection | null, target: Node): boolean {
  if (!sel || sel.isCollapsed || !sel.toString()) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    if (range.intersectsNode(target) || target.contains(range.commonAncestorContainer)) return true;
  }
  return false;
}

/**
 * 针对右键点击目标生成复制菜单；如果点击的不是可读文本则返回 null
 */
export function copyMenuFor(target: EventTarget | null): MenuItem[] | null {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el || el.closest(EDITABLE)) return null;
  const sel = window.getSelection();
  const text = selectionCovers(sel, el) ? sel!.toString() : "";
  if (!text && !el.closest(`.${selectableText}`)) return null;
  return [
    {
      id: "copy",
      label: "复制",
      icon: "copy",
      shortcut: `${MOD_LABEL}+C`,
      disabled: !text,
      run: () => void copyText(text),
    },
  ];
}

/**
 * 将文本写入系统剪贴板；在失败时回退到复制当前选区
 */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // 剪贴板权限被拒绝时降级处理
  }
  document.execCommand("copy");
}
