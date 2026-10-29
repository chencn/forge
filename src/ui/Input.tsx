import {
  forwardRef,
  useRef,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { Icon, type LucideIconType } from "./Icon";
import { IconButton } from "./Button";
import styles from "./Input.module.css";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  invalid?: boolean;
  mono?: boolean;
  /** `bare` 去除外边框（适用于嵌入式或浮层内部） */
  variant?: "framed" | "bare";
}

/**
 * 基础单行文本输入框
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    invalid,
    mono,
    variant = "framed",
    className,
    spellCheck = false,
    autoComplete = "off",
    placeholder,
    "aria-label": ariaLabel,
    ...rest
  },
  ref
) {
  return (
    <input
      ref={ref}
      spellCheck={spellCheck}
      autoComplete={autoComplete}
      autoCorrect="off"
      autoCapitalize="off"
      aria-invalid={invalid || undefined}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={clsx(
        styles.input,
        variant === "bare" ? styles.bare : styles.framed,
        mono && styles.mono,
        className
      )}
      {...rest}
    />
  );
});

export interface SearchToggle {
  id: string;
  icon: string | LucideIconType | ReactNode;
  title: string;
  shortcut?: string;
  pressed: boolean;
  onToggle: (pressed: boolean) => void;
}

export interface SearchFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "size"> {
  value: string;
  onChange: (value: string) => void;
  leadingIcon?: string | LucideIconType | ReactNode | null;
  /** 后缀开关按钮（如 Match Case / Words / Regex） */
  toggles?: SearchToggle[];
  /** 额外后缀内容（如结果计数） */
  trailing?: ReactNode;
  clearable?: boolean;
  invalid?: boolean;
  size?: "normal" | "large";
  variant?: "framed" | "bare";
  className?: string;
  multiline?: boolean;
}

const isNewLineKey = (e: KeyboardEvent) =>
  e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey;

/**
 * 专业级 IDE 搜索输入框（支持前缀图标、正则/大小写切换组、清空按钮及多行展开）
 */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  {
    value,
    onChange,
    leadingIcon = "search",
    toggles,
    trailing,
    clearable = true,
    invalid,
    size = "normal",
    variant = "framed",
    className,
    placeholder,
    multiline,
    "aria-label": ariaLabel,
    ...rest
  },
  ref
) {
  const inner = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const setRef = (el: HTMLInputElement | HTMLTextAreaElement | null) => {
    inner.current = el;
    if (typeof ref === "function") ref(el as HTMLInputElement);
    else if (ref) ref.current = el as HTMLInputElement;
  };

  const insertNewLine = () => {
    const el = inner.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    onChange(`${value.slice(0, start)}\n${value.slice(end)}`);
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(start + 1, start + 1);
    }, 0);
  };

  const { onKeyDown, ...fieldProps } = rest;

  const keyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (multiline && isNewLineKey(e)) {
      e.preventDefault();
      insertNewLine();
      return;
    }
    if (e.key === "Escape" && value && clearable) {
      e.preventDefault();
      onChange("");
      return;
    }
    onKeyDown?.(e);
  };

  const lines = multiline ? value.split("\n").length : 1;

  return (
    <div
      className={clsx(
        styles.searchField,
        variant === "framed" && styles.framed,
        size === "large" && styles.large,
        multiline && styles.multiline,
        invalid && styles.invalid,
        className
      )}
    >
      {leadingIcon && (
        <span className={styles.leading}>
          <Icon icon={leadingIcon} size={size === "large" ? 18 : 14} />
        </span>
      )}

      {multiline ? (
        <textarea
          ref={setRef}
          value={value}
          rows={Math.min(lines, 8)}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={clsx(
            styles.searchInput,
            styles.searchArea,
            lines <= 1 && styles.searchAreaSingle
          )}
          onKeyDown={keyDown as any}
          {...(fieldProps as any)}
        />
      ) : (
        <input
          ref={setRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={styles.searchInput}
          onKeyDown={keyDown}
          {...fieldProps}
        />
      )}

      {toggles?.map((t) => (
        <IconButton
          key={t.id}
          icon={t.icon}
          title={t.title}
          shortcut={t.shortcut}
          pressed={t.pressed}
          size={size === "large" ? "normal" : "small"}
          onClick={() => t.onToggle(!t.pressed)}
        />
      ))}

      {clearable && value && (
        <IconButton
          icon="close"
          title="清空"
          size={size === "large" ? "normal" : "small"}
          onClick={() => {
            onChange("");
            inner.current?.focus();
          }}
        />
      )}

      {trailing}
    </div>
  );
});
