import { describe, expect, it } from "vitest";
import { collapseLinear, computeGraph, hideLongEdges } from "../../src/features/vcs/graph";

describe("computeGraph 提交图 lane 状态机", () => {
  it("直线历史全走 lane 0，颜色不变", () => {
    const { rows } = computeGraph([
      { id: "a", parents: ["b"] },
      { id: "b", parents: ["c"] },
      { id: "c", parents: [] },
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows.every((r) => r.up.length === 0 || r.up.every((s) => s.from === 0 && s.to === 0))).toBe(true);
  });

  it("分叉时第二父提交占新 lane，合流时在父节点收拢", () => {
    //        a
    //       / \
    //      b   c   （b 是第一父，c 是第二父）
    const { rows } = computeGraph([
      { id: "a", parents: ["b", "c"] },
      { id: "b", parents: ["d"] },
      { id: "c", parents: ["d"] },
      { id: "d", parents: [] },
    ]);
    // a 在 lane 0；b 沿 lane 0；c 从 a 的 down 段落到 lane 1；d 在 lane 0 收拢两条。
    expect(rows[0]!.lane).toBe(0);
    expect(rows[0]!.down.some((s) => s.to === 1)).toBe(true);
    expect(rows[1]!.lane).toBe(0);
    expect(rows[2]!.lane).toBe(1);
    // d 同时是 b 和 c 的父：lane 0 与 lane 1 两条都通向它。
    expect(rows[3]!.up.length).toBe(2);
  });

  it("lane 槽位回收复用：合并后 freed 槽给下一个新 lane", () => {
    // 两条独立支线先后结束，后续新 lane 应落在最早空出的槽位。
    const { rows } = computeGraph([
      { id: "m1", parents: ["m2", "s1"] },
      { id: "s1", parents: ["m2"] },
      { id: "m2", parents: [] },
    ]);
    // s1 占 lane 1，m2 处两条收拢，之后无活动 lane。
    expect(rows[1]!.lane).toBe(1);
    expect(rows[2]!.up.length).toBe(2);
    expect(rows[2]!.lane).toBe(0);
  });

  it("state 可延续：第二页接着第一页排，lane 延续", () => {
    const first = computeGraph([
      { id: "a", parents: ["b"] },
      { id: "b", parents: ["c"] },
    ]);
    const second = computeGraph([{ id: "c", parents: ["d"] }, { id: "d", parents: [] }], first.state);
    // b 的 lane 0 通向 c；第二页里 c 应该落在 lane 0，颜色延续。
    expect(second.rows[0]!.lane).toBe(0);
    expect(second.rows[0]!.color).toBe(first.rows[0]!.color);
  });

  it("collapseLinear 折叠线性链，只留分叉/引用/端点，边标 dashed", () => {
    // a -> mid1 -> mid2 -> b（线性链），另有 c 从 b 分叉；mid1/mid2 单父单子无引用，应被藏。
    const all = [
      { id: "a", parents: ["mid1"], refs: [] },
      { id: "mid1", parents: ["mid2"], refs: [] },
      { id: "mid2", parents: ["b"], refs: [] },
      { id: "b", parents: [], refs: ["main"] },
    ];
    const { commits, graph } = collapseLinear(all, new Set<string>());
    expect(commits.map((c) => c.id)).toEqual(["a", "b"]);
    // a 的父链一路折叠到 b，且这条边是虚线。
    expect(graph[0]!.parents).toEqual(["b"]);
    expect(graph[0]!.dashed).toEqual([true]);
  });

  it("hideLongEdges 藏掉旁路 lane 笔直长边的中段，两端留箭头", () => {
    // 主链 40 个提交走 lane 0；c10 另有第二父 c39，lane 1 从行 10 直穿到行 39。
    const commits = Array.from({ length: 40 }, (_, i) => ({
      id: `c${i}`,
      parents: i === 10 ? ["c11", "c39"] : i < 39 ? [`c${i + 1}`] : [],
    }));
    const rows = computeGraph(commits).rows;
    const trimmed = hideLongEdges(rows, 5);
    // 主链 lane 0 每行都有节点，不算长边，不受影响。
    expect(trimmed[20]!.up.some((s) => s.from === 0 && s.to === 0)).toBe(true);
    // lane 1 的中段（stub 之外）被藏掉；紧贴 stub 的两行带箭头。
    expect(trimmed[20]!.up.some((s) => s.from === 1)).toBe(false);
    expect(trimmed[20]!.down.some((s) => s.from === 1)).toBe(false);
    expect(trimmed[12]!.down.some((s) => s.arrow === "down")).toBe(true);
    expect(trimmed[37]!.up.some((s) => s.arrow === "up")).toBe(true);
  });
});
