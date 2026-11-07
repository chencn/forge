/**
 * 编辑器的实际编辑行为（复用 @codemirror/commands 的命令原语），键位由方案表提供。
 *
 * @remarks 命令不含键位绑定——绑定走方案表
 */
import {
  EditorSelection,
  StateEffect,
  StateField,
  countColumn,
  type ChangeSpec,
  type EditorState,
  type SelectionRange,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, type Command } from "@codemirror/view";
import {
  foldedRanges,
  forceParsing,
  syntaxTree,
  getIndentUnit,
  indentString,
  getIndentation,
} from "@codemirror/language";
import {
  copyLineDown,
  deleteLine as deleteDocLine,
  insertNewlineAndIndent,
  moveLineDown,
  moveLineUp,
} from "@codemirror/commands";
import { SearchCursor } from "@codemirror/search";

/** 语法树节点类型（SyntaxNode）的简写。 */
type Node = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

// --- 行 / 选区 ---------------------------------------------------------------

/**
 * `[from, to]` 触及的整行，扩到它们所在的可见行：折叠区里的行连同展示它的那一行一起算。
 */
export function visualLineSpan(state: EditorState, from: number, to: number): { from: number; to: number } {
  let a = state.doc.lineAt(from).from;
  let b = state.doc.lineAt(to).to;
  const folded = foldedRanges(state);
  for (let changed = true; changed;) {
    changed = false;
    folded.between(a, b, (f, t) => {
      const na = Math.min(a, state.doc.lineAt(f).from);
      const nb = Math.max(b, state.doc.lineAt(t).to);
      if (na !== a || nb !== b) {
        a = na;
        b = nb;
        changed = true;
      }
    });
  }
  return { from: a, to: b };
}

/** 选区各范围的可见行跨度，合并相邻；不涉及折叠时返回 `null`（调用方直接走库命令）。 */
function foldedLineSpans(state: EditorState): Array<{ from: number; to: number }> | null {
  const spans: Array<{ from: number; to: number }> = [];
  let folds = false;
  for (const r of state.selection.ranges) {
    const end = r.to > r.from && state.doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to;
    const span = visualLineSpan(state, r.from, end);
    if (span.from !== state.doc.lineAt(r.from).from || span.to !== state.doc.lineAt(end).to) folds = true;
    const last = spans[spans.length - 1];
    if (last && span.from <= last.to + 1) last.to = Math.max(last.to, span.to);
    else spans.push(span);
  }
  return folds ? spans : null;
}

/** ⌘D：复制行（光标落到副本上）或复制选区（副本贴在选中内容后）。 */
export const duplicateLineOrSelection: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  if (state.selection.ranges.every((r) => r.empty)) {
    const spans = foldedLineSpans(state);
    if (!spans) return copyLineDown(view);
    // 折叠区所在行被复制时，整个折叠块一起复制。
    const changes = state.changes(
      spans.map((s) => ({ from: s.to, insert: state.lineBreak + state.sliceDoc(s.from, s.to) })),
    );
    const ranges = state.selection.ranges.map((r) => {
      const s = spans.find((sp) => sp.from <= r.head && r.head <= sp.to)!;
      return EditorSelection.cursor(changes.mapPos(r.head, -1) + s.to - s.from + state.lineBreak.length);
    });
    view.dispatch({
      changes,
      selection: EditorSelection.create(ranges, state.selection.mainIndex),
      scrollIntoView: true,
      userEvent: "input.duplicate",
    });
    return true;
  }
  const tr = state.changeByRange((r) => {
    if (r.empty) {
      const line = state.doc.lineAt(r.head);
      return {
        changes: { from: line.to, insert: state.lineBreak + line.text },
        range: EditorSelection.cursor(r.head + line.length + 1),
      };
    }
    const text = state.sliceDoc(r.from, r.to);
    return {
      changes: { from: r.to, insert: text },
      range: EditorSelection.range(r.to, r.to + text.length),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.duplicate" }));
  return true;
};

/** ⌘⌫：删除行——折叠区所在行被删时，折叠块里每一行都删。 */
export const deleteLine: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const spans = foldedLineSpans(state);
  if (!spans) return deleteDocLine(view);
  const len = state.doc.length;
  const changes = state.changes(
    spans.map((s) => (s.to < len ? { from: s.from, to: s.to + 1 } : { from: Math.max(0, s.from - 1), to: s.to })),
  );
  const doc = changes.apply(state.doc);
  const ranges = state.selection.ranges.map((r) => {
    const col = r.head - state.doc.lineAt(r.head).from;
    const line = doc.lineAt(changes.mapPos(r.head, -1));
    return EditorSelection.cursor(line.from + Math.min(col, line.length));
  });
  view.dispatch({
    changes,
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    scrollIntoView: true,
    userEvent: "delete.line",
  });
  return true;
};

// --- 出现处 -------------------------------------------------------------------

interface OccurrenceSearch {
  /** 这轮从空光标起步：出现处只按整词匹配。 */
  wholeWords: boolean;
  /** 上一次没找到：下一次从头开始找。 */
  notFound: boolean;
}

/** 设置出现处连选轮次的事务效果。 */
const setOccurrenceSearch = StateEffect.define<OccurrenceSearch>();

/** 「添加下一处出现」连选的状态；任何其他选区变化或编辑都会终止这一轮。 */
export const occurrenceSearch = StateField.define<OccurrenceSearch | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setOccurrenceSearch)) return e.value;
    return tr.docChanged || tr.selection ? null : value;
  },
});

