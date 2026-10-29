import { memo, useEffect, useMemo, useRef } from "react";
import { parseToolDiff } from "../lib/aiTools";
import { applyFontMetrics } from "../lib/cmEditor";
import { createDiffView } from "../lib/cm/diffView";
import { languageForPath } from "../lib/editorEnv";

/**
 * 工具明细里的 diff：**Git 管理面板同款的比对视图**（同一份 `createDiffView`），
 * 不再是手搓的 HTML 行。
 *
 * 明细里只有 unified diff 的 hunk（没有整份文件）：把 hunk 按真实行号摆进两份对齐的
 * 文本里重建 original/modified——hunk 之间的空档两侧都是空行，比对视图对齐后就是
 * 一段安静的同文区，与完整 diff 的观感一致。
 */

/**
 * unified diff → 两侧对齐文本。规则：
 * - 行内游标按真实文件位置推进——add 只推 new，delete 只推 old，context 推两侧；
 * - hunk 头给出的 old/new 起点各自权威；hunk 之间与首 hunk 之前的未改动区间**整段跳过**
 *   （游标直接跳到起点，不垫空行）——按行号垫空会让 L1374 的补丁先产出 1373 行空白对；
 * - 两侧保留真实文本长度；行对齐交给比对视图那套 chunk。
 */
export function alignDiffSides(diff: string, startLine?: number): {
  original: string; modified: string;
  /** 模型每行对应的真实文件行号（hunk 间跳过的区间不占号）；行号槽照这个显示。 */
  oldNos: number[]; newNos: number[];
} {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const oldNos: number[] = [];
  const newNos: number[] = [];
  let oldAt = startLine ?? 1;
  let newAt = startLine ?? 1;
  let inHunk = false;
  for (const line of parseToolDiff(diff)) {
    if (line.kind === "header") {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line.text);
      if (hunk) {
        inHunk = true;
        // 两个 hunk 之间未改动的区间**整段跳过**（不垫空行）：用户要看的只有修改本身。
        // 各自游标直接跳到 hunk 起点——比对视图只比对送进去的文本，跳过的区间不影响对齐。
        oldAt = Number(hunk[1]);
        newAt = Number(hunk[2]);
      } else if (/^(?:@@|diff --git |index |--- |\+\+\+ |\\ No newline)/.test(line.text)) {
        // 补丁的定位标题和元信息不是源码，原生 apply_patch 也遵循这条边界。
        continue;
      } else if (!inHunk) {
        // 没有 hunk 头的裸补丁：空格开头的上下文行两侧同现，丢了它两侧就错位。
        const body = line.text.replace(/^ /, "");
        oldLines.push(body); oldNos.push(oldAt);
        newLines.push(body); newNos.push(newAt);
        oldAt += 1;
        newAt += 1;
      }
      // 有 hunk 之后出现的非 @@ 杂行（如 "\ No newline at end of file"）整行丢弃。
      continue;
    }
    if (line.kind === "add") {
      newLines.push(line.text.replace(/^\+/, "")); newNos.push(newAt);
      newAt += 1;
    } else if (line.kind === "delete") {
      oldLines.push(line.text.replace(/^-/, "")); oldNos.push(oldAt);
      oldAt += 1;
    } else if (inHunk) {
      // hunk 内的上下文行保留：给改动提供定位锚点（紧邻的 2-3 行）。
      const body = line.text.replace(/^ /, "");
      oldLines.push(body); oldNos.push(oldAt);
      newLines.push(body); newNos.push(newAt);
      oldAt += 1;
      newAt += 1;
    }
    // hunk 外的普通行（属于被跳过的区间）不进文本。
  }
  return { original: oldLines.join("\n"), modified: newLines.join("\n"), oldNos, newNos };
}

export default memo(function AiDiffEditor({ diff, original, modified, path, sideBySide, height, revealChange = false }: {
  /** unified diff；与 original/modified 二选一。 */
  diff?: string;
  /** 改动前/后的完整文本（补丁 old/new、新建文件 original="" modified=content）。 */
  original?: string;
  modified?: string;
  /** 文件路径：取语法语言。 */
  path: string;
  sideBySide: boolean;
  /** 不传则按内容行数自适应（88–320px）。 */
  height?: number | "100%";
  /** 独立标签打开后直接滚到首处改动，聊天行内预览保持原来的滚动行为。 */
  revealChange?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const sides = useMemo(() => {
    if (original !== undefined && modified !== undefined) return { original, modified, oldNos: [] as number[], newNos: [] as number[] };
    if (diff !== undefined) return alignDiffSides(diff);
    return { original: "", modified: "", oldNos: [] as number[], newNos: [] as number[] };
  }, [diff, original, modified]);
  // 高度跟内容走：行数 × 行高，夹在 88–320px——短 diff 不再拖一屏空白。
  const contentHeight = useMemo(() => {
    const lines = Math.max(sides.original.split("\n").length, sides.modified.split("\n").length, 4);
    return Math.min(320, Math.max(88, lines * 18 + 12));
  }, [sides]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    // 行高必须显式交出去：这台嵌在聊天正文（line-height 1.8）里，不写就跟着正文的行距被撑开。
    applyFontMetrics(element, 12);
    const { oldNos, newNos } = sides;
    const view = createDiffView({
      parent: element,
      original: sides.original,
      modified: sides.modified,
      language: languageForPath(path),
      path,
      mode: sideBySide ? "side" : "unified",
      // 行号显示真实文件行号：模型从 1 起数，每行的文件行号来自对齐映射
      // （hunk 之间跳过的区间不占号，所以不是简单的 start + n）。没给映射时按模型行号走。
      numbers: oldNos.length || newNos.length
        ? {
            original: (line) => String(oldNos[line - 1] ?? line),
            modified: (line) => String(newNos[line - 1] ?? line),
          }
        : undefined,
    });
    if (revealChange) view.land("first");
    return () => view.destroy();
  }, [sides, path, sideBySide, revealChange]);

  return <div className="ai-diff-editor" style={{ height: height ?? contentHeight }} ref={host} />;
});
