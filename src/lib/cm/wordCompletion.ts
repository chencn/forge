/** 复用实际编辑行为，键位由方案表提供。 */
/**
 * Code › Code Completion › Cyclic Expand Word (⌥/) and its backward twin
 * (⌥⇧/), IDEA's "hippie" completion: completes the word prefix at the caret
 * from words in the current file (nearest first, ⌥/ searching upwards first,
 * ⌥⇧/ downwards), then from other open editors. Repeated presses cycle
 * through the candidates and back to the typed prefix.
 */
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

const WORD_CHAR = /[\p{L}\p{N}_$]/u;
const WORD = /[\p{L}\p{N}_$]+/gu;

/** Start of the word prefix ending at `caret`. */
export function prefixStart(text: string, caret: number): number {
  let i = caret;
  while (i > 0) {
    const ch = text[i - 1]!;
    // Low surrogates belong to the character before them.
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

interface Session {
  from: number;
  prefix: string;
  candidates: string[];
  /** Index into candidates; `candidates.length` shows the bare prefix again. */
  index: number;
  /** Document after our last expansion; any other edit ends the session. */
  doc: EditorView["state"]["doc"];
  end: number;
}

const sessions = new WeakMap<EditorView, Session>();

/** Expands (or cycles) the word at the caret. Returns a hint when there is nothing to do. */
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
