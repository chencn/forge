import { invoke, isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

/** 受支持的两个 CLI，顺序即界面兜底展示顺序；用户排序后会覆盖。 */
export const AI_PROVIDERS = ["claude", "codex"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
/** 由 Forge 或系统掌管、设置页不允许覆盖的变量，与后端白名单一致。 */
export const RESERVED_AI_CLI_ENV = ["PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"];
/** 设置页能发起的三种管理动作，与后端 `Action` 一一对应。 */
export type AiCliAction = "install" | "update" | "uninstall";
/** 界面上的产品名。品牌名不翻译，所以不进 i18n 表。 */
export const AI_NAMES: Record<AiProvider, string> = { claude: "Claude Code", codex: "Codex" };

/** 后端 `ai_cli_probe` 的单项结果。能力位由后端算好，前端不重复判断。 */
export interface AiCliStatus {
  /** 这份状态属于哪个 CLI。 */
  provider: AiProvider;
  /** PATH 上是否找到了可执行文件；找到不等于版本可用。 */
  installed: boolean;
  /** 解析出的正式版本；探测失败或输出无法解析时为 null。 */
  version: string | null;
  /** 实际使用的启动器路径，直接展示给用户，方便对照自己装在哪。 */
  path: string | null;
  /** 安装来源；只有 npm 归 Forge 管，原生与外部安装只读。 */
  source: "native" | "npm" | "external" | null;
  /** 官方源（或镜像回退）报告的最新稳定版本；查询失败时为 null。 */
  latestVersion: string | null;
  /** 上面那个版本号来自哪个源，界面据此提示镜像可能滞后。 */
  latestSource: "official" | "npmmirror" | null;
  /** 最新版本是否高于已装版本；无法比较时为 false，不会提示降级。 */
  updateAvailable: boolean;
  /** 是否允许安装：未安装、无前置条件错误、无残留占用。 */
  canInstall: boolean;
  /** 是否允许更新：可卸载、能解析版本、且确实有更高版本。 */
  canUpdate: boolean;
  /** 是否允许卸载：唯一一份安装、来源为 npm、无前置条件错误。 */
  canUninstall: boolean;
  /** 阻止操作的原因（Node 版本不够、多份安装、目录被链接占用等）。 */
  prerequisiteError: string | null;
  /** `--version` 探测失败的原因；与前置条件错误分开，用户要修的东西不同。 */
  probeError: string | null;
  /** 最新版本查询失败的原因；本地结论仍然有效。 */
  latestError: string | null;
}

/** 会话入口只关心本机是否安装，不受联网版本查询或安装管理权限影响。 */
export function installedAiProviders(statuses: Partial<Record<AiProvider, AiCliStatus>>): AiProvider[] {
  return AI_PROVIDERS.filter((provider) => statuses[provider]?.installed === true);
}

/** 一个 CLI 在设置页里的可编辑状态。 */
export interface AiCliAgentSettings {
  /** 停用后不再出现在新建会话的选择里；已有会话不受影响。 */
  enabled: boolean;
  sortOrder: number;
  /** 启动 CLI 时追加的环境变量。 */
  env: Record<string, string>;
  /** 绑定的模型供应商 id；空字符串表示没绑定。绑定只是记录来源，端点与密钥由「应用」写入 CLI。 */
  provider: string;
}

export interface AiCliSettings {
  version: number;
  agents: Record<AiProvider, AiCliAgentSettings>;
}

/** 原生配置文件。读失败时 `error` 非空，内容不能当成空文件写回。 */
export interface AiCliConfigFile {
  path: string;
  exists: boolean;
  content: string;
  error: string | null;
}

/** 一条本地检查；`id` 由界面换成当前语言的标题。 */
export interface AiCliCheck {
  id: string;
  status: "pass" | "warn" | "fail";
  value: string | null;
  hint: string | null;
}

/** Codex `approval_policy = "granular"` 展开的五个开关。 */
export interface AiCliCodexGranular {
  sandboxApproval: boolean;
  rules: boolean;
  skillApproval: boolean;
  requestPermissions: boolean;
  mcpElicitations: boolean;
}

/** Codex config.toml 里由设置页结构化管理的字段；空字符串表示使用 Codex 默认值。 */
export interface AiCliCodexSettings {
  model: string;
  modelProvider: string | null;
  approvalPolicy: string;
  sandboxMode: string;
  writableRoots: string[];
  networkAccess: boolean;
  excludeTmpdirEnvVar: boolean;
  excludeSlashTmp: boolean;
  granular: AiCliCodexGranular;
  defaultModeRequestUserInput: boolean;
  /** 推理档位；合法值来自 Codex 自己的模型清单（supported_reasoning_levels）。 */
  modelReasoningEffort: string;
  modelReasoningSummary: string;
  modelVerbosity: string;
  modelContextWindow: number | null;
  modelAutoCompactTokenLimit: number | null;
  webSearch: string;
  historyPersistence: string;
  historyMaxBytes: number | null;
  shellEnvInherit: string;
  /** 仅 Windows：`[windows].sandbox`。 */
  windowsSandbox: string;
  supportsWebsockets: boolean | null;
  /** `[model_providers.<id>]` 在文件里存在时才能写；内置 ID 被 Codex 拒绝覆盖。 */
  providerDefined: boolean;
  /** `default_permissions` 存在时 Codex 会忽略 `sandbox_mode`。 */
  shadowed: boolean;
  /** 文件里有没有 `[permissions]` 段落；它和 sandbox_mode 是两套权限表达。 */
  permissionsDefined: boolean;
  /** 生效的端点：Forge 覆盖层优先，其次是 config.toml 里 provider 的 base_url。 */
  apiBaseUrl: string;
  /** 生效的密钥：Forge 覆盖层优先，其次是 ~/.codex/auth.json。 */
  apiKey: string;
  /** auth.json 读不出来时的原因；非空时界面提示手动修复。 */
  authError: string | null;
}

/** Claude Code 的 ~/.claude/settings.json 里 `env` 的实际内容（已合并 Forge 覆盖层）。 */
export interface AiCliClaudeSettings {
  path: string;
  exists: boolean;
  error: string | null;
  env: Record<string, string>;
}

/** 认证方式由界面显式保存：只看环境变量会让「切过去」立刻被推导回原值。 */
export type ClaudeAuthMode = "official" | "custom" | "provider";
export type CodexAuthMode = "subscription" | "api_key" | "provider";

const CLAUDE_AUTH_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/** 从本地生效配置推导 Claude 认证方式；仅在加载/保存后播种，之后以用户选择为准。 */
export function claudeAuthModeOf(env: Record<string, string>): ClaudeAuthMode {
  return CLAUDE_AUTH_KEYS.some((key) => (env[key] ?? "").trim() !== "") ? "custom" : "official";
}

/** 有密钥就是 API Key 模式；没有则沿用 Codex 自己的登录状态。 */
export function codexAuthModeOf(settings: Pick<AiCliCodexSettings, "apiKey">): CodexAuthMode {
  return settings.apiKey.trim() !== "" ? "api_key" : "subscription";
}

/** 枚举一律取自 `codex -c <键>=__probe__` 的报错，不猜；界面会额外补一个「不设置」选项。 */
export const CODEX_APPROVAL_POLICIES = ["", "on-request", "on-failure", "untrusted", "never", "granular"] as const;
export const CODEX_SANDBOX_MODES = ["", "read-only", "workspace-write", "danger-full-access"] as const;
export const CODEX_SUMMARY_VALUES = ["auto", "concise", "detailed", "none"] as const;
export const CODEX_VERBOSITY_VALUES = ["low", "medium", "high"] as const;
export const CODEX_WEB_SEARCH_VALUES = ["disabled", "cached", "indexed", "live"] as const;
export const CODEX_PERSISTENCE_VALUES = ["save-all", "none"] as const;
export const CODEX_INHERIT_VALUES = ["core", "all", "none"] as const;
export const CODEX_WINDOWS_SANDBOX_VALUES = ["elevated", "unelevated", "mxc"] as const;

const defaultAgent = (sortOrder: number): AiCliAgentSettings => ({ enabled: true, sortOrder, env: {}, provider: "" });
export const DEFAULT_AI_CLI_SETTINGS: AiCliSettings = {
  version: 1,
  agents: { claude: defaultAgent(0), codex: defaultAgent(1) },
};

interface CliSettingsSnapshot {
  settings: AiCliSettings;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
}

let settingsSnapshot: CliSettingsSnapshot = {
  settings: DEFAULT_AI_CLI_SETTINGS, loaded: false, loading: false, saving: false, error: null,
};
const settingsListeners = new Set<() => void>();
function publishSettings(patch: Partial<CliSettingsSnapshot>) {
  settingsSnapshot = { ...settingsSnapshot, ...patch };
  settingsListeners.forEach((listener) => listener());
}
function subscribeSettings(listener: () => void) {
  settingsListeners.add(listener);
  return () => { settingsListeners.delete(listener); };
}
/** 启停、排序与环境变量，会话工具条和设置页共用一个快照。 */
export function useAiCliSettings() {
  return useSyncExternalStore(subscribeSettings, () => settingsSnapshot, () => settingsSnapshot);
}

/** 把后端返回的稀疏对象补齐成固定两块，界面不用到处判空。 */
function normalizeSettings(value: Partial<AiCliSettings> | null | undefined): AiCliSettings {
  const agents = value?.agents ?? ({} as Partial<Record<AiProvider, AiCliAgentSettings>>);
  return {
    version: value?.version ?? 1,
    agents: {
      claude: { ...defaultAgent(0), ...agents.claude, env: { ...agents.claude?.env } },
      codex: { ...defaultAgent(1), ...agents.codex, env: { ...agents.codex?.env } },
    },
  };
}

let settingsRequest: Promise<void> | null = null;
/** 首次进入设置页或会话工具条时读一次；并发调用共享同一个请求。 */
export function refreshAiCliSettings(force = false): Promise<void> {
  if (!cliDesktopAvailable()) {
    publishSettings({ loaded: true });
    return Promise.resolve();
  }
  if (settingsRequest) return settingsRequest;
  if (settingsSnapshot.loaded && !force) return Promise.resolve();
  publishSettings({ loading: true, error: null });
  settingsRequest = invoke<AiCliSettings>("ai_cli_settings_load").then((value) => {
    publishSettings({ settings: normalizeSettings(value), loaded: true });
  }).catch((error) => {
    publishSettings({ error: String(error), loaded: true });
  }).finally(() => {
    publishSettings({ loading: false });
    settingsRequest = null;
  });
  return settingsRequest;
}

/** 整份写回；失败时保留旧快照并把错误挂出来，界面据此提示。 */
export async function saveAiCliSettings(next: AiCliSettings): Promise<void> {
  if (!cliDesktopAvailable()) return;
  publishSettings({ saving: true, error: null });
  try {
    const saved = await invoke<AiCliSettings>("ai_cli_settings_save", { settings: normalizeSettings(next) });
    publishSettings({ settings: normalizeSettings(saved), loaded: true });
  } catch (error) {
    publishSettings({ error: String(error) });
    throw error;
  } finally {
    publishSettings({ saving: false });
  }
}

/** 修改单个 CLI 的字段；读最新的整份设置，避免并发保存互相覆盖。 */
export function updateAiCliAgent(provider: AiProvider, patch: Partial<AiCliAgentSettings>): Promise<void> {
  const current = settingsSnapshot.settings;
  return saveAiCliSettings({
    ...current,
    agents: { ...current.agents, [provider]: { ...current.agents[provider], ...patch } },
  });
}

/** 按界面顺序重排；只改 sortOrder，不动其他字段。 */
export function reorderAiCliAgents(order: AiProvider[]): Promise<void> {
  const current = settingsSnapshot.settings;
  const agents = { ...current.agents };
  order.forEach((provider, index) => { agents[provider] = { ...agents[provider], sortOrder: index }; });
  return saveAiCliSettings({ ...current, agents });
}

/** 按用户保存的顺序排列，未保存过时按内置顺序。 */
export function orderedAiProviders(settings: AiCliSettings): AiProvider[] {
  return [...AI_PROVIDERS].sort((a, b) => settings.agents[a].sortOrder - settings.agents[b].sortOrder);
}

/** 会话入口：已安装且未被停用。 */
export function availableAiProviders(
  statuses: Partial<Record<AiProvider, AiCliStatus>>,
  settings: AiCliSettings,
): AiProvider[] {
  return orderedAiProviders(settings).filter((provider) => statuses[provider]?.installed === true && settings.agents[provider].enabled);
}

/** `KEY=VALUE` → 映射；空行与 `#` 注释跳过，值里的 `=` 保留。 */
export function parseAiCliEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (key) env[key] = trimmed.slice(index + 1).trim();
  }
  return env;
}

