/** 移植自 openidea（Apache-2.0）：复用实际编辑行为，键位由方案表提供。 */
/**
 * Overwrite mode (Insert key, as in IDEA): typed characters replace the ones
 * after the caret (never the line break) and the caret is drawn as a block.
 */
import { EditorSelection, Prec, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export const setOverwrite = StateEffect.define<boolean>();

export function isOverwrite(state: EditorState): boolean {
  return state.field(overwriteField, false) ?? false;
}

export function toggleOverwrite(view: EditorView): boolean {
  view.dispatch({ effects: setOverwrite.of(!isOverwrite(view.state)) });
  return true;
}

const overwriteInput = EditorView.inputHandler.of((view, _from, _to, text) => {
  const { state } = view;
  if (!isOverwrite(state) || state.readOnly || /[\r\n]/.test(text)) return false;
  const tr = state.changeByRange((r) => {
    let to = r.to;
    if (r.empty) {
      const line = state.doc.lineAt(r.head);
      // 替换完整码点，不能把 emoji 的 UTF-16 代理对劈成半个字符。
      const remaining = state.sliceDoc(r.head, line.to);
      to = r.head + [...remaining].slice(0, [...text].length).join('').length;
    }
    return { changes: { from: r.from, to, insert: text }, range: EditorSelection.cursor(r.from + text.length) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.type" }));
  return true;
});

export const overwriteField = StateField.define<boolean>({
  create: () => false,
  update: (on, tr) => tr.effects.reduce((acc, e) => (e.is(setOverwrite) ? e.value : acc), on),
  provide: (f) => [
    Prec.highest(overwriteInput),
    // 块光标随模式一起装配，避免切换 Insert 后只有内部状态变化。
    EditorView.theme({ '.cm-forge-blockCaret .cm-cursor': { borderLeftWidth: '.6em', opacity: '.5' } }),
    EditorView.editorAttributes.compute([f], (s): Record<string, string> =>
      s.field(f) ? { class: "cm-forge-blockCaret" } : {},
    ),
  ],
});
