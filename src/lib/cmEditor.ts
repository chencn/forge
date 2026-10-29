/**
 * 编辑器引擎的唯一归属：组件要用 CodeMirror 的任何东西都从这里引，
 * 不许在组件里直接 import `@codemirror/*`——要什么从这里再走一遍。
 *
 * 一篇文档对应一个常驻的 `EditorState`（放在 {@link held} 里），不是对应一台编辑器：
 * 没在屏幕上的页签不挂载视图，撤销栈、光标、滚动位置都留在表里，切回来原样复现。
 * 打字之后的 state 由 {@link captureState} 收回来，表里那份必须始终等于屏幕上那份。
 */
import {
  Compartment,
  EditorSelection,
  EditorState,
  Facet,
  Prec,
  RangeSetBuilder,
  StateEffect,
  Transaction,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  Decoration,
  drawSelection,
  dropCursor,
  GutterMarker,
  gutterLineClass,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  type LanguageSupport,
} from "@codemirror/language";
import { lintGutter, lintKeymap } from "@codemirror/lint";
import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { showMinimap, type MinimapConfig } from "@replit/codemirror-minimap";
import { samePath } from "./format";
import { registerRetentionSweep } from "./modelRetention";
import { attachEditorBridge } from "./editorEnv";
import { cmPhrases } from "./cm/phrases";
import { grammarSupport, loadGrammar, pathExtension } from "./cm/grammars";
import { forgeHighlightStyle } from "./cm/highlight";
import { indentGuides } from "./cm/indentGuides";
import { rainbowBrackets } from "./cm/rainbowBrackets";
import { forgeTheme } from "./cm/theme";
import { changeMarksField } from "./cm/changeMarks";
import { overviewLane } from "./cm/overview";

export { EditorState, EditorView };
export type { Extension, Transaction };

/** 磁盘上的行尾风格，与 `OpenDocument.lineEnding` 同一档。 */
export type LineEnding = "crlf" | "lf";

/** 编辑器要认识的文档字段；`OpenDocument` 是它的超集，组件直接传整份过来。 */
export interface EditorDoc {
  path: string;
  contents: string;
  /** 语言 id，沿用 lib/editorEnv.ts 那张表：认得出就上语法，认不出就是纯文本。 */
  language: string;
  readOnly: boolean;
  tabSize: number;
  /**
   * 行号怎么写。默认就是行下标；补丁预览里模型从 1 起数、真实文件行号在外面，
   * 得由调用方给（hunk 之间跳过的区间不占号，不是加一个偏移就完事）。
   */
  lineNumberFormat?: (line: number) => string;
  /** 给 false 就整条行号栏都不要：预览的那段不知道从文件第几行起，编号会误导。 */
  showLineNumbers?: boolean;
}

/**
 * 这篇 state 属于哪个文件、配的是哪门语言。
 *
 * 得做成 facet 而不是外挂一张 WeakMap：`state.update()` 每次都产出新对象，
 * 打一个字外挂表就认不出手上这份了。facet 跟着配置走，正文怎么改都在。
 */
const pathFacet = Facet.define<string, string>({ combine: (values) => values[0] ?? "" });
const languageFacet = Facet.define<string, string>({ combine: (values) => values[0] ?? "" });
const supportFacet = Facet.define<LanguageSupport | null, LanguageSupport | null>({
  combine: (values) => values.length ? values[0] : null,
});

const languageSlot = new Compartment();
const readOnlySlot = new Compartment();
const tabSlot = new Compartment();
const minimapSlot = new Compartment();
const keymapSlot = new Compartment();

// ---------------------------------------------------------------- 行尾

/**
 * 磁盘正文换成编辑器里那份。
 *
 * CodeMirror 的文档只存 `\n`：`EditorState.create` 与每一次改动派发都会先把 `\r\n`、
 * 落单的 `\r` 折成 `\n`。原来 Monaco 用 `model.setEOL()` 把这层包在引擎里，这里没人包，
 * 于是「拿磁盘正文和编辑器正文直接比」永远对不上——每跑一遍正文同步就把整篇重换一次，
 * 撤销栈被一层假改动压满。换算只能放在这一层，且进出各一次。
 */
export function fromDiskText(contents: string): string {
  return contents.includes("\r") ? contents.replace(/\r\n?/g, "\n") : contents;
}

