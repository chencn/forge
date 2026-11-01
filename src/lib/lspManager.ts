import {
  diagnosticsFor,
  clearLspLogs as clientClearLogs,
  capabilitiesFor,
  lspRequest,
  lspRawRequest,
  executeLspCommand,
  lspLogs as clientLogs,
  onDiagnosticsChange,
  positionEncodingFor,
  documentVersionFor,
  routeFor,
  reconcileLsp,
  shutdownLsp,
  wakeLsp,
  watchLspLogs as clientWatchLogs,
  watchLspStatus,
  busySessionIds as clientBusySessionIds,
  subscribeBusy as clientSubscribeBusy,
  applyWorkspaceEdit as clientApplyWorkspaceEdit,
  setWorkspaceEditHandler as clientSetWorkspaceEditHandler,
  willSave as clientWillSave,
  didSave as clientDidSave,
} from "./lspClient";
import type { LspDocument, LspManager } from "./lspTypes";

/**
 * LSP 的公开 seam。
 *
 * 复杂实现仍在 lspClient 内部，调用方只拿到文档、请求、诊断和生命周期这组小接口。
 * 后续迁移 server request、capability 和 WorkspaceEdit 时只替换这里的实现，不再扩散到 UI。
 */
export const lspManager: LspManager = {
  reconcile(root: string | null, config, documents: LspDocument[]): Promise<void> {
    return reconcileLsp(root, config, documents);
  },
  request(path, language, method, params, options) {
    return lspRequest(path, language, method, params, options);
  },
  requestRaw(path, language, method, params, options) {
    return lspRawRequest(path, language, method, params, options);
  },
  executeCommand(path, language, command, arguments_) {
    return executeLspCommand(path, language, command, arguments_);
  },
  positionEncoding: positionEncodingFor,
  documentVersion: documentVersionFor,
  route: routeFor,
  capabilities: capabilitiesFor,
  willSave: clientWillSave,
  didSave: clientDidSave,
  diagnosticsFor,
  onDiagnosticsChange,
  watchStatus: watchLspStatus,
  busySessionIds: clientBusySessionIds,
  subscribeBusy: clientSubscribeBusy,
  logs: clientLogs,
  watchLogs: clientWatchLogs,
  clearLogs: clientClearLogs,
  setWorkspaceEditHandler: clientSetWorkspaceEditHandler,
  applyWorkspaceEdit: clientApplyWorkspaceEdit,
  wake(root: string | null, config, serverId: string, documents: LspDocument[]) {
    if (!root) return Promise.resolve({ state: "off" as const });
    return wakeLsp(root, config, serverId, documents);
  },
  shutdown: shutdownLsp,
};
