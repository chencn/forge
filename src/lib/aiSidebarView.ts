import { useCallback, useSyncExternalStore } from "react";
import type { AiProvider } from "./aiCli";

/**
 * AI 会话侧栏的视图偏好（排序、章节顺序、折叠、显示最近/归档）与工具条共享。
 *
 * 参考实现里这些状态由侧栏组件自持；这里抽成模块级小 store，是因为 forge 的
 * 面板标题行（定位/展开全部/视图选项按钮）与列表分属两个组件，两边要读同一份值。
 * 只存当前 WebView 的 localStorage，不进后端设置。
 */

export type AiSidebarSortMode = "created" | "updated";
/** 可排序的两个章节；「置顶」永远在最上，不参与排序。 */
export type AiSidebarSectionId = "sessions" | "recent";
export type AiSidebarSectionKey = "pinned" | AiSidebarSectionId;
export type AiSidebarRecentFilter = "all" | AiSidebarProviderFilter;
export type AiSidebarProviderFilter = AiProvider;

export const AI_SIDEBAR_SECTION_IDS: readonly AiSidebarSectionId[] = ["sessions", "recent"];
export const AI_SIDEBAR_SECTION_KEYS: readonly AiSidebarSectionKey[] = ["pinned", "sessions", "recent"];
export const DEFAULT_SECTION_ORDER: readonly AiSidebarSectionId[] = ["sessions", "recent"];
/** 「最近」章节每页条数；参考实现同值。 */
export const RECENT_PAGE_SIZE = 10;

const KEY = "forge:ai-sidebar-view:v1";

interface AiSidebarViewState {
  sortMode: AiSidebarSortMode;
  sectionOrder: readonly AiSidebarSectionId[];
  /** 折叠的章节；缺省即展开。 */
  collapsed: Partial<Record<AiSidebarSectionKey, boolean>>;
  /** 「最近」章节整体开关。 */
  showRecent: boolean;
  recentFilter: AiSidebarRecentFilter;
  /** 「最近」展开到的条数；null 表示还在第一页。 */
  recentLimit: number | null;
  /** 会话章节是否带出已归档条目。 */
  showArchived: boolean;
}

const DEFAULT_STATE: AiSidebarViewState = {
  sortMode: "created",
  sectionOrder: DEFAULT_SECTION_ORDER,
  collapsed: { recent: true },
  showRecent: true,
  recentFilter: "all",
  recentLimit: null,
  showArchived: false,
};

function normalizeSectionOrder(value: unknown): readonly AiSidebarSectionId[] {
  if (!Array.isArray(value)) return DEFAULT_SECTION_ORDER;
  const kept = AI_SIDEBAR_SECTION_IDS.filter((id) => value.includes(id));
  const added = DEFAULT_SECTION_ORDER.filter((id) => !kept.includes(id));
  return [...kept, ...added];
}

