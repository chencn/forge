/** 上下文分类快照，与输入/输出/费用用量独立。summary 是 CLI 本地估算。 */
export type ContextKind = "used" | "free" | "buffer" | "deferred";
export interface ContextRow { name: string; tokens: number; kind: ContextKind }
export interface ContextItem { name: string; tokens: number; source?: string; loaded?: boolean }
export interface AiContext {
  runId: string;
  capturedAt: number;
  model: string;
  requestedModel?: string;
  total: number;
  /** CLI 解析后的自动压缩窗口，不保证等于模型硬上限。 */
  window: number;
  stale: boolean;
  categories: ContextRow[];
  sections: Partial<Record<"systemPrompt" | "systemTools" | "mcp" | "files" | "agents" | "skills" | "deferredTools" | "messages" | "attachments" | "toolCalls" | "toolResults", ContextItem[]>>;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function items(value: unknown, name = "name", source?: string, tokens = "tokens"): ContextItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((value) => {
    const row = object(value);
    return typeof row[name] === "string" && number(row[tokens]) ? [{ name: row[name] as string, tokens: row[tokens] as number, ...(source && typeof row[source] === "string" ? { source: row[source] as string } : {}), ...(typeof row.isLoaded === "boolean" ? { loaded: row.isLoaded } : {}) }] : [];
  });
}
export function normalizeAiContext(data: Record<string, unknown>, runId: string): AiContext | undefined {
  if (data.detail !== "summary" || !number(data.capturedAt) || !number(data.totalTokens) || !number(data.rawMaxTokens) || data.rawMaxTokens === 0 || typeof data.model !== "string" || !Array.isArray(data.categories)) return undefined;
  const categories: ContextRow[] = [];
  for (const value of data.categories) {
    const row = object(value);
    // 未知 kind 不能按英文分类名猜测为已用内容。
    if (typeof row.name !== "string" || !number(row.tokens) || !["used", "free", "buffer", "deferred"].includes(String(row.kind))) return undefined;
    categories.push({ name: row.name, tokens: row.tokens, kind: row.kind as ContextKind });
  }
  if (!categories.length) return undefined;
  const message = object(data.messageBreakdown);
  const messageKeys = ["userMessageTokens", "assistantMessageTokens", "toolCallTokens", "toolResultTokens", "attachmentTokens", "redirectedContextTokens", "unattributedTokens"] as const;
  return {
    runId, capturedAt: data.capturedAt, model: data.model, requestedModel: typeof data.requestedModel === "string" ? data.requestedModel : undefined, total: data.totalTokens, window: data.rawMaxTokens, stale: false, categories,
    sections: {
      systemPrompt: items(data.systemPromptSections), systemTools: items(data.systemTools),
      mcp: items(data.mcpTools, "name", "serverName"), files: items(data.memoryFiles, "path", "type"),
      agents: items(data.agents, "agentType", "source"), skills: items(object(data.skills).skillFrontmatter, "name", "source"),
      deferredTools: items(data.deferredBuiltinTools),
      messages: data.messageBreakdown && typeof data.messageBreakdown === "object" ? messageKeys.flatMap((name) => number(message[name]) ? [{ name, tokens: message[name] as number }] : []) : undefined,
      attachments: items(message.attachmentsByType), toolCalls: items(message.toolCallsByType, "name", undefined, "callTokens"), toolResults: items(message.toolCallsByType, "name", undefined, "resultTokens"),
    },
  };
}
/** 百分比不截断：超过窗口时仍显示实际比例；只有视觉条宽截断。 */
export function contextShare(tokens: number, window: number): string {
  const percent = tokens / window * 100;
  return percent > 0 && percent < 0.1 ? "<0.1%" : `${Number(percent.toFixed(1))}%`;
}
