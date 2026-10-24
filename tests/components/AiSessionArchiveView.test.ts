import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiCliStatus, AiProvider } from "../../src/lib/aiCli";
import type { AiSession, AiSessionAction } from "../../src/lib/aiSessions";
import { __resetAiSidebarViewForTest, setShowAiSidebarArchived } from "../../src/lib/aiSidebarView";

const h = vi.hoisted(() => ({
  desktop: true,
  states: [] as unknown[],
  index: 0,
  actions: [] as AiSessionAction[],
}));
vi.mock("../../src/i18n", () => ({
  useI18n: () => ({ t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key) }),
}));
vi.mock("../../src/lib/aiCli", async (original) => ({
  ...await original<typeof import("../../src/lib/aiCli")>(),
  useAiCli: () => ({ statuses: {} as Partial<Record<AiProvider, AiCliStatus>>, checking: false, operation: null, results: {}, error: null, checked: true }),
  cliDesktopAvailable: () => h.desktop,
  refreshAiCli: vi.fn(),
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: (initial: unknown) => {
      const index = h.index++;
      if (!(index in h.states)) h.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [h.states[index], (next: unknown) => { h.states[index] = typeof next === "function" ? (next as (prev: unknown) => unknown)(h.states[index]) : next; }];
    } };
});

import AiSessionsPanel from "../../src/components/AiSessionsPanel";
import AiSidebarCard from "../../src/components/AiSidebarCard";

type Node = ReactElement<Record<string, unknown>>;

const plain: AiSession = { id: "a", provider: "codex", title: "在用的会话", createdAt: 2 };
const putAway: AiSession = { id: "b", provider: "claude", title: "收起来的会话", createdAt: 1, archived: true };

function nodes(root: unknown): Node[] {
  if (!root || typeof root !== "object") return [];
  if ("props" in root) {
    const element = root as Node;
    return [element, ...nodes(element.props.children)];
  }
  return Array.isArray(root) ? root.flatMap(nodes) : [];
}

function render(sessions: AiSession[] = [plain, putAway], props: { workspace?: string | null } = {}) {
  let tree!: Node;
  h.index = 0;
  function Harness() {
    tree = AiSessionsPanel({
      sessions, openIds: [], activeId: null, storageError: false,
      workspace: "workspace" in props ? props.workspace ?? null : "D:/p",
      onOpen: vi.fn(), onAction: (action: AiSessionAction) => { h.actions.push(action); }, onNew: vi.fn(),
    }) as Node;
    return tree;
  }
  return { html: renderToStaticMarkup(createElement(Harness)), tree };
}

const byClass = (tree: Node, name: string) => nodes(tree).filter((node) => String(node.props.className ?? "").includes(name));
const cards = (tree: Node) => nodes(tree).filter((node) => node.type === AiSidebarCard);
const click = (node: Node) => (node.props.onClick as (value?: unknown) => void)();

beforeEach(() => {
  h.desktop = true;
  h.states = [];
  h.index = 0;
  h.actions = [];
  __resetAiSidebarViewForTest();
});

describe("归档视图", () => {
  it("默认只收未归档的；归档的要经视图选项带出", () => {
    const { html } = render();
    expect(html).toContain("在用的会话");
    expect(html).not.toContain("收起来的会话");
  });

  it("打开「显示已归档」后归档会话回到「会话」章节，行带归档态并可取消归档", () => {
    setShowAiSidebarArchived(true);
    const { html } = render();
    expect(html).toContain("收起来的会话");
    expect(html).toContain("在用的会话");
    expect(html.match(/class="ai-scard is-archived"/g)).toHaveLength(1);
    expect(html).toContain('title="ai.archived.restoreHint"');
  });

  it("悬停快捷按钮发出置顶与归档意图，本地状态由上层确认后改", () => {
    const view = render();
    const first = cards(view.tree).find((node) => (node.props.session as AiSession).id === "a")!;
    (first.props.onPin as (session: unknown) => void)(first.props.session);
    (first.props.onArchive as (session: unknown) => void)(first.props.session);
    expect(h.actions).toEqual([
      { type: "pin", id: "a", pinned: true },
      { type: "archive", id: "a", archived: true },
    ]);
  });

  it("归档视图空了仍说明的是会话为空，不误报搜索", () => {
    const { html } = render([]);
    expect(html).toContain("ai.sidebar.noUnarchived");
    expect(html).not.toContain("ai.archived.empty");
  });
});

describe("搜索入口", () => {
  it("桌面端且有项目时才给搜索框", () => {
    expect(render().html).toContain('aria-label="ai.search.placeholder"');
    expect(render([plain], { workspace: null }).html).not.toContain("ai-sidebar-search");
    h.desktop = false;
    expect(render().html).not.toContain("ai-sidebar-search");
  });

  it("一个字符不扫盘：给出原因，同时会话列表照常留着", () => {
    const view = render();
    const input = nodes(view.tree).find((node) => node.type === "input")!;
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "a" } });
    const typed = render();
    expect(typed.html).toContain("ai.search.tooShort:2");
    expect(typed.html).toContain("在用的会话");
  });

  it("清空按钮只在有内容时出现", () => {
    expect(render().html).not.toContain("ai.search.clear");
    const view = render();
    const input = nodes(view.tree).find((node) => node.type === "input")!;
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "构建" } });
    const typed = render();
    expect(typed.html).toContain('aria-label="ai.search.clear"');
    click(byClass(typed.tree, "icon-button").find((node) => String(node.props["aria-label"]) === "ai.search.clear")!);
    expect(render().html).not.toContain("ai.search.clear");
  });
});
