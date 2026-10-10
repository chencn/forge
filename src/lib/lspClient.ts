import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { lspFailed, lspResolveRoot, lspStart, lspStop, lspWrite } from "./lsp";
import type { LspExit, LspLog, LspMessage } from "./lsp";
import { programOf, serverEntries, serverForLanguage } from "./lspConfig";
import type { LspConfig, LspServerEntry } from "./lspConfig";
import { parentPath, pathWithin, samePath } from "./format";
import { windowLabel } from "./window";
import { monaco } from "./monacoEditor";

/**
 * 一份要交给语言服务的文档快照。
 *
 * 由调用方（App）每次从文档列表里挑出「已加载、可编辑、语言归某个 server 管」的那些喂进来，
 * 客户端不认识文档模型本身的其它字段。
 */
export interface LspDocument {
  /** 文件绝对路径，同时是 LSP 的 URI 键。 */
  path: string;
  /** Monaco 语言 id，用来选 server。 */
  language: string;
  /** 当前文本（含未保存改动）。 */
  text: string;
}

/**
 * 一个运行中的语言服务：后端会话、它对应的配置项，以及它使用的项目根。
 *
 * 会话按 `server + 根` 分，不是按 server 分。`Cargo.toml` 在子目录的工程里拿工程根当
 * `rootUri`，rust-analyzer 就退成 detached 单文件模式：跨文件跳转失效、类型诊断缺失。
 */
interface RunningServer {
  /** 表里的键：`server id + 分隔符 + 根`。同一个 server 在 monorepo 里可以有多条。 */
  key: string;
  /** 后端会话 id。 */
  id: string;
  entry: LspServerEntry;
  root: string;
  /** 已 didOpen 的文档，键是 URI，值是 LSP 版本号。 */
  opened: Map<string, number>;
  /** 每个文档最后一次发出去的文本内容，用来判断要不要 didChange。 */
  sent: Map<string, string>;
  /** 下一个要用的文档版本号，LSP 只要求它单调递增。 */
  version: number;
}

const running = new Map<string, RunningServer>();
/**
 * 最近一次 reconcile 用到的那份配置。
 * provider 回调是 Monaco 直接调的，拿不到调用参数，语言归哪个 server 管要按当前配置查。
 */
let current: LspConfig = { version: 1, servers: {} };
/**
 * 暂时不去起的组合，键同 `running`。
 *
 * `retryAt` 是可以重试的时刻：后端退避返回具体时刻，本机未安装与未找到标志文件返回无穷远，
 * 直到用户修改配置或手动重试时清除。缺少这一层，每次击键触发的 reconcile 都会重复一次必然失败的 spawn。
 */
/** 暂时不去起的组合，键同 `running`。 */
const skipped = new Map<string, { detail: string; retryAt: number; signature: string }>();
/** 根解析的备忘：同一次编辑里同一个目录不再问后端一遍。换工程时清空。 */
const roots = new Map<string, { root: string | null; at: number }>();
/** 当前解析所依据的工程根；变了就要把备忘丢掉。 */
let rootsScope = "";
/** 后端事件只订阅一次。 */
let detachMessage: UnlistenFn | null = null;
let detachExit: UnlistenFn | null = null;
let detachLog: UnlistenFn | null = null;
/** 同步哨兵：订阅是否已经发起（与 detachMessage 是否已赋值无关）。 */
let subscribed = false;
/** 诊断落到 Monaco 的 owner 串：清旧标记时靠它只清这个 server 的。 */
const DIAGNOSTIC_OWNER = "lsp";
/** 会话键的分隔符：server 名与路径里都不会出现的字符。 */
const KEY_SEP = String.fromCharCode(1);
/** 待发出的请求 id，用来把响应配回请求。 */
let nextId = 1;
/** 还没收到响应的请求：id → 回调解法。 */
const inflight = new Map<number, (result: unknown) => void>();
/** 已注册过 provider 的语言，避免重复注册。 */
const providersRegistered = new Set<string>();

/** 语言服务状态变化的通知，界面据此显示「正在启动 / 未找到」。 */
export type LspStatus = "starting" | "ready" | "missing";
type StatusWatcher = (serverId: string, status: LspStatus, detail?: string) => void;
const statusWatchers = new Set<StatusWatcher>();

function emitStatus(serverId: string, status: LspStatus, detail = "") {
  for (const watch of statusWatchers) watch(serverId, status, detail);
}

/** 订阅语言服务状态；立刻回放一遍当前所有已知状态。 */
export function watchLspStatus(watch: StatusWatcher): () => void {
  statusWatchers.add(watch);
  // 回放按 server 归并：同一个 server 可能一条会话成了、另一条被跳过（根不同），
  // 只要有一条活着就不算「未找到」，否则后放的跳过记录会把 ready 盖掉。
  const live = new Set([...running.values()].map((server) => server.entry.id));
  for (const server of running.values()) watch(server.entry.id, "ready");
  for (const [key, item] of skipped) {
    const id = key.split(KEY_SEP)[0];
    if (!live.has(id)) watch(id, "missing", item.detail);
  }
  return () => {
    statusWatchers.delete(watch);
  };
}