/** 标识符字符类（字母/数字/下划线/美元）。 */
const IDENT = /[\p{L}\p{N}_$]/u;
/** `pos` 处是否为标识符字符（越界为 false）。 */
const identAt = (state: EditorState, pos: number) =>
  pos >= 0 && pos < state.doc.length && IDENT.test(state.sliceDoc(pos, pos + 1));

/** `pos` 处或紧邻其前的标识符；不在标识符上返回 `null`。 */
export function identifierAt(state: EditorState, pos: number): { from: number; to: number } | null {
  let from = pos;
  let to = pos;
  while (from > 0 && identAt(state, from - 1)) from--;
  while (to < state.doc.length && identAt(state, to)) to++;
  return from < to ? { from, to } : null;
}

/** `[from, to)` 是否落在整词边界内（两侧都不紧贴标识符字符）。 */
function isWholeWord(state: EditorState, from: number, to: number): boolean {
  if (identAt(state, from - 1) && identAt(state, from)) return false;
  return !(identAt(state, to) && identAt(state, to - 1));
}

/** 从 `from` 起按原文大小写找 `text` 的匹配（按需只认整词）。 */
function* matches(state: EditorState, text: string, from: number, wholeWords: boolean) {
  const cursor = new SearchCursor(state.doc, text, from);
  for (cursor.next(); !cursor.done; cursor.next()) {
    const { from: a, to: b } = cursor.value;
    if (!wholeWords || isWholeWord(state, a, b)) yield { from: a, to: b };
  }
}

/** 照 `like` 的头在哪一侧生成 `m` 的选区（反向选区的方向保持）。 */
const rangeLike = (like: SelectionRange, m: { from: number; to: number }) =>
  like.head === like.from && like.from !== like.to
    ? EditorSelection.range(m.to, m.from)
    : EditorSelection.range(m.from, m.to);

/**
 * ⌃G：添加下一处出现的选区。空光标时先选中所在词（这轮随之为整词匹配）；
 * 已有选区时在上一个添加处之后追加下一个匹配。找不到回报 `notFound`
 * （由调用方提示），下一次调用改从头找。
 */
