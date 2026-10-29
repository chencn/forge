import { type ReactNode } from "react";
import clsx from "clsx";
import { Spinner } from "../ui";
import styles from "./StatusBar.module.css";

export interface StatusItemProps {
  id?: string;
  shrink?: boolean;
  children: ReactNode;
  className?: string;
}

export function StatusItem({ id, shrink, children, className }: StatusItemProps) {
  if (children == null || children === false) return null;
  return (
    <div
      className={clsx(styles.item, shrink && styles.shrink, className)}
      data-status-item={id}
    >
      {children}
    </div>
  );
}

export interface StatusBarProps {
  left?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
  className?: string;
  "aria-label"?: string;
}

/**
 * 工作台现代化状态栏组件
 */
export function StatusBar({
  left,
  right,
  children,
  className,
  ...aria
}: StatusBarProps) {
  return (
    <footer
      className={clsx(styles.bar, className)}
      aria-label={aria["aria-label"] ?? "状态栏"}
      role="status"
    >
      {left}
      {children}
      <div className={styles.spacer} />
      {right}
    </footer>
  );
}

export interface StatusMessageProps {
  message?: string | null;
  className?: string;
}

/** 瞬态状态消息文本 */
export function StatusMessage({ message, className }: StatusMessageProps) {
  if (!message) return null;
  return (
    <span className={clsx(styles.info, className)} role="status" title={message}>
      {message}
    </span>
  );
}

export interface StatusTaskProps {
  title: string;
  running?: boolean;
  onClick?: () => void;
  className?: string;
}

/** 后台运行任务微件 */
export function StatusTask({ title, running = true, onClick, className }: StatusTaskProps) {
  return (
    <div className={clsx(styles.task, className)} onClick={onClick} role={onClick ? "button" : undefined}>
      {running && <Spinner size={12} />}
      <span className={styles.taskTitle} title={title}>
        {title}
      </span>
    </div>
  );
}
