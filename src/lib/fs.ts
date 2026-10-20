import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/** 条目类型，取自 Rust `EntryKind` 的 serde 小写序列化结果。 */
export type EntryKind = "directory" | "file" | "other";

/** 单个文件或文件夹，由 Rust `FsEntry` 序列化而来。 */
export interface FsEntry {
  /** 显示名，不含路径分隔符；盘符根（"C:\\"）时退化为完整路径。 */
  name: string;
  /** 绝对路径，分隔符跟随平台。 */
  path: string;
  /** 目录 / 文件 / 其它（设备、命名管道等）。 */
  kind: EntryKind;
  /** 扩展名（不含点）；无扩展名或目录时为 null。 */
  extension: string | null;
  /** 字节数；目录恒为 0（不做递归统计）。 */
  size: number;
  /** 修改时间，Unix 毫秒；取不到时为 0。 */
  modifiedMs: number;
  /** 符号链接或 junction（Windows 靠 reparse point 判定）。 */
  isSymlink: boolean;
  /** Windows 隐藏/系统属性，类 unix 下为点开头文件名。 */
  isHidden: boolean;
  /** 只读属性。 */
  isReadonly: boolean;
}

/** 一次目录读取结果，来自 Rust `DirectoryListing`。 */
export interface DirectoryListing {
  /** 请求时传入的路径，原样回传。 */
  path: string;
  /** 父目录绝对路径；已到卷根时为 null。 */
  parent: string | null;
  /** 目录项，已按「目录优先 + 名称升序」排好。 */
  entries: FsEntry[];
  /** 读取单条时失败的原因列表，不阻断整个目录。 */
  unreadable: string[];
}

/** 交给编辑器的一整份文本，来自 Rust `FileContent`。 */
export interface FileContent {
  /** 打开的绝对路径。 */
  path: string;
  /** 正文，BOM 已剥离。 */
  contents: string;
  /** 磁盘字节数（含 BOM）。 */
  size: number;
  /** 行尾风格，保存时按它写回。 */
  lineEnding: "crlf" | "lf";
  /** 原文件是否带 UTF-8 BOM。 */
  hasBom: boolean;
  /** 这份内容在磁盘上的修改时间（unix 毫秒），用来认出「只是被 touch 了一下」。 */
  modifiedMs: number;
  /**
   * 文本编码标签：`utf-8` 或 `gb18030`。
   *
   * 读时由后端判定（UTF-8 解不动且无 NUL、能按 GB18030 干净解出的就是 `gb18030`），
   * 保存时原样带回，后端按它回写；不给时后端按 `utf-8`。
   */
  encoding: "utf-8" | "gb18030";
}

/** 超过 8 MiB、含 NUL 的二进制、或既非 UTF-8 又非 GB18030 的文本时后端报错，不会给半份内容。 */
export function readFile(path: string): Promise<FileContent> {
  return invoke<FileContent>("read_file", { path });
}

export function writeFile(
  path: string,
  contents: string,
  lineEnding: "crlf" | "lf",
  hasBom: boolean,
  /** 按打开时认下的编码回写；缺省后端按 utf-8。 */
  encoding?: "utf-8" | "gb18030",
  /** 乐观锁：传打开时认下的 `modifiedMs`，磁盘被别处改过时后端拒写并报 `CONFLICT_ON_WRITE`。 */
  expectModifiedMs?: number
): Promise<FileContent> {
  return invoke<FileContent>("write_file", {
    path,
    contents,
    lineEnding,
    hasBom,
    encoding,
    expectModifiedMs,
  });
}

/**
 * 开始监听工作区；换目录直接再调一次，后端自己停掉上一个。
 *
 * `generation` 是这次监听的代号：后端命令在阻塞线程池里跑，两次 start 的执行
 * 顺序没有保证，代号落后的那次不能覆盖新监听（槽里留着旧根，事件就全静默了）。
 */