export function nextOccurrence(view: EditorView): "selected" | "added" | "notFound" | "none" {
  const { state } = view;
  const main = state.selection.main;
  if (main.empty) {
    const word = identifierAt(state, main.head);
    if (!word) return "none";
    view.dispatch({
      selection: state.selection.replaceRange(EditorSelection.range(word.from, word.to)),
      effects: setOccurrenceSearch.of({ wholeWords: true, notFound: false }),
      scrollIntoView: true,
      userEvent: "select",
    });
    return "selected";
  }
  const run = state.field(occurrenceSearch, false) ?? null;
  const wholeWords = !!run?.wholeWords;
  const text = state.sliceDoc(main.from, main.to);
  const hit = matches(state, text, run?.notFound ? 0 : main.to, wholeWords).next().value;
  if (!hit) {
    view.dispatch({ effects: setOccurrenceSearch.of({ wholeWords, notFound: true }) });
    return "notFound";
  }
  if (state.selection.ranges.some((r) => r.from === hit.from && r.to === hit.to)) {
    view.dispatch({ effects: setOccurrenceSearch.of({ wholeWords, notFound: !!run?.notFound }) });
    return "none";
  }
  view.dispatch({
    selection: state.selection.addRange(rangeLike(main, hit)),
    effects: [setOccurrenceSearch.of({ wholeWords, notFound: false }), EditorView.scrollIntoView(hit.from)],
    userEvent: "select",
  });
  return "added";
}

/** ⌃D：添加下一处出现；找不到返回 false 不吃按键。 */
export const addCaretNextOccurrence: Command = (view) => nextOccurrence(view) !== "none";

/** ⌃⌘G：选中选区（或光标所在整词）的全部出现处。 */
export const selectAllOccurrences: Command = (view) => {
  const { state } = view;
  let main = state.selection.main;
  // 从 Alt+J 的整词选择接续“选择全部”时，不能把 foobar 中的 foo 也选进来。
  let wholeWords = state.field(occurrenceSearch, false)?.wholeWords ?? false;
  if (main.empty) {
    const word = identifierAt(state, main.head);
    if (!word) return false;
    main = EditorSelection.range(word.from, word.to);
    wholeWords = true;
  }
  const text = state.sliceDoc(main.from, main.to);
  const ranges: SelectionRange[] = [];
  let mainIndex = 0;
  for (const m of matches(state, text, 0, wholeWords)) {
    if (m.from === main.from) mainIndex = ranges.length;
    ranges.push(rangeLike(main, m));
  }
  if (!ranges.length) return false;
  view.dispatch({ selection: EditorSelection.create(ranges, mainIndex), userEvent: "select" });
  return true;
};

// --- 语句移动 -------------------------------------------------------------------

interface LineSpan {
  from: number; // 行首
  to: number; // 行尾（不含换行）
}

/** 子节点是语句 / 成员的节点（外加顶层节点）。 */
const CONTAINER =
  /^(Program|Script|Module|SourceFile|Chunk|Document|StyleSheet|JsonText|Object|Array|BlockMapping|BlockSequence|Suite|CompoundStatement|DeclarationList|FieldDeclarationList|StatementList)$|Block$|Body$/;
/** 函数 / 类族节点：语句移动绝不把代码带进或带出它们。 */
const GUARD = /Function|Method|Class|Interface|Constructor|Enum|Struct|Trait|Impl|Lambda|Arrow|Closure|Func/;
/** 函数/类族节点名里放行的普通词（排除 GUARD 误伤 Block/Body 之类）。 */
const NOT_GUARD = /Body|Block|Call|Name|Type|Keyword|Modifier|List|Param|Signature|Invocation|Reference|Access/;

/** 是可容纳语句的节点（顶层或语句列表类节点）。 */
const isContainer = (n: Node | null) => !n || !n.parent || CONTAINER.test(n.type.name);
/** 是函数/类族节点（语句移动的硬边界）。 */
const isGuard = (n: Node) => GUARD.test(n.type.name) && !NOT_GUARD.test(n.type.name);

/** 某行第一个非空白字符的位置；整行空白返回 null。 */
function firstToken(state: EditorState, lineNo: number): number | null {
  const line = state.doc.line(lineNo);
  const indent = /^\s*/.exec(line.text)![0].length;
  return indent === line.length ? null : line.from + indent;
}

/** 以某行第一个 token 起头的语句（或成员、注释、块的收括号）。 */
function statementStartingAt(state: EditorState, lineNo: number): Node | null {
  const pos = firstToken(state, lineNo);
  if (pos === null) return null;
  for (let n: Node | null = syntaxTree(state).resolveInner(pos, 1); n && n.parent; n = n.parent) {
    if (n.from !== pos) return null;
    if (isContainer(n.parent)) return n;
  }
  return null;
}

