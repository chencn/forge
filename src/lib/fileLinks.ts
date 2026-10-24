import { isWindowsPath, nativeSeparators, resolveRelative } from "./format";

/** markdown 链接里认出的一处本地文件，行号可缺省。 */
export interface FileLinkTarget {
  path: string;
  line?: number;
  column?: number;
}

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const URI_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;

/**
 * 无协议的地址以主机名开头：`www.…`、`localhost`、IPv4，或常见域名后缀。
 * `index.html` 与 `example.com` 形状相同，只有后缀能分开，所以这里只收很少
 * 会当文件扩展名的后缀。
 */
const WEB_SUFFIXES = new Set([
  "com", "net", "org", "io", "dev", "ai", "app", "co", "cn", "me", "xyz",
  "info", "edu", "gov", "uk", "de", "jp", "kr", "tw", "hk",
]);

function isWebHost(segment: string): boolean {
  const host = segment.toLowerCase();
  if (host === "localhost" || host.startsWith("www.")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  // 主机名不会以点开头，`.env.local` 仍是点文件。
  const suffix = /^[^.].*\.([a-z\d]+)$/.exec(host)?.[1];
  return suffix !== undefined && WEB_SUFFIXES.has(suffix);
}

/**
 * 只有名字也像文件的相对路径才当文件：扩展名里有字母（`index.html`、`a.ts`，
 * 但 `v1.2.3` 不是），点文件（`.gitignore`），或工程根上常见的无扩展名文件。
 */
export function isFileName(name: string): boolean {
  if (!name || isWebHost(name)) return false;
  return (
    /\.[A-Za-z\d]*[A-Za-z][A-Za-z\d]*$/.test(name) ||
    /^\.[^./\\]/.test(name) ||
    /^[A-Za-z]+file$/i.test(name) ||
    /^[A-Z][A-Z\d]{3,}(?:[-_][A-Z\d]+)*$/.test(name)
  );
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function positive(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const number = Number.parseInt(value, 10);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function parseHashLine(hash: string): number | undefined {
  const normalized = hash.replace(/^#/, "");
  if (!normalized) return undefined;
  // `#L10` / `#L10-L25` / `#line=10` / `#10`：范围跳到起始行。
  return positive(/^L(\d+)(?:-L?\d+)?$/i.exec(normalized)?.[1])
    ?? positive(/^line=(\d+)$/i.exec(normalized)?.[1])
    ?? positive(/^(\d+)$/.exec(normalized)?.[1]);
}

/** 拆出结尾的 `:行[:列]`；盘符的冒号与其后的路径不算。 */
function splitPosition(rawPath: string): { path: string; line?: number; column?: number } {
  // 先试带列号的形式，免得贪婪匹配把「行」吃进路径、只留下「列」。
  const withColumn = /^(.*):(\d+):(\d+)$/.exec(rawPath);
  if (withColumn?.[1] && !withColumn[1].endsWith("://")) {
    const line = positive(withColumn[2]);
    const column = positive(withColumn[3]);
    if (line !== undefined) return { path: withColumn[1], line, column };
  }
  const withLine = /^(.*):(\d+)$/.exec(rawPath);
  if (!withLine?.[1] || withLine[1].endsWith("://")) return { path: rawPath };
  const line = positive(withLine[2]);
  return line === undefined ? { path: rawPath } : { path: withLine[1], line };
}

function isLocalPathLike(path: string): boolean {
  if (!path) return false;
  if (WINDOWS_ABSOLUTE.test(path) || path.startsWith("\\\\") || path.startsWith("//")) return true;
  if (path.startsWith("/") || path.startsWith("./") || path.startsWith("../") || path.startsWith("~/")) return true;
  if (URI_SCHEME.test(path)) return false;
  const slash = path.indexOf("/");
  if (slash > 0) return !isWebHost(path.slice(0, slash));
  return isFileName(path);
}

/**
 * 从一个 markdown 链接地址里解出本地文件目标；网页地址、页内锚点、协议相对的
 * `//host/…` 都返回 null。
 *
 * 认的写法：`file://` URI、盘符路径、UNC、POSIX 绝对路径、`./` `../` `~/`，
 * 以及相对路径；行号可写成 `:12`、`:12:5`、`#L12`、`#L12-L20` 或 `#line=12`。
 */
export function parseFileLink(rawHref: string): FileLinkTarget | null {
  const trimmed = rawHref.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  if (trimmed.toLowerCase().startsWith("file://")) {
    try {
      const url = new URL(trimmed);
      const pathname = decodeSafely(url.pathname);
      // 非空 host 是 UNC：file://server/share/x → //server/share/x。
      const local = url.host ? `//${url.host}${pathname}` : pathname.replace(/^\/([A-Za-z]:[\\/])/, "$1");
      const position = splitPosition(local);
      if (!position.path || !isLocalPathLike(position.path)) return null;
      return {
        path: position.path.replace(/\\/g, "/"),
        line: parseHashLine(url.hash) ?? position.line,
        column: position.column,
      };
    } catch {
      return null;
    }
  }

  // 协议相对的 `//host/…` 是网页地址，不是 UNC。
  if (trimmed.startsWith("//")) return null;

  // 先按原始 # / ? 切开再解码，避免路径里编过码的 `%23` / `%3F` 被当成片段/查询。
  // 解码也要排在协议/盘符判断之前：marked 会把链接里的反斜杠写成 `%5C`。
  const hashIndex = trimmed.indexOf("#");
  const rawHash = hashIndex >= 0 ? trimmed.slice(hashIndex) : "";
  const beforeHash = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const queryIndex = beforeHash.indexOf("?");
  const rawPath = decodeSafely(queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash);

  // `a.ts:12` 会被 URL 协议规则读成 scheme `a.ts:`，但它是工程根上的文件位置。
  const rootPosition = /^([^\s/\\?#:]+):\d+(?::\d+)?$/.exec(rawPath);
  if (rootPosition && isFileName(rootPosition[1])) {
    const position = splitPosition(rawPath);
    return { path: position.path.replace(/\\/g, "/"), line: position.line, column: position.column };
  }

  if (URI_SCHEME.test(rawPath) && !WINDOWS_ABSOLUTE.test(rawPath)) return null;

  const position = splitPosition(rawPath);
  if (!position.path || !isLocalPathLike(position.path)) return null;

  return {
    path: position.path.replace(/\\/g, "/"),
    line: parseHashLine(rawHash) ?? position.line,
    column: position.column,
  };
}

/**
 * 把链接里的路径落成绝对路径：绝对路径与 UNC 原样（统一成系统分隔符），
 * 相对路径按工程根还原；`~` 没法确定家目录，只能放弃。
 */
export function resolveFileLink(target: FileLinkTarget, workspace: string | null): string | null {
  const path = target.path;
  if (!path) return null;
  if (path.startsWith("//") || WINDOWS_ABSOLUTE.test(path)) return nativeSeparators(path);
  if (path.startsWith("~")) return null;
  if (path.startsWith("/")) {
    // Windows 上的 `/d/app/x` 是 Git Bash 的盘符写法。
    if (workspace && isWindowsPath(workspace)) {
      const msys = /^\/([A-Za-z])(\/.*)?$/.exec(path);
      return msys ? nativeSeparators(`${msys[1].toUpperCase()}:${msys[2] ?? "/"}`) : null;
    }
    return path;
  }
  if (!workspace) return null;
  return resolveRelative(workspace, path);
}
