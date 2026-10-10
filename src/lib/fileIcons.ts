/**
 * 文件图标运行时：按文件名解析图标，并按需懒加载图标数据。
 *
 * 图标数据（src/lib/fileIconData.ts）单独成一个 chunk，不进首屏；
 * 界面先用单色占位图标渲染，数据到位后通知订阅者重渲染成彩色图标。
 */

/** 图标数据模块的形状，对应生成产物 fileIconData.ts 的导出。 */
interface FileIconData {
  EXTENSION_ICONS: Record<string, string>;
  SUFFIX_ICONS: Record<string, string>;
  FILE_NAME_ICONS: Record<string, string>;
  FOLDER_ICONS: Record<string, string>;
  DEFAULT_FILE: string;
  DEFAULT_FOLDER: string;
  ICONS_LIGHT: Record<string, string>;
  ICONS_DARK: Record<string, string>;
}

let data: FileIconData | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
/**
 * 后缀键按长度降序排好一次。每次解析都 `Object.keys` 一遍再逐个 `endsWith` 的话，
 * 424 个键就是 424 次字符串拼接加 424 次比较，而树里每个文件行都要解析一次。
 */
let suffixKeys: string[] = [];
/** 解析结果按「行形状 + 名字」记一份：同一目录重画时名字都是那些名字。 */
const resolved = new Map<string, string>();
/** 记满了就整张重开：图标解析的结果只依赖名字，重开最多再算一遍，不会算错。 */
const RESOLVED_CAP = 20_000;

/** 装入图标数据并通知所有订阅者重渲染。 */
export function installFileIcons(mod: FileIconData): void {
  data = mod;
  suffixKeys = Object.keys(mod.SUFFIX_ICONS).sort((a, b) => b.length - a.length);
  resolved.clear();
  for (const notify of listeners) notify();
}

/** 触发一次懒加载；并发调用共享同一个 Promise，数据已在时直接返回。 */
export function ensureFileIcons(): Promise<void> {
  if (data) return Promise.resolve();
  loading ??= import("./fileIconData").then((mod) => installFileIcons(mod));
  return loading;
}

/** useSyncExternalStore 的订阅入口。 */
export function subscribeFileIcons(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** 数据是否已装入，作为 useSyncExternalStore 的快照。 */
export function fileIconsReady(): boolean {
  return data !== null;
}

/** JVM 包节点用的图标（对齐 IDEA 的 package.svg）。 */
export const PACKAGE_ICON = "expui/nodes/package.svg";

/**
 * 解析条目对应的图标相对路径。
 * @param name 文件名或目录名
 * @param isDirectory 是否目录
 * @param isPackage 是否 JVM 包节点（目录链合并出来的 `com.example` 那种）；为真时用包图标
 * @returns 图标相对路径；数据未装入时为空串
 *
 * 顺序同 VS Code 的 fileIconTheme，从具体到笼统：
 *   1. 完整文件名（package.json、pom.xml）
 *   2. 多段后缀（foo.d.ts 命中 d.ts、x.schema.json 命中 schema.json）
 *   3. 单段扩展名（foo.rs 命中 rs）
 * 名字比后缀具体，后缀比扩展名具体——`package.json` 不该跟普通 `.json` 一个图标。
 */
export function resolveIconPath(name: string, isDirectory: boolean, isPackage = false): string {
  if (!data) return "";
  const key = `${isPackage ? "p" : isDirectory ? "d" : "f"}|${name}`;
  const hit = resolved.get(key);
  if (hit !== undefined) return hit;
  const path = resolveIconPathInner(name, isDirectory, isPackage);
  if (resolved.size >= RESOLVED_CAP) resolved.clear();
  resolved.set(key, path);
  return path;
}

function resolveIconPathInner(name: string, isDirectory: boolean, isPackage: boolean): string {
  if (!data) return "";
  const lower = name.toLowerCase();
  if (isDirectory || isPackage) {
    // 包节点是合并出来的目录，用 IDEA 的包图标；普通目录按其名查文件夹图标。
    if (isPackage) return data.ICONS_LIGHT[PACKAGE_ICON] ? PACKAGE_ICON : data.DEFAULT_FOLDER;
    return data.FOLDER_ICONS[lower] ?? data.DEFAULT_FOLDER;
  }

  const byName = data.FILE_NAME_ICONS[lower];
  if (byName) return byName;

  // 多段后缀：键已按长度降序排好，第一个 endsWith 命中的就是最长那个。
  // `d.ts` 与 `ts` 同时存在时要取前者，它更具体。
  for (const suffix of suffixKeys) {
    if (lower.endsWith(`.${suffix}`)) return data.SUFFIX_ICONS[suffix];
  }

  // 单段扩展名：普通文件取最后一个点之后；点开头且无其它点（.gitignore）时取点之后；
  // 完全无点（Dockerfile / Makefile）时退回整个文件名——对齐 IntelliJ 的 `extension ?: name`。
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : dot === 0 ? lower.slice(1) : "";
  const key = ext || lower;
  return data.EXTENSION_ICONS[key] ?? data.DEFAULT_FILE;
}

/**
 * 取图标相对路径对应的 SVG 字符串。
 * @param path 图标相对路径，浅色那套的写法
 * @param dark 是否深色主题
 * @returns SVG 字符串；深色缺失时回退浅色，都没有则为空串
 */
export function iconSvg(path: string, dark: boolean): string {
  if (!data) return "";
  if (!dark) return data.ICONS_LIGHT[path] ?? "";
  // 深色版在它自己那张表里按自己的文件名存：`folder.svg` 对应的是 `folder_dark.svg`。
  // 直接拿浅色路径去查一条都命中不了，整栏图标在深色主题下就全退回浅色版。
  const darker = path.replace(/\.svg$/, "_dark.svg");
  return data.ICONS_DARK[darker] ?? data.ICONS_LIGHT[path] ?? "";
}
