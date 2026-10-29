import { describe, expect, it } from "vitest";
import { fuzzyMatch, indexRuns, wordMatch } from "../../src/lib/seMatch";

describe("fuzzyMatch 三档匹配", () => {
  it("连着的一段最先，下标连着排", () => {
    expect(fuzzyMatch("SearchEverywhere", "earch")).toEqual([1, 2, 3, 4, 5]);
  });

  it("子串对不上就认词首与驼峰的「山尖」", () => {
    // r 在开头，t 与 w 落在 Tool、Window 两个山尖上。
    expect(fuzzyMatch("runToolWindow", "rtw")).toEqual([0, 3, 7]);
  });

  it("连不住又不起头时，退到最松的逐字顺次档", () => {
    // "eh" 里 e 起头、h 夹在中间：驼峰档不要它，逐字档把它捞回来。
    expect(fuzzyMatch("Everywhere", "eh")).toEqual([0, 6]);
  });

  it("词首串起来的算驼峰档", () => {
    // n/f/f/t 分别压在 New、File、From、Template 四个词首上。
    expect(fuzzyMatch("New File From Template", "nfft")).toEqual([0, 4, 9, 14]);
  });

  it("顺序不对就整条不认", () => {
    expect(fuzzyMatch("file", "efl")).toBeNull();
  });

  it("空查询算全中，下标表是空表", () => {
    expect(fuzzyMatch("anything", "")).toEqual([]);
  });
});

describe("wordMatch 只认起头的", () => {
  it("散落的逐字命中整条拒掉", () => {
    // "dbe" 在 "database" 里逐字顺次能对上（d-b-e），但 b、e 都不起头也不连着，
    // IDEA 的 Find Action 匹配器就不认这一档。
    expect(wordMatch("database", "dbe")).toBeNull();
    expect(fuzzyMatch("database", "dbe")).toEqual([0, 4, 7]);
  });

  it("词首串起来的仍然算", () => {
    expect(wordMatch("New File From Template", "nfft")).toEqual([0, 4, 9, 14]);
  });
});

describe("indexRuns 下标并段", () => {
  it("连着的合成一段，断了就分家", () => {
    expect(indexRuns([1, 2, 3, 7, 8, 20])).toEqual([
      [1, 4],
      [7, 9],
      [20, 21],
    ]);
  });

  it("空表就一段也不产生", () => {
    expect(indexRuns([])).toEqual([]);
  });
});
