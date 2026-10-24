import type { AiEntry } from "./aiRuntime";

export type ToolKind = "command" | "read" | "search" | "list" | "edit" | "add" | "delete" | "move" | "tool";
export interface ToolAction { kind: ToolKind; target: string; detail?: string; start?: number; end?: number }
export interface ToolPatch { path: string; kind: ToolKind; destination?: string; diff?: string; before?: string; after?: string; proposed: boolean; start?: number }
export interface ToolView {
  kind: ToolKind; summary: string; actions: ToolAction[]; patches: ToolPatch[];
  command?: string; cwd?: string; exitCode?: number; durationMs?: number;
  source?: { path: string; content: string; start: number; end: number; total?: number; truncated: boolean };
}
export function toolObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") { try { return toolObject(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const string = (value: unknown) => typeof value === "string" ? value : undefined;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
export function toolText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => toolObject(v).type === "text")) return value.map((v) => String(toolObject(v).text ?? "")).join("\n");
  return JSON.stringify(value, null, 2) ?? "";
}

function hunkStart(diff?: string): number | undefined {
  const raw = diff ? /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(diff)?.[1] : undefined;
  return raw ? Number(raw) : undefined;
}

/** 只解释官方结构化字段；不能从任意 shell 文本猜文件内容或虚构行号。 */
export function describeAiTool(entry: AiEntry, details = true): ToolView {
  const input = toolObject(entry.input), result = toolObject(entry.result), file = toolObject(result.file);
  const firstHunk = toolObject(Array.isArray(result.structuredPatch) ? result.structuredPatch[0] : undefined);
  // Codex 自定义 exec 的 input 是原始脚本文本，不是 JSON；它本身就是要展示的命令。
  const command = entry.name === "exec" && typeof entry.input === "string" ? entry.input
    : Array.isArray(input.command) ? input.command.map(String).join(" ") : string(input.command) ?? string(input.cmd);
  const path = string(result.filePath) ?? string(file.filePath) ?? string(input.file_path) ?? string(input.path) ?? string(input.notebook_path);
  const view: ToolView = { kind: "tool", summary: entry.name ?? "", actions: [], patches: [], command,
    cwd: string(input.cwd) ?? string(input.workdir), exitCode: number(result.exitCode) ?? number(input.exitCode), durationMs: number(result.durationMs) ?? number(input.durationMs) };
  if (command) { view.kind = "command"; view.summary = command.split(/\r?\n/, 1)[0]; }
  for (const item of Array.isArray(input.commandActions) ? input.commandActions : []) {
    const action = toolObject(item);
    const kind = action.type === "read" ? "read" : action.type === "search" ? "search" : action.type === "listFiles" ? "list" : null;
    const start = number(action.startLine) ?? number(action.line) ?? number(action.offset);
    const count = number(action.numLines) ?? number(action.limit);
    const end = number(action.endLine) ?? (start !== undefined && count !== undefined ? start + Math.max(0, count - 1) : undefined);
    if (kind) view.actions.push({ kind, target: string(action.path) ?? string(action.name) ?? "", detail: string(action.query), start, end });
  }
  if (entry.name === "Read") {
    view.kind = "read"; view.summary = path ?? "";
    const start = number(file.startLine), count = number(file.numLines);
    view.actions.push({ kind: "read", target: path ?? "", start: start ?? number(input.offset), end: start !== undefined && count !== undefined ? start + Math.max(0, count - 1) : undefined });
    if (result.type === "text" && typeof file.content === "string" && start !== undefined && count !== undefined) {
      view.source = { path: path ?? "", content: file.content, start, end: start + Math.max(0, count - 1), total: number(file.totalLines), truncated: file.truncatedByTokenCap === true };
    }
  }
  if (entry.name === "Grep" || entry.name === "Glob" || entry.name === "webSearch") {
    view.kind = "search";
    view.summary = string(input.pattern) ?? string(input.query) ?? path ?? "";
    view.actions.push({ kind: "search", target: path ?? "", detail: [string(input.pattern) ?? string(input.query), string(input.glob)].filter(Boolean).join(" · ") });
  }
  if (input.kind === "mcp" || input.kind === "dynamic") {
    const namespace = string(input.server) ?? string(input.namespace) ?? "";
    const tool = string(input.tool) ?? entry.name ?? "";
    view.summary = [namespace, tool].filter(Boolean).join(" · ");
    view.actions.push({ kind: "tool", target: tool, detail: namespace || undefined });
  }
  for (const item of Array.isArray(input.changes) ? input.changes : []) {
    const change = toolObject(item), kind = toolObject(change.kind);
    view.patches.push({ path: string(change.path) ?? "", kind: kind.move_path ? "move" : kind.type === "add" ? "add" : kind.type === "delete" ? "delete" : "edit", destination: string(kind.move_path), diff: string(change.diff), proposed: entry.status !== "completed", start: hunkStart(string(change.diff)) });
  }
  // 原生 Codex 历史保存 apply_patch 文本，按其显式文件头分组，不猜测缺失的行号。
  if (entry.name?.endsWith("apply_patch") && typeof entry.input === "string") {
    let current: ToolPatch | undefined;
    for (const line of entry.input.split(/\r?\n/)) {
      const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
      if (header) { current = { path: header[2], kind: header[1] === "Add" ? "add" : header[1] === "Delete" ? "delete" : "edit", diff: "", proposed: entry.status !== "completed" }; view.patches.push(current); }
      else if (current && line.startsWith("*** Move to: ")) { current.kind = "move"; current.destination = line.slice(13); }
      else if (details && current && !line.startsWith("*** ")) current.diff += `${line}\n`;
    }
  }
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(entry.name ?? "")) {
    const hunks = details && Array.isArray(result.structuredPatch) ? result.structuredPatch.map(toolObject) : [];
    const diff = hunks.filter((h) => Array.isArray(h.lines)).map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${(h.lines as unknown[]).map(String).join("\n")}`).join("\n");
    view.patches.push({ path: path ?? "", kind: result.type === "create" ? "add" : "edit", diff: diff || undefined,
      // 折叠态不拼整份 diff，但补丁头的行号是白拿的：摘要那颗跳转要靠它。
      start: number(firstHunk.newStart) ?? hunkStart(diff || undefined),
      // 没有真实补丁时，输入 old/new 仅是请求；Write update 不伪造整文件新增 diff。
      before: !diff ? string(input.old_string) : undefined,
      after: !diff ? result.type === "create" ? string(result.content) : string(input.new_string) : undefined,
      proposed: result.staged === true || entry.status !== "completed" || !diff && result.type !== "create" });
  }
  if (view.patches.length) { view.kind = view.patches.length === 1 ? view.patches[0].kind : "edit"; view.summary = view.patches.map((patch) => patch.destination ? `${patch.path} → ${patch.destination}` : patch.path).join(" · "); }
  else if (view.actions.length && view.actions.every((a) => a.kind === view.actions[0].kind)) {
    view.kind = view.actions[0].kind; view.summary = view.actions.map((a) => [a.target, a.detail].filter(Boolean).join(" · ")).join(" · ");
    const action = view.actions[0];
    if (view.actions.length === 1 && action.start !== undefined) view.summary += `:${action.start}${action.end !== undefined && action.end !== action.start ? `–${action.end}` : ""}`;
  }
  return view;
}

export interface DiffLine { kind: "add" | "delete" | "context" | "header"; text: string; oldLine?: number; newLine?: number }
/** unified diff 的 hunk 提供真实起点；文件头与元信息不占源文件行号。 */
export function parseToolDiff(diff: string): DiffLine[] {
  let oldLine: number | undefined, newLine: number | undefined;
  let oldRemaining = 0, newRemaining = 0;
  return diff.split(/\r?\n/).map((text) => {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); oldRemaining = Number(hunk[2] ?? 1); newLine = Number(hunk[3]); newRemaining = Number(hunk[4] ?? 1); return { kind: "header", text }; }
    if (oldLine === undefined || newLine === undefined) {
      return { kind: text.startsWith("+") && !text.startsWith("+++") ? "add" : text.startsWith("-") && !text.startsWith("---") ? "delete" : "header", text };
    }
    if (!oldRemaining && !newRemaining || text.startsWith("\\") || !/^[ +\-]/.test(text)) return { kind: "header", text };
    if (text.startsWith("+")) { newRemaining--; return { kind: "add", text, newLine: newLine++ }; }
    if (text.startsWith("-")) { oldRemaining--; return { kind: "delete", text, oldLine: oldLine++ }; }
    oldRemaining--; newRemaining--;
    return { kind: "context", text, oldLine: oldLine++, newLine: newLine++ };
  });
}

export interface AiEditedFile { path: string; additions?: number; deletions?: number; kind?: "add" | "delete" | "edit" }
export interface AiEditSummary { files: AiEditedFile[]; fileCount: number; additions?: number; deletions?: number }

/** 编辑行的行号范围（对照参考实现 `Edited path L44–46`）：只认官方字段，缺失不编。 */
export function toolLineRange(view: ToolView): { start?: number; end?: number } {
  const patchStarts = view.patches.map((patch) => patch.start).filter((value): value is number => value !== undefined);
  const actionStarts = view.actions.map((action) => action.start).filter((value): value is number => value !== undefined);
  const starts = [...patchStarts, ...actionStarts];
  if (!starts.length) return {};
  const start = Math.min(...starts);
  const ends = view.actions.map((action) => action.end).filter((value): value is number => value !== undefined && value >= start);
  return { start, end: ends.length ? Math.max(...ends) : undefined };
}

/** 行尾的 `+N −N` 计数（对照 DiffFigure）；任何补丁缺 diff 就整个不显示，不报半个数。 */
export function toolDiffCounts(view: ToolView): { additions: number; deletions: number } | undefined {
  if (!view.patches.length) return undefined;
  let additions = 0;
  let deletions = 0;
  for (const patch of view.patches) {
    if (!patch.diff) return undefined;
    for (const line of parseToolDiff(patch.diff)) {
      if (line.kind === "add") additions += 1;
      if (line.kind === "delete") deletions += 1;
    }
  }
  return { additions, deletions };
}

/** 按真实完成的补丁聚合文件与行数；任何缺失 diff 的补丁都会让总行数保持未知。 */
export function summarizeAiFileEdits(entries: AiEntry[]): AiEditSummary {
  const files = new Map<string, { additions: number; deletions: number; measured: boolean; kind: "add" | "delete" | "edit" }>();
  let allMeasured = true;
  for (const entry of entries) {
    if (entry.kind !== "tool" || entry.status !== "completed") continue;
    for (const patch of describeAiTool(entry).patches) {
      if (patch.proposed || !patch.path) continue;
      const current = files.get(patch.path) ?? { additions: 0, deletions: 0, measured: true, kind: "edit" };
      // 同一文件先删后建的极端顺序按「删过就算删」：新增标记只给纯新增的文件。
      if (patch.kind === "delete") current.kind = "delete";
      else if (patch.kind === "add" && current.kind === "edit") current.kind = "add";
      if (!patch.diff) {
        current.measured = false;
        allMeasured = false;
      } else {
        for (const line of parseToolDiff(patch.diff)) {
          if (line.kind === "add") current.additions += 1;
          if (line.kind === "delete") current.deletions += 1;
        }
      }
      files.set(patch.path, current);
    }
  }
  const list = [...files.entries()].map(([path, stats]) => stats.measured
    ? { path, additions: stats.additions, deletions: stats.deletions, kind: stats.kind }
    : { path, kind: stats.kind });
  const measured = list.length > 0 && allMeasured && list.every((file) => file.additions !== undefined);
  return {
    files: list,
    fileCount: list.length,
    additions: measured ? list.reduce((sum, file) => sum + (file.additions ?? 0), 0) : undefined,
    deletions: measured ? list.reduce((sum, file) => sum + (file.deletions ?? 0), 0) : undefined,
  };
}
