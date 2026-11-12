/**
 * VCS 提交工具窗口核心模型：变更分组、目录树构建、纳入复选框聚合与提交计划。
 * 变更树保留目录聚合圆点与行尾状态字母。
 */
import type { GitChange, GitCommitSelection } from "../../lib/git";
import { changeMark, folderMarks, isDeletedMark } from "../../lib/git";
import { basenameOf } from "../../lib/format";

/** 变更树四个分组（冲突/已暂存/未暂存/未版本控制）。 */
export type GroupId = "conflicts" | "staged" | "unstaged" | "unversioned";

/** 各分组在树里的英文标题。 */
export const GROUP_LABEL: Record<GroupId, string> = {
  conflicts: "Merge Conflicts",
  staged: "Staged Changes",
  unstaged: "Changes",
  unversioned: "Unversioned Files",
};

/** 变更树的一个节点（分组头、目录聚合或单文件）。 */
export interface ChangeNode {
  key: string;
  type: "repository" | "group" | "dir" | "file";
  /** 多仓库树节点的来源根；单仓库旧调用可以不提供。 */
  repoRoot?: string;
  label: string;
  group: GroupId;
  children?: ChangeNode[];
  /** 该节点下涵盖的所有文件 */
  files: GitChange[];
  /** 节点对应路径（文件绝对/相对路径，或目录路径） */
  path?: string;
  /** 节点附加描述（如平铺模式下的父目录，或旧文件名） */
  detail?: string;
  /** 文件行尾状态字母（如 M, U, A, D, R, C） */
  mark?: string;
  /** 目录聚合变更状态（用于目录行尾圆点染色） */
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

/** 复选框状态表（键见 {@link checkKey}，值 true 为勾）。 */
export type Checks = ReadonlyMap<string, boolean>;

/**
 * 某一侧复选框的存储键，仓库与路径共同确定身份。
 * @param side - 索引或工作区侧
 * @param path - 仓库相对路径
 * @param repoRoot - 汇总变更的来源根；省略时保持单仓库键
 * @returns 不同仓库同名文件互不碰撞的键
 */
export function checkKey(side: ChangeSide, path: string, repoRoot?: string): string {
  return `${side === "staged" ? "s" : "w"}:${repoRoot ? JSON.stringify([repoRoot, path]) : path}`;
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
  return checks.get(checkKey(side, change.path, change.repoRoot)) ?? defaultChecked(change, side);
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
 * 汇总仓库各文件实际存在的索引和工作区两侧，不把部分暂存误判为全选。
 * @param files - 同一仓库内的变更
 * @param checks - 按仓库、路径和侧隔离的勾选
 * @returns 仓库复选框的选中、混合状态及选中侧数；无可提交项时均为空
 */
export function aggregateRepositoryCheck(files: readonly GitChange[], checks: Checks) {
  /** 只统计真实可提交侧，冲突不能纳入提交。 */
  const sides = files.filter((file) => !file.conflicted).flatMap((file) => [
    ...(isStaged(file) ? [isChecked(file, "staged", checks)] : []),
    ...(file.untracked || file.workStatus.trim() ? [isChecked(file, "worktree", checks)] : []),
  ]);
  /** 已选中的侧数。 */
  const on = sides.filter(Boolean).length;
  return { checked: sides.length > 0 && on === sides.length, indeterminate: on > 0 && on < sides.length, on };
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

/** 路径前缀树节点：目录段 → 子节点，叶子挂文件。 */
interface TrieNode {
  dirs: Map<string, TrieNode>;
  files: GitChange[];
}

/** 深度优先收齐前缀树里的全部文件。 */
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
          if (!seen.has(checkKey("worktree", f.path, f.repoRoot))) {
            seen.add(checkKey("worktree", f.path, f.repoRoot));
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

/**
 * 构造按仓库分组的变更树，节点与文件均保留来源根。
 * @param repositories - 每个仓库的根、显示名称和变更
 * @param groupByDir - 是否在各仓库内按目录组织文件
 * @returns 仓库节点，包含各自的索引与工作区子树；干净仓库保留空节点
 */
export function buildRepositoryChangeTree(
  repositories: readonly { root: string; label: string; changes: GitChange[] }[],
  groupByDir: boolean,
): ChangeNode[] {
  return repositories.map(({ root, label, changes }) => {
    /** 标签来源必须和快照根一致，不能从文件路径猜测嵌套仓库归属。 */
    const files = changes.map((change) => ({ ...change, repoRoot: root }));
    /**
     * 为子树节点绑定来源并隔离键。
     * @param node - 单仓库构造器返回的节点
     * @returns 绑定仓库的节点及后代
     */
    const scope = (node: ChangeNode): ChangeNode => ({
      ...node, key: JSON.stringify([root, node.key]), repoRoot: root, children: node.children?.map(scope),
    });
    return { key: JSON.stringify([root]), type: "repository", label, repoRoot: root, group: "unstaged",
      files, children: buildChangeTree(files, groupByDir).map(scope) };
  });
}

/** 一次提交的计划：纳入的文件与每文件的操作选择。 */
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
