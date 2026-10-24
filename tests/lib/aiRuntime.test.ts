import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiRuntimeEvent } from "../../src/lib/aiRuntime";
const h = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), callback: null as null | ((event: { payload: AiRuntimeEvent[] }) => void), errorCallback: null as null | ((event: { payload: { sessionId: string; runId: string; error: string } }) => void) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke, isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: h.listen }));
vi.mock("react", () => ({ useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read() }));
const session = { id: "session", provider: "codex" as const, title: "Test", createdAt: 1 };
function event(seq: number, kind: string, data: Record<string, unknown>, runId = "run"): AiRuntimeEvent { return { sessionId: session.id, runId, seq, kind, data }; }
function emit(...events: AiRuntimeEvent[]) { h.callback?.({ payload: events }); }
beforeEach(() => {
  vi.resetModules(); h.callback = null; h.errorCallback = null; h.invoke.mockReset(); h.listen.mockReset();
  h.listen.mockImplementation(async (channel, callback) => { if (channel === "ai-runtime://events") h.callback = callback; else h.errorCallback = callback; return () => {}; });
  h.invoke.mockImplementation(async (command: string) => command === "ai_runtime_send" ? { status: "running" } : undefined);
});

describe("AI runtime event store", () => {
  it("keeps structured tool output, patch updates and cancellation as separate facts", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    const result = { file: { filePath: "a.ts", content: "a\nb", startLine: 10, numLines: 2 }, type: "text" };
    const state = projectAiEvents([
      event(1, "status", { status: "running" }),
      event(2, "tool", { id: "tool", name: "fileChange", input: { cwd: "D:/project" }, status: "running" }),
      event(3, "tool", { id: "tool", inputPatch: { changes: [{ path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b" }] } }),
      event(4, "tool", { id: "tool", result, outputDelta: "partial" }),
      event(5, "status", { status: "cancelled" }),
    ]);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({ status: "cancelled", result, output: "partial", input: { cwd: "D:/project", changes: [{ path: "a.ts" }] } });
  });
  it("describes real read ranges, command actions and patch line coordinates", async () => {
    const { describeAiTool, parseToolDiff } = await import("../../src/lib/aiTools");
    const read = describeAiTool({ id: "r", runId: "run", kind: "tool", text: "", name: "Read", input: { file_path: "a.ts", offset: 1, limit: 200 }, result: { type: "text", file: { filePath: "a.ts", content: "a\nb", startLine: 10, numLines: 2, totalLines: 90 } } });
    expect(read.summary).toBe("a.ts:10–11");
    expect(read.source).toMatchObject({ start: 10, end: 11, total: 90 });
    const command = describeAiTool({ id: "c", runId: "run", kind: "tool", text: "", name: "commandExecution", input: { command: "rg TODO src", cwd: "root", commandActions: [{ type: "search", query: "TODO", path: "src" }], exitCode: 1, durationMs: 42 } });
    expect(command).toMatchObject({ kind: "search", summary: "src · TODO", command: "rg TODO src", exitCode: 1, durationMs: 42 });
    expect(command.actions[0].start).toBeUndefined();
    const edit = describeAiTool({ id: "e", runId: "run", kind: "tool", text: "", name: "Edit", status: "completed", result: { filePath: "a.ts", staged: true, structuredPatch: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: ["-old", "+new", "+more"] }] } });
    expect(edit.patches[0].proposed).toBe(true);
    expect(parseToolDiff(edit.patches[0].diff!)).toEqual([
      { kind: "header", text: "@@ -10,1 +10,2 @@" }, { kind: "delete", text: "-old", oldLine: 10 }, { kind: "add", text: "+new", newLine: 10 }, { kind: "add", text: "+more", newLine: 11 },
    ]);
    const move = describeAiTool({ id: "m", runId: "run", kind: "tool", text: "", name: "fileChange", status: "completed", input: { changes: [{ path: "a.ts", kind: { type: "update", move_path: "b.ts" }, diff: "diff" }] } });
    expect(move.patches[0]).toMatchObject({ kind: "move", destination: "b.ts", proposed: false });
  });
  it("tracks external occupancy per session and recovers after release", async () => {
    const api = await import("../../src/lib/aiRuntime");
    h.invoke.mockResolvedValueOnce([{ sessionId: "external-session", state: "external", queuedCount: 2 }, { sessionId: "other", state: "external" }]);
    await api.refreshAiSessionActivity("D:/project", ["external-session", "idle-session"]);
    expect(api.getAiSessionActivity("external-session")).toBe("external");
    expect(api.getAiQueuedCount("external-session")).toBe(2);
    expect(api.getAiSessionActivity("idle-session")).toBe("idle");
    expect(api.getAiSessionActivity("other")).toBe("idle");
    expect(api.hasAiProjectActivity("d:/PROJECT")).toBe(true);
    expect(api.hasAiProjectActivity("d:/other")).toBe(false);
    h.invoke.mockRejectedValueOnce(new Error("unavailable"));
    await api.refreshAiSessionActivity("D:/project", ["external-session"]);
    expect(api.getAiSessionActivity("external-session")).toBe("unknown");
    h.invoke.mockResolvedValueOnce([{ sessionId: "external-session", state: "idle" }]);
    await api.refreshAiSessionActivity("D:/project", ["external-session"]);
    expect(api.getAiSessionActivity("external-session")).toBe("idle");
    expect(api.getAiQueuedCount("external-session")).toBe(0);
    expect(api.hasAiProjectActivity("D:/project")).toBe(false);
  });
  it("shows live Forge events immediately and does not hide a concurrent external conflict", async () => {
    const api = await import("../../src/lib/aiRuntime");
    await api.ensureAiRuntimeListener();
    emit(event(1, "status", { status: "running" }));
    expect(api.getAiSessionActivity(session.id)).toBe("running");
    h.invoke.mockResolvedValueOnce([{ sessionId: session.id, state: "conflict" }]);
    await api.refreshAiSessionActivity("D:/project", [session.id]);
    expect(api.getAiSessionActivity(session.id)).toBe("conflict");
    expect(api.isAiSessionRunning(session.id)).toBe(true);
  });
  it("replaces command catalogs and ignores old-run discovery during replay and incremental updates", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    const events = [event(1, "status", { status: "running" }), event(2, "commands", { commands: [{ name: "old" }], terminal: [] }),
      event(3, "commands", { commands: [{ name: "new", argumentHint: "<file>" }], terminal: ["exit"] }),
      event(4, "status", { status: "running" }, "next"), event(5, "commands", { commands: [{ name: "late" }] })];
    const state = projectAiEvents(events);
    expect(state.commands?.commands.map((c) => c.name)).toEqual(["new"]);
    expect(state.commands?.terminal).toEqual(["exit"]);
    expect(projectAiEvents(events.slice(2), projectAiEvents(events.slice(0, 2)), true)).toEqual(state);
    const cleared = projectAiEvents([event(6, "commands", { commands: [], terminal: [] }, "next")], state, true);
    expect(cleared.commands?.commands).toEqual([]);
    expect(state.commands?.commands).toHaveLength(1);
  });
  it("keeps command output separate from assistant messages and replaces duplicate output", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    const events = [event(1, "command_output", { id: "same", text: "first" }), event(2, "message", { id: "same", text: "assistant" }), event(3, "command_output", { id: "same", text: "中文😀" })];
    const state = projectAiEvents(events);
    expect(state.entries.map((e) => [e.kind, e.text])).toEqual([["command", "中文😀"], ["assistant", "assistant"]]);
    const first = projectAiEvents(events.slice(0, 2));
    expect(projectAiEvents(events.slice(2), first, true)).toEqual(state);
    expect(first.entries[0].text).toBe("first");
  });
  it.each(["claudeSlash", "codexReview", "codexCompact"] as const)("passes explicit %s intent and preserves the entire prompt through IPC", async (command) => {
    const runtime = await import("../../src/lib/aiRuntime");
    const prompt = '/review  "a b" --flag\n第二行  ';
    await runtime.sendAiMessage(session, "D:/project", prompt, true, {}, command);
    expect(h.invoke).toHaveBeenCalledWith("ai_runtime_send", expect.objectContaining({ request: expect.objectContaining({ prompt, command }) }));
  });
  it("replays composition snapshots separately from usage and invalidates them on new turns, model changes and compaction", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    const data = { detail: "summary", capturedAt: 1, model: "fixture", totalTokens: 100, rawMaxTokens: 1000, categories: [{ name: "System prompt", tokens: 100, kind: "used" }] };
    const events = [event(1, "status", { status: "running" }), event(2, "context", data), event(3, "usage", { input_tokens: 9999 }), event(4, "status", { status: "completed" })];
    const state = projectAiEvents(events);
    expect(state.context?.total).toBe(100); expect(state.context?.stale).toBe(false);
    for (const next of [event(5, "status", { status: "running" }, "new"), event(5, "configuration", { model: "changed" }), event(5, "compaction", {}), event(5, "context_unavailable", {})]) {
      expect(projectAiEvents([next], state, true).context?.stale).toBe(true);
      expect(projectAiEvents([...events, next])).toEqual(projectAiEvents([next], state, true));
    }
    const newTurn = projectAiEvents([event(5, "status", { status: "running" }, "new"), event(6, "context", data)], state, true);
    expect(newTurn.context?.stale).toBe(true); // Old run cannot refresh the current turn.
    const refreshed = projectAiEvents([event(7, "context", data, "new")], newTurn, true);
    expect(refreshed.context?.runId).toBe("new"); expect(refreshed.context?.stale).toBe(false);
    const invalid = projectAiEvents([event(8, "context", {}, "new")], refreshed, true);
    expect(invalid.contextUnavailable).toBe(true); expect(invalid.context?.stale).toBe(true);
  });
  it("passes selected model and effort to the backend", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    await runtime.sendAiMessage(session, "D:/project", "hello", true, { model: "test-model", effort: "high", permission: "auto", fast: true });
    expect(h.invoke).toHaveBeenCalledWith("ai_runtime_send", expect.objectContaining({ request: expect.objectContaining({ model: "test-model", effort: "high", permission: "auto", fast: true }) }));
  });
  it("passes pasted image paths to the backend instead of dropping them", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    await (runtime.sendAiMessage as unknown as (...args: unknown[]) => Promise<void>)(
      session, "D:/project", "", true, {}, undefined, ["C:/Forge/pasted-images/paste.png"],
    );
    expect(h.invoke).toHaveBeenCalledWith("ai_runtime_send", expect.objectContaining({
      request: expect.objectContaining({ images: ["C:/Forge/pasted-images/paste.png"] }),
    }));
  });
  it("keeps pasted image paths on projected user messages", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    const snapshot = projectAiEvents([event(1, "user", { text: "看图", images: ["C:/cache/paste.png"] })]);
    expect(snapshot.entries[0]).toEqual(expect.objectContaining({ kind: "user", text: "看图", images: ["C:/cache/paste.png"] }));
  });
  it("已结束的历史不是待办任务：只有 user 事件不造任何一轮", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    // 导入的原生历史：整份日志共用一个 runId，一条状态事件都没有。
    const imported = projectAiEvents([event(1, "user", { text: "第一条" }, "native"), event(2, "message", { id: "m", text: "答完了" }, "native"), event(3, "user", { text: "第二条" }, "native")]);
    expect(imported.tasks).toEqual([]);
    expect(imported.status).toBe("idle");
    expect(imported.runId).toBeNull();
    // 正文一条不少：不该进任务列表的是「待办」，不是这段对话本身。
    expect(imported.entries.map((entry) => entry.kind)).toEqual(["user", "assistant", "user"]);
    // 真在跑的那一轮仍然带得上正文：running 状态事件自己没有 prompt，取同一轮的用户消息。
    const live = projectAiEvents([event(1, "user", { text: "改一下" }, "r"), event(2, "status", { status: "running" }, "r")]);
    expect(live.tasks.map((task) => [task.status, task.prompt])).toEqual([["running", "改一下"]]);
    // 事件落了地，本地那份占位就让位；还没落地的（IPC 往返中）照常留着。
    const blank = projectAiEvents([]);
    const local = { ...blank, tasks: [{ runId: "in-flight", status: "submitting" as const, prompt: "还没送到后端", seq: 9 }] };
    const landed = projectAiEvents([event(1, "user", { text: "在路上" }, "in-flight"), event(2, "status", { status: "running" }, "in-flight")], local);
    expect(landed.tasks.map((task) => [task.runId, task.status, task.prompt])).toEqual([["in-flight", "running", "在路上"]]);
    const stillFlying = projectAiEvents([event(1, "user", { text: "别人的历史" }, "gone")], local);
    expect(stillFlying.tasks.map((task) => [task.runId, task.status])).toEqual([["in-flight", "submitting"]]);
  });
  it("projects public reasoning, configuration, usage and requests in timeline order", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    const events = [event(1, "status", { status: "running" }), event(2, "configuration", { model: "effective", effort: "high" }),
      event(3, "reasoning_delta", { id: "thought", text: "public " }), event(4, "reasoning_delta", { id: "thought", text: "summary" }),
      event(5, "permission", { requestId: "approve", title: "Run" }), event(6, "tool", { id: "tool", name: "Bash", status: "running" }),
      event(7, "usage", { tokenUsage: { last: { totalTokens: 50 }, total: { totalTokens: 500 }, modelContextWindow: 100 } }), event(8, "compaction", { text: "compacted" })];
    const state = projectAiEvents(events);
    expect(state.entries.map((entry) => entry.kind)).toEqual(["reasoning", "request", "tool", "notice"]);
    expect(state.entries[0].text).toBe("public summary"); expect(state.configuration?.model).toBe("effective"); expect(state.usage?.context).toBeUndefined(); expect(state.usage?.total).toBe(500);
    expect(projectAiEvents(events.slice(4), projectAiEvents(events.slice(0, 4)), true)).toEqual(state);
  });
  it("keeps accumulated thinking when a CLI full-block event arrives with empty text", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    const events = [event(1, "reasoning_delta", { id: "m-1", text: "" }), event(2, "reasoning_delta", { id: "m-1", text: "先查一遍" }),
      // assistant 信封补发的完整块：CLI 在裁剪/签名后可能给空文本——不得把上面的增量洗掉。
      event(3, "reasoning", { id: "m-1", text: "" })];
    const state = projectAiEvents(events);
    expect(state.entries[0].text).toBe("先查一遍");
    // 带正文的完整块仍然是权威替换（幂等，不叠加）。
    const replaced = projectAiEvents([...events, event(4, "reasoning", { id: "m-1", text: "先查一遍" })]);
    expect(replaced.entries[0].text).toBe("先查一遍");
  });
  it("allows separate sessions in parallel and sends same-session tasks to the backend queue", async () => {
    const api = await import("../../src/lib/aiRuntime");
    await api.sendAiMessage(session, "D:/project", "first", true);
    await api.sendAiMessage({ ...session, id: "parallel-session" }, "D:/project", "second", true);
    h.invoke.mockImplementation(async (command: string) => command === "ai_runtime_send" ? { status: "queued" } : undefined);
    await api.sendAiMessage(session, "D:/project", "duplicate", true);
    const sends = h.invoke.mock.calls.filter(([command]) => command === "ai_runtime_send");
    expect(sends).toHaveLength(3);
    expect(sends[0][1].request).toMatchObject({ permission: "inherit", fast: null });
    expect(api.useAiRuntime(session.id).tasks.map((task) => task.status)).toEqual(["running", "queued"]);
    expect(api.getAiQueuedCount(session.id)).toBe(1);
  });
  it("队列动作只说本窗口知道的那一半事实", async () => {
    const api = await import("../../src/lib/aiRuntime");
    // 本机快照里没有这一条待办：话要说「不在本窗口的待办列表里」，而不是含糊的「不存在」——
    // 队列活在收下它的那个进程里，跨窗口的情况由后端那句更准的说明负责。
    for (const call of [() => api.runQueuedAiTaskNow("ghost"), () => api.moveQueuedAiTask("ghost", null), () => api.editQueuedAiTask("ghost", "改一下")]) {
      await expect(call()).rejects.toThrow("不在本窗口的待办列表里");
    }
    // 判定在本机就该拦住，不该把三个请求挨个发给后端再报错。
    expect(h.invoke.mock.calls.filter(([command]) => String(command).startsWith("ai_runtime_queue_"))).toHaveLength(0);
  });
  it("keeps the running task addressable while projecting FIFO queued tasks", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    const state = projectAiEvents([
      event(1, "user", { text: "first" }, "run-a"), event(2, "status", { status: "running" }, "run-a"),
      event(3, "user", { text: "second" }, "run-b"), event(4, "status", { status: "queued" }, "run-b"),
      event(5, "user", { text: "third" }, "run-c"), event(6, "status", { status: "waitingExternal" }, "run-c"),
    ]);
    expect(state.runId).toBe("run-a");
    expect(state.status).toBe("running");
    expect(state.tasks.map((task) => [task.runId, task.status, task.prompt])).toEqual([
      ["run-a", "running", "first"], ["run-b", "queued", "second"], ["run-c", "waitingExternal", "third"],
    ]);
    const next = projectAiEvents([event(7, "status", { status: "cancelled" }, "run-b"), event(8, "status", { status: "completed" }, "run-a"), event(9, "status", { status: "running" }, "run-c")], state, true);
    expect(next.runId).toBe("run-c");
    expect(next.tasks.map((task) => task.status)).toEqual(["completed", "cancelled", "running"]);
  });
  it("registers routing before invoking send and retains early Unicode events", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    h.invoke.mockImplementation(async (command, args) => {
      if (command === "ai_runtime_send") {
        const id = args.request.runId;
        expect(runtime.getAiRunId(session.id)).toBe(id);
        expect(runtime.hasAiRuns("d:/project")).toBe(true);
        emit(event(1, "status", { status: "running" }, id), event(2, "text", { id: "text", text: "中文😀" }, id));
      }
    });
    await runtime.sendAiMessage(session, "D:\\Project", "hello", true);
    expect(runtime.useAiRuntime(session.id).entries[0].text).toBe("中文😀");
    expect(h.listen).toHaveBeenCalledTimes(2);
  });
  it("deduplicates replayed events and replaces complete messages", async () => {
    const runtime = await import("../../src/lib/aiRuntime"); await runtime.ensureAiRuntimeListener();
    const delta = event(2, "text", { id: "m", text: "中" });
    emit(event(1, "status", { status: "running" }), delta); emit(delta, event(3, "text", { id: "m", text: "文😀" }));
    emit(event(4, "message", { id: "m", text: "中文😀" }));
    expect(runtime.useAiRuntime(session.id).entries).toHaveLength(1);
    expect(runtime.useAiRuntime(session.id).entries[0].text).toBe("中文😀");
  });
  it("答案跟着失效事件一起回来，已处理和已失效分得清", async () => {
    const runtime = await import("../../src/lib/aiRuntime"); await runtime.ensureAiRuntimeListener();
    emit(
      event(1, "status", { status: "running" }),
      event(2, "question", { requestId: "q", title: "Claude Code", questions: [{ id: "lang", question: "选哪个", options: [{ label: "中文" }, { label: "English" }] }] }),
      event(3, "question", { requestId: "p", title: "Claude Code", questions: [{ id: "x", question: "没答的那张" }] }),
      event(4, "invalidated", { requestId: "q", answer: { answers: { lang: ["中文", "随便写的那句"] } } }),
      event(5, "invalidated", { requestId: "p" }),
    );
    const state = runtime.useAiRuntime(session.id);
    expect(state.requests.find((item) => item.requestId === "q")).toMatchObject({ active: false, answer: { answers: { lang: ["中文", "随便写的那句"] } } });
    // 没等到答复的那张只有失效，不能凭空给它编一个答案。
    expect(state.requests.find((item) => item.requestId === "p")?.active).toBe(false);
    expect(state.requests.find((item) => item.requestId === "p")?.answer).toBeUndefined();
  });
  it("失效事件丢了答案时，从同轮提问工具的结构化结果里恢复当时的选择", async () => {
    const runtime = await import("../../src/lib/aiRuntime"); await runtime.ensureAiRuntimeListener();
    emit(
      event(1, "status", { status: "running" }),
      event(2, "question", { requestId: "q", title: "Claude Code", questions: [{ id: "0", question: "选哪个", options: [{ label: "选项 A" }, { label: "选项 B" }] }] }),
      event(3, "question", { requestId: "r", title: "Claude Code", questions: [{ id: "0", question: "另一张卡的问题", options: [{ label: "X" }] }] }),
      // 答案经 updatedInput 交给 CLI 后，工具结果里每回都带着结构化 answers。
      event(4, "tool", { id: "toolu_1", name: "AskUserQuestion", input: {}, status: "completed",
        result: { answers: { "选哪个": "选项 A" }, questions: [{ question: "选哪个", options: [{ label: "选项 A" }] }] } }),
      // 两条 invalidated 都没带答案（实测日志里确有此情形）。
      event(5, "invalidated", { requestId: "q" }),
      event(6, "invalidated", { requestId: "r" }),
    );
    const state = runtime.useAiRuntime(session.id);
    expect(state.requests.find((item) => item.requestId === "q")?.answer).toMatchObject({ answers: { "0": ["选项 A"] } });
    // 问的不是同一组问题的那张卡，不把别人的答案贴过来。
    expect(state.requests.find((item) => item.requestId === "r")?.answer).toBeUndefined();
  });
  it("late terminal events cannot finish another run or keep stale approvals active", async () => {
    const runtime = await import("../../src/lib/aiRuntime"); await runtime.ensureAiRuntimeListener();
    emit(event(1, "status", { status: "running" }), event(2, "permission", { requestId: "old" }), event(3, "status", { status: "completed" }));
    emit(event(4, "status", { status: "running" }, "new"), event(5, "status", { status: "failed" }));
    const state = runtime.useAiRuntime(session.id);
    expect(state.runId).toBe("new"); expect(state.status).toBe("running"); expect(state.requests[0].active).toBe(false);
  });
  it("merges paginated history with live output without overwriting it", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    let resolve!: (page: unknown) => void;
    h.invoke.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const loading = runtime.loadAiMessages(session.id, "D:/project");
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    emit(event(2, "text", { id: "m", text: "hello" }));
    resolve({ events: [event(1, "status", { status: "running" })], hasOlder: false, nextSeq: 1, nativeId: "native", status: "running" });
    await loading;
    expect(runtime.useAiRuntime(session.id).entries[0].text).toBe("hello");
    expect(runtime.useAiRuntime(session.id).nativeId).toBe("native");
  });
  it("listener failure prevents launch and can be retried explicitly", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    h.listen.mockRejectedValueOnce(new Error("listener failed"));
    await expect(runtime.sendAiMessage(session, "D:/project", "hello", true)).rejects.toThrow("listener failed");
    expect(h.invoke).not.toHaveBeenCalled();
    await runtime.ensureAiRuntimeListener(); expect(h.listen).toHaveBeenCalledTimes(3);
  });
  it("uncertain send errors stop the registered run rather than resend", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    h.invoke.mockImplementation(async (command) => { if (command === "ai_runtime_send") throw new Error("lost response"); });
    await expect(runtime.sendAiMessage(session, "D:/project", "hello", true)).rejects.toThrow("lost response");
    expect(h.invoke.mock.calls.map(([command]) => command)).toEqual(["ai_runtime_send", "ai_runtime_stop"]);
    expect(runtime.isAiSessionRunning(session.id)).toBe(false);
  });
  it("disk errors use a separate channel without consuming a durable sequence", async () => {
    const runtime = await import("../../src/lib/aiRuntime"); await runtime.ensureAiRuntimeListener();
    emit(event(1, "status", { status: "running" }), event(2, "permission", { requestId: "permission" }));
    h.errorCallback?.({ payload: { sessionId: session.id, runId: "run", error: "disk full" } });
    expect(runtime.useAiRuntime(session.id).status).toBe("failed");
    expect(runtime.useAiRuntime(session.id).requests[0].active).toBe(false);
    emit(event(3, "text", { id: "m", text: "late" }));
    expect(runtime.useAiRuntime(session.id).error).toBe("disk full");
    emit(event(4, "status", { status: "running" }, "new"));
    h.errorCallback?.({ payload: { sessionId: session.id, runId: "run", error: "old error" } });
    expect(runtime.useAiRuntime(session.id).status).toBe("running");
    expect(runtime.useAiRuntime(session.id).runId).toBe("new");
  });
  it("partial history uses the current backend status without blocking native resume", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    h.invoke.mockResolvedValue({ events: [event(1, "status", { status: "running" })], hasOlder: true, nextSeq: 1, latestSeq: 1000, latestRunId: "run", nativeId: "native", status: "completed" });
    await runtime.loadAiMessages(session.id, "D:/project");
    expect(runtime.useAiRuntime(session.id).status).toBe("completed");
    await runtime.sendAiMessage(session, "D:/project", "hello", true);
    expect(h.invoke.mock.calls.some(([command]) => command === "ai_runtime_send")).toBe(true);
  });
  it("opens on the newest page and keeps walking backwards from there", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    h.invoke.mockResolvedValue({ events: [event(901, "text", { id: "m", text: "tail" })], hasOlder: true, nextSeq: 901, latestSeq: 1200, latestRunId: "run", nativeId: "native", status: "completed" });
    await runtime.loadAiMessages(session.id, "D:/project");
    // 首屏不带任何游标：后端默认给最后面那一页。
    expect(h.invoke.mock.calls.at(-1)![1]).toEqual({ sessionId: session.id, workspace: "D:/project", limit: 500 });
    expect(runtime.useAiRuntime(session.id)).toMatchObject({ loaded: true, hasOlder: true, cursor: 901 });
    h.invoke.mockResolvedValue({ events: [event(801, "text", { id: "k", text: "older" })], hasOlder: true, nextSeq: 801, nativeId: "native", status: "completed" });
    await runtime.loadOlderAiMessages(session.id, "D:/project");
    expect(h.invoke.mock.calls.at(-1)![1]).toMatchObject({ beforeSeq: 901, limit: 500 });
    const state = runtime.useAiRuntime(session.id);
    expect(state.cursor).toBe(801);
    // 更早的一页接在上面，最新那条不被挤掉：投影按序号排，不看到达顺序。
    expect(state.entries.map((entry) => entry.text)).toEqual(["older", "tail"]);
    expect(state.status).toBe("completed");
  });
  it("gives up paging back when a page brings nothing new", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    h.invoke.mockResolvedValue({ events: [event(5, "text", { id: "m", text: "tail" })], hasOlder: true, nextSeq: 5, nativeId: "native", status: "completed" });
    await runtime.loadAiMessages(session.id, "D:/project");
    h.invoke.mockResolvedValue({ events: [], hasOlder: true, nextSeq: 0, nativeId: "native", status: "completed" });
    await runtime.loadOlderAiMessages(session.id, "D:/project");
    const state = runtime.useAiRuntime(session.id);
    // 空页还留着 hasOlder 的话，按钮会一直亮着却翻不出东西；游标也不能被 0 拽回开头。
    expect(state).toMatchObject({ hasOlder: false, cursor: 5 });
    h.invoke.mockClear();
    await runtime.loadOlderAiMessages(session.id, "D:/project");
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it("background project file events do not refresh the foreground project", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    h.invoke.mockResolvedValue({ events: [], hasOlder: false, nextSeq: 0, nativeId: null, status: null });
    await runtime.loadAiMessages(session.id, "D:/project");
    await runtime.loadAiMessages("background", "D:/other");
    const local = event(1, "files", { paths: ["src/main.ts"] });
    const other = { ...local, sessionId: "background" };
    expect(runtime.filterAiProjectEvents([local, other], "d:\\PROJECT")).toEqual([local]);
    expect(runtime.filterAiProjectEvents([{ ...local, sessionId: "unknown" }], "D:/project")).toEqual([]);
  });
  it("incremental projections preserve previous snapshots and match a full replay", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    const first = [event(1, "status", { status: "running" }), event(2, "text", { id: "m", text: "中" })];
    const second = [event(3, "text", { id: "m", text: "文😀" }), event(4, "status", { status: "completed" })];
    const snapshot = projectAiEvents(first);
    const next = projectAiEvents(second, snapshot, true);
    expect(snapshot.entries[0].text).toBe("中");
    expect(next).toEqual(projectAiEvents([...first, ...second]));
  });
  it("deleted conversations ignore late events", async () => {
    const runtime = await import("../../src/lib/aiRuntime"); await runtime.ensureAiRuntimeListener();
    emit(event(1, "status", { status: "running" }));
    await runtime.deleteAiRuntimeSession(session.id, "D:/project");
    emit(event(2, "text", { id: "m", text: "late" }));
    expect(runtime.useAiRuntime(session.id).entries).toEqual([]);
  });
  it("coalesces streaming notifications without delaying state changes", async () => {
    const runtime = await import("../../src/lib/aiRuntime"); await runtime.ensureAiRuntimeListener();
    let notifications = 0;
    const unsubscribe = runtime.subscribeAiChanges(() => { notifications += 1; });
    emit(event(1, "status", { status: "running" }));
    expect(notifications).toBe(1);
    emit(event(2, "text", { id: "m", text: "中" }), event(3, "tool", { id: "t", name: "Read", outputDelta: "x" }));
    emit(event(4, "text", { id: "m", text: "文" }));
    // 合帧只推迟「告诉大家」：快照当场就是最新的，读得到但还没通知。
    expect(notifications).toBe(1);
    expect(runtime.useAiRuntime(session.id).entries.map((entry) => entry.text)).toEqual(["中文", ""]);
    // 没有 rAF 的环境靠兜底定时器追上，不会永远欠一次通知。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(notifications).toBe(2);
    // 混进状态事件的那一批必须当场通知，不能让用户等下一帧才看到停止按钮。
    emit(event(5, "text", { id: "m", text: "！" }), event(6, "status", { status: "completed" }));
    expect(notifications).toBe(3);
    expect(runtime.useAiRuntime(session.id).status).toBe("completed");
    unsubscribe();
  });
  it("merges plan drafts with the authoritative review and keeps every revision", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    const review = { planId: "thread/plan", sessionId: session.id, nativeId: "thread", workspace: "D:/project", revision: 1,
      title: "计划", content: "# 计划\n第一步", contentHash: "h", complete: true, nativePlanId: "item", execPermission: "inherit",
      status: "awaiting_review", execution: "not_started", createdAt: 1, updatedAt: 1 };
    const first = projectAiEvents([
      event(1, "status", { status: "running" }),
      event(2, "plan_draft", { planId: "thread/plan", text: "# 计划\n", append: false }),
      event(3, "plan_draft", { planId: "thread/plan", text: "第一步", append: true }),
      event(4, "plan_review", review),
      event(5, "status", { status: "completed" }),
    ]);
    expect(first.plans).toHaveLength(1);
    expect(first.plans[0]).toMatchObject({ revision: 1, status: "awaiting_review" });
    // 流式草稿与权威正文合并成一条，不出现两份同一计划。
    const planEntries = first.entries.filter((entry) => entry.name === "plan_review" || entry.name === "plan_draft");
    expect(planEntries).toHaveLength(1);
    expect(planEntries[0]).toMatchObject({ name: "plan_review", text: "# 计划\n第一步" });
    const second = projectAiEvents([event(6, "plan_review", { ...review, revision: 2, status: "approved", content: "# 计划\n第二步" })], first, true);
    expect(second.plans.map((plan) => plan.revision)).toEqual([1, 2]);
    expect(second.plans[1].status).toBe("approved");
  });
  it("tracks background tasks, permission denials and MCP snapshots outside the transcript", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    const state = projectAiEvents([
      event(1, "status", { status: "running" }),
      event(2, "background", { pending: 2, settled: true }),
      event(3, "permission_denied", { tool: "Read", path: "C:\\outside\\a.ts", text: "requires approval" }),
      event(4, "mcp_servers", { servers: [{ name: "docs", status: "connected" }], tools: ["mcp__docs__search", 3] }),
    ]);
    expect(state.background).toEqual({ pending: 2, settled: true });
    expect(state.permissionDenied).toEqual({ tool: "Read", path: "C:\\outside\\a.ts", text: "requires approval" });
    expect(state.mcpServers).toEqual({ servers: [{ name: "docs", status: "connected" }], tools: ["mcp__docs__search"] });
    const done = projectAiEvents([event(5, "status", { status: "completed" })], state, true);
    expect(done.background).toBeUndefined();
  });
  it("a plan decision starts a run without pretending the backend prompt is a user message", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    await runtime.ensureAiRuntimeListener();
    const plan = { planId: "thread/plan", revision: 2, status: "awaiting_review" as const, complete: true } as never;
    await runtime.decideAiPlan(session, "D:/project", plan, "requestChanges", "补上回滚");
    const request = h.invoke.mock.calls.find(([command]) => command === "ai_runtime_send")?.[1]?.request;
    expect(request).toMatchObject({ prompt: "", images: [], plan: { planId: "thread/plan", revision: 2, decision: "requestChanges", feedback: "补上回滚" } });
  });
  it("forwards plan mode and granted directories with a normal send", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    await runtime.ensureAiRuntimeListener();
    await runtime.sendAiMessage(session, "D:/project", "先给方案", true, { planMode: true }, undefined, [], ["C:\\docs"]);
    const request = h.invoke.mock.calls.filter(([command]) => command === "ai_runtime_send").at(-1)?.[1]?.request;
    expect(request).toMatchObject({ planMode: true, additionalDirs: ["C:\\docs"], prompt: "先给方案" });
  });
});

