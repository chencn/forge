// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeLocations, locationsExtensions, showLocations } from "../../src/lib/cm/locations";
import { disposeModel, stateFor } from "../../src/lib/cmEditor";
import { setOpenTargetHandler } from "../../src/lib/editorEnv";
import { stubTextLayout } from "../helpers/cmLayout";

/**
 * 跳转结果那块面板。
 *
 * 这里不碰 LSP：`cm/lsp.ts` 那一头在模块顶层就要取 Tauri 的窗口对象，而面板本身
 * 只吃一份位置列表。协议回来的结果怎么变成这张列表，是 lsp 那一层的事。
 */

beforeAll(stubTextLayout);

const PATH = "D:/proj/test.ts";

function mount(contents: string): EditorView {
  return new EditorView({
    state: stateFor({ path: PATH, contents, language: "", readOnly: false, tabSize: 2 }, locationsExtensions),
    parent: window.document.body,
  });
}

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  setOpenTargetHandler(null);
  disposeModel(PATH);
});

describe("跳转结果列表", () => {
  it("开得出、行数对得上、当前文档那行带着正文", () => {
    view = mount("alpha\nbeta");
    showLocations(view, "用法", [
      { path: PATH, line: 2, column: 1, text: "beta" },
      { path: "D:/proj/other.ts", line: 7, column: 3, text: "x" },
    ]);
    const panel = view.dom.querySelector(".lsp-locations");
    expect(panel).not.toBeNull();
    const rows = panel!.querySelectorAll(".lsp-locations-row");
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector(".lsp-locations-where")?.textContent).toBe("test.ts:2");
    expect(rows[0].querySelector(".lsp-locations-text")?.textContent).toBe("beta");
    expect(rows[1].querySelector(".lsp-locations-where")?.textContent).toBe("other.ts:7");
  });

  it("点一行就交回应用去开那份文件，行列按 1 起原样传", () => {
    view = mount("alpha\nbeta");
    const picked = vi.fn(() => true);
    setOpenTargetHandler(picked);
    showLocations(view, "用法", [{ path: "D:/proj/other.ts", line: 7, column: 3, text: "x" }]);
    view.dom.querySelector<HTMLButtonElement>(".lsp-locations-row")!.click();
    expect(picked).toHaveBeenCalledWith("D:/proj/other.ts", 7, 3);
  });

  it("一条结果也没有时写明，不留一块空白面板", () => {
    view = mount("alpha");
    showLocations(view, "用法", []);
    expect(view.dom.querySelector(".lsp-locations-empty")?.textContent).toBeTruthy();
  });

  it("Escape 收掉；没开着时这条命令不算命中", () => {
    view = mount("alpha\nbeta");
    expect(closeLocations(view)).toBe(false);
    showLocations(view, "用法", [{ path: PATH, line: 1, column: 1, text: "alpha" }]);
    const panel = view.dom.querySelector(".lsp-locations")!;
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(view.dom.querySelector(".lsp-locations")).toBeNull();
  });

  it("换文档时面板自己收掉：它挂在那份 state 的 field 上", () => {
    view = mount("alpha\nbeta");
    showLocations(view, "用法", [{ path: PATH, line: 1, column: 1, text: "alpha" }]);
    expect(view.dom.querySelector(".lsp-locations")).not.toBeNull();
    view.setState(stateFor({ path: "D:/proj/next.ts", contents: "one", language: "", readOnly: false, tabSize: 2 }, locationsExtensions));
    expect(view.dom.querySelector(".lsp-locations")).toBeNull();
    disposeModel("D:/proj/next.ts");
  });
});
