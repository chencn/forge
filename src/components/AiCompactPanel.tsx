import { useI18n } from "../i18n";
import type { CompactDecision } from "../lib/aiCompact";
import { formatTokenCount } from "../lib/aiUsage";

/**
 * 上下文面板里的压缩区：比例、分母来源、动手按钮与自动开关。
 *
 * 它住在 token 芯片点开的那一层，而不是输入框上方又一条横幅——用户看到占用要去点占用，
 * 而不是在聊天区里再读一遍同一个数字。
 *
 * 数字来源必须写出来：本轮报告的、还是该模型上次报告的，是两件事。后者只能提示，
 * 面板也据它拒绝自动动手。硬阻断（没绑会话、正在停止、本轮还在跑……）由后端语义给出，
 * 这里只如实照说，并把「立即压缩」按住。
 */
export default function AiCompactPanel({ decision, auto, compacting, disabled, onCompact, onLater, onAuto }: {
  decision: CompactDecision;
  /** 自动压缩开关，用来决定第三个按钮的措辞。 */
  auto: boolean;
  /** 本轮正在跑的就是压缩：按钮再点一次只是排队，要说清现在发生了什么。 */
  compacting: boolean;
  disabled: boolean;
  onCompact: () => void;
  /** 静音这一档；跨到下一档比例才重新提醒。 */
  onLater: () => void;
  onAuto: (next: boolean) => void;
}) {
  const { t } = useI18n();
  const blocked = decision.reason !== null;
  return <section className="ai-compact-panel" aria-label={t("ai.chat.compaction")}>
    <header><strong>{t("ai.chat.compaction")}</strong>{decision.percent !== null ? <span className={blocked ? "" : "is-percent"}>{`${decision.percent}%`}</span> : null}</header>
    {compacting ? <p className="ai-compact-panel-state" role="status">{t("ai.chat.compactionRunning")}</p> : decision.action === "suggest" ? <p className="ai-compact-panel-state">{t("ai.compact.hint", { percent: `${decision.percent}%` })}</p> : null}
    {decision.reason ? <p className="ai-muted">{t(decision.reason)}</p> : <>
      <p className="ai-muted">{decision.source === "reported"
        ? `${formatTokenCount(decision.total)} / ${formatTokenCount(decision.window)} · ${t("ai.compact.windowReported")}`
        : t("ai.compact.windowRemembered", { model: decision.model ?? "—", window: formatTokenCount(decision.window) })}</p>
      {decision.autoGuard ? <p className="ai-muted">{t(decision.autoGuard, { percent: `${decision.autoAt ?? 0}%` })}</p> : null}
      {auto ? <p className="ai-muted">{t("ai.compact.autoNote")}</p> : null}
    </>}
    <div className="ai-compact-panel-actions">
      <button type="button" className="button is-primary" disabled={disabled || blocked || compacting} onClick={onCompact}>{t("ai.compact.now")}</button>
      {decision.noticeId ? <button type="button" className="button" disabled={disabled || decision.action !== "suggest"} onClick={onLater}>{t("ai.compact.later")}</button> : null}
      <button type="button" className="ai-text-button" disabled={disabled} aria-pressed={auto} onClick={() => onAuto(!auto)}>{t(auto ? "ai.compact.disableAuto" : "ai.compact.enableAuto")}</button>
    </div>
  </section>;
}
