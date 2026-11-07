import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Button, IconButton } from "./Button";
import { FOCUSABLE, onWindowDeactivate, openLayer, trapTab } from "./popupState";
import styles from "./Dialog.module.css";

/** 按钮角色：default 主操作、cancel 取消、extra 其它。 */
export type DialogButtonRole = "default" | "cancel" | "extra";

/** 模态对话框底部的一个按钮。 */
export interface DialogButton {
  label: string;
  onClick?: () => void;
  role?: DialogButtonRole;
  disabled?: boolean;
  autoFocus?: boolean;
  title?: string;
}

/** 按钮排序口径：mac 反转主次（主按钮在右），其余平台主按钮在左。 */
export type DialogPlatform = "mac" | "other";

/**
 * 按平台规则排按钮顺序：mac 取消在最左、主操作最右；Windows/Linux
 * 主操作最左，其余按传入顺序。稳定排序，同角色保持原相对次序。
 */
export function orderDialogButtons<T extends { role?: DialogButtonRole }>(
  buttons: readonly T[],
  platform: DialogPlatform
): T[] {
  const role = (b: T) => b.role ?? "extra";
  if (platform === "mac") {
    const MAC_ORDER: Record<DialogButtonRole, number> = { cancel: -10, extra: 0, default: 100 };
    return buttons
      .map((b, i) => ({ b, i }))
      .sort((x, y) => MAC_ORDER[role(x.b)] - MAC_ORDER[role(y.b)] || x.i - y.i)
      .map((x) => x.b);
  }
  return [
    ...buttons.filter((b) => role(b) === "default"),
    ...buttons.filter((b) => role(b) !== "default"),
  ];
}

/** 渲染一排对话框按钮（自动按平台排序、缺省 onClick 落到 onCancel）。 */
export function DialogButtons({
  buttons,
  onCancel,
  platform = "other",
}: {
  buttons: readonly DialogButton[];
  onCancel?: () => void;
  platform?: DialogPlatform;
}) {
  return (
    <div className={styles.buttons}>
      {orderDialogButtons(buttons, platform).map((b) => (
        <Button
          key={b.label}
          variant={b.role === "default" ? "primary" : "secondary"}
          disabled={b.disabled}
          title={b.title}
          data-autofocus={b.autoFocus ? "" : undefined}
          data-dialog-default={b.role === "default" ? "" : undefined}
          onClick={b.onClick ?? (b.role === "cancel" ? onCancel : undefined)}
        >
          {b.label}
        </Button>
      ))}
    </div>
  );
}

/** {@link Dialog} 的入参。 */
export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  buttons?: readonly DialogButton[];
  footerStart?: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  position?: "center" | "top";
  className?: string;
  "aria-label"?: string;
  dismissOnBackdrop?: boolean;
  closeOnDeactivate?: boolean;
  platform?: DialogPlatform;
}

/** Enter 键这些元素自己消化，不冒泡成对话框的确认。 */
const ENTER_OWNERS =
  'textarea, button, a[href], select, form, [contenteditable=""], [contenteditable="true"]';

/** 模态对话框入口：open 为 false 时不挂载内部实现。 */
export function Dialog(props: DialogProps) {
  if (!props.open) return null;
  return <DialogInner {...props} />;
}

/** 对话框内部实现：Portal、焦点圈、Enter/Escape 键与拖拽定位。 */
function DialogInner({
  onClose,
  title,
  children,
  buttons,
  footerStart,
  footer,
  width = 480,
  position = "center",
  className,
  dismissOnBackdrop,
  closeOnDeactivate,
  platform = "other",
  ...aria
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const popup = position === "top" || title == null;
  const onCloseRef = useRef(onClose);
  const buttonsRef = useRef(buttons);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    buttonsRef.current = buttons;
  });

  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const cancelOnDeactivate = closeOnDeactivate ?? popup;
  useEffect(() => {
    if (!cancelOnDeactivate) return;
    return onWindowDeactivate(() => onCloseRef.current());
  }, [cancelOnDeactivate]);

  useEffect(() => {
    const layer = openLayer(() => ref.current);
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;

    const target =
      el?.querySelector<HTMLElement>("[data-autofocus]") ??
      el?.querySelector<HTMLElement>(`[data-dialog-body] :is(${FOCUSABLE})`) ??
      el?.querySelector<HTMLElement>("[data-dialog-footer] [data-dialog-default]:not([disabled])") ??
      el?.querySelector<HTMLElement>(`[data-dialog-footer] :is(${FOCUSABLE})`) ??
      el;
    target?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (!layer.isTop() || !ref.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCloseRef.current();
      } else if (e.key === "Tab") {
        trapTab(e, ref.current);
      } else if (e.key === "Enter" && !e.defaultPrevented && !e.shiftKey && !e.altKey) {
        const t = e.target instanceof Element ? e.target : null;
        const mod = e.metaKey || e.ctrlKey;
        if (t && t !== document.body && !ref.current.contains(t)) return;
        if (!mod && t?.closest(ENTER_OWNERS)) return;
        const def = buttonsRef.current?.find((b) => b.role === "default");
        if (!def || def.disabled || !def.onClick) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        def.onClick();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      layer.release();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const drag = (e: PointerEvent<HTMLDivElement>) => {
    if (popup || e.button !== 0 || (e.target as Element).closest("button, input, label, a, select, textarea")) {
      return;
    }
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    const start = { x: e.clientX - offset.x, y: e.clientY - offset.y };
    const rect = el.getBoundingClientRect();
    const base = { left: rect.left - offset.x, top: rect.top - offset.y };
    const move = (ev: globalThis.PointerEvent) => {
      const x = Math.min(
        Math.max(ev.clientX - start.x, -base.left - rect.width + 80),
        window.innerWidth - base.left - 80
      );
      const y = Math.min(Math.max(ev.clientY - start.y, -base.top), window.innerHeight - base.top - 28);
      setOffset({ x, y });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const label = aria["aria-label"] ?? (typeof title === "string" ? title : undefined);
  const hasFooter = !!(buttons?.length || footerStart || footer);

  return createPortal(
    <div
      className={clsx(styles.backdrop, position === "top" && styles.top)}
      onPointerDown={(e) => {
        if ((dismissOnBackdrop ?? popup) && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={clsx(styles.dialog, popup ? styles.popup : styles.window, className)}
        style={{
          width,
          transform: offset.x || offset.y ? `translate(${offset.x}px, ${offset.y}px)` : undefined,
        }}
      >
        {!popup && (
          <div className={styles.titleBar} onPointerDown={drag} data-dialog-titlebar="">
            <span className={styles.title}>{title}</span>
            {/* JetBrains close.svg（Apache-2.0）：16×16、1px 笔画；原版 Icon 的单色前景来自 fg-icon。 */}
            <IconButton icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 12.5L12.5 3.5M12.5 12.5L3.5 3.5" stroke="var(--fg-icon)" strokeLinecap="round" /></svg>} size="small" tabIndex={-1} title="关闭" onClick={onClose} />
          </div>
        )}

        <div className={styles.body} data-dialog-body="">
          {children}
        </div>

        {hasFooter && (
          <div className={styles.footer} data-dialog-footer="">
            {footerStart && <div className={styles.footerStart}>{footerStart}</div>}
            {footer}
            {buttons && (
              <DialogButtons buttons={buttons} onCancel={onClose} platform={platform} />
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
