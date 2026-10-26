import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import hljs from "highlight.js";
import type { AiEntry } from "../lib/aiRuntime";
import { useI18n } from "../i18n";
import { describeAiTool, parseToolDiff, toolLineRange, toolLiveDiffCounts, toolObject, toolReadLines, toolText as show } from "../lib/aiTools";
import type { ToolView } from "../lib/aiTools";
import { AI_CLOCK_AFTER_MS, formatAiClock, useAiElapsed } from "../lib/aiClock";
import { useAiDiffViewMode } from "../lib/aiDiffView";
import AiDiffEditor from "./AiDiffEditor";
import type { AiRequestAnswer } from "../lib/aiApprovals";
import { ArrowUpRight, Bot, Brain, ChevronRight, FileText, FilePenLine, Layers, MessageCircleQuestionMark, Search, Terminal, FolderOpen } from "lucide-react";
import { renderCodeBlock } from "../lib/markdown";
import AiMarkdown from "./AiMarkdown";
import { AiQuestionCard } from "./AiQuestionCard";

/** 摘要只有一个目标时才整行可点：多个时摘要拼在一起，点了不知道开哪个。 */
function summaryTarget(view: ToolView): { path: string; line?: number } | null {
  if (view.actions.length === 1 && view.actions[0].target) {
    return { path: view.actions[0].target, line: view.actions[0].start };
  }
  if (view.patches.length === 1 && view.patches[0].path) {
    return { path: view.patches[0].path, line: view.patches[0].start };
  }
  return null;
}

/** Claude Code 的子代理工具名；它的调用按「委派」卡片渲染而不是普通工具行。 */
const DELEGATION_TOOL = /^task$/i;
/** 提问工具；历史里它只是一条工具记录，按只读问答卡渲染而不是裸 JSON。 */
const QUESTION_TOOL = /^askuserquestion$/i;

/** 从提问工具的入参里还原问题列表；结构不合的条目逐条丢弃，不整卡报废。 */
export function questionToolItems(entry: AiEntry): Array<{ id: string; question: string; header?: string; multiSelect?: boolean; options: Array<{ label: string; description?: string }> }> {
  const input = toolObject(entry.input);
  const list = Array.isArray(input.questions) ? input.questions : [];
  return list.flatMap((raw, index) => {
    const value = toolObject(raw);
    const text = typeof value.question === "string" ? value.question : "";
    if (!text) return [];
    return [{
      id: typeof value.id === "string" && value.id ? value.id : String(index),
      header: typeof value.header === "string" && value.header.trim() ? value.header : undefined,
      question: text,
      multiSelect: value.multiSelect === true,
      options: Array.isArray(value.options) ? value.options.flatMap((option) => {
        const item = toolObject(option);
        return typeof item.label === "string" ? [{ label: item.label, description: typeof item.description === "string" ? item.description : undefined }] : [];
      }) : [],
    }];
  });
}

/**
 * 历史里的提问记录（实时路径是独立的请求卡，这里只兜住工具形态的那份）：
 * 结果文本里出现过的选项标成已选——这只是「答案里提到了它」的诚实转述，不冒充当时的
 * 精确选择；一个都没对上就把结果原文整段摆出来，不编一个好看的答案。
 */
