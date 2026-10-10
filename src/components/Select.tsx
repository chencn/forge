import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption<T extends string | number> {
  /** 实际写回设置/命令的值。 */
  value: T;
  /** 触发器和列表里显示的主文案。 */
  label: string;
  /** 右侧次级文案，等宽绘制，例如脚本的真实命令。 */
  detail?: string;
}

interface SelectProps<T extends string | number> {
  /** 当前选中值；null 表示没有可选项。 */
  value: T | null;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** 可选项为空时的占位文案。 */
  placeholder: string;
  /** 供读屏识别的控件名。 */
  label: string;
  className?: string;
  disabled?: boolean;
}

const LIST_GAP = 4;
const LIST_MAX_HEIGHT = 288;
const VIEWPORT_PADDING = 8;
/** 列表里一行的实际高度：上下内边距 12 + 行高约 20。 */
const ITEM_HEIGHT = 32;

/** 展开列表自己定位，原生 select 的弹层由系统绘制，配色跟应用主题对不上。 */
export default function Select<T extends string | number>({
  value,
  options,
  onChange,
  placeholder,
  label,
  className = "",
  disabled = false,
}: SelectProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState({ left: 0, top: 0, width: 0 });
  const [cursor, setCursor] = useState(0);

  const current = options.find((option) => option.value === value) ?? null;

  useLayoutEffect(() => {
    if (!open) return;
    const box = triggerRef.current?.getBoundingClientRect();
    if (!box) return;
    const height = Math.min(LIST_MAX_HEIGHT, options.length * ITEM_HEIGHT + 14);
    const spaceBelow = window.innerHeight - box.bottom - LIST_GAP - VIEWPORT_PADDING;
    const openUp = spaceBelow < height && box.top > spaceBelow;
    setRect({
      left: Math.min(box.left, window.innerWidth - Math.max(box.width, 200) - VIEWPORT_PADDING),
      top: openUp
        ? Math.max(VIEWPORT_PADDING, box.top - height - LIST_GAP)
        : box.bottom + LIST_GAP,
      width: Math.max(box.width, 200),
    });
    const active = options.findIndex((option) => option.value === value);
    setCursor(active < 0 ? 0 : active);
    listRef.current?.focus();
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const pick = (option: SelectOption<T>) => {
    setOpen(false);
    triggerRef.current?.focus();
    if (option.value !== value) onChange(option.value);
  };

  const onListKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setCursor((index) => (index + step + options.length) % options.length);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = options[cursor];
      if (option) pick(option);
    }
  };

  return (
    <div ref={rootRef} className={`select ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled || options.length === 0}
        onClick={() => setOpen((state) => !state)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="select-value">{current ? current.label : placeholder}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>

      {open ? (
        <div
          ref={listRef}
          className="select-list"
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onListKey}
          style={{ left: rect.left, top: rect.top, width: rect.width }}
        >
          {options.map((option, index) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={`select-option${selected ? " is-selected" : ""}${index === cursor ? " is-cursor" : ""}`}
                onMouseEnter={() => setCursor(index)}
                onClick={() => pick(option)}
              >
                <span className="select-option-mark">
                  {selected ? <Check size={13} aria-hidden="true" /> : null}
                </span>
                <span className="select-option-label">{option.label}</span>
                {option.detail ? <span className="select-option-detail">{option.detail}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
