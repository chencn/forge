import { describe, expect, it } from "vitest";
import { byScore, isWordAligned, matchText } from "../../src/lib/seRank";

describe("matchText 分档", () => {
  it("全等压过前缀，前缀压过连续，连续压过山尖，山尖压过逐字", () => {
    const exact = matchText("run", "run")!.score;
    const prefix = matchText("runConfig", "run")!.score;
    const inside = matchText("rerun", "run")!.score;
    const hump = matchText("RemoteUploadNode", "run")!.score;
    const loose = matchText("database", "dbe")!.score;
    expect(exact).toBe(1002);
    expect(prefix).toBe(796);
    expect(inside).toBe(596);
    expect(hump).toBe(414);
    expect(loose).toBe(187);
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(hump);
    expect(hump).toBeGreaterThan(loose);
  });

  it("同档里短名获胜：两处连续命中，靠后靠前的都按位置扣", () => {
    expect(matchText("aa", "a")!.score).toBeGreaterThan(matchText("aaaaaaa", "a")!.score);
  });

  it("原文照抄查询的大小写再多给一点", () => {
    expect(matchText("SearchEverywhere", "Search")!.score).toBe(
      matchText("SearchEverywhere", "search")!.score + 5
    );
  });

  it("多个词按空白切开，每个都得中，否则整条不要", () => {
    // 「config run」整串对不上（顺序反了），切成两个词各自去匹配后按下标并起来。
    const hit = matchText("Run Config", "config run");
    expect(hit?.indices).toEqual([0, 1, 2, 4, 5, 6, 7, 8, 9]);
    expect(hit?.score).toBe(636);
    expect(matchText("Run Config", "config zebra")).toBeNull();
  });

  it("wordAligned 只留起头的：散着逐字对上的整条拒", () => {
    expect(matchText("database", "dbe", { wordAligned: true })).toBeNull();
    expect(matchText("runToolWindow", "rtw", { wordAligned: true })!.indices).toEqual([0, 3, 7]);
  });

  it("空查询算全中零分，列表自己排", () => {
    expect(matchText("anything", "")).toEqual({ score: 0, indices: [] });
  });
});

describe("isWordAligned", () => {
  it("连着的一整段直接算对齐", () => {
    expect(isWordAligned("Garbage", [4, 5, 6])).toBe(true);
  });

  it("断开的那一段必须落在分隔符后或大小写山尖上", () => {
    expect(isWordAligned("run Tool", [0, 4])).toBe(true);
    expect(isWordAligned("runTool", [0, 3])).toBe(true);
    expect(isWordAligned("runtool", [0, 3])).toBe(false);
    expect(isWordAligned("database", [0, 4, 7])).toBe(false);
  });
});

describe("byScore", () => {
  it("同分保持来时的顺序", () => {
    const ranked = byScore([
      { id: "a", score: 5 },
      { id: "b", score: 9 },
      { id: "c", score: 5 },
    ]);
    expect(ranked.map((item) => item.id)).toEqual(["b", "a", "c"]);
  });
});
