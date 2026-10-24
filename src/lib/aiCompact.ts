/**
 * 什么时候该提「压缩上下文」，以及 Forge 能不能自己动手。
 *
 * CLI 自己会在快到窗口上限时压缩，但那发生在**回合中间**：正跑着的一轮被切断，
 * 折出来的摘要也服务不了这一轮。Forge 能挑一个更好的时机——回合已经结束、下一条还没发出去。
 *
 * 两条不能破的规矩：
 * - 数字不猜。分子只认本轮报告过的（快照没过期、或用量带回了 context），分母可以是
 *   该模型上次报告过的窗口，但那种情况下**只提示，绝不动手**。
 * - 待输入保护。输入框里有半截话、队列里还有没发出去的消息、或者正在等用户回答授权，
 *   自动压缩一律停手：压缩会改写这之后的历史，用户不该在毫不知情的情况下被换掉上下文。
 *
 * 压缩本身是一次模型调用，所以默认只提示，用户点头才做；自动那档要用户自己打开。
 */
import type { AiProvider } from "./aiCli";
import type { AiContext } from "./aiContext";
import type { AiUsage } from "./aiUsage";
import { recallContextWindow } from "./aiContextMemory";

/** 提示阈值（百分比整数）。 */
export const DEFAULT_COMPACT_THRESHOLD = 80;
export const MIN_COMPACT_THRESHOLD = 50;
export const MAX_COMPACT_THRESHOLD = 95;
/** 自动压缩永远不早于此比例，哪怕用户把提示阈值调得更低：折掉的内容下一轮可能还要用。 */
export const AUTO_COMPACT_MIN_PERCENT = 90;

export interface CompactPrefs {
  /** 自动压缩开关；默认关，用户自己点头才替他要动手。 */
  auto: boolean;
  threshold: number;
}

const prefsKey = "forge:ai:compact:v1";
const clampThreshold = (value: unknown): number => typeof value === "number" && Number.isFinite(value)
  ? Math.min(MAX_COMPACT_THRESHOLD, Math.max(MIN_COMPACT_THRESHOLD, Math.round(value)))
  : DEFAULT_COMPACT_THRESHOLD;

export function readCompactPrefs(): CompactPrefs {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(prefsKey) ?? "{}");
    const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return { auto: row.auto === true, threshold: clampThreshold(row.threshold) };
  } catch {
    return { auto: false, threshold: DEFAULT_COMPACT_THRESHOLD };
  }
}

export function writeCompactPrefs(prefs: Partial<CompactPrefs>): CompactPrefs {
  const next: CompactPrefs = { auto: prefs.auto ?? readCompactPrefs().auto, threshold: clampThreshold(prefs.threshold ?? readCompactPrefs().threshold) };
  try {
    localStorage.setItem(prefsKey, JSON.stringify(next));
  } catch {
    // 存不住只是下次回到默认，本轮判定照样用 next。
  }
  return next;
}

/** 分母是从哪来的：本轮报告、该模型的历史报告，或者根本没有。 */
export type WindowSource = "reported" | "remembered" | "unknown";

export interface CompactNumbers {
  total: number;
  window: number;
  source: WindowSource;
  /** 分子所属的模型写法，用来查记忆窗口。 */
  model?: string;
  /** 记忆到的那条报告的时间，用于说明分母有多旧。 */
  seenAt?: number;
}

/** 用来算比例的分子与分母；凑不出一对可信数字时返回 null。 */
export function compactNumbers(input: { provider: AiProvider; context?: AiContext; usage?: AiUsage; model?: string }): CompactNumbers | null {
  // 快照过期意味着分子分母都属于别的模型/配置，不能拿来当本轮占用。
  const context = input.context && !input.context.stale ? input.context : undefined;
  const usage = input.usage;
  const total = context?.total ?? usage?.context;
  if (total === undefined) return null;
  const model = context?.model ?? usage?.model ?? input.model;
  const window = context?.window ?? usage?.window;
  if (window !== undefined) return { total, window, source: "reported", model };
  const remembered = model ? recallContextWindow(input.provider, model) : undefined;
  // 分母来自记忆：只能提示，不能自动动手。
  return remembered ? { total, window: remembered.window, source: "remembered", model, seenAt: remembered.seenAt } : null;
}

/** 完全不给提示的硬阻断：现在这个状态压缩会出问题。 */
export type CompactBlockReason =
  | "ai.compact.blockNoSession"
  | "ai.compact.blockNoNumbers"
  | "ai.compact.blockStopping"
  | "ai.compact.blockRunning"
  | "ai.compact.blockRequest"
  | "ai.compact.blockQueued";

/** 只挡自动、不挡用户的软守卫。 */
export type CompactAutoGuard =
  | "ai.compact.guardDraft"
  | "ai.compact.guardRemembered"
  | "ai.compact.guardEarly";

