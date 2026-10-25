import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Archive, ArrowUpRight, Brain, Check, CheckCircle2, ChevronUp, CircleAlert, CircleDashed, ChevronDown, ChevronRight, ChevronsUp, Command, Copy, EllipsisVertical, FilePenLine, FilePlus2, FolderClosed, GripVertical, ListOrdered, ListTodo, Loader2, Paperclip, Pause, Pencil, Pin, PinOff, Plane, Play, Plus, Send, Settings, Square, Target, Timer, Trash2, X } from "lucide-react";
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
import { clearQueuedAiTasks, decideAiPlan, deferAiPlan, editQueuedAiTask, loadAiMessages, loadAiMessagesThrough, loadAiOutline, loadOlderAiMessages, moveQueuedAiTask, respondAiRequest, runQueuedAiTaskNow, sendAiMessage, setAiGoalStatus, stopAiRun, useAiOutline, useAiOwnedQueuedRunIds, useAiOwnedRunId, useAiRuntime, useAiSessionActivity } from "../lib/aiRuntime";
import type { AiEntry, AiOutlineSnapshot, AiRequest, AiRunOptions, AiCommandIntent, AiModelTaskList, AiThreadGoal } from "../lib/aiRuntime";
import { buildNavRows, NAV_PAGE, navCount, visibleNavRows } from "../lib/aiMessageNav";
import type { AiNavRow } from "../lib/aiMessageNav";
import AiPlanApproval, { AiPlanEntry } from "./AiPlanCard";
import { openAiPlan } from "../lib/aiPlan";
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
import AiContextChip from "./AiContextChip";
import { aiNormalMode, loadAiOptions, saveAiOptions } from "../lib/aiOptions";
import AiToolDetails, { AiToolCall, AiToolSummary, CodeText } from "./AiToolDetails";
import AiDiffEditor from "./AiDiffEditor";
import { useAiDiffViewMode } from "../lib/aiDiffView";
import { AiOpenFileProvider, type AiOpenFile } from "./AiFileLink";
import { aiSessionStorageKey } from "../lib/aiSessions";
import type { AiSession, AiSessionAction } from "../lib/aiSessions";
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
function AiCompactionDivider({ entry }: { entry: AiEntry }) {
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
}

function TimelineNotice({ entry }: { entry: AiEntry }) {
  const { t } = useI18n();
  const data = entry.input && typeof entry.input === "object" && !Array.isArray(entry.input) ? entry.input as Record<string, unknown> : {};
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
}
function RequestCard({ request, stopping }: { request: AiRequest; stopping: boolean }) {
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
}

/** 用户消息的长文折叠线：超过这个行数先收起，底部渐隐提示还有更多。 */
const USER_MESSAGE_CLIP_LINES = 18;
const USER_MESSAGE_CLIP_CHARS = 1500;

/** 行首带 `>` 的行算引用（对照参考实现的 quote line）：排进带左线的引用段。 */
const USER_QUOTE_LINE = /^\s*>/;

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
      parts.push(line);
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
function AiUserMessage({ text, images }: { text: string; images?: { node: ReactNode; key: string }[] }) {
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
}

interface FloatingPos {
  left: number;
  top: number;
}

/**
 * 浮动挂件自由 2D 拖拽 Hook：
 * 支持在任何地方自由拖拽，自动限制在可视区域内（8px 安全边距）；
 * 面板展开状态切换时自动校验尺寸防右下边界溢出；
 * 点击与拖拽平滑解耦（微小位移视为点击）。
 */
