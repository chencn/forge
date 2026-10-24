import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../../src/lib/settings";

beforeEach(() => { invoke.mockReset(); });

describe("AI 编程助手设置", () => {
  it("默认关闭，旧设置缺字段时保持关闭", async () => {
    expect(DEFAULT_SETTINGS.aiAssistantsEnabled).toBe(false);
    invoke.mockResolvedValue({ theme: "dark" });
    const settings = await loadSettings();
    expect(settings.aiAssistantsEnabled).toBe(false);
    expect(settings.theme).toBe("dark");
  });

  it.each([null, "true", 1, false])("无效或关闭值 %s 不启用功能", async (value) => {
    invoke.mockResolvedValue({ aiAssistantsEnabled: value });
    expect((await loadSettings()).aiAssistantsEnabled).toBe(false);
  });

  it("保存只发改动的那几个字段，并拿回合并后的全量设置", async () => {
    invoke.mockResolvedValue({ aiAssistantsEnabled: true });
    const saved = await saveSettings({ aiAssistantsEnabled: true });
    expect(invoke).toHaveBeenCalledWith("settings_save", { patch: { aiAssistantsEnabled: true } });
    // 后端返回的是文件里合并后的文档，可能只含存过的键；前端仍要拿到一份补齐默认值的完整设置。
    expect(saved.aiAssistantsEnabled).toBe(true);
    expect(saved.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(saved.workspaceMode).toBe("multi");
  });

  it("保存失败如实抛出，不静默当成已落盘", async () => {
    invoke.mockRejectedValue(new Error("SETTINGS_JSON: 设置文件坏了"));
    await expect(saveSettings({ theme: "dark" })).rejects.toThrow("设置文件坏了");
  });

  it("读取失败时默认关闭", async () => {
    invoke.mockRejectedValue(new Error("unavailable"));
    expect((await loadSettings()).aiAssistantsEnabled).toBe(false);
  });
});