describe("消息导航的索引与跳转", () => {
  it("导航索引只在第一次展开时扫一次，失败后还能重试", async () => {
    const api = await import("../../src/lib/aiRuntime");
    const turns = [{ seq: 1, entryId: "r1:1", runId: "r1", label: "第一条", files: 2 }];
    const outlineCalls = () => h.invoke.mock.calls.filter(([command]) => command === "ai_runtime_outline").length;
    h.invoke.mockImplementation(async (command: string) => (command === "ai_runtime_outline" ? { turns, complete: true } : undefined));
    await api.loadAiOutline("nav-session", "D:/project");
    expect(api.getAiOutline("nav-session")).toMatchObject({ loaded: true, complete: true, loading: false, error: null });
    expect(api.getAiOutline("nav-session").turns.map((turn) => turn.label)).toEqual(["第一条"]);
    // 取过就不再重复扫盘：正文里新发出的那几轮由 entries 接上，不需要第二次扫描。
    await api.loadAiOutline("nav-session", "D:/project");
    expect(outlineCalls()).toBe(1);
    h.invoke.mockRejectedValueOnce(new Error("日志读不出来"));
    await expect(api.loadAiOutline("nav-failed", "D:/project")).rejects.toThrow();
    expect(api.getAiOutline("nav-failed")).toMatchObject({ loaded: false, loading: false, error: expect.stringContaining("日志读不出来") });
    await api.loadAiOutline("nav-failed", "D:/project");
    expect(api.getAiOutline("nav-failed").loaded).toBe(true);
  });
  it("跳到未加载的那一轮时把中间的事件连续补回来，不留空洞", async () => {
    const api = await import("../../src/lib/aiRuntime");
    const limits: number[] = [];
    h.invoke.mockImplementation(async (command: string, args?: { beforeSeq?: number; limit?: number }) => {
      if (command !== "ai_runtime_load") return undefined;
      limits.push(args?.limit ?? 0);
      // 每页只倒得动 200 条，模拟后端字节预算把条数砍下来。
      const before = args?.beforeSeq ?? 1001;
      const from = Math.max(1, before - 200);
      const events = [];
      for (let seq = from; seq < before; seq++) events.push(event(seq, seq === 500 ? "user" : "text", seq === 500 ? { text: "很久以前说的那句话" } : { id: `m${seq}`, text: "x" }));
      return { events, hasOlder: from > 1, nextSeq: from, nativeId: null, status: "completed", latestSeq: 1000, latestRunId: "run" };
    });
    await api.loadAiMessages(session.id, "D:/project");
    expect(api.useAiRuntime(session.id).cursor).toBe(801);
    expect(await api.loadAiMessagesThrough(session.id, "D:/project", 500)).toBe(true);
    const snapshot = api.useAiRuntime(session.id);
    expect(snapshot.cursor).toBeLessThanOrEqual(500);
    // 导航点是正文里那条 id：补回来的必须正好是它，而不是「大概到附近」。
    expect(snapshot.entries.some((entry) => entry.kind === "user" && entry.id === "run:500")).toBe(true);
    expect(limits.slice(1)).toEqual([500, 500]);
  });
  it("补到上限还够不着就如实说够不着", async () => {
    const api = await import("../../src/lib/aiRuntime");
    let pages = 0;
    h.invoke.mockImplementation(async (command: string, args?: { beforeSeq?: number }) => {
      if (command !== "ai_runtime_load") return undefined;
      pages += 1;
      const before = args?.beforeSeq ?? 9001;
      // 巨型事件占满预算：一页只挪得动一条，几百轮外的那条根本补不到。
      const seq = before - 1;
      return { events: [event(seq, "text", { id: `m${seq}`, text: "一屏装不下" })], hasOlder: true, nextSeq: seq, nativeId: null, status: "completed", latestSeq: 9000, latestRunId: "run" };
    });
    await api.loadAiMessages(session.id, "D:/project");
    expect(await api.loadAiMessagesThrough(session.id, "D:/project", 1)).toBe(false);
    // 停在愿意付的代价上：不是一路翻到会话开头。
    expect(pages).toBeLessThanOrEqual(13);
    expect(api.useAiRuntime(session.id).hasOlder).toBe(true);
  });
});
