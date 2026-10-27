import { describe, expect, it } from "vitest";
import { reconstructFileChange, toolFilePreviews, type AiFilePreview } from "../../src/lib/aiFilePreview";

// 这里验证的是完整文件与当次工具补丁之间的边界；现有工具解析测试不覆盖全文还原。
const change = (diff: string, proposed = false): AiFilePreview => ({
  id: "e1:0", path: "a.ts", kind: "change", patches: [{ path: "a.ts", kind: "edit", diff, proposed }],
});

describe("AI 文件预览", () => {
  it("读取预览携带真实路径和整段读取范围", () => {
    expect(toolFilePreviews({ id: "r", runId: "run", kind: "tool", text: "", name: "Read", input: { file_path: "a.ts" },
      result: { type: "text", file: { startLine: 3, numLines: 2, content: "a\nb" } },
    })).toEqual([{ id: "r:0", path: "a.ts", kind: "read", start: 3, end: 4, source: "a\nb" }]);
  });

  it("从执行后的全文还原修改前全文，保留补丁外的所有行", () => {
    const preview = change("@@ -2,1 +2,2 @@\n-old\n+new\n+extra");
    expect(reconstructFileChange(preview, "head\nnew\nextra\ntail\n")).toEqual({ original: "head\nold\ntail\n", modified: "head\nnew\nextra\ntail\n" });
  });

  it("多个 hunk 按各自真实行号还原，包括行数偏移", () => {
    const preview = change("@@ -2,1 +2,2 @@\n-a\n+b\n+c\n@@ -4,1 +5,1 @@\n-d\n+e");
    expect(reconstructFileChange(preview, "top\nb\nc\nmiddle\ne\nend")).toEqual({ original: "top\na\nmiddle\nd\nend", modified: "top\nb\nc\nmiddle\ne\nend" });
  });

  it("待执行补丁从当前全文产生预期全文", () => {
    expect(reconstructFileChange(change("@@ -2 +2 @@\n-old\n+new", true), "head\nold\ntail")).toEqual({ original: "head\nold\ntail", modified: "head\nnew\ntail" });
  });

  it("纯删除在正确位置还原，不能把删除位置当成下一行", () => {
    expect(reconstructFileChange(change("@@ -2 +1,0 @@\n-removed"), "head\ntail")).toEqual({ original: "head\nremoved\ntail", modified: "head\ntail" });
  });

  it("后续文件漂移或不完整 hunk 不伪造全文差异", () => {
    expect(reconstructFileChange(change("@@ -2 +2 @@\n-old\n+new"), "head\nlater\ntail")).toBeNull();
    expect(reconstructFileChange(change("@@ -2,2 +2,2 @@\n-old\n+new"), "head\nnew\ntail")).toBeNull();
  });

  it("原生 apply_patch 没有行号时，用唯一的完整上下文还原全文", () => {
    expect(reconstructFileChange(change("@@\n head\n-old\n+new\n tail\n"), "prefix\nhead\nnew\ntail\nsuffix\n"))
      .toEqual({ original: "prefix\nhead\nold\ntail\nsuffix\n", modified: "prefix\nhead\nnew\ntail\nsuffix\n" });
    expect(reconstructFileChange(change("@@\n-old\n+new\n"), "new\nnew\n")).toBeNull();
  });

  it("新增文件的补丁本身就包含全文，不依赖文件现在是否存在", () => {
    const preview = change("+first\n+second\n");
    preview.patches![0].kind = "add";
    expect(reconstructFileChange(preview, "")).toEqual({ original: "", modified: "first\nsecond\n" });
  });

  it("EOF 换行信息缺乏可靠基线时保留原始补丁", () => {
    expect(reconstructFileChange(change("@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n"), "new\n")).toBeNull();
  });
});
