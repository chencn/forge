import { useEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "../i18n";
import type { AiProvider } from "../lib/aiCli";
import { contextPercent, formatTokenCount } from "../lib/aiUsage";
import type { AiUsage } from "../lib/aiUsage";
import type { AiContext } from "../lib/aiContext";
import { rememberContextWindow } from "../lib/aiContextMemory";
import type { CompactDecision } from "../lib/aiCompact";
import AiCompactPanel from "./AiCompactPanel";
import AiContextDetails from "./AiContextDetails";
import Popover from "./Popover";

/** 与弹层明细共用同一种格式：一位小数，整数值不带 .0，极小值不显示成 0%。 */
function percentLabel(percent: number | undefined): string {
  if (percent === undefined) return "--";
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${Number(percent.toFixed(1))}%`;
}

/**
 * 上下文用量芯片（保留 forge 的 Claude 上下文构成，位置与样式对照参考实现）：
 * 环形进度 + 百分比，点开向上弹出紧凑用量卡——标题行 + 进度条 + 已用/窗口 +
 * token 明细行；压缩建议只在真的值得做（或正在压缩）时出现，不常驻占版面；
 * 构成明细收在同一弹层的滚动区里。
 */
export default function AiContextChip({ triggerRef, provider, usage, context, contextUnavailable, actualModel, selectedModel, compact, autoCompact, compacting, onCompact, onCompactLater, onAutoCompact }: {
  /** 会话页持有按钮引用：斜杠命令 `/context` 需要模拟点击打开这颗芯片。 */
  triggerRef?: Ref<HTMLButtonElement>;
  provider: AiProvider;
  usage?: AiUsage;
  context?: AiContext;
  contextUnavailable?: boolean;
  actualModel?: string;
  /** 用户当前选中的模型 id；用于判断快照是否过期。 */
  selectedModel?: string;
  compact: CompactDecision;
  autoCompact: boolean;
  compacting: boolean;
  onCompact: () => void;
  onCompactLater: () => void;
  onAutoCompact: (next: boolean) => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  /** 弹层锚点用 state 存：ref 在某些渲染路径下（如测试的静态渲染）不可跨渲染保留。 */
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);

  const contextSelection = provider === "claude" ? selectedModel || actualModel : selectedModel;
  // 请求的模型与快照里的模型对不上时，快照按「过期」展示：数字还能看，但不能当决策依据。
  const shownContext = context && contextSelection && contextSelection !== context.requestedModel && contextSelection !== context.model ? { ...context, stale: true } : context;
  const currentContext = shownContext && !shownContext.stale ? shownContext : undefined;
  // 没有正在跑的回合时，上一份快照就是用户唯一能看到的上下文：照常显示，
  // 过期只在弹层里标注。外面和弹层必须共用同一份数字，不能一个用快照、一个用本轮用量。
  const contextTotal = shownContext?.total ?? usage?.context;
  const contextWindow = shownContext?.window ?? usage?.window;
  const percent = contextPercent({ context: contextTotal, window: contextWindow });
  // 芯片只报占用比例；拿不到比例时退回报累计 token（对照参考的 Coins 分支）。
  const chipLabel = percent !== undefined ? percentLabel(percent) : usage?.total !== undefined ? formatTokenCount(usage.total) : percentLabel(undefined);
  // 窗口多大只有 CLI 知道：把本轮报到的那个窗口按 (引擎, 模型) 存下来，
  // 供下一次还没报告时当分母用（届时会标明来源，并拒绝自动压缩）。
  useEffect(() => {
    if (currentContext) rememberContextWindow(provider, currentContext.model, currentContext.window, currentContext.capturedAt);
    else if (usage?.window !== undefined) rememberContextWindow(provider, usage.model ?? selectedModel, usage.window);
  }, [provider, currentContext, usage?.window, usage?.model, selectedModel]);

  useEffect(() => {
    if (!open) return;
    popover.current?.focus();
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      opener.current?.focus();
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", dismiss, true); window.removeEventListener("keydown", escape); };
  }, [open]);

  /** token 明细行：有数的才画，合计行压一条上边线（对照参考的 token rows）。 */
  const tokenRows: { key: string; label: string; value: number }[] = [];
  if (usage?.input !== undefined) tokenRows.push({ key: "input", label: t("ai.usage.input"), value: usage.input });
  if (usage?.output !== undefined) tokenRows.push({ key: "output", label: t("ai.usage.output"), value: usage.output });
  if (usage?.cached !== undefined) tokenRows.push({ key: "cached", label: t("ai.usage.cached"), value: usage.cached });
  if (usage?.cacheWrite !== undefined) tokenRows.push({ key: "cacheWrite", label: t("ai.usage.cacheWrite"), value: usage.cacheWrite });
  if (usage?.total !== undefined) tokenRows.push({ key: "total", label: t("ai.usage.total"), value: usage.total });
  // 压缩区只在有建议、正在压缩或用户开过自动时出现：空闲时它只是一块与占用无关的按钮堆。
  const compactVisible = compact.action !== "none" || compacting || autoCompact;

  return <div ref={root} className="ai-context-chip">
    <button
      ref={(element) => {
        opener.current = element;
        if (typeof triggerRef === "function") triggerRef(element);
        else if (triggerRef && typeof triggerRef === "object") (triggerRef as { current: HTMLButtonElement | null }).current = element;
      }}
      type="button"
      className={`ai-context-trigger${compacting ? " is-compacting" : ""}${compact.action === "suggest" && !compacting ? " is-urgent" : ""}`}
      title={`${t("ai.chat.context")}: ${chipLabel}${compacting ? ` · ${t("ai.chat.compactionRunning")}` : ""}`}
      aria-label={`${t("ai.chat.context")} ${chipLabel}`}
      aria-expanded={open}
      onClick={(event) => { opener.current = event.currentTarget; setAnchor(event.currentTarget); setOpen((value) => !value); }}
    >
      {compacting ? (
        <Loader2 size={12} className="is-spinning ai-context-spinner" aria-hidden="true" />
      ) : (
        <span className={`ai-context-ring${percent === undefined ? " is-unknown" : ""}`} style={{ "--context-fill": `${Math.min(100, Math.max(0, percent ?? 0))}%` } as CSSProperties} aria-hidden="true" />
      )}
      <span>{chipLabel}</span>
      {compacting ? <strong className="ai-context-state">{t("ai.compact.chipCompacting")}</strong> : compact.action === "suggest" ? <span className="ai-context-badge" aria-hidden="true" /> : null}
    </button>
    {open ? (
      <Popover anchor={anchor} onClose={() => { setOpen(false); opener.current?.focus(); }} maxWidth={320} modal={false}>
        <div ref={popover} className="ai-context-popover" role="dialog" aria-label={t("ai.chat.context")} tabIndex={-1}>
          <header className="ai-context-head">
            <strong>{t("ai.chat.contextWindow")}</strong>
            <span className="ai-context-percent">{chipLabel}</span>
          </header>
          <div className="ai-context-bar" role="img" aria-label={chipLabel}>
            <span style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }} />
          </div>
          {contextTotal !== undefined || contextWindow !== undefined ? (
            <p className="ai-context-used"><span>{t("ai.usage.usedMax")}</span><span>{formatTokenCount(contextTotal)} / {formatTokenCount(contextWindow)}</span></p>
          ) : null}
          {tokenRows.length ? <dl className="ai-context-tokens">
            {tokenRows.map((row) => <div key={row.key} className={row.key === "total" ? "is-total" : undefined}>
              <dt>{row.label}</dt><dd>{formatTokenCount(row.value)}</dd>
            </div>)}
          </dl> : null}
          {contextUnavailable ? <p className="ai-context-note">{t("ai.context.unavailable")}</p> : null}
          {compactVisible ? <AiCompactPanel decision={compact} auto={autoCompact} compacting={compacting} disabled={false} onCompact={onCompact} onLater={onCompactLater} onAuto={onAutoCompact} /> : null}
          <div className="ai-context-details-scroll">
            <AiContextDetails provider={provider} context={shownContext} unavailable={contextUnavailable} />
          </div>
        </div>
      </Popover>
    ) : null}
  </div>;
}
