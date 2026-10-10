import { invoke } from "@tauri-apps/api/core";
import type { LspConfig } from "./lspConfig";

/** 后端分配的语言服务会话 id：`窗口::server::工程根`，同一个键起两次拿到的是同一条。 */
export type LspSessionId = string;

/** 一条从 server 来的 LSP 消息，`body` 是去掉 `Content-Length` 头之后的 JSON 文本。 */
export interface LspMessage {
  id: LspSessionId;
  body: string;
}

/** server 写到 stderr 的一段日志。 */
export interface LspLog {
  id: LspSessionId;
  text: string;
}

/** 会话结束事件。 */
export interface LspExit {
  id: LspSessionId;
  code: number | null;
}

/** 会话状态快照。`running` 只说进程还活着，不代表索引完了。 */
export interface LspSessionStatus {
  id: LspSessionId;
  server: string;
  root: string;
  window: string;
  status: "running" | "dead" | "exited";
  restartCount: number;
  lastUsedMs: number;
  error: string | null;
}

/** 一个 server 的安装探测结果。 */
export interface LspServerProbe {
  id: string;
  program: string;
  installed: boolean;
  path: string;
}

/** 探测的完整回报：每项结果，加上可能被单向校正过的那份配置。 */
export interface LspProbeReport {
  config: LspConfig;
  servers: LspServerProbe[];
}

/** 一键安装的执行结果。 */
export interface LspInstallResult {
  command: string;
  output: string;
  exitCode: number | null;
}

/** 技术栈根解析的命中结果。 */
export interface LspRootHit {
  root: string;
  marker: string;
}

/**
 * 起一个语言服务会话，返回会话 id。幂等：同 `window + server + root` 再调一次拿到同一条会话。
 *
 * `program` 是路径或裸名字；`args` 是一行文本，含空格的片段用双引号包住，拆分在后端做。
 * 找不到可执行文件回 `LSP_NOT_FOUND`，退避中回 `LSP_START_BACKOFF`，连续失败超上限回
 * `LSP_START_LIMIT`，前端据此降级。
 */
export function lspStart(
  window: string,
  server: string,
  root: string,
  program: string,
  args: string
): Promise<LspSessionId> {
  return invoke<LspSessionId>("lsp_start", { window, server, root, program, args });
}

/** 发一条 JSON-RPC 消息给 server；`Content-Length` 头由后端补。 */
export function lspWrite(id: LspSessionId, body: string): Promise<void> {
  return invoke<void>("lsp_write", { id, body });
}

export function lspStop(id: LspSessionId): Promise<void> {
  return invoke<void>("lsp_stop", { id });
}

/** 收掉上一回页面留下的语言服务；重载时那条 `lsp_stop` 往往来不及送达。 */
export function lspReap(): Promise<void> {
  return invoke<void>("lsp_reap");
}

/** 会话状态快照；不传窗口就回全部窗口的。 */
export function lspSessionStatuses(window?: string | null): Promise<LspSessionStatus[]> {
  return invoke<LspSessionStatus[]>("lsp_session_statuses", { window: window ?? null });
}

/** 上报一次启动失败（例如握手超时），使其计入后端的退避记录。 */
export function lspFailed(id: LspSessionId, message: string): Promise<void> {
  return invoke<void>("lsp_failed", { id, message });
}

/** 手动重试：清除退避记录，下一次调用即可重新启动。 */
export function lspRetry(id: LspSessionId): Promise<void> {
  return invoke<void>("lsp_retry", { id });
}

/** 执行一轮安装状态探测，同时把「已启用外部档但未安装」的项回退为关闭；返回校正后的配置。 */
export function lspProbe(): Promise<LspProbeReport> {
  return invoke<LspProbeReport>("lsp_probe");
}

/** 跑配置里那条安装命令。没配的回 `LSP_NO_INSTALL`。 */
export function lspInstall(server: string): Promise<LspInstallResult> {
  return invoke<LspInstallResult>("lsp_install", { server });
}

/**
 * 解析某门语言在这个工程里的真实根。
 *
 * `file` 给的就是「这份文件归哪个根」，不给就是「这个工程里有没有这门语言」。
 * 返回 null 表示没找到标志文件，此时不启进程。
 */
export function lspResolveRoot(
  server: string,
  workspaceRoot: string,
  file?: string | null
): Promise<LspRootHit | null> {
  return invoke<LspRootHit | null>("lsp_resolve_root", { server, workspaceRoot, file: file ?? null });
}
