/**
 * 项目树视图状态的持久化：
 * - 视图选项（9 个开关）：`forge:tree:options:<root>`
 * - 视图模式（5 选 1）：`forge:tree:mode:<root>`
 * - 展开状态：`forge:tree:expanded:<root>`（上限 3000 个 key，300ms 防抖写盘）
 *
 * ProjectTree 是组件内 state，刷新/重挂载即丢——这层把三样状态按工程根落盘，重挂载时读回。
 */
import { DEFAULT_VIEW_OPTIONS, type ProjectViewMode, type ViewOptions } from "./ProjectHeader";

/** 展开状态最多保留的 key 数，超出截断。 */
const MAX_EXPANDED = 3000;
/** 合法的视图模式枚举（读回时校验）。 */
const VIEW_MODES: readonly ProjectViewMode[] = [
  "project",
  "projectFiles",
  "openFiles",
  "changedFiles",
  "scratches",
];

/** localStorage 键里的工程根段（路径原样进键名）。 */
type RootKey = string;

/** 读 JSON 并按期望类型返回；缺键、解析失败回退 fallback。 */
function read<T>(storageKey: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 写 JSON；存储满或被禁用时静默忽略。 */
function write(storageKey: string, value: unknown): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // 存储满或被禁用时忽略
  }
}

/** 读回工程根的视图选项，缺项用默认值补齐。 */
export function loadViewOptions(root: RootKey): ViewOptions {
  const raw = read<unknown>(`forge:tree:options:${root}`, {});
  const saved: Partial<ViewOptions> =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Partial<ViewOptions>)
      : {};
  return { ...DEFAULT_VIEW_OPTIONS, ...saved };
}

/** 首次迁移时区分“没有项目级选项”和“已有项目级选项”。 */
export function hasSavedViewOptions(root: RootKey): boolean {
  try {
    return localStorage.getItem(`forge:tree:options:${root}`) !== null;
  } catch {
    return false;
  }
}

/** 持久化工程根的视图选项。 */
export function saveViewOptions(root: RootKey, options: ViewOptions): void {
  write(`forge:tree:options:${root}`, options);
}

/** 读回工程根的视图模式，存值非法或缺失回退 "project"。 */
export function loadViewMode(root: RootKey): ProjectViewMode {
  const saved = read<unknown>(`forge:tree:mode:${root}`, "project");
  return typeof saved === "string" && VIEW_MODES.includes(saved as ProjectViewMode)
    ? (saved as ProjectViewMode)
    : "project";
}

/** 持久化工程根的视图模式。 */
export function saveViewMode(root: RootKey, mode: ProjectViewMode): void {
  write(`forge:tree:mode:${root}`, mode);
}

/** 读回展开状态；从未保存过返回 null（区别于「全部收起」）。 */
export function loadExpanded(root: RootKey): Set<string> | null {
  const list = read<string[] | null>(`forge:tree:expanded:${root}`, null);
  if (!Array.isArray(list)) return null;
  return new Set(list.filter((key): key is string => typeof key === "string").slice(0, MAX_EXPANDED));
}

/** 持久化展开状态（超过 {@link MAX_EXPANDED} 截断）。 */
export function saveExpanded(root: RootKey, expanded: Set<string>): void {
  const list = [...expanded];
  write(`forge:tree:expanded:${root}`, list.slice(0, MAX_EXPANDED));
}
