import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AiProvider } from "./aiCli";

/** 与后端 `Provider` 对齐：这两个 CLI 都有可管理的供应商/Skills/MCP 配置。 */
export const MANAGED_PROVIDERS: AiProvider[] = ["claude", "codex"];

/** 当前环境是否具备 CLI 管理能力；仅在桌面应用内可用。 */
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

/**
 * Claude 八个模型槽位的键名；界面顺序即此处顺序。
 *
 * 前两位是主模型与推理模型，紧随其后的 `autoMode` / `subagent` 是会话级辅助模型
 * （auto 权限模式的安全分类器、子代理默认模型）；其余四位是 Haiku~Fable 别名。
 * 它们同样属于供应商，换端点后必须一起重写，否则会拿着旧供应商的模型 ID 发请求。
 */
export const CLAUDE_MODEL_SLOTS = ["main", "reasoning", "autoMode", "subagent", "haiku", "sonnet", "opus", "fable"] as const;
/** Claude 模型槽位名的字面量联合。 */
export type ClaudeModelSlot = (typeof CLAUDE_MODEL_SLOTS)[number];
/**
 * 自定义模型选项：在 CLI 的 /model 选择器里多出来的那一项（值 / 显示名 / 说明），
 * 用来点名网关自己提供的模型。它和常规槽位一样属于供应商，随同一次「应用」写进 CLI。
 */
export const CLAUDE_CUSTOM_SLOTS = ["customOption", "customOptionName", "customOptionDescription"] as const;
/** Claude 自定义模型选项槽位名的字面量联合。 */
export type ClaudeCustomSlot = (typeof CLAUDE_CUSTOM_SLOTS)[number];

/**
 * 生成一个空的供应商配置草稿。
 *
 * @param kind - 所属 CLI；决定应用时改哪家的环境变量层
 * @returns id 已填随机 UUID、其余字段为空的草稿
 */
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

/** 读取全部已保存的供应商端点配置。 */
export function loadModelProviders(): Promise<ModelProvider[]> {
  return invoke<ModelProvider[]>("ai_providers_load");
}

/** 保存整套供应商配置并返回后端归一后的列表。 */
export function saveModelProviders(providers: ModelProvider[]): Promise<ModelProvider[]> {
  return invoke<ModelProvider[]>("ai_providers_save", { providers });
}

/** 把指定 id 的端点应用到对应 CLI 的环境变量层；当前激活项不变时是幂等的。 */
export function applyModelProvider(id: string): Promise<void> {
  return invoke<void>("ai_providers_apply", { id });
}

/** 一个技能搜索目录；一个 CLI 可能有多个（用户级 / 项目级 / 插件目录）。 */
export interface SkillLocation {
  id: string;
  path: string;
}

/** 技能列表中的一条技能。 */
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

/** 一次技能扫描结果：目录与技能集合。 */
export interface SkillList {
  locations: SkillLocation[];
  skills: SkillItem[];
}

/** 列出某 CLI 的技能目录与全部技能。 */
export function listSkills(provider: AiProvider): Promise<SkillList> {
  return invoke<SkillList>("ai_skills_list", { provider });
}

/** 读取一个技能的 SKILL.md 正文。 */
export function readSkill(provider: AiProvider, location: string, id: string): Promise<string> {
  return invoke<string>("ai_skill_read", { provider, location, id });
}

/** 保存技能正文并返回刷新后的技能列表。 */
export function saveSkill(provider: AiProvider, location: string, id: string, content: string): Promise<SkillList> {
  return invoke<SkillList>("ai_skill_save", { provider, location, id, content });
}

/** 删除技能；符号链接目录只删链接不删源目录。返回刷新后的技能列表。 */
export function deleteSkill(provider: AiProvider, location: string, id: string): Promise<SkillList> {
  return invoke<SkillList>("ai_skill_delete", { provider, location, id });
}

/** 新建技能的骨架；id 会被后端再校验一次。 */
export function skillTemplate(id: string): string {
  return `---\nname: ${id}\ndescription: Describe when this skill should be used.\n---\n\n# ${id}\n\n`;
}

/** 一个 MCP 服务器的本地配置：id 即配置文件里的键。 */
export interface McpServer {
  id: string;
  spec: Record<string, unknown>;
}

