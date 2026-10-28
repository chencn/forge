import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useI18n } from "../i18n";
import { copyChatImage } from "../lib/chatImage";
import ImagePreview from "./ImagePreview";

/**
 * 聊天图片的放大预览（对照参考实现的 ImagePreviewDialog）。
 *
 * 缩放逻辑复用工作台文档那套 `ImagePreview`（适应窗口 + 档位缩放）；这里只负责
 * 模态外壳。`path` 一律走沙箱里的副本——粘贴与选择器两条入口落盘后都有真实路径，
 * asset 授权在保存与加载时已经建立。
 */
export default function AiImageDialog({ path, onClose, onCopyError }: {
  path: string | null;
  onClose: () => void;
  /** 复制失败时回传原因；成功与否由预览工具条自己显示。 */
  onCopyError?: (message: string) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (path) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [path]);
  return <dialog ref={ref} className="dialog ai-image-dialog" aria-label={t("ai.chat.previewImage")}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    {path ? <ImagePreview path={path} stamp={0} onCopy={async () => {
      try {
        await copyChatImage(path);
      } catch (cause) {
        onCopyError?.(String(cause));
        throw cause;
      }
    }} /> : null}
    <button type="button" className="icon-button is-inline ai-image-close" aria-label={t("dialog.close")} title={t("dialog.close")}
      onClick={onClose}><X size={16} aria-hidden /></button>
  </dialog>;
}
