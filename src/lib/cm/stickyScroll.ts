/**
 * Sticky scroll（IDEA 2023+ 默认开启）：首个可视行所在作用域的头部行钉在编辑区顶部。
 * 作用域取折叠范围（forge 的 foldedRanges 已合并语法折叠与 LSP folding），没有折叠信息时
 * 退回语法树的 Body/Block 节点。点钉住的行跳到那一行（对齐 openidea cm/stickyScroll.ts）。
 */
import { EditorSelection, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { foldNodeProp, foldedRanges, syntaxTree } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { forgeHighlightStyle } from "./highlight";

/** 最多钉几行。 */
const STICKY_MAX_LINES = 5;

/** 包住 `lineNo` 且起点在其上方的「头部行」行号（1 起），由外到内。 */
export function enclosingHeaders(state: EditorState, lineNo: number): number[] {
  const doc = state.doc;
  if (lineNo < 1 || lineNo > doc.lines) return [];
  const linePos = doc.line(lineNo).from;
  const headers = new Set<number>();
  let hasFolds = false;
  foldedRanges(state).between(0, linePos, (from, to) => {
    if (from >= linePos) return false;
    hasFolds = true;
    // 折叠范围恰好包住可视行（终点在行首或之后）才算 enclosing。
    if (to >= linePos) headers.add(doc.lineAt(from).number);
  });
  if (!hasFolds) {
    const tree = syntaxTree(state);
    for (
      let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(linePos, 1);
      node;
      node = node.parent
    ) {
      if (!node.type.prop(foldNodeProp) && !/Body|Block|ClassBody|Object|Array/.test(node.type.name)) continue;
      const start = doc.lineAt(node.from).number;
      const end = doc.lineAt(node.to).number;
      if (start < lineNo && end > lineNo) headers.add(start);
    }
  }
  return [...headers]
    .filter((n) => n < lineNo)
    .sort((a, b) => a - b)
    .slice(-STICKY_MAX_LINES);
}

/** 用当前语法树给一行正文上色，塞进 `target`（sticky 行的内容与正文一致）。 */
function renderLineContent(state: EditorState, lineNo: number, target: HTMLElement): void {
  const line = state.doc.line(lineNo);
  const text = line.text.length > 400 ? line.text.slice(0, 400) : line.text;
  const end = line.from + text.length;
  const tree = syntaxTree(state);
  let pos = line.from;
  const push = (to: number, cls: string) => {
    if (to <= pos) return;
    const chunk = state.doc.sliceString(pos, to);
    if (cls) {
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = chunk;
      target.appendChild(span);
    } else {
      target.appendChild(document.createTextNode(chunk));
    }
    pos = to;
  };
  if (tree.length >= end) {
    highlightTree(
      tree,
      forgeHighlightStyle,
      (from, to, cls) => {
        push(Math.max(from, pos), "");
        push(Math.min(to, end), cls);
      },
      line.from,
      end,
    );
  }
  push(end, "");
}

class StickyScroll {
  readonly dom: HTMLElement;
  private lines: number[] = [];
  private gutterWidth = 0;
  private numberLeft = 0;
  private scheduled = false;

  constructor(private view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-forge-sticky";
    this.dom.style.display = "none";
    this.dom.setAttribute("aria-hidden", "true");
    this.dom.addEventListener("mousedown", this.onMouseDown);
    view.dom.appendChild(this.dom);
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.schedule();
  }

  update(u: ViewUpdate) {
    if (
      u.docChanged ||
      u.viewportChanged ||
      u.geometryChanged ||
      syntaxTree(u.startState) !== syntaxTree(u.state)
    ) {
      this.schedule();
    }
  }

  private onScroll = () => this.schedule();

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        this.scheduled = false;
        const scroller = view.scrollDOM;
        const scrollTop = scroller.scrollTop;
        const docOffset = view.documentTop - scroller.getBoundingClientRect().top + scrollTop;
        const lh = view.defaultLineHeight;
        const gutters = view.dom.querySelector<HTMLElement>(".cm-gutters");
        const numbers = view.dom.querySelector<HTMLElement>(".cm-lineNumbers");
        const gutterWidth = gutters?.offsetWidth ?? 0;
        const numberWidth = numbers?.offsetWidth ?? 0;
        // 行号槽左边的其它槽（折叠扣、lint 记号）会把号码列往右推。
        const numberLeft =
          gutters && numbers
            ? Math.max(0, numbers.getBoundingClientRect().left - gutters.getBoundingClientRect().left)
            : 0;
        if (scrollTop - docOffset <= 0)
          return { lines: [] as number[], gutterWidth, numberWidth, numberLeft };
        // n 行 sticky 盖住前 n 个可视行，显示的是它们下面那行由外到内的 n 层头部。
        const lineBelow = (n: number) => {
          const block = view.lineBlockAtHeight(
            Math.min(scrollTop - docOffset + n * lh + 1, view.contentHeight - 1)
          );
          return view.state.doc.lineAt(block.from).number;
        };
        let headers: number[] = [];
        for (let n = 1; n <= STICKY_MAX_LINES; n++) {
          const enclosing = enclosingHeaders(view.state, lineBelow(n));
          if (enclosing.length < n) break;
          headers = enclosing.slice(0, n);
        }
        return { lines: headers, gutterWidth, numberWidth, numberLeft };
      },
      write: ({ lines, gutterWidth, numberWidth, numberLeft }) => {
        const state = this.view.state;
        const same =
          lines.length === this.lines.length &&
          lines.every((n, i) => n === this.lines[i]) &&
          gutterWidth === this.gutterWidth &&
          numberLeft === this.numberLeft;
        if (!lines.length) {
          this.dom.style.display = "none";
          this.lines = [];
          return;
        }
        this.dom.style.display = "";
        this.gutterWidth = gutterWidth;
        this.numberLeft = numberLeft;
        if (same) return;
        this.lines = lines;
        const frag = document.createDocumentFragment();
        for (const n of lines) {
          const row = document.createElement("div");
          row.className = "cm-forge-stickyLine";
          row.dataset.line = String(n);
          const num = document.createElement("span");
          num.className = "cm-forge-stickyNumber";
          num.style.width = `${numberWidth}px`;
          num.style.marginLeft = `${numberLeft}px`;
          num.style.marginRight = `${Math.max(0, gutterWidth - numberLeft - numberWidth)}px`;
          num.textContent = String(n);
          const text = document.createElement("span");
          text.className = "cm-forge-stickyText";
          renderLineContent(state, n, text);
          row.append(num, text);
          frag.appendChild(row);
        }
        this.dom.replaceChildren(frag);
        // sticky 层盖住的正文水平滚动要跟手：内容反向平移一个 scrollLeft。
        this.syncHorizontal(this.view.scrollDOM.scrollLeft);
      },
    });
  }

  private syncHorizontal(scrollLeft: number): void {
    for (const text of this.dom.querySelectorAll<HTMLElement>(".cm-forge-stickyText")) {
      text.style.transform = scrollLeft ? `translateX(${-scrollLeft}px)` : "";
    }
  }

  private onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>(".cm-forge-stickyLine");
    if (!row?.dataset.line) return;
    e.preventDefault();
    const state = this.view.state;
    const line = state.doc.line(Math.min(Number(row.dataset.line), state.doc.lines));
    // 那一行接管自己这行 sticky 的位置，文字正好留在指针底下。
    const rowIndex = [...this.dom.children].indexOf(row);
    this.view.dispatch({
      selection: EditorSelection.cursor(line.from),
      effects: EditorView.scrollIntoView(line.from, {
        y: "start",
        yMargin: Math.max(0, rowIndex) * this.view.defaultLineHeight,
      }),
      userEvent: "select.sticky",
    });
    this.view.focus();
  };

  destroy() {
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.dom.remove();
  }
}

export const stickyScroll: Extension = ViewPlugin.fromClass(StickyScroll);