function AiQuestionRecord({ entry }: { entry: AiEntry }) {
  const { t } = useI18n();
  const questions = useMemo(() => questionToolItems(entry), [entry]);
  const outputText = useMemo(() => {
    const raw = entry.output !== undefined ? show(entry.output) : entry.result !== undefined ? show(entry.result) : "";
    return raw;
  }, [entry]);
  const answer = useMemo<AiRequestAnswer | undefined>(() => {
    if (!outputText || !questions.length) return undefined;
    const answers: Record<string, string[]> = {};
    let any = false;
    for (const question of questions) {
      for (const option of question.options) {
        if (outputText.includes(option.label)) {
          (answers[question.id] ??= []).push(option.label);
          any = true;
        }
      }
    }
    return any ? { answers } : undefined;
  }, [outputText, questions]);
  if (!questions.length) return null;
  const request = { requestId: entry.id, runId: entry.runId, kind: "question" as const, title: "", detail: "", questions, active: false };
  // 折叠形态与答完的请求卡同款：一行摘要 + 点开才是整张只读卡。摘要优先给当时选到的
  // 选项（答案里提到了），对不上就给问题正文——两头都不编。
  const answeredLabels = answer && "answers" in answer ? Object.values(answer.answers).flat().join("、") : "";
  const summary = answeredLabels || questions[0].question;
  return <div className="ai-question-record">
    <details>
      <summary>
        <MessageCircleQuestionMark size={13} className="ai-question-record-check" aria-hidden="true" />
        {/* 已答说「提问回答」；没答（历史里失效的提问）不冒充也不喊「需要回答」。 */}
        <span className="ai-question-record-prefix">{t(answeredLabels ? "ai.runtime.questionAnswered" : "ai.chat.questionRecord")}</span>
        <span className="ai-question-record-summary" title={summary}>{summary}</span>
        <ChevronRight className="ai-detail-chevron" size={13} aria-hidden="true" />
      </summary>
      {answer
        ? <AiQuestionCard request={request} readOnly answer={answer} />
        : <div className="ai-question is-read-only">
          <div className="ai-question-record-raw">
            {questions.map((question) => <p key={question.id}>{question.question}</p>)}
            {outputText ? <pre>{outputText}</pre> : <p className="ai-muted">{t("ai.runtime.requestExpired")}</p>}
          </div>
        </div>}
    </details>
  </div>;
}

/**
 * 子代理（Task 工具）的委派卡片，对照参考实现的 agent-row + 委派卡：
 * 一行「代理名 + 任务一句话 + 当前动作 + 状态 + 时钟」，展开是它自己的迷你时间线——
 * 子代理的正文、思考与工具调用（事件带 parent 归属）全部收在这里，不再平铺主对话。
 * 历史里 CLI 原生文件不带这些过程（子代理记录在独立的 subagents 目录，forge 不导入），
 * 那些旧会话的卡片就只有任务原文与最终结果，如实少显示。
 */
