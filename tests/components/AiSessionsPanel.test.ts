import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiCliStatus, AiProvider } from "../../src/lib/aiCli";
import type { AiSession } from "../../src/lib/aiSessions";
import { __resetAiSidebarViewForTest, toggleAiSidebarSection } from "../../src/lib/aiSidebarView";

const h = vi.hoisted(() => ({
  desktop: true,
  enabled: true,
  patch: vi.fn(),
  cli: { statuses: {} as Partial<Record<AiProvider, AiCliStatus>>, checking: false, operation: null, results: {},
    error: null as string | null, checked: true },
  settings: { version: 1, agents: {
    claude: { enabled: true, sortOrder: 0, env: {} },
    codex: { enabled: true, sortOrder: 1, env: {} },
  } },
}));
vi.mock("../../src/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("../../src/lib/aiCli", async (original) => ({
  ...await original<typeof import("../../src/lib/aiCli")>(),
  useAiCli: () => h.cli,
  useAiCliSettings: () => ({ settings: h.settings, loaded: true, loading: false, saving: false, error: null }),
  refreshAiCliSettings: vi.fn(),
  cliDesktopAvailable: () => h.desktop,
  refreshAiCli: vi.fn(),
}));
vi.mock("../../src/hooks/useSettings", () => ({
  useSettings: () => ({ settings: { aiAssistantsEnabled: h.enabled }, patch: h.patch }),
}));
import AiSessionsPanel, { AiSessionsToolbar } from "../../src/components/AiSessionsPanel";
import AiSidebarCard from "../../src/components/AiSidebarCard";
import AiCliSettingsPanel, { AiAssistantsToggle, AiCliSettingsControls } from "../../src/components/AiCliSettingsPanel";
import Select from "../../src/components/Select";
import AiProviderIcon, { AiTabProviderIcon } from "../../src/components/AiProviderIcon";

function installed(provider: AiProvider): AiCliStatus {
  return { provider, installed: true, version: "1.2.3", path: null, source: "external", latestVersion: null, latestSource: null,
    updateAvailable: false, canInstall: false, canUpdate: false, canUninstall: false,
    prerequisiteError: null, probeError: null, latestError: "offline" };
}
function render(sessions: AiSession[] = []) {
  return renderToStaticMarkup(createElement(Fragment, null,
    createElement("header", null, "ai.title", createElement(AiSessionsToolbar, { onSettings: vi.fn() })),
    createElement(AiSessionsPanel, {
      sessions, openIds: [], activeId: null, storageError: false,
      // 这一组用例不碰磁盘：项目根给 null，搜索入口不出现。
      workspace: null,
      onOpen: vi.fn(), onAction: vi.fn(), onNew: vi.fn(),
    }),
  ));
}
beforeEach(() => {
  h.desktop = true;
  h.enabled = true;
  h.patch.mockClear();
  h.cli = { statuses: {}, checking: false, operation: null, results: {}, error: null, checked: true };
  h.settings = { version: 1, agents: {
    claude: { enabled: true, sortOrder: 0, env: {} },
    codex: { enabled: true, sortOrder: 1, env: {} },
  } };
  __resetAiSidebarViewForTest();
});