/** 把 LSP 的 `file://` URI 和本地路径互转。前后端都用真实路径，不另造虚拟路径。 */
function toUri(path: string): string {
  return monaco.Uri.file(path).toString();
}

/** 会话键：同一份配置在同一个根上只有一条会话。 */
function sessionKey(entry: LspServerEntry, root: string): string {
  return `${entry.id}${KEY_SEP}${root}`;
}

/** 根解析的备忘有效时长，与后端那层缓存同长：新加一个 `go.mod` 一分钟内要能认出来。 */
const ROOTS_TTL = 60_000;

/**
 * 这份文件归哪个根管。
 *
 * 问过一次的直接查备忘；后端对「标志文件在不在」另有 60 秒缓存。
 * 返回 null 表示这个工程里没有该语言的技术栈，此时不启进程。
 */
async function resolveRoot(
  entry: LspServerEntry,
  workspaceRoot: string | null,
  file: string
): Promise<string | null> {
  const dir = parentPath(file) ?? file;
  const memo = `${entry.id}${KEY_SEP}${workspaceRoot ?? ""}${KEY_SEP}${dir}`;
  const held = roots.get(memo);
  if (held && Date.now() - held.at < ROOTS_TTL) return held.root;
  if (!workspaceRoot) return null;
  const hit = await lspResolveRoot(entry.id, workspaceRoot, file).catch(() => null);
  const root = hit?.root ?? null;
  roots.set(memo, { root, at: Date.now() });
  return root;
}

/** 启动后端进程。返回会话 id，失败时抛出带错误码的字符串。幂等：同键再调一次拿到同一条。 */
async function launch(entry: LspServerEntry, root: string): Promise<string> {
  return lspStart(windowLabel, entry.id, root, programOf(entry), entry.args);
}

/** 发一条 JSON-RPC 通知（不需要响应）。 */
function notify(server: RunningServer, method: string, params: unknown): void {
  const body = JSON.stringify({ jsonrpc: "2.0", method, params });
  void lspWrite(server.id, body).catch(() => {});
}

/** 发一条 JSON-RPC 请求，返回一个等响应的 Promise。 */
function request(server: RunningServer, method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => {
    inflight.set(id, resolve);
    void lspWrite(server.id, body).catch(() => {
      inflight.delete(id);
      resolve(null);
    });
  });
}

