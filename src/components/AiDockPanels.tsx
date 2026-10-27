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

/**
 * 任务清单侧栏工作区（像素级对照 6.png 的浮岛卡片 Task Dock 模式）：
 * 顶栏显示纯文本进程与操作区（... 与折叠收起）；
 * 中间使用滑动折叠视窗（< 前面 N 项 折叠、→ 当前步骤、○ 待办步骤、< 待处理 M 项 折叠）；
 * 底部整合极简的「智能体」协同分区。
 */
export function AiTaskListDockPanel({
  taskList,
  running: _running,
  agents,
  onOpenSession,
  onJump,
  onClose,
}: {
  taskList?: AiModelTaskList | null;
  running: boolean;
  agents?: AiAgentSummary[];
  onOpenSession?: (id: string) => void;
  onJump: (id: string) => void;
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
    <div className={`ai-taskdock${allCompleted ? " is-all-completed" : ""}`} aria-label={titleLabel}>
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

      {hasTasks ? (
        <div className="ai-taskdock-body">
          {/* 前置完成项折叠条（对照 6.png：向左尖角 < + 浅灰色文字） */}
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
                  <button type="button" className="ai-taskdock-row" onClick={() => onJump("session:task-list")}>
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
                  </button>
                </li>
              );
            })}
          </ol>

          {/* 后置待处理项折叠条（对照 6.png：向左尖角 < + 浅灰色文字） */}
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

      {/* 底部：极简智能体协同分区（对照 6.png，名称统一使用「子代理1」「子代理2」） */}
      {hasAgents ? (
        <div className={`ai-taskdock-agents-section${!hasTasks ? " is-primary" : ""}`}>
          {hasTasks ? (
            <div className="ai-taskdock-agents-header">
              <span>{t("ai.task.agents")}</span>
            </div>
          ) : null}
          <div className="ai-taskdock-agents-list">
            {agents!.map((agent, index) => {
              const numberedName = t("ai.agent.numbered", { index: index + 1 });
              const titleText = agent.title ? `${numberedName} · ${agent.title}` : numberedName;
              return (
                <div key={agent.key || agent.sessionId || index} className="ai-taskdock-agent-row">
                  <span className="ai-agent-subrow-dot" data-status={agent.status} aria-hidden />
                  {onOpenSession && agent.sessionId ? (
                    <button
                      type="button"
                      className="ai-taskdock-agent-btn"
                      onClick={() => onOpenSession(agent.sessionId!)}
                      title={titleText}
                    >
                      <span className="ai-taskdock-agent-title">{titleText}</span>
                    </button>
                  ) : (
                    <span className="ai-taskdock-agent-title" title={titleText}>
                      {titleText}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
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
 * 右侧工具窗口里的子代理列表内容（标题栏由右侧边栏框架统一提供）：
 * 会话里 Claude Agent 工具 / Codex collaboration 派生的子代理都在这里列出
 * （状态点 + 标题 + 类型/模型），运行中置顶。点行进入该子代理的独立会话视图；
 * Claude 的运行中代理可单独停止（stop_task）。
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
      <div key={agent.key} className="ai-agentdock-rowwrap">
        <button type="button" className="ai-agentdock-row" title={agent.result ?? agent.title}
          onClick={() => agent.sessionId && onOpen(agent.sessionId)}>
          <span className="ai-agent-subrow-dot" data-status={agent.status} aria-hidden />
          <span className="ai-agentdock-title">{agent.title || t("ai.agent.untitled")}</span>
          {/* 旧 Codex 事件曾把随机 nickname 写进 agentType；无法可靠迁移，Codex 一律不展示该旧字段。 */}
          {provider === "claude" && agent.agentType ? <span className="ai-agentdock-type">{agent.agentType}</span> : null}
          {agent.model ? <span className="ai-agent-subrow-model">{agent.model}</span> : null}
          <span className="ai-agentdock-status" data-status={agent.status}>{agentStatusLabel(t, agent.status)}</span>
          <ArrowUpRight size={12} className="ai-taskchip-jump" aria-hidden />
        </button>
        {provider === "claude" && live(agent) && agent.sessionId ? (
          <button type="button" className="ai-agentdock-stop" disabled={stoppingKey !== null}
            title={t("ai.agent.stop")} aria-label={t("ai.agent.stop")}
            onClick={() => void stop(agent)}>
            {stoppingKey === agent.key ? <Loader2 size={11} className="is-spinning" aria-hidden /> : <Square size={11} aria-hidden />}
          </button>
        ) : null}
        {agent.status === "failed" ? <CircleX size={12} className="ai-agentdock-failed" aria-hidden /> : null}
      </div>
    ))}
    {!rows.length ? <p className="ai-msgnav-empty">{t("ai.agent.empty")}</p> : null}
  </div>;
}
