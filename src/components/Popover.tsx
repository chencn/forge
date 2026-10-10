import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

interface PopoverProps {
  /** 锚点元素：弹层贴着它的下沿画，放不下时翻到上沿。 */
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  /** 宽度下限；不传则取锚点宽度。 */
  minWidth?: number;
  /**
   * 宽度上限。内容（长路径、长错误串）比它宽时不再撑大弹层，改由内容自身省略号收尾。
   * 不传则不设上限，维持旧行为。实际取值还会再压到视口内，避免出屏。
   */
  maxWidth?: number;
  /**
   * 默认带一层全屏遮罩：点外面收，代价是遮罩期间底下的区域吃不到点击。
   * 悬停展开的读数明细传 false——它跟着指针自己会走，不需要拦截点击。
   */
  modal?: boolean;
}

const GAP = 4;
const EDGE = 8;

/**
 * 主工具栏的芯片与头部动作条共用这一套定位：贴着锚点、随视口翻转、点外面收。
 * 横向一律从锚点的左边缘往右开——锚点待在窄容器里时弹层就盖到旁边的区域上，
 * 不为了留在容器内而挪到锚点左边；只有右边缘会出屏时才整块往回收。
 */
export default function Popover({ anchor, onClose, children, minWidth, maxWidth, modal = true }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const measure = () => {
      const rect = anchor.getBoundingClientRect();
      const panel = ref.current?.getBoundingClientRect();
      // 下限取「显式下限」与「锚点宽」的较大者；上限存在时再夹一层，且不能低于下限本身。
      const floor = Math.max(minWidth ?? 0, rect.width);
      const ceiling = Math.max(floor, Math.min(maxWidth ?? Infinity, window.innerWidth - 2 * EDGE));
      const width = Math.min(ceiling, Math.max(floor, panel?.width ?? 0));
      const natural = panel?.height ?? 320;
      const below = window.innerHeight - rect.bottom - GAP - EDGE;
      const flip = natural > below && rect.top > natural;
      const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - width - EDGE));
      const top = flip ? Math.max(EDGE, rect.top - GAP - natural) : rect.bottom + GAP;
      // 位置没变就别换那个对象：换一次就是一次父层重渲染，而下面那个观察器是按尺寸变化触发的。
      setBox((current) =>
        current && current.left === left && current.top === top && current.width === width
          ? current
          : { left, top, width }
      );
    };
    measure();
    /**
     * 用尺寸变化来补测，而不是把 `children` 写进依赖：浮层里的列表异步到位、内容自己长高时
     * 才需要重算翻转；挂在 `children` 上的话，开着浮层时每敲一个键父层都重渲染一次，
     * 每次都量两遍 `getBoundingClientRect` 再触发第二趟渲染。
     */
    const observer = new ResizeObserver(measure);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anchor, minWidth, maxWidth]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!anchor) return null;

  return (
    <>
      {modal ? <div className="menu-overlay" onClick={onClose} /> : null}
      <div
        ref={ref}
        className="popover is-anchored"
        role={modal ? "dialog" : "tooltip"}
        style={
          box
            ? {
                left: box.left,
                top: box.top,
                minWidth: box.width,
                // 只设 minWidth 挡不住更宽的内容（min-width 不是上限），
                // 给了 maxWidth 就把它也钉到同一个值，内容改走自身省略号收尾。
                ...(maxWidth === undefined ? {} : { maxWidth: box.width }),
              }
            : {
                left: EDGE,
                top: EDGE,
                visibility: "hidden",
                // 首帧就得按最终宽度量。不带上这两个约束时量到的是内容的最大宽（说明文字一行不折），
                // 而钉完宽之后内容才折行、高度才变，用第一趟的高度定位置就差一截，
                // 下一帧修正回来就是肉眼看到的「跳一下」。
                minWidth,
                maxWidth,
              }
        }
      >
        {children}
      </div>
    </>
  );
}
