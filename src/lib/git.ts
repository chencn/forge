import { invoke } from "@tauri-apps/api/core";

/** 空树哈希：根提交没有父提交时拿它当差异的左侧，整份文件就是新增。 */
export const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** git 可用性与仓库归属，来自 Rust `GitProbe`。 */
export interface GitProbe {
  /** 能不能执行 git 可执行文件。 */
  available: boolean;
  /** 仓库工作区根，git 自己给的写法；不在仓库内为 null。 */
  repoRoot: string | null;
  /** 停在合并冲突中（存在 .git/MERGE_HEAD）。 */
  midMerge: boolean;
  /** 停在变基冲突中（存在 .git/rebase-merge 或 rebase-apply）。 */
  midRebase: boolean;
  /** 停在优选冲突中（存在 .git/CHERRY_PICK_HEAD）。 */
  midCherryPick: boolean;
  /** 停在还原冲突中（存在 .git/REVERT_HEAD）。 */
  midRevert: boolean;
  /** 配了哪些远端；一个都没有时抓取那颗要置灰。 */
  remotes: string[];
}

/** 仓库停在哪个动作中间，决定「继续 / 中止」那两颗跑哪一对命令。 */
export type Recovery = "rebase" | "merge" | "cherryPick" | "revert";

/** 一次只可能停在一个动作上：真要嵌套，git 在起手时就会拦掉，所以挑出第一个即够。 */
export function recoveryOf(probe: GitProbe | null): Recovery | null {
  if (probe?.midRebase) return "rebase";
  if (probe?.midMerge) return "merge";
  if (probe?.midCherryPick) return "cherryPick";
  if (probe?.midRevert) return "revert";
  return null;
}

/** 一条变更，来自 Rust `GitChange`。 */
export interface GitChange {
  /** 相对仓库根的路径，正斜杠。 */
  path: string;
  /** 重命名/复制的来源路径；其余为 null。 */
  oldPath: string | null;
  /** 索引位（porcelain XY 的第一位）；未跟踪时为空串。 */
  indexStatus: string;
  /** 工作区位（porcelain XY 的第二位）；未跟踪时为空串。 */
  workStatus: string;
  /** 未跟踪文件。 */
  untracked: boolean;
  /** 未合并（冲突）。 */
  conflicted: boolean;
}

/** 分支与变更全貌，来自 Rust `GitStatus`。 */
export interface GitStatus {
  /** 当前分支名；游离 HEAD 时为 "(detached)"。 */
  branch: string;
  /** 是否游离在具名分支之外。 */
  detached: boolean;
  /** 上游分支名；没有上游为 null。 */
  upstream: string | null;
  /** 领先上游提交数；无上游为 0。 */
  ahead: number;
  /** 落后上游提交数；无上游为 0。 */
  behind: number;
  /** 变更清单，含未跟踪。 */
  changes: GitChange[];
}

/** 分支条目，来自 Rust `GitBranch`。 */
export interface GitBranch {
  /** 短名：本地是 `main`，远程是 `origin/main`。 */
  name: string;
  /** 是否为当前签出的分支；远程分支恒为 false。 */
  current: boolean;
  /** 是否远程分支。 */
  remote: boolean;
  /** 跟踪的上游分支短名；没有上游时为空串。 */
  upstream: string;
  /** 是否为该远端的默认分支（`<远端>/HEAD` 指向的那支）；本地分支恒为 false。 */
  defaultRef: boolean;
}

/** 一条提交，来自 Rust `GitCommit`。 */
export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  /** 作者时间，Unix 毫秒。 */
  authoredMs: number;
  subject: string;
  /** refs 标注，例如 `HEAD -> main`；没有时为空串。 */
  refs: string;
  /** 父提交的完整哈希，按 git 给出的顺序；根提交是空数组，合并提交有两条以上。 */
  parents: string[];
}

/** 一个标签，来自 Rust `GitTag`。 */
export interface GitTag {
  name: string;
  /** 指向的提交短哈希。 */
  target: string;
  /** 创建时间，Unix 毫秒。 */
  createdMs: number;
}

/** 提交改到的一个文件，来自 Rust `GitCommitFile`。 */
export interface GitCommitFile {
  path: string;
  /** 重命名/复制前的路径；其余为空串。 */
  oldPath: string;
  /** M / A / D / R / T 之一；取不到时为空串。 */
  status: string;
  added: number;
  removed: number;
}

