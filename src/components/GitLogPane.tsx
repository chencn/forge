import { memo, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardCopy,
  Download,
  Eye,
  FileDiff,
  Folder,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  History,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RefreshCw,
  Regex,
  RotateCcw,
  Search,
  Settings,
  SquarePlus,
  Star,
  Tag,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import type {
  GitBranch as GitBranchRef,
  GitCommit,
  GitCommitDetail,
  GitCommitFile,
  GitNameStatus,
} from "../lib/git";
import {
  EMPTY_TREE_HASH,
  gitAuthors,
  gitCommitDetail,
  gitDiffNames,
  gitDiffText,
  gitLog,
  isDeletedMark,
  markClass,
} from "../lib/git";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor, MenuItem } from "./ContextMenu";
import EntryIcon from "./EntryIcon";
import Popover from "./Popover";
import Select from "./Select";
import { collapsePackageDirs, isUnderJvmSourceRoot } from "../lib/jvm";
import { MOD_LABEL } from "../lib/sys";
import type { GitState } from "../hooks/useGitState";
import type { BranchSettings } from "../lib/settings";
import { withFavoriteToggled } from "../lib/settings";
import { commitStamp } from "../lib/format";
import { errorText } from "../lib/fs";
import { buildRefMenu, upstreamOf } from "../lib/refMenu";
import type { RefAction, RefTarget } from "../lib/refMenu";
import { useI18n } from "../i18n";

/* 引用动作的类型与菜单本体都在 lib/refMenu：日志的分支树和主工具栏的分支弹层共用。 */
export type { RefAction, RefTarget } from "../lib/refMenu";

/** 第三栏文件行右键菜单的动作；置灰那几项不在这份名单里。 */
export type FileAction =
  | "diff"
  | "diffNewTab"
  | "diffLocal"
  | "diffParentLocal"
  | "openRepoVersion"
  | "revert"
  | "patch"
  | "getFromRevision"
  | "diffParent";

/** 中列提交行右键里要弹窗或动仓库的那几条，落到 App 去办。 */
export type CommitAction =
  | "checkout"
  | "newBranch"
  | "newTag"
  | "patch"
  | "cherryPick"
  | "revert"
  | "resetSoft"
  | "resetMixed"
  | "resetHard"
  | "uncommit"
  | "reword"
  | "pushUpTo";

interface GitLogPaneProps {
  git: GitState;
  /** 日志里的错误走同一条告警通道，跟面板其它地方一致。 */
  reportError: (message: string) => void;
  /** 文件行的动作落到 App：开比对标签、读写工作区、落补丁都由它做。 */
  onFileAction: (action: FileAction, commit: GitCommitDetail, file: GitCommitFile) => void;
  /** 「与工作树的差异」模式下一行双击：比对引用与工作区两侧；第三份是这一串文件，供顶栏左右箭头走。 */
  onCompareWork: (revision: string, entry: GitNameStatus, siblings: GitNameStatus[]) => void;
  /** 编辑源：把工作区里那份文件开进编辑器。 */
  onEditSource: (path: string) => void;
  /** 引用树上的动作，只有「比较」和「与工作树的差异」留在这层改第三栏。 */
  onRefAction: (action: RefAction, target: RefTarget) => void;
  /** 提交行右键里要弹窗或动仓库的那几条：建分支/建标签/落补丁/签出这条修订。 */
  onCommitAction: (action: CommitAction, commit: GitCommit) => void;
  /** 「比较版本」：恰好选中两条时，把这两条之间的差异交给 App 开比对标签。 */
  onCompareCommits: (left: GitCommit, right: GitCommit) => void;
  /** 分支面板齿轮读写的显示开关，和顶栏分支弹层是同一份。 */
  options: BranchSettings;
  onOptions: (next: BranchSettings) => void;
  /** 模块行（仓库根）显示的名字。 */
  repoName: string;
  /** 中列筛到哪条引用。提在 App 是因为分支弹层那两处动作也要改它。 */
  reference: string;
  setReference: (revision: string) => void;
  /** 第三栏的「与工作树的差异」目标；null 表示列的是选中提交的改动。 */
  compareRef: string | null;
  setCompareRef: (revision: string | null) => void;
  /** 中列只看改过这个路径的提交；提交窗口里的「历史记录」也写它。 */
  pathFilter: string;
  setPathFilter: (path: string) => void;
}

/** 日期下拉的三档，值就是往回推多少毫秒。 */
const SINCE_MS: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** 日志窗口的三栏，从左到右。 */
type LogColumn = "refs" | "list" | "detail";

/** 第三栏树里的一行文件：提交模式带行数，比对模式只有状态。 */
interface TreeItem {
  path: string;
  oldPath: string;
  status: string;
  added: number;
  removed: number;
}

/** 文件树的一层目录。 */
interface FileNode {
  name: string;
  path: string;
  dirs: FileNode[];
  files: TreeItem[];
}

/** 引用树的一片叶子：显示名与交给 git 的全名可以不同（远端叶子只写后半截）。 */
interface RefLeaf {
  label: string;
  value: string;
  badge?: ReactNode;
  target: RefTarget;
}

/** 引用树的一层目录，由名字里的斜杠现拆。 */
interface RefNode {
  name: string;
  path: string;
  dirs: RefNode[];
  leaves: RefLeaf[];
}

function buildFileTree(items: TreeItem[]): FileNode {
  const root: FileNode = { name: "", path: "", dirs: [], files: [] };
  /** 每层的「子目录路径 → 节点」索引：逐段 `dirs.find` 在同级目录多时是平方量级。 */
  const indexes = new Map<FileNode, Map<string, FileNode>>();
  for (const item of items) {
    const parts = item.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let bucket = indexes.get(node);
      if (!bucket) {
        bucket = new Map<string, FileNode>();
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
    node.files.push(item);
  }
  const sortInto = (node: FileNode) => {
    node.dirs.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.path.localeCompare(b.path));
    for (const dir of node.dirs) sortInto(dir);
  };
  sortInto(root);
  // 单子目录链压成一行；JVM 源码根之下用 `.`（com.example.demo），其余用 `/`（a/b/c）。
  root.dirs = root.dirs.map((dir) => collapsePackageDirs(dir));
  return root;
}

/** 树按那一份 items 数组缓存：第三栏每次渲染都要用，而换提交才会真的换内容。 */
const treeCache = new WeakMap<TreeItem[], FileNode>();

function fileTree(items: TreeItem[]): FileNode {
  let hit = treeCache.get(items);
  if (!hit) {
    hit = buildFileTree(items);
    treeCache.set(items, hit);
  }
  return hit;
}

/** 目录行右端那个「几个文件」：整棵树里每个目录行都要算一次，不缓存就是每渲染一遍全递归一次。 */
const underCache = new WeakMap<FileNode, TreeItem[]>();

function filesUnder(node: FileNode): TreeItem[] {
  const hit = underCache.get(node);
  if (hit) return hit;
  const all = [...node.files, ...node.dirs.flatMap(filesUnder)];
  underCache.set(node, all);
  return all;
}

/** 按斜杠把引用嵌成目录；返回的那层里 leaves 是不含斜杠的那一批。 */
function buildRefTree(leaves: RefLeaf[]): RefNode {
  const root: RefNode = { name: "", path: "", dirs: [], leaves: [] };
  for (const leaf of leaves) {
    const parts = leaf.label.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let next = node.dirs.find((dir) => dir.path === path);
      if (!next) {
        next = { name: part, path, dirs: [], leaves: [] };
        node.dirs.push(next);
      }
      node = next;
    }
    node.leaves.push(leaf);
  }
  const sortInto = (node: RefNode) => {
    node.dirs.sort((a, b) => a.name.localeCompare(b.name));
    node.leaves.sort((a, b) => a.label.localeCompare(b.label));
    for (const dir of node.dirs) sortInto(dir);
  };
  sortInto(root);
  return root;
}

