/**
 * 快速搜索与本地过滤的轻量匹配算法
 *
 * 优先匹配连续子串，其次驼峰/词首匹配，最后为宽松子序列匹配。
 * 返回命中的 UTF-16 索引数组或 null。
 */
export function fuzzyMatch(text: string, query: string): number[] | null {
  if (!query) return [];
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) return Array.from({ length: q.length }, (_, i) => at + i);
  return humpMatch(text, q) ?? subsequence(t, q);
}

/** 词首或驼峰匹配（无宽松子序列回退） */
export function wordMatch(text: string, query: string): number[] | null {
  if (!query) return [];
  const q = query.toLowerCase();
  const at = text.toLowerCase().indexOf(q);
  if (at >= 0) return Array.from({ length: q.length }, (_, i) => at + i);
  return humpMatch(text, q);
}

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1]!;
  const c = text[i]!;
  if (/[\s_\-./\\:]/.test(prev)) return true;
  return c !== c.toLowerCase() && prev === prev.toLowerCase();
}

function humpMatch(text: string, q: string): number[] | null {
  const out: number[] = [];
  const t = text.toLowerCase();
  let qi = 0;
  let i = 0;
  while (qi < q.length && i < t.length) {
    if (
      t[i] === q[qi] &&
      (qi === 0 ? isWordStart(text, i) || i === 0 : out[out.length - 1] === i - 1 || isWordStart(text, i))
    ) {
      out.push(i);
      qi++;
    }
    i++;
  }
  return qi === q.length ? out : null;
}

function subsequence(t: string, q: string): number[] | null {
  const out: number[] = [];
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      out.push(i);
      qi++;
    }
  }
  return qi === q.length ? out : null;
}

/** 将排好序的离散索引聚合为 [start, end) 区间数组 */
export function indexRuns(indices: readonly number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const i of indices) {
    const last = runs[runs.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else runs.push([i, i + 1]);
  }
  return runs;
}
