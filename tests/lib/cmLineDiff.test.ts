import { describe, expect, it } from "vitest";
import { lineDiff, lineDiffConfig, textLines } from "../../src/lib/cm/lineDiff";

/**
 * 比对视图的行级差异口径。
 *
 * 库默认逐字符比，还带一条 500 的扫描预算——大文件上它会放弃细节、把后面整段认作一处，
 * 比对视图就变成满屏同色。这里比的是「一行一个字符」的编码，偏移即行下标；
 * 交回库的区间必须换回真实字符偏移，含改动那行的换行。
 */

/** 行级区间 → 字符区间，方便断言。 */
function ranges(original: string, modified: string) {
  return lineDiffConfig
    .override(original, modified)
    .map((change) => [
      original.slice(change.fromA, change.toA),
      modified.slice(change.fromB, change.toB),
    ]);
}

describe("lineDiff 按行比", () => {
  it("改一行是一处，区间落在行下标上", () => {
    const changes = lineDiff("alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n");
    expect(changes).toEqual([{ fromA: 1, toA: 2, fromB: 1, toB: 2 }]);
  });

  it("连续改的几行并成一处", () => {
    const changes = lineDiff("a\nb\nc\nd\n", "a\nX\nY\nd\n");
    expect(changes).toEqual([{ fromA: 1, toA: 3, fromB: 1, toB: 3 }]);
  });

  it("行数超限就不按行比，交回调用方退回粗比", () => {
    const big = Array.from({ length: 20_001 }, (_, line) => `line ${line}`).join("\n");
    expect(lineDiff(big, `${big}\ntail\n`)).toBeNull();
  });

  it("拆行与编辑器同一套：末尾换行多出一行空行", () => {
    expect(textLines("a\nb\n")).toEqual(["a", "b", ""]);
    expect(textLines("a\r\nb\r\n")).toEqual(["a", "b", ""]);
  });
});

describe("lineDiffConfig 换回字符区间", () => {
  it("改一行含它自己的换行", () => {
    expect(ranges("a\nb\nc\n", "a\nB\nc\n")).toEqual([["b\n", "B\n"]]);
  });

  it("文末新增在原文那一侧是零宽区间", () => {
    expect(ranges("a\n", "a\nb\n")).toEqual([["", "b\n"]]);
  });

  it("删掉开头一行，在新文那一侧是零宽区间", () => {
    expect(ranges("a\nb\n", "b\n")).toEqual([["a\n", ""]]);
  });

  it("CRLF 的偏移按换行符本身算", () => {
    expect(ranges("a\r\nb\r\n", "a\r\nB\r\n")).toEqual([["b\r\n", "B\r\n"]]);
  });

  it("两处隔得远的改动是两处——大文件上不再整段认作一处", () => {
    const filler = Array.from({ length: 400 }, (_, line) => `line ${line}`).join("\n");
    const original = `${filler}\n`;
    const modified = original
      .replace("line 0\n", "LINE ZERO\n")
      .replace("line 300\n", "line THREE HUNDRED\n");
    expect(ranges(original, modified)).toEqual([
      ["line 0\n", "LINE ZERO\n"],
      ["line 300\n", "line THREE HUNDRED\n"],
    ]);
  });

  it("完全相同的两份没有区间", () => {
    expect(ranges("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("空对空、空对有内容", () => {
    expect(ranges("", "")).toEqual([]);
    expect(ranges("", "a\nb\n")).toEqual([["", "a\nb\n"]]);
  });

  it("行数超限时退回库的字符比，末尾那段仍然报出来", () => {
    const big = Array.from({ length: 20_001 }, (_, line) => `line ${line}`).join("\n");
    const modified = `${big}\ntail\n`;
    const changes = lineDiffConfig.override(big, modified);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.some((change) => change.toB === modified.length)).toBe(true);
  });
});
