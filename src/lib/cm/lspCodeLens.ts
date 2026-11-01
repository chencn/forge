/** CodeLens 适配层：把文档级只读命令挂在对应代码行上方。 */
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { languageIdOf, pathOf } from "../cmEditor";
import { lspManager } from "../lspManager";
import { offsetAtPosition } from "../lspProtocol";
import type { LspPositionEncoding, LspRange } from "../lspTypes";

export interface CodeLensView {
  range: LspRange;
  title: string;
  command?: string;
  arguments?: unknown[];
}

/** 只保留有标题的 lens；没有 command 的 unresolved lens 不进入可点击 UI。 */
export function codeLensesOf(result: unknown): CodeLensView[] {
  if (!Array.isArray(result)) return [];
  return result.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as { range?: unknown; command?: unknown };
    if (!raw.range || typeof raw.range !== "object" || Array.isArray(raw.range)) return [];
    const range = raw.range as LspRange;
    if (!validPosition(range.start) || !validPosition(range.end)) return [];
    if (!raw.command || typeof raw.command !== "object" || Array.isArray(raw.command)) return [];
    const command = raw.command as { title?: unknown; command?: unknown; arguments?: unknown };
    if (typeof command.title !== "string" || !command.title || typeof command.command !== "string" || !command.command) return [];
    return [{
      range,
      title: command.title,
      command: command.command,
      arguments: Array.isArray(command.arguments) ? command.arguments : undefined,
    }];
  });
}

function validPosition(value: unknown): value is { line: number; character: number } {
  return Boolean(value && typeof value === "object" && Number.isInteger((value as { line?: unknown }).line)
    && Number.isInteger((value as { character?: unknown }).character)
    && (value as { line: number }).line >= 0 && (value as { character: number }).character >= 0);
}

const setCodeLensDecorations = StateEffect.define<DecorationSet>();

export const codeLensDecorationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    decorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setCodeLensDecorations)) return effect.value;
    }
    return transaction.docChanged ? Decoration.none : decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class CodeLensWidget extends WidgetType {
  constructor(
    private readonly lens: CodeLensView,
    private readonly run: (lens: CodeLensView) => void
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = "lsp-code-lens";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lsp-code-lens-button";
    button.textContent = this.lens.title;
    button.setAttribute("aria-label", this.lens.title);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.run(this.lens);
    });
    dom.append(button);
    return dom;
  }

  eq(other: CodeLensWidget): boolean {
    return this.lens.title === other.lens.title && this.lens.command === other.lens.command;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function decorationsOf(
  state: EditorState,
  lenses: CodeLensView[],
  run: (lens: CodeLensView) => void,
  encoding: LspPositionEncoding
): DecorationSet {
  const text = state.doc.toString();
  const ranges = lenses.flatMap((lens) => {
    const line = lens.range.start.line + 1;
    if (line < 1 || line > state.doc.lines) return [];
    const from = offsetAtPosition(text, lens.range.start, encoding);
    const lineStart = state.doc.line(line).from;
    if (from < lineStart || from > state.doc.line(line).to) return [];
    return [Decoration.widget({ widget: new CodeLensWidget(lens, run), block: true, side: -1 }).range(from)];
  });
  return Decoration.set(ranges, true);
}

export const codeLensExtension: Extension[] = [
  codeLensDecorationsField,
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
        if (this.view.state.field(codeLensDecorationsField) !== Decoration.none) {
          this.view.dispatch({ effects: setCodeLensDecorations.of(Decoration.none) });
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
        const provider = path ? lspManager.capabilities(path, language)?.codeLensProvider : undefined;
        if (!path || provider === undefined || provider === null || provider === false) return;
        const snapshot = state.doc;
        const requestSerial = this.serial;
        const controller = new AbortController();
        this.controller = controller;
        try {
          const result = await lspManager.request(path, language, "textDocument/codeLens", {}, { signal: controller.signal });
          if (requestSerial !== this.serial || this.view.state.doc !== snapshot || pathOf(this.view.state) !== path) return;
          this.view.dispatch({
            effects: setCodeLensDecorations.of(
              decorationsOf(this.view.state, codeLensesOf(result), (lens) => {
                if (lens.command) void lspManager.executeCommand(path, language, lens.command, lens.arguments ?? []).catch(() => {});
              }, lspManager.positionEncoding(path, language))
            ),
          });
        } catch {
          // CodeLens 失败不影响编辑器正文和其它 LSP 能力。
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
