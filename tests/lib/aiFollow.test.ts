import { describe, expect, it } from "vitest";
import { BOTTOM_SLOP, isNearBottom, trackFollow, unseenCount } from "../../src/lib/aiFollow";

describe("isNearBottom", () => {
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
