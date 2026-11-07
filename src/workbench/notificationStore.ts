import { notificationCenter, suppressGroup as suppressGroupImpl } from "../lib/notifications";

/**
 * 通知系统状态中心桥接层：
 * 统一指向 `src/lib/notifications.ts`。
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

/** 发一条通知（转给 {@link notificationCenter}）。 */
export const notify = (opts: import("../lib/notifications").NotifyOptions) => {
  return notificationCenter.notify(opts);
};

/** 收起一条气泡（保留在通知中心历史里）。 */
export const dismissBalloon = (id: string | number) => {
  notificationCenter.dismissBalloon(id);
};

/** 从通知中心彻底移除一条。 */
export const removeNotification = (id: string | number) => {
  notificationCenter.removeNotification(id);
};

/** 撤下某个业务键的气泡（expireNotification）。 */
export const expireNotification = (key: string) => {
  notificationCenter.expireNotification(key);
};

/** 「不再显示」：整组改成不弹气泡，写回用户设置（suppressGroup）。 */
export const suppressGroup = (group: string) => {
  suppressGroupImpl(group);
};

/** 清空通知中心历史。 */
export const clearNotifications = () => {
  notificationCenter.clearHistory();
};

/** 全部标记为已读。 */
export const markAllNotificationsRead = () => {
  notificationCenter.markAllAsRead();
};
