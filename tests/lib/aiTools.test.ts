import { describe, expect, it } from "vitest";
import type { AiEntry } from "../../src/lib/aiRuntime";
import { describeAiTool, parseToolDiff, summarizeAiFileEdits } from "../../src/lib/aiTools";

const tool = (change: Partial<AiEntry>): AiEntry => ({
  id: "tool",
  runId: "run",
  kind: "tool",
  text: "",
  ...change,
});

describe("AI 工具协议投影", () => {
  it("保留 Codex custom_tool_call 的原始 exec 脚本", () => {
    const script = "Get-Content src/main.ts\nrg -n TODO src";
    const view = describeAiTool(tool({ name: "exec", input: script, output: "done", status: "completed" }));
    expect(view.kind).toBe("command");
    expect(view.command).toBe(script);
    expect(view.summary).toBe("Get-Content src/main.ts");
  });

  it("保留 Codex commandActions 明确给出的读取范围", () => {
    const view = describeAiTool(tool({
      name: "exec",
      input: { command: "Get-Content src/main.ts", commandActions: [{ type: "read", path: "src/main.ts", startLine: 12, endLine: 30 }] },
      status: "completed",
    }));
    expect(view.actions).toEqual([{ kind: "read", target: "src/main.ts", detail: undefined, start: 12, end: 30 }]);
  });

  it("保留 Codex fileChange 的文件与真实 diff 行号", () => {
    const diff = "@@ -10,2 +10,2 @@\n-old\n+new\n same";
    const view = describeAiTool(tool({
      name: "fileChange",
      status: "completed",
      input: { changes: [{ path: "src/main.ts", kind: { type: "update" }, diff }] },
    }));
    expect(view.patches).toEqual([{ path: "src/main.ts", kind: "edit", diff, proposed: false, start: 10 }]);
    expect(parseToolDiff(diff)).toEqual([
      { kind: "header", text: "@@ -10,2 +10,2 @@" },
      { kind: "delete", text: "-old", oldLine: 10 },
      { kind: "add", text: "+new", newLine: 10 },
      { kind: "context", text: " same", oldLine: 11, newLine: 11 },
    ]);
  });

  it("折叠态也带着 Claude Edit 的起始行，摘要那颗跳转才跳得准", () => {
    const view = describeAiTool(tool({
      name: "Edit",
      status: "completed",
      input: { file_path: "src/main.ts" },
      result: { type: "update", structuredPatch: [{ oldStart: 40, oldLines: 2, newStart: 44, newLines: 3, lines: ["-old", "+new"] }] },
    }), false);
    expect(view.patches[0]?.diff).toBeUndefined();
    expect(view.patches[0]?.start).toBe(44);
  });

  it("保留 Claude Read 的文件路径、行范围与正文", () => {
    const view = describeAiTool(tool({
      name: "Read",
      status: "completed",
      input: { file_path: "src/main.ts", offset: 20 },
      result: { type: "text", file: { filePath: "src/main.ts", content: "one\ntwo", startLine: 20, numLines: 2, totalLines: 80 } },
    }));
    expect(view.summary).toBe("src/main.ts:20–21");
    expect(view.actions).toEqual([{ kind: "read", target: "src/main.ts", start: 20, end: 21 }]);
    expect(view.source).toEqual({ path: "src/main.ts", content: "one\ntwo", start: 20, end: 21, total: 80, truncated: false });
  });

  it("只聚合已完成的真实补丁，并按路径去重", () => {
    const completed = tool({ id: "done", name: "fileChange", status: "completed", input: { changes: [
      { path: "a.ts", kind: { type: "update" }, diff: "@@ -1,2 +1,3 @@\n-old\n keep\n+new\n+more" },
      { path: "a.ts", kind: { type: "update" }, diff: "@@ -9 +9 @@\n-before\n+after" },
    ] } });
    const failed = tool({ id: "failed", name: "fileChange", status: "failed", input: { changes: [{ path: "ignored.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b" }] } });
    const uncertain = tool({ id: "recorded", name: "apply_patch", status: "recorded", input: "*** Update File: uncertain.ts\n@@\n-old\n+new" });
    expect(summarizeAiFileEdits([completed, failed, uncertain])).toEqual({
      files: [{ path: "a.ts", additions: 3, deletions: 2, kind: "edit" }], fileCount: 1, additions: 3, deletions: 2,
    });
  });
});
