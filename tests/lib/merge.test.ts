import { describe, expect, it, vi } from "vitest";
import { conflictBlocks, flattenMerge, threeWayMerge } from "../../src/lib/merge";

// 合并器是纯函数，不碰 IPC；这一句只为和同目录其它 lib 测试保持同一套 mock 头。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("threeWayMerge 三路合并", () => {
  it("只有一侧改：取改的那侧", () => {
    const r = threeWayMerge("a\nb\nc", "a\nB\nc", "a\nb\nc");
    expect(r.conflicts).toBe(0);
    expect(flattenMerge(r)).toBe("a\nB\nc");

    const t = threeWayMerge("a\nb\nc", "a\nb\nc", "a\nT\nc");
    expect(t.conflicts).toBe(0);
    expect(flattenMerge(t)).toBe("a\nT\nc");
  });

  it("两侧改相邻行：分别应用而不是扩大成整段冲突", () => {
    const r = threeWayMerge("a\nb", "A\nb", "a\nB");
    expect(r.conflicts).toBe(0);
    expect(flattenMerge(r)).toBe("A\nB");
  });

  it("两侧改不同行：自动并起来，两处改动都在", () => {
    // base 三行，本地改第一行，磁盘改第三行。
    const r = threeWayMerge("a\nb\nc", "A\nb\nc", "a\nb\nC");
    expect(r.conflicts).toBe(0);
    expect(flattenMerge(r)).toBe("A\nb\nC");
  });

  it("两侧改成一模一样：不算冲突，取一份", () => {
    const r = threeWayMerge("a\nb", "x\nb", "x\nb");
    expect(r.conflicts).toBe(0);
    expect(flattenMerge(r)).toBe("x\nb");
  });

  it("同一行改得不一样：报冲突，默认取本地", () => {
    const r = threeWayMerge("a\nb", "A\nb", "T\nb");
    expect(r.conflicts).toBe(1);
    expect(flattenMerge(r)).toBe("A\nb");
    expect(flattenMerge(r, ["theirs"])).toBe("T\nb");
    expect(flattenMerge(r, ["both"])).toBe("A\nT\nb");
  });

  it("插入落在另一侧修改区间边界：按顺序独立应用", () => {
    const r = threeWayMerge("a\nb", "a\ninserted\nb", "a\nB");
    expect(r.conflicts).toBe(0);
    expect(flattenMerge(r)).toBe("a\ninserted\nB");
  });

  it("两侧各自插入不同内容到同一处：不静默吞行，报冲突且两侧内容都在块里", () => {
    // base: a b。本地在 a 后插 I-ours，磁盘在 a 后插 I-theirs。
    const r = threeWayMerge("a\nb", "a\nI-ours\nb", "a\nI-theirs\nb");
    const conflicts = conflictBlocks(r);
    expect(conflicts.length).toBe(1);
    // 冲突块两侧各自的段都要含自己那一行，谁也不能被吃掉。
    expect(conflicts[0].ours).toContain("I-ours");
    expect(conflicts[0].theirs).toContain("I-theirs");
    // 取 both 时两行都在。
    expect(flattenMerge(r, ["both"])).toContain("I-ours");
    expect(flattenMerge(r, ["both"])).toContain("I-theirs");
  });

  it("本地删一段、磁盘改别处：磁盘改动保住，本地删除生效", () => {
    // base a b c d。本地删掉 b，磁盘把 d 改成 D。
    const r = threeWayMerge("a\nb\nc\nd", "a\nc\nd", "a\nb\nc\nD");
    expect(r.conflicts).toBe(0);
    expect(flattenMerge(r)).toBe("a\nc\nD");
  });

  it("一侧整篇删空、另一侧改：取改的一侧而不是判冲突", () => {
    // base 有内容，磁盘删光，本地改了一行 → 这是「磁盘删 vs 本地改」的真冲突。
    const r = threeWayMerge("a\nb", "A\nb", "");
    expect(r.conflicts).toBe(1);
    // 本地啥也没动、磁盘删光 → 不冲突，结果就是空。
    const clean = threeWayMerge("a\nb", "a\nb", "");
    expect(clean.conflicts).toBe(0);
    expect(flattenMerge(clean)).toBe("");
  });

  it("末尾换行保留：三份都以换行结尾时结果也结尾换行", () => {
    const r = threeWayMerge("a\nb\n", "a\nB\n", "a\nb\n");
    expect(flattenMerge(r)).toBe("a\nB\n");
  });

  it("空 base：本地或磁盘有内容时取有的一侧，都空则空", () => {
    expect(flattenMerge(threeWayMerge("", "x", ""))).toBe("x");
    expect(flattenMerge(threeWayMerge("", "", "y"))).toBe("y");
    expect(flattenMerge(threeWayMerge("", "", ""))).toBe("");
  });
});

describe("flattenMerge 默认与缺省选择", () => {
  it(" choices 比冲突数少时，缺的那些按取本地", () => {
    // 两处独立冲突：第一处选磁盘，第二处没给 → 取本地。
    const r = threeWayMerge("a\nb\nc\nd", "A\nb\nC\nd", "T1\nb\nT2\nd");
    expect(r.conflicts).toBe(2);
    expect(flattenMerge(r, ["theirs"])).toBe("T1\nb\nC\nd");
  });
});
