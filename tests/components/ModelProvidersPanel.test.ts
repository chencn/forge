// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import ModelProvidersPanel from "../../src/components/ModelProvidersPanel";
import AiCliSettingsPanel from "../../src/components/AiCliSettingsPanel";
import AiComposerOptions from "../../src/components/AiComposerOptions";
import type { AiRunOptions } from "../../src/lib/aiRuntime";
import type { AiCliCodexSettings } from "../../src/lib/aiCli";
import { CLAUDE_MODEL_SLOTS, emptyCodexCatalogIntent, parseCodexCatalogIntent, type CodexCatalogView, type ModelProvider } from "../../src/lib/aiManage";

/** 固定的 CLI 状态与翻译函数，避免配置读取 effect 被不相关的引用变化打断。 */
const cliFixture = vi.hoisted(() => ({
  t: (key: string) => key,
  cli: { statuses: {}, checked: true, checking: false, operation: null, results: {}, error: null },
  settings: { version: 1, agents: {
    claude: { enabled: true, sortOrder: 0, env: {} },
    codex: { enabled: true, sortOrder: 1, env: {}, provider: "" },
  } },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("../../src/i18n", async (original) => ({
  ...await original<typeof import("../../src/i18n")>(),
  useI18n: () => ({ t: cliFixture.t }),
}));
vi.mock("../../src/hooks/useSettings", () => ({
  useSettings: () => ({ settings: { aiAssistantsEnabled: true } }),
}));
vi.mock("../../src/lib/aiCli", async (original) => ({
  ...await original<typeof import("../../src/lib/aiCli")>(),
  useAiCli: () => cliFixture.cli,
  useAiCliSettings: () => ({ settings: cliFixture.settings, loaded: true, loading: false, saving: false, error: null }),
  cliDesktopAvailable: () => true,
  refreshAiCliSettings: vi.fn(),
  refreshAiCliUpdates: vi.fn(),
  refreshAiCli: vi.fn(),
}));

/** 每项模型字段的可访问标签，与八个公共配置槽位对应。 */
const LABELS = ["providers.claudeMainModel", "providers.claudeReasoningModel", "providers.claudeAutoModeModel",
  "providers.claudeSubagentModel", "providers.claudeHaikuDefaultModel", "providers.claudeSonnetDefaultModel",
  "providers.claudeOpusDefaultModel", "providers.claudeFableDefaultModel"];
/** 当前测试的 React 挂载点。 */
let host: HTMLDivElement;
/** 当前测试的 React 根。 */
let root: Root;
/** 模拟磁盘保存的供应商配置。 */
let saved: ModelProvider[];
/** 模型接口的响应，可替换成延迟或失败的请求。 */
let fetchResponse: () => Promise<unknown>;
/** 模拟 Claude 原生 settings.json 的 env，保存时按原生协议合并。 */
let nativeEnv: Record<string, string>;
/** 本机 Codex 提供的参数模板，与供应商端点候选刻意不同。 */
let codexView: CodexCatalogView;
/** Codex 原生认证及结构化配置，供 Agent 目录请求和保存验证。 */
let nativeCodex: AiCliCodexSettings;
/** Claude CLI 实际读取的八个模型环境变量，与表单顺序对应。 */
const MODEL_ENV_KEYS = ["ANTHROPIC_MODEL", "ANTHROPIC_REASONING_MODEL", "CLAUDE_CODE_AUTO_MODE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL"];

/**
 * 构造后端 HTTP 命令的成功响应。
 * @param ids - 端点返回的模型 ID
 * @returns 与 http_send 相同的响应封装
 */
function response(ids: string[]) {
  return { entry: { error: null }, response: { status: 200, statusText: "OK", body: JSON.stringify({ data: ids.map((id) => ({ id })) }) } };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    /** 开始观察测试元素；jsdom 没有布局变化。 */
    observe() {}
    /** 停止观察测试元素。 */
    unobserve() {}
    /** 断开测试观察器。 */
    disconnect() {}
  });
  saved = [{ id: "claude-test", name: "Gateway", kind: "claude", apiUrl: "https://gateway.test/v1",
    apiKey: "saved-secret", model: "manual-main", models: { opus: "manual-opus[1m]" } }];
  fetchResponse = async () => response(["endpoint-a", "endpoint-b"]);
  nativeEnv = { ANTHROPIC_BASE_URL: "https://native.test/v1", ANTHROPIC_AUTH_TOKEN: "native-secret",
    ANTHROPIC_MODEL: "native-main[1m]", ANTHROPIC_SMALL_FAST_MODEL: "stale-fast", ANTHROPIC_DEFAULT_MODEL: "stale-default",
    UNMANAGED_FLAG: "keep" };
  codexView = { path: "C:/fixture/catalog.json", active: false, error: null, intent: emptyCodexCatalogIntent(),
    models: [{ slug: "builtin-only", visibility: "list" }, { slug: "endpoint-a", visibility: "list" }, { slug: "internal", visibility: "hide" }],
    hidden: [], domains: {}, flags: [], flagsVerified: true };
  cliFixture.settings.agents.codex.provider = "";
  nativeCodex = {
    model: "endpoint-a", modelProvider: "gateway", apiBaseUrl: "https://native-codex.test/v1", apiKey: "codex-secret", authError: null,
    approvalPolicy: "", sandboxMode: "", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    granular: { sandboxApproval: false, rules: false, skillApproval: false, requestPermissions: false, mcpElicitations: false },
    defaultModeRequestUserInput: false, modelReasoningEffort: "", modelReasoningSummary: "", modelVerbosity: "", modelContextWindow: null,
    modelAutoCompactTokenLimit: null, webSearch: "", historyPersistence: "", historyMaxBytes: null, shellEnvInherit: "", windowsSandbox: "",
    supportsWebsockets: false, providerDefined: true, shadowed: false, permissionsDefined: false,
  };
  vi.mocked(invoke).mockReset().mockImplementation(async (command, args) => {
    if (command === "ai_providers_load") return structuredClone(saved);
    if (command === "http_send") return fetchResponse();
    if (command === "ai_providers_save") {
      saved = structuredClone((args as { providers: ModelProvider[] }).providers.map((provider) => ({
        ...provider, apiKey: provider.apiKey || saved.find((item) => item.id === provider.id)?.apiKey || "",
      })));
      return saved;
    }
    if (command === "ai_providers_apply") return;
    if (command === "ai_cli_codex_catalog_read") return structuredClone(codexView);
    if (command === "ai_cli_codex_settings_read") return structuredClone(nativeCodex);
    if (command === "ai_cli_codex_catalog_save") {
      codexView.intent = structuredClone((args as { intent: CodexCatalogView["intent"] }).intent);
      return structuredClone(codexView);
    }
    if (command === "ai_cli_claude_settings_save") {
      for (const [key, value] of Object.entries((args as { env: Record<string, string> }).env)) {
        if (value) nativeEnv[key] = value;
        else delete nativeEnv[key];
      }
    }
    if (command === "ai_cli_claude_settings_read" || command === "ai_cli_claude_settings_save") {
      return { path: "C:/fixture/settings.json", exists: true, error: null, env: structuredClone(nativeEnv) };
    }
    if (command === "ai_cli_diagnostics" || command === "ai_runtime_custom_models") return [];
    if (command === "ai_cli_config_read") return { path: "C:/fixture/config", exists: true, error: null, content: "{}" };
    throw new Error(`Unexpected command: ${command}`);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/**
 * 挂载供应商编辑页并等待加载。
 * @returns 界面完成首次渲染
 */
async function render() {
  await act(async () => root.render(createElement(ModelProvidersPanel)));
}

/**
 * 从可访问标签找到模型输入框。
 * @param index - 八模型槽位的位置
 * @returns 对应的可编辑 combobox
 */
function modelInput(index: number): HTMLInputElement {
  /** 标签与输入的关联由组件提供，测试不依赖布局层级。 */
  const label = [...host.querySelectorAll("label")].find((item) => item.textContent === LABELS[index])!;
  return document.getElementById(label.htmlFor) as HTMLInputElement;
}

/**
 * 触发 DOM 点击并等待 React 更新。
 * @param element - 要操作的控件
 * @returns 点击产生的状态更新完成
 */
async function click(element: Element) {
  await act(async () => (element as HTMLElement).click());
}

/**
 * 查找命名按钮。
 * @param text - 按钮的完整文案
 * @returns 匹配的按钮
 */
function button(text: string): HTMLButtonElement {
  return [...host.querySelectorAll("button")].find((item) => item.textContent === text)!;
}

/**
 * 模拟手工输入，不绕过 React 的输入事件。
 * @param input - 模型或端点输入框
 * @param value - 输入的新值
 * @returns 编辑事件与受控状态更新完成
 */
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("供应商模型编辑行为", () => {
  it.each([
    { efforts: ["medium", "high"], expectedEffort: "high" },
    { efforts: ["medium"], expectedEffort: undefined },
  ])("Codex 切换供应商设置默认高强度与编辑权限，并从本地目录保留或回落模型（$efforts）", async ({ efforts, expectedEffort }) => {
    /** 保存的两个 Codex 来源以及不可跨引擎选择的 Claude 来源。 */
    const providers = [
      { id: "a", kind: "codex", name: "供应商 A" }, { id: "b", kind: "codex", name: "供应商 B" },
      { id: "c", kind: "claude", name: "Claude 来源" },
    ];
    /** 验证组件提交给当前会话的完整选项。 */
    const changed = vi.fn();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "ai_providers_load") return providers;
      if (command === "ai_runtime_models" || command === "ai_runtime_refresh_models") {
        /** 模型目录由 IPC 的供应商 ID 决定，空 ID 使用 Agent 配置。 */
        const source = (args as { providerId?: string }).providerId;
        return { models: [{ id: source === "b" ? "b-default" : "shared", name: source === "b" ? "B model" : "Shared model", isDefault: true, efforts }], efforts: [], customModel: true };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    /** 通过真实 React 状态接收会话选项，验证切换后默认回到模型 Tab。 */
    function Composer() {
      /** 当前会话已有的供应商与模型。 */
      const [options, setOptions] = useState<AiRunOptions>({ providerId: "a", model: "shared", effort: "high", permission: "read" });
      return createElement(AiComposerOptions, { provider: "codex", workspace: "D:/fixture", value: options,
        onChange: (next) => { changed(next); setOptions(next); } });
    }
    await act(async () => root.render(createElement(Composer)));
    await click(host.querySelector("button")!);
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("供应商 A");
    await click(document.querySelector('[role="tab"][data-tab="providers"]')!);
    expect(document.querySelector('[role="tabpanel"]')?.textContent).not.toContain("Claude 来源");
    await click([...document.querySelectorAll('[role="tabpanel"] button')].find((item) => item.textContent === "供应商 B")!);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ providerId: "b", model: "b-default", effort: expectedEffort, permission: "auto" }));
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("供应商 B");
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain("B model");
    await click(document.querySelector('[role="tab"][data-tab="providers"]')!);
    await click([...document.querySelectorAll('[role="tabpanel"] button')].find((item) => item.textContent === "ai.chat.agentConfig")!);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ providerId: undefined, model: "shared", effort: expectedEffort, permission: "auto" }));
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "ai_providers_apply" || command === "http_send")).toBe(false);
  });

  it("Claude 切换供应商默认使用高强度与自动权限，并清除旧计划模式", async () => {
    /** 切换必须一次提交模型、强度与权限，避免残留旧会话的只读限制。 */
    const changed = vi.fn();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "ai_providers_load") return [{ id: "a", kind: "claude", name: "A" }, { id: "b", kind: "claude", name: "B" }];
      if (command === "ai_runtime_models") return {
        models: [{ id: "sonnet", name: "Sonnet", isDefault: true, efforts: [] }],
        efforts: ["low", "medium", "high"], modes: ["manual", "plan", "auto"], modesAuthoritative: true,
      };
      throw new Error(`Unexpected command: ${command}`);
    });
    /** 真实会话状态用于验证提交后公开控件显示的选中档位。 */
    function Composer() {
      /** 从旧计划模式和只读权限切换，确保新默认同时生效。 */
      const [options, setOptions] = useState<AiRunOptions>({ providerId: "a", model: "sonnet", effort: "high", mode: "plan", planMode: true, permission: "read" });
      return createElement(AiComposerOptions, { provider: "claude", workspace: "D:/fixture", value: options,
        onChange: (next) => { changed(next); setOptions(next); } });
    }
    await act(async () => root.render(createElement(Composer)));
    await click(host.querySelector("button")!);
    await click(document.querySelector('[role="tab"][data-tab="providers"]')!);
    await click([...document.querySelectorAll('[role="tabpanel"] button')].find((item) => item.textContent === "B")!);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ providerId: "b", model: "sonnet", effort: "high", mode: "auto", permission: "auto", planMode: undefined }));
    expect([...document.querySelectorAll('[role="group"] button[aria-pressed="true"]')].map((item) => item.textContent)).toEqual(["ai.chat.effort.high", "ai.chat.modeAuto"]);
  });

  it("切换供应商时禁止并发改档位，读取失败保留原会话选择", async () => {
    /** 可控失败用于模拟本地目录读取尚未完成。 */
    let rejectSwitch!: (error: Error) => void;
    /** 保留失败前的在途请求，以验证禁用与失败状态。 */
    const pending = new Promise((_, reject) => { rejectSwitch = reject; });
    /** 失败不得发布任何新的会话选项。 */
    const changed = vi.fn();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "ai_providers_load") return [{ id: "a", kind: "codex", name: "A" }, { id: "b", kind: "codex", name: "B" }];
      if (command === "ai_runtime_models") {
        if ((args as { providerId?: string }).providerId === "b") return pending;
        return { models: [{ id: "a-model", name: "A model", efforts: ["high"], isDefault: true }], efforts: [], customModel: true };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    await act(async () => root.render(createElement(AiComposerOptions, { provider: "codex", workspace: "D:/fixture", value: { providerId: "a", model: "a-model" }, onChange: changed })));
    await click(host.querySelector("button")!);
    await click(document.querySelector('[role="tab"][data-tab="providers"]')!);
    await click([...document.querySelectorAll('[role="tabpanel"] button')].find((item) => item.textContent === "B")!);
    expect((document.querySelector('[role="tab"][data-tab="models"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[role="tabpanel"]')?.getAttribute("aria-busy")).toBe("true");
    await act(async () => rejectSwitch(new Error("目录不可用")));
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("目录不可用");
    expect((document.querySelector('[role="tab"][data-tab="models"]') as HTMLButtonElement).disabled).toBe(false);
  });
  it("八项响应完整进入下拉，带前缀和不带前缀的 DeepSeek ID 可分别选择和保存", async () => {
    /** 两个 DeepSeek ID 是不同模型，不能按名称尾部去重或过滤。 */
    const ids = ["auto/deepseek-v4.1-flash", "deepseek-v4.1-flash", "gemini-3.8-flash-high",
      "gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"];
    saved[0].model = "gemini-3.8-flash-high";
    fetchResponse = async () => response(ids);
    await render();
    for (let index = 0; index < 2; index += 1) {
      await click(host.querySelector(`button[aria-label="${LABELS[index]}"]`)!);
      /** 通过公开的选项角色检查完整候选，而不是组件内部状态。 */
      const options = [...document.querySelectorAll('[role="option"]')];
      expect(options.map((item) => item.textContent).sort()).toEqual([...ids].sort());
      await click(options.find((item) => item.textContent === ids[index])!);
      expect(modelInput(index).value).toBe(ids[index]);
    }
    await click(button("providers.save"));
    expect(saved[0].model).toBe(ids[0]);
    expect(saved[0].models.reasoning).toBe(ids[1]);
  });

  it("八个槽位共用 /v1/models 候选，留空密钥沿用保存值，选择写入对应槽位", async () => {
    await render();
    for (let index = 0; index < LABELS.length; index += 1) {
      await click(host.querySelector(`button[aria-label="${LABELS[index]}"]`)!);
      await click([...document.querySelectorAll('[role="option"]')].find((item) => item.textContent === "endpoint-b")!);
      expect(modelInput(index).value).toBe(index === 6 ? "endpoint-b[1m]" : "endpoint-b");
    }
    /** 发起的 HTTP 命令体现实际地址和鉴权边界。 */
    const requests = vi.mocked(invoke).mock.calls.filter(([command]) => command === "http_send");
    expect(requests).toHaveLength(1);
    expect(requests[0][1]).toMatchObject({ call: { method: "GET", url: "https://gateway.test/v1/models",
      headers: [["x-api-key", "saved-secret"], ["anthropic-version", "2023-06-01"]] } });
    await click(button("providers.save"));
    expect(saved[0].model).toBe("endpoint-b");
    for (const slot of CLAUDE_MODEL_SLOTS.filter((item) => item !== "main")) {
      expect(saved[0].models[slot]).toBe(slot === "opus" ? "endpoint-b[1m]" : "endpoint-b");
    }
  });

  it("手填模型可保存，1M 可恢复、切换、取消，空值不会保存孤立后缀", async () => {
    await render();
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${LABELS[6]} 1M"]`)!.checked).toBe(true);
    expect(modelInput(6).value).toBe("manual-opus[1m]");
    await click(host.querySelector(`input[aria-label="${LABELS[6]} 1M"]`)!);
    expect(modelInput(6).value).toBe("manual-opus");
    await type(modelInput(0), "custom-main");
    await click(host.querySelector(`input[aria-label="${LABELS[0]} 1M"]`)!);
    expect(modelInput(0).value).toBe("custom-main[1m]");
    await type(modelInput(0), "custom-next[1m]");
    await type(modelInput(1), "custom-reasoning[1M]");
    await type(modelInput(4), "custom-haiku");
    await click(host.querySelector(`input[aria-label="${LABELS[4]} 1M"]`)!);
    await type(modelInput(4), "");
    await type(modelInput(5), "custom-sonnet");
    await type(modelInput(7), "custom-fable");
    await click(button("providers.save"));
    expect(saved[0].model).toBe("custom-next[1m]");
    expect(saved[0].models).toMatchObject({ reasoning: "custom-reasoning[1m]", haiku: "", sonnet: "custom-sonnet",
      opus: "manual-opus", fable: "custom-fable" });
    expect(modelInput(0).value).toBe("custom-next[1m]");
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${LABELS[0]} 1M"]`)!.checked).toBe(true);
    await type(modelInput(0), "custom-next");
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${LABELS[0]} 1M"]`)!.checked).toBe(false);
    await click(button("providers.save"));
    expect(saved[0].model).toBe("custom-next");
  });

  it("八个字段通过模型后缀双向同步 1M，保存并重新挂载后仍能识别", { timeout: 30000 }, async () => {
    await render();
    for (let index = 0; index < LABELS.length; index += 1) {
      await type(modelInput(index), `model-${index}`);
      await click(host.querySelector(`input[aria-label="${LABELS[index]} 1M"]`)!);
      expect(modelInput(index).value).toBe(`model-${index}[1m]`);
    }
    await click(button("providers.save"));
    expect(saved[0].model).toBe("model-0[1m]");
    for (const [index, slot] of CLAUDE_MODEL_SLOTS.entries()) {
      if (slot !== "main") expect(saved[0].models[slot]).toBe(`model-${index}[1m]`);
    }
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    for (let index = 0; index < LABELS.length; index += 1) {
      expect(modelInput(index).value).toBe(`model-${index}[1m]`);
      expect(host.querySelector<HTMLInputElement>(`input[aria-label="${LABELS[index]} 1M"]`)!.checked).toBe(true);
      await click(host.querySelector(`input[aria-label="${LABELS[index]} 1M"]`)!);
      expect(modelInput(index).value).toBe(`model-${index}`);
      await type(modelInput(index), `model-${index}[1m]`);
      expect(host.querySelector<HTMLInputElement>(`input[aria-label="${LABELS[index]} 1M"]`)!.checked).toBe(true);
      await type(modelInput(index), `model-${index}`);
      expect(host.querySelector<HTMLInputElement>(`input[aria-label="${LABELS[index]} 1M"]`)!.checked).toBe(false);
    }
    await click(button("providers.save"));
    expect(saved[0].model).toBe("model-0");
    for (const [index, slot] of CLAUDE_MODEL_SLOTS.entries()) {
      if (slot !== "main") expect(saved[0].models[slot]).toBe(`model-${index}`);
    }
  });

  it("下拉获取失败后仍能手填和保存，重新打开下拉自动重试", async () => {
    fetchResponse = async () => { throw new Error("HTTP 401 Unauthorized"); };
    await render();
    await click(host.querySelector(`button[aria-label="${LABELS[0]}"]`)!);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("providers.fetchModelsFailed");
    await type(modelInput(0), "fallback-model");
    await act(async () => modelInput(0).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await click(button("providers.save"));
    expect(saved[0].model).toBe("fallback-model");
    fetchResponse = async () => response(["recovered"]);
    await click(host.querySelector(`button[aria-label="${LABELS[0]}"]`)!);
    expect([...document.querySelectorAll('[role="option"]')].map((item) => item.textContent)).toEqual(["recovered"]);
  });

  it("更换端点后丢弃旧请求的结果", async () => {
    /** 旧端点请求在新端点返回之后才完成。 */
    let finishOld!: (result: unknown) => void;
    fetchResponse = () => new Promise((resolve) => { finishOld = resolve; });
    await render();
    await click(host.querySelector(`button[aria-label="${LABELS[0]}"]`)!);
    await act(async () => modelInput(0).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await type(host.querySelector<HTMLInputElement>('input[placeholder="providers.apiUrlPlaceholder"]')!, "https://new.test");
    fetchResponse = async () => response(["new-endpoint-model"]);
    await click(host.querySelector(`button[aria-label="${LABELS[0]}"]`)!);
    await act(async () => finishOld(response(["old-endpoint-model"])));
    expect([...document.querySelectorAll('[role="option"]')].map((item) => item.textContent)).toEqual(["new-endpoint-model"]);
  });
});

describe("Agent 的 Claude 原生模型配置", () => {
  it.each(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"])("使用 %s 获取候选并保存八个模型后缀", async (keyName) => {
    delete nativeEnv.ANTHROPIC_AUTH_TOKEN;
    nativeEnv[keyName] = "native-secret";
    await act(async () => root.render(createElement(AiCliSettingsPanel)));
    expect(modelInput(0).value).toBe("native-main[1m]");
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${LABELS[0]} 1M"]`)!.checked).toBe(true);
    await click(host.querySelector(`button[aria-label="${LABELS[0]}"]`)!);
    await click([...document.querySelectorAll('[role="option"]')].find((item) => item.textContent === "endpoint-b")!);
    expect(modelInput(0).value).toBe("endpoint-b[1m]");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("http_send", expect.objectContaining({
      call: expect.objectContaining({ url: "https://native.test/v1/models",
        headers: [["x-api-key", "native-secret"], ["anthropic-version", "2023-06-01"]] }),
    }));
    for (let index = 1; index < LABELS.length; index += 1) {
      await type(modelInput(index), `native-${index}`);
      await click(host.querySelector(`input[aria-label="${LABELS[index]} 1M"]`)!);
    }
    await click(button("ai.cfg.save"));
    expect(nativeEnv[keyName]).toBe("native-secret");
    expect(nativeEnv.UNMANAGED_FLAG).toBe("keep");
    // 弃用与同义的模型键随保存一起清除，旧供应商的模型名不会继续生效。
    expect(nativeEnv.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
    expect(nativeEnv.ANTHROPIC_DEFAULT_MODEL).toBeUndefined();
    for (const [index, key] of MODEL_ENV_KEYS.entries()) {
      expect(nativeEnv[key]).toBe(index === 0 ? "endpoint-b[1m]" : `native-${index}[1m]`);
    }
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(AiCliSettingsPanel)));
    for (let index = 0; index < LABELS.length; index += 1) {
      expect(modelInput(index).value).toBe(nativeEnv[MODEL_ENV_KEYS[index]]);
      expect(host.querySelector<HTMLInputElement>(`input[aria-label="${LABELS[index]} 1M"]`)!.checked).toBe(true);
    }
  });
});

