import { type ReactNode } from "react";
import clsx from "clsx";
import { Icon, IconButton, tooltipAttrs, type LucideIconType } from "../ui";
import styles from "./ToolWindows.module.css";

/** 工具窗口切换按钮的入参。 */
export interface ToolWindowButtonProps {
  id: string;
  title: string;
  icon: string | LucideIconType | ReactNode;
  active?: boolean;
  badge?: number | string;
  shortcut?: string;
  onClick?: () => void;
  className?: string;
}

/** 工具窗口切换按钮（带徽标与快捷键提示）。 */
export function ToolWindowButton({
  id,
  title,
  icon,
  active,
  badge,
  shortcut,
  onClick,
  className,
}: ToolWindowButtonProps) {
  return (
    <button
      type="button"
      data-tool-window={id}
      aria-label={title}
      aria-expanded={active}
      className={clsx(styles.stripeButton, active && styles.stripeActive, className)}
      onClick={onClick}
      {...tooltipAttrs(title, shortcut)}
    >
      <Icon icon={icon} size={18} />
      {badge != null && badge !== 0 && (
        <span className={styles.badge} aria-label={`${badge} 条通知`}>
          {badge}
        </span>
      )}
    </button>
  );
}

/** {@link ToolWindowStripe} 的入参。 */
export interface ToolWindowStripeProps {
  children?: ReactNode;
  bottomChildren?: ReactNode;
  className?: string;
}

/**
 * 侧边工具窗口条（Stripe），垂直放置各窗口切换按钮
 */
export function ToolWindowStripe({
  children,
  bottomChildren,
  className,
}: ToolWindowStripeProps) {
  return (
    <div className={clsx(styles.stripe, className)}>
      <div className={styles.stripeGroup}>{children}</div>
      <div className={styles.stripeSpacer} />
      {bottomChildren && <div className={styles.stripeGroup}>{bottomChildren}</div>}
    </div>
  );
}

/** 工具窗口标题栏的入参。 */
export interface ToolWindowHeaderProps {
  title: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
  onMinimize?: () => void;
  className?: string;
}

/** 工具窗口标题栏（标题 + 动作 + 最小化/关闭）。 */
export function ToolWindowHeader({
  title,
  actions,
  onClose,
  onMinimize,
  className,
}: ToolWindowHeaderProps) {
  return (
    <div className={clsx(styles.header, className)}>
      <span className={styles.title}>{title}</span>
      <div className={styles.headerActions}>
        {actions}
        {onMinimize && (
          <IconButton
            icon="minus"
            size="small"
            title="最小化"
            onClick={onMinimize}
          />
        )}
        {onClose && (
          <IconButton
            icon="close"
            size="small"
            title="关闭窗口"
            onClick={onClose}
          />
        )}
      </div>
    </div>
  );
}

/** {@link ToolWindowPanel} 的入参。 */
export interface ToolWindowPanelProps {
  title?: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  className?: string;
}

/**
 * 停靠面板容器，包含标准标题栏与自适应内容视口
 */
export function ToolWindowPanel({
  title,
  actions,
  onClose,
  children,
  className,
}: ToolWindowPanelProps) {
  return (
    <div className={clsx(styles.panel, className)}>
      {title != null && (
        <ToolWindowHeader title={title} actions={actions} onClose={onClose} />
      )}
      <div className={styles.body}>{children}</div>
    </div>
  );
}
