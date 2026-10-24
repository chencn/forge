import { describe, expect, it } from "vitest";
import { turnAction, turnActions } from "../../src/lib/aiRetry";
import type { AiTask } from "../../src/lib/aiRuntime";

const task = (runId: string, status: AiTask["status"], extra: Partial<AiTask> = {}): AiTask => ({ runId, status, seq: 1, ...extra });
const state = (tasks: AiTask[], status: string = "idle", stopping = false) => ({ tasks, status: status as never, stopping });

describe("aiRetry 的回合判定", () => {
  it("没跑成的最近回合给重试，不给重新生成", () => {
    const failed = task("r1", "failed", { prompt: "把队列改成 FIFO", error: "CLI 异常退出" });
    expect(turnAction(state([failed]), "retry")).toEqual({ task: failed, reason: null });
    expect(turnAction(state([failed]), "regenerate").reason).toBe("ai.chat.turnActionNotFinished");
  });
  it("被取消的回合同样能补一次——用户中止不等于这一轮不必重做", () => {
    const cancelled = task("r1", "cancelled", { prompt: "继续" });
    expect(turnAction(state([cancelled], "cancelled"), "retry")).toEqual({ task: cancelled, reason: null });
  });
  it("跑完的最近回合给重新生成，不给重试", () => {
    const done = task("r1", "completed", { prompt: "解释这段代码" });
    expect(turnAction(state([done], "completed"), "regenerate")).toEqual({ task: done, reason: null });
    expect(turnAction(state([done], "completed"), "retry").reason).toBe("ai.chat.turnActionNotFinished");
  });
  it("只有最近一回合能重来，更早的失败回合不在这里补", () => {
    const older = task("r1", "failed", { prompt: "旧问题", seq: 1 });
    const newer = task("r2", "completed", { prompt: "新问题", seq: 2 });
    expect(turnAction(state([older, newer], "completed"), "retry").reason).toBe("ai.chat.turnActionNotFinished");
    expect(turnAction(state([older, newer], "completed"), "regenerate").task?.runId).toBe("r2");
  });
  it("还在跑或正在停时一个回合动作都不给", () => {
    const running = task("r1", "running", { prompt: "写个测试" });
    expect(turnAction(state([running], "running"), "retry").reason).toBe("ai.chat.turnActionRunning");
    expect(turnAction(state([running], "running"), "regenerate").reason).toBe("ai.chat.turnActionRunning");
    // 停止优先：这一轮还没落地，此刻的重试会和它抢同一个会话。
    const failed = task("r1", "failed", { prompt: "写个测试" });
    expect(turnAction(state([failed], "failed", true), "retry").reason).toBe("ai.chat.turnActionStopping");
  });
  it("还没开跑的任务走「立即运行」，这里不出现第三个按钮", () => {
    for (const status of ["submitting", "queued", "waitingExternal"] as const) {
      expect(turnAction(state([task("r1", status, { prompt: "排队的问题" })]), "retry").reason).toBe("ai.chat.turnActionQueued");
    }
  });
  it("没有原文就没有可重发的内容", () => {
    for (const prompt of [undefined, "", "   "]) {
      expect(turnAction(state([task("r1", "failed", { prompt })]), "retry").reason).toBe("ai.chat.turnActionNoPrompt");
    }
    expect(turnAction(state([]), "retry").reason).toBe("ai.chat.turnActionNothing");
  });
  it("斜杠命令不重发：含义由当时的命令目录决定", () => {
    expect(turnAction(state([task("r1", "failed", { prompt: "/review HEAD~1" })]), "retry").reason).toBe("ai.chat.turnActionSlash");
  });
  it("一次判定给出两个动作，调用方不必各算一遍", () => {
    const failed = task("r1", "failed", { prompt: "继续" });
    const both = turnActions(state([failed]));
    expect(both.retry).toEqual({ task: failed, reason: null });
    expect(both.regenerate?.reason).toBe("ai.chat.turnActionNotFinished");
  });
});
