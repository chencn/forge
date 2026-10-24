/**
 * 回合级的「重试 / 重新生成」判定。
 *
 * 这里只做一件事：说清「这一回合现在能不能重来、为什么不能」。真正的发送仍走
 * `sendAiMessage`，它会换一个新的 runId 重新排队——重试永远由用户点出来，
 * 运行时自己绝不重发，这是这个后端从头到尾的约定。
 */
import type { AiTask } from "./aiRuntime";
import { isAiTaskQueued } from "./aiTaskStatus";

/** 能做的回合动作；`retry` 补一个没跑完的回合，`regenerate` 重跑刚跑完的那个。 */
export type AiTurnAction = "retry" | "regenerate";

/** 不能做的原因，直接是 i18n 键；没有原因即表示可以做。 */
export type AiTurnBlockReason =
  | "ai.chat.turnActionRunning"
  | "ai.chat.turnActionStopping"
  | "ai.chat.turnActionNothing"
  | "ai.chat.turnActionQueued"
  | "ai.chat.turnActionNotFinished"
  | "ai.chat.turnActionNoPrompt"
  | "ai.chat.turnActionSlash";

export interface AiTurnActionState {
  /** 会话当前状态，来自运行时快照。 */
  status: AiTask["status"] | "idle";
  /** 正在停止：这一轮还没落地，重试要等它落地。 */
  stopping: boolean;
  /** 按 seq 排好序的真实任务。 */
  tasks: readonly AiTask[];
}

export interface AiTurnActionDecision {
  /** 可以操作的那一回合；不可操作时为 null。 */
  task: AiTask | null;
  /** 不可操作的原因键；可操作时为 null。 */
  reason: AiTurnBlockReason | null;
}

/**
 * 只有**最近**一回合能重来。
 *
 * 更早的回合不能：CLI 的会话是接着往下写的，把第 3 回合的提示词现在再发一遍，
 * 它会带上前 3 回合之后的一切上下文。那不是「重试」，那是一次用户没预期的新提问。
 */
export function turnAction(state: AiTurnActionState, action: AiTurnAction): AiTurnActionDecision {
  if (state.stopping) return { task: null, reason: "ai.chat.turnActionStopping" };
  if (state.status === "running") return { task: null, reason: "ai.chat.turnActionRunning" };
  const latest = state.tasks.at(-1);
  if (!latest) return { task: null, reason: "ai.chat.turnActionNothing" };
  // 还没开跑的任务自有「立即运行 / 编辑」两条路，不该出现第三个动作。
  if (isAiTaskQueued(latest.status)) {
    return { task: null, reason: "ai.chat.turnActionQueued" };
  }
  // 没跑完的回合补一次（含被取消的），跑完的回合重新生成。
  const acceptable: AiTask["status"][] = action === "retry" ? ["failed", "cancelled"] : ["completed"];
  if (!acceptable.includes(latest.status)) return { task: null, reason: "ai.chat.turnActionNotFinished" };
  const prompt = latest.prompt?.trim() ?? "";
  if (!prompt) return { task: null, reason: "ai.chat.turnActionNoPrompt" };
  // 斜杠命令的原文重新发出去，含义未必还在：命令目录、参数改写与本地命令都在发送那一步才决定。
  if (prompt.startsWith("/")) return { task: null, reason: "ai.chat.turnActionSlash" };
  return { task: latest, reason: null };
}

/** 这一回合该显示什么按钮：可用动作给任务，其余给一句原因。 */
export function turnActions(state: AiTurnActionState): Partial<Record<AiTurnAction, AiTurnActionDecision>> {
  return { retry: turnAction(state, "retry"), regenerate: turnAction(state, "regenerate") };
}
