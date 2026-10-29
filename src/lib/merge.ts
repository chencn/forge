/**
 * 行级三路合并（diff3）。
 *
 * 只在「保存那一刻磁盘已被别处改过」（`CONFLICT_ON_WRITE`）时走到这里，
 * 所以宁可是纯函数、可单测，也不借编辑器的合并视图：这里要的是把冲突块写进文本，
 * 交回用户自己改完再存。
 *
 * 三份文本：`base` 是上次与磁盘一致的那份（共同祖先），`ours` 是编辑器里手里这份，`theirs` 是磁盘现在那份。
 *
 * 做法是先分别用 LCS（最长公共子序列）生成 `base → ours`、`base → theirs` 的编辑区间，再按区间关系合并：
 * 只有严格重叠的两侧编辑才属于同一个冲突候选；相邻区间分别应用，所以“本地改第一行、磁盘改第二行”
 * 能直接得到两边的结果。同一位置的两次插入视为重叠，插入落在另一修改区间内部也视为重叠；落在区间边界
 * 则可独立应用。一个重叠组件里只有一侧编辑就直接采用，两侧结果相同也直接采用，否则产出冲突块。
 *
 * 这样既不会把相邻独立修改扩成整段冲突，也不会在同一处各插一段时静默吞掉其中一侧。
 */

export type MergeBlock =
  | { kind: "stable"; lines: string[] }
  | { kind: "conflict"; base: string[]; ours: string[]; theirs: string[] };

export interface MergeResult {
  blocks: MergeBlock[];
  /** 冲突块的数量，为 0 时两侧能自动并起来。 */
  conflicts: number;
}

/** 一个冲突块的取法。`both` 是本地在上、磁盘在下都留着，等价「两边都要」。 */
export type ConflictChoice = "ours" | "theirs" | "both";

/** LCS 表规模上限：base×other 超过它就不逐格算，退化成「整段算一处改动」——反正那么大范围多半是真冲突。 */
const LCS_CELL_LIMIT = 4_000_000;

/** 按行切。末尾换行会切出一个空尾行，这里保留它——它是内容的一部分，不能丢。 */
function toLines(text: string): string[] {
  if (text === "") return [];
  return text.split("\n");
}

/**
 * 求 a、b 的 LCS 匹配位置，返回若干段「a[i..i+len) ↔ b[j..j+len)」的连续匹配块（按 a 升序）。
 *
 * 太大时退回「只认公共前后缀」两块匹配：把能对齐的头尾当稳定，中间整段留给改动区——
 * 宁可把一大片判成改动（进而判冲突），也不能因为一次巨型 DP 卡住界面。
 */
function lcsMatches(a: string[], b: string[]): { ai: number; bi: number; len: number }[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  if (n * m > LCS_CELL_LIMIT) return prefixSuffixMatches(a, b);
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度。摊平成 Uint32Array 省内存。
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[at(i, j)] =
        a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  // 沿 dp 走一遍收集匹配对（a、b 同步前进），再把连续匹配对折成块。
  const blocks: { ai: number; bi: number; len: number }[] = [];
  let i = 0;
  let j = 0;
  let runAi = -1;
  let runBi = -1;
  let runLen = 0;
  const flush = () => {
    if (runLen > 0) blocks.push({ ai: runAi, bi: runBi, len: runLen });
    runAi = -1;
    runBi = -1;
    runLen = 0;
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      if (runLen === 0) {
        runAi = i;
        runBi = j;
      }
      runLen += 1;
      i += 1;
      j += 1;
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      flush();
      i += 1;
    } else {
      flush();
      j += 1;
    }
  }
  flush();
  return blocks;
}

