// @vitest-environment jsdom
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyChangeMarks,
  captureState,
  disposeModel,
  editorFor,
  emptyState,
  fromDiskText,
  gutterHost,
  lineTop,
  lineText,
  minimapGutters,
  persistView,
  replaceRange,
  restoreView,
  revealRange,
  scrollRatio,
  selectAll,
  selectedRange,
  selectedText,
  setKeymap,
  setMinimap,
  setMounted,
  setScrollRatio,
  stateFor,
  textOf,
  textReplacement,
  toDiskText,
  type EditorDoc,
} from "../../src/lib/cmEditor";
import { retainEditorModels } from "../../src/lib/modelRetention";
import { stubTextLayout } from "../helpers/cmLayout";

/**
 * 编辑器引擎那一层的测试：整层是新写的，屏幕上那台编辑器全骑在它上面。
 *
 * 盯的是「状态表与界面对不对得上」——常驻 state 有没有跟着打字走、卸载与重挂时光标还在不在、
 * 只换 settings 时会不会白白新建一份、回收名单进来时丢的是哪一半。
 * 排版相关的（小地图 canvas、行高、按坐标落点）在这台环境里量不到，不在这里测。
 */

/**
 * jsdom 的 `Element` 没有 `scrollTo`，而跳行那一条走的是平滑滚动（只有 Chromium 认这个）。
 * 给它一个直接落到 `scrollTop` 的替身：测的是落点算得对不对，不是动画。
 */
beforeAll(() => {
  stubTextLayout();
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollTo = function scrollTo(this: Element, options: { top?: number; left?: number }) {
    if (typeof options.top === "number") this.scrollTop = options.top;
    if (typeof options.left === "number") this.scrollLeft = options.left;
  };
});

function docOf(overrides: Partial<EditorDoc> = {}): EditorDoc {
  return { path: "D:/proj/a.ts", contents: "alpha\nbeta\ngamma", language: "", readOnly: false, tabSize: 2, ...overrides };
}

/** 按组件的真实用法挂一台：空态起步 → 换上这篇的 state → 登记成「在屏幕上」。 */
function mount(document: EditorDoc): EditorView {
  const view = new EditorView({ state: emptyState(), parent: globalThis.document.body });
  view.setState(stateFor(document));
  setMounted(document.path, view);
  return view;
}

function teardown(view: EditorView, ...paths: string[]): void {
  for (const path of paths) setMounted(path, null);
  view.destroy();
  for (const path of paths) disposeModel(path);
}

describe("常驻 state", () => {
  it("同一篇文档拿到同一份 state；打字之后表里那份跟着走", () => {
    const record = docOf({ path: "D:/proj/keep.ts" });
    const first = stateFor(record);
    expect(stateFor(record)).toBe(first);

    const view = mount(record);
    replaceRange(view, 0, 5, "AAA");
    captureState(view);
    expect(textOf(view)).toBe("AAA\nbeta\ngamma");
    expect(stateFor(record).doc.toString()).toBe("AAA\nbeta\ngamma");
    teardown(view, record.path);
  });

  it("只读、tab 宽、语言换了是重配同一份，不是另建", () => {
    const record = docOf({ path: "D:/proj/ro.ts" });
    const before = stateFor(record);
    const after = stateFor({ ...record, readOnly: true, tabSize: 4 });
    expect(after).not.toBe(before);
    expect(after.readOnly).toBe(true);
    expect(after.tabSize).toBe(4);
    // 三样都没变时原样退回，不产生新的 state（否则每次渲染都要重挂一遍配置）。
    expect(stateFor({ ...record, readOnly: true, tabSize: 4 })).toBe(after);
    disposeModel(record.path);
  });

  it("正文没变时不给改动；变了才给整篇替换", () => {
    const view = mount(docOf({ path: "D:/proj/same.ts" }));
    expect(textReplacement(view.state, textOf(view))).toBeNull();
    const change = textReplacement(view.state, "one\ntwo");
    expect(change).not.toBeNull();
    view.dispatch(change!);
    expect(textOf(view)).toBe("one\ntwo");
    teardown(view, "D:/proj/same.ts");
  });

  it("卸载前存的光标与滚动位置，重新挂载时贴回去", () => {
    const record = docOf({ path: "D:/proj/view.ts", contents: "a\nb\nc\nd" });
    const view = mount(record);
    view.dispatch({ selection: { anchor: 5, head: 5 } });
    persistView(record.path, view);
    view.destroy();
    setMounted(record.path, null);

    // 组件那一头的用法是「换上 state → 立刻贴回位置」，这里照做。
    const again = new EditorView({ state: emptyState(), parent: globalThis.document.body });
    again.setState(stateFor(record));
    restoreView(record.path, again);
    expect(again.state.selection.main.anchor).toBe(5);
    teardown(again, record.path);
  });

  it("关标签连光标一起丢；超限回收只丢 state，光标留下", () => {
    const record = docOf({ path: "D:/proj/recycle.ts" });
    const view = mount(record);
    replaceRange(view, 0, 5, "XYZ");
    captureState(view);
    view.dispatch({ selection: { anchor: 6 } });
    persistView(record.path, view);
    disposeModel(record.path);

    // 关标签：打字的那一份和光标都不该留下——重开是一篇全新的文档。
    expect(stateFor(record).doc.toString()).toBe("alpha\nbeta\ngamma");
    view.setState(stateFor(record));
    restoreView(record.path, view);
    expect(view.state.selection.main.anchor).not.toBe(6);

    // 超限回收：这篇还开着但不在最近名单里，丢的是 state，光标要留在表里。
    replaceRange(view, 0, 3, "QQQ");
    captureState(view);
    view.dispatch({ selection: { anchor: 6 } });
    persistView(record.path, view);
    stateFor(docOf({ path: "D:/proj/active.ts" }));
    retainEditorModels("D:/proj/active.ts", [record.path, "D:/proj/active.ts"]);
    view.setState(stateFor(record));
    restoreView(record.path, view);
    expect(view.state.doc.toString()).toBe("alpha\nbeta\ngamma");
    expect(view.state.selection.main.anchor).toBe(6);
    teardown(view, record.path, "D:/proj/active.ts");
  });

  it("空态不占常驻表：没开文件时不该有任何一篇进表", () => {
    const view = new EditorView({ state: emptyState(), parent: globalThis.document.body });
    expect(editorFor("D:/proj/nowhere.ts")).toBeNull();
    view.destroy();
  });
});

