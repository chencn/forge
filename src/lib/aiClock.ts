import { useEffect, useState } from "react";

/**
 * 聊天里的秒级时钟（对照 codeg 的 use-live-elapsed）。
 *
 * 两件事：
 * 一、共享 ticker——同一时刻可能有几十条行级计时（工具时钟、过程组耗时、回合状态条），
 * 每条各起一个 `setInterval` 既浪费也会让重渲染在不同帧散开；有订阅者才走表。
 * 二、到达时刻登记——forge 的事件不带时间戳，运行中条目的「已跑多久」只能从前端
 * 第一次看到它的那一刻起算；重新打开会话后从加载时刻重新起算，这是能拿到的最诚实的数。
 */

const arrivals = new Map<string, number>();

/** 第一次问才写入；之后一直返回那一刻。键建议用条目 id（跨页稳定）。 */
export function aiArrival(id: string): number {
  let at = arrivals.get(id);
  if (at === undefined) {
    at = Date.now();
    arrivals.set(id, at);
  }
  return at;
}

/** 只读查询：还没登记过返回 undefined，也不会顺手登记。 */
export function aiArrivalOf(id: string): number | undefined {
  return arrivals.get(id);
}

const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function ensureTicker() {
  if (timer !== null || subscribers.size === 0) return;
  timer = setInterval(() => subscribers.forEach((notify) => notify()), 1000);
}
function stopTickerIfIdle() {
  if (subscribers.size === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * `active` 为真时每秒走一次的当前时刻；为假时返回 null 不走表。
 * 与参考实现一致：滚动导致组件卸载再挂回，计时基准在 `aiArrival` 里，不会重置。
 */
export function useAiNow(active: boolean): number | null {
  const [now, setNow] = useState<number | null>(active ? Date.now() : null);
  useEffect(() => {
    if (!active) {
      setNow(null);
      return;
    }
    setNow(Date.now());
    const notify = () => setNow(Date.now());
    subscribers.add(notify);
    ensureTicker();
    return () => {
      subscribers.delete(notify);
      stopTickerIfIdle();
    };
  }, [active]);
  return now;
}

/** 运行中的条目已经跑了多久（毫秒）；条目不在了返回 undefined。 */
export function useAiElapsed(active: boolean, id: string): number | undefined {
  const now = useAiNow(active);
  if (!active || now === null) return undefined;
  return Math.max(0, now - aiArrival(id));
}

/** 与参考实现相同的格式：`0:21` / `12:05` / `1:04:17`。 */
export function formatAiClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const two = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

/** 参考实现的取舍：不足 10 秒的运行不显示时钟——数字跳得太快只是噪音。 */
export const AI_CLOCK_AFTER_MS = 10000;

/** 与参考实现相同的短耗时格式：`3.2s` / `45s`。不到一秒或负数没有可说的，返回 null。 */
export function formatAiSeconds(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const seconds = ms / 1000;
  return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)}s`;
}

/** 供测试重置。 */
export function __resetAiClockForTest() {
  arrivals.clear();
  subscribers.clear();
  stopTickerIfIdle();
}
