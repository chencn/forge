import { afterEach, describe, expect, it, vi } from "vitest";
import { TermOutputBuffer } from "../../src/lib/termOutputBuffer";

const ENTER = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68]);
const EXIT = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c]);

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("TermOutputBuffer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("普通输出立刻写出去", () => {
    const written: Uint8Array[] = [];
    const buffer = new TermOutputBuffer({
      write: (data) => written.push(data),
    });
    buffer.enqueue(bytes("hi"), () => {});
    expect(new TextDecoder().decode(written[0] ?? new Uint8Array())).toBe("hi");
  });

  it("同步输出先攒着，结束标记过后等 settle 再一次写完", () => {
    vi.useFakeTimers();
    const written: Uint8Array[] = [];
    const buffer = new TermOutputBuffer({
      write: (data) => written.push(data),
      settleDelayMs: 40,
    });
    buffer.enqueue(ENTER, () => {});
    buffer.enqueue(bytes("frame"), () => {});
    buffer.enqueue(EXIT, () => {});
    expect(written).toHaveLength(0);
    vi.advanceTimersByTime(40);
    expect(written).toHaveLength(1);
    expect(new TextDecoder().decode(written[0] ?? new Uint8Array())).toContain("frame");
  });

  it("同步输出迟迟不结束时，到超时强制刷出", () => {
    vi.useFakeTimers();
    const written: Uint8Array[] = [];
    const buffer = new TermOutputBuffer({
      write: (data) => written.push(data),
      synchronizedOutputTimeoutMs: 1000,
    });
    buffer.enqueue(ENTER, () => {});
    buffer.enqueue(bytes("stuck"), () => {});
    expect(written).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(written).toHaveLength(1);
  });
});
