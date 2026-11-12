import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Copy,
  ExternalLink,
  Eye,
  FileDiff,
  FolderOpen,
  GitBranchPlus,
  GitMerge,
  History,
  Loader2,
  Minus,
  Pencil,
  Plus,
  Sparkles,
  Undo2,
} from "lucide-react";

import { Button, IconButton } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor, MenuItem } from "./ContextMenu";
import EntryIcon from "./EntryIcon";
import Popover from "./Popover";

import type { GitChange, GitCommitDetail, GitCommitFile } from "../lib/git";
import {
  gitCommitDetail,
  gitConfigGet,
  gitDiffText,
  gitCommit,
  gitStage,
  gitUnstage,
  gitShelve,
  gitStashPush,
  gitLog,
  recoveryOf,
  markClass,
} from "../lib/git";
import { commitDraft, setCommitDraft, subscribeCommitDraft } from "../lib/commitDraft";
import { commitStamp, joinPath, relativePathFrom, basenameOf } from "../lib/format";
import { readFile } from "../lib/fs";
import { badCommitNames, isNewCommitPath } from "../features/vcs/commitChecks";
import {
  cancelAiCommit,
  collectFilesDiff,
  formatAiCommitError,
  generateAiCommitMessage,
  loadAiCommitConfig,
  useAiCommitEnabled,
} from "../lib/aiCommit";
import type { GitState } from "../hooks/useGitState";
import { RECOVERY_MESSAGE } from "../lib/recovery";
import { MOD_LABEL } from "../lib/sys";
import { isUnderJvmSourceRoot } from "../lib/jvm";
import { useI18n } from "../i18n";
import { useSettings } from "../hooks/useSettings";
import { IssueText } from "../features/vcs/IssueNavigation";
import { fileStamp, revealEntry, writeFile } from "../lib/fs";
import {
  loadChangelists,
  saveChangelists,
  newChangelistId,
  moveTo,
  DEFAULT_LIST_ID,
  type ChangelistsState,
} from "../lib/changelists";

import type { ChangeNode, ChangeSide } from "../features/vcs/changes";
import {
  aggregateCheck,
  aggregateRepositoryCheck,
  buildChangeTree,
  buildRepositoryChangeTree,
  checkKey,
  filesOf,
  isPartiallyStaged,
  isStaged,
  planCommit,
} from "../features/vcs/changes";
import {
  CommitOptionsPopup,
  loadCommitOptions,
  type CommitOptionsState,
} from "../features/vcs/CommitOptions";

import styles from "../features/vcs/CommitView.module.css";

/**
 * 无仓库或状态未就绪时的共享空数组。必须是模块级常量：
 * `git.status?.changes ?? []` 每次渲染都会造一个新数组，把依赖它的清理 effect 每渲染都重跑一遍。
 */
const EMPTY_CHANGES: GitChange[] = [];

/** 提交树里要交给 App 落地的动作：开文件、写补丁、回滚、加忽略、看历史。 */
export type CommitFileAction =
  | "editSource"
  | "patch"
  | "patchClipboard"
  | "history"
  | "rollback"
  | "ignore";

/** 工具窗口头部那两个视图页签选中的视图。 */
export type GitView = "commit" | "stash";

/** {@link GitPanel} 的入参。 */
interface GitPanelProps {
  git: GitState;
  /** 当前视图；页签画在工具窗口头部，面板只按它切换内容。 */
  view: GitView;
  /** 切视图的回调，日志「编辑提交消息」等入口也要能把面板拉回提交页。 */
  onViewChange: (view: GitView) => void;
  /** 网络动作交给 App 的统一窗口和任务流程。 */
  onUpdate: (root: string) => void;
  onPush: (root: string, branch: string) => void;
  /** 工作区目录，用于在非仓库时给出上下文。 */
  workspaceRoot: string;
  onOpenChange: (change: GitChange, staged: boolean, siblings: GitChange[]) => void;
  /** 打开某个文件的普通编辑器。 */
  onOpenFile: (path: string) => void;
  /** 主工具栏「提交…」动作自增它，说明框拿到焦点。 */
  focusSignal: number;
  /** 日志里「编辑提交消息」自增它：把 HEAD 摊进说明框并勾上修正。 */
  rewordSignal: number;
  /** 提交成功后把说明交给上层记进历史。 */
  onCommitted: (message: string) => void;
  /** 提交说明历史，新的在前。 */
  history: string[];
  /** 按目录分组：关掉就是平铺一列文件名。快捷键 Ctrl+Alt+P。 */
  groupByDir: boolean;
  /** 按模块分组：变更外面再套一层仓库根节点。快捷键 Ctrl+Alt+M。 */
  groupByModule: boolean;
  /** 列出被 .gitignore 挡掉的文件。 */
  showIgnored: boolean;
  /** 视图选项里翻这个开关。 */
  onToggleIgnored: () => void;
  /** 视图选项里的两个分组开关。 */
  onToggleByDir: () => void;
  onToggleByModule: () => void;
  /** 双击变更行打开比对还是源文件。 */
  showOnDoubleClick: "preview" | "source";
  /** 一件都没暂存时，提交按钮直接提交全部已跟踪改动；默认开着。 */
  /** 双击要打开源文件时走这条，落给 App 开编辑器标签。 */
  onOpenSource: (change: GitChange) => void;
  /** 「解决冲突」开的是同一个弹层。 */
  onOpenResolve: (repoRoot?: string) => void;
  /** 仓库根那一行显示的名字。 */
  repoName: string;
  /** 文件与目录菜单里需要动编辑器、对话框或日志的动作，落给 App。 */
  onFileAction: (action: CommitFileAction, path: string, staged: boolean, isDirectory?: boolean, repoRoot?: string) => void;
  /** 已忽略那一行的「从忽略列表移除」：动的是盖住它的那条规则，落给 App。 */
  onUnignore: (relative: string) => void;
  /** 修正那一节里的文件：点开看的是那次提交里这一份的差异。 */
  onOpenCommitFile: (revision: string, file: GitCommitFile) => void;
  /** 点击设置按钮打开 AI 提交配置 */
  onOpenAiSettings?: () => void;
}

/** 提交信息规范问题检查：主题长度、空行分隔等。 */
export function messageProblems(
  message: string,
  c: {
    blankLineAfterSubject: boolean;
    limitSubject: boolean;
    subjectLimit: number;
    limitBody: boolean;
    bodyLimit: number;
  }
): string[] {
  const lines = message.split("\n");
  const out: string[] = [];
  if (c.blankLineAfterSubject && lines.length > 1 && lines[1]!.trim() !== "") {
    out.push("主题行与正文之间需保留空行");
  }
  if (c.limitBody) {
    const long = lines.slice(1).findIndex((l) => l.length > c.bodyLimit);
    if (long >= 0) {
      out.push(`正文第 ${long + 2} 行超过了 ${c.bodyLimit} 个字符限制`);
    }
  }
  return out;
}

/** 达到右边界自动换行 */
export function wrapAtMargin(text: string, caret: number, limit: number): { text: string; caret: number } | null {
  const start = text.lastIndexOf("\n", caret - 1) + 1;
  const end = text.indexOf("\n", caret);
  const line = text.slice(start, end < 0 ? text.length : end);
  if (start === 0 || line.length <= limit) return null; // 主题行不自动折行
  const cut = line.lastIndexOf(" ", limit);
  if (cut <= 0) return null;
  const at = start + cut;
  return { text: `${text.slice(0, at)}\n${text.slice(at + 1)}`, caret };
}

/** 14px 三态复选框。 */
function CheckMark({
  checked,
  indeterminate,
  label,
  onToggle,
}: {
  checked: boolean;
  indeterminate: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <span
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      className={clsx(styles.check, (checked || indeterminate) && styles.checkOn)}
      onClick={(e) => {
        // 严禁冒泡到父级整行，防止勾选复选框时触发文件夹展开或折叠
        e.stopPropagation();
      }}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        onToggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {indeterminate ? <Minus size={10} /> : checked ? <Check size={10} /> : null}
    </span>
  );
}