/** 移动的语句停下的行：空行、语句起点、块的收括号。 */
const isStopLine = (state: EditorState, lineNo: number) =>
  firstToken(state, lineNo) === null || !!statementStartingAt(state, lineNo);

/** 包住光标行第一个 token 的语句。 */
function statementAround(state: EditorState, pos: number): Node | null {
  const start = firstToken(state, state.doc.lineAt(pos).number);
  if (start === null) return null;
  for (let n: Node | null = syntaxTree(state).resolveInner(start, 1); n && n.parent; n = n.parent)
    if (isContainer(n.parent)) return n;
  return null;
}

/** 以某行收尾（在它最后一个 token 上）的语句。 */
function statementEndingOn(state: EditorState, lineNo: number): Node | null {
  const line = state.doc.line(lineNo);
  const end = line.from + line.text.trimEnd().length;
  if (end === line.from) return null;
  for (let n: Node | null = syntaxTree(state).resolveInner(end, -1); n && n.parent; n = n.parent) {
    if (isContainer(n.parent)) return state.doc.lineAt(n.to).number === lineNo ? n : null;
  }
  return null;
}

/** 函数 / 类（或持有其一的语句，如带回调的调用）作为一个整体移动。 */
function holdsGuard(n: Node): boolean {
  if (isGuard(n)) return true;
  for (let c = n.firstChild; c; c = c.nextSibling) if (!CONTAINER.test(c.type.name) && holdsGuard(c)) return true;
  return false;
}

/** 把 `cur` 挪过行 `[s, e]` 会把它带进或带出某个函数 / 类。 */
function crossesGuard(state: EditorState, cur: Node, s: number, e: number): boolean {
  const from = state.doc.line(s).from;
  const to = state.doc.line(e).to;
  let crosses = false;
  syntaxTree(state).iterate({
    from,
    to,
    enter: (n) => {
      if (crosses) return false;
      if (!isGuard(n.node)) return;
      if (n.from <= cur.from && n.to >= cur.to) {
        const gs = state.doc.lineAt(n.from).number;
        const ge = state.doc.lineAt(n.to).number;
        if ((gs >= s && gs <= e) || (ge >= s && ge <= e)) crosses = true;
      } else if (n.from < from || n.to > to) crosses = true;
    },
  });
  return crosses;
}

/** 行 `a` 上面紧贴的注释行（声明的文档注释跟着声明走）。 */
function leadingCommentStart(state: EditorState, a: number): number {
  while (a > 1) {
    const n = statementStartingAt(state, a - 1);
    if (!n || !/Comment/.test(n.type.name)) break;
    a = state.doc.lineAt(n.from).number;
  }
  return a;
}

/** {@link planStatementMove} 的结果：一次事务、不动（仍吃按键）或退回普通整行移动。 */
export type StatementMove = { spec: TransactionSpec } | "noop" | "line";

/**
 * 语句移动：光标所在的语句（整行）越过下一条语句；邻居是块头或收括号时进块，
 * 但绝不进出一个函数或类（那时不动）。相邻的函数 / 类（或持有其一的语句）
 * 作为整体越过。挪过去的行按新位置的缩进重排。光标处没有语句时返回 `line`（走普通整行移动）。
 */
