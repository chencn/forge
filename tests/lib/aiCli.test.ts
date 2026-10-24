import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiCliStatus } from "../../src/lib/aiCli";
const h = vi.hoisted(() => ({ invoke: vi.fn(), desktop: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke, isTauri: () => h.desktop }));
const status: AiCliStatus = {
  provider: "claude", installed: false, version: null, path: null, source: null,
  latestVersion: "2.1.0", latestSource: "official", updateAvailable: false, canInstall: true, canUpdate: false,
  canUninstall: false, prerequisiteError: null, probeError: null, latestError: null,
};

beforeEach(() => { vi.resetModules(); h.invoke.mockReset(); h.desktop = true; });
describe("已安装工具筛选", () => {
  it("未检测与未安装的工具不出现在选项中", async () => {
    const { installedAiProviders } = await import("../../src/lib/aiCli");
    expect(installedAiProviders({})).toEqual([]);
    expect(installedAiProviders({ claude: status })).toEqual([]);
    expect(installedAiProviders({ codex: { ...status, provider: "codex", installed: true } })).toEqual(["codex"]);
  });

  it("使用固定工具顺序，联网失败或只读安装不影响已安装选项", async () => {
    const { installedAiProviders } = await import("../../src/lib/aiCli");
    expect(installedAiProviders({
      codex: { ...status, provider: "codex", installed: true },
      claude: { ...status, installed: true, source: "external", canInstall: false, latestError: "offline" },
    })).toEqual(["claude", "codex"]);
  });

  it("卸载后的状态立即移除对应选项", async () => {
    const { installedAiProviders } = await import("../../src/lib/aiCli");
    expect(installedAiProviders({
      claude: status,
      codex: { ...status, provider: "codex", installed: true },
    })).toEqual(["codex"]);
  });
});

describe("环境变量草稿补丁", () => {
  it("只改指定键，保留注释、空行和其他键的顺序", async () => {
    const { patchAiCliEnvText } = await import("../../src/lib/aiCli");
    const before = "# gateway\nANTHROPIC_BASE_URL=https://old.example.com\n\nANTHROPIC_MODEL=claude-old\nCUSTOM=keep";
    expect(patchAiCliEnvText(before, { ANTHROPIC_MODEL: "claude-new" })).toBe(
      "# gateway\nANTHROPIC_BASE_URL=https://old.example.com\n\nANTHROPIC_MODEL=claude-new\nCUSTOM=keep",
    );
  });

  it("空值删除键，重复行一并清理", async () => {
    const { patchAiCliEnvText } = await import("../../src/lib/aiCli");
    expect(patchAiCliEnvText("A=1\nB=2\nA=3", { A: "" })).toBe("B=2");
  });

  it("新键追加在末尾非空行之后，保留尾部空行", async () => {
    const { patchAiCliEnvText } = await import("../../src/lib/aiCli");
    expect(patchAiCliEnvText("A=1\n\n", { B: "2" })).toBe("A=1\nB=2\n\n");
  });

  it("按候选顺序读取变量，缺失时返回空串", async () => {
    const { aiCliEnvValue } = await import("../../src/lib/aiCli");
    const text = "ANTHROPIC_API_KEY=sk-second";
    expect(aiCliEnvValue(text, "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY")).toBe("sk-second");
    expect(aiCliEnvValue(text, "OPENAI_API_KEY")).toBe("");
  });
});

describe("设置页枚举译文", () => {
  it("Codex 审批策略与沙箱模式的每个取值都有三种语言的译文", async () => {
    const [{ CODEX_APPROVAL_POLICIES, CODEX_SANDBOX_MODES }, { zh }, { en }, { zhTW }] = await Promise.all([
      import("../../src/lib/aiCli"),
      import("../../src/i18n/lang/zh"),
      import("../../src/i18n/lang/en"),
      import("../../src/i18n/lang/zh-TW"),
    ]);
    // 这些键在面板里是拼出来的，TypeScript 查不到；漏一条就会直接显示键名。
    const keys = [
      ...CODEX_APPROVAL_POLICIES.filter(Boolean).map((value) => `ai.cfg.approval.${value}`),
      ...CODEX_SANDBOX_MODES.filter(Boolean).map((value) => `ai.cfg.sandbox.${value}`),
    ];
    for (const dict of [zh, en, zhTW]) {
      for (const key of keys) expect(dict[key as keyof typeof zh], key).toBeTruthy();
    }
  });
});

