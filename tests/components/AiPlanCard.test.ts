import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AiEntry, AiPlanReview } from "../../src/lib/aiRuntime";

vi.mock("../../src/i18n", () => ({
  useI18n: () => ({ t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key) }),
}));
vi.mock("../../src/components/AiMarkdown", async () => {
  const { createElement } = await import("react");
  return { default: ({ text }: { text: string }) => createElement("div", { className: "markdown" }, text) };
});

import AiPlanApproval, { AiPlanEntry } from "../../src/components/AiPlanCard";

const plan: AiPlanReview = {
  planId: "thread/plan", sessionId: "s", nativeId: "thread", workspace: "D:/project", revision: 2,
  title: "实施步骤", content: "# 实施步骤\n1. 先写测试", contentHash: "h", complete: true, nativePlanId: "item",
  execPermission: "inherit", status: "awaiting_review", execution: "not_started", createdAt: 1, updatedAt: 2,
};

describe("plan review UI", () => {
  it("renders the pinned approval card with all three decisions", () => {
    const html = renderToStaticMarkup(createElement(AiPlanApproval, {
      plan, onApprove: async () => {}, onRequestChanges: async () => {}, onDefer: async () => {},
    }));
    expect(html).toContain("ai.plan.title");
    expect(html).toContain("实施步骤");
    expect(html).toContain("先写测试");
    expect(html).toContain("ai.plan.approve");
    expect(html).toContain("ai.plan.requestChanges");
    expect(html).toContain("ai.plan.defer");
    expect(html).toContain("v2");
  });

  it("disables every decision while another action is in flight", () => {
    const html = renderToStaticMarkup(createElement(AiPlanApproval, {
      plan, disabled: true, onApprove: async () => {}, onRequestChanges: async () => {}, onDefer: async () => {},
    }));
    expect(html.match(/disabled=""/g)?.length).toBe(3);
  });

  it("renders drafts without claiming a revision or status, and records with both", () => {
    const draft: AiEntry = { id: "draft", runId: "run", kind: "notice", name: "plan_draft", text: "# 草稿" };
    const draftHtml = renderToStaticMarkup(createElement(AiPlanEntry, { entry: draft }));
    expect(draftHtml).toContain("ai.plan.draft");
    expect(draftHtml).not.toContain("ai.plan.awaiting");
    expect(draftHtml).toContain("草稿");
    const review: AiEntry = { id: "review", runId: "run", kind: "notice", name: "plan_review", text: plan.content, input: plan };
    const reviewHtml = renderToStaticMarkup(createElement(AiPlanEntry, { entry: review }));
    expect(reviewHtml).toContain("ai.plan.awaiting");
    expect(reviewHtml).toContain("v2");
    expect(reviewHtml).toContain("先写测试");
  });
});
