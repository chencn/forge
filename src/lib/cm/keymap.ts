/**
 * 编辑器键位方案：设置里那三档（IntelliJ IDEA / VS Code / Eclipse）在 CodeMirror 上的落地，
 * 默认 IntelliJ IDEA。
 *
 * 三套完整来源表决定键位；只给有真实实现的动作注册处理器，不混入另一套默认方案。
 * IDE 专有的语义功能需要对应服务，不能拿不相干的编辑命令代替。
 *
 * 优先级用 `Prec.high`：这三档是「照着别的编辑器按」的，同名键必须盖过 CM 自带那套
 * （比如 Eclipse 的 Ctrl+Alt+Up 是多光标还是复制行，听方案的，不听引擎的）。
 */
import { startCompletion } from "@codemirror/autocomplete";
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  copyLineUp,
  indentSelection,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
  selectParentSyntax,
  selectLine,
  simplifySelection,
  toggleBlockComment,
  toggleLineComment,
  redo,
  undo,
} from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, Facet, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import * as commands from "@codemirror/commands";
import { findNext, findPrevious, gotoLine, SearchCursor, SearchQuery, setSearchQuery, getSearchQuery } from "@codemirror/search";
import { EditorView, ViewPlugin, keymap, type Command } from "@codemirror/view";
import type { KeymapScheme } from "../settings";
import { openFind } from "./find";
import { cmKey, presetKeys } from "../keymaps/idea";
import * as editing from "./editing";
import * as folding from "./folding";
import { cursorCodeBlockStart, cursorCodeBlockEnd, cursorMatchBrace, scrollToCenter, splitLine as ideaSplitLine } from "./caretCommands";
import { columnModeExtension, toggleColumnMode } from "./columnMode";
import { overwriteField, toggleOverwrite } from "./overwrite";
import { cyclicExpandWord } from "./wordCompletion";
import { changeMarksOf } from "./changeMarks";

/** 语言由文档装配，切换键位方案时不丢失；完成语句不能凭文件文本猜语言。 */
export const keymapLanguage = Facet.define<string, string>({ combine: (values) => values[0] ?? "plaintext" });

/** 只读文档上不该动的命令：按下去不算命中，让按键继续往下走。 */
function writable(command: Command): Command {
  return (view: EditorView) => (view.state.readOnly ? false : command(view));
}

/** 查找保持单行；替换入口才展开第二行，焦点仍在查找词上。 */
function find(replace: boolean): Command {
  return (view: EditorView) => openFind(view, replace);
}

/** 一条键位绑定：动作 id、CM 键名与实现命令。 */
interface Binding {
  action: string;
  key: string;
  command: Command;
  /** 只有查找/替换入口同时作用于搜索输入框，普通编辑键不能抢走输入框按键。 */
  scope?: string;
}

/** 扩大选区单独记住每一步，缩小时恢复原选区而不是直接丢掉所有次光标。 */
const selectionStep = StateEffect.define<readonly EditorSelection[]>();
/** 扩大选区各步的历史（StateField），供缩小选区逐步还原。 */
const selectionHistory = StateField.define<readonly EditorSelection[]>({
  create: () => [],
  update(history, transaction) {
    for (const effect of transaction.effects) if (effect.is(selectionStep)) {
      return effect.value;
    }
    return transaction.docChanged || transaction.selection ? [] : history;
  },
});
/** 扩大选区（Ctrl+W 一族）：沿语法结构向外扩，成功则记录一步历史。 */
const expandSelection: Command = (view) => {
  const previous = view.state.selection;
  const history = view.state.field(selectionHistory);
  if (!selectParentSyntax(view)) return false;
  if (!previous.eq(view.state.selection)) view.dispatch({ effects: selectionStep.of([...history, previous]) });
  return true;
};
/** 缩小选区（Shift+Ctrl+W）：按历史退回上一步选区。 */
const shrinkSelection: Command = (view) => {
  const history = view.state.field(selectionHistory);
  const previous = history.at(-1);
  if (!previous) return false;
  view.dispatch({ selection: previous, effects: selectionStep.of(history.slice(0, -1)), scrollIntoView: true });
  return true;
};

