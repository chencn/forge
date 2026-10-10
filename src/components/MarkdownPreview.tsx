import { useEffect, useMemo, useRef } from "react";
import { assetUrl, openExternal } from "../lib/fs";
import { renderMarkdown } from "../lib/markdown";

interface MarkdownPreviewProps {
  /** markdown 正文。 */
  source: string;
  /** 这份文档的绝对路径；相对图片按它所在目录解析。 */
  docPath: string;
  /** 点本地链接（相对路径的图片或文件）时打开它。 */
  onOpenLocal: (absolute: string) => void;
}

/**
 * markdown 的渲染视图。
 *
 * 正文由 marked 转成 HTML、DOMPurify 洗过后注入；图片的地址在这一步就换成了
 * asset 协议的 URL，所以本地图片与线上图片走的是同一条 <img> 路径。
 * 链接的点击在容器上统一拦一次：外链交系统浏览器，本地文件交编辑器，
 * 页内锚点留给浏览器自己滚。
 */
export default function MarkdownPreview({ source, docPath, onOpenLocal }: MarkdownPreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const html = useMemo(
    () => renderMarkdown(source, docPath, (absolute) => assetUrl(absolute, 0)),
    [source, docPath]
  );

  // 换文档或重渲染后把滚动位置拉回顶部，免得接着上一篇的位置。
  useEffect(() => {
    hostRef.current?.scrollTo({ top: 0 });
  }, [docPath]);

  return (
    <div
      ref={hostRef}
      className="markdown-body"
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest("a");
        if (!anchor) return;
        const local = anchor.dataset.local;
        if (local) {
          event.preventDefault();
          onOpenLocal(local);
          return;
        }
        if (anchor.dataset.external) {
          // 外链不在应用内开：webview 里跳走就回不来了，交给系统浏览器。
          // 只放行真正可交给系统的协议；被净化掉 href 的链接（如 javascript:）
          // 没有 href，不能拿空串去起进程。
          const href = anchor.getAttribute("href") ?? "";
          if (/^(https?:|mailto:|tel:)/i.test(href)) {
            event.preventDefault();
            void openExternal(href).catch(() => {});
          }
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
