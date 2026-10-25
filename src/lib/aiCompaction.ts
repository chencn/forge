/**
 * 时间线上那一条压缩记录怎么读。
 *
 * 与 `aiCompact.ts` 分工：那边管「什么时候该提压缩、Forge 能不能自己动手」，这边只管
 * 「已经发生的这一次压缩，CLI 报了什么」。字段名的脏活全收在这里——同一次压缩的
 * token 前后值，实时流里是 `pre_tokens`/`post_tokens`，原生转写里是 `preTokens`/
 * `postTokens`，几代 CLI 还写过 `tokensBefore`；界面只读结果，认不出就没有数字，
 * 不猜也不编。
 */

/** 压缩事件里 token 前后值与时长的几种写法。 */
const BEFORE_KEYS = ["preTokens", "pre_tokens", "tokensBefore", "before_tokens", "tokens_before"];
const AFTER_KEYS = ["postTokens", "post_tokens", "tokensAfter", "after_tokens", "tokens_after"];
const DURATION_KEYS = ["durationMs", "duration_ms"];

/** 只用得到压缩条目的这几个字段，避免与 `AiEntry` 形成循环依赖。 */
export interface AiCompactionEntry { text: string; input?: unknown }

export const compactionRecord = (entry: AiCompactionEntry): Record<string, unknown> =>
  entry.input && typeof entry.input === "object" && !Array.isArray(entry.input) ? entry.input as Record<string, unknown> : {};

function pickNumber(meta: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = meta?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

/** 压缩卡要说的话。 */
export interface AiCompactionFacts {
  running: boolean;
  failed: boolean;
  before?: number;
  after?: number;
  /** CLI 自己报的耗时；没报就是 undefined，不拿前端看到两个状态的时刻差去冒充。 */
  durationMs?: number;
  /** 触发方式的原始词（auto/manual/…），怎么翻译由界面决定。 */
  trigger?: string;
  /** 保留下来的摘要正文；没有为空串。 */
  summary: string;
}

export function compactionFacts(entry: AiCompactionEntry): AiCompactionFacts {
  const data = compactionRecord(entry);
  const meta = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
    ? data.metadata as Record<string, unknown> : undefined;
  const status = String(data.status ?? "completed");
  const trigger = meta && typeof meta.trigger === "string" && meta.trigger.trim() ? meta.trigger.trim() : undefined;
  return { running: status === "running" || status === "compacting", failed: status === "failed",
    before: pickNumber(meta, BEFORE_KEYS), after: pickNumber(meta, AFTER_KEYS),
    durationMs: pickNumber(meta, DURATION_KEYS), trigger, summary: entry.text.trim() };
}
