/**
 * 随处搜索的结果模型：条目类型、各分节的合并与排序、弹窗渲染的那张平表
 * （分节标题 + 「更多」行 + 条目）。抄 openidea 的 everywhere/model.ts，
 * 去掉了这边没有数据源的两块：LSP workspace/symbol 合并与设置页条目。
 */
import type { FileHit, SymbolHit, TextHit } from "./fs";
import type { ForgeCommand } from "./commands";
import { byScore, matchText } from "./seRank";
import { basenameOf } from "./format";

/** 弹窗页签。openidea 的六档原样搬，动作档的数据源换成命令面板那张表。 */
export type SeTab = "all" | "classes" | "files" | "symbols" | "actions" | "text";
/** 数据分节：All 页签按权重混排时，每节各自保持源内顺序。 */
export type SectionId = "recent" | "recentActions" | "classes" | "files" | "symbols" | "actions" | "text";

export const TABS: ReadonlyArray<{ id: SeTab }> = [
  { id: "all" },
  { id: "classes" },
  { id: "files" },
  { id: "symbols" },
  { id: "actions" },
  { id: "text" },
];

export const SECTION_ORDER: readonly SectionId[] = [
  "recent",
  "recentActions",
  "classes",
  "files",
  "symbols",
  "actions",
  "text",
];

/** 每个页签查哪些分节：空查询只看「最近」，两档以上才混排。 */
export function sectionsFor(tab: SeTab, emptyQuery: boolean): SectionId[] {
  if (emptyQuery) {
    switch (tab) {
      case "all":
        return ["recent", "recentActions"];
      case "files":
        return ["recent"];
      case "actions":
        return ["recentActions"];
      default:
        return [];
    }
  }
  return tab === "all" ? ["classes", "files", "symbols", "actions", "text"] : [tab];
}

export const ALL_TAB_LIMIT = 6;
export const TAB_LIMIT = 50;
export const MORE_STEP_ALL = 15;
export const MORE_STEP_TAB = 50;
export const RECENT_LIMIT = 15;

export interface FileItem {
  kind: "file";
  key: string;
  path: string;
  name: string;
  /** 相对根的目录，`/` 连接；根下为空串。 */
  dir: string;
  isDir: boolean;
  nameIndices: number[];
  /** `File.kt:42` 那种输入带的行号，1 起。 */
  line: number | null;
  col: number | null;
}

export interface SymbolItem {
  kind: "symbol";
  key: string;
  name: string;
  /** 展示名：可调用符号带 `()`，照 IDEA。 */
  display: string;
  symbolKind: string;
  path: string;
  /** 所在文件的名，右侧那一格用。 */
  file: string;
  dir: string;
  /** 行号/列号 1 起，直接给 docs.openHit。 */
  line: number;
  col: number;
  indices: number[];
}

export interface ActionItem {
  kind: "action";
  key: string;
  id: string;
  title: string;
  shortcut?: string;
  indices: number[];
  score: number;
}

export interface TextItem {
  kind: "text";
  key: string;
  path: string;
  name: string;
  dir: string;
  line: number;
  /** 1 起，直接给 docs.openHit。 */
  col: number;
  endCol: number;
  /** 缩进折到最多两个空格的那一行。 */
  text: string;
  indices: number[];
  /** 后端原样的一条命中，激活时要交给底部查找窗口。 */
  hit: TextHit;
}

export type SeItem = FileItem | SymbolItem | ActionItem | TextItem;

export type SeRow =
  | { kind: "section"; key: string; section: SectionId; title: string }
  | { kind: "command"; key: string; name: string; tab: SeTab; label: string }
  | { kind: "more"; key: string; section: SectionId }
  | (SeItem & { section: SectionId });

export interface SectionState {
  items: SeItem[];
  hasMore: boolean;
  loading: boolean;
}

/** 后端没有名字下标表，回来用本地匹配器现算：名称优先，折不进名称就落在相对路径上。 */
export function fileItem(m: FileHit, query: string, line: number | null = null, col: number | null = null): FileItem {
  const rel = m.container ? `${m.container}/${m.name}` : m.name;
  const inName = matchText(m.name, query);
  const inRel = inName ? null : matchText(rel, query);
  return {
    kind: "file",
    key: `f:${m.path}`,
    path: m.path,
    name: m.name,
    dir: m.container,
    isDir: m.isDir,
    nameIndices: inName ? inName.indices : (inRel?.indices.filter((i) => i > m.container.length) ?? []).map((i) => i - m.container.length - 1),
    line,
    col,
  };
}

