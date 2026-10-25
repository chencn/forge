import { describe, expect, it } from "vitest";
import type { AiEntry } from "../../src/lib/aiRuntime";
import { describeAiTool, parseToolDiff, summarizeAiFileEdits, toolDiffCounts, toolLiveDiffCounts, toolReadLines } from "../../src/lib/aiTools";

const tool = (change: Partial<AiEntry>): AiEntry => ({
  id: "tool",
  runId: "run",
  kind: "tool",
  text: "",
  ...change,
});

describe("AI 工具协议投影", () => {
  it("Claude 成功编辑没有 structuredPatch 时仍计入文件汇总，失败与仅记录的请求不计入", () => {
    const edit = tool({ name: "Edit", status: "completed", input: { file_path: "a.ts", old_string: "old", new_string: "new" }, output: "updated" });
    expect(summarizeAiFileEdits([edit]).files).toMatchObject([{ path: "a.ts", kind: "edit" }]);
    expect(describeAiTool(edit).patches[0]).toMatchObject({ before: "old", after: "new", proposed: false });
    expect(summarizeAiFileEdits([{ ...edit, status: "failed" }, { ...edit, status: "recorded" }]).fileCount).toBe(0);
  });

  it("Claude Write 缺少创建结果时不冒充新增，仍保留成功写入的内容", () => {
    const write = tool({ name: "Write", status: "completed", input: { file_path: "a.ts", content: "new content" }, output: "written" });
    expect(describeAiTool(write).patches[0]).toMatchObject({ kind: "edit", after: "new content", proposed: false });
  });
  it("同文件多次无补丁替换逐次保留，混合真实 diff 时也不丢片段", () => {
    const first = tool({ name: "Edit", status: "completed", input: { file_path: "a.ts", old_string: "a=1", new_string: "a=2" } });
    const second = tool({ ...first, id: "second", input: { file_path: "a.ts", old_string: "z=3", new_string: "z=4" } });
    const patch = tool({ name: "fileChange", status: "completed", input: { changes: [{ path: "a.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }] } });
    const fragments = [{ before: "a=1", after: "a=2" }, { before: "z=3", after: "z=4" }];
    expect(summarizeAiFileEdits([first, second]).files[0].fragments).toEqual(fragments);
    expect(summarizeAiFileEdits([first, patch, second]).files[0]).toMatchObject({ fragments, diff: "@@ -1 +1 @@\n-old\n+new" });
    expect(summarizeAiFileEdits([{ ...first, result: { staged: true } }]).fileCount).toBe(0);
  });
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
    expect(toolDiffCounts(view)).toEqual({ additions: 1, deletions: 1 });
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

  it("命令行标题优先 agent 的描述，没有描述才显示命令本身", () => {
    const described = describeAiTool(tool({ id: "b1", name: "Bash", input: { command: ["pnpm", "--filter", "web", "test"], description: "跑 web 单元测试" } }));
    expect(described.kind).toBe("command");
    expect(described.summary).toBe("跑 web 单元测试");
    // 原始命令仍在 view.command 里，明细与悬浮提示用它。
    expect(described.command).toBe("pnpm --filter web test");
    const bare = describeAiTool(tool({ id: "b2", name: "Bash", input: { command: "git status" } }));
    expect(bare.summary).toBe("git status");
  });
  it("只聚合已完成的真实补丁，并按路径去重", () => {
    const completed = tool({ id: "done", name: "fileChange", status: "completed", input: { changes: [
      { path: "a.ts", kind: { type: "update" }, diff: "@@ -1,2 +1,3 @@\n-old\n keep\n+new\n+more" },
      { path: "a.ts", kind: { type: "update" }, diff: "@@ -9 +9 @@\n-before\n+after" },
    ] } });
    const failed = tool({ id: "failed", name: "fileChange", status: "failed", input: { changes: [{ path: "ignored.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b" }] } });
    const uncertain = tool({ id: "recorded", name: "apply_patch", status: "recorded", input: "*** Update File: uncertain.ts\n@@\n-old\n+new" });
    expect(summarizeAiFileEdits([completed, failed, uncertain])).toEqual({
      // recorded 的历史补丁真实发生过（导入时没有完成事件），同样计入；
      // failed 的不算——失败补丁没写进文件。
      files: [
        { path: "a.ts", additions: 3, deletions: 2, kind: "edit",
          diff: "@@ -1,2 +1,3 @@\n-old\n keep\n+new\n+more\n@@ -9 +9 @@\n-before\n+after" },
        { path: "uncertain.ts", additions: 1, deletions: 1, kind: "edit",
          diff: "@@\n-old\n+new\n" },
      ],
      fileCount: 2, additions: 4, deletions: 3,
    });
  });
  it("已执行完成的 Write 操作计入汇总，并能区分新增文件与覆盖修改文件", () => {
    const created = tool({ id: "w1", name: "Write", status: "completed", input: { file_path: "src/new.ts" }, result: { type: "create", content: "hello" } });
    const updated = tool({ id: "w2", name: "Write", status: "completed", input: { file_path: "src/updated.ts", old_string: "a", new_string: "b" }, result: { type: "update" } });
    const summary = summarizeAiFileEdits([created, updated]);
    expect(summary.fileCount).toBe(2);
    expect(summary.files.find((f) => f.path === "src/new.ts")?.kind).toBe("add");
    expect(summary.files.find((f) => f.path === "src/updated.ts")?.kind).toBe("edit");
  });

  it("读取文件行数提取：精确提取读取行数，不与文件总行数混淆", () => {
    // 文件总行数 200 行，但本次仅读取 40 行
    const withSource = tool({ name: "Read", result: { file: { filePath: "a.ts", startLine: 1, numLines: 40, totalLines: 200 } } });
    const view1 = describeAiTool(withSource);
    expect(toolReadLines(withSource, view1)).toBe(40);

    const withOutput = tool({ name: "Read", output: "line 1\nline 2\nline 3" });
    const view2 = describeAiTool(withOutput);
    expect(toolReadLines(withOutput, view2)).toBe(3);

    const running = tool({ name: "Read", status: "running", input: { file_path: "b.ts", limit: 50 } });
    const view3 = describeAiTool(running);
    expect(toolReadLines(running, view3)).toBe(50);
  });

  it("修改文件行数动态实时计算：流式吐字期间 additions 实时动态增长并剔除前后缀", () => {
    // 阶段 1：模型刚输出 1 行替换
    const step1 = tool({
      name: "Edit",
      status: "running",
      input: { file_path: "x.ts", old_string: "const a = 1;\nconst b = 2;\nreturn a + b;", new_string: "const a = 1;\nconst b = 20;" },
    });
    const view1 = describeAiTool(step1);
    expect(toolLiveDiffCounts(step1, view1)).toEqual({ additions: 1, deletions: 2 });

    // 阶段 2：模型继续流式追加 3 行代码，additions 实时从 1 增加到 4
    const step2 = tool({
      name: "Edit",
      status: "running",
      input: { file_path: "x.ts", old_string: "const a = 1;\nconst b = 2;\nreturn a + b;", new_string: "const a = 1;\nconst b = 20;\nconst c = 30;\nconst d = 40;\nreturn a + b;" },
    });
    const view2 = describeAiTool(step2);
    // 前缀 "const a = 1;\n" 和后缀 "\nreturn a + b;" 均被精准剔除，只统计核心变化区
    expect(toolLiveDiffCounts(step2, view2)).toEqual({ additions: 3, deletions: 1 });

    // 阶段 3：Write 流式新建内容逐行增加
    const writeStep1 = tool({ name: "Write", status: "running", input: { file_path: "new.ts", content: "export const x = 1;" } });
    expect(toolLiveDiffCounts(writeStep1, describeAiTool(writeStep1))).toEqual({ additions: 1, deletions: 0 });
    const writeStep2 = tool({ name: "Write", status: "running", input: { file_path: "new.ts", content: "export const x = 1;\nexport const y = 2;\nexport const z = 3;" } });
    expect(toolLiveDiffCounts(writeStep2, describeAiTool(writeStep2))).toEqual({ additions: 3, deletions: 0 });
  });
});
