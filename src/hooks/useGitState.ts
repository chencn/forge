import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../lib/fs";
import { joinPath, nativeSeparators, separator } from "../lib/format";
import {
  gitAmendTargets,
  gitBranches,
  gitCheckout,
  gitCherryPick,
  gitCherryPickAbort,
  gitCherryPickContinue,
  gitCommit,
  gitCreateBranch,
  gitCreateTag,
  gitDeleteBranch,
  gitDeleteTag,
  gitDeleteRemoteBranch,
  gitFetch,
  gitIgnored,
  gitInit,
  gitLog,
  gitMerge,
  gitMergeAbort,
  gitMergeContinue,
  gitProbe,
  gitPull,
  gitPush,
  gitPushRef,
  gitPushUpTo,
  gitRebase,
  gitRebaseAbort,
  gitRebaseContinue,
  gitRenameBranch,
  gitReset,
  gitResolveConflict,
  gitRestoreFile,
  gitRevertFile,
  gitRevert,
  gitRevertAbort,
  gitRevertContinue,
  gitStage,
  gitStatus,
  gitTags,
  gitUnstage,
  gitWorktreeAdd,
} from "../lib/git";
import type { ResetMode } from "../lib/git";
import { recoveryOf } from "../lib/git";
import type {
  GitBranch,
  GitChange,
  GitCommit,
  GitProbe,
  GitStatus,
  GitTag,
} from "../lib/git";

/** 状态还没回来时的空清单：每次给同一个数组，派生表的记忆才不会每帧失效。 */
const EMPTY_CHANGES: GitChange[] = [];

/** 已暂存：索引位有内容且不是冲突项。 */
export function isIndexChange(change: GitChange): boolean {
  return !change.untracked && !change.conflicted && change.indexStatus.trim() !== "";
}

/** 工作区改动：工作区位有内容，或文件还没被跟踪。冲突项只进「未合并」那一组，两边都不算。 */
export function isWorktreeChange(change: GitChange): boolean {
  if (change.conflicted) return false;
  return change.untracked || change.workStatus.trim() !== "";
}

