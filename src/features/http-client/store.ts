/**
 * HTTP 客户端状态：环境、历史、当前选中的一次交换、正在跑的请求。
 *
 * 解析与变量替换在前端 `src/lib/httpFile.ts`（那边是 `.http` 的语言模型），
 * 环境文件、发送与历史在 Rust 的 `src-tauri/src/http`。状态走外部 store（参照
 * `caretStatus.ts` / `notificationStore.ts`），因为工具窗口之外的编辑器装订线也会
 * 触发请求，不必牵动 App 的渲染树。
 */
import { invoke } from "@tauri-apps/api/core";
import { parentPath } from "../../lib/format";
import { codedError } from "../../lib/errors";
import { errorText } from "../../lib/fs";
import {
  createHttpRunSession,
  executeHttpRequest,
  httpRequestLabel,
  HttpExchangeError,
  isHttpCancelled,
  parseHttpFile,
  toHttpResult,
  type HttpExchange,
  type HttpHistoryEntry,
  type HttpResult,
  type HttpRunSession,
} from "../../lib/httpFile";

export type { HttpExchange, HttpHistoryEntry } from "../../lib/httpFile";

/** 工具窗口在 App 面板块编排里的 id。 */
export const HTTP_CLIENT_VIEW = "httpClient";

export interface HttpClientState {
  /** 每个文件可用的环境名（按路径，分屏同时开两个 `.http` 时各认各的）。 */
  environments: Record<string, string[]>;
  /** 每个文件选中的环境（按路径）。 */
  envByFile: Record<string, string | null>;
  /** 历史条目，最新在前。 */
  history: HttpHistoryEntry[];
  /** 工具窗口右侧展示的那一次交换。 */
  exchange: HttpExchange | null;
  /** 已经取回的交换，按历史 id。再点同一条不必重拉。 */
  exchanges: Record<string, HttpExchange>;
  /** 左侧选中的历史 id。详情还在路上时只有它，用来转圈。 */
  selected: string | null;
  /** 正在发送的请求。`path` 用来把停止按钮限定在发起它的那个文件。 */
  running: { id: string; label: string; path: string | null } | null;
  /** 换工作区时递增。编辑器工具栏只盯着路径，靠它重读新项目的环境。 */
  rootEpoch: number;
}

/** 环境选择按文件记在 localStorage，跨会话保留。 */
const ENV_KEY = "forge:http-client:environments";

/** 当前工作区根；命令需要它来定位环境文件与历史分桶。 */
let root: string | null = null;

function readEnvChoices(): Record<string, string | null> {
  try {
    const text = localStorage.getItem(ENV_KEY);
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    if (parsed && typeof parsed === "object") return parsed as Record<string, string | null>;
  } catch {
    // 存坏了就当没选过。
  }
  return {};
}

function writeEnvChoices(choices: Record<string, string | null>): void {
  try {
    localStorage.setItem(ENV_KEY, JSON.stringify(choices));
  } catch {
    // 隐私模式等写不进去：只在本次会话生效。
  }
}

let state: HttpClientState = {
  environments: {},
  envByFile: readEnvChoices(),
  history: [],
  exchange: null,
  exchanges: {},
  selected: null,
  running: null,
  rootEpoch: 0,
};

const listeners = new Set<() => void>();

function changed(): void {
  for (const notify of listeners) notify();
}

function patch(next: Partial<HttpClientState>): void {
  state = { ...state, ...next };
  changed();
}

