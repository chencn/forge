import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitChange } from "../../src/lib/git";
import { parseIssueTokens } from "../../src/features/vcs/IssueNavigation";
import { DEFAULT_COMMIT_OPTIONS, loadCommitOptions, saveCommitOptions } from "../../src/features/vcs/CommitOptions";
import {
  aggregateCheck,
  buildChangeTree,
  checkKey,
  groupOf,
  isChecked,
  isPartiallyStaged,
  isStaged,
  planCommit,
} from "../../src/features/vcs/changes";

describe("提交选项持久化", () => {
  const storage = new Map<string, string>();
  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("旧选项加载后仅保存作者、Sign-off、Git 钩子和 TODO，保留明确关闭的值", () => {
    const expected = { author: "作者 <author@example.com>", signOff: false, runHooks: false, checkTodo: false };
    storage.set("forge:vcs:commitOptions:v1", JSON.stringify({
      ...expected, reformat: true, optimizeImports: true, cleanup: true, analyzeCode: true,
    }));
    const options = loadCommitOptions();
    expect(options).toEqual(expected);
    saveCommitOptions(options);
    expect(JSON.parse(storage.get("forge:vcs:commitOptions:v1")!)).toEqual(expected);
    expect(loadCommitOptions()).toEqual(expected);
  });

  it("缺失、损坏或字段类型无效时使用默认值", () => {
    for (const raw of [null, "invalid", "null", JSON.stringify({ author: 1, signOff: "true", runHooks: 0, checkTodo: "false" })]) {
      storage.clear();
      if (raw !== null) storage.set("forge:vcs:commitOptions:v1", raw);
      expect(loadCommitOptions()).toEqual(DEFAULT_COMMIT_OPTIONS);
    }
  });
});

function change(partial: Partial<GitChange>): GitChange {
  return {
    path: "src/main.ts",
    oldPath: null,
    indexStatus: "",
    workStatus: "",
    untracked: false,
    conflicted: false,
    ...partial,
  };
}