export function planStatementMove(state: EditorState, up: boolean): StatementMove {
  const head = state.selection.main.head;
  const cur = statementAround(state, head);
  if (!cur) return "line";
  const doc = state.doc;
  if (/^[{}]$/.test(cur.type.name)) {
    for (let g: Node | null = cur.parent; g; g = g.parent)
      if (isGuard(g)) {
        const curLine = doc.lineAt(cur.from).number;
        if (doc.lineAt(g.from).number === curLine || doc.lineAt(g.to).number === curLine) return "noop";
        break;
      }
  }
  let a = doc.lineAt(cur.from).number;
  const b = doc.lineAt(cur.to).number;
  if (holdsGuard(cur)) a = leadingCommentStart(state, a);
  let s: number;
  let e: number;
  if (up) {
    e = a - 1;
    if (e < 1) return "noop";
    const prev = statementEndingOn(state, e);
    if (prev && prev.from < cur.from && holdsGuard(prev)) s = leadingCommentStart(state, doc.lineAt(prev.from).number);
    else {
      s = e;
      while (s >= 1 && !isStopLine(state, s)) s--;
      if (s < 1) return "noop";
    }
  } else {
    s = b + 1;
    if (s > doc.lines) return "noop";
    const next = statementStartingAt(state, s);
    if (next && next.to > cur.to && holdsGuard(next)) e = doc.lineAt(next.to).number;
    else {
      e = s + 1;
      while (e <= doc.lines && !isStopLine(state, e)) e++;
      e--;
    }
  }
  if (crossesGuard(state, cur, s, e)) return "noop";
  const moved: LineSpan = { from: doc.line(a).from, to: doc.line(b).to };
  const other: LineSpan = { from: doc.line(s).from, to: doc.line(e).to };
  const [first, second] = up ? [other, moved] : [moved, other];
  const insert = state.sliceDoc(second.from, second.to) + state.lineBreak + state.sliceDoc(first.from, first.to);
  const changes = state.changes({ from: first.from, to: second.to, insert });
  const movedFrom = up ? first.from : first.from + (second.to - second.from) + state.lineBreak.length;
  const after = state.update({ changes }).state;
  const reindent = shiftToIndentation(after, movedFrom, movedFrom + (moved.to - moved.from));
  const caret = movedFrom + (head - moved.from);
  return {
    spec: {
      changes: reindent ? changes.compose(reindent) : changes,
      selection: EditorSelection.cursor(reindent ? reindent.mapPos(caret, 1) : caret),
      scrollIntoView: true,
      userEvent: "move.line",
    },
  };
}

/** 把 `[from, to]` 触及的行整体平移缩进，让第一行拿到语言为它算出的缩进。 */
function shiftToIndentation(state: EditorState, from: number, to: number) {
  if (!syntaxTree(state).length) return null;
  const first = state.doc.lineAt(from);
  const proper = getIndentation(state, first.from);
  if (proper === null) return null;
  const delta = proper - countColumn(/^\s*/.exec(first.text)![0], state.tabSize);
  if (!delta) return null;
  const changes: ChangeSpec[] = [];
  for (let pos = from; pos <= to;) {
    const line = state.doc.lineAt(pos);
    pos = line.to + 1;
    const ws = /^\s*/.exec(line.text)![0];
    if (ws.length === line.length) continue;
    const col = Math.max(0, countColumn(ws, state.tabSize) + delta);
    changes.push({ from: line.from, to: line.from + ws.length, insert: indentString(state, col) });
  }
  return state.changes(changes);
}

/** ⌃⌥↑/⌃⌥↓ 的实现工厂：先试语句移动，光标处无语句时退回普通整行移动。 */
function moveStatement(up: boolean): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    if (view.state.selection.ranges.length === 1 && view.state.selection.main.empty) {
      // 语句与其邻居需要光标附近有解析树。
      forceParsing(view, Math.min(view.state.doc.length, view.state.selection.main.head + 20_000), 100);
      const plan = planStatementMove(view.state, up);
      if (plan === "noop") return true;
      if (plan !== "line") {
        view.dispatch(plan.spec);
        return true;
      }
    }
    return up ? moveLineUp(view) : moveLineDown(view);
  };
}

/** ⌃⌥↑：把当前语句往上挪一条。 */
export const moveStatementUp = moveStatement(true);
/** ⌃⌥↓：把当前语句往下挪一条。 */
export const moveStatementDown = moveStatement(false);

// --- 语句补全 -----------------------------------------------------------------------

export const SEMICOLON_LANGS = new Set([
  "java",
  "c",
  "cpp",
  "csharp",
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
  "rust",
  "php",
  "dart",
  "objective-c",
  "objective-cpp",
  "groovy",
  "zig",
]);
/** 块用关键字（`end`）或缩进收尾：绝不用花括号补全它们。 */
export const KEYWORD_BLOCK_LANGS = new Set([
  "python",
  "ruby",
  "lua",
  "elixir",
  "haskell",
  "shellscript",
  "julia",
  "erlang",
  "fsharp",
  "ocaml",
  "ocaml.interface",
  "yaml",
  "markdown",
  "plaintext",
  "makefile",
  "cmake",
  "toml",
  "ini",
  "properties",
  "sql",
  "r",
  "perl",
  "powershell",
]);
/** `end` / 缩进语言（Ruby、Lua、Elixir、Haskell…）里打开缩进体的行。 */
const KEYWORD_HEAD =
  /\b(do(\s*\|[^|]*\|)?|then|where|of)$|^\s*(def|defp|defmodule|class|module|function|local function|if|unless|elsif|elseif|else|while|until|for|case|begin)\b/;
