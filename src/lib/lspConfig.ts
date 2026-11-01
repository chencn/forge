import { invoke } from "@tauri-apps/api/core";
import { readFile } from "./fs";
import { joinPath } from "./format";

/**
 * 语言服务配置。真相源是系统配置目录里的 `lsp.json`，读写走 `lsp_config_load` / `lsp_config_save`。
 *
 * 默认表在后端（`src-tauri/src/lsp_config.rs` 的种子）：文件本身就是完整的一表，
 * 手改的人不用再去代码里翻缺省值。档位合法性、空字段兜底也在后端归一化过一遍，
 * 前端拿到的值已经是可用的，不再校验。
 */

/** off 全关 / builtin 用 Forge 预置好的那条服务 / lsp 用户自己指的那条。三态而不是两个布尔，非法组合存不下。 */
export type LspMode = "off" | "builtin" | "lsp";

/** 一个语言服务的配置，对应 Rust `LspServerConfig`。 */
export interface LspServerConfig {
  mode: LspMode;
  /** 在 PATH 里找的那个可执行文件名。 */
  program: string;
  /** 用户填的绝对路径；空串表示用探测结果。 */
  path: string;
  /** 启动参数文本，含空格的片段用双引号包住；拆分在后端。 */
  args: string;
  /** 这个 server 管哪些语言 id（`languageForPath` 那一套）。一个 server 可管多个（ts 管 typescript 与 javascript）。 */
  languages: string[];
  /** 技术栈标志文件名，认工程根用；支持 `*.csproj` 这类后缀通配。 */
  rootMarkers: string[];
  /** 一键安装要跑的那行命令；空串表示跟着语言工具链一起装，没有独立命令。 */
  installCommand: string;
  /** 一键卸载要跑的那行命令；空串表示没有可靠的卸载路径。 */
  uninstallCommand: string;
  /** initialize 握手超时（毫秒）。 */
  startupTimeoutMs: number;
  /** 交给 server 的 initializationOptions；null 表示不传。 */
  initOptions: unknown;
  /** 是否允许 `builtin` 档。只有表里预置好了一条服务的语言才有这一档可退。 */
  supportsBuiltin: boolean;
  /** 服务主页；设置页详情头部展示。 */
  homepage: string;
  /** 没有受管安装命令时的官方安装提示；空串表示没有。 */
  installHint: string;
}

/** 整份配置，对应 Rust `LspConfig`。键是 server 名，后端按字典序落盘。 */
export interface LspConfig {
  version: number;
  /** Rust 后端用于 session 资源治理的全局上限。旧浏览器配置缺失时由后端补默认值。 */
  maxSessions?: number;
  /** Rust 后端回收空闲 session 的分钟数。旧浏览器配置缺失时由后端补默认值。 */
  idleTimeoutMin?: number;
  /** 仅运行时使用；项目配置指定语言到 server 的有序候选，不写回用户 lsp.json。 */
  candidateOrder?: Record<string, string[]>;
  servers: Record<string, LspServerConfig>;
}

/** 项目根下 `.forge/lsp.json` 的受限覆盖格式。未知字段和未知 server 会被忽略。 */
export interface LspProjectConfig {
  candidates?: Record<string, string[]>;
  servers?: Record<string, Partial<LspServerConfig>>;
}

const PROJECT_CONFIG_TTL_MS = 1_000;
const projectConfigCache = new Map<string, { at: number; value: LspProjectConfig | null }>();

/** 带 id 的一项，界面与客户端按它迭代。 */
export type LspServerEntry = LspServerConfig & { id: string };

/** 这个档要不要真起一条语言服务进程。`off` 之外都要。 */
export function serverEnabled(entry: { mode: LspMode }): boolean {
  return entry.mode !== "off";
}

/** 这个 server 允许的档位。 */
export function modesFor(server: LspServerConfig): LspMode[] {
  return server.supportsBuiltin ? ["off", "builtin", "lsp"] : ["off", "lsp"];
}

/** 真正拿去起进程的那条：用户填了路径就用它，否则用可执行文件名。 */
export function programOf(server: LspServerConfig): string {
  return server.path.trim() || server.program.trim();
}

/** 按落盘顺序列出所有 server。 */
export function serverEntries(config: LspConfig): LspServerEntry[] {
  return Object.entries(config.servers).map(([id, server]) => ({ id, ...server }));
}

