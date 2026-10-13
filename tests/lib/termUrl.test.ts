import { describe, expect, it } from "vitest";
import {
  cleanTrailingPunctuation,
  findUrlsInText,
  isHttpUrl,
} from "../../src/lib/termUrl";

describe("cleanTrailingPunctuation URL 末尾标点清洗", () => {
  it("保持干净的 URL 不变", () => {
    expect(cleanTrailingPunctuation("http://localhost:3000")).toBe("http://localhost:3000");
    expect(cleanTrailingPunctuation("https://vite.dev/guide/")).toBe("https://vite.dev/guide/");
  });

  it("剥离句末句点、逗号、分号与引号", () => {
    expect(cleanTrailingPunctuation("http://localhost:3000.")).toBe("http://localhost:3000");
    expect(cleanTrailingPunctuation("http://localhost:3000,")).toBe("http://localhost:3000");
    expect(cleanTrailingPunctuation("http://localhost:3000;")).toBe("http://localhost:3000");
    expect(cleanTrailingPunctuation("http://localhost:3000\"")).toBe("http://localhost:3000");
    expect(cleanTrailingPunctuation("http://localhost:3000'")).toBe("http://localhost:3000");
  });

  it("剥离包裹 URL 的外层括号，但保留 URL 内部合法的平衡括号", () => {
    // 正则提取出的末尾闭括号（外层配对括号在 http 之前，提取出的 raw string 仅含末尾闭括号）
    expect(cleanTrailingPunctuation("http://localhost:3000)")).toBe("http://localhost:3000");
    expect(cleanTrailingPunctuation("http://localhost:3000]")).toBe("http://localhost:3000");
    expect(cleanTrailingPunctuation("http://localhost:3000）")).toBe("http://localhost:3000");
    expect(cleanTrailingPunctuation("http://localhost:3000】")).toBe("http://localhost:3000");

    // 内部平衡括号保留（例如维基百科条目）
    expect(cleanTrailingPunctuation("https://en.wikipedia.org/wiki/C_(programming_language)")).toBe(
      "https://en.wikipedia.org/wiki/C_(programming_language)"
    );
  });
});

describe("findUrlsInText 行内 URL 扫描与列坐标计算", () => {
  it("正确识别单个 URL 及其 1-based 列区间", () => {
    const text = "  Local:   http://localhost:5173/";
    // 构建 1:1 的纯 ASCII 列映射（1-based）
    const charToCol = Array.from({ length: text.length }, (_, i) => i + 1);

    const matches = findUrlsInText(text, charToCol);
    expect(matches).toHaveLength(1);
    expect(matches[0].url).toBe("http://localhost:5173/");
    expect(matches[0].startCol).toBe(12);
    expect(matches[0].endCol).toBe(33);
  });

  it("当 URL 被括号或引号包裹时，能正确剥离末尾符号并计算精确列区间", () => {
    const text = "Open (http://localhost:3000) or \"https://example.com/\" now";
    const charToCol = Array.from({ length: text.length }, (_, i) => i + 1);

    const matches = findUrlsInText(text, charToCol);
    expect(matches).toHaveLength(2);
    expect(matches[0].url).toBe("http://localhost:3000");
    expect(matches[1].url).toBe("https://example.com/");
  });

  it("一行内存在多个 URL 时均能准确识别", () => {
    const text = "Local: http://localhost:3000 Network: http://192.168.1.5:3000";
    const charToCol = Array.from({ length: text.length }, (_, i) => i + 1);

    const matches = findUrlsInText(text, charToCol);
    expect(matches).toHaveLength(2);
    expect(matches[0].url).toBe("http://localhost:3000");
    expect(matches[1].url).toBe("http://192.168.1.5:3000");
  });

  it("中文宽字符（占用2个单元格）前缀下，URL 的列坐标正确偏移", () => {
    // "服务地址：" 5 个全角字符，每个占 2 列，共占据前 10 列（1~10）
    // 后面紧跟 "http://127.0.0.1:8080"
    const text = "服务地址：http://127.0.0.1:8080";
    // 构建模拟列映射：前 5 个中文对应列 1, 3, 5, 7, 9，后面从 11 开始
    const charToCol: number[] = [1, 3, 5, 7, 9];
    let col = 11;
    for (let i = 5; i < text.length; i += 1) {
      charToCol.push(col);
      col += 1;
    }

    const matches = findUrlsInText(text, charToCol);
    expect(matches).toHaveLength(1);
    expect(matches[0].url).toBe("http://127.0.0.1:8080");
    // 起始字符应在列 11
    expect(matches[0].startCol).toBe(11);
  });
});

describe("isHttpUrl 判断", () => {
  it("识别合法 http/https 链接", () => {
    expect(isHttpUrl("http://localhost:3000")).toBe(true);
    expect(isHttpUrl("https://github.com")).toBe(true);
    expect(isHttpUrl("http://127.0.0.1:8080/api?a=1#test")).toBe(true);
  });

  it("过滤非法或非 http 链接", () => {
    expect(isHttpUrl("file:///C:/test.txt")).toBe(false);
    expect(isHttpUrl("ftp://example.com")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});
