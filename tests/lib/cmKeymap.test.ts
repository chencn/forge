// @vitest-environment jsdom
import { EditorSelection } from "@codemirror/state";
import { foldEffect, foldedRanges } from "@codemirror/language";
import { getSearchQuery, SearchQuery, searchPanelOpen, setSearchQuery } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { base as KEY_CODES, shift as SHIFT_CODES } from "w3c-keyname";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { forgeKeymap, keymapBindings } from "../../src/lib/cm/keymap";
import { disposeModel, loadLanguage, setKeymap, stateFor } from "../../src/lib/cmEditor";
import type { KeymapScheme } from "../../src/lib/settings";
import { stubTextLayout } from "../helpers/cmLayout";
import { translate as t } from "../../src/i18n";

/**
 * 键位方案的两件事：
 *
 * 一、这串键名引擎认不认。CodeMirror 把绑定串的最后一段**原样**拿去和按键事件给的名字比对，
 * 所以 `Ctrl-Slash`、`Ctrl-Minus` 不报错，只是永远按不动的死键；字母也得写成小写
 * （`Ctrl-D` 死、`Ctrl-d` 活）。合法的末段要么是一个字符，要么出现在引擎自己那份
 * `w3c-keyname` 的名字表里，再加它特判的 Space。
 *
 * 二、按下之后正文真的动了。防止键名对上了但接错命令。
 */

/** 按键事件能给出的名字：表里那些具名键，外加引擎特判的 Space。 */
const NAMED_KEYS = new Set<string>([...Object.values(KEY_CODES), "Space"]);

/** 具名键对应的 keyCode：jsdom 不会自己算，而 CodeMirror 认Shift组合时要回查这张表。 */
const CODE_OF: Record<string, number> = {};
for (const [code, name] of Object.entries(KEY_CODES)) CODE_OF[name] = Number(code);

function terminalOf(key: string): string {
  return key.split(/-(?!$)/).at(-1) as string;
}

beforeAll(stubTextLayout);

const mounted: Array<{ view: EditorView; path: string }> = [];
let documentId = 0;
afterEach(() => {
  for (const { view, path } of mounted.splice(0)) {
    if (view.dom.isConnected) view.destroy();
    disposeModel(path);
  }
});

function mount(doc: string, scheme: KeymapScheme, caret = 0, readOnly = false, language = ""): EditorView {
  const path = `D:/shortcut-tests/${documentId++}.txt`;
  // 使用生产装配入口，才能捕获底层默认键覆盖方案、多光标或撤销失效的回归。
  const view = new EditorView({
    state: stateFor({ path, contents: doc, language, readOnly, tabSize: 2 }),
    parent: document.body,
  });
  setKeymap(view, forgeKeymap(scheme));
  view.dispatch({ selection: { anchor: caret } });
  mounted.push({ view, path });
  return view;
}

/** 按一张表里的绑定串去按一次键：末段是字符就直接给字符，是具名键就补上 keyCode。 */
function pressKey(view: EditorView, key: string, target: HTMLElement = view.contentDOM): void {
  const parts = key.split(/-(?!$)/);
  const terminal = parts[parts.length - 1];
  const init: KeyboardEventInit & { keyCode?: number } = {
    ctrlKey: parts.some((part) => /^(c(trl|ontrol)|mod)$/i.test(part)),
    altKey: parts.some((part) => /^a(lt)?$/i.test(part)),
    shiftKey: parts.some((part) => /^s(hift)?$/i.test(part)),
  };
  if (terminal === "Space") {
    init.key = " ";
    init.keyCode = 32;
  } else {
    init.key = terminal;
    const code = CODE_OF[terminal];
    if (code !== undefined) {
      init.keyCode = code;
      // 真实 Shift+字母/符号事件给大写/上档字符，不能伪造成 Ctrl+小写而命中另一条键。
      if (init.shiftKey) init.key = SHIFT_CODES[code] ?? terminal;
    }
  }
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
  target.dispatchEvent(event);
}

