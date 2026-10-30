import type { FC } from "react";
import { javaKindSvg } from "../lib/javaKindIcons";
import { useSettings } from "../hooks/useSettings";

/**
 * 1:1 对标 IntelliJ IDEA 的各类符号徽章（16x16）
 * 浅色与深色主题分别调教了对比度与发光效果。
 */
const SYMBOL_SVGS_LIGHT: Record<string, string> = {
  // 结构体 Struct（橙黄底，中字符 S）
  struct:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#FFF7ED" stroke="#EA580C"/><path d="M6 10.5C6.5 11 7.2 11.3 8 11.3C9.1 11.3 9.8 10.7 9.8 9.9C9.8 9.1 9.2 8.7 8.2 8.4L7.5 8.1C6.2 7.7 5.5 7.1 5.5 5.9C5.5 4.7 6.6 3.8 8 3.8C8.8 3.8 9.5 4.1 10 4.5L9.4 5.4C9 5.1 8.5 4.8 8 4.8C7.2 4.8 6.6 5.3 6.6 6C6.6 6.7 7.2 7.1 8.2 7.4L8.9 7.7C10.3 8.1 11 8.8 11 10C11 11.3 9.8 12.3 8 12.3C7 12.3 6.2 11.9 5.5 11.3L6 10.5Z" fill="#EA580C"/></svg>',
  // 特征 / 类型别名 Trait / TypeAlias（青绿底，中字符 T）
  trait:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#F0FDFA" stroke="#0D9488"/><path d="M5 5H11V6.2H8.7V11.5H7.3V6.2H5V5Z" fill="#0D9488"/></svg>',
  typeAlias:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#F0FDFA" stroke="#0D9488"/><path d="M5 5H11V6.2H8.7V11.5H7.3V6.2H5V5Z" fill="#0D9488"/></svg>',
  // 函数 Function（粉紫底，小立方体/标志 f）
  function:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" fill="#FAF5FF" stroke="#9333EA"/><path d="M9.5 4.5C8.8 4.5 8.2 4.8 8 5.4L8 6.2H9.5V7.2H8V11.5H6.8V7.2H5.5V6.2H6.8V5.3C6.8 4.2 7.6 3.5 8.9 3.5C9.4 3.5 9.8 3.6 10 3.8L9.5 4.8C9.5 4.5 9.5 4.5 9.5 4.5Z" fill="#9333EA"/></svg>',
  // 方法 Method（紫色圆角矩形，中字符 m）
  method:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" fill="#FAF5FF" stroke="#9333EA"/><path d="M4.5 11.5V5.5H5.8L7.2 8.8L8.6 5.5H9.9V11.5H8.7V7.5L7.6 10H6.8L5.7 7.5V11.5H4.5Z" fill="#9333EA"/></svg>',
  // 构造函数
  constructor:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" fill="#FAF5FF" stroke="#9333EA"/><path d="M4.5 11.5V5.5H5.8L7.2 8.8L8.6 5.5H9.9V11.5H8.7V7.5L7.6 10H6.8L5.7 7.5V11.5H4.5Z" fill="#9333EA"/></svg>',
  // 属性 / 字段 / 变量 Field / Property / Variable（蓝灰圆角矩形，带 p / f / v）
  field:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#F0F9FF" stroke="#0284C7"/><path d="M5.5 11.5V4.5H10.5V5.5H6.7V7.5H10V8.5H6.7V11.5H5.5Z" fill="#0284C7"/></svg>',
  property:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#F0F9FF" stroke="#0284C7"/><path d="M5.5 11.5V4.5H8.5C9.8 4.5 10.5 5.3 10.5 6.5C10.5 7.7 9.8 8.5 8.5 8.5H6.7V11.5H5.5ZM6.7 7.5H8.3C9.1 7.5 9.4 7.1 9.4 6.5C9.4 5.9 9.1 5.5 8.3 5.5H6.7V7.5Z" fill="#0284C7"/></svg>',
  variable:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#F0F9FF" stroke="#0284C7"/><path d="M5 5L7.4 11.5H8.6L11 5H9.7L8 10L6.3 5H5Z" fill="#0284C7"/></svg>',
  // 常量 Constant（琥珀橙圆，中字符 c）
  constant:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#FFFBEB" stroke="#D97706"/><path d="M8.1 11.5C9.6 11.5 10.9 10.6 11.2 9.3H10.2C9.9 10.1 9.1 10.6 8.1 10.6C6.8 10.6 5.8 9.5 5.8 8C5.8 6.5 6.8 5.4 8.1 5.4C9.1 5.4 9.9 5.9 10.2 6.7H11.2C10.9 5.4 9.6 4.5 8.1 4.5C6.2 4.5 4.8 6 4.8 8C4.8 10 6.2 11.5 8.1 11.5Z" fill="#D97706"/></svg>',
  // 模块 Module / Namespace
  module:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2L13.5 5.2V11.5L8 14.8L2.5 11.5V5.2L8 2Z" fill="#F1F5F9" stroke="#64748B"/><path d="M8 2V8.5M8 8.5L13.5 11.5M8 8.5L2.5 11.5" stroke="#64748B"/></svg>',
};