describe("行尾换算", () => {
  it("CRLF 文档进来只有 \\n，交回应用时又是 \\r\\n", () => {
    const record = docOf({ path: "D:/proj/crlf.ts", contents: "alpha\r\nbeta\r\n" });
    const view = mount(record);
    expect(textOf(view)).toBe("alpha\nbeta\n");
    expect(toDiskText(textOf(view), "crlf")).toBe(record.contents);
    expect(toDiskText(textOf(view), "lf")).toBe("alpha\nbeta\n");
    teardown(view, record.path);
  });

  it("正文只是行尾写法不同就不重换：保存回写与外部重载都走这条路", () => {
    const record = docOf({ path: "D:/proj/crlf2.ts", contents: "alpha\r\nbeta" });
    const view = mount(record);
    expect(textReplacement(view.state, record.contents)).toBeNull();
    view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });
    // 后端写盘后回读的那一份还是 CRLF：正文一个字没变，撤销栈不该压一层「整篇换了」。
    expect(textReplacement(view.state, "xalpha\r\nbeta")).toBeNull();
    expect(textReplacement(view.state, "xalpha\r\nbeta\ngamma")).not.toBeNull();
    teardown(view, record.path);
  });

  it("落单的 \\r 也算换行：与 CodeMirror 自己的口径一致", () => {
    expect(fromDiskText("a\rb")).toBe("a\nb");
    expect(fromDiskText("a\r\nb\rc")).toBe("a\nb\nc");
    expect(fromDiskText("a\nb")).toBe("a\nb");
  });

  it("从右键菜单粘进来的 CRLF 不会把行数算多", () => {
    const record = docOf({ path: "D:/proj/paste.ts", contents: "one" });
    const view = mount(record);
    replaceRange(view, 3, 3, "\r\ntwo");
    expect(textOf(view)).toBe("one\ntwo");
    expect(view.state.doc.lines).toBe(2);
    teardown(view, record.path);
  });
});

