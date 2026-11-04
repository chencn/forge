import { invoke } from "@tauri-apps/api/core";
import { normalizeExtraExtensions } from "./shellWhitelist";
import type { ThemeMode } from "./window";
import type { Lang } from "../i18n";
import { normalizeProjectDirectoryRoles, type ProjectDirectoryRoles } from "./projectDirectoryRoles";

/** 内置快捷键方案，对应 `lib/cm/keymap.ts` 与 `lib/shortcuts.ts` 里的三套；默认 IDEA。 */
export type KeymapScheme = "idea" | "vscode" | "eclipse";

/** 三套方案的展示顺序；设置页下拉也按这个顺序排。 */
export const KEYMAP_SCHEMES: KeymapScheme[] = ["idea", "vscode", "eclipse"];

/** 把历史配置或脏数据收进三档：认不出的一律当默认 IDEA。 */
export function normalizeKeymapScheme(value: unknown): KeymapScheme {
  return value === "vscode" || value === "eclipse" ? value : "idea";
}

/** 代码保存策略：只手动存，还是失去焦点时自动存。 */
export type SavePolicy = "manual" | "blur";

/** 点关闭按钮做什么：收进托盘还是直接退应用。 */
export type CloseBehavior = "tray" | "quit";

/** 工作区模式：一个窗口同时常驻多个文件夹（multi），还是只留一个（single）。 */
export type WorkspaceMode = "multi" | "single";

/** HTTP 响应放哪：底部面板，或单独开一个页签。 */
export type HttpResponseLayout = "bottom" | "tab";

/** 编辑器偏好，对应 Rust `EditorSettings`。 */
export interface EditorSettings {
  /** 括号按嵌套深度上色（对标 IDEA 默认关）。 */
  rainbowBrackets: boolean;
  /** 正文字体族；空串跟随 `--font-mono`。 */
  fontFamily: string;
  /** 字号（px），编辑器与两个控制台共用。 */
  fontSize: number;
  /** 制表宽度。 */
  tabSize: number;
  /** 是否显示右侧缩略图。 */
  minimap: boolean;
  /** 快捷键方案。 */
  keymap: KeymapScheme;
  /** 保存策略。 */
  savePolicy: SavePolicy;
  /** 退出前是否把没保存的改动写回磁盘。 */
  saveOnExit: boolean;
  /** 保存时删除行尾空格和制表符。 */
  trimTrailingWhitespace: boolean;
  /** 保存时保证非空文本以换行结束。 */
  insertFinalNewline: boolean;
  /** 软换行（IDEA 默认关）。 */
  softWrap: boolean;
  /** 显示空白符（IDEA 默认关）。 */
  showWhitespace: boolean;
  /** 行高（px）；0 表示自动按字号 1.69 倍推导。 */
  lineHeight: number;
}

/** 终端光标形状。 */
export type TerminalCursorStyle = "bar" | "block" | "underline";

/** 终端偏好，对应 Rust `TerminalSettings`。 */
export interface TerminalSettings {
  /** 起终端用的 shell：`ShellInfo.id`（多数就是路径）；空串表示用 `shell_probe` 排在第一的那个。 */
  shell: string;
  /** 字号（px），和编辑器字号分开。 */
  fontSize: number;
  /** 字体；空串表示跟编辑器同一套等宽字体。 */
  fontFamily: string;
  /** 回滚行数。 */
  scrollback: number;
  cursorStyle: TerminalCursorStyle;
  /** 页签放标题行里，还是终端左侧一列。 */
  tabLayout: TerminalTabLayout;
  bell: TerminalBell;
  profiles: TerminalProfile[];
}

export type TerminalTabLayout = "horizontal" | "vertical";
/** 程序响铃时：闪一下并在页签上挂铃铛、再加一声提示音、或什么都不做。 */
export type TerminalBell = "visual" | "sound" | "none";

export interface TerminalEnvVar {
  key: string;
  value: string;
}

/** 终端配置档，对应 Rust `TerminalProfile`。 */
export interface TerminalProfile {
  id: string;
  name: string;
  /** `ShellInfo.id`；空串表示默认 shell。 */
  shell: string;
  /** 追加在 shell 自带参数后面。 */
  args: string[];
  /** 值为空表示把这个变量从继承的环境里摘掉。 */
  env: TerminalEnvVar[];
  /** 起始目录；相对路径按工作区根解析，空串就是工作区根。 */
  dir: string;
  /** shell 起来后自动敲进去的命令。 */
  command: string;
}

