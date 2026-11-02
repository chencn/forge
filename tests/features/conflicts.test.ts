import { describe, expect, it } from "vitest";
import { initialResult, parseConflicts, resolutionText } from "../../src/features/vcs/conflicts";

const MERGED = [
  "top",
  "<<<<<<< HEAD",
  "ours-1",
  "ours-2",
  "=======",
  "theirs-1",
  ">>>>>>> feature",
  "bottom",
].join("\n");

const MERGED_DIFF3 = [
  "a",
  "<<<<<<< HEAD",
  "ours",
  "||||||| merged",
  "base",
  "=======",
  "theirs",
  ">>>>>>> x",
  "b",
].join("\n");

describe("parseConflicts 冲突标记解析", () => {
  it("普通两段式：ours/theirs 与两侧标签", () => {
    const blocks = parseConflicts(MERGED);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.ours).toBe("ours-1\nours-2\n");
    expect(b.theirs).toBe("theirs-1\n");
    expect(b.base).toBeNull();
    expect(b.oursLabel).toBe("HEAD");
    expect(b.theirsLabel).toBe("feature");
  });

  it("diff3 三段式带 base，标记行后面的标签空着也认", () => {
    const [b] = parseConflicts(MERGED_DIFF3);
    expect(b!.ours).toBe("ours\n");
    expect(b!.base).toBe("base\n");
    expect(b!.theirs).toBe("theirs\n");
  });

  it("没有标记的文本零块", () => {
    expect(parseConflicts("plain\n======\ntext")).toHaveLength(0);
  });
});

describe("resolutionText", () => {
  it("both 拼接时 ours 没有结尾换行要补一行", () => {
    expect(resolutionText({ ours: "a", base: null, theirs: "b" }, "both")).toBe("a\nb");
    expect(resolutionText({ ours: "a\n", base: null, theirs: "b" }, "both")).toBe("a\nb");
  });

  it("base 取舍在两段式下取不了（没有 base 段）", () => {
    const [b] = parseConflicts(MERGED);
    expect(resolutionText(b!, "base")).toBe("");
  });
});

describe("initialResult 三栏结果栏起步形态", () => {
  it("diff3：冲突块填 base 段，范围与三方文本随块记录", () => {
    const { text, conflicts } = initialResult(MERGED_DIFF3);
    expect(text).toBe("a\nbase\nb");
    expect(conflicts).toEqual([
      { from: 2, to: 7, ours: "ours\n", base: "base\n", theirs: "theirs\n" },
    ]);
  });

  it("两段式没有 base：块填空串，范围为空但不丢块", () => {
    const { text, conflicts } = initialResult(MERGED);
    expect(text).toBe("top\nbottom");
    expect(conflicts).toEqual([
      { from: 4, to: 4, ours: "ours-1\nours-2\n", base: null, theirs: "theirs-1\n" },
    ]);
  });

  it("reversed：ours/theirs 对调（变基里 stage 2 是上游），base 段不变", () => {
    const { text, conflicts } = initialResult(MERGED_DIFF3, true);
    expect(text).toBe("a\nbase\nb");
    expect(conflicts).toEqual([
      { from: 2, to: 7, ours: "theirs\n", base: "base\n", theirs: "ours\n" },
    ]);
  });

  it("无标记文本原样返回、零冲突", () => {
    const r = initialResult("plain\n======\ntext");
    expect(r.text).toBe("plain\n======\ntext");
    expect(r.conflicts).toEqual([]);
  });
});
