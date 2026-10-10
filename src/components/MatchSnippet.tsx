import type { ReactNode } from "react";
import type { TextHit } from "../lib/fs";

interface MatchSnippetProps {
  /** 后端回的一行正文命中。 */
  hit: TextHit;
}

/**
 * 把一行正文里的命中段涂亮。
 *
 * 后端给的列号是整行的，而 `snippet` 可能被裁过（一行压缩过的 js 有几 MB），
 * 所以要按 `snippetFrom` 把列号折算回片段内，落在片段外的整段丢掉。
 */
export default function MatchSnippet({ hit }: MatchSnippetProps) {
  const chars = [...hit.snippet];
  const start = hit.snippetFrom - 1;
  const marks: [number, number][] = [];
  for (const range of hit.ranges) {
    const from = range.column - 1 - start;
    const to = from + range.length;
    if (to <= 0 || from >= chars.length) continue;
    marks.push([Math.max(0, from), Math.min(chars.length, to)]);
  }
  if (marks.length === 0) return <>{hit.snippet}</>;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  marks.forEach(([from, to], index) => {
    if (from > cursor) nodes.push(<span key={`plain-${index}`}>{chars.slice(cursor, from).join("")}</span>);
    // 零宽命中（正则的空匹配）也要看得见，垫一个不换行的空格。
    nodes.push(<mark key={`mark-${index}`}>{chars.slice(from, to).join("") || "\u00A0"}</mark>);
    cursor = to;
  });
  if (cursor < chars.length) nodes.push(<span key="tail">{chars.slice(cursor).join("")}</span>);
  return <>{nodes}</>;
}
