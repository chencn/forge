/**
 * LSP 结果落到 CodeMirror 的这一层。
 *
 * 协议那一半在 LSP Manager：这里只把它引擎无关的请求和诊断
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
import { EditorSelection, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
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
import { lspManager } from "../lspManager";
import { offsetAtPosition, positionAtOffset } from "../lspProtocol";
import type {
  LspDiagnostic,
  LspPosition,
  LspPositionEncoding,
  LspRange,
  LspTextEdit,
  LspWorkspaceEdit,
} from "../lspTypes";
import { openTargetInEditor } from "../editorEnv";
import { renderChatMarkdown } from "../markdown";
import { languageIdOf, lineText, pathOf } from "../cmEditor";
import { samePath } from "../format";
import { pathToUri, uriToPath } from "../lspUri";
import { cmSnippet, plainSnippetText } from "./snippet";
import { locationsExtensions, showLocations, type LocationItem } from "./locations";
import { chooserExtensions, showDeclarationChooser } from "./lspChooser";
import { inlayHintsExtension } from "./lspDecorations";
import { semanticTokensExtension } from "./lspSemanticTokens";
import { codeLensExtension } from "./lspCodeLens";
import { acceptInlineCompletion, clearInlineCompletion, inlineCompletionExtension } from "./lspInlineCompletion";
import { documentLinksExtension } from "./lspDocumentLinks";

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

/**
 * 补全触发字符取自当前路由到的服务声明（`completionProvider.triggerCharacters`）。
 *
 * 原来那张写死的表是 Monaco 那版留下的：服务没声明的字符（`:`、`<`、`@` 之类）会白弹一次
 * 补全，服务声明了的（`-`、`>`）又接不上。服务没声明就不认触发字符，靠打字本身触发即可。
 */
function triggerCharactersOf(path: string, language: string): string[] {
  const provider = lspManager.capabilities(path, language)?.completionProvider;
  if (!provider || typeof provider !== "object") return [];
  return provider.triggerCharacters ?? [];
}

/** LSP `TextEdit` 换成 CodeMirror 的一处改动（按当前这份 state 的坐标）。 */
function changeOf(
  state: EditorState,
  edit: LspTextEdit,
  encoding: LspPositionEncoding = "utf-16"
) {
  return {
    from: offsetAtPosition(state.doc.toString(), edit.range.start, encoding),
    to: offsetAtPosition(state.doc.toString(), edit.range.end, encoding),
    insert: edit.newText,
  };
}

function positionOf(
  state: EditorState,
  pos: number,
  encoding: LspPositionEncoding = "utf-16"
): LspPosition {
  return positionAtOffset(state.doc.toString(), pos, encoding);
}

/**
 * 补全源：把 `textDocument/completion` 的结果换成 CodeMirror 的候选。
 *
 * server 给了 `textEdit.range` 就按它替换，没给就替换光标所在的那个词。
 * snippet（`insertTextFormat: 2`）与 `additionalTextEdits`（典型是自动 import）都接：
 * 附加编辑与主插入按「接受前」的坐标一起派发，CodeMirror 允许一次改动里放多段，
 * 所以不重排就会互相错位。
 */
/** `textDocument/completion` 返回的候选（只声明读取的字段）。 */
interface RawCompletionItem {
  label?: unknown;
  kind?: number;
  detail?: string;
  documentation?: unknown;
  insertText?: string;
  insertTextFormat?: number;
  additionalTextEdits?: LspTextEdit[];
  textEdit?: { newText?: string; range?: LspRange; insert?: LspRange };
  filterText?: string;
  sortText?: string;
  labelDetails?: { detail?: string; description?: string };
}

/** resolve 之后候选的最终形态（请求时那份 + resolve 补全的字段）。 */
interface ResolvedCompletion {
  detail?: string;
  info?: string;
  extras: LspTextEdit[];
  inserted: string;
  isSnippet: boolean;
}

/** documentation 归一成纯文本：字符串直接用，MarkupContent 取 value，再拼 labelDetails.description。 */
function completionDoc(node: RawCompletionItem): string | undefined {
  const documentation = node.documentation;
  const text =
    typeof documentation === "string"
      ? documentation
      : documentation && typeof documentation === "object" && typeof (documentation as { value?: unknown }).value === "string"
        ? (documentation as { value: string }).value
        : undefined;
  if (node.labelDetails?.description) {
    return text ? `${text}\n\n${node.labelDetails.description}` : node.labelDetails.description;
  }
  return text;
}

