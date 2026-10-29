/**
 * LSP 结果落到 CodeMirror 的这一层。
 *
 * 协议那一半在 `lib/lspClient.ts`：这里只把它引擎无关的 `lspRequest` / `diagnosticsFor`
 * 翻译成 CodeMirror 的补全源、悬停浮层与诊断，加上「跳转到定义 / 查找用法」这几条命令。
 *
 * 位置换算的口径与原来 Monaco 那版一致：LSP 的 `character` 与 CodeMirror 的 offset
 * 都按 UTF-16 码元数，所以「行首 offset + character」就是答案，不需要再折算码点。
 */
import {
  autocompletion,
  completeAnyWord,
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  EditorView,
  hoverTooltip,
  keymap,
  showTooltip,
  ViewPlugin,
  type Command,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import { translate } from "../../i18n";
import type { TranslationKey } from "../../i18n/lang/zh";
import { diagnosticsFor, lspRequest, onDiagnosticsChange, type LspDiagnostic } from "../lspClient";
import { openTargetInEditor } from "../editorEnv";
import { renderChatMarkdown } from "../markdown";
import { languageIdOf, lineText, pathOf } from "../cmEditor";
import { samePath } from "../format";
import { uriToPath } from "../lspUri";
import { cmSnippet } from "./snippet";
import { locationsExtensions, showLocations, type LocationItem } from "./locations";

/** LSP `CompletionItemKind` 1…25 → CodeMirror 的 type 名；两边的顺序正好一一对应。 */
const CM_COMPLETION_TYPES = [
  "text",
  "method",
  "function",
  "constructor",
  "field",
  "variable",
  "class",
  "interface",
  "module",
  "property",
  "unit",
  "value",
  "enum",
  "keyword",
  "snippet",
  "color",
  "file",
  "reference",
  "folder",
  "enumMember",
  "constant",
  "struct",
  "event",
  "operator",
  "typeParameter",
];

/** 与原来 Monaco provider 用的是同一批触发字符：少一个就会少一次补全弹出。 */
const TRIGGER_CHARACTERS = [".", ":", "<", "/", "@", '"', "'"];

interface LspPosition {
  line: number;
  character: number;
}

interface LspRangeLike {
  start: LspPosition;
  end: LspPosition;
}

/** LSP 的 TextEdit：行列都从 0 起，`range` 是要替换的那一段。 */
interface LspTextEdit {
  range: LspRangeLike;
  newText: string;
}

/** LSP `TextEdit` 换成 CodeMirror 的一处改动（按当前这份 state 的坐标）。 */
function changeOf(state: EditorState, edit: LspTextEdit) {
  return {
    from: offsetOf(state, edit.range.start.line, edit.range.start.character),
    to: offsetOf(state, edit.range.end.line, edit.range.end.character),
    insert: edit.newText,
  };
}

/** LSP 的行列换成这份文档里的 offset；越界时收在文档两端，不抛。 */
function offsetOf(state: EditorState, line: number, character: number): number {
  const target = Math.min(Math.max(1, line + 1), state.doc.lines);
  const row = state.doc.line(target);
  return Math.min(row.from + character, row.to);
}

function positionOf(state: EditorState, pos: number): LspPosition {
  const row = state.doc.lineAt(pos);
  return { line: row.number - 1, character: pos - row.from };
}

/**
 * 补全源：把 `textDocument/completion` 的结果换成 CodeMirror 的候选。
 *
 * server 给了 `textEdit.range` 就按它替换，没给就替换光标所在的那个词。
 * snippet（`insertTextFormat: 2`）与 `additionalTextEdits`（典型是自动 import）都接：
 * 附加编辑与主插入按「接受前」的坐标一起派发，CodeMirror 允许一次改动里放多段，
 * 所以不重排就会互相错位。
 */
async function lspCompletions(context: CompletionContext): Promise<CompletionResult | null> {
  const state = context.state;
  const path = pathOf(state);
  if (!path) return null;
  // 打字触发的补全要有「正在输入的词」；点 Ctrl+Space 或刚敲下触发字符时没有词也要发。
  const word = context.matchBefore(/[\w$]*/);
  const typed = context.matchBefore(new RegExp(`[${TRIGGER_CHARACTERS.map(escapeRegExpChar).join("")}]$`));
  if (!context.explicit && !word?.text && !typed) return null;
  // server 不回话（半死、超时）时按「这一路没有候选」落地：这条 await 抛出去没人接，
  // 会变成 CodeMirror 那边一个未处理的 rejection。
  let result: unknown;
  try {
    result = await lspRequest(path, languageIdOf(state), "textDocument/completion", {
      position: positionOf(state, context.pos),
    });
  } catch {
    return null;
  }
  const items = Array.isArray(result) ? result : ((result as { items?: unknown[] })?.items ?? []);
  if (!items.length) return null;
  const fallbackFrom = word ? word.from : context.pos;
  const options = [];
  for (const item of items) {
    const node = item as {
      label?: unknown;
      kind?: number;
      detail?: string;
      documentation?: unknown;
      insertText?: string;
      insertTextFormat?: number;
      additionalTextEdits?: LspTextEdit[];
      textEdit?: { newText?: string; range?: LspRangeLike; insert?: LspRangeLike };
      filterText?: string;
      sortText?: string;
      labelDetails?: { detail?: string; description?: string };
    };
    const label = typeof node.label === "string" ? node.label : (node.label as { label?: string })?.label;
    if (!label) continue;
    const range = node.textEdit?.range ?? node.textEdit?.insert;
    const inserted = node.textEdit?.newText ?? node.insertText ?? label;
    const isSnippet = node.insertTextFormat === 2;
    const extras = node.additionalTextEdits ?? [];
    options.push({
      label,
      type: CM_COMPLETION_TYPES[Math.max((node.kind ?? 1) - 1, 0)] ?? "text",
      detail: node.detail ?? node.labelDetails?.detail,
      info: node.labelDetails?.description
        ? `${typeof node.documentation === "string" ? node.documentation + "\n\n" : ""}${node.labelDetails.description}`
        : typeof node.documentation === "string"
          ? node.documentation
          : undefined,
      apply: (view: EditorView, picked: Completion, from: number, to: number) =>
        applyCompletion(view, picked, from, to, inserted, isSnippet, extras),
      filterText: node.filterText,
      sortText: node.sortText,
      from: range ? offsetOf(state, range.start.line, range.start.character) : fallbackFrom,
      to: range ? offsetOf(state, range.end.line, range.end.character) : context.pos,
    });
  }
  return { from: fallbackFrom, options, validFor: /^[\w$]*$/ };
}

/**
 * 候选落到文档上。
 *
 * 非 snippet 走一次派发：附加编辑与主插入的坐标都相对改动前的正文，CodeMirror 一次
 * transaction 里多段改动正是按这个口径算的，光标点交给它自己映射（落点就在插入文本之后）。
 * snippet 只能两次：模板那一段由 `snippet()` 自己派发，改不了它手上的偏移，
 * 所以先把附加编辑发出去、再把主插入的坐标按前面那段改动挪一次。撤销栈里因此是两步，
 * 换的是「按 Tab 能在占位之间跳」这件事。
 */
function applyCompletion(
  view: EditorView,
  picked: Completion,
  from: number,
  to: number,
  inserted: string,
  isSnippet: boolean,
  extras: LspTextEdit[]
): void {
  const state = view.state;
  const changes = extras.map((edit) => changeOf(state, edit));
  if (!isSnippet) {
    view.dispatch({ changes: [...changes, { from, to, insert: inserted }], userEvent: "input.complete" });
    return;
  }
  // 只挪「插在主插入之前」的那些：后面的改动不影响主插入的坐标。
  const shift = changes
    .filter((change) => change.to <= from)
    .reduce((sum, change) => sum + change.insert.length - (change.to - change.from), 0);
  if (changes.length) view.dispatch({ changes, userEvent: "input.complete" });
  snippet(cmSnippet(inserted))(view, picked, from + shift, to + shift);
}

function escapeRegExpChar(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** LSP 的 contents 可能是字符串、`{value}`，或它们的数组。 */
function markupToText(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(markupToText).filter(Boolean).join("\n\n");
  if (contents && typeof contents === "object") {
    const value = (contents as { value?: unknown }).value;
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * 取某处的悬停文档，换成可以直接挂上的浮层。
 *
 * 鼠标悬停与 Ctrl+Q（IDEA 的「文档提示」）共用这一条：两处要的是同一份内容，
 * 分别实现迟早对不上。
 */
async function hoverTip(view: EditorView, pos: number): Promise<Tooltip | null> {
  const state = view.state;
  const path = pathOf(state);
  if (!path) return null;
  let result: unknown;
  try {
    result = await lspRequest(path, languageIdOf(state), "textDocument/hover", {
      position: positionOf(state, pos),
    });
  } catch {
    return null;
  }
  const text = markupToText((result as { contents?: unknown } | null)?.contents);
  if (!text) return null;
  const range = (result as { range?: LspRangeLike } | null)?.range;
  const dom = document.createElement("div");
  dom.className = "lsp-hover";
  // 套上聊天那条类名：排版与 tok-* 配色本来就按 :is(.markdown-body, .ai-message-markdown)
  // 分组生效，浮层自己再造一份作用域等于把这套规则抄一遍。
  const body = document.createElement("div");
  body.className = "ai-message-markdown";
  // 内容已经是 DOMPurify 洗过的（renderChatMarkdown 那一层），这里不再二次清洗。
  body.innerHTML = renderChatMarkdown(text, "");
  dom.append(body);
  return {
    pos: range ? offsetOf(state, range.start.line, range.start.character) : pos,
    end: range ? offsetOf(state, range.end.line, range.end.character) : pos,
    create: () => ({ dom }),
  };
}

const lspHover = hoverTooltip((view, pos) => hoverTip(view, pos), { hoverTime: 350 });

/**
 * 键盘唤出的悬停浮层（IDEA 的 Ctrl+Q）。
 *
 * 只能挂成 facet：CodeMirror 没有「按位置开一个浮层」的命令，浮层一律由 `showTooltip`
 * 这条 facet 提供。光标一动就把 field 清空，浮层跟着收——留着它会指着别处的代码。
 */
const setManualHover = StateEffect.define<Tooltip | null>();

const manualHoverField = StateField.define<Tooltip | null>({
  create: () => null,
  update(tip, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setManualHover)) return effect.value;
    }
    if (transaction.docChanged || transaction.selection) return null;
    return tip;
  },
  provide: (field) => showTooltip.from(field, (tip) => tip),
});

const hideManualHover: Command = (view) => {
  if (!view.state.field(manualHoverField)) return false;
  view.dispatch({ effects: setManualHover.of(null) });
  return true;
};

/** Ctrl+Q：不动光标，把光标所在处的文档贴出来。 */
export const showDocumentation: Command = (view) => {
  const state = view.state;
  if (!pathOf(state)) return false;
  const pos = state.selection.main.head;
  void hoverTip(view, pos).then((tip) => {
    // 回来时文档已经换了或光标挪了就作废：那一份内容对应的是按下去那一刻的位置。
    if (!tip || view.state !== state) return;
    view.dispatch({ effects: setManualHover.of(tip) });
  });
  return true;
};

const SEVERITY_BY_LSP = ["error", "warning", "info", "hint"] as const;

/** LSP 诊断 → CodeMirror 诊断。server 报的行列可能落后于手上这份文本，逐条夹住。 */
function toDiagnostics(state: EditorState, diagnostics: LspDiagnostic[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const item of diagnostics) {
    const severity = SEVERITY_BY_LSP[Math.min(Math.max((item.severity ?? 4) - 1, 0), 3)];
    const from = offsetOf(state, item.range.start.line, item.range.start.character);
    const to = Math.max(from, offsetOf(state, item.range.end.line, item.range.end.character));
    out.push({ from, to, severity, message: item.message, source: item.source });
  }
  return out;
}

/**
 * 诊断的落地：订阅 `lspClient` 的推送按文件取缓存写进 state，正文变了再按新行号重算落点。
 *
 * 只在真的变了时派发：`setDiagnostics` 本身会改 state，不加这道签名锁会自己触发自己。
 */
const lspDiagnostics = ViewPlugin.fromClass(
  class {
    private signature = "";
    private unsubscribe: () => void;

    constructor(private readonly view: EditorView) {
      this.unsubscribe = onDiagnosticsChange((path) => this.sync(path));
      this.sync(pathOf(view.state));
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) this.sync(pathOf(update.view.state));
    }

    private sync(changed: string | null): void {
      const state = this.view.state;
      const path = pathOf(state);
      if (!path || !changed || !samePath(changed, path)) return;
      const diagnostics = toDiagnostics(state, diagnosticsFor(path));
      const signature = diagnostics.map((item) => `${item.from}:${item.to}:${item.severity}:${item.message}`).join("|");
      if (signature === this.signature) return;
      this.signature = signature;
      // setDiagnostics 给的是一个完整的 transaction spec，不是单独的 effect：直接当参数递进去。
      this.view.dispatch(setDiagnostics(state, diagnostics));
    }

    destroy(): void {
      this.unsubscribe();
    }
  }
);

