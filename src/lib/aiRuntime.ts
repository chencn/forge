import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import type { AiSession } from "./aiSessions";
import { isAiTaskBackendActive, isAiTaskBackendStatus, isAiTaskLive, isAiTaskQueued, isAiTaskTerminal, type AiTaskStatus } from "./aiTaskStatus";
import { normalizeAiUsage } from "./aiUsage";
import type { AiUsage } from "./aiUsage";
import { normalizeAiContext } from "./aiContext";
import type { AiContext } from "./aiContext";
import { normalizeCommandCatalog } from "./aiCommands";
import type { AiCommandCatalog } from "./aiCommands";
import type { AiRequestAnswer } from "./aiApprovals";
import { createFrameNotifier } from "./aiFrame";
export type AiCommandIntent = "claudeSlash" | "codexCompact" | "codexReview";

/** 一轮运行可选的模型与思考强度；两者都为空表示沿用 CLI 默认。 */
export interface AiRunOptions {
  /** 模型 id；必须在 `AiCapabilities.models` 里或由用户自定义输入。 */
  model?: string;
  /** 思考强度；只有该模型声明支持的档位才可传。 */
  effort?: string;
  /**
   * 会话模式，取 CLI 亲口报出的原话 id（Claude 的 `--permission-mode` 取值、
   * Codex 的 collaborationMode 取值）。计划模式就是其中一项，不是一个开关。
   */
  mode?: string;
  /** 默认按需审批；read 只允许只读工具，auto 的范围由 CLI 决定，full 为明确授权的完全访问。 */
  permission?: "read" | "ask" | "auto" | "full";
  /** Codex 的 Fast 服务等级，false 明确恢复标准速度。 */
  fast?: boolean;
  /** 旧数据里的计划模式布尔；新选择一律写进 `mode`，读取时按同一语义迁移。 */
  planMode?: boolean;
}

/** 一份计划审阅记录；状态与后端 plans.json 一一对应。 */
export interface AiPlanReview {
  planId: string;
  sessionId: string;
  nativeId: string;
  workspace: string;
  runId?: string | null;
  revision: number;
  title: string;
  content: string;
  contentHash: string;
  complete: boolean;
  nativePlanId: string;
  execPermission: string;
  status: "awaiting_review" | "submitting" | "approved" | "changes_requested" | "deferred" | "expired" | "superseded";
  execution: "not_started" | "running" | "completed" | "failed" | "unknown";
  decision?: string | null;
  appliedAt?: number | null;
  createdAt: number;
  updatedAt: number;
  supersededBy?: number | null;
  /** 事件序号；来自历史文件而非事件时为 undefined。 */
  seq?: number;
}

/** CLI 报告的后台任务数；settled 表示当前回合已交还用户。 */
export interface AiBackground { pending: number; settled: boolean }
/** headless 下被权限系统拒绝的一次调用。 */
export interface AiPermissionDenied { tool?: string; path?: string; text: string }
/** CLI 实际加载的 MCP 服务快照。 */
export interface AiMcpSnapshot { servers: Array<{ name: string; status?: string | null }>; tools?: string[] }

/** CLI 报告的一个可选模型。 */
export interface AiModelOption {
  /** 官方目录项 ID，可能不同于实际调用参数 id。 */
  catalogId?: string;
  /** Claude 配置的别名目标，只展示，不冒充服务端实际运行模型。 */
  configuredModel?: string;
  /** 传给 CLI 的模型标识。 */
  id: string;
  /** 界面显示的名字。 */
  name: string;
  /** 该模型支持的思考强度档位；为空表示不支持调节。 */
  efforts: string[];
  /** 每档强度的说明文字（CLI 目录自带）；弹层按当前档展示。 */
  effortDescriptions?: Record<string, string>;
  /** Claude 槽位（opus/sonnet/haiku/fable）被用户配置后，标记所属槽位。 */
  customSlot?: string;
  /** Claude 的 ANTHROPIC_CUSTOM_MODEL_OPTION 条目：用户在 CLI 配置里追加的模型。 */
  customOption?: boolean;
  /** 模型的一句话说明（CLI 目录自带）。 */
  description?: string;
  /** CLI 建议的默认强度。 */
  defaultEffort?: string;
  /** 是否为 CLI 当前默认模型。 */
  isDefault?: boolean;
  /** CLI 原样报告的服务等级，不猜测 Fast 的协议取值。 */
  serviceTiers?: Array<{ id: string; name: string; description: string }>;
}

/** CLI 的模型能力清单，用于渲染模型与强度下拉。 */
export interface AiCapabilities {
  /** Forge 独立维护的用户自定义列表，允许显式增删。 */
  customModels?: string[];
  /** 可用模型列表。 */
  models: AiModelOption[];
  /** 是否允许用户自己输入模型 id（列表外的模型）。 */
  customModel: boolean;
  /** 所有模型共有的强度档位，用于在没有具体模型时兜底展示。 */
  efforts: string[];
  /** 这版 CLI 提供的会话模式取值；空表示只探测到内置兜底表。 */
  modes?: string[];
  /** 模式表是不是 CLI 亲口报的；false 时界面仍可用，但不能当成这版 CLI 的事实。 */
  modesAuthoritative?: boolean;
  /** 这份目录是否 CLI 亲口报的；false 说明只是 Forge 内置别名表，不能当成事实。 */
  authoritative: boolean;
  /** 这一次是现问 CLI 拿的，还是沿用磁盘上的上次结果。 */
  remote: boolean;
  /** 报出这份目录的 CLI 版本；后端按它判断缓存是否已经过期。 */
  cliVersion?: string | null;
}
/** Codex 通过 app-server config/read 返回的当前项目有效配置。 */
export interface AiProjectConfig {
  model?: string;
  effort?: string;
  /** 仅精确匹配的官方组合使用快捷名；custom 时由下面两个原始字段说明真实配置。 */
  permission: "read" | "ask" | "auto" | "full" | "custom";
  sandboxMode?: string;
  approvalPolicy?: string;
  serviceTier?: string;
}
const projectConfigs = new Map<string, { value?: AiProjectConfig; pending?: Promise<AiProjectConfig> }>();
function projectConfigKey(workspace: string) {
  const normalized = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}
function requestAiProjectConfig(workspace: string, force: boolean): Promise<AiProjectConfig> {
  const key = projectConfigKey(workspace);
  const current = projectConfigs.get(key);
  if (current?.pending) return current.pending;
  if (!force && current?.value) return Promise.resolve(current.value);
  const pending = invoke<AiProjectConfig>("ai_runtime_project_config", { workspace }).then((value) => {
    if (projectConfigs.get(key)?.pending === pending) projectConfigs.set(key, { value });
    return value;
  }).catch((error) => {
    if (projectConfigs.get(key)?.pending === pending) {
      if (current?.value) projectConfigs.set(key, { value: current.value });
      else projectConfigs.delete(key);
    }
    throw error;
  });
  projectConfigs.set(key, { value: current?.value, pending });
  return pending;
}
export function loadAiProjectConfig(workspace: string): Promise<AiProjectConfig> {
  return requestAiProjectConfig(workspace, false);
}
/** 项目激活时重新读取 CLI 的有效配置；失败保留上一份缓存。 */
export function refreshAiProjectConfig(workspace: string): Promise<AiProjectConfig> {
  return requestAiProjectConfig(workspace, true);
}
export type AiProjectConfigPatch = { model?: string | null; effort?: string | null; permission?: Exclude<AiProjectConfig["permission"], "custom"> | null; serviceTier?: string | null };
export function updateAiProjectConfig(workspace: string, patch: AiProjectConfigPatch): Promise<AiProjectConfig> {
  return invoke<AiProjectConfig>("ai_runtime_update_project_config", { workspace, patch }).then((value) => {
    projectConfigs.set(projectConfigKey(workspace), { value });
    return value;
  });
}
export function loadAiCapabilities(provider: AiSession["provider"], workspace: string): Promise<AiCapabilities> {
  return invoke("ai_runtime_models", { provider, workspace });
}
/** 后台发现与读取磁盘分开，刷新失败不丢弃已有目录。 */
export function refreshAiCapabilities(provider: AiSession["provider"], workspace: string, force = false): Promise<AiCapabilities> {
  return invoke("ai_runtime_refresh_models", { provider, workspace, force });
}
/** 用户输入单独持久化，自动发现不能覆盖自定义 ID。 */
export function saveAiCustomModel(provider: AiSession["provider"], model: string): Promise<AiCapabilities> {
  return invoke("ai_runtime_save_model", { provider, model });
}
/** 设置页只读列表：不探测 CLI，也不依赖当前工程。 */
export function loadAiCustomModels(provider: AiSession["provider"]): Promise<string[]> {
  return invoke("ai_runtime_custom_models", { provider });
}
export function removeAiCustomModel(provider: AiSession["provider"], model: string): Promise<void> {
  return invoke("ai_runtime_remove_model", { provider, model });
}

/** 后端推送的一条运行时事件，与 Rust 侧 `Event` 一一对应。 */
export interface AiRuntimeEvent {
  /** 事件属于哪个会话。 */
  sessionId: string;
  /** 事件属于哪一轮运行。 */
  runId: string;
  /** 会话内单调序号，用于排序、去重与补漏。 */
  seq: number;
  /** 事件类型：`text`、`tool`、`status`、`files`、`usage` 等。 */
  kind: string;
  /** 与类型配套的载荷，前端按 `kind` 解读。 */
  data: Record<string, unknown>;
}

/** 一个需要用户回答的问题（来自 CLI 的提问工具）。 */
export interface AiQuestion {
  /** 问题标识，答复时按它回填。 */
  id: string;
  /** 可选的短标题。 */
  header?: string;
  /** 问题正文。 */
  question: string;
  /** 预设选项；允许自由输入时也可能为空。 */
  options?: Array<{ label: string; description?: string }>;
  /** 是否可多选。 */
  multiSelect?: boolean;
}

/** 时间线上的一条记录：用户消息、助手回复、工具调用、文件变更等。 */
export interface AiEntry {
  /** 稳定 id，同一段内容多次更新时用它合并。 */
  id: string;
  /** 属于哪一轮运行。 */
  runId: string;
  /** 对应的事件序号；本地生成（如用户消息）时可能没有。 */
  seq?: number;
  /** 条目种类，决定渲染方式。 */
  kind: "user" | "assistant" | "command" | "tool" | "files" | "reasoning" | "notice" | "request";
  /** 正文；工具条目里是名称或摘要。 */
  text: string;
  /** 工具名，仅工具条目有。 */
  name?: string;
  /** 工具入参，仅工具条目有；结构由具体工具决定。 */
  input?: unknown;
  /** CLI 的结构化工具结果；与面向模型的文本 output 分开保存。 */
  result?: unknown;
  /** 工具输出，仅工具条目有。 */
  output?: unknown;
  /** 工具状态：running / completed / failed。 */
  status?: string;
  /** 被改动的文件路径，仅文件变更条目有。 */
  paths?: string[];
  /** Forge 图片沙箱中的附件路径，仅用户消息有。 */
  images?: string[];
  /** 关联的请求 id，仅请求条目有，用于定位答复目标。 */
  requestId?: string;
  /** 归属的 Task 工具调用 id（Claude 的 parent_tool_use_id）；子代理条目才有。 */
  parent?: string;
  /** 工具条目的原始工具 id（tool_use id）；子代理条目按它挂到对应委派卡。 */
  toolId?: string;
}

/** 一张等待用户处理的卡片：授权或提问。 */
export interface AiRequest {
  /** 对外请求 id，答复时原样回传。 */
  requestId: string;
  /** 属于哪一轮运行。 */
  runId: string;
  /** 对应事件序号，用于按时间插入时间线。 */
  seq?: number;
  /** `permission` 是工具授权，`question` 是提问。 */
  kind: "permission" | "question";
  /** 卡片标题，通常是工具名。 */
  title: string;
  /** 详情（授权时是格式化的入参）。 */
  detail: string;
  /** 权限请求对应的真实工具与结构化参数；用于复用普通工具明细。 */
  toolName?: string;
  /** 原始工具调用 id（Claude 的 can_use_tool request_id = tool_use id）；用于工具记录让位。 */
  toolId?: string;
  input?: unknown;
  reason?: string;
  blockedPath?: string;
  /** 由后端声明：这家的授权答复有没有「改过的入参」这个位置。没有就不给出现该按钮。 */
  canEdit?: boolean;
  /** 提问内容；授权卡片为空数组。 */
  questions: AiQuestion[];
  /** 是否仍可答复；请求被取消或已答复后置为 false。 */
  active: boolean;
  /** 答过了就带着当时的答案；`active` 为假而没有这一项，说明没等到答复就失效了。 */
  answer?: AiRequestAnswer;
}

