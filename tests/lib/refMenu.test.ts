import { describe, expect, it } from "vitest";
import { buildRefMenu, type RefMenuDeps, type RefTarget } from "../../src/lib/refMenu";
import type { TranslationKey } from "../../src/i18n/lang/zh";
import { branchPopupRows } from "../../src/lib/branchPopup";
import { DEFAULT_SETTINGS } from "../../src/lib/settings";
import type { GitBranch } from "../../src/lib/git";
import { canUpdate } from "../../src/lib/gitGates";
import type { GitState } from "../../src/hooks/useGitState";

/** 假 t 直接回键名，测试按键名找项，不跟着译文改。 */
const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;

const base: RefMenuDeps = {
  t,
  current: "main",
  upstream: "",
  detached: false,
  remotes: 1,
  fresh: false,
  onAction: () => {},
  onCompareWith: () => {},
  onDiffWithWorktree: () => {},
};

/** 带变量的文案键名后面跟了参数，按前缀认。 */
const find = (items: ReturnType<typeof buildRefMenu>, key: TranslationKey) =>
  items.find((item) => item.label === key || item.label?.startsWith(`${key}:`));

const local: RefTarget = { name: "feature/x", kind: "local" };

describe("分支弹窗的引用导航", () => {
  const branch = (name: string, current = false, remote = false): GitBranch => ({ name, current, remote, upstream: "", defaultRef: false });
  const branches = [branch("main", true), branch("feature/one"), branch("feature/two"), branch("origin/main", false, true), branch("origin/HEAD", false, true)];
  const labels = { recent: "recent", local: "local", remote: "remote", tag: "tag" };
  const options = DEFAULT_SETTINGS.branches;
  it("没有最近分支时展开本地分支，当前分支排在前面，远端 HEAD 不列为可操作引用", () => {
    const rows = branchPopupRows(branches, [], [], "", options, new Map(), labels);
    expect(rows.find((r) => r.key === "group:local")).toMatchObject({ expanded: true });
    expect(rows.filter((r) => r.type === "ref").map((r) => r.target.name)).toEqual(["main"]);
    expect(rows.some((r) => r.key.includes("origin/HEAD"))).toBe(false);
  });
  it("最近分支去重并排除当前和已删除引用；搜索时只在本地组返回一次", () => {
    const rows = branchPopupRows(branches, [], ["main", "feature/one", "feature/one", "gone"], "", options, new Map(), labels);
    expect(rows.filter((r) => r.type === "ref").map((r) => r.target.name)).toEqual(["feature/one"]);
    const found = branchPopupRows(branches, [], ["feature/one"], "one", options, new Map(), labels);
    expect(found.filter((r) => r.type === "ref").map((r) => r.target)).toEqual([{ name: "feature/one", kind: "local" }]);
  });
  it("搜索展开被折叠的路径，清空后保留原来的折叠状态和精确远端名", () => {
    const expanded = new Map([["group:remote", false]]);
    const search = branchPopupRows(branches, [], [], "origin/main", options, expanded, labels);
    expect(search.find((r) => r.type === "ref")).toMatchObject({ target: { name: "origin/main", kind: "remote" }, label: "main" });
    expect(branchPopupRows(branches, [], [], "", options, expanded, labels).some((r) => r.type === "ref" && r.target.kind === "remote")).toBe(false);
  });
  it("关闭前缀分组后使用完整名字，隐藏标签时搜索也不返回标签", () => {
    const rows = branchPopupRows(branches, [{ name: "v2", target: "abc", createdMs: 0 }], [], "feature", { ...options, groupByDirectory: false, showTags: false }, new Map(), labels);
    expect(rows.filter((r) => r.type === "ref").map((r) => r.label)).toEqual(["feature/one", "feature/two"]);
    expect(branchPopupRows(branches, [{ name: "v2", target: "abc", createdMs: 0 }], [], "v2", { ...options, showTags: false }, new Map(), labels)).toEqual([]);
  });
  it.each([null, undefined, "", " "])("没有有效上游 %s 时禁止更新项目", (upstream) => {
    expect(canUpdate({ lastCommit: {}, probe: { remotes: ["origin"] }, status: { detached: false, upstream } } as unknown as GitState)).toBe(false);
  });
});

describe("buildRefMenu 游离 HEAD", () => {
  it("不游离时两条变基项都在且可点", () => {
    const menu = buildRefMenu(local, base);
    const rebase = find(menu, "git.refRebaseOnto");
    const checkoutRebase = find(menu, "git.refCheckoutRebase");
    expect(rebase, "少了「将当前变基到它」").toBeDefined();
    expect(checkoutRebase, "少了「签出并变基」").toBeDefined();
    expect(rebase?.disabled).toBeFalsy();
    expect(checkoutRebase?.disabled).toBeFalsy();
  });

  it("游离 HEAD 时两条都置灰并给一句原因，不再拿 'HEAD' 当真分支去变基", () => {
    const menu = buildRefMenu(local, { ...base, current: "HEAD", detached: true });
    const rebase = find(menu, "git.refRebaseOnto");
    const checkoutRebase = find(menu, "git.refCheckoutRebase");
    expect(rebase?.disabled).toBe(true);
    expect(rebase?.hint).toBe("git.detachedRebase");
    expect(checkoutRebase?.disabled).toBe(true);
    expect(checkoutRebase?.hint).toBe("git.detachedRebase");
  });

  it("当前分支那一行仍然不给签出与删除，标签上没有从它新建分支与比较", () => {
    const current = buildRefMenu({ name: "main", kind: "local" }, base);
    expect(find(current, "git.refCheckout")).toBeUndefined();
    expect(find(current, "git.refDelete")).toBeUndefined();
    const tag = buildRefMenu({ name: "v1", kind: "tag" }, base);
    expect(find(tag, "git.refNewBranchFrom")).toBeUndefined();
    expect(find(tag, "git.refCompareWith")).toBeUndefined();
  });
});
