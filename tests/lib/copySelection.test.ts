import { describe, expect, it } from "vitest";
import { shouldCopyDomSelection } from "../../src/lib/copySelection";
import type { CopySelectionKey, CopySelectionTarget } from "../../src/lib/copySelection";

const div: CopySelectionTarget = { tagName: "DIV", isContentEditable: false };

function key(partial: Partial<CopySelectionKey>): CopySelectionKey {
  return { key: "c", ctrlKey: true, ...partial };
}

describe("shouldCopyDomSelection", () => {
  it("普通 Ctrl+C 且有选区时复制", () => {
    expect(shouldCopyDomSelection(key({}), div, "hello")).toBe(true);
  });

  it("macOS 的 Cmd+C 同样复制", () => {
    expect(shouldCopyDomSelection(key({ ctrlKey: false, metaKey: true }), div, "hello")).toBe(true);
  });

  it("大写 C 也认", () => {
    expect(shouldCopyDomSelection(key({ key: "C" }), div, "hello")).toBe(true);
  });

  it("只含空白的选区也复制", () => {
    expect(shouldCopyDomSelection(key({}), div, " ")).toBe(true);
  });

  it("没有焦点元素时仍复制选区", () => {
    expect(shouldCopyDomSelection(key({}), null, "hello")).toBe(true);
  });

  it("选区为空时放过，留给资源管理器复制文件", () => {
    expect(shouldCopyDomSelection(key({}), div, "")).toBe(false);
  });

  it("输入框、文本域、可编辑区域留给浏览器和编辑器", () => {
    expect(
      shouldCopyDomSelection(key({}), { tagName: "INPUT", isContentEditable: false }, "hello"),
    ).toBe(false);
    expect(
      shouldCopyDomSelection(key({}), { tagName: "TEXTAREA", isContentEditable: false }, "hello"),
    ).toBe(false);
    expect(
      shouldCopyDomSelection(key({}), { tagName: "DIV", isContentEditable: true }, "hello"),
    ).toBe(false);
  });

  it("带 Shift 或 Alt 的组合留给别的命令", () => {
    expect(shouldCopyDomSelection(key({ shiftKey: true }), div, "hello")).toBe(false);
    expect(shouldCopyDomSelection(key({ altKey: true }), div, "hello")).toBe(false);
    expect(shouldCopyDomSelection(key({ altKey: true, shiftKey: true }), div, "hello")).toBe(false);
  });

  it("没有主修饰键、或不是 C 时不接手", () => {
    expect(shouldCopyDomSelection(key({ ctrlKey: false }), div, "hello")).toBe(false);
    expect(shouldCopyDomSelection(key({ key: "x" }), div, "hello")).toBe(false);
    expect(shouldCopyDomSelection(key({ key: "v" }), div, "hello")).toBe(false);
  });
});
