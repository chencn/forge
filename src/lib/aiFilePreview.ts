import { describeAiTool, type AiEditedFile, type ToolPatch } from "./aiTools";
import type { AiEntry } from "./aiRuntime";

/** AI 文件预览保留工具原始数据，不能用当前 Git 总差异替代当次操作。 */
export interface AiFilePreview {
  id: string;
  path: string;
  kind: "read" | "change";
  start?: number;
  end?: number;
  source?: string;
  patches?: ToolPatch[];
}

export function toolFilePreviews(entry: AiEntry, details = true): AiFilePreview[] {
  const view = describeAiTool(entry, details);
  if (view.patches.length) return view.patches.filter((patch) => patch.path).map((patch, index) => ({
    id: `${entry.id}:${index}`, path: patch.destination ?? patch.path, kind: "change",
    start: patch.start, patches: [patch],
  }));
  return view.actions.filter((action) => action.kind === "read" && action.target).map((action, index) => ({
    id: `${entry.id}:${index}`, path: action.target, kind: "read", start: action.start,
    end: action.end, source: view.source?.content,
  }));
}

export function editedFilePreview(file: AiEditedFile, id: string): AiFilePreview {
  return { id: `${id}:${file.path}`, path: file.path, kind: "change", patches: [
    ...(file.diff ? [{ path: file.path, kind: file.kind ?? "edit", diff: file.diff, proposed: false } as ToolPatch] : []),
    ...(file.content !== undefined ? [{ path: file.path, kind: "add", after: file.content, proposed: false } as ToolPatch] : []),
    ...(file.fragments ?? []).map((fragment): ToolPatch => ({ ...fragment, path: file.path, kind: file.kind ?? "edit", proposed: false })),
  ] };
}

interface Hunk { oldStart: number; newStart: number; oldLines: string[]; newLines: string[] }

/** 只接受完整且计数一致的标准 hunk，缺数字行号的补丁另走唯一上下文匹配。 */
function hunksOf(diff: string): Hunk[] | null {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let oldCount = 0, newCount = 0;
  for (const line of diff.split(/\r?\n/)) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      if (current && (current.oldLines.length !== oldCount || current.newLines.length !== newCount)) return null;
      current = { oldStart: Number(header[1]), newStart: Number(header[3]), oldLines: [], newLines: [] };
      oldCount = Number(header[2] ?? 1); newCount = Number(header[4] ?? 1);
      hunks.push(current);
    } else if (current && (current.oldLines.length < oldCount || current.newLines.length < newCount)) {
      if (line.startsWith(" ")) { current.oldLines.push(line.slice(1)); current.newLines.push(line.slice(1)); }
      else if (line.startsWith("-")) current.oldLines.push(line.slice(1));
      else if (line.startsWith("+")) current.newLines.push(line.slice(1));
      else if (!line.startsWith("\\")) return null;
    }
  }
  if (!current || current.oldLines.length !== oldCount || current.newLines.length !== newCount) return null;
  return hunks;
}

function applyHunks(text: string, hunks: Hunk[], reverse: boolean): string | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let previousStart = Infinity;
  for (const hunk of [...hunks].reverse()) {
    const expected = reverse ? hunk.newLines : hunk.oldLines;
    const replacement = reverse ? hunk.oldLines : hunk.newLines;
    const line = reverse ? hunk.newStart : hunk.oldStart;
    const at = expected.length ? Math.max(0, line - 1) : line;
    if (at + expected.length > previousStart || at > lines.length || expected.some((value, index) => lines[at + index] !== value)) return null;
    previousStart = at;
    lines.splice(at, expected.length, ...replacement);
  }
  return lines.join("\n");
}

/** 原生 apply_patch 没有数字行号，只有唯一上下文匹配才允许嵌回完整文件。 */
function rawPatchSides(diff: string): Array<{ oldLines: string[]; newLines: string[] }> | null {
  if (/^@@ -\d/m.test(diff)) return null;
  const chunks: Array<{ oldLines: string[]; newLines: string[] }> = [];
  let chunk = { oldLines: [] as string[], newLines: [] as string[] };
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      if (chunk.oldLines.length || chunk.newLines.length) chunks.push(chunk);
      chunk = { oldLines: [], newLines: [] };
    } else if (line.startsWith(" ")) { chunk.oldLines.push(line.slice(1)); chunk.newLines.push(line.slice(1)); }
    else if (line.startsWith("-")) chunk.oldLines.push(line.slice(1));
    else if (line.startsWith("+")) chunk.newLines.push(line.slice(1));
    else if (line && !line.startsWith("\\")) return null;
  }
  if (chunk.oldLines.length || chunk.newLines.length) chunks.push(chunk);
  return chunks.length ? chunks : null;
}

function applyRawPatch(text: string, chunks: NonNullable<ReturnType<typeof rawPatchSides>>, reverse: boolean): string | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let previousStart = Infinity;
  for (const chunk of [...chunks].reverse()) {
    const expected = reverse ? chunk.newLines : chunk.oldLines;
    const replacement = reverse ? chunk.oldLines : chunk.newLines;
    if (!expected.length) return null;
    const positions: number[] = [];
    for (let at = 0; at <= lines.length - expected.length; at++) {
      if (expected.every((line, index) => lines[at + index] === line)) positions.push(at);
    }
    if (positions.length !== 1 || positions[0] + expected.length > previousStart) return null;
    previousStart = positions[0];
    lines.splice(positions[0], expected.length, ...replacement);
  }
  return lines.join("\n");
}

/** 只有当前全文与补丁精确匹配时才还原另一侧；历史内容漂移必须回退显示原补丁。 */
export function reconstructFileChange(preview: AiFilePreview, current: string): { original: string; modified: string } | null {
  const patches = preview.patches ?? [];
  if (patches.length !== 1) return null;
  const patch = patches[0];
  if (patch.kind === "add" && patch.after !== undefined) return { original: "", modified: patch.after };
  if (patch.diff) {
    // EOF 换行变化不能从行数组可靠还原，保留原始补丁，避免伪造另一侧的文件末尾。
    if (patch.kind !== "add" && patch.diff.includes("\\ No newline at end of file")) return null;
    const hunks = hunksOf(patch.diff);
    const raw = hunks ? null : rawPatchSides(patch.diff);
    if (patch.kind === "add") {
      const all = hunks ?? raw;
      if (all?.length === 1 && all[0].oldLines.length === 0) {
        return { original: "", modified: all[0].newLines.join("\n") + (patch.diff.includes("\\ No newline at end of file") ? "" : "\n") };
      }
    }
    const other = hunks ? applyHunks(current, hunks, !patch.proposed) : raw ? applyRawPatch(current, raw, !patch.proposed) : null;
    if (other === null) return null;
    return patch.proposed ? { original: current, modified: other } : { original: other, modified: current };
  }
  const expected = patch.proposed ? patch.before : patch.after;
  const replacement = patch.proposed ? patch.after : patch.before;
  if (!expected || replacement === undefined) return null;
  const at = current.indexOf(expected);
  // 没有官方行号的替换片段只接受唯一命中，重复内容不能凭猜测定位。
  if (at < 0 || current.indexOf(expected, at + 1) >= 0) return null;
  const other = current.slice(0, at) + replacement + current.slice(at + expected.length);
  return patch.proposed ? { original: current, modified: other } : { original: other, modified: current };
}
