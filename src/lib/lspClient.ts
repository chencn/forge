import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { lspFailed, lspResolveRoot, lspStart, lspStop, lspWrite } from "./lsp";
import type { LspExit, LspLog, LspMessage } from "./lsp";
import {
  loadProjectLspConfig,
  mergeProjectLspConfig,
  programOf,
  serverEnabled,
  serverCandidates,
  serverEntries,
} from "./lspConfig";
import type { LspConfig, LspServerEntry } from "./lspConfig";
import { canonicalPath, parentPath, pathWithin } from "./format";
import { translate } from "../i18n";
import { windowLabel } from "./window";
import { pathToUri, uriToPath } from "./lspUri";
import { parseLspMessage, positionEncodingOf } from "./lspProtocol";
import type {
  LspDiagnostic,
  LspDocument,
  LspPositionEncoding,
  LspRequestOptions,
  LspServerCapabilities,
  LspStatus,
  LspWakeResult,
  LspApplyEditResult,
  LspWorkspaceEdit,
  LspWorkspaceEditContext,
  LspWorkspaceEditHandler,
  LspSaveReason,
  LspRouteInfo,
} from "./lspTypes";

export type { LspDiagnostic, LspDocument } from "./lspTypes";

/**
 * 一份要交给语言服务的文档快照。
 *
 * 由调用方（App）每次从文档列表里挑出「已加载、可编辑、语言归某个 server 管」的那些喂进来，
 * 客户端不认识文档模型本身的其它字段。
 */
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
  /** 防抖中的 didChange：URI → 计时器与待发文本。窗口内连续击键只在尾部发一次。 */
  pendingChanges: Map<string, { timer: ReturnType<typeof setTimeout>; text: string }>;
  /** 下一个要用的文档版本号，LSP 只要求它单调递增。 */
  version: number;
  /** initialize 返回的能力，供编辑器和 Action 判断可用性。 */
  capabilities: LspServerCapabilities;
  /** initialize 的静态能力；动态注册变化时从这份基线重新派生公开快照。 */
  staticCapabilities: LspServerCapabilities;
  /** server 通过 client/registerCapability 注册的能力，键是注册 id。 */
  dynamicRegistrations: Map<string, { method: string; registerOptions?: unknown }>;
  /** initialize 协商出的文档位置编码。未返回时按 LSP 规范使用 UTF-16。 */
  positionEncoding: LspPositionEncoding;
}

const running = new Map<string, RunningServer>();
/** 手动「启动」拉起的会话：reconcile 不因当前没有该语言的打开文档就把它们收掉。 */
const manualSessions = new WeakSet<RunningServer>();
/**
 * 最近一次 reconcile 用到的那份配置。
 * 编辑器那侧的调用只交语言 id（补全、悬停、跳转都是），语言归哪个 server 管要按当前配置查。
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
/**
 * 跳过标记的上限。键里带着「文件所在目录」，一个工程里没装这门语言的目录能有几百个，
 * 多个常驻工程加起来就上千条；每条只是一个小字符串，但没理由让它无界地涨。
 * 超限时先清过期的（过期条目本来也要重新判定），还超就整张重开。
 */
const SKIPPED_LIMIT = 512;

