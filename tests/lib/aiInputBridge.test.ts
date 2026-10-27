import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendAiInputText, deliverAiInput, formatAiFileReference, routeAiTargets, watchAiInputDelivery } from "../../src/lib/aiInputBridge";
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