/** 会话中的一项真实任务；同一会话最多一项 running，其余活动项按 FIFO 排队。 */
export interface AiTask {
  runId: string;
  status: AiTaskStatus;
  prompt?: string;
  error?: string;
  seq: number;
  /** 后端会话队列中的真实顺序；只对 queued/waitingExternal 有意义。 */
  queueIndex?: number;
  /** false 表示已知尚未启动；缺失表示分页没有覆盖启动事件，不能据此隐藏历史。 */
  started?: boolean;
}

/** 模型在一次工作中拆出的任务项；与用户消息运行队列 AiTask 完全不同。 */
export interface AiModelTaskItem { id: string; content: string; status: string; detail?: string }
/** 会话级模型任务快照；seq 用来防止迟到的分页响应覆盖实时进展。 */
export interface AiModelTaskList { seq: number; runId: string; items: AiModelTaskItem[] }

/** 会话里的一个子代理（Claude Agent 工具 / Codex collaboration）。由 `agent` 事件
 * 聚合：同 key 只保留最新状态，列表按首次出现的顺序排。 */
export interface AiAgentSummary {
  /** 路由 key：Claude 的 Agent tool_use id、Codex 的 agentThreadId。 */
  key: string;
  /** 子会话 id；点开子代理视图就是打开它。 */
  sessionId?: string;
  title: string;
  agentType?: string;
  /** Claude 回执的 resolvedModel / Codex SubAgentActivity 的 model。 */
  model?: string;
  /** running / starting / completed / failed / stopped。 */
  status: string;
  /** CLI 侧可寻址标识（Claude agentId、Codex agent_path）；停止与转发用。 */
  agentId?: string;
  /** 终态带回的摘要（task_notification 的 summary / FINAL_ANSWER 相关文本）。 */
  result?: string;
  /** 首次出现的序号，用于稳定排序。 */
  seq: number;
  /** 最近一次更新的序号。 */
  updatedAt: number;
}

export type AiThreadGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
/** Codex 原生线程 Goal；它描述长期目标，不承担 Task 清单的逐步进度。 */
export interface AiThreadGoal {
  seq: number;
  threadId: string;
  objective: string;
  status: AiThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}
interface AiGoalSummary { seq: number; goal: AiThreadGoal | null }

/** 一个会话在前端看到的状态快照。 */
export interface AiRuntimeSnapshot {
  /** 已合并好的时间线条目，按序号排列。 */
  entries: AiEntry[];
  /** 尚未处理的请求卡片。 */
  requests: AiRequest[];
  /** 当前运行项与历史/排队任务，用 runId 独立控制，不能压扁成一个布尔值。 */
  tasks: AiTask[];
  /** 模型拆出的最新任务清单；独立于时间线分页。 */
  taskList?: AiModelTaskList;
  /** Codex 线程的长期目标；与本轮任务清单相互独立。 */
  goal?: AiThreadGoal;
  /** 当前或最近一轮的 run id；从未运行过为 null。 */
  runId: string | null;
  /** 会话状态：idle / running / completed / cancelled / failed。 */
  status: string;
  /** 是否正在停止；此期间禁用发送并显示停止中。 */
  stopping: boolean;
  /** 最近一次失败的原因。 */
  error: string | null;
  /** 是否正在加载历史。 */
  loading: boolean;
  /** 是否已成功加载过一次；未加载前不能发送。 */
  loaded: boolean;
  /** 是否还有更早的历史可翻；首屏取的是最新一页，往前翻才是「更早」。 */
  hasOlder: boolean;
  /** 翻页游标：已加载记录里最老一条的序号，往前翻从这里再往前取。 */
  cursor: number;
  /** CLI 原生会话 id；恢复对话时用。 */
  nativeId: string | null;
  /** 最近报告的用量统计。 */
  usage?: AiUsage;
  /** 独立的上下文组成快照；过期快照仅供回看。 */
  context?: AiContext;
  contextUnavailable?: boolean;
  commands?: AiCommandCatalog;
  /** CLI 报告的运行配置（实际模型、权限模式等）。 */
  configuration?: AiRunOptions & { permissionMode?: string };
  /** 本会话的全部计划版本，按 planId/revision 去重；界面取最新一版。 */
  plans: AiPlanReview[];
  /** 会话里的子代理列表（会话级状态，不随分页丢失）。 */
  agents: AiAgentSummary[];
  /** 后台任务进度；没有后台任务时为 undefined。 */
  background?: AiBackground;
  /** 最近一次被权限系统拒绝的调用。 */
  permissionDenied?: AiPermissionDenied;
  /** CLI 实际加载的 MCP 服务。 */
  mcpServers?: AiMcpSnapshot;
}

/** 一个会话的内部存储：事件原文与由它派生的快照。 */
interface State {
  /** 会话所属工作区（原始写法），用于按项目过滤事件。 */
  workspace: string | null;
  /** 按序号索引的事件原文；快照由它派生，便于重放。 */
  events: Map<number, AiRuntimeEvent>;
  /** 当前对外暴露的快照。 */
  snapshot: AiRuntimeSnapshot;
  /** 正在进行的历史加载；用于合并并发请求。 */
  loading: Promise<void> | null;
  /** 重开或聚焦期间排队的最新页刷新；多个请求共用一次补取。 */
  refreshing?: Promise<void>;
  /** 已知的最大序号与对应运行/状态，用于判断是否需要重新拉取。 */
  summary: { seq: number; runId: string; status: string } | null;
  /** 全日志任务摘要必须跨历史重放保留，避免旧 queued 事件复活队列。 */
  activeSummary?: { seq: number; tasks: AiTask[] };
  /** 全日志模型任务快照必须跨历史重放保留，避免只靠当前页的稀疏补丁重建。 */
  taskListSummary?: AiModelTaskList;
  /** Goal 的最新状态（包括清除）必须带序号跨分页保留。 */
  goalSummary?: AiGoalSummary;
  /** 已见过的最大序号，防止乱序事件把游标回退。 */
  maxSeq: number;
  /** 本轮失败的记录；成功后清空。 */
  failure: { runId: string; error: string } | null;
  /** 正文缓存释放后仍供侧栏显示的最后终态。 */
  lastStatus: string | null;
}

/** 后端返回的一页历史。 */
interface Page {
  /** 本页事件，按序号升序。 */
  events: AiRuntimeEvent[];
  /** 往前翻的那一页：还有更早的记录没被这一页装下。 */
  hasOlder: boolean;
  /** 原生历史/摘要尚在补采，或向后读取还有下一页。 */
  hasMore?: boolean;
  /** 下一次分页的游标：往前翻是这一页最老一条，往后翻是最新一条。 */
  nextSeq: number;
  /** CLI 原生会话 id。 */
  nativeId: string | null;
  /** 会话状态；后端未记录时为 null。 */
  status: string | null;
  /** 后端已知的最大序号，用来判断本地是否落后。 */
  latestSeq?: number;
  /** 最大序号所属的运行 id。 */
  latestRunId?: string | null;
  /** 后端全日志扫描得到的活动任务摘要，不受当前分页位置影响。 */
  activeTasks?: AiTask[];
  /** 后端全日志折叠出的模型任务清单，不受当前分页位置影响。 */
  taskList?: AiModelTaskList | null;
  /** 后端全日志折叠出的 Goal 状态；goal:null 表示它已被清除。 */
  goal?: AiGoalSummary | null;
  /** 读取时的非致命问题，例如某条记录损坏被跳过。 */
  warning?: string | null;
  /** 计划审阅记录；事件分页之外的独立事实源。 */
  plans?: AiPlanReview[];
}
const EMPTY: AiRuntimeSnapshot = { entries: [], requests: [], tasks: [], runId: null, status: "idle", stopping: false, error: null, loading: false, loaded: false, hasOlder: false, cursor: 0, nativeId: null, plans: [], agents: [] };
const stores = new Map<string, State>();
const deleted = new Set<string>();
/** 已关闭标签等待释放正文缓存；活动任务结束后由事件合并路径完成释放。 */
const releaseRequested = new Set<string>();
/** 高频正文先按会话积到下一帧；通知和投影共用一次合帧，避免只省渲染、不省全量投影。 */
const pendingStreaming = new Map<string, AiRuntimeEvent[]>();
/** 停止意图按任务归属；会话级 stopping 只投影当前真正运行的那一项。 */
const stoppingRunIds = new Set<string>();
const listeners = new Set<() => void>();
export type AiSessionActivity = "idle" | "queued" | "running" | "external" | "conflict" | "unknown";
const activities = new Map<string, AiSessionActivity>();
const activityRoots = new Map<string, string>();
const activityQueued = new Map<string, number>();
const activityRunIds = new Map<string, string>();
const activityQueuedRunIds = new Map<string, readonly string[]>();
const NO_RUN_IDS: readonly string[] = [];
/** 同一工程可能被多个 Hook 同时轮询；只允许最后发出的请求提交结果。 */
const activityEpochs = new Map<string, number>();
export interface AiProjectActivitySummary { running: number; queued: number; external: number; }
export function getAiProjectActivitySummary(workspace: string): AiProjectActivitySummary {
  const key = rootKey(workspace);
  let running = 0; let queued = 0; let external = 0;
  for (const state of stores.values()) if (state.workspace && rootKey(state.workspace) === key) {
    running += state.snapshot.tasks.filter((task) => task.status === "running").length;
    queued += state.snapshot.tasks.filter((task) => isAiTaskQueued(task.status)).length;
  }
  for (const [id, root] of activityRoots) if (rootKey(root) === key) {
    const local = stores.get(id)?.snapshot;
    const state = activities.get(id) ?? "idle";
    if (["external", "conflict"].includes(state)) external += 1;
    else if (state === "running" && !local?.tasks.some((task) => task.status === "running")) running += 1;
    const localQueued = local?.tasks.filter((task) => isAiTaskQueued(task.status)).length ?? 0;
    queued += Math.max(0, (activityQueued.get(id) ?? 0) - localQueued);
  }
  return { running, queued, external };
}
/** 工程运行摘要只订阅任务状态变化，不跟随每个输出字符重渲染整个应用。 */
export function useAiActiveProjects(): string {
  return useSyncExternalStore(subscribeAiChanges, () => {
    const roots = new Set<string>([...stores.values()].flatMap((state) => state.workspace ? [state.workspace] : []).concat([...activityRoots.values()]));
    return JSON.stringify([...roots].map((root) => ({ root: rootKey(root), ...getAiProjectActivitySummary(root) }))
      .filter((item) => item.running || item.queued || item.external).sort((a, b) => a.root.localeCompare(b.root)));
  }, () => "[]");
}
export function hasAiProjectActivity(workspace: string): boolean {
  return hasAiRuns(workspace) || [...activityRoots].some(([id, root]) => rootKey(root) === rootKey(workspace) && ["running", "external", "conflict"].includes(getAiSessionActivity(id)));
}
/** 活动状态独立于历史消息；外部占用不能伪装成 Forge 可停止的任务。 */
export function getAiSessionActivity(id: string): AiSessionActivity {
  const observed = activities.get(id);
  // 一旦进程探针回过结果，它就比历史投影权威。历史里的 running 可能来自另一个窗口，
  // 也可能只是终态事件尚未补齐；拿它盖住 idle/external 会把不可停止的任务画成可停止。
  if (observed) return observed === "idle" && (activityQueued.get(id) ?? 0) > 0 ? "queued" : observed;
  if (isAiSessionRunning(id)) return "running";
  return getAiQueuedCount(id) > 0 ? "queued" : "idle";
}
export function useAiSessionActivity(id: string): AiSessionActivity {
  return useSyncExternalStore(subscribeAiChanges, () => getAiSessionActivity(id), () => "idle");
}
/** 当前桌面进程真正登记的运行 id；历史里的 running 没有控制权。 */
export function getAiOwnedRunId(id: string): string | null { return activityRunIds.get(id) ?? null; }
export function useAiOwnedRunId(id: string): string | null {
  return useSyncExternalStore(subscribeAiChanges, () => getAiOwnedRunId(id), () => null);
}
/** 当前桌面进程持有的排队项；其他进程写进共享日志的 queued 只能只读展示。 */
export function getAiOwnedQueuedRunIds(id: string): readonly string[] { return activityQueuedRunIds.get(id) ?? NO_RUN_IDS; }
export function useAiOwnedQueuedRunIds(id: string): readonly string[] {
  return useSyncExternalStore(subscribeAiChanges, () => getAiOwnedQueuedRunIds(id), () => NO_RUN_IDS);
}
/** 本进程事件/IPC 回执只更新控制权，不用共享日志反推所有权。 */
function markOwnedTask(id: string, runId: string, status: AiTaskStatus) {
  const queued = activityQueuedRunIds.get(id) ?? NO_RUN_IDS;
  if (status === "submitting" || status === "running") {
    activityRunIds.set(id, runId);
    activities.set(id, "running");
    const next = queued.filter((candidate) => candidate !== runId);
    activityQueuedRunIds.set(id, next);
    activityQueued.set(id, next.length);
  } else if (isAiTaskQueued(status)) {
    if (activityRunIds.get(id) === runId) activityRunIds.delete(id);
    const next = queued.includes(runId) ? queued : [...queued, runId];
    activityQueuedRunIds.set(id, next);
    activityQueued.set(id, next.length);
    activities.set(id, "idle");
  } else if (isAiTaskTerminal(status)) {
    stoppingRunIds.delete(runId);
    if (activityRunIds.get(id) === runId) activityRunIds.delete(id);
    const next = queued.filter((candidate) => candidate !== runId);
    activityQueuedRunIds.set(id, next);
    activityQueued.set(id, next.length);
    activities.delete(id);
  }
}
/** 一次批量查询只更新请求涉及的会话，不覆盖其他工程的状态。 */
export async function refreshAiSessionActivity(workspace: string, sessionIds: string[]): Promise<void> {
  const workspaceKey = rootKey(workspace);
  const epoch = (activityEpochs.get(workspaceKey) ?? 0) + 1;
  activityEpochs.set(workspaceKey, epoch);
  const requested = new Set(sessionIds);
  for (const [id, root] of activityRoots) if (rootKey(root) === rootKey(workspace) && !requested.has(id)) {
    activityRoots.delete(id); activities.delete(id); activityQueued.delete(id); activityRunIds.delete(id); activityQueuedRunIds.delete(id);
  }
  if (!isTauri() || !sessionIds.length) { changed(); return; }
  for (const id of sessionIds) activityRoots.set(id, workspace);
  try {
    const records = await invoke<Array<{ sessionId: string; state: AiSessionActivity; queuedCount?: number; activeRunId?: string | null; queuedRunIds?: string[] }>>("ai_runtime_activity", { workspace, sessionIds });
    // 慢请求后返回时不能把较新的 idle/external 又覆盖成旧 running。
    if (activityEpochs.get(workspaceKey) !== epoch) return;
    for (const record of records) {
      if (sessionIds.includes(record.sessionId) && ["idle", "running", "external", "conflict", "unknown"].includes(record.state)) {
        activities.set(record.sessionId, record.state);
        activityQueued.set(record.sessionId, Number.isSafeInteger(record.queuedCount) && (record.queuedCount ?? 0) > 0 ? record.queuedCount! : 0);
        if (typeof record.activeRunId === "string" && record.activeRunId) activityRunIds.set(record.sessionId, record.activeRunId);
        else activityRunIds.delete(record.sessionId);
        activityQueuedRunIds.set(record.sessionId, Array.isArray(record.queuedRunIds)
          ? record.queuedRunIds.filter((runId): runId is string => typeof runId === "string" && !!runId) : NO_RUN_IDS);
      }
    }
  } catch {
    if (activityEpochs.get(workspaceKey) !== epoch) return;
    // 探测失败不是“空闲”，不能把已知外部占用静默清除。
    // 探针失败时保留上一次控制权：网络/IO 错误不能凭空把仍在运行的停止按钮撤掉，
    // 更不能把未知任务认领到本窗口；activity 本身仍明确显示 unknown。
    for (const id of sessionIds) activities.set(id, "unknown");
  }
  changed();
}
let listening: Promise<void> | null = null;
const notify = () => { for (const listener of listeners) listener(); };
/**
 * 流式进度把事件投影与订阅通知一起压到一帧一次，避免每个 delta 都复制完整时间线。
 * 兜底定时器保证 rAF 不来时（窗口隐藏）界面仍会追上，不会卡在旧数据上。
 */
