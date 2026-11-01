import { describe, expect, it } from "vitest";
import type { GitChange } from "../../src/lib/git";
import { parseIssueTokens } from "../../src/features/vcs/IssueNavigation";
import {
  aggregateCheck,
  buildChangeTree,
  checkOf,
  groupOf,
  isPartiallyStaged,
  isStaged,
  planCommit,
  toggledCheck,
  type CheckState,
} from "../../src/features/vcs/changes";

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

    it("普通变更归入 changes 组", () => {
      expect(groupOf(change({ workStatus: "M" }))).toBe("changes");
      expect(groupOf(change({ indexStatus: "M" }))).toBe("changes");
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
      expect(tree).toHaveLength(2); // Changes 组与 Unversioned Files 组

      const changesGroup = tree.find((n) => n.group === "changes");
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
  });

  describe("三态勾选与提交计划 planCommit", () => {
    it("初始状态：普通变更默认勾选，未跟踪文件默认不勾选", () => {
      const c1 = change({ path: "mod.ts", workStatus: "M" });
      const c2 = change({ path: "new.ts", untracked: true });
      const checks = new Map<string, CheckState>();

      expect(checkOf(c1, checks)).toBe("all");
      expect(checkOf(c2, checks)).toBe("none");

      const agg = aggregateCheck([c1, c2], checks);
      expect(agg.checked).toBe(false);
      expect(agg.indeterminate).toBe(true);
    });

    it("切换勾选与计划计算", () => {
      const c1 = change({ path: "mod.ts", workStatus: "M" });
      const checks = new Map<string, CheckState>();
      checks.set(c1.path, toggledCheck(checkOf(c1, checks))); // 变为 none

      const plan = planCommit([c1], checks);
      expect(plan.included).toHaveLength(0);
      expect(plan.stage).toHaveLength(0);
      expect(plan.unstage).toHaveLength(0);
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
