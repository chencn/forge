/**
 * VCS 提交工具窗口核心模型：变更分组、目录树构建、纳入复选框聚合与提交计划。
 * 1:1 对标 IntelliJ IDEA / IDEA 的变更树模型，同时保留目录聚合圆点与行尾状态字母。
 */
import type { GitChange, GitCommitSelection } from "../../lib/git";
import { changeMark, folderMarks, isDeletedMark } from "../../lib/git";
import { basenameOf } from "../../lib/format";

export type GroupId = "conflicts" | "staged" | "unstaged" | "unversioned";

export const GROUP_LABEL: Record<GroupId, string> = {
  conflicts: "Merge Conflicts",
  staged: "Staged Changes",
  unstaged: "Changes",
  unversioned: "Unversioned Files",
};

export interface ChangeNode {
  key: string;
  type: "group" | "dir" | "file";
  label: string;
  group: GroupId;
  children?: ChangeNode[];
  /** 该节点下涵盖的所有文件 */
  files: GitChange[];
  /** 节点对应路径（文件绝对/相对路径，或目录路径） */
  path?: string;
  /** 节点附加描述（如平铺模式下的父目录，或旧文件名） */
  detail?: string;
  /** 【保留项】文件行尾状态字母（如 M, U, A, D, R, C） */
  mark?: string;
  /** 【保留项】目录聚合变更状态（用于目录行尾圆点染色） */
  dirMark?: string;
  /** 是否为删除态 */
  isDeleted?: boolean;
}

/**
 * 判断变更属于哪一组（git 暂存区那套口径）：
 * 冲突 -> conflicts, 未跟踪 -> unversioned,
 * 索引位有内容 -> staged, 其余（只有工作区改动）-> unstaged。
 * 部分暂存的文件在 staged 与 unstaged 两组各占一条，见 buildChangeTree。
 */
export function groupOf(change: GitChange): GroupId {
  if (change.conflicted) return "conflicts";
  if (change.untracked) return "unversioned";
  return isStaged(change) ? "staged" : "unstaged";
}

/**
 * 按组取行尾状态字母：已暂存组读索引位，未暂存组读工作区位。
 * 部分暂存文件两边各显示自己那一侧的字母，而不是混用一个。
 * 组没覆盖到的那一侧（正常不存在）退回原 changeMark。
 */
export function groupMark(change: GitChange, group: GroupId): string {
  if (group === "staged") return change.indexStatus.trim() || changeMark(change);
  if (group === "unstaged") return change.workStatus.trim() || changeMark(change);
  return changeMark(change);
}

/**
 * 是否已暂存（索引区有有效变更状态）
 */
export function isStaged(change: GitChange): boolean {
  if (change.untracked || change.conflicted) return false;
  const index = change.indexStatus.trim();
  return index !== "" && index !== "?";
}

/**
 * 是否属于部分暂存（既有暂存内容，又有未暂存修改）
 */
export function isPartiallyStaged(change: GitChange): boolean {
  if (change.untracked || change.conflicted) return false;
  return change.indexStatus.trim() !== "" && change.workStatus.trim() !== "";
}

/**
 * 勾选按「侧」独立存储：同一文件（部分暂存的）在已暂存与未暂存两组各有一条，
 * 各有自己的复选框，互不联动。
 * - `staged` 侧那条：勾 = 提交索引里的内容；不勾 = 保留它供以后提交
 * - `worktree` 侧那条：勾 = 提交工作区这部分修改；不勾 = 保留工作区这部分修改
 * 未跟踪文件与冲突文件只出现在各自组里，复用 `worktree` 侧的键。
 * 值就是布尔：勾或空。旧的 all/none/staged/hunks 四态模型按文件存一份，
 * 在两侧两条的显示下必然联动，连「这条勾选管哪一半」都说不清，已整个废掉。
 */
export type ChangeSide = "staged" | "worktree";

export type Checks = ReadonlyMap<string, boolean>;

/** 某一侧复选框的存储键。 */
export function checkKey(side: ChangeSide, path: string): string {
  return `${side === "staged" ? "s" : "w"}:${path}`;
}