/** 块头关键字开头的行（补 `{ }` 用）；Python 的 `def`/`elif` 在 completeStatementSpec 里单独折算。 */
const BLOCK_HEAD =
  /^\s*(if|else|for|while|do|switch|try|catch|finally|fn|fun|func|function|class|struct|enum|impl|trait|interface|object|match|when|loop|unsafe|mod|namespace)\b/;

/** 行内尾注释（不在字符串字面量里）的起点偏移；没有注释时为 `text.length`。 */
export function codeEnd(text: string, lineComment: string | undefined): number {
  if (!lineComment) return text.length;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (text.startsWith(lineComment, i)) return text.slice(0, i).trimEnd().length;
  }
  return text.length;
}

/** 某位置语言的行注释符（来自语言的 commentTokens）；没有为 undefined。 */
export function lineCommentToken(state: EditorState, pos: number): string | undefined {
  const tokens = state.languageDataAt<{ line?: string }>("commentTokens", pos)[0];
  return tokens?.line;
}

/**
 * 基于文本的补全当前语句（⌘⇧↵）：在光标行上补 `;`（尾注释之前）、
 * 块头后的 `{ }`、Python 的 `:`，然后换行。空行返回 `null`。
 */
export function completeStatementSpec(state: EditorState, language: string): TransactionSpec | null {
  const line = state.doc.lineAt(state.selection.main.head);
  const full = line.text.trimEnd();
  const trimmed = full.trim();
  if (!trimmed) return null;
  const comment = /^(\/\/|#|\*|\/\*|--)/.test(trimmed);
  const text = comment ? full : full.slice(0, codeEnd(full, lineCommentToken(state, line.from)));
  const unit = indentString(state, getIndentUnit(state));
  const baseIndent = /^\s*/.exec(line.text)![0];
  const br = state.lineBreak;
  const braces = !KEYWORD_BLOCK_LANGS.has(language);
  if (braces && !comment && BLOCK_HEAD.test(text) && !/[{;,]$/.test(text)) {
    const insert = ` {${br}${baseIndent}${unit}${br}${baseIndent}}`;
    const from = line.from + text.length;
    return {
      // 尾注释挪到块头行的行尾。
      changes: {
        from,
        to: line.from + full.length,
        insert: insert.slice(0, 2) + full.slice(text.length) + insert.slice(2),
      },
      selection: { anchor: from + 2 + full.length - text.length + br.length + baseIndent.length + unit.length },
      scrollIntoView: true,
      userEvent: "input.complete",
    };
  }
  let insert = "";
  if (SEMICOLON_LANGS.has(language) && !comment && text.trim() && !/[;{},:]$/.test(text)) insert = ";";
  if (language === "python" && BLOCK_HEAD.test(text.replace(/^\s*(def|elif)\b/, "if")) && !text.endsWith(":"))
    insert = ":";
  const opensBlock =
    text.endsWith("{") ||
    insert === ":" ||
    text.endsWith(":") ||
    (KEYWORD_BLOCK_LANGS.has(language) && KEYWORD_HEAD.test(text) && !/^\s*module\b.*\bwhere$/.test(text));
  const nextIndent = baseIndent + (opensBlock ? unit : "");
  const indentHere = getIndentation(state, line.to);
  const newline = br + (indentHere !== null && !opensBlock ? indentString(state, indentHere) : nextIndent);
  const changes: ChangeSpec[] = [];
  if (insert) changes.push({ from: line.from + text.length, insert });
  changes.push({ from: line.from + full.length, to: line.to, insert: newline });
  return {
    changes,
    selection: { anchor: line.from + full.length + insert.length + newline.length },
    scrollIntoView: true,
    userEvent: "input.complete",
  };
}

/** ⌘⇧↵：收完当前行（补 `;` 或 `{ }` 块）并跳到下一行。 */
export function completeStatement(language: string): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const spec = completeStatementSpec(view.state, language);
    if (!spec) return false;
    view.dispatch(spec);
    return true;
  };
}

