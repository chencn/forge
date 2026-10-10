import { useEffect, useRef, useState } from "react";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { assetUrl } from "../lib/fs";
import { useI18n } from "../i18n";

interface ImagePreviewProps {
  /** 图片的绝对路径。 */
  path: string;
  /** 磁盘指纹；变了就换 URL 的查询串，绕过 webview 缓存。 */
  stamp: number;
}

/** 缩放倍率档位，点加号 / 减号在档位间跳。 */
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6];

/** 画布四周的内边距，算「适应窗口」时要从可用空间里扣掉。 */
const CANVAS_PADDING = 48;

/**
 * 图片预览：一张居中、可缩放的图。
 *
 * 支持 svg：<img> 加载 svg 时脚本不会执行，所以「预览」这一侧是安全的，
 * 要看源码切到另一视图即可。
 *
 * 缩放落成真实的宽高而不是 transform：transform 不改变布局盒，放大后多出来的
 * 部分落在滚动区之外，滚不到。基准是「适应窗口」——按容器与图片原始尺寸算一个
 * 初始比例，图片一打开就完整可见，倍率在此基础上乘。
 */
export default function ImagePreview({ path, stamp }: ImagePreviewProps) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const url = assetUrl(path, stamp);

  // 换一张图时把缩放和失败态复位，否则接着上一张的比例。
  useEffect(() => {
    setZoom(1);
    setFailed(false);
    setNatural(null);
  }, [path, stamp]);

  // 盯住画布尺寸：窗口一改，适应窗口的比例要跟着重算。
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () =>
      setBox({ width: el.clientWidth - CANVAS_PADDING, height: el.clientHeight - CANVAS_PADDING });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 适应窗口的基准比例：容器装得下就按原尺寸，装不下才缩。
  const fit =
    natural && box.width > 0 && box.height > 0
      ? Math.min(1, box.width / natural.width, box.height / natural.height)
      : 1;
  const scale = fit * zoom;
  const shownPercent = Math.round(scale * 100);

  const step = (direction: 1 | -1) => {
    setZoom((current) => {
      const at = ZOOM_STEPS.findIndex((value) => Math.abs(value - current) < 0.001);
      const index = at < 0 ? ZOOM_STEPS.indexOf(1) : at;
      const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, index + direction));
      return ZOOM_STEPS[next];
    });
  };

  return (
    <div className="image-view">
      <div className="image-tools">
        <button
          type="button"
          className="icon-button is-inline"
          onClick={() => step(-1)}
          disabled={zoom <= ZOOM_STEPS[0]}
          title={t("preview.zoomOut")}
          aria-label={t("preview.zoomOut")}
        >
          <ZoomOut size={15} />
        </button>
        <span className="image-zoom">{natural ? `${shownPercent}%` : "…"}</span>
        <button
          type="button"
          className="icon-button is-inline"
          onClick={() => step(1)}
          disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
          title={t("preview.zoomIn")}
          aria-label={t("preview.zoomIn")}
        >
          <ZoomIn size={15} />
        </button>
        <button
          type="button"
          className="icon-button is-inline"
          onClick={() => setZoom(1)}
          disabled={zoom === 1}
          title={t("preview.resetZoom")}
          aria-label={t("preview.resetZoom")}
        >
          <Maximize2 size={14} />
        </button>
      </div>
      <div ref={canvasRef} className="image-canvas">
        {failed ? (
          <p className="image-error">{t("preview.loadFailed")}</p>
        ) : (
          <img
            src={url}
            alt={path.split(/[\\/]/).pop() ?? path}
            style={
              natural
                ? { width: natural.width * scale, height: natural.height * scale }
                : undefined
            }
            onLoad={(event) => {
              const el = event.currentTarget;
              setNatural({ width: el.naturalWidth, height: el.naturalHeight });
            }}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}
