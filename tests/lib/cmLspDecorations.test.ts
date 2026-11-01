// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { disposeModel, stateFor } from "../../src/lib/cmEditor";
import { stubTextLayout } from "../helpers/cmLayout";

const manager = vi.hoisted(() => ({
  capabilities: vi.fn(),
  positionEncoding: vi.fn(() => "utf-16"),
  request: vi.fn(),
  executeCommand: vi.fn().mockResolvedValue(undefined),
  watchStatus: vi.fn(() => () => {}),
}));

vi.mock("../../src/lib/lspManager", () => ({
  lspManager: manager,
}));

import { inlayHintsExtension, inlayHintsOf } from "../../src/lib/cm/lspDecorations";
import { legendOf, semanticTokensExtension, semanticTokensOf } from "../../src/lib/cm/lspSemanticTokens";
import { codeLensExtension, codeLensesOf } from "../../src/lib/cm/lspCodeLens";
import { acceptInlineCompletion, inlineCompletionExtension, inlineCompletionsOf } from "../../src/lib/cm/lspInlineCompletion";

beforeAll(stubTextLayout);
let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  manager.capabilities.mockReset();
  manager.request.mockReset();
  manager.executeCommand.mockReset();
  manager.executeCommand.mockResolvedValue(undefined);
  disposeModel("D:/proj/test.ts");
});

