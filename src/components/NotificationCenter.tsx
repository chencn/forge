import { useEffect, useRef, useState, useMemo } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  CheckCheck,
  Info,
  Search,
  Settings as SettingsIcon,
  Trash2,
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
  const minutes = Math.floor(seconds / 1000 / 60);
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
    return <AlertCircle size={16} className="notification-icon is-error" aria-hidden="true" />;
  }
  if (level === "warn" || level === "warning") {
    return <AlertTriangle size={16} className="notification-icon is-warn" aria-hidden="true" />;
  }
  if (level === "success") {
    return <CheckCheck size={16} className="notification-icon is-success" aria-hidden="true" />;
  }
  return <Info size={16} className="notification-icon is-info" aria-hidden="true" />;
}

/**
 * 单个气泡（Toast / Balloon）展示。
 * 1:1 对齐 openidea / IntelliJ IDEA Islands 规范：
 * - 来源组徽章（如 Git、Maven）；
 * - 纯净的 Link 风格操作栏（带下划线，Primary 高亮）；
 * - 顶栏齿轮与关闭按钮（悬停浮现，不破坏内容流）；
 * - 智能计时（悬停暂停倒计时，Sticky 与 Error 永不超时）。
 */
function NotificationToast({
  notification,
  onDismiss,
  onOpenSettings,
}: {
  notification: AppNotification;
  onDismiss: () => void;
  onOpenSettings?: () => void;
}) {
  const timerRef = useRef<number | null>(null);
  const [gearMenuOpen, setGearMenuOpen] = useState(false);

  const startTimer = () => {
    // 错误或显式 Sticky 永不自动超时关闭
    if (notification.sticky || notification.level === "error") return;
    const duration = notification.level === "warn" || notification.level === "warning" ? 9000 : 6000;
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
  }, [notification.sticky, notification.level]);

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
        {notification.groupId ? (
          <div className="notification-balloon-group">
            {notification.groupTitle ?? notification.groupId.toUpperCase()}
          </div>
        ) : null}
        <div className="notification-balloon-title">{notification.title}</div>
        <div className="notification-balloon-content">{notification.content}</div>

        {/* Action 操作超链接栏 */}
        {notification.actions && notification.actions.length > 0 ? (
          <div className="notification-balloon-actions">
            {notification.actions.map((act, idx) => (
              <button
                key={idx}
                type="button"
                className={`notification-action-link ${act.primary ? "is-primary" : ""}`}
                onClick={() => {
                  try {
                    act.run();
                  } finally {
                    onDismiss();
                  }
                }}
              >
                {act.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* 右上角配置齿轮与关闭按钮 */}
      <div className="notification-balloon-controls">
        {onOpenSettings ? (
          <button
            type="button"
            className="notification-balloon-btn"
            onClick={() => setGearMenuOpen(!gearMenuOpen)}
            title="通知设置..."
          >
            <SettingsIcon size={13} />
          </button>
        ) : null}
        <button
          type="button"
          className="notification-balloon-btn"
          onClick={onDismiss}
          title="关闭"
        >
          <X size={14} />
        </button>
      </div>

      {/* 齿轮浮动快捷菜单 */}
      {gearMenuOpen ? (
        <div
          className="notification-gear-menu"
          onMouseLeave={() => setGearMenuOpen(false)}
        >
          <div
            className="notification-gear-item"
            onClick={() => {
              setGearMenuOpen(false);
              onOpenSettings?.();
            }}
          >
            通知设置...
          </div>
        </div>
      ) : null}
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
  onOpenSettings,
  children,
}: {
  toasts: AppNotification[];
  position?: NotificationPosition;
  onDismiss: (id: string) => void;
  onOpenSettings?: () => void;
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
          onOpenSettings={onOpenSettings}
        />
      ))}
    </div>
  );
}

/**
 * Notifications 工具窗口的主体内容（Tool Window View）：
 * 对应 IntelliJ IDEA 的 Notifications 工具窗口面板，按时间线展示当前项目的通知历史。
 * 包含：级别筛选（All / Errors / Warnings）、实时搜索框、全标已读、清空已读按钮。
 */
