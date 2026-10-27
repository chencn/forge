import type { AiProvider } from "./aiCli";

/** 一条本地会话记录。`id` 由后端生成的 CLI 会话 id，前后端共用同一个值。 */
export interface AiSession {
  /** CLI 会话 id，同时用作本地存储与标签 id 的一部分。 */
  id: string;
  /** 该会话属于哪个 CLI，决定图标与恢复时走哪套协议。 */
  provider: AiProvider;
  /** 列表里显示的名字；新建还没发过消息时为空串，界面按「未命名会话」显示；用户可重命名，最长 120 字符。 */
  title: string;
  /** 创建时间（毫秒时间戳），列表按它倒序排列。 */
  createdAt: number;
  /**
   * 归档状态。缺省即未归档，只有真归档过才写入这个键——后端 `meta.json` 才是真相，
   * 本地每次刷新都按它重建；不留 `archived: false` 是为了让新旧缓存在字符串上等价。
   */
  archived?: boolean;
  /**
   * 置顶状态与置顶时间。置顶的会话进侧栏「置顶」章节并按置顶时间倒序；
   * 与归档一样只在真置顶时写入，缺省即未置顶。
   */
  pinned?: boolean;
  pinnedAt?: number;
  /** 最近一次活动（毫秒时间戳），取自后端事件日志的修改时间；「最近」章节按它排序。 */
  lastActivity?: number;
  /**
   * 父会话 id；只有子代理会话有值。侧栏把它嵌在父会话行下，发送走经父转发，
   * 不能像普通会话那样直接驱动 CLI。
   */
  parentSessionId?: string;
  /** 子代理元数据（标题/状态/类型）；与 `parentSessionId` 同时出现。 */
  agent?: { title: string; status: string; agentType?: string | null; nativeAgentId?: string | null; toolId: string; model?: string | null };
}
/** 一个工作区下的全部会话、打开标签和最后活动标签；一起存储才能准确恢复编辑区。 */
export interface AiSessionState {
  /** 全部会话，包含标签已关闭但记录仍在的那些。 */
  sessions: AiSession[];
  /** 当前打开着的会话 id；只保留 `sessions` 里存在的值。 */
  openIds: string[];
  /** 最后活动的 AI 会话；为 null 表示没有活动 AI 标签。 */
  activeId: string | null;
}
/** 解析失败时的空状态。用常量而非每次新建，便于用引用相等判断「没变化」。 */
export const EMPTY_AI_SESSIONS: AiSessionState = { sessions: [], openIds: [], activeId: null };

/** Windows 路径不区分大小写；Unix 路径保持原样，避免把两个项目混为一谈。 */
export function aiSessionStorageKey(root: string | null) {
  let normalized = (root ?? "").replace(/^\\\\\?\\UNC\\/i, "//").replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[a-z]:\//i.test(normalized) || normalized.startsWith("//")) normalized = normalized.toLowerCase();
  return `forge:ai-sessions:v1:${normalized || (root ? "/" : "global")}`;
}

/**
 * 「同时删除 CLI 原生记录」的默认勾选态。真删不可逆，默认永远是不勾；这里记住的只是
 * 上一次那一下主动选择，而且按 CLI 分开存——Codex 是让 CLI 自己清 rollout，Claude 是直接
 * 删文件，两者的可恢复性不一样，共用一个开关会把一次勾选误扩到另一个引擎上。
 */
const NATIVE_PURGE_KEY = "forge:ai-native-purge:v1";

export function loadNativePurgeDefault(provider: AiProvider): boolean {
  try {
    const raw = localStorage.getItem(NATIVE_PURGE_KEY);
    if (!raw) return false;
    return (JSON.parse(raw) as Partial<Record<AiProvider, boolean>>)[provider] === true;
  } catch {
    return false;
  }
}

export function saveNativePurgeDefault(provider: AiProvider, value: boolean): void {
  try {
    const current = JSON.parse(localStorage.getItem(NATIVE_PURGE_KEY) ?? "{}") as Partial<Record<AiProvider, boolean>>;
    current[provider] = value;
    localStorage.setItem(NATIVE_PURGE_KEY, JSON.stringify(current));
  } catch {
    // 记不住就每次都回到默认不勾：少一点便利，不该拦下删除本身。
  }
}

