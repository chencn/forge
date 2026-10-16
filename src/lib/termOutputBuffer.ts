/** 同步输出（DEC 2026）的进入与退出标记：CSI ? 2026 h / l。 */
const SYNCHRONIZED_OUTPUT_ENTER = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68]);
const SYNCHRONIZED_OUTPUT_EXIT = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c]);
const SYNCHRONIZED_OUTPUT_MARKER_LENGTH = SYNCHRONIZED_OUTPUT_ENTER.length;

/** 结束标记之后再等一小会儿，把紧跟着的那一帧一起交出去。 */
const DEFAULT_SETTLE_DELAY_MS = 40;
/** 开始标记一直没有结束时，到点强制刷出，避免队列永远卡住。 */
const DEFAULT_SYNCHRONIZED_OUTPUT_TIMEOUT_MS = 1_000;
/** 队列字节上限。到了就提前写，不等结束标记。 */
export const TERM_OUTPUT_HIGH_WATERMARK = 500_000;

interface PendingWrite {
  data: Uint8Array;
  onComplete: () => void;
}

export interface TermOutputBufferOptions {
  write: (data: Uint8Array, onComplete: () => void) => void;
  scheduleFlush?: (callback: () => void, delayMs: number) => unknown;
  cancelFlush?: (handle: unknown) => void;
  settleDelayMs?: number;
  synchronizedOutputTimeoutMs?: number;
  maxPendingBytes?: number;
}

/**
 * 把 DEC 2026 同步重绘在交给 xterm 之前收成一次写入。
 *
 * 普通输出仍是到了就写。同步输出先攒着：结束标记后的 settle、安全超时，
 * 或字节高水位，三者任一到了再一次性 write。这样清屏和重画中间的半帧不会被画出来。
 */
export class TermOutputBuffer {
  private readonly write: TermOutputBufferOptions["write"];
  private readonly scheduleFlush: NonNullable<TermOutputBufferOptions["scheduleFlush"]>;
  private readonly cancelFlush: NonNullable<TermOutputBufferOptions["cancelFlush"]>;
  private readonly settleDelayMs: number;
  private readonly synchronizedOutputTimeoutMs: number;
  private readonly maxPendingBytes: number;
  private readonly pending: PendingWrite[] = [];
  private pendingBytes = 0;
  private scanTail = new Uint8Array(0);
  private synchronizedOutput = false;
  private awaitingTrailingOutput = false;
  private scheduledFlush: unknown;
  private synchronizedOutputTimeout: unknown;
  private disposed = false;

  public constructor(options: TermOutputBufferOptions) {
    this.write = options.write;
    this.scheduleFlush =
      options.scheduleFlush ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelFlush =
      options.cancelFlush ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.settleDelayMs = options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS;
    this.synchronizedOutputTimeoutMs =
      options.synchronizedOutputTimeoutMs ?? DEFAULT_SYNCHRONIZED_OUTPUT_TIMEOUT_MS;
    this.maxPendingBytes = options.maxPendingBytes ?? TERM_OUTPUT_HIGH_WATERMARK;
  }

  /** 返回 true 表示这次因为字节上限提前写出去了。 */
  public enqueue(data: Uint8Array, onComplete: () => void): boolean {
    if (this.disposed) {
      onComplete();
      return false;
    }

    const containsSynchronizedMarker = this.containsSynchronizedMarker(data);
    const shouldBuffer =
      this.pending.length > 0 ||
      this.synchronizedOutput ||
      this.awaitingTrailingOutput ||
      containsSynchronizedMarker;

    if (!shouldBuffer) {
      this.updateProtocolState(data);
      this.write(data, onComplete);
      return false;
    }

    this.pending.push({ data: data.slice(), onComplete });
    this.pendingBytes += data.byteLength;
    this.updateProtocolState(data);

    if (this.pendingBytes >= this.maxPendingBytes) {
      this.flushPending();
      return true;
    }

    return false;
  }

  public flush(): void {
    this.forceFlush();
  }

  public get hasPendingWrites(): boolean {
    return this.pending.length > 0;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.forceFlush();
  }