export function useGitState(
  workspaceRoot: string | null,
  reportError: (message: string, title?: string) => void
) {
  const [probe, setProbe] = useState<GitProbe | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [tags, setTags] = useState<GitTag[]>([]);
  /** HEAD 上那一条，提交框的「上次提交」用。 */
  const [lastCommit, setLastCommit] = useState<GitCommit | null>(null);
  const [loading, setLoading] = useState(false);
  /** 已经发起过几次刷新，用来认出「我这一轮已经被更新的刷新超过了」。 */
  const seqRef = useRef(0);
  /**
   * 在飞的刷新条数。转圈状态不能跟着 `seqRef` 走：全量刷新还在飞时一次暂存把票据抢走，
   * 那一轮就永远收不到「我不是最新」之外的收尾信号，图标会一直转。
   */
  const pendingRef = useRef(0);
  /** 缓存已知已探明的仓库根，用于解除全量刷新时 gitProbe 的串行等待。 */
  const repoRootRef = useRef<string | null>(null);

  const beginRefresh = useCallback(() => {
    pendingRef.current += 1;
    setLoading(true);
  }, []);

  const endRefresh = useCallback(() => {
    pendingRef.current = pendingRef.current > 1 ? pendingRef.current - 1 : 0;
    if (pendingRef.current === 0) setLoading(false);
  }, []);

  const root = probe?.repoRoot ?? null;
  // 同步根目录引用，供并发快速路径使用
  repoRootRef.current = root;

  const refresh = useCallback(async () => {
    // 监听一起来刷新会叠着跑，五次调用各自的回来顺序不保证。给每次刷新编号，
    // 只有最新那一次允许写状态，否则旧结果会把新结果盖掉，面板停在半路上。
    const ticket = (seqRef.current += 1);
    const stale = () => ticket !== seqRef.current;
    if (!workspaceRoot) {
      repoRootRef.current = null;
      setProbe(null);
      setStatus(null);
      setBranches([]);
      setTags([]);
      setLastCommit(null);
      return;
    }
    beginRefresh();
    try {
      const knownRoot = repoRootRef.current;
      // 快速并发路径：若已有已探明的仓库根目录，同时发起探根和状态/分支读取，
      // 将 Windows 上的串行进程等待耗时降低约 50%。
      if (knownRoot) {
        const [nextProbe, stateResult] = await Promise.all([
          gitProbe(workspaceRoot),
          Promise.all([
            gitStatus(knownRoot),
            gitBranches(knownRoot),
            gitTags(knownRoot).catch(() => [] as GitTag[]),
            gitLog(knownRoot, { limit: 1 }).catch(() => [] as GitCommit[]),
          ]).catch(() => null),
        ]);
        if (stale()) return;
        const normalizedNextRoot = nextProbe.repoRoot
          ? nativeSeparators(nextProbe.repoRoot)
          : null;
        setProbe(
          normalizedNextRoot ? { ...nextProbe, repoRoot: normalizedNextRoot } : nextProbe
        );
        repoRootRef.current = normalizedNextRoot;

        // 若探根结果与当前根目录一致且并发查询成功，直接提交数据（99.9% 的常规场景）
        if (normalizedNextRoot === knownRoot && stateResult) {
          const [nextStatus, nextBranches, nextTags, nextLog] = stateResult;
          setStatus(nextStatus);
          setBranches(nextBranches);
          setTags(nextTags);
          setLastCommit(nextLog[0] ?? null);
          return;
        }

        if (!normalizedNextRoot) {
          setStatus(null);
          setBranches([]);
          setTags([]);
          setLastCommit(null);
          return;
        }

        // 根目录发生迁移（如工作区内切换了子仓库），以新根为准补拉一次
        const [nextStatus, nextBranches, nextTags, nextLog] = await Promise.all([
          gitStatus(normalizedNextRoot),
          gitBranches(normalizedNextRoot),
          gitTags(normalizedNextRoot).catch(() => [] as GitTag[]),
          gitLog(normalizedNextRoot, { limit: 1 }).catch(() => [] as GitCommit[]),
        ]);
        if (stale()) return;
        setStatus(nextStatus);
        setBranches(nextBranches);
        setTags(nextTags);
        setLastCommit(nextLog[0] ?? null);
        return;
      }

      // 冷启动路径：工作区首次挂载或尚未识别为 git 仓库，按序探根
      const nextProbe = await gitProbe(workspaceRoot);
      if (stale()) return;
      const normalizedNextRoot = nextProbe.repoRoot
        ? nativeSeparators(nextProbe.repoRoot)
        : null;
      setProbe(
        normalizedNextRoot ? { ...nextProbe, repoRoot: normalizedNextRoot } : nextProbe
      );
      repoRootRef.current = normalizedNextRoot;
      if (!normalizedNextRoot) {
        setStatus(null);
        setBranches([]);
        setTags([]);
        setLastCommit(null);
        return;
      }
      // 标签与最近一条提交拿不到不该让整块面板消失，各自退化成空值。
      const [nextStatus, nextBranches, nextTags, nextLog] = await Promise.all([
        gitStatus(normalizedNextRoot),
        gitBranches(normalizedNextRoot),
        gitTags(normalizedNextRoot).catch(() => [] as GitTag[]),
        gitLog(normalizedNextRoot, { limit: 1 }).catch(() => [] as GitCommit[]),
      ]);
      if (stale()) return;
      setStatus(nextStatus);
      setBranches(nextBranches);
      setTags(nextTags);
      setLastCommit(nextLog[0] ?? null);
    } catch (cause) {
      if (!stale()) reportError(errorText(cause));
    } finally {
      endRefresh();
    }
  }, [beginRefresh, endRefresh, reportError, workspaceRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 只重取变更清单的轻量刷新：暂存 / 取消暂存只动索引，分支、标签、最近提交都不会变，
   * 没必要每次都把另外三条 git 命令再跑一遍（Windows 上每条都要起一个进程）。
   */
  const refreshChanges = useCallback(async () => {
    const ticket = (seqRef.current += 1);
    const stale = () => ticket !== seqRef.current;
    if (!root) return;
    beginRefresh();
    try {
      const nextStatus = await gitStatus(root);
      if (stale()) return;
      setStatus(nextStatus);
    } catch (cause) {
      if (!stale()) reportError(errorText(cause));
    } finally {
      endRefresh();
    }
  }, [beginRefresh, endRefresh, reportError, root]);

  /** git 输出的是仓库相对正斜杠路径，界面与后端命令都要绝对路径。 */
  const absoluteOf = useCallback(
    (relative: string) => {
      if (!root) return relative;
      const sep = separator(root);
      return joinPath(root, relative.replaceAll("/", sep));
    },
    [root]
  );

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
        await refresh();
        return true;
      } catch (cause) {
        reportError(errorText(cause));
        return false;
      }
    },
    [refresh, reportError]
  );

  /** 暂存 / 取消暂存只动索引：失败弹错，成功只重取变更清单，不碰分支标签日志。 */
  const runIndex = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
        await refreshChanges();
        return true;
      } catch (cause) {
        reportError(errorText(cause));
        return false;
      }
    },
    [refreshChanges, reportError]
  );

  /**
   * 在没有仓库的目录上建一个。走的是打开的那个目录而不是 `root`——那时 `root` 还是 null。
   * 成功后整轮刷新，分支芯片下一遍就有仓库可读了。
   */
  const init = useCallback(
    () => (workspaceRoot ? run(() => gitInit(workspaceRoot)) : Promise.resolve(false)),
    [run, workspaceRoot]
  );

  const stage = useCallback(
    (paths: string[]) => (root ? runIndex(() => gitStage(root, paths)) : Promise.resolve(false)),
    [root, runIndex]
  );

  const unstage = useCallback(
    (paths: string[]) => (root ? runIndex(() => gitUnstage(root, paths)) : Promise.resolve(false)),
    [root, runIndex]
  );

  const commit = useCallback(
    async (message: string, amend: boolean) => {
      if (!root) return false;
      return run(() => gitCommit(root, message, amend));
    },
    [root, run]
  );

  const checkout = useCallback(
    (branch: string) => (root ? run(() => gitCheckout(root, branch)) : Promise.resolve(false)),
    [root, run]
  );

  /** 新建分支；`from` 非空时从那条引用起，andCheckout=true 顺带切过去。 */
  const createBranch = useCallback(
    (name: string, from: string, andCheckout: boolean) =>
      root ? run(() => gitCreateBranch(root, name, from, andCheckout)) : Promise.resolve(false),
    [root, run]
  );

  /** 合并 / 变基 / 改名 / 删除都动本地历史，失败要弹错、成功要刷新。 */
  const merge = useCallback(
    (name: string) => (root ? run(() => gitMerge(root, name)) : Promise.resolve(false)),
    [root, run]
  );
  const rebase = useCallback(
    (onto: string) => (root ? run(() => gitRebase(root, onto)) : Promise.resolve(false)),
    [root, run]
  );
  const renameBranch = useCallback(
    (name: string, to: string) =>
      root ? run(() => gitRenameBranch(root, name, to)) : Promise.resolve(false),
    [root, run]
  );
  const deleteBranch = useCallback(
    (name: string) => (root ? run(() => gitDeleteBranch(root, name)) : Promise.resolve(false)),
    [root, run]
  );
  const deleteTag = useCallback(
    (name: string) => (root ? run(() => gitDeleteTag(root, name)) : Promise.resolve(false)),
    [root, run]
  );
  /** 删远端分支是往服务器推删除引用，和本地删除一样要弹错、要刷新。 */
  const deleteRemoteBranch = useCallback(
    (name: string) => (root ? run(() => gitDeleteRemoteBranch(root, name)) : Promise.resolve(false)),
    [root, run]
  );
  const worktreeAdd = useCallback(
    (path: string, branch: string) =>
      root ? run(() => gitWorktreeAdd(root, path, branch)) : Promise.resolve(false),
    [root, run]
  );
  /** 把某个版本的文件内容写回工作区；revision 为空时从暂存区恢复。只影响工作区状态，走轻量刷新。 */
  const restoreFile = useCallback(
    (revision: string, path: string) =>
      root ? runIndex(() => gitRestoreFile(root, revision, path)) : Promise.resolve(false),
    [root, runIndex]
  );
  /** 针对历史某次提交中的单个文件应用反向差异（撤销该提交对该文件的改动）。走轻量刷新，无需重新扫分支与历史日志。 */
  const revertFile = useCallback(
    (commit: string, path: string) =>
      root ? runIndex(() => gitRevertFile(root, commit, path)) : Promise.resolve(false),
    [root, runIndex]
  );

  /** 按一边了结一个冲突文件：取完内容顺手 add，让这一项从未合并那一组里消失。仅变更索引与状态。 */
  const resolveConflict = useCallback(
    (path: string, side: "ours" | "theirs") =>
      root ? runIndex(() => gitResolveConflict(root, path, side)) : Promise.resolve(false),
    [root, runIndex]
  );

  /** 冲突恢复四件套：继续会落一次提交，中止把仓库退回动作之前。 */
  const rebaseContinue = useCallback(
    () => (root ? run(() => gitRebaseContinue(root)) : Promise.resolve(false)),
    [root, run]
  );
  const rebaseAbort = useCallback(
    () => (root ? run(() => gitRebaseAbort(root)) : Promise.resolve(false)),
    [root, run]
  );
  const mergeContinue = useCallback(
    () => (root ? run(() => gitMergeContinue(root)) : Promise.resolve(false)),
    [root, run]
  );
  const mergeAbort = useCallback(
    () => (root ? run(() => gitMergeAbort(root)) : Promise.resolve(false)),
    [root, run]
  );

  /**
   * 提交级的那几条：摘取和还原都可能停在冲突里（CHERRY_PICK_HEAD / REVERT_HEAD），
   * 所以各自也配一对继续/中止，和变基、合并那四件套一样由说明框上方的横幅驱动。
   * 重置的 hard 档会连工作区一起换，弹确认那句由调用方负责。
   */
  const cherryPick = useCallback(
    (revision: string) => (root ? run(() => gitCherryPick(root, revision)) : Promise.resolve(false)),
    [root, run]
  );
  const cherryPickContinue = useCallback(
    () => (root ? run(() => gitCherryPickContinue(root)) : Promise.resolve(false)),
    [root, run]
  );
  const cherryPickAbort = useCallback(
    () => (root ? run(() => gitCherryPickAbort(root)) : Promise.resolve(false)),
    [root, run]
  );
  const revert = useCallback(
    (revision: string) => (root ? run(() => gitRevert(root, revision)) : Promise.resolve(false)),
    [root, run]
  );
  const revertContinue = useCallback(
    () => (root ? run(() => gitRevertContinue(root)) : Promise.resolve(false)),
    [root, run]
  );
  const revertAbort = useCallback(
    () => (root ? run(() => gitRevertAbort(root)) : Promise.resolve(false)),
    [root, run]
  );
  const reset = useCallback(
    (revision: string, mode: ResetMode) =>
      root ? run(() => gitReset(root, revision, mode)) : Promise.resolve(false),
    [root, run]
  );

  /**
   * 停在哪个动作中间，以及「继续 / 中止」那两颗落到哪一对命令。
   * 提交面板的横幅和顶栏的微工具条都读这一份，不各写各的判断链。
   */
  const recovery = recoveryOf(probe);
  const recoveryContinue = useCallback(() => {
    if (recovery === "rebase") return rebaseContinue();
    if (recovery === "merge") return mergeContinue();
    if (recovery === "cherryPick") return cherryPickContinue();
    if (recovery === "revert") return revertContinue();
    return Promise.resolve(false);
  }, [recovery, rebaseContinue, mergeContinue, cherryPickContinue, revertContinue]);
  const recoveryAbort = useCallback(() => {
    if (recovery === "rebase") return rebaseAbort();
    if (recovery === "merge") return mergeAbort();
    if (recovery === "cherryPick") return cherryPickAbort();
    if (recovery === "revert") return revertAbort();
    return Promise.resolve(false);
  }, [recovery, rebaseAbort, mergeAbort, cherryPickAbort, revertAbort]);

  const createTag = useCallback(
    (name: string, message: string, revision = "") =>
      root ? run(() => gitCreateTag(root, name, message, revision)) : Promise.resolve(false),
    [root, run]
  );

  /** 网络类操作把 git 的进度文案回给调用方，成功时返回那段文本。 */
  const remote = useCallback(
    async (action: (repo: string) => Promise<string>, actionKey?: string) => {
      if (!root) return null;
      try {
        const detail = await action(root);
        await refresh();
        return detail;
      } catch (cause) {
        reportError(errorText(cause), actionKey);
        return null;
      }
    },
    [refresh, reportError, root]
  );

  const fetch = useCallback(() => remote(gitFetch, "fetch"), [remote]);
  const pull = useCallback(() => remote(gitPull, "pull"), [remote]);
  const push = useCallback(
    (setUpstream: boolean) => remote((repo) => gitPush(repo, setUpstream), "push"),
    [remote]
  );
  /** 推指定分支或标签：网络类操作，成功时把 git 的进度文案回给调用方。 */
  const pushRef = useCallback(
    (name: string) => remote((repo) => gitPushRef(repo, name), "push"),
    [remote]
  );
  /** 只推这条提交（含）以前那一段，同样是网络操作，把 git 的进度文案回给调用方。 */
  const pushUpTo = useCallback(
    (branch: string, revision: string) =>
      remote((repo) => gitPushUpTo(repo, branch, revision), "push"),
    [remote]
  );

  /** 忽略清单只在开关打开时才要，单独取，不进每次 refresh。 */
  const loadIgnored = useCallback(
    () => (root ? gitIgnored(root).catch(() => [] as string[]) : Promise.resolve([])),
    [root]
  );

  /** 修正目标清单：只在打开那颗下拉时去取，取不到就当只有上次提交。 */
  const loadAmendTargets = useCallback(
    () => (root ? gitAmendTargets(root).catch(() => [] as GitCommit[]) : Promise.resolve([])),
    [root]
  );

  /**
   * 派生清单与返回对象都要记住。
   *
   * 每帧新建的话，下游那些「依赖 git」的 effect 就等于依赖了渲染次数：
   * `GitPanel` 的忽略清单 effect 会在每次 App 渲染（含状态栏每 5 秒那一次）
   * 后重跑，一次 `git status --ignored` 子进程就这么被反复起出来。
   */
  const changes = status?.changes ?? EMPTY_CHANGES;
  const worktreeChanges = useMemo(() => changes.filter(isWorktreeChange), [changes]);
  const stagedChanges = useMemo(() => changes.filter(isIndexChange), [changes]);
  /** IDEA 把「已修改」和「未进行版本控制」分成两组摆。 */
  const trackedChanges = useMemo(
    () => worktreeChanges.filter((change) => !change.untracked),
    [worktreeChanges]
  );
  const untrackedChanges = useMemo(
    () => worktreeChanges.filter((change) => change.untracked),
    [worktreeChanges]
  );
  /** IDEA 的 Unmerged 一节：排在已暂存之上，且这些文件不出现在其它两组里。 */
  const conflictChanges = useMemo(
    () => changes.filter((change) => change.conflicted),
    [changes]
  );

  return useMemo(
    () => ({
      probe,
      status,
      branches,
      tags,
      lastCommit,
      root,
      loading,
      refresh,
      refreshChanges,
      absoluteOf,
      init,
      stage,
      unstage,
      commit,
      checkout,
      createBranch,
      createTag,
      merge,
      rebase,
      renameBranch,
      deleteBranch,
      deleteTag,
      deleteRemoteBranch,
      worktreeAdd,
      restoreFile,
      revertFile,
      resolveConflict,
      rebaseContinue,
      rebaseAbort,
      mergeContinue,
      mergeAbort,
      recovery,
      recoveryContinue,
      recoveryAbort,
      cherryPick,
      cherryPickContinue,
      cherryPickAbort,
      revert,
      revertContinue,
      revertAbort,
      reset,
      fetch,
      pull,
      push,
      pushRef,
      pushUpTo,
      loadIgnored,
      loadAmendTargets,
      stagedChanges,
      worktreeChanges,
      trackedChanges,
      untrackedChanges,
      conflictChanges,
    }),
    [
      probe,
      status,
      branches,
      tags,
      lastCommit,
      root,
      loading,
      refresh,
      refreshChanges,
      absoluteOf,
      init,
      stage,
      unstage,
      commit,
      checkout,
      createBranch,
      createTag,
      merge,
      rebase,
      renameBranch,
      deleteBranch,
      deleteTag,
      deleteRemoteBranch,
      worktreeAdd,
      restoreFile,
      revertFile,
      resolveConflict,
      rebaseContinue,
      rebaseAbort,
      mergeContinue,
      mergeAbort,
      recovery,
      recoveryContinue,
      recoveryAbort,
      cherryPick,
      cherryPickContinue,
      cherryPickAbort,
      revert,
      revertContinue,
      revertAbort,
      reset,
      fetch,
      pull,
      push,
      pushRef,
      pushUpTo,
      loadIgnored,
      loadAmendTargets,
      stagedChanges,
      worktreeChanges,
      trackedChanges,
      untrackedChanges,
      conflictChanges,
    ]
  );
}

export type GitState = ReturnType<typeof useGitState>;
