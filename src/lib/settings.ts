import { invoke } from "@tauri-apps/api/core";
import { normalizeExtraExtensions } from "./shellWhitelist";
import type { ThemeMode } from "./window";
import type { Lang } from "../i18n";

/** 编辑器快捷键方案，对应 `lib/keymap.ts` 里的三套。 */
export type KeymapScheme = "default" | "idea" | "eclipse";

/** 代码保存策略：只手动存，还是失去焦点时自动存。 */
export type SavePolicy = "manual" | "blur";

/** 点关闭按钮做什么：收进托盘还是直接退应用。 */
export type CloseBehavior = "tray" | "quit";

/** 工作区模式：一个窗口同时常驻多个文件夹（multi），还是只留一个（single）。 */
export type WorkspaceMode = "multi" | "single";

/** 编辑器偏好，对应 Rust `EditorSettings`。 */
export interface EditorSettings {
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
}

/** 终端偏好，对应 Rust `TerminalSettings`。 */
export interface TerminalSettings {
  /** 起终端用的 shell 程序路径；空串表示用 `shell_probe` 排在第一的那个。 */
  shell: string;
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

/** 通知弹窗气泡显示位置，对应 IDEA 的 NotificationLocation。 */
export type NotificationPosition = "bottom-right" | "top-right" | "bottom-left" | "top-left";

/**
 * 一份全局设置，落在系统配置目录的 settings.json。
 *
 * 这里只放偏好：主题、字号这类几个月不动一次的选择。用户做过的流水（上次开的项目、
 * 最近分支、用过的提交说明）住在 `history.json`，见 `lib/history.ts`。
 */
export interface Settings {
  /** 外观模式。 */
  theme: ThemeMode;
  /** 界面语言；空串表示跟随系统。 */
  language: Lang | "";
  /** 工作区模式：多工作区常驻或单工作区。 */
  workspaceMode: WorkspaceMode;
  /** 点关闭按钮做什么。 */
  closeBehavior: CloseBehavior;
  editor: EditorSettings;
  terminal: TerminalSettings;
  commit: CommitSettings;
  branches: BranchSettings;
  explorer: ExplorerSettings;
  /** 资源管理器右键菜单。默认都不开。 */
  shell: ShellSettings;
  /** 通知弹窗气泡位置。 */
  notificationPosition: NotificationPosition;
  /** 应用内更新。 */
  updates: UpdateSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  language: "",
  workspaceMode: "multi",
  closeBehavior: "tray",
  editor: {
    fontSize: 13,
    tabSize: 2,
    minimap: true,
    keymap: "default",
    savePolicy: "blur",
    saveOnExit: true,
  },
  terminal: { shell: "" },
  commit: { showOnDoubleClick: "preview", commitAllWhenNothingStaged: true },
  branches: {
    actionsInSearch: true,
    showRecent: true,
    showTags: true,
    groupByDirectory: true,
    onSingleClick: "none",
    favorites: [],
  },
  explorer: { showIgnored: true, showHidden: false },
  shell: { openFolder: false, openFile: false, defaultFile: false, extraExtensions: [] },
  notificationPosition: "bottom-right",
  updates: {
    autoDownload: false,
    autoPromptInstall: true,
    proxyEnabled: false,
    proxyUrl: "https://gh-proxy.com/",
  },
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
    workspaceMode: raw?.workspaceMode === "single" ? "single" : "multi",
    closeBehavior: raw?.closeBehavior === "quit" ? "quit" : "tray",
    editor: {
      ...DEFAULT_SETTINGS.editor,
      ...raw?.editor,
      // 只认列出来的那两档，文件里写了别的值就退回默认。
      savePolicy: raw?.editor?.savePolicy === "manual" ? "manual" : "blur",
    },
    terminal: { ...DEFAULT_SETTINGS.terminal, ...raw?.terminal },
    commit: { ...DEFAULT_SETTINGS.commit, ...raw?.commit },
    branches: { ...DEFAULT_SETTINGS.branches, ...raw?.branches },
    explorer: { ...DEFAULT_SETTINGS.explorer, ...raw?.explorer },
    shell: {
      openFolder: raw?.shell?.openFolder === true,
      openFile: raw?.shell?.openFile === true,
      defaultFile: raw?.shell?.defaultFile === true,
      extraExtensions: normalizeExtraExtensions(raw?.shell?.extraExtensions),
    },
    updates: { ...DEFAULT_SETTINGS.updates, ...raw?.updates },
    notificationPosition:
      raw?.notificationPosition === "top-right" ||
      raw?.notificationPosition === "bottom-left" ||
      raw?.notificationPosition === "top-left"
        ? raw.notificationPosition
        : "bottom-right",
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

/** 整份写回；纯浏览器里失败就忽略。 */
export function saveSettings(settings: Settings): Promise<void> {
  return invoke<void>("settings_save", { settings }).catch(() => {});
}
