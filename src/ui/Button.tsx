import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";
import { Icon, type LucideIconType } from "./Icon";
import { tooltipAttrs } from "./Tooltip";
import styles from "./Button.module.css";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "normal" | "small";
  icon?: string | LucideIconType | ReactNode;
  children?: ReactNode;
}

/**
 * 通用按钮组件（支持 primary、secondary 与 ghost 变体）
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "normal", icon, className, children, type = "button", title, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(styles.button, styles[variant], size === "small" && styles.small, className)}
      title={title}
      {...rest}
    >
      {icon && <Icon icon={icon} size={14} />}
      {children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  icon: string | LucideIconType | ReactNode;
  /** 可访问标签与提示文本 */
  title?: string;
  /** 快捷键提示（显示在气泡内） */
  shortcut?: string;
  /** 按压开关状态（渲染 aria-pressed） */
  pressed?: boolean;
  size?: "small" | "normal" | "large";
  iconSize?: number;
  tone?: "default" | "danger" | "accent";
}

/**
 * 图标按钮组件（专用于工具栏、面板头部与行内操作）
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    title,
    shortcut,
    pressed,
    size = "normal",
    iconSize,
    tone = "default",
    className,
    disabled,
    type = "button",
    "aria-label": ariaLabel,
    ...rest
  },
  ref
) {
  const label = title ?? (typeof icon === "string" ? icon : undefined);
  return (
    <button
      ref={ref}
      type={type}
      aria-label={ariaLabel ?? label}
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut}
      disabled={disabled}
      className={clsx(
        styles.iconButton,
        styles[`is-${size}`],
        tone !== "default" && styles[`tone-${tone}`],
        className
      )}
      {...tooltipAttrs(label, shortcut)}
      {...rest}
    >
      <Icon icon={icon} size={iconSize ?? (size === "small" ? 14 : 16)} />
    </button>
  );
});