export const TERMINAL_FONT_SIZE_RANGE = { min: 8, max: 32 } as const;
export const TERMINAL_SCROLLBACK_RANGE = { min: 1_000, max: 100_000 } as const;
export const TERMINAL_CURSOR_STYLES: readonly TerminalCursorStyle[] = ["bar", "block", "underline"];
export const TERMINAL_TAB_LAYOUTS: readonly TerminalTabLayout[] = ["horizontal", "vertical"];
export const TERMINAL_BELLS: readonly TerminalBell[] = ["visual", "sound", "none"];

function normalizeProfile(raw: Partial<TerminalProfile> | null | undefined, index: number): TerminalProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    id: text(raw.id) || `profile-${index + 1}`,
    name: text(raw.name).trim() || `Profile ${index + 1}`,
    shell: text(raw.shell),
    args: Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === "string") : [],
    env: Array.isArray(raw.env)
      ? raw.env
          .filter((entry) => entry && typeof entry.key === "string")
          .map((entry) => ({ key: entry.key.trim(), value: text(entry.value) }))
          .filter((entry) => entry.key && !entry.key.includes("="))
      : [],
    dir: text(raw.dir).trim(),
    command: text(raw.command),
  };
}

function normalizeProfiles(raw: unknown): TerminalProfile[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: TerminalProfile[] = [];
  raw.forEach((item, index) => {
    const profile = normalizeProfile(item as Partial<TerminalProfile>, index);
    if (!profile || seen.has(profile.id)) return;
    seen.add(profile.id);
    out.push(profile);
  });
  return out;
}

function clampInt(value: unknown, range: { min: number; max: number }, fallback: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(range.max, Math.max(range.min, number));
}

/** 读进来的终端设置：越界的数值夹回范围，认不得的光标退回默认。 */
function normalizeTerminal(raw: Partial<TerminalSettings> | undefined): TerminalSettings {
  const base = DEFAULT_SETTINGS.terminal;
  return {
    shell: typeof raw?.shell === "string" ? raw.shell : base.shell,
    fontSize: clampInt(raw?.fontSize, TERMINAL_FONT_SIZE_RANGE, base.fontSize),
    fontFamily: typeof raw?.fontFamily === "string" ? raw.fontFamily.trim() : base.fontFamily,
    scrollback: clampInt(raw?.scrollback, TERMINAL_SCROLLBACK_RANGE, base.scrollback),
    cursorStyle: TERMINAL_CURSOR_STYLES.includes(raw?.cursorStyle as TerminalCursorStyle)
      ? (raw?.cursorStyle as TerminalCursorStyle)
      : base.cursorStyle,
    tabLayout: raw?.tabLayout === "vertical" ? "vertical" : "horizontal",
    bell: TERMINAL_BELLS.includes(raw?.bell as TerminalBell) ? (raw?.bell as TerminalBell) : base.bell,
    profiles: normalizeProfiles(raw?.profiles),
  };
}

/** 运行工具窗口偏好，对应 Rust `RunSettings`。 */
export interface RunSettings {
  /** 给每行输出盖一个收到时刻的时间戳；本来就带时间的行不动。 */
  timestamps: boolean;
}

/** 双击变更行打开什么：比对还是源文件。 */
export type DoubleClickTarget = "preview" | "source";
/** 提交工具窗口偏好，对应 Rust `CommitSettings`。 */
export interface CommitSettings {
  /** 双击变更行打开什么。 */
  showOnDoubleClick: DoubleClickTarget;
  /** 一件都没暂存时，提交按钮直接提交全部已跟踪改动。 */
  commitAllWhenNothingStaged: boolean;
}

/** 事务工单规则项（对齐 IntelliJ IDEA Issue Navigation 规范） */
export interface IssueNavigationPattern {
  id: string;
  issueId: string;
  issueLink: string;
}

