import type { LspConfig } from "./lspConfig";

/**
 * LSP 的公开领域类型。
 *
 * 这里不放 Tauri event 载荷，也不放具体编辑器类型。调用方只依赖这些协议语义，
 * session、进程和 CodeMirror 的实现可以在各自的 Adapter 里替换。
 */

export type LspRequestId = number | string;

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspSemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

export interface LspSemanticTokensProvider {
  legend?: LspSemanticTokensLegend;
  range?: boolean | Record<string, unknown>;
  full?: boolean | { delta?: boolean };
}

/** 编辑器交给 Manager 的文档快照。URI 在 LSP seam 处由 path 统一生成。 */
export interface LspDocument {
  path: string;
  language: string;
  text: string;
  version?: number;
  dirty?: boolean;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspTextDocumentEdit {
  textDocument: {
    uri: string;
    version?: number | null;
  };
  edits: LspTextEdit[];
}

export type LspResourceOperation =
  | {
      kind: "create";
      uri: string;
      options?: { overwrite?: boolean; ignoreIfExists?: boolean };
    }
  | {
      kind: "rename";
      oldUri: string;
      newUri: string;
      options?: { overwrite?: boolean; ignoreIfExists?: boolean };
    }
  | {
      kind: "delete";
      uri: string;
      options?: { recursive?: boolean; ignoreIfNotExists?: boolean };
    };

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<LspTextDocumentEdit | LspResourceOperation>;
  changeAnnotations?: Record<string, unknown>;
}

export type LspDiagnosticTag = "unnecessary" | "deprecated" | string;

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: number | string;
  source?: string;
  message: string;
  tags?: LspDiagnosticTag[];
  relatedInformation?: Array<{
    location: LspLocation;
    message: string;
  }>;
}

export interface LspServerCapabilities {
  positionEncoding?: LspPositionEncoding | string;
  textDocumentSync?: unknown;
  /** 只声明用得到的字段：触发字符表（编辑器据此决定何时弹补全）。 */
  completionProvider?: { triggerCharacters?: string[] } | boolean;
  hoverProvider?: unknown;
  signatureHelpProvider?: unknown;
  declarationProvider?: unknown;
  definitionProvider?: unknown;
  typeDefinitionProvider?: unknown;
  implementationProvider?: unknown;
  referencesProvider?: unknown;
  /** 只声明用得到的字段：是否支持 `textDocument/prepareRename`。 */
  renameProvider?: { prepareProvider?: boolean } | boolean;
  codeActionProvider?: unknown;
  documentFormattingProvider?: unknown;
  documentRangeFormattingProvider?: unknown;
  documentOnTypeFormattingProvider?: unknown;
  documentHighlightProvider?: unknown;
  documentSymbolProvider?: unknown;
  workspaceSymbolProvider?: unknown;
  callHierarchyProvider?: unknown;
  typeHierarchyProvider?: unknown;
  semanticTokensProvider?: LspSemanticTokensProvider | false;
  inlayHintProvider?: unknown;
  codeLensProvider?: unknown;
  inlineCompletionProvider?: unknown;
  documentLinkProvider?: { resolveProvider?: boolean } | boolean;
  foldingRangeProvider?: unknown;
  selectionRangeProvider?: unknown;
  linkedEditingRangeProvider?: unknown;
  colorProvider?: unknown;
  diagnosticProvider?: unknown;
  executeCommandProvider?: unknown;
  [key: string]: unknown;
}

export type LspPositionEncoding = "utf-8" | "utf-16" | "utf-32";

export type LspServerState =
  | "missing"
  | "starting"
  | "initializing"
  | "ready"
  | "busy"
  | "crashed"
  | "restarting"
  | "disabled"
  | "misconfigured";

export type LspStatus = "starting" | "ready" | "missing";

export interface LspWakeResult {
  state: "started" | "running" | "off" | "no-root" | "failed";
  root?: string;
  markers?: string[];
  detail?: string;
}

/** 当前文档的语言服务路由；只读快照，不触发启动或配置写入。 */
export interface LspRouteInfo {
  language: string;
  serverId: string | null;
  root: string | null;
  status: "running" | "starting" | "missing" | "unconfigured";
  detail?: string;
}

export type LspStatusListener = (serverId: string, status: LspStatus, detail?: string) => void;

/** LSP 外部 seam。session、协议帧和编辑器实现都隐藏在 Manager 内部。 */
export interface LspManager {
  reconcile(root: string | null, config: LspConfig, documents: LspDocument[]): Promise<void>;
  request(
    path: string,
    language: string,
    method: string,
    params: Record<string, unknown>,
    options?: LspRequestOptions
  ): Promise<unknown>;
  /** 不自动附加 textDocument 的协议请求，供 workspace/层级类能力使用。 */
  requestRaw(
    path: string,
    language: string,
    method: string,
    params: Record<string, unknown>,
    options?: LspRequestOptions
  ): Promise<unknown>;
  executeCommand(
    path: string,
    language: string,
    command: string,
    args?: unknown[]
  ): Promise<unknown>;
  positionEncoding(path: string, language: string): LspPositionEncoding;
  documentVersion(path: string, language: string): number | undefined;
  capabilities(path: string, language: string): LspServerCapabilities | undefined;
  route(path: string, language: string): LspRouteInfo;
  /** 保存前通知与可等待的保存前编辑；无对应能力时返回 null。 */
  willSave(path: string, language: string, reason: LspSaveReason): Promise<LspTextEdit[] | null>;
  /** 磁盘写入完成后通知语言服务；正文只在服务端声明 includeText 时发送。 */
  didSave(path: string, language: string, text: string): void;
  diagnosticsFor(path: string): LspDiagnostic[];
  onDiagnosticsChange(listener: (path: string) => void): () => void;
  watchStatus(listener: LspStatusListener): () => void;
  /** 正在索引 / 分析的会话 id（服务端 `$/progress` 还没结束的那些）。 */
  busySessionIds(): ReadonlySet<string>;
  /** 订阅忙闲变化；返回退订函数。 */
  subscribeBusy(listener: () => void): () => void;
  logs(serverId: string): string[];
  watchLogs(listener: () => void): () => void;
  clearLogs(serverId: string): void;
  setWorkspaceEditHandler(handler: LspWorkspaceEditHandler | null): () => void;
  applyWorkspaceEdit(
    edit: LspWorkspaceEdit,
    context?: LspWorkspaceEditContext
  ): Promise<LspApplyEditResult>;
  wake(
    root: string | null,
    config: LspConfig,
    serverId: string,
    documents: LspDocument[]
  ): Promise<LspWakeResult>;
  shutdown(): Promise<void>;
}

export type LspSaveReason = "manual" | "afterDelay" | "focusOut";

export interface LspRequestOptions {
  signal?: AbortSignal;
}

export type LspErrorCode =
  | "transport"
  | "protocol"
  | "server"
  | "timeout"
  | "cancelled"
  | "conflict"
  | "rollback"
  | "unavailable";

export interface LspErrorDetails {
  code: LspErrorCode;
  message: string;
  method?: string;
  uri?: string;
  cause?: unknown;
}

export interface LspApplyEditResult {
  applied: boolean;
  failureReason?: string;
  failedChange?: number;
  code?: LspErrorCode;
  uri?: string;
  expectedVersion?: number;
  actualVersion?: number;
}

export interface LspWorkspaceEditContext {
  positionEncoding?: LspPositionEncoding;
  source?: string;
}

export type LspWorkspaceEditHandler = (
  edit: LspWorkspaceEdit,
  context?: LspWorkspaceEditContext
) => Promise<LspApplyEditResult>;
