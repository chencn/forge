import { canonicalPath, isWindowsPath, pathWithin } from "./format";
import { gitShow } from "./git";
import type { GitChange } from "./git";
import { DefaultLinesDiffComputer } from "monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js";

/**
 * 普通编辑器里相对上次提交的一块标记。
 *
 * 行号按当前正文计，从 1 起，含两端。删除没有留下行，标记挂在缺口旁边那一行上：
 * `after` 挂在上一行的下沿，`before` 是文件开头被删掉、只能挂在第 1 行的上沿。
 */
export interface GutterChange {
  kind: "added" | "modified" | "deleted";
  startLine: number;
  endLine: number;
  edge: "line" | "before" | "after";
}

/** 编辑器要去取的那份 HEAD 基线。`allowEmpty` 为假时，仓库里没有这份文件就不画。 */
export interface LineChangeBaseline {
  relativePath: string;
  allowEmpty: boolean;
}

/** 交给编辑器的基线：绝对路径，重命名时指向旧文件。 */
export interface ChangeBaseline {
  root: string;
  head: string;
  path: string;
  allowEmpty: boolean;
}

/** 超过这个行数就不同步算了：算法在主线程上，大文件会把输入卡住。 */
const MAX_LINES = 20_000;

const computer = new DefaultLinesDiffComputer();

/** 与 Monaco 模型同一套拆行：末尾换行会多出一行空行。 */
function textLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/**
 * 当前正文相对 HEAD 原文，哪些行要画。
 *
 * 空原文换成有内容时整段算新增：算法会把那一行空行看成「被改掉」，
 * 画成蓝色，和「这个文件是新写出来的」对不上。
 */
export function gutterChanges(original: string, modified: string): GutterChange[] {
  const originalLines = textLines(original);
  const modifiedLines = textLines(modified);
  if (originalLines.length > MAX_LINES || modifiedLines.length > MAX_LINES) return [];

  let mappings: ReturnType<DefaultLinesDiffComputer["computeDiff"]>["changes"];
  try {
    mappings = computer.computeDiff(originalLines, modifiedLines, {
      ignoreTrimWhitespace: false,
      maxComputationTimeMs: 1000,
      computeMoves: false,
    }).changes;
  } catch {
    return [];
  }

  const originalBlank = originalLines.length === 1 && originalLines[0] === "";
  const marks: GutterChange[] = [];
  for (const mapping of mappings) {
    if (mapping.original.isEmpty && mapping.modified.isEmpty) continue;
    if (mapping.modified.isEmpty) {
      const anchor = mapping.modified.startLineNumber - 1;
      if (anchor < 1) {
        marks.push({ kind: "deleted", startLine: 1, endLine: 1, edge: "before" });
      } else {
        marks.push({ kind: "deleted", startLine: anchor, endLine: anchor, edge: "after" });
      }
      continue;
    }
    const endLine = mapping.modified.endLineNumberExclusive - 1;
    if (endLine < mapping.modified.startLineNumber) continue;
    const added = mapping.original.isEmpty || (originalBlank && !mapping.modified.isEmpty);
    marks.push({
      kind: added ? "added" : "modified",
      startLine: mapping.modified.startLineNumber,
      endLine,
      edge: "line",
    });
  }
  return marks;
}

/**
 * 概览条把不够高的色块撑到这么高（和 Monaco 画的时候同一套），
 * 点击热区必须跟着撑开，否则一个一行的改动根本点不中。
 */
const MIN_RULER_MARK = 6;

/** 没开右侧小地图时，短标记向左仍可点的宽度。 */
const RULER_CLICK_SLACK = 48;

/**
 * 右侧短标记的横向点击范围。
 * 小地图开在右边时，整条小地图都能点，不用贴着最右几个像素。
 * 小地图在左边或关掉时，从滚动条向左再留一段。
 */
export function rulerClickBounds(
  rulerLeft: number,
  rulerWidth: number,
  minimapLeft: number,
  minimapWidth: number
): { left: number; right: number } {
  const right = rulerLeft + rulerWidth;
  const minimapOnRight =
    minimapWidth > 0 && minimapLeft < rulerLeft && minimapLeft + minimapWidth >= rulerLeft - 1;
  return { left: minimapOnRight ? minimapLeft : rulerLeft - RULER_CLICK_SLACK, right };
}

/**
 * 点在右侧概览条上时，该落到哪一行。
 *
 * 右侧只在改动的起始行画一个短标记，不按整段改动拉成一条。热区跟着这个短标记，
 * 点在空白处返回 null，滚动条还能拖。
 */
