/**
 * 任务状态的唯一来源。
 *
 * 这套字符串同时存在于 Rust 的 `ai_runtime/task_status.rs`：后端把其中六个写进事件日志，
 * 前端按它们决定队列、停止按钮和重试入口。两边靠字面量对齐、没有代码生成，所以每一处判断
 * 都必须走这里，不能在各组件里重新手写一份 `status === "..."` 的清单——历史上正是因为散着写，
 * 才出现过「本地已标取消、后端却继续启动下一条」这类只在竞态下暴露的分歧。
 *
 * `submitting` 只有前端会用到：它是 IPC 往返期间的乐观占位，后端绝不落盘，
 * 因此不属于「后端状态」，事件投影也不接受它。
 */

export type AiTaskStatus = "submitting" | "queued" | "waitingExternal" | "running" | "completed" | "cancelled" | "failed";

/** 后端写进事件日志的六个状态；顺序与内容必须和 Rust `task_status::EMITTED` 一致。 */
export const AI_TASK_BACKEND_STATUSES: readonly AiTaskStatus[] = ["queued", "waitingExternal", "running", "completed", "cancelled", "failed"];

/** 前端认识的全部状态：后端六个，加上只存在于本地的 `submitting`。 */
export const AI_TASK_STATUSES: readonly AiTaskStatus[] = ["submitting", ...AI_TASK_BACKEND_STATUSES];

/** 尚未启动，因此可以编辑、移动、立即执行或取消。运行中的回合不属于这一档。 */
const QUEUED: readonly AiTaskStatus[] = ["submitting", "queued", "waitingExternal"];
/** 还没终结：排队项加上正在跑的回合。 */
const LIVE: readonly AiTaskStatus[] = [...QUEUED, "running"];
/** 已落定的终态；只有这一档允许重试/重新生成。 */
const TERMINAL: readonly AiTaskStatus[] = ["completed", "cancelled", "failed"];

export function isAiTaskQueued(status: AiTaskStatus): boolean { return QUEUED.includes(status); }
export function isAiTaskLive(status: AiTaskStatus): boolean { return LIVE.includes(status); }
export function isAiTaskTerminal(status: AiTaskStatus): boolean { return TERMINAL.includes(status); }

/** 会话状态与任务状态共用同一批词，但从事件日志、后端摘要里拿到的是未经校验的 `string`。 */
export function isAiTaskStatus(value: unknown): value is AiTaskStatus {
  return typeof value === "string" && AI_TASK_STATUSES.includes(value as AiTaskStatus);
}

/** 每个状态一句现成的话；必须是字面量联合，界面才能直接把结果交给 i18n。 */
export type AiTaskStatusLabelKey =
  | "ai.runtime.submitting" | "ai.runtime.queued" | "ai.runtime.waitingExternal" | "ai.runtime.running"
  | "ai.runtime.completed" | "ai.runtime.cancelled" | "ai.runtime.failed";

const LABELS: Record<AiTaskStatus, AiTaskStatusLabelKey> = {
  submitting: "ai.runtime.submitting",
  queued: "ai.runtime.queued",
  waitingExternal: "ai.runtime.waitingExternal",
  running: "ai.runtime.running",
  completed: "ai.runtime.completed",
  cancelled: "ai.runtime.cancelled",
  failed: "ai.runtime.failed",
};

/** 状态 → 文案键。词表新增一档时这里必须跟着补，否则界面会把还在跑的那一档显示成「就绪」。 */
export function aiTaskStatusLabel(status: AiTaskStatus): AiTaskStatusLabelKey { return LABELS[status]; }

/** 事件投影只认后端词表：损坏或伪造的日志里冒出一个前端态，一律当没发生。 */
export function isAiTaskBackendStatus(value: unknown): value is AiTaskStatus {
  return typeof value === "string" && AI_TASK_BACKEND_STATUSES.includes(value as AiTaskStatus);
}

/**
 * 后端报告「这一轮还没结束」。用于合并后端的全日志摘要：
 * 那是未经词表校验的外部字符串，只认后端六个状态里的非终态，`submitting` 不在其中。
 */
export function isAiTaskBackendActive(value: unknown): value is AiTaskStatus {
  return isAiTaskBackendStatus(value) && !isAiTaskTerminal(value);
}
