import type { AiEntry } from "./aiRuntime";

export type ToolKind = "command" | "read" | "search" | "list" | "edit" | "add" | "delete" | "move" | "tool";
export interface ToolAction { kind: ToolKind; target: string; detail?: string; start?: number; end?: number }
export interface ToolPatch { path: string; kind: ToolKind; destination?: string; diff?: string; before?: string; after?: string; proposed: boolean; start?: number; counts?: { additions: number; deletions: number } }
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
/** 工具条目是否为已执行生效的状态（实时完成 completed 或历史已落盘 recorded）。 */
export const isExecutedToolStatus = (status?: string) => status === "completed" || status === "recorded";
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
  if (command) {
    view.kind = "command";
    // 行标题说「这是干什么的」：优先 agent 自己写的命令描述（对照参考实现 CommandLabel），
    // 没有描述才回落命令行本身——不从命令文本猜用途，猜错比显示原文更糟。
    const description = string(input.description)?.split(/\r?\n/, 1)[0].trim();
    view.summary = description || command.split(/\r?\n/, 1)[0];
  }
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
    const start = number(file.startLine) ?? number(input.offset), count = number(file.numLines) ?? number(input.limit);
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
    const change = toolObject(item);
    // Codex 的 change.kind 是字符串（"update"/"add"/"delete"）；Claude 的是对象。
    const rawKind = change.type ?? change.kind;
    const kind = typeof rawKind === "string" ? { type: rawKind } : toolObject(rawKind);
    view.patches.push({ path: string(change.path) ?? "", kind: kind.move_path ? "move" : kind.type === "add" ? "add" : kind.type === "delete" ? "delete" : "edit", destination: string(kind.move_path), diff: string(change.diff), proposed: !isExecutedToolStatus(entry.status), start: hunkStart(string(change.diff)) });
  }
  // 原生 Codex 历史保存 apply_patch 文本，按其显式文件头分组，不猜测缺失的行号。
  if (entry.name?.endsWith("apply_patch") && typeof entry.input === "string") {
    let current: ToolPatch | undefined;
    for (const line of entry.input.split(/\r?\n/)) {
      const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
      if (header) { current = { path: header[2], kind: header[1] === "Add" ? "add" : header[1] === "Delete" ? "delete" : "edit", diff: "", proposed: !isExecutedToolStatus(entry.status) }; view.patches.push(current); }
      else if (current && line.startsWith("*** Move to: ")) { current.kind = "move"; current.destination = line.slice(13); }
      else if (details && current && !line.startsWith("*** ")) current.diff += `${line}\n`;
    }
  }
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(entry.name ?? "")) {
    const hunks = Array.isArray(result.structuredPatch) ? result.structuredPatch.map(toolObject).filter((h) => Array.isArray(h.lines)) : [];
    const diff = details ? hunks.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${(h.lines as unknown[]).map(String).join("\n")}`).join("\n") : "";
    // Write 既能创建也能覆盖，只有结果明确标为 create 才算新增。
    const isNewFile = result.type === "create";
    view.patches.push({ path: path ?? "", kind: isNewFile ? "add" : "edit", diff: diff || undefined,
      // 折叠态不拼整份 diff，但补丁头的行号是白拿的：摘要那颗跳转要靠它。
      start: number(firstHunk.newStart) ?? hunkStart(diff || undefined),
      // 没有真实补丁时，输入 old/new 仅是请求；Write update 不伪造整文件新增 diff。
      before: !diff ? string(input.old_string) : undefined,
      after: !diff ? entry.name === "Write" ? string(result.content) ?? string(input.content) : string(result.newString) ?? string(input.new_string) : undefined,
      // 成功结果即使没有补丁也已写入；仅记录请求不能证明 Edit 已执行。
      proposed: result.staged === true || !isExecutedToolStatus(entry.status) || (!hunks.length && !isNewFile && entry.status !== "completed"),
      ...(!details && hunks.length ? { counts: hunks.reduce<{ additions: number; deletions: number }>((counts, hunk) => {
        // 折叠态只统计官方补丁行，不拼接整份 diff。
        for (const line of hunk.lines as unknown[]) {
          if (typeof line === "string" && line.startsWith("+")) counts.additions++;
          if (typeof line === "string" && line.startsWith("-")) counts.deletions++;
        }
        return counts;
      }, { additions: 0, deletions: 0 }) } : {}) });
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

export interface AiEditedFile {
  path: string;
  additions?: number;
  deletions?: number;
  kind?: "add" | "delete" | "edit";
  /** 改动/删除：该文件的全部 unified diff（汇总卡行内预览用）。 */
  diff?: string;
  /** 新增：建档时的完整内容（行内高亮预览用）。 */
  content?: string;
  /** 无结构化补丁时保留执行成功的替换片段，不推算文件行号。 */
  fragments?: Array<{ before?: string; after?: string }>;
}
export interface AiEditSummary { files: AiEditedFile[]; fileCount: number; additions?: number; deletions?: number }

/**
 * 常见命令 → 语义标题（对照参考实现「按用途命名命令行」）：行上说的是「构建 xxx」
 * 这种人话，原始命令收进悬浮提示与展开明细。认不出的命令如实回落原文——
 * 宁可显示原命令，也不编一个猜错的用途。
 */
export interface CommandIntent { key: string; subject?: string }

export function commandIntent(command: string): CommandIntent | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  // 第一个非选项参数当宾语（分支名/脚本名/目录名）。
  const subjectAfter = (from: number): string | undefined => {
    for (let index = from; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.startsWith("-")) continue;
      return token;
    }
    return undefined;
  };
  const [head, second] = tokens;
  const pkg = ["pnpm", "npm", "yarn", "bun"].includes(head);
  // 包管理器常带 run/--filter <pkg>，动作可能出现在第二或第三个词。
  if (pkg) {
    let action = second ?? "";
    let subject: string | undefined;
    for (let index = 1; index < tokens.length; index += 1) {
      if (tokens[index] === "--filter" && tokens[index + 1]) subject = tokens[index + 1];
    }
    if (action === "run") action = tokens[2] ?? "";
    const map: Record<string, string> = {
      install: "ai.cmd.install", add: "ai.cmd.install", ci: "ai.cmd.install",
      build: "ai.cmd.build", dev: "ai.cmd.dev", serve: "ai.cmd.dev", start: "ai.cmd.dev",
      test: "ai.cmd.test", lint: "ai.cmd.lint", check: "ai.cmd.check",
    };
    const key = map[action.split(":")[0]];
    return key ? { key, subject } : null;
  }
  if (head === "git" && second) {
    const map: Record<string, string> = {
      status: "ai.cmd.gitStatus", diff: "ai.cmd.gitDiff", log: "ai.cmd.gitLog",
      show: "ai.cmd.gitShow", branch: "ai.cmd.gitBranch", add: "ai.cmd.gitAdd",
      commit: "ai.cmd.gitCommit", push: "ai.cmd.gitPush", pull: "ai.cmd.gitPull",
      fetch: "ai.cmd.gitPull", stash: "ai.cmd.gitStash", restore: "ai.cmd.gitRestore",
      rebase: "ai.cmd.gitRebase", cherry: "ai.cmd.gitRebase",
    };
    const key = map[second];
    if (key) return { key };
    if (second === "checkout" || second === "switch") return { key: "ai.cmd.gitCheckout", subject: subjectAfter(2) };
    if (second === "merge") return { key: "ai.cmd.gitMerge", subject: subjectAfter(2) };
    return null;
  }
  if (head === "cargo" || head === "go") {
    const map: Record<string, string> = { build: "ai.cmd.build", test: "ai.cmd.test", run: "ai.cmd.run", check: "ai.cmd.check" };
    const key = map[second ?? ""];
    return key ? { key } : null;
  }
  if (["python", "python3", "py", "node", "deno", "bunx", "npx"].includes(head)) {
    const script = subjectAfter(1);
    return script ? { key: "ai.cmd.runScript", subject: script } : null;
  }
  if (head === "docker" && (second === "compose" || second === "compose")) {
    const third = tokens[2];
    if (third === "up") return { key: "ai.cmd.dockerUp" };
    if (third === "down") return { key: "ai.cmd.dockerDown" };
    return null;
  }
  const simple: Record<string, [string, boolean]> = {
    mkdir: ["ai.cmd.mkdir", true], rm: ["ai.cmd.remove", true], del: ["ai.cmd.remove", true],
    cp: ["ai.cmd.copy", true], copy: ["ai.cmd.copy", true], mv: ["ai.cmd.move", true],
    ls: ["ai.cmd.listDir", true], dir: ["ai.cmd.listDir", true], cat: ["ai.cmd.readFile", true],
    type: ["ai.cmd.readFile", true], grep: ["ai.cmd.search", false], find: ["ai.cmd.search", false],
    curl: ["ai.cmd.http", false], ping: ["ai.cmd.ping", false],
  };
  const entry = simple[head.toLowerCase()];
  if (entry) return { key: entry[0], subject: entry[1] ? subjectAfter(1) : undefined };
  return null;
}

/** 文件修改类工具（新增/编辑/删除/移动）：时间线里提到一级单独成行，不进过程折叠段。 */
export function isFileEditEntry(entry: AiEntry): boolean {
  if (entry.kind !== "tool") return false;
  return ["edit", "add", "delete", "move"].includes(describeAiTool(entry, false).kind);
}

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

/** 解析读取文件工具实际读取的行数：根据读取范围、正文分行或请求 limit 精确计算（不混淆为文件总行数）。 */
export function toolReadLines(entry: AiEntry, view: ToolView): number | undefined {
  // 1. 优先取结构化明细中本次实际读取的起止行范围（end - start + 1）
  if (view.source?.start !== undefined && view.source?.end !== undefined) {
    return Math.max(0, view.source.end - view.source.start + 1);
  }
  const result = toolObject(entry.result);
  const file = toolObject(result.file);
  const readCount = number(file.numLines);
  if (readCount !== undefined) return readCount;

  // 2. 检查 view actions 中记录的读取范围
  const action = view.actions.find((a) => a.kind === "read");
  if (action?.start !== undefined && action?.end !== undefined) {
    return Math.max(0, action.end - action.start + 1);
  }

  // 3. 检查本次读取正文内容的实际行数
  if (typeof file.content === "string") return file.content.split(/\r?\n/).length;
  if (typeof result.content === "string") return result.content.split(/\r?\n/).length;
  if (typeof entry.output === "string" && entry.output.length > 0) return entry.output.split(/\r?\n/).length;
  if (typeof entry.result === "string" && entry.result.length > 0) return entry.result.split(/\r?\n/).length;

  // 4. 运行中（running）尚未收到输出时，使用入参请求的读取行数
  const input = toolObject(entry.input);
  const limit = number(input.limit) ?? number(input.numLines);
  if (limit !== undefined) return limit;
  return undefined;
}

/** 行尾的 `+N −N` 计数（对照 DiffFigure）；任何补丁缺 diff 就整个不显示，不报半个数。 */
export function toolDiffCounts(view: ToolView): { additions: number; deletions: number } | undefined {
  if (!view.patches.length) return undefined;
  let additions = 0;
  let deletions = 0;
  for (const patch of view.patches) {
    if (patch.counts) { additions += patch.counts.additions; deletions += patch.counts.deletions; continue; }
    if (!patch.diff) return undefined;
    for (const line of parseToolDiff(patch.diff)) {
      if (line.kind === "add") additions += 1;
      if (line.kind === "delete") deletions += 1;
    }
  }
  return { additions, deletions };
}

/**
 * 实时计算文件改动行数（支持流式生成中动态变化）：
 * 优先官方结构化/unified diff；流式过程中若尚未产生 patch，则根据 input.new_string/old_string
 * 或 input.content/patch 动态差异对比，随着流式吐字实时计算出增加和减少的行数。
 */
export function toolLiveDiffCounts(entry: AiEntry, view: ToolView): { additions: number; deletions: number } | undefined {
  // 1. 已有确定性 diff 统计（如 structuredPatch 或 patch diff）
  const exact = toolDiffCounts(view);
  if (exact) return exact;

  const input = toolObject(entry.input);
  const result = toolObject(entry.result);

  // 2. 检查补丁文本（如 patch 或 diff 字段）
  const patchText = string(input.patch) ?? string(input.diff) ?? (typeof entry.input === "string" && entry.input.includes("*** ") ? entry.input : undefined);
  if (patchText) {
    let additions = 0, deletions = 0;
    for (const rawLine of patchText.split(/\r?\n/)) {
      if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) additions++;
      else if (rawLine.startsWith("-") && !rawLine.startsWith("---")) deletions++;
    }
    if (additions > 0 || deletions > 0) return { additions, deletions };
  }

  // 3. Write / 新增文件或整文件覆盖流式内容
  const isWrite = entry.name === "Write" || view.patches.some((p) => p.kind === "add");
  const content = string(input.content) ?? string(result.content);
  if (isWrite && content !== undefined) {
    const additions = content.length > 0 ? content.split(/\r?\n/).length : 0;
    return { additions, deletions: 0 };
  }

  // 4. Edit 工具中的 old_string 与 new_string 流式动态差异计算
  const oldStr = string(input.old_string) ?? string(result.oldString);
  const newStr = string(input.new_string) ?? string(result.newString);
  if (oldStr !== undefined || newStr !== undefined) {
    const oldLines = oldStr ? oldStr.split(/\r?\n/) : [];
    const newLines = newStr ? newStr.split(/\r?\n/) : [];
    if (!oldLines.length && newLines.length) return { additions: newLines.length, deletions: 0 };
    if (oldLines.length && !newLines.length) return { additions: 0, deletions: oldLines.length };

    // 剔除相同前缀行
    let start = 0;
    while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
      start++;
    }
    // 剔除相同后缀行
    let oldEnd = oldLines.length;
    let newEnd = newLines.length;
    while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    return { additions: Math.max(0, newEnd - start), deletions: Math.max(0, oldEnd - start) };
  }

  return undefined;
}

/** 按真实完成的补丁聚合文件与行数；任何缺失 diff 的补丁都会让总行数保持未知。 */
export function summarizeAiFileEdits(entries: AiEntry[]): AiEditSummary {
  const files = new Map<string, { additions: number; deletions: number; measured: boolean; kind: "add" | "delete" | "edit"; diff?: string; content?: string; fragments?: AiEditedFile["fragments"] }>();
  let allMeasured = true;
  for (const entry of entries) {
    if (entry.kind !== "tool" || !isExecutedToolStatus(entry.status)) continue;
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
        // 行内预览要的数据顺手攒下：改动/删除拼 diff，新增留建档内容——都是已有字符串的引用。
        current.diff = current.diff === undefined ? patch.diff : current.diff + "\n" + patch.diff;
        for (const line of parseToolDiff(patch.diff)) {
          if (line.kind === "add") current.additions += 1;
          if (line.kind === "delete") current.deletions += 1;
        }
      }
      if (patch.after !== undefined && (current.kind === "add" || patch.kind === "add") && current.content === undefined) {
        current.content = patch.after;
      }
      files.set(patch.path, current);
      // 不同位置的替换是独立片段，不能把首次 before 与末次 after 拼成伪造的整文件版本。
      if (!patch.diff && patch.kind !== "add" && (patch.before !== undefined || patch.after !== undefined)) {
        (current.fragments ??= []).push({ before: patch.before, after: patch.after });
      }
    }
  }
  const list = [...files.entries()].map(([path, stats]) => stats.measured
    ? { path, additions: stats.additions, deletions: stats.deletions, kind: stats.kind, diff: stats.diff, content: stats.content }
    : { path, kind: stats.kind, diff: stats.diff, content: stats.content, fragments: stats.fragments });
  const measured = list.length > 0 && allMeasured && list.every((file) => file.additions !== undefined);
  return {
    files: list,
    fileCount: list.length,
    additions: measured ? list.reduce((sum, file) => sum + (file.additions ?? 0), 0) : undefined,
    deletions: measured ? list.reduce((sum, file) => sum + (file.deletions ?? 0), 0) : undefined,
  };
}