/** 某 CLI 的 MCP 配置文件位置与全部服务器。 */
export interface McpList {
  path: string;
  servers: McpServer[];
}

/** 读取某 CLI 的 MCP 配置。 */
export function listMcp(provider: AiProvider): Promise<McpList> {
  return invoke<McpList>("ai_mcp_list", { provider });
}

/** 写入（新增或覆盖）一个 MCP 服务器配置，返回刷新后的列表。 */
export function saveMcp(provider: AiProvider, id: string, spec: Record<string, unknown>): Promise<McpList> {
  return invoke<McpList>("ai_mcp_save", { provider, id, spec });
}

/** 删除一个 MCP 服务器配置，返回刷新后的列表。 */
export function deleteMcp(provider: AiProvider, id: string): Promise<McpList> {
  return invoke<McpList>("ai_mcp_delete", { provider, id });
}

/** 新建 MCP 服务器的默认 spec：本地 stdio 文件系统服务。 */
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
/** 用户自定义条目的稀疏覆盖项；null 与缺省都表示「不覆盖该字段」。 */
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

/** 用户自定义的 Codex 模型条目：写进 model_catalog_json 的新模型。 */
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

/** 用户对 Codex 模型目录的完整意图：排除、覆盖、自定义与默认模型。 */
export interface CodexCatalogIntent {
  excluded: string[];
  overrides: Record<string, CodexModelOverride>;
  customs: CodexCustomModel[];
  default?: string;
}

/** 后端合并意图后回给界面的 Codex 目录视图。 */
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
/** 兜底取值域：Codex 多智能体版本。 */
export const CODEX_MULTI_AGENT_VERSIONS = ["v1", "v2"];
/** 兜底取值域：推理摘要粒度。 */
export const CODEX_REASONING_SUMMARIES = ["auto", "concise", "detailed", "none"];
/** 兜底取值域：回答详略程度。 */
export const CODEX_VERBOSITIES = ["low", "medium", "high"];
/** 兜底取值域：shell 执行类型。 */
export const CODEX_SHELL_TYPES = ["default", "local", "shell_command", "unified_exec", "disabled"];
/** 兜底取值域：apply_patch 工具类型。 */
export const CODEX_APPLY_PATCH_TYPES = ["freeform"];
/** 兜底取值域：web_search 工具类型。 */
export const CODEX_WEB_SEARCH_TYPES = ["text", "text_and_image"];
/** 兜底取值域：目录条目可见性。 */
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
/** 兼容预设要清掉的枚举字段（指向私有方言的键）。 */
const CODEX_COMPAT_ENUMS: CodexEnumKey[] = ["toolMode", "multiAgentVersion", "applyPatchToolType"];
/** 兼容预设要显式钉成 false 的布尔开关。 */
const CODEX_COMPAT_FLAGS = ["use_responses_lite", "supports_image_detail_original"];

/** 下拉里「跟随 Codex」和「显式清除」是两个不同状态，不能都塞成空串：前者不写键，后者写 null。 */
/** 下拉里「跟随 Codex」的哨兵值；提交时不写键。 */
export const CODEX_INHERIT = "\u0000inherit";
/** 下拉里「显式清除」的哨兵值；提交时写 null。 */
export const CODEX_CLEAR = "\u0000clear";

/** 生成一份全空的覆盖项。 */
export function emptyCodexModelOverride(): CodexModelOverride {
  return { flags: {} };
}

/** 清单里渲染成下拉的目录字段；`key` 是覆盖项字段名，`field` 是 Codex 目录里的键名。 */
export type CodexEnumKey = "toolMode" | "multiAgentVersion" | "defaultReasoningSummary"
  | "defaultVerbosity" | "shellType" | "applyPatchToolType" | "webSearchToolType" | "visibility";

/** 覆盖项字段名到 Codex 目录键名的映射。 */
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
/** 兜底取值域到是否允许清除的映射；按 Codex 0.164.0 实测。 */
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

/** 生成一份空目录意图：不排除、不覆盖、无自定义条目。 */
export function emptyCodexCatalogIntent(): CodexCatalogIntent {
  return { excluded: [], overrides: {}, customs: [] };
}

