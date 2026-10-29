/**
 * 比对视图的差异口径：先按行比。
 *
 * `@codemirror/merge` 默认逐字符比（Myers），并带一条 500 的扫描预算：文件一大、改动一多，
 * 它就在预算处放弃，把后面整段认成「一处改动」——比对视图于是变成满屏同色，
 * 上下箭头也只有一步可走。这里把每行折成一个字符再交给同一个算法：行下标就是字符下标，
 * 规模从「几万个字」降到「几千行」，预算够得着，块也正好落在行上。
 * 词级高亮仍由库自己算——它拿到的是真实字符区间，不是折出来的行。
 */
import { Change, diff } from "@codemirror/merge";

/** 超过这个行数就不按行比了：折行本身是 O(行) 的内存与时间，再叠上 Myers 不划算。 */
const MAX_DIFF_LINES = 20_000;
/** 退回库的粗比时给的预算，与它自己的默认值一致。 */
const CRUDE_SCAN_LIMIT = 500;
/** 行级比对的预算：与行号槽那批 VCS 标记同一个口径，两处不该一个卡一个不卡。 */
const DIFF_TIMEOUT = 1000;

/** 与编辑器同一套拆行：末尾换行会多出一行空行。 */
export function textLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/** 每行的起始偏移，末尾那条是「最后一行的下一行」的位置——正好当区间的右开边界用。 */
function lineStarts(text: string): number[] {
  const starts = [0];
  const breakAt = /\r\n|\n|\r/g;
  let hit: RegExpExecArray | null;
  while ((hit = breakAt.exec(text))) starts.push(hit.index + hit[0].length);
  return starts;
}

/**
 * 行的字母表。
 *
 * 每行折成一个字符，内容相同的行两边拿同一个号，字符偏移因此正好是行下标。
 * 从 0x20 往后发号，跳过代理对区：那里是「半个字符」，落在里面会被当成能部分匹配的单元。
 * 两边各 2 万行是上限，可用位有 6.3 万个，够用。
 */
function lineCoder(): (line: string) => number {
  const ids = new Map<string, number>();
  let next = 0x20;
  return (line) => {
    let id = ids.get(line);
    if (id === undefined) {
      if (next >= 0xd800 && next <= 0xdfff) next = 0xe000;
      id = next++;
      ids.set(line, id);
    }
    return id;
  };
}

function encodeLines(lines: readonly string[], code: (line: string) => number): string {
  let out = "";
  for (const line of lines) out += String.fromCharCode(code(line));
  return out;
}

/**
 * 两边按行比出来的区间，行下标、左闭右开。
 *
 * 返回 null 表示这份太大、不该按行比，交回调用方另想办法。
 */
export function lineDiff(original: string, modified: string): readonly Change[] | null {
  const a = textLines(original);
  const b = textLines(modified);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;
  const code = lineCoder();
  try {
    return diff(encodeLines(a, code), encodeLines(b, code), { timeout: DIFF_TIMEOUT });
  } catch {
    return null;
  }
}

/** 行下标 → 字符偏移；越过最后一行就是文末。 */
function offsetOf(starts: readonly number[], line: number, length: number): number {
  return starts[line] ?? length;
}

/**
 * 交给比对视图的差异配置：把行级区间换算成库要的字符区间。
 *
 * 右开边界取「下一行的起点」，所以改动含自己那行的换行——与库逐字符比出来的形状一致，
 * 后面的词级对齐与相邻并块都按这个前提走。
 */
export const lineDiffConfig = {
  override: (original: string, modified: string): readonly Change[] => {
    const ranges = lineDiff(original, modified);
    if (!ranges) return diff(original, modified, { scanLimit: CRUDE_SCAN_LIMIT });
    const startsA = lineStarts(original);
    const startsB = lineStarts(modified);
    return ranges.map(
      (range) =>
        new Change(
          offsetOf(startsA, range.fromA, original.length),
          offsetOf(startsA, range.toA, original.length),
          offsetOf(startsB, range.fromB, modified.length),
          offsetOf(startsB, range.toB, modified.length)
        )
    );
  }
};
