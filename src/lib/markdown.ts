import DOMPurify from "dompurify";
import hljs from "highlight.js";
import { Marked } from "marked";
import { parseFileLink } from "./fileLinks";
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
 * 流式正文尚未写完时补齐未闭合的围栏（对照参考实现的 parseIncompleteMarkdown 的
 * 最小集）：模型正在敲一个代码块时，未闭合的 ``` 会把后半段正文整个吞进代码块，
 * 每次流式刷新都闪一下。只数围栏行、只补最后一行，不改别的语义。
 */
export function repairStreamingMarkdown(source: string): string {
  const count = (marker: string) => (source.match(new RegExp(`^[ \\t]*${marker}`, "gm")) ?? []).length;
  if (count("```") % 2 === 1) return `${source}\n\`\`\``;
  if (count("~~~") % 2 === 1) return `${source}\n~~~`;
  return source;
}

const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);

/**
 * 把高亮后的 HTML 按行切开：行尾把仍开着的标签补上闭合，下一行重新按原样打开。
 * 高亮的 `<span>` 可能跨多行（块注释一类），直接按 `\n` 切会产出未闭合的半截标签。
 */
function splitHtmlLines(html: string): string[] {
  const out: string[] = [];
  const stack: Array<{ name: string; raw: string }> = [];
  let line = "";
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
  const closeAll = () => stack.slice().reverse().map((tag) => `</${tag.name}>`).join("");
  const reopenAll = () => stack.map((tag) => tag.raw).join("");
  const append = (chunk: string) => {
    const parts = chunk.split("\n");
    for (let index = 0; index < parts.length; index++) {
      if (index > 0) {
        out.push(line + closeAll());
        line = reopenAll();
      }
      line += parts[index];
    }
  };
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    append(html.slice(last, match.index));
    last = re.lastIndex;
    const name = match[1].toLowerCase();
    if (match[0].startsWith("</")) {
      const at = stack.map((tag) => tag.name).lastIndexOf(name);
      if (at >= 0) stack.splice(at, 1);
      line += match[0];
    } else if (!match[0].endsWith("/>") && !VOID_TAGS.has(name)) {
      stack.push({ name, raw: match[0] });
      line += match[0];
    } else {
      line += match[0];
    }
  }
  append(html.slice(last));
  out.push(line + closeAll());
  return out;
}

/**
 * 高亮并包一个代码块。
 *
 * `copyLabel` 只在聊天里传：文档预览的复制按钮另有实现（React 组件），而聊天正文是
 * 一次性注入的 HTML，得把按钮直接写进标记里。按钮用 `span[role=button]` 而不是
 * `<button>`——聊天的白名单把 `button`、`svg` 都禁掉了，图标只能靠 CSS 画。
 * 聊天路径同时把正文按行包进 `<span class="cl">`：CSS 计数器给每行一个行号
 * （对照参考实现），复制仍取 textContent——行号画在伪元素里，不会混进复制的文本。
 */
/**
 * 高亮并包一个代码块。
 *
 * `copyLabel` 只在聊天里传：文档预览的复制按钮另有实现（React 组件），而聊天正文是
 * 一次性注入的 HTML，得把按钮直接写进标记里。按钮用 `span[role=button]` 而不是
 * `<button>`——聊天的白名单把 `button`、`svg` 都禁掉了，图标只能靠 CSS 画。
 * 聊天路径同时把正文按行包进 `<span class="cl">`：CSS 计数器给每行一个行号
 * （对照参考实现），复制仍取 textContent——行号画在伪元素里，不会混进复制的文本。
 *
 * 聊天路径的代码块收进 `<details class="code-fold">`：默认收起、点题头展开
 * （对照参考实现的折叠代码块）。`openBlocks` 为真（流式输出中）时保持展开——
 * 流式每次整段重渲染，不展开的话刚写的代码块会闪没了。
 */
