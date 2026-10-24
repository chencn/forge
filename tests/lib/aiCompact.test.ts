import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiContext } from "../../src/lib/aiContext";
import type { AiUsage } from "../../src/lib/aiUsage";
import { AUTO_COMPACT_MIN_PERCENT, COMPACT_COMMAND_TEXT, DEFAULT_COMPACT_THRESHOLD, compactDecision, compactIntent, compactNumbers, readCompactPrefs, writeCompactPrefs } from "../../src/lib/aiCompact";
import { rememberContextWindow } from "../../src/lib/aiContextMemory";

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  });
});

/** 快照只挑判定用得上的字段填，其余给个能过类型检查的形状。 */
const snapshot = (total: number, window: number, extra: Partial<AiContext> = {}): AiContext => ({
  runId: "r1", capturedAt: 1, model: "claude-sonnet-4-5", total, window, stale: false,
  categories: [{ name: "Used context", tokens: total, kind: "used" }], sections: {}, ...extra,
});
const state = (over: Partial<Parameters<typeof compactDecision>[0]> = {}) => ({
  provider: "claude", status: "completed", stopping: false, boundSession: true,
  pendingRequests: 0, queuedTasks: 0, draft: "",
  prefs: { auto: false, threshold: DEFAULT_COMPACT_THRESHOLD }, ...over,
} as Parameters<typeof compactDecision>[0]);

describe("压缩偏好", () => {
  it("默认只提示、不动手", () => {
    expect(readCompactPrefs()).toEqual({ auto: false, threshold: DEFAULT_COMPACT_THRESHOLD });
  });
  it("写进去的阈值出得来，开关也留得住", () => {
    expect(writeCompactPrefs({ auto: true, threshold: 70 })).toEqual({ auto: true, threshold: 70 });
    expect(readCompactPrefs()).toEqual({ auto: true, threshold: 70 });
    expect(writeCompactPrefs({ threshold: 60 }).auto).toBe(true);
  });
  it("坏数据回到默认，超范围夹在可用区间", () => {
    store.set("forge:ai:compact:v1", "不是 JSON");
    expect(readCompactPrefs()).toEqual({ auto: false, threshold: DEFAULT_COMPACT_THRESHOLD });
    store.set("forge:ai:compact:v1", JSON.stringify({ auto: "yes", threshold: 5 }));
    expect(readCompactPrefs()).toEqual({ auto: false, threshold: 50 });
    store.set("forge:ai:compact:v1", "[1,2]");
    expect(readCompactPrefs().threshold).toBe(DEFAULT_COMPACT_THRESHOLD);
    expect(writeCompactPrefs({ threshold: 999 }).threshold).toBe(95);
  });
});

describe("压缩用的分子与分母", () => {
  it("本轮快照同时给出占用与窗口，算报告值", () => {
    expect(compactNumbers({ provider: "claude", context: snapshot(150000, 200000) })).toMatchObject({ total: 150000, window: 200000, source: "reported" });
  });
  it("过期快照不算本轮占用，宁可不提示", () => {
    expect(compactNumbers({ provider: "claude", context: snapshot(150000, 200000, { stale: true }) })).toBeNull();
  });
  it("Codex 只有用量时也按报告值算", () => {
    const usage: AiUsage = { context: 90000, window: 100000, model: "gpt-5.1-codex" };
    expect(compactNumbers({ provider: "codex", usage })).toMatchObject({ total: 90000, window: 100000, source: "reported", model: "gpt-5.1-codex" });
  });
  it("有占用但没人报过窗口：查该模型的历史报告，并标明来源", () => {
    rememberContextWindow("codex", "gpt-5.1-codex", 272000, 7);
    expect(compactNumbers({ provider: "codex", usage: { context: 200000, model: "gpt-5.1-codex" } }))
      .toMatchObject({ total: 200000, window: 272000, source: "remembered", seenAt: 7 });
  });
  it("连历史都没报告过就不凑一个分母", () => {
    expect(compactNumbers({ provider: "codex", usage: { context: 200000, model: "gpt-5.1-codex" } })).toBeNull();
    expect(compactNumbers({ provider: "claude" })).toBeNull();
  });
});

