import { describe, expect, it } from "vitest";

const load = async () => await import("../../src/hooks/useUnsavedGuard");

describe("设置页未保存守卫", () => {
  it("登记后面板的状态决定是否拦住切换", async () => {
    const { registerUnsavedChecker, hasUnsavedSettings } = await load();
    let dirty = false;
    const unregister = registerUnsavedChecker(() => dirty);
    expect(hasUnsavedSettings()).toBe(false);
    dirty = true;
    expect(hasUnsavedSettings()).toBe(true);
    unregister();
    expect(hasUnsavedSettings()).toBe(false);
  });

  it("后登记的覆盖前一个，前者注销不会误清后者", async () => {
    const { registerUnsavedChecker, hasUnsavedSettings } = await load();
    const unregisterFirst = registerUnsavedChecker(() => true);
    const unregisterSecond = registerUnsavedChecker(() => false);
    unregisterFirst();
    expect(hasUnsavedSettings()).toBe(false);
    unregisterSecond();
    expect(hasUnsavedSettings()).toBe(false);
  });

  it("没有面板登记时按没有未保存处理", async () => {
    const { hasUnsavedSettings } = await load();
    expect(hasUnsavedSettings()).toBe(false);
  });
});
