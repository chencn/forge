import { useEffect, useMemo, useRef, useState } from "react";
import { parseToolDiff } from "../lib/aiTools";

/**
 * 工具明细里的 diff：**Git 管理面板同款的 Monaco DiffEditor**（参数照抄 DiffPane/
 * LocalHistoryDialog），不再是手搓的 HTML 行。
 *
 * Monaco 体积大且依赖 window：**挂载后才动态加载**——静态渲染（SSR/测试）不跑
 * effect，永远不会碰它。加载完成前渲染占位框，高度不跳。
 *
 * 明细里只有 unified diff 的 hunk（没有整份文件）：把 hunk 按真实行号摆进两份对齐的
 * 文本里重建 original/modified——hunk 之间的空档两侧都是空行，Monaco 对齐后就是
 * 一段安静的同文区，与完整 diff 的观感一致。
 */

let seq = 0;

/**
 * unified diff → 两侧对齐文本。规则：
 * - 行内游标按真实文件位置推进——add 只推 new，delete 只推 old，context 推两侧；
 * - hunk 头给出的 old/new 起点各自权威；hunk 之间与首 hunk 之前的未改动区间**整段跳过**
 *   （游标直接跳到起点，不垫空行）——按行号垫空会让 L1374 的补丁先产出 1373 行空白对；
 * - 结尾补齐短的一侧，保证两份文本行数一致。
 */
export function alignDiffSides(diff: string, startLine?: number): {
  original: string; modified: string;
  /** 模型每行对应的真实文件行号（hunk 间跳过的区间不占号）；Monaco 行号回调据此显示。 */
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
        // 各自游标直接跳到 hunk 起点——Monaco 只比对送进去的文本，跳过的区间不影响对齐。
        oldAt = Number(hunk[1]);
        newAt = Number(hunk[2]);
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
  while (oldLines.length < newLines.length) { oldLines.push(""); oldNos.push(oldAt); oldAt += 1; }
  while (newLines.length < oldLines.length) { newLines.push(""); newNos.push(newAt); newAt += 1; }
  return { original: oldLines.join("\n"), modified: newLines.join("\n"), oldNos, newNos };
}

export default function AiDiffEditor({ diff, original, modified, path, sideBySide, height = 320 }: {
  /** unified diff；与 original/modified 二选一。 */
  diff?: string;
  /** 改动前/后的完整文本（补丁 old/new、新建文件 original="" modified=content）。 */
  original?: string;
  modified?: string;
  /** 文件路径：取语法语言。 */
  path: string;
  sideBySide: boolean;
  /** 不传则按内容行数自适应（88–320px）。 */
  height?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
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
    let cancelled = false;
    let editor: import("../lib/monacoEditor").monaco.editor.IStandaloneDiffEditor | null = null;
    let models: Array<{ dispose(): void }> = [];
    void Promise.all([import("../lib/monacoEditor"), import("../lib/monacoEnv")]).then(([{ monaco }, { languageForPath, monoFont }]) => {
      if (cancelled) return;
      const element = host.current;
      if (!element) return;
      editor = monaco.editor.createDiffEditor(element, {
        readOnly: true,
        renderSideBySide: sideBySide,
        automaticLayout: true,
        fontFamily: monoFont(),
        fontSize: 12,
        // 行高必须显式交出去：编辑器嵌在聊天正文（line-height 1.8）里，无单位
        // line-height 会继承进 Monaco 的行盒，行距被撑成正文档——Git 面板没有这问题
        // 只是因为它不在正文容器里。
        lineHeight: 18,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderOverviewRuler: false,
        scrollbar: { verticalScrollbarSize: 14, horizontalScrollbarSize: 10, useShadows: false },
        overviewRulerLanes: 0,
        diffWordWrap: "off",
        editContext: false,
      });
      const modelSeq = (seq += 1);
      const uri = (side: string) => monaco.Uri.parse(`inmemory://forge/ai-diff-${modelSeq}-${side}`);
      const left = monaco.editor.createModel(sides.original, languageForPath(path), uri("original"));
      const right = monaco.editor.createModel(sides.modified, languageForPath(path), uri("modified"));
      editor.setModel({ original: left, modified: right });
      // 行号显示真实文件行号：模型从 1 起数，但每行的文件行号来自对齐映射
      // （hunk 之间跳过的区间不占号，所以不是简单的 start + n）。
      const { oldNos, newNos } = sides;
      editor.getOriginalEditor().updateOptions({
        lineNumbers: (line: number) => String(oldNos[line - 1] ?? line),
      });
      editor.getModifiedEditor().updateOptions({
        lineNumbers: (line: number) => String(newNos[line - 1] ?? line),
      });
      models = [left, right];
      setReady(true);
    });
    return () => {
      cancelled = true;
      editor?.dispose();
      models.forEach((model) => model.dispose());
    };
  }, [sides, path, sideBySide]);

  return <div className={`ai-diff-editor${ready ? "" : " is-loading"}`} style={{ height: height ?? contentHeight }} ref={host} />;
}