function useFloatingDraggable(open: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<FloatingPos | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    initialLeft: number;
    initialTop: number;
    moved: boolean;
  } | null>(null);

  // 展开时校验位置：避免展开后宽度/高度溢出父容器右下边界
  useLayoutEffect(() => {
    if (!pos || !open || !containerRef.current) return;
    const container = containerRef.current;
    const parent = container.parentElement;
    if (!parent) return;
    const parentWidth = parent.clientWidth;
    const parentHeight = parent.clientHeight;
    const width = container.offsetWidth;
    const height = container.offsetHeight;
    if (pos.left + width > parentWidth - 8 || pos.top + height > parentHeight - 8) {
      setPos((prev) => {
        if (!prev) return null;
        return {
          left: Math.max(8, Math.min(parentWidth - width - 8, prev.left)),
          top: Math.max(8, Math.min(parentHeight - height - 8, prev.top)),
        };
      });
    }
  }, [open]);

  const startDrag = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    // 点击面板内部的具体交互按钮（如折叠按钮、重试按钮、列表项按钮等）时不启动拖拽
    if (target.closest("button") && !target.closest(".ai-floating-chip")) {
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const parent = container.parentElement;
    const parentRect = parent ? parent.getBoundingClientRect() : document.body.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const currentLeft = containerRect.left - parentRect.left;
    const currentTop = containerRect.top - parentRect.top;

    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      initialLeft: currentLeft,
      initialTop: currentTop,
      moved: false,
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const deltaX = e.clientX - dragRef.current.startX;
      const deltaY = e.clientY - dragRef.current.startY;
      if (!dragRef.current.moved && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
        dragRef.current.moved = true;
        setIsDragging(true);
      }
      if (dragRef.current.moved) {
        const parentWidth = parent ? parent.clientWidth : window.innerWidth;
        const parentHeight = parent ? parent.clientHeight : window.innerHeight;
        const currentWidth = container.offsetWidth || 32;
        const currentHeight = container.offsetHeight || 32;
        const clampedLeft = Math.max(8, Math.min(parentWidth - currentWidth - 8, dragRef.current.initialLeft + deltaX));
        const clampedTop = Math.max(8, Math.min(parentHeight - currentHeight - 8, dragRef.current.initialTop + deltaY));
        setPos({ left: clampedLeft, top: clampedTop });
      }
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      setTimeout(() => {
        setIsDragging(false);
        dragRef.current = null;
      }, 0);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  const isMoved = () => dragRef.current?.moved === true;

  return { containerRef, pos, isDragging, startDrag, isMoved };
}

/**
 * 右侧消息导航，对照参考实现的 Session Details 消息索引：收起时是右缘一颗
 * 小芯片（图标 + 消息数），展开为一张卡片，按顺序列出会话里每一轮用户消息（序号 +
 * 首行摘要 + 本轮改过的文件数），点击把正文滚到那条消息并闪一下定位高亮。
 *
 * 列表不跟着正文分页走：正文一页只装得下几百条事件，长会话里连一轮都铺不满，导航就会只剩
 * 一条记录。展开时另向后端要一份轮次索引（只有摘要和文件数，不带正文），一次列全，
 * 往上滚一档再加一档；点的行还没加载进正文，才按序号往前补事件。
 */
