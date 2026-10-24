import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAiOptions, readAiOptions, saveAiOptions, resolveAiModel } from "../../src/lib/aiOptions";

beforeEach(() => {
  const values = new Map<string, string>();
  const session = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value), removeItem: (key: string) => session.delete(key) });
});
describe("AI option persistence", () => {
  it("resolves display names, case variants and catalog IDs to the actual model parameter", () => {
    const catalog = { models: [{ id: "gpt-6-astra", catalogId: "astra-picker", name: "GPT-6 Astra", efforts: [] }], customModel: true, efforts: [], authoritative: true, remote: false };
    for (const value of ["GPT-6-Astra", "gpt-6-astra", "GPT-6 Astra", "astra-picker"]) expect(resolveAiModel(catalog, value)).toBe("gpt-6-astra");
    expect(resolveAiModel(catalog, "Vendor/CaseSensitiveModel")).toBe("Vendor/CaseSensitiveModel");
    expect(resolveAiModel({ ...catalog, models: [...catalog.models, { id: "other", name: "GPT-6 Astra", efforts: [] }] }, "GPT-6 Astra")).toBe("GPT-6 Astra");
  });
  it("remembers the last Codex selection and permission mode in Forge's own storage", () => {
    saveAiOptions("old", "codex", { model: "chosen", effort: "high", fast: true, permission: "auto" });
    // 当前会话与新会话都沿用上次的普通权限模式。
    expect(loadAiOptions("old", "codex")).toEqual({ model: "chosen", effort: "high", fast: true, permission: "auto" });
    expect(loadAiOptions("new", "codex")).toEqual({ model: "chosen", effort: "high", fast: true, permission: "auto" });
  });
  it("keeps full access across sessions and restarts", () => {
    saveAiOptions("prev", "codex", { permission: "auto" });
    saveAiOptions("old", "codex", { permission: "full" });
    // 完全访问也是用户明确选择的模式：同一会话、新会话和重启后都保持。
    expect(loadAiOptions("old", "codex").permission).toBe("full");
    expect(loadAiOptions("new", "codex").permission).toBe("full");
    expect(readAiOptions("old").permission).toBe("full");
  });
  it("remembers the Codex read-only mode instead of dropping it", () => {
    saveAiOptions("ro", "codex", { permission: "read" });
    expect(loadAiOptions("ro", "codex").permission).toBe("read");
    expect(loadAiOptions("new", "codex").permission).toBe("read");
  });
  it("falls back to the last ordinary mode for legacy keys without a permission", () => {
    saveAiOptions("seed", "codex", { permission: "auto" });
    localStorage.setItem("legacy", '{"model":"gpt-6-astra"}');
    expect(loadAiOptions("legacy", "codex").permission).toBe("auto");
  });
  it("keeps Claude session choices separate from the provider defaults", () => {
    saveAiOptions("first", "claude", { model: "one", effort: "low" });
    saveAiOptions("second", "claude", { model: "two", effort: "high" });
    expect(loadAiOptions("first", "claude").model).toBe("one");
    saveAiOptions("first", "claude", {});
    expect(loadAiOptions("first", "claude").model).toBeUndefined();
    expect(loadAiOptions("new", "codex").model).toBeUndefined();
  });
  it("ignores malformed storage", () => {
    for (const stored of ["null", "broken", '{"model":1,"effort":false,"fast":"true","permission":7}']) {
      localStorage.setItem("bad", stored);
      expect(readAiOptions("bad")).toEqual({});
    }
  });
});
