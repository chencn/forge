import { useEffect, useState } from "react";

/**
 * 聊天里的秒级时钟与到达时刻登记。
 *
 * @remarks 共享 ticker：同一时刻可能有几十条行级计时（工具时钟、过程组耗时、回合状态条），
 * 每条各起一个 `setInterval` 既浪费也会让重渲染在不同帧散开；有订阅者才走表。
 * 到达时刻登记：事件不带时间戳，运行中条目的「已跑多久」只能从前端第一次看到它的那一刻起算；
 * 重新打开会话后从加载时刻重新起算，这是能拿到的最诚实的数。
 */

/** 已登记的到达时刻表；键为条目 id（跨页稳定），值为首次查询时刻（epoch 毫秒） */
const arrivals = new Map<string, number>();

/**
 * 取条目的到达时刻，没有则登记为当前时刻。
 *
 * @param id - 条目 id；跨页渲染保持稳定
 * @returns 到达时刻（epoch 毫秒）；同一 id 恒定返回第一次登记的那一刻
 */
export function aiArrival(id: string): number {
  let at = arrivals.get(id);
  if (at === undefined) {
    at = Date.now();
    arrivals.set(id, at);
  }
  return at;
}

/**
 * 只读查询条目的到达时刻。
 *
 * @param id - 条目 id
 * @returns 已登记返回时刻（epoch 毫秒）；未登记返回 undefined，不会顺手登记
 */
export function aiArrivalOf(id: string): number | undefined {
  return arrivals.get(id);
}

/** 时钟订阅者集合；每个走表组件一个回调 */
const subscribers = new Set<() => void>();
/** 共享 ticker 句柄；null 表示未启动 */
let timer: ReturnType<typeof setInterval> | null = null;

/** 有订阅者且未启动时启动 1 秒共享 ticker */
function ensureTicker() {
  if (timer !== null || subscribers.size === 0) return;
  timer = setInterval(() => subscribers.forEach((notify) => notify()), 1000);
}
/** 订阅者清空时停掉共享 ticker */
function stopTickerIfIdle() {
  if (subscribers.size === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * 每秒走一次的当前时刻。
 *
 * @param active - 为真才订阅并走表；为假返回 null 且不占 ticker
 * @returns 当前时刻（epoch 毫秒）；不活跃返回 null
 * @remarks 计时基准在 `aiArrival` 里：滚动导致组件卸载再挂回也不会重置
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

/**
 * 运行中条目已经跑了多久。
 *
 * @param active - 是否处于运行中；为假不查询
 * @param id - 条目 id
 * @returns 已运行毫秒数（下限 0）；不活跃返回 undefined
 */
export function useAiElapsed(active: boolean, id: string): number | undefined {
  const now = useAiNow(active);
  if (!active || now === null) return undefined;
  return Math.max(0, now - aiArrival(id));
}

/**
 * 时长格式化为 `0:21` / `12:05` / `1:04:17`。
 *
 * @param ms - 时长（毫秒）
 * @returns 分:秒（超 1 小时带时:段）的紧凑文本
 */
export function formatAiClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const two = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

/** 显示时钟的时长下限（毫秒）；不足 10 秒的运行不显示——数字跳得太快只是噪音 */
export const AI_CLOCK_AFTER_MS = 10000;

/**
 * 短耗时格式化为 `3.2s` / `45s`。
 *
 * @param ms - 时长（毫秒）；须为正有限数
 * @returns 10 秒以上取整秒、以下保留一位小数；不到一秒或负数返回 null
 */
export function formatAiSeconds(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const seconds = ms / 1000;
  return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)}s`;
}

/**
 * 清空时钟内部状态，供测试重置。
 *
 * @remarks 仅测试使用；生产代码不得调用
 */
export function __resetAiClockForTest() {
  arrivals.clear();
  subscribers.clear();
  stopTickerIfIdle();
}
