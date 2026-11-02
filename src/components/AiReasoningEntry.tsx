import { memo, useState } from "react";
import { Brain } from "lucide-react";
import { useI18n } from "../i18n";
import type { AiEntry } from "../lib/aiRuntime";
import AiMarkdown from "./AiMarkdown";
import { TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "./ui/trace";

/** shadcn Reasoning pattern; disclose only the public summary supplied by the runtime. */
export default memo(function AiReasoningEntry({ entry, live }: { entry: AiEntry; live: boolean }) {
  const { t } = useI18n();
  const phase = live ? "running" : "completed";
  const [disclosure, setDisclosure] = useState<{ phase: string; open: boolean } | null>(null);
  // A manual choice belongs to this phase; completed history returns to collapsed.
  const open = disclosure?.phase === phase ? disclosure.open : live;
  const lines = entry.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const title = live ? lines.at(-1) ?? "" : lines[0] ?? "";
  const line = <TraceLine status={live ? "running" : undefined}>
    <TraceIcon className="ai-entry-icon"><Brain size={13} /></TraceIcon>
    <span aria-hidden className="ai-entry-dot" />
    <TraceTitle>{t(live ? "ai.chat.reasoningLive" : "ai.chat.reasoning")}</TraceTitle>
    {title ? <TraceDescription aria-hidden={live ? "true" : undefined}>{title}</TraceDescription> : null}
  </TraceLine>;
  // An empty streaming summary has nothing to expand; avoid a dead disclosure button.
  if (!entry.text.trim()) return <div className="ai-reasoning">{line}</div>;
  return <TraceCollapsible className="ai-reasoning" open={open} onOpenChange={(next) => setDisclosure({ phase, open: next })}>
    <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
    <TraceCollapsibleContent>{open ? <AiMarkdown text={entry.text} /> : null}</TraceCollapsibleContent>
  </TraceCollapsible>;
});