async function lspCompletions(context: CompletionContext): Promise<CompletionResult | null> {
  const state = context.state;
  const path = pathOf(state);
  if (!path) return null;
  const language = languageIdOf(state);
  const encoding = lspManager.positionEncoding(path, language);
  // 打字触发的补全要有「正在输入的词」；点 Ctrl+Space 或刚敲下触发字符时没有词也要发。
  const word = context.matchBefore(/[\w$]*/);
  const triggers = triggerCharactersOf(path, language);
  const typed = triggers.length
    ? context.matchBefore(new RegExp(`[${triggers.map(escapeRegExpChar).join("")}]$`))
    : null;
  if (!context.explicit && !word?.text && !typed) return null;
  // server 不回话（半死、超时）时按「这一路没有候选」落地：这条 await 抛出去没人接，
  // 会变成 CodeMirror 那边一个未处理的 rejection。
  let result: unknown;
  try {
    result = await lspManager.request(path, language, "textDocument/completion", {
      position: positionOf(state, context.pos, encoding),
      // 只有服务声明过的触发字符才报 triggerKind 2：它据此决定要不要先按前缀过滤一轮。
      // 显式呼出（Ctrl+Space）永远算 kind 1。
      context:
        !context.explicit && typed
          ? { triggerKind: 2, triggerCharacter: typed.text }
          : { triggerKind: 1 },
    });
  } catch {
    return null;
  }
  const items = Array.isArray(result) ? result : ((result as { items?: unknown[] })?.items ?? []);
  if (!items.length) return null;
  const fallbackFrom = word ? word.from : context.pos;
  const doc = state.doc.toString();
  // completionItem/resolve 的结果按 label 缓存：`info` 懒加载（选中项时）触发一次，
  // `apply` 取回 resolve 后才有的 detail / 文档 / additionalTextEdits（自动 import）。
  const resolvedByLabel = new Map<string, ResolvedCompletion>();
  const resolveCompletion = (node: RawCompletionItem, label: string): Promise<ResolvedCompletion> => {
    const cached = resolvedByLabel.get(label);
    if (cached) return Promise.resolve(cached);
    const value: ResolvedCompletion = {
      detail: node.detail ?? node.labelDetails?.detail,
      info: completionDoc(node),
      extras: node.additionalTextEdits ?? [],
      inserted: node.textEdit?.newText ?? node.insertText ?? label,
      isSnippet: node.insertTextFormat === 2,
    };
    // 请求时若需要的字段都已带齐，就不必再问 server 一遍。
    if (node.documentation !== undefined && node.detail !== undefined && node.additionalTextEdits !== undefined) {
      resolvedByLabel.set(label, value);
      return Promise.resolve(value);
    }
    return lspManager
      .requestRaw(path, language, "completionItem/resolve", node as unknown as Record<string, unknown>)
      .then((full) => {
        const item = full as RawCompletionItem | null;
        if (item) {
          value.detail = item.detail ?? value.detail;
          value.info = completionDoc(item) ?? value.info;
          value.extras = item.additionalTextEdits ?? value.extras;
          value.inserted = item.textEdit?.newText ?? item.insertText ?? value.inserted;
          value.isSnippet = (item.insertTextFormat ?? node.insertTextFormat) === 2;
        }
        resolvedByLabel.set(label, value);
        return value;
      })
      .catch(() => {
        // resolve 失败就按请求时那份落地，不让补全整条消失。
        resolvedByLabel.set(label, value);
        return value;
      });
  };
  const options = [];
  for (const item of items) {
    const node = item as RawCompletionItem;
    const label = typeof node.label === "string" ? node.label : (node.label as { label?: string })?.label;
    if (!label) continue;
    const range = node.textEdit?.range ?? node.textEdit?.insert;
    options.push({
      label,
      type: CM_COMPLETION_TYPES[Math.max((node.kind ?? 1) - 1, 0)] ?? "text",
      detail: node.detail ?? node.labelDetails?.detail,
      info: async () => document.createTextNode((await resolveCompletion(node, label)).info ?? ""),
      apply: (view: EditorView, picked: Completion, from: number, to: number) => {
        // 选中项若已 resolve 就用 resolve 后的内容（自动 import 的附加编辑只在 resolve 里给）。
        const value = resolvedByLabel.get(label);
        if (value) {
          applyCompletion(view, picked, from, to, value.inserted, value.isSnippet, value.extras, encoding, state, path, language);
        } else {
          const inserted = node.textEdit?.newText ?? node.insertText ?? label;
          applyCompletion(
            view,
            picked,
            from,
            to,
            inserted,
            node.insertTextFormat === 2,
            node.additionalTextEdits ?? [],
            encoding,
            state,
            path,
            language
          );
        }
      },
      filterText: node.filterText,
      sortText: node.sortText,
      from: range ? offsetAtPosition(doc, range.start, encoding) : fallbackFrom,
      to: range ? offsetAtPosition(doc, range.end, encoding) : context.pos,
    });
  }
  return { from: fallbackFrom, options, validFor: /^[\w$]*$/ };
}

/**
 * 候选落到文档上。
 *
 * 有附加编辑时统一交给 WorkspaceEdit，确保自动导入与主插入要么一起成功、要么一起失败。
 * 没有附加编辑时，普通文本一次派发，snippet 交给 CodeMirror 保留占位跳转。
 */
function applyCompletion(
  view: EditorView,
  picked: Completion,
  from: number,
  to: number,
  inserted: string,
  isSnippet: boolean,
  extras: LspTextEdit[],
  encoding: LspPositionEncoding,
  snapshot: EditorState,
  path: string,
  language: string
): void {
  // CodeMirror 的候选可能在请求返回后仍短暂留在浮层里；旧坐标不能落到新正文上。
  if (view.state.doc !== snapshot.doc || pathOf(view.state) !== path) return;
  if (extras.length) {
    // additionalTextEdits 与主补全必须作为同一个 WorkspaceEdit 提交，失败时不能只落地主插入。
    // 补全协议的附加编辑属于当前文档，因此统一转成同一 URI 下的 TextDocumentEdit；
    // 版本字段让 Manager 在用户或 server 已推进正文时拒绝这次旧候选。
    const version = lspManager.documentVersion(path, language);
    const edit = completionWorkspaceEdit(
      pathToUri(path),
      { start: positionOf(snapshot, from, encoding), end: positionOf(snapshot, to, encoding) },
      isSnippet ? plainSnippetText(inserted) : inserted,
      extras,
      version
    );
    void lspManager.applyWorkspaceEdit(edit, {
      positionEncoding: encoding,
      source: "completion",
    }).catch(() => {
      // WorkspaceEdit 失败时保持正文不变；错误由 Manager/状态栏的统一路径负责记录。
    });
    return;
  }
  if (!isSnippet) {
    view.dispatch({ changes: { from, to, insert: inserted }, userEvent: "input.complete" });
    return;
  }
  snippet(cmSnippet(inserted))(view, picked, from, to);
}

/** 把补全主编辑与 additionalTextEdits 组装成一个可事务提交的 LSP WorkspaceEdit。 */
export function completionWorkspaceEdit(
  uri: string,
  mainRange: LspRange,
  inserted: string,
  additionalTextEdits: LspTextEdit[],
  version?: number
): LspWorkspaceEdit {
  const edits = [...additionalTextEdits, { range: mainRange, newText: inserted }];
  return version === undefined
    ? { changes: { [uri]: edits } }
    : { documentChanges: [{ textDocument: { uri, version }, edits }] };
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

export interface SignatureHelpView {
  signatures: Array<{
    label: string;
    documentation: string;
    parameters: string[];
  }>;
  activeSignature: number;
  activeParameter: number;
}

/** 把协议里的签名提示收敛成 UI 需要的最小公开形状，未知字段直接忽略。 */
export function signatureHelpViewOf(result: unknown): SignatureHelpView | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const raw = result as {
    signatures?: unknown;
    activeSignature?: unknown;
    activeParameter?: unknown;
  };
  if (!Array.isArray(raw.signatures)) return null;
  const signatures = raw.signatures.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const signature = item as { label?: unknown; documentation?: unknown; parameters?: unknown };
    if (typeof signature.label !== "string" || !signature.label) return [];
    const signatureLabel = signature.label;
    const parameters = Array.isArray(signature.parameters)
      ? signature.parameters.flatMap((parameter) => {
          if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) return [];
          const label = (parameter as { label?: unknown }).label;
          // label 可以是字符串，也可以是 [start, end] 偏移（gopls / clangd 用后者），按偏移从签名行切出参数名。
          if (typeof label === "string") return [label];
          if (Array.isArray(label) && typeof label[0] === "number" && typeof label[1] === "number") {
            const slice = signatureLabel.slice(label[0] as number, label[1] as number);
            return slice ? [slice] : [];
          }
          return [];
        })
      : [];
    return [{ label: signatureLabel, documentation: markupToText(signature.documentation), parameters }];
  });
  if (!signatures.length) return null;
  return {
    signatures,
    activeSignature: Math.min(
      Math.max(typeof raw.activeSignature === "number" ? raw.activeSignature : 0, 0),
      signatures.length - 1
    ),
    activeParameter: Math.max(typeof raw.activeParameter === "number" ? raw.activeParameter : 0, 0),
  };
}

