import { describe, expect, it } from "vitest";
import { buildChunkPatch } from "../../src/lib/cm/chunkPatch";

/** 与 @codemirror/merge 的 Chunk 同形的 plain 对象：字符偏移、右开。 */
const chunk = (fromA: number, toA: number, fromB: number, toB: number) => ({ fromA, toA, fromB, toB });

describe("buildChunkPatch 按块补丁", () => {
  const original = "alpha\nbeta\ngamma\ndelta\nepsilon";
  const modified = "alpha\nBETA\ngamma\ndelta\nepsilon";

  it("单行修改：带上 3 行上下文与正确的行号头", () => {
    // beta 在两侧的偏移：第 2 行 = 6..10。
    const patch = buildChunkPatch("src/f.txt", original, modified, chunk(6, 10, 6, 10));
    const lines = patch.split("\n");
    expect(lines[0]).toBe("--- a/src/f.txt");
    expect(lines[1]).toBe("+++ b/src/f.txt");
    expect(lines[2]).toBe("@@ -2,1 +2,1 @@");
    expect(lines[3]).toBe(" alpha");
    expect(lines[4]).toBe("-beta");
    expect(lines[5]).toBe("+BETA");
    expect(lines[6]).toBe(" gamma");
    expect(lines[7]).toBe(" delta");
    expect(lines[8]).toBe(" epsilon");
    // 尾随换行劈出来的空串。
    expect(lines).toHaveLength(10);
  });

  it("纯插入：基线一侧计数为 0，头指插入点前一行", () => {
    // 在 gamma（第 3 行）之后插一行 ZETA。
    const mod = "alpha\nbeta\ngamma\nZETA\ndelta\nepsilon";
    const patch = buildChunkPatch("f.txt", original, mod, chunk(17, 17, 17, 22));
    const lines = patch.split("\n");
    expect(lines[2]).toBe("@@ -3,0 +4,1 @@");
    expect(lines).toContain("+ZETA");
  });

  it("纯删除：当前一侧计数为 0，头也指前一行", () => {
    const mod = "alpha\ngamma\ndelta\nepsilon";
    // beta（6..11，含换行）被删。
    const patch = buildChunkPatch("f.txt", original, mod, chunk(6, 11, 6, 6));
    const lines = patch.split("\n");
    expect(lines[2]).toBe("@@ -2,1 +1,0 @@");
    expect(lines).toContain("-beta");
  });

  it("文件末尾的块：上下文不足 3 行也不越界", () => {
    const mod = "alpha\nbeta\ngamma\ndelta\nEPSILON";
    const at = original.lastIndexOf("epsilon");
    const patch = buildChunkPatch("f.txt", original, mod, chunk(at, original.length, at, mod.length));
    const lines = patch.split("\n");
    expect(lines[2]).toBe("@@ -5,1 +5,1 @@");
    expect(lines).toContain("-epsilon");
    expect(lines).toContain("+EPSILON");
    // 前面取满 3 行上下文：beta / gamma / delta。
    expect(lines[3]).toBe(" beta");
    expect(lines[4]).toBe(" gamma");
    expect(lines[5]).toBe(" delta");
  });
});
