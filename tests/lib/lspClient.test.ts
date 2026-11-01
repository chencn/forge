import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lspManager } from "../../src/lib/lspManager";
import { lspResolveRoot, lspStart } from "../../src/lib/lsp";
import type { LspConfig } from "../../src/lib/lspConfig";

/**
 * didChange 防抖的行为测试：驱动真实的 reconcileLsp 流程，
 * 断言「150ms 内多次 reconcile 只发一次 didChange、版本号连续」。
 *
 * 只 mock 边界：后端 IPC（lib/lsp）、事件订阅、窗口标签。lspConfig / format / lspUri
 * 是纯函数，用真实现，语言归属、路径归一与 URI 写法不用在这里另测。
 *
 * 集中放在 tests/lib/，目录与 src/lib 镜像（团队约定的集中式测试布局）。
 * 注意 vi.mock 的说明符按本文件解析，要和被测模块内部的 import 落到同一文件。
 */

const { listeners, writes } = vi.hoisted(() => ({
  /** 模拟后端事件：键是事件名，值是最后注册的那个 handler。 */
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  /** lspWrite 收到的全部消息，按发出顺序。 */
  writes: [] as { id: string; body: string }[],
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => listeners.delete(name));
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/lib/lsp", () => ({
  lspStart: vi.fn().mockResolvedValue("sess-1"),
  lspStop: vi.fn().mockResolvedValue(undefined),
  lspWrite: vi.fn((_id: string, body: string) => {
    writes.push({ id: _id, body });
    return Promise.resolve();
  }),
  lspFailed: vi.fn().mockResolvedValue(undefined),
  lspResolveRoot: vi.fn().mockResolvedValue({ root: "D:/proj", marker: "package.json" }),
}));

vi.mock("../../src/lib/window", () => ({
  windowLabel: "main",
}));

const config: LspConfig = {
  version: 1,
  servers: {
    tsserver: {
      mode: "lsp",
      program: "typescript-language-server",
      path: "",
      args: "--stdio",
      languages: ["typescript"],
      rootMarkers: ["package.json"],
      installCommand: "",
      uninstallCommand: "",
      startupTimeoutMs: 30000,
      homepage: "",
      installHint: "",
      initOptions: null,
      supportsBuiltin: false,
    },
  },
};

/** 把挂着的 microtask 链冲干净：启动流程全靠 await 串联，几十层足够落定。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 64; i += 1) await Promise.resolve();
}

function messages(): { method?: string; id?: unknown; params?: any }[] {
  return writes.map((write) => JSON.parse(write.body));
}

function notifications(method: string): any[] {
  return messages().filter((message) => message.method === method).map((message) => message.params);
}

/** 找出最新发出的 initialize 请求并回一条响应，让启动流程走完。 */
function respondInitialize(capabilities: Record<string, unknown> = {}): void {
  const request = messages()
    .filter((message) => message.method === "initialize")
    .at(-1);
  if (!request) throw new Error("initialize 请求还没发出");
  const handler = listeners.get("lsp://message");
  if (!handler) throw new Error("消息订阅还没挂上");
  handler({
    payload: {
      id: "sess-1",
      body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { capabilities } }),
    },
  });
}

/** 起一条会话并等它 ready：发 didOpen 之前的一切都替它走完。 */
async function startServerWith(...docs: { path: string; language: string; text: string }[]) {
  return startServerWithCapabilities({}, ...docs);
}

async function startServerWithCapabilities(
  capabilities: Record<string, unknown>,
  ...docs: { path: string; language: string; text: string }[]
) {
  const started = lspManager.reconcile("D:/proj", config, docs);
  await flush();
  respondInitialize(capabilities);
  await started;
}

