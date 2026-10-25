import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedAiSessionOptions } from "../../src/lib/aiDraftSession";
import { loadAiOptions, readAiOptions, saveAiOptions, resolveAiModel } from "../../src/lib/aiOptions";
import { aiSessionStorageKey } from "../../src/lib/aiSessions";

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
  it("新会话复制草稿页自己的配置，不受其他会话最后选择影响", () => {
    const root = "D:/project";
    const draftKey = "forge:ai-draft-options:v1:codex";
    const sessionKey = `${aiSessionStorageKey(root)}:options:new-session`;
    saveAiOptions(draftKey, "codex", { model: "draft-model", mode: "plan", permission: "read" });
    // 草稿仍开着时，另一个会话修改配置；全局默认会变化，但不能污染这次草稿。
    saveAiOptions("other-session", "codex", { model: "other-model", mode: "default", permission: "full" });
    seedAiSessionOptions(root, "new-session", "codex");
    expect(loadAiOptions(sessionKey, "codex")).toMatchObject({ model: "draft-model", mode: "plan", permission: "read" });
  });
  it("remembers the selected mode as a choice and preselects it on the next open", () => {
    saveAiOptions("plan", "claude", { mode: "plan" });
    expect(loadAiOptions("plan", "claude").mode).toBe("plan");
    // 新会话首屏就要选中上次记的那一档，而不是每次都回到默认。
    expect(loadAiOptions("fresh", "claude").mode).toBe("plan");
    // 旧数据把计划模式存成布尔：读出来是模式列表里的同一项。
    localStorage.setItem("legacy-plan", '{"planMode":true}');
    expect(readAiOptions("legacy-plan").mode).toBe("plan");
    // 升级前存下的会话没有 mode：沿用该引擎上次的模式，不能显示成「没选」。
    saveAiOptions("seed", "codex", { mode: "default" });
    localStorage.setItem("legacy-none", '{"model":"gpt-6-astra"}');
    expect(loadAiOptions("legacy-none", "codex").mode).toBe("default");
    // 形状不对的字符串不认；它绝不能原样变成 CLI 参数。
    localStorage.setItem("bad-mode", '{"mode":"--permission-mode"}');
    expect(readAiOptions("bad-mode").mode).toBeUndefined();
  });
  it("ignores malformed storage", () => {
    for (const stored of ["null", "broken", '{"model":1,"effort":false,"fast":"true","permission":7}', '{"mode":{}}']) {
      localStorage.setItem("bad", stored);
      expect(readAiOptions("bad")).toEqual({});
    }
  });
});