const frames = createFrameNotifier(() => { flushPendingStreaming(); notify(); });
const changed = () => { frames.cancel(); flushPendingStreaming(); notify(); };
/** 只推进正文、工具输出这类高频内容时用这个，攒到下一帧再通知。 */
const changedSoon = () => frames.schedule();
/** 取（必要时新建）某个会话的内部状态。所有会话共享一个 map，跨组件复用同一份数据。 */
function store(id: string): State { let state = stores.get(id); if (!state) { state = { workspace: null, events: new Map(), snapshot: { ...EMPTY }, loading: null, summary: null, maxSeq: 0, failure: null, lastStatus: null }; stores.set(id, state); } return state; }
/** 局部更新快照并通知订阅者；调用方只传要改的字段。 */
function patch(id: string, change: Partial<AiRuntimeSnapshot>) { const state = store(id); state.snapshot = { ...state.snapshot, ...change }; changed(); }
/** 订阅任何会话的变化（含新建/删除），供 `useSyncExternalStore` 使用。 */
export function subscribeAiChanges(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** 读取某个会话的快照；不存在的会话返回空快照，保证组件首帧不崩。 */
export function useAiRuntime(id: string): AiRuntimeSnapshot { return useSyncExternalStore(subscribeAiChanges, () => stores.get(id)?.snapshot ?? EMPTY); }
/** 当前（或最近）一轮的 run id；停止按钮要用它。 */
export function getAiRunId(id: string) { return stores.get(id)?.snapshot.runId ?? null; }
/** 该会话是否正在运行；关闭标签前的判断靠它。 */
export function isAiSessionRunning(id: string) { return stores.get(id)?.snapshot.status === "running"; }
/** 该会话最后一轮任务的终态（completed/cancelled/failed）；没跑过为 null。侧栏状态点据此着色。 */
export function getAiSessionLastStatus(id: string): string | null {
  const state = stores.get(id);
  const tasks = state?.snapshot.tasks;
  const last = tasks?.at(-1);
  return last && isAiTaskTerminal(last.status) ? last.status : state?.lastStatus ?? null;
}
/** 排队与等待外部任务都可取消，但不冒充正在运行。 */
export function getAiQueuedCount(id: string) {
  const local = stores.get(id)?.snapshot.tasks.filter((task) => isAiTaskQueued(task.status)).length ?? 0;
  return Math.max(local, activityQueued.get(id) ?? 0);
}
export function useAiQueuedCount(id: string) { return useSyncExternalStore(subscribeAiChanges, () => getAiQueuedCount(id), () => 0); }
/** 路径归一化用于比较：去 `\\?\` 前缀、统一分隔符，Windows 与 UNC 路径转小写。 */
function rootKey(root: string) { const key = root.replace(/^\\\\\?\\UNC\\/i, "//").replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, ""); return /^[a-z]:\//i.test(key) || key.startsWith("//") ? key.toLowerCase() : key; }
/** 只保留属于该工作区的事件；会话还没绑定工作区时一律过滤掉。 */
export function filterAiProjectEvents(events: AiRuntimeEvent[], workspace: string): AiRuntimeEvent[] {
  return events.filter((event) => { const root = stores.get(event.sessionId)?.workspace; return !!root && rootKey(root) === rootKey(workspace); });
}
/** 是否有正在运行的任务；传工作区则只统计该项目下的。 */
export function hasAiRuns(workspace?: string) { return [...stores.values()].some((state) => state.snapshot.tasks.some((task) => isAiTaskLive(task.status)) && (!workspace || state.workspace !== null && rootKey(state.workspace) === rootKey(workspace))); }

type AiModelTaskPatch = { id: string; content?: string; replacesId?: string; status?: string; detail?: string };
/** 把完整清单与稀疏 TaskUpdate 折成同一种会话级快照。 */
function foldAiModelTaskList(previous: AiModelTaskList | undefined, event: AiRuntimeEvent): AiModelTaskList {
  const data = event.data;
  const incoming: AiModelTaskPatch[] = Array.isArray(data.items) ? data.items.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const content = typeof value.content === "string" ? value.content : undefined;
    const id = typeof value.id === "string" && value.id ? value.id : content || `task-${index}`;
    return [{ id, ...(content !== undefined ? { content } : {}),
      ...(typeof value.replacesId === "string" ? { replacesId: value.replacesId } : {}),
      ...(typeof value.status === "string" ? { status: value.status } : {}),
      ...(typeof value.detail === "string" ? { detail: value.detail } : {}) }];
  }) : [];
  const complete = (item: AiModelTaskPatch): AiModelTaskItem => ({ id: item.id, content: item.content ?? "", status: item.status ?? "pending", ...(item.detail !== undefined ? { detail: item.detail } : {}) });
  const items: AiModelTaskItem[] = data.replace === true ? incoming.map(complete) : previous?.items.map((item) => ({ ...item })) ?? [];
  if (data.replace !== true) for (const item of incoming) {
    const index = items.findIndex((old) => old.id === item.id || old.id === item.replacesId);
    if (index < 0) items.push(complete(item));
    else items[index] = { ...items[index], ...item, id: item.id, content: item.content || items[index].content };
  }
  return { seq: event.seq, runId: event.runId, items };
}

/** IPC 边界只接收完整、可排序的模型任务快照；坏载荷不能覆盖实时状态。 */
function normalizeAiModelTaskList(value: unknown): AiModelTaskList | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const snapshot = value as Record<string, unknown>;
  if (!Number.isSafeInteger(snapshot.seq) || Number(snapshot.seq) < 1 || typeof snapshot.runId !== "string" || !Array.isArray(snapshot.items)) return undefined;
  const items = snapshot.items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const task = item as Record<string, unknown>;
    if (typeof task.id !== "string" || typeof task.content !== "string" || typeof task.status !== "string") return [];
    return [{ id: task.id, content: task.content, status: task.status, ...(typeof task.detail === "string" ? { detail: task.detail } : {}) }];
  });
  return { seq: Number(snapshot.seq), runId: snapshot.runId, items };
}

const GOAL_STATUSES = new Set<AiThreadGoalStatus>(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);
function normalizeAiThreadGoal(value: unknown, seq: number): AiThreadGoal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const goal = value as Record<string, unknown>;
  if (typeof goal.threadId !== "string" || typeof goal.objective !== "string" || !GOAL_STATUSES.has(goal.status as AiThreadGoalStatus)) return undefined;
  const numbers = [goal.tokensUsed, goal.timeUsedSeconds, goal.createdAt, goal.updatedAt];
  if (numbers.some((number) => !Number.isSafeInteger(number) || Number(number) < 0)) return undefined;
  if (goal.tokenBudget != null && (!Number.isSafeInteger(goal.tokenBudget) || Number(goal.tokenBudget) < 1)) return undefined;
  return {
    seq,
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status as AiThreadGoalStatus,
    tokenBudget: goal.tokenBudget == null ? null : Number(goal.tokenBudget),
    tokensUsed: Number(goal.tokensUsed),
    timeUsedSeconds: Number(goal.timeUsedSeconds),
    createdAt: Number(goal.createdAt),
    updatedAt: Number(goal.updatedAt),
  };
}

function normalizeAiGoalSummary(value: unknown): AiGoalSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const summary = value as Record<string, unknown>;
  if (!Number.isSafeInteger(summary.seq) || Number(summary.seq) < 1) return undefined;
  if (summary.goal === null) return { seq: Number(summary.seq), goal: null };
  const goal = normalizeAiThreadGoal(summary.goal, Number(summary.seq));
  return goal ? { seq: Number(summary.seq), goal } : undefined;
}

