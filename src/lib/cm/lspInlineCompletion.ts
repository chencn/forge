/** Inline Completion 适配层：只展示 ghost text，接受时才修改正文。 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import { languageIdOf, pathOf } from "../cmEditor";
import { lspManager } from "../lspManager";
import { offsetAtPosition, positionAtOffset } from "../lspProtocol";
import type { LspRange } from "../lspTypes";

export interface InlineCompletionView {
  text: string;
  from: number;
  to: number;
}

/** 兼容提案中的数组和对象返回形状，只接受非空字符串插入内容。 */
export function inlineCompletionsOf(result: unknown): Array<{ text: string; range?: LspRange }> {
  const items = Array.isArray(result)
    ? result
    : result && typeof result === "object" && Array.isArray((result as { items?: unknown }).items)
      ? (result as { items: unknown[] }).items
      : [];
  return items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as { insertText?: unknown; text?: unknown; range?: unknown };
    const text = typeof raw.insertText === "string" ? raw.insertText : typeof raw.text === "string" ? raw.text : "";
    if (!text) return [];
    if (raw.range !== undefined && !validRange(raw.range)) return [];
    const range = raw.range === undefined ? undefined : raw.range as LspRange;
    return [{ text, range }];
  });
}

function validRange(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const range = value as LspRange;
  return validPosition(range.start) && validPosition(range.end);
}

function validPosition(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Number.isInteger((value as { line?: unknown }).line)
    && Number.isInteger((value as { character?: unknown }).character)
    && (value as { line: number }).line >= 0
    && (value as { character: number }).character >= 0);
}

const setInlineCompletion = StateEffect.define<InlineCompletionView | null>();

export const inlineCompletionField = StateField.define<InlineCompletionView | null>({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged) return null;
    for (const effect of transaction.effects) {
      if (effect.is(setInlineCompletion)) return effect.value;
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => {
    if (!value) return Decoration.none;
    return Decoration.set([
      Decoration.widget({ widget: new InlineCompletionWidget(value.text), side: 1 }).range(value.to),
    ]);
  }),
});

class InlineCompletionWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }

  toDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = "lsp-inline-completion";
    dom.textContent = this.text;
    dom.setAttribute("aria-hidden", "true");
    return dom;
  }

  eq(other: InlineCompletionWidget): boolean {
    return this.text === other.text;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function acceptInlineCompletion(view: EditorView): boolean {
  const completion = view.state.field(inlineCompletionField);
  if (!completion) return false;
  view.dispatch({
    changes: { from: completion.from, to: completion.to, insert: completion.text },
    userEvent: "input.complete",
  });
  return true;
}

export function clearInlineCompletion(view: EditorView): boolean {
  if (!view.state.field(inlineCompletionField)) return false;
  view.dispatch({ effects: setInlineCompletion.of(null) });
  return true;
}

export const inlineCompletionExtension: Extension[] = [
  inlineCompletionField,
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
        if (update.docChanged || update.selectionSet) this.schedule();
      }

      private schedule(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.controller?.abort();
        this.controller = null;
        this.serial += 1;
        if (this.view.state.field(inlineCompletionField)) {
          this.view.dispatch({ effects: setInlineCompletion.of(null) });
        }
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.request();
        }, 180);
      }

      private async request(): Promise<void> {
        const state = this.view.state;
        const path = pathOf(state);
        const language = languageIdOf(state);
        const provider = path ? lspManager.capabilities(path, language)?.inlineCompletionProvider : undefined;
        if (!path || provider === undefined || provider === null || provider === false) return;
        const head = state.selection.main.head;
        const encoding = lspManager.positionEncoding(path, language);
        const text = state.doc.toString();
        const requestSerial = this.serial;
        const snapshot = state.doc;
        const controller = new AbortController();
        this.controller = controller;
        try {
          const result = await lspManager.request(path, language, "textDocument/inlineCompletion", {
            position: positionAtOffset(text, head, encoding),
            context: { triggerKind: 2 },
          }, { signal: controller.signal });
          if (requestSerial !== this.serial || this.view.state.doc !== snapshot || pathOf(this.view.state) !== path) return;
          const item = inlineCompletionsOf(result)[0];
          if (!item) return;
          const from = item.range ? offsetAtPosition(this.view.state.doc.toString(), item.range.start, encoding) : head;
          const to = item.range ? offsetAtPosition(this.view.state.doc.toString(), item.range.end, encoding) : head;
          if (from < 0 || to < from || to > this.view.state.doc.length || (item.range && to !== head)) return;
          this.view.dispatch({ effects: setInlineCompletion.of({ text: item.text, from, to }) });
        } catch {
          // 提示失败或取消只清除 ghost text。
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
