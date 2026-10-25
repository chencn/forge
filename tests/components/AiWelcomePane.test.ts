import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ states: [] as unknown[], index: 0, launch: vi.fn(), execute: vi.fn() }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: (initial: unknown) => {
      const index = h.index++;
      if (!(index in h.states)) h.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [h.states[index], (next: unknown) => { h.states[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(h.states[index]) : next; }];
    },
  };
});
vi.mock("../../src/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("../../src/lib/aiCli", () => ({
  AI_NAMES: { codex: "Codex", claude: "Claude" },
  availableAiProviders: () => ["codex"],
  cliDesktopAvailable: () => true,
  orderedAiProviders: () => ["codex"],
  useAiCli: () => ({ statuses: {} }),
  useAiCliSettings: () => ({ settings: { agents: { codex: { enabled: true }, claude: { enabled: false } } } }),
}));
vi.mock("../../src/lib/aiChatWidth", () => ({ useAiChatWidth: () => ({ width: 720 }) }));
vi.mock("../../src/lib/fs", () => ({ assetUrl: (path: string) => path }));
vi.mock("../../src/components/AiComposerOptions", () => ({ default: ({ commandRef }: { commandRef?: { current: unknown } }) => {
  if (commandRef) commandRef.current = { execute: h.execute };
  return null;
} }));

import AiWelcomePane from "../../src/components/AiWelcomePane";

type Node = ReactElement<Record<string, unknown>>;

function nodes(root: unknown): Node[] {
  if (!root || typeof root !== "object") return [];
  if ("props" in root) {
    const element = root as Node;
    return [element, ...nodes(element.props.children), ...Object.entries(element.props)
      .filter(([key]) => key !== "children")
      .flatMap(([, value]) => nodes(value))];
  }
  return Array.isArray(root) ? root.flatMap(nodes) : [];
}

function render() {
  h.index = 0;
  let tree!: Node;
  function Harness() {
    tree = AiWelcomePane({ workspace: "D:/project", onLaunch: h.launch, onSettings: vi.fn() }) as Node;
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Harness));
  return { tree, html };
}

beforeEach(() => {
  h.states = [];
  h.index = 0;
  h.launch.mockReset();
  h.execute.mockReset();
  h.execute.mockResolvedValue(undefined);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
});

describe("AI new-session composer", () => {
  it("输入斜杠时提供与正式会话一致的命令列表", () => {
    const first = render();
    expect(first.html).not.toContain('role="listbox"');
    const shell = nodes(first.tree).find((node) => "editor" in node.props)!;
    const input = shell.props.editor as Node;
    // 直接驱动新建页自己的输入边界；解析器单测无法发现页面根本没接命令菜单。
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "/" } });
    const opened = render();
    expect(opened.html).toContain('role="listbox"');
    expect(opened.html).toContain("/model");
  });
  it("本地斜杠命令在新建页直接执行，不创建空会话", async () => {
    const first = render();
    const shell = nodes(first.tree).find((node) => "editor" in node.props)!;
    const input = shell.props.editor as Node;
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "/model custom-model" } });
    const ready = render();
    const readyInput = nodes(ready.tree).find((node) => "editor" in node.props)!.props.editor as Node;
    (readyInput.props.onKeyDown as (event: Record<string, unknown>) => void)({
      key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
      nativeEvent: {}, preventDefault: vi.fn(), stopPropagation: vi.fn(),
    });
    await Promise.resolve();
    expect(h.execute).toHaveBeenCalledWith("model", "custom-model");
    expect(h.launch).not.toHaveBeenCalled();
  });
  it("/help 清空命令文本后仍保持完整命令列表", async () => {
    const first = render();
    const shell = nodes(first.tree).find((node) => "editor" in node.props)!;
    const input = shell.props.editor as Node;
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "/help " } });
    const ready = render();
    const readyInput = nodes(ready.tree).find((node) => "editor" in node.props)!.props.editor as Node;
    (readyInput.props.onKeyDown as (event: Record<string, unknown>) => void)({
      key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
      nativeEvent: {}, preventDefault: vi.fn(), stopPropagation: vi.fn(),
    });
    await Promise.resolve();
    const help = render();
    expect(help.html).toContain('role="listbox"');
    expect(help.html).toContain("/model");
    expect(h.launch).not.toHaveBeenCalled();
  });
  it("创建首条会话失败时保留草稿并允许重试", async () => {
    h.launch.mockRejectedValueOnce(new Error("创建失败"));
    const first = render();
    const input = nodes(first.tree).find((node) => "editor" in node.props)!.props.editor as Node;
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "不要丢掉我" } });
    const ready = render();
    const readyInput = nodes(ready.tree).find((node) => "editor" in node.props)!.props.editor as Node;
    (readyInput.props.onKeyDown as (event: Record<string, unknown>) => void)({
      key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
      nativeEvent: {}, preventDefault: vi.fn(), stopPropagation: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();
    const failed = render();
    const failedInput = nodes(failed.tree).find((node) => "editor" in node.props)!.props.editor as Node;
    expect(failedInput.props.value).toBe("不要丢掉我");
    expect(h.launch).toHaveBeenCalledTimes(1);
  });
});
