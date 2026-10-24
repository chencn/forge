import type { AiPlanReview } from "./aiRuntime";

/** 当前仍需用户处理的计划：同一 planId 取最新版本，多个 planId 取最近更新的一份。 */
export function openAiPlan(plans: AiPlanReview[]): AiPlanReview | null {
  const latest = new Map<string, AiPlanReview>();
  for (const plan of plans) {
    const current = latest.get(plan.planId);
    if (!current || plan.revision > current.revision) latest.set(plan.planId, plan);
  }
  const open = [...latest.values()].filter((plan) => plan.complete && (plan.status === "awaiting_review" || plan.status === "deferred"));
  return open.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}
