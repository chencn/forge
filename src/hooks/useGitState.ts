import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../lib/fs";
import { createCoalescer, type Coalescer } from "../lib/coalesce";
import { joinPath, nativeSeparators, separator } from "../lib/format";
import { translate } from "../i18n";
import { notificationCenter } from "../lib/notifications";
import {
  gitAmendTargets,
  containsRepository,
  gitCheckout,
  gitCherryPick,
  gitCherryPickAbort,
  gitCherryPickContinue,
  gitCommit,
  type CommitRequestOptions,
  gitCreateBranch,
  gitCreateTag,
  gitDeleteBranch,
  gitDeleteTag,
  gitDeleteRemoteBranch,
  gitDiscover,
  gitFetch,
  gitInit,
  gitLog,
  gitMerge,
  gitMergeAbort,
  gitMergeContinue,
  gitProbe,
  gitPull,
  gitUpdateBranch,
  gitPush,
  gitPushTarget,
  isPushRejected,
  gitPushRef,
  gitPushUpTo,
  gitRebase,
  gitRebaseAbort,
  gitRebaseContinue,
  gitRefs,
  gitRenameBranch,
  gitReset,
  gitResolveConflict,
  gitRestoreFile,
  gitRevert,
  gitRevertAbort,
  gitRevertContinue,
  gitShelve,
  gitShelfDelete,
  gitShelfRename,
  gitShelves,
  gitStashApply,
  gitStashBranch,
  gitStashDrop,
  gitStashList,
  gitStashPush,
  gitUnshelve,
  gitStage,
  gitStatus,
  gitUnstage,
  gitWorktreeAdd,
} from "../lib/git";
import type { GitShelfApplyOutcome, GitShelvedChangeList, GitPushOptions, ResetMode } from "../lib/git";
import { recoveryOf } from "../lib/git";
import type {
  GitBranch,
  GitChange,
  GitCommit,
  GitProbe,
  GitStatus,
  GitStash,
  GitTag,
} from "../lib/git";

/** 状态还没回来时的空清单：每次给同一个数组，派生表的记忆才不会每帧失效。 */
const EMPTY_CHANGES: GitChange[] = [];

/** 工作区内一个仓库的变更快照；读取失败保留仓库身份并显式报告错误。 */
export interface GitRepositorySnapshot {
  /** 仓库工作树的绝对根路径。 */
  root: string;
  /** 仓库操作中间态；尚未读回时为 null。 */
  probe: GitProbe | null;
  /** 当前分支和变更；首次读取前为 null，读取失败时保留最后成功快照。 */
  status: GitStatus | null;
  /** 最近读取错误；正常时为 null。 */
  error: string | null;
}

/** 一条 Git 操作的种类。 */
export type GitOperationKind = "fetch" | "pull" | "push" | "checkout" | "createBranch" | "createTag" | "merge" | "rebase";
/** 一条 Git 操作的进行时状态（跑完留在历史上供回放）。 */
export interface GitOperation {
  id: number;
  root: string;
  kind: GitOperationKind;
  target: string;
  phase: "running" | "success" | "error";
  message?: string;
  fraction?: number;
}

/** 调用方注入的工作流钩子（更新前的确认、更新策略与推送被拒时的自动更新）。 */
interface GitWorkflow {
  beforeUpdate?: () => Promise<unknown>;
  updateMethod?: "merge" | "rebase";
  autoUpdateOnPushRejected?: boolean;
}

/** 已暂存：索引位有内容且不是冲突项。 */
export function isIndexChange(change: GitChange): boolean {
  return !change.untracked && !change.conflicted && change.indexStatus.trim() !== "";
}

/** 工作区改动：工作区位有内容，或文件还没被跟踪。冲突项只进「未合并」那一组，两边都不算。 */
export function isWorktreeChange(change: GitChange): boolean {
  if (change.conflicted) return false;
  return change.untracked || change.workStatus.trim() !== "";
}

/**
 * 发现工作区内的仓库，并将 Git 状态与操作绑定到所选仓库。
 * @param workspaceRoot - 工作区目录；null 时清空 Git 上下文
 * @param reportError - 发现或操作失败时的错误出口
 * @param afterRepoWrite - 仓库写操作结束后抑制监听回声
 * @param workflow - 更新与推送的保存策略
 * @returns 原有活动仓库状态及操作；repositories 为全部根，repositoryStates 为全部变更快照，selectRepository 切换分支栏目标，refresh 重扫并刷新，refreshChanges 刷新全部变更，runRepository 按根锁定写入
 */