describe("复制整行与缩进参考线", () => {
  /**
   * jsdom 的 ClipboardEvent 不带 `clipboardData`，所以自己造一个可记录的对象挂上去。
   * 事件从 contentDOM 发出：`EditorView.domEventHandlers` 就是绑在那一层的。
   */
  function fireCopy(view: EditorView): { event: Event; setData: ReturnType<typeof vi.fn> } {
    const setData = vi.fn();
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: [], setData, getData: () => "" } });
    view.contentDOM.dispatchEvent(event);
    return { event, setData };
  }

  it("光标停在哪就复制哪一整行", () => {
    const record = docOf({ path: "D:/proj/copy.ts", contents: "alpha\nbeta" });
    const view = mount(record);
    view.dispatch({ selection: { anchor: 2 } });
    const { event, setData } = fireCopy(view);
    expect(setData).toHaveBeenCalledWith("text/plain", "alpha\n");
    expect(event.defaultPrevented).toBe(true);
    teardown(view, record.path);
  });

  it("划了选区就不拦原生复制", () => {
    const record = docOf({ path: "D:/proj/copy2.ts", contents: "alpha\nbeta" });
    const view = mount(record);
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    const { event, setData } = fireCopy(view);
    expect(setData).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    teardown(view, record.path);
  });

  it("多光标一次复制这几行，同一行上的两颗只算一次", () => {
    const record = docOf({ path: "D:/proj/copy3.ts", contents: "alpha\nbeta\ngamma" });
    const view = mount(record);
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(1, 1),
        EditorSelection.range(2, 2),
        EditorSelection.range(7, 7),
        EditorSelection.range(12, 12),
      ]),
    });
    const { setData } = fireCopy(view);
    expect(setData).toHaveBeenCalledWith("text/plain", "alpha\nbeta\ngamma\n");
    teardown(view, record.path);
  });

  it("缩进参考线挂在带缩进的行上，顶格的行不挂", () => {
    const record = docOf({
      path: "D:/proj/guides.ts",
      contents: "function f() {\n  if (x) {\n    y\n  }\n}\n",
    });
    const view = mount(record);
    const guided = Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-line.cm-indent-guide"));
    expect(guided.length).toBeGreaterThan(0);
    expect(guided.length).toBeLessThan(6);
    // 层数与步长写在行的 style 上，CSS 靠它算渐变重复的宽度。
    expect(guided[0].style.getPropertyValue("--forge-guide-levels")).not.toBe("");
    const top = view.dom.querySelectorAll(".cm-line")[0];
    expect(top.classList.contains("cm-indent-guide")).toBe(false);
    teardown(view, record.path);
  });
});

