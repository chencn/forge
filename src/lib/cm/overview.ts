/**
 * 右侧滚动条上那条改动色带（IDEA 的「错误条」位置）：整篇按比例铺在编辑器右缘，
 * 每段改动画成一根小竖条，点上去跳到那一行。
 *
 * 移植自 IntelliJ IDEA 的 `src/editor/core/cm/lanes.ts`（OverviewLane）。
 *
 * 色带落在滚动条那一列，不动正文宽度；小地图开着时它压在小地图右缘，同 IDEA。
 * 长短文档都按比例算：短到一屏放得下就按像素摆，长的按百分比——窗口改大小不用重写。
 */
import { EditorSelection, Facet } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { changeMarksOf, type ChangeMark } from "./changeMarks";

/**
 * 点中一条之后怎么跳。
 *
 * 默认是编辑器自己滚；比对视图两栏各自的滚动条是关着的，整份外框才是一条，
 * 由那边换一份实现：选中 + 滚外框。
 */
export const overviewJump = Facet.define<(view: EditorView, pos: number) => void>();

/** 一道色条：位置、高度（像素或百分比，看 `unit`）、颜色。 */
interface Row {
  top: number;
  height: number;
  color: string;
  thin: boolean;
  /** 点它跳到的正文偏移。 */
  pos: number;
}

const MAX_RENDERED = 4000;

/** 点偏多少（px）还算点在这一条上。 */
const MARK_TOLERANCE = 6;

const COLORS: Record<ChangeMark["kind"], string> = {
  added: "var(--accent-green)",
  modified: "var(--accent-blue)",
  deleted: "var(--accent-red)",
};

/** 离 `y` 最近、且落在外扩 `MARK_TOLERANCE` 之内的那一条。 */
function nearestMark<M extends { top: number; bottom: number }>(marks: readonly M[], y: number): M | null {
  let best: M | null = null;
  for (const mark of marks) {
    if (y < mark.top - MARK_TOLERANCE || y > mark.bottom + MARK_TOLERANCE) continue;
    if (!best || Math.abs(mark.top - y) < Math.abs(best.top - y)) best = mark;
  }
  return best;
}

class OverviewLane {
  dom: HTMLElement;
  private scheduled = false;
  private lastKey = "";

  constructor(readonly view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-overview";
    this.dom.addEventListener("mousedown", this.onMouseDown);
    view.dom.appendChild(this.dom);
    this.schedule();
  }

  update(update: ViewUpdate) {
    if (
      update.docChanged ||
      update.geometryChanged ||
      update.heightChanged ||
      changeMarksOf(update.state) !== changeMarksOf(update.startState)
    ) {
      this.schedule();
    }
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        this.scheduled = false;
        const laneHeight = view.scrollDOM.clientHeight;
        const doc = view.state.doc;
        // 正文自己的高度，不含滚到末行之后那段留白——留白也按比例算，色带就整体偏上了。
        const contentHeight = Math.max(view.lineBlockAt(doc.length).bottom, 1);
        const fit = contentHeight <= laneHeight;
        const unit = fit ? "px" : "%";
        const pos = (y: number) => (fit ? Math.floor(y) : +((y / contentHeight) * 100).toFixed(3));
        const size = (h: number) => (fit ? Math.round(h) : +((h / contentHeight) * 100).toFixed(3));
        const rows: Row[] = [];
        for (const mark of changeMarksOf(view.state)) {
          if (rows.length >= MAX_RENDERED) break;
          const start = Math.min(Math.max(1, mark.startLine), doc.lines);
          const end = Math.min(Math.max(start, mark.endLine), doc.lines);
          const from = doc.line(start).from;
          const a = view.lineBlockAt(from);
          // 删除没有行高：给个最小高度，缩成一条线就看不见了。
          const b = mark.kind === "deleted" ? a : view.lineBlockAt(doc.line(end).to);
          rows.push({
            top: pos(a.top),
            height: Math.max(size(b.bottom - a.top), fit ? 3 : 0.3),
            color: COLORS[mark.kind],
            thin: mark.kind !== "added",
            pos: from,
          });
        }
        return { rows, unit };
      },
      write: ({ rows, unit }) => {
        const key = rows.map((r) => `${r.top},${r.height},${r.color},${r.pos}`).join("|") + unit;
        if (key === this.lastKey) return;
        this.lastKey = key;
        const fragment = document.createDocumentFragment();
        for (const row of rows) {
          const el = document.createElement("div");
          el.className = row.thin ? "cm-overviewMark cm-overviewMark-thin" : "cm-overviewMark";
          el.style.top = `${row.top}${unit}`;
          el.style.height = `${row.height}${unit}`;
          el.style.background = row.color;
          el.dataset.pos = String(row.pos);
          fragment.appendChild(el);
        }
        this.dom.replaceChildren(fragment);
      },
    });
  }

  private onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    // 点空白处要留给滚动条本身（拖动滑块），只拦点中色条的那些。
    const hit = nearestMark(
      [...this.dom.querySelectorAll<HTMLElement>(".cm-overviewMark")].map((el) => {
        const rect = el.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, pos: Number(el.dataset.pos) };
      }),
      event.clientY
    );
    if (!hit) return;
    event.preventDefault();
    const pos = Math.min(hit.pos, this.view.state.doc.length);
    const [jump] = this.view.state.facet(overviewJump);
    if (jump) {
      jump(this.view, pos);
      return;
    }
    this.view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
      userEvent: "select.overview",
    });
    this.view.focus();
  };

  destroy() {
    this.dom.removeEventListener("mousedown", this.onMouseDown);
    this.dom.remove();
  }
}

export const overviewLane = ViewPlugin.fromClass(OverviewLane);