/** 只认公共前缀与公共后缀两段匹配，给巨型输入兜底。 */
function prefixSuffixMatches(a: string[], b: string[]) {
  const n = a.length;
  const m = b.length;
  const blocks: { ai: number; bi: number; len: number }[] = [];
  let low = 0;
  while (low < n && low < m && a[low] === b[low]) low += 1;
  if (low > 0) blocks.push({ ai: 0, bi: 0, len: low });
  let tail = 0;
  while (tail < n - low && tail < m - low && a[n - 1 - tail] === b[m - 1 - tail]) tail += 1;
  if (tail > 0) blocks.push({ ai: n - tail, bi: m - tail, len: tail });
  return blocks;
}

interface Edit {
  /** 被替换的 base 半开区间；start === end 表示在该位置插入。 */
  start: number;
  end: number;
  lines: string[];
  side: "ours" | "theirs";
}

/** 把 LCS 匹配块之间的缺口转成 base → side 的编辑区间。 */
function editsFromMatches(
  base: string[],
  sideLines: string[],
  side: Edit["side"]
): Edit[] {
  const matches = lcsMatches(base, sideLines);
  const edits: Edit[] = [];
  let baseCursor = 0;
  let sideCursor = 0;
  for (const match of matches) {
    if (baseCursor !== match.ai || sideCursor !== match.bi) {
      edits.push({
        start: baseCursor,
        end: match.ai,
        lines: sideLines.slice(sideCursor, match.bi),
        side,
      });
    }
    baseCursor = match.ai + match.len;
    sideCursor = match.bi + match.len;
  }
  if (baseCursor !== base.length || sideCursor !== sideLines.length) {
    edits.push({
      start: baseCursor,
      end: base.length,
      lines: sideLines.slice(sideCursor),
      side,
    });
  }
  return edits;
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k += 1) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * 两侧编辑是否触碰同一片 base 内容。
 *
 * 半开区间严格重叠才冲突；同点插入冲突；插入位于另一修改内部冲突，但落在首尾边界可独立应用。
 */
function editsOverlap(a: Edit, b: Edit): boolean {
  const aInsert = a.start === a.end;
  const bInsert = b.start === b.end;
  if (aInsert && bInsert) return a.start === b.start;
  if (aInsert) return a.start > b.start && a.start < b.end;
  if (bInsert) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

/** 在一个 base 区间内应用某一侧的若干编辑，未被该侧触碰的行原样保留。 */
function applyEdits(base: string[], start: number, end: number, edits: Edit[]): string[] {
  const out: string[] = [];
  let cursor = start;
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const edit of ordered) {
    out.push(...base.slice(cursor, edit.start), ...edit.lines);
    cursor = edit.end;
  }
  out.push(...base.slice(cursor, end));
  return out;
}

/**
 * 三份行数组做三路合并。
 *
 * 每个编辑是图上的节点，只有来自不同侧且实际重叠的节点才连边。连通分量就是必须一起判断的修改区；
 * 没有连边的相邻编辑仍是两个分量，会按 base 坐标顺序分别应用。
 */
