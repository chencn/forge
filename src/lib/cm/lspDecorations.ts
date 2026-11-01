/**
 * LSP 的可见区装饰。
 *
 * 这一层目前只承载 Inlay Hints：它们是只读 inline widget，不改变正文、不进撤销栈，
 * 所有请求都经过 LspManager。请求快照同时绑定 CodeMirror 的 Doc 身份和序号，
 * 因为 didChange 有防抖，server 的文档版本不能单独证明结果仍对应当前正文。
 */
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate, WidgetType } from "@codemirror/view";
import { languageIdOf, pathOf } from "../cmEditor";
import { lspManager } from "../lspManager";
import { offsetAtPosition, positionAtOffset } from "../lspProtocol";
import type { LspPosition, LspPositionEncoding } from "../lspTypes";

export interface InlayHintView {
  position: LspPosition;
  label: string;
  paddingLeft: boolean;
  paddingRight: boolean;
}

/** LSP label 可为字符串或 label parts；UI 只需要最终的纯文本。 */
export function inlayHintsOf(result: unknown): InlayHintView[] {
  if (!Array.isArray(result)) return [];
  return result.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as {
      position?: unknown;
      label?: unknown;
      paddingLeft?: unknown;
      paddingRight?: unknown;
    };
    if (!raw.position || typeof raw.position !== "object" || Array.isArray(raw.position)) return [];
    const position = raw.position as { line?: unknown; character?: unknown };
    if (
      !Number.isInteger(position.line) ||
      !Number.isInteger(position.character) ||
      (position.line as number) < 0 ||
      (position.character as number) < 0
    ) return [];
    const label = typeof raw.label === "string"
      ? raw.label
      : Array.isArray(raw.label)
        ? raw.label
            .flatMap((part) => {
              if (!part || typeof part !== "object" || Array.isArray(part)) return [];
              const text = (part as { value?: unknown }).value;
              return typeof text === "string" ? [text] : [];
            })
            .join("")
        : "";
    if (!label) return [];
    return [{
      position: { line: position.line as number, character: position.character as number },
      label,
      paddingLeft: raw.paddingLeft === true,
      paddingRight: raw.paddingRight === true,
    }];
  });
}

const setInlayDecorations = StateEffect.define<DecorationSet>();

export const inlayDecorationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    decorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setInlayDecorations)) return effect.value;
    }
    return transaction.docChanged ? Decoration.none : decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class InlayWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly paddingLeft: boolean,
    private readonly paddingRight: boolean
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = "lsp-inlay-hint";
    dom.textContent = `${this.paddingLeft ? " " : ""}${this.label}${this.paddingRight ? " " : ""}`;
    dom.setAttribute("aria-hidden", "true");
    return dom;
  }

  eq(other: InlayWidget): boolean {
    return this.label === other.label && this.paddingLeft === other.paddingLeft && this.paddingRight === other.paddingRight;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function decorationsOf(
  state: EditorState,
  hints: InlayHintView[],
  encoding: LspPositionEncoding
): DecorationSet {
  const text = state.doc.toString();
  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];
  for (const hint of hints) {
    if (hint.position.line < 0 || hint.position.character < 0 || hint.position.line >= state.doc.lines) continue;
    const line = state.doc.line(hint.position.line + 1);
    const lineEnd = positionAtOffset(text, line.to, encoding).character;
    if (hint.position.character > lineEnd) continue;
    const offset = offsetAtPosition(text, hint.position, encoding);
    ranges.push({
      from: offset,
      to: offset,
      decoration: Decoration.widget({
        widget: new InlayWidget(hint.label, hint.paddingLeft, hint.paddingRight),
        side: 1,
      }),
    });
  }
  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges.map((range) => range.decoration.range(range.from, range.to)), true);
}

function visibleRange(state: EditorState, view: EditorView, encoding: LspPositionEncoding): { start: LspPosition; end: LspPosition } | null {
  if (!view.visibleRanges.length) return null;
  const from = view.visibleRanges[0].from;
  const to = view.visibleRanges[view.visibleRanges.length - 1].to;
  return {
    start: positionAtOffset(state.doc.toString(), from, encoding),
    end: positionAtOffset(state.doc.toString(), to, encoding),
  };
}

export const inlayHintsExtension: Extension[] = [
  inlayDecorationsField,
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
        if (this.view.state.field(inlayDecorationsField) !== Decoration.none) {
          this.view.dispatch({ effects: setInlayDecorations.of(Decoration.none) });
        }
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.request();
        }, 120);
      }

      private async request(): Promise<void> {
        const state = this.view.state;
        const path = pathOf(state);
        const language = languageIdOf(state);
        const provider = path ? lspManager.capabilities(path, language)?.inlayHintProvider : undefined;
        if (!path || provider === undefined || provider === null || provider === false) return;
        const encoding = lspManager.positionEncoding(path, language);
        const range = visibleRange(state, this.view, encoding);
        if (!range) return;
        const snapshot = state.doc;
        const requestSerial = this.serial;
        const controller = new AbortController();
        this.controller = controller;
        try {
          const result = await lspManager.request(path, language, "textDocument/inlayHint", { range }, { signal: controller.signal });
          if (
            requestSerial !== this.serial ||
            this.view.state.doc !== snapshot ||
            pathOf(this.view.state) !== path
          ) return;
          this.view.dispatch({
            effects: setInlayDecorations.of(
              decorationsOf(this.view.state, inlayHintsOf(result), lspManager.positionEncoding(path, language))
            ),
          });
        } catch {
          // 取消、超时和 server 不可用都降级为无装饰；正文不受影响。
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
