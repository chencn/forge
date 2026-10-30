/**
 * 项目侧边栏树节点数据模型
 *
 * 统一抽象三类根域：
 * 1. project: 工作区主工程源码树
 * 2. libraries: External Libraries 外部依赖库
 * 3. scratches: Scratches 临时文件与控制台
 */

import type { FsEntry } from "../../lib/fs";

export type ProjectNodeDomain = "project" | "libraries" | "scratches";

export interface ProjectTreeNode {
  /** 节点唯一标识键（正斜杠小写规范） */
  readonly key: string;
  /** 所属根域 */
  readonly domain: ProjectNodeDomain;
  /** 真实或虚拟文件系统条目 */
  readonly entry: FsEntry;
  /** 显示标题（合并 JVM 包链后可能为 `com.example.demo`） */
  readonly displayName: string;
  /** 展开/折叠的目标路径 */
  readonly deepestPath: string;
  /** 树层级深度 (0 为顶级根) */
  readonly depth: number;
  /** 是否为根节点 */
  readonly isRoot?: boolean;
  /** 是否已展开 */
  readonly isExpanded?: boolean;
  /** 是否有子节点（目录或非空组） */
  readonly hasChildren?: boolean;
  /** 是否被排除（.gitignore 忽略） */
  readonly isExcluded?: boolean;
  /** 是否为只读节点（如外部依赖库） */
  readonly isReadonly?: boolean;
  /** 附加描述文字，如 "library root"、"crates.io" */
  readonly locationDetail?: string;
  /** 虚拟分组标识，如 `< Node.js Packages >` */
  readonly isGroup?: boolean;
  /** 是否为 JVM 包节点（如 com.example） */
  readonly isPackage?: boolean;
  /** 自定义特定图标名称 (1:1 对齐 IntelliJ IDEA node.icon) */
  readonly icon?: string;
  /** 是否为归档文件节点 (如 .jar / .zip) */
  readonly isArchive?: boolean;
}