function goalSummaryFromEvent(event: AiRuntimeEvent): AiGoalSummary | undefined {
  if (event.kind !== "goal") return undefined;
  if (event.data.goal === null) return { seq: event.seq, goal: null };
  const goal = normalizeAiThreadGoal(event.data.goal, event.seq);
  return goal ? { seq: event.seq, goal } : undefined;
}

/** Complete messages replace deltas under the same provider item ID. */
export function projectAiEvents(events: AiRuntimeEvent[], previous: AiRuntimeSnapshot = EMPTY, incremental = false): AiRuntimeSnapshot {
  const entries: AiEntry[] = incremental ? previous.entries.map((entry) => ({ ...entry })) : [];
  const byId = new Map<string, AiEntry>(entries.map((entry) => [entry.id, entry]));
  const requests = new Map<string, AiRequest>(incremental ? previous.requests.map((request) => [request.requestId, { ...request }]) : []);
  const tasks = new Map<string, AiTask>(incremental ? previous.tasks.map((task) => [task.runId, { ...task }]) : []);
  // 每一轮的正文：只有真有状态事件的那一轮才配拿去当提示词（见下面 `user` 分支）。
  const prompts = new Map<string, string>();
  const seenRuns = new Set<string>();
  let runId: string | null = incremental ? previous.runId : null;
  let status = incremental ? previous.status : "idle"; let error: string | null = incremental ? previous.error : null; let nativeId = previous.nativeId;
  let usage = incremental ? previous.usage : undefined;
  let context = incremental ? previous.context : undefined;
  let contextUnavailable = incremental ? previous.contextUnavailable : undefined;
  const staleContext = () => { if (context) context = { ...context, stale: true }; };
  let commands = incremental ? previous.commands : undefined;
  let configuration = incremental ? previous.configuration : undefined;
  const plans = new Map<string, AiPlanReview>(incremental ? previous.plans.map((plan) => [`${plan.planId}:${plan.revision}`, { ...plan }]) : []);
  let background = incremental ? previous.background : undefined;
  let permissionDenied = incremental ? previous.permissionDenied : undefined;
  let mcpServers = incremental ? previous.mcpServers : undefined;
  let modelTasks = incremental ? previous.taskList : undefined;
  let goal = incremental ? previous.goal : undefined;
  // 子代理列表是会话级状态：同 key 后写覆盖字段，首见序号保住稳定排序。
  const agents = new Map<string, AiAgentSummary>(incremental ? previous.agents.map((agent) => [agent.key, { ...agent }]) : []);
  /** 每轮当前所处的压缩段（entry id）；用户消息一旦出现即视为新段落。 */
  const compactionEpisodes = new Map<string, string>();
  if (incremental) {
    for (const entry of previous.entries) {
      if (entry.kind === "notice" && entry.name === "compaction") compactionEpisodes.set(entry.runId, entry.id);
      if (entry.kind === "user") compactionEpisodes.delete(entry.runId);
    }
  }
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const data = event.data; const key = `${event.runId}:${typeof data.id === "string" ? data.id : event.seq}`;
    seenRuns.add(event.runId);
    if (event.kind === "status") {
      // 词表外或前端专属（submitting）的状态一律当没发生：日志损坏时不能凭空造出一轮。
      const rawStatus = String(data.status);
      const taskStatus = isAiTaskBackendStatus(rawStatus) ? rawStatus : null;
      if (taskStatus) {
        const current = tasks.get(event.runId);
        tasks.set(event.runId, { runId: event.runId, status: taskStatus,
          started: taskStatus === "running" || taskStatus === "completed" ? true
            : current?.started ?? (isAiTaskQueued(taskStatus) ? false : undefined),
          prompt: typeof data.prompt === "string" ? data.prompt : (current?.prompt ?? prompts.get(event.runId)),
          queueIndex: Number.isSafeInteger(data.queueIndex) && Number(data.queueIndex) >= 0 ? Number(data.queueIndex) : current?.queueIndex,
          error: typeof data.error === "string" ? data.error : undefined, seq: current?.seq ?? event.seq });
        // 排队期间编辑的是任务提示词；启动时正文必须使用最后确认的版本。
        const prompt = tasks.get(event.runId)?.prompt;
        if (current && isAiTaskQueued(current.status) && typeof prompt === "string") for (const entry of entries) {
          if (entry.runId === event.runId && entry.kind === "user") entry.text = prompt;
        }
      }
      const terminal = taskStatus !== null && isAiTaskTerminal(taskStatus);
      if (taskStatus === "running") {
        if (runId !== event.runId) mcpServers = undefined;
        runId = event.runId; status = "running"; error = null; staleContext(); contextUnavailable = undefined; background = undefined; permissionDenied = undefined;
      }
      else if (terminal && runId === event.runId && taskStatus) { status = taskStatus; error = typeof data.error === "string" ? data.error : null; background = undefined; }
      if (terminal) for (const request of requests.values()) if (request.runId === event.runId) request.active = false;
      if (terminal && taskStatus) {
        for (const entry of entries) {
          if (entry.kind === "tool" && entry.runId === event.runId && entry.status === "running") {
            entry.status = taskStatus === "completed" ? "unknown" : taskStatus;
          }
          if (entry.kind === "notice" && entry.name === "compaction" && entry.runId === event.runId) {
            const input = entry.input && typeof entry.input === "object" ? entry.input as Record<string, unknown> : {};
            if (input.status === "compacting" || input.status === "running") {
              entry.input = { ...input, status: taskStatus === "cancelled" ? "interrupted" : taskStatus };
            }
          }
        }
      }
    } else if (event.kind === "bound" && typeof data.nativeId === "string") nativeId = data.nativeId;
    else if (event.kind === "user" && typeof data.text === "string") {
      // `user` 只说明「这一轮说过什么」，不说明「这一轮还在不在跑」。以前这里顺手造一轮
      // （没有状态就写 `submitting`），导入的原生历史几百条用户消息一条状态事件都没有，
      // 于是已经结束的历史被摆成一条待办任务：输入框上方多出一行点不动的「正在提交」，
      // 按立即执行/编辑/取消，后端只回「这条任务不在当前窗口的队列里」——它本来就不存在。
      // 正文照旧进时间线；提示词留给真正有状态事件的那一轮。
      prompts.set(event.runId, data.text);
      compactionEpisodes.delete(event.runId);
      const task = tasks.get(event.runId);
      if (task) tasks.set(event.runId, { ...task, prompt: data.text });
      if (!byId.has(key)) { const entry: AiEntry = { id: key, runId: event.runId, seq: event.seq, kind: "user", text: data.text,
        images: Array.isArray(data.images) ? data.images.filter((path): path is string => typeof path === "string") : undefined }; entries.push(entry); byId.set(key, entry); }
    }
    else if (event.kind === "command_output" && typeof data.id === "string" && typeof data.text === "string") {
      const commandKey = `${key}:command`;
      let entry = byId.get(commandKey);
      if (!entry) { entry = { id: commandKey, runId: event.runId, kind: "command", text: "" }; byId.set(commandKey, entry); entries.push(entry); }
      entry.text = data.text;
    }
    else if ((event.kind === "text" || event.kind === "message") && typeof data.id === "string" && typeof data.text === "string") {
      let entry = byId.get(key); if (!entry) { entry = { id: key, runId: event.runId, kind: "assistant", text: "" }; byId.set(key, entry); entries.push(entry); }
      entry.text = event.kind === "message" ? data.text : entry.text + data.text;
      if (typeof data.parent === "string" && data.parent) entry.parent = data.parent;
    } else if (event.kind === "tool" && typeof data.id === "string") {
      let entry = byId.get(key); if (!entry) { entry = { id: key, runId: event.runId, kind: "tool", text: "" }; byId.set(key, entry); entries.push(entry); }
      entry.toolId = data.id;
      if (typeof data.parent === "string" && data.parent) entry.parent = data.parent;
      if (typeof data.name === "string") entry.name = data.name;
      if (data.input !== undefined && data.input !== null) entry.input = data.input;
      if (data.inputPatch && typeof data.inputPatch === "object" && !Array.isArray(data.inputPatch)) {
        entry.input = { ...(entry.input && typeof entry.input === "object" ? entry.input : {}), ...data.inputPatch };
      }
      if (data.result !== undefined && data.result !== null) entry.result = data.result;
      if (data.output !== undefined && data.output !== null) entry.output = data.output;
      if (typeof data.outputDelta === "string") entry.output = String(entry.output ?? "") + data.outputDelta;
      if (typeof data.status === "string") entry.status = data.status;
    } else if (event.kind === "files") {
      const paths = Array.isArray(data.paths) ? data.paths.filter((path): path is string => typeof path === "string") : [];
      if (paths.length) entries.push({ id: key, runId: event.runId, kind: "files", text: "", paths });
    } else if (event.kind === "usage") {
      usage = normalizeAiUsage(data, usage);
    } else if (event.kind === "context" && (!runId || runId === event.runId)) {
      const next = normalizeAiContext(data, event.runId);
      if (next) { context = next; contextUnavailable = false; }
      else { staleContext(); contextUnavailable = true; }
    } else if (event.kind === "context_unavailable" && (!runId || runId === event.runId)) {
      staleContext(); contextUnavailable = true;
    } else if (event.kind === "commands" && (!runId || runId === event.runId)) {
      const next = normalizeCommandCatalog(data);
      if (next) commands = next;
    } else if (event.kind === "configuration") {
      if (typeof data.model === "string" && context && data.model !== context.model) staleContext();
      if (typeof data.model === "string" && data.model !== configuration?.model && usage) usage = { ...usage, window: undefined, model: data.model };
      configuration = { ...configuration,
        ...(typeof data.model === "string" ? { model: data.model } : {}),
        ...(typeof data.effort === "string" ? { effort: data.effort } : {}),
        ...(typeof data.permissionMode === "string" ? { permissionMode: data.permissionMode } : {}),
        ...(typeof data.mode === "string" ? { mode: data.mode } : {}),
        ...(typeof data.planMode === "boolean" ? { planMode: data.planMode } : {}),
      };
    } else if (event.kind === "plan_draft" && typeof data.planId === "string") {
      const draftKey = `plan-draft:${data.planId}`;
      let entry = byId.get(draftKey);
      if (!entry) { entry = { id: draftKey, runId: event.runId, seq: event.seq, kind: "notice", name: "plan_draft", text: "" }; entries.push(entry); byId.set(draftKey, entry); }
      const text = typeof data.text === "string" ? data.text : "";
      entry.text = data.append === true ? entry.text + text : text;
      entry.input = { planId: data.planId, complete: data.complete === true };
      entry.seq = event.seq;
    } else if (event.kind === "plan_review" && typeof data.planId === "string" && typeof data.revision === "number") {
      const plan = data as unknown as AiPlanReview;
      plans.set(`${plan.planId}:${plan.revision}`, { ...plan, seq: event.seq });
      // 同一次规划先有流式草稿、后有权威正文：合并成一条，不让同一份计划出现两次。
      const draftKey = `plan-draft:${plan.planId}`;
      const entry = byId.get(draftKey) ?? { id: `${event.runId}:plan-review:${plan.planId}:${plan.revision}`, runId: event.runId, seq: event.seq, kind: "notice" as const, name: "plan_review", text: "" };
      entry.name = "plan_review"; entry.text = typeof plan.content === "string" ? plan.content : entry.text;
      entry.input = plan; entry.seq = event.seq;
      if (!byId.has(entry.id)) { byId.set(entry.id, entry); entries.push(entry); }
    } else if (event.kind === "plan_decision") {
      const noticeKey = `${key}:plan-decision`;
      let entry = byId.get(noticeKey);
      if (!entry) { entry = { id: noticeKey, runId: event.runId, seq: event.seq, kind: "notice", name: "plan_decision", text: "" }; byId.set(noticeKey, entry); entries.push(entry); }
      entry.input = data; entry.seq = event.seq;
    } else if (event.kind === "background") {
      background = { pending: Number.isSafeInteger(data.pending) && Number(data.pending) >= 0 ? Number(data.pending) : 0, settled: data.settled === true };
    } else if (event.kind === "permission_denied") {
      permissionDenied = {
        ...(typeof data.tool === "string" ? { tool: data.tool } : {}),
        ...(typeof data.path === "string" ? { path: data.path } : {}),
        text: typeof data.text === "string" ? data.text : "",
      };
    } else if (event.kind === "mcp_servers") {
      const servers = Array.isArray(data.servers) ? data.servers.flatMap((server) => server && typeof server === "object" && typeof (server as Record<string, unknown>).name === "string"
        ? [{ name: String((server as Record<string, unknown>).name), status: typeof (server as Record<string, unknown>).status === "string" ? String((server as Record<string, unknown>).status) : null }] : []) : [];
      mcpServers = servers.length ? { servers, ...(Array.isArray(data.tools) ? { tools: data.tools.filter((tool): tool is string => typeof tool === "string") } : {}) } : undefined;
    } else if ((event.kind === "reasoning" || event.kind === "reasoning_delta") && typeof data.id === "string") {
      const reasoningKey = `${key}:reasoning`;
      let entry = byId.get(reasoningKey);
      if (!entry) { entry = { id: reasoningKey, runId: event.runId, seq: event.seq, kind: "reasoning", text: "" }; byId.set(reasoningKey, entry); entries.push(entry); }
      if (typeof data.parent === "string" && data.parent) entry.parent = data.parent;
      const text = typeof data.text === "string" ? data.text : typeof data.delta === "string" ? data.delta : "";
      // 完整思考块可能带着被 CLI 裁剪/签名后的空文本到来：空串不得洗掉已累计的增量，
      // 否则流式期间还能看到的思考在整封信封落地后就消失了。
      entry.text = !text ? entry.text
        : event.kind === "reasoning_delta" || data.append === true ? entry.text + text
        : text;
    } else if (event.kind === "task_list") {
      // TaskUpdate 可以来自后续回合；任务清单属于会话，不能按回合截断。
      const taskKey = "session:task-list";
      modelTasks = foldAiModelTaskList(modelTasks, event);
      let entry = byId.get(taskKey);
      const items = modelTasks.items;
      if (data.replace === true && items.length === 0) {
        // 清单清空就是删除当前快照，不能留下一个永远空着的“任务”壳。
        if (entry) entries.splice(entries.indexOf(entry), 1);
        byId.delete(taskKey);
      } else {
        if (!entry) { entry = { id: taskKey, runId: event.runId, seq: event.seq, kind: "notice", name: "task_list", text: "" }; byId.set(taskKey, entry); }
        else entries.splice(entries.indexOf(entry), 1);
        // 这是会话级最新快照，但在时间线上仍必须归到产生本次更新的新回合和新位置。
        entry.runId = event.runId; entry.input = { items }; entry.seq = event.seq; entries.push(entry);
      }
    } else if (event.kind === "goal") {
      // 清除与更新共用一个事件类型；坏载荷不能误清除当前 Goal。
      const summary = goalSummaryFromEvent(event);
      if (summary) goal = summary.goal ?? undefined;
    } else if (event.kind === "agent" && typeof data.key === "string" && data.key) {
      const key = data.key;
      const current = agents.get(key);
      const next: AiAgentSummary = {
        key,
        ...(current ?? {}),
        ...(typeof data.sessionId === "string" && data.sessionId ? { sessionId: data.sessionId } : {}),
        ...(typeof data.title === "string" && data.title.trim() ? { title: data.title } : { title: current?.title ?? "" }),
        ...(typeof data.agentType === "string" && data.agentType ? { agentType: data.agentType } : {}),
        ...(typeof data.model === "string" && data.model ? { model: data.model } : {}),
        ...(typeof data.resolvedModel === "string" && data.resolvedModel ? { model: data.resolvedModel } : {}),
        ...(typeof data.agentId === "string" && data.agentId ? { agentId: data.agentId } : {}),
        ...(typeof data.result === "string" && data.result ? { result: data.result } : {}),
        status: typeof data.status === "string" && data.status ? data.status : current?.status ?? "running",
        seq: current?.seq ?? event.seq,
        updatedAt: event.seq,
      };
      agents.set(key, next);
    } else if (["retry", "compaction", "notice", "plan"].includes(event.kind)) {
      if (event.kind === "compaction") { staleContext(); if (usage) usage = { ...usage, context: undefined }; }
      // 普通 notice 一条一格（本轮可能有多次自动允许/自动拒绝）；retry/plan 仍按类型合并。
      if (event.kind !== "compaction") {
        const noticeKey = event.kind === "notice" ? `${key}:notice:${event.seq}` : `${key}:notice:${event.kind}`;
        const existing = byId.get(noticeKey);
        if (existing) { existing.text = typeof data.text === "string" ? data.text : existing.text; existing.input = data; existing.seq = event.seq; }
        else { const entry: AiEntry = { id: noticeKey, runId: event.runId, seq: event.seq, kind: "notice", name: event.kind, text: typeof data.text === "string" ? data.text : "", input: data }; entries.push(entry); byId.set(noticeKey, entry); }
      }
    }
    // 实时 episode 与原生 summary 是同一次压缩的两个身份；重放和增量都恢复别名。
    if (event.kind === "compaction") {
      const summaryId = typeof data.summaryId === "string" ? data.summaryId : undefined;
      const episodeId = typeof data.episodeId === "string" ? data.episodeId : undefined;
      const matches = entries.filter((entry) => {
        if (entry.kind !== "notice" || entry.name !== "compaction") return false;
        const input = entry.input as Record<string, unknown> | undefined;
        return (summaryId && input?.summaryId === summaryId) || (episodeId && input?.episodeId === episodeId);
      });
      let existing = matches[0];
      // 两个身份先各自到达，再收到关联事件时，收拢已存在的卡片。
      for (const duplicate of matches.slice(1)) {
        existing.input = { ...(existing.input as Record<string, unknown>), ...(duplicate.input as Record<string, unknown>) };
        if (!existing.text) existing.text = duplicate.text;
        entries.splice(entries.indexOf(duplicate), 1);
        byId.delete(duplicate.id);
        for (const [run, id] of compactionEpisodes) if (id === duplicate.id) compactionEpisodes.set(run, existing.id);
      }
      if (!existing) {
        const currentId = compactionEpisodes.get(event.runId);
        const current = currentId ? byId.get(currentId) : undefined;
        const input = current?.input as Record<string, unknown> | undefined;
        const starting = data.status === "compacting" || data.status === "running";
        const newStart = starting && input?.status === "completed";
        // 无身份的原生边界只能补给同段尚无摘要的记录，不能吞掉下一次摘要。
        const compatible = (!episodeId || !input?.episodeId) && (!summaryId || !input?.summaryId);
        if (current && compatible && !newStart && (!input?.summaryId || !data.metadata)) existing = current;
      }
      if (!existing) {
        existing = { id: `${event.runId}:compaction:${event.seq}`, runId: event.runId, seq: event.seq, kind: "notice", name: "compaction", text: "" };
        entries.push(existing);
        byId.set(existing.id, existing);
      }
      // 摘要那条的 status 是投影时写死的 completed（history.rs），它并不知道那次压缩是怎么结束的；
      // 卡片上已经观察到的状态（实时边界报的，或取消后写的 interrupted）不许被它改写。
      const observed = existing.input as Record<string, unknown> | undefined;
      existing.input = { ...observed, ...data,
        ...(summaryId !== undefined && observed?.status !== undefined ? { status: observed.status } : {}) };
      existing.seq = event.seq;
      if (typeof data.text === "string" && data.text) existing.text = data.text;
      compactionEpisodes.set(event.runId, existing.id);
    } else if ((event.kind === "permission" || event.kind === "question") && typeof data.requestId === "string") {
      if (!requests.has(data.requestId)) entries.push({ id: `${key}:request`, runId: event.runId, seq: event.seq, kind: "request", text: "", requestId: data.requestId });
      requests.set(data.requestId, { requestId: data.requestId, runId: event.runId, seq: event.seq, kind: event.kind, title: String(data.title ?? ""), detail: String(data.detail ?? ""),
        ...(typeof data.toolName === "string" ? { toolName: data.toolName } : {}),
        ...(typeof data.toolId === "string" ? { toolId: data.toolId } : {}),
        ...(data.input !== undefined ? { input: data.input } : {}),
        ...(typeof data.reason === "string" ? { reason: data.reason } : {}), ...(typeof data.blockedPath === "string" ? { blockedPath: data.blockedPath } : {}),
        ...(data.canEdit === true ? { canEdit: true } : {}),
        questions: Array.isArray(data.questions) ? data.questions.filter((q): q is AiQuestion => !!q && typeof q === "object" && typeof q.id === "string" && typeof q.question === "string") : [], active: true });
    } else if (event.kind === "invalidated" && typeof data.requestId === "string") {
      const request = requests.get(data.requestId);
      // 答复带回来的那条失效事件留着答案：卡片据此分清「已处理」和「没等到答复就失效」，
      // 重开会话时也能把当时选的那几项显示出来，而不是重新摆一副还能点的样子。
      if (request) { request.active = false; if (data.answer !== undefined && data.answer !== null) request.answer = data.answer as AiRequestAnswer; }
    }
  }
  // 同一次压缩的两条记录（实时状态 + 原生日志里的摘要正文）由后端在读事件时合并：
  // 前端只看得到当前这一页，两张卡很少同页，按页折叠注定时对时错（见 store.rs 的 compaction_fold）。
  // 全量重放期间保留尚未收到后端事件的提交项；其余状态一律由事件决定。
  // 这一批事件里已经出现过的那一轮不算：它的状态由事件说了算，本地那份只是往返期间的占位。
  if (!incremental) for (const task of previous.tasks) {
    if (task.status === "submitting" && !tasks.has(task.runId) && !seenRuns.has(task.runId)) tasks.set(task.runId, { ...task });
  }
  // 失效的提问卡若没随 invalidated 带答案，从同轮 AskUserQuestion 工具的结构化结果里恢复。
  // 答案经 updatedInput 交给 CLI 后，工具结果里每回都带着它；invalidated 那条丢答案的
  // 场景（实测日志里确有）靠这份兜底，旧会话日志也一并修好。放在事件循环之后：
  // invalidated 常常先于工具结果到达，逐事件处理时答案还没落盘。
  for (const request of requests.values()) {
    if (request.kind !== "question" || request.active || request.answer || !request.questions.length) continue;
    const tool = entries.find((entry) => entry.kind === "tool" && entry.runId === request.runId
      && /^askuserquestion$/i.test(entry.name ?? "")
      && entry.result !== undefined && typeof entry.result === "object" && !Array.isArray(entry.result));
    const result = tool ? tool.result as Record<string, unknown> : null;
    const answers = result && typeof result.answers === "object" && !Array.isArray(result.answers) ? result.answers as Record<string, unknown> : null;
    const resultQuestions = result && Array.isArray(result.questions) ? result.questions : null;
    if (!answers || !resultQuestions) continue;
    // 只认问的是同一组问题的那次调用：一轮里问过两次时，别把别人的答案贴过来。
    const sameQuestions = request.questions.every((question, index) => {
      const match = resultQuestions[index] && typeof resultQuestions[index] === "object" ? resultQuestions[index] as Record<string, unknown> : null;
      return match !== null && match.question === question.question;
    });
    if (!sameQuestions) continue;
    const recovered: Record<string, string[]> = {};
    for (const question of request.questions) {
      const joined = answers[question.question];
      if (typeof joined !== "string" || !joined) continue;
      const parts = joined.split(", ");
      const labels = (question.options ?? []).map((option) => option.label)
        .filter((label) => parts.includes(label) || joined.includes(label));
      if (labels.length) recovered[question.id] = labels;
    }
    if (Object.keys(recovered).length) request.answer = { answers: recovered };
  }
  const taskList = [...tasks.values()].sort((a, b) => a.seq - b.seq);
  const active = taskList.slice().reverse().find((task) => task.status === "running");
  const latest = taskList.at(-1);
  if (active) { runId = active.runId; status = "running"; error = active.error ?? null; }
  else if (latest) { runId = latest.runId; status = latest.status; error = latest.error ?? null; }
  return { ...previous, entries, requests: [...requests.values()], tasks: taskList, taskList: modelTasks, goal, runId, status, error, nativeId, usage, context, contextUnavailable, commands, configuration, plans: [...plans.values()].sort((a, b) => a.createdAt - b.createdAt || a.revision - b.revision), agents: [...agents.values()].sort((a, b) => a.seq - b.seq), background, permissionDenied, mcpServers, stopping: active ? stoppingRunIds.has(active.runId) : false };
}
function applySummary(state: State) {
  const summary = state.summary;
  if (!summary || state.maxSeq > summary.seq) return;
  const summaryStatus = isAiTaskBackendStatus(summary.status) ? summary.status : null;
  if (summaryStatus !== null && isAiTaskTerminal(summaryStatus)) {
    state.snapshot = { ...state.snapshot, tasks: state.snapshot.tasks.map((task) => task.runId === summary.runId
      ? { ...task, status: summaryStatus } : task) };
  }
  const active = state.snapshot.tasks.slice().reverse().find((task) => task.status === "running");
  if (active && active.runId !== summary.runId) return;
  const optimistic = state.snapshot.status === "running" && state.snapshot.runId !== summary.runId && ![...state.events.values()].some((event) => event.runId === state.snapshot.runId && event.kind === "status");
  if (optimistic) return;
  state.snapshot = { ...state.snapshot, runId: summary.runId, status: summary.status,
    context: state.snapshot.context && state.snapshot.context.runId !== summary.runId ? { ...state.snapshot.context, stale: true } : state.snapshot.context,
    stopping: summary.status === "running" && stoppingRunIds.has(summary.runId),
    requests: state.snapshot.requests.map((request) => ({ ...request, active: request.active && summary.status === "running" && request.runId === summary.runId })),
  };
}
/** 更新单项后重新选择当前运行项；排队项绝不能覆盖停止按钮所指向的 run id。 */
function updateTask(id: string, next: AiTask) {
  const state = store(id);
  // 本窗口刚提交的新状态比上一轮三秒轮询更新；先丢掉旧探针，下一轮轮询再重新确认。
  if (isAiTaskLive(next.status)) { activities.delete(id); activityQueued.delete(id); }
  const current = state.snapshot.tasks.find((task) => task.runId === next.runId);
  next = { ...next, started: current?.started === true || next.status === "running" || next.status === "completed" ? true
    : next.started ?? (isAiTaskQueued(next.status) ? false : undefined) };
  const tasks = state.snapshot.tasks.some((task) => task.runId === next.runId)
    ? state.snapshot.tasks.map((task) => task.runId === next.runId ? next : task)
    : [...state.snapshot.tasks, next];
  tasks.sort((a, b) => a.seq - b.seq);
  const active = tasks.slice().reverse().find((task) => task.status === "running");
  const latest = tasks.at(-1);
  state.snapshot = { ...state.snapshot, tasks, runId: active?.runId ?? latest?.runId ?? null,
    status: active ? "running" : latest?.status ?? "idle", error: active?.error ?? latest?.error ?? null,
    stopping: active ? stoppingRunIds.has(active.runId) : false };
  changed();
}

