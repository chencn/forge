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
/**
 * 自定义模型选项：在 CLI 的 /model 选择器里多出来的那一项（值 / 显示名 / 说明），
 * 用来点名网关自己提供的模型。它和六个槽位一样属于供应商，随同一次「应用」写进 CLI。
 */
export const CLAUDE_CUSTOM_SLOTS = ["customOption", "customOptionName", "customOptionDescription"] as const;
export type ClaudeCustomSlot = (typeof CLAUDE_CUSTOM_SLOTS)[number];

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
 * Codex 模型清单。`model_catalog_json` 是**整份替换**语义（实测 0.164.0 指到 `{"models":[]}`
 * 时 `thread/start` 直接拒绝：must contain at least one model），所以后端必须在 Codex 原始条目上
 * 做稀疏覆盖。枚举取值域与「能不能清除」都不写死：后端现场问 Codex，结果随 CLI 版本缓存，
 * 问不到时才退回下面这份按 0.164.0 实测抄录的兜底表，并在界面上标成未核实。
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
  /** 系统提示词：空值等于「不覆盖」，Codex 条目自带的那段文本会原样留着。 */
  baseInstructions?: string | null;
  flags: Record<string, boolean>;
}

/** 后端实测出来的一个枚举字段的规则。 */
export interface CodexFieldDomain {
  /** Codex 亲口报的合法取值（`verified` 为假时是兜底表）。 */
  values: string[];
  /** 能不能选「清除」：往 Codex 的非可选字段写 null 会让整份目录被拒。 */
  nullable: boolean;
  verified: boolean;
}

export interface CodexCustomModel {
  slug: string;
  displayName: string;
  description: string;
  /** 复制哪个官方条目的参数；空或对不上快照时回退到 priority 最小的官方条目。 */
  base: string;
  /** 手写的上下文长度；写进条目并抬高 max_context_window。 */
  contextWindow?: number;
  overrides: CodexModelOverride;
}

export interface CodexCatalogIntent {
  excluded: string[];
  overrides: Record<string, CodexModelOverride>;
  customs: CodexCustomModel[];
  default?: string;
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
  /** 按目录字段名给的取值域，界面所有的下拉都从这里取。 */
  domains: Record<string, CodexFieldDomain>;
  /** 这一版 Codex 还认的布尔开关；后端探测失败时是整张候选表。 */
  flags: string[];
  /** `flags` 是不是现问的；为假时界面要标未核实。 */
  flagsVerified: boolean;
}

/** 兜底取值域：只在后端问不到 Codex 时用，界面会标成「未核实」。 */
export const CODEX_TOOL_MODES = ["direct", "code_mode", "code_mode_only"];
export const CODEX_MULTI_AGENT_VERSIONS = ["v1", "v2"];
export const CODEX_REASONING_SUMMARIES = ["auto", "concise", "detailed", "none"];
export const CODEX_VERBOSITIES = ["low", "medium", "high"];
export const CODEX_SHELL_TYPES = ["default", "local", "shell_command", "unified_exec", "disabled"];
export const CODEX_APPLY_PATCH_TYPES = ["freeform"];
export const CODEX_WEB_SEARCH_TYPES = ["text", "text_and_image"];
export const CODEX_VISIBILITIES = ["list", "hide", "none"];
/** 开关候选表：实际显示哪些由后端探测结果决定（`view.flags`）。 */
export const CODEX_MODEL_FLAGS = [
  "use_responses_lite",
  "supports_image_detail_original",
  "support_verbosity",
  "supports_search_tool",
  "include_apps_usage_instructions",
  "include_plugin_usage_instructions",
  "include_skills_usage_instructions",
  "supports_reasoning_summary_parameter",
] as const;

/**
 * 走 OpenAI 兼容网关时要改的五件事：Codex 对自己的 GPT 用的是私有方言（代码模式、
 * 多智能体、apply_patch、responses-lite、原图细节），第三方端点只认标准 Responses。
 * 这是「能不能连通」的分水岭，所以做成一键预设，而不是让用户在八个开关里自己猜。
 */
const CODEX_COMPAT_ENUMS: CodexEnumKey[] = ["toolMode", "multiAgentVersion", "applyPatchToolType"];
const CODEX_COMPAT_FLAGS = ["use_responses_lite", "supports_image_detail_original"];