/** 编辑器正文换回磁盘那份的行尾；`crlf` 之外的值按原样交回（后端写文件时还会再归一次）。 */
export function toDiskText(text: string, lineEnding: LineEnding): string {
  return lineEnding === "crlf" && text.includes("\n") ? text.replace(/\n/g, "\r\n") : text;
}

// ---------------------------------------------------------------- 语法

/**
 * 同步拿当前可用的语法；还没加载完时返回 null，正文先按纯文本排。
 * 加载完成由调用方在 {@link loadLanguage} 落定后重新配一次。
 *
 * 判定与聊天、md 预览共用 `cm/grammars` 那一张表：同一篇正文在编辑器里和在被复制进聊天的
 * 代码块里必须是同一套 token，两处各写各的表迟早对不上。`path` 只用来纠 tsx/jsx——
 * 语言 id 表里那两门记成 typescript/javascript（那是给 tsserver 用的），语法却是另一套。
 */
export function languageOf(id: string, path = ""): LanguageSupport | null {
  return grammarSupport(id, pathExtension(path));
}

/** 装上这篇文档要的语法；落定后由调用方重配一次 state。 */
export function loadLanguage(id: string, path = ""): Promise<LanguageSupport | null> {
  return loadGrammar(id, pathExtension(path));
}

function languageExtensions(doc: EditorDoc): Extension[] {
  const support = languageOf(doc.language, doc.path);
  return [languageFacet.of(doc.language), supportFacet.of(support), pathFacet.of(doc.path), ...(support ? [support] : [])];
}

// 改动标记（行号右边的色带、右侧概览条、小地图色带）在 ./cm/changeMarks.ts，这里只做门面。
export { applyChangeMarks, changeMarksOf, minimapGutters, type ChangeMark } from "./cm/changeMarks";

/**
 * 小地图那一格。
 *
 * 必须跟着 state 一起建：库的行表（`LinesState`）只在 `docChanged` 或折叠变化时重算，
 * 而 `enables` 挂上的字段在**事后**用 compartment 或 `appendConfig` 加进来时，
 * 创建那一刻读到的配置还是「关」，行表于是永远空着——画布画出来是全白的。
 * 实测：建 state 时带配置 → 有内容；之后再加 → 空白，直到敲一下键盘。
 */
export function minimapExtension(config: MinimapConfig | null): Extension {
  return showMinimap.of(config);
}

/**
 * 逼小地图重算行表。
 *
 * 只在小地图从「关」切到「开」时用：那一刻行表是空的（见 {@link minimapExtension}），
 * 而库只认文档改动与折叠变化。这里补一对「插一个零宽空格、再删掉」的改动：
 * 净正文不变，`addToHistory: false` 不进撤销栈，两笔在同一批里走完。
 */
export function primeMinimap(view: EditorView): void {
  const noHistory = Transaction.addToHistory.of(false);
  view.dispatch(
    { changes: { from: 0, insert: "\u200b" }, annotations: [noHistory] },
    { changes: { from: 0, to: 1 }, annotations: [noHistory] }
  );
}

// ---------------------------------------------------------------- 装配

/**
 * 空选区按 Ctrl+C 复制整行。IDEA、VS Code 与原来 Monaco 那版都是这行为：光标停在哪，
 * 那一行就是「要复制的东西」，不必先划选。有选区时原样交给浏览器。
 *
 * 走 `copy` 事件里的 `clipboardData.setData`，而不是绑 Mod-c：绑键就得拦默认行为，
 * 一拦会把有选区那次正常复制一起弄坏；而且多光标要按 IDEA 的口径一次复制好几行，
 * 原生那条路给不了。
 */
const copyLineOnEmpty = EditorView.domEventHandlers({
  copy(event, view) {
    const ranges = view.state.selection.ranges;
    if (!event.clipboardData || !ranges.every((range) => range.empty)) return false;
    const lines: string[] = [];
    let previous = 0;
    for (const range of ranges) {
      const line = view.state.doc.lineAt(range.head);
      if (line.number === previous) continue;
      previous = line.number;
      lines.push(line.text);
    }
    // 末尾补一个换行：粘出去的是「一整行」，跟 IDEA 一样落在光标所在行的下一行之上。
    event.clipboardData.setData("text/plain", `${lines.join("\n")}\n`);
    event.preventDefault();
    return true;
  },
});

/**
 * 折叠扣：细线小箭头，平时收着，鼠标进装订线才露出来（IDEA 和模范项目都是这个路数）。
 * 用 SVG 不用字符：`⌄` / `›` 在不同字体下胖瘦差得太多。
 */