/** 握手：发 initialize 并等响应，再发 initialized。根与超时都取自这条会话自己的配置。 */
async function initialize(server: RunningServer): Promise<void> {
  const entry = server.entry;
  const timeout = Math.max(1000, entry.startupTimeoutMs || 30_000);
  // 握手要按时限放弃：`request` 只在收到响应或写入失败时才落地，进程活着但不回 initialize 会永远挂着。
  const settled = await Promise.race([
    request(server, "initialize", {
      processId: null,
      rootUri: toUri(server.root),
      ...(entry.initOptions === null || entry.initOptions === undefined
        ? {}
        : { initializationOptions: entry.initOptions }),
      capabilities: {
        textDocument: {
          synchronization: { didSave: false, dynamicRegistration: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          completion: { completionItem: { snippetSupport: false } },
          definition: {},
          references: {},
          rename: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: {},
        },
        workspace: { workspaceFolders: false },
      },
      workspaceFolders: null,
    }).then((result) => ({ result, timedOut: false })),
    new Promise<{ result: unknown; timedOut: boolean }>((resolve) => {
      setTimeout(() => resolve({ result: null, timedOut: true }), timeout);
    }),
  ]);
  if (settled.timedOut) throw new Error(`initialize 握手超时（${Math.round(timeout / 1000)} 秒）`);
  notify(server, "initialized", {});
}

/** 该会话使用的命令与参数。二者变化后需要重试一次：退避与「未安装」的判断都是按修改前的值得出的。 */
function signature(entry: LspServerEntry): string {
  return `${programOf(entry)} ${entry.args}`;
}

/**
 * 从后端那条错误里读出它给的退避时长（`LSP_START_BACKOFF` 第二段是毫秒）。
 * 读不出具体时长的（没找到、spawn 失败、超上限）按「等人来改」处理。
 */
function retryFrom(detail: string): number {
  const parts = detail.split(KEY_SEP);
  if (parts[0] === "LSP_START_BACKOFF") {
    const wait = Number(parts[1]);
    if (Number.isFinite(wait) && wait > 0) return Date.now() + wait;
  }
  return Number.POSITIVE_INFINITY;
}

/** 正在启动的会话键：对档流程与设置页的「启动」可能同时选中同一条，不能启动两遍。 */
const starting = new Set<string>();

/** 建一条会话：起进程、订阅事件、握手。同一条键只允许一趟在跑；返回失败原因，成功为 null。 */
async function startServer(entry: LspServerEntry, root: string): Promise<string | null> {
  const key = sessionKey(entry, root);
  // 已经有同一键在跑：这一趟不重复起，也不报错；失败原因由在跑的那趟通过状态回调给出。
  if (starting.has(key)) return null;
  starting.add(key);
  try {
    return await launchSession(key, entry, root);
  } finally {
    starting.delete(key);
  }
}

async function launchSession(
  key: string,
  entry: LspServerEntry,
  root: string
): Promise<string | null> {
  emitStatus(entry.id, "starting");
  // 订阅要先挂上：进程一 spawn 就可能向 stderr 写入报错，晚一步那几行无法补回。
  ensureSubscriptions();
  let id: string;
  try {
    id = await launch(entry, root);
  } catch (cause) {
    // 后端已经为「找不到」与「spawn 失败」记过账，这里只补本地状态，并把原始错误串交给调用方。
    const detail = typeof cause === "string" ? cause : String(cause);
    skipped.set(key, { detail, retryAt: retryFrom(detail), signature: signature(entry) });
    emitStatus(entry.id, "missing", detail);
    return detail;
  }
  const server: RunningServer = {
    key,
    id,
    entry,
    root,
    opened: new Map(),
    sent: new Map(),
    version: 0,
  };
  running.set(key, server);
  skipped.delete(key);
  owners.set(id, entry.id);
  adoptLogs(id, entry.id);
  // 会话 id 会随窗口开久了累积，攒够一批就松开最老的半批。
  if (owners.size > 256) {
    for (const stale of [...owners.keys()].slice(0, 128)) owners.delete(stale);
  }
  ensureProviders(entry);

  try {
    await initialize(server);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "initialize 失败";
    running.delete(key);
    // 握手失败时也不能把进程留在内存里：上报后端记录退避，随后回收。
    void lspFailed(id, detail).catch(() => {});
    await lspStop(id).catch(() => {});
    skipped.set(key, { detail, retryAt: Date.now() + 15_000, signature: signature(entry) });
    emitStatus(entry.id, "missing", detail);
    return detail;
  }
  emitStatus(entry.id, "ready");
  return null;
}

/** 后端事件订阅只挂一次，分发到当前表里的会话。 */
function ensureSubscriptions(): void {
  // 用同步布尔做哨兵，不用 detachMessage：listen 返回的取消函数是在 .then 里才赋值的，
  // 那之前 detachMessage 还是 null。两个 server 同时起时会在那个窗口里各挂一遍订阅，
  // 每条消息就被处理两次（诊断重复、响应被配走两次）。
  if (subscribed) return;
  subscribed = true;
  void listen<LspMessage>("lsp://message", (event) => {
    const server = findById(event.payload.id);
    if (server) handleMessage(server, event.payload.body);
  }).then((off) => {
    detachMessage = off;
  });
  void listen<LspExit>("lsp://exit", (event) => {
    handleExit(event.payload);
  }).then((off) => {
    detachExit = off;
  });
  void listen<LspLog>("lsp://log", (event) => {
    // 后端必须有人把这条管道读干净，否则缓冲满了 server 会卡住；内容留在 `logs` 里给界面看与复制。
    appendLog(event.payload.id, event.payload.text);
    const serverId = ownerOf(event.payload.id);
    if (serverId) console.debug(`[lsp:${serverId}]`, event.payload.text);
  }).then((off) => {
    detachLog = off;
  });
}

/** 会话 id → server id：进程退出之后日志还要留在卡片上，所以这份映射不跟着会话删。 */
const owners = new Map<string, string>();

function ownerOf(id: string): string | null {
  return owners.get(id) ?? (findById(id)?.entry.id ?? null);
}

/** 每个 server 最近的语言服务输出，按行存。上限 200 行：再多就没人看了。 */
const LOG_CAP = 200;
const logs = new Map<string, string[]>();
const logWatchers = new Set<() => void>();
/** 前端尚未确认该会话时（进程一 spawn 即崩溃，stderr 先于 `lsp_start` 返回）暂存的输出行。 */
const orphans = new Map<string, string[]>();

function pushLog(serverId: string, text: string): void {
  const mine = logs.get(serverId) ?? [];
  mine.push(text);
  if (mine.length > LOG_CAP) mine.splice(0, mine.length - LOG_CAP);
  logs.set(serverId, mine);
  for (const listener of logWatchers) listener();
}

function appendLog(id: string, text: string): void {
  const serverId = ownerOf(id);
  if (serverId) {
    pushLog(serverId, text);
    return;
  }
  const mine = orphans.get(id) ?? [];
  mine.push(text);
  if (mine.length > LOG_CAP) mine.splice(0, mine.length - LOG_CAP);
  orphans.set(id, mine);
  if (orphans.size > 64) {
    for (const stale of [...orphans.keys()].slice(0, 32)) orphans.delete(stale);
  }
}

/** 确认该会话所属项之后，把先前暂存的输出行并入该项。 */
function adoptLogs(id: string, serverId: string): void {
  const mine = orphans.get(id);
  if (!mine) return;
  orphans.delete(id);
  for (const line of mine) pushLog(serverId, line);
}

/** 某一项最近的语言服务输出，最新一行在末尾。 */
export function lspLogs(serverId: string): string[] {
  return logs.get(serverId) ?? [];
}

/** 输出日志发生变化时通知订阅者，卡片的「日志」按钮与弹窗都依赖这个通知。 */
export function watchLspLogs(listener: () => void): () => void {
  logWatchers.add(listener);
  return () => {
    logWatchers.delete(listener);
  };
}

/** 清空某一项的输出：复制归档后归零，下一次启动只查看新增的输出。 */
export function clearLspLogs(serverId: string): void {
  if (!logs.delete(serverId)) return;
  for (const listener of logWatchers) listener();
}

function findById(id: string): RunningServer | null {
  for (const server of running.values()) if (server.id === id) return server;
  return null;
}

/** 一条消息：有 id 是响应，配回 pending；没 id 是通知（诊断等），直接处理。 */
function handleMessage(server: RunningServer, body: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }
  const message = parsed as {
    id?: number | string;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  };
  if (message.id !== undefined && message.method === undefined) {
    const numericId = typeof message.id === "number" ? message.id : Number(message.id);
    const resolve = Number.isFinite(numericId) ? inflight.get(numericId) : undefined;
    if (resolve) {
      inflight.delete(numericId);
      resolve(message.result ?? null);
    }
    return;
  }
  if (message.method === "textDocument/publishDiagnostics") {
    applyDiagnostics(message.params as { uri: string; diagnostics: LspDiagnostic[] });
    return;
  }
  // 少数 server 会发请求回来（`window/workDoneProgress/create`、`workspace/configuration` 等），按协议回复。
  // 允许数字与字符串类型的 id。
  if (message.id !== undefined && message.method) {
    let result: unknown = null;
    if (message.method === "workspace/configuration") {
      // 规范要求返回与请求项长度一致的配置数组，返回 null 会导致 TypeScript / ESLint 等服务端抛 TypeError 崩溃
      const items = (message.params as { items?: unknown[] })?.items;
      result = Array.isArray(items) ? items.map(() => ({})) : [{}];
    }
    void lspWrite(
      server.id,
      JSON.stringify({ jsonrpc: "2.0", id: message.id, result })
    ).catch(() => {});
  }
}

