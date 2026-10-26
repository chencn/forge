import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  CircleDashed,
  CircleX,
  Loader2,
  Square,
} from "lucide-react";
import { useI18n } from "../i18n";
import type { AiAgentSummary, AiModelTaskList } from "../lib/aiRuntime";
import { stopAiAgent } from "../lib/aiRuntime";

/**
 * 任务清单弹层正文：进度统计 + 进度条 + 清单，点击条目跳到正文
 * 对应清单位置。弹层标题和开关由 AiSessionPane 的会话标题栏提供。
 */
export function AiTaskListDockPanel({ taskList, running, onJump }: {
  taskList: AiModelTaskList;
  running: boolean;
  onJump: (id: string) => void;
}) {
  const { t } = useI18n();

  const visible = taskList.items.filter((item) => item.status !== "dropped" && item.content.trim());
  const completed = visible.filter((item) => item.status === "complete" || item.status === "completed").length;
  const allCompleted = completed === visible.length;
  const percent = Math.round((completed / visible.length) * 100);
  const activePlanItem = visible.find((item) => item.status === "in_progress" || item.status === "active");
  const activePosition = activePlanItem ? visible.indexOf(activePlanItem) + 1 : 0;

  return <div className={`ai-taskdock${allCompleted ? " is-all-completed" : ""}`} aria-label={t("ai.chat.taskList")}>
    <div className="ai-taskdock-meta">
      <span className="ai-taskchip-count">{completed}/{visible.length}</span>
      <span className="ai-taskchip-percent">{percent}%</span>
      {running && activePlanItem ? (
        <span className="ai-taskdock-active" title={`${activePosition}/${visible.length} · ${activePlanItem.content}`}>
          <Loader2 size={12} className="is-spinning" aria-hidden />
          {activePosition}/{visible.length}
        </span>
      ) : allCompleted && !running ? (
        <CheckCircle2 size={12} className="is-complete" aria-hidden />
      ) : null}
    </div>
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
  </div>;
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
          {agent.agentType ? <span className="ai-agentdock-type">{agent.agentType}</span> : null}
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
