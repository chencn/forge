/** 一次轻击按住的最大时长（毫秒）；超过这个时间算长按，松开时不计入双击的前半段 */
export const MAX_SHIFT_HOLD_MS = 280;

/** 两次轻击之间的最大间隔（毫秒）；上一次松开到下一次按下的时间差 */
export const MAX_SHIFT_GAP_MS = 350;

/** 双击识别所需的键盘事件最小字段集 */
export interface ShiftKeyEvent {
  /** 事件键名；只认 "Shift" */
  key: string;
  /** 事件时间戳（毫秒），用于按住与间隔计时 */
  timeStamp: number;
  /** 系统自动重复标记；为真按长按处理 */
  repeat?: boolean;
  /** Ctrl 组合标记；为真打断手势 */
  ctrlKey?: boolean;
  /** Alt 组合标记；为真打断手势 */
  altKey?: boolean;
  /** Meta 组合标记；为真打断手势 */
  metaKey?: boolean;
}

/**
 * 双击 Shift 手势识别器。
 *
 * 遵循 IntelliJ IDEA 的手势习惯（`shift SHIFT`）：
 * 1. 只有纯净、快速的轻击（Tap，按住不超过 {@link MAX_SHIFT_HOLD_MS} 且未结合其他键/未发生按键重复）松开后，才记为第一击；
 * 2. 在第一击松开后的 {@link MAX_SHIFT_GAP_MS} 内再次按下 Shift，才触发搜索；
 * 3. 长按 Shift（长按持续按住、触发系统 repeat 或按住超时）严格判定为长按，绝不触发搜索，且长按释放后不作为双击起点；
 * 4. 混入其他按键、修饰键或处于输入框等禁用环境时，立刻重置手势计数。
 */
export class DoubleShiftDetector {
  /** 上一次有效轻击的松开时刻（毫秒）；0 表示还没有第一击 */
  private lastTapAt = 0;
  /** 本次 Shift 按下时刻（毫秒）；0 表示未按下 */
  private downAt = 0;
  /** 手势是否被打断；打断后本次松开不记为有效轻击 */
  private interrupted = false;

  /** 单次轻击最长按住时长（毫秒） */
  private readonly maxHoldMs: number;
  /** 两击之间最大间隔（毫秒） */
  private readonly maxGapMs: number;

  /**
   * 创建识别器。
   *
   * @param maxHoldMs - 轻击最长按住时长；默认 {@link MAX_SHIFT_HOLD_MS}
   * @param maxGapMs - 两击最大间隔；默认 {@link MAX_SHIFT_GAP_MS}
   */
  constructor(maxHoldMs = MAX_SHIFT_HOLD_MS, maxGapMs = MAX_SHIFT_GAP_MS) {
    this.maxHoldMs = maxHoldMs;
    this.maxGapMs = maxGapMs;
  }

  /**
   * 处理 keydown 事件。
   *
   * @param event - 键盘事件
   * @param disabled - 是否处于禁用环境（如处于输入框、模态框打开等）
   * @returns 是否满足双击 Shift 触发条件；触发后内部状态已重置，可直接开始下一轮
   */
  handleKeyDown(event: ShiftKeyEvent, disabled = false): boolean {
    // 任何其他按键、组合修饰键、或处于禁用环境：打断双击手势
    if (
      event.key !== "Shift" ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      disabled
    ) {
      this.reset();
      return false;
    }

    // 长按 Shift 产生系统 repeat：立即打断并清除状态，绝对不触发搜索
    if (event.repeat) {
      this.reset();
      return false;
    }

    const now = event.timeStamp;
    this.downAt = now;
    this.interrupted = false;

    // 检查距离上一次合法轻击松开的时间是否在双击时间窗口内
    if (this.lastTapAt > 0 && now - this.lastTapAt <= this.maxGapMs) {
      this.reset();
      return true;
    }

    return false;
  }

  /**
   * 处理 keyup 事件。
   *
   * @param event - 键盘事件
   * @remarks 只有在未被中断、且按住时长不超过 maxHoldMs 的轻击松开，才被记录为有效 Tap 1
   */
  handleKeyUp(event: ShiftKeyEvent): void {
    if (event.key !== "Shift") {
      this.reset();
      return;
    }

    const now = event.timeStamp;
    const holdDuration = this.downAt > 0 ? now - this.downAt : Infinity;

    if (!this.interrupted && holdDuration <= this.maxHoldMs) {
      this.lastTapAt = now;
    } else {
      this.lastTapAt = 0;
    }

    this.downAt = 0;
    this.interrupted = false;
  }

  /**
   * 重置所有手势状态。
   *
   * @remarks 窗口失焦或手势中断时调用
   */
  reset(): void {
    this.lastTapAt = 0;
    this.downAt = 0;
    this.interrupted = true;
  }
}
