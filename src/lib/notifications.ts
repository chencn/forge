/**
 * 通知系统核心数据结构、响应式总线与本地持久化。
 *
 * 通知中心设计：
 * - 每个功能模块归属独立的 NotificationGroup（如 Git, Maven, Build, AI, System）；
 * - 支持 Action 操作按钮（如查看日志、重试、解决冲突）；
 * - 气泡形态与位置已固化：右下角弹出、错误常驻、全部记入历史；「不再显示」仅当前会话静默；
 * - 每个项目独立持久化保留最近 7 天通知历史，过期自动清理；
 * - 统一单例事件总线，解耦全局组件与业务逻辑。
 */
import { useSyncExternalStore, type ReactNode } from "react";

/** 通知级别（warn 是 warning 的别名）。 */
export type NotificationLevel = "error" | "warn" | "warning" | "info" | "success";

/** 内置通知分组。 */
export type BuiltinNotificationGroup =
  | "git"
  | "maven"
  | "build"
  | "ai"
  | "dependencies"
  | "terminal"
  | "system";

/** 通知上的快捷操作按钮。 */
export interface NotificationAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

/** 一条通知（气泡与历史共用）。 */
export interface AppNotification {
  id: string;
  /** 业务去重键：同一条件的通知（如同一类 git 错误连发）按 key 替换而非堆叠。 */
  key?: string;
  groupId: string;
  groupTitle?: string;
  title: string;
  content: string;
  body?: ReactNode;
  level: NotificationLevel;
  timestamp: number;
  time: number;
  read: boolean;
  /** 所属项目路径，用于分项目隔离历史。 */
  projectRoot: string;
  /** 是否当前以浮动气泡（Balloon）展示 */
  balloon: boolean;
  /** 是否常驻气泡（不自动倒计时淡出，需用户手动交互或关闭） */
  sticky: boolean;
  /** 是否记录到历史日志面板 */
  logged?: boolean;
  /** 快捷操作按钮列表 */
  actions?: NotificationAction[];
}

/** 发通知的可选参数；标题必填，其余按 {@link AppNotification} 字段缺省。 */
export interface NotifyOptions {
  groupId?: string;
  /** 业务去重键：带 key 的新通知会替换同 key 的旧通知（气泡与历史都替换）。 */
  key?: string;
  groupTitle?: string;
  title: string;
  content?: string;
  body?: ReactNode;
  level?: NotificationLevel;
  sticky?: boolean;
  actions?: NotificationAction[];
  projectRoot?: string;
  /** 是否以气泡弹出（默认为 true；本次会话内被「不再显示」静默的组除外） */
  balloon?: boolean;
  /** 是否记录到历史面板（默认为 true） */
  logged?: boolean;
}

/**
 * 气泡淡出节奏：普通气泡 10 秒；错误与显式常驻 5 分钟后
 * 淡出（前提是已记录进历史——没记录的常驻气泡只能手动关）；返回 null 表示不自动淡出。
 */
export const STICKY_BALLOON_TIMEOUT = 5 * 60 * 1000;

/** 计算气泡自动淡出的毫秒数；null 表示不自动淡出（只能手动关）。 */
export function balloonTimeout(n: Pick<AppNotification, "level" | "sticky" | "logged">): number | null {
  if (n.sticky || n.level === "error") {
    return n.logged === false ? null : STICKY_BALLOON_TIMEOUT;
  }
  return 10000;
}

/** 7 天的毫秒数，用于历史保留窗口。 */
export const NOTIFICATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 最大保留历史条数 */
const MAX_HISTORY_ITEMS = 200;

/** 产生存储 Key，未打开项目时归入全局。 */
function storageKey(projectRoot: string | null): string {
  const norm = projectRoot ? projectRoot.replace(/[/\\]+/g, "/") : "global";
  return `forge:notifications:${norm}`;
}

/** 读取项目的历史通知，自动丢弃超过 7 天的旧记录。 */
export function loadNotifications(projectRoot: string | null): AppNotification[] {
  try {
    const raw = localStorage.getItem(storageKey(projectRoot));
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    const now = Date.now();
    return list.filter(
      (item): item is AppNotification =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as AppNotification).id === "string" &&
        typeof (item as AppNotification).timestamp === "number" &&
        now - (item as AppNotification).timestamp <= NOTIFICATION_MAX_AGE_MS
    );
  } catch {
    return [];
  }
}

/** 保存项目的历史通知，自动丢弃超过 7 天的旧记录并持久化。 */
export function saveNotifications(
  projectRoot: string | null,
  list: AppNotification[]
): void {
  try {
    const now = Date.now();
    const active = list
      .filter((item) => now - item.timestamp <= NOTIFICATION_MAX_AGE_MS)
      .slice(0, MAX_HISTORY_ITEMS)
      // balloon 是会话内的浮动气泡状态，不随历史持久化，避免重启后幽灵气泡
      .map((item) => (item.balloon ? { ...item, balloon: false } : item))
      // actions 是函数、body 可能是 ReactNode：序列化只会得到僵尸数据，恢复的条目
      // 按 content/title/level/time 渲染即可（Toast 已有 body ?? content 兜底）。
      .map(({ actions: _actions, body: _body, ...rest }) => rest);
    localStorage.setItem(storageKey(projectRoot), JSON.stringify(active));
  } catch {
    // 存储满或被禁用时忽略
  }
}

/** 通知中心内部状态 */
interface NotificationCenterState {
  projectRoot: string | null;
  history: AppNotification[];
  items: AppNotification[];
  toasts: AppNotification[];
}

/** 通知中心当前状态（单例可变状态，见 {@link notificationCenter}）。 */
let state: NotificationCenterState = {
  projectRoot: null,
  history: [],
  items: [],
  toasts: [],
};

