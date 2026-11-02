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
  /** 代表被折叠的提交（Collapse Linear Branches）。 */
  dashed?: true;
  /** 长边在这个方向上延出视野（Show Long Edges 关）。 */
  arrow?: "up" | "down";
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
  dashed?: true;
}

export interface GraphState {
  lanes: Array<Lane | null>;
  nextColor: number;
}

export interface GraphCommit {
  id: string;
  parents: readonly string[];
  /** 每父一条：这条连线跳过了被折叠的提交。 */
  dashed?: readonly boolean[];
}

export const emptyGraphState = (): GraphState => ({ lanes: [], nextColor: 0 });

const firstFree = (lanes: Array<Lane | null>) => {
  const i = lanes.indexOf(null);
  return i < 0 ? lanes.length : i;
};

const seg = (from: number, to: number, color: number, dashed?: boolean): GraphSegment =>
  dashed ? { from, to, color, dashed: true } : { from, to, color };

const laneOf = (id: string, color: number, dashed: boolean): Lane =>
  dashed ? { id, color, dashed: true } : { id, color };

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
      up.push(seg(i, l.id === c.id ? lane : i, l.color, l.dashed));
    });
    for (const m of matching) lanes[m] = null;
    if (lane >= lanes.length) lanes.length = lane + 1;
    lanes[lane] = null;

    const down: GraphSegment[] = [];
    lanes.forEach((l, i) => {
      if (l) down.push(seg(i, i, l.color, l.dashed));
    });

    c.parents.forEach((p, k) => {
      const dashed = !!c.dashed?.[k];
      // 第一父提交沿用本 lane，即使别的 lane 也通向它（在父节点处汇合成一条，同 git log --graph）。
      if (k === 0) {
        lanes[lane] = laneOf(p, color, dashed);
        down.push(seg(lane, lane, color, dashed));
        return;
      }
      const existing = lanes.findIndex((l) => l?.id === p);
      if (existing >= 0) {
        down.push(seg(lane, existing, lanes[existing]!.color, dashed));
        return;
      }
      const slot = firstFree(lanes);
      const col = nextColor++;
      lanes[slot] = laneOf(p, col, dashed);
      down.push(seg(lane, slot, col, dashed));
    });

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const widthAfter = Math.max(0, ...down.map((s) => s.to + 1));
    rows.push({ lane, color, up, down, width: Math.max(widthBefore, widthAfter, lane + 1) });
  }
  return { rows, state: { lanes, nextColor } };
}

/**
 * Collapse Linear Branches：把线性链（单父单子、无引用）的提交藏起来，只留
 * 分叉点、合并点、端点和带引用的提交，中间用虚线边连着。`keep` 里的（HEAD）不藏。
 * 对齐 openidea graph.ts 同名函数。
 */
export function collapseLinear<C extends { id: string; parents: readonly string[]; refs?: readonly string[] }>(
  commits: readonly C[],
  keep: ReadonlySet<string>,
): { commits: C[]; graph: GraphCommit[] } {
  const byId = new Map(commits.map((c) => [c.id, c]));
  const children = new Map<string, number>();
  for (const c of commits) for (const p of c.parents) children.set(p, (children.get(p) ?? 0) + 1);
  const hidden = (c: C | undefined): boolean =>
    !!c && c.parents.length === 1 && children.get(c.id) === 1 && !c.refs?.length && !keep.has(c.id);

  const visible: C[] = [];
  const graph: GraphCommit[] = [];
  for (const c of commits) {
    if (hidden(c)) continue;
    const dashed: boolean[] = [];
    const parents: string[] = [];
    for (const p of c.parents) {
      let cur = p;
      let skipped = false;
      for (let next = byId.get(cur), guard = 0; next && guard < commits.length && hidden(next); guard++) {
        cur = next.parents[0]!;
        next = byId.get(cur);
        skipped = true;
      }
      // 两条被折叠的链可能通向同一个提交：只画一条边。
      const seen = parents.indexOf(cur);
      if (seen >= 0) dashed[seen] = dashed[seen]! || skipped;
      else {
        parents.push(cur);
        dashed.push(skipped);
      }
    }
    visible.push(c);
    graph.push(dashed.some(Boolean) ? { id: c.id, parents, dashed } : { id: c.id, parents });
  }
  return { commits: visible, graph };
}

/** 从 `head` 可达的提交 id（log 序：子在前父在后）。 */
export function reachableFrom(
  commits: ReadonlyArray<{ id: string; parents: readonly string[] }>,
  head: string | null,
): Set<string> {
  const out = new Set<string>();
  if (!head) return out;
  out.add(head);
  for (const c of commits) if (out.has(c.id)) for (const p of c.parents) out.add(p);
  return out;
}

/** 一条边笔直穿过这么多行以上就是「长边」。 */
export const LONG_EDGE = 30;
/** 藏掉的长边仍紧贴两端各画几行，末端带箭头（IDEA 的 long-edge arrows）。 */
const LONG_EDGE_STUB = 2;

const onLane = (i: number) => (s: GraphSegment) => s.from === i && s.to === i;

const passes = (row: GraphRow, i: number) =>
  row.lane !== i && row.up.some(onLane(i)) && row.down.some(onLane(i));

/** Show Long Edges 关：笔直穿过 `minLength` 行以上的 lane 中段不画，可见的两端以箭头收尾。 */
export function hideLongEdges(rows: readonly GraphRow[], minLength = LONG_EDGE): GraphRow[] {
  const out = rows.slice();
  const width = Math.max(0, ...rows.map((r) => r.width));
  const edit = (r: number, fn: (row: GraphRow) => GraphRow) => {
    out[r] = fn(out[r]!);
  };
  for (let i = 0; i < width; i++) {
    const lane = onLane(i);
    let start = -1;
    for (let r = 0; r <= rows.length; r++) {
      if (r < rows.length && passes(rows[r]!, i)) {
        if (start < 0) start = r;
        continue;
      }
      if (start >= 0 && r - start >= minLength) {
        const from = start + LONG_EDGE_STUB;
        const to = r - 1 - LONG_EDGE_STUB;
        for (let k = from; k <= to; k++) {
          edit(k, (row) => ({
            ...row,
            up: row.up.filter((s) => !lane(s)),
            down: row.down.filter((s) => !lane(s)),
          }));
        }
        edit(from - 1, (row) => ({
          ...row,
          down: row.down.map((s) => (lane(s) ? { ...s, arrow: "down" } : s)),
        }));
        edit(to + 1, (row) => ({
          ...row,
          up: row.up.map((s) => (lane(s) ? { ...s, arrow: "up" } : s)),
        }));
      }
      start = -1;
    }
  }
  return out;
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
