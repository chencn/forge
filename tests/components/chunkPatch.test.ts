import { describe, expect, it } from "vitest";
import { buildChunkPatch } from "../../src/lib/cm/chunkPatch";

/** 与 @codemirror/merge 的 Chunk 同形的 plain 对象：字符偏移、右开。 */
const chunk = (fromA: number, toA: number, fromB: number, toB: number) => ({ fromA, toA, fromB, toB });

// 补丁是直接喂给 `git apply --unidiff-zero` 的 wire contract：整份字符串逐字断言，
// 一旦多出上下文行或头计数与正文不符，git apply 会报 corrupt / does not apply。
describe("buildChunkPatch 按块补丁（零上下文）", () => {
  const original = "alpha\nbeta\ngamma\ndelta\nepsilon";
  const modified = "alpha\nBETA\ngamma\ndelta\nepsilon";

  it("单行修改：头计数与删/增行数一致", () => {
    // beta 在两侧的偏移：第 2 行 = 6..10。
    const patch = buildChunkPatch("src/f.txt", original, modified, chunk(6, 10, 6, 10));
    expect(patch).toBe("--- a/src/f.txt\n+++ b/src/f.txt\n@@ -2,1 +2,1 @@\n-beta\n+BETA\n");
  });

  it("纯插入：基线一侧计数为 0，头指插入点前一行", () => {
    // 在 gamma（第 3 行）之后插一行 ZETA。
    const mod = "alpha\nbeta\ngamma\nZETA\ndelta\nepsilon";
    const patch = buildChunkPatch("f.txt", original, mod, chunk(17, 17, 17, 22));
    expect(patch).toBe("--- a/f.txt\n+++ b/f.txt\n@@ -3,0 +4,1 @@\n+ZETA\n");
  });

  it("纯删除：当前一侧计数为 0，头也指前一行", () => {
    const mod = "alpha\ngamma\ndelta\nepsilon";
    // beta（6..11，含换行）被删。
    const patch = buildChunkPatch("f.txt", original, mod, chunk(6, 11, 6, 6));
    expect(patch).toBe("--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +1,0 @@\n-beta\n");
  });

  it("文件末尾的块：不产生越界的上下文行", () => {
    const mod = "alpha\nbeta\ngamma\ndelta\nEPSILON";
    const at = original.lastIndexOf("epsilon");
    const patch = buildChunkPatch("f.txt", original, mod, chunk(at, original.length, at, mod.length));
    expect(patch).toBe("--- a/f.txt\n+++ b/f.txt\n@@ -5,1 +5,1 @@\n-epsilon\n+EPSILON\n");
  });
});