export function lineForRulerClick(
  y: number,
  rulerHeight: number,
  scrollHeight: number,
  lineHeight: number,
  marks: readonly { startLine: number; endLine: number }[],
  lineTop: (line: number) => number
): number | null {
  if (rulerHeight <= 0 || scrollHeight <= 0 || lineHeight <= 0 || marks.length === 0) return null;
  const ratio = rulerHeight / scrollHeight;
  let bestLine: number | null = null;
  let bestDist = Infinity;
  for (const mark of marks) {
    if (mark.endLine < mark.startLine) continue;
    const band = paintedBand(
      lineTop(mark.startLine) * ratio,
      (lineTop(mark.endLine) + lineHeight) * ratio,
      rulerHeight
    );
    if (y < band.top - 1 || y > band.bottom + 1) continue;
    const line = closestLine(y / ratio, mark.startLine, mark.endLine, lineTop, lineHeight);
    const dist = Math.abs(y - (band.top + band.bottom) / 2);
    if (dist < bestDist) {
      bestDist = dist;
      bestLine = line;
    }
  }
  return bestLine;
}

function paintedBand(y1: number, y2: number, rulerHeight: number): { top: number; bottom: number } {
  if (y2 - y1 >= MIN_RULER_MARK) return { top: y1, bottom: y2 };
  const half = MIN_RULER_MARK / 2;
  let center = (y1 + y2) / 2;
  if (center < half) center = half;
  else if (center + half > rulerHeight) center = rulerHeight - half;
  return { top: center - half, bottom: center + half };
}

function closestLine(
  offset: number,
  start: number,
  end: number,
  lineTop: (line: number) => number,
  lineHeight: number
): number {
  let best = start;
  let bestDist = Infinity;
  for (let line = start; line <= end; line++) {
    const dist = Math.abs(lineTop(line) + lineHeight / 2 - offset);
    if (dist < bestDist) {
      best = line;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * 这篇文档要不要画、基线用哪条路径。
 *
 * 未跟踪不把整篇涂绿，冲突有自己的标记，工作区或索引里已删除的文件也没有行可挂。
 * 不在变更清单里的跟踪文件仍要算：人正在打的字还没存盘，状态清单还不知道。
 * 重命名用旧路径当基线，否则新路径在 HEAD 里不存在，整篇会被看成新增。
 */
export function lineChangeBaseline(
  root: string,
  absolutePath: string,
  changes: readonly GitChange[]
): LineChangeBaseline | null {
  const relative = relativeToRepo(root, absolutePath);
  if (relative === null) return null;
  const change = changes.find((item) => sameRepoPath(root, item.path, relative));
  if (!change) return { relativePath: relative, allowEmpty: false };
  if (change.untracked || change.conflicted) return null;
  if (change.indexStatus === "D" || change.workStatus === "D") return null;
  return { relativePath: change.oldPath ?? change.path, allowEmpty: true };
}

/** 基线身份。编辑器用来认出「还是同一份 HEAD，不必再取」。 */
export function changeBaselineKey(spec: ChangeBaseline | null): string {
  if (!spec) return "";
  return `${spec.head}\0${spec.allowEmpty ? "1" : "0"}\0${canonicalPath(spec.root)}\0${canonicalPath(spec.path)}`;
}

const HEAD_CACHE_LIMIT = 32;
const headCache = new Map<string, Promise<string>>();

/**
 * HEAD 里这份文件的原文。按提交哈希缓存：打字只重算差异，不每次起 git。
 * 取失败不缓存，下一次还能再试。没有提交时退回 `HEAD`，仓库是空的就得到空串。
 */
export function headFile(root: string, head: string, absolute: string): Promise<string> {
  const revision = head === "" ? "HEAD" : head;
  const key = `${revision}\0${canonicalPath(root)}\0${canonicalPath(absolute)}`;
  const cached = headCache.get(key);
  if (cached) return cached;
  const pending = gitShow(root, revision, absolute).then(
    (text) => text,
    () => {
      headCache.delete(key);
      return "";
    }
  );
  headCache.set(key, pending);
  if (headCache.size > HEAD_CACHE_LIMIT) {
    const oldest = headCache.keys().next().value;
    if (oldest !== undefined && oldest !== key) headCache.delete(oldest);
  }
  return pending;
}

/** 仓库内的相对路径，保留原样大小写。不在这个根里返回 null。 */
function relativeToRepo(root: string, absolute: string): string | null {
  if (!pathWithin(root, absolute)) return null;
  const rootTrim = root.replace(/[\\/]+$/, "");
  if (absolute.length <= rootTrim.length) return null;
  const rest = absolute.slice(rootTrim.length).replace(/^[\\/]+/, "").replaceAll("\\", "/");
  return rest === "" ? null : rest;
}

function sameRepoPath(root: string, left: string, right: string): boolean {
  return isWindowsPath(root) ? left.toLowerCase() === right.toLowerCase() : left === right;
}
