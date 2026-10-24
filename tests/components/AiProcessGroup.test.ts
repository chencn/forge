import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiEntry } from "../../src/lib/aiRuntime";

const h = vi.hoisted(() => ({ states: [] as unknown[], index: 0 }));
vi.mock("../../src/i18n", () => ({ useI18n: () => ({ t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${vars.count}` : key) }) }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: (initial: unknown) => {
      const index = h.index++;
      if (!(index in h.states)) h.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [h.states[index], (next: unknown) => { h.states[index] = typeof next === "function" ? (next as (prev: unknown) => unknown)(h.states[index]) : next; }];
    } };
});

import AiProcessGroup from "../../src/components/AiProcessGroup";

const tools = (count: number): AiEntry[] => Array.from({ length: count }, (_, index) => ({ id: `t${index}`, runId: "r1", kind: "tool", text: "", name: `tool${index}`, status: "completed" }));
const running = (count: number): AiEntry[] => tools(count).map((entry, index) => (index === count - 1 ? { ...entry, status: "running" } : entry));

/** 逐条渲染交给回调，测试里就用回调数出到底渲染了几条。 */
function render(entries: AiEntry[], active: boolean) {
  const seen: string[] = [];
  let tree!: ReactElement<Record<string, unknown>>;
  h.index = 0;
  function Harness() {
    // 直接调用组件函数拿到的才是它渲染出来的元素树；createElement 拿到的只是入参。
    tree = AiProcessGroup({ entries, active, render: (entry: AiEntry) => { seen.push(entry.id); return createElement("i", { key: entry.id }); } }) as ReactElement<Record<string, unknown>>;
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Harness));
  return { html, seen, tree };
}

type Node = ReactElement<Record<string, unknown>>;
/** 把元素树摊平成数组：折叠体在 Fragment 里，只翻一层 children 找不到按钮。 */
function nodes(root: unknown): Node[] {
  if (!root || typeof root !== "object") return [];
  if ("props" in root) {
    const element = root as Node;
    return [element, ...nodes(element.props.children)];
  }
  return Array.isArray(root) ? root.flatMap(nodes) : [];
}
const findByClass = (root: Node, className: string) => nodes(root).find((node) => node.props.className === className);

/** 段头按钮的 props，用来直接触发一次收起/展开。 */
const head = (tree: Node) => findByClass(tree, "ai-process-head")!.props;
const moreButton = (tree: Node) => findByClass(tree, "ai-text-button");

beforeEach(() => { h.states = []; h.index = 0; });

describe("AiProcessGroup", () => {
  it("跑完的一段默认只留一行标题，正文一条都不渲染", () => {
    const { html, seen } = render(tools(12), false);
    expect(seen).toEqual([]);
    expect(html).toContain("ai.chat.processTitle");
    expect(html).toContain("ai.chat.stepsTotal:12");
    expect(html).not.toContain("is-open");
    expect(html).not.toContain('aria-expanded="true"');
  });
  it("还在跑的那段默认摊开，并说明正在执行", () => {
    const { html, seen } = render(running(9), true);
    expect(html).toContain("is-active");
    expect(html).toContain("is-open");
    // 进行中的段不再挂「运行中」标签：标题的微光就是运行态（对照参考）。
    expect(html).not.toContain("ai.runtime.taskRunning");
    expect(seen).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"]);
    expect(html).toContain("ai.chat.showEarlierSteps:1");
  });
  it("点标题收起跑着的那段——用户想看干净屏幕时不该被强按着展开", () => {
    const first = render(running(4), true);
    (head(first.tree).onClick as () => void)();
    const again = render(running(4), true);
    expect(again.seen).toEqual([]);
    expect(again.html).toContain('aria-expanded="false"');
    expect(again.html).not.toContain("is-open");
  });
  it("点标题收起的段展开，露最近 8 条并说出还藏了几条", () => {
    const closed = render(tools(20), false);
    (head(closed.tree).onClick as () => void)();
    const open = render(tools(20), false);
    expect(open.seen).toEqual(["t12", "t13", "t14", "t15", "t16", "t17", "t18", "t19"]);
    expect(open.html).toContain("ai.chat.showEarlierSteps:12");
    expect(moreButton(open.tree)).toBeTruthy();
  });
  it("点「显示更早」一次多给 8 条，藏到 0 时按钮消失", () => {
    const closed = render(tools(20), false);
    (head(closed.tree).onClick as () => void)();
    const open = render(tools(20), false);
    (moreButton(open.tree)!.props.onClick as () => void)();
    const wider = render(tools(20), false);
    expect(wider.seen).toHaveLength(16);
    expect(wider.html).toContain("ai.chat.showEarlierSteps:4");
    (moreButton(wider.tree)!.props.onClick as () => void)();
    const all = render(tools(20), false);
    expect(all.seen).toHaveLength(20);
    expect(moreButton(all.tree)).toBeUndefined();
  });
  it("不足一页的段展开后不出现「更早」，也不谎报藏了内容", () => {
    const closed = render(tools(3), false);
    (head(closed.tree).onClick as () => void)();
    const open = render(tools(3), false);
    expect(open.seen).toHaveLength(3);
    expect(moreButton(open.tree)).toBeUndefined();
  });
});