/** 从真实面板输入，覆盖查询同步、命令和文档修改的完整边界。 */
function enterSearch(view: EditorView, name: "search" | "replace", value: string): HTMLTextAreaElement {
  const input = view.dom.querySelector<HTMLTextAreaElement>(`[name="${name}"]`)!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return input;
}

function clickSearch(view: EditorView, label: string): void {
  const button = [...view.dom.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label") === label);
  expect(button, label).toBeDefined();
  button!.click();
}

describe("文件内查找", () => {
  it.each([["idea", "Ctrl-r"], ["vscode", "Ctrl-h"]] as const)("%s：查找框内可打开替换，Tab 聚焦替换，Enter 执行替换", (scheme, shortcut) => {
    const view = mount("alpha beta alpha", scheme);
    pressKey(view, "Ctrl-f");
    const input = enterSearch(view, "search", "alpha");
    pressKey(view, shortcut, input);
    pressKey(view, "Tab", input);
    const replace = enterSearch(view, "replace", "gamma");
    expect(document.activeElement).toBe(replace);
    pressKey(view, "Enter", replace);
    expect(view.state.doc.toString()).toBe("gamma beta alpha");
  });

  it("多行查询和搜索历史可恢复；只读模式执行替换入口也不会修改正文", () => {
    const view = mount("alpha\nbeta\nalpha\nbeta", "idea");
    pressKey(view, "Ctrl-f");
    const input = enterSearch(view, "search", "alpha");
    input.setSelectionRange(5, 5);
    pressKey(view, "Ctrl-Shift-Enter", input);
    expect(getSearchQuery(view.state).search).toBe("alpha\n");
    enterSearch(view, "search", "alpha\nbeta");
    pressKey(view, "Enter", input);
    expect(view.state.selection.main.from).toBe(11);
    enterSearch(view, "search", "something else");
    clickSearch(view, t("editor.find.history"));
    clickSearch(view, "alpha\nbeta");
    expect(getSearchQuery(view.state).search).toBe("alpha\nbeta");
    const readonly = mount("alpha", "idea", 0, true);
    pressKey(readonly, "Ctrl-r");
    const readonlyInput = enterSearch(readonly, "search", "alpha");
    pressKey(readonly, "Enter", readonlyInput);
    expect(readonly.state.doc.toString()).toBe("alpha");
    expect(readonly.state.sliceDoc(readonly.state.selection.main.from, readonly.state.selection.main.to)).toBe("alpha");
  });

  it("输入立即选中命中，Enter / Shift+Enter 循环导航，Escape 返回编辑器", () => {
    const view = mount("alpha beta alpha", "idea");
    pressKey(view, "Ctrl-f");
    const input = enterSearch(view, "search", "alpha");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("alpha");
    expect(view.state.selection.main.from).toBe(0);
    pressKey(view, "Enter", input);
    expect(view.state.selection.main.from).toBe(11);
    pressKey(view, "Shift-Enter", input);
    expect(view.state.selection.main.from).toBe(0);
    pressKey(view, "Escape", input);
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(view.hasFocus).toBe(true);
  });

  it("大小写和整词开关实际过滤命中，普通查询中的反斜杠保持字面值", () => {
    const view = mount(String.raw`ALPHA alphabet alpha alpha\nbeta` + "\nalpha\nbeta", "idea");
    pressKey(view, "Ctrl-f");
    enterSearch(view, "search", "alpha");
    view.dom.querySelector<HTMLButtonElement>("button[name=caseSensitive]")!.click();
    view.dom.querySelector<HTMLButtonElement>("button[name=wholeWord]")!.click();
    expect(view.state.selection.main.from).toBe(15);
    enterSearch(view, "search", String.raw`alpha\nbeta`);
    const selected = view.state.selection.main;
    expect(view.state.sliceDoc(selected.from, selected.to)).toBe(String.raw`alpha\nbeta`);
    expect(getSearchQuery(view.state).literal).toBe(true);
  });

  it("正则替换保留捕获组语义；无效正则不能修改文档", () => {
    const view = mount("foo1 foo2", "idea");
    pressKey(view, "Ctrl-r");
    view.dom.querySelector<HTMLButtonElement>("button[name=regexp]")!.click();
    const input = enterSearch(view, "search", "(");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    enterSearch(view, "replace", "broken");
    clickSearch(view, t("editor.cm.replaceAll"));
    expect(view.state.doc.toString()).toBe("foo1 foo2");
    enterSearch(view, "search", String.raw`(foo)(\d)`);
    enterSearch(view, "replace", "$2-$1");
    clickSearch(view, t("editor.cm.replaceAll"));
    expect(view.state.doc.toString()).toBe("1-foo 2-foo");
  });

  it("多行选区替换只修改范围内命中，连续替换映射范围，关闭后恢复全文件查找", () => {
    const view = mount("foo\nfoo\noutside foo", "idea");
    view.dispatch({ selection: { anchor: 0, head: 7 } });
    pressKey(view, "Ctrl-r");
    enterSearch(view, "search", "foo");
    enterSearch(view, "replace", "x");
    clickSearch(view, t("editor.cm.replace"));
    clickSearch(view, t("editor.cm.replaceAll"));
    expect(view.state.doc.toString()).toBe("x\nx\noutside foo");
    const input = view.dom.querySelector<HTMLTextAreaElement>("[name=search]")!;
    pressKey(view, "Escape", input);
    view.dispatch({ selection: { anchor: 0 } });
    pressKey(view, "Ctrl-f");
    enterSearch(view, "search", "foo");
    expect(view.state.selection.main.from).toBe(12);
  });

  it("搜索范围筛选使用语法上下文，替换时同样排除范围外文本", async () => {
    await loadLanguage("javascript");
    const view = mount('const foo = "foo"; // foo\nfoo();', "idea", 0, false, "javascript");
    pressKey(view, "Ctrl-r");
    enterSearch(view, "search", "foo");
    enterSearch(view, "replace", "bar");
    clickSearch(view, t("editor.find.filter"));
    clickSearch(view, t("editor.find.inComments"));
    expect(view.state.selection.main.from).toBe(22);
    clickSearch(view, t("editor.cm.replaceAll"));
    expect(view.state.doc.toString()).toBe('const foo = "foo"; // bar\nfoo();');
  });

  it("字符串范围筛选保留模板文本，排除插值中的代码", async () => {
    await loadLanguage("javascript");
    const view = mount('const text = `foo ${foo}`;', "idea", 0, false, "javascript");
    pressKey(view, "Ctrl-r");
    enterSearch(view, "search", "foo");
    enterSearch(view, "replace", "bar");
    clickSearch(view, t("editor.find.filter"));
    clickSearch(view, t("editor.find.inStrings"));
    clickSearch(view, t("editor.cm.replaceAll"));
    expect(view.state.doc.toString()).toBe('const text = `bar ${foo}`;');
  });
});

describe("键位方案", () => {
  it("每条绑定的末段都是按键事件真会给出的名字", () => {
    for (const [scheme, bindings] of keymapBindings()) {
      for (const binding of bindings) {
        for (const chord of binding.key.split(" ")) {
          const terminal = terminalOf(chord);
          expect(
            terminal.length === 1 || NAMED_KEYS.has(terminal),
            `${scheme} 方案的「${binding.key}」：末段「${terminal}」不是按键名，这条键按下去没有反应`
          ).toBe(true);
        }
      }
    }
  });

  it("字母键一律写小写：引擎按字符比对，大写会让 Ctrl+W 这类变成死键", () => {
    for (const [scheme, bindings] of keymapBindings()) {
      for (const binding of bindings) {
        const terminal = terminalOf(binding.key);
        if (/^[a-z]$/i.test(terminal)) {
          expect(terminal, `${scheme} 方案的「${binding.key}」要把字母写成小写`).toBe(
            terminal.toLowerCase()
          );
        }
      }
    }
  });

  it("同一档里不许出现两条相同的键：后面那条会被前面那条吃掉", () => {
    for (const [scheme, bindings] of keymapBindings()) {
      const keys = bindings.map((binding) => binding.key.toLowerCase());
      expect(new Set(keys).size, `${scheme} 方案里有重复的按键串`).toBe(keys.length);
    }
  });

  it("IDEA：Ctrl+D 复制下行，Ctrl+Y 删行", () => {
    const view = mount("alpha\nbeta\ngamma", "idea");
    pressKey(view, "Ctrl-d");
    expect(view.state.doc.toString()).toBe("alpha\nalpha\nbeta\ngamma");
    pressKey(view, "Ctrl-y");
    expect(view.state.doc.toString()).toBe("alpha\nbeta\ngamma");
    view.destroy();
  });

  it("IDEA：Ctrl+F 打开查找面板", () => {
    const view = mount("alpha", "idea");
    pressKey(view, "Ctrl-f");
    expect(view.dom.querySelector(".cm-search")).not.toBeNull();
    view.destroy();
  });

  it("同一个 Ctrl+D 在 Eclipse 档是删行：换档真的换了表", () => {
    const view = mount("alpha\nbeta", "eclipse");
    pressKey(view, "Ctrl-d");
    expect(view.state.doc.toString()).toBe("beta");
    view.destroy();
  });

  it("VS Code：Ctrl+H 打开替换面板，Ctrl+Y 不是删行", () => {
    const view = mount("alpha\nbeta", "vscode");
    pressKey(view, "Ctrl-h");
    expect(view.dom.querySelector(".cm-search")).not.toBeNull();
    view.destroy();

    const other = mount("alpha\nbeta", "vscode");
    pressKey(other, "Ctrl-y");
    expect(other.state.doc.toString()).toBe("alpha\nbeta");
    other.destroy();
  });

  it("只读文档上改正文的键不算命中，查找照样能用", () => {
    const view = mount("alpha\nbeta", "idea", 0, true);
    pressKey(view, "Ctrl-d");
    expect(view.state.doc.toString()).toBe("alpha\nbeta");
    pressKey(view, "Ctrl-f");
    expect(view.dom.querySelector(".cm-search")).not.toBeNull();
    view.destroy();
  });

  it("切换方案后 Ctrl+Enter 从 IDEA 拆行变成 VS Code 行下插入，撤销仍可用", () => {
    const view = mount("alpha\nbeta", "idea", 2);
    pressKey(view, "Ctrl-Enter");
    expect(view.state.doc.toString()).toBe("al\npha\nbeta");
    pressKey(view, "Ctrl-z");
    expect(view.state.doc.toString()).toBe("alpha\nbeta");
    setKeymap(view, forgeKeymap("vscode"));
    pressKey(view, "Ctrl-Enter");
    expect(view.state.doc.toString()).toBe("alpha\n\nbeta");
    expect(view.state.selection.main.head).toBe(6);
  });

  it("Ctrl+Alt+Down 在 VS Code 增加光标，在 Eclipse 复制行，在 IDEA 导航出现处", () => {
    const vscode = mount("alpha\nbeta", "vscode", 1);
    pressKey(vscode, "Ctrl-Alt-ArrowDown");
    expect(vscode.state.selection.ranges).toHaveLength(2);
    expect(vscode.state.doc.toString()).toBe("alpha\nbeta");
    const eclipse = mount("alpha\nbeta", "eclipse");
    pressKey(eclipse, "Ctrl-Alt-ArrowDown");
    expect(eclipse.state.doc.toString()).toBe("alpha\nalpha\nbeta");
    const idea = mount("alpha beta alpha", "idea", 1);
    pressKey(idea, "Ctrl-Alt-ArrowDown");
    expect(idea.state.selection.ranges).toHaveLength(1);
    expect(idea.state.selection.main.from).toBe(11);
    pressKey(idea, "Ctrl-Alt-ArrowUp");
    expect(idea.state.selection.main.from).toBe(0);
  });

  it("IDEA 拼接行与切换大小写支持撤销，只读文档保持不变", () => {
    const view = mount("alpha\n  beta", "idea", 1);
    pressKey(view, "Ctrl-Shift-j");
    expect(view.state.doc.toString()).toBe("alpha beta");
    pressKey(view, "Ctrl-z");
    expect(view.state.doc.toString()).toBe("alpha\n  beta");
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    pressKey(view, "Ctrl-Shift-u");
    expect(view.state.doc.toString()).toBe("ALPHA\n  beta");
    const readonly = mount("alpha\n  beta", "idea", 1, true);
    pressKey(readonly, "Ctrl-Shift-j");
    pressKey(readonly, "Ctrl-Shift-u");
    expect(readonly.state.doc.toString()).toBe("alpha\n  beta");
  });

  it("连续扩大与缩小选区逐步恢复最初的光标", async () => {
    await loadLanguage("javascript");
    const view = mount("const value = call(alpha);", "idea", 20, false, "javascript");
    const original = view.state.selection;
    pressKey(view, "Ctrl-w");
    const first = view.state.selection;
    expect(first.main.empty).toBe(false);
    pressKey(view, "Ctrl-w");
    expect(view.state.selection.main.to - view.state.selection.main.from).toBeGreaterThan(first.main.to - first.main.from);
    pressKey(view, "Ctrl-Shift-w");
    expect(view.state.selection.toJSON()).toEqual(first.toJSON());
    pressKey(view, "Ctrl-Shift-w");
    expect(view.state.selection.toJSON()).toEqual(original.toJSON());
  });

  it("VS Code 的 Ctrl+K Ctrl+0 折叠，Ctrl+K Ctrl+J 展开", async () => {
    await loadLanguage("javascript");
    const view = mount("function test() {\n  return 1;\n}\n", "vscode", 0, false, "javascript");
    pressKey(view, "Ctrl-k");
    pressKey(view, "Ctrl-0");
    expect(foldedRanges(view.state).size).toBeGreaterThan(0);
    pressKey(view, "Ctrl-k");
    pressKey(view, "Ctrl-j");
    expect(foldedRanges(view.state).size).toBe(0);
  });

  it("注释键再次按下会取消注释", async () => {
    await loadLanguage("javascript");
    const view = mount("const value = 1;", "idea", 0, false, "javascript");
    pressKey(view, "Ctrl-/");
    expect(view.state.doc.toString()).toBe("// const value = 1;");
    pressKey(view, "Ctrl-/");
    expect(view.state.doc.toString()).toBe("const value = 1;");
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    pressKey(view, "Ctrl-Shift-/");
    expect(view.state.doc.toString()).toBe("/* const value = 1; */");
    pressKey(view, "Ctrl-Shift-/");
    expect(view.state.doc.toString()).toBe("const value = 1;");
  });

  it("查找面板内可继续搜索和用 Escape 关闭", () => {
    const view = mount("alpha beta alpha", "idea");
    pressKey(view, "Ctrl-f");
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "alpha" })) });
    const input = view.dom.querySelector<HTMLElement>(".cm-search [name=search]")!;
    expect(input).not.toBeNull();
    pressKey(view, "Ctrl-g", input);
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(5);
    pressKey(view, "Ctrl-g", input);
    expect(view.state.selection.main.from).toBe(11);
    pressKey(view, "Escape", input);
    expect(searchPanelOpen(view.state)).toBe(false);
  });

  it("VS Code 在全部光标上方插入空行，保留多光标", () => {
    const view = mount("alpha\nbeta", "vscode");
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(7)]) });
    pressKey(view, "Ctrl-Shift-Enter");
    expect(view.state.doc.toString()).toBe("\nalpha\n\nbeta");
    expect(view.state.selection.ranges.map((range) => range.head)).toEqual([0, 7]);
    pressKey(view, "Ctrl-z");
    expect(view.state.doc.toString()).toBe("alpha\nbeta");
  });

  it("IDEA 的方法导航只移动光标，不移动代码", async () => {
    await loadLanguage("javascript");
    const doc = "function first() {}\nfunction second() {}";
    const view = mount(doc, "idea", 0, false, "javascript");
    pressKey(view, "Alt-ArrowDown");
    expect(view.state.selection.main.head).toBe(doc.indexOf("function second"));
    pressKey(view, "Alt-ArrowUp");
    expect(view.state.selection.main.head).toBe(0);
    expect(view.state.doc.toString()).toBe(doc);
  });
});