/** 状态订阅者（useSyncExternalStore 用）。 */
const listeners = new Set<() => void>();

/**
 * 本次会话里被「不再显示」的组。通知策略已固化，不再写设置；
 * 重启后恢复默认（弹气泡 + 记历史），避免一次误点永久静默某个组。
 */
const suppressedGroups = new Set<string>();

/** 通知所有订阅者。 */
function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

/** 替换状态并广播变更。 */
function updateState(fn: (prev: NotificationCenterState) => NotificationCenterState) {
  state = fn(state);
  emitChange();
}

/**
 * 全局通知中心单例对象 (Notification Center)
 */
export const notificationCenter = {
  getState: () => state,

  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** 切换当前活跃工程根，自动同步载入对应的隔离历史；浮动气泡随会话废弃。 */
  switchProjectRoot: (projectRoot: string | null) => {
    if (state.projectRoot === projectRoot) return;
    const history = loadNotifications(projectRoot);
    updateState((prev) => ({
      ...prev,
      projectRoot,
      history,
      items: history,
      toasts: [],
    }));
  },

  /** 发布通知 */
  notify: (opts: NotifyOptions): string => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const root = opts.projectRoot ?? state.projectRoot ?? "";
    const level = opts.level ?? "info";
    const groupId = opts.groupId ?? "system";
    // 通知策略已固化为默认值：普通通知弹气泡并记历史，错误常驻；
    // 只有用户在这次会话里点过「不再显示」的组才不弹气泡（历史照记）。
    const displayType = suppressedGroups.has(groupId) ? "none" : "balloon";
    const isSticky = opts.sticky ?? level === "error";
    const isBalloon = opts.balloon !== false && displayType !== "none";
    const isLogged = opts.logged !== false;
    const now = Date.now();
    const contentText = typeof opts.body === "string" ? opts.body : (opts.content ?? "");

    const notif: AppNotification = {
      id,
      key: opts.key,
      groupId,
      groupTitle: opts.groupTitle,
      title: opts.title,
      content: contentText,
      body: opts.body,
      level,
      timestamp: now,
      time: now,
      read: false,
      projectRoot: root,
      balloon: isBalloon,
      sticky: isSticky,
      logged: isLogged,
      actions: opts.actions,
    };

    updateState((prev) => {
      // 同 key 替换而非堆叠（notify 的 key 去重）
      const rest = opts.key
        ? prev.history.filter((x) => x.key !== opts.key)
        : prev.history;
      const nextHistory = isLogged ? [notif, ...rest].slice(0, MAX_HISTORY_ITEMS) : prev.history;
      // 气泡队列存全量：第 4 条起排队，关掉一条补位（Balloons 的 slice 语义）
      const restToasts = opts.key
        ? prev.toasts.filter((x) => x.key !== opts.key)
        : prev.toasts;
      const nextToasts = isBalloon ? [notif, ...restToasts] : prev.toasts;
      if (isLogged) {
        saveNotifications(prev.projectRoot, nextHistory);
      }
      return {
        ...prev,
        history: nextHistory,
        items: nextHistory,
        toasts: nextToasts,
      };
    });

    return id;
  },

  /** 关闭特定浮动气泡 */
  dismissBalloon: (id: string | number) => {
    const idStr = String(id);
    updateState((prev) => ({
      ...prev,
      toasts: prev.toasts.filter((t) => t.id !== idStr),
    }));
  },

  /** 标记全部通知已读：面板被看过，已记录条目的浮动气泡随之撤下 */
  markAllAsRead: () => {
    updateState((prev) => {
      const nextHistory = prev.history.map((it) => ({ ...it, read: true, balloon: false }));
      saveNotifications(prev.projectRoot, nextHistory);
      return {
        ...prev,
        history: nextHistory,
        items: nextHistory,
        // 面板被看过，气泡一并收走（markAllNotificationsRead）
        toasts: [],
      };
    });
  },

  /** 清空历史记录 */
  clearHistory: () => {
    updateState((prev) => {
      saveNotifications(prev.projectRoot, []);
      return {
        ...prev,
        history: [],
        items: [],
        toasts: [],
      };
    });
  },

  /** 撤下某个业务键的气泡：条件不再成立时由调用方收掉（expireNotification）。 */
  expireNotification: (key: string) => {
    updateState((prev) => ({
      ...prev,
      toasts: prev.toasts.filter((t) => t.key !== key),
    }));
  },

  /** 删除单条历史通知 */
  removeNotification: (id: string | number) => {
    const idStr = String(id);
    updateState((prev) => {
      const nextHistory = prev.history.filter((it) => it.id !== idStr);
      const nextToasts = prev.toasts.filter((it) => it.id !== idStr);
      saveNotifications(prev.projectRoot, nextHistory);
      return {
        ...prev,
        history: nextHistory,
        items: nextHistory,
        toasts: nextToasts,
      };
    });
  },
};

/**
 * 「不再显示」（suppressGroup）：本次会话内该组不再弹气泡，
 * 气泡立即收下、历史照记。策略已固化，这里不写设置，重启即恢复默认。
 */
export function suppressGroup(group: string): void {
  suppressedGroups.add(group);
  updateState((prev) => ({
    ...prev,
    items: prev.items.flatMap((x) =>
      x.groupId !== group || !x.balloon ? [x] : x.logged === false ? [] : [{ ...x, balloon: false }]
    ),
    toasts: prev.toasts.filter((t) => t.groupId !== group),
  }));
}

/**
 * 响应式 Hook：订阅通知中心状态
 */
export function useNotificationCenter<T>(selector: (state: NotificationCenterState) => T): T {
  return useSyncExternalStore(
    notificationCenter.subscribe,
    () => selector(notificationCenter.getState()),
    () => selector(notificationCenter.getState())
  );
}
