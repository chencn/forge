import { describe, expect, it } from "vitest";
import { applyMention, mentionAt, mentionPathOf, splitMentionTokens } from "../../src/lib/aiMention";

describe("mentionAt", () => {
  it("光标前紧邻的 @token 命中，返回起点与查询词", () => {
    expect(mentionAt("看看 @src/ma", 10)).toEqual({ start: 3, query: "src/ma" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("(@ind", 5)).toEqual({ start: 1, query: "ind" });
  });

  it("邮箱里的 @ 与普通词中间的 @ 不算提及", () => {
    expect(mentionAt("写信到 a@example", 14)).toBeNull();
    expect(mentionAt("foo@bar", 7)).toBeNull();
  });

  it("光标离开 token 之后不再命中", () => {
    expect(mentionAt("@src 已完成", 9)).toBeNull();
  });
});

describe("applyMention", () => {
  it("把 @query 换成 @路径（后面已有空白就不补），光标落在路径后", () => {
    const applied = applyMention("看看 @src/ma 呗", 10, 3, "src/main.ts");
    expect(applied.text).toBe("看看 @src/main.ts 呗");
    expect(applied.caret).toBe(3 + 1 + "src/main.ts".length);
    const appended = applyMention("看看 @src/ma", 10, 3, "src/main.ts");
    expect(appended.text).toBe("看看 @src/main.ts ");
    expect(appended.caret).toBe(3 + 1 + "src/main.ts".length + 1);
  });
});

describe("mentionPathOf", () => {
  it("剥掉工作区前缀并统一正斜杠", () => {
    expect(mentionPathOf("D:\\app\\code\\forge\\src\\a.ts", "D:\\app\\code\\forge")).toBe("src/a.ts");
    expect(mentionPathOf("/home/u/proj/b.md", "/home/u/proj")).toBe("b.md");
  });

  it("工作区外的路径原样返回（正斜杠化）", () => {
    expect(mentionPathOf("D:\\other\\c.txt", "D:\\app")).toBe("D:/other/c.txt");
  });
});

describe("splitMentionTokens", () => {
  it("正文切成普通片段与提及交替", () => {
    const parts = splitMentionTokens("先看 @src/a.ts 再看 @docs/x.md，谢谢");
    expect(parts.filter((part) => part.mention).map((part) => part.text)).toEqual(["@src/a.ts", "@docs/x.md"]);
    expect(parts.map((part) => part.text).join("")).toBe("先看 @src/a.ts 再看 @docs/x.md，谢谢");
  });

  it("邮箱不是提及，行首提及也命中", () => {
    expect(splitMentionTokens("a@b.com").some((part) => part.mention)).toBe(false);
    expect(splitMentionTokens("@readme.md 开头")[0]).toEqual({ text: "@readme.md", mention: true });
  });
});
