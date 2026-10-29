/**
 * 「相对上次提交改过哪几行」的标记，三个地方共用这一份：行号右边那条色带、
 * 右侧概览条、小地图色带。三个消费者放一个模块里，免得再出现同一条改动三处口径不一。
 */
import { RangeSet, RangeSetBuilder, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { gutter, GutterMarker, type EditorView } from "@codemirror/view";

/** 行号旁那一条改动标记；删除行的 `endLine` 只是落点。 */
export interface ChangeMark {
  startLine: number;
  endLine: number;
  kind: "added" | "modified" | "deleted";
  /** 删除标记挂缺口的下沿还是上沿（整篇新增走下沿）；"line" 是那行本身有内容，色条走普通档。 */
  edge?: "before" | "after" | "line";
}

const setChangeMarks = StateEffect.define<ChangeMark[]>();

/**
 * 行号右边那条色带里的一格。
 *
 * 色带单开一条槽（`cm-change-lane`），不挂在行号那一格上：IDEA 把色条夹在行号与代码
 * 之间，挂行号格只能用 `border-left` 画，条会跑到数字左边去。删掉的行没有留下行高，
 * 仍用三角挂在缺口上沿或下沿。
 */
class LaneMark extends GutterMarker {
  constructor(readonly kind: ChangeMark["kind"], readonly edge: ChangeMark["edge"]) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof LaneMark && other.kind === this.kind && other.edge === this.edge;
  }

  override toDOM(): Node {
    const el = document.createElement("div");
    if (this.kind === "deleted" && this.edge !== "line") {
      // 没有行高的那半（新增出来的空档）用三角；`edge: "line"` 是真的有整行被删，
      // 比对视图左栏就是这一档，照常画条，只是换成红。
      el.className = this.edge === "before" ? "change-lane-wedge is-before" : "change-lane-wedge";
    } else {
      el.className = "change-lane-bar";
      el.style.setProperty(
        "--lane-color",
        this.kind === "added" ? "var(--accent-green)" : this.kind === "deleted" ? "var(--accent-red)" : "var(--accent-blue)"
      );
    }
    return el;
  }
}

interface ChangeMarkState {
  /** 原样的改动列表：右侧概览条按它算位置。 */
  marks: readonly ChangeMark[];
  /** 行号右边那条槽要的逐行点标记。 */
  lane: RangeSet<GutterMarker>;
}

/**
 * 行号右边那条改动色带。
 *
 * 槽的标记只认「起点正好落在行首」的区间——CM 按行切槽，落在行中的区间不画
 * （`gutterLineClass` 的口径一样）。所以一段改动仍然一行一个点，删掉的行只有锚点那一行。
 */
export const changeMarksField = StateField.define<ChangeMarkState>({
  create: () => ({ marks: [], lane: RangeSet.empty }),
  update(state, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setChangeMarks)) continue;
      const builder = new RangeSetBuilder<GutterMarker>();
      const doc = transaction.state.doc;
      for (const mark of effect.value) {
        const start = Math.min(Math.max(1, mark.startLine), doc.lines);
        // 删除没有留下行：`endLine` 就是锚点那一行，区间只剩它一个点。
        const end = Math.min(Math.max(start, mark.endLine), doc.lines);
        const lane = new LaneMark(mark.kind, mark.edge);
        for (let line = start; line <= end; line += 1) {
          const at = doc.line(line).from;
          builder.add(at, at, lane);
        }
      }
      return { marks: effect.value, lane: builder.finish() };
    }
    return state;
  },
  provide: (field) => gutter({ class: "cm-change-lane", markers: (view) => view.state.field(field).lane }),
});

/** 这篇 state 上的改动标记；右侧概览条用。 */
export function changeMarksOf(state: EditorState): readonly ChangeMark[] {
  return state.field(changeMarksField).marks;
}

/** 把改动标记打到行号槽上；正文变化后由调用方重算再发一次。 */
export function applyChangeMarks(view: EditorView, marks: ChangeMark[]): void {
  view.dispatch({ effects: setChangeMarks.of(marks) });
}

/**
 * 小地图左侧那条 VCS 色带：行号 → 颜色。
 *
 * 每一行都要给：库是按行画一小段竖条，只标起始行就成了一条细线，看过去跟没有一样——
 * 原来 Monaco 那条带是整段连续的。
 *
 * 色值得给具体颜色——小地图是 canvas，画不出 CSS 变量。取值与原来
 * Monaco 概览条那档一致（同一组 --accent-* 的十六进制）。
 */
export function minimapGutters(marks: ChangeMark[], dark: boolean): Record<number, string> {
  const colors = {
    added: dark ? "#4ade80cc" : "#22c55ecc",
    modified: dark ? "#58a6ffcc" : "#3b82f6cc",
    deleted: dark ? "#f87171cc" : "#ef4444cc",
  };
  const strip: Record<number, string> = {};
  for (const mark of marks) {
    for (let line = mark.startLine; line <= Math.max(mark.startLine, mark.endLine); line += 1) {
      strip[line] = colors[mark.kind];
    }
  }
  return strip;
}
