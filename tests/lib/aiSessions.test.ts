import { describe, expect, it } from "vitest";
import { aiSessionStorageKey, EMPTY_AI_SESSIONS, parseAiSessions, reduceAiSessions } from "../../src/lib/aiSessions";
import type { AiSession } from "../../src/lib/aiSessions";

const session: AiSession = { id: "session-1", title: "Claude Code 会话 1", provider: "claude", createdAt: 1000 };

describe("AI 会话本地状态", () => {
  it("新建即打开；关闭标签保留记录，再次打开不会重复", () => {
    let state = reduceAiSessions(EMPTY_AI_SESSIONS, { type: "create", session });
    expect(state.openIds).toEqual([session.id]);
    expect(state.activeId).toBe(session.id);
    state = reduceAiSessions(state, { type: "close", id: session.id });
    expect(state.sessions).toEqual([session]);
    expect(state.openIds).toEqual([]);
    expect(state.activeId).toBeNull();
    state = reduceAiSessions(state, { type: "open", id: session.id });
    expect(reduceAiSessions(state, { type: "open", id: session.id })).toBe(state);
    expect(reduceAiSessions(state, { type: "create", session })).toBe(state);
  });

  it("重命名修剪空白、限制长度，删除同步移除标签", () => {
    let state = reduceAiSessions(EMPTY_AI_SESSIONS, { type: "create", session });
    expect(reduceAiSessions(state, { type: "rename", id: session.id, title: "  " })).toBe(state);
    state = reduceAiSessions(state, { type: "rename", id: session.id, title: "  测试会话  " });
    expect(state.sessions[0].title).toBe("测试会话");
    state = reduceAiSessions(state, { type: "rename", id: session.id, title: "x".repeat(121) });
    expect(state.sessions[0].title.length).toBe(120);
    expect(reduceAiSessions(state, { type: "delete", id: session.id })).toEqual(EMPTY_AI_SESSIONS);
  });

  it("损坏记录容错，过滤未知提供商、重复 ID 与悬空标签", () => {
    expect(parseAiSessions("broken")).toEqual(EMPTY_AI_SESSIONS);
    expect(parseAiSessions("null")).toEqual(EMPTY_AI_SESSIONS);
    const state = parseAiSessions(JSON.stringify({
      sessions: [null, {}, session, session, { ...session, id: "other", provider: "unknown" },
        { ...session, id: "bad\nid" }, { ...session, id: "untitled", title: "" },
        { ...session, id: "too-long", title: "x".repeat(121) },
        { ...session, id: "bad-time", createdAt: "1000" }],
      openIds: [session.id, "missing", session.id, null],
    }));
    // 旧数据没有 activeId 时迁移到最后一个有效打开标签。
    // 空标题是「还没发第一条消息」的正常状态，不能被当成损坏记录丢掉。
    expect(state).toEqual({ sessions: [session, { ...session, id: "untitled", title: "" }], openIds: [session.id], activeId: session.id });
  });

  it("只恢复安全字段，忽略注入的内容", () => {
    const state = parseAiSessions(JSON.stringify({ sessions: [{ ...session, token: "should-not-copy" }] }));
    expect(state.sessions).toEqual([session]);
    expect(state.openIds).toEqual([]);
  });

  it("按工作区隔离，Windows 路径兼容大小写和分隔符", () => {
    expect(aiSessionStorageKey("D:\\Work\\Project\\")).toBe(aiSessionStorageKey("d:/work/project"));
    expect(aiSessionStorageKey("\\\\Server\\Share\\Project")).toBe(aiSessionStorageKey("//server/share/project/"));
    expect(aiSessionStorageKey("/Work/Project")).not.toBe(aiSessionStorageKey("/work/project"));
    expect(aiSessionStorageKey("/one")).not.toBe(aiSessionStorageKey("/two"));
    expect(aiSessionStorageKey(null)).not.toBe(aiSessionStorageKey("/"));
  });

  it("恢复全部元数据与已打开标签，关闭未知标签不改变状态", () => {
    const state = reduceAiSessions(EMPTY_AI_SESSIONS, { type: "create", session });
    expect(parseAiSessions(JSON.stringify(state))).toEqual(state);
    expect(reduceAiSessions(state, { type: "open", id: "missing" })).toBe(state);
    expect(reduceAiSessions(state, { type: "close", id: "missing" })).toBe(state);
  });

  it("切换和关闭活动标签时持久化准确的会话", () => {
    const second = { ...session, id: "session-2", title: "第二个会话" };
    let state = reduceAiSessions(EMPTY_AI_SESSIONS, { type: "create", session });
    state = reduceAiSessions(state, { type: "create", session: second });
    expect(state.activeId).toBe(second.id);
    state = reduceAiSessions(state, { type: "open", id: session.id });
    expect(state.activeId).toBe(session.id);
    state = reduceAiSessions(state, { type: "close", id: session.id });
    expect(state.activeId).toBe(second.id);
    expect(parseAiSessions(JSON.stringify(state)).activeId).toBe(second.id);
  });
});

describe("会话归档", () => {
  const archived = (id: string, over: Record<string, unknown> = {}) => ({ id, provider: "codex", title: "标题", createdAt: 1, ...over });

  it("只翻一个位：记录、标签和活动标签都不动", () => {
    let state = reduceAiSessions(EMPTY_AI_SESSIONS, { type: "create", session });
    state = reduceAiSessions(state, { type: "archive", id: session.id, archived: true });
    expect(state.sessions[0].archived).toBe(true);
    expect(state.openIds).toEqual([session.id]);
    expect(state.activeId).toBe(session.id);
    // 重复归档与不存在的会话都返回同一引用，不该触发整列重渲染。
    expect(reduceAiSessions(state, { type: "archive", id: session.id, archived: true })).toBe(state);
    expect(reduceAiSessions(state, { type: "archive", id: "missing", archived: true })).toBe(state);
  });

  it("取消归档把键整个去掉，新老缓存的字符串才等价", () => {
    const state = reduceAiSessions(reduceAiSessions(EMPTY_AI_SESSIONS, { type: "create", session }), { type: "archive", id: session.id, archived: true });
    const back = reduceAiSessions(state, { type: "archive", id: session.id, archived: false });
    expect(back.sessions[0].archived).toBeUndefined();
    expect(JSON.stringify(back.sessions[0])).toBe(JSON.stringify(session));
  });

  it("归档状态能跟着本地缓存往返，刷新后不会自己变回去", () => {
    const state = reduceAiSessions(reduceAiSessions(EMPTY_AI_SESSIONS, { type: "create", session }), { type: "archive", id: session.id, archived: true });
    expect(parseAiSessions(JSON.stringify(state))).toEqual(state);
  });

  it("解析只认真写的 true：别的值一律当未归档", () => {
    const read = (value: unknown) => parseAiSessions(JSON.stringify({ sessions: [archived("s", { archived: value })] })).sessions[0];
    expect(read(true).archived).toBe(true);
    for (const value of [undefined, null, false, "true", 1, {}, []]) {
      expect(read(value)).toEqual(archived("s"));
    }
  });
});
