/**
 * 把「攒了一批数据 → 通知订阅者」压成一帧一次。
 *
 * 流式回复的每个 delta 都会改动快照并通知一次 React。一次通知就是一轮整棵时间线的
 * 重渲染加正文重新解析，一秒几十条时浏览器全花在重画上。合帧只改通知节奏：数据照旧
 * 当场写进快照，欠的只有「什么时候告诉大家」。
 *
 * 两条不能破的规矩：
 * - 兜底定时器。窗口隐藏时 rAF 会被挂起，只靠它就再也不会通知；用户在别的窗口里
 *   完全看不到进展，也不知道是不是卡住了。
 * - 兑现顺序。任何一次立即通知都顺带把这一帧欠下的清掉——快照已经是最新的，
 *   随后再通知一遍只是多渲染一次。
 */
export interface FrameNotifier {
  /** 记下一次欠账；同一帧内反复调用只算一次。 */
  schedule: () => void;
  /** 立即兑现欠账；没欠账时什么都不做。 */
  flush: () => void;
  /** 作废欠账——调用方自己已经通知过了才用它。 */
  cancel: () => void;
  /** 是否还欠着一次通知。 */
  isPending: () => boolean;
}

/** 一帧之后跑。没有 rAF 的环境退回 16ms 定时器，跟 term.ts 里同样的取舍。 */
function afterFrame(run: () => void): () => void {
  if (typeof requestAnimationFrame !== "function") {
    const id = setTimeout(run, 16);
    return () => { clearTimeout(id); };
  }
  const id = requestAnimationFrame(run);
  return () => { cancelAnimationFrame(id); };
}

/**
 * @param run 真正去通知订阅者的那一步
 * @param fallbackMs rAF 多久还没来就改用定时器兜底
 */
export function createFrameNotifier(run: () => void, fallbackMs = 500): FrameNotifier {
  let pending = false;
  let dropFrame: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    dropFrame();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const settle = () => {
    if (!pending) return;
    // 先清账再跑：run 抛异常时不能把调度器卡在「永远欠一次」的状态。
    pending = false;
    clear();
    run();
  };

  return {
    schedule() {
      if (pending) return;
      pending = true;
      dropFrame = afterFrame(settle);
      timer = setTimeout(settle, fallbackMs);
    },
    flush: settle,
    cancel() {
      if (!pending) return;
      pending = false;
      clear();
    },
    isPending: () => pending,
  };
}
