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

export type DialogButtonRole = "default" | "cancel" | "extra";

export interface DialogButton {
  label: string;
  onClick?: () => void;
  role?: DialogButtonRole;
  disabled?: boolean;
  autoFocus?: boolean;
  title?: string;
}

export type DialogPlatform = "mac" | "other";

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

const ENTER_OWNERS =
  'textarea, button, a[href], select, form, [contenteditable=""], [contenteditable="true"]';

export function Dialog(props: DialogProps) {
  if (!props.open) return null;
  return <DialogInner {...props} />;
}

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
            <IconButton icon="close" size="small" title="关闭" onClick={onClose} />
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