/** 后端摘要覆盖分页之外的活动任务；已有 prompt 优先，避免刷新时任务只剩编号。 */
function mergeActiveTasks(state: State, summaries: AiTask[], latestSeq: number) {
  const activeIds = new Set(summaries.map((summary) => summary?.runId).filter((id): id is string => typeof id === "string"));
  // 历史请求在途时仍会收到实时状态；task.seq 是入队序号，不能拿它判定状态的新旧。
  // 摘要只覆盖其水位以内的任务状态，避免重开时把 running 改回 queued 或复活已结束的回合。
  const newerStatusIds = new Set([...state.events.values()]
    .filter((event) => event.seq > latestSeq && event.kind === "status" && isAiTaskBackendStatus(event.data.status))
    .map((event) => event.runId));
  // activeTasks 是后端全日志摘要；本地仍活跃但摘要中不存在的项已经终结，不能继续显示幽灵队列。
  state.snapshot = { ...state.snapshot, tasks: state.snapshot.tasks.map((task) =>
    isAiTaskLive(task.status) && task.seq <= latestSeq && !activeIds.has(task.runId) && !newerStatusIds.has(task.runId)
      ? { ...task, status: "cancelled" as const } : task) };
  for (const summary of summaries) {
    if (!summary || typeof summary.runId !== "string" || !isAiTaskBackendActive(summary.status) || newerStatusIds.has(summary.runId)) continue;
    const current = state.snapshot.tasks.find((task) => task.runId === summary.runId);
    const task = { ...summary, started: summary.status === "running", prompt: summary.prompt ?? current?.prompt, seq: Number.isSafeInteger(summary.seq) ? summary.seq : current?.seq ?? 0 };
    const tasks = state.snapshot.tasks.filter((item) => item.runId !== task.runId).concat(task).sort((a, b) => a.seq - b.seq);
    state.snapshot = { ...state.snapshot, tasks };
  }
  const active = state.snapshot.tasks.slice().reverse().find((task) => task.status === "running");
  const latest = state.snapshot.tasks.at(-1);
  state.snapshot = { ...state.snapshot, runId: active?.runId ?? latest?.runId ?? null,
    status: active ? "running" : latest?.status ?? "idle", stopping: active ? stoppingRunIds.has(active.runId) : false };
}
/** 完整模型任务快照覆盖同序号的分页补丁，但绝不覆盖更晚到达的实时进展。 */
function mergeTaskListSummary(state: State, summary: AiModelTaskList) {
  if (!state.taskListSummary || summary.seq >= state.taskListSummary.seq) state.taskListSummary = summary;
  const source = state.taskListSummary;
  if (!state.snapshot.taskList || source.seq >= state.snapshot.taskList.seq) {
    state.snapshot = { ...state.snapshot, taskList: source };
  }
}
function mergePageTaskList(state: State, page: Page) {
  const summary = normalizeAiModelTaskList(page.taskList);
  if (summary) mergeTaskListSummary(state, summary);
}
/** Goal 摘要按事件序号覆盖；goal:null 是有效终态，不能当“没有返回字段”。 */
function mergeGoalSummary(state: State, summary: AiGoalSummary) {
  if (!state.goalSummary || summary.seq >= state.goalSummary.seq) state.goalSummary = summary;
  const source = state.goalSummary;
  if (!state.snapshot.goal || source.seq >= state.snapshot.goal.seq) {
    state.snapshot = { ...state.snapshot, goal: source.goal ?? undefined };
  }
}
function mergePageGoal(state: State, page: Page) {
  const summary = normalizeAiGoalSummary(page.goal);
  if (summary) mergeGoalSummary(state, summary);
}
function applyFailure(state: State) {
  if (state.failure) {
    const task = state.snapshot.tasks.find((item) => item.runId === state.failure!.runId);
    if (task) state.snapshot = { ...state.snapshot, tasks: state.snapshot.tasks.map((item) => item.runId === task.runId ? { ...item, status: "failed", error: state.failure!.error } : item) };
  }
  if (state.failure && state.snapshot.runId === state.failure.runId) state.snapshot = {
    ...state.snapshot, status: "failed", stopping: false, error: state.failure.error,
    requests: state.snapshot.requests.map((request) => request.runId === state.failure!.runId ? { ...request, active: false } : request),
  };
}
/** 只推进正文与工具输出的高频事件；词表外的任何 kind 都算紧急，宁可多通知一次。 */
const STREAMING_EVENT_KINDS = new Set(["text", "message", "reasoning", "reasoning_delta", "tool", "command_output"]);
function projectBatch(id: string, batch: AiRuntimeEvent[]) {
  const state = store(id);
  const appendOnly = batch.every((event) => event.seq > state.maxSeq);
  for (const event of batch) {
    const summary = goalSummaryFromEvent(event);
    if (summary && (!state.goalSummary || summary.seq >= state.goalSummary.seq)) state.goalSummary = summary;
  }
  state.snapshot = projectAiEvents(appendOnly ? batch : [...state.events.values()], state.snapshot, appendOnly);
  state.maxSeq = batch.reduce((max, event) => Math.max(max, event.seq), state.maxSeq);
  if (!appendOnly && state.activeSummary) mergeActiveTasks(state, state.activeSummary.tasks, state.activeSummary.seq);
  if (state.taskListSummary) mergeTaskListSummary(state, state.taskListSummary);
  if (state.goalSummary) mergeGoalSummary(state, state.goalSummary);
  applySummary(state); applyFailure(state);
  releaseInactiveCache(id);
}
function flushPendingStreaming(onlyId?: string) {
  const batches = onlyId
    ? (pendingStreaming.has(onlyId) ? [[onlyId, pendingStreaming.get(onlyId)!] as const] : [])
    : [...pendingStreaming.entries()];
  for (const [id, batch] of batches) {
    pendingStreaming.delete(id);
    if (batch.length) projectBatch(id, batch);
  }
}
function merge(events: AiRuntimeEvent[], owned = false) {
  const touched = new Map<string, AiRuntimeEvent[]>();
  let ownershipTouched = false;
  for (const event of events) {
    if (!event || typeof event.sessionId !== "string" || typeof event.runId !== "string" || !Number.isSafeInteger(event.seq) || event.seq < 1 || !event.data || typeof event.data !== "object" || deleted.has(event.sessionId)) continue;
    if (event.kind === "status" && isAiTaskBackendStatus(event.data.status) && isAiTaskTerminal(event.data.status)) {
      stoppingRunIds.delete(event.runId);
    }
    // Tauri 事件只来自当前桌面进程，可以建立控制权；磁盘历史调用 merge 时不能。
    if (owned && event.kind === "status" && isAiTaskBackendStatus(event.data.status)) {
      markOwnedTask(event.sessionId, event.runId, event.data.status);
      ownershipTouched = true;
    }
    const state = store(event.sessionId);
    if (state.events.has(event.seq)) continue;
    state.events.set(event.seq, event);
    const batch = touched.get(event.sessionId) ?? []; batch.push(event); touched.set(event.sessionId, batch);
  }
  let immediate = false;
  for (const [id, batch] of touched) {
    if (owned && batch.every((event) => STREAMING_EVENT_KINDS.has(event.kind))) {
      const pending = pendingStreaming.get(id) ?? [];
      pending.push(...batch);
      pendingStreaming.set(id, pending);
      continue;
    }
    // 状态/审批等事件必须看到它前面的全部正文，先把同会话欠着的一帧投影补上。
    flushPendingStreaming(id);
    projectBatch(id, batch);
    immediate = true;
  }
  if (!touched.size) { if (ownershipTouched) changed(); return; }
  // 只有正文与工具进度攒到下一帧；状态、审批、用量这些会改按钮和卡片的事件当场通知，
  // 否则「停止」按钮和审批卡片会比它们该出现的时间晚一帧。
  immediate ? changed() : changedSoon();
}
/** 后端在无法走事件流时回报的失败（例如进程起不来）。 */
interface RuntimeFailure {
  /** 出问题的会话。 */
  sessionId: string;
  /** 出问题的那一轮；与当前 run 不一致的旧失败会被丢弃。 */
  runId: string;
  /** 可直接展示的错误文本。 */
  error: string;
}
/**
 * 处理一次失败回报。会话已删除、或失败属于更早的某一轮时直接忽略，
 * 免得把新一轮的正常状态覆盖成旧错误。
 */
