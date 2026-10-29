import { useMemo, type CSSProperties, type ReactNode } from "react";
import { Popup as UiPopup } from "../ui/Popup";

export interface PopoverProps {
  /** 锚点元素：弹层贴着它的下沿画，放不下时翻到上沿。 */
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  /** 宽度下限；不传则取锚点宽度。 */
  minWidth?: number;
  /**
   * 宽度上限。内容（长路径、长错误串）比它宽时不再撑大弹层，改由内容自身省略号收尾。
   */
  maxWidth?: number;
  /** 可选横向边界；窄侧栏里的弹层不得越过所属面板。 */
  boundary?: HTMLElement | null;
  /** 角色：对话框或工具提示 */
  role?: "dialog" | "tooltip";
  /**
   * 默认带一层点击外部收起行为。
   */
  modal?: boolean;
  className?: string;
}

/**
 * 业务通用气泡浮层组件
 * 内部已平滑升级为基于 @floating-ui/react-dom 与 popupState 的 UI 规范组件，
 * 原生支持视口翻转、边界避让、点击外部自动关闭与 Escape 层级栈弹出。
 */
export default function Popover({
  anchor,
  onClose,
  children,
  minWidth,
  maxWidth,
  role,
  modal = true,
  className = "",
}: PopoverProps) {
  const style = useMemo<CSSProperties>(
    () => ({
      minWidth,
      maxWidth,
    }),
    [minWidth, maxWidth]
  );

  if (!anchor) return null;

  return (
    <UiPopup
      open={true}
      anchor={anchor}
      onClose={onClose}
      placement="bottom-start"
      offset={4}
      role={role ?? (modal ? "dialog" : "tooltip")}
      closeOnOutsideClick={modal}
      closeOnDeactivate={modal}
      autoFocus={false}
      unstyled={true}
      className={`popover is-anchored ${className}`.trim()}
      style={style}
    >
      {children}
    </UiPopup>
  );
}