/**
 * 从端点模型 ID 构造一条自定义条目：协议预设与「添加 OpenAI 兼容模型」一致，
 * base 用清单里的官方条目当模板（拿不到就留空，后端生成时会兜底选 priority 最小的）。
 */
export function codexCustomFromEndpoint(id: string, baseModel: Record<string, unknown> | undefined): CodexCustomModel {
  const item: CodexCustomModel = {
    slug: id,
    displayName: "",
    contextWindow: undefined,
    description: "",
    base: baseModel ? String(baseModel.slug ?? "") : "",
    overrides: emptyCodexModelOverride(),
  };
  return { ...item, overrides: applyCodexCompatPreset(item, baseModel, true) };
}

/**
 * 将端点模型合入供应商目录，保留手填条目与覆盖项，并排除端点未提供的内置可见模型。
 * @param intent - 当前供应商的编辑意图
 * @param ids - 端点完整返回的模型 ID
 * @param view - CLI 模板及已应用目录；为空时新增条目由后端选择模板
 * @returns 可直接保存和应用的目录意图；已有自定义条目不会因端点变化被删除
 */
export function codexCatalogFromEndpoint(intent: CodexCatalogIntent, ids: string[], view: CodexCatalogView | null): CodexCatalogIntent {
  /** 当前 CLI 中其他供应商的自定义条目不能当作官方模板。 */
  const appliedCustoms = new Set(view?.intent.customs.map((item) => item.slug) ?? []);
  /** 被排除的官方条目仍需参与本供应商的目录计算。 */
  const officials = [...new Map([...(view?.models ?? []), ...(view?.hidden ?? [])]
    .filter((model) => !appliedCustoms.has(String(model.slug)))
    .map((model) => [String(model.slug), model] as const)).values()];
  /** 隐藏内部模型不用于端点列表，也不从 CLI 目录中排除。 */
  const listable = officials.filter((model) => (model.visibility ?? "list") === "list");
  /** 完整 ID 匹配保留前缀不同的独立模型。 */
  const offered = new Set(ids);
  /** 原有排除由用户决定；端点以外的官方模型不能继续作为可用模型出现。 */
  const excluded = [...new Set([...intent.excluded, ...listable.filter((model) => !offered.has(String(model.slug))).map((model) => String(model.slug))])];
  /** 自定义模型与官方同名时仍保留用户自己的参数。 */
  const customs = [...intent.customs];
  for (const id of ids) {
    if (excluded.includes(id) || customs.some((item) => item.slug === id) || listable.some((model) => model.slug === id)) continue;
    customs.push(codexCustomFromEndpoint(id, listable[0] ?? officials[0]));
  }
  /** 默认模型必须仍在最终目录中，失效时优先采用端点第一个可用模型。 */
  const available = [...ids.filter((id) => !excluded.includes(id)), ...customs.map((item) => item.slug)].filter(Boolean);
  return { ...intent, excluded, customs, default: intent.default && available.includes(intent.default) ? intent.default : available[0] };
}

/**
 * 从本地目录意图恢复可用模型 ID，无需请求供应商端点。
 * @param intent - 已保存或正在编辑的目录意图
 * @param view - 本机目录模板；为空时只返回自定义模型
 * @returns 去重后的可见官方模型和自定义模型 ID；没有可用模型时为空数组
 */
export function codexCatalogModelIds(intent: CodexCatalogIntent, view: CodexCatalogView | null): string[] {
  /** 已应用目录中的自定义模型由当前意图决定，不能混入其他供应商的模型。 */
  const appliedCustoms = new Set(view?.intent.customs.map((item) => item.slug) ?? []);
  return [...new Set([
    ...[...(view?.models ?? []), ...(view?.hidden ?? [])]
      .filter((model) => (model.visibility ?? "list") === "list" && !appliedCustoms.has(String(model.slug)) && !intent.excluded.includes(String(model.slug)))
      .map((model) => String(model.slug)),
    ...intent.customs.map((item) => item.slug),
  ])].filter(Boolean);
}

/**
 * 拉取供应商端点的可用模型清单（`GET {base}/v1/models`）。
 * Claude 走 Anthropic 鉴权头，Codex 走标准 Bearer；两家响应都是 `data[].id`。
 * 页面 CSP 只放行自家地址，浏览器 fetch 到不了任意端点，所以请求交给后端 `http_send`。
 * 不传 root 就不进 HTTP 历史——这不是 `.http` 里的一条请求，只是借个传输。
 */
