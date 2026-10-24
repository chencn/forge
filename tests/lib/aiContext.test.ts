import { describe, expect, it } from "vitest";
import { contextShare, normalizeAiContext } from "../../src/lib/aiContext";

export const contextFixture = {
  detail: "summary", capturedAt: 1700000000000, model: "fixture", requestedModel: "alias", totalTokens: 6000, rawMaxTokens: 10000,
  categories: [
    { name: "System prompt", tokens: 1000, kind: "used" },
    { name: "MCP tools", tokens: 2000, kind: "used" },
    { name: "Messages", tokens: 3000, kind: "used" },
    { name: "Free space", tokens: 3000, kind: "free" },
    { name: "Autocompact buffer", tokens: 1000, kind: "buffer" },
    { name: "MCP tools (deferred)", tokens: 90000, kind: "deferred" },
  ],
  systemPromptSections: [{ name: "Base", tokens: 1000 }],
  mcpTools: [{ name: "fixture_read", serverName: "fixture-server", tokens: 2000, isLoaded: true }, { name: "fixture_deferred", serverName: "fixture-server", tokens: 90000, isLoaded: false }],
  memoryFiles: [{ path: "fixture/CLAUDE.md", type: "Project", tokens: 100 }],
  messageBreakdown: { userMessageTokens: 500, assistantMessageTokens: 2500, toolCallsByType: [{ name: "Read", callTokens: 100, resultTokens: 200 }], attachmentsByType: [{ name: "file", tokens: 10 }] },
  apiUsage: { input_tokens: 99999 },
};

describe("context composition", () => {
  it("keeps definitions, messages, files and out-of-window items separate", () => {
    const context = normalizeAiContext(contextFixture, "run")!;
    expect(context.total).toBe(6000);
    expect(context.requestedModel).toBe("alias");
    expect(context.categories.filter((row) => row.kind === "used").reduce((sum, row) => sum + row.tokens, 0)).toBe(6000);
    expect(context.sections.mcp?.[1].loaded).toBe(false);
    expect(context.sections.files?.[0].name).toBe("fixture/CLAUDE.md");
    expect(context.sections.messages).toHaveLength(2);
    expect(context.sections.toolCalls?.[0].tokens).toBe(100);
    expect(context.sections.toolResults?.[0].tokens).toBe(200);
    expect(context.sections.systemTools).toBeUndefined();
    expect(context).not.toHaveProperty("apiUsage");
  });
  it("classifies by kind, not a translated or misleading name", () => {
    const context = normalizeAiContext({ ...contextFixture, categories: [{ name: "System prompt", tokens: 999, kind: "deferred" }] }, "run")!;
    expect(context.categories[0].kind).toBe("deferred");
  });
  it.each([-1, NaN, Infinity, "100", null])("rejects invalid totals %s instead of showing zero", (totalTokens) => {
    expect(normalizeAiContext({ ...contextFixture, totalTokens }, "run")).toBeUndefined();
  });
  it("rejects incomplete snapshots and unknown kinds", () => {
    for (const changes of [{ detail: "full" }, { rawMaxTokens: 0 }, { categories: [] }, { categories: [{ name: "x", tokens: -1, kind: "used" }] }, { categories: [{ name: "x", tokens: 1, kind: "future" }] }]) {
      expect(normalizeAiContext({ ...contextFixture, ...changes }, "run")).toBeUndefined();
    }
  });
  it("preserves over-limit and small shares without adding deferred tokens", () => {
    expect(contextShare(6000, 10000)).toBe("60%");
    expect(contextShare(11000, 10000)).toBe("110%");
    expect(contextShare(1, 10000)).toBe("<0.1%");
    expect(contextShare(0, 10000)).toBe("0%");
  });
});
