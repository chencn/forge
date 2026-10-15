import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import ContextMenu, { type MenuAnchor, type MenuItem } from "./ContextMenu";
import { useI18n } from "../i18n";
import { assetUrl, openExternal } from "../lib/fs";
import { renderMarkdown } from "../lib/markdown";

interface MarkdownPreviewProps {
  /** markdown 正文。 */
  source: string;
  /** 这份文档的绝对路径；相对图片按它所在目录解析。 */
  docPath: string;
  /** 点本地链接（相对路径的图片或文件）时打开它。 */
  onOpenLocal: (absolute: string) => void;
  /** 切换到源码视图。 */
  onToggleSource?: () => void;
}

/**
 * markdown 的渲染视图。
 *
 * 正文由 marked 转成 HTML、DOMPurify 洗过后注入；图片的地址在这一步就换成了
 * asset 协议的 URL，所以本地图片与线上图片走的是同一条 <img> 路径。
 * 链接的点击在容器上统一拦一次：外链交系统浏览器，本地文件交编辑器，
 * 页内锚点留给浏览器自己滚。
 */
export default function MarkdownPreview({
  source,
  docPath,
  onOpenLocal,
  onToggleSource,
}: MarkdownPreviewProps) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);

  const html = useMemo(
    () => renderMarkdown(source, docPath, (absolute) => assetUrl(absolute, 0)),
    [source, docPath]
  );

  // 换文档或重渲染后把滚动位置拉回顶部，免得接着上一篇的位置。
  useEffect(() => {
    hostRef.current?.scrollTo({ top: 0 });
  }, [docPath]);

  const selectAll = () => {
    const host = hostRef.current;
    if (!host) return;
    const range = document.createRange();
    range.selectNodeContents(host);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const target = event.target as HTMLElement;
    const anchor = target.closest("a");
    const img = target.closest("img");
    const pre = target.closest("pre");
    const selection = window.getSelection();
    const selectedText = selection ? selection.toString() : "";
    const hasSelection = selectedText.length > 0;

    const items: MenuItem[] = [];

    // 若右击在链接上：优先提供链接相关操作
    if (anchor) {
      const local = anchor.dataset.local;
      const href = anchor.getAttribute("href") ?? "";
      items.push({
        label: t("preview.openLink"),
        onSelect: () => {
          if (local) {
            onOpenLocal(local);
          } else if (/^(https?:|mailto:|tel:)/i.test(href)) {
            void openExternal(href).catch(() => {});
          }
        },
      });
      items.push({
        label: t("preview.copyLink"),
        onSelect: () => {
          const targetUrl = local || href;
          if (targetUrl) void navigator.clipboard.writeText(targetUrl);
        },
      });
      items.push({ separator: true });
    }

    // 若右击在图片上：提供复制图片地址
    if (img) {
      const src = img.getAttribute("src") ?? "";
      if (src) {
        items.push({
          label: t("preview.copyImage"),
          onSelect: () => void navigator.clipboard.writeText(src),
        });
        items.push({ separator: true });
      }
    }

    // 复制选区或复制代码块
    if (hasSelection) {
      items.push({
        label: t("action.copy"),
        onSelect: () => void navigator.clipboard.writeText(selectedText),
      });
    } else if (pre) {
      items.push({
        label: t("preview.copyCode"),
        onSelect: () => {
          const codeText = pre.innerText || pre.textContent || "";
          if (codeText) void navigator.clipboard.writeText(codeText);
        },
      });
    } else {
      items.push({
        label: t("action.copy"),
        disabled: true,
      });
    }

    items.push({
      label: t("action.selectAll"),
      onSelect: selectAll,
    });

    // 切换到源码视图
    if (onToggleSource) {
      items.push({ separator: true });
      items.push({
        label: t("preview.source"),
        onSelect: onToggleSource,
      });
    }

    setMenu({
      x: event.clientX,
      y: event.clientY,
      items,
    });
  };

  return (
    <>
      <div
        ref={hostRef}
        tabIndex={-1}
        className="markdown-body"
        onContextMenu={handleContextMenu}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
            const active = document.activeElement;
            if (active?.tagName !== "INPUT" && active?.tagName !== "TEXTAREA") {
              event.preventDefault();
              selectAll();
            }
          }
        }}
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
      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </>
  );
}