describe("工具品牌图标配色", () => {
  it("claude 使用品牌橙色而非继承文字颜色", () => {
    const html = renderToStaticMarkup(createElement(AiProviderIcon, { provider: "claude" }));
    expect(html).toContain('fill="#D97757"');
    expect(html).not.toContain('fill="currentColor"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("codex 使用官方渐变标，和 codeg 一致", () => {
    const html = renderToStaticMarkup(createElement(AiProviderIcon, { provider: "codex" }));
    expect(html).toContain("linearGradient");
    expect(html).toContain('stop-color="#B1A7FF"');
    expect(html).toContain('stop-color="#7A9DFF"');
    expect(html).toContain('stop-color="#3941FF"');
    expect(html).toContain('viewBox="2 2 20 20"');
    expect(html).not.toContain('fill="currentColor"');
    expect(html).toContain('aria-hidden="true"');
  });
});

describe("AI 功能总开关", () => {
  it("Claude 详情包含认证与模型配置管理", () => {
    const panel = renderToStaticMarkup(createElement(AiCliSettingsPanel));
    expect(panel).toContain("ai.cfg.title");
    expect(panel).toContain("ai.cfg.claudeAuthMode");
    expect(panel).toContain("ai.cfg.claudeMain");
    expect(panel).toContain("ai.cfg.sendAttribution");
  });

  it("CLI 列表整行负责切换，拖拽只挂在手柄上", () => {
    const panel = renderToStaticMarkup(createElement(AiCliSettingsPanel));
    const rows = panel.match(/<div role="button" tabindex="0"[^>]*>/g) ?? [];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).not.toContain("draggable");
    expect(panel).toContain('<span class="ai-cli-grip" draggable="true"');
  });

  it("关闭时只显示通用页的未选中开关，不渲染安装管理或检测按钮", () => {    h.enabled = false;
    expect(renderToStaticMarkup(createElement(AiCliSettingsPanel))).toBe("");
    const html = renderToStaticMarkup(createElement(AiAssistantsToggle));
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(renderToStaticMarkup(createElement(AiCliSettingsControls))).toBe("");
  });

  it("开启时通用开关、AI 页检测按钮与工具管理卡片分别显示", () => {
    expect(renderToStaticMarkup(createElement(AiAssistantsToggle))).toContain('aria-checked="true"');
    expect(renderToStaticMarkup(createElement(AiCliSettingsControls))).toContain('aria-label="ai.check"');
    const panel = renderToStaticMarkup(createElement(AiCliSettingsPanel));
    expect(panel).toContain("ai-cli-page");
    expect(panel).toContain("ai-cli-list");
    expect(panel).toContain("ai-cli-detail");
  });

  it("开关点击保存相反的启用状态", () => {
    for (const enabled of [false, true]) {
      h.enabled = enabled;
      let click = () => {};
      function Harness() {
        const toggle = AiAssistantsToggle();
        click = toggle.props.children[0].props.onClick;
        return toggle;
      }
      renderToStaticMarkup(createElement(Harness));
      click();
      expect(h.patch).toHaveBeenLastCalledWith({ aiAssistantsEnabled: !enabled });
    }
  });
});

describe("版本查询来源提示", () => {
  it("镜像查询成功时显示来源提示和版本，不显示查询失败", () => {
    h.cli.statuses = { codex: { ...installed("codex"), latestVersion: "0.163.0", latestSource: "npmmirror", latestError: null } };
    const html = renderToStaticMarkup(createElement(AiCliSettingsPanel));
    expect(html).toContain("ai.mirrorVersionHint");
    expect(html).toContain("0.163.0");
    expect(html).not.toContain("ai.latestFailed");
  });

  it("官方查询成功时不显示镜像提示", () => {
    h.cli.statuses = { codex: { ...installed("codex"), latestVersion: "0.163.0", latestSource: "official", latestError: null } };
    const html = renderToStaticMarkup(createElement(AiCliSettingsPanel));
    expect(html).not.toContain("ai.mirrorVersionHint");
  });
});