/** 一条提交的完整信息，来自 Rust `GitCommitDetail`。 */
export interface GitCommitDetail {
  hash: string;
  short: string;
  author: string;
  email: string;
  authoredMs: number;
  subject: string;
  /** 标题行以下的正文。 */
  body: string;
  refs: string;
  /** 父提交短哈希；根提交为空数组。 */
  parents: string[];
  /** 提交者姓名；变基或代提交时和作者不是同一人。 */
  committer: string;
  /** 提交者邮箱。 */
  committerEmail: string;
  /** 提交时间，Unix 毫秒。 */
  committedMs: number;
  files: GitCommitFile[];
}

/** 提交里某个文件的两侧内容，来自 Rust `GitFileSides`。 */
export interface GitFileSides {
  /** 父提交一侧；新增文件或根提交时为空串。 */
  original: string;
  /** 该提交一侧；被删除时为空串。 */
  modified: string;
}

/** 引用与工作树之间改到的一个文件，来自 Rust `GitNameStatus`。 */
export interface GitNameStatus {
  /** 相对仓库根的路径，正斜杠。 */
  path: string;
  /** 重命名/复制前的路径；其余为空串。 */
  oldPath: string;
  /** M / A / D / R / T 之一。 */
  status: string;
}

/** 日志查询条件，来自 Rust `GitLogQuery`；缺省字段一律按「不过滤」处理。 */
export interface GitLogQuery {
  /** 限定的分支/标签；空串表示当前分支。 */
  reference?: string;
  /** 作者子串。 */
  author?: string;
  /** 标题与正文里的文本。 */
  text?: string;
  /** text 按扩展正则解释。 */
  regex?: boolean;
  /** 起始时间，Unix 毫秒；0 表示不限。 */
  sinceMs?: number;
  /** 限定改到该路径（仓库相对）的提交；空串表示不限。 */
  path?: string;
  /** 条数上限。 */
  limit?: number;
}

/** path 用绝对路径；Rust 侧会换算成仓库相对路径。 */
export function gitProbe(path: string): Promise<GitProbe> {
  return invoke<GitProbe>("git_probe", { path });
}

/** 在打开的那个目录上建仓库；目录已经是仓库的一部分时 git 自己往上找那个根。 */
export function gitInit(root: string): Promise<string> {
  return invoke<string>("git_init", { root });
}

export function gitStatus(root: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_status", { root });
}

/** 取某版本下的文件内容，作为 diff 的基线一侧；该版本没有此文件时返回空串。 */
export function gitShow(root: string, revision: string, path: string): Promise<string> {
  return invoke<string>("git_show", { root, revision, path });
}

/** 索引里的版本（git show :path），已暂存那一侧的基线；索引没有该文件时为空串。 */
export function gitIndexShow(root: string, path: string): Promise<string> {
  return invoke<string>("git_index_show", { root, path });
}

/** absolutePaths 是仓库内绝对路径，Rust 侧转 pathspec。 */
export function gitStage(root: string, absolutePaths: string[]): Promise<void> {
  return invoke<void>("git_stage", { root, paths: absolutePaths });
}

export function gitUnstage(root: string, absolutePaths: string[]): Promise<void> {
  return invoke<void>("git_unstage", { root, paths: absolutePaths });
}

export function gitCommit(root: string, message: string, amend: boolean): Promise<string> {
  return invoke<string>("git_commit", { root, message, amend });
}

export function gitBranches(root: string): Promise<GitBranch[]> {
  return invoke<GitBranch[]>("git_branches", { root });
}

export function gitTags(root: string): Promise<GitTag[]> {
  return invoke<GitTag[]>("git_tags", { root });
}

export function gitRemotes(root: string): Promise<string[]> {
  return invoke<string[]>("git_remotes", { root });
}

/** 被 .gitignore 忽略的路径，「显示忽略文件」开关用。 */
export function gitIgnored(root: string): Promise<string[]> {
  return invoke<string[]>("git_ignored", { root });
}

/**
 * 把 `git_ignored` 回的仓库相对路径折成绝对前缀，正斜杠、小写，供前缀比较。
 *
 * 忽略项只按顶层给（如 `node_modules/`），所以判定与剪枝都看「落在某个前缀之下」，
 * 目录下的所有内容一起算。文件树的染色与搜索的可见性闸门共用这一份折算，
 * 两处的口径才不会分家。
 */
export function ignoredRoots(repoRoot: string, patterns: string[]): string[] {
  const prefix = repoRoot.replace(/[\\/]+$/, "");
  return patterns.map((pattern) =>
    `${prefix}/${pattern.replace(/[\\/]+$/, "")}`.replaceAll("\\", "/").toLocaleLowerCase()
  );
}

