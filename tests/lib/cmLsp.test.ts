// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const lspMock = vi.hoisted(() => ({
  capabilities: vi.fn(),
  positionEncoding: vi.fn(() => "utf-16"),
  request: vi.fn(),
  diagnosticsFor: vi.fn(() => []),
  executeCommand: vi.fn(),
  applyWorkspaceEdit: vi.fn(),
}));

vi.mock("../../src/lib/lspManager", () => ({
  lspManager: lspMock,
}));

import { organizeImports, codeActionsOf, completionWorkspaceEdit, signatureHelpViewOf } from "../../src/lib/cm/lsp";
import { plainSnippetText } from "../../src/lib/cm/snippet";
import { EditorView, stateFor } from "../../src/lib/cmEditor";

describe("CodeMirror LSP 结果归一化", () => {
  it("Optimize Imports 请求整篇文档的 source.organizeImports，并执行服务端动作", async () => {
    lspMock.capabilities.mockReturnValue({ codeActionProvider: true });
    lspMock.request.mockResolvedValue([
      { title: "Organize imports", kind: "source.organizeImports", command: "organize.imports" },
    ]);
    const view = new EditorView({
      state: stateFor({
        path: "D:/proj/a.ts",
        contents: "import z from 'z';\nimport a from 'a';",
        language: "typescript",
        readOnly: false,
        tabSize: 4,
      }),
      parent: document.body,
    });

    expect(organizeImports(view)).toBe(true);
    await vi.waitFor(() => expect(lspMock.request).toHaveBeenCalled());
    expect(lspMock.request).toHaveBeenCalledWith(
      "D:/proj/a.ts",
      "typescript",
      "textDocument/codeAction",
      expect.objectContaining({
        range: {
          start: { line: 0, character: 0 },
          end: { line: 1, character: 18 },
        },
        context: { diagnostics: [], only: ["source.organizeImports"] },
      })
    );
    await vi.waitFor(() => expect(lspMock.executeCommand).toHaveBeenCalledWith(
      "D:/proj/a.ts",
      "typescript",
      "organize.imports",
      undefined
    ));
    view.destroy();
    lspMock.request.mockReset();
    lspMock.capabilities.mockReset();
    lspMock.executeCommand.mockReset();
  });

  it("保留签名、文档说明和活动参数，并夹住越界的活动签名", () => {
    expect(
      signatureHelpViewOf({
        signatures: [
          {
            label: "read(path, encoding)",
            documentation: { kind: "markdown", value: "读取文件" },
            parameters: [{ label: "path" }, { label: "encoding" }],
          },
        ],
        activeSignature: 8,
        activeParameter: 1,
      })
    ).toEqual({
      signatures: [{ label: "read(path, encoding)", documentation: "读取文件", parameters: ["path", "encoding"] }],
      activeSignature: 0,
      activeParameter: 1,
    });
  });

  it("只返回有 edit 或 command 的动作，并统一 command 两种协议写法", () => {
    expect(
      codeActionsOf([
        { title: "导入缺失类型", edit: { changes: {} } },
        { title: "运行修复", command: "fix.import", data: "ignored" },
        { title: "带参数修复", command: { command: "fix.more", arguments: [1] } },
        { title: "无执行内容" },
        null,
      ])
    ).toEqual([
      { title: "导入缺失类型", kind: undefined, edit: { changes: {} }, command: undefined },
      { title: "运行修复", kind: undefined, edit: undefined, command: { command: "fix.import" } },
      { title: "带参数修复", kind: undefined, edit: undefined, command: { command: "fix.more", arguments: [1] } },
    ]);
  });

  it("非法或空的签名结果按无结果处理", () => {
    expect(signatureHelpViewOf(null)).toBeNull();
    expect(signatureHelpViewOf({ signatures: [] })).toBeNull();
    expect(codeActionsOf({ items: [] })).toEqual([]);
  });

  it("自动导入的附加编辑与主补全合并为一个带版本的 WorkspaceEdit", () => {
    const uri = "file:///D:/workspace/a.ts";
    const mainRange = { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } };
    expect(completionWorkspaceEdit(uri, mainRange, "Thing", [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "import Thing from './thing';\n" },
    ], 7)).toEqual({
      documentChanges: [{
        textDocument: { uri, version: 7 },
        edits: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "import Thing from './thing';\n" },
          { range: mainRange, newText: "Thing" },
        ],
      }],
    });
  });

  it("原子自动导入事务把 snippet 降级为默认文本而不写入占位符", () => {
    expect(plainSnippetText("fn(${1:value}, ${2|a,b|})$0")).toBe("fn(value, a)");
  });
});