const CALLABLE = new Set(["function", "method", "constructor"]);
/** 展示名，IDEA 风格：可调用符号带 `()`。 */
export function symbolDisplayName(name: string, kind: string): string {
  return CALLABLE.has(kind) && !name.endsWith(")") ? `${name}()` : name;
}

/** 「类」档收录的种类，与 Rust `is_type_kind` 同一张表。 */
const TYPE_KINDS = new Set(["class", "interface", "struct", "enum", "trait", "typeAlias", "record", "annotation", "object", "union"]);
export const isTypeKind = (kind: string) => TYPE_KINDS.has(kind);

export function symbolItem(m: SymbolHit, query: string): SymbolItem {
  const hit = matchText(m.name, query);
  return {
    kind: "symbol",
    key: `s:${m.path}:${m.line}:${m.column}:${m.name}`,
    name: m.name,
    display: symbolDisplayName(m.name, m.kind),
    symbolKind: m.kind,
    path: m.path,
    file: basenameOf(m.path),
    dir: m.container,
    line: m.line,
    col: m.column,
    indices: hit?.indices ?? [],
  };
}

/**
 * 动作匹配，照 openidea 的 matchActions 减去 enabled/hidden/toggled：
 * 词对齐的标签匹配为主，散落的逐字命中只认 id 包含，最近执行过的往上抬。
 */
export function matchActions(
  commands: readonly ForgeCommand[],
  query: string,
  recent: readonly string[]
): ActionItem[] {
  const q = query.trim();
  if (!q) return [];
  const out: ActionItem[] = [];
  const recentRank = new Map(recent.map((id, i) => [id, i]));
  for (const c of commands) {
    let score: number;
    let indices: number[] = [];
    const title = matchText(c.label, q, { wordAligned: true });
    const loose = title ? null : matchText(c.label, q);
    if (title) {
      score = title.score;
      indices = title.indices;
    } else if (loose) {
      score = loose.score;
      indices = loose.indices;
    } else if (c.id.toLowerCase().includes(q.toLowerCase())) {
      score = -400;
    } else {
      continue;
    }
    const r = recentRank.get(c.id);
    if (r !== undefined) score += 40 - Math.min(30, r * 3);
    out.push({ kind: "action", key: `a:${c.id}`, id: c.id, title: c.label, shortcut: c.shortcut, indices, score });
  }
  return byScore(out);
}

/** 后端的一条正文命中折成弹窗行：缩进最多留两个空格，IDEA 同款。 */
export function textItem(hit: TextHit): TextItem {
  const chars = [...hit.snippet];
  const start = hit.snippetFrom - 1;
  let ws = 0;
  while (ws < chars.length && /\s/.test(chars[ws]!)) ws++;
  const indent = " ".repeat(Math.min(ws, 2));
  const lead = ws - indent.length;
  const text = indent + chars.slice(ws).join("").trimEnd();
  const indices: number[] = [];
  for (const range of hit.ranges) {
    const from = Math.max(range.column - 1 - start, ws);
    const to = Math.min(range.column - 1 - start + range.length, start + 1 + chars.length);
    for (let i = from; i < to; i++) if (i - lead < text.length) indices.push(i - lead);
  }
  const first = hit.ranges[0];
  return {
    kind: "text",
    key: `t:${hit.path}:${hit.line}:${first?.column ?? 0}`,
    path: hit.path,
    name: hit.name,
    dir: hit.container,
    line: hit.line,
    col: first ? first.column : 1,
    endCol: first ? first.column + first.length : 1,
    text,
    indices,
    hit,
  };
}

// ---------------------------------------------------------------------------
// 行

/** All 页签混排的分节。 */
const MIXED: readonly SectionId[] = ["classes", "files", "symbols", "actions", "text"];

/**
 * 一处文本命中的权重：正文匹配低于任何起头的名字匹配、高于散落的逐字名匹配。
 */
export const TEXT_WEIGHT = 350;

/** 条目对查询的匹配度（IDEA 的 MatchingDegree）。 */
export function itemWeight(item: SeItem, query: string): number {
  const name = (text: string) => matchText(text, query)?.score;
  switch (item.kind) {
    case "file":
      return name(item.name) ?? (name(item.dir ? `${item.dir}/${item.name}` : item.name) ?? 0) - 200;
    case "symbol":
      return name(item.name) ?? 0;
    case "action":
      return item.score;
    case "text":
      return TEXT_WEIGHT;
  }
}

interface Mixed {
  item: SeItem;
  section: SectionId;
  weight: number;
}

/**
 * All 页签按权重混排。节内保持来源顺序（后端已按档排好），所以权重被夹成
 * 非递增；平分秋色时分节顺序说了算。
 */
