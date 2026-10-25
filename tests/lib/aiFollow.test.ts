import { describe, expect, it } from "vitest";
import { BOTTOM_SLOP, isNearBottom, OlderHistoryScroll, trackFollow, unseenCount } from "../../src/lib/aiFollow";

describe("向上历史预加载", () => {
  it("不足一屏时向上滚轮也能启动，首次展示不会自动加载", () => {
    const scroll = new OlderHistoryScroll();
    expect(scroll.shouldLoad(0, 800, true, false)).toBe(false);
    scroll.intent(-100);
    expect(scroll.shouldLoad(0, 800, true, false)).toBe(true);
    scroll.intent(100);
    expect(scroll.shouldLoad(0, 800, true, false)).toBe(false);
  });
  it("首次贴底不加载，上滚到距离顶部两屏时提前加载", () => {
    const scroll = new OlderHistoryScroll();
    scroll.follow(1300);
    expect(scroll.shouldLoad(1300, 800, true, false)).toBe(false);
    scroll.scroll(1200);
    expect(scroll.shouldLoad(1200, 800, true, false)).toBe(true);
    expect(scroll.shouldLoad(1700, 800, true, false)).toBe(false);
  });

  it("补页补偿保持上翻意图，短页完成后无需新滚动事件即可续页", () => {
    const scroll = new OlderHistoryScroll();
    scroll.follow(1500);
    scroll.scroll(1000);
    expect(scroll.begin()).toBe(true);
    expect(scroll.begin()).toBe(false);
    expect(scroll.shouldLoad(1000, 800, true, false)).toBe(false);
    scroll.preserve(1200);
    expect(scroll.scroll(1200)).toBe(0);
    scroll.finish();
    expect(scroll.shouldLoad(1200, 800, true, false)).toBe(true);
    scroll.preserve(2000);
    expect(scroll.shouldLoad(2000, 800, true, false)).toBe(false);
  });

  it("量到一页的真实厚度后提前两页开始读，不是等滑到顶才读", () => {
    const scroll = new OlderHistoryScroll();
    scroll.follow(20000);
    scroll.scroll(19000);
    // 一页 6000px：离顶还剩 11000px（不足两页）就该动手，13000px 还早。
    scroll.measure(6000);
    expect(scroll.shouldLoad(11000, 800, true, false)).toBe(true);
    expect(scroll.shouldLoad(13000, 800, true, false)).toBe(false);
    // 补页落地、阅读位置被补偿之后，头上重新攒够两页就停手，不会一路读到底。
    scroll.begin();
    scroll.preserve(17000);
    scroll.finish();
    expect(scroll.shouldLoad(17000, 800, true, false)).toBe(false);
  });

  it("非正的增量不算一页，仍然退回两屏的提前量", () => {
    const scroll = new OlderHistoryScroll();
    scroll.intent(-100);
    scroll.measure(0);
    scroll.measure(-40);
    expect(scroll.shouldLoad(1600, 800, true, false)).toBe(true);
    expect(scroll.shouldLoad(1601, 800, true, false)).toBe(false);
  });

  it("薄薄一页不会把提前量压到比两屏还短", () => {
    const scroll = new OlderHistoryScroll();
    scroll.intent(-100);
    scroll.measure(120);
    expect(scroll.shouldLoad(1600, 800, true, false)).toBe(true);
    expect(scroll.shouldLoad(1601, 800, true, false)).toBe(false);
  });

  it("用户改为向下滚动或回到底部后停止续页", () => {
    const scroll = new OlderHistoryScroll();
    scroll.follow(1000);
    scroll.scroll(900);
    scroll.begin();
    scroll.scroll(950);
    scroll.preserve(1100);
    scroll.finish();
    expect(scroll.shouldLoad(1100, 800, true, false)).toBe(false);
    scroll.scroll(1000);
    expect(scroll.shouldLoad(1000, 800, true, false)).toBe(true);
    scroll.follow(1100);
    expect(scroll.shouldLoad(1100, 800, true, false)).toBe(false);
  });

  it("加载中、历史耗尽和失败不自动重试，按钮可显式重试", () => {
    const scroll = new OlderHistoryScroll();
    scroll.follow(1000);
    scroll.scroll(500);
    expect(scroll.shouldLoad(500, 800, true, true)).toBe(false);
    expect(scroll.shouldLoad(500, 800, false, false)).toBe(false);
    scroll.begin();
    scroll.finish(true);
    scroll.scroll(400);
    expect(scroll.shouldLoad(400, 800, true, false)).toBe(false);
    expect(scroll.begin()).toBe(true);
    scroll.finish();
    expect(scroll.shouldLoad(400, 800, true, false)).toBe(true);
  });
});

describe("isNearBottom", () => {
  it("首次补足三屏后停止自动填充，用户滚动会接管", () => {
    const scroll = new OlderHistoryScroll();
    expect(scroll.shouldFill(1200, 800, true, false)).toBe(true);
    scroll.begin(true);
    expect(scroll.shouldFill(1600, 800, true, false)).toBe(false);
    scroll.finish();
    expect(scroll.shouldFill(2400, 800, true, false)).toBe(false);
    const reading = new OlderHistoryScroll();
    reading.intent(-1);
    expect(reading.shouldFill(1200, 800, true, false)).toBe(false);
  });
  it("counts the slop band as still at the bottom", () => {
    expect(isNearBottom(1000, 900, 100)).toBe(true);
    expect(isNearBottom(1000, 1000 - 100 - BOTTOM_SLOP, 100)).toBe(true);
  });

  it("reports leaving the bottom past the slop", () => {
    expect(isNearBottom(1000, 1000 - 100 - BOTTOM_SLOP - 1, 100)).toBe(false);
  });

  it("treats content shorter than the viewport as at the bottom", () => {
    expect(isNearBottom(120, 0, 400)).toBe(true);
  });
});

describe("trackFollow", () => {
  it("clears the anchor once the user is back at the bottom", () => {
    expect(trackFollow({ id: "e3" }, true, "e9")).toBeNull();
  });

  it("anchors the tail when the user scrolls away", () => {
    expect(trackFollow(null, false, "e3")).toEqual({ id: "e3" });
  });

  it("keeps the first anchor while the user stays scrolled up", () => {
    expect(trackFollow({ id: "e3" }, false, "e7")).toEqual({ id: "e3" });
  });

  it("stays unanchored while there is nothing to anchor to", () => {
    expect(trackFollow(null, false, undefined)).toBeNull();
  });
});

describe("unseenCount", () => {
  const ids = ["e1", "e2", "e3", "e4", "e5"];

  it("is zero while following", () => {
    expect(unseenCount(null, ids)).toBe(0);
  });

  it("counts only what arrived after the anchor", () => {
    expect(unseenCount({ id: "e3" }, ids)).toBe(2);
    expect(unseenCount({ id: "e1" }, ids)).toBe(4);
  });

  it("is zero when the anchored entry is already the newest", () => {
    expect(unseenCount({ id: "e5" }, ids)).toBe(0);
  });

  it("reports nothing when the anchor is gone rather than guessing", () => {
    expect(unseenCount({ id: "gone" }, ids)).toBe(0);
    expect(unseenCount({ id: "e3" }, [])).toBe(0);
  });
});
