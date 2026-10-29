import { renderChatTokenBlocks } from "./chatMarkdownCore";
import { fenceLanguages, prepareHighlight } from "./cm/grammars";

/**
 * 聊天 markdown 的渲染 Worker。
 *
 * marked 解析与 Lezer 高亮都发生在这里，主线程只剩 DOMPurify 清洗与 innerHTML 提交。
 * Worker 里没有 window，DOMPurify 干不了活——所以这份 Worker 只出「未清洗」的逐块
 * HTML，清洗由主线程按块缓存着做（见 chatMarkdownAsync）。
 *
 * 高亮必须在这里出终态 HTML：主线程拿到的是一整段 innerHTML，事后往里面补 span，
 * 下一帧提交就把它冲掉了。所以先把这篇用过的围栏语法装上，再进同步渲染核心。
 * 语法包按语言只装一次，之后 prepareHighlight 立刻返回，不拖慢流式帧。
 *
 * 一条消息一个 id，回复按 id 归位，因此两次渲染交错完成也不会有人拿到别人的块。
 */

interface RenderRequest {
  id: number;
  source: string;
  copyLabel: string;
  openBlocks: boolean;
}

self.onmessage = (event: MessageEvent<RenderRequest>) => {
  const { id, source, copyLabel, openBlocks } = event.data;
  void (async () => {
    try {
      await prepareHighlight(fenceLanguages(source));
      const blocks = renderChatTokenBlocks(source, copyLabel, openBlocks);
      (self as unknown as Worker).postMessage({ id, blocks });
    } catch (error) {
      (self as unknown as Worker).postMessage({ id, error: String(error) });
    }
  })();
};
