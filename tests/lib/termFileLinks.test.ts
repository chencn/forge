import { describe, expect, it } from "vitest";
import { parseTermFileLinks } from "../../src/lib/termFileLinks";

const ROOT = "D:\\app\\code\\forge";

describe("parseTermFileLinks 认终端输出里的文件路径", () => {
  it("相对路径按起始目录落成绝对路径，带上行号列号", () => {
    const [link] = parseTermFileLinks("  --> src/main.rs:10:5", ROOT);
    expect(link).toMatchObject({
      path: "D:\\app\\code\\forge\\src\\main.rs",
      line: 10,
      column: 5,
      text: "src/main.rs:10:5",
      startIndex: 6,
    });
    expect(link.endIndex).toBe(6 + "src/main.rs:10:5".length);
  });

  it("tsc 的括号写法：行号列号在括号里，结尾冒号不算链接", () => {
    const [link] = parseTermFileLinks("src/App.tsx(12,7): error TS2304", ROOT);
    expect(link).toMatchObject({ line: 12, column: 7, text: "src/App.tsx(12,7)" });
  });

  it("Windows 绝对路径原样用，句尾标点剥掉", () => {
    const [link] = parseTermFileLinks("see C:\\work\\a.txt.", ROOT);
    expect(link).toMatchObject({ path: "C:\\work\\a.txt", text: "C:\\work\\a.txt", line: undefined });
  });

  it("Git Bash 的 /d/... 写法转成盘符路径", () => {
    const [link] = parseTermFileLinks("/d/app/x.ts:3", ROOT);
    expect(link).toMatchObject({ path: "D:\\app\\x.ts", line: 3 });
  });

  it("file:// 解码成本地路径", () => {
    const [link] = parseTermFileLinks("file:///C:/work/a%20b.md", ROOT);
    expect(link.path).toBe("C:/work/a b.md");
  });

  it("不像文件的不认：分支名、版本号、网址、没有分隔符的词", () => {
    expect(parseTermFileLinks("origin/main", ROOT)).toEqual([]);
    expect(parseTermFileLinks("v1/1.2.3", ROOT)).toEqual([]);
    expect(parseTermFileLinks("https://example.com/a.js", ROOT)).toEqual([]);
    expect(parseTermFileLinks("package.json", ROOT)).toEqual([]);
  });

  it("Windows 工作区里出现的 Linux 绝对路径落不下来，不认", () => {
    expect(parseTermFileLinks("/home/me/a.txt", ROOT)).toEqual([]);
  });
});
