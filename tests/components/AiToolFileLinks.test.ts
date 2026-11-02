// @vitest-environment jsdom
import { act, createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiEntry } from "../../src/lib/aiRuntime";

vi.mock("../../src/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import { AiFilePath, AiOpenFileProvider } from "../../src/components/AiFileLink";
import { AiToolCall, AiToolSummary } from "../../src/components/AiToolDetails";
import type { AiFilePreview } from "../../src/lib/aiFilePreview";
import { CodeBlock } from "../../src/components/ui/code-block";

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
    ["子代理", { name: "Task", input: { subagent_type: "explore", prompt: "检查数据接口" } }],
  ])("只有正在执行的%s默认展开，手动开关与阶段转换都生效", async (_label, tool) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = async (status: string) => { await act(async () => root.render(createElement(AiToolCall, { entry: entry({ ...tool, status }) }))); };
    const trigger = () => host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    try {
      await render("running");
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      await act(async () => trigger().click());
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      await act(async () => trigger().click());
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      await render("completed");
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      await act(async () => trigger().click());
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
    } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
  });
});

describe("工具代码/命令输出复制", () => {
  it("按原文复制，只有剪贴板成功才报告已复制，文本改变后重置状态", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const host = document.createElement("div");
    const root = createRoot(host);
    const render = async (text: string) => { await act(async () => root.render(createElement(CodeBlock, { text, terminal: true }))); };
    try {
      await render("line 1\nline 2");
      await act(async () => host.querySelector("button")!.click());
      expect(writeText).toHaveBeenCalledExactlyOnceWith("line 1\nline 2");
      expect(host.querySelector("button")!.getAttribute("aria-label")).toBe("action.copied");
      await render("new output");
      writeText.mockRejectedValueOnce(new Error("denied"));
      await act(async () => host.querySelector("button")!.click());
      expect(host.querySelector("button")!.getAttribute("aria-label")).toBe("action.copy");
    } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
  });
});

describe("AI 文件操作打开独立预览", () => {
  const mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLDivElement }> = [];
  afterEach(async () => {
    for (const { root, host } of mounted.splice(0)) { await act(async () => root.unmount()); host.remove(); }
    vi.unstubAllGlobals();
  });

  async function renderCall(tool: AiEntry, onPreview: (preview: AiFilePreview) => void) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    // 通过真实 DOM 点击边界验证交互，不能直接调用整行的 onClick 来掩盖误触。
    await act(async () => root.render(createElement(AiOpenFileProvider, { onPreview, children: createElement(AiToolCall, { entry: tool }) })));
    return { host, controls: Array.from(host.querySelectorAll<HTMLButtonElement>("button[title]")) };
  }

  it("读取文件名点击发送完整读取范围到预览入口", async () => {
    const open = vi.fn();
    const { controls } = await renderCall(entry({ name: "Read", input: { file_path: "a.ts" },
      result: { type: "text", file: { startLine: 12, numLines: 5, content: "read fragment" } },
    }), open);
    expect(controls).toHaveLength(1);
    await act(async () => controls[0].click());
    expect(open).toHaveBeenCalledExactlyOnceWith({ id: "e1:0", kind: "read", path: "a.ts", start: 12, end: 16, source: "read fragment" });
  });

  it("修改文件名点击保留当次补丁，不依赖当前 Git 改动", async () => {
    const open = vi.fn();
    const { controls } = await renderCall(entry({ name: "Edit", input: { file_path: "a.ts" }, result: {
      type: "update", structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-old", "+new"] }],
    } }), open);
    await act(async () => controls[0].click());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: "change", path: "a.ts", patches: [expect.objectContaining({ diff: "@@ -3,1 +3,1 @@\n-old\n+new", proposed: false })] }));
  });

  it("多文件操作分别打开对应的文件", async () => {
    const open = vi.fn();
    const { controls } = await renderCall(entry({ input: { changes: [
      { path: "a.ts", kind: "add", diff: "+first" },
      { path: "b.ts", kind: "update", diff: "-old\n+second" },
    ] } }), open);
    expect(controls).toHaveLength(2);
    await act(async () => controls[1].click());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: "change", path: "b.ts", patches: [expect.objectContaining({ diff: "-old\n+second" })] }));
  });

  it("同名文件的读取入口保留各自完整路径与行号范围", async () => {
    const open = vi.fn();
    const { controls } = await renderCall(entry({ name: "exec", input: { commandActions: [
      { type: "read", path: "D:/repo/src/index.ts", startLine: 12, endLine: 16 },
      { type: "read", path: "D:/repo/tests/index.ts", startLine: 40, endLine: 52 },
    ] } }), open);
    expect(controls).toHaveLength(2);
    await act(async () => controls[0].click());
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "read", path: "D:/repo/src/index.ts", start: 12, end: 16 }));
    await act(async () => controls[1].click());
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "read", path: "D:/repo/tests/index.ts", start: 40, end: 52 }));
  });

  it.each([
    { name: "Read", input: { file_path: "a.ts", offset: 12 } },
    { name: "Edit", input: { file_path: "a.ts", old_string: "old", new_string: "new" } },
  ])("$name 的操作文字、箭头和文件名均打开预览，空白和统计不触发", async (tool) => {
    const open = vi.fn();
    const { controls } = await renderCall(entry(tool), open);
    const file = controls[0];
    const row = file.parentElement!;
    const action = row.querySelector<HTMLButtonElement>("button:not([title])")!;
    await act(async () => {
      row.click();
      for (const child of Array.from(row.children)) {
        if (child.tagName !== "BUTTON") child.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    });
    expect(open).not.toHaveBeenCalled();
    await act(async () => action.querySelector("span")!.click());
    expect(open).toHaveBeenCalledTimes(1);
    const preview = open.mock.calls[0][0];
    await act(async () => action.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith(preview);
    await act(async () => file.click());
    expect(open).toHaveBeenCalledTimes(3);
    expect(open).toHaveBeenLastCalledWith(preview);
  });

  it("执行脚本的操作文字和箭头均切换展开，行空白和命令正文不触发", async () => {
    const open = vi.fn();
    const { host } = await renderCall(entry({ name: "exec", input: "npm test" }), open);
    const trigger = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      trigger.parentElement!.click();
      host.querySelector("code")!.click();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(open).not.toHaveBeenCalled();
    await act(async () => trigger.querySelector("span")!.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => trigger.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