export interface CodeActionView {
  title: string;
  kind?: string;
  edit?: LspWorkspaceEdit;
  command?: { command: string; arguments?: unknown[] };
}

/** 只保留能实际执行的 Code Action；Command 的字符串和对象写法都归一成对象。 */
export function codeActionsOf(result: unknown): CodeActionView[] {
  if (!Array.isArray(result)) return [];
  return result.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as { title?: unknown; kind?: unknown; edit?: unknown; command?: unknown };
    if (typeof raw.title !== "string" || !raw.title) return [];
    const edit = raw.edit && typeof raw.edit === "object" && !Array.isArray(raw.edit)
      ? raw.edit as LspWorkspaceEdit
      : undefined;
    let command: CodeActionView["command"];
    if (typeof raw.command === "string") command = { command: raw.command };
    else if (raw.command && typeof raw.command === "object" && !Array.isArray(raw.command)) {
      const value = raw.command as { command?: unknown; arguments?: unknown };
      if (typeof value.command === "string") {
        command = { command: value.command, arguments: Array.isArray(value.arguments) ? value.arguments : undefined };
      }
    }
    if (!edit && !command) return [];
    return [{ title: raw.title, kind: typeof raw.kind === "string" ? raw.kind : undefined, edit, command }];
  });
}

function capabilityEnabled(path: string, language: string, name: keyof import("../lspTypes").LspServerCapabilities): boolean {
  const value = lspManager.capabilities(path, language)?.[name];
  return value !== undefined && value !== null && value !== false;
}

function rangeOf(state: EditorState, encoding: LspPositionEncoding): LspRange {
  return {
    start: positionOf(state, state.selection.main.from, encoding),
    end: positionOf(state, state.selection.main.to, encoding),
  };
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
  const language = languageIdOf(state);
  // 服务没这一档就别问：鼠标划过去每次都要发一条请求，换回来的只会是空。
  if (!path || !capabilityEnabled(path, language, "hoverProvider")) return null;
  const encoding = lspManager.positionEncoding(path, language);
  let result: unknown;
  try {
    result = await lspManager.request(path, language, "textDocument/hover", {
      position: positionOf(state, pos, encoding),
    });
  } catch {
    return null;
  }
  const text = markupToText((result as { contents?: unknown } | null)?.contents);
  if (!text) return null;
  const range = (result as { range?: LspRange } | null)?.range;
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
    pos: range ? offsetAtPosition(state.doc.toString(), range.start, encoding) : pos,
    end: range ? offsetAtPosition(state.doc.toString(), range.end, encoding) : pos,
    create: () => ({ dom }),
  };
}

const lspHover = hoverTooltip((view, pos) => hoverTip(view, pos), { hoverTime: 350 });

const setSignatureHelp = StateEffect.define<Tooltip | null>();
const signatureHelpField = StateField.define<Tooltip | null>({
  create: () => null,
  update(tip, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setSignatureHelp)) return effect.value;
    }
    return transaction.docChanged || transaction.selection ? null : tip;
  },
  provide: (field) => showTooltip.from(field, (tip) => tip),
});

function signatureTooltip(help: SignatureHelpView, pos: number): Tooltip {
  const active = help.signatures[help.activeSignature];
  const dom = document.createElement("div");
  dom.className = "lsp-signature-help";
  const label = document.createElement("code");
  label.textContent = active.label;
  dom.append(label);
  if (active.parameters[help.activeParameter]) {
    const parameter = document.createElement("div");
    parameter.className = "lsp-signature-parameter";
    parameter.textContent = active.parameters[help.activeParameter];
    dom.append(parameter);
  }
  if (active.documentation) {
    const documentation = document.createElement("div");
    documentation.className = "lsp-signature-documentation";
    documentation.textContent = active.documentation;
    dom.append(documentation);
  }
  return { pos, end: pos, create: () => ({ dom }) };
}

const signatureControllers = new WeakMap<EditorView, AbortController>();

function requestSignatureHelp(view: EditorView, triggerCharacter?: string): boolean {
  const state = view.state;
  const path = pathOf(state);
  const language = languageIdOf(state);
  if (!path || !capabilityEnabled(path, language, "signatureHelpProvider")) return false;
  signatureControllers.get(view)?.abort();
  const controller = new AbortController();
  signatureControllers.set(view, controller);
  const snapshot = state.doc;
  const pos = state.selection.main.head;
  const triggerKind = triggerCharacter ? 2 : 1;
  void lspManager
    .request(
      path,
      language,
      "textDocument/signatureHelp",
      {
        position: positionOf(state, pos, lspManager.positionEncoding(path, language)),
        context: { triggerKind, ...(triggerCharacter ? { triggerCharacter } : {}) },
      },
      { signal: controller.signal }
    )
    .then((result) => {
      if (view.state.doc !== snapshot || pathOf(view.state) !== path || view.state.selection.main.head !== pos) return;
      const help = signatureHelpViewOf(result);
      view.dispatch({ effects: setSignatureHelp.of(help ? signatureTooltip(help, pos) : null) });
    })
    .catch(() => {
      // 取消、超时和 server 失败都只是收起提示，不污染编辑器内容。
    });
  return true;
}

