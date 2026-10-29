import { describe, expect, it } from "vitest";
import { parseLocationQuery } from "../../src/lib/seQuery";

describe("parseLocationQuery 地点解析", () => {
  it("认 `:行` 与 `:行:列`，剩下的才是拿去匹配的文字", () => {
    expect(parseLocationQuery("File.kt:42")).toEqual({ text: "File.kt", line: 42, col: null });
    expect(parseLocationQuery("File.kt:42:5")).toEqual({ text: "File.kt", line: 42, col: 5 });
  });

  it("认 IDE 复制出来的 `Foo(42,5)` 括号写法", () => {
    expect(parseLocationQuery("Foo(42,5)")).toEqual({ text: "Foo", line: 42, col: 5 });
  });

  it("套了引号先剥掉", () => {
    expect(parseLocationQuery('"File.kt:42"')).toEqual({ text: "File.kt", line: 42, col: null });
  });

  it("file:// 链接与 Windows 反斜杠都折成正斜杠路径", () => {
    expect(parseLocationQuery("file:///D:/my%20dir/x.ts:10")).toEqual({ text: "/D:/my dir/x.ts", line: 10, col: null });
    expect(parseLocationQuery("D:\\app\\src\\File.ts:7")).toEqual({ text: "D:/app/src/File.ts", line: 7, col: null });
  });

  it("给了根就把绝对路径剪成相对出处", () => {
    expect(parseLocationQuery("D:/app/forge/src/File.ts:3", "D:/app/forge").text).toBe("src/File.ts");
    expect(parseLocationQuery("D:/app/forge/src/File.ts:3", "D:/app/forge").line).toBe(3);
    expect(parseLocationQuery("D:/app/forge", "D:/app/forge/").text).toBe("");
  });

  it("对不上地点格式的原样当查询", () => {
    expect(parseLocationQuery("hello world")).toEqual({ text: "hello world", line: null, col: null });
    expect(parseLocationQuery("File.ts:")).toEqual({ text: "File.ts:", line: null, col: null });
    // 行号必须是正的，0 不算地点。
    expect(parseLocationQuery("src/x.ts:0")).toEqual({ text: "src/x.ts:0", line: null, col: null });
  });

  it("行列号跟着这边的 1 起口径，不做换算", () => {
    const p = parseLocationQuery("App.tsx:1:1");
    expect(p).toEqual({ text: "App.tsx", line: 1, col: 1 });
  });
});
