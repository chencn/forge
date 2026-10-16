import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateMark,
  changeMark,
  folderMarks,
  ignoredRoots,
  isDeletedMark,
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

  it("工作区盖过暂存区，只暂存时才用索引位", () => {
    expect(changeMark(change({ workStatus: "M" }))).toBe("M");
    expect(changeMark(change({ indexStatus: "A" }))).toBe("A");
    expect(changeMark(change({ indexStatus: "A", workStatus: "M" }))).toBe("M");
    expect(changeMark(change({ indexStatus: "A", workStatus: "D" }))).toBe("D");
    expect(changeMark(change({ conflicted: true, workStatus: "M" }))).toBe("!");
  });
});

describe("markClass 徽标染色类", () => {
  it("感叹号走专用类，类型变化跟修改同色，复制跟重命名同色", () => {
    // `.mark-!` 不是合法选择器，冲突单独一类。
    expect(markClass("!")).toBe("mark-conflict");
    expect(markClass("M")).toBe("mark-m");
    expect(markClass("A")).toBe("mark-a");
    expect(markClass("T")).toBe("mark-m");
    expect(markClass("C")).toBe("mark-r");
  });
});

describe("isDeletedMark 删除态", () => {
  it("只认大写的 D，其余字母与空串都不是删除", () => {
    expect(isDeletedMark("D")).toBe(true);
    expect(isDeletedMark("M")).toBe(false);
    expect(isDeletedMark("A")).toBe(false);
    expect(isDeletedMark("U")).toBe(false);
    expect(isDeletedMark("!")).toBe(false);
    expect(isDeletedMark("")).toBe(false);
    // 小写的 d 不是 git 给的状态字母，别把它当成删除。
    expect(isDeletedMark("d")).toBe(false);
  });

  it("删除态与 changeMark 的输出对得上", () => {
    expect(isDeletedMark(changeMark(change({ workStatus: "D" })))).toBe(true);
    expect(isDeletedMark(changeMark(change({ indexStatus: "D" })))).toBe(true);
    expect(isDeletedMark(changeMark(change({ indexStatus: "A", workStatus: "D" })))).toBe(true);
    expect(isDeletedMark(changeMark(change({ workStatus: "M" })))).toBe(false);
    expect(isDeletedMark(changeMark(change({ untracked: true })))).toBe(false);
  });
});

describe("aggregateMark 目录聚合标记", () => {
  it("按权重取最高的一档；删除不向上传播", () => {
    expect(aggregateMark([change({ indexStatus: "A" }), change({ workStatus: "M" })])).toBe("M");
    expect(aggregateMark([change({ workStatus: "D" })])).toBeNull();
    expect(aggregateMark([change({ indexStatus: "A" }), change({ workStatus: "D" })])).toBe("A");
    expect(aggregateMark([change({ workStatus: "M" }), change({ conflicted: true })])).toBe("!");
    expect(aggregateMark([change({ indexStatus: "R" }), change({ untracked: true })])).toBe("R");
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

  it("同一层里冲突压过修改", () => {
    const marks = folderMarks([
      change({ path: "src/a.ts", workStatus: "M" }),
      change({ path: "src/b.ts", conflicted: true }),
    ]);
    expect(marks.get("src")).toBe("!");
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
