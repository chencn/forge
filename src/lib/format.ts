const SEPARATOR_PATTERN = /[\\/]/;

/** 判断是否为 Windows 风格路径（盘符或 UNC）。兼容正反双斜杠前缀。 */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("//");
}

/** 取路径当前风格的分隔符。 */
export function separator(path: string): string {
  return isWindowsPath(path) ? "\\" : "/";
}

/**
 * 归一成系统写法。git 在 Windows 上回的是 `D:/app/x` 这样的正斜杠根，
 * 和目录树那份反斜杠并排放在界面上就是两种分隔符。
 */
export function nativeSeparators(path: string): string {
  return isWindowsPath(path) ? path.replaceAll("/", "\\") : path;
}

/** 拼子项路径，根（"C:\" 或 "/"）不会拼出重复分隔符。 */
export function joinPath(dir: string, name: string): string {
  const sep = separator(dir);
  if (dir.endsWith(sep)) return `${dir}${name}`;
  return `${dir}${sep}${name}`;
}

/** 用户填的落盘位置：已经是绝对路径就原样用，相对的按 base 拼。 */
export function resolvePath(base: string, input: string): string {
  return isWindowsPath(input) || input.startsWith("/") ? input : joinPath(base, input);
}

/**
 * 把相对路径按基准目录还原成绝对路径。
 *
 * markdown 里的图片写的是相对这份文档的路径，得先落成绝对路径才好交给 asset 协议。
 * 退到根再往上时停在根上，不越出去。
 */
export function resolveRelative(baseDir: string, relative: string): string {
  const sep = separator(baseDir);
  let built = baseDir.replace(/[\\/]+$/, "");
  for (const part of relative.split(SEPARATOR_PATTERN)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      built = parentPath(built) ?? built;
      continue;
    }
    built = built.endsWith(sep) ? `${built}${part}` : `${built}${sep}${part}`;
  }
  return built;
}

/** 上一级目录；已在根时返回 null。 */
export function parentPath(path: string): string | null {
  const sep = separator(path);
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed === "" || trimmed === sep || /^[A-Za-z]:$/.test(trimmed)) return null;
  const index = trimmed.lastIndexOf(sep);
  if (index < 0) return null;
  const head = trimmed.slice(0, index);
  if (head === "" || /^[A-Za-z]:$/.test(head)) return `${head}${sep}`;
  // UNC 共享（\\server\share）本身算根，不再往上退。
  if (head.startsWith(sep + sep)) return head + sep;
  return head;
}

/** 拆成「根 + 逐级目录」，basenameOf 靠它保证盘符根不被砍成 "C:"。 */
function pathCrumbs(path: string): { name: string; path: string }[] {
  const sep = separator(path);
  const crumbs: { name: string; path: string }[] = [];

  let rest = path;
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    const root = `${path.slice(0, 2)}${sep}`;
    crumbs.push({ name: root, path: root });
    rest = path.slice(root.length);
  } else if (path.startsWith(sep + sep)) {
    const parts = path.split(SEPARATOR_PATTERN).filter(Boolean);
    const root = `${sep}${sep}${parts[0] ?? ""}${sep}${parts[1] ?? ""}${sep}`;
    crumbs.push({ name: root, path: root });
    rest = parts.slice(2).join(sep);
  } else {
    crumbs.push({ name: sep, path: sep });
    rest = path.replace(/^\/+/, "");
  }

  let built = crumbs[0].path;
  for (const part of rest.split(SEPARATOR_PATTERN).filter(Boolean)) {
    built = built.endsWith(sep) ? `${built}${part}` : `${built}${sep}${part}`;
    crumbs.push({ name: part, path: built });
  }
  return crumbs;
}

/** 取路径最后一级名，标题栏用；盘符根时返回 "C:\\" 这样的根写法。 */
export function basenameOf(path: string): string {
  const crumbs = pathCrumbs(path);
  return crumbs.length > 0 ? crumbs[crumbs.length - 1].name : path;
}

/**
 * 补丁文件用的主名：去掉最后一段扩展名。`.gitignore` 这类只有扩展名写法、没有主名的
 * 名字要整个退回，否则拼出来的是「-worktree.patch」，等于把文件名吃掉。
 */
export function patchStem(path: string): string {
  const name = basenameOf(path);
  const stem = name.replace(/\.[^.]+$/, "");
  return stem === "" ? name : stem;
}

/** 统一分隔符与末尾斜杠；Windows 形状的路径再忽略大小写。保留单个根斜杠 "/"。 */
function normPath(p: string): string {
  let flat = p.replace(/\\/g, "/");
  if (flat.length > 1 && flat.endsWith("/")) {
    flat = flat.replace(/\/+$/, "");
  }
  return isWindowsPath(flat) ? flat.toLowerCase() : flat;
}

/**
 * 两条路径是否指同一个文件。监听事件给的是系统原样写法（反斜杠、盘符大小写都可能和
 * 前端自己拼出来的那份不一样），所以先统一分隔符，Windows 形状的路径再忽略大小写。
 */
export function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

/**
 * 会话身份用的稳定路径写法：统一分隔符、Windows 盘符小写、去掉末尾斜杠。
 *
 * 语言服务的会话键是「server + 根」拼出来的字符串。同一个目录若因来源不同拿到
 * `D:/app/x` 与 `D:\app\x` 两种写法，会被当成两个工程根各起一条会话——同目录重复起进程、
 * 诊断与补全各算一遍。这里把两种写法归一到一处。
 */
export function canonicalPath(path: string): string {
  return normPath(path);
}

/**
 * `path` 是否落在 `ancestor` 这个目录里（或者就是它）。
 * 语言服务按工程根分会话，一份文档归哪条会话管问的是这个。
 */
export function pathWithin(ancestor: string, path: string): boolean {
  const base = normPath(ancestor);
  const target = normPath(path);
  if (target === base) return true;
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return target.startsWith(prefix);
}

/**
 * `Intl.DateTimeFormat` 造一次不算便宜（几十微秒量级），而提交列表一次渲染就要给
 * 两百行各算一遍时间。按「语言 + 形状」留三份复用，切语言时自然换键。
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(
  locale: string,
  shape: string,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = `${locale}|${shape}`;
  let hit = FORMATTERS.get(key);
  if (!hit) {
    hit = new Intl.DateTimeFormat(locale, options);
    FORMATTERS.set(key, hit);
  }
  return hit;
}

/**
 * 提交时间的紧凑写法：今天/昨天带时刻，本年只到月日，跨年补年份。
 * 「今天」「昨天」由调用方按当前语言传进来，这里不写死文案。
 */
export function commitStamp(ms: number, locale: string, today: string, yesterday: string): string {
  const date = new Date(ms);
  const now = new Date();
  const clock = formatter(locale, "clock", { hour: "2-digit", minute: "2-digit" });
  const day = date.toDateString();
  if (day === now.toDateString()) return `${today} ${clock.format(date)}`;
  if (day === new Date(now.getTime() - 86_400_000).toDateString()) {
    return `${yesterday} ${clock.format(date)}`;
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return formatter(locale, sameYear ? "month-day-clock" : "date", {
    year: sameYear ? undefined : "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: sameYear ? "2-digit" : undefined,
    minute: sameYear ? "2-digit" : undefined,
  }).format(date);
}