// --- 辅助 -------------------------------------------------------------------

export function selectRange(view: EditorView, range: SelectionRange | { from: number; to: number }, center = true) {
  view.dispatch({
    selection: EditorSelection.single(range.from, range.to),
    effects: center ? EditorView.scrollIntoView(range.from, { y: "center" }) : undefined,
    scrollIntoView: !center,
    userEvent: "select",
  });
}

// --- comments ------------------------------------------------------------------------


// --- 智能按键 ------------------------------------------------------------------

function newLineCommand(before: boolean): Command {
  return (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    if (before) {
      // 在每个光标行上方插一行，缩进与该行一致（收括号上方深一级）。
      const unit = indentString(state, getIndentUnit(state));
      const tr = state.changeByRange((r) => {
        const line = state.doc.lineAt(r.head);
        const own = /^[ \t]*/.exec(line.text)![0];
        // 没有解析出的语言就无从计算：沿用该行自己的缩进。
        const computed = syntaxTree(state).length ? getIndentation(state, line.from) : null;
        let indent = computed !== null ? indentString(state, computed) : own;
        if (/^\s*[)\]}]/.test(line.text) && indent.length <= own.length) indent = own + unit;
        return {
          changes: { from: line.from, insert: indent + state.lineBreak },
          range: EditorSelection.cursor(line.from + indent.length),
        };
      });
      view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
      return true;
    }
    // 把每个光标挪到所在行行尾，再在那里换行并缩进。
    const atEnd = state.update({
      selection: EditorSelection.create(
        state.selection.ranges.map((r) => EditorSelection.cursor(state.doc.lineAt(r.head).to)),
        state.selection.mainIndex,
      ),
    }).state;
    let result: Transaction | null = null;
    insertNewlineAndIndent({ state: atEnd, dispatch: (tr) => (result = tr) });
    if (!result) return false;
    const tr: Transaction = result;
    view.dispatch({ changes: tr.changes, selection: tr.selection, scrollIntoView: true, userEvent: "input" });
    return true;
  };
}

/** ⇧↵：开新行（在光标行下方，不管光标在哪一列）。 */
export const startNewLine = newLineCommand(false);
/** ⌘⌥↵：在当前行上方开新行。 */
export const startNewLineBefore = newLineCommand(true);

