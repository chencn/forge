/**
 * 随处搜索的落盘记忆（localStorage，键带 forge 前缀）：
 * 最近打开的文件、最近执行的动作、每个页签自己的搜索历史。
 */
import type { SeTab } from "./seModel";
import { pathWithin, samePath } from "./format";

/** 从 localStorage 读 JSON，损坏或缺键时回退到 fallback。 */
function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 把值序列化进 localStorage；存储不可用（隐私模式等）时静默放弃。 */
function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 存储不可用就算了 */
  }
}

/** 把未知值收窄成字符串数组，非数组成员一律丢弃。 */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

/** 最近文件在 localStorage 里的键。 */
const RECENT_FILES_KEY = "forge:se:recentFiles.v1";
/** 最近文件最多保留的条数。 */
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

/** 最近动作 id 在 localStorage 里的键。 */
const RECENT_ACTIONS_KEY = "forge:se:recentActions.v1";
/** 最近动作最多保留的条数。 */
const MAX_RECENT_ACTIONS = 12;

/** 最近执行过的动作 id，新的在前。 */
export function recentActions(): string[] {
  return strings(loadJson(RECENT_ACTIONS_KEY, [] as unknown));
}

/** 记一笔刚执行过的动作；重复的挪到最前。 */
export function pushRecentAction(id: string) {
  saveJson(RECENT_ACTIONS_KEY, [id, ...recentActions().filter((x) => x !== id)].slice(0, MAX_RECENT_ACTIONS));
}

/** 搜索历史在 localStorage 里的键。 */
const HISTORY_KEY = "forge:se:searchHistory.v1";
/** 搜索历史（跨页签合计）最多保留的条数。 */
const MAX_HISTORY = 50;

/** 一条搜索历史：哪个页签里搜的什么词。 */
interface HistoryEntry {
  tab: SeTab;
  query: string;
}

/** 从 localStorage 读全部页签的搜索历史，坏记录丢弃。 */
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

/** 记一笔某页签的搜索；空查询不记，重复的同词挪到最前。 */
export function pushSearchHistory(tab: SeTab, query: string) {
  const q = query.trim();
  if (!q) return;
  const rest = loadHistory().filter((e) => e.tab !== tab || e.query !== q);
  saveJson(HISTORY_KEY, [{ tab, query: q }, ...rest].slice(0, MAX_HISTORY));
}