/** 出现处导航只移动主选区，不生成多光标。 */
function occurrence(backward: boolean): Command {
  return (view) => {
    const { state } = view;
    const range = state.selection.main;
    const word = range.empty ? state.wordAt(range.head) : range;
    if (!word) return false;
    const text = state.sliceDoc(word.from, word.to);
    const matches = [...new SearchCursor(state.doc, text)];
    const next = backward
      ? matches.filter((match) => match.to <= word.from).at(-1) ?? matches.at(-1)
      : matches.find((match) => match.from >= word.to) ?? matches[0];
    if (!next) return false;
    view.dispatch({ selection: { anchor: next.from, head: next.to }, scrollIntoView: true });
    return true;
  };
}

/** 按语法树查找方法，不把 Alt+上下错误地解释成移动代码行。 */
function method(backward: boolean): Command {
  return (view) => {
    const head = view.state.selection.main.head;
    const positions: number[] = [];
    syntaxTree(view.state).iterate({ enter(node) {
      if (/(?:Method|Function|Constructor)(?:Declaration|Definition)$/.test(node.name)) positions.push(node.from);
    } });
    const position = backward ? positions.filter((from) => from < head).at(-1) : positions.find((from) => from > head);
    if (position === undefined) return false;
    view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
    return true;
  };
}

/** 官方动作 id 对接真正的编辑行为；不存在处理器的语义动作不注册、不吞键。 */
export const IDEA_EDITOR_ACTIONS: Readonly<Record<string, Command>> = {
  EditorLeft: commands.cursorCharLeft,
  EditorRight: commands.cursorCharRight,
  EditorUp: commands.cursorLineUp,
  EditorDown: commands.cursorLineDown,
  EditorLeftWithSelection: commands.selectCharLeft,
  EditorRightWithSelection: commands.selectCharRight,
  EditorUpWithSelection: commands.selectLineUp,
  EditorDownWithSelection: commands.selectLineDown,
  EditorPreviousWord: commands.cursorGroupLeft,
  EditorNextWord: commands.cursorGroupRight,
  EditorPreviousWordWithSelection: commands.selectGroupLeft,
  EditorNextWordWithSelection: commands.selectGroupRight,
  EditorLineStart: commands.cursorLineStart,
  EditorLineEnd: commands.cursorLineEnd,
  EditorLineStartWithSelection: commands.selectLineStart,
  EditorLineEndWithSelection: commands.selectLineEnd,
  EditorTextStart: commands.cursorDocStart,
  EditorTextEnd: commands.cursorDocEnd,
  EditorTextStartWithSelection: commands.selectDocStart,
  EditorTextEndWithSelection: commands.selectDocEnd,
  EditorPageUp: commands.cursorPageUp,
  EditorPageDown: commands.cursorPageDown,
  EditorPageUpWithSelection: commands.selectPageUp,
  EditorPageDownWithSelection: commands.selectPageDown,
  EditorMoveToPageTop: viewportEdge(false, false),
  EditorMoveToPageBottom: viewportEdge(true, false),
  EditorMoveToPageTopWithSelection: viewportEdge(false, true),
  EditorMoveToPageBottomWithSelection: viewportEdge(true, true),
  EditorScrollUp: scrollLine(-1),
  EditorScrollDown: scrollLine(1),
  EditorBackSpace: writable(commands.deleteCharBackward),
  EditorDeleteToWordStart: writable(commands.deleteGroupBackward),
  EditorDeleteToWordEnd: writable(commands.deleteGroupForward),
  EditorEnter: writable(commands.insertNewlineAndIndent),
  EditorTab: writable(indentMore),
  EditorUnindentSelection: writable(indentLess),
  EditorEscape: simplifySelection,
  '$SelectAll': commands.selectAll,
  '$Delete': writable(commands.deleteCharForward),
  '$Undo': writable(undo),
  '$Redo': writable(redo),
  EditorDuplicate: editing.duplicateLineOrSelection,
  EditorDeleteLine: editing.deleteLine,
  EditorJoinLines: editing.joinLines,
  EditorToggleCase: editing.toggleCase,
  EditorStartNewLine: editing.startNewLine,
  EditorStartNewLineBefore: editing.startNewLineBefore,
  EditorSplitLine: ideaSplitLine,
  EditorCompleteStatement: (view) => editing.completeStatement(view.state.facet(keymapLanguage))(view),
  EditorSelectWord: expandSelection,
  EditorUnSelectWord: shrinkSelection,
  SelectNextOccurrence: editing.addCaretNextOccurrence,
  SelectAllOccurrences: editing.selectAllOccurrences,
  UnselectPreviousOccurrence: editing.unselectOccurrence,
  EditorAddCaretPerSelectedLine: editing.addCaretsToLineEnds,
  EditorScrollToCenter: scrollToCenter,
  EditorCodeBlockStart: cursorCodeBlockStart,
  EditorCodeBlockEnd: cursorCodeBlockEnd,
  EditorCodeBlockStartWithSelection: extendTo(cursorCodeBlockStart),
  EditorCodeBlockEndWithSelection: extendTo(cursorCodeBlockEnd),
  EditorMatchBrace: cursorMatchBrace,
  EditorToggleColumnMode: toggleColumnMode,
  EditorToggleInsertState: toggleOverwrite,
  MoveLineUp: writable(moveLineUp),
  MoveLineDown: writable(moveLineDown),
  MoveStatementUp: editing.moveStatementUp,
  MoveStatementDown: editing.moveStatementDown,
  MethodUp: method(true),
  MethodDown: method(false),
  NextOccurence: occurrence(false),
  PreviousOccurence: occurrence(true),
  CommentByLineComment: writable(toggleLineComment),
  CommentByBlockComment: writable(toggleBlockComment),
  AutoIndentLines: writable(indentSelection),
  CodeCompletion: startCompletion,
  HippieCompletion: (view) => { if (view.state.readOnly) return false; cyclicExpandWord(view, 'backward', () => []); return true; },
  HippieBackwardCompletion: (view) => { if (view.state.readOnly) return false; cyclicExpandWord(view, 'forward', () => []); return true; },
  Find: find(false),
  Replace: find(true),
  FindNext: findNext,
  FindPrevious: findPrevious,
  FindWordAtCaret: findWord(false),
  FindPrevWordAtCaret: findWord(true),
  CollapseRegion: folding.foldAtCaret,
  ExpandRegion: folding.unfoldAtCaret,
  CollapseAllRegions: folding.collapseAll,
  ExpandAllRegions: folding.expandAll,
  CollapseRegionRecursively: folding.collapseRecursively,
  ExpandRegionRecursively: folding.expandRecursively,
  CollapseSelection: folding.foldSelection,
  GotoLine: gotoLine,
  VcsShowNextChangeMarker: changeMarker(false),
  VcsShowPrevChangeMarker: changeMarker(true),
};

