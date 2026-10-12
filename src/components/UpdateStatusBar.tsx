import { useEffect, useState } from "react";
import { AlertCircle, ArrowUpCircle, Loader2, RotateCw } from "lucide-react";
import { useI18n } from "../i18n";
import { getUpdateStatus, watchUpdateStatus } from "../lib/updater";
import type { GlobalUpdateState } from "../lib/updater";

interface UpdateStatusBarProps {
  /** 点击时打开设置页的关于模块 */
  onOpenSettings: () => void;
  /** 点击已就绪待重启时请求重启确认 */
  onRequestRestart: (version: string) => void;
}

/**
 * 全局状态栏右下角的更新指示器组件。
 *
 * 状态机阶段：
 * - idle: 正常无更新，返回 null 不占位；
 * - checking: 检查中（若由用户触发）；
 * - available: 发现新版，展示版本号，点击跳转关于页；
 * - downloading: 正在下载，实时展示百分比，旋转图标；
 * - ready: 下载完成已就绪，绿色高亮提示，点击直接呼出重启确认；
 * - error: 更新出错，黄色/红色告警，点击跳转关于页查看详情。
 */
export default function UpdateStatusBar({
  onOpenSettings,
  onRequestRestart,
}: UpdateStatusBarProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<GlobalUpdateState>(getUpdateStatus());

  useEffect(() => {
    return watchUpdateStatus(setStatus);
  }, []);

  if (status.phase === "idle") {
    return null;
  }

  if (status.phase === "checking") {
    return (
      <span className="status-update is-checking" title={t("update.status.checking")}>
        <span className="is-spinning">
          <Loader2 size={12} />
        </span>
        <span>{t("update.status.checking")}</span>
      </span>
    );
  }

  if (status.phase === "available") {
    const versionText = status.version ? `v${status.version}` : "";
    return (
      <button
        type="button"
        className="status-update is-available"
        onClick={onOpenSettings}
        title={t("update.status.available", { version: versionText })}
      >
        <ArrowUpCircle size={12} />
        <span>{t("update.status.available", { version: versionText })}</span>
      </button>
    );
  }

  if (status.phase === "downloading") {
    const total = status.downloadProgress?.total;
    const received = status.downloadProgress?.received ?? 0;
    const percent =
      total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
    const label = total
      ? t("update.status.downloading", { percent })
      : t("about.progress");
    return (
      <button
        type="button"
        className="status-update is-downloading"
        onClick={onOpenSettings}
        title={label}
      >
        <span className="is-spinning">
          <Loader2 size={12} />
        </span>
        <span>{label}</span>
      </button>
    );
  }

  if (status.phase === "ready") {
    const versionText = status.version ?? "";
    return (
      <button
        type="button"
        className="status-update is-ready"
        onClick={() => onRequestRestart(versionText)}
        title={t("update.status.ready")}
      >
        <RotateCw size={12} />
        <span>{t("update.status.ready")}</span>
      </button>
    );
  }

  if (status.phase === "error") {
    return (
      <button
        type="button"
        className="status-update is-error"
        onClick={onOpenSettings}
        title={status.error ? `${t("update.status.error")}: ${status.error}` : t("update.status.error")}
      >
        <AlertCircle size={12} />
        <span>{t("update.status.error")}</span>
      </button>
    );
  }

  return null;
}
