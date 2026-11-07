/** 复用实际编辑行为，键位由方案表提供。 */
import { StateEffect, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { foldEffect, foldable, foldedRanges, unfoldEffect } from "@codemirror/language";
const MAX_SCAN_LINES = 2000;

/**
 * IDEA "Collapse" (⌘-): the innermost not-yet-folded region that contains the
 * caret — the caret line's own region first, then enclosing ones above it.
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

/** Folds the region around each caret. */
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
 * IDEA "Expand" (⌘=): the visible fold at the caret — the outermost fold
 * containing it (inner ones are hidden inside it), else a fold on its line.
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
 * IDEA "Fold Selection / Remove Region" (⌘.): folds each selection (without
 * a trailing line break); with no selection, toggles the region at the caret.
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

export function foldSelection(view: EditorView): boolean {
  const effects = foldSelectionEffects(view.state);
  if (!effects.length) return false;
  const sel = view.state.selection;
  const folded = effects.filter((e) => e.is(foldEffect)).map((e) => e.value as { from: number; to: number });
  // The caret lands after the new fold, like IDEA.
  const after =
    sel.ranges.some((r) => !r.empty) && folded.length ? { anchor: folded[folded.length - 1]!.to } : undefined;
  view.dispatch({ effects, selection: after });
  return true;
}

function isFolded(state: EditorState, r: { from: number; to: number }): boolean {
  let hit = false;
  foldedRanges(state).between(r.from, r.from, (a, b) => {
    if (a === r.from && b === r.to) hit = true;
  });
  return hit;
}

/** Every foldable region (nested ones included) of the lines in `[from, to]`, kept within `[from, to]`. */
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

/** The selection, when it holds whole regions to work on; else the whole document. */
function regionScope(state: EditorState): { from: number; to: number } | null {
  const main = state.selection.main;
  return main.empty ? null : { from: main.from, to: main.to };
}

/**
 * IDEA "Collapse All" (⌘⇧-): every region, nested ones included; with a
 * selection, the regions inside it (all of them when it holds none).
 */
export function collapseAllEffects(state: EditorState): StateEffect<unknown>[] {
  const scope = regionScope(state);
  let regions = scope ? foldableRegions(state, scope.from, scope.to) : [];
  if (!regions.length) regions = foldableRegions(state);
  return regions.filter((r) => !isFolded(state, r)).map((r) => foldEffect.of(r));
}

/** IDEA "Expand All" (⌘⇧=): every folded region, or those inside the selection. */
export function expandAllEffects(state: EditorState): StateEffect<unknown>[] {
  const all: Array<{ from: number; to: number }> = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => void all.push({ from, to }));
  const scope = regionScope(state);
  const inside = scope ? all.filter((r) => r.from >= scope.from && r.to <= scope.to) : [];
  return (inside.length ? inside : all).map((r) => unfoldEffect.of(r));
}

/**
 * IDEA "Collapse Recursively" (⌘⌥-): the region at the caret line (else the
 * innermost one around the caret) and every region inside it.
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

/** IDEA "Expand Recursively" (⌘⌥=): the region at the caret and every folded region inside it. */
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

function dispatchEffects(view: EditorView, effects: StateEffect<unknown>[]): boolean {
  if (effects.length) view.dispatch({ effects });
  return effects.length > 0;
}

export const collapseAll = (view: EditorView) => dispatchEffects(view, collapseAllEffects(view.state));
export const expandAll = (view: EditorView) => dispatchEffects(view, expandAllEffects(view.state));
export const collapseRecursively = (view: EditorView) =>
  dispatchEffects(
    view,
    view.state.selection.ranges.flatMap((r) => collapseRecursivelyEffects(view.state, r.head)),
  );
export const expandRecursively = (view: EditorView) =>
  dispatchEffects(
    view,
    view.state.selection.ranges.flatMap((r) => expandRecursivelyEffects(view.state, r.head)),
  );

