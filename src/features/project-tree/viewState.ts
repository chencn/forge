/**
 * 项目树视图状态的持久化（对齐 IDEA project-tree/store.ts 的持久层）：
 * - 视图选项（9 个开关）：`forge:tree:options:<root>`
 * - 视图模式（5 选 1）：`forge:tree:mode:<root>`
 * - 展开状态：`forge:tree:expanded:<root>`（上限 3000 个 key，300ms 防抖写盘）
 *
 * IDEA 用单一 zustand store 常驻内存；forge 的 ProjectTree 是组件内 state，
 * 刷新/重挂载即丢——这层把三样状态按工程根落盘，重挂载时读回。
 */
import { DEFAULT_VIEW_OPTIONS, type ProjectViewMode, type ViewOptions } from "./ProjectHeader";

const MAX_EXPANDED = 3000;
const VIEW_MODES: readonly ProjectViewMode[] = [
  "project",
  "projectFiles",
  "openFiles",
  "changedFiles",
  "scratches",
];

type RootKey = string;

function read<T>(storageKey: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(storageKey: string, value: unknown): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // 存储满或被禁用时忽略
  }
}

export function loadViewOptions(root: RootKey): ViewOptions {
  const raw = read<unknown>(`forge:tree:options:${root}`, {});
  const saved: Partial<ViewOptions> & { _v?: number } =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Partial<ViewOptions> & { _v?: number })
      : {};
  // _v4 对齐 IDEA 默认值：单击打开/单击展开/预览标签页默认关（v2/v3 曾强推为 true，一并迁回）。
  // v4 起才认用户自己保存的值；更老的数据里的 true 是当年迁移强推的，不当作用户偏好。
  const legacy = !saved._v || saved._v < 4;
  const singleClickOpen = legacy ? false : (saved.singleClickOpen ?? false);
  const singleClickExpand = legacy ? false : (saved.singleClickExpand ?? false);
  const previewTab = legacy ? false : (saved.previewTab ?? false);
  const { _v: _version, ...persisted } = saved;
  void _version;
  return { ...DEFAULT_VIEW_OPTIONS, ...persisted, singleClickOpen, singleClickExpand, previewTab };
}

/** 首次迁移时区分“没有项目级选项”和“已有项目级选项”。 */
export function hasSavedViewOptions(root: RootKey): boolean {
  try {
    return localStorage.getItem(`forge:tree:options:${root}`) !== null;
  } catch {
    return false;
  }
}

export function saveViewOptions(root: RootKey, options: ViewOptions): void {
  write(`forge:tree:options:${root}`, { ...options, _v: 4 });
}

export function loadViewMode(root: RootKey): ProjectViewMode {
  const saved = read<unknown>(`forge:tree:mode:${root}`, "project");
  return typeof saved === "string" && VIEW_MODES.includes(saved as ProjectViewMode)
    ? (saved as ProjectViewMode)
    : "project";
}

export function saveViewMode(root: RootKey, mode: ProjectViewMode): void {
  write(`forge:tree:mode:${root}`, mode);
}

export function loadExpanded(root: RootKey): Set<string> | null {
  const list = read<string[] | null>(`forge:tree:expanded:${root}`, null);
  if (!Array.isArray(list)) return null;
  return new Set(list.filter((key): key is string => typeof key === "string").slice(0, MAX_EXPANDED));
}

export function saveExpanded(root: RootKey, expanded: Set<string>): void {
  const list = [...expanded];
  write(`forge:tree:expanded:${root}`, list.slice(0, MAX_EXPANDED));
}
