/**
 * VCS 提交工具窗口核心模型：变更分组、目录树构建、纳入复选框聚合与提交计划。
 * 1:1 对标 IntelliJ IDEA / OpenIdea 的变更树模型，同时保留目录聚合圆点与行尾状态字母。
 */
import type { GitChange } from "../../lib/git";
import { changeMark, folderMarks, isDeletedMark } from "../../lib/git";
import type { ChangelistsState } from "../../lib/changelists";
import { DEFAULT_LIST_ID, listIdOf } from "../../lib/changelists";
import { basenameOf } from "../../lib/format";

export type GroupId = "conflicts" | "changes" | "unversioned";

export const GROUP_LABEL: Record<GroupId, string> = {
  conflicts: "Merge Conflicts",
  changes: "Changes",
  unversioned: "Unversioned Files",
};

/**
 * 单个文件纳入提交的勾选状态：
 * - all: 提交前全部暂存并纳入
 * - none: 不纳入本次提交
 * - staged: 仅提交已暂存的块（部分暂存）
 * - hunks: 按块选择性提交
 */
export type CheckState = "all" | "none" | "staged" | "hunks";

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
  /** 所属变更列表 id */
  changelist?: string;
  /** 是否为活动变更列表 */
  active?: boolean;
  /** 【保留项】文件行尾状态字母（如 M, U, A, D, R, C） */
  mark?: string;
  /** 【保留项】目录聚合变更状态（用于目录行尾圆点染色） */
  dirMark?: string;
  /** 是否为删除态 */
  isDeleted?: boolean;
}

/**
 * 判断变更属于哪一组：
 * 冲突 -> conflicts, 未跟踪 -> unversioned, 其余 -> changes
 */
export function groupOf(change: GitChange): GroupId {
  if (change.conflicted) return "conflicts";
  if (change.untracked) return "unversioned";
  return "changes";
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
 * 单个文件的初始勾选状态：
 * IDEA 规范：Unversioned Files 与冲突文件默认不勾选，普通变更默认勾选（部分暂存默认 staged）
 */
export function initialCheck(change: GitChange): CheckState {
  const g = groupOf(change);
  if (g !== "changes") return "none";
  return isPartiallyStaged(change) ? "staged" : "all";
}

export function checkOf(change: GitChange, checks: ReadonlyMap<string, CheckState>): CheckState {
  return checks.get(change.path) ?? initialCheck(change);
}

/**
 * 聚合一组文件的勾选状态（用于分组行和目录行的三态复选框）
 */
export function aggregateCheck(files: readonly GitChange[], checks: ReadonlyMap<string, CheckState>) {
  if (files.length === 0) {
    return { checked: false, indeterminate: false, on: 0 };
  }
  let on = 0;
  let partial = false;
  for (const f of files) {
    const c = checkOf(f, checks);
    if (c !== "none") on++;
    if (c === "staged" || c === "hunks") partial = true;
  }
  return {
    checked: on > 0 && on === files.length && !partial,
    indeterminate: (on > 0 && on < files.length) || partial,
    on,
  };
}

/**
 * 单个勾选框切换后的下一个状态
 */
export function toggledCheck(current: CheckState): CheckState {
  return current === "none" ? "all" : "none";
}

/**
 * 构建平铺模式下的单个文件节点
 */
function createFileNode(change: GitChange, group: GroupId, scope: string, flat: boolean): ChangeNode {
  const mark = changeMark(change);
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

  const dirMarks = folderMarks(files);
  return createDirNodes(rootTrie, "", group, scope, dirMarks);
}

function tagChangelist(nodes: ChangeNode[], changelistId: string): ChangeNode[] {
  for (const n of nodes) {
    n.changelist = changelistId;
    if (n.children) tagChangelist(n.children, changelistId);
  }
  return nodes;
}

/**
 * 构建完整的变更树（1:1 对标 OpenIdea，支持 Merge Conflicts、多 Changelist 拆分及 Unversioned Files）
 */
export function buildChangeTree(
  changes: GitChange[],
  groupByDir: boolean,
  lists?: ChangelistsState
): ChangeNode[] {
  const conflicts: GitChange[] = [];
  const changesGroup: GitChange[] = [];
  const unversioned: GitChange[] = [];

  for (const c of changes) {
    const g = groupOf(c);
    if (g === "conflicts") conflicts.push(c);
    else if (g === "unversioned") unversioned.push(c);
    else changesGroup.push(c);
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

  // 2. Changes 组（如果有 Changelist，按 Changelist 分组展示）
  if (lists && lists.lists.length > 0) {
    const byList = new Map<string, GitChange[]>();
    byList.set(DEFAULT_LIST_ID, []);
    for (const l of lists.lists) {
      byList.set(l.id, []);
    }

    for (const c of changesGroup) {
      const listId = listIdOf(lists, c.path);
      const target = byList.get(listId) ?? byList.get(DEFAULT_LIST_ID)!;
      target.push(c);
    }

    // 默认列表
    const defaultChanges = byList.get(DEFAULT_LIST_ID) ?? [];
    if (defaultChanges.length > 0 || lists.lists.length > 0) {
      const defaultActive = lists.activeId === DEFAULT_LIST_ID;
      roots.push({
        key: `group:cl:${DEFAULT_LIST_ID}`,
        type: "group",
        label: GROUP_LABEL.changes,
        group: "changes",
        children: tagChangelist(
          buildSubTree(defaultChanges, "changes", groupByDir, `cl:${DEFAULT_LIST_ID}`),
          DEFAULT_LIST_ID
        ),
        files: defaultChanges,
        changelist: DEFAULT_LIST_ID,
        active: defaultActive,
      });
    }

    // 自定义列表
    for (const l of lists.lists) {
      const listChanges = byList.get(l.id) ?? [];
      const isActive = lists.activeId === l.id;
      roots.push({
        key: `group:cl:${l.id}`,
        type: "group",
        label: l.name,
        group: "changes",
        children: tagChangelist(
          buildSubTree(listChanges, "changes", groupByDir, `cl:${l.id}`),
          l.id
        ),
        files: listChanges,
        changelist: l.id,
        active: isActive,
        detail: l.comment ? l.comment.split("\n")[0] : undefined,
      });
    }
  } else {
    // 无自定义变更列表，普通单一 Changes 组
    if (changesGroup.length > 0) {
      roots.push({
        key: "group:changes",
        type: "group",
        label: GROUP_LABEL.changes,
        group: "changes",
        children: buildSubTree(changesGroup, "changes", groupByDir, "changes"),
        files: changesGroup,
        active: true,
      });
    }
  }

  // 3. Unversioned Files 组
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
  /** 需要暂存的路径 */
  stage: string[];
  /** 需要取消暂存的路径 */
  unstage: string[];
  /** 用于 git commit --only 的路径 */
  paths: string[];
}

/**
 * 计算提交计划：根据用户勾选状态，计算出纳入提交的文件和需操作的路径
 */
export function planCommit(
  changes: readonly GitChange[],
  checks: ReadonlyMap<string, CheckState>
): CommitPlan {
  const plan: CommitPlan = { included: [], stage: [], unstage: [], paths: [] };
  for (const c of changes) {
    const check = checkOf(c, checks);
    const staged = isStaged(c);
    if (check === "none") {
      if (staged) {
        plan.unstage.push(c.path);
      }
      continue;
    }
    plan.included.push(c);
    plan.paths.push(c.path);
    if (check === "all" && !staged) {
      plan.stage.push(c.path);
    }
  }
  return plan;
}
