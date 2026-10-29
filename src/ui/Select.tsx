import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import { Icon, type LucideIconType } from "./Icon";
import { Popup } from "./Popup";
import { List, listNavigate } from "./List";
import styles from "./Select.module.css";

export interface SelectOption<V extends string | number = string> {
  value: V;
  label: string;
  icon?: string | LucideIconType | ReactNode;
  detail?: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string | number = string> {
  value: V | null;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  placeholder?: string;
  disabled?: boolean;
  /** `ghost` 渲染为无边框文本+箭头（用于标题栏等微型控件） */
  variant?: "framed" | "ghost";
  className?: string;
  "aria-label"?: string;
  /** 自定义触发区内容渲染 */
  renderValue?: (option: SelectOption<V> | undefined) => ReactNode;
}

/**
 * 带有弹出列表框的下拉选择器（支持 ↑↓ Enter Esc 导航及首字母快速键入选择）
 */
export function Select<V extends string | number = string>({
  value,
  options,
  onChange,
  placeholder = "请选择...",
  disabled,
  variant = "framed",
  className,
  renderValue,
  ...aria
}: SelectProps<V>) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.value === value);
  const [active, setActive] = useState(0);
  const isSection = (o: SelectOption<V>) => !!o.disabled;

  const openPopup = () => {
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value)
      )
    );
    setOpen(true);
  };

  const choose = (o: SelectOption<V> | undefined) => {
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
  };

  const onPopupKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(options[active]);
      return;
    }
    const next = listNavigate(e.key, { items: options, active, isSection, wrap: true });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
      return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      const ch = e.key.toLowerCase();
      const n = options.length;
      for (let s = 1; s <= n; s++) {
        const i = (active + s) % n;
        if (!options[i]!.disabled && options[i]!.label.toLowerCase().startsWith(ch)) {
          setActive(i);
          break;
        }
      }
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={aria["aria-label"]}
        disabled={disabled}
        className={clsx(styles.trigger, styles[variant], className)}
        onClick={() => (open ? setOpen(false) : openPopup())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openPopup();
          }
        }}
      >
        {renderValue ? (
          <span className={clsx(styles.value, "select-value")}>{renderValue(current)}</span>
        ) : (
          <>
            {current?.icon && <Icon icon={current.icon} size={14} />}
            <span className={current ? "select-value" : clsx("select-value", styles.placeholder)}>
              {current?.label ?? placeholder}
            </span>
          </>
        )}
        <Icon icon="chevron-down" size={14} className={styles.chevron} />
      </button>

      <Popup
        open={open}
        onClose={() => setOpen(false)}
        anchor={triggerRef}
        matchWidth
        role="presentation"
        className={styles.popup}
      >
        <div tabIndex={-1} data-autofocus onKeyDown={onPopupKey} className={styles.popupInner}>
          {/* 尺寸嗅探：根据最宽项自适应宽度 */}
          <div aria-hidden className={styles.sizer}>
            {options.map((o) => (
              <div key={o.value} className={styles.sizerRow}>
                <span className={styles.check} />
                {o.icon && <Icon icon={o.icon} size={14} />}
                <span>{o.label}</span>
                {o.detail && <span className={styles.sizerDetail}>{o.detail}</span>}
              </div>
            ))}
          </div>

          <List
            items={options}
            getKey={(o) => String(o.value)}
            isSection={isSection}
            renderSection={(o) => <span className={styles.disabled}>{o.label}</span>}
            activeIndex={active}
            onActiveChange={setActive}
            onActivate={(o) => choose(o)}
            focusable={false}
            hoverSelects
            rowHeight={24}
            aria-label={aria["aria-label"]}
            className={styles.list}
            renderItem={(o) => (
              <>
                <span className={styles.check}>
                  {o.value === value && <Icon icon="check" size={12} />}
                </span>
                {o.icon && <Icon icon={o.icon} size={14} />}
                <span className={clsx(styles.optionLabel, o.detail && styles.withDetail)}>
                  {o.label}
                </span>
                {o.detail && (
                  <span className={styles.detail} title={o.detail}>
                    {o.detail}
                  </span>
                )}
              </>
            )}
          />
        </div>
      </Popup>
    </>
  );
}
