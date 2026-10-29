/**
 * 比对视图的公共那一段：并排（两侧各一台编辑器、没改的行对齐）与单栏（改动上下排）
 * 两种排法都从这里出，Git 面板、本地历史、聊天里的补丁预览共用一套走差异的接线。
 *
 * 引擎用 `@codemirror/merge`：改动块（chunk）把挨着的改动并成一块，跨行的没改区折成一条，
 * 整台只读——这里不做「接受 / 拒绝」，那是合并对话框的事。
 */
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { bracketMatching, syntaxHighlighting } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { Chunk, MergeView, getChunks, unifiedMergeView } from "@codemirror/merge";
import type { Text } from "@codemirror/state";
import { applyChangeMarks, changeMarksField, type ChangeMark } from "./changeMarks";
import { overviewJump, overviewLane } from "./overview";
import { grammarSupport, loadGrammar, pathExtension } from "./grammars";
import { cmPhrases } from "./phrases";
import { forgeHighlightStyle } from "./highlight";
import { indentGuides } from "./indentGuides";
import { rainbowBrackets } from "./rainbowBrackets";
import { lineDiffConfig } from "./lineDiff";
import { forgeTheme } from "./theme";

/** 两种排法：并排两栏，或者一栏里上下摆改动。 */
export type DiffMode = "side" | "unified";

export type DiffDir = "next" | "previous";

/** 本篇的差异条数与还剩几处可走。走到头的那一侧由调用方决定换不换篇。 */
export interface DiffNav {
  count: number;
  previous: boolean;
  next: boolean;
}

export interface DiffViewOptions {
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
  /**
   * 行号怎么显示。补丁预览里模型是从 1 起数的，真实文件行号得由外面给——
   * hunk 之间跳过的区间不占号，不是简单的加一个偏移。
   */
  numbers?: { original?: (line: number) => string; modified?: (line: number) => string };
  /** 光标一动就回报条数与还剩几处可走；建完立刻报一次，上下箭头照这个禁用。 */
  onNav?: (nav: DiffNav) => void;
}

export interface DiffView {
  canGo: (dir: DiffDir) => boolean;
  /** 走到本篇的下一处 / 上一处；不可走时什么都不做。 */
  go: (dir: DiffDir) => void;
  /** 落到首 / 末那一处：从邻篇换过来时用。 */
  land: (on: "first" | "last") => void;
  /** 换排法：两种排法是两台不同的视图，这里整份重建（正文与位置照原样接回来）。 */
  setMode: (mode: DiffMode) => void;
  destroy: () => void;
}

/** 没改的部分折起来，跟 IDEA 的比对窗口一样默认收着（点开那一条「…」就展开）。 */
const COLLAPSE = { margin: 3, minSize: 4 };

/**
 * 一栏的扩展。
 *
 * 只读、不挂小地图、不挂 LSP、没有撤销栈——比对的两侧都是内存里的正文。
 * 语法、色板、主题与正文编辑器同一套，两处观感必须一致。
 *
 * `forge-diff` 这个类是样式的作用域：库自带的改动色权重不低，而单栏那一档根本没有
 * `.cm-mergeView` 外框，靠它圈不住——所以两种排法都在编辑器元素上盖一个自己的章。
 */
function sideExtensions(
  options: DiffViewOptions,
  format: ((line: number) => string) | undefined,
  language: Compartment,
  onCaret?: () => void,
  jump?: (view: EditorView, pos: number) => void
): Extension[] {
  const support = grammarSupport(options.language, pathExtension(options.path ?? ""));
  return [
    EditorState.phrases.of(cmPhrases),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.editorAttributes.of({ class: "forge-diff" }),
    lineNumbers(format ? { formatNumber: (line) => format(line) } : undefined),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    drawSelection(),
    bracketMatching(),
    indentGuides,
    rainbowBrackets(),
    syntaxHighlighting(forgeHighlightStyle),
    keymap.of([...searchKeymap]),
    forgeTheme,
    // 改动色带与右侧概览条：比对的每一处改动画在装订线和滚动条上（同 IDEA 的比对窗口）。
    changeMarksField,
    overviewLane,
    ...(jump ? [overviewJump.of(jump)] : []),
    // 光标只认读侧那一栏：左栏是基线，上下箭头的「还剩几处」不该跟着它走。
    ...(onCaret
      ? [EditorView.updateListener.of((update) => { if (update.selectionSet) onCaret(); })]
      : []),
    language.of(support ? [support] : []),
  ];
}

