import { describe, expect, it } from "vitest";
import { compareModels, modelAliases, modelGeneration, stripContextMarker, stripSnapshot } from "../../src/lib/aiModelMatch";

describe("stripContextMarker", () => {
  it("removes only a trailing tier bracket", () => {
    expect(stripContextMarker("gpt-5.1-codex[1m]")).toBe("gpt-5.1-codex");
    expect(stripContextMarker("gpt-5.1-codex")).toBe("gpt-5.1-codex");
  });
});

describe("stripSnapshot", () => {
  it("peels dated and channel snapshots", () => {
    expect(stripSnapshot("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet");
    expect(stripSnapshot("o3-2025-04-16")).toBe("o3");
    expect(stripSnapshot("gpt-5@latest")).toBe("gpt-5");
    expect(stripSnapshot("claude-sonnet-4-5-latest")).toBe("claude-sonnet-4-5");
  });

  it("leaves version numbers that are not snapshots alone", () => {
    expect(stripSnapshot("gpt-5.1-codex")).toBe("gpt-5.1-codex");
    expect(stripSnapshot("gemini-2.0-flash-001")).toBe("gemini-2.0-flash-001");
  });
});

describe("modelGeneration", () => {
  it("ignores both the tier bracket and the snapshot", () => {
    expect(modelGeneration("Claude-Sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(modelGeneration("gpt-5.1-codex[1m]")).toBe("gpt-5.1-codex");
  });
});

describe("modelAliases", () => {
  it("keeps only aliases that actually point somewhere else", () => {
    const aliases = modelAliases([
      { id: "sonnet", name: "Sonnet", efforts: [], configuredModel: "claude-sonnet-4-5-20250929" },
      { id: "haiku", name: "Haiku", efforts: [], configuredModel: "haiku" },
      { id: "opus", name: "Opus", efforts: [] },
    ]);
    expect(aliases).toEqual({ sonnet: "claude-sonnet-4-5-20250929" });
  });

  it("tolerates a missing catalog", () => {
    expect(modelAliases(undefined)).toEqual({});
  });
});

describe("compareModels", () => {
  it("says unknown whenever one side is missing", () => {
    const aliases = { sonnet: "claude-sonnet-4-5-20250929" };
    expect(compareModels(undefined, "gpt-5", aliases)).toBe("unknown");
    expect(compareModels("gpt-5", undefined, aliases)).toBe("unknown");
    // 没选模型＝沿用 CLI 默认，默认是什么我们并不知道。
    expect(compareModels("", "gpt-5", aliases)).toBe("unknown");
  });

  it("matches an exact id regardless of case", () => {
    expect(compareModels("GPT-5.1-Codex", "gpt-5.1-codex")).toBe("match");
  });

  it("matches once the alias resolves to the served snapshot", () => {
    const aliases = { sonnet: "claude-sonnet-4-5-20250929" };
    expect(compareModels("sonnet", "claude-sonnet-4-5-20250929", aliases)).toBe("match");
  });

  it("follows an alias that points at another alias", () => {
    const aliases = { default: "sonnet", sonnet: "claude-sonnet-4-5-20250929" };
    expect(compareModels("default", "claude-sonnet-4-5-20250929", aliases)).toBe("match");
  });

  it("still calls a bracketed alias by its target", () => {
    const aliases = { sonnet: "claude-sonnet-4-5-20250929" };
    expect(compareModels("sonnet[1m]", "claude-sonnet-4-5-20250929", aliases)).toBe("variant");
  });

  it("reports a different tier or snapshot of the same model as a variant", () => {
    expect(compareModels("gpt-5.1-codex", "gpt-5.1-codex[1m]")).toBe("variant");
    expect(compareModels("claude-sonnet-4-5", "claude-sonnet-4-5-20250929")).toBe("variant");
    expect(compareModels("claude-sonnet-4-5", "claude-sonnet-4-5-latest")).toBe("variant");
  });

  it("reports another model as a mismatch", () => {
    expect(compareModels("gpt-5", "gpt-5.1-codex")).toBe("mismatch");
    expect(compareModels("sonnet", "claude-opus-4-1-20250805", { sonnet: "claude-sonnet-4-5-20250929" })).toBe("mismatch");
  });

  it("trims whitespace on both sides", () => {
    expect(compareModels("  gpt-5  ", " gpt-5 ")).toBe("match");
  });
});
