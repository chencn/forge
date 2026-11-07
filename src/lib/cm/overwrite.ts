/**
 * 改写模式（Insert 键切换）：输入的字符替换光标之后的字符（换行除外），
 * 光标画成方块。
 */
import { EditorSelection, Prec, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** 切换改写模式的 effect（true 为开）。 */
export const setOverwrite = StateEffect.define<boolean>();

/** 当前编辑器是否处于改写模式（未装配字段时为 false）。 */
export function isOverwrite(state: EditorState): boolean {
  return state.field(overwriteField, false) ?? false;
}

/** 切换改写模式。 */
export function toggleOverwrite(view: EditorView): boolean {
  view.dispatch({ effects: setOverwrite.of(!isOverwrite(view.state)) });
  return true;
}

/** 改写模式的输入拦截：输入的字符替换光标之后的字符（含换行的文本不拦）。 */
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

/** 改写模式字段：状态本体 + 装配输入拦截与块光标样式。 */
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