/**
 * 打开 Agent 设置中的 Codex 详情并等待原生配置加载。
 * @returns Codex 目录及其端点请求完成首次状态更新
 */
async function renderCodexAgent() {
  await act(async () => root.render(createElement(AiCliSettingsPanel)));
  await click([...host.querySelectorAll('[role="button"]')].find((item) => item.textContent?.includes("Codex"))!);
}

describe("Codex 手动刷新", () => {
  it.each(["agent", "provider"])("%s 进入、修改端点密钥及重新打开都不自动获取或改写模型", async (page) => {
    /** 已保存清单包含一个官方模型和一个手填模型。 */
    const intent = { ...emptyCodexCatalogIntent(), excluded: ["builtin-only"], default: "endpoint-a",
      customs: [{ slug: "manual-old", displayName: "Manual", description: "", base: "endpoint-a", overrides: { flags: {} } }] };
    codexView.intent = structuredClone(intent);
    saved[0] = { ...saved[0], kind: "codex", model: JSON.stringify(intent), models: {} };
    if (page === "agent") await renderCodexAgent();
    else await render();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "http_send")).toEqual([]);
    await type(host.querySelector<HTMLInputElement>(page === "agent"
      ? 'input[placeholder="https://api.openai.com/v1"]' : 'input[placeholder="providers.apiUrlPlaceholder"]')!, "https://edited.test/v1");
    await type(host.querySelector<HTMLInputElement>('input[type="password"]')!, "edited-secret");
    await click(button(page === "agent" ? "ai.catalog.save" : "providers.save"));
    expect(page === "agent" ? codexView.intent : parseCodexCatalogIntent(saved[0].model)).toEqual(intent);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "http_send")).toEqual([]);
    await act(async () => root.unmount());
    root = createRoot(host);
    if (page === "agent") await renderCodexAgent();
    else await render();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "http_send")).toEqual([]);
  });
});

