/**
 * 比对视图的差异口径：先按行比。
 *
 * `@codemirror/merge` 默认逐字符比（Myers），并带一条 500 的扫描预算：文件一大、改动一多，
 * 它就在预算处放弃，把后面整段认成「一处改动」——比对视图于是变成满屏同色，
 * 上下箭头也只有一步可走。这里把每行折成一个字符再交给同一个算法：行下标就是字符下标，
 * 规模从「几万个字」降到「几千行」，预算够得着，块也正好落在行上。
 * 词级高亮仍由库自己算——它拿到的是真实字符区间，不是折出来的行。
 *
 * 「忽略空白」也在这层做：比较前把行归一化（去首尾空白 / 去所有空白 / 连空行一起扔），
 * 只差空白的行两边拿到同一个号，自然不再成块——展示的仍是真实文本，动的只是比较口径。
 */
import { Change, diff } from "@codemirror/merge";

/** 空白口径：比对窗口「Ignore whitespace」那四档。 */
export type DiffWhitespace = "default" | "trim" | "ignore" | "ignoreEmptyLines";

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

/** 按口径归一化一行；返回 null 表示这一行（归一化后为空）整个不参与比较。 */
function normalizeLine(line: string, whitespace: DiffWhitespace): string | null {
  switch (whitespace) {
    case "trim":
      return line.trim();
    case "ignore":
      return line.replace(/\s+/g, "");
    case "ignoreEmptyLines": {
      const stripped = line.replace(/\s+/g, "");
      return stripped === "" ? null : stripped;
    }
    default:
      return line;
  }
}

/**
 * 两边按行比出来的区间，行下标、左闭右开。
 *
 * 返回 null 表示这份太大、不该按行比，交回调用方另想办法。
 * 「忽略空白与空行」那一档会把归一化后为空的行整行扔掉，所以内部多一层
 * 「保留行号」的映射：diff 在保留序上比，结果再折回真实行号。
 */
export function lineDiff(
  original: string,
  modified: string,
  whitespace: DiffWhitespace = "default"
): readonly Change[] | null {
  const a = textLines(original);
  const b = textLines(modified);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;
  const code = lineCoder();
  const dropping = whitespace === "ignoreEmptyLines";
  /** 保留行的真实行号（0 起）；不扔行时就是一一对应。 */
  const keptA: number[] = [];
  const keptB: number[] = [];
  const charsA: string[] = [];
  const charsB: string[] = [];
  for (let i = 0; i < a.length; i += 1) {
    const norm = normalizeLine(a[i], whitespace);
    if (norm === null) continue;
    keptA.push(i);
    charsA.push(String.fromCharCode(code(norm)));
  }
  for (let i = 0; i < b.length; i += 1) {
    const norm = normalizeLine(b[i], whitespace);
    if (norm === null) continue;
    keptB.push(i);
    charsB.push(String.fromCharCode(code(norm)));
  }
  let ranges: readonly Change[];
  try {
    ranges = diff(encodeLines(charsA, (c) => c.charCodeAt(0)), encodeLines(charsB, (c) => c.charCodeAt(0)), { timeout: DIFF_TIMEOUT });
  } catch {
    return null;
  }
  if (!dropping) {
    // 不扔行时保留序就是真实行序，区间原样返回。
    return ranges;
  }
  // 保留序 → 真实行序；右开边界落在保留序的 to 上：to == len 表示到文末。
  const lineA = (at: number) => (at >= keptA.length ? a.length : keptA[at]);
  const lineB = (at: number) => (at >= keptB.length ? b.length : keptB[at]);
  return ranges.map(
    (range) => new Change(lineA(range.fromA), lineA(range.toA), lineB(range.fromB), lineB(range.toB))
  );
}

/** 行下标 → 字符偏移；越过最后一行就是文末。 */
function offsetOf(starts: readonly number[], line: number, length: number): number {
  return starts[line] ?? length;
}

/**
 * 交给比对视图的差异配置：把行级区间换算成库要的字符区间。
 *
 * 右开边界取「下一行的起点」，所以改动含自己那行的换行——与库逐字符比出来的形状一致，
 * 后面的词级对齐与相邻并块都按这个前提走。空白口径换档要重建视图，所以是工厂不是单例。
 */
export function diffConfigFor(whitespace: DiffWhitespace = "default") {
  return {
    override: (original: string, modified: string): readonly Change[] => {
      const ranges = lineDiff(original, modified, whitespace);
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
    },
  };
}

/** 缺省口径的单例：不关心空白的调用方（补丁预览等）共用一份。 */
export const lineDiffConfig = diffConfigFor("default");