export const showSignatureHelp: Command = (view) => requestSignatureHelp(view);

const signatureHelpPlugin = ViewPlugin.fromClass(
  class {
    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate): void {
      if (!update.docChanged) return;
      const path = pathOf(update.view.state);
      const language = languageIdOf(update.view.state);
      if (!path) return;
      const provider = lspManager.capabilities(path, language)?.signatureHelpProvider;
      const triggerCharacters = provider && typeof provider === "object" && !Array.isArray(provider)
        ? [
            ...((provider as { triggerCharacters?: unknown }).triggerCharacters instanceof Array
              ? (provider as { triggerCharacters: unknown[] }).triggerCharacters
              : []),
            ...((provider as { retriggerCharacters?: unknown }).retriggerCharacters instanceof Array
              ? (provider as { retriggerCharacters: unknown[] }).retriggerCharacters
              : []),
          ].filter((item): item is string => typeof item === "string")
        : [];
      let lastInserted = "";
      update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
        lastInserted += inserted.toString();
      });
      const character = lastInserted.slice(-1);
      if (character && triggerCharacters.includes(character)) requestSignatureHelp(this.view, character);
    }

    destroy(): void {
      signatureControllers.get(this.view)?.abort();
      signatureControllers.delete(this.view);
    }
  }
);

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

const setCodeActions = StateEffect.define<Tooltip | null>();
const codeActionsField = StateField.define<Tooltip | null>({
  create: () => null,
  update(tip, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setCodeActions)) return effect.value;
    }
    return transaction.docChanged || transaction.selection ? null : tip;
  },
  provide: (field) => showTooltip.from(field, (tip) => tip),
});

const setRename = StateEffect.define<Tooltip | null>();
const renameField = StateField.define<Tooltip | null>({
  create: () => null,
  update(tip, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setRename)) return effect.value;
    }
    return transaction.docChanged || transaction.selection ? null : tip;
  },
  provide: (field) => showTooltip.from(field, (tip) => tip),
});

function closeRename(view: EditorView): boolean {
  if (!view.state.field(renameField)) return false;
  view.dispatch({ effects: setRename.of(null) });
  view.focus();
  return true;
}

/** `textDocument/prepareRename` 的应答：新规范给 `{ range, placeholder }`，旧规范直接给 Range。 */
interface PrepareRenameAnswer {
  start?: unknown;
  end?: unknown;
  range?: { start?: unknown; end?: unknown };
  placeholder?: unknown;
  defaultBehavior?: unknown;
}

/**
 * 问服务「这个位置能改名吗、这个名字叫什么」。
 *
 * 服务没声明 `renameProvider.prepareProvider` 就不问：它多半没实现这个方法，问了只换回一条
 * MethodNotFound。`allowed: false` 表示这个位置不能改名，调用方当场说明白，别让人打完新名字才失败。
 */
async function prepareRename(
  path: string,
  language: string,
  position: LspPosition
): Promise<{ allowed: boolean; placeholder?: string }> {
  const provider = lspManager.capabilities(path, language)?.renameProvider;
  if (!provider || typeof provider !== "object" || !provider.prepareProvider) {
    return { allowed: true };
  }
  const answer = (await lspManager.request(path, language, "textDocument/prepareRename", {
    position,
  })) as PrepareRenameAnswer | null;
  // 规范里的 null 就是「这个位置不能改名」。
  if (answer === null || answer === undefined) return { allowed: false };
  if (typeof answer !== "object" || Array.isArray(answer)) return { allowed: true };
  const placeholder = typeof answer.placeholder === "string" ? answer.placeholder : undefined;
  if (answer.range) return { allowed: true, placeholder };
  // 旧规范直接回 Range（有 start / end 两个字段）。
  if (answer.start && answer.end) return { allowed: true };
  // 新规范的 `defaultBehavior: false` 同样是「不改名」。
  return { allowed: answer.defaultBehavior !== false };
}

function renameWord(state: EditorState): string {
  const line = state.doc.lineAt(state.selection.main.head);
  const at = state.selection.main.head - line.from;
  let from = at;
  let to = at;
  while (from > 0 && /[\w$]/.test(line.text[from - 1])) from -= 1;
  while (to < line.text.length && /[\w$]/.test(line.text[to])) to += 1;
  return line.text.slice(from, to);
}

function actionError(dom: HTMLElement, detail: string): void {
  const error = dom.querySelector<HTMLElement>(".lsp-action-error") ?? document.createElement("div");
  error.className = "lsp-action-error";
  error.textContent = detail;
  if (!error.parentElement) dom.append(error);
}

async function applyCodeAction(
  view: EditorView,
  path: string,
  language: string,
  snapshot: EditorState["doc"],
  action: CodeActionView
): Promise<void> {
  if (view.state.doc !== snapshot || pathOf(view.state) !== path) return;
  if (action.edit) {
    const result = await lspManager.applyWorkspaceEdit(action.edit, {
      positionEncoding: lspManager.positionEncoding(path, language),
      source: "code-action",
    });
    if (!result.applied) {
      throw new Error(result.failureReason ?? translate("editor.lsp.actionFailed"));
    }
  }
  if (action.command) {
    try {
      await lspManager.executeCommand(path, language, action.command.command, action.command.arguments);
    } catch (cause) {
      throw cause;
    }
  }
  view.dispatch({ effects: setCodeActions.of(null) });
  view.focus();
}

function codeActionTooltip(
  view: EditorView,
  path: string,
  language: string,
  snapshot: EditorState["doc"],
  items: CodeActionView[],
  pos: number
): Tooltip {
  const dom = document.createElement("div");
  dom.className = "lsp-code-actions";
  const title = document.createElement("div");
  title.className = "lsp-code-actions-title";
  title.textContent = translate("editor.lsp.codeActions");
  dom.append(title);
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "lsp-code-actions-empty";
    empty.textContent = translate("editor.lsp.noCodeActions");
    dom.append(empty);
  }
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lsp-code-action";
    button.textContent = item.title;
    button.addEventListener("click", () => {
      button.disabled = true;
      void applyCodeAction(view, path, language, snapshot, item).catch((cause) => {
        button.disabled = false;
        actionError(dom, cause instanceof Error ? cause.message : String(cause));
      });
    });
    dom.append(button);
  }
  return { pos, end: pos, create: () => ({ dom }) };
}

