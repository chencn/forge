import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  aggregateMark,
  changeMark,
  folderDeletePaths,
  folderMarks,
  gitCommit,
  gitPull,
  gitFetch,
  gitPush,
  gitPushTarget,
  isProtectedBranch,
  isPushRejected,
  ignoredRoots,
  isDeletedMark,
  markClass,
  recoveryOf,
  rollbackTargets,
  containsRepository,
} from "../../src/lib/git";
import type { GitChange, GitProbe } from "../../src/lib/git";

// 纯函数测试不碰 IPC，mock 掉 invoke 让模块加载不依赖 Tauri 运行时。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class { onmessage = (_line: string) => {}; } }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Git 推送契约", () => {
  it("实时输出经 Channel 转发且保留最终命令返回值", async () => {
    const output = vi.fn();
    vi.mocked(invoke).mockImplementationOnce(async (_command, args) => {
      (args as { onOutput: { onmessage: (line: string) => void } }).onOutput.onmessage("Receiving objects: 25%");
      return "fetched";
    });
    await expect(gitFetch("D:/repo", output)).resolves.toBe("fetched");
    expect(output).toHaveBeenCalledWith("Receiving objects: 25%");
  });
  it("推送目标、租约和标签完整传入后端", async () => {
    vi.mocked(invoke).mockResolvedValue("pushed");
    const options = { branch: "feature/a", remote: "team/origin", target: "review/a", forceWithLease: true, setUpstream: true, tags: "currentBranch" as const };
    await expect(gitPush("D:/repo", options)).resolves.toBe("pushed");
    expect(invoke).toHaveBeenCalledWith("git_push", { root: "D:/repo", options });
    await gitPush("D:/repo");
    expect(invoke).toHaveBeenLastCalledWith("git_push", { root: "D:/repo", options: {} });
  });
  it("目标解析不在前端猜测远端，后端错误原样传出", async () => {
    vi.mocked(invoke).mockResolvedValue({ branch: "local", remote: "team/origin", target: "remote", tracked: true });
    await expect(gitPushTarget("D:/repo", "local")).resolves.toMatchObject({ remote: "team/origin", target: "remote" });
    expect(invoke).toHaveBeenCalledWith("git_push_target", { root: "D:/repo", branch: "local" });
    vi.mocked(invoke).mockRejectedValue(new Error("non-fast-forward"));
    await expect(gitPush("D:/repo")).rejects.toThrow("non-fast-forward");
  });
  it("保护分支规则支持分隔符和通配符，拒绝分类不误判网络错误", () => {
    expect(isProtectedBranch("release/2", "main, master; release/* hotfix/?")).toBe(true);
    expect(isProtectedBranch("hotfix/a", "main, master; release/* hotfix/?")).toBe(true);
    expect(isProtectedBranch("feature/main", "main;release/*")).toBe(false);
    expect(isPushRejected("[rejected] main -> main (fetch first)")).toBe(true);
    expect(isPushRejected("Permission denied (publickey)")).toBe(false);
    expect(isPushRejected("unable to access: network offline")).toBe(false);
  });
});

describe("Git 更新策略 IPC 契约", () => {
  it.each(["ff-only", "merge", "rebase"] as const)("将 %s 策略传到实际更新命令", async (method) => {
    vi.mocked(invoke).mockResolvedValue("updated");
    await expect(gitPull("D:/repo", method)).resolves.toBe("updated");
    expect(invoke).toHaveBeenCalledWith("git_pull", { root: "D:/repo", method });
  });
});

