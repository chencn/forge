/**
 * 每文件缩进覆盖（状态栏缩进段的 per-file 切换）：
 * forge 的缩进默认是全工程一把尺（空格 × tabSize，.editorconfig 可按目录覆盖），
 * 这里提供单文件一档覆盖——状态栏缩进段点开的菜单写进来，编辑器装配时优先读。
 *
 * 会话内改动存 localStorage，持久化是它的本意。
 */
import { canonicalPath } from "./format";

/** 单文件的缩进覆盖（字段可缺省，缺省项回落工程默认）。 */
export interface IndentOverride {
  /** 用几个空格缩进。 */
  spaces?: number;
  /** 用制表符缩进（宽度仍按 tabSize）。 */
  useTabs?: boolean;
}

/** localStorage 键。 */
const STORAGE_KEY = "forge.indentOverrides";

/** 路径 → 覆盖（模块级单例，启动时从 localStorage 装载）。 */
const overrides = new Map<string, IndentOverride>();
/** 覆盖变化订阅者。 */
const listeners = new Set<() => void>();
/** 外部存储的版本号：useSyncExternalStore 的快照，写一次跳一格。 */
let revision = 0;

/** 模块加载时从 localStorage 装载（坏数据当没有）。 */
function load(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value && typeof value === "object") overrides.set(key, value as IndentOverride);
      }
    }
  } catch {
    // 坏数据当没有：菜单里重设一次就好。
  }
}

/** 把覆盖表写回 localStorage（写不进就只留在本会话）。 */
function persist(): void {
  try {
    const raw: Record<string, IndentOverride> = {};
    for (const [key, value] of overrides) raw[key] = value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
  } catch {
    // 无痕模式存不进去就只留在本会话。
  }
}

if (typeof localStorage !== "undefined") load();

/** 该文件的缩进覆盖；没设过返回 null。 */
export function indentOverrideOf(path: string): IndentOverride | null {
  return overrides.get(canonicalPath(path)) ?? null;
}

/** 写入（或传 null 清除）该文件的缩进覆盖。 */
export function setIndentOverride(path: string, override: IndentOverride | null): void {
  const key = canonicalPath(path);
  if (override) overrides.set(key, override);
  else overrides.delete(key);
  persist();
  revision += 1;
  for (const notify of listeners) notify();
}

/** useSyncExternalStore 订阅入口。 */
export function subscribeIndent(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** useSyncExternalStore 快照：版本号，变了才重渲染。 */
export function indentRevision(): number {
  return revision;
}
