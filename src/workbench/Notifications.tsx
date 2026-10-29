import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Toast, EmptyState, IconButton } from "../ui";
import {
  balloonTimeout,
  clearNotifications,
  dismissBalloon,
  markAllNotificationsRead,
  removeNotification,
  useNotifications,
  type IdeNotification,
} from "./notificationStore";
import styles from "./Notifications.module.css";

const MAX_BALLOONS = 3;

function timeLabel(t: number) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function toToastLevel(level: import("../lib/notifications").NotificationLevel): "error" | "warning" | "info" | "success" {
  if (level === "warn") return "warning";
  return level;
}

function subscribeWindowFocus(onChange: () => void) {
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
  };
}

/** 窗口是否处于激活状态（聚焦） */
function useWindowActive(): boolean {
  return useSyncExternalStore(
    subscribeWindowFocus,
    () => document.hasFocus(),
    () => true
  );
}

function Balloon({ n }: { n: IdeNotification }) {
  const [hover, setHover] = useState(false);
  const active = useWindowActive();
  const remaining = useRef<number | null>(null);
  const ms = balloonTimeout(n);

  // IDEA 智能计时：仅当窗口激活且鼠标未悬停在气泡上时倒数
  useEffect(() => {
    if (ms === null || hover || !active) return;
    const left = remaining.current ?? ms;
    const start = Date.now();
    const t = window.setTimeout(() => dismissBalloon(n.id), left);
    return () => {
      window.clearTimeout(t);
      remaining.current = Math.max(1, left - (Date.now() - start));
    };
  }, [n.id, ms, hover, active]);

  return (
    <Toast
      className={styles.balloon}
      level={toToastLevel(n.level)}
      title={n.title}
      body={n.body ?? n.content}
      actions={n.actions?.map((a) => ({
        label: a.label,
        run: () => {
          dismissBalloon(n.id);
          a.run();
        },
      }))}
      onClose={() => dismissBalloon(n.id)}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    />
  );
}

/**
 * 右下角堆叠通知气泡宿主（按时间倒序排列，最新在最下方，最多展示 3 条）
 * 1:1 对齐 openidea：当 Notifications 工具窗口打开时自动隐藏气泡
 */
export function Balloons({ isListOpen = false }: { isListOpen?: boolean }) {
  const items = useNotifications((s) => s.items);
  const balloons = items
    .filter((n) => n.balloon)
    .slice(0, MAX_BALLOONS)
    .reverse();

  if (isListOpen || !balloons.length) return null;

  return (
    <div className={styles.stack} aria-live="polite">
      {balloons.map((n) => (
        <Balloon key={n.id} n={n} />
      ))}
    </div>
  );
}

export const NOTIFICATIONS_TOOL_WINDOW = "notifications";

/**
 * Notifications 工具窗口（右侧活动栏，1:1 对标 openidea 源码）
 * 历史记录按时间倒序，最新在最前；无任何自造药丸过滤栏或输入框；纯净 Toast 细线列表渲染；
 * 当面板处于展开可见状态时，自动触发 markAllNotificationsRead 将全部通知标记为已读。
 */
export function NotificationsToolWindow({ isOpen = true }: { isOpen?: boolean }) {
  const all = useNotifications((s) => s.items);
  const items = all.filter((n) => n.logged !== false);
  const unread = all.some((n) => !n.read || n.balloon);

  useEffect(() => {
    if (isOpen && unread) {
      markAllNotificationsRead();
    }
  }, [isOpen, unread]);

  return (
    <div className={styles.list} data-autofocus tabIndex={-1}>
      {items.length === 0 ? (
        <EmptyState icon="bell">
          暂无通知
        </EmptyState>
      ) : (
        items.map((n) => (
          <Toast
            key={n.id}
            className={styles.entry}
            level={toToastLevel(n.level)}
            title={n.title}
            body={n.body ?? n.content}
            meta={timeLabel(n.time || n.timestamp)}
            actions={n.actions}
            onClose={() => removeNotification(n.id)}
          />
        ))
      )}
    </div>
  );
}

/**
 * 对应 openidea 中的 NotificationsHeaderActions：
 * 头部右侧操作区仅包含单个 Clear All 垃圾桶图标按钮。
 */
export function NotificationsHeaderActions() {
  const count = useNotifications((s) => s.items.filter((n) => n.logged !== false).length);
  return (
    <IconButton
      icon="trash"
      title="清空全部通知"
      size="small"
      iconSize={16}
      disabled={!count}
      onClick={clearNotifications}
    />
  );
}

/** 未读通知数量（用于活动栏按钮 Badge） */
export function useUnreadNotifications(): number {
  return useNotifications((s) => s.items.filter((n) => !n.read && n.logged !== false).length);
}
