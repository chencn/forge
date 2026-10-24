import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke, isTauri: () => true }));

import {
  AI_SEARCH_MAX_HITS,
  AI_SEARCH_MIN_QUERY,
  createAiSearchTracker,
  groupAiSearchHits,
  isSearchQueryActive,
  normalizeSearchQuery,
  parseSearchResult,
  searchAiSessions,
  splitAiSearchSnippet,
} from "../../src/lib/aiSearch";
import type { AiSearchHit } from "../../src/lib/aiSearch";

function hit(over: Partial<AiSearchHit> = {}): AiSearchHit {
  return { sessionId: "s1", sessionTitle: "标题", provider: "codex", createdAt: 10, seq: 3, kind: "text",
    text: "前面 keyword 后面", start: 3, length: 7, leading: true, trailing: true, ...over };
}

beforeEach(() => {
  h.invoke.mockReset();
  h.invoke.mockImplementation(async () => ({}));
});

describe("查询词", () => {
  it("只清首尾空白，中间的空格是用户要打的内容", () => {
    expect(normalizeSearchQuery("  fix  the  build ")).toBe("fix  the  build");
    expect(normalizeSearchQuery("   ")).toBe("");
  });
  it("超长查询按后端上限截断，不会把整段话当关键词", () => {
    expect(normalizeSearchQuery("字".repeat(300))).toHaveLength(200);
  });
  it("一个字符不扫盘", () => {
    expect(isSearchQueryActive("a")).toBe(false);
    expect(isSearchQueryActive(" a ")).toBe(false);
    expect(isSearchQueryActive("ab")).toBe(true);
    expect(AI_SEARCH_MIN_QUERY).toBe(2);
  });
});

describe("结果解析", () => {
  it("字段齐全时原样收下，计数不猜", () => {
    const parsed = parseSearchResult({ hits: [hit()], scanned: 3, skipped: 1, bytes: 4096, truncated: true });
    expect(parsed.hits).toHaveLength(1);
    expect(parsed).toMatchObject({ scanned: 3, skipped: 1, bytes: 4096, truncated: true });
  });
  it("坏数据整条丢掉，好数据一条不损失", () => {
    const parsed = parseSearchResult({ hits: [null, 7, { sessionId: "", text: "x" }, { sessionId: "s", text: "x", provider: "gemini" }, hit()], scanned: 2 });
    expect(parsed.hits.map((item) => item.sessionId)).toEqual(["s1"]);
    expect(parsed.skipped).toBe(0);
  });
  it("标题缺失不等于会话不存在：留空但保留 sessionId", () => {
    const parsed = parseSearchResult({ hits: [{ sessionId: "s9", text: "内容", provider: "claude" }] });
    expect(parsed.hits[0]).toMatchObject({ sessionId: "s9", sessionTitle: "", createdAt: 0, seq: 0, kind: "text", leading: false, trailing: false });
  });
  it("空响应与脏响应都只说明「没有命中」，不谎称扫过了什么", () => {
    for (const raw of [undefined, null, "x", {}, { hits: "no" }]) {
      expect(parseSearchResult(raw)).toEqual({ hits: [], scanned: 0, skipped: 0, bytes: 0, truncated: false });
    }
  });
  it("偏移越界夹回文本范围内", () => {
    const parsed = parseSearchResult({ hits: [{ sessionId: "s", text: "短", provider: "codex", start: 99, length: 99 }] });
    expect(parsed.hits[0]).toMatchObject({ start: 1, length: 0 });
  });
});

describe("片段切分", () => {
  it("按后端给的 UTF-16 码元偏移切，emoji 也不会切歪", () => {
    const parts = splitAiSearchSnippet(hit({ text: "前😀后 keyword 结尾", start: 5, length: 7 }));
    expect(parts).toMatchObject({ before: "前😀后 ", match: "keyword", after: " 结尾", leading: true, trailing: true });
  });
  it("命中在开头或结尾时不硬凑前后文", () => {
    expect(splitAiSearchSnippet(hit({ text: "keyword 结尾", start: 0, length: 7, leading: false }))).toMatchObject({ before: "", match: "keyword", after: " 结尾" });
    expect(splitAiSearchSnippet(hit({ text: "前面 keyword", start: 3, length: 7, trailing: false })).after).toBe("");
  });
});

describe("按会话归组", () => {
  it("保持后端的时间倒序，同一会话的命中并在一起", () => {
    const groups = groupAiSearchHits([hit({ sessionId: "b", seq: 1 }), hit({ sessionId: "a", seq: 2 }), hit({ sessionId: "b", seq: 5 })]);
    expect(groups.map((group) => group.sessionId)).toEqual(["b", "a"]);
    expect(groups[0].hits.map((item) => item.seq)).toEqual([1, 5]);
    expect(groups[0].sessionTitle).toBe("标题");
  });
  it("没有命中就没有分组", () => {
    expect(groupAiSearchHits([])).toEqual([]);
  });
});

describe("过期响应", () => {
  it("只有最新一次查询能落地；旧结果与旧错误都不算数", () => {
    const tracker = createAiSearchTracker();
    const old = tracker.begin("fi");
    const fresh = tracker.begin("fix");
    expect(tracker.pending()).toBe("fix");
    expect(tracker.settle(old)).toBe(false);
    // 旧响应落地不能把仍在等待的新查询清空。
    expect(tracker.pending()).toBe("fix");
    expect(tracker.settle(fresh)).toBe(true);
    expect(tracker.pending()).toBeNull();
  });
});

describe("发查询", () => {
  it("带上范围与上限，回来的是解析过的结果", async () => {
    h.invoke.mockImplementation(async () => ({ hits: [hit()], scanned: 1, skipped: 0, bytes: 10, truncated: false }));
    const result = await searchAiSessions("D:/p", "  keyword ", false);
    expect(h.invoke).toHaveBeenCalledWith("ai_runtime_search", { workspace: "D:/p", query: "keyword", limit: AI_SEARCH_MAX_HITS, includeArchived: false });
    expect(result.hits).toHaveLength(1);
  });
  it("空查询不发请求：磁盘一次都不用碰", async () => {
    expect((await searchAiSessions("D:/p", "   ", true)).hits).toEqual([]);
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it("后端报错原样抛出，交给界面区分「没搜成」和「没命中」", async () => {
    h.invoke.mockImplementation(async () => { throw new Error("AI 助手已关闭"); });
    await expect(searchAiSessions("D:/p", "fix", false)).rejects.toThrow("AI 助手已关闭");
  });
});