export function aiCliEnvText(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n");
}

/**
 * 按行补丁：保留注释、空行和其他键，只替换/插入指定变量。
 * 值为空表示删除该键；重复行也会一并清掉，确保读回来就是刚写入的值。
 */
export function patchAiCliEnvText(text: string, patch: Record<string, string>): string {
  const pending = new Set(
    Object.keys(patch).filter((key) => (patch[key]?.trim() ?? "") !== ""),
  );
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const kept: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const index = line.startsWith("#") ? -1 : line.indexOf("=");
    const key = index > 0 ? line.slice(0, index).trim() : "";
    if (!key || !Object.prototype.hasOwnProperty.call(patch, key)) {
      kept.push(rawLine);
      continue;
    }
    const next = patch[key]?.trim() ?? "";
    if (!next || !pending.delete(key)) continue;
    kept.push(`${key}=${next}`);
  }
  if (pending.size > 0) {
    let end = kept.length;
    while (end > 0 && kept[end - 1].trim() === "") end -= 1;
    const tail = kept.splice(end);
    for (const key of pending) kept.push(`${key}=${patch[key]?.trim() ?? ""}`);
    kept.push(...tail);
  }
  return kept.join("\n");
}

/** 某个键在环境变量草稿里的值；不存在时返回空串。 */
export function aiCliEnvValue(text: string, ...keys: string[]): string {
  const env = parseAiCliEnvText(text);
  for (const key of keys) {
    if (env[key] !== undefined) return env[key];
  }
  return "";
}

