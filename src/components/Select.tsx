import type { ReactNode } from "react";
import clsx from "clsx";
import { Select as UiSelect, type SelectOption as UiSelectOption } from "../ui/Select";

export interface SelectOption<T extends string | number> {
  /** 实际写回设置/命令的值。 */
  value: T;
  /** 触发器和列表里显示的主文案。 */
  label: string;
  /** 可选的装饰图标，同时用于触发器与选项。 */
  icon?: ReactNode;
  /** 右侧次级文案，等宽绘制，例如脚本的真实命令。 */
  detail?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string | number> {
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

/**
 * 业务侧下拉选择组件
 * 内部已平滑升级为基于 floating-ui 与虚拟化列表的 UI 规范组件，
 * 彻底消除手写绝对坐标定位与视口溢出问题。
 */
export default function Select<T extends string | number>({
  value,
  options,
  onChange,
  placeholder,
  label,
  className = "",
  disabled = false,
}: SelectProps<T>) {
  return (
    <div className={clsx("select", className)}>
      <UiSelect<T>
        value={value}
        options={options as UiSelectOption<T>[]}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled || options.length === 0}
        aria-label={label}
        className="select-trigger"
      />
    </div>
  );
}
