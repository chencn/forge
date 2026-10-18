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

  it("不含标记的整包原样交出去，不另拷一份", () => {
    const chunk = text("just some ordinary output\r\n");
    const result = stripEraseScrollback(new Uint8Array(0), chunk);
    // 同一条引用：这条路径上不该产生任何拷贝。
    expect(result.data).toBe(chunk);
    expect(result.carry).toHaveLength(0);
  });

  it("带前缀进来的包剥完标记后，前缀那截不会再重复吐出", () => {
    const first = stripEraseScrollback(new Uint8Array(0), new Uint8Array([...text("a"), 0x1b]));
    // `a` 这一趟已经交出去了，carry 里只剩那半个标记。
    expect(new TextDecoder().decode(first.data)).toBe("a");
    expect(Array.from(first.carry)).toEqual([0x1b]);
    const second = stripEraseScrollback(first.carry, new Uint8Array([0x5b, 0x33, 0x4a, ...text("b")]));
    expect(new TextDecoder().decode(second.data)).toBe("b");
    expect(second.carry).toHaveLength(0);
  });

  it("一包里有多段擦滚屏标记时全部拿掉", () => {
    const chunk = new Uint8Array([
      ...text("1\n"),
      ...marker,
      ...text("2\n"),
      ...marker,
      ...text("3\n"),
    ]);
    const result = stripEraseScrollback(new Uint8Array(0), chunk);
    expect(new TextDecoder().decode(result.data)).toBe("1\n2\n3\n");
  });
});
