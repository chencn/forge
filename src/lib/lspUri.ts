/**
 * LSP 的 `file://` URI 与本地路径互转。
 *
 * 输出必须和原来 Monaco 的 `Uri.file(path).toString()` 逐字节一样：这套串早就发给了语言服务，
 * 服务器按它认文档、按它回诊断——串一变，`didOpen` 与后面的请求就不是同一份身份，
 * 表现为「语言服务明明在跑，补全和诊断全无」。规则是 RFC3986 那一套，抄 VS Code 的 URI 实现：
 * 盘符小写、冒号写成 `%3A`、斜杠留着不编码，其余非「未保留字符」全部百分号编码（UTF-8）。
 */
/**
 * 这台跑在 Windows 上吗——判定与 Monaco 的 `isWindows` 一模一样：
 * 有 node 那层（测试、SSR）看 `process.platform`，只有浏览器（应用的 webview）看 UA。
 * 两边不一致的话，测试里对得上的写法到应用里就变了。
 */
const IS_WINDOWS = (() => {
  const nodeProcess =
    typeof process !== "undefined" && typeof process?.versions?.node === "string" ? process : null;
  if (nodeProcess) return nodeProcess.platform === "win32";
  return typeof navigator === "object" && navigator.userAgent.indexOf("Windows") >= 0;
})();

/** 这些字符在路径里有专门含义或被 URI 实现当成保留字，逐个换成固定写法。 */
const ENCODED: Record<number, string> = {
  58: "%3A", // :
  47: "%2F", // /
  63: "%3F", // ?
  35: "%23", // #
  91: "%5B", // [
  93: "%5D", // ]
  64: "%40", // @
  33: "%21", // !
  36: "%24", // $
  38: "%26", // &
  39: "%27", // '
  40: "%28", // (
  41: "%29", // )
  42: "%2A", // *
  43: "%2B", // +
  44: "%2C", // ,
  59: "%3B", // ;
  61: "%3D", // =
  32: "%20", // 空格
};

/** 未保留字符（字母数字与 `-._~`）加上路径里的 `/` 原样留着。 */
function kept(code: number, isPath: boolean): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 45 ||
    code === 46 ||
    code === 95 ||
    code === 126 ||
    (isPath && code === 47)
  );
}

/**
 * 按 URI 的口径编码一段。
 *
 * 攒着连续要「原生编码」的字符一次交给 `encodeURIComponent`：中文这类要靠代理对合成
 * 一个码点，逐字符编码会把它们拆坏。
 */
function encodeSegment(text: string, isPath: boolean): string {
  let out: string | undefined;
  let plainFrom = -1;
  for (let pos = 0; pos < text.length; pos++) {
    const code = text.charCodeAt(pos);
    if (kept(code, isPath)) {
      if (plainFrom !== -1) {
        out += encodeURIComponent(text.slice(plainFrom, pos));
        plainFrom = -1;
      }
      if (out !== undefined) out += text.charAt(pos);
      continue;
    }
    if (out === undefined) out = text.slice(0, pos);
    const escaped = ENCODED[code];
    if (escaped !== undefined) {
      if (plainFrom !== -1) {
        out += encodeURIComponent(text.slice(plainFrom, pos));
        plainFrom = -1;
      }
      out += escaped;
    } else if (plainFrom === -1) {
      plainFrom = pos;
    }
  }
  if (plainFrom !== -1) out += encodeURIComponent(text.slice(plainFrom));
  return out === undefined ? text : out;
}

/**
 * 本地路径 → `file://` URI。
 *
 * Windows 上反斜杠先换成正斜杠（那边它是分隔符），UNC 的第二段是主机名，得放进 authority；
 * 盘符那一份 URI 里统一小写（`file:///d%3A/app`），与语言服务自己规范化出来的写法一致。
 */
export function pathToUri(path: string): string {
  let working = IS_WINDOWS ? path.replace(/\\/g, "/") : path;
  let authority = "";
  if (working[0] === "/" && working[1] === "/") {
    const idx = working.indexOf("/", 2);
    if (idx === -1) {
      authority = working.slice(2);
      working = "/";
    } else {
      authority = working.slice(2, idx);
      working = working.slice(idx) || "/";
    }
  }
  // `file` 这条 scheme 的 path 恒以斜杠开头：少了就补，空串就是一条斜杠（原来那版同样补）。
  if (working === "") working = "/";
  else if (working[0] !== "/") working = `/${working}`;
  // 盘符小写：语言服务规范化出来的写法就是这样。
  if (working.length >= 3 && working.charCodeAt(0) === 47 && working.charCodeAt(2) === 58) {
    const code = working.charCodeAt(1);
    if (code >= 65 && code <= 90) working = `/${String.fromCharCode(code + 32)}${working.slice(2)}`;
  }
  const host = authority === "" ? "" : `//${encodeSegment(authority.toLowerCase(), false)}`;
  // `file` 这条 scheme 恒带 `//`，authority 为空就是那三条斜杠。
  return `file:${host || "//"}${encodeSegment(working, true)}`;
}

/**
 * `file://` URI → 本地路径。
 *
 * 只用来当诊断与文档的键，末尾交给 `canonicalPath` 归一，所以分隔符保持正斜杠即可；
 * 盘符照 URI 的写法小写，UNC 把主机名拼回去。不是 `file` 就交回空串（原来那版也拿不到路径）。
 */
export function uriToPath(uri: string): string {
  const match = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/.exec(uri);
  if (!match || match[2] !== "file") return "";
  const authority = decode(match[4] ?? "");
  let path = decode(match[5] ?? "");
  if (authority !== "" && path.length > 1) return `//${authority}${path}`;
  if (
    path.charCodeAt(0) === 47 &&
    ((path.charCodeAt(1) >= 65 && path.charCodeAt(1) <= 90) ||
      (path.charCodeAt(1) >= 97 && path.charCodeAt(1) <= 122)) &&
    path.charCodeAt(2) === 58
  ) {
    return path[1].toLowerCase() + path.slice(2);
  }
  return path;
}

/** 百分号解码；文件名里真的写了 `%zz` 这类不合法的序列时原样留着，不抛。 */
function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/%[0-9A-Fa-f]{2}/g, (item) => {
      try {
        return decodeURIComponent(item);
      } catch {
        return item;
      }
    });
  }
}
