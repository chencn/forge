/**
 * 通知系统核心数据结构与本地持久化。
 *
 * 参照 IntelliJ IDEA 的通知中心设计：
 * - 每个项目独立保存通知历史；
 * - 自动保留最近 7 天，过期的通知在读取和写入时自动剔除；
 * - 支持未读状态追踪与清理。
 */

export type NotificationLevel = "error" | "warn" | "info";

export interface AppNotification {
  id: string;
  title: string;
  content: string;
  level: NotificationLevel;
  timestamp: number;
  read: boolean;
  /** 所属项目路径，用于分项目隔离历史。 */
  projectRoot: string;
}

/** 7 天的毫秒数，用于历史保留窗口。 */
export const NOTIFICATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
    const active = list.filter((item) => now - item.timestamp <= NOTIFICATION_MAX_AGE_MS);
    localStorage.setItem(storageKey(projectRoot), JSON.stringify(active));
  } catch {
    // 存储满或被禁用时忽略
  }
}