function foldChevron(open: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = open ? "cm-fold-open" : "cm-fold-closed";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({
    width: "9",
    height: "9",
    viewBox: "0 0 9 9",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1",
    "stroke-linecap": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(name, value);
  }
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", open ? "M8 2.75 4.5 6.25 1 2.75" : "M3 8 6.5 4.5 3 1");
  svg.appendChild(path);
  span.appendChild(svg);
  return span;
}

function baseExtensions(doc: EditorDoc, extra: Extension[]): Extension[] {
  const format = doc.lineNumberFormat;
  const numbers =
    doc.showLineNumbers === false ? [] : format ? [lineNumbers({ formatNumber: (line) => format(line) })] : [lineNumbers()];
  return [
    // 查找条、跳转行、折叠、问题面板的文案：引擎里那些是写死的英文原串，这张表是唯一的翻译入口。
    EditorState.phrases.of(cmPhrases),
    ...numbers,
    // 改动色带紧跟行号（IDEA 的位置）；折叠扣压到最右，别插到两者中间。
    changeMarksField,
    // 右侧滚动条那条改动色带（IDEA 的错误条位置），点一下跳到那一行。
    overviewLane,
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    Prec.lowest(foldGutter({ markerDOM: foldChevron })),
    codeFolding(),
    // 出问题的行在行号左边点一颗标志；同 IDEA 那条红色波浪线旁边的记号。
    lintGutter(),
    // 光标闪烁的样式统一在 styles.css：跟终端光标同一条淡入淡出（见 `forge-caret-blink`）。
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    // 缩进参考线：Monaco 默认就画，换了引擎得自己带上（这一版 CodeMirror 没有内置）。
    indentGuides,
    // 括号按嵌套深度上色：IDEA 默认就是这样，只影视口，几千行的文件也扛得住。
    rainbowBrackets(),
    highlightSelectionMatches(),
    copyLineOnEmpty,
    // 补全浮层由 lib/cm/lsp.ts 那组装配（它要给候选列表装 LSP 那一路的来源），这里只留按键。
    syntaxHighlighting(forgeHighlightStyle),
    forgeTheme,
    languageSlot.of(languageExtensions(doc)),
    readOnlySlot.of([EditorState.readOnly.of(doc.readOnly), EditorView.editable.of(!doc.readOnly)]),
    tabSlot.of([EditorState.tabSize.of(doc.tabSize), indentUnit.of(" ".repeat(doc.tabSize))]),
    // 默认不挂小地图：配置要随系统设置与改动标记变，由组件用 setMinimap 现派发。
    minimapSlot.of(showMinimap.of(null)),
    // 键位方案同理：换了方案不该把整台编辑器重配，只要换这一格。
    keymapSlot.of([]),
    ...extra,
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...completionKeymap,
      // 折叠扣与问题导航属于引擎能力，三套键位方案都不该把它们换掉；
      // 方案里另有同名键时由 `Prec.high` 压过这里（见 cm/keymap.ts）。
      ...foldKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
  ];
}

// ---------------------------------------------------------------- 常驻 state

/** 文档 → 常驻 state：撤销栈与正文都在这份里，没在屏幕上也不丢。 */
const held = new Map<string, EditorState>();
/**
 * 光标与滚动位置单独一张表，不塞进 state 旁边。
 *
 * 超限回收（{@link pruneToRecent}）会把 state 丢掉省内存，但切回那篇时光标还得在原处——
 * 和原来 Monaco 那版的 `viewStateByPath` 是同一条取舍。
 */
interface ViewMarks {
  ranges: Array<{ anchor: number; head: number }>;
  scrollTop: number;
  scrollLeft: number;
}
const viewByPath = new Map<string, ViewMarks>();
/** 此刻挂在屏幕上的编辑器，按路径找。 */
const mounted = new Map<string, EditorView>();

export function setMounted(path: string, view: EditorView | null): void {
  if (view) mounted.set(path, view);
  else mounted.delete(path);
}

export function editorFor(path: string): EditorView | null {
  for (const [key, view] of mounted) if (samePath(key, path)) return view;
  return null;
}

/**
 * 取这篇文档的 state，没有就建一个。
 *
 * 语言、只读、tab 宽这三样变了才重配；正文不在这里动（走 {@link syncText}）。
 * 语法是异步装进来的，装好之后语言 id 没变但 `languageOf` 有值了，靠 supportFacet 比出来。
 */
export function stateFor(doc: EditorDoc, extra: Extension[] = []): EditorState {
  const state = held.get(doc.path);
  if (!state) {
    const created = EditorState.create({ doc: fromDiskText(doc.contents), extensions: baseExtensions(doc, extra) });
    held.set(doc.path, created);
    return created;
  }
  const effects: StateEffect<unknown>[] = [];
  if (state.facet(languageFacet) !== doc.language || state.facet(supportFacet) !== languageOf(doc.language, doc.path)) {
    effects.push(languageSlot.reconfigure(languageExtensions(doc)));
  }
  if (state.readOnly !== doc.readOnly) {
    effects.push(readOnlySlot.reconfigure([EditorState.readOnly.of(doc.readOnly), EditorView.editable.of(!doc.readOnly)]));
  }
  if (state.tabSize !== doc.tabSize) {
    effects.push(tabSlot.reconfigure([EditorState.tabSize.of(doc.tabSize), indentUnit.of(" ".repeat(doc.tabSize))]));
  }
  if (!effects.length) return state;
  const next = state.update({ effects }).state;
  held.set(doc.path, next);
  return next;
}

/** 这篇 state 是哪份文档的。 */
export function pathOf(state: EditorState): string {
  return state.facet(pathFacet);
}

/**
 * 没打开任何文件时编辑器挂的那一份：只读、没有路径、不进常驻表。
 *
 * 不这么处理的话得给空态编一个假路径，于是每个回调都要多判一次「是不是那个假路径」。
 */
export function emptyState(extra: Extension[] = []): EditorState {
  return EditorState.create({
    doc: "",
    extensions: baseExtensions({ path: "", contents: "", language: "", readOnly: true, tabSize: 4 }, extra),
  });
}

/**
 * 不进常驻表的一份 state：比对、AI 预览、合并对话框里那些「正文不在磁盘上」的编辑器用它。
 *
 * 这类正文跟着对话框或那张卡片一起活，换内容就重挂，不该占住路径那格——占住了会把
 * 工作区里同路径那篇的撤销栈和光标位置一起顶掉。
 */
export function detachedState(doc: EditorDoc, extra: Extension[] = []): EditorState {
  return EditorState.create({
    doc: fromDiskText(doc.contents),
    extensions: baseExtensions(doc, extra),
  });
}

/** 只给 elementClass：gutterLineClass 要的就是这个，带 toDOM 的标记会串进别的槽。 */
class MarkStrip extends GutterMarker {
  constructor(className: string) {
    super();
    this.elementClass = className;
  }
}

/**
 * 给一段整行上色，并在行号那一栏留一条竖标：AI 读过的那一段在预览里要看得出来。
 *
 * 行号按当前正文计，超出文档的行数收在最后一行。
 */
export function highlightRange(startLine: number, endLine: number): Extension {
  return [
    // 槽只认行首那个点：按行号当偏移给区间，一行都画不出来（同改动色带那里的口径）。
    gutterLineClass.compute(["doc"], (state) => {
      const mark = new MarkStrip("ai-file-read-gutter");
      const builder = new RangeSetBuilder<GutterMarker>();
      const lines = state.doc.lines;
      const start = Math.min(Math.max(1, startLine), lines);
      const end = Math.min(Math.max(start, endLine), lines);
      for (let line = start; line <= end; line += 1) {
        const at = state.doc.line(line).from;
        builder.add(at, at, mark);
      }
      return builder.finish();
    }),
    EditorView.decorations.of((view) => {
      const lines = view.state.doc.lines;
      const from = view.state.doc.line(Math.min(Math.max(1, startLine), lines)).from;
      const to = view.state.doc.line(Math.min(Math.max(1, endLine), lines)).to;
      return Decoration.set([Decoration.line({ class: "ai-file-read-highlight" }).range(from, to)]);
    }),
  ];
}

/**
 * 挂上或收掉小地图。
 *
 * 每次都重配而不是让 `showMinimap` 自己按 doc 重算：开关跟着系统设置变、色带跟着改动
 * 标记变，这两样都不产生正文变化，按 doc 算的那套依赖等不到重算的时机。
 */
export function setMinimap(view: EditorView, config: MinimapConfig | null): void {
  view.dispatch({ effects: minimapSlot.reconfigure(showMinimap.of(config)) });
}

/** 这一台此刻挂着的小地图配置；没挂是 null。用来分辨「从关到开」那一步。 */
export function minimapConfigOf(view: EditorView): MinimapConfig | null {
  return view.state.facet(showMinimap) ?? null;
}

/** 换一套键位方案（`cm/keymap` 按设置里那三档算出来的那组绑定）。 */
export function setKeymap(view: EditorView, scheme: Extension): void {
  view.dispatch({ effects: keymapSlot.reconfigure(scheme) });
}


/** 这篇 state 当时配的是哪门语言——LSP 按它选服务，也用它判断「配置换了没有」。 */
export function languageIdOf(state: EditorState): string {
  return state.facet(languageFacet);
}

/**
 * 正文从外部变了（保存回写、磁盘重载、换文档）时整篇换上。
 *
 * 一样时返回 null 什么都不发——切页签回来正文没变，不该把撤销栈压一层「改了个寂寞」。
 * 比之前先归一行尾：传进来的多是磁盘那份 CRLF，而编辑器里只有 `\n`，不归一就是每次都不 equal。
 */
export function textReplacement(state: EditorState, contents: string): Transaction | null {
  const text = fromDiskText(contents);
  if (state.doc.toString() === text) return null;
  return state.update({ changes: { from: 0, to: state.doc.length, insert: text } });
}

/** 打字之后把视图的当前 state 收进表里。 */
export function captureState(view: EditorView): void {
  const path = pathOf(view.state);
  if (path) held.set(path, view.state);
}

/** 卸载视图前存光标与滚动位置。 */
export function persistView(path: string, view: EditorView): void {
  viewByPath.set(path, {
    ranges: view.state.selection.ranges.map((range) => ({ anchor: range.anchor, head: range.head })),
    scrollTop: view.scrollDOM.scrollTop,
    scrollLeft: view.scrollDOM.scrollLeft,
  });
}

/** 挂载后贴回上次的光标与滚动位置；没存过就停在文档开头。 */
export function restoreView(path: string, view: EditorView): void {
  const marks = viewByPath.get(path);
  if (!marks) return;
  if (marks.ranges.length) {
    const length = view.state.doc.length;
    view.dispatch({
      selection: EditorSelection.create(
        marks.ranges
          .filter((range) => range.anchor <= length && range.head <= length)
          .map((range) => EditorSelection.range(range.anchor, range.head))
      ),
    });
  }
  view.scrollDOM.scrollTop = marks.scrollTop;
  view.scrollDOM.scrollLeft = marks.scrollLeft;
}

/** 关掉这篇文档：撤销栈与光标一起丢。 */
export function disposeModel(path: string): void {
  for (const key of Array.from(held.keys())) {
    if (samePath(key, path)) held.delete(key);
  }
  for (const key of Array.from(viewByPath.keys())) {
    if (samePath(key, path)) viewByPath.delete(key);
  }
}

/**
 * 最近没在看的那几篇只丢 state，光标位置留在 `viewByPath` 里。
 *
 * 名单由 `modelRetention` 算好递进来（它在 DocPane 每个渲染周期跑一次）。正看着的那篇
 * 恒在名单首位，所以这里不会把屏幕上的编辑器抽走。丢的那篇切回来时正文由 `useDocuments`
 * 供上，撤销栈没了、光标还在——和原来 Monaco 那版的取舍一致。
 */
function pruneToRecent(keep: readonly string[], openPaths: readonly string[]): void {
  for (const key of Array.from(held.keys())) {
    if (!openPaths.some((item) => samePath(item, key))) continue;
    if (keep.some((item) => samePath(item, key))) continue;
    held.delete(key);
  }
}

registerRetentionSweep(pruneToRecent);

// ---------------------------------------------------------------- 读写与定位

export function textOf(view: EditorView): string {
  return view.state.doc.toString();
}

export function lineText(state: EditorState, line: number): string {
  if (line < 1 || line > state.doc.lines) return "";
  return state.doc.line(line).text;
}

/** 当前选区；没有选东西时返回 null。 */
export function selectedRange(view: EditorView): { from: number; to: number; line: number; endLine: number } | null {
  const range = view.state.selection.main;
  if (range.empty) return null;
  const start = view.state.doc.lineAt(range.from);
  const end = view.state.doc.lineAt(range.to);
  return {
    from: range.from,
    to: range.to,
    line: start.number,
    // 选到下一行第 1 列时并不真的包含下一行正文，引用范围不能虚增一行。
    endLine: range.to === end.from && end.number > start.number ? end.number - 1 : end.number,
  };
}

export function selectedText(view: EditorView): string {
  return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
}

export function selectAll(view: EditorView): void {
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
}

/** 右键菜单的剪切/粘贴落进文档；`userEvent` 让撤销栈把这一步当成一次输入。 */
export function replaceRange(view: EditorView, from: number, to: number, text: string): void {
  const insert = fromDiskText(text);
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input.paste" });
}

export function scrollRatio(view: EditorView): number {
  const max = view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight;
  return max > 0 ? view.scrollDOM.scrollTop / max : 0;
}

export function setScrollRatio(view: EditorView, ratio: number): void {
  const max = view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight;
  if (max > 0) view.scrollDOM.scrollTop = Math.round(ratio * max);
}

/**
 * 把某个位置滚到视口中间，平滑滚动。
 *
 * 原来 Monaco 开着 `smoothScrolling`，搜索命中、小地图跳转都是滑过去的；CodeMirror 的
 * `scrollIntoView` 直接改 `scrollTop`，一跳就到。落点自己算（行顶减去半屏），比给
 * `.cm-scroller` 整条挂 `scroll-behavior: smooth` 好——那样连打字时把光标滚进视野
 * 也会跟着滑，敲一行字光标就一直追动画。
 */
export function scrollToPos(view: EditorView, pos: number): void {
  const block = view.lineBlockAt(Math.min(Math.max(0, pos), view.state.doc.length));
  const target = Math.max(0, block.top - (view.scrollDOM.clientHeight - block.height) / 2);
  view.scrollDOM.scrollTo({ top: target, behavior: "smooth" });
}

/** 跳到某一行并选中一段；行号超出文档时收在最后一行，不抛。 */
export function revealRange(view: EditorView, line: number, from: number, to: number): void {
  const target = Math.min(Math.max(1, line), view.state.doc.lines);
  const start = view.state.doc.line(target);
  view.dispatch({ selection: { anchor: start.from + from, head: start.from + to } });
  scrollToPos(view, start.from);
  view.focus();
}

/**
 * 第 `line` 行的顶部在**文档坐标**里的位置（从内容顶算起，不含滚动量）。
 *
 * 装订线那颗 ▶ 挂在行号槽里，跟着内容一起滚，所以要的是文档坐标；
 * `coordsAtPos` 对没渲染的行给的是假值，`lineBlockAt` 才算得出来。
 */
export function lineTop(view: EditorView, line: number): number | null {
  if (line < 1 || line > view.state.doc.lines) return null;
  return view.lineBlockAt(view.state.doc.line(line).from).top;
}

/**
 * 行号槽那一层。
 *
 * `setState`（换文档、语法包加载完重配）会把整层 `.cm-gutters` 拆掉重造，所以**不能存着**：
 * 每次要用都现查。挂在上面的东西（▶ 那层）会跟着旧节点一起脱开文档，表现就是一颗都不显示。
 */
export function gutterHost(view: EditorView): HTMLElement | null {
  return view.scrollDOM.querySelector<HTMLElement>(".cm-gutters");
}

/** 行号槽的宽度：▶ 摆进行号与代码之间那条带，靠这个算左缘。 */
export function gutterWidth(view: EditorView): number {
  return gutterHost(view)?.getBoundingClientRect().width ?? 0;
}

// ---------------------------------------------------------------- 保存与偏好

/** Ctrl+S 交回应用的保存，不落在引擎自己的按键表里。 */
export function saveKeymap(onSave: () => void): Extension {
  return keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (onSave(), true) }]);
}

/**
 * 字号与行高不进主题对象：宿主元素上写两个自定义属性，主题按 var() 取，
 * 改设置只换属性，不重建主题也不重配 state。
 *
 * 行高跟着字号走：原来 Monaco 那版写死 20px，字号调到 20 以上字就挤在一起。
 * 13px 时仍然正好折算成 20px，默认观感不变。
 */
export function applyFontMetrics(host: HTMLElement, fontSize: number): void {
  host.style.setProperty("--editor-font-size", `${fontSize}px`);
  host.style.setProperty("--editor-line-height", `${Math.round(fontSize * 1.538)}px`);
}

/**
 * 挂进应用那侧的门面：关标签释放 state、搜索预填取当前选区。
 *
 * 语言显示名不在这里——引擎没有自己的别名表，用 editorEnv 那一份静态表。
 */
attachEditorBridge({
  disposeModel,
  selectedText: (limit: number) => {
    for (const view of mounted.values()) {
      if (!view.hasFocus) continue;
      const text = selectedText(view);
      if (text) return text.slice(0, limit);
    }
    return "";
  },
});