const SYMBOL_SVGS_DARK: Record<string, string> = {
  struct:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#432617" stroke="#FB923C"/><path d="M6 10.5C6.5 11 7.2 11.3 8 11.3C9.1 11.3 9.8 10.7 9.8 9.9C9.8 9.1 9.2 8.7 8.2 8.4L7.5 8.1C6.2 7.7 5.5 7.1 5.5 5.9C5.5 4.7 6.6 3.8 8 3.8C8.8 3.8 9.5 4.1 10 4.5L9.4 5.4C9 5.1 8.5 4.8 8 4.8C7.2 4.8 6.6 5.3 6.6 6C6.6 6.7 7.2 7.1 8.2 7.4L8.9 7.7C10.3 8.1 11 8.8 11 10C11 11.3 9.8 12.3 8 12.3C7 12.3 6.2 11.9 5.5 11.3L6 10.5Z" fill="#FB923C"/></svg>',
  trait:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#133E3B" stroke="#2DD4BF"/><path d="M5 5H11V6.2H8.7V11.5H7.3V6.2H5V5Z" fill="#2DD4BF"/></svg>',
  typeAlias:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#133E3B" stroke="#2DD4BF"/><path d="M5 5H11V6.2H8.7V11.5H7.3V6.2H5V5Z" fill="#2DD4BF"/></svg>',
  function:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" fill="#3B234F" stroke="#C084FC"/><path d="M9.5 4.5C8.8 4.5 8.2 4.8 8 5.4L8 6.2H9.5V7.2H8V11.5H6.8V7.2H5.5V6.2H6.8V5.3C6.8 4.2 7.6 3.5 8.9 3.5C9.4 3.5 9.8 3.6 10 3.8L9.5 4.8C9.5 4.5 9.5 4.5 9.5 4.5Z" fill="#C084FC"/></svg>',
  method:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" fill="#3B234F" stroke="#C084FC"/><path d="M4.5 11.5V5.5H5.8L7.2 8.8L8.6 5.5H9.9V11.5H8.7V7.5L7.6 10H6.8L5.7 7.5V11.5H4.5Z" fill="#C084FC"/></svg>',
  constructor:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" fill="#3B234F" stroke="#C084FC"/><path d="M4.5 11.5V5.5H5.8L7.2 8.8L8.6 5.5H9.9V11.5H8.7V7.5L7.6 10H6.8L5.7 7.5V11.5H4.5Z" fill="#C084FC"/></svg>',
  field:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#163753" stroke="#38BDF8"/><path d="M5.5 11.5V4.5H10.5V5.5H6.7V7.5H10V8.5H6.7V11.5H5.5Z" fill="#38BDF8"/></svg>',
  property:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#163753" stroke="#38BDF8"/><path d="M5.5 11.5V4.5H8.5C9.8 4.5 10.5 5.3 10.5 6.5C10.5 7.7 9.8 8.5 8.5 8.5H6.7V11.5H5.5ZM6.7 7.5H8.3C9.1 7.5 9.4 7.1 9.4 6.5C9.4 5.9 9.1 5.5 8.3 5.5H6.7V7.5Z" fill="#38BDF8"/></svg>',
  variable:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#163753" stroke="#38BDF8"/><path d="M5 5L7.4 11.5H8.6L11 5H9.7L8 10L6.3 5H5Z" fill="#38BDF8"/></svg>',
  constant:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#422915" stroke="#FBBF24"/><path d="M8.1 11.5C9.6 11.5 10.9 10.6 11.2 9.3H10.2C9.9 10.1 9.1 10.6 8.1 10.6C6.8 10.6 5.8 9.5 5.8 8C5.8 6.5 6.8 5.4 8.1 5.4C9.1 5.4 9.9 5.9 10.2 6.7H11.2C10.9 5.4 9.6 4.5 8.1 4.5C6.2 4.5 4.8 6 4.8 8C4.8 10 6.2 11.5 8.1 11.5Z" fill="#FBBF24"/></svg>',
  module:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2L13.5 5.2V11.5L8 14.8L2.5 11.5V5.2L8 2Z" fill="#243042" stroke="#94A3B8"/><path d="M8 2V8.5M8 8.5L13.5 11.5M8 8.5L2.5 11.5" stroke="#94A3B8"/></svg>',
};

export interface SymbolIconProps {
  kind: string;
  size?: number;
  className?: string;
}

/**
 * 规范符号图标组件
 * 将通用符号种类（class, interface, enum, struct, trait, function, method, constant 等）
 * 映射为 JetBrains 经典彩色徽章。
 */
export const SymbolIcon: FC<SymbolIconProps> = ({ kind, size = 16, className = "" }) => {
  const { applied } = useSettings();
  const isDark = applied === "dark";
  const normalized = kind.toLowerCase();

  // 1. 若命中 javaKindIcons 已经支持的经典类型（类、接口、枚举、注解、记录、异常）
  if (normalized === "class") {
    return (
      <span
        className={`entry-icon ${className}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: javaKindSvg("java.class", isDark) }}
      />
    );
  }
  if (normalized === "interface") {
    return (
      <span
        className={`entry-icon ${className}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: javaKindSvg("java.interface", isDark) }}
      />
    );
  }
  if (normalized === "enum") {
    return (
      <span
        className={`entry-icon ${className}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: javaKindSvg("java.enum", isDark) }}
      />
    );
  }
  if (normalized === "annotation") {
    return (
      <span
        className={`entry-icon ${className}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: javaKindSvg("java.annotation", isDark) }}
      />
    );
  }
  if (normalized === "record") {
    return (
      <span
        className={`entry-icon ${className}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: javaKindSvg("java.record", isDark) }}
      />
    );
  }
  if (normalized === "exception") {
    return (
      <span
        className={`entry-icon ${className}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: javaKindSvg("java.exception", isDark) }}
      />
    );
  }

  // 2. 查扩展符号表
  const dict = isDark ? SYMBOL_SVGS_DARK : SYMBOL_SVGS_LIGHT;
  const svg = dict[normalized] ?? (isDark ? SYMBOL_SVGS_DARK.function : SYMBOL_SVGS_LIGHT.function);

  return (
    <span
      className={`entry-icon ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
};

export default SymbolIcon;
