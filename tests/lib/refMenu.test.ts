import { describe, expect, it } from "vitest";
import { buildRefMenu, type RefMenuDeps, type RefTarget } from "../../src/lib/refMenu";
import type { TranslationKey } from "../../src/i18n/lang/zh";

/** 假 t 直接回键名，测试按键名找项，不跟着译文改。 */
const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;

const base: RefMenuDeps = {
  t,
  current: "main",
  upstream: "",
  detached: false,
  onAction: () => {},
  onCompareWith: () => {},
  onDiffWithWorktree: () => {},
};

/** 带变量的文案键名后面跟了参数，按前缀认。 */
const find = (items: ReturnType<typeof buildRefMenu>, key: TranslationKey) =>
  items.find((item) => item.label === key || item.label?.startsWith(`${key}:`));

const local: RefTarget = { name: "feature/x", kind: "local" };

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
