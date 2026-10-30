import { describe, expect, it } from "vitest";
import { lineDiff } from "../../src/lib/cm/lineDiff";

describe("lineDiff 的空白口径", () => {
  it("默认档严格比：只差空白的两行算一处改动", () => {
    const original = "alpha\nbeta\n";
    const modified = "alpha\nbeta   \n";
    const ranges = lineDiff(original, modified);
    expect(ranges).not.toBeNull();
    expect(ranges!.length).toBe(1);
  });

  it("trim 档：只差首尾空白的行不再成块", () => {
    const original = "alpha\nbeta\n";
    const modified = "alpha\n  beta  \n";
    expect(lineDiff(original, modified, "trim")).toEqual([]);
  });

  it("ignore 档：中间空白多少都不算改动", () => {
    const original = "a = 1;\nb = 2;\n";
    const modified = "a=1;\nb    =   2;\n";
    expect(lineDiff(original, modified, "ignore")).toEqual([]);
  });

  it("ignoreEmptyLines 档：多出来的空行整个不进差异，映射折回真实行号", () => {
    // modified 在中间插了两个空行：真实行号里这是 2..4 的空档，但空行不算差异。
    const original = "alpha\nbeta\ngamma\n";
    const modified = "alpha\n\n\nbeta\ngamma\n";
    const ranges = lineDiff(original, modified, "ignoreEmptyLines");
    expect(ranges).toEqual([]);
  });

  it("忽略空行后真正的改动仍按真实行号报", () => {
    // 空行插在改动之前：改动落在真实第 3 行（0 起 2）。
    const original = "alpha\nbeta\ngamma\n";
    const modified = "alpha\n\nBETA\ngamma\n";
    const ranges = lineDiff(original, modified, "ignoreEmptyLines")!;
    expect(ranges.length).toBe(1);
    expect([ranges[0].fromA, ranges[0].toA]).toEqual([1, 2]);
    expect([ranges[0].fromB, ranges[0].toB]).toEqual([2, 3]);
  });
});