/** 前端先挡一遍明显的错误；后端保存时仍会再校验一次。 */
export function validateAiCliEnv(env: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) return key;
    if (RESERVED_AI_CLI_ENV.some((reserved) => reserved.toLowerCase() === key.toLowerCase())) return key;
    if (value.length > 8 * 1024 || value.includes("\0")) return key;
  }
  return null;
}

/** 读 CLI 自己的配置文件（Claude settings.json / Codex config.toml）。 */
export function readAiCliConfig(provider: AiProvider): Promise<AiCliConfigFile> {
  return invoke<AiCliConfigFile>("ai_cli_config_read", { provider });
}

/** 写回前由后端按 JSON/TOML 校验，并保留一份 .forge.bak。 */
export function saveAiCliConfig(provider: AiProvider, content: string): Promise<AiCliConfigFile> {
  return invoke<AiCliConfigFile>("ai_cli_config_write", { provider, content });
}

/** Codex config.toml 的结构化字段；保存时只改这些键，保留用户其余内容和注释。 */
export function readAiCliCodexSettings(): Promise<AiCliCodexSettings> {
  return invoke<AiCliCodexSettings>("ai_cli_codex_settings_read");
}

export function saveAiCliCodexSettings(settings: AiCliCodexSettings): Promise<AiCliCodexSettings> {
  return invoke<AiCliCodexSettings>("ai_cli_codex_settings_save", { settings });
}