/** `Location` 与 `LocationLink` 两种写法都接：后者用 `targetUri` / `targetRange`。 */
interface LspLocationLike {
  uri?: string;
  range?: LspRangeLike;
  targetUri?: string;
  targetRange?: LspRangeLike;
  targetSelectionRange?: LspRangeLike;
}

/**
 * 请求一组位置并按结果分支：定义只有一处就直接跳，多处开列表。
 *
 * 只跳第一条是错的——多处结果本来就是「让人挑一个」，Monaco 那版有内置的引用列表面板，
 * CodeMirror 没有，所以列表这一层自己搭（`cm/locations.ts`）。
 * 一处结果也没有也开列表并写明「没有找到结果」：按键没反应比一句空话更难查。
 */
function openLocations(view: EditorView, method: LspLocationMethod, pos: number): boolean {
  const state = view.state;
  const path = pathOf(state);
  if (!path) return false;
  void lspRequest(path, languageIdOf(state), `textDocument/${method}`, {
    position: positionOf(state, pos),
    ...(method === "references" ? { context: { includeDeclaration: true } } : {}),
  })
    .then((result) => {
      // 整台编辑器只有一台，切页签是换 state 不是换视图：等回来时手上这篇可能已经换成
      // 另一份文件了，那一份结果与它无关，直接丢。
      const live = pathOf(view.state);
      if (!live || !samePath(live, path)) return;
      const items = locationItems(view, Array.isArray(result) ? result : result ? [result] : []);
      // 「查找用法」哪怕只有一处也列出来：那条命令要的是「都看看」，直接跳反而少了确认。
      if (items.length === 1 && method !== "references") {
        openTargetInEditor(items[0].path, items[0].line, items[0].column);
        view.focus();
        return;
      }
      showLocations(view, translate(TITLE_BY_METHOD[method]), items);
    })
    .catch(() => {
      // 超时或 server 半死：这一次就是不跳，状态条上已经有那条服务的状态，不再叠一层提示。
    });
  return true;
}

