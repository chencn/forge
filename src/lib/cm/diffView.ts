/**
 * 比对视图的公共那一段：并排（两侧各一台编辑器、没改的行对齐）与单栏（改动上下排）
 * 两种排法都从这里出，Git 面板、本地历史、聊天里的补丁预览共用一套走差异的接线。
 *
 * 引擎用 `@codemirror/merge`：改动块（chunk）把挨着的改动并成一块，跨行的没改区折成一条，
 * 整台只读——「接受 / 拒绝」由外层按块打补丁（git apply），不在这里动编辑器。
 */
import {
  Compartment,
  Prec,
  EditorState,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  gutter,
  GutterMarker,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type Command,
} from "@codemirror/view";
import { bracketMatching, syntaxHighlighting } from "@codemirror/language";
import { Chunk, MergeView, getChunks, unifiedMergeView } from "@codemirror/merge";
import type { Text } from "@codemirror/state";
import { applyChangeMarks, changeMarksField, type ChangeMark } from "./changeMarks";
import { grammarSupport, loadGrammar, pathExtension } from "./grammars";
import { cmPhrases } from "./phrases";
import { forgeHighlightStyle } from "./highlight";
import { indentGuides } from "./indentGuides";
import { rainbowBrackets } from "./rainbowBrackets";
import { diffConfigFor, type DiffWhitespace } from "./lineDiff";
export type { DiffWhitespace };
import { buildChunkPatch } from "./chunkPatch";
import { forgeTheme } from "./theme";
import { forgeSearch } from "./find";
import { forgeKeymap } from "./keymap";
import { cmKey, presetKeys } from "../keymaps/idea";
import type { KeymapScheme } from "../settings";

/** 两种排法：并排两栏，或者一栏里上下摆改动。 */
export type DiffMode = "side" | "unified";

/** 词级高亮：words 是库的词级标记，lines 只染整行，none 全部素着。 */
export type DiffHighlight = "words" | "lines" | "none";

/** 差异间跳转方向。 */
export type DiffDir = "next" | "previous";

/** 本篇的差异条数、还剩几处可走，以及光标落在第几处（1 起，0 = 不在任何一处里）。 */
export interface DiffNav {
  count: number;
  previous: boolean;
  next: boolean;
  index: number;
}

/** {@link createDiffView} 的入参。 */
export interface DiffViewOptions {
  keymapScheme?: KeymapScheme;
  /** 挂正文的容器；两种排法都只占这一个元素。 */
  parent: HTMLElement;
  /** 左边 / 上边那一份（基线）。 */
  original: string;
  /** 右边 / 下边那一份（当前）。 */
  modified: string;
  /** 语言 id（`languageForPath` 那张表给的）：认不出就按纯文本排。 */
  language: string;
  /** 比对的是内存里的正文，这条路径只用来纠 tsx/jsx 的语言判定。 */
  path?: string;
  mode: DiffMode;
  /** 词级 / 整行 / 不高亮；缺省 words。 */
  highlight?: DiffHighlight;
  /** 折叠未更改区；缺省关。 */
  collapse?: boolean;
  /** 空白口径：default 严格比，trim 首尾、ignore 全部空白，ignoreEmptyLines 连空行一起扔。 */
  whitespace?: DiffWhitespace;
  /** 双栏滚动是否同步；缺省同步。 */
  syncScroll?: boolean;
  /**
   * 每块行内控件的落点：stage 把块打进索引，revert 把块从工作区撤掉。
   * 补丁由这里按块生成，回调只管落地。
   */
  onChunkOp?: (op: "stage" | "revert", patch: string) => void;
  /** 块控件的悬停文案（调用方翻好）。 */
  chunkLabels?: { stage: string; revert: string };
  /**
   * 块级勾选框状态变化回调。
   * 缺省已自动在内部维护勾选状态并重绘。
   */
  onChunkCheck?: (chunkIndex: number, checked: boolean, chunk: Chunk) => void;
  /**
   * 行号怎么显示。补丁预览里模型是从 1 起数的，真实文件行号得由外面给——
   * hunk 之间跳过的区间不占号，不是简单的加一个偏移。
   */
  numbers?: { original?: (line: number) => string; modified?: (line: number) => string };
  /** 光标一动就回报条数与还剩几处可走；建完立刻报一次，上下箭头照这个禁用。 */
  onNav?: (nav: DiffNav) => void;
  /** F7 / ⇧F7 走到头的那一下交给外层（跨文件链）。 */
  onStep?: (dir: DiffDir) => void;
  /** F4 跳到源文件。 */
  onJumpSource?: () => void;
}