export function renderCodeBlock(text: string, lang: string | null | undefined, copyLabel?: string, openBlocks = false, startLine?: number): string {
  const cleanLang = (lang || "").trim().split(/\s+/)[0].toLowerCase();
  let highlighted: string;
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
      highlighted = hljs.highlightAuto(text).value;
    } catch {
      highlighted = escapeHtml(text);
    }
  }
  const langClass = cleanLang ? ` language-${escapeHtml(cleanLang)}` : "";
  const tag = cleanLang ? `<span class="code-lang-tag">${escapeHtml(cleanLang)}</span>` : "";
  const copy = copyLabel
    ? `<span class="code-copy" role="button" tabindex="0" data-code-copy="1" aria-label="${escapeHtml(copyLabel)}">${escapeHtml(copyLabel)}</span>`
    : "";
  // 行号：聊天代码块从 1 起；明细里的读取内容带真实文件行号（startLine），计数器直接从那一行起数。
  const numbered = copyLabel || startLine !== undefined;
  const body = numbered
    ? splitHtmlLines(highlighted).map((lineHtml) => `<span class="cl">${lineHtml}</span>`).join("\n")
    : highlighted;
  const reset = startLine !== undefined && startLine > 1 ? ` style="counter-reset: ai-code-line ${startLine - 1}"` : "";
  const pre = `<pre><code class="hljs${langClass}"${reset}>${body}</code></pre>`;
  if (!copyLabel) return `<div class="code-block-wrapper">${tag}${copy}${pre}</div>`;
  const chevron = '<span class="code-fold-chevron" aria-hidden="true"></span>';
  return `<div class="code-block-wrapper"><details class="code-fold"${openBlocks ? " open" : ""}><summary class="code-head">${tag}${chevron}${copy}</summary>${pre}</details></div>`;
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
        return renderCodeBlock(text, lang);
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

/**
 * 渲染聊天正文成可安全注入的 HTML。
 *
 * 和文档预览分开是因为信任边界不同：聊天里的 markdown 出自模型输出，图片、表单、
 * 内联样式、`<svg>` 一律禁掉，只留排版标签。链接不做磁盘解析（聊天没有「本文档所在
 * 目录」这个概念），但认出指向本地文件的写法，改成 `data-file-path` / `data-file-line`
 * 标记交给上层跳行，见 {@link parseFileLink}。
 *
 * @param source markdown 正文
 * @param copyLabel 逐代码块复制按钮的文案，随界面语言变化
 */
export function renderChatMarkdown(source: string, copyLabel: string, openBlocks = false): string {
  const parser = new Marked({ gfm: true, breaks: false });
  parser.use({
    renderer: {
      code({ text, lang }) {
        return renderCodeBlock(text, lang, copyLabel, openBlocks);
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const file = parseFileLink(href);
        if (file) {
          const position = file.line !== undefined ? `:${file.line}${file.column !== undefined ? `:${file.column}` : ""}` : "";
          const titleAttr = title ?? `${file.path}${position}`;
          const line = file.line !== undefined ? ` data-file-line="${file.line}"` : "";
          const column = file.column !== undefined ? ` data-file-column="${file.column}"` : "";
          return `<a class="ai-file-link" href="#" data-file-path="${escapeHtml(file.path)}"${line}${column} title="${escapeHtml(titleAttr)}">${inner}</a>`;
        }
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        return `<a href="${escapeHtml(href)}"${titleAttr}>${inner}</a>`;
      },
    },
  });
  return DOMPurify.sanitize(parser.parse(source, { async: false }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "picture", "source", "video", "audio", "iframe", "object", "embed", "style", "form", "input", "button", "svg", "math", "link", "meta", "base"],
    FORBID_ATTR: ["style", "src", "srcset", "autofocus", "background", "poster", "ping"],
    // data-file-* 是上面给本地文件链接打的标记，html 档默认保留 data-*，这里只补一条说明。
  });
}
