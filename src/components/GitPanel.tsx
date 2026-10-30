import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  ExternalLink,
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
  markClass,
} from "../lib/git";
import { loadIgnored, subscribeIgnored } from "../lib/ignoredCache";
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
import { loadChangelists, type ChangelistsState } from "../lib/changelists";

import type { ChangeNode, CheckState } from "../features/vcs/changes";
import {
  aggregateCheck,
  buildChangeTree,
  checkOf,
  filesOf,
  isPartiallyStaged,
  isStaged,
  planCommit,
  toggledCheck,
} from "../features/vcs/changes";
import {
  CommitOptionsPopup,
  loadCommitOptions,
  type CommitOptionsState,
} from "../features/vcs/CommitOptions";

import styles from "../features/vcs/CommitView.module.css";

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

/** 14px 三态复选框组件（1:1 对标 OpenIdea / IntelliJ IDEA） */
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

  // 提交选项 Commit Options Popup 状态（1:1 移植自 OpenIdea）
  const commitOptionsRef = useRef<HTMLButtonElement>(null);
  const [commitOptionsOpen, setCommitOptionsOpen] = useState(false);
  const [commitOptions, setCommitOptions] = useState<CommitOptionsState>(() => loadCommitOptions());

  // 提交输入框状态
  const [message, setMessage] = useState("");
  const [emptyError, setEmptyError] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

  // 勾选状态（文件路径 -> CheckState）
  const [checks, setChecks] = useState<Map<string, CheckState>>(new Map());

  // 树折叠状态：默认 Unversioned Files 折叠
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(
    () => new Set(["group:unversioned"])
  );
  // 选中的节点 key 集合
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  // 忽略文件列表
  const [ignored, setIgnored] = useState<string[]>([]);

  // AI 提交相关状态【保留项 3】
  const aiCommitEnabled = useAiCommitEnabled();
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState<string | null>(null);
  const generationIdRef = useRef<string | null>(null);

  // 当前正在执行的动作
  const [committingAction, setCommittingAction] = useState<"commit" | "commitAndPush" | null>(null);

  // 聚焦信号响应
  useEffect(() => {
    if (focusSignal > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusSignal]);

  // 修正信号响应
  useEffect(() => {
    if (rewordSignal <= 0) return;
    if (!amend) switchAmend(true);
    inputRef.current?.focus();
    inputRef.current?.select();
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

  // 订阅忽略文件
  useEffect(() => {
    if (!showIgnored || !git.root) {
      setIgnored([]);
      return;
    }
    let stale = false;
    const unsubscribe = subscribeIgnored(git.root, (list) => {
      if (!stale) setIgnored(list);
    });
    void loadIgnored(git.root).then((list) => {
      if (!stale) setIgnored(list);
    });
    return () => {
      stale = true;
      unsubscribe();
    };
  }, [showIgnored, git.root]);

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

  const rawChanges = git.status?.changes ?? [];

  // 清除失效文件的勾选记录
  useEffect(() => {
    const live = new Set(rawChanges.map((c) => c.path));
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

  // 构建变更树（1:1 对标 OpenIdea）
  const treeRoots = useMemo(() => {
    return buildChangeTree(rawChanges, groupByDir, changelists);
  }, [rawChanges, groupByDir, changelists]);

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

  // 切换节点的勾选状态
  const toggleCheck = useCallback((nodes: ChangeNode[]) => {
    const targets = filesOf(nodes);
    if (targets.length === 0) return;
    setChecks((prev) => {
      const agg = aggregateCheck(targets, prev);
      const nextState: CheckState = agg.checked && !agg.indeterminate ? "none" : "all";
      const next = new Map(prev);
      for (const f of targets) {
        next.set(f.path, targets.length === 1 ? toggledCheck(checkOf(f, prev)) : nextState);
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

  // 右键菜单
  const openContextMenu = (event: ReactMouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  // 生成节点的右键菜单（1:1 对标 OpenIdea 规范顺序）
  const getNodeMenu = (node: ChangeNode): MenuItem[] => {
    const files = filesOf([node]);
    const paths = files.map((f) => f.path);
    const firstChange = files[0];
    const itemStaged = firstChange ? isStaged(firstChange) : false;
    const isDeleted = firstChange
      ? firstChange.indexStatus === "D" || firstChange.workStatus === "D"
      : false;

    const items: MenuItem[] = [];

    if (firstChange) {
      items.push({
        label: t("log.diffShow"),
        icon: FileDiff,
        onSelect: () => onOpenChange(firstChange, itemStaged, rawChanges),
      });
      items.push({
        label: t("diff.jumpToSource"),
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

    if (node.group === "conflicts" || files.some((f) => f.conflicted)) {
      items.push({
        label: t("git.resolveConflicts"),
        icon: GitMerge,
        onSelect: onOpenResolve,
      });
      items.push({ separator: true });
    }

    // 回滚
    items.push({
      label: t("git.rollback"),
      icon: Undo2,
      onSelect: () => onFileAction("rollback", node.path ?? "", itemStaged, node.type === "dir"),
    });

    // 暂存与取消暂存
    items.push({
      label: t("git.stage"),
      icon: Plus,
      onSelect: () => void git.stage(paths.map(absolute)),
    });
    items.push({
      label: t("git.unstage"),
      icon: Minus,
      onSelect: () => void git.unstage(paths.map(absolute)),
    });

    items.push({ separator: true });
    items.push({
      label: t("git.patchToClipboard"),
      icon: ClipboardCopy,
      onSelect: () => onFileAction("patchClipboard", node.path ?? "", itemStaged, node.type === "dir"),
    });
    items.push({
      label: t("menu.copyPath"),
      icon: ClipboardCopy,
      onSelect: () => void navigator.clipboard.writeText(paths.map(absolute).join("\n")),
    });

    if (firstChange) {
      items.push({ separator: true });
      items.push({
        label: t("git.history"),
        icon: History,
        onSelect: () => onFileAction("history", firstChange.path, itemStaged, node.type === "dir"),
      });
    }

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

    const targets = plan.included.length > 0 ? plan.included : rawChanges;
    if (targets.length === 0) {
      setAiError(t("aiCommit.noChanges"));
      return;
    }

    const root = git.root ?? workspaceRoot;
    setIsGenerating(true);
    const opId = crypto.randomUUID();
    generationIdRef.current = opId;

    try {
      const files = await collectFilesDiff(root, targets, false);
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

      if (message.trim().length > 0) {
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

  // 提交执行逻辑（支持复选框勾选与 --only 语义提交）
  const executeCommit = async (andPush: boolean) => {
    if (committingAction !== null) return;
    const text = message.trim();
    if (!text && !amend) {
      setEmptyError(true);
      inputRef.current?.focus();
      return;
    }

    // 计算提交目标路径
    let includedPaths = plan.included.map((f) => f.path);
    if (includedPaths.length === 0 && commitAllWhenNothingStaged) {
      includedPaths = rawChanges.filter((c) => !c.untracked && !c.conflicted).map((c) => c.path);
    }
    if (includedPaths.length === 0 && !amend && git.recovery !== "merge") {
      return;
    }

    setCommittingAction(andPush ? "commitAndPush" : "commit");
    try {
      // 如果指定了勾选路径，传递给 commit
      const pathsToCommit = includedPaths.length < rawChanges.length ? includedPaths : undefined;

      if (andPush) {
        const committed = await git.commitAndPush(text, amend, false, pathsToCommit);
        if (!committed) return;
      } else {
        const done = await git.commit(text, amend, pathsToCommit);
        if (!done) return;
      }

      amendSeq.current += 1;
      messageBeforeAmend.current = "";
      onCommitted(text);
      setMessage("");
      setAmend(false);
      setAmendDetail(null);
      setEmptyError(false);
    } finally {
      setCommittingAction(null);
    }
  };

  // 渲染单行树节点（1:1 对标 OpenIdea，并严格保留目录聚合圆点与行尾状态字母）
  const renderRow = (node: ChangeNode, depth: number) => {
    const isGroup = node.type === "group";
    const isDir = node.type === "dir";
    const isFile = node.type === "file";
    const isCollapsed = collapsedNodes.has(node.key);
    const agg = aggregateCheck(node.files, checks);

    // 缩进：每层 18px
    const paddingLeft = 4 + depth * 18;
    const isSelected = selectedKeys.has(node.key);
    const displayLabel = isGroup
      ? node.group === "conflicts"
        ? t("git.unmerged")
        : node.group === "unversioned"
        ? t("git.untracked")
        : node.changelist && node.changelist !== "default"
        ? node.label
        : t("git.changesList")
      : node.label;

    return (
      <div key={node.key}>
        <div
          className={clsx(
            styles.nodeRow,
            "change-row",
            isSelected && styles.isSelected,
            node.active && styles.groupLabel,
            node.changelist && !node.active && styles.inactiveList
          )}
          style={{ paddingLeft }}
          onClick={() => {
            setSelectedKeys(new Set([node.key]));
            if (!isFile) {
              // 点击文件夹行才展开或收缩
              toggleCollapse(node.key);
            } else if (node.files[0]) {
              // 点击文件打开差异对比
              onOpenChange(node.files[0], isStaged(node.files[0]), rawChanges);
            }
          }}
          onContextMenu={(e) => openContextMenu(e, getNodeMenu(node))}
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
                openByDoubleClick(node.files[0], isStaged(node.files[0]), rawChanges);
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

          {/* 【保留项 1】：目录聚合彩色圆点 */}
          {isDir && node.dirMark && (
            <span
              className={clsx(styles.changeDot, `change-dot ${markClass(node.dirMark)}`)}
              aria-hidden="true"
            />
          )}

          {/* 【保留项 1】：行尾单字母状态标记（如 M, U, A, D, R, C） */}
          {isFile && node.mark && (
            <span
              className={clsx(styles.changeMark, `change-mark ${markClass(node.mark)}`)}
            >
              {node.mark}
            </span>
          )}
        </div>

        {/* 展开子节点 */}
        {!isCollapsed &&
          node.children &&
          node.children.map((child) => renderRow(child, depth + 1))}
      </div>
    );
  };

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
    !isGenerating;

  const firstSubjectLine = message.split("\n")[0] ?? "";
  const isSubjectTooLong = firstSubjectLine.length > 72;

  void repoName;
  void onUnignore;
  void onOpenCommitFile;
  void ignored;

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

      {/* 1:1 对标 OpenIdea 的 32px 规范工具栏 */}
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
          icon="arrow-down-to-line"
          title={t("git.updateProject")}
          size="small"
          onClick={() => void git.refresh()}
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
              {treeRoots.map((rootNode) => renderRow(rootNode, 0))}
            </div>
          )}
        </div>
      </div>

      {/* 【保留项 4】：提交区可拖拽自定义高度分隔条 */}
      {!commitCollapsed && (
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

      {/* 提交面板区（1:1 对标 OpenIdea，支持折叠与自定义高度） */}
      <div
        ref={commitBoxRef}
        className={clsx(styles.commit, commitCollapsed && styles.isCollapsed)}
        style={!commitCollapsed && commitHeight !== null ? { flex: "none", height: commitHeight } : undefined}
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

          {/* 主题行长度计数 */}
          {isSubjectTooLong && (
            <span className={clsx(styles.lineLen, styles.lineLenWarn)} title={t("git.subjectLineLength")}>
              {firstSubjectLine.length}/72
            </span>
          )}

          {/* 【保留项 2】：收起提交区折叠按钮 */}
          <IconButton
            icon={commitCollapsed ? "chevron-up" : "chevron-down"}
            size="small"
            title={commitCollapsed ? t("git.expandCommit") : t("git.collapseCommit")}
            onClick={() => setCommitCollapsed((folded) => !folded)}
          />
        </div>

        {/* 提交输入框及操作按钮（折叠时隐藏） */}
        {!commitCollapsed && (
          <>
            {/* 修正上次提交详情提示 */}
            {amend && amendDetail && (
              <div
                className={styles.inspections}
                style={{ color: "var(--fg-secondary, var(--text-muted))" }}
              >
                <span>
                  {t("git.amendHeader", { short: amendDetail.short, subject: amendDetail.subject })}
                </span>
              </div>
            )}

            {/* 平铺式等宽 Mono 输入框（1:1 对标 OpenIdea） */}
            <textarea
              ref={inputRef}
              className={clsx(styles.message, emptyError && styles.messageError)}
              value={message}
              placeholder={t("git.messagePlaceholder")}
              aria-label={t("git.messagePlaceholder")}
              spellCheck
              onChange={(e) => {
                setMessage(e.target.value);
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

            {/* 底部按钮栏（1:1 对齐 OpenIdea 布局规范） */}
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
                title="Ctrl+Alt+Enter"
              >
                {committingAction === "commitAndPush" ? (
                  <Loader2 size={13} className="is-spinning" style={{ marginRight: 6 }} />
                ) : null}
                <span>{t("git.commitAndPush")}</span>
              </Button>

              <span className={styles.grow} />

              {/* 【保留项 3】：AI 提交按钮 */}
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

              {/* 【核心改造项】：设置齿轮替换为 OpenIdea 的 CommitOptionsPopup */}
              <IconButton
                ref={commitOptionsRef}
                icon="settings"
                title={t("git.commitOptions")}
                size="small"
                aria-haspopup="dialog"
                aria-expanded={commitOptionsOpen}
                onClick={() => setCommitOptionsOpen((o) => !o)}
              />

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

      {/* 历史提交说明菜单 */}
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
              <span className="popover-item-label">{item}</span>
            </button>
          ))
        )}
      </Popover>

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
    </div>
  );
}

export default memo(GitPanel);