/** 下拉里「跟随 Codex」和「显式清除」是两个不同状态，不能都塞成空串：前者不写键，后者写 null。 */
export const CODEX_INHERIT = "\u0000inherit";
export const CODEX_CLEAR = "\u0000clear";

export function emptyCodexModelOverride(): CodexModelOverride {
  return { flags: {} };
}

/** 清单里渲染成下拉的目录字段；`key` 是覆盖项字段名，`field` 是 Codex 目录里的键名。 */
export type CodexEnumKey = "toolMode" | "multiAgentVersion" | "defaultReasoningSummary"
  | "defaultVerbosity" | "shellType" | "applyPatchToolType" | "webSearchToolType" | "visibility";

const CODEX_ENUM_FIELDS: Record<CodexEnumKey, string> = {
  toolMode: "tool_mode",
  multiAgentVersion: "multi_agent_version",
  defaultReasoningSummary: "default_reasoning_summary",
  defaultVerbosity: "default_verbosity",
  shellType: "shell_type",
  applyPatchToolType: "apply_patch_tool_type",
  webSearchToolType: "web_search_tool_type",
  visibility: "visibility",
};

/** 兜底表：按 Codex 0.164.0 实测抄录，只在后端问不到这一版 CLI 时用。 */
const CODEX_ENUM_FALLBACK: Record<CodexEnumKey, { values: string[]; nullable: boolean }> = {
  toolMode: { values: CODEX_TOOL_MODES, nullable: true },
  multiAgentVersion: { values: CODEX_MULTI_AGENT_VERSIONS, nullable: true },
  defaultReasoningSummary: { values: CODEX_REASONING_SUMMARIES, nullable: false },
  defaultVerbosity: { values: CODEX_VERBOSITIES, nullable: true },
  shellType: { values: CODEX_SHELL_TYPES, nullable: false },
  applyPatchToolType: { values: CODEX_APPLY_PATCH_TYPES, nullable: true },
  webSearchToolType: { values: CODEX_WEB_SEARCH_TYPES, nullable: false },
  visibility: { values: CODEX_VISIBILITIES, nullable: false },
};

/** 取值域优先用后端实测的；没探到的字段退回兜底表并标成未核实。 */
export function codexFieldDomain(view: CodexCatalogView | null, key: CodexEnumKey): CodexFieldDomain {
  const found = view?.domains?.[CODEX_ENUM_FIELDS[key]];
  if (found && Array.isArray(found.values) && found.values.length) {
    return { values: found.values, nullable: found.nullable === true, verified: found.verified === true };
  }
  const fallback = CODEX_ENUM_FALLBACK[key];
  return { values: [...fallback.values], nullable: fallback.nullable, verified: false };
}

/** 条目当前的实际取值（覆盖项优先，否则是基础条目自带的）；空串是「显式清除」，等于没有值。 */
function effectiveEnum(item: CodexModelOverride, key: CodexEnumKey, base: Record<string, unknown> | undefined): unknown {
  const value = item[key];
  if (value === "") return null;
  if (value !== undefined && value !== null) return value;
  return base?.[CODEX_ENUM_FIELDS[key]] ?? null;
}

/** 这一条是不是已经等于兼容网关需要的样子——按值判断，不另外记一个标记位。
 *  开关缺省算「未定」而不是 false：Codex 的默认值由它自己定，只有条目里写死了 false 才算已经兼容。 */
export function isCodexCompatModel(model: CodexCustomModel, base: Record<string, unknown> | undefined): boolean {
  const item = model.overrides ?? emptyCodexModelOverride();
  return CODEX_COMPAT_ENUMS.every((key) => effectiveEnum(item, key, base) === null)
    && CODEX_COMPAT_FLAGS.every((field) => (item.flags?.[field] ?? base?.[field]) === false);
}

/**
 * 套上/取下兼容预设。和清单别处一样是稀疏写法：基础条目已经等于目标值的字段不记覆盖项，
 * 取下预设时也只撤自己写过的键，用户另外设过的东西一律不碰。
 */
