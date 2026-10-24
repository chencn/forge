/**
 * 一次运行报告的用量。字段全部可选：不同 CLI、不同事件只报告其中一部分，
 * 缺失时界面显示「—」而不是 0，避免把「没报告」误读成「用了 0」。
 * 数值一律以 CLI 的报告为准，不从模型名或累计用量反推。
 */
export interface AiUsage {
  /** 本次请求的输入 token；单条消息的 input 不含缓存读写，需另加。 */
  input?: number;
  /** 本次请求的输出 token。 */
  output?: number;
  /** 命中缓存读取的 token，通常比 input 便宜得多。 */
  cached?: number;
  /** 写入缓存的 token，首次建立缓存时才有。 */
  cacheWrite?: number;
  /** 推理/思考 token，只有报告了该字段的模型才有。 */
  reasoning?: number;
  /** 整个会话累计消耗的 token，不等于当前上下文占用。 */
  total?: number;
  /** 当前上下文已占用 token，用于算百分比。 */
  context?: number;
  /** 模型上下文窗口上限；未知时不显示百分比。 */
  window?: number;
  /** CLI 自报的费用（美元），不代表订阅账单。 */
  cost?: number;
  /** 实际使用的模型名；一次运行里切换过模型时可能对不上当前选择。 */
  model?: string;
}
/** 只接受普通对象，数组与 null 一律当空对象，省掉调用处的判空。 */
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
/** 只接受有限非负数。负数、NaN、字符串都是不可信输入，按「未报告」处理。 */
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
/**
 * 把 CLI 报告的用量合并进已有结果。
 *
 * 两种格式：Codex 给 `tokenUsage`（last/total 分开），Claude 给 `usage` 或 `modelUsage`。
 * `previous` 兜底是必要的——有些事件只带增量字段，缺的项不能清空之前已知的值。
 */
export function normalizeAiUsage(data: Record<string, unknown>, previous: AiUsage = {}): AiUsage {
  const tokenUsage = record(data.tokenUsage);
  // Codex 的格式：last 是最近一条消息，total 是整个会话的累计。
  if (Object.keys(tokenUsage).length) {
    const last = record(tokenUsage.last); const total = record(tokenUsage.total);
    return { ...previous, input: number(last.inputTokens), output: number(last.outputTokens), cached: number(last.cachedInputTokens),
      cacheWrite: number(last.cacheWriteInputTokens), reasoning: number(last.reasoningOutputTokens), total: number(total.totalTokens),
      context: number(last.totalTokens), window: number(tokenUsage.modelContextWindow) };
  }
  const models = record(data.modelUsage);
  const modelNames = Object.keys(models);
  // 只有恰好一个模型时才敢把它的 contextWindow 当作本次的窗口；
  // 多个模型混用时无从判断，留空让界面显示「—」。
  const onlyModel = modelNames.length === 1 ? modelNames[0] : undefined;
  const model = onlyModel ? record(models[onlyModel]) : {};
  const usage = Object.keys(record(data.usage)).length ? record(data.usage) : data;
  const input = number(usage.input_tokens); const cached = number(usage.cache_read_input_tokens); const cacheWrite = number(usage.cache_creation_input_tokens);
  // 单条消息的 input 不含缓存读写，要自己加回去才是真实上下文；
  // 而按轮次聚合的用量（modelUsage / total_cost_usd / scope=turn）是累计值，
  // 拿它当上下文会把百分比撑爆，所以这类结果不覆盖已有的 context。
  const aggregate = "modelUsage" in data || "total_cost_usd" in data || data.scope === "turn";
  const context = !aggregate && input !== undefined ? input + (cached ?? 0) + (cacheWrite ?? 0) : previous.context;
  return { ...previous, input: input ?? previous.input, output: number(usage.output_tokens) ?? previous.output,
    cached: cached ?? previous.cached, cacheWrite: cacheWrite ?? previous.cacheWrite, context,
    window: number(model.contextWindow) ?? number(data.contextWindow) ?? previous.window,
    cost: number(data.total_cost_usd) ?? previous.cost, model: onlyModel ?? previous.model };
}
/** 上下文计数超过 1 Ki token 后按 1024 换算为 KB，和界面容量习惯一致。 */
export function formatTokenCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  return value >= 1024 ? `${Number((value / 1024).toFixed(1))} KB` : String(Math.round(value));
}

/** 上下文占用百分比。窗口大小未知或为 0 时返回 undefined，不猜一个分母。 */
export function contextPercent(usage: AiUsage | undefined): number | undefined {
  // 不在这里取整：外层芯片和弹层共用一位小数，先 Math.round 会把 14.9 变成 15。
  return usage?.context !== undefined && usage.window !== undefined && usage.window > 0 ? usage.context / usage.window * 100 : undefined;
}
