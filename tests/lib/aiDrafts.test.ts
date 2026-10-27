import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiSessionStorageKey } from "../../src/lib/aiSessions";
import { browseCancel, browseDown, browseTyped, browseUp, caretOnFirstLine, caretOnLastLine, clearAiSessionStorage, clearDraft, clearDraftImages, flushDraft, loadDraft, loadDraftImages, loadPromptHistory, rememberPrompt, saveDraft, saveDraftImages, subscribeDraftImages, updateDraftImages } from "../../src/lib/aiDrafts";
import type { DraftState } from "../../src/lib/aiDrafts";

const ROOT = "D:\\app\\code\\forge";
const PROMPTS = `${aiSessionStorageKey(ROOT)}:prompts`;
/** 直接看写进了哪些键：草稿是不是真被删掉，光靠 loadDraft 返回 "" 分不出来。 */
let store: Map<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  });
});
afterEach(() => {
  // 模拟窗口退出，刷完当前存储的待写入项，避免跨用例遗留防抖任务。
  flushDraft();
  vi.useRealTimers();
});

describe("AI 草稿持久化", () => {
  it("按会话分别存回，切标签不会串用别人的半截话", () => {
    saveDraft(ROOT, "s1", "第一条写到一半");
    saveDraft(ROOT, "s2", "另一条");
    expect(loadDraft(ROOT, "s1")).toBe("第一条写到一半");
    expect(loadDraft(ROOT, "s2")).toBe("另一条");
    expect(loadDraft(ROOT, "missing")).toBe("");
  });
  it("同一个工程的路径写法不同也算同一个键", () => {
    saveDraft("D:\\app\\code\\forge\\", "s1", "带尾斜杠");
    expect(loadDraft("d:/app/code/forge", "s1")).toBe("带尾斜杠");
    expect(loadDraft("D:\\app\\code\\other", "s1")).toBe("");
  });
  it("快速切换项目与会话时，每份草稿都能延迟落盘", () => {
    saveDraft(ROOT, "s1", "第一条");
    saveDraft(ROOT, "s2", "第二条");
    saveDraft("D:/other", "s1", "其他项目");
    expect(loadDraft(ROOT, "s1")).toBe("第一条");
    expect(loadDraft("D:/other", "s1")).toBe("其他项目");
    expect(store.size).toBe(0);
    vi.advanceTimersByTime(300);
    expect(store.get(`${aiSessionStorageKey(ROOT)}:draft:s1`)).toBe("第一条");
    expect(store.get(`${aiSessionStorageKey(ROOT)}:draft:s2`)).toBe("第二条");
    expect(store.get(`${aiSessionStorageKey("D:/other")}:draft:s1`)).toBe("其他项目");
  });
  it("发送清空与删除会话取消各自的待写入项，不影响其他项目", () => {
    saveDraft(ROOT, "s1", "已发送");
    saveDraft(ROOT, "s2", "已删除");
    saveDraft("D:/other", "s1", "继续编辑");
    clearDraft(ROOT, "s1");
    clearAiSessionStorage(ROOT, "s2");
    vi.advanceTimersByTime(300);
    expect(loadDraft(ROOT, "s1")).toBe("");
    expect(loadDraft(ROOT, "s2")).toBe("");
    expect(loadDraft("D:/other", "s1")).toBe("继续编辑");
    expect([...store.keys()]).toEqual([`${aiSessionStorageKey("D:/other")}:draft:s1`]);
  });
  it("立即写入一份草稿后，不会被旧的防抖值覆盖", () => {
    saveDraft(ROOT, "s1", "旧值");
    saveDraft(ROOT, "s2", "另一份");
    saveDraft(ROOT, "s1", "新值", true);
    vi.advanceTimersByTime(300);
    expect(loadDraft(ROOT, "s1")).toBe("新值");
    expect(loadDraft(ROOT, "s2")).toBe("另一份");
  });
  it("清空草稿是删键，不是留一条空记录", () => {
    saveDraft(ROOT, "s1", "x");
    saveDraft(ROOT, "s1", "");
    expect(loadDraft(ROOT, "s1")).toBe("");
    expect([...store.keys()].filter((key) => key.includes(":draft:"))).toEqual([]);
  });
  it("删会话时带走它的草稿，发送历史留着", () => {
    saveDraft(ROOT, "s1", "垃圾草稿");
    rememberPrompt(ROOT, "留下来的话");
    clearDraft(ROOT, "s1");
    expect(loadDraft(ROOT, "s1")).toBe("");
    expect(loadPromptHistory(ROOT)).toEqual(["留下来的话"]);
  });
  it("删除会话同时清理草稿、附加目录和会话选项", () => {
    const prefix = aiSessionStorageKey(ROOT);
    saveDraft(ROOT, "s1", "draft");
    saveDraftImages(ROOT, "s1", [{ path: "C:/cache/paste-1.png", name: "screen.png" }]);
    store.set(`${prefix}:dirs:s1`, '["D:/extra"]');
    store.set(`${prefix}:options:s1`, '{"model":"chosen"}');
    clearAiSessionStorage(ROOT, "s1");
    expect([...store.keys()].filter((key) => key.includes(":s1"))).toEqual([]);
  });
  it("按会话保存待发送附件，并忽略损坏缓存", () => {
    const images = [{ path: "C:/cache/paste-1.png", name: "screen.png" }];
    saveDraftImages(ROOT, "s1", images);
    expect(loadDraftImages(ROOT, "s1")).toEqual(images);
    expect(loadDraftImages(ROOT, "s2")).toEqual([]);

    store.set(`${aiSessionStorageKey(ROOT)}:draft-images:s2`, JSON.stringify([
      null, { path: 42, name: "bad" }, { path: "C:/cache/file-2.webp", name: "diagram.webp" },
    ]));
    expect(loadDraftImages(ROOT, "s2")).toEqual([{ path: "C:/cache/file-2.webp", name: "diagram.webp" }]);
    clearDraftImages(ROOT, "s1");
    expect(loadDraftImages(ROOT, "s1")).toEqual([]);
  });
  it("超长草稿只留前面一段", () => {
    saveDraft(ROOT, "s1", "a".repeat(25_000));
    expect(loadDraft(ROOT, "s1")).toHaveLength(20_000);
  });
  it("重新打开页面后收到异步附件追加，合并最新列表且不串项目", () => {
    const first = { path: "C:/cache/first.png", name: "first.png" };
    const second = { path: "C:/cache/second.png", name: "second.png" };
    saveDraftImages(ROOT, "s1", [first]);
    const snapshots: unknown[] = [];
    const stop = subscribeDraftImages("d:/app/code/forge/", "s1", () => snapshots.push(loadDraftImages(ROOT, "s1")));
    const other = vi.fn();
    const stopOther = subscribeDraftImages("D:/other", "s1", other);
    try {
      // 旧页面的复制任务稍后完成，必须保留新页面先加入的附件。
      updateDraftImages(ROOT, "s1", (current) => [...current, second]);
      expect(loadDraftImages(ROOT, "s1")).toEqual([first, second]);
      expect(snapshots).toEqual([[first, second]]);
      expect(other).not.toHaveBeenCalled();
      clearAiSessionStorage(ROOT, "s1");
      expect(snapshots).toEqual([[first, second], []]);
    } finally { stop(); stopOther(); }
    saveDraftImages(ROOT, "s1", [first]);
    expect(snapshots).toHaveLength(2);
  });
  it("附件持久化失败时仍能在本窗口切换页面并手动移除", () => {
    const attachment = { path: "C:/cache/keep.png", name: "keep.png" };
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    });
    saveDraftImages(ROOT, "blocked-session", [attachment]);
    expect(loadDraftImages(ROOT, "blocked-session")).toEqual([attachment]);
    clearDraftImages(ROOT, "blocked-session");
    expect(loadDraftImages(ROOT, "blocked-session")).toEqual([]);
  });
  it("其他窗口保存附件后通知当前订阅，取消订阅后不再接收", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const key = `${aiSessionStorageKey(ROOT)}:draft-images:window-session`;
    const image = { path: "C:/cache/window.png", name: "window.png" };
    const snapshots: unknown[] = [];
    const stop = subscribeDraftImages(ROOT, "window-session", () => snapshots.push(loadDraftImages(ROOT, "window-session")));
    const changed = (storageKey: string | null) => {
      const event = new Event("storage");
      Object.defineProperty(event, "key", { value: storageKey });
      target.dispatchEvent(event);
    };
    try {
      localStorage.setItem(key, JSON.stringify([image]));
      changed("unrelated-key");
      expect(snapshots).toEqual([]);
      changed(key);
      expect(snapshots).toEqual([[image]]);
      store.clear();
      changed(null);
      expect(snapshots).toEqual([[image], []]);
    } finally { stop(); vi.unstubAllGlobals(); }
    changed(key);
    expect(snapshots).toHaveLength(2);
  });
  it("存储坏了不影响挂载，读取退回空草稿", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    });
    expect(loadDraft(ROOT, "s1")).toBe("");
    expect(() => saveDraft(ROOT, "s1", "写不进去")).not.toThrow();
    expect(() => clearDraft(ROOT, "s1")).not.toThrow();
    expect(() => rememberPrompt(ROOT, "也写不进去")).not.toThrow();
    expect(loadPromptHistory(ROOT)).toEqual([]);
  });
});

