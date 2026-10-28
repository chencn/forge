import type { TranslationKey } from "../i18n/lang/zh";

/** 后端分段用的控制字符，和 Rust `error::SEP` 是同一个。 */
const SEP = "\u0001";

/**
 * 前端自己产生的错误码，和 Rust 那边同一套写法。
 *
 * 有些「打不开」在打开之前就判得出来（例如已知的二进制格式），不必等后端报错；
 * 但也走这条通道，文案才和切语言时一起换。
 */
export function codedError(code: string, ...parts: string[]): string {
  return [code, ...parts].join(SEP);
}

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** 字节数说成人话；不是数字就原样回。 */
function humanBytes(raw: string | undefined): string {
  const bytes = Number(raw);
  if (raw === undefined || !Number.isFinite(bytes)) return raw ?? "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * 后端错误代码 → 界面文案。
 *
 * 后端只发「代码 + 原文片段」，怎么说由这里定，切语言才能连横幅一起切。
 * 代码对不上时退回原文：多半是新旧两端没同时更新，把话说全比猜一句更有用。
 */
const CODES: Record<string, (parts: string[], t: Translate) => string> = {
  IO: (p, t) => t("error.io", { path: p[0] ?? "", detail: p[1] ?? "" }),
  SHELL_REG: (p, t) => t("error.shellReg", { detail: p[0] ?? "" }),
  PATH_GONE: (p, t) => t("error.pathGone", { path: p[0] ?? "" }),
  IS_DIR: (p, t) => t("error.isDir", { path: p[0] ?? "" }),
  TOO_LARGE: (p, t) => t("error.tooLarge", { size: humanBytes(p[0]), max: humanBytes(p[1]) }),
  NOT_UTF8: (p, t) => t("error.notUtf8", { path: p[0] ?? "" }),
  // 保存那一刻磁盘 mtime 对不上基线：编辑器手里这份和磁盘那份都改过，拒写交回三向合并。
  CONFLICT_ON_WRITE: (p, t) =>
    t("error.conflictOnWrite", { path: p[0] ?? "", disk: p[1] ?? "", base: p[2] ?? "" }),
  // 已知的二进制格式：打开前就判出来了，说明放在正文里，不是一闪而过的横幅。
  BINARY: (p, t) => t("error.binary", { path: p[0] ?? "" }),
  // 没有可逐行比对的文本：图片是能打开但不能比对，其余二进制两样都不行。
  NO_DIFF: (p, t) =>
    t(p[1] === "image" ? "error.noDiffImage" : "error.noDiffBinary", { path: p[0] ?? "" }),
  TARGET_DIR: (p, t) => t("error.targetDir", { path: p[0] ?? "" }),
  TARGET_EXISTS: (p, t) => t("error.targetExists", { path: p[0] ?? "" }),
  // 跨盘挪动时复制成了、源没删掉：盘上留着两份，得说清楚是哪两份。
  MOVED_WITH_SOURCE: (p, t) => t("error.moveCopied", { to: p[0] ?? "", from: p[1] ?? "" }),
  NOT_DIR: (p, t) => t("error.notDir", { path: p[0] ?? "" }),
  // 交给系统 shell 之前被拦下的链接/路径（协议不在白名单、盘上没有、或是可执行文件）。
  EXTERNAL_BLOCKED: (p, t) => t("error.externalBlocked", { path: p[0] ?? "" }),
  WATCH_START: (p, t) => t("error.watchStart", { detail: p[0] ?? "" }),
  WATCH_DIR: (p, t) => t("error.watchDir", { path: p[0] ?? "", detail: p[1] ?? "" }),
  // git 自己的输出已经带「error:」「fatal:」，再套一层话只会重复。
  GIT: (p, t) => {
    const detail = (p[0] ?? "").trim();
    return detail === "" ? t("error.gitBare") : detail;
  },
  GIT_SPAWN: (p, t) => t("error.gitSpawn", { detail: p[0] ?? "" }),
  // 超过上限的 git 输出宁可不显示，也不能截半份 diff 给用户看——那是骗人。
  GIT_OUTPUT_TOO_LARGE: (p, t) => t("error.gitOutputTooLarge", { detail: p[0] ?? "" }),
  BLOCK_SPAWN: (p, t) => t("error.blockSpawn", { detail: p[0] ?? "" }),
  NO_REPO: (p, t) => t("error.noRepo", { path: p[0] ?? "" }),
  NOT_IN_REPO: (p, t) => t("error.notInRepo", { path: p[0] ?? "", root: p[1] ?? "" }),
  BAD_REV: (p, t) => t("error.badRev", { ref: p[0] ?? "" }),
  BAD_LOG_PATH: (p, t) => t("error.badLogPath", { path: p[0] ?? "" }),
  BAD_REPO_PATH: (p, t) => t("error.badRepoPath", { path: p[0] ?? "" }),
  BAD_BRANCH: (p, t) => t("error.badBranch", { name: p[0] ?? "" }),
  BAD_TAG: (p, t) => t("error.badTag", { name: p[0] ?? "" }),
  BAD_PATH: (p, t) => t("error.badPath", { path: p[0] ?? "" }),
  BAD_REGEX: (p, t) => t("error.badRegex", { pattern: p[0] ?? "", detail: p[1] ?? "" }),
  EMPTY_MESSAGE: (_p, t) => t("error.emptyMessage"),
  DETACHED_PUSH: (_p, t) => t("error.detachedPush"),
  NO_REMOTE: (_p, t) => t("error.noRemote"),
  NO_COMMAND: (_p, t) => t("error.noCommand"),
  // 脚本要在终端里跑，但本机没有它要的那种终端：直接拦下，不给终端发一条必挂的命令。
  NO_TERMINAL: (p, t) => t("error.noTerminal", { terminal: p[0] ?? "" }),
  // 识别出来的配置本机跑不了：缺构建工具 / 缺 JDK / JDK 太老，理由都写在这一条上。
  NO_TOOL: (p, t) => t("error.noTool", { program: p[0] ?? "" }),
  NO_JDK: (_p, t) => t("error.noJdk"),
  JDK_TOO_OLD: (p, t) => t("error.jdkTooOld", { version: p[0] ?? "" }),
  // 工程太大时扫描只翻了一部分，条目还是那些条目，但得说明可能不全。
  TOO_MANY_SOURCES: (p, t) => t("error.tooManySources", { path: p[0] ?? "" }),
  SPAWN: (p, t) => t("error.spawn", { program: p[0] ?? "", detail: p[1] ?? "" }),
  TERM_OPEN: (p, t) => t("error.termOpen", { detail: p[0] ?? "" }),
  TERM_GONE: (_p, t) => t("error.termGone"),
  TERM_IO: (p, t) => t("error.termIo", { detail: p[0] ?? "" }),
  TERM_LONG_INPUT: (p, t) => t("error.termLongInput", { limit: p[0] ?? "" }),
  TERM_LONG_INPUT_ENCODING: (_p, t) => t("error.termLongInputEncoding"),
  CONFIG_DIR: (p, t) => t("error.configDir", { detail: p[0] ?? "" }),
  BAD_JSON: (p, t) => t("error.badJson", { path: p[0] ?? "", detail: p[1] ?? "" }),
  LSP_NOT_FOUND: (p, t) => t("error.lspNotFound", { program: p[0] ?? "" }),
  LSP_SPAWN: (p, t) => t("error.lspSpawn", { program: p[0] ?? "", detail: p[1] ?? "" }),
  LSP_GONE: (_p, t) => t("error.lspGone"),
  LSP_IO: (p, t) => t("error.lspIo", { detail: p[0] ?? "" }),
  LSP_START_BACKOFF: (p, t) =>
    t("error.lspBackoff", { ms: p[0] ?? "", detail: p[1] ?? "" }),
  LSP_START_LIMIT: (p, t) =>
    t("error.lspStartLimit", { count: p[0] ?? "", detail: p[1] ?? "" }),
  LSP_NO_SERVER: (p, t) => t("error.lspNoServer", { server: p[0] ?? "" }),
  LSP_NO_INSTALL: (p, t) => t("error.lspNoInstall", { server: p[0] ?? "" }),
  LSP_INSTALL_SPAWN: (p, t) =>
    t("error.lspInstallSpawn", { program: p[0] ?? "", detail: p[1] ?? "" }),
  HTTP_URL: (p, t) => t("error.httpUrl", { url: p[0] ?? "" }),
  HTTP_NETWORK: (p, t) => t("error.httpNetwork", { detail: p[0] ?? "" }),
  HTTP_TIMEOUT: (p, t) => t("error.httpTimeout", { detail: p[0] ?? "" }),
  HTTP_HEADER: (p, t) => t("error.httpHeader", { name: p[0] ?? "" }),
  HTTP_METHOD: (p, t) => t("error.httpMethod", { method: p[0] ?? "" }),
  HTTP_BODY: (p, t) => t("error.httpBody", { detail: p[0] ?? "" }),
  HTTP_CYCLE: (p, t) => t("error.httpCycle", { name: p[0] ?? "" }),
  HTTP_ENCODING: (p, t) => t("error.httpEncoding", { encoding: p[0] ?? "" }),
  // 内置浏览器：宿主能力、页面生命周期与截图边界。文案只在界面这一侧有一份。
  BROWSER_DISABLED: (_p, t) => t("error.browserDisabled"),
  BROWSER_SESSION: (_p, t) => t("error.browserSession"),
  BROWSER_ZOOM: (_p, t) => t("error.browserZoom"),
  BROWSER_VIEWPORT: (_p, t) => t("error.browserViewport"),
  BROWSER_TAB_LIMIT: (p, t) => t("error.browserTabLimit", { max: p[0] ?? "" }),
  // 选取与批注：标记失效要分「还没发」和「已经发了」两种补救，所以带一段动作。
  BROWSER_PICK_STALE: (p, t) => t(p[0] === "resend" ? "error.browserPickResend" : "error.browserPickReselect"),
  BROWSER_PICK_LOADING: (_p, t) => t("error.browserPickLoading"),
  BROWSER_PICK_OVERLAY: (_p, t) => t("error.browserPickOverlay"),
  BROWSER_PICK_CANCELLED: (_p, t) => t("error.browserPickCancelled"),
  BROWSER_PICK_IFRAME: (_p, t) => t("error.browserPickIframe"),
  BROWSER_PICK_HIDDEN: (_p, t) => t("error.browserPickHidden"),
  BROWSER_PICK_LIMIT: (_p, t) => t("error.browserPickLimit"),
  BROWSER_PICK_MODE: (_p, t) => t("error.browserPickMode"),
  BROWSER_PICK_CAPTURE: (_p, t) => t("error.browserPickCapture"),
  BROWSER_STYLE_INPUT: (_p, t) => t("error.browserStyleInput"),
  BROWSER_STYLE_APPLY: (_p, t) => t("error.browserStyleApply"),
  BROWSER_STYLE_RESTORE: (_p, t) => t("error.browserStyleRestore"),
  BROWSER_ANNOTATION_INPUT: (_p, t) => t("error.browserAnnotationInput"),
  BROWSER_ANNOTATION_LIMIT: (p, t) => t("error.browserAnnotationLimit", { max: p[0] ?? "" }),
  BROWSER_BOUNDS: (_p, t) => t("error.browserBounds"),
  BROWSER_FIND_LIMIT: (p, t) => t("error.browserFindLimit", { max: p[0] ?? "" }),
  BROWSER_DIALOG_LIMIT: (_p, t) => t("error.browserDialogLimit"),
  BROWSER_NO_HISTORY: (_p, t) => t("error.browserNoHistory"),
  TAB_CLOSED: (_p, t) => t("error.tabClosed"),
};

/** 把后端回的错误文本翻成当前界面语言；不含代码的原样返回。 */
export function describeError(text: string, t: Translate): string {
  if (!text.includes(SEP)) return text;
  const [code = "", ...parts] = text.split(SEP);
  const build = CODES[code];
  if (build) return build(parts, t);
  return parts.join(" ");
}

/** `CONFLICT_ON_WRITE` 拆出来的三段，供三向合并取磁盘那份。 */
export interface SaveConflict {
  path: string;
  diskMs: number;
  baseMs: number;
}

/**
 * 从一条保存失败的错误文本里认出「磁盘被别处改过」这一种。
 *
 * 保存被乐观锁拒掉时后端回 `CONFLICT_ON_WRITE\u0001path\u0001diskMs\u0001baseMs`。
 * 命中就给出三段（diskMs/baseMs 已是数字），不是这一种或数值坏掉时回 null，交回普通报错。
 */
export function parseSaveConflict(text: string): SaveConflict | null {
  if (!text.includes(SEP)) return null;
  const [code = "", path = "", disk = "", base = ""] = text.split(SEP);
  if (code !== "CONFLICT_ON_WRITE") return null;
  const diskMs = Number(disk);
  const baseMs = Number(base);
  if (!Number.isFinite(diskMs) || !Number.isFinite(baseMs)) return null;
  return { path, diskMs, baseMs };
}