function rememberSkip(
  key: string,
  entry: { detail: string; retryAt: number; signature: string }
): void {
  skipped.set(key, entry);
  if (skipped.size <= SKIPPED_LIMIT) return;
  const now = Date.now();
  for (const [held, item] of skipped) {
    if (now >= item.retryAt) skipped.delete(held);
  }
  if (skipped.size > SKIPPED_LIMIT) skipped.clear();
}
/** 根解析的备忘：同一次编辑里同一个目录不再问后端一遍。键已含 workspaceRoot 与 dir，带 TTL。 */
const roots = new Map<string, { root: string | null; at: number }>();
/** 后端事件只订阅一次。 */
let detachMessage: UnlistenFn | null = null;
let detachExit: UnlistenFn | null = null;
let detachLog: UnlistenFn | null = null;
/** 同步哨兵：订阅是否已经发起（与 detachMessage 是否已赋值无关）。 */
let subscribed = false;
/** 会话键的分隔符：server 名与路径里都不会出现的字符。 */
const KEY_SEP = String.fromCharCode(1);
/** 待发出的请求 id，用来把响应配回请求。 */
let nextId = 1;
/** 还没收到响应的请求：id → 回调解法。 */
const inflight = new Map<
  number,
  {
    resolve: (result: unknown) => void;
    reject: (cause: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
    cleanup: () => void;
  }
>();
/**
 * 普通请求的超时，按方法分档（对齐 openidea `lib.rs:56-58` 的 5 / 10 / 30 秒）：
 * 打字路径上的补全只给 5 秒——超过这时间再弹出来也没人用了；引用、重命名、执行命令
 * 要遍历整个工程，给 30 秒；其余 10 秒。
 *
 * 原来一刀 60 秒：server 半死（活着但不回话）时 hover / 补全 / 跳定义会挂满一分钟，
 * 期间界面什么都不动。initialize 有自己的握手超时，不受这里影响。
 */
const FAST_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const LONG_TIMEOUT_MS = 30_000;

/** 打字路径上的请求，晚到就没意义了。 */
const FAST_METHODS = new Set(["textDocument/completion", "textDocument/inlineCompletion"]);
/** 全工程级别的请求，慢是正常的。 */
const LONG_METHODS = new Set([
  "textDocument/references",
  "textDocument/rename",
  "workspace/executeCommand",
  "workspace/willRenameFiles",
]);

function timeoutOf(method: string): number {
  if (FAST_METHODS.has(method)) return FAST_TIMEOUT_MS;
  if (LONG_METHODS.has(method)) return LONG_TIMEOUT_MS;
  return DEFAULT_TIMEOUT_MS;
}
/** didChange 的防抖窗口：把每次击键触发的 reconcile 合并成窗口尾部的一次发送。 */
const CHANGE_DEBOUNCE_MS = 150;

/**
 * LSP 动态注册的方法到公开 capability 字段的映射。
 *
 * 表里只留真的有消费点的能力：没有消费点的那种（fold 折叠、selectionRange、颜色选择、
 * pull diagnostics、文档高亮、按类型格式化等）一律不映射——塞进去只会让能力表出现
 * 「界面以为有、点下去没人应」的假字段。未知方法仍然应答，只是不伪造能力。
 */
const DYNAMIC_CAPABILITY_BY_METHOD: Record<string, keyof LspServerCapabilities> = {
  "textDocument/completion": "completionProvider",
  "textDocument/hover": "hoverProvider",
  "textDocument/signatureHelp": "signatureHelpProvider",
  "textDocument/declaration": "declarationProvider",
  "textDocument/definition": "definitionProvider",
  "textDocument/typeDefinition": "typeDefinitionProvider",
  "textDocument/implementation": "implementationProvider",
  "textDocument/references": "referencesProvider",
  "textDocument/rename": "renameProvider",
  "textDocument/codeAction": "codeActionProvider",
  "textDocument/documentFormatting": "documentFormattingProvider",
  "textDocument/documentSymbol": "documentSymbolProvider",
  "textDocument/semanticTokens": "semanticTokensProvider",
  "textDocument/codeLens": "codeLensProvider",
  "textDocument/inlineCompletion": "inlineCompletionProvider",
  "textDocument/documentLink": "documentLinkProvider",
  "workspace/symbol": "workspaceSymbolProvider",
  "callHierarchy/incomingCalls": "callHierarchyProvider",
  "callHierarchy/outgoingCalls": "callHierarchyProvider",
  "textDocument/prepareCallHierarchy": "callHierarchyProvider",
  "typeHierarchy/supertypes": "typeHierarchyProvider",
  "typeHierarchy/subtypes": "typeHierarchyProvider",
  "typeHierarchy/prepare": "typeHierarchyProvider",
  "workspace/executeCommand": "executeCommandProvider",
};

/** 语言服务状态变化的通知，界面据此显示「正在启动 / 未找到」。 */
type StatusWatcher = (serverId: string, status: LspStatus, detail?: string) => void;
const statusWatchers = new Set<StatusWatcher>();
let workspaceEditHandler: LspWorkspaceEditHandler | null = null;

/** 注册 WorkspaceEdit 执行器；返回的函数只撤销本次注册。 */
export function setWorkspaceEditHandler(handler: LspWorkspaceEditHandler | null): () => void {
  workspaceEditHandler = handler;
  return () => {
    if (workspaceEditHandler === handler) workspaceEditHandler = null;
  };
}

export function applyWorkspaceEdit(
  edit: LspWorkspaceEdit,
  context?: LspWorkspaceEditContext
): Promise<LspApplyEditResult> {
  return workspaceEditHandler
    ? workspaceEditHandler(edit, context)
    : Promise.resolve({ applied: false, failureReason: "WorkspaceEdit 执行器未注册" });
}

function emitStatus(serverId: string, status: LspStatus, detail = "") {
  for (const watch of statusWatchers) watch(serverId, status, detail);
}

/**
 * 每个会话上还没结束的 `$/progress` 令牌。有令牌就说明它在索引 / 分析，
 * 状态栏据此把「运行中」画成「索引中」——不靠猜时间，服务说忙才是忙。
 */
const activeProgress = new Map<string, Set<string>>();
const busyListeners = new Set<() => void>();
/** 快照：只在忙闲真的变了时换新对象，React 那边据此判断要不要重渲染。 */
let busySnapshot: ReadonlySet<string> = new Set();

function publishBusy(sessionId: string): void {
  const busy = (activeProgress.get(sessionId)?.size ?? 0) > 0;
  if (!busy) activeProgress.delete(sessionId);
  if (busy === busySnapshot.has(sessionId)) return;
  const next = new Set(busySnapshot);
  if (busy) next.add(sessionId);
  else next.delete(sessionId);
  busySnapshot = next;
  for (const listener of busyListeners) listener();
}

/** 跟踪 `$/progress`：`begin` 记下令牌、`end` 划掉，令牌清空就是不忙了（对齐 openidea `handler.rs:30-60`）。 */
function trackProgress(sessionId: string, params: unknown): void {
  const { token, kind } = progressOf(params);
  if (token === null || kind === null) return;
  if (kind === "end") {
    activeProgress.get(sessionId)?.delete(token);
    publishBusy(sessionId);
    return;
  }
  // `report` 不改忙闲：没有对应 `begin` 的孤零零 report（有的服务会这么发）不该让它永远显示忙。
  if (kind !== "begin") return;
  const tokens = activeProgress.get(sessionId) ?? new Set<string>();
  tokens.add(token);
  activeProgress.set(sessionId, tokens);
  publishBusy(sessionId);
}

/** `$/progress` 的令牌与阶段；形状不对的一律当没看见。 */
function progressOf(params: unknown): { token: string | null; kind: "begin" | "report" | "end" | null } {
  if (!params || typeof params !== "object") return { token: null, kind: null };
  const token = (params as { token?: unknown }).token;
  const kind = (params as { value?: { kind?: unknown } }).value?.kind;
  return {
    token:
      typeof token === "string" || typeof token === "number"
        ? String(token)
        : null,
    kind: kind === "begin" || kind === "report" || kind === "end" ? kind : null,
  };
}

/** 会话没了：把它从忙表里划掉，别让 id 越攒越多。 */
export function forgetBusy(sessionId: string): void {
  if (!activeProgress.delete(sessionId)) return;
  publishBusy(sessionId);
}

/** 正在索引 / 分析的会话 id。 */
export function busySessionIds(): ReadonlySet<string> {
  return busySnapshot;
}

/** 订阅忙闲变化；返回退订函数。 */
export function subscribeBusy(listener: () => void): () => void {
  busyListeners.add(listener);
  return () => {
    busyListeners.delete(listener);
  };
}

/** 从 initialize 基线和当前动态注册重建 capability，注销后不会残留幽灵能力。 */
function rebuildCapabilities(server: RunningServer): void {
  const capabilities: LspServerCapabilities = { ...server.staticCapabilities };
  for (const registration of server.dynamicRegistrations.values()) {
    const key = DYNAMIC_CAPABILITY_BY_METHOD[registration.method];
    if (!key) continue;
    capabilities[key] = registration.registerOptions ?? {};
  }
  server.capabilities = capabilities;
}

function dynamicRegistrationError(params: unknown, unregister: boolean): string | null {
  const key = unregister ? "unregisterations" : "registrations";
  const registrations = (params as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(registrations)) return "registrations 必须是数组";
  for (const registration of registrations) {
    if (
      !registration ||
      typeof registration !== "object" ||
      typeof (registration as { id?: unknown }).id !== "string" ||
      typeof (registration as { method?: unknown }).method !== "string"
    ) {
      return "动态注册项缺少 id 或 method";
    }
  }
  return null;
}

/** 应用一批动态注册/注销，并让已有编辑器通过 ready 状态回调重新读取 capability。 */
function applyDynamicRegistration(server: RunningServer, params: unknown, unregister: boolean): string | null {
  const error = dynamicRegistrationError(params, unregister);
  if (error) return error;
  const key = unregister ? "unregisterations" : "registrations";
  const registrations = (params as Record<string, Array<{ id: string; method: string; registerOptions?: unknown }>>)[key]!;
  for (const registration of registrations) {
    if (unregister) {
      server.dynamicRegistrations.delete(registration.id);
    } else {
      server.dynamicRegistrations.set(registration.id, {
        method: registration.method,
        registerOptions: registration.registerOptions,
      });
    }
  }
  rebuildCapabilities(server);
  emitStatus(server.entry.id, "ready");
  return null;
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

/**
 * 会话键：同一份配置在同一个根上只有一条会话。
 *
 * 根先归一化：`D:/app/x` 与 `D:\app\x` 指同一个目录，不归一就会各起一条会话——
 * 同目录重复进程、诊断与补全各算一遍、状态条上出现两个同名的语言服务。
 */
function sessionKey(entry: LspServerEntry, root: string): string {
  return `${entry.id}${KEY_SEP}${canonicalPath(root)}`;
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
  // 后端按原样路径回根，同一目录可能给出 `D:/x` 或 `D:\x` 两种写法；归一化后再当会话身份，
  // 否则同目录会被当成两个工程根，各起一条会话（状态条上出现两个同名语言服务）。
  const root = hit?.root ? canonicalPath(hit.root) : null;
  rememberRoot(memo, root);
  return root;
}

/**
 * 根解析备忘的条目上限。
 *
 * 键里带着文件所在目录：一个 monorepo 里散落几百个目录、再加上多个常驻工程，
 * 这张表会一路涨下去。过期的条目本身已经没人会读（TTL 到了就重新问后端），
 * 所以超限时先把过期的清掉，还超就整张重开——最坏只是多问几趟后端。
 */
const ROOTS_CACHE_LIMIT = 512;

function rememberRoot(memo: string, root: string | null): void {
  roots.set(memo, { root, at: Date.now() });
  if (roots.size <= ROOTS_CACHE_LIMIT) return;
  const now = Date.now();
  for (const [key, item] of roots) {
    if (now - item.at >= ROOTS_TTL) roots.delete(key);
  }
  if (roots.size > ROOTS_CACHE_LIMIT) roots.clear();
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
function request(
  server: RunningServer,
  method: string,
  params: unknown,
  options?: LspRequestOptions
): Promise<unknown> {
  const id = nextId++;
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    let cleanup = () => {};
    // 到点不落就从 inflight 摘掉并报超时：不然 server 半死时每个 hover / 补全都会一直
    // 占着条目，inflight 只涨不落。迟到的响应会因条目已删被 handleMessage 丢弃。
    const timeout = timeoutOf(method);
    const timer = setTimeout(() => {
      inflight.delete(id);
      cleanup();
      reject(new Error(`${method} 超时（${Math.round(timeout / 1000)} 秒无响应）`));
    }, timeout);
    const cancel = () => {
      if (!inflight.has(id)) return;
      inflight.delete(id);
      clearTimeout(timer);
      cleanup();
      void lspWrite(
        server.id,
        JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } })
      ).catch(() => {});
      const error = new Error(`${method} 已取消`);
      Object.assign(error, { code: "cancelled" });
      reject(error);
    };
    if (options?.signal) {
      options.signal.addEventListener("abort", cancel, { once: true });
      cleanup = () => options.signal?.removeEventListener("abort", cancel);
      if (options.signal.aborted) {
        cancel();
        return;
      }
    }
    inflight.set(id, { resolve, reject, timer, cleanup });
    void lspWrite(server.id, body).catch(() => {
      // 写不进去说明会话已经没了：不等超时，立刻按「没有结果」落地，调用方各自兜底。
      clearTimeout(timer);
      inflight.delete(id);
      cleanup();
      reject(new Error(`${method} 写入失败`));
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
      rootUri: pathToUri(server.root),
      ...(entry.initOptions === null || entry.initOptions === undefined
        ? {}
        : { initializationOptions: entry.initOptions }),
      capabilities: {
          textDocument: {
            // 保存生命周期是客户端主动提供的能力；是否实际调用由服务端的 textDocumentSync 决定。
            synchronization: { willSave: true, willSaveWaitUntil: true, didSave: true, dynamicRegistration: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          // 参数 label 允许用 [start, end] 偏移（gopls / clangd 的默认形态），声明后才会收到偏移版。
          signatureHelp: {
            signatureInformation: {
              documentationFormat: ["markdown", "plaintext"],
              parameterInformation: { labelOffsetSupport: true },
            },
          },
          completion: {
            completionItem: {
              snippetSupport: true,
              // 允许 server 把 detail / 文档 / 自动 import 的附加编辑推迟到 completionItem/resolve 再给。
              resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
              labelDetailsSupport: true,
            },
          },
          inlayHint: { dynamicRegistration: false },
          semanticTokens: {
            dynamicRegistration: false,
            requests: { range: true, full: { delta: false } },
            tokenTypes: [
              "namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter",
              "variable", "property", "enumMember", "event", "function", "method", "macro", "label",
              "comment", "string", "keyword", "number", "regexp", "operator", "decorator",
            ],
            tokenModifiers: [
              "declaration", "definition", "readonly", "static", "deprecated", "abstract", "async",
              "modification", "documentation", "defaultLibrary",
            ],
            formats: ["relative"],
            overlappingTokenSupport: true,
            multilineTokenSupport: true,
          },
          codeLens: { dynamicRegistration: false },
          inlineCompletion: { dynamicRegistration: false },
          documentLink: { dynamicRegistration: false },
          definition: { linkSupport: true },
          references: {},
          rename: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          // 声明版本支持，服务端才会在 publishDiagnostics 里带上 `version`；
          // 收下之后确实按它滤掉过期批次（见 `applyDiagnostics`）。
          publishDiagnostics: { versionSupport: true },
        },
        // 这三条决定服务端怎么拿设置与文件变动，必须如实声明（参照 openidea `caps.rs:38-40`）：
        // `configuration: true` 才收得到 `workspace/configuration`（本客户端的应答见
        // `configurationForSection`）；`didChangeWatchedFiles` 声明 false 是「不接动态注册」，
        // 服务端据此用自己的监听，不是承诺我们会推事件。
        workspace: {
          workspaceFolders: false,
          configuration: true,
          didChangeConfiguration: { dynamicRegistration: false },
          didChangeWatchedFiles: { dynamicRegistration: false, relativePatternSupport: false },
        },
      },
      workspaceFolders: null,
    })
      .then((result) => ({ result, timedOut: false, error: undefined }))
      // 握手时限先落地后，这条迟到 60s 的超时 reject 没人听了——不加 catch 就是
      // 一个 unhandled rejection（server 半死时每次启动都刷一条）。
      .catch((error: unknown) => ({ result: null, timedOut: false, error })),
    new Promise<{ result: unknown; timedOut: boolean; error?: unknown }>((resolve) => {
      setTimeout(() => resolve({ result: null, timedOut: true }), timeout);
    }),
  ]);
  if (settled.timedOut) throw new Error(`initialize 握手超时（${Math.round(timeout / 1000)} 秒）`);
  if (settled.error) throw settled.error;
  const result = settled.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("initialize 响应缺少 capabilities");
  }
  const capabilities = (result as { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new Error("initialize 响应缺少 capabilities");
  }
  server.staticCapabilities = capabilities as LspServerCapabilities;
  server.dynamicRegistrations.clear();
  rebuildCapabilities(server);
  server.positionEncoding = positionEncodingOf(server.capabilities);
  notify(server, "initialized", {});
  // 不问 `workspace/configuration` 的服务只认这一条：把 initializationOptions 当设置再送一遍，
  // 对齐参照（openidea `lib.rs:456-462`）。没配就什么都不发，别拿空对象去覆盖它自己的默认值。
  if (server.entry.initOptions !== undefined && server.entry.initOptions !== null) {
    notify(server, "workspace/didChangeConfiguration", { settings: server.entry.initOptions });
  }
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
    rememberSkip(key, { detail, retryAt: retryFrom(detail), signature: signature(entry) });
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
    pendingChanges: new Map(),
    version: 0,
    capabilities: {},
    staticCapabilities: {},
    dynamicRegistrations: new Map(),
    positionEncoding: "utf-16",
  };
  running.set(key, server);
  skipped.delete(key);
  owners.set(id, entry.id);
  adoptLogs(id, entry.id);
  // 会话 id 会随窗口开久了累积，攒够一批就松开最老的半批。
  if (owners.size > 256) {
    for (const stale of [...owners.keys()].slice(0, 128)) owners.delete(stale);
  }

  try {
    await initialize(server);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "initialize 失败";
    running.delete(key);
    forgetBusy(id);
    // 握手失败时也不能把进程留在内存里：上报后端记录退避，随后回收。
    void lspFailed(id, detail).catch(() => {});
    await lspStop(id).catch(() => {});
    rememberSkip(key, { detail, retryAt: Date.now() + 15_000, signature: signature(entry) });
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
    if (server) void handleMessage(server, event.payload.body);
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
    appendLog(event.payload.id, lspLogLine(event.payload));
    const serverId = ownerOf(event.payload.id);
    if (serverId) console.debug(`[lsp:${serverId}]`, event.payload.text);
  }).then((off) => {
    detachLog = off;
  });
}

