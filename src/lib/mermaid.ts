/**
 * md 预览里的 Mermaid 图。`renderMarkdown` 只把 ```mermaid 围栏包成一个
 * `[data-mermaid]` 占位（源码留在占位里），真正的 SVG 由这里补上。
 * 库本身第一次用到才 import，不占首屏。
 */
import type { Mermaid } from "mermaid";
import { computedColor } from "./color";

/** mermaid 占位元素的选择器（renderMarkdown 生成的约定）。 */
export const MERMAID_SELECTOR = "[data-mermaid]";
/** 渲染结果容器的 class。 */
const OUTPUT_CLASS = "mermaid-output";
/** 占位元素上标记渲染状态的属性（ok / error / pending）。 */
const RENDERED_ATTR = "data-mermaid-state";

/** 一次渲染的结果：SVG 或错误消息。 */
type Result = { svg: string } | { error: string };

/** 库模块的动态 import 单例（失败时置回 null 允许重试）。 */
let loading: Promise<Mermaid> | null = null;
/** 已生效的配置身份（{@link themeKey}），一致则不再重复 initialize。 */
let configured = "";
/** 临时渲染节点 id 的自增序号。 */
let seq = 0;
/** 按「主题 + 源码」缓存：改文档别处不该把图重画一遍。 */
const cache = new Map<string, Result>();
/** 渲染结果缓存的容量上限，超出按插入序淘汰。 */
const CACHE_LIMIT = 64;
/** mermaid 的 render 换配置期间不可重入，一次只画一张。 */
let queue: Promise<unknown> = Promise.resolve();

/** 懒加载 mermaid 库（首次调用触发动态 import，结果复用）。 */
function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then((m) => m.default);
  loading.catch(() => (loading = null));
  return loading;
}

/** 主题身份：凡是会让下面那批令牌变色的东西。 */
export function themeKey(): string {
  return document.documentElement.dataset.theme ?? "";
}

/** 主题属性换了就回调（图是缓存的，配色得跟着重算）。 */
export function subscribeTheme(cb: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(cb);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/**
 * 图的配色取自应用自己的令牌，所以深浅色切换后图不会跳成另一套颜色。
 *
 * `securityLevel: "strict"` 是这模块的安全边界：模型或别人给的 .md 里写的标签文本
 * 一律转义、不绑事件、不外链。CSP 那头的 `script-src 'self'` 是第二道。
 */
function themeVariables(): Record<string, string | boolean> {
  const token = (...names: string[]) => {
    for (const name of names) {
      const value = computedColor(name);
      if (value) return value;
    }
    return undefined;
  };
  const vars: Record<string, string | undefined> = {
    background: token("--bg-editor", "--bg-primary"),
    mainBkg: token("--bg-tertiary"),
    primaryColor: token("--bg-tertiary"),
    primaryBorderColor: token("--border-light"),
    primaryTextColor: token("--text-primary"),
    secondaryColor: token("--surface-island"),
    tertiaryColor: token("--bg-hover"),
    lineColor: token("--text-secondary"),
    textColor: token("--text-primary"),
    edgeLabelBackground: token("--bg-editor", "--bg-primary"),
    errorBkgColor: token("--bg-tertiary"),
    errorTextColor: token("--accent-red"),
  };
  const out: Record<string, string | boolean> = { darkMode: themeKey() !== "light" };
  for (const [key, value] of Object.entries(vars)) if (value) out[key] = value;
  const font = getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim();
  if (font) out.fontFamily = font;
  return out;
}

/** 按主题身份初始化 mermaid（strict 安全级别 + 应用令牌配色）；已配置同主题则跳过。 */
function configure(mermaid: Mermaid, key: string) {
  if (configured === key) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "base",
    themeVariables: themeVariables(),
  });
  configured = key;
}

/** 清理 mermaid 渲染时挂在 body 上的临时量尺节点。 */
function removeTemp(id: string) {
  // mermaid 量文本尺寸时往 <body> 挂临时节点：d<id>（开沙箱时还有 i<id>），画完得收干净。
  for (const tmp of [`d${id}`, `i${id}`, id]) document.getElementById(tmp)?.remove();
}

