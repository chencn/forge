/**
 * 轻量匹配器：弹窗里所有「本地重排」都吃它（抄 openidea 的 ui/match.ts）。
 *
 * 优先连续子串，其次词首/驼峰首字母，最后退化为逐字顺次出现。
 * 返回命中的下标表（UTF-16），配 `indexRuns` 涂亮用。
 */

/** 在 `text` 里找 `query`；找不到返回 null。 */
export function fuzzyMatch(text: string, query: string): number[] | null {
  if (!query) return [];
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) return Array.from({ length: q.length }, (_, i) => at + i);
  return humpMatch(text, q) ?? subsequence(t, q);
}

/** 只认子串与词首/驼峰首字母，不留松散的逐字命中。 */
export function wordMatch(text: string, query: string): number[] | null {
  if (!query) return [];
  const q = query.toLowerCase();
  const at = text.toLowerCase().indexOf(q);
  if (at >= 0) return Array.from({ length: q.length }, (_, i) => at + i);
  return humpMatch(text, q);
}

/** 这一段是不是词开头：分隔符之后、或大小写驼峰的「山尖」。 */
function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1]!;
  const c = text[i]!;
  if (/[\s_\-./\\:]/.test(prev)) return true;
  return c !== c.toLowerCase() && prev === prev.toLowerCase();
}

/** 驼峰匹配：首个字符必须落在词首，之后要么连着、要么落在词首。 */
function humpMatch(text: string, q: string): number[] | null {
  const out: number[] = [];
  const t = text.toLowerCase();
  let qi = 0;
  let i = 0;
  while (qi < q.length && i < t.length) {
    if (
      t[i] === q[qi] &&
      (qi === 0 ? isWordStart(text, i) : out[out.length - 1] === i - 1 || isWordStart(text, i))
    ) {
      out.push(i);
      qi++;
    }
    i++;
  }
  return qi === q.length ? out : null;
}

/** 最松的一档：逐字顺次出现即可。 */
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

/** 把升序下标表并成 [开始, 结束) 区段，涂亮用。 */
export function indexRuns(indices: readonly number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const i of indices) {
    const last = runs[runs.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else runs.push([i, i + 1]);
  }
  return runs;
}