/** 后端状态行（kind 为 protocol）的 text 是稳定标记，在此翻成当前语言；server 输出原样保留。 */
function lspLogLine(log: LspLog): string {
  if (log.kind !== "protocol") return log.text;
  return log.text === "read_limit_hit" ? translate("lsp.log.readLimit") : log.text;
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
/**
 * `workspace/configuration` 按 section 取配置：从会话的 initializationOptions 沿点分路径逐级查。
 * 取不到就回空对象——协议要求每项都是对象，但不能再一律回 `{}` 让 vtsls / eslint 的配置静默失效。
 */
function configurationForSection(server: RunningServer, item: unknown): unknown {
  const section = (item as { section?: unknown } | null)?.section;
  if (typeof section !== "string" || !section) return {};
  let current: unknown = server.entry.initOptions;
  for (const part of section.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return {};
    current = (current as Record<string, unknown>)[part];
  }
  return current && typeof current === "object" && !Array.isArray(current) ? current : {};
}

async function handleMessage(server: RunningServer, body: string): Promise<void> {
  const message = parseLspMessage(body);
  if (!message) return;
  if (message.kind === "response") {
    const numericId = typeof message.id === "number" ? message.id : Number(message.id);
    const pending = Number.isFinite(numericId) ? inflight.get(numericId) : undefined;
    if (pending) {
      inflight.delete(numericId);
      clearTimeout(pending.timer);
      pending.cleanup();
      if (message.error) {
        pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      } else {
        pending.resolve(message.result ?? null);
      }
    }
    return;
  }
  if (message.method === "$/progress") {
    trackProgress(server.id, message.params);
    return;
  }
  if (message.method === "textDocument/publishDiagnostics") {
    const params = message.params as { uri?: unknown; diagnostics?: unknown; version?: unknown };
    if (typeof params?.uri === "string" && Array.isArray(params.diagnostics)) {
      applyDiagnostics(server, {
        uri: params.uri,
        diagnostics: params.diagnostics as LspDiagnostic[],
        version: typeof params.version === "number" ? params.version : null,
      });
    }
    return;
  }
  // 少数 server 会发请求回来（`window/workDoneProgress/create`、`workspace/configuration` 等），按协议回复。
  // 允许数字与字符串类型的 id。
  if (message.kind === "request") {
    let result: unknown;
    let error: { code: number; message: string } | undefined;
    if (message.method === "workspace/configuration") {
      // 规范要求返回与请求项长度一致的配置数组，返回 null 会让 server 抛 TypeError。
      // 按 section 从该会话的 initializationOptions 逐级取值；取不到回空对象，不能一律回 [{}] 让配置静默失效。
      const items = (message.params as { items?: unknown[] })?.items;
      result = Array.isArray(items) ? items.map((item) => configurationForSection(server, item)) : [];
    } else if (message.method === "window/workDoneProgress/create") {
      result = null;
    } else if (message.method === "client/registerCapability" || message.method === "client/unregisterCapability") {
      const registrationError = applyDynamicRegistration(
        server,
        message.params,
        message.method === "client/unregisterCapability",
      );
      if (registrationError) {
        error = { code: -32602, message: registrationError };
      } else {
        result = null;
      }
    } else if (message.method === "workspace/applyEdit") {
      const params = message.params as { edit?: unknown } | undefined;
      if (!params?.edit || typeof params.edit !== "object" || Array.isArray(params.edit)) {
        result = { applied: false, failureReason: "WorkspaceEdit 参数无效" };
      } else {
        result = await awaitWorkspaceEdit(server, params.edit as LspWorkspaceEdit);
      }
    } else {
      error = { code: -32601, message: `未实现的 LSP 请求：${message.method}` };
    }
    const response = error
      ? { jsonrpc: "2.0", id: message.id, error }
      : { jsonrpc: "2.0", id: message.id, result };
    void lspWrite(
      server.id,
      JSON.stringify(response)
    ).catch(() => {});
  }
}

/** server request 必须在异步执行器完成后回复，不能先回失败再让编辑落地。 */
function awaitWorkspaceEdit(server: RunningServer, edit: LspWorkspaceEdit): Promise<LspApplyEditResult> {
  const task = workspaceEditHandler
    ? workspaceEditHandler(edit, { positionEncoding: server.positionEncoding, source: server.entry.id })
    : Promise.resolve({ applied: false, failureReason: "WorkspaceEdit 执行器未注册" });
  return task.catch((cause) => ({
    applied: false,
    failureReason: cause instanceof Error ? cause.message : String(cause),
  }));
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
  cancelAllChanges(server);
  forgetDiagnostics(server);
  forgetBusy(server.id);
  emitStatus(server.entry.id, "missing", detail);
}

/**
 * 这条 URI 管的是哪个文件。
 *
 * 服务器回的串与 `didOpen` 发出去的那条常不逐字节相同（盘符大小写、冒号编码与否），
 * 一律过 `uriToPath` + `canonicalPath` 归一，诊断才落得回同一份文档。
 */
function diagnosticsKey(raw: string): string | null {
  const path = uriToPath(raw);
  return path ? canonicalPath(path) : null;
}

/**
 * 诊断的「按文件」缓存与订阅，供编辑器侧落地。
 *
 * 视图随时可能没挂上（后台页签、比对面板），所以原文按路径留一份，编辑器挂载时自己取，
 * 推送时通知订阅者，两条路共用同一份事实，不会出现「server 说了但界面没收到」。
 */
// 路径 → 会话 id → 该会话发布的诊断。一门语言可挂多个 server（tsserver + eslint），
// 各按自己的会话 id 存一份、读取时合并，避免后写的把先写的整体顶掉。
const rawDiagnosticsByPath = new Map<string, Map<string, LspDiagnostic[]>>();
const diagnosticsListeners = new Set<(path: string) => void>();

/** 某文件当前的诊断（LSP 原样，行列都从 0 起）；多 server 的结果合并返回。 */
export function diagnosticsFor(path: string): LspDiagnostic[] {
  const byServer = rawDiagnosticsByPath.get(canonicalPath(path));
  if (!byServer) return [];
  const merged: LspDiagnostic[] = [];
  for (const items of byServer.values()) merged.push(...items);
  return merged;
}

/** 抹掉某会话在某文件上的诊断；该文件已无任何会话诊断时连键一起收走，并通知订阅者。 */
function clearDiagnosticsForKey(key: string, serverId: string): void {
  const byServer = rawDiagnosticsByPath.get(key);
  if (!byServer) return;
  byServer.delete(serverId);
  if (byServer.size === 0) rawDiagnosticsByPath.delete(key);
  notifyDiagnostics(key);
}

/** 订阅诊断变化，回调带文件路径；返回退订。 */
export function onDiagnosticsChange(listener: (path: string) => void): () => void {
  diagnosticsListeners.add(listener);
  return () => {
    diagnosticsListeners.delete(listener);
  };
}

/** 按当前文件选择最深 root 的活动会话，所有编辑器请求和能力查询共用这一规则。 */
function serverForPath(path: string, language: string): RunningServer | null {
  for (const entry of serverCandidates(current, language)) {
    const owners = [...running.values()].filter(
      (item) => item.entry.id === entry.id && pathWithin(item.root, path)
    );
    if (owners.length > 0) {
      return owners.reduce((best, item) => (item.root.length > best.root.length ? item : best));
    }
  }
  return null;
}

export function positionEncodingFor(path: string, language: string): LspPositionEncoding {
  return serverForPath(path, language)?.positionEncoding ?? "utf-16";
}

export function documentVersionFor(path: string, language: string): number | undefined {
  const server = serverForPath(path, language);
  return server?.opened.get(pathToUri(path));
}

export function capabilitiesFor(path: string, language: string): LspServerCapabilities | undefined {
  return serverForPath(path, language)?.capabilities;
}

/**
 * 返回当前文档的实际路由状态。
 *
 * 这条查询只读 `current`、`running` 和 `skipped` 三张内存表，不解析项目文件、
 * 不启动进程，也不改变配置；状态栏可以因此展示与编辑器请求相同的自动识别结果。
 */
export function routeFor(path: string, language: string): LspRouteInfo {
  const active = serverForPath(path, language);
  if (active) {
    return {
      language,
      serverId: active.entry.id,
      root: active.root,
      status: "running",
    };
  }

  const candidates = serverCandidates(current, language);
  if (candidates.length === 0) {
    return { language, serverId: null, root: null, status: "unconfigured" };
  }

  const first = candidates[0]!;
  const prefix = `${first.id}${KEY_SEP}`;
  const failure = [...skipped.entries()].find(([key]) => {
    if (!key.startsWith(prefix)) return false;
    // skipped 的尾部可能是真实 root，也可能是「工作区 root + 目录」的缺根标记；
    // 两种都只在其 root 覆盖当前文件时生效，不能把另一个工程的失败状态串过来。
    const encodedRoot = key.slice(prefix.length);
    const root = encodedRoot.split(KEY_SEP, 1)[0];
    return Boolean(root) && pathWithin(root, path);
  })?.[1];
  return {
    language,
    serverId: first.id,
    root: null,
    status: failure ? "missing" : "starting",
    detail: failure?.detail,
  };
}

function textDocumentSyncOf(server: RunningServer): Record<string, unknown> | null {
  const sync = server.capabilities.textDocumentSync;
  return sync && typeof sync === "object" && !Array.isArray(sync) ? sync as Record<string, unknown> : null;
}

function saveCapabilityOf(server: RunningServer): { willSave: boolean; willSaveWaitUntil: boolean; didSave: boolean; includeText: boolean } {
  const sync = textDocumentSyncOf(server);
  if (!sync) return { willSave: false, willSaveWaitUntil: false, didSave: false, includeText: false };
  const save = sync.save;
  const saveOptions = save && typeof save === "object" && !Array.isArray(save) ? save as Record<string, unknown> : null;
  return {
    willSave: sync.willSave === true,
    willSaveWaitUntil: sync.willSaveWaitUntil === true,
    didSave: save === true || saveOptions !== null,
    includeText: saveOptions?.includeText === true,
  };
}

function saveReasonCode(reason: LspSaveReason): 1 | 2 | 3 {
  return reason === "afterDelay" ? 2 : reason === "focusOut" ? 3 : 1;
}

/** 按服务端声明发送保存前生命周期；等待编辑不会绕过文档版本校验。 */
export async function willSave(
  path: string,
  language: string,
  reason: LspSaveReason
): Promise<import("./lspTypes").LspTextEdit[] | null> {
  const server = serverForPath(path, language);
  if (!server || !server.opened.has(pathToUri(path))) return null;
  const capability = saveCapabilityOf(server);
  const textDocument = { uri: pathToUri(path) };
  // 保存前格式化返回的 edits 坐标基于 server 那份文本，先把排定中的改动冲刷出去才不会错位。
  flushPendingChange(server, path);
  if (capability.willSave || capability.willSaveWaitUntil) {
    notify(server, "textDocument/willSave", { textDocument, reason: saveReasonCode(reason) });
  }
  if (!capability.willSaveWaitUntil) return null;
  const result = await request(server, "textDocument/willSaveWaitUntil", {
    textDocument,
    reason: saveReasonCode(reason),
  });
  return Array.isArray(result) ? result as import("./lspTypes").LspTextEdit[] : null;
}

/** 写盘成功后发送 didSave；仅在服务端声明 save 时发送，避免伪造保存事件。 */
export function didSave(path: string, language: string, text: string): void {
  const server = serverForPath(path, language);
  if (!server || !server.opened.has(pathToUri(path))) return;
  const capability = saveCapabilityOf(server);
  if (!capability.didSave) return;
  const params: { textDocument: { uri: string }; text?: string } = { textDocument: { uri: pathToUri(path) } };
  if (capability.includeText) params.text = text;
  notify(server, "textDocument/didSave", params);
}

function rememberDiagnostics(serverId: string, uri: string, diagnostics: LspDiagnostic[]): string | null {
  const key = diagnosticsKey(uri);
  if (!key) return null;
  if (diagnostics.length) {
    let byServer = rawDiagnosticsByPath.get(key);
    if (!byServer) {
      byServer = new Map();
      rawDiagnosticsByPath.set(key, byServer);
    }
    byServer.set(serverId, diagnostics);
  } else {
    const byServer = rawDiagnosticsByPath.get(key);
    if (byServer) {
      byServer.delete(serverId);
      if (byServer.size === 0) rawDiagnosticsByPath.delete(key);
    }
  }
  return key;
}

function notifyDiagnostics(key: string | null): void {
  if (!key) return;
  for (const listener of diagnosticsListeners) listener(key);
}

function applyDiagnostics(
  server: RunningServer,
  params: { uri: string; diagnostics: LspDiagnostic[]; version: number | null }
): void {
  // 批次比手上这份文档旧就别用：那些行列是按旧正文算的，映射到新正文上会标错地方。
  // 改动之后服务会再推一批新的，这一批丢掉不丢信息。
  if (params.version !== null) {
    const current = server.opened.get(params.uri);
    if (current !== undefined && params.version < current) return;
  }
  notifyDiagnostics(rememberDiagnostics(server.id, params.uri, params.diagnostics));
}

/**
 * 发一条以「某个文件的某个语言」为目标的 LSP 请求，不依赖任何编辑器实例。
 *
 * 只对已经 didOpen 的文档发：协议要求请求前文档必须已打开，比对面板那两份内存里的
 * 虚拟文档没经过 didOpen，不挡就会拿一个 server 不认识的 URI 去问，回一堆错。
 */
export async function lspRequest(
  path: string,
  language: string,
  method: string,
  params: Record<string, unknown>,
  options?: LspRequestOptions
): Promise<unknown> {
  const server = serverForPath(path, language);
  if (!server) return null;
  // 键一律用 pathToUri(path)：它就是 didOpen 时发出去的那条串，两边天然对得上。
  const uri = pathToUri(path);
  if (!server.opened.has(uri)) return null;
  // 编辑后立刻发起的请求要基于最新文本：先把排定中的 didChange 冲刷出去（对齐 IDEA 的 whenAllSynced）。
  flushPendingChange(server, path);
  return request(server, method, { textDocument: { uri }, ...params }, options);
}

/** workspace/symbol、层级后续请求等非 textDocument 请求的统一入口。 */
export async function lspRawRequest(
  path: string,
  language: string,
  method: string,
  params: Record<string, unknown>,
  options?: LspRequestOptions
): Promise<unknown> {
  const server = serverForPath(path, language);
  if (!server) return null;
  flushPendingChange(server, path);
  return request(server, method, params, options);
}

/** 执行 Code Action 返回的 workspace/executeCommand；它不是 textDocument 请求，不能复用上面的包装。 */
export async function executeLspCommand(
  path: string,
  language: string,
  command: string,
  arguments_: unknown[] = []
): Promise<unknown> {
  const server = serverForPath(path, language);
  if (!server) return null;
  // 服务没声明 executeCommandProvider 就没有命令能执行，发出去只会换回一条 MethodNotFound。
  if (!server.capabilities.executeCommandProvider) return null;
  const uri = pathToUri(path);
  if (!server.opened.has(uri)) return null;
  return request(server, "workspace/executeCommand", { command, arguments: arguments_ });
}

/**
 * 主入口：把当前工作区、设置、打开的文档对到语言服务上。幂等，随便调多少次。
 *
 * 做三件事：该起的 server 起起来、不该留的停掉、文档按增删改发 didOpen / didChange / didClose。
 * App 在文档列表、工作区或设置变化时调用即可。
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
    const project = await loadProjectLspConfig(todo.root);
    await reconcileOnce(todo.root, mergeProjectLspConfig(todo.config, project), todo.documents);
  }
}

async function reconcileOnce(
  root: string | null,
  config: LspConfig,
  documents: LspDocument[]
): Promise<void> {
  // `lspRequest` 那边按这份查语言归属，先落地再算会话。
  current = config;

  // 每份文档先按候选顺序选出一条活动会话，再按 (server, 根) 聚合，避免同一 session 重复启动。
  const groups = new Map<string, { entry: LspServerEntry; root: string; docs: LspDocument[] }>();
  for (const document of documents) {
    const selected = await activateDocument(config, root, document);
    if (!selected) continue;
    const key = sessionKey(selected.entry, selected.root);
    const group = groups.get(key) ?? { entry: selected.entry, root: selected.root, docs: [] };
    group.docs.push(document);
    groups.set(key, group);
  }

  // 不再需要的会话收掉；手动「启动」拉起的会话保留（对应状态栏启动按钮的语义）。
  for (const [key, server] of [...running]) {
    if (!groups.has(key) && !manualSessions.has(server)) {
      running.delete(key);
      cancelAllChanges(server);
      forgetDiagnostics(server);
      forgetBusy(server.id);
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

/**
 * 为一份文档选择活动候选：先复用已有会话，再按顺序启动候选。
 * 启动失败只影响这份文档的候选链；调用方仍会按 session key 聚合其它文档。
 */
async function activateDocument(
  config: LspConfig,
  workspaceRoot: string | null,
  document: LspDocument
): Promise<{ entry: LspServerEntry; root: string } | null> {
  const resolved: Array<{ entry: LspServerEntry; root: string; key: string }> = [];
  for (const entry of serverCandidates(config, document.language)) {
    const found = await resolveRoot(entry, workspaceRoot, document.path);
    if (!found) {
      rememberMissingRoot(entry, workspaceRoot, document.path);
      continue;
    }
    resolved.push({ entry, root: found, key: sessionKey(entry, found) });
  }

  // fallback 已经在运行时，不再额外启动主候选；这样配置刷新不会短暂产生两个语义来源。
  const existing = resolved.find((item) => running.has(item.key));
  if (existing) return existing;

  for (const item of resolved) {
    const held = skipped.get(item.key);
    if (held && held.signature === signature(item.entry) && Date.now() < held.retryAt) continue;
    const failure = await startServer(item.entry, item.root);
    if (failure === null && running.has(item.key)) return item;
  }
  return null;
}

/** 根 marker 缺失不应在每次击键时重复探测和报错，沿用现有 TTL 跳过记录。 */
function rememberMissingRoot(
  entry: LspServerEntry,
  workspaceRoot: string | null,
  file: string
): void {
  const dir = parentPath(file) ?? file;
  const miss = sessionKey(entry, `${workspaceRoot ?? ""}${KEY_SEP}${dir}`);
  const held = skipped.get(miss);
  if (held && Date.now() < held.retryAt && held.signature === signature(entry)) return;
  rememberSkip(miss, {
    detail: `未在项目「${workspaceRoot ?? ""}」中找到该语言的标志文件（${entry.rootMarkers.join(
      " / "
    )}）`,
    retryAt: Date.now() + ROOTS_TTL,
    signature: signature(entry),
  });
}

/**
 * 编辑器那侧的语言 id（`languageForPath` 给的）就是对标 IDE 的目录 id，
 * 与 LSP 协议的 languageId 同名（tsx/jsx 已经是独立的 typescriptreact/javascriptreact），
 * 无需再翻译；留这一层是为了协议侧将来单独调整时不牵动识别表。
 */
function lspLanguageId(_filePath: string, language: string): string {
  return language;
}

/**
 * 把一次文档改动排进防抖窗口：窗口内每次 reconcile 只刷新待发文本并重置计时，
 * 到期才用最新的文本发一条 didChange。
 *
 * 每次击键都会触发 reconcile，若每次都把全文发给 server，长文档下 IPC 与 server 的
 * 重解析开销全花在中间态上，诊断反而更慢。防抖只压本地改动的推送频率；
 * didOpen 仍立即发全文，请求类消息（hover / 补全）不经过这里。
 * 版本号在真正发送时才分配，发出的序列保持连续递增。
 */
/** 实发一条 didChange（版本号在此分配）；防抖到期与请求前冲刷共用同一份发送逻辑。 */
function sendDidChange(server: RunningServer, uri: string, text: string): void {
  const version = ++server.version;
  notify(server, "textDocument/didChange", {
    textDocument: { uri, version },
    contentChanges: [{ text }],
  });
  server.opened.set(uri, version);
  server.sent.set(uri, text);
}

/**
 * 立刻把某文档排定中的 didChange 发出去。
 * 请求前（补全 / hover / 跳转 / 保存前格式化）必须先冲刷，否则 server 拿到的文本比编辑器旧，
 * 落点与诊断都会错位——对齐 IDEA 的 `whenAllSynced`。
 */
function flushPendingChange(server: RunningServer, path: string): void {
  const uri = pathToUri(path);
  const held = server.pendingChanges.get(uri);
  if (!held) return;
  clearTimeout(held.timer);
  server.pendingChanges.delete(uri);
  sendDidChange(server, uri, held.text);
}

function scheduleChange(server: RunningServer, uri: string, text: string): void {
  const held = server.pendingChanges.get(uri);
  if (held) clearTimeout(held.timer);
  const timer = setTimeout(() => {
    const pending = server.pendingChanges.get(uri);
    if (!pending) return;
    server.pendingChanges.delete(uri);
    sendDidChange(server, uri, pending.text);
  }, CHANGE_DEBOUNCE_MS);
  server.pendingChanges.set(uri, { timer, text });
}

/** 取消一份文档排定中的 didChange（文档关闭时用，关了再发的改动会被 server 拒收）。 */
function cancelChange(server: RunningServer, uri: string): void {
  const held = server.pendingChanges.get(uri);
  if (!held) return;
  clearTimeout(held.timer);
  server.pendingChanges.delete(uri);
}

/** 清掉一条会话全部排定中的 didChange（会话停止时用）。 */
function cancelAllChanges(server: RunningServer): void {
  for (const uri of [...server.pendingChanges.keys()]) cancelChange(server, uri);
}

/**
 * 会话不再需要时，把它管过的文档的诊断一并摘掉。
 *
 * 这份缓存按文件路径累积、每条都带着完整诊断文本；会话已经收掉之后它就只是残留，
 * 多工程来回切时只涨不落。文档重新打开会重新收到诊断。
 */
function forgetDiagnostics(server: RunningServer): void {
  for (const uri of server.opened.keys()) {
    const key = diagnosticsKey(uri);
    if (key) clearDiagnosticsForKey(key, server.id);
  }
}

/** 一条会话的文档增删改。调用方已经把落在它那个根里的那批传进来，这里不再筛。 */
function syncDocuments(server: RunningServer, mine: LspDocument[]): void {
  // 键一律用 pathToUri 出来的 URI 串，跟请求侧（`lspRequest` 也走 pathToUri）对得上。
  // 若这里存原始路径、那里查编码后的串，Windows 上盘符大小写与分隔符对不上，
  // 请求会被 `opened.has` 挡掉，hover / 补全 / 跳定义全部静默失效。
  const live = new Set(mine.map((document) => pathToUri(document.path)));

  // 关掉已开但这次不在的。
  for (const uri of [...server.opened.keys()]) {
    if (live.has(uri)) continue;
    // 先把排定中的改动取消掉：文档已经关了，到期再发 didChange 会被 server 拒收。
    cancelChange(server, uri);
    notify(server, "textDocument/didClose", { textDocument: { uri } });
    server.opened.delete(uri);
    server.sent.delete(uri);
    const cached = diagnosticsKey(uri);
    if (cached) clearDiagnosticsForKey(cached, server.id);
  }

  for (const document of mine) {
    const uri = pathToUri(document.path);
    const sentText = server.sent.get(uri);
    if (sentText === undefined) {
      const version = ++server.version;
      notify(server, "textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: lspLanguageId(document.path, document.language),
          version,
          text: document.text,
        },
      });
      server.opened.set(uri, version);
      server.sent.set(uri, document.text);
      continue;
    }
    if (sentText !== document.text) {
      // 不立即发：排进防抖窗口，窗口内反复击键只在尾部发一次最新全文。
      scheduleChange(server, uri, document.text);
    } else {
      // 文本与已发的一致（典型是 undo 回去了）：排定中的 didChange 要取消掉，
      // 不然到点仍会把中间态发出去，server 端文本与模型分叉到下一次编辑才对上。
      cancelChange(server, uri);
    }
  }
}