describe('完整方案接通实际编辑行为', () => {
  it('复制选区只复制所选文字，拆行后光标留在断点前，别名可撤销', () => {
    const view = mount('alpha beta', 'idea');
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    pressKey(view, 'Ctrl-d');
    expect(view.state.doc.toString()).toBe('alphaalpha beta');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('alpha');
    pressKey(view, 'Alt-Backspace');
    expect(view.state.doc.toString()).toBe('alpha beta');
    view.dispatch({ selection: { anchor: 2 } });
    pressKey(view, 'Ctrl-Enter');
    expect(view.state.doc.toString()).toBe('al\npha beta');
    expect(view.state.selection.main.head).toBe(2);
  });

  it('完成语句依据文档语言补分号与换行，只读文档不变', () => {
    const view = mount('call()', 'idea', 2, false, 'javascript');
    pressKey(view, 'Ctrl-Shift-Enter');
    expect(view.state.doc.toString()).toBe('call();\n');
    const readonly = mount('call()', 'idea', 2, true, 'javascript');
    pressKey(readonly, 'Ctrl-Shift-Enter');
    expect(readonly.state.doc.toString()).toBe('call()');
  });

  it('多光标出现处保持整词匹配，取消后恢复上一主选区', () => {
    const view = mount('foo foobar foo foo', 'idea', 1);
    pressKey(view, 'Alt-j');
    pressKey(view, 'Alt-j');
    expect(view.state.selection.ranges.map((range) => range.from)).toEqual([0, 11]);
    pressKey(view, 'Alt-Shift-j');
    expect(view.state.selection.ranges.map((range) => range.from)).toEqual([0]);
    pressKey(view, 'Ctrl-Alt-Shift-j');
    expect(view.state.selection.ranges.map((range) => range.from)).toEqual([0, 11, 15]);
  });

  it('选中多行后在各行末添加光标，末尾下一行不被误选', () => {
    const view = mount('alpha\nbeta\ngamma', 'idea');
    view.dispatch({ selection: { anchor: 0, head: 11 } });
    pressKey(view, 'Alt-Shift-g');
    expect(view.state.selection.ranges.map((range) => range.head)).toEqual([5, 10]);
  });

  it('列选择支持 Shift+方向键和切换关闭', () => {
    const view = mount('abcd\nefgh\nijkl', 'idea', 1);
    pressKey(view, 'Alt-Shift-Insert');
    pressKey(view, 'Shift-ArrowDown');
    pressKey(view, 'Shift-ArrowRight');
    expect(view.state.selection.ranges.map((range) => view.state.sliceDoc(range.from, range.to))).toEqual(['b', 'f']);
    pressKey(view, 'Alt-Shift-Insert');
    pressKey(view, 'Escape');
    expect(view.state.selection.ranges).toHaveLength(1);
  });

  it('递归折叠保留嵌套范围，选区折叠可再次展开', async () => {
    await loadLanguage('javascript');
    const view = mount('function test() {\n  if (true) {\n    call();\n  }\n}\n', 'idea', 0, false, 'javascript');
    pressKey(view, 'Ctrl-Alt--');
    expect(foldedRanges(view.state).size).toBe(2);
    pressKey(view, 'Ctrl-Alt-=');
    expect(foldedRanges(view.state).size).toBe(0);
    view.dispatch({ selection: { anchor: 19, head: 42 } });
    pressKey(view, 'Ctrl-.');
    expect(foldedRanges(view.state).size).toBe(1);
    pressKey(view, 'Ctrl-.');
    expect(foldedRanges(view.state).size).toBe(0);
  });

  it('折叠块上的复制携带整个块，保持一次撤销', () => {
    const view = mount('start\ninside\nend\nafter', 'idea');
    view.dispatch({ effects: foldEffect.of({ from: 5, to: 16 }) });
    pressKey(view, 'Ctrl-d');
    expect(view.state.doc.toString()).toBe('start\ninside\nend\nstart\ninside\nend\nafter');
    pressKey(view, 'Ctrl-z');
    expect(view.state.doc.toString()).toBe('start\ninside\nend\nafter');
  });

  it('代码块导航跨过内部语句，而不是移动一个语法节点', async () => {
    await loadLanguage('javascript');
    const doc = 'function test() {\n  first();\n  second();\n}';
    const view = mount(doc, 'idea', doc.indexOf('first'), false, 'javascript');
    pressKey(view, 'Ctrl-]');
    expect(view.state.selection.main.head).toBe(doc.lastIndexOf('}'));
    pressKey(view, 'Ctrl-[');
    expect(view.state.selection.main.head).toBe(doc.indexOf('{') + 1);
  });

  it('循环单词补全按最近候选循环，一圈后回到原始前缀', () => {
    const view = mount('alphabet alpine al', 'idea', 18);
    pressKey(view, 'Alt-/');
    expect(view.state.doc.toString()).toBe('alphabet alpine alpine');
    pressKey(view, 'Alt-/');
    expect(view.state.doc.toString()).toBe('alphabet alpine alphabet');
    pressKey(view, 'Alt-/');
    expect(view.state.doc.toString()).toBe('alphabet alpine al');
  });

  it('双 Ctrl 按住上下添加光标，松开后普通 Ctrl+上下只滚动', () => {
    const view = mount('alpha\nbeta\ngamma', 'idea', 1);
    pressKey(view, 'Ctrl-Control');
    view.contentDOM.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
    pressKey(view, 'Ctrl-Control');
    pressKey(view, 'Ctrl-ArrowDown');
    expect(view.state.selection.ranges).toHaveLength(2);
    view.contentDOM.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
    pressKey(view, 'Ctrl-ArrowDown');
    expect(view.state.selection.ranges).toHaveLength(2);
  });
});


