import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Minus, Plus, Maximize, MoveHorizontal } from "lucide-react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useI18n } from "../../i18n";
import { EmptyState, IconButton, Spinner } from "../../ui";
import styles from "./PdfPreview.module.css";

// 本模块由正文页签懒加载；Worker 和解析器不会进入普通 HTTP 响应的加载路径。
GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfPreview({ base64 }: { base64: string }) {
  const { t } = useI18n();
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<"password" | "invalid" | null>(null);
  const [page, setPage] = useState(1);
  // 自动模式跟随预览区尺寸；取消自适应或手动缩放后固定当前比例。
  const [zoom, setZoom] = useState<number | "page" | "width">("page");
  const [scale, setScale] = useState(1);
  const [busy, setBusy] = useState(true);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // 按钮、键盘和滚轮共用缩放边界；连续输入按最新比例累积，不等待 canvas 渲染完成。
  const zoomBy = useCallback((direction: 1 | -1) => {
    if (!document) return;
    setZoom((current) => {
      const value = typeof current === "number" ? current : scale;
      if ((direction < 0 && value <= 0.25) || (direction > 0 && value >= 4)) return current;
      return direction > 0 ? Math.min(4, value * 1.25) : Math.max(0.25, value / 1.25);
    });
  }, [document, scale]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!document || event.defaultPrevented || event.nativeEvent.isComposing || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]")) return;
    if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") {
      zoomBy(1);
    } else if (event.key === "-" || event.code === "NumpadSubtract") {
      zoomBy(-1);
    } else {
      // 翻页只接管普通按键，带修饰键的工作台快捷键仍交给外层。
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        setPage((current) => Math.max(1, current - 1));
      } else if (event.key === "ArrowRight" || event.key === "PageDown") {
        setPage((current) => Math.min(document.numPages, current + 1));
      } else {
        return;
      }
    }
    event.preventDefault();
    event.stopPropagation();
  };

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !document) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.deltaY === 0) return;
      // 原生非被动监听才能阻止浏览器整页缩放；普通滚轮保持页面滚动。
      event.preventDefault();
      event.stopPropagation();
      zoomBy(event.deltaY < 0 ? 1 : -1);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [document, zoomBy]);

  useEffect(() => {
    let alive = true;
    setDocument(null);
    setError(null);
    setBusy(true);
    setPage(1);
    setZoom("page");
    const resources = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href).href;
    let task: ReturnType<typeof getDocument>;
    try {
      task = getDocument({
        data: Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
        cMapUrl: `${resources}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${resources}standard_fonts/`,
        wasmUrl: `${resources}wasm/`,
        iccUrl: `${resources}iccs/`,
        // 文档只来自已保存的响应字节，不重新访问原 URL 或执行文档脚本。
        useWorkerFetch: true,
      });
    } catch {
      // 历史 JSON 可能完好但 Base64 损坏，同步解码失败也不能破坏整个面板。
      setError("invalid");
      setBusy(false);
      return;
    }
    void task.promise.then((pdf) => {
      if (alive) setDocument(pdf);
    }).catch((cause: unknown) => {
      if (alive) {
        setError(cause instanceof Error && cause.name === "PasswordException" ? "password" : "invalid");
        setBusy(false);
      }
    });
    return () => {
      alive = false;
      // 同时中止读取、释放文档缓存并终止它的 Worker。
      void task.destroy().catch(() => {});
    };
  }, [base64]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const measure = () => setSize((previous) => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      return previous.width === width && previous.height === height ? previous : { width, height };
    });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!document || size.width <= 0 || size.height <= 0) return;
    let alive = true;
    let render: RenderTask | undefined;
    const host = canvasRef.current;
    setBusy(true);
    setError(null);
    host?.replaceChildren();
    void document.getPage(page).then(async (pdfPage) => {
      if (!alive || !host) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      // 整页模式同时约束宽高并扣除纸张四周留白，大页面也不能因最小比例被裁掉。
      const fitWidth = Math.max(1, size.width - 32) / natural.width;
      const fitHeight = Math.max(1, size.height - 32) / natural.height;
      const nextScale = typeof zoom === "number" ? zoom
        : Math.min(4, fitWidth, zoom === "page" ? fitHeight : Infinity);
      const viewport = pdfPage.getViewport({ scale: nextScale });
      // 每次渲染独占 canvas，取消旧任务后不复用其绘图上下文。
      const canvas = window.document.createElement("canvas");
      // 缩小时至少保留原始页面分辨率，并以双倍采样绘制细字；像素预算仍限制大页面内存。
      const ratio = Math.min(
        Math.max(window.devicePixelRatio || 1, 2, 1 / nextScale),
        Math.sqrt(16_777_216 / (viewport.width * viewport.height)),
      );
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      host.replaceChildren(canvas);
      setScale(nextScale);
      render = pdfPage.render({
        canvas,
        viewport,
        // 位图尺寸取整后用实际比例绘制，避免小数像素裁切和二次拉伸。
        transform: [canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0],
        background: "white",
      });
      await render.promise;
      if (alive) setBusy(false);
    }).catch(() => {
      if (alive) {
        host?.replaceChildren();
        setError("invalid");
        setBusy(false);
      }
    });
    return () => {
      alive = false;
      render?.cancel();
      host?.replaceChildren();
    };
  }, [document, page, zoom, size]);

  return (
    <div className={styles.root} onKeyDown={onKeyDown}>
      <div className={styles.toolbar}>
        <IconButton icon={ChevronLeft} title={t("http.pdfPrevious")} shortcut="← / Page Up" aria-keyshortcuts="ArrowLeft PageUp" disabled={!document || page <= 1} onClick={() => setPage((value) => value - 1)} />
        <span className={styles.counter}>{document ? `${page} / ${document.numPages}` : "— / —"}</span>
        <IconButton icon={ChevronRight} title={t("http.pdfNext")} shortcut="→ / Page Down" aria-keyshortcuts="ArrowRight PageDown" disabled={!document || page >= document.numPages} onClick={() => setPage((value) => value + 1)} />
        <IconButton icon={Minus} title={t("http.pdfZoomOut")} shortcut="-" disabled={!document || scale <= 0.25} onClick={() => zoomBy(-1)} />
        <span className={styles.counter}>{Math.round(scale * 100)}%</span>
        <IconButton icon={Plus} title={t("http.pdfZoomIn")} shortcut="+" aria-keyshortcuts="Plus Equal" disabled={!document || scale >= 4} onClick={() => zoomBy(1)} />
        <IconButton icon={MoveHorizontal} title={t("http.pdfFitWidth")} pressed={zoom === "width"} disabled={!document} onClick={() => setZoom("width")} />
        <IconButton icon={Maximize} title={t("http.pdfFitPage")} pressed={zoom === "page"} disabled={!document} onClick={() => setZoom(zoom === "page" ? scale : "page")} />
      </div>
      <div
        ref={scrollRef}
        className={styles.viewport}
        role="region"
        tabIndex={0}
        aria-label={t("http.pdfPreview")}
        aria-busy={busy}
        onPointerDown={(event) => {
          // 点击纸张即可使用键盘；焦点留在预览内，不抢占编辑器或表单输入。
          if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]")) return;
          event.currentTarget.focus({ preventScroll: true });
        }}
      >
        <div ref={canvasRef} className={styles.page} />
        {busy ? <div className={styles.message}><Spinner /></div> : null}
        {error ? <div className={styles.message}><EmptyState title={t(error === "password" ? "http.pdfPassword" : "http.pdfInvalid")} /></div> : null}
      </div>
    </div>
  );
}