/** 渲染一段 mermaid 源码为 SVG 并注入量尺完成排版。 */
async function renderOne(source: string, key: string): Promise<Result> {
  const mermaid = await loadMermaid();
  configure(mermaid, key);
  const id = `forge-mermaid-${++seq}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return { svg };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message.trim() || "Invalid diagram" };
  } finally {
    removeTemp(id);
  }
}

/** 轮到自己时这一趟已经被更新了取代，就返回 null。 */
function enqueue(source: string, key: string, live: () => boolean): Promise<Result | null> {
  const next = queue.then(() => (live() ? renderOne(source, key) : null));
  queue = next.catch(() => undefined);
  return next;
}

/** 结果入缓存；满则按插入序淘汰最旧一条。 */
function remember(key: string, result: Result) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, result);
}

/** `stale` 是上一次那张图：新图还在画就先顶着，边打字边预览时不闪空白。 */
function show(block: HTMLElement, result: Result | null, stale?: Node) {
  block.querySelector(`:scope > .${OUTPUT_CLASS}`)?.remove();
  const out = document.createElement("div");
  out.className = OUTPUT_CLASS;
  if (result && "svg" in result) {
    out.innerHTML = result.svg;
    block.setAttribute(RENDERED_ATTR, "ok");
  } else if (result) {
    out.setAttribute("role", "alert");
    out.textContent = result.error;
    block.setAttribute(RENDERED_ATTR, "error");
  } else if (stale) {
    out.append(stale.cloneNode(true));
    block.setAttribute(RENDERED_ATTR, "ok");
  } else {
    block.setAttribute(RENDERED_ATTR, "pending");
    return;
  }
  block.append(out);
}

/** root 里有没有还没处理的 mermaid 占位。 */
export const hasMermaid = (root: ParentNode) => root.querySelector(MERMAID_SELECTOR) !== null;

/** 一轮渲染趟次的句柄：是否含异步图、完成时机与取消。 */
export interface MermaidPass {
  /** 这一趟里有没有图还在异步画（画完会改变布局，滚动联动要跟着重来）。 */
  async: boolean;
  /** 这一趟所有图都到位（或被取消）时落定。 */
  done: Promise<void>;
  cancel(): void;
}

/**
 * 把 `root` 下面的占位画成图。`previous` 按块序号存着上一次画好的节点，原地更新，
 * 某一张变了时其余的拿缓存同步贴上、改过的那张先顶旧图——缓存命中的不异步。
 */
export function renderMermaidIn(root: HTMLElement, previous: Node[] = []): MermaidPass {
  const blocks = [...root.querySelectorAll<HTMLElement>(MERMAID_SELECTOR)];
  let live = true;
  if (!blocks.length) return { async: false, done: Promise.resolve(), cancel: () => {} };
  const key = themeKey();
  const pending: Promise<void>[] = [];
  blocks.forEach((block, index) => {
    const source = (block.querySelector("code")?.textContent ?? "").replace(/\n+$/, "");
    const cacheKey = `${key}\n${source}`;
    const cached = cache.get(cacheKey);
    const keep = () => {
      const out = block.querySelector(`:scope > .${OUTPUT_CLASS}`);
      if (out && block.getAttribute(RENDERED_ATTR) === "ok") previous[index] = out.firstChild ?? out;
    };
    if (cached) {
      show(block, cached);
      keep();
      return;
    }
    show(block, null, previous[index]);
    pending.push(
      enqueue(source, key, () => live).then((result) => {
        if (!result) return;
        remember(cacheKey, result);
        if (!live) return;
        show(block, result);
        keep();
      })
    );
  });
  previous.length = blocks.length;
  return {
    async: pending.length > 0,
    done: Promise.all(pending).then(() => undefined),
    cancel: () => {
      live = false;
    },
  };
}