/** 比较用的路径键：分隔符统一为 `/` 并小写折叠 */
export function normalizePathKey(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

/**
 * 将用户家目录前缀缩写为 `~`（1:1 对标 IntelliJ IDEA 路径规范）
 */
export function tildify(path: string, home: string | null | undefined): string {
  if (!home || home === "/") return path.replaceAll("\\", "/");
  const h = home.replaceAll("\\", "/").replace(/\/+$/, "");
  const p = path.replaceAll("\\", "/");
  if (p.toLowerCase() === h.toLowerCase()) return "~";
  if (p.toLowerCase().startsWith(h.toLowerCase() + "/")) return "~" + p.slice(h.length);
  return p;
}

/**
 * 命名空间前缀与规整契约（1:1 对标 IntelliJ IDEA）
 * GROUP_PREFIX: 虚拟组根节点或虚拟分类
 * LIB_PREFIX: 外部依赖库独立命名空间，杜绝与项目工程同名物理路径冲突
 */
export const GROUP_PREFIX = "\u0000group:";
export const LIB_PREFIX = "\u0000lib:";
export const LIB_SEP = "\u0000";

export const isGroupKey = (key: string): boolean => key.startsWith(GROUP_PREFIX);
export const isLibKey = (key: string): boolean => key.startsWith(LIB_PREFIX);

export const libKey = (group: string, path: string): string =>
  `${LIB_PREFIX}${group}${LIB_SEP}${normalizePathKey(path)}`;

/** 从节点 key 解析出实际物理路径或虚拟路径 */
export function pathOfKey(key: string): string {
  if (isLibKey(key)) {
    const sep = key.indexOf(LIB_SEP, LIB_PREFIX.length);
    return sep >= 0 ? key.slice(sep + 1) : key;
  }
  return key;
}

/** 统一规范化树节点的唯一 Key */
export function normalizeNodeKey(key: string): string {
  if (isLibKey(key)) {
    const sep = key.indexOf(LIB_SEP, LIB_PREFIX.length);
    if (sep >= 0) {
      const group = key.slice(LIB_PREFIX.length, sep);
      const rest = key.slice(sep + 1);
      return `${LIB_PREFIX}${group}${LIB_SEP}${normalizePathKey(rest)}`;
    }
  }
  if (key.startsWith("__") || isGroupKey(key)) {
    return key;
  }
  return normalizePathKey(key);
}

/** 判定路径 a 是否在路径 b 之下或相等 */
export function isPathEqualOrChild(child: string, parent: string): boolean {
  const a = normalizePathKey(child).replace(/\/+$/, "");
  const b = normalizePathKey(parent).replace(/\/+$/, "");
  return a === b || a.startsWith(`${b}/`);
}

/**
 * 1:1 对标 JetBrains 的系统忽略文件规则
 * 注意：点开头文件（如 .github, .config, .env, .gitignore）在 IDEA 中默认完全可见！
 * 只有系统隐藏名单中的特殊项（如 .git, .DS_Store）才受 showHidden 限制。
 */
export const DEFAULT_IGNORED_NAMES = new Set([
  ".git",
  ".hg",
  ".jj",
  ".svn",
  "cvs",
  "_svn",
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
  "__pycache__",
  "vssver.scc",
  "vssver2.scc",
]);

export function isIgnoredName(name: string): boolean {
  const lower = name.toLowerCase();
  if (DEFAULT_IGNORED_NAMES.has(lower)) return true;
  if (lower.endsWith(".pyc") || lower.endsWith(".pyo") || lower.endsWith(".rbc") || lower.endsWith(".yarb") || lower.endsWith("~"))
    return true;
  return false;
}

/**
 * 1:1 对标 JetBrains 的 Excluded 排除目录规则
 * node_modules, dist, target 等构建输出或依赖包目录默认为排除目录，
 * 在树中赋予专属橙色文件夹高亮。
 */
export const DEFAULT_EXCLUDED_FOLDERS = new Set([
  "node_modules",
  "dist",
  "target",
  "build",
  "out",
  ".turbo",
  ".next",
  ".nuxt",
  ".cache",
]);

export function isExcludedFolder(name: string): boolean {
  return DEFAULT_EXCLUDED_FOLDERS.has(name.toLowerCase());
}

/** 拆分文件名与扩展名（点开头的文件没有扩展名，如 `.gitignore` -> `[".gitignore", ""]`） */
export function splitExtension(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  if (i <= 0) return [name, ""];
  return [name.slice(0, i), name.slice(i)];
}

export interface NameCheck {
  /** 错误描述，为 null 时表示合法 */
  error: string | null;
  /** 警告提示（如首尾存在空格） */
  warning?: string;
}

export interface ValidateOptions {
  /** 当前父目录下已存在的文件/目录名列表 */
  siblings: Iterable<string>;
  /** 当前重命名节点的原始名称 */
  current?: string;
  /** 大小写不敏感比对 */
  caseInsensitive?: boolean;
  /** 是否启用 Windows 非法字符与保留设备名检测 */
  windows?: boolean;
}

const WINDOWS_INVALID = /[<>:"|?*\\]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** 1:1 对标 IntelliJ IDEA 校验行内编辑输入的文件/目录名 */
export function validateName(raw: string, opts: ValidateOptions): NameCheck {
  const name = raw.trim();
  if (!name) return { error: "Name cannot be empty" };
  if (name.includes("\0")) return { error: "Name contains an invalid character" };
  if (name.startsWith("/") || name.startsWith("\\")) return { error: "Name cannot start with '/'" };

  const segments = name.split(/[/\\]/);
  for (const seg of segments) {
    if (!seg) return { error: "Name contains an empty path segment" };
    if (seg === "." || seg === "..") return { error: `'${seg}' is not a valid name` };
    if (opts.windows && (WINDOWS_INVALID.test(seg) || WINDOWS_RESERVED.test(seg))) {
      return { error: `'${seg}' is not a valid file name` };
    }
    if (seg.length > 255) return { error: "Name is too long" };
  }

  const fold = (s: string) => (opts.caseInsensitive ? s.toLowerCase() : s);
  const current = opts.current !== undefined ? fold(opts.current) : undefined;
  if (opts.current !== undefined && name === opts.current) return { error: null };

  const firstSeg = fold(segments[0]);
  for (const s of opts.siblings) {
    if (fold(s) !== firstSeg) continue;
    if (current !== undefined && fold(s) === current) continue;
    return { error: `'${segments[0]}' already exists` };
  }

  const warning = raw !== raw.trim() ? "Name has leading or trailing spaces" : undefined;
  return { error: null, warning };
}

/** 行内就地编辑状态模型 */
export type EditingState =
  | { kind: "new"; parent: string; nodeKind: "file" | "dir"; initial?: string }
  | { kind: "rename"; path: string; currentName: string; isDir: boolean };

/** 树条目剪贴板状态模型 */
export interface ClipboardState {
  paths: string[];
  cut: boolean;
}

/** 拖拽交互状态模型 */
export interface DragState {
  paths: string[];
  label: string;
  x: number;
  y: number;
  copy: boolean;
}