export function mixItems(sections: ReadonlyMap<SectionId, SectionState>, query: string): Mixed[] {
  const out: Array<Mixed & { rank: number }> = [];
  MIXED.forEach((id, rank) => {
    let cap = Infinity;
    for (const item of sections.get(id)?.items ?? []) {
      cap = Math.min(cap, itemWeight(item, query));
      out.push({ item, section: id, weight: cap, rank });
    }
  });
  return out
    .map((m, i) => ({ m, i }))
    .sort((a, b) => b.m.weight - a.m.weight || a.m.rank - b.m.rank || a.i - b.i)
    .map(({ m }) => m);
}

/**
 * 弹窗渲染的平表。All 页签带查询时按相关度混排、「更多」行殿后；
 * 其余页签分节各归各位。
 */
export function buildRows(
  sections: ReadonlyMap<SectionId, SectionState>,
  opts: { headers: boolean; mix?: string; titles?: Partial<Record<SectionId, string>> }
): SeRow[] {
  const rows: SeRow[] = [];
  if (opts.mix?.trim()) {
    for (const m of mixItems(sections, opts.mix.trim())) rows.push({ ...m.item, section: m.section });
    for (const id of MIXED) if (sections.get(id)?.hasMore) rows.push({ kind: "more", key: `+${id}`, section: id });
    return rows;
  }
  for (const id of SECTION_ORDER) {
    const s = sections.get(id);
    if (!s || !s.items.length) continue;
    if (opts.headers) rows.push({ kind: "section", key: `#${id}`, section: id, title: opts.titles?.[id] ?? id });
    for (const item of s.items) rows.push({ ...item, section: id });
    if (s.hasMore) rows.push({ kind: "more", key: `+${id}`, section: id });
  }
  return rows;
}

export const isSectionRow = (r: SeRow) => r.kind === "section";

// ---------------------------------------------------------------------------
// 「/」命令

export const COMMANDS: ReadonlyArray<{ name: string; tab: SeTab }> = TABS.filter(
  (t) => t.id !== "all"
).map((t) => ({ name: `/${t.id}`, tab: t.id }));

export type ParsedCommand = { kind: "list"; rows: SeRow[] } | { kind: "run"; tab: SeTab; rest: string };

/**
 * `/` 或 `/fi` 列出能跳的分节命令；`/files foo` 跳到 Files 并搜 `foo`。
 * 别的都当查询本身（比如绝对路径）。label 由前端按页签翻译填。
 */
export function parseCommand(query: string, label: (tab: SeTab) => string): ParsedCommand | null {
  const m = /^\/(\S*)(?:\s+([\s\S]*))?$/.exec(query);
  if (!m) return null;
  const word = m[1]!.toLowerCase();
  if (m[2] !== undefined) {
    const cmd = COMMANDS.find((c) => c.name === `/${word}`);
    return cmd ? { kind: "run", tab: cmd.tab, rest: m[2] } : null;
  }
  const rows: SeRow[] = COMMANDS.filter((c) => c.name.startsWith(`/${word}`)).map((c) => ({
    kind: "command",
    key: `cmd:${c.tab}`,
    name: c.name,
    tab: c.tab,
    label: label(c.tab),
  }));
  return rows.length ? { kind: "list", rows } : null;
}

/**
 * 顶端结果定了没有：第一条有结果的分节之前的所有分节都已收口。
 * 没定就按 Enter 会被欠着（IDEA 开的是新查询的第一条，不是旧查询的残留行）。
 */
export function topResultSettled(sections: ReadonlyMap<SectionId, SectionState>, mix?: string): boolean {
  if (mix?.trim()) {
    const top = mixItems(sections, mix.trim())[0]?.weight ?? -Infinity;
    return MIXED.every((id) => !sections.get(id)?.loading || (id === "text" && top > TEXT_WEIGHT));
  }
  for (const id of SECTION_ORDER) {
    const s = sections.get(id);
    if (!s) continue;
    if (s.loading) return false;
    if (s.items.length) return true;
  }
  return true;
}

/**
 * 结果流式进来时把选中位钉在同一条目上：`key` 还在就跟着它；
 * 用户已经走动过就夹回最近的可选行；否则落第一条可选行。
 */
export function stableIndex(rows: readonly SeRow[], key: string | null, prevIndex: number, userMoved: boolean): number {
  if (key) {
    const i = rows.findIndex((r) => r.key === key);
    if (i >= 0) return i;
  }
  if (userMoved && prevIndex >= 0 && rows.length) {
    for (let i = Math.min(prevIndex, rows.length - 1); i >= 0; i--) if (!isSectionRow(rows[i]!)) return i;
  }
  return rows.findIndex((r) => !isSectionRow(r));
}
