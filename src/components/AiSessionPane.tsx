import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Archive, Bot, Brain, Check, CheckCircle2, ChevronLeft, ChevronUp, CircleAlert, CircleDashed, ChevronDown, ChevronRight, ChevronsUp, Command, Copy, EllipsisVertical, EyeOff, FilePenLine, FilePlus2, FolderClosed, GripVertical, History, ListOrdered, Loader2, Paperclip, Pause, Pencil, Pin, PinOff, Plane, Play, Plus, Send, Settings, Square, Target, Timer, Trash2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import AiApprovalCard from "./AiApprovalCard";
import AiChatWidthHandles from "./AiChatWidthHandles";
import AiImageDialog from "./AiImageDialog";
import AiJumpToBottom from "./AiJumpToBottom";
import AiMarkdown from "./AiMarkdown";
import AiProcessGroup from "./AiProcessGroup";
import { AiQuestionCard, AiQuestionResult } from "./AiQuestionCard";
import AiProviderIcon from "./AiProviderIcon";
import AiActionDialog from "./AiActionDialog";
import { useI18n } from "../i18n";
import { AI_NAMES, cliDesktopAvailable } from "../lib/aiCli";
import { assetUrl } from "../lib/fs";
import { aiArrival, aiArrivalOf, formatAiClock, formatAiSeconds, useAiElapsed } from "../lib/aiClock";
import { useAiChatWidth } from "../lib/aiChatWidth";
import { compactionFacts } from "../lib/aiCompaction";
import { clearQueuedAiTasks, decideAiPlan, deferAiPlan, editQueuedAiTask, loadAiCapabilities, loadAiMessages, loadAiMessagesThrough, loadAiOutline, loadOlderAiMessages, moveQueuedAiTask, respondAiRequest, runQueuedAiTaskNow, sendAiAgentMessage, sendAiMessage, setAiGoalStatus, stopAiRun, useAiOutline, useAiOwnedQueuedRunIds, useAiOwnedRunId, useAiRuntime, useAiSessionActivity } from "../lib/aiRuntime";
import type { AiEntry, AiOutlineSnapshot, AiRequest, AiRunOptions, AiCommandIntent, AiThreadGoal } from "../lib/aiRuntime";
import { buildNavRows, NAV_PAGE, navCount, visibleNavRows } from "../lib/aiMessageNav";
import type { AiNavRow } from "../lib/aiMessageNav";
import AiPlanApproval, { AiPlanEntry } from "./AiPlanCard";
import { AiAgentDockPanel, AiTaskListDockPanel } from "./AiDockPanels";
import { useAiDockSlots } from "./AiDockSlots";
import { openAiPlan } from "../lib/aiPlan";
import { requestPath } from "../lib/aiApprovals";
import type { AiPermissionAnswer } from "../lib/aiApprovals";
import { commandSuggestions, completeCommand, filterCommandSuggestions, localCommand, parseSlash, resolveNativeCommand } from "../lib/aiCommands";
import { browseCancel, browseDown, browseTyped, browseUp, caretOnFirstLine, caretOnLastLine, clearDraft, loadAdditionalDirs, loadDraft, loadPromptHistory, rememberPrompt, saveAdditionalDirs, saveDraft } from "../lib/aiDrafts";
import type { PromptBrowse } from "../lib/aiDrafts";
import { compactDecision, COMPACT_COMMAND_TEXT, readCompactPrefs, writeCompactPrefs } from "../lib/aiCompact";
import { isNearBottom, OlderHistoryScroll, trackFollow, unseenCount } from "../lib/aiFollow";
import type { FollowAnchor } from "../lib/aiFollow";
import { conversationItems, groupAiTimeline, liveThinking, TIMELINE_WINDOW, windowAiTimeline } from "../lib/aiTimeline";
import { registerDropOwner } from "../lib/dropOwner";
import { collectPastedImages } from "../lib/aiClipboard";
import Popover from "./Popover";
import { takeAiDraftHandoff } from "../lib/aiDraftSession";
import { refreshAiSessionHistory } from "../hooks/useAiSessions";
import { useCollapsibleOverflow } from "../hooks/useCollapsibleOverflow";
import { aiQueueOrder, isAiTaskTerminal } from "../lib/aiTaskStatus";
import type { AiComposerHandle } from "./AiComposerOptions";
import AiComposerOptions from "./AiComposerOptions";
import AiComposerShell from "./AiComposerShell";
import AiCommandMenu from "./AiCommandMenu";
import AiMentionMenu from "./AiMentionMenu";
import { applyMention, mentionAt, mentionPathOf, splitMentionTokens } from "../lib/aiMention";
import { findFiles } from "../lib/fs";
import AiContextChip from "./AiContextChip";
import { aiNormalMode, loadAiOptions, saveAiOptions } from "../lib/aiOptions";
import AiToolDetails, { AiToolCall, AiToolSummary, CodeText } from "./AiToolDetails";
import AiDiffEditor from "./AiDiffEditor";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor } from "./ContextMenu";
import { useAiInputMenu } from "./AiInputContext";
import { useAiDiffViewMode } from "../lib/aiDiffView";
import { AiOpenFileProvider, type AiOpenFile } from "./AiFileLink";
import { aiSessionStorageKey } from "../lib/aiSessions";
import type { AiSession, AiSessionAction } from "../lib/aiSessions";
import { watchAiInputDelivery } from "../lib/aiInputBridge";
import { summarizeAiFileEdits, type AiEditSummary, type AiEditedFile } from "../lib/aiTools";

interface PastedImage { path: string; preview: string; name: string }
/** 选择器里的筛选提示；真正认格式的是后端的文件头嗅探，扩展名写错也骗不过去。 */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
const detail = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2);

/** 触发方式：只认两家 CLI 都会给的这两个词，认不出的照原样浮出——不猜，也不丢。 */
const COMPACTION_TRIGGERS: Record<string, "ai.chat.compactionTriggerManual" | "ai.chat.compactionTriggerAutomatic"> = {
  manual: "ai.chat.compactionTriggerManual",
  auto: "ai.chat.compactionTriggerAutomatic",
  automatic: "ai.chat.compactionTriggerAutomatic",
};

/**
 * 压缩摘要正文：裁到固定高度，只有真被裁掉了底部才出现展开/收起页脚
 * （对照参考实现的 CompactionSummaryBody）。
 */