export function watchWorkspace(root: string, generation: number): Promise<void> {
  return invoke<void>("fs_watch_start", { root, generation }).catch(() => {});
}

/**
 * 关闭工作区时停监听。root 与 generation 合起来是令牌：后端只清代号与根都对得上的槽位，
 * 就算这条 stop 比换目录后那次新 start 晚到，也掐不死新监听。
 */
export function stopWorkspaceWatch(root: string, generation: number): Promise<void> {
  return invoke<void>("fs_watch_stop", { root, generation }).catch(() => {});
}

/** 列目录：后端已按「目录优先 + 名称升序」排好，隐藏项照实返回。 */
export function listDirectory(path: string): Promise<DirectoryListing> {
  return invoke<DirectoryListing>("list_directory", { path });
}

export function createFolder(path: string): Promise<FsEntry> {
  return invoke<FsEntry>("create_folder", { path });
}

export function createFile(path: string): Promise<FsEntry> {
  return invoke<FsEntry>("create_file", { path });
}

export function renameEntry(from: string, to: string): Promise<FsEntry> {
  return invoke<FsEntry>("rename_entry", { from, to });
}

/** 复制一条，目录连里面的内容一起；目标那儿已经有东西就报 TARGET_EXISTS，换名由调用方决定。 */
export function copyEntry(from: string, to: string): Promise<FsEntry> {
  return invoke<FsEntry>("copy_entry", { from, to });
}

/** 把一条挪到别处：同一个盘里就是一次改名，跨盘时复制完再把源删掉。 */
export function moveEntry(from: string, to: string): Promise<FsEntry> {
  return invoke<FsEntry>("move_entry", { from, to });
}

export function deleteEntry(path: string): Promise<void> {
  return invoke<void>("delete_entry", { path });
}

/** 在系统文件管理器中选中该项。 */
export function revealEntry(path: string): Promise<void> {
  return invoke<void>("reveal_entry", { path });
}

/** 一份文件的大小与修改时间，图片预览靠它认出磁盘上换过内容。 */
export interface FileStamp {
  size: number;
  modifiedMs: number;
}

export function fileStamp(path: string): Promise<FileStamp> {
  return invoke<FileStamp>("file_stamp", { path });
}

/** 一条路径是文件还是文件夹，给系统拖放分类用。 */
export interface PathKind {
  path: string;
  kind: EntryKind;
}

/** 批量看路径类型。不存在的条目不会出现在结果里。 */
export function statEntries(paths: string[]): Promise<PathKind[]> {
  return invoke<PathKind[]>("stat_entries", { paths });
}

/**
 * 本地文件的 asset URL，交给 <img> 用。
 *
 * 后端起 asset 协议得先有授权，所以打开工作区时要先调 `allowAssetDir`。附加的
 * `?v=` 是缓存失效串：磁盘上换了内容、URL 却一样时，webview 会拿旧图，换个值才重取。
 */
export function assetUrl(path: string, version: number): string {
  const base = convertFileSrc(path);
  return version > 0 ? `${base}?v=${version}` : base;
}

/** 把工作区目录授权给 asset 协议；不落盘，每次打开工作区都要重新授一遍。 */
export function allowAssetDir(root: string): Promise<void> {
  return invoke<void>("fs_allow_asset", { root });
}

/** 用系统默认浏览器打开链接。 */
export function openExternal(url: string): Promise<void> {
  return invoke<void>("open_external", { url });
}

/** 文件名搜索的一条结果，来自 Rust `FileHit`。 */
export interface FileHit {
  /** 绝对路径，分隔符跟随平台；打开时用它。 */
  path: string;
  /** 显示名，不含路径。 */
  name: string;
  /** 所在目录相对工作区根，恒用 `/` 连接；直接挂在根下时是空串。显示出处用。 */
  container: string;
  /** 排档次：4 名字全等、3 前缀、2 包含、1 逐字顺次出现。后端已按它排好序。 */
  score: number;
  /** 目录也算命中，图标要和文件分开画。 */
  isDir: boolean;
}