/**
 * 某一侧的默认勾选：
 * - 已暂存侧默认勾（有暂存内容通常就是要提交的）
 * - 工作区侧默认跟随原语义：纯工作区变更默认带上（原 all），
 *   部分暂存文件默认只提交暂存块（原 staged），不带工作区
 * - 未跟踪与冲突文件默认不勾
 */
export function defaultChecked(change: GitChange, side: ChangeSide): boolean {
  if (change.untracked || change.conflicted) return false;
  if (side === "staged") return true;
  return !isPartiallyStaged(change);
}

/** 读取某一条的勾选状态；没动过就用默认值。 */
export function isChecked(change: GitChange, side: ChangeSide, checks: Checks): boolean {
  return checks.get(checkKey(side, change.path)) ?? defaultChecked(change, side);
}

/**
 * 聚合一组文件某一侧的勾选状态（用于组行和目录行的三态复选框）。
 * 勾 = 全部纳入，空 = 全部不纳入，横线 = 一部分纳入一部分不纳入。
 */
export function aggregateCheck(
  files: readonly GitChange[],
  side: ChangeSide,
  checks: Checks
) {
  if (files.length === 0) {
    return { checked: false, indeterminate: false, on: 0 };
  }
  let on = 0;
  for (const f of files) {
    if (isChecked(f, side, checks)) on++;
  }
  return {
    checked: on === files.length,
    indeterminate: on > 0 && on < files.length,
    on,
  };
}

/**
 * 构建平铺模式下的单个文件节点
 */
function createFileNode(change: GitChange, group: GroupId, scope: string, flat: boolean): ChangeNode {
  const mark = groupMark(change, group);
  const isDeleted = isDeletedMark(mark);
  const name = basenameOf(change.path);
  const dir = change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "";

  return {
    key: `${scope}:file:${change.path}`,
    type: "file",
    label: flat ? change.path : name,
    group,
    files: [change],
    path: change.path,
    detail: flat && dir ? undefined : undefined,
    mark,
    isDeleted,
  };
}

interface TrieNode {
  dirs: Map<string, TrieNode>;
  files: GitChange[];
}

function collectTrieFiles(trie: TrieNode): GitChange[] {
  const result = [...trie.files];
  for (const sub of trie.dirs.values()) {
    result.push(...collectTrieFiles(sub));
  }
  return result;
}

/**
 * 递归构建目录树，并自动压缩单路径目录（如 src/main/java）
 */
function createDirNodes(
  trie: TrieNode,
  currentPath: string,
  group: GroupId,
  scope: string,
  dirMarks: Map<string, string>
): ChangeNode[] {
  const nodes: ChangeNode[] = [];
  const entries = [...trie.dirs.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [name, sub] of entries) {
    let label = name;
    let node = sub;
    let rel = currentPath ? `${currentPath}/${name}` : name;

    // 压缩单层目录
    while (node.files.length === 0 && node.dirs.size === 1) {
      const [nextName, nextSub] = [...node.dirs.entries()][0]!;
      label += `/${nextName}`;
      rel += `/${nextName}`;
      node = nextSub;
    }

    const children = createDirNodes(node, rel, group, scope, dirMarks);
    const files = collectTrieFiles(node);
    const dirMark = dirMarks.get(rel);

    nodes.push({
      key: `${scope}:dir:${rel}`,
      type: "dir",
      label,
      group,
      children,
      files,
      path: rel,
      dirMark,
    });
  }

  // 排序文件并生成文件节点
  const sortedFiles = [...trie.files].sort((a, b) =>
    basenameOf(a.path).localeCompare(basenameOf(b.path))
  );
  for (const file of sortedFiles) {
    nodes.push(createFileNode(file, group, scope, false));
  }

  return nodes;
}

/**
 * 构建一组变更的子树（平铺模式或目录树模式）
 */
function buildSubTree(
  files: GitChange[],
  group: GroupId,
  groupByDir: boolean,
  scope: string
): ChangeNode[] {
  if (!groupByDir) {
    return [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => createFileNode(f, group, scope, true));
  }

  const rootTrie: TrieNode = { dirs: new Map(), files: [] };
  for (const change of files) {
    const parts = change.path.split("/");
    let cur = rootTrie;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      let next = cur.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        cur.dirs.set(part, next);
      }
      cur = next;
    }
    cur.files.push(change);
  }

  const dirMarks = folderMarks(files, (c) => groupMark(c, group));
  return createDirNodes(rootTrie, "", group, scope, dirMarks);
}

