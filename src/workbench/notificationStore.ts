import { notificationCenter } from "../lib/notifications";

/**
 * 通知系统状态中心桥接层：
 * 统一指向 `src/lib/notifications.ts`，1:1 对标 openidea notificationStore。
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

export const clearNotifications = () => {
  notificationCenter.clearHistory();
};

export const markAllNotificationsRead = () => {
  notificationCenter.markAllAsRead();
};