function receiveFailure(failure: RuntimeFailure) {
  if (!failure || typeof failure.sessionId !== "string" || typeof failure.runId !== "string" || typeof failure.error !== "string" || deleted.has(failure.sessionId)) return;
  const state = store(failure.sessionId);
  stoppingRunIds.delete(failure.runId);
  markOwnedTask(failure.sessionId, failure.runId, "failed");
  state.failure = { runId: failure.runId, error: failure.error };
  const task = state.snapshot.tasks.find((item) => item.runId === failure.runId);
  if (task) state.snapshot = { ...state.snapshot, tasks: state.snapshot.tasks.map((item) => item.runId === failure.runId ? { ...item, status: "failed" as const, error: failure.error } : item) };
  else if (!state.snapshot.runId) state.snapshot = { ...state.snapshot, runId: failure.runId };
  applyFailure(state); releaseInactiveCache(failure.sessionId); changed();
}
/**
 * 挂上后端事件监听。全局只挂一次：重复调用返回同一个 Promise，
 * 失败时把缓存清空，让下一次还能重试。
 */
export function ensureAiRuntimeListener(): Promise<void> {
  if (!isTauri()) return Promise.reject(new Error("AI runtime requires the Forge desktop app"));
  if (!listening) listening = (async () => {
    const unlisten = await listen<AiRuntimeEvent[]>("ai-runtime://events", ({ payload }) => {
      if (!Array.isArray(payload)) return;
      merge(payload, true);
      if (typeof window !== "undefined" && payload.some((event) => event.kind === "user" || event.kind === "bound")) window.dispatchEvent(new Event("ai-session-metadata"));
    });
    try { await listen<RuntimeFailure>("ai-runtime://errors", ({ payload }) => receiveFailure(payload)); }
    catch (error) { unlisten(); throw error; }
  })().catch((error) => { listening = null; throw error; });
  return listening;
}
/** 一页取多少条事件。后端另有字节预算，所以这个数只是条数上限，不会把几 MB 一次灌进内存。 */
const PAGE_LIMIT = 500;
/**
 * 加载首屏历史：取**最新**的一页，而不是从第一条开始。
 *
 * 一个跑了几百轮的会话有几十 MB 记录，从 seq 0 往后翻等于让用户一直点「加载更多」
 * 才看得到正在聊的那里；所以打开会话必须落在末尾，更早的记录由 `loadOlderAiMessages` 往前翻。
 *
 * 并发的重复调用共享同一个 Promise，避免同一页被拉两次；
 * 首次加载失败时保留 `loaded=false`，下次进入会话还会重试。
 */
