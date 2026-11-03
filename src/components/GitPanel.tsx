import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRightLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Copy,
  ExternalLink,
  Eye,
  FileDiff,
  FolderOpen,
  GitMerge,
  History,
  Loader2,
  Minus,
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
  markClass,
} from "../lib/git";
import { commitDraft, setCommitDraft, subscribeCommitDraft } from "../lib/commitDraft";
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
  buildChangeTree,
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

interface GitPanelProps {
  git: GitState;
  /** 网络动作交给 App 的统一窗口和任务流程。 */
  onUpdate: () => void;
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
  /** 双击变更行打开比对还是源文件；IDEA 的 Show on Double-Click。 */
  showOnDoubleClick: "preview" | "source";
  /** 一件都没暂存时，提交按钮直接提交全部已跟踪改动；IDEA 默认开着。 */
  commitAllWhenNothingStaged: boolean;
  /** 双击要打开源文件时走这条，落给 App 开编辑器标签。 */
  onOpenSource: (change: GitChange) => void;
  /** 「解决冲突」开的是同一个弹层。 */
  onOpenResolve: () => void;
  /** 仓库根那一行显示的名字。 */
  repoName: string;
  /** 文件与目录菜单里需要动编辑器、对话框或日志的动作，落给 App。 */
  onFileAction: (action: CommitFileAction, path: string, staged: boolean, isDirectory?: boolean) => void;
  /** 已忽略那一行的「从忽略列表移除」：动的是盖住它的那条规则，落给 App。 */
  onUnignore: (relative: string) => void;
  /** 修正那一节里的文件：点开看的是那次提交里这一份的差异。 */
  onOpenCommitFile: (revision: string, file: GitCommitFile) => void;
  /** 点击设置按钮打开 AI 提交配置 */
  onOpenAiSettings?: () => void;
}

/** 提交信息规范问题检查 (对齐 IntelliJ IDEA / IDEA Commit Inspections) */
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

/** 14px 三态复选框组件（1:1 对标 IDEA / IntelliJ IDEA） */
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