function mergeLines(base: string[], ours: string[], theirs: string[]): MergeResult {
  const edits = [
    ...editsFromMatches(base, ours, "ours"),
    ...editsFromMatches(base, theirs, "theirs"),
  ];
  if (edits.length === 0) {
    return { blocks: base.length > 0 ? [{ kind: "stable", lines: base }] : [], conflicts: 0 };
  }

  // 并查集把跨侧重叠编辑收成组件。同侧编辑来自同一份合法 diff，彼此不会重叠。
  const parent = edits.map((_, index) => index);
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    let current = value;
    while (parent[current] !== current) {
      const next = parent[current];
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  for (let i = 0; i < edits.length; i += 1) {
    for (let j = i + 1; j < edits.length; j += 1) {
      if (edits[i].side !== edits[j].side && editsOverlap(edits[i], edits[j])) union(i, j);
    }
  }

  const grouped = new Map<number, Edit[]>();
  for (let index = 0; index < edits.length; index += 1) {
    const root = find(index);
    const group = grouped.get(root);
    if (group) group.push(edits[index]);
    else grouped.set(root, [edits[index]]);
  }
  const components = [...grouped.values()]
    .map((items) => ({
      edits: items,
      start: Math.min(...items.map((edit) => edit.start)),
      end: Math.max(...items.map((edit) => edit.end)),
    }))
    // 同一边界处，插入（end === start）要先于从该位置开始的替换。
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const blocks: MergeBlock[] = [];
  let conflicts = 0;
  let cursor = 0;
  const pushStable = (lines: string[]) => {
    if (lines.length === 0) return;
    const previous = blocks[blocks.length - 1];
    if (previous?.kind === "stable") previous.lines.push(...lines);
    else blocks.push({ kind: "stable", lines: [...lines] });
  };

  for (const component of components) {
    pushStable(base.slice(cursor, component.start));
    const oursEdits = component.edits.filter((edit) => edit.side === "ours");
    const theirsEdits = component.edits.filter((edit) => edit.side === "theirs");
    const baseSeg = base.slice(component.start, component.end);
    const oursSeg = applyEdits(base, component.start, component.end, oursEdits);
    const theirsSeg = applyEdits(base, component.start, component.end, theirsEdits);

    if (oursEdits.length === 0) pushStable(theirsSeg);
    else if (theirsEdits.length === 0) pushStable(oursSeg);
    else if (sameLines(oursSeg, theirsSeg)) pushStable(oursSeg);
    else {
      blocks.push({ kind: "conflict", base: baseSeg, ours: oursSeg, theirs: theirsSeg });
      conflicts += 1;
    }
    cursor = component.end;
  }
  pushStable(base.slice(cursor));

  return { blocks, conflicts };
}

/** 入口：按行合并三份文本，返回块序列与冲突数。 */
export function threeWayMerge(base: string, ours: string, theirs: string): MergeResult {
  return mergeLines(toLines(base), toLines(ours), toLines(theirs));
}

/**
 * 把块序列拍成最终文本。
 *
 * `choices` 按冲突出现顺序给每个冲突块选一种取法；漏给的（或没有冲突时）默认取本地。
 * 不插 `<<<<<<<` 那类文本标记——这边是自带选择器的人机合并，结果应当是干净的。
 */
export function flattenMerge(result: MergeResult, choices: ConflictChoice[] = []): string {
  let conflictIndex = 0;
  const out: string[] = [];
  for (const block of result.blocks) {
    if (block.kind === "stable") {
      out.push(...block.lines);
      continue;
    }
    const choice = choices[conflictIndex] ?? "ours";
    conflictIndex += 1;
    if (choice === "ours") out.push(...block.ours);
    else if (choice === "theirs") out.push(...block.theirs);
    else out.push(...block.ours, ...block.theirs);
  }
  return out.join("\n");
}

/** 合并结果里第 index 个冲突块（供界面逐个高亮 / 走查）。 */
export function conflictBlocks(result: MergeResult): Extract<MergeBlock, { kind: "conflict" }>[] {
  return result.blocks.filter((b): b is Extract<MergeBlock, { kind: "conflict" }> => b.kind === "conflict");
}

/**
 * 带冲突标记的渲染，交给「结果」那一格让人手改。
 *
 * 自动能并的区域直接给干净文本；每个冲突块摊成 `<<<<<<< 本地 / ======= / 磁盘 >>>>>>>` 那一段，
 * 人删掉不要的一侧、抹掉标记即可。没有冲突时就是一份干净文本，等于 [`flattenMerge`] 的默认结果。
 */
export function renderWithMarkers(result: MergeResult): string {
  const out: string[] = [];
  for (const block of result.blocks) {
    if (block.kind === "stable") {
      out.push(...block.lines);
      continue;
    }
    out.push("<<<<<<< 本地", ...block.ours, "=======", ...block.theirs, ">>>>>>> 磁盘");
  }
  return out.join("\n");
}

/** 把带标记的文本里的 `<<<<<<<` / `=======` / `>>>>>>>` 行去掉（人改完后清理残留标记）。 */
export function stripConflictMarkers(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^(<<<<<<<|=======|>>>>>>>)/.test(line))
    .join("\n");
}
