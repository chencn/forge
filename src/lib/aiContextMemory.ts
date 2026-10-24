import type { AiProvider } from "./aiCli";

/**
 * 按 (引擎, 模型) 记住 CLI 亲口报告过的上下文窗口。
 *
 * 窗口多大只有 CLI 知道。Forge 不从模型名猜档位，也不把内置目录里的常见值当事实：
 * 这里存的每一个数都来自某一次真实的 `context` 快照或 `tokenUsage` 报告。
 * 记下来只有一个用途——本轮还没重新报告时，让「还剩多少地方」有一个**带来源**的分母，
 * 而不是整块显示「—」。来源会一路带在提示里说给用户听，记忆值永远不算本轮事实。
 */
const storageKey = "forge:ai:context-windows:v1";
/** 只留最近报告过的这么多条：模型很多的工作区也不能无限写。 */
const MAX_ENTRIES = 24;
/** 模型 id 最长这么多字符，和保存运行选项时的裁剪保持一致。 */
const MAX_MODEL = 200;

export interface ContextWindowFact {
  provider: AiProvider;
  /** CLI 报告时用的模型写法，原样保存；大小写变体各算一条，不猜它们是同一个。 */
  model: string;
  window: number;
  /** 这份数字是**什么时候报的**（毫秒），不是什么时候写进本地的。 */
  seenAt: number;
}

const isProvider = (value: unknown): value is AiProvider => value === "claude" || value === "codex";
/** 窗口必须是正的安全整数：负数、NaN、字符串、0 都按「没报告」处理。 */
const isWindow = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isSeenAt = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const modelName = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_MODEL) : undefined;

/** 坏数据逐条丢掉，不整串作废：一个写坏的模型 id 不该让已知的窗口一起消失。 */
export function parseContextWindows(raw: string | null): ContextWindowFact[] {
  try {
    const data: unknown = JSON.parse(raw ?? "null");
    if (!Array.isArray(data)) return [];
    return data.flatMap((item): ContextWindowFact[] => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const model = modelName(row.model);
      if (!isProvider(row.provider) || !model || !isWindow(row.window) || !isSeenAt(row.seenAt)) return [];
      return [{ provider: row.provider, model, window: row.window, seenAt: row.seenAt }];
    }).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function loadContextWindows(): ContextWindowFact[] {
  try {
    return parseContextWindows(localStorage.getItem(storageKey));
  } catch {
    // 存储读不到只是少了个分母，聊天照常。
    return [];
  }
}

/**
 * 记下一条报告。数组按「最近报告在前」存，同一 (引擎, 模型) 只留最新一条。
 *
 * 数字变小也要覆盖：换订阅、CLI 升级、模型改名都可能让窗口缩，留着大值会一直提示不足。
 */
export function rememberContextWindow(provider: AiProvider, model: string | undefined, window: number | undefined, seenAt?: number): void {
  const name = modelName(model);
  if (!name || !isWindow(window)) return;
  const at = isSeenAt(seenAt) ? Math.floor(seenAt) : Date.now();
  const next = [{ provider, model: name, window, seenAt: at }, ...loadContextWindows().filter((item) => !(item.provider === provider && item.model === name))].slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    // 写失败只退回「本轮没报告就显示 —」，不影响发送。
  }
}

export function recallContextWindow(provider: AiProvider, model: string | undefined): ContextWindowFact | undefined {
  const name = modelName(model);
  if (!name) return undefined;
  return loadContextWindows().find((item) => item.provider === provider && item.model === name);
}

/** 会话删掉时不清：窗口属于模型，不属于某个标签。只留一个整体清空给设置页用。 */
export function clearContextWindows(): void {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // 删不掉也无所谓：下次报告会覆盖。
  }
}
