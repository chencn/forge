import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import { Toast, EmptyState } from "../ui";
import {
  balloonTimeout,
  clearNotifications,
  dismissBalloon,
  markAllNotificationsRead,
  removeNotification,
  suppressGroup,
  useNotifications,
  type IdeNotification,
} from "./notificationStore";
import styles from "./Notifications.module.css";

const MAX_BALLOONS = 3;

type TranslateFn = ReturnType<typeof useI18n>["t"];

/** 通知动作在组件外构造文案，t 在组件挂载时同步进这个 ref。 */
const tRef = { current: ((key: string) => key) as TranslateFn };

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

/**
 * 通知自身动作之后追加「不再显示」（对齐 openidea notificationActions/canSuppress）：
 * 错误级不可抑制——错误本来就必须让用户看见。
 */
function notificationActions(n: IdeNotification): NonNullable<IdeNotification["actions"]> {
  const own = n.actions ?? [];
  if (n.level === "error") return own;
  return [
    ...own,
    {
      label: tRef.current("notifications.dontShowAgain"),
      run: () => suppressGroup(n.groupId),
    },
  ];
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
      actions={notificationActions(n).map((a) => ({
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
 * 1:1 对齐 IntelliJ IDEA：气泡源是 store 的活动气泡列表（toasts），点叉/超时即从中移除；
 * 当 Notifications 工具窗口打开时自动隐藏气泡
 */
export function Balloons({
  isListOpen = false,
  position = "bottom-right",
}: {
  isListOpen?: boolean;
  /** 屏幕四角位置：跟随 settings.notificationPosition（对齐位置设置语义）。 */
  position?: import("../lib/settings").NotificationPosition;
}) {
  const { t } = useI18n();
  tRef.current = t;
  const balloons = useNotifications((s) => s.toasts);
  const [hover, setHover] = useState(false);

  if (isListOpen || !balloons.length) return null;

  return (
    <div
      className={`notification-toasts-host is-${position}${hover ? " is-hovering" : ""}`}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      aria-live="polite"
    >
      {[...balloons].slice(0, MAX_BALLOONS).reverse().map((n) => (
        <Balloon key={n.id} n={n} />
      ))}
    </div>
  );
}

export const NOTIFICATIONS_TOOL_WINDOW = "notifications";

/**
 * Notifications 工具窗口（右侧活动栏，1:1 对标 IntelliJ IDEA 源码）
 * 历史记录按时间倒序，最新在最前；无任何自造药丸过滤栏或输入框；纯净 Toast 细线列表渲染；
 * 当面板处于展开可见状态时，自动触发 markAllNotificationsRead 将全部通知标记为已读。
 */
export function NotificationsToolWindow({ isOpen = true }: { isOpen?: boolean }) {
  const { t } = useI18n();
  tRef.current = t;
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
          {t("notifications.empty")}
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
            actions={notificationActions(n)}
            onClose={() => removeNotification(n.id)}
          />
        ))
      )}
    </div>
  );
}

/**
 * 对应 IntelliJ IDEA 中的 NotificationsHeaderActions：
 * 头部右侧操作区仅包含单个 Clear All 垃圾桶图标按钮。
 * 用与侧栏工具窗一致的原生 `icon-button is-inline is-hover`：
 * 跟随头部 hover 才显现，配色/尺寸随 `.tool-window-head` 规范走。
 */
export function NotificationsHeaderActions() {
  const { t } = useI18n();
  const count = useNotifications((s) => s.items.filter((n) => n.logged !== false).length);
  return (
    <button
      type="button"
      className="icon-button is-inline is-hover"
      title={t("notifications.clearAll")}
      aria-label={t("notifications.clearAll")}
      disabled={!count}
      onClick={clearNotifications}
    >
      <Trash2 size={16} />
    </button>
  );
}

/** 未读通知数量（用于活动栏按钮 Badge） */
export function useUnreadNotifications(): number {
  return useNotifications((s) => s.items.filter((n) => !n.read && n.logged !== false).length);
}