function AiCompactionSummaryBody({ id, text }: { id: string; text: string }) {
  const { t } = useI18n();
  const { contentRef, isOverflowing, expanded, toggle } = useCollapsibleOverflow<HTMLDivElement>(text);
  return <div id={id} className="ai-compaction-summary">
    <div ref={contentRef} className={`ai-compaction-summary-body${expanded ? "" : " is-clipped"}${!expanded && isOverflowing ? " is-faded" : ""}`}>
      <AiMarkdown text={text} />
    </div>
    {isOverflowing ? <button type="button" className="ai-compaction-summary-more" onClick={toggle} aria-expanded={expanded}>
      {t(expanded ? "ai.chat.collapseMessage" : "ai.chat.expandMessage")}
      {expanded ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
    </button> : null}
  </div>;
}

/**
 * 压缩分割线（对照参考实现的 ContextCompactionCard）：居中的一道无框分割线，左右渐隐的
 * 横线夹着「图标 + 状态 + token 差值 + 耗时」，摘要开关就在这一行里。它是会话里的一道
 * 分界标记——「这里压缩过」——不是一次工具调用，所以不给卡片外壳。
 *
 * 摘要默认折叠，分界线因此始终只占一行。触发方式浮在 title 里：它回答的是「为什么会
 * 这样」，比 token 差值次一级。耗时只报 CLI 自己给的，不拿前端看到两个状态的时刻差
 * 去冒充。数字认不出就不显示——没有数字比编一个数字好。
 */
const AiCompactionDivider = memo(function AiCompactionDivider({ entry }: { entry: AiEntry }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const facts = compactionFacts(entry);
  // 前后相等就不是真压缩掉了什么，退回不带数字的说法，别让人以为出了 bug。
  const label = facts.failed ? t("ai.chat.compactionFailed")
    : facts.running ? t("ai.chat.compactionRunning")
    : facts.before !== undefined && facts.after !== undefined && facts.before !== facts.after
      ? t("ai.chat.compactionTokens", { before: facts.before.toLocaleString(), after: facts.after.toLocaleString() })
      : t("ai.chat.compactionCompleted");
  const triggerKey = facts.trigger ? COMPACTION_TRIGGERS[facts.trigger.toLowerCase()] : undefined;
  const duration = !facts.running && facts.durationMs !== undefined ? formatAiSeconds(facts.durationMs) : null;
  return <div className="ai-compaction-container">
    <div className={`ai-compaction-notice${facts.failed ? " is-failed" : facts.running ? " is-running" : " is-completed"}`}
      role="status" title={triggerKey ? t(triggerKey) : facts.trigger}>
      <Archive size={13} aria-hidden />
      <span className={facts.running ? "ai-activity-shimmer" : undefined}>{label}</span>
      {duration ? <span className="ai-compaction-duration">· {duration}</span> : null}
      {facts.summary ? <button type="button" className="ai-compaction-toggle" aria-expanded={open}
        aria-controls={open ? bodyId : undefined} onClick={() => setOpen((value) => !value)}>
        {t("ai.chat.compactionSummary")}
        {open ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
      </button> : null}
    </div>
    {facts.summary && open ? <AiCompactionSummaryBody id={bodyId} text={facts.summary} /> : null}
  </div>;
});

/** 一条改动快照：批准写入工具或恢复动作时生成，列出文件并提供一键恢复。 */
const AiCheckpointNotice = memo(function AiCheckpointNotice({ entry, onRestore }: { entry: AiEntry; onRestore?: (id: string) => void }) {
  const { t } = useI18n();
  const data = entry.input && typeof entry.input === "object" && !Array.isArray(entry.input) ? entry.input as Record<string, unknown> : {};
  const id = typeof data.id === "string" ? data.id : "";
  const files = Array.isArray(data.files) ? data.files.filter((file): file is string => typeof file === "string") : [];
  if (!id || files.length === 0) return null;
  const isRestore = data.source === "restore";
  const restoreOf = typeof data.restoreOf === "string" ? data.restoreOf : null;
  return <section className="ai-checkpoint" data-checkpoint-id={id}>
    <span className="ai-checkpoint-icon" aria-hidden><History size={14} /></span>
    <div className="ai-checkpoint-body">
      <strong>{isRestore ? t("ai.checkpoint.restored") : t("ai.checkpoint.title")}</strong>
      {restoreOf ? <small>{t("ai.checkpoint.restoreOf")}</small> : null}
      <div className="ai-checkpoint-files">
        {files.slice(0, 6).map((file) => <code key={file} title={file}>{file.split(/[\\/]/).pop()}</code>)}
        {files.length > 6 ? <small>+{files.length - 6}</small> : null}
      </div>
    </div>
    {onRestore ? <button type="button" className="button" onClick={() => onRestore(id)}>{t("ai.checkpoint.restore")}</button> : null}
  </section>;
});

const TimelineNotice = memo(function TimelineNotice({ entry, onRestoreCheckpoint }: { entry: AiEntry; onRestoreCheckpoint?: (id: string) => void }) {
  const { t } = useI18n();
  const data = entry.input && typeof entry.input === "object" && !Array.isArray(entry.input) ? entry.input as Record<string, unknown> : {};
  if (entry.name === "checkpoint") return <AiCheckpointNotice entry={entry} onRestore={onRestoreCheckpoint} />;
  if (entry.name === "plan_review" || entry.name === "plan_draft") return <AiPlanEntry entry={entry} />;
  if (entry.name === "plan_decision") {
    const decision = String(data.decision ?? "");
    return <div className="ai-compaction-notice" role="status"><strong>{t("ai.plan.decision")}</strong><span>{t(decision === "approve" ? "ai.plan.decidedApprove" : decision === "requestChanges" ? "ai.plan.decidedChanges" : "ai.plan.decidedDefer")}</span></div>;
  }
  if (entry.name === "compaction") return <AiCompactionDivider entry={entry} />;
  if (entry.name === "task_list" || entry.name === "plan" && Array.isArray(data.plan)) {
    const source = entry.name === "task_list" ? data.items : data.plan;
    const steps = Array.isArray(source) ? source.flatMap((item) => item && typeof item === "object" ? [item as Record<string, unknown>] : []).filter((item) => typeof (item.content ?? item.step) === "string") : [];
    const visible = steps.filter((step) => step.status !== "dropped");
    const completed = visible.filter((step) => step.status === "complete" || step.status === "completed").length;
    return <section className="ai-plan-notice"><header><strong>{t("ai.chat.plan")}</strong><span>{t("ai.runtime.taskCompleted", { count: completed })} / {t("ai.runtime.taskTotal", { count: visible.length })}</span></header>
      <ol role="list">{visible.map((step, index) => <li key={String(step.id ?? index)} className={`is-${String(step.status)}`}>
        <span className="ai-plan-entry-icon" aria-hidden>
          {step.status === "complete" || step.status === "completed" ? <CheckCircle2 size={14} />
            : <CircleDashed size={14} />}
        </span>
        <span className="ai-plan-entry-text">{String(step.content ?? step.step)}{typeof step.detail === "string" && step.detail ? <small>{step.detail}</small> : null}</span>
      </li>)}</ol>
    </section>;
  }
  return <details className="ai-timeline-notice"><summary><ChevronRight className="ai-detail-chevron" size={13} />{entry.name === "retry" ? t("ai.chat.retry") : t("ai.chat.notice")}</summary>{entry.text ? <AiMarkdown text={entry.text} /> : <pre>{detail(entry.input)}</pre>}</details>;
});

const RequestCard = memo(function RequestCard({ request, stopping, onBeforeAllow }: { request: AiRequest; stopping: boolean; onBeforeAllow?: (request: AiRequest) => Promise<void> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState(false);
  /** 提交成功但失效事件还没回来的那一小段，先用这份把结果顶上，卡片不会闪回空白。 */
  const [submitted, setSubmitted] = useState<Record<string, string[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const disabled = !request.active || stopping || busy || answered;
  const toolEntry: AiEntry | null = request.toolName ? { id: `${request.requestId}:tool`, runId: request.runId, kind: "tool", text: "", name: request.toolName, input: request.input } : null;
  const respond = async (answer: AiPermissionAnswer | { answers: Record<string, string[]> }) => {
    setBusy(true); setError(null);
    try {
      // 允许写入类工具之前先落改动前快照：这是恢复链的源头。快照失败不拦批准，
      // CLI 自己的历史还在，但「恢复到此步之前」就没有这一站了。
      if (onBeforeAllow && !("answers" in answer) && answer.allow === true) {
        try { await onBeforeAllow(request); } catch { /* 尽力而为 */ }
      }
      await respondAiRequest(request.runId, request.requestId, answer);
      if ("answers" in answer) setSubmitted(answer.answers);
      setAnswered(true);
    }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const isQuestion = request.kind === "question";
  // 提问卡：还能答才摆交互版；答完或失效就换成结果行（点开看当时选的那几项）。
  // 两种形态不同时出现，也就不会出现「按钮还在、结果也在」的自相矛盾。
  const asking = !isQuestion || (request.active && !answered);
  return <section className={`ai-request-card${isQuestion ? " is-question" : ""}`} aria-label={t(isQuestion ? "ai.runtime.question" : "ai.runtime.permission")}>
    {/* 提问卡自带一行表头（图标 + 标题 + 进度），这里再叠一句同款标题就是同一件事说两遍。 */}
    {isQuestion ? null : <strong>{t("ai.runtime.permission")} · {request.title}</strong>}
    {toolEntry ? <div className="ai-request-tool"><div className="ai-request-tool-title"><AiToolSummary entry={toolEntry} /></div><AiToolDetails entry={toolEntry} /></div> : request.detail ? <pre>{request.detail}</pre> : null}
    {request.reason ? <p className="ai-muted">{request.reason}</p> : null}
    {request.blockedPath ? <code>{request.blockedPath}</code> : null}
    {isQuestion
      ? request.questions.length === 0
        // 后端两家都校验过非空；真到了这里也不该留一个空白壳卡片装作有内容。
        ? <p className="ai-muted">{t("ai.runtime.questionEmpty")}</p>
        : asking
          ? <AiQuestionCard request={request} disabled={disabled} busy={busy} onRespond={(answers) => void respond({ answers })} />
          : <AiQuestionResult request={request} answer={request.answer ?? (submitted ? { answers: submitted } : undefined)} />
      : <>
        <AiApprovalCard request={request} stopping={stopping} busy={busy || answered} onRespond={(answer) => void respond(answer)} />
        {/* 已处理和已失效是两件事：前者是用户答过了，后者是没等到答复这一轮就结束了。
            混成一句「已处理或失效」等于两种情况都说不清。 */}
        {!request.active || answered ? <span className="ai-muted">{t(request.answer || answered ? "ai.runtime.requestAnswered" : "ai.runtime.requestExpired")}</span> : null}
      </>}
    {error ? <p className="ai-error" role="alert">{error}</p> : null}
  </section>;
});

/** 用户消息的长文折叠线：超过这个行数先收起，底部渐隐提示还有更多。 */
const USER_MESSAGE_CLIP_LINES = 18;
const USER_MESSAGE_CLIP_CHARS = 1500;

/** 行首带 `>` 的行算引用（对照参考实现的 quote line）：排进带左线的引用段。 */
const USER_QUOTE_LINE = /^\s*>/;

/** 一行正文里的 @提及：命中就包成小徽章，其余原样。 */
function renderMentions(line: string, lineIndex: number): ReactNode {
  const parts = splitMentionTokens(line);
  if (parts.every((part) => !part.mention)) return line;
  return <Fragment key={`mention-${lineIndex}`}>
    {parts.map((part, index) => part.mention
      ? <span key={index} className="ai-mention">{part.text}</span>
      : <span key={index}>{part.text}</span>)}
  </Fragment>;
}

/** 纯文本按行渲染，引用行聚成一段；换行仍由 pre-wrap 呈现，段内换行归段自己。 */
function renderUserText(text: string): ReactNode[] {
  const lines = text.split("\n");
  const parts: ReactNode[] = [];
  let quote: string[] = [];
  const flushQuote = () => {
    if (quote.length) {
      parts.push(<span key={`quote-${parts.length}`} className="ai-user-quote">{quote.join("\n")}</span>);
      quote = [];
    }
  };
  lines.forEach((line, index) => {
    if (USER_QUOTE_LINE.test(line)) quote.push(line);
    else {
      flushQuote();
      parts.push(renderMentions(line, index));
    }
    const next = lines[index + 1];
    if (next !== undefined && !(USER_QUOTE_LINE.test(line) && USER_QUOTE_LINE.test(next))) parts.push("\n");
  });
  flushQuote();
  return parts;
}

/**
 * 用户消息：右对齐的圆角气泡，图片贴右上；悬停浮出复制按钮。
 *
 * 对照参考实现：正文是纯文本（不走 markdown），过长的消息先按高度收起并留一条
 * 渐隐边，展开后才见全文——一整屏贴进来的日志不会把时间线顶出十屏。
 */
const AiUserMessage = memo(function AiUserMessage({ text, images }: { text: string; images?: { node: ReactNode; key: string }[] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const long = text.split("\n").length > USER_MESSAGE_CLIP_LINES || text.length > USER_MESSAGE_CLIP_CHARS;
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }, () => { /* 剪贴板被拒就保持原样，不谎报已复制。 */ });
  };
  return <div className="ai-user-msg">
    {images?.length ? <div className="ai-user-msg-images">{images.map((image) => <span key={image.key}>{image.node}</span>)}</div> : null}
    {text ? <div className="ai-user-msg-row">
      <button type="button" className="ai-user-msg-copy" aria-label={copied ? t("action.copied") : t("action.copy")}
        title={copied ? t("action.copied") : t("action.copy")} onClick={copy}>
        {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      </button>
      <div className={`ai-user-msg-bubble${long && !expanded ? " is-clipped" : ""}`}>
        <p>{renderUserText(text)}</p>
        {long && !expanded ? <button type="button" className="ai-user-msg-expand" onClick={() => setExpanded(true)}>{t("ai.chat.expandMessage")}</button> : null}
      </div>
    </div> : null}
    {long && expanded ? <button type="button" className="ai-user-msg-expand" onClick={() => setExpanded(false)}>{t("ai.chat.collapseMessage")}</button> : null}
  </div>;
});

/** 思考只在当前生成阶段自动展开；阶段结束后收起，历史正文仍可由用户手动打开。 */
const AiReasoningEntry = memo(function AiReasoningEntry({ entry, live }: { entry: AiEntry; live: boolean }) {
  const { t } = useI18n();
  const phase = live ? "running" : "completed";
  const [disclosure, setDisclosure] = useState<{ phase: string; open: boolean } | null>(null);
  const open = disclosure?.phase === phase ? disclosure.open : live;
  const lines = entry.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const title = live ? lines.at(-1) ?? "" : lines[0] ?? "";
  return <details className="ai-reasoning" open={open}
    onToggle={(event) => setDisclosure({ phase, open: event.currentTarget.open })}>
    <summary className="ai-row-head">
      <Brain size={13} aria-hidden className="ai-entry-icon" />
      <span aria-hidden className="ai-entry-dot" />
      <span className="ai-row-label">{t(live ? "ai.chat.reasoningLive" : "ai.chat.reasoning")}</span>
      <ChevronRight className="ai-detail-chevron" size={14} aria-hidden />
      {entry.text ? <span className="ai-reasoning-title" aria-hidden={live ? "true" : undefined}>{title}</span> : null}
    </summary>
    <AiMarkdown text={entry.text} />
  </details>;
});

interface FloatingPos {
  left: number;
  top: number;
}

/**
 * 消息导航的拖拽状态：展开后可在会话视口内移动，收起后始终贴住右缘并垂直居中。
 * 位移超过 3px 才视为拖拽，避免松手时误触发展开或收起。
 */
function useFloatingMessageNav(open: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState<FloatingPos | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    initialLeft: number;
    initialTop: number;
    moved: boolean;
  } | null>(null);

  // 未拖拽时折叠态和展开态都由 CSS 用组件中心点对齐内容中线；
  // 折叠后丢弃手动位置，下次展开恢复真正的垂直居中。
  useLayoutEffect(() => {
    if (!open) setPanelPos(null);
  }, [open]);

  const startDrag = (event: React.PointerEvent) => {
    // 收起态必须固定在右侧垂直中点，只有展开后的卡片允许拖动。
    if (!open) return;
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    // 面板里的折叠、重试和导航按钮保留自己的点击行为。
    if (open && target.closest("button")) return;
    const container = containerRef.current;
    if (!container) return;
    const parent = container.parentElement;
    const parentRect = parent?.getBoundingClientRect() ?? document.body.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      initialLeft: containerRect.left - parentRect.left,
      initialTop: containerRect.top - parentRect.top,
      moved: false,
    };

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const deltaX = pointerEvent.clientX - drag.startX;
      const deltaY = pointerEvent.clientY - drag.startY;
      if (!drag.moved && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
        drag.moved = true;
        setIsDragging(true);
      }
      if (!drag.moved) return;
      const parentWidth = parent?.clientWidth ?? window.innerWidth;
      const parentHeight = parent?.clientHeight ?? window.innerHeight;
      const width = container.offsetWidth || 32;
      const height = container.offsetHeight || 32;
      const top = Math.max(8, Math.min(parentHeight - height - 8, drag.initialTop + deltaY));
      const left = Math.max(8, Math.min(parentWidth - width - 8, drag.initialLeft + deltaX));
      setPanelPos({ left, top });
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      window.setTimeout(() => {
        setIsDragging(false);
        dragRef.current = null;
      }, 0);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  // panelPos 只代表用户拖动后的左上角；默认态不能覆盖 CSS 的中心点定位。
  const style: CSSProperties | undefined = open && panelPos
    ? { left: panelPos.left, top: panelPos.top, right: "auto", bottom: "auto", transform: "none" }
    : undefined;

  return { containerRef, style, isDragging, startDrag, isMoved: () => dragRef.current?.moved === true };
}

/**
 * 会话内消息导航：收起时贴在正文右缘，展开后列出各轮用户消息，并可跳到尚未加载的历史轮次。
 */
function AiMessageNav({ entries, outline, hasOlder, onRequestOutline, onJump }: {
  entries: AiEntry[];
  outline: AiOutlineSnapshot;
  hasOlder: boolean;
  onRequestOutline: () => void;
  onJump: (row: AiNavRow) => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [rendered, setRendered] = useState(NAV_PAGE);
  const list = useRef<HTMLDivElement>(null);
  const grewAt = useRef(0);
  const rows = useMemo(() => buildNavRows(entries, outline), [entries, outline]);
  const visible = useMemo(() => visibleNavRows(rows, rendered), [rows, rendered]);
  const count = navCount(rows, outline, hasOlder);
  const { containerRef, style, isDragging, startDrag, isMoved } = useFloatingMessageNav(open);

  useLayoutEffect(() => {
    if (!open) return;
    const element = list.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [open]);
  useLayoutEffect(() => {
    if (!grewAt.current) return;
    const element = list.current;
    if (element) element.scrollTop += element.scrollHeight - grewAt.current;
    grewAt.current = 0;
  }, [visible]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // 轮次索引只在用户第一次展开导航时读取。
    if (next && !outline.loaded && !outline.loading) onRequestOutline();
  };
  const grow = () => {
    const element = list.current;
    if (!element || rows.length <= visible.length || element.scrollTop > 60) return;
    grewAt.current = element.scrollHeight;
    setRendered((value) => value + NAV_PAGE);
  };
  const jump = async (row: AiNavRow) => {
    setActiveId(row.id);
    if (row.loaded) { await onJump(row); return; }
    setPendingId(row.id);
    try { await onJump(row); } finally { setPendingId(null); }
  };

  return <div className={`ai-msgnav${open ? " is-open" : ""}${isDragging ? " is-dragging" : ""}`}
    ref={containerRef} style={style}>
    {open ? <div className="ai-msgnav-panel">
      <header onPointerDown={startDrag} title={t("ai.nav.title")}>
        <GripVertical size={13} className="ai-msgnav-drag-handle" aria-hidden />
        <strong>{t("ai.nav.title")}</strong>
        <span className="ai-msgnav-count">{count}</span>
        <button type="button" className="ai-msgnav-collapse" aria-label={t("ai.sidebar.collapseAll")} onClick={() => setOpen(false)}>
          <ChevronRight size={14} className="is-flipped" aria-hidden />
        </button>
      </header>
      {outline.loaded && !outline.complete ? <p className="ai-msgnav-note">{t("ai.nav.partial")}</p> : null}
      {rows.length > visible.length ? <p className="ai-msgnav-note">{t("ai.nav.older", { count: rows.length - visible.length })}</p> : null}
      {outline.loading ? <p className="ai-msgnav-note" role="status"><Loader2 size={11} className="is-spinning" aria-hidden />{t("ai.runtime.loading")}</p> : null}
      {outline.error ? <p className="ai-msgnav-note" role="alert">{outline.error}<button type="button" className="ai-text-button" onClick={onRequestOutline}>{t("ai.nav.retry")}</button></p> : null}
      <div className="ai-msgnav-list" role="list" ref={list} onScroll={grow}>
        {visible.map((row) => <div key={row.id} role="listitem" className="ai-msgnav-rowwrap">
          <button type="button" className={row.id === activeId ? "is-active" : ""} onClick={() => void jump(row)}>
            <span className="ai-msgnav-ordinal" aria-hidden>{row.id === pendingId ? <Loader2 size={11} className="is-spinning" /> : row.ordinal}</span>
            <span className="ai-msgnav-label" title={row.label}>{row.label || t("ai.message")}</span>
            {row.files ? <span className="ai-msgnav-files">{t("ai.nav.files", { count: row.files })}</span> : null}
          </button>
          {row.id === activeId && row.paths?.length ? <div className="ai-msgnav-files-card">
            {row.paths.slice(0, 8).map((path) => <code key={path} className="ai-msgnav-file">{path.split(/[\\/]/).pop() || path}</code>)}
            {row.paths.length > 8 ? <span className="ai-msgnav-files-more">+{row.paths.length - 8}</span> : null}
          </div> : null}
        </div>)}
        {!rows.length && !outline.loading && !outline.error ? <p className="ai-msgnav-empty">{t("ai.nav.empty")}</p> : null}
      </div>
    </div> : <button type="button" className="ai-msgnav-chip" title={t("ai.nav.title")} aria-label={t("ai.nav.title")} aria-expanded={false}
      onClick={() => { if (!isMoved()) toggle(); }}>
      <ListOrdered size={12} aria-hidden />
      <span className="ai-msgnav-chip-label">{count}</span>
    </button>}
  </div>;
}

/** 本轮 token 的起点快照：tok/s =（当前累计 − 起点）/ 已跑时长；键随 runId 换新。 */
const runUsageStart = new Map<string, number>();
function aiRunUsageBaseline(runId: string, total: number | undefined): number | undefined {
  if (total === undefined) return undefined;
  if (!runUsageStart.has(runId)) runUsageStart.set(runId, total);
  return runUsageStart.get(runId);
}

/**
 * 运行中状态行（对照参考实现 LiveTurnStats 的精简版）：图标脉动 + 状态字之外，
 * 补「耗时 / 本轮编辑统计 / tok/s」三档数据——按面板宽度分档出现，窄栏只留状态字。
 * 计时与 token 起点都从本轮第一次被前端看到起算，历史里翻开的旧轮没有这些数就不显示。
 */
function AiLiveStats({ provider, runId, entries, usage, statusText, planMode }: {
  provider: AiSession["provider"];
  runId: string | null;
  entries: AiEntry[];
  usage?: import("../lib/aiUsage").AiUsage;
  statusText: string;
  /** 本轮请求真实带去的模式（Codex collaborationMode / Claude --permission-mode plan）。 */
  planMode: boolean;
}) {
  const { t } = useI18n();
  const elapsed = useAiElapsed(true, `run:${runId ?? ""}`);
  const edits = useMemo(() => summarizeAiFileEdits(entries.filter((entry) => entry.runId === runId)), [entries, runId]);
  const baseline = aiRunUsageBaseline(runId ?? "", usage?.total);
  const speed = elapsed !== undefined && elapsed >= 10000 && baseline !== undefined && usage?.total !== undefined && usage.total > baseline
    ? (usage.total - baseline) / (elapsed / 1000)
    : undefined;
  return <div className="ai-live-stats" role="status">
    <AiProviderIcon provider={provider} size={13} />
    <span>{statusText}</span>
    {planMode ? <span className="ai-live-item ai-live-mode">{t("ai.chat.planModeActive")}</span> : null}
    {elapsed !== undefined && elapsed >= 10000 ? <span className="ai-live-item"><Timer size={12} aria-hidden />{formatAiClock(elapsed)}</span> : null}
    {edits.fileCount ? <span className="ai-live-item is-wide"><FilePenLine size={12} aria-hidden />{edits.fileCount}F{edits.additions !== undefined ? <> +{edits.additions}/−{edits.deletions ?? 0}</> : null}</span> : null}
    {speed !== undefined ? <span className="ai-live-item is-wider"><Plane size={12} aria-hidden />{speed.toFixed(1)} tok/s</span> : null}
  </div>;
}

/**
 * 回合末尾的文件汇总卡（对照 codeg 的 reply-artifacts）：新增一张、改动一张，
 * 完成态全部默认收起；头部给「N 个文件 + 总 ±行数」，
 * 展开是逐文件卡——点文件跳编辑器。统计口径与底栏汇总同源（只算真实完成的补丁）。
 */
const AiReplyArtifacts = memo(function AiReplyArtifacts({ summary }: { summary: AiEditSummary }) {
  const { t } = useI18n();
  const added = summary.files.filter((file) => file.kind === "add");
  const changed = summary.files.filter((file) => file.kind !== "add");
  const [openNew, setOpenNew] = useState(false);
  const [openChanged, setOpenChanged] = useState(false);
  /** 行内展开的文件：点行就地预览它的 diff（改动/删除）或建档内容（新增），不跳编辑器。 */
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!added.length && !changed.length) return null;
  const [sideBySide] = useAiDiffViewMode();
  const preview = (file: AiEditedFile) => {
    if (file.kind === "add" && file.content !== undefined) {
      return <CodeText text={file.content} lang={file.path.split(".").pop()} />;
    }
    return <>{file.diff !== undefined ? <AiDiffEditor diff={file.diff} path={file.path} sideBySide={sideBySide === "split"} /> : null}
      {file.fragments?.map((fragment, index) => <div key={index}>{fragment.before !== undefined ? <CodeText text={fragment.before} lang={file.path.split(".").pop()} /> : null}{fragment.after !== undefined ? <CodeText text={fragment.after} lang={file.path.split(".").pop()} /> : null}</div>)}</>;
  };
  const card = (title: string, files: AiEditedFile[], open: boolean, toggle: () => void, icon: ReactNode) => files.length ? <details className={`ai-artifact-card${open ? " is-open" : ""}`} open={open}
    onToggle={(event) => { const next = event.currentTarget.open; if (next !== open) toggle(); }}>
    <summary>
      {icon}
      <strong>{title}</strong>
      <span className="ai-artifact-count">{t("ai.chat.filesCount", { count: files.length })}</span>
      {summary.additions !== undefined ? <span className="ai-artifact-diff"><span className="is-add">+{files.reduce((sum, file) => sum + (file.additions ?? 0), 0)}</span><span className="is-delete">−{files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)}</span></span> : null}
      <ChevronRight size={14} className="ai-detail-chevron" aria-hidden />
    </summary>
    <div className="ai-artifact-files">
      {files.map((file) => {
        const name = file.path.split(/[\\/]/).pop() || file.path;
        const dir = file.path.slice(0, file.path.length - name.length - 1);
        const canPreview = (file.kind === "add" && file.content !== undefined) || file.diff !== undefined || !!file.fragments?.length;
        return <div key={file.path} className={`ai-artifact-file is-${file.kind ?? "edit"}${expanded === file.path ? " is-expanded" : ""}`}>
          <button type="button" className="ai-artifact-file-main" disabled={!canPreview}
            aria-expanded={expanded === file.path}
            title={canPreview ? t("ai.chat.previewChange") : undefined}
            onClick={() => setExpanded((current) => current === file.path ? null : file.path)}>
            <span className="ai-artifact-file-name">{name}</span>
            {dir ? <span className="ai-artifact-file-dir">{dir}</span> : null}
          </button>
          {file.additions !== undefined ? <span className="ai-artifact-file-diff"><b>+{file.additions}</b>{file.deletions ? <i>−{file.deletions}</i> : null}</span> : file.kind === "delete" ? <span className="ai-artifact-file-diff">{t("ai.tool.delete")}</span> : null}
          {expanded === file.path ? <div className="ai-artifact-preview">{preview(file)}</div> : null}
        </div>;
      })}
    </div>
  </details> : null;
  return <div className="ai-artifacts">
    {card(t("ai.chat.filesAdded"), added, openNew, () => setOpenNew(!openNew), <FilePlus2 size={14} aria-hidden />)}
    {card(t("ai.chat.filesChanged"), changed, openChanged, () => setOpenChanged(!openChanged), <FilePenLine size={14} aria-hidden />)}
  </div>;
});

/**
 * 回合完成后的操作行（对照参考实现的 TurnStats，砍掉协议不支持的分叉/转任务）：
 * 耗时、token 数、复制最后一段回复、跳回本轮的用户消息。回合失败也有这一行——
 * 失败原因另有错误行，这里的统计与动作同样成立。
 */
const AiTurnStats = memo(function AiTurnStats({ runId, usage, lastAssistantText, userEntryId, onJump }: {
  runId: string;
  usage?: import("../lib/aiUsage").AiUsage;
  lastAssistantText: string | undefined;
  userEntryId: string | undefined;
  onJump: (id: string) => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const start = aiArrivalOf(`run:${runId}`);
  const duration = start !== undefined ? aiArrival(`run:${runId}:end`) - start : undefined;
  const fallbackTokens = (usage?.input ?? 0) + (usage?.output ?? 0);
  const tokens = usage?.total ?? (fallbackTokens > 0 ? fallbackTokens : undefined);
  const copy = () => {
    if (!lastAssistantText) return;
    void navigator.clipboard.writeText(lastAssistantText).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }, () => { /* 剪贴板被拒就保持原样，不谎报已复制。 */ });
  };
  return <div className="ai-turn-stats">
    {duration !== undefined && duration >= 1000 ? <span className="ai-turn-stats-pill"><Timer size={12} aria-hidden />{formatAiClock(duration)}</span> : null}
    {tokens !== undefined && tokens > 0 ? <span className="ai-turn-stats-pill">{tokens.toLocaleString()} tok</span> : null}
    {lastAssistantText ? <button type="button" className="ai-turn-stats-button" aria-label={copied ? t("action.copied") : t("action.copy")} title={copied ? t("action.copied") : t("action.copy")} onClick={copy}>
      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
    </button> : null}
    {userEntryId ? <button type="button" className="ai-turn-stats-button" aria-label={t("ai.chat.backToMessage")} title={t("ai.chat.backToMessage")} onClick={() => onJump(userEntryId)}>
      <ChevronsUp size={12} aria-hidden />
    </button> : null}
  </div>;
});

/** Goal 是会话级控制器，固定在输入区上方；Task 仍是标题栏里的步骤概览。 */
const AiGoalBar = memo(function AiGoalBar({ goal, busy, onStatus, onHide }: {
  goal: AiThreadGoal;
  busy: boolean;
  onStatus: (status: "active" | "paused") => void;
  onHide: () => void;
}) {
  const { t } = useI18n();
  const status = {
    active: t("ai.chat.goalStatusActive"),
    paused: t("ai.chat.goalStatusPaused"),
    blocked: t("ai.chat.goalStatusBlocked"),
    usageLimited: t("ai.chat.goalStatusUsageLimited"),
    budgetLimited: t("ai.chat.goalStatusBudgetLimited"),
    complete: t("ai.chat.goalStatusComplete"),
  }[goal.status];
  const next = goal.status === "active" ? "paused" : goal.status === "paused" ? "active" : null;
  return <section className={`ai-goalbar is-${goal.status}`} aria-label={t("ai.chat.goal")}>
    <span className="ai-goalbar-icon">{goal.status === "active" ? <Loader2 size={14} className="is-spinning" aria-hidden /> : goal.status === "complete" ? <CheckCircle2 size={14} aria-hidden /> : <Target size={14} aria-hidden />}</span>
    <div className="ai-goalbar-body">
      <div><strong>{t("ai.chat.goal")}</strong><span className={`ai-goalbar-status is-${goal.status}`}>{status}</span></div>
      <p title={goal.objective}>{goal.objective}</p>
    </div>
    <span className="ai-goalbar-usage" title={`${t("ai.chat.goalTime")}: ${goal.timeUsedSeconds.toLocaleString()}s`}>
      {goal.tokensUsed.toLocaleString()}{goal.tokenBudget !== null ? ` / ${goal.tokenBudget.toLocaleString()}` : ""} tok
    </span>
    {next ? <button type="button" className="ai-goalbar-action" disabled={busy} onClick={() => onStatus(next)}
      aria-label={t(next === "paused" ? "ai.chat.pauseGoal" : "ai.chat.resumeGoal")}
      title={t(next === "paused" ? "ai.chat.pauseGoal" : "ai.chat.resumeGoal")}>
      {busy ? <Loader2 size={13} className="is-spinning" aria-hidden /> : next === "paused" ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
      <span>{t(next === "paused" ? "ai.chat.pause" : "ai.chat.resume")}</span>
    </button> : goal.status === "complete" ? <button type="button" className="ai-goalbar-action" onClick={onHide}
      aria-label={t("ai.chat.hideGoal")} title={t("ai.chat.hideGoal")}>
      <EyeOff size={13} aria-hidden />
      <span>{t("ai.chat.hideGoal")}</span>
    </button> : null}
  </section>;
});

interface AiChatEntryRowProps {
  entry: AiEntry;
  request?: AiRequest;
  stopping: boolean;
  artifacts?: AiEditSummary;
  streaming: boolean;
  liveThinking: boolean;
  agentSession?: string;
  subagents?: AiEntry[];
  hasRequest: boolean;
  onOpenSession?: (id: string) => void;
  onLightbox: (path: string) => void;
  onImageLoad: () => void;
  /** 允许写入类工具前先快照；由会话层提供会话 id 与工作区。 */
  onBeforeAllow?: (request: AiRequest) => Promise<void>;
  /** 恢复一条改动快照。 */
  onRestoreCheckpoint?: (checkpointId: string) => void;
}

/** 单条会话记录渲染单元：深度 memo 记忆化保护，防止任何外层状态变动拖慢整条历史时间线 */
const AiChatEntryRow = memo(function AiChatEntryRow({
  entry,
  request,
  stopping,
  artifacts,
  streaming,
  liveThinking,
  agentSession,
  subagents,
  hasRequest,
  onOpenSession,
  onLightbox,
  onImageLoad,
  onBeforeAllow,
  onRestoreCheckpoint,
}: AiChatEntryRowProps) {
  const { t } = useI18n();
  if (entry.kind === "request") {
    return request ? <RequestCard key={entry.id} request={request} stopping={stopping} onBeforeAllow={onBeforeAllow} /> : null;
  }
  const body = (
    <article data-entry-id={entry.id} className={`ai-chat-entry is-${entry.kind}`}>
      {entry.kind === "user" ? (
        <AiUserMessage
          text={entry.text}
          images={entry.images?.map((path) => ({
            key: path,
            node: (
              <button
                type="button"
                className="ai-msg-image"
                aria-label={t("ai.chat.previewImage")}
                title={t("ai.chat.previewImage")}
                onClick={() => onLightbox(path)}
              >
                <img
                  src={assetUrl(path, 0)}
                  alt={path.split(/[\\/]/).pop() ?? t("ai.chat.pastedImage")}
                  onLoad={onImageLoad}
                  onError={(event) => {
                    event.currentTarget.alt = t("ai.chat.imageMissing");
                    event.currentTarget.classList.add("is-missing");
                  }}
                />
              </button>
            ),
          }))}
        />
      ) : entry.kind === "assistant" || entry.kind === "command" ? (
        <>
          {entry.kind === "command" ? <small className="ai-muted">{t("ai.commands.output")}</small> : null}
          <AiMarkdown text={entry.text} streaming={streaming} />
        </>
      ) : entry.kind === "tool" ? (
        <AiToolCall
          entry={entry}
          subagents={subagents}
          hasRequest={hasRequest}
          agent={agentSession ? { sessionId: agentSession } : undefined}
          onOpenAgent={onOpenSession}
        />
      ) : entry.kind === "reasoning" ? (
        <AiReasoningEntry entry={entry} live={liveThinking} />
      ) : entry.kind === "notice" ? (
        <TimelineNotice entry={entry} onRestoreCheckpoint={onRestoreCheckpoint} />
      ) : null}
    </article>
  );

  return artifacts ? (
    <Fragment key={entry.id}>
      {body}
      <AiReplyArtifacts summary={artifacts} />
    </Fragment>
  ) : (
    body
  );
});

interface AiSessionPaneProps {
  /** 要渲染的会话；切换会话时由上层用 `key` 强制重建，不靠 props 变化。 */
  session: AiSession;
  /** 会话所属工作区根；为 null 时只能看历史，不能发送。 */
  workspace: string | null;
  /** 打开设置页的 AI 助手模块。 */
  onSettings: () => void;
  /** 发送前的最后检查；返回 false 则中止本轮发送（例如还有未保存文件）。 */
  beforeSend?: () => boolean | Promise<boolean>;
  /** 横幅菜单里的重命名/置顶/归档/删除意图，与侧栏同一通道；缺省时菜单相应项收起。 */
  onAction?: (action: AiSessionAction) => void;
  /** 横幅菜单里的「新建会话」。 */
  onNew?: () => void;
  /** 点在回复或工具卡片里的文件路径：跳到编辑器对应行。 */
  onOpenFile?: AiOpenFile;
  /** 向右侧侧边栏上报子代理列表有没有内容；右栏据此决定显隐。 */
  onAgentDockAvailable?: (available: boolean) => void;
  /** 打开子代理侧栏；父会话里的状态提示调用它，不直接操纵应用布局。 */
  onOpenAgentDock?: () => void;
  /** 打开（或聚焦）另一条会话的标签：子代理视图跳转、返回父会话都用它。 */
  onOpenSession?: (id: string) => void;
  /** 父会话标题；子代理会话的面包屑用它，普通会话不传。 */
  parentTitle?: string | null;
}

/**
 * 一个 AI 会话的完整界面：消息时间线、请求卡片、输入框与运行控制。
 *
 * 组件本身不持有跨会话状态，所有会话数据都在 `lib/aiRuntime` 的全局 store 里，
 * 所以切走再切回来能直接看到后台仍在推进的进度。
 */
export default function AiSessionPane({ session, workspace, onSettings, beforeSend, onAction, onNew, onOpenFile, onAgentDockAvailable, onOpenAgentDock, onOpenSession, parentTitle }: AiSessionPaneProps) {
  const { t } = useI18n();
  /** 子代理会话：事件由父会话运行时路由进来，发送走经父转发，不直接驱动 CLI。 */
  const isAgentSession = !!session.parentSessionId;
  /** 右侧侧边栏给本面板留的挂载点；任务清单与子代理列表 portal 过去停靠。 */
  const dockSlots = useAiDockSlots();
  const snapshot = useAiRuntime(session.id);
  const activity = useAiSessionActivity(session.id);
  const ownedRunId = useAiOwnedRunId(session.id);
  const ownedQueuedRunIds = useAiOwnedQueuedRunIds(session.id);
  // 原始日志保留入队记录；所有正文消费者只读取已启动的回合。
  const entries = useMemo(() => conversationItems(snapshot.entries, snapshot.tasks), [snapshot.entries, snapshot.tasks]);
  const runtime = { ...snapshot, entries };
  // 导航另用一份轮次索引；正文分页只覆盖最近那一页事件，长会话里连一轮都铺不满。
  const rawOutline = useAiOutline(session.id);
  const outline = useMemo(() => ({ ...rawOutline, turns: conversationItems(rawOutline.turns, snapshot.tasks) }), [rawOutline, snapshot.tasks]);
  // 打开工程即读本地信任配置，不启动 CLI，也不等待模型发现。
  const optionsKey = `${aiSessionStorageKey(workspace)}:options:${session.id}`;
  const [options, setOptions] = useState<AiRunOptions>(() => loadAiOptions(optionsKey, session.provider));
  // 设置芯片用历史实际模型补空选择；发送必须复用同一结果，不能显示 5.6 却让后端另选默认模型。
  const selectedModel = options.model?.trim() || runtime.usage?.model?.trim() || runtime.configuration?.model?.trim() || undefined;
  const selectedRunOptions = async (): Promise<AiRunOptions> => {
    if (selectedModel) return { ...options, model: selectedModel };
    if (!workspace) throw new Error(t("ai.noWorkspace"));
    // 全新会话显示的是本地目录默认项；发送前把这项解析成明确 ID，禁止后端再次猜默认值。
    const catalog = await loadAiCapabilities(session.provider, workspace);
    const model = catalog.models.find((item) => item.isDefault)?.id.trim();
    if (!model) throw new Error(t("ai.chat.noModels"));
    return { ...options, model };
  };
  const [extraDirs, setExtraDirs] = useState<string[]>(() => loadAdditionalDirs(workspace, session.id));
  const openPlan = useMemo(() => openAiPlan(runtime.plans), [runtime.plans]);
  /** 计划决策在途时禁用卡片；实际状态要等抓取到新的 plan_review 事件。 */
  const [decidingPlan, setDecidingPlan] = useState(false);
  /** 用户已忽略的一次权限拒绝提示，按路径/文本记住，不重复打扰。 */
  const [dismissedDenial, setDismissedDenial] = useState<string | null>(null);
  const denialKey = runtime.permissionDenied ? runtime.permissionDenied.path ?? runtime.permissionDenied.text : "";
  const changeOptions = (next: AiRunOptions) => {
    setOptions(next);
    // 切走计划这一档时，CLI 回报的那份运行态也要一起清掉：
    // 否则徽标停在「计划模式」上，用户看不出自己已经换了选项。
    if (runtime.configuration?.planMode && next.mode !== "plan" && next.planMode !== true) {
      runtime.configuration.planMode = false;
    }
    try { saveAiOptions(optionsKey, session.provider, next); } catch { setError(t("ai.storageError")); }
  };
  const isPlanModeActive = options.mode === "plan" || options.planMode === true || runtime.configuration?.planMode === true;
  const handleExitPlanMode = useCallback(() => {
    changeOptions({ ...options, planMode: undefined, mode: aiNormalMode(session.provider) });
    if (runtime.configuration) {
      runtime.configuration.planMode = false;
    }
  }, [changeOptions, options, runtime]);
  const [draft, setDraft] = useState(() => loadDraft(workspace, session.id));
  const aiInputMenu = useAiInputMenu();
  const [contextMenu, setContextMenu] = useState<MenuAnchor | null>(null);
  /** ↑↓ 召回停在历史的哪一条；`stash` 是走出历史时要还回去的那行，用户在召回件上改的字也存这里。 */
  const [browse, setBrowse] = useState<PromptBrowse | null>(null);
  const [images, setImages] = useState<PastedImage[]>([]);
  // 异步保存尚未回填 state 时也要占名额，防止连续粘贴越过上限。
  const pendingImages = useRef(0);
  /** 每条消息的附件上限。初值只是后端还没答话时的兜底，真实数字来自 `ai_runtime_image_limits`。 */
  const [imageLimit, setImageLimit] = useState(8);
  /** 外部文件正拖在输入框上方：整窗的「打开工程」路由这时要让位给附件。 */
  const [dropArmed, setDropArmed] = useState(false);
  const attachArea = useRef<HTMLDivElement>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [timelineLimit, setTimelineLimit] = useState(TIMELINE_WINDOW);
  /** 用户点过「这次不用」的那一档；跨过下一个比例档位才会重新提醒。 */
  const [compactDismissed, setCompactDismissed] = useState<string | null>(null);
  const [compactPrefs, setCompactPrefs] = useState(readCompactPrefs);
  const [error, setError] = useState<string | null>(null);
  const [goalUpdating, setGoalUpdating] = useState(false);
  // 只记住当前会话里用户主动隐藏的 Goal；Goal 数据本身仍由运行时保留。
  const [hiddenGoalKey, setHiddenGoalKey] = useState<string | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLElement>(null);
  /** 聊天列宽（左右手柄可调，持久化在 aiChatWidth）；列宽变化经 CSS 变量即时生效。 */
  const chatWidth = useAiChatWidth();
  /** 图片放大预览：存沙箱里的副本路径；null 表示关着。 */
  const [lightbox, setLightbox] = useState<string | null>(null);
  /**
   * 往前翻时记住的锚点：顶上第一条消息当时离视口顶多远。
   *
   * 更早的记录一律插到已渲染内容上面，而 scrollTop 只管自己不管内容变长，于是每翻一页眼前那段就
   * 被顶得看不见。记住这一条的位置、提交后量它挪了多少、把 scrollTop 补回去——比按整个
   * scrollHeight 的差值补更准：翻页请求在途时正文照样在底部追加，那种增长不该移动视线。
   */
  const olderTop = useRef<{ element: HTMLElement; offset: number; height: number; id?: string } | null>(null);
  const olderScroll = useRef(new OlderHistoryScroll());
  const olderLocal = useRef(false);
  const olderRequest = useRef<Promise<void> | null>(null);
  const [, refreshOlderScroll] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<AiComposerHandle>(null);
  /** 召回替换整段文本后要把光标放到末尾：一次性意图，用完就清掉，不值得进 state。 */
  const recallCaret = useRef<number | null>(null);
  const menuId = useId();
  const queueBodyId = useId();
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  // @ 文件提及：光标前命中 @token 就弹建议，选中后以 @相对路径 拼进正文。
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionItems, setMentionItems] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionSeq = useRef(0);
  const mentionTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(mentionTimer.current), []);
  /** 队列编辑借用主输入框；restoreDraft 保证用户原来写到一半的草稿不会被队列正文覆盖。 */
  const [editingTask, setEditingTask] = useState<{ runId: string; restoreDraft: string } | null>(null);
  /** 横幅 ⋯ 菜单与重命名/删除确认。 */
  const [headMenuAnchor, setHeadMenuAnchor] = useState<HTMLElement | null>(null);
  const [headPending, setHeadPending] = useState<{ action: "rename" | "delete"; session: AiSession } | null>(null);
  const queuePointerDrag = useRef<{
    runId: string;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
    drop: { runId: string; edge: "before" | "after" } | null;
  } | null>(null);
  /** 队列默认展开；收起后保留标题、数量和清空入口，避免任务存在却完全失去提示。 */
  const [queueExpanded, setQueueExpanded] = useState(true);
  /** 当前拖拽落点只负责视觉反馈；真正排序仍用稳定 run id 交给后端原子完成。 */
  const [queueDrop, setQueueDrop] = useState<{ runId: string; edge: "before" | "after" } | null>(null);
  /** 排队条拖拽排序的 FLIP：拖起时记下各行的位置，重排落地那一帧按差值反向平移再归位。 */
  const queueHost = useRef<HTMLElement>(null);
  const queueFlip = useRef<Map<string, DOMRect> | null>(null);
  const captureQueueFlip = () => {
    const rects = new Map<string, DOMRect>();
    queueHost.current?.querySelectorAll<HTMLElement>("[data-queue-id]").forEach((element) => {
      if (element.dataset.queueId) rects.set(element.dataset.queueId, element.getBoundingClientRect());
    });
    queueFlip.current = rects;
  };
  useLayoutEffect(() => {
    const from = queueFlip.current;
    if (!from) return;
    queueFlip.current = null;
    queueHost.current?.querySelectorAll<HTMLElement>("[data-queue-id]").forEach((element) => {
      const old = from.get(element.dataset.queueId ?? "");
      if (!old) return;
      const delta = old.top - element.getBoundingClientRect().top;
      if (!delta) return;
      element.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], { duration: 200, easing: "ease-out" });
    });
  });
  /** 「+」菜单与上下文芯片的锚点；后者还承接 /context 命令的模拟点击。 */
  const [addMenuAnchor, setAddMenuAnchor] = useState<HTMLElement | null>(null);
  const contextTrigger = useRef<HTMLButtonElement | null>(null);
  const commandList = commandSuggestions(session.provider, runtime.commands);
  const suggestions = editingTask ? [] : commandsDismissed ? [] : showHelp ? commandList : filterCommandSuggestions(commandList, draft);
  const selectedCommand = Math.min(commandIndex, Math.max(0, suggestions.length - 1));
  const draftSlash = parseSlash(draft);
  const activeCommand = editingTask ? undefined : draftSlash && commandList.find((command) => command.name === (localCommand(draftSlash.name) ?? resolveNativeCommand(runtime.commands ?? { commands: [], terminal: [] }, draftSlash.name)?.name ?? draftSlash.name));
  const menuVisible = suggestions.length > 0 && !sending;
  /** @ 建议：有查询词且搜到了文件才亮出来，避免敲个邮箱地址也弹一层。 */
  const mentionVisible = !editingTask && !sending && mention !== null && mention.query.length > 0 && mentionItems.length > 0;
  const commandMenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuVisible) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target !== input.current && !commandMenu.current?.contains(event.target as Node)) { setCommandsDismissed(true); setShowHelp(false); }
    };
    window.addEventListener("pointerdown", dismiss, true);
    return () => window.removeEventListener("pointerdown", dismiss, true);
  }, [menuVisible]);
  /** 改输入框就顺手落一次盘（内部防抖 300ms）：存不下只是下次重启看不到半截话，不值得打扰发送；空了就删键，别攒一堆空记录。 */
  const commitDraft = (text: string, immediate = false) => {
    setDraft(text);
    if (text) saveDraft(workspace, session.id, text, immediate); else clearDraft(workspace, session.id);
  };
  const updateDraft = (text: string) => {
    // 编辑队列时输入框只是临时工作区，不能拿队列正文覆盖持久草稿。
    if (editingTask) setDraft(text); else commitDraft(text);
    // 直接在召回来的那行上改字：位置留住，改动记进 stash，走出历史时还回得到用户自己打的字。
    if (browse) setBrowse(browseTyped(text, { text, browse }).browse);
    setCommandsDismissed(false); setShowHelp(false); setCommandIndex(0); setCommandNotice(null);
  };
  /** 输入变化后同步 @ 提及建议：命中 @token 就按查询词搜一次文件（260ms 防抖，只认文件）。 */
  const syncMention = (text: string, caret: number) => {
    const found = editingTask || sending || !workspace ? null : mentionAt(text, caret);
    setMention(found);
    setMentionIndex(0);
    if (!found || !found.query || !workspace) { setMentionItems([]); return; }
    const token = ++mentionSeq.current;
    window.clearTimeout(mentionTimer.current);
    mentionTimer.current = window.setTimeout(() => {
      void findFiles(workspace, found.query, 8, { showHidden: false, ignored: [] })
        .then((result) => {
          if (mentionSeq.current !== token) return;
          setMentionItems(result.items
            .filter((item) => !item.isDir)
            .map((item) => mentionPathOf(item.path, workspace))
            .filter(Boolean));
        })
        .catch(() => {
          if (mentionSeq.current === token) setMentionItems([]);
        });
    }, 260);
  };
  /** 草稿清空（发送、切队列编辑等）时把建议一并收掉，浮层不悬在空输入上。 */
  useEffect(() => {
    if (!draft) { setMention(null); setMentionItems([]); }
  }, [draft]);
  const acceptMention = (path: string) => {
    if (!mention) return;
    const caret = input.current?.selectionStart ?? draft.length;
    const applied = applyMention(draft, caret, mention.start, path);
    commitDraft(applied.text);
    setMention(null);
    setMentionItems([]);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(applied.caret, applied.caret);
    });
  };
  /** 允许写入类工具之前，把目标文件的当前内容快照下来（改动前状态，恢复链的源头）。 */
  const snapshotBeforeAllow = useCallback(async (request: AiRequest) => {
    const path = requestPath(request.input);
    if (!workspace || !path) return;
    await invoke("ai_session_checkpoint_save", { sessionId: session.id, workspace, paths: [path] }).catch(() => {
      // 快照尽力而为：失败不拦批准，也不打断发送。
    });
  }, [session.id, workspace]);
  /** 把一份快照写回磁盘；恢复动作自己会在时间线上生成一条「恢复前」快照。 */
  const restoreCheckpoint = useCallback((checkpointId: string) => {
    if (!workspace) return;
    void invoke("ai_session_checkpoint_restore", { sessionId: session.id, workspace, checkpointId })
      .catch((cause) => setError(String(cause)));
  }, [session.id, workspace]);
  useEffect(() => watchAiInputDelivery(session.id, (delivery) => {
    // 编辑队列期间输入框属于队列项；外部投递只更新背后的正常草稿，退出编辑后再显现。
    if (editingTask) {
      setEditingTask({ ...editingTask, restoreDraft: delivery.text });
    } else {
      setDraft(delivery.text);
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.setSelectionRange(delivery.text.length, delivery.text.length);
      });
    }
    if (delivery.additionalDir) {
      setExtraDirs((current) => current.includes(delivery.additionalDir!)
        ? current : [delivery.additionalDir!, ...current].slice(0, 16));
    }
  }), [editingTask, session.id]);

  const requestConversationMenu = (event: ReactMouseEvent) => {
    const selection = window.getSelection();
    const text = selection?.toString() ?? "";
    const anchor = selection?.anchorNode;
    const focus = selection?.focusNode;
    if (!text.trim() || !anchor || !focus || !content.current?.contains(anchor) || !content.current.contains(focus)) return;
    event.preventDefault();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: t("action.copy"), onSelect: () => void navigator.clipboard.writeText(text) },
        aiInputMenu({ kind: "text", text, source: session.title || t("ai.untitledSession") }),
      ],
    });
  };

  const requestEditorMenu = (event: ReactMouseEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? start;
    const selected = draft.slice(start, end);
    const replace = (text: string) => {
      const next = `${draft.slice(0, start)}${text}${draft.slice(end)}`;
      updateDraft(next);
      requestAnimationFrame(() => {
        const caret = start + text.length;
        input.current?.focus(); input.current?.setSelectionRange(caret, caret);
      });
    };
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: t("action.copy"), disabled: !selected, onSelect: () => void navigator.clipboard.writeText(selected) },
        { label: t("action.paste"), onSelect: () => void navigator.clipboard.readText().then(replace).catch(() => {}) },
        { label: t("action.selectAll"), disabled: !draft, onSelect: () => requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); }) },
        { label: t("menu.cut"), disabled: !selected, onSelect: () => { void navigator.clipboard.writeText(selected); replace(""); } },
      ],
    });
  };
  const cancelQueuedEdit = () => {
    if (!editingTask) return;
    const restore = editingTask.restoreDraft;
    setEditingTask(null); commitDraft(restore); setBrowse(null); setCommandNotice(null);
    recallCaret.current = restore.length;
    requestAnimationFrame(() => input.current?.focus());
  };
  const beginQueuedEdit = (runId: string, prompt: string) => {
    // 从一个队列项切到另一个时仍保留最初的用户草稿，而不是把上一项正文当成草稿。
    const restoreDraft = editingTask?.restoreDraft ?? draft;
    setEditingTask({ runId, restoreDraft }); setDraft(prompt); setBrowse(null);
    setCommandsDismissed(true); setShowHelp(false); setCommandNotice(null); setError(null);
    recallCaret.current = prompt.length;
    requestAnimationFrame(() => input.current?.focus());
  };
  const chooseCommand = (name: string) => { updateDraft(completeCommand(draft, name)); input.current?.focus(); };
  useEffect(() => { document.getElementById(`${menuId}-${selectedCommand}`)?.scrollIntoView?.({ block: "nearest" }); }, [menuId, selectedCommand]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(240, Math.max(52, element.scrollHeight))}px`;
    // 召回替换整段文本后把光标放到末尾：否则光标停在开头，长提示词一上来看不见尾巴。
    if (recallCaret.current !== null) {
      element.setSelectionRange(recallCaret.current, recallCaret.current);
      recallCaret.current = null;
    }
  }, [draft]);
  /** 召回一条已发送的正文；没历史、或往下时本来就不在历史里，就把这个键还给输入框。 */
  const recall = (up: boolean): boolean => {
    const history = loadPromptHistory(workspace);
    if (!history.length || !up && !browse) return false;
    const next = (up ? browseUp : browseDown)(history, { text: draft, browse });
    commitDraft(next.text);
    setBrowse(next.browse);
    recallCaret.current = next.text.length;
    return true;
  };
  /** 脱离底部时锚定的那条条目；null 就是「贴着底部，跟着走」。 */
  const [anchor, setAnchor] = useState<FollowAnchor>(null);
  const [atBottom, setAtBottom] = useState(true);
  /**
   * 待落地的跳转。目标可能要等历史补齐、也要等时间线窗口放开才存在于 DOM 里，而这两步都会重新渲染，
   * 所以「跳过去」是一份状态，由下面那条 layout effect 在它真正渲染出来的那一帧执行。
   * 旧写法是在一个闭包里轮询 6 次 ×60ms：`await` 补完历史以后，手上的 `entries` 还是跳转前那份，
   * 找不到条目就静默不跳——正是「点了没反应，往上滑一下再点才到位」。`waiting` 是「还在为它补历史」，
   * 补完之前不能说够不着。
   */
  const [pendingJump, setPendingJump] = useState<{ id: string; waiting: boolean } | null>(null);
  // 历史 running 可能属于另一个 Forge 进程；动画和停止按钮只能认实时探针给出的本进程 run id。
  const running = runtime.status === "running" && activity === "running" && runtime.runId === ownedRunId;
  useEffect(() => { setOptions(loadAiOptions(optionsKey, session.provider)); setDraft(loadDraft(workspace, session.id)); setEditingTask(null); setBrowse(null); setImages([]); setDropArmed(false); setTimelineLimit(TIMELINE_WINDOW); setCompactDismissed(null); setError(null); setAnchor(null); setAtBottom(true); setPendingJump(null); olderTop.current = null; setTaskListDisclosure(null); }, [optionsKey, session.id, workspace]);
  /**
   * 新建会话的交接：草稿欢迎页在创建会话时把首条消息（含附件）留在这里，
   * 会话页挂载后先回填输入框与附件，再触发一次正常发送——信任确认、未保存检查
   * 与斜杠命令校验都照常经过。仅在挂载时读一次，读不到的会话绝不自动发送。
   */
  const draftHandoff = useRef(takeAiDraftHandoff(session.id));
  const [armedSend, setArmedSend] = useState(false);
  useEffect(() => {
    const payload = draftHandoff.current;
    if (!payload) return;
    draftHandoff.current = null;
    if (payload.images.length) setImages(payload.images.map((path) => ({ path, preview: assetUrl(path, 0), name: path.split(/[\\/]/).pop() ?? t("ai.chat.pastedImage") })));
    if (payload.text) commitDraft(payload.text);
    setArmedSend(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在会话页挂载时消费一次交接载荷。
  }, []);
  useEffect(() => {
    if (!armedSend || sendingRef.current) return;
    setArmedSend(false);
    void send(false);
  }, [armedSend]);
  useEffect(() => {
    if (!workspace || !cliDesktopAvailable()) return;
    // 重开标签必须补取最新正文和活动任务；已有缓存不代表后台期间的事件已经收齐。
    // 聚焦时也校准运行中的会话，不能用可能过期的 running 状态阻止恢复。
    const refresh = () => { void loadAiMessages(session.id, workspace, true).catch(() => {}); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [session.id, workspace]);
  /**
   * 三条附件入口（粘贴、选择器、拖拽）共用的结算。
   *
   * 先占名额再落盘，成的进输入框，败的报第一句原因。逐张结算是因为一整批里只要有一张读失败，
   * 其余**已经写进沙箱**的文件不能跟着结果一起被丢掉——那既看不见也没人删，只能堆在缓存目录里。
   */
  const attach = (tasks: Promise<PastedImage>[]) => {
    // 队列更新接口只改提示词；编辑态忽略附件入口，不能让隐藏附件看起来会随保存生效。
    if (editingTask || !tasks.length) return;
    if (images.length + pendingImages.current + tasks.length > imageLimit) { setError(t("ai.chat.tooManyImages", { count: imageLimit })); return; }
    pendingImages.current += tasks.length;
    void Promise.allSettled(tasks).then((results) => {
      const saved = results.flatMap((result): PastedImage[] => result.status === "fulfilled" ? [result.value] : []);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (saved.length) setImages((current) => [...current, ...saved]);
      setError(failed ? String(failed.reason) : null);
    }).finally(() => { pendingImages.current = Math.max(0, pendingImages.current - tasks.length); });
  };
  /** 剪贴板里的图片由前端读成 data URL，后端只按文件头复核；回显直接用同一份 data URL，省一次读盘。 */
  const pasteImage = (file: File) => new Promise<PastedImage>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("ai.chat.imageReadFailed")));
    reader.onload = () => {
      const preview = typeof reader.result === "string" ? reader.result : "";
      if (!preview) { reject(new Error(t("ai.chat.imageReadFailed"))); return; }
      invoke<{ path: string }>("ai_runtime_save_pasted_image", { dataUrl: preview })
        .then(({ path }) => resolve({ path, preview, name: file.name || t("ai.chat.pastedImage") }), reject);
    };
    reader.readAsDataURL(file);
  });
  /** 本机绝对路径（选择器与拖拽给的都是）：复制进沙箱后 CLI 只读副本，原文件既不动也不授权。 */
  const attachFile = (path: string) => invoke<{ path: string; name?: string }>("ai_runtime_save_image_file", { path })
    .then(({ path: saved, name }) => ({ path: saved, preview: assetUrl(saved, 0), name: name || t("ai.chat.pastedImage") }));
  const attachPaths = (paths: readonly string[]) => attach(paths.map(attachFile));
  /** 原生文件选择器：扩展名只是给用户的筛选提示，算不算图片仍由后端按文件头判定。 */
  const pickImages = async () => {
    try {
      const picked = await open({ multiple: true, filters: [{ name: t("ai.chat.imageFilter"), extensions: IMAGE_EXTENSIONS }] });
      if (picked) attachPaths(Array.isArray(picked) ? picked : [picked]);
    } catch (cause) { setError(String(cause)); }
  };
  /** 投放接手用的最新闭包：目标只在挂载时注册一次，动作按当下的附件列表与上限判断。 */
  const takeDrop = useRef<(paths: string[]) => void>(() => {});
  takeDrop.current = attachPaths;
  useEffect(() => {
    if (!workspace || !cliDesktopAvailable()) return;
    return registerDropOwner({
      contains: (x, y) => {
        const area = attachArea.current;
        if (!area) return false;
        const box = area.getBoundingClientRect();
        return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      },
      hovered: setDropArmed,
      take: (paths) => { setDropArmed(false); takeDrop.current(paths); },
    });
  }, [workspace]);
  // 上限的唯一来源是后端：这个数字在两处生效（界面提前提示、发送时真的拒绝），前端抄一份迟早会对不上。
  // 总开关关掉时这条命令按其他 AI 命令的约定直接拒绝，那就留初值，反正发不出去也就不用提示得更准。
  useEffect(() => {
    if (!cliDesktopAvailable()) return;
    void invoke<{ maxImages: number }>("ai_runtime_image_limits").then(({ maxImages }) => setImageLimit(maxImages)).catch(() => {});
  }, []);
  useEffect(() => {
    olderScroll.current = new OlderHistoryScroll();
    olderLocal.current = false;
  }, [session.id, workspace]);
  const scrollToBottom = () => {
    olderTop.current = null;
    const element = content.current;
    if (element) { element.scrollTop = element.scrollHeight; olderScroll.current.follow(element.scrollTop); }
  };
  /** 保存消息的内容坐标，用户滚动不会改变它，因此无需等待 scroll 事件更新锚点。 */
  const captureOlderAnchor = () => {
    const container = content.current;
    const top = container?.getBoundingClientRect().top ?? 0;
    const element = Array.from(container?.querySelectorAll<HTMLElement>(".ai-chat-entry, .ai-process-group") ?? [])
      .find((entry) => entry.getBoundingClientRect().bottom > top);
    return element && container ? {
      element, offset: element.getBoundingClientRect().top + container.scrollTop,
      height: container.scrollHeight, id: element.dataset.entryId,
    } : null;
  };
  useLayoutEffect(() => {
    if (olderLocal.current) { olderLocal.current = false; olderScroll.current.finish(); }
    const element = content.current;
    const before = olderTop.current;
    if (element === null || before === null) return;
    // 先接收尚未派发 scroll 事件的实际位移；自动补偿本身不算用户下滚。
    olderScroll.current.scroll(element.scrollTop);
    // 这一页真实长出来多高，就是滚动状态机算「提前两页」时的一页。
    olderScroll.current.measure(element.scrollHeight - before.height);
    const target = before.element.isConnected ? before.element : before.id
      ? element.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(before.id)}"]`) : null;
    // 过程组被合并、原条目被折叠时按新增高度补偿，不能直接丢掉阅读位置。
    element.scrollTop += target
      ? target.getBoundingClientRect().top + element.scrollTop - before.offset
      : element.scrollHeight - before.height;
    olderScroll.current.preserve(element.scrollTop);
    olderTop.current = runtime.loading ? captureOlderAnchor() : null;
  }, [runtime.entries, runtime.loading, timelineLimit]);
  useEffect(() => { if (!anchor) scrollToBottom(); }, [runtime.entries, runtime.requests, timelineLimit, anchor]);
  /**
   * 「更早」这一颗按钮做两件事，按顺序：先把已经加载但被窗口挡住的那段放出来，
   * 挡无可挡且后端说还有更早的记录时，才往前翻一页。
   *
   * 合成一颗而不是上下各摆一颗：分页改成从最新一页开始以后，「往上翻」只有一个方向。
   */
  const showEarlier = (initial = false) => {
    if (runtime.loading) return;
    const local = timeline.hidden > 0 || runtime.requests.length > timelineLimit;
    if (!local && (!workspace || !runtime.hasOlder)) return;
    const scroll = olderScroll.current;
    if (!scroll.begin(initial)) return;
    if (!initial) setAnchor((current) => trackFollow(current, false, tailId));
    if (local) {
      olderLocal.current = true;
      olderTop.current = initial ? null : captureOlderAnchor();
      setTimelineLimit((limit) => limit + TIMELINE_WINDOW * 3);
      return;
    }
    olderTop.current = initial ? null : captureOlderAnchor();
    setTimelineLimit((limit) => limit + TIMELINE_WINDOW * 3);
    const request = loadOlderAiMessages(session.id, workspace!, undefined, 3);
    olderRequest.current = request;
    void request.then(() => {
      scroll.finish();
    }, (cause) => {
      scroll.finish(true);
      if (scroll !== olderScroll.current) return;
      setError(String(cause)); olderTop.current = null;
    }).finally(() => {
      if (olderRequest.current === request) olderRequest.current = null;
      // 请求结束后再检查剩余距离，不依赖用户制造下一次 scroll 事件。
      if (scroll === olderScroll.current) refreshOlderScroll((value) => value + 1);
    });
  };
  /**
   * 发一条消息。
   *
   * `override` 是面板代打的文本（自动压缩、重试）：它绕过输入框，但斜杠命令校验、未保存检查和
   * 信任确认一律照走，而且事后不动用户正在写的半截话与已经贴好的附件。
   */
  const send = async (_accepted = false, override?: string) => {
    const text = override ?? draft;
    const queueEdit = override === undefined ? editingTask : null;
    if (!workspace || !cliDesktopAvailable() || sendingRef.current
      || (queueEdit ? !text.trim() : !text.trim() && !images.length)) return;
    // 子代理会话没有直连 CLI 的通道：消息包装后注入父会话，由父模型转发；
    // 转发痕迹留在父时间线，回复仍路由回这里。斜杠命令与附件在转发模式下没有意义。
    if (isAgentSession) {
      if (!text.trim() || override !== undefined) return;
      sendingRef.current = true; setSending(true); setError(null);
      try {
        await sendAiAgentMessage(session.id, workspace, text);
        commitDraft(""); setBrowse(null);
        setAnchor(null); setAtBottom(true); scrollToBottom();
      } catch (cause) { setError(String(cause)); }
      finally { sendingRef.current = false; setSending(false); }
      return;
    }
    const slash = parseSlash(text);
    const local = slash && localCommand(slash.name);
    sendingRef.current = true; setSending(true); setError(null); setCommandNotice(null);
    try {
      if (queueEdit) {
        await editQueuedAiTask(queueEdit.runId, text);
        // 更新成功才退出编辑态；失败时保留正文，用户仍可修正或复制。
        setEditingTask(null); commitDraft(queueEdit.restoreDraft); setBrowse(null);
        recallCaret.current = queueEdit.restoreDraft.length;
        requestAnimationFrame(() => input.current?.focus());
        return;
      }
      if (slash && override === undefined && images.length) throw new Error(t("ai.chat.imageCommandConflict"));
      if (local && slash) {
        if (local === "help") {
          if (slash.args.trim()) throw new Error(t("ai.commands.invalidArgs"));
          setShowHelp(true); setCommandsDismissed(false); setCommandIndex(0);
        } else {
          // /context 打开的是上下文芯片（在盒下状态行），不经设置芯片的命令接口。
          if (local === "context") { contextTrigger.current?.click(); }
          else {
            if (!composer.current) return;
            await composer.current.execute(local, slash.args);
          }
          setCommandNotice(t("ai.commands.localDone", { name: slash.name }));
        }
        commitDraft(""); setBrowse(null); return;
      }
      let command: AiCommandIntent | undefined;
      if (slash) {
        if (!slash.name) { setShowHelp(true); setCommandsDismissed(false); return; }
        if (session.provider === "codex") {
          if (slash.name === "compact") {
            if (slash.args.trim()) throw new Error(t("ai.commands.compactArgs"));
            if (!runtime.nativeId) throw new Error(t("ai.commands.needsSession"));
            command = "codexCompact";
          } else if (slash.name === "review") command = "codexReview";
          else throw new Error(t("ai.commands.unsupported"));
        } else {
          if (!runtime.commands) throw new Error(t("ai.commands.discovery"));
          if (!resolveNativeCommand(runtime.commands, slash.name)) throw new Error(t("ai.commands.unsupported"));
          command = "claudeSlash";
        }
      }
      if (beforeSend && !await beforeSend()) return;
      // 信任确认不再弹窗：项目是用户自己打开的，直接信任并随请求置位（对照用户决策）。
      await sendAiMessage(session, workspace, slash?.text ?? text, true, await selectedRunOptions(), command, override === undefined ? images.map((image) => image.path) : [], extraDirs);
      void loadAiMessages(session.id, workspace, true).catch(() => {});
      // 首条消息落盘后后端会把标题换成消息摘要：刷一次会话列表，侧栏与标签立即跟上。
      refreshAiSessionHistory();
      if (override === undefined) { commitDraft(""); setBrowse(null); setImages([]); setShowHelp(false); }
      rememberPrompt(workspace, text);
      setAnchor(null); setAtBottom(true); scrollToBottom();
    } catch (cause) { setError(String(cause)); }
    finally { sendingRef.current = false; setSending(false); }
  };
  const queuedTasks = aiQueueOrder(runtime.tasks);
  const ownedQueued = useMemo(() => new Set(ownedQueuedRunIds), [ownedQueuedRunIds]);
  const ownedQueuedTasks = queuedTasks.filter((task) => ownedQueued.has(task.runId));
  /** WebView2 会接管 HTML5 文件拖放；队列排序必须用 Pointer Events 才能在 Tauri 中生效。 */
  const startQueuePointerDrag = (event: ReactPointerEvent<HTMLSpanElement>, runId: string, owned: boolean) => {
    if (!owned || event.button !== 0) return;
    queuePointerDrag.current = {
      runId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false, drop: null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveQueuePointerDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = queuePointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
      drag.active = true;
    }
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-queue-id]");
    const runId = target?.dataset.queueId;
    if (!target || !runId || runId === drag.runId || !ownedQueued.has(runId)) {
      drag.drop = null; setQueueDrop(null); return;
    }
    const box = target.getBoundingClientRect();
    const drop = { runId, edge: event.clientY < box.top + box.height / 2 ? "before" as const : "after" as const };
    drag.drop = drop; setQueueDrop(drop);
  };
  const finishQueuePointerDrag = (event: ReactPointerEvent<HTMLSpanElement>, commit: boolean) => {
    const drag = queuePointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    queuePointerDrag.current = null; setQueueDrop(null);
    if (!commit || !drag.active || !drag.drop) return;
    const targetIndex = ownedQueuedTasks.findIndex((task) => task.runId === drag.drop!.runId);
    if (targetIndex < 0) return;
    const beforeRunId = drag.drop.edge === "after" ? ownedQueuedTasks[targetIndex + 1]?.runId ?? null : drag.drop.runId;
    if (beforeRunId === drag.runId) return;
    captureQueueFlip();
    void moveQueuedAiTask(drag.runId, beforeRunId).catch((cause) => setError(String(cause)));
  };
  const runningTask = runtime.tasks.find((task) => task.status === "running");
  const connectingTask = activity === "running" && ownedRunId
    ? runtime.tasks.find((task) => task.runId === ownedRunId && task.status === "submitting") : undefined;
  /** 权限拒绝指向文件时先问后端它的真实目录，再记进本会话的启动参数。 */
  const grantDirectory = async (path: string) => {
    const dir = await invoke<string>("ai_runtime_directory_for_path", { path });
    const next = [...new Set([...extraDirs, dir])].slice(0, 16);
    setExtraDirs(next);
    saveAdditionalDirs(workspace, session.id, next);
  };
  useEffect(() => { setDecidingPlan(false); }, [openPlan?.planId, openPlan?.revision, openPlan?.status]);
  /**
   * 这一轮跑的就是压缩。CLI 折上下文时前面除了「运行中」什么都不显示，
   * 用户只能看到进度条空转几十秒，以为卡住了——那件事本身要说出来。
   */
  // 项目目标库未包含 ES2023，倒序查找不依赖 findLast。
  const latestCompaction = [...runtime.entries].reverse().find((entry) => entry.name === "compaction" && entry.runId === runningTask?.runId);
  const compactionStatus = (latestCompaction?.input as Record<string, unknown> | undefined)?.status;
  const compacting = compactionStatus === "running" || compactionStatus === "compacting"
    || !latestCompaction && runningTask?.prompt?.trim().split(/\s+/, 1)[0] === COMPACT_COMMAND_TEXT;
  const requestsById = new Map(runtime.requests.map((request) => [request.requestId, request]));
  /** 已有请求卡的工具 id 集合：同一次提问的工具记录给请求卡让位，不画第二张。 */
  const requestToolIds = useMemo(() => new Set(runtime.requests.flatMap((request) => request.toolId ? [request.toolId] : [])), [runtime.requests]);
  /** 存在提问请求卡的轮次：旧日志的请求里没有 toolId，按「轮次里出现过提问卡」让位同样成立。 */
  const questionRequestRuns = useMemo(() => new Set(runtime.requests.filter((request) => request.kind === "question").map((request) => request.runId)), [runtime.requests]);
  /**
   * 顶层条目按「一轮」切分：一条用户消息到下一条用户消息之间。
   *
   * 不能按 runId 切——整段从原生日志导入的会话，每一条都写着 runId="native"，
   * 几十轮的改动会被压成时间线最末尾的一张卡；底栏那个数字也会随着往上翻越长越大。
   */
  const replyTurns = useMemo(() => {
    const groups: Array<{ runId: string; last: AiEntry; items: AiEntry[] }> = [];
    for (const entry of runtime.entries) {
      // 子代理的改动归它自己的委派卡，不进主时间线的这一轮。
      if (entry.parent) continue;
      if (entry.kind === "user" || !groups.length) groups.push({ runId: entry.runId, last: entry, items: [] });
      const group = groups[groups.length - 1];
      group.items.push(entry);
      group.last = entry;
      group.runId = entry.runId;
    }
    return groups;
  }, [runtime.entries]);
  // 底栏报的是「这一趟」的结果：只看最新那一轮，往上翻历史时它不该跟着变。
  const editSummary = useMemo(() => summarizeAiFileEdits(replyTurns.at(-1)?.items ?? []), [replyTurns]);
  // 子代理条目（带 parent 归属）不再平铺主时间线：按归属挂进对应 Task 委派卡展开看。
  // 若当前本身就是子代理会话，则时间线即为其专属视图，必须完整展示，不进行 parent 过滤。
  const subagentChildren = useMemo(() => {
    if (isAgentSession) return new Map<string, AiEntry[]>();
    const map = new Map<string, AiEntry[]>();
    for (const entry of runtime.entries) {
      if (!entry.parent) continue;
      const list = map.get(entry.parent);
      if (list) list.push(entry);
      else map.set(entry.parent, [entry]);
    }
    return map;
  }, [isAgentSession, runtime.entries]);
  const timelineEntries = useMemo(() => isAgentSession ? runtime.entries : runtime.entries.filter((entry) => !entry.parent), [isAgentSession, runtime.entries]);
  /** 任务清单是会话级事实，不再依赖当前时间线页是否包含它的最后一次更新。 */
  const taskList = runtime.taskList?.items.some((item) => item.status !== "dropped" && item.content.trim()) ? runtime.taskList : null;
  const taskListPhase = taskList?.runId ?? "none";
  const taskItems = taskList?.items.filter((item) => item.status !== "dropped" && item.content.trim()) ?? [];
  const completedTasks = taskItems.filter((item) => item.status === "complete" || item.status === "completed").length;
  const allTasksCompleted = taskItems.length > 0 && completedTasks === taskItems.length;
  const [taskListAnchor, setTaskListAnchor] = useState<HTMLButtonElement | null>(null);
  const [taskListDisclosure, setTaskListDisclosure] = useState<{ phase: string; open: boolean } | null>(null);
  // 仅在执行中且未全部完成时默认打开；已完成、空闲或点击进入历史会话时不默认弹开，用户在当前阶段手动操作后保持其状态。
  const taskListDefaultOpen = running && !allTasksCompleted;
  const taskListOpen = !!taskList && (taskListDisclosure?.phase === taskListPhase ? taskListDisclosure.open : taskListDefaultOpen);
  const attachTaskListTrigger = useCallback((node: HTMLButtonElement | null) => setTaskListAnchor(node), []);
  const setTaskListOpen = (open: boolean) => setTaskListDisclosure({ phase: taskListPhase, open });
  const goal = runtime.goal?.objective.trim() ? runtime.goal : null;
  const showMessageNav = runtime.loaded && !!(runtime.entries.length || outline.turns.length);
  const dockAgents = !isAgentSession && runtime.agents.length > 0;
  useEffect(() => {
    onAgentDockAvailable?.(dockAgents);
    return () => onAgentDockAvailable?.(false);
  }, [onAgentDockAvailable, dockAgents]);
  const currentTask = taskItems.find((item) => item.status === "in_progress" || item.status === "active")
    ?? taskItems.find((item) => item.status !== "complete" && item.status !== "completed");
  // 标题栏只承担扫视摘要：正文保留完整标题，这里最多露六个字符再收尾。
  const currentTaskLabel = currentTask ? (() => {
    const chars = Array.from(currentTask.content.trim());
    return chars.length > 6 ? `${chars.slice(0, 6).join("")}…` : chars.join("");
  })() : "";
  const goalKey = goal ? `${goal.threadId}:${goal.createdAt}:${goal.objective}` : null;
  const visibleGoal = goal && goalKey !== hiddenGoalKey ? goal : null;
  // 先折叠再开窗：反过来会把一整段过程劈成两半，两段各自都够不上折叠门槛，就都摊在屏幕上。
  // 传 running 是为了只留「正在想」那一条空思考：空正文的历史思考块摆成一排「思考」却点不出东西。
  const timeline = useMemo(() => windowAiTimeline(groupAiTimeline(timelineEntries, running), timelineLimit), [timelineEntries, running, timelineLimit]);
  // 「正在思考」只能给真正在动的那一条：本轮还在跑时它是末尾那条思考，其余都是想完的。
  const liveThinkingId = useMemo(() => liveThinking(timelineEntries, running)?.id ?? null, [timelineEntries, running]);
  const entryIds = useMemo(() => runtime.entries.map((entry) => entry.id), [runtime.entries]);
  // 只有露出来的那部分算「已就地渲染」；没渲染出来的待答复卡片改挂在输入框上方，不能跟着历史一起滚走。
  const inlineRequests = new Set(timeline.items.flatMap((item) => item.kind === "entry" && item.entry.kind === "request" && item.entry.requestId ? [item.entry.requestId] : []));
  const pendingCards = runtime.requests.filter((request) => request.active && !inlineRequests.has(request.requestId));
  const latestTask = runtime.tasks.at(-1);
  // 刚结束的那一轮（完成或失败）：给回合操作行用；正在跑或还有排队时不摆。
  const finishedTask = !running && latestTask && isAiTaskTerminal(latestTask.status) ? latestTask : null;
  /** 该轮最后一段有正文的回复，与它之前最近的一条用户消息（跳回那一条用）。 */
  const turnStats = useMemo(() => {
    if (!finishedTask) return null;
    let assistant: AiEntry | undefined;
    let user: AiEntry | undefined;
    for (const entry of runtime.entries) {
      if (entry.runId !== finishedTask.runId) continue;
      // 子代理的正文不算主回复：复制按钮给的应当是主对话自己的答案。
      if (entry.parent) continue;
      if (entry.kind === "assistant" && entry.text.trim()) assistant = entry;
      else if (entry.kind === "user") { user = entry; assistant = undefined; }
    }
    return assistant || user ? { text: assistant?.text, userId: user?.id } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只跟这一轮的归属走，entries 变化由 runId 兜底。
  }, [finishedTask?.runId, runtime.entries]);
  /** 正在流式输出的那条回复：给它做未闭合围栏的修复，免得半截代码块吞掉后面的字。 */
  const streamingEntryId = running ? runtime.entries.at(-1)?.id ?? null : null;
  /** 每轮最后一条顶层条目 → 该轮的文件汇总：轮内 edits 统计同底栏口径（不含子代理的改动）。 */
  const artifactsByLastEntry = useMemo(() => {
    const map = new Map<string, AiEditSummary>();
    for (const group of replyTurns) {
      // 正在跑的这一轮先不挂卡：改动还在往里加，挂上去就是一张数字一直跳的卡。
      if (running && group.runId === runtime.runId) continue;
      // 汇总卡挂在顶层该轮最后一个条目之后（不论收尾是消息、工具调用还是通知，只要有改动就必须呈现）。
      const summary = summarizeAiFileEdits(group.items);
      if (summary.fileCount) map.set(group.last.id, summary);
    }
    return map;
  }, [replyTurns, runtime.runId, running]);
  // 会话状态与任务状态共用同一批词；认不出就当 idle，让判定回到任务列表本身。
  const compact = useMemo(() => compactDecision({
    provider: session.provider,
    status: runtime.status,
    stopping: runtime.stopping,
    boundSession: !!runtime.nativeId,
    pendingRequests: runtime.requests.filter((request) => request.active).length,
    queuedTasks: queuedTasks.length,
    draft,
    context: runtime.context,
    usage: runtime.usage,
    model: options.model ?? undefined,
    prefs: compactPrefs,
    dismissed: compactDismissed,
  }), [session.provider, runtime.status, runtime.stopping, runtime.nativeId, runtime.requests, runtime.context, runtime.usage, queuedTasks.length, draft, options.model, compactPrefs, compactDismissed]);
  // 自动压缩达标就直接发 /compact。上一回合本身就是压缩时不再连发：摘要没能把比例压到阈值以下，
  // 就会一轮接一轮折下去；失败也不重发，这是这个后端从头到尾的约定。
  useEffect(() => {
    if (compact.action !== "fire" || latestTask?.prompt?.trim() === COMPACT_COMMAND_TEXT) return;
    void send(false, COMPACT_COMMAND_TEXT);
  }, [compact.action, latestTask?.runId]);
  const tailId = runtime.entries.at(-1)?.id;
  const unseen = unseenCount(anchor, entryIds);
  const prefetchEarlier = () => {
    const element = content.current;
    if (!element || pendingJump) return;
    const available = timeline.hidden > 0 || runtime.requests.length > timelineLimit || runtime.hasOlder;
    if (runtime.loaded && olderScroll.current.shouldFill(element.scrollHeight, element.clientHeight, available, runtime.loading)) {
      showEarlier(true);
      return;
    }
    if (olderScroll.current.shouldLoad(element.scrollTop, element.clientHeight,
      timeline.hidden > 0 || runtime.requests.length > timelineLimit || runtime.hasOlder, runtime.loading)) showEarlier();
  };
  // 每次补页提交后检查：不足两屏的短页会继续补，不需要点击按钮或再滚一下。
  // 仅在条目、请求、分页或加载状态变化时触发，严禁用户打字或光标操作时触发强制重排。
  useEffect(() => {
    prefetchEarlier();
  }, [runtime.entries.length, runtime.requests.length, runtime.loaded, runtime.loading, runtime.hasOlder, timeline.hidden, timelineLimit, pendingJump]);
  const trackScroll = () => {
    const element = content.current;
    if (!element) return;
    const delta = olderScroll.current.scroll(element.scrollTop);
    if (delta === 0) return;
    // 上翻即脱离跟随；底部容差只能用于向下滚动，不能把小幅上翻拉回底部。
    const near = delta > 0 && isNearBottom(element.scrollHeight, element.scrollTop, element.clientHeight);
    setAtBottom(near);
    // 首屏补页期间开始阅读，后续响应也必须补偿当前阅读位置。
    if (runtime.loading) olderTop.current = near ? null : captureOlderAnchor();
    setAnchor((current) => trackFollow(current, near, tailId));
    prefetchEarlier();
  };
  const jumpToBottom = () => { setAnchor(null); setAtBottom(true); scrollToBottom(); };
  /** 跳到任意一条已加载的条目（回合操作行「回到该轮消息」用）：复用导航跳转那套状态机。 */
  const jumpToEntryById = (id: string) => {
    olderTop.current = null;
    setAnchor((current) => current ?? { id: tailId ?? "" });
    setPendingJump({ id, waiting: false });
  };
  /**
   * 跳到导航里的某一行。正文已经加载到那一轮就直接滚；还没加载就先按序号往前补事件——
   * 走的是「更早」那条路径，游标连续往前挪，中间不留没读到的空洞。
   * 补完了正文里还是没有这一条，就如实说一句，而不是让点击没有下文。
   */
  const jumpToTurn = async (row: AiNavRow) => {
    olderTop.current = null;
    // 一决定跳就脱离贴底跟随：补历史期间每一页都会改 entries，锚点还空着的话那条 effect 会把视图一路拽回最后一条。
    setAnchor((current) => current ?? { id: tailId ?? "" });
    const willLoad = !row.loaded && !!workspace && row.seq !== undefined;
    setPendingJump({ id: row.id, waiting: willLoad });
    if (!willLoad) return;
    // 导航优先，但不能把预加载占用请求通道误判成目标不存在。
    await olderRequest.current?.catch(() => {});
    await loadAiMessagesThrough(session.id, workspace!, row.seq!).catch((cause) => { setError(String(cause)); return false; });
    setPendingJump((current) => current && current.id === row.id ? { ...current, waiting: false } : current);
  };
  /**
   * 落地待跳转的那一条。窗口数的是时间线项、而项不会多于条目，所以按「目标到末尾的条目数」一次放开到
   * 够用，不用「找不到就加大一档」地试；剩下只有「等这一帧提交进 DOM」一件事，交给重新渲染而不是定时器。
   */
  useLayoutEffect(() => {
    if (!pendingJump || pendingJump.waiting) return;
    const index = runtime.entries.findIndex((entry) => entry.id === pendingJump.id);
    if (index < 0) { setPendingJump(null); setError(t("ai.nav.tooOld")); return; }
    const needed = runtime.entries.length - index;
    if (needed > timelineLimit) { setTimelineLimit(needed + TIMELINE_WINDOW); return; }
    const element = content.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(pendingJump.id)}"]`);
    if (!element) return;
    setPendingJump(null);
    element.scrollIntoView({ block: "center" });
    if (content.current) olderScroll.current.follow(content.current.scrollTop);
    // 跳转可能发生在三页预取途中；剩余页到达时保持刚定位的消息。
    if (runtime.loading) olderTop.current = captureOlderAnchor();
    element.classList.add("is-flash");
    window.setTimeout(() => element.classList.remove("is-flash"), 1600);
  }, [pendingJump, runtime.entries, timeline, timelineLimit]);
  /** 子代理路由 key → 子会话 id；委派卡的「打开会话」入口靠它跳转。 */
  const agentSessionsByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of runtime.agents) if (agent.sessionId) map.set(agent.key, agent.sessionId);
    return map;
  }, [runtime.agents]);
  const handleImageLoad = useCallback(() => {
    /* 图片加载完才撑开高度：首屏贴底时不补这一下，打开带图的会话就停在底部上面一截。 */
    if (!anchor) scrollToBottom();
  }, [anchor]);

  const renderEntry = useCallback((entry: AiEntry): ReactNode => {
    if (entry.kind === "user") {
      return <article key={entry.id} data-entry-id={entry.id} className="ai-chat-entry is-user">
        <AiUserMessage
          text={entry.text}
          images={entry.images?.map((path) => ({
            key: path,
            node: (
              <button
                type="button"
                className="ai-msg-image"
                aria-label={t("ai.chat.previewImage")}
                title={t("ai.chat.previewImage")}
                onClick={() => setLightbox(path)}
              >
                <img
                  src={assetUrl(path, 0)}
                  alt={path.split(/[\\/]/).pop() ?? t("ai.chat.pastedImage")}
                  onLoad={handleImageLoad}
                  onError={(event) => {
                    event.currentTarget.alt = t("ai.chat.imageMissing");
                    event.currentTarget.classList.add("is-missing");
                  }}
                />
              </button>
            ),
          }))}
        />
      </article>;
    }
    return <AiChatEntryRow
      key={entry.id}
      entry={entry}
      request={requestsById.get(entry.requestId ?? "")}
      stopping={runtime.stopping}
      artifacts={artifactsByLastEntry.get(entry.id)}
      streaming={entry.id === streamingEntryId}
      liveThinking={entry.id === liveThinkingId}
      agentSession={!isAgentSession && entry.toolId ? agentSessionsByKey.get(entry.toolId) : undefined}
      subagents={subagentChildren.get(entry.toolId ?? "")}
      hasRequest={requestToolIds.has(entry.toolId ?? "") || questionRequestRuns.has(entry.runId)}
      onOpenSession={onOpenSession}
      onLightbox={setLightbox}
      onImageLoad={handleImageLoad}
      onBeforeAllow={snapshotBeforeAllow}
      onRestoreCheckpoint={restoreCheckpoint}
    />;
  }, [
    requestsById,
    restoreCheckpoint,
    snapshotBeforeAllow,
    runtime.stopping,
    artifactsByLastEntry,
    streamingEntryId,
    liveThinkingId,
    isAgentSession,
    agentSessionsByKey,
    subagentChildren,
    requestToolIds,
    questionRequestRuns,
    onOpenSession,
    handleImageLoad,
    t,
  ]);
  // 原生历史里提不出标题时 meta 就是空的；标题行不能是一条空白。
  const displayTitle = session.title || t("ai.untitledSession");
  return <AiOpenFileProvider onOpen={onOpenFile}>
  <section ref={pane} className="ai-session-pane" aria-label={displayTitle}
    style={{ "--ai-content-width": `${chatWidth.width}px` } as CSSProperties}>
    <header className="ai-session-pane-head">
      {/* 子代理会话的面包屑：返回按钮 + 父会话标题，再进入自己的标题。 */}
      {isAgentSession ? <>
        {onOpenSession && session.parentSessionId ? <button type="button" className="ai-head-back" title={t("ai.agent.backToParent")} aria-label={t("ai.agent.backToParent")}
          onClick={() => onOpenSession(session.parentSessionId!)}>
          <ChevronLeft size={14} aria-hidden />
          <span className="ai-head-parent">{parentTitle || t("ai.agent.parent")}</span>
        </button> : <span className="ai-head-parent"><Bot size={13} aria-hidden />{t("ai.agent.parent")}</span>}
        <ChevronRight size={14} className="ai-head-sep" aria-hidden />
      </> : null}
      <span className="ai-head-folder" title={workspace ?? undefined}>
        <FolderClosed size={13} aria-hidden />
        {workspace?.split(/[\\/]/).filter(Boolean).pop() ?? t("ai.noWorkspace")}
      </span>
      <ChevronRight size={14} className="ai-head-sep" aria-hidden />
      <span className={`ai-head-provider-icon${activity === "running" || running ? " is-running" : ""}`} aria-hidden>
        <AiProviderIcon provider={session.provider} size={14} />
      </span>
      <span className="ai-head-title" title={displayTitle}>{displayTitle}</span>
      <span className="ai-head-actions">
        {taskList ? <button ref={attachTaskListTrigger} type="button" className="ai-head-tasklist"
          title={currentTask && !allTasksCompleted ? `${t("ai.chat.taskList")} · ${currentTask.content}` : t("ai.chat.taskList")}
          aria-label={t("ai.chat.taskList")}
          aria-haspopup="dialog" aria-expanded={taskListOpen}
          onClick={() => {
            setHeadMenuAnchor(null);
            setTaskListOpen(!taskListOpen);
          }}>
          {allTasksCompleted
            ? <CheckCircle2 size={15} className="ai-head-tasklist-status is-complete" aria-hidden />
            : <Loader2 size={15} className="ai-head-tasklist-status is-spinning" aria-hidden />}
          <span className="ai-head-tasklist-count">{completedTasks}/{taskItems.length}</span>
          {!allTasksCompleted && currentTaskLabel
            ? <span className="ai-head-tasklist-current">{currentTaskLabel}</span>
            : null}
        </button> : null}
        {onAction || onNew ? <button type="button" className="ai-head-menu" title={t("ai.sidebar.moreOptions")} aria-label={t("ai.sidebar.moreOptions")}
          aria-haspopup="menu" aria-expanded={headMenuAnchor !== null}
          onClick={(event) => {
            setTaskListOpen(false);
            setHeadMenuAnchor(event.currentTarget);
          }}>
          <EllipsisVertical size={16} aria-hidden />
        </button> : null}
      </span>
      {taskList && taskListOpen && taskListAnchor ? (
        // 清单会在运行时自动展开；保持非模态，避免全屏遮罩吞掉用户对正文和其他面板的点击。
        <Popover anchor={taskListAnchor} boundary={pane.current} onClose={() => setTaskListOpen(false)}
          minWidth={320} maxWidth={360} modal={false} role="dialog">
          <section className="ai-head-tasklist-popover" aria-label={t("ai.chat.taskList")}>
            <header>
              <ListOrdered size={14} aria-hidden />
              <strong>{t("ai.chat.taskList")}</strong>
              <span className="status-spacer" />
              {/* 弹层自身必须有明确出口，用户不需要再回头寻找顶栏入口。 */}
              <button type="button" className="icon-button is-inline" onClick={() => setTaskListOpen(false)}
                aria-label={t("ai.runtime.collapseQueue")} title={t("ai.runtime.collapseQueue")}>
                <ChevronUp size={14} aria-hidden />
              </button>
            </header>
            <AiTaskListDockPanel taskList={taskList} running={running} onJump={(id) => {
              setTaskListOpen(false);
              jumpToEntryById(id);
            }} />
          </section>
        </Popover>
      ) : null}
      {headMenuAnchor ? (
        <Popover anchor={headMenuAnchor} onClose={() => setHeadMenuAnchor(null)} minWidth={200}>
          <div className="ai-add-menu" role="menu">
            {onNew ? <button type="button" role="menuitem" onClick={() => { setHeadMenuAnchor(null); onNew(); }}><Plus size={14} aria-hidden />{t("ai.newSession")}</button> : null}
            {onAction ? <button type="button" role="menuitem" onClick={() => { setHeadMenuAnchor(null); setHeadPending({ action: "rename", session }); }}><Pencil size={14} aria-hidden />{t("menu.rename")}</button> : null}
            {/* 跨会话提问要引用另一条会话的 ID：在这里复制当前这条。 */}
            <button type="button" role="menuitem" onClick={() => { setHeadMenuAnchor(null); void navigator.clipboard.writeText(session.id); }}><Copy size={14} aria-hidden />{t("ai.copySessionId")}</button>
            {onAction ? <button type="button" role="menuitem" onClick={() => { setHeadMenuAnchor(null); onAction({ type: "pin", id: session.id, pinned: session.pinned !== true }); }}>
              {session.pinned === true ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />}{session.pinned === true ? t("ai.sidebar.unpin") : t("ai.sidebar.pin")}
            </button> : null}
            {onAction ? <button type="button" role="menuitem" onClick={() => { setHeadMenuAnchor(null); onAction({ type: "archive", id: session.id, archived: session.archived !== true }); }}>
              <Archive size={14} aria-hidden />{session.archived === true ? t("ai.archived.restore") : t("ai.archived.button")}
            </button> : null}
            <button type="button" role="menuitem" onClick={() => { setHeadMenuAnchor(null); onSettings(); }}><Settings size={14} aria-hidden />{t("ai.manageCli")}</button>
            {onAction ? <button type="button" role="menuitem" className="is-danger" onClick={() => { setHeadMenuAnchor(null); setHeadPending({ action: "delete", session }); }}><Trash2 size={14} aria-hidden />{t("menu.delete")}</button> : null}
          </div>
        </Popover>
      ) : null}
    </header>
    <div className="ai-chat-viewport">
    {/* 列宽手柄挂在内容轴左右缘：命中区 12px、可见线 1px，拖拽对称放大。 */}
    <AiChatWidthHandles host={pane} />
    <div ref={content} className="ai-session-content ai-chat-content" style={{ overflowAnchor: "none" }} onScroll={trackScroll}
      onContextMenu={requestConversationMenu}
      onWheel={(event) => {
        // 内容不足一屏时没有 scroll 事件，向上滚轮仍应启动历史加载。
        olderScroll.current.intent(event.deltaY);
        prefetchEarlier();
      }}>
      <div className="ai-conversation">
      {/* 父会话必须自己声明已启动子代理；否则右栏收起时，用户完全不知道委派发生过。 */}
      {!isAgentSession && runtime.agents.length ? (() => {
        const liveAgents = runtime.agents.filter((agent) => agent.status === "running" || agent.status === "starting");
        const highlighted = liveAgents[0] ?? runtime.agents[runtime.agents.length - 1];
        const status = liveAgents.length ? "running" : highlighted.status;
        const label = status === "running" || status === "starting" ? t("ai.runtime.running")
          : status === "failed" ? t("ai.runtime.failed")
          : status === "stopped" ? t("ai.runtime.cancelled")
          : status ? t("ai.runtime.completed") : "";
        return <div className={`ai-parent-agent-strip${liveAgents.length ? " is-running" : ""}`} role="status" aria-live="polite">
          <button type="button" className="ai-parent-agent-trigger" aria-label={t("ai.agents.openDock")}
            title={t("ai.agents.openDock")} disabled={!onOpenAgentDock} onClick={onOpenAgentDock}>
            <Bot size={13} aria-hidden />
            <strong>{t("ai.agent.nav")}</strong>
            <span className="ai-parent-agent-count">{runtime.agents.length}</span>
            <span className="ai-parent-agent-title" title={highlighted.title}>{highlighted.title || t("ai.agent.untitled")}</span>
            <span className="ai-parent-agent-status" data-status={status}>{label}</span>
            <ChevronRight size={13} aria-hidden />
          </button>
        </div>;
      })() : null}
      {/* 子代理状态条：实时状态来自父连接；Codex 的完整正文由终态 rollout 回填。 */}
      {isAgentSession ? (() => {
        // 按会话 id 认领自己；万一父日志里混进别的 key，也不至于拿别人的状态。
        const self = runtime.agents.find((agent) => agent.sessionId === session.id) ?? runtime.agents[0];
        const status = self?.status ?? session.agent?.status ?? "";
        const label = status === "running" || status === "starting" ? t("ai.runtime.running")
          : status === "failed" ? t("ai.runtime.failed")
          : status === "stopped" ? t("ai.runtime.cancelled")
          : status ? t("ai.runtime.completed") : "";
        return <div className={`ai-agent-strip${status === "running" || status === "starting" ? " is-running" : ""}`} role="status">
          <Bot size={13} aria-hidden />
          <strong>{t("ai.agent.session")}</strong>
          <span className="ai-agent-strip-status" data-status={status}>{label}</span>
          {self?.model ? <span className="ai-agent-strip-model">{self.model}</span> : null}
        </div>;
      })() : null}
      {/* 往上只有一个方向：窗口里还藏着已加载的记录就先放窗口，放完了再问后端要更早的一页。 */}
      {timeline.hidden > 0 || runtime.hasOlder ? <div className="ai-earlier">
        {error ? <button type="button" className="ai-text-button" disabled={runtime.loading} onClick={() => showEarlier()}>
          <ChevronDown size={13} aria-hidden="true" />{timeline.hidden > 0 ? t("ai.runtime.showEarlier") : t("ai.runtime.loadOlder")}
        </button> : null}
        {runtime.loading && anchor ? <span className="ai-muted" role="status">{t("ai.runtime.loading")}</span> : null}
      </div> : null}
      {timeline.items.map((item) => item.kind === "process"
        ? <AiProcessGroup key={item.key} entries={item.entries} active={item.active} render={renderEntry} />
        : renderEntry(item.entry))}
      {/* 参考的回合错误行：未加盒的一行说明，圆圈叹号 + 灰字；重试由用户重发实现。 */}
      {latestTask?.error ? <div className="ai-turn-error" role="note"><CircleAlert size={14} aria-hidden /><p>{latestTask.error}</p></div> : null}
      {connectingTask ? <AiLiveStats provider={session.provider} runId={connectingTask.runId} entries={runtime.entries} usage={runtime.usage}
        statusText={runtime.stopping ? t("ai.lifecycle.stopping") : t("ai.runtime.submitting")} planMode={options.mode === "plan" || options.planMode === true} />
      : running ? <AiLiveStats provider={session.provider} runId={runtime.runId} entries={runtime.entries} usage={runtime.usage}
        statusText={compacting ? t("ai.compact.chipCompacting") : runtime.stopping ? t("ai.lifecycle.stopping") : t("ai.runtime.running")}
        planMode={options.mode === "plan" || options.planMode === true} /> : null}
      {finishedTask && turnStats ? <AiTurnStats runId={finishedTask.runId} usage={runtime.usage}
        lastAssistantText={turnStats.text} userEntryId={turnStats.userId} onJump={jumpToEntryById} /> : null}
      {!runtime.entries.length ? runtime.loading
        ? <p className="ai-chat-loading" role="status">{t("ai.runtime.loading")}</p>
        : <p className="ai-chat-empty">{isAgentSession ? (session.agent?.title || t("ai.agent.empty")) : workspace ? t("ai.chat.emptyHint", { provider: AI_NAMES[session.provider] }) : t("ai.noWorkspace")}</p> : null}
      </div>
    </div>
    {/* 浮在滚动区下沿，所以放在滚动容器之外：往上翻页和流式增长都不该把它跟着推走。 */}
    {!atBottom ? <AiJumpToBottom unseen={unseen} onClick={jumpToBottom} /> : null}
    {/* 消息导航恢复为会话正文右缘的浮动芯片；长会话可从这里按需读取完整轮次索引。 */}
    {showMessageNav ? <AiMessageNav key={session.id} entries={runtime.entries} outline={outline} hasOlder={runtime.hasOlder}
      onRequestOutline={() => { if (workspace) void loadAiOutline(session.id, workspace).catch(() => {}); }} onJump={jumpToTurn} /> : null}
    {/* 子代理列表同样停靠右栏：只在父会话显示（子会话自己就是那个代理）。 */}
    {!isAgentSession && runtime.agents.length && dockSlots.agents ? createPortal(
      <AiAgentDockPanel key={session.id} agents={runtime.agents} provider={session.provider} workspace={workspace}
        onOpen={(id) => onOpenSession?.(id)} />,
      dockSlots.agents,
    ) : null}
    </div>
    <footer className="ai-composer-dock">
    {visibleGoal ? <AiGoalBar goal={visibleGoal} busy={goalUpdating} onHide={() => {
      if (goalKey) setHiddenGoalKey(goalKey);
    }} onStatus={(status) => {
      if (!workspace || goalUpdating) return;
      setGoalUpdating(true); setError(null);
      void setAiGoalStatus(session.id, workspace, status)
        .catch((cause) => setError(String(cause)))
        .finally(() => setGoalUpdating(false));
    }} /> : null}
    {/* 待答复的卡片钉在输入框上方：正文一路往下滚的时候，不能让它跟着滚出屏幕——那等于本轮卡住却看不见卡在哪。 */}
    {pendingCards.length > 1 ? <p className="ai-session-requests-depth" role="status">{t("ai.runtime.requestsPending", { count: pendingCards.length })}</p> : null}
    {pendingCards.length ? <div className="ai-session-requests">{pendingCards.map((request) => <RequestCard key={request.requestId} request={request} stopping={runtime.stopping} onBeforeAllow={snapshotBeforeAllow} />)}</div> : null}
    {openPlan && workspace ? <AiPlanApproval plan={openPlan} disabled={decidingPlan || runtime.stopping || sending} key={`${openPlan.planId}:${openPlan.revision}`}
      onApprove={async () => { setDecidingPlan(true); try { await decideAiPlan(session, workspace!, openPlan, "approve", undefined, await selectedRunOptions(), extraDirs); } catch (cause) { setDecidingPlan(false); throw cause; } }}
      onRequestChanges={async (feedback) => { setDecidingPlan(true); try { await decideAiPlan(session, workspace!, openPlan, "requestChanges", feedback, await selectedRunOptions(), extraDirs); } catch (cause) { setDecidingPlan(false); throw cause; } }}
      onDefer={async () => { setDecidingPlan(true); try { await deferAiPlan(session.id, workspace!, openPlan.planId, openPlan.revision); } catch (cause) { setDecidingPlan(false); throw cause; } }} /> : null}
    {runtime.background && runtime.background.pending > 0 ? <section className="ai-background-strip" role="status">
      <Loader2 size={13} className="is-spinning" aria-hidden />
      <span>{t(runtime.background.settled ? "ai.background.settled" : "ai.background.pending", { count: runtime.background.pending })}</span>
    </section> : null}
    {runtime.permissionDenied && denialKey !== dismissedDenial ? <section className="ai-permission-denied" role="status">
      <CircleAlert size={14} aria-hidden />
      <div>
        <strong>{t("ai.permission.denied")}</strong>
        {runtime.permissionDenied.path ? <code>{runtime.permissionDenied.path}</code> : null}
        {runtime.permissionDenied.text ? <p>{runtime.permissionDenied.text}</p> : null}
      </div>
      {runtime.permissionDenied.path ? <button type="button" className="button is-primary" disabled={sending || runtime.stopping}
        onClick={() => void grantDirectory(runtime.permissionDenied!.path!).then(() => setDismissedDenial(denialKey)).catch((cause) => setError(String(cause)))}>
        {t("ai.permission.grantDirectory")}
      </button> : null}
      <button type="button" className="icon-button is-inline" aria-label={t("ai.permission.dismiss")} title={t("ai.permission.dismiss")}
        onClick={() => setDismissedDenial(denialKey)}><X size={13} /></button>
    </section> : null}
    {error || (runtime.error && runtime.error !== latestTask?.error ? runtime.error : null) ? <p className="ai-session-alert" role="alert">{error ?? runtime.error}</p> : null}
    {queuedTasks.length ? <section className="ai-task-queue" aria-label={t("ai.runtime.queue")} ref={queueHost}>
        <header>
          <button type="button" className="ai-task-queue-toggle" aria-expanded={queueExpanded} aria-controls={queueBodyId}
            aria-label={t(queueExpanded ? "ai.runtime.collapseQueue" : "ai.runtime.expandQueue")}
            title={t(queueExpanded ? "ai.runtime.collapseQueue" : "ai.runtime.expandQueue")}
            onClick={() => setQueueExpanded((expanded) => !expanded)}>
            {queueExpanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
            <ListOrdered size={14} aria-hidden /><strong>{t("ai.runtime.queue")}</strong><small>{queuedTasks.length}</small>
          </button>
          {ownedQueuedTasks.length ? <button type="button" className="ai-task-queue-clear" onClick={() => void clearQueuedAiTasks(session.id).catch((cause) => setError(String(cause)))}>{t("ai.runtime.clearQueue")}</button> : null}
        </header>
        <div className="ai-task-queue-list" id={queueBodyId} hidden={!queueExpanded}>
        {queuedTasks.map((task, index) => { const owned = ownedQueued.has(task.runId); const ownedIndex = ownedQueuedTasks.findIndex((item) => item.runId === task.runId); return <div key={task.runId} data-queue-id={task.runId} aria-current={editingTask?.runId === task.runId ? "true" : undefined}
          className={`ai-task-queue-item${owned ? " is-draggable" : " is-external"}${editingTask?.runId === task.runId ? " is-editing" : ""}${queueDrop?.runId === task.runId ? ` is-drop-${queueDrop.edge}` : ""}`}>
          <span role="button" className="ai-task-drag" tabIndex={owned ? 0 : -1}
            aria-disabled={!owned}
            aria-label={t("ai.runtime.reorderQueued")} title={t("ai.runtime.reorderQueued")}
            onPointerDown={(event) => startQueuePointerDrag(event, task.runId, owned)}
            onPointerMove={moveQueuePointerDrag}
            onPointerUp={(event) => finishQueuePointerDrag(event, true)}
            onPointerCancel={(event) => finishQueuePointerDrag(event, false)}
            onKeyDown={(event) => {
              if (!owned || ownedIndex < 0 || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
              const beforeRunId = event.key === "ArrowUp"
                ? ownedQueuedTasks[ownedIndex - 1]?.runId
                : ownedQueuedTasks[ownedIndex + 2]?.runId ?? null;
              if (event.key === "ArrowUp" && !beforeRunId || event.key === "ArrowDown" && ownedIndex >= ownedQueuedTasks.length - 1) return;
              event.preventDefault(); captureQueueFlip();
              void moveQueuedAiTask(task.runId, beforeRunId ?? null).catch((cause) => setError(String(cause)));
            }}><GripVertical size={14} aria-hidden /></span>
          {/* 序号属于任务正文，不属于拖拽图标；用普通文本保持列表阅读顺序。 */}
          <span className="ai-task-queue-index" aria-hidden>{index + 1}.</span>
          <p title={task.prompt}>{task.prompt || t("ai.runtime.queuedTask")}</p>
          {owned ? <span className="ai-task-queue-actions">
            {/* 队列是高频操作区：正文占主位，右侧只留图标；完整语义由 title 与 aria-label 承担。 */}
            <button type="button" className="ai-task-action" aria-label={t("ai.runtime.runQueuedNow")} title={t("ai.runtime.runQueuedNow")} onClick={() => void runQueuedAiTaskNow(task.runId).catch((cause) => setError(String(cause)))}><Send size={14} aria-hidden /></button>
            <button type="button" className="ai-task-action" aria-label={t("ai.runtime.editQueued")} title={t("ai.runtime.editQueued")} onClick={() => beginQueuedEdit(task.runId, task.prompt ?? "")}><Pencil size={14} aria-hidden /></button>
            <button type="button" className="ai-task-action is-danger" aria-label={t("ai.runtime.cancelQueued")} title={t("ai.runtime.cancelQueued")} onClick={() => void stopAiRun(task.runId).catch((cause) => setError(String(cause)))}><X size={14} aria-hidden /></button>
          </span> : <small className="ai-task-queue-owner">{t("ai.runtime.otherWindow")}</small>}
        </div>; })}
        </div>
      </section> : null}
    <div className={`ai-composer-wrap${editingTask ? " is-queue-editing" : ""}`} ref={attachArea}>
    <AiComposerShell
      overlay={<>
        {dropArmed ? <div className="ai-composer-drop" role="status">{t("ai.chat.dropImages")}</div> : null}
        {menuVisible ? <AiCommandMenu id={menuId} suggestions={suggestions} selected={selectedCommand} onChoose={chooseCommand}
          menuRef={commandMenu} showDiscovery={session.provider === "claude" && !runtime.commands} /> : null}
        {mentionVisible ? <AiMentionMenu id={`${menuId}-mention`} items={mentionItems} selected={Math.min(mentionIndex, mentionItems.length - 1)} onChoose={acceptMention} /> : null}
      </>}
      attachments={!editingTask && images.length ? <div className="ai-image-attachments" aria-label={t("ai.chat.images")}>
        {images.map((image) => <figure key={image.path}><button type="button" className="ai-msg-image" aria-label={t("ai.chat.previewImage")} title={t("ai.chat.previewImage")} onClick={() => setLightbox(image.path)}><img src={image.preview} alt={image.name} /></button><button type="button" className="ai-image-remove" aria-label={t("ai.chat.removeImage")} title={t("ai.chat.removeImage")} onClick={() => { setImages((current) => current.filter((item) => item.path !== image.path)); void invoke("ai_runtime_delete_image", { path: image.path }).catch(() => {}); }}><X size={12} /></button></figure>)}
      </div> : null}
      editor={<textarea ref={input} rows={2} aria-label={t("ai.message")} placeholder={isAgentSession ? t("ai.agent.relayPlaceholder") : editingTask ? t("ai.runtime.editingQueued") : `${t("ai.runtime.placeholder")} · ${t("ai.commands.hint")}`} value={draft} maxLength={16000}
        aria-autocomplete="list" aria-controls={menuVisible ? menuId : undefined} aria-expanded={menuVisible} aria-activedescendant={menuVisible ? `${menuId}-${selectedCommand}` : undefined}
              disabled={!workspace || !cliDesktopAvailable() || sending}
              onContextMenu={requestEditorMenu}
              onChange={(event) => {
                const caret = event.target.selectionStart ?? event.target.value.length;
                updateDraft(event.target.value);
                syncMention(event.target.value, caret);
              }}
              onPaste={(event) => {
                const files = collectPastedImages(event.clipboardData);
                if (!files.length) return;
                event.preventDefault();
                attach(files.map(pasteImage));
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (editingTask && event.key === "Escape") { event.preventDefault(); cancelQueuedEdit(); return; }
                // @ 文件建议优先于命令菜单与发送：Enter/Tab 收下建议，↑↓ 挑选，Esc 关闭。
                if (mentionVisible) {
                  const caret = event.currentTarget.selectionStart ?? 0;
                  const live = mentionAt(draft, caret);
                  if (!live) { setMention(null); setMentionItems([]); }
                  else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setMentionIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + mentionItems.length) % mentionItems.length);
                    return;
                  } else if (event.key === "Enter" && !event.shiftKey || event.key === "Tab") {
                    event.preventDefault();
                    acceptMention(mentionItems[Math.min(mentionIndex, mentionItems.length - 1)]);
                    return;
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setMention(null);
                    setMentionItems([]);
                    return;
                  }
                }
                if (menuVisible && !event.ctrlKey && !event.metaKey && !event.altKey) {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setCommandIndex((selectedCommand + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length); return; }
                  if (event.key === "Tab" && !event.shiftKey || event.key === "Enter" && !event.shiftKey) { event.preventDefault(); chooseCommand(suggestions[selectedCommand].name); return; }
                  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setCommandsDismissed(true); setShowHelp(false); return; }
                }
                // 命令菜单没出现时 ↑↓ 才归历史召回；光标不在首/末行说明用户在读自己写的多行文本，那时该移动光标。
                if (!menuVisible && !event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                  const caret = event.currentTarget.selectionStart ?? 0;
                  if (event.key === "ArrowUp" ? caretOnFirstLine(draft, caret) : caretOnLastLine(draft, caret)) {
                    if (recall(event.key === "ArrowUp")) event.preventDefault();
                    return;
                  }
                }
                // Esc 退出召回：把 ↑ 之前的那行（或用户在召回件上改出来的那行）还回去。
                if (!menuVisible && event.key === "Escape" && browse) {
                  event.preventDefault();
                  const next = browseCancel({ text: draft, browse });
                  commitDraft(next.text); setBrowse(next.browse); recallCaret.current = next.text.length;
                  return;
                }
                // 回车直接发送（Shift+Enter 换行）；Ctrl/⌘+Enter 同样发送，兼容旧习惯但不作提示。
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
              }} />}
      footer={editingTask || isAgentSession || activeCommand && !menuVisible || commandNotice ? <div className="ai-composer-notices">
        {editingTask ? <p className="ai-queue-edit-notice"><Pencil size={12} aria-hidden />{t("ai.runtime.editingQueued")}</p>
          : isAgentSession ? <p className="ai-agent-relay-notice"><Bot size={12} aria-hidden />{t("ai.agent.relayNotice")}</p>
          : activeCommand && !menuVisible ? <p className="ai-command-notice"><code>/{activeCommand.name} {activeCommand.argumentHint}</code> · {activeCommand.hintKey ? t(activeCommand.hintKey as Parameters<typeof t>[0]) : activeCommand.description}</p> : null}
        {commandNotice ? <p className="ai-command-notice" role="status">{commandNotice}</p> : null}
      </div> : null}
      toolbarLeft={<>
        {/* 转发模式没有附件与档位选择：模型与权限跟随父会话，界面不再给第二套。 */}
        {!isAgentSession ? <>
          <button type="button" className="ai-add-button" aria-label={t("ai.chat.attach")} title={t("ai.chat.attach")}
            disabled={!workspace || !cliDesktopAvailable() || sending || !!editingTask}
            onClick={(event) => setAddMenuAnchor(event.currentTarget)}><Plus size={16} /></button>
          <AiComposerOptions commandRef={composer} key={optionsKey} provider={session.provider} workspace={workspace} value={options} onChange={changeOptions} disabled={sending || !!editingTask || !cliDesktopAvailable()} actualModel={runtime.usage?.model ?? runtime.configuration?.model} />
        </> : null}
        {isPlanModeActive ? (
          <span className="ai-composer-plan-badge" title={t("ai.chat.inPlanModeNotice")}>
            <span className="ai-composer-plan-dot" />
            {t("ai.chat.planModeActive")}
            <button type="button" className="ai-composer-plan-exit" onClick={handleExitPlanMode} title={t("ai.chat.exitPlanMode")}>
              <X size={11} />
            </button>
          </span>
        ) : null}
      </>}
      toolbarRight={<>
        {/* 运行或排队中只留红色停止：并排再摆一颗禁用的发送，两颗圆钮挤在一起读作冲突。
            排队占位没有 runId 可停，那颗停止按钮走队首任务（后端按会话精确取消）。 */}
        {editingTask ? <>
          <button type="button" className="icon-button is-inline ai-queue-edit-cancel" aria-label={t("dialog.cancel")} title={t("dialog.cancel")} disabled={sending} onClick={cancelQueuedEdit}><X size={14} /></button>
          <button type="button" className="ai-send-button" aria-label={t("ai.runtime.saveQueued")} title={t("ai.runtime.saveQueued")} disabled={!draft.trim() || sending} onClick={() => void send()}><Check size={16} /></button>
        </> : activity === "running" && ownedRunId && (running || connectingTask)
          ? <button type="button" className="ai-send-button is-stop" aria-label={t("ai.runtime.stop")} title={t("ai.runtime.stop")} disabled={runtime.stopping} onClick={() => void stopAiRun(ownedRunId).catch((cause) => setError(String(cause)))}><Square size={13} fill="currentColor" /></button>
          : ownedQueuedTasks.length
            ? <button type="button" className="ai-send-button is-stop" aria-label={t("ai.runtime.stop")} title={t("ai.runtime.stop")} onClick={() => void stopAiRun(ownedQueuedTasks[0].runId).catch((cause) => setError(String(cause)))}><Square size={13} fill="currentColor" /></button>
            : <button type="button" className="ai-send-button" aria-label={t("ai.send")} title={t("ai.send")} disabled={!workspace || !cliDesktopAvailable() || !draft.trim() && !images.length || sending} onClick={() => void send()}><Send size={16} /></button>}
      </>}
    />
    {addMenuAnchor ? (
      <Popover anchor={addMenuAnchor} onClose={() => setAddMenuAnchor(null)} minWidth={200}>
        <div className="ai-add-menu">
          <button type="button" onClick={() => { setAddMenuAnchor(null); void pickImages(); }}>
            <Paperclip size={14} aria-hidden />{t("ai.chat.attach")}
          </button>
          <button type="button" onClick={() => { setAddMenuAnchor(null); updateDraft("/"); setShowHelp(true); input.current?.focus(); }}>
            <Command size={14} aria-hidden />{t("ai.commands.title")}
          </button>
        </div>
      </Popover>
    ) : null}
    <div className="ai-composer-caption"><span title={workspace ?? undefined}>{workspace?.split(/[\\/]/).filter(Boolean).pop() ?? t("ai.noWorkspace")}</span>
      {/* 本轮改过哪些文件属于「这一整趟的结果」，不属于某一条消息：收在底栏，点开往上浮。 */}
      {editSummary.fileCount ? <details className="ai-edit-summary"><summary><ChevronRight className="ai-detail-chevron" size={13} /><strong>{t(editSummary.fileCount === 1 ? "ai.chat.editedFile" : "ai.chat.editedFiles", { count: editSummary.fileCount })}</strong>{editSummary.additions !== undefined ? <><span className="is-add">+{editSummary.additions}</span><span className="is-delete">-{editSummary.deletions}</span></> : null}</summary>
        <ul>{editSummary.files.map((file) => <li key={file.path}>{file.kind ? <em className={`ai-edit-kind is-${file.kind}`}>{t(`ai.tool.${file.kind}`)}</em> : null}<code className="ai-file-path">{file.path}</code>{file.additions !== undefined ? <span><b>+{file.additions}</b> <i>-{file.deletions}</i></span> : null}</li>)}</ul>
      </details> : null}
      {extraDirs.length ? <details className="ai-edit-summary">
        <summary><ChevronRight className="ai-detail-chevron" size={13} /><strong>{t("ai.chat.extraDirs", { count: extraDirs.length })}</strong></summary>
        <ul>{extraDirs.map((dir) => <li key={dir}><code>{dir}</code><button type="button" className="icon-button is-inline" aria-label={t("ai.chat.removeExtraDir")} title={t("ai.chat.removeExtraDir")}
          onClick={() => { const next = extraDirs.filter((item) => item !== dir); setExtraDirs(next); saveAdditionalDirs(workspace, session.id, next); }}><X size={11} /></button></li>)}</ul>
      </details> : null}
      {runtime.mcpServers?.servers.length ? <details className="ai-edit-summary">
        <summary><ChevronRight className="ai-detail-chevron" size={13} /><strong>{t("ai.chat.mcpServers", { count: runtime.mcpServers.servers.length })}</strong></summary>
        <ul>{runtime.mcpServers.servers.map((server) => <li key={server.name}><code>{server.name}</code>{server.status ? <span className="ai-muted">{server.status}</span> : null}</li>)}</ul>
      </details> : null}
      <AiContextChip triggerRef={contextTrigger} provider={session.provider} usage={runtime.usage} context={runtime.context} contextUnavailable={runtime.contextUnavailable} actualModel={runtime.usage?.model ?? runtime.configuration?.model} selectedModel={options.model} compact={compact} autoCompact={compactPrefs.auto} compacting={compacting} onCompact={() => void send(false, COMPACT_COMMAND_TEXT)} onCompactLater={() => setCompactDismissed(compact.noticeId)} onAutoCompact={(next) => setCompactPrefs(writeCompactPrefs({ auto: next }))} />
    </div>
    </div>
    </footer>
    {headPending ? <AiActionDialog title={t(headPending.action === "rename" ? "menu.rename" : "ai.deleteSession")}
      confirm={t(headPending.action === "rename" ? "dialog.confirm" : "menu.delete")}
      initialValue={headPending.action === "rename" ? headPending.session.title : undefined} danger={headPending.action === "delete"}
      onCancel={() => setHeadPending(null)} onConfirm={(title) => {
        if (onAction) onAction(headPending.action === "rename" ? { type: "rename", id: headPending.session.id, title } : { type: "delete", id: headPending.session.id });
        setHeadPending(null);
      }}>
      {headPending.action === "delete" ? <p className="dialog-body">{t("ai.deleteConfirm", { name: headPending.session.title || t("ai.untitledSession") })}</p> : null}
    </AiActionDialog> : null}
    <AiImageDialog path={lightbox} onClose={() => setLightbox(null)} />
    {contextMenu ? <ContextMenu anchor={contextMenu} onClose={() => setContextMenu(null)} /> : null}
  </section>
  </AiOpenFileProvider>;
}
