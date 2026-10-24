import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompactDecision } from "../../src/lib/aiCompact";

const h = vi.hoisted(() => ({ states: [] as unknown[], index: 0 }));
vi.mock("../../src/i18n", () => ({
  useI18n: () => ({ t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key) }),
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

import AiCompactPanel from "../../src/components/AiCompactPanel";

type Node = ReactElement<Record<string, unknown>>;

const calls: string[] = [];
const auto: boolean[] = [];

function render(decision: CompactDecision, options: { auto?: boolean; compacting?: boolean; disabled?: boolean } = {}) {
  const props = {
    decision, auto: options.auto ?? false, compacting: options.compacting ?? false, disabled: options.disabled ?? false,
    onCompact: () => { calls.push("compact"); }, onLater: () => { calls.push("later"); }, onAuto: (next: boolean) => { auto.push(next); },
  };
  let tree!: Node;
  h.index = 0;
  function Harness() {
    tree = AiCompactPanel(props) as Node;
    return tree;
  }
  return { html: renderToStaticMarkup(createElement(Harness)), tree };
}

function nodes(root: unknown): Node[] {
  if (!root || typeof root !== "object") return [];
  if ("props" in root) {
    const element = root as Node;
    return [element, ...nodes(element.props.children)];
  }
  return Array.isArray(root) ? root.flatMap(nodes) : [];
}
const label = (node: Node) => String(node.props.children ?? "");
const buttonByLabel = (tree: Node, text: string) => nodes(tree).filter((node) => node.type === "button").find((node) => label(node) === text);
const click = (tree: Node, text: string) => (buttonByLabel(tree, text)!.props.onClick as () => void)();

const suggest = (over: Partial<CompactDecision> = {}): CompactDecision => ({
  action: "suggest", percent: 85, source: "reported", total: 170000, window: 200000,
  model: "claude-sonnet-4-5", autoAt: 90, reason: null, autoGuard: null, noticeId: "claude:200000:85", ...over,
});
const blocked = (reason: CompactDecision["reason"]): CompactDecision => ({
  action: "none", percent: null, source: "unknown", reason, autoGuard: null, noticeId: null,
});

beforeEach(() => {
  h.states = [];
  h.index = 0;
  calls.length = 0;
  auto.length = 0;
});

describe("AiCompactPanel", () => {
  it("建议档把比例、来源和动作摆在同一层里", () => {
    const { html, tree } = render(suggest());
    expect(html).toContain("ai.compact.hint:85%");
    expect(html).toContain("166 KB / 195.3 KB · ai.compact.windowReported");
    expect(buttonByLabel(tree, "ai.compact.now")).toBeTruthy();
    expect(buttonByLabel(tree, "ai.compact.later")).toBeTruthy();
    expect(buttonByLabel(tree, "ai.compact.enableAuto")).toBeTruthy();
  });
  it("记忆来的分母点名是哪个模型的旧报告", () => {
    const { html } = render(suggest({ source: "remembered", seenAt: 1 }));
    expect(html).toContain("ai.compact.windowRemembered:claude-sonnet-4-5,195.3 KB");
    expect(html).not.toContain("ai.compact.windowReported");
  });
  it("自动本该触发却被挡下时，把原因写在同一层", () => {
    const { html } = render(suggest({ autoGuard: "ai.compact.guardDraft" }), { auto: true });
    expect(html).toContain("ai.compact.guardDraft");
    expect(html).toContain("ai.compact.disableAuto");
    expect(html).toContain("ai.compact.autoNote");
  });
  it("点「立即压缩」只交代一次，不自己猜怎么发", () => {
    const { tree } = render(suggest());
    click(tree, "ai.compact.now");
    expect(calls).toEqual(["compact"]);
  });
  it("「这次不用」把这一档交给面板外面处理，跨档才重新提醒", () => {
    const { tree } = render(suggest());
    click(tree, "ai.compact.later");
    expect(calls).toEqual(["later"]);
  });
  it("开关把选择交给用户，自己不落盘", () => {
    const { tree } = render(suggest());
    click(tree, "ai.compact.enableAuto");
    expect(auto).toEqual([true]);
  });
  it("用户主动点开时，没到阈值也能立即压缩", () => {
    const { html, tree } = render(suggest({ action: "none", percent: 40, noticeId: "claude:200000:40" }));
    expect(html).not.toContain("ai.compact.hint");
    expect((buttonByLabel(tree, "ai.compact.now")!.props as { disabled: boolean }).disabled).toBe(false);
  });
  it("硬阻断说清原因，并把立即压缩按住", () => {
    for (const reason of ["ai.compact.blockNoSession", "ai.compact.blockRunning", "ai.compact.blockQueued"] as const) {
      const { html, tree } = render(blocked(reason));
      expect(html).toContain(reason);
      expect(html).not.toContain("ai.compact.hint");
      expect((buttonByLabel(tree, "ai.compact.now")!.props as { disabled: boolean }).disabled).toBe(true);
      // 没得压缩时连「这次不用」都不该出现：那条提示本来就没出现过。
      expect(buttonByLabel(tree, "ai.compact.later")).toBeUndefined();
    }
  });
  it("正在压缩时把状态写在明面上，再点一次按得住", () => {
    const { html, tree } = render(suggest(), { compacting: true });
    expect(html).toContain("ai.chat.compactionRunning");
    expect((buttonByLabel(tree, "ai.compact.now")!.props as { disabled: boolean }).disabled).toBe(true);
  });
  it("发送中与关闭时禁用动作", () => {
    const { tree } = render(suggest(), { disabled: true });
    expect((buttonByLabel(tree, "ai.compact.now")!.props as { disabled: boolean }).disabled).toBe(true);
    expect((buttonByLabel(tree, "ai.compact.later")!.props as { disabled: boolean }).disabled).toBe(true);
    expect((buttonByLabel(tree, "ai.compact.enableAuto")!.props as { disabled: boolean }).disabled).toBe(true);
  });
});
