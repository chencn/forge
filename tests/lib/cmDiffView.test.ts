// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDiffView, type DiffNav, type DiffViewOptions } from "../../src/lib/cm/diffView";
import { stubTextLayout } from "../helpers/cmLayout";

/**
 * 比对视图那一段接线。
 *
 * jsdom 没有排版：并排那两栏的行高、对齐垫片都量不出来，这里测的是差异算完之后的
 * 那些决定——几处、能不能走、走与落停在第几行、换排法留住什么。颜色与像素不在这份覆盖里。
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeAll(stubTextLayout);

/** 第 2 行改了，第 5 行是新加的：两处，中间隔着没动的 gamma 与 delta。 */
const ORIGINAL = "alpha\nbeta\ngamma\ndelta\n";
const MODIFIED = "alpha\nBETA\ngamma\ndelta\nEPSILON\n";

const hosts: HTMLElement[] = [];

function mount(options: Omit<DiffViewOptions, "parent">) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  return { host, view: createDiffView({ ...options, parent: host }) };
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

/** 读侧那一栏：并排时是右栏（cm-merge-b），单栏时就是唯一那一栏。 */
function readView(host: HTMLElement): EditorView {
  const editor = host.querySelector<HTMLElement>(".cm-merge-b");
  const view = editor && EditorView.findFromDOM(editor);
  if (!view) throw new Error("读侧那栏没挂上");
  return view;
}

function caretLine(host: HTMLElement): number {
  const view = readView(host);
  return view.state.doc.lineAt(view.state.selection.main.head).number;
}

/** 一栏的正文文字（ jsdom 里量不到行高，只认渲染出来的那几行）。 */
function textOf(host: HTMLElement, selector: string): string {
  return host.querySelector(selector)?.textContent ?? "";
}

/**
 * 行号那一栏里露出来的数字，按顺序。
 * 第一格是撑宽度用的垫片（`visibility: hidden`），不算一行。
 */
function shownNumbers(host: HTMLElement, side: "a" | "b"): string[] {
  return Array.from(host.querySelectorAll<HTMLElement>(`.cm-merge-${side} .cm-lineNumbers .cm-gutterElement`))
    .filter((element) => element.style.visibility !== "hidden")
    .map((element) => element.textContent ?? "");
}

