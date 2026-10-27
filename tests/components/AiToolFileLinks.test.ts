import { createElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AiEntry } from "../../src/lib/aiRuntime";

vi.mock("../../src/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import { AiFilePath, AiOpenFileProvider } from "../../src/components/AiFileLink";
import { AiToolCall, AiToolSummary } from "../../src/components/AiToolDetails";
import type { AiFilePreview } from "../../src/lib/aiFilePreview";

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
    expect(html).toContain('<span class="ai-file-target ai-tool-name"');
    expect(html).not.toContain('<button');
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
    expect(html).toContain('<span class="ai-file-target ai-tool-name"');
    expect(html).not.toContain('<button');
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

describe("AiToolCall 的运行态展开", () => {
  it.each([
    ["命令", { name: "exec", input: "npm test" }],
    ["文件修改", { name: "Edit", input: { file_path: "src/a.ts", old_string: "a", new_string: "b" } }],
  ])("只有正在执行的%s默认展开", (_label, tool) => {
    const running = withProvider(undefined, createElement(AiToolCall, { entry: entry({ ...tool, status: "running" }) }));
    const completed = withProvider(undefined, createElement(AiToolCall, { entry: entry({ ...tool, status: "completed" }) }));
    // 展开规则绑定运行阶段；历史完成项不能继承运行时的敞开状态。
    expect(running).toMatch(/<details[^>]* open=""/);
    expect(completed).not.toMatch(/<details[^>]* open=""/);
  });
});

describe("AI 文件操作打开独立预览", () => {
  function buttons(root: unknown): Array<ReactElement<{ onClick?: () => void; children?: ReactNode }>> {
    if (Array.isArray(root)) return root.flatMap(buttons);
    if (!root || typeof root !== "object" || !("props" in root)) return [];
    const node = root as ReactElement<{ onClick?: () => void; children?: ReactNode }>;
    return [...(node.type === "button" ? [node] : []), ...buttons(node.props.children)];
  }

  function renderCall(tool: AiEntry, onPreview: (preview: AiFilePreview) => void) {
    let tree: ReactNode;
    function Harness() {
      // 通过真实组件的点击边界验证传给编辑区的数据，SSR 只负责提供 Hook/Context。
      tree = (AiToolCall as unknown as { type: (props: { entry: AiEntry }) => ReactNode }).type({ entry: tool });
      return tree;
    }
    renderToStaticMarkup(createElement(AiOpenFileProvider, { onPreview, children: createElement(Harness) }));
    return buttons(tree!);
  }

  it("读取行点击发送完整读取范围到预览入口", () => {
    const open = vi.fn();
    const controls = renderCall(entry({ name: "Read", input: { file_path: "a.ts" },
      result: { type: "text", file: { startLine: 12, numLines: 5, content: "read fragment" } },
    }), open);
    expect(controls).toHaveLength(1);
    controls[0].props.onClick!();
    expect(open).toHaveBeenCalledExactlyOnceWith({ id: "e1:0", kind: "read", path: "a.ts", start: 12, end: 16, source: "read fragment" });
  });

  it("修改行点击保留当次补丁，不依赖当前 Git 改动", () => {
    const open = vi.fn();
    const controls = renderCall(entry({ name: "Edit", input: { file_path: "a.ts" }, result: {
      type: "update", structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-old", "+new"] }],
    } }), open);
    controls[0].props.onClick!();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: "change", path: "a.ts", patches: [expect.objectContaining({ diff: "@@ -3,1 +3,1 @@\n-old\n+new", proposed: false })] }));
  });

  it("多文件操作分别打开对应的文件", () => {
    const open = vi.fn();
    const controls = renderCall(entry({ input: { changes: [
      { path: "a.ts", kind: "add", diff: "+first" },
      { path: "b.ts", kind: "update", diff: "-old\n+second" },
    ] } }), open);
    expect(controls).toHaveLength(2);
    controls[1].props.onClick!();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: "change", path: "b.ts", patches: [expect.objectContaining({ diff: "-old\n+second" })] }));
  });
});
