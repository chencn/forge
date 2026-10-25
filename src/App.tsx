import { useCallback, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  Bell,
  Check,
  CheckCheck,
  Eraser,
  FilePlus,
  FolderPlus,
  FileDiff,
  GitCommit,
  ListTree,
  LocateFixed,
  Maximize2,
  Sparkles,
  Minus,
  PanelBottom,
  PanelLeftClose,
  PanelRight,
  Play,
  RefreshCw,
  Save,
  Settings,
  SquarePen,
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
import type { FolderStatusItem } from "./components/ProjectPicker";
import BranchPicker from "./components/BranchPicker";
import type { BranchAction } from "./components/BranchPicker";
import ConflictWidget from "./components/ConflictWidget";
import Popover from "./components/Popover";
import WelcomeScreen from "./components/WelcomeScreen";
import type { SettingsModule } from "./components/SettingsPage";
import MemoryGauge from "./components/MemoryGauge";
import {
  NotificationBell,
  NotificationsView,
  NotificationToasts,
} from "./components/NotificationCenter";
import DepSyncToast from "./components/DepSyncToast";
import { isManifestDeclarationFile } from "./lib/depSync";
import { planWorkspaceFlush, type WorkspaceFlush } from "./lib/watchBatch";
import { loadNotifications, saveNotifications } from "./lib/notifications";
import type { AppNotification } from "./lib/notifications";
import { belongsToRoot, useDocuments } from "./hooks/useDocuments";
import { useDepSync } from "./hooks/useDepSync";
import { useFileWatch } from "./hooks/useFileWatch";
import { useGitState } from "./hooks/useGitState";
import { useLspConfig } from "./hooks/useLspConfig";
import { useRunConfigs } from "./hooks/useRunConfigs";
import { useRunSessions } from "./hooks/useRunSessions";
import { useHistory } from "./hooks/useHistory";
import { useSettings } from "./hooks/useSettings";
import { useStable } from "./hooks/useStable";
import type { BranchSettings } from "./lib/settings";
import { installReadyUpdate, relaunchApp, runAutoUpdateFlow } from "./lib/updater";
import UpdateStatusBar from "./components/UpdateStatusBar";
import { MavenDock, MavenStatus, RightDockSplitter } from "./components/MavenTool";
import { closeMaven } from "./hooks/useMavenProject";
import StatusBreadcrumb from "./components/StatusBreadcrumb";
import { shouldCopyDomSelection } from "./lib/copySelection";
import { DoubleShiftDetector } from "./lib/doubleShift";
import {
  disposeModel,
  languageForPath,
  languageLabel,
  selectedText,
  setKeymapScheme,
  setOpenTargetHandler,
} from "./lib/monacoEnv";
import {
  EMPTY_TREE_HASH,
  gitCommitDetail,
  gitCommitFile,
  gitDiffText,
  gitIgnoreRule,
  gitIndexShow,
  gitShow,
  rollbackTargets,
} from "./lib/git";
import { forgetIgnoredUnder } from "./lib/ignoredCache";
import { lineChangeBaseline } from "./lib/lineChanges";
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
  statEntries,
  writeFile,
} from "./lib/fs";
import { dropHintKey, splitDrop } from "./lib/dropIn";
import { dispatchDrop, dropPosition } from "./lib/dropOwner";
import { codedError, describeError } from "./lib/errors";
import { invalidateJavaIcons } from "./lib/javaKindIcons";
import { IS_WINDOWS, MOD_LABEL } from "./lib/sys";
import { applyShellIntegration, takeShellOpen } from "./lib/shellOpen";
import { canDiff, docKindOf, hasTextContent } from "./lib/docKind";
import {
  closeTermsForRoot,
  hasAliveTermsForRoot,
  runInTerminal,
  termSessions,
  watchTermTabs,
} from "./lib/termStore";
import { shellProbe } from "./lib/term";
import type { ShellInfo } from "./lib/term";
import {
  buildScriptCommand,
  findShellForScript,
  scriptKindOf,
  scriptTerminalLabel,
} from "./lib/scriptRun";
import {
  executeHttpRequest,
  formatHttpExchange,
  httpRequestLabel,
  httpResponsePath,
  parseHttpFile,
} from "./lib/httpFile";
import type { FileContent, FsEntry, SearchOptions, TextHit, TextPage } from "./lib/fs";
import { basenameOf, joinPath, nativeSeparators, parentPath, patchStem, pathWithin, resolvePath, samePath } from "./lib/format";
import { resolveFileLink } from "./lib/fileLinks";
import { appExit, cancelAppExit, onWindowBlur, onWindowFocus, setTrayLabels } from "./lib/window";
import { useI18n } from "./i18n";
import type { TranslationKey } from "./i18n/lang/zh";
import { RunPaneToolbar, RunSessionTabs } from "./components/RunPaneHead";
import TerminalTabs from "./components/TerminalTabs";
import AiSessionsPanel, { AiSessionsToolbar } from "./components/AiSessionsPanel";
import AiProviderIcon from "./components/AiProviderIcon";
import { forgetAiSessionWorkspace, useAiSessions } from "./hooks/useAiSessions";
import { useAiRunLifecycle } from "./hooks/useAiRunLifecycle";
import { ensureAiRuntimeListener, filterAiProjectEvents, getAiProjectActivitySummary, hasAiRuns, hasAiProjectActivity, refreshAiProjectConfig, useAiActiveProjects } from "./lib/aiRuntime";
import type { AiRuntimeEvent } from "./lib/aiRuntime";
import { AI_NAMES } from "./lib/aiCli";
import { seedAiSessionOptions, setAiDraftHandoff } from "./lib/aiDraftSession";
import type { AiProvider } from "./lib/aiCli";
import type { AiSession } from "./lib/aiSessions";
import "./components/aiAssistants.css";

/**
 * 编辑区与工具窗口按「首次用到」才取。
 *
 * 这几块带着 Monaco、xterm、marked 与 DOMPurify：静态引它们就等于把约 4.6MB 放在
 * `createRoot().render()` 之前求值，而首屏要么是空白页要么是目录树，一样都用不到。
 * 类型仍走 `import type`，编译期擦掉，不产生依赖。
 */
const DocPane = lazy(() => import("./components/DocPane"));
const DiffPane = lazy(() => import("./components/DiffPane"));
const MergeConflictDialog = lazy(() => import("./components/MergeConflictDialog"));
const LocalHistoryDialog = lazy(() => import("./components/LocalHistoryDialog"));
const GitPanel = lazy(() => import("./components/GitPanel"));
const GitLogPane = lazy(() => import("./components/GitLogPane"));
const TerminalPane = lazy(() => import("./components/TerminalPane"));
const TerminalHost = lazy(() => import("./components/TerminalHost"));
const RunPane = lazy(() => import("./components/RunPane"));
const RunConfigsPage = lazy(() => import("./components/RunConfigsPage"));
const SearchEverywhere = lazy(() => import("./components/SearchEverywhere"));
const SettingsPage = lazy(() => import("./components/SettingsPage"));
const AiSessionPane = lazy(() => import("./components/AiSessionPane"));
const AiWelcomePane = lazy(() => import("./components/AiWelcomePane"));