/** 引用树里每层目录的折叠键，直接从分支名算出来，和 buildRefTree 的累计方式一致。 */
function refDirKeysOf(labels: string[]): string[] {
  const keys = new Set<string>();
  for (const label of labels) {
    let path = "";
    for (const part of label.split("/").slice(0, -1)) {
      path = path ? `${path}/${part}` : part;
      keys.add(`refdir/${path}`);
    }
  }
  return [...keys];
}

/** IDEA 的日志窗口：左边引用树，中间提交列表，右边这次提交的文件清单与元信息。 */
function GitLogPane({
  git,
  reportError,
  onFileAction,
  onCompareWork,
  onEditSource,
  onRefAction,
  onCommitAction,
  onCompareCommits,
  options,
  onOptions,
  repoName,
  reference,
  setReference,
  compareRef,
  setCompareRef,
  pathFilter,
  setPathFilter,
}: GitLogPaneProps) {
  const { t, locale } = useI18n();
  const [text, setText] = useState("");
  const [regex, setRegex] = useState(false);
  const [author, setAuthor] = useState("");
  /** 日期档位：空串不限，其余见 SINCE_MS。 */
  const [since, setSince] = useState("");
  const [refQuery, setRefQuery] = useState("");
  /** 文件历史过滤：只列改到这个路径的提交；空表示不限。 */
  /** 收起来的分组，包括每个远端自己那一层；不在里面就是展开。 */
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());
  /** 三栏的宽度比，默认 2:4:3；拖哪条分隔条就只重分它左右两栏。 */
  const [weights, setWeights] = useState<Record<LogColumn, number>>({
    refs: 2,
    list: 4,
    detail: 3,
  });
  /** 右栏底部那块提交信息，收起来只剩一行标题。 */
  const [infoClosed, setInfoClosed] = useState(false);
  /** 第三栏文件树的四个视图开关，⋮ 眼睛弹层和快捷键都能翻。 */
  const [groupDir, setGroupDir] = useState(true);
  const [groupModule, setGroupModule] = useState(true);
  const [showDetails, setShowDetails] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  /** 第三栏文件树收起来的目录，键带当前数据源前缀。 */
  const [closedFileDirs, setClosedFileDirs] = useState<Set<string>>(new Set());
  const [optionsAnchor, setOptionsAnchor] = useState<HTMLElement | null>(null);
  const optionsRef = useRef<HTMLButtonElement>(null);
  const [compareFiles, setCompareFiles] = useState<GitNameStatus[] | null>(null);
  /** 引用树上选中（点过或右键过）的那条；Delete 等键位作用在它身上。 */
  const [pickedRef, setPickedRef] = useState<RefTarget | null>(null);
  const colDrag = useRef<{
    left: LogColumn;
    right: LogColumn;
    startX: number;
    span: number;
    sum: number;
    startLeft: number;
  } | null>(null);

  const [commits, setCommits] = useState<GitCommit[]>([]);
  /** 「用户」下拉的候选：最近这些条提交里出现过的人。 */
  const [authors, setAuthors] = useState<string[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [signal, setSignal] = useState(0);
  /**
   * 中列的选中集，按点击的先后排；最后一颗是详情栏跟着走的那条。
   * IDEA 的提交行菜单里好几项要看选中几条，所以这里不能只留一条。
   */
  const [picked, setPicked] = useState<string[]>([]);
  const selectedHash = picked[picked.length - 1] ?? null;
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [pickedFile, setPickedFile] = useState<string | null>(null);
  /** 差异预览区的统一差异文本；null 表示还没取或没开预览。 */
  const [preview, setPreview] = useState<string | null>(null);
  /** 引用树上右键弹出的那条菜单；null 表示没有开。 */
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** 抓取期间按钮自己转起来并禁用。 */
  const [fetching, setFetching] = useState(false);
  /** 分支面板整块收起时，只剩这条动作条贴在日志左边。 */
  const [refsHidden, setRefsHidden] = useState(false);
  /** 齿轮弹层（视图选项）挂在这颗钮上。 */
  const gearRef = useRef<HTMLButtonElement>(null);
  const [gearAnchor, setGearAnchor] = useState<HTMLElement | null>(null);

  const root = git.root;

  /** 详情栏里作者时间和提交时间的画法。 */
  const stamp = (ms: number) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(ms)
    );

  // 文本框每敲一个字都查一次 git 太吵，落定 250ms 再查；其余筛选是选出来的，不用等。
  const [settledText, setSettledText] = useState(text);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettledText(text), 250);
    return () => window.clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    if (!root) {
      setCommits([]);
      setAuthors([]);
      return;
    }
    let stale = false;
    // 候选名单取不到不该打扰人，下拉空着就是只有「不限」这一档。
    void gitAuthors(root, 500).then(
      (list) => {
        if (!stale) setAuthors(list);
      },
      () => {}
    );
  }, [root, signal]);

  useEffect(() => {
    if (!root) {
      setCommits([]);
      return;
    }
    let stale = false;
    setLogLoading(true);
    void gitLog(root, {
      text: settledText,
      regex,
      author,
      reference,
      path: pathFilter,
      sinceMs: since ? Date.now() - SINCE_MS[since] : 0,
      limit: 200,
    })
      .then((list) => {
        if (stale) return;
        setCommits(list);
        // 上一次选中的提交可能被过滤掉了，落到列表第一条。
        setPicked((current) => {
          const kept = current.filter((hash) => list.some((commit) => commit.hash === hash));
          return kept.length > 0 ? kept : list.slice(0, 1).map((commit) => commit.hash);
        });
      })
      .catch((cause: unknown) => {
        if (stale) return;
        // 查询本身失败了，留着上一次的结果会让人以为过滤生效了。
        setCommits([]);
        setPicked([]);
        reportError(errorText(cause));
      })
      .finally(() => {
        if (!stale) setLogLoading(false);
      });
    return () => {
      stale = true;
    };
    // HEAD 一动就得重查：引用留空那一档查的就是「当前分支」，签出别的分支或提交完
    // HEAD 前移，列表停在旧结果会让人拿别的分支的历史做重置、优选。
  }, [root, settledText, regex, author, reference, pathFilter, since, signal, reportError, git.lastCommit?.hash, git.status?.branch]);

  useEffect(() => {
    if (!root || !selectedHash) {
      setDetail(null);
      return;
    }
    let stale = false;
    setPickedFile(null);
    void gitCommitDetail(root, selectedHash)
      .then((next) => {
        if (stale) return;
        setDetail(next);
        // 顺手点亮它改的第一个文件，双击才把比对开到标签页里，免得一次点击塞一个标签。
        const first = next.files[0];
        if (first) setPickedFile(first.path);
      })
      .catch((cause: unknown) => {
        if (!stale) reportError(errorText(cause));
      });
    return () => {
      stale = true;
    };
  }, [root, selectedHash, reportError]);

  useEffect(() => {
    if (!root || !compareRef) {
      setCompareFiles(null);
      return;
    }
    let stale = false;
    void gitDiffNames(root, compareRef)
      .then((list) => {
        if (!stale) setCompareFiles(list);
      })
      .catch((cause: unknown) => {
        if (!stale) reportError(errorText(cause));
      });
    return () => {
      stale = true;
    };
  }, [root, compareRef, signal, reportError]);

  const activeFile = detail?.files.find((file) => file.path === pickedFile) ?? null;

  useEffect(() => {
    if (!showPreview || !root || !detail || !activeFile) {
      setPreview(null);
      return;
    }
    let stale = false;
    const left = detail.parents[0] ?? EMPTY_TREE_HASH;
    void gitDiffText(root, left, detail.hash, git.absoluteOf(activeFile.path))
      .then((diff) => {
        if (!stale) setPreview(diff);
      })
      .catch((cause: unknown) => {
        if (!stale) {
          setPreview("");
          reportError(errorText(cause));
        }
      });
    return () => {
      stale = true;
    };
  }, [showPreview, root, detail, activeFile, reportError, git.absoluteOf]);

  const toggleGroup = (key: string) =>
    setClosedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const openGroup = (key: string) => !closedGroups.has(key);

  const toggleFileDir = (key: string) =>
    setClosedFileDirs((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const colStyle = (key: LogColumn) => ({ flexGrow: weights[key], flexBasis: 0 });

  /** 一条竖向分隔条：拖它只重分左右两栏，其余栏不受影响。 */
  const splitter = (left: LogColumn, right: LogColumn) => (
    <div
      role="separator"
      aria-orientation="vertical"
      className="panel-splitter is-vertical"
      onPointerDown={(event) => {
        const bar = event.currentTarget;
        colDrag.current = {
          left,
          right,
          startX: event.clientX,
          // 拿这两栏自己的像素宽度当基准，拖多少就走多少，不被第三栏稀释。
          span:
            (bar.previousElementSibling?.clientWidth ?? 0) +
            (bar.nextElementSibling?.clientWidth ?? 0),
          sum: weights[left] + weights[right],
          startLeft: weights[left],
        };
        bar.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = colDrag.current;
        if (!drag || drag.span < 40) return;
        const shift = ((event.clientX - drag.startX) / drag.span) * drag.sum;
        const grown = Math.min(drag.sum - 0.6, Math.max(0.6, drag.startLeft + shift));
        setWeights((current) => ({
          ...current,
          [drag.left]: grown,
          [drag.right]: drag.sum - grown,
        }));
      }}
      onPointerUp={() => {
        colDrag.current = null;
      }}
    />
  );

  const needle = refQuery.trim().toLowerCase();
  /**
   * 引用的分堆按这一份缓存。三趟过滤加一次分组写在渲染体里，而日志面板会因为
   * 选提交、拖列宽、轮询这些跟引用毫不相干的事反复重渲染——分支多的仓库就是几百条各扫一遍。
   */
  const { locals, remotes, tags, remoteGroups } = useMemo(() => {
    const hit = (name: string) => needle === "" || name.toLowerCase().includes(needle);
    const localList = git.branches.filter((branch) => !branch.remote && hit(branch.name));
    const remoteList = git.branches.filter((branch) => branch.remote && hit(branch.name));
    /** 远程先按远端分堆，堆里的叶子只写远端名后面那截。 */
    const groups = new Map<string, GitBranchRef[]>();
    for (const branch of remoteList) {
      const remote = branch.name.slice(0, branch.name.indexOf("/"));
      const list = groups.get(remote);
      if (list) list.push(branch);
      else groups.set(remote, [branch]);
    }
    return {
      locals: localList,
      remotes: remoteList,
      tags: git.tags.filter((tag) => hit(tag.name)),
      remoteGroups: groups,
    };
  }, [git.branches, git.tags, needle]);
  const filtering =
    text !== "" || author !== "" || reference !== "" || since !== "" || pathFilter !== "";
  const clearFilters = useCallback(() => {
    setText("");
    setAuthor("");
    setReference("");
    setSince("");
    setPathFilter("");
  }, []);

  // 菜单上画了的键位必须真能用；输入框和编辑器里的按键一律让行。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      /** 只选中一条时的那行；菜单上好几项和左右箭头都只作用在「恰好一条」上。 */
      const sole = picked.length === 1 ? (commits.find((row) => row.hash === picked[0]) ?? null) : null;
      // 主修饰键按平台认：macOS 上是 Cmd（与 App 侧提交分组的同一对键位保持一致）。
      const mod = event.ctrlKey || event.metaKey;
      if (event.ctrlKey && event.altKey && event.shiftKey && !event.metaKey && key === "c") {
        event.preventDefault();
        void navigator.clipboard.writeText(picked.join("\n"));
        return;
      }
      if (mod && event.altKey && !event.shiftKey) {
        if (key === "p") {
          event.preventDefault();
          setGroupDir((value) => !value);
        } else if (key === "m") {
          event.preventDefault();
          setGroupModule((value) => !value);
        } else if (key === "n" && sole) {
          event.preventDefault();
          onCommitAction("newBranch", sole);
        }
        return;
      }
      if (event.ctrlKey && !event.altKey && !event.metaKey && key === "d") {
        if (detail && activeFile) {
          event.preventDefault();
          onFileAction("diff", detail, activeFile);
        }
        return;
      }
      if (event.key === "F12") {
        if (activeFile) {
          event.preventDefault();
          onEditSource(activeFile.path);
        }
        return;
      }
      if (
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        sole
      ) {
        // 左边是子提交、右边是父提交，和 IDEA 图上的箭头一致；这一侧没有可跳的行就不抢按键。
        const next =
          event.key === "ArrowLeft"
            ? commits.find((row) => row.parents.includes(sole.hash))
            : sole.parents
                .map((hash) => commits.find((row) => row.hash === hash))
                .find((row) => row !== undefined);
        if (next) {
          event.preventDefault();
          setPicked([next.hash]);
        }
        return;
      }
      if (!pickedRef) return;
      if (event.ctrlKey && event.shiftKey && !event.altKey && key === "k") {
        event.preventDefault();
        onRefAction("push", pickedRef);
      } else if (event.altKey && event.shiftKey && !event.ctrlKey && key === "r") {
        if (pickedRef.kind === "local") {
          event.preventDefault();
          onRefAction("rename", pickedRef);
        }
      } else if (event.key === "Delete") {
        // 只认分支树里焦点落过的那一下：资源管理器侧也绑了 Delete，两边都接手会先弹出
        // 「永久删除文件」的确认框，删掉的是盘上的东西，不是这条引用。
        if (target?.closest(".log-refs")) {
          event.preventDefault();
          event.stopImmediatePropagation();
          onRefAction("delete", pickedRef);
        }
      } else if (event.key === "Enter") {
        // 这条只管分支树里有焦点的那一下：回车把日志收到选中的那条引用上。
        if (target?.closest(".log-refs")) {
          event.preventDefault();
          setReference(pickedRef.name);
        }
      } else if (key === " " && pickedRef.kind !== "tag") {
        // 空格翻收藏，同样只认分支树里的那一下按键。
        if (target?.closest(".log-refs")) {
          event.preventDefault();
          toggleFavorite(pickedRef);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    commits,
    picked,
    detail,
    activeFile,
    pickedRef,
    onFileAction,
    onEditSource,
    onCommitAction,
    onRefAction,
    setReference,
    options,
    onOptions,
  ]);

  if (!root) {
    return <p className="panel-note">{t("git.notARepo")}</p>;
  }

  const openMenu = (event: ReactMouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  /** 单击只留这一条；Ctrl 加选或取消；Shift 按列表里的可见顺序连选。 */
  const pickCommit = (commit: GitCommit, event: ReactMouseEvent) => {
    if (event.ctrlKey || event.metaKey) {
      setPicked((current) =>
        current.includes(commit.hash)
          ? current.filter((hash) => hash !== commit.hash)
          : [...current, commit.hash]
      );
      return;
    }
    const anchor = commits.findIndex((row) => row.hash === selectedHash);
    const here = commits.findIndex((row) => row.hash === commit.hash);
    if (event.shiftKey && anchor >= 0 && here >= 0) {
      const [lo, hi] = anchor <= here ? [anchor, here] : [here, anchor];
      setPicked(commits.slice(lo, hi + 1).map((row) => row.hash));
      return;
    }
    setPicked([commit.hash]);
  };

  /**
   * IDEA 的 Vcs.Log.ContextMenu，次序照平台那份组声明加上 git4idea 插进来的那批。
   * 门控也照它：多数项要求恰好选中一条，合并提交还原不了（要先定并入哪一条父提交），
   * 撤销与改写说明那一族只在 HEAD 那条提交上生效。
   * 修补 / 压缩到 / 删除提交 / 压缩提交 / 交互式变基这几项要的是变基待办那条通道，
   * 「在修订版中显示仓库」要拼远端网页地址；落点没有就不摆出来，摆了就是点不动的死控件。
   */
  const commitMenu = (event: ReactMouseEvent, commit: GitCommit) => {
    /* 右键落在没选中的行上时选中集先换成它自己。这一句菜单的门控读就地算出来的那份，不读 state：
       setPicked 要下一次渲染才生效，读 picked 会让刚右键这一行的那次判定还停在旧选择集上。 */
    if (!picked.includes(commit.hash)) setPicked([commit.hash]);
    const current = picked.includes(commit.hash) ? picked : [commit.hash];
    const one = current.length === 1 ? commit : null;
    const needOne = current.length === 1 ? undefined : t("log.needOneCommit");
    const atHead = one !== null && git.lastCommit?.hash === one.hash;
    const needHead = atHead ? undefined : t("log.onlyAtHead");
    const merged = one !== null && one.parents.length > 1;
    const branch = git.status && !git.status.detached ? git.status.branch : "";
    const canPush = branch !== "" && (git.probe?.remotes.length ?? 0) > 0;
    const pair =
      current.length === 2
        ? (current.map((hash) => commits.find((row) => row.hash === hash)) as (GitCommit | undefined)[])
        : null;
    const pairBoth = pair !== null && pair[0] !== undefined && pair[1] !== undefined;
    // 父、子都只能在看得见的这些行里跳；跳不出去的那条给原因，不留一颗空箭头。
    const parents = one ? one.parents.filter((hash) => commits.some((row) => row.hash === hash)) : [];
    const children = one ? commits.filter((row) => row.parents.includes(one.hash)) : [];
    const jump = (hash: string) => () => setPicked([hash]);
    const gotoItem = (
      label: string,
      shortcut: string,
      icon: typeof GitBranch,
      targets: { hash: string; text: string }[]
    ): MenuItem => {
      if (targets.length === 0) {
        return { label, icon, shortcut, disabled: true, hint: t("log.noNeighbour") };
      }
      const only = targets[0];
      if (targets.length === 1) {
        return { label, icon, shortcut, onSelect: jump(only.hash) };
      }
      return {
        label,
        icon,
        shortcut,
        children: targets.map((target) => ({
          label: target.text,
          onSelect: jump(target.hash),
        })),
      };
    };
    const named = (hash: string) => {
      const row = commits.find((commit2) => commit2.hash === hash);
      return row ? `${row.subject} (${row.short})` : hash.slice(0, 8);
    };
    /** IDEA 的签出子菜单：本地分支挨个列，当前那条不算，末尾再挂「签出修订」。 */
    const localCheckout = git.branches
      .filter((ref) => !ref.remote && !ref.current)
      .map((ref) => ref.name);

    openMenu(event, [
      {
        label: t("log.copyRevisionNumber"),
        icon: ClipboardCopy,
        shortcut: `${MOD_LABEL}+Alt+Shift+C`,
        onSelect: () => void navigator.clipboard.writeText(current.join("\n")),
      },
      {
        label: t("log.createPatch"),
        icon: SquarePlus,
        onSelect: () => onCommitAction("patch", commit),
      },
      {
        label: t("log.cherryPick"),
        icon: GitMerge,
        disabled: needOne !== undefined || merged,
        hint: merged ? t("log.needSingleParent") : needOne,
        onSelect: () => onCommitAction("cherryPick", commit),
      },
      { separator: true },
      ...(localCheckout.length === 0
        ? [
            {
              label: t("log.checkoutRevision", { rev: commit.short }),
              icon: GitBranch,
              disabled: needOne !== undefined,
              hint: needOne,
              onSelect: () => onCommitAction("checkout", commit),
            },
          ]
        : [
            {
              label: t("log.checkout"),
              icon: GitBranch,
              disabled: needOne !== undefined,
              hint: needOne,
              children: [
                ...localCheckout.map((name) => ({
                  label: name,
                  onSelect: () => void git.checkout(name),
                })),
                {
                  label: t("log.checkoutRevision", { rev: commit.short }),
                  onSelect: () => onCommitAction("checkout", commit),
                },
              ],
            },
          ]),
      ...(pairBoth
        ? [
            {
              label: t("log.compareVersions"),
              icon: FileDiff,
              onSelect: () => onCompareCommits(pair[0] as GitCommit, pair[1] as GitCommit),
            },
          ]
        : []),
      {
        label: t("log.diffWithLocal"),
        icon: FileDiff,
        disabled: needOne !== undefined,
        hint: needOne,
        onSelect: () => setCompareRef(commit.hash),
      },
      { separator: true },
      {
        label: t("log.resetHere"),
        icon: RotateCcw,
        disabled: needOne !== undefined,
        hint: needOne,
        children: [
          {
            label: t("log.resetSoft"),
            onSelect: () => onCommitAction("resetSoft", commit),
          },
          {
            label: t("log.resetMixed"),
            onSelect: () => onCommitAction("resetMixed", commit),
          },
          {
            label: t("log.resetHard"),
            danger: true,
            onSelect: () => onCommitAction("resetHard", commit),
          },
        ],
      },
      {
        label: t("log.revertCommit"),
        icon: Undo2,
        disabled: needOne !== undefined || merged,
        hint: merged ? t("log.needSingleParent") : needOne,
        onSelect: () => onCommitAction("revert", commit),
      },
      {
        label: t("log.uncommit"),
        icon: GitCommitHorizontal,
        disabled: !atHead,
        hint: needHead,
        onSelect: () => onCommitAction("uncommit", commit),
      },
      { separator: true },
      {
        label: t("log.editMessage"),
        icon: Pencil,
        disabled: !atHead,
        hint: needHead,
        onSelect: () => onCommitAction("reword", commit),
      },
      {
        label: t("log.pushUpTo"),
        icon: Upload,
        disabled: !canPush || needOne !== undefined,
        hint: !canPush ? t("log.noRemoteBranch") : needOne,
        onSelect: () => onCommitAction("pushUpTo", commit),
      },
      { separator: true },
      {
        label: t("git.newBranch"),
        icon: GitBranch,
        shortcut: `${MOD_LABEL}+Alt+N`,
        disabled: needOne !== undefined,
        hint: needOne,
        onSelect: () => onCommitAction("newBranch", commit),
      },
      {
        label: t("git.newTag"),
        icon: Tag,
        disabled: needOne !== undefined,
        hint: needOne,
        onSelect: () => onCommitAction("newTag", commit),
      },
      { separator: true },
      gotoItem(
        t("log.goToChild"),
        "LEFT",
        ArrowUpRight,
        children.map((row) => ({ hash: row.hash, text: `${row.subject} (${row.short})` }))
      ),
      gotoItem(
        t("log.goToParent"),
        "RIGHT",
        ArrowDownLeft,
        parents.map((hash) => ({ hash, text: named(hash) }))
      ),
    ]);
  };

  /** 收藏只作用于分支；标签点不动那颗星。 */
  /** 收藏名单用 Set：目录树每个目录行都要递归问一遍「这底下有没有收藏的」，扫全名单是白付的钱。 */
  const favorites = useMemo(() => new Set(options.favorites), [options.favorites]);
  const isFavorite = (name: string) => favorites.has(name);
  const toggleFavorite = (target: RefTarget) =>
    onOptions(withFavoriteToggled(options, target.name));
  /** 一行的星标，和「当前分支」「远端默认分支」那两个标记并排画。 */
  const leafBadge = (name: string, extra: ReactNode) => {
    if (!isFavorite(name)) return extra;
    const star = <Star size={12} className="ref-badge" aria-hidden="true" />;
    return extra ? (
      <>
        {star}
        {extra}
      </>
    ) : (
      star
    );
  };

  /** 本地分支那一行的形状；嵌套和平铺两种画法共用。 */
  const localLeaf = (branch: GitBranchRef): RefLeaf => ({
    label: branch.name,
    value: branch.name,
    badge: leafBadge(
      branch.name,
      branch.current ? <Tag size={12} className="ref-badge" aria-hidden="true" /> : null
    ),
    target: { name: branch.name, kind: "local" },
  });

  /** 远程分支那一行：标签只写远端名后面那截，值仍是全名。 */
  const remoteLeaf = (remote: string, branch: GitBranchRef): RefLeaf => ({
    label: branch.name.slice(remote.length + 1),
    value: branch.name,
    badge: leafBadge(
      branch.name,
      branch.defaultRef ? <Star size={12} className="ref-badge" aria-hidden="true" /> : null
    ),
    target: { name: branch.name, kind: "remote" },
  });

  const refRow = (leaf: RefLeaf, depth: number) => (
    <button
      key={`${leaf.value}-${leaf.label}`}
      type="button"
      className={`log-ref${reference === leaf.value ? " is-on" : ""}`}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={() => {
        setPickedRef(leaf.target);
        if (options.onSingleClick === "filter") setReference(leaf.value);
      }}
      onDoubleClick={() => setReference(leaf.value)}
      onContextMenu={(event) => {
        setPickedRef(leaf.target);
        openMenu(event, refMenu(leaf.target));
      }}
      title={leaf.value || git.status?.branch}
    >
      {leaf.badge}
      <span>{leaf.label}</span>
    </button>
  );

  /** 一条引用能做什么，看它是本地分支、远端分支还是标签；空组不留下悬空的分隔线。 */
  /** 一条引用能做什么：菜单本身在 lib/refMenu，主工具栏的分支弹层共用同一份。 */
  const refMenu = (target: RefTarget): MenuItem[] =>
    buildRefMenu(target, {
      t,
      current: git.status?.branch ?? "",
      upstream: upstreamOf(git.branches, target),
      detached: git.status?.detached ?? false,
      onAction: onRefAction,
      onCompareWith: (held) => setReference(`${git.status?.branch ?? ""}..${held.name}`),
      onDiffWithWorktree: (held) => setCompareRef(held.name),
    });

  /** 文件行右键菜单：IDEA 在日志里给的那一整套，置灰的照旧置灰。 */
  const fileMenu = (commit: GitCommitDetail, file: GitCommitFile): MenuItem[] => {
    const hasParent = commit.parents.length > 0;
    const act = (action: FileAction) => () => onFileAction(action, commit, file);
    return [
      { label: t("log.diffShow"), icon: FileDiff, shortcut: "Ctrl+D", onSelect: act("diff") },
      { label: t("log.diffNewTab"), icon: FileDiff, onSelect: act("diffNewTab") },
      { label: t("log.diffWithLocal"), onSelect: act("diffLocal") },
      {
        label: t("log.diffParentWithLocal"),
        disabled: !hasParent,
        onSelect: act("diffParentLocal"),
      },
      { label: t("log.editSource"), icon: Pencil, shortcut: "F12", onSelect: () => onEditSource(file.path) },
      { label: t("log.openRepoVersion"), onSelect: act("openRepoVersion") },
      { separator: true },
      {
        label: t("log.revertSelected"),
        icon: Undo2,
        disabled: !hasParent,
        onSelect: act("revert"),
      },
      // 这三项是 IDEA 变更清单那一侧的动作，日志里对着一次提交没有对应落点。
      { label: t("log.prioritizeSelected"), disabled: true },
      { label: t("log.extractToCommit"), disabled: true },
      { label: t("log.deleteSelected"), disabled: true },
      { label: t("log.createPatch"), icon: SquarePlus, onSelect: act("patch") },
      { label: t("log.getFromRevision"), icon: Download, onSelect: act("getFromRevision") },
      // 「迄今为止的历史记录」只是把中间那栏的过滤条件收窄到这个文件，不落到 App。
      { label: t("log.historyUpTo"), icon: History, onSelect: () => setPathFilter(file.path) },
      {
        label: t("log.showAgainstParent"),
        disabled: !hasParent,
        onSelect: act("diffParent"),
      },
    ];
  };

  const groupHead = (key: string, label: string) => (
    <button
      type="button"
      className="log-ref-group"
      onClick={() => toggleGroup(key)}
      aria-expanded={openGroup(key)}
    >
      {openGroup(key) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      <span>{label}</span>
    </button>
  );

  /** 引用树的一层目录：折叠键带前缀，和第三栏文件树的键不撞。 */
  const refDirRow = (node: RefNode, depth: number, render: (node: RefNode, depth: number) => ReactNode) => {
    const key = `refdir/${node.path}`;
    const open = openGroup(key);
    return (
      <Fragment key={key}>
        <button
          type="button"
          className="log-ref"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => toggleGroup(key)}
          aria-expanded={open}
          title={node.path}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Folder size={12} aria-hidden="true" />
          <span>{node.name}</span>
        </button>
        {open ? render(node, depth + 1) : null}
      </Fragment>
    );
  };

  /** 一层里的排序：当前分支最前，收藏的分支其次，含收藏的目录再次，其余按名字。 */
  const leafWeight = (leaf: RefLeaf) =>
    leaf.target.kind === "local" && leaf.target.name === currentBranch
      ? 0
      : isFavorite(leaf.target.name)
        ? 1
        : 4;
  const dirHasFavorite = (node: RefNode): boolean =>
    node.leaves.some((leaf) => isFavorite(leaf.target.name)) || node.dirs.some(dirHasFavorite);

  const renderRefNodes = (node: RefNode, depth: number): ReactNode => {
    const children = [
      ...node.dirs.map((dir) => ({
        name: dir.name,
        weight: dirHasFavorite(dir) ? 2 : 3,
        row: refDirRow(dir, depth, renderRefNodes),
      })),
      ...node.leaves.map((leaf) => ({
        name: leaf.label,
        weight: leafWeight(leaf),
        row: refRow(leaf, depth),
      })),
    ];
    children.sort((a, b) => a.weight - b.weight || a.name.localeCompare(b.name));
    return children.map((child) => child.row);
  };

  /** 一组叶子是嵌成目录还是平铺一条，看齿轮里那一档。 */
  const renderLeaves = (leaves: RefLeaf[], depth: number) =>
    options.groupByDirectory
      ? renderRefNodes(buildRefTree(leaves), depth)
      : leaves.map((leaf) => refRow(leaf, depth));

  /** 一个远端一层：折叠键按远端名记，展开后才是它下面的分支。 */
  const remoteNode = (remote: string, list: GitBranchRef[]) => {
    const key = `remote/${remote}`;
    const open = openGroup(key);
    const leaves: RefLeaf[] = list.map((branch) => remoteLeaf(remote, branch));
    return (
      <Fragment key={key}>
        <button
          type="button"
          className="log-ref"
          style={{ paddingLeft: 8 + 2 * 12 }}
          onClick={() => toggleGroup(key)}
          aria-expanded={open}
          title={remote}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Folder size={12} aria-hidden="true" />
          <span>{remote}</span>
        </button>
        {open ? renderLeaves(leaves, 3) : null}
      </Fragment>
    );
  };

  /**
   * 第三栏树的数据源：提交模式取这次提交的文件，比对模式取引用对工作区的改动。
   *
   * 这一份要保住数组身份：它同时是 `fileTree` 的缓存键，每次渲染现 map 一个新数组的话
   * 那棵树每渲染一遍就要重建一次，每个目录行的文件数也跟着重算一遍。
   */
  const treeItems: TreeItem[] = useMemo(
    () =>
      compareRef
        ? (compareFiles ?? []).map((entry) => ({
            path: entry.path,
            oldPath: entry.oldPath,
            status: entry.status,
            added: 0,
            removed: 0,
          }))
        : (detail?.files ?? []).map((file) => ({
            path: file.path,
            oldPath: file.oldPath,
            status: file.status,
            added: file.added,
            removed: file.removed,
          })),
    [compareRef, compareFiles, detail]
  );
  const treePrefix = compareRef ?? detail?.hash ?? "";

  const fileRow = (item: TreeItem, depth: number) => {
    const picked = !compareRef && pickedFile === item.path;
    return (
      <button
        key={`${treePrefix}|file:${item.path}`}
        type="button"
        className={`log-file${picked ? " is-on" : ""}`}
        style={{ paddingLeft: 9 + depth * 13 }}
        onClick={() => {
          if (!compareRef) setPickedFile(item.path);
        }}
        onDoubleClick={() => {
          if (compareRef) {
            const entry = (compareFiles ?? []).find((held) => held.path === item.path);
            if (entry) onCompareWork(compareRef, entry, compareFiles ?? []);
            return;
          }
          if (detail) {
            const file = detail.files.find((held) => held.path === item.path);
            if (file) onFileAction("diff", detail, file);
          }
        }}
        onContextMenu={(event) => {
          if (compareRef) {
            openMenu(event, [
              {
                label: t("log.diffShow"),
                icon: FileDiff,
                shortcut: "Ctrl+D",
                onSelect: () => onCompareWork(compareRef, {
                  path: item.path,
                  oldPath: item.oldPath,
                  status: item.status,
                }, compareFiles ?? []),
              },
              {
                label: t("log.editSource"),
                icon: Pencil,
                shortcut: "F12",
                onSelect: () => onEditSource(item.path),
              },
            ]);
            return;
          }
          if (detail) {
            const file = detail.files.find((held) => held.path === item.path);
            if (file) openMenu(event, fileMenu(detail, file));
          }
        }}
        title={item.oldPath ? `${item.oldPath} → ${item.path}` : item.path}
      >
        <span
          className={`tree-mark${item.status ? ` ${markClass(item.status)}` : " is-empty"}`}
        >
          {item.status || "·"}
        </span>
        <EntryIcon name={item.path.split("/").pop() ?? item.path} size={13} />
        <span
          className={`log-file-name${item.status ? ` ${markClass(item.status)}` : ""}${
            isDeletedMark(item.status) ? " is-deleted" : ""
          }`}
        >
          {item.path.split("/").pop()}
        </span>
        {showDetails && !compareRef ? (
          <span className="log-file-lines">
            +{item.added} −{item.removed}
          </span>
        ) : null}
      </button>
    );
  };

  const renderFileNodes = (node: FileNode, depth: number): ReactNode => (
    <>
      {node.dirs.map((dir) => {
        const key = `${treePrefix}|${dir.path}`;
        const open = !closedFileDirs.has(key);
        const count = filesUnder(dir).length;
        return (
          <Fragment key={key}>
            <button
              type="button"
              className="log-file is-dir"
              style={{ paddingLeft: 3 + depth * 13 }}
              onClick={() => toggleFileDir(key)}
              aria-expanded={open}
              title={dir.path}
            >
              <span className="tree-chevron">
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </span>
              <EntryIcon
                name={dir.name}
                isDirectory
                isPackage={isUnderJvmSourceRoot(dir.path)}
                size={13}
              />
              <span className="log-file-name">{dir.name}</span>
              {showDetails ? <span className="dir-count">{t("git.fileCount", { count })}</span> : null}
            </button>
            {open ? renderFileNodes(dir, depth + 1) : null}
          </Fragment>
        );
      })}
      {node.files.map((item) => fileRow(item, depth))}
    </>
  );

  const allFileDirKeys = (node: FileNode, prefix: string): string[] => [
    ...node.dirs.flatMap((dir) => [`${prefix}|${dir.path}`, ...allFileDirKeys(dir, prefix)]),
  ];

  const optionRow = (
    label: string,
    on: boolean,
    accel: string | null,
    onToggle: () => void
  ) => (
    <button type="button" className="popover-item" onClick={onToggle}>
      {on ? <Check size={13} aria-hidden="true" /> : <span className="menu-icon-spacer" />}
      <span className="popover-item-label">{label}</span>
      {accel ? <span className="popover-accel">{accel}</span> : null}
    </button>
  );

  const currentBranch = git.status?.branch ?? "";
  /** 选中那条引用是什么，决定工具条上哪几颗点得动。 */
  const pickedUpstream = pickedRef ? upstreamOf(git.branches, pickedRef) : "";
  const pickedIsCurrent =
    pickedRef !== null && pickedRef.kind === "local" && pickedRef.name === currentBranch;
  const remoteCount = git.probe?.remotes.length ?? 0;
  /** 折叠全部要连每个远端那一层、每层目录一起收，键和渲染那套一致。 */
  const everyGroupKey = () => [
    "local",
    "remote",
    "tag",
    ...[...remoteGroups.keys()].map((remote) => `remote/${remote}`),
    ...refDirKeysOf(locals.map((branch) => branch.name)),
    ...[...remoteGroups.entries()].flatMap(([remote, list]) =>
      refDirKeysOf(list.map((branch) => branch.name.slice(remote.length + 1)))
    ),
  ];

  const runFetch = () => {
    setFetching(true);
    void git.fetch().finally(() => setFetching(false));
  };

  /** 三个分组：有收藏的那一组排到前面，其余保持本地 / 远程 / 标签这个次序。 */
  const remoteEntries = [...remoteGroups.entries()];
  const refSections = [
    {
      key: "local",
      rank: 0,
      label: t("git.localBranches"),
      count: locals.length,
      favorite: locals.some((branch) => isFavorite(branch.name)),
      render: () => renderLeaves(locals.map(localLeaf), 2),
    },
    {
      key: "remote",
      rank: 1,
      label: t("git.remoteBranches"),
      count: remotes.length,
      favorite: remotes.some((branch) => isFavorite(branch.name)),
      render: () => remoteEntries.map(([remote, list]) => remoteNode(remote, list)),
    },
    {
      key: "tag",
      rank: 2,
      label: t("git.tags"),
      count: options.showTags ? tags.length : 0,
      favorite: false,
      render: () =>
        tags.map((tag) =>
          refRow(
            {
              label: tag.name,
              value: tag.name,
              badge: <Tag size={12} aria-hidden="true" />,
              target: { name: tag.name, kind: "tag" },
            },
            2
          )
        ),
    },
  ];

  /** 分支面板的动作条：竖着摆在树的左边，一颗一个动作，要靠选中的那些先点不动。 */
  const refTools = (
    <nav className="log-ref-tools">
      <button
        type="button"
        className="icon-button is-inline"
        title={t(refsHidden ? "git.showBranches" : "git.hideBranches")}
        onClick={() => setRefsHidden(!refsHidden)}
      >
        {refsHidden ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
      </button>
      {refsHidden ? null : (
        <>
          <span className="log-ref-tools-sep" />
          <button
            type="button"
            className="icon-button is-inline"
            title={t("git.newBranch")}
            disabled={!pickedRef}
            onClick={() => pickedRef && onRefAction("newBranch", pickedRef)}
          >
            <SquarePlus size={15} />
          </button>
          <button
            type="button"
            className="icon-button is-inline"
            title={pickedUpstream === "" ? t("git.noUpstream") : t("git.updateSelected")}
            disabled={!pickedRef || pickedUpstream === ""}
            onClick={() => pickedRef && onRefAction("update", pickedRef)}
          >
            <RefreshCw size={15} />
          </button>
          <button
            type="button"
            className="icon-button is-inline"
            title={pickedRef?.kind === "tag" ? t("git.refDelete") : t("git.deleteSelected")}
            disabled={!pickedRef || pickedIsCurrent}
            onClick={() => pickedRef && onRefAction("delete", pickedRef)}
          >
            <Trash2 size={15} />
          </button>
          <button
            type="button"
            className="icon-button is-inline"
            title={t("git.compareWithCurrent")}
            disabled={!pickedRef || pickedIsCurrent}
            onClick={() => pickedRef && setReference(`${currentBranch}..${pickedRef.name}`)}
          >
            <FileDiff size={15} />
          </button>
          {/* IDEA 的抓取动作在执行时仅置灰禁用，按钮图标保持静态不转圈。 */}
          <button
            type="button"
            className="icon-button is-inline"
            title={t(fetching ? "git.fetching" : "git.fetch")}
            disabled={remoteCount === 0 || fetching}
            onClick={runFetch}
          >
            <Download size={15} />
          </button>
          <button
            type="button"
            className="icon-button is-inline"
            title={t("git.toggleFavorite")}
            disabled={!pickedRef || pickedRef.kind === "tag"}
            onClick={() => pickedRef && pickedRef.kind !== "tag" && toggleFavorite(pickedRef)}
          >
            <Star size={15} />
          </button>
          <button
            type="button"
            className="icon-button is-inline"
            title={t("git.logToSelected")}
            disabled={!pickedRef}
            onClick={() => pickedRef && setReference(pickedRef.name)}
          >
            <MapPin size={15} />
          </button>
          <span className="log-ref-tools-sep" />
          <button
            type="button"
            ref={gearRef}
            className={`icon-button is-inline${gearAnchor ? " is-on" : ""}`}
            title={t("git.viewOptions")}
            aria-expanded={gearAnchor !== null}
            aria-haspopup="menu"
            onClick={() => setGearAnchor((current) => (current ? null : gearRef.current))}
          >
            <Settings size={15} />
          </button>
          <button
            type="button"
            className="icon-button is-inline"
            title={t("tool.expandAll")}
            onClick={() => setClosedGroups(new Set())}
          >
            <ChevronsUpDown size={15} />
          </button>
          <button
            type="button"
            className="icon-button is-inline"
            title={t("tool.collapseAll")}
            onClick={() => setClosedGroups(new Set(everyGroupKey()))}
          >
            <ChevronsDownUp size={15} />
          </button>
          {gearAnchor ? (
            <Popover anchor={gearAnchor} onClose={() => setGearAnchor(null)} minWidth={230}>
              <p className="popover-label">{t("git.onSingleClick")}</p>
              {(["none", "filter"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className="popover-item"
                  onClick={() => onOptions({ ...options, onSingleClick: mode })}
                >
                  {options.onSingleClick === mode ? (
                    <Check size={13} aria-hidden="true" />
                  ) : (
                    <span className="menu-icon-spacer" />
                  )}
                  <span className="popover-item-label">
                    {t(mode === "none" ? "git.clickSelectOnly" : "git.clickFilterBranch")}
                  </span>
                </button>
              ))}
              <div className="popover-sep" />
              {optionRow(t("git.groupByDirectory"), options.groupByDirectory, null, () =>
                onOptions({ ...options, groupByDirectory: !options.groupByDirectory })
              )}
              {optionRow(t("git.showTags"), options.showTags, null, () =>
                onOptions({ ...options, showTags: !options.showTags })
              )}
            </Popover>
          ) : null}
        </>
      )}
    </nav>
  );

  return (
    <div className="log-pane">
      {refTools}

      <aside className="log-refs" style={colStyle("refs")} hidden={refsHidden}>
        <label className="log-filter is-inline">
          <Search size={12} aria-hidden="true" />
          <input
            value={refQuery}
            placeholder={t("log.branchFilter")}
            spellCheck={false}
            onChange={(event) => setRefQuery(event.target.value)}
          />
        </label>
        <div className="log-ref-list">
          {refRow(
            {
              label: t("git.headBranch"),
              value: "",
              target: { name: git.status?.branch ?? "", kind: "local" },
            },
            1
          )}
          {refSections
            .filter((section) => section.count > 0)
            .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.rank - b.rank)
            .map((section) => (
              <Fragment key={section.key}>
                {groupHead(section.key, section.label)}
                {openGroup(section.key) ? section.render() : null}
              </Fragment>
            ))}
        </div>
      </aside>

      {refsHidden ? null : splitter("refs", "list")}

      <section className="log-list" style={colStyle("list")}>
        <div className="log-filters">
          <label className="log-filter is-grow">
            <Search size={12} aria-hidden="true" />
            <input
              value={text}
              placeholder={t("log.textFilter")}
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
            />
            <button
              type="button"
              className={`icon-button is-tiny${regex ? " is-on" : ""}`}
              onClick={() => setRegex((state) => !state)}
              title={regex ? t("log.regex") : t("log.caseSensitive")}
              aria-pressed={regex}
            >
              <Regex size={12} />
            </button>
          </label>
          {reference ? (
            <button
              type="button"
              className="log-chip"
              onClick={() => setReference("")}
              title={t("log.clear")}
            >
              <GitBranch size={11} aria-hidden="true" />
              <span>{reference}</span>
              <X size={11} aria-hidden="true" />
            </button>
          ) : null}
          {pathFilter ? (
            <button
              type="button"
              className="log-chip"
              onClick={() => setPathFilter("")}
              title={t("log.historyOf", { path: pathFilter })}
            >
              <History size={11} aria-hidden="true" />
              <span>{pathFilter}</span>
              <X size={11} aria-hidden="true" />
            </button>
          ) : null}
          <Select
            className="log-select"
            label={t("log.author")}
            placeholder={t("log.anyAuthor")}
            value={author}
            onChange={setAuthor}
            options={[
              { value: "", label: t("log.anyAuthor") },
              ...authors.map((name) => ({ value: name, label: name })),
            ]}
          />
          <Select
            className="log-select"
            label={t("log.date")}
            placeholder={t("log.anyDate")}
            value={since}
            onChange={setSince}
            options={[
              { value: "", label: t("log.anyDate") },
              { value: "24h", label: t("log.last24h") },
              { value: "7d", label: t("log.last7d") },
              { value: "30d", label: t("log.last30d") },
            ]}
          />
          <button
            type="button"
            className="icon-button is-tiny"
            onClick={() => {
              setSignal((value) => value + 1);
              // 这一句的标题是「刷新状态」：提交行菜单按 HEAD 与上游判定的那几项读的是仓库状态那一份，
              // 只重查日志会让它们停在旧结论上。
              void git.refresh();
            }}
            title={t("git.refresh")}
          >
            <RefreshCw size={12} className={logLoading ? "is-spinning" : undefined} />
          </button>
          {filtering ? (
            <button type="button" className="icon-button is-tiny" onClick={clearFilters} title={t("log.clear")}>
              <X size={12} />
            </button>
          ) : null}
        </div>

        <div className="log-commits">
          {commits.length === 0 && !logLoading ? (
            <p className="panel-note">{t("log.empty")}</p>
          ) : null}
          {commits.map((commit) => (
            <button
              key={commit.hash}
              type="button"
              className={`log-commit${picked.includes(commit.hash) ? " is-on" : ""}`}
              onClick={(event) => pickCommit(commit, event)}
              onContextMenu={(event) => commitMenu(event, commit)}
              title={commit.subject}
            >
              <span className="log-dot" aria-hidden="true" />
              <span className="log-subject">{commit.subject}</span>
              {commit.refs ? <span className="log-refs-badge">{commit.refs}</span> : null}
              <span className="log-author">{commit.author}</span>
              <span className="log-time">
                {commitStamp(commit.authoredMs, locale, t("time.today"), t("time.yesterday"))}
              </span>
            </button>
          ))}
        </div>
      </section>

      {splitter("list", "detail")}

      <section className="log-detail" style={colStyle("detail")}>
        <div className="log-detail-bar">
          <button
            type="button"
            className="icon-button is-tiny"
            disabled={treeItems.length === 0}
            onClick={() => setClosedFileDirs(new Set(allFileDirKeys(fileTree(treeItems), treePrefix)))}
            title={t("tool.collapseAll")}
          >
            <ChevronsDownUp size={13} />
          </button>
          <button
            type="button"
            className="icon-button is-tiny"
            disabled={closedFileDirs.size === 0}
            onClick={() => setClosedFileDirs(new Set())}
            title={t("tool.expandAll")}
          >
            <ChevronsUpDown size={13} />
          </button>
          {compareRef ? (
            <button
              type="button"
              className="log-chip"
              onClick={() => setCompareRef(null)}
              title={t("log.clear")}
            >
              <FileDiff size={11} aria-hidden="true" />
              <span>{t("log.compareWork", { name: compareRef })}</span>
              <X size={11} aria-hidden="true" />
            </button>
          ) : null}
          <span className="status-spacer" />
          <button
            type="button"
            ref={optionsRef}
            className="icon-button is-tiny is-split"
            onClick={() => setOptionsAnchor((current) => (current ? null : optionsRef.current))}
            aria-expanded={optionsAnchor !== null}
            title={t("log.options")}
          >
            <Eye size={13} />
            <ChevronDown size={9} aria-hidden="true" />
          </button>
        </div>

        {detail || compareRef ? (
          <>
            <div className="log-files">
              {treeItems.length === 0 ? (
                <p className="panel-note">{t("log.noFiles")}</p>
              ) : groupDir ? (
                <>
                  {groupModule ? (
                    (() => {
                      const key = `${treePrefix}|⌂module`;
                      const open = !closedFileDirs.has(key);
                      return (
                        <>
                          <button
                            type="button"
                            className="log-file is-dir is-module"
                            style={{ paddingLeft: 3 }}
                            onClick={() => toggleFileDir(key)}
                            aria-expanded={open}
                            title={root}
                          >
                            <span className="tree-chevron">
                              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            </span>
                            <FolderGit2 size={13} className="entry-icon" aria-hidden="true" />
                            <span className="log-file-name">{repoName}</span>
                            {showDetails ? (
                              <span className="dir-count">
                                {t("git.fileCount", { count: treeItems.length })}
                              </span>
                            ) : null}
                            <span className="dir-path">{repoName}</span>
                          </button>
                          {open ? renderFileNodes(fileTree(treeItems), 1) : null}
                        </>
                      );
                    })()
                  ) : (
                    renderFileNodes(fileTree(treeItems), 0)
                  )}
                </>
              ) : (
                treeItems.map((item) => fileRow(item, groupModule ? 1 : 0))
              )}
            </div>
            {showPreview ? (
              <pre className="log-preview">
                {preview === null ? t("log.diffHint") : preview || t("log.noFiles")}
              </pre>
            ) : null}
          </>
        ) : (
          <p className="log-hint">{logLoading ? t("log.loading") : t("log.selectCommit")}</p>
        )}

        {detail ? (
          <>
            <button
              type="button"
              className="log-info-head"
              onClick={() => setInfoClosed((state) => !state)}
              aria-expanded={!infoClosed}
            >
              {infoClosed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <span>{t("log.details")}</span>
            </button>
            {infoClosed ? null : (
              <>
                <div className="log-message">
                  <p className="log-message-subject" title={detail.refs}>
                    {detail.subject}
                  </p>
                  {detail.body ? <p className="log-message-body">{detail.body}</p> : null}
                </div>
                <dl className="log-meta">
                  <div>
                    <dt>{t("log.hash")}</dt>
                    <dd>{detail.short}</dd>
                  </div>
                  <div>
                    <dt>{t("log.creator")}</dt>
                    <dd>
                      {detail.author} &lt;{detail.email}&gt;
                    </dd>
                  </div>
                  <div>
                    <dt>{t("log.authorDate")}</dt>
                    <dd>{stamp(detail.authoredMs)}</dd>
                  </div>
                  <div>
                    <dt>{t("log.committer")}</dt>
                    <dd>
                      {detail.committer} &lt;{detail.committerEmail}&gt;
                    </dd>
                  </div>
                  <div>
                    <dt>{t("log.commitDate")}</dt>
                    <dd>{stamp(detail.committedMs)}</dd>
                  </div>
                  <div>
                    <dt>{t("log.parents")}</dt>
                    <dd>{detail.parents.length > 0 ? detail.parents.join(", ") : "—"}</dd>
                  </div>
                </dl>
              </>
            )}
          </>
        ) : null}

        <Popover
          anchor={optionsAnchor}
          onClose={() => setOptionsAnchor(null)}
          minWidth={230}
        >
          <p className="popover-label">{t("git.groupBy")}</p>
          {optionRow(t("git.groupDir"), groupDir, `${MOD_LABEL}+Alt+P`, () => setGroupDir((v) => !v))}
          {optionRow(t("git.groupModule"), groupModule, `${MOD_LABEL}+Alt+M`, () =>
            setGroupModule((v) => !v)
          )}
          <div className="popover-sep" />
          <p className="popover-label">{t("log.layout")}</p>
          {optionRow(t("log.showDetails"), showDetails, null, () => setShowDetails((v) => !v))}
          {optionRow(t("log.showPreview"), showPreview, null, () => setShowPreview((v) => !v))}
        </Popover>
      </section>

      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

/** 日志那三栏（图 + 列表 + 详情）是这里最贵的一块，props 没变就挡在外面。 */
export default memo(GitLogPane);
