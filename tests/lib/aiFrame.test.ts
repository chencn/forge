import { afterEach, describe, expect, it, vi } from "vitest";
import { createFrameNotifier } from "../../src/lib/aiFrame";

/** 自己掌握帧什么时候来，才能断言「一帧只通知一次」。 */
function withFrames() {
  const queue: Array<() => void> = [];
  let cancelled = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queue.push(() => callback(performance.now()));
    return queue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => { cancelled += 1; });
  return {
    /** 放掉 n 帧（默认全部）。rAF 被挂起时一帧也不放。 */
    paint(n = queue.length) {
      queue.splice(0, n).forEach((run) => run());
    },
    get cancelled() { return cancelled; },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AI 流式通知合帧", () => {
  it("一帧内连着来几十条 delta，也只通知一次", () => {
    const frames = withFrames();
    const run = vi.fn();
    const notifier = createFrameNotifier(run);
    for (let i = 0; i < 30; i += 1) notifier.schedule();
    expect(notifier.isPending()).toBe(true);
    expect(run).not.toHaveBeenCalled();
    frames.paint();
    expect(run).toHaveBeenCalledTimes(1);
    expect(notifier.isPending()).toBe(false);
  });
  it("下一批重新欠一次账，不会把后面的更新吞掉", () => {
    const frames = withFrames();
    const run = vi.fn();
    const notifier = createFrameNotifier(run);
    notifier.schedule();
    frames.paint();
    notifier.schedule();
    frames.paint();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("窗口隐藏、一帧都不来时兜底定时器照样通知", () => {
    vi.useFakeTimers();
    withFrames();
    const run = vi.fn();
    const notifier = createFrameNotifier(run, 500);
    notifier.schedule();
    vi.advanceTimersByTime(499);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(notifier.isPending()).toBe(false);
  });
  it("帧正常到账时把兜底定时器撤掉，不会重复通知", () => {
    vi.useFakeTimers();
    const frames = withFrames();
    const run = vi.fn();
    const notifier = createFrameNotifier(run, 500);
    notifier.schedule();
    frames.paint();
    vi.advanceTimersByTime(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("flush 立即兑现；没欠账时什么都不做", () => {
    const frames = withFrames();
    const run = vi.fn();
    const notifier = createFrameNotifier(run);
    notifier.schedule();
    notifier.flush();
    expect(run).toHaveBeenCalledTimes(1);
    notifier.flush();
    expect(run).toHaveBeenCalledTimes(1);
    // 帧随后照常到来，但账已经清了，不能再通知第二次。
    frames.paint();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("取消后帧和定时器都不再通知", () => {
    vi.useFakeTimers();
    const frames = withFrames();
    const run = vi.fn();
    const notifier = createFrameNotifier(run, 500);
    notifier.schedule();
    notifier.cancel();
    notifier.cancel();
    expect(frames.cancelled).toBe(1);
    frames.paint();
    vi.advanceTimersByTime(10_000);
    expect(run).not.toHaveBeenCalled();
    expect(notifier.isPending()).toBe(false);
  });
  it("通知里抛异常也不会把调度器卡死", () => {
    const frames = withFrames();
    const notifier = createFrameNotifier(() => { throw new Error("订阅者炸了"); });
    notifier.schedule();
    expect(() => frames.paint()).toThrow("订阅者炸了");
    expect(notifier.isPending()).toBe(false);
    const run = vi.fn();
    const next = createFrameNotifier(run);
    next.schedule();
    frames.paint();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("没有 rAF 的环境退回 16ms 定时器", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", undefined);
    const run = vi.fn();
    const notifier = createFrameNotifier(run, 500);
    notifier.schedule();
    vi.advanceTimersByTime(15);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
