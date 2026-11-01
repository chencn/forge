/**
 * Semantic Tokens 适配层。
 *
 * 语言服务返回的是相对编码的整数流，编辑器需要的是 DecorationSet。这里把协议解码、
 * 可见范围请求、请求取消和正文快照校验收在一起，避免把服务端坐标泄漏到 CodeMirror。
 */
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { languageIdOf, pathOf } from "../cmEditor";
import { lspManager } from "../lspManager";
import { offsetAtPosition, positionAtOffset } from "../lspProtocol";
import type {
  LspPositionEncoding,
  LspSemanticTokensLegend,
  LspSemanticTokensProvider,
} from "../lspTypes";

export interface SemanticTokenView {
  line: number;
  character: number;
  length: number;
  tokenType: string;
  tokenModifiers: string[];
}

/**
 * 取服务声明的 legend。空名字原样留着占位：`tokenModifiers` 的下标就是位序号，
 * 滤掉一个空串会让它后面每一位都错位。
 */
export function legendOf(provider: unknown): LspSemanticTokensLegend | null {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return null;
  const legend = (provider as LspSemanticTokensProvider).legend;
  if (!legend || !Array.isArray(legend.tokenTypes) || !Array.isArray(legend.tokenModifiers)) return null;
  // 按原样收下 legend，不过滤、不重排：`tokenModifiers` 的下标就是 modifier 的位序号，
  // 滤掉一个空串会让它后面每一位都错位（位是按原始 legend 发的）。非字符串只归一成空串占位，
  // 真正取名字的时候再按「没有这个名字」跳过。
  const tokenTypes = legend.tokenTypes.map((value) => (typeof value === "string" ? value : ""));
  const tokenModifiers = legend.tokenModifiers.map((value) => (typeof value === "string" ? value : ""));
  return { tokenTypes, tokenModifiers };
}

/** 把 LSP 的五元组相对整数流解码成 UI 使用的绝对位置。 */
export function semanticTokensOf(result: unknown, legend: LspSemanticTokensLegend): SemanticTokenView[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length % 5 !== 0) return [];
  const tokens: SemanticTokenView[] = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < data.length; index += 5) {
    const values = data.slice(index, index + 5);
    if (!values.every((value) => Number.isInteger(value) && (value as number) >= 0)) continue;
    const [deltaLine, deltaStart, length, tokenType, modifierBits] = values as number[];
    line += deltaLine;
    character = deltaLine === 0 ? character + deltaStart : deltaStart;
    const type = legend.tokenTypes[tokenType];
    if (!type || length <= 0) continue;
    // 位的下标就是 legend 里的下标；legend 里那个位置是空名字（服务没报全）就只跳过名字，
    // 不能把这一位从判断里删掉，否则后面每一位都会跟着错位。
    const tokenModifiers = legend.tokenModifiers.filter(
      (modifier, bit) => modifier.length > 0 && (modifierBits & (1 << bit)) !== 0
    );
    tokens.push({ line, character, length, tokenType: type, tokenModifiers });
  }
  return tokens;
}

function classNameOf(token: SemanticTokenView): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  return [
    "lsp-semantic-token",
    `lsp-semantic-${safe(token.tokenType)}`,
    ...token.tokenModifiers.map((modifier) => `lsp-semantic-mod-${safe(modifier)}`),
  ].join(" ");
}

function decorationsOf(state: EditorState, tokens: SemanticTokenView[], encoding: LspPositionEncoding): DecorationSet {
  const text = state.doc.toString();
  const ranges = tokens.flatMap((token) => {
    if (token.line < 0 || token.line >= state.doc.lines || token.character < 0) return [];
    const line = state.doc.line(token.line + 1);
    const lineEnd = positionAtOffset(text, line.to, encoding).character;
    if (token.character > lineEnd) return [];
    const from = offsetAtPosition(text, { line: token.line, character: token.character }, encoding);
    const to = offsetAtPosition(text, { line: token.line, character: token.character + token.length }, encoding);
    if (from < line.from || to <= from || to > line.to) return [];
    return [Decoration.mark({ class: classNameOf(token) }).range(from, to)];
  });
  return Decoration.set(ranges, true);
}

const setSemanticDecorations = StateEffect.define<DecorationSet>();

export const semanticTokenDecorationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    decorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setSemanticDecorations)) return effect.value;
    }
    return transaction.docChanged ? Decoration.none : decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function visibleRange(state: EditorState, view: EditorView, encoding: LspPositionEncoding) {
  if (!view.visibleRanges.length) return null;
  const from = view.visibleRanges[0].from;
  const to = view.visibleRanges[view.visibleRanges.length - 1].to;
  return {
    start: positionAtOffset(state.doc.toString(), from, encoding),
    end: positionAtOffset(state.doc.toString(), to, encoding),
  };
}

export const semanticTokensExtension: Extension[] = [
  semanticTokenDecorationsField,
  ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private controller: AbortController | null = null;
      private serial = 0;
      private readonly unsubscribe: () => void;

      constructor(private readonly view: EditorView) {
        this.unsubscribe = lspManager.watchStatus((_serverId, status) => {
          if (status === "ready") this.schedule();
        });
        this.schedule();
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) this.schedule();
      }

      private schedule(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.controller?.abort();
        this.controller = null;
        this.serial += 1;
        // 构造 ViewPlugin 时仍在 CodeMirror 的 update 事务里，初始空字段无需派发；
        // 后续正文/视口变化再清掉旧装饰，避免重入 EditorView.update。
        if (this.view.state.field(semanticTokenDecorationsField) !== Decoration.none) {
          this.view.dispatch({ effects: setSemanticDecorations.of(Decoration.none) });
        }
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.request();
        }, 160);
      }

      private async request(): Promise<void> {
        const state = this.view.state;
        const path = pathOf(state);
        const language = languageIdOf(state);
        const provider = path ? lspManager.capabilities(path, language)?.semanticTokensProvider : undefined;
        if (!path || provider === undefined || provider === null || provider === false) return;
        const legend = legendOf(provider);
        if (!legend) return;
        const encoding = lspManager.positionEncoding(path, language);
        const range = (provider as LspSemanticTokensProvider).range
          ? visibleRange(state, this.view, encoding)
          : null;
        if ((provider as LspSemanticTokensProvider).range && !range) return;
        const requestSerial = this.serial;
        const snapshot = state.doc;
        const controller = new AbortController();
        this.controller = controller;
        try {
          const method = range ? "textDocument/semanticTokens/range" : "textDocument/semanticTokens/full";
          const result = await lspManager.request(path, language, method, range ? { range } : {}, { signal: controller.signal });
          if (requestSerial !== this.serial || this.view.state.doc !== snapshot || pathOf(this.view.state) !== path) return;
          this.view.dispatch({ effects: setSemanticDecorations.of(decorationsOf(this.view.state, semanticTokensOf(result, legend), encoding)) });
        } catch {
          // server 不可用或请求被取消时只清除装饰，不影响正文。
        } finally {
          if (this.controller === controller) this.controller = null;
        }
      }

      destroy(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.controller?.abort();
        this.serial += 1;
        this.unsubscribe();
      }
    }
  ),
];
