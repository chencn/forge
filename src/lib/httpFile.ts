/**
 * `.http` 与 `.rest` 共用的请求文件。
 *
 * 语法按 VS Code REST Client 那套（`.http` / `.rest` 同一份）：`###` 分段、`#` 与 `//`
 * 注释、`@name = value` 文件变量、`{{var}}` 替换、请求行 / 请求头 / 空行后的正文、
 * `?` `&` 续行、`# @name` 以及 `{{name.response...}}`。系统变量覆盖 `$guid`、
 * `$timestamp`、`$datetime`、`$randomInt`、`$dotenv`、`$processEnv`。
 * 正文里的 `> {% ... %}` 是响应脚本，不发出去，也不在这里执行。
 */
import { invoke } from "@tauri-apps/api/core";
import { codedError } from "./errors";
import { isWindowsPath, joinPath, resolvePath } from "./format";
import { fileStamp, readFile } from "./fs";

export interface HttpHeader {
  name: string;
  value: string;
}

export interface HttpPrompt {
  name: string;
  description: string;
}

export interface HttpVariable {
  name: string;
  value: string;
  line: number;
}

export interface HttpRequest {
  /** 请求行的 1-based 行号，装订线箭头落在这一行。 */
  line: number;
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

export interface HttpFile {
  variables: HttpVariable[];
  requests: HttpRequest[];
}

export interface HttpBodyPiece {
  text?: string;
  file?: string;
}

/** 发给后端的一条已经替换完变量的请求。 */
export interface HttpCall {
  method: string;
  url: string;
  headers: HttpHeader[];
  body: HttpBodyPiece[];
}

/** 后端 `http_exchange` 的返回。 */
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

export interface HttpExecuteOptions {
  /** `.http` 文件所在目录，相对路径的正文文件和 `.env` 都相对它。 */
  dir?: string;
  /** 工程根。正文文件在 http 文件旁边找不到时，再按这个根找一次。 */
  workspace?: string | null;
  /** 某个路径在不在磁盘上。测试注入；缺省问文件系统。 */
  exists?: (path: string) => Promise<boolean>;
  readText?: (path: string) => Promise<string>;
  send?: (call: HttpCall) => Promise<HttpResult>;
  /** `# @prompt` 弹出的输入。取消时返回 null，占位符保持原样。 */
  prompt?: (name: string, description: string) => string | null;
  processEnv?: (name: string) => Promise<string | null>;
  /** 系统时间。测试用固定时钟，缺省为当前时间。 */
  now?: Date;
}

interface Captured {
  call: HttpCall;
  bodyText: string;
  result: HttpResult;
}

const cookiesByHost = new Map<string, Map<string, string>>();

/** 测试之间清掉会话里记住的 Cookie。 */
export function clearHttpCookies(): void {
  cookiesByHost.clear();
}

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
      continue;
    }

    if (mode === "body" && draft) {
      if (line.startsWith(">")) {
        mode = "script";
        continue;
      }
      draft.body = bodyStarted ? `${draft.body}\n${line}` : line;
      bodyStarted = true;
      continue;
    }
    if (mode === "script") continue;

    if (trimmed === "") {
      if (mode === "headers") mode = "body";
      continue;
    }

    if (trimmed.startsWith("#") || trimmed.startsWith("//")) {
      if (mode === "preamble") {
        const named = /^(?:#|\/\/)\s*@name\s+(\S+)/.exec(trimmed);
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
        requests.push(parseCurl(chunk.join("\n"), index + 1 - (chunk.length - 1), meta));
        continue;
      }
      const parsed = parseRequestLine(trimmed);
      const meta = takeMeta();
      draft = {
        line: index + 1,
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
      if (!seenHeader && /^[?&]/.test(trimmed)) {
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

export async function executeHttpRequest(
  file: HttpFile,
  request: HttpRequest,
  options: HttpExecuteOptions = {}
): Promise<HttpResult> {
  const dir = options.dir ?? "";
  const workspace = options.workspace ?? null;
  const exists = options.exists ?? defaultExists;
  const readText = options.readText ?? defaultReadText;
  const send = options.send ?? defaultSend;
  const ask = options.prompt ?? defaultPrompt;
  const processEnv = options.processEnv ?? defaultProcessEnv;
  const now = options.now ?? new Date();
  const byName = new Map<string, HttpRequest>();
  for (const item of file.requests) {
    if (item.name) byName.set(item.name, item);
  }
  const cache = new Map<string, Captured>();
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

  const runOne = async (current: HttpRequest, stack: string[]): Promise<Captured> => {
    if (current.name && cache.has(current.name)) return cache.get(current.name)!;
    const prepared = await prepare(current, stack);
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
    const vars = resolveFileVars(file, cache, dotenv, env, now);
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

function parseRequestLine(line: string): { method: string; url: string } {
  const stripped = line.replace(/\s+HTTP\/\d+(?:\.\d+)?$/i, "").trim();
  const method = /^([A-Za-z][A-Za-z0-9+.-]*)\s+(\S[\s\S]*)$/.exec(stripped);
  if (method) return { method: method[1].toUpperCase(), url: method[2].trim() };
  return { method: "GET", url: stripped };
}

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
    name: meta.name,
    title: meta.title,
    method,
    url,
    headers,
    body: parts.length === 1 ? parts[0] : parts.join("&"),
    prompts: meta.prompts,
  };
}

function pushCurlHeader(headers: HttpHeader[], raw: string) {
  const index = raw.indexOf(":");
  if (index <= 0) return;
  headers.push({ name: raw.slice(0, index).trim(), value: raw.slice(index + 1).trim() });
}

function curlData(value: string): string {
  if (value.startsWith("@@")) return value.slice(1);
  if (value.startsWith("@")) return `< ${value.slice(1)}`;
  return value;
}

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

function basicAuth(user: string): string {
  const bytes = new TextEncoder().encode(user);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function unescapeValue(value: string): string {
  return value.replace(/\\([nrt\\])/g, (_match, ch: string) => {
    if (ch === "n") return "\n";
    if (ch === "r") return "\r";
    if (ch === "t") return "\t";
    return "\\";
  });
}

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

function resolveFileVars(
  file: HttpFile,
  cache: Map<string, Captured>,
  dotenv: Map<string, string>,
  env: Map<string, string | null>,
  now: Date
): Map<string, string> {
  const raw = new Map<string, string>();
  for (const variable of file.variables) raw.set(variable.name, variable.value);
  let resolved = new Map(raw);
  for (let pass = 0; pass < 8; pass++) {
    const next = new Map<string, string>();
    for (const [key, value] of raw) {
      next.set(key, substitute(value, resolved, cache, dotenv, env, now, null, new Map()));
    }
    resolved = next;
  }
  return resolved;
}

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

async function materialize(
  request: HttpRequest,
  vars: Map<string, string>,
  ctx: MaterializeContext
): Promise<Captured> {
  // 提示变量只在这一条请求里有效，不带给后面的请求。
  const answers = new Map<string, string>();
  const fill = (text: string) =>
    substitute(text, vars, ctx.cache, ctx.dotenv, ctx.env, ctx.now, request.prompts, answers, ctx.ask);
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
  const url = normalizeUrl(fill(request.url));
  assertHttp(url);
  const call: HttpCall = {
    method,
    url,
    headers: applyCookies(url, headers),
    body: pieces,
  };
  return { call, bodyText: pieces.map((piece) => piece.text ?? "").join(""), result: emptyResult(url) };
}

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
    const include = /^<(@([A-Za-z0-9._-]*))?[ \t]+(.+?)\s*$/.exec(line);
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

async function resolveIncludePath(ctx: MaterializeContext, raw: string): Promise<string> {
  const primary = tidyPath(resolvePath(ctx.dir, raw));
  const rooted = isWindowsPath(raw) || raw.startsWith("/") || raw.startsWith("\\");
  if (rooted || !ctx.workspace) return primary;
  if (await ctx.exists(primary)) return primary;
  const alternate = tidyPath(resolvePath(ctx.workspace, raw));
  if (alternate !== primary && (await ctx.exists(alternate))) return alternate;
  return primary;
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await fileStamp(path);
    return true;
  } catch {
    return false;
  }
}

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

function substitute(
  text: string,
  vars: Map<string, string>,
  cache: Map<string, Captured>,
  dotenv: Map<string, string>,
  env: Map<string, string | null>,
  now: Date,
  prompts: HttpPrompt[] | null,
  answers: Map<string, string>,
  ask?: (name: string, description: string) => string | null
): string {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (token, raw: string) => {
    const expr = raw.trim();
    const ref = /^([\w.-]+)\.(response|request)\.(body|headers)\.([\s\S]+)$/.exec(expr);
    if (ref) {
      const captured = cache.get(ref[1]);
      if (!captured) return token;
      const value = lookupCaptured(captured, ref[2] as "response" | "request", ref[3] as "body" | "headers", ref[4]);
      return value === null ? token : value;
    }
    if (expr.startsWith("$")) {
      const value = systemValue(expr, dotenv, env, now);
      return value === null ? token : value;
    }
    const prompt = prompts?.find((item) => item.name === expr);
    if (prompt) {
      if (!answers.has(expr)) {
        const answer = ask?.(expr, prompt.description);
        if (answer === null || answer === undefined) return token;
        answers.set(expr, answer);
      }
      return answers.get(expr) ?? token;
    }
    if (vars.has(expr)) return vars.get(expr) ?? "";
    return token;
  });
}

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

function systemValue(
  expr: string,
  dotenv: Map<string, string>,
  env: Map<string, string | null>,
  now: Date
): string | null {
  const body = expr.slice(1).trim();
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
  if (name === "timestamp") return String(shift(now, rest).getTime());
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

function stringifyJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

interface XmlEl {
  name: string;
  attrs: Record<string, string>;
  children: XmlEl[];
  text: string;
}

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

function collectXml(nodes: XmlEl[], name: string, deep: boolean, bag: XmlEl[]) {
  for (const node of nodes) {
    if (node.name === name) bag.push(node);
    if (deep) collectXml(node.children, name, true, bag);
  }
}

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

function fillXmlText(node: XmlEl): string {
  if (node.name === "#text") return node.text;
  const value = node.children.map((child) => fillXmlText(child)).join("");
  node.text = value;
  node.children = node.children.filter((child) => child.name !== "#text");
  return value;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

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

async function defaultReadText(path: string): Promise<string> {
  const file = await readFile(path);
  return file.contents;
}

function defaultSend(call: HttpCall): Promise<HttpResult> {
  return invoke<HttpResult>("http_exchange", { request: call });
}

function defaultPrompt(name: string, description: string): string | null {
  if (typeof window === "undefined" || typeof window.prompt !== "function") return null;
  return window.prompt(description || name, "");
}

async function defaultProcessEnv(name: string): Promise<string | null> {
  return invoke<string | null>("http_env", { name });
}