/**
 * 会话结束。能走到这里说明不是我们主动停的（主动停时已先从表里摘掉了），
 * 也就是进程崩了或被外部杀了。摘掉并报 `missing`，下一次 reconcile 会重试。
 * 不记入 `unavailable`：该表用于「本机未安装」，进程崩溃应当保留重试的机会。
 */
function handleExit(payload: LspExit): void {
  const server = findById(payload.id);
  // 后端在那条路上已经记过一次失败并排好退避；这里只是把会话从本地表里摘掉。
  const detail = payload.code === null ? "语言服务已退出" : `语言服务退出，退出码 ${payload.code}`;
  appendLog(payload.id, detail);
  if (!server) return;
  running.delete(server.key);
  emitStatus(server.entry.id, "missing", detail);
}

/** 一条 LSP 诊断，字段按协议给的最小子集。 */
interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  message: string;
  source?: string;
}

/** 把诊断落到 Monaco 的 marker 上。行号要 +1：LSP 从 0 起，Monaco 从 1 起。 */
function applyDiagnostics(params: { uri: string; diagnostics: LspDiagnostic[] }): void {
  const model = findModelByUri(params.uri);
  if (!model) return;
  const markers = params.diagnostics.map((diagnostic) => ({
    severity: severityOf(diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source,
    startLineNumber: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.character + 1,
    endLineNumber: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
  }));
  monaco.editor.setModelMarkers(model, DIAGNOSTIC_OWNER, markers);
}

/**
 * 按 URI 找 model。
 *
 * 先直接按解析出的 URI 查；查不到再按归一化文件路径扫一遍。server 回的 URI 常带编码
 * （`file:///c%3A/...`，盘符小写且冒号被编码），和我们用 `Uri.file` 建的可能不逐字节相同，
 * 只靠第一次查会漏掉诊断，marker 就永远不显示。
 */
function findModelByUri(raw: string): monaco.editor.ITextModel | null {
  const direct = monaco.editor.getModel(monaco.Uri.parse(raw));
  if (direct) return direct;
  let target: string;
  try {
    target = monaco.Uri.parse(raw).fsPath;
  } catch {
    return null;
  }
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme === "file" && samePath(model.uri.fsPath, target)) return model;
  }
  return null;
}

function severityOf(severity: number | undefined): monaco.MarkerSeverity {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    default:
      return monaco.MarkerSeverity.Hint;
  }
}

/**
 * 给这个 server 管的语言注册 Monaco provider，把请求转成 LSP 往返。
 * 每种语言只注册一次；内置语义该关的地方由 `configureBuiltin` 处理。
 */
