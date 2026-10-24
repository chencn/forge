import { useEffect, useRef, useState, type RefObject } from "react";
import { useI18n } from "../i18n";
import { AI_CHAT_WIDTH_KEY_STEP, aiChatWidthClamped, setAiChatHostWidth, setAiChatWidth } from "../lib/aiChatWidth";

/**
 * 聊天列宽的左右拖拽手柄（对照参考实现的 chat-width-handles）。
 *
 * 命中区 12px、可见线 1px；拖拽**对称放大**——从左缘向外拖多少，右缘同步放多少，
 * 内容列始终居中。拖动中只改预览不落盘，松手才持久化；双击、Esc、Home 恢复默认；
 * 方向键一次 32px。宿主宽度变化时收窄上限，列永远压不到窗口边。
 */
export default function AiChatWidthHandles({ host }: { host: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState<"left" | "right" | null>(null);
  const start = useRef({ pointer: 0, width: 0 });

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setAiChatHostWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [host]);

  const begin = (side: "left" | "right") => (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { pointer: event.clientX, width: aiChatWidthClamped() };
    setDragging(side);
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const delta = (dragging === "right" ? 1 : -1) * (event.clientX - start.current.pointer);
    setAiChatWidth(start.current.width + 2 * delta, false);
  };
  const end = () => {
    if (!dragging) return;
    setDragging(null);
    setAiChatWidth(aiChatWidthClamped());
  };
  const label = t("ai.chat.resizeWidth");
  const side = (which: "left" | "right") => <div
    key={which}
    role="separator"
    aria-orientation="vertical"
    aria-label={label}
    title={label}
    tabIndex={0}
    className={`ai-width-handle${which === "right" ? " is-right" : ""}${dragging ? " is-dragging" : ""}`}
    data-dragging={dragging === which ? "true" : undefined}
    onPointerDown={begin(which)}
    onPointerMove={move}
    onPointerUp={end}
    onPointerCancel={end}
    onDoubleClick={() => setAiChatWidth(null)}
    onKeyDown={(event) => {
      if (event.key === "Escape" || event.key === "Home") {
        event.preventDefault();
        setAiChatWidth(null);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const direction = event.key === "ArrowRight" ? 1 : -1;
        setAiChatWidth(aiChatWidthClamped() + direction * AI_CHAT_WIDTH_KEY_STEP);
      }
    }}
  />;

  return <>{side("left")}{side("right")}</>;
}
