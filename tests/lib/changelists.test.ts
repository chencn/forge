import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LIST_ID,
  assignNew,
  loadChangelists,
  moveTo,
  newChangelistId,
  pruneMoves,
} from "../../src/lib/changelists";

/** node 环境没有 localStorage：拿一份内存_map 顶上，load/save 才有处落。 */
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
});
afterEach(() => store.clear());

describe("changelists 变更列表模型", () => {
  it("没有落盘数据时回空表，活动列表就是默认列表", () => {
    const state = loadChangelists("repo-a");
    expect(state.lists).toEqual([]);
    expect(state.moves).toEqual({});
    expect(state.activeId).toBe(DEFAULT_LIST_ID);
  });

  it("落盘里的坏数据不炸：非列表项与未知归属一律丢弃", () => {
    localStorage.setItem(
      "forge:vcs:changelists:v1:repo-b",
      JSON.stringify({
        lists: [{ id: "cl-1", name: "A" }, { id: "default", name: "假默认" }, null],
        moves: { "a.ts": "cl-1", "b.ts": "unknown", "c.ts": 42 },
        activeId: "nope",
      })
    );
    const state = loadChangelists("repo-b");
    expect(state.lists).toEqual([{ id: "cl-1", name: "A" }]);
    expect(state.moves).toEqual({ "a.ts": "cl-1" });
    expect(state.activeId).toBe(DEFAULT_LIST_ID);
  });

  it("moveTo 挪进用户列表；挪回默认列表就删掉记录", () => {
    let state = { lists: [{ id: "cl-1", name: "A", comment: "" }], moves: {}, activeId: DEFAULT_LIST_ID };
    state = moveTo(state, ["a.ts", "b.ts"], "cl-1");
    expect(state.moves).toEqual({ "a.ts": "cl-1", "b.ts": "cl-1" });
    state = moveTo(state, ["a.ts"], DEFAULT_LIST_ID);
    expect(state.moves).toEqual({ "b.ts": "cl-1" });
  });

  it("pruneMoves 只回收消失文件的记录；都在就原样返回", () => {
    const state = { lists: [], moves: { "a.ts": "cl-1", "gone.ts": "cl-1" }, activeId: DEFAULT_LIST_ID };
    expect(pruneMoves(state, ["a.ts", "b.ts"]).moves).toEqual({ "a.ts": "cl-1" });
    expect(pruneMoves(state, ["a.ts", "gone.ts"])).toBe(state);
  });

  it("assignNew 把没记录的路径落进活动列表；活动是默认列表时不动", () => {
    const active = { lists: [{ id: "cl-1", name: "A", comment: "" }], moves: {}, activeId: "cl-1" };
    expect(assignNew(active, ["n.ts"]).moves).toEqual({ "n.ts": "cl-1" });
    const passive = { lists: [], moves: {}, activeId: DEFAULT_LIST_ID };
    expect(assignNew(passive, ["n.ts"]).moves).toEqual({});
  });

  it("新列表 id 不与默认列表撞", () => {
    expect(newChangelistId()).not.toBe(DEFAULT_LIST_ID);
    expect(newChangelistId()).not.toBe(newChangelistId());
  });
});
