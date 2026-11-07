/**
 * `.http` 与 `.rest` 共用的请求文件。
 *
 * 语法按 VS Code REST Client 那套（`.http` / `.rest` 同一份）：`###` 分段、`#` 与 `//`
 * 注释、`@name = value` 文件变量、`{{var}}` 替换、请求行 / 请求头 / 空行后的正文、
 * `?` `&` 续行、`# @name` 以及 `{{name.response...}}`。系统变量覆盖 `$guid`、
 * `$timestamp`、`$datetime`、`$randomInt`、`$dotenv`、`$processEnv`。
 * 正文里的 `> {% ... %}` 是响应脚本，不发出去，也不在这里执行。
 *
 * 分工：`.http` 的语言模型（解析 + 变量替换 + 依赖链 + cURL 导入）在这一层，
 * 环境文件（`http-client.env.json`）、发送与响应历史在 Rust 的 `src-tauri/src/http`。
 * 这里只把拼装好的请求交给后端 `http_send`，拿回一条交换记录。
 */
import { invoke } from "@tauri-apps/api/core";
import { codedError } from "./errors";
import { isWindowsPath, joinPath, resolvePath } from "./format";
import { fileStamp, readFile } from "./fs";

/** 一条请求头。 */
export interface HttpHeader {
  name: string;
  value: string;
}

/** `# @prompt` 声明的一个发送前询问。 */
export interface HttpPrompt {
  name: string;
  description: string;
}

/** 文件里的一条 `@name = value` 变量。 */
export interface HttpVariable {
  name: string;
  value: string;
  line: number;
}

/** `.http` 文件里解析出的一条请求。 */
export interface HttpRequest {
  /** 请求行的 1-based 行号，装订线箭头落在这一行。 */
  line: number;
  /**
   * 这一段请求在文件里的范围（1-based，含请求行前后的注释和正文）。
   * 光标落在块内任意一行都应运行这一条，不必正好点在请求行上。
   */
  startLine: number;
  endLine: number;
  /** `# @name` / `// @name`。 */
  name: string | null;
  /** `###` 后面的标题。 */
  title: string | null;
  method: string;
  url: string;
  headers: HttpHeader[];
  body: string;
  prompts: HttpPrompt[];
}

/** 一个解析完的 `.http` 文件：文件变量与请求列表。 */
export interface HttpFile {
  variables: HttpVariable[];
  requests: HttpRequest[];
}

/** 请求正文的一段：文本或文件引用（`< file` / `<@utf-8 file`）。 */
export interface HttpBodyPiece {
  text?: string;
  file?: string;
}

/** 发给后端的一条已经替换完变量的请求。 */
export interface HttpCall {
  /** `# @name` / `###` 标题，只进历史，不参与发送。 */
  name: string | null;
  method: string;
  url: string;
  headers: HttpHeader[];
  body: HttpBodyPiece[];
}

/** 响应预览用的形状（`toHttpResult` 由一次交换收出来）。 */
export interface HttpResult {
  status: number;
  reason: string;
  headers: HttpHeader[];
  body: string;
  binary: boolean;
  truncated: boolean;
  bodyBytes: number;
  elapsedMs: number;
  finalUrl: string;
}

/** 实际发出去的那条请求（后端 `http_send` 的回执）。 */
export interface HttpSentRequest {
  name: string | null;
  method: string;
  url: string;
  headers: [string, string][];
  body: string | null;
  /** 首次发送时补全默认值的请求头；重发仍使用原始 headers。 */
  sentHeaders?: [string, string][];
  /** 非 UTF-8 请求正文的原始字节，仅用于无损重发。 */
  bodyBase64?: string;
}

/** 后端读回来的响应。文本正文为字符串，二进制为 `null`。 */
export interface HttpWireResponse {
  status: number;
  statusText: string;
  version: string;
  headers: [string, string][];
  contentType: string | null;
  body: string | null;
  /** 完整 PDF 响应的原始字节；截断响应不提供可预览数据。 */
  bodyBase64?: string;
  /** 解压后的字节数。 */
  size: number;
  truncated: boolean;
  ttfbMs: number;
  totalMs: number;
  /** 跟随重定向之后的最终地址。 */
  finalUrl: string;
}

/** 历史条目里不含正文的那部分（列表用）。 */
export interface HttpHistoryEntry {
  id: string;
  /** Unix 纪元毫秒。 */
  timeMs: number;
  name: string | null;
  method: string;
  url: string;
  status: number | null;
  totalMs: number | null;
  file: string | null;
  error: string | null;
}

/** 后端 `http_send` / `http_history_get` 的返回：一次请求及其结果。 */
export interface HttpExchange {
  entry: HttpHistoryEntry;
  request: HttpSentRequest;
  response: HttpWireResponse | null;
}

/** 后端 `http_cancel` 回的就是这个码，没有分段符。停止不是失败。 */
export function isHttpCancelled(text: string): boolean {
  return text.split("\u0001")[0] === "HTTP_CANCELLED";
}

/** 已记录的传输失败与准备失败分开，运行全部才能继续后面的独立请求。 */
export class HttpExchangeError extends Error {}

/** 把一次交换收成响应预览用的形状；没有响应时抛出那次失败。 */
export function toHttpResult(exchange: HttpExchange): HttpResult {
  const response = exchange.response;
  if (!response) throw new HttpExchangeError(exchange.entry.error ?? "HTTP_NETWORK");
  return {
    status: response.status,
    reason: response.statusText,
    headers: response.headers.map(([name, value]) => ({ name, value })),
    body: response.body ?? "",
    binary: response.body === null,
    truncated: response.truncated,
    bodyBytes: response.size,
    elapsedMs: response.totalMs,
    finalUrl: response.finalUrl,
  };
}

