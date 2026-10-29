/**
 * 随处搜索的落盘记忆（localStorage，键带 forge 前缀）：
 * 最近打开的文件、最近执行的动作、每个页签自己的搜索历史。
 * 对应 openidea 的 everywhere/store.ts + tracking.ts 里前端侧的那几份表。
 */
import type { SeTab } from "./seModel";
import { pathWithin, samePath } from "./format";

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 存储不可用就算了 */
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

const RECENT_FILES_KEY = "forge:se:recentFiles.v1";
const MAX_RECENT_FILES = 50;

/** 最近打开的文件，新的在前。若传入 root 则只返回该项目工程作用域内的文件，彻底防止跨项目推荐污染。 */
export function recentFiles(root?: string | null): string[] {
  const all = loadJson(RECENT_FILES_KEY, [] as string[]);
  if (!root) return all;
  return all.filter((item) => pathWithin(root, item) || samePath(root, item));
}

/** 记一笔「这篇刚被激活」；重复的挪到最前（路径大小写与分隔符都按 samePath 折）。 */
export function pushRecentFile(path: string) {
  const rest = recentFiles().filter((item) => !samePath(item, path));
  saveJson(RECENT_FILES_KEY, [path, ...rest].slice(0, MAX_RECENT_FILES));
}

const RECENT_ACTIONS_KEY = "forge:se:recentActions.v1";
const MAX_RECENT_ACTIONS = 12;

export function recentActions(): string[] {
  return strings(loadJson(RECENT_ACTIONS_KEY, [] as unknown));
}

export function pushRecentAction(id: string) {
  saveJson(RECENT_ACTIONS_KEY, [id, ...recentActions().filter((x) => x !== id)].slice(0, MAX_RECENT_ACTIONS));
}

const HISTORY_KEY = "forge:se:searchHistory.v1";
const MAX_HISTORY = 50;

interface HistoryEntry {
  tab: SeTab;
  query: string;
}

function loadHistory(): HistoryEntry[] {
  const v = loadJson(HISTORY_KEY, [] as unknown);
  return Array.isArray(v)
    ? v.filter((e): e is HistoryEntry => typeof e?.tab === "string" && typeof e?.query === "string")
    : [];
}

/** 某个页签里打过的查询，新的在前；开弹窗时用作预填。 */
export function searchHistory(tab: SeTab): string[] {
  return loadHistory()
    .filter((e) => e.tab === tab)
    .map((e) => e.query);
}

export function pushSearchHistory(tab: SeTab, query: string) {
  const q = query.trim();
  if (!q) return;
  const rest = loadHistory().filter((e) => e.tab !== tab || e.query !== q);
  saveJson(HISTORY_KEY, [{ tab, query: q }, ...rest].slice(0, MAX_HISTORY));
}