describe("createDiffView 并排那一档", () => {
  it("两栏都挂上，左是基线右是当前", () => {
    const { host } = mount({ original: ORIGINAL, modified: MODIFIED, language: "", mode: "side" });
    expect(host.querySelector(".cm-mergeView")).not.toBeNull();
    expect(host.querySelectorAll(".cm-mergeViewEditor")).toHaveLength(2);
    expect(textOf(host, ".cm-merge-a .cm-content")).toContain("beta");
    expect(textOf(host, ".cm-merge-b .cm-content")).toContain("EPSILON");
  });

  it("两栏都盖 forge-diff：配色那批规则认这个章，不认外框", () => {
    const { host } = mount({ original: ORIGINAL, modified: MODIFIED, language: "", mode: "side" });
    expect(host.querySelectorAll(".cm-editor.cm-merge-a.forge-diff")).toHaveLength(1);
    expect(host.querySelectorAll(".cm-editor.cm-merge-b.forge-diff")).toHaveLength(1);
  });

  it("两栏的装订线都画上改动（比对窗口不再挂右侧概览条）", async () => {
    const { host } = mount({ original: ORIGINAL, modified: MODIFIED, language: "", mode: "side" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    // 左栏：改动的 beta 算改动档；右栏：改动的 BETA 与新加的 EPSILON 各一条。
    expect(host.querySelectorAll(".cm-merge-a .change-lane-bar").length).toBeGreaterThan(0);
    expect(host.querySelectorAll(".cm-merge-b .change-lane-bar").length).toBeGreaterThan(0);
    expect(host.querySelectorAll(".cm-merge-b .cm-overviewMark").length).toBe(0);
  });

  it("首次打开某门语言：语法到货后比对里也补上颜色", async () => {
    // 原来只同步查一次语法表：这门语言的包还没装进内存时就永远是素文本，
    // 于是「第一次看某种语言的比对」没颜色，换一篇再回来看又有了。
    const { host } = mount({
      original: "public class A {\n  int x = 1;\n}\n",
      modified: "public class A {\n  int x = 2;\n}\n",
      language: "java",
      mode: "side",
    });
    // 语法色的类名是引擎现生成的（`ͼ…`），比对的改动块与彩虹括号都用 `cm-` 开头。
    const tinted = () =>
      [...host.querySelectorAll<HTMLElement>(".cm-merge-b .cm-content span")].some(
        (el) => el.className !== "" && !el.className.startsWith("cm-")
      );
    for (let i = 0; i < 40 && !tinted(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(tinted()).toBe(true);
  });

  it("长文件里两处隔得远的改动算两处，词级高亮照旧", () => {
    // 库默认逐字符比，扫到预算就把后面整段认作一处——那样这里只会数到 1，满屏同色。
    const filler = Array.from({ length: 400 }, (_, line) => `line ${line}`).join("\n");
    const original = `${filler}\n`;
    const modified = original
      .replace("line 0\n", "LINE ZERO\n")
      .replace("line 300\n", "line THREE HUNDRED\n");
    const nav: DiffNav[] = [];
    const { host } = mount({ original, modified, language: "", mode: "side", onNav: (item) => nav.push(item) });
    expect(nav[0].count).toBe(2);
    expect(host.querySelectorAll(".cm-changedText").length).toBeGreaterThan(0);
  });

  it("建好就报条数：两处改动，光标在篇首，只能往后走", () => {
    const nav: DiffNav[] = [];
    mount({ original: ORIGINAL, modified: MODIFIED, language: "", mode: "side", onNav: (item) => nav.push(item) });
    expect(nav[0]).toEqual({ count: 2, previous: false, next: true, index: 0 });
  });

  it("下一处落到改动那一行的行首，走到最后一处就不再让走", () => {
    const { host, view } = mount({ original: ORIGINAL, modified: MODIFIED, language: "", mode: "side" });
    view.go("next");
    expect(caretLine(host)).toBe(2);
    view.go("next");
    expect(caretLine(host)).toBe(5);
    expect(view.canGo("next")).toBe(false);
    expect(view.canGo("previous")).toBe(true);
  });

  it("停在某一处上再往回走，走的是上一处而不是这一处", () => {
    const { host, view } = mount({ original: ORIGINAL, modified: MODIFIED, language: "", mode: "side" });
    view.land("last");
    expect(caretLine(host)).toBe(5);
    view.go("previous");
    expect(caretLine(host)).toBe(2);
    view.go("previous");
    // 第 2 行就是首处：没有更早的一处了，箭头该交出去换篇。
    expect(view.canGo("previous")).toBe(false);
  });

  it("从邻篇转过来时落首 / 落末", () => {
    const first = mount({ original: ORIGINAL, modified: MODIFIED, language: "", mode: "side" });
    first.view.land("first");
    expect(caretLine(first.host)).toBe(2);
    const last = mount({ original: ORIGINAL, modified: MODIFIED, language: "", mode: "side" });
    last.view.land("last");
    expect(caretLine(last.host)).toBe(5);
  });

  it("正文一样就没处可走", () => {
    const nav: DiffNav[] = [];
    const { view } = mount({
      original: MODIFIED,
      modified: MODIFIED,
      language: "",
      mode: "side",
      onNav: (item) => nav.push(item),
    });
    expect(nav[0]).toEqual({ count: 0, previous: false, next: false, index: 0 });
    view.go("next");
    view.land("first");
    expect(nav.length).toBe(1);
  });

  it("行号映射由外面给（补丁预览里模型行号不是文件行号）", () => {
    const { host } = mount({
      original: ORIGINAL,
      modified: MODIFIED,
      language: "",
      mode: "side",
      numbers: { original: (line) => `L${line}`, modified: (line) => `N${line}` },
    });
    expect(shownNumbers(host, "a")[0]).toBe("L1");
    expect(shownNumbers(host, "b")[0]).toBe("N1");
  });

  it("两侧都只读，敲不进字", () => {
    const { host } = mount({ original: ORIGINAL, modified: MODIFIED, language: "", mode: "side" });
    expect(readView(host).state.readOnly).toBe(true);
    expect(readView(host).contentDOM.getAttribute("contenteditable")).not.toBe("true");
  });
});

describe("createDiffView 单栏那一档", () => {
  it("只有一栏，删掉的那段摆在改动上面", () => {
    const { host } = mount({ original: ORIGINAL, modified: MODIFIED, language: "", mode: "unified" });
    expect(host.querySelector(".cm-mergeView")).toBeNull();
    expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
    expect(textOf(host, ".cm-deletedChunk")).toContain("beta");
    // 没外框可认，改动色全靠编辑器元素上这一枚章。
    expect(host.querySelectorAll(".cm-editor.cm-merge-b.forge-diff")).toHaveLength(1);
  });

  it("条数与走位和并排一致", () => {
    const nav: DiffNav[] = [];
    const { host, view } = mount({
      original: ORIGINAL,
      modified: MODIFIED,
      language: "",
      mode: "unified",
      onNav: (item) => nav.push(item),
    });
    expect(nav[0]).toEqual({ count: 2, previous: false, next: true, index: 0 });
    view.land("last");
    expect(caretLine(host)).toBe(5);
  });

  it("不给接受 / 拒绝那两颗按钮", () => {
    const { host } = mount({ original: ORIGINAL, modified: MODIFIED, language: "", mode: "unified" });
    expect(host.querySelector(".cm-chunkButtons")).toBeNull();
  });
});

describe("createDiffView 换排法与收摊", () => {
  it("换排法留住光标与条数", () => {
    const nav: DiffNav[] = [];
    const { host, view } = mount({
      original: ORIGINAL,
      modified: MODIFIED,
      language: "",
      mode: "side",
      onNav: (item) => nav.push(item),
    });
    view.land("last");
    view.setMode("unified");
    expect(host.querySelector(".cm-mergeView")).toBeNull();
    expect(caretLine(host)).toBe(5);
    expect(nav[nav.length - 1].count).toBe(2);
    view.setMode("side");
    expect(host.querySelectorAll(".cm-mergeViewEditor")).toHaveLength(2);
    expect(caretLine(host)).toBe(5);
  });

  it("换到同一档不动东西", () => {
    const { host, view } = mount({ original: ORIGINAL, modified: MODIFIED, language: "", mode: "side" });
    view.setMode("side");
    expect(host.querySelectorAll(".cm-mergeView")).toHaveLength(1);
  });

  it("收掉把两栏一起摘走", () => {
    const { host, view } = mount({ original: ORIGINAL, modified: MODIFIED, language: "", mode: "side" });
    view.destroy();
    expect(host.childNodes.length).toBe(0);
    const plain = mount({ original: ORIGINAL, modified: MODIFIED, language: "", mode: "unified" });
    plain.view.destroy();
    expect(plain.host.childNodes.length).toBe(0);
  });
});

describe("比对视图连线带与块提交复选框", () => {
  it("并排模式下左右两栏之间挂载连线分栏区与 SVG 梯形色带（左右高度严格一致）", async () => {
    const { host } = mount({
      original: ORIGINAL,
      modified: MODIFIED,
      language: "",
      mode: "side",
    });
    const splitter = host.querySelector(".forge-diff-splitter");
    expect(splitter).not.toBeNull();
    const svg = splitter?.querySelector(".forge-diff-ribbon-svg");
    expect(svg).not.toBeNull();

    // 等待 requestAnimationFrame 异步连线绘制
    await new Promise((resolve) => setTimeout(resolve, 50));
    const paths = splitter?.querySelectorAll(".forge-diff-ribbon-path");
    expect(paths?.length).toBe(2);
    const borders = splitter?.querySelectorAll(".forge-diff-ribbon-border");
    // 每个改动块有独立的顶底 2 条过渡线（无左右竖直描边）
    expect(borders?.length).toBe(4);
  });

  it("当提供 onChunkOp 时，在连线区左侧渲染 > 回滚按钮并能触发补丁派发", async () => {
    const onChunkOp = vi.fn();
    const { host } = mount({
      original: ORIGINAL,
      modified: MODIFIED,
      language: "",
      mode: "side",
      path: "src/sample.ts",
      onChunkOp,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const revertButtons = host.querySelectorAll<HTMLButtonElement>(".forge-diff-revert-btn");
    expect(revertButtons.length).toBe(2);

    // 点击第 1 个 > 按钮回滚第 1 块
    revertButtons[0].click();
    expect(onChunkOp).toHaveBeenCalledTimes(1);
    expect(onChunkOp).toHaveBeenCalledWith("revert", expect.stringContaining("src/sample.ts"));
  });

  it("修改侧（右栏）行号右侧挂载块级提交复选框 [✓]，且支持点击切换", async () => {
    const onChunkCheck = vi.fn();
    const { host } = mount({
      original: ORIGINAL,
      modified: MODIFIED,
      language: "",
      mode: "side",
      onChunkCheck,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const checkboxes = host.querySelectorAll<HTMLElement>(".cm-diff-chunk-checkbox");
    expect(checkboxes.length).toBe(2);

    // 默认全选
    expect(checkboxes[0].classList.contains("is-checked")).toBe(true);
    expect(checkboxes[1].classList.contains("is-checked")).toBe(true);

    // 点击第 1 个复选框取消勾选（CodeMirror gutter 重新挂载新 DOM 节点）
    checkboxes[0].click();
    const afterFirstClick = host.querySelectorAll<HTMLElement>(".cm-diff-chunk-checkbox");
    expect(afterFirstClick[0].classList.contains("is-checked")).toBe(false);
    expect(onChunkCheck).toHaveBeenCalledWith(0, false, expect.anything());

    // 再次点击恢复勾选
    afterFirstClick[0].click();
    const afterSecondClick = host.querySelectorAll<HTMLElement>(".cm-diff-chunk-checkbox");
    expect(afterSecondClick[0].classList.contains("is-checked")).toBe(true);
    expect(onChunkCheck).toHaveBeenCalledWith(0, true, expect.anything());
  });

  it.each([
    { name: "纵向滚轮驱动共同滚动", wheel: { deltaY: 100 }, syncScroll: true, expectedTop: 100 },
    { name: "横向手势不驱动纵向滚动", wheel: { deltaX: 120, deltaY: 20 }, syncScroll: true, expectedTop: 0 },
    { name: "Shift 滚轮留给横向滚动", wheel: { deltaY: 100, shiftKey: true }, syncScroll: true, expectedTop: 0 },
    { name: "Ctrl 滚轮留给缩放", wheel: { deltaY: 100, ctrlKey: true }, syncScroll: true, expectedTop: 0 },
    { name: "取消同步后由各栏处理纵向滚轮", wheel: { deltaY: 100 }, syncScroll: false, expectedTop: 0 },
  ])("$name", ({ wheel, syncScroll, expectedTop }) => {
    const { host } = mount({
      original: ORIGINAL,
      modified: MODIFIED,
      language: "",
      mode: "side",
      syncScroll,
    });
    const mergeEl = host.querySelector<HTMLElement>(".cm-mergeView");
    expect(mergeEl).not.toBeNull();

    // 模拟存在可滚动内容
    Object.defineProperty(mergeEl, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(mergeEl, "clientHeight", { value: 300, configurable: true });
    mergeEl!.scrollTop = 0;

    // 验证公开输入行为：横向或带修饰键的手势必须继续交给浏览器与当前栏。
    const event = new WheelEvent("wheel", { ...wheel, bubbles: true, cancelable: true });
    mergeEl!.dispatchEvent(event);

    expect(mergeEl!.scrollTop).toBe(expectedTop);
    expect(event.defaultPrevented).toBe(expectedTop > 0);
  });
});


describe('比对快捷键跟随方案与焦点', () => {
  it('无外层回调时，导航当前侧改动并可切换两侧焦点', () => {
    const { host, view } = mount({ original: ORIGINAL, modified: MODIFIED, language: '', mode: 'side' });
    const right = readView(host);
    const left = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-merge-a')!)!;
    const press = (editor: EditorView, key: string, modifiers: KeyboardEventInit = {}) => editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers }));
    press(right, 'F7');
    expect(caretLine(host)).toBe(2);
    press(right, 'ArrowRight', { altKey: true, shiftKey: true });
    expect(caretLine(host)).toBe(5);
    right.focus();
    press(right, 'Tab', { ctrlKey: true, shiftKey: true });
    expect(left.hasFocus).toBe(true);
    press(left, 'F7');
    expect(left.state.doc.lineAt(left.state.selection.main.head).number).toBe(2);
    expect(caretLine(host)).toBe(5);
    view.setKeymap('vscode');
    press(right, 'F5', { altKey: true, shiftKey: true });
    expect(caretLine(host)).toBe(2);
    view.destroy();
  });

  it('切换方案即时换差异导航键，保留光标和只读边界', () => {
    const onStep = vi.fn();
    const onJumpSource = vi.fn();
    const { host, view } = mount({ original: ORIGINAL, modified: MODIFIED, language: '', mode: 'side', onStep, onJumpSource });
    const editor = readView(host);
    const press = (key: string, modifiers: KeyboardEventInit = {}) => editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers }));
    press('F7');
    expect(onStep).toHaveBeenLastCalledWith('next');
    view.land('last');
    const before = editor.state.selection.main.head;
    view.setKeymap('vscode');
    onStep.mockClear();
    press('F7');
    expect(onStep).not.toHaveBeenCalled();
    press('F5', { altKey: true });
    expect(onStep).toHaveBeenLastCalledWith('next');
    expect(editor.state.selection.main.head).toBe(before);
    expect(editor.state.readOnly).toBe(true);
    press('F4');
    expect(onJumpSource).toHaveBeenCalledOnce();
    view.destroy();
  });
});