export function useGitState(
  workspaceRoot: string | null,
  reportError: (message: string, title?: string) => void,
  afterRepoWrite?: () => void,
  workflow: GitWorkflow = {},
) {
  /** 每个工作区在本次会话内保留自己的仓库选择。 */
  const selections = useRef(new Map<string, string>());
  /** 发现结果带来源，避免切换工作区的第一帧复用旧根。 */
  const [discovery, setDiscovery] = useState<{
    /** 扫描所属的工作区。 */
    workspace: string | null;
    /** 按默认选择顺序排列的仓库根。 */
    roots: string[];
    /** 所选仓库；没有仓库时为 null。 */
    selected: string | null;
  } | null>(null);
  /** 当前工作区与发现序号用于丢弃迟到的扫描。 */
  const currentWorkspace = useRef(workspaceRoot);
  /** 工作区每次切换递增，包括离开后再返回同一路径。 */
  const snapshotEpoch = useRef(0);
  if (currentWorkspace.current !== workspaceRoot) snapshotEpoch.current += 1;
  currentWorkspace.current = workspaceRoot;
  /** 当前渲染绑定的工作区实例，用于拒绝离开后再返回时遗留的写回调。 */
  const contextEpoch = snapshotEpoch.current;
  /** 连续扫描仅接受最新结果。 */
  const generation = useRef(0);
  /** 全部仓库的变更独立于分支栏的活动仓库，根路径是状态键。 */
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, GitRepositorySnapshot>>(new Map());
  /** 每个根独立丢弃迟到的读取，避免一个慢仓库阻塞其它仓库。 */
  const snapshotTickets = useRef(new Map<string, number>());
  /** 当前已注册根用于拒绝旧工作区或已经移出的仓库操作。 */
  const registeredRoots = useRef<readonly string[]>([]);
  /** 仓库写入期间拒绝重复提交与同时修改索引。 */
  const writingRoots = useRef(new Set<string>());
  /** 分支栏当前根；异步收尾不能使用操作开始时的选择。 */
  const selectedRoot = useRef<string | null>(null);
  /**
   * 刷新各仓库的分支、变更与恢复状态，逐个发布结果。
   * @param roots - 本次需要读取的仓库根
   * @returns 所有读取结束；失败保留仓库条目并写入 error
   */
  const refreshRepositories = useCallback(async (roots: readonly string[]) => {
    /** 本轮读取所属的工作区实例。 */
    const epoch = snapshotEpoch.current;
    await Promise.all(roots.map(async (root) => {
      /** 当前根的请求序号。 */
      const ticket = (snapshotTickets.current.get(root) ?? 0) + 1;
      snapshotTickets.current.set(root, ticket);
      /** 本次结果；错误时不把仓库显示为干净。 */
      let snapshot: GitRepositorySnapshot;
      try {
        /** Git 身份与变更并行读取。 */
        const [probe, status] = await Promise.all([gitProbe(root), gitStatus(root)]);
        snapshot = { root, probe, status, error: null };
      } catch (cause) {
        snapshot = { root, probe: null, status: null, error: errorText(cause) };
      }
      if (epoch !== snapshotEpoch.current || currentWorkspace.current !== workspaceRoot || !registeredRoots.current.includes(root)
        || snapshotTickets.current.get(root) !== ticket) return;
      setSnapshots((current) => new Map(current).set(root, snapshot.error && current.has(root)
        ? { ...current.get(root)!, error: snapshot.error } : snapshot));
    }));
  }, [workspaceRoot]);
  /**
   * 重扫仓库列表并保留仍有效的选择。
   * @returns 扫描结束；失败上报错误，旧工作区结果直接丢弃
   */
  const discover = useCallback(async () => {
    if (!workspaceRoot || currentWorkspace.current !== workspaceRoot) return;
    /** 本次扫描身份。 */
    const ticket = ++generation.current;
    try {
      /** 后端路径转为界面统一使用的本机分隔符。 */
      const roots = (await gitDiscover(workspaceRoot)).map(nativeSeparators);
      if (ticket !== generation.current || currentWorkspace.current !== workspaceRoot) return;
      registeredRoots.current = roots;
      /** 优先保留用户选择，已移除时退到第一个仓库。 */
      const previous = selections.current.get(workspaceRoot);
      /** 无仓库时继续以工作区目录提供初始化入口。 */
      const selected = previous && roots.includes(previous) ? previous : roots[0] ?? null;
      if (selected) selections.current.set(workspaceRoot, selected);
      else selections.current.delete(workspaceRoot);
      setDiscovery({ workspace: workspaceRoot, roots, selected });
      await refreshRepositories(roots.filter((root) => root !== selected));
    } catch (cause) {
      if (ticket !== generation.current || currentWorkspace.current !== workspaceRoot) return;
      reportError(errorText(cause));
    }
  }, [workspaceRoot, reportError, refreshRepositories]);
  useEffect(() => { void discover(); return () => { generation.current += 1; }; }, [discover]);
  /** 只有当前工作区的发现结果可以进入仓库状态机。 */
  const active = discovery?.workspace === workspaceRoot ? discovery : null;
  registeredRoots.current = active?.roots ?? [];
  selectedRoot.current = active?.selected ?? null;
  /** 复用原有单仓库状态机，使切仓库与切工作区共享请求隔离和操作锁。 */
  const repository = useRepositoryState(active ? active.selected ?? workspaceRoot : null, reportError, afterRepoWrite, workflow, writingRoots);
  useEffect(() => {
    if (!repository.root || !registeredRoots.current.includes(repository.root)) return;
    if (!repository.status && !repository.readError) return;
    // 活动根的新读数使此前在后台启动的旧读取作废。
    snapshotTickets.current.set(repository.root, (snapshotTickets.current.get(repository.root) ?? 0) + 1);
    setSnapshots((current) => new Map(current).set(repository.root!, {
      root: repository.root!, probe: repository.probe,
      status: repository.status ?? current.get(repository.root!)?.status ?? null, error: repository.readError,
    }));
  }, [repository.root, repository.probe, repository.status, repository.readError]);
  /**
   * 切换到发现列表中的仓库，拒绝任意外部路径。
   * @param root - 列表中的绝对仓库根路径
   * @returns 更新当前工作区的选择；无效路径不产生副作用
   */
  const selectRepository = useCallback((root: string) => {
    if (!workspaceRoot || !active?.roots.includes(root)) return;
    selections.current.set(workspaceRoot, root);
    setDiscovery({ ...active, selected: root });
  }, [workspaceRoot, active]);
  /**
   * 同时刷新候选仓库和当前仓库数据。
   * @returns 两项刷新均结束，错误由各自的错误出口报告
   */
  const refresh = useCallback(async () => { await Promise.all([discover(), repository.refresh()]); }, [discover, repository.refresh]);
  /**
   * 文件监听刷新全部仓库的变更，活动仓库同时更新原有分支状态。
   * @returns 所有刷新结束，失败信息保存在对应仓库快照
   */
  const refreshChanges = useCallback(async () => {
    await Promise.all([refreshRepositories(registeredRoots.current.filter((root) => root !== selectedRoot.current)), repository.refreshChanges()]);
  }, [refreshRepositories, repository.refreshChanges]);
  /**
   * 对明确指定的已注册仓库执行一次写操作，并只刷新该仓库。
   * @param root - 目标仓库根，不能以打开的父文件夹替代
   * @param action - 已绑定该根的 IPC 操作
   * @returns 成功结果；失败、重复操作或仓库已移出时为 null
   */
  const runRepository = useCallback(async <T,>(root: string, action: () => Promise<T>): Promise<T | null> => {
    if (contextEpoch !== snapshotEpoch.current || currentWorkspace.current !== workspaceRoot || !registeredRoots.current.includes(root) || writingRoots.current.has(root)) return null;
    writingRoots.current.add(root);
    try {
      return await action();
    } catch (cause) {
      if (contextEpoch === snapshotEpoch.current) reportError(`${root}: ${errorText(cause)}`);
      return null;
    } finally {
      try {
        afterRepoWrite?.();
        if (root === selectedRoot.current) await activeRefresh.current();
        else await refreshRepositories([root]);
      } finally { writingRoots.current.delete(root); }
    }
  }, [workspaceRoot, contextEpoch, reportError, afterRepoWrite, refreshRepositories, repository.root, repository.refresh]);
  /** 异步写入收尾调用最新活动仓库的刷新，避免切换期间覆盖新状态。 */
  const activeRefresh = useRef(repository.refresh);
  activeRefresh.current = repository.refresh;
  /** 所有仓库使用独立快照，切换分支栏不改变提交树。 */
  const repositoryStates = useMemo(() => (active?.roots ?? []).map((root) => {
    /** 未完成读取时保留占位，避免将未读取误判为没有仓库。 */
    const snapshot = snapshots.get(root) ?? { root, probe: null, status: null, error: null };
    return snapshot.status ? { ...snapshot, status: { ...snapshot.status, changes: snapshot.status.changes.filter((change) =>
      !change.untracked || !containsRepository(joinPath(root, change.path), active?.roots ?? [])) } } : snapshot;
  }), [active, snapshots, repository.root, repository.status, repository.probe]);
  return useMemo(() => ({ ...repository, repositories: active?.roots ?? [], repositoryStates, selectRepository, refresh, refreshChanges, runRepository }),
    [repository, active, repositoryStates, selectRepository, refresh, refreshChanges, runRepository]);
}

