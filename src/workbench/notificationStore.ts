import { notificationCenter, suppressGroup as suppressGroupImpl } from "../lib/notifications";

/**
 * 通知系统状态中心桥接层：
 * 统一指向 `src/lib/notifications.ts`，1:1 对标 IntelliJ IDEA notificationStore。
 */
export {
  notificationCenter as notificationStore,
  useNotificationCenter as useNotifications,
  balloonTimeout,
  type AppNotification as IdeNotification,
  type NotificationAction,
  type NotificationLevel,
  type NotifyOptions,
} from "../lib/notifications";

export const notify = (opts: import("../lib/notifications").NotifyOptions) => {
  return notificationCenter.notify(opts);
};

export const dismissBalloon = (id: string | number) => {
  notificationCenter.dismissBalloon(id);
};

export const removeNotification = (id: string | number) => {
  notificationCenter.removeNotification(id);
};

/** 撤下某个业务键的气泡（对齐 openidea expireNotification）。 */
export const expireNotification = (key: string) => {
  notificationCenter.expireNotification(key);
};

/** 「不再显示」：整组改成不弹气泡，写回用户设置（对齐 openidea suppressGroup）。 */
export const suppressGroup = (group: string) => {
  suppressGroupImpl(group);
};

export const clearNotifications = () => {
  notificationCenter.clearHistory();
};

export const markAllNotificationsRead = () => {
  notificationCenter.markAllAsRead();
};
