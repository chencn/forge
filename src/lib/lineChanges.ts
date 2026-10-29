import { canonicalPath, isWindowsPath, pathWithin } from "./format";
import { gitShow } from "./git";
import type { GitChange } from "./git";
import { lineDiff, textLines } from "./cm/lineDiff";

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

/**
 * 当前正文相对 HEAD 原文，哪些行要画。
 *
 * 差异引擎与比对视图同一份（`cm/lineDiff` 的行级比对），但这里只看行：
 * 一行折成一个字符，改一个词与改一整行在行号槽上本来就是同一档标记。比对视图那一头
 * 还多做了一步——把改动扩到词边界、好把变了哪几个字画出来，两条路不该混在一起。
 */
export function gutterChanges(original: string, modified: string): GutterChange[] {
  const modifiedLines = textLines(modified);
  // 空原文换成有内容时整篇算新增：diff 会把那一行空行看成「被改掉」，画成蓝色，
  // 和「这个文件是新写出来的」对不上。
  if (original === "" && modified !== "") {
    return [{ kind: "added", startLine: 1, endLine: modifiedLines.length, edge: "line" }];
  }

  const changes = lineDiff(original, modified);
  if (!changes) return [];

  const marks: GutterChange[] = [];
  for (const change of changes) {
    // 偏移即行下标，+1 换成编辑器那一套 1 起的行号；end 是「最后一行的下一行」。
    const startLine = change.fromB + 1;
    const endLine = change.toB;
    if (startLine > endLine) {
      // 删除没有留下行，三角挂在缺口旁边那一行上：文件开头被删只能挂第 1 行的上沿。
      const anchor = startLine - 1;
      marks.push(
        anchor < 1
          ? { kind: "deleted", startLine: 1, endLine: 1, edge: "before" }
          : { kind: "deleted", startLine: anchor, endLine: anchor, edge: "after" }
      );
      continue;
    }
    marks.push({
      kind: change.fromA === change.toA ? "added" : "modified",
      startLine,
      endLine,
      edge: "line",
    });
  }
  return marks;
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
