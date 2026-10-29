import { renderChatTokenBlocks } from "./chatMarkdownCore";
import { sanitizeChatHtml } from "./chatSanitize";
import { fenceLanguages, prepareHighlight } from "./cm/grammars";

export interface ChatBlock {
  key: string;
  html: string;
}

/**
 * 聊天 markdown 的增量渲染入口。
 *
 * 解析与高亮在渲染 Worker 里跑（marked + Lezer），这里收下逐块 HTML 后只在主线程做
 * 两件事：对新出现的块做 DOMPurify 清洗（按块 LRU 缓存，内容没变的块直接复用上次结果），
 * 再把块按顺序拼回整段。流式刷新时绝大多数块原样复用，真正的成本只剩最后那个在变的块。
 *
 * 没有 Worker 的环境（vitest、SSR、worker 创建失败）整条链走主线程兜底，行为与 Worker
 * 一致——包括先把围栏语法装上，所以兜底那一路出的也是带高亮的终态。
 */

/** 单块清洗结果的 LRU；按 token 指纹命中，流式中历史块永不重洗。 */
const SANITIZE_LIMIT = 2000;
const sanitizeCache = new Map<string, string>();

function sanitizeBlock(key: string, html: string): string {
  const cached = sanitizeCache.get(key);
  if (cached !== undefined) return cached;
  const clean = sanitizeChatHtml(html);
  if (sanitizeCache.size >= SANITIZE_LIMIT) {
    const first = sanitizeCache.keys().next().value;
    if (first) sanitizeCache.delete(first);
  }
  sanitizeCache.set(key, clean);
  return clean;
}

function sanitizeAll(blocks: ChatBlock[]): ChatBlock[] {
  return blocks.map((block) => ({ key: block.key, html: sanitizeBlock(block.key, block.html) }));
}

/** 主线程兜底：与 Worker 同一条链——先把围栏语法装上，再按块出，最后清洗。 */
async function renderSync(source: string, copyLabel: string, openBlocks: boolean): Promise<ChatBlock[]> {
  await prepareHighlight(fenceLanguages(source));
  return sanitizeAll(renderChatTokenBlocks(source, copyLabel, openBlocks));
}

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, (blocks: ChatBlock[]) => void>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  try {
    const instance = new Worker(new URL("./chatMarkdownWorker.ts", import.meta.url), { type: "module" });
    instance.onmessage = (event: MessageEvent<{ id: number; blocks?: ChatBlock[]; error?: string }>) => {
      const resolve = pending.get(event.data.id);
      pending.delete(event.data.id);
      if (!resolve) return;
      if (event.data.error || !event.data.blocks) {
        // Worker 内抛错的那一帧退回主线程全量渲染：宁可慢一帧，不能空一块。
        // source 在请求闭包里，这里拿不到——onmessage 的兜底只对挂起表里还活着的
        // 请求生效，超时兜底交给调用方的 abort 标记。
        resolve([]);
        return;
      }
      resolve(event.data.blocks);
    };
    instance.onerror = () => {
      // 脚本级失败（加载失败等）直接弃用：后续请求全部走主线程兜底。
      worker = null;
    };
    worker = instance;
    return instance;
  } catch {
    worker = null;
    return null;
  }
}

/**
 * 按块渲染聊天正文。`signal.aborted` 置真后到来的结果会被丢弃——组件卸载或
 * 正文又变了时，旧一帧的结果不该再写进状态。
 */
export function renderChatMarkdownBlocks(
  source: string,
  copyLabel: string,
  openBlocks: boolean,
  signal?: { aborted: boolean }
): Promise<ChatBlock[]> {
  if (!source) return Promise.resolve([]);
  const instance = ensureWorker();
  if (!instance) return renderSync(source, copyLabel, openBlocks);
  const id = nextRequestId++;
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      // Worker 假死（极少见）：放弃等待，主线程自己算，别让一条消息永远空着。
      if (pending.delete(id)) void renderSync(source, copyLabel, openBlocks).then((blocks) => {
        if (!signal?.aborted) resolve(blocks);
      });
    }, 3000);
    pending.set(id, (blocks) => {
      window.clearTimeout(timeout);
      if (signal?.aborted) return;
      // 空结果说明那一帧在 Worker 里失败了：退回主线程全量渲染兜底。
      if (blocks.length) resolve(sanitizeAll(blocks));
      else void renderSync(source, copyLabel, openBlocks).then(resolve);
    });
    instance.postMessage({ id, source, copyLabel, openBlocks });
  });
}