export function gitFetch(root: string): Promise<string> {
  return invoke<string>("git_fetch", { root });
}

export function gitPull(root: string): Promise<string> {
  return invoke<string>("git_pull", { root });
}

/** 当前分支没有上游时，后端退回 `push --set-upstream <第一个远端> HEAD`。 */
export function gitPush(root: string, setUpstream: boolean): Promise<string> {
  return invoke<string>("git_push", { root, setUpstream });
}

/** `revision` 空串打在 HEAD 上，否则打在给定那条修订上。 */
export function gitCreateTag(
  root: string,
  name: string,
  message: string,
  revision: string
): Promise<string> {
  return invoke<string>("git_create_tag", { root, name, message, revision });
}

export function gitCheckout(root: string, branch: string): Promise<string> {
  return invoke<string>("git_checkout", { root, branch });
}

/** `from` 非空时从那条引用起，否则从当前 HEAD 起；checkout=true 顺带切过去。 */
export function gitCreateBranch(
  root: string,
  name: string,
  from: string,
  checkout: boolean
): Promise<string> {
  return invoke<string>("git_create_branch", { root, name, from, checkout });
}

/** 把 name 合并进当前分支。 */
export function gitMerge(root: string, name: string): Promise<string> {
  return invoke<string>("git_merge", { root, name });
}

/** 当前分支变基到 onto。 */
export function gitRebase(root: string, onto: string): Promise<string> {
  return invoke<string>("git_rebase", { root, onto });
}

export function gitRenameBranch(root: string, name: string, to: string): Promise<string> {
  return invoke<string>("git_rename_branch", { root, name, to });
}

/** 后端用 `branch -d`，还没合并的分支 git 自己会拦。 */
export function gitDeleteBranch(root: string, name: string): Promise<string> {
  return invoke<string>("git_delete_branch", { root, name });
}

export function gitDeleteTag(root: string, name: string): Promise<string> {
  return invoke<string>("git_delete_tag", { root, name });
}

/** 推指定分支或标签，不动当前分支的上游设置。 */
export function gitPushRef(root: string, name: string): Promise<string> {
  return invoke<string>("git_push_ref", { root, name });
}

/** 删除远端分支：往服务器推一条删除引用。 */
export function gitDeleteRemoteBranch(root: string, name: string): Promise<string> {
  return invoke<string>("git_delete_remote_branch", { root, name });
}

/** 新建工作树：把 branch 签出到 path 目录里。 */
export function gitWorktreeAdd(root: string, path: string, branch: string): Promise<string> {
  return invoke<string>("git_worktree_add", { root, path, branch });
}

/** 把某个版本下的文件内容写回工作区，不动索引；revision 为空时从暂存区恢复。 */
export function gitRestoreFile(root: string, revision: string, path: string): Promise<string> {
  return invoke<string>("git_restore_file", { root, revision, path });
}

/** 针对历史某次提交中的单个文件应用反向差异（撤销该提交对该文件的改动）。 */
export function gitRevertFile(root: string, commit: string, path: string): Promise<string> {
  return invoke<string>("git_revert_file", { root, commit, path });
}

/** 两侧版本之间某个文件的统一差异；right 空串表示工作区那一侧。 */
export function gitDiffText(
  root: string,
  left: string,
  right: string,
  path: string
): Promise<string> {
  return invoke<string>("git_diff_text", { root, left, right, path });
}

/** 引用与工作树之间改到的文件清单。 */
export function gitDiffNames(root: string, revision: string): Promise<GitNameStatus[]> {
  return invoke<GitNameStatus[]>("git_diff_names", { root, revision });
}

/** 冲突恢复：变基/合并的继续与中止。 */
export function gitRebaseContinue(root: string): Promise<string> {
  return invoke<string>("git_rebase_continue", { root });
}

export function gitRebaseAbort(root: string): Promise<string> {
  return invoke<string>("git_rebase_abort", { root });
}

export function gitMergeContinue(root: string): Promise<string> {
  return invoke<string>("git_merge_continue", { root });
}

export function gitMergeAbort(root: string): Promise<string> {
  return invoke<string>("git_merge_abort", { root });
}

/** 摘一条提交到当前分支上。 */
export function gitCherryPick(root: string, revision: string): Promise<string> {
  return invoke<string>("git_cherry_pick", { root, revision });
}

export function gitCherryPickContinue(root: string): Promise<string> {
  return invoke<string>("git_cherry_pick_continue", { root });
}

export function gitCherryPickAbort(root: string): Promise<string> {
  return invoke<string>("git_cherry_pick_abort", { root });
}