export const showCodeActions: Command = (view) => {
  const state = view.state;
  const path = pathOf(state);
  const language = languageIdOf(state);
  if (!path || !capabilityEnabled(path, language, "codeActionProvider")) return false;
  const encoding = lspManager.positionEncoding(path, language);
  const snapshot = state.doc;
  const pos = state.selection.main.head;
  void lspManager
    .request(path, language, "textDocument/codeAction", {
      range: rangeOf(state, encoding),
      context: { diagnostics: lspManager.diagnosticsFor(path) },
    })
    .then((result) => {
      if (view.state.doc !== snapshot || pathOf(view.state) !== path) return;
      view.dispatch({ effects: setCodeActions.of(codeActionTooltip(view, path, language, snapshot, codeActionsOf(result), pos)) });
    })
    .catch(() => {});
  return true;
};

/**
 * 只执行 source.organizeImports，供项目树的 Optimize Imports 使用。
 * 仍走通用 Code Action → WorkspaceEdit/executeCommand 链，避免菜单另造一套写文档路径。
 */
export const organizeImports: Command = (view) => {
  const state = view.state;
  const path = pathOf(state);
  const language = languageIdOf(state);
  if (!path || !capabilityEnabled(path, language, "codeActionProvider")) return false;
  const encoding = lspManager.positionEncoding(path, language);
  const snapshot = state.doc;
  void lspManager
    .request(path, language, "textDocument/codeAction", {
      range: {
        start: positionOf(state, 0, encoding),
        end: positionOf(state, state.doc.length, encoding),
      },
      context: {
        diagnostics: lspManager.diagnosticsFor(path),
        only: ["source.organizeImports"],
      },
    })
    .then((result) => {
      if (view.state.doc !== snapshot || pathOf(view.state) !== path) return;
      const action = codeActionsOf(result).find(
        (item) => item.kind === "source.organizeImports" || item.kind?.startsWith("source.organizeImports.")
      );
      if (!action) return;
      void applyCodeAction(view, path, language, snapshot, action).catch(() => {});
    })
    .catch(() => {});
  return true;
};

export const renameSymbol: Command = (view) => {
  const state = view.state;
  const path = pathOf(state);
  const language = languageIdOf(state);
  if (state.readOnly || !path || !capabilityEnabled(path, language, "renameProvider")) return false;
  const snapshot = state.doc;
  const pos = state.selection.main.head;
  const encoding = lspManager.positionEncoding(path, language);
  const dom = document.createElement("div");
  dom.className = "lsp-rename";
  const input = document.createElement("input");
  input.className = "lsp-rename-input";
  input.value = renameWord(state);
  input.setAttribute("aria-label", translate("editor.lsp.renamePlaceholder"));
  const status = document.createElement("div");
  status.className = "lsp-rename-status";
  dom.append(input, status);
  let submitting = false;
  const submit = () => {
    const newName = input.value.trim();
    if (submitting || !newName) return;
    submitting = true;
    input.disabled = true;
    status.textContent = translate("editor.lsp.renaming");
    void lspManager
      .request(path, language, "textDocument/rename", {
        position: positionOf(state, pos, encoding),
        newName,
      })
      .then(async (result) => {
        if (view.state.doc !== snapshot || pathOf(view.state) !== path) return;
        if (!result || typeof result !== "object" || Array.isArray(result)) {
          status.textContent = translate("editor.lsp.renameFailed");
          input.disabled = false;
          submitting = false;
          return;
        }
        const applied = await lspManager.applyWorkspaceEdit(result as LspWorkspaceEdit, {
          positionEncoding: encoding,
          source: "rename",
        });
        if (!applied.applied) {
          status.textContent = applied.failureReason ?? translate("editor.lsp.renameFailed");
          input.disabled = false;
          submitting = false;
          return;
        }
        view.dispatch({ effects: setRename.of(null) });
        view.focus();
      })
      .catch((cause) => {
        status.textContent = cause instanceof Error ? cause.message : String(cause);
        input.disabled = false;
        submitting = false;
      });
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeRename(view);
    }
  });
  view.dispatch({ effects: setRename.of({ pos, end: pos, create: () => ({ dom, mount: () => { input.focus(); input.select(); } }) }) });
  // 先问服务一句能不能改名，并把它的 placeholder 当初值：本地词边界猜出来的名字
  // 在 `foo_bar` 这种位置上只会取到半截。这一问失败不挡改名，真正的失败由下面那次报。
  prepareRename(path, language, positionOf(state, pos, encoding))
    .then((prepared) => {
      if (view.state.doc !== snapshot || pathOf(view.state) !== path || submitting) return;
      if (!prepared.allowed) {
        status.textContent = translate("editor.lsp.renameUnavailable");
        input.disabled = true;
        return;
      }
      if (prepared.placeholder) {
        input.value = prepared.placeholder;
        input.select();
      }
    })
    .catch(() => {
      // 服务半死 / 不支持时按「可以改名」继续，改名那一步会给出真正的错误。
    });
  return true;
};

const closeLspPopups: Command = (view) => {
  const effects = [];
  if (view.state.field(manualHoverField)) effects.push(setManualHover.of(null));
  if (view.state.field(signatureHelpField)) effects.push(setSignatureHelp.of(null));
  if (view.state.field(codeActionsField)) effects.push(setCodeActions.of(null));
  if (view.state.field(renameField)) effects.push(setRename.of(null));
  if (!effects.length) return false;
  view.dispatch({ effects });
  view.focus();
  return true;
};

const SEVERITY_BY_LSP = ["error", "warning", "info", "hint"] as const;

/** LSP 诊断 → CodeMirror 诊断。server 报的行列可能落后于手上这份文本，逐条夹住。 */
function toDiagnostics(
  state: EditorState,
  diagnostics: LspDiagnostic[],
  encoding: LspPositionEncoding
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const item of diagnostics) {
    const severity = SEVERITY_BY_LSP[Math.min(Math.max((item.severity ?? 4) - 1, 0), 3)];
    let from = offsetAtPosition(state.doc.toString(), item.range.start, encoding);
    let to = Math.max(from, offsetAtPosition(state.doc.toString(), item.range.end, encoding));
    // 空 range 画不出波浪线（这类诊断指的是「光标这一处」，比如多余的分号）：
    // 往右扩一个字符，已经在行尾就往左扩（对齐参照 `diagnostics.ts:126-131`）。
    if (from === to) {
      const line = state.doc.lineAt(from);
      if (to < line.to) to += 1;
      else if (from > line.from) from -= 1;
    }
    out.push({ from, to, severity, message: item.message, source: item.source });
  }
  return out;
}

