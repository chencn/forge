import { isWindowsPath, resolveRelative } from "./format";

/** 终端一行里认出来的一处文件路径。下标是这一行纯文本里的字符下标，左闭右开。 */
export interface TermFileLink {
  text: string;
  path: string;
  line?: number;
  column?: number;
  startIndex: number;
  endIndex: number;
}

/** 剥掉路径头部常见的引用符与括号，如 `` ` ``、引号、`(`。 */
const LEADING_TRIM = /^[`"'(<[{]+/;
/** 剥掉路径尾部常见的标点，如引号、`)`、句号、逗号。 */
const TRAILING_TRIM = /[`"')>\]},.;!:]+$/;
/** `a.ts:12` 与 `a.ts:12:5`：编译器、测试框架、栈追踪最常见的写法。 */
const LINE_COLUMN = /^(.*?):(\d+)(?::(\d+))?$/;
/** `a.ts(12,5)`：tsc 与 MSBuild 的写法，后面常跟一个冒号。 */
const PAREN_LINE_COLUMN = /^(.*?)\((\d+)(?:,(\d+))?\):?$/;
/** `src/App.java:[42,9]`：Maven javac / checkstyle 的写法，报错的行最爱用这个格式。 */
const BRACKET_LINE_COLUMN = /^(.*?):\[(\d+)(?:,(\d+))?\]:?$/;
/** `file://` 协议头。 */
const FILE_URI = /^file:\/\//i;
/** 其它带协议头的 URI（http 等）：一律不当文件路径。 */
const OTHER_URI = /^[a-z][a-z0-9+.-]*:\/\//i;
/** Windows 盘符绝对路径（`C:/` 或 `C:\`）。 */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
/** 没有扩展名也当文件名认的白名单。 */
const EXTENSIONLESS = new Set([
  "Dockerfile",
  "Gemfile",
  "Justfile",
  "LICENSE",
  "Makefile",
  "Procfile",
  "Rakefile",
  "README",
]);
/** Git Bash / MSYS 写法的盘符路径：`/d/app/x`。 */
const MSYS_DRIVE = /^\/([A-Za-z])(\/.*)?$/;

/** 解开 `file://` 链接：本地盘去掉协议头与首斜杠，UNC 保留主机名；解不动原样返回。 */
function decodeFileUri(path: string): string {
  if (!FILE_URI.test(path)) return path;
  try {
    const url = new URL(path);
    const decoded = decodeURIComponent(url.pathname.replace(/^\/([A-Za-z]:\/)/, "$1"));
    // file://server/share 必须保留主机名，否则会被当成本机绝对路径或工程相对路径。
    return url.hostname ? `//${url.hostname}${decoded}` : decoded;
  } catch {
    return path.slice("file://".length);
  }
}

/** 取路径的末段文件名（两种分隔符都认，去掉尾部斜杠）。 */
function baseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/** 得带目录分隔符才算路径：光一个 `foo.bar` 在终端里太常见，多数不是文件。 */
function hasPathShape(path: string): boolean {
  return path.includes("/") || path.includes("\\");
}

/** 末段像不像一个文件名：带扩展点、或属于无扩展名白名单，且不是纯版本号。 */
function hasFileNameShape(path: string): boolean {
  const name = baseName(path);
  if (!name || name === "." || name === "..") return false;
  if (/^\d+(\.\d+)+$/.test(name)) return false;
  return name.includes(".") || EXTENSIONLESS.has(name);
}

/** 按起始目录落成绝对路径；落不下来（Windows 上的 Linux 绝对路径之类）返回 null。 */
function resolveCandidate(path: string, baseDir: string | null): string | null {
  if (OTHER_URI.test(path) && !FILE_URI.test(path)) return null;
  const decoded = decodeFileUri(path);
  if (!hasPathShape(decoded) || !hasFileNameShape(decoded)) return null;
  if (isWindowsPath(decoded)) return decoded;
  const windows = baseDir ? isWindowsPath(baseDir) : WINDOWS_ABSOLUTE.test(decoded);
  if (decoded.startsWith("/")) {
    if (!windows) return decoded;
    const drive = MSYS_DRIVE.exec(decoded);
    return drive ? `${drive[1].toUpperCase()}:${(drive[2] ?? "/").replaceAll("/", "\\")}` : null;
  }
  if (!baseDir) return null;
  return resolveRelative(baseDir, decoded);
}

/** 拆出路径和行列号；`shown` 是要画下划线的那一段（不含句尾标点）。 */
function splitPosition(text: string): {
  path: string;
  shown: string;
  line?: number;
  column?: number;
} {
  const paren = PAREN_LINE_COLUMN.exec(text);
  if (paren?.[1]) {
    return {
      path: paren[1],
      shown: text.replace(/:$/, ""),
      line: Number(paren[2]),
      column: paren[3] ? Number(paren[3]) : undefined,
    };
  }
  const bracket = BRACKET_LINE_COLUMN.exec(text);
  if (bracket?.[1]) {
    return {
      path: bracket[1],
      shown: text.replace(/:$/, ""),
      line: Number(bracket[2]),
      column: bracket[3] ? Number(bracket[3]) : undefined,
    };
  }
  const trimmed = text.replace(TRAILING_TRIM, "");
  const colon = LINE_COLUMN.exec(trimmed);
  if (colon?.[1]) {
    return {
      path: colon[1],
      shown: trimmed,
      line: Number(colon[2]),
      column: colon[3] ? Number(colon[3]) : undefined,
    };
  }
  return { path: trimmed, shown: trimmed };
}

/**
 * 在终端的一行文字里找文件路径：绝对路径、相对 `baseDir` 的路径、`file://`，
 * 以及后面跟着的行号列号。只认带目录分隔符、文件名像文件的那些，宁漏勿错。
 */
export function parseTermFileLinks(lineText: string, baseDir: string | null): TermFileLink[] {
  const links: TermFileLink[] = [];
  const token = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(lineText))) {
    let text = match[0];
    let startIndex = match.index;
    const leading = LEADING_TRIM.exec(text);
    if (leading) {
      text = text.slice(leading[0].length);
      startIndex += leading[0].length;
    }
    const { path, shown, line, column } = splitPosition(text);
    const resolved = resolveCandidate(path, baseDir);
    if (!resolved) continue;
    links.push({
      text: shown,
      path: resolved,
      line,
      column,
      startIndex,
      endIndex: startIndex + shown.length,
    });
  }
  return links;
}