/** `executeHttpRequest` 的可注入选项；全部缺省时按桌面环境实际行为执行。 */
export interface HttpExecuteOptions {
  /** `.http` 文件所在目录，相对路径的正文文件和 `.env` 都相对它。 */
  dir?: string;
  /** 工程根。正文文件在 http 文件旁边找不到时，再按这个根找一次。 */
  workspace?: string | null;
  /** `.http` 文件路径，随这次请求记进历史。 */
  path?: string | null;
  /** 取消这次请求用的 id（配合后端 `http_cancel`）。 */
  requestId?: string | null;
  /** `http-client.env.json` 里选中的环境的变量，优先级低于文件变量。未选环境时仍带 `$shared`。 */
  envVars?: Record<string, string> | null;
  /**
   * 同一次「运行全部」共用的具名响应。
   * 后面的请求引用 `{{name.response…}}` 时直接用这里的结果，不再把依赖重发一遍。
   */
  session?: HttpRunSession;
  /** 这次的交换（历史里也有一份）。工具窗口据此高亮最新一条。 */
  onExchange?: (exchange: HttpExchange) => void;
  /** 某个路径在不在磁盘上。测试注入；缺省问文件系统。 */
  exists?: (path: string) => Promise<boolean>;
  readText?: (path: string) => Promise<string>;
  send?: (call: HttpCall) => Promise<HttpResult>;
  /** `# @prompt` 弹出的输入。取消时返回 null，占位符保持原样。 */
  prompt?: (name: string, description: string) => string | null;
  processEnv?: (name: string) => Promise<string | null>;
  /** 系统时间。测试用固定时钟，缺省为当前时间。 */
  now?: Date;
  /**
   * 用户已经点了停止。依赖请求是一条接一条发出去的，两条之间后端的取消通道已经拆掉，
   * 所以每次真正 `send` 之前都要再问一次。
   */
  isCancelled?: () => boolean;
}

/** 一次发送的完整留底：发出的请求、正文文本与收到的结果。 */
interface Captured {
  call: HttpCall;
  bodyText: string;
  result: HttpResult;
}

/**
 * 一次连续发送（运行全部）的响应缓存。
 * 空对象即可，真正的表放在模块里，避免把 `Captured` 漏到外面。
 */
export type HttpRunSession = object;

/** 运行全部会话到具名响应缓存的映射；`WeakMap` 让会话废弃后缓存自动回收。 */
const runSessions = new WeakMap<HttpRunSession, Map<string, Captured>>();

/** 开一次「运行全部」用的会话。单条请求不用这个。 */
export function createHttpRunSession(): HttpRunSession {
  return {};
}

/** 取（必要时新建）一个会话的具名响应缓存。 */
function sessionCache(session: HttpRunSession): Map<string, Captured> {
  let cache = runSessions.get(session);
  if (!cache) {
    cache = new Map();
    runSessions.set(session, cache);
  }
  return cache;
}

/** 会话期间记住的 Cookie，按 host 分罐；仅内存，不持久化。 */
const cookiesByHost = new Map<string, Map<string, string>>();

/** 测试之间清掉会话里记住的 Cookie。 */
export function clearHttpCookies(): void {
  cookiesByHost.clear();
}

/** 路径是否为 `.http` / `.rest` 文件。 */
export function isHttpFile(path: string): boolean {
  return /\.(?:http|rest)$/i.test(path);
}

/** 装订线气泡上的名字：有请求名用请求名，否则用 `###` 标题，再否则方法加地址。 */
export function httpRequestLabel(request: HttpRequest): string {
  if (request.name) return request.name;
  if (request.title) return request.title;
  const url = request.url.length > 48 ? `${request.url.slice(0, 45)}…` : request.url;
  return `${request.method} ${url}`.trim();
}

/** 响应页签的虚拟路径。同一条请求反复发送会更新同一页。 */
export function httpResponsePath(path: string, line: number): string {
  return `${path}#${line}`;
}

/**
 * 光标所在行属于哪一条请求。行号 1-based，和解析结果、装订线一致。
 * 先看块范围（请求行、头、正文、前后注释），对不上就取光标上方最近的一条。
 */
export function httpRequestAtLine(file: HttpFile, line: number): HttpRequest | null {
  let best: HttpRequest | null = null;
  for (const request of file.requests) {
    const end = Math.max(request.endLine, request.line);
    if (request.startLine <= line && line <= end) return request;
    if (request.line <= line) best = request;
  }
  return best ?? file.requests[0] ?? null;
}

/**
 * 解析 `.http` 文本为变量与请求列表。
 *
 * 语法容错：`###`/`####` 都算分段符，标题可有可无；请求行后接 `?`/`&` 续行、
 * 缩进的头值续行；cURL 行（含 `\` 续行）整段交给 {@link parseCurl}。
 * 响应脚本 `> {% … %}` 与 `<>`/`>>` 指令行被跳过，不当成正文。
 *
 * @param text - 文件全文；BOM 会被剥掉
 * @returns 变量与请求；行号均为 1-based
 */
