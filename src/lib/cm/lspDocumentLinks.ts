/** Document Link 适配层：只把安全的本地文件链接交给编辑器导航。 */
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, ViewPlugin, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { languageIdOf, pathOf } from "../cmEditor";
import { lspManager } from "../lspManager";
import { offsetAtPosition } from "../lspProtocol";
import type { LspPosition, LspPositionEncoding, LspRange } from "../lspTypes";
import { openTargetInEditor } from "../editorEnv";
import { isFileUri } from "../virtualDocuments";
import { uriToPath } from "../lspUri";

export interface DocumentLinkView {
  range: LspRange;
  /** 已通过 `file:` 校验的本地路径；未知 scheme 不进入此类型。 */
  target: string;
  tooltip?: string;
}

function validPosition(value: unknown): value is LspPosition {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Number.isInteger((value as LspPosition).line) &&
      Number.isInteger((value as LspPosition).character) &&
      (value as LspPosition).line >= 0 &&
      (value as LspPosition).character >= 0
  );
}

function validRange(value: unknown): value is LspRange {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const range = value as LspRange;
  return validPosition(range.start) && validPosition(range.end);
}

/**
 * 归一化 `textDocument/documentLink` 返回值。
 *
 * LSP 允许任意 URI scheme，但当前应用只有本地文件有安全的打开入口；其它 scheme
 * 必须在协议边界丢弃，不能调用 `uriToPath` 的兜底路径，更不能落到文件系统。
 */
export function documentLinksOf(result: unknown): DocumentLinkView[] {
  if (!Array.isArray(result)) return [];
  return result.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as { range?: unknown; target?: unknown; tooltip?: unknown };
    if (!validRange(raw.range) || typeof raw.target !== "string" || !isFileUri(raw.target)) return [];
    const target = uriToPath(raw.target);
    if (!target) return [];
    return [{
      range: raw.range,
      target,
      tooltip: typeof raw.tooltip === "string" && raw.tooltip.length > 0 ? raw.tooltip : undefined,
    }];
  });
}

interface MountedDocumentLink extends DocumentLinkView {
  from: number;
  to: number;
}

function decorationsOf(
  state: EditorState,
  links: DocumentLinkView[],
  encoding: LspPositionEncoding
): MountedDocumentLink[] {
  const text = state.doc.toString();
  return links.flatMap((link) => {
    const from = offsetAtPosition(text, link.range.start, encoding);
    const to = offsetAtPosition(text, link.range.end, encoding);
    if (to <= from || from < 0 || to > text.length) return [];
    return [{ ...link, from, to }];
  });
}

const setDocumentLinks = StateEffect.define<MountedDocumentLink[]>();

export const documentLinksField = StateField.define<MountedDocumentLink[]>({
  create: () => [],
  update(links, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setDocumentLinks)) return effect.value;
    }
    // 文档坐标已失效；必须等当前正文的新请求返回后再显示，不能把链接标到新文字上。
    return transaction.docChanged ? [] : links;
  },
  provide: (field) => EditorView.decorations.from(field, (links) =>
    Decoration.set(links.map((link) => Decoration.mark({ class: "lsp-document-link" }).range(link.from, link.to)), true)
  ),
});

function linkAt(view: EditorView, pos: number): MountedDocumentLink | null {
  return view.state.field(documentLinksField).find((link) => pos >= link.from && pos < link.to) ?? null;
}

function linkTooltip(view: EditorView, pos: number): Tooltip | null {
  const link = linkAt(view, pos);
  if (!link) return null;
  const dom = document.createElement("span");
  dom.className = "lsp-document-link-tooltip";
  dom.textContent = link.tooltip ?? link.target;
  return { pos: link.from, end: link.to, create: () => ({ dom }) };
}

const documentLinkHover = hoverTooltip((view, pos) => linkTooltip(view, pos), { hoverTime: 250 });

const documentLinkClick = EditorView.domEventHandlers({
  click(event, view) {
    if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const link = linkAt(view, pos);
    if (!link) return false;
    event.preventDefault();
    event.stopPropagation();
    return openTargetInEditor(link.target, 1, 1);
  },
});

export const documentLinksExtension: Extension[] = [
  documentLinksField,
  documentLinkHover,
  documentLinkClick,
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
        if (update.docChanged) this.schedule();
      }

      private schedule(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.controller?.abort();
        this.controller = null;
        this.serial += 1;
        if (this.view.state.field(documentLinksField).length > 0) {
          this.view.dispatch({ effects: setDocumentLinks.of([]) });
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
        const provider = path ? lspManager.capabilities(path, language)?.documentLinkProvider : undefined;
        if (!path || provider === undefined || provider === null || provider === false) return;
        const snapshot = state.doc;
        const requestSerial = this.serial;
        const controller = new AbortController();
        this.controller = controller;
        try {
          const result = await lspManager.request(path, language, "textDocument/documentLink", {}, { signal: controller.signal });
          if (requestSerial !== this.serial || this.view.state.doc !== snapshot || pathOf(this.view.state) !== path) return;
          const encoding = lspManager.positionEncoding(path, language);
          this.view.dispatch({ effects: setDocumentLinks.of(decorationsOf(this.view.state, documentLinksOf(result), encoding)) });
        } catch {
          // 请求取消、超时或服务退出时保持无链接状态，不影响正文编辑。
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

