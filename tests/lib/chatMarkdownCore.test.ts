import { describe, expect, it } from "vitest";
import {
  blockKey,
  renderChatHtmlRaw,
  renderChatTokenBlocks,
  repairStreamingMarkdown,
} from "../../src/lib/chatMarkdownCore";
import { fenceLanguages, hasGrammar, prepareHighlight } from "../../src/lib/cm/grammars";

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

function join(blocks: Array<{ html: string }>): string {
  return blocks.map((block) => block.html).join("");
}

describe("renderChatTokenBlocks", () => {
  it("逐块拼接与整段渲染等价", () => {
    for (const source of SAMPLES) {
      expect(join(renderChatTokenBlocks(source, "copy", false))).toBe(renderChatHtmlRaw(source, "copy"));
    }
  });

  it("流式开关不改变 HTML，只改变块指纹", () => {
    // 原来流式那一档要跳过 highlightAuto 的全表试探；Lezer 没有猜语言这一步，
    // 两条路径出的是同一份 HTML，开关只剩下让缓存区分流式与落定这一件事还有用。
    for (const source of ["```ts\nconst a = 1;\n```", "```\nconst a = 1;\n```"]) {
      expect(join(renderChatTokenBlocks(source, "copy", true))).toBe(join(renderChatTokenBlocks(source, "copy", false)));
    }
    expect(blockKey("同一段", "copy", true)).not.toBe(blockKey("同一段", "copy", false));
  });

  it("没标语言的围栏按素文本排，不去猜", () => {
    const html = join(renderChatTokenBlocks("```\nconst a = 1;\n```", "copy", false));
    expect(html).toContain("const a = 1;");
    expect(html).not.toContain("tok-keyword");
  });

  it("块指纹只随内容变化", () => {
    expect(blockKey("同一段", "copy", false)).toBe(blockKey("同一段", "copy", false));
    expect(blockKey("同一段", "copy", false)).not.toBe(blockKey("另一段", "copy", false));
    expect(blockKey("同一段", "copy", false)).not.toBe(blockKey("同一段", "copy", true));
  });
});

describe("Lezer 高亮", () => {
  it("扫出围栏标注的语言", () => {
    expect(fenceLanguages("```ts\nx\n```")).toEqual(["ts"]);
    expect(fenceLanguages("``` python\nx\n```\n~~~sh\ny\n~~~")).toEqual(["python", "sh"]);
    expect(fenceLanguages("没有围栏")).toEqual([]);
  });

  it("语法没装上时不产出 span，装上后同一份正文出 tok-* 类", async () => {
    const source = "```ts\nconst a = 1;\n```";
    expect(hasGrammar("ts")).toBe(true);
    expect(join(renderChatTokenBlocks(source, "copy", false))).not.toContain("tok-");
    expect(await prepareHighlight(fenceLanguages(source))).toBe(true);
    const html = join(renderChatTokenBlocks(source, "copy", false));
    expect(html).toContain("tok-keyword");
    // 已经装好了，再问一次不该重复加载。
    expect(await prepareHighlight(["ts"])).toBe(false);
  });

  it("认不出的语言不占加载名额", async () => {
    expect(hasGrammar("不存在的语言")).toBe(false);
    expect(await prepareHighlight(["不存在的语言", "text", ""])).toBe(false);
  });
});

describe("repairStreamingMarkdown", () => {
  it("补齐未闭合的围栏", () => {
    expect(repairStreamingMarkdown("```ts\nconst a = 1;")).toBe("```ts\nconst a = 1;\n```");
    expect(repairStreamingMarkdown("~~~py\nx = 1")).toBe("~~~py\nx = 1\n~~~");
    expect(repairStreamingMarkdown("已经闭合\n```\n代码\n```")).toBe("已经闭合\n```\n代码\n```");
  });
});
