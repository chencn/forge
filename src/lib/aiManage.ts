import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AiProvider } from "./aiCli";

/** 与后端 `Provider` 对齐：这两个 CLI 都有可管理的供应商/Skills/MCP 配置。 */
export const MANAGED_PROVIDERS: AiProvider[] = ["claude", "codex"];

export const cliAdminAvailable = () => isTauri();

/** 保存下来的一套模型端点；应用时只改动对应 CLI 的环境变量层。 */
export interface ModelProvider {
  id: string;
  name: string;
  kind: AiProvider;
  apiUrl: string;
  apiKey: string;
  /** Codex 的模型；Claude 时作为 models.main 的快捷字段。 */
  model: string;
  models: Record<string, string>;
}

export const CLAUDE_MODEL_SLOTS = ["main", "reasoning", "haiku", "sonnet", "opus", "fable"] as const;
export type ClaudeModelSlot = (typeof CLAUDE_MODEL_SLOTS)[number];

export function emptyModelProvider(kind: AiProvider): ModelProvider {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `provider-${Date.now()}`,
    name: "",
    kind,
    apiUrl: "",
    apiKey: "",
    model: "",
    models: {},
  };
}

export function loadModelProviders(): Promise<ModelProvider[]> {
  return invoke<ModelProvider[]>("ai_providers_load");
}

export function saveModelProviders(providers: ModelProvider[]): Promise<ModelProvider[]> {
  return invoke<ModelProvider[]>("ai_providers_save", { providers });
}

export function applyModelProvider(id: string): Promise<void> {
  return invoke<void>("ai_providers_apply", { id });
}

export interface SkillLocation {
  id: string;
  path: string;
}

export interface SkillItem {
  id: string;
  name: string;
  description: string | null;
  location: string;
  path: string;
  updated: number | null;
  /** 目录本身是符号链接；删除只移除链接，不删源目录。 */
  linked: boolean;
}

export interface SkillList {
  locations: SkillLocation[];
  skills: SkillItem[];
}

export function listSkills(provider: AiProvider): Promise<SkillList> {
  return invoke<SkillList>("ai_skills_list", { provider });
}

export function readSkill(provider: AiProvider, location: string, id: string): Promise<string> {
  return invoke<string>("ai_skill_read", { provider, location, id });
}

export function saveSkill(provider: AiProvider, location: string, id: string, content: string): Promise<SkillList> {
  return invoke<SkillList>("ai_skill_save", { provider, location, id, content });
}

export function deleteSkill(provider: AiProvider, location: string, id: string): Promise<SkillList> {
  return invoke<SkillList>("ai_skill_delete", { provider, location, id });
}

/** 新建技能的骨架；id 会被后端再校验一次。 */
export function skillTemplate(id: string): string {
  return `---\nname: ${id}\ndescription: Describe when this skill should be used.\n---\n\n# ${id}\n\n`;
}

export interface McpServer {
  id: string;
  spec: Record<string, unknown>;
}

export interface McpList {
  path: string;
  servers: McpServer[];
}

export function listMcp(provider: AiProvider): Promise<McpList> {
  return invoke<McpList>("ai_mcp_list", { provider });
}

export function saveMcp(provider: AiProvider, id: string, spec: Record<string, unknown>): Promise<McpList> {
  return invoke<McpList>("ai_mcp_save", { provider, id, spec });
}

export function deleteMcp(provider: AiProvider, id: string): Promise<McpList> {
  return invoke<McpList>("ai_mcp_delete", { provider, id });
}

export const MCP_TEMPLATE = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
  env: {},
};

/** 列表里的一句话摘要：stdio 看命令，http 看地址。 */
export function mcpSummary(spec: Record<string, unknown>): string {
  const url = typeof spec.url === "string" ? spec.url : "";
  if (url) return url;
  const command = typeof spec.command === "string" ? spec.command : "";
  const args = Array.isArray(spec.args) ? spec.args.filter((item): item is string => typeof item === "string") : [];
  return [command, ...args].join(" ").trim();
}

/** 编辑框里的文本 → 对象；只在前端挡住语法错误，结构校验仍由后端做。 */
export function parseMcpSpec(text: string): { spec: Record<string, unknown> } | { error: string } {
  if (!text.trim()) return { error: "empty" };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "object" };
    return { spec: parsed as Record<string, unknown> };
  } catch (error) {
    return { error: String(error) };
  }
}

