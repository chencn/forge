/**
 * 小地图的点击与拖动。
 *
 * 库自己挂的是 `mousedown`，而这里必须先 `preventDefault` 掉 `pointerdown`（不然按下
 * 会把正文的选区起手一起带走），那一步同时把兼容的 `mousedown` 掐掉——库两头都收不到。
 * 所以整组手势在这里接管：点一下跳到那一块，按住拖就连续滚。
 *
 * 位置换算以视口框（overlay）为准：它多高像素代表屏幕上一屏，拖动多少像素就按这个比例
 * 折成滚动量。不用「整幅画布代表整篇文档」那套——库画的是跟着滚动滑动的窗口，
 * 按整篇比例算会越滚越偏。
 */
import type { EditorView } from "@codemirror/view";

interface Drag {
  id: number;
  y: number;
  top: number;
  /** 视口框上 1px 折算成文档里多少 px。 */
  perPx: number;
}

/** 视口框该落在哪、多高。`top` 是屏幕坐标，`offset` 是相对画布顶。 */
interface Thumb {
  top: number;
  offset: number;
  height: number;
  surface: DOMRect;
}

/** 库把正文按 1/8 画进画布（PixelMultiplier × SizeRatio）。视口框高度对不上时退回这个数。 */
const MINIMAP_SCALE = 8;

export function attachMinimapPointer(host: HTMLElement, view: EditorView): void {
  let drag: Drag | null = null;
  let thumbFrame = 0;

  const overlay = () => host.querySelector<HTMLElement>(".cm-minimap-overlay");
  const scroller = () => view.scrollDOM;
  const maxScroll = () => Math.max(0, scroller().scrollHeight - scroller().clientHeight);

  const place = (top: number) => {
    const next = Math.min(Math.max(0, top), maxScroll());
    if (scroller().scrollTop === next) return;
    scroller().scrollTop = next;
    // 滚动事件要等一拍才来，拖动过程中框得当场跟上，不然看着像没动。
    syncThumb();
  };

  /**
   * 视口框现在该在哪。
   *
   * 公式同库自己那份：按可滚比例摆，短文档时退回「一屏在整幅里占到哪」。不从
   * `getBoundingClientRect()` 读位置——库给框挂了 `transition`，刚写进去的 `top`
   * 要等下一帧才落到布局上，同一拍读回来还是旧值。
   */
  const thumbBox = (): Thumb | null => {
    const box = overlay();
    const surface = host.querySelector<HTMLElement>(".cm-minimap-inner");
    if (!box || !surface) return null;
    const surfaceRect = surface.getBoundingClientRect();
    const height = box.getBoundingClientRect().height;
    const max = maxScroll();
    if (height <= 0 || surfaceRect.height <= 0 || max <= 0) return null;
    const offset = Math.max(
      0,
      Math.min((surfaceRect.height - height) * (scroller().scrollTop / max), scroller().scrollTop / MINIMAP_SCALE)
    );
    return { top: surfaceRect.top + offset, offset, height, surface: surfaceRect };
  };

  const syncThumb = () => {
    const thumb = thumbBox();
    const box = overlay();
    if (thumb && box) box.style.top = `${Math.round(thumb.offset)}px`;
  };

  const onScroll = () => {
    // 关掉小地图、换文档时库把这块整个摘走；滚动条还活着，监听自己退场。
    if (!host.isConnected) {
      scroller().removeEventListener("scroll", onScroll);
      return;
    }
    if (thumbFrame) return;
    thumbFrame = window.requestAnimationFrame(() => {
      thumbFrame = 0;
      syncThumb();
    });
  };

  /** 光标落到屏幕正中那一行。 */
  const selectCenter = () => {
    const box = scroller();
    const block = view.lineBlockAtHeight(box.scrollTop + box.clientHeight / 2);
    const line = view.state.doc.lineAt(block.from);
    if (view.state.selection.main.head === line.from) return;
    view.dispatch({ selection: { anchor: line.from } });
    view.focus();
  };

  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const thumb = thumbBox();
    if (!thumb) return;
    event.preventDefault();
    event.stopPropagation();
    // 顺手把框摆正：库那个滚动监听没生效，框可能还停在老位置。
    syncThumb();
    // 框就是一屏：它多高像素代表 clientHeight 那么高的正文。框被拉得跟画布一样高
    // （库在排版落定前量过一次、之后没赶上重算）时按库自己的比例退回去。
    const perPx = thumb.height > thumb.surface.height * 0.95 ? MINIMAP_SCALE : scroller().clientHeight / thumb.height;
    drag = { id: event.pointerId, y: event.clientY, top: scroller().scrollTop, perPx };
    try {
      host.setPointerCapture(event.pointerId);
    } catch {
      // 指针已经抬起：后面的 move 自然也不会来。
    }
    // 按在框上是要拖滑块，不跳；按在框外才是「跳到这块」。
    if (event.clientY < thumb.top || event.clientY > thumb.top + thumb.height) {
      place(scroller().scrollTop + (event.clientY - (thumb.top + thumb.height / 2)) * perPx);
      drag.top = scroller().scrollTop;
      drag.y = event.clientY;
      selectCenter();
    }
  };

  const onMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    place(drag.top + (event.clientY - drag.y) * drag.perPx);
  };

  const onUp = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
  };

  host.addEventListener("pointerdown", onDown);
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerup", onUp);
  host.addEventListener("pointercancel", onUp);
  scroller().addEventListener("scroll", onScroll, { passive: true });
}
