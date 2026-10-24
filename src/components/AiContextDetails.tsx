import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/lang/zh";
import type { AiProvider } from "../lib/aiCli";
import type { AiContext, ContextKind } from "../lib/aiContext";
import { contextShare } from "../lib/aiContext";
import { formatTokenCount } from "../lib/aiUsage";

const sectionKeys = {
  systemPrompt: "ai.context.systemPrompt", systemTools: "ai.context.systemTools", mcp: "ai.context.mcp", files: "ai.context.files",
  agents: "ai.context.agents", skills: "ai.context.skills", deferredTools: "ai.context.deferredTools", messages: "ai.context.messages",
  attachments: "ai.context.attachments", toolCalls: "ai.context.toolCalls", toolResults: "ai.context.toolResults",
} as const;
const names: Record<string, TranslationKey> = {
  "System prompt": "ai.context.systemPrompt", "System tools": "ai.context.systemTools", "MCP tools": "ai.context.mcp", "Memory files": "ai.context.files", Messages: "ai.context.messages", Skills: "ai.context.skills", Agents: "ai.context.agents",
  userMessageTokens: "ai.context.userMessages", assistantMessageTokens: "ai.context.assistantMessages", toolCallTokens: "ai.context.toolCalls", toolResultTokens: "ai.context.toolResults", attachmentTokens: "ai.context.attachments", redirectedContextTokens: "ai.context.redirected", unattributedTokens: "ai.context.unattributed",
};
const kindKeys: Record<ContextKind, TranslationKey> = { used: "ai.context.used", free: "ai.context.free", buffer: "ai.context.buffer", deferred: "ai.context.deferred" };

/** 展示真正的上下文分类；不把消费统计当作上下文组成。 */
export default function AiContextDetails({ provider, context, unavailable = false }: { provider: AiProvider; context?: AiContext; unavailable?: boolean }) {
  const { t, locale } = useI18n();
  const label = (name: string) => names[name] ? t(names[name]) : name;
  if (provider === "codex") return <p className="ai-popover-note">{t("ai.context.codexUnavailable")}</p>;
  if (!context) return <p className="ai-popover-note">{t(unavailable ? "ai.context.unavailable" : "ai.context.waiting")}</p>;
  // 过期快照仍然展示：没有新回合时，它就是用户上次看到的上下文，只加警告不藏数字。
  return <div className="ai-context-details">
    {context.stale ? <p className="ai-context-warning" role="status">{t("ai.context.stale")}</p> : null}
    {unavailable ? <p className="ai-popover-note">{t("ai.context.unavailable")}</p> : null}
    <div className="ai-context-total"><strong>{formatTokenCount(context.total)}<small> / {formatTokenCount(context.window)} tokens</small></strong><span>{contextShare(context.total, context.window)}</span></div>
    <p className="ai-popover-note">{t("ai.context.estimate")}</p>
    <div className="ai-context-categories">
      <div className="ai-context-columns"><span>{t("ai.context.category")}</span><span>tokens</span><span>{t("ai.context.share")}</span></div>
      {(["used", "buffer", "free", "deferred"] as const).map((kind) => {
        const rows = context.categories.filter((row) => row.kind === kind);
        if (!rows.length) return null;
        return <section key={kind} className={`ai-context-group is-${kind}`}>
          <h4>{t(kindKeys[kind])}</h4>
          {rows.map((row, index) => <div className="ai-context-category" key={`${row.name}-${index}`}>
            <div className="ai-context-columns"><span title={row.name}>{label(row.name)}</span><span>{row.tokens.toLocaleString(locale)}</span><span>{kind === "deferred" ? "—" : contextShare(row.tokens, context.window)}</span></div>
            {kind !== "deferred" ? <div className="ai-context-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, row.tokens / context.window * 100)}%` }} /></div> : null}
          </div>)}
        </section>;
      })}
    </div>
    <p className="ai-popover-note">{t("ai.context.detailsHint")}</p>
    {(Object.keys(sectionKeys) as Array<keyof typeof sectionKeys>).map((key) => {
      const rows = context.sections[key];
      if (!rows?.length) return null;
      return <details className="ai-context-section" key={key}>
        <summary>{t(sectionKeys[key])}<span>{rows.length}</span></summary>
        <dl>{rows.map((row, index) => <div className="ai-context-item" key={`${row.name}-${index}`}>
          <dt><span>{label(row.name)}</span>{row.source ? <small>{row.source}</small> : null}{row.loaded !== undefined ? <small>{t(row.loaded ? "ai.context.loaded" : "ai.context.deferred")}</small> : null}</dt>
          <dd>{row.tokens.toLocaleString(locale)}<small>{key === "mcp" || key === "deferredTools" ? row.loaded === true ? contextShare(row.tokens, context.window) : "—" : contextShare(row.tokens, context.window)}</small></dd>
        </div>)}</dl>
      </details>;
    })}
    <p className="ai-popover-note">{context.model} · {new Date(context.capturedAt).toLocaleString(locale)}</p>
  </div>;
}
