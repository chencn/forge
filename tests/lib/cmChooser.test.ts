// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chooserExtensions, closeChooser, showDeclarationChooser } from "../../src/lib/cm/lspChooser";
import { disposeModel, stateFor } from "../../src/lib/cmEditor";
import { setOpenTargetHandler } from "../../src/lib/editorEnv";
import { stubTextLayout } from "../helpers/cmLayout";

/**
 * 跳转目标选择器：定义多处命中时锚在光标处的弹层。
 *
 * 这里不碰 LSP：`cm/lsp.ts` 那一头在模块顶层就要取 Tauri 的窗口对象，选择器
 * 本身只吃一份位置列表。协议回来的结果怎么变成这份候选，是 lsp 那一层的事。
 */

beforeAll(stubTextLayout);

const PATH = "D:/proj/test.ts";

function mount(contents: string): EditorView {
  return new EditorView({
    state: stateFor({ path: PATH, contents, language: "", readOnly: false, tabSize: 2 }, chooserExtensions),
    parent: window.document.body,
  });
}

function press(view: EditorView, key: string): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  setOpenTargetHandler(null);
  disposeModel(PATH);
});

describe("跳转目标选择器", () => {
  it("锚点弹层列得出候选：符号名按目标列取，行预览与「文件:行号」都在", () => {
    view = mount("interface Props {\n  initialQuery?: string;\n}\nconst initialQuery = 1;\n");
    showDeclarationChooser(view, 0, "选择 ‘initialQuery’ 的定义（2 处）", [
      { path: PATH, line: 2, column: 3, text: "initialQuery?: string;" },
      { path: PATH, line: 4, column: 7, text: "const initialQuery = 1;" },
    ]);
    const popup = view.dom.querySelector(".cm-lsp-chooser");
    expect(popup).not.toBeNull();
    expect(popup!.querySelector(".cm-lsp-chooser-title")?.textContent).toBe("选择 ‘initialQuery’ 的定义（2 处）");
    const rows = popup!.querySelectorAll(".cm-lsp-chooser-row");
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector(".cm-lsp-chooser-label")?.textContent).toBe("initialQuery");
    expect(rows[0].querySelector(".cm-lsp-chooser-where")?.textContent).toBe("test.ts:2");
    // 修饰符不算名字：`const initialQuery` 的候选名还是 initialQuery。
    expect(rows[1].querySelector(".cm-lsp-chooser-label")?.textContent).toBe("initialQuery");
  });

  it("点一行就跳：行列按 1 起原样交回，弹层跟着收掉", () => {
    view = mount("alpha\nbeta");
    const picked = vi.fn(() => true);
    setOpenTargetHandler(picked);
    showDeclarationChooser(view, 0, "选择 ‘x’ 的定义（1 处）", [
      { path: PATH, line: 2, column: 1, text: "beta" },
    ]);
    view.dom.querySelector<HTMLButtonElement>(".cm-lsp-chooser-row")!.click();
    expect(picked).toHaveBeenCalledWith(PATH, 2, 1);
    expect(view.dom.querySelector(".cm-lsp-chooser")).toBeNull();
  });

  it("上下键换候选、回车挑当前那条，光标不动", () => {
    view = mount("alpha\nbeta\ngamma");
    const picked = vi.fn(() => true);
    setOpenTargetHandler(picked);
    showDeclarationChooser(view, 0, "选择 ‘x’ 的定义（2 处）", [
      { path: PATH, line: 1, column: 1, text: "alpha" },
      { path: PATH, line: 2, column: 1, text: "beta" },
    ]);
    expect(view.dom.querySelectorAll(".cm-lsp-chooser-row")[0].classList.contains("is-active")).toBe(true);
    press(view, "ArrowDown");
    expect(view.dom.querySelectorAll(".cm-lsp-chooser-row")[1].classList.contains("is-active")).toBe(true);
    expect(view.state.selection.main.head).toBe(0);
    press(view, "Enter");
    expect(picked).toHaveBeenCalledWith(PATH, 2, 1);
    expect(view.dom.querySelector(".cm-lsp-chooser")).toBeNull();
  });

  it("Escape 收掉；没开着时这条命令不算命中，让别的 Escape 命令接着处理", () => {
    view = mount("alpha");
    expect(closeChooser(view)).toBe(false);
    showDeclarationChooser(view, 0, "选择 ‘x’ 的定义（1 处）", [
      { path: PATH, line: 1, column: 1, text: "alpha" },
    ]);
    press(view, "Escape");
    expect(view.dom.querySelector(".cm-lsp-chooser")).toBeNull();
  });
});
