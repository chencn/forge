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
  it("压缩身份延迟关联时合并已有卡片，增量与重放一致", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    const first = [event(1, "compaction", { episodeId: "run:1", status: "running" }),
      event(2, "compaction", { summaryId: "native-1", text: "摘要", status: "completed" }, "native")];
    const linked = event(3, "compaction", { episodeId: "run:1", summaryId: "native-1", text: "摘要", status: "completed" }, "native");
    for (const state of [projectAiEvents([...first, linked]), projectAiEvents([linked], projectAiEvents(first), true)]) {
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0]).toMatchObject({ text: "摘要", input: { episodeId: "run:1", summaryId: "native-1", status: "completed" } });
    }
  });
  it("原生压缩边界和随后摘要合为一张卡，下一次压缩独立保留", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    const state = projectAiEvents([
      event(1, "compaction", { metadata: { preTokens: 100 } }, "native"),
      event(2, "compaction", { summaryId: "s1", text: "相同摘要", status: "completed" }, "native"),
      event(3, "compaction", { metadata: { preTokens: 200 } }, "native"),
      event(4, "compaction", { summaryId: "s2", text: "相同摘要", status: "completed" }, "native"),
    ]);
    expect(state.entries).toHaveLength(2);
    expect(state.entries.map((entry) => entry.input)).toMatchObject([
      { summaryId: "s1", metadata: { preTokens: 100 } }, { summaryId: "s2", metadata: { preTokens: 200 } },
    ]);
  });
  it.each(["approve", "requestChanges"] as const)("计划 %s 保留当前执行设置", async (decision) => {
    const api = await import("../../src/lib/aiRuntime");
    await api.decideAiPlan(session, "D:/project", { planId: "p", revision: 1 } as never, decision, "修改反馈",
      { model: "selected", effort: "high", permission: "auto", fast: true }, ["D:/extra"]);
    const request = h.invoke.mock.calls.find(([command]) => command === "ai_runtime_send")?.[1]?.request;
    expect(request).toMatchObject({ model: "selected", effort: "high", permission: "auto", fast: true, additionalDirs: ["D:/extra"], prompt: "", plan: { decision } });
  });
  it("未开启 Fast 时明确发送 false", async () => {
    const api = await import("../../src/lib/aiRuntime");
    await api.sendAiMessage(session, "D:/project", "hello", true);
    expect(h.invoke.mock.calls.find(([command]) => command === "ai_runtime_send")?.[1]?.request.fast).toBe(false);
  });
  it("刷新恢复的运行摘要在翻旧页后不会退回排队", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    await runtime.ensureAiRuntimeListener();
    emit(event(2, "status", { status: "queued", prompt: "待执行" }));
    h.invoke.mockResolvedValueOnce({ events: [event(600, "text", { id: "m", text: "已执行" })], hasOlder: true, nextSeq: 600,
      latestSeq: 600, latestRunId: "run", status: "running", activeTasks: [{ runId: "run", status: "running", seq: 2 }] });
    await runtime.loadAiMessages(session.id, "D:/project", true);
    h.invoke.mockResolvedValueOnce({ events: [event(1, "user", { text: "待执行" })], hasOlder: false, nextSeq: 1 });
    await runtime.loadOlderAiMessages(session.id, "D:/project");
    expect(runtime.useAiRuntime(session.id).tasks).toMatchObject([{ status: "running", started: true }]);
    emit(event(601, "status", { status: "completed" }));
    expect(runtime.useAiRuntime(session.id).tasks).toMatchObject([{ status: "completed", started: true }]);
  });
  it("停止命令返回但没有终态事件时保持停止中，不伪造已取消", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    await runtime.ensureAiRuntimeListener();
    emit(event(1, "user", { text: "问题" }), event(2, "status", { status: "queued" }));
    let resolve!: () => void;
    h.invoke.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    const stopping = runtime.stopAiRun("run");
    emit(event(3, "status", { status: "running" }));
    expect(runtime.useAiRuntime(session.id).stopping).toBe(true);
    resolve();
    await stopping;
    expect(runtime.useAiRuntime(session.id)).toMatchObject({ status: "running", stopping: true,
      tasks: [{ status: "running", started: true }] });
  });
  it("取消排队项不会冻结同一会话里正在运行的任务", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    await runtime.ensureAiRuntimeListener();
    emit(
      event(1, "status", { status: "running" }, "running"),
      event(2, "status", { status: "queued", prompt: "稍后执行" }, "queued"),
    );
    await runtime.stopAiRun("queued");
    expect(runtime.useAiRuntime(session.id)).toMatchObject({ status: "running", stopping: false });
  });
  it.each([
    ["普通消息", async (runtime: typeof import("../../src/lib/aiRuntime")) => runtime.sendAiMessage(session, "D:/project", "不会被受理", true)],
    ["计划决策", async (runtime: typeof import("../../src/lib/aiRuntime")) => runtime.decideAiPlan(session, "D:/project", { planId: "p", revision: 1 } as never, "approve")],
  ])("%s 前置校验失败且后端无任务时终结 submitting 占位", async (_label, submit) => {
    const runtime = await import("../../src/lib/aiRuntime");
    h.invoke.mockRejectedValueOnce(new Error("前置校验失败")).mockRejectedValueOnce(new Error("任务未受理"));
    await expect(submit(runtime)).rejects.toThrow("前置校验失败");
    expect(runtime.useAiRuntime(session.id)).toMatchObject({ status: "failed", stopping: false });
    expect(runtime.useAiRuntime(session.id).tasks).toMatchObject([{ status: "failed", error: "Error: 前置校验失败" }]);
  });
  it("发送已受理但 CLI 尚未确认时保持 submitting", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    h.invoke.mockResolvedValueOnce({ status: "submitting" });
    await runtime.sendAiMessage(session, "D:/project", "等待 CLI", true);
    expect(runtime.useAiRuntime(session.id)).toMatchObject({ status: "submitting", tasks: [{ status: "submitting", prompt: "等待 CLI" }] });
    expect(runtime.getAiOwnedRunId(session.id)).not.toBeNull();
    expect(runtime.getAiOwnedQueuedRunIds(session.id)).toEqual([]);
  });
  it("原生历史尚未补齐时自动续读，不需要用户点击更早记录才能看到压缩摘要", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    h.invoke.mockResolvedValueOnce({ events: [event(10, "message", { text: "最新回复" })], hasOlder: true, hasMore: true, nextSeq: 10, nativeId: "native" })
      .mockResolvedValueOnce({ events: [event(11, "compaction", { summaryId: "native-1", text: "完整摘要", status: "completed" })], hasOlder: false, hasMore: false, nextSeq: 11, nativeId: "native" });
    await runtime.loadAiMessages(session.id, "D:/project");
    expect(runtime.useAiRuntime(session.id).entries.map((entry) => entry.text)).toContain("完整摘要");
    expect(h.invoke).toHaveBeenNthCalledWith(2, "ai_runtime_load", expect.objectContaining({ afterSeq: 10 }));
    expect(runtime.useAiRuntime(session.id)).toMatchObject({ cursor: 10, hasOlder: true, loading: false });
  });
  it("原生续读游标不前进时停止并报告错误，避免无休止请求", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    const page = { events: [event(10, "compaction", { text: "摘要" })], hasOlder: false, hasMore: true, nextSeq: 10, nativeId: "native" };
    h.invoke.mockResolvedValue(page);
    await expect(runtime.loadAiMessages(session.id, "D:/project")).rejects.toThrow("没有推进游标");
    expect(h.invoke).toHaveBeenCalledTimes(2);
    expect(runtime.useAiRuntime(session.id).loading).toBe(false);
  });
  it("摘要续读失败不撤销首屏的向前分页能力", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    h.invoke.mockResolvedValueOnce({ events: [event(10, "compaction", { text: "摘要" })], hasOlder: true, hasMore: true, nextSeq: 10, nativeId: "native" })
      .mockRejectedValueOnce(new Error("同步失败"));
    await expect(runtime.loadAiMessages(session.id, "D:/project")).rejects.toThrow("同步失败");
    expect(runtime.useAiRuntime(session.id)).toMatchObject({ cursor: 10, hasOlder: true, loading: false, error: "Error: 同步失败" });
    h.invoke.mockResolvedValueOnce({ events: [event(1, "user", { text: "最早的问题" })], hasOlder: false, nextSeq: 1 });
    await runtime.loadOlderAiMessages(session.id, "D:/project");
    expect(runtime.useAiRuntime(session.id).entries.map((entry) => entry.text)).toContain("最早的问题");
  });
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
    h.invoke.mockResolvedValueOnce([{ sessionId: "external-session", state: "external", queuedCount: 2,
      activeRunId: null, queuedRunIds: ["owned-a", "owned-b"] }, { sessionId: "other", state: "external" }]);
    await api.refreshAiSessionActivity("D:/project", ["external-session", "idle-session"]);
    expect(api.getAiSessionActivity("external-session")).toBe("external");
    expect(api.getAiQueuedCount("external-session")).toBe(2);
    expect(api.getAiOwnedRunId("external-session")).toBeNull();
    expect(api.getAiOwnedQueuedRunIds("external-session")).toEqual(["owned-a", "owned-b"]);
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
  it.each(["idle", "external", "unknown"] as const)("后端活动探针的 %s 覆盖历史里的旧 running", async (state) => {
    const api = await import("../../src/lib/aiRuntime");
    await api.ensureAiRuntimeListener();
    emit(event(1, "status", { status: "running" }));
    h.invoke.mockResolvedValueOnce([{ sessionId: session.id, state }]);
    await api.refreshAiSessionActivity("D:/project", [session.id]);
    expect(api.getAiSessionActivity(session.id)).toBe(state);
  });
  it("较早发出的 activity 响应后返回时不能覆盖新结果", async () => {
    const api = await import("../../src/lib/aiRuntime");
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    h.invoke.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
    const old = api.refreshAiSessionActivity("D:/project", [session.id]);
    const latest = api.refreshAiSessionActivity("D:/project", [session.id]);
    resolveNew([{ sessionId: session.id, state: "idle" }]);
    await latest;
    resolveOld([{ sessionId: session.id, state: "running" }]);
    await old;
    expect(api.getAiSessionActivity(session.id)).toBe("idle");
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
    expect(sends[0][1].request).toMatchObject({ permission: "inherit", fast: false });
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
    const { conversationItems } = await import("../../src/lib/aiTimeline");
    const state = projectAiEvents([
      event(1, "user", { text: "first" }, "run-a"), event(2, "status", { status: "running" }, "run-a"),
      event(3, "user", { text: "second" }, "run-b"), event(4, "status", { status: "queued" }, "run-b"),
      event(5, "user", { text: "third" }, "run-c"), event(6, "status", { status: "waitingExternal" }, "run-c"),
    ]);
    expect(state.runId).toBe("run-a");
    expect(state.status).toBe("running");
    expect(conversationItems(state.entries, state.tasks).map((entry) => entry.text)).toEqual(["first"]);
    expect(state.tasks.map((task) => [task.runId, task.status, task.prompt])).toEqual([
      ["run-a", "running", "first"], ["run-b", "queued", "second"], ["run-c", "waitingExternal", "third"],
    ]);
    const next = projectAiEvents([event(7, "status", { status: "cancelled" }, "run-b"), event(8, "status", { status: "completed" }, "run-a"), event(9, "status", { status: "running" }, "run-c")], state, true);
    expect(next.runId).toBe("run-c");
    expect(next.tasks.map((task) => task.status)).toEqual(["completed", "cancelled", "running"]);
    expect(conversationItems(next.entries, next.tasks).map((entry) => entry.text)).toEqual(["first", "third"]);
  });
  it("排队编辑后启动只显示最终提示词，取消未启动任务不生成正文", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    const { conversationItems } = await import("../../src/lib/aiTimeline");
    const events = [event(1, "user", { text: "旧提示词", images: ["image.png"] }),
      event(2, "status", { status: "queued" }),
      event(3, "status", { status: "queued", prompt: "最终提示词" })];
    const queued = projectAiEvents(events);
    expect(conversationItems(queued.entries, queued.tasks)).toEqual([]);
    const started = projectAiEvents([event(4, "status", { status: "running" })], queued, true);
    expect(conversationItems(started.entries, started.tasks)).toMatchObject([{ text: "最终提示词", images: ["image.png"] }]);
    expect(started.tasks.filter((task) => task.status === "queued")).toEqual([]);
    const cancelled = projectAiEvents([...events, event(4, "status", { status: "cancelled" })]);
    expect(conversationItems(cancelled.entries, cancelled.tasks)).toEqual([]);
    const history = projectAiEvents([event(1, "user", { text: "原生历史" })]);
    expect(conversationItems(history.entries, history.tasks)).toHaveLength(1);
  });
  it("跨回合 task_list 更新归到新回合并移动到最新位置", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    const state = projectAiEvents([
      event(1, "task_list", { replace: true, items: [{ id: "1", content: "旧任务", status: "pending" }] }, "run-a"),
      event(2, "message", { id: "answer", text: "第一轮结束" }, "run-a"),
      event(3, "task_list", { replace: false, items: [{ id: "1", content: "", status: "completed" }] }, "run-b"),
    ]);
    expect(state.entries.map((entry) => entry.id)).toEqual(["run-a:answer", "session:task-list"]);
    expect(state.entries.at(-1)).toMatchObject({ runId: "run-b", seq: 3,
      input: { items: [{ id: "1", content: "旧任务", status: "completed" }] } });
    const cleared = projectAiEvents([event(4, "task_list", { replace: true, items: [] }, "run-b")], state, true);
    expect(cleared.entries.some((entry) => entry.name === "task_list")).toBe(false);
  });
  it("TaskUpdate 缺失字段时保留原任务内容和状态", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    const initial = projectAiEvents([event(1, "task_list", { replace: true,
      items: [{ id: "1", content: "正在实现", status: "active", detail: "保持 FIFO" }] })]);
    const updated = projectAiEvents([event(2, "task_list", { replace: false, items: [{ id: "1", detail: "等待复核" }] })], initial, true);
    expect(updated.entries.at(-1)?.input).toEqual({ items: [{ id: "1", content: "正在实现", status: "active", detail: "等待复核" }] });
  });
  it("重开会话时从分页摘要恢复完整任务清单，不拿最新页的稀疏补丁冒充全量", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    h.invoke.mockResolvedValueOnce({
      events: [event(20, "task_list", { replace: false, items: [{ id: "2", status: "complete" }] }, "run-b")],
      hasOlder: true, hasMore: false, nextSeq: 20, nativeId: "native", status: "completed", latestSeq: 20, latestRunId: "run-b",
      taskList: { seq: 20, runId: "run-b", items: [
        { id: "1", content: "分析", status: "complete" },
        { id: "2", content: "实现", status: "complete" },
        { id: "3", content: "验证", status: "active" },
      ] },
    });
    await runtime.loadAiMessages(session.id, "D:/project");
    expect(runtime.useAiRuntime(session.id).taskList).toEqual({ seq: 20, runId: "run-b", items: [
      { id: "1", content: "分析", status: "complete" },
      { id: "2", content: "实现", status: "complete" },
      { id: "3", content: "验证", status: "active" },
    ] });
  });
  it("Goal 创建、完成与清除保持线程级状态，不生成 Task 条目", async () => {
    const { projectAiEvents } = await import("../../src/lib/aiRuntime");
    const base = { threadId: "native", objective: "完成 Goal 与 Task 联测", tokenBudget: 10000,
      tokensUsed: 1200, timeUsedSeconds: 30, createdAt: 1, updatedAt: 2 };
    const active = projectAiEvents([event(1, "goal", { goal: { ...base, status: "active" } })]);
    expect(active.goal).toMatchObject({ seq: 1, objective: base.objective, status: "active" });
    expect(active.taskList).toBeUndefined();
    const completed = projectAiEvents([event(2, "goal", { goal: { ...base, status: "complete", tokensUsed: 8000, updatedAt: 3 } })], active, true);
    expect(completed.goal).toMatchObject({ seq: 2, status: "complete", tokensUsed: 8000 });
    const cleared = projectAiEvents([event(3, "goal", { goal: null })], completed, true);
    expect(cleared.goal).toBeUndefined();
  });
  it("Goal 暂停通过受限命令发送线程、工作区和状态", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    await runtime.setAiGoalStatus("session", "D:/project", "paused");
    expect(h.invoke).toHaveBeenCalledWith("ai_runtime_set_goal_status", {
      sessionId: "session", workspace: "D:/project", status: "paused",
    });
  });
  it("重开会话时从分页摘要恢复 Goal，并接受已清除快照", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    const goal = { threadId: "native", objective: "持续目标", status: "paused",
      tokensUsed: 42, timeUsedSeconds: 8, createdAt: 1, updatedAt: 2 };
    h.invoke.mockResolvedValueOnce({ events: [], hasOlder: false, hasMore: false, nextSeq: 0, latestSeq: 8,
      goal: { seq: 7, goal } });
    await runtime.loadAiMessages(session.id, "D:/project");
    expect(runtime.useAiRuntime(session.id).goal).toMatchObject({ seq: 7, objective: "持续目标", status: "paused", tokenBudget: null });
    emit(event(8, "goal", { goal: null }));
    expect(runtime.useAiRuntime(session.id).goal).toBeUndefined();
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
    await vi.waitFor(() => expect(runtime.useAiRuntime(session.id).entries[0]?.text).toBe("中文😀"));
    expect(runtime.useAiRuntime(session.id).entries).toHaveLength(1);
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
  it("一次压缩只留一条记录：live 两段与导入边界合并，用户消息开启新段", async () => {
    const runtime = await import("../../src/lib/aiRuntime"); await runtime.ensureAiRuntimeListener();
    emit(
      event(1, "status", { status: "running" }),
      // live：压缩中 + 边界（同一次压缩的两段）。
      event(2, "compaction", { status: "compacting", metadata: { tokensBefore: 100, tokensAfter: 0 } }),
      event(3, "compaction", { status: "completed", metadata: { tokensBefore: 100, tokensAfter: 42 } }),
      // 后续对话……然后历史导入又投影了一次同一次压缩的边界（seq 靠后，但中间没有新用户消息）。
      event(4, "assistant", { id: "m", text: "压缩后的回答" }),
      event(5, "compaction", { status: "completed", metadata: { tokensBefore: 100, tokensAfter: 42 } }),
      // 新的用户消息开启新段落：之后的压缩是另一次。
      event(6, "user", { text: "再来一轮" }),
      event(7, "compaction", { status: "compacting" }),
    );
    const state = runtime.useAiRuntime(session.id);
    const compactions = state.entries.filter((entry) => entry.kind === "notice" && entry.name === "compaction");
    expect(compactions).toHaveLength(2);
    // 合并后保留最新状态与 token 数。
    expect((compactions[0].input as Record<string, unknown>).status).toBe("completed");
    expect((compactions[0].input as Record<string, unknown>).metadata).toMatchObject({ tokensAfter: 42 });
  });
  it("压缩摘要按原生记录去重，同轮再次压缩独立显示且取消后停止", async () => {
    const runtime = await import("../../src/lib/aiRuntime"); await runtime.ensureAiRuntimeListener();
    // 后端给每条实时压缩事件盖 episodeId，捞回来的摘要带上它认领的那一段，前端只按这份标识认亲。
    emit(event(1, "status", { status: "running" }),
      event(2, "compaction", { status: "compacting", episodeId: "run:1" }),
      event(3, "compaction", { status: "completed", episodeId: "run:1" }),
      event(4, "compaction", { status: "compacting", episodeId: "run:2" }),
      event(5, "status", { status: "cancelled" }),
      event(6, "compaction", { summaryId: "native-100", episodeId: "run:1", text: "摘要一", status: "completed" }, "native"),
      event(7, "compaction", { summaryId: "native-200", episodeId: "run:2", text: "摘要二", status: "completed" }, "native"),
      event(8, "compaction", { summaryId: "native-100", episodeId: "run:1", text: "摘要一", status: "completed" }, "native"));
    // 实时的两条和原生的两条讲的是同两次压缩：摘要折回实时卡，重复的原生记录（seq 8）按 summaryId 去重。
    const entries = runtime.useAiRuntime(session.id).entries.filter((entry) => entry.name === "compaction");
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.text)).toEqual(["摘要一", "摘要二"]);
    // 取消掉的那次仍然是取消掉的：摘要那条的 status 是投影时写死的 completed，不许改写观察到的状态。
    expect(entries[1].input).toMatchObject({ status: "interrupted", summaryId: "native-200" });
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
  it("does not replace a live running turn with an older queued history response", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    await runtime.ensureAiRuntimeListener();
    emit(event(1, "status", { status: "queued" }));
    let resolve!: (page: unknown) => void;
    h.invoke.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const loading = runtime.loadAiMessages(session.id, "D:/project", true);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    emit(event(2, "status", { status: "running" }), event(3, "text", { id: "m", text: "正在继续" }));
    resolve({ events: [event(1, "status", { status: "queued" })], hasOlder: false, nextSeq: 1,
      latestSeq: 1, latestRunId: "run", status: "queued", nativeId: session.id,
      activeTasks: [{ runId: "run", status: "queued", seq: 1 }] });
    await loading;
    expect(runtime.getAiSessionActivity(session.id)).toBe("running");
    expect(runtime.useAiRuntime(session.id)).toMatchObject({ runId: "run", status: "running",
      tasks: [{ runId: "run", status: "running" }] });
    emit(event(4, "text", { id: "m", text: "，新输出" }));
    await vi.waitFor(() => expect(runtime.useAiRuntime(session.id).entries[0]?.text).toBe("正在继续，新输出"));
  });
  it("refreshes a reopened session and restores the active turn outside the newest page", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    h.invoke.mockResolvedValueOnce({ events: [], hasOlder: false, nextSeq: 0, latestSeq: 0, nativeId: session.id, activeTasks: [] });
    await runtime.loadAiMessages(session.id, "D:/project");
    h.invoke.mockResolvedValueOnce({ events: [event(600, "text", { id: "m", text: "后台输出" })],
      hasOlder: true, nextSeq: 600, latestSeq: 600, latestRunId: "run", status: "running", nativeId: session.id,
      activeTasks: [{ runId: "run", status: "running", seq: 1 }] });
    await runtime.loadAiMessages(session.id, "D:/project", true);
    expect(runtime.getAiSessionActivity(session.id)).toBe("running");
    expect(runtime.getAiRunId(session.id)).toBe("run");
    emit(event(601, "text", { id: "m", text: "继续更新" }));
    await vi.waitFor(() => expect(runtime.useAiRuntime(session.id).entries[0]?.text).toBe("后台输出继续更新"));
  });
  it.each(["completed", "cancelled", "failed"])("does not revive a %s turn from an older running summary", async (status) => {
    const runtime = await import("../../src/lib/aiRuntime");
    await runtime.ensureAiRuntimeListener();
    emit(event(1, "status", { status: "running" }));
    let resolve!: (page: unknown) => void;
    h.invoke.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const loading = runtime.loadAiMessages(session.id, "D:/project", true);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    emit(event(2, "status", { status }));
    resolve({ events: [event(1, "status", { status: "running" })], hasOlder: false, nextSeq: 1,
      latestSeq: 1, latestRunId: "run", status: "running", nativeId: session.id,
      activeTasks: [{ runId: "run", status: "running", seq: 1 }] });
    await loading;
    expect(runtime.isAiSessionRunning(session.id)).toBe(false);
    expect(runtime.useAiRuntime(session.id)).toMatchObject({ status, tasks: [{ runId: "run", status }] });
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
  it("refreshes the live turn after an older-page request finishes when reopening", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    h.invoke.mockResolvedValueOnce({ events: [event(100, "text", { id: "old", text: "旧内容" })],
      hasOlder: true, nextSeq: 100, nativeId: session.id, activeTasks: [] });
    await runtime.loadAiMessages(session.id, "D:/project");
    let resolveOlder!: (page: unknown) => void;
    h.invoke.mockImplementationOnce(() => new Promise((done) => { resolveOlder = done; }));
    const older = runtime.loadOlderAiMessages(session.id, "D:/project");
    await vi.waitFor(() => expect(resolveOlder).toBeTypeOf("function"));
    const reopened = runtime.loadAiMessages(session.id, "D:/project", true);
    const focused = runtime.loadAiMessages(session.id, "D:/project", true);
    h.invoke.mockResolvedValueOnce({ events: [event(600, "text", { id: "live", text: "后台内容" })],
      hasOlder: true, nextSeq: 600, latestSeq: 600, latestRunId: "run", status: "running", nativeId: session.id,
      activeTasks: [{ runId: "run", status: "running", seq: 101 }] });
    resolveOlder({ events: [event(99, "text", { id: "older", text: "更早内容" })], hasOlder: true, nextSeq: 99 });
    await Promise.all([older, reopened, focused]);
    expect(h.invoke).toHaveBeenCalledTimes(3);
    expect(h.invoke.mock.calls.at(-1)?.[1]).not.toHaveProperty("beforeSeq");
    expect(runtime.getAiSessionActivity(session.id)).toBe("running");
    expect(runtime.getAiRunId(session.id)).toBe("run");
    expect(runtime.useAiRuntime(session.id).entries.some((entry) => entry.text === "后台内容")).toBe(true);
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
  it("releases closed terminal sessions and reloads them from persistence", async () => {
    const runtime = await import("../../src/lib/aiRuntime"); await runtime.ensureAiRuntimeListener();
    emit(event(1, "user", { text: "问题" }), event(2, "status", { status: "running" }),
      event(3, "message", { id: "m", text: "回答" }), event(4, "status", { status: "completed" }));

    runtime.releaseAiRuntimeSessionCache(session.id);
    expect(runtime.useAiRuntime(session.id)).toMatchObject({ entries: [], tasks: [], loaded: false });
    expect(runtime.getAiSessionLastStatus(session.id)).toBe("completed");

    h.invoke.mockResolvedValueOnce({ events: [event(3, "message", { id: "m", text: "回答" }), event(4, "status", { status: "completed" })],
      hasOlder: true, nextSeq: 3, latestSeq: 4, latestRunId: "run", status: "completed", nativeId: "native", activeTasks: [] });
    await runtime.loadAiMessages(session.id, "D:/project");
    expect(runtime.useAiRuntime(session.id)).toMatchObject({ loaded: true, status: "completed" });
    expect(runtime.useAiRuntime(session.id).entries.map((entry) => entry.text)).toEqual(["回答"]);
  });
  it("keeps a closed background run until its terminal event then releases it", async () => {
    const runtime = await import("../../src/lib/aiRuntime"); await runtime.ensureAiRuntimeListener();
    emit(event(1, "status", { status: "running" }), event(2, "text", { id: "m", text: "后台输出" }));

    runtime.releaseAiRuntimeSessionCache(session.id);
    expect(runtime.useAiRuntime(session.id).entries.map((entry) => entry.text)).toEqual(["后台输出"]);
    emit(event(3, "status", { status: "completed" }));

    expect(runtime.useAiRuntime(session.id)).toMatchObject({ entries: [], tasks: [], loaded: false });
    expect(runtime.getAiSessionLastStatus(session.id)).toBe("completed");
  });
  it("does not let an internal queued refresh cancel a close-time release", async () => {
    const runtime = await import("../../src/lib/aiRuntime");
    let resolveInitial!: (page: unknown) => void;
    let resolveRefresh!: (page: unknown) => void;
    h.invoke.mockImplementationOnce(() => new Promise((done) => { resolveInitial = done; }))
      .mockImplementationOnce(() => new Promise((done) => { resolveRefresh = done; }));
    const initial = runtime.loadAiMessages(session.id, "D:/project");
    await vi.waitFor(() => expect(resolveInitial).toBeTypeOf("function"));
    const refresh = runtime.loadAiMessages(session.id, "D:/project", true);
    runtime.releaseAiRuntimeSessionCache(session.id);

    resolveInitial({ events: [event(1, "message", { id: "old", text: "首屏" })], hasOlder: false, nextSeq: 1, nativeId: "native" });
    await vi.waitFor(() => expect(resolveRefresh).toBeTypeOf("function"));
    resolveRefresh({ events: [event(2, "message", { id: "new", text: "刷新" })], hasOlder: false, nextSeq: 2, nativeId: "native" });
    await Promise.all([initial, refresh]);
    await vi.waitFor(() => expect(runtime.useAiRuntime(session.id).entries).toEqual([]));
    expect(runtime.useAiRuntime(session.id).loaded).toBe(false);
  });
  it("coalesces streaming notifications without delaying state changes", async () => {
    const runtime = await import("../../src/lib/aiRuntime"); await runtime.ensureAiRuntimeListener();
    let notifications = 0;
    const unsubscribe = runtime.subscribeAiChanges(() => { notifications += 1; });
    emit(event(1, "status", { status: "running" }));
    expect(notifications).toBe(1);
    emit(event(2, "text", { id: "m", text: "中" }), event(3, "tool", { id: "t", name: "Read", outputDelta: "x" }));
    emit(event(4, "text", { id: "m", text: "文" }));
    // 高频事件连投影一起合帧，不能只延迟通知却仍为每个 delta 复制整份长会话。
    expect(notifications).toBe(1);
    expect(runtime.useAiRuntime(session.id).entries).toEqual([]);
    // 没有 rAF 的环境靠兜底定时器追上，不会永远欠一次通知。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(notifications).toBe(2);
    expect(runtime.useAiRuntime(session.id).entries.map((entry) => entry.text)).toEqual(["中文", ""]);
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
    const nextRun = projectAiEvents([event(6, "status", { status: "running" }, "next")], state, true);
    expect(nextRun.mcpServers).toBeUndefined();
    const empty = projectAiEvents([event(7, "mcp_servers", { servers: [] }, "next")], nextRun, true);
    expect(empty.mcpServers).toBeUndefined();
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