describe("统一会话侧栏", () => {
  it("标题行是定位/批量展开/视图选项三颗按钮，列表区域不重复显示操作栏", () => {
    const html = render();
    const header = html.match(/<header>(.*?)<\/header>/)?.[1] ?? "";
    expect(header).toContain('aria-label="ai.sidebar.locate"');
    expect(header).toContain('aria-label="ai.sidebar.expandAll"');
    expect(header).toContain('aria-label="ai.sidebar.viewOptions"');
    const body = html.slice(html.indexOf("</header>") + 9);
    expect(body).not.toContain("ai-sessions-tools");
  });

  it("「新建会话」固定行始终可点：未安装时也不再禁用，安装引导移到草稿页", () => {
    const html = render();
    const button = html.match(/<button[^>]*class="ai-sidebar-nav"[^>]*>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain("disabled");
    expect(html).toContain("ai.newSession");
    expect(html).not.toContain("ai-session-create");
    expect(html).not.toContain("ai-session-group");
  });

  it("「最近」默认收起，点击分组后才展开内容", () => {
    let html = render();
    expect(html).toContain("ai.sidebar.sectionSessions");
    expect(html).toContain("ai.sidebar.noUnarchived");
    expect(html).toContain("ai.sidebar.sectionRecent");
    expect(html).toContain('aria-expanded="false"><span>ai.sidebar.sectionRecent</span>');
    expect(html).not.toContain("ai.sidebar.noRecent");

    toggleAiSidebarSection("recent");
    html = render();
    expect(html).toContain('aria-expanded="true"><span>ai.sidebar.sectionRecent</span>');
    expect(html).toContain("ai.sidebar.noRecent");
  });

  it("两种工具的会话在同一列表中，按创建时间倒序并保留品牌图标", () => {
    const html = render([
      { id: "c", provider: "claude", title: "Claude old", createdAt: 1 },
      { id: "x", provider: "codex", title: "Codex old", createdAt: 2 },
    ]);
    expect(html).toContain("ai-provider-icon is-claude");
    expect(html).toContain("ai-provider-icon is-codex");
    expect(html.indexOf("Codex old")).toBeLessThan(html.indexOf("Claude old"));
  });

  it("左侧会话列表只显示顶层会话，不显示子代理", () => {
    const html = render([
      { id: "parent", provider: "codex", title: "父会话", createdAt: 1 },
      // 子代理由独立的右侧栏提供入口，不能重复占用左侧会话列表。
      { id: "child", provider: "codex", title: "子代理任务", createdAt: 2, parentSessionId: "parent" },
    ]);
    expect(html).toContain("父会话");
    expect(html).not.toContain("子代理任务");
  });

  it("置顶的会话进「置顶」章节并排在最上面", () => {
    const html = render([
      { id: "p", provider: "claude", title: "钉住的", createdAt: 1, pinned: true, pinnedAt: 9 },
      { id: "n", provider: "codex", title: "普通的", createdAt: 2 },
    ]);
    expect(html.indexOf("ai.sidebar.sectionPinned")).toBeLessThan(html.indexOf("钉住的"));
    expect(html.indexOf("钉住的")).toBeLessThan(html.indexOf("普通的"));
    // 「会话」章节只列未置顶的。
    expect(html.match(/钉住的/g)).toHaveLength(2);
  });

  it("非桌面端不显示搜索入口，但新建与章节照常", () => {
    h.desktop = false;
    const html = render([{ id: "c", provider: "claude", title: "Claude old", createdAt: 1 }]);
    expect(html).not.toContain("ai-sidebar-search");
    expect(html).toContain("ai-sidebar-nav");
    expect(html).toContain("Claude old");
  });

  it("通用下拉框保留文本并渲染选中工具的图标", () => {
    const html = renderToStaticMarkup(createElement(Select, {
      value: "codex", options: [{ value: "codex", label: "Codex", icon: createElement(AiProviderIcon, { provider: "codex" }) }],
      onChange: vi.fn(), label: "tool", placeholder: "empty",
    }));
    expect(html).toContain("ai-provider-icon is-codex");
    expect(html).toContain('class="select-value">Codex');
    expect(html).toContain('aria-haspopup="listbox"');
  });

  it("会话卡片在运行中时图标带有 is-running 状态类，空闲时不带", () => {
    const runningCard = renderToStaticMarkup(createElement(AiSidebarCard, {
      session: { id: "test-run", provider: "claude", title: "Running Claude", createdAt: 1 },
      selected: false,
      openInTab: false,
      activity: "running",
      workspace: null,
      onOpen: vi.fn(),
      onMenu: vi.fn(),
      onPin: vi.fn(),
      onArchive: vi.fn(),
    }));
    // 运行态下供应商图标容器应带有 is-running 类名以触发呼吸闪动动画
    expect(runningCard).toContain('class="ai-scard-icon is-running"');

    const idleCard = renderToStaticMarkup(createElement(AiSidebarCard, {
      session: { id: "test-idle", provider: "codex", title: "Idle Codex", createdAt: 2 },
      selected: false,
      openInTab: false,
      activity: "idle",
      workspace: null,
      onOpen: vi.fn(),
      onMenu: vi.fn(),
      onPin: vi.fn(),
      onArchive: vi.fn(),
    }));
    // 空闲态下供应商图标容器不带有 is-running 类名
    expect(idleCard).toContain('class="ai-scard-icon"');
    expect(idleCard).not.toContain("is-running");
  });

  it("Tab 标签上的供应商图标自订阅运行状态：running 时带 is-running，否则不带", async () => {
    const aiRuntime = await import("../../src/lib/aiRuntime");
    const spy = vi.spyOn(aiRuntime, "useAiSessionActivity").mockReturnValue("idle");

    const idleMarkup = renderToStaticMarkup(createElement(AiTabProviderIcon, {
      sessionId: "tab-test",
      provider: "claude",
    }));
    expect(idleMarkup).toContain('class="ai-tab-provider-icon"');
    expect(idleMarkup).not.toContain("is-running");

    spy.mockReturnValue("running");
    const runningMarkup = renderToStaticMarkup(createElement(AiTabProviderIcon, {
      sessionId: "tab-test",
      provider: "codex",
    }));
    expect(runningMarkup).toContain('class="ai-tab-provider-icon is-running"');
    expect(runningMarkup).toContain('ai-provider-icon is-codex');

    spy.mockRestore();
  });
});