/** 差异视图的命令式句柄（跳转/换排法/换档位/销毁）。 */
export interface DiffView {
  setKeymap: (scheme: KeymapScheme) => void;
  canGo: (dir: DiffDir) => boolean;
  /** 走到本篇的下一处 / 上一处；不可走时什么都不做。 */
  go: (dir: DiffDir) => void;
  /** 落到首 / 末那一处：从邻篇换过来时用。 */
  land: (on: "first" | "last") => void;
  /** 换排法：两种排法是两台不同的视图，这里整份重建（正文与位置照原样接回来）。 */
  setMode: (mode: DiffMode) => void;
  /** 换高亮 / 折叠 / 空白口径 / 同步滚动这类要重建视图的档位。 */
  setPresentation: (next: {
    highlight?: DiffHighlight;
    collapse?: boolean;
    whitespace?: DiffWhitespace;
    syncScroll?: boolean;
  }) => void;
  /** 光标所在的那一处改动（本块优先，其次下一块），连同它的序号（1 起）。 */
  currentChunk: () => { index: number; chunk: Chunk | null };
  destroy: () => void;
}

/** 折起来的没改区：改动上下各留 3 行，≥6 行的没改区才折。 */
const COLLAPSE = { margin: 3, minSize: 6 };

/** 块级勾选框装订线标记：提交比对里勾选是否包含此块 [✓] */
class ChunkCheckboxMarker extends GutterMarker {
  constructor(
    readonly chunkIndex: number,
    readonly checked: boolean,
    readonly onToggle: (index: number) => void
  ) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    return (
      other instanceof ChunkCheckboxMarker &&
      other.chunkIndex === this.chunkIndex &&
      other.checked === this.checked
    );
  }

  override toDOM(): Node {
    const box = document.createElement("div");
    box.className = `cm-diff-chunk-checkbox${this.checked ? " is-checked" : ""}`;
    box.title = this.checked ? "已勾选提交此块（点击取消）" : "未勾选此块（点击包含）";
    if (this.checked) {
      box.innerHTML = `<svg viewBox="0 0 12 12" width="9" height="9"><path d="M2.5 6.5 L4.8 8.8 L9.5 3.5" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    box.addEventListener("mousedown", (e) => e.stopPropagation());
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onToggle(this.chunkIndex);
    });
    return box;
  }
}

/** 更新勾选框装订线标记的效果。 */
const setCheckboxMarkers = StateEffect.define<RangeSet<GutterMarker>>();

/** 勾选框装订线标记的状态字段。 */
const checkboxGutterField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCheckboxMarkers)) return effect.value;
    }
    return value;
  },
});

/** 块级勾选框装订槽（挂在修改侧栏上）。 */
const diffCheckboxGutter = gutter({
  class: "cm-diff-checkbox-gutter",
  markers: (view) => view.state.field(checkboxGutterField, false) ?? RangeSet.empty,
});

/** 一栏的扩展。 */
const diffKeymapSlot = new Compartment();

/** 比对焦点优先处理差异动作，其他移动/查找键复用当前方案。 */
function diffShortcuts(options: DiffViewOptions, step: (dir: DiffDir, view: EditorView) => boolean, opposite: Command): Extension {
  const scheme = options.keymapScheme ?? 'idea';
  const bindings = [
    ...(['NextDiff', 'PreviousDiff', 'Diff.NextChange', 'Diff.PrevChange'] as const).flatMap((action) => presetKeys(scheme, action).map((key) => ({
      key: cmKey(key), run: (view: EditorView) => step(action === 'NextDiff' || action === 'Diff.NextChange' ? 'next' : 'previous', view),
    }))),
    ...presetKeys(scheme, 'Diff.FocusOppositePane').map((key) => ({ key: cmKey(key), run: opposite })),
    ...(options.onJumpSource ? presetKeys(scheme, 'EditSource').map((key) => ({
      key: cmKey(key), run: () => { options.onJumpSource?.(); return true; },
    })) : []),
  ];
  return [Prec.highest(keymap.of(bindings)), forgeKeymap(scheme)];
}

/** 拼一栏（并排模式单侧）的全部扩展：只读、行号、主题、键位与勾选槽。 */
function sideExtensions(
  options: DiffViewOptions,
  shortcuts: Extension,
  format: ((line: number) => string) | undefined,
  language: Compartment,
  onCaret?: () => void,
  isRightSide = false,
  onGeometryChange?: () => void
): Extension[] {
  const support = grammarSupport(options.language, pathExtension(options.path ?? ""));
  return [
    EditorState.phrases.of(cmPhrases),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.editorAttributes.of({ class: "forge-diff" }),
    lineNumbers(format ? { formatNumber: (line) => format(line) } : undefined),
    // 右栏（工作副本修改栏）挂块级勾选框装订槽 [✓]
    ...(isRightSide ? [checkboxGutterField, diffCheckboxGutter] : []),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    drawSelection(),
    bracketMatching(),
    indentGuides,
    rainbowBrackets(),
    syntaxHighlighting(forgeHighlightStyle),
    // 比对侧与正文共用搜索栏；只读状态由面板负责隐藏替换入口。
    forgeSearch,
    diffKeymapSlot.of(shortcuts),
    forgeTheme,
    // 改动色带：比对的每一处改动画在装订线上（右侧概览条比对不挂）。
    changeMarksField,
    // 监听视图更新（几何变动、滚动、选区等）
    EditorView.updateListener.of((update) => {
      if (update.selectionSet && onCaret) onCaret();
      if ((update.geometryChanged || update.docChanged) && onGeometryChange) {
        onGeometryChange();
      }
    }),
    language.of(support ? [support] : []),
  ];
}

/**
 * 一处改动在某一栏里的行号范围。
 *
 * 并排看的时候两栏都要标：读侧是新增蓝、改了蓝，改动里没有对应的那半（纯删 / 纯增）
 * 在另一栏就是一个空档，摆一颗三角。单栏只有一份正文，按读侧那一套算。
 */
function marksOf(chunks: readonly Chunk[], side: "a" | "b", doc: Text): ChangeMark[] {
  const marks: ChangeMark[] = [];
  for (const chunk of chunks) {
    const from = side === "a" ? chunk.fromA : chunk.fromB;
    const to = side === "a" ? chunk.toA : chunk.toB;
    const startLine = doc.lineAt(Math.min(from, doc.length)).number;
    // 这一栏没有对应的行：新增在左栏、删除在右栏都是这个形状，挂一颗三角。
    if (from === to) {
      marks.push({ startLine, endLine: startLine, kind: "deleted", edge: "after" });
      continue;
    }
    const endLine = doc.lineAt(Math.max(from, to - 1)).number;
    const other = side === "a" ? chunk.toB - chunk.fromB : chunk.toA - chunk.fromA;
    // 左栏里没有对应内容的，是真的被删掉了那一整段，画灰条；其余都算改动。
    const kind = other === 0 ? "deleted" : side === "b" && chunk.fromA === chunk.toA ? "added" : "modified";
    marks.push({ startLine, endLine, kind, edge: "line" });
  }
  return marks;
}

/**
 * 创建一台比对视图。
 *
 * 差异在建的时候就算完了（`@codemirror/merge` 的 chunk 是同步算的），所以条数、
 * 箭头可走与否一开始就有值，没有「正在算」的那一档。
 */
export function createDiffView(options: DiffViewOptions): DiffView {
  // 配置留在本视图内，切换方案不修改调用方对象，也不重建丢失滚动位置。
  options = { ...options };
  let mode = options.mode;
  let highlight: DiffHighlight = options.highlight ?? "words";
  let collapse = options.collapse ?? false;
  let whitespace: DiffWhitespace = options.whitespace ?? "default";
  let syncScroll = options.syncScroll ?? true;
  /** 并排那台；单栏排法下是 null。 */
  let merge: MergeView | null = null;
  /** 读侧那一栏：并排时是右栏，单栏时就是唯一那一栏。上下箭头都按它的光标算。 */
  let read: EditorView;
  let chunks: readonly Chunk[] = [];
  let destroyed = false;
  /** 本轮建出来的那几栏：语法包迟到时要往它们身上补发。 */
  let panes: EditorView[] = [];
  let languageSlot: Compartment | null = null;
  /** 并排比对中间的分栏与连线色带元素 */
  let splitterEl: HTMLElement | null = null;
  let svgEl: SVGSVGElement | null = null;
  let buttonsBoxEl: HTMLElement | null = null;
  let scrollCleanup: (() => void) | null = null;
  let updateHorizontalScrollbars: (() => void) | null = null;
  let checkedChunks = new Set<number>();
  let renderScheduled = false;

  function scheduleRibbonRender(): void {
    if (renderScheduled || destroyed) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      if (destroyed) return;
      updateHorizontalScrollbars?.();
      renderRibbons();
    });
  }

  /** 更新右栏行号旁的块级勾选框 [✓] */
  function updateCheckboxMarkers(): void {
    if (!read || destroyed) return;
    const builder = new RangeSetBuilder<GutterMarker>();
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const at = Math.min(chunk.fromB, read.state.doc.length);
      const line = read.state.doc.lineAt(at);
      const checked = checkedChunks.has(i);
      builder.add(
        line.from,
        line.from,
        new ChunkCheckboxMarker(i, checked, (idx) => {
          if (checkedChunks.has(idx)) {
            checkedChunks.delete(idx);
          } else {
            checkedChunks.add(idx);
          }
          updateCheckboxMarkers();
          options.onChunkCheck?.(idx, checkedChunks.has(idx), chunks[idx]);
        })
      );
    }
    read.dispatch({ effects: setCheckboxMarkers.of(builder.finish()) });
  }

  /** 在两栏中间的分栏区实时绘制平滑连线色带与 > 回退按钮（左右高度严格一致） */
  function renderRibbons(): void {
    if (!merge || !splitterEl || !svgEl || !buttonsBoxEl || destroyed) return;

    svgEl.innerHTML = "";
    buttonsBoxEl.innerHTML = "";
    if (chunks.length === 0) return;

    const width = splitterEl.clientWidth || 30;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      const hasContentA = chunk.fromA < chunk.toA;
      const hasContentB = chunk.fromB < chunk.toB;

      const posA = Math.min(chunk.fromA, merge.a.state.doc.length);
      const posB = Math.min(chunk.fromB, merge.b.state.doc.length);
      const startBlockA = merge.a.lineBlockAt(posA);
      const startBlockB = merge.b.lineBlockAt(posB);

      // 起始高度：在 Spacer 对齐下，左右栏改动块的起始顶线平直对齐
      const topA = startBlockA.top;
      const topB = startBlockB.top;
      const chunkTop = Math.min(topA, topB);

      // 终止高度：包含改动块本身及两栏内部已插入的 Spacer 物理空间，确保左右两侧高度完全一致
      let bottomA = startBlockA.bottom;
      if (hasContentA) {
        bottomA = merge.a.lineBlockAt(Math.max(chunk.fromA, chunk.toA - 1)).bottom;
      }
      if (chunk.toA < merge.a.state.doc.length) {
        bottomA = Math.max(bottomA, merge.a.lineBlockAt(chunk.toA).top);
      }

      let bottomB = startBlockB.bottom;
      if (hasContentB) {
        bottomB = merge.b.lineBlockAt(Math.max(chunk.fromB, chunk.toB - 1)).bottom;
      }
      if (chunk.toB < merge.b.state.doc.length) {
        bottomB = Math.max(bottomB, merge.b.lineBlockAt(chunk.toB).top);
      }

      // 左右物理高度严格对齐一致（消除左矮右高的喇叭口畸变）
      const chunkBottom = Math.max(bottomA, bottomB, chunkTop + 22);

      const cp1x = width * 0.38;
      const cp2x = width * 0.62;

      // 绘制填充色带
      const dFill = `M 0 ${chunkTop} C ${cp1x} ${chunkTop}, ${cp2x} ${chunkTop}, ${width} ${chunkTop} L ${width} ${chunkBottom} C ${cp2x} ${chunkBottom}, ${cp1x} ${chunkBottom}, 0 ${chunkBottom} Z`;
      const fillPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      fillPath.setAttribute("class", "forge-diff-ribbon-path");
      fillPath.setAttribute("d", dFill);
      svgEl.appendChild(fillPath);

      // 绘制顶线与底线平滑轮廓（左右两端无多余竖线）
      const dTop = `M 0 ${chunkTop} C ${cp1x} ${chunkTop}, ${cp2x} ${chunkTop}, ${width} ${chunkTop}`;
      const topLine = document.createElementNS("http://www.w3.org/2000/svg", "path");
      topLine.setAttribute("class", "forge-diff-ribbon-border");
      topLine.setAttribute("d", dTop);
      svgEl.appendChild(topLine);

      const dBottom = `M 0 ${chunkBottom} C ${cp1x} ${chunkBottom}, ${cp2x} ${chunkBottom}, ${width} ${chunkBottom}`;
      const bottomLine = document.createElementNS("http://www.w3.org/2000/svg", "path");
      bottomLine.setAttribute("class", "forge-diff-ribbon-border");
      bottomLine.setAttribute("d", dBottom);
      svgEl.appendChild(bottomLine);

      // 挂载白底微立体阴影卡片 > 回滚按钮（居左贴靠，垂直居中于首行中心线）
      if (options.onChunkOp) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "forge-diff-revert-btn";
        btn.title = options.chunkLabels?.revert ?? "回滚此改动块";
        const lineH = Math.max(18, startBlockA.height || 22);
        btn.style.top = `${Math.max(0, chunkTop + (lineH - 15) / 2)}px`;
        btn.innerHTML = `<svg viewBox="0 0 12 12" width="7" height="7"><path d="M4 2.5 L7.5 6 L4 9.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const patch = buildChunkPatch(
            options.path ?? "",
            options.original,
            options.modified,
            chunk
          );
          options.onChunkOp?.("revert", patch);
        });
        buttonsBoxEl.appendChild(btn);
      }
    }
  }

  const lineOf = (pos: number) => read.state.doc.lineAt(Math.min(pos, read.state.doc.length)).number;

  /** 光标之外还有没有起点比它晚 / 比它早的那一处。落在同一处里再按同方向不再走。 */
  function canGo(dir: DiffDir): boolean {
    if (chunks.length === 0) return false;
    const line = lineOf(read.state.selection.main.head);
    return chunks.some((chunk) =>
      dir === "next" ? lineOf(chunk.fromB) > line : lineOf(chunk.fromB) < line
    );
  }

  /** 光标落在哪一处里；都不在就是下一处（再没有就 null）。 */
  function currentChunk(): { index: number; chunk: Chunk | null } {
    if (chunks.length === 0) return { index: 0, chunk: null };
    const pos = read.state.selection.main.head;
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (pos >= chunk.fromB && pos <= chunk.toB) return { index: i + 1, chunk };
    }
    const line = lineOf(pos);
    const next = chunks.find((chunk) => lineOf(chunk.fromB) >= line);
    return { index: 0, chunk: next ?? null };
  }

  function reportNav(): void {
    if (destroyed) return;
    const cursor = currentChunk();
    options.onNav?.({
      count: chunks.length,
      previous: canGo("previous"),
      next: canGo("next"),
      index: cursor.index,
    });
  }

  /**
   * 把某一处滚到中间。
   *
   * 并排那一档，库把两栏自己的竖向滚动条关了（`.cm-scroller` 是 `height: auto` +
   * `overflow: visible`），整份 `.cm-mergeView` 才是一条滚动条——所以编辑器自己的
   * `scrollIntoView` 在那一档没处可使，得自己滚外框。行块坐标加栏顶偏移就是外框坐标。
   */
  function revealFrom(view: EditorView, pos: number): void {
    const block = view.lineBlockAt(Math.min(pos, view.state.doc.length));
    if (merge) {
      const outer = merge.dom;
      const top =
        view.dom.getBoundingClientRect().top - outer.getBoundingClientRect().top + outer.scrollTop;
      outer.scrollTo({
        top: Math.max(0, top + block.top - (outer.clientHeight - block.height) / 2),
      });
      return;
    }
    const target = Math.max(0, block.top - (view.scrollDOM.clientHeight - block.height) / 2);
    view.scrollDOM.scrollTo({ top: target });
  }

  function reveal(pos: number): void {
    revealFrom(read, pos);
  }

  /** 走或落：把光标放到那一处的起点，读侧滚动跟上。 */
  function jump(pos: number): void {
    read.dispatch({ selection: { anchor: pos } });
    reveal(pos);
    reportNav();
  }

  function go(dir: DiffDir): void {
    if (!canGo(dir)) return;
    const line = lineOf(read.state.selection.main.head);
    const ordered = dir === "next" ? chunks : [...chunks].reverse();
    const target = ordered.find((chunk) =>
      dir === "next" ? lineOf(chunk.fromB) > line : lineOf(chunk.fromB) < line
    );
    if (target) jump(Math.min(target.fromB, read.state.doc.length));
  }

  function land(on: "first" | "last"): void {
    if (chunks.length === 0) return;
    const chunk = on === "first" ? chunks[0] : chunks[chunks.length - 1];
    jump(Math.min(chunk.fromB, read.state.doc.length));
  }

  /** 嵌入式比对没有跨文件回调，仍须按当前焦点所在侧的坐标导航。 */
  function step(dir: DiffDir, source: EditorView): boolean {
    if (options.onStep) { options.onStep(dir); return true; }
    const position = (chunk: Chunk) => Math.min(source === merge?.a ? chunk.fromA : chunk.fromB, source.state.doc.length);
    const line = source.state.doc.lineAt(source.state.selection.main.head).number;
    const ordered = dir === 'next' ? chunks : [...chunks].reverse();
    const target = ordered.find((chunk) => dir === 'next'
      ? source.state.doc.lineAt(position(chunk)).number > line
      : source.state.doc.lineAt(position(chunk)).number < line);
    if (!target) return false;
    source.dispatch({ selection: { anchor: position(target) } });
    revealFrom(source, position(target));
    return true;
  }

  function focusOpposite(source: EditorView): boolean {
    if (!merge) return false;
    (source === merge.a ? merge.b : merge.a).focus();
    return true;
  }

  function build(): void {
    const slot = new Compartment();
    languageSlot = slot;
    const highlightChanges = highlight === "words";
    const collapseUnchanged = collapse ? COLLAPSE : undefined;
    const diffConfig = diffConfigFor(whitespace);
    if (mode === "side") {
      merge = new MergeView({
        a: {
          doc: options.original,
          extensions: sideExtensions(options, diffShortcuts(options, step, focusOpposite), options.numbers?.original, slot, undefined, false, scheduleRibbonRender),
        },
        b: {
          doc: options.modified,
          extensions: sideExtensions(options, diffShortcuts(options, step, focusOpposite), options.numbers?.modified, slot, reportNav, true, scheduleRibbonRender),
        },
        parent: options.parent,
        collapseUnchanged,
        highlightChanges,
        diffConfig,
      });
      read = merge.b;
      chunks = merge.chunks;
      panes = [merge.a, merge.b];
      applyChangeMarks(merge.a, marksOf(chunks, "a", merge.a.state.doc));
      applyChangeMarks(merge.b, marksOf(chunks, "b", merge.b.state.doc));

      // 在并排左右两栏之间挂载分栏槽（Splitter Gutter）
      const wrapA = merge.a.dom.parentElement;
      const wrapB = merge.b.dom.parentElement;
      const editorsParent = wrapA?.parentElement;
      if (editorsParent && wrapB) {
        splitterEl = document.createElement("div");
        splitterEl.className = "forge-diff-splitter";

        svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svgEl.setAttribute("class", "forge-diff-ribbon-svg");
        splitterEl.appendChild(svgEl);

        buttonsBoxEl = document.createElement("div");
        buttonsBoxEl.className = "forge-diff-buttons";
        splitterEl.appendChild(buttonsBoxEl);

        editorsParent.insertBefore(splitterEl, wrapB);
      }

      // 子编辑器随整份文件增高，原生横向条也落在文件末尾；底部代理条保留共同纵向滚动。
      const scrollbars = document.createElement("div");
      scrollbars.className = "forge-diff-scrollbars";
      scrollbars.setAttribute("aria-hidden", "true");
      const horizontal = panes.map((pane, index) => {
        if (index > 0) {
          const gap = document.createElement("div");
          gap.className = "forge-diff-scrollbar-gap";
          scrollbars.appendChild(gap);
        }
        const bar = document.createElement("div");
        bar.className = "forge-diff-scrollbar";
        bar.tabIndex = -1;
        const track = document.createElement("div");
        track.className = "forge-diff-scrollbar-track";
        bar.appendChild(track);
        scrollbars.appendChild(bar);
        const syncFromEditor = () => { bar.scrollLeft = pane.scrollDOM.scrollLeft; };
        const syncFromBar = () => { pane.scrollDOM.scrollLeft = bar.scrollLeft; };
        pane.scrollDOM.addEventListener("scroll", syncFromEditor, { passive: true });
        bar.addEventListener("scroll", syncFromBar, { passive: true });
        return { pane, bar, track, syncFromEditor, syncFromBar };
      });
      merge.dom.appendChild(scrollbars);
      updateHorizontalScrollbars = () => {
        scrollbars.hidden = horizontal.every(({ pane }) => pane.scrollDOM.scrollWidth <= pane.scrollDOM.clientWidth);
        for (const { pane, bar, track, syncFromEditor } of horizontal) {
          // 用正文的实际滚动范围计算轨道，取消同步时栏内竖向滚动条也不会造成末尾偏差。
          const range = pane.scrollDOM.scrollWidth - pane.scrollDOM.clientWidth;
          track.style.width = `${bar.clientWidth + range}px`;
          bar.style.visibility = range > 0 ? "visible" : "hidden";
          syncFromEditor();
        }
      };

      const onScroll = () => scheduleRibbonRender();
      merge.dom.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll, { passive: true });

      // 确保鼠标悬停在两栏代码、装订线或中缝任意区域滑动滚轮时，均能顺畅驱动外层滚动
      const onWheel = (e: WheelEvent) => {
        if (!merge || !syncScroll || e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey ||
          Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.deltaY === 0) return;
        const maxScroll = merge.dom.scrollHeight - merge.dom.clientHeight;
        if (maxScroll > 0) {
          const next = Math.max(0, Math.min(maxScroll, merge.dom.scrollTop + e.deltaY));
          if (next !== merge.dom.scrollTop) {
            merge.dom.scrollTop = next;
            e.preventDefault();
          }
        }
      };
      merge.dom.addEventListener("wheel", onWheel, { passive: false });

      scrollCleanup = () => {
        merge?.dom.removeEventListener("scroll", onScroll);
        merge?.dom.removeEventListener("wheel", onWheel);
        window.removeEventListener("resize", onScroll);
        updateHorizontalScrollbars = null;
        for (const { pane, bar, syncFromEditor, syncFromBar } of horizontal) {
          pane.scrollDOM.removeEventListener("scroll", syncFromEditor);
          bar.removeEventListener("scroll", syncFromBar);
        }
      };
    } else {
      merge = null;
      const state = EditorState.create({
        doc: options.modified,
        extensions: [
          ...sideExtensions(options, diffShortcuts(options, step, focusOpposite), options.numbers?.modified, slot, reportNav, true),
          unifiedMergeView({
            original: options.original,
            // 只读视图不给接受 / 拒绝那两颗按钮；改动色块与左侧那条缝照旧。
            mergeControls: false,
            highlightChanges,
            collapseUnchanged,
            diffConfig,
          }),
        ],
      });
      read = new EditorView({ state, parent: options.parent });
      chunks = getChunks(state)?.chunks ?? [];
      panes = [read];
      // 单栏只有读侧那一份正文，改动色带按它算。
      applyChangeMarks(read, marksOf(chunks, "b", read.state.doc));
    }
    // 「不高亮」是一颗样式开关：库不参与，整个外框加个类，配色规则全关。
    options.parent.classList.toggle("noHighlight", highlight === "none");
    // 「不同步滚动」也是样式档：两栏各自成滚动列，外框不滚。
    options.parent.classList.toggle("forge-diff-unsynced", mode === "side" && !syncScroll);
    applyChunkControls();

    // 语法包是异步的：第一次打开某门语言的比对时它还没进内存，`grammarSupport` 只能给 null，
    // 这篇就一直是素文本。等它到货再补一枪——不补的话「比对里没颜色」只在首次出现。
    const support = grammarSupport(options.language, pathExtension(options.path ?? ""));
    if (support) return;
    void loadGrammar(options.language, pathExtension(options.path ?? "")).then((loaded) => {
      if (!loaded || destroyed || languageSlot !== slot) return;
      for (const pane of panes) pane.dispatch({ effects: slot.reconfigure([loaded]) });
    });
  }

  /** 更新块级控件：右栏复选框与中间连线多边形 */
  function applyChunkControls(): void {
    checkedChunks = new Set(chunks.map((_, i) => i));
    updateCheckboxMarkers();
    scheduleRibbonRender();
  }

  /**
   * 收掉当前这一份。
   *
   * `MergeView.destroy()` 会把两栏一起收掉并摘掉外框，所以并排那一档不能再单独
   * destroy 读侧——读侧就是它手上的 `merge.b`。
   */
  function teardown(): void {
    if (scrollCleanup) {
      scrollCleanup();
      scrollCleanup = null;
    }
    if (splitterEl) {
      splitterEl.remove();
      splitterEl = null;
      svgEl = null;
      buttonsBoxEl = null;
    }
    if (merge) {
      merge.destroy();
      merge = null;
      return;
    }
    read.destroy();
  }

  build();
  reportNav();

  return {
    setKeymap(scheme) {
      if (destroyed || options.keymapScheme === scheme) return;
      options.keymapScheme = scheme;
      for (const pane of panes) pane.dispatch({ effects: diffKeymapSlot.reconfigure(diffShortcuts(options, step, focusOpposite)) });
    },
    canGo,
    go,
    land,
    setMode(next) {
      if (destroyed || next === mode) return;
      // 换排法留住光标：读侧正文两份排法共用，偏移直接接得上。
      const pos = read.state.selection.main.head;
      mode = next;
      teardown();
      build();
      read.dispatch({ selection: { anchor: Math.min(pos, read.state.doc.length) } });
      reportNav();
    },
    setPresentation(next) {
      const pos = read?.state.selection.main.head ?? 0;
      let dirty = false;
      if (next.highlight !== undefined && next.highlight !== highlight) {
        highlight = next.highlight;
        dirty = true;
      }
      if (next.collapse !== undefined && next.collapse !== collapse) {
        collapse = next.collapse;
        dirty = true;
      }
      if (next.whitespace !== undefined && next.whitespace !== whitespace) {
        whitespace = next.whitespace;
        dirty = true;
      }
      if (next.syncScroll !== undefined && next.syncScroll !== syncScroll) {
        syncScroll = next.syncScroll;
        // 滚动同步是纯样式档：不重建视图，直接翻外框的类。
        options.parent.classList.toggle("forge-diff-unsynced", mode === "side" && !syncScroll);
        scheduleRibbonRender();
      }
      if (!dirty || destroyed) return;
      teardown();
      build();
      read.dispatch({ selection: { anchor: Math.min(pos, read.state.doc.length) } });
      reportNav();
    },
    currentChunk,
    destroy() {
      destroyed = true;
      teardown();
    },
  };
}