/**
 * 诊断的落地：订阅 LSP Manager 的推送按文件取缓存写进 state，正文变了再按新行号重算落点。
 *
 * 只在真的变了时派发：`setDiagnostics` 本身会改 state，不加这道签名锁会自己触发自己。
 */
const lspDiagnostics = ViewPlugin.fromClass(
  class {
    private signature = "";
    private unsubscribe: () => void;

    constructor(private readonly view: EditorView) {
      this.unsubscribe = lspManager.onDiagnosticsChange((path) => this.sync(path));
      this.sync(pathOf(view.state));
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) this.sync(pathOf(update.view.state));
    }

    private sync(changed: string | null): void {
      const state = this.view.state;
      const path = pathOf(state);
      if (!path || !changed || !samePath(changed, path)) return;
      const diagnostics = toDiagnostics(
        state,
        lspManager.diagnosticsFor(path),
        lspManager.positionEncoding(path, languageIdOf(state))
      );
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
  range?: LspRange;
  targetUri?: string;
  targetRange?: LspRange;
  targetSelectionRange?: LspRange;
}

/** 每台编辑器最后一次改正文的时刻（`performance.now()`）：空结果重试靠它判断「刚改过」。 */
const editedAt = new WeakMap<EditorView, number>();

/** 空结果重试的窗口、次数与间隔。 */
const EDIT_RETRY_WINDOW_MS = 1500;
const EDIT_RETRIES = 3;
const EDIT_RETRY_DELAY_MS = 250;

const trackEdits = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate): void {
      if (update.docChanged) editedAt.set(update.view, performance.now());
    }
  }
);

/** 空结果：null / undefined / 空数组。 */
function isEmptyLocations(answer: unknown): boolean {
  return answer === null || answer === undefined || (Array.isArray(answer) && answer.length === 0);
}

/**
 * 有些服务拿上一版正文在答（kotlin-language-server 在打字后约 300ms 内回空，
 * 对齐参照 `navigation.ts` 的 `gotoAfterEdits`）：结果是空的、而且这篇刚改过，就再问几次。
 */
async function retryEmpty<T>(view: EditorView, request: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const answer = await request();
    const justEdited = performance.now() - (editedAt.get(view) ?? -Infinity) <= EDIT_RETRY_WINDOW_MS;
    if (!isEmptyLocations(answer) || attempt >= EDIT_RETRIES || !justEdited) return answer;
    await new Promise((resolve) => setTimeout(resolve, EDIT_RETRY_DELAY_MS));
  }
}

