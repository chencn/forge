/** 一次轻击按住的最大时长：超过这个时间算长按，松开时不计入双击的前半段。 */
export const MAX_SHIFT_HOLD_MS = 280;

/** 两次轻击之间的最大间隔：上一次松开到下一次按下的时间差。 */
export const MAX_SHIFT_GAP_MS = 350;

export interface ShiftKeyEvent {
  key: string;
  timeStamp: number;
  repeat?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

/**
 * 双击 Shift 手势识别器。
 *
 * 遵循 IntelliJ IDEA 的手势习惯（`shift SHIFT`）：
 * 1. 只有纯净、快速的轻击（Tap，按住不超过 MAX_SHIFT_HOLD_MS 且未结合其他键/未发生按键重复）松开后，才记为第一击；
 * 2. 在第一击松开后的 MAX_SHIFT_GAP_MS 内再次按下 Shift，才触发搜索；
 * 3. 长按 Shift（长按持续按住、触发系统 repeat 或按住超时）严格判定为长按，绝不触发搜索，且长按释放后不作为双击起点；
 * 4. 混入其他按键、修饰键或处于输入框等禁用环境时，立刻重置手势计数。
 */
export class DoubleShiftDetector {
  private lastTapAt = 0;
  private downAt = 0;
  private interrupted = false;

  private readonly maxHoldMs: number;
  private readonly maxGapMs: number;

  constructor(maxHoldMs = MAX_SHIFT_HOLD_MS, maxGapMs = MAX_SHIFT_GAP_MS) {
    this.maxHoldMs = maxHoldMs;
    this.maxGapMs = maxGapMs;
  }

  /**
   * 处理 keydown 事件。
   * @param event 键盘事件
   * @param disabled 是否处于禁用环境（如处于输入框、模态框打开等）
   * @returns 是否满足双击 Shift 触发条件
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
   * 只有在未被中断、且按住时长不超过 maxHoldMs 的轻击松开，才被记录为有效 Tap 1。
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

  /** 窗口失焦或手势中断时重置所有状态。 */
  reset(): void {
    this.lastTapAt = 0;
    this.downAt = 0;
    this.interrupted = true;
  }
}
