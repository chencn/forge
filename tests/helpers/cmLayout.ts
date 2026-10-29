/**
 * jsdom 没有排版：CodeMirror 一挂上正文就要向 `Range` 要矩形来实行高，取不到就在
 * 动画帧回调里抛「未处理异常」，用例本身跑对了也会把整个文件判失败。
 *
 * 这里给一个固定矩形，另外补一个直接落到 `scrollTop` 的 `scrollTo` 替身（跳行与
 * 比对视图的走位都走平滑滚动，只有 Chromium 认那个对象参数）。测的是落点算得对不对，不是动画。
 * 真按坐标落光标的那类命令（删行、移行）在这台环境里仍然量不出行高，不在覆盖之内。
 */
const RECT = { top: 0, left: 0, bottom: 12, right: 8, width: 8, height: 12, x: 0, y: 0 };

export function stubTextLayout(): void {
  const range = Range.prototype as unknown as Record<string, unknown>;
  range.getClientRects = () => Object.assign([RECT], { item: () => RECT });
  range.getBoundingClientRect = () => RECT;
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.scrollTo) {
    proto.scrollTo = function scrollTo(this: Element, options: { top?: number; left?: number }) {
      if (typeof options.top === "number") this.scrollTop = options.top;
      if (typeof options.left === "number") this.scrollLeft = options.left;
    };
  }
}
