import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAgentSummary } from "../../src/lib/aiRuntime";

const h = vi.hoisted(() => ({ states: [] as unknown[], index: 0, stops: [] as string[] }));
vi.mock("../../src/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("../../src/lib/aiRuntime", () => ({
  stopAiAgent: async (sessionId: string) => { h.stops.push(sessionId); },
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

import { AiAgentDockPanel } from "../../src/components/AiDockPanels";

type Node = ReactElement<Record<string, unknown>>;

function nodes(root: unknown): Node[] {
  if (!root || typeof root !== "object") return [];
  if ("props" in root) {
    const element = root as Node;
    return [element, ...nodes(element.props.children)];
  }
  return Array.isArray(root) ? root.flatMap(nodes) : [];
}
// className 按 token 精确匹配，避免 ai-agentdock-row 误吃 ai-agentdock-rowwrap。
const byClass = (tree: Node, className: string) => nodes(tree).filter((node) => {
  const tokens = String(node.props.className ?? "").split(/\s+/);
  return tokens.includes(className);
});

const agent = (over: Partial<AiAgentSummary> & { key: string }): AiAgentSummary => ({
  title: "子代理", status: "completed", seq: 1, updatedAt: 1, ...over,
});

function render(agents: AiAgentSummary[], provider: "claude" | "codex" = "claude") {
  const opens: string[] = [];
  let tree!: Node;
  h.index = 0;
  function Harness() {
    tree = AiAgentDockPanel({ agents, provider, workspace: "ws", onOpen: (id) => { opens.push(id); } }) as Node;
    return tree;
  }
  return { opens, html: renderToStaticMarkup(createElement(Harness)), tree };
}

beforeEach(() => {
  h.states = [];
  h.stops = [];
});

describe("AiAgentDockPanel", () => {
  it("运行中的子代理排前面，其余保持出现顺序", () => {
    const { tree } = render([
      agent({ key: "a", title: "先结束的", status: "completed" }),
      agent({ key: "b", title: "还在跑的", status: "running", sessionId: "session-b" }),
      agent({ key: "c", title: "后结束的", status: "failed" }),
    ]);
    const rows = byClass(tree, "ai-agentdock-row");
    expect(rows).toHaveLength(3);
    const titles = rows.map((row) => {
      const titleNode = byClass(row, "ai-agentdock-title")[0];
      return String(titleNode.props.children);
    });
    expect(titles).toEqual(["还在跑的", "先结束的", "后结束的"]);
  });

  it("只有 Claude 的运行中代理带停止按钮，点击调用 stopAiAgent", async () => {
    const claude = render([agent({ key: "b", title: "还在跑的", status: "running", sessionId: "session-b" })], "claude");
    expect(byClass(claude.tree, "ai-agentdock-stop")).toHaveLength(1);
    const stop = byClass(claude.tree, "ai-agentdock-stop")[0];
    await (stop.props.onClick as () => Promise<void>)();
    expect(h.stops).toEqual(["session-b"]);

    // Codex 没有客户端停止通道；已完成也不给按钮。
    const codex = render([agent({ key: "b", title: "还在跑的", status: "running", sessionId: "session-b" })], "codex");
    expect(byClass(codex.tree, "ai-agentdock-stop")).toHaveLength(0);
    const done = render([agent({ key: "b", title: "已结束", status: "completed", sessionId: "session-b" })], "claude");
    expect(byClass(done.tree, "ai-agentdock-stop")).toHaveLength(0);
  });

  it("点行走 onOpen 带子会话 id；没有 sessionId 的行点了无效", () => {
    const withId = render([agent({ key: "a", status: "completed", sessionId: "session-a" })]);
    (byClass(withId.tree, "ai-agentdock-row")[0].props.onClick as () => void)();
    expect(withId.opens).toEqual(["session-a"]);

    const withoutId = render([agent({ key: "a", status: "completed" })]);
    (byClass(withoutId.tree, "ai-agentdock-row")[0].props.onClick as () => void)();
    expect(withoutId.opens).toEqual([]);
  });
});
