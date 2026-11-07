/**
 * Code › Code Completion › Cyclic Expand Word（⌥/）及其反向版（⌥⇧/），即
 * 「hippie 补全」：用当前文件里的词补光标处的词前缀（就近优先，⌥/ 先向上找，
 * ⌥⇧/ 先向下找），找不到再从其他打开的编辑器里找。连按在候选间循环，
 * 最后回到敲进去的前缀。
 */
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** 单个「词字符」的判定（含代理对检查）。 */
const WORD_CHAR = /[\p{L}\p{N}_$]/u;
/** 连续词串（全文扫候选用）。 */
const WORD = /[\p{L}\p{N}_$]+/gu;

/** 以 `caret` 结尾的词前缀的起点。 */
export function prefixStart(text: string, caret: number): number {
  let i = caret;
  while (i > 0) {
    const ch = text[i - 1]!;
    // 低位代理项属于它前面的那个字符。
    const cp = ch >= "\udc00" && ch <= "\udfff" && i > 1 ? text.slice(i - 2, i) : ch;
    if (!WORD_CHAR.test(cp)) break;
    i -= cp.length;
  }
  return i;
}

/**
 * Candidates for the prefix `text[from, caret)`: words starting with it (and
 * longer), nearest first in `direction`, then the other way, then `others`.
 * The word being completed itself is skipped.
 */
export function expandCandidates(
  text: string,
  from: number,
  caret: number,
  direction: "backward" | "forward",
  others: readonly string[] = [],
): string[] {
  const prefix = text.slice(from, caret);
  if (!prefix) return [];
  const before: string[] = [];
  const after: string[] = [];
  for (const m of text.matchAll(WORD)) {
    const start = m.index;
    if (start <= from && start + m[0].length >= caret) continue;
    const w = m[0];
    if (w.length <= prefix.length || !w.startsWith(prefix)) continue;
    (start < from ? before : after).push(w);
  }
  before.reverse();
  const ordered = direction === "backward" ? [...before, ...after] : [...after, ...before];
  for (const other of others)
    for (const m of other.matchAll(WORD))
      if (m[0].length > prefix.length && m[0].startsWith(prefix)) ordered.push(m[0]);
  return [...new Set(ordered)];
}

/** 一轮补全会话的状态（文档一变就作废，见字段注释）。 */
interface Session {
  from: number;
  prefix: string;
  candidates: string[];
  /** 候选列表的下标；`candidates.length` 表示又回到裸前缀。 */
  index: number;
  /** 上次展开后的文档快照；其他任何编辑都会终止本轮补全会话。 */
  doc: EditorView["state"]["doc"];
  end: number;
}

/** 各编辑器自己的补全会话（视图销毁随之回收）。 */
const sessions = new WeakMap<EditorView, Session>();

/** 展开（或循环）光标处的词；没得可做时返回提示原因。 */
export function cyclicExpandWord(
  view: EditorView,
  direction: "backward" | "forward",
  others: () => string[],
): string | null {
  const state = view.state;
  if (state.readOnly) return null;
  const head = state.selection.main.head;
  let s = sessions.get(view);
  if (!s || s.doc !== state.doc || s.end !== head || !state.selection.main.empty) {
    const text = state.doc.toString();
    const from = prefixStart(text, head);
    const candidates = expandCandidates(text, from, head, direction, others());
    if (!candidates.length) {
      sessions.delete(view);
      return from === head ? "No word to expand at the caret" : "No suitable completions found";
    }
    s = { from, prefix: text.slice(from, head), candidates, index: -1, doc: state.doc, end: head };
  }
  s.index = (s.index + 1) % (s.candidates.length + 1);
  const insert = s.candidates[s.index] ?? s.prefix;
  view.dispatch({
    changes: { from: s.from, to: s.end, insert },
    selection: EditorSelection.cursor(s.from + insert.length),
    scrollIntoView: true,
    userEvent: "input.complete",
  });
  s.doc = view.state.doc;
  s.end = s.from + insert.length;
  sessions.set(view, s);
  return null;
}
