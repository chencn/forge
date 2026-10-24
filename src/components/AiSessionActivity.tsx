import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/lang/zh";
import { useAiQueuedCount, useAiSessionActivity } from "../lib/aiRuntime";
import type { AiSessionActivity as Activity } from "../lib/aiRuntime";

/** 窄行里只显示短标签，完整句子留给悬停：长句会把会话标题挤没。 */
const LABELS: Record<Exclude<Activity, "idle">, { short: TranslationKey; full: TranslationKey }> = {
  running: { short: "ai.runtime.running", full: "ai.runtime.running" },
  queued: { short: "ai.runtime.queued", full: "ai.runtime.queued" },
  external: { short: "ai.runtime.externalShort", full: "ai.runtime.external" },
  conflict: { short: "ai.runtime.conflictShort", full: "ai.runtime.conflict" },
  unknown: { short: "ai.runtime.activityUnknownShort", full: "ai.runtime.activityUnknown" },
};

/** 侧栏和标签共享同一活动来源；状态文字必须直接可见，不能只靠一个含义不明的圆点。 */
export default function AiSessionActivity({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const state = useAiSessionActivity(sessionId);
  const queued = useAiQueuedCount(sessionId);
  if (state === "idle") return null;
  const label = t(LABELS[state].short);
  const detail = queued ? `${t(LABELS[state].full)} · ${t("ai.runtime.queuedCount", { count: queued })}` : t(LABELS[state].full);
  return <span className={`ai-activity is-${state}`} role="status" aria-label={detail} title={detail}>
    <i aria-hidden="true" /><span>{label}</span>{queued ? <small>{queued}</small> : null}
  </span>;
}
