/**
 * Git 冲突标记解析与块级解决（纯函数）。
 * 移植自 openidea `features/vcs/conflicts.ts` 的标记解析与逐块取舍核心。
 */

export interface ConflictBlock {
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

const START = "<<<<<<<";
const BASE = "|||||||";
const SEP = "=======";
const END = ">>>>>>>";

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
export function resolveWithChoices(
  text: string,
  choices: ReadonlyArray<Resolution | undefined>,
): string {
  const blocks = parseConflicts(text);
  let out = "";
  let pos = 0;
  blocks.forEach((b, i) => {
    const how = choices[i];
    if (how) out += text.slice(pos, b.from) + resolutionText(b, how);
    else out += text.slice(pos, b.to);
    pos = b.to;
  });
  return out + text.slice(pos);
}
