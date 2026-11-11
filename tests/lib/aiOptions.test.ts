import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiDraftOptionsKey, initializeAiDraftOptions, seedAiSessionOptions } from "../../src/lib/aiDraftSession";
import { loadAiDefaultOptions, loadAiOptions, readAiOptions, saveAiOptions, resolveAiModel } from "../../src/lib/aiOptions";
import { aiSessionStorageKey } from "../../src/lib/aiSessions";
import { loadAdditionalDirs, saveAdditionalDirs } from "../../src/lib/aiDrafts";

beforeEach(() => {
  const values = new Map<string, string>();
  const session = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value), removeItem: (key: string) => session.delete(key) });
});
describe("AI option persistence", () => {
  it("供应商与所有档位只改变当前会话，未来新草稿继承最新选择", () => {
    saveAiOptions("a", "codex", { providerId: "gateway-a", model: "a-model", effort: "high", permission: "read" });
    initializeAiDraftOptions("D:/one");
    saveAiOptions("b", "codex", { providerId: "gateway-b", model: "b-model", effort: "low", permission: "full" });
    expect(loadAiOptions("a", "codex")).toMatchObject({ providerId: "gateway-a", model: "a-model", permission: "read" });
    expect(loadAiOptions("existing-without-options", "codex")).toEqual({});
    initializeAiDraftOptions("D:/two");
    seedAiSessionOptions("D:/one", "first", "codex");
    expect(loadAiOptions(`${aiSessionStorageKey("D:/one")}:options:first`, "codex").providerId).toBe("gateway-a");
    expect(loadAiOptions(aiDraftOptionsKey("codex", "D:/two"), "codex").providerId).toBe("gateway-b");
    saveAiOptions("a", "codex", { providerId: undefined, model: "native-model", permission: "ask" });
    initializeAiDraftOptions("D:/one");
    expect(loadAiOptions(aiDraftOptionsKey("codex", "D:/one"), "codex")).toMatchObject({ model: "native-model", permission: "ask" });
    expect(loadAiOptions(aiDraftOptionsKey("codex", "D:/one"), "codex").providerId).toBeUndefined();
    expect(loadAiOptions("b", "codex").providerId).toBe("gateway-b");
    expect(loadAiDefaultOptions("claude").providerId).toBeUndefined();
  });
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
    expect(loadAiDefaultOptions("codex")).toEqual({ model: "chosen", effort: "high", fast: true, permission: "auto" });
  });
  it("keeps full access across sessions and restarts", () => {
    saveAiOptions("prev", "codex", { permission: "auto" });
    saveAiOptions("old", "codex", { permission: "full" });
    // 完全访问也是用户明确选择的模式：同一会话、新会话和重启后都保持。
    expect(loadAiOptions("old", "codex").permission).toBe("full");
    expect(loadAiDefaultOptions("codex").permission).toBe("full");
    expect(readAiOptions("old").permission).toBe("full");
  });
  it("remembers the Codex read-only mode instead of dropping it", () => {
    saveAiOptions("ro", "codex", { permission: "read" });
    expect(loadAiOptions("ro", "codex").permission).toBe("read");
    expect(loadAiDefaultOptions("codex").permission).toBe("read");
  });
  it("does not change legacy sessions when another session changes defaults", () => {
    saveAiOptions("seed", "codex", { permission: "auto" });
    localStorage.setItem("legacy", '{"model":"gpt-6-astra"}');
    expect(loadAiOptions("legacy", "codex").permission).toBeUndefined();
  });
  it("keeps Claude session choices separate from the provider defaults", () => {
    saveAiOptions("first", "claude", { model: "one", effort: "low" });
    saveAiOptions("second", "claude", { model: "two", effort: "high" });
    expect(loadAiOptions("first", "claude").model).toBe("one");
    saveAiOptions("first", "claude", {});
    expect(loadAiOptions("first", "claude").model).toBeUndefined();
    expect(loadAiDefaultOptions("codex").model).toBeUndefined();
  });
  it("新会话复制草稿页自己的配置，不受其他会话最后选择影响", () => {
    const root = "D:/project";
    const draftKey = aiDraftOptionsKey("codex", root);
    const sessionKey = `${aiSessionStorageKey(root)}:options:new-session`;
    saveAiOptions(draftKey, "codex", { model: "draft-model", mode: "plan", permission: "read" });
    saveAdditionalDirs(root, "draft", ["C:/Temp/forge-context"]);
    saveAdditionalDirs("D:/other", "draft", ["C:/Temp/other-context"]);
    // 草稿仍开着时，另一个会话修改配置；全局默认会变化，但不能污染这次草稿。
    saveAiOptions("other-session", "codex", { model: "other-model", mode: "default", permission: "full" });
    seedAiSessionOptions(root, "new-session", "codex");
    expect(loadAiOptions(sessionKey, "codex")).toMatchObject({ model: "draft-model", mode: "plan", permission: "read" });
    expect(loadAdditionalDirs(root, "new-session")).toEqual(["C:/Temp/forge-context"]);
  });
  it("remembers the selected mode as a choice and preselects it on the next open", () => {
    saveAiOptions("plan", "claude", { mode: "plan" });
    expect(loadAiOptions("plan", "claude").mode).toBe("plan");
    // 新会话首屏就要选中上次记的那一档，而不是每次都回到默认。
    expect(loadAiDefaultOptions("claude").mode).toBe("plan");
    // 旧数据把计划模式存成布尔：读出来是模式列表里的同一项。
    localStorage.setItem("legacy-plan", '{"planMode":true}');
    expect(readAiOptions("legacy-plan").mode).toBe("plan");
    // 已有会话缺少 mode 时保持缺省，不被其他会话的选择串改。
    saveAiOptions("seed", "codex", { mode: "default" });
    localStorage.setItem("legacy-none", '{"model":"gpt-6-astra"}');
    expect(loadAiOptions("legacy-none", "codex").mode).toBeUndefined();
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