describe('覆盖输入的公开输入边界', () => {
  // jsdom 不执行原生文字编辑，使用 CodeMirror 公开的 inputHandler 管线发送文字。
  function type(view: EditorView, text: string): void {
    const range = view.state.selection.main;
    const insert = () => view.state.update(view.state.replaceSelection(text), { userEvent: 'input.type' });
    if (!view.state.facet(EditorView.inputHandler).some((handler) => handler(view, range.from, range.to, text, insert))) view.dispatch(insert());
  }

  it('Insert 打开后覆盖完整字符，不吞换行，关闭后恢复插入且可以撤销', () => {
    const view = mount('😀ab\nnext', 'idea');
    pressKey(view, 'Insert');
    type(view, 'X');
    expect(view.state.doc.toString()).toBe('Xab\nnext');
    view.dispatch({ selection: { anchor: 3 } });
    type(view, 'YZ');
    expect(view.state.doc.toString()).toBe('XabYZ\nnext');
    pressKey(view, 'Insert');
    type(view, 'Q');
    expect(view.state.doc.toString()).toBe('XabYZQ\nnext');
    pressKey(view, 'Ctrl-z');
    expect(view.state.doc.toString()).toBe('Xab\nnext');
    pressKey(view, 'Ctrl-z');
    expect(view.state.doc.toString()).toBe('😀ab\nnext');
  });
});