async function sendServerRequest(method: string, params: unknown): Promise<void> {
  const handler = listeners.get("lsp://message");
  if (!handler) throw new Error("消息订阅还没挂上");
  handler({
    payload: {
      id: "sess-1",
      body: JSON.stringify({ jsonrpc: "2.0", id: `server-${method}`, method, params }),
    },
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  listeners.clear();
  writes.length = 0;
});

afterEach(async () => {
  await lspManager.shutdown();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("didChange 防抖", () => {
  it("路由查询返回编辑器当前实际使用的服务和项目根", async () => {
    const doc = { path: "D:/proj/src/a.ts", language: "typescript", text: "v1" };
    await startServerWith(doc);

    expect(lspManager.route(doc.path, doc.language)).toEqual({
      language: "typescript",
      serverId: "tsserver",
      root: "d:/proj",
      status: "running",
    });
  });

  it("路由失败状态按项目根隔离，不污染另一个工程", async () => {
    vi.mocked(lspStart).mockRejectedValueOnce("启动失败");
    const doc = { path: "D:/proj/src/a.ts", language: "typescript", text: "v1" };
    await lspManager.reconcile("D:/proj", config, [doc]);

    expect(lspManager.route(doc.path, doc.language).status).toBe("missing");
    expect(lspManager.route("D:/other/src/a.ts", doc.language).status).toBe("starting");
  });

  it("手动唤醒按项目根隔离，并且没有打开文件时不被空对档立即收掉", async () => {
    await startServerWith({ path: "D:/proj/src/a.ts", language: "typescript", text: "v1" });
    vi.mocked(lspResolveRoot).mockResolvedValueOnce({ root: "D:/other", marker: "package.json" });

    const waking = lspManager.wake("D:/other", config, "tsserver", []);
    await flush();
    respondInitialize();
    await expect(waking).resolves.toMatchObject({ state: "started", root: "d:/other" });

    expect(lspStart).toHaveBeenCalledTimes(2);
    expect(lspManager.route("D:/other/src/b.ts", "typescript").status).toBe("running");
  });

  it("按服务端能力执行 willSaveWaitUntil，并在写盘后发送 didSave", async () => {
    await startServerWithCapabilities(
      { textDocumentSync: { willSave: true, willSaveWaitUntil: true, save: { includeText: true } } },
      { path: "D:/proj/a.ts", language: "typescript", text: "v1" },
    );
    const saving = lspManager.willSave("D:/proj/a.ts", "typescript", "manual");
    await flush();
    const willSave = messages().find((message) => message.method === "textDocument/willSave");
    expect(willSave?.params).toMatchObject({ reason: 1, textDocument: { uri: "file:///d%3A/proj/a.ts" } });
    const request = messages().find((message) => message.method === "textDocument/willSaveWaitUntil");
    const handler = listeners.get("lsp://message");
    if (!handler || request?.id === undefined) throw new Error("willSaveWaitUntil 请求还没发出");
    handler({
      payload: {
        id: "sess-1",
        body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: "V1" }] }),
      },
    });
    await expect(saving).resolves.toHaveLength(1);
    lspManager.didSave("D:/proj/a.ts", "typescript", "V1");
    expect(messages().find((message) => message.method === "textDocument/didSave")?.params).toEqual({
      textDocument: { uri: "file:///d%3A/proj/a.ts" },
      text: "V1",
    });
    const methods = messages().map((message) => message.method);
    expect(methods.indexOf("initialize")).toBeLessThan(methods.indexOf("initialized"));
    expect(methods.indexOf("initialized")).toBeLessThan(methods.indexOf("textDocument/didOpen"));
    expect(methods.indexOf("textDocument/didOpen")).toBeLessThan(methods.indexOf("textDocument/willSave"));
    expect(methods.indexOf("textDocument/willSave")).toBeLessThan(methods.indexOf("textDocument/willSaveWaitUntil"));
    expect(methods.indexOf("textDocument/willSaveWaitUntil")).toBeLessThan(methods.indexOf("textDocument/didSave"));
    expect(messages().find((message) => message.method === "initialize")?.params.capabilities.textDocument.synchronization)
      .toMatchObject({ willSave: true, willSaveWaitUntil: true, didSave: true });
  });

  it("服务端没有等待保存能力时不发送请求，但仍发送已声明的生命周期事件", async () => {
    await startServerWithCapabilities(
      { textDocumentSync: { willSave: true, save: true } },
      { path: "D:/proj/a.ts", language: "typescript", text: "v1" },
    );
    await expect(lspManager.willSave("D:/proj/a.ts", "typescript", "focusOut")).resolves.toBeNull();
    expect(notifications("textDocument/willSave")).toHaveLength(1);
    expect(messages().some((message) => message.method === "textDocument/willSaveWaitUntil")).toBe(false);
    lspManager.didSave("D:/proj/a.ts", "typescript", "v1");
    expect(notifications("textDocument/didSave")).toHaveLength(1);
  });

  it("服务端没有 save 能力时不伪造 didSave", async () => {
    await startServerWithCapabilities(
      { textDocumentSync: { willSave: true } },
      { path: "D:/proj/a.ts", language: "typescript", text: "v1" },
    );
    lspManager.didSave("D:/proj/a.ts", "typescript", "v1");
    expect(notifications("textDocument/didSave")).toHaveLength(0);
  });

  it("缓存 initialize capabilities 和 position encoding，供 Manager seam 查询", async () => {
    const started = lspManager.reconcile("D:/proj", config, [
      { path: "D:/proj/a.ts", language: "typescript", text: "v1" },
    ]);
    await flush();
    respondInitialize({ positionEncoding: "utf-8", completionProvider: { triggerCharacters: ["."] } });
    await started;

    expect(lspManager.positionEncoding("D:/proj/a.ts", "typescript")).toBe("utf-8");
    expect(lspManager.capabilities("D:/proj/a.ts", "typescript")).toMatchObject({
      completionProvider: { triggerCharacters: ["."] },
    });
  });

  it("动态注册和注销会派生 capability，并在多个注册共存时保留剩余注册", async () => {
    const doc = { path: "D:/proj/a.ts", language: "typescript", text: "v1" };
    await startServerWithCapabilities({ completionProvider: false }, doc);
    expect(lspManager.capabilities(doc.path, doc.language)?.completionProvider).toBe(false);
    const statusEvents: string[] = [];
    const stopWatching = lspManager.watchStatus((_serverId, status) => statusEvents.push(status));
    statusEvents.length = 0;

    await sendServerRequest("client/registerCapability", {
      registrations: [
        { id: "completion-a", method: "textDocument/completion", registerOptions: { triggerCharacters: ["."] } },
        { id: "completion-b", method: "textDocument/completion", registerOptions: { triggerCharacters: ["#"] } },
      ],
    });
    expect(statusEvents).toContain("ready");
    expect(lspManager.capabilities(doc.path, doc.language)?.completionProvider).toEqual({ triggerCharacters: ["#"] });
    expect(messages().at(-1)).toEqual({ jsonrpc: "2.0", id: "server-client/registerCapability", result: null });

    await sendServerRequest("client/unregisterCapability", {
      unregisterations: [{ id: "completion-b", method: "textDocument/completion" }],
    });
    expect(messages().at(-1)).toEqual({ jsonrpc: "2.0", id: "server-client/unregisterCapability", result: null });
    expect(lspManager.capabilities(doc.path, doc.language)?.completionProvider).toEqual({ triggerCharacters: ["."] });

    await sendServerRequest("client/unregisterCapability", {
      unregisterations: [{ id: "completion-a", method: "textDocument/completion" }],
    });
    expect(lspManager.capabilities(doc.path, doc.language)?.completionProvider).toBe(false);
    stopWatching();
  });

  it("动态注册的坏载荷返回参数错误且不污染静态 capability", async () => {
    const doc = { path: "D:/proj/a.ts", language: "typescript", text: "v1" };
    await startServerWithCapabilities({ definitionProvider: true }, doc);
    await sendServerRequest("client/registerCapability", { registrations: [{ id: "missing-method" }] });

    expect(lspManager.capabilities(doc.path, doc.language)).toMatchObject({ definitionProvider: true });
    expect(messages().at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "server-client/registerCapability",
      error: { code: -32602, message: "动态注册项缺少 id 或 method" },
    });
  });

  it("重启会话后清除上一会话的动态 capability", async () => {
    const doc = { path: "D:/proj/a.ts", language: "typescript", text: "v1" };
    await startServerWithCapabilities({ completionProvider: false }, doc);
    await sendServerRequest("client/registerCapability", {
      registrations: [{ id: "completion", method: "textDocument/completion" }],
    });
    expect(lspManager.capabilities(doc.path, doc.language)?.completionProvider).toEqual({});

    await lspManager.shutdown();
    const restarted = lspManager.reconcile("D:/proj", config, [doc]);
    await flush();
    respondInitialize({ completionProvider: false });
    await restarted;
    expect(lspManager.capabilities(doc.path, doc.language)?.completionProvider).toBe(false);
  });

  it("对 server 请求返回结构化结果，未知方法返回 JSON-RPC 方法未找到错误", async () => {
    await startServerWith({ path: "D:/proj/a.ts", language: "typescript", text: "v1" });
    const handler = listeners.get("lsp://message");
    if (!handler) throw new Error("消息订阅还没挂上");

    handler({
      payload: {
        id: "sess-1",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "server-config",
          method: "workspace/configuration",
          params: { items: [{ section: "typescript" }, { section: "editor" }] },
        }),
      },
    });
    expect(messages().at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "server-config",
      result: [{}, {}],
    });

    handler({
      payload: {
        id: "sess-1",
        body: JSON.stringify({ jsonrpc: "2.0", id: "server-unknown", method: "server/unknown" }),
      },
    });
    expect(messages().at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "server-unknown",
      error: { code: -32601, message: "未实现的 LSP 请求：server/unknown" },
    });
  });

  it("执行 Code Action command 时发送 workspace/executeCommand 的原始参数", async () => {
    // D-23 起 executeCommand 有能力门控：服务得先声明 executeCommandProvider 才发请求。
    await startServerWithCapabilities(
      { executeCommandProvider: { commands: ["fix.import"] } },
      { path: "D:/proj/a.ts", language: "typescript", text: "v1" }
    );
    const pending = lspManager.executeCommand("D:/proj/a.ts", "typescript", "fix.import", ["a.ts"]);
    await flush();
    const request = messages().find((message) => message.method === "workspace/executeCommand");
    expect(request?.params).toEqual({ command: "fix.import", arguments: ["a.ts"] });
    const handler = listeners.get("lsp://message");
    if (!handler || request?.id === undefined) throw new Error("executeCommand 请求还没发出");
    handler({
      payload: {
        id: "sess-1",
        body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { applied: true } }),
      },
    });
    await expect(pending).resolves.toEqual({ applied: true });
  });

  it("raw request 不附加 textDocument，供 workspace/symbol 使用", async () => {
    await startServerWith({ path: "D:/proj/a.ts", language: "typescript", text: "v1" });
    const pending = lspManager.requestRaw("D:/proj/a.ts", "typescript", "workspace/symbol", { query: "value" });
    await flush();
    const request = messages().find((message) => message.method === "workspace/symbol");
    expect(request?.params).toEqual({ query: "value" });
    const handler = listeners.get("lsp://message");
    if (!handler || request?.id === undefined) throw new Error("raw request 还没发出");
    handler({
      payload: {
        id: "sess-1",
        body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: [] }),
      },
    });
    await expect(pending).resolves.toEqual([]);
  });

  it("server 的 workspace/applyEdit 进入 Manager 注册的执行器并返回应用结果", async () => {
    await startServerWith({ path: "D:/proj/a.ts", language: "typescript", text: "v1" });
    const applied: unknown[] = [];
    const detach = lspManager.setWorkspaceEditHandler(async (edit, context) => {
      applied.push({ edit, context });
      return { applied: true };
    });
    const handler = listeners.get("lsp://message");
    if (!handler) throw new Error("消息订阅还没挂上");
    handler({
      payload: {
        id: "sess-1",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "server-edit",
          method: "workspace/applyEdit",
          params: { edit: { changes: {} } },
        }),
      },
    });
    await flush();
    detach();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ context: { positionEncoding: "utf-16", source: "tsserver" } });
    expect(messages().at(-1)).toEqual({ jsonrpc: "2.0", id: "server-edit", result: { applied: true } });
  });

  it("取消未完成请求时发送 $/cancelRequest 并以 cancelled 结束 Promise", async () => {
    await startServerWith({ path: "D:/proj/a.ts", language: "typescript", text: "v1" });
    const controller = new AbortController();
    const pending = lspManager.request(
      "D:/proj/a.ts",
      "typescript",
      "textDocument/hover",
      { position: { line: 0, character: 0 } },
      { signal: controller.signal }
    );
    await flush();
    const request = messages().filter((message) => message.method === "textDocument/hover").at(-1);
    if (!request) throw new Error("hover 请求还没发出");

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(messages().at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: request.id },
    });
  });

  it("didOpen 立即发全文，不等防抖窗口", async () => {
    const doc = { path: "D:/proj/a.ts", language: "typescript", text: "v1" };
    await startServerWith(doc);
    const opened = notifications("textDocument/didOpen");
    expect(opened).toHaveLength(1);
    expect(opened[0].textDocument.version).toBe(1);
    expect(opened[0].textDocument.text).toBe("v1");
  });

  it("150ms 内多次 reconcile 只发一次 didChange，带最新文本", async () => {
    const doc = { path: "D:/proj/a.ts", language: "typescript", text: "v1" };
    await startServerWith(doc);
    const baseline = notifications("textDocument/didChange").length;

    // 连续三轮 reconcile，每轮都换文本；窗口未到，一条也不发。
    for (const text of ["v2", "v3", "v4"]) {
      await lspManager.reconcile("D:/proj", config, [{ ...doc, text }]);
      await flush();
    }
    expect(notifications("textDocument/didChange")).toHaveLength(baseline);

    vi.advanceTimersByTime(150);
    const changes = notifications("textDocument/didChange");
    expect(changes).toHaveLength(baseline + 1);
    expect(changes[baseline].contentChanges[0].text).toBe("v4");
  });

  it("版本号连续递增：didOpen 是 1，防抖发出的 didChange 依次是 2、3", async () => {
    const doc = { path: "D:/proj/a.ts", language: "typescript", text: "v1" };
    await startServerWith(doc);

    await lspManager.reconcile("D:/proj", config, [{ ...doc, text: "v2" }]);
    await flush();
    vi.advanceTimersByTime(150);

    await lspManager.reconcile("D:/proj", config, [{ ...doc, text: "v3" }]);
    await flush();
    vi.advanceTimersByTime(150);

    const versions = [
      ...notifications("textDocument/didOpen"),
      ...notifications("textDocument/didChange"),
    ].map((params) => params.textDocument.version);
    expect(versions).toEqual([1, 2, 3]);
  });

  it("会话关闭时撤销还没发出的 didChange，不发到已停的会话上", async () => {
    const docA = { path: "D:/proj/a.ts", language: "typescript", text: "v1" };
    const docB = { path: "D:/proj/b.ts", language: "typescript", text: "w1" };
    await startServerWith(docA, docB);

    // 改一次文本（排进防抖窗口），随后把这份文档从列表里拿掉（另一份还在，会话不撤）：
    // didClose 要立刻发出，排定中的改动必须被撤销，不许到期后发到已关的文档上。
    await lspManager.reconcile("D:/proj", config, [
      { ...docA, text: "v2" },
      { ...docB },
    ]);
    await flush();
    await lspManager.reconcile("D:/proj", config, [{ ...docB }]);
    await flush();
    vi.advanceTimersByTime(150);

    expect(notifications("textDocument/didClose")).toHaveLength(1);
    // didClose 之后不许再出现针对该文档的 didChange。
    expect(notifications("textDocument/didChange")).toHaveLength(0);
  });

  it("undo 回到已发文本时取消排定中的 didChange，不把中间态发给 server", async () => {
    const doc = { path: "D:/proj/a.ts", language: "typescript", text: "v1" };
    await startServerWith(doc);
    const baseline = notifications("textDocument/didChange").length;

    // 改一版（排进防抖窗口），随后 undo 回到与已发一致的 v1：
    // 排定的定时器要被取消，到期后不发出任何 didChange。
    await lspManager.reconcile("D:/proj", config, [{ ...doc, text: "v2" }]);
    await flush();
    await lspManager.reconcile("D:/proj", config, [{ ...doc, text: "v1" }]);
    await flush();
    vi.advanceTimersByTime(150);

    expect(notifications("textDocument/didChange")).toHaveLength(baseline);
  });

  it("多工作区切换激活根时回收未激活根的 LSP 会话，且切回时复用已解析的 root 缓存", async () => {
    const lspMod = await import("../../src/lib/lsp");
    const docA = { path: "D:/proj/a.ts", language: "typescript", text: "const a = 1;" };
    await startServerWith(docA);
    expect(lspMod.lspResolveRoot).toHaveBeenCalledTimes(1);

    // 切到空文档的另一工程根 B（只向 reconcileLsp 传当前激活根的文档）：A 根的 LSP 会话应被回收
    await lspManager.reconcile("D:/proj-b", config, []);
    await flush();
    expect(lspMod.lspStop).toHaveBeenCalledWith("sess-1");

    // 再次切回 D:/proj：roots 缓存未被切根清空，无需重复调用 lspResolveRoot
    const back = lspManager.reconcile("D:/proj", config, [docA]);
    await flush();
    respondInitialize();
    await back;
    expect(lspMod.lspResolveRoot).toHaveBeenCalledTimes(1);
  });
});

