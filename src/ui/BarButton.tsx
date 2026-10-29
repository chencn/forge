import { forwardRef, type ButtonHTMLAttributes } from "react";
import clsx from "clsx";
import { tooltipAttrs } from "./Tooltip";
import styles from "./BarButton.module.css";

export interface BarButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  /** `status`: 状态栏微件; `title`: 主工具栏微件 */
  variant?: "status" | "title";
  mono?: boolean;
  /** 气泡提示文案 */
  tooltip?: string;
  /** 快捷键提示 */
  shortcut?: string;
  emphasis?: boolean;
}

/**
 * 供状态栏、标题栏与轻量工具栏使用的文本/图标微件按钮
 */
export const BarButton = forwardRef<HTMLButtonElement, BarButtonProps>(function BarButton(
  { variant = "status", mono, tooltip, shortcut, emphasis, className, type = "button", children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(
        styles.button,
        styles[variant],
        mono && styles.mono,
        emphasis && styles.emphasis,
        className
      )}
      {...tooltipAttrs(tooltip, shortcut)}
      {...rest}
    >
      {children}
    </button>
  );
});
