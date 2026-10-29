import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { BracketScanner, bracketClass } from "../../src/lib/cm/rainbowBrackets";

/**
 * 彩虹括号的深度扫描。
 *
 * 直接问扫描器要结果，不挂编辑器：装饰那一层只是把深度换成类名，真正会算错的是
 * 嵌套栈、字符串与注释的跳过、以及检查点复用之后还准不准。
 */

function marks(doc: string, from = 0, to = doc.length): Array<{ from: number; depth: number }> {
  const state = EditorState.create({ doc });
  return new BracketScanner().marks(state, from, to);
}

describe("括号深度", () => {
  it("左右各按所在深度上色", () => {
    const doc = "((x))";
    expect(marks(doc).map((mark) => mark.depth)).toEqual([0, 1, 1, 0]);
    expect(marks(doc).map((mark) => mark.from)).toEqual([0, 1, 3, 4]);
  });

  it("配不上的那半颗给 -1", () => {
    expect(marks("a)b").map((mark) => mark.depth)).toEqual([-1]);
    // 一路开到文档尾都没闭合的左括号：整篇扫完仍然没有右括号，才算它配不上。
    expect(marks("(abc").map((mark) => mark.depth)).toEqual([-1]);
    // 后面确实闭合了就不该标红。
    expect(marks("(a)b").map((mark) => mark.depth)).toEqual([0, 0]);
  });

  it("字符串里的括号不算一层", () => {
    // `f("(")`：真正的括号在 1 和 5，字符串里那颗（3）不该进来，也不该把里面那颗算成嵌套。
    const found = marks('f("(")');
    expect(found.map((mark) => mark.from)).toEqual([1, 5]);
    expect(found.map((mark) => mark.depth)).toEqual([0, 0]);
  });

  it("只问视口那一段，深度仍然从整篇算起", () => {
    const doc = `${"x".repeat(9_000)}((y))`;
    const found = marks(doc, 9_000, doc.length);
    expect(found.map((mark) => mark.depth)).toEqual([0, 1, 1, 0]);
  });

  it("类名按三档循环，-1 走告警那一档", () => {
    expect(bracketClass(0)).toBe("cm-rainbow-bracket-1");
    expect(bracketClass(1)).toBe("cm-rainbow-bracket-2");
    expect(bracketClass(2)).toBe("cm-rainbow-bracket-3");
    expect(bracketClass(3)).toBe("cm-rainbow-bracket-1");
    expect(bracketClass(-1)).toBe("cm-rainbow-bracket-unmatched");
  });
});
