import { describe, expect, it } from "vitest";
import { contextPercent, normalizeAiUsage } from "../../src/lib/aiUsage";

describe("provider usage accounting", () => {
  it("uses the latest Codex context rather than cumulative usage", () => {
    const usage = normalizeAiUsage({ tokenUsage: { last: { inputTokens: 90, outputTokens: 10, totalTokens: 100, cachedInputTokens: 20 }, total: { totalTokens: 10000 }, modelContextWindow: 1000 } });
    expect(usage.context).toBe(100); expect(usage.total).toBe(10000); expect(contextPercent(usage)).toBe(10);
    // 保留小数：界面按一位小数展示，提前取整会让外层和弹层出现 15% / 14.9% 的差异。
    expect(contextPercent({ context: 149, window: 1000 })).toBeCloseTo(14.9);
  });
  it("never invents a context window or percentage", () => {
    expect(contextPercent(normalizeAiUsage({ tokenUsage: { last: { totalTokens: 100 }, total: { totalTokens: 10000 } } }))).toBeUndefined();
    expect(contextPercent({ context: 0, window: 0 })).toBeUndefined();
    expect(normalizeAiUsage({ input_tokens: -1, output_tokens: Infinity }).input).toBeUndefined();
  });
  it("includes Claude cache inputs without replacing context with result totals", () => {
    const message = normalizeAiUsage({ input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 5 });
    const result = normalizeAiUsage({ usage: { input_tokens: 3000, output_tokens: 100 }, modelUsage: { actual: { contextWindow: 1000 } }, total_cost_usd: 0.12 }, message);
    expect(message.context).toBe(100); expect(result.context).toBe(100); expect(contextPercent(result)).toBe(10); expect(result.model).toBe("actual"); expect(result.cost).toBe(0.12);
  });
  it("does not pick an arbitrary effective model from a multi-model result", () => {
    const usage = normalizeAiUsage({ modelUsage: { one: { contextWindow: 1000 }, two: { contextWindow: 2000 } } });
    expect(usage.model).toBeUndefined(); expect(usage.window).toBeUndefined();
  });
});
