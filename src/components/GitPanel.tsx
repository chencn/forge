import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  AlertTriangle,
  Archive,
  ArrowDownToLine,
  ClipboardCopy,
  FileDiff,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleSlash,
  Eye,
  FolderGit2,
  GitCommit,
  GitMerge,
  History,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  SquarePlus,
  Trash2,
  Undo2,
} from "lucide-react";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor, MenuItem } from "./ContextMenu";
import { flatMenu } from "./ContextMenu";
import EntryIcon from "./EntryIcon";
import Popover from "./Popover";
import type { GitChange, GitCommit as AmendTarget, GitCommitDetail, GitCommitFile } from "../lib/git";
import { changeMark, folderMarks, gitCommitDetail, markClass } from "../lib/git";
import type { GitState } from "../hooks/useGitState";
import { basenameOf } from "../lib/format";
import { collapsePackageDirs, isUnderJvmSourceRoot } from "../lib/jvm";
import { RECOVERY_MESSAGE } from "../lib/recovery";
import { MOD_LABEL } from "../lib/sys";
import { useI18n } from "../i18n";

/** 提交树里要交给 App 落地的动作：开文件、写补丁、删文件、加忽略、看历史。 */
export type CommitFileAction =
  | "editSource"
  | "patch"
  | "patchClipboard"
  | "history"
  | "delete"
  | "ignore";

interface GitPanelProps {
  git: GitState;
  /** 工作区目录，用于在非仓库时给出上下文。 */
  workspaceRoot: string;
  onOpenChange: (change: GitChange, staged: boolean, siblings: GitChange[]) => void;
  /** 打开某个文件的普通编辑器（忽略文件没有差异可看，点开就是看内容）。 */
  onOpenFile: (path: string) => void;
  /** 主工具栏「提交…」动作自增它，说明框拿到焦点。 */
  focusSignal: number;
  /** 日志里「编辑提交消息」自增它：把 HEAD 摊进说明框并勾上修正。 */
  rewordSignal: number;
  /** 提交成功后把说明交给上层记进历史。 */
  onCommitted: (message: string) => void;
  /** 提交说明历史，新的在前。 */
  history: string[];
  /** 按目录分组：关掉就是平铺一列文件名。齿轮弹层管它，快捷键 Ctrl+Alt+P。 */
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
  /** 「解决冲突」这一颗（组标题的链接与冲突行的菜单项）开的是同一个弹层。 */
  onOpenResolve: () => void;
  /** 仓库根那一行显示的名字。 */
  repoName: string;
  /** 文件行菜单里那几项要动编辑器 / 对话框 / 日志的，落给 App。 */
  onFileAction: (action: CommitFileAction, change: GitChange, staged: boolean) => void;
  /** 修正那一节里的文件：点开看的是那次提交里这一份的差异，不是工作区比对。 */
  onOpenCommitFile: (revision: string, file: GitCommitFile) => void;
}

/** 变更树的一层目录；`path` 是仓库相对路径，git 输出恒用正斜杠。 */
interface DirNode {
  /** 显示名。中间目录被压缩后是 `a/b/c` 这样的合并写法，`path` 仍是真实路径。 */
  name: string;
  path: string;
  dirs: DirNode[];
  files: GitChange[];
}

function buildTree(changes: GitChange[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: [], files: [] };
  /** 每一层的「子目录名 → 节点」。原来用 `dirs.find` 逐段找，同级目录一多就是平方量级。 */
  const indexes = new Map<DirNode, Map<string, DirNode>>();
  for (const change of changes) {
    const parts = change.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let bucket = indexes.get(node);
      if (!bucket) {
        bucket = new Map<string, DirNode>();
        indexes.set(node, bucket);
      }
      let next = bucket.get(path);
      if (!next) {
        next = { name: part, path, dirs: [], files: [] };
        bucket.set(path, next);
        node.dirs.push(next);
      }
      node = next;
    }
    node.files.push(change);
  }
  const sortInto = (node: DirNode) => {
    node.dirs.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => basenameOf(a.path).localeCompare(basenameOf(b.path)));
    for (const dir of node.dirs) sortInto(dir);
  };
  sortInto(root);
  // 压缩在排序之后：排序按原始名字比，压缩只改显示名，不影响同级次序。
  root.dirs = root.dirs.map((dir) => collapsePackageDirs(dir));
  return root;
}

/** 某个目录往下的全部文件。树按变更数组缓存，节点身份稳定，所以这一份也能跟着缓存。 */
const underCache = new WeakMap<DirNode, GitChange[]>();

function filesUnder(node: DirNode): GitChange[] {
  const hit = underCache.get(node);
  if (hit) return hit;
  const all = [...node.files, ...node.dirs.flatMap(filesUnder)];
  underCache.set(node, all);
  return all;
}

/**
 * 一组的目录树与目录聚合标记，按那一份变更数组的身份缓存。
 *
 * 这两样只跟变更列表有关，但 `renderRows` 每组都要用一次、每次渲染都要用一次：
 * App 那边轮询、拖动、打字都会带着上千条变更重跑一遍建树。
 */
