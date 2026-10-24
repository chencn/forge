import { useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useI18n } from "../i18n";
import { PROCESS_PAGE, pageProcess } from "../lib/aiTimeline";
import { describeAiTool } from "../lib/aiTools";
import { aiArrival, aiArrivalOf, formatAiClock } from "../lib/aiClock";
import type { AiEntry } from "../lib/aiRuntime";
import { AiExploreGroup, isExploreEntry } from "./AiToolDetails";

interface AiProcessGroupProps {
  /** 一段连续的工具调用与想法。 */
  entries: AiEntry[];
  /** 段里还有在跑的工具；这时默认摊开。 */
  active: boolean;
  /** 逐条怎么渲染由会话面板决定——这里不复制它那一串分支。 */
  render: (entry: AiEntry) => ReactNode;
}

/**
 * 连续过程折成一段。
 *
 * 一轮长任务里几十条工具调用挨着排，回复正文被挤到看不见。折起来之后一屏只剩
 * 「标题 + 分类细分 + 正文」，想看过程再展开，展开也先只给最近 8 条。
 * 头部对照参考 ActivityHeader：标题在跑时微光、细分用等宽字体、箭头收在文字后；
 * 完成后的总耗时与失败跳转也在这里（对照参考的 elapsed 与 jump-to-failure）。
 */
export default function AiProcessGroup({ entries, active, render }: AiProcessGroupProps) {
  const { t } = useI18n();
  // null 表示用户没表过态：跑着的段摊开，跑完的段收起来。
  const [open, setOpen] = useState<boolean | null>(null);
  const [shown, setShown] = useState(PROCESS_PAGE);
  const group = useRef<HTMLElement>(null);
  const expanded = open ?? active;
  const page = expanded ? pageProcess(entries, shown) : { visible: [] as AiEntry[], hidden: entries.length };
  // 细分（对照参考 ActivityHeader）：总步数 + 按类计数，等宽字体排在一行；失败数单独
  // 成按钮，点了展开整段并滚到第一条失败——错误埋在折叠里等于没报。
  const breakdown = useMemo(() => {
    let commands = 0, edits = 0, thinking = 0;
    for (const entry of entries) {
      if (entry.kind === "reasoning") thinking += 1;
      else {
        const kind = describeAiTool(entry, false).kind;
        if (kind === "command") commands += 1;
        else if (["edit", "add", "delete", "move"].includes(kind)) edits += 1;
      }
    }
    return [
      t("ai.chat.stepsTotal", { count: entries.length }),
      commands ? t("ai.chat.stepsCommands", { count: commands }) : "",
      edits ? t("ai.chat.stepsEdits", { count: edits }) : "",
      thinking ? t("ai.chat.stepsThinking", { count: thinking }) : "",
    ].filter(Boolean).join(" · ");
  }, [entries, t]);
  const failedCount = useMemo(() => entries.filter((entry) => entry.status === "failed").length, [entries]);
  /** 组耗时：从第一次看到它在跑、到第一次看到它跑完；历史里翻出来的旧段没有起点就不编。 */
  const durationLabel = useMemo(() => {
    const key = `process:${entries[0]?.id ?? ""}`;
    if (active) {
      aiArrival(`start:${key}`);
      return undefined;
    }
    const start = aiArrivalOf(`start:${key}`);
    if (start === undefined) {
      // CLI 报了每步耗时的场合（Codex）求和兜底；缺任何一步就整个不显示。
      const durations = entries.map((entry) => describeAiTool(entry).durationMs);
      if (durations.every((value) => value !== undefined)) {
        const total = durations.reduce((sum, value) => sum + (value ?? 0), 0);
        return total >= 1000 ? formatAiClock(total) : undefined;
      }
      return undefined;
    }
    const span = aiArrival(`end:${key}`) - start;
    return span >= 1000 ? formatAiClock(span) : undefined;
    // active 翻假的那一拍重算一次耗时。
  }, [entries, active]);
  const clusters = useMemo(() => {
    const out: Array<{ kind: "explore"; entries: AiEntry[] } | { kind: "single"; entry: AiEntry }> = [];
    for (const entry of page.visible) {
      if (isExploreEntry(entry)) {
        const last = out.at(-1);
        if (last && last.kind === "explore") last.entries.push(entry);
        else out.push({ kind: "explore", entries: [entry] });
      } else out.push({ kind: "single", entry });
    }
    // 只有一条浏览行的不折：折一条等于让人多点一次才看到本来就在眼前的东西。
    return out.flatMap((cluster) => cluster.kind === "explore" && cluster.entries.length < 2
      ? cluster.entries.map((entry) => ({ kind: "single" as const, entry }))
      : [cluster]);
  }, [page.visible]);
  const jumpToFailure = () => {
    const target = entries.find((entry) => entry.status === "failed");
    if (!target) return;
    setOpen(true);
    setShown(entries.length);
    // 展开与放行是两次提交，等下一帧 DOM 里才有目标行。
    window.requestAnimationFrame(() => {
      const element = group.current?.querySelector(`[data-entry-id="${CSS.escape(target.id)}"]`) as HTMLElement | null;
      if (!element) return;
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      element.classList.add("is-flash");
      window.setTimeout(() => element.classList.remove("is-flash"), 1600);
    });
  };
  return <section ref={group} className={`ai-process-group${expanded ? " is-open" : ""}${active ? " is-active" : ""}`} aria-label={breakdown}>
    <button type="button" className="ai-process-head" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
      <strong>{t("ai.chat.processTitle")}</strong>
      <span className="ai-process-breakdown" title={breakdown}>{breakdown}</span>
      {durationLabel ? <span className="ai-process-elapsed" aria-label={t("ai.tool.duration")}>{durationLabel}</span> : null}
      {failedCount ? <span className="ai-process-failed" role="button" tabIndex={0}
        title={t("ai.chat.jumpToFailure")} aria-label={t("ai.chat.jumpToFailure")}
        onClick={(event) => { event.stopPropagation(); jumpToFailure(); }}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); jumpToFailure(); } }}>
        {t("ai.chat.stepsFailed", { count: failedCount })}
      </span> : null}
      <ChevronRight size={14} className="ai-detail-chevron" aria-hidden="true" />
    </button>
    {expanded ? <>
      <div className="ai-process-body">
        {clusters.map((cluster) => cluster.kind === "explore"
          ? <AiExploreGroup key={`explore:${cluster.entries[0].id}`} entries={cluster.entries} render={render} />
          : render(cluster.entry))}
      </div>
      {page.hidden > 0 ? <button type="button" className="ai-text-button" onClick={() => setShown(shown + PROCESS_PAGE)}>{t("ai.chat.showEarlierSteps", { count: page.hidden })}</button> : null}
    </> : null}
  </section>;
}