export type CompactAction = "none" | "suggest" | "fire";

export interface CompactState {
  provider: AiProvider;
  /** 会话状态：idle / running / completed / cancelled / failed。 */
  status: string;
  stopping: boolean;
  /** 已经绑上 CLI 原生会话：没有它，压缩没有对象。 */
  boundSession: boolean;
  /** 等着用户回答的授权/提问数。 */
  pendingRequests: number;
  /** 还没开跑的排队消息数。 */
  queuedTasks: number;
  /** 输入框里的原文，用来做待输入保护。 */
  draft: string;
  context?: AiContext;
  usage?: AiUsage;
  /** 当前选中的模型；本轮没报告模型时用它查记忆窗口。 */
  model?: string;
  prefs: CompactPrefs;
  /** 用户这一档里已经点过「这次不用」。 */
  dismissed?: string | null;
}

export interface CompactDecision {
  action: CompactAction;
  /** 已用比例（四舍五入到整数百分比）；算不出来为 null。 */
  percent: number | null;
  source: WindowSource;
  /** 实际用来算比例的那对数字，界面要说清分母有多大。 */
  total?: number;
  window?: number;
  /** 分子所属的模型写法；用记忆分母时靠它说明「是谁的窗口」。 */
  model?: string;
  /** 记忆到的那次报告时间。 */
  seenAt?: number;
  /** 自动真正会动手的比例，可能比用户的提示阈值更高。 */
  autoAt?: number | null;
  reason: CompactBlockReason | null;
  /** 自动本该触发却被软守卫挡下的原因；null 表示没有。 */
  autoGuard: CompactAutoGuard | null;
  /** 提示的去重身份：同一档内点过「这次不用」就不再重复骚扰，跨过下一档才重新出现。 */
  noticeId: string | null;
}

const NONE: CompactDecision = { action: "none", percent: null, source: "unknown", reason: null, autoGuard: null, noticeId: null };
/** 会话还没跑过任何一轮时的判定；给只关心模型/权限的调用方当一个中性值用。 */
export const NO_COMPACT_DECISION: CompactDecision = NONE;

export function compactDecision(state: CompactState): CompactDecision {
  if (!state.boundSession) return { ...NONE, reason: "ai.compact.blockNoSession" };
  // 正在停止：这一轮还没落地，压缩会插在一个已经决定要结束的回合后面。
  if (state.stopping) return { ...NONE, reason: "ai.compact.blockStopping" };
  if (state.status === "running") return { ...NONE, reason: "ai.compact.blockRunning" };
  // 等用户答授权时压缩，等于把那一轮从他的回答脚下抽走。
  if (state.pendingRequests > 0) return { ...NONE, reason: "ai.compact.blockRequest" };
  if (state.queuedTasks > 0) return { ...NONE, reason: "ai.compact.blockQueued" };
  const numbers = compactNumbers(state);
  if (!numbers) return { ...NONE, reason: "ai.compact.blockNoNumbers" };
  const percent = Math.round(numbers.total / numbers.window * 100);
  const base: CompactDecision = { action: "none", percent, source: numbers.source, total: numbers.total, window: numbers.window, model: numbers.model, seenAt: numbers.seenAt, autoAt: null, reason: null, autoGuard: null, noticeId: null };
  if (percent < state.prefs.threshold) return base;
  // 提示按用户的阈值，自动再往后压一截；两个条件都成立才自己动手。
  const autoAt = Math.max(state.prefs.threshold, AUTO_COMPACT_MIN_PERCENT);
  let action: CompactAction = "suggest";
  let autoGuard: CompactAutoGuard | null = null;
  if (state.prefs.auto) {
    if (percent < autoAt) autoGuard = "ai.compact.guardEarly";
    else if (numbers.source !== "reported") autoGuard = "ai.compact.guardRemembered";
    else if (state.draft.trim()) autoGuard = "ai.compact.guardDraft";
    else action = "fire";
  }
  // 静音只针对「这个窗口大小上的这一档」：换了模型（分母不同）就该重新问一次。
  const noticeId = `${state.provider}:${numbers.window}:${Math.max(0, Math.floor(percent / 5) * 5)}`;
  const decided = { ...base, autoAt, action, autoGuard, noticeId };
  // 点过「这次不用」只静音这一档：数字还在，按钮不再出现，跨过下一档重新提。
  return state.dismissed === noticeId ? { ...decided, action: "none" } : decided;
}

/** 压缩指令的原文与意图：Codex 的压缩不接受附加指令，Claude 走自己的斜杠命令。 */
export function compactIntent(provider: AiProvider): "codexCompact" | "claudeSlash" {
  return provider === "codex" ? "codexCompact" : "claudeSlash";
}
export const COMPACT_COMMAND_TEXT = "/compact";
