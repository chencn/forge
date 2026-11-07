/**
 * 主题与外观管理系统
 *
 * 规范原生支持：
 * 1. Islands Dark (暗色)
 * 2. Islands Light (浅色)
 * 3. High Contrast (高对比度)
 * 4. 跟随操作系统深浅模式 (system)
 */

/** 一款内置主题的元信息。 */
export interface BuiltinThemeInfo {
  readonly id: BuiltinThemeId;
  readonly label: string;
  readonly kind: "light" | "dark";
  readonly description?: string;
}

/** 全部内置主题。 */
export const BUILTIN_THEMES: readonly BuiltinThemeInfo[] = [
  { id: "dark", label: "Islands Dark", kind: "dark", description: "经典暗色主题" },
  { id: "light", label: "Islands Light", kind: "light", description: "素雅浅色主题" },
  { id: "dark-hc", label: "High Contrast", kind: "dark", description: "高对比度无障碍暗色主题" },
] as const;

/** 内置主题 id。 */
export type BuiltinThemeId = "dark" | "light" | "dark-hc";

/** 用户的主题偏好：内置主题或跟随系统。 */
export type ThemePreference = BuiltinThemeId | "system";

/** 内置主题 id 列表（从 {@link BUILTIN_THEMES} 投影）。 */
export const BUILTIN_THEME_IDS: readonly BuiltinThemeId[] = BUILTIN_THEMES.map((t) => t.id);

/** 值是否是合法的内置主题 id。 */
export function isBuiltinTheme(value: unknown): value is BuiltinThemeId {
  return typeof value === "string" && (BUILTIN_THEME_IDS as readonly string[]).includes(value as BuiltinThemeId);
}

/** 主题的深浅归属。 */
export function themeKind(id: BuiltinThemeId): "light" | "dark" {
  if (id === "light") return "light";
  return "dark";
}

/** 默认强调色（经典蓝） */
export const DEFAULT_ACCENT = "#3871e1";

/** 预设强调色板 */
export const ACCENT_PRESETS = [
  { value: DEFAULT_ACCENT, label: "蓝色 (默认)" },
  { value: "#24a394", label: "青绿 (Teal)" },
  { value: "#955ae0", label: "紫色 (Purple)" },
  { value: "#e08855", label: "橙色 (Orange)" },
  { value: "#369650", label: "绿色 (Green)" },
  { value: "#e55765", label: "赤红 (Red)" },
] as const;

/** 强调色合法性（#RGB–#RRGGBBAA）。 */
const ACCENT_RE = /^#[0-9a-f]{3,8}$/i;

/**
 * 将主题属性落地到 document.documentElement
 */
export function applyThemeAttributes(
  themeId: BuiltinThemeId,
  accent?: string | null,
  root: HTMLElement = document.documentElement
): void {
  // 1. 清理多余属性
  delete root.dataset.colorTheme;

  // 2. 设置深浅模式与主题标识
  if (themeId === "dark-hc") {
    root.dataset.theme = "dark-hc";
    root.dataset.contrast = "high";
    root.style.colorScheme = "dark";
  } else if (themeId === "light") {
    root.dataset.theme = "light";
    delete root.dataset.contrast;
    root.style.colorScheme = "light";
  } else {
    root.dataset.theme = "dark";
    delete root.dataset.contrast;
    root.style.colorScheme = "dark";
  }

  // 3. 应用重音色覆盖
  if (accent && ACCENT_RE.test(accent) && accent.toLowerCase() !== DEFAULT_ACCENT) {
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--button-solid", accent);
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--button-solid");
  }
}

/**
 * 根据系统环境解析最终生效的主题 ID
 */
export function resolveThemeId(
  preference: ThemePreference | undefined,
  systemIsDark: boolean,
  preferredLightTheme: BuiltinThemeId = "light",
  preferredDarkTheme: BuiltinThemeId = "dark"
): BuiltinThemeId {
  if (!preference || preference === "system") {
    return systemIsDark ? preferredDarkTheme : preferredLightTheme;
  }
  return isBuiltinTheme(preference) ? preference : "dark";
}
