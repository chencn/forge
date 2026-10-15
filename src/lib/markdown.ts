import DOMPurify from "dompurify";
import hljs from "highlight.js";
import { Marked } from "marked";
import { resolveRelative, isWindowsPath, nativeSeparators } from "./format";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 链接是不是要走系统浏览器：绝对 URL 带协议，或协议相对（//host）。 */
function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

/**
 * 把 markdown 里的图片/链接地址解析成能用的 URL。
 *
 * - `http(s)://`、`data:` 等绝对地址原样用。
 * - 相对路径按文档所在目录还原成绝对路径；图片交给 `assetOf` 变成 asset URL，
 *   链接则保留绝对路径（交给上层决定点开行为）。
 * - `#anchor` 留给页内跳转。
 */
function resolveHref(
  href: string,
  docDir: string,
  assetOf: (absolute: string) => string
): { url: string; local: string | null } {
  if (href === "" || href.startsWith("#")) return { url: href, local: null };
  if (isExternal(href) || href.startsWith("data:")) return { url: href, local: null };
  // 查询串与片段要从路径上摘下来，否则会当成文件名的一部分。
  const match = /^([^?#]*)([?#].*)?$/.exec(href);
  const rawPath = match?.[1] ?? href;
  const suffix = match?.[2] ?? "";
  // 百分号编码可能不合法（作者手写的 `%` 之类），解不开就按原样用。
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    decoded = rawPath;
  }
  const absolute = isWindowsPath(decoded)
    ? nativeSeparators(decoded)
    : resolveRelative(docDir, decoded);
  return { url: assetOf(absolute) + suffix, local: absolute };
}

/**
 * 渲染 markdown 成可安全注入的 HTML。
 *
 * 两个关口：marked 把正文转成 HTML，DOMPurify 再洗一遍，去掉脚本、事件处理器等
 * 能执行的东西。地址改写只做两件事：本地图片换成 asset 协议的 URL，外链打上标记
 * 好让点击时交给系统浏览器。
 *
 * @param source markdown 正文
 * @param docPath 这份文档的绝对路径，相对图片按它所在目录解析
 * @param assetOf 绝对路径 → 可放进 <img src> 的 URL
 */
export function renderMarkdown(
  source: string,
  docPath: string,
  assetOf: (absolute: string) => string
): string {
  const docDir = docPath.replace(/[\\/][^\\/]*$/, "") || docPath;

  const parser = new Marked({ gfm: true, breaks: false });

  parser.use({
    renderer: {
      code({ text, lang }) {
        const cleanLang = (lang || "").trim().split(/\s+/)[0].toLowerCase();
        let highlighted = "";
        if (cleanLang && hljs.getLanguage(cleanLang)) {
          try {
            highlighted = hljs.highlight(text, { language: cleanLang, ignoreIllegals: true }).value;
          } catch {
            highlighted = escapeHtml(text);
          }
        } else if (cleanLang === "plaintext" || cleanLang === "text" || cleanLang === "txt") {
          highlighted = escapeHtml(text);
        } else {
          // 未显式指定语言或未知语言时，自动检测高亮
          try {
            const auto = hljs.highlightAuto(text);
            highlighted = auto.value;
          } catch {
            highlighted = escapeHtml(text);
          }
        }
        const langClass = cleanLang ? ` language-${escapeHtml(cleanLang)}` : "";
        const tag = cleanLang ? `<span class="code-lang-tag">${escapeHtml(cleanLang)}</span>` : "";
        return `<div class="code-block-wrapper">${tag}<pre><code class="hljs${langClass}">${highlighted}</code></pre></div>`;
      },
      image({ href, title, text }) {
        const { url } = resolveHref(href, docDir, assetOf);
        const alt = text.replace(/"/g, "&quot;");
        const titleAttr = title ? ` title="${title.replace(/"/g, "&quot;")}"` : "";
        return `<img src="${url}" alt="${alt}"${titleAttr}>`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const { url, local } = resolveHref(href, docDir, assetOf);
        const titleAttr = title ? ` title="${title.replace(/"/g, "&quot;")}"` : "";
        // 判据用原始 href，不用解析后的 url：本地文件的 url 已经被换成 asset 协议，
        // 拿它判 isExternal 会把本地文档错当成外链。本地文件打 data-local，
        // 外链打 data-external，其余（页内锚点）原样交给浏览器。
        if (local) {
          return `<a href="${url}"${titleAttr} data-local="${local.replace(/"/g, "&quot;")}">${inner}</a>`;
        }
        if (isExternal(href) && !href.startsWith("data:")) {
          return `<a href="${url}"${titleAttr} data-external="1">${inner}</a>`;
        }
        return `<a href="${url}"${titleAttr}>${inner}</a>`;
      },
    },
  });

  const raw = parser.parse(source, { async: false });
  return DOMPurify.sanitize(raw, {
    // data-* 要留着：上面打的两个标记靠它把点击导去系统程序；class 供代码高亮样式用。
    ADD_ATTR: ["data-external", "data-local", "target", "class"],
    // DOMPurify 默认放行 http(s)/mailto/data 与相对地址，唯独不认 asset 协议——
    // 那是非 Windows 平台上本地图片的 scheme，补进去。协议本身在 CSP 里另有约束。
    ALLOWED_URI_REGEXP:
      /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|asset):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  });
}