/** 按配置顺序返回某个语言的启用候选；off 项不参与启动和请求路由。 */
export function serverCandidates(config: LspConfig, language: string): LspServerEntry[] {
  const entries = serverEntries(config).filter((entry) => entry.languages.includes(language));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const ordered = (config.candidateOrder?.[language] ?? [])
    .map((id) => byId.get(id))
    .filter((entry): entry is LspServerEntry => Boolean(entry));
  const rest = entries.filter((entry) => !ordered.some((item) => item.id === entry.id));
  return [...ordered, ...rest].filter(
    (entry) => serverEnabled(entry) && (entry.mode !== "builtin" || entry.supportsBuiltin)
  );
}

/** 某个语言 id 当前优先使用的 server；没有启用候选返回 null。 */
export function serverForLanguage(
  config: LspConfig,
  language: string
): LspServerEntry | null {
  return serverCandidates(config, language)[0] ?? null;
}

/** 读取项目专用配置；文件不存在、格式错误或浏览器预览环境均视为没有项目覆盖。 */
export async function loadProjectLspConfig(root: string | null): Promise<LspProjectConfig | null> {
  if (!root) return null;
  const cached = projectConfigCache.get(root);
  if (cached && Date.now() - cached.at < PROJECT_CONFIG_TTL_MS) return cached.value;
  try {
    const file = await readFile(joinPath(joinPath(root, ".forge"), "lsp.json"));
    const value: unknown = JSON.parse(file.contents);
    const result = isProjectConfig(value) ? value : null;
    projectConfigCache.set(root, { at: Date.now(), value: result });
    return result;
  } catch {
    projectConfigCache.set(root, { at: Date.now(), value: null });
    return null;
  }
}

/** 将项目覆盖合并到运行时配置；不修改调用方对象，也不携带项目字段写回用户配置。 */
export function mergeProjectLspConfig(base: LspConfig, project: LspProjectConfig | null): LspConfig {
  if (!project) return base;
  const servers = { ...base.servers };
  for (const [id, patch] of Object.entries(project.servers ?? {})) {
    if (servers[id] && isServerPatch(patch)) servers[id] = { ...servers[id], ...patch };
  }
  const candidateOrder = project.candidates
    ? Object.fromEntries(
        Object.entries(project.candidates).filter(
      ([language, ids]) => language.trim() !== "" && Array.isArray(ids)
        )
      )
    : base.candidateOrder;
  return {
    ...base,
    servers,
    candidateOrder,
  };
}

/** 读整份配置；纯浏览器预览（没有 Tauri 注入）退回空表，界面照常渲染。 */
export async function loadLspConfig(): Promise<LspConfig> {
  try {
    return await invoke<LspConfig>("lsp_config_load");
  } catch {
    return { version: 1, servers: {} };
  }
}

/** 整份写回；纯浏览器里失败就忽略。 */
export function saveLspConfig(config: LspConfig): Promise<void> {
  const { candidateOrder: _candidateOrder, ...persisted } = config;
  return invoke<void>("lsp_config_save", { config: persisted }).catch(() => {});
}

function isProjectConfig(value: unknown): value is LspProjectConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.candidates !== undefined && !isCandidateMap(record.candidates)) return false;
  if (
    record.servers !== undefined &&
    (!record.servers ||
      typeof record.servers !== "object" ||
      Array.isArray(record.servers) ||
      !Object.values(record.servers).every(isServerPatch)
    )
  ) {
    return false;
  }
  return true;
}

function isCandidateMap(value: unknown): value is Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([language, ids]) => language.trim() !== "" && Array.isArray(ids) && ids.every((id) => typeof id === "string" && id.trim() !== "")
  );
}

function isServerPatch(value: unknown): value is Partial<LspServerConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.mode !== undefined && !["off", "builtin", "lsp"].includes(String(record.mode))) return false;
  if (record.languages !== undefined && !isStringArray(record.languages)) return false;
  if (record.rootMarkers !== undefined && !isStringArray(record.rootMarkers)) return false;
  if (record.program !== undefined && typeof record.program !== "string") return false;
  if (record.path !== undefined && typeof record.path !== "string") return false;
  if (record.args !== undefined && typeof record.args !== "string") return false;
  if (record.installCommand !== undefined && typeof record.installCommand !== "string") return false;
  if (record.uninstallCommand !== undefined && typeof record.uninstallCommand !== "string") return false;
  if (
    record.startupTimeoutMs !== undefined &&
    (typeof record.startupTimeoutMs !== "number" || !Number.isFinite(record.startupTimeoutMs) || record.startupTimeoutMs <= 0)
  ) return false;
  if (record.supportsBuiltin !== undefined && typeof record.supportsBuiltin !== "boolean") return false;
  return true;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
