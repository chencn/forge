import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateMark,
  changeMark,
  folderMarks,
  ignoredRoots,
  markClass,
  recoveryOf,
} from "../../src/lib/git";
import type { GitChange, GitProbe } from "../../src/lib/git";

// 纯函数测试不碰 IPC，mock 掉 invoke 让模块加载不依赖 Tauri 运行时。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

function change(partial: Partial<GitChange>): GitChange {
  return {
    path: "a.txt",
    oldPath: null,
    indexStatus: "",
    workStatus: "",
    untracked: false,
    conflicted: false,
    ...partial,
  };
}

describe("changeMark 变更徽标", () => {
  it("未跟踪记 U，冲突记感叹号", () => {
    expect(changeMark(change({ untracked: true }))).toBe("U");
    expect(changeMark(change({ conflicted: true }))).toBe("!");
  });

  it("工作区位的字母优先于索引位，索引位单独改动也认得出", () => {
    expect(changeMark(change({ workStatus: "M" }))).toBe("M");
    expect(changeMark(change({ indexStatus: "A" }))).toBe("A");
    expect(changeMark(change({ indexStatus: "A", workStatus: "D" }))).toBe("D");
  });
});

describe("markClass 徽标染色类", () => {
  it("感叹号走专用类，其余按小写字母", () => {
    // `.mark-!` 不是合法选择器，冲突单独一类。
    expect(markClass("!")).toBe("mark-conflict");
    expect(markClass("M")).toBe("mark-m");
    expect(markClass("A")).toBe("mark-a");
  });
});

describe("aggregateMark 目录聚合标记", () => {
  it("子孙里有 M 就聚合为 M；删除不向上传播", () => {
    expect(aggregateMark([change({ indexStatus: "A" }), change({ workStatus: "M" })])).toBe("M");
    expect(aggregateMark([change({ workStatus: "D" })])).toBeNull();
    expect(aggregateMark([change({ indexStatus: "A" }), change({ workStatus: "D" })])).toBe("A");
  });
});

describe("folderMarks 目录圆点表", () => {
  it("变更沿祖先链向上累加，键是正斜杠相对路径", () => {
    const marks = folderMarks([change({ path: "src/a/b.ts", workStatus: "M" })]);
    expect(marks.get("src")).toBe("M");
    expect(marks.get("src/a")).toBe("M");
    expect(marks.has("src/a/b.ts")).toBe(false);
  });

  it("删除态不把目录染成 D", () => {
    const marks = folderMarks([change({ path: "src/gone.ts", workStatus: "D" })]);
    expect(marks.has("src")).toBe(false);
  });
});

describe("recoveryOf 停在哪个动作中间", () => {
  it("按优先级挑出第一个中间状态，都没有就回 null", () => {
    const probe = (flags: Partial<GitProbe>): GitProbe => ({
      available: true,
      repoRoot: "D:/proj",
      midMerge: false,
      midRebase: false,
      midCherryPick: false,
      midRevert: false,
      remotes: [],
      ...flags,
    });
    expect(recoveryOf(null)).toBeNull();
    expect(recoveryOf(probe({ midRebase: true }))).toBe("rebase");
    expect(recoveryOf(probe({ midMerge: true }))).toBe("merge");
    expect(recoveryOf(probe({ midCherryPick: true }))).toBe("cherryPick");
    expect(recoveryOf(probe({ midRevert: true }))).toBe("revert");
    // 一次只可能停在一个动作上，但真要同时挂着，rebase 最先被挑出。
    expect(recoveryOf(probe({ midRebase: true, midMerge: true }))).toBe("rebase");
  });
});

describe("ignoredRoots 忽略前缀折算", () => {
  it("折成绝对前缀、正斜杠、小写，供前缀比较与搜索剪枝共用", () => {
    const roots = ignoredRoots("D:/Repo/Sub", ["node_modules/", "build"]);
    expect(roots).toEqual(["d:/repo/sub/node_modules", "d:/repo/sub/build"]);
  });

  it("反斜杠的仓库根同样折成斜杠口径", () => {
    expect(ignoredRoots("D:\\Repo", ["dist/"])).toEqual(["d:/repo/dist"]);
  });
});