describe("档位与进程", () => {
  const doc = { path: "D:/proj/a.ts", language: "typescript", text: "v1" };
  const tsConfig = (mode: "off" | "builtin" | "lsp"): LspConfig => ({
    version: 2,
    servers: {
      typescript: {
        mode,
        program: "typescript-language-server",
        path: "",
        args: "--stdio",
        languages: ["typescript"],
        rootMarkers: ["package.json"],
        installCommand: "",
        uninstallCommand: "",
        startupTimeoutMs: 30_000,
        homepage: "",
        installHint: "",
        initOptions: null,
        supportsBuiltin: true,
      },
    },
  });

  /**
   * 编辑器换成 CodeMirror 之后没有「渲染进程里的内置 tsserver」可退，
   * `builtin` 档起的也是表里预置的那条外部服务——这一条断言就是那件事。
   */
  it("builtin 档起预置的那条服务，并把文档 didOpen 过去", async () => {
    const started = lspManager.reconcile("D:/proj", tsConfig("builtin"), [doc]);
    await flush();
    respondInitialize();
    await started;
    expect(vi.mocked(lspStart)).toHaveBeenCalledTimes(1);
    expect(notifications("textDocument/didOpen")).toHaveLength(1);
  });

  it("off 档一条进程都不起", async () => {
    await lspManager.reconcile("D:/proj", tsConfig("off"), [doc]);
    await flush();
    expect(vi.mocked(lspStart)).not.toHaveBeenCalled();
    expect(notifications("textDocument/didOpen")).toHaveLength(0);
  });

  it("主候选启动失败后按配置顺序启动 fallback，且只打开一条会话", async () => {
    const fallbackConfig: LspConfig = {
      version: 1,
      servers: {
        primary: {
          ...tsConfig("lsp").servers.typescript,
          program: "primary-language-server",
        },
        fallback: {
          ...tsConfig("lsp").servers.typescript,
          program: "fallback-language-server",
        },
      },
    };
    vi.mocked(lspStart)
      .mockRejectedValueOnce("LSP_NOT_FOUND\u0001primary-language-server")
      .mockResolvedValueOnce("sess-1");

    const started = lspManager.reconcile("D:/proj", fallbackConfig, [doc]);
    await flush();
    respondInitialize();
    await started;

    expect(vi.mocked(lspStart).mock.calls.map((call) => call[1])).toEqual(["primary", "fallback"]);
    expect(notifications("textDocument/didOpen")).toHaveLength(1);
    expect(notifications("textDocument/didOpen")[0].textDocument.uri).toContain("a.ts");
  });
});
