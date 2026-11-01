/**
 * 提交图 lane 状态机：按拓扑序（子在前）给每行算出上下两半的连线段。
 * 移植自 openidea `features/vcs/graph.ts` 的 computeGraph（纯前端函数，
 * 从 parents 客户端算出，分页可延续——state 传出下一页接着用）。
 */

export interface GraphSegment {
  /** 段起点 lane（up 是顶边，down 是节点高度）。 */
  from: number;
  /** 段终点 lane（up 是节点高度，down 是底边）。 */
  to: number;
  color: number;
}

export interface GraphRow {
  /** 提交节点所在的 lane。 */
  lane: number;
  color: number;
  /** 上半段：从上一行进来的线。 */
  up: GraphSegment[];
  /** 下半段：往下一行去的线。 */
  down: GraphSegment[];
  /** 本行横跨的 lane 槽位数（定 SVG 宽度用）。 */
  width: number;
}

interface Lane {
  id: string;
  color: number;
}

export interface GraphState {
  lanes: Array<Lane | null>;
  nextColor: number;
}

export interface GraphCommit {
  id: string;
  parents: readonly string[];
}

export const emptyGraphState = (): GraphState => ({ lanes: [], nextColor: 0 });

const firstFree = (lanes: Array<Lane | null>) => {
  const i = lanes.indexOf(null);
  return i < 0 ? lanes.length : i;
};

const seg = (from: number, to: number, color: number): GraphSegment => ({ from, to, color });

/**
 * 给 `commits`（可从 `state` 续排，分页追加用）铺出各行。每个 lane 存活期间
 * 位置不动，空出的槽位回收复用。
 */
export function computeGraph(
  commits: ReadonlyArray<GraphCommit>,
  state: GraphState = emptyGraphState(),
): { rows: GraphRow[]; state: GraphState } {
  const lanes = [...state.lanes];
  let nextColor = state.nextColor;
  const rows: GraphRow[] = [];

  for (const c of commits) {
    const matching: number[] = [];
    lanes.forEach((l, i) => {
      if (l?.id === c.id) matching.push(i);
    });
    let lane: number;
    let color: number;
    if (matching.length) {
      lane = matching[0]!;
      color = lanes[lane]!.color;
    } else {
      lane = firstFree(lanes);
      color = nextColor++;
    }
    const widthBefore = lanes.length;

    const up: GraphSegment[] = [];
    lanes.forEach((l, i) => {
      if (!l) return;
      up.push(seg(i, l.id === c.id ? lane : i, l.color));
    });
    for (const m of matching) lanes[m] = null;
    if (lane >= lanes.length) lanes.length = lane + 1;
    lanes[lane] = null;

    const down: GraphSegment[] = [];
    lanes.forEach((l, i) => {
      if (l) down.push(seg(i, i, l.color));
    });

    c.parents.forEach((p, k) => {
      // 第一父提交沿用本 lane，即使别的 lane 也通向它（在父节点处汇合成一条，同 git log --graph）。
      if (k === 0) {
        lanes[lane] = { id: p, color };
        down.push(seg(lane, lane, color));
        return;
      }
      const existing = lanes.findIndex((l) => l?.id === p);
      if (existing >= 0) {
        down.push(seg(lane, existing, lanes[existing]!.color));
        return;
      }
      const slot = firstFree(lanes);
      const col = nextColor++;
      lanes[slot] = { id: p, color: col };
      down.push(seg(lane, slot, col));
    });

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const widthAfter = Math.max(0, ...down.map((s) => s.to + 1));
    rows.push({ lane, color, up, down, width: Math.max(widthBefore, widthAfter, lane + 1) });
  }
  return { rows, state: { lanes, nextColor } };
}

/** lane 颜色（token 轮换）。 */
export const LANE_COLORS = [
  "var(--accent)",
  "var(--vcs-added)",
  "var(--vcs-modified)",
  "var(--syn-annotation)",
  "var(--syn-number)",
  "var(--syn-string)",
  "var(--syn-type)",
  "var(--danger)",
];

export const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length]!;