/** Git 工具窗口主体：改动清单、changelist、暂存区与历史页签。 */
function GitPanel({
  git,
  view,
  onViewChange,
  onUpdate,
  onPush,
  workspaceRoot,
  onOpenChange,
  onOpenFile,
  focusSignal,
  rewordSignal,
  onCommitted,
  history,
  groupByDir,
  groupByModule,
  showIgnored,
  onToggleIgnored,
  onToggleByDir,
  onToggleByModule,
  showOnDoubleClick,
  onOpenSource,
  onOpenResolve,
  repoName,
  onFileAction,
  onUnignore,
  onOpenCommitFile,
  onOpenAiSettings,
}: GitPanelProps) {
  const { t, locale } = useI18n();

  // 视图选项 Popover 状态
  const viewRef = useRef<HTMLButtonElement>(null);
  const [viewAnchor, setViewAnchor] = useState<HTMLElement | null>(null);

  // 获取全局版本控制设置
  const { settings } = useSettings();
  const vcs = settings.vcs;

  // 提交选项仅包含已接通的 Git 参数与 TODO 检查，默认同步全局 VCS 设置。
  const commitOptionsRef = useRef<HTMLButtonElement>(null);
  const [commitOptionsOpen, setCommitOptionsOpen] = useState(false);
  const [commitOptions, setCommitOptions] = useState<CommitOptionsState>(() => {
    const loaded = loadCommitOptions();
    return {
      ...loaded,
      signOff: loaded.signOff || vcs.signOffCommit,
      checkTodo: loaded.checkTodo || vcs.checkTodo,
    };
  });

  /** 提交说明属于工作区的本次选择，分支栏切换不能替换或清空它。 */
  const draftKey = workspaceRoot;
  const [message, setMessageState] = useState(() => commitDraft(draftKey));
  const setMessage = (next: string) => {
    setCommitDraft(draftKey, next);
    setMessageState(next);
  };
  useEffect(() => {
    setMessageState(commitDraft(draftKey));
    return subscribeCommitDraft(draftKey, (next) => {
      setMessageState((prev) => (prev === next ? prev : next));
    });
  }, [draftKey]);
  const [emptyError, setEmptyError] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 提交规范计算 (Commit Message Inspections)
  const firstLine = message.split("\n")[0] ?? "";
  const isSubjectTooLong = vcs.limitSubjectLine && firstLine.length > vcs.subjectLineLimit;
  const marginChars = vcs.limitBodyLine ? vcs.bodyLineLimit : vcs.subjectLineLimit;
  const showMargin = vcs.showRightMargin && (vcs.limitBodyLine || vcs.limitSubjectLine);
  const commitProblems = useMemo(() => {
    return messageProblems(message, {
      blankLineAfterSubject: vcs.blankLineAfterSubject,
      limitSubject: vcs.limitSubjectLine,
      subjectLimit: vcs.subjectLineLimit,
      limitBody: vcs.limitBodyLine,
      bodyLimit: vcs.bodyLineLimit,
    });
  }, [message, vcs.blankLineAfterSubject, vcs.limitSubjectLine, vcs.subjectLineLimit, vcs.limitBodyLine, vcs.bodyLineLimit]);

  // 提交区收起与自定义高度状态
  const [commitCollapsed, setCommitCollapsed] = useState(false);
  const [commitHeight, setCommitHeight] = useState<number | null>(null);
  const commitBoxRef = useRef<HTMLDivElement>(null);
  const commitDrag = useRef<{ startY: number; startHeight: number } | null>(null);

  // 修正 (Amend) 状态
  const [amend, setAmend] = useState(false);
  const [amendDetail, setAmendDetail] = useState<GitCommitDetail | null>(null);
  const messageBeforeAmend = useRef("");
  const amendSeq = useRef(0);
  /** 修正操作固定到用户启用时的仓库，不能随分支栏切换漂移。 */
  const [amendRoot, setAmendRoot] = useState<string | null>(null);

  // 提交历史弹层
  const historyRef = useRef<HTMLButtonElement>(null);
  const [historyAnchor, setHistoryAnchor] = useState<HTMLElement | null>(null);

  // 右键菜单
  const [menu, setMenu] = useState<MenuAnchor | null>(null);

  // 待确认丢弃的贮藏；非 null 时弹出二次确认框。index 是 git stash 的序号（0 为最新）。
  const [stashToDrop, setStashToDrop] = useState<{ index: number; message: string } | null>(null);

  // 变更列表数据（支持按 Changelist 分组）
  const [changelists, setChangelists] = useState<ChangelistsState>(() =>
    loadChangelists(workspaceRoot)
  );

  useEffect(() => {
    setChangelists(loadChangelists(workspaceRoot));
  }, [workspaceRoot]);

  /**
   * 页签切到贮藏时，树专属按钮随之卸载；锚点没了的弹层先收掉，别留在半空。
   * 面板本身不卸载，说明框草稿与 AI 生成中的任务都还在。
   */
  useEffect(() => {
    setViewAnchor(null);
    setHistoryAnchor(null);
    setCommitOptionsOpen(false);
  }, [view]);

  // 勾选状态：按侧独立存储（`s:<path>` 管已暂存那条，`w:<path>` 管未暂存那条），
  // 同一文件（部分暂存的）在两组的复选框互不联动
  const [checks, setChecks] = useState<Map<string, boolean>>(new Map());

  // 文件分组默认折叠，用户手动展开；刷新变更列表时保留当前展开状态。
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(
    () => new Set(["group:staged", "group:unstaged", "group:unversioned"])
  );
  // 选中的节点 key 集合
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  // AI 提交相关状态
  const aiCommitEnabled = useAiCommitEnabled();
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState<string | null>(null);
  // Stash Changes… 对话框：消息默认留空走 git 的「WIP on …」，未跟踪文件默认包含。
  const [stashDialog, setStashDialog] = useState(false);
  /** 贮藏确认冻结目标，切换分支栏不改变目标。 */
  const [stashRoot, setStashRoot] = useState<string | null>(null);
  const [shelfDialog, setShelfDialog] = useState(false);
  const [shelfName, setShelfName] = useState("");
  /** unshelve 有冲突时的一条内联提示；下次动作或关闭清掉。 */
  const [shelfNotice, setShelfNotice] = useState<string | null>(null);
  /** 待搁置的文件相对路径；null 表示工具栏按钮（存全部变更）。 */
  const [shelfPaths, setShelfPaths] = useState<string[] | null>(null);
  /** 搁置对话框的来源仓库，在等待输入时保持不变。 */
  const [shelfRoot, setShelfRoot] = useState<string | null>(null);
  const [stashMessage, setStashMessage] = useState("");
  const [stashUntracked, setStashUntracked] = useState(true);
  const generationIdRef = useRef<string | null>(null);

  // 当前正在执行的动作
  const [committingAction, setCommittingAction] = useState<"commit" | "commitAndPush" | null>(null);
  /** 提交前检查也持锁，避免 await 期间连续点击启动多批提交。 */
  const commitLock = useRef(false);
  /** 卸载后取消尚未执行的仓库提交和界面回调。 */
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  /** 每个仓库独立记录结果，部分失败时保留失败项和说明。 */
  const [commitResults, setCommitResults] = useState<ReadonlyMap<string, boolean>>(new Map());
  /** 关掉非模态提交后，提交区改成对话框，由「提交」或 Ctrl+K 打开。 */
  const [commitDialog, setCommitDialog] = useState(false);
  const pendingCaret = useRef<number | null>(null);
  /** 模态提交刚打开时，下一帧再选中说明文字。 */
  const selectAfterOpen = useRef(false);
  const commitDialogRef = useRef(false);
  commitDialogRef.current = commitDialog;

  useEffect(() => {
    if (vcs.nonModalCommit) setCommitDialog(false);
  }, [vcs.nonModalCommit]);

  // 聚焦信号：非模态直接进说明框；模态先打开对话框，下一帧再聚焦。
  useEffect(() => {
    if (focusSignal <= 0) return;
    onViewChange("commit");
    if (!vcs.nonModalCommit) {
      setCommitCollapsed(false);
      setCommitDialog(true);
      return;
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal, vcs.nonModalCommit]);

  useEffect(() => {
    if (!commitDialog) return;
    const select = selectAfterOpen.current;
    selectAfterOpen.current = false;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      if (select) inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [commitDialog]);

  useEffect(() => {
    const caret = pendingCaret.current;
    if (caret == null || !inputRef.current) return;
    pendingCaret.current = null;
    const bounded = Math.min(caret, inputRef.current.value.length);
    inputRef.current.setSelectionRange(bounded, bounded);
  }, [message]);

  // 日志里「编辑提交消息」：模态时先打开对话框，再把 HEAD 摊进说明框。
  useEffect(() => {
    if (rewordSignal <= 0) return;
    onViewChange("commit");
    if (!vcs.nonModalCommit) {
      setCommitCollapsed(false);
      if (commitDialogRef.current) {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        selectAfterOpen.current = true;
        setCommitDialog(true);
      }
    } else {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    if (!amend) switchAmend(true);
  }, [rewordSignal]);

  // 取消 AI 生成
  const handleCancelAiCommit = () => {
    if (generationIdRef.current) {
      void cancelAiCommit(generationIdRef.current);
      generationIdRef.current = null;
    }
    setIsGenerating(false);
  };

  useEffect(() => {
    if (!aiCommitEnabled) {
      setAiError(null);
      if (generationIdRef.current) {
        void cancelAiCommit(generationIdRef.current);
        generationIdRef.current = null;
        setIsGenerating(false);
      }
    }
  }, [aiCommitEnabled]);

  // 修正上次提交切换
  const switchAmend = (on: boolean) => {
    const seq = (amendSeq.current += 1);
    if (!on) {
      setMessage(messageBeforeAmend.current);
      setAmendDetail(null);
      setAmend(false);
      setAmendRoot(null);
      return;
    }
    if (repositoryPlans.length > 1) return;
    /** 有勾选时使用勾选仓库；纯改说明时使用分支栏的目标仓库。 */
    const root = repositoryPlans[0]?.root ?? git.root;
    if (!root) return;
    messageBeforeAmend.current = message;
    setAmend(true);
    setAmendRoot(root);
    void gitLog(root, { limit: 1 }).then((commits) => commits[0] ? gitCommitDetail(root, commits[0].hash) : null)
      .then((detail) => {
        if (seq !== amendSeq.current || !detail) return;
        setAmendDetail(detail);
        setMessage(detail.body ? `${detail.subject}\n\n${detail.body}` : detail.subject);
      })
      .catch(() => {
        if (seq === amendSeq.current) setAmendDetail(null);
      });
  };

  /** 全部仓库快照；单仓库调用也使用同一提交模型。 */
  const repositories = useMemo(() => git.repositoryStates ?? (git.root
    ? [{ root: git.root, status: git.status, probe: git.probe, error: null }] : []),
  [git.repositoryStates, git.root, git.status, git.probe]);
  /** 文件身份由来源根和相对路径组成，两个 README.md 互不覆盖。 */
  const rawChanges = useMemo(() => repositories.flatMap((repo) =>
    (repo.status?.changes ?? EMPTY_CHANGES).map((change) => ({ ...change, repoRoot: repo.root }))), [repositories]);

  // 清除失效文件的勾选记录（键带侧前缀 `s:`/`w:`，截掉前两字符才是路径）
  useEffect(() => {
    /** 两侧键均按仓库隔离。 */
    const live = new Set(rawChanges.flatMap((c) => [checkKey("staged", c.path, c.repoRoot), checkKey("worktree", c.path, c.repoRoot)]));
    setChecks((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const k of next.keys()) {
        if (!live.has(k)) {
          next.delete(k);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rawChanges]);

  // 构建变更树（git 暂存区那套分组：已暂存 / 未暂存分开摆，部分暂存两边各一条）
  const treeRoots = useMemo(() => {
    if (repositories.length < 2 && !groupByModule) return buildChangeTree(rawChanges, groupByDir);
    return buildRepositoryChangeTree(repositories.map((repo) => ({ root: repo.root,
      label: relativePathFrom(workspaceRoot, repo.root) || basenameOf(repo.root), changes: repo.status?.changes ?? [] })), groupByDir);
  }, [rawChanges, repositories, groupByDir, groupByModule, workspaceRoot]);

  // 扁平化映射表与父级索引
  const [nodesByKey, parentKeyMap] = useMemo(() => {
    const byKey = new Map<string, ChangeNode>();
    const parents = new Map<string, string>();
    const walk = (nodes: ChangeNode[], parent?: string) => {
      for (const n of nodes) {
        byKey.set(n.key, n);
        if (parent) parents.set(n.key, parent);
        if (n.children) walk(n.children, n.key);
      }
    };
    walk(treeRoots);
    return [byKey, parents] as const;
  }, [treeRoots]);

  // 计算提交计划（纳入提交的文件）
  const plan = useMemo(() => planCommit(rawChanges, checks), [rawChanges, checks]);
  const includedCount = plan.included.length;
  /** 每个请求只有一个根和该根下勾选的文件，空仓库不进入提交批次。 */
  const repositoryPlans = useMemo(() => repositories.map((repo) => ({ ...repo,
    plan: planCommit(rawChanges.filter((change) => change.repoRoot === repo.root), checks),
  })).filter((repo) => repo.plan.included.length > 0 || amend && repo.root === amendRoot), [repositories, rawChanges, checks, amend, amendRoot]);

  // 切换节点的勾选状态：写入哪一侧由节点所在组决定，两组各管各的那一半
  const toggleCheck = useCallback((nodes: ChangeNode[]) => {
    const first = nodes[0];
    if (!first) return;
    const side: ChangeSide = first.group === "staged" ? "staged" : "worktree";
    const targets = filesOf(nodes);
    if (targets.length === 0) return;
    setChecks((prev) => {
      if (first.type === "repository") {
        /** 仓库勾选涵盖两侧，取消时不能遗留已暂存文件。 */
        const selected = aggregateRepositoryCheck(targets, prev).checked;
        /** 仓库级勾选只处理无冲突文件。 */
        const eligible = targets.filter((file) => !file.conflicted);
        /** 文件级默认行为保留，仓库全选明确包含未跟踪文件。 */
        const next = new Map(prev);
        for (const file of eligible) {
          next.set(checkKey("staged", file.path, file.repoRoot), !selected);
          next.set(checkKey("worktree", file.path, file.repoRoot), !selected);
        }
        return next;
      }
      const agg = aggregateCheck(targets, side, prev);
      // 全勾点一下全清空，其余（含横线）一律全勾上
      const turnOn = !agg.checked;
      const next = new Map(prev);
      for (const f of targets) {
        next.set(checkKey(side, f.path, f.repoRoot), turnOn);
      }
      return next;
    });
  }, []);

  // 切换折叠状态
  const toggleCollapse = useCallback((key: string) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // 全部展开
  const expandAll = useCallback(() => {
    setCollapsedNodes(new Set());
  }, []);

  // 全部折叠
  const collapseAll = useCallback(() => {
    const nonFiles = [...nodesByKey.values()]
      .filter((n) => n.type !== "file")
      .map((n) => n.key);
    setCollapsedNodes(new Set(nonFiles));
  }, [nodesByKey]);

  // 定位当前打开的文件
  const selectOpenedFile = useCallback(() => {
    // 展开所有祖先
    const targetFile = rawChanges[0];
    if (!targetFile) return;
    const node = [...nodesByKey.values()].find((n) => n.type === "file" && n.path === targetFile.path);
    if (!node) return;
    const ancestors: string[] = [];
    for (let k = parentKeyMap.get(node.key); k; k = parentKeyMap.get(k)) {
      ancestors.push(k);
    }
    setCollapsedNodes((prev) => new Set([...prev].filter((k) => !ancestors.includes(k))));
    setSelectedKeys(new Set([node.key]));
  }, [rawChanges, nodesByKey, parentKeyMap]);

  // 双击动作
  const openByDoubleClick = (change: GitChange, isStaged: boolean, siblings: GitChange[]) => {
    if (showOnDoubleClick === "source") onOpenSource(change);
    else onOpenChange(change, isStaged, siblings);
  };

  /**
   * 将仓库相对路径解析到明确的来源根。
   * @param relative - 仓库相对路径
   * @param root - 来源仓库，单仓库入口默认使用活动根
   * @returns 文件绝对路径
   */
  const absolute = useCallback((relative: string, root = git.root) => root ? joinPath(root, relative) : relative, [git.root]);
  /**
   * 修改选中文件的索引，每个仓库分别发出请求。
   * @param files - 带仓库归属的文件
   * @param unstage - true 时取消暂存
   * @returns 所有仓库操作结束，错误由状态层报告
   */
  const changeIndex = async (files: GitChange[], unstage = false) => {
    for (const repo of repositories) {
      /** 只传该仓库的路径。 */
      const paths = files.filter((file) => file.repoRoot === repo.root).map((file) => file.path);
      if (paths.length) await git.runRepository(repo.root, () => unstage ? gitUnstage(repo.root, paths) : gitStage(repo.root, paths));
    }
  };

  // 变更列表弹窗状态（新建 / 编辑 / 移动到其他列表 / 删除确认）
  const [clDialog, setClDialog] = useState<
    | { mode: "new" }
    | { mode: "edit"; id: string; name: string; comment: string; active: boolean }
    | { mode: "move"; paths: string[] }
    | { mode: "delete"; id: string; name: string; count: number }
    | null
  >(null);

  // 变更列表持久化与状态更新
  const updateChangelists = useCallback(
    (next: ChangelistsState) => {
      setChangelists(next);
      saveChangelists(workspaceRoot, next);
    },
    [workspaceRoot]
  );

  const handleNewChangelist = useCallback(
    (name: string, comment = "", makeActive = false) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const id = newChangelistId();
      const next: ChangelistsState = {
        ...changelists,
        lists: [...changelists.lists, { id, name: trimmed, comment: comment.trim() }],
        activeId: makeActive ? id : changelists.activeId,
      };
      updateChangelists(next);
    },
    [changelists, updateChangelists]
  );

  const handleEditChangelist = useCallback(
    (id: string, name: string, comment: string, makeActive: boolean) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const next: ChangelistsState = {
        ...changelists,
        lists: changelists.lists.map((l) =>
          l.id === id ? { ...l, name: trimmed, comment: comment.trim() } : l
        ),
        activeId: makeActive ? id : changelists.activeId,
      };
      updateChangelists(next);
    },
    [changelists, updateChangelists]
  );

  const handleDeleteChangelist = useCallback(
    (id: string) => {
      const newMoves = { ...changelists.moves };
      for (const [p, lId] of Object.entries(newMoves)) {
        if (lId === id) delete newMoves[p];
      }
      const next: ChangelistsState = {
        ...changelists,
        lists: changelists.lists.filter((l) => l.id !== id),
        moves: newMoves,
        activeId: changelists.activeId === id ? DEFAULT_LIST_ID : changelists.activeId,
      };
      updateChangelists(next);
    },
    [changelists, updateChangelists]
  );

  const handleMoveToChangelist = useCallback(
    (paths: string[], targetListId: string) => {
      const next = moveTo(changelists, paths, targetListId);
      updateChangelists(next);
    },
    [changelists, updateChangelists]
  );

  // 搁置所选改动（通过暂存并复制补丁至剪贴板）
  // 搁置选中文件：只负责开对话框记下路径，真正的存补丁在确认后走 git.shelve。
  const handleShelveFiles = useCallback(
    (files: GitChange[]) => {
      if (!files[0]?.repoRoot || files.some((file) => file.repoRoot !== files[0]?.repoRoot)) return;
      setShelfRoot(files[0].repoRoot);
      setShelfPaths(files.map((f) => f.path));
      setShelfName("");
      setShelfNotice(null);
      setShelfDialog(true);
    },
    [git.root]
  );

  // 创建补丁文件并按设置分流处理。
  const handleCreatePatchFiles = useCallback(
    async (files: GitChange[]) => {
      /** 标准补丁的相对路径只允许来自一个仓库。 */
      const root = files[0]?.repoRoot;
      if (!root || files.some((file) => file.repoRoot !== root)) return;
      try {
        const diffs: string[] = [];
        for (const f of files) {
          const text = await gitDiffText(root, "HEAD", "", absolute(f.path, root));
          if (text) diffs.push(text);
        }
        if (diffs.length === 0) return;
        const patchContent = diffs.join("\n\n");

        if (vcs.onPatchCreated === "file" || vcs.onPatchCreated === "open") {
          // 在项目工作区生成标准 patch 文件
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const patchName = `patch-${timestamp}.patch`;
          const patchPath = `${root.replace(/[\\/]+$/, "")}/${patchName}`;
          await writeFile(patchPath, patchContent, "lf", false);

          if (vcs.onPatchCreated === "file") {
            // 在系统文件管理器中高亮定位该补丁
            await revealEntry(patchPath);
          } else {
            // 在编辑器中打开该补丁源码
            onOpenFile(patchPath);
          }
        } else {
          // 默认写入系统剪贴板 (clipboard)
          await navigator.clipboard.writeText(patchContent);
        }
      } catch (err) {
        console.error("Create patch failed:", err);
      }
    },
    [absolute, git, vcs.onPatchCreated, onFileAction]
  );

  // 右键菜单唤起
  const openContextMenu = (event: ReactMouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  /** 单条贮藏的右键菜单；与行尾那四个图标走同一套动作。 */
  const stashMenu = (entry: { index: number; message: string }): MenuItem[] => [
    { label: t("git.stashApply"), icon: ArrowDownToLine, onSelect: () => void git.stashApply(entry.index, false) },
    { label: t("git.stashPop"), icon: ArrowUpFromLine, onSelect: () => void git.stashApply(entry.index, true) },
    { label: t("git.stashBranch"), icon: GitBranchPlus, onSelect: () => stashToBranch(entry.index) },
    { separator: true },
    { label: t("git.stashDrop"), icon: "trash", danger: true, onSelect: () => setStashToDrop(entry) },
  ];

  /** 从某条贮藏切出新分支并恢复；用户取消或留空则什么都不做。 */
  const stashToBranch = (index: number) => {
    const name = window.prompt(t("git.stashBranchPrompt"));
    if (name && name.trim()) void git.stashBranch(index, name.trim());
  };

  /** 真正执行丢弃；二次确认框确认后才会走到这里。 */
  const confirmStashDrop = () => {
    if (!stashToDrop) return;
    void git.stashDrop(stashToDrop.index);
    setStashToDrop(null);
  };

  /**
   * 变更文件与目录节点右键菜单。
   */
  const getNodeMenu = (node: ChangeNode): MenuItem[] => {
    const files = filesOf([node]);
    /** 当前节点内的仓库相对路径，用于复制路径菜单。 */
    const paths = files.map((file) => file.path);
    const firstChange = files[0];
    /** 目录和分组操作使用节点来源，不能沿用分支栏的活动仓库。 */
    const root = node.repoRoot ?? firstChange?.repoRoot ?? git.root;
    // 比对方向跟组走：已暂存组看 HEAD↔索引，未暂存组看索引↔工作区（部分暂存文件两边各一条）。
    const itemStaged = node.group === "staged";
    const isDeleted = firstChange
      ? firstChange.indexStatus === "D" || firstChange.workStatus === "D"
      : false;
    const untracked = files.filter((f) => f.untracked);
    const conflicted = files.filter((f) => f.conflicted);

    const items: MenuItem[] = [];

    // 1. 差异比较与源码跳转
    if (firstChange) {
      items.push({
        label: t("log.diffShow") ?? "Show Diff",
        icon: FileDiff,
        shortcut: "Ctrl+D",
        onSelect: () => onOpenChange(firstChange, itemStaged, rawChanges),
      });
      items.push({
        label: t("diff.jumpToSource") ?? "Jump to Source",
        icon: ExternalLink,
        shortcut: "F4",
        disabled: !firstChange.path || isDeleted,
        onSelect: () => onFileAction("editSource", firstChange.path, itemStaged, false, root ?? undefined),
      });
      items.push({
        label: t("menu.open") ?? "Open",
        icon: FolderOpen,
        disabled: !firstChange.path || isDeleted,
        onSelect: () => onOpenFile(absolute(firstChange.path, root)),
      });
      items.push({ separator: true });
    }

    // 2. 冲突解决
    if (node.group === "conflicts" || conflicted.length > 0) {
      items.push({
        label: `${t("git.resolveConflicts") ?? "Resolve Conflicts"}…`,
        icon: GitMerge,
        onSelect: () => onOpenResolve(root ?? undefined),
      });
      items.push({ separator: true });
    }

    // 3. 版本回滚 (Ctrl+Alt+Z)
    items.push({
      label: `${t("git.rollback") ?? "Rollback"}…`,
      icon: Undo2,
      shortcut: "Ctrl+Alt+Z",
      onSelect: () => onFileAction("rollback", node.path ?? "", itemStaged, node.type !== "file", root ?? undefined),
    });

    // 4. 加入版本控制 (未跟踪文件专用)
    if (untracked.length > 0) {
      items.push({
        label: t("git.addVcs") ?? "Add to VCS",
        icon: Plus,
        onSelect: () => void changeIndex(untracked),
      });
    }

    // 5. 暂存与取消暂存：可用性跟组走，避免部分暂存文件在未暂存组被错禁 Stage
    items.push({
      label: t("git.stage") ?? "Stage",
      icon: Plus,
      disabled: node.group === "staged",
      onSelect: () => void changeIndex(files),
    });
    items.push({
      label: t("git.unstage") ?? "Unstage",
      icon: Minus,
      disabled: node.group !== "staged" && !files.some((f) => isStaged(f)),
      onSelect: () => void changeIndex(files, true),
    });

    // 6. 移动到其他变更列表 (Alt+Shift+M)
    if (node.group === "staged" || node.group === "unstaged") {
      items.push({ separator: true });
      items.push({
        label: `${t("git.moveToList") ?? "Move to Another Changelist"}…`,
        icon: ArrowRightLeft,
        shortcut: "Alt+Shift+M",
        onSelect: () => setClDialog({ mode: "move", paths: files.map((file) => JSON.stringify([file.repoRoot, file.path])) }),
      });
    }

    // 7. 搁置与创建补丁
    items.push({
      label: `${t("git.shelve") ?? "Shelve Changes"}…`,
      icon: ArrowDownToLine,
      onSelect: () => void handleShelveFiles(files),
    });
    items.push({
      label: `${t("git.patchToClipboard") ?? "Create Patch"}…`,
      icon: ClipboardCopy,
      onSelect: () => void handleCreatePatchFiles(files),
    });

    // 8. 文件历史与 Git Blame 注解追溯
    if (firstChange) {
      items.push({ separator: true });
      items.push({
        label: t("git.history") ?? "Show History",
        icon: History,
        disabled: !firstChange.path,
        onSelect: () => onFileAction("history", firstChange.path, itemStaged, node.type === "dir", root ?? undefined),
      });
      items.push({
        label: t("git.annotate") ?? "Annotate with Git Blame",
        icon: Eye,
        disabled: !firstChange.path || isDeleted,
        onSelect: () => onFileAction("editSource", firstChange.path, itemStaged, false, root ?? undefined),
      });
    }

    // 9. 复制路径
    items.push({ separator: true });
    items.push({
      label: t("menu.copyPath") ?? "Copy Path",
      icon: Copy,
      onSelect: () => void navigator.clipboard.writeText(paths.map((path) => absolute(path, root)).join("\n")),
    });

    return items;
  };

  // 生成 AI 提交消息
  const handleGenerateAiCommit = async () => {
    if (isGenerating) {
      handleCancelAiCommit();
      return;
    }
    setAiError(null);
    let config;
    try {
      config = await loadAiCommitConfig();
    } catch {
      setAiError(t("aiCommit.failed"));
      return;
    }

    if (!config.enabled) {
      setAiError(t("aiCommit.AI_COMMIT_DISABLED"));
      return;
    }

    if (!config.providerId) {
      setAiError(t("aiCommit.configureFirst"));
      return;
    }

    // AI 与提交共用文件来源，区分完整工作区和仅未暂存修改。
    /** AI 只读取实际勾选的文件，与提交范围一致。 */
    const targets = plan.included;
    if (targets.length === 0) {
      setAiError(t("aiCommit.noChanges"));
      return;
    }

    setIsGenerating(true);
    const opId = crypto.randomUUID();
    generationIdRef.current = opId;

    try {
      /** 每个仓库独立取 diff，显示路径补仓库前缀以区分同名文件。 */
      const files = (await Promise.all(repositoryPlans.map(async (repo) =>
        (await collectFilesDiff(repo.root, repo.plan.included, repo.plan.selections)).map((file) => ({
          ...file, path: `${relativePathFrom(workspaceRoot, repo.root) || basenameOf(repo.root)}/${file.path}`,
        }))))).flat();
      if (files.length === 0) {
        setAiError(t("aiCommit.AI_COMMIT_EMPTY_DIFF"));
        setIsGenerating(false);
        return;
      }

      const generated = await generateAiCommitMessage({
        operationId: opId,
        files,
      });

      // 以仓库里的说明为准：生成期间面板可能已经卸掉，晚到的结果不能盖掉切回来后新打的字。
      if (!mounted.current || generationIdRef.current !== opId) return;
      if (commitDraft(draftKey).trim().length > 0) {
        setConfirmReplace(generated);
      } else {
        setMessage(generated);
        inputRef.current?.focus();
      }
    } catch (err: unknown) {
      const errStr = err instanceof Error ? err.message : String(err);
      if (errStr !== "AI_COMMIT_CANCELLED") {
        setAiError(formatAiCommitError(err, t));
      }
    } finally {
      if (generationIdRef.current === opId) {
        generationIdRef.current = null;
        setIsGenerating(false);
      }
    }
  };

  /**
   * 对单个已冻结的仓库计划执行检查和提交。
   * @param repo - 来源仓库快照与该仓库的勾选计划
   * @returns 成功时为 true；检查取消、卸载或 IPC 失败时为 false/undefined
   */
  const commitRepository = async (repo: (typeof repositoryPlans)[number]) => {
    /** 检查与写入始终使用同一个根；局部上下文不依赖分支栏。 */
    const root = repo.root;
    /** 本仓库的恢复阶段。 */
    const recovery = recoveryOf(repo.probe);
    /** 勾选文件仅来自该仓库。 */
    const plan = repo.plan;
    /** 检查只读取该仓库的变更。 */
    const rawChanges = repo.status?.changes ?? [];
    /**
     * 解析本批次的仓库相对路径。
     * @param path - 相对路径
     * @returns 来源仓库内的绝对路径
     */
    const absolute = (path: string) => joinPath(root, path);
    const text = message.trim();
    if (!text && !amend) {
      setEmptyError(true);
      inputRef.current?.focus();
      return;
    }

    // 游离 HEAD 或变基中提交。变基进行中 HEAD 不一定显示为游离。
    if (vcs.warnDetachedHead && (recovery === "rebase" || repo.status?.detached || repo.status?.branch === "(detached)")) {
      const confirmed = window.confirm(`${root}\n${t(recovery === "rebase" ? "vcs.warnRebaseConfirm" : "vcs.warnDetachedConfirm")}`);
      if (!confirmed) return;
    }

    // 计算提交目标路径
    /** 空选择绝不扩成整个工作区或整个索引。 */
    const includedPaths = plan.included.map((f) => f.path);
    if (includedPaths.length === 0 && !amend) {
      return;
    }

    // 3. 超大文件安全拦截（warnLargeFiles & largeFilesLimitMb）
    if (vcs.warnLargeFiles && includedPaths.length > 0) {
      const limitBytes = (vcs.largeFilesLimitMb || 50) * 1024 * 1024;
      const oversizedFiles: { path: string; sizeMb: number }[] = [];
      for (const p of includedPaths) {
        try {
          const stamp = await fileStamp(absolute(p));
          if (stamp && stamp.size > limitBytes) {
            oversizedFiles.push({ path: p, sizeMb: +(stamp.size / (1024 * 1024)).toFixed(1) });
          }
        } catch {
          // 忽略已删除文件等 stat 异常
        }
      }
      if (oversizedFiles.length > 0) {
        const fileList = oversizedFiles.map((f) => `• ${f.path} (${f.sizeMb} MB)`).join("\n");
        const confirmed = window.confirm(
          `警告：检测到待提交变动中包含超大文件（阈值 ${vcs.largeFilesLimitMb} MB）：\n${fileList}\n\n提交大文件可能导致 Git 仓库急剧膨胀。确定继续提交吗？`
        );
        if (!confirmed) return;
      }
    }

    // 4. 提交前检查：扫描待提交文件中的 TODO/FIXME（checkTodo）
    const shouldCheckTodo = commitOptions.checkTodo || vcs.checkTodo;
    if (shouldCheckTodo && includedPaths.length > 0) {
      const filesWithTodo: string[] = [];
      try {
        // 一次拿整份 diff 再在内存里按文件切分：逐文件起 `git diff` 子进程，勾几十个文件
        // 就是几十个进程排队（Windows 上每个几十毫秒，大提交点下去要干等好几秒）。
        const diff = await gitDiffText(root, "HEAD", "", "");
        const wanted = new Set(includedPaths);
        let current: string | null = null;
        for (const line of diff.split("\n")) {
          if (line.startsWith("+++ ")) {
            // `+++ b/<相对路径>`；删除文件是 `+++ /dev/null`，那种块里不会有新增行。
            current = line.startsWith("+++ b/") ? line.slice(6) : null;
            continue;
          }
          if (!current || !line.startsWith("+") || !/\b(TODO|FIXME)\b/i.test(line)) continue;
          if (wanted.has(current) && !filesWithTodo.includes(current)) filesWithTodo.push(current);
        }
      } catch {
        // 拿不到整份 diff 时跳过这项检查，不阻断提交。
      }
      if (filesWithTodo.length > 0) {
        const confirmed = window.confirm(
          `提交前检查：在待提交文件的变更中检测到新增的 TODO / FIXME 标记：\n${filesWithTodo.map((p) => `• ${p}`).join("\n")}\n\n是否仍要继续提交？`
        );
        if (!confirmed) return;
      }
    }

    // CRLF：只有 core.autocrlf 不会替这次提交转换时才警告。
    if (vcs.warnCrlf && includedPaths.length > 0) {
      const autocrlf = (await gitConfigGet(root, "core.autocrlf").catch(() => "")).toLowerCase();
      if (autocrlf !== "true" && autocrlf !== "input") {
        const crlf: string[] = [];
        for (const path of includedPaths) {
          try {
            const file = await readFile(absolute(path));
            if (file.contents.includes("\r\n")) crlf.push(path);
          } catch {
            // 已删除或读不出文本的文件跳过。
          }
        }
        if (crlf.length > 0) {
          const confirmed = window.confirm(t("vcs.warnCrlfConfirm", { files: crlf.map((path) => `• ${path}`).join("\n") }));
          if (!confirmed) return;
        }
      }
    }

    // 只检查这次新加的路径，并同时拦 Windows 保留名与非法字符。
    if (vcs.warnBadFileNames && includedPaths.length > 0) {
      const byPath = new Map(rawChanges.map((change) => [change.path, change]));
      const added = includedPaths.filter((path) => isNewCommitPath(byPath.get(path)));
      const bad = badCommitNames(added);
      const warn = async (key: "vcs.warnReservedConfirm" | "vcs.warnBadCharConfirm", files: string[]) => {
        if (files.length === 0) return true;
        return window.confirm(t(key, { files: files.map((path) => `• ${path}`).join("\n") }));
      };
      if (!(await warn("vcs.warnReservedConfirm", bad.reserved))) return;
      if (!(await warn("vcs.warnBadCharConfirm", bad.invalid))) return;
    }

    // 6. Sign-off、作者与跳过 hooks 交给 Git 参数；提交说明按 Git 配置处理。
    const commitText = text;
    const commitOpts = {
      signoff: commitOptions.signOff || vcs.signOffCommit,
      author: commitOptions.author,
      noVerify: !commitOptions.runHooks,
      selections: plan.selections,
    };
    if (!mounted.current) return false;
    await gitCommit(root, commitText, amend, undefined, commitOpts);
    return true;
  };

  /**
   * 按仓库分别执行当前勾选，部分失败不清空草稿或重复提交成功项。
   * @param andPush - 全部提交成功后是否进入推送流程
   * @returns 提交批次结束；空选择、忙碌或冲突时不执行
   */
  const executeCommit = async (andPush: boolean) => {
    if (commitLock.current || repositoryPlans.length === 0 || isGenerating) return;
    if (!message.trim() && !amend) { setEmptyError(true); inputRef.current?.focus(); return; }
    if (amend && (repositoryPlans.length !== 1 || repositoryPlans[0]?.root !== amendRoot)) return;
    if (repositoryPlans.some((repo) => !repo.status || repo.error || repo.status.changes.some((change) => change.conflicted))) return;
    commitLock.current = true;
    setCommittingAction(andPush ? "commitAndPush" : "commit");
    /** 固定请求清单，子模块先于包含它的父仓库提交。 */
    const batch = [...repositoryPlans].sort((a, b) => b.root.split(/[\\/]/).length - a.root.split(/[\\/]/).length);
    /** 每个仓库分别记录结果，失败不抹掉成功。 */
    const results = new Map<string, boolean>();
    try {
      for (const repo of batch) {
        if (!mounted.current) break;
        /** 单个仓库的成功状态。 */
        const done = await git.runRepository(repo.root, () => commitRepository(repo)) === true;
        results.set(repo.root, done);
        if (!mounted.current) break;
        setCommitResults(new Map(results));
        if (done) setChecks((current) => {
          /** 成功文件从待提交选择移除，失败仓库保留原选择。 */
          const next = new Map(current);
          for (const file of repo.plan.included) {
            next.set(checkKey("staged", file.path, repo.root), false);
            next.set(checkKey("worktree", file.path, repo.root), false);
          }
          return next;
        });
      }
      if (!mounted.current || results.size !== batch.length || [...results.values()].some((done) => !done)) return;
      amendSeq.current += 1;
      messageBeforeAmend.current = "";
      onCommitted(message.trim());
      if (vcs.clearInitialCommitMessage !== false && commitDraft(draftKey) === message) {
        setMessage("");
      }
      if (!vcs.nonModalCommit) setCommitDialog(false);
      setAmend(false);
      setAmendRoot(null);
      setAmendDetail(null);
      setEmptyError(false);
      // 提交已落盘后清理说明；取消或失败的推送不会撤销这次提交。
      if (andPush) for (const repo of batch) onPush(repo.root, repo.status?.branch ?? "");
    } finally {
      commitLock.current = false;
      if (mounted.current) setCommittingAction(null);
    }
  };

  /**
   * 这三个回调每次渲染都是一份新函数（内部引用整份 Git 状态与菜单表）。树的缓存一旦把
   * 它们列进依赖就永远命中不了，等于没做缓存——所以用 ref 取最新一份：
   * 树元只在事件回调里调用它们，取值时机晚于渲染，不影响正确性。
   */
  const openContextMenuRef = useRef(openContextMenu);
  openContextMenuRef.current = openContextMenu;
  const getNodeMenuRef = useRef(getNodeMenu);
  getNodeMenuRef.current = getNodeMenu;
  const openByDoubleClickRef = useRef(openByDoubleClick);
  openByDoubleClickRef.current = openByDoubleClick;

  // 渲染单行树节点：保留目录聚合圆点与行尾状态字母
  const renderRow = useCallback(function renderRows(node: ChangeNode, depth: number) {
    const isGroup = node.type === "group";
    const isDir = node.type === "dir";
    const isFile = node.type === "file";
    const isCollapsed = collapsedNodes.has(node.key);
    // 复选框只看本侧：已暂存组与未暂存组各自的勾选互不相干
    /** 仓库行汇总全部可提交文件，其它行保持索引与工作区两侧独立。 */
    const agg = node.type === "repository" ? aggregateRepositoryCheck(node.files, checks)
      : aggregateCheck(node.files, node.group === "staged" ? "staged" : "worktree", checks);
    /** 本节点的来源根，单仓库树的文件仍自带根。 */
    const nodeRoot = node.repoRoot ?? node.files[0]?.repoRoot ?? git.root;

    // 缩进：每层 18px
    const paddingLeft = 4 + depth * 18;
    const isSelected = selectedKeys.has(node.key);
    const displayLabel = isGroup
      ? node.group === "conflicts"
        ? t("git.unmerged")
        : node.group === "staged"
        ? t("git.staged")
        : node.group === "unstaged"
        ? t("git.changes")
        : t("git.untracked")
      : node.label;

    return (
      <div key={node.key}>
        <div
          className={clsx(
            styles.nodeRow,
            "change-row",
            isSelected && styles.isSelected,
            isGroup && styles.groupLabel
          )}
          style={{ paddingLeft }}
          onClick={() => {
            setSelectedKeys(new Set([node.key]));
            if (!isFile) {
              // 点击文件夹行才展开或收缩
              toggleCollapse(node.key);
            } else if (node.files[0]) {
              // 点击文件打开差异对比：方向跟组走，已暂存组比 HEAD↔索引，未暂存组比索引↔工作区
              onOpenChange(node.files[0], node.group === "staged", rawChanges);
            }
          }}
          onContextMenu={(e) => {
            openContextMenuRef.current(e, getNodeMenuRef.current(node));
          }}
        >
          {/* 折叠箭头 */}
          {!isFile ? (
            <button
              type="button"
              className="tree-chevron"
              style={{
                width: 16,
                height: 16,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: "none",
                border: "none",
                padding: 0,
                color: "var(--fg-subtle, var(--text-muted))",
                cursor: "pointer",
              }}
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapse(node.key);
              }}
            >
              {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </button>
          ) : (
            <span style={{ width: 16, flex: "none" }} />
          )}

          {/* 14px 三态复选框 */}
          <CheckMark
            checked={agg.checked}
            indeterminate={agg.indeterminate}
            label={`${t("git.includeInCommit")} ${nodeRoot ?? ""} ${node.path ?? node.label}`}
            onToggle={() => toggleCheck([node])}
          />

          {/* 图标：ExpUI 官方矢量文件夹与文件图标体系 */}
          {isGroup ? null : isDir || node.type === "repository" ? (
            <span className={styles.icon}>
              <EntryIcon
                name={node.label}
                path={absolute(node.path ?? "", nodeRoot)}
                isDirectory
                isPackage={isUnderJvmSourceRoot(absolute(node.path ?? "", nodeRoot))}
                size={14}
              />
            </span>
          ) : (
            <span className={styles.icon}>
              <EntryIcon name={node.label} path={absolute(node.path ?? "", nodeRoot)} size={14} />
            </span>
          )}

          {/* 节点文本 */}
          <span
            className={clsx(
              styles.label,
              isGroup && styles.groupLabel,
              node.isDeleted && styles.isDeleted,
              node.mark && markClass(node.mark)
            )}
            title={node.path ?? displayLabel}
            onDoubleClick={() => {
              if (isFile && node.files[0]) {
                openByDoubleClickRef.current(node.files[0], node.group === "staged", rawChanges);
              }
            }}
          >
            {displayLabel}
          </span>

          {/* 组计数 */}
          {(isGroup || node.type === "repository") && (
            <span className={styles.detail}>
              {t("git.fileCount", { count: node.files.length })}
            </span>
          )}

          {/* 部分暂存 partial 徽标 */}
          {isFile && node.files[0] && isPartiallyStaged(node.files[0]) && (
            <span className={styles.partial} title={t("git.partiallyStaged")}>
              partial
            </span>
          )}

          {/* 就地暂存/取消暂存：方向跟组走——未暂存（含未版本控制）加号、已暂存减号；
              组行作用整组、目录行作用整棵子树、文件行只管自己。悬停该行才显。
              冲突行保留隐形占位但禁点，带冲突标记进索引等于把冲突藏起来。 */}
          {(() => {
            const stageHere = node.group !== "conflicts" && node.files.length > 0;
            const isStagedGroup = node.group === "staged";
            return (
              <button
                type="button"
                className={styles.stageAction}
                disabled={!stageHere}
                title={
                  stageHere
                    ? (t(isStagedGroup ? "git.unstage" : "git.stage") ?? undefined)
                    : undefined
                }
                aria-label={
                  stageHere
                    ? (t(isStagedGroup ? "git.unstage" : "git.stage") ?? undefined)
                    : undefined
                }
                onClick={(e) => {
                  e.stopPropagation();
                  if (!stageHere) return;
                  void changeIndex(node.files, isStagedGroup);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                {isStagedGroup ? <Minus size={13} /> : <Plus size={13} />}
              </button>
            );
          })()}

          {/* 状态槽：字母 / 目录聚合圆点 / 空占位，统一 16px 宽，
              保证暂存图标列与状态列在文件行、目录行、组标题行落在同一条竖线上 */}
          {isFile && node.mark ? (
            <span
              className={clsx(styles.changeMark, `change-mark ${markClass(node.mark)}`)}
            >
              {node.mark}
            </span>
          ) : isDir && node.dirMark ? (
            <span
              className={clsx(styles.changeDot, markClass(node.dirMark))}
              aria-hidden="true"
            />
          ) : (
            <span className={styles.markSlot} aria-hidden="true" />
          )}
        </div>

        {/* 展开子节点 */}
        {!isCollapsed &&
          node.children &&
          node.children.map((child) => renderRows(child, depth + 1))}
      </div>
    );
    // 依赖只列树本身读到的东西：`message`、拖拽高度这类与树无关的状态变化不该重建整棵树。
  }, [collapsedNodes, checks, selectedKeys, t, rawChanges, toggleCheck, toggleCollapse, absolute, onOpenChange, git]);

  /**
   * 整棵树的元素数组缓存。提交说明框每敲一个字符都会重渲染 GitPanel，没有这层缓存
   * 就得对几百个节点重跑一遍 renderRow（每行还要拼绝对路径、建一整套闭包）。
   */
  const treeRows = useMemo(
    () => treeRoots.map((rootNode) => renderRow(rootNode, 0)),
    [treeRoots, renderRow]
  );

  // 空态检查
  if (repositories.length === 0 && !git.probe?.available) {
    return <p className="panel-note">{t("git.notInstalled")}</p>;
  }
  if (repositories.length === 0) {
    return (
      <div className="panel-note">
        <p>{t("git.notARepo")}</p>
        <p className="panel-note-sub" title={workspaceRoot}>
          {workspaceRoot}
        </p>
      </div>
    );
  }

  const recovery = git.recovery;
  const canCommit =
    (includedCount > 0 || amend) &&
    (!amend || repositoryPlans.length === 1 && repositoryPlans[0]?.root === amendRoot) &&
    !repositoryPlans.some((repo) => repo.error || !repo.status || repo.status.changes.some((change) => change.conflicted)) &&
    committingAction === null &&
    git.operation?.phase !== "running" &&
    !isGenerating;

  void repoName;
  void onUnignore;
  void onOpenCommitFile;
  /** 工具栏根据树中选中行确定目标，多仓库时不暗用分支栏仓库。 */
  const selectedNodes = [...selectedKeys].map((key) => nodesByKey.get(key)).filter((node): node is ChangeNode => !!node);
  /** 唯一选中节点用于回滚，避免把选中文件扩大为整个仓库。 */
  const toolbarNode = selectedNodes.length === 1 ? selectedNodes[0] : undefined;
  /** 单仓库可直接操作，多仓库必须有明确的树节点上下文。 */
  const toolbarRoot = toolbarNode?.repoRoot ?? toolbarNode?.files[0]?.repoRoot ?? (repositories.length === 1 ? repositories[0]?.root : undefined);
  /** 工具栏目标仓库的当前状态。 */
  const toolbarRepository = repositories.find((repo) => repo.root === toolbarRoot);

  return (
    <div className={clsx(styles.root, "git-panel")}>
      {repositories.filter((repo) => repo.error).map((repo) => <p key={repo.root} className="panel-note" role="alert">{repo.root}: {repo.error}</p>)}
      {[...commitResults].map(([root, success]) => <p key={root} className="panel-note" role="status">{relativePathFrom(workspaceRoot, root) || basenameOf(root)} · {t(success ? "git.commitSucceeded" : "git.commitFailed")}</p>)}
      {/* 视图选项弹层 */}
      <Popover anchor={viewAnchor} onClose={() => setViewAnchor(null)} minWidth={230}>
        <p className="popover-label">{t("git.groupBy")}</p>
        {[
          { key: "dir", label: t("git.groupDir"), accel: `${MOD_LABEL}+Alt+P`, on: groupByDir, flip: onToggleByDir },
          { key: "module", label: t("git.groupModule"), accel: `${MOD_LABEL}+Alt+M`, on: groupByModule, flip: onToggleByModule },
        ].map((row) => (
          <button key={row.key} type="button" className="popover-item" onClick={row.flip}>
            {row.on ? <Check size={13} aria-hidden="true" /> : <span className="menu-icon-spacer" />}
            <span className="popover-item-label">{row.label}</span>
            <span className="popover-accel">{row.accel}</span>
          </button>
        ))}
        <div className="popover-sep" />
        <p className="popover-label">{t("git.showSection")}</p>
        <button type="button" className="popover-item" onClick={onToggleIgnored}>
          {showIgnored ? <Check size={13} aria-hidden="true" /> : <span className="menu-icon-spacer" />}
          <span className="popover-item-label">{t("git.showIgnoredFiles")}</span>
        </button>
      </Popover>

      {/* 32px 规范工具栏：只在提交页展示，贮藏页不显示该工具栏 */}
      {view === "commit" && (
        <div className={styles.toolbar} role="toolbar" aria-label={t("git.changes")}>
          <IconButton
            icon="refresh"
            title={t("git.refresh")}
            size="small"
            onClick={() => void git.refresh()}
          />
          <IconButton
            icon="undo"
            title={t("git.rollback")}
            size="small"
            disabled={!toolbarRoot || rawChanges.length === 0}
            onClick={() => onFileAction("rollback", toolbarNode?.path ?? "", toolbarNode?.group === "staged", toolbarNode?.type !== "file", toolbarRoot)}
          />
          <IconButton
            icon="stash"
            title={t("git.stash")}
            size="small"
            disabled={!toolbarRoot || rawChanges.length === 0}
            onClick={() => { setStashRoot(toolbarRoot ?? null); setStashDialog(true); }}
          />
          <IconButton
            icon="archive"
            title={t("git.shelve")}
            size="small"
            disabled={!toolbarRoot || rawChanges.length === 0}
            onClick={() => {
              setShelfRoot(toolbarRoot ?? null);
              setShelfPaths(toolbarNode?.files.map((file) => file.path) ?? null);
              setShelfName("");
              setShelfNotice(null);
              setShelfDialog(true);
            }}
          />
          <IconButton
            icon="git-pull"
            title={t("git.updateProject")}
            size="small"
            disabled={!toolbarRoot || !toolbarRepository?.status?.upstream || !!recoveryOf(toolbarRepository?.probe ?? null)}
            onClick={() => { if (toolbarRoot) onUpdate(toolbarRoot); }}
          />
          <IconButton
            ref={viewRef}
            icon="eye"
            title={t("git.viewOptions")}
            size="small"
            aria-haspopup="menu"
            aria-expanded={viewAnchor !== null}
            onClick={() => setViewAnchor((current) => (current ? null : viewRef.current))}
          />
          <span className={styles.sep} />
          <IconButton
            icon="locate"
            title={t("git.locateOpened")}
            size="small"
            onClick={selectOpenedFile}
          />
          <IconButton
            icon="expand-all"
            title={t("tool.expandAll")}
            size="small"
            disabled={rawChanges.length === 0}
            onClick={expandAll}
          />
          <IconButton
            icon="collapse-all"
            title={t("tool.collapseAll")}
            size="small"
            disabled={rawChanges.length === 0}
            onClick={collapseAll}
          />
          {!vcs.nonModalCommit && (
            <Button size="small" onClick={() => { setCommitCollapsed(false); setCommitDialog(true); }}>
              {t("git.commit")}
            </Button>
          )}
        </div>
      )}

      {/* 恢复状态横幅（变基/合并中间） */}
      {recovery && (
        <div className="conflict-banner" role="status">
          <AlertTriangle size={13} aria-hidden="true" />
          <p>{t(RECOVERY_MESSAGE[recovery])}</p>
          <span className="status-spacer" />
          <button
            type="button"
            className="button is-tiny"
            onClick={() => void git.recoveryContinue()}
          >
            {t("git.continueAction")}
          </button>
          <button
            type="button"
            className="button is-tiny"
            onClick={() => void git.recoveryAbort()}
          >
            {t("git.abortAction")}
          </button>
        </div>
      )}

      {/* 变更树主体 */}
      <div className={styles.changes} hidden={view !== "commit"}>
        <div
          className={styles.treeWrap}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === " " && selectedKeys.size > 0) {
              e.preventDefault();
              const selectedNodes = [...selectedKeys]
                .map((k) => nodesByKey.get(k))
                .filter((n): n is ChangeNode => !!n);
              toggleCheck(selectedNodes);
            }
          }}
        >
          {rawChanges.length === 0 ? (
            <div className={styles.empty}>
              <span>{t("git.clean")}</span>
            </div>
          ) : (
            <div style={{ padding: "4px 0" }}>
              {treeRows}
            </div>
          )}
        </div>
      </div>

      {/* 贮藏页签：列表占满整页高度，四个动作只画图标，文字在 hover 提示里。 */}
      <div className={styles.stashPane} hidden={view !== "stash"}>
        {git.stashes.length > 0 ? (
          <div className={styles.stashList}>
            {git.stashes.map((entry) => (
              <div
                key={entry.index}
                className={styles.stashRow}
                onContextMenu={(event) => openContextMenu(event, stashMenu(entry))}
              >
                <span className={styles.stashMsg} title={entry.message}>
                  {entry.message}
                </span>
                <span className={styles.stashTime} title={new Date(entry.timeMs).toLocaleString()}>
                  {commitStamp(entry.timeMs, locale, t("time.today"), t("time.yesterday"))}
                </span>
                <span className={styles.stashActions}>
                  <IconButton
                    icon="trash"
                    iconSize={13}
                    size="small"
                    className={clsx(styles.stashAction, styles.stashDrop)}
                    title={t("git.stashDrop")}
                    onClick={() => setStashToDrop(entry)}
                  />
                </span>
              </div>
            ))}
          </div>
        ) : git.shelves.length === 0 ? (
          /* 一条都没有才留一行空态；下面接着搁置列表时不抢这句。 */
          <p className={styles.stashEmpty}>{t("git.stashEmpty")}</p>
        ) : null}

        {git.shelves.length > 0 && (
          <div className={styles.stashBox}>
            <div className={styles.stashHead}>
              <span>{t("git.shelfTitle")}</span>
              <span className={styles.stashCount}>{git.shelves.length}</span>
            </div>
            {shelfNotice ? (
              <p className={styles.stashMsg} role="status">
                {shelfNotice}
              </p>
            ) : null}
            <div className={styles.stashList}>
              {git.shelves.map((entry) => (
                <div key={entry.id} className={styles.stashRow}>
                  <span className={styles.stashMsg} title={`${entry.name} · ${entry.files.length}`}>
                    {entry.name}
                  </span>
                  <span className={styles.stashTime} title={new Date(entry.timeMs).toLocaleString()}>
                    {commitStamp(entry.timeMs, locale, t("time.today"), t("time.yesterday"))}
                  </span>
                  <span className={styles.stashActions}>
                    <IconButton
                      icon={ArrowDownToLine}
                      iconSize={13}
                      size="small"
                      className={styles.stashAction}
                      title={t("git.unshelve")}
                      onClick={() => {
                        setShelfNotice(null);
                        void git.unshelve(entry.id, false).then((outcome) => {
                          if (outcome && outcome.conflicts.length > 0) {
                            setShelfNotice(t("git.unshelveConflicts").replace("{n}", String(outcome.conflicts.length)));
                          }
                        });
                      }}
                    />
                    <IconButton
                      icon={Pencil}
                      iconSize={13}
                      size="small"
                      className={styles.stashAction}
                      title={t("git.shelfRename")}
                      onClick={() => {
                        const next = window.prompt(t("git.shelfRename"), entry.name);
                        if (next && next.trim() && next.trim() !== entry.name) {
                          void git.shelfRename(entry.id, next.trim());
                        }
                      }}
                    />
                    <IconButton
                      icon="trash"
                      iconSize={13}
                      size="small"
                      className={clsx(styles.stashAction, styles.stashDrop)}
                      title={t("git.shelfDelete")}
                      onClick={() => {
                        if (window.confirm(t("git.shelfDeleteConfirm"))) {
                          void git.shelfDelete(entry.id);
                        }
                      }}
                    />
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 提交区可拖拽自定义高度分隔条。模态提交时改由对话框承载。 */}
      {view === "commit" && vcs.nonModalCommit && !commitCollapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          className="panel-splitter"
          onPointerDown={(event) => {
            const box = commitBoxRef.current;
            if (!box) return;
            commitDrag.current = { startY: event.clientY, startHeight: box.offsetHeight };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = commitDrag.current;
            if (!drag) return;
            const panel = commitBoxRef.current?.parentElement;
            const max = panel ? panel.clientHeight - 80 : window.innerHeight - 200;
            const grown = drag.startHeight + drag.startY - event.clientY;
            setCommitHeight(Math.max(100, Math.min(max, grown)));
          }}
          onPointerUp={() => {
            commitDrag.current = null;
          }}
        />
      )}

      {view === "commit" && !vcs.nonModalCommit && commitDialog && (
        <div className="dialog-backdrop" onMouseDown={() => { if (committingAction === null) setCommitDialog(false); }} />
      )}

      {/* 提交面板区。非模态贴在变更列表下方；关掉后同一块改成对话框。 */}
      <div
        ref={commitBoxRef}
        hidden={view !== "commit"}
        className={clsx(
          styles.commit,
          !vcs.nonModalCommit && styles.isDialog,
          !vcs.nonModalCommit && !commitDialog && styles.isHidden,
          vcs.nonModalCommit && commitCollapsed && styles.isCollapsed,
        )}
        style={vcs.nonModalCommit && !commitCollapsed && commitHeight !== null ? { flex: "none", height: commitHeight } : undefined}
      >
        {/* 提交头部工具行 */}
        <div className={styles.commitBar}>
          <Checkbox
            checked={amend}
            disabled={committingAction !== null || !amend && repositoryPlans.length > 1}
            onChange={(v) => switchAmend(v)}
            label={t("git.amend")}
          />
          <IconButton
            ref={historyRef}
            icon="history"
            title={t("git.messageHistory")}
            size="small"
            disabled={history.length === 0}
            aria-haspopup="menu"
            aria-expanded={historyAnchor !== null}
            onClick={() => setHistoryAnchor((current) => (current ? null : historyRef.current))}
          />

          <span className={styles.grow} />

          {isSubjectTooLong && (
            <span
              className={clsx(styles.lineLen, styles.lineLenWarn)}
              title={t("git.subjectLineLength")}
            >
              {firstLine.length}/{vcs.subjectLineLimit}
            </span>
          )}

          {vcs.nonModalCommit ? (
            <IconButton
              icon={commitCollapsed ? "chevron-up" : "chevron-down"}
              size="small"
              title={commitCollapsed ? t("git.expandCommit") : t("git.collapseCommit")}
              onClick={() => setCommitCollapsed((folded) => !folded)}
            />
          ) : (
            <IconButton
              icon="close"
              size="small"
              title={t("dialog.cancel")}
              onClick={() => setCommitDialog(false)}
            />
          )}
        </div>

        {/* 提交输入框及操作按钮（折叠时隐藏） */}
        {(!commitCollapsed || !vcs.nonModalCommit) && (
          <>
            {/* 修正上次提交详情提示 (联动 Issue Navigation 工单超链接) */}
            {amend && amendDetail && (
              <div
                className={styles.inspections}
                style={{ color: "var(--fg-secondary, var(--text-muted))" }}
              >
                <span>
                  [{amendDetail.short}]{" "}
                  <IssueText text={amendDetail.subject} patterns={vcs.issueNavigationPatterns} />
                </span>
              </div>
            )}

            {/* 平铺式等宽 Mono 输入框 */}
            <textarea
              readOnly={committingAction !== null}
              ref={inputRef}
              className={clsx(styles.message, !showMargin && styles.noMargin, emptyError && styles.messageError)}
              style={showMargin ? { ["--guide" as string]: `${Math.max(1, marginChars)}ch` } : undefined}
              value={message}
              placeholder={t("git.messagePlaceholder")}
              aria-label={t("git.messagePlaceholder")}
              spellCheck
              onChange={(e) => {
                const val = e.target.value;
                if (vcs.wrapRightMargin && vcs.limitBodyLine && e.target.selectionStart != null) {
                  const wrapped = wrapAtMargin(val, e.target.selectionStart, vcs.bodyLineLimit);
                  if (wrapped) {
                    pendingCaret.current = wrapped.caret;
                    setMessage(wrapped.text);
                    if (emptyError) setEmptyError(false);
                    return;
                  }
                }
                setMessage(val);
                if (emptyError) setEmptyError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void executeCommit(e.altKey);
                } else if (e.key === "Escape") {
                  e.currentTarget.blur();
                }
              }}
            />

            {/* 空消息报错警告 */}
            {emptyError && (
              <div className={clsx(styles.inspections, styles.inspectionError)} role="alert">
                <span>{t("git.specifyMessage")}</span>
              </div>
            )}

            {/* 提交规范检查警告（Commit Message Inspections） */}
            {commitProblems.length > 0 && !emptyError && (
              <div className={styles.inspections} role="status">
                {commitProblems.map((prob, idx) => (
                  <div key={idx} style={{ color: "var(--warning, #e5a824)", fontSize: 11, marginTop: 2 }}>
                    <span>⚠ {prob}</span>
                  </div>
                ))}
              </div>
            )}

            {/* AI 错误提示 */}
            {aiCommitEnabled && aiError && (
              <div className={styles.inspections} style={{ display: "flex", justifyContent: "space-between" }}>
                <span>{aiError}</span>
                {onOpenAiSettings && (
                  <button type="button" className="group-link" onClick={onOpenAiSettings}>
                    {t("aiCommit.settings")}
                  </button>
                )}
              </div>
            )}

            {/* 底部按钮栏 */}
            <div className={styles.commitActions}>
              <Button
                variant="primary"
                className={styles.commitButton}
                disabled={!canCommit}
                onClick={() => void executeCommit(false)}
                title="Ctrl+Enter"
              >
                {committingAction === "commit" ? (
                  <Loader2 size={13} className="is-spinning" style={{ marginRight: 6 }} />
                ) : null}
                <span>{t(amend ? "git.amendButton" : "git.commitButton")}</span>
              </Button>

              <Button
                variant="secondary"
                className={styles.pushButton}
                disabled={!canCommit}
                onClick={() => void executeCommit(true)}
                title={`${t("git.commitAndPush")} (Ctrl+Alt+Enter)`}
              >
                {committingAction === "commitAndPush" ? (
                  <Loader2 size={13} className="is-spinning" style={{ marginRight: 6 }} />
                ) : null}
                <span>{t("git.commitAndPush")}</span>
              </Button>

              {/* AI 与提交选项固定在行尾；宽度不够时只省略「提交并推送」的文字 */}
              <div className={styles.commitActionsTail}>
                {aiCommitEnabled && (
                  <Button
                    variant="secondary"
                    className={styles.aiButton}
                    disabled={committingAction !== null}
                    onClick={isGenerating ? handleCancelAiCommit : () => void handleGenerateAiCommit()}
                    title={t(isGenerating ? "aiCommit.cancel" : "aiCommit.generate")}
                  >
                    {isGenerating ? (
                      <Loader2 size={12} className="is-spinning" />
                    ) : (
                      <Sparkles size={12} />
                    )}
                    <span>AI</span>
                  </Button>
                )}

                <IconButton
                  ref={commitOptionsRef}
                  icon="settings"
                  title={t("git.commitOptions")}
                  size="small"
                  aria-haspopup="dialog"
                  aria-expanded={commitOptionsOpen}
                  onClick={() => setCommitOptionsOpen((o) => !o)}
                />
              </div>

              {/* 340px Commit Options 弹层 */}
              <CommitOptionsPopup
                anchor={commitOptionsRef}
                open={commitOptionsOpen}
                onClose={() => setCommitOptionsOpen(false)}
                options={commitOptions}
                onChange={setCommitOptions}
              />
            </div>
          </>
        )}
      </div>

      {/* 历史提交说明。行数上限只作用于文件历史，不裁这条菜单。 */}
      <Popover anchor={historyAnchor} onClose={() => setHistoryAnchor(null)} minWidth={280}>
        <p className="popover-label">{t("git.messageHistory")}</p>
        {history.length === 0 ? (
          <p className="popover-note">{t("git.noHistory")}</p>
        ) : (
          history.map((item) => (
            <button
              key={item}
              type="button"
              className="popover-item"
              onClick={() => {
                setHistoryAnchor(null);
                setMessage(item);
                inputRef.current?.focus();
              }}
            >
              <Check size={13} aria-hidden="true" />
              <span className="popover-item-label">
                <IssueText text={item} patterns={vcs.issueNavigationPatterns} />
              </span>
            </button>
          ))
        )}
      </Popover>

      {/* Stash Changes… 对话框：消息 + 未跟踪文件开关 */}
      {stashDialog && (
        <div className="dialog-backdrop" onClick={() => setStashDialog(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <h3 className="dialog-title">{t("git.stash")}</h3>
            <div className="dialog-body">
              <input
                type="text"
                className="text-input"
                style={{ width: "100%" }}
                placeholder={t("git.stashMessage")}
                aria-label={t("git.stashMessage")}
                value={stashMessage}
                autoFocus
                onChange={(e) => setStashMessage(e.target.value)}
              />
              <div style={{ marginTop: 8 }}>
                <Checkbox
                  checked={stashUntracked}
                  onChange={setStashUntracked}
                  label={t("git.stashIncludeUntracked")}
                />
              </div>
            </div>
            <div className="dialog-actions">
              <button type="button" className="button" onClick={() => setStashDialog(false)}>
                {t("dialog.cancel")}
              </button>
              <button
                type="button"
                className="button is-primary"
                onClick={() => {
                  setStashDialog(false);
                  if (stashRoot) void git.runRepository(stashRoot, () => gitStashPush(stashRoot, stashMessage, stashUntracked, false));
                }}
              >
                {t("git.stashPushAction")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 丢弃贮藏的二次确认：行尾垃圾桶与右键菜单都走这里，不用 window.confirm。 */}
      {stashToDrop && (
        <div className="dialog-backdrop" onClick={() => setStashToDrop(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <h3 className="dialog-title">{t("git.stashDrop")}</h3>
            <div className="dialog-body">
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>{t("git.stashDropConfirm")}</p>
              <p
                style={{
                  margin: "8px 0 0",
                  fontSize: 13,
                  color: "var(--text-muted)",
                  wordBreak: "break-word",
                }}
                title={stashToDrop.message}
              >
                {stashToDrop.message}
              </p>
            </div>
            <div className="dialog-actions">
              {/* 焦点落在取消上：危险动作不该被一个回车直接触发。 */}
              <button type="button" className="button" autoFocus onClick={() => setStashToDrop(null)}>
                {t("dialog.cancel")}
              </button>
              <button type="button" className="button is-danger" onClick={confirmStashDrop}>
                {t("dialog.delete")}
              </button>
            </div>
          </div>
        </div>
      )}

      {shelfDialog && (
        <div className="dialog-backdrop" onClick={() => setShelfDialog(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <h3 className="dialog-title">{t("git.shelve")}</h3>
            <div className="dialog-body">
              <input
                type="text"
                className="text-input"
                style={{ width: "100%" }}
                placeholder={t("git.shelfName")}
                aria-label={t("git.shelfName")}
                value={shelfName}
                autoFocus
                onChange={(e) => setShelfName(e.target.value)}
              />
            </div>
            <div className="dialog-actions">
              <button type="button" className="button" onClick={() => setShelfDialog(false)}>
                {t("dialog.cancel")}
              </button>
              <button
                type="button"
                className="button is-primary"
                disabled={!shelfName.trim()}
                onClick={() => {
                  setShelfDialog(false);
                  // 右键菜单存选中的那几个；工具栏按钮存全部变更（相对路径，后端兼容绝对路径）。
                  if (shelfRoot) void git.runRepository(shelfRoot, () => gitShelve(
                    shelfRoot, shelfName.trim(),
                    shelfPaths ?? rawChanges.filter((change) => change.repoRoot === shelfRoot).map((change) => change.path)
                  ));
                  setShelfPaths(null);
                }}
              >
                {t("git.shelveAction")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 右键上下文菜单 */}
      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}

      {/* AI 替换确认弹窗 */}
      {confirmReplace !== null && (
        <div className="dialog-backdrop" onClick={() => setConfirmReplace(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <h3 className="dialog-title">{t("aiCommit.replaceConfirmTitle")}</h3>
            <p className="dialog-body">{t("aiCommit.replaceConfirmBody")}</p>
            <div className="dialog-actions">
              <button
                type="button"
                className="button"
                onClick={() => setConfirmReplace(null)}
              >
                {t("aiCommit.keep")}
              </button>
              <button
                type="button"
                className="button is-primary"
                onClick={() => {
                  setMessage(confirmReplace);
                  setConfirmReplace(null);
                  inputRef.current?.focus();
                }}
              >
                {t("aiCommit.replace")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 变更列表管理弹窗（新建 / 编辑 / 移动 / 删除） */}
      {clDialog !== null && (
        <ChangelistModal
          dialog={clDialog}
          changelists={changelists}
          onClose={() => setClDialog(null)}
          onNew={handleNewChangelist}
          onEdit={handleEditChangelist}
          onMove={handleMoveToChangelist}
          onDelete={handleDeleteChangelist}
        />
      )}
    </div>
  );
}

/** {@link ChangelistModal} 的入参（dialog 决定当前是新建/编辑/移动/删除哪一种）。 */
interface ChangelistModalProps {
  dialog:
    | { mode: "new" }
    | { mode: "edit"; id: string; name: string; comment: string; active: boolean }
    | { mode: "move"; paths: string[] }
    | { mode: "delete"; id: string; name: string; count: number };
  changelists: ChangelistsState;
  onClose: () => void;
  onNew: (name: string, comment: string, makeActive: boolean) => void;
  onEdit: (id: string, name: string, comment: string, makeActive: boolean) => void;
  onMove: (paths: string[], targetListId: string) => void;
  onDelete: (id: string) => void;
}

/** changelist 的新建/编辑/移动/删除弹窗。 */
function ChangelistModal({
  dialog,
  changelists,
  onClose,
  onNew,
  onEdit,
  onMove,
  onDelete,
}: ChangelistModalProps) {
  const { t } = useI18n();
  const [name, setName] = useState(() => (dialog.mode === "edit" ? dialog.name : ""));
  const [comment, setComment] = useState(() => (dialog.mode === "edit" ? dialog.comment : ""));
  const [makeActive, setMakeActive] = useState(() =>
    dialog.mode === "edit" ? dialog.active : true
  );
  const [selectedTarget, setSelectedTarget] = useState<string>(() => DEFAULT_LIST_ID);

  const isNew = dialog.mode === "new";
  const isEdit = dialog.mode === "edit";
  const isMove = dialog.mode === "move";
  const isDelete = dialog.mode === "delete";

  const allLists = useMemo(() => {
    return [
      { id: DEFAULT_LIST_ID, name: t("git.defaultChangelist") ?? "Default Changelist" },
      ...changelists.lists,
    ];
  }, [changelists.lists, t]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isNew) {
      if (!name.trim()) return;
      onNew(name.trim(), comment, makeActive);
    } else if (isEdit) {
      if (!name.trim()) return;
      onEdit(dialog.id, name.trim(), comment, makeActive);
    } else if (isMove) {
      onMove(dialog.paths, selectedTarget);
    } else if (isDelete) {
      onDelete(dialog.id);
    }
    onClose();
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 440, minWidth: 360 }}
      >
        <h3 className="dialog-title">
          {isNew && (t("git.newChangelist") ?? "新建变更列表")}
          {isEdit && (t("git.editChangelist") ?? "编辑变更列表")}
          {isMove && (t("git.moveToList") ?? "移到其他变更列表")}
          {isDelete && (t("git.deleteChangelist") ?? "删除变更列表")}
        </h3>

        <form onSubmit={handleSubmit}>
          <div className="dialog-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {(isNew || isEdit) && (
              <>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                  <span style={{ color: "var(--fg-secondary, var(--text-muted))" }}>
                    {t("git.changelistName") ?? "名称"}:
                  </span>
                  <input
                    type="text"
                    className="text-input"
                    autoFocus
                    value={name}
                    placeholder="New Changelist"
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                  <span style={{ color: "var(--fg-secondary, var(--text-muted))" }}>
                    {t("git.changelistComment") ?? "说明（可选）"}:
                  </span>
                  <input
                    type="text"
                    className="text-input"
                    value={comment}
                    placeholder="Comment"
                    onChange={(e) => setComment(e.target.value)}
                  />
                </label>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    cursor: "pointer",
                    marginTop: 4,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={makeActive}
                    onChange={(e) => setMakeActive(e.target.checked)}
                  />
                  <span>{t("git.setActiveChangelist") ?? "设为活动变更列表"}</span>
                </label>
              </>
            )}

            {isMove && (
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
                <span style={{ color: "var(--fg-secondary, var(--text-muted))" }}>
                  {t("git.selectTargetList") ?? "选择目标变更列表"}:
                </span>
                <select
                  className="select-input"
                  value={selectedTarget}
                  onChange={(e) => setSelectedTarget(e.target.value)}
                  style={{ padding: "4px 8px", borderRadius: 4, height: 28 }}
                >
                  {allLists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {isDelete && (
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
                {t("git.deleteChangelistBody", {
                  name: dialog.name,
                  count: dialog.count,
                }) ?? `确定要删除变更列表「${dialog.name}」吗？其中的文件将回到默认变更列表。`}
              </p>
            )}
          </div>

          <div className="dialog-actions" style={{ marginTop: 16 }}>
            <button type="button" className="button" onClick={onClose}>
              {t("dialog.cancel") ?? "取消"}
            </button>
            <button
              type="submit"
              className={clsx("button", isDelete ? "is-danger" : "is-primary")}
              disabled={(isNew || isEdit) && !name.trim()}
            >
              {isDelete
                ? t("dialog.delete") ?? "删除"
                : t("dialog.ok") ?? "确定"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default memo(GitPanel);