describe("压缩判定", () => {
  it("还没到阈值就什么都不说", () => {
    expect(compactDecision(state({ context: snapshot(150000, 200000) }))).toMatchObject({ action: "none", percent: 75, noticeId: null, reason: null });
  });
  it("到阈值只提示，用户点头才压", () => {
    expect(compactDecision(state({ context: snapshot(170000, 200000) }))).toMatchObject({ action: "suggest", percent: 85, source: "reported" });
  });
  it("开了自动、数字是本轮报的、也没待发送内容，才自己动手", () => {
    expect(compactDecision(state({ context: snapshot(190000, 200000), prefs: { auto: true, threshold: 80 } })))
      .toMatchObject({ action: "fire", autoGuard: null });
  });
  it("输入框里有半截话时，自动停手但提示照旧", () => {
    expect(compactDecision(state({ context: snapshot(190000, 200000), draft: "还没发出去的一句话", prefs: { auto: true, threshold: 80 } })))
      .toMatchObject({ action: "suggest", autoGuard: "ai.compact.guardDraft" });
  });
  it("分母来自记忆时永不自动", () => {
    rememberContextWindow("claude", "claude-sonnet-4-5", 200000, 1);
    const usage: AiUsage = { context: 190000, model: "claude-sonnet-4-5" };
    expect(compactDecision(state({ usage, prefs: { auto: true, threshold: 80 } })))
      .toMatchObject({ action: "suggest", source: "remembered", autoGuard: "ai.compact.guardRemembered" });
  });
  it("把提示阈值调低也不会提前自动压缩", () => {
    const decision = compactDecision(state({ context: snapshot(150000, 200000), prefs: { auto: true, threshold: 60 } }));
    expect(decision).toMatchObject({ action: "suggest", percent: 75, autoGuard: "ai.compact.guardEarly", autoAt: AUTO_COMPACT_MIN_PERCENT });
  });
  it("本轮还在跑 / 正在停止 / 还在等回答 / 还在排队时不提", () => {
    const busy = state({ context: snapshot(190000, 200000) });
    expect(compactDecision({ ...busy, status: "running" }).reason).toBe("ai.compact.blockRunning");
    expect(compactDecision({ ...busy, status: "running", stopping: true }).reason).toBe("ai.compact.blockStopping");
    expect(compactDecision({ ...busy, pendingRequests: 1 }).reason).toBe("ai.compact.blockRequest");
    expect(compactDecision({ ...busy, queuedTasks: 2 }).reason).toBe("ai.compact.blockQueued");
  });
  it("会话还没绑上原生对话，压缩没有对象", () => {
    expect(compactDecision(state({ boundSession: false, context: snapshot(190000, 200000) }))).toMatchObject({ action: "none", reason: "ai.compact.blockNoSession" });
  });
  it("没有可信数字时不猜，也说得清为什么没有提示", () => {
    expect(compactDecision(state())).toMatchObject({ action: "none", percent: null, reason: "ai.compact.blockNoNumbers" });
  });
  it("点过「这次不用」只静音这一档，跨过下一档重新提", () => {
    const loud = state({ context: snapshot(190000, 200000) });
    const first = compactDecision(loud);
    expect(first.noticeId).toBe("claude:200000:95");
    expect(compactDecision({ ...loud, dismissed: first.noticeId }).action).toBe("none");
    // 分母还在，圆环照旧显示，只是不再放按钮。
    expect(compactDecision({ ...loud, dismissed: first.noticeId }).percent).toBe(95);
    expect(compactDecision({ ...loud, context: snapshot(90000, 100000), dismissed: first.noticeId }).action).toBe("suggest");
  });
  it("压缩指令的意图按引擎走，Codex 的那条不接受参数", () => {
    expect(COMPACT_COMMAND_TEXT).toBe("/compact");
    expect(compactIntent("codex")).toBe("codexCompact");
    expect(compactIntent("claude")).toBe("claudeSlash");
  });
});