/** 版本控制完整配置，1:1 对标 IntelliJ IDEA VCS 设置规范 */
export interface VcsSettings {
  /** 提交设置 Commit Settings */
  nonModalCommit: boolean;
  clearInitialCommitMessage: boolean;
  blankLineAfterSubject: boolean;
  limitSubjectLine: boolean;
  subjectLineLimit: number;
  limitBodyLine: boolean;
  bodyLineLimit: number;
  showRightMargin: boolean;
  wrapRightMargin: boolean;
  /** 提交前检查 Commit Checks */
  checkTodo: boolean;
  /** 确认与操作行为 Confirmation Settings */
  showUpdateOptions: boolean;
  /** 统一更新弹窗和跳过弹窗时使用的策略。 */
  updateMethod: "merge" | "rebase";
  autoUpdateOnPushRejected: boolean;
  highlightDirtyDirectories: boolean;
  onPatchCreated: "open" | "clipboard" | "file";
  limitHistoryRows: number;
  /** Git 行为与警告 */
  warnCrlf: boolean;
  warnDetachedHead: boolean;
  signOffCommit: boolean;
  warnLargeFiles: boolean;
  largeFilesLimitMb: number;
  warnBadFileNames: boolean;
  showPushDialog: "always" | "protected" | "never";
  protectedBranches: string;
  /** 事务工单导航 Issue Navigation */
  issueNavigationPatterns: IssueNavigationPattern[];
}

/** 点一下分支树里某条引用做什么。 */
export type SingleClickAction = "none" | "filter";

/** 分支弹层与日志分支面板齿轮里那几条显示开关，对应 Rust `BranchSettings`。 */
export interface BranchSettings {
  /** 搜索时把动作也列进结果。 */
  actionsInSearch: boolean;
  /** 列「最近使用」那一节。 */
  showRecent: boolean;
  /** 列标签那一节。 */
  showTags: boolean;
  /** 分支名按斜杠嵌成目录层级；关掉就是平铺一条。 */
  groupByDirectory: boolean;
  /** 点一下树里某条引用做什么：只选中，还是顺手把日志筛到这条。 */
  onSingleClick: SingleClickAction;
  /** 收藏的引用全名（本地分支不带前缀，远端带 `origin/`）；同层里排在前面。标签收藏不了。 */
  favorites: string[];
  /** 提交图折叠线性链（Collapse Linear Branches），对齐 openidea logOptions 默认关。 */
  collapseLinear: boolean;
  /** 提交图画长边（Show Long Edges），IDEA 默认开。 */
  showLongEdges: boolean;
}

/** 资源管理器右键「通过 Forge 打开」。两个都要用户自己打开。 */
export interface ShellSettings {
  /** 文件夹右键。打开后按添加项目处理。 */
  openFolder: boolean;
  /** 文本文件右键。只登记白名单里的文本格式，打开后暂时进编辑区。 */
  openFile: boolean;
  /** 这些文本文件的双击默认程序。 */
  defaultFile: boolean;
  /** 用户追加的扩展名。内置名单不在这里。 */
  extraExtensions: string[];
}

/**
 * 切换「通过 Forge 打开文件」后的设置。
 *
 * 关掉文件右键时必须同时收回默认程序关联：否则设置页里开关已经消失，
 * 系统里却还留着 `UserChoice` 指向 Forge，用户再也找不到地方改回来。
 */
export function withShellFileToggle(shell: ShellSettings, openFile: boolean): ShellSettings {
  return { ...shell, openFile, defaultFile: openFile ? shell.defaultFile : false };
}

/** 资源管理器的显示偏好。 */
export interface ExplorerSettings {
  /** 显示被 .gitignore 忽略的文件/目录。 */
  showIgnored: boolean;
  /** 显示隐藏文件（Windows 隐藏属性 / 点开头）。 */
  showHidden: boolean;
}

/** 应用内更新的偏好，对应 Rust `UpdateSettings`。 */
export interface UpdateSettings {
  /** 发现新版本后自动下载；关掉就只走设置页里的手动检查。 */
  autoDownload: boolean;
  /** 下载完成后弹窗询问安装；关掉就是下载完直接静默安装。只在 autoDownload 开着时有意义。 */
  autoPromptInstall: boolean;
  /** 是否开启 GitHub 镜像加速更新。 */
  proxyEnabled: boolean;
  /** 镜像加速前缀地址，如 https://gh-proxy.com/。 */
  proxyUrl: string;
}

/**
 * 一份全局设置，落在系统配置目录的 settings.json。
 *
 * 这里只放偏好：主题、字号这类几个月不动一次的选择。用户做过的流水（上次开的项目、
 * 最近分支、用过的提交说明）住在 `history.json`，见 `lib/history.ts`。
 */
