import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  patch: vi.fn(),
  selects: [] as { label: string; value: unknown; onChange: (value: string) => void }[],
  settings: null as unknown,
}));

vi.mock("../../src/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("../../src/hooks/useSettings", () => ({
  useSettings: () => ({ settings: h.settings, patch: h.patch, applied: "light" }),
}));
// 右键菜单只在 Windows 渲染；测试环境没有 navigator.userAgent。
vi.mock("../../src/lib/sys", () => ({ IS_WINDOWS: true }));
vi.mock("../../src/lib/shellOpen", () => ({
  builtinShellExtensions: () => Promise.resolve(["txt", "md"]),
}));
vi.mock("../../src/components/AiCliSettingsPanel", () => ({
  AiAssistantsToggle: () => null,
}));
// 只记录下拉的 props：renderToStaticMarkup 不输出事件处理器，交互断言靠这些 props。
vi.mock("../../src/components/Select", () => ({
  default: (props: { label: string; value: unknown; onChange: (value: string) => void }) => {
    h.selects.push(props);
    return null;
  },
}));

import { AppearanceSystemPage } from "../../src/features/settings/pages/AppearancePages";
import { DEFAULT_SETTINGS } from "../../src/lib/settings";

function renderShell(shell: Partial<(typeof DEFAULT_SETTINGS)["shell"]>) {
  h.selects = [];
  h.settings = { ...DEFAULT_SETTINGS, shell: { ...DEFAULT_SETTINGS.shell, ...shell } };
  return renderToStaticMarkup(createElement(AppearanceSystemPage));
}

function select(label: string) {
  const found = h.selects.find((item) => item.label === label);
  if (!found) throw new Error(`没有 ${label} 这一项：${h.selects.map((item) => item.label).join(",")}`);
  return found;
}

describe("通用 › 系统 › 资源管理器右键菜单", () => {
  beforeEach(() => {
    h.patch.mockClear();
  });

  it("文件右键关闭时不显示默认程序与追加格式", () => {
    const html = renderShell({ openFolder: false, openFile: false });
    expect(h.selects.map((item) => item.label)).toEqual(
      expect.arrayContaining(["shellOpen.folder", "shellOpen.file"])
    );
    expect(h.selects.map((item) => item.label)).not.toContain("shellOpen.default");
    expect(html).not.toContain("shellOpen.extraAdd");
  });

  it("文件右键开启后显示默认程序与追加格式", () => {
    const html = renderShell({ openFile: true, defaultFile: false, extraExtensions: ["prisma"] });
    expect(h.selects.map((item) => item.label)).toContain("shellOpen.default");
    // 追加格式是输入框 + 添加按钮，不是下拉。
    expect(html).toContain('aria-label="shellOpen.extra"');
    expect(html).toContain("shellOpen.extraAdd");
    expect(html).toContain(".prisma");
  });

  it("打开文件夹右键写回 openFolder", () => {
    renderShell({ openFolder: false });
    select("shellOpen.folder").onChange("yes");
    expect(h.patch).toHaveBeenCalledWith({
      shell: expect.objectContaining({ openFolder: true }),
    });
  });

  it("关闭文件右键时一并收回默认程序关联", () => {
    renderShell({ openFolder: true, openFile: true, defaultFile: true, extraExtensions: ["prisma"] });
    select("shellOpen.file").onChange("no");
    expect(h.patch).toHaveBeenCalledWith({
      shell: {
        openFolder: true,
        openFile: false,
        defaultFile: false,
        extraExtensions: ["prisma"],
      },
    });
  });

  it("默认程序开关只改 defaultFile", () => {
    renderShell({ openFile: true, defaultFile: false });
    select("shellOpen.default").onChange("yes");
    expect(h.patch).toHaveBeenCalledWith({
      shell: expect.objectContaining({ openFile: true, defaultFile: true }),
    });
  });
});