function AiDelegationCard({ entry, subagents, agent, onOpenAgent }: { entry: AiEntry; subagents?: AiEntry[]; agent?: { sessionId: string }; onOpenAgent?: (id: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<boolean | null>(null);
  const input = entry.input && typeof entry.input === "object" && !Array.isArray(entry.input) ? entry.input as Record<string, unknown> : {};
  const agentName = String(input.subagent_type ?? input.agent_type ?? t("ai.tool.delegation"));
  const description = typeof input.description === "string" ? input.description : "";
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const running = entry.status === "running";
  const failed = entry.status === "failed";
  const elapsed = useAiElapsed(running, entry.id);
  const status = running ? t("ai.runtime.running") : failed ? t("ai.runtime.failed")
    : entry.status === "completed" ? t("ai.runtime.completed") : entry.status === "cancelled" ? t("ai.runtime.cancelled") : "";
  // 展开默认：还在跑的子代理摊开（看得见它在动）；跑完的收起。
  const expanded = open ?? running;
  // 当前动作（对照 ProgressLine）：优先在跑的工具摘要，其次最新一段正文的首行。
  const currentAction = useMemo(() => {
    if (!subagents?.length) return undefined;
    for (let index = subagents.length - 1; index >= 0; index--) {
      const child = subagents[index];
      if (child.kind === "tool" && child.status === "running") {
        return describeAiTool(child, false).summary;
      }
    }
    return undefined;
  }, [subagents]);
  const lastAssistant = useMemo(() => [...(subagents ?? [])].reverse().find((child) => child.kind === "assistant" && child.text.trim()), [subagents]);
  return <div className={`ai-delegation${running ? " is-running" : ""}${failed ? " is-failed" : ""}${expanded ? " is-open" : ""}`}>
    <button type="button" className="ai-delegation-main" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
      <span className="ai-delegation-marker" aria-hidden><Bot size={16} /></span>
      <span className="ai-delegation-body">
        <span className="ai-delegation-name"><strong>{agentName}</strong></span>
        {description ? <span className="ai-delegation-task" title={description}>{description}</span> : null}
        {currentAction ? <span className="ai-delegation-progress" aria-hidden="true">{currentAction}</span> : null}
      </span>
      {running && elapsed !== undefined && elapsed >= AI_CLOCK_AFTER_MS ? <span className="ai-delegation-clock">{formatAiClock(elapsed)}</span> : null}
      <span className="ai-delegation-status">{status}</span>
      <ChevronRight size={14} className={`ai-detail-chevron${expanded ? " is-open" : ""}`} aria-hidden />
    </button>
    {/* 子代理已升级为独立会话：这里给一个直达入口，与右栏子代理列表同源。 */}
    {agent && onOpenAgent ? <button type="button" className="ai-delegation-open"
      title={t("ai.agent.open")} aria-label={t("ai.agent.open")}
      onClick={() => onOpenAgent(agent.sessionId)}>
      {t("ai.agent.open")}<ArrowUpRight size={12} aria-hidden />
    </button> : null}
    {expanded ? <div className="ai-delegation-detail">
      {subagents?.length ? <div className="ai-delegation-timeline">
        {subagents.map((child) => {
          if (child.kind === "tool") return <AiToolCall key={child.id} entry={child} />;
          if (child.kind === "assistant" && child.text.trim()) {
            return <div key={child.id} className="ai-delegation-text">
              <AiMarkdown text={child.text} streaming={running && child === lastAssistant} />
            </div>;
          }
          if (child.kind === "reasoning" && child.text.trim()) {
            return <details key={child.id} className="ai-reasoning">
              <summary className="ai-row-head"><Brain size={13} aria-hidden className="ai-entry-icon" /><span aria-hidden className="ai-entry-dot" /><span className="ai-row-label">{t("ai.chat.reasoning")}</span><span className="ai-reasoning-title">{child.text.split(/\r?\n/).find((line) => line.trim()) ?? ""}</span><ChevronRight className="ai-detail-chevron" size={14} aria-hidden /></summary>
              <AiMarkdown text={child.text} />
            </details>;
          }
          return null;
        })}
      </div> : null}
      {prompt ? <><p className="ai-delegation-label">{t("ai.tool.delegationTask")}</p><pre>{prompt}</pre></> : null}
      {entry.output !== undefined ? <><p className="ai-delegation-label">{t("ai.tool.delegationResult")}</p><pre className="ai-tool-output">{show(entry.output)}</pre></> : null}
      {(() => { const meta = describeAiTool(entry); return meta.exitCode !== undefined || meta.durationMs !== undefined ? <div className="ai-tool-execution-meta">{meta.exitCode !== undefined ? <span>{t("ai.chat.exitCode")}: {meta.exitCode}</span> : null}{meta.durationMs !== undefined ? <span>{t("ai.tool.duration")}: {(meta.durationMs / 1000).toFixed(2)} s</span> : null}</div> : null; })()}
    </div> : null}
  </div>;
}

/**
 * 行尾数字列（对照参考实现的 RowFigure）：编辑行给 `+N −N`，命令行给退出码或
 * 运行时钟，读取给行数。运行时钟与参考同一条规矩——不足 10 秒不显示，数字跳得
 * 太快只是噪音；计时基准是前端第一次看到这条条目的时刻。
 */
function AiToolFigure({ entry, view }: { entry: AiEntry; view: ToolView }) {
  const { t } = useI18n();
  const running = entry.status === "running";
  const elapsed = useAiElapsed(running, entry.id);
  if (running) {
    return elapsed !== undefined && elapsed >= AI_CLOCK_AFTER_MS
      ? <span className="ai-tool-status is-clock" title={t("ai.tool.duration")}>{formatAiClock(elapsed)}</span>
      : null;
  }
  if (view.exitCode !== undefined && view.exitCode !== 0) {
    return <span className="ai-tool-status">exit {view.exitCode}</span>;
  }
  if (view.durationMs !== undefined && view.durationMs >= AI_CLOCK_AFTER_MS) {
    return <span className="ai-tool-status is-clock">{formatAiClock(view.durationMs)}</span>;
  }
  return null;
}

/** 折叠时不构造文件 diff 和完整 JSON，避免每个流式事件重做大文件工作。 */
export const AiToolCall = memo(function AiToolCall({ entry, subagents, hasRequest, agent, onOpenAgent }: { entry: AiEntry; subagents?: AiEntry[]; hasRequest?: boolean; agent?: { sessionId: string }; onOpenAgent?: (id: string) => void }) {
  const { t } = useI18n();
  const view = describeAiTool(entry, false);
  const fileEdit = ["edit", "add", "delete", "move"].includes(view.kind);
  const phase = entry.status ?? "pending";
  const defaultOpen = phase === "running" && (fileEdit || view.kind === "command");
  const [disclosure, setDisclosure] = useState<{ phase: string; open: boolean } | null>(null);
  // 手动开关只属于当前状态阶段；离开 running 后旧选择失效，完成项立即恢复默认折叠。
  const open = disclosure?.phase === phase ? disclosure.open : defaultOpen;
  if (DELEGATION_TOOL.test(entry.name ?? "")) return <AiDelegationCard entry={entry} subagents={subagents} agent={agent} onOpenAgent={onOpenAgent} />;
  // 历史里的提问工具（没有请求卡的那份记录）才按问答记录渲染；实时里请求卡和工具条目
  // 是同一次提问的两条协议记录，这里再画一张就是「显示两次」——有请求卡就让位。
  if (QUESTION_TOOL.test(entry.name ?? "") && questionToolItems(entry).length) {
    if (hasRequest) return null;
    return <div className={`ai-tool is-${entry.status ?? "pending"}`}>
      <AiQuestionRecord entry={entry} />
    </div>;
  }
  const status = entry.status === "failed" ? t("ai.runtime.failed") : entry.status === "cancelled" ? t("ai.runtime.cancelled") : "";
  return <details className={`ai-tool is-${entry.status ?? "pending"}`} data-kind={view.kind} open={open}
    onToggle={(event) => setDisclosure({ phase, open: event.currentTarget.open })}>
    <summary className="ai-row-head">
      {/* 命令行与思考行使用同一阅读顺序：类型 → 箭头 → 摘要。 */}
      <AiToolSummary entry={entry} disclosure={view.kind === "command"
        ? <ChevronRight className="ai-detail-chevron" size={14} aria-hidden />
        : null} />
      <AiToolFigure entry={entry} view={view} />
      {status ? <span className="ai-tool-status">{status}</span> : null}
      {view.kind !== "command" ? <ChevronRight className="ai-detail-chevron" size={14} aria-hidden /> : null}
    </summary>
    {open ? <AiToolDetails entry={entry} /> : null}
  </details>;
});

/** 展开才序列化的大块内容：JSON/代码按语言高亮（复用聊天那套 hljs），认不出的语言保持素文本。 */
export function CodeText({ text, lang, startLine }: { text: string; lang?: string; startLine?: number }) {
  const clean = (lang || "").trim().split(/\s+/)[0].toLowerCase();
  const html = useMemo(() => clean && hljs.getLanguage(clean) ? renderCodeBlock(text, clean, undefined, false, startLine ?? 1) : null, [text, clean, startLine]);
  return html
    ? <div className="ai-tool-source-code" dangerouslySetInnerHTML={{ __html: html }} />
    : <pre>{text}</pre>;
}

/** 原始结果可能含整份文件，只有主动展开才序列化；对象值按 JSON 高亮。 */
function RawDetails({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  const lang = value !== null && typeof value === "object" ? "json" : undefined;
  return <details className="ai-tool-raw" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{label}</summary>{open ? <CodeText text={show(value)} lang={lang} /> : null}</details>;
}

/**
 * 工具行的摘要文字，按场景分形态（对照参考实现的 command/edit/explore 行）：
 * 命令行走等宽截断、编辑行带 `L44–46` 行号、读取/搜索带可点路径。
 * `icon` 为假时不画行内图标——过程行里状态环就是唯一图形，再叠一枚图标是重复。
 */
export function AiToolSummary({ entry, icon = true, disclosure }: { entry: AiEntry; icon?: boolean; disclosure?: ReactNode }) {
  const { t } = useI18n();
  const view = useMemo(() => describeAiTool(entry, false), [entry]);
  const running = entry.status === "running";
  // 读取行数与改动增减行数（支持流式生成中动态变化）
  const readLines = useMemo(() => view.kind === "read" ? toolReadLines(entry, view) : undefined, [entry, view]);
  const diffCounts = useMemo(() => ["edit", "add", "delete", "move"].includes(view.kind) ? toolLiveDiffCounts(entry, view) : undefined, [entry, view]);
  // 提问工具的摘要是第一个问题正文，不是工具名——行上那两个字该说的是「问了什么」。
  const questionSummary = QUESTION_TOOL.test(entry.name ?? "") ? questionToolItems(entry)[0]?.question : undefined;
  const Icon = questionSummary ? MessageCircleQuestionMark
    : view.kind === "read" ? FileText : view.kind === "search" ? Search : view.kind === "list" ? FolderOpen : ["edit", "add", "delete", "move"].includes(view.kind) ? FilePenLine : Terminal;
  const target = summaryTarget(view);
  const single = view.patches.length <= 1 && view.actions.length <= 1;
  const range = single && ["edit", "add", "delete", "move"].includes(view.kind) ? toolLineRange(view) : null;
  const commandText = view.kind === "command" ? view.summary : "";
  // 目标形态：读取与改动文件为 inline，光标呈现指针样式；
  // 在 summary 内部作为普通文本节点呈现，点击文件标题将直接跟随 summary 原生逻辑就地切换折叠/展开，
  // 避免嵌套 button 拦截事件导致折叠失效。目录类目标（列目录/搜索根）为纯文本。
  const targetKind = ["list", "search"].includes(view.kind) ? "plain" : "inline";
  const TargetTitle = ({ children }: { children: ReactNode }) => (
    <span
      className={targetKind === "inline" ? "ai-file-target ai-tool-name" : "ai-tool-name"}
      title={target ? `${target.path}${target.line !== undefined ? `:${target.line}` : ""}` : undefined}
    >
      {children}
    </span>
  );
  return <>
    {/* ai-tool-glyph：活动导轨上的行不需要这枚图标（环就是图形），CSS 在导轨内隐藏它。 */}
    {icon ? <Icon className="ai-tool-glyph" size={13} aria-hidden /> : null}
    <span className="ai-row-label">{t(`ai.tool.${view.kind}`)}</span>
    {disclosure}
    {/* 读取文件：在文件名签名/前面显示读取的行数（如 128 行） */}
    {readLines !== undefined ? (
      <span className="ai-tool-inline-badge is-read">
        {t("ai.chat.exploreLines", { count: readLines })}
      </span>
    ) : null}
    {/* 修改文件：在文件名前面显示增减行数，流式修改中支持实时动态变化 */}
    {diffCounts ? (
      <span className={`ai-tool-inline-badge is-edit${running ? " is-live" : ""}`}>
        <span className="is-add">+{diffCounts.additions}</span>
        <span className="is-delete">−{diffCounts.deletions}</span>
      </span>
    ) : running && ["edit", "add", "delete", "move"].includes(view.kind) ? (
      <span className="ai-tool-inline-badge is-edit is-live">
        <span className="is-add">+0</span>
        <span className="is-delete">−0</span>
      </span>
    ) : null}
    {questionSummary ? <span className="ai-tool-name" title={questionSummary}>{questionSummary}</span>
      : commandText ? (view.summary === commandText
        // 没有描述：行上就是命令本身。
        ? <code className="ai-tool-cmd" dir="ltr" title={commandText}>{commandText}</code>
        // 有描述：行上说用途，悬浮提示给完整命令。
        : <span className="ai-tool-name" title={commandText}>{view.summary}</span>)
      : target
        ? <TargetTitle>{view.summary}{range?.start !== undefined
          ? ` L${range.start}${range.end !== undefined && range.end !== range.start ? `–${range.end}` : ""}`
          : ""}</TargetTitle>
        : <span className="ai-tool-name" title={view.summary}>{view.summary}{range?.start !== undefined
          ? ` L${range.start}${range.end !== undefined && range.end !== range.start ? `–${range.end}` : ""}`
          : ""}</span>}
  </>;
}

/** Grep 类输出的 `路径:行:内容` 行拆成按文件分组的命中列表（对照参考实现），行不跳编辑器。 */
function SearchHits({ output }: { output: string }) {
  const groups = useMemo(() => {
    const map = new Map<string, Array<{ line: string; text: string }>>();
    for (const raw of output.split(/\r?\n/)) {
      // 惰性量词从最短处起试：Windows 盘符路径里唯一满足 `:数字:` 的就是行号。
      const hit = /^(.+?):(\d+):(.*)$/.exec(raw.trim());
      if (!hit) continue;
      const list = map.get(hit[1]) ?? [];
      list.push({ line: hit[2], text: hit[3] });
      map.set(hit[1], list);
    }
    return [...map.entries()];
  }, [output]);
  if (!groups.length) return <pre className="ai-tool-output">{output}</pre>;
  return <div className="ai-search-hits">
    {groups.map(([file, hitsForFile]) => <div key={file} className="ai-search-hits-file">
      <header><FileText size={12} aria-hidden />{file}<span>{hitsForFile.length}</span></header>
      {hitsForFile.map((hit, index) => <div key={index} className="ai-search-hits-row"><span className="ai-line-number">{hit.line}</span><code>{hit.text}</code></div>)}
    </div>)}
  </div>;
}

/** 明细卡里的一节：题头图标 + 标题（可为可点路径）；审批卡与工具明细共用同一套分块视觉。 */
function ToolSection({ title, children }: { title: ReactNode; children: ReactNode }) {
  return <section className="ai-tool-section">
    <header><Terminal size={13} aria-hidden />{title}</header>
    {children}
  </section>;
}

interface SplitRow { left?: ReturnType<typeof parseToolDiff>[number]; right?: ReturnType<typeof parseToolDiff>[number] }

/** unified diff → 左右两栏的行对：删除行先攒着，遇到添加行配成对，上下文两侧同现。 */
function toSplitRows(lines: ReturnType<typeof parseToolDiff>): SplitRow[] {
  const rows: SplitRow[] = [];
  const pending: ReturnType<typeof parseToolDiff> = [];
  const flush = () => { while (pending.length) rows.push({ left: pending.shift() }); };
  for (const line of lines) {
    if (line.kind === "header") { flush(); rows.push({ left: line, right: line }); continue; }
    if (line.kind === "delete") pending.push(line);
    else if (line.kind === "add") rows.push({ left: pending.shift(), right: line });
    else { flush(); rows.push({ left: line, right: line }); }
  }
  flush();
  return rows;
}

/** 补丁明细的 diff：Git 面板同款 Monaco DiffEditor（行内/分栏跟随全局偏好）。 */
function PatchDiff({ diff, path }: { diff: string; path: string }) {
  const [mode] = useAiDiffViewMode();
  return <div className="ai-patch-diff"><AiDiffEditor diff={diff} path={path} sideBySide={mode === "split"} /></div>;
}

/** unified diff 行的首字符就是 +/-/空格 符号：拆开单独染色，正文去掉前缀（git 网页端惯例）。 */
function DiffCode({ text, kind }: { text: string; kind: string }) {
  if (kind === "add" || kind === "delete") {
    return <><span className="ai-diff-sign" aria-hidden="true">{text.charAt(0)}</span><code>{text.slice(1)}</code></>;
  }
  return <code>{text}</code>;
}

function DiffLineView({ line, side }: { line: SplitRow["left"]; side: "old" | "new" }) {
  if (!line) return <div className="ai-tool-diff-line is-filler" />;
  const number = side === "old" ? line.oldLine : line.newLine;
  return <div className={`ai-tool-diff-line is-${line.kind === "header" ? "hunk" : side === "old" ? line.kind === "add" ? "filler" : line.kind : line.kind === "delete" ? "filler" : line.kind}`}>
    {line.kind === "header"
      ? <code>{line.text}</code>
      : <><span className="ai-line-number">{number ?? ""}</span><DiffCode text={line.text} kind={side === "old" ? line.kind === "add" ? "filler" : line.kind : line.kind} /></>}
  </div>;
}

/** 分栏视图：两列各自滚动，滚动位置互相跟随（对照参考的 useSyncedScroll）。 */
function SplitDiff({ lines }: { lines: ReturnType<typeof parseToolDiff> }) {
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const rows = useMemo(() => toSplitRows(lines), [lines]);
  const sync = (from: HTMLDivElement, to: HTMLDivElement | null) => {
    if (syncing.current || !to) return;
    syncing.current = true;
    to.scrollTop = from.scrollTop;
    window.requestAnimationFrame(() => { syncing.current = false; });
  };
  return <div className="ai-tool-diff is-split" role="region">
    <div className="ai-tool-diff-col" ref={left} onScroll={(event) => sync(event.currentTarget, right.current)}>
      {rows.map((row, index) => <DiffLineView key={index} line={row.left} side="old" />)}
    </div>
    <div className="ai-tool-diff-col" ref={right} onScroll={(event) => sync(event.currentTarget, left.current)}>
      {rows.map((row, index) => <DiffLineView key={index} line={row.right} side="new" />)}
    </div>
  </div>;
}

/** 大 diff 的起步渲染量与步进（对照参考实现：先 240 行，按钮每次再放 400）。 */
const DIFF_FIRST = 240;
const DIFF_STEP = 400;

export function ToolDiff({ text }: { text: string }) {
  const { t } = useI18n();
  const lines = useMemo(() => parseToolDiff(text), [text]);
  const [mode, setMode] = useAiDiffViewMode();
  const [count, setCount] = useState(DIFF_FIRST);
  const shown = lines.slice(0, count);
  return <div className="ai-tool-diff-wrap" role="region" aria-label={t("ai.tool.diff")}>
    <div className="ai-tool-diff-tools" role="group" aria-label={t("ai.tool.diff")}>
      <button type="button" className={`ai-diff-mode${mode === "inline" ? " is-on" : ""}`} role="radio" aria-checked={mode === "inline"} onClick={() => setMode("inline")}>{t("ai.tool.diffInline")}</button>
      <button type="button" className={`ai-diff-mode${mode === "split" ? " is-on" : ""}`} role="radio" aria-checked={mode === "split"} onClick={() => setMode("split")}>{t("ai.tool.diffSplit")}</button>
    </div>
    {mode === "split" ? <SplitDiff lines={shown} /> : <div className="ai-tool-diff">
      {shown.map((line, index) => line.kind === "header"
        ? <div key={index} className="ai-tool-diff-line is-hunk"><code>{line.text}</code></div>
        : <div key={index} className={`ai-tool-diff-line is-${line.kind}`}><span className="ai-line-number">{line.oldLine ?? ""}</span><span className="ai-line-number">{line.newLine ?? ""}</span><DiffCode text={line.text} kind={line.kind} /></div>)}
    </div>}
    {lines.length > count ? <button type="button" className="ai-text-button" onClick={() => setCount((n) => n + DIFF_STEP)}>{t("ai.tool.more")}</button> : null}
  </div>;
}

interface AiToolDetailsProps {
  /** 要展开的工具条目，从 `input` / `output` 里挑已知字段渲染。 */
  entry: AiEntry;
}

/**
 * 工具调用的明细：命令、路径、改动前后、原始参数与输出。
 *
 * 各 CLI 的工具入参结构不统一，所以这里按已知字段名逐个试探；
 * 一个都认不出时退回展示整份 JSON，保证信息不丢。
 */
export default function AiToolDetails({ entry }: AiToolDetailsProps) {
  const { t } = useI18n();
  const view = describeAiTool(entry);
  const known = !!view.command || !!view.source || view.actions.length > 0 || view.patches.length > 0;
  return <div className="ai-tool-details">
    {view.cwd ? <div className="ai-tool-path">{t("ai.tool.cwd")} · {view.cwd}</div> : null}
    {view.command ? <ToolSection title={t("ai.tool.command")}><CodeText text={view.command} lang="bash" /></ToolSection> : null}
    {/* 单文件读取已在摘要行带全「路径 + 行范围」，「动作」分节再写一遍就是套娃。 */}
    {view.actions.length && !(view.source && view.actions.length === 1) ? <ToolSection title={t("ai.tool.actions")}>
      {view.actions.map((action, index) => <div key={index} className="ai-tool-path"><strong>{t(`ai.tool.${action.kind}`)}</strong> · {action.kind === "list" || action.kind === "search"
        // 列目录/搜索的目标是目录：点它去「打开文件」没有意义，按纯文字展示。
        ? <span className="ai-tool-target">{action.target}</span>
        : <span className="ai-tool-target">{action.target}</span>}{action.start !== undefined ? `:${action.start}${action.end !== undefined ? `–${action.end}` : ""}` : ""}{action.detail ? ` · ${action.detail}` : ""}</div>)}
    </ToolSection> : null}
    {view.source ? <>
      {/* 单文件读取展开后只有代码本体：路径在摘要行出现过，这里不再重复标题。 */}
      <div className="ai-tool-source-code" dangerouslySetInnerHTML={{ __html: renderCodeBlock(
        view.source.content.split(/\r?\n/).slice(0, view.source.end - view.source.start + 1).join("\n"),
        view.source.path.split(".").pop() || undefined, undefined, false, view.source.start ?? 1) }} />
      {view.source.truncated ? <div className="ai-muted">{t("ai.tool.truncated")}</div> : null}
    </> : null}
    {view.patches.length ? view.patches.map((patch, index) => <section key={index} className="ai-tool-file-change">
      {/* 单补丁不再套「文件改动」分节与补丁头——路径已在一级修改行上，三层说一件事是套娃；
          多补丁（多文件）时才保留每文件的路径头作分组。 */}
      {view.patches.length > 1 ? <header className="ai-tool-path"><strong>{t(`ai.tool.${patch.kind}`)}</strong> · <span className="ai-tool-target">{patch.path}</span>{patch.destination ? <> → <span className="ai-tool-target">{patch.destination}</span></> : ""}{patch.proposed ? <small> · {t("ai.tool.proposed")}</small> : ""}</header> : null}
      {patch.diff ? <PatchDiff diff={patch.diff} path={patch.path} /> : <>{patch.before !== undefined ? <CodeText text={patch.before} lang={patch.path.split(".").pop()} startLine={patch.start} /> : null}{patch.after !== undefined ? <CodeText text={patch.after} lang={patch.path.split(".").pop()} startLine={patch.start} /> : null}</>}
    </section>) : null}
    {!known && entry.input !== undefined ? <CodeText text={show(entry.input)} lang={entry.input !== null && typeof entry.input === "object" ? "json" : undefined} /> : null}
    {/* 已有结构化视图（读取内容/补丁/命中列表/命令）的条目不再附「完整参数 / 结构化结果」
        折叠块：那是同一段数据的 JSON 原文，视图失真需要核对原始数据时才有价值；
        认不出结构的条目（known 为假）仍给原文兜底。 */}
    {known && !view.source && view.kind !== "search" ? <RawDetails label={t("ai.chat.rawInput")} value={entry.input} /> : null}
    {entry.output !== undefined && !view.source ? (view.kind === "search" ? <SearchHits output={show(entry.output)} /> : <pre className="ai-tool-output">{show(entry.output)}</pre>) : null}
    {view.exitCode !== undefined || view.durationMs !== undefined ? <div className="ai-tool-execution-meta">{view.exitCode !== undefined ? <span>{t("ai.chat.exitCode")}: {view.exitCode}</span> : null}{view.durationMs !== undefined ? <span>{t("ai.tool.duration")}: {(view.durationMs / 1000).toFixed(2)} s</span> : null}</div> : null}
    {entry.result !== undefined && !view.source && view.kind !== "search" ? <RawDetails label={t("ai.tool.structuredResult")} value={entry.result} /> : null}
  </div>;
}

/** 浏览类的行内聚类判定（供过程组把连续 read/search/list 归成一组）。 */
export function isExploreEntry(entry: AiEntry): boolean {
  if (entry.kind !== "tool") return false;
  const kind = describeAiTool(entry, false).kind;
  return kind === "read" || kind === "search" || kind === "list";
}

/**
 * 连续的读取/搜索/列目录折成一条「浏览 · N 文件 · M 搜索」组行（对照参考实现的
 * Explored 组行）：组内子行保持各自的行级状态与可展开明细，运行中的子行使整组摊开。
 */
export const AiExploreGroup = memo(function AiExploreGroup({ entries, render }: { entries: AiEntry[]; render: (entry: AiEntry) => ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<boolean | null>(null);
  const active = entries.some((entry) => entry.status === "running");
  const expanded = open ?? active;
  const { files, searches } = useMemo(() => {
    let files = 0;
    let searches = 0;
    for (const entry of entries) {
      const kind = describeAiTool(entry, false).kind;
      if (kind === "search") searches += 1;
      else files += 1;
    }
    return { files, searches };
  }, [entries]);
  return <div className={`ai-explore-group${active ? " is-active" : ""}${expanded ? " is-open" : ""}`}>
    <button type="button" className="ai-row-head ai-explore-head" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
      <Layers size={13} aria-hidden className="ai-tool-glyph" />
      <span className="ai-row-label">{t("ai.chat.exploredTitle")}</span>
      <span className="ai-explore-count">{[files ? t("ai.chat.exploreFiles", { count: files }) : "", searches ? t("ai.chat.exploreSearches", { count: searches }) : ""].filter(Boolean).join(" · ")}</span>
      <ChevronRight size={14} className={`ai-detail-chevron${expanded ? " is-open" : ""}`} aria-hidden />
    </button>
    {expanded ? <div className="ai-explore-children">{entries.map(render)}</div> : null}
  </div>;
});
