// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { disposeModel, stateFor } from "../../src/lib/cmEditor";
import { setOpenTargetHandler } from "../../src/lib/editorEnv";
import { stubTextLayout } from "../helpers/cmLayout";

const manager = vi.hoisted(() => ({
  capabilities: vi.fn(),
  positionEncoding: vi.fn(() => "utf-16"),
  request: vi.fn(),
  watchStatus: vi.fn(() => () => {}),
}));

vi.mock("../../src/lib/lspManager", () => ({ lspManager: manager }));

import { documentLinksExtension, documentLinksOf } from "../../src/lib/cm/lspDocumentLinks";

beforeAll(stubTextLayout);
let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  manager.capabilities.mockReset();
  manager.positionEncoding.mockReset();
  manager.positionEncoding.mockReturnValue("utf-16");
  manager.request.mockReset();
  setOpenTargetHandler(null);
  disposeModel("D:/proj/test.ts");
});

describe("Document Link 协议归一化", () => {
  it("只接受有效 file URI，拒绝未知 scheme、非法范围和空目标", () => {
    expect(documentLinksOf([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        target: "file:///d%3A/proj/other.ts",
        tooltip: "打开定义",
      },
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        target: "untitled:Scratch-1",
      },
      {
        range: { start: { line: -1, character: 0 }, end: { line: 0, character: 2 } },
        target: "file:///d%3A/proj/bad.ts",
      },
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
        target: "file:",
      },
    ])).toEqual([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        target: "d:/proj/other.ts",
        tooltip: "打开定义",
      },
    ]);
    expect(documentLinksOf(null)).toEqual([]);
  });
});

describe("Document Link 请求生命周期", () => {
  it("能力关闭时不请求，能力开启时只在当前正文上挂装饰", async () => {
    manager.capabilities.mockReturnValue({ documentLinkProvider: false });
    view = new EditorView({
      state: stateFor({ path: "D:/proj/test.ts", contents: "other.ts", language: "typescript", readOnly: false, tabSize: 4 }, documentLinksExtension),
      parent: document.body,
    });
    await new Promise((resolve) => setTimeout(resolve, 190));
    expect(manager.request).not.toHaveBeenCalled();

    view.destroy();
    view = null;
    manager.capabilities.mockReturnValue({ documentLinkProvider: {} });
    manager.request.mockResolvedValue([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } }, target: "file:///d%3A/proj/other.ts" },
    ]);
    view = new EditorView({
      state: stateFor({ path: "D:/proj/test.ts", contents: "other.ts", language: "typescript", readOnly: false, tabSize: 4 }, documentLinksExtension),
      parent: document.body,
    });
    await new Promise((resolve) => setTimeout(resolve, 190));
    expect(manager.request).toHaveBeenCalledWith(
      "D:/proj/test.ts",
      "typescript",
      "textDocument/documentLink",
      {},
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(view.dom.querySelector(".lsp-document-link")).not.toBeNull();
  });

  it("正文变化后丢弃旧链接结果", async () => {
    manager.capabilities.mockReturnValue({ documentLinkProvider: {} });
    let resolveRequest: ((value: unknown) => void) | undefined;
    manager.request.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    view = new EditorView({
      state: stateFor({ path: "D:/proj/test.ts", contents: "other.ts", language: "typescript", readOnly: false, tabSize: 4 }, documentLinksExtension),
      parent: document.body,
    });
    await new Promise((resolve) => setTimeout(resolve, 190));
    expect(manager.request).toHaveBeenCalledTimes(1);
    view.dispatch({ changes: { from: 0, insert: "new " } });
    resolveRequest?.([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } }, target: "file:///d%3A/proj/other.ts" },
    ]);
    await Promise.resolve();
    expect(view.dom.querySelector(".lsp-document-link")).toBeNull();
  });

  it("Ctrl/⌘ 点击通过编辑器门面打开 file 目标", async () => {
    manager.capabilities.mockReturnValue({ documentLinkProvider: {} });
    manager.request.mockResolvedValue([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } }, target: "file:///d%3A/proj/other.ts" },
    ]);
    const openTarget = vi.fn(() => true);
    setOpenTargetHandler(openTarget);
    view = new EditorView({
      state: stateFor({ path: "D:/proj/test.ts", contents: "other.ts", language: "typescript", readOnly: false, tabSize: 4 }, documentLinksExtension),
      parent: document.body,
    });
    await new Promise((resolve) => setTimeout(resolve, 190));
    const link = view.dom.querySelector<HTMLElement>(".lsp-document-link");
    expect(link).not.toBeNull();
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true, button: 0, clientX: 4, clientY: 4 }));
    expect(openTarget).toHaveBeenCalledWith("d:/proj/other.ts", 1, 1);
  });
});

