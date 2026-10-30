/**
 * 彩虹括号：`()`、`[]`、`{}` 按嵌套深度换色，配不上的那半颗标红。
 * 逻辑移植自 IntelliJ IDEA（Apache-2.0）的同名模块，注释与开关换成本应用的说法。
 *
 * 只给视口内的括号上装饰。视口开头的嵌套状态靠扫描时每几 KB 存下的检查点还原，
 * 于是滚动和打字是从改动前最近的检查点重扫，而不是从文件头——大文件才扛得住。
 * 字符串与注释里的括号不算：有语法树就按节点跳，没有就按该语言的注释符与引号词法跳。
 */
import { Prec, type EditorState, type Extension, type Text } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

type Tree = ReturnType<typeof syntaxTree>;
type NodeType = Tree["type"];

/** 深度循环用掉几档 `--syn-bracket-<n>`。 */
const BRACKET_COLORS = 3;

const CHUNK = 4096;
/** 看得见的左括号，往后再找多远的右括号才算它闭合。 */
const LOOKAHEAD = 64_000;
/** 词法扫描跨检查点时，注释与引号最坏要往外看这么几个字符。 */
const TOKEN_SLACK = 8;

/** 三种左括号的码位 → 对应的右括号码位。 */
const CLOSER: Record<number, number> = { 40: 41, 91: 93, 123: 125 };

/** 一颗等着闭合的左括号；栈做成持久链表，检查点之间能共用。 */
interface Opener {
  closer: number;
  pos: number;
  depth: number;
  prev: Opener | null;
}

/** 词法档位：0 代码、1 行注释、2 块注释、3 字符串（引号在 `quote`）。 */
type Mode = 0 | 1 | 2 | 3;

interface ScanState {
  pos: number;
  stack: Opener | null;
  mode: Mode;
  quote: string;
}

interface BracketMark {
  from: number;
  /** 从 0 起的深度；-1 是配不上的那半颗。 */
  depth: number;
}

interface CommentTokens {
  line?: string;
  block?: { open: string; close: string };
}

const SKIP_NODE = /string|comment|char|rune|regexp|textblock|docstring|heredoc/i;
const skipCache = new WeakMap<NodeType, boolean>();
function skipsNode(type: NodeType): boolean {
  let cached = skipCache.get(type);
  if (cached === undefined) skipCache.set(type, (cached = !type.isTop && SKIP_NODE.test(type.name)));
  return cached;
}

/**
 * 一台编辑器的括号扫描器：检查点在两次重画之间留着，正文改了就把改动点之后的丢掉。
 */
export class BracketScanner {
  private checkpoints: ScanState[] = [];
  private tree: Tree | null = null;

  /** 丢掉 `pos` 之后的检查点（`pos` 是旧文档里第一处改动的位置）。 */
  invalidate(pos: number): void {
    const keep = pos - TOKEN_SLACK;
    let n = this.checkpoints.length;
    while (n > 0 && this.checkpoints[n - 1]!.pos > keep) n--;
    this.checkpoints.length = n;
  }

