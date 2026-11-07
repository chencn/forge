/**
 * 折叠动作（⌘- / ⌘= / 递归折叠等）的区间计算。
 */
import { StateEffect, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { foldEffect, foldable, foldedRanges, unfoldEffect } from "@codemirror/language";
/** 往上扫描包住区的行数上限（防超长文档卡死）。 */
const MAX_SCAN_LINES = 2000;

/**
 * 折叠（⌘-）：包住光标的最内层未折叠区——先看光标行自己的区，
 * 再往上看包住它的。
 */
export function enclosingFoldRange(state: EditorState, pos: number): { from: number; to: number } | null {
  const folded = foldedRanges(state);
  const isFolded = (r: { from: number; to: number }) => {
    let hit = false;
    folded.between(r.from, r.from, (a, b) => {
      if (a === r.from && b === r.to) hit = true;
    });
    return hit;
  };
  let line = state.doc.lineAt(pos);
  for (let i = 0; i < MAX_SCAN_LINES; i++) {
    const r = foldable(state, line.from, line.to);
    const onCaretLine = i === 0;
    if (r && (onCaretLine || (r.from <= pos && pos <= r.to)) && !isFolded(r)) return r;
    if (line.number === 1) break;
    line = state.doc.line(line.number - 1);
  }
  return null;
}

/** 在每个光标处折叠所在的区。 */
export function foldAtCaret(view: EditorView): boolean {
  const effects: StateEffect<unknown>[] = [];
  for (const range of view.state.selection.ranges) {
    const r = enclosingFoldRange(view.state, range.head);
    if (r) effects.push(foldEffect.of(r));
  }
  if (effects.length) view.dispatch({ effects });
  return effects.length > 0;
}

/**
 * 展开（⌘=）：光标处可见的折叠——包住它的最外层折叠（内层的藏在它里面），
 * 没有就找光标行上的折叠。
 */
export function foldToExpand(state: EditorState, head: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(head);
  let containing: { from: number; to: number } | null = null;
  let onLine: { from: number; to: number } | null = null;
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    if (from <= head && head <= to) {
      if (!containing || to - from > containing.to - containing.from) containing = { from, to };
    } else if (from >= line.from && from <= line.to) {
      if (!onLine || to - from > onLine.to - onLine.from) onLine = { from, to };
    }
  });
  return containing ?? onLine;
}

/** 展开（⌘=）命令：每个光标处展开一处折叠。 */
export function unfoldAtCaret(view: EditorView): boolean {
  const effects: StateEffect<unknown>[] = [];
  for (const range of view.state.selection.ranges) {
    const r = foldToExpand(view.state, range.head);
    if (r) effects.push(unfoldEffect.of(r));
  }
  if (effects.length) view.dispatch({ effects });
  return effects.length > 0;
}

/**
 * 折叠选区 / 移除折叠区（⌘.）：折起每个选区（去掉结尾换行）；
 * 没有选区时切换光标处的折叠区。
 */
export function foldSelectionEffects(state: EditorState): StateEffect<unknown>[] {
  const effects: StateEffect<unknown>[] = [];
  for (const range of state.selection.ranges) {
    if (!range.empty) {
      const to = state.sliceDoc(range.to - 1, range.to) === "\n" ? range.to - 1 : range.to;
      if (to > range.from) effects.push(foldEffect.of({ from: range.from, to }));
      continue;
    }
    const folded = foldToExpand(state, range.head);
    if (folded) effects.push(unfoldEffect.of(folded));
    else {
      const r = enclosingFoldRange(state, range.head);
      if (r) effects.push(foldEffect.of(r));
    }
  }
  return effects;
}

/** 折叠选区 / 移除折叠区（⌘.）命令。 */
export function foldSelection(view: EditorView): boolean {
  const effects = foldSelectionEffects(view.state);
  if (!effects.length) return false;
  const sel = view.state.selection;
  const folded = effects.filter((e) => e.is(foldEffect)).map((e) => e.value as { from: number; to: number });
  // 折叠后光标落在新区之后。
  const after =
    sel.ranges.some((r) => !r.empty) && folded.length ? { anchor: folded[folded.length - 1]!.to } : undefined;
  view.dispatch({ effects, selection: after });
  return true;
}