export async function loadAiMessages(sessionId: string, workspace: string, refresh = false, explicitOpen = true): Promise<void> {
  // 只有组件明确打开/聚焦会话才撤销释放；内部排队刷新不能把已关闭标签重新留在内存。
  if (explicitOpen) releaseRequested.delete(sessionId);
  const state = store(sessionId); state.workspace = workspace;
  if (state.loading) {
    if (!refresh) return state.loading;
    // 旧分页不能代替重连刷新；即使旧请求失败，也仍需尝试获取最新活动任务。
    if (!state.refreshing) state.refreshing = (async () => {
      while (state.loading) { try { await state.loading; } catch { /* 最新页请求会独立报告结果。 */ } }
      if (!deleted.has(sessionId)) await loadAiMessages(sessionId, workspace, true, false);
    })().finally(() => { state.refreshing = undefined; });
    return state.refreshing;
  }
  if (state.snapshot.loaded && !refresh) return;
  const pending = (async () => {
    patch(sessionId, { loading: true, error: null });
    try {
      await ensureAiRuntimeListener();
      let page = await invoke<Page>("ai_runtime_load", { sessionId, workspace, limit: PAGE_LIMIT });
      if (deleted.has(sessionId)) return;
      const initialPage = page;
      merge(page.events);
      mergePageTaskList(state, page);
      mergePageGoal(state, page);
      // 首屏已成功就保存向前游标；后续补采失败也不能让已显示的历史无法翻页。
      patch(sessionId, { hasOlder: page.hasOlder && page.events.length > 0, cursor: page.events.length ? page.nextSeq : 0 });
      // 最新页之后可能还有原生补采；按事件游标续读，保留最初的向前分页边界。
      while (page.hasMore) {
        const afterSeq = page.events.at(-1)?.seq;
        if (afterSeq === undefined) throw new Error("原生历史同步没有推进游标");
        page = await invoke<Page>("ai_runtime_load", { sessionId, workspace, afterSeq, limit: PAGE_LIMIT });
        if (deleted.has(sessionId)) return;
        if (page.hasMore && (!page.events.length || page.events.at(-1)!.seq <= afterSeq)) throw new Error("原生历史同步没有推进游标");
        merge(page.events);
        mergePageTaskList(state, page);
        mergePageGoal(state, page);
      }
      if (Number.isSafeInteger(page.latestSeq) && page.latestRunId && page.status) state.summary = { seq: page.latestSeq!, runId: page.latestRunId, status: page.status };
      applySummary(state); applyFailure(state);
      // 计划记录不在事件分页里：事件投影优先（带 seq），其余由 plans.json 补齐。
      if (Array.isArray(page.plans) && page.plans.length) {
        const merged = new Map(page.plans.map((plan) => [`${plan.planId}:${plan.revision}`, plan]));
        for (const plan of state.snapshot.plans) merged.set(`${plan.planId}:${plan.revision}`, plan);
        state.snapshot = { ...state.snapshot, plans: [...merged.values()].sort((a, b) => a.createdAt - b.createdAt || a.revision - b.revision) };
      }
      if (Array.isArray(page.activeTasks)) {
        state.activeSummary = { tasks: page.activeTasks, seq: Number.isSafeInteger(page.latestSeq) ? page.latestSeq! : state.maxSeq };
        mergeActiveTasks(state, state.activeSummary.tasks, state.activeSummary.seq);
      }
      // 空会话没有游标可言；此时 nextSeq 是 0，留着它只会让「更早」按钮点亮又翻不出东西。
      patch(sessionId, { loaded: true, hasOlder: initialPage.hasOlder && initialPage.events.length > 0, cursor: initialPage.events.length ? initialPage.nextSeq : 0, nativeId: state.snapshot.nativeId ?? page.nativeId, ...(page.warning || initialPage.warning ? { error: page.warning ?? initialPage.warning } : {}) });
    } catch (error) { if (!deleted.has(sessionId)) patch(sessionId, { error: String(error) }); throw error; }
    finally { state.loading = null; if (!deleted.has(sessionId)) patch(sessionId, { loading: false }); }
  })();
  state.loading = pending; return pending;
}
/**
 * 往前翻一页：取已加载的最老一条之前那一段。
 *
 * 游标只会往更小的方向走，并且带上「这页确实读到了东西」的判断：
 * 后端连续返回空页时直接把「更早」关掉，否则按钮会亮着却什么都翻不出来。
 *
 * `limit` 由调用方按还剩多少距离要给：跳到某一轮时不该先取满一页再等下一页，
 * 但也不许小于 PAGE_LIMIT，否则一屏滚动就只前进几条。
 */
export async function loadOlderAiMessages(sessionId: string, workspace: string, limit = PAGE_LIMIT, pages = 1): Promise<void> {
  const state = store(sessionId); state.workspace = workspace;
  if (state.loading || !state.snapshot.hasOlder || !state.snapshot.cursor) return;
  const pending = (async () => {
    patch(sessionId, { loading: true, error: null });
    try {
      await ensureAiRuntimeListener();
      // 字节预算会把大页截短；连续准备三页，整批共用加载锁，逐页显示并保持阅读位置。
      for (let index = 0; index < Math.min(3, Math.max(1, pages)); index++) {
        const cursor = state.snapshot.cursor;
        const page = await invoke<Page>("ai_runtime_load", { sessionId, workspace, beforeSeq: cursor, limit });
        if (deleted.has(sessionId)) return;
        const advanced = page.events.length > 0 && page.nextSeq < cursor;
        // 重复页属于协议错误，不可伪装成历史耗尽；保留游标供用户重试。
        if (page.events.length > 0 && !advanced) throw new Error("历史分页游标未前进，请重试");
        merge(page.events);
        mergePageTaskList(state, page);
        mergePageGoal(state, page);
        patch(sessionId, { hasOlder: page.hasOlder && advanced, cursor: advanced ? page.nextSeq : cursor });
        if (!state.snapshot.hasOlder) break;
      }
    } catch (error) { if (!deleted.has(sessionId)) patch(sessionId, { error: String(error) }); throw error; }
    finally { state.loading = null; if (!deleted.has(sessionId)) patch(sessionId, { loading: false }); }
  })();
  state.loading = pending; return pending;
}
/** 一次跳转最多往前补这么多页；再多就停下来认「这一轮太远」，不能把整个会话悄悄搬进内存。 */
const THROUGH_PAGE_LIMIT = 12;
/** 单次补齐的条数上限。后端另有字节预算兜底，这个数只防止一次要回上万条事件。 */
const THROUGH_EVENT_LIMIT = 5000;
/**
 * 把正文一直加载到目标序号为止，消息导航点未加载的那一行时用它。
 *
 * 走的是「更早」那条路径：游标连续往前挪，中间不留没读到的空洞，
 * 投影出来的时间线因此还是完整的一段对话，而不是首尾相接的两半。
 * 返回 false 表示没能到达——要么真的到头了，要么超出一次跳转愿意付的代价。
 */
export async function loadAiMessagesThrough(sessionId: string, workspace: string, targetSeq: number): Promise<boolean> {
  const state = store(sessionId);
  if (!state.snapshot.loaded || state.loading) return false;
  for (let guard = 0; guard < THROUGH_PAGE_LIMIT && state.snapshot.cursor > targetSeq; guard++) {
    const cursor = state.snapshot.cursor;
    const limit = Math.min(THROUGH_EVENT_LIMIT, Math.max(PAGE_LIMIT, cursor - targetSeq));
    await loadOlderAiMessages(sessionId, workspace, limit);
    // 游标没动说明这一页什么都没取到（并发占用或已到顶），继续循环只是空转。
    if (state.snapshot.cursor >= cursor) break;
  }
  return state.snapshot.cursor <= targetSeq;
}

/** 消息导航用的轮次索引：只带每条用户消息的开头一行与该轮改过的文件数，不带正文。 */
export interface AiOutlineTurn {
  /** 该轮 user 事件的序号；正文没加载到那里时靠它往前补齐。 */
  seq: number;
  /** 与正文投影同意的条目 id；用它判断这一轮在不在已加载的正文里。 */
  entryId: string;
  runId: string;
  /** 首行摘要；空串表示这条消息没有文字（只有附件）。 */
  label: string;
  /** 该轮改过的文件数，按路径去重。 */
  files: number;
}