/** useSyncExternalStore 的订阅入口。 */
export function subscribeHttpClient(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** useSyncExternalStore 的快照。 */
export function httpClientSnapshot(): HttpClientState {
  return state;
}

/** 作废还在飞的历史读取。环境按文件各记一号，换工作区时整表作废。 */
let rootEpoch = 0;
let historySeq = 0;
/** 清空历史或换工作区后，已经发出的详情读取也必须失效。 */
let historyEpoch = 0;
/** 删除后的延迟详情不能重新进入缓存；历史 ID 不会复用。 */
const removedHistoryIds = new Set<string>();
const envSeq = new Map<string, number>();

/** 工作区根变化时由 App 调用；换根要清掉上一个工作区的运行态，并重拉历史。 */
export function setHttpRoot(value: string | null): void {
  if (root === value) return;
  root = value;
  resetHttpClient();
  if (value) refreshHistorySoon();
}

/**
 * 某个文件实际用来发送的环境。
 * 记下的名字已经不在当前环境列表里时当作没选，下拉框回到「无环境」。
 * 列表还没读回来时先保留记下的名字，避免加载过程中闪成空。
 */
export function effectiveEnvironment(path: string | null): string | null {
  if (!path) return null;
  const chosen = state.envByFile[path];
  if (!chosen) return null;
  const available = state.environments[path];
  if (available && !available.includes(chosen)) return null;
  return chosen;
}

export function setEnvironment(path: string, env: string | null): void {
  const envByFile = { ...state.envByFile, [path]: env };
  writeEnvChoices(envByFile);
  patch({ envByFile });
}

/** 快照里读某个文件的环境名；没有就返回同一个空数组，别让 getSnapshot 每次换新引用。 */
const NO_ENVIRONMENTS: string[] = [];

export function environmentsFor(path: string | null): string[] {
  return (path && state.environments[path]) || NO_ENVIRONMENTS;
}

/** 读一个文件可用的环境名。未保存的缓冲（`path` 为 null）只认工作区里的那份。过期的读取直接丢掉。 */
export async function loadEnvironments(path: string | null): Promise<string[]> {
  const epoch = rootEpoch;
  const currentRoot = root;
  const key = path ?? "";
  const seq = (envSeq.get(key) ?? 0) + 1;
  envSeq.set(key, seq);
  const current = () => epoch === rootEpoch && envSeq.get(key) === seq && root === currentRoot;
  try {
    const environments = await invoke<string[]>("http_environments", { path, root: currentRoot });
    if (!current()) return environments;
    patch({ environments: { ...state.environments, [key]: environments } });
    return environments;
  } catch (cause) {
    if (!current()) return [];
    const next = { ...state.environments };
    delete next[key];
    patch({ environments: next });
    throw cause;
  }
}

/** 重新拉取历史列表。过期的读取不能盖住后一次换工作区的结果。 */
export async function refreshHistory(): Promise<void> {
  const seq = ++historySeq;
  const currentRoot = root;
  if (!currentRoot) {
    if (seq === historySeq) patch({ history: [] });
    return;
  }
  const history = await invoke<HttpHistoryEntry[]>("http_history", { root: currentRoot });
  if (seq !== historySeq || root !== currentRoot) return;
  // 历史只留最近若干条。缓存若一直叠着，响应正文会在这次会话里越积越多。
  const keep = new Set(history.map((item) => item.id));
  if (state.selected) keep.add(state.selected);
  const exchanges: Record<string, HttpExchange> = {};
  for (const [id, item] of Object.entries(state.exchanges)) {
    if (keep.has(id)) exchanges[id] = item;
  }
  patch({
    history,
    exchanges,
    exchange: state.selected ? exchanges[state.selected] ?? null : null,
  });
}

/** 没人 await 的历史刷新（换工作区、请求结束）失败时交给界面报出来，避免变成未处理的拒绝。 */
const historyErrors = new Set<(cause: unknown) => void>();

export function subscribeHttpHistoryError(listener: (cause: unknown) => void): () => void {
  historyErrors.add(listener);
  return () => {
    historyErrors.delete(listener);
  };
}

function refreshHistorySoon(): void {
  void refreshHistory().catch((cause) => {
    for (const listener of historyErrors) listener(cause);
  });
}

/** 作废过期的详情读取：连点两条时，先点的那条不能盖住后点的。 */
let selectSeq = 0;

/**
 * 选中历史里某一条。缓存里有就直接展示，否则先转圈再去取。
 *
 * 每次点击都作废还在飞的那次读取：先点一条没缓存的，再点一条已经在手里的，
 * 先点的那次返回时不能把选中改回去。新的发送结果同样作废这次读取，只把正文放进缓存。
 */
export async function selectEntry(id: string): Promise<void> {
  if (removedHistoryIds.has(id)) return;
  const epoch = historyEpoch;
  const seq = ++selectSeq;
  const cached = state.exchanges[id];
  if (cached) {
    patch({ selected: id, exchange: cached });
    return;
  }
  patch({ selected: id, exchange: null });
  if (!root) return;
  try {
    const exchange = await invoke<HttpExchange>("http_history_get", { root, id });
    // 同一工作区换选中项可以复用缓存；已清空或换根的旧详情必须丢弃。
    if (epoch !== historyEpoch || removedHistoryIds.has(id)) return;
    if (seq !== selectSeq || state.selected !== id) {
      patch({ exchanges: { ...state.exchanges, [id]: exchange } });
      return;
    }
    patch({
      selected: id,
      exchange,
      exchanges: { ...state.exchanges, [id]: exchange },
    });
  } catch (cause) {
    if (epoch !== historyEpoch || removedHistoryIds.has(id)) return;
    if (seq === selectSeq && state.selected === id) patch({ selected: null, exchange: null });
    throw cause;
  }
}

export async function clearHistory(): Promise<void> {
  if (!root) return;
  const epoch = rootEpoch;
  await invoke("http_history_clear", { root });
  if (epoch !== rootEpoch) return;
  historyEpoch += 1;
  historySeq += 1;
  selectSeq += 1;
  removedHistoryIds.clear();
  patch({ history: [], exchange: null, exchanges: {}, selected: null });
}

/** 后端确认删除后再更新界面；失败时保留记录和当前选中项。 */
export async function removeHistoryEntry(id: string): Promise<void> {
  if (!root) return;
  const epoch = rootEpoch;
  await invoke("http_history_remove", { root, id });
  if (epoch !== rootEpoch) return;
  removedHistoryIds.add(id);
  historySeq += 1;
  const exchanges = { ...state.exchanges };
  delete exchanges[id];
  patch({
    history: state.history.filter((entry) => entry.id !== id),
    exchanges,
    ...(state.selected === id ? { selected: null, exchange: null } : {}),
  });
}

let runningId: string | null = null;
/** 批次覆盖整轮运行，包括两次发送和结束清理之间的异步间隙。 */
let activeBatch: HttpRunSession | null = null;
/** 已经点过停止的请求 id。读环境或两条依赖之间，后端通道还没建起来，停在这里挡住下一次发送。 */
const cancelledIds = new Set<string>();

function nextRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 环境变量垫在文件变量底下。
 * 没选环境时仍向后端要一份：那边会把 `$shared` 交回来。
 */
async function loadEnvVars(path: string | null): Promise<Record<string, string> | null> {
  if (!root) return null;
  const env = effectiveEnvironment(path);
  return invoke<Record<string, string>>("http_env_variables", { path, root, env });
}

export interface RunArgs {
  /** `.http` 文件路径（未保存的缓冲传 null）。 */
  path: string | null;
  /** 编辑器里的最新正文。 */
  text: string;
  /** 请求行的行号（和装订线 ▶ 对得上）。 */
  line: number;
  /** 正在发送时显示的名字。 */
  label?: string;
  /** 「运行全部」时带上，让具名请求的响应在后续请求里复用。 */
  session?: HttpRunSession;
}

/**
 * 发送 `text` 里 `line` 那一条请求。成功或失败（取消除外）都刷新历史；
 * 取消和别的失败都抛回给调用方，由调用方决定要不要当错误报出来。
 */
export async function runRequest(args: RunArgs): Promise<HttpResult> {
  const currentRoot = root;
  const file = parseHttpFile(args.text);
  const request = file.requests.find((item) => item.line === args.line);
  if (!request) throw new Error("HTTP_INDEX");
  return runTrackedRequest({ ...args, label: args.label ?? httpRequestLabel(request) }, async (id, onExchange) => {
    const envVars = await loadEnvVars(args.path);
    if (cancelledIds.has(id)) throw codedError("HTTP_CANCELLED");
    return executeHttpRequest(file, request, {
      dir: (args.path && parentPath(args.path)) ?? currentRoot ?? "",
      workspace: currentRoot,
      path: args.path,
      requestId: id,
      envVars,
      session: args.session,
      isCancelled: () => cancelledIds.has(id),
      onExchange,
    });
  });
}

/** 重放历史中的实际请求，不重新解析源码或替换变量，也不额外打开编辑器响应页签。 */
export async function retryHistoryEntry(id: string): Promise<HttpResult> {
  const currentRoot = root;
  const cached = state.exchanges[id];
  const entry = cached?.entry ?? state.history.find((item) => item.id === id);
  if (!currentRoot || !entry || removedHistoryIds.has(id)) throw new Error("HTTP_INDEX");
  return runTrackedRequest({ path: entry.file, label: entry.name ?? `${entry.method} ${entry.url}` }, async (requestId, onExchange) => {
    const saved = cached ?? await invoke<HttpExchange>("http_history_get", { root: currentRoot, id });
    if (cancelledIds.has(requestId)) throw codedError("HTTP_CANCELLED");
    if (removedHistoryIds.has(id)) throw new Error("HTTP_INDEX");
    const request = saved.request;
    const exchange = await invoke<HttpExchange>("http_send", {
      requestId,
      path: entry.file,
      root: currentRoot,
      call: {
        name: request.name,
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.bodyBase64 !== undefined
          ? [{ base64: request.bodyBase64 }]
          : request.body === null ? [] : [{ text: request.body }],
      },
    });
    onExchange(exchange);
    return toHttpResult(exchange);
  });
}

/** 编辑器发送和历史重发共用取消、选中、历史刷新及结束清理，避免两条发送路径状态分叉。 */
async function runTrackedRequest(
  args: { path: string | null; label: string; line?: number; session?: HttpRunSession },
  execute: (id: string, onExchange: (exchange: HttpExchange) => void) => Promise<HttpResult>,
): Promise<HttpResult> {
  const epoch = rootEpoch;
  if (args.session !== activeBatch) activeBatch = null;
  cancelCurrentRequest();
  const id = nextRequestId();
  const label = args.label;
  runningId = id;
  patch({ running: { id, label, path: args.path } });
  let started = false;
  try {
    if (args.line !== undefined) {
      presentEditor({ id, path: args.path, line: args.line, label, phase: "start" });
      started = true;
    }
    const result = await execute(id, (exchange) => {
      // 请求可以在切换工作区后才返回，旧交换不能进入当前工作区的状态。
      if (epoch !== rootEpoch) return;
      // 停止或下一条请求已经开始时，这条结果只进历史，不能把选中抢回去。
      const superseded = cancelledIds.has(id) || (state.running !== null && state.running.id !== id);
      if (!superseded) selectSeq += 1;
      patch({
        exchanges: { ...state.exchanges, [exchange.entry.id]: exchange },
        history: [exchange.entry, ...state.history.filter((item) => item.id !== exchange.entry.id)],
        ...(superseded ? {} : { exchange, selected: exchange.entry.id }),
      });
      if (!superseded) revealHttpClient();
    });
    if (cancelledIds.has(id)) throw codedError("HTTP_CANCELLED");
    if (args.line !== undefined) presentEditor({ id, path: args.path, line: args.line, label, phase: "done", result });
    if (epoch === rootEpoch) refreshHistorySoon();
    return result;
  } catch (cause) {
    // 取消优先于稍后到达的网络失败，运行全部不能因此继续下一条。
    const failure = cancelledIds.has(id) ? codedError("HTTP_CANCELLED") : cause;
    const raw = errorText(failure);
    if (started && args.line !== undefined) {
      presentEditor({
        id,
        path: args.path,
        line: args.line,
        label,
        phase: isHttpCancelled(raw) ? "cancelled" : "failed",
        error: raw,
      });
    }
    if (epoch === rootEpoch && !isHttpCancelled(raw)) refreshHistorySoon();
    throw failure;
  } finally {
    cancelledIds.delete(id);
    if (runningId === id) runningId = null;
    if (state.running?.id === id) patch({ running: null });
    // 整轮依赖发送结束后再释放登记；清理失败不能掩盖原请求的结果。
    await invoke("http_finish", { requestId: id }).catch(() => {});
  }
}

/** 依次发送整个文件里的请求；已记录的传输失败不阻断，取消和准备失败立即停止。 */
export async function runAll(path: string | null, text: string): Promise<void> {
  const session = createHttpRunSession();
  const epoch = rootEpoch;
  activeBatch = session;
  const ensureCurrent = () => {
    if (epoch !== rootEpoch || activeBatch !== session) throw codedError("HTTP_CANCELLED");
  };
  try {
    for (const request of parseHttpFile(text).requests) {
      ensureCurrent();
      try {
        await runRequest({ path, text, line: request.line, label: httpRequestLabel(request), session });
      } catch (cause) {
        if (!(cause instanceof HttpExchangeError)) throw cause;
      }
      ensureCurrent();
    }
  } finally {
    if (activeBatch === session) activeBatch = null;
  }
}

export function cancelRunning(): void {
  activeBatch = null;
  cancelCurrentRequest();
}

function cancelCurrentRequest(): void {
  const id = runningId;
  if (!id) return;
  cancelledIds.add(id);
  runningId = null;
  void invoke("http_cancel", { requestId: id });
}

/** 换工作区时清空运行时状态，并停掉还在飞的那一条。 */
export function resetHttpClient(): void {
  activeBatch = null;
  rootEpoch += 1;
  historyEpoch += 1;
  historySeq += 1;
  envSeq.clear();
  removedHistoryIds.clear();
  const id = runningId;
  runningId = null;
  if (id) {
    cancelledIds.add(id);
    void invoke("http_cancel", { requestId: id });
  }
  selectSeq += 1;
  patch({
    environments: {},
    history: [],
    exchange: null,
    exchanges: {},
    selected: null,
    running: null,
    rootEpoch,
  });
}

/** 请求有了结果时通知 App 把 HTTP 客户端弄到眼前。已经开着就保持用户摆好的位置。 */
const revealListeners = new Set<() => void>();

export function subscribeHttpClientReveal(listener: () => void): () => void {
  revealListeners.add(listener);
  return () => {
    revealListeners.delete(listener);
  };
}

function revealHttpClient(): void {
  for (const listener of revealListeners) listener();
}

/**
 * 编辑器里的响应（左右分栏或单独页签）。
 * 单条运行和运行全部都走 `runRequest`，所以在这里通知一次，两条入口不会各写一份。
 */
export interface HttpEditorEvent {
  id: string;
  path: string;
  line: number;
  label: string;
  phase: "start" | "done" | "cancelled" | "failed";
  result?: HttpResult;
  error?: string;
}

const editorListeners = new Set<(event: HttpEditorEvent) => void>();

export function subscribeHttpEditor(listener: (event: HttpEditorEvent) => void): () => void {
  editorListeners.add(listener);
  return () => {
    editorListeners.delete(listener);
  };
}

function presentEditor(event: {
  id: string;
  path: string | null;
  line: number;
  label: string;
  phase: HttpEditorEvent["phase"];
  result?: HttpResult;
  error?: string;
}): void {
  if (!event.path) return;
  const next: HttpEditorEvent = {
    id: event.id,
    path: event.path,
    line: event.line,
    label: event.label,
    phase: event.phase,
    result: event.result,
    error: event.error,
  };
  for (const listener of editorListeners) listener(next);
}
