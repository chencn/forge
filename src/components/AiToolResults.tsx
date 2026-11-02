import { CheckCircle2, CircleDashed, CircleX, ExternalLink } from "lucide-react";
import type { AiEntry } from "../lib/aiRuntime";
import { aiToolError, aiToolSources, type AiTestSuite } from "../lib/aiToolResults";
import { useI18n } from "../i18n";
import { openExternal } from "../lib/fs";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceLine, TraceTitle } from "./ui/trace";
import { CodeBlock } from "./ui/code-block";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";

/** AI Elements Sources/Inline Citation, Test Results and Stack Trace, backed only by reported tool facts. */
export default function AiToolResults({ entry, suites }: { entry: AiEntry; suites: AiTestSuite[] }) {
  const { t } = useI18n();
  const sources = aiToolSources(entry);
  const error = aiToolError(entry);
  if (!sources.length && !suites.length && !error) return null;
  return <div className="ai-tool-results">
    {sources.length ? <TraceCollapsible data-element="sources" defaultOpen>
      <TraceCollapsibleTrigger><TraceTitle>{t("ai.elements.sources")} · {sources.length}</TraceTitle></TraceCollapsibleTrigger>
      <TraceCollapsibleContent><ol className="ai-element-sources">{sources.map((source, index) => <li key={source.url}>
        <HoverCard><HoverCardTrigger delay={100} closeDelay={150} render={<a href={source.url} />} data-slot="inline-citation" onClick={(event) => { event.preventDefault(); void openExternal(source.url); }}>
          <sup>[{index + 1}]</sup><span>{source.title}</span><ExternalLink size={12} aria-hidden />
        </HoverCardTrigger><HoverCardContent><strong>{source.title}</strong>
          <a href={source.url} onClick={(event) => { event.preventDefault(); void openExternal(source.url); }}>{source.url}</a>
        </HoverCardContent></HoverCard>
      </li>)}</ol></TraceCollapsibleContent>
    </TraceCollapsible> : null}
    {suites.length ? <Trace data-element="test-results" aria-label={t("ai.elements.tests")}>
      <strong>{t("ai.elements.tests")} · {t("ai.elements.testCounts", { passed: suites.flatMap((suite) => suite.tests).filter((test) => test.status === "passed").length, total: suites.reduce((sum, suite) => sum + suite.tests.length, 0) })}</strong>
      {suites.map((suite, index) => <TraceCollapsible key={`${suite.name}:${index}`} defaultOpen={suite.tests.some((test) => test.status === "failed")}>
        <TraceCollapsibleTrigger><TraceTitle>{suite.name}</TraceTitle></TraceCollapsibleTrigger>
        <TraceCollapsibleContent>{suite.tests.map((test, index) => <div key={`${test.name}:${index}`}>
          <TraceLine status={test.status === "failed" ? "error" : undefined}>
            {test.status === "passed" ? <CheckCircle2 size={13} aria-hidden /> : test.status === "failed" ? <CircleX size={13} aria-hidden /> : <CircleDashed size={13} aria-hidden />}
            <span>{test.name}</span><small>{t(`ai.elements.test.${test.status}`)}</small>
          </TraceLine>
          {test.errors.length ? <CodeBlock text={test.errors.join("\n\n")} /> : null}
        </div>)}</TraceCollapsibleContent>
      </TraceCollapsible>)}
    </Trace> : null}
    {error ? <TraceCollapsible data-element="stack-trace" defaultOpen>
      <TraceCollapsibleTrigger><TraceLine status="error"><CircleX size={13} aria-hidden /><TraceTitle>{t("ai.runtime.failed")}</TraceTitle></TraceLine></TraceCollapsibleTrigger>
      <TraceCollapsibleContent><CodeBlock text={error.stack || error.message} /></TraceCollapsibleContent>
    </TraceCollapsible> : null}
  </div>;
}