describe("vcs changes 核心逻辑", () => {
  describe("groupOf 分组逻辑", () => {
    it("未合并冲突归入 conflicts 组", () => {
      expect(groupOf(change({ conflicted: true }))).toBe("conflicts");
    });

    it("未跟踪文件归入 unversioned 组", () => {
      expect(groupOf(change({ untracked: true }))).toBe("unversioned");
    });

    it("未暂存修改归入 unstaged 组，已暂存归入 staged 组", () => {
      expect(groupOf(change({ workStatus: "M" }))).toBe("unstaged");
      expect(groupOf(change({ indexStatus: "M" }))).toBe("staged");
      expect(groupOf(change({ indexStatus: "M", workStatus: "M" }))).toBe("staged");
    });
  });

  describe("isPartiallyStaged 与 isStaged 状态判定", () => {
    it("仅在索引区有状态时为 isStaged", () => {
      expect(isStaged(change({ indexStatus: "M" }))).toBe(true);
      expect(isStaged(change({ workStatus: "M" }))).toBe(false);
      expect(isStaged(change({ untracked: true }))).toBe(false);
    });

    it("索引与工作区同时有改动时为部分暂存", () => {
      expect(isPartiallyStaged(change({ indexStatus: "A", workStatus: "M" }))).toBe(true);
      expect(isPartiallyStaged(change({ indexStatus: "M", workStatus: "" }))).toBe(false);
      expect(isPartiallyStaged(change({ indexStatus: "", workStatus: "M" }))).toBe(false);
      expect(isPartiallyStaged(change({ untracked: true }))).toBe(false);
    });
  });

  describe("buildChangeTree 变更树构建与保留标记", () => {
    it("按目录构建树并保留目录圆点染色 dirMark 与行尾字母 mark", () => {
      const changes: GitChange[] = [
        change({ path: "src/a.ts", workStatus: "M" }),
        change({ path: "src/b.ts", workStatus: "D" }),
        change({ path: "README.md", untracked: true }),
      ];

      const tree = buildChangeTree(changes, true);
      expect(tree).toHaveLength(2); // 未暂存组与 Unversioned Files 组

      const changesGroup = tree.find((n) => n.group === "unstaged");
      expect(changesGroup).toBeDefined();
      expect(changesGroup?.children).toBeDefined();

      // 验证目录节点
      const dirNode = changesGroup?.children?.find((n) => n.type === "dir");
      expect(dirNode).toBeDefined();
      expect(dirNode?.path).toBe("src");
      expect(dirNode?.dirMark).toBe("M"); // 目录圆点聚合色

      // 验证文件节点与行尾状态字母
      const fileA = dirNode?.children?.find((n) => n.label === "a.ts");
      expect(fileA).toBeDefined();
      expect(fileA?.mark).toBe("M");

      const fileB = dirNode?.children?.find((n) => n.label === "b.ts");
      expect(fileB).toBeDefined();
      expect(fileB?.mark).toBe("D");
      expect(fileB?.isDeleted).toBe(true);
    });

    it("部分暂存文件在已暂存与未暂存两组各出现一条，各取自己那一侧的字母", () => {
      const changes: GitChange[] = [
        change({ path: "src/partial.ts", indexStatus: "M", workStatus: "M" }),
        change({ path: "src/staged.ts", indexStatus: "A" }),
      ];

      const tree = buildChangeTree(changes, true);
      expect(tree).toHaveLength(2); // 已暂存组与未暂存组

      const stagedGroup = tree.find((n) => n.group === "staged");
      const unstagedGroup = tree.find((n) => n.group === "unstaged");
      expect(stagedGroup?.files.map((f) => f.path)).toEqual(["src/partial.ts", "src/staged.ts"]);
      expect(unstagedGroup?.files.map((f) => f.path)).toEqual(["src/partial.ts"]);

      // 各组行尾字母取自己那一侧：暂存侧读索引位，未暂存侧读工作区位
      const stagedPartial = stagedGroup?.children
        ?.flatMap((n) => n.children ?? [])
        .find((n) => n.label === "partial.ts");
      const unstagedPartial = unstagedGroup?.children
        ?.flatMap((n) => n.children ?? [])
        .find((n) => n.label === "partial.ts");
      expect(stagedPartial?.mark).toBe("M");
      expect(unstagedPartial?.mark).toBe("M");

      const stagedAdded = stagedGroup?.children
        ?.flatMap((n) => n.children ?? [])
        .find((n) => n.label === "staged.ts");
      expect(stagedAdded?.mark).toBe("A");
    });
  });

  describe("三态勾选与提交计划 planCommit", () => {
    it("初始状态：普通变更默认勾选，未跟踪文件默认不勾选", () => {
      const c1 = change({ path: "mod.ts", workStatus: "M" });
      const c2 = change({ path: "new.ts", untracked: true });
      const checks = new Map<string, boolean>();

      expect(isChecked(c1, "worktree", checks)).toBe(true);
      expect(isChecked(c2, "worktree", checks)).toBe(false);

      const agg = aggregateCheck([c1, c2], "worktree", checks);
      expect(agg.checked).toBe(false);
      expect(agg.indeterminate).toBe(true);
    });

    it("两侧勾选互相独立：勾已暂存那条不动未暂存那条", () => {
      const partial = change({ path: "p.ts", indexStatus: "M", workStatus: "M" });
      const checks = new Map<string, boolean>();

      // 默认：已暂存侧勾，部分暂存的工作区侧不勾
      expect(isChecked(partial, "staged", checks)).toBe(true);
      expect(isChecked(partial, "worktree", checks)).toBe(false);

      // 只翻转已暂存侧，工作区侧不受影响
      checks.set(checkKey("staged", partial.path), false);
      expect(isChecked(partial, "staged", checks)).toBe(false);
      expect(isChecked(partial, "worktree", checks)).toBe(false);
      checks.set(checkKey("worktree", partial.path), true);
      expect(isChecked(partial, "staged", checks)).toBe(false);
      expect(isChecked(partial, "worktree", checks)).toBe(true);
    });

    it("复选框三态只表达纳不纳入：同一侧内混合才画横线", () => {
      const plainFile = change({ path: "q.ts", workStatus: "M" });
      const untrackedFile = change({ path: "new.ts", untracked: true });
      const checks = new Map<string, boolean>();

      // 同侧整组都纳入是勾
      const allOn = aggregateCheck([plainFile, change({ path: "r.ts", workStatus: "M" })], "worktree", checks);
      expect(allOn.checked).toBe(true);
      expect(allOn.indeterminate).toBe(false);

      // 组内一部分纳入、一部分（未跟踪）不纳入才是横线
      const mixed = aggregateCheck([plainFile, untrackedFile], "worktree", checks);
      expect(mixed.checked).toBe(false);
      expect(mixed.indeterminate).toBe(true);
    });

    it("提交计划按两侧勾选独立推导", () => {
      const partial = change({ path: "p.ts", indexStatus: "M", workStatus: "M" });

      // 默认（s勾 w不勾）：只提交暂存块
      const onlyStaged = planCommit([partial], new Map());
      expect(onlyStaged.included.map((f) => f.path)).toEqual(["p.ts"]);
      expect(onlyStaged.selections).toEqual([{ path: "p.ts", oldPath: null, source: "index" }]);

      // s勾 w勾：全部内容提交
      const allChecks = new Map([[checkKey("worktree", partial.path), true]]);
      const everything = planCommit([partial], allChecks);
      expect(everything.included.map((f) => f.path)).toEqual(["p.ts"]);
      expect(everything.selections).toEqual([{ path: "p.ts", oldPath: null, source: "worktree" }]);

      // s不勾 w不勾：不提交，也不改动真实索引
      const noneChecks = new Map([[checkKey("staged", partial.path), false]]);
      const dropped = planCommit([partial], noneChecks);
      expect(dropped.included).toHaveLength(0);
      expect(dropped.selections).toEqual([]);

      // s不勾 w勾：只提交工作区改动
      const workOnlyChecks = new Map([
        [checkKey("staged", partial.path), false],
        [checkKey("worktree", partial.path), true],
      ]);
      const workOnly = planCommit([partial], workOnlyChecks);
      expect(workOnly.included.map((f) => f.path)).toEqual(["p.ts"]);
      expect(workOnly.selections).toEqual([{ path: "p.ts", oldPath: null, source: "worktreeOnly" }]);
    });

    it("纯工作区变更使用工作区来源，取消勾选不动索引", () => {
      const unstaged = change({ path: "mod.ts", workStatus: "M" });

      const on = planCommit([unstaged], new Map());
      expect(on.included.map((f) => f.path)).toEqual(["mod.ts"]);
      expect(on.selections).toEqual([{ path: "mod.ts", oldPath: null, source: "worktree" }]);

      const off = new Map([[checkKey("worktree", unstaged.path), false]]);
      const skip = planCommit([unstaged], off);
      expect(skip.included).toHaveLength(0);
      expect(skip.selections).toEqual([]);
    });

    it("冲突文件不进提交计划：porcelain 的 UU 两边都有字母，不能对它跑 unstage", () => {
      const conflicted = change({ path: "c.ts", indexStatus: "U", workStatus: "U", conflicted: true });
      const plan = planCommit([conflicted], new Map());
      expect(plan.included).toHaveLength(0);
      expect(plan.selections).toEqual([]);
    });

    it("已暂存文件取消勾选保留原内容，未跟踪文件勾选才提交", () => {
      const stagedFile = change({ path: "s.ts", indexStatus: "M" });
      const untracked = change({ path: "new.ts", untracked: true });

      // 未跟踪默认不勾，显式勾上才纳入
      const checks = new Map([
        [checkKey("staged", stagedFile.path), false],
        [checkKey("worktree", untracked.path), true],
      ]);
      const plan = planCommit([stagedFile, untracked], checks);
      expect(plan.included.map((f) => f.path)).toEqual(["new.ts"]);
      expect(plan.selections).toEqual([{ path: "new.ts", oldPath: null, source: "worktree" }]);
    });
  });

  describe("Issue Navigation 工单超链接解析 parseIssueTokens", () => {
    const patterns = [
      { id: "1", issueId: "([A-Z]+-\\d+)", issueLink: "https://jira.example.com/browse/$1" },
      { id: "2", issueId: "#(\\d+)", issueLink: "https://github.com/org/repo/issues/$1" },
    ];

    it("无匹配规则或纯文本时返回单个 text token", () => {
      const tokens = parseIssueTokens("feat: normal commit message", []);
      expect(tokens).toEqual([{ type: "text", value: "feat: normal commit message" }]);
    });

    it("正确匹配 JIRA 工单并安全替换 $1", () => {
      const tokens = parseIssueTokens("fix(core): resolve PROJ-1024 crash", patterns);
      expect(tokens).toEqual([
        { type: "text", value: "fix(core): resolve " },
        { type: "link", value: "PROJ-1024", url: "https://jira.example.com/browse/PROJ-1024" },
        { type: "text", value: " crash" },
      ]);
    });

    it("支持混合多个不同工单规范（如 JIRA 与 GitHub #ID）", () => {
      const tokens = parseIssueTokens("fix: resolve PROJ-123 and close #456", patterns);
      expect(tokens).toEqual([
        { type: "text", value: "fix: resolve " },
        { type: "link", value: "PROJ-123", url: "https://jira.example.com/browse/PROJ-123" },
        { type: "text", value: " and close " },
        { type: "link", value: "#456", url: "https://github.com/org/repo/issues/456" },
      ]);
    });

    it("容错处理：跳过非法正则表达式，不抛出异常", () => {
      const invalidPatterns = [
        { id: "bad", issueId: "([unclosed-regex", issueLink: "https://example.com" },
      ];
      const tokens = parseIssueTokens("fix: some message", invalidPatterns);
      expect(tokens).toEqual([{ type: "text", value: "fix: some message" }]);
    });
  });
});
