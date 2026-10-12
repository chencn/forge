import { useCallback, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  Bell,
  Check,
  CheckCheck,
  Eraser,
  Eye,
  FilePlus,
  FolderPlus,
  FileDiff,
  GitCommit,
  ListTree,
  Maximize2,
  Minus,
  PanelBottom,
  PanelLeftClose,
  Play,
  RefreshCw,
  Settings,
  SquareTerminal,
} from "lucide-react";
import TitleBar from "./components/TitleBar";
import ContextMenu from "./components/ContextMenu";
import type { MenuAnchor, MenuItem } from "./components/ContextMenu";
import { flatMenu } from "./components/ContextMenu";
import ErrorBoundary from "./components/ErrorBoundary";
import PromptDialog from "./components/PromptDialog";
import ResolveConflictsDialog from "./components/ResolveConflictsDialog";
import type { DialogRequest } from "./components/PromptDialog";
import ExplorerTree from "./components/ExplorerTree";
import EntryIcon from "./components/EntryIcon";
import EditorTabs from "./components/EditorTabs";
import type { TabItem, TabKind } from "./components/EditorTabs";
import LspStatusBar from "./components/LspStatusBar";
import type { CommitFileAction } from "./components/GitPanel";
import type { CommitAction, FileAction, RefAction, RefTarget } from "./components/GitLogPane";
import type { TerminalPaneHandle } from "./components/TerminalPane";
import type { DiffGroup } from "./components/DiffPane";
import RunControls from "./components/RunControls";
import type { SearchTab } from "./components/SearchEverywhere";
import FindPane from "./components/FindPane";
import { CommitIcon, ProjectIcon, SearchIcon, VcsIcon } from "./components/ToolWindowIcons";
import ProjectPicker from "./components/ProjectPicker";
import BranchPicker from "./components/BranchPicker";
import type { BranchAction } from "./components/BranchPicker";
import ConflictWidget from "./components/ConflictWidget";
import Popover from "./components/Popover";
import WelcomeScreen from "./components/WelcomeScreen";
import MemoryGauge from "./components/MemoryGauge";
import {
  NotificationBell,
  NotificationsView,
  NotificationToasts,
} from "./components/NotificationCenter";
import { loadNotifications, saveNotifications } from "./lib/notifications";
import type { AppNotification } from "./lib/notifications";
import { useDocuments } from "./hooks/useDocuments";
import { useFileWatch } from "./hooks/useFileWatch";
import { useGitState } from "./hooks/useGitState";
import { useLspConfig } from "./hooks/useLspConfig";
import { useRunConfigs } from "./hooks/useRunConfigs";
import { useRunSessions } from "./hooks/useRunSessions";
import { useHistory } from "./hooks/useHistory";
import { useSettings } from "./hooks/useSettings";
import { relaunchApp, runAutoUpdateFlow } from "./lib/updater";
import UpdateStatusBar from "./components/UpdateStatusBar";
import {
  disposeAllModels,
  disposeModel,
  languageForPath,
  languageLabel,
  selectedText,
  setKeymapScheme,
  setOpenTargetHandler,
} from "./lib/monacoEnv";
import { EMPTY_TREE_HASH, gitCommitDetail, gitCommitFile, gitDiffText, gitIgnoreRule, gitIndexShow, gitShow } from "./lib/git";
import type {
  GitChange,
  GitCommit as GitCommitInfo,
  GitCommitDetail,
  GitCommitFile,
  GitFileSides,
  GitNameStatus,
} from "./lib/git";
import {
  allowAssetDir,
  copyEntry,
  createFile,
  createFolder,
  deleteEntry,
  errorText,
  moveEntry,
  openExternal,
  readFile,
  renameEntry,
  revealEntry,
  writeFile,
} from "./lib/fs";
import { codedError, describeError } from "./lib/errors";
import { MOD_LABEL } from "./lib/sys";
import { canDiff, docKindOf, hasTextContent } from "./lib/docKind";
import { dropTermSession, runInTerminal } from "./lib/termStore";
import { shellProbe } from "./lib/term";
import type { ShellInfo } from "./lib/term";
import {
  buildScriptCommand,
  findShellForScript,
  scriptKindOf,
  scriptTerminalLabel,
} from "./lib/scriptRun";
import type { FsEntry, SearchOptions, TextHit, TextPage } from "./lib/fs";
import { basenameOf, joinPath, parentPath, patchStem, pathWithin, resolvePath, samePath } from "./lib/format";
import { appExit, setTrayLabels } from "./lib/window";
import { useI18n } from "./i18n";
import type { TranslationKey } from "./i18n/lang/zh";
import { RunPaneToolbar, RunSessionTabs } from "./components/RunPaneHead";
import TerminalTabs from "./components/TerminalTabs";

/**
 * 编辑区与工具窗口按「首次用到」才取。
 *
 * 这几块带着 Monaco、xterm、marked 与 DOMPurify：静态引它们就等于把约 4.6MB 放在
 * `createRoot().render()` 之前求值，而首屏要么是空白页要么是目录树，一样都用不到。
 * 类型仍走 `import type`，编译期擦掉，不产生依赖。
 */
const DocPane = lazy(() => import("./components/DocPane"));
const DiffPane = lazy(() => import("./components/DiffPane"));
const GitPanel = lazy(() => import("./components/GitPanel"));
const GitLogPane = lazy(() => import("./components/GitLogPane"));
const TerminalPane = lazy(() => import("./components/TerminalPane"));
const RunPane = lazy(() => import("./components/RunPane"));
const RunConfigsPage = lazy(() => import("./components/RunConfigsPage"));
const SearchEverywhere = lazy(() => import("./components/SearchEverywhere"));
const SettingsPage = lazy(() => import("./components/SettingsPage"));

/** 对话框除了文案，还要记住它作用在哪个条目上、新建落在哪个目录里。 */
type PendingDialog = DialogRequest & {
  entry: FsEntry | null;
  dir: string | null;
  /** 删除可以一次作用在一批路径上；缺省时只删 `entry` / `path` 那一条。 */
  many?: string[];
};

/** 标签页里的一份比对：来源可以是工作区改动，也可以是某次提交里的文件。 */
interface DiffTab {
  /** 同一份比对只开一个标签，键由来源 + 版本 + 路径拼成。 */
  id: string;
  /** 标签上显示的文件名。 */
  name: string;
  /** 左那一栏的表头：这一侧是哪个版本（HEAD、索引、短哈希）。 */
  leftLabel: string;
  /** 右那一栏的表头。 */
  rightLabel: string;
  /** 悬停提示里的仓库相对路径。 */
  path: string;
  original: string;
  modified: string;
  language: string;
  /** 有值时这次比对打不开（二进制、图片），正文区摆这句说明，不画编辑器。 */
  notice?: string;
  /**
   * 这篇文件所在的那一串：链条编号 + 第几篇 + 一共几篇。
   *
   * 开关函数不在这里，按编号存在 `diffChains` 那个表里——标签是要进 state 的，
   * 每开一次都会换一个新闭包，留着只会让旧标签的箭头指向过期的那一批。
   */
  chain?: { id: string; index: number; total: number };
  /**
   * 这一篇打开后把光标落到哪一处差异：`first` 是上下箭头从上一篇走到底转过来的，`last` 是从下一篇
   * 走到头倒着转过来的。缺省就是不动，左右两枚箭头换篇时正是这样，从篇首看起。
   */
  landOn?: "first" | "last";
  /** 跳到源码落在那个工作区文件上（绝对路径）；工作区里没有对应文件时不给。 */
  openIn?: string;
}

/**
 * 顶栏箭头走链时交给开比对那一步的落点。
 *
 * `tabId` 是要写回哪一颗标签：IDEA 的比对标签装的是整条链，走链只换里面那一篇，所以这一步
 * 带着它自己那颗回来，不再新开。`land` 是上下箭头走到本篇尽头转过来时才给的落点。
 */
type ChainStep = { tabId: string; land?: "first" | "last" };

/** 比对里一篇文件的两条路径与状态：提交清单和 name-status 都满足这一份。 */
type DiffFileRef = { path: string; oldPath: string; status: string };

/**
 * 顶栏左右箭头走的那一条链：记下这一串文件是按哪种口径比的，走到第几篇时现取现开。
 *
 * `change` 是工作区改动（HEAD→索引 或 索引→工作区）；`commitFile` 是某次提交里父与本相比；
 * `between` 是文件菜单里点名那两个版本；`against` 是某个版本对工作区。
 */
type DiffChain =
  | { kind: "change"; staged: boolean; items: GitChange[] }
  | { kind: "commitFile"; commit: GitCommitDetail; items: GitCommitFile[] }
  | { kind: "between"; commit: GitCommitDetail; parent: string; items: GitCommitFile[] }
  | { kind: "against"; chainId: string; revision: string; leftLabel: string; items: DiffFileRef[] };

/** 侧边工具窗口的两种内容，对应活动栏上端的两颗按钮。 */
type Panel = "explorer" | "git";

/** 底部工具窗口：各自独立开关，底部一次只见一块，切到选项卡才能并存。包含 IDEA 的通知工具窗口。 */
type BottomPane = "terminal" | "run" | "log" | "find" | "notifications";

/** 一块工具窗口待在哪。底部是排他的，选项卡那边可以并存。 */
type Placement = "hidden" | "docked" | "tabbed";

const RAIL_LABEL: Record<Panel, TranslationKey> = {
  explorer: "panel.explorer",
  git: "panel.commit",
};

/** 并排时的固定次序，不受点开顺序影响。 */
const BOTTOM_ORDER: BottomPane[] = ["terminal", "run", "log", "find", "notifications"];

/**
 * 活动栏下端那排入口的次序，比 BOTTOM_ORDER 少一块「查找」。
 * IDEA 没给 Find 工具窗口留活动栏入口，它是搜正文时自己开出来的，这边照做。
 */
const RAIL_BOTTOM: BottomPane[] = ["terminal", "run", "log", "notifications"];

const BOTTOM_LABEL: Record<BottomPane, TranslationKey> = {
  terminal: "panel.terminal",
  run: "panel.run",
  log: "panel.log",
  find: "panel.find",
  notifications: "notifications.title",
};

/** 页签栏里给面板标签用的图标，和活动栏下端那几颗是同一组。 */
const PANE_ICON: Record<BottomPane, ReactNode> = {
  terminal: <SquareTerminal size={13} className="entry-icon" aria-hidden="true" />,
  run: <Play size={13} className="entry-icon" aria-hidden="true" />,
  log: <VcsIcon size={13} className="entry-icon" />,
  find: <SearchIcon size={13} className="entry-icon" aria-hidden="true" />,
  notifications: <Bell size={13} className="entry-icon" aria-hidden="true" />,
};

