import { invoke } from "@tauri-apps/api/core";
import type { AiProvider } from "./aiCli";

/**
 * 会话正文搜索的前端侧。
 *
 * 后端（`ai_runtime/search.rs`）没有倒排索引，而是直接扫每个会话的 JSONL 原文，
 * 所以一次查询可能读上百兆。这件事只有两个约束：
 * 一是扫描量有上限，结果可能不完整；二是慢响应回来时用户往往已经改了关键词。
 * 这个模块负责把这两件事如实说出来——`truncated`/`skipped` 一路带到界面，
 * 过期响应则由 `createAiSearchTracker` 拦掉，绝不拿旧结果冒充新答案。
 */

/** 后端一次最多返回这么多条命中。 */
export const AI_SEARCH_MAX_HITS = 200;
/** 少于这个字符不发查询。 */
export const AI_SEARCH_MIN_QUERY = 2;
/** 输入停顿多久才真的扫盘：逐字符触发会把磁盘打满。 */
export const AI_SEARCH_DEBOUNCE_MS = 350;

/** 一条命中片段。`start`/`length` 按 UTF-16 码元计，正好是 `text.slice` 的口径。 */
export interface AiSearchHit {
  sessionId: string;
  sessionTitle: string;
  provider: AiProvider;
  createdAt: number;
  /** 命中起点那条事件的序号；同一会话里的定位锚点。 */
  seq: number;
  kind: string;
  text: string;
  start: number;
  length: number;
  /** 片段前面还有没显示出来的内容。 */
  leading: boolean;
  trailing: boolean;
}

/** 一次扫描的完整结果。计数都来自后端，前端一个都不猜。 */
export interface AiSearchResult {
  hits: AiSearchHit[];
  /** 真正读过的本项目会话数。 */
  scanned: number;
  /** 归属读不出或记录已损坏、因此完全没被查过的目录数。 */
  skipped: number;
  bytes: number;
  /** 撞上扫描上限提前收手：结果不全，界面必须说明。 */
  truncated: boolean;
}

const EMPTY_RESULT: AiSearchResult = { hits: [], scanned: 0, skipped: 0, bytes: 0, truncated: false };

/** 查询词只做首尾清理：后端按子串匹配，中间的空格是用户要打的内容的一部分。 */
export function normalizeSearchQuery(raw: string) {
  return raw.trim().slice(0, 200);
}

/** 这个查询词值不值得扫盘。 */
export function isSearchQueryActive(query: string) {
  return normalizeSearchQuery(query).length >= AI_SEARCH_MIN_QUERY;
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * 后端的一条命中按不可信输入处理：字段缺就补成能显示的，类型不对就整条丢掉。
 * 丢一条好过把 `undefined` 画进列表，或让整次搜索假装失败。
 */
function toSearchHit(value: unknown): AiSearchHit | null {
  if (!value || typeof value !== "object") return null;
  const hit = value as Record<string, unknown>;
  if (typeof hit.sessionId !== "string" || !hit.sessionId) return null;
  if (typeof hit.text !== "string" || !hit.text) return null;
  if (hit.provider !== "claude" && hit.provider !== "codex") return null;
  const start = count(hit.start);
  const length = count(hit.length);
  return {
    sessionId: hit.sessionId,
    sessionTitle: typeof hit.sessionTitle === "string" ? hit.sessionTitle : "",
    provider: hit.provider,
    createdAt: count(hit.createdAt),
    seq: count(hit.seq),
    kind: typeof hit.kind === "string" ? hit.kind : "text",
    text: hit.text,
    // 偏移越界只会来自坏数据；夹到文本范围内，宁可少高亮也不切出半句话。
    start: Math.min(start, hit.text.length),
    length: Math.min(length, hit.text.length - Math.min(start, hit.text.length)),
    leading: hit.leading === true,
    trailing: hit.trailing === true,
  };
}

export function parseSearchResult(raw: unknown): AiSearchResult {
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const items = Array.isArray(data.hits) ? data.hits : [];
  const hits: AiSearchHit[] = [];
  for (const item of items) {
    const hit = toSearchHit(item);
    if (hit) hits.push(hit);
  }
  return {
    hits,
    scanned: count(data.scanned),
    skipped: count(data.skipped),
    bytes: count(data.bytes),
    truncated: data.truncated === true,
  };
}

/** 一条命中拆成三段，界面上只有 `match` 需要高亮。 */
export interface AiSearchSnippet {
  before: string;
  match: string;
  after: string;
  leading: boolean;
  trailing: boolean;
}

export function splitAiSearchSnippet(hit: AiSearchHit): AiSearchSnippet {
  const start = Math.min(hit.start, hit.text.length);
  const end = Math.min(start + hit.length, hit.text.length);
  return {
    before: hit.text.slice(0, start),
    match: hit.text.slice(start, end),
    after: hit.text.slice(end),
    leading: hit.leading,
    trailing: hit.trailing,
  };
}

/** 同一会话的多条命中归到同一个标题下面：搜出来的首先是「哪段对话」，其次才是哪一句。 */
export interface AiSearchGroup {
  sessionId: string;
  sessionTitle: string;
  provider: AiProvider;
  createdAt: number;
  hits: AiSearchHit[];
}

export function groupAiSearchHits(hits: AiSearchHit[]): AiSearchGroup[] {
  const groups: AiSearchGroup[] = [];
  const index = new Map<string, AiSearchGroup>();
  for (const hit of hits) {
    // 后端已按时间倒序，这里只保持它给的顺序，不再自己排，免得两处口径不一致。
    const existing = index.get(hit.sessionId);
    if (existing) { existing.hits.push(hit); continue; }
    const group: AiSearchGroup = {
      sessionId: hit.sessionId,
      sessionTitle: hit.sessionTitle,
      provider: hit.provider,
      createdAt: hit.createdAt,
      hits: [hit],
    };
    index.set(hit.sessionId, group);
    groups.push(group);
  }
  return groups;
}

/**
 * 只认最新一次查询的守门人。
 *
 * 扫盘可能耗时几秒，期间用户还在打字。晚到的旧结果如果照单收下，列表会闪回上一条
 * 关键词的命中，甚至把旧错误信息显示在新查询的输入框下面。所以每次 `begin` 发一个
 * 令牌，只有仍是最新的令牌才允许落状态——错误也一样，过期查询的失败不值得报警。
 */
export interface AiSearchTracker {
  /** 记下这次发起时的查询词，返回令牌。 */
  begin(query: string): number;
  /**
   * 请求落地时调用：令牌还是最新的吗？
   * 是就同时清空 `pending`（这一次确实有了结论），否则什么都不动。
   */
  settle(token: number): boolean;
  /** 最新一次已发起、还没落地的查询；没有请求在飞时为 null。 */
  pending(): string | null;
}

export function createAiSearchTracker(): AiSearchTracker {
  let seq = 0;
  let latest = 0;
  let query: string | null = null;
  return {
    begin(next) {
      seq += 1;
      latest = seq;
      query = next;
      return latest;
    },
    settle(token) {
      if (token !== latest) return false;
      query = null;
      return true;
    },
    pending: () => query,
  };
}

/** 发起一次搜索。非桌面端没有会话日志可扫，直接给空结果。 */
export async function searchAiSessions(workspace: string, query: string, includeArchived: boolean): Promise<AiSearchResult> {
  const needle = normalizeSearchQuery(query);
  if (!needle) return EMPTY_RESULT;
  const raw = await invoke<unknown>("ai_runtime_search", { workspace, query: needle, limit: AI_SEARCH_MAX_HITS, includeArchived });
  return parseSearchResult(raw);
}