describe("Inlay Hints 协议归一化", () => {
  it("合并字符串 label 与 label parts，并保留两侧 padding", () => {
    expect(
      inlayHintsOf([
        { position: { line: 0, character: 4 }, label: ": string", paddingLeft: true },
        { position: { line: 1, character: 2 }, label: [{ value: " = " }, { value: "42" }], paddingRight: true },
      ])
    ).toEqual([
      { position: { line: 0, character: 4 }, label: ": string", paddingLeft: true, paddingRight: false },
      { position: { line: 1, character: 2 }, label: " = 42", paddingLeft: false, paddingRight: true },
    ]);
  });

  it("丢弃非法位置、空 label 和不支持的返回形状", () => {
    expect(
      inlayHintsOf([
        { position: { line: -1, character: 0 }, label: "bad" },
        { position: { line: 0, character: 0 }, label: "" },
        { position: { line: 0 }, label: "bad" },
        { position: { line: 0, character: 0 }, label: [{ value: 1 }] },
      ])
    ).toEqual([]);
    expect(inlayHintsOf(null)).toEqual([]);
  });

  it("capability 明确为 false 时不请求可见区提示", async () => {
    manager.capabilities.mockReturnValue({ inlayHintProvider: false });
    view = new EditorView({
      state: stateFor({ path: "D:/proj/test.ts", contents: "const value = 1;", language: "typescript", readOnly: false, tabSize: 4 }, inlayHintsExtension),
      parent: document.body,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(manager.request).not.toHaveBeenCalled();
  });

  it("正文变化后丢弃旧请求返回的装饰", async () => {
    manager.capabilities.mockReturnValue({ inlayHintProvider: {} });
    let resolveRequest: ((value: unknown) => void) | undefined;
    manager.request.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    view = new EditorView({
      state: stateFor({ path: "D:/proj/test.ts", contents: "value", language: "typescript", readOnly: false, tabSize: 4 }, inlayHintsExtension),
      parent: document.body,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(manager.request).toHaveBeenCalledTimes(1);
    view.dispatch({ changes: { from: 0, insert: "new " } });
    resolveRequest?.([{ position: { line: 0, character: 0 }, label: ": stale" }]);
    await Promise.resolve();
    expect(view.dom.querySelector(".lsp-inlay-hint")).toBeNull();
  });
});

describe("Semantic Tokens 协议与请求生命周期", () => {
  it("解码相对位置、token 类型和 modifier 位图", () => {
    expect(
      semanticTokensOf(
        { data: [0, 0, 5, 0, 1, 0, 6, 3, 1, 2, 1, 0, 4, 1, 0] },
        { tokenTypes: ["variable", "function"], tokenModifiers: ["readonly", "deprecated"] }
      )
    ).toEqual([
      { line: 0, character: 0, length: 5, tokenType: "variable", tokenModifiers: ["readonly"] },
      { line: 0, character: 6, length: 3, tokenType: "function", tokenModifiers: ["deprecated"] },
      { line: 1, character: 0, length: 4, tokenType: "function", tokenModifiers: [] },
    ]);
  });

  it("legend 原样收下，空名字与非法项都留着占位", () => {
    expect(
      legendOf({
        legend: { tokenTypes: ["variable", ""], tokenModifiers: ["readonly", "", "deprecated"] },
      })
    ).toEqual({ tokenTypes: ["variable", ""], tokenModifiers: ["readonly", "", "deprecated"] });
    // 非字符串归一成空串占位，位序号仍然对得上。
    expect(
      legendOf({ legend: { tokenTypes: ["variable"], tokenModifiers: ["readonly", 7, "deprecated"] } })
    ).toEqual({ tokenTypes: ["variable"], tokenModifiers: ["readonly", "", "deprecated"] });
  });

  it("legend 里的空名字只跳过名字，位序号不跟着挪", () => {
    const legend = { tokenTypes: ["variable", ""], tokenModifiers: ["readonly", "", "deprecated"] };
    // 位图 6 = 位 1 与位 2：位 1 是空名字（丢掉），位 2 = "deprecated" 必须照旧命中。
    expect(semanticTokensOf({ data: [0, 0, 5, 0, 6] }, legend)).toEqual([
      { line: 0, character: 0, length: 5, tokenType: "variable", tokenModifiers: ["deprecated"] },
    ]);
    // 类型名本身是空的那个下标没有名字可用，整条丢掉，而不是退成别的类型。
    expect(semanticTokensOf({ data: [0, 0, 5, 1, 0] }, legend)).toEqual([]);
  });

  it("无 legend、false capability 或非法数据时不产生请求/装饰", async () => {
    manager.capabilities.mockReturnValue({ semanticTokensProvider: false });
    view = new EditorView({
      state: stateFor({ path: "D:/proj/test.ts", contents: "const value = 1;", language: "typescript", readOnly: false, tabSize: 4 }, semanticTokensExtension),
      parent: document.body,
    });
    await new Promise((resolve) => setTimeout(resolve, 190));
    expect(manager.request).not.toHaveBeenCalled();
    expect(semanticTokensOf({ data: [0, 0, 1] }, { tokenTypes: ["variable"], tokenModifiers: [] })).toEqual([]);
  });

  it("使用 range capability 请求可见区并丢弃旧正文结果", async () => {
    manager.capabilities.mockReturnValue({
      semanticTokensProvider: {
        range: true,
        legend: { tokenTypes: ["variable"], tokenModifiers: [] },
      },
    });
    let resolveRequest: ((value: unknown) => void) | undefined;
    manager.request.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    view = new EditorView({
      state: stateFor({ path: "D:/proj/test.ts", contents: "value", language: "typescript", readOnly: false, tabSize: 4 }, semanticTokensExtension),
      parent: document.body,
    });
    await new Promise((resolve) => setTimeout(resolve, 190));
    expect(manager.request).toHaveBeenCalledWith(
      "D:/proj/test.ts",
      "typescript",
      "textDocument/semanticTokens/range",
      expect.objectContaining({ range: expect.any(Object) }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    view.dispatch({ changes: { from: 0, insert: "new " } });
    resolveRequest?.({ data: [0, 0, 5, 0, 0] });
    await Promise.resolve();
    expect(view.dom.querySelector(".lsp-semantic-token")).toBeNull();
  });
});

describe("CodeLens 协议与能力边界", () => {
  it("只保留可执行命令并过滤无效范围", () => {
    expect(codeLensesOf([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, command: { title: "Run", command: "run" } },
      { range: { start: { line: -1, character: 0 }, end: { line: 0, character: 2 } }, command: { title: "bad", command: "bad" } },
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } },
    ])).toEqual([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, title: "Run", command: "run", arguments: undefined },
    ]);
  });

  it("capability 明确关闭时不请求 CodeLens", async () => {
    manager.capabilities.mockReturnValue({ codeLensProvider: false });
    view = new EditorView({
      state: stateFor({ path: "D:/proj/test.ts", contents: "value", language: "typescript", readOnly: false, tabSize: 4 }, codeLensExtension),
      parent: document.body,
    });
    await new Promise((resolve) => setTimeout(resolve, 190));
    expect(manager.request).not.toHaveBeenCalled();
  });

  it("点击 CodeLens 只通过 Manager 执行 command", async () => {
    manager.capabilities.mockReturnValue({ codeLensProvider: {} });
    manager.request.mockResolvedValue([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, command: { title: "Run", command: "run.test", arguments: [1] } },
    ]);
    view = new EditorView({
      state: stateFor({ path: "D:/proj/test.ts", contents: "value", language: "typescript", readOnly: false, tabSize: 4 }, codeLensExtension),
      parent: document.body,
    });
    await new Promise((resolve) => setTimeout(resolve, 210));
    view.dom.querySelector<HTMLButtonElement>(".lsp-code-lens-button")?.click();
    expect(manager.executeCommand).toHaveBeenCalledWith("D:/proj/test.ts", "typescript", "run.test", [1]);
  });
});

describe("Inline Completion 协议与接受行为", () => {
  it("兼容数组/对象返回并过滤空插入文本", () => {
    expect(inlineCompletionsOf({ items: [{ insertText: "foo" }, { insertText: "" }, { insertText: "bad", range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } } }, null] })).toEqual([
      { text: "foo", range: undefined },
    ]);
    expect(inlineCompletionsOf(null)).toEqual([]);
  });

  it("capability 明确关闭时不请求，且接受 ghost text 才写入正文", async () => {
    manager.capabilities.mockReturnValue({ inlineCompletionProvider: {} });
    manager.request.mockResolvedValue({ items: [{ insertText: " + 1" }] });
    view = new EditorView({
      state: stateFor({ path: "D:/proj/test.ts", contents: "value", language: "typescript", readOnly: false, tabSize: 4 }, inlineCompletionExtension),
      parent: document.body,
    });
    await new Promise((resolve) => setTimeout(resolve, 210));
    expect(manager.request).toHaveBeenCalledWith(
      "D:/proj/test.ts",
      "typescript",
      "textDocument/inlineCompletion",
      expect.objectContaining({ position: { line: 0, character: 0 } }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    // 初始光标在开头，服务端返回的 ghost text 不应在接受前改动正文。
    expect(view.state.doc.toString()).toBe("value");
    expect(acceptInlineCompletion(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(" + 1value");
  });

  it("provider 为 false 时不发送 inline completion 请求", async () => {
    manager.capabilities.mockReturnValue({ inlineCompletionProvider: false });
    view = new EditorView({
      state: stateFor({ path: "D:/proj/test.ts", contents: "value", language: "typescript", readOnly: false, tabSize: 4 }, inlineCompletionExtension),
      parent: document.body,
    });
    await new Promise((resolve) => setTimeout(resolve, 210));
    expect(manager.request).not.toHaveBeenCalled();
  });
});