function ensureProviders(entry: LspServerEntry): void {
  for (const language of entry.languages) {
    if (providersRegistered.has(language)) continue;
    providersRegistered.add(language);

    monaco.languages.registerHoverProvider(language, {
      provideHover: async (model, position) => {
        const result = await serverRequest(model, "textDocument/hover", {
          position: { line: position.lineNumber - 1, character: position.column - 1 },
        });
        return hoverFromLsp(result);
      },
    });

    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: [".", ":", "<", "/", "@", '"', "'"],
      provideCompletionItems: async (model, position) => {
        const result = await serverRequest(model, "textDocument/completion", {
          position: { line: position.lineNumber - 1, character: position.column - 1 },
        });
        return completionsFromLsp(result, model, position);
      },
    });

    monaco.languages.registerReferenceProvider(language, {
      provideReferences: async (model, position) => {
        const result = await serverRequest(model, "textDocument/references", {
          position: { line: position.lineNumber - 1, character: position.column - 1 },
          context: { includeDeclaration: true },
        });
        return locationsFromLsp(result);
      },
    });

    monaco.languages.registerDefinitionProvider(language, {
      provideDefinition: async (model, position) => {
        const result = await serverRequest(model, "textDocument/definition", {
          position: { line: position.lineNumber - 1, character: position.column - 1 },
        });
        return locationsFromLsp(result);
      },
    });

    monaco.languages.registerDocumentSymbolProvider(language, {
      provideDocumentSymbols: async (model) => {
        const result = await serverRequest(model, "textDocument/documentSymbol", {});
        return symbolsFromLsp(result);
      },
    });
  }
}

/**
 * LSP completion → Monaco completion。带范围信息时用它做替换范围，否则从光标到词尾。
 *
 * 只做最小必要的映射：标签、插入文本、种类、详情、文档。snippet / 附加编辑这些
 * 冒进的能力先不接——接错比不接更糟（往文档里插进不对的文本）。
 */
function completionsFromLsp(
  result: unknown,
  model: monaco.editor.ITextModel,
  position: monaco.Position
): monaco.languages.CompletionList {
  if (!result || typeof result !== "object") return { suggestions: [] };
  const raw = Array.isArray(result)
    ? result
    : (((result as { items?: unknown }).items as unknown[]) ?? []);
  const word = model.getWordUntilPosition(position);
  const fallbackRange: monaco.IRange = {
    startLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endLineNumber: position.lineNumber,
    endColumn: word.endColumn,
  };
  const suggestions: monaco.languages.CompletionItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const node = item as {
      label?: unknown;
      kind?: number;
      detail?: string;
      documentation?: unknown;
      insertText?: string;
      textEdit?: { newText?: string; range?: LspRange };
      filterText?: string;
      sortText?: string;
    };
    const label = labelOf(node.label);
    if (!label) continue;
    const insertText = node.textEdit?.newText ?? node.insertText ?? label;
    suggestions.push({
      label,
      kind: completionKind(node.kind),
      detail: node.detail,
      documentation: markupToText(node.documentation) || undefined,
      insertText,
      filterText: node.filterText,
      sortText: node.sortText,
      range: node.textEdit?.range
        ? rangeFromLsp(node.textEdit.range)
        : (node.textEdit as { insert?: LspRange })?.insert
          ? rangeFromLsp((node.textEdit as { insert: LspRange }).insert)
          : fallbackRange,
    });
  }
  return { suggestions };
}