export default function App() {
  const { t } = useI18n();
  const { settings, patch, applied: resolved } = useSettings();
  const { history, patch: patchHistory, remember } = useHistory();
  const { config: lspConfig } = useLspConfig();
  /** 递增即再对一趟语言服务：状态条里手动重启或停用之后要立刻反映到进程上。 */
  const [lspKick, setLspKick] = useState(0);

  /** 上次打开的文件夹，跟着历史记录走。先声明以便初始化通知历史。 */
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(
    history.lastFolder || null
  );

  /** 当前项目最近 7 天通知历史（从持久化缓存加载并自动过滤过期记录）。 */
  const [notifications, setNotifications] = useState<AppNotification[]>(() =>
    loadNotifications(history.lastFolder || null)
  );
  /** 当前在右下角悬浮展示的气泡列表（最多同时展示 3 条）。 */
  const [activeToasts, setActiveToasts] = useState<AppNotification[]>([]);

  // 辅助更新并持久化通知
  const updateNotifications = useCallback(
    (updater: (prev: AppNotification[]) => AppNotification[]) => {
      setNotifications((prev) => {
        const next = updater(prev);
        saveNotifications(workspaceRoot, next);
        return next;
      });
    },
    [workspaceRoot]
  );

  // 工作区项目切换时，加载该项目的 7 天通知历史并重置屏幕浮动气泡
  useEffect(() => {
    setNotifications(loadNotifications(workspaceRoot));
    setActiveToasts([]);
  }, [workspaceRoot]);

  /** 统一上报错误与通知（参照 IDEA：右下角弹出 Notification Balloon，并留存在最近 7 天通知历史中）。 */
  const reportError = useCallback(
    (raw: string, titleKey?: string) => {
      const desc = describeError(raw, t);
      let title = t("notifications.error");
      if (titleKey === "fetch") title = t("notifications.fetchFailed");
      else if (titleKey === "pull") title = t("notifications.pullFailed");
      else if (titleKey === "push") title = t("notifications.pushFailed");
      else if (titleKey) title = titleKey;
      else if (desc.includes("fatal:") || desc.includes("error:") || raw.startsWith("GIT\u0001")) {
        title = t("notifications.gitErrorTitle");
      }

      const notif: AppNotification = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title,
        content: desc,
        level: "error",
        timestamp: Date.now(),
        read: false,
        projectRoot: workspaceRoot ?? "",
      };

      // 记入历史并弹出右下角气泡（最多保留最新 3 条未关闭气泡）
      updateNotifications((prev) => [notif, ...prev]);
      setActiveToasts((prev) => [notif, ...prev.slice(0, 2)]);
    },
    [t, updateNotifications, workspaceRoot]
  );

  const dismissToast = useCallback((id: string) => {
    setActiveToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const markAllNotificationsRead = useCallback(() => {
    updateNotifications((prev) => prev.map((item) => ({ ...item, read: true })));
  }, [updateNotifications]);

  const clearAllNotifications = useCallback(() => {
    updateNotifications(() => []);
    setActiveToasts([]);
  }, [updateNotifications]);

  const removeNotification = useCallback(
    (id: string) => {
      updateNotifications((prev) => prev.filter((item) => item.id !== id));
      setActiveToasts((prev) => prev.filter((item) => item.id !== id));
    },
    [updateNotifications]
  );

  /** 自动更新流程的通报走同一条管道：进 7 天历史 + 右下角气泡。 */
  const pushUpdateNotice = useCallback(
    (level: "info" | "warn", title: string, content: string) => {
      const notif: AppNotification = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title,
        content,
        level,
        timestamp: Date.now(),
        read: false,
        projectRoot: workspaceRoot ?? "",
      };
      updateNotifications((prev) => [notif, ...prev]);
      setActiveToasts((prev) => [notif, ...prev.slice(0, 2)]);
    },
    [updateNotifications, workspaceRoot]
  );

  /** 下载完成后的「立即安装？」弹窗；挂起的是版本号，resolve 值回给自动更新流程。 */
  const [updatePrompt, setUpdatePrompt] = useState<string | null>(null);
  const updatePromptResolve = useRef<((now: boolean) => void) | null>(null);

  // 自动更新只按启动那一刻的设置跑一次：中途改设置下次启动才生效。
  // settings 对象一变就重跑，会把「刚关掉自动下载」误解成「再下载一遍」。
  useEffect(() => {
    void runAutoUpdateFlow(settings.updates, {
      onPromptInstall: (version) =>
        new Promise<boolean>((resolve) => {
          updatePromptResolve.current = resolve;
          setUpdatePrompt(version);
        }),
      notify: pushUpdateNotice,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const docs = useDocuments(reportError);
  const git = useGitState(workspaceRoot, reportError);
  /**
   * 挂载期注册的监听要读最新的那份，但绝不能把它写进依赖。
   * 这两个对象每次渲染都是新的（依赖 documents / status），进依赖就等于每次渲染
   * 摘挂一次监听——`listen` 那对还要走两趟 IPC。
   */
  const saveAllRef = useRef(docs.saveAll);
  saveAllRef.current = docs.saveAll;
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const gitRef = useRef(git);
  gitRef.current = git;
  /** 磁盘事件触发的 git 刷新防抖计时器；只留最后一趟，风暴期间不起中间的子进程。 */
  const gitDebounce = useRef<number | null>(null);

  /**
   * 语言服务「跳转到定义」落到别的文件时，由这里把那份文件开出来并定位。
   *
   * 处理者挂一次就够，内部读 ref 取最新的 openHit，所以依赖是空的：
   * 进依赖会让每次渲染都重挂一遍 opener。
   */
  useEffect(() => {
    setOpenTargetHandler((path, line, column) => {
      void docsRef.current.openHit(path, line, column).catch((cause: unknown) => {
        reportError(errorText(cause));
      });
      return true;
    });
    return () => setOpenTargetHandler(null);
  }, [reportError]);

  /**
   * 把打开的文档对到语言服务上。
   *
   * 只在文档列表、工作区或语言服务配置变动时重算。`reconcileLsp` 幂等，
   * 多调几次不会重复起进程或重复 didOpen；正在编辑的那份文档每敲一下会进一次这里，
   * 但内容没变的那几条会被它自己跳过。
   */
  // 交给语言服务的文档集合：只给「已加载、可编辑、正文读回来了、且在磁盘上」的那几份。
  // 虚拟文档（git 历史里那份）不在磁盘上，语言服务按 URI 读不到，一并排除。
  const lspDocuments = useCallback(
    () =>
      docs.documents
        .filter((doc) => !doc.loading && !doc.readOnly && doc.error === null && doc.onDisk)
        .map((doc) => ({ path: doc.path, language: doc.language, text: doc.contents })),
    [docs.documents]
  );

  useEffect(() => {
    // 客户端拉得到 monaco，静态引它就把整份编辑器打进启动 chunk；
    // 这里已经在等文档打开，动态引一次同一片 chunk，加载时机反而更准。
    void import("./lib/lspClient")
      .then(({ reconcileLsp }) => reconcileLsp(workspaceRoot, lspConfig, lspDocuments()))
      .catch(() => {});
  }, [lspDocuments, lspConfig, workspaceRoot, lspKick]);

  /** 设置页的「启动」按钮：让指定 server 立即在当前项目中启动，不等待用户打开其管理的语言文件。 */
  const wakeLspServer = useCallback(
    async (serverId: string) => {
      if (!workspaceRoot) return { state: "off" } as const;
      const { wakeLsp } = await import("./lib/lspClient");
      const result = await wakeLsp(workspaceRoot, lspConfig, serverId, lspDocuments());
      setLspKick((value) => value + 1);
      return result;
    },
    [lspConfig, lspDocuments, workspaceRoot]
  );

  const [panel, setPanel] = useState<Panel>("explorer");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  /** 递增即通知目录树折叠全部。 */
  const [collapseSignal, setCollapseSignal] = useState(0);
  /**
   * 通知目录树丢缓存重读。`paths` 是这批变更落在哪些路径上，只作废与它们相干的那些缓存；
   * `null` 表示整张表都不要了（git 操作、改名这类改了成片又说不清单条路径的）。
   */
  const [treeRefresh, setTreeRefresh] = useState<{ paths: string[] | null; seq: number }>({
    paths: null,
    seq: 0,
  });
  /** 交给目录树去定位的那一条，连同序号：同一路径再点一次也要重新滚一趟。 */
  const [treeReveal, setTreeReveal] = useState<{ path: string; seq: number } | null>(null);
  /** 目录树里选中的那一批，按点击先后排；最后一条是主行，右键菜单和键位都读这一份。 */
  const [explorerPick, setExplorerPick] = useState<FsEntry[]>([]);
  /** 剪切 / 复制攒下的那一批，连同它是挪走还是留下。 */
  const [clipboard, setClipboard] = useState<{ entries: FsEntry[]; cut: boolean } | null>(null);
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** 编辑区页签栏里的比对，按打开顺序排。 */
  const [diffs, setDiffs] = useState<DiffTab[]>([]);
  /** 「在新标签页中显示差异」要一份新标签，靠它把同一处比对的键区分开。 */
  const diffSeq = useRef(0);
  /**
   * 开过的那一串文件，按链条编号存着这一串是按哪种口径比的。
   *
   * 标签上只留编号与序号，这里存的是数据而不是闭包：留着闭包就等于把打开它时的那一批
   * 连同当时的每一篇都钉死，旧标签的箭头会走向过期的那一批。
   */
  const diffChains = useRef(new Map<string, DiffChain>());
  /** 底部工具窗口各自待在哪：底部、选项卡、还是收着。底部一次只放一块。 */
  const [places, setPlaces] = useState<Record<BottomPane, Placement>>({
    terminal: "hidden",
    run: "hidden",
    log: "hidden",
    find: "hidden",
    notifications: "hidden",
  });
  /** 设置页开在不在页签栏里。 */
  const [settingsTab, setSettingsTab] = useState(false);
  /** 「编辑程序配置」那一页开在不在页签栏里。 */
  const [runConfigsTab, setRunConfigsTab] = useState(false);
  /** 递增即打开配置选择下拉，对应 `Alt+Shift+F10`。 */
  const [runChooser, setRunChooser] = useState(0);
  /** 页签栏当前选中的那一项，null 表示编辑区是空的。 */
  const [activeTab, setActiveTab] = useState<string | null>(null);
  /** 页签栏的排列顺序，只装标签 id；栏上有什么仍由各自的来源说。 */
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  /** 底部工具窗口整体高度，拖动上面那条横分隔条改它。 */
  const [bottomHeight, setBottomHeight] = useState(260);
  /** 侧边工具窗口宽度，拖动它右缘那条竖分隔条改它。 */
  const [sidebarWidth, setSidebarWidth] = useState(320);
  /** 递增即让提交说明框抢焦点，对应主工具栏那条「提交…」。 */
  const [commitFocus, setCommitFocus] = useState(0);
  /** 递增即让提交面板摊开 HEAD 那一次并勾上修正，对应日志里的「编辑提交消息」。 */
  const [rewordSignal, setRewordSignal] = useState(0);
  /** 提交工具窗口的视图选项，图标条那颗齿轮和变更树共用。 */
  const [commitView, setCommitView] = useState({ byDir: true, byModule: true, ignored: false });
  /** 头部齿轮（IDEA 的 CommitView.GearActions）挂在这颗按钮上。 */
  const commitGearRef = useRef<HTMLButtonElement>(null);
  const [commitGearAnchor, setCommitGearAnchor] = useState<HTMLElement | null>(null);
  /** 未合并那一节的 Resolve 链接与冲突行菜单开的是同一层弹层。 */
  const [resolveOpen, setResolveOpen] = useState(false);
  /**
   * 日志的两处筛选状态提在这一层：分支弹层里的「与当前比较」和「显示与工作树的差异」
   * 也要改它们，改完顺手把日志窗口叫出来。
   */
  const [logReference, setLogReference] = useState("");
  const [logCompareRef, setLogCompareRef] = useState<string | null>(null);
  /** 日志中列的路径过滤，空串不限。 */
  const [logPath, setLogPath] = useState("");
  /**
   * 随处搜索的弹层，null 表示没开。开的时候带三样：落在哪个页签、预填的词、
   * 以及搜的是哪一层（IDEA 的 Look in Directory，从树右键带过来的那个目录）。
   */
  const [everywhere, setEverywhere] = useState<{
    tab: SearchTab;
    query: string;
    scope: string | null;
  } | null>(null);
  /** 每开一次换一个序号当 key：同一份状态里再按一次 Ctrl+Shift+N 也要重置页签与词。 */
  const searchSeq = useRef(0);
  /** 底部查找窗口里那一趟的结果。一次只看一趟，重跑就地覆盖。 */
  const [find, setFind] = useState<{
    query: string;
    options: SearchOptions;
    page: TextPage | null;
  }>({ query: "", options: { caseSensitive: false, wholeWords: false, regex: false, fileMask: "", limit: 0 }, page: null });
  const terminalApi = useRef<TerminalPaneHandle>(null);
  /**
   * 分割条拖动：拖动期间直接写那块面板的行内尺寸，松手才落到 state。
   * 每来一个 pointermove 就 setState 的话，一次拖动要在 60-120 Hz 上把整个 IDE 树
   * （标签、目录树、Git 面板、日志）全重渲染一遍，而改的只是两条边的宽度。
   */
  const sidePanelRef = useRef<HTMLElement | null>(null);
  const bottomPanelRef = useRef<HTMLElement | null>(null);
  const splitDrag = useRef<{ startY: number; startHeight: number; live: number } | null>(null);
  const sideDrag = useRef<{ startX: number; startWidth: number; live: number } | null>(null);
  /** 每块工具窗口上次待的位置，最小化后再点活动栏那颗要回原处。 */
  const lastPlace = useRef<Record<BottomPane, "docked" | "tabbed">>({
    terminal: "docked",
    run: "docked",
    log: "docked",
    find: "docked",
    notifications: "docked",
  });
  const configs = useRunConfigs(workspaceRoot);
  const run = useRunSessions(configs);

  const dockedPane = BOTTOM_ORDER.find((key) => places[key] === "docked") ?? null;
  /** 当前那篇文档：只有选中的是文档标签时才算「在看」。 */
  const shownDoc = activeTab && activeTab.startsWith("doc|") ? activeTab.slice(4) : null;
  const activeDoc = docs.documents.find((doc) => doc.path === shownDoc) ?? null;
  const activeDiffTab =
    activeTab && activeTab.startsWith("diff|")
      ? (diffs.find((tab) => tab.id === activeTab.slice(5)) ?? null)
      : null;
  const activePane =
    activeTab && activeTab.startsWith("pane|") ? (activeTab.slice(5) as BottomPane) : null;
  const changeCount = git.status?.changes.length ?? 0;

  useEffect(() => {
    patchHistory({ lastFolder: workspaceRoot ?? "" });
  }, [patchHistory, workspaceRoot]);

  // 本地图片要经 asset 协议读，授权不落盘，每次打开工作区都得重授一遍。
  useEffect(() => {
    if (workspaceRoot) void allowAssetDir(workspaceRoot).catch(() => {});
  }, [workspaceRoot]);

  // 键位方案只存值：装绑定要 monaco，编辑器还没建起来时为它加载编辑器不划算。
  // 编辑器模块加载时取当前值装一次，之后换方案由那边撤掉上一套再装。
  useEffect(() => {
    setKeymapScheme(settings.editor.keymap);
  }, [settings.editor.keymap]);

  // 托盘菜单是系统画的，吃不到界面这套 i18n，文字得由这边递过去。
  useEffect(() => {
    void setTrayLabels(t("tray.show"), t("tray.quit"));
  }, [t]);

  // 失焦自动保存：窗口一失去焦点，把手上改过的都写回磁盘。
  useEffect(() => {
    if (settings.editor.savePolicy !== "blur") return;
    const onBlur = () => void saveAllRef.current();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [settings.editor.savePolicy]);

  // 退出前强制保存：后端拦下关闭发出这条事件，这边存完再让它真退。
  // 后端那条 5 秒看门狗兜住「前端没回音」，所以这里只管存，不用回话确认。
  useEffect(() => {
    const unlisten = listen("app://flush", async () => {
      await saveAllRef.current();
      await appExit().catch(() => {});
    });
    return () => void unlisten.then((off) => off()).catch(() => {});
  }, []);

  // 齿轮弹层里那两条分组依据带着快捷键，菜单项画了就必须真能用。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 主修饰键按平台认（macOS 是 Cmd+Alt），Shift 一律排除。
      if (!(event.ctrlKey || event.metaKey) || !event.altKey || event.shiftKey) return;
      if (!sidebarOpen || panel !== "git") return;
      // 日志窗口开着时这两个键归它自己：那边分的是一次提交里的文件，不是变更清单。
      if (places.log !== "hidden") return;
      const key = event.key.toLowerCase();
      if (key !== "p" && key !== "m") return;
      event.preventDefault();
      setCommitView((current) =>
        key === "p"
          ? { ...current, byDir: !current.byDir }
          : { ...current, byModule: !current.byModule }
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, places.log, sidebarOpen]);

  // WebView2 自带的「刷新 / 打印 / 检查」菜单在桌面应用里不该出现。
  // 各面板自己的菜单是事件处理器，preventDefault 不会挡掉它们。
  useEffect(() => {
    const block = (event: MouseEvent) => event.preventDefault();
    window.addEventListener("contextmenu", block, true);
    return () => window.removeEventListener("contextmenu", block, true);
  }, []);

  const refreshTree = useCallback(
    () => setTreeRefresh((current) => ({ paths: null, seq: current.seq + 1 })),
    []
  );
  /** 磁盘事件报得来的是具体哪几条路径变了，缓存就只作废与它们相干的那些目录。 */
  const refreshPaths = useCallback(
    (paths: string[]) => setTreeRefresh((current) => ({ paths, seq: current.seq + 1 })),
    []
  );

  /**
   * 磁盘上出了事就三处一起补：目录树重读、变更清单重取、打开的文档按干净 / 脏分别处理。
   * 报来的路径既喂给文档判定，也用来把树的缓存精确作废——清整张表的话，
   * 每个展开中的目录每批都要重发一次列目录。
   *
   * git 这侧只取变更清单：文件改动不会动分支、标签和 HEAD 上那条提交，
   * 每批事件都把五条命令起八个 git 进程，构建期间就是持续失血。
   */
  const onDiskChange = useCallback(
    (paths: string[]) => {
      refreshPaths(paths);
      // 构建期间每 150-300ms 就来一批事件，每批都起一个 git status 子进程的话
      // 就是持续失血：抖 500ms，风暴停下来才问一次最终状态。目录树那边是
      // 即时精确作废的，不跟着等。
      const gitTimer = gitDebounce.current;
      if (gitTimer) window.clearTimeout(gitTimer);
      gitDebounce.current = window.setTimeout(() => {
        gitDebounce.current = null;
        void gitRef.current.refreshChanges();
      }, 500);
      void docsRef.current.noteExternalChange(paths);
    },
    [refreshPaths]
  );

  useFileWatch(workspaceRoot, onDiskChange);

  /** 把一块工具窗口放到底部：底部是排他的，原来那块退回收起。 */
  const dockPane = useCallback((key: BottomPane) => {
    lastPlace.current[key] = "docked";
    setPlaces((current) => {
      const next = { ...current };
      for (const other of BOTTOM_ORDER) if (next[other] === "docked") next[other] = "hidden";
      next[key] = "docked";
      return next;
    });
    // 日志是三栏并排，太矮就没法看。
    if (key === "log") setBottomHeight((height) => Math.max(height, 380));
  }, []);

  /** 收起：只藏界面，shell 和任务继续在后台跑。 */
  const hidePane = useCallback((key: BottomPane) => {
    setPlaces((current) => ({ ...current, [key]: "hidden" }));
  }, []);

  /**
   * 拉起一块面板，但**只在它收着的时候**才动：已经停靠在底部或已挪进页签栏的，保持原状。
   * 触发运行/调试这类「顺带让你看一眼」的动作走这条，不能拿 `dockPane`——那会把用户
   * 手动挪到页签栏或正在看的面板强行拽回底部，等于篡改用户自己摆好的布局。
   */
  const revealPane = useCallback((key: BottomPane) => {
    setPlaces((current) => {
      // 已经可见（停靠在底部或挪进页签栏）：用户自己摆的位置，原样不动。
      if (current[key] !== "hidden") return current;
      // 收着才拉起：底部是排他的，原来停靠的那块退回收起。
      const next = { ...current };
      for (const other of BOTTOM_ORDER) if (next[other] === "docked") next[other] = "hidden";
      next[key] = "docked";
      return next;
    });
  }, []);

  /**
   * 把一块面板弄到眼前：收着的拉起到底部，挪进页签栏的就切到它那一页。
   *
   * 比 `revealPane` 多管页签栏那一档。运行脚本这类「你点了一定想看结果」的动作走这条：
   * 终端若被用户挪成了页签，`revealPane` 是空操作，命令在后台跑他却什么都没看见。
   */
  const focusPane = useCallback(
    (key: BottomPane) => {
      if (places[key] === "tabbed") setActiveTab(`pane|${key}`);
      else revealPane(key);
    },
    [places, revealPane]
  );

  /**
   * 本机扫出来的 shell，给脚本 ▶ 挑终端用。
   *
   * 只拉一次：装了新终端要重启应用才认得出，这跟终端页签那边同一个口径。
   */
  const shellsRef = useRef<ShellInfo[]>([]);
  useEffect(() => {
    void shellProbe()
      .then((list) => {
        shellsRef.current = list;
      })
      .catch(() => {
        shellsRef.current = [];
      });
  }, []);

  /**
   * 脚本文件装订线那颗 ▶：按脚本类型挑终端，把脚本发进去跑。
   *
   * 本机没有对应终端就直接拦下弹通知，不打开终端也不发命令——发过去也只会报一句看不懂的错。
   */
  const runScript = useCallback(
    (path: string) => {
      const kind = scriptKindOf(path);
      if (!kind) return;
      const shell = findShellForScript(shellsRef.current, kind);
      if (!shell) {
        reportError(codedError("NO_TERMINAL", scriptTerminalLabel(kind)));
        return;
      }
      // 终端起始目录用工程根：TerminalPane 挂载时按 cwd 复用会话，传脚本目录会让它再开一条空的。
      // 脚本真正的工作目录由命令里的 cd 落地。
      const dir = parentPath(path) ?? workspaceRoot ?? "";
      void runInTerminal(
        shell.path,
        workspaceRoot,
        buildScriptCommand(kind, path, dir),
        // 会话进表之后再把它弄到眼前：否则面板先挂载，needTermSession 找不到会话会另开一条空的。
        () => focusPane("terminal")
      ).catch((cause: unknown) => reportError(errorText(cause)));
    },
    [focusPane, reportError, workspaceRoot]
  );

  /** 挪进页签栏：好几块能同时开着，切换着看。 */
  const tabPane = useCallback((key: BottomPane) => {
    lastPlace.current[key] = "tabbed";
    setPlaces((current) => {
      const next = { ...current };
      for (const other of BOTTOM_ORDER) if (next[other] === "docked") next[other] = "hidden";
      next[key] = "tabbed";
      return next;
    });
    setActiveTab(`pane|${key}`);
  }, []);

  /** 活动栏那颗按钮：底部那块再点一次收起；在页签栏里的直接跳到它那一页。 */
  const railPane = useCallback(
    (key: BottomPane) => {
      if (places[key] === "docked") hidePane(key);
      else if (places[key] === "tabbed") setActiveTab(`pane|${key}`);
      // 收着的那颗：回到它上次待的地方，之前切到选项卡过就不硬塞回底部。
      else if (lastPlace.current[key] === "tabbed") tabPane(key);
      else dockPane(key);
    },
    [dockPane, hidePane, places, tabPane]
  );

  /** 把一份比对落到页签栏里：同 id 就地更新，新 id 追加到末尾并选中。 */
  /** 填内容的那一次不许抢焦点：加载完成时用户可能已经切去别处了。 */
  const putDiff = useCallback((tab: DiffTab, activate: boolean = true) => {
    setDiffs((list) =>
      list.some((item) => item.id === tab.id)
        ? list.map((item) => (item.id === tab.id ? tab : item))
        : [...list, tab]
    );
    if (activate) setActiveTab(`diff|${tab.id}`);
  }, []);

  const closeDiff = useCallback((id: string) => {
    setDiffs((list) => list.filter((item) => item.id !== id));
  }, []);

  /**
   * 开随处搜索弹层。`query` 是从编辑器选区带过来的词（IDEA 的 `PREDEFINED_TEXT`），
   * 没选东西就留空；`scope` 为空表示搜整个工程，非空就是 IDEA 的 Look in Directory。
   */
  const openEverywhere = useCallback(
    (tab: SearchTab = "all", query = "", scope: string | null = null) => {
      searchSeq.current += 1;
      setEverywhere({ tab, query, scope });
    },
    []
  );

  /**
   * 把一条路径交给目录树：侧栏收着就打开，停在 Git 面板就扳回资源管理器，
   * 逐层展开、选中与滚动都在树那边。
   */
  const revealInTree = useCallback((path: string) => {
    setPanel("explorer");
    setSidebarOpen(true);
    setTreeReveal((current) => ({ path, seq: (current?.seq ?? 0) + 1 }));
  }, []);

  /** 跳一处命中：落到那一行，并把命中的那一段选住。 */
  const revealHit = useCallback(
    (hit: TextHit) => {
      const first = hit.ranges[0];
      // 编辑区显示哪一篇读的是 activeTab，只走 useDocuments 那边的 activate 翻不出那一页。
      setActiveTab(`doc|${hit.path}`);
      void docs.openHit(hit.path, hit.line, first?.column, first?.length);
      revealInTree(hit.path);
    },
    [docs, revealInTree]
  );

  /**
   * 弹层里点开一个文件：进编辑区，光标不动，IDEA 的 Files 页也是这样落。
   * 目录那一条没有正文可开，落点全在树上——展开它并把它选住。
   */
  const openSearchFile = useCallback(
    (path: string, isDir: boolean) => {
      if (!isDir) {
        setActiveTab(`doc|${path}`);
        void docs.open(path);
      }
      revealInTree(path);
    },
    [docs, revealInTree]
  );

  /**
   * 弹层里点开一处正文命中：跳进编辑器，同一整页结果留在底部查找窗口里。
   * IDEA 那边 Enter 之后弹层关掉、结果还摆在 Find 窗口，这边一样。
   */
  const openSearchHit = useCallback(
    (hit: TextHit, page: TextPage, options: SearchOptions) => {
      setFind({ query: page.query, options, page });
      dockPane("find");
      revealHit(hit);
    },
    [dockPane, revealHit]
  );

  /**
   * 搜索那三颗键位是应用级的，不走 monaco 的键绑定，三个快捷键方案里都是同一套。
   *
   * 双击 Shift 照 IDEA 那条键盘手势（`$default.xml` 里的 `shift SHIFT`）：两次 Shift 的
   * 间隔不超过 300ms 才算，中间落了别的键就重新计。焦点在输入框里时不认这条，
   * 否则重命名框里连按两下 Shift 会把弹层盖上去；monaco 那块输入面除外，
   * 它是编辑器本体，IDEA 在这儿照样生效。终端的辅助 textarea 不除外，那边敲的是 shell。
   */
  useEffect(() => {
    let lastShiftAt = 0;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inEditor = target?.classList.contains("inputarea") ?? false;
      const inField =
        !!target &&
        (target.isContentEditable ||
          ((target.tagName === "INPUT" || target.tagName === "TEXTAREA") && !inEditor));
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey) {
        const key = event.key.toLowerCase();
        // Ctrl+Shift+F 是 Find in Files：直接开在文本页签，词取编辑器选区。
        if (key === "f") {
          event.preventDefault();
          openEverywhere("text", selectedText());
          return;
        }
        // Ctrl+Shift+N 是 Go to File：同一个弹层落在文件页签上，不是另一个框。
        if (key === "n") {
          event.preventDefault();
          openEverywhere("files");
          return;
        }
      }
      if (event.key !== "Shift" || inField || dialog || menu || resolveOpen || everywhere) return;
      const now = event.timeStamp;
      if (now - lastShiftAt <= 300) {
        lastShiftAt = 0;
        event.preventDefault();
        openEverywhere("all");
        return;
      }
      lastShiftAt = now;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, everywhere, menu, openEverywhere, resolveOpen]);

  /**
   * 运行那几条键位和应用级的搜索键一样住在窗口上：工具窗口收着、焦点在终端里都按得到。
   *
   * 键位取 IDEA 的 Run 布局——`Shift+F10` 跑、`Ctrl+F5` 重跑、`Ctrl+F2` 停、
   * `Alt+Shift+F10` 选配置、`Alt+4` 开 Run 窗口。没选配置时 `Shift+F10` 不空跑，
   * 直接把选择下拉打开：IDEA 在那儿弹的是「没有可运行的配置」，这边让人当场挑一条。
   * 模态开着时整条不认，跟搜索那几颗一个规矩。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialog || menu || resolveOpen || everywhere) return;
      const ctrl = event.ctrlKey || event.metaKey;
      if (event.key === "F10" && event.shiftKey && !ctrl) {
        event.preventDefault();
        if (event.altKey) {
          setRunChooser((signal) => signal + 1);
          return;
        }
        const picked = configs.selected;
        if (!picked) {
          setRunChooser((signal) => signal + 1);
          return;
        }
        run.start(picked);
        focusPane("run");
        return;
      }
      if (ctrl && !event.altKey && !event.shiftKey && event.key === "F5") {
        event.preventDefault();
        // 重跑选中的那条：正在跑的实例就地重开，没在跑的按普通运行起一条。
        const picked = configs.selected;
        if (picked) {
          const running = run.sessions.filter(
            (session) => session.status === "running" && session.config.id === picked.id
          );
          if (running.length === 0) run.start(picked);
          else for (const session of running) run.restartSession(session.id);
        }
        focusPane("run");
        return;
      }
      if (ctrl && !event.altKey && !event.shiftKey && event.key === "F2") {
        event.preventDefault();
        for (const session of run.sessions) {
          if (session.status === "running") run.stop(session.id);
        }
        return;
      }
      if (event.altKey && !ctrl && !event.shiftKey && event.key === "4") {
        event.preventDefault();
        if (places.run === "docked") hidePane("run");
        else dockPane("run");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [configs, dialog, dockPane, everywhere, focusPane, hidePane, menu, places.run, resolveOpen, run]);

  const openFolder = useCallback(async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: t("workspace.openFolder"),
      defaultPath: workspaceRoot ?? undefined,
    });
    // 确认选了新目录才收上一处的 shell：先收再弹框的话，用户点个取消
    // 也会把还在跑的终端任务一起带走。
    if (typeof picked !== "string" || picked.length === 0) return;
    void dropTermSession();
    disposeAllModels();
    docs.closeAll();
    setDiffs([]);
    setExplorerPick([]);
    setClipboard(null);
    setActiveToasts([]);
    // 旧工程的比对链与查找结果里攥着旧工程绝对路径，留着只会泄漏内存，
    // 命中行点击还会开到旧工程的文件去。
    diffChains.current.clear();
    setFind({
      query: "",
      options: { caseSensitive: false, wholeWords: false, regex: false, fileMask: "", limit: 0 },
      page: null,
    });
    setWorkspaceRoot(picked);
    remember("recentFolders", picked);
    setPanel("explorer");
    setSidebarOpen(true);
  }, [docs, remember, t, workspaceRoot]);

  const closeFolder = useCallback(() => {
    void dropTermSession();
    disposeAllModels();
    docs.closeAll();
    setDiffs([]);
    setExplorerPick([]);
    setClipboard(null);
    // 关闭工程同样清掉旧工程的比对链与查找结果，别把它们滞留到下一次 openFolder。
    diffChains.current.clear();
    setFind({
      query: "",
      options: { caseSensitive: false, wholeWords: false, regex: false, fileMask: "", limit: 0 },
      page: null,
    });
    setWorkspaceRoot(null);
  }, [docs]);

  const openFile = useCallback(
    (entry: FsEntry) => {
      setActiveTab(`doc|${entry.path}`);
      void docs.open(entry.path);
    },
    [docs]
  );

  /** markdown 预览里点本地链接：按类型开进编辑区（图片进预览，文本进编辑器）。 */
  const openLocalFile = useCallback(
    (absolute: string) => {
      setActiveTab(`doc|${absolute}`);
      void docs.open(absolute);
    },
    [docs]
  );

  const saveActive = useCallback(async () => {
    const path = docs.activePath;
    if (!path) return;
    const saved = await docs.save(path);
    // 存盘只动工作区内容，取一份变更清单就够；分支/标签/日志那几条留给显式刷新。
    if (saved) void git.refreshChanges();
  }, [docs, git]);

  const closeDocTab = useCallback(
    (path: string) => {
      if (docs.dirty(path)) {
        setDialog({ kind: "discard", name: basenameOf(path), path, entry: null, dir: null });
        return;
      }
      disposeModel(path);
      docs.close(path);
    },
    [docs]
  );

  /**
   * 比对标签的统一落点：两侧文本由调用方去取，取失败就把刚开的空标签收掉。
   *
   * 打开前先按扩展名判一次：图片能打开但不能逐行比对，其余二进制两样都不行。
   * 这类「本来就没得比」的理由直接摆在标签正文里，不去读盘、不弹横幅。
   */
  const openDiffTab = useCallback(
    async (
      base: Omit<DiffTab, "original" | "modified" | "notice">,
      load: () => Promise<GitFileSides>
    ) => {
      // 这几条串里都藏着路径：显示串拼着两条（`a → b`、`x ↔ y`），双文件比对还把两条路径写进了表头。
      // 逐段判：任一侧是图片或二进制，这次比对就没得比。
      const blocked = [base.path, base.leftLabel, base.rightLabel]
        .flatMap((text) => text.split(/\s*[→↔]\s*/))
        .map((piece) => docKindOf(piece))
        .find((kind) => !canDiff(kind));
      if (blocked) {
        // 存错误码原文，渲染时再翻；这样切语言时这句说明也跟着换。
        putDiff({
          ...base,
          original: "",
          modified: "",
          notice: codedError(
            "NO_DIFF",
            base.path || `${base.leftLabel} → ${base.rightLabel}`,
            blocked
          ),
        });
        return;
      }
      putDiff({ ...base, original: "", modified: "" });
      try {
        const sides = await load();
        putDiff({ ...base, original: sides.original, modified: sides.modified }, false);
      } catch (cause) {
        closeDiff(base.id);
        reportError(errorText(cause));
      }
    },
    [closeDiff, putDiff, reportError]
  );

  /** 工作区里那份文件现在的文本：编辑器里没存的改动比磁盘新，删掉了就是空。 */
  const worktreeText = useCallback(
    async (absolute: string, deleted: boolean) => {
      const openDoc = docs.documents.find((doc) => doc.path === absolute);
      if (openDoc && docs.dirty(absolute)) return openDoc.contents;
      if (deleted) return "";
      return (await readFile(absolute)).contents;
    },
    [docs.dirty, docs.documents]
  );

  /** 工作区改动：索引位取 HEAD → 索引，工作区位取索引 → 工作区。 */
  const openChange = useCallback(
    (change: GitChange, staged: boolean, siblings: GitChange[], step?: ChainStep) => {
      const root = git.root;
      if (!root) return;
      const absolute = git.absoluteOf(change.path);
      // 重命名的基线在旧路径上；只按新路径取 HEAD / 索引，会把整份文件显示成新增。
      const baseAbsolute = change.oldPath ? git.absoluteOf(change.oldPath) : absolute;
      const chainId = `ws|${staged ? "hi" : "iw"}`;
      // 那一串就是面板上眼前这一组：一串只有一篇时计数照摆，只是不摆那两枚左右箭头。
      const list = siblings.length > 0 ? siblings : [change];
      const index = Math.max(
        0,
        list.findIndex((item) => item.path === change.path)
      );
      diffChains.current.set(chainId, { kind: "change", staged, items: list });
      void openDiffTab(
        {
          id: step?.tabId ?? `${chainId}|${change.path}`,
          name: basenameOf(change.path),
          leftLabel: t(staged ? "git.revHead" : "git.revIndex"),
          rightLabel: t(staged ? "git.revIndex" : "git.revWorktree"),
          path: change.path,
          language: languageForPath(change.path),
          chain: { id: chainId, index, total: list.length },
          landOn: step?.land,
          // 哪一侧写着删除，工作区里就没这份文件，跳到源码去不了。
          openIn:
            change.indexStatus === "D" || change.workStatus === "D" ? undefined : absolute,
        },
        async () => {
          const original = staged
            ? await gitShow(root, "HEAD", baseAbsolute)
            : await gitIndexShow(root, baseAbsolute).catch(() => "");
          const openDoc = docs.documents.find((doc) => doc.path === absolute);
          // 已暂存对比右侧是索引内容；未暂存对比右侧是工作区，编辑器未保存改动优先。
          const modified = staged
            ? await gitIndexShow(root, absolute)
            : openDoc && docs.dirty(absolute)
              ? openDoc.contents
              : change.workStatus === "D"
                ? // 工作区已经没有这个文件，读盘会报错，右侧本来就该是空的。
                  ""
                : (await readFile(absolute)).contents;
          return { original, modified };
        }
      );
    },
    [docs.dirty, docs.documents, git, openDiffTab, t]
  );

  /** 「与本地比较」那几项：左那一侧是某个版本下的文件，右那一侧是工作区里现在这份。 */
  const openAgainstWorktree = useCallback(
    (
      chainId: string,
      revision: string,
      leftLabel: string,
      file: DiffFileRef,
      siblings?: DiffFileRef[],
      step?: ChainStep
    ) => {
      const root = git.root;
      if (!root) return;
      const absolute = git.absoluteOf(file.path);
      const baseAbsolute = file.oldPath ? git.absoluteOf(file.oldPath) : absolute;
      const list = siblings && siblings.length > 0 ? siblings : undefined;
      let chain: DiffTab["chain"];
      if (list) {
        diffChains.current.set(chainId, { kind: "against", chainId, revision, leftLabel, items: list });
        chain = {
          id: chainId,
          index: Math.max(
            0,
            list.findIndex((item) => item.path === file.path)
          ),
          total: list.length,
        };
      }
      void openDiffTab(
        {
          // 走链时写回自己那颗标签；从入口发起的比对才是新的一颗。
          id: step?.tabId ?? `${chainId}|${file.path}`,
          name: basenameOf(file.path),
          leftLabel,
          rightLabel: t("git.revWorktree"),
          path: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path,
          language: languageForPath(file.path),
          chain,
          landOn: step?.land,
          openIn: file.status === "D" ? undefined : absolute,
        },
        async () => ({
          original: await gitShow(root, revision, baseAbsolute),
          modified: await worktreeText(absolute, file.status === "D"),
        })
      );
    },
    [git, openDiffTab, t, worktreeText]
  );

  /** 把某个版本下的文件写回工作区，目录树和开着的文档都跟着重读。 */
  const writeBack = useCallback(
    async (revision: string, absolute: string) => {
      const done = await git.restoreFile(revision, absolute);
      if (!done) return;
      refreshTree();
      void docs.noteExternalChange([absolute]);
    },
    [docs.noteExternalChange, git.restoreFile, refreshTree]
  );

  /** 日志里双击一个文件：把这次提交前后的两份内容开到标签页里比对；`fresh` 为真时另开一个标签。 */
  const openCommitFile = useCallback(
    (
      commit: GitCommitDetail,
      file: GitCommitFile,
      fresh: boolean,
      siblings?: GitCommitFile[],
      step?: ChainStep
    ) => {
      const root = git.root;
      if (!root) return;
      // 「在新标签页中显示差异」要的是另一条链：后缀并进编号里，两颗标签各走各的串。
      const chainId = `cm|${commit.hash}${fresh ? `|${(diffSeq.current += 1)}` : ""}`;
      const list = siblings && siblings.length > 0 ? siblings : undefined;
      let chain: DiffTab["chain"];
      if (list) {
        diffChains.current.set(chainId, { kind: "commitFile", commit, items: list });
        chain = {
          id: chainId,
          index: Math.max(
            0,
            list.findIndex((item) => item.path === file.path)
          ),
          total: list.length,
        };
      }
      void openDiffTab(
        {
          id: step?.tabId ?? `${chainId}|${file.path}`,
          name: basenameOf(file.path),
          // 根提交没有父版本，那一侧本来就是空的，表头也跟着不给名字。
          leftLabel: commit.parents[0] ?? "",
          rightLabel: commit.short,
          path: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path,
          language: languageForPath(file.path),
          chain,
          landOn: step?.land,
        },
        () => gitCommitFile(root, commit.hash, file.path)
      );
    },
    [git.root, openDiffTab]
  );

  /** 文件菜单里点名那两个版本：两侧都从仓库取，链上换下一篇比的还是这一对。 */
  const openBetweenRevisions = useCallback(
    (
      commit: GitCommitDetail,
      file: GitCommitFile,
      parent: string,
      siblings?: GitCommitFile[],
      step?: ChainStep
    ) => {
      const root = git.root;
      if (!root) return;
      const absolute = git.absoluteOf(file.path);
      const baseAbsolute = file.oldPath ? git.absoluteOf(file.oldPath) : absolute;
      const chainId = `dp|${commit.hash}`;
      const list = siblings && siblings.length > 0 ? siblings : undefined;
      let chain: DiffTab["chain"];
      if (list) {
        diffChains.current.set(chainId, { kind: "between", commit, parent, items: list });
        chain = {
          id: chainId,
          index: Math.max(
            0,
            list.findIndex((item) => item.path === file.path)
          ),
          total: list.length,
        };
      }
      void openDiffTab(
        {
          id: step?.tabId ?? `${chainId}|${file.path}`,
          name: basenameOf(file.path),
          leftLabel: parent,
          rightLabel: commit.short,
          path: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path,
          language: languageForPath(file.path),
          chain,
          landOn: step?.land,
        },
        async () => ({
          original: await gitShow(root, parent, baseAbsolute),
          modified: await gitShow(root, commit.hash, absolute),
        })
      );
    },
    [git, openDiffTab]
  );

  /** 日志第三栏文件菜单的落点：比对开标签页，其余直接读写工作区。 */
  const fileAction = useCallback(
    (action: FileAction, commit: GitCommitDetail, file: GitCommitFile) => {
      const root = git.root;
      if (!root) return;
      const absolute = git.absoluteOf(file.path);
      const parent = commit.parents[0] ?? "";
      switch (action) {
        case "diff":
          openCommitFile(commit, file, false, commit.files);
          break;
        case "diffNewTab":
          openCommitFile(commit, file, true, commit.files);
          break;
        case "diffLocal":
          openAgainstWorktree(`dl|${commit.hash}`, commit.hash, commit.short, file, commit.files);
          break;
        case "diffParentLocal":
          if (parent) openAgainstWorktree(`dpl|${commit.hash}`, parent, parent, file, commit.files);
          break;
        case "diffParent":
          // 与「显示差异」的差别在于两侧都取自仓库，表头就摆那两个版本。
          if (parent) openBetweenRevisions(commit, file, parent, commit.files);
          break;
        case "openRepoVersion": {
          // 二进制开不出文本，git show 给的是一堆替换字符，不如照实说打不开。
          const versionKind = docKindOf(file.path);
          if (!hasTextContent(versionKind)) {
            const virtual = `${absolute}@${commit.short}`;
            setActiveTab(`doc|${virtual}`);
            docs.openNotice(virtual, codedError("BINARY", file.path));
            break;
          }
          void gitShow(root, commit.hash, absolute).then(
            (contents) => {
              // 这份内容不在磁盘上，拿「路径@短哈希」当只读文档的键。
              const virtual = `${absolute}@${commit.short}`;
              setActiveTab(`doc|${virtual}`);
              docs.openVirtual(virtual, contents, languageForPath(file.path));
            },
            (cause: unknown) => reportError(errorText(cause))
          );
          break;
        }
        case "revert":
          // 撤销那次改动＝把这条提交的父版写回工作区；只动工作区，索引留着不动，
          // 人还能用「全部取消暂存」那条路退回去。
          if (parent) void writeBack(parent, absolute);
          break;
        case "getFromRevision":
          void writeBack(commit.hash, absolute);
          break;
        case "patch":
          setDialog({
            kind: "patch",
            name: `${patchStem(file.path)}-${commit.short}.patch`,
            path: file.path,
            revision: commit.hash,
            from: parent || EMPTY_TREE_HASH,
            dir: workspaceRoot,
            hint: workspaceRoot ?? undefined,
            entry: null,
          });
          break;
      }
    },
    [
      docs.noteExternalChange,
      docs.openVirtual,
      git,
      openAgainstWorktree,
      openBetweenRevisions,
      openCommitFile,
      refreshTree,
      reportError,
      workspaceRoot,
      writeBack,
    ]
  );

  /** 「显示与工作树的差异」里双击一行：那条引用对工作区。 */
  const compareWork = useCallback(
    (revision: string, entry: GitNameStatus, siblings: GitNameStatus[]) => {
      openAgainstWorktree(`cw|${revision}`, revision, revision, entry, siblings);
    },
    [openAgainstWorktree]
  );

  /** 编辑源：把工作区里那份文件开进编辑器。 */
  const editSource = useCallback(
    (relative: string) => {
      const absolute = git.absoluteOf(relative);
      setActiveTab(`doc|${absolute}`);
      void docs.open(absolute);
    },
    [docs.open, git]
  );

  /** 仓库相对路径（正斜杠）：.gitignore 里写这一份，日志的路径过滤也认这一份。 */
  const repoRelative = useCallback(
    (absolute: string) => {
      const root = git.root;
      if (!root || !absolute.toLowerCase().startsWith(root.toLowerCase())) return absolute;
      return absolute.slice(root.length).replace(/^[\\/]+/, "").replaceAll("\\", "/");
    },
    [git.root]
  );

  /** 往 .gitignore 末尾追加几行；仓库里还没有这个文件就从空写起。已经写过的行不再重复。 */
  const addToGitignore = useCallback(
    async (relativePaths: string[]) => {
      if (!git.root || relativePaths.length === 0) return;
      const ignoreFile = joinPath(git.root, ".gitignore");
      let text = "";
      try {
        text = (await readFile(ignoreFile)).contents;
      } catch {
        // 还没有 .gitignore，从空文件写起。
      }
      const known = new Set(text.split(/\r?\n/));
      const adding = relativePaths.filter((relative) => !known.has(relative));
      if (adding.length === 0) return;
      const body = text === "" || text.endsWith("\n") ? text : `${text}\n`;
      try {
        await writeFile(ignoreFile, `${body}${adding.join("\n")}\n`, "lf", false);
        refreshTree();
      } catch (cause) {
        reportError(errorText(cause));
      }
    },
    [git.root, refreshTree, reportError]
  );

  /**
   * 从忽略列表移除，去掉的是**盖住这一条的那条规则**：`logs/run.log` 是被 `*.log` 盖住的，
   * 照它的路径写一条反向规则动不到那条通配。规则也不一定写在 `.gitignore` 里——可能在
   * `.git/info/exclude`，也可能在用户的全局忽略文件里；仓库外那份只报在哪个文件，不动它。
   */
  const removeFromGitignore = useCallback(
    async (relative: string) => {
      if (!git.root) return;
      const rule = await gitIgnoreRule(git.root, relative);
      const hit = /^(.*?):(\d+):/.exec(rule);
      if (!hit) {
        reportError(t("git.ignoreRuleMissing", { path: relative }));
        return;
      }
      const source = resolvePath(git.root, hit[1] ?? "");
      if (!pathWithin(git.root, source)) {
        reportError(t("git.ignoreRuleOutside", { file: source }));
        return;
      }
      const line = Number(hit[2]);
      try {
        const body = (await readFile(source)).contents;
        const lines = body.split(/\r?\n/);
        lines.splice(line - 1, 1);
        await writeFile(source, lines.join("\n"), "lf", false);
        refreshTree();
        await git.refresh();
      } catch (cause) {
        reportError(errorText(cause));
      }
    },
    [git, refreshTree, reportError, t]
  );

  /** 剪切 / 复制攒下这一批，连同它是挪走还是留下。 */
  const copyPicked = useCallback((entries: FsEntry[], cut: boolean) => {
    if (entries.length === 0) return;
    setClipboard({ entries, cut });
  }, []);

  /** 新建与粘贴的落点：单选一个目录就落在它里面，否则落在主行的上一层；空白处右键落在工程根。 */
  const targetDirOf = useCallback(
    (selection: FsEntry[]) => {
      const primary = selection[selection.length - 1] ?? null;
      if (!primary) return workspaceRoot;
      if (selection.length === 1 && primary.kind === "directory") return primary.path;
      return parentPath(primary.path) ?? workspaceRoot;
    },
    [workspaceRoot]
  );

  /**
   * 把攒下的那一批落进 `dir`。撞名不覆盖，直接把后端的错报回去——覆盖是找回不来的事，这里不猜。
   * 剪切那批粘完就清空；跨盘挪动时源删不掉，后端会连「两份都在盘上」一起报出来。
   */
  const pasteInto = useCallback(
    async (dir: string | null) => {
      if (!clipboard || !dir) return;
      let done = 0;
      for (const entry of clipboard.entries) {
        const target = joinPath(dir, entry.name);
        // 原地粘贴（剪切后贴回它自己所在的目录）什么也不做。
        if (samePath(target, entry.path)) continue;
        try {
          if (clipboard.cut) await moveEntry(entry.path, target);
          else await copyEntry(entry.path, target);
          done += 1;
        } catch (cause) {
          reportError(errorText(cause));
        }
      }
      if (clipboard.cut) setClipboard(null);
      if (done > 0) {
        // 选中集里那几条已经换到别处去了，留着只会让下一次 Delete / 粘贴落在不存在的路上。
        setExplorerPick([]);
        refreshTree();
        void git.refreshChanges();
      }
    },
    [clipboard, git, refreshTree, reportError]
  );

  /** 恰好选中两个文件才比对，开的是这两份现在的文本。 */
  const compareFiles = useCallback(
    (selection: FsEntry[]) => {
      const files = selection.filter((entry) => entry.kind !== "directory");
      const left = files[0];
      const right = files[1];
      if (files.length !== 2 || !left || !right) return;
      void openDiffTab(
        {
          id: `fs|${left.path}|${right.path}`,
          name: `${basenameOf(left.path)} ↔ ${basenameOf(right.path)}`,
          // 两侧本来就是磁盘上两篇文件：表头直接写各自的路径，不再补一条路径。
          leftLabel: left.path,
          rightLabel: right.path,
          path: "",
          language: languageForPath(right.path),
          openIn: right.path,
        },
        async () => ({
          original: (await readFile(left.path)).contents,
          modified: (await readFile(right.path)).contents,
        })
      );
    },
    [openDiffTab]
  );

  /**
   * 顶栏那两枚左右箭头与「走到头转篇」的落点：沿标签上记的那条链走到相邻那一篇，
   * 按同一口径重开一次比对，并且写回**它自己那颗标签**。
   *
   * 链上存的是这一串文件与比法，不是打开它的闭包——所以旧标签的箭头走的还是它自己那一串，
   * 序号也从标签上现读，不靠谁记住走到哪了。写回同一颗是 IDEA 的规矩：比对标签装的是整条链，
   * 走链只换里面那一篇。
   */
  const stepChain = useCallback(
    (tabId: string, delta: number, land?: "first" | "last") => {
      const tab = diffs.find((item) => item.id === tabId);
      const chain = tab?.chain;
      const list = chain ? diffChains.current.get(chain.id) : undefined;
      if (!chain || !list) return;
      const at = chain.index + delta;
      if (at < 0 || at >= chain.total) return;
      const step: ChainStep = { tabId, land };
      if (list.kind === "change") {
        const next = list.items[at];
        if (next) openChange(next, list.staged, list.items, step);
        return;
      }
      if (list.kind === "commitFile") {
        const next = list.items[at];
        if (next) openCommitFile(list.commit, next, false, list.items, step);
        return;
      }
      if (list.kind === "between") {
        const next = list.items[at];
        if (next) openBetweenRevisions(list.commit, next, list.parent, list.items, step);
        return;
      }
      const next = list.items[at];
      if (next) openAgainstWorktree(list.chainId, list.revision, list.leftLabel, next, list.items, step);
    },
    [diffs, openAgainstWorktree, openBetweenRevisions, openChange, openCommitFile]
  );

  /**
   * 顶栏那两枚左右箭头要的一组：序号与总数读标签上的链，走的还是那条链。
   *
   * `land` 非空是上下箭头走到本篇尽头转过来的——换篇之后要落在首 / 末那一处差异上，
   * 跟左右两枚本身的换篇（从头看起）区分开。
   */
  const diffGroupOf = useCallback(
    (tab: DiffTab): DiffGroup | undefined =>
      tab.chain
        ? {
            index: tab.chain.index,
            total: tab.chain.total,
            onPrev: (land) => stepChain(tab.id, -1, land),
            onNext: (land) => stepChain(tab.id, 1, land),
          }
        : undefined,
    [stepChain]
  );

  /** 跳到源码：把这份比对对应的那个工作区文件开进编辑器；对不出来就没有这一项。 */
  const diffOpenFile = useMemo(() => {
    const absolute = activeDiffTab?.openIn;
    if (!absolute) return undefined;
    return () => {
      setActiveTab(`doc|${absolute}`);
      void docs.open(absolute);
    };
  }, [activeDiffTab?.openIn, docs.open, setActiveTab]);

  /** 删除确认落在整批选中上：文案报第一条的名字，真正删的是这一批的路径。 */
  const confirmDelete = useCallback((selection: FsEntry[]) => {
    const primary = selection[selection.length - 1];
    if (!primary) return;
    setDialog({
      kind: "delete",
      name: primary.name,
      path: primary.path,
      isDirectory: primary.kind === "directory",
      count: selection.length,
      entry: primary,
      dir: null,
      many: selection.map((entry) => entry.path),
    });
  }, []);

  const confirmRename = useCallback((entry: FsEntry) => {
    setDialog({
      kind: "rename",
      name: entry.name,
      path: entry.path,
      entry,
      dir: parentPath(entry.path),
    });
  }, []);

  /** 把日志叫出来并筛到这一条路径上；提交树和目录树两处历史记录走的是同一句。 */
  const showFileHistory = useCallback(
    (relative: string) => {
      setLogPath(relative);
      if (places.log === "hidden") dockPane("log");
      else if (places.log === "tabbed") setActiveTab("pane|log");
    },
    [dockPane, places.log]
  );

  /**
   * 提交树文件行菜单里要动编辑器、对话框或日志的那几项。
   * 补丁取 HEAD 到工作区这一段：暂存过的那一行工作区与索引同内容，范围一致。
   */
  const commitFileAction = useCallback(
    async (action: CommitFileAction, change: GitChange) => {
      if (!git.root) return;
      const absolute = git.absoluteOf(change.path);
      switch (action) {
        case "editSource":
          editSource(change.path);
          break;
        case "patch":
          setDialog({
            kind: "patch",
            name: `${patchStem(change.path)}-worktree.patch`,
            path: change.path,
            revision: "",
            from: "HEAD",
            dir: workspaceRoot,
            hint: workspaceRoot ?? undefined,
            entry: null,
          });
          break;
        case "patchClipboard":
          try {
            await navigator.clipboard.writeText(await gitDiffText(git.root, "HEAD", "", absolute));
          } catch (cause) {
            reportError(errorText(cause));
          }
          break;
        case "history":
          showFileHistory(change.path);
          break;
        case "delete":
          setDialog({
            kind: "delete",
            name: basenameOf(absolute),
            path: absolute,
            isDirectory: false,
            entry: null,
            dir: null,
          });
          break;
        case "ignore":
          await addToGitignore([change.path]);
          break;
      }
    },
    [addToGitignore, editSource, git, reportError, showFileHistory, workspaceRoot]
  );

  /**
   * 目录树那一句右键菜单，照 IDEA 的 ProjectViewPopupMenu 排：
   * 新建一组 / 剪切复制粘贴一组 / 打开 / 重命名与删除 / 路径与外部打开 / Git 子菜单 / 比对 / 刷新。
   * 每一项作用在整批选中上，只有要求「恰好一条」的那几条多选时点不动。
   */
  const requestMenu = useCallback(
    (selection: FsEntry[], position: { x: number; y: number }) => {
      const one = selection.length === 1 ? (selection[0] ?? null) : null;
      const needOne = one === null ? t("menu.needOne") : undefined;
      const dir = targetDirOf(selection);
      const files = selection.filter((entry) => entry.kind !== "directory");
      const sole = one !== null && one.kind !== "directory" ? one : null;
      const has = selection.length > 0;

      // IDEA 在树里给的是整个 Git 子菜单（Git.ContextMenu），这里只摆后端撑得住的三条。
      // 未跟踪那一条还没有来路可查：历史记录查的是这条路径在提交里的经过，一次都没提交过就是空的。
      const untrackedSole =
        sole !== null &&
        (git.status?.changes ?? []).some(
          (change) => change.untracked && change.path === repoRelative(sole.path)
        );
      const gitGroup: MenuItem[] =
        !git.root || files.length === 0
          ? []
          : [
              {
                label: "Git",
                children: [
                  {
                    label: t("git.stage"),
                    onSelect: () => void git.stage(files.map((entry) => entry.path)),
                  },
                  ...(sole && !untrackedSole
                    ? [
                        {
                          label: t("git.history"),
                          onSelect: () => showFileHistory(repoRelative(sole.path)),
                        },
                      ]
                    : []),
                  {
                    label: t("git.ignoreFile"),
                    onSelect: () =>
                      void addToGitignore(files.map((entry) => repoRelative(entry.path))),
                  },
                ],
              },
            ];

      setMenu({
        ...position,
        items: flatMenu([
          [
            {
              label: t("action.newFile"),
              onSelect: () =>
                setDialog({ kind: "newFile", name: "untitled.txt", dir, entry: null }),
            },
            {
              label: t("action.newFolder"),
              onSelect: () =>
                setDialog({
                  kind: "newFolder",
                  name: t("dialog.newFolderDefault"),
                  dir,
                  entry: null,
                }),
            },
          ],
          [
            {
              label: t("menu.cut"),
              shortcut: `${MOD_LABEL}+X`,
              disabled: !has,
              onSelect: () => copyPicked(selection, true),
            },
            {
              label: t("action.copy"),
              shortcut: `${MOD_LABEL}+C`,
              disabled: !has,
              onSelect: () => copyPicked(selection, false),
            },
            ...(clipboard
              ? [
                  {
                    label: t("action.paste"),
                    shortcut: `${MOD_LABEL}+V`,
                    onSelect: () => void pasteInto(dir),
                  },
                ]
              : []),
          ],
          // 目录靠单击展开，「打开」与「用关联应用打开」都只给文件。
          sole ? [{ label: t("menu.open"), onSelect: () => openFile(sole) }] : [],
          [
            {
              label: t("menu.rename"),
              shortcut: "F2",
              disabled: one === null,
              hint: needOne,
              onSelect: () => {
                if (one) confirmRename(one);
              },
            },
            {
              label: t("menu.delete"),
              shortcut: "Delete",
              danger: true,
              disabled: !has,
              onSelect: () => confirmDelete(selection),
            },
          ],
          [
            {
              label: t("menu.copyPath"),
              disabled: !has,
              onSelect: () =>
                void navigator.clipboard.writeText(selection.map((entry) => entry.path).join("\n")),
            },
            ...(one !== null
              ? [{ label: t("menu.reveal"), onSelect: () => void revealEntry(one.path) }]
              : []),
            ...(sole
              ? [
                  {
                    label: t("menu.openWith"),
                    onSelect: () =>
                      void openExternal(sole.path).catch((cause: unknown) =>
                        reportError(errorText(cause))
                      ),
                  },
                ]
              : []),
          ],
          gitGroup,
          // IDEA 把 Find in Path 紧跟在 Git 组后面。作用层照 `setDirectoryName` 那套取：
          // 目录取自身，文件取父目录，空白处取工程根，`targetDirOf` 已是这个口径。
          // 落在工程根时传 null，弹层底部那句作用域才不会出现「整个工程里再搜一个子目录」的怪话。
          workspaceRoot
            ? [
                {
                  label: t("menu.findInDirectory"),
                  onSelect: () =>
                    openEverywhere("text", selectedText(), dir === workspaceRoot ? null : dir),
                },
              ]
            : [],
          files.length === 2
            ? [{ label: t("menu.compareFiles"), onSelect: () => compareFiles(selection) }]
            : [],
          [
            {
              label: t("tool.refresh"),
              onSelect: () => {
                refreshTree();
                void git.refresh();
              },
            },
          ],
        ]),
      });
    },
    [
      addToGitignore,
      clipboard,
      compareFiles,
      confirmDelete,
      confirmRename,
      copyPicked,
      git,
      openEverywhere,
      openFile,
      pasteInto,
      refreshTree,
      repoRelative,
      reportError,
      showFileHistory,
      t,
      targetDirOf,
      workspaceRoot,
    ]
  );

  /**
   * 目录树菜单上画了键位的那几句必须真能用，且只作用在选中集上。
   * 只在这侧栏停着、树里有选中的时候接手；输入框和编辑器里的按键一律让行。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!sidebarOpen || panel !== "explorer" || explorerPick.length === 0) return;
      const focus = event.target as HTMLElement | null;
      if (
        focus &&
        (focus.tagName === "INPUT" || focus.tagName === "TEXTAREA" || focus.isContentEditable)
      ) {
        return;
      }
      // 日志的引用树自己绑了 Delete（删的是那条引用，不是盘上的东西）：焦点在它身上时
      // 这一侧要整句让开，否则两个确认框叠着弹，先出来的那个把后一个顶掉。
      if (focus?.closest(".log-refs")) return;
      const key = event.key.toLowerCase();
      // 主修饰键按平台认：macOS 上 Cmd+C/V，其余平台 Ctrl+C/V（对齐 Monaco 的 CtrlCmd 语义）。
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.altKey && (key === "c" || key === "x")) {
        event.preventDefault();
        copyPicked(explorerPick, key === "x");
        return;
      }
      if (mod && !event.altKey && key === "v") {
        event.preventDefault();
        void pasteInto(targetDirOf(explorerPick));
        return;
      }
      if (event.key === "F2") {
        const sole = explorerPick.length === 1 ? explorerPick[0] : null;
        if (sole) {
          event.preventDefault();
          confirmRename(sole);
        }
        return;
      }
      if (event.key === "Delete") {
        event.preventDefault();
        confirmDelete(explorerPick);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    confirmDelete,
    confirmRename,
    copyPicked,
    explorerPick,
    panel,
    pasteInto,
    sidebarOpen,
    targetDirOf,
  ]);

  /** 已关闭的标签页要连 Monaco model 一起丢，否则内容留在内存里。 */
  const dropDocument = useCallback(
    (path: string) => {
      if (docs.dirty(path)) return;
      disposeModel(path);
      docs.close(path);
    },
    [docs]
  );

  /** 批量关闭时，脏文件只弹一次放弃框，剩下的排在队列里等确认后再关。 */
  const closeQueue = useRef<string[]>([]);

  const closeBatch = useCallback(
    (paths: string[]) => {
      const rest = [...paths];
      const done: string[] = [];
      for (;;) {
        const path = rest.shift();
        if (path === undefined) break;
        if (docs.dirty(path)) {
          // 问这一句之前，先把已经确认过的那批一次关掉。
          if (done.length > 0) docs.closeMany(done);
          closeQueue.current = rest;
          setDialog({ kind: "discard", name: basenameOf(path), path, entry: null, dir: null });
          return;
        }
        disposeModel(path);
        done.push(path);
      }
      if (done.length > 0) docs.closeMany(done);
      closeQueue.current = [];
    },
    [docs]
  );

  const submitDialog = useCallback(
    async (name: string, extra: string) => {
      if (!dialog) return;
      const { kind, entry, dir, path, name: currentName, revision, refKind } = dialog;
      setDialog(null);
      try {
        if (kind === "newFolder" && dir) {
          await createFolder(joinPath(dir, name));
          refreshTree();
        }
        if (kind === "newFile" && dir) {
          const created = await createFile(joinPath(dir, name));
          refreshTree();
          void docs.open(created.path);
        }
        if (kind === "newBranch") {
          const done = await git.createBranch(name, dialog.from ?? "", true);
          if (done) remember("recentBranches", name);
        }
        if (kind === "renameBranch") {
          await git.renameBranch(currentName, name);
        }
        if (kind === "newTag") {
          await git.createTag(name, "", dialog.from ?? "");
        }
        if (kind === "checkoutRev") {
          // 这里可能签出标签或任意修订号，记进「最近分支」只会列出一条永远点不动的记录。
          await git.checkout(name);
        }
        if (kind === "worktree") {
          const base = dir ?? workspaceRoot;
          // extra 是可选的新分支名：签的是手上这条分支时，只有先开新分支才落得下去。
          if (base) await git.worktreeAdd(resolvePath(base, name), dialog.from ?? "", extra);
        }
        /* 补丁：from 是左、revision 是右；右端给空串就是拿工作区，提交树那侧走这条。
           path 为空表示整条提交的差异，只有提交行那侧会这么给。 */
        if (kind === "patch" && revision !== undefined && git.root) {
          const text = await gitDiffText(
            git.root,
            dialog.from ?? EMPTY_TREE_HASH,
            revision,
            path ? git.absoluteOf(path) : ""
          );
          // 未跟踪文件相对 HEAD 本来就没有差异，写一份空文件过去会被读成「补丁做好了」。
          if (text.trim() === "") {
            reportError(t("git.patchNoDiff"), t("git.patchSkipped"));
            return;
          }
          await writeFile(resolvePath(dir ?? workspaceRoot ?? git.root, name), text, "lf", false);
        }
        if (kind === "deleteRef") {
          if (refKind === "tag") await git.deleteTag(currentName);
          else if (refKind === "remote") await git.deleteRemoteBranch(currentName);
          else await git.deleteBranch(currentName);
        }
        // 这两句确认框里 name 画的是短哈希给看，真正交给 git 的完整哈希在 revision。
        if (kind === "resetHard" && revision) {
          await git.reset(revision, "hard");
        }
        if (kind === "pushUpTo" && revision && dialog.from) {
          await git.pushUpTo(dialog.from, revision);
        }
        if (kind === "rename" && entry && dir) {
          const target = joinPath(dir, name);
          await renameEntry(entry.path, target);
          dropDocument(entry.path);
          refreshTree();
        }
        if (kind === "delete") {
          // 目录树可以多选一起删，提交树那边只给一条绝对路径；两种都给同一个循环处理。
          const targets =
            dialog.many ?? [entry?.path ?? path].filter((held): held is string => held !== undefined);
          for (const target of targets) {
            await deleteEntry(target);
            dropDocument(target);
          }
          if (targets.length > 0) {
            setExplorerPick([]);
            refreshTree();
          }
        }
        if (kind === "discard" && path) {
          disposeModel(path);
          docs.close(path);
          const queued = closeQueue.current;
          closeQueue.current = [];
          if (queued.length > 0) closeBatch(queued);
        }
        if (kind === "restartUpdate") {
          await relaunchApp();
        }
      } catch (cause) {
        reportError(errorText(cause));
      }
      /**
       * 分档收尾：会动引用与 HEAD 的那几类才重取分支、标签与日志；
       * 只改文件的（新建、改名、删除、补丁）补一次变更清单，磁盘监听那轮是兜底；
       * 「放弃改动」根本没碰仓库，什么都不用问。
       */
      if (
        kind === "newBranch" ||
        kind === "renameBranch" ||
        kind === "newTag" ||
        kind === "checkoutRev" ||
        kind === "deleteRef" ||
        kind === "resetHard" ||
        kind === "pushUpTo" ||
        kind === "worktree"
      ) {
        void git.refresh();
      } else if (kind !== "discard") {
        void git.refreshChanges();
      }
    },
    [closeBatch, dialog, docs, dropDocument, git, refreshTree, remember, reportError, workspaceRoot]
  );

  /**
   * 页签栏上的全部标签：文档、比对、工具窗口、设置，按这个次序排。
   *
   * 这一份必须按身份留住：下面 `tabs` 那一步是「按顺序去目录里找」，两边都进来
   * 就是标签数平方量级的比较，而 App 每渲染一次（打字、轮询、拖动松手）都走一趟。
   * 顺带把 `docs.dirty(path)` 换成直接比这两份文本——那个函数内部就是做一次线性找。
   */
  const tabCatalog: TabItem[] = useMemo(
    () => [
    ...docs.documents.map((doc) => ({
      id: `doc|${doc.path}`,
      kind: "doc" as const,
      name: doc.name,
      title: doc.path,
      dirty: doc.contents !== doc.baseline,
      icon: <EntryIcon name={doc.name} size={13} />,
    })),
    ...diffs.map((tab) => ({
      id: `diff|${tab.id}`,
      kind: "diff" as const,
      name: tab.name,
      title: tab.path,
      dirty: false,
      icon: <FileDiff size={13} className="entry-icon" aria-hidden="true" />,
    })),
    ...BOTTOM_ORDER.filter((key) => places[key] === "tabbed").map((key) => ({
      id: `pane|${key}`,
      kind: "pane" as const,
      name: t(BOTTOM_LABEL[key]),
      title: t(BOTTOM_LABEL[key]),
      dirty: false,
      icon: PANE_ICON[key],
    })),
    ...(settingsTab
      ? [
          {
            id: "settings",
            kind: "settings" as const,
            name: t("settings.title"),
            title: t("settings.title"),
            dirty: false,
            icon: <Settings size={13} className="entry-icon" aria-hidden="true" />,
          },
        ]
      : []),
    ...(runConfigsTab
      ? [
          {
            id: "run-configs",
            kind: "settings" as const,
            name: t("run.editConfigs"),
            title: t("run.editConfigs"),
            dirty: false,
            icon: <Play size={13} className="entry-icon" aria-hidden="true" />,
          },
        ]
      : []),
    ],
    [diffs, docs.documents, places, runConfigsTab, settingsTab, t]
  );

  // 栏上有哪些标签由上面那份目录说，排在哪儿由 tabOrder 说：新开一颗落在当前这颗右边，拖动改这个数组。
  const catalogKey = useMemo(() => tabCatalog.map((tab) => tab.id).join("\n"), [tabCatalog]);
  /** 上一次活跃的那颗；新开的标签插到它右边，而不是统统追加到末尾。 */
  const prevActiveTab = useRef<string | null>(null);
  useEffect(() => {
    const ids = catalogKey ? catalogKey.split("\n") : [];
    setTabOrder((current) => {
      const kept = current.filter((id) => ids.includes(id));
      const added = ids.filter((id) => !kept.includes(id));
      if (kept.length === current.length && added.length === 0) return current;
      const at = kept.indexOf(prevActiveTab.current ?? "");
      const next = [...kept];
      added.forEach((id, offset) => next.splice((at < 0 ? next.length : at + 1) + offset, 0, id));
      return next;
    });
    prevActiveTab.current = activeTab;
  }, [catalogKey, activeTab]);

  // 按 tabOrder 去目录里取：先建一张 id → 标签的表，免得十几颗标签排一遍要 compares 次查找。
  const tabs: TabItem[] = useMemo(() => {
    const byId = new Map(tabCatalog.map((tab) => [tab.id, tab]));
    return tabOrder
      .map((id) => byId.get(id))
      .filter((tab): tab is TabItem => tab !== undefined);
  }, [tabCatalog, tabOrder]);

  /** 拖完一颗：落到目标那颗原来的位子上。 */
  const reorderTab = useCallback((from: string, to: string) => {
    if (from === to) return;
    setTabOrder((current) => {
      const next = current.filter((id) => id !== from);
      const at = next.indexOf(to);
      next.splice(at < 0 ? next.length : at, 0, from);
      return next;
    });
  }, []);

  // 选中的那个被关掉了就落到剩下的最后一个；全关完回到空白页。
  // 存在性要问目录而不是排好序的那份：新开的标签这一帧还没进 tabOrder，
  // 拿 tabs 判会把它当成「已被关掉」，焦点立刻跳回旧标签。
  useEffect(() => {
    if (!activeTab) return;
    if (tabCatalog.some((tab) => tab.id === activeTab)) return;
    setActiveTab(tabs[tabs.length - 1]?.id ?? null);
  }, [activeTab, tabCatalog, tabs]);

  const selectTab = useCallback(
    (id: string) => {
      setActiveTab(id);
      if (id.startsWith("doc|")) docs.setActivePath(id.slice(4));
    },
    [docs]
  );

  /** 关一颗标签：文档先问没保存的改动，面板那颗只是最小化，比对和整页那两类直接收。 */
  const closeTab = useCallback(
    (id: string, kind: TabKind) => {
      if (kind === "doc") closeDocTab(id.slice(4));
      else if (kind === "diff") closeDiff(id.slice(5));
      else if (kind === "pane") hidePane(id.slice(5) as BottomPane);
      else if (id === "run-configs") setRunConfigsTab(false);
      else setSettingsTab(false);
    },
    [closeDiff, closeDocTab, hidePane]
  );

  /** 批量关闭：脏文档一次只问一遍，靠的就是 closeBatch 那条队列。 */
  const dropTabs = useCallback(
    (list: TabItem[]) => {
      for (const tab of list) {
        if (tab.kind === "pane") hidePane(tab.id.slice(5) as BottomPane);
        else if (tab.kind === "settings") {
          if (tab.id === "run-configs") setRunConfigsTab(false);
          else setSettingsTab(false);
        } else if (tab.kind === "diff") closeDiff(tab.id.slice(5));
      }
      closeBatch(list.filter((tab) => tab.kind === "doc").map((tab) => tab.id.slice(4)));
    },
    [closeBatch, closeDiff, hidePane]
  );

  const closeOtherTabs = useCallback(
    (id: string) => dropTabs(tabs.filter((tab) => tab.id !== id)),
    [dropTabs, tabs]
  );

  const closeAllTabs = useCallback(() => dropTabs(tabs), [dropTabs, tabs]);

  /** 设置从页签栏进：已经开着就跳到它，否则新开一页。 */
  const openSettingsTab = useCallback(() => {
    setSettingsTab(true);
    setActiveTab("settings");
  }, []);

  /** 编辑程序配置也从页签栏进：开着就跳过去，没开就新添一页。 */
  const openRunConfigsTab = useCallback(() => {
    setRunConfigsTab(true);
    setActiveTab("run-configs");
  }, []);

  const paneBody = (key: BottomPane) =>
    key === "terminal" ? (
      <TerminalPane ref={terminalApi} cwd={workspaceRoot} dark={resolved === "dark"} />
    ) : key === "run" ? (
      <RunPane run={run} dark={resolved === "dark"} />
    ) : key === "find" ? (
      <FindPane
        query={find.query}
        options={find.options}
        page={find.page}
        running={false}
        error={null}
        onOpen={revealHit}
      />
    ) : key === "notifications" ? (
      <NotificationsView
        notifications={notifications}
        onRemoveItem={removeNotification}
      />
    ) : (
      <GitLogPane
        git={git}
        reportError={reportError}
        onFileAction={fileAction}
        onCompareWork={compareWork}
        onEditSource={editSource}
        onRefAction={refAction}
        onCommitAction={(action, commit) => void commitAction(action, commit)}
        onCompareCommits={(left, right) => void compareCommits(left, right)}
        options={settings.branches}
        onOptions={(next) => patch({ branches: next })}
        repoName={basenameOf(git.root ?? workspaceRoot ?? "")}
        reference={logReference}
        setReference={setLogReference}
        compareRef={logCompareRef}
        setCompareRef={setLogCompareRef}
        pathFilter={logPath}
        setPathFilter={setLogPath}
      />
    );

  /**
   * 一块工具窗口的完整外壳：自己的头部 + 内容。
   * 待在底部和待在页签栏里用的是同一套，所以切过去切回来看到的动作是一样的。
   */
  const paneFrame = (key: BottomPane, docked: boolean) => (
    <section
      className={docked ? "bottom-panel" : "pane-body"}
      // 只有停在底部的那块归分割条管，挪进页签栏的那块没有可调的边。
      ref={docked ? bottomPanelRef : null}
      style={docked ? { height: bottomHeight } : undefined}
    >
      <header className="tool-window-head">
        <span className="tool-window-title">{t(BOTTOM_LABEL[key])}</span>
        {/* 运行面板照 IDEA：会话页签跟在标题同一行，动作另起第二行。 */}
        {key === "run" ? <RunSessionTabs run={run} /> : null}
        {/* 终端同理：页签 + `+` + `⌄` 都在标题行里。 */}
        {key === "terminal" ? <TerminalTabs cwd={workspaceRoot} /> : null}
        {key === "notifications" ? (
          <>
            <button
              type="button"
              className="icon-button is-inline"
              onClick={markAllNotificationsRead}
              disabled={notifications.length === 0}
              title={t("notifications.markAllRead")}
            >
              <CheckCheck size={14} />
            </button>
            <button
              type="button"
              className="icon-button is-inline"
              onClick={clearAllNotifications}
              disabled={notifications.length === 0}
              title={t("notifications.clearAll")}
            >
              <Eraser size={14} />
            </button>
          </>
        ) : null}
        <span className="status-spacer" />
        {key === "run" ? <span className="run-status">{run.notice}</span> : null}
        {/* 底部一次只见一块，切到选项卡才谈得上几块并存；反过来就是切回底部。 */}
        <button
          type="button"
          className="icon-button is-inline"
          onClick={() => (docked ? tabPane(key) : dockPane(key))}
          title={t(docked ? "tool.showAsTab" : "tool.showDocked")}
        >
          {docked ? <Maximize2 size={15} /> : <PanelBottom size={15} />}
        </button>
        <button
          type="button"
          className="icon-button is-inline"
          onClick={() => hidePane(key)}
          title={t("tool.minimize")}
        >
          <Minus size={15} />
        </button>
      </header>
      {/* 运行面板的第二行：重跑 / 停止 / 清空 / 更多，和 IDEA 的 Run 工具窗口同构。 */}
      {key === "run" ? <RunPaneToolbar run={run} /> : null}
      <div className="bottom-body">
        <ErrorBoundary label={t(BOTTOM_LABEL[key])} onError={reportError}>
          <Suspense fallback={null}>{paneBody(key)}</Suspense>
        </ErrorBoundary>
      </div>
    </section>
  );

  /** 切分支成功才记进「最近」，失败的签出不该留在列表里。 */
  const checkoutBranch = useCallback(
    (name: string) =>
      git.checkout(name).then((done) => {
        if (done) remember("recentBranches", name);
        return done;
      }),
    [git, remember]
  );

  /** 引用树右键菜单的落点：菜单只管文案，具体命令都在这层。 */
  const refAction = useCallback(
    (action: RefAction, target: RefTarget) => {
      // 签出远端分支要传去掉远端名的短名：git 的 DWIM 只认短名，
      // 传 `origin/x` 会直接游离到那个提交上，而不是建/切本地同名分支。
      const branchName =
        target.kind === "remote" ? target.name.slice(target.name.indexOf("/") + 1) : target.name;
      switch (action) {
        case "checkout":
          void checkoutBranch(branchName);
          break;
        case "checkoutUpdate":
          void checkoutBranch(branchName).then((done) => {
            if (done) void git.pull();
          });
          break;
        case "checkoutRebase": {
          // 菜单那边已按游离置灰，这里再兜一道：游离时 `branch` 是 "HEAD"，
          // 第二步会把刚签出的分支变基到那个字面量上。
          if (git.status?.detached) return;
          // IDEA 那项是「切到这条，再把它变基到刚才那条上」，两步都要成才走第二步。
          const onto = git.status?.branch ?? "";
          void checkoutBranch(branchName).then((done) => {
            if (done && onto) void git.rebase(onto);
          });
          break;
        }
        case "newBranch":
          setDialog({ kind: "newBranch", name: "", from: target.name, dir: null, entry: null });
          break;
        case "worktree": {
          // 默认落在仓库旁边：往仓库里塞一份工作树，git 自己会当成未跟踪内容。
          const base = parentPath(git.root ?? workspaceRoot ?? "");
          setDialog({
            kind: "worktree",
            name: "",
            from: target.name,
            dir: base,
            hint: base ?? undefined,
            entry: null,
          });
          break;
        }
        case "rename":
          setDialog({ kind: "renameBranch", name: target.name, dir: null, entry: null });
          break;
        case "merge":
          void git.merge(target.name);
          break;
        case "rebase":
          // 变基的对象是「当前分支」，游离 HEAD 时没有这条分支。
          if (!git.status?.detached) void git.rebase(target.name);
          break;
        case "update":
          // 当前分支直接 pull；非当前分支先检出再 pull，避免误更新当前分支
          if (target.kind === "local" && git.status?.branch === target.name) {
            void git.pull();
          } else {
            void checkoutBranch(target.name).then((ok) => {
              if (ok) void git.pull();
            });
          }
          break;
        case "push":
          void git.pushRef(target.name);
          break;
        case "delete":
          // 删远端分支是往服务器推一条删除引用，先问一句再动手。
          setDialog({
            kind: "deleteRef",
            name: target.name,
            refKind: target.kind,
            dir: null,
            entry: null,
          });
          break;
      }
    },
    [checkoutBranch, git, workspaceRoot]
  );

  /** 中列提交行右键那几条的落点：起名字的走弹窗，会动仓库的直接办。 */
  const commitAction = useCallback(
    async (action: CommitAction, commit: GitCommitInfo) => {
      if (!git.root) return;
      if (action === "checkout") {
        // IDEA 的 Checkout Revision 不二次确认：行上点一下就游离到那条修订上。
        await git.checkout(commit.hash);
        return;
      }
      if (action === "newBranch") {
        setDialog({ kind: "newBranch", name: "", from: commit.hash, dir: null, entry: null });
        return;
      }
      if (action === "newTag") {
        setDialog({ kind: "newTag", name: "", from: commit.hash, dir: null, entry: null });
        return;
      }
      if (action === "cherryPick") {
        await git.cherryPick(commit.hash);
        return;
      }
      if (action === "revert") {
        await git.revert(commit.hash);
        return;
      }
      if (action === "resetSoft" || action === "resetMixed") {
        // 这两档都留着改动，做错了还能接着提交，所以不拦人。
        await git.reset(commit.hash, action === "resetSoft" ? "soft" : "mixed");
        return;
      }
      if (action === "resetHard") {
        // 硬的那档把工作区里没提交的改动一起丢，丢了找不回来，先确认一句。
        setDialog({
          kind: "resetHard",
          name: commit.short,
          revision: commit.hash,
          dir: null,
          entry: null,
        });
        return;
      }
      if (action === "uncommit") {
        /* IDEA 的 Undo Commit 就是「mixed 重置到 HEAD 的父」：HEAD 退一格，改动留在工作区且不暂存。
           这条只在 HEAD 上点得动，所以直接写 HEAD^；根提交没有父，git 自己报错报回去。 */
        await git.reset("HEAD^", "mixed");
        return;
      }
      if (action === "reword") {
        // 改写 HEAD 的说明不用新命令：把提交面板摊开成修正状态，改完按提交即是 amend。
        setPanel("git");
        setSidebarOpen(true);
        setRewordSignal((value) => value + 1);
        return;
      }
      if (action === "pushUpTo") {
        const branch = git.status && !git.status.detached ? git.status.branch : "";
        if (branch === "") return;
        setDialog({
          kind: "pushUpTo",
          name: commit.short,
          from: branch,
          revision: commit.hash,
          dir: null,
          entry: null,
        });
        return;
      }
      try {
        // 整条提交的补丁：左端取它的父，根提交没有父就从空树起。
        const detail = await gitCommitDetail(git.root, commit.hash);
        setDialog({
          kind: "patch",
          name: `${commit.short}.patch`,
          path: "",
          revision: commit.hash,
          from: detail.parents[0] ?? EMPTY_TREE_HASH,
          dir: workspaceRoot,
          hint: workspaceRoot ?? undefined,
          entry: null,
        });
      } catch (cause) {
        reportError(errorText(cause));
      }
    },
    [git, reportError, workspaceRoot]
  );

  /** 日志里「比较版本」：IDEA 开的是那份改动清单，这里直接把两侧的差异文本开成一页。 */
  const compareCommits = useCallback(
    async (left: GitCommitInfo, right: GitCommitInfo) => {
      if (!git.root) return;
      try {
        const text = await gitDiffText(git.root, left.hash, right.hash, "");
        const virtual = `${left.short}..${right.short}.diff`;
        setActiveTab(`doc|${virtual}`);
        docs.openVirtual(virtual, text, "diff");
      } catch (cause) {
        reportError(errorText(cause));
      }
    },
    [docs, git.root, reportError]
  );

  /** 分支弹层里那几条动作，落点都在 App 这一层。 */
  const branchAction = useCallback(
    (action: BranchAction) => {
      switch (action) {
        case "update":
          void git.pull();
          break;
        case "fetch":
          void git.fetch();
          break;
        case "push":
          void git.push(false);
          break;
        case "commit":
          setPanel("git");
          setSidebarOpen(true);
          setCommitFocus((value) => value + 1);
          break;
        case "newBranch":
          setDialog({ kind: "newBranch", name: "", dir: null, entry: null });
          break;
        case "newTag":
          setDialog({ kind: "newTag", name: "", dir: null, entry: null });
          break;
        case "checkoutRev":
          setDialog({ kind: "checkoutRev", name: "", dir: null, entry: null });
          break;
        case "initRepo":
          void git.init();
          break;
      }
    },
    [git]
  );

  return (
    <div className="app-shell">
      <TitleBar
        sidebarOpen={sidebarOpen}
        sidebarWidth={sidebarWidth}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        project={
          <ProjectPicker
            root={workspaceRoot}
            recent={history.recentFolders}
            onOpenFolder={() => void openFolder()}
            onPick={(path) => {
              void dropTermSession();
              disposeAllModels();
              docs.closeAll();
              setDiffs([]);
              setExplorerPick([]);
              setClipboard(null);
              // 与 openFolder 同一套清理：旧工程的比对链与查找结果不能带过去。
              diffChains.current.clear();
              setFind({
                query: "",
                options: { caseSensitive: false, wholeWords: false, regex: false, fileMask: "", limit: 0 },
                page: null,
              });
              setWorkspaceRoot(path);
              remember("recentFolders", path);
              setPanel("explorer");
              setSidebarOpen(true);
            }}
            onCloseProject={closeFolder}
          />
        }
        branch={
          <BranchPicker
            git={git}
            folder={workspaceRoot}
            recent={history.recentBranches}
            options={settings.branches}
            onOptions={(next) => patch({ branches: next })}
            onCheckout={checkoutBranch}
            onAction={branchAction}
            onRefAction={refAction}
            onRefInspect={(target, mode) => {
              /* IDEA 这两项都是把日志叫出来并落好筛选条件。 */
              const current = git.status?.branch ?? "";
              if (mode === "compare") setLogReference(`${current}..${target.name}`);
              else setLogCompareRef(target.name);
              if (places.log === "hidden") dockPane("log");
              else if (places.log === "tabbed") setActiveTab("pane|log");
            }}
          />
        }
        conflict={<ConflictWidget git={git} />}
        run={
          <RunControls
            configs={configs}
            run={run}
            enabled={workspaceRoot !== null}
            chooserSignal={runChooser}
            onStarted={() => focusPane("run")}
            onEditConfigs={openRunConfigsTab}
          />
        }
        search={
          <button
            type="button"
            className={`icon-button is-toolbar${everywhere ? " is-on" : ""}`}
            aria-pressed={everywhere !== null}
            disabled={workspaceRoot === null}
            onClick={() => (everywhere ? setEverywhere(null) : openEverywhere("all", selectedText()))}
            title={workspaceRoot === null ? t("git.noWorkspace") : t("search.title")}
          >
            <SearchIcon size={17} />
          </button>
        }
        settings={
          <button
            type="button"
            className={`icon-button is-toolbar${settingsTab ? " is-on" : ""}`}
            aria-pressed={settingsTab}
            onClick={openSettingsTab}
            title={t("settings.title")}
          >
            <Settings size={17} />
          </button>
        }
      />

      <div className="app-body">
        <aside className="side-panel">
          <nav className="activity-rail" aria-label={t("panel.explorer")}>
            {(["explorer", "git"] as Panel[]).map((key) => {
              const active = panel === key && sidebarOpen;
              return (
                <button
                  key={key}
                  type="button"
                  className={`rail-button${active ? " is-active" : ""}`}
                  aria-pressed={active}
                  aria-label={t(RAIL_LABEL[key])}
                  data-tip={t(RAIL_LABEL[key])}
                  onClick={() => {
                    if (panel === key) {
                      setSidebarOpen((open) => !open);
                      // 已经在这一栏、只是被收起来了：展开时也刷一次，等于「看它一眼就取最新」。
                      if (!sidebarOpen && key === "git") void git.refresh();
                    } else {
                      setPanel(key);
                      setSidebarOpen(true);
                      // 切到提交面板就顺手取一次：工作区在别处（终端、外部工具）改过时，
                      // 光切过来看到的是上一次的快照，得让人主动按刷新才对得上。
                      if (key === "git") void git.refresh();
                    }
                  }}
                >
                  {key === "explorer" ? <ProjectIcon size={18} /> : <CommitIcon size={18} />}
                  {key === "git" && changeCount > 0 ? (
                    <span className="rail-badge">{changeCount}</span>
                  ) : null}
                </button>
              );
            })}
            {/* IDEA 把底部工具窗口的入口放在活动栏下端，和上面的项目/提交分开。 */}
            <span className="rail-spacer" />
            {RAIL_BOTTOM.map((key) => {
              // 收着的那颗不亮；不管是待在底部还是待在页签栏里，都算开着。
              const open = places[key] !== "hidden";
              return (
                <button
                  key={key}
                  type="button"
                  className={`rail-button${open ? " is-active" : ""}`}
                  aria-pressed={open}
                  aria-label={t(BOTTOM_LABEL[key])}
                  data-tip={t(BOTTOM_LABEL[key])}
                  onClick={() => railPane(key)}
                >
                  {key === "terminal" ? (
                    <SquareTerminal size={18} />
                  ) : key === "run" ? (
                    <Play size={17} />
                  ) : key === "find" ? (
                    <SearchIcon size={18} />
                  ) : key === "notifications" ? (
                    <Bell size={18} />
                  ) : (
                    <VcsIcon size={18} />
                  )}
                </button>
              );
            })}
          </nav>

          {sidebarOpen ? (
            <section
              className="tool-window"
              ref={sidePanelRef}
              style={{ width: sidebarWidth }}
            >
              <header className="tool-window-head">
                <span className="tool-window-title" title={workspaceRoot ?? undefined}>
                  {panel === "explorer"
                    ? workspaceRoot
                      ? basenameOf(workspaceRoot).toUpperCase()
                      : t("panel.explorer")
                    : t("panel.commit")}
                </span>
                <span className="status-spacer" />
                {panel === "explorer" && workspaceRoot ? (
                  <>
                    <button
                      type="button"
                      className="icon-button is-inline is-hover"
                      onClick={() => setDialog({ kind: "newFile", name: "untitled.txt", dir: workspaceRoot, entry: null })}
                      title={t("action.newFile")}
                    >
                      <FilePlus size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-button is-inline is-hover"
                      onClick={() =>
                        setDialog({
                          kind: "newFolder",
                          name: t("dialog.newFolderDefault"),
                          dir: workspaceRoot,
                          entry: null,
                        })
                      }
                      title={t("action.newFolder")}
                    >
                      <FolderPlus size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-button is-inline is-hover"
                      onClick={() => setCollapseSignal((signal) => signal + 1)}
                      title={t("tool.collapseAll")}
                    >
                      <ListTree size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-button is-inline is-hover"
                      onClick={() => {
                        refreshTree();
                        void git.refresh();
                      }}
                      title={t("tool.refresh")}
                    >
                      <RefreshCw size={15} />
                    </button>
                    {/* 视图选项（忽略文件 / 隐藏文件）写在设置页里，这里只是去那儿的近路。 */}
                    <button
                      type="button"
                      className="icon-button is-inline is-hover"
                      onClick={openSettingsTab}
                      title={t("explorer.viewOptions")}
                    >
                      <Eye size={15} />
                    </button>
                  </>
                ) : null}
                {panel === "git" && git.root ? (
                  <>
                    {/* IDEA 的 CommitView.GearActions 挂在工具窗口头部那颗齿轮上。 */}
                    <Popover
                      anchor={commitGearAnchor}
                      onClose={() => setCommitGearAnchor(null)}
                      minWidth={230}
                    >
                      <p className="popover-label">{t("git.showOnDoubleClick")}</p>
                      {(["preview", "source"] as const).map((target) => (
                        <button
                          key={target}
                          type="button"
                          className="popover-item"
                          onClick={() =>
                            patch({ commit: { ...settings.commit, showOnDoubleClick: target } })
                          }
                        >
                          {settings.commit.showOnDoubleClick === target ? (
                            <Check size={13} aria-hidden="true" />
                          ) : (
                            <span className="menu-icon-spacer" />
                          )}
                          <span className="popover-item-label">
                            {t(target === "preview" ? "git.doubleClickDiff" : "git.doubleClickSource")}
                          </span>
                        </button>
                      ))}
                      <div className="popover-sep" />
                      <button
                        type="button"
                        className="popover-item"
                        onClick={() =>
                          patch({
                            commit: {
                              ...settings.commit,
                              commitAllWhenNothingStaged: !settings.commit.commitAllWhenNothingStaged,
                            },
                          })
                        }
                      >
                        {settings.commit.commitAllWhenNothingStaged ? (
                          <Check size={13} aria-hidden="true" />
                        ) : (
                          <span className="menu-icon-spacer" />
                        )}
                        <span className="popover-item-label">
                          {t("git.commitAllWhenNothingStaged")}
                        </span>
                      </button>
                    </Popover>
                    <button
                      type="button"
                      ref={commitGearRef}
                      className={`icon-button is-inline${commitGearAnchor ? " is-on" : ""}`}
                      onClick={() => setCommitGearAnchor((current) => (current ? null : commitGearRef.current))}
                      aria-expanded={commitGearAnchor !== null}
                      aria-haspopup="menu"
                      title={t("git.commitOptions")}
                    >
                      <Settings size={15} />
                    </button>
                  </>
                ) : null}
                {/* 收起那颗不跟着隐藏：指针没进头部时也得找得到出口。 */}
                <button
                  type="button"
                  className="icon-button is-inline"
                  onClick={() => setSidebarOpen(false)}
                  title={t("tool.closePanel")}
                >
                  <PanelLeftClose size={15} />
                </button>
              </header>

              <div className="panel-body">
                <ErrorBoundary label={t(RAIL_LABEL[panel])} onError={reportError}>
                {panel === "explorer" ? (
                  workspaceRoot ? (
                    <ExplorerTree
                      root={workspaceRoot}
                      activePath={docs.activePath}
                      repoRoot={git.root}
                      changes={git.status?.changes ?? []}
                      collapseSignal={collapseSignal}
                      refresh={treeRefresh}
                      reveal={treeReveal}
                      showIgnored={settings.explorer.showIgnored}
                      showHidden={settings.explorer.showHidden}
                      picked={explorerPick.map((entry) => entry.path)}
                      onPick={setExplorerPick}
                      onOpenFile={openFile}
                      onContextMenu={requestMenu}
                    />
                  ) : (
                    <div className="tool-window-empty">
                      <p>{t("explorer.noFolder")}</p>
                    </div>
                  )
                ) : workspaceRoot ? (
                  <Suspense fallback={null}>
                    <GitPanel
                      git={git}
                      workspaceRoot={workspaceRoot}
                      onOpenChange={openChange}
                      onOpenFile={(path) => {
                        setActiveTab(`doc|${path}`);
                        void docs.open(path);
                      }}
                      focusSignal={commitFocus}
                      rewordSignal={rewordSignal}
                      history={history.commitMessages}
                      onCommitted={(message) => remember("commitMessages", message)}
                      groupByDir={commitView.byDir}
                      groupByModule={commitView.byModule}
                      showIgnored={commitView.ignored}
                      onToggleIgnored={() =>
                        setCommitView((current) => ({ ...current, ignored: !current.ignored }))
                      }
                      repoName={basenameOf(git.root ?? workspaceRoot)}
                      onFileAction={commitFileAction}
                      onUnignore={(relative) => void removeFromGitignore(relative)}
                      onOpenCommitFile={(revision, file) => {
                        if (!git.root) return;
                        void gitCommitDetail(git.root, revision)
                          .then((detail) => openCommitFile(detail, file, false))
                          .catch((cause: unknown) => reportError(errorText(cause)));
                      }}
                      onToggleByDir={() => setCommitView((c) => ({ ...c, byDir: !c.byDir }))}
                      onToggleByModule={() =>
                        setCommitView((c) => ({ ...c, byModule: !c.byModule }))
                      }
                      showOnDoubleClick={settings.commit.showOnDoubleClick}
                      commitAllWhenNothingStaged={settings.commit.commitAllWhenNothingStaged}
                      onOpenSource={(change) => {
                        const absolute = git.absoluteOf(change.path);
                        setActiveTab(`doc|${absolute}`);
                        void docs.open(absolute);
                      }}
                      onOpenResolve={() => setResolveOpen(true)}
                    />
                  </Suspense>
                ) : (
                  <p className="tool-window-empty">{t("git.noWorkspace")}</p>
                )}
                </ErrorBoundary>
              </div>

            </section>
          ) : null}
          {sidebarOpen ? (
            <div
              role="separator"
              aria-orientation="vertical"
              className="panel-splitter is-vertical"
              onPointerDown={(event) => {
                sideDrag.current = {
                  startX: event.clientX,
                  startWidth: sidebarWidth,
                  live: sidebarWidth,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = sideDrag.current;
                if (!drag) return;
                const grown = drag.startWidth + event.clientX - drag.startX;
                drag.live = Math.max(180, Math.min(window.innerWidth - 560, grown));
                if (sidePanelRef.current) sidePanelRef.current.style.width = `${drag.live}px`;
              }}
              onPointerUp={() => {
                const drag = sideDrag.current;
                sideDrag.current = null;
                if (drag) setSidebarWidth(drag.live);
              }}
            />
          ) : null}
        </aside>

        {/* 底部工具窗口只跟着编辑区，不把左边的活动栏和工具窗口截断。 */}
        <div className="main-column">
          <main className="editor-region">
            {tabs.length > 0 ? (
              <EditorTabs
                tabs={tabs}
                activeId={activeTab}
                onSelect={selectTab}
                onReorder={reorderTab}
                onClose={closeTab}
                onCloseOthers={closeOtherTabs}
                onCloseAll={closeAllTabs}
                onSave={(path) => void docs.save(path)}
                isDirty={docs.dirty}
              />
            ) : null}
            {/* 正文区这四块（比对 / 面板 / 设置 / 文档）都在按需取的 chunk 里。
                边界只包正文、不包上面的标签栏：文档渲染崩了标签还在，关掉这一篇就能自愈。 */}
            <ErrorBoundary label={t("editor.region")} onError={reportError}>
            <Suspense fallback={null}>
              {activeDiffTab ? (
                <DiffPane
                  leftLabel={activeDiffTab.leftLabel}
                  rightLabel={activeDiffTab.rightLabel}
                  path={activeDiffTab.path}
                  original={activeDiffTab.original}
                  modified={activeDiffTab.modified}
                  language={activeDiffTab.language}
                  notice={
                    activeDiffTab.notice ? describeError(activeDiffTab.notice, t) : undefined
                  }
                  group={diffGroupOf(activeDiffTab)}
                  landOn={activeDiffTab.landOn}
                  onOpenFile={diffOpenFile}
                  onClose={() => closeDiff(activeDiffTab.id)}
                />
              ) : activePane && places[activePane] === "tabbed" ? (
                paneFrame(activePane, false)
              ) : activeTab === "run-configs" ? (
                <RunConfigsPage configs={configs} />
              ) : activeTab === "settings" ? (
                <SettingsPage
                  workspace={workspaceRoot}
                  onLspKick={() => setLspKick((value) => value + 1)}
                  onLspWake={wakeLspServer}
                />
              ) : activeDoc ? (
                <DocPane
                  document={activeDoc}
                  onChange={docs.update}
                  onSave={() => void saveActive()}
                  onView={docs.setView}
                  onOpenLocal={openLocalFile}
                  reveal={docs.reveal}
                  onRevealDone={docs.revealDone}
                  runConfigs={configs.configs}
                  projectRoot={workspaceRoot ?? ""}
                  onRunConfig={(picked) => {
                    if (picked.length > 1) {
                      // 这一行落进好几条：选中位次最靠前的那条，再把下拉打开让他改。
                      configs.select(picked[0].id);
                      setRunChooser((signal) => signal + 1);
                      return;
                    }
                    run.start(picked[0]);
                    focusPane("run");
                  }}
                  onRunScript={runScript}
                />
              ) : (
                <WelcomeScreen
                  keymap={settings.editor.keymap}
                  workspace={workspaceRoot !== null}
                />
              )}
            </Suspense>
            </ErrorBoundary>
          </main>

          {/* 底部一次只见一块工具窗口；要同时看几块就切到选项卡那边。 */}
          {dockedPane ? (
            <>
              <div
                role="separator"
                aria-orientation="horizontal"
                className="panel-splitter"
                onPointerDown={(event) => {
                  splitDrag.current = {
                    startY: event.clientY,
                    startHeight: bottomHeight,
                    live: bottomHeight,
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const drag = splitDrag.current;
                  if (!drag) return;
                  const grown = drag.startHeight + drag.startY - event.clientY;
                  drag.live = Math.max(120, Math.min(window.innerHeight - 240, grown));
                  if (bottomPanelRef.current) bottomPanelRef.current.style.height = `${drag.live}px`;
                }}
                onPointerUp={() => {
                  const drag = splitDrag.current;
                  splitDrag.current = null;
                  if (drag) setBottomHeight(drag.live);
                }}
              />
              {paneFrame(dockedPane, true)}
            </>
          ) : null}
        </div>
      </div>

      <footer className="global-status">
        {(git.status?.changes.length ?? 0) > 0 ? (
          /* IDEA 左端那条是可点的检查消息，这里对应到「还有改动没提交」。 */
          <button
            type="button"
            className="status-note"
            onClick={() => {
              setPanel("git");
              setSidebarOpen(true);
              setCommitFocus((value) => value + 1);
            }}
            title={t("status.openCommit")}
          >
            <GitCommit size={12} aria-hidden="true" />
            {t("status.changes", { count: git.status?.changes.length ?? 0 })}
          </button>
        ) : null}
        <span className="status-spacer" />
        {activeDoc ? (
          <>
            <span>{languageLabel(activeDoc.language)}</span>
            {/* 图片没有行尾这回事，那一格换成它的类型名。 */}
            {activeDoc.kind === "image" ? (
              <span>{t("preview.image")}</span>
            ) : (
              <span>{activeDoc.lineEnding.toUpperCase()}</span>
            )}
            {docs.dirty(activeDoc.path) ? (
              <span className="status-dirty">{t("editor.dirty")}</span>
            ) : null}
            {activeDoc.readOnly ? <span>{t("editor.readOnly")}</span> : null}
          </>
        ) : null}
        <LspStatusBar
          workspace={workspaceRoot}
          onKicked={() => setLspKick((value) => value + 1)}
          onOpenSettings={openSettingsTab}
          onError={reportError}
        />
        <UpdateStatusBar
          onOpenSettings={openSettingsTab}
          onRequestRestart={(version) =>
            setDialog({ kind: "restartUpdate", name: version, dir: null, entry: null })
          }
        />
        <MemoryGauge />
        <NotificationBell
          notifications={notifications}
          active={dockedPane === "notifications" || activePane === "notifications"}
          onClick={() => {
            if (dockedPane !== "notifications" && activePane !== "notifications") {
              markAllNotificationsRead();
            }
            railPane("notifications");
          }}
        />
      </footer>

      {/* IDEA 浮动通知气泡 (位置跟随 settings.notificationPosition，默认右下角) */}
      <NotificationToasts
        toasts={activeToasts}
        position={settings.notificationPosition}
        onDismiss={dismissToast}
      />

      {everywhere && workspaceRoot ? (
        <Suspense fallback={null}>
          <SearchEverywhere
            key={searchSeq.current}
            root={everywhere.scope ?? workspaceRoot}
            repoRoot={git.root}
            showHidden={settings.explorer.showHidden}
            showIgnored={settings.explorer.showIgnored}
            initialTab={everywhere.tab}
            initialQuery={everywhere.query}
            onClose={() => setEverywhere(null)}
            onOpenFile={openSearchFile}
            onOpenHit={openSearchHit}
          />
        </Suspense>
      ) : null}
      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
      {dialog ? (
        <PromptDialog
          request={dialog}
          onSubmit={(name, extra) => void submitDialog(name, extra)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {updatePrompt ? (
        <PromptDialog
          request={{ kind: "installUpdate", name: updatePrompt }}
          onSubmit={() => {
            setUpdatePrompt(null);
            updatePromptResolve.current?.(true);
            updatePromptResolve.current = null;
          }}
          onCancel={() => {
            setUpdatePrompt(null);
            updatePromptResolve.current?.(false);
            updatePromptResolve.current = null;
          }}
        />
      ) : null}
      {resolveOpen ? (
        <ResolveConflictsDialog
          files={git.conflictChanges}
          onAccept={(change, side) => void git.resolveConflict(git.absoluteOf(change.path), side)}
          onOpen={(change) => editSource(change.path)}
          onClose={() => setResolveOpen(false)}
        />
      ) : null}
    </div>
  );
}
