/**
 * 按块补丁：把 `@codemirror/merge` 的一处 chunk 包成一份统一差异，交给
 * `git apply`（`--cached` 按块暂存、`-R` 按块回退）。
 *
 * 坐标全来自 chunk（字符偏移），这里换算成行号；上下文取基线那一侧的行——
 * 块外两侧内容本来就一致。
 */

/** 把文本拆成行（不带换行符本身）。 */
export function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split("\n");
}

/** 与 `@codemirror/merge` 的 Chunk 同形的坐标（字符偏移、右开）。 */
export interface ChunkCoords {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

export function buildChunkPatch(
  path: string,
  original: string,
  modified: string,
  chunk: ChunkCoords
): string {
  const aLines = splitLines(original);
  const bLines = splitLines(modified);
  const findLine = (doc: string[], offset: number) => {
    // 逐行走到偏移所在的行（行数组不带换行符，+1 是它的长度）：块操作一次只算一块，够用。
    let count = 1;
    let at = 0;
    while (count < doc.length) {
      if (at + doc[count - 1].length >= offset) break;
      at += doc[count - 1].length + 1;
      count += 1;
    }
    return count;
  };
  const startA = findLine(aLines, chunk.fromA);
  const endA = chunk.toA <= chunk.fromA ? startA - 1 : findLine(aLines, chunk.toA - 1);
  const startB = findLine(bLines, chunk.fromB);
  const endB = chunk.toB <= chunk.fromB ? startB - 1 : findLine(bLines, chunk.toB - 1);
  const countA = Math.max(0, endA - startA + 1);
  const countB = Math.max(0, endB - startB + 1);
  const context = 3;
  const ctxFrom = Math.max(1, startA - context);
  const ctxTo = Math.max(startA, Math.min(aLines.length, endA + context));
  const lines: string[] = [];
  lines.push(`--- a/${path}`);
  lines.push(`+++ b/${path}`);
  // 空区间（纯插 / 纯删）按统一差异的规范指「上一行之后」：l,0 = 在第 l 行后面。
  const headA = countA === 0 ? startA - 1 : startA;
  const headB = countB === 0 ? startB - 1 : startB;
  lines.push(`@@ -${headA},${countA} +${headB},${countB} @@`);
  // 上下文行（基线与工作区一致）。
  for (let line = ctxFrom; line < startA; line += 1) {
    lines.push(` ${aLines[line - 1] ?? ""}`);
  }
  // 基线独有的行：删。
  for (let line = startA; line <= endA; line += 1) {
    lines.push(`-${aLines[line - 1] ?? ""}`);
  }
  // 当前独有的行：增。
  for (let line = startB; line <= endB; line += 1) {
    lines.push(`+${bLines[line - 1] ?? ""}`);
  }
  // 块后上下文。
  for (let line = endA + 1; line <= ctxTo; line += 1) {
    lines.push(` ${aLines[line - 1] ?? ""}`);
  }
  return lines.join("\n") + "\n";
}