const groupCache = new WeakMap<GitChange[], { tree: DirNode; marks: Map<string, string> }>();

function groupView(changes: GitChange[]) {
  let hit = groupCache.get(changes);
  if (!hit) {
    hit = { tree: buildTree(changes), marks: folderMarks(changes) };
    groupCache.set(changes, hit);
  }
  return hit;
}

/** 展平后的一行树：目录行或文件行，深度决定缩进。 */
type FlatRow =
  | { kind: "dir"; key: string; depth: number; node: DirNode; open: boolean }
  | { kind: "file"; key: string; depth: number; change: GitChange };

function flattenTree(
  node: DirNode,
  depth: number,
  prefix: string,
  opened: Set<string>,
  out: FlatRow[]
): void {
  for (const dir of node.dirs) {
    const key = `${prefix}${dir.path}`;
    const open = opened.has(key);
    out.push({ kind: "dir", key, depth, node: dir, open });
    if (open) flattenTree(dir, depth + 1, prefix, opened, out);
  }
  for (const change of node.files) {
    out.push({ kind: "file", key: `${prefix}file:${change.path}`, depth, change });
  }
}

/** 模块行（仓库根）的折叠键后缀，和目录行的键不撞。 */
const MODULE_KEY = "⌂module";
/** 组标题自己的折叠键：目录路径不会带 #，所以和后两样都不撞。 */
const groupKey = (prefix: string) => `${prefix}#group`;

/**
 * 组标题那一行从行首到文字之间隔着折叠箭头和它的间距。组下面的仓库根、目录、文件
 * 都从这一列起步，箭头才不会和标题的箭头并排，层级才看得出来。
 */
const HEAD_TEXT = 28;
/** 文件行没有箭头，状态字母顶上这一列；比目录行多出箭头那一段。 */
const HEAD_MARK = HEAD_TEXT + 6;

/** 未跟踪文件并进「未暂存」的上限；超过就独立成节。同 IDEA 的 vcs.unversioned.files.max.intree。 */
const UNTRACKED_INLINE_LIMIT = 1000;