/**
 * 管理单个仓库的状态、操作和异步隔离。
 * @param workspaceRoot - 当前仓库的探测目录；null 时清空状态
 * @param reportError - 操作失败的错误出口
 * @param afterRepoWrite - 仓库写操作收尾回调
 * @param workflow - 更新与推送策略
 * @param sharedLocks - 工作区共享的每仓库写锁；未传时使用本地锁
 * @returns probe/status/branches/tags 等仓库快照、按根隔离的操作状态与刷新及 Git 动作
 */
function useRepositoryState(
  workspaceRoot: string | null,
  reportError: (message: string, title?: string) => void,
  /**
   * 本地写仓库动作收尾时通知一次，让调用方把紧接着来的 watcher 回声压掉。
   * 这些命令自己会刷新状态，回声再刷一遍就是白起一个 git 进程。
   */
  afterRepoWrite?: () => void,
  workflow: GitWorkflow = {},
  sharedLocks?: { current: Set<string> },
) {
  const workflowRef = useRef(workflow);
  workflowRef.current = workflow;
  const [probe, setProbe] = useState<GitProbe | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  /** 最近读取错误；保留旧状态供展示，但阻止使用旧状态提交。 */
  const [readError, setReadError] = useState<string | null>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [tags, setTags] = useState<GitTag[]>([]);
  /** HEAD 上那一条，提交框的「上次提交」用。 */
  const [lastCommit, setLastCommit] = useState<GitCommit | null>(null);
  /** stash 列表，最新在前；只在整轮刷新里拉（见 `refreshOnce`）。 */
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [shelves, setShelves] = useState<GitShelvedChangeList[]>([]);
  const [operations, setOperations] = useState<ReadonlyMap<string, GitOperation>>(new Map());
  const operationTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  // 同仓库请求在 React 重渲染前就上锁，快速连点也不会排出第二个 Git 操作。
  const localLocks = useRef(new Set<string>());
  /** 工作区写入与分支栏动作共用每根锁。 */
  const operationLocks = sharedLocks ?? localLocks;
  const operationSequence = useRef(0);
  /** 已经发起过几次刷新，用来认出「我这一轮已经被更新的刷新超过了」。 */
  const seqRef = useRef(0);
  /** 缓存已知已探明的仓库根，用于解除全量刷新时 gitProbe 的串行等待。 */
  const repoRootRef = useRef<string | null>(null);
  /** 记录上一次刷新的 workspaceRoot，切换工作区时立即清空旧项目的 Git 状态与缓存根。 */
  const lastWorkspaceRef = useRef<string | null>(workspaceRoot);
  const activeWorkspaceRef = useRef(workspaceRoot);
  activeWorkspaceRef.current = workspaceRoot;

  const root = lastWorkspaceRef.current === workspaceRoot ? probe?.repoRoot ?? null : null;
  const operation = root ? operations.get(root) ?? null : null;
  const pushing = operation?.kind === "push" && operation.phase === "running";
  // 同步根目录引用，供并发快速路径使用
  repoRootRef.current = root;

  useEffect(() => () => { for (const timer of operationTimers.current) clearTimeout(timer); }, []);

  const trackOperation = useCallback(async <T,>(kind: GitOperationKind, target: string, action: (onProgress: (line: string) => void) => Promise<T>, blocked: T): Promise<T> => {
    if (!root || operationLocks.current.has(root)) return blocked;
    operationLocks.current.add(root);
    const next: GitOperation = { id: ++operationSequence.current, root, kind, target, phase: "running" };
    setOperations((current) => new Map(current).set(root, next));
    let succeeded = false;
    try {
      const result = await action((message) => {
        // 每一阶段独立计数；没有百分比的输出恢复扫动，迟到输出不能改写下一个任务。
        const match = /(\d{1,3})%/.exec(message);
        const fraction = match && Number(match[1]) <= 100 ? Number(match[1]) / 100 : undefined;
        setOperations((current) => {
          const held = current.get(root);
          return held?.id === next.id && held.phase === "running"
            ? new Map(current).set(root, { ...held, message, fraction }) : current;
        });
      });
      succeeded = result !== null && result !== false;
      // 通知中心写入当前工程历史；旧工程后台完成时不能污染新工程。
      if (succeeded && activeWorkspaceRef.current === workspaceRoot) notificationCenter.notify({
        groupId: "git", groupTitle: "Git", projectRoot: root, level: "success",
        title: `${translate(`git.operation.${kind}`)} · ${translate("git.operationDone")}`,
        content: target, key: `git.operation:${root}`,
      });
      return result;
    } finally {
      operationLocks.current.delete(root);
      setOperations((current) => {
        const held = current.get(root);
        return held?.id === next.id ? new Map(current).set(root, { ...held, phase: succeeded ? "success" : "error" }) : current;
      });
      // 任务收尾保留 600ms；每个仓库独立，切回时仍能看见运行状态。
      const timer = setTimeout(() => {
        operationTimers.current.delete(timer);
        setOperations((current) => {
          if (current.get(root)?.id !== next.id) return current;
          const remaining = new Map(current); remaining.delete(root); return remaining;
        });
      }, 600);
      operationTimers.current.add(timer);
    }
  }, [root, workspaceRoot]);

  /** 整轮 / 轻量两条队列：同一时刻各只跑一趟，多来的请求并成收尾的一次补跑。 */
  const fullQueueRef = useRef<Coalescer | null>(null);
  const lightQueueRef = useRef<Coalescer | null>(null);
  const fullQueue = (fullQueueRef.current ??= createCoalescer());
  const lightQueue = (lightQueueRef.current ??= createCoalescer());

  const refreshOnce = useCallback(async () => {
    // 老工程的网络任务可能晚于切换工程结束，旧闭包不能重新探回旧仓库。
    if (activeWorkspaceRef.current !== workspaceRoot) return;
    // 监听一起来刷新会叠着跑，五次调用各自的回来顺序不保证。给每次刷新编号，
    // 只有最新那一次允许写状态，否则旧结果会把新结果盖掉，面板停在半路上。
    const ticket = (seqRef.current += 1);
    const stale = () => ticket !== seqRef.current || activeWorkspaceRef.current !== workspaceRoot;
    if (lastWorkspaceRef.current !== workspaceRoot) {
      lastWorkspaceRef.current = workspaceRoot;
      repoRootRef.current = null;
      setProbe(null);
      // 换工作区时排在后面的那轮补跑作废：旧仓库的状态读回来也不该写进新面板。
      fullQueue.cancelTrailing();
      lightQueue.cancelTrailing();
      setProbe(null);
      setStatus(null);
      setBranches([]);
      setTags([]);
      setLastCommit(null);
      setStashes([]);
      setShelves([]);
    }
    if (!workspaceRoot) {
      repoRootRef.current = null;
      setProbe(null);
      setStatus(null);
      setBranches([]);
      setTags([]);
      setLastCommit(null);
      setStashes([]);
      setShelves([]);
      return;
    }
    try {
      const knownRoot = repoRootRef.current;
      // 快速并发路径：若已有已探明的仓库根目录，同时发起探根和状态/分支读取，
      // 将 Windows 上的串行进程等待耗时降低约 50%。
      if (knownRoot) {
        const [nextProbe, stateResult] = await Promise.all([
          gitProbe(workspaceRoot),
          // 四条读命令一起发：分支与标签已由后端一趟 `for-each-ref` 取回，stash 也从
          // 「status 一变就单独拉」挪进这里——轻量刷新只动索引，stash 不可能变，
          // 而整轮刷新本来就在并发起进程，多这一条不增加墙钟时间。
          Promise.all([
            gitStatus(knownRoot),
            gitRefs(knownRoot),
            gitLog(knownRoot, { limit: 1 }).catch(() => [] as GitCommit[]),
            gitStashList(knownRoot).catch(() => [] as GitStash[]),
            gitShelves(knownRoot).catch(() => [] as GitShelvedChangeList[]),
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
          const [nextStatus, refs, nextLog, nextStashes, nextShelves] = stateResult;
          setReadError(null);
          setStatus(nextStatus);
          setBranches(refs.branches);
          setTags(refs.tags);
          setLastCommit(nextLog[0] ?? null);
          setStashes(nextStashes);
          setShelves(nextShelves);
          return;
        }

        if (!normalizedNextRoot) {
          setStatus(null);
          setBranches([]);
          setTags([]);
          setLastCommit(null);
          setStashes([]);
          setShelves([]);
          return;
        }

        // 根目录发生迁移（如工作区内切换了子仓库），以新根为准补拉一次
        const [nextStatus, refs, nextLog, nextStashes, nextShelves] = await Promise.all([
          gitStatus(normalizedNextRoot),
          gitRefs(normalizedNextRoot),
          gitLog(normalizedNextRoot, { limit: 1 }).catch(() => [] as GitCommit[]),
          gitStashList(normalizedNextRoot).catch(() => [] as GitStash[]),
          gitShelves(normalizedNextRoot).catch(() => [] as GitShelvedChangeList[]),
        ]);
        if (stale()) return;
        setReadError(null);
        setStatus(nextStatus);
        setBranches(refs.branches);
        setTags(refs.tags);
        setLastCommit(nextLog[0] ?? null);
        setStashes(nextStashes);
        setShelves(nextShelves);
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
        setStashes([]);
        setShelves([]);
        return;
      }
      // 最近一条提交、stash、shelved 清单拿不到不该让整块面板消失，各自退化成空值。
      const [nextStatus, refs, nextLog, nextStashes, nextShelves] = await Promise.all([
        gitStatus(normalizedNextRoot),
        gitRefs(normalizedNextRoot),
        gitLog(normalizedNextRoot, { limit: 1 }).catch(() => [] as GitCommit[]),
        gitStashList(normalizedNextRoot).catch(() => [] as GitStash[]),
        gitShelves(normalizedNextRoot).catch(() => [] as GitShelvedChangeList[]),
      ]);
      if (stale()) return;
      setReadError(null);
      setStatus(nextStatus);
      setBranches(refs.branches);
      setTags(refs.tags);
      setLastCommit(nextLog[0] ?? null);
      setStashes(nextStashes);
      setShelves(nextShelves);
    } catch (cause) {
      if (!stale()) { setReadError(errorText(cause)); reportError(errorText(cause)); }
    }
  }, [reportError, workspaceRoot]);

  /**
   * 整轮刷新排队：连着来五次，只跑第一次那趟，其余各次并成收尾的一次补跑。
   *
   * 四连进程（探根 + 状态 + 分支 + 标签）在 Windows 上是四个 git.exe，
   * 叠着跑既费进程又让后一次的读数盖不住前一次的写入顺序。补跑那轮读到的一定
   * 是最后一次请求之后的状态，所以合并丢不了东西。
   */
  const refresh = useCallback(() => activeWorkspaceRef.current === workspaceRoot ? fullQueue.request(refreshOnce) : Promise.resolve(), [fullQueue, refreshOnce, workspaceRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 只重取变更清单的轻量刷新：暂存 / 取消暂存只动索引，分支、标签、最近提交都不会变，
   * 没必要每次都把另外三条 git 命令再跑一遍（Windows 上每条都要起一个进程）。
   */
  const refreshChangesOnce = useCallback(async () => {
    if (activeWorkspaceRef.current !== workspaceRoot) return;
    const ticket = (seqRef.current += 1);
    const stale = () => ticket !== seqRef.current || activeWorkspaceRef.current !== workspaceRoot;
    if (!root) return;
    try {
      const nextStatus = await gitStatus(root);
      if (stale()) return;
      setReadError(null);
      setStatus(nextStatus);
    } catch (cause) {
      if (!stale()) { setReadError(errorText(cause)); reportError(errorText(cause)); }
    }
  }, [reportError, root, workspaceRoot]);

  /** 轻量刷新也排队：连点五次暂存只起两次 `git status`（手头那趟 + 收尾补一趟）。 */
  const refreshChanges = useCallback(
    () => activeWorkspaceRef.current === workspaceRoot ? lightQueue.request(refreshChangesOnce) : Promise.resolve(),
    [lightQueue, refreshChangesOnce, workspaceRoot]
  );

  /** git 输出的是仓库相对正斜杠路径，界面与后端命令都要绝对路径。 */
  const absoluteOf = useCallback(
    (relative: string) => {
      if (!root) return relative;
      const sep = separator(root);
      return joinPath(root, relative.replaceAll("/", sep));
    },
    [root]
  );

  /**
   * 写入与刷新共用每仓库锁，带进度操作可声明已经持有该锁。
   * @param action - 已绑定目标根的写入
   * @param lockHeld - 仅供 trackOperation 内部调用，表示外层管理锁
   * @returns 写入是否成功；同根正在写入时返回 false
   */
  const run = useCallback(
    async (action: () => Promise<unknown>, lockHeld = false) => {
      /** 初始化没有已发现根，仍按打开目录隔离。 */
      const target = root ?? workspaceRoot;
      if (!target || !lockHeld && operationLocks.current.has(target)) return false;
      if (!lockHeld) operationLocks.current.add(target);
      let done = false;
      try {
        await action();
        done = true;
      } catch (cause) {
        reportError(errorText(cause));
      }
      // 失败不等于仓库没动：合并 / 变基 / 优选 / 还原撞冲突时正是停在了中间，
      // 不重探一遍就得等人手点刷新才看得到那条横幅。
      // 自己已经拉过这一轮，先把 watcher 那次回声压掉，免得同一个仓库被读两遍。
      try { afterRepoWrite?.(); await refresh(); }
      finally { if (!lockHeld) operationLocks.current.delete(target); }
      return done;
    },
    [afterRepoWrite, refresh, reportError, root, workspaceRoot, operationLocks]
  );

  /**
   * 只写、不读回状态的版本。给「紧接着还有一次全量刷新」的调用方用：
   * 提交前整理索引（stage / unstage）之后马上就是 commit，中间那趟 `git status` 读回来的
   * 状态立刻被提交后的全量刷新盖掉——白起一个进程，还让面板闪一下中间态。
   */
  const runSilent = useCallback(
    async (action: () => Promise<unknown>) => {
      if (!root || operationLocks.current.has(root)) return false;
      operationLocks.current.add(root);
      try {
        await action();
        afterRepoWrite?.();
        return true;
      } catch (cause) {
        reportError(errorText(cause));
        return false;
      } finally { operationLocks.current.delete(root); }
    },
    [afterRepoWrite, reportError, root, operationLocks]
  );

  /** 暂存 / 取消暂存只动索引：失败弹错，成功只重取变更清单，不碰分支标签日志。 */
  const runIndex = useCallback(
    async (action: () => Promise<unknown>) => {
      if (!root || operationLocks.current.has(root)) return false;
      operationLocks.current.add(root);
      try {
        await action();
        afterRepoWrite?.();
        await refreshChanges();
        return true;
      } catch (cause) {
        reportError(errorText(cause));
        return false;
      } finally { operationLocks.current.delete(root); }
    },
    [afterRepoWrite, refreshChanges, reportError, root, operationLocks]
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
    (paths: string[], silent = false) => (root
      ? (silent ? runSilent(() => gitStage(root, paths)) : runIndex(() => gitStage(root, paths)))
      : Promise.resolve(false)),
    [root, runIndex, runSilent]
  );

  const unstage = useCallback(
    (paths: string[], silent = false) => (root
      ? (silent ? runSilent(() => gitUnstage(root, paths)) : runIndex(() => gitUnstage(root, paths)))
      : Promise.resolve(false)),
    [root, runIndex, runSilent]
  );

  /**
   * 提交。`paths` 非空时走 `--only`：只提交点名的那几条，索引里没点名的已暂存块
   * 原样保留（复选框勾选语义）。
   */
  const commit = useCallback(
    async (message: string, amend: boolean, paths?: string[], options?: CommitRequestOptions) => {
      if (!root) return false;
      return run(() => gitCommit(root, message, amend, paths, options));
    },
    [root, run]
  );

  const checkout = useCallback(
    (branch: string) => trackOperation("checkout", branch, () => root ? run(() => gitCheckout(root, branch), true) : Promise.resolve(false), false),
    [root, run, trackOperation]
  );

  /** 新建分支；`from` 非空时从那条引用起，andCheckout=true 顺带切过去。 */
  const createBranch = useCallback(
    (name: string, from: string, andCheckout: boolean) =>
      trackOperation("createBranch", name, () => root ? run(() => gitCreateBranch(root, name, from, andCheckout), true) : Promise.resolve(false), false),
    [root, run, trackOperation]
  );

  /** 合并 / 变基 / 改名 / 删除都动本地历史，失败要弹错、成功要刷新。 */
  const merge = useCallback(
    (name: string) => trackOperation("merge", name, () => root ? run(() => gitMerge(root, name), true) : Promise.resolve(false), false),
    [root, run, trackOperation]
  );
  const rebase = useCallback(
    (onto: string) => trackOperation("rebase", onto, () => root ? run(() => gitRebase(root, onto), true) : Promise.resolve(false), false),
    [root, run, trackOperation]
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
    (path: string, branch: string, newBranch: string) =>
      root ? run(() => gitWorktreeAdd(root, path, branch, newBranch)) : Promise.resolve(false),
    [root, run]
  );
  /** 把某个版本的文件内容写回工作区；revision 为空时从暂存区恢复。只影响工作区状态，走轻量刷新。 */
  const restoreFile = useCallback(
    (revision: string, path: string) =>
      root ? runIndex(() => gitRestoreFile(root, revision, path)) : Promise.resolve(false),
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

  // --- Stash：列表跟随每轮刷新，写动作走 run（成功自动整轮刷新） ---

  /** stash 写动作不动 status 对象之外的缓存，紧跟一次全量刷新即可。 */
  const stashPush = useCallback(
    (message: string, includeUntracked: boolean, keepIndex: boolean) =>
      root ? run(() => gitStashPush(root, message, includeUntracked, keepIndex)) : Promise.resolve(false),
    [root, run]
  );
  const stashApply = useCallback(
    (index: number, pop: boolean) =>
      root ? run(() => gitStashApply(root, index, pop, false)) : Promise.resolve(false),
    [root, run]
  );
  const stashDrop = useCallback(
    (index: number) => (root ? run(() => gitStashDrop(root, index)) : Promise.resolve(false)),
    [root, run]
  );
  const stashBranch = useCallback(
    (index: number, name: string) =>
      root ? run(() => gitStashBranch(root, index, name)) : Promise.resolve(false),
    [root, run]
  );

  // --- Shelf：同 stash 的模式。shelve/unshelve 的回调结果交给调用方弹提示。 ---

  const shelve = useCallback(
    (name: string, paths: string[]) =>
      root ? run(() => gitShelve(root, name, paths)) : Promise.resolve(false),
    [root, run]
  );
  // unshelve 不走 run：调用方要看 conflicts 清单（有冲突时条目保留、提示用户）。
  const unshelve = useCallback(
    async (id: string, remove: boolean): Promise<GitShelfApplyOutcome | null> => {
      if (!root || operationLocks.current.has(root)) return null;
      operationLocks.current.add(root);
      try {
        const outcome = await gitUnshelve(root, id, remove);
        afterRepoWrite?.();
        await refresh();
        return outcome;
      } catch (cause) {
        reportError(errorText(cause));
        return null;
      } finally { operationLocks.current.delete(root); }
    },
    [root, afterRepoWrite, refresh, reportError, operationLocks]
  );
  const shelfDelete = useCallback(
    (id: string) => (root ? run(() => gitShelfDelete(root, id)) : Promise.resolve(false)),
    [root, run]
  );
  const shelfRename = useCallback(
    (id: string, name: string) =>
      root ? run(() => gitShelfRename(root, id, name)) : Promise.resolve(false),
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
      trackOperation("createTag", name, () => root ? run(() => gitCreateTag(root, name, message, revision), true) : Promise.resolve(false), false),
    [root, run, trackOperation]
  );

  /** 网络类操作把 git 的进度文案回给调用方，成功时返回那段文本。 */
  const remote = useCallback(
    async (action: (repo: string, onProgress: (line: string) => void) => Promise<string>, actionKey: "fetch" | "pull" | "push") => trackOperation(actionKey, status?.branch ?? "", async (onProgress) => {
      if (!root) return null;
      try {
        const detail = await action(root, onProgress);
        return detail;
      } catch (cause) {
        reportError(errorText(cause), actionKey);
        return null;
      } finally {
        // 更新失败也可能停在合并/变基冲突中，必须读回恢复状态。
        afterRepoWrite?.();
        await refresh();
      }
    }, null),
    [afterRepoWrite, refresh, reportError, root, status?.branch, trackOperation]
  );

  const fetch = useCallback(() => remote(gitFetch, "fetch"), [remote]);
  const pull = useCallback((method: "ff-only" | "merge" | "rebase" = "merge") => remote((repo, onProgress) => gitPull(repo, method, onProgress), "pull"), [remote]);
  const updateBranch = useCallback((branch: string) => remote((repo, onProgress) => gitUpdateBranch(repo, branch, onProgress), "pull"), [remote]);
  const push = useCallback((options: GitPushOptions = {}) => {
    // 重试绑定原仓库、源分支和目标；切换工程后旧通知不能操作新工程。
    const request = { ...options, branch: options.branch ?? status?.branch };
    const target = request.branch ?? "";
    const execute = (method?: "merge" | "rebase"): Promise<string | null> => {
      if (activeWorkspaceRef.current !== workspaceRoot) return Promise.resolve(null);
      let autoUpdate: "merge" | "rebase" | undefined;
      return trackOperation("push", target, async (onProgress) => {
        if (!root) return null;
        let updating = false;
        let canUpdate = false;
        try {
          // 恢复推送前先保存编辑缓冲，再读取实际分支，等待保存时允许用户切换工程。
          if (method) await workflowRef.current.beforeUpdate?.();
          if (activeWorkspaceRef.current !== workspaceRoot) return null;
          const destination = await gitPushTarget(root, request.branch);
          request.remote ??= destination.remote;
          request.target ??= destination.target;
          setOperations((current) => {
            const held = current.get(root);
            return held ? new Map(current).set(root, { ...held, target: `${request.branch} → ${request.remote}/${request.target}` }) : current;
          });
          const current = await gitStatus(root);
          if (activeWorkspaceRef.current !== workspaceRoot) return null;
          canUpdate = !request.forceWithLease && !request.revision && !current.detached &&
            current.branch === request.branch && destination.tracked &&
            destination.remote === request.remote && destination.target === request.target;
          if (method) {
            // 只更新仍签出原分支且仍跟踪原目标的仓库；编辑过目标的推送不盲目 pull。
            if (!canUpdate) throw new Error(translate("git.pushContextChanged"));
            updating = true;
            setOperations((current) => {
              const held = current.get(root);
              return held ? new Map(current).set(root, { ...held, kind: "pull" }) : current;
            });
            await gitPull(root, method, onProgress);
            updating = false;
            setOperations((current) => {
              const held = current.get(root);
              return held ? new Map(current).set(root, { ...held, kind: "push" }) : current;
            });
          }
          return await gitPush(root, request, onProgress);
        } catch (cause) {
          const message = errorText(cause);
          if (activeWorkspaceRef.current === workspaceRoot) {
            const rejected = !updating && isPushRejected(message);
            // 每次用户推送最多自动更新一次；先释放操作锁，再开始恢复流程。
            if (rejected && canUpdate && !method && workflowRef.current.autoUpdateOnPushRejected) {
              autoUpdate = workflowRef.current.updateMethod ?? "merge";
              return null;
            }
            notificationCenter.notify({
              groupId: "git", groupTitle: "Git", projectRoot: root, level: "error",
              key: `git.operation:${root}`,
              title: translate(updating ? "notifications.pullFailed" : rejected ? "git.pushRejected" : "notifications.pushFailed"),
              content: message,
              actions: updating ? undefined : [
                { label: translate("git.retryPush"), run: () => { void execute(); } },
                ...(rejected && canUpdate ? (["merge", "rebase"] as const).map((method) => ({
                  label: translate(method === "merge" ? "git.mergeAndPush" : "git.rebaseAndPush"),
                  run: () => { void execute(method); },
                })) : []),
              ],
            });
          }
          return null;
        } finally {
          afterRepoWrite?.();
          await refresh();
        }
      }, null).then((result) => autoUpdate ? execute(autoUpdate) : result);
    };
    return execute();
  }, [afterRepoWrite, refresh, root, status?.branch, trackOperation, workspaceRoot]);
  /** 提交落盘与推送结果分开；推送复用相同的拒绝恢复和目标冻结。 */
  const commitAndPush = useCallback(async (message: string, amend: boolean, setUpstream = false, paths?: string[], options?: CommitRequestOptions) => {
    if (!root || operationLocks.current.has(root)) return false;
    const branch = status?.branch;
    if (!await commit(message, amend, paths, options)) return false;
    if (activeWorkspaceRef.current === workspaceRoot) await push({ branch, setUpstream });
    return true;
  }, [root, status?.branch, commit, push, workspaceRoot]);
  /** 推指定分支或标签：网络类操作，成功时把 git 的进度文案回给调用方。 */
  const pushRef = useCallback(
    (name: string) => remote((repo, onProgress) => gitPushRef(repo, name, onProgress), "push"),
    [remote]
  );
  /** 只推这条提交（含）以前那一段，同样是网络操作，把 git 的进度文案回给调用方。 */
  const pushUpTo = useCallback(
    (branch: string, revision: string) =>
      remote((repo) => gitPushUpTo(repo, branch, revision), "push"),
    [remote]
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
  /** 「已修改」和「未进行版本控制」分成两组摆。 */
  const trackedChanges = useMemo(
    () => worktreeChanges.filter((change) => !change.untracked),
    [worktreeChanges]
  );
  const untrackedChanges = useMemo(
    () => worktreeChanges.filter((change) => change.untracked),
    [worktreeChanges]
  );
  /** 未合并（Unmerged）一组：排在已暂存之上，且这些文件不出现在其它两组里。 */
  const conflictChanges = useMemo(
    () => changes.filter((change) => change.conflicted),
    [changes]
  );

  return useMemo(
    () => ({
      readError,
      probe,
      status,
      branches,
      tags,
      lastCommit,
      root,
      operation: operation?.root === root ? operation : null,
      backgroundOperations: [...operations.values()],
      pushing,
      refresh,
      refreshChanges,
      absoluteOf,
      init,
      stage,
      unstage,
      commit,
      commitAndPush,
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
      stashes,
      stashPush,
      stashApply,
      stashDrop,
      stashBranch,
      shelves,
      shelve,
      unshelve,
      shelfDelete,
      shelfRename,
      fetch,
      pull,
      updateBranch,
      push,
      pushRef,
      pushUpTo,
      loadAmendTargets,
      stagedChanges,
      worktreeChanges,
      trackedChanges,
      untrackedChanges,
      conflictChanges,
    }),
    [
      readError,
      probe,
      status,
      branches,
      tags,
      lastCommit,
      root,
      operation,
      operations,
      pushing,
      refresh,
      refreshChanges,
      absoluteOf,
      init,
      stage,
      unstage,
      commit,
      commitAndPush,
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
      stashes,
      stashPush,
      stashApply,
      stashDrop,
      stashBranch,
      shelves,
      shelve,
      unshelve,
      shelfDelete,
      shelfRename,
      fetch,
      pull,
      updateBranch,
      push,
      pushRef,
      pushUpTo,
      loadAmendTargets,
      stagedChanges,
      worktreeChanges,
      trackedChanges,
      untrackedChanges,
      conflictChanges,
    ]
  );
}

/** {@link useGitState} 的返回值类型（Git 面板与各对话框共用的状态接口）。 */
export type GitState = ReturnType<typeof useGitState>;