/** completion 的 label 可能是字符串，也可能是 `{ label, description }`。 */
function labelOf(label: unknown): string {
  if (typeof label === "string") return label;
  if (label && typeof label === "object") {
    const value = (label as { label?: unknown }).label;
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * LSP `CompletionItemKind` → Monaco `CompletionItemKind`。
 *
 * 不能像 `SymbolKind` 那样减一：两边顺序不一样（LSP 里 Text=1、Method=2、Class=7，
 * Monaco 里 Method=0、Class=5、Text=18）。按 LSP 的 1…25 逐条对着写下标。
 */
const COMPLETION_KIND_BY_LSP: monaco.languages.CompletionItemKind[] = [
  monaco.languages.CompletionItemKind.Text, // 1
  monaco.languages.CompletionItemKind.Method, // 2
  monaco.languages.CompletionItemKind.Function, // 3
  monaco.languages.CompletionItemKind.Constructor, // 4
  monaco.languages.CompletionItemKind.Field, // 5
  monaco.languages.CompletionItemKind.Variable, // 6
  monaco.languages.CompletionItemKind.Class, // 7
  monaco.languages.CompletionItemKind.Interface, // 8
  monaco.languages.CompletionItemKind.Module, // 9
  monaco.languages.CompletionItemKind.Property, // 10
  monaco.languages.CompletionItemKind.Unit, // 11
  monaco.languages.CompletionItemKind.Value, // 12
  monaco.languages.CompletionItemKind.Enum, // 13
  monaco.languages.CompletionItemKind.Keyword, // 14
  monaco.languages.CompletionItemKind.Snippet, // 15
  monaco.languages.CompletionItemKind.Color, // 16
  monaco.languages.CompletionItemKind.File, // 17
  monaco.languages.CompletionItemKind.Reference, // 18
  monaco.languages.CompletionItemKind.Folder, // 19
  monaco.languages.CompletionItemKind.EnumMember, // 20
  monaco.languages.CompletionItemKind.Constant, // 21
  monaco.languages.CompletionItemKind.Struct, // 22
  monaco.languages.CompletionItemKind.Event, // 23
  monaco.languages.CompletionItemKind.Operator, // 24
  monaco.languages.CompletionItemKind.TypeParameter, // 25
];

function completionKind(kind: number | undefined): monaco.languages.CompletionItemKind {
  if (kind === undefined) return monaco.languages.CompletionItemKind.Text;
  return COMPLETION_KIND_BY_LSP[kind - 1] ?? monaco.languages.CompletionItemKind.Text;
}

/**
 * 发一条以当前 model 为目标的请求。
 *
 * 只对已经 didOpen 的文档发：协议要求请求前文档必须已打开，比对面板那两份
 * `inmemory://` 模型（`DiffPane` 建的，没经过 didOpen）也走同一个 provider，
 * 不挡就会拿一个 server 不认识的 URI 去问，回一堆错。
 */
async function serverRequest(
  model: monaco.editor.ITextModel,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  // 只认 file:// 的真实文件；虚拟 URI 一律不发。
  if (model.uri.scheme !== "file") return null;
  const entry = serverForLanguage(current, model.getLanguageId());
  if (!entry) return null;
  // 同一个 server 可能有多条会话（monorepo 每个子根一条），按这份文件落在哪个根里挑，
  // 嵌套命中时取最深的那条。
  const owners = [...running.values()].filter(
    (item) => item.entry.id === entry.id && pathWithin(item.root, model.uri.fsPath)
  );
  if (owners.length === 0) return null;
  const server = owners.reduce((best, item) =>
    item.root.length > best.root.length ? item : best
  );
  // 用 model 自己的 uri 串：它就是建 model 与发 didOpen 时用的那条，键天然对得上。
  const uri = model.uri.toString();
  if (!server.opened.has(uri)) return null;
  return request(server, method, { textDocument: { uri }, ...params });
}

/** LSP hover → Monaco hover。 */
function hoverFromLsp(result: unknown): monaco.languages.Hover | null {
  if (!result || typeof result !== "object") return null;
  const contents = (result as { contents?: unknown }).contents;
  const text = markupToText(contents);
  if (!text) return null;
  const range = (result as { range?: LspRange }).range;
  return {
    contents: [{ value: text }],
    range: range ? rangeFromLsp(range) : undefined,
  };
}

/** LSP 的 contents 可能是字符串、{value}，或它们的数组。 */
function markupToText(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(markupToText).filter(Boolean).join("\n\n");
  if (contents && typeof contents === "object") {
    const value = (contents as { value?: unknown }).value;
    if (typeof value === "string") return value;
  }
  return "";
}

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

function rangeFromLsp(range: LspRange): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/** LSP definition → Monaco location（可能是单个、数组，或 null）。 */
function locationsFromLsp(result: unknown): monaco.languages.Location[] | null {
  if (!result) return null;
  const items = Array.isArray(result) ? result : [result];
  const out: monaco.languages.Location[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const loc = item as { uri?: string; range?: LspRange; targetUri?: string; targetRange?: LspRange };
    const uri = loc.uri ?? loc.targetUri;
    const range = loc.range ?? loc.targetRange;
    if (!uri || !range) continue;
    out.push({ uri: monaco.Uri.parse(uri), range: rangeFromLsp(range) });
  }
  return out.length > 0 ? out : null;
}

/** LSP documentSymbol → Monaco SymbolInformation。递归展开子节点。 */
function symbolsFromLsp(result: unknown): monaco.languages.DocumentSymbol[] {
  if (!Array.isArray(result)) return [];
  const out: monaco.languages.DocumentSymbol[] = [];
  for (const item of result) {
    if (!item || typeof item !== "object") continue;
    const node = item as {
      name?: string;
      kind?: number;
      range?: LspRange;
      selectionRange?: LspRange;
      location?: { range?: LspRange };
      children?: unknown[];
    };
    const range = node.range ?? node.location?.range;
    if (!range) continue;
    out.push({
      name: node.name ?? "",
      detail: "",
      kind: symbolKind(node.kind),
      tags: [],
      range: rangeFromLsp(range),
      selectionRange: rangeFromLsp(node.selectionRange ?? range),
      children: symbolsFromLsp(node.children ?? []),
    });
  }
  return out;
}

/**
 * LSP 的 `SymbolKind` 从 1 起（File=1…TypeParameter=26），Monaco 的从 0 起（File=0…TypeParameter=25），
 * 两边一一对应。直接强转会整体错一格，所以减一。
 */
function symbolKind(kind: number | undefined): monaco.languages.SymbolKind {
  const last = monaco.languages.SymbolKind.TypeParameter;
  if (kind === undefined || kind < 1 || kind - 1 > last) {
    return monaco.languages.SymbolKind.Variable;
  }
  return (kind - 1) as monaco.languages.SymbolKind;
}

/**
 * 关掉某个语言的内置语义。只对 typescript 有实际作用——它内置了 tsserver，
 * 开着会和外部 LSP 同时弹 hover、同时出诊断。`builtin` 档不调这里。
 */
function disableBuiltin(language: string): void {
  const defaults =
    language === "typescript"
      ? monaco.typescript.typescriptDefaults
      : language === "javascript"
        ? monaco.typescript.javascriptDefaults
        : null;
  if (!defaults) return;
  defaults.setModeConfiguration({
    completionItems: false,
    hovers: false,
    definitions: false,
    references: false,
    rename: false,
    diagnostics: false,
    documentSymbols: false,
    signatureHelp: false,
    documentHighlights: false,
    codeActions: false,
  });
}

/** 把内置语义恢复到默认（全开）。切回 builtin / off 时用。 */
function enableBuiltin(language: string): void {
  const defaults =
    language === "typescript"
      ? monaco.typescript.typescriptDefaults
      : language === "javascript"
        ? monaco.typescript.javascriptDefaults
        : null;
  if (!defaults) return;
  defaults.setModeConfiguration({
    completionItems: true,
    hovers: true,
    definitions: true,
    references: true,
    rename: true,
    diagnostics: true,
    documentSymbols: true,
    signatureHelp: true,
    documentHighlights: true,
    codeActions: true,
  });
}

/** 每种语言当前的内置语义开关状态，避免每次 reconcile 都白改一遍（改会触发语言服务重算）。 */
const builtinState = new Map<string, "on" | "off">();

/**
 * 按配置同步内置语义的开关。每种语言算一遍：
 * `lsp` 档关内置，`builtin` / `off` 档恢复内置。
 * 只有 ts / js 有内置语义可切，别的语言这一步是空转。状态没变就不动。
 */
function configureBuiltin(config: LspConfig): void {
  for (const entry of serverEntries(config)) {
    const wanted = entry.mode === "lsp" ? "off" : "on";
    for (const language of entry.languages) {
      if (builtinState.get(language) === wanted) continue;
      builtinState.set(language, wanted);
      if (wanted === "off") disableBuiltin(language);
      else enableBuiltin(language);
    }
  }
}

/**
 * 主入口：把当前工作区、设置、打开的文档对到语言服务上。幂等，随便调多少次。
 *
 * 做四件事：该起的 server 起起来、不该留的停掉、文档按增删改发 didOpen / didChange / didClose、
 * 内置语义的开关跟着设置走。App 在文档列表、工作区或设置变化时调用即可。
 *
 * 它是异步的，而调用方在每次击键都会触发一次，所以外面套一个「最新优先」的合并队列：
 * 正在跑的时候再来的调用只更新待办参数，不并排跑第二遍。少了这层，两次 reconcile 会交叉执行，
 * 同一份文档可能被并发 didOpen，或者进程刚起一半又被另一遍收掉。
 */
export function reconcileLsp(
  root: string | null,
  config: LspConfig,
  documents: LspDocument[]
): Promise<void> {
  pending = { root, config, documents };
  if (!draining) {
    draining = drain().finally(() => {
      draining = null;
    });
  }
  return draining;
}

let pending: { root: string | null; config: LspConfig; documents: LspDocument[] } | null = null;
let draining: Promise<void> | null = null;

/** 反复取走最新的待办参数跑一遍，直到没有新的进来。 */
async function drain(): Promise<void> {
  while (pending) {
    const todo = pending;
    pending = null;
    await reconcileOnce(todo.root, todo.config, todo.documents);
  }
}

async function reconcileOnce(
  root: string | null,
  config: LspConfig,
  documents: LspDocument[]
): Promise<void> {
  // provider 回调按这份查语言归属，先落地再算会话。
  current = config;
  configureBuiltin(config);
  if (rootsScope !== (root ?? "")) {
    roots.clear();
    rootsScope = root ?? "";
  }

  // 该跑的会话按 (server, 根) 分组：一份文档归它自己那个根管。
  const groups = new Map<string, { entry: LspServerEntry; root: string; docs: LspDocument[] }>();
  for (const document of documents) {
    const entry = serverForLanguage(config, document.language);
    if (!entry || entry.mode !== "lsp") continue;
    const found = await resolveRoot(entry, root, document.path);
    if (!found) {
      // 工程里没有这门语言的技术栈：不启进程，也别每敲一个字都再报一次。
      const miss = sessionKey(entry, root ?? "");
      if (!skipped.has(miss)) {
        skipped.set(miss, {
          detail: `未在项目「${root ?? ""}」中找到该语言的标志文件（${entry.rootMarkers.join(
            " / "
          )}）`,
          retryAt: Number.POSITIVE_INFINITY,
          signature: signature(entry),
        });
      }
      continue;
    }
    const key = sessionKey(entry, found);
    const group = groups.get(key) ?? { entry, root: found, docs: [] };
    group.docs.push(document);
    groups.set(key, group);
  }

  // 不再需要的会话收掉。
  for (const [key, server] of [...running]) {
    if (!groups.has(key)) {
      running.delete(key);
      await lspStop(server.id).catch(() => {});
    }
  }

  // 尚未启动的会话在此启动。跳过标记只在「命令与参数未变化」时继续有效，
  // 用户填写路径或修改参数后会重新尝试。
  for (const [key, group] of groups) {
    if (running.has(key)) continue;
    const skip = skipped.get(key);
    if (skip) {
      if (skip.signature === signature(group.entry) && Date.now() < skip.retryAt) continue;
      skipped.delete(key);
    }
    await startServer(group.entry, group.root);
  }

  // 文档同步：每条会话只管落在它那个根里的文档。
  for (const server of running.values()) {
    syncDocuments(server, groups.get(server.key)?.docs ?? []);
  }
}

/** 一条会话的文档增删改。调用方已经把落在它那个根里的那批传进来，这里不再筛。 */
function syncDocuments(server: RunningServer, mine: LspDocument[]): void {
  // 键一律用规范化 URI 串，跟请求侧（`serverRequest` 用 model 的 uri）对得上。
  // 若这里存原始路径、那里查 `uri.toString()`，Windows 上盘符大小写与分隔符对不上，
  // 请求会被 `opened.has` 挡掉，hover / 补全 / 跳定义全部静默失效。
  const live = new Set(mine.map((document) => toUri(document.path)));

  // 关掉已开但这次不在的。
  for (const uri of [...server.opened.keys()]) {
    if (live.has(uri)) continue;
    notify(server, "textDocument/didClose", { textDocument: { uri } });
    server.opened.delete(uri);
    server.sent.delete(uri);
    // 关标签时 model 常已 dispose，清 marker 要判一下，否则会在这个已死的 model 上写。
    const model = findModelByUri(uri);
    if (model) monaco.editor.setModelMarkers(model, DIAGNOSTIC_OWNER, []);
  }

  for (const document of mine) {
    const uri = toUri(document.path);
    const sentText = server.sent.get(uri);
    if (sentText === undefined) {
      const version = ++server.version;
      notify(server, "textDocument/didOpen", {
        textDocument: { uri, languageId: document.language, version, text: document.text },
      });
      server.opened.set(uri, version);
      server.sent.set(uri, document.text);
      continue;
    }
    if (sentText !== document.text) {
      const version = ++server.version;
      notify(server, "textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: document.text }],
      });
      server.opened.set(uri, version);
      server.sent.set(uri, document.text);
    }
  }
}

/** 「启动」按钮的结果：失败时把原始原因带回去，界面上要能照着排查，不能只说一句「无法启动」。 */
export interface WakeResult {
  /** started 已启动；running 已在运行；off 该项没启用外部档；no-root 项目里没有该语言的标志文件；failed 后端或握手报错。 */
  state: "started" | "running" | "off" | "no-root" | "failed";
  /** 使用或本拟使用的项目根。 */
  root?: string;
  /** no-root 时列出找过的标志文件名。 */
  markers?: string[];
  /** failed 时是后端原始错误串（错误码 + 分隔符 + 明细），界面按码翻译并原样可复制。 */
  detail?: string;
}

/**
 * 让某个 server 立刻在项目里跑起来，不等用户打开它管理的语言。
 *
 * 必须走 `startServer`：绕过它自行 spawn 的会话不在 `running` 表里，没人发 initialize 也没人发 didOpen，
 * 会成为无人回收的孤儿进程。启动完成后再执行一次文档对档，握手结束即可工作。
 */
export async function wakeLsp(
  workspaceRoot: string,
  config: LspConfig,
  serverId: string,
  documents: LspDocument[]
): Promise<WakeResult> {
  const entry = serverEntries(config).find((item) => item.id === serverId);
  if (!entry || entry.mode !== "lsp") return { state: "off" };
  if ([...running.values()].some((server) => server.entry.id === entry.id))
    return { state: "running" };
  // 没有文件可依据，就按「这个项目里有没有这门语言」问一次：从工作区根向下扫描标志文件。
  // 这条命令本身失败也要报出来，不能和被「没有标志文件」混成同一种说法。
  const hit = await lspResolveRoot(entry.id, workspaceRoot, null).catch((cause: unknown) => {
    const detail = typeof cause === "string" ? cause : String(cause);
    return { error: detail } as const;
  });
  if (!hit) {
    const miss = sessionKey(entry, workspaceRoot);
    const detail =
      skipped.get(miss)?.detail ??
      `未在项目「${workspaceRoot}」中找到标志文件（${entry.rootMarkers.join(" / ")}）`;
    return { state: "no-root", root: workspaceRoot, markers: entry.rootMarkers, detail };
  }
  if ("error" in hit) return { state: "failed", detail: hit.error, root: workspaceRoot };
  const failure = await startServer(entry, hit.root);
  if (failure) return { state: "failed", detail: failure, root: hit.root };
  await reconcileLsp(workspaceRoot, config, documents);
  return { state: "started", root: hit.root };
}

/** 收掉所有会话：换工作区、退出时调。 */
export async function shutdownLsp(): Promise<void> {
  const all = [...running.values()];
  running.clear();
  skipped.clear();
  roots.clear();
  rootsScope = "";
  inflight.clear();
  pending = null;
  owners.clear();
  logs.clear();
  orphans.clear();
  // providersRegistered 不清：provider 一旦注册就撤不掉（monaco 只在 dispose 时移除），
  // 清掉只会让下次 reconcile 又注册一遍，同一个语言就挂上两份 provider，hover 弹两次。
  detachMessage?.();
  detachExit?.();
  detachLog?.();
  detachMessage = null;
  detachExit = null;
  detachLog = null;
  subscribed = false;
  for (const server of all) await lspStop(server.id).catch(() => {});
}
