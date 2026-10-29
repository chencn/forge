import { describe, expect, it, vi } from "vitest";
import { gutterChanges, lineChangeBaseline } from "../../src/lib/lineChanges";
import type { GitChange } from "../../src/lib/git";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function change(partial: Partial<GitChange>): GitChange {
  return {
    path: "a.txt",
    oldPath: null,
    indexStatus: " ",
    workStatus: " ",
    untracked: false,
    conflicted: false,
    ...partial,
  };
}

describe("gutterChanges 相对上次提交的行标记", () => {
  it("正文没变就没有标记", () => {
    expect(gutterChanges("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("改了一行，标在那一行上", () => {
    expect(gutterChanges("a\nb\nc\n", "a\nB\nc\n")).toEqual([
      { kind: "modified", startLine: 2, endLine: 2, edge: "line" },
    ]);
  });

  it("只改空白也算修改", () => {
    expect(gutterChanges("a \n", "a\n")).toEqual([
      { kind: "modified", startLine: 1, endLine: 1, edge: "line" },
    ]);
  });

  it("文件末尾多出来的行算新增", () => {
    expect(gutterChanges("a\nb\n", "a\nb\nc\n")).toEqual([
      { kind: "added", startLine: 3, endLine: 3, edge: "line" },
    ]);
  });

  it("空文件写出内容，整篇算新增", () => {
    expect(gutterChanges("", "a\nb\n")).toEqual([
      { kind: "added", startLine: 1, endLine: 3, edge: "line" },
    ]);
  });

  it("中间删掉一行，三角挂在上一行的下沿", () => {
    expect(gutterChanges("a\nb\nc\nd\n", "a\nb\nd\n")).toEqual([
      { kind: "deleted", startLine: 2, endLine: 2, edge: "after" },
    ]);
  });

  it("删掉开头，三角挂在第 1 行的上沿", () => {
    expect(gutterChanges("a\nb\nc\n", "b\nc\n")).toEqual([
      { kind: "deleted", startLine: 1, endLine: 1, edge: "before" },
    ]);
  });

  it("删掉最后一行，三角挂在新的最后一行下沿", () => {
    expect(gutterChanges("a\nb\nc\n", "a\nb\n")).toEqual([
      { kind: "deleted", startLine: 2, endLine: 2, edge: "after" },
    ]);
  });

  it("两行换成一行，是一块修改，不再另画删除", () => {
    expect(gutterChanges("a\nb\nc\n", "a\nX\n")).toEqual([
      { kind: "modified", startLine: 2, endLine: 2, edge: "line" },
    ]);
  });

  it("一行里改两个词，仍是一处", () => {
    expect(gutterChanges("let a = 1 + 2\n", "let A = 1 + B\n")).toEqual([
      { kind: "modified", startLine: 1, endLine: 1, edge: "line" },
    ]);
  });

  it("连续改动几行合成一块", () => {
    expect(gutterChanges("a\nb\nc\nd\n", "a\nB\nC\nd\n")).toEqual([
      { kind: "modified", startLine: 2, endLine: 3, edge: "line" },
    ]);
  });

  it("隔一行没改，就是两处", () => {
    expect(gutterChanges("a\nb\nc\nd\n", "A\nb\nc\nD\n")).toEqual([
      { kind: "modified", startLine: 1, endLine: 1, edge: "line" },
      { kind: "modified", startLine: 4, endLine: 4, edge: "line" },
    ]);
  });

  it("整块新增一段，一块绿", () => {
    expect(gutterChanges("a\nd\n", "a\nb\nc\nd\n")).toEqual([
      { kind: "added", startLine: 2, endLine: 3, edge: "line" },
    ]);
  });

  it("整块删掉一段，一个三角", () => {
    expect(gutterChanges("a\nb\nc\nd\ne\n", "a\ne\n")).toEqual([
      { kind: "deleted", startLine: 1, endLine: 1, edge: "after" },
    ]);
  });
});

describe("lineChangeBaseline 哪篇该画、基线用哪条路径", () => {
  it("仓库外的文件不画", () => {
    expect(lineChangeBaseline("D:\\repo", "D:\\other\\a.ts", [])).toBeNull();
  });

  it("没进变更清单的跟踪文件仍要对照它自己", () => {
    expect(lineChangeBaseline("D:\\repo", "D:\\repo\\Src\\A.ts", [])).toEqual({
      relativePath: "Src/A.ts",
      allowEmpty: false,
    });
  });

  it("已暂存的修改用当前路径，空的 HEAD 文件也要画", () => {
    expect(
      lineChangeBaseline("D:\\repo", "D:\\repo\\Src\\A.ts", [
        change({ path: "Src/A.ts", indexStatus: "M", workStatus: " " }),
      ])
    ).toEqual({ relativePath: "Src/A.ts", allowEmpty: true });
  });

  it("重命名用旧路径当基线", () => {
    expect(
      lineChangeBaseline("D:\\repo", "D:\\repo\\new.ts", [
        change({ path: "new.ts", oldPath: "old.ts", indexStatus: "R", workStatus: " " }),
      ])
    ).toEqual({ relativePath: "old.ts", allowEmpty: true });
  });

  it("未跟踪、冲突、已删除都不画", () => {
    const root = "/repo";
    expect(
      lineChangeBaseline(root, "/repo/a.txt", [change({ path: "a.txt", untracked: true })])
    ).toBeNull();
    expect(
      lineChangeBaseline(root, "/repo/a.txt", [change({ path: "a.txt", conflicted: true })])
    ).toBeNull();
    expect(
      lineChangeBaseline(root, "/repo/a.txt", [change({ path: "a.txt", workStatus: "D" })])
    ).toBeNull();
    expect(
      lineChangeBaseline(root, "/repo/a.txt", [change({ path: "a.txt", indexStatus: "D" })])
    ).toBeNull();
  });

  it("Windows 上路径大小写不同仍对得上同一条变更", () => {
    expect(
      lineChangeBaseline("D:\\repo", "d:\\repo\\Src\\A.ts", [
        change({ path: "Src/A.ts", workStatus: "M" }),
      ])
    ).toEqual({ relativePath: "Src/A.ts", allowEmpty: true });
  });
});