function AiMessageNav({ entries, outline, hasOlder, onRequestOutline, onJump }: {
  entries: AiEntry[];
  outline: AiOutlineSnapshot;
  /** 正文之外还有更早的记录；芯片上的条数据此带个 `+`，不冒充总数。 */
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
  /** 往上加一档之前量一次高度：新行插在上方会把视图推走，按差值把 scrollTop 补回来。 */
  const grewAt = useRef(0);
  const rows = useMemo(() => buildNavRows(entries, outline), [entries, outline]);
  const visible = useMemo(() => visibleNavRows(rows, rendered), [rows, rendered]);
  const count = navCount(rows, outline, hasOlder);
  const { containerRef, pos, isDragging, startDrag, isMoved } = useFloatingDraggable(open);

  const scrollToList = () => {
    if (grewAt.current) {
      const element = list.current;
      if (element) element.scrollTop += element.scrollHeight - grewAt.current;
      grewAt.current = 0;
    }
  };
  // 面板刚展开时落在最新那一轮：正文此刻就停在那里，导航不该把人甩回第一条。
  useLayoutEffect(() => {
    if (!open) return;
    const element = list.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [open]);
  useLayoutEffect(scrollToList, [visible]);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    // 索引只在第一次展开时扫：没点开面板就没必要读整份日志。
    if (next && !outline.loaded && !outline.loading) onRequestOutline();
  };
  const grow = () => {
    const element = list.current;
    if (!element || rows.length <= visible.length) return;
    if (element.scrollTop > 60) return;
    grewAt.current = element.scrollHeight;
    setRendered((value) => value + NAV_PAGE);
  };
  const jump = async (row: AiNavRow) => {
    setActiveId(row.id);
    if (row.loaded) { await onJump(row); return; }
    // 未加载的那一轮要先往前补事件，几百轮的老会话这一步会持续一会儿，得让人看见它在动。
    setPendingId(row.id);
    try { await onJump(row); } finally { setPendingId(null); }
  };
  const handleChipClick = () => {
    if (isMoved()) return;
    toggle();
  };

  return <div
    className={`ai-msgnav${open ? " is-open" : ""}${isDragging ? " is-dragging" : ""}`}
    ref={containerRef}
    style={pos ? { left: `${pos.left}px`, top: `${pos.top}px`, right: "auto", bottom: "auto", transform: "none" } : undefined}
  >
    {open ? <div className="ai-msgnav-panel">
      <header onPointerDown={startDrag} title={t("ai.nav.title")}>
        <GripVertical size={13} className="ai-msgnav-drag-handle" aria-hidden />
        <strong>{t("ai.nav.title")}</strong>
        <span className="ai-msgnav-count">{count}</span>
        <button type="button" className="ai-msgnav-collapse" aria-label={t("ai.sidebar.collapseAll")} onClick={() => setOpen(false)}>
          <ChevronRight size={14} className="is-flipped" aria-hidden />
        </button>
      </header>
      {/* 状态行放在滚动区之外：往上加一档时它一直钉在那里，才看得到「上面还有」；
          列表里也只留行本身，role="list" 不该混进非 listitem 的子节点。 */}
      {outline.loaded && !outline.complete ? <p className="ai-msgnav-note">{t("ai.nav.partial")}</p> : null}
      {rows.length > visible.length ? <p className="ai-msgnav-note">{t("ai.nav.older", { count: rows.length - visible.length })}</p> : null}
      {outline.loading ? <p className="ai-msgnav-note" role="status"><Loader2 size={11} className="is-spinning" aria-hidden />{t("ai.runtime.loading")}</p> : null}
      {outline.error ? <p className="ai-msgnav-note" role="alert">{outline.error}<button type="button" className="ai-text-button" onClick={onRequestOutline}>{t("ai.nav.retry")}</button></p> : null}
      <div className="ai-msgnav-list" role="list" ref={list} onScroll={grow}>
        {visible.map((row) => (
          <div key={row.id} role="listitem" className="ai-msgnav-rowwrap">
            <button type="button" className={row.id === activeId ? "is-active" : ""} onClick={() => void jump(row)}>
              <span className="ai-msgnav-ordinal" aria-hidden>{row.id === pendingId ? <Loader2 size={11} className="is-spinning" /> : row.ordinal}</span>
              <span className="ai-msgnav-label" title={row.label}>{row.label || t("ai.message")}</span>
              {row.files ? <span className="ai-msgnav-files">{t("ai.nav.files", { count: row.files })}</span> : null}
            </button>
            {/* 当前行展开文件卡（对照参考实现的展开态）：路径只有已加载进正文的那几轮才有，没加载的只报数量。 */}
            {row.id === activeId && row.paths?.length ? <div className="ai-msgnav-files-card">
              {row.paths.slice(0, 8).map((path) => <code key={path} className="ai-msgnav-file">{path.split(/[\\/]/).pop() || path}</code>)}
              {row.paths.length > 8 ? <span className="ai-msgnav-files-more">+{row.paths.length - 8}</span> : null}
            </div> : null}
          </div>
        ))}
        {!rows.length && !outline.loading && !outline.error ? <p className="ai-msgnav-empty">{t("ai.nav.empty")}</p> : null}
      </div>
    </div> : (
      <button type="button" className="ai-msgnav-chip ai-floating-chip" title={t("ai.nav.title")} aria-label={t("ai.nav.title")} aria-expanded={false}
        onPointerDown={startDrag} onClick={handleChipClick}>
        <ListOrdered size={12} aria-hidden />
        <span className="ai-msgnav-chip-label">{count}</span>
      </button>
    )}
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
 * 新增的默认展开（绿卡）、改动/删除的默认收起；头部给「N 个文件 + 总 ±行数」，
 * 展开是逐文件卡——点文件跳编辑器。统计口径与底栏汇总同源（只算真实完成的补丁）。
 */
function AiReplyArtifacts({ summary }: { summary: AiEditSummary }) {
  const { t } = useI18n();
  const added = summary.files.filter((file) => file.kind === "add");
  const changed = summary.files.filter((file) => file.kind !== "add");
  const [openNew, setOpenNew] = useState(true);
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
}

/**
 * 回合完成后的操作行（对照参考实现的 TurnStats，砍掉协议不支持的分叉/转任务）：
 * 耗时、token 数、复制最后一段回复、跳回本轮的用户消息。回合失败也有这一行——
 * 失败原因另有错误行，这里的统计与动作同样成立。
 */
function AiTurnStats({ runId, usage, lastAssistantText, userEntryId, onJump }: {
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
}

/** Goal 是会话级控制器，固定在输入区上方；Task 仍是标题栏里的步骤概览。 */
function AiGoalBar({ goal, busy, onStatus }: {
  goal: AiThreadGoal;
  busy: boolean;
  onStatus: (status: "active" | "paused") => void;
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
    </button> : null}
  </section>;
}

/**
 * 任务清单贴边面板：
 * 贴在右侧边缘（消息导航旁边），有任务清单时默认展开，收起时为半圆药丸芯片；
 * 支持按住卡片头部或贴边芯片上下拖动位置（自动限制在视口边界内）；
 * 点击条目可跳转至正文时间线中对应清单位置。
 */
function AiTaskListChip({ taskList, running, onJump }: {
  taskList: AiModelTaskList;
  running: boolean;
  onJump: (id: string) => void;
}) {
  const { t } = useI18n();
  // 有清单时默认展开
  const [open, setOpen] = useState(true);
  // 用户拖动后的纵向像素位置；未拖动时按默认 CSS 贴边定位
  const [top, setTop] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    startY: number;
    initialTop: number;
    moved: boolean;
  } | null>(null);

  const visible = taskList.items.filter((item) => item.status !== "dropped" && item.content.trim());
  const completed = visible.filter((item) => item.status === "complete" || item.status === "completed").length;
  const allCompleted = completed === visible.length;
  const percent = Math.round((completed / visible.length) * 100);

  // 有新进展（完成数变化或条目增减）且面板收着时点亮；点开就视为看过。
  const signature = `${taskList.seq}:${visible.length}:${completed}:${running ? 1 : 0}`;
  const [lastSignature, setLastSignature] = useState(signature);
  const dirty = !open && signature !== lastSignature;

  const toggle = () => {
    setOpen((current) => {
      if (!current) setLastSignature(signature);
      return !current;
    });
  };

  // 支持拖动面板垂直位置：限制在父级可视区边界内
  const startDrag = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    // 点击关闭/折叠/跳转等具名按钮时不触发拖拽
    if (target.closest("button") && !target.closest(".ai-taskchip-chip")) {
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const parent = container.parentElement;
    const parentRect = parent ? parent.getBoundingClientRect() : document.body.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const currentTop = containerRect.top - parentRect.top;

    dragRef.current = {
      startY: event.clientY,
      initialTop: currentTop,
      moved: false,
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const deltaY = e.clientY - dragRef.current.startY;
      if (!dragRef.current.moved && Math.abs(deltaY) > 3) {
        dragRef.current.moved = true;
        setIsDragging(true);
      }
      if (dragRef.current.moved) {
        const parentHeight = parent ? parent.clientHeight : window.innerHeight;
        const currentHeight = container.offsetHeight || 32;
        // 留出 8px 上下安全边距
        const clampedTop = Math.max(8, Math.min(parentHeight - currentHeight - 8, dragRef.current.initialTop + deltaY));
        setTop(clampedTop);
      }
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      setTimeout(() => {
        setIsDragging(false);
        dragRef.current = null;
      }, 0);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  const handleChipClick = () => {
    if (dragRef.current?.moved) return;
    toggle();
  };

  // 按下 Esc 键时快捷收起面板
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const activePlanItem = visible.find((item) => item.status === "in_progress" || item.status === "active");
  const activePosition = activePlanItem ? visible.indexOf(activePlanItem) + 1 : 0;

  return <div
    className={`ai-taskchip${open ? " is-open" : ""}${running ? " is-running" : ""}${allCompleted ? " is-all-completed" : ""}${isDragging ? " is-dragging" : ""}`}
    ref={containerRef}
    style={top !== null ? { top: `${top}px`, transform: "none" } : undefined}
  >
    {open ? <div className="ai-taskchip-panel" role="region" aria-label={t("ai.chat.taskList")}>
      <header onPointerDown={startDrag} title={t("ai.chat.taskList")}>
        <div className="ai-taskchip-header-title">
          <GripVertical size={13} className="ai-taskchip-drag-handle" aria-hidden />
          <ListTodo size={14} className="ai-taskchip-header-icon" aria-hidden />
          <strong>{t("ai.chat.taskList")}</strong>
          <div className="ai-taskchip-stats">
            <span className="ai-taskchip-count">{completed}/{visible.length}</span>
            <span className="ai-taskchip-percent">{percent}%</span>
          </div>
        </div>
        <button type="button" className="ai-taskchip-collapse" aria-label={t("ai.sidebar.collapseAll")} title={t("ai.sidebar.collapseAll")} onClick={() => setOpen(false)}>
          <ChevronRight size={14} className="is-flipped" aria-hidden />
        </button>
      </header>
      <div className="ai-taskchip-progress-bar" role="progressbar" aria-valuenow={completed} aria-valuemin={0} aria-valuemax={visible.length}>
        <div className={`ai-taskchip-progress-fill${allCompleted ? " is-complete" : ""}`} style={{ width: `${percent}%` }} />
      </div>
      <div className="ai-taskchip-body">
        <ol className="ai-taskchip-list" role="list">
          {visible.map((item, index) => {
            const isDone = item.status === "complete" || item.status === "completed";
            const isActive = item.status === "in_progress" || item.status === "active";
            return <li key={item.id || index} className={`is-${item.status}`}>
              <button type="button" className="ai-taskchip-row" onClick={() => onJump("session:task-list")}>
                <span className="ai-plan-entry-icon" aria-hidden>
                  {isDone ? <CheckCircle2 size={14} className="is-complete" /> : isActive ? <Loader2 size={14} className="is-spinning" /> : <CircleDashed size={14} />}
                </span>
                <span className="ai-plan-entry-text">
                  <span className="ai-taskchip-item">{item.content}</span>
                  {item.detail ? <small className="ai-taskchip-detail">{item.detail}</small> : null}
                </span>
                <ArrowUpRight size={13} className="ai-taskchip-jump" aria-hidden />
              </button>
            </li>;
          })}
        </ol>
      </div>
    </div> : null}
    <button type="button"
      className={`ai-taskchip-chip${dirty ? " is-dirty" : ""}${open ? " is-active" : ""}${allCompleted && !running ? " is-success" : ""}`}
      title={t("ai.chat.taskList")}
      aria-label={t("ai.chat.taskList")}
      aria-expanded={open}
      onPointerDown={startDrag}
      onClick={handleChipClick}
    >
      {running && activePlanItem ? (
        <Loader2 size={12} className="ai-taskchip-icon is-spinning" aria-hidden />
      ) : allCompleted && !running ? (
        <CheckCircle2 size={12} className="ai-taskchip-icon is-complete" aria-hidden />
      ) : (
        <ListTodo size={12} className="ai-taskchip-icon" aria-hidden />
      )}
      <span className="ai-taskchip-progress">{completed}/{visible.length}</span>
      {running && activePlanItem && !open ? (
        <span className="ai-taskchip-active-text" title={activePlanItem.content}>{activePosition}/{visible.length} · {activePlanItem.content}</span>
      ) : null}
      {dirty ? <span className="ai-taskchip-dot" aria-hidden="true" /> : null}
    </button>
  </div>;
}

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
}

/**
 * 一个 AI 会话的完整界面：消息时间线、请求卡片、输入框与运行控制。
 *
 * 组件本身不持有跨会话状态，所有会话数据都在 `lib/aiRuntime` 的全局 store 里，
 * 所以切走再切回来能直接看到后台仍在推进的进度。
 */
export default function AiSessionPane({ session, workspace, onSettings, beforeSend, onAction, onNew, onOpenFile }: AiSessionPaneProps) {
  const { t } = useI18n();
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
  /** 队列编辑借用主输入框；restoreDraft 保证用户原来写到一半的草稿不会被队列正文覆盖。 */
  const [editingTask, setEditingTask] = useState<{ runId: string; restoreDraft: string } | null>(null);
  /** 横幅 ⋯ 菜单与重命名/删除确认。 */
  const [headMenuAnchor, setHeadMenuAnchor] = useState<HTMLElement | null>(null);
  const [headPending, setHeadPending] = useState<{ action: "rename" | "delete"; session: AiSession } | null>(null);
  const draggedTask = useRef<string | null>(null);
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
  const commandMenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuVisible) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target !== input.current && !commandMenu.current?.contains(event.target as Node)) { setCommandsDismissed(true); setShowHelp(false); }
    };
    window.addEventListener("pointerdown", dismiss, true);
    return () => window.removeEventListener("pointerdown", dismiss, true);
  }, [menuVisible]);
  /** 改输入框就顺手落一次盘：存不下只是下次重启看不到半截话，不值得打扰发送；空了就删键，别攒一堆空记录。 */
  const commitDraft = (text: string) => {
    setDraft(text);
    if (text) saveDraft(workspace, session.id, text); else clearDraft(workspace, session.id);
  };
  const updateDraft = (text: string) => {
    // 编辑队列时输入框只是临时工作区，不能拿队列正文覆盖持久草稿。
    if (editingTask) setDraft(text); else commitDraft(text);
    // 直接在召回来的那行上改字：位置留住，改动记进 stash，走出历史时还回得到用户自己打的字。
    if (browse) setBrowse(browseTyped(text, { text, browse }).browse);
    setCommandsDismissed(false); setShowHelp(false); setCommandIndex(0); setCommandNotice(null);
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
  useEffect(() => { setOptions(loadAiOptions(optionsKey, session.provider)); setDraft(loadDraft(workspace, session.id)); setEditingTask(null); setBrowse(null); setImages([]); setDropArmed(false); setTimelineLimit(TIMELINE_WINDOW); setCompactDismissed(null); setError(null); setAnchor(null); setAtBottom(true); setPendingJump(null); olderTop.current = null; }, [optionsKey, session.id, workspace]);
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
      await sendAiMessage(session, workspace, slash?.text ?? text, true, options, command, override === undefined ? images.map((image) => image.path) : [], extraDirs);
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
  const subagentChildren = useMemo(() => {
    const map = new Map<string, AiEntry[]>();
    for (const entry of runtime.entries) {
      if (!entry.parent) continue;
      const list = map.get(entry.parent);
      if (list) list.push(entry);
      else map.set(entry.parent, [entry]);
    }
    return map;
  }, [runtime.entries]);
  const timelineEntries = useMemo(() => runtime.entries.filter((entry) => !entry.parent), [runtime.entries]);
  /** 任务清单是会话级事实，不再依赖当前时间线页是否包含它的最后一次更新。 */
  const taskList = runtime.taskList?.items.some((item) => item.status !== "dropped" && item.content.trim()) ? runtime.taskList : null;
  const goal = runtime.goal?.objective.trim() ? runtime.goal : null;
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
  useEffect(() => { prefetchEarlier(); });
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
  const renderEntry = (entry: AiEntry): ReactNode => {
    if (entry.kind === "request") {
      const request = requestsById.get(entry.requestId ?? "");
      return request ? <RequestCard key={entry.id} request={request} stopping={runtime.stopping} /> : null;
    }
    // 回合末尾的文件汇总卡：只挂在顶层条目之后（折在过程组/浏览组里就成了套娃），
    // 且正在跑的那一轮不挂——它还在改。统计口径同底栏（真实完成的补丁、按路径去重）。
    const artifacts = artifactsByLastEntry.get(entry.id);
    const body = <article key={entry.id} data-entry-id={entry.id} className={`ai-chat-entry is-${entry.kind}`}>
      {entry.kind === "user" ? <AiUserMessage text={entry.text} images={entry.images?.map((path) => ({ key: path, node: <button type="button" className="ai-msg-image" aria-label={t("ai.chat.previewImage")} title={t("ai.chat.previewImage")} onClick={() => setLightbox(path)}><img src={assetUrl(path, 0)} alt={path.split(/[\\/]/).pop() ?? t("ai.chat.pastedImage")} onLoad={() => { /* 图片加载完才撑开高度：首屏贴底时不补这一下，打开带图的会话就停在底部上面一截。 */ if (!anchor) scrollToBottom(); }} onError={(event) => { /* 文件被清掉时不编占位图：把 alt 换成一句实话，坏图本来就会显示 alt。 */ event.currentTarget.alt = t("ai.chat.imageMissing"); event.currentTarget.classList.add("is-missing"); }} /></button> }))} /> : entry.kind === "assistant" || entry.kind === "command" ? <>
        {entry.kind === "command" ? <small className="ai-muted">{t("ai.commands.output")}</small> : null}
        <AiMarkdown text={entry.text} streaming={entry.id === streamingEntryId} />
      </> : entry.kind === "tool" ? <AiToolCall entry={entry} subagents={subagentChildren.get(entry.toolId ?? "")} hasRequest={requestToolIds.has(entry.toolId ?? "") || questionRequestRuns.has(entry.runId)} /> : entry.kind === "reasoning" ? <details className="ai-reasoning"><summary className="ai-row-head"><Brain size={13} aria-hidden className="ai-entry-icon" /><span aria-hidden className="ai-entry-dot" /><span className="ai-row-label">{entry.id === liveThinkingId ? t("ai.chat.reasoningLive") : t("ai.chat.reasoning")}</span><ChevronRight className="ai-detail-chevron" size={14} aria-hidden />{entry.text ? <span className="ai-reasoning-title" aria-hidden={entry.id === liveThinkingId ? "true" : undefined}>{entry.id === liveThinkingId ? (entry.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "") : (entry.text.split(/\r?\n/).find((line) => line.trim()) ?? "")}</span> : null}</summary><AiMarkdown text={entry.text} /></details>
        : entry.kind === "notice" ? <TimelineNotice entry={entry} />
        // 「已报告的文件变动」fallback 行撤掉：一级已有每次修改的明细行 + 回合末尾的汇总卡，
        // 再铺一条只报文件名的清单是三份重复（有修改文件显示就不要它）。
        : null}
    </article>;
    return artifacts ? <Fragment key={entry.id}>{body}<AiReplyArtifacts summary={artifacts} /></Fragment> : body;
  };
  // 原生历史里提不出标题时 meta 就是空的；标题行不能是一条空白。
  const displayTitle = session.title || t("ai.untitledSession");
  return <AiOpenFileProvider onOpen={onOpenFile}>
  <section ref={pane} className="ai-session-pane" aria-label={displayTitle}
    style={{ "--ai-content-width": `${chatWidth.width}px` } as CSSProperties}>
    <header className="ai-session-pane-head">
      <span className="ai-head-folder" title={workspace ?? undefined}>
        <FolderClosed size={13} aria-hidden />
        {workspace?.split(/[\\/]/).filter(Boolean).pop() ?? t("ai.noWorkspace")}
      </span>
      <ChevronRight size={14} className="ai-head-sep" aria-hidden />
      <span className="ai-head-title" title={displayTitle}>{displayTitle}</span>
      {onAction || onNew ? <button type="button" className="ai-head-menu" title={t("ai.sidebar.moreOptions")} aria-label={t("ai.sidebar.moreOptions")}
        aria-haspopup="menu" aria-expanded={headMenuAnchor !== null}
        onClick={(event) => setHeadMenuAnchor(event.currentTarget)}>
        <EllipsisVertical size={16} aria-hidden />
      </button> : null}
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
      onWheel={(event) => {
        // 内容不足一屏时没有 scroll 事件，向上滚轮仍应启动历史加载。
        olderScroll.current.intent(event.deltaY);
        prefetchEarlier();
      }}>
      <div className="ai-conversation">
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
        : <p className="ai-chat-empty">{workspace ? t("ai.chat.emptyHint", { provider: AI_NAMES[session.provider] }) : t("ai.noWorkspace")}</p> : null}
      </div>
    </div>
    {/* 浮在滚动区下沿，所以放在滚动容器之外：往上翻页和流式增长都不该把它跟着推走。 */}
    {!atBottom ? <AiJumpToBottom unseen={unseen} onClick={jumpToBottom} /> : null}
    {/* 右侧贴边任务清单：吸附在右边缘（消息导航旁边），有清单时默认展开，支持拖动垂直位置 */}
    {taskList ? <AiTaskListChip taskList={taskList} running={running} onJump={jumpToEntryById} /> : null}
    {/* 芯片只要会话读过就挂着：长会话的首屏可能一条用户消息都没落进那一页事件里，
        按「有没有已加载的用户消息」来隐藏，导航就永远没机会被点开、也就永远取不到索引。 */}
    {runtime.loaded && (runtime.entries.length || outline.turns.length) ? <AiMessageNav key={session.id} entries={runtime.entries} outline={outline} hasOlder={runtime.hasOlder}
      onRequestOutline={() => { if (workspace) void loadAiOutline(session.id, workspace).catch(() => {}); }} onJump={jumpToTurn} /> : null}
    </div>
    <footer className="ai-composer-dock">
    {goal ? <AiGoalBar goal={goal} busy={goalUpdating} onStatus={(status) => {
      if (!workspace || goalUpdating) return;
      setGoalUpdating(true); setError(null);
      void setAiGoalStatus(session.id, workspace, status)
        .catch((cause) => setError(String(cause)))
        .finally(() => setGoalUpdating(false));
    }} /> : null}
    {/* 待答复的卡片钉在输入框上方：正文一路往下滚的时候，不能让它跟着滚出屏幕——那等于本轮卡住却看不见卡在哪。 */}
    {pendingCards.length ? <div className="ai-session-requests">{pendingCards.map((request) => <RequestCard key={request.requestId} request={request} stopping={runtime.stopping} />)}</div> : null}
    {openPlan && workspace ? <AiPlanApproval plan={openPlan} disabled={decidingPlan || runtime.stopping || sending} key={`${openPlan.planId}:${openPlan.revision}`}
      onApprove={async () => { setDecidingPlan(true); try { await decideAiPlan(session, workspace!, openPlan, "approve", undefined, options, extraDirs); } catch (cause) { setDecidingPlan(false); throw cause; } }}
      onRequestChanges={async (feedback) => { setDecidingPlan(true); try { await decideAiPlan(session, workspace!, openPlan, "requestChanges", feedback, options, extraDirs); } catch (cause) { setDecidingPlan(false); throw cause; } }}
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
          className={`ai-task-queue-item${owned ? " is-draggable" : " is-external"}${editingTask?.runId === task.runId ? " is-editing" : ""}${queueDrop?.runId === task.runId ? ` is-drop-${queueDrop.edge}` : ""}`}
          draggable={owned}
          onDragStart={(event) => {
            // WebView2 不可靠地启动 button[draggable]；整行才是用户眼里的任务，也是稳定的拖拽源。
            draggedTask.current = task.runId; setQueueDrop(null);
            event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", task.runId);
          }}
          onDragEnd={() => { draggedTask.current = null; setQueueDrop(null); }}
          onDragOver={(event) => {
            const runId = draggedTask.current;
            if (!owned || !runId || runId === task.runId) return;
            event.preventDefault(); event.dataTransfer.dropEffect = "move";
            const box = event.currentTarget.getBoundingClientRect();
            setQueueDrop({ runId: task.runId, edge: event.clientY < box.top + box.height / 2 ? "before" : "after" });
          }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setQueueDrop(null); }}
          onDrop={(event) => {
            event.preventDefault();
            const runId = draggedTask.current;
            const box = event.currentTarget.getBoundingClientRect();
            const after = event.clientY >= box.top + box.height / 2;
            const beforeRunId = after ? ownedQueuedTasks[ownedIndex + 1]?.runId ?? null : task.runId;
            draggedTask.current = null; setQueueDrop(null);
            if (owned && runId && runId !== task.runId && beforeRunId !== runId) {
              // 落点提示会触发重渲染，FLIP 必须在真正提交排序前重新取位置。
              captureQueueFlip();
              void moveQueuedAiTask(runId, beforeRunId).catch((cause) => setError(String(cause)));
            }
          }}>
          <button type="button" className="ai-task-drag" disabled={!owned}
            aria-label={t("ai.runtime.reorderQueued")} title={t("ai.runtime.reorderQueued")}
            onKeyDown={(event) => {
              if (!owned || ownedIndex < 0 || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
              const beforeRunId = event.key === "ArrowUp"
                ? ownedQueuedTasks[ownedIndex - 1]?.runId
                : ownedQueuedTasks[ownedIndex + 2]?.runId ?? null;
              if (event.key === "ArrowUp" && !beforeRunId || event.key === "ArrowDown" && ownedIndex >= ownedQueuedTasks.length - 1) return;
              event.preventDefault(); captureQueueFlip();
              void moveQueuedAiTask(task.runId, beforeRunId ?? null).catch((cause) => setError(String(cause)));
            }}><GripVertical size={14} aria-hidden /></button>
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
      </>}
      attachments={!editingTask && images.length ? <div className="ai-image-attachments" aria-label={t("ai.chat.images")}>
        {images.map((image) => <figure key={image.path}><button type="button" className="ai-msg-image" aria-label={t("ai.chat.previewImage")} title={t("ai.chat.previewImage")} onClick={() => setLightbox(image.path)}><img src={image.preview} alt={image.name} /></button><button type="button" className="ai-image-remove" aria-label={t("ai.chat.removeImage")} title={t("ai.chat.removeImage")} onClick={() => { setImages((current) => current.filter((item) => item.path !== image.path)); void invoke("ai_runtime_delete_image", { path: image.path }).catch(() => {}); }}><X size={12} /></button></figure>)}
      </div> : null}
      editor={<textarea ref={input} rows={2} aria-label={t("ai.message")} placeholder={editingTask ? t("ai.runtime.editingQueued") : `${t("ai.runtime.placeholder")} · ${t("ai.commands.hint")}`} value={draft} maxLength={16000}
        aria-autocomplete="list" aria-controls={menuVisible ? menuId : undefined} aria-expanded={menuVisible} aria-activedescendant={menuVisible ? `${menuId}-${selectedCommand}` : undefined}
              disabled={!workspace || !cliDesktopAvailable() || sending}
              onChange={(event) => updateDraft(event.target.value)}
              onPaste={(event) => {
                const files = collectPastedImages(event.clipboardData);
                if (!files.length) return;
                event.preventDefault();
                attach(files.map(pasteImage));
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (editingTask && event.key === "Escape") { event.preventDefault(); cancelQueuedEdit(); return; }
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
      footer={editingTask || activeCommand && !menuVisible || commandNotice ? <div className="ai-composer-notices">
        {editingTask ? <p className="ai-queue-edit-notice"><Pencil size={12} aria-hidden />{t("ai.runtime.editingQueued")}</p>
          : activeCommand && !menuVisible ? <p className="ai-command-notice"><code>/{activeCommand.name} {activeCommand.argumentHint}</code> · {activeCommand.hintKey ? t(activeCommand.hintKey as Parameters<typeof t>[0]) : activeCommand.description}</p> : null}
        {commandNotice ? <p className="ai-command-notice" role="status">{commandNotice}</p> : null}
      </div> : null}
      toolbarLeft={<>
        <button type="button" className="ai-add-button" aria-label={t("ai.chat.attach")} title={t("ai.chat.attach")}
          disabled={!workspace || !cliDesktopAvailable() || sending || !!editingTask}
          onClick={(event) => setAddMenuAnchor(event.currentTarget)}><Plus size={16} /></button>
        <AiComposerOptions commandRef={composer} key={optionsKey} provider={session.provider} workspace={workspace} value={options} onChange={changeOptions} disabled={sending || !!editingTask || !cliDesktopAvailable()} actualModel={runtime.usage?.model ?? runtime.configuration?.model} />
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
  </section>
  </AiOpenFileProvider>;
}