function load(): AiSidebarViewState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_STATE;
    const data = JSON.parse(raw) as Partial<AiSidebarViewState>;
    const sortMode = data.sortMode === "updated" ? "updated" : "created";
    // 「最近」是侧栏底部抽屉：每次打开应用先收起，用户点标题后才在本次运行中展开。
    const collapsed: AiSidebarViewState["collapsed"] = { recent: true };
    for (const key of AI_SIDEBAR_SECTION_KEYS) {
      if (data.collapsed?.[key] === true) collapsed[key] = true;
    }
    return {
      sortMode,
      sectionOrder: normalizeSectionOrder(data.sectionOrder),
      collapsed,
      showRecent: data.showRecent !== false,
      recentFilter: data.recentFilter === "claude" || data.recentFilter === "codex" ? data.recentFilter : "all",
      recentLimit: null,
      showArchived: data.showArchived === true,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

let state = load();
const listeners = new Set<() => void>();
function commit(next: AiSidebarViewState) {
  state = next;
  // 「最近」展开到第几页是阅读手势，只在本次会话有效：落盘时剥掉，重开应用回到第一页。
  const { recentLimit: _sessionOnly, ...persisted } = next;
  try { localStorage.setItem(KEY, JSON.stringify(persisted)); } catch { /* 存不下只丢偏好，不挡界面 */ }
  listeners.forEach((listener) => listener());
}

/** 供面板与工具条共同订阅的视图偏好。 */
export function useAiSidebarView(): AiSidebarViewState {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  const snapshot = useCallback(() => state, []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function setAiSidebarSortMode(sortMode: AiSidebarSortMode) {
  if (state.sortMode === sortMode) return;
  commit({ ...state, sortMode });
}
export function toggleAiSidebarSection(section: AiSidebarSectionKey) {
  const collapsed = { ...state.collapsed };
  if (collapsed[section]) delete collapsed[section];
  else collapsed[section] = true;
  commit({ ...state, collapsed });
}
export function setAllAiSidebarSections(expanded: boolean) {
  if (expanded) {
    if (Object.keys(state.collapsed).length === 0) return;
    commit({ ...state, collapsed: {} });
    return;
  }
  const collapsed: AiSidebarViewState["collapsed"] = {};
  for (const key of AI_SIDEBAR_SECTION_KEYS) {
    // 「置顶」没有内容时不折叠它：折叠一个看不见的章节只会让开关状态莫名奇妙。
    collapsed[key] = true;
  }
  commit({ ...state, collapsed });
}
export function setShowAiSidebarRecent(show: boolean) {
  if (state.showRecent === show) return;
  commit({ ...state, showRecent: show });
}
export function setAiSidebarRecentFilter(filter: AiSidebarRecentFilter) {
  if (state.recentFilter === filter) return;
  commit({ ...state, recentFilter: filter });
}
export function revealMoreAiSidebarRecent() {
  commit({ ...state, recentLimit: (state.recentLimit ?? RECENT_PAGE_SIZE) + RECENT_PAGE_SIZE });
}
export function resetAiSidebarRecentLimit() {
  if (state.recentLimit === null) return;
  commit({ ...state, recentLimit: null });
}
export function setShowAiSidebarArchived(show: boolean) {
  if (state.showArchived === show) return;
  commit({ ...state, showArchived: show });
}
export function moveAiSidebarSection(id: AiSidebarSectionId, delta: number) {
  const order = [...state.sectionOrder];
  const at = order.indexOf(id);
  if (at < 0) return;
  const next = at + delta;
  if (next < 0 || next >= order.length) return;
  [order[at], order[next]] = [order[next], order[at]];
  commit({ ...state, sectionOrder: order });
}

/**
 * 列表控制总线：面板挂载时注册，标题行的「定位当前会话 / 展开全部 / 收起全部」
 * 通过它驱动列表。列表卸载后这些按钮自然失效（空操作）。
 */
interface AiSidebarListCommands {
  scrollToActive?: () => void;
}
const listCommands: AiSidebarListCommands = {};
export function useAiSidebarListCommands(): AiSidebarListCommands {
  return listCommands;
}
export function registerAiSidebarListCommands(commands: AiSidebarListCommands | null) {
  listCommands.scrollToActive = commands?.scrollToActive ?? undefined;
}

/**
 * 相对时间标签（"now" / "5m" / "3h" / "2d" / "5mo" / "1y"）。
 * 与参考实现逐字相同：紧凑的非本地化缩写，各语言下都占一行的固定小宽度。
 * `now` 由调用方传入，同一轮渲染共享一个值，避免同一时间在不同行上显示得不一样。
 */
export function formatAiRelativeTime(timestamp: number | undefined, now: number): string {
  if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) return "";
  const diff = Math.max(0, now - timestamp);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

/** 供测试重置模块状态。 */
export function __resetAiSidebarViewForTest() {
  state = DEFAULT_STATE;
  listeners.forEach((listener) => listener());
}

/** 章节顺序移动的稳定回调集合：避免每次渲染生成新函数导致子组件 memo 失效。 */
export function useAiSidebarSectionMovers() {
  return useCallback((id: AiSidebarSectionId, delta: number) => moveAiSidebarSection(id, delta), []);
}