/** ⌃⇧J：合并行——下一行（或选中的各行）以单个空格接上。 */
export const joinLines: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const tr = state.changeByRange((r) => {
    const first = state.doc.lineAt(r.from);
    let last = state.doc.lineAt(r.to);
    if (last.number === first.number || (!r.empty && r.to === last.from && last.number - 1 === first.number)) {
      if (first.number === state.doc.lines) return { range: r };
      last = state.doc.line(first.number + 1);
    } else if (!r.empty && r.to === last.from) {
      last = state.doc.line(last.number - 1);
    }
    const changes: ChangeSpec[] = [];
    let caret = r.head;
    for (let n = first.number; n < last.number; n++) {
      const cur = state.doc.line(n);
      const next = state.doc.line(n + 1);
      const trail = /[ \t]*$/.exec(cur.text)![0].length;
      const lead = /^[ \t]*/.exec(next.text)![0].length;
      const nextText = next.text.slice(lead);
      // 合并行注释时丢掉后一行的注释符（`// a` + `// b` → `// a b`）。
      const comment = /^(\/\/+|#+|--)\s?/.exec(nextText);
      const curTrim = cur.text.slice(0, cur.length - trail);
      const skip =
        comment && new RegExp(`(^|\\s)${comment[1]!.replace(/[-/#]/g, "\\$&")}`).test(curTrim) ? comment[0].length : 0;
      const sep =
        !curTrim.length || !nextText.length || /[([{]$/.test(curTrim) || /^[)\]}.,;]/.test(nextText.slice(skip))
          ? ""
          : " ";
      changes.push({ from: cur.to - trail, to: next.from + lead + skip, insert: sep });
      if (n === first.number) caret = cur.to - trail;
    }
    const set = state.changes(changes);
    return {
      changes: set,
      range: r.empty
        ? EditorSelection.cursor(set.mapPos(caret, -1))
        : EditorSelection.range(set.mapPos(r.from, 1), set.mapPos(r.to, -1)),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.join" }));
  return true;
};

/** 转义序列保持原样：`\n` 不能变成 `\N`。 */
function caseOf(state: EditorState, from: number, to: number, lower: boolean): string {
  const text = state.sliceDoc(from, to);
  const conv = (t: string) => (lower ? t.toLowerCase() : t.toUpperCase());
  const keep: Array<[number, number]> = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (n) => {
      if (/Escape/.test(n.type.name)) keep.push([Math.max(n.from, from) - from, Math.min(n.to, to) - from]);
    },
  });
  if (!keep.length) return conv(text);
  let out = "";
  let pos = 0;
  for (const [a, b] of keep) {
    if (a < pos) continue;
    out += conv(text.slice(pos, a)) + text.slice(a, b);
    pos = b;
  }
  return out + conv(text.slice(pos));
}

/**
 * ⌘⇧U：切换选区（空光标时取所在词，保持选中）的大小写：
 * 任一含大写字母就全转小写，否则全转大写。
 */
export const toggleCase: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const targets = state.selection.ranges.map((r) => (r.empty ? state.wordAt(r.head) : r));
  const lower = targets.some((t) => t && state.sliceDoc(t.from, t.to) !== state.sliceDoc(t.from, t.to).toLowerCase());
  const tr = state.changeByRange((r) => {
    const t = targets[state.selection.ranges.indexOf(r)];
    if (!t) return { range: r };
    const insert = caseOf(state, t.from, t.to, lower);
    const range = r.empty
      ? EditorSelection.range(t.from, t.from + insert.length)
      : EditorSelection.range(r.anchor, r.head);
    return { changes: { from: t.from, to: t.to, insert }, range };
  });
  view.dispatch(state.update(tr, { userEvent: "input.case" }));
  return true;
};

/** ⌥⇧G：在选中各行的行尾加光标。 */
export const addCaretsToLineEnds: Command = (view) => {
  const { state } = view;
  const ranges: SelectionRange[] = [];
  for (const r of state.selection.ranges) {
    if (r.empty) {
      ranges.push(r);
      continue;
    }
    const first = state.doc.lineAt(r.from).number;
    let last = state.doc.lineAt(r.to).number;
    if (last > first && state.doc.lineAt(r.to).from === r.to) last--;
    for (let n = first; n <= last; n++) ranges.push(EditorSelection.cursor(state.doc.line(n).to));
  }
  if (ranges.length === state.selection.ranges.length && state.selection.ranges.every((r) => r.empty)) return false;
  view.dispatch({
    selection: EditorSelection.create(ranges, ranges.length - 1),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
};

/** ⌃⇧G：取消一处选择——撤掉最近添加的选区；只剩一个时坍缩为光标。 */
export const unselectOccurrence: Command = (view) => {
  const { state } = view;
  const sel = state.selection;
  const run = state.field(occurrenceSearch, false) ?? null;
  const effects = setOccurrenceSearch.of({ wholeWords: !!run?.wholeWords, notFound: false });
  if (sel.ranges.length < 2) {
    if (sel.main.empty) return false;
    view.dispatch({ selection: EditorSelection.cursor(sel.main.head), effects, userEvent: "select" });
    return true;
  }
  const ranges = sel.ranges.filter((_, i) => i !== sel.mainIndex);
  // 撤掉的那处之前最近的一个变回主选区；其前没有就用最后一个。
  const removed = sel.main.from;
  let main = ranges.length - 1;
  for (let i = ranges.length - 1; i >= 0; i--)
    if (ranges[i]!.from < removed) {
      main = i;
      break;
    }
  view.dispatch({
    selection: EditorSelection.create(ranges, main),
    effects,
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
};
