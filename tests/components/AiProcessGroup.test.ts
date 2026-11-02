// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiEntry } from "../../src/lib/aiRuntime";

vi.mock("../../src/i18n", () => ({ useI18n: () => ({ t: (key: string, vars?: Record<string, unknown>) => vars ? `${key}:${vars.count}` : key }) }));
import AiProcessGroup from "../../src/components/AiProcessGroup";
import AiReasoningEntry from "../../src/components/AiReasoningEntry";

const tools = (count: number): AiEntry[] => Array.from({ length: count }, (_, index) => ({ id: `t${index}`, runId: "r1", kind: "tool", text: "", name: `tool${index}`, status: "completed" }));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const button = (label: string) => Array.from(host.querySelectorAll("button")).find((node) => node.textContent?.includes(label))!;
const click = async (target: HTMLElement) => { await act(async () => target.click()); };
const visibleEntries = () => Array.from(host.querySelectorAll("[data-entry-id]")).map((node) => node.getAttribute("data-entry-id"));
async function render(entries: AiEntry[], active: boolean) {
  await act(async () => root.render(createElement(AiProcessGroup, { entries, active,
    render: (entry) => createElement("p", { key: entry.id, "data-entry-id": entry.id }, entry.id),
  })));
}

describe("AiProcessGroup 的公开交互", () => {
  it("完成项默认折叠，打开只渲染最近8条，逐页查看更早条目", async () => {
    await render(tools(20), false);
    expect(button("ai.chat.processTitle").getAttribute("aria-expanded")).toBe("false");
    expect(visibleEntries()).toEqual([]);
    await click(button("ai.chat.processTitle"));
    expect(visibleEntries()).toEqual(tools(20).slice(-8).map((entry) => entry.id));
    await click(button("ai.chat.showEarlierSteps:12"));
    expect(visibleEntries()).toHaveLength(16);
    await click(button("ai.chat.showEarlierSteps:4"));
    expect(visibleEntries()).toHaveLength(20);
    expect(button("ai.chat.showEarlierSteps")).toBeUndefined();
  });
  it("运行中默认展开，结束后自动收起", async () => {
    await render(tools(3), true);
    expect(visibleEntries()).toHaveLength(3);
    await render(tools(3), false);
    expect(button("ai.chat.processTitle").getAttribute("aria-expanded")).toBe("false");
    expect(visibleEntries()).toEqual([]);
  });
  it("用户收起优先于持续到达的运行事件", async () => {
    await render(tools(4), true);
    await click(button("ai.chat.processTitle"));
    await render(tools(5), true);
    expect(visibleEntries()).toEqual([]);
    expect(button("ai.chat.processTitle").getAttribute("aria-expanded")).toBe("false");
  });
  it("失败跳转独立可访问，并展开所有条目以显示失败目标", async () => {
    const entries = tools(20);
    entries[0].status = "failed";
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    const scroll = vi.fn();
    // The jump runs after the next frame, as it does in the browser after the DOM commit.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return 1; });
    await render(entries, false);
    const jump = host.querySelector<HTMLButtonElement>('button[aria-label="ai.chat.jumpToFailure"]')!;
    expect(jump.parentElement?.closest("button")).toBeNull();
    await click(jump);
    expect(visibleEntries()).toHaveLength(20);
    const target = host.querySelector<HTMLElement>('[data-entry-id="t0"]')!;
    target.scrollIntoView = scroll;
    frames.forEach((frame) => frame(0));
    expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });
});

describe("Reasoning 的阶段状态", () => {
  const entry: AiEntry = { id: "thinking", runId: "r1", kind: "reasoning", text: "公开摘要正文" };
  const reasoning = async (live: boolean, text = entry.text) => {
    await act(async () => root.render(createElement(AiReasoningEntry, { entry: { ...entry, text }, live })));
  };
  it("空流式摘要只显示状态，不提供无内容的折叠操作", async () => {
    await reasoning(true, "");
    expect(host.textContent).toContain("ai.chat.reasoningLive");
    expect(host.querySelector("button")).toBeNull();
  });
  it("实时摘要可手动收起，完成后默认折叠并可重新展开正文", async () => {
    await reasoning(true);
    expect(button("ai.chat.reasoningLive").getAttribute("aria-expanded")).toBe("true");
    await click(button("ai.chat.reasoningLive"));
    await reasoning(true, "更新后的公开摘要");
    expect(button("ai.chat.reasoningLive").getAttribute("aria-expanded")).toBe("false");
    await click(button("ai.chat.reasoningLive"));
    await reasoning(false);
    expect(button("ai.chat.reasoning").getAttribute("aria-expanded")).toBe("false");
    await click(button("ai.chat.reasoning"));
    const panelId = button("ai.chat.reasoning").getAttribute("aria-controls")!;
    expect(document.getElementById(panelId)?.textContent).toContain(entry.text);
  });
});