export function parseHttpFile(text: string): HttpFile {
  const source = text.replace(/^\uFEFF/, "");
  const lines = source.split(/\r?\n/);
  const variables: HttpVariable[] = [];
  const requests: HttpRequest[] = [];

  let mode: "preamble" | "headers" | "body" | "script" = "preamble";
  let title: string | null = null;
  let name: string | null = null;
  let prompts: HttpPrompt[] = [];
  let draft: HttpRequest | null = null;
  /** 当前这段从哪一行开始（分隔符的下一行；文件开头是第 1 行）。 */
  let blockStart = 1;
  let seenHeader = false;
  // 正文可以从空行开始。不能用「正文是不是空串」判断已经开始，否则第一行空白会被吃掉。
  let bodyStarted = false;

  const takeMeta = () => {
    const meta = { name, title, prompts: prompts.slice() };
    name = null;
    title = null;
    prompts = [];
    return meta;
  };

  const finish = () => {
    if (!draft) return;
    draft.body = draft.body.replace(/\n$/, "");
    while (draft.endLine > draft.line && (lines[draft.endLine - 1] ?? "").trim() === "") {
      draft.endLine -= 1;
    }
    requests.push(draft);
    draft = null;
    seenHeader = false;
    bodyStarted = false;
    mode = "preamble";
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const separator = /^(#{3,})[ \t]*(.*)$/.exec(trimmed);
    if (separator) {
      finish();
      const label = (separator[2] ?? "").trim();
      title = label === "" ? null : label;
      name = null;
      prompts = [];
      mode = "preamble";
      blockStart = index + 2;
      continue;
    }

    if (draft) draft.endLine = index + 1;

    // 无正文的请求也可以直接跟响应指令，不要求额外插入空行。
    if (mode === "headers" && /^(?:>\s|>>|<>)/.test(trimmed)) mode = "body";
    if (mode === "body" && draft) {
      // 响应指令允许缩进；只跳过脚本区间，不能把指令或脚本当请求正文。
      if (trimmed.startsWith("> {%")) {
        if (!trimmed.endsWith("%}")) mode = "script";
        continue;
      }
      if (/^(?:<>|>>|>\s)/.test(trimmed)) continue;
      draft.body = bodyStarted ? `${draft.body}\n${line}` : line;
      bodyStarted = true;
      continue;
    }
    if (mode === "script") {
      if (trimmed.endsWith("%}")) mode = "body";
      continue;
    }

    if (trimmed === "") {
      if (mode === "headers") mode = "body";
      continue;
    }

    if (trimmed.startsWith("#") || trimmed.startsWith("//")) {
      if (mode === "preamble") {
        const named = /^(?:#|\/\/)\s*@name[ \t=]+(.+?)\s*$/.exec(trimmed);
        if (named) name = named[1];
        const prompted = /^(?:#|\/\/)\s*@prompt\s+(\S+)(?:\s+(.+))?$/.exec(trimmed);
        if (prompted) {
          prompts.push({ name: prompted[1], description: (prompted[2] ?? "").trim() });
        }
      }
      continue;
    }

    if (mode === "preamble") {
      const variable = /^@(\S+)\s*=\s*(.*)$/.exec(trimmed);
      if (variable) {
        variables.push({
          name: variable[1],
          value: unescapeValue(variable[2].trim()),
          line: index + 1,
        });
        continue;
      }
      if (/^curl(?:\.exe)?(?:\s|$)/i.test(trimmed)) {
        const chunk = [line];
        while (/\\\s*$/.test(lines[index] ?? "") && index + 1 < lines.length) {
          index += 1;
          chunk.push(lines[index] ?? "");
        }
        const meta = takeMeta();
        const requestLine = index + 1 - (chunk.length - 1);
        requests.push({
          ...parseCurl(chunk.join("\n"), requestLine, meta),
          startLine: Math.min(blockStart, requestLine),
          endLine: index + 1,
        });
        continue;
      }
      const parsed = parseRequestLine(trimmed);
      if (!parsed) continue;
      const meta = takeMeta();
      draft = {
        line: index + 1,
        startLine: Math.min(blockStart, index + 1),
        endLine: index + 1,
        name: meta.name,
        title: meta.title,
        method: parsed.method,
        url: parsed.url,
        headers: [],
        body: "",
        prompts: meta.prompts,
      };
      seenHeader = false;
      mode = "headers";
      continue;
    }

    if (mode === "headers" && draft) {
      if (!seenHeader && (/^[?&]/.test(trimmed) || /^[ \t]+\//.test(line))) {
        let extra = trimmed;
        if (extra.startsWith("?") && draft.url.includes("?")) extra = `&${extra.slice(1)}`;
        draft.url += extra;
        continue;
      }
      if (seenHeader && /^[ \t]/.test(line)) {
        const last = draft.headers[draft.headers.length - 1];
        if (last) last.value = `${last.value} ${trimmed}`;
        continue;
      }
      const header = /^([^:\s][^:]*):\s?(.*)$/.exec(trimmed);
      if (header) {
        draft.headers.push({ name: header[1].trim(), value: header[2].trim() });
        seenHeader = true;
        continue;
      }
      mode = "body";
      draft.body = line;
      bodyStarted = true;
    }
  }
  finish();
  return { variables, requests };
}

/** 发送一条 .http 请求：变量展开 → include 拼装 → 交发送器；结果落历史。 */
export async function executeHttpRequest(
  file: HttpFile,
  request: HttpRequest,
  options: HttpExecuteOptions = {}
): Promise<HttpResult> {
  const dir = options.dir ?? "";
  const workspace = options.workspace ?? null;
  const exists = options.exists ?? defaultExists;
  const readText = options.readText ?? defaultReadText;
  const send = options.send ?? ((call: HttpCall) => defaultSend(call, options));
  const ask = options.prompt ?? defaultPrompt;
  const processEnv = options.processEnv ?? defaultProcessEnv;
  const now = options.now ?? new Date();
  const byName = new Map<string, HttpRequest>();
  for (const item of file.requests) {
    if (item.name) byName.set(item.name, item);
  }
  const cache = options.session ? sessionCache(options.session) : new Map<string, Captured>();
  const env = new Map<string, string | null>();
  let dotenv = new Map<string, string>();
  let dotenvLoaded = false;

  const loadDotenv = async (): Promise<Map<string, string>> => {
    if (dotenvLoaded) return dotenv;
    dotenvLoaded = true;
    if (!dir) return dotenv;
    try {
      dotenv = parseDotEnv(await readText(joinPath(dir, ".env")));
    } catch {
      dotenv = new Map();
    }
    return dotenv;
  };

  const ensureDynamics = async (text: string) => {
    if (text.includes("$dotenv")) await loadDotenv();
    const pending: string[] = [];
    const re = /\{\{\s*\$processEnv\s+([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      if (!env.has(match[1]) && !pending.includes(match[1])) pending.push(match[1]);
    }
    for (const key of pending) env.set(key, await processEnv(key));
  };

  const ensureCurrent = () => {
    if (options.isCancelled?.()) throw codedError("HTTP_CANCELLED");
  };

  const runOne = async (current: HttpRequest, stack: string[]): Promise<Captured> => {
    ensureCurrent();
    if (current.name && cache.has(current.name)) return cache.get(current.name)!;
    const prepared = await prepare(current, stack);
    // 准备依赖、读正文的这段时间里用户可能已经点了停止。停在发出去之前。
    ensureCurrent();
    const result = await send(prepared.call);
    rememberCookies(result.finalUrl || prepared.call.url, result.headers);
    const captured = { call: prepared.call, bodyText: prepared.bodyText, result };
    if (current.name) cache.set(current.name, captured);
    return captured;
  };

  const prepare = async (current: HttpRequest, stack: string[]): Promise<Captured> => {
    for (let pass = 0; pass < 8; pass++) {
      const blob = [
        ...file.variables.map((item) => item.value),
        current.url,
        current.body,
        ...current.headers.flatMap((header) => [header.name, header.value]),
      ].join("\n");
      await ensureDynamics(blob);
      const own = [
        current.url,
        current.body,
        ...current.headers.flatMap((header) => [header.name, header.value]),
      ].join("\n");
      // 请求自己的地址或正文引用了自己，才是循环。文件变量里的 `{{login.response...}}`
      // 是给后面的请求用的，不能把正在发送的 login 自己算成依赖。
      if (current.name && missingNames(own, byName, cache).includes(current.name)) {
        throw codedError("HTTP_CYCLE", current.name);
      }
      const missing = missingNames(blob, byName, cache).filter((depName) => depName !== current.name);
      if (missing.length === 0) break;
      for (const depName of missing) {
        if (stack.includes(depName)) throw codedError("HTTP_CYCLE", depName);
        const dep = byName.get(depName);
        if (!dep) continue;
        stack.push(depName);
        await runOne(dep, stack);
        stack.pop();
      }
    }
    await ensureDynamics(
      [...file.variables.map((item) => item.value), current.url, current.body].join("\n")
    );
    const vars = resolveFileVars(file, options.envVars);
    // 依赖和动态变量加载都可能让出执行权，停止后不能再准备下一条请求。
    ensureCurrent();
    return materialize(current, vars, {
      dir,
      workspace,
      exists,
      cache,
      dotenv,
      env,
      now,
      ask,
      readText,
      ensureDynamics,
    });
  };

  const captured = await runOne(request, request.name ? [request.name] : []);
  return captured.result;
}

/**
 * 把一次交换格式化成历史页用的纯文本（状态行、耗时、头、正文）。
 *
 * @param result - 响应预览
 * @param notes - 二进制正文与截断正文的占位文案
 * @returns 多行文本；JSON 正文按 2 空格缩进重排，解析失败原样保留
 */
export function formatHttpExchange(
  result: HttpResult,
  notes: { binary: string; truncated: string }
): string {
  const lines = [
    `HTTP/1.1 ${result.status} ${result.reason}`.trimEnd(),
    result.finalUrl,
    `${result.elapsedMs} ms · ${result.bodyBytes} B`,
    "",
  ];
  for (const header of result.headers) lines.push(`${header.name}: ${header.value}`);
  lines.push("");
  if (result.binary) {
    lines.push(notes.binary);
    return lines.join("\n");
  }
  let body = result.body;
  const type = result.headers.find((header) => header.name.toLowerCase() === "content-type")?.value ?? "";
  if (/json/i.test(type)) {
    try {
      body = JSON.stringify(JSON.parse(result.body), null, 2);
    } catch {
      body = result.body;
    }
  }
  if (result.truncated) body += `\n\n${notes.truncated}`;
  lines.push(body);
  return lines.join("\n");
}

/** `.env` 的最小子集：`KEY=VALUE`、可选的 `export`、成对引号。 */
export function parseDotEnv(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    let key = trimmed.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value.replace(/\\n/g, "\n"));
  }
  return map;
}

/**
 * 解析请求行 `METHOD URL`；`HTTP/x.y` 后缀被剥掉。
 *
 * @returns 方法（大写）与地址；裸 URL / `{{…}}` / 路径按 GET 处理，其余返回 null（留在前导区）
 */
function parseRequestLine(line: string): { method: string; url: string } | null {
  const stripped = line.replace(/\s+HTTP\/\d+(?:\.\d+)?$/i, "").trim();
  // 与原版一样只把请求行认作请求，说明文字和没有目标的方法名留在前导区。
  const method = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE|CONNECT|GRAPHQL)\s+(\S[\s\S]*)$/i.exec(stripped);
  if (method) return { method: method[1].toUpperCase(), url: method[2].trim() };
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|\{\{|\/)/i.test(stripped)) return { method: "GET", url: stripped };
  return null;
}

/**
 * 把一条 cURL 命令转成请求（`parseHttpFile` 的 cURL 分支）。
 *
 * 支持 `-X/--request`、`-H/--header`、`-d/--data*`、`--url`、`-I/--head`、
 * `-u/--user`（转 Basic）、`-b/--cookie`；`-L` 忽略。`@file`/`@@file` 数据
 * 分别转成 `< file` / `<@ file` 的正文文件引用。
 *
 * @param script - cURL 全文（续行已合并）
 * @param line - 请求行行号（1-based）
 * @param meta - 注释里收集的 `@name`/标题/`@prompt`
 */
function parseCurl(
  script: string,
  line: number,
  meta: { name: string | null; title: string | null; prompts: HttpPrompt[] }
): HttpRequest {
  const words = shellWords(script);
  let method = "GET";
  let url = "";
  let head = false;
  let user = "";
  let cookie = "";
  const headers: HttpHeader[] = [];
  const data: string[] = [];
  const take = (index: number) => words[index + 1] ?? "";
  for (let index = 1; index < words.length; index++) {
    const word = words[index] ?? "";
    if (word === "-X" || word === "--request") {
      method = take(index).toUpperCase();
      index += 1;
    } else if (word.startsWith("--request=")) {
      method = word.slice("--request=".length).toUpperCase();
    } else if (word.startsWith("-X") && word.length > 2) {
      method = word.slice(2).toUpperCase();
    } else if (word === "-H" || word === "--header") {
      pushCurlHeader(headers, take(index));
      index += 1;
    } else if (word.startsWith("--header=")) {
      pushCurlHeader(headers, word.slice("--header=".length));
    } else if (
      word === "-d" ||
      word === "--data" ||
      word === "--data-raw" ||
      word === "--data-ascii" ||
      word === "--data-binary"
    ) {
      data.push(take(index));
      index += 1;
    } else if (word.startsWith("--data=")) {
      data.push(word.slice("--data=".length));
    } else if (word.startsWith("--data-raw=")) {
      data.push(word.slice("--data-raw=".length));
    } else if (word.startsWith("--data-binary=")) {
      data.push(word.slice("--data-binary=".length));
    } else if (word === "--url") {
      url = take(index);
      index += 1;
    } else if (word.startsWith("--url=")) {
      url = word.slice("--url=".length);
    } else if (word === "-I" || word === "--head") {
      head = true;
    } else if (word === "-u" || word === "--user") {
      user = take(index);
      index += 1;
    } else if (word.startsWith("--user=")) {
      user = word.slice("--user=".length);
    } else if (word === "-b" || word === "--cookie") {
      cookie = take(index);
      index += 1;
    } else if (word.startsWith("--cookie=")) {
      cookie = word.slice("--cookie=".length);
    } else if (word === "-L" || word === "--location") {
      continue;
    } else if (!word.startsWith("-") && url === "") {
      url = word;
    }
  }
  const parts = data.map(curlData);
  const fileBody = parts.some((part) => part.startsWith("< "));
  if (head && method === "GET") method = "HEAD";
  if (!fileBody && parts.length > 0 && method === "GET") method = "POST";
  if (user) headers.push({ name: "Authorization", value: basicAuth(user) });
  if (cookie) headers.push({ name: "Cookie", value: cookie });
  if (
    !fileBody &&
    parts.length > 0 &&
    !headers.some((header) => header.name.toLowerCase() === "content-type")
  ) {
    headers.push({ name: "Content-Type", value: "application/x-www-form-urlencoded" });
  }
  return {
    line,
    startLine: line,
    endLine: line,
    name: meta.name,
    title: meta.title,
    method,
    url,
    headers,
    body: parts.length === 1 ? parts[0] : parts.join("&"),
    prompts: meta.prompts,
  };
}

/** 解析 `-H "Name: value"` 并追加到头列表；无冒号的参数忽略。 */
function pushCurlHeader(headers: HttpHeader[], raw: string) {
  const index = raw.indexOf(":");
  if (index <= 0) return;
  headers.push({ name: raw.slice(0, index).trim(), value: raw.slice(index + 1).trim() });
}

/** 归一一条 `-d` 数据：`@@file` 保留为 `@file`，`@file` 转成 `< file` 文件引用。 */
function curlData(value: string): string {
  if (value.startsWith("@@")) return value.slice(1);
  if (value.startsWith("@")) return `< ${value.slice(1)}`;
  return value;
}

/** 按 POSIX 规则把一行 cURL 拆成词：单双引号、反斜杠转义、`\` 续行。 */
function shellWords(input: string): string[] {
  const text = input.replace(/\\\r?\n/g, " ");
  const words: string[] = [];
  let index = 0;
  while (index < text.length) {
    while (text[index] === " " || text[index] === "\t") index += 1;
    if (index >= text.length) break;
    let word = "";
    let quote: "'" | '"' | null = null;
    while (index < text.length) {
      const ch = text[index] ?? "";
      if (quote) {
        if (ch === quote) {
          quote = null;
          index += 1;
          continue;
        }
        if (ch === "\\" && quote === '"') {
          const next = text[index + 1];
          if (next) {
            word += next === "n" ? "\n" : next === "t" ? "\t" : next;
            index += 2;
            continue;
          }
        }
        word += ch;
        index += 1;
        continue;
      }
      if (ch === " " || ch === "\t") break;
      if (ch === "'" || ch === '"') {
        quote = ch;
        index += 1;
        continue;
      }
      if (ch === "\\") {
        const next = text[index + 1];
        if (next) {
          word += next;
          index += 2;
          continue;
        }
      }
      word += ch;
      index += 1;
    }
    words.push(word);
  }
  return words;
}

/** `user:password` 编码为 Basic 授权头值。 */
function basicAuth(user: string): string {
  const bytes = new TextEncoder().encode(user);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

/** 还原文件变量值里的转义序列（`\n`/`\r`/`\t`/`\\`）。 */
function unescapeValue(value: string): string {
  return value.replace(/\\([nrt\\])/g, (_match, ch: string) => {
    if (ch === "n") return "\n";
    if (ch === "r") return "\r";
    if (ch === "t") return "\t";
    return "\\";
  });
}

/**
 * 找出文本里引用了、但还没有响应缓存的具名请求。
 *
 * @returns 按出现顺序去重后的缺失名字列表
 */
function missingNames(
  text: string,
  byName: Map<string, HttpRequest>,
  cache: Map<string, Captured>
): string[] {
  const names: string[] = [];
  const re = /\{\{\s*([\w.-]+)\.(?:response|request)\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const name = match[1];
    if (!byName.has(name) || cache.has(name) || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

/** 变量合并视图：环境文件垫底，文件内 `@var` 覆盖；替换时递归展开。 */
function resolveFileVars(
  file: HttpFile,
  envVars?: Record<string, string> | null
): Map<string, string> {
  const raw = new Map<string, string>();
  // 环境文件的变量垫底，文件里的 `@var` 覆盖它（取值次序：文件优先于环境）。
  for (const [key, value] of Object.entries(envVars ?? {})) raw.set(key, value);
  for (const variable of file.variables) raw.set(variable.name, variable.value);
  // 使用时递归解析，保留模板与外部响应数据的边界，不重复解释已经替换出的数据。
  return raw;
}

/** 物化一条请求所需的环境：路径、缓存、动态变量与各注入点。 */
interface MaterializeContext {
  dir: string;
  workspace: string | null;
  exists: (path: string) => Promise<boolean>;
  cache: Map<string, Captured>;
  dotenv: Map<string, string>;
  env: Map<string, string | null>;
  now: Date;
  ask: (name: string, description: string) => string | null;
  readText: (path: string) => Promise<string>;
  ensureDynamics: (text: string) => Promise<void>;
}

/** 展开一条请求的 URL/头/体：替换变量、处理 `@prompt` 提示（答案只在本请求内有效）。 */
async function materialize(
  request: HttpRequest,
  vars: Map<string, string>,
  ctx: MaterializeContext
): Promise<Captured> {
  // 提示变量只在这一条请求里有效，不带给后面的请求。
  const answers = new Map<string, string>();
  const fill = (text: string) => {
    const missing = new Set<string>();
    const value = substitute(text, vars, ctx.cache, ctx.dotenv, ctx.env, ctx.now, request.prompts, answers, ctx.ask, missing);
    // 只报告解析模板时缺失的名字；外部响应与提示输入不再作为新模板扫描。
    if (missing.size) throw codedError("HTTP_VARIABLE", [...missing].sort().join(", "));
    return value;
  };
  let method = request.method;
  const headers = request.headers.map((header) => ({
    name: fill(header.name),
    value: fill(header.value),
  }));
  const graphql =
    method === "GRAPHQL" ||
    headers.some(
      (header) =>
        header.name.toLowerCase() === "x-request-type" && header.value.trim().toLowerCase() === "graphql"
    );
  if (method === "GRAPHQL") method = "POST";
  let body = fill(request.body);
  const form = headers.some(
    (header) =>
      header.name.toLowerCase() === "content-type" &&
      header.value.toLowerCase().includes("application/x-www-form-urlencoded")
  );
  if (form) body = body.replace(/\n&/g, "&");
  let pieces = await expandIncludes(body, ctx, fill);
  if (graphql && pieces.every((piece) => piece.file === undefined)) {
    const text = pieces.map((piece) => piece.text ?? "").join("");
    pieces = [{ text: graphqlEnvelope(text) }];
    if (!headers.some((header) => header.name.toLowerCase() === "content-type")) {
      headers.push({ name: "Content-Type", value: "application/json" });
    }
  }
  const target = fill(request.url).trim();
  // 原始 HTTP 请求行可只写路径，此时必须用已经替换变量的 Host 头补齐地址。
  const host = headers.find((header) => header.name.toLowerCase() === "host")?.value;
  if (target.startsWith("/") && !host) throw codedError("HTTP_URL", target);
  const url = target.startsWith("/") ? `http://${host}${target}` : normalizeUrl(target);
  assertHttp(url);
  const call: HttpCall = {
    name: request.name ?? request.title,
    method,
    url,
    headers: applyCookies(url, headers),
    body: pieces,
  };
  return { call, bodyText: pieces.map((piece) => piece.text ?? "").join(""), result: emptyResult(url) };
}

/** 把请求体中的 `< include` 引用展开成请求片段；GraphQL 的 `< query`/`< variables` 特殊拼装。 */
async function expandIncludes(
  body: string,
  ctx: MaterializeContext,
  fill: (text: string) => string
): Promise<HttpBodyPiece[]> {
  if (body === "") return [];
  const lines = body.split("\n");
  const pieces: HttpBodyPiece[] = [];
  let buf = "";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const include = /^[ \t]*<(@([A-Za-z0-9._-]*))?[ \t]+(.+?)\s*$/.exec(line);
    const newline = index < lines.length - 1 ? "\n" : "";
    if (!include) {
      buf += line + newline;
      continue;
    }
    if (buf !== "") {
      pieces.push({ text: buf });
      buf = "";
    }
    const encoding = include[2] ?? "";
    const substituteFile = include[1] !== undefined;
    if (substituteFile && encoding !== "" && !/^utf-?8$/i.test(encoding)) {
      throw codedError("HTTP_ENCODING", encoding);
    }
    const path = await resolveIncludePath(ctx, fill(include[3] ?? ""));
    if (substituteFile) {
      const text = await ctx.readText(path);
      await ctx.ensureDynamics(text);
      pieces.push({ text: fill(text) });
    } else {
      pieces.push({ file: path });
    }
    buf = newline;
  }
  if (buf !== "") pieces.push({ text: buf });
  return pieces;
}

/** 把 GRAPHQL 方法包成 `{query, variables}` JSON 信封；正文按空行拆 query 与 variables。 */
function graphqlEnvelope(body: string): string {
  const splitAt = body.search(/\n[ \t]*\n/);
  if (splitAt < 0) return JSON.stringify({ query: body });
  const query = body.slice(0, splitAt);
  const variables = body.slice(splitAt).trim();
  if (variables === "") return JSON.stringify({ query });
  try {
    return JSON.stringify({ query, variables: JSON.parse(variables) as unknown });
  } catch {
    return JSON.stringify({ query: body });
  }
}

/** 解析 include 引用的相对路径：相对请求文件目录，找不到再退回工作区根。 */
async function resolveIncludePath(ctx: MaterializeContext, raw: string): Promise<string> {
  const primary = tidyPath(resolvePath(ctx.dir, raw));
  const rooted = isWindowsPath(raw) || raw.startsWith("/") || raw.startsWith("\\");
  if (rooted || !ctx.workspace) return primary;
  if (await ctx.exists(primary)) return primary;
  const alternate = tidyPath(resolvePath(ctx.workspace, raw));
  if (alternate !== primary && (await ctx.exists(alternate))) return alternate;
  return primary;
}

/** 通过文件时间戳探测存在性的缺省实现。 */
async function defaultExists(path: string): Promise<boolean> {
  try {
    await fileStamp(path);
    return true;
  } catch {
    return false;
  }
}

/** 补协议：只有 `scheme://` 才算带了协议，`localhost:8080` 补成 `http://localhost:8080`。 */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  // 只有 `scheme://` 才算已经带了协议。`localhost:8080` 里的冒号是端口，不是协议。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

/** 去掉 `./` 与重复分隔符，让 `< ./a` 落到文件所在目录下的 `a`。 */
function tidyPath(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const rooted = path.startsWith("/") || path.startsWith("\\");
  const parts = path.split(/[\\/]/).filter((part) => part !== "" && part !== ".");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  const joined = stack.join(sep);
  if (rooted) return `${sep}${joined}`;
  return joined;
}

/** 地址必须是可解析的 http(s) URL，否则抛 `HTTP_URL`。 */
function assertHttp(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw codedError("HTTP_URL", url);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw codedError("HTTP_URL", url);
  }
}

/** 用户没写 Cookie 头时，把会话记住的该 host Cookie 追加进去。 */
function applyCookies(url: string, headers: HttpHeader[]): HttpHeader[] {
  if (headers.some((header) => header.name.toLowerCase() === "cookie")) return headers;
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    return headers;
  }
  const jar = cookiesByHost.get(host);
  if (!jar || jar.size === 0) return headers;
  const value = [...jar].map(([key, item]) => `${key}=${item}`).join("; ");
  return [...headers, { name: "Cookie", value }];
}

/** 把响应里的 `Set-Cookie` 记进会话罐（只取名值对，忽略属性）。 */
function rememberCookies(url: string, headers: HttpHeader[]) {
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  for (const header of headers) {
    if (header.name.toLowerCase() !== "set-cookie") continue;
    const pair = header.value.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const jar = cookiesByHost.get(host) ?? new Map<string, string>();
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    cookiesByHost.set(host, jar);
  }
}

/**
 * 递归替换 `{{…}}` 占位符。
 *
 * 解析次序：具名响应引用 → `$` 系统变量 → `@prompt` 询问 → 文件/环境变量（再递归展开）。
 * 每层最多递归 8 层防环；解不开的名字记入 `missing` 并保留原 token。
 *
 * @param prompts - 本条请求的 `@prompt` 声明；null 表示不启用询问
 * @param answers - 本次请求内提示答案缓存，同名的只问一次
 * @param missing - 收集未能解析的名字；不传则静默保留 token
 */
function substitute(
  text: string,
  vars: Map<string, string>,
  cache: Map<string, Captured>,
  dotenv: Map<string, string>,
  env: Map<string, string | null>,
  now: Date,
  prompts: HttpPrompt[] | null,
  answers: Map<string, string>,
  ask?: (name: string, description: string) => string | null,
  missing?: Set<string>,
  depth = 0
): string {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (token, raw: string) => {
    const expr = raw.trim();
    const unresolved = () => {
      missing?.add(expr);
      return token;
    };
    const ref = /^([\w.-]+)\.(response|request)\.(body|headers)\.([\s\S]+)$/.exec(expr);
    if (ref) {
      const captured = cache.get(ref[1]);
      if (!captured) return unresolved();
      const value = lookupCaptured(captured, ref[2] as "response" | "request", ref[3] as "body" | "headers", ref[4]);
      return value === null ? unresolved() : value;
    }
    if (expr.startsWith("$")) {
      const value = systemValue(expr, dotenv, env, now);
      return value === null ? unresolved() : value;
    }
    const prompt = prompts?.find((item) => item.name === expr);
    if (prompt) {
      if (!answers.has(expr)) {
        const answer = ask?.(expr, prompt.description);
        if (answer === null || answer === undefined) return unresolved();
        answers.set(expr, answer);
      }
      return answers.get(expr) ?? token;
    }
    if (vars.has(expr)) {
      if (depth >= 8) return unresolved();
      return substitute(vars.get(expr) ?? "", vars, cache, dotenv, env, now, prompts, answers, ask, missing, depth + 1);
    }
    return unresolved();
  });
}

/**
 * 从具名请求的留底里取 `{{name.response…}}` / `{{name.request…}}` 的值。
 *
 * @param path - `*` 整个正文；`$…` JSON path；`/…` XPath；头引用按名不区分大小写合并
 * @returns 值文本；二进制响应、解不开的路径返回 null
 */
function lookupCaptured(
  captured: Captured,
  side: "response" | "request",
  part: "body" | "headers",
  path: string
): string | null {
  if (part === "headers") {
    const source = side === "response" ? captured.result.headers : captured.call.headers;
    const found = source.filter((header) => header.name.toLowerCase() === path.toLowerCase());
    if (found.length === 0) return null;
    return found.map((header) => header.value).join(", ");
  }
  if (side === "response" && captured.result.binary) return null;
  const body = side === "response" ? captured.result.body : captured.bodyText;
  if (path === "*") return body;
  if (path.startsWith("$")) return jsonPath(body, path);
  if (path.startsWith("/")) return xmlPath(body, path);
  return null;
}

/**
 * 计算 `$` 系统变量：`$guid`、`$timestamp`、`$datetime`、`$randomInt`、
 * `$dotenv KEY`、`$processEnv KEY` 及 REST Client 别名（`$random.uuid` 等）。
 *
 * @returns 替换值；未知变量或参数不合法返回 null
 */
function systemValue(
  expr: string,
  dotenv: Map<string, string>,
  env: Map<string, string | null>,
  now: Date
): string | null {
  const body = expr.slice(1).trim();
  // 内置动态变量与 REST Client 的带参数写法共用同一条替换路径。
  if (body === "random.uuid") return crypto.randomUUID();
  if (body === "isoTimestamp") return now.toISOString().replace(/\.\d{3}Z$/, "Z");
  if (["randomInt", "random.integer", "random.integer()"].includes(body)) return String(Math.floor(Math.random() * 1000));
  const name = /^([A-Za-z]+)/.exec(body)?.[1] ?? "";
  const rest = body.slice(name.length).trim();
  if (name === "guid" || name === "uuid") return crypto.randomUUID();
  if (name === "randomInt") {
    const match = /^(-?\d+)\s+(-?\d+)$/.exec(rest);
    if (!match) return null;
    const min = Number(match[1]);
    const max = Number(match[2]);
    if (!Number.isInteger(min) || !Number.isInteger(max) || max <= min) return null;
    return String(Math.floor(Math.random() * (max - min)) + min);
  }
  if (name === "timestamp") return String(Math.floor(shift(now, rest).getTime() / 1000));
  if (name === "datetime" || name === "localDatetime") {
    const parsed = splitFormat(rest);
    return formatDate(shift(now, parsed.offset), parsed.format, name === "datetime");
  }
  if (name === "dotenv") {
    const key = rest.trim();
    return dotenv.has(key) ? dotenv.get(key)! : null;
  }
  if (name === "processEnv") {
    const key = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(rest)?.[1];
    if (!key || !env.has(key)) return null;
    const value = env.get(key);
    return value === null || value === undefined ? null : value;
  }
  return null;
}

/** 拆 `$datetime` 参数：`"格式" 偏移`、具名格式（rfc1123/iso8601）或裸偏移。 */
function splitFormat(rest: string): { format: string; offset: string } {
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const quote = rest[0];
    const end = rest.indexOf(quote, 1);
    if (end > 0) return { format: rest.slice(1, end), offset: rest.slice(end + 1).trim() };
  }
  const named = /^(rfc1123|iso8601)\b\s*(.*)$/i.exec(rest);
  if (named) return { format: named[1].toLowerCase(), offset: named[2].trim() };
  return { format: "iso8601", offset: rest };
}

/** 按偏移表达式（`-1d`、`+2h` 等）平移时间；格式不合法返回原时间。 */
function shift(now: Date, offset: string): Date {
  const match = /^(-?\d+)\s+([A-Za-z]+)$/.exec(offset.trim());
  const date = new Date(now.getTime());
  if (!match) return date;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "y") date.setUTCFullYear(date.getUTCFullYear() + amount);
  else if (unit === "M") date.setUTCMonth(date.getUTCMonth() + amount);
  else if (unit === "w") date.setUTCDate(date.getUTCDate() + amount * 7);
  else if (unit === "d") date.setUTCDate(date.getUTCDate() + amount);
  else if (unit === "h") date.setUTCHours(date.getUTCHours() + amount);
  else if (unit === "m") date.setUTCMinutes(date.getUTCMinutes() + amount);
  else if (unit === "s") date.setUTCSeconds(date.getUTCSeconds() + amount);
  else if (unit === "ms") date.setUTCMilliseconds(date.getUTCMilliseconds() + amount);
  return date;
}

/** 按模板格式化时间：`iso8601`/`rfc1123` 具名格式或 `YYYY MM DD HH mm ss SSS` 令牌。 */
function formatDate(date: Date, format: string, utc: boolean): string {
  if (format === "iso8601") {
    if (utc) return date.toISOString();
    const pad = (value: number, width = 2) => String(value).padStart(width, "0");
    const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
    const offsetMin = -date.getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    return `${local}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  }
  if (format === "rfc1123") {
    if (utc) return date.toUTCString();
    return date.toString();
  }
  const pick = (token: string) => {
    const year = utc ? date.getUTCFullYear() : date.getFullYear();
    const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1;
    const day = utc ? date.getUTCDate() : date.getDate();
    const hour = utc ? date.getUTCHours() : date.getHours();
    const minute = utc ? date.getUTCMinutes() : date.getMinutes();
    const second = utc ? date.getUTCSeconds() : date.getSeconds();
    const ms = utc ? date.getUTCMilliseconds() : date.getMilliseconds();
    if (token === "YYYY") return String(year);
    if (token === "YY") return String(year).slice(-2);
    if (token === "MM") return String(month).padStart(2, "0");
    if (token === "DD") return String(day).padStart(2, "0");
    if (token === "HH") return String(hour).padStart(2, "0");
    if (token === "mm") return String(minute).padStart(2, "0");
    if (token === "ss") return String(second).padStart(2, "0");
    if (token === "SSS") return String(ms).padStart(3, "0");
    return token;
  };
  return format.replace(/YYYY|YY|MM|DD|HH|mm|ss|SSS/g, pick);
}

/** 简化版 JSON path（`.key`、`[0]`、`['key']`）；解析失败返回 null。 */
function jsonPath(body: string, path: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (path === "$") return stringifyJson(data);
  const rest = path.startsWith("$") ? path.slice(1) : path;
  if (rest === "") return stringifyJson(data);
  let current: unknown = data;
  const re = /(?:\.([A-Za-z_][\w-]*)|\[(\d+)\]|\[['"]([^'"]+)['"]\])/y;
  let index = 0;
  while (index < rest.length) {
    re.lastIndex = index;
    const match = re.exec(rest);
    if (!match) return null;
    index = re.lastIndex;
    if (match[1] !== undefined) {
      if (current === null || typeof current !== "object") return null;
      current = (current as Record<string, unknown>)[match[1]];
    } else if (match[2] !== undefined) {
      if (!Array.isArray(current)) return null;
      current = current[Number(match[2])];
    } else {
      if (current === null || typeof current !== "object") return null;
      current = (current as Record<string, unknown>)[match[3]];
    }
    if (current === undefined) return null;
  }
  return stringifyJson(current);
}

/** 值转文本：字符串原样，标量 `String()`，其余 `JSON.stringify`。 */
function stringifyJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** XPath 取值用的最小 XML 节点；文本子节点以 `#text` 名暂存。 */
interface XmlEl {
  name: string;
  attrs: Record<string, string>;
  children: XmlEl[];
  text: string;
}

/** 简化版 XPath（`/a/b`、`//a`、`[n]`、`/text()`、`/@attr`）；解不开返回 null。 */
function xmlPath(body: string, path: string): string | null {
  const attr = /\/@([\w:.-]+)$/.exec(path);
  const attrName = attr?.[1] ?? null;
  let rest = attr ? path.slice(0, attr.index) : path;
  if (rest.endsWith("/text()")) rest = rest.slice(0, -"/text()".length);
  const descendant = rest.startsWith("//");
  const steps = rest
    .split("/")
    .filter((part) => part !== "")
    .map((part) => {
      const match = /^([\w:.-]+)(?:\[(\d+)\])?$/.exec(part);
      if (!match) return null;
      return { name: match[1], index: match[2] ? Number(match[2]) : 1 };
    });
  if (steps.some((step) => step === null)) return null;
  let current = parseXml(body);
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (!step) return null;
    const bag: XmlEl[] = [];
    collectXml(current, step.name, index === 0 && descendant, bag);
    const picked = bag[step.index - 1];
    if (!picked) return null;
    if (index === steps.length - 1) {
      if (attrName) return picked.attrs[attrName] ?? null;
      return picked.text;
    }
    current = picked.children;
  }
  return null;
}

/** 深度优先收集名字匹配的节点；`deep` 时连同子孙一起收。 */
function collectXml(nodes: XmlEl[], name: string, deep: boolean, bag: XmlEl[]) {
  for (const node of nodes) {
    if (node.name === name) bag.push(node);
    if (deep) collectXml(node.children, name, true, bag);
  }
}

/** 解析 XML 为节点树：剥 PI/注释、展开 CDATA、属性与文本做实体反转义。 */
function parseXml(source: string): XmlEl[] {
  const text = source
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  let index = 0;
  const parseNodes = (): XmlEl[] => {
    const nodes: XmlEl[] = [];
    while (index < text.length) {
      if (text.startsWith("</", index)) break;
      if (text[index] !== "<") {
        const next = text.indexOf("<", index);
        const chunk = text.slice(index, next < 0 ? text.length : next);
        if (chunk.trim() !== "") nodes.push({ name: "#text", attrs: {}, children: [], text: decodeXml(chunk) });
        if (next < 0) break;
        index = next;
        continue;
      }
      const end = text.indexOf(">", index);
      if (end < 0) break;
      let open = text.slice(index + 1, end).trim();
      const self = open.endsWith("/");
      if (self) open = open.slice(0, -1).trim();
      const name = /^([\w:.-]+)/.exec(open)?.[1];
      if (!name) {
        index = end + 1;
        continue;
      }
      const attrs: Record<string, string> = {};
      const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      const attrSrc = open.slice(name.length);
      let attr: RegExpExecArray | null;
      while ((attr = attrRe.exec(attrSrc))) attrs[attr[1]] = decodeXml(attr[3] ?? attr[4] ?? "");
      index = end + 1;
      if (self) {
        nodes.push({ name, attrs, children: [], text: "" });
        continue;
      }
      const children = parseNodes();
      const closer = `</${name}>`;
      if (text.startsWith(closer, index)) index += closer.length;
      nodes.push({ name, attrs, children, text: "" });
    }
    return nodes;
  };
  const roots = parseNodes();
  for (const node of roots) fillXmlText(node);
  return roots.filter((node) => node.name !== "#text");
}

/** 把文本子节点折叠进父元素的 text，并从 children 里移除 `#text`。 */
function fillXmlText(node: XmlEl): string {
  if (node.name === "#text") return node.text;
  const value = node.children.map((child) => fillXmlText(child)).join("");
  node.text = value;
  node.children = node.children.filter((child) => child.name !== "#text");
  return value;
}

/** 反转义五个 XML 基本实体；`&amp;` 最后处理避免二次解包。 */
function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 发送前的空结果占位：状态 0、无头无正文，仅供依赖链占位。 */
function emptyResult(url: string): HttpResult {
  return {
    status: 0,
    reason: "",
    headers: [],
    body: "",
    binary: false,
    truncated: false,
    bodyBytes: 0,
    elapsedMs: 0,
    finalUrl: url,
  };
}

/** 通过 Tauri fs 命令读文件内容的缺省实现。 */
async function defaultReadText(path: string): Promise<string> {
  const file = await readFile(path);
  return file.contents;
}

/**
 * 交给 Rust 发送。取消走 `requestId` + `http_cancel`；回来的那条交换既是历史也是
 * 这次的响应，所以顺手让调用方看一眼（工具窗口据此高亮最新一条）。
 */
async function defaultSend(call: HttpCall, options: HttpExecuteOptions): Promise<HttpResult> {
  const exchange = await invoke<HttpExchange>("http_send", {
    requestId: options.requestId ?? null,
    path: options.path ?? null,
    root: options.workspace ?? null,
    call: {
      name: call.name,
      method: call.method,
      url: call.url,
      headers: call.headers.map((header) => [header.name, header.value]),
      body: call.body,
    },
  });
  options.onExchange?.(exchange);
  return toHttpResult(exchange);
}

/** `@prompt` 的缺省询问实现；无窗口环境返回 null（占位符原样保留）。 */
function defaultPrompt(name: string, description: string): string | null {
  if (typeof window === "undefined" || typeof window.prompt !== "function") return null;
  return window.prompt(description || name, "");
}

/** 从后端 `http_env` 取环境变量的缺省实现；未定义返回 null。 */
async function defaultProcessEnv(name: string): Promise<string | null> {
  return invoke<string | null>("http_env", { name });
}
