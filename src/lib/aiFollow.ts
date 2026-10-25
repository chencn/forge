/** 倒数这么多像素内都算「贴着底部」，别让用户为几个像素的对不齐动手。 */
export const BOTTOM_SLOP = 80;

/** 上翻历史的意图与分页锁；程序补偿只更新位置，不能改变用户滚动方向。 */
export class OlderHistoryScroll {
  private top = 0;
  private upward = false;
  private busy = false;
  private failed = false;
  private initial = true;
  /** 上一次补页真实长出来的内容高度；0 表示还没测到过。 */
  private page = 0;

  scroll(top: number): number {
    const delta = top - this.top;
    this.top = top;
    this.intent(delta);
    return delta;
  }

  intent(delta: number) { if (delta !== 0) { this.upward = delta < 0; this.initial = false; } }

  /** 补页落地后量一次：新内容比旧内容高出多少，那就是「一页」在本会话里的真实厚度。 */
  measure(gain: number) { if (gain > 0) this.page = gain; }

  /** 首屏按真实内容高度补到三屏；用户开始滚动后不再替他补底部空间。 */
  shouldFill(contentHeight: number, height: number, available: boolean, loading: boolean): boolean {
    if (height > 0 && contentHeight >= height * 3) this.initial = false;
    return this.initial && !this.busy && !this.failed && !loading && available && height > 0;
  }

  preserve(top: number) { this.top = top; }
  follow(top: number) { this.top = top; this.upward = false; }

  shouldLoad(top: number, height: number, available: boolean, loading: boolean): boolean {
    // 提前两页开始读，而不是等用户滑到顶才看见「正在读取记录…」。
    // 一页按上次补页量到的真实高度算；还没量到时退回两屏，绝不低于原有提前量。
    const lead = Math.max(this.page * 2, height * 2);
    return this.upward && !this.busy && !this.failed && !loading && available
      && height > 0 && top <= lead;
  }

  begin(initial = false): boolean {
    if (this.busy) return false;
    this.busy = true;
    this.failed = false;
    if (!initial) this.upward = true;
    return true;
  }

  finish(failed = false) { this.busy = false; this.failed = failed; }
}

/**
 * 聊天滚动跟随的计数规则。
 *
 * 只碰数字不碰 DOM：面板把滚动位置换算成 `nearBottom` 再交给这里，于是「脱离底部时
 * 锚定、期间累计新条目、回到底部即清零」这套次序能在 node 里测。
 *
 * 锚点存当时最后一条条目的 id 而不是条目数——历史页会整段重建 entries，用数字锚会把
 * 重建误算成新消息。
 */
export type FollowAnchor = { id: string } | null;

export function isNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number, slop = BOTTOM_SLOP): boolean {
  return scrollHeight - scrollTop - clientHeight <= slop;
}

/** 贴底就取消锚点（恢复跟随）；离开底部时记下当前末尾，已有锚点则保持第一次的。 */
export function trackFollow(anchor: FollowAnchor, nearBottom: boolean, tailId: string | undefined): FollowAnchor {
  if (nearBottom) return null;
  return anchor ?? (tailId ? { id: tailId } : null);
}

/** 锚点之后到了几条。锚点那条已经被换掉时返回 0：宁可少说，不编一个数。 */
export function unseenCount(anchor: FollowAnchor, ids: Array<string | undefined>): number {
  if (!anchor) return 0;
  const index = ids.findIndex((id) => id === anchor.id);
  return index < 0 ? 0 : Math.max(0, ids.length - 1 - index);
}
