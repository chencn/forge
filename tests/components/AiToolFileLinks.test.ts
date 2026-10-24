import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AiEntry } from "../../src/lib/aiRuntime";

vi.mock("../../src/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import { AiFilePath, AiOpenFileProvider } from "../../src/components/AiFileLink";
import { AiToolSummary } from "../../src/components/AiToolDetails";

function entry(over: Partial<AiEntry>): AiEntry {
  return { id: "e1", runId: "r1", kind: "tool", text: "", status: "completed", ...over };
}

function withProvider(onOpen: ((path: string, line?: number, column?: number) => void) | undefined, node: ReactElement) {
  return renderToStaticMarkup(createElement(AiOpenFileProvider, { onOpen, children: node }));
}

describe("AiToolSummary 的文件路径", () => {
  it("读文件时整个摘要可点，带上起始行", () => {
    const html = withProvider(
      vi.fn(),
      createElement(AiToolSummary, {
        entry: entry({
          name: "Read",
          input: { file_path: "src/a.ts", offset: 12 },
          result: { type: "text", file: { filePath: "D:/repo/a.ts", startLine: 12, numLines: 5, content: "x" } },
        }),
      })
    );
    expect(html).toContain('class="ai-file-target ai-tool-name"');
    expect(html).toContain('title="D:/repo/a.ts:12"');
  });

  it("编辑文件时按补丁头的第一行跳", () => {
    const html = withProvider(
      vi.fn(),
      createElement(AiToolSummary, {
        entry: entry({
          name: "Edit",
          input: { file_path: "src/a.ts" },
          result: {
            type: "update",
            structuredPatch: [{ oldStart: 40, oldLines: 2, newStart: 44, newLines: 3, lines: [" ctx", "-old", "+new"] }],
          },
        }),
      })
    );
    expect(html).toContain('title="src/a.ts:44"');
  });

  it("多个目标时摘要不再是按钮，明细里每行各自可点", () => {
    const html = withProvider(
      vi.fn(),
      createElement(AiToolSummary, {
        entry: entry({
          name: "exec",
          input: { command: { commandActions: [
            { type: "read", path: "a.ts", startLine: 1 },
            { type: "read", path: "b.ts", startLine: 9 },
          ] } },
        }),
      })
    );
    expect(html).toContain('class="ai-tool-name"');
    expect(html).not.toContain("ai-file-target");
  });

  it("没有上层回调就退回普通文字", () => {
    const html = withProvider(
      undefined,
      createElement(AiFilePath, { path: "src/a.ts", line: 3, children: "src/a.ts" })
    );
    expect(html).toBe("<span>src/a.ts</span>");
  });
});