/** Claude settings.json 的 `env`（合并 Forge 覆盖层后的有效值）。 */
export function readAiCliClaudeSettings(): Promise<AiCliClaudeSettings> {
  return invoke<AiCliClaudeSettings>("ai_cli_claude_settings_read");
}

/** 把设置页托管的环境变量写回 settings.json；空字符串表示删除该键。 */
export function saveAiCliClaudeSettings(env: Record<string, string>): Promise<AiCliClaudeSettings> {
  return invoke<AiCliClaudeSettings>("ai_cli_claude_settings_save", { env });
}

/** 本地检查不联网；最新版本那一项由界面用 `AiCliStatus` 拼上。 */
export function runAiCliDiagnostics(provider: AiProvider): Promise<AiCliCheck[]> {
  return invoke<AiCliCheck[]>("ai_cli_diagnostics", { provider });
}

/** 管理操作的回执。`success` 是后端回读校验的结果，不是命令退出码。 */
export interface AiCliResult {
  /** 安装后回读校验是否通过；退出码为 0 但校验不通过时也是 false。 */
  success: boolean;
  /** 命令的原始输出，失败时附一句校验说明。 */
  output: string;
  /** 命令退出码；进程被信号终止等情况下为 null。 */
  exitCode: number | null;
}

/** 一份全局快照，供所有订阅者共享。 */
interface CliSnapshot {
  /** 已检测到的状态，按 provider 索引；未检测过的 provider 没有键。 */
  statuses: Partial<Record<AiProvider, AiCliStatus>>;
  /** 是否正在检测本机安装；更新查询不改变这个状态。 */
  checking: boolean;
  /** 正在执行的管理动作；非空时全局互斥，不允许再发起第二个。 */
  operation: { provider: AiProvider; action: AiCliAction } | null;
  /** 最近一次管理动作的回执，按 provider 索引，用于展示输出。 */
  results: Partial<Record<AiProvider, AiCliResult>>;
  /** 检测失败的整体错误；非空时清空 `statuses`，旧结果不再授权任何操作。 */
  error: string | null;
  /** 是否至少完成过一次检测；用来区分「没装」和「还没查」。 */
  checked: boolean;
}

