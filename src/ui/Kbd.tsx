import type { ReactNode } from "react";
import clsx from "clsx";
import styles from "./Kbd.module.css";

export interface KbdProps {
  /** 格式化快捷键展示串（如 "Ctrl+S" 或 "⌘O"） */
  binding?: string;
  children?: ReactNode;
  className?: string;
}

/**
 * 键盘快捷键徽章组件
 */
export function Kbd({ binding, children, className }: KbdProps) {
  const label = children ?? binding;
  if (!label) return null;
  return <kbd className={clsx(styles.kbd, className)}>{label}</kbd>;
}
