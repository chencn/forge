import { renderChatTokenBlocks } from "./chatMarkdownCore";

/**
 * 聊天 markdown 的渲染 Worker。
 *
 * marked 解析与 highlight.js 高亮都发生在这里，主线程只剩 DOMPurify 清洗与
 * innerHTML 提交。Worker 里没有 window，DOMPurify 干不了活——所以这份 Worker 只出
 * 「未清洗」的逐块 HTML，清洗由主线程按块缓存着做（见 chatMarkdownAsync）。
 *
 * 请求串行处理即可：一次一帧全文渲染本身就是流水线，排队不会饿死谁。
 */

interface RenderRequest {
  id: number;
  source: string;
  copyLabel: string;
  openBlocks: boolean;
}

self.onmessage = (event: MessageEvent<RenderRequest>) => {
  const { id, source, copyLabel, openBlocks } = event.data;
  try {
    const blocks = renderChatTokenBlocks(source, copyLabel, openBlocks);
    (self as unknown as Worker).postMessage({ id, blocks });
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: String(error) });
  }
};