// 安装任务属于应用而非设置组件。切换标签或项目后，进度、互斥和执行结果仍保留。
let snapshot: CliSnapshot = {
  statuses: {}, checking: false, operation: null, results: {}, error: null, checked: false,
};
const listeners = new Set<() => void>();
/** 合并补丁后通知所有订阅者。快照整体替换，便于 useSyncExternalStore 判等。 */
function publish(patch: Partial<CliSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}
/** 共享订阅：多个面板同时挂载时只发一次请求，也避免各自维护一份互斥状态。 */
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** 读取当前快照。任何面板都能看到同一个进行中的安装任务。 */
export function useAiCli() {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
/** 是否跑在 Tauri 里；浏览器预览下所有管理入口都要禁用。 */
export const cliDesktopAvailable = () => isTauri();

/** 只读取本机状态；联网版本查询走独立命令。 */
async function probe(force = false) {
  publish({ checking: true, error: null });
  try {
    const statuses = await invoke<AiCliStatus[]>("ai_cli_probe", { force });
    publish({ statuses: Object.fromEntries(statuses.map((item) => [item.provider, item])) });
  } catch (error) {
    // 旧结果不能在刷新失败后继续授权安装/卸载。
    publish({ statuses: {}, error: String(error) });
  } finally {
    publish({ checking: false, checked: true });
  }
}
/** 本次前端生命周期只读取一次；WebView 刷新后由后端进程缓存兜底。 */
export async function refreshAiCli(force = false) {
  if (!cliDesktopAvailable() || !force && snapshot.checked && !snapshot.error || snapshot.checking || snapshot.operation) return;
  await probe(force);
}

let updateRequest: Promise<void> | null = null;
let generation = 0;
/** 更新查询只补充管理信息；失败或迟到的响应都不能撤销安装状态。 */
export function refreshAiCliUpdates(): Promise<void> {
  if (!cliDesktopAvailable() || snapshot.operation) return Promise.resolve();
  if (updateRequest) return updateRequest;
  const current = generation;
  updateRequest = invoke<AiCliStatus[]>("ai_cli_updates").then((statuses) => {
    if (current === generation && !snapshot.operation) {
      publish({ statuses: Object.fromEntries(statuses.map((item) => [item.provider, item])) });
    }
  }).catch(() => { /* 联网失败不影响本机安装结论。 */ }).finally(() => { updateRequest = null; });
  return updateRequest;
}
/** 某个动作当前是否可点。判断只依赖后端给的能力位。 */
export function canManageCli(status: AiCliStatus | undefined, action: AiCliAction): boolean {
  if (!status) return false;
  return action === "install" ? status.canInstall
    : action === "update" ? status.canUpdate : status.canUninstall;
}
/**
 * 执行一次管理动作。
 *
 * 无论成功、失败还是抛异常，结束时都要重新探测：npm 可能已经改动了一半目录，
 * 只有回读才能知道本机到底变成什么样。期间把 `operation` 挂在快照上，
 * 其他面板据此禁用按钮，不会并发发起第二个安装。
 */
export async function manageAiCli(provider: AiProvider, action: AiCliAction) {
  if (!cliDesktopAvailable() || snapshot.operation || snapshot.checking ||
      !canManageCli(snapshot.statuses[provider], action)) return;
  publish({ operation: { provider, action }, results: { ...snapshot.results, [provider]: undefined } });
  generation += 1;
  try {
    const result = await invoke<AiCliResult>("ai_cli_manage", { provider, action });
    publish({ results: { ...snapshot.results, [provider]: result } });
  } catch (error) {
    publish({ results: { ...snapshot.results, [provider]: { success: false, output: String(error), exitCode: null } } });
  } finally {
    // 无论结果如何都重新读取本机状态；失败也可能已留下部分安装。
    await probe();
    publish({ operation: null });
  }
}
