import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../../src/lib/settings";

beforeEach(() => { invoke.mockReset(); });

describe("AI 编程助手设置", () => {
  it("浏览器和截图默认启用，上传和任意脚本必须显式授权", async () => {
    invoke.mockResolvedValue({ aiAssistantsEnabled: true });
    expect((await loadSettings()).browser).toEqual({ enabled: true, renderedPixels: true, unsafeEvaluate: false, fileUpload: false, elementContent: "both" });
    invoke.mockResolvedValue({ browser: { enabled: false, renderedPixels: "true", unsafeEvaluate: 1, fileUpload: true } });
    expect((await loadSettings()).browser).toEqual({ enabled: false, renderedPixels: false, unsafeEvaluate: false, fileUpload: true, elementContent: "both" });
  });
  it("明确关闭截图后保持关闭，单独授权上传不会开启任意脚本", async () => {
    const browser = { enabled: true, renderedPixels: false, unsafeEvaluate: false, fileUpload: true, elementContent: "both" as const };
    invoke.mockResolvedValue({ browser });
    expect((await saveSettings({ browser })).browser).toEqual(browser);
    expect(invoke).toHaveBeenCalledWith("settings_save", { patch: { browser } });
    invoke.mockResolvedValue({ browser: { enabled: true } });
    expect((await loadSettings()).browser).toEqual(DEFAULT_SETTINGS.browser);
  });
  it("切换截图只发送对应字段，不携带旧的上传或脚本授权", async () => {
    invoke.mockResolvedValue({ browser: { renderedPixels: false, fileUpload: false, unsafeEvaluate: false } });
    const saved = await saveSettings({ browser: { renderedPixels: false } });
    expect(invoke).toHaveBeenCalledWith("settings_save", { patch: { browser: { renderedPixels: false } } });
    expect(saved.browser).toEqual({ enabled: true, renderedPixels: false, fileUpload: false, unsafeEvaluate: false, elementContent: "both" });
  });
  it("元素发送内容可保存三种模式，无效设置恢复截图和代码", async () => {
    for (const elementContent of ["code", "screenshot", "both"] as const) {
      invoke.mockResolvedValue({ browser: { elementContent } });
      expect((await saveSettings({ browser: { elementContent } })).browser.elementContent).toBe(elementContent);
      expect(invoke).toHaveBeenLastCalledWith("settings_save", { patch: { browser: { elementContent } } });
    }
    invoke.mockResolvedValue({ browser: { elementContent: "invalid" } });
    expect((await loadSettings()).browser.elementContent).toBe("both");
  });
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