/** 远程 MCP 只读 headers；带 env 时提示保存会忽略它。 */
export function hasRemoteMcpEnv(spec: Record<string, unknown>): boolean {
  const url = typeof spec.url === "string" ? spec.url.trim() : "";
  if (!url) return false;
  const env = spec.env;
  return !!env && typeof env === "object" && !Array.isArray(env) && Object.keys(env).length > 0;
}

/** SKILL.md 必须用 --- 包住的 front matter 声明 name/description，否则 CLI 不会加载。 */
export function skillHasFrontMatter(content: string): boolean {
  // 后端解析时会去掉 BOM，这里保持一致，避免把带 BOM 的合法文件误报为缺少 front matter。
  return content.replace(/^\uFEFF/, "").trimStart().startsWith("---");
}

/**
 * Codex 模型清单。`model_catalog_json` 是**整份替换**语义（实测指向单模型文件后
 * `codex debug models` 只回那一个），所以后端必须在 Codex 原始条目上做稀疏覆盖。
 * 下面的取值域全部是 Codex 0.164.0 实测能原样回显的值；写未知枚举会被整份拒掉。
 */
export interface CodexModelOverride {
  toolMode?: string | null;
  multiAgentVersion?: string | null;
  defaultReasoningLevel?: string | null;
  defaultReasoningSummary?: string | null;
  defaultVerbosity?: string | null;
  shellType?: string | null;
  applyPatchToolType?: string | null;
  webSearchToolType?: string | null;
  visibility?: string | null;
  contextWindow?: number | null;
  maxContextWindow?: number | null;
  flags: Record<string, boolean>;
}

export interface CodexCustomModel {
  slug: string;
  displayName: string;
  description: string;
  /** 复制哪个官方条目的参数；后端要求它必须存在于原始目录。 */
  base: string;
  overrides: CodexModelOverride;
}

export interface CodexCatalogIntent {
  excluded: string[];
  overrides: Record<string, CodexModelOverride>;
  customs: CodexCustomModel[];
}

export interface CodexCatalogView {
  /** 实际会写到哪个文件（CODEX_HOME 可被环境变量改写，界面直接展示免得用户猜）。 */
  path: string;
  /** config.toml 当前是否指向这份文件。 */
  active: boolean;
  /** 取原始目录失败的原因；失败时后端用上次缓存继续渲染。 */
  error: string | null;
  intent: CodexCatalogIntent;
  /** 合并完意图、并投影掉两个大字段后的实际目录。 */
  models: Record<string, unknown>[];
  /** 被排除的原始条目：界面要能显示“是哪个模型被放出去了”，否则没法放回。 */
  hidden: Record<string, unknown>[];
}

export const CODEX_TOOL_MODES = ["direct", "code_mode", "code_mode_only"];
export const CODEX_MULTI_AGENT_VERSIONS = ["v1", "v2"];
export const CODEX_REASONING_SUMMARIES = ["auto", "concise", "detailed", "none"];
export const CODEX_VERBOSITIES = ["low", "medium", "high"];
export const CODEX_SHELL_TYPES = ["unified_exec", "disabled"];
export const CODEX_APPLY_PATCH_TYPES = ["freeform"];
export const CODEX_WEB_SEARCH_TYPES = ["text", "text_and_image"];
export const CODEX_VISIBILITIES = ["list", "hide"];
/** 实测会被原样回显的开关；`supports_parallel_tool_calls` 等在 0.164 已是被忽略的死键，不提供。 */
export const CODEX_MODEL_FLAGS = [
  "support_verbosity",
  "supports_search_tool",
  "supports_image_detail_original",
  "include_apps_usage_instructions",
  "include_plugin_usage_instructions",
  "include_skills_usage_instructions",
  "use_responses_lite",
] as const;
export type CodexModelFlag = (typeof CODEX_MODEL_FLAGS)[number];

export function emptyCodexModelOverride(): CodexModelOverride {
  return { flags: {} };
}

export function emptyCodexCatalogIntent(): CodexCatalogIntent {
  return { excluded: [], overrides: {}, customs: [] };
}