/** 一个会话的导航索引。 */
export interface AiOutlineSnapshot {
  /** 按序号升序的轮次。 */
  turns: AiOutlineTurn[];
  /** 索引是否覆盖到会话第一条消息；为假时序号只能当相对位置讲。 */
  complete: boolean;
  /** 已经取过一次；取过就不再重复扫盘。 */
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

const EMPTY_OUTLINE: AiOutlineSnapshot = { turns: [], complete: false, loaded: false, loading: false, error: null };
const outlines = new Map<string, AiOutlineSnapshot>();
function patchOutline(id: string, change: Partial<AiOutlineSnapshot>) { outlines.set(id, { ...(outlines.get(id) ?? EMPTY_OUTLINE), ...change }); changed(); }
export function getAiOutline(id: string): AiOutlineSnapshot { return outlines.get(id) ?? EMPTY_OUTLINE; }
export function useAiOutline(id: string): AiOutlineSnapshot { return useSyncExternalStore(subscribeAiChanges, () => getAiOutline(id), () => EMPTY_OUTLINE); }
/**
 * 标签关闭后丢弃可从磁盘重建的正文，只保留侧栏需要的最后终态。
 * 运行中/排队中的会话先记释放意图，等终态事件落地再清，保证后台继续时仍能投影进度。
 */
function releaseInactiveCache(sessionId: string): boolean {
  if (!releaseRequested.has(sessionId)) return false;
  const state = stores.get(sessionId);
  if (!state || state.loading || state.refreshing || state.snapshot.tasks.some((task) => isAiTaskLive(task.status))) return false;
  const latest = state.snapshot.tasks.at(-1);
  if (latest && isAiTaskTerminal(latest.status)) state.lastStatus = latest.status;
  for (const task of state.snapshot.tasks) stoppingRunIds.delete(task.runId);
  state.events.clear();
  state.snapshot = { ...EMPTY };
  state.summary = null;
  state.activeSummary = undefined;
  state.taskListSummary = undefined;
  state.goalSummary = undefined;
  state.maxSeq = 0;
  state.failure = null;
  outlines.delete(sessionId);
  releaseRequested.delete(sessionId);
  return true;
}
export function releaseAiRuntimeSessionCache(sessionId: string): void {
  releaseRequested.add(sessionId);
  const state = stores.get(sessionId);
  const release = () => { if (releaseInactiveCache(sessionId)) changed(); };
  const pending = [state?.loading, state?.refreshing].filter((item): item is Promise<void> => item !== null && item !== undefined);
  if (pending.length) {
    // 两条链无论成功失败都会在 finally 中撤掉标记；全部收尾后再判断能否安全释放。
    void Promise.allSettled(pending).then(release);
  } else {
    release();
  }
}
/**
 * 取导航要的轮次索引——打开面板时才取，一次列全最近这么多轮。
 *
 * 正文分页一页只装得下几百条事件，长会话里连一轮都铺不满，导航跟着它就只能显示一条记录。
 * 索引不碰正文和工具输出，几百轮也就几百 KB，才敢一次取回、按序号一路数下去。
 */
export async function loadAiOutline(sessionId: string, workspace: string): Promise<void> {
  if (deleted.has(sessionId)) return;
  const current = outlines.get(sessionId);
  if (current?.loading || current?.loaded) return;
  patchOutline(sessionId, { loading: true, error: null });
  try {
    const page = await invoke<{ turns?: AiOutlineTurn[]; complete?: boolean }>("ai_runtime_outline", { sessionId, workspace });
    if (deleted.has(sessionId)) return;
    patchOutline(sessionId, { turns: Array.isArray(page.turns) ? page.turns : [], complete: page.complete === true, loaded: true, loading: false });
  } catch (error) {
    if (!deleted.has(sessionId)) patchOutline(sessionId, { loading: false, error: String(error) });
    throw error;
  }
}
/** 发送 IPC 失败后无论停止补偿是否命中，都必须终结本地占位；后续真实事件仍可覆盖这个失败快照。 */
async function failOptimisticSubmission(sessionId: string, runId: string, error: unknown): Promise<void> {
  let stopError: unknown;
  try { await invoke("ai_runtime_stop", { runId }); }
  catch (cause) { stopError = cause; }
  receiveFailure({ sessionId, runId, error: String(error) });
  if (stopError !== undefined) patch(sessionId, { error: `${String(error)}\n${String(stopError)}` });
}
/**
 * 发起一项任务。后端决定立即运行、FIFO 排队或等待外部 CLI；前端只按返回状态投影。
 * CLI 原生会话 ID 是续聊依据；Forge 历史镜像的分页进度不参与发送资格判断。
 */
export async function sendAiMessage(session: AiSession, workspace: string, prompt: string, trusted: boolean, options: AiRunOptions = {}, command?: AiCommandIntent, images: string[] = [], additionalDirs: string[] = []): Promise<void> {
  await ensureAiRuntimeListener();
  releaseRequested.delete(session.id);
  const state = store(session.id); state.workspace = workspace;
  state.failure = null;
  const runId = crypto.randomUUID();
  const seq = Math.max(0, ...state.snapshot.tasks.map((task) => task.seq)) + 0.001;
  updateTask(session.id, { runId, status: "submitting", prompt, seq });
  try {
    // Fast 是二态开关；未开启就明确关闭，不能暗中继承配置中的服务等级。
    const result = await invoke<{ status: AiTaskStatus }>("ai_runtime_send", { request: { sessionId: session.id, runId, provider: session.provider, workspace, title: session.title, prompt, images, trusted, model: options.model || null, effort: options.effort || null, permission: options.permission ?? (session.provider === "codex" ? "inherit" : "ask"), mode: options.mode ?? (options.planMode ? "plan" : null), fast: options.fast ?? false, planMode: options.planMode === true, additionalDirs, ...(command ? { command } : {}) } });
    const current = store(session.id).snapshot.tasks.find((task) => task.runId === runId);
    const accepted = result?.status;
    // 只接受「后端说这一轮还没结束」的返回值：排队/等待外部/立即运行。
    // 本地占位是 submitting，后端答成别的词表外字符串时宁可继续等事件，也不照着改。
    if (current && current.status === "submitting" && isAiTaskBackendActive(accepted)) updateTask(session.id, { ...current, status: accepted });
    if (accepted === "submitting" || isAiTaskBackendActive(accepted)) { markOwnedTask(session.id, runId, accepted); changed(); }
  }
  catch (error) {
    // IPC 报错不等于后端没收到请求：进程可能已经在跑。
    // 所以先按本地预登记的 runId 发停止，再清掉本地运行状态，避免留下看不见的孤儿任务。
    await failOptimisticSubmission(session.id, runId, error);
    throw error;
  }
}

/** 计划决策：批准会开一次执行回合，要求修改会带着反馈继续规划。 */
export type AiPlanDecision = "approve" | "requestChanges";
export async function decideAiPlan(session: AiSession, workspace: string, plan: AiPlanReview, decision: AiPlanDecision, feedback?: string, options: AiRunOptions = {}, additionalDirs: string[] = []): Promise<void> {
  await ensureAiRuntimeListener();
  releaseRequested.delete(session.id);
  const state = store(session.id); state.workspace = workspace;
  state.failure = null;
  const runId = crypto.randomUUID();
  const seq = Math.max(0, ...state.snapshot.tasks.map((task) => task.seq)) + 0.001;
  updateTask(session.id, { runId, status: "submitting", prompt: decision === "approve" ? "" : feedback?.trim() ?? "", seq });
  try {
    const result = await invoke<{ status: AiTaskStatus }>("ai_runtime_send", { request: {
      sessionId: session.id, runId, provider: session.provider, workspace, title: session.title,
      // 计划决策只替换执行正文，模型、强度、权限和授权目录仍使用用户当前选择。
      prompt: "", images: [], trusted: true, model: options.model || null, effort: options.effort || null,
      permission: options.permission ?? "inherit", fast: options.fast ?? false, additionalDirs,
      plan: { planId: plan.planId, revision: plan.revision, decision, feedback: feedback ?? null },
    } });
    const current = store(session.id).snapshot.tasks.find((task) => task.runId === runId);
    const accepted = result?.status;
    if (current && current.status === "submitting" && isAiTaskBackendActive(accepted)) updateTask(session.id, { ...current, status: accepted });
    if (accepted === "submitting" || isAiTaskBackendActive(accepted)) { markOwnedTask(session.id, runId, accepted); changed(); }
  } catch (error) {
    await failOptimisticSubmission(session.id, runId, error);
    throw error;
  }
}
/** 暂不执行：只在本地落账，不启动回合，计划仍可再次提交。 */
export async function deferAiPlan(sessionId: string, workspace: string, planId: string, revision: number): Promise<void> {
  await invoke("ai_runtime_plan_defer", { sessionId, workspace, planId, revision });
}
/** 停止一轮运行。终态只能来自后端事件；IPC 返回成功本身不能伪造 CLI 已中断。 */
export async function stopAiRun(runId: string) {
  const item = [...stores].find(([, state]) => state.snapshot.tasks.some((task) => task.runId === runId));
  const task = item?.[1].snapshot.tasks.find((candidate) => candidate.runId === runId);
  if (item && task && isAiTaskLive(task.status)) {
    stoppingRunIds.add(runId);
    // queued 的停止意图先记在 runId 上；只有它真的转成 running，投影才显示会话级 stopping。
    if (task.status === "submitting" || task.status === "running") patch(item[0], { stopping: true });
  }
  try {
    await invoke("ai_runtime_stop", { runId });
  }
  catch (error) {
    // 后端拒绝时中断并未成立，恢复可操作状态；成功时则一直保留缓冲，直到终态事件确认。
    stoppingRunIds.delete(runId);
    if (item) patch(item[0], { stopping: false, error: String(error) });
    throw error;
  }
}
/** 本窗口这份快照里已经没有这一条待办了：要么已经开始或结束，要么状态还没刷回来。
 *  「不存在」太含糊——队列活在收下它的那个进程里，跨窗口的情况由后端那句更准的说明负责。 */
const NOT_QUEUED_LOCALLY = "这一条已经不在本窗口的待办列表里（可能已经开始或结束了）";
function queuedTaskOwner(runId: string) {
  return [...stores].find(([id, state]) => activityQueuedRunIds.get(id)?.includes(runId)
    && state.snapshot.tasks.some((task) => task.runId === runId && isAiTaskQueued(task.status)));
}
/** 编辑尚未启动的任务；运行中的任务不允许伪装成可编辑队列项。 */
export async function editQueuedAiTask(runId: string, prompt: string) {
  const owner = queuedTaskOwner(runId);
  if (!owner) throw new Error(NOT_QUEUED_LOCALLY);
  await invoke("ai_runtime_queue_update", { runId, prompt });
  const task = owner[1].snapshot.tasks.find((item) => item.runId === runId);
  if (task) updateTask(owner[0], { ...task, prompt: prompt.trim() });
}
/** 用目标 run id 表达顺序，避免另一个窗口更新后旧下标命中错误任务。 */
export async function moveQueuedAiTask(runId: string, beforeRunId: string | null) {
  if (!queuedTaskOwner(runId)) throw new Error(NOT_QUEUED_LOCALLY);
  await invoke("ai_runtime_queue_move", { runId, beforeRunId });
}
/** 立即执行指定排队项：后端原子移到队首，并停止本窗口当前回合。 */
export async function runQueuedAiTaskNow(runId: string) {
  if (!queuedTaskOwner(runId)) throw new Error(NOT_QUEUED_LOCALLY);
  await invoke("ai_runtime_queue_run_now", { runId });
}
/** 清空一个会话的所有排队项；运行中的任务保持不变。 */
export async function clearQueuedAiTasks(sessionId: string) {
  await invoke("ai_runtime_queue_clear", { sessionId });
}
/** 停止全部运行。用于关闭 AI 功能前的兜底，把所有在跑的会话一次性落成已取消。 */
export async function stopAllAiRuns() {
  await invoke("ai_runtime_stop_all");
}
/** 答复一个请求：`{allow}` 表示授权，`{answers}` 表示提问的回答。 */
export async function respondAiRequest(runId: string, requestId: string, answer: AiRequestAnswer) { await invoke("ai_runtime_respond", { runId, requestId, answer }); }
/** Goal 是 Codex 线程状态；这里只暴露用户能直接控制的暂停与继续。 */
export async function setAiGoalStatus(sessionId: string, workspace: string, status: "active" | "paused") {
  await invoke("ai_runtime_set_goal_status", { sessionId, workspace, status });
}
/**
 * 在子代理会话里发消息。两个 CLI 都没有客户端直发子代理的通道，后端会把这条消息
 * 包装成指令注入父会话，由父模型调 SendMessage / followup_task 转达。父会话时间线
 * 会留下转发痕迹；子代理的回复仍按事件路由回子会话。
 */
export async function sendAiAgentMessage(sessionId: string, workspace: string, prompt: string): Promise<void> {
  await ensureAiRuntimeListener();
  releaseRequested.delete(sessionId);
  await invoke("ai_runtime_agent_forward", { sessionId, workspace, prompt });
}
/** 停止单个后台子代理（Claude stop_task）。Codex 子代理不支持单独停止，由后端拒绝。 */
export async function stopAiAgent(sessionId: string, workspace: string): Promise<void> {
  await invoke("ai_runtime_agent_stop", { sessionId, workspace });
}
/** 删除会话：后端删记录成功后才清本地缓存，并记入 `deleted` 防止历史再被导回来。 */
export async function deleteAiRuntimeSession(sessionId: string, workspace: string) { await invoke("ai_runtime_delete", { sessionId, workspace }); deleted.add(sessionId); releaseRequested.delete(sessionId); pendingStreaming.delete(sessionId); for (const task of stores.get(sessionId)?.snapshot.tasks ?? []) stoppingRunIds.delete(task.runId); stores.delete(sessionId); outlines.delete(sessionId); activities.delete(sessionId); activityRoots.delete(sessionId); activityQueued.delete(sessionId); activityRunIds.delete(sessionId); activityQueuedRunIds.delete(sessionId); changed(); }
/**
 * 归档 / 取消归档。后端只改 `meta.json` 的一个布尔位，事件日志与 CLI 原生会话都不动，
 * 所以这里的失败只会让本地状态没变——本地列表始终以 `ai_runtime_list` 为准。
 */
export async function archiveAiRuntimeSession(sessionId: string, workspace: string, archived: boolean) { await invoke("ai_runtime_archive", { sessionId, workspace, archived }); }
/** 置顶 / 取消置顶：与归档同为纯元数据动作，不影响运行中的任务。 */
export async function pinAiRuntimeSession(sessionId: string, workspace: string, pinned: boolean) { await invoke("ai_runtime_set_pinned", { sessionId, workspace, pinned }); }