/** 区间当前是否处于折叠状态。 */
function isFolded(state: EditorState, r: { from: number; to: number }): boolean {
  let hit = false;
  foldedRanges(state).between(r.from, r.from, (a, b) => {
    if (a === r.from && b === r.to) hit = true;
  });
  return hit;
}

/** `[from, to]` 各行的全部可折叠区（嵌套的也算），且都要落在 `[from, to]` 内。 */
export function foldableRegions(
  state: EditorState,
  from = 0,
  to = state.doc.length,
): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (let pos = state.doc.lineAt(from).from; pos <= to;) {
    const line = state.doc.lineAt(pos);
    const r = foldable(state, line.from, line.to);
    if (r && r.from >= from && r.to <= to) out.push(r);
    if (line.to >= state.doc.length) break;
    pos = line.to + 1;
  }
  return out;
}

/** 选区恰是可整片处理的区间时用选区；否则用整篇文档。 */
function regionScope(state: EditorState): { from: number; to: number } | null {
  const main = state.selection.main;
  return main.empty ? null : { from: main.from, to: main.to };
}

/**
 * 全部折叠（⌘⇧-）：每个区、嵌套的也算；有选区时只折里面的
 * （一个都没有时折整篇）。
 */
export function collapseAllEffects(state: EditorState): StateEffect<unknown>[] {
  const scope = regionScope(state);
  let regions = scope ? foldableRegions(state, scope.from, scope.to) : [];
  if (!regions.length) regions = foldableRegions(state);
  return regions.filter((r) => !isFolded(state, r)).map((r) => foldEffect.of(r));
}

/** 全部展开（⌘⇧=）：每个已折叠区；有选区时只展开里面的。 */
export function expandAllEffects(state: EditorState): StateEffect<unknown>[] {
  const all: Array<{ from: number; to: number }> = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => void all.push({ from, to }));
  const scope = regionScope(state);
  const inside = scope ? all.filter((r) => r.from >= scope.from && r.to <= scope.to) : [];
  return (inside.length ? inside : all).map((r) => unfoldEffect.of(r));
}

/**
 * 递归折叠（⌘⌥-）：光标行上的区（没有就取包住光标的最内层区）
 * 连同它里面的每个区。
 */
export function collapseRecursivelyEffects(state: EditorState, head: number): StateEffect<unknown>[] {
  const line = state.doc.lineAt(head);
  const own = foldable(state, line.from, line.to);
  const root = own && !isFolded(state, own) ? own : enclosingFoldRange(state, head);
  if (!root) return [];
  const inner = foldableRegions(state, root.from, root.to).filter((r) => !isFolded(state, r));
  if (!isFolded(state, root) && !inner.some((r) => r.from === root.from && r.to === root.to)) inner.push(root);
  return inner.map((r) => foldEffect.of(r));
}

/** 递归展开（⌘⌥=）：光标处的折叠连同它里面的每个折叠。 */
export function expandRecursivelyEffects(state: EditorState, head: number): StateEffect<unknown>[] {
  const line = state.doc.lineAt(head);
  const root = foldToExpand(state, head) ?? foldable(state, line.from, line.to);
  if (!root) return [];
  const out: StateEffect<unknown>[] = [];
  foldedRanges(state).between(root.from, root.to, (from, to) => {
    if (from >= root.from && to <= root.to) out.push(unfoldEffect.of({ from, to }));
  });
  return out;
}

/** 有 effects 才 dispatch；返回是否有动作发生。 */
function dispatchEffects(view: EditorView, effects: StateEffect<unknown>[]): boolean {
  if (effects.length) view.dispatch({ effects });
  return effects.length > 0;
}

/** 全部折叠（⌘⇧-）命令。 */
export const collapseAll = (view: EditorView) => dispatchEffects(view, collapseAllEffects(view.state));
/** 全部展开（⌘⇧=）命令。 */
export const expandAll = (view: EditorView) => dispatchEffects(view, expandAllEffects(view.state));
/** 递归折叠（⌘⌥-）命令：每个光标各折叠一次。 */
export const collapseRecursively = (view: EditorView) =>
  dispatchEffects(
    view,
    view.state.selection.ranges.flatMap((r) => collapseRecursivelyEffects(view.state, r.head)),
  );
/** 递归展开（⌘⌥=）命令：每个光标各展开一次。 */
export const expandRecursively = (view: EditorView) =>
  dispatchEffects(
    view,
    view.state.selection.ranges.flatMap((r) => expandRecursivelyEffects(view.state, r.head)),
  );