export async function listProviderModels(kind: AiProvider, apiUrl: string, apiKey: string): Promise<string[]> {
  const base = apiUrl.trim().replace(/\/+$/, "");
  const url = base.endsWith("/v1/models") ? base
    : base.endsWith("/v1") ? `${base}/models`
    : `${base}/v1/models`;
  const headers = kind === "claude"
    ? [
        { name: "x-api-key", value: apiKey.trim() },
        { name: "anthropic-version", value: "2023-06-01" },
      ]
    : [{ name: "Authorization", value: `Bearer ${apiKey.trim()}` }];
  const exchange = await invoke<{
    entry: { error: string | null };
    response: { status: number; statusText: string; body: string | null } | null;
  }>("http_send", {
    requestId: null,
    path: null,
    root: null,
    call: {
      name: null,
      method: "GET",
      url,
      headers: headers.map((header) => [header.name, header.value]),
      body: [],
    },
  });
  const result = exchange.response;
  if (!result) throw new Error(exchange.entry.error ?? "请求失败");
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`HTTP ${result.status} ${result.statusText}`.trim());
  }
  if (result.body === null) throw new Error("响应不是文本");
  const parsed = JSON.parse(result.body) as { data?: unknown; models?: unknown };
  const list = Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : [];
  const ids = list
    .map((item) => (typeof item === "string" ? item : (item as { id?: unknown })?.id))
    .filter((id): id is string => typeof id === "string" && id.trim() !== "")
    .map((id) => id.trim());
  return Array.from(new Set(ids)).sort((left, right) => left.localeCompare(right));
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

/** 把意图序列化成保存到供应商 model 字段的 JSON 文本；空意图返回空串。 */
export function serializeCodexCatalogIntent(intent: CodexCatalogIntent): string {
  const hasContent = (intent.customs && intent.customs.length > 0)
    || (intent.excluded && intent.excluded.length > 0)
    || (intent.overrides && Object.keys(intent.overrides).length > 0)
    || !!intent.default;
  if (!hasContent) return "";
  return JSON.stringify(intent, null, 2);
}

/** 两个意图是否等价：按归一化文本比较。 */
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

/** 读取 Codex 模型目录的当前视图。 */
export function readAiCliCodexCatalog(): Promise<CodexCatalogView> {
  return invoke<CodexCatalogView>("ai_cli_codex_catalog_read");
}

/** 保存意图并返回合并后的目录视图。 */
export function saveAiCliCodexCatalog(intent: CodexCatalogIntent): Promise<CodexCatalogView> {
  return invoke<CodexCatalogView>("ai_cli_codex_catalog_save", { intent });
}

/** 按需取某个条目自带的系统提示词：整份目录里它占两成体积，不跟着列表一起塞给界面。 */
export function readAiCliCodexCatalogText(slug: string): Promise<string | null> {
  return invoke<string | null>("ai_cli_codex_catalog_text", { slug });
}

/** 市场来源：官方 MCP registry 与 Smithery。 */
/** 一个市场来源的展示信息。 */
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

/** 市场里可选的一种安装方式（协议 + 参数表）。 */
export interface McpMarketOption {
  id: string;
  protocol: string;
  label: string;
  description: string | null;
  spec: Record<string, unknown>;
  parameters: McpMarketParameter[];
}

/** 市场服务器详情：搜索结果字段 + 该 CLI 下的安装方式列表。 */
export interface McpMarketDetail extends McpMarketServer {
  defaultOptionId: string | null;
  installOptions: McpMarketOption[];
  /** 默认安装方式的配置；没有可安装方式时为空。 */
  spec: Record<string, unknown> | null;
}

/** 列出可用的市场来源。 */
export function mcpMarketProviders(): Promise<McpMarketProvider[]> {
  return invoke<McpMarketProvider[]>("ai_mcp_market_providers");
}

/** 在指定市场里按关键词搜索服务器。 */
export function mcpMarketSearch(market: string, query: string): Promise<McpMarketServer[]> {
  return invoke<McpMarketServer[]>("ai_mcp_market_search", { market, query });
}

/** 取某服务器在指定 CLI 下的安装详情（安装方式与参数表）。 */
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