  /** `[from, to)` 之间的括号与深度；配不上的给 -1。 */
  marks(state: EditorState, from: number, to: number): BracketMark[] {
    const tree = treeOf(state);
    if (tree !== this.tree) {
      // 树长大了：原来树尾之后那些内容可能被重新解释成字符串或注释。
      if (this.tree && tree) this.invalidate(Math.min(this.tree.length, tree.length));
      else this.checkpoints.length = 0;
      this.tree = tree;
    }
    const doc = state.doc;
    to = Math.min(to, doc.length);
    const limit = tree ? Math.min(doc.length, tree.length) : doc.length;
    const comments = tree ? {} : (state.languageDataAt<CommentTokens>("commentTokens", 0)[0] ?? {});
    const out: BracketMark[] = [];
    const state_ = this.start(from);
    const visit = (pos: number, depth: number) => {
      if (pos >= from && pos < to) out.push({ from: pos, depth });
    };
    this.scan(doc, tree, comments, state_, Math.min(to, limit), visit);
    // 视口里那些还开着的左括号：往后看不到闭合就当配不上；超出 lookahead 就不管了，留着上色的样子。
    let open = state_.stack;
    let shallowest = Infinity;
    for (let item = open; item && item.pos >= from; item = item.prev) shallowest = item.depth;
    if (shallowest !== Infinity) {
      const end = Math.min(limit, to + LOOKAHEAD);
      this.scan(doc, tree, comments, state_, end, () => {}, shallowest);
      open = state_.stack;
      if (state_.pos >= doc.length && (open?.depth ?? -1) >= shallowest) {
        const unmatched = new Set<number>();
        for (let item = open; item && item.depth >= shallowest; item = item.prev) unmatched.add(item.pos);
        for (const mark of out) if (unmatched.has(mark.from)) mark.depth = -1;
      }
    }
    return out;
  }

  private start(from: number): ScanState {
    const points = this.checkpoints;
    let lo = 0;
    let hi = points.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid]!.pos <= from) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best < 0 ? { pos: 0, stack: null, mode: 0, quote: "" } : { ...points[best]! };
  }

  /**
   * 把扫描位置推到 `end`，每遇到一颗括号就调 `visit`。
   * 给了 `untilBelow` 时，栈一浅到那个深度就停（那就是往后找闭合括号的那趟）。
   */
  private scan(
    doc: Text,
    tree: Tree | null,
    comments: CommentTokens,
    cursor: ScanState,
    end: number,
    visit: (pos: number, depth: number) => void,
    untilBelow = -1
  ): void {
    const points = this.checkpoints;
    const lineFirst = comments.line ? comments.line.charCodeAt(0) : -1;
    const blockFirst = comments.block ? comments.block.open.charCodeAt(0) : -1;
    while (cursor.pos < end) {
      const chunkEnd = Math.min(end, (Math.floor(cursor.pos / CHUNK) + 1) * CHUNK);
      const base = cursor.pos;
      const text = doc.sliceString(base, Math.min(doc.length, chunkEnd + TOKEN_SLACK));
      const stop = chunkEnd - base;
      const skips: number[] = [];
      if (tree)
        tree.iterate({
          from: base,
          to: chunkEnd,
          enter: (node) => {
            if (!skipsNode(node.type)) return;
            skips.push(node.from - base, node.to - base);
            return false;
          },
        });
      let k = 0;
      let i = 0;
      while (i < stop) {
        if (tree) {
          while (k < skips.length && skips[k + 1]! <= i) k += 2;
          if (k < skips.length && skips[k]! <= i) {
            i = skips[k + 1]!;
            continue;
          }
        } else if (cursor.mode !== 0) {
          i = lexSkip(text, i, stop, cursor, comments);
          continue;
        }
        const ch = text.charCodeAt(i);
        if (!tree && (ch === 34 || ch === 39 || ch === 96 || ch === lineFirst || ch === blockFirst)) {
          const next = lexEnter(text, i, cursor, comments);
          if (next !== i) {
            i = next;
            continue;
          }
        }
        if (ch === 40 || ch === 91 || ch === 123) {
          const depth = cursor.stack ? cursor.stack.depth + 1 : 0;
          visit(base + i, depth);
          cursor.stack = { closer: CLOSER[ch]!, pos: base + i, depth, prev: cursor.stack };
        } else if (ch === 41 || ch === 93 || ch === 125) {
          if (cursor.stack && cursor.stack.closer === ch) {
            visit(base + i, cursor.stack.depth);
            cursor.stack = cursor.stack.prev;
            if ((cursor.stack?.depth ?? -1) < untilBelow) {
              cursor.pos = base + i + 1;
              return;
            }
          } else visit(base + i, -1);
        }
        i++;
      }
      cursor.pos = base + i;
      const last = points[points.length - 1];
      if (cursor.pos >= (last ? last.pos : 0) + CHUNK && cursor.pos <= doc.length) points.push({ ...cursor });
    }
  }
}

