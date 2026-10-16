import { describe, expect, it } from "vitest";
import { stripEraseScrollback } from "../../src/lib/termHistory";

const text = (value: string) => new TextEncoder().encode(value);
const marker = new Uint8Array([0x1b, 0x5b, 0x33, 0x4a]);

describe("stripEraseScrollback", () => {
  it("普通输出原样留下", () => {
    const chunk = text("hello\r\n");
    const result = stripEraseScrollback(new Uint8Array(0), chunk);
    expect(result.data).toBe(chunk);
    expect(result.carry).toHaveLength(0);
  });

  it("整段擦滚屏标记被拿掉，前后的日志还在", () => {
    const chunk = new Uint8Array([...text("keep\n"), ...marker, ...text("next\n")]);
    const result = stripEraseScrollback(new Uint8Array(0), chunk);
    expect(new TextDecoder().decode(result.data)).toBe("keep\nnext\n");
    expect(result.carry).toHaveLength(0);
  });

  it("标记被切在两包之间时，凑齐再拿掉", () => {
    const first = stripEraseScrollback(new Uint8Array(0), new Uint8Array([...text("a"), 0x1b, 0x5b]));
    expect(new TextDecoder().decode(first.data)).toBe("a");
    expect(Array.from(first.carry)).toEqual([0x1b, 0x5b]);

    const second = stripEraseScrollback(first.carry, new Uint8Array([0x33, 0x4a, ...text("b")]));
    expect(new TextDecoder().decode(second.data)).toBe("b");
    expect(second.carry).toHaveLength(0);
  });

  it("半截转义不是擦滚屏标记时，字节还回去", () => {
    const first = stripEraseScrollback(new Uint8Array(0), new Uint8Array([0x1b, 0x5b]));
    const second = stripEraseScrollback(first.carry, text("1mred"));
    expect(new TextDecoder().decode(second.data)).toBe("\u001b[1mred");
    expect(second.carry).toHaveLength(0);
  });
});
