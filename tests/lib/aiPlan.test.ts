import { describe, expect, it } from "vitest";
import { openAiPlan } from "../../src/lib/aiPlan";
import type { AiPlanReview } from "../../src/lib/aiRuntime";

function plan(overrides: Partial<AiPlanReview>): AiPlanReview {
  return {
    planId: "thread/plan", sessionId: "s", nativeId: "thread", workspace: "root", revision: 1, title: "计划",
    content: "# 计划", contentHash: "h", complete: true, nativePlanId: "item", execPermission: "inherit",
    status: "awaiting_review", execution: "not_started", createdAt: 1, updatedAt: 1, ...overrides,
  };
}

describe("openAiPlan", () => {
  it("takes the newest revision and ignores closed or incomplete plans", () => {
    expect(openAiPlan([])).toBeNull();
    expect(openAiPlan([plan({ revision: 1, status: "superseded" }), plan({ revision: 2, status: "approved" })])).toBeNull();
    const open = openAiPlan([plan({ revision: 1, status: "superseded" }), plan({ revision: 2, status: "awaiting_review" })]);
    expect(open?.revision).toBe(2);
    // 旧版本仍是 awaiting 也不能盖过新版本。
    expect(openAiPlan([plan({ revision: 3, status: "approved" }), plan({ revision: 2, status: "awaiting_review" })])).toBeNull();
  });

  it("keeps deferred plans actionable and prefers the most recently updated one", () => {
    const deferred = openAiPlan([plan({ revision: 1, status: "deferred", updatedAt: 9 })]);
    expect(deferred?.revision).toBe(1);
    const first = plan({ planId: "a/plan", updatedAt: 5 });
    const second = plan({ planId: "b/plan", updatedAt: 8 });
    expect(openAiPlan([first, second])?.planId).toBe("b/plan");
    expect(openAiPlan([plan({ complete: false })])).toBeNull();
  });
});
