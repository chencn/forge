import { describe, expect, it } from "vitest";
import { isFileUri, isVirtualDocumentKey, isVirtualUri, uriScheme, virtualDocumentKey } from "../../src/lib/virtualDocuments";

describe("虚拟文档 URI 边界", () => {
  it("只允许带 scheme 且不是 file 的 URI", () => {
    expect(uriScheme("untitled:Scratch-1")).toBe("untitled");
    expect(isVirtualUri("inmemory:abc")).toBe(true);
    expect(isFileUri("file:///d%3A/work/a.ts")).toBe(true);
    expect(isVirtualUri("file:///d%3A/work/a.ts")).toBe(false);
    expect(isVirtualUri("D:/work/a.ts")).toBe(false);
    expect(isVirtualUri("")).toBe(false);
  });

  it("生成稳定的内部键，不暴露原始 URI 的路径分隔符", () => {
    const uri = "untitled://session/a.ts?view=1";
    const key = virtualDocumentKey(uri);
    expect(key).toBe("virtual:doc/untitled%3A%2F%2Fsession%2Fa.ts%3Fview%3D1");
    expect(key).toBe(virtualDocumentKey(uri));
    expect(isVirtualDocumentKey(key ?? "")).toBe(true);
    expect(virtualDocumentKey("file:///d%3A/work/a.ts")).toBeNull();
  });
});