/** 还原一条提交：做一笔内容相反的提交。 */
export function gitRevert(root: string, revision: string): Promise<string> {
  return invoke<string>("git_revert", { root, revision });
}

export function gitRevertContinue(root: string): Promise<string> {
  return invoke<string>("git_revert_continue", { root });
}

export function gitRevertAbort(root: string): Promise<string> {
  return invoke<string>("git_revert_abort", { root });
}

/** 重置的三档：只挪指针 / 再清索引 / 连工作区一起换。 */
export type ResetMode = "soft" | "mixed" | "hard";

/** 把当前分支的头挪到某条提交：soft 只挪指针，mixed 再清索引，hard 连工作区一起换。 */
export function gitReset(root: string, revision: string, mode: ResetMode): Promise<string> {
  return invoke<string>("git_reset", { root, revision, mode });
}

/** 只推这条提交（含）以前的那一段到分支所在的远端。 */
export function gitPushUpTo(root: string, branch: string, revision: string): Promise<string> {
  return invoke<string>("git_push_up_to", { root, branch, revision });
}

/** 按一边了结一个冲突文件；`side` 只有 ours（本地）与 theirs（对方）两种。 */
export function gitResolveConflict(root: string, path: string, side: "ours" | "theirs"): Promise<string> {
  return invoke<string>("git_resolve_conflict", { root, path, side });
}

export function gitLog(root: string, query: GitLogQuery = {}): Promise<GitCommit[]> {
  return invoke<GitCommit[]>("git_log", { root, query });
}

/** 能拿去修正的提交：HEAD 往下、还没推到远端的那几条，第一条就是上次提交。 */
export function gitAmendTargets(root: string): Promise<GitCommit[]> {
  return invoke<GitCommit[]>("git_amend_targets", { root });
}

/** 最近 limit 条提交里出现过的作者，按各人最近一次出现排。 */
export function gitAuthors(root: string, limit: number): Promise<string[]> {
  return invoke<string[]>("git_authors", { root, limit });
}

export function gitCommitDetail(root: string, revision: string): Promise<GitCommitDetail> {
  return invoke<GitCommitDetail>("git_commit_detail", { root, revision });
}

/** 提交里某个文件的两侧内容；`path` 用仓库相对路径。 */
export function gitCommitFile(
  root: string,
  revision: string,
  path: string
): Promise<GitFileSides> {
  return invoke<GitFileSides>("git_commit_file", { root, revision, path });
}

/** 变更项的简短状态标记，用于列表右侧单字母徽标。 */
export function changeMark(change: GitChange): string {
  if (change.untracked) return "U";
  if (change.conflicted) return "!";
  const work = change.workStatus.trim();
  const index = change.indexStatus.trim();
  if (work && work !== "M") return work;
  return index || work || "M";
}

/** 标记字母 → 行尾染色 class。冲突的 `!` 单独一个类，其余按字母（`.mark-!` 不是合法选择器）。 */
export function markClass(mark: string): string {
  return mark === "!" ? "mark-conflict" : `mark-${mark.toLowerCase()}`;
}

/** 一组变更的聚合标记：子孙含 M 即为 M，否则取最后一个非 D 的字母；无有效变更返回 null。 */
export function aggregateMark(changes: GitChange[]): string | null {
  let hasM = false;
  let last = "";
  for (const change of changes) {
    const mark = changeMark(change);
    // 删除态不向父级传播（文件已不存在），对齐 VS Code。
    if (mark === "D") continue;
    if (mark === "M") hasM = true;
    last = mark;
  }
  return hasM ? "M" : last || null;
}

/**
 * 目录聚合标记表：键为仓库相对路径（正斜杠），值为聚合字母，供目录行的圆点染色。
 * 每个变更沿祖先链向上累加，规则同 {@link aggregateMark}。
 * @param changes 变更清单
 * @returns 目录相对路径 → 聚合字母；没有变更的目录不在表里
 */
export function folderMarks(changes: GitChange[]): Map<string, string> {
  const acc = new Map<string, { hasM: boolean; last: string }>();
  for (const change of changes) {
    const mark = changeMark(change);
    if (mark === "D") continue;
    const parts = change.path.split("/");
    let dir = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      dir = dir ? `${dir}/${parts[i]}` : parts[i];
      const entry = acc.get(dir) ?? { hasM: false, last: "" };
      entry.last = mark;
      if (mark === "M") entry.hasM = true;
      acc.set(dir, entry);
    }
  }
  const out = new Map<string, string>();
  for (const [dir, entry] of acc) out.set(dir, entry.hasM ? "M" : entry.last);
  return out;
}
