import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sanitize: vi.fn((html: string) => html),
  openExternal: vi.fn(),
  openFile: vi.fn(),
  writeText: vi.fn(() => Promise.resolve()),
  timers: [] as Array<() => void>,
}));

// 同 tests/lib/markdown.test.ts：node 里没有 DOMPurify 可用，先passthrough，只验本组件的逻辑。
vi.mock("dompurify", () => ({ default: { sanitize: h.sanitize } }));
vi.mock("../../src/i18n", () => ({ useI18n: () => ({ t: (key: string) => `_${key}` }) }));
vi.mock("../../src/lib/fs", () => ({ openExternal: h.openExternal }));
vi.mock("../../src/components/AiFileLink", () => ({ useAiOpenFile: () => h.openFile }));
vi.mock("../../src/lib/chatMarkdownAsync", () => ({ renderChatMarkdownBlocks: () => Promise.resolve([]) }));

import AiMarkdown from "../../src/components/AiMarkdown";

const CODE = "```ts\nconst a = 1;\n```";

/** 直接调用组件函数拿到元素树，才能取到 props 上的委托处理器。 */
function render(text = CODE) {
  let el!: ReactElement<Record<string, unknown>>;
  // memo 包装对象本身不可调用，取它包着的那层原始函数。
  const inner = (AiMarkdown as unknown as { type: (props: { text: string }) => ReactElement<Record<string, unknown>> }).type;
  function Harness() {
    el = inner({ text });
    return el;
  }
  return { html: renderToStaticMarkup(createElement(Harness)), props: el.props };
}

function button(textContent = "const a = 1;") {
  const wrapper = { querySelector: () => ({ textContent }) };
  const element = {
    textContent: "_action.copy",
    isConnected: true,
    classList: { add: vi.fn(), remove: vi.fn() },
    closest: (selector: string) => (selector === ".code-block-wrapper" ? wrapper : null),
  };
  return element as unknown as HTMLElement & { classList: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } };
}

function target(buttonEl: HTMLElement | null, linkEl: Record<string, unknown> | null = null, fileEl: Record<string, unknown> | null = null) {
  return {
    closest: (selector: string) => selector === "[data-code-copy]" ? buttonEl : selector === "[data-file-path]" ? fileEl : linkEl,
  };
}

beforeEach(() => {
  h.timers.length = 0;
  h.openExternal.mockClear();
  h.openFile.mockClear();
  h.writeText.mockClear();
  vi.stubGlobal("navigator", { clipboard: { writeText: h.writeText } });
  vi.stubGlobal("window", { setTimeout: (fn: () => void) => h.timers.push(fn) });
});

describe("AiMarkdown", () => {
  it("marks the container and localises the copy button", () => {
    const { html } = render();
    expect(html).toContain('class="ai-message-markdown"');
    expect(html).toContain('data-code-copy="1"');
    expect(html).toContain("_action.copy");
    expect(html).toContain('class="hljs language-ts"');
  });

  it("copies the raw code, not the highlight markup", async () => {
    const { props } = render();
    const buttonEl = button("const a = 1;");
    (props.onClick as (event: unknown) => void)({ target: target(buttonEl), preventDefault: vi.fn(), stopPropagation: vi.fn() });
    await Promise.resolve();
    expect(h.writeText).toHaveBeenCalledWith("const a = 1;");
    expect(buttonEl.textContent).toBe("_action.copied");
    expect(buttonEl.classList.add).toHaveBeenCalledWith("is-copied");
    h.timers.forEach((run) => run());
    expect(buttonEl.textContent).toBe("_action.copy");
  });

  it("copies from the keyboard too", async () => {
    const { props } = render();
    const buttonEl = button("x");
    const preventDefault = vi.fn();
    (props.onKeyDown as (event: unknown) => void)({ key: "Enter", target: target(buttonEl), preventDefault, stopPropagation: vi.fn() });
    await Promise.resolve();
    expect(preventDefault).toHaveBeenCalled();
    expect(h.writeText).toHaveBeenCalledWith("x");
  });

  it("ignores an empty code block", () => {
    const { props } = render();
    const buttonEl = button("");
    (props.onClick as (event: unknown) => void)({ target: target(buttonEl), preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(h.writeText).not.toHaveBeenCalled();
  });

  it("sends http(s) links to the system browser", () => {
    const { props } = render("see [docs](https://example.com/a)");
    const preventDefault = vi.fn();
    const link = { getAttribute: () => "https://example.com/a" };
    (props.onClick as (event: unknown) => void)({ target: target(null, link), preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(h.openExternal).toHaveBeenCalledWith("https://example.com/a");
  });

  it("opens a local file link at its line", () => {
    const { props } = render("see [a.ts](src/a.ts:12)");
    const preventDefault = vi.fn();
    const file = {
      getAttribute: (name: string) =>
        name === "data-file-path" ? "src/a.ts" : name === "data-file-line" ? "12" : null,
    };
    (props.onClick as (event: unknown) => void)({ target: target(null, null, file), preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(h.openFile).toHaveBeenCalledWith("src/a.ts", 12, undefined);
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  it("does not hand a non-http link to the browser", () => {
    const { props } = render();
    const preventDefault = vi.fn();
    const link = { getAttribute: () => "file:///D:/secret" };
    (props.onClick as (event: unknown) => void)({ target: target(null, link), preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  it("leaves plain clicks alone", () => {
    const { props } = render("hello");
    const preventDefault = vi.fn();
    (props.onClick as (event: unknown) => void)({ target: target(null, null), preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