/** 页顶/页底使用可见范围，不把 Ctrl+PageUp 错绑成再翻一页。 */
function viewportEdge(bottom: boolean, extend: boolean): Command {
  return (view) => {
    const box = view.scrollDOM.getBoundingClientRect();
    const height = (bottom ? box.bottom : box.top) - view.documentTop;
    const line = view.lineBlockAtHeight(Math.max(0, height));
    const head = bottom ? line.to : line.from;
    view.dispatch({ selection: extend ? EditorSelection.range(view.state.selection.main.anchor, head) : EditorSelection.cursor(head), scrollIntoView: true });
    return true;
  };
}
/** 滚动一行（不挪光标）；direction 为 ±1。 */
function scrollLine(direction: number): Command {
  return (view) => { view.scrollDOM.scrollTop += direction * view.defaultLineHeight; return true; };
}
/** 把命令包成「移动后延伸选区到新 head」的形式。 */
function extendTo(command: Command): Command {
  return (view) => {
    const anchor = view.state.selection.main.anchor;
    if (!command(view)) return false;
    view.dispatch({ selection: { anchor, head: view.state.selection.main.head }, scrollIntoView: true });
    return true;
  };
}
/** 查找光标所在（或选中的）词的下一处/上一处。 */
function findWord(backward: boolean): Command {
  return (view) => {
    const range = view.state.selection.main;
    const word = range.empty ? view.state.wordAt(range.head) : range;
    if (!word) return false;
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: view.state.sliceDoc(word.from, word.to), literal: true })) });
    return backward ? findPrevious(view) : findNext(view);
  };
}
/** 跳到上一处/下一处改动标记（变更条）。 */
function changeMarker(backward: boolean): Command {
  return (view) => {
    const head = view.state.selection.main.head;
    const positions = changeMarksOf(view.state).map((mark) => view.state.doc.line(Math.min(mark.startLine, view.state.doc.lines)).from);
    const target = backward ? positions.filter((pos) => pos < head).at(-1) : positions.find((pos) => pos > head);
    if (target === undefined) return false;
    view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
    return true;
  };
}

