import { describe, expect, it } from "vitest";
import { alignDiffSides } from "../../src/components/AiDiffEditor";

/** 逐行展开成数组，空位补 null，两侧差异一眼可见。 */
const rows = (text: string) => text.split("\n");

describe("alignDiffSides", () => {
  it("单 hunk：删除只推旧侧、新增只推新侧，上下文同现", () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "+new",
      " tail",
    ].join("\n");
    const { original, modified } = alignDiffSides(diff);
    expect(rows(original)).toEqual(["keep", "old", "tail"]);
    expect(rows(modified)).toEqual(["keep", "new", "tail"]);
  });

  it("两个 hunk 且第一个删了两行：第二个 hunk 按各自起点垫空，两侧逐行对齐", () => {
    // 文件 10 行：hunk1 在 1-3 行删 oldA/oldB（新侧此后少 2 行），
    // hunk2 的头如实给出 -6 +4：旧侧垫 2 行、新侧垫 2 行，删掉的行由新侧空位占行。
    const diff = [
      "@@ -1,3 +1,1 @@",
      " top",
      "-oldA",
      "-oldB",
      "@@ -6,2 +4,2 @@",
      " mid",
      "-late",
      "+early",
    ].join("\n");
    const { original, modified, oldNos, newNos } = alignDiffSides(diff);
    // hunk 之间未改动的区间整段跳过：只呈现修改本身（含紧邻上下文）。
    expect(rows(original)).toEqual(["top", "oldA", "oldB", "mid", "late"]);
    expect(rows(modified)).toEqual(["top", "mid", "early", "", ""]);
    // 行号是真实文件行号：hunk2 从旧 6 / 新 4 起，跳过的区间不占号。
    expect(oldNos).toEqual([1, 2, 3, 6, 7]);
    expect(newNos).toEqual([1, 4, 5, 6, 7]);
    // 两侧行数一致是 Monaco 对齐渲染的前提。
    expect(rows(original)).toHaveLength(rows(modified).length);
  });

  it("没有 hunk 头的裸补丁按行序对齐，短的一侧补空", () => {
    const diff = ["-a", "+b", " c"].join("\n");
    const { original, modified } = alignDiffSides(diff);
    expect(rows(original)).toEqual(["a", "c"]);
    expect(rows(modified)).toEqual(["b", "c"]);
  });
});
