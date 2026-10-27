import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSession, AiSessionAction } from "../../src/lib/aiSessions";

const h = vi.hoisted(() => ({
  desktop: true,
  states: [] as unknown[],
  index: 0,
  sessions: [] as unknown[],
  actions: [] as AiSessionAction[],
  deleteOne: vi.fn(),
  deleteAll: vi.fn(),
  refreshed: 0,
}));

vi.mock("../../src/i18n", () => ({
  useI18n: () => ({ t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key) }),
}));
vi.mock("../../src/lib/aiCli", async (original) => ({
  ...await original<typeof import("../../src/lib/aiCli")>(),
  cliDesktopAvailable: () => h.desktop,
}));
vi.mock("../../src/lib/aiRuntime", () => ({
  deleteAiRuntimeSession: h.deleteOne,
  deleteArchivedAiRuntimeSessions: h.deleteAll,
}));
vi.mock("../../src/hooks/useAiSessions", () => ({
  useAiSessions: () => ({ sessions: h.sessions, dispatch: (action: AiSessionAction) => h.actions.push(action) }),
  refreshAiSessionHistory: () => { h.refreshed += 1; },
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

import AiActionDialog from "../../src/components/AiActionDialog";
import AiArchivedSessionsPanel from "../../src/components/AiArchivedSessionsPanel";

type Node = ReactElement<Record<string, unknown>>;

const putAway: AiSession = { id: "b", provider: "claude", title: "收起来的会话", createdAt: 1, archived: true };
const older: AiSession = { id: "c", provider: "codex", title: "更早收起来的", createdAt: 2, archived: true, lastActivity: 9 };
const inUse: AiSession = { id: "a", provider: "codex", title: "还在用的会话", createdAt: 3 };
const subagent: AiSession = { id: "d", provider: "claude", title: "收起来的孩子", createdAt: 4, archived: true, parentSessionId: "b", agent: { title: "子代理", status: "completed", toolId: "t1" } };

function nodes(root: unknown): Node[] {
  if (!root || typeof root !== "object") return [];
  if ("props" in root) {
    const element = root as Node;
    return [element, ...nodes(element.props.children)];
  }
  return Array.isArray(root) ? root.flatMap(nodes) : [];
}

function render(sessions: AiSession[], workspace: string | null = "D:/p") {
  let tree!: Node;
  h.index = 0;
  h.sessions = sessions;
  function Harness() {
    tree = AiArchivedSessionsPanel({ workspace }) as Node;
    return tree;
  }
  return { html: renderToStaticMarkup(createElement(Harness)), tree };
}

const dialog = (tree: Node) => nodes(tree).find((node) => node.type === AiActionDialog);
/** 把一棵子树里的文本摊平，用来按标签找到那颗按钮。 */
function text(node: Node): string {
  const children = node.props.children;
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) {
    return children.map((child) => (typeof child === "string" || typeof child === "number"
      ? String(child)
      : child && typeof child === "object" && "props" in child ? text(child as Node) : "")).join("");
  }
  if (children && typeof children === "object" && "props" in children) return text(children as Node);
  return "";
}
const button = (tree: Node, label: string) => nodes(tree).find((node) => node.type === "button" && text(node).includes(label))!;
/** 某一行的删除键：按标题认行，不能靠行序——行序跟着「最近活动」变。 */
const rowDelete = (tree: Node, title: string) => {
  const row = nodes(tree).find((node) => String(node.props.className ?? "").includes("ai-cli-row") && text(node).includes(title))!;
  return nodes(row).find((node) => node.type === "button" && node.props["aria-label"] === "menu.delete")!;
};
const confirm = (node: Node) => (node.props.onConfirm as (value: string) => void)("");

beforeEach(() => {
  h.desktop = true;
  h.states = [];
  h.index = 0;
  h.actions = [];
  h.sessions = [];
  h.refreshed = 0;
  h.deleteOne.mockReset().mockResolvedValue(undefined);
  h.deleteAll.mockReset().mockResolvedValue({ deleted: [], failed: [] });
});

describe("设置页「归档会话」", () => {
  it("只列已归档的顶层会话，按最近活动倒序", () => {
    const view = render([inUse, putAway, older, subagent]);
    expect(view.html).toContain("ai.archived.count:2");
    expect(view.html).toContain("收起来的会话");
    expect(view.html).toContain("更早收起来的");
    // 还在用的不该出现在这一页，收起来的孩子跟着父一条，不该多出一行。
    expect(view.html).not.toContain("还在用的会话");
    expect(view.html).not.toContain("收起来的孩子");
    expect(view.html.indexOf("更早收起来的")).toBeLessThan(view.html.indexOf("收起来的会话"));
  });

  it("没有归档会话就如实说没有，批量删除按钮不可点", () => {
    const { html, tree } = render([inUse]);
    expect(html).toContain("ai.archived.empty");
    expect(button(tree, "ai.archived.deleteAll").props.disabled).toBe(true);
  });

  it("没有项目时给出原因：归档按项目存放，按钮不可点", () => {
    const { html, tree } = render([putAway], null);
    expect(html).toContain("ai.archived.noWorkspace");
    expect(button(tree, "ai.archived.deleteAll").props.disabled).toBe(true);
  });

  it("单条删除先确认；默认不动 CLI 原生，勾选态由后端调用参数原样带回", async () => {
    const first = render([putAway, older]);
    (rowDelete(first.tree, "收起来的会话").props.onClick as () => void)();
    const asked = render([putAway, older]);
    const modal = dialog(asked.tree);
    expect(modal).toBeDefined();
    expect(asked.html).toContain("ai.deleteConfirm");
    expect(asked.html).toContain('class="ai-native-purge"');
    confirm(modal!);
    await vi.waitFor(() => expect(h.deleteOne).toHaveBeenCalledWith("b", "D:/p", false));
    expect(h.actions).toEqual([{ type: "delete", id: "b", purgeNative: false }]);
    expect(h.refreshed).toBe(1);
  });

  it("勾上「同时删除 CLI 原生记录」后确认文案换成不可恢复那一版", () => {
    const first = render([putAway]);
    (rowDelete(first.tree, "收起来的会话").props.onClick as () => void)();
    const opened = render([putAway]);
    // 勾选行在确认框组件内部，元素树看不到它的 input，只能经 nativePurge 回调驱动状态。
    (dialog(opened.tree)!.props.nativePurge as { onChange: (value: boolean) => void }).onChange(true);
    const ticked = render([putAway]);
    expect(ticked.html).toContain("ai.deleteConfirmPurge");
  });

  it("批量删除把逐条结果摊开：删掉的收走，没删掉指名报原因并留在列表里", async () => {
    h.deleteAll.mockResolvedValue({ deleted: ["c"], failed: [{ id: "b", title: "收起来的会话", error: "原生历史删除失败" }] });
    const first = render([putAway, older]);
    (button(first.tree, "ai.archived.deleteAll").props.onClick as () => void)();
    const asked = render([putAway, older]);
    expect(asked.html).toContain("ai.archived.allConfirm");
    confirm(dialog(asked.tree)!);
    await vi.waitFor(() => expect(h.deleteAll).toHaveBeenCalledWith("D:/p", false));
    expect(h.actions).toEqual([{ type: "delete", id: "c", purgeNative: false }]);
    const done = render([putAway, older]);
    expect(done.html).toContain("ai.archived.partial:1,1");
    expect(done.html).toContain("ai.archived.failedOne:收起来的会话,原生历史删除失败");
    // 没删掉的那条仍留在列表里，界面不能假装它已经没了。
    expect(done.html).toContain("收起来的会话");
  });

  it("非桌面端不给删除入口：这一页要动磁盘", () => {
    h.desktop = false;
    const { html, tree } = render([putAway]);
    expect(html).toContain("ai.desktopOnly");
    expect(button(tree, "ai.archived.deleteAll").props.disabled).toBe(true);
  });
});
