import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendAiInputText,
  buildSendSessionIdMenuItem,
  deliverAiInput,
  deliverAiSessionId,
  formatAiFileReference,
  getOngoingAiSessionTargets,
  routeAiTargets,
  validateAiSessionIdDelivery,
  watchAiInputDelivery,
} from "../../src/lib/aiInputBridge";
import { flushDraft, loadAdditionalDirs, loadDraft, saveDraft } from "../../src/lib/aiDrafts";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
const ROOT = "D:/project";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  });
  vi.stubGlobal("window", new EventTarget());
  h.invoke.mockReset();
});
afterEach(() => { flushDraft(); vi.unstubAllGlobals(); });

describe("AI 输入投递路由", () => {
  it("没有标签禁用、单标签直发、多标签交给二级菜单选择", () => {
    const first = { id: "one", title: "会话一" };
    const second = { id: "two", title: "会话二" };
    expect(routeAiTargets([])).toEqual({ kind: "disabled" });
    expect(routeAiTargets([first])).toEqual({ kind: "direct", target: first });
    expect(routeAiTargets([first, second])).toEqual({ kind: "choose", targets: [first, second] });
  });

  it("文件引用首行是绝对路径并规范行号", () => {
    expect(formatAiFileReference("D:\\repo\\src\\a.ts", 8, 3)).toBe("D:\\repo\\src\\a.ts\n第 8 行到第 8 行");
  });

  it("向已有草稿追加独立段落且忽略空文本", () => {
    expect(appendAiInputText("原问题\n", "  新上下文  ")).toBe("原问题\n\n  新上下文  ");
    expect(appendAiInputText("原问题", "   ")).toBe("原问题");
  });

  it("文件引用保存到目标草稿，切回目标页面后仍能消费投递", async () => {
    const target = { id: "file-target", title: "文件目标" };
    h.invoke.mockResolvedValueOnce(20);
    await deliverAiInput(ROOT, target, { kind: "file", path: "D:/project/a.ts", startLine: 5 });
    expect(h.invoke).toHaveBeenCalledWith("ai_runtime_file_line_count", { path: "D:/project/a.ts" });
    expect(loadDraft(ROOT, target.id)).toBe("D:/project/a.ts\n第 5 行到第 20 行");
    const receive = vi.fn();
    const stop = watchAiInputDelivery(target.id, receive);
    await Promise.resolve();
    stop();
    expect(receive).toHaveBeenCalledWith({ sessionId: target.id, text: loadDraft(ROOT, target.id), additionalDir: undefined });
  });

  it("生成长文本附件期间继续输入，完成后追加到最新草稿", async () => {
    const target = { id: "slow-target", title: "异步目标" };
    saveDraft(ROOT, target.id, "原草稿", true);
    let finish!: (saved: { path: string; directory: string }) => void;
    h.invoke.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const text = "上下文".repeat(5_000);
    const pending = deliverAiInput(ROOT, target, { kind: "text", text });
    saveDraft(ROOT, target.id, "原草稿，以及等待时输入的新内容");
    finish({ path: "C:/Temp/forge/context.txt", directory: "C:/Temp/forge" });
    await pending;
    expect(h.invoke).toHaveBeenCalledWith("ai_runtime_save_text_attachment", { text });
    expect(loadDraft(ROOT, target.id)).toBe("原草稿，以及等待时输入的新内容\n\n内容较长，已保存到临时附件：C:/Temp/forge/context.txt\n请读取该文件。");
    expect(loadAdditionalDirs(ROOT, target.id)).toEqual(["C:/Temp/forge"]);
    expect(loadDraft("D:/other", target.id)).toBe("");
  });

  it("附件生成失败时不覆盖已有草稿", async () => {
    const target = { id: "failed-target", title: "失败目标" };
    saveDraft(ROOT, target.id, "保留原问题", true);
    h.invoke.mockRejectedValueOnce(new Error("磁盘写入失败"));
    await expect(deliverAiInput(ROOT, target, { kind: "text", text: "x".repeat(13_000) })).rejects.toThrow("磁盘写入失败");
    expect(loadDraft(ROOT, target.id)).toBe("保留原问题");
    expect(loadAdditionalDirs(ROOT, target.id)).toEqual([]);
  });
});

