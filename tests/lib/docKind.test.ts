import { describe, expect, it } from "vitest";
import { canDiff, docKindOf, hasTextContent, previewsFromDisk } from "../../src/lib/docKind";
import { canPreview, type DocView } from "../../src/hooks/useDocuments";

describe("docKindOf 按扩展名分五类", () => {
  it("常见代码与无扩展名落 text", () => {
    expect(docKindOf("src/App.tsx")).toBe("text");
    expect(docKindOf("C:\\repo\\main.rs")).toBe("text");
    expect(docKindOf("Makefile")).toBe("text");
  });

  it("markdown 家族与 svg 单列", () => {
    expect(docKindOf("README.md")).toBe("markdown");
    expect(docKindOf("notes.mdown")).toBe("markdown");
    expect(docKindOf("logo.svg")).toBe("svg");
  });

  it("位图与已知二进制", () => {
    expect(docKindOf("assets/icon.PNG")).toBe("image");
    expect(docKindOf("lib/core.dll")).toBe("binary");
    expect(docKindOf("dist/app.jar")).toBe("binary");
  });
});

describe("视图能力判定", () => {
  it("hasTextContent：svg 本体是文本所以算，位图与二进制不算", () => {
    expect(hasTextContent("text")).toBe(true);
    expect(hasTextContent("markdown")).toBe(true);
    expect(hasTextContent("svg")).toBe(true);
    expect(hasTextContent("image")).toBe(false);
    expect(hasTextContent("binary")).toBe(false);
  });

  it("previewsFromDisk：svg 与位图走 asset 协议，markdown 预览渲染手里正文", () => {
    expect(previewsFromDisk("svg")).toBe(true);
    expect(previewsFromDisk("image")).toBe(true);
    expect(previewsFromDisk("markdown")).toBe(false);
    expect(previewsFromDisk("text")).toBe(false);
  });

  it("canDiff：只有位图与已知二进制不能逐行比对", () => {
    expect(canDiff("svg")).toBe(true);
    expect(canDiff("text")).toBe(true);
    expect(canDiff("image")).toBe(false);
    expect(canDiff("binary")).toBe(false);
  });

  it("canPreview 与 DocView 视图类型判定", () => {
    const mdDoc = {
      path: "/repo/README.md",
      root: "/repo",
      name: "README.md",
      kind: "markdown" as const,
      view: "split" as DocView,
      contents: "# Hello",
      baseline: "# Hello",
      lineEnding: "lf" as const,
      hasBom: false,
      encoding: "utf-8" as const,
      language: "markdown",
      readOnly: false,
      loading: false,
      error: null,
      diskMs: 0,
      stamp: 0,
      onDisk: true,
    };
    expect(canPreview(mdDoc)).toBe(true);
    const views: DocView[] = ["source", "split", "preview"];
    expect(views).toContain(mdDoc.view);
  });
});
