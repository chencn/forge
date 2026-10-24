import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useI18n } from "../i18n";
import ImagePreview from "./ImagePreview";

/**
 * 聊天图片的放大预览（对照参考实现的 ImagePreviewDialog）。
 *
 * 缩放逻辑复用工作台文档那套 `ImagePreview`（适应窗口 + 档位缩放）；这里只负责
 * 模态外壳。`path` 一律走沙箱里的副本——粘贴与选择器两条入口落盘后都有真实路径，
 * asset 授权在保存与加载时已经建立。
 */
export default function AiImageDialog({ path, onClose }: { path: string | null; onClose: () => void }) {
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
    {path ? <ImagePreview path={path} stamp={0} /> : null}
    <button type="button" className="icon-button is-inline ai-image-close" aria-label={t("dialog.close")} title={t("dialog.close")}
      onClick={onClose}><X size={16} aria-hidden /></button>
  </dialog>;
}
