// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import { EditorView, keymap } from "@codemirror/view";
import { base as KEY_CODES } from "w3c-keyname";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { forgeKeymap, keymapBindings } from "../../src/lib/cm/keymap";
import type { KeymapScheme } from "../../src/lib/settings";
import { stubTextLayout } from "../helpers/cmLayout";

/**
 * `cm/lsp` 那一头拉着 `lspClient`，而后者在模块顶层就要取 Tauri 的窗口对象。
 * 这里只验键位表，不需要真起语言服务。
 */
vi.mock("../../src/lib/cm/lsp", () => ({
  findUsages: () => false,
  formatDocument: () => false,
  gotoDefinition: () => false,
  gotoImplementation: () => false,
  showDocumentation: () => false,
}));

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

function mount(doc: string, scheme: KeymapScheme, caret = 0, readOnly = false): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: caret },
      extensions: [
        ...(readOnly ? [EditorState.readOnly.of(true)] : []),
        forgeKeymap(scheme),
        keymap.of([...defaultKeymap]),
      ],
    }),
    parent: document.body,
  });
}

/** 按一张表里的绑定串去按一次键：末段是字符就直接给字符，是具名键就补上 keyCode。 */
function pressKey(view: EditorView, key: string): void {
  const parts = key.split(/-(?!$)/);
  const terminal = parts[parts.length - 1];
  const init: KeyboardEventInit & { keyCode?: number } = {
    ctrlKey: parts.some((part) => /^c(trl|ontrol)$/i.test(part)),
    altKey: parts.some((part) => /^a(lt)?$/i.test(part)),
    shiftKey: parts.some((part) => /^s(hift)?$/i.test(part)),
  };
  if (terminal === "Space") {
    init.key = " ";
    init.keyCode = 32;
  } else {
    init.key = terminal;
    const code = CODE_OF[terminal];
    if (code !== undefined) init.keyCode = code;
  }
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
  view.contentDOM.dispatchEvent(event);
}

describe("键位方案", () => {
  it("每条绑定的末段都是按键事件真会给出的名字", () => {
    for (const [scheme, bindings] of keymapBindings()) {
      for (const binding of bindings) {
        const terminal = terminalOf(binding.key);
        expect(
          terminal.length === 1 || NAMED_KEYS.has(terminal),
          `${scheme} 方案的「${binding.key}」：末段「${terminal}」不是按键名，这条键按下去没有反应`
        ).toBe(true);
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

  it("默认档只补引擎没有的那条：Ctrl+D 复制当前行", () => {
    const view = mount("alpha\nbeta", "default");
    pressKey(view, "Ctrl-d");
    expect(view.state.doc.toString()).toBe("alpha\nalpha\nbeta");
    // 其余照旧归引擎：Ctrl+Y 在默认档不该变成删行，那是 IDEA 档的键。
    pressKey(view, "Ctrl-y");
    expect(view.state.doc.toString()).toBe("alpha\nalpha\nbeta");
    view.destroy();
  });

  it("只读文档上改正文的键不算命中，查找照样能用", () => {
    const view = mount("alpha\nbeta", "idea", 0, true);
    pressKey(view, "Ctrl-d");
    expect(view.state.doc.toString()).toBe("alpha\nbeta");
    pressKey(view, "Ctrl-f");
    expect(view.dom.querySelector(".cm-search")).not.toBeNull();
    view.destroy();
  });
});
