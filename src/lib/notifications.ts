/**
 * 通知系统核心数据结构、响应式总线与本地持久化。
 *
 * 1:1 参照 openidea / IntelliJ IDEA 通知中心设计：
 * - 每个功能模块归属独立的 NotificationGroup（如 Git, Maven, Build, LSP, AI, System）；
 * - 支持 Action 操作按钮（如查看日志、重试、解决冲突）；
 * - 区分气泡形态（None / Balloon / Sticky）与是否记入工具窗口历史；
 * - 每个项目独立持久化保留最近 7 天通知历史，过期自动清理；
 * - 统一单例事件总线，解耦全局组件与业务逻辑。
 */
import { useSyncExternalStore, type ReactNode } from "react";
import type { Settings } from "./settings";

export type NotificationLevel = "error" | "warn" | "warning" | "info" | "success";

export type BuiltinNotificationGroup =
  | "git"
  | "maven"
  | "build"
  | "lsp"
  | "ai"
  | "dependencies"
  | "terminal"
  | "system";

export interface NotificationAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

export interface AppNotification {
  id: string;
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

export interface NotifyOptions {
  groupId?: string;
  groupTitle?: string;
  title: string;
  content?: string;
  body?: ReactNode;
  level?: NotificationLevel;
  sticky?: boolean;
  actions?: NotificationAction[];
  projectRoot?: string;
  /** 是否以气泡弹出（默认为 true，若组配置为 None 则遵循配置） */
  balloon?: boolean;
  /** 是否记录到历史面板（默认为 true） */
  logged?: boolean;
}

/** 智能超时：常驻或错误气泡常驻（返回 null），警告 9 秒，其他 6 秒 */
export function balloonTimeout(n: AppNotification): number | null {
  if (n.sticky || n.level === "error") return null;
  return n.level === "warn" || n.level === "warning" ? 9000 : 6000;
}

/** 7 天的毫秒数，用于历史保留窗口。 */
export const NOTIFICATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 最大保留历史条数 */
const MAX_HISTORY_ITEMS = 200;
/** 屏幕最多同时展示的浮动气泡数，防止重叠铺满 */
const MAX_BALLOONS_COUNT = 3;

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
      .slice(0, MAX_HISTORY_ITEMS);
    localStorage.setItem(storageKey(projectRoot), JSON.stringify(active));
  } catch {
    // 存储满或被禁用时忽略
  }
}

/** 当前全局设置缓存引用，用于联动勿扰模式和组系统通知开关 */
let activeSettings: Settings | null = null;

export interface NativeNotifyOptions {
  body?: string;
  tag?: string;
}

/**
 * 唤起操作系统原生通知中心（Windows Action Center / macOS / Linux）
 * 采用双通道优先机制：优先走 Tauri 原生 sys_notify 命令，降级回退到标准 Web Notification API。
 */
export async function sendNativeNotification(
  title: string,
  options?: NativeNotifyOptions
): Promise<boolean> {
  // 1. 优先尝试 Tauri 后端原生命令
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("sys_notify", {
      title,
      body: options?.body ?? "",
    });
    return true;
  } catch {
    // 后端命令不可用时尝试 Webview 标准通知通道
  }

  // 2. 尝试标准 Web Notification API
  if (typeof window !== "undefined" && "Notification" in window) {
    try {
      if (Notification.permission === "granted") {
        const n = new Notification(title, {
          body: options?.body,
          tag: options?.tag,
        });
        n.onclick = () => {
          window.focus();
          try {
            import("@tauri-apps/api/window")
              .then(({ getCurrentWindow }) => {
                const win = getCurrentWindow();
                win.show().catch(() => {});
                win.unminimize().catch(() => {});
                win.setFocus().catch(() => {});
              })
              .catch(() => {});
          } catch {}
        };
        return true;
      }
    } catch {
      // 忽略沙箱限制抛错
    }
  }

  return false;
}

/**
 * 请求系统原生通知权限
 */
export async function requestNativeNotificationPermission(): Promise<boolean> {
  if (typeof window !== "undefined" && "Notification" in window) {
    try {
      if (Notification.permission === "granted") return true;
      if (Notification.permission !== "denied") {
        const permission = await Notification.requestPermission();
        return permission === "granted";
      }
    } catch {
      return false;
    }
  }
  return false;
}

/** 通知中心内部状态 */
interface NotificationCenterState {
  projectRoot: string | null;
  history: AppNotification[];
  items: AppNotification[];
  toasts: AppNotification[];
}

let state: NotificationCenterState = {
  projectRoot: null,
  history: [],
  items: [],
  toasts: [],
};

const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

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

  /** 切换当前活跃工程根，自动同步载入对应的隔离历史。 */
  switchProjectRoot: (projectRoot: string | null) => {
    if (state.projectRoot === projectRoot) return;
    const history = loadNotifications(projectRoot);
    updateState((prev) => ({
      ...prev,
      projectRoot,
      history,
      items: history,
    }));
  },

  /** 同步当前全局设置，用于联动勿扰模式和通知组的系统原生通知策略。 */
  syncSettings: (settings: Settings | null) => {
    activeSettings = settings;
  },

  /** 发布通知 */
  notify: (opts: NotifyOptions): string => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const root = opts.projectRoot ?? state.projectRoot ?? "";
    const level = opts.level ?? "info";
    const groupId = opts.groupId ?? "system";
    const isSticky = opts.sticky ?? (level === "error");

    // 勿扰模式下静默所有浮动气泡
    const isDnd = activeSettings?.notificationDoNotDisturb === true;
    const isBalloon = !isDnd && opts.balloon !== false;
    const isLogged = opts.logged !== false;
    const now = Date.now();
    const contentText = typeof opts.body === "string" ? opts.body : (opts.content ?? "");

    const notif: AppNotification = {
      id,
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
      const nextHistory = isLogged ? [notif, ...prev.history].slice(0, MAX_HISTORY_ITEMS) : prev.history;
      const nextToasts = isBalloon ? [notif, ...prev.toasts].slice(0, MAX_BALLOONS_COUNT) : prev.toasts;
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

    // 检查并调度操作系统原生通知：
    // 条件：未开启勿扰、组配置开启了系统通知、且窗口处于非前台聚焦状态（最小化或后台失焦）
    if (activeSettings && !isDnd) {
      const groupRule = activeSettings.notificationGroups?.[groupId];
      const shouldNotifySystem = groupRule?.system === true;
      const isBackground =
        typeof document !== "undefined" &&
        (!document.hasFocus() || document.visibilityState === "hidden");

      if (shouldNotifySystem && isBackground) {
        void sendNativeNotification(opts.title, {
          body: contentText,
          tag: id,
        });
      }
    }

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

  /** 标记全部通知已读 */
  markAllAsRead: () => {
    updateState((prev) => {
      const nextHistory = prev.history.map((it) => ({ ...it, read: true }));
      saveNotifications(prev.projectRoot, nextHistory);
      return {
        ...prev,
        history: nextHistory,
        items: nextHistory,
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
 * 响应式 Hook：订阅通知中心状态
 */
export function useNotificationCenter<T>(selector: (state: NotificationCenterState) => T): T {
  return useSyncExternalStore(
    notificationCenter.subscribe,
    () => selector(notificationCenter.getState()),
    () => selector(notificationCenter.getState())
  );
}
