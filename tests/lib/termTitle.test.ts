import { describe, expect, it } from "vitest";
import { isTabWorthyTitle, normalizeTermTitle } from "../../src/lib/termTitle";
import { parseOsc7 } from "../../src/lib/termOsc";
import { pasteNeedsConfirm } from "../../src/lib/termPaste";

describe("normalizeTermTitle", () => {
  it("ConPTY 报的可执行文件全路径只留程序名", () => {
    expect(normalizeTermTitle("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
    expect(normalizeTermTitle("C:\\WINDOWS\\system32\\cmd.exe - npm  run dev")).toBe("cmd - npm  run dev");
  });

  it("普通标题原样保留", () => {
    expect(normalizeTermTitle("  vim a.txt ")).toBe("vim a.txt");
  });

  it("空的、带控制字符或半截转义序列的不要", () => {
    expect(normalizeTermTitle("   ")).toBeNull();
    expect(normalizeTermTitle("a\u0007b")).toBeNull();
    expect(normalizeTermTitle("title[?25h")).toBeNull();
  });
});

describe("isTabWorthyTitle", () => {
  it("短标题留着", () => {
    expect(isTabWorthyTitle("cmd - npm run dev")).toBe(true);
    expect(isTabWorthyTitle("vim a.txt")).toBe(true);
  });

  it("带主机名、路径或太长的不上页签", () => {
    expect(isTabWorthyTitle("me@box: ~/project")).toBe(false);
    expect(isTabWorthyTitle("C:\\Users\\me")).toBe(false);
    expect(isTabWorthyTitle("x".repeat(33))).toBe(false);
    expect(isTabWorthyTitle(null)).toBe(false);
  });
});

describe("parseOsc7", () => {
  it("Windows 路径去掉盘符前的斜杠并换成反斜杠", () => {
    expect(parseOsc7("file://host/C:/Users/me%20x")).toBe("C:\\Users\\me x");
  });

  it("Unix 路径原样", () => {
    expect(parseOsc7("file://host/home/me")).toBe("/home/me");
  });

  it("不是 file:// 的不认", () => {
    expect(parseOsc7("http://x/y")).toBeNull();
  });
});

describe("pasteNeedsConfirm", () => {
  it("五行以上或一千字以上才确认", () => {
    expect(pasteNeedsConfirm("a\nb\nc\nd")).toBe(false);
    expect(pasteNeedsConfirm("a\nb\nc\nd\ne")).toBe(true);
    expect(pasteNeedsConfirm("x".repeat(1000))).toBe(true);
  });
});
