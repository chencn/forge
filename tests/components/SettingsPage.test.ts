import { describe, expect, it } from "vitest";
import { visibleSettingsModules } from "../../src/components/SettingsPage";

describe("设置页导航", () => {
  it("总开关关闭时仍保留模型供应商，只摘掉依赖会话的 AI 页", () => {
    const off = visibleSettingsModules(false);
    expect(off).toContain("modelProviders");
    expect(off).toContain("aiCommit");
    expect(off).not.toContain("aiCli");
    expect(off).not.toContain("skills");
    expect(off).not.toContain("hooks");

    const on = visibleSettingsModules(true);
    expect(on).toEqual(expect.arrayContaining(["modelProviders", "aiCommit", "aiCli", "hooks"]));
    expect(on.length).toBeGreaterThan(off.length);
  });
});