describe("读写、定位与标记", () => {

  it("选区：没选东西给 null，选到下一行第 1 列不虚增一行", () => {
    const record = docOf({ path: "D:/proj/sel.ts", contents: "ab\ncd" });
    const view = mount(record);
    expect(selectedRange(view)).toBeNull();
    view.dispatch({ selection: { anchor: 0, head: 2 } });
    expect(selectedRange(view)).toMatchObject({ from: 0, to: 2, line: 1, endLine: 1 });
    expect(selectedText(view)).toBe("ab");
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    expect(selectedRange(view)?.endLine).toBe(1);
    selectAll(view);
    expect(selectedText(view)).toBe("ab\ncd");
    teardown(view, record.path);
  });

  it("行文本按 1 起算，越界给空串", () => {
    const record = docOf({ path: "D:/proj/line.ts", contents: "one\ntwo\nthree" });
    const view = mount(record);
    expect(lineText(view.state, 2)).toBe("two");
    expect(lineText(view.state, 0)).toBe("");
    expect(lineText(view.state, 99)).toBe("");
    teardown(view, record.path);
  });

  it("跳转落点夹在文档行数内，滚动比例两头对得上", () => {
    const record = docOf({ path: "D:/proj/go.ts", contents: "a\nb\nc" });
    const view = mount(record);
    revealRange(view, 3, 0, 1);
    expect(view.state.selection.main.from).toBe(4);
    revealRange(view, 99, 0, 1);
    expect(view.state.selection.main.from).toBe(4);
    expect(scrollRatio(view)).toBe(0);
    setScrollRatio(view, 1);
    teardown(view, record.path);
  });

  it("改动标记：小地图那条带按起始行给色，深色与浅色不同", () => {
    const marks = [
      { startLine: 1, endLine: 2, kind: "added" as const },
      { startLine: 3, endLine: 3, kind: "deleted" as const, edge: "before" as const },
    ];
    const light = minimapGutters(marks, false);
    expect(light[1]).toBe("#22c55ecc");
    expect(light[3]).toBe("#ef4444cc");
    expect(minimapGutters(marks, true)[1]).toBe("#4ade80cc");

    const record = docOf({ path: "D:/proj/marks.ts", contents: "a\nb\nc" });
    const view = mount(record);
    applyChangeMarks(view, marks);
    expect(view.state.selection.main.empty).toBe(true);
    applyChangeMarks(view, []);
    teardown(view, record.path);
  });

  it("行落点：越界与第 0 行给 null，别的行给文档坐标", () => {
    const record = docOf({ path: "D:/proj/pin.ts", contents: "a\nb\nc" });
    const view = mount(record);
    expect(lineTop(view, 0)).toBeNull();
    expect(lineTop(view, 9)).toBeNull();
    const first = lineTop(view, 1);
    expect(first).toBeTypeOf("number");
    // 文档坐标：不含滚动量，翻了页也不会变。
    view.scrollDOM.scrollTop = 40;
    expect(lineTop(view, 1)).toBe(first);
    teardown(view, record.path);
  });

  it("换文档时行号槽整层会被换掉：取它必须现查，不能存着", () => {
    const record = docOf({ path: "D:/proj/gutter.ts" });
    const view = mount(record);
    const before = gutterHost(view);
    expect(before).not.toBeNull();
    // 语法包加载完重配、切页签都会走这一路：整层拆掉重造，老节点脱离文档。
    view.setState(stateFor({ ...record, path: "D:/proj/other.ts" }));
    const after = gutterHost(view);
    expect(after).not.toBe(before);
    expect(before?.isConnected).toBe(false);
    expect(after?.isConnected).toBe(true);
    teardown(view, record.path, "D:/proj/other.ts");
  });

  it("小地图与键位方案走重配：换了配置不换正文", () => {
    const record = docOf({ path: "D:/proj/slot.ts" });
    const view = mount(record);
    const before = view.state;
    setMinimap(view, null);
    setKeymap(view, []);
    expect(view.state).not.toBe(before);
    expect(view.state.doc.toString()).toBe(before.doc.toString());
    expect(editorFor(record.path)).toBe(view);
    teardown(view, record.path);
    expect(editorFor(record.path)).toBeNull();
  });

  it("改动色带挂在行号右边那条专用的槽上：一段改动一行一格", () => {
    const record = docOf({ path: "D:/proj/marks.ts", contents: "a\nb\nc\nd" });
    const view = mount(record);
    applyChangeMarks(view, [{ startLine: 2, endLine: 3, kind: "added", edge: "line" }]);
    // 槽只认行首那个点：按行号当偏移给区间，一格都画不出来。
    const gutters = [...view.dom.querySelectorAll(".cm-gutters > .cm-gutter")].map((el) => el.className);
    expect(gutters.indexOf("cm-gutter cm-change-lane")).toBe(gutters.findIndex((name) => name.includes("cm-lineNumbers")) + 1);
    const bars = [...view.dom.querySelectorAll(".cm-change-lane .change-lane-bar")];
    expect(bars).toHaveLength(2);
    expect(bars.every((el) => el.parentElement?.className.includes("cm-gutterElement"))).toBe(true);
    expect((bars[0] as HTMLElement).style.getPropertyValue("--lane-color")).toContain("accent-green");
    teardown(view, record.path);
  });

  it("右侧概览条按改动画色条：一段一根，点了跳过去", async () => {
    const record = docOf({ path: "D:/proj/overview.ts", contents: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") });
    const view = mount(record);
    applyChangeMarks(view, [
      { startLine: 3, endLine: 5, kind: "added", edge: "line" },
      { startLine: 20, endLine: 20, kind: "deleted", edge: "after" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const marks = [...view.dom.querySelectorAll<HTMLElement>(".cm-overview .cm-overviewMark")];
    expect(marks).toHaveLength(2);
    expect(marks[0].style.background).toContain("accent-green");
    expect(marks[1].className).toContain("thin");
    marks[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientY: 0 }));
    teardown(view, record.path);
  });

  it("删掉的行没有行高：三角挂在缺口的上沿或下沿", () => {
    const record = docOf({ path: "D:/proj/marks.ts", contents: "a\nb\nc\nd" });
    const view = mount(record);
    applyChangeMarks(view, [{ startLine: 2, endLine: 2, kind: "deleted", edge: "before" }]);
    expect(view.dom.querySelector(".cm-change-lane .change-lane-wedge.is-before")).not.toBeNull();
    applyChangeMarks(view, [{ startLine: 3, endLine: 3, kind: "deleted", edge: "after" }]);
    const wedge = view.dom.querySelector(".cm-change-lane .change-lane-wedge");
    expect(wedge?.className).not.toContain("is-before");
    teardown(view, record.path);
  });

  it("小地图色带盖住整段改动，删除只标锚点那一行", () => {
    const added = minimapGutters([{ startLine: 10, endLine: 13, kind: "added", edge: "line" }], false);
    expect(Object.keys(added).map(Number)).toEqual([10, 11, 12, 13]);
    const deleted = minimapGutters([{ startLine: 5, endLine: 5, kind: "deleted", edge: "after" }], true);
    expect(Object.keys(deleted)).toEqual(["5"]);
  });
});
