import { useEffect, useRef } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  Info,
  X,
} from "lucide-react";
import type { AppNotification } from "../lib/notifications";
import type { NotificationPosition } from "../lib/settings";
import { useI18n } from "../i18n";

/** 时间戳格式化为人话或日期。 */
function formatRelativeTime(timestamp: number, todayText: string, yesterdayText: string): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 30) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  const date = new Date(timestamp);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timeStr = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  if (isToday) return `${todayText} ${timeStr}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) return `${yesterdayText} ${timeStr}`;

  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${timeStr}`;
}

/** 等级对应的图标。 */
function LevelIcon({ level }: { level: AppNotification["level"] }) {
  if (level === "error") {
    return <AlertCircle size={15} className="notification-icon is-error" aria-hidden="true" />;
  }
  if (level === "warn") {
    return <AlertTriangle size={15} className="notification-icon is-warn" aria-hidden="true" />;
  }
  return <Info size={15} className="notification-icon is-info" aria-hidden="true" />;
}

/** 单个气泡（Toast / Balloon）展示。无左侧粗竖线，纯净圆角卡片。 */
function NotificationToast({
  notification,
  onDismiss,
}: {
  notification: AppNotification;
  onDismiss: () => void;
}) {
  const timerRef = useRef<number | null>(null);

  const startTimer = () => {
    // 错误通知停留 9 秒，其他 6 秒自动淡出
    const duration = notification.level === "error" ? 9000 : 6000;
    timerRef.current = window.setTimeout(onDismiss, duration);
  };

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    startTimer();
    return clearTimer;
  }, []);

  return (
    <div
      className={`notification-balloon is-${notification.level}`}
      role="alert"
      onMouseEnter={clearTimer}
      onMouseLeave={startTimer}
    >
      <div className="notification-balloon-lead">
        <LevelIcon level={notification.level} />
      </div>
      <div className="notification-balloon-body">
        <div className="notification-balloon-title">{notification.title}</div>
        <div className="notification-balloon-content">{notification.content}</div>
      </div>
      <button
        type="button"
        className="icon-button notification-balloon-close"
        onClick={onDismiss}
        title="关闭"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/**
 * 浮动通知气泡容器：
 * 支持通过设置配置弹出在右下角、右上角、左下角或左上角。
 */
export function NotificationToasts({
  toasts,
  position = "bottom-right",
  onDismiss,
  children,
}: {
  toasts: AppNotification[];
  position?: NotificationPosition;
  onDismiss: (id: string) => void;
  children?: React.ReactNode;
}) {
  if (toasts.length === 0 && !children) return null;
  return (
    <div className={`notification-toasts-host is-${position}`} aria-live="polite">
      {children}
      {toasts.map((item) => (
        <NotificationToast
          key={item.id}
          notification={item}
          onDismiss={() => onDismiss(item.id)}
        />
      ))}
    </div>
  );
}

/**
 * Notifications 工具窗口的主体内容（Tool Window View）：
 * 对应 IntelliJ IDEA 的 Notifications 工具窗口面板，按时间线展示当前项目的通知历史。
 */
export function NotificationsView({
  notifications,
  onRemoveItem,
}: {
  notifications: AppNotification[];
  onRemoveItem: (id: string) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="notifications-tool-window">
      <div className="notification-panel-list">
        {notifications.length === 0 ? (
          <div className="notification-panel-empty">{t("notifications.empty")}</div>
        ) : (
          notifications.map((item) => (
            <div
              key={item.id}
              className={`notification-item is-${item.level}${item.read ? " is-read" : ""}`}
            >
              <div className="notification-item-icon">
                <LevelIcon level={item.level} />
              </div>
              <div className="notification-item-main">
                <div className="notification-item-header">
                  <span className="notification-item-title">{item.title}</span>
                  <span className="notification-item-time">
                    {formatRelativeTime(item.timestamp, t("time.today"), t("time.yesterday"))}
                  </span>
                </div>
                <div className="notification-item-content">{item.content}</div>
              </div>
              <button
                type="button"
                className="icon-button notification-item-remove"
                title={t("notifications.delete")}
                onClick={() => onRemoveItem(item.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** 状态栏右侧通知铃铛：点开后停在编辑区右侧，和 Maven 同一侧。 */
export function NotificationBell({
  notifications,
  active,
  onClick,
}: {
  notifications: AppNotification[];
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const unreadCount = notifications.filter((n) => !n.read).length;
  const hasUnreadError = notifications.some((n) => !n.read && n.level === "error");

  return (
    <div className="status-notification-area">
      <button
        type="button"
        className={`status-button notification-trigger${hasUnreadError ? " has-error" : ""}${
          unreadCount > 0 ? " has-unread" : ""
        }${active ? " is-active" : ""}`}
        onClick={onClick}
        title={t("notifications.viewHistory")}
        aria-label={t("notifications.title")}
        aria-pressed={active}
      >
        <Bell size={13} aria-hidden="true" />
        {unreadCount > 0 ? (
          <span className={`notification-badge${hasUnreadError ? " is-error" : ""}`}>
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>
    </div>
  );
}
