import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { AI_NAMES, type AiProvider } from "../lib/aiCli";
import AiProviderIcon from "./AiProviderIcon";

/** 与参考实现相同的收展时长与缓动；滑块和胶囊共用，两者才能同步走完。 */
const REVEAL_MS = 300;
const REVEAL_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

export interface AiAgentPill {
  provider: AiProvider;
  /** 可选（已安装且启用）。不可选的胶囊置灰但保留图标与名称提示。 */
  usable: boolean;
  /** 不可选的原因（停用或未安装），画在悬停提示里。 */
  unavailableHint?: string;
}

/**
 * 工具胶囊选择器，对照参考实现的 AgentSelector：滑块随选中项滑动，
 * 未选中的胶囊收成图标、选中的展开名称。行宽不够时参考会折叠进「更多」，
 * forge 只有 Claude / Codex 两颗，恒放得下，省去折叠与弹出层。
 *
 * 滑块定位必须持续重测：胶囊的宽度在 300ms 过渡里一直在变，只在点击那一帧
 * 量一次会停在半途的尺寸上——这正是切换工具时「样式乱」的根源。参考实现用
 * ResizeObserver 盯住每颗胶囊与外框，过渡期间每一帧都把滑块贴回选中胶囊。
 */
export default function AiAgentPills({ pills, selected, onSelect, className }: {
  pills: AiAgentPill[];
  selected: AiProvider | null;
  onSelect: (provider: AiProvider) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<AiProvider, HTMLButtonElement>());
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  /**
   * 一次测量、一个答案：滑块贴选中胶囊。全部用布局像素（offsetLeft/offsetWidth），
   * 不用 getBoundingClientRect——后者受上层 CSS 缩放影响，和这里的未缩放值混算会错位。
   */
  const measure = useCallback(() => {
    const button = selected !== null ? itemRefs.current.get(selected) : null;
    if (!button) { setIndicator(null); return; }
    setIndicator((current) => current && current.left === button.offsetLeft && current.width === button.offsetWidth
      ? current
      : { left: button.offsetLeft, width: button.offsetWidth });
  }, [selected]);

  // 首帧绘制前量一次，避免滑块从 0 滑到位的启动闪动。
  const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
  useIsomorphicLayoutEffect(() => { measure(); }, [measure, pills.length]);

  // 胶囊在 300ms 过渡里持续变宽/变窄，外框随窗口与列宽变化：都要跟着重测。
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    for (const button of itemRefs.current.values()) observer.observe(button);
    if (frame.current) observer.observe(frame.current);
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => { observer.disconnect(); window.removeEventListener("resize", onResize); };
  }, [measure, pills.length]);

  const summary = useMemo(() => pills.map((pill) => ({
    ...pill,
    label: AI_NAMES[pill.provider],
    isSelected: pill.provider === selected,
  })), [pills, selected]);

  return (
    <div className={className}>
      <div ref={frame} className="ai-agent-track">
        {indicator ? <span aria-hidden className="ai-agent-droplet" style={{ left: indicator.left, width: indicator.width }} /> : null}
        {summary.map((pill) => (
          <button
            key={pill.provider}
            ref={(element) => {
              if (element) itemRefs.current.set(pill.provider, element);
              else itemRefs.current.delete(pill.provider);
            }}
            type="button"
            aria-pressed={pill.isSelected}
            disabled={!pill.usable}
            title={pill.usable
              ? `${t("ai.selectTool")} · ${pill.label}`
              : `${pill.label}${pill.unavailableHint ? ` · ${pill.unavailableHint}` : ""}`}
            onClick={() => onSelect(pill.provider)}
            className={`ai-agent-pill${pill.isSelected ? " is-selected" : ""}`}
          >
            {/* inline-flex 是有讲究的：裸行内盒会把图标放上文字基线，行高多出 4px、
                图标整体偏上。包成 flex 盒后高度就是图标本身，图标和文字共享一条中线。 */}
            <span className="ai-agent-glyph">
              <AiProviderIcon provider={pill.provider} size={16} />
              {!pill.usable ? <span className="ai-agent-dot" aria-hidden /> : null}
            </span>
            {/* 标签收展用 grid 0fr→1fr：宽度过渡平滑，且和参考同一条缓动曲线。 */}
            <span className="ai-agent-label-wrap">
              <span className="ai-agent-label">{pill.label}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export { REVEAL_MS, REVEAL_EASE };