/**
 * 一处改动在某一栏里的行号范围。
 *
 * 并排看的时候两栏都要标：读侧是新增绿、改了蓝，改动里没有对应的那半（纯删 / 纯增）
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
    // 左栏里没有对应内容的，是真的被删掉了那一整段，画红条；其余都算改动。
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
  let mode = options.mode;
  /** 并排那台；单栏排法下是 null。 */
  let merge: MergeView | null = null;
  /** 读侧那一栏：并排时是右栏，单栏时就是唯一那一栏。上下箭头都按它的光标算。 */
  let read: EditorView;
  let chunks: readonly Chunk[] = [];
  let destroyed = false;
  /** 本轮建出来的那几栏：语法包迟到时要往它们身上补发。 */
  let panes: EditorView[] = [];
  let languageSlot: Compartment | null = null;

  const lineOf = (pos: number) => read.state.doc.lineAt(Math.min(pos, read.state.doc.length)).number;

  /** 光标之外还有没有起点比它晚 / 比它早的那一处。落在同一处里再按同方向不再走。 */
  function canGo(dir: DiffDir): boolean {
    if (chunks.length === 0) return false;
    const line = lineOf(read.state.selection.main.head);
    return chunks.some((chunk) =>
      dir === "next" ? lineOf(chunk.fromB) > line : lineOf(chunk.fromB) < line
    );
  }

  function reportNav(): void {
    if (destroyed) return;
    options.onNav?.({ count: chunks.length, previous: canGo("previous"), next: canGo("next") });
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
        behavior: "smooth",
      });
      return;
    }
    const target = Math.max(0, block.top - (view.scrollDOM.clientHeight - block.height) / 2);
    view.scrollDOM.scrollTo({ top: target, behavior: "smooth" });
  }

  function reveal(pos: number): void {
    revealFrom(read, pos);
  }

  /** 概览条点中一条：选中它、把外框滚过去。并排时两栏共用一个外框。 */
  function jumpFrom(view: EditorView, pos: number): void {
    view.dispatch({ selection: { anchor: pos } });
    revealFrom(view, pos);
    view.focus();
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

  function build(): void {
    const slot = new Compartment();
    languageSlot = slot;
    if (mode === "side") {
      merge = new MergeView({
        a: {
          doc: options.original,
          extensions: sideExtensions(options, options.numbers?.original, slot, undefined, jumpFrom),
        },
        b: {
          doc: options.modified,
          extensions: sideExtensions(options, options.numbers?.modified, slot, reportNav, jumpFrom),
        },
        parent: options.parent,
        collapseUnchanged: COLLAPSE,
        diffConfig: lineDiffConfig,
      });
      read = merge.b;
      chunks = merge.chunks;
      panes = [merge.a, merge.b];
      applyChangeMarks(merge.a, marksOf(chunks, "a", merge.a.state.doc));
      applyChangeMarks(merge.b, marksOf(chunks, "b", merge.b.state.doc));
    } else {
      merge = null;
      const state = EditorState.create({
        doc: options.modified,
        extensions: [
          ...sideExtensions(options, options.numbers?.modified, slot, reportNav, jumpFrom),
          unifiedMergeView({
            original: options.original,
            // 只读视图不给接受 / 拒绝那两颗按钮；改动色块与左侧那条缝照旧。
            mergeControls: false,
            collapseUnchanged: COLLAPSE,
            diffConfig: lineDiffConfig,
          }),
        ],
      });
      read = new EditorView({ state, parent: options.parent });
      chunks = getChunks(state)?.chunks ?? [];
      panes = [read];
      // 单栏只有读侧那一份正文，改动色带按它算。
      applyChangeMarks(read, marksOf(chunks, "b", read.state.doc));
    }

    // 语法包是异步的：第一次打开某门语言的比对时它还没进内存，`grammarSupport` 只能给 null，
    // 这篇就一直是素文本。等它到货再补一枪——不补的话「比对里没颜色」只在首次出现。
    const support = grammarSupport(options.language, pathExtension(options.path ?? ""));
    if (support) return;
    void loadGrammar(options.language, pathExtension(options.path ?? "")).then((loaded) => {
      if (!loaded || destroyed || languageSlot !== slot) return;
      for (const pane of panes) pane.dispatch({ effects: slot.reconfigure([loaded]) });
    });
  }

  /**
   * 收掉当前这一份。
   *
   * `MergeView.destroy()` 会把两栏一起收掉并摘掉外框，所以并排那一档不能再单独
   * destroy 读侧——读侧就是它手上的 `merge.b`。
   */
  function teardown(): void {
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
    destroy() {
      destroyed = true;
      teardown();
    },
  };
}