describe("Agent 的 Codex 远程模型目录", () => {
  it("手动获取原生端点，刷新保留旧条目和参数，重置只保存远程清单", async () => {
    codexView.intent = { ...emptyCodexCatalogIntent(), default: "manual-old",
      customs: [{ slug: "manual-old", displayName: "Manual", description: "", base: "endpoint-a", overrides: { flags: {} } }],
      overrides: { "endpoint-a": { contextWindow: 123456, flags: {} } } };
    await renderCodexAgent();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "http_send")).toEqual([]);
    await click(button("tool.refresh"));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("http_send", expect.objectContaining({ call: expect.objectContaining({
      url: "https://native-codex.test/v1/models", headers: [["Authorization", "Bearer codex-secret"]],
    }) }));
    fetchResponse = async () => response(["builtin-only", "endpoint-c"]);
    await click(button("tool.refresh"));
    await click(button("tool.refresh"));
    await click(button("ai.catalog.save"));
    expect(codexView.intent.excluded).toEqual([]);
    expect(codexView.intent.customs.map((item) => item.slug)).toEqual(["manual-old", "endpoint-b", "endpoint-c"]);
    expect(codexView.intent.overrides["endpoint-a"].contextWindow).toBe(123456);
    expect(codexView.intent.default).toBe("manual-old");
    expect(host.querySelector<HTMLInputElement>('input[placeholder="gpt-5-codex"]')!.value).toBe("manual-old");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("ai.catalog.saved");
    fetchResponse = async () => response(["endpoint-a", "reset-new"]);
    await click(button("providers.resetModels"));
    await click(button("ai.catalog.save"));
    expect(codexView.intent.excluded).toEqual(["builtin-only"]);
    expect(codexView.intent.customs.map((item) => item.slug)).toEqual(["reset-new"]);
    expect(codexView.intent.overrides).toEqual({});
    expect(codexView.intent.default).toBe("endpoint-a");
    expect(host.querySelector<HTMLInputElement>('input[placeholder="gpt-5-codex"]')!.value).toBe("endpoint-a");
  });

  it("重置失败保留手填草稿，重试刷新不会继续执行重置", async () => {
    await renderCodexAgent();
    await click(button("tool.refresh"));
    await click(button("ai.catalog.addCompat"));
    await type(host.querySelector<HTMLInputElement>('input[placeholder="my-gateway/claude-opus"]')!, "manual-keep");
    fetchResponse = async () => { throw new Error("HTTP 503"); };
    await click(button("providers.resetModels"));
    expect(host.querySelector('[role="status"]')?.textContent).toBe("providers.fetchModelsFailed");
    await click(button("ai.catalog.save"));
    expect(codexView.intent.customs.map((item) => item.slug)).toEqual(["endpoint-b", "manual-keep"]);
    fetchResponse = async () => response(["recovered"]);
    await click(button("tool.refresh"));
    await click(button("ai.catalog.save"));
    expect(codexView.intent.customs.map((item) => item.slug)).toEqual(["endpoint-b", "manual-keep", "recovered"]);
  });

  it("切换端点时忽略未完成的重置，并在请求期间禁用目录保存", async () => {
    await renderCodexAgent();
    await click(button("tool.refresh"));
    /** 保存按钮请求期间会变更文案，但保持禁用。 */
    const saveButton = button("ai.catalog.save");
    /** 旧端点重置在新端点加载之后返回。 */
    let finishReset!: (value: unknown) => void;
    fetchResponse = () => new Promise((resolve) => { finishReset = resolve; });
    await click(button("providers.resetModels"));
    expect(saveButton.disabled).toBe(true);
    expect(button("tool.refresh").disabled).toBe(true);
    fetchResponse = async () => response(["new-endpoint"]);
    await type(host.querySelector<HTMLInputElement>('input[placeholder="https://api.openai.com/v1"]')!, "https://changed.test/v1");
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "http_send")).toHaveLength(2);
    await click(button("tool.refresh"));
    await act(async () => finishReset(response(["stale-reset"])));
    await click(button("ai.catalog.save"));
    expect(codexView.intent.customs.map((item) => item.slug)).toEqual(["endpoint-b", "new-endpoint"]);
  });

  it.each(["subscription", "provider"])("%s 模式不请求 API Key 端点或开放远程修改", async (mode) => {
    if (mode === "subscription") nativeCodex.apiKey = "";
    else cliFixture.settings.agents.codex.provider = "bound-provider";
    await renderCodexAgent();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "http_send")).toEqual([]);
    expect(button("tool.refresh")).toBeUndefined();
    expect(button("providers.resetModels")).toBeUndefined();
    expect(button("ai.catalog.save").disabled).toBe(mode === "provider");
  });
});