describe("跨会话发送会话 ID", () => {
  it("严格遵守约束：同 Provider 互通，异构 Provider 拒绝发送", () => {
    expect(validateAiSessionIdDelivery("codex", "claude")).toEqual({
      allowed: false,
      reason: "ai.sendSessionId.codexToClaudeBlocked",
    });
    expect(validateAiSessionIdDelivery("claude", "codex")).toEqual({
      allowed: false,
      reason: "ai.sendSessionId.codexToClaudeBlocked",
    });
    expect(validateAiSessionIdDelivery("claude", "claude")).toEqual({ allowed: true });
    expect(validateAiSessionIdDelivery("codex", "codex")).toEqual({ allowed: true });
  });

  it("筛选进行中会话时排除自身、子代理与异构 Provider，只保留同 Provider 打开或运行中的会话", () => {
    const list = [
      { id: "source", title: "源Codex", provider: "codex" as const },
      { id: "tab-claude", title: "标签Claude", provider: "claude" as const },
      { id: "tab-codex-1", title: "标签Codex1", provider: "codex" as const },
      { id: "running-codex-2", title: "运行中Codex2", provider: "codex" as const },
      { id: "subagent", title: "子代理", provider: "codex" as const, parentSessionId: "tab-codex-1" },
      { id: "closed-idle", title: "未打开且空闲", provider: "codex" as const },
    ];
    const openIds = ["source", "tab-claude", "tab-codex-1"];
    const isRunning = (id: string) => id === "running-codex-2";
    const targets = getOngoingAiSessionTargets(list, openIds, { id: "source", provider: "codex" }, isRunning);
    // tab-claude 被严格屏蔽过滤；subagent 和 closed-idle 排除；只留下 tab-codex-1 与 running-codex-2
    expect(targets.map((t) => t.id)).toEqual(["tab-codex-1", "running-codex-2"]);
  });

  it("跨 Provider 违规时 deliverAiSessionId 拒绝发送，合法时写入草稿并激活标签", async () => {
    const sourceCodex = { id: "codex-99", provider: "codex" as const };
    const targetClaude = { id: "claude-88", title: "目标Claude", provider: "claude" as const };
    const onOpen = vi.fn();

    await expect(
      deliverAiSessionId(ROOT, sourceCodex, targetClaude, onOpen)
    ).rejects.toThrow();
    expect(onOpen).not.toHaveBeenCalled();

    const targetCodex = { id: "codex-88", title: "目标Codex", provider: "codex" as const };
    saveDraft(ROOT, targetCodex.id, "原有问题");
    await deliverAiSessionId(ROOT, sourceCodex, targetCodex, onOpen);
    expect(loadDraft(ROOT, targetCodex.id)).toBe("原有问题\n\ncodex-99");
    expect(onOpen).toHaveBeenCalledWith("codex-88");
  });

  it("buildSendSessionIdMenuItem 无目标时直接返回 null（不在菜单中渲染灰色项目）", () => {
    const source = { id: "s1", title: "源", provider: "codex" as const };
    const t = (k: string) => k;
    const item = buildSendSessionIdMenuItem({
      sourceSession: source,
      sessions: [source],
      openIds: ["s1"],
      workspace: ROOT,
      t: t as any,
    });
    expect(item).toBeNull();
  });

  it("buildSendSessionIdMenuItem 仅有异构目标时全部屏蔽并返回 null（严禁展示置灰菜单）", () => {
    const source = { id: "s1", title: "源Codex", provider: "codex" as const };
    const target = { id: "s2", title: "目标Claude", provider: "claude" as const };
    const t = (k: string) => k;
    const item = buildSendSessionIdMenuItem({
      sourceSession: source,
      sessions: [source, target],
      openIds: ["s1", "s2"],
      workspace: ROOT,
      t: t as any,
    });
    // 异构目标被直接屏蔽剔除，因此无可用候选，返回 null
    expect(item).toBeNull();
  });

  it("buildSendSessionIdMenuItem 单目标且同 Provider 时返回可直接发送的一级菜单项", () => {
    const source = { id: "s1", title: "源Codex", provider: "codex" as const };
    const target = { id: "s2", title: "目标Codex", provider: "codex" as const };
    const t = (k: string) => k;
    const item = buildSendSessionIdMenuItem({
      sourceSession: source,
      sessions: [source, target],
      openIds: ["s1", "s2"],
      workspace: ROOT,
      t: t as any,
    });
    expect(item).not.toBeNull();
    expect(item!.disabled).toBeFalsy();
    expect(item!.label).toContain("目标Codex");
  });

  it("buildSendSessionIdMenuItem 多同 Provider 目标时展示子菜单，屏蔽异构项且当前激活标签排在首位", () => {
    const source = { id: "s1", title: "源", provider: "codex" as const };
    const target1 = { id: "s2", title: "Codex会话1", provider: "codex" as const };
    const target2 = { id: "s3", title: "Claude会话", provider: "claude" as const };
    const target3 = { id: "s4", title: "Codex会话2", provider: "codex" as const };
    const t = (k: string, vars?: any) => (vars?.title ? `${vars.title} (当前)` : k);
    const item = buildSendSessionIdMenuItem({
      sourceSession: source,
      sessions: [source, target1, target2, target3],
      openIds: ["s1", "s2", "s3", "s4"],
      activeId: "ai|s4",
      workspace: ROOT,
      t: t as any,
    });
    expect(item).not.toBeNull();
    // target2 (Claude) 必须被彻底屏蔽过滤，只保留 target1 和 target3 两个 Codex 目标
    expect(item!.children).toHaveLength(2);
    // target3 (s4) 是当前激活的，排在第 1 项
    expect(item!.children![0].label).toContain("Codex会话2 (当前)");
    expect(item!.children![0].disabled).toBeFalsy();

    // target1 (s2) 是 Codex，允许发送
    expect(item!.children![1].label).toBe("Codex会话1");
    expect(item!.children![1].disabled).toBeFalsy();
  });
});
