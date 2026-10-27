import type { AiEntry, AiOutlineSnapshot } from "./aiRuntime";

/** 摘要保留这么多字符；口径与后端 `outline.rs` 的 `summarize` 一致，两边数出来的才是一回事。 */
const LABEL_CHARS = 120;

/** 导航面板里的一行，对应一轮用户消息。 */
export interface AiNavRow {
  /** 正文里对应条目的 id，滚过去就靠它。 */
  id: string;
  /** 该轮 `user` 事件的序号；正文还没加载到那里时用它往前补。 */
  seq?: number;
  /** 第几轮，从 1 开始。 */
  ordinal: number;
  /** 首行摘要。 */
  label: string;
  /** 该轮用户的原始提示词全文（已加载正文时存在）；供悬浮卡片提取技能/路径及多行预览。 */
  text?: string;
  /** 该轮改过的文件数，按路径去重。 */
  files: number;
  /** 该轮改过的文件路径；只有已加载进正文的那几轮才有（索引只存数量）。 */
  paths?: string[];
  /** 正文里已经有这一条了吗；为假时点击要先往回补事件才能跳。 */
  loaded: boolean;
}

/** 一次多渲染这么多行；列表往上滚一档加一档，长会话不会一次挂出几千个按钮。 */
export const NAV_PAGE = 200;

/** 取第一行非空文字作摘要并按字符截断。 */
export function navLabel(text: string | undefined): string {
  const line = text?.split(/\r?\n/).map((item) => item.trim()).find((item) => item.length > 0) ?? "";
  return line.slice(0, LABEL_CHARS);
}

/** 拆解用户提示词中的技能胶囊、路径上下文与正文。 */
export interface ParsedNavPrompt {
  /** 技能或命令标识，例如 "[$code-review]" 或 "/review" */
  badge?: string;
  /** 伴随的路径上下文，例如 "(C:\Users\...)" */
  path?: string;
  /** 提示词正文文本（保留多行，去除技能标识与路径） */
  body: string;
}

/**
 * 解析用户提示词结构：提取技能胶囊（如 `[$code-review]`）、上下文路径以及主要提问内容。
 */
export function parseNavPrompt(text: string | undefined, fallbackLabel: string): ParsedNavPrompt {
  if (!text || !text.trim()) {
    return { body: fallbackLabel };
  }
  const trimmed = text.trim();
  // 匹配开头的技能标识 [$xxx] 或斜杠命令 /xxx
  const badgeMatch = trimmed.match(/^(\[\$[^\]]+\]|\/[\w-]+)/);
  if (!badgeMatch) {
    return { body: trimmed };
  }
  const badge = badgeMatch[1];
  let rest = trimmed.slice(badge.length).trim();
  let path: string | undefined;

  // 匹配紧随其后的括号路径，如 (C:\Users\... 或 (/path/to/...
  const pathMatch = rest.match(/^(\([^)]+\))/);
  if (pathMatch) {
    path = pathMatch[1];
    rest = rest.slice(path.length).trim();
  }

  return {
    badge,
    path,
    body: rest || fallbackLabel,
  };
}

/** 已加载正文里每一轮的摘要与改动文件；文件数按路径去重，口径同 `summarizeAiFileEdits`。 */
function groupLoadedEntries(entries: AiEntry[]) {
  const rows = new Map<string, { label: string; text?: string; files: Set<string>; seq?: number }>();
  let current: { label: string; text?: string; files: Set<string>; seq?: number } | null = null;
  for (const entry of entries) {
    if (entry.kind === "user") {
      current = { label: navLabel(entry.text), text: entry.text, files: new Set(), seq: entry.seq };
      rows.set(entry.id, current);
    } else if (entry.kind === "files" && current) {
      // 一轮的文件改动都排在它的 user 条目之后，所以正文只要加载到这一轮就必然加载到全部。
      for (const path of entry.paths ?? []) current.files.add(path);
    }
  }
  return rows;
}

/**
 * 把后端轮次索引和已加载的正文合成导航的行。
 *
 * 索引列的是整个会话，正文只覆盖最近那一页事件，所以两边按条目 id 对齐：索引里的行按序号
 * 一路数下来，正文已经有的标成 `loaded`（跳转直接滚过去，不用再往前补事件），摘要与文件数
 * 以正文为准——正在跑的那一轮，索引还是面板打开那一刻的旧快照。
 * 刚发出去、索引里还没有的那几轮照常算，但**按序号归位**而不是接在最后。
 */
export function buildNavRows(entries: AiEntry[], outline: AiOutlineSnapshot): AiNavRow[] {
  const loaded = groupLoadedEntries(entries);
  const known = new Set<string>();
  const gathered: Array<Omit<AiNavRow, "ordinal">> = [];
  const push = (row: Omit<AiNavRow, "ordinal">) => {
    // 索引一次最多列 2000 轮，长会话里正文还会带着比索引开头更早的轮次；把它们接到末尾的话，
    // 最老的一轮就排到了列表底部，还被「先露最近这么多行」当成最新那一档露出来。
    if (known.has(row.id)) return;
    known.add(row.id);
    gathered.push(row);
  };
  for (const turn of outline.turns) {
    const hit = loaded.get(turn.entryId);
    push({
      id: turn.entryId,
      seq: turn.seq,
      label: hit?.label || turn.label,
      text: hit?.text,
      files: hit ? hit.files.size : turn.files,
      paths: hit ? [...hit.files] : undefined,
      loaded: !!hit,
    });
  }
  for (const [id, row] of loaded) {
    push({
      id,
      seq: row.seq,
      label: row.label,
      text: row.text,
      files: row.files.size,
      paths: [...row.files],
      loaded: true,
    });
  }
  // 没有序号的是本机刚按下、还没落进日志的那几轮，它们本来就最新，排到最后正合适。
  gathered.sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));
  return gathered.map((row, index) => ({ ...row, ordinal: index + 1 }));
}

/**
 * 这次渲染哪几行。导航跟正文同一个方向：上面旧、下面新，而正文此刻就停在最新那一轮，
 * 所以先给最近这么多行，往上滚再往前长。
 */
export function visibleNavRows(rows: AiNavRow[], rendered: number): AiNavRow[] {
  return rows.slice(Math.max(0, rows.length - Math.max(NAV_PAGE, rendered)));
}

/**
 * 芯片上的条数。宁可报一个带 `+` 的约数，也不能报一个确定的数字却少掉几百轮：
 * 索引没取回时只看得见已加载的正文，正文之外还有更早的记录就还有得翻。
 */
export function navCount(rows: AiNavRow[], outline: AiOutlineSnapshot, hasOlder: boolean): string {
  if (outline.loaded) return `${rows.length}${outline.complete ? "" : "+"}`;
  return `${rows.length}${hasOlder ? "+" : ""}`;
}
