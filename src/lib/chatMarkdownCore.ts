import { Marked, Parser, Renderer } from "marked";
import { parseFileLink } from "./fileLinks";
import { escapeHtml, highlightCodeHtml } from "./cm/grammars";

/**
 * 聊天 markdown 的 DOM 无关核心：marked 实例、代码高亮、流式围栏修补、
 * 按 token 切分与渲染。不碰 DOMPurify——清洗必须留在有 DOM 的一侧（Worker 里
 * 没有 window），所以这份核心可以同时进主线程与渲染 Worker。
 *
 * marked 的模型是两遍的：先切块（收集 `[ref]: url` 定义），再对全部块做行内解析。
 * 因此按顶层 token 渲染是语义精确的——行内 token 在 lex 时就已带着完整的定义表
 * 解析完，之后逐块交给 Parser 只是出 HTML，不再有跨块上下文。
 */

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

/**
 * 按语言高亮；语法包还没装上（首次遇到这门语言的那一帧）或解析抛错时退回转义后的原文。
 *
 * 不再自动猜语言：highlight.js 的 highlightAuto 会对全表回溯试探，一段贴错的正文
 * 就会被染成莫名其妙的颜色。Lezer 与 IDEA 一样，围栏没标语言就按素文本排。
 */
function highlightCode(text: string, cleanLang: string): string {
  return highlightCodeHtml(text, cleanLang) ?? escapeHtml(text);
}

/**
 * 高亮并包一个代码块。
 *
 * `copyLabel` 只在聊天里传：文档预览的复制按钮另有实现（React 组件），而聊天正文是
 * 一次性注入的 HTML，得把按钮直接写进标记里。按钮用 `span[role=button]` 而不是
 * `<button>`——聊天的白名单把 `button`、`svg` 都禁掉了，图标只能靠 CSS 画。
 *
 * 正文代码块正常直出，不折叠、不套特殊题头卡片、不带折叠扣。
 * 不对正文逐行包 `span.cl`，避免 `display: block` 与换行符在 `white-space: pre` 下
 * 叠加导致单行代码占双倍行高。仅在显式传入真实文件行号（startLine）时才做切行编号。
 */
export function renderCodeBlock(text: string, lang: string | null | undefined, copyLabel?: string, startLine?: number): string {
  const cleanLang = (lang || "").trim().split(/\s+/)[0].toLowerCase();
  const highlighted = highlightCode(text, cleanLang);
  const langClass = cleanLang ? ` language-${escapeHtml(cleanLang)}` : "";
  const tag = cleanLang ? `<span class="code-lang-tag">${escapeHtml(cleanLang)}</span>` : "";
  const copy = copyLabel
    ? `<span class="code-copy" role="button" tabindex="0" data-code-copy="1" aria-label="${escapeHtml(copyLabel)}">${escapeHtml(copyLabel)}</span>`
    : "";
  // 仅在明确指定了起始行号时才编号；普通正文代码段直接输出，避免每行产生双倍行高
  const numbered = startLine !== undefined;
  // Lezer 每个换行都重新起一段，token 的 span 不会跨行，直接按 \n 切就是逐行闭合的。
  const body = numbered
    ? highlighted.split("\n").map((lineHtml) => `<span class="cl">${lineHtml}</span>`).join("")
    : highlighted;
  const reset = startLine !== undefined && startLine > 1 ? ` style="counter-reset: ai-code-line ${startLine - 1}"` : "";
  const pre = `<pre><code class="${langClass.trim()}"${reset}>${body}</code></pre>`;
  return `<div class="code-block-wrapper">${tag}${copy}${pre}</div>`;
}

let activeChatCopyLabel = "";

function chatCode({ text, lang }: { text: string; lang?: string | null }): string {
  return renderCodeBlock(text, lang, activeChatCopyLabel);
}

function chatCheckbox({ checked }: { checked: boolean }): string {
  // GFM 任务列表复选框：用无害的只读 span 替换 input，避免被聊天的 DOMPurify 白名单删除。
  return checked
    ? '<span class="ai-task-checkbox is-checked" aria-hidden="true"></span> '
    : '<span class="ai-task-checkbox" aria-hidden="true"></span> ';
}

type InlineTokens = import("marked").Tokens.Generic[] & { links?: unknown };

function chatLink(
  { href, title, tokens }: { href: string; title?: string | null; tokens: InlineTokens },
  parseInline: (tokens: InlineTokens) => string
): string {
  const inner = parseInline(tokens);
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
}

/** 整段解析共用的 Marked 实例：renderer 挂钩与下面的逐 token 路径是同一批函数。 */
const chatParser = new Marked({ gfm: true, breaks: false });
chatParser.use({
  renderer: {
    code: chatCode,
    checkbox: chatCheckbox,
    link(token) {
      // 对象式挂钩的 this 带着所属 parser，行内解析得靠它。
      return chatLink(token, (inline) => this.parser.parseInline(inline as never));
    },
  },
});

/** 逐 token 渲染共用的独立 Parser：同一个 renderer，绕开 Marked.parse 只收字符串的限制。 */
const blockRenderer = new Renderer();
blockRenderer.code = chatCode;
blockRenderer.checkbox = chatCheckbox;
const blockParser = new Parser({ gfm: true, breaks: false, renderer: blockRenderer });
blockRenderer.link = (token) => chatLink(token, (inline) => blockParser.parseInline(inline as never));

/** 整段解析（不清洗）：给主线程的 DOMPurify 包装层复用同一套解析配置。 */
export function renderChatHtmlRaw(source: string, copyLabel: string): string {
  activeChatCopyLabel = copyLabel;
  const html = chatParser.parse(source, { async: false });
  return typeof html === "string" ? html : "";
}

/**
 * 块指纹（cyrb53：两路混合出 53 位）。LRU 拿它当键复用清洗结果，等长碰撞会把
 * 上一块洗好的 HTML 张冠李戴，所以只用 32 位不够；53 位在缓存规模（≤2000 条）下
 * 意外碰撞概率可忽略。防的是意外不是攻击——输入是自家模型输出。
 */
export function blockKey(raw: string, copyLabel: string, openBlocks: boolean): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < raw.length; index++) {
    const ch = raw.charCodeAt(index);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const fingerprint = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${openBlocks ? "s" : "d"}:${copyLabel}:${fingerprint.toString(36)}:${raw.length}`;
}

/**
 * 把正文按顶层 token 切开并逐块渲染（不做清洗）。
 *
 * 返回的 key 是 token 原文的指纹：内容没变的块，调用方可以原样复用上一次的
 * 清洗结果与 DOM，流式刷新的成本就只剩最后那一个在变的块。
 *
 * 语法包是懒加载的，而 marked 的 renderer 只能同步返回。所以调用方必须先
 * `await prepareHighlight(fenceLanguages(source))` 把这篇用过的语言装进内存再进来，
 * 否则第一次遇到某门语言的那一帧，代码块会是素文本。
 */
export function renderChatTokenBlocks(source: string, copyLabel: string, openBlocks: boolean): Array<{ key: string; html: string }> {
  activeChatCopyLabel = copyLabel;
  const tokens = chatParser.lexer(source);
  const out: Array<{ key: string; html: string }> = [];
  for (const token of tokens) {
    if (token.type === "space") continue;
    const html = blockParser.parse([token]);
    if (!html) continue;
    out.push({ key: blockKey(token.raw, copyLabel, openBlocks), html });
  }
  return out;
}
