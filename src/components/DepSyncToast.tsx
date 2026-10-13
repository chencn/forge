import { memo } from "react";
import { useI18n } from "../i18n";
import { formatSyncCommand } from "../lib/depSync";
import type { DepSyncPrompt } from "../lib/depSync";
import type { NotificationPosition } from "../lib/settings";

/**
 * IDEA New UI `AllIcons.General.BalloonInformation`（源自 `platform/icons/src/expui/status/info.svg`）。
 * 16x16 实心蓝圆（浅色 `#4682FA` / 深色 `#548AF7`）配白色 `i`。
 */
function IdeaBalloonInfoIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="dep-sync-info-icon"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="7" fill="var(--idea-notification-info-icon)" />
      <path
        d="M7 11C7 11.5523 7.44772 12 8 12C8.55228 12 9 11.5523 9 11L9 8.5C9 7.94771 8.55228 7.5 8 7.5C7.44771 7.5 7 7.94772 7 8.5L7 11Z"
        fill="#FFFFFF"
      />
      <path
        d="M8 4C7.44771 4 7 4.44772 7 5C7 5.55228 7.44771 6 8 6C8.55228 6 9 5.55228 9 5C9 4.44772 8.55228 4 8 4Z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

/**
 * IDEA New UI `AllIcons.Ide.Notification.Close`（源自 `platform/icons/src/expui/general/closeSmall.svg`）。
 */
function IdeaNotificationCloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11.4939 4.48784C11.3002 4.28007 10.9724 4.27548 10.7729 4.47775L8.00074 7.28849L5.22871 4.47788C5.02922 4.27561 4.70143 4.2802 4.50768 4.48797C4.32506 4.68382 4.32933 4.98882 4.51736 5.17947L7.29908 7.99991L4.51756 10.8201C4.32953 11.0108 4.32526 11.3158 4.50788 11.5116C4.70163 11.7194 5.02942 11.724 5.22892 11.5217L8.00074 8.71133L10.7727 11.5219C10.9722 11.7241 11.3 11.7196 11.4937 11.5118C11.6764 11.3159 11.6721 11.0109 11.484 10.8203L8.7024 7.99991L11.4843 5.17934C11.6723 4.98869 11.6766 4.68368 11.4939 4.48784Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * IDEA Notification Balloon（`NotificationsManagerImpl` + `PackageJsonUpdateNotifier`）风格的依赖同步提示气泡。
 *
 * 布局严格对齐 IDEA Community 源码：
 * - 宽度 `360px`，圆角 `12px`（`Notification.arc`）；
 * - 左侧裸露 `16x16` `BalloonInformation` 图标（无灰底方块），`iconPanelWidth = 32px`、`iconOffset = (10, 7)`；
 * - 第一行加粗标题（`安装依赖项` / `更新依赖项`），第二行正文 `来自 <a href="#">package.json</a>`；
 * - 底部动作区（`isSuggestionType = true`）：第 1 个动作为无图标描边 `JButton`（`运行 'npm install'`），
 *   第 2 个动作为间距 `16px` 的蓝色 `LinkLabel` 文字链接（`不再询问`）；
 * - 右上角关闭按钮悬停气泡时显示。
 */
const DepSyncToast = memo(function DepSyncToast({
  items,
  position = "bottom-right",
  inline = false,
  onSync,
  onDismiss,
  onOpenManifest,
}: {
  items: DepSyncPrompt[];
  position?: NotificationPosition;
  /** 若为 `true`，代表已嵌入外层 `.notification-toasts-host` 堆栈流中，不再重复包裹 fixed 容器。 */
  inline?: boolean;
  onSync: (item: DepSyncPrompt) => void;
  onDismiss: (id: string, permanent?: boolean) => void;
  onOpenManifest?: (manifestRelPath: string, root: string) => void;
}) {
  const { t } = useI18n();
  if (items.length === 0) return null;

  const visible = items.slice(0, 2);

  const cards = visible.map((item) => {
    const title =
      item.reason === "missing"
        ? t("depSync.missingTitle")
        : t("depSync.modifiedTitle");
    const cmd = formatSyncCommand(item.installConfig.command);

    return (
      <div key={item.id} className="dep-sync-card">
        <div className="dep-sync-card-lead">
          <IdeaBalloonInfoIcon />
        </div>
        <div className="dep-sync-card-body">
          <div className="dep-sync-card-title">{title}</div>
          <div className="dep-sync-card-desc">
            <span>{t("depSync.from")} </span>
            <button
              type="button"
              className="dep-sync-file-link"
              onClick={() => onOpenManifest?.(item.manifest, item.root)}
              title={item.manifest}
            >
              {item.manifest}
            </button>
          </div>
          <div className="dep-sync-card-actions">
            <button
              type="button"
              className="dep-sync-action-btn"
              onClick={() => onSync(item)}
            >
              {t("depSync.run", { cmd })}
            </button>
            <button
              type="button"
              className="dep-sync-action-link"
              onClick={() => onDismiss(item.id, true)}
            >
              {t("depSync.dontAskAgain")}
            </button>
          </div>
        </div>
        <button
          type="button"
          className="dep-sync-card-close"
          onClick={() => onDismiss(item.id, false)}
          title={t("depSync.close")}
          aria-label={t("depSync.close")}
        >
          <IdeaNotificationCloseIcon />
        </button>
      </div>
    );
  });

  if (inline) {
    return <>{cards}</>;
  }

  return (
    <div className={`notification-toasts-host is-${position}`} role="region" aria-live="polite">
      {cards}
    </div>
  );
});

export default DepSyncToast;