export function NotificationsView({
  notifications,
  onRemoveItem,
  onMarkAllRead,
  onClearAll,
  onOpenSettings,
}: {
  notifications: AppNotification[];
  onRemoveItem: (id: string) => void;
  onMarkAllRead?: () => void;
  onClearAll?: () => void;
  onOpenSettings?: () => void;
}) {
  const { t } = useI18n();
  const [filterLevel, setFilterLevel] = useState<"all" | "errors" | "warnings">("all");
  const [searchQuery, setSearchQuery] = useState("");

  const filtered = useMemo(() => {
    return notifications.filter((item) => {
      if (filterLevel === "errors" && item.level !== "error") return false;
      if (filterLevel === "warnings" && item.level === "info") return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const inTitle = item.title.toLowerCase().includes(q);
        const inContent = item.content.toLowerCase().includes(q);
        const inGroup = item.groupId?.toLowerCase().includes(q);
        if (!inTitle && !inContent && !inGroup) return false;
      }
      return true;
    });
  }, [notifications, filterLevel, searchQuery]);

  return (
    <div className="notifications-tool-window">
      {/* 顶部工具栏 Toolbar */}
      <div className="notification-toolbar">
        {/* 级别过滤器 */}
        <div className="notification-filter-group">
          <button
            type="button"
            className={`notification-filter-btn ${filterLevel === "all" ? "is-active" : ""}`}
            onClick={() => setFilterLevel("all")}
          >
            全部
          </button>
          <button
            type="button"
            className={`notification-filter-btn ${filterLevel === "errors" ? "is-danger-active" : ""}`}
            onClick={() => setFilterLevel("errors")}
          >
            仅错误
          </button>
          <button
            type="button"
            className={`notification-filter-btn ${filterLevel === "warnings" ? "is-active" : ""}`}
            onClick={() => setFilterLevel("warnings")}
          >
            警告与错误
          </button>
        </div>

        {/* 搜索过滤输入框 */}
        <div className="notification-search-box">
          <Search size={12} className="notification-search-icon" />
          <input
            type="text"
            className="notification-search-input"
            placeholder="筛选通知..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* 工具栏快捷动作组 */}
        <div className="notification-toolbar-actions">
          {onMarkAllRead ? (
            <button
              type="button"
              className="icon-button"
              title="全部标记为已读"
              onClick={onMarkAllRead}
            >
              <CheckCheck size={13} />
            </button>
          ) : null}
          {onClearAll ? (
            <button
              type="button"
              className="icon-button"
              title="清空历史通知"
              onClick={onClearAll}
            >
              <Trash2 size={13} />
            </button>
          ) : null}
          {onOpenSettings ? (
            <button
              type="button"
              className="icon-button"
              title="通知设置"
              onClick={onOpenSettings}
            >
              <SettingsIcon size={13} />
            </button>
          ) : null}
        </div>
      </div>

      {/* 通知列表 */}
      <div className="notification-panel-list">
        {filtered.length === 0 ? (
          <div className="notification-panel-empty">{t("notifications.empty")}</div>
        ) : (
          filtered.map((item) => (
            <div
              key={item.id}
              className={`notification-item is-${item.level}${item.read ? " is-read" : ""}`}
            >
              <div className="notification-item-icon">
                <LevelIcon level={item.level} />
              </div>
              <div className="notification-item-main">
                <div className="notification-item-header">
                  <span className="notification-item-title">
                    {item.groupId ? (
                      <span className="notification-item-group-tag">
                        [{item.groupTitle ?? item.groupId.toUpperCase()}]
                      </span>
                    ) : null}
                    {item.title}
                  </span>
                  <span className="notification-item-time">
                    {formatRelativeTime(item.timestamp, t("time.today"), t("time.yesterday"))}
                  </span>
                </div>
                <div className="notification-item-content">{item.content}</div>

                {/* 历史卡片中的 Action 超链接操作栏 */}
                {item.actions && item.actions.length > 0 ? (
                  <div className="notification-item-actions">
                    {item.actions.map((act, idx) => (
                      <button
                        key={idx}
                        type="button"
                        className={`notification-action-link ${act.primary ? "is-primary" : ""}`}
                        onClick={act.run}
                      >
                        {act.label}
                      </button>
                    ))}
                  </div>
                ) : null}
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
