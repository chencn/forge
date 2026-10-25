import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiOutlineSnapshot, AiRuntimeSnapshot } from "../../src/lib/aiRuntime";
import { loadDraft, rememberPrompt } from "../../src/lib/aiDrafts";

const h = vi.hoisted(() => ({ state: {} as AiRuntimeSnapshot, outline: { turns: [], complete: false, loaded: false, loading: false, error: null } as AiOutlineSnapshot, activity: "idle", ownedRun: null as string | null, ownedQueued: [] as string[], desktop: true, send: vi.fn(), moveQueued: vi.fn(), older: vi.fn(), outlineLoad: vi.fn(), through: vi.fn(), beforeSend: vi.fn(), sanitize: vi.fn((html: string, _config: unknown) => html) }));
vi.mock("../../src/i18n", () => ({ useI18n: () => ({ t: (key: string, vars?: Record<string, unknown>) => key === "ai.chat.editedFiles" ? `Edited ${vars?.count} files` : key }) }));
vi.mock("../../src/lib/aiCli", () => ({ AI_NAMES: { codex: "Codex" }, cliDesktopAvailable: () => h.desktop }));
vi.mock("../../src/lib/aiRuntime", () => ({ useAiRuntime: () => h.state, useAiOutline: () => h.outline, useAiSessionActivity: () => h.activity, useAiOwnedRunId: () => h.ownedRun, useAiOwnedQueuedRunIds: () => h.ownedQueued, loadAiMessages: vi.fn(), loadAiOutline: h.outlineLoad, loadAiMessagesThrough: h.through, loadOlderAiMessages: h.older, moveQueuedAiTask: h.moveQueued, respondAiRequest: vi.fn(), sendAiMessage: h.send, stopAiRun: vi.fn() }));
vi.mock("../../src/lib/fs", () => ({ openExternal: vi.fn(), assetUrl: (path: string) => `asset://${path}` }));
vi.mock("dompurify", () => ({ default: { sanitize: h.sanitize } }));
import AiSessionPane from "../../src/components/AiSessionPane";

let number = 0;
let sessionId = "";
/**
 * 草稿与发送历史都存在 localStorage 里，静态渲染每次都是一次全新挂载：面板靠这两个存储
 * 把输入框的内容带过下一次渲染（原来那份模块级 `Map` 也是同一件事）。
 * 所以这里给一个真实的内存存储，而不是把 `loadDraft` 也 mock 掉。
 */
let storage = new Map<string, string>();
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  h.activity = "idle";
  h.ownedRun = null; h.ownedQueued = [];
  h.outline = { turns: [], complete: false, loaded: false, loading: false, error: null };
  sessionId = `pane-${++number}`; h.desktop = true; h.send.mockReset(); h.moveQueued.mockReset(); h.moveQueued.mockResolvedValue(undefined); h.older.mockReset(); h.older.mockResolvedValue(undefined); h.outlineLoad.mockReset(); h.outlineLoad.mockResolvedValue(undefined); h.through.mockReset(); h.through.mockResolvedValue(true); h.beforeSend.mockReset(); h.beforeSend.mockResolvedValue(true); h.sanitize.mockClear();
  h.state = { entries: [], requests: [], tasks: [], runId: null, status: "idle", stopping: false, error: null, loading: false, loaded: true, hasOlder: false, cursor: 0, nativeId: null, plans: [] };
});
function render() {
  let pane!: ReactElement<any>;
  function Harness() {
    pane = AiSessionPane({ session: { id: sessionId, title: "Test", provider: "codex", createdAt: 1 }, workspace: "D:/project", onSettings: vi.fn(), beforeSend: h.beforeSend });
    return pane;
  }
  return { html: renderToStaticMarkup(createElement(Harness)), pane };
}
function textarea(pane: ReactElement<any>): ReactElement<any> {
  return findAll(pane, "textarea")[0] ?? (undefined as unknown as ReactElement<any>);
}
/** 收集渲染树里所有 `<img>`：附件回显的 onError 只能从元素 props 上取，静态 HTML 里没有。 */
function pictures(pane: ReactElement<any>): ReactElement<any>[] {
  return findAll(pane, "img");
}
function findAll(pane: ReactElement<any>, type: unknown): ReactElement<any>[] {
  if (!pane || typeof pane !== "object" || !("props" in pane)) return [];
  // 匹配到父容器后仍需遍历子节点，否则找不到嵌套滚动容器。
  const matches = pane.type === type ? [pane] : [];
  // 输入框外壳与用户消息组件把子内容放在具名 prop（甚至包在普通对象数组）里，
  // 不止 children；逐层摊开所有对象值里的 React 元素才能找齐。
  const unwrap = (value: unknown): ReactElement<any>[] =>
    [value].flat(Infinity).flatMap((item) =>
      !item || typeof item !== "object" ? [] :
      "props" in item ? [item as ReactElement<any>] :
      unwrap(Object.values(item)));
  return [...matches, ...unwrap(pane.props).flatMap((child) => findAll(child, type))];
}
/**
 * 面板内部的私有组件在静态树里还是没展开的元素（它的按钮是在函数体里造的，
 * 不是当 children 传进去的）。按组件函数名取到它的 props，才能调用面板交给它的回调。
 */
