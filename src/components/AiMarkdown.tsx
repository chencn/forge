import { useMemo } from "react";
import { useI18n } from "../i18n";
import { openExternal } from "../lib/fs";
import { renderChatMarkdown, repairStreamingMarkdown } from "../lib/markdown";
import { useAiOpenFile } from "./AiFileLink";

function positive(value: string | null): number | undefined {
  if (!value) return undefined;
  const number = Number.parseInt(value, 10);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/**
 * 聊天正文的 markdown。
 *
 * 高亮复用文档预览那套 highlight.js，安全边界仍是聊天自己的严格白名单，见
 * {@link renderChatMarkdown}。复制按钮和链接都不由 React 渲染——它们是注入的 HTML 字符串
 * 的一部分，所以只能靠根节点上的一次委托来响应，而不是逐块挂 onClick。
 */
export default function AiMarkdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const { t } = useI18n();
  const openFile = useAiOpenFile();
  const copyLabel = t("action.copy");
  const copiedLabel = t("action.copied");
  // 流式正文先补齐未闭合的围栏：半截代码块会把后面的字整个吞进去，每次刷新闪一下。
  // 流式中的代码块保持展开（整段重渲染会丢 details 的 open 态），落定后默认收起。
  const html = useMemo(() => renderChatMarkdown(streaming ? repairStreamingMarkdown(text) : text, copyLabel, streaming), [text, copyLabel, streaming]);

  const copy = (button: HTMLElement, event: { preventDefault(): void; stopPropagation(): void }) => {
    // textContent 拿回的是高亮标记剥掉之后的原始代码，逐 token 的 <span> 不会掺进字符。
    const code = button.closest(".code-block-wrapper")?.querySelector("pre code");
    const value = code?.textContent ?? "";
    if (!value) return;
    // 复制按钮在折叠题头上：不让这次点击顺带把代码块展开/收起。
    event.preventDefault();
    event.stopPropagation();
    void navigator.clipboard.writeText(value).then(() => {
      button.textContent = copiedLabel;
      button.classList.add("is-copied");
      window.setTimeout(() => {
        // 流式渲染会整段替换 innerHTML，节点可能早就不在文档里了，别去动它。
        if (button.isConnected) {
          button.textContent = copyLabel;
          button.classList.remove("is-copied");
        }
      }, 1600);
    }, () => {
      // 剪贴板被拒时保持原文案：按钮看着像没被点到，比谎报「已复制」诚实。
    });
  };

  return <div
    className="ai-message-markdown"
    dangerouslySetInnerHTML={{ __html: html }}
    onClick={(event) => {
      const target = event.target as HTMLElement;
      const button = target.closest<HTMLElement>("[data-code-copy]");
      if (button) {
        copy(button, event);
        return;
      }
      const file = target.closest<HTMLElement>("[data-file-path]");
      if (file) {
        event.preventDefault();
        const path = file.getAttribute("data-file-path") ?? "";
        if (!path) return;
        const line = positive(file.getAttribute("data-file-line"));
        const column = positive(file.getAttribute("data-file-column"));
        openFile?.(path, line, column);
        return;
      }
      const link = target.closest("a");
      if (!link) return;
      event.preventDefault();
      const href = link.getAttribute("href") ?? "";
      if (/^https?:\/\//i.test(href)) void openExternal(href);
    }}
    onKeyDown={(event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-code-copy]");
      if (!button) return;
      copy(button, event);
    }}
  />;
}