/** 命令 → LSP 方法名 → 列表标题用的那条文案。 */
type LspLocationMethod = "definition" | "implementation" | "references";

const TITLE_BY_METHOD: Record<LspLocationMethod, TranslationKey> = {
  definition: "editor.definitions.title",
  implementation: "editor.implementations.title",
  references: "editor.usages.title",
};

/** 结果去重、排序，并把当前文档里的那些行的正文就地取出来。 */
function locationItems(view: EditorView, locations: LspLocationLike[]): LocationItem[] {
  const state = view.state;
  const here = pathOf(state);
  const seen = new Set<string>();
  const items: LocationItem[] = [];
  for (const location of locations) {
    const uri = location.uri ?? location.targetUri;
    const range = location.range ?? location.targetRange ?? location.targetSelectionRange;
    if (!uri || !range) continue;
    // 只认 `file:` 这一种：`untitled:`、`inmemory:` 这类虚拟文档跳过去也打不开，
    // 列在结果里只会让人点了没反应。
    const itemPath = uriToPath(uri);
    if (!itemPath) continue;
    const line = range.start.line + 1;
    const column = range.start.character + 1;
    const key = `${itemPath.toLowerCase()}:${line}:${column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ path: itemPath, line, column, text: here && samePath(here, itemPath) ? lineText(state, line).trim() : "" });
  }
  return items.sort((a, b) => {
    const byPath = a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
    return byPath !== 0 ? byPath : a.line - b.line || a.column - b.column;
  });
}

/**
 * 「跳过去」这一类命令：定义、实现、用法都按「一处就跳、多处列出来」处理。
 *
 * Ctrl+Click 走同一条，只是把落点从选区换成鼠标指的那里。
 */
function goTo(method: LspLocationMethod): Command {
  return (view) => {
    if (!pathOf(view.state)) return false;
    return openLocations(view, method, view.state.selection.main.head);
  };
}

export const gotoDefinition = goTo("definition");
export const gotoImplementation = goTo("implementation");
export const findUsages = goTo("references");

/**
 * Ctrl/Cmd + 单击跳到定义——IDEA 与 VS Code 都是这个手势。
 *
 * 按下去那一刻的位置就是要问的位置：请求发出去到结果回来之间，光标已经被这次点击挪走了，
 * 所以取坐标算出的位置，而不是事后再读选区。`posAtCoords` 对折叠扣、装订线和小地图
 * 那些不在正文里的坐标给 null，正好把这些一并挡掉。
 */
const ctrlClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    return openLocations(view, "definition", pos);
  },
});

/**
 * 格式化整篇。server 回的是若干处替换，一次 dispatch 交出去，撤销栈里就是一条「格式化」。
 *
 * 每处替换的行列都是按格式化前的正文给的，CodeMirror 一次事务里的多段改动正是按这个
 * 口径算坐标，所以不用像原来那样从后往前排。
 */
export const formatDocument = (view: EditorView): boolean => {
  const state = view.state;
  const path = pathOf(state);
  if (!path) return false;
  void lspRequest(path, languageIdOf(state), "textDocument/formatting", {
    options: { tabSize: state.tabSize, insertSpaces: true },
  })
    .then((result) => {
      // 等回来时正文已经变了就放弃这一次：那些行列是按发出去那一份算的，
      // 往新正文上落会把代码改坏，宁可让人再按一次。
      if (view.state.doc !== state.doc) return;
      const edits = Array.isArray(result) ? (result as LspTextEdit[]) : [];
      if (!edits.length) return;
      view.dispatch({ changes: edits.map((edit) => changeOf(state, edit)), userEvent: "format" });
    })
    .catch(() => {
      // 同上：这一次不格式化。服务状态由状态条那一路说明。
    });
  return true;
};

/**
 * 编辑器挂上这一组就得到 LSP 的补全、悬停、诊断，加 F12 / Ctrl+Click / Ctrl+Q。
 *
 * `autocompletion` 在这里配而不是在 base 里：要给候选列表装 LSP 那一路的来源，
 * 挂两处会重复注册同一套浮层。这条 Escape 只管浮层——用法列表自己绑了收掉它那一条。
 */
export const lspExtensions: Extension[] = [
  autocompletion({ override: [lspCompletions, completeAnyWord] }),
  lspHover,
  lspDiagnostics,
  locationsExtensions,
  manualHoverField,
  ctrlClick,
  keymap.of([
    { key: "F12", run: gotoDefinition },
    { key: "Escape", run: hideManualHover },
  ]),
];
