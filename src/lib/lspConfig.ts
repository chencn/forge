import { invoke } from "@tauri-apps/api/core";

/**
 * 语言服务配置。真相源是系统配置目录里的 `lsp.json`，读写走 `lsp_config_load` / `lsp_config_save`。
 *
 * 默认表在后端（`src-tauri/src/lsp_config.rs` 的种子）：文件本身就是完整的一表，
 * 手改的人不用再去代码里翻缺省值。档位合法性、空字段兜底也在后端归一化过一遍，
 * 前端拿到的值已经是可用的，不再校验。
 */

/** off 全关 / builtin 用 Monaco 内置语义 / lsp 用外部语言服务。三态而不是两个布尔，非法组合存不下。 */
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
  /** 这个 server 管哪些 Monaco 语言 id。一个 server 可管多个（ts 管 typescript 与 javascript）。 */
  languages: string[];
  /** 技术栈标志文件名，认工程根用；支持 `*.csproj` 这类后缀通配。 */
  rootMarkers: string[];
  /** 一键安装要跑的那行命令；空串表示跟着语言工具链一起装，没有独立命令。 */
  installCommand: string;
  /** initialize 握手超时（毫秒）。 */
  startupTimeoutMs: number;
  /** 交给 server 的 initializationOptions；null 表示不传。 */
  initOptions: unknown;
  /** 是否允许 `builtin` 档。只有 ts 系有 Monaco 内置语义可退。 */
  supportsBuiltin: boolean;
}

/** 整份配置，对应 Rust `LspConfig`。键是 server 名，后端按字典序落盘。 */
export interface LspConfig {
  version: number;
  servers: Record<string, LspServerConfig>;
}

/** 带 id 的一项，界面与客户端按它迭代。 */
export type LspServerEntry = LspServerConfig & { id: string };

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

/** 某个 Monaco 语言 id 归哪个 server 管；没有对应项返回 null。 */
export function serverForLanguage(
  config: LspConfig,
  language: string
): LspServerEntry | null {
  return serverEntries(config).find((entry) => entry.languages.includes(language)) ?? null;
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
  return invoke<void>("lsp_config_save", { config }).catch(() => {});
}