function propsOfComponent(pane: ReactElement<any>, name: string): Record<string, unknown> | undefined {
  const stack: unknown[] = [pane];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    const node = item as { type?: unknown; props?: unknown };
    if (typeof node.type === "function" && (node.type as { name?: string }).name === name) return node.props as Record<string, unknown>;
    if (node.props && typeof node.props === "object") stack.push(...[Object.values(node.props as Record<string, unknown>)].flat(Infinity));
  }
  return undefined;
}

describe("AI conversation pane", () => {
  it.each(["external", "unknown"])("keeps input usable for external activity or unavailable detection: %s", async (activity) => {
    textarea(render().pane).props.onChange({ target: { value: "hello" } });
    // 共享历史仍残留 running，也不能把别的进程画成本窗口可停止的任务。
    h.state.status = "running"; h.state.runId = "foreign";
    h.activity = activity;
    const { pane, html } = render();
    expect(textarea(pane).props.disabled).toBe(false);
    expect(html).not.toContain('aria-label="ai.runtime.stop"');
    textarea(pane).props.onKeyDown({ key: "Enter", ctrlKey: true, nativeEvent: {}, preventDefault: vi.fn() });
    textarea(pane).props.onKeyDown({ key: "Enter", nativeEvent: {}, preventDefault: vi.fn() });
    await Promise.resolve();
    expect(h.beforeSend).toHaveBeenCalled();
    h.activity = "idle";
    expect(textarea(render().pane).props.disabled).toBe(false);
  });
  it("completes slash names with Tab and retains parameter guidance after a space", () => {
    textarea(render().pane).props.onChange({ target: { value: "/rev" } });
    const { pane, html } = render();
    expect(html).toContain('role="listbox"');
    const preventDefault = vi.fn();
    textarea(pane).props.onKeyDown({ key: "Tab", nativeEvent: {}, preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    const completed = render();
    expect(textarea(completed.pane).props.value).toBe("/review ");
    expect(completed.html).toContain("[instructions]");
    expect(completed.html).not.toContain('class="ai-command-menu"');
    expect(h.send).not.toHaveBeenCalled();
  });
  it.each([{ isComposing: true }, { keyCode: 229 }])("never completes or sends during IME composition: %j", (nativeEvent) => {
    textarea(render().pane).props.onChange({ target: { value: "/review" } });
    const preventDefault = vi.fn();
    const field = textarea(render().pane);
    field.props.onKeyDown({ key: "Enter", nativeEvent, preventDefault });
    field.props.onKeyDown({ key: "Enter", ctrlKey: true, nativeEvent, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
    expect(textarea(render().pane).props.value).toBe("/review");
  });
  it.each(["/unknown args", "/compact extra", "/compact"])("rejects unsupported command or parameters before trust and retains draft: %s", async (draft) => {
    textarea(render().pane).props.onChange({ target: { value: draft } });
    textarea(render().pane).props.onKeyDown({ key: "Enter", ctrlKey: true, nativeEvent: {}, preventDefault: vi.fn() });
    await Promise.resolve();
    expect(h.send).not.toHaveBeenCalled(); expect(h.beforeSend).not.toHaveBeenCalled();
    expect(textarea(render().pane).props.value).toBe(draft);
  });
  it("allows local help through both button and keyboard while history is incomplete", async () => {
    textarea(render().pane).props.onChange({ target: { value: "/help" } });
    h.state.loaded = false; h.state.hasOlder = true;
    const { pane, html } = render();
    expect(html.match(/<button[^>]*class="ai-send-button"[^>]*>/)?.[0]).not.toContain("disabled");
    textarea(pane).props.onKeyDown({ key: "Enter", ctrlKey: true, nativeEvent: {}, preventDefault: vi.fn() });
    await Promise.resolve();
    expect(textarea(render().pane).props.value).toBe("");
    expect(h.send).not.toHaveBeenCalled(); expect(h.beforeSend).not.toHaveBeenCalled();
  });
  it("shows local command output with the same sanitization as assistant messages", () => {
    h.state.entries = [{ id: "output", runId: "run", kind: "command", text: "**command result**" }];
    const { html } = render();
    expect(html).toContain("ai.commands.output"); expect(h.sanitize).toHaveBeenCalled();
  });
  it("shows compact model, effort and honest context controls", () => {
    h.state.configuration = { model: "effective-model", effort: "high" };
    h.state.usage = { context: 250, window: 1000, total: 8000 };
    const { html } = render();
    expect(html).toContain("ai-settings-chip"); expect(html).toContain("effective-model");
    expect(html).toContain("25%");
  });
  it("keeps controls in one composer and hides settings and usage details until requested", () => {
    const { html } = render();
    expect(html).toContain('class="ai-composer-dock"');
    expect(html).toContain('class="ai-composer-bar"');
    expect(html).toContain("ai-settings-chip");
    expect(html).toContain('class="ai-send-button"');
    expect(html).not.toContain("<select");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("ai.chat.inputTokens");
    expect(html).not.toContain("ai.chat.modelId");
  });
  it("accepts pasted image files in the composer", () => {
    expect(textarea(render().pane).props.onPaste).toBeTypeOf("function");
  });
  it("offers a picker entry in the action bar and no drop hint until a drag is over", () => {
    const { html, pane } = render();
    const attach = findAll(pane, "button").find((button) => button.props.className === "ai-add-button");
    expect(attach).toBeTruthy();
    expect(attach!.props["aria-label"]).toBe("ai.chat.attach");
    expect(attach!.props.disabled).toBe(false);
    expect(html).not.toContain('class="ai-composer-drop"');
    // CLI 不在本机时和其他输入控件一起停用，不给点了没反应的入口。
    h.desktop = false;
    const offline = findAll(render().pane, "button").find((button) => button.props.className === "ai-add-button");
    expect(offline!.props.disabled).toBe(true);
    h.desktop = true;
  });
  it("says plainly when an echoed attachment is no longer in the cache", () => {
    h.state.entries = [{ id: "u", runId: "run", kind: "user", text: "看图", images: ["C:/cache/paste-1.png"] }];
    const { pane, html } = render();
    expect(html).toContain('src="asset://C:/cache/paste-1.png"');
    const [image] = pictures(pane);
    const classList = { add: vi.fn() };
    const target = { alt: "paste-1.png", classList };
    image.props.onError({ currentTarget: target });
    // 坏图本来就显示 alt：换成一句实话，而不是编一张占位图。
    expect(target.alt).toBe("ai.chat.imageMissing");
    expect(classList.add).toHaveBeenCalledWith("is-missing");
  });
  it("summarizes edited files and real line churn", () => {
    h.state.entries = [
      { id: "edit-a", runId: "run", kind: "tool", text: "", name: "fileChange", status: "completed", input: { changes: [{ path: "a.ts", kind: { type: "update" }, diff: "@@ -1,20 +1,3 @@\n" + Array.from({ length: 20 }, (_, index) => `-old-${index}`).join("\n") + "\n" + Array.from({ length: 3 }, (_, index) => `+new-${index}`).join("\n") }] } },
      { id: "edit-b", runId: "run", kind: "tool", text: "", name: "fileChange", status: "completed", input: { changes: [{ path: "b.ts", kind: { type: "update" }, diff: "@@ -1,24 +1,4 @@\n" + Array.from({ length: 24 }, (_, index) => `-before-${index}`).join("\n") + "\n" + Array.from({ length: 4 }, (_, index) => `+after-${index}`).join("\n") }] } },
    ];
    const { html } = render();
    expect(html).toContain("Edited 2 files");
    expect(html).toContain("+7");
    expect(html).toContain("-44");
  });
  it("keeps tool calls and reasoning collapsed and gives them expansion affordances", () => {
    h.state.entries = [
      { id: "tool", runId: "run", kind: "tool", text: "", name: "Read", status: "completed" },
      { id: "reasoning", runId: "run", kind: "reasoning", text: "summary" },
    ];
    const { html } = render();
    expect(html).toContain('class="ai-tool is-completed"');
    expect(html).toContain('class="ai-reasoning"');
    expect(html.match(/<details[^>]*open/g)).toBeNull();
    expect(html.match(/ai-detail-chevron/g)).toHaveLength(2);
  });
  it("keeps unknown context honest and uses an accessible icon-only stop control", () => {
    h.state.status = "running"; h.state.runId = "run";
    h.state.tasks = [{ runId: "run", status: "running", seq: 1 }];
    h.activity = "running"; h.ownedRun = "run";
    const { html } = render();
    expect(html).toContain('aria-label="ai.chat.context --"');
    expect(html).not.toContain('aria-label="ai.chat.context 0%"');
    expect(html).toContain('class="ai-send-button is-stop"');
    expect(html).toContain('aria-label="ai.runtime.stop"');
  });
  it("连接阶段可中断，但不会伪装成可编辑队列", () => {
    h.state.status = "submitting"; h.state.runId = "connecting";
    h.state.tasks = [{ runId: "connecting", status: "submitting", seq: 1, prompt: "hello" }];
    h.activity = "running"; h.ownedRun = "connecting";
    const { html } = render();
    expect(html).toContain("ai.runtime.submitting");
    expect(html).toContain('aria-label="ai.runtime.stop"');
    expect(html).not.toContain('aria-label="ai.runtime.editQueued"');
  });
  it("其他窗口的队列只读展示，不暴露本窗口控制按钮", () => {
    h.state.tasks = [{ runId: "foreign-queue", status: "queued", seq: 1, prompt: "later" }];
    h.state.status = "queued"; h.state.runId = "foreign-queue"; h.activity = "queued";
    const { html } = render();
    expect(html).toContain("ai.runtime.otherWindow");
    expect(html).not.toContain('aria-label="ai.runtime.runQueuedNow"');
    expect(html).not.toContain('aria-label="ai.runtime.cancelQueued"');
    expect(html).not.toContain('aria-label="ai.runtime.stop"');
  });
  it("任务队列默认展开，并把折叠按钮与正文关联起来", () => {
    h.state.tasks = [{ runId: "queued", status: "queued", seq: 1, prompt: "later" }];
    h.ownedQueued = ["queued"];
    const { html } = render();
    const toggle = html.match(/class="ai-task-queue-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="([^"]+)"/);
    expect(toggle?.[1]).toBeTruthy();
    // aria-controls 必须指向实际正文；屏幕阅读器才能把按钮和被折叠区域对应起来。
    expect(html).toContain(`class="ai-task-queue-list" id="${toggle![1]}"`);
  });
  it("用方向键按稳定 runId 调整自己的队列顺序", () => {
    h.state.tasks = [
      { runId: "first", status: "queued", seq: 1, prompt: "first" },
      { runId: "second", status: "queued", seq: 2, prompt: "second" },
      { runId: "third", status: "queued", seq: 3, prompt: "third" },
    ];
    h.ownedQueued = ["first", "second", "third"];
    const handles = findAll(render().pane, "button").filter((button) => button.props.className === "ai-task-drag");
    const preventDefault = vi.fn();
    // 向上就是插到前一项前；向下到队尾用 null 表达，避免依赖可变序号。
    handles[1].props.onKeyDown({ key: "ArrowUp", preventDefault });
    handles[1].props.onKeyDown({ key: "ArrowDown", preventDefault });
    expect(h.moveQueued).toHaveBeenNthCalledWith(1, "second", "first");
    expect(h.moveQueued).toHaveBeenNthCalledWith(2, "second", null);
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });
  it("拖动整条任务行时按落点调整队列顺序", () => {
    h.state.tasks = [
      { runId: "first", status: "queued", seq: 1, prompt: "first" },
      { runId: "second", status: "queued", seq: 2, prompt: "second" },
      { runId: "third", status: "queued", seq: 3, prompt: "third" },
    ];
    h.ownedQueued = ["first", "second", "third"];
    const rows = findAll(render().pane, "div").filter((item) => String(item.props.className).startsWith("ai-task-queue-item"));
    const dataTransfer = { effectAllowed: "none", dropEffect: "none", setData: vi.fn() };
    const box = { top: 100, height: 40 };
    const preventDefault = vi.fn();
    // 从第二条正文拖到第一条上半区：完整 dragstart → dragover → drop 必须提交一次稳定 id 排序。
    rows[1].props.onDragStart({ target: { closest: () => null }, dataTransfer });
    rows[0].props.onDragOver({ preventDefault, dataTransfer, currentTarget: { getBoundingClientRect: () => box }, clientY: 105 });
    rows[0].props.onDrop({ preventDefault, currentTarget: { getBoundingClientRect: () => box }, clientY: 105 });
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "second");
    expect(h.moveQueued).toHaveBeenCalledWith("second", "first");
  });
  it("renders approvals at their timeline positions without duplicating them", () => {
    h.state.entries = [
      { id: "before", runId: "run", kind: "assistant", text: "before-marker" },
      { id: "request", runId: "run", kind: "request", requestId: "approval", text: "" },
      { id: "after", runId: "run", kind: "assistant", text: "after-marker" },
    ];
    h.state.requests = [{ requestId: "approval", runId: "run", kind: "permission", title: "approval-marker", detail: "", questions: [], active: true }];
    const { html } = render();
    expect(html.indexOf("before-marker")).toBeLessThan(html.indexOf("approval-marker"));
    expect(html.indexOf("approval-marker")).toBeLessThan(html.indexOf("after-marker"));
    expect(html.match(/class="ai-request-card/g)).toHaveLength(1);
  });
  it.each(["loading", "hasOlder", "unloaded"])("history state does not block native submission: %s", async (guard) => {
    textarea(render().pane).props.onChange({ target: { value: "hello" } });
    if (guard === "loading") h.state.loading = true;
    if (guard === "hasOlder") h.state.hasOlder = true;
    if (guard === "unloaded") h.state.loaded = false;
    const { pane, html } = render();
    const preventDefault = vi.fn();
    textarea(pane).props.onKeyDown({ key: "Enter", ctrlKey: true, nativeEvent: { isComposing: false }, preventDefault });
    await Promise.resolve();
    expect(preventDefault).toHaveBeenCalled(); expect(h.beforeSend).toHaveBeenCalled();
    expect(html.match(/<button[^>]*class="ai-send-button"[^>]*>/)?.[0]).not.toContain("disabled");
  });
  it("browser preview still blocks submission", async () => {
    textarea(render().pane).props.onChange({ target: { value: "hello" } });
    h.desktop = false;
    const { pane, html } = render();
    const preventDefault = vi.fn();
    textarea(pane).props.onKeyDown({ key: "Enter", ctrlKey: true, nativeEvent: { isComposing: false }, preventDefault });
    await Promise.resolve();
    expect(preventDefault).toHaveBeenCalled(); expect(h.beforeSend).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
    expect(html.match(/<button[^>]*class="ai-send-button"[^>]*>/)?.[0]).toContain("disabled");
  });
  it("正常首屏不要求点击加载按钮", () => {
    h.state.entries = Array.from({ length: 301 }, (_, i) => ({ id: String(i), runId: "run", kind: "user", text: `message-${i}` }));
    const { html } = render();
    expect(html).not.toContain("ai.runtime.showEarlier");
    expect(html).not.toContain("ai.runtime.loadOlder");
  });
  it("pins a pending approval above the composer instead of burying it in the timeline", () => {
    h.state.entries = Array.from({ length: 301 }, (_, i) => ({ id: String(i), runId: "run", kind: "user", text: `message-${i}` }));
    h.state.requests = [
      { requestId: "old", runId: "run", kind: "permission", title: "approval-active", detail: "", questions: [], active: true },
      { requestId: "done", runId: "run", kind: "permission", title: "approval-closed", detail: "", questions: [], active: false },
    ];
    const { html } = render();
    // 还在等答复的那张钉在输入框上方；已经答完的属于历史，不再霸占这块地方。
    expect(html).toContain("approval-active");
    expect(html).not.toContain("approval-closed");
    expect(html).toContain('class="ai-session-requests"');
    expect(html.match(/class="ai-request-card/g)).toHaveLength(1);
  });
  it("向上滚动提前请求三页历史，无需点击按钮", () => {
    h.state.hasOlder = true; h.state.cursor = 500;
    const { pane, html } = render();
    expect(html).not.toContain("ai.runtime.loadOlder");
    expect(html).not.toContain("ai.runtime.showEarlier");
    // 底部那条「加载更多记录」是旧语义的产物：首屏就在最新一页，往上翻才是更早。
    expect(html).not.toContain("ai.runtime.loadMore");
    const viewport = findAll(pane, "div").find((item) => item.props.onWheel)!;
    viewport.props.ref.current = { scrollTop: 1200, scrollHeight: 4000, clientHeight: 800, getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [] };
    viewport.props.onWheel({ deltaY: -100 });
    expect(h.older).toHaveBeenCalledWith(sessionId, "D:/project", undefined, 3);
  });
  it("expands the loaded window before asking the backend for another page", () => {
    h.state.hasOlder = true; h.state.cursor = 500;
    h.state.entries = Array.from({ length: 301 }, (_, i) => ({ id: String(i), runId: "run", kind: "user", text: `message-${i}` }));
    const { pane, html } = render();
    expect(html).not.toContain("ai.runtime.showEarlier");
    const viewport = findAll(pane, "div").find((item) => item.props.onWheel)!;
    viewport.props.ref.current = { scrollTop: 1200, scrollHeight: 4000, clientHeight: 800, getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [] };
    viewport.props.onWheel({ deltaY: -100 });
    expect(h.older).not.toHaveBeenCalled();
  });
  it("keeps a half-typed message per session and reloads it on the next render", () => {
    textarea(render().pane).props.onChange({ target: { value: "写到一半" } });
    expect(loadDraft("D:/project", sessionId)).toBe("写到一半");
    expect(loadDraft("D:/project", "别的会话")).toBe("");
    expect(textarea(render().pane).props.value).toBe("写到一半");
  });
  it("不再有信任确认挡路：首条消息直接发出，不弹窗", async () => {
    textarea(render().pane).props.onChange({ target: { value: "直接发这条" } });
    textarea(render().pane).props.onKeyDown({ key: "Enter", nativeEvent: {}, preventDefault: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    // 项目是用户自己打开的：直接信任随请求置位，一次都不弹窗。
    expect(h.send).toHaveBeenCalled();
  });
  it("recalls the last prompt sent in this project with ArrowUp", () => {
    rememberPrompt("D:/project", "上一条发出去的话");
    const preventDefault = vi.fn();
    textarea(render().pane).props.onKeyDown({ key: "ArrowUp", nativeEvent: {}, preventDefault, currentTarget: { selectionStart: 0 } });
    expect(preventDefault).toHaveBeenCalled();
    expect(textarea(render().pane).props.value).toBe("上一条发出去的话");
  });
  it("leaves ↑ to the caret while the user is reading a multi-line draft", () => {
    rememberPrompt("D:/project", "上一条");
    textarea(render().pane).props.onChange({ target: { value: "第一行\n第二行" } });
    const preventDefault = vi.fn();
    textarea(render().pane).props.onKeyDown({ key: "ArrowUp", nativeEvent: {}, preventDefault, currentTarget: { selectionStart: 8 } });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(textarea(render().pane).props.value).toBe("第一行\n第二行");
  });
  it("folds a long run of tool calls into one process group", () => {
    h.state.entries = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, runId: "run", kind: "tool", text: "", name: "Read", status: "completed" as const }));
    const { html } = render();
    expect(html.match(/class="ai-process-group/g)).toHaveLength(1);
    expect(html).toContain("ai.chat.stepsTotal");
    // 收起的那一段不渲染明细：过程折叠的意义就是别把 5 个展开块摊在屏幕上。
    expect(html.match(/class="ai-tool /g)).toBeNull();
  });
  it("puts the failure on the turn that failed as a plain error line, with no retry button", () => {
    h.state.tasks = [{ runId: "r1", status: "failed", prompt: "做个改动", error: "CLI 崩了", seq: 1 }];
    const { html } = render();
    expect(html).toContain('class="ai-turn-error"');
    expect(html).toContain("CLI 崩了");
    // 参考实现没有任何重试按钮：重试就是重发。
    expect(html).not.toContain("ai.chat.retryTurn");
    expect(html).not.toContain('class="ai-turn-actions"');
  });
  it("offers the deeper approval actions only when the backend can take them", () => {
    h.state.requests = [{ requestId: "a", runId: "run", kind: "permission", title: "Edit a.ts", detail: "", questions: [], active: true, toolName: "Edit", input: { file_path: "D:/project/src/a.ts" }, canEdit: true }];
    const { html } = render();
    expect(html).toContain("ai.runtime.allowAndRemember");
    expect(html).toContain("ai.runtime.allowDirectoryNamed");
    expect(html).toContain("ai.runtime.editBeforeAllow");
    h.state.requests = [{ requestId: "b", runId: "run", kind: "permission", title: "Bash", detail: "", questions: [], active: true }];
    const bare = render();
    expect(bare.html).toContain("ai.runtime.allowOnce");
    expect(bare.html).not.toContain("ai.runtime.allowAndRemember");
    expect(bare.html).not.toContain("ai.runtime.editBeforeAllow");
  });
  it("回合末尾挂新增/改动汇总卡：完成轮次的 Write 建档计入新增，运行中的轮次不挂", () => {
    // 真实镜像的事件形态：同一工具 id 的 running → 入参补全 → completed(result) 三段合并成一条。
    h.state.entries = [
      { id: "u", runId: "run", kind: "user", text: "做个东西" },
      { id: "t1", runId: "run", kind: "tool", toolId: "toolu_1", name: "Write", text: "", input: { file_path: "D:/project/images.rs", content: "fn main() {}" }, status: "running" },
      { id: "t2", runId: "run", kind: "tool", toolId: "toolu_1", name: "Write", text: "", input: { file_path: "D:/project/images.rs", content: "fn main() {}" }, status: "running" },
      { id: "t3", runId: "run", kind: "tool", toolId: "toolu_1", name: "Write", text: "", status: "completed",
        output: "ok", result: { type: "create", filePath: "D:/project/images.rs", content: "fn main() {}" } },
      { id: "a1", runId: "run", kind: "assistant", text: "做完了" },
    ];
    h.state.tasks = [{ runId: "run", status: "completed", seq: 1 }];
    const html = render().html;
    expect(html).toContain("ai-artifacts");
    expect(html).toContain("ai.chat.filesAdded");
    expect(html).toContain("images.rs");
    // 运行中的轮次不在末尾挂卡：它还在改。
    h.state.tasks = [{ runId: "run", status: "running", seq: 1 }];
    h.state.status = "running"; h.state.runId = "run";
    h.activity = "running"; h.ownedRun = "run";
    expect(render().html).not.toContain("ai-artifacts");
  });
  it("把提问卡按状态换成两种形态：还能答摆交互版，答过了只剩结果行", () => {
    const questions = [{ id: "lang", question: "用哪种语言？", options: [{ label: "中文" }] }];
    h.state.entries = [{ id: "e1", runId: "run", kind: "request", requestId: "q", text: "" }];
    h.state.requests = [{ requestId: "q", runId: "run", kind: "question", title: "AskUserQuestion", detail: "", questions, active: true }];
    expect(render().html).toContain('class="ai-question"');
    // 已经结束的请求不再摆交互版：按钮还在、结果也在，等于自相矛盾。
    h.state.requests = [{ requestId: "q", runId: "run", kind: "question", title: "AskUserQuestion", detail: "", questions, active: false, answer: { answers: { lang: ["中文"] } } }];
    const done = render();
    expect(done.html).toContain("ai-question-record");
    expect(done.html).not.toContain('class="ai-question"');
    expect(done.html).not.toContain("ai.runtime.answer");
    // 没等到答复就结束的：失效说明照说，但「问了什么」照样给——一行摘要 + 点开的只读卡。
    h.state.requests = [{ requestId: "q", runId: "run", kind: "question", title: "AskUserQuestion", detail: "", questions, active: false }];
    const expired = render();
    expect(expired.html).toContain("ai.runtime.requestExpired");
    expect(expired.html).toContain("ai-question-record");
    expect(expired.html).toContain("用哪种语言？");
  });
  it("没有正文的思考不摆成一排「思考」，只留本轮末尾那一条占位", () => {
    h.state.entries = [
      { id: "u", runId: "run", kind: "user", text: "做个东西" },
      { id: "run:e1:reasoning", runId: "run", kind: "reasoning", text: "" },
      { id: "run:e2:reasoning", runId: "run", kind: "reasoning", text: "" },
    ];
    // 本轮已结束：空正文就是没有可显示的东西，签名-only 的 redacted thinking 不该占两行。
    expect(render().html).not.toContain("ai-reasoning");
    // 还在跑：末尾那一条是「模型正在想」的唯一凭证，而「正在思考」只给它，不给历史里的其他条。
    h.state.status = "running"; h.state.runId = "run"; h.state.tasks = [{ runId: "run", status: "running", seq: 1 }];
    h.activity = "running"; h.ownedRun = "run";
    const live = render();
    expect(live.html.match(/class="ai-reasoning/g)).toHaveLength(1);
    expect(live.html).toContain("ai.chat.reasoningLive");
    // 想完且有正文的，照常单独成行，正文摘要跟着走。
    h.state.status = "idle";
    h.state.entries = [{ id: "u", runId: "run", kind: "user", text: "做个东西" }, { id: "run:e3:reasoning", runId: "run", kind: "reasoning", text: "先看目录结构" }];
    const told = render();
    expect(told.html).toContain("先看目录结构");
    expect(told.html).toContain("ai.chat.reasoning");
    expect(told.html).not.toContain("ai.chat.reasoningLive");
  });
  it("marks the context chip when compacting is worth doing, and keeps the action there", () => {
    h.state.nativeId = "native";
    h.state.usage = { context: 900, window: 1000 };
    const { html } = render();
    expect(html).toContain('class="ai-context-trigger is-urgent"');
    // 入口不再另起一条横幅：占用要看芯片，压缩就在它点开的那一层里。
    expect(html).not.toContain('class="ai-compact-hint"');
    h.state.usage = { context: 300, window: 1000 };
    expect(render().html).not.toContain("is-urgent");
  });
  it("names compaction out loud while that is what the turn is doing", () => {
    h.state.status = "running"; h.state.runId = "run";
    h.state.tasks = [{ runId: "run", status: "running", prompt: "/compact", seq: 1 }];
    const { html } = render();
    expect(html).toContain("ai.chat.compactionRunning");
    expect(html).toContain("is-compacting");
    expect(html).not.toContain(">ai.runtime.running<");
  });
  it("labels ordinary turns as running on the live stats line, without repeating the prompt", () => {
    h.state.status = "running"; h.state.runId = "run";
    h.state.tasks = [{ runId: "run", status: "running", prompt: "把分页改成从最新一页开始", seq: 1 }];
    h.activity = "running"; h.ownedRun = "run";
    const { html } = render();
    expect(html).toContain("ai-live-stats");
    expect(html).toContain("ai.runtime.running");
    // 参考的运行行不回显提示词；它属于时间线本身。
    expect(html).not.toContain("把分页改成从最新一页开始");
    expect(html).not.toContain("is-compacting");
  });
  it("uses HTML-only sanitization and forbids automatically loaded media", () => {
    h.state.entries = [{ id: "m", runId: "run", kind: "assistant", text: "**hello**" }]; render();
    const config = h.sanitize.mock.calls[0]?.[1] as unknown as { USE_PROFILES: { html: boolean }; FORBID_TAGS: string[]; FORBID_ATTR: string[] };
    expect(config.USE_PROFILES).toEqual({ html: true });
    expect(config.FORBID_TAGS).toEqual(expect.arrayContaining(["img", "svg", "iframe", "style"]));
    expect(config.FORBID_ATTR).toEqual(expect.arrayContaining(["src", "style", "background", "ping"]));
  });
  it("counts the whole session in the message nav, not just the page the body loaded", () => {
    // 正文那一页事件里只装得下一条用户消息：长会话一轮工具输出就能把 500 条填满。
    h.state.entries = [{ id: "r9:9", runId: "r9", kind: "user", text: "最新的一条" }];
    h.state.hasOlder = true;
    const chip = () => render().html.match(/class="ai-msgnav-chip-label"[^>]*>([^<]*)</)?.[1];
    // 索引还没取回，只能报已加载的，并带个 + 说明后面还有。
    expect(chip()).toBe("1+");
    h.outline = {
      turns: [
        { seq: 1, entryId: "r1:1", runId: "r1", label: "第一条", files: 0 },
        { seq: 5, entryId: "r5:5", runId: "r5", label: "第五条", files: 3 },
        { seq: 9, entryId: "r9:9", runId: "r9", label: "最新的一条", files: 0 },
      ],
      complete: true, loaded: true, loading: false, error: null,
    };
    // 取回索引后报的是整个会话的轮数；正文只有一条不影响这个数字。
    expect(chip()).toBe("3");
  });
  it("asks the backend for the turn index only once the nav is opened", async () => {
    h.state.entries = [{ id: "r9:9", runId: "r9", kind: "user", text: "最新的一条" }];
    h.state.hasOlder = true;
    const { pane, html } = render();
    // 收起状态只有一颗芯片：面板没展开就不该扫整份日志。
    expect(html).not.toContain("ai-msgnav-panel");
    expect(h.outlineLoad).not.toHaveBeenCalled();
    const nav = propsOfComponent(pane, "AiMessageNav") as { onRequestOutline: () => void; onJump: (row: { id: string; seq?: number; ordinal: number; label: string; files: number; loaded: boolean }) => Promise<void> };
    nav.onRequestOutline();
    expect(h.outlineLoad).toHaveBeenCalledWith(sessionId, "D:/project");
    // 点还没加载进正文的那一行：先按序号把中间的事件连续补齐，而不是让点击没有反应。
    await nav.onJump({ id: "r1:1", seq: 1, ordinal: 1, label: "第一条", files: 0, loaded: false });
    expect(h.through).toHaveBeenCalledWith(sessionId, "D:/project", 1);
  });
  it("seq 为 0 的那一轮照样补历史：拿真假判存在，最早的一轮就永远跳不到", async () => {
    h.state.entries = [{ id: "r9:9", runId: "r9", kind: "user", text: "最新的一条" }];
    const { pane } = render();
    const nav = propsOfComponent(pane, "AiMessageNav") as { onJump: (row: { id: string; seq?: number; ordinal: number; label: string; files: number; loaded: boolean }) => Promise<void> };
    await nav.onJump({ id: "r0:0", seq: 0, ordinal: 1, label: "最开头那条", files: 0, loaded: false });
    expect(h.through).toHaveBeenCalledWith(sessionId, "D:/project", 0);
    // 索引没给序号的行（只在正文里出现过）不需要补，直接当已加载处理。
    h.through.mockClear();
    await nav.onJump({ id: "r9:9", ordinal: 2, label: "最新的一条", files: 0, loaded: true });
    expect(h.through).not.toHaveBeenCalled();
  });
  it("轮次以 tool 调用收尾时，改动文件汇总卡依然挂载渲染", () => {
    h.state.entries = [
      { id: "u1", runId: "r1", seq: 1, kind: "user", text: "修改代码" },
      { id: "t1", runId: "r1", seq: 2, kind: "tool", name: "Edit", text: "", status: "completed", input: { changes: [{ path: "src/foo.ts", diff: "@@ -1 +1 @@\n-a\n+b" }] } },
    ];
    h.state.tasks = [{ runId: "r1", status: "completed", seq: 1 }];
    const { html } = render();
    expect(html).toContain("ai-artifacts");
    expect(html).toContain("src/foo.ts");
  });
  it("CLI 汇报处于计划模式时，输入框工具栏浮现计划模式徽章与一键退出按钮", () => {
    h.state.configuration = { planMode: true };
    const { html } = render();
    expect(html).toContain("ai-composer-plan-badge");
    expect(html).toContain("ai-composer-plan-exit");
  });
  it("轮次同时发生压缩与文件改动时，压缩分隔条与新增修改文件汇总两者兼备且新增与修改卡片并存", () => {
    h.state.entries = [
      { id: "u1", runId: "r1", seq: 1, kind: "user", text: "做一次改动并压缩" },
      { id: "t1", runId: "r1", seq: 2, kind: "tool", name: "Write", text: "", status: "completed", input: { file_path: "src/newFile.ts" }, result: { type: "create", content: "export const x = 1;" } },
      { id: "t2", runId: "r1", seq: 3, kind: "tool", name: "Edit", text: "", status: "completed", input: { file_path: "src/existing.ts" }, result: { type: "update", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }] } },
      { id: "c1", runId: "r1", seq: 4, kind: "notice", name: "compaction", text: "This is compaction summary text", input: { status: "completed", metadata: { before_tokens: 10000, after_tokens: 2000 } } },
    ];
    h.state.tasks = [{ runId: "r1", status: "completed", seq: 1 }];
    const { html } = render();
    // 压缩分隔条在，摘要正文默认收起（对齐参考实现），点开后才落到 DOM 里。
    expect(html).toContain("ai-compaction-container");
    expect(html).toContain('class="ai-compaction-toggle" aria-expanded="false"');
    expect(html).not.toContain("ai-compaction-summary");
    expect(html).not.toContain("This is compaction summary text");
    // 新增文件卡默认摊开，改动文件卡默认收起。
    expect(html).toContain('<details class="ai-artifact-card is-open" open="">');
    expect(html).toContain('<details class="ai-artifact-card"><summary>');
    expect(html).toContain("ai-artifacts");
    expect(html).toContain("src/newFile.ts");
    expect(html).toContain("src/existing.ts");
    expect(html).toContain("ai.chat.filesAdded");
    expect(html).toContain("ai.chat.filesChanged");
  });
  it("整段导入的原生会话按「一轮」切分改动卡，底栏只报最新一轮", () => {
    // 导入的历史每条都写着 runId="native"：按 runId 切会把几十轮压成时间线最末尾的一张卡，
    // 底栏那个数字也会随着往上翻越长越大。
    const edit = (id: string, seq: number, path: string) => ({ id, runId: "native", seq, kind: "tool" as const, name: "Edit", text: "", status: "completed",
      input: { changes: [{ path, diff: "@@ -1 +1 @@\n-a\n+b" }] } });
    h.state.entries = [
      { id: "u1", runId: "native", seq: 1, kind: "user", text: "第一轮改动" },
      edit("t1", 2, "src/first.ts"),
      { id: "a1", runId: "native", seq: 3, kind: "assistant", text: "第一轮做完了" },
      { id: "u2", runId: "native", seq: 4, kind: "user", text: "第二轮改动" },
      edit("t2", 5, "src/second.ts"),
      { id: "a2", runId: "native", seq: 6, kind: "assistant", text: "第二轮做完了" },
    ];
    const { html } = render();
    expect(html.match(/class="ai-artifacts"/g)).toHaveLength(2);
    // 每张卡挂在它那一轮的末尾，而不是全挤在时间线最下面。
    expect(html.indexOf("src/first.ts")).toBeLessThan(html.indexOf("第二轮改动"));
    expect(html.indexOf("src/second.ts")).toBeGreaterThan(html.indexOf("第二轮改动"));
    // 底栏报的是「这一趟」：只有一个文件，且往上翻历史时不会跟着变。
    const chip = html.slice(html.indexOf("ai-edit-summary"));
    expect(chip).toContain("ai.chat.editedFile");
    expect(chip).not.toContain("ai.chat.editedFiles");
  });
  it("任务清单在右侧视口贴边展示且默认展开，带有拖动手柄与折叠按钮", () => {
    h.state.taskList = {
      runId: "run",
      seq: 1,
      items: [
        { id: "1", content: "检查代码结构", status: "completed" },
        { id: "2", content: "运行测试套件", status: "in_progress" },
        { id: "3", content: "汇总检查报告", status: "pending" },
      ],
    };
    const { html } = render();
    // 渲染在右侧浮动挂件中且默认展开
    expect(html).toContain('class="ai-taskchip is-open"');
    expect(html).toContain('class="ai-taskchip-panel"');
    // 展开状态下不显示拉手芯片（折叠时才显示拉手）
    expect(html).not.toContain('class="ai-taskchip-chip');
    // 包含拖拽手柄、折叠按钮、清单项与统计进度
    expect(html).toContain('ai-taskchip-drag-handle');
    expect(html).toContain('ai-taskchip-collapse');
    expect(html).toContain("检查代码结构");
    expect(html).toContain("运行测试套件");
    expect(html).toContain("汇总检查报告");
    expect(html).toContain("1/3");
    expect(html).toContain("33%");
    // 顶栏不包含任务清单，任务清单位于视口内与消息导航相邻
    const headerHtml = html.slice(html.indexOf('<header class="ai-session-pane-head">'), html.indexOf('</header>'));
    expect(headerHtml).not.toContain("ai-taskchip");
  });
  it("只在已完成 Goal 上提供用户主动的隐藏入口", () => {
    h.state.goal = {
      seq: 1, threadId: "native", objective: "完成验证", status: "complete",
      tokenBudget: null, tokensUsed: 10, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2,
    };
    const completed = render().html;
    expect(completed).toContain('class="ai-goalbar is-complete"');
    expect(completed).toContain("ai.chat.hideGoal");

    h.state.goal = { ...h.state.goal, status: "active" };
    const active = render().html;
    expect(active).not.toContain("ai.chat.hideGoal");
    expect(active).toContain("ai.chat.pauseGoal");
  });
});
