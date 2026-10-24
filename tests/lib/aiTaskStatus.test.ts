import { describe, expect, it } from "vitest";
import {
  AI_TASK_BACKEND_STATUSES, AI_TASK_STATUSES,
  aiTaskStatusLabel, isAiTaskLive, isAiTaskQueued, isAiTaskStatus, isAiTaskBackendActive, isAiTaskBackendStatus, isAiTaskTerminal,
  type AiTaskStatus,
} from "../../src/lib/aiTaskStatus";

/**
 * 这张表抄自 Rust 的 `ai_runtime/task_status.rs::EMITTED`。
 * 两边没有代码生成，靠这里钉住：后端加一档或改拼写，这条测试就会红，
 * 逼着改动同时更新前端词表和事件投影。
 */
const BACKEND_CONTRACT = ["queued", "waitingExternal", "running", "completed", "cancelled", "failed"];

describe("AI 任务状态词表", () => {
  it("后端六个状态与 Rust 契约逐项相等，顺序也一致", () => {
    expect([...AI_TASK_BACKEND_STATUSES]).toEqual(BACKEND_CONTRACT);
    expect([...AI_TASK_STATUSES]).toEqual(["submitting", ...BACKEND_CONTRACT]);
  });

  it("每个状态恰好落进「未结束」或「终态」之一", () => {
    for (const status of AI_TASK_STATUSES) {
      expect(isAiTaskLive(status)).toBe(!isAiTaskTerminal(status));
      if (isAiTaskQueued(status)) expect(isAiTaskLive(status)).toBe(true);
    }
  });

  it("排队档只含尚未启动的三项，运行中的回合不算", () => {
    expect(AI_TASK_STATUSES.filter(isAiTaskQueued)).toEqual(["submitting", "queued", "waitingExternal"]);
    expect(AI_TASK_STATUSES.filter(isAiTaskTerminal)).toEqual(["completed", "cancelled", "failed"]);
    expect(AI_TASK_STATUSES.filter((status) => isAiTaskLive(status) && !isAiTaskQueued(status))).toEqual(["running"]);
  });

  it("submitting 是前端专属占位，后端词表不认它", () => {
    expect(isAiTaskBackendStatus("submitting" as AiTaskStatus)).toBe(false);
    expect(isAiTaskBackendActive("submitting" as AiTaskStatus)).toBe(false);
    // 但本地投影要认：编辑队列、取消、计数都靠它。
    expect(isAiTaskQueued("submitting")).toBe(true);
  });

  it("词表外的字符串一律不当成后端状态", () => {
    for (const value of ["", "idle", "Completed", "interrupted", "running ", null, undefined, 0, {}]) {
      expect(isAiTaskBackendStatus(value)).toBe(false);
      expect(isAiTaskBackendActive(value)).toBe(false);
    }
  });

  it("后端「还没结束」只认非终态的那三档", () => {
    expect(AI_TASK_BACKEND_STATUSES.filter(isAiTaskBackendActive)).toEqual(["queued", "waitingExternal", "running"]);
  });

  it("每个状态都有文案键，且排队中的三项各说各的话", () => {
    expect(AI_TASK_STATUSES.map(aiTaskStatusLabel)).toEqual([
      "ai.runtime.submitting", "ai.runtime.queued", "ai.runtime.waitingExternal",
      "ai.runtime.running", "ai.runtime.completed", "ai.runtime.cancelled", "ai.runtime.failed",
    ]);
  });

  it("词表外的字符串拿不到状态，界面于是回落到「就绪」", () => {
    for (const value of ["", "idle", "Completed", "interrupted", null, undefined, 0]) {
      expect(isAiTaskStatus(value)).toBe(false);
    }
    expect(isAiTaskStatus("waitingExternal")).toBe(true);
  });
});
