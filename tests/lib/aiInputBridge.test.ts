import { describe, expect, it } from "vitest";
import { appendAiInputText, formatAiFileReference, routeAiTargets } from "../../src/lib/aiInputBridge";

describe("AI 输入投递路由", () => {
  it("没有标签禁用、单标签直发、多标签交给二级菜单选择", () => {
    const first = { id: "one", title: "会话一" };
    const second = { id: "two", title: "会话二" };
    expect(routeAiTargets([])).toEqual({ kind: "disabled" });
    expect(routeAiTargets([first])).toEqual({ kind: "direct", target: first });
    expect(routeAiTargets([first, second])).toEqual({ kind: "choose", targets: [first, second] });
  });

  it("文件引用首行是绝对路径并规范行号", () => {
    expect(formatAiFileReference("D:\\repo\\src\\a.ts", 8, 3)).toBe("D:\\repo\\src\\a.ts\n第 8 行到第 8 行");
  });

  it("向已有草稿追加独立段落且忽略空文本", () => {
    expect(appendAiInputText("原问题\n", "  新上下文  ")).toBe("原问题\n\n  新上下文  ");
    expect(appendAiInputText("原问题", "   ")).toBe("原问题");
  });
});