export interface Settings {
  /** AI 编程助手总开关，默认关闭。只决定菜单与侧栏入口显不显示，不拦截任何功能。 */
  aiAssistantsEnabled: boolean;
  /** 浏览器和截图默认启用；文件上传和任意脚本必须手动授权。 */
  browser: { enabled: boolean; renderedPixels: boolean; unsafeEvaluate: boolean; fileUpload: boolean; elementContent: "code" | "screenshot" | "both" };
  /** 外观模式。 */
  theme: ThemeMode;
  /** 界面语言；空串表示跟随系统。 */
  language: Lang | "";
  /** 工作区模式：多工作区常驻或单工作区。 */
  workspaceMode: WorkspaceMode;
  /** `.http` / `.rest` 的响应显示：底部面板或单独页签。 */
  httpResponse: HttpResponseLayout;
  /** 点关闭按钮做什么。 */
  closeBehavior: CloseBehavior;
  editor: EditorSettings;
  terminal: TerminalSettings;
  commit: CommitSettings;
  branches: BranchSettings;
  explorer: ExplorerSettings;
  /** 资源管理器右键菜单。默认都不开。 */
  shell: ShellSettings;
  /** 应用内更新。 */
  updates: UpdateSettings;
  /** 运行工具窗口。 */
  run: RunSettings;
  /** 按项目根隔离的目录角色；相对路径值为 source/test/resources/testResources/excluded。 */
  projectDirectoryRoles: ProjectDirectoryRoles;
  /** 版本控制与 Git 设置（1:1 对标 IntelliJ IDEA VCS 设置中心） */
  vcs: VcsSettings;
}

export const DEFAULT_VCS_SETTINGS: VcsSettings = {
  nonModalCommit: true,
  clearInitialCommitMessage: false,
  blankLineAfterSubject: true,
  limitSubjectLine: true,
  subjectLineLimit: 72,
  limitBodyLine: true,
  bodyLineLimit: 72,
  showRightMargin: true,
  wrapRightMargin: false,
  checkTodo: true,
  showUpdateOptions: true,
  updateMethod: "merge",
  autoUpdateOnPushRejected: false,
  highlightDirtyDirectories: true,
  onPatchCreated: "clipboard",
  limitHistoryRows: 1000,
  warnCrlf: true,
  warnDetachedHead: true,
  signOffCommit: false,
  warnLargeFiles: true,
  largeFilesLimitMb: 50,
  warnBadFileNames: true,
  showPushDialog: "protected",
  protectedBranches: "master;main;release/*",
  issueNavigationPatterns: [
    { id: "1", issueId: "([A-Z]+-\\d+)", issueLink: "https://jira.example.com/browse/$1" },
  ],
};

/** 浏览器权限逐项保存，避免旧窗口顺带恢复已撤销的上传或脚本授权。 */
export type SettingsPatch = Omit<Partial<Settings>, "browser"> & { browser?: Partial<Settings["browser"]> };

export const DEFAULT_SETTINGS: Settings = {
  aiAssistantsEnabled: false,
  browser: { enabled: true, renderedPixels: true, unsafeEvaluate: false, fileUpload: false, elementContent: "both" },
  theme: "system",
  language: "",
  workspaceMode: "multi",
  httpResponse: "bottom",
  closeBehavior: "tray",
  editor: {
    rainbowBrackets: false,
    fontFamily: "",
    fontSize: 13,
    tabSize: 2,
    minimap: true,
    keymap: "idea",
    savePolicy: "blur",
    saveOnExit: true,
    trimTrailingWhitespace: false,
    insertFinalNewline: false,
    softWrap: false,
    showWhitespace: false,
    lineHeight: 0,
  },
  terminal: {
    shell: "",
    fontSize: 12,
    fontFamily: "",
    scrollback: 10_000,
    cursorStyle: "bar",
    tabLayout: "horizontal",
    bell: "visual",
    profiles: [],
  },
  commit: { showOnDoubleClick: "preview", commitAllWhenNothingStaged: true },
  branches: {
    actionsInSearch: true,
    showRecent: true,
    showTags: true,
    groupByDirectory: true,
    onSingleClick: "none",
    favorites: [],
    collapseLinear: false,
    showLongEdges: true,
  },
  explorer: { showIgnored: true, showHidden: false },
  shell: { openFolder: false, openFile: false, defaultFile: false, extraExtensions: [] },
  updates: {
    autoDownload: false,
    autoPromptInstall: true,
    proxyEnabled: false,
    proxyUrl: "https://gh-proxy.com/",
  },
  run: { timestamps: true },
  projectDirectoryRoles: {},
  vcs: DEFAULT_VCS_SETTINGS,
};