describe("AI 发送历史", () => {
  it("最新一条排最前，并按容量截断", () => {
    for (const index of Array.from({ length: 55 }, (_, i) => i)) rememberPrompt(ROOT, `第 ${index} 条`);
    const history = loadPromptHistory(ROOT);
    expect(history).toHaveLength(50);
    expect(history[0]).toBe("第 54 条");
    expect(history.at(-1)).toBe("第 5 条");
  });
  it("连续重复只留一份，隔开的重复各自留", () => {
    rememberPrompt(ROOT, "同一句");
    rememberPrompt(ROOT, "   同一句   ");
    rememberPrompt(ROOT, "另一句");
    rememberPrompt(ROOT, "同一句");
    expect(loadPromptHistory(ROOT)).toEqual(["同一句", "另一句", "同一句"]);
  });
  it("斜杠命令与空白正文不进历史", () => {
    for (const value of ["/compact", "  /model gpt", "", "   "]) rememberPrompt(ROOT, value);
    expect(loadPromptHistory(ROOT)).toEqual([]);
  });
  it("坏数据与超长条目都按可用处理", () => {
    localStorage.setItem(PROMPTS, "{not json");
    expect(loadPromptHistory(ROOT)).toEqual([]);
    localStorage.setItem(PROMPTS, JSON.stringify(["好的一条", 42, null, "", "x".repeat(5_000)]));
    expect(loadPromptHistory(ROOT)).toEqual(["好的一条", "x".repeat(5_000)]);
    rememberPrompt(ROOT, "y".repeat(5_000));
    expect(loadPromptHistory(ROOT)[0]).toHaveLength(2_000);
  });
});