/** 这一处结果是不是就落在光标所在位置（同行同列）。 */
function pointsAtCaret(item: LocationItem, path: string, pos: number, state: EditorState): boolean {
  if (!samePath(item.path, path)) return false;
  const line = state.doc.lineAt(pos);
  return item.line === line.number && item.column === pos - line.from + 1;
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
  const language = languageIdOf(state);
  if (!path || !capabilityEnabled(path, language, CAPABILITY_BY_METHOD[method])) return false;
  const snapshot = state.doc;
  const encoding = lspManager.positionEncoding(path, language);
  void retryEmpty(view, () =>
    lspManager.request(path, language, `textDocument/${method}`, {
      position: positionOf(state, pos, encoding),
      // 用法列表不要把声明本身算进去（参照的用法面板同样是 false）：光标停在声明上时
      // 下面会转成找用法，带着声明的话第一条就是它自己。
      ...(method === "references" ? { context: { includeDeclaration: false } } : {}),
    })
  )
    .then((result) => {
      // 整台编辑器只有一台，切页签是换 state 不是换视图：等回来时手上这篇可能已经换成
      // 另一份文件了，那一份结果与它无关，直接丢。
      const live = pathOf(view.state);
      if (!live || !samePath(live, path) || view.state.doc !== snapshot) return;
      const items = locationItems(view, Array.isArray(result) ? result : result ? [result] : []);
      // 光标本来就停在声明上：定义跳转在这里等于原地不动，转去找用法（IDEA 的规矩）。
      if (method === "definition" && items.length === 1 && pointsAtCaret(items[0], path, pos, state)) {
        if (openLocations(view, "references", pos)) return;
      }
      // 「查找用法」哪怕只有一处也列出来：那条命令要的是「都看看」，直接跳反而少了确认。
      if (items.length === 1 && method !== "references") {
        openTargetInEditor(items[0].path, items[0].line, items[0].column);
        view.focus();
        return;
      }
      // 定义一类导航多处命中：锚在发起跳转的位置弹选择器，光标处挑完就走，
      // 不用把视线甩到底部面板再甩回来。没有选择器的（用法）仍开面板。
      const chooserTitle = CHOOSER_TITLE_BY_METHOD[method];
      if (chooserTitle && items.length > 1) {
        const word = view.state.wordAt(pos);
        const name = word ? view.state.sliceDoc(word.from, word.to) : "";
        showDeclarationChooser(view, pos, translate(chooserTitle, { name, count: items.length }), items);
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
type LspLocationMethod = "declaration" | "definition" | "typeDefinition" | "implementation" | "references";

const CAPABILITY_BY_METHOD: Record<LspLocationMethod, "declarationProvider" | "definitionProvider" | "typeDefinitionProvider" | "implementationProvider" | "referencesProvider"> = {
  declaration: "declarationProvider",
  definition: "definitionProvider",
  typeDefinition: "typeDefinitionProvider",
  implementation: "implementationProvider",
  references: "referencesProvider",
};

const TITLE_BY_METHOD: Record<LspLocationMethod, TranslationKey> = {
  declaration: "editor.declarations.title",
  definition: "editor.definitions.title",
  typeDefinition: "editor.typeDefinitions.title",
  implementation: "editor.implementations.title",
  references: "editor.usages.title",
};

/**
 * 多处命中时锚在光标处的选择器标题（对标 IDE 的 Choose Declaration 弹层）。
 * 「查找用法」不走这里：它要的是通览，仍开底部面板。
 */
const CHOOSER_TITLE_BY_METHOD: Partial<Record<LspLocationMethod, TranslationKey>> = {
  declaration: "editor.chooser.declaration",
  definition: "editor.chooser.definition",
  typeDefinition: "editor.chooser.typeDefinition",
  implementation: "editor.chooser.implementation",
};

/** 结果去重，并把当前文档里的那些行的正文就地取出来；顺序按服务给的来。 */
function locationItems(view: EditorView, locations: LspLocationLike[]): LocationItem[] {
  const state = view.state;
  const here = pathOf(state);
  const seen = new Set<string>();
  const items: LocationItem[] = [];
  for (const location of locations) {
    const uri = location.uri ?? location.targetUri;
    // LocationLink 要取 targetSelectionRange（要选中的符号名）；退化到 range，最后才是 targetRange。
    const range = location.targetSelectionRange ?? location.range ?? location.targetRange;
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
  // 不重排：这份列表也拿来放符号树和调用层级，顺序本身就是服务给的层级顺序；
  // 按路径字母序一排，符号树就成了乱序。
  return items;
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
export const gotoDeclaration = goTo("declaration");
export const gotoTypeDefinition = goTo("typeDefinition");
export const gotoImplementation = goTo("implementation");
export const findUsages = goTo("references");

interface StructuralSymbol {
  name?: unknown;
  kind?: unknown;
  range?: unknown;
  selectionRange?: unknown;
  location?: unknown;
  children?: unknown;
  uri?: unknown;
}

function validLspRange(value: unknown): value is LspRange {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const range = value as LspRange;
  return Number.isInteger(range.start?.line) && Number.isInteger(range.start?.character)
    && Number.isInteger(range.end?.line) && Number.isInteger(range.end?.character)
    && range.start.line >= 0 && range.start.character >= 0 && range.end.line >= 0 && range.end.character >= 0;
}

function symbolsToLocations(view: EditorView, result: unknown): LocationItem[] {
  const path = pathOf(view.state);
  if (!path || !Array.isArray(result)) return [];
  const locations: LspLocationLike[] = [];
  const visit = (item: StructuralSymbol, fallbackPath: string) => {
    const location = item.location && typeof item.location === "object" ? item.location as LspLocationLike : null;
    const uri = typeof item.uri === "string" ? item.uri : location?.uri;
    const range = validLspRange(item.selectionRange) ? item.selectionRange
      : validLspRange(item.range) ? item.range
        : location?.range;
    if (range && uri) locations.push({ uri, range });
    else if (range && fallbackPath) locations.push({ uri: pathToUri(fallbackPath), range });
    if (Array.isArray(item.children)) {
      for (const child of item.children) if (child && typeof child === "object" && !Array.isArray(child)) visit(child as StructuralSymbol, fallbackPath);
    }
  };
  for (const item of result) if (item && typeof item === "object" && !Array.isArray(item)) visit(item as StructuralSymbol, path);
  return locationItems(view, locations);
}

/** 当前文件的符号树以位置列表呈现，避免为同一类导航再造一套结果面板。 */
export const showDocumentSymbols = (view: EditorView): boolean => {
  const path = pathOf(view.state);
  const language = languageIdOf(view.state);
  if (!path || !capabilityEnabled(path, language, "documentSymbolProvider")) return false;
  const snapshot = view.state.doc;
  void lspManager.request(path, language, "textDocument/documentSymbol", {})
    .then((result) => {
      if (pathOf(view.state) !== path || view.state.doc !== snapshot) return;
      showLocations(view, "Document Symbols", symbolsToLocations(view, result));
    }).catch(() => {});
  return true;
};

/** 方法级符号：IDEA 的 Alt+↑↓ 只在方法边界停靠（Method/Function/Constructor）。 */
const METHOD_KINDS = new Set([6, 9, 12]);

/** 拉平符号树，取方法级符号的落点偏移（selectionRange 起点优先，退回 range/location 起点）。 */
function methodStops(result: unknown, docText: string): number[] {
  const stops: number[] = [];
  const visit = (item: StructuralSymbol) => {
    const kind = typeof item.kind === "number" ? item.kind : -1;
    const range = validLspRange(item.selectionRange) ? item.selectionRange
      : validLspRange(item.range) ? item.range
        : (item.location && typeof item.location === "object" && validLspRange((item.location as LspLocationLike).range))
          ? (item.location as LspLocationLike).range
          : null;
    if (METHOD_KINDS.has(kind) && range) {
      const offset = offsetAtPosition(docText, range.start);
      if (offset >= 0 && offset <= docText.length) stops.push(offset);
    }
    if (Array.isArray(item.children)) {
      for (const child of item.children) if (child && typeof child === "object" && !Array.isArray(child)) visit(child as StructuralSymbol);
    }
  };
  if (Array.isArray(result)) for (const item of result) if (item && typeof item === "object" && !Array.isArray(item)) visit(item as StructuralSymbol);
  return stops.sort((a, b) => a - b);
}

/**
 * Alt+↑/↓：光标跳到上一个/下一个方法头（IDEA 的 navigate.previousMethod / nextMethod，
 * 对齐 openidea navigation/index.ts:55 gotoMethod——LSP outline，方法边界停靠）。
 * 服务没给 outline 时返回 false，让按键落空而不是误跳。
 */
export const gotoMethod = (view: EditorView, dir: 1 | -1): boolean => {
  const path = pathOf(view.state);
  const language = languageIdOf(view.state);
  if (!path || !capabilityEnabled(path, language, "documentSymbolProvider")) return false;
  const snapshot = view.state.doc;
  const caret = view.state.selection.main.head;
  void lspManager.request(path, language, "textDocument/documentSymbol", {})
    .then((result) => {
      if (pathOf(view.state) !== path || view.state.doc !== snapshot) return;
      const stops = methodStops(result, snapshot.toString());
      const target = dir === 1
        ? stops.find((offset) => offset > caret)
        : stops.slice().reverse().find((offset) => offset < caret);
      if (target === undefined) return;
      view.dispatch({
        selection: EditorSelection.cursor(target),
        scrollIntoView: true,
        userEvent: "select.navigate",
      });
    }).catch(() => {});
  return true;
};

/** Workspace Symbol 使用 raw request，因为它不属于某一个 textDocument。 */
export const showWorkspaceSymbols = (view: EditorView): boolean => {
  const path = pathOf(view.state);
  const language = languageIdOf(view.state);
  if (!path || !capabilityEnabled(path, language, "workspaceSymbolProvider")) return false;
  const word = view.state.wordAt(view.state.selection.main.head);
  const query = word ? view.state.sliceDoc(word.from, word.to) : "";
  const snapshot = view.state.doc;
  void lspManager.requestRaw(path, language, "workspace/symbol", { query })
    .then((result) => {
      if (pathOf(view.state) !== path || view.state.doc !== snapshot) return;
      showLocations(view, "Workspace Symbols", symbolsToLocations(view, Array.isArray(result) ? result : []));
    }).catch(() => {});
  return true;
};

function hierarchyLocations(
  view: EditorView,
  provider: "callHierarchyProvider" | "typeHierarchyProvider",
  prepareMethod: string,
  resultMethod: string,
  title: string,
  project: (item: unknown) => LspLocationLike | null
): boolean {
  const path = pathOf(view.state);
  const language = languageIdOf(view.state);
  if (!path || !capabilityEnabled(path, language, provider)) return false;
  const snapshot = view.state.doc;
  const encoding = lspManager.positionEncoding(path, language);
  void lspManager.request(path, language, prepareMethod, { position: positionOf(view.state, view.state.selection.main.head, encoding) })
    .then((prepared) => {
      const item = Array.isArray(prepared) ? prepared[0] : prepared;
      if (!item || pathOf(view.state) !== path || view.state.doc !== snapshot) return null;
      return lspManager.requestRaw(path, language, resultMethod, { item });
    })
    .then((result) => {
      if (result === null || pathOf(view.state) !== path || view.state.doc !== snapshot) return;
      const items = Array.isArray(result) ? result : [];
      const locations = items.flatMap((item) => {
        const location = project(item);
        return location ? [location] : [];
      });
      showLocations(view, title, locationItems(view, locations));
    }).catch(() => {});
  return true;
}

export const showIncomingCalls = (view: EditorView): boolean => hierarchyLocations(
  view, "callHierarchyProvider", "textDocument/prepareCallHierarchy", "callHierarchy/incomingCalls", "Incoming Calls",
  (item) => {
    if (!item || typeof item !== "object") return null;
    const from = (item as { from?: { uri?: unknown; range?: unknown } }).from;
    return typeof from?.uri === "string" && validLspRange(from.range) ? { uri: from.uri, range: from.range } : null;
  }
);

export const showOutgoingCalls = (view: EditorView): boolean => hierarchyLocations(
  view, "callHierarchyProvider", "textDocument/prepareCallHierarchy", "callHierarchy/outgoingCalls", "Outgoing Calls",
  (item) => {
    if (!item || typeof item !== "object") return null;
    const to = (item as { to?: { uri?: unknown; range?: unknown } }).to;
    return typeof to?.uri === "string" && validLspRange(to.range) ? { uri: to.uri, range: to.range } : null;
  }
);

export const showSuperTypes = (view: EditorView): boolean => hierarchyLocations(
  view, "typeHierarchyProvider", "textDocument/prepareTypeHierarchy", "typeHierarchy/supertypes", "Supertypes",
  (item) => item && typeof item === "object" && typeof (item as { uri?: unknown }).uri === "string" && validLspRange((item as { range?: unknown }).range)
    ? { uri: (item as { uri: string }).uri, range: (item as { range: LspRange }).range } : null
);

export const showSubTypes = (view: EditorView): boolean => hierarchyLocations(
  view, "typeHierarchyProvider", "textDocument/prepareTypeHierarchy", "typeHierarchy/subtypes", "Subtypes",
  (item) => item && typeof item === "object" && typeof (item as { uri?: unknown }).uri === "string" && validLspRange((item as { range?: unknown }).range)
    ? { uri: (item as { uri: string }).uri, range: (item as { range: LspRange }).range } : null
);

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
/**
 * 格式化参数：制表宽度照编辑器当前值给；缩进风格看 indentUnit 这一档是空格还是制表符，
 * 不能一律说「用空格」——Tab 缩进的项目会被服务整篇回改成空格。
 */
function formattingOptionsOf(state: EditorState): { tabSize: number; insertSpaces: boolean } {
  return { tabSize: state.tabSize, insertSpaces: !state.facet(indentUnit).includes("\t") };
}

export const formatDocument = (view: EditorView): boolean => {
  const state = view.state;
  const path = pathOf(state);
  const language = languageIdOf(state);
  // 服务没报 `documentFormattingProvider` 就直接不发：发出去只会换回一条
  // MethodNotFound，撤销栈上还白留一条「格式化」。菜单项的灰显也认这一档。
  if (!path || !capabilityEnabled(path, language, "documentFormattingProvider")) return false;
  void lspManager.request(path, language, "textDocument/formatting", {
    options: formattingOptionsOf(state),
  })
    .then((result) => {
      // 等回来时正文已经变了就放弃这一次：那些行列是按发出去那一份算的，
      // 往新正文上落会把代码改坏，宁可让人再按一次。
      if (view.state.doc !== state.doc) return;
      const edits = Array.isArray(result) ? (result as LspTextEdit[]) : [];
      if (!edits.length) return;
      view.dispatch({
        changes: edits.map((edit) => changeOf(state, edit, lspManager.positionEncoding(path, language))),
        userEvent: "format",
      });
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
  inlayHintsExtension,
  semanticTokensExtension,
  codeLensExtension,
  inlineCompletionExtension,
  documentLinksExtension,
  signatureHelpPlugin,
  signatureHelpField,
  // 记录最后一次改正文的时刻，跳转的空结果重试要用。
  trackEdits,
  codeActionsField,
  renameField,
  locationsExtensions,
  chooserExtensions,
  manualHoverField,
  ctrlClick,
  keymap.of([
    { key: "F12", run: gotoDefinition },
    { key: "Ctrl-Alt-Shift-b", run: gotoDeclaration },
    { key: "Ctrl-Shift-b", run: gotoTypeDefinition },
    { key: "Alt-Enter", run: showCodeActions },
    { key: "Shift-F6", run: renameSymbol },
    { key: "Ctrl-p", run: showSignatureHelp },
    { key: "Escape", run: closeLspPopups },
    { key: "Tab", run: acceptInlineCompletion },
    { key: "Escape", run: clearInlineCompletion },
  ]),
];