/** 同一个动作实现服务于三套完整方案，方案只负责键位，不复制动作。 */
function bindingsFor(scheme: KeymapScheme): Binding[] {
  const actions: Record<string, Command> = {
    ...IDEA_EDITOR_ACTIONS,
    EditorDuplicateLines: writable(copyLineDown),
    EditorDuplicateLinesUp: writable(copyLineUp),
    EditorIndentLineOrSelection: writable(indentMore),
    EditorIndentSelection: writable(indentMore),
    EditorSelectLine: selectLine,
    EditorCloneCaretAbove: addCursorAbove,
    EditorCloneCaretBelow: addCursorBelow,
    EditorDeleteToLineEnd: writable(commands.deleteToLineEnd),
    SmartUnSelect: shrinkSelection,
    CommentLine: writable(commands.lineComment),
    UncommentLine: writable(commands.lineUncomment),
  };
  if (scheme === 'eclipse') {
    actions.Find = find(true);
    actions.FindNext = (view) => getSearchQuery(view.state).search ? findNext(view) : occurrence(false)(view);
    actions.FindPrevious = (view) => getSearchQuery(view.state).search ? findPrevious(view) : occurrence(true)(view);
  }
  return [...new Map(Object.entries(actions).flatMap(([id, command]) => presetKeys(scheme, id).map((binding) => {
    const key = cmKey(binding);
    return [key, { action: id, key, command, scope: ['Find', 'Replace'].includes(id) ? 'editor search-panel' : undefined }] as const;
  }))).values()];
}
/** 三套方案的绑定总表（构建时一次算好）。 */
const BINDINGS: Record<KeymapScheme, Binding[]> = {
  idea: bindingsFor('idea'), vscode: bindingsFor('vscode'), eclipse: bindingsFor('eclipse'),
};

/** 导出三张表只为让测试能逐条检查键名——绑错名字不会报错，只会变成一条死键。 */
export function keymapBindings(): Array<[KeymapScheme, Binding[]]> {
  return Object.entries(BINDINGS) as Array<[KeymapScheme, Binding[]]>;
}

/** 编辑器的完整键位扩展：状态字段 + 方案绑定 + 通用兜底键。 */
export function forgeKeymap(scheme: KeymapScheme): Extension {
  const bindings = BINDINGS[scheme];
  return [selectionHistory, editing.occurrenceSearch, overwriteField, columnModeExtension, ...(scheme === "idea" ? [Prec.highest(cloneCarets)] : []), Prec.high(keymap.of([
    ...bindings.map((binding) => ({ key: binding.key, run: binding.command, scope: binding.scope })),
    // 查找输入框使用独立作用域；正文里的 Ctrl+G 仍按所选方案执行。
    { key: "F3", run: findNext, shift: findPrevious, scope: "search-panel", preventDefault: true },
    { key: "Mod-g", run: findNext, shift: findPrevious, scope: "search-panel", preventDefault: true },
    { key: "Escape", run: simplifySelection },
    // 工作区撤销在 cmEditor 中以更高优先级处理，普通撤销仍须可独立使用。
    { key: "Mod-z", run: writable(undo) },
    { key: "Tab", run: writable(indentMore), shift: writable(indentLess) },
  ]))];
}

/** IDEA 的双击 Ctrl 克隆光标：Ctrl 松开 500ms 内再按（无修饰键）则武装，随后↑↓加光标。 */
const cloneCarets = ViewPlugin.fromClass(class {
  releasedAt = -Infinity;
  armed = false;
}, { eventHandlers: {
  keydown(event, view) {
    if (event.isComposing) { this.armed = false; return false; }
    if (event.key === 'Control' && !event.repeat) {
      this.armed = !event.altKey && !event.shiftKey && !event.metaKey && event.timeStamp - this.releasedAt < 500;
      return false;
    }
    if (this.armed && event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      if (event.key === 'ArrowUp') return addCursorAbove(view);
      if (event.key === 'ArrowDown') return addCursorBelow(view);
    }
    this.armed = false;
    this.releasedAt = -Infinity;
    return false;
  },
  keyup(event) {
    if (event.key === 'Control') { this.releasedAt = event.timeStamp; this.armed = false; }
    return false;
  },
  blur() { this.armed = false; this.releasedAt = -Infinity; return false; },
} });