describe("Codex 供应商端点目录", () => {
  it("手动获取端点，保留手填条目并将端点目录保存后应用", async () => {
    saved = [{ id: "codex-test", name: "Codex Gateway", kind: "codex", apiUrl: "https://gateway.test/v1",
      apiKey: "saved-secret", models: {}, model: JSON.stringify({ ...emptyCodexCatalogIntent(),
        excluded: ["builtin-only"],
        customs: [{ slug: "manual-old", displayName: "Manual", description: "", base: "endpoint-a", overrides: { flags: {} } }] }) }];
    await render();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "http_send")).toEqual([]);
    await click(button("tool.refresh"));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("http_send", expect.objectContaining({ call: expect.objectContaining({
      url: "https://gateway.test/v1/models", headers: [["Authorization", "Bearer saved-secret"]],
    }) }));
    await click(button("ai.catalog.addCompat"));
    /** 手动新增的条目仍有可编辑的模型 ID。 */
    const inputs = [...host.querySelectorAll<HTMLInputElement>('input[placeholder="my-gateway/claude-opus"]')];
    await type(inputs[inputs.length - 1], "manual-new");
    await click(button("providers.apply"));
    /** 应用前的保存载荷代表 Codex 最终读取的目录意图。 */
    const intent = parseCodexCatalogIntent(saved[0].model);
    expect(intent.excluded).toEqual(["builtin-only"]);
    expect(intent.customs.map((item) => item.slug)).toEqual(["manual-old", "endpoint-b", "manual-new"]);
    expect(intent.default).toBe("endpoint-a");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("ai_providers_apply", { id: "codex-test" });
  });

  it("端点失败不导入官方模型，仍可手动添加并重试", async () => {
    saved[0] = { ...saved[0], kind: "codex", model: "", models: {} };
    fetchResponse = async () => { throw new Error("HTTP 503"); };
    await render();
    await click(button("tool.refresh"));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await click(button("ai.catalog.addCompat"));
    await type(host.querySelector<HTMLInputElement>('input[placeholder="my-gateway/claude-opus"]')!, "manual-recovery");
    fetchResponse = async () => response(["endpoint-b"]);
    await click(button("tool.refresh"));
    await click(button("providers.save"));
    expect(parseCodexCatalogIntent(saved[0].model).customs.map((item) => item.slug)).toEqual(["manual-recovery", "endpoint-b"]);
  });

  it("刷新增量添加且去重，保留旧官方模型、手填参数和默认模型", async () => {
    saved[0] = { ...saved[0], kind: "codex", models: {}, model: JSON.stringify({
      ...emptyCodexCatalogIntent(), default: "manual-old",
      overrides: { "endpoint-a": { contextWindow: 123456, flags: {} } },
      customs: [{ slug: "manual-old", displayName: "Manual", description: "", base: "endpoint-a", overrides: { contextWindow: 654321, flags: {} } }],
    }) };
    await render();
    await click(button("tool.refresh"));
    fetchResponse = async () => response(["builtin-only", "endpoint-c"]);
    await click(button("tool.refresh"));
    await click(button("tool.refresh"));
    await click(button("providers.save"));
    /** 保存载荷应包含合并结果，远程消失的旧模型不会被排除。 */
    const intent = parseCodexCatalogIntent(saved[0].model);
    expect(intent.excluded).toEqual([]);
    expect(intent.customs.map((item) => item.slug)).toEqual(["manual-old", "endpoint-b", "endpoint-c"]);
    expect(intent.customs[0].overrides.contextWindow).toBe(654321);
    expect(intent.overrides["endpoint-a"].contextWindow).toBe(123456);
    expect(intent.default).toBe("manual-old");
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "http_send")).toHaveLength(3);
  });

  it.each([["builtin-only", "reset-new"], []])("重置只保存本次远程清单 %j 并清除旧参数", async (...ids) => {
    saved[0] = { ...saved[0], kind: "codex", models: {}, model: JSON.stringify({
      ...emptyCodexCatalogIntent(), default: "manual-old",
      overrides: { "endpoint-a": { contextWindow: 123456, flags: {} } },
      customs: [{ slug: "manual-old", displayName: "Manual", description: "", base: "endpoint-a", overrides: { flags: {} } }],
    }) };
    await render();
    fetchResponse = async () => response(ids);
    await click(button("providers.resetModels"));
    await click(button("providers.save"));
    /** 空远程列表同样具有替换语义，不能残留旧自定义条目。 */
    const intent = parseCodexCatalogIntent(saved[0].model);
    expect(intent.customs.map((item) => item.slug)).toEqual(ids.filter((id) => id !== "builtin-only"));
    expect(intent.excluded).toEqual(ids.length ? ["endpoint-a"] : ["builtin-only", "endpoint-a"]);
    expect(intent.overrides).toEqual({});
    expect(intent.default).toBe(ids[0]);
  });

  it.each(["tool.refresh", "providers.resetModels"])("%s 失败保留草稿并允许再次刷新", async (action) => {
    saved[0] = { ...saved[0], kind: "codex", model: "", models: {} };
    await render();
    await click(button("tool.refresh"));
    await click(button("ai.catalog.addCompat"));
    await type(host.querySelector<HTMLInputElement>('input[placeholder="my-gateway/claude-opus"]')!, "manual-keep");
    await click(button("providers.save"));
    /** 请求失败前的持久化意图，包含手填与端点条目。 */
    const before = parseCodexCatalogIntent(saved[0].model);
    fetchResponse = async () => { throw new Error("HTTP 503"); };
    await click(button(action));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await click(button("providers.save"));
    expect(parseCodexCatalogIntent(saved[0].model)).toEqual(before);
    fetchResponse = async () => response(["recovered"]);
    await click(button("tool.refresh"));
    await click(button("providers.save"));
    expect(parseCodexCatalogIntent(saved[0].model).customs.map((item) => item.slug)).toEqual(["endpoint-b", "manual-keep", "recovered"]);
  });

  it("重置期间禁用操作，切换端点后旧重置响应不能覆盖新草稿", async () => {
    saved[0] = { ...saved[0], kind: "codex", model: "", models: {} };
    await render();
    await click(button("tool.refresh"));
    /** 挂起重置，模拟用户在它结束前修改端点。 */
    let finishReset!: (value: unknown) => void;
    fetchResponse = () => new Promise((resolve) => { finishReset = resolve; });
    await click(button("providers.resetModels"));
    expect(button("tool.refresh").disabled).toBe(true);
    expect(button("providers.resetModels").disabled).toBe(true);
    expect(button("providers.save").disabled).toBe(true);
    fetchResponse = async () => response(["new-endpoint"]);
    await type(host.querySelector<HTMLInputElement>('input[placeholder="providers.apiUrlPlaceholder"]')!, "https://new.test/v1");
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "http_send")).toHaveLength(2);
    await click(button("tool.refresh"));
    await act(async () => finishReset(response(["stale-reset"])));
    await click(button("providers.save"));
    expect(parseCodexCatalogIntent(saved[0].model).customs.map((item) => item.slug)).toEqual(["endpoint-b", "new-endpoint"]);
  });

  it("更换端点后忽略旧请求，不污染当前供应商目录", async () => {
    saved[0] = { ...saved[0], kind: "codex", model: "", models: {} };
    /** 第一次端点请求晚于新端点结束。 */
    let finishOld!: (value: unknown) => void;
    fetchResponse = () => new Promise((resolve) => { finishOld = resolve; });
    await render();
    await click(button("tool.refresh"));
    fetchResponse = async () => response(["new-endpoint"]);
    await type(host.querySelector<HTMLInputElement>('input[placeholder="providers.apiUrlPlaceholder"]')!, "https://new.test/v1");
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "http_send")).toHaveLength(1);
    await click(button("tool.refresh"));
    await act(async () => finishOld(response(["old-endpoint"])));
    await click(button("providers.save"));
    expect(parseCodexCatalogIntent(saved[0].model).customs.map((item) => item.slug)).toEqual(["new-endpoint"]);
  });
});