/** 意图是否有改动：先归一化再比，避免 `{flags:{}}` 与缺字段造成假“未保存”。 */
export function normalizeCodexCatalogIntent(intent: CodexCatalogIntent): string {
  const override = (item: CodexModelOverride | undefined) => {
    const source = item ?? emptyCodexModelOverride();
    const fields: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(source)) {
      if (key === "flags") continue;
      if (value === undefined || value === null || value === "") continue;
      fields[key] = value as string | number;
    }
    const flags: Record<string, boolean> = {};
    for (const key of Object.keys(source.flags ?? {}).sort()) {
      if (source.flags?.[key] !== undefined) flags[key] = source.flags[key];
    }
    return { ...fields, ...(Object.keys(flags).length ? { flags } : {}) };
  };
  const overrides: Record<string, unknown> = {};
  for (const slug of Object.keys(intent.overrides ?? {}).sort()) overrides[slug] = override(intent.overrides[slug]);
  return JSON.stringify({
    excluded: [...(intent.excluded ?? [])].sort(),
    overrides,
    customs: [...(intent.customs ?? [])]
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .map((item) => ({ slug: item.slug, displayName: item.displayName.trim(), description: item.description.trim(), base: item.base, overrides: override(item.overrides) })),
  });
}

export function catalogIntentEquals(left: CodexCatalogIntent, right: CodexCatalogIntent): boolean {
  return normalizeCodexCatalogIntent(left) === normalizeCodexCatalogIntent(right);
}

/** 默认推理档位的合法值跟着模型自己走：Codex 不校验这个字段（实测写错也照样回显），只能我们挡。 */
export function codexModelEfforts(model: Record<string, unknown>): string[] {
  const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
  return levels
    .map((level) => (level && typeof level === "object" ? (level as Record<string, unknown>).effort : undefined))
    .filter((effort): effort is string => typeof effort === "string" && effort !== "");
}

export function readAiCliCodexCatalog(): Promise<CodexCatalogView> {
  return invoke<CodexCatalogView>("ai_cli_codex_catalog_read");
}

export function saveAiCliCodexCatalog(intent: CodexCatalogIntent): Promise<CodexCatalogView> {
  return invoke<CodexCatalogView>("ai_cli_codex_catalog_save", { intent });
}

/** 市场来源：官方 MCP registry 与 Smithery。 */
export interface McpMarketProvider {
  id: string;
  name: string;
  description: string;
}

/** 一条市场结果；`serverId` 是完整服务器名，也是安装后的本地配置键。 */
export interface McpMarketServer {
  providerId: string;
  serverId: string;
  name: string;
  description: string;
  homepage: string | null;
  remote: boolean;
  verified: boolean;
  iconUrl: string | null;
  latestVersion: string | null;
  protocols: string[];
  owner: string | null;
  namespace: string | null;
  downloads: number | null;
  score: number | null;
  isDeployed: boolean | null;
}

/** 安装参数；kind 决定输入控件，location 说明值写进 env、header、query 还是参数表。 */
export interface McpMarketParameter {
  key: string;
  label: string;
  description: string | null;
  required: boolean;
  secret: boolean;
  kind: string;
  defaultValue: unknown;
  placeholder: string | null;
  enumValues: string[];
  location: string | null;
}

export interface McpMarketOption {
  id: string;
  protocol: string;
  label: string;
  description: string | null;
  spec: Record<string, unknown>;
  parameters: McpMarketParameter[];
}

export interface McpMarketDetail extends McpMarketServer {
  defaultOptionId: string | null;
  installOptions: McpMarketOption[];
  /** 默认安装方式的配置；没有可安装方式时为空。 */
  spec: Record<string, unknown> | null;
}

export function mcpMarketProviders(): Promise<McpMarketProvider[]> {
  return invoke<McpMarketProvider[]>("ai_mcp_market_providers");
}

export function mcpMarketSearch(market: string, query: string): Promise<McpMarketServer[]> {
  return invoke<McpMarketServer[]>("ai_mcp_market_search", { market, query });
}

export function mcpMarketDetail(provider: AiProvider, market: string, serverId: string): Promise<McpMarketDetail> {
  return invoke<McpMarketDetail>("ai_mcp_market_detail", { provider, market, serverId });
}

/** 按安装方式的参数表生成初始草稿；对象/数组默认值转成 JSON 文本。 */
export function defaultMarketParams(option: McpMarketOption | null): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const field of option?.parameters ?? []) {
    const value = field.defaultValue;
    if (value === null || value === undefined) continue;
    draft[field.key] = typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
  }
  return draft;
}

/** 按安装方式与参数值生成真正要落盘的配置；必填缺失由后端报错。 */
export function mcpMarketResolve(
  provider: AiProvider,
  market: string,
  serverId: string,
  optionId: string,
  values: Record<string, string>,
): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("ai_mcp_market_resolve", { provider, market, serverId, optionId, values });
}
