import { describe, expect, it } from "vitest";
import { pathToUri, uriToPath } from "../../src/lib/lspUri";
import { canonicalPath } from "../../src/lib/format";

/**
 * LSP 那套 `file://` URI 的写法。
 *
 * 期望值不是照着实现编的：这一批是从 Monaco 的 `Uri.file(x).toString()` 上抄下来的实测值
 * （那份实现就是应用的语言服务一直在吃的串）。少一位编码、盘符大小写不同，
 * `didOpen` 与后续请求就不再指向同一份文档，症状是「语言服务在跑但补全全无」。
 */
describe("pathToUri 与原来 Monaco 的 Uri.file 逐字节一致", () => {
  const CASES: Array<[string, string]> = [
    ["D:\\app\\code\\forge\\src\\App.tsx", "file:///d%3A/app/code/forge/src/App.tsx"],
    ["D:/app/x.ts", "file:///d%3A/app/x.ts"],
    ["D:\\", "file:///d%3A/"],
    ["D:\\dir\\", "file:///d%3A/dir/"],
    ["D:\\.hidden\\file", "file:///d%3A/.hidden/file"],
    ["C:\\Users\\me\\a b\\c#d.ts", "file:///c%3A/Users/me/a%20b/c%23d.ts"],
    ["D:\\a(b)[c]{d}.ts", "file:///d%3A/a%28b%29%5Bc%5D%7Bd%7D.ts"],
    ["D:\\p@q&r+s=t~u.ts", "file:///d%3A/p%40q%26r%2Bs%3Dt~u.ts"],
    ["D:\\100%25-done.md", "file:///d%3A/100%2525-done.md"],
    ["D:\\50%-off.md", "file:///d%3A/50%25-off.md"],
    ["D:\\a?b.md", "file:///d%3A/a%3Fb.md"],
    ["D:\\with'quote.md", "file:///d%3A/with%27quote.md"],
    ["D:\\with\"double.md", "file:///d%3A/with%22double.md"],
    ["D:\\back\\slash,comma;semi.md", "file:///d%3A/back/slash%2Ccomma%3Bsemi.md"],
    ["D:\\中文\\文件.txt", "file:///d%3A/%E4%B8%AD%E6%96%87/%E6%96%87%E4%BB%B6.txt"],
    ["/home/user/proj/main.go", "file:///home/user/proj/main.go"],
    ["/", "file:///"],
    ["", "file:///"],
    // 相对路径不是绝对路径：照样补一条前导斜杠，与原来那版一致。
    ["relative/path.ts", "file:///relative/path.ts"],
    // UNC：主机名进 authority，路径里不再重复它。
    ["\\\\nas\\share\\x.rs", "file://nas/share/x.rs"],
  ];

  it.each(CASES)("%s", (path, uri) => {
    expect(pathToUri(path)).toBe(uri);
  });
});

describe("uriToPath 兜回同一条路径", () => {
  it("往返后归一到同一个 canonicalPath", () => {
    const paths = [
      "D:\\app\\code\\forge\\src\\App.tsx",
      "C:\\Users\\me\\a b\\c#d.ts",
      "D:\\中文\\文件.txt",
      "D:\\50%-off.md",
      "D:\\a?b.md",
      "/home/user/proj/main.go",
    ];
    for (const path of paths) {
      expect(canonicalPath(uriToPath(pathToUri(path)))).toBe(canonicalPath(path));
    }
  });

  it("认得语言服务自己规范化出来的写法", () => {
    // 服务器回的串常见两种：盘符大小写不同、冒号编码与否不同。都归到同一条路径。
    expect(canonicalPath(uriToPath("file:///D%3A/app/x.ts"))).toBe("d:/app/x.ts");
    expect(canonicalPath(uriToPath("file:///d:/app/x.ts"))).toBe("d:/app/x.ts");
    expect(canonicalPath(uriToPath("file:///D:/app/X.ts"))).toBe("d:/app/x.ts");
    expect(canonicalPath(uriToPath("file://nas/share/x.rs"))).toBe("//nas/share/x.rs");
  });

  it("不是 file 就交回空串", () => {
    expect(uriToPath("untitled:Untitled-1")).toBe("");
    expect(uriToPath("http://example.com/a.ts")).toBe("");
    expect(uriToPath("")).toBe("");
  });

  it("不合法的百分号序列不抛，原样留着", () => {
    expect(uriToPath("file:///d%3A/a%zz-b.ts")).toBe("d:/a%zz-b.ts");
  });
});