/** 对话框除了文案，还要记住它作用在哪个条目上、新建落在哪个目录里。 */
type PendingDialog = DialogRequest & {
  entry: FsEntry | null;
  dir: string | null;
  /** 删除可以一次作用在一批路径上；缺省时只删 `entry` / `path` 那一条。 */
  many?: string[];
  /** 回滚：删完新建文件之后再恢复的已跟踪改动，存交给 git 的 pathspec（`.` 表示仓库根）。 */
  restore?: string;
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

/** 左侧工具窗口：项目、提交与 AI 助手会话。 */
type Panel = "explorer" | "git" | "ai";

/** 底部工具窗口：各自独立开关，底部一次只见一块，切到选项卡才能并存。通知不占底部，停在右侧，并和 Maven 共用这一列。 */
type BottomPane = "terminal" | "run" | "log" | "find" | "notifications";

/** 一块工具窗口待在哪。底部是排他的，选项卡那边可以并存。 */
type Placement = "hidden" | "docked" | "tabbed";

const RAIL_LABEL: Record<Panel, TranslationKey> = {
  explorer: "panel.explorer",
  git: "panel.commit",
  ai: "ai.title",
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

/** 底部查找窗口单次搜索结果状态。 */
interface FindState {
  query: string;
  options: SearchOptions;
  page: TextPage | null;
}

const EMPTY_FIND: FindState = {
  query: "",
  options: { caseSensitive: false, wholeWords: false, regex: false, fileMask: "", limit: 0 },
  page: null,
};
const EMPTY_DIFFS: DiffTab[] = [];
const EMPTY_PICK: FsEntry[] = [];
/** 目录树在没有仓库状态时拿到的那份空清单：必须是同一个数组，否则 memo 白装。 */
const EMPTY_CHANGES: GitChange[] = [];
const EMPTY_TAB_ORDER: string[] = [];
/** 交给语言服务对齐文档的最小间隔：敲字期间不必每一下都重算整份文档表。 */
const LSP_SYNC_GAP_MS = 250;
const DEFAULT_PLACES: Record<BottomPane, Placement> = {
  terminal: "hidden",
  run: "hidden",
  log: "hidden",
  find: "hidden",
  notifications: "hidden",
};
const DEFAULT_LAST_PLACE: Record<BottomPane, "docked" | "tabbed"> = {
  terminal: "docked",
  run: "docked",
  log: "docked",
  find: "docked",
  notifications: "docked",
};

export default function App() {
  const { t } = useI18n();
  const { settings, patch, applied: resolved } = useSettings();
  const { history, patch: patchHistory, remember, forget } = useHistory();
  const { config: lspConfig } = useLspConfig();
  /** 终端会话增删或退出时递增，触发常驻文件夹运行态绿点重算。 */
  const [termRev, setTermRev] = useState(0);
  useEffect(() => watchTermTabs(() => setTermRev((value) => value + 1)), []);
  /** 递增即再对一趟语言服务：状态条里手动重启或停用之后要立刻反映到进程上。 */
  const [lspKick, setLspKick] = useState(0);

  /**
   * 启动时默认只恢复原来激活的单个项目。
   * 运行期间保留多个项目是为了保留正在启动的应用与后台会话；应用重启后后台进程已重置，无需恢复多个。
   */
  const initialActiveRoot =
    history.activeFolder || history.lastFolder || history.openFolders[0] || null;
  const [openFolders, setOpenFolders] = useState<string[]>(() =>
    initialActiveRoot ? [initialActiveRoot] : []
  );
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(() => initialActiveRoot);

  /** 当前项目最近 7 天通知历史（从持久化缓存加载并自动过滤过期记录）。 */
  const [notifications, setNotifications] = useState<AppNotification[]>(() =>
    loadNotifications(initialActiveRoot)
  );
  /** 当前在右下角悬浮展示的气泡列表（最多同时展示 3 条）。 */
  const [activeToasts, setActiveToasts] = useState<AppNotification[]>([]);

  // 按目标根更新并持久化通知：后台根产生的通知落回后台根自己的存储，不串进当前激活根。
  const updateNotifications = useCallback(
    (
      updater: (prev: AppNotification[]) => AppNotification[],
      targetRoot: string | null = workspaceRoot
    ) => {
      if (samePath(targetRoot ?? "", workspaceRoot ?? "")) {
        setNotifications((prev) => {
          const next = updater(prev);
          saveNotifications(workspaceRoot, next);
          return next;
        });
        return;
      }
      const next = updater(loadNotifications(targetRoot));
      saveNotifications(targetRoot, next);
    },
    [workspaceRoot]
  );

  // 工作区项目切换时，加载该项目的 7 天通知历史并重置屏幕浮动气泡与跟项目绑定的弹层/日志筛选
  useEffect(() => {
    setNotifications(loadNotifications(workspaceRoot));
    setActiveToasts([]);
    setLogReference("");
    setLogCompareRef(null);
    setLogPath("");
    setResolveOpen(false);
    setEverywhere(null);
    setDialog(null);
    setMenu(null);
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

  const docs = useDocuments(reportError, workspaceRoot);
  /**
   * 本地 git/fs 写操作后的 watcher 回声抑制窗口。
   * 这些操作完成后都主动刷新过了，`.git/index`、refs、被写文件自身的磁盘回声
   * 再触发一轮就是纯重复的 git 子进程；短窗口内的回声直接不追，外部改动靠
   * 聚焦/轮询兜底。
   */
  const gitEchoUntilRef = useRef(0);
  const suppressGitEcho = useCallback(() => {
    gitEchoUntilRef.current = Date.now() + 800;
  }, []);
  const git = useGitState(workspaceRoot, reportError, suppressGitEcho);
  /** 全量存盘并同步刷新 Git 变更列表，供失焦自动保存、退出前保存与保存按钮共用。 */
  const flushDirtyDocs = useCallback(async () => {
    const saved = await docs.saveAll();
    if (saved > 0) {
      suppressGitEcho();
      void git.refreshChanges();
    }
    return saved;
  }, [docs, git, suppressGitEcho]);
  /**
   * 挂载期注册的监听要读最新的那份，但绝不能把它写进依赖。
   * 这两个对象每次渲染都是新的（依赖 documents / status），进依赖就等于每次渲染
   * 摘挂一次监听——`listen` 那对还要走两趟 IPC。
   */
  const saveAllRef = useRef(flushDirtyDocs);
  saveAllRef.current = flushDirtyDocs;
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const gitRef = useRef(git);
  gitRef.current = git;
  /** 磁盘事件触发的 git 刷新防抖计时器；只留最后一趟，风暴期间不起中间的子进程。 */
  const gitDebounce = useRef<number | null>(null);
  /** 上一次真的向语言服务对齐的时刻，用来决定这次是立即跑还是排到尾沿。 */
  const lastLspSyncRef = useRef(0);
  /** 文档集合的路径签名（开 / 关 / 切根会变）。集合变了就不节流——新文件得马上 didOpen，补全和悬停等不起。 */
  const lspSetRef = useRef("");

  /**
   * 把打开的文档对到语言服务上。
   *
   * 只在文档列表、工作区或语言服务配置变动时重算。`reconcileLsp` 幂等，
   * 多调几次不会重复起进程或重复 didOpen；正在编辑的那份文档每敲一下会进一次这里，
   * 但内容没变的那几条会被它自己跳过。
   */
  // 交给语言服务的文档集合：只给「当前激活根下、已加载、可编辑、正文读回来了、且在磁盘上」的那几份。
  // 虚拟文档（git 历史里那份）不在磁盘上，语言服务按 URI 读不到，一并排除；未激活根的文档排除后会自动触发其 LSP 会话回收。
  const lspDocuments = useCallback(
    () =>
      workspaceRoot
        ? docs.documents
            .filter(
              (doc) =>
                !doc.loading &&
                !doc.readOnly &&
                doc.error === null &&
                doc.onDisk &&
                pathWithin(workspaceRoot, doc.path)
            )
            .map((doc) => ({ path: doc.path, language: doc.language, text: doc.contents }))
        : [],
    [docs.documents, workspaceRoot]
  );

  useEffect(() => {
    const run = () => {
      lastLspSyncRef.current = Date.now();
      // 客户端拉得到 monaco，静态引它就把整份编辑器打进启动 chunk；
      // 这里已经在等文档打开，动态引一次同一片 chunk，加载时机反而更准。
      void import("./lib/lspClient")
        .then(({ reconcileLsp }) => reconcileLsp(workspaceRoot, lspConfig, lspDocuments()))
        .catch(() => {});
    };
    // 文档集合本身变了（开 / 关 / 切根）必须立刻对齐：补全与悬停要求新文档已经 didOpen，
    // 晚一秒都是看得见的「这个文件没有智能提示」。
    const signature = lspDocuments()
      .map((doc) => doc.path)
      .join("\n");
    if (signature !== lspSetRef.current) {
      lspSetRef.current = signature;
      run();
      return;
    }
    // 剩下的只是正文变了。正文存在这一层，敲一个字 `lspDocuments` 就换身份、这个 effect
    // 就重走一趟：整份文档表重算 + 一遍会话分组。猛敲期间把它节流到窗口尾沿，只对齐最后一份。
    const wait = LSP_SYNC_GAP_MS - (Date.now() - lastLspSyncRef.current);
    if (wait <= 0) {
      run();
      return;
    }
    const timer = window.setTimeout(run, wait);
    return () => window.clearTimeout(timer);
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
  /** 当前激活根在各按根状态表中的索引键；用 ref 同步供恒定引用的按根 setter 读取，避免切换项目后旧闭包写串工作区。 */
  const rootKey = workspaceRoot ?? "";
  const rootKeyRef = useRef(rootKey);
  rootKeyRef.current = rootKey;
  /** 目录树里选中的那一批，按根分别记忆；最后一条是主行，右键菜单和键位都读这一份。 */
  const [explorerPickByRoot, setExplorerPickByRoot] = useState<Record<string, FsEntry[]>>({});
  const explorerPick = useMemo(
    () => explorerPickByRoot[rootKey] ?? EMPTY_PICK,
    [explorerPickByRoot, rootKey]
  );
  const setExplorerPick = useCallback((next: FsEntry[]) => {
    setExplorerPickByRoot((prev) => ({ ...prev, [rootKeyRef.current]: next }));
  }, []);
  /** 交给目录树的那份选中路径：每次渲染现 map 一个新数组的话，memo 就等于没装。 */
  const explorerPickedPaths = useMemo(
    () => explorerPick.map((entry) => entry.path),
    [explorerPick]
  );
  /** 剪切 / 复制攒下的那一批，连同它是挪走还是留下。 */
  const [clipboard, setClipboard] = useState<{ entries: FsEntry[]; cut: boolean } | null>(null);
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** 编辑区页签栏里的比对，按根隔离，同一根内按打开顺序排。 */
  const [diffsByRoot, setDiffsByRoot] = useState<Record<string, DiffTab[]>>({});
  const diffs = useMemo(() => diffsByRoot[rootKey] ?? EMPTY_DIFFS, [diffsByRoot, rootKey]);
  /** 「在新标签页中显示差异」要一份新标签，靠它把同一处比对的键区分开。 */
  const diffSeq = useRef(0);
  /**
   * 开过的那一串文件，按「根 -> 链条编号」存着这一串是按哪种口径比的。
   *
   * 标签上只留编号与序号，这里存的是数据而不是闭包：留着闭包就等于把打开它时的那一批
   * 连同当时的每一篇都钉死，旧标签的箭头会走向过期的那一批。
   */
  const diffChainsByRoot = useRef(new Map<string, Map<string, DiffChain>>());
  const getDiffChains = useCallback((targetRootKey?: string) => {
    const key = targetRootKey ?? rootKeyRef.current;
    let map = diffChainsByRoot.current.get(key);
    if (!map) {
      map = new Map<string, DiffChain>();
      diffChainsByRoot.current.set(key, map);
    }
    return map;
  }, []);
  /** 底部工具窗口各自待在哪：按根隔离（底部、选项卡、还是收着）。底部一次只放一块。 */
  const [placesByRoot, setPlacesByRoot] = useState<Record<string, Record<BottomPane, Placement>>>({});
  const places = useMemo(
    () => placesByRoot[rootKey] ?? DEFAULT_PLACES,
    [placesByRoot, rootKey]
  );
  const setPlaces = useCallback(
    (
      updater:
        | Record<BottomPane, Placement>
        | ((prev: Record<BottomPane, Placement>) => Record<BottomPane, Placement>)
    ) => {
      const key = rootKeyRef.current;
      setPlacesByRoot((prev) => {
        const current = prev[key] ?? DEFAULT_PLACES;
        const next = typeof updater === "function" ? updater(current) : updater;
        if (next === current) return prev;
        return { ...prev, [key]: next };
      });
    },
    []
  );
  /** 设置页开在不在页签栏里（全局一份，跨根保留）。 */
  const [settingsTab, setSettingsTab] = useState(false);
  const [settingsModule, setSettingsModule] = useState<SettingsModule>("general");
  /** 「编辑程序配置」那一页开在不在页签栏里（按根隔离）。 */
  const [runConfigsTabByRoot, setRunConfigsTabByRoot] = useState<Record<string, boolean>>({});
  const runConfigsTab = Boolean(runConfigsTabByRoot[rootKey]);
  const setRunConfigsTab = useCallback((open: boolean) => {
    setRunConfigsTabByRoot((prev) => ({ ...prev, [rootKeyRef.current]: open }));
  }, []);
  /** 递增即打开配置选择下拉，对应 `Alt+Shift+F10`。 */
  const [runChooser, setRunChooser] = useState(0);
  /** 页签栏当前选中的那一项，按根隔离，null 表示当前根编辑区是空的。 */
  const [activeTabByRoot, setActiveTabByRoot] = useState<Record<string, string | null>>({});
  const activeTab = activeTabByRoot[rootKey] ?? null;
  const aiSessions = useAiSessions(workspaceRoot, settings.aiAssistantsEnabled);
  const aiActiveProjects = useAiActiveProjects();
  const dispatchAiSession = aiSessions.dispatch;
  const aiLifecycle = useAiRunLifecycle(reportError);
  // 发送前的最后一道检查：CLI 会直接读写磁盘，项目里有未保存改动时先让用户保存，
  // 否则模型看到的是旧内容、改动还可能被覆盖。
  const beforeAiSend = useCallback(() => {
    if (workspaceRoot && docsRef.current.hasDirtyForRoot(workspaceRoot)) {
      reportError(t("ai.lifecycle.unsaved"));
      return false;
    }
    return true;
  }, [workspaceRoot, reportError, t]);
  // 事件监听是全局单例，这里只保证「启用后一定挂上」；重复调用由 lib 内部去重。
  useEffect(() => {
    if (settings.aiAssistantsEnabled && isTauri()) void ensureAiRuntimeListener().catch((error) => reportError(String(error)));
  }, [settings.aiAssistantsEnabled, reportError]);
  useEffect(() => {
    if (!settings.aiAssistantsEnabled || !workspaceRoot || !isTauri()) return;
    // 项目一激活就读取 Codex 的有效配置；会话输入区随后直接复用，不要求用户重新设置。
    void refreshAiProjectConfig(workspaceRoot).catch(() => {});
  }, [settings.aiAssistantsEnabled, workspaceRoot]);
  const activeAiSession = settings.aiAssistantsEnabled && activeTab?.startsWith("ai|")
    ? aiSessions.sessions.find((session) => session.id === activeTab.slice(3)) ?? null
    : null;
  const setActiveTab = useCallback((next: string | null) => {
    setActiveTabByRoot((prev) => ({ ...prev, [rootKeyRef.current]: next }));
  }, []);
  const restoredAiTabRoots = useRef(new Set<string>());
  useEffect(() => {
    if (activeTab) {
      restoredAiTabRoots.current.add(rootKey);
      return;
    }
    if (restoredAiTabRoots.current.has(rootKey) || !aiSessions.activeId) return;
    // 恢复明确记录的活动会话；它已在 useAiSessions 中经过 CLI 原生列表过滤。
    restoredAiTabRoots.current.add(rootKey);
    setActiveTab(`ai|${aiSessions.activeId}`);
  }, [activeTab, aiSessions.activeId, rootKey, setActiveTab]);
  useEffect(() => {
    if (settings.aiAssistantsEnabled) return;
    setPanel((current) => current === "ai" ? "explorer" : current);
    setAiDraftOpen({});
    setActiveTabByRoot((current) => Object.fromEntries(
      Object.entries(current).map(([root, tab]) => [root, tab?.startsWith("ai|") ? null : tab]),
    ));
  }, [settings.aiAssistantsEnabled]);
  const openAiSession = useCallback((id: string) => {
    if (!settings.aiAssistantsEnabled) return;
    dispatchAiSession({ type: "open", id });
    setActiveTab(`ai|${id}`);
  }, [dispatchAiSession, setActiveTab, settings.aiAssistantsEnabled]);
  /** 「新建会话」草稿标签是否打开，按根隔离；真正的会话在首条消息发出时才创建。 */
  const [aiDraftOpen, setAiDraftOpen] = useState<Record<string, boolean>>({});
  const openAiDraft = useCallback(() => {
    if (!settings.aiAssistantsEnabled) return;
    setAiDraftOpen((current) => ({ ...current, [rootKeyRef.current]: true }));
    setActiveTab("ai|draft");
  }, [setActiveTab, settings.aiAssistantsEnabled]);
  /**
   * 草稿页首条消息：创建会话、把欢迎页配置的选项种给新会话、留下待发出的
   * 文本与附件，然后切到会话标签——会话页挂载后自动把这条消息发出去。
   */
  const launchAiDraft = async (provider: AiProvider, text: string, images: string[]) => {
    if (!settings.aiAssistantsEnabled || !workspaceRoot) return;
    // 异步创建完成时用户可能已切换项目；后续状态必须仍写回发起创建的工程。
    const launchWorkspace = workspaceRoot;
    const launchRootKey = rootKey;
    // 删除旧会话后也不会复用现存会话的默认名称。
    let number = 1;
    let title = t("ai.defaultTitle", { name: AI_NAMES[provider], number });
    while (aiSessions.sessions.some((session) => session.title === title)) {
      title = t("ai.defaultTitle", { name: AI_NAMES[provider], number: ++number });
    }
    const requestedId = provider === "claude" ? crypto.randomUUID() : null;
    try {
      const session = await invoke<AiSession>("ai_runtime_create", { provider, workspace: launchWorkspace, sessionId: requestedId, title });
      seedAiSessionOptions(launchWorkspace, session.id, provider);
      setAiDraftHandoff(session.id, { text, images });
      dispatchAiSession({ type: "create", session });
      setAiDraftOpen((current) => ({ ...current, [launchRootKey]: false }));
      setActiveTabByRoot((current) => ({ ...current, [launchRootKey]: `ai|${session.id}` }));
    } catch (cause) {
      reportError(errorText(cause));
      throw cause;
    }
  };

  /**
   * 语言服务「跳转到定义」落到别的文件时，由这里把那份文件开出来并定位。
   *
   * 处理者内部通过 ref 取最新的 openHit 与 rootKey，跨文件跳转时同步激活目标文档页签。
   */
  useEffect(() => {
    setOpenTargetHandler((path, line, column) => {
      setActiveTab(`doc|${path}`);
      void docsRef.current.openHit(path, line, column).catch((cause: unknown) => {
        reportError(errorText(cause));
      });
      return true;
    });
    return () => setOpenTargetHandler(null);
  }, [reportError, setActiveTab]);
  /** 页签栏的排列顺序，按根隔离，只装标签 id；栏上有什么仍由各自的来源说。 */
  const [tabOrderByRoot, setTabOrderByRoot] = useState<Record<string, string[]>>({});
  const tabOrder = useMemo(
    () => tabOrderByRoot[rootKey] ?? EMPTY_TAB_ORDER,
    [rootKey, tabOrderByRoot]
  );
  const setTabOrder = useCallback((updater: string[] | ((prev: string[]) => string[])) => {
    const key = rootKeyRef.current;
    setTabOrderByRoot((prev) => {
      const current = prev[key] ?? EMPTY_TAB_ORDER;
      const next = typeof updater === "function" ? updater(current) : updater;
      if (next === current) return prev;
      return { ...prev, [key]: next };
    });
  }, []);
  /** 底部工具窗口整体高度，拖动上面那条横分隔条改它。 */
  const [bottomHeight, setBottomHeight] = useState(260);
  /** 侧边工具窗口宽度，拖动它右缘那条竖分隔条改它。 */
  const [sidebarWidth, setSidebarWidth] = useState(320);
  /** 右侧通知 / Maven 共用这一列的宽度，拖它左缘那条缝改它。 */
  const [rightWidth, setRightWidth] = useState(300);
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
  /** 双栏拆分编辑器（IDEA 的 Split Right / Split Down） */
  const [editorSplit, setEditorSplit] = useState<{ direction: "horizontal" | "vertical"; ratio: number } | null>(null);
  const [secondaryTab, setSecondaryTab] = useState<string | null>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const splitDragRef = useRef<{
    startX: number;
    startY: number;
    startRatio: number;
    totalWidth: number;
    totalHeight: number;
  } | null>(null);
  /** 本地历史时间线弹窗当前查看的文件 */
  const [historyFile, setHistoryFile] = useState<{
    path: string;
    name: string;
    language: string;
    currentContent: string;
  } | null>(null);
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
  /** 底部查找窗口里那一趟的结果，按根隔离。一次只看一趟，重跑就地覆盖。 */
  const [findByRoot, setFindByRoot] = useState<Record<string, FindState>>({});
  const find = useMemo(() => findByRoot[rootKey] ?? EMPTY_FIND, [findByRoot, rootKey]);
  const setFind = useCallback((next: FindState) => {
    setFindByRoot((prev) => ({ ...prev, [rootKeyRef.current]: next }));
  }, []);
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
  const rightPanelRef = useRef<HTMLElement | null>(null);
  const rightDrag = useRef<{ startX: number; startWidth: number; live: number } | null>(null);
  /** 每块工具窗口上次待的位置（按根隔离），最小化后再点活动栏那颗要回原处。 */
  const lastPlaceByRoot = useRef(new Map<string, Record<BottomPane, "docked" | "tabbed">>());
  const getLastPlace = useCallback((targetRootKey?: string) => {
    const key = targetRootKey ?? rootKeyRef.current;
    let record = lastPlaceByRoot.current.get(key);
    if (!record) {
      record = { ...DEFAULT_LAST_PLACE };
      lastPlaceByRoot.current.set(key, record);
    }
    return record;
  }, []);
  const configs = useRunConfigs(workspaceRoot);
  const run = useRunSessions(configs);

  const dockedPane =
    BOTTOM_ORDER.find((key) => key !== "notifications" && places[key] === "docked") ?? null;
  /** 当前激活根下的打开文档列表（按打开时绑定的所属工作区隔离，支持外部库跳转与父级仓库虚拟文档）。 */
  const visibleDocs = useMemo(
    () =>
      workspaceRoot
        ? docs.documents.filter((doc) => belongsToRoot(doc, workspaceRoot))
        : docs.documents,
    [docs.documents, workspaceRoot]
  );
  /** 当前那篇文档：只有选中的是当前根下的文档标签时才算「在看」（走 samePath 兼容 Windows 盘符大小写差异）。 */
  const shownDoc = activeTab && activeTab.startsWith("doc|") ? activeTab.slice(4) : null;
  const activeDoc = shownDoc
    ? (visibleDocs.find((doc) => samePath(doc.path, shownDoc)) ?? null)
    : null;
  const activeDiffTab =
    activeTab && activeTab.startsWith("diff|")
      ? (diffs.find((tab) => tab.id === activeTab.slice(5)) ?? null)
      : null;
  /** 副栏文档解析：拆分模式下副栏选中的文档或比对 */
  const secondaryShownDoc =
    secondaryTab && secondaryTab.startsWith("doc|") ? secondaryTab.slice(4) : null;
  const secondaryActiveDoc = secondaryShownDoc
    ? (visibleDocs.find((doc) => samePath(doc.path, secondaryShownDoc)) ?? null)
    : null;
  const secondaryActiveDiffTab =
    secondaryTab && secondaryTab.startsWith("diff|")
      ? (diffs.find((tab) => tab.id === secondaryTab.slice(5)) ?? null)
      : null;
  /**
   * 侧栏「定位文件位置」对准当前打开的文件；比对则对准工作区里还在的那份。
   * 没有这样的文件，或路径不在工程根下（外部库、临时打开）时留空，按钮置灰。
   */
  const locatePath = useMemo(() => {
    const path = activeDoc?.path ?? activeDiffTab?.openIn ?? null;
    if (!workspaceRoot || !path || !pathWithin(workspaceRoot, path)) return null;
    return path;
  }, [activeDiffTab, activeDoc, workspaceRoot]);
  const activePane =
    activeTab && activeTab.startsWith("pane|") ? (activeTab.slice(5) as BottomPane) : null;
  const changeCount = git.status?.changes.length ?? 0;
  /**
   * 当前这篇相对上次提交的基线。打字时正文还没进变更清单，所以不在清单里的跟踪文件也要对照。
   * 身份只跟路径、HEAD 和变更清单走，正文每敲一下字不会把基线换掉。
   */
  const changeBaseline = useMemo(() => {
    const path = activeDoc?.path;
    if (!path || !git.root) return null;
    const request = lineChangeBaseline(git.root, path, git.status?.changes ?? []);
    if (!request) return null;
    return {
      root: git.root,
      head: git.lastCommit?.hash ?? "",
      path: git.absoluteOf(request.relativePath),
      allowEmpty: request.allowEmpty,
    };
  }, [activeDoc?.path, git]);

  /** 副编辑器必须按自己的文档计算行变更基线，不能复用主栏当前文件。 */
  const secondaryChangeBaseline = useMemo(() => {
    const path = secondaryActiveDoc?.path;
    if (!path || !git.root) return null;
    const request = lineChangeBaseline(git.root, path, git.status?.changes ?? []);
    if (!request) return null;
    return {
      root: git.root,
      head: git.lastCommit?.hash ?? "",
      path: git.absoluteOf(request.relativePath),
      allowEmpty: request.allowEmpty,
    };
  }, [secondaryActiveDoc?.path, git]);

  /**
   * 侧栏蓝底只来自选中，不因「这篇正开着」再涂一档。
   * 页签离开后，若只选中了另一个文件，把选中清掉。点树打开时选中和页签是同一篇，留着。
   * 多选和目录选中不动。
   */
  const shownDocRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = shownDocRef.current;
    shownDocRef.current = shownDoc;

    if (shownDoc) {
      const matched = visibleDocs.find((doc) => samePath(doc.path, shownDoc));
      if (matched) {
        if (!docs.activePath || !samePath(docs.activePath, matched.path)) {
          docs.setActivePath(matched.path);
        }
        if (activeTab !== `doc|${matched.path}`) setActiveTab(`doc|${matched.path}`);
      }
    } else if (docs.activePath !== null) {
      docs.setActivePath(null);
    }

    const leftFile = previous !== null && (shownDoc === null || !samePath(previous, shownDoc));
    const pickedFile =
      explorerPick.length === 1 && explorerPick[0].kind !== "directory" ? explorerPick[0] : null;
    if (leftFile && pickedFile && (shownDoc === null || !samePath(pickedFile.path, shownDoc))) {
      setExplorerPick([]);
    }
  }, [activeTab, docs, explorerPick, setActiveTab, setExplorerPick, shownDoc, visibleDocs]);

  useEffect(() => {
    patchHistory({
      lastFolder: workspaceRoot ?? "",
      activeFolder: workspaceRoot ?? "",
      openFolders,
    });
  }, [openFolders, patchHistory, workspaceRoot]);

  // 本地图片要经 asset 协议读，授权不落盘，每次打开或恢复常驻工作区都得授一遍。
  useEffect(() => {
    for (const folder of openFolders) {
      if (folder) void allowAssetDir(folder).catch(() => {});
    }
    if (workspaceRoot) void allowAssetDir(workspaceRoot).catch(() => {});
  }, [openFolders, workspaceRoot]);

  // 键位方案只存值：装绑定要 monaco，编辑器还没建起来时为它加载编辑器不划算。
  // 编辑器模块加载时取当前值装一次，之后换方案由那边撤掉上一套再装。
  useEffect(() => {
    setKeymapScheme(settings.editor.keymap);
  }, [settings.editor.keymap]);

  // 托盘菜单是系统画的，吃不到界面这套 i18n，文字得由这边递过去。
  useEffect(() => {
    void setTrayLabels(t("tray.show"), t("tray.quit"));
  }, [t]);

  // 失焦自动保存：窗口失去焦点、页面切入后台或原生窗口失焦时，把手上改过的都写回磁盘。
  useEffect(() => {
    if (settings.editor.savePolicy !== "blur") return;
    const flush = () => void saveAllRef.current();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", onVisibility);
    const offNativeBlur = onWindowBlur(flush);
    return () => {
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      offNativeBlur();
    };
  }, [settings.editor.savePolicy]);

  // 切标签页等同于离开上一篇文档：开启失焦自动保存时，切走即落盘。
  useEffect(() => {
    if (settings.editor.savePolicy !== "blur") return;
    void saveAllRef.current();
  }, [activeTab, settings.editor.savePolicy]);

  // 退出前强制保存：只有所有可写文档都已变干净才确认退出。
  // 冲突或其它保存失败会让文档保持脏状态，此时显式取消后端看门狗并留下窗口供用户处理。
  useEffect(() => {
    const unlisten = listen("app://flush", async () => {
      await saveAllRef.current();
      if (docs.hasDirty()) await cancelAppExit().catch(() => {});
      else await appExit().catch(() => {});
    });
    return () => void unlisten.then((off) => off()).catch(() => {});
  }, [docs.hasDirty]);

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

  // 窗口重新激活时（对齐 IDEA 的 Frame Activation / VSCode 的 focus 刷新）：
  // 外部敲完 git 命令（如外部终端提交/切分支）切回应用窗口时，自动静默同步一次 Git 状态与最近提交。
  useEffect(() => {
    let lastFocusSync = 0;
    return onWindowFocus(() => {
      const now = Date.now();
      // 避免快速在多窗口切换时频繁起进程（设置 1.5 秒节流冷却）
      if (now - lastFocusSync < 1500) return;
      lastFocusSync = now;
      if (workspaceRoot) {
        void gitRef.current.refresh();
      }
    });
  }, [workspaceRoot]);

  // 当 Git 侧边栏打开或 Git Log 面板展开时，设置 30 秒低频防饥饿兜底轮询，
  // 避免在外部执行 Git 操作后、未切窗口时副屏长达半小时不刷新。
  useEffect(() => {
    if (!workspaceRoot) return;
    const isGitPaneVisible = (sidebarOpen && panel === "git") || places.log !== "hidden";
    if (!isGitPaneVisible) return;

    const interval = window.setInterval(() => {
      void gitRef.current.refreshChanges();
    }, 30000);

    return () => window.clearInterval(interval);
  }, [panel, places.log, sidebarOpen, workspaceRoot]);

  const refreshTree = useCallback(
    () => setTreeRefresh((current) => ({ paths: null, seq: current.seq + 1 })),
    []
  );
  // AI 运行期间会改文件，这些改动不经过编辑器，所以要主动刷新文件树、Git 变更，
  // 并通知已打开的文档去重载。事件里只带项目相对/绝对路径，这里统一过滤掉
  // 逃出工作区的路径，避免被诱导去读工作区外的文件。
  useEffect(() => {
    if (!settings.aiAssistantsEnabled || !isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<AiRuntimeEvent[]>("ai-runtime://events", ({ payload }) => {
      if (disposed || !workspaceRoot || !Array.isArray(payload)) return;
      const projectEvents = filterAiProjectEvents(payload, workspaceRoot);
      const changed = projectEvents.filter((event) => event.kind === "files").flatMap((event) =>
        Array.isArray(event.data.paths) ? event.data.paths.filter((path): path is string => typeof path === "string") : []);
      // 只有「真的改了文件」或「任务跑完了」才值得全量刷新；其余状态事件太频繁。
      if (changed.length || projectEvents.some((event) => event.kind === "status" && event.data.status !== "running")) {
        refreshTree();
        void gitRef.current.refreshChanges();
        if (changed.length && workspaceRoot) {
          const paths = changed.filter((path) => !path.split(/[\\/]/).includes(".."))
            .map((path) => path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, ""))
            .map((path) => /^(?:[a-z]:[\\/]|[\\/])/i.test(path) ? path : joinPath(workspaceRoot, path))
            .filter((path) => pathWithin(workspaceRoot, path));
          void docsRef.current.noteExternalChange(paths);
        }
      }
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch((error) => reportError(String(error)));
    return () => { disposed = true; unlisten?.(); };
  }, [settings.aiAssistantsEnabled, workspaceRoot, refreshTree, reportError]);

  /** 磁盘事件报得来的是具体哪几条路径变了，缓存就只作废与它们相干的那些目录。 */
  const refreshPaths = useCallback(
    (paths: string[]) => setTreeRefresh((current) => ({ paths, seq: current.seq + 1 })),
    []
  );

  /** 本地文件删除操作进行中标志：删除期间暂停响应磁盘监听，待删除结束后一次性刷新。 */
  const fsDeletingRef = useRef(false);
  /** 删除动作完成并主动刷新后的短暂回声抑制窗口（时间戳），防止尾随到达的监听事件重复刷树。 */
  const suppressWatchUntilRef = useRef(0);
  /**
   * 文件删除进度状态（参照 IDEA `DeleteHandlerHelper.kt` + `ProgressDialogUI.kt`）：
   * - `deleting` 阶段：批量删除或大目录删除超过延迟阈值时在窗口中央展示模态进度弹窗，
   *   实时刷新底层递归回调上报的 `已删除：{count} 个文件/目录`；
   * - `done` 阶段：模态框关闭，底部全局状态栏短暂提示已删除结果。
   */
  const [deleteStatus, setDeleteStatus] = useState<{
    phase: "deleting" | "done";
    name: string;
    deletedCount: number;
    current: number;
    total: number;
    modalVisible: boolean;
  } | null>(null);
  const deleteStatusTimerRef = useRef<number | null>(null);
  const deleteModalDelayRef = useRef<number | null>(null);
  /** 跨多个顶层选中项累计已删除的底层文件/目录数。 */
  const deleteBaseCountRef = useRef(0);
  /** 当前正在删除的单个顶层条目已上报的底层删除数。 */
  const deleteCurrentTargetCountRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let detach: (() => void) | null = null;
    void listen<{ count: number; current: string }>("fs://delete-progress", (event) => {
      if (!fsDeletingRef.current) return;
      const { count, current } = event.payload;
      deleteCurrentTargetCountRef.current = count;
      const totalDeleted = deleteBaseCountRef.current + count;
      setDeleteStatus((prev) =>
        prev && prev.phase === "deleting"
          ? {
              ...prev,
              deletedCount: totalDeleted,
              name: current || prev.name,
              modalVisible: prev.modalVisible || totalDeleted >= 2,
            }
          : prev
      );
    }).then((off) => {
      if (cancelled) off();
      else detach = off;
    });
    return () => {
      cancelled = true;
      if (detach) detach();
      if (deleteStatusTimerRef.current !== null) {
        window.clearTimeout(deleteStatusTimerRef.current);
      }
      if (deleteModalDelayRef.current !== null) {
        window.clearTimeout(deleteModalDelayRef.current);
      }
      if (rescanConfigsTimerRef.current !== null) {
        window.clearTimeout(rescanConfigsTimerRef.current);
        rescanConfigsTimerRef.current = null;
      }
    };
  }, []);
  /**
   * 包管理安装/清理会话运行期间按工作区根暂存的待刷新路径，待会话结束再统一刷新。
   * `.git` 里的事件也要一起攒着：安装期间从外部终端来的一次 checkout 若不落地，
   * 分支名会一直停在旧的那份上。
   */
  const deferredPathsByRootRef = useRef(
    new Map<string, { root: string; paths: Set<string>; gitPaths: Set<string>; firstAt: number }>()
  );
  const runSessionsRef = useRef(run.allSessions);
  runSessionsRef.current = run.allSessions;
  /** 记录上一轮仍处于 running 状态的会话 ID -> root，用于会话刚结束时立即触发目录树刷新。 */
  const prevRunningSessionsRef = useRef(new Map<string, string>());
  const rescanConfigsTimerRef = useRef<number | null>(null);
  const rescanConfigsRef = useRef(configs.rescan);
  rescanConfigsRef.current = configs.rescan;

  /** 判断运行会话是否为包安装或大批量文件增删命令（如 npm install / npm i / pnpm i / yarn / 依赖同步 / clean 等）。 */
  const isBulkInstallSession = useCallback(
    (session: (typeof run.allSessions)[number]) =>
      session.config.id.startsWith("dep-sync::") ||
      /\b(?:npm|pnpm|yarn|bun|cnpm|cargo|mvn|mvnw|gradle|gradlew|pip|pip3|poetry|uv|composer|dotnet|go)\b(?:\s+(?:install|i|ci|add|remove|rm|uninstall|update|up|sync|clean|tidy|restore|build| fetch)\b|\s*$)/i.test(
        session.command.trim()
      ),
    []
  );

  // 包管理/构建会话结束的收尾刷新在 `flushWorkspace` 定义之后（收尾要用它，得先声明）。

  /**
   * 一批工作区变动落地时要做的三件事：作废目录缓存、防抖重扫顶栏运行配置、防抖重取 Git 状态。
   *
   * 监听来的批次和安装会话收尾时攒下的那批路径都走这儿。之前收尾那段是自己另写的一套：
   * 只刷了树和 Git，manifest 重扫整个漏了（安装期间被暂存的那批根本进不了监听那条路），
   * 而且立即刷完还补一次 600ms 重刷——同一棵树连着作废两轮。
   */
  const flushWorkspace = useCallback(
    (changedRoot: string, flush: WorkspaceFlush) => {
      const plan = planWorkspaceFlush({
        ...flush,
        manifestChanged: flush.workspacePaths.some((p) =>
          isManifestDeclarationFile(p, changedRoot)
        ),
      });

      if (plan.tree === "full") {
        refreshTree();
      } else if (plan.tree === "precise") {
        // 只作废与这批路径相干的目录：构建产物那种整棵重读是白花钱。
        refreshPaths(flush.workspacePaths);
      }

      // Git 与顶栏配置只认当前激活根：`rescan` 扫的永远是当前根，后台根白扫一遍，
      // 那个后台根的配置照样是旧的（切回它时 `useRunConfigs` 自己会重扫）。
      if (!workspaceRoot || !samePath(changedRoot, workspaceRoot)) return;

      // 工程构建声明文件（package.json、pom.xml、Cargo.toml）因保存或 git checkout / pull 变化时，
      // 防抖重扫顶栏运行配置。
      if (plan.configs) {
        if (rescanConfigsTimerRef.current !== null) {
          window.clearTimeout(rescanConfigsTimerRef.current);
        }
        rescanConfigsTimerRef.current = window.setTimeout(() => {
          rescanConfigsTimerRef.current = null;
          rescanConfigsRef.current();
        }, 600);
      }

      // 防抖 200ms：比原来 500ms 快，改完状态栏与侧栏的反馈就跟得上手感。
      if (plan.git !== "none") {
        const run = () => {
          gitDebounce.current = null;
          // 刚做过一次本地 git / 保存动作，那一轮状态已经由它自己刷新过了；这次回声是同一次
          // 写入的尾巴，再刷就是白起一个 git 进程。
          if (Date.now() < gitEchoUntilRef.current) {
            // 但引用类变动（HEAD / refs / MERGE_HEAD）不能跟着一起丢：30s 轮询只重取变更清单，
            // 分支名不会自己回来。这类事件挪到抑制窗口末尾补一次，别把外部 checkout 吞掉。
            if (plan.git === "full") {
              const remaining = gitEchoUntilRef.current - Date.now();
              if (gitDebounce.current !== null) window.clearTimeout(gitDebounce.current);
              gitDebounce.current = window.setTimeout(run, Math.max(20, remaining) + 20);
            }
            return;
          }
          if (plan.git === "full") {
            void gitRef.current.refresh();
          } else {
            void gitRef.current.refreshChanges();
          }
        };
        const gitTimer = gitDebounce.current;
        if (gitTimer) window.clearTimeout(gitTimer);
        gitDebounce.current = window.setTimeout(run, 200);
      }
    },
    [refreshPaths, refreshTree, workspaceRoot]
  );

  /**
   * 磁盘上出了事就三处一起补：目录树重读、变更清单重取、打开的文档按干净 / 脏分别处理。
   * 报来的路径既喂给文档判定，也用来把树的缓存精确作废。
   *
   * 区分工作区常规文件与 .git 版本控制元数据：
   * - 外部执行 git commit / checkout / branch 等仅变动 .git 核心指针时，精准触发 Git 刷新，
   *   不误触工作区目录树重读，避免无谓的磁盘开销；
   * - 运行包安装期间，工作区文件与 Git 刷新一起暂存防风暴，并带 3000ms 超时上限防饥饿；
   *   会话收尾时攒下的路径改走 `flushWorkspace`，与监听同一套落地。
   */
  const onDiskChange = useCallback(
    (changedRoot: string, paths: string[], bulk = false) => {
      invalidateJavaIcons(paths);
      const isGitInternal = (p: string) => {
        const norm = p.replaceAll("\\", "/");
        return norm.includes("/.git/") || norm.endsWith("/.git");
      };
      const workspacePaths = paths.filter((p) => !isGitInternal(p));
      const gitPaths = paths.filter(isGitInternal);

      // 任何常驻根下的已打开文档都跟着感知外部修改（干净的自动重读，脏的标记磁盘变化）。
      if (workspacePaths.length > 0) {
        void docsRef.current.noteExternalChange(workspacePaths);
        // 构建脚本或顶层依赖目录变动时，通知依赖同步检测器（内部先经 O(1) 白名单过滤 + 600ms 防抖）。
        depSyncRef.current?.noteDiskChange(changedRoot, workspacePaths);
      }

      // 正在执行文件删除或处于删除刚结束的回声抑制窗口内时，暂停文件管理器与 Git 的重复刷新。
      if (fsDeletingRef.current || Date.now() < suppressWatchUntilRef.current) {
        return;
      }

      // 若该工作区当前有正在运行的包安装/清理会话（如 npm install），暂存工作区文件路径等会话结束再刷。
      // 加入 3000ms 防饥饿超时机制，防止后台长任务导致文件树永久不刷新。
      let deferWorkspace = false;
      if (workspacePaths.length > 0) {
        const hasRunningInstall = runSessionsRef.current.some(
          (s) =>
            s.status === "running" &&
            samePath(s.root, changedRoot) &&
            isBulkInstallSession(s)
        );
        if (hasRunningInstall) {
          const key = changedRoot.replaceAll("\\", "/").toLowerCase();
          const now = Date.now();
          let deferred = deferredPathsByRootRef.current.get(key);
          if (!deferred) {
            deferred = {
              root: changedRoot,
              paths: new Set(workspacePaths),
              gitPaths: new Set(gitPaths),
              firstAt: now,
            };
            deferredPathsByRootRef.current.set(key, deferred);
            deferWorkspace = true;
          } else if (now - deferred.firstAt < 3000) {
            for (const p of workspacePaths) deferred.paths.add(p);
            for (const p of gitPaths) deferred.gitPaths.add(p);
            deferWorkspace = true;
          } else {
            // 已超过 3000ms 上限，强制放行并重置积攒计时
            deferredPathsByRootRef.current.delete(key);
          }
        }
      }

      // 安装风暴期间整批按住：树、Git、顶栏配置一起等会话收尾补刷（见 flushWorkspace 与
      // 上面那个 3000ms 防饥饿上限）。放行时三类落地都走 flushWorkspace 这一条路。
      if (!deferWorkspace && (workspacePaths.length > 0 || gitPaths.length > 0)) {
        flushWorkspace(changedRoot, { workspacePaths, gitPaths, bulk });
      }
    },
    [flushWorkspace, isBulkInstallSession]
  );

  // 包管理/构建会话（npm install、cargo build 等）结束时，把安装期间按住的那批路径补刷掉。
  // 三类落地全走 `flushWorkspace`：以前这里另写了一套「立即刷 + 600ms 再刷一遍」，
  // 既漏了顶栏运行配置重扫（manifest 正躺在被按住的那批里没送出去），又把同一棵树连续作废了两轮。
  useEffect(() => {
    const currentRunning = new Map<string, string>();
    for (const s of run.allSessions) {
      if (s.status === "running") {
        currentRunning.set(s.id, s.root);
      }
    }

    const finishedRoots = new Set<string>();
    for (const [id, root] of prevRunningSessionsRef.current.entries()) {
      if (!currentRunning.has(id)) {
        finishedRoots.add(root);
      }
    }
    prevRunningSessionsRef.current = currentRunning;

    // 攒下的路径按根取出来一起补刷：安装期间被按住的写入只有靠这批才落地，
    // 锁文件也跟着它们触发配置重扫。
    const deferredByKey = new Map<string, { workspacePaths: string[]; gitPaths: string[] }>();
    for (const [key, entry] of [...deferredPathsByRootRef.current.entries()]) {
      const stillRunning = run.allSessions.some(
        (s) =>
          s.status === "running" && samePath(s.root, entry.root) && isBulkInstallSession(s)
      );
      if (stillRunning) continue;
      deferredPathsByRootRef.current.delete(key);
      finishedRoots.add(entry.root);
      deferredByKey.set(key, {
        workspacePaths: [...entry.paths],
        gitPaths: [...entry.gitPaths],
      });
    }

    for (const root of finishedRoots) {
      const deferred = deferredByKey.get(root.replaceAll("\\", "/").toLowerCase());
      flushWorkspace(root, {
        workspacePaths: deferred?.workspacePaths ?? [],
        gitPaths: deferred?.gitPaths ?? [],
        // 收尾这一趟按批量算：装完依赖树结构整块变了，值得全量重读。
        bulk: true,
        finishedInstall: true,
      });
    }
  }, [flushWorkspace, isBulkInstallSession, run.allSessions]);

  const watchedRoots = useMemo(
    () => (openFolders.length > 0 ? openFolders : workspaceRoot ? [workspaceRoot] : []),
    [openFolders, workspaceRoot]
  );

  useFileWatch(watchedRoots, onDiskChange);

  /** 把一块工具窗口放到底部：底部是排他的，原来那块退回收起。 */
  const dockPane = useCallback(
    (key: BottomPane) => {
      getLastPlace()[key] = "docked";
      setPlaces((current) => {
        const next = { ...current };
        // 通知停在右侧，和底部那一块互不挤占。右侧和 Maven 共用一列，开通知就把 Maven 让出去。
        if (key !== "notifications") {
          for (const other of BOTTOM_ORDER) {
            if (other === "notifications") continue;
            if (next[other] === "docked") next[other] = "hidden";
          }
        }
        next[key] = "docked";
        return next;
      });
      if (key === "notifications") closeMaven();
      // 日志是三栏并排，太矮就没法看。
      if (key === "log") setBottomHeight((height) => Math.max(height, 380));
    },
    [getLastPlace, setPlaces]
  );

  /** 收起：只藏界面，shell 和任务继续在后台跑。 */
  const hidePane = useCallback(
    (key: BottomPane) => {
      setPlaces((current) => ({ ...current, [key]: "hidden" }));
    },
    [setPlaces]
  );

  /**
   * 拉起一块面板，但**只在它收着的时候**才动：已经停靠在底部或已挪进页签栏的，保持原状。
   * 触发运行/调试这类「顺带让你看一眼」的动作走这条，不能拿 `dockPane`——那会把用户
   * 手动挪到页签栏或正在看的面板强行拽回底部，等于篡改用户自己摆好的布局。
   */
  const revealPane = useCallback(
    (key: BottomPane) => {
      const wasHidden = places[key] === "hidden";
      setPlaces((current) => {
        // 已经可见（停靠在底部或挪进页签栏）：用户自己摆的位置，原样不动。
        if (current[key] !== "hidden") return current;
        // 收着才拉起：底部是排他的，原来停靠的那块退回收起。通知在右侧，不参与这一轮。
        const next = { ...current };
        if (key !== "notifications") {
          for (const other of BOTTOM_ORDER) {
            if (other === "notifications") continue;
            if (next[other] === "docked") next[other] = "hidden";
          }
        }
        next[key] = "docked";
        return next;
      });
      // 通知从收起变成右侧时才让出 Maven。已经在选项卡里的不动。
      if (wasHidden && key === "notifications") closeMaven();
    },
    [places, setPlaces]
  );

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
    [places, revealPane, setActiveTab]
  );

  const focusRunPane = useCallback(() => focusPane("run"), [focusPane]);
  const depSync = useDepSync(workspaceRoot, watchedRoots, run, focusRunPane);
  const depSyncRef = useRef(depSync);
  depSyncRef.current = depSync;

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
        shell.id,
        workspaceRoot,
        buildScriptCommand(kind, path, dir),
        // 会话进表之后再把它弄到眼前：否则面板先挂载，needTermSession 找不到会话会另开一条空的。
        () => focusPane("terminal")
      ).catch((cause: unknown) => reportError(errorText(cause)));
    },
    [focusPane, reportError, workspaceRoot]
  );

  /** 同一条请求连点时，只采纳最后一次的响应。键是文件路径（分栏）或响应页签路径。 */
  const httpGenRef = useRef(new Map<string, number>());
  /** 左右分栏时挂在请求文件右边的响应正文。换文件就按路径对上，不另开页签。 */
  const [httpSide, setHttpSide] = useState<{ path: string; text: string } | null>(null);
  /**
   * `.http` / `.rest` 装订线那颗 ▶：解析编辑器里的当前正文，发出这一条请求。
   *
   * 引用了还没跑过的具名请求时会先把依赖发出去。
   * 左右分栏把响应留在这份文件右边；单独页签才开只读页。两种都不写回磁盘。
   */
  const runHttp = useCallback(
    (path: string, line: number, contents: string) => {
      const file = parseHttpFile(contents);
      const request = file.requests.find((item) => item.line === line);
      if (!request) return;
      const dir = parentPath(path) ?? workspaceRoot ?? "";
      const split = settings.httpResponse === "split";
      const key = split ? path : httpResponsePath(path, line);
      const label = httpRequestLabel(request);
      const gen = (httpGenRef.current.get(key) ?? 0) + 1;
      httpGenRef.current.set(key, gen);
      const sending = t("http.sending", { name: label });
      const show = (text: string) => {
        if (split) {
          setHttpSide({ path, text });
          return;
        }
        docsRef.current.openVirtual(key, text, "http");
      };
      if (!split) setActiveTab(`doc|${key}`);
      show(sending);
      void executeHttpRequest(file, request, { dir, workspace: workspaceRoot })
        .then((result) => {
          if (httpGenRef.current.get(key) !== gen) return;
          show(
            formatHttpExchange(result, {
              binary: t("http.binary", { size: result.bodyBytes }),
              truncated: t("http.truncated", { size: result.body.length }),
            })
          );
        })
        .catch((cause: unknown) => {
          if (httpGenRef.current.get(key) !== gen) return;
          const raw = errorText(cause);
          show(describeError(raw, t));
          reportError(raw);
        });
    },
    [reportError, setActiveTab, settings.httpResponse, t, workspaceRoot]
  );

  /** 挪进页签栏：好几块能同时开着，切换着看。 */
  const tabPane = useCallback(
    (key: BottomPane) => {
      getLastPlace()[key] = "tabbed";
      setPlaces((current) => {
        const next = { ...current };
        if (key !== "notifications") {
          for (const other of BOTTOM_ORDER) {
            if (other === "notifications") continue;
            if (next[other] === "docked") next[other] = "hidden";
          }
        }
        next[key] = "tabbed";
        return next;
      });
      setActiveTab(`pane|${key}`);
    },
    [getLastPlace, setActiveTab, setPlaces]
  );

  /** 活动栏那颗按钮：底部那块再点一次收起；在页签栏里的直接跳到它那一页。 */
  const railPane = useCallback(
    (key: BottomPane) => {
      if (places[key] === "docked") hidePane(key);
      else if (places[key] === "tabbed") setActiveTab(`pane|${key}`);
      // 收着的那颗：回到它上次待的地方，之前切到选项卡过就不硬塞回底部。
      else if (getLastPlace()[key] === "tabbed") tabPane(key);
      else dockPane(key);
    },
    [dockPane, getLastPlace, hidePane, places, setActiveTab, tabPane]
  );

  /** 把一份比对落到页签栏里：同 id 就地更新，新 id 追加到末尾并选中；支持指定目标根，防异步期间切根写串。 */
  /** 填内容的那一次不许抢焦点：加载完成时用户可能已经切去别处了。 */
  const putDiff = useCallback(
    (tab: DiffTab, activate: boolean = true, targetRootKey?: string) => {
      const key = targetRootKey ?? rootKeyRef.current;
      setDiffsByRoot((prev) => {
        const list = prev[key] ?? EMPTY_DIFFS;
        const next = list.some((item) => item.id === tab.id)
          ? list.map((item) => (item.id === tab.id ? tab : item))
          : [...list, tab];
        return { ...prev, [key]: next };
      });
      if (activate) {
        setActiveTabByRoot((prev) => ({ ...prev, [key]: `diff|${tab.id}` }));
      }
    },
    []
  );

  const closeDiff = useCallback((id: string, targetRootKey?: string) => {
    const key = targetRootKey ?? rootKeyRef.current;
    setDiffsByRoot((prev) => {
      const list = prev[key] ?? EMPTY_DIFFS;
      const next = list.filter((item) => item.id !== id);
      if (next.length === list.length) return prev;
      // 提交比对链每次「在新标签中显示差异」都用带序号的唯一键，标签全关后
      // 那条链连同整份 GitCommitDetail 再没人引用——不回收就只增不减（只在关根时清）。
      const chainId = list.find((item) => item.id === id)?.chain?.id;
      if (
        chainId &&
        chainId.startsWith("cm|") &&
        !next.some((item) => item.chain?.id === chainId)
      ) {
        getDiffChains(key).delete(chainId);
      }
      return { ...prev, [key]: next };
    });
  }, [getDiffChains]);

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

  /** 点击依赖同步气泡中的构建清单链接：在编辑器中打开该清单并在项目树定位。 */
  const openDepSyncManifest = useCallback(
    (manifestRelPath: string, itemRoot: string) => {
      const baseRoot = nativeSeparators(itemRoot || workspaceRoot || "");
      if (!baseRoot) return;
      if (workspaceRoot && !samePath(baseRoot, workspaceRoot)) {
        setWorkspaceRoot(baseRoot);
      }
      const fullPath = joinPath(baseRoot, nativeSeparators(manifestRelPath));
      openSearchFile(fullPath, false);
    },
    [openSearchFile, workspaceRoot]
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
   * 双击 Shift 照 IDEA 那条键盘手势（`$default.xml` 里的 `shift SHIFT`）：两次轻击 Shift 的
   * 间隔不超过 350ms 才算，中间落了别的键就重新计。长按 Shift（持续按住或发生 repeat）
   * 严格判定为长按，绝不触发搜索。焦点在输入框里时不认这条，
   * 否则重命名框里连按两下 Shift 会把弹层盖上去；monaco 那块输入面除外，
   * 它是编辑器本体，IDEA 在这儿照样生效。终端的辅助 textarea 不除外，那边敲的是 shell。
   */
  useEffect(() => {
    const detector = new DoubleShiftDetector();
    const onKeyDown = (event: KeyboardEvent) => {
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
          detector.reset();
          openEverywhere("text", selectedText());
          return;
        }
        // Ctrl+Shift+N 是 Go to File：同一个弹层落在文件页签上，不是另一个框。
        if (key === "n") {
          event.preventDefault();
          detector.reset();
          openEverywhere("files");
          return;
        }
      }
      const disabled = inField || !!dialog || !!menu || resolveOpen || !!everywhere;
      if (detector.handleKeyDown(event, disabled)) {
        event.preventDefault();
        openEverywhere("all");
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      detector.handleKeyUp(event);
    };
    const onBlur = () => {
      detector.reset();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
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

  /**
   * 彻底清理并移除一个常驻文件夹（在确认无脏文件/运行任务或用户已确认放弃后调用）。
   *
   * 改成 async 是因为要先停掉该项目下的 AI 任务：进程还在写文件时就把项目从界面上摘掉，
   * 后续事件会指向一个已不存在的根。停止失败则中止关闭并返回 false，
   * 由调用方决定是否继续（换文件夹的场景会就此打住，避免留下跑着的任务）。
   */
  const performCloseRoot = useCallback(
    async (targetRoot: string) => {
      try { if (isTauri()) await invoke("ai_runtime_stop_project", { workspace: targetRoot }); }
      catch (error) { reportError(String(error)); return false; }
      void closeTermsForRoot(targetRoot);
      run.closeSessionsForRoot(targetRoot);
      // 忽略清单缓存按仓库根存，可能挂在子仓库键上：把该文件夹之下的条目一并回收。
      forgetIgnoredUnder(targetRoot);
      for (const doc of docs.documents) {
        if (belongsToRoot(doc, targetRoot)) {
          disposeModel(doc.path);
        }
      }
      docs.closeForRoot(targetRoot);
      // 只有工程被真正关闭才注销轮询；切换前台工程时必须继续监测后台会话。
      forgetAiSessionWorkspace(targetRoot);
      setDiffsByRoot((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (samePath(key, targetRoot)) delete next[key];
        }
        return next;
      });
      for (const key of Array.from(diffChainsByRoot.current.keys())) {
        if (samePath(key, targetRoot)) diffChainsByRoot.current.delete(key);
      }
      setFindByRoot((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (samePath(key, targetRoot)) delete next[key];
        }
        return next;
      });
      setExplorerPickByRoot((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (samePath(key, targetRoot)) delete next[key];
        }
        return next;
      });
      setRunConfigsTabByRoot((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (samePath(key, targetRoot)) delete next[key];
        }
        return next;
      });
      setTabOrderByRoot((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (samePath(key, targetRoot)) delete next[key];
        }
        return next;
      });
      setActiveTabByRoot((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (samePath(key, targetRoot)) delete next[key];
        }
        return next;
      });
      setPlacesByRoot((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (samePath(key, targetRoot)) delete next[key];
        }
        return next;
      });
      for (const key of Array.from(lastPlaceByRoot.current.keys())) {
        if (samePath(key, targetRoot)) lastPlaceByRoot.current.delete(key);
      }

      const closingCurrent = workspaceRoot !== null && samePath(workspaceRoot, targetRoot);
      const idx = openFolders.findIndex((item) => samePath(item, targetRoot));
      const remaining = openFolders.filter((item) => !samePath(item, targetRoot));
      setOpenFolders(remaining);

      if (closingCurrent) {
        setClipboard(null);
        setActiveToasts([]);
        const fallback =
          remaining.length > 0
            ? (remaining[Math.min(Math.max(0, idx), remaining.length - 1)] ?? null)
            : null;
        if (fallback && activeTab === "settings" && settingsTab) {
          setActiveTabByRoot((prev) => ({ ...prev, [fallback]: "settings" }));
        }
        setWorkspaceRoot(fallback);
      }
      return true;
    },
    [activeTab, docs, openFolders, run, settingsTab, workspaceRoot, reportError]
  );

  /** 请求关闭指定文件夹：先处理失焦自动保存，再检查是否有未保存改动或后台运行任务。 */
  const requestCloseRoot = useCallback(
    async (targetRoot: string) => {
      if (settings.editor.savePolicy === "blur") {
        const saved = await docs.saveAllForRoot(targetRoot);
        if (saved > 0 && workspaceRoot && samePath(workspaceRoot, targetRoot)) {
          suppressGitEcho();
          void git.refreshChanges();
        }
      }
      const dirty = docs.hasDirtyForRoot(targetRoot);
      // AI 任务也算「运行中」：关闭项目会杀掉它们的进程，必须先让用户确认。
      const running =
        run.hasRunningSessionsForRoot(targetRoot) || hasAliveTermsForRoot(targetRoot) || hasAiRuns(targetRoot);
      if (dirty || running) {
        setDialog({
          kind: "closeRoot",
          name: basenameOf(targetRoot),
          path: targetRoot,
          closeReason: dirty && running ? "both" : dirty ? "dirty" : "running",
          entry: null,
          dir: null,
        });
        return;
      }
      await performCloseRoot(targetRoot);
    },
    [docs, git, performCloseRoot, run, settings.editor.savePolicy, suppressGitEcho, workspaceRoot]
  );

  /** 切换或添加文件夹：多工作区模式下常驻并秒切；单工作区模式下替换当前激活根。 */
  const switchOrAddFolder = useCallback(
    async (picked: string) => {
      if (settings.editor.savePolicy === "blur") {
        void saveAllRef.current();
      }
      const existing = openFolders.find((item) => samePath(item, picked)) ?? picked;
      const keepSettingsActive = activeTab === "settings" && settingsTab;

      if (settings.workspaceMode === "single") {
        // 单工作区模式：若所选不是已常驻的后台根，关闭当前激活根并就地替换；不触碰其它已常驻的根。
        // 关闭失败（AI 任务停不下来）就不切走，否则新项目会顶着一个还在跑旧任务的后端。
        const alreadyOpen = openFolders.some((item) => samePath(item, existing));
        if (workspaceRoot && !samePath(workspaceRoot, existing) && !alreadyOpen) {
          if (!await performCloseRoot(workspaceRoot)) return;
        }
        setOpenFolders((prev) => {
          if (prev.length <= 1) return [existing];
          if (prev.some((item) => samePath(item, existing))) return prev;
          return workspaceRoot
            ? prev.map((item) => (samePath(item, workspaceRoot) ? existing : item))
            : [...prev, existing];
        });
      } else {
        setOpenFolders((prev) =>
          prev.some((item) => samePath(item, existing)) ? prev : [...prev, existing]
        );
      }

      if (keepSettingsActive) {
        setActiveTabByRoot((prev) => ({ ...prev, [existing]: "settings" }));
      }
      setActiveToasts([]);
      setWorkspaceRoot(existing);
      remember("recentFolders", existing);
      setPanel("explorer");
      setSidebarOpen(true);
    },
    [
      activeTab,
      openFolders,
      performCloseRoot,
      remember,
      settings.editor.savePolicy,
      settings.workspaceMode,
      settingsTab,
      workspaceRoot,
    ]
  );

  const openFolder = useCallback(async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: t("workspace.openFolder"),
      defaultPath: workspaceRoot ?? undefined,
    });
    if (typeof picked !== "string" || picked.length === 0) return;
    switchOrAddFolder(picked);
  }, [switchOrAddFolder, t, workspaceRoot]);

  const closeFolder = useCallback(() => {
    if (!workspaceRoot) return;
    void requestCloseRoot(workspaceRoot);
  }, [requestCloseRoot, workspaceRoot]);

  /** 传给顶栏工程切换器的常驻文件夹状态摘要（绿点 = 后台任务/终端运行中，蓝点 = 有未保存修改）。 */
  const folderStatusList: FolderStatusItem[] = useMemo(() => {
    const roots =
      openFolders.length > 0
        ? workspaceRoot && !openFolders.some((item) => samePath(item, workspaceRoot))
          ? [...openFolders, workspaceRoot]
          : openFolders
        : workspaceRoot
          ? [workspaceRoot]
          : [];
    return roots.map((folderPath) => {
      const ai = getAiProjectActivitySummary(folderPath);
      return {
        path: folderPath,
        running: run.hasRunningSessionsForRoot(folderPath) || hasAliveTermsForRoot(folderPath) || hasAiProjectActivity(folderPath),
        aiRunning: ai.running,
        aiQueued: ai.queued,
        aiExternal: ai.external,
        dirty: docs.hasDirtyForRoot(folderPath),
      };
    });
  }, [docs, openFolders, run, termRev, workspaceRoot, aiActiveProjects]);

  const openFile = useCallback(
    (entry: FsEntry) => {
      setActiveTab(`doc|${entry.path}`);
      void docs.open(entry.path);
    },
    [docs]
  );

  /** 从系统文件管理器拖到窗口上时的悬停提示；null 表示当前没在拖。 */
  const [dropHover, setDropHover] = useState<{
    pending: boolean;
    files: number;
    folders: number;
  } | null>(null);
  /**
   * 文件和文件夹一起放下时，先等新项目变成当前根再开文件。
   * 文档的所属根是打开那一刻读的，根还没切过去就会绑到旧项目上。
   */
  const pendingDropFiles = useRef<{ root: string; files: string[] } | null>(null);
  const dropGen = useRef(0);

  /** 拖进来的文件只在编辑区打开，不把所在目录收成项目。图片要先授父目录，预览才取得出来。 */
  const openDroppedFiles = useCallback(
    async (paths: string[]) => {
      await Promise.all(
        paths.map((path) => {
          const parent = parentPath(path);
          return parent ? allowAssetDir(parent).catch(() => {}) : Promise.resolve();
        })
      );
      for (const path of paths) {
        setActiveTab(`doc|${path}`);
        void docs.open(path);
      }
    },
    [docs, setActiveTab]
  );

  useEffect(() => {
    const pending = pendingDropFiles.current;
    if (!pending || !workspaceRoot || !samePath(workspaceRoot, pending.root)) return;
    pendingDropFiles.current = null;
    void openDroppedFiles(pending.files);
  }, [openDroppedFiles, workspaceRoot]);

  const openIncomingRef = useRef<(files: string[], folders: string[]) => void>(() => {});
  openIncomingRef.current = (files, folders) => {
    if (files.length === 0 && folders.length === 0) return;
    if (folders.length > 0) {
      const target = folders[folders.length - 1];
      for (const folder of folders) switchOrAddFolder(folder);
      if (files.length > 0) {
        if (workspaceRoot && samePath(workspaceRoot, target)) void openDroppedFiles(files);
        else pendingDropFiles.current = { root: target, files };
      }
      return;
    }
    void openDroppedFiles(files);
  };

  const acceptDropRef = useRef<(paths: string[]) => void>(() => {});
  acceptDropRef.current = (paths) => {
    void (async () => {
      let entries;
      try {
        entries = await statEntries(paths);
      } catch (cause) {
        reportError(errorText(cause));
        return;
      }
      const split = splitDrop(entries);
      openIncomingRef.current(split.files, split.folders);
    })();
  };

  const menuLabel = t("shellOpen.menu");
  const reportErrorRef = useRef(reportError);
  reportErrorRef.current = reportError;

  // 设置里的两个开关默认关。勾上才写资源管理器右键，关掉就删掉写过的键。
  useEffect(() => {
    if (!IS_WINDOWS || !("__TAURI_INTERNALS__" in window)) return;
    let cancelled = false;
    void applyShellIntegration({
      openFolder: settings.shell.openFolder,
      openFile: settings.shell.openFile,
      defaultFile: settings.shell.defaultFile,
      label: menuLabel,
      extraExtensions: settings.shell.extraExtensions,
    })
      .then((warning) => {
        // Win11 新菜单没装上时后端会退回经典动词，这里把原因说清楚，
        // 免得用户以为「打开开关了却没有菜单」。
        if (!cancelled && warning) reportErrorRef.current(errorText(warning));
      })
      .catch((cause) => {
        if (!cancelled) reportErrorRef.current(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [
    menuLabel,
    settings.shell.defaultFile,
    settings.shell.extraExtensions,
    settings.shell.openFile,
    settings.shell.openFolder,
  ]);

  // 资源管理器「通过 Forge 打开」带进来的路径：文件夹添加项目，文本文件暂时打开。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const pull = () => {
      void takeShellOpen()
        .then((plan) => {
          openIncomingRef.current(plan.files ?? [], plan.folders ?? []);
        })
        .catch(() => {});
    };
    pull();
    void listen("shell-open", () => {
      if (!disposed) pull();
    })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let webview;
    try {
      webview = getCurrentWebview();
    } catch {
      return;
    }
    void webview
      .onDragDropEvent((event) => {
        const payload = event.payload;
        const point = dropPosition(payload.type === "leave" ? { x: 0, y: 0 } : payload.position);
        // 悬停中的局部目标（聊天输入框）先认领；认领了就不显示整窗提示，也不打开文件。
        if (dispatchDrop(payload.type, "paths" in payload ? payload.paths : [], point.x, point.y)) {
          if (payload.type === "enter" || payload.type === "drop") {
            dropGen.current += 1;
            setDropHover(null);
          }
          return;
        }
        if (payload.type === "enter") {
          const gen = ++dropGen.current;
          setDropHover({ pending: true, files: 0, folders: 0 });
          void statEntries(payload.paths)
            .then((entries) => {
              if (disposed || dropGen.current !== gen) return;
              const split = splitDrop(entries);
              setDropHover({
                pending: false,
                files: split.files.length,
                folders: split.folders.length,
              });
            })
            .catch(() => {});
          return;
        }
        if (payload.type === "over") return;
        dropGen.current += 1;
        setDropHover(null);
        if (payload.type === "drop") acceptDropRef.current(payload.paths);
      })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /** markdown 预览里点本地链接：按类型开进编辑区（图片进预览，文本进编辑器）。 */
  const openLocalFile = useCallback(
    (absolute: string) => {
      setActiveTab(`doc|${absolute}`);
      void docs.open(absolute);
    },
    [docs]
  );

  const saveDoc = useCallback(
    async (path: string) => {
      const saved = await docs.save(path);
      // 存盘只动工作区内容，取一份变更清单就够；分支/标签/日志那几条留给显式刷新。
      // 这次刷新和写文件落在同一个仓库上，顺手把随后的 watcher 回声压掉。
      if (saved) {
        suppressGitEcho();
        void git.refreshChanges();
      }
    },
    [docs, git, suppressGitEcho]
  );

  const saveActive = useCallback(async () => {
    const path = docs.activePath;
    if (path && docs.dirty(path)) {
      await saveDoc(path);
      return;
    }
    await flushDirtyDocs();
  }, [docs, flushDirtyDocs, saveDoc]);

  /** 双栏拆分操作：支持向右拆分或向下拆分。 */
  const splitEditor = useCallback((id: string, direction: "horizontal" | "vertical") => {
    setEditorSplit({ direction, ratio: 50 });
    setSecondaryTab(id);
  }, []);

  const closeSplit = useCallback(() => {
    setEditorSplit(null);
    setSecondaryTab(null);
  }, []);

  /** 查看某文件的本地历史快照。 */
  const showLocalHistory = useCallback((path: string) => {
    const openDoc = docs.documents.find((d) => samePath(d.path, path));
    const name = path.split(/[\\/]/).pop() ?? path;
    if (openDoc) {
      setHistoryFile({
        path,
        name,
        language: openDoc.language,
        currentContent: openDoc.contents,
      });
    } else {
      void readFile(path)
        .then((fc) => {
          setHistoryFile({
            path,
            name,
            language: languageForPath(path, fc.contents),
            currentContent: fc.contents,
          });
        })
        .catch((cause: unknown) => reportError(errorText(cause)));
    }
  }, [docs.documents, reportError]);

  const onLocalHistoryRestored = useCallback((fc: FileContent) => {
    docs.applyDiskVersion(fc.path, fc);
    pushUpdateNotice("info", t("menu.localHistory"), t("history.reverted"));
  }, [docs, pushUpdateNotice, t]);

  // 窗口级 Ctrl+S / Cmd+S：焦点不在 Monaco 内（例如正看预览或点在侧栏/页签栏）时也能保存。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialog || menu || resolveOpen || everywhere) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveActive();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, everywhere, menu, resolveOpen, saveActive]);

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
      const targetKey = rootKeyRef.current;
      // 这几条串里都藏着路径：显示串拼着两条（`a → b`、`x ↔ y`），双文件比对还把两条路径写进了表头。
      // 逐段判：任一侧是图片或二进制，这次比对就没得比。
      const blocked = [base.path, base.leftLabel, base.rightLabel]
        .flatMap((text) => text.split(/\s*[→↔]\s*/))
        .map((piece) => docKindOf(piece))
        .find((kind) => !canDiff(kind));
      if (blocked) {
        // 存错误码原文，渲染时再翻；这样切语言时这句说明也跟着换。
        putDiff(
          {
            ...base,
            original: "",
            modified: "",
            notice: codedError(
              "NO_DIFF",
              base.path || `${base.leftLabel} → ${base.rightLabel}`,
              blocked
            ),
          },
          true,
          targetKey
        );
        return;
      }
      putDiff({ ...base, original: "", modified: "" }, true, targetKey);
      try {
        const sides = await load();
        putDiff({ ...base, original: sides.original, modified: sides.modified }, false, targetKey);
      } catch (cause) {
        closeDiff(base.id, targetKey);
        reportError(errorText(cause));
      }
    },
    [closeDiff, putDiff, reportError]
  );

  /** 工作区里那份文件现在的文本：编辑器里没存的改动比磁盘新，删掉了就是空。 */
  const worktreeText = useCallback(
    async (absolute: string, deleted: boolean) => {
      const openDoc = docs.documents.find((doc) => samePath(doc.path, absolute));
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
      getDiffChains().set(chainId, { kind: "change", staged, items: list });
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
          const openDoc = docs.documents.find((doc) => samePath(doc.path, absolute));
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
    [docs.dirty, docs.documents, getDiffChains, git, openDiffTab, t]
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
        getDiffChains().set(chainId, { kind: "against", chainId, revision, leftLabel, items: list });
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
    [getDiffChains, git, openDiffTab, t, worktreeText]
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
        getDiffChains().set(chainId, { kind: "commitFile", commit, items: list });
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
    [getDiffChains, git.root, openDiffTab]
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
        getDiffChains().set(chainId, { kind: "between", commit, parent, items: list });
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
    [getDiffChains, git, openDiffTab]
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
        suppressGitEcho();
        await git.refresh();
      } catch (cause) {
        reportError(errorText(cause));
      }
    },
    [git, refreshTree, reportError, suppressGitEcho, t]
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
        suppressGitEcho();
        void git.refreshChanges();
      }
    },
    [clipboard, git, refreshTree, reportError, suppressGitEcho]
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
      const list = chain ? getDiffChains().get(chain.id) : undefined;
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
    [diffs, getDiffChains, openAgainstWorktree, openBetweenRevisions, openChange, openCommitFile]
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
   * 提交树文件或目录菜单里要动编辑器、对话框或日志的动作。
   * 补丁取 HEAD 到工作区这一段：暂存过的路径工作区与索引同内容，范围一致。
   */
  const commitFileAction = useCallback(
    async (action: CommitFileAction, path: string, _staged: boolean, isDirectory = false) => {
      if (!git.root) return;
      const absolute = path ? git.absoluteOf(path) : "";
      switch (action) {
        case "editSource":
          editSource(path);
          break;
        case "patch":
          setDialog({
            kind: "patch",
            name: `${path ? patchStem(path) : basenameOf(git.root)}-worktree.patch`,
            path,
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
          showFileHistory(path);
          break;
        /*
         * 回滚把两件事合到一起：已跟踪文件的改动恢复成索引内容；新建、还没进过暂存区的新文件
         * 没有索引版本可恢复，它的回滚就是把这个文件移入回收站。后者会丢文件，所以先列成清单
         * 让用户确认一次，确认后删文件与恢复改动一起做完。
         */
        case "rollback": {
          const targets = rollbackTargets(path, isDirectory, git.trackedChanges, git.untrackedChanges);
          // 目录节点与仓库根都是聚合出来的，交给 git 的 pathspec 用 `.` 表示整个仓库根。
          const restore = path === "" ? "." : absolute;
          if (targets.delete.length === 0) {
            if (targets.restore) await git.restoreFile("", restore);
            break;
          }
          setDialog({
            kind: "rollback",
            name: basenameOf(targets.delete[0]),
            count: targets.delete.length,
            many: targets.delete.map((relative) => git.absoluteOf(relative)),
            fileList: targets.delete,
            restoreTracked: targets.restore,
            restore: targets.restore ? restore : undefined,
            entry: null,
            dir: null,
          });
          break;
        }
        case "ignore":
          await addToGitignore([isDirectory ? `${path.replace(/\/$/, "")}/` : path]);
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
          sole ? [{ label: t("menu.localHistory"), onSelect: () => showLocalHistory(sole.path) }] : [],
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
   * 选中一段文字后，Ctrl/Cmd+C 把这段文字写入系统剪贴板。
   *
   * 挂在捕获阶段：下面资源管理器那段冒泡监听会把同一次按键当成「复制文件」。
   * 输入框、Monaco 与终端的 textarea 不在这里处理，编辑和粘贴仍走原来的路。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const node = event.target instanceof HTMLElement ? event.target : null;
      const text = window.getSelection()?.toString() ?? "";
      if (
        !shouldCopyDomSelection(
          event,
          node ? { tagName: node.tagName, isContentEditable: node.isContentEditable } : null,
          text,
        )
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void navigator.clipboard.writeText(text).catch(() => {});
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

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
        // 页面上已有文字选区时，这次按键属于那段文字。捕获阶段会把 Ctrl+C 写入剪贴板；
        // 这里再让开一次，避免把目录树里选中的文件标成已复制或已剪切。
        if ((window.getSelection()?.toString() ?? "").length > 0) return;
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

  /** 已关闭的标签页要连 Monaco model 一起丢，否则内容留在内存里。支持单文件或被删目录下全部已打开文档清理。 */
  const dropDocument = useCallback(
    (targetPath: string) => {
      for (const doc of docs.documents) {
        if (samePath(doc.path, targetPath) || pathWithin(targetPath, doc.path)) {
          if (!docs.dirty(doc.path)) {
            disposeModel(doc.path);
            docs.close(doc.path);
          }
        }
      }
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

  /**
   * 一次删一批路径：去重、剔掉被父目录覆盖的子项，再走一遍带进度的删除，最后刷新文件树与变更清单。
   * 目录树的删除与 Git 面板「回滚」（未跟踪新文件的回滚就是删除）都落在这里。
   */
  const deleteTargets = useCallback(
    async (rawTargets: string[]) => {
      // 若多选中同时包含父目录与该目录下的子项，过滤掉已被父目录覆盖的子路径，避免父目录删完后再删子项报 NotFound。
      // 注意：去重与父子包含判断必须使用 samePath，避免 Windows 大小写异构导致同一路径互相排除变为空数组。
      const targets = rawTargets.filter(
        (target, idx) =>
          rawTargets.findIndex((t) => samePath(t, target)) === idx &&
          !rawTargets.some((other) => !samePath(other, target) && pathWithin(other, target))
      );
      if (targets.length === 0) return;
      if (deleteStatusTimerRef.current !== null) {
        window.clearTimeout(deleteStatusTimerRef.current);
        deleteStatusTimerRef.current = null;
      }
      if (deleteModalDelayRef.current !== null) {
        window.clearTimeout(deleteModalDelayRef.current);
        deleteModalDelayRef.current = null;
      }
      fsDeletingRef.current = true;
      deleteBaseCountRef.current = 0;
      deleteCurrentTargetCountRef.current = 0;
      const showModalImmediately = targets.length > 1;
      setDeleteStatus({
        phase: "deleting",
        name: basenameOf(targets[0]),
        deletedCount: 0,
        current: 1,
        total: targets.length,
        modalVisible: showModalImmediately,
      });
      // 参照 IDEA `ProgressWindow.DEFAULT_PROGRESS_DELAY_MILLIS`：单条目若在 180ms 内秒删完则不闪模态框，
      // 删大目录耗时超过阈值时自动弹出居中模态进度框。
      if (!showModalImmediately) {
        deleteModalDelayRef.current = window.setTimeout(() => {
          deleteModalDelayRef.current = null;
          setDeleteStatus((prev) =>
            prev && prev.phase === "deleting" ? { ...prev, modalVisible: true } : prev
          );
        }, 180);
      }
      let completed = false;
      try {
        for (let i = 0; i < targets.length; i++) {
          const target = targets[i];
          deleteCurrentTargetCountRef.current = 0;
          setDeleteStatus((prev) => ({
            phase: "deleting",
            name: basenameOf(target),
            deletedCount: deleteBaseCountRef.current,
            current: i + 1,
            total: targets.length,
            modalVisible: prev?.modalVisible ?? showModalImmediately,
          }));
          await deleteEntry(target);
          deleteBaseCountRef.current += Math.max(1, deleteCurrentTargetCountRef.current);
          dropDocument(target);
        }
        setExplorerPick([]);
        completed = true;
      } finally {
        fsDeletingRef.current = false;
        suppressWatchUntilRef.current = Date.now() + 500;
        if (deleteModalDelayRef.current !== null) {
          window.clearTimeout(deleteModalDelayRef.current);
          deleteModalDelayRef.current = null;
        }
        if (!completed) {
          setDeleteStatus(null);
        }
      }
      refreshTree();
      void git.refreshChanges();
      if (completed) {
        const finalDeletedCount = Math.max(targets.length, deleteBaseCountRef.current);
        setDeleteStatus({
          phase: "done",
          name: basenameOf(targets[0]),
          deletedCount: finalDeletedCount,
          current: targets.length,
          total: targets.length,
          modalVisible: false,
        });
        deleteStatusTimerRef.current = window.setTimeout(() => {
          deleteStatusTimerRef.current = null;
          setDeleteStatus(null);
        }, 2400);
      }
    },
    [deleteEntry, dropDocument, git.refreshChanges, refreshTree]
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
          // 新建文件后立即切到新文件的页签并打开。
          setActiveTab(`doc|${created.path}`);
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
          // 目录树可以多选一起删，提交树那边只给一条绝对路径。
          await deleteTargets(
            dialog.many ?? [entry?.path ?? path].filter((held): held is string => held !== undefined)
          );
        }
        /*
         * 回滚：先删掉未跟踪的新文件（走同一套删除流程，进系统回收站），再恢复已跟踪的改动。
         * 用户取消确认框的话，两件事都不做——半途恢复改动会让「取消」变得说不清。
         */
        if (kind === "rollback") {
          await deleteTargets(dialog.many ?? []);
          if (dialog.restore) await git.restoreFile("", dialog.restore);
        }
        if (kind === "discard" && path) {
          disposeModel(path);
          docs.close(path);
          const queued = closeQueue.current;
          closeQueue.current = [];
          if (queued.length > 0) closeBatch(queued);
        }
        if (kind === "closeRoot" && path) {
          await performCloseRoot(path);
          return;
        }
        if (kind === "restartUpdate") {
          // 装的是缓存里那一版，延后过也不会重下；Windows 上安装器接管后就不会往下走，
          // 后面这句只给 macOS / Linux 用。
          const updates = settings.updates;
          await installReadyUpdate(name, {
            proxyUrl: updates.proxyEnabled ? updates.proxyUrl : undefined,
          });
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
    [
      closeBatch,
      deleteTargets,
      dialog,
      docs,
      dropDocument,
      git,
      performCloseRoot,
      refreshTree,
      remember,
      reportError,
      settings,
      t,
      workspaceRoot,
    ]
  );

  /**
   * 页签栏上的全部标签：当前激活根的文档、比对、工具窗口、设置，按这个次序排。
   *
   * 这一份必须按身份留住：下面 `tabs` 那一步是「按顺序去目录里找」，两边都进来
   * 就是标签数平方量级的比较，而 App 每渲染一次（打字、轮询、拖动松手）都走一趟。
   * 顺带把 `docs.dirty(path)` 换成直接比这两份文本——那个函数内部就是做一次线性找。
   */
  const tabCatalog: TabItem[] = useMemo(
    () => [
    ...visibleDocs.map((doc) => ({
      id: `doc|${doc.path}`,
      kind: "doc" as const,
      name: doc.name,
      title: doc.path,
      filePath: doc.path,
      dirty: doc.contents !== doc.baseline,
      icon: <EntryIcon name={doc.name} path={doc.path} size={13} />,
    })),
    ...diffs.map((tab) => ({
      id: `diff|${tab.id}`,
      kind: "diff" as const,
      name: tab.name,
      title: tab.path,
      filePath: tab.openIn,
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
    ...aiSessions.sessions.filter((session) => aiSessions.openIds.includes(session.id)).map((session) => ({
      id: `ai|${session.id}`,
      kind: "ai" as const,
      name: session.title,
      title: `${AI_NAMES[session.provider]} · ${session.title}`,
      dirty: false,
      icon: <AiProviderIcon provider={session.provider} size={14} />,
    })),
    ...(aiDraftOpen[rootKey] && settings.aiAssistantsEnabled
      ? [
          {
            id: "ai|draft",
            kind: "ai" as const,
            name: t("ai.newSession"),
            title: t("ai.newSession"),
            dirty: false,
            icon: <SquarePen size={14} className="entry-icon" aria-hidden="true" />,
          },
        ]
      : []),
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
    [aiSessions.sessions, aiSessions.openIds, aiDraftOpen[rootKey], settings.aiAssistantsEnabled, diffs, places, runConfigsTab, settingsTab, t, visibleDocs]
  );

  // 栏上有哪些标签由上面那份目录说，排在哪儿由 tabOrder 说：新开一颗落在当前这颗右边，拖动改这个数组。
  const catalogKey = useMemo(() => tabCatalog.map((tab) => tab.id).join("\n"), [tabCatalog]);
  /** 上一次活跃的那颗；新开的标签插到它右边，而不是统统追加到末尾。 */
  const prevActiveTab = useRef<string | null>(null);
  const prevRootKeyRef = useRef(rootKey);
  useEffect(() => {
    const ids = catalogKey ? catalogKey.split("\n") : [];
    const rootSwitched = prevRootKeyRef.current !== rootKey;
    prevRootKeyRef.current = rootKey;
    setTabOrder((current) => {
      const kept = current.filter((id) => ids.includes(id));
      const added = ids.filter((id) => !kept.includes(id));
      if (kept.length === current.length && added.length === 0) return current;
      const anchor = rootSwitched ? activeTab : prevActiveTab.current;
      const at = kept.indexOf(anchor ?? "");
      const next = [...kept];
      added.forEach((id, offset) => next.splice((at < 0 ? next.length : at + 1) + offset, 0, id));
      return next;
    });
    prevActiveTab.current = activeTab;
  }, [catalogKey, activeTab, rootKey, setTabOrder]);

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
    // 兼容 Windows 盘符大小写差异：若目标文档已在目录中但路径大小写不同，对齐到目录中的真实标签 id。
    if (activeTab.startsWith("doc|")) {
      const targetPath = activeTab.slice(4);
      const matched = tabCatalog.find(
        (tab) => tab.kind === "doc" && samePath(tab.id.slice(4), targetPath)
      );
      if (matched) {
        setActiveTab(matched.id);
        return;
      }
    }
    setActiveTab(tabs[tabs.length - 1]?.id ?? null);
  }, [activeTab, setActiveTab, tabCatalog, tabs]);

  const selectTab = useCallback(
    (id: string) => {
      setActiveTab(id);
      if (id.startsWith("doc|")) docs.setActivePath(id.slice(4));
      // 已打开的 AI 标签再次被选中也要更新持久化活动项，不能只在首次 open 时记录；
      // 草稿标签背后没有会话，只切换显示。
      else if (id.startsWith("ai|") && id !== "ai|draft") dispatchAiSession({ type: "open", id: id.slice(3) });
    },
    [docs, dispatchAiSession]
  );

  /**
   * 关一颗标签：文档先问没保存的改动，面板那颗只是最小化，比对和整页那两类直接收。
   *
   * AI 标签特殊：可能还有任务在跑，交给 `closeSession` 先问「后台继续 / 停止并关闭」，
   * 只有用户选完才真正把标签从状态里摘掉。
   */
  const closeTab = useCallback(
    (id: string, kind: TabKind) => {
      if (kind === "doc") closeDocTab(id.slice(4));
      else if (kind === "diff") closeDiff(id.slice(5));
      else if (kind === "pane") hidePane(id.slice(5) as BottomPane);
      // 草稿标签背后没有会话也没有任务，直接收掉即可。
      else if (id === "ai|draft") setAiDraftOpen((current) => ({ ...current, [rootKeyRef.current]: false }));
      else if (kind === "ai") aiLifecycle.closeSession(id.slice(3), () => dispatchAiSession({ type: "close", id: id.slice(3) }));
      else if (id === "run-configs") setRunConfigsTab(false);
      else setSettingsTab(false);
    },
    [closeDiff, closeDocTab, hidePane, dispatchAiSession, aiLifecycle.closeSession]
  );

  /**
   * 批量关闭：脏文档一次只问一遍，靠的就是 closeBatch 那条队列。
   * AI 标签逐个走 `closeSession`，各自判断是否还有任务在跑。
   */
  const dropTabs = useCallback(
    (list: TabItem[]) => {
      for (const tab of list) {
        if (tab.kind === "pane") hidePane(tab.id.slice(5) as BottomPane);
        else if (tab.id === "ai|draft") setAiDraftOpen((current) => ({ ...current, [rootKeyRef.current]: false }));
        else if (tab.kind === "ai") aiLifecycle.closeSession(tab.id.slice(3), () => dispatchAiSession({ type: "close", id: tab.id.slice(3) }));
        else if (tab.kind === "settings") {
          if (tab.id === "run-configs") setRunConfigsTab(false);
          else setSettingsTab(false);
        } else if (tab.kind === "diff") closeDiff(tab.id.slice(5));
      }
      closeBatch(list.filter((tab) => tab.kind === "doc").map((tab) => tab.id.slice(4)));
    },
    [closeBatch, closeDiff, hidePane, dispatchAiSession, aiLifecycle.closeSession]
  );

  const closeOtherTabs = useCallback(
    (id: string) => dropTabs(tabs.filter((tab) => tab.id !== id)),
    [dropTabs, tabs]
  );

  const closeAllTabs = useCallback(() => dropTabs(tabs), [dropTabs, tabs]);

  /** 设置从页签栏进：已经开着就跳到它，否则新开一页。 */
  const openSettingsTab = useCallback((module: unknown = "general") => {
    setSettingsModule(typeof module === "string" ? (module as SettingsModule) : "general");
    setSettingsTab(true);
    setActiveTab("settings");
  }, []);

  /** 编辑程序配置也从页签栏进：开着就跳过去，没开就新添一页。 */
  const openRunConfigsTab = useCallback(() => {
    setRunConfigsTab(true);
    setActiveTab("run-configs");
  }, []);

  const terminalPlacement = (docked: boolean) => ({
    docked,
    toggle: () => (docked ? tabPane("terminal") : dockPane("terminal")),
  });

  const paneBody = (key: BottomPane, docked: boolean) =>
    key === "terminal" ? (
      <TerminalPane
        ref={terminalApi}
        cwd={workspaceRoot}
        dark={resolved === "dark"}
        placement={terminalPlacement(docked)}
      />
    ) : key === "run" ? (
      <RunPane run={run} dark={resolved === "dark"} onOpenFile={terminalOpenFile} />
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
        key={workspaceRoot ?? ""}
        git={git}
        reportError={reportError}
        onFileAction={logFileAction}
        onCompareWork={logCompareWork}
        onEditSource={logEditSource}
        onRefAction={logRefAction}
        onCommitAction={logCommitAction}
        onCompareCommits={logCompareCommits}
        options={settings.branches}
        onOptions={logOptions}
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
      className={docked ? "bottom-panel island" : "pane-body"}
      // 只有停在底部的那块归分割条管，挪进页签栏的那块没有可调的边。
      ref={docked ? bottomPanelRef : null}
      style={docked ? { height: bottomHeight } : undefined}
    >
      <header className="tool-window-head">
        <span className="tool-window-title">{t(BOTTOM_LABEL[key])}</span>
        {/* 运行面板照 IDEA：会话页签跟在标题同一行，动作另起第二行。 */}
        {key === "run" ? <RunSessionTabs run={run} /> : null}
        {/* 终端同理：页签 + `+` + `⌄` 都在标题行里。 */}
        {key === "terminal" ? (
          <TerminalTabs cwd={workspaceRoot} placement={terminalPlacement(docked)} />
        ) : null}
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
        {key === "run" && run.notice ? (
          <span className="run-status">
            {run.activeRunning ? <span className="run-dot is-running" aria-hidden="true" /> : null}
            {run.notice}
          </span>
        ) : null}
        {/* 底部一次只见一块，切到选项卡才谈得上几块并存；反过来就是切回底部。 */}
        <button
          type="button"
          className="icon-button is-inline"
          onClick={() => (docked ? tabPane(key) : dockPane(key))}
          title={t(
            key === "notifications"
              ? "tool.showOnSide"
              : docked
                ? "tool.showAsTab"
                : "tool.showDocked",
          )}
        >
          {docked ? (
            <Maximize2 size={15} />
          ) : key === "notifications" ? (
            <PanelRight size={15} />
          ) : (
            <PanelBottom size={15} />
          )}
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
          <Suspense fallback={null}>{paneBody(key, docked)}</Suspense>
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
        const virtual = joinPath(git.root, `${left.short}..${right.short}.diff`);
        setActiveTab(`doc|${virtual}`);
        docs.openVirtual(virtual, text, "diff");
      } catch (cause) {
        reportError(errorText(cause));
      }
    },
    [docs, git.root, reportError, setActiveTab]
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

  /**
   * 递给 memo 过的三块面板（目录树 / 提交 / 日志）的回调。
   *
   * 正文就存在这一层的 `docs` 状态里，敲一个字整棵组件树就重渲染一次；那些回调
   * 每次渲染都是新箭头（或闭住了每次都换身份的 `docs`），直接递过去浅比较第一关
   * 就过不去，memo 等于没装。`useStable` 把引用钉住，里面照常读最新那份文档与仓库，
   * 行为一点没变。
   */
  const treeOpenFile = useStable(openFile);
  const treeContextMenu = useStable(requestMenu);
  const panelOpenChange = useStable(openChange);
  const panelOpenFile = useStable((path: string) => {
    setActiveTab(`doc|${path}`);
    void docs.open(path);
  });
  /** 终端里点中的文件路径：带行号就跳过去，和搜索命中同一条路。 */
  const terminalOpenFile = useStable((path: string, line?: number, column?: number) => {
    setActiveTab(`doc|${path}`);
    const opened = line ? docs.openHit(path, line, column) : docs.open(path);
    void opened.catch((cause: unknown) => reportError(errorText(cause)));
  });
  /** AI 回复里点中的文件路径：相对路径按工程根还原，带行号就跳过去。 */
  const aiOpenFile = useStable((path: string, line?: number, column?: number) => {
    const resolved = resolveFileLink({ path, line, column }, workspaceRoot);
    if (!resolved) return;
    setActiveTab(`doc|${resolved}`);
    const opened = line ? docs.openHit(resolved, line, column) : docs.open(resolved);
    void opened.catch((cause: unknown) => reportError(errorText(cause)));
  });
  const panelOpenSource = useStable((change: GitChange) => {
    const absolute = git.absoluteOf(change.path);
    setActiveTab(`doc|${absolute}`);
    void docs.open(absolute);
  });
  const panelFileAction = useStable(commitFileAction);
  const panelCommitted = useStable((message: string) => remember("commitMessages", message));
  const panelUnignore = useStable((relative: string) => void removeFromGitignore(relative));
  const panelOpenCommitFile = useStable((revision: string, file: GitCommitFile) => {
    if (!git.root) return;
    void gitCommitDetail(git.root, revision)
      .then((detail) => openCommitFile(detail, file, false))
      .catch((cause: unknown) => reportError(errorText(cause)));
  });
  const panelToggleIgnored = useStable(() =>
    setCommitView((current) => ({ ...current, ignored: !current.ignored }))
  );
  const panelToggleByDir = useStable(() =>
    setCommitView((current) => ({ ...current, byDir: !current.byDir }))
  );
  const panelToggleByModule = useStable(() =>
    setCommitView((current) => ({ ...current, byModule: !current.byModule }))
  );
  const panelOpenResolve = useStable(() => setResolveOpen(true));
  const panelOpenAiSettings = useStable(() => openSettingsTab("aiCommit"));
  const logFileAction = useStable(fileAction);
  const logCompareWork = useStable(compareWork);
  const logEditSource = useStable(editSource);
  const logRefAction = useStable(refAction);
  const logCommitAction = useStable((action: CommitAction, commit: GitCommitInfo) =>
    void commitAction(action, commit)
  );
  const logCompareCommits = useStable((left: GitCommitInfo, right: GitCommitInfo) =>
    void compareCommits(left, right)
  );
  const logOptions = useStable((next: BranchSettings) => patch({ branches: next }));
  const closeActiveDiff = useStable(() => {
    if (activeDiffTab) closeDiff(activeDiffTab.id);
  });
  /** 比对链那一组按钮的容器：每次现造对象同样会顶穿 memo，跟着这一份留住。 */
  const activeDiffGroup = useMemo(
    () => (activeDiffTab ? diffGroupOf(activeDiffTab) : undefined),
    [activeDiffTab, diffGroupOf]
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
            mode={settings.workspaceMode}
            openFolders={folderStatusList}
            recent={history.recentFolders}
            onOpenFolder={() => void openFolder()}
            onPick={switchOrAddFolder}
            onCloseFolder={(path) => void requestCloseRoot(path)}
            onRemoveRecent={(path) => forget("recentFolders", path)}
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
          <nav className="activity-rail" aria-label={t("panel.explorer")}>
            {([...(settings.aiAssistantsEnabled ? ["ai" as const] : []), "explorer", "git"] as Panel[]).map((key) => {
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
                  {key === "explorer" ? <ProjectIcon size={18} /> : key === "ai" ? <Sparkles size={18} /> : <CommitIcon size={18} />}
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
              const hasRunning =
                key === "run" && run.sessions.some((session) => session.status === "running");
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
                  {/* 照 IDEA 工具窗口栏：当前工程有运行中的会话时，运行图标右下角亮绿点。 */}
                  {hasRunning ? <span className="rail-dot" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </nav>

        <div className="workbench-column">
          <div className="workbench-row">
          {sidebarOpen ? (
            <section
              className="tool-window"
              ref={sidePanelRef}
              style={{ width: sidebarWidth }}
            >
              <header className={`tool-window-head${panel === "ai" ? " ai-sessions-head" : ""}`}>
                <span className="tool-window-title" title={panel === "ai" ? t("ai.title") : undefined}>
                  {panel === "explorer" ? t("panel.project") : t(RAIL_LABEL[panel])}
                </span>
                <span className="status-spacer" />
                {panel === "ai" && settings.aiAssistantsEnabled ? (
                  <AiSessionsToolbar key={rootKey} onSettings={() => openSettingsTab("aiCli")} />
                ) : null}
                {panel === "explorer" && workspaceRoot ? (
                  <>
                    <button
                      type="button"
                      className="icon-button is-inline is-hover"
                      onClick={() => setDialog({ kind: "newFile", name: "untitled.txt", dir: workspaceRoot, entry: null })}
                      title={t("action.newFile")}
                    >
                      <FilePlus size={16} />
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
                      <FolderPlus size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-button is-inline is-hover"
                      onClick={() => setCollapseSignal((signal) => signal + 1)}
                      title={t("tool.collapseAll")}
                    >
                      <ListTree size={16} />
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
                      <RefreshCw size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-button is-inline"
                      disabled={locatePath === null}
                      onClick={() => {
                        if (locatePath) revealInTree(locatePath);
                      }}
                      title={t("menu.locateInSidebar")}
                    >
                      <LocateFixed size={16} />
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
                      <Settings size={16} />
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
                  <PanelLeftClose size={16} />
                </button>
              </header>

              <div className="panel-body">
                <ErrorBoundary label={t(RAIL_LABEL[panel])} onError={reportError}>
                {panel === "explorer" ? (
                  workspaceRoot ? (
                    <ExplorerTree
                      root={workspaceRoot}
                      repoRoot={git.root}
                      changes={git.status?.changes ?? EMPTY_CHANGES}
                      collapseSignal={collapseSignal}
                      refresh={treeRefresh}
                      reveal={treeReveal}
                      showIgnored={settings.explorer.showIgnored}
                      showHidden={settings.explorer.showHidden}
                      openRoots={watchedRoots}
                      picked={explorerPickedPaths}
                      onPick={setExplorerPick}
                      onOpenFile={treeOpenFile}
                      onContextMenu={treeContextMenu}
                    />
                  ) : (
                    <div className="tool-window-empty">
                      <p>{t("explorer.noFolder")}</p>
                    </div>
                  )
                ) : panel === "ai" ? (
                  settings.aiAssistantsEnabled ? <AiSessionsPanel
                    key={rootKey}
                    sessions={aiSessions.sessions}
                    openIds={aiSessions.openIds}
                    activeId={activeTab}
                    storageError={aiSessions.storageError}
                    workspace={workspaceRoot}
                    onOpen={openAiSession}
                    onNew={openAiDraft}
                    // 重命名/删除可能要先停掉在跑的任务，归档与搜索按项目归属，统一交给生命周期钩子处理。
                    onAction={(action) => void aiLifecycle.act(action, workspaceRoot, dispatchAiSession)}
                  /> : null
                ) : workspaceRoot ? (
                  <Suspense fallback={null}>
                    <GitPanel
                      key={workspaceRoot}
                      git={git}
                      workspaceRoot={workspaceRoot}
                      onOpenChange={panelOpenChange}
                      onOpenFile={panelOpenFile}
                      focusSignal={commitFocus}
                      rewordSignal={rewordSignal}
                      history={history.commitMessages}
                      onCommitted={panelCommitted}
                      groupByDir={commitView.byDir}
                      groupByModule={commitView.byModule}
                      showIgnored={commitView.ignored}
                      onToggleIgnored={panelToggleIgnored}
                      repoName={basenameOf(git.root ?? workspaceRoot)}
                      onFileAction={panelFileAction}
                      onUnignore={panelUnignore}
                      onOpenCommitFile={panelOpenCommitFile}
                      onToggleByDir={panelToggleByDir}
                      onToggleByModule={panelToggleByModule}
                      showOnDoubleClick={settings.commit.showOnDoubleClick}
                      commitAllWhenNothingStaged={settings.commit.commitAllWhenNothingStaged}
                      onOpenSource={panelOpenSource}
                      onOpenResolve={panelOpenResolve}
                      onOpenAiSettings={panelOpenAiSettings}
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
          <div className="editor-stack">
          <main className="editor-region island">
            {editorSplit ? (
              <div
                className={`editor-split-container is-${editorSplit.direction}`}
                ref={splitContainerRef}
              >
                <div
                  className="editor-split-pane is-primary"
                  style={
                    editorSplit.direction === "horizontal"
                      ? { width: `${editorSplit.ratio}%`, flex: "none" }
                      : { height: `${editorSplit.ratio}%`, flex: "none" }
                  }
                >
                  {tabs.length > 0 ? (
                    <EditorTabs
                      tabs={tabs}
                      activeId={activeTab}
                      onSelect={selectTab}
                      onReorder={reorderTab}
                      onClose={closeTab}
                      onCloseOthers={closeOtherTabs}
                      onCloseAll={closeAllTabs}
                      onSave={(path) => void saveDoc(path)}
                      onSaveAll={() => void flushDirtyDocs()}
                      isDirty={docs.dirty}
                      onRevealInSidebar={revealInTree}
                      onSplitRight={(id) => splitEditor(id, "horizontal")}
                      onSplitDown={(id) => splitEditor(id, "vertical")}
                      onCloseSplit={closeSplit}
                      isSplit={true}
                      onShowLocalHistory={showLocalHistory}
                    />
                  ) : null}
                  <div className="editor-pane-body">
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
                            group={activeDiffGroup}
                            landOn={activeDiffTab.landOn}
                            onOpenFile={diffOpenFile}
                            onClose={closeActiveDiff}
                          />
                        ) : activePane && places[activePane] === "tabbed" ? (
                          paneFrame(activePane, false)
                        ) : activeTab === "run-configs" ? (
                          <RunConfigsPage configs={configs} />
                        ) : activeTab === "ai|draft" ? (
                          // 新建会话草稿页：会话还不存在，首条消息发出时才创建并切到会话页。
                          <Suspense fallback={null}>
                            <AiWelcomePane workspace={workspaceRoot} beforeSend={beforeAiSend} onLaunch={launchAiDraft} onSettings={() => openSettingsTab("aiCli")} />
                          </Suspense>
                        ) : activeAiSession ? (
                          // key 绑会话 id：切到另一个会话时必须整块重建，否则输入框草稿、
                          // 展开状态和本地事件订阅会串到新会话上。
                          <AiSessionPane key={activeAiSession.id} session={activeAiSession} workspace={workspaceRoot} beforeSend={beforeAiSend} onSettings={() => openSettingsTab("aiCli")} onNew={openAiDraft} onOpenFile={aiOpenFile} onAction={(action) => void aiLifecycle.act(action, workspaceRoot, dispatchAiSession)} />
                        ) : activeTab === "settings" ? (
                          <SettingsPage
                            workspace={workspaceRoot}
                            initialModule={settingsModule}
                            onLspKick={() => setLspKick((value) => value + 1)}
                            onLspWake={wakeLspServer}
                          />
                        ) : activeDoc ? (
                          <DocPane
                            document={activeDoc}
                            onChange={docs.update}
                            onSave={() => void saveActive()}
                            onBlur={() => {
                              if (settings.editor.savePolicy === "blur") void saveAllRef.current();
                            }}
                            onView={docs.setView}
                            onOpenLocal={openLocalFile}
                            reveal={docs.reveal}
                            onRevealDone={docs.revealDone}
                            runConfigs={configs.configs}
                            projectRoot={workspaceRoot ?? ""}
                            openPaths={docs.documents.map((item) => item.path)}
                            onRunConfig={(picked) => {
                              if (picked.length > 1) {
                                configs.select(picked[0].id);
                                setRunChooser((signal) => signal + 1);
                                return;
                              }
                              configs.select(picked[0].id);
                              run.start(picked[0]);
                              focusPane("run");
                            }}
                            onRunScript={runScript}
                            onRunHttp={runHttp}
                            httpResponse={
                              settings.httpResponse === "split" &&
                              httpSide !== null &&
                              samePath(httpSide.path, activeDoc.path)
                                ? httpSide.text
                                : null
                            }
                            changeBaseline={changeBaseline}
                          />
                        ) : (
                          <WelcomeScreen
                            keymap={settings.editor.keymap}
                            workspace={workspaceRoot !== null}
                          />
                        )}
                      </Suspense>
                    </ErrorBoundary>
                  </div>
                </div>

                <div
                  role="separator"
                  aria-orientation={editorSplit.direction === "horizontal" ? "vertical" : "horizontal"}
                  className={`editor-split-divider is-${editorSplit.direction}`}
                  title={t("preview.splitResetTip")}
                  onDoubleClick={() => setEditorSplit((prev) => prev ? { ...prev, ratio: 50 } : null)}
                  onPointerDown={(event) => {
                    if (!splitContainerRef.current) return;
                    const rect = splitContainerRef.current.getBoundingClientRect();
                    splitDragRef.current = {
                      startX: event.clientX,
                      startY: event.clientY,
                      startRatio: editorSplit.ratio,
                      totalWidth: rect.width,
                      totalHeight: rect.height,
                    };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    const drag = splitDragRef.current;
                    if (!drag) return;
                    if (editorSplit.direction === "horizontal") {
                      if (drag.totalWidth <= 0) return;
                      const deltaRatio = ((event.clientX - drag.startX) / drag.totalWidth) * 100;
                      const next = Math.max(20, Math.min(80, drag.startRatio + deltaRatio));
                      setEditorSplit((prev) => prev ? { ...prev, ratio: next } : null);
                    } else {
                      if (drag.totalHeight <= 0) return;
                      const deltaRatio = ((event.clientY - drag.startY) / drag.totalHeight) * 100;
                      const next = Math.max(20, Math.min(80, drag.startRatio + deltaRatio));
                      setEditorSplit((prev) => prev ? { ...prev, ratio: next } : null);
                    }
                  }}
                  onPointerUp={() => {
                    splitDragRef.current = null;
                  }}
                />

                <div
                  className="editor-split-pane is-secondary"
                  style={
                    editorSplit.direction === "horizontal"
                      ? { width: `${100 - editorSplit.ratio}%`, flex: "none" }
                      : { height: `${100 - editorSplit.ratio}%`, flex: "none" }
                  }
                >
                  {tabs.length > 0 ? (
                    <EditorTabs
                      tabs={tabs}
                      activeId={secondaryTab}
                      onSelect={(id) => setSecondaryTab(id)}
                      onReorder={reorderTab}
                      onClose={(id, kind) => {
                        if (id === secondaryTab) closeSplit();
                        else closeTab(id, kind);
                      }}
                      onCloseOthers={closeOtherTabs}
                      onCloseAll={closeAllTabs}
                      onSave={(path) => void saveDoc(path)}
                      onSaveAll={() => void flushDirtyDocs()}
                      isDirty={docs.dirty}
                      onRevealInSidebar={revealInTree}
                      onCloseSplit={closeSplit}
                      isSplit={true}
                      onShowLocalHistory={showLocalHistory}
                    />
                  ) : null}
                  <div className="editor-pane-body">
                    <ErrorBoundary label={t("editor.region")} onError={reportError}>
                      <Suspense fallback={null}>
                        {secondaryActiveDiffTab ? (
                          <DiffPane
                            leftLabel={secondaryActiveDiffTab.leftLabel}
                            rightLabel={secondaryActiveDiffTab.rightLabel}
                            path={secondaryActiveDiffTab.path}
                            original={secondaryActiveDiffTab.original}
                            modified={secondaryActiveDiffTab.modified}
                            language={secondaryActiveDiffTab.language}
                            notice={
                              secondaryActiveDiffTab.notice
                                ? describeError(secondaryActiveDiffTab.notice, t)
                                : undefined
                            }
                            group={activeDiffGroup}
                            landOn={secondaryActiveDiffTab.landOn}
                            onOpenFile={diffOpenFile}
                            onClose={closeSplit}
                          />
                        ) : secondaryActiveDoc ? (
                          <DocPane
                            document={secondaryActiveDoc}
                            onChange={docs.update}
                            onSave={() => void saveDoc(secondaryActiveDoc.path)}
                            onBlur={() => {
                              if (settings.editor.savePolicy === "blur") void saveAllRef.current();
                            }}
                            onView={docs.setView}
                            onOpenLocal={openLocalFile}
                            reveal={null}
                            onRevealDone={() => {}}
                            runConfigs={configs.configs}
                            projectRoot={workspaceRoot ?? ""}
                            openPaths={docs.documents.map((item) => item.path)}
                            onRunConfig={(picked) => {
                              if (picked.length > 1) {
                                configs.select(picked[0].id);
                                setRunChooser((signal) => signal + 1);
                                return;
                              }
                              configs.select(picked[0].id);
                              run.start(picked[0]);
                              focusPane("run");
                            }}
                            onRunScript={runScript}
                            onRunHttp={runHttp}
                            httpResponse={
                              settings.httpResponse === "split" &&
                              httpSide !== null &&
                              samePath(httpSide.path, secondaryActiveDoc.path)
                                ? httpSide.text
                                : null
                            }
                            changeBaseline={secondaryChangeBaseline}
                          />
                        ) : (
                          <div className="tool-window-empty">
                            <p>{t("editor.selectToView")}</p>
                          </div>
                        )}
                      </Suspense>
                    </ErrorBoundary>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {tabs.length > 0 ? (
                  <EditorTabs
                    tabs={tabs}
                    activeId={activeTab}
                    onSelect={selectTab}
                    onReorder={reorderTab}
                    onClose={closeTab}
                    onCloseOthers={closeOtherTabs}
                    onCloseAll={closeAllTabs}
                    onSave={(path) => void saveDoc(path)}
                    onSaveAll={() => void flushDirtyDocs()}
                    isDirty={docs.dirty}
                    onRevealInSidebar={revealInTree}
                    onSplitRight={(id) => splitEditor(id, "horizontal")}
                    onSplitDown={(id) => splitEditor(id, "vertical")}
                    onShowLocalHistory={showLocalHistory}
                  />
                ) : null}
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
                        group={activeDiffGroup}
                        landOn={activeDiffTab.landOn}
                        onOpenFile={diffOpenFile}
                        onClose={closeActiveDiff}
                      />
                    ) : activePane && places[activePane] === "tabbed" ? (
                      paneFrame(activePane, false)
                    ) : activeTab === "run-configs" ? (
                      <RunConfigsPage configs={configs} />
                    ) : activeTab === "ai|draft" ? (
                      // 同上：多工作区分支里的草稿页。
                      <Suspense fallback={null}>
                        <AiWelcomePane workspace={workspaceRoot} beforeSend={beforeAiSend} onLaunch={launchAiDraft} onSettings={() => openSettingsTab("aiCli")} />
                      </Suspense>
                    ) : activeAiSession ? (
                      // 同上：多工作区分支里的这颗也要按会话 id 重建。
                      <AiSessionPane key={activeAiSession.id} session={activeAiSession} workspace={workspaceRoot} beforeSend={beforeAiSend} onSettings={() => openSettingsTab("aiCli")} onNew={openAiDraft} onOpenFile={aiOpenFile} onAction={(action) => void aiLifecycle.act(action, workspaceRoot, dispatchAiSession)} />
                    ) : activeTab === "settings" ? (
                      <SettingsPage
                        workspace={workspaceRoot}
                        initialModule={settingsModule}
                        onLspKick={() => setLspKick((value) => value + 1)}
                        onLspWake={wakeLspServer}
                      />
                    ) : activeDoc ? (
                      <DocPane
                        document={activeDoc}
                        onChange={docs.update}
                        onSave={() => void saveActive()}
                        onBlur={() => {
                          if (settings.editor.savePolicy === "blur") void saveAllRef.current();
                        }}
                        onView={docs.setView}
                        onOpenLocal={openLocalFile}
                        reveal={docs.reveal}
                        onRevealDone={docs.revealDone}
                        runConfigs={configs.configs}
                        projectRoot={workspaceRoot ?? ""}
                        openPaths={docs.documents.map((item) => item.path)}
                        onRunConfig={(picked) => {
                          if (picked.length > 1) {
                            configs.select(picked[0].id);
                            setRunChooser((signal) => signal + 1);
                            return;
                          }
                          configs.select(picked[0].id);
                          run.start(picked[0]);
                          focusPane("run");
                        }}
                        onRunScript={runScript}
                        onRunHttp={runHttp}
                        httpResponse={
                          settings.httpResponse === "split" &&
                          httpSide !== null &&
                          samePath(httpSide.path, activeDoc.path)
                            ? httpSide.text
                            : null
                        }
                        changeBaseline={changeBaseline}
                      />
                    ) : (
                      <WelcomeScreen
                        keymap={settings.editor.keymap}
                        workspace={workspaceRoot !== null}
                      />
                    )}
                  </Suspense>
                </ErrorBoundary>
              </>
            )}
          </main>
          {/* 底部工具窗口只占编辑区这一列，侧栏继续接到顶栏和底栏上。 */}
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
          {places.notifications === "docked" ? (
            <>
            <RightDockSplitter
              width={rightWidth}
              panelRef={rightPanelRef}
              dragRef={rightDrag}
              onCommit={setRightWidth}
            />
            <section
              ref={rightPanelRef}
              className="notify-pane island"
              style={{ width: rightWidth }}
              aria-label={t("notifications.title")}
            >
              <header className="tool-window-head">
                <span className="tool-window-title">{t("notifications.title")}</span>
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
                <span className="status-spacer" />
                <button
                  type="button"
                  className="icon-button is-inline"
                  onClick={() => tabPane("notifications")}
                  title={t("tool.showAsTab")}
                >
                  <Maximize2 size={15} />
                </button>
                <button
                  type="button"
                  className="icon-button is-inline"
                  onClick={() => hidePane("notifications")}
                  title={t("tool.minimize")}
                >
                  <Minus size={15} />
                </button>
              </header>
              <div className="bottom-body">
                <NotificationsView
                  notifications={notifications}
                  onRemoveItem={removeNotification}
                />
              </div>
            </section>
            </>
          ) : null}
          {places.notifications === "docked" ? null : (
          <MavenDock
            workspace={workspaceRoot}
            width={rightWidth}
            paneRef={rightPanelRef}
            dragRef={rightDrag}
            onWidth={setRightWidth}
            running={run.sessions.some(
              (session) => session.status === "running" && session.config.id.startsWith("maven-goal:"),
            )}
            onRun={(config) => {
              run.start(config);
              focusPane("run");
            }}
            onStop={() => {
              for (const session of run.sessions) {
                if (session.status === "running" && session.config.id.startsWith("maven-goal:")) {
                  run.stop(session.id);
                }
              }
            }}
            onOpenFile={(path) => {
              setActiveTab(`doc|${path}`);
              void docs.open(path);
            }}
          />
          )}
          </div>
        </div>
      </div>

      <footer className="global-status">
        {deleteStatus ? (
          <span
            className={`status-note is-delete-status is-${deleteStatus.phase}`}
            role="status"
            aria-live="polite"
          >
            {deleteStatus.phase === "deleting" ? (
              <span className="status-delete-spin is-spinning" aria-hidden="true">
                <RefreshCw size={11} />
              </span>
            ) : (
              <Check size={12} aria-hidden="true" />
            )}
            <span>
              {deleteStatus.phase === "deleting"
                ? `${t("explorer.progressDeleting")} · ${t("explorer.progressAlreadyDeleted", {
                    count: deleteStatus.deletedCount,
                  })}`
                : deleteStatus.deletedCount > 1
                  ? t("explorer.deletedMany", { count: deleteStatus.deletedCount })
                  : t("explorer.deletedOne", { name: deleteStatus.name })}
            </span>
          </span>
        ) : null}
        {activeDoc && workspaceRoot ? (
          <StatusBreadcrumb
            root={workspaceRoot}
            file={activeDoc.path}
            showHidden={settings.explorer.showHidden}
            onOpenFile={(path) => {
              setActiveTab(`doc|${path}`);
              void docs.open(path);
            }}
          />
        ) : (
          <span className="status-spacer" />
        )}
        {activeDoc ? (
          <>
            <span>{languageLabel(activeDoc.language)}</span>
            {/* 图片没有行尾这回事，那一格换成它的类型名。 */}
            {activeDoc.kind === "image" ? (
              <span>{t("preview.image")}</span>
            ) : (
              <span>{activeDoc.lineEnding.toUpperCase()}</span>
            )}
            {/* 不是 UTF-8 才占一格：中文老工程的 GBK 文件要让人看见存回什么编码。 */}
            {activeDoc.encoding === "gb18030" ? (
              <span title={t("status.encodingTip")}>{t("status.encoding")}</span>
            ) : null}
            {docs.dirty(activeDoc.path) ? (
              <button
                type="button"
                className="status-note status-dirty"
                onClick={() => void saveDoc(activeDoc.path)}
                title={`${t("editor.save")} (${MOD_LABEL}+S)`}
              >
                <Save size={12} aria-hidden="true" />
                {t("editor.dirty")}
              </button>
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
        {(git.status?.changes.length ?? 0) > 0 ? (
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
        <MavenStatus
          workspace={workspaceRoot}
          onWillOpen={() => {
            if (places.notifications === "docked") hidePane("notifications");
          }}
        />
        <NotificationBell
          notifications={notifications}
          active={places.notifications !== "hidden"}
          onClick={() => {
            if (places.notifications === "hidden") markAllNotificationsRead();
            railPane("notifications");
          }}
        />
      </footer>

      {/* IDEA 浮动通知气泡 (位置跟随 settings.notificationPosition，默认右下角；统一堆栈流防重叠) */}
      <NotificationToasts
        toasts={activeToasts}
        position={settings.notificationPosition}
        onDismiss={dismissToast}
      >
        {depSync.items.length > 0 ? (
          <DepSyncToast
            items={depSync.items}
            inline
            onSync={depSync.syncItem}
            onDismiss={depSync.dismissItem}
            onOpenManifest={openDepSyncManifest}
          />
        ) : null}
      </NotificationToasts>

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
      {termSessions().sessions.length > 0 ||
      places.terminal !== "hidden" ||
      activePane === "terminal" ? (
        <Suspense fallback={null}>
          <TerminalHost
            dark={resolved === "dark"}
            cwd={workspaceRoot}
            onOpenFile={terminalOpenFile}
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
      {/* 参照 IDEA `DeleteHandlerHelper.kt` + `ProgressDialogUI.kt`：居中模态删除进度框 */}
      {deleteStatus?.phase === "deleting" && deleteStatus.modalVisible ? (
        <div className="dialog-backdrop" role="presentation">
          <div
            className="dialog progress-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("explorer.progressDeleting")}
          >
            <p className="dialog-title">{t("explorer.progressDeleting")}</p>
            <p className="progress-dialog-text">
              {t("explorer.progressAlreadyDeleted", { count: deleteStatus.deletedCount })}
            </p>
            <div className="progress-dialog-bar" role="progressbar" aria-busy="true">
              <div className="progress-dialog-bar-indeterminate" />
            </div>
            <p className="progress-dialog-details" title={deleteStatus.name}>
              {deleteStatus.total > 1
                ? `(${deleteStatus.current}/${deleteStatus.total}) ${deleteStatus.name}`
                : deleteStatus.name}
            </p>
          </div>
        </div>
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
      {/* 保存撞上「磁盘被别处改过」时开这一层：本地 / 磁盘两份对着共同祖先摆，底下结果格可编辑。 */}
      {docs.conflict ? (
        <Suspense fallback={null}>
          <MergeConflictDialog
            key={`${docs.conflict.path}-${docs.conflict.diskMs}`}
            conflict={docs.conflict}
            onAcceptDisk={(disk) => docs.applyDiskVersion(docs.conflict!.path, disk)}
            onResolve={(result, disk) => void docs.resolveConflict(docs.conflict!.path, result, disk)}
            onCancel={docs.dismissConflict}
          />
        </Suspense>
      ) : null}
      {/* 本地历史时间线对话框 */}
      {historyFile && workspaceRoot ? (
        <Suspense fallback={null}>
          <LocalHistoryDialog
            root={workspaceRoot}
            path={historyFile.path}
            name={historyFile.name}
            language={historyFile.language}
            currentContent={historyFile.currentContent}
            onRestored={onLocalHistoryRestored}
            onClose={() => setHistoryFile(null)}
          />
        </Suspense>
      ) : null}
      {dropHover ? (
        <div className="drop-overlay" role="status">
          <div className="drop-overlay-card">
            {dropHover.folders > 0 && dropHover.files === 0 ? (
              <FolderPlus size={18} aria-hidden="true" />
            ) : (
              <FilePlus size={18} aria-hidden="true" />
            )}
            <span>
              {t(dropHintKey(dropHover.files, dropHover.folders, dropHover.pending), {
                count: dropHover.folders > 1 ? dropHover.folders : dropHover.files,
              })}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
