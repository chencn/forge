/**
 * Edit › Sort Lines / Reverse Lines：选中的各行；没有选区时整篇。
 */
import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";

/** 排序比较器：数字不按数值、区分大小写变体。 */
const collator = new Intl.Collator(undefined, { numeric: false, sensitivity: "variant" });

/** 命令作用的行块：每个非空选区一个；没有选区时整篇。 */
function blocks(state: EditorState): Array<{ from: number; to: number }> {
  const ranges = state.selection.ranges.filter((r) => !r.empty);
  if (!ranges.length) {
    // 末尾换行后的空行保持在最后一行。
    const doc = state.doc;
    const last = doc.line(doc.lines);
    return [{ from: 0, to: !last.length && doc.lines > 1 ? doc.line(doc.lines - 1).to : doc.length }];
  }
  const out: Array<{ from: number; to: number }> = [];
  for (const r of ranges) {
    const first = state.doc.lineAt(r.from);
    // 选区正好止于某行行首时不包含那一行。
    const last = state.doc.lineAt(r.to > r.from && state.doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to);
    const prev = out[out.length - 1];
    if (prev && first.from <= prev.to) prev.to = Math.max(prev.to, last.to);
    else out.push({ from: first.from, to: last.to });
  }
  return out;
}

/** 对每个行块施加 transform 生成事务；没有可改的行块返回 null。 */
function rewrite(
  state: EditorState,
  transform: (lines: string[]) => string[],
  userEvent: string,
): TransactionSpec | null {
  const changes: ChangeSpec[] = [];
  for (const b of blocks(state)) {
    const text = state.sliceDoc(b.from, b.to);
    const lines = text.split(state.lineBreak);
    if (lines.length < 2) continue;
    const next = transform(lines).join(state.lineBreak);
    if (next !== text) changes.push({ from: b.from, to: b.to, insert: next });
  }
  if (!changes.length) return null;
  const set = state.changes(changes);
  const hadSelection = state.selection.ranges.some((r) => !r.empty);
  return {
    changes: set,
    selection: hadSelection
      ? EditorSelection.create(
          state.selection.ranges.map((r) => EditorSelection.range(set.mapPos(r.anchor, -1), set.mapPos(r.head, 1))),
          state.selection.mainIndex,
        )
      : undefined,
    scrollIntoView: true,
    userEvent,
  };
}

/** 排序行的事务规格（纯计算，供测试与命令共用）。 */
export function sortLinesSpec(state: EditorState): TransactionSpec | null {
  return rewrite(state, (lines) => [...lines].sort((a, b) => collator.compare(a, b)), "input.sort");
}

/** 倒转行的事务规格。 */
export function reverseLinesSpec(state: EditorState): TransactionSpec | null {
  return rewrite(state, (lines) => [...lines].reverse(), "input.reverse");
}

/** 命令需要的最小视图接口（EditorView 的结构子集）。 */
type Dispatch = { state: EditorState; dispatch: (tr: Transaction | TransactionSpec) => void };

/** Edit › Sort Lines 命令。 */
export function sortLines(view: Dispatch): boolean {
  if (view.state.readOnly) return false;
  const spec = sortLinesSpec(view.state);
  if (spec) view.dispatch(spec);
  return !!spec;
}

/** Edit › Reverse Lines 命令。 */
export function reverseLines(view: Dispatch): boolean {
  if (view.state.readOnly) return false;
  const spec = reverseLinesSpec(view.state);
  if (spec) view.dispatch(spec);
  return !!spec;
}