/** 翻一条引用的收藏标记：名单按引用全名存，日志的分支树和顶栏的分支弹层共用这一份。 */
export function withFavoriteToggled(options: BranchSettings, name: string): BranchSettings {
  return {
    ...options,
    favorites: options.favorites.includes(name)
      ? options.favorites.filter((held) => held !== name)
      : [...options.favorites, name],
  };
}

/** 老文件缺字段时逐层补默认值，改结构不用迁移。 */
function merge(raw: Partial<Settings> | null): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    // 只认严格的 true：老文件里没有这个字段、或被写成字符串，都按「关闭」处理。
    aiAssistantsEnabled: raw?.aiAssistantsEnabled === true,
    browser: {
      enabled: raw?.browser?.enabled !== false,
      // 缺字段默认允许截图；明确关闭或无效值不能被默认值覆盖。
      renderedPixels: raw?.browser?.renderedPixels === undefined || raw.browser.renderedPixels === true,
      unsafeEvaluate: raw?.browser?.unsafeEvaluate === true,
      fileUpload: raw?.browser?.fileUpload === true,
      // 缺失或未知的发送模式恢复截图和代码，权限字段继续独立归一化。
      elementContent: raw?.browser?.elementContent === "code" || raw?.browser?.elementContent === "screenshot" ? raw.browser.elementContent : "both",
    },
    workspaceMode: raw?.workspaceMode === "single" ? "single" : "multi",
    httpResponse: raw?.httpResponse === "tab" ? "tab" : "bottom",
    closeBehavior: raw?.closeBehavior === "quit" ? "quit" : "tray",
    editor: {
      ...DEFAULT_SETTINGS.editor,
      ...raw?.editor,
      // 只认列出来的那两档，文件里写了别的值就退回默认。
      savePolicy: raw?.editor?.savePolicy === "manual" ? "manual" : "blur",
      // 老配置里的 "default" 与未知值都归一成 IDEA。
      keymap: normalizeKeymapScheme(raw?.editor?.keymap),
      fontFamily: typeof raw?.editor?.fontFamily === "string" ? raw.editor.fontFamily.trim() : "",
    },
    terminal: normalizeTerminal(raw?.terminal),
    commit: { ...DEFAULT_SETTINGS.commit, ...raw?.commit },
    branches: { ...DEFAULT_SETTINGS.branches, ...raw?.branches },
    explorer: { ...DEFAULT_SETTINGS.explorer, ...raw?.explorer },
    shell: {
      openFolder: raw?.shell?.openFolder === true,
      openFile: raw?.shell?.openFile === true,
      // 没开「通过 Forge 打开文件」时，不能单独占着默认打开方式。
      defaultFile: raw?.shell?.openFile === true && raw?.shell?.defaultFile === true,
      extraExtensions: normalizeExtraExtensions(raw?.shell?.extraExtensions),
    },
    updates: { ...DEFAULT_SETTINGS.updates, ...raw?.updates },
    run: { ...DEFAULT_SETTINGS.run, ...raw?.run },
    projectDirectoryRoles: normalizeProjectDirectoryRoles(raw?.projectDirectoryRoles),
    // 仅保留当前支持的 VCS 字段，已移除的提交检查不再传回界面或随设置保存。
    vcs: {
      ...DEFAULT_VCS_SETTINGS,
      ...Object.fromEntries(Object.entries(raw?.vcs ?? {}).filter(([key]) => Object.hasOwn(DEFAULT_VCS_SETTINGS, key))),
      updateMethod: raw?.vcs?.updateMethod === "rebase" ? "rebase" : "merge",
      autoUpdateOnPushRejected: raw?.vcs?.autoUpdateOnPushRejected === true,
    },
  };
}

/** 读全局设置；没有 Tauri 注入（纯浏览器跑前端）时退回默认值。 */
export async function loadSettings(): Promise<Settings> {
  try {
    return merge(await invoke<Partial<Settings>>("settings_load"));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * 按字段保存：只把改动的部分交给后端做 JSON Merge Patch（RFC 7396）合并，
 * 返回合并后的全量设置。不再传全量，是因为另一个窗口的旧内存副本整份写回时
 * 会把新设置连别的字段一起抹掉；调用方拿返回值覆盖本地，两个窗口最终都跟文件一致。
 */
export function saveSettings(patch: SettingsPatch): Promise<Settings> {
  return invoke<Settings>("settings_save", { patch }).then(merge);
}