describe("↑↓ 历史召回", () => {
  const history = ["最新", "上一条", "最老"];
  const fresh: DraftState = { text: "", browse: null };
  it("从空行开始按 ↑ 落到最新一条，按 ↓ 走到底再回到 stash", () => {
    const first = browseUp(history, fresh);
    expect(first).toEqual({ text: "最新", browse: { index: 0, stash: "" } });
    expect(browseUp(history, first)).toEqual({ text: "上一条", browse: { index: 1, stash: "" } });
    expect(browseUp(history, browseUp(history, first))).toEqual({ text: "最老", browse: { index: 2, stash: "" } });
    // 已经到最老一条，再按 ↑ 停在原地而不是把内容清空。
    expect(browseUp(history, browseUp(history, browseUp(history, first)))).toEqual({ text: "最老", browse: { index: 2, stash: "" } });
    expect(browseDown(history, { text: "最老", browse: { index: 2, stash: "" } })).toEqual({ text: "上一条", browse: { index: 1, stash: "" } });
    expect(browseDown(history, { text: "最新", browse: { index: 0, stash: "自己打了一半" } })).toEqual({ text: "自己打了一半", browse: null });
  });
  it("没在召回状态时按 ↓ 什么都不动，历史为空时按 ↑ 什么都不动", () => {
    expect(browseDown(history, fresh)).toBe(fresh);
    expect(browseUp([], { text: "手写的", browse: null })).toEqual({ text: "手写的", browse: null });
  });
  it("召回后改字：位置留住，改动成为走出历史时要回的那行", () => {
    const recalled = browseUp(history, { text: "原来的草稿", browse: null });
    const edited = browseTyped("最新（我改过）", recalled);
    expect(edited).toEqual({ text: "最新（我改过）", browse: { index: 0, stash: "最新（我改过）" } });
    expect(browseUp(history, edited)).toEqual({ text: "上一条", browse: { index: 1, stash: "最新（我改过）" } });
    expect(browseDown(history, edited)).toEqual({ text: "最新（我改过）", browse: null });
    expect(browseTyped("直接打字", fresh)).toEqual({ text: "直接打字", browse: null });
  });
  it("Esc 回到召回前的那行并退出召回", () => {
    const recalled = browseUp(history, { text: "正在写的", browse: null });
    expect(browseCancel(recalled)).toEqual({ text: "正在写的", browse: null });
    expect(browseCancel(browseCancel(recalled))).toEqual({ text: "正在写的", browse: null });
  });
  it("历史在召回期间变短时不会取到 undefined", () => {
    expect(browseDown(["最新"], { text: "上一条", browse: { index: 5, stash: "兜底" } }).text).toBe("兜底");
  });
});

describe("召回的按键归属", () => {
  it("只有光标在首行时 ↑ 才归历史，在末行时 ↓ 才归历史", () => {
    const text = "第一行\n第二行\n第三行";
    expect(caretOnFirstLine(text, 0)).toBe(true);
    expect(caretOnFirstLine(text, 3)).toBe(true);
    expect(caretOnFirstLine(text, 5)).toBe(false);
    expect(caretOnFirstLine(text, text.length)).toBe(false);
    expect(caretOnLastLine(text, text.length)).toBe(true);
    expect(caretOnLastLine(text, 10)).toBe(true);
    expect(caretOnLastLine(text, 5)).toBe(false);
  });
  it("光标越界按边界算，不把整段文本判成一行", () => {
    expect(caretOnFirstLine("a\nb", -5)).toBe(true);
    expect(caretOnFirstLine("a\nb", 99)).toBe(false);
    expect(caretOnLastLine("a\nb", -5)).toBe(false);
    expect(caretOnLastLine("a\nb", 99)).toBe(true);
  });
});