/** 本地记录按不可信输入处理；原生历史归属由后端校验，此处只恢复会话元数据。 */
export function parseAiSessions(raw: string | null): AiSessionState {
  try {
    const data: unknown = JSON.parse(raw ?? "null");
    if (!data || typeof data !== "object") return EMPTY_AI_SESSIONS;
    const { sessions, openIds, activeId } = data as Record<string, unknown>;
    if (!Array.isArray(sessions)) return EMPTY_AI_SESSIONS;
    const seen = new Set<string>();
    const valid = sessions.filter((item): item is AiSession => {
      if (!item || typeof item !== "object" || typeof item.id !== "string" ||
          !/^[a-zA-Z0-9-]{1,80}$/.test(item.id) || seen.has(item.id) ||
          (item.provider !== "claude" && item.provider !== "codex") ||
          typeof item.title !== "string" || item.title.length > 120 ||
          !Number.isFinite(item.createdAt) || item.createdAt < 0) return false;
      seen.add(item.id);
      return true;
      // 归档位/置顶位缺失或写成别的值都按未归档/未置顶处理；老缓存不需要迁移脚本。
    }).map(({ id, provider, title, createdAt, archived, pinned, pinnedAt, lastActivity, parentSessionId, agent }) => ({
      id, provider, title, createdAt,
      ...(archived === true ? { archived: true } : {}),
      ...(pinned === true ? { pinned: true, ...(Number.isFinite(pinnedAt) && (pinnedAt as number) > 0 ? { pinnedAt: pinnedAt as number } : {}) } : {}),
      ...(Number.isFinite(lastActivity) && (lastActivity as number) > 0 ? { lastActivity: lastActivity as number } : {}),
      // 子代理字段只认完整形状：parentSessionId 存在且合法才透传，坏了按普通会话丢弃。
      ...(() => {
        const info = agent as AiSession["agent"] | undefined;
        return typeof parentSessionId === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(parentSessionId)
          && !!info && typeof info.title === "string" && info.title.trim() && typeof info.status === "string"
          ? { parentSessionId, agent: info } : {};
      })(),
    }));
    const open = Array.isArray(openIds) ? [...new Set(openIds.filter((id): id is string => typeof id === "string" && seen.has(id)))] : [];
    // 旧版没有 activeId；迁移时沿用最后一个打开标签，避免升级后丢失当前会话。
    const active = typeof activeId === "string" && open.includes(activeId) ? activeId : open.at(-1) ?? null;
    return { sessions: valid, openIds: open, activeId: active };
  } catch {
    return EMPTY_AI_SESSIONS;
  }
}

/**
 * 会话动作。`delete` 默认只删 Forge 的本地记录；带 `purgeNative` 时后端连 CLI 原生历史
 * 一起真删（不可逆，Codex 由 CLI 自己清 rollout，Claude 直接删 projects 里那条 jsonl）。
 */
export type AiSessionAction =
  /** 新建会话并立即打开；id 已存在时视为无变化。 */
  | { type: "create"; session: AiSession }
  /** 打开已有会话的标签，重复打开不产生第二个。 */
  | { type: "open"; id: string }
  /** 关闭标签但保留会话记录，之后还能再打开。 */
  | { type: "close"; id: string }
  /** 删除记录并关闭标签；`purgeNative` 为真时把 CLI 原生那一份也删掉。 */
  | { type: "delete"; id: string; purgeNative?: boolean }
  /** 改名；空白名与超长部分会被裁掉，裁完为空则整条动作被忽略。 */
  | { type: "rename"; id: string; title: string }
  /**
   * 归档 / 取消归档。会话记录、标签和 CLI 原生历史都不动，只是默认列表里先收起来。
   * 与删除的区别必须在界面上说得清：归档随时能翻回来。
   */
  | { type: "archive"; id: string; archived: boolean }
  /**
   * 置顶 / 取消置顶。同样只动侧栏归位：置顶章节按置顶时间倒序，其余一概不变。
   */
  | { type: "pin"; id: string; pinned: boolean };

/**
 * 会话状态机。所有分支都返回原引用（而不是新对象）当状态没变，
 * 这样 `useSyncExternalStore` 能直接跳过重渲染。
 */
export function reduceAiSessions(state: AiSessionState, action: AiSessionAction): AiSessionState {
  if (action.type === "create") {
    if (state.sessions.some((item) => item.id === action.session.id)) return state;
    return { sessions: [action.session, ...state.sessions], openIds: [...state.openIds, action.session.id], activeId: action.session.id };
  }
  if (!state.sessions.some((item) => item.id === action.id)) return state;
  if (action.type === "open") {
    if (state.openIds.includes(action.id)) return state.activeId === action.id ? state : { ...state, activeId: action.id };
    return { ...state, openIds: [...state.openIds, action.id], activeId: action.id };
  }
  if (action.type === "close") {
    const openIds = state.openIds.filter((id) => id !== action.id);
    return { ...state, openIds, activeId: state.activeId === action.id ? openIds.at(-1) ?? null : state.activeId };
  }
  if (action.type === "delete") {
    // 子代理跟着父一起走：后端已经把它们的记录删了，本地主动收掉才不用等下一次刷新才收起标签。
    const sessions = state.sessions.filter((item) => item.id !== action.id && item.parentSessionId !== action.id);
    const openIds = state.openIds.filter((id) => sessions.some((item) => item.id === id));
    return { sessions, openIds, activeId: state.activeId && openIds.includes(state.activeId) ? state.activeId : openIds.at(-1) ?? null };
  }
  if (action.type === "archive") {
    const current = state.sessions.find((item) => item.id === action.id);
    // 状态没变就返回原引用：同一个归档按钮点第二次不该触发整列重渲染。
    if (!current || (current.archived === true) === (action.archived === true)) return state;
    return {
      ...state,
      sessions: state.sessions.map((item) => (item.id === action.id
        ? { ...item, archived: action.archived === true ? true : undefined }
        : item)),
    };
  }
  if (action.type === "pin") {
    const current = state.sessions.find((item) => item.id === action.id);
    if (!current || (current.pinned === true) === (action.pinned === true)) return state;
    return {
      ...state,
      // 置顶时间先按本地时钟写一份让章节立即有稳定排序，下一次后端刷新会带回权威值。
      sessions: state.sessions.map((item) => (item.id === action.id
        ? action.pinned
          ? { ...item, pinned: true, pinnedAt: Date.now() }
          : { ...item, pinned: undefined, pinnedAt: undefined }
        : item)),
    };
  }
  const title = action.title.trim().slice(0, 120);
  return title ? { ...state, sessions: state.sessions.map((item) => item.id === action.id ? { ...item, title } : item) } : state;
}