/** 「启动」按钮的结果：失败时把原始原因带回去，界面上要能照着排查，不能只说一句「无法启动」。 */
export type WakeResult = LspWakeResult;

/**
 * 让某个 server 立刻在项目里跑起来，不等用户打开它管理的语言。
 *
 * 必须走 `startServer`：绕过它自行 spawn 的会话不在 `running` 表里，没人发 initialize 也没人发 didOpen，
 * 会成为无人回收的孤儿进程。握手完成后只同步当前 server 能管理的文档，保留手动启动的会话。
 */
export async function wakeLsp(
  workspaceRoot: string,
  config: LspConfig,
  serverId: string,
  documents: LspDocument[]
): Promise<WakeResult> {
  const entry = serverEntries(config).find((item) => item.id === serverId);
  if (!entry || !serverEnabled(entry)) return { state: "off" };
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
  // 同 resolveRoot：后端回的根要归一化，否则和文档路径那条算出的根不是同一个会话键。
  const root = canonicalPath(hit.root);
  // 同一个 server 可以同时服务多个项目；只按 server id 判断会把其它项目的会话
  // 错当成当前项目已启动，状态栏随后也找不到当前文件对应的会话。
  if ([...running.values()].some((server) => server.entry.id === entry.id && server.root === root))
    return { state: "running", root };
  const failure = await startServer(entry, root);
  if (failure) return { state: "failed", detail: failure, root };
  // 手动启动不是一次普通对档：即使当前没有该语言的打开文件，也应保留这条会话，
  // 不能启动后立刻用空文档集合把它收掉。已有文档只同步属于该 server 且落在当前根内的部分。
  const started = running.get(sessionKey(entry, root));
  if (started) {
    manualSessions.add(started);
    syncDocuments(
      started,
      documents.filter(
        (document) => entry.languages.includes(document.language) && pathWithin(root, document.path),
      ),
    );
  }
  return { state: "started", root };
}

/** 收掉所有会话：换工作区、退出时调。 */
export async function shutdownLsp(): Promise<void> {
  const all = [...running.values()];
  // 先把各会话排定中的 didChange 计时器撤掉，再清表：留着它们到点会在空会话上白发消息。
  for (const server of all) {
    cancelAllChanges(server);
    forgetDiagnostics(server);
  }
  running.clear();
  skipped.clear();
  roots.clear();
  inflight.clear();
  pending = null;
  owners.clear();
  logs.clear();
  orphans.clear();
  detachMessage?.();
  detachExit?.();
  detachLog?.();
  detachMessage = null;
  detachExit = null;
  detachLog = null;
  subscribed = false;
  for (const server of all) await lspStop(server.id).catch(() => {});
}
