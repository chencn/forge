/**
 * 缩进参考线：每缩进一级在行的缩进区画一条竖线。
 * 实现用一条行装饰配一段重复渐变背景，
 * 每个可见行只多一个装饰、不多 DOM，所以几千行也不卡。
 *
 * 这一版 `@codemirror/language`（6.13.1）没有 `indentGuides` 导出，只能自己带一份。
 * 空白行自己没缩进，取上下两侧较浅的那一档，线才不会在空行处断开。
 */
import { RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { getIndentUnit } from "@codemirror/language";

/** 层数与步长决定装饰的形状，两者都编进缓存键：同一档就复用同一个 Decoration。 */
const cache = new Map<string, Decoration>();
/** 缓存里取（或造）一条参考线行装饰（层数与步长编进键）。 */
function guideDecoration(levels: number, step: number): Decoration {
  const key = `${levels}:${step}`;
  let decoration = cache.get(key);
  if (!decoration) {
    decoration = Decoration.line({
      attributes: {
        class: "cm-indent-guide",
        style: `--forge-guide-levels: ${levels}; --forge-guide-step: ${step}`,
      },
    });
    cache.set(key, decoration);
  }
  return decoration;
}

/** 这一行缩进到第几列；整行空白返回 null（交给上下行去定档）。 */
function indentColumns(text: string, tabSize: number): number | null {
  let column = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 32) column++;
    else if (code === 9) column += tabSize - (column % tabSize);
    else return column;
  }
  return null;
}

/** 空白行上下各找这么多行；再远的邻行跟这一眼看到的段落无关，别把滚动条拖慢。 */
const LOOK_AROUND = 200;

/** 空白行借档：从 `lineNo` 起（1 为向下）在 {@link LOOK_AROUND} 行内找最近一个非空行的缩进档。 */
function levelNear(state: EditorState, lineNo: number, step: number, direction: 1 | -1): number {
  const doc = state.doc;
  for (let n = lineNo, i = 0; n >= 1 && n <= doc.lines && i < LOOK_AROUND; n += direction, i++) {
    const columns = indentColumns(doc.line(n).text, state.tabSize);
    if (columns !== null) return Math.floor(columns / step);
  }
  return 0;
}

/** 给可见行逐行铺参考线装饰（空白行取上下两侧较浅的一档）。 */
function build(view: EditorView): DecorationSet {
  const state = view.state;
  const step = Math.max(1, getIndentUnit(state));
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      // 一行的缩进列算不动就不画：超过一万列多半是压缩产物或 base64，逐列数过去不值。
      if (line.length < 10_000) {
        const columns = indentColumns(line.text, state.tabSize);
        const levels =
          columns === null
            ? Math.min(levelNear(state, line.number - 1, step, -1), levelNear(state, line.number + 1, step, 1))
            : Math.floor(columns / step);
        if (levels > 0) builder.add(line.from, line.from, guideDecoration(levels, step));
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/** 缩进参考线扩展：文档/视口/tabSize 变化时重铺。 */
export const indentGuides: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.startState.tabSize !== update.state.tabSize) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (value) => value.decorations }
);
