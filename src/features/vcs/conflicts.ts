/**
 * Git 冲突标记解析与块级解决（纯函数）：标记解析与逐块取舍核心。
 */

interface ConflictBlock {
  /** `<<<<<<<` 行的起点偏移。 */
  from: number;
  /** `>>>>>>>` 行终止符之后的偏移。 */
  to: number;
  ours: string;
  /** diff3 的 base 段，没有时为 null。 */
  base: string | null;
  theirs: string;
  oursLabel: string;
  theirsLabel: string;
}

/** 冲突块起始标记。 */
const START = "<<<<<<<";
/** diff3 基线段标记。 */
const BASE = "|||||||";
/** ours 与 theirs 的分隔标记。 */
const SEP = "=======";
/** 冲突块结束标记。 */
const END = ">>>>>>>";

/** 这行是不是指定的冲突标记（标记后可跟 ` 标签` 或行尾符）。 */
const isMarker = (line: string, marker: string) =>
  line.startsWith(marker) && (line.length === 7 || line[7] === " " || line[7] === "\r" || line[7] === "\n");

/** 找出文本里所有良构的冲突块。 */
export function parseConflicts(text: string): ConflictBlock[] {
  const out: ConflictBlock[] = [];
  const lines: Array<{ from: number; text: string; end: number }> = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl < 0 ? text.length : nl + 1;
    lines.push({ from: pos, text: text.slice(pos, end), end });
    pos = end;
  }
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i]!;
    if (!isMarker(start.text, START)) continue;
    let baseAt = -1;
    let sepAt = -1;
    let endAt = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.text;
      if (isMarker(t, START)) break;
      if (sepAt < 0 && baseAt < 0 && isMarker(t, BASE)) baseAt = j;
      else if (sepAt < 0 && isMarker(t, SEP)) sepAt = j;
      else if (sepAt >= 0 && isMarker(t, END)) {
        endAt = j;
        break;
      }
    }
    if (sepAt < 0 || endAt < 0) continue;
    const slice = (a: number, b: number) => (a >= b ? "" : text.slice(lines[a]!.from, lines[b - 1]!.end));
    const oursEnd = baseAt >= 0 ? baseAt : sepAt;
    const label = (l: string, m: string) => l.slice(m.length).trim();
    out.push({
      from: start.from,
      to: lines[endAt]!.end,
      ours: slice(i + 1, oursEnd),
      base: baseAt >= 0 ? slice(baseAt + 1, sepAt) : null,
      theirs: slice(sepAt + 1, endAt),
      oursLabel: label(start.text, START),
      theirsLabel: label(lines[endAt]!.text, END),
    });
    i = endAt;
  }
  return out;
}

/** 用户口中的取舍：ours 是用户自己的活（Accept Yours）。 */
export type Resolution = "ours" | "theirs" | "both" | "base";

/** 替换某个冲突块的文本。 */
export function resolutionText(
  block: Pick<ConflictBlock, "ours" | "base" | "theirs">,
  how: Resolution,
): string {
  switch (how) {
    case "ours":
      return block.ours;
    case "theirs":
      return block.theirs;
    case "base":
      return block.base ?? "";
    case "both":
      return block.ours && !block.ours.endsWith("\n")
        ? `${block.ours}\n${block.theirs}`
        : block.ours + block.theirs;
  }
}

/** 按每块的取舍拼出解决后的全文；`choices` 缺块的条目原样保留标记。 */
/** 三栏合并编辑器结果栏里的一个未解决冲突（范围存的是 base 段的偏移）。 */
export interface ResultConflict {
  from: number;
  to: number;
  ours: string;
  base: string | null;
  theirs: string;
}

/**
 * 三栏合并编辑器的起始结果：合并文本里每个冲突块先填 base 段——
 * 界面上不出现标记，块的位置由 ResultConflict 记着，编辑过程中随文档改动平移。
 * `reversed`：变基/恢复 stash 撞出的冲突 git 把上游写进 stage 2，两侧对调
 * ours/theirs 存的是对调后的「你的/对方的」正文。
 */
export function initialResult(
  merged: string,
  reversed = false,
): { text: string; conflicts: ResultConflict[] } {
  const conflicts: ResultConflict[] = [];
  let text = "";
  let pos = 0;
  for (const b of parseConflicts(merged)) {
    text += merged.slice(pos, b.from);
    const from = text.length;
    text += b.base ?? "";
    conflicts.push({
      from,
      to: text.length,
      ours: reversed ? b.theirs : b.ours,
      base: b.base,
      theirs: reversed ? b.ours : b.theirs,
    });
    pos = b.to;
  }
  return { text: text + merged.slice(pos), conflicts };
}
