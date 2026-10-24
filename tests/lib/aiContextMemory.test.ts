import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearContextWindows, loadContextWindows, parseContextWindows, recallContextWindow, rememberContextWindow } from "../../src/lib/aiContextMemory";

const KEY = "forge:ai:context-windows:v1";
let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  });
});

const written = () => JSON.parse(store.get(KEY) ?? "[]") as Array<{ provider: string; model: string; window: number; seenAt: number }>;

describe("上下文窗口记忆", () => {
  it("报告过的窗口按 (引擎, 模型) 记住", () => {
    rememberContextWindow("claude", "claude-sonnet-4-5", 200000, 1000);
    expect(recallContextWindow("claude", "claude-sonnet-4-5")?.window).toBe(200000);
    expect(recallContextWindow("claude", "claude-sonnet-4-5")?.seenAt).toBe(1000);
  });
  it("没报告过的模型不编一个窗口", () => {
    rememberContextWindow("claude", "claude-sonnet-4-5", 200000, 1000);
    expect(recallContextWindow("claude", "gpt-5.1-codex")).toBeUndefined();
    expect(recallContextWindow("codex", "claude-sonnet-4-5")).toBeUndefined();
    expect(recallContextWindow("claude", undefined)).toBeUndefined();
    expect(recallContextWindow("claude", "   ")).toBeUndefined();
  });
  it("不可信的数字根本不入库", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 200000.4, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      rememberContextWindow("claude", "m", bad as number, 1);
    }
    expect(written()).toEqual([]);
    expect(loadContextWindows()).toEqual([]);
  });
  it("同一个模型的第二次报告覆盖第一次，包括变小的那种", () => {
    rememberContextWindow("claude", "m", 200000, 1);
    rememberContextWindow("claude", "m", 128000, 2);
    expect(written()).toEqual([{ provider: "claude", model: "m", window: 128000, seenAt: 2 }]);
    expect(recallContextWindow("claude", "m")?.window).toBe(128000);
  });
  it("模型写法不同算两条，不猜它们是同一个", () => {
    rememberContextWindow("claude", "Claude-Sonnet", 200000, 1);
    rememberContextWindow("claude", "claude-sonnet", 128000, 2);
    expect(recallContextWindow("claude", "Claude-Sonnet")?.window).toBe(200000);
    expect(recallContextWindow("claude", "claude-sonnet")?.window).toBe(128000);
  });
  it("最近报告过的排在前面，超出上限只丢最老的", () => {
    for (let index = 0; index < 30; index += 1) rememberContextWindow("claude", `m${index}`, 1000 + index, index);
    const rows = loadContextWindows();
    expect(rows.length).toBe(24);
    expect(rows[0]).toMatchObject({ model: "m29", window: 1029 });
    expect(recallContextWindow("claude", "m0")).toBeUndefined();
  });
  it("一条写坏的数据不带走其他已知窗口", () => {
    store.set(KEY, JSON.stringify([
      { provider: "claude", model: "good", window: 200000, seenAt: 1 },
      { provider: "gemini", model: "unknown-engine", window: 100000, seenAt: 1 },
      { provider: "claude", model: "zero", window: 0, seenAt: 1 },
      { provider: "claude", model: "", window: 1000, seenAt: 1 },
      { provider: "claude", model: "stringy", window: "200000", seenAt: 1 },
      null, "text", [1, 2],
      { provider: "codex", model: "gpt-5.1", window: 272000, seenAt: -5 },
      { provider: "codex", model: "gpt-5.1-codex", window: 272000, seenAt: 2 },
    ]));
    expect(loadContextWindows().map((item) => item.model)).toEqual(["good", "gpt-5.1-codex"]);
  });
  it("模型 id 超长只裁剪，不整条拒绝", () => {
    const long = "x".repeat(300);
    rememberContextWindow("claude", long, 200000, 1);
    expect(written()[0].model).toHaveLength(200);
    expect(recallContextWindow("claude", long)?.window).toBe(200000);
  });
  it("存储坏了也只是没有分母，不抛给用户", () => {
    store.set(KEY, "{不是 JSON");
    expect(loadContextWindows()).toEqual([]);
    expect(recallContextWindow("claude", "m")).toBeUndefined();
    expect(() => rememberContextWindow("claude", "m", 200000, 1)).not.toThrow();
    expect(parseContextWindows("[1,2]")).toEqual([]);
  });
  it("整体清空只删这一串键，不碰草稿和运行选项", () => {
    rememberContextWindow("claude", "m", 200000, 1);
    store.set("forge:ai:defaults:v1:claude", "{}");
    clearContextWindows();
    expect(store.has(KEY)).toBe(false);
    expect(store.has("forge:ai:defaults:v1:claude")).toBe(true);
  });
});
