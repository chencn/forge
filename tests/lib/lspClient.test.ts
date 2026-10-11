import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileLsp, shutdownLsp } from "../../src/lib/lspClient";
import type { LspConfig } from "../../src/lib/lspConfig";

/**
 * didChange 防抖的行为测试：驱动真实的 reconcileLsp 流程，
 * 断言「150ms 内多次 reconcile 只发一次 didChange、版本号连续」。
 *
 * 只 mock 边界：后端 IPC（lib/lsp）、事件订阅、窗口标签与 Monaco（模块顶层就会求值
 * CompletionItemKind 表，node 环境加载不了真的 monaco-editor）。lspConfig / format
 * 是纯函数，用真实现，语言归属与路径归一不用另测。
 *
 * 集中放在 tests/lib/，目录与 src/lib 镜像（团队约定的集中式测试布局）。
 * 注意 vi.mock 的说明符按本文件解析，要和被测模块内部的 import 落到同一文件。
 */

const { listeners, writes, COMPLETION_KIND_NAMES, SYMBOL_KIND_NAMES } = vi.hoisted(() => ({
  /** 模拟后端事件：键是事件名，值是最后注册的那个 handler。 */
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  /** lspWrite 收到的全部消息，按发出顺序。 */
  writes: [] as { id: string; body: string }[],
  /** Monaco 的两套枚举名，mock 工厂按顺序编上号（见被测模块里的两张映射表）。 */
  COMPLETION_KIND_NAMES: [
    "Text", "Method", "Function", "Constructor", "Field", "Variable", "Class",
    "Interface", "Module", "Property", "Unit", "Value", "Enum", "Keyword",
    "Snippet", "Color", "File", "Reference", "Folder", "EnumMember", "Constant",
    "Struct", "Event", "Operator", "TypeParameter",
  ] as const,
  SYMBOL_KIND_NAMES: [
    "File", "Module", "Namespace", "Package", "Class", "Method", "Property",
    "Field", "Constructor", "Enum", "Interface", "Function", "Variable",
    "Constant", "String", "Number", "Boolean", "Array", "Object", "Key", "Null",
    "EnumMember", "Struct", "Event", "Operator", "TypeParameter",
  ] as const,
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

vi.mock("../../src/lib/monacoEditor", () => ({
  monaco: {
    Uri: {
      // 键只要自洽即可：测试里 didOpen / didChange / didClose 用同一套 URI。
      file: (path: string) => ({ toString: () => `file://${path}`, fsPath: path }),
      parse: (raw: string) => ({ toString: () => raw, fsPath: raw }),
    },
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    languages: {
      CompletionItemKind: Object.fromEntries(
        COMPLETION_KIND_NAMES.map((name, index) => [name, index + 1])
      ),
      SymbolKind: Object.fromEntries(SYMBOL_KIND_NAMES.map((name, index) => [name, index])),
      registerHoverProvider: vi.fn(),
      registerCompletionItemProvider: vi.fn(),
      registerReferenceProvider: vi.fn(),
      registerDefinitionProvider: vi.fn(),
      registerDocumentSymbolProvider: vi.fn(),
    },
    editor: {
      getModel: vi.fn(() => null),
      getModels: vi.fn(() => []),
      setModelMarkers: vi.fn(),
    },
    typescript: {
      typescriptDefaults: { setModeConfiguration: vi.fn() },
      javascriptDefaults: { setModeConfiguration: vi.fn() },
    },
  },
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
      startupTimeoutMs: 30000,
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

/** 找出已发出的 initialize 请求并回一条响应，让启动流程走完。 */
function respondInitialize(): void {
  const request = messages().find((message) => message.method === "initialize");
  if (!request) throw new Error("initialize 请求还没发出");
  const handler = listeners.get("lsp://message");
  if (!handler) throw new Error("消息订阅还没挂上");
  handler({
    payload: {
      id: "sess-1",
      body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { capabilities: {} } }),
    },
  });
}

/** 起一条会话并等它 ready：发 didOpen 之前的一切都替它走完。 */
async function startServerWith(...docs: { path: string; language: string; text: string }[]) {
  const started = reconcileLsp("D:/proj", config, docs);
  await flush();
  respondInitialize();
  await started;
}

beforeEach(() => {
  vi.useFakeTimers();
  listeners.clear();
  writes.length = 0;
});

afterEach(async () => {
  await shutdownLsp();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("didChange 防抖", () => {
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
      await reconcileLsp("D:/proj", config, [{ ...doc, text }]);
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

    await reconcileLsp("D:/proj", config, [{ ...doc, text: "v2" }]);
    await flush();
    vi.advanceTimersByTime(150);

    await reconcileLsp("D:/proj", config, [{ ...doc, text: "v3" }]);
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
    await reconcileLsp("D:/proj", config, [
      { ...docA, text: "v2" },
      { ...docB },
    ]);
    await flush();
    await reconcileLsp("D:/proj", config, [{ ...docB }]);
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
    await reconcileLsp("D:/proj", config, [{ ...doc, text: "v2" }]);
    await flush();
    await reconcileLsp("D:/proj", config, [{ ...doc, text: "v1" }]);
    await flush();
    vi.advanceTimersByTime(150);

    expect(notifications("textDocument/didChange")).toHaveLength(baseline);
  });
});