/** 一次文件名搜索的结果，来自 Rust `FileHits`。 */
export interface FileHits {
  /** 传进去的原词，回显用。 */
  query: string;
  /** 已排好序的结果，条数不超过请求的 limit。 */
  items: FileHit[];
  /** 扫到条目上限或结果被截时为真，界面要说明这不是全部。 */
  truncated: boolean;
}

/**
 * 搜索的可见性闸门，对应 Rust `ScanFilter`。跟着资源管理器那两个设置走：
 * 隐藏项与被 .gitignore 忽略的项在后端扫描层整棵剪掉，不占条目与命中预算。
 */
export interface ScanFilter {
  /** 显示隐藏项（Windows 隐藏/系统属性、类 unix 点开头）。默认 false。 */
  showHidden?: boolean;
  /** 被忽略项的绝对路径；空数组表示「显示忽略项」，不剪任何路径。 */
  ignored?: string[];
}

/** 全文搜索的开关，对应 Rust `TextOptions`；整个对象可缺项，缺了后端按默认值。 */
export interface SearchOptions {
  /** 区分大小写。默认 false。 */
  caseSensitive?: boolean;
  /** 整词匹配，只在非正则下生效。默认 false。 */
  wholeWords?: boolean;
  /** 把搜索词当正则；写错时后端报 BAD_REGEX。默认 false。 */
  regex?: boolean;
  /** 文件名过滤，逗号或分号分隔的多个模式，认 `*`；空串不限。默认空。 */
  fileMask?: string;
  /** 最多回多少行，0 或缺省走后端的默认档。 */
  limit?: number;
}

/** 一行上的一处命中，来自 Rust `Range`。列号与长度都按整行的字符数算。 */
export interface MatchRange {
  /** 起始列，1 起。 */
  column: number;
  /** 命中长度，按字符数；正则空匹配时为 0。 */
  length: number;
}

/** 一行正文命中，来自 Rust `TextHit`。同一行的多处命中合在一条里。 */
export interface TextHit {
  /** 所在文件绝对路径。 */
  path: string;
  /** 文件名。 */
  name: string;
  /** 所在目录相对工作区根，`/` 连接；根下是空串。 */
  container: string;
  /** 行号，1 起，直接交给编辑器落行。 */
  line: number;
  /** `snippet` 首字符在原行里的列号，1 起；整行没被裁时是 1。 */
  snippetFrom: number;
  /** 预览片段，原行太长时只截命中附近的一段。 */
  snippet: string;
  /** 这一行里的所有命中，按出现顺序。 */
  ranges: MatchRange[];
}

/** 一次全文搜索的结果，来自 Rust `TextPage`。 */
export interface TextPage {
  /** 传进去的原词，回显用。 */
  query: string;
  /** 命中行，按后端的遍历顺序。 */
  hits: TextHit[];
  /** 这一页里出现过命中的文件数。 */
  files: number;
  /** 命中行被条数上限切断，或扫描触到条目上限时为真。 */
  truncated: boolean;
  /** 跳过的文件数：太大、二进制、非 UTF-8、读不到，四类合并。 */
  skipped: number;
}

/** 按名字找文件和目录。空词后端直接回空表，不报错。 */
export function findFiles(
  root: string,
  query: string,
  limit?: number,
  filter?: ScanFilter
): Promise<FileHits> {
  return invoke<FileHits>("find_files", { root, query, limit, filter });
}

/** 在正文里找词。正则写错时 reject 出 BAD_REGEX，别的都不算失败。 */
export function searchText(
  root: string,
  query: string,
  options: SearchOptions,
  filter?: ScanFilter
): Promise<TextPage> {
  return invoke<TextPage>("search_text", { root, query, options, filter });
}

/** 把 invoke 抛出的未知错误压成一行可展示文本。 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