export function applyCodexCompatPreset(model: CodexCustomModel, base: Record<string, unknown> | undefined, enabled: boolean): CodexModelOverride {
  const next: CodexModelOverride = { ...model.overrides, flags: { ...(model.overrides?.flags ?? {}) } };
  for (const key of CODEX_COMPAT_ENUMS) {
    if (enabled) {
      // 空串在清单里就是「显式清除」；基础条目本来没有值时不必记这条覆盖。
      if (effectiveEnum(next, key, base) !== null) next[key] = "";
      else delete next[key];
    } else delete next[key];
  }
  for (const field of CODEX_COMPAT_FLAGS) {
    // 缺省不当成 false：Codex 的默认值只有写进条目才算数，所以「条目里没有」也要显式钉上 false。
    const current = next.flags[field] ?? base?.[field];
    if (enabled) {
      if (current !== false) next.flags[field] = false;
      else delete next.flags[field];
    } else delete next.flags[field];
  }
  return next;
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
      // 空串是「显式清除」（后端写 null），和没填不一样，必须在归一化里留着。
      if (value === undefined || value === null) continue;
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
  const customs = [...(intent.customs ?? [])]
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map((item) => {
      const entry: Record<string, unknown> = {
        slug: item.slug,
        displayName: item.displayName.trim(),
        description: item.description.trim(),
        base: item.base,
        overrides: override(item.overrides),
      };
      if (item.contextWindow !== undefined && item.contextWindow !== null && item.contextWindow > 0) {
        entry.contextWindow = item.contextWindow;
      }
      return entry;
    });
  const normalized: Record<string, unknown> = {
    excluded: [...(intent.excluded ?? [])].sort(),
    overrides,
    customs,
  };
  if (intent.default && intent.default.trim()) {
    normalized.default = intent.default.trim();
  }
  return JSON.stringify(normalized);
}

/** 从供应商 model 字符串解析意图，支持新意图 JSON、老 models 数组与裸 slug。 */
export function parseCodexCatalogIntent(raw: string | undefined | null): CodexCatalogIntent {
  if (!raw || !raw.trim()) return emptyCodexCatalogIntent();
  const trimmed = raw.trim();
  try {
    const value = JSON.parse(trimmed);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("customs" in value || "excluded" in value || "overrides" in value) {
        return {
          excluded: Array.isArray(value.excluded) ? value.excluded.map(String) : [],
          overrides: value.overrides && typeof value.overrides === "object" ? value.overrides : {},
          customs: Array.isArray(value.customs) ? value.customs.map((c: any) => ({
            slug: String(c.slug ?? ""),
            displayName: String(c.displayName ?? c.display_name ?? ""),
            description: String(c.description ?? ""),
            base: String(c.base ?? c.slug ?? ""),
            contextWindow: typeof c.contextWindow === "number" ? c.contextWindow : (typeof c.context_window === "number" ? c.context_window : undefined),
            overrides: c.overrides ?? emptyCodexModelOverride(),
          })) : [],
          default: typeof value.default === "string" ? value.default : undefined,
        };
      }
      if (Array.isArray(value.models)) {
        return {
          excluded: [],
          overrides: {},
          customs: value.models.map((m: any) => ({
            slug: String(m.slug ?? ""),
            displayName: String(m.displayName ?? m.display_name ?? ""),
            description: String(m.description ?? ""),
            base: String(m.base ?? m.slug ?? ""),
            contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
            overrides: m.overrides ?? emptyCodexModelOverride(),
          })),
          default: typeof value.default === "string" ? value.default : undefined,
        };
      }
    }
    if (typeof value === "string" && value.trim()) {
      const slug = value.trim();
      return {
        excluded: [],
        overrides: {},
        customs: [{ slug, displayName: "", description: "", base: slug, overrides: emptyCodexModelOverride() }],
        default: slug,
      };
    }
  } catch {
    // 裸 slug 文本
    return {
      excluded: [],
      overrides: {},
      customs: [{ slug: trimmed, displayName: "", description: "", base: trimmed, overrides: emptyCodexModelOverride() }],
      default: trimmed,
    };
  }
  return emptyCodexCatalogIntent();
}

export function serializeCodexCatalogIntent(intent: CodexCatalogIntent): string {
  const hasContent = (intent.customs && intent.customs.length > 0)
    || (intent.excluded && intent.excluded.length > 0)
    || (intent.overrides && Object.keys(intent.overrides).length > 0)
    || !!intent.default;
  if (!hasContent) return "";
  return JSON.stringify(intent, null, 2);
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

/** 按需取某个条目自带的系统提示词：整份目录里它占两成体积，不跟着列表一起塞给界面。 */
export function readAiCliCodexCatalogText(slug: string): Promise<string | null> {
  return invoke<string | null>("ai_cli_codex_catalog_text", { slug });
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