/** 这门语言有语法树就按树扫，没有就退回词法扫描。 */
function treeOf(state: EditorState): Tree | null {
  const tree = syntaxTree(state);
  return tree.length || state.doc.length === 0 ? tree : null;
}

/** 在代码里遇到 `i`：进注释或字符串，返回跳过起始符号后的下标；不是就返回 `i`。 */
function lexEnter(text: string, i: number, cursor: ScanState, comments: CommentTokens): number {
  const ch = text[i]!;
  if (comments.line && text.startsWith(comments.line, i)) {
    cursor.mode = 1;
    return i + comments.line.length;
  }
  if (comments.block && text.startsWith(comments.block.open, i)) {
    cursor.mode = 2;
    return i + comments.block.open.length;
  }
  if (ch === '"' || ch === "`" || (ch === "'" && quoteStartsString(text, i))) {
    cursor.mode = 3;
    cursor.quote = ch;
    return i + 1;
  }
  return i;
}

/** 单引号只有在「不像词的尾巴、且本行还有另一颗」时才算字符串——否则 Rust 的生命周期 `&'a` 会把后半篇吞掉。 */
function quoteStartsString(text: string, i: number): boolean {
  if (i > 0 && /\w/.test(text[i - 1]!)) return false;
  const newline = text.indexOf("\n", i + 1);
  const close = text.indexOf("'", i + 1);
  return close >= 0 && (newline < 0 || close < newline);
}

/** 在注释或字符串里的 `i`：返回回到代码的那个下标；这段没结束就返回 `stop`。 */
function lexSkip(text: string, i: number, stop: number, cursor: ScanState, comments: CommentTokens): number {
  if (cursor.mode === 1 || cursor.mode === 2) {
    const close = cursor.mode === 1 ? "\n" : (comments.block?.close ?? "\n");
    const at = text.indexOf(close, i);
    if (at < 0 || at >= stop) return stop;
    cursor.mode = 0;
    return at + close.length;
  }
  for (; i < stop; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === cursor.quote || (ch === "\n" && cursor.quote !== "`")) {
      cursor.mode = 0;
      return i + 1;
    }
  }
  return i;
}

/** 某颗括号该用哪一档类名；`-unmatched` 是配不上的那半颗。 */
export function bracketClass(depth: number): string {
  return depth < 0 ? "cm-rainbow-bracket-unmatched" : `cm-rainbow-bracket-${(depth % BRACKET_COLORS) + 1}`;
}

const markCache = new Map<string, Decoration>();
function markFor(depth: number): Decoration {
  const cls = bracketClass(depth);
  let mark = markCache.get(cls);
  if (!mark) markCache.set(cls, (mark = Decoration.mark({ class: cls })));
  return mark;
}

function build(view: EditorView, scanner: BracketScanner): DecorationSet {
  const { from, to } = view.viewport;
  return Decoration.set(
    scanner.marks(view.state, from, to).map((mark) => markFor(mark.depth).range(mark.from, mark.from + 1)),
    true
  );
}

const plugin = ViewPlugin.fromClass(
  class {
    scanner = new BracketScanner();
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view, this.scanner);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) {
        let first = Infinity;
        update.changes.iterChangedRanges((fromA) => (first = Math.min(first, fromA)));
        this.scanner.invalidate(first);
      }
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = build(update.view, this.scanner);
      }
    }
  },
  { decorations: (value) => value.decorations }
);

/**
 * 编辑器挂上这条就有彩虹括号。
 *
 * `Prec.high`：要盖在语法高亮之上，括号那一个字符的颜色才是这里给的深度色。
 */
export function rainbowBrackets(): Extension {
  return Prec.high(plugin);
}