describe("认证方式回填", () => {  it("本地有端点或密钥时默认自定义，否则官方", async () => {
    const { claudeAuthModeOf } = await import("../../src/lib/aiCli");
    expect(claudeAuthModeOf({})).toBe("official");
    expect(claudeAuthModeOf({ ANTHROPIC_BASE_URL: "  " })).toBe("official");
    expect(claudeAuthModeOf({ ANTHROPIC_BASE_URL: "https://gw.example.com" })).toBe("custom");
    expect(claudeAuthModeOf({ ANTHROPIC_API_KEY: "sk-local" })).toBe("custom");
  });

  it("Codex 只有存在密钥时才是 API Key 模式", async () => {
    const { codexAuthModeOf } = await import("../../src/lib/aiCli");
    expect(codexAuthModeOf({ apiKey: "" })).toBe("subscription");
    expect(codexAuthModeOf({ apiKey: "sk-local" })).toBe("api_key");
  });

  it("Claude 配置保存走原生 settings.json 命令", async () => {
    h.invoke.mockResolvedValue({ path: "/home/me/.claude/settings.json", exists: true, error: null, env: {} });
    const api = await import("../../src/lib/aiCli");
    await api.saveAiCliClaudeSettings({ ANTHROPIC_BASE_URL: "https://gw.example.com", ANTHROPIC_AUTH_TOKEN: "" });
    expect(h.invoke).toHaveBeenCalledWith("ai_cli_claude_settings_save", {
      env: { ANTHROPIC_BASE_URL: "https://gw.example.com", ANTHROPIC_AUTH_TOKEN: "" },
    });
  });
});

describe("CLI 管理边界", () => {
  it("重复进入与刷新复用本次启动的安装检测", async () => {
    h.invoke.mockResolvedValue([status]);
    const api = await import("../../src/lib/aiCli");
    await api.refreshAiCli();
    await api.refreshAiCli();
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  it("更新查询挂起时仍允许使用本机管理状态", async () => {
    let finish!: (value: unknown) => void;
    h.invoke.mockImplementation((command: string) => command === "ai_cli_updates"
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve(command === "ai_cli_probe" ? [status] : { success: true, output: "ok", exitCode: 0 }));
    const api = await import("../../src/lib/aiCli");
    await api.refreshAiCli();
    const updating = api.refreshAiCliUpdates();
    await api.manageAiCli("claude", "install");
    expect(h.invoke).toHaveBeenCalledWith("ai_cli_manage", { provider: "claude", action: "install" });
    finish([]);
    await updating;
    // 旧更新响应不得覆盖管理后的状态。
    await api.manageAiCli("claude", "install");
    expect(h.invoke.mock.calls.filter(([name]) => name === "ai_cli_manage")).toHaveLength(2);
  });
  it("浏览器预览不调用本机命令", async () => {
    h.desktop = false;
    const api = await import("../../src/lib/aiCli");
    await api.refreshAiCli();
    await api.manageAiCli("claude", "install");
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("未经检测的操作不会执行", async () => {
    const api = await import("../../src/lib/aiCli");
    await api.manageAiCli("claude", "install");
    expect(h.invoke).not.toHaveBeenCalled();
    expect(api.canManageCli(undefined, "uninstall")).toBe(false);
  });

  it("只执行后端声明可用的操作，并在操作后刷新状态", async () => {
    h.invoke.mockImplementation(async (command: string) => command === "ai_cli_probe" ? [status] : { success: true, output: "ok", exitCode: 0 });
    const api = await import("../../src/lib/aiCli");
    await api.refreshAiCli();
    await api.manageAiCli("claude", "uninstall");
    expect(h.invoke).toHaveBeenCalledTimes(1);
    await api.manageAiCli("claude", "install");
    expect(h.invoke.mock.calls.map(([name]) => name)).toEqual(["ai_cli_probe", "ai_cli_manage", "ai_cli_probe"]);
    expect(h.invoke).toHaveBeenNthCalledWith(2, "ai_cli_manage", { provider: "claude", action: "install" });
  });

  it("更新查询失败不撤销本机安装管理权限", async () => {
    h.invoke.mockResolvedValueOnce([status]).mockRejectedValueOnce(new Error("probe failed"));
    const api = await import("../../src/lib/aiCli");
    await api.refreshAiCli();
    await api.refreshAiCliUpdates();
    await api.manageAiCli("claude", "install");
    expect(h.invoke).toHaveBeenCalledWith("ai_cli_manage", { provider: "claude", action: "install" });
  });

  it("操作失败仍刷新，互斥状态随后释放以便重试", async () => {
    h.invoke.mockImplementation(async (command: string) => {
      if (command === "ai_cli_manage") throw new Error("failed");
      return [status];
    });
    const api = await import("../../src/lib/aiCli");
    await api.refreshAiCli();
    await api.manageAiCli("claude", "install");
    await api.manageAiCli("claude", "install");
    expect(h.invoke.mock.calls.map(([name]) => name)).toEqual(["ai_cli_probe", "ai_cli_manage", "ai_cli_probe", "ai_cli_manage", "ai_cli_probe"]);
  });

  it("安装期间禁止重复操作及并发刷新", async () => {
    let complete: (value: unknown) => void = () => {};
    h.invoke.mockImplementation((command: string) => command === "ai_cli_probe" ? Promise.resolve([status]) : new Promise((resolve) => { complete = resolve; }));
    const api = await import("../../src/lib/aiCli");
    await api.refreshAiCli();
    const running = api.manageAiCli("claude", "install");
    await api.manageAiCli("claude", "install");
    await api.refreshAiCli();
    expect(h.invoke).toHaveBeenCalledTimes(2);
    complete({ success: true, output: "", exitCode: 0 });
    await running;
    expect(h.invoke).toHaveBeenCalledTimes(3);
  });
});
