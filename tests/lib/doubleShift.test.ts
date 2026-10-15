import { describe, expect, it } from "vitest";
import { DoubleShiftDetector } from "../../src/lib/doubleShift";

describe("DoubleShiftDetector 双击与长按手势识别", () => {
  it("快速双击 Shift 能够成功触发", () => {
    const detector = new DoubleShiftDetector(280, 350);

    // 第 1 次按下并松开（按下 60ms）
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 100, repeat: false })).toBe(false);
    detector.handleKeyUp({ key: "Shift", timeStamp: 160 });

    // 120ms 后第 2 次按下
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 280, repeat: false })).toBe(true);
  });

  it("长按 Shift 产生 repeat 事件时绝不触发搜索", () => {
    const detector = new DoubleShiftDetector(280, 350);

    // 第 1 次按下
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 100, repeat: false })).toBe(false);

    // 持续长按，系统产生多次 repeat
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 350, repeat: true })).toBe(false);
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 380, repeat: true })).toBe(false);
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 410, repeat: true })).toBe(false);

    // 最终松开
    detector.handleKeyUp({ key: "Shift", timeStamp: 800 });

    // 长按释放后，过一小会儿再单按一次，不应触发双击
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 900, repeat: false })).toBe(false);
  });

  it("长按 Shift 超过单次按压时限后松开，不应作为双击的前半段", () => {
    const detector = new DoubleShiftDetector(280, 350);

    // 用户长按了 400ms（超过 280ms 时限），即便没有产生 repeat
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 100, repeat: false })).toBe(false);
    detector.handleKeyUp({ key: "Shift", timeStamp: 500 });

    // 松开后即便快速再按一次，也不应触发双击
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 580, repeat: false })).toBe(false);
  });

  it("按住 Shift 期间按了其他键，双击手势被打断", () => {
    const detector = new DoubleShiftDetector(280, 350);

    // 按下 Shift
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 100, repeat: false })).toBe(false);

    // 期间按了 A 键（例如 Shift+A 组合或误触）
    expect(detector.handleKeyDown({ key: "a", timeStamp: 140, repeat: false })).toBe(false);
    detector.handleKeyUp({ key: "a", timeStamp: 180 });

    // 松开 Shift
    detector.handleKeyUp({ key: "Shift", timeStamp: 200 });

    // 紧接着再按一次 Shift，不应被视为双击
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 260, repeat: false })).toBe(false);
  });

  it("带有 Ctrl / Alt / Meta 等其他修饰键时不能触发", () => {
    const detector = new DoubleShiftDetector(280, 350);

    // 先正常按一下 Shift 并松开
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 100, repeat: false })).toBe(false);
    detector.handleKeyUp({ key: "Shift", timeStamp: 150 });

    // 第二次按下带有 Ctrl（如 Ctrl+Shift 组合）
    expect(
      detector.handleKeyDown({ key: "Shift", timeStamp: 220, repeat: false, ctrlKey: true })
    ).toBe(false);
  });

  it("处于禁用状态（如输入框中、弹窗模态开着）时不触发并重置状态", () => {
    const detector = new DoubleShiftDetector(280, 350);

    // 第 1 次正常按下松开
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 100, repeat: false })).toBe(false);
    detector.handleKeyUp({ key: "Shift", timeStamp: 150 });

    // 第 2 次处于 disabled（例如在重命名输入框内）
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 220, repeat: false }, true)).toBe(false);

    // 离开禁用后再次按下，不应受之前的残留影响
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 300, repeat: false })).toBe(false);
  });

  it("窗口 blur 失焦会重置双击状态", () => {
    const detector = new DoubleShiftDetector(280, 350);

    // 第 1 次按下松开
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 100, repeat: false })).toBe(false);
    detector.handleKeyUp({ key: "Shift", timeStamp: 150 });

    // 窗口失去焦点（如 Alt+Tab）
    detector.reset();

    // 焦点回到窗口后按下 Shift，不应触发
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 220, repeat: false })).toBe(false);
  });

  it("两次单击间隔超过时限后不触发", () => {
    const detector = new DoubleShiftDetector(280, 350);

    // 第 1 次按下松开
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 100, repeat: false })).toBe(false);
    detector.handleKeyUp({ key: "Shift", timeStamp: 150 });

    // 间隔 400ms（超过 350ms 限制）再按
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 560, repeat: false })).toBe(false);
  });

  it("双击成功触发后，连续按第 3 次不会连续触发", () => {
    const detector = new DoubleShiftDetector(280, 350);

    // 正常的双击
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 100, repeat: false })).toBe(false);
    detector.handleKeyUp({ key: "Shift", timeStamp: 150 });
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 220, repeat: false })).toBe(true);
    detector.handleKeyUp({ key: "Shift", timeStamp: 280 });

    // 紧接着按第 3 次
    expect(detector.handleKeyDown({ key: "Shift", timeStamp: 350, repeat: false })).toBe(false);
  });
});
