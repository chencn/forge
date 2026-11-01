// @vitest-environment jsdom
/**
 * 状态栏的语言服务提醒（对标 IDE 的 notifyMissing）：当前文件路由到 missing 且服务
 * 有安装命令时，右下角弹一条 `lsp` 组警告气泡，带「安装」动作；同一「根 + 服务」只提醒
 * 一次。服务名摘要文本也在这一层锁住（对标 IDE 的 serversSummary）。
 */
import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  route: {
    language: "yaml",
    serverId: "yaml-language-server",
    root: "D:/proj",
    status: "missing" as const,
  },
  notify: vi.fn(() => "notification-id"),
  sessions: { byServer: {} as Record<string, unknown[]>, stale: false, refresh: () => {} },
  busy: new Set<string>(),
  probes: null as Record<string, { id: string; program: string; installed: boolean; path: string }> | null,
}));

vi.mock("../../src/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

vi.mock("../../src/hooks/useLspConfig", () => ({
  useLspConfig: () => ({
    config: {
      version: 1,
      maxSessions: 5,
      idleTimeoutMin: 30,
      servers: {
        "rust-analyzer": {
          mode: "lsp",
          program: "rust-analyzer",
          path: "",
          args: "",
          languages: ["rust"],
          rootMarkers: [],
          installCommand: "",
          startupTimeoutMs: 30000,
          initOptions: null,
          supportsBuiltin: false,
        },
        gopls: {
          mode: "lsp",
          program: "gopls",
          path: "",
          args: "",
          languages: ["go"],
          rootMarkers: [],
          installCommand: "",
          startupTimeoutMs: 30000,
          initOptions: null,
          supportsBuiltin: false,
        },
        "yaml-language-server": {
          mode: "lsp",
          program: "yaml-language-server",
          path: "",
          args: "--stdio",
          languages: ["yaml"],
          rootMarkers: [],
          installCommand: "npm install -g yaml-language-server",
          startupTimeoutMs: 30000,
          initOptions: null,
          supportsBuiltin: false,
        },
      },
    },
    patchServer: vi.fn(),
    probes: h.probes,
    reprobe: vi.fn(async () => null),
    probeError: null,
  }),
  useLspSessionStatuses: () => h.sessions,
}));

vi.mock("../../src/lib/lspManager", () => ({
  lspManager: {
    route: () => h.route,
    busySessionIds: () => h.busy,
    subscribeBusy: () => () => {},
  },
}));

vi.mock("../../src/lib/lsp", () => ({
  lspRetry: vi.fn(),
  lspInstall: vi.fn(),
}));

import { notificationCenter } from "../../src/lib/notifications";

let container: HTMLElement;
let root: Root;

type StatusProps = {
  workspace: string | null;
  activeDocument: { path: string; language: string } | null;
  onKicked: () => void;
  onError: (text: string) => void;
};

async function mount(
  running: Array<{ server: string; status: "running" | "dead"; error?: string | null }> = []
): Promise<ComponentType<StatusProps>> {
  h.sessions.byServer = Object.fromEntries(running.map((item) => [item.server, [{
    id: `${item.server}:1`,
    server: item.server,
    root: "D:/proj",
    window: "main",
    status: item.status,
    restartCount: 0,
    lastUsedMs: 0,
    error: item.error ?? null,
  }]]));
  return (await import("../../src/components/LspStatusBar")).default;
}

function mountEditor() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

function render(Component: ComponentType<StatusProps>) {
  return act(async () => {
    root.render(
      createElement(Component, {
        workspace: "D:/proj",
        activeDocument: { path: "D:/proj/deploy.yaml", language: "yaml" },
        onKicked: () => {},
        onError: () => {},
      })
    );
  });
}

beforeEach(() => {
  vi.spyOn(notificationCenter, "notify").mockImplementation(h.notify);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  h.probes = null;
  h.busy = new Set();
  vi.restoreAllMocks();
  h.notify.mockClear();
});

describe("LspStatusBar", () => {
  it("路由到 missing 时弹一次带安装动作的提醒；同一根与服务不重复弹", async () => {
    const Component = await mount();
    mountEditor();
    await render(Component);
    expect(h.notify).toHaveBeenCalledTimes(1);
    const first = (h.notify.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0] as {
      groupId: string;
      key: string;
      title: string;
      level: string;
      actions: Array<{ label: string; run: () => void }>;
    };
    expect(first.groupId).toBe("lsp");
    expect(first.key).toBe("lsp-missing-yaml-language-server");
    expect(first.title).toBe("lsp.missing.title");
    expect(first.level).toBe("warning");
    expect(first.actions[0]?.label).toBe("lsp.install");
    expect(typeof first.actions[0]?.run).toBe("function");

    await render(Component);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("状态栏按钮显示服务名摘要（对标 IDE serversSummary），弹层按服务名列出会话与 missing 行", async () => {
    const Component = await mount([{ server: "rust-analyzer", status: "running" }, { server: "gopls", status: "running" }]);
    mountEditor();
    await render(Component);
    const text = container.querySelector(".status-lsp-name")?.textContent ?? "";
    // 会话两行 + 当前文件路由到的 missing 一行：参照的摘要按服务名排序后收成「第一个 +N」。
    expect(text).toBe("gopls +2");
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".status-lsp-button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
    });
    const rows = [...document.querySelectorAll(".lsp-panel .lsp-server")];
    expect(rows).toHaveLength(3);
    // 参照按服务名排序；行内是「语言, 语言 · 相对根」，根与项目根相同时省略。
    expect(rows[0]?.querySelector(".lsp-name")?.textContent).toBe("gopls");
    expect(rows[0]?.querySelector(".lsp-meta")?.textContent).toContain("Go");
    expect(rows[0]?.querySelector('button[aria-label="lsp.bar.retry"]')).not.toBeNull();
    expect([...rows[0]?.querySelectorAll("button") ?? []]).toHaveLength(1);
    const missingRow = rows[2];
    expect(missingRow?.querySelector(".lsp-name")?.textContent).toBe("yaml-language-server");
    expect(missingRow?.textContent).toContain("lsp.probe.missing");
    expect([...missingRow?.querySelectorAll("button") ?? []].map((b) => b.textContent)).toContain("lsp.install");
    // 状态栏按钮是色点 + 文本，不是图标。
    expect(container.querySelector(".status-lsp-button .lsp-dot")).not.toBeNull();
    expect(container.querySelector(".status-lsp-button svg")).toBeNull();
  });

  it("服务在索引（有未结束的 $/progress）时那一行显示「索引中」，色点走忙碌档", async () => {
    h.busy = new Set(["rust-analyzer:1"]);
    const Component = await mount([{ server: "rust-analyzer", status: "running" }]);
    mountEditor();
    await render(Component);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".status-lsp-button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
    });
    const row = document.querySelector(".lsp-panel .lsp-server");
    expect(row?.querySelector(".lsp-name")?.textContent).toBe("rust-analyzer");
    expect(row?.textContent).toContain("lsp.status.busy");
    expect(row?.querySelector(".lsp-dot")?.className).toContain("is-busy");
  });

  it("死会话报 LSP_NOT_FOUND 码按未安装处理：行尾是安装按钮与安装命令（对标 IDE）", async () => {
    const Component = await mount([
      {
        server: "yaml-language-server",
        status: "dead",
        error: "LSP_NOT_FOUNDyaml-language-server",
      },
    ]);
    mountEditor();
    await render(Component);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".status-lsp-button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
    });
    const row = [...document.querySelectorAll(".lsp-panel .lsp-server")].find(
      (item) => item.querySelector(".lsp-name")?.textContent === "yaml-language-server"
    );
    expect(row).toBeDefined();
    expect(row?.textContent).toContain("lsp.probe.missing");
    const buttons = [...row?.querySelectorAll("button") ?? []];
    expect(buttons.map((button) => button.textContent)).toContain("lsp.install");
    expect(buttons).toHaveLength(1);
    // 提示语是对标 IDE 的那条安装命令，不是「起不来 N 次」的报错串。
    expect(row?.textContent).toContain("npm install -g yaml-language-server");
    expect(row?.textContent).not.toContain("lsp.state.dead");
  });

  it("探测确认已装后，死会话的旧 LSP_NOT_FOUND 码不再把它钉在未安装", async () => {
    h.probes = { "yaml-language-server": { id: "yaml-language-server", program: "yaml-language-server", installed: true, path: "C:/npm/yaml-language-server" } };
    const Component = await mount([
      {
        server: "yaml-language-server",
        status: "dead",
        error: "LSP_NOT_FOUNDyaml-language-server",
      },
    ]);
    mountEditor();
    await render(Component);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".status-lsp-button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
    });
    const row = [...document.querySelectorAll(".lsp-panel .lsp-server")].find(
      (item) => item.querySelector(".lsp-name")?.textContent === "yaml-language-server"
    );
    expect(row).toBeDefined();
    // 已装就不是 missing：没有安装按钮，行尾回到重启入口（清退避后马上能起）。
    expect([...row?.querySelectorAll("button") ?? []].map((button) => button.textContent)).not.toContain("lsp.install");
    expect(row?.querySelector('button[aria-label="lsp.bar.retry"]')).not.toBeNull();
    expect(row?.textContent).toContain("lsp.state.dead");
  });
});