export default function GitPanel({
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
  onOpenCommitFile,
}: GitPanelProps) {
  const { t, locale } = useI18n();
  /** 条内那颗视图选项的锚点。 */
  const viewRef = useRef<HTMLButtonElement>(null);
  const [viewAnchor, setViewAnchor] = useState<HTMLElement | null>(null);
  const [message, setMessage] = useState("");
  /** 修正上次提交：勾上后不带新说明也能按提交。 */
  const [amend, setAmend] = useState(false);
  /** 忽略文件清单，勾上视图选项那项才去拉。 */
  const [ignored, setIgnored] = useState<string[]>([]);
  /** 折叠起来的变更树目录，键带组前缀，各组各自记。 */
  /** 目录与模块行的展开状态：IDEA 那棵树默认是收起来的，点开哪条记哪条。 */
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  /** 组标题（已暂存/未存/…）的折叠状态，和目录分开记：默认全展开。 */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  /** 变更行右键菜单，整棵树共用一个。 */
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** 说明历史弹层的锚点。 */
  const [historyAnchor, setHistoryAnchor] = useState<HTMLElement | null>(null);
  /** 「上次提交」那颗下拉：列的是还没推出去的提交，选中哪条就修正哪条。 */
  const amendRef = useRef<HTMLButtonElement>(null);
  const [amendAnchor, setAmendAnchor] = useState<HTMLElement | null>(null);
  const [amendTargets, setAmendTargets] = useState<AmendTarget[]>([]);
  /** 勾上修正时那次提交的完整信息：说明要搬进提交框，改到的文件要在树顶列出来。 */
  const [amendDetail, setAmendDetail] = useState<GitCommitDetail | null>(null);
  /** 修正之前提交框里写的是什么，取消勾选要原样还回去。 */
  const messageBeforeAmend = useRef("");

  /** IDEA 的 Amend：勾上把上次提交摊开（说明进框、文件成节），取消就收回这些。 */
  const switchAmend = (on: boolean) => {
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
        setAmendDetail(detail);
        setMessage(detail.body ? `${detail.subject}\n\n${detail.body}` : detail.subject);
      })
      .catch(() => setAmendDetail(null));
  };
  /** 提交区整体：拖分隔条要量它当前高度，收起时也靠它保持头部可见。 */
  const commitBoxRef = useRef<HTMLDivElement>(null);
  /** 提交区高度；null 表示还没拖过，按 CSS 的比例分上下。 */
  const [commitHeight, setCommitHeight] = useState<number | null>(null);
  /** 收起提交区，只留上面那条工具行。 */
  const [commitCollapsed, setCommitCollapsed] = useState(false);
  /** 拖分隔条时的起点：按下那刻的指针纵坐标与提交区高度。 */
  const commitDrag = useRef<{ startY: number; startHeight: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 弹层锚点用 ref 拿，别靠 event.currentTarget：updater 跑的时候它已经被清空。 */
  const historyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (focusSignal > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusSignal]);

  /** 日志里「编辑提交消息」：HEAD 摊进说明框、勾上修正，光标落在框里等着改。 */
  useEffect(() => {
    if (rewordSignal <= 0) return;
    if (!amend) switchAmend(true);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [rewordSignal]);

  useEffect(() => {
    if (!showIgnored) {
      setIgnored([]);
      return;
    }
    let stale = false;
    void git.loadIgnored().then((list) => {
      if (!stale) setIgnored(list);
    });
    return () => {
      stale = true;
    };
    // 忽略清单只会随工作区内容变，所以跟着 `status` 走；
    // 依赖整个 `git` 的话，App 每渲染一次就多一个 `git status --ignored` 子进程。
  }, [showIgnored, git.loadIgnored, git.status]);

  const staged = git.stagedChanges;
  const tracked = git.trackedChanges;
  const untracked = git.untrackedChanges;
  /**
   * 未跟踪的层级照 IDEA 的暂存区（GitStageTree）：文件不多时并进「未暂存」一节，
   * 超过阈值才独立成节（否则一节被几千个未跟踪文件撑爆）。阈值同 IDEA 的 1000。
   */
  const untrackedInline = untracked.length <= UNTRACKED_INLINE_LIMIT;
  // 这一份拼出来的数组要能保住身份：它同时是 `groupView` 的缓存键，
  // 每次渲染现拼一个新数组的话，缓存永远命不中。
  const unstaged = useMemo(
    () => (untrackedInline ? [...tracked, ...untracked] : tracked),
    [untrackedInline, tracked, untracked]
  );
  /** IDEA 的 Unmerged 一节：这些文件只出现在这里，已暂存与未暂存两组都不含它们。 */
  const conflicts = git.conflictChanges;
  /** 停在变基/合并/优选/还原中间：横幅说明状况，继续和中止落到当前那个动作。 */
  const recovery = git.recovery;

  const flip = (current: Set<string>, key: string) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const toggleDir = (key: string) => setOpenDirs((current) => flip(current, key));
  const toggleGroup = (key: string) => setCollapsedGroups((current) => flip(current, key));

  const absolute = (relative: string) => git.absoluteOf(relative);

  const openMenu = (event: ReactMouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  /** 一组变更画成目录树、平铺列表，外面再按需套一层仓库根节点。 */
  const renderRows = (prefix: string, changes: GitChange[], isStaged: boolean, base: number) => {
    const stageLabel = isStaged ? t("git.unstage") : t("git.stage");
    /** 本组的目录树与聚合标记：目录行右端的圆点按它染色。同组的变更数组没换就沿用缓存。 */
    const { tree, marks: dirMarks } = groupView(changes);
    const move = (paths: string[]) => {
      const pathsAbsolute = paths.map(absolute);
      void (isStaged ? git.unstage(pathsAbsolute) : git.stage(pathsAbsolute));
    };
    const copyPath = (relative: string) => () => void navigator.clipboard.writeText(absolute(relative));
    /**
     * IDEA 的暂存树菜单（组 Git.Stage.Tree.Menu）。哪几项出现看这一行是什么状态：
     * 暂存只对未暂存与未跟踪、取消暂存只对已暂存、回滚只对未暂存。
     * 后端还做不到的几项（不带内容暂存、搁置、独立窗口比对、三向比对、从版本控制移除、
     * 以及冲突那三项）照 IDEA 摆出来但点不动。
     */
    const fileMenu = (change: GitChange): MenuItem[][] => [
      change.conflicted
        ? [
            { label: t("git.resolveConflicts"), icon: GitMerge, onSelect: onOpenResolve },
            {
              label: t("git.acceptTheirs"),
              icon: GitMerge,
              onSelect: () => void git.resolveConflict(absolute(change.path), "theirs"),
            },
            {
              label: t("git.acceptYours"),
              icon: GitMerge,
              onSelect: () => void git.resolveConflict(absolute(change.path), "ours"),
            },
          ]
        : [],
      [
        // 冲突行走的是上面那一组按一边了结；就地暂存会把冲突标记送进索引，回滚又清不掉索引里的三方。
        ...(change.conflicted
          ? []
          : isStaged
            ? [{ label: t("git.unstage"), icon: Minus, onSelect: () => move([change.path]) }]
            : [
                { label: t("git.stage"), icon: Plus, onSelect: () => move([change.path]) },
                ...(change.untracked
                  ? [{ label: t("git.stageNoContent"), icon: Plus, disabled: true }]
                  : []),
              ]),
        { label: t("git.stashFiles"), icon: Archive, disabled: true },
        ...(isStaged || change.untracked || change.conflicted
          ? []
          : [
              {
                label: t("git.rollback"),
                icon: Undo2,
                // 回滚未暂存的修改到暂存区索引，空 revision 表示恢复至 index
                onSelect: () => void git.restoreFile("", absolute(change.path)),
              },
            ]),
        ...(change.untracked
          ? [{ label: t("menu.delete"), icon: Trash2, onSelect: () => onFileAction("delete", change, isStaged) }]
          : [{ label: t("git.removeVcs"), icon: Minus, disabled: true }]),
        { label: t("git.ignoreFile"), icon: CircleSlash, onSelect: () => onFileAction("ignore", change, isStaged) },
      ],
      [
        { label: t("log.diffShow"), icon: FileDiff, onSelect: () => onOpenChange(change, isStaged, changes) },
        { label: t("git.standaloneDiff"), icon: FileDiff, disabled: true },
        { label: t("git.threeSideDiff"), icon: FileDiff, disabled: true },
        { label: t("log.editSource"), icon: Pencil, onSelect: () => onFileAction("editSource", change, isStaged) },
        { label: t("log.createPatch"), icon: SquarePlus, onSelect: () => onFileAction("patch", change, isStaged) },
        {
          label: t("git.patchToClipboard"),
          icon: ClipboardCopy,
          onSelect: () => onFileAction("patchClipboard", change, isStaged),
        },
        { label: t("menu.copyPath"), onSelect: copyPath(change.path) },
      ],
      [{ label: t("git.history"), icon: History, onSelect: () => onFileAction("history", change, isStaged) }],
    ];

    if (!groupByDir) {
      return changes.map((change) => (
        <div
          key={`${prefix}flat:${change.path}`}
          className="change-row"
          onContextMenu={(event) => openMenu(event, flatMenu(fileMenu(change)))}
        >
          <button
            type="button"
            className="change-main"
            style={{ paddingLeft: HEAD_MARK + base * 13 }}
            onClick={() => onOpenChange(change, isStaged, changes)}
            onDoubleClick={() => openByDoubleClick(change, isStaged, changes)}
            title={change.path}
          >
            <EntryIcon name={basenameOf(change.path)} size={13} />
            <span className="change-name">{change.path}</span>
            <span className={`change-mark ${markClass(changeMark(change))}`}>
              {changeMark(change)}
            </span>
          </button>
          {/* 冲突行不给就地暂存：带着冲突标记进索引等于把冲突藏起来。 */}
          {change.conflicted ? null : (
            <button
              type="button"
              className="icon-button change-stage"
              onClick={() => move([change.path])}
              title={stageLabel}
            >
              {isStaged ? <Minus size={14} /> : <Plus size={14} />}
            </button>
          )}
        </div>
      ));
    }

    const rows: FlatRow[] = [];
    flattenTree(tree, base, prefix, openDirs, rows);

    return rows.map((row) =>
      row.kind === "dir" ? (
        <div
          key={row.key}
          className="change-row"
          onContextMenu={(event) =>
            openMenu(event, [
              {
                label: stageLabel,
                onSelect: () => move(filesUnder(row.node).map((change) => change.path)),
              },
              { label: t("menu.copyPath"), onSelect: copyPath(row.node.path) },
            ])
          }
        >
          <button
            type="button"
            className="change-main"
            style={{ paddingLeft: HEAD_TEXT + row.depth * 13 }}
            onClick={() => toggleDir(row.key)}
            aria-expanded={row.open}
            title={row.node.path}
          >
            <span className="tree-chevron">
              {row.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
            <EntryIcon
              name={row.node.name}
              isDirectory
              isPackage={isUnderJvmSourceRoot(row.node.path)}
              size={13}
            />
            <span className="change-name">{row.node.name}</span>
            {dirMarks.get(row.node.path) ? (
              <span
                className={`change-dot ${markClass(dirMarks.get(row.node.path)!)}`}
                aria-hidden="true"
              />
            ) : null}
          </button>
          <button
            type="button"
            className="icon-button change-stage"
            onClick={() => move(filesUnder(row.node).map((change) => change.path))}
            title={stageLabel}
          >
            {isStaged ? <Minus size={14} /> : <Plus size={14} />}
          </button>
        </div>
      ) : (
        <div
          key={row.key}
          className="change-row"
          onContextMenu={(event) => openMenu(event, flatMenu(fileMenu(row.change)))}
        >
          <button
            type="button"
            className="change-main"
            style={{ paddingLeft: HEAD_MARK + row.depth * 13 }}
            onClick={() => onOpenChange(row.change, isStaged, changes)}
            onDoubleClick={() => openByDoubleClick(row.change, isStaged, changes)}
            title={row.change.path}
          >
            <EntryIcon name={basenameOf(row.change.path)} size={13} />
            <span className="change-name">{basenameOf(row.change.path)}</span>
            <span className={`change-mark ${markClass(changeMark(row.change))}`}>
              {changeMark(row.change)}
            </span>
          </button>
          {row.change.conflicted ? null : (
            <button
              type="button"
              className="icon-button change-stage"
              onClick={() => move([row.change.path])}
              title={stageLabel}
            >
              {isStaged ? <Minus size={14} /> : <Plus size={14} />}
            </button>
          )}
        </div>
      )
    );
  };

  /** 折叠全部要用的键：跟着当前这三组现算，不留历史残留。 */
  const allDirKeys = (groups: [string, GitChange[]][]) => {
    const keys: string[] = [];
    const walk = (node: DirNode, prefix: string) => {
      for (const dir of node.dirs) {
        keys.push(`${prefix}${dir.path}`);
        walk(dir, prefix);
      }
    };
    for (const [prefix, changes] of groups) {
      walk(buildTree(changes), prefix);
      if (groupByModule && changes.length > 0) keys.push(`${prefix}${MODULE_KEY}`);
    }
    return keys;
  };

  /** IDEA 的 isCommitAll：开着「提交全部」且暂存区是空的，提交对象换成全部已跟踪改动。 */
  const commitAll = commitAllWhenNothingStaged && staged.length === 0 && tracked.length > 0;

  const commit = async (andPush: boolean) => {
    const text = message.trim();
    if (!text && !amend) return;
    // 后端提交的是索引，所以这里先把那批文件替 IDEA 暂存上；中途失败会留在索引里，用「全部取消暂存」退得回去。
    if (commitAll) {
      const stagedAll = await git.stage(tracked.map((change) => absolute(change.path)));
      if (!stagedAll) return;
    }
    const done = await git.commit(text, amend);
    if (!done) return;
    onCommitted(text);
    setMessage("");
    setAmend(false);
    setAmendDetail(null);
    if (andPush) await git.push(false);
  };

  /** 双击落在哪一档由设置说：源文件走编辑器，否则和单击一样开比对。 */
  const openByDoubleClick = (change: GitChange, isStaged: boolean, siblings: GitChange[]) => {
    if (showOnDoubleClick === "source") onOpenSource(change);
    else onOpenChange(change, isStaged, siblings);
  };

  /** 有未合并文件时提交是锁住的，IDEA 那句 "Resolve conflicts in order to commit"。 */
  const canCommit =
    (message.trim().length > 0 || amend) &&
    (staged.length > 0 || commitAll || amend) &&
    conflicts.length === 0;

  /**
   * 一组：可折叠的组标题 + 可选的仓库根节点 + 它下面的变更。
   * 根节点收起时整组只剩标题行，对应 IDEA「模块」这一层。
   */
  const renderGroup = (
    prefix: string,
    label: string,
    changes: GitChange[],
    isStaged: boolean,
    link?: ReactNode
  ) => {
    if (changes.length === 0) return null;
    const rootKey = `${prefix}${MODULE_KEY}`;
    const open = openDirs.has(rootKey);
    return (
      <section className="change-group">
        {groupHead(prefix, label, changes.length, link)}
        {collapsedGroups.has(groupKey(prefix)) ? null : (
          <>
            {groupByModule ? (
              <div
                className="change-row is-module"
                onContextMenu={(event) =>
                  openMenu(event, [
                    {
                      label: isStaged ? t("git.unstage") : t("git.stage"),
                      onSelect: () =>
                        void (isStaged
                          ? git.unstage(changes.map((change) => absolute(change.path)))
                          : git.stage(changes.map((change) => absolute(change.path)))),
                    },
                    {
                      label: t("menu.copyPath"),
                      onSelect: () =>
                        void navigator.clipboard.writeText(git.root ?? workspaceRoot ?? ""),
                    },
                  ])
                }
              >
                <button
                  type="button"
                  className="change-main"
                  style={{ paddingLeft: HEAD_TEXT }}
                  onClick={() => toggleDir(rootKey)}
                  aria-expanded={open}
                  title={git.root ?? workspaceRoot}
                >
                  <span className="tree-chevron">
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </span>
                  <FolderGit2 size={13} className="entry-icon" aria-hidden="true" />
                  <span className="change-name">{repoName}</span>
                </button>
                {/* 模块行也带暂存/取消暂存：一次把整棵子树的文件都挪过去。 */}
                <button
                  type="button"
                  className="icon-button change-stage"
                  onClick={() =>
                    void (isStaged
                      ? git.unstage(changes.map((change) => absolute(change.path)))
                      : git.stage(changes.map((change) => absolute(change.path))))
                  }
                  title={isStaged ? t("git.unstage") : t("git.stage")}
                >
                  {isStaged ? <Minus size={14} /> : <Plus size={14} />}
                </button>
              </div>
            ) : null}
            {open ? renderRows(prefix, changes, isStaged, groupByModule ? 1 : 0) : null}
          </>
        )}
      </section>
    );
  };

  const groupHead = (prefix: string, label: string, count: number, link?: ReactNode) => {
    const key = groupKey(prefix);
    const open = !collapsedGroups.has(key);
    return (
      <header className="change-group-head">
        <button type="button" onClick={() => toggleGroup(key)} aria-expanded={open}>
          <span className="tree-chevron">
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
          <span>{label}</span>
        </button>
        {count > 0 ? <span className="change-count">{t("git.fileCount", { count })}</span> : null}
        {/* IDEA 在未合并那一节的标题后挂一颗 Resolve 链接。 */}
        {link ? <span className="group-link-wrap">{link}</span> : null}
      </header>
    );
  };

  /**
   * IDEA 那组数字数的是「按下提交会带走多少文件」，按状态分三档；
   * 图例形态放不下时自动退成 +N *N -N 那种紧凑写法。
   *
   * 这几颗钩子必须排在下面那两条「git 不可用 / 不是仓库」的早退之前：
   * 早退之后再用钩子，probe 由 null 变可用的那一次渲染钩子数就变了，React 直接抛错。
   */
  const tally = useMemo(() => {
    let added = 0;
    let deleted = 0;
    for (const change of staged) {
      if (change.indexStatus === "A") added += 1;
      else if (change.indexStatus === "D") deleted += 1;
    }
    return { added, modified: staged.length - added - deleted, deleted };
  }, [staged]);
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const linesRef = useRef<HTMLSpanElement>(null);
  /** 图例那一版放得下放不下；放不下就换紧凑版。 */
  const [narrow, setNarrow] = useState(false);
  /** 图例的自然宽度，紧凑版量不到自己该占多宽，只能拿它比。 */
  const legendWidth = useRef(0);

  useEffect(() => {
    const el = linesRef.current;
    const row = el?.parentElement;
    if (!el || !row) return;
    const measure = () => {
      if (!narrow) legendWidth.current = el.scrollWidth;
      // 这一行剩下的宽度：把除占位弹开那颗之外的兄弟都扣掉，再留出行距。
      const others = [...row.children].filter(
        (node) => node !== el && !(node instanceof HTMLElement && node.classList.contains("status-spacer"))
      );
      const used = others.reduce((sum, node) => sum + (node as HTMLElement).offsetWidth, 0) + others.length * 7;
      setNarrow(legendWidth.current > row.clientWidth - used);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [narrow, tally]);

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

  const total = git.status?.changes.length ?? 0;
  const lastCommit = git.lastCommit;
  /**
   * 修正目标：第一条永远是上次提交（HEAD），后面接还没推出去的那几条。
   * 全推出去了也至少留第一条——IDEA 那份清单空的时候同样退回「last commit」。
   */
  const amendList: AmendTarget[] = lastCommit
    ? [lastCommit, ...amendTargets.filter((commit) => commit.hash !== lastCommit.hash)]
    : amendTargets;

  /**
   * 整树那几件事。图标条、变更树空白处、模块行右键用的是同一套，
   * 只在这一处写，免得三处的禁用条件各写各的。
   */
  const stageAllTracked = () =>
    void git.stage(git.trackedChanges.map((change) => absolute(change.path)));
  const unstageAll = () => void git.unstage(staged.map((change) => absolute(change.path)));
  const collapseAll = () => {
    setOpenDirs(new Set());
    setCollapsedGroups(
      new Set([["s|"], ["w|"], ["u|"], ["ig|"]].map(([prefix]) => groupKey(prefix)))
    );
  };
  const expandAll = () => {
    setOpenDirs(new Set(allDirKeys([["s|", staged], ["w|", unstaged], ["u|", untracked]])));
    setCollapsedGroups(new Set());
  };
  const refreshAll = () => void git.refresh();

  /**
   * 空白处的菜单：只给整树动作。IDEA 在提交树空白处也不给「新建文件」那一类，
   * 那一类属于资源管理器。
   */
  const blankMenu: MenuItem[] = [
    {
      label: t("git.stageAllTracked"),
      onSelect: stageAllTracked,
      disabled: git.trackedChanges.length === 0,
    },
    { label: t("git.unstageAll"), onSelect: unstageAll, disabled: staged.length === 0 },
    { label: t("tool.collapseAll"), onSelect: collapseAll, disabled: total === 0 },
    { label: t("tool.expandAll"), onSelect: expandAll, disabled: total === 0 },
    { label: t("tool.refresh"), onSelect: refreshAll },
  ];

  /** 一行落在树里还是落在具体某条变更上：具体行自己有菜单，空白处才接。 */
  const onTreeBlankMenu = (event: ReactMouseEvent) => {
    if (event.target instanceof Element && event.target.closest(".change-row")) return;
    openMenu(event, blankMenu);
  };

  return (
    <div className="git-panel">
    {/* IDEA 的 View Options 弹层：分组依据与显示忽略都收在条内那颗齿轮里。 */}
    <Popover
      anchor={viewAnchor}
      onClose={() => setViewAnchor(null)}
      minWidth={230}
    >
      <p className="popover-label">{t("git.groupBy")}</p>
      {[
        { key: "dir", label: t("git.groupDir"), accel: `${MOD_LABEL}+Alt+P`, on: groupByDir, flip: onToggleByDir },
        {
          key: "module",
          label: t("git.groupModule"),
          accel: `${MOD_LABEL}+Alt+M`,
          on: groupByModule,
          flip: onToggleByModule,
        },
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
      {/* IDEA 把动作排成变更树上方的图标条，而不是散在组标题里。 */}
      <div className="commit-actions">
        <button
          type="button"
          className={`icon-button is-inline${git.loading ? " is-spinning" : ""}`}
          onClick={refreshAll}
          title={t("git.refresh")}
        >
          <RefreshCw size={14} />
        </button>
        {/* IDEA 这颗是 Stage All Tracked：只暂存已跟踪文件的改动，未跟踪的留给单独动作。 */}
        <button
          type="button"
          className="icon-button is-inline"
          onClick={stageAllTracked}
          disabled={git.trackedChanges.length === 0}
          title={t("git.stageAllTracked")}
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          className="icon-button is-inline"
          onClick={unstageAll}
          disabled={staged.length === 0}
          title={t("git.unstageAll")}
        >
          <ArrowDownToLine size={14} />
        </button>
        <button
          type="button"
          className="icon-button is-inline"
          onClick={collapseAll}
          disabled={total === 0}
          title={t("tool.collapseAll")}
        >
          <ChevronsDownUp size={14} />
        </button>
        <button
          type="button"
          className="icon-button is-inline"
          onClick={expandAll}
          disabled={total === 0}
          title={t("tool.expandAll")}
        >
          <ChevronsUpDown size={14} />
        </button>
        {/* IDEA 的 Git.Stage.Toolbar 以 View Options 收尾：分组依据与显示忽略都收在这层弹层里。 */}
        <button
          type="button"
          ref={viewRef}
          className={`icon-button is-inline${showIgnored ? " is-on" : ""}`}
          onClick={() => setViewAnchor((current) => (current ? null : viewRef.current))}
          aria-expanded={viewAnchor !== null}
          aria-haspopup="menu"
          title={t("git.viewOptions")}
        >
          <Eye size={14} />
        </button>
      </div>

      {recovery ? (
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
      ) : null}

      {/* IDEA 的 Commit 工具窗口：变更树占上方剩余高度，说明框和提交按钮压在底部。 */}
      <div className="commit-tree" onContextMenu={onTreeBlankMenu}>
        {total === 0 ? <p className="panel-note">{t("git.clean")}</p> : null}

        {renderGroup(
          "c|",
          t("git.unmerged"),
          conflicts,
          false,
          <button type="button" className="group-link" onClick={onOpenResolve}>
            {t("git.resolve")}
          </button>
        )}
        {renderGroup("s|", t("git.staged"), staged, true)}
        {renderGroup("w|", t("git.changes"), unstaged, false)}
        {untrackedInline ? null : renderGroup("u|", t("git.untracked"), untracked, false)}

        {showIgnored && ignored.length > 0 ? (
          <section className="change-group">
            {groupHead("ig|", t("git.ignored"), ignored.length)}
            {collapsedGroups.has(groupKey("ig|")) ? null : ignored.map((relative) => (
              <div key={`ig|${relative}`} className="change-row is-ignored">
                <button
                  type="button"
                  className="change-main"
                  style={{ paddingLeft: HEAD_MARK }}
                  onClick={() => onOpenFile(absolute(relative))}
                  title={relative}
                >
                  <EntryIcon name={basenameOf(relative)} size={13} />
                  <span className="change-name">{relative}</span>
                  <span className="change-mark is-empty" aria-hidden="true">
                    <CircleSlash size={12} />
                  </span>
                </button>
              </div>
            ))}
          </section>
        ) : null}
        {/* 修正那一节排在整棵树最底下：那次提交改到的文件，标题就是它的说明。 */}
        {amend && amendDetail && amendDetail.files.length > 0 ? (
          <section className="change-group">
            {groupHead("a|", amendDetail.subject || amendDetail.short, amendDetail.files.length)}
            {collapsedGroups.has(groupKey("a|")) ? null : (
              <>
                {groupByModule ? (
                  <div
                    className="change-row is-module"
                    onContextMenu={(event) =>
                      openMenu(event, [
                        // 修正那一节是只读的：那次提交改了哪些文件，动不了索引，
                        // 所以这里只给得出复制路径。
                        {
                          label: t("menu.copyPath"),
                          onSelect: () =>
                            void navigator.clipboard.writeText(git.root ?? workspaceRoot ?? ""),
                        },
                      ])
                    }
                  >
                    <button
                      type="button"
                      className="change-main"
                      style={{ paddingLeft: HEAD_TEXT }}
                      title={git.root ?? ""}
                    >
                      <span className="tree-chevron" />
                      <FolderGit2 size={13} className="entry-icon" aria-hidden="true" />
                      <span className="change-name">{repoName}</span>
                    </button>
                  </div>
                ) : null}
                {amendDetail.files.map((file) => (
                  <div key={`a|${file.path}`} className="change-row">
                    <button
                      type="button"
                      className="change-main"
                      style={{ paddingLeft: HEAD_MARK + (groupByModule ? 13 : 0) }}
                      onClick={() => onOpenCommitFile(amendDetail.hash, file)}
                      title={file.path}
                    >
                      <EntryIcon name={basenameOf(file.path)} size={13} />
                      <span className="change-name">{file.path}</span>
                      {file.status ? (
                        <span className={`change-mark ${markClass(file.status)}`}>{file.status}</span>
                      ) : null}
                    </button>
                  </div>
                ))}
              </>
            )}
          </section>
        ) : null}
      </div>

      {/* 提交区能拖上面这条改高矮，也能整个收起来只留那行工具。 */}
      {commitCollapsed ? null : (
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
            const max = panel ? panel.clientHeight - 120 : window.innerHeight - 240;
            const grown = drag.startHeight + drag.startY - event.clientY;
            setCommitHeight(Math.max(120, Math.min(max, grown)));
          }}
          onPointerUp={() => {
            commitDrag.current = null;
          }}
        />
      )}

      <div
        ref={commitBoxRef}
        className={`commit-box${commitCollapsed ? " is-collapsed" : ""}`}
        style={!commitCollapsed && commitHeight !== null ? { flex: "none", height: commitHeight } : undefined}
      >
        <div className="commit-box-head">
          <label className="commit-amend" title={t("git.amendLong")}>
            <input
              type="checkbox"
              checked={amend}
              onChange={(event) => switchAmend(event.target.checked)}
            />
            <span>{t("git.amend")}</span>
          </label>
          {lastCommit ? (
            <button
              type="button"
              ref={amendRef}
              className={`commit-last${amend ? " is-on" : ""}`}
              title={t("git.pickAmendTarget")}
              aria-expanded={amendAnchor !== null}
              aria-haspopup="menu"
              onClick={() => {
                if (amendAnchor) {
                  setAmendAnchor(null);
                  return;
                }
                void git.loadAmendTargets().then(setAmendTargets);
                setAmendAnchor(amendRef.current);
              }}
            >
              <GitCommit size={12} aria-hidden="true" />
              <span>{t("git.lastCommit")}</span>
              <ChevronDown size={11} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            ref={historyRef}
            className="icon-button is-inline"
            onClick={() => setHistoryAnchor((current) => (current ? null : historyRef.current))}
            disabled={history.length === 0}
            title={t("git.messageHistory")}
            aria-expanded={historyAnchor !== null}
          >
            <History size={13} />
          </button>
          <span className="status-spacer" />
          {staged.length > 0 ? (
            <span className="commit-lines" ref={linesRef}>
              {narrow ? (
                <>
                  {tally.added > 0 ? <span className="is-added">+{number.format(tally.added)}</span> : null}
                  {tally.modified > 0 ? (
                    <span className="is-modified">*{number.format(tally.modified)}</span>
                  ) : null}
                  {tally.deleted > 0 ? (
                    <span className="is-deleted">-{number.format(tally.deleted)}</span>
                  ) : null}
                </>
              ) : (
                <>
                  {tally.added > 0 ? (
                    <span className="is-added">
                      {t("git.filesAdded", { count: number.format(tally.added) })}
                    </span>
                  ) : null}
                  {tally.modified > 0 ? (
                    <span className="is-modified">
                      {t("git.filesModified", { count: number.format(tally.modified) })}
                    </span>
                  ) : null}
                  {tally.deleted > 0 ? (
                    <span className="is-deleted">
                      {t("git.filesDeleted", { count: number.format(tally.deleted) })}
                    </span>
                  ) : null}
                </>
              )}
            </span>
          ) : null}
          <button
            type="button"
            className="icon-button is-inline commit-fold"
            onClick={() => setCommitCollapsed((folded) => !folded)}
            title={t(commitCollapsed ? "git.expandCommit" : "git.collapseCommit")}
            aria-expanded={!commitCollapsed}
          >
            {commitCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>

        {commitCollapsed ? null : (
          <>
            <textarea
              ref={inputRef}
              className="commit-input"
              value={message}
              placeholder={t("git.messagePlaceholder")}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void commit(false);
                }
              }}
            />

            {conflicts.length > 0 ? (
              <p className="commit-note is-conflict">
                <AlertTriangle size={13} aria-hidden="true" />
                <span>{t("git.resolveToCommit")}</span>
                <button type="button" className="group-link" onClick={onOpenResolve}>
                  {t("git.resolve")}
                </button>
              </p>
            ) : null}

            <div className="commit-buttons">
              <button
                type="button"
                className="button is-primary commit-button"
                disabled={!canCommit}
                onClick={() => void commit(false)}
              >
                {t(amend ? "git.amendButton" : "git.commitButton")}
              </button>
              <button
                type="button"
                className="button"
                disabled={!canCommit}
                onClick={() => void commit(true)}
              >
                {t("git.commitAndPush")}
              </button>
              {staged.length === 0 && !amend ? (
                <p className="commit-hint">{t("git.nothingStaged")}</p>
              ) : null}
            </div>
          </>
        )}
      </div>

      <Popover anchor={amendAnchor} onClose={() => setAmendAnchor(null)} minWidth={300}>
        <p className="popover-label">{t("git.pickAmendTarget")}</p>
        {amendList.map((commit, index) => (
          <button
            key={commit.hash}
            type="button"
            className="popover-item"
            disabled={index > 0}
            title={index > 0 ? t("git.amendNeedsRewrite") : commit.subject}
            onClick={() => {
              setAmendAnchor(null);
              switchAmend(true);
            }}
          >
            {index === 0 && amend ? (
              <Check size={13} aria-hidden="true" />
            ) : (
              <span className="menu-icon-spacer" />
            )}
            <span className="popover-item-label">
              {index === 0 ? t("git.lastCommit") : commit.subject}
            </span>
            <span className="popover-accel">{commit.short}</span>
          </button>
        ))}
      </Popover>

      <Popover anchor={historyAnchor} onClose={() => setHistoryAnchor(null)} minWidth={300}>
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

      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