describe("Git 提交 IPC 契约", () => {
  it("只发送当前支持的提交参数，并返回提交结果", async () => {
    vi.mocked(invoke).mockResolvedValue("提交成功");
    await expect(gitCommit("D:/repo", "修复问题", true, ["D:/repo/a.ts"], {
      signoff: true,
      author: "作者 <author@example.com>",
      noVerify: true,
    })).resolves.toBe("提交成功");
    expect(invoke).toHaveBeenCalledWith("git_commit", {
      root: "D:/repo",
      message: "修复问题",
      amend: true,
      paths: ["D:/repo/a.ts"],
      signoff: true,
      author: "作者 <author@example.com>",
      noVerify: true,
      selections: null,
    });
  });

  it("未指定选项时提交索引，并使用默认 Git 参数", async () => {
    vi.mocked(invoke).mockResolvedValue("提交成功");
    await gitCommit("D:/repo", "更新代码", false);
    expect(invoke).toHaveBeenCalledWith("git_commit", {
      root: "D:/repo", message: "更新代码", amend: false, paths: [],
      signoff: false, author: "", noVerify: false,
      selections: null,
    });
  });

  it("提交明确传递每个文件的来源，不把只选工作区修改降级为整文件暂存", async () => {
    vi.mocked(invoke).mockResolvedValue("提交成功");
    const selections = [{ path: "a.ts", oldPath: null, source: "worktreeOnly" as const }];
    await gitCommit("D:/repo", "只提交工作区修改", false, undefined, { selections });
    expect(invoke).toHaveBeenCalledWith("git_commit", expect.objectContaining({ paths: [], selections }));
  });
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

describe("folderDeletePaths Git 文件夹删除范围", () => {
  it("只返回节点下未跟踪的变更文件，不把聚合文件夹本身当成删除目标", () => {
    const targets = folderDeletePaths([
      change({ path: "src/new-a.ts", untracked: true, workStatus: "?" }),
      change({ path: "src/nested/new-b.ts", untracked: true, workStatus: "?" }),
      change({ path: "src/tracked.ts", workStatus: "M" }),
    ]);

    expect(targets).toEqual(["src/new-a.ts", "src/nested/new-b.ts"]);
    expect(targets).not.toContain("src");
  });
});

describe("rollbackTargets Git 回滚范围", () => {
  it("嵌套仓库及其祖先目录不得按未跟踪文件删除，普通同名前缀不受影响", () => {
    /** 已发现的父仓库与子仓库，包含 Windows 大小写和分隔符变化。 */
    const roots = ["D:\\projects", "D:\\projects\\group\\child"];
    expect(containsRepository("d:/projects/group/", roots)).toBe(true);
    expect(containsRepository("d:/projects/group/child", roots)).toBe(true);
    expect(containsRepository("d:/projects/group/child-copy", roots)).toBe(false);
    expect(containsRepository("d:/projects/group/child/file.txt", roots)).toBe(false);
  });
  const tracked = change({ path: "src/tracked.ts", workStatus: "M" });
  const inside = change({ path: "src/nested/new-b.ts", untracked: true, workStatus: "?" });
  const outside = change({ path: "other/outside.ts", untracked: true, workStatus: "?" });

  it("目录节点覆盖其下全部新文件，并把仓库根交给 git 用 `.` 表示", () => {
    expect(rollbackTargets("src", true, [tracked], [inside, outside])).toEqual({
      delete: ["src/nested/new-b.ts"],
      restore: true,
    });
    // 仓库根（空路径）回滚带走全部未跟踪文件，聚合目录自身永远不进清单。
    expect(rollbackTargets("", true, [tracked], [inside, outside])).toEqual({
      delete: ["src/nested/new-b.ts", "other/outside.ts"],
      restore: true,
    });
  });

  it("只看这一条文件路径时不带上同目录的邻居", () => {
    expect(rollbackTargets("src/nested/new-b.ts", false, [tracked], [inside, outside])).toEqual({
      delete: ["src/nested/new-b.ts"],
      restore: false,
    });
  });

  it("都是新文件时没有已跟踪改动要恢复", () => {
    expect(rollbackTargets("src", true, [], [inside])).toEqual({
      delete: ["src/nested/new-b.ts"],
      restore: false,
    });
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
