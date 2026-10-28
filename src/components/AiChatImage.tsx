import { memo, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Copy } from "lucide-react";
import { useI18n } from "../i18n";
import { assetUrl } from "../lib/fs";
import { copyChatImage } from "../lib/chatImage";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor } from "./ContextMenu";

interface AiChatImageProps {
  /** 沙箱里的图片路径。 */
  path: string;
  /** 图片说明；缺省时用文件名。 */
  name?: string;
  /** 点击缩略图放大预览。 */
  onPreview: (path: string) => void;
  /** 缩略图加载完，时间线用来补一次贴底。 */
  onLoad?: () => void;
  /** 复制失败时交给会话展示，不把按钮标成已复制。 */
  onError?: (message: string) => void;
}

/**
 * 会话里的一张截图：点击放大，悬停或右键可以复制整张图。
 *
 * 缩略图是裁切过的，剪贴板里放的是沙箱原文件，粘贴出去仍是完整图片。
 */
const AiChatImage = memo(function AiChatImage({ path, name, onPreview, onLoad, onError }: AiChatImageProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void copyChatImage(path).then(() => setCopied(true), (cause) => onError?.(String(cause)));
  };
  const openMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [{ label: t("ai.chat.copyImage"), onSelect: copy }],
    });
  };

  return (
    <span className="ai-chat-image" onContextMenu={openMenu}>
      <button
        type="button"
        className="ai-msg-image"
        aria-label={t("ai.chat.previewImage")}
        title={t("ai.chat.previewImage")}
        onClick={() => onPreview(path)}
      >
        <img
          src={assetUrl(path, 0)}
          alt={name || path.split(/[\\/]/).pop() || t("ai.chat.pastedImage")}
          onLoad={onLoad}
          onError={(event) => {
            event.currentTarget.alt = t("ai.chat.imageMissing");
            event.currentTarget.classList.add("is-missing");
          }}
        />
      </button>
      <button
        type="button"
        className="ai-chat-image-copy"
        aria-label={copied ? t("action.copied") : t("ai.chat.copyImage")}
        title={copied ? t("action.copied") : t("ai.chat.copyImage")}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          copy();
        }}
      >
        {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      </button>
      {menu ? createPortal(<ContextMenu anchor={menu} onClose={() => setMenu(null)} />, document.body) : null}
    </span>
  );
});

export default AiChatImage;
