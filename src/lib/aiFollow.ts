/** 倒数这么多像素内都算「贴着底部」，别让用户为几个像素的对不齐动手。 */
export const BOTTOM_SLOP = 80;

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