function GitPanel({
  git,
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
  commitAllWhenNothingStaged,
  onOpenSource,
  onOpenResolve,
  repoName,
  onFileAction,
  onUnignore,
  onOpenCommitFile,
  onOpenAiSettings,
}: GitPanelProps) {
  const { t } = useI18n();

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

  // 提交说明按仓库留着：切走工具窗口会卸掉这个面板，不能只放在组件状态里。
  const draftKey = git.root ?? workspaceRoot;
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

  // 提交区收起与自定义高度状态【保留项 2 & 4】
  const [commitCollapsed, setCommitCollapsed] = useState(false);
  const [commitHeight, setCommitHeight] = useState<number | null>(null);
  const commitBoxRef = useRef<HTMLDivElement>(null);
  const commitDrag = useRef<{ startY: number; startHeight: number } | null>(null);

  // 修正 (Amend) 状态
  const [amend, setAmend] = useState(false);
  const [amendDetail, setAmendDetail] = useState<GitCommitDetail | null>(null);
  const messageBeforeAmend = useRef("");
  const amendSeq = useRef(0);

  // 提交历史弹层
  const historyRef = useRef<HTMLButtonElement>(null);
  const [historyAnchor, setHistoryAnchor] = useState<HTMLElement | null>(null);

  // 右键菜单
  const [menu, setMenu] = useState<MenuAnchor | null>(null);

  // 变更列表数据（支持按 Changelist 分组）
  const [changelists, setChangelists] = useState<ChangelistsState>(() =>
    git.root ? loadChangelists(git.root) : { lists: [], moves: {}, activeId: "default" }
  );

  useEffect(() => {
    if (git.root) {
      setChangelists(loadChangelists(git.root));
    }
  }, [git.root]);

  // 勾选状态：按侧独立存储（`s:<path>` 管已暂存那条，`w:<path>` 管未暂存那条），
  // 同一文件（部分暂存的）在两组的复选框互不联动
  const [checks, setChecks] = useState<Map<string, boolean>>(new Map());

  // 文件分组默认折叠，用户手动展开；刷新变更列表时保留当前展开状态。
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(
    () => new Set(["group:staged", "group:unstaged", "group:unversioned"])
  );
  // 选中的节点 key 集合
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  // AI 提交相关状态【保留项 3】
  const aiCommitEnabled = useAiCommitEnabled();
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState<string | null>(null);
  // Stash Changes… 对话框：消息默认留空走 git 的「WIP on …」，未跟踪文件默认包含（IDEA 默认勾选）。
  const [stashDialog, setStashDialog] = useState(false);
  const [shelfDialog, setShelfDialog] = useState(false);
  const [shelfName, setShelfName] = useState("");
  /** unshelve 有冲突时的一条内联提示；下次动作或关闭清掉。 */
  const [shelfNotice, setShelfNotice] = useState<string | null>(null);
  /** 待搁置的文件相对路径；null 表示工具栏按钮（存全部变更）。 */
  const [shelfPaths, setShelfPaths] = useState<string[] | null>(null);
  const [stashMessage, setStashMessage] = useState("");
  const [stashUntracked, setStashUntracked] = useState(true);
  const generationIdRef = useRef<string | null>(null);

  // 当前正在执行的动作
  const [committingAction, setCommittingAction] = useState<"commit" | "commitAndPush" | null>(null);
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
      return;
    }
    const head = git.lastCommit;
    if (!head || !git.root) return;
    messageBeforeAmend.current = message;
    setAmend(true);
    void gitCommitDetail(git.root, head.hash)
      .then((detail) => {
        if (seq !== amendSeq.current) return;
        setAmendDetail(detail);
        setMessage(detail.body ? `${detail.subject}\n\n${detail.body}` : detail.subject);
      })
      .catch(() => {
        if (seq === amendSeq.current) setAmendDetail(null);
      });
  };

  const rawChanges = git.status?.changes ?? EMPTY_CHANGES;

  // 清除失效文件的勾选记录（键带侧前缀 `s:`/`w:`，截掉前两字符才是路径）
  useEffect(() => {
    const live = new Set(rawChanges.map((c) => c.path));
    setChecks((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const k of next.keys()) {
        if (!live.has(k.slice(2))) {
          next.delete(k);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rawChanges]);

  // 构建变更树（git 暂存区那套分组：已暂存 / 未暂存分开摆，部分暂存两边各一条）
  const treeRoots = useMemo(() => {
    return buildChangeTree(rawChanges, groupByDir);
  }, [rawChanges, groupByDir]);

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

  // 切换节点的勾选状态：写入哪一侧由节点所在组决定，两组各管各的那一半
  const toggleCheck = useCallback((nodes: ChangeNode[]) => {
    const first = nodes[0];
    if (!first) return;
    const side: ChangeSide = first.group === "staged" ? "staged" : "worktree";
    const targets = filesOf(nodes);
    if (targets.length === 0) return;
    setChecks((prev) => {
      const agg = aggregateCheck(targets, side, prev);
      // 全勾点一下全清空，其余（含横线）一律全勾上
      const turnOn = !agg.checked;
      const next = new Map(prev);
      for (const f of targets) {
        next.set(checkKey(side, f.path), turnOn);
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

  const absolute = useCallback(
    (relative: string) => git.absoluteOf(relative),
    [git]
  );

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
      if (git.root) {
        saveChangelists(git.root, next);
      }
    },
    [git.root]
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
      if (!git.root || files.length === 0) return;
      setShelfPaths(files.map((f) => f.path));
      setShelfName("");
      setShelfNotice(null);
      setShelfDialog(true);
    },
    [git.root]
  );

  // 创建补丁文件并按设置分流处理 (对标 IDEA VCS onPatchCreated 规范)
  const handleCreatePatchFiles = useCallback(
    async (files: GitChange[]) => {
      if (!git.root || files.length === 0) return;
      try {
        const diffs: string[] = [];
        for (const f of files) {
          const text = await gitDiffText(git.root, "HEAD", "", absolute(f.path));
          if (text) diffs.push(text);
        }
        if (diffs.length === 0) return;
        const patchContent = diffs.join("\n\n");

        if (vcs.onPatchCreated === "file" || vcs.onPatchCreated === "open") {
          // 在项目工作区生成标准 patch 文件
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const patchName = `patch-${timestamp}.patch`;
          const patchPath = `${git.root.replace(/[\\/]+$/, "")}/${patchName}`;
          await writeFile(patchPath, patchContent, "lf", false);

          if (vcs.onPatchCreated === "file") {
            // 在系统文件管理器中高亮定位该补丁
            await revealEntry(patchPath);
          } else {
            // 在编辑器中打开该补丁源码
            onFileAction("editSource", patchPath, false, false);
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

  /**
   * 变更文件与目录节点右键菜单（1:1 对标 IDEA 的 nodeMenu 规范）
   */
  const getNodeMenu = (node: ChangeNode): MenuItem[] => {
    const files = filesOf([node]);
    const paths = files.map((f) => f.path);
    const firstChange = files[0];
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
        onSelect: () => onFileAction("editSource", firstChange.path, itemStaged),
      });
      items.push({
        label: t("menu.open") ?? "Open",
        icon: FolderOpen,
        disabled: !firstChange.path || isDeleted,
        onSelect: () => onOpenFile(firstChange.path),
      });
      items.push({ separator: true });
    }

    // 2. 冲突解决
    if (node.group === "conflicts" || conflicted.length > 0) {
      items.push({
        label: `${t("git.resolveConflicts") ?? "Resolve Conflicts"}…`,
        icon: GitMerge,
        onSelect: onOpenResolve,
      });
      items.push({ separator: true });
    }

    // 3. 版本回滚 (Ctrl+Alt+Z)
    items.push({
      label: `${t("git.rollback") ?? "Rollback"}…`,
      icon: Undo2,
      shortcut: "Ctrl+Alt+Z",
      onSelect: () => onFileAction("rollback", node.path ?? "", itemStaged, node.type === "dir"),
    });

    // 4. 加入版本控制 (未跟踪文件专用)
    if (untracked.length > 0) {
      items.push({
        label: t("git.addVcs") ?? "Add to VCS",
        icon: Plus,
        onSelect: () => void git.stage(untracked.map((f) => absolute(f.path))),
      });
    }

    // 5. 暂存与取消暂存：可用性跟组走，避免部分暂存文件在未暂存组被错禁 Stage
    items.push({
      label: t("git.stage") ?? "Stage",
      icon: Plus,
      disabled: node.group === "staged",
      onSelect: () => void git.stage(paths.map(absolute)),
    });
    items.push({
      label: t("git.unstage") ?? "Unstage",
      icon: Minus,
      disabled: node.group !== "staged" && !files.some((f) => isStaged(f)),
      onSelect: () => void git.unstage(paths.map(absolute)),
    });

    // 6. 移动到其他变更列表 (Alt+Shift+M)
    if (node.group === "staged" || node.group === "unstaged") {
      items.push({ separator: true });
      items.push({
        label: `${t("git.moveToList") ?? "Move to Another Changelist"}…`,
        icon: ArrowRightLeft,
        shortcut: "Alt+Shift+M",
        onSelect: () => setClDialog({ mode: "move", paths }),
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
        onSelect: () => onFileAction("history", firstChange.path, itemStaged, node.type === "dir"),
      });
      items.push({
        label: t("git.annotate") ?? "Annotate with Git Blame",
        icon: Eye,
        disabled: !firstChange.path || isDeleted,
        onSelect: () => onFileAction("editSource", firstChange.path, itemStaged),
      });
    }

    // 9. 复制路径
    items.push({ separator: true });
    items.push({
      label: t("menu.copyPath") ?? "Copy Path",
      icon: Copy,
      onSelect: () => void navigator.clipboard.writeText(paths.map(absolute).join("\n")),
    });

    return items;
  };

  // 生成 AI 提交消息【保留项 3】
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

    const activeProvider = config.providers.find((p) => p.id === config.activeProviderId);
    if (!activeProvider) {
      setAiError(t("aiCommit.configureFirst"));
      return;
    }

    // AI 与提交共用文件来源，区分完整工作区和仅未暂存修改。
    const targets = plan.included.length > 0
      ? plan.included
      : commitAllWhenNothingStaged ? rawChanges.filter((c) => !c.untracked && !c.conflicted) : [];
    const selections = plan.included.length > 0 ? plan.selections
      : targets.map((c) => ({ path: c.path, oldPath: c.oldPath, source: "worktree" as const }));
    if (targets.length === 0) {
      setAiError(t("aiCommit.noChanges"));
      return;
    }

    const root = git.root ?? workspaceRoot;
    setIsGenerating(true);
    const opId = crypto.randomUUID();
    generationIdRef.current = opId;

    try {
      const files = await collectFilesDiff(root, targets, selections);
      if (files.length === 0) {
        setAiError(t("aiCommit.AI_COMMIT_EMPTY_DIFF"));
        setIsGenerating(false);
        return;
      }

      const generated = await generateAiCommitMessage({
        operationId: opId,
        files,
        overrideProviderId: activeProvider.id,
      });

      // 以仓库里的说明为准：生成期间面板可能已经卸掉，晚到的结果不能盖掉切回来后新打的字。
      if (commitDraft(root).trim().length > 0) {
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

  // 按文件来源提交，联动 VCS 安全策略与推送保护。
  const executeCommit = async (andPush: boolean) => {
    if (committingAction !== null || git.operation?.phase === "running") return;
    const pushRoot = git.root;
    const pushBranch = git.status?.branch ?? "";
    const text = message.trim();
    if (!text && !amend) {
      setEmptyError(true);
      inputRef.current?.focus();
      return;
    }

    // 游离 HEAD 或变基中提交。变基进行中 HEAD 不一定显示为游离。
    if (vcs.warnDetachedHead && (git.recovery === "rebase" || git.status?.detached || git.status?.branch === "(detached)")) {
      const confirmed = window.confirm(t(git.recovery === "rebase" ? "vcs.warnRebaseConfirm" : "vcs.warnDetachedConfirm"));
      if (!confirmed) return;
    }

    // 计算提交目标路径
    let includedPaths = plan.included.map((f) => f.path);
    // 「什么都没勾也要提交」时纳入全部已跟踪变更，并强制全部暂存（此路径没有部分暂存语义）。
    let stageAll = false;
    if (includedPaths.length === 0 && commitAllWhenNothingStaged) {
      includedPaths = rawChanges.filter((c) => !c.untracked && !c.conflicted).map((c) => c.path);
      stageAll = true;
    }
    if (includedPaths.length === 0 && !amend && git.recovery !== "merge") {
      return;
    }

    // 3. 超大文件安全拦截 (warnLargeFiles & largeFilesLimitMb 对标 IDEA)
    if (vcs.warnLargeFiles && git.root && includedPaths.length > 0) {
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

    // 4. 提交前检查：扫描待提交文件中的 TODO/FIXME (checkTodo 对标 IDEA Commit Checks)
    const shouldCheckTodo = commitOptions.checkTodo || vcs.checkTodo;
    if (shouldCheckTodo && git.root && includedPaths.length > 0) {
      const filesWithTodo: string[] = [];
      try {
        // 一次拿整份 diff 再在内存里按文件切分：逐文件起 `git diff` 子进程，勾几十个文件
        // 就是几十个进程排队（Windows 上每个几十毫秒，大提交点下去要干等好几秒）。
        const diff = await gitDiffText(git.root, "HEAD", "", "");
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
    if (vcs.warnCrlf && git.root && includedPaths.length > 0) {
      const autocrlf = (await gitConfigGet(git.root, "core.autocrlf").catch(() => "")).toLowerCase();
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
      selections: stageAll
        ? rawChanges.filter((c) => includedPaths.includes(c.path)).map((c) => ({ path: c.path, oldPath: c.oldPath, source: "worktree" as const }))
        : plan.selections,
    };

    setCommittingAction(andPush ? "commitAndPush" : "commit");
    try {
      // 由后端一次构造提交索引并保留其余内容，前端不提前改动真实暂存区。
      const done = await git.commit(commitText, amend, undefined, commitOpts);
      if (!done) return;

      amendSeq.current += 1;
      messageBeforeAmend.current = "";
      onCommitted(commitText);
      if (vcs.clearInitialCommitMessage !== false) {
        setMessage("");
      }
      if (!vcs.nonModalCommit) setCommitDialog(false);
      setAmend(false);
      setAmendDetail(null);
      setEmptyError(false);
      // 提交已落盘后清理说明；取消或失败的推送不会撤销这次提交。
      if (andPush && pushRoot) onPush(pushRoot, pushBranch);
    } finally {
      setCommittingAction(null);
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

  // 渲染单行树节点（1:1 对标 IDEA，并严格保留目录聚合圆点与行尾状态字母）
  const renderRow = useCallback(function renderRows(node: ChangeNode, depth: number) {
    const isGroup = node.type === "group";
    const isDir = node.type === "dir";
    const isFile = node.type === "file";
    const isCollapsed = collapsedNodes.has(node.key);
    // 复选框只看本侧：已暂存组与未暂存组各自的勾选互不相干
    const agg = aggregateCheck(node.files, node.group === "staged" ? "staged" : "worktree", checks);

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
            label={t("git.includeInCommit")}
            onToggle={() => toggleCheck([node])}
          />

          {/* 图标：1:1 对标 IntelliJ IDEA / ExpUI 官方矢量文件夹与文件图标体系 */}
          {isGroup ? null : isDir ? (
            <span className={styles.icon}>
              <EntryIcon
                name={node.label}
                path={absolute(node.path ?? "")}
                isDirectory
                isPackage={isUnderJvmSourceRoot(absolute(node.path ?? ""))}
                size={14}
              />
            </span>
          ) : (
            <span className={styles.icon}>
              <EntryIcon name={node.label} path={absolute(node.path ?? "")} size={14} />
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
          {isGroup && (
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
            const paths = node.files.map((f) => absolute(f.path));
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
                  if (isStagedGroup) void git.unstage(paths);
                  else void git.stage(paths);
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
  if (!git.probe?.available) {
    return <p className="panel-note">{t("git.notInstalled")}</p>;
  }
  if (!git.root) {
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
    (includedCount > 0 || amend || recovery === "merge") &&
    committingAction === null &&
    git.operation?.phase !== "running" &&
    !isGenerating;

  void repoName;
  void onUnignore;
  void onOpenCommitFile;

  return (
    <div className={clsx(styles.root, "git-panel")}>
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

      {/* 1:1 对标 IDEA 的 32px 规范工具栏 */}
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
          disabled={rawChanges.length === 0}
          onClick={() => onFileAction("rollback", "", false, true)}
        />
        <IconButton
          icon="stash"
          title={t("git.stash")}
          size="small"
          disabled={rawChanges.length === 0}
          onClick={() => setStashDialog(true)}
        />
        <IconButton
          icon="archive"
          title={t("git.shelve")}
          size="small"
          disabled={rawChanges.length === 0}
          onClick={() => {
            setShelfName("");
            setShelfNotice(null);
            setShelfDialog(true);
          }}
        />
        <IconButton
          icon="git-pull"
          title={t("git.updateProject")}
          size="small"
          disabled={git.operation?.phase === "running" || !git.status?.upstream || !!git.recovery}
          onClick={onUpdate}
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
      <div className={styles.changes}>
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

      {/* Stash 列表：有贮藏才占地方，空仓库不留一行标题。操作对齐 IDEA 的 Apply / Pop / Drop。 */}
      {git.stashes.length > 0 && (
        <div className={styles.stashBox}>
          <div className={styles.stashHead}>
            <span>{t("git.stashTitle")}</span>
            <span className={styles.stashCount}>{git.stashes.length}</span>
          </div>
          <div className={styles.stashList}>
            {git.stashes.map((entry) => (
              <div key={entry.index} className={styles.stashRow}>
                <span className={styles.stashMsg} title={entry.message}>
                  {entry.message}
                </span>
                <span className={styles.stashTime}>
                  {new Date(entry.timeMs).toLocaleString([], {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <button
                  type="button"
                  className={styles.stashAction}
                  onClick={() => void git.stashApply(entry.index, false)}
                >
                  {t("git.stashApply")}
                </button>
                <button
                  type="button"
                  className={styles.stashAction}
                  onClick={() => void git.stashApply(entry.index, true)}
                >
                  {t("git.stashPop")}
                </button>
                <button
                  type="button"
                  className={styles.stashAction}
                  onClick={() => {
                    const name = window.prompt(t("git.stashBranchPrompt"));
                    if (name && name.trim()) void git.stashBranch(entry.index, name.trim());
                  }}
                >
                  {t("git.stashBranch")}
                </button>
                <button
                  type="button"
                  className={clsx(styles.stashAction, styles.stashDrop)}
                  onClick={() => {
                    if (window.confirm(t("git.stashDropConfirm"))) {
                      void git.stashDrop(entry.index);
                    }
                  }}
                >
                  {t("git.stashDrop")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

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
                <span className={styles.stashTime}>
                  {new Date(entry.timeMs).toLocaleString([], {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <button
                  type="button"
                  className={styles.stashAction}
                  onClick={() => {
                    setShelfNotice(null);
                    void git.unshelve(entry.id, false).then((outcome) => {
                      if (outcome && outcome.conflicts.length > 0) {
                        setShelfNotice(t("git.unshelveConflicts").replace("{n}", String(outcome.conflicts.length)));
                      }
                    });
                  }}
                >
                  {t("git.unshelve")}
                </button>
                <button
                  type="button"
                  className={styles.stashAction}
                  onClick={() => {
                    const next = window.prompt(t("git.shelfRename"), entry.name);
                    if (next && next.trim() && next.trim() !== entry.name) {
                      void git.shelfRename(entry.id, next.trim());
                    }
                  }}
                >
                  {t("git.shelfRename")}
                </button>
                <button
                  type="button"
                  className={clsx(styles.stashAction, styles.stashDrop)}
                  onClick={() => {
                    if (window.confirm(t("git.shelfDeleteConfirm"))) {
                      void git.shelfDelete(entry.id);
                    }
                  }}
                >
                  {t("git.shelfDelete")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 【保留项 4】：提交区可拖拽自定义高度分隔条。模态提交时改由对话框承载。 */}
      {vcs.nonModalCommit && !commitCollapsed && (
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

      {!vcs.nonModalCommit && commitDialog && (
        <div className="dialog-backdrop" onMouseDown={() => { if (committingAction === null) setCommitDialog(false); }} />
      )}

      {/* 提交面板区。非模态贴在变更列表下方；关掉后同一块改成对话框。 */}
      <div
        ref={commitBoxRef}
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

            {/* 平铺式等宽 Mono 输入框（1:1 对标 IDEA） */}
            <textarea
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

            {/* 提交规范检查警告 (Commit Message Inspections 对标 IDEA) */}
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

            {/* 底部按钮栏（1:1 对齐 IDEA 布局规范） */}
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

      {/* Stash Changes… 对话框（对齐 IDEA：消息 + 未跟踪文件开关） */}
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
                  void git.stashPush(stashMessage, stashUntracked, false);
                }}
              >
                {t("git.stashPushAction")}
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
                  void git.shelve(
                    shelfName.trim(),
                    shelfPaths ?? rawChanges.map((change) => change.path)
                  );
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
