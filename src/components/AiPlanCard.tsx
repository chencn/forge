import { useState } from "react";
import { CheckCircle2, ChevronRight, CircleDashed, Loader2, ListTodo } from "lucide-react";
import AiMarkdown from "./AiMarkdown";
import { useI18n } from "../i18n";
import type { AiEntry, AiPlanReview } from "../lib/aiRuntime";

const STATUS_KEY = {
  awaiting_review: "ai.plan.awaiting",
  submitting: "ai.plan.submitting",
  approved: "ai.plan.approved",
  changes_requested: "ai.plan.changesRequested",
  deferred: "ai.plan.deferred",
  expired: "ai.plan.expired",
  superseded: "ai.plan.superseded",
} as const;

function statusLabel(t: ReturnType<typeof useI18n>["t"], status: AiPlanReview["status"]) {
  return t(STATUS_KEY[status] ?? "ai.plan.awaiting");
}

/** 当前仍需用户处理的计划：同一 planId 取最新版本，多个 planId 取最近更新的一份。 */
export { openAiPlan } from "../lib/aiPlan";

interface AiPlanApprovalProps {
  plan: AiPlanReview;
  disabled?: boolean;
  onApprove: () => Promise<void>;
  onRequestChanges: (feedback: string) => Promise<void>;
  onDefer: () => Promise<void>;
}

/**
 * 计划审批卡：固定钉在输入框上方，和 codeg 的 plan-approval-card 一致。
 * 批准不携带自由文本；要求修改必须写清反馈；暂不执行只落本地账。
 */
export default function AiPlanApproval({ plan, disabled = false, onApprove, onRequestChanges, onDefer }: AiPlanApprovalProps) {
  const { t } = useI18n();
  const [changesOpen, setChangesOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    if (busy || disabled) return;
    setBusy(true); setError(null);
    try { await action(); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const locked = busy || disabled;
  return <section className="ai-plan-approval" aria-label={t("ai.plan.title")}>
    <header>
      <ListTodo size={15} aria-hidden />
      <strong>{plan.title || t("ai.plan.title")}</strong>
      <span className="ai-plan-revision">v{plan.revision}</span>
      <span className="ai-plan-status">{statusLabel(t, plan.status)}</span>
    </header>
    <div className="ai-plan-body"><AiMarkdown text={plan.content} /></div>
    {changesOpen ? <div className="ai-plan-feedback">
      <textarea className="text-input" rows={3} autoFocus disabled={locked} value={feedback}
        placeholder={t("ai.plan.feedbackPlaceholder")} aria-label={t("ai.plan.feedbackPlaceholder")}
        onChange={(event) => setFeedback(event.target.value)} />
      <div className="ai-plan-actions">
        <button type="button" className="button" disabled={locked} onClick={() => setChangesOpen(false)}>{t("ai.plan.cancel")}</button>
        <button type="button" className="button is-primary" disabled={locked || !feedback.trim()} onClick={() => void run(() => onRequestChanges(feedback.trim()))}>
          {busy ? <Loader2 size={13} className="is-spinning" aria-hidden /> : null}{t("ai.plan.sendChanges")}
        </button>
      </div>
    </div> : <div className="ai-plan-actions">
      <button type="button" className="button is-primary" disabled={locked} onClick={() => void run(onApprove)}>
        {busy ? <Loader2 size={13} className="is-spinning" aria-hidden /> : null}{t("ai.plan.approve")}
      </button>
      <button type="button" className="button" disabled={locked} onClick={() => setChangesOpen(true)}>{t("ai.plan.requestChanges")}</button>
      <button type="button" className="button" disabled={locked} onClick={() => void run(onDefer)}>{t("ai.plan.defer")}</button>
    </div>}
    {error ? <p className="ai-error" role="alert">{error}</p> : null}
  </section>;
}

/** 时间线里的一份计划：草稿随流式增长，完成后显示状态与可折叠全文。 */
export function AiPlanEntry({ entry }: { entry: AiEntry }) {
  const { t } = useI18n();
  const record = entry.input && typeof entry.input === "object" && !Array.isArray(entry.input)
    && typeof (entry.input as Record<string, unknown>).planId === "string"
    && typeof (entry.input as Record<string, unknown>).revision === "number"
    ? entry.input as unknown as AiPlanReview : null;
  const status = record?.status;
  const icon = !record ? <Loader2 size={14} className="is-spinning" aria-hidden />
    : status === "approved" ? <CheckCircle2 size={14} aria-hidden />
      : status === "awaiting_review" || status === "deferred" ? <CircleDashed size={14} aria-hidden />
        : <CircleDashed size={14} aria-hidden />;
  return <details className={`ai-plan-entry is-${status ?? "draft"}`} open={status === "awaiting_review" || status === "deferred"}>
    <summary>
      <ChevronRight size={13} className="ai-detail-chevron" aria-hidden />
      {icon}
      <strong>{record?.title || t("ai.plan.draft")}</strong>
      {record ? <span className="ai-plan-revision">v{record.revision}</span> : null}
      {record ? <span className="ai-plan-status">{statusLabel(t, record.status)}</span> : null}
    </summary>
    <div className="ai-plan-body">{entry.text ? <AiMarkdown text={entry.text} /> : <p className="ai-muted">{t("ai.plan.drafting")}</p>}</div>
    {record && record.execution !== "not_started" ? <p className="ai-plan-execution">{t(`ai.plan.execution.${record.execution}` as Parameters<typeof t>[0])}</p> : null}
  </details>;
}
