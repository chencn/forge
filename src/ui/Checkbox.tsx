import { useId, type ReactNode } from "react";
import clsx from "clsx";
import { Icon } from "./Icon";
import styles from "./Checkbox.module.css";

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  /** 三态复选框（混合态） */
  indeterminate?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * 复选框组件（支持选中、未选中与半选状态）
 */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  indeterminate,
  className,
  ...aria
}: CheckboxProps) {
  const id = useId();
  return (
    <label className={clsx(styles.row, disabled && styles.disabled, className)} htmlFor={id}>
      <span className={styles.boxWrap}>
        <input
          id={id}
          type="checkbox"
          className={styles.native}
          checked={checked}
          disabled={disabled}
          aria-checked={indeterminate ? "mixed" : checked}
          aria-label={aria["aria-label"]}
          onChange={(e) => onChange(e.target.checked)}
          ref={(el) => {
            if (el) el.indeterminate = !!indeterminate;
          }}
        />
        <span className={clsx(styles.box, (checked || indeterminate) && styles.on)} aria-hidden>
          {indeterminate ? <Icon icon="minus" size={12} /> : checked ? <Icon icon="check" size={12} /> : null}
        </span>
      </span>
      {label != null && <span className={styles.label}>{label}</span>}
    </label>
  );
}

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * IDEA 风格开关组件（ON/OFF 滑块）
 */
export function Toggle({ checked, onChange, label, disabled, className, ...aria }: ToggleProps) {
  return (
    <label className={clsx(styles.row, disabled && styles.disabled, className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={aria["aria-label"]}
        disabled={disabled}
        className={clsx(styles.switch, checked && styles.switchOn)}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.knob} />
        <span className={styles.knobLabel} aria-hidden>
          {checked ? "ON" : "OFF"}
        </span>
      </button>
      {label != null && <span className={styles.label}>{label}</span>}
    </label>
  );
}
