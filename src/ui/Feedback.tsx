import type { ReactNode } from "react";
import clsx from "clsx";
import { Icon, type LucideIconType } from "./Icon";
import { IconButton } from "./Button";
import styles from "./Feedback.module.css";

export interface ProgressBarProps {
  /** 0..1; 为 null/undefined 时渲染不确定滑动动画 */
  value?: number | null;
  className?: string;
  "aria-label"?: string;
}

/**
 * 细线条进度条
 */
export function ProgressBar({ value, className, ...aria }: ProgressBarProps) {
  const determinate = value != null;
  return (
    <div
      role="progressbar"
      aria-label={aria["aria-label"]}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? Math.round(value * 100) : undefined}
      className={clsx(styles.progress, !determinate && styles.indeterminate, className)}
    >
      <div
        className={styles.bar}
        style={determinate ? { transform: `scaleX(${Math.max(0, Math.min(1, value))})` } : undefined}
      />
    </div>
  );
}

/**
 * 加载旋转指示器
 */
export function Spinner({
  size = 14,
  className,
  label = "Loading",
}: {
  size?: number;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      className={clsx(styles.spinner, className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="status"
      aria-label={label}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.4" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export interface BadgeProps {
  children: ReactNode;
  tone?: "neutral" | "accent" | "danger" | "warning" | "success";
  /** 小圆点形式 */
  dot?: boolean;
  className?: string;
}

export function Badge({ children, tone = "neutral", dot, className }: BadgeProps) {
  if (dot) {
    return (
      <span
        className={clsx(styles.dot, styles[`tone-${tone}`], className)}
        role="status"
        aria-label={String(children)}
      />
    );
  }
  return <span className={clsx(styles.badge, styles[`tone-${tone}`], className)}>{children}</span>;
}

export interface EmptyStateProps {
  title?: ReactNode;
  icon?: string | LucideIconType | ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/**
 * 居中空白状态占位
 */
export function EmptyState({ title, children, actions, className }: EmptyStateProps) {
  return (
    <div className={clsx(styles.empty, className)}>
      {title != null && <div className={styles.emptyTitle}>{title}</div>}
      {children != null && <div className={styles.emptyBody}>{children}</div>}
      {actions != null && <div className={styles.emptyActions}>{actions}</div>}
    </div>
  );
}

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastProps {
  level?: "info" | "warning" | "error" | "success";
  title?: ReactNode;
  meta?: ReactNode;
  body?: ReactNode;
  children?: ReactNode;
  actions?: ToastAction[];
  onClose?: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  className?: string;
}

/**
 * IDEA 风格通知条目 / 气泡卡片
 */
export function Toast({
  level = "info",
  title,
  meta,
  body,
  children,
  actions,
  onClose,
  onPointerEnter,
  onPointerLeave,
  className,
}: ToastProps) {
  return (
    <div
      className={clsx(styles.toast, className)}
      role={level === "error" ? "alert" : "status"}
      data-level={level}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <span className={clsx(styles.toastIcon, styles[`level-${level}`])}>
        <Icon
          icon={
            level === "error"
              ? "error"
              : level === "warning"
                ? "warning"
                : level === "success"
                  ? "success"
                  : "info"
          }
          size={16}
        />
      </span>
      <div className={styles.toastMain}>
        {(title != null || meta != null) && (
          <div className={styles.toastHead}>
            {title != null && <span className={styles.toastTitle}>{title}</span>}
            {meta != null && <span className={styles.toastMeta}>{meta}</span>}
          </div>
        )}
        {body != null ? (
          <div className={styles.toastBody}>{body}</div>
        ) : children != null ? (
          <div className={styles.toastBody}>{children}</div>
        ) : null}
        {actions && actions.length > 0 && (
          <div className={styles.toastActions}>
            {actions.map((a, i) => (
              <button key={i} type="button" className={styles.link} onClick={a.run}>
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {onClose && (
        <span className={styles.toastClose}>
          <IconButton icon="close" size="small" iconSize={12} title="关闭" onClick={onClose} />
        </span>
      )}
    </div>
  );
}
