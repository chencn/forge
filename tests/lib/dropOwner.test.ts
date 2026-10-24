import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchDrop, dropPosition, registerDropOwner, type DropOwner } from "../../src/lib/dropOwner";

/** 一个只记录被调了什么的目标；`contains` 由测试给定矩形决定命中。 */
function owner(box: { left: number; right: number; top: number; bottom: number }) {
  const calls: string[] = [];
  const taken: string[][] = [];
  const hovered: boolean[] = [];
  const target: DropOwner = {
    contains: (x, y) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom,
    hovered: (value) => { hovered.push(value); calls.push(`hover:${value}`); },
    take: (paths) => { taken.push(paths); calls.push("take"); },
  };
  return { target, calls, taken, hovered };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("外部文件投放的分派", () => {
  it("没有注册目标时谁都不认领，整窗路由照旧", () => {
    expect(dispatchDrop("drop", ["D:/a.png"], 10, 10)).toBe(false);
  });

  it("指针不在目标矩形里就不算命中，drop 也不接手", () => {
    const { target, taken } = owner({ left: 0, right: 100, top: 0, bottom: 50 });
    const off = registerDropOwner(target);
    expect(dispatchDrop("enter", ["D:/a.png"], 400, 400)).toBe(false);
    expect(dispatchDrop("drop", ["D:/a.png"], 400, 400)).toBe(false);
    expect(taken).toEqual([]);
    off();
  });

  it("命中的目标在 drop 时拿到整批路径，并立刻退出悬停", () => {
    const { target, taken, hovered } = owner({ left: 0, right: 100, top: 0, bottom: 50 });
    const off = registerDropOwner(target);
    expect(dispatchDrop("enter", ["D:/a.png"], 20, 20)).toBe(true);
    expect(dispatchDrop("drop", ["D:/a.png", "D:/b.jpg"], 20, 20)).toBe(true);
    expect(taken).toEqual([["D:/a.png", "D:/b.jpg"]]);
    // 悬停经历点亮→落下熄灭：投放提示不能留在屏幕上。
    expect(hovered).toEqual([true, false]);
    off();
  });

  it("enter/over 只把悬停给命中的那个目标，其余保持熄灭", () => {
    const inside = owner({ left: 0, right: 100, top: 0, bottom: 50 });
    const outside = owner({ left: 200, right: 300, top: 0, bottom: 50 });
    const a = registerDropOwner(inside.target);
    const b = registerDropOwner(outside.target);
    expect(dispatchDrop("enter", ["D:/a.png"], 20, 20)).toBe(true);
    expect(inside.hovered).toEqual([true]);
    expect(outside.hovered).toEqual([false]);
    a(); b();
  });

  it("重叠时后注册的目标优先接手", () => {
    const first = owner({ left: 0, right: 400, top: 0, bottom: 300 });
    const second = owner({ left: 100, right: 200, top: 100, bottom: 200 });
    const a = registerDropOwner(first.target);
    const b = registerDropOwner(second.target);
    expect(dispatchDrop("enter", ["D:/a.png"], 150, 150)).toBe(true);
    expect(dispatchDrop("drop", ["D:/a.png"], 150, 150)).toBe(true);
    expect(second.taken).toEqual([["D:/a.png"]]);
    expect(first.taken).toEqual([]);
    // 悬停只归上层，下层必须熄灭，否则两个投放提示会叠在一起。
    expect(first.hovered).toEqual([false, false]);
    expect(second.hovered).toEqual([true, false]);
    a(); b();
  });

  it("leave 把所有目标熄灭且不认领，取消的拖放不会留下高亮", () => {
    const inside = owner({ left: 0, right: 100, top: 0, bottom: 50 });
    const off = registerDropOwner(inside.target);
    dispatchDrop("enter", ["D:/a.png"], 20, 20);
    expect(dispatchDrop("leave", [], 20, 20)).toBe(false);
    expect(inside.hovered).toEqual([true, false]);
    expect(inside.taken).toEqual([]);
    off();
  });

  it("注销之后不再接手，重复注销不影响别人", () => {
    const gone = owner({ left: 0, right: 100, top: 0, bottom: 50 });
    const kept = owner({ left: 0, right: 100, top: 0, bottom: 50 });
    const off = registerDropOwner(gone.target);
    const keep = registerDropOwner(kept.target);
    off();
    off();
    expect(dispatchDrop("drop", ["D:/a.png"], 20, 20)).toBe(true);
    expect(gone.taken).toEqual([]);
    expect(kept.taken).toEqual([["D:/a.png"]]);
    keep();
  });

  it("take 拿到的是这一批路径的副本，调用方改数组不会回灌", () => {
    const { target, taken } = owner({ left: 0, right: 100, top: 0, bottom: 50 });
    const off = registerDropOwner(target);
    const paths = ["D:/a.png"];
    dispatchDrop("drop", paths, 20, 20);
    paths.push("D:/b.png");
    expect(taken).toEqual([["D:/a.png"]]);
    off();
  });
});

describe("投放坐标换算", () => {
  it("按 devicePixelRatio 把物理像素换成 CSS 像素", () => {
    vi.stubGlobal("window", { devicePixelRatio: 2 });
    expect(dropPosition({ x: 200, y: 80 })).toEqual({ x: 100, y: 40 });
  });

  it("取不到缩放系数时按 1 处理，不能把坐标除以 0", () => {
    vi.stubGlobal("window", { devicePixelRatio: 0 });
    expect(dropPosition({ x: 30, y: 12 })).toEqual({ x: 30, y: 12 });
    vi.stubGlobal("window", {});
    expect(dropPosition({ x: 30, y: 12 })).toEqual({ x: 30, y: 12 });
  });
});