/**
 * 构建完整的变更树（git 暂存区那套分组：Merge Conflicts、已暂存、未暂存、Unversioned Files）。
 * 部分暂存的文件（porcelain 的 `AM`/`MM`/`AD`）在已暂存与未暂存两组各出现一条，
 * 点开时各看各的那一半差异；空组不画。
 */
export function buildChangeTree(changes: GitChange[], groupByDir: boolean): ChangeNode[] {
  const conflicts: GitChange[] = [];
  const staged: GitChange[] = [];
  const unstaged: GitChange[] = [];
  const unversioned: GitChange[] = [];

  for (const c of changes) {
    if (c.conflicted) conflicts.push(c);
    else if (c.untracked) unversioned.push(c);
    else {
      if (c.indexStatus.trim() !== "") staged.push(c);
      if (c.workStatus.trim() !== "") unstaged.push(c);
    }
  }

  const roots: ChangeNode[] = [];

  // 1. Merge Conflicts 组
  if (conflicts.length > 0) {
    roots.push({
      key: "group:conflicts",
      type: "group",
      label: GROUP_LABEL.conflicts,
      group: "conflicts",
      children: buildSubTree(conflicts, "conflicts", groupByDir, "conflicts"),
      files: conflicts,
    });
  }

  // 2. 已暂存组：索引里有内容的就是已暂存（含部分暂存的暂存侧）
  if (staged.length > 0) {
    roots.push({
      key: "group:staged",
      type: "group",
      label: GROUP_LABEL.staged,
      group: "staged",
      children: buildSubTree(staged, "staged", groupByDir, "staged"),
      files: staged,
    });
  }

  // 3. 未暂存组：工作区有改动且索引侧已经算过账的（含部分暂存的工作区侧）
  if (unstaged.length > 0) {
    roots.push({
      key: "group:unstaged",
      type: "group",
      label: GROUP_LABEL.unstaged,
      group: "unstaged",
      children: buildSubTree(unstaged, "unstaged", groupByDir, "unstaged"),
      files: unstaged,
    });
  }

  // 4. Unversioned Files 组
  if (unversioned.length > 0) {
    roots.push({
      key: "group:unversioned",
      type: "group",
      label: GROUP_LABEL.unversioned,
      group: "unversioned",
      children: buildSubTree(unversioned, "unversioned", groupByDir, "unversioned"),
      files: unversioned,
    });
  }

  return roots;
}

/**
 * 遍历提取节点及其后代涵盖的所有文件
 */
export function filesOf(nodes: readonly ChangeNode[]): GitChange[] {
  const seen = new Set<string>();
  const out: GitChange[] = [];
  const walk = (ns: readonly ChangeNode[]) => {
    for (const n of ns) {
      if (n.type === "file") {
        for (const f of n.files) {
          if (!seen.has(f.path)) {
            seen.add(f.path);
            out.push(f);
          }
        }
      } else if (n.children) {
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return out;
}

export interface CommitPlan {
  /** 纳入本次提交的文件 */
  included: GitChange[];
  /** 每个文件只有一个明确来源，不再拼接互相冲突的暂存／取消暂存操作。 */
  selections: GitCommitSelection[];
}

/**
 * 按两侧勾选选择索引、完整工作区或仅未暂存修改；未选内容保留原样。
 */
export function planCommit(changes: readonly GitChange[], checks: Checks): CommitPlan {
  const plan: CommitPlan = { included: [], selections: [] };
  for (const c of changes) {
    // 冲突文件由提交门控拦截，不把未合并状态当成可提交来源。
    if (c.conflicted) continue;
    const hasStaged = !c.untracked && c.indexStatus.trim() !== "";
    const stageSide = hasStaged && isChecked(c, "staged", checks);
    const workSide = (c.untracked || c.workStatus.trim() !== "") && isChecked(c, "worktree", checks);
    if (!stageSide && !workSide) continue;
    plan.included.push(c);
    plan.selections.push({
      path: c.path,
      oldPath: c.oldPath,
      source: workSide ? hasStaged && !stageSide ? "worktreeOnly" : "worktree" : "index",
    });
  }
  return plan;
}
