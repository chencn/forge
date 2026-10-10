/**
 * 文件按「怎么给用户看」分五类，全应用只在这里判定一次。
 *
 * - text：当代码打开，只有编辑器一种视图。
 * - markdown：正文是文本，但多一个渲染后的预览视图。
 * - svg：本体是图片，但也是文本，所以预览与源码两种视图都成立。
 * - image：本体是二进制图片，只有预览。
 * - binary：已知的二进制格式，既读不出文本也没有预览，只能给一句说明。
 */

export type DocKind = "text" | "markdown" | "svg" | "image" | "binary";

/** 除 svg 外，能直接交给 <img> 的图片格式。 */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "tif",
  "tiff",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd"]);

/**
 * 已知的二进制扩展名：既读不出文本，也没有预览可言。
 *
 * 这里列的是「看一眼扩展名就知道打不开」的那批；判错了也不致命，只是少一次
 * 明确说明。没有列的（例如没有扩展名的可执行文件）落到读盘那一步再判。
 */
const BINARY_EXTENSIONS = new Set([
  // 可执行与库
  "exe", "dll", "so", "dylib", "bin", "o", "a", "lib", "obj", "class", "wasm",
  // 归档与压缩
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "jar", "war",
  // 文档与数据
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  // 字体
  "ttf", "otf", "woff", "woff2", "eot",
  // 音视频
  "mp3", "wav", "flac", "ogg", "mp4", "mov", "avi", "mkv", "webm",
  // 其它二进制
  "sqlite", "db", "pdb", "dat", "pak", "iso", "dmg", "msi",
]);

/** 取小写扩展名，无扩展名时为空串。 */
function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function docKindOf(path: string): DocKind {
  const ext = extensionOf(path);
  if (ext === "svg") return "svg";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (BINARY_EXTENSIONS.has(ext)) return "binary";
  return "text";
}

/**
 * 这种类型有没有文本正文可读。
 *
 * 二进制图片与已知二进制都没有；svg 本体是 XML 文本，源码视图靠它，所以算有。
 */
export function hasTextContent(kind: DocKind): boolean {
  return kind !== "image" && kind !== "binary";
}

/**
 * 预览是不是从磁盘那份文件直接读（asset 协议）。
 *
 * svg 与位图都靠它；markdown 的预览渲染的是手里的正文，不走这里。
 */
export function previewsFromDisk(kind: DocKind): boolean {
  return kind === "image" || kind === "svg";
}

/**
 * 这种类型能不能逐行比对。
 *
 * 只有二进制图片与已知二进制不行：图片能打开但没有文本，其余两样都不行。
 * 别的（含 svg）本体都是文本，逐行比对成立。
 */
export function canDiff(kind: DocKind): boolean {
  return kind !== "image" && kind !== "binary";
}
