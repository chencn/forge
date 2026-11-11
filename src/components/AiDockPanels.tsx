import { useMemo, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  Circle,
  CircleX,
  Loader2,
  Minimize2,
  Square,
} from "lucide-react";
import { useI18n } from "../i18n";
import type { AiAgentSummary, AiModelTaskList } from "../lib/aiRuntime";
import { stopAiAgent } from "../lib/aiRuntime";
import { Trace, TraceLine } from "./ui/trace";
import { Item } from "./ui/item";

/**
 * 展示模型任务清单与子代理列表，共用委派的状态、会话入口及停止能力。
 *
 * @param props - 任务、委派、提供商、工程范围及导航回调
 * @returns 任务侧栏；无任务或代理时省略对应区域
 */
export function AiTaskListDockPanel({
  taskList,
  running: _running,
  agents,
  provider,
  workspace,
  onOpenSession,
  onJump,
  onClose,
}: {
  /** 模型任务清单；未提供时仅展示代理。 */
  taskList?: AiModelTaskList | null;
  /** 父会话是否运行；代理状态独立读取生命周期。 */
  running: boolean;
  /** 按首次出现顺序传入的代理列表。 */
  agents?: AiAgentSummary[];
  /** 决定子代理是否支持单独停止。 */
  provider: "claude" | "codex";
  /** 停止请求的工程范围；为空时禁止发送。 */
  workspace: string | null;
  /** 打开独立代理会话；未提供时点击不派发导航。 */
  onOpenSession?: (id: string) => void;
  /** 跳转到模型任务关联的正文条目。 */
  onJump: (id: string) => void;
  /** 收起侧栏；未提供时不展示收起入口。 */
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const [expandEarlier, setExpandEarlier] = useState(false);
  const [expandLater, setExpandLater] = useState(false);

  const visible = taskList?.items.filter((item) => item.status !== "dropped" && item.content.trim()) ?? [];
  const completed = visible.filter((item) => item.status === "complete" || item.status === "completed").length;
  const allCompleted = visible.length > 0 && completed === visible.length;
  const activePlanIndex = visible.findIndex((item) => item.status === "in_progress" || item.status === "active");
  const currentStep = activePlanIndex >= 0 ? activePlanIndex + 1 : completed;

  const hasTasks = visible.length > 0;
  const hasAgents = Boolean(agents && agents.length > 0);

  // 滑动折叠窗口：当任务总数较多时，默认折叠前面已完成项和后面超额待办项
  const shouldFoldEarlier = visible.length > 4 && activePlanIndex > 1 && !expandEarlier;
  const earlierCount = shouldFoldEarlier ? activePlanIndex : 0;
  const remainingStartIndex = activePlanIndex >= 0 ? activePlanIndex : 0;
  const shouldFoldLater = visible.length - remainingStartIndex > 3 && !expandLater;
  const laterCutoff = shouldFoldLater ? remainingStartIndex + 3 : visible.length;
  const laterCount = shouldFoldLater ? visible.length - laterCutoff : 0;

  // 顶栏显示文本与步数
  const titleLabel = hasTasks ? t("ai.task.process") : t("ai.task.agents");
  const activeAgentIndex = agents?.findIndex((a) => a.status === "running" || a.status === "starting") ?? -1;
  const activeAgentStep = activeAgentIndex >= 0 ? activeAgentIndex + 1 : (agents?.length ?? 0);
  const stepCount = hasTasks ? `${currentStep}/${visible.length}` : `${activeAgentStep}/${agents?.length ?? 0}`;

  return (
    <Trace data-element="queue" className={`ai-taskdock${allCompleted ? " is-all-completed" : ""}`} aria-label={titleLabel}>
      {/* 顶栏：纯文本「进程/智能体  M/N」 + 收起操作按钮 */}
      <header className="ai-taskdock-header">
        <div className="ai-taskdock-header-title">
          <span className="ai-taskdock-title-label">{titleLabel}</span>
          <span className="ai-taskdock-step-count">{stepCount}</span>
        </div>
        <div className="ai-taskdock-header-actions">
          {onClose ? (
            <button
              type="button"
              className="ai-taskdock-action-btn"
              title={t("ai.runtime.collapseQueue")}
              aria-label={t("ai.runtime.collapseQueue")}
              onClick={onClose}
            >
              <Minimize2 size={13} aria-hidden />
            </button>
          ) : null}
        </div>
      </header>
      {/* Queue 就是代理真实的待办清单，与待发出的消息各自独立。 */}
      {hasTasks ? <progress className="ai-element-plan-progress" aria-label={titleLabel} max={visible.length} value={visible.filter((item) => item.status === "complete" || item.status === "completed").length} /> : null}

      {hasTasks ? (
        <div className="ai-taskdock-body">
          {/* 前置完成项折叠条：向左尖角 < + 浅灰色文字 */}
          {earlierCount > 0 ? (
            <button
              type="button"
              className="ai-taskdock-fold-btn"
              onClick={() => setExpandEarlier(true)}
            >
              <ChevronLeft size={13} aria-hidden />
              <span>{t("ai.task.earlier", { count: earlierCount })}</span>
            </button>
          ) : null}

          <ol className="ai-taskdock-list" role="list">
            {visible.map((item, index) => {
              if (shouldFoldEarlier && index < activePlanIndex) return null;
              if (shouldFoldLater && index >= laterCutoff) return null;

              const isDone = item.status === "complete" || item.status === "completed";
              const isActive = item.status === "in_progress" || item.status === "active";
              return (
                <li key={item.id || index} className={`ai-taskdock-item${isActive ? " is-active" : ""}${isDone ? " is-done" : ""}`}>
                  <TraceLine data-element="task" status={isActive ? "running" : isDone ? undefined : "pending"}><button type="button" className="ai-taskdock-row" onClick={() => onJump("session:task-list")}>
                    <span className="ai-taskdock-icon" aria-hidden>
                      {isActive ? (
                        <ArrowRight size={13} className="ai-taskdock-arrow" />
                      ) : isDone ? (
                        <CheckCircle2 size={13} className="ai-taskdock-done" />
                      ) : (
                        <Circle size={11} strokeWidth={1.5} className="ai-taskdock-circle" />
                      )}
                    </span>
                    <span className="ai-taskdock-text">
                      <span className="ai-taskdock-content">{item.content}</span>
                      {item.detail ? <span className="ai-taskdock-detail">{item.detail}</span> : null}
                    </span>
                  </button></TraceLine>
                </li>
              );
            })}
          </ol>

          {/* 后置待处理项折叠条：向左尖角 < + 浅灰色文字 */}
          {laterCount > 0 ? (
            <button
              type="button"
              className="ai-taskdock-fold-btn"
              onClick={() => setExpandLater(true)}
            >
              <ChevronLeft size={13} aria-hidden />
              <span>{t("ai.task.pending", { count: laterCount })}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 委派列表复用同一状态与停止入口，避免集成视图丢失控制能力。 */}
      {hasAgents ? (
        <div className={`ai-taskdock-agents-section${!hasTasks ? " is-primary" : ""}`}>
          {hasTasks ? (
            <div className="ai-taskdock-agents-header">
              <span>{t("ai.task.agents")}</span>
            </div>
          ) : null}
          <AiAgentDockPanel agents={agents!} provider={provider} workspace={workspace}
            onOpen={(id) => onOpenSession?.(id)} />
        </div>
      ) : null}
    </Trace>
  );
}

/** 子代理状态的统一文案：与运行状态词表同源，认不出的状态如实空着。 */
function agentStatusLabel(t: ReturnType<typeof useI18n>["t"], status: string): string {
  return status === "running" || status === "starting" ? t("ai.runtime.running")
    : status === "failed" ? t("ai.runtime.failed")
    : status === "stopped" ? t("ai.runtime.cancelled")
    : status === "completed" ? t("ai.runtime.completed")
    : "";
}

/**
 * 按生命周期展示委派，运行项置顶且编号稳定，Claude 运行项提供单独停止入口。
 *
 * @param props - 委派列表、提供商、工程范围及打开独立会话的回调
 * @returns 可操作的子代理列表；无代理时显示空态
 */
export function AiAgentDockPanel({ agents, provider, workspace, onOpen }: {
  agents: AiAgentSummary[];
  provider: "claude" | "codex";
  workspace: string | null;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const [stoppingKey, setStoppingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = (agent: AiAgentSummary) => agent.status === "running" || agent.status === "starting";
  // 运行中置顶，其余按首次出现顺序。
  const rows = useMemo(() => {
    const running = agents.filter(live);
    const settled = agents.filter((agent) => !live(agent));
    return [...running, ...settled];
  }, [agents]);

  const stop = async (agent: AiAgentSummary) => {
    if (!workspace || !agent.sessionId || stoppingKey) return;
    setStoppingKey(agent.key); setError(null);
    try { await stopAiAgent(agent.sessionId, workspace); }
    catch (cause) { setError(String(cause)); }
    finally { setStoppingKey(null); }
  };

  return <div className="ai-agentdock-body" aria-label={t("ai.agent.nav")}>
    {error ? <p className="ai-msgnav-note" role="alert">{error}</p> : null}
    {rows.map((agent) => (
      <Item key={agent.key} data-element="subagent" className="ai-agentdock-rowwrap">
        <button type="button" className="ai-agentdock-row" disabled={!agent.sessionId} title={agent.result ?? agent.title}
          onClick={() => agent.sessionId && onOpen(agent.sessionId)}>
          <span className="ai-agent-subrow-dot" data-status={agent.status} aria-hidden />
          <span className="ai-agentdock-title">{t("ai.agent.numbered", { index: agents.indexOf(agent) + 1 })}{agent.title ? ` · ${agent.title}` : ""}</span>
          {/* 旧 Codex 事件曾把随机 nickname 写进 agentType；无法可靠迁移，Codex 一律不展示该旧字段。 */}
          {provider === "claude" && agent.agentType ? <span className="ai-agentdock-type">{agent.agentType}</span> : null}
          {agent.model ? <span className="ai-agent-subrow-model">{agent.model}</span> : null}
          <span className="ai-agentdock-status" data-status={agent.status}>{agentStatusLabel(t, agent.status)}</span>
          <ArrowUpRight size={12} className="ai-taskchip-jump" aria-hidden />
        </button>
        {provider === "claude" && workspace && live(agent) && agent.sessionId ? (
          <button type="button" className="ai-agentdock-stop" disabled={stoppingKey !== null}
            title={t("ai.agent.stop")} aria-label={t("ai.agent.stop")}
            onClick={() => void stop(agent)}>
            {stoppingKey === agent.key ? <Loader2 size={11} className="is-spinning" aria-hidden /> : <Square size={11} aria-hidden />}
          </button>
        ) : null}
        {agent.status === "failed" ? <CircleX size={12} className="ai-agentdock-failed" aria-hidden /> : null}
      </Item>
    ))}
    {!rows.length ? <p className="ai-msgnav-empty">{t("ai.agent.empty")}</p> : null}
  </div>;
}
