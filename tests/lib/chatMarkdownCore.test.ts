import { describe, expect, it } from "vitest";
import {
  blockKey,
  renderChatHtmlRaw,
  renderChatTokenBlocks,
  repairStreamingMarkdown,
} from "../../src/lib/chatMarkdownCore";

/**
 * 增量渲染的核心不变量：整段渲染 == 各顶层 token 渲染的拼接。
 * 参考定义（`[1]: url`）的解析发生在 lex 的第二遍、行内 token 里已经带全，
 * 所以跨块引用也必须与整段渲染一致——样例里专门放了一组。
 */
const SAMPLES = [
  "# 标题\n\n一段话，带 **粗体** 与 [链接](https://example.com)。",
  "```ts\nconst a = 1;\n```\n\n后文还有一段。",
  "- 列表项一\n- 列表项二\n\n1. 有序一\n2. 有序二",
  "> 引用行\n> 另一行\n\n| a | b |\n|---|---|\n| 1 | 2 |",
  "参考定义 [ref][1] 与 [ref][2] 混着用。\n\n[1]: https://a.example\n[2]: https://b.example",
  "任务清单：\n\n- [x] 已完成\n- [ ] 未完成",
  "行内代码 `x = y` 与 <span>直出的 HTML</span>。",
  "",
];

describe("renderChatTokenBlocks", () => {
  it("逐块拼接与整段渲染等价", () => {
    for (const source of SAMPLES) {
      const joined = renderChatTokenBlocks(source, "copy", false)
        .map((block) => block.html)
        .join("");
      expect(joined).toBe(renderChatHtmlRaw(source, "copy", false));
    }
  });

  it("流式开关只影响无语言代码块的自动高亮", () => {
    // 带已知语言的块：两条路径完全一致（openBlocks 只用于跳过 highlightAuto）。
    expect(renderChatTokenBlocks("```ts\nconst a = 1;\n```", "copy", true).map((b) => b.html).join(""))
      .toBe(renderChatHtmlRaw("```ts\nconst a = 1;\n```", "copy", true));
    // 无语言的短代码：非流式走 highlightAuto 出高亮 span，流式直接转义。
    const open = renderChatTokenBlocks("```\nconst a = 1;\nconst b = 2;\n```", "copy", true).map((b) => b.html).join("");
    const closed = renderChatTokenBlocks("```\nconst a = 1;\nconst b = 2;\n```", "copy", false).map((b) => b.html).join("");
    expect(open).not.toBe(closed);
  });

  it("块指纹只随内容变化", () => {
    expect(blockKey("同一段", "copy", false)).toBe(blockKey("同一段", "copy", false));
    expect(blockKey("同一段", "copy", false)).not.toBe(blockKey("另一段", "copy", false));
    expect(blockKey("同一段", "copy", false)).not.toBe(blockKey("同一段", "copy", true));
  });
});

describe("repairStreamingMarkdown", () => {
  it("补齐未闭合的围栏", () => {
    expect(repairStreamingMarkdown("```ts\nconst a = 1;")).toBe("```ts\nconst a = 1;\n```");
    expect(repairStreamingMarkdown("~~~py\nx = 1")).toBe("~~~py\nx = 1\n~~~");
    expect(repairStreamingMarkdown("已经闭合\n```\n代码\n```")).toBe("已经闭合\n```\n代码\n```");
  });
});
