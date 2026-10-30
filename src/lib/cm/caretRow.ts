/**
 * 当前行高亮（1:1 抄 openidea cm/caretRow.ts）：`highlightActiveLine` 的替代品，
 * 只标记**空光标**所在行——有选区时整行不透明底色会盖住选区色（IDEA 同款行为）。
 */
import type { Extension, Range } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";

const caretRow = Decoration.line({ class: "cm-activeLine" });

function rows(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  let last = -1;
  for (const r of view.state.selection.ranges) {
    // 有选区就不画：整行底色会把选区盖掉。
    if (!r.empty) continue;
    const from = view.lineBlockAt(r.head).from;
    if (from > last) out.push(caretRow.range(from));
    last = from;
  }
  return Decoration.set(out, true);
}

/** 只给空光标所在行画当前行底色的 highlightActiveLine 替代。 */
export const caretRowHighlight: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = rows(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet) this.decorations = rows(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