  private containsSynchronizedMarker(data: Uint8Array): boolean {
    const combined = this.concat(this.scanTail, data);
    return (
      this.indexOf(combined, SYNCHRONIZED_OUTPUT_ENTER) !== -1 ||
      this.indexOf(combined, SYNCHRONIZED_OUTPUT_EXIT) !== -1
    );
  }

  private updateProtocolState(data: Uint8Array): void {
    const combined = this.concat(this.scanTail, data);
    let index = 0;

    while (index <= combined.length - SYNCHRONIZED_OUTPUT_MARKER_LENGTH) {
      const enterIndex = this.indexOf(combined, SYNCHRONIZED_OUTPUT_ENTER, index);
      const exitIndex = this.indexOf(combined, SYNCHRONIZED_OUTPUT_EXIT, index);
      const nextIndex = this.nextMarkerIndex(enterIndex, exitIndex);
      if (nextIndex === -1) break;

      if (enterIndex !== -1 && enterIndex === nextIndex) {
        const wasSynchronized = this.synchronizedOutput;
        this.synchronizedOutput = true;
        this.awaitingTrailingOutput = false;
        this.cancelScheduledFlush();
        if (!wasSynchronized) this.scheduleSynchronizedOutputTimeout();
      } else {
        this.synchronizedOutput = false;
        this.awaitingTrailingOutput = true;
        this.cancelSynchronizedOutputTimeout();
        this.schedulePendingFlush();
      }

      index = nextIndex + SYNCHRONIZED_OUTPUT_MARKER_LENGTH;
    }

    this.scanTail = combined.slice(
      Math.max(0, combined.length - SYNCHRONIZED_OUTPUT_MARKER_LENGTH + 1),
    );
  }

  private schedulePendingFlush(): void {
    if (this.scheduledFlush !== undefined) return;

    this.scheduledFlush = this.scheduleFlush(() => {
      this.scheduledFlush = undefined;
      this.awaitingTrailingOutput = false;
      if (!this.synchronizedOutput) this.flushPending();
    }, this.settleDelayMs);
  }

  private cancelScheduledFlush(): void {
    if (this.scheduledFlush === undefined) return;
    this.cancelFlush(this.scheduledFlush);
    this.scheduledFlush = undefined;
  }

  private scheduleSynchronizedOutputTimeout(): void {
    if (this.synchronizedOutputTimeout !== undefined) return;

    this.synchronizedOutputTimeout = this.scheduleFlush(() => {
      this.synchronizedOutputTimeout = undefined;
      if (!this.synchronizedOutput) return;
      this.forceFlush();
    }, this.synchronizedOutputTimeoutMs);
  }

  private cancelSynchronizedOutputTimeout(): void {
    if (this.synchronizedOutputTimeout === undefined) return;
    this.cancelFlush(this.synchronizedOutputTimeout);
    this.synchronizedOutputTimeout = undefined;
  }

  private forceFlush(): void {
    this.cancelScheduledFlush();
    this.cancelSynchronizedOutputTimeout();
    this.synchronizedOutput = false;
    this.awaitingTrailingOutput = false;
    this.flushPending();
  }

  private flushPending(): void {
    if (this.pending.length === 0) return;

    const writes = this.pending.splice(0);
    this.pendingBytes = 0;
    const data = this.concatMany(writes.map((write) => write.data));
    this.write(data, () => {
      for (const write of writes) write.onComplete();
    });
  }

  private indexOf(data: Uint8Array, needle: Uint8Array, fromIndex = 0): number {
    outer: for (let index = fromIndex; index <= data.length - needle.length; index += 1) {
      for (let offset = 0; offset < needle.length; offset += 1) {
        if (data[index + offset] !== needle[offset]) continue outer;
      }
      return index;
    }
    return -1;
  }

  private nextMarkerIndex(enterIndex: number, exitIndex: number): number {
    if (enterIndex === -1) return exitIndex;
    if (exitIndex === -1) return enterIndex;
    return Math.min(enterIndex, exitIndex);
  }

  private concat(left: Uint8Array, right: Uint8Array): Uint8Array {
    const result = new Uint8Array(left.length + right.length);
    result.set(left);
    result.set(right, left.length);
    return result;
  }

  private concatMany(chunks: Uint8Array[]): Uint8Array {
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}
