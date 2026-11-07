/**
 * `.http` 编辑器上方的工具栏：
 * `Toolbar`/`toolbarPanel`：Run All、Stop、`Run with:` 环境下拉、重载环境。
 *
 * forge 的编辑器是 React 壳，
 * 直接渲染成 `.code-host` 里 `code-editor` 之上的一行，省掉一整套命令式面板生命周期。
 * 环境按文件记，所以没开文件（`path` 为 null）时只剩 Run All/Stop 是禁用态。
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { IconButton, Select } from "../../ui";
import { useI18n } from "../../i18n";
import { describeError } from "../../lib/errors";
import { errorText } from "../../lib/fs";
import { notificationCenter } from "../../lib/notifications";
import { isHttpCancelled } from "../../lib/httpFile";
import {
  cancelRunning,
  effectiveEnvironment,
  environmentsFor,
  httpClientSnapshot,
  loadEnvironments,
  runAll,
  setEnvironment,
  subscribeHttpClient,
} from "./store";
import styles from "./HttpClient.module.css";

/** 「运行全部」：两枚播放三角。 */
export function RunAllIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9.35558 7.25929C9.81637 7.65809 9.81637 8.37278 9.35558 8.77157L4.15681 13.2709C3.5091 13.8315 2.5024 13.3714 2.5024 12.5148L2.5024 3.5161C2.5024 2.6595 3.5091 2.19939 4.15681 2.75996L9.35558 7.25929Z" fill="#F2FCF3" />
      <path fillRule="evenodd" clipRule="evenodd" d="M9.68279 6.88122C10.374 7.47941 10.374 8.55145 9.68279 9.14964L4.48401 13.649C3.51245 14.4898 2.0024 13.7997 2.0024 12.5148L2.0024 3.51609C2.0024 2.23119 3.51245 1.54103 4.48402 2.38188L9.68279 6.88122ZM9.02838 8.3935C9.25877 8.1941 9.25877 7.83675 9.02838 7.63736L3.82961 3.13802C3.50575 2.85774 3.0024 3.08779 3.0024 3.51609L3.0024 12.5148C3.0024 12.9431 3.50575 13.1731 3.8296 12.8928L9.02838 8.3935Z" fill="#208A3C" />
      <path d="M7.85764 2.5L13.3568 7.2593C13.8176 7.65809 13.8176 8.37279 13.3568 8.77158L7.8933 13.5" stroke="#208A3C" strokeLinecap="round" />
    </svg>
  );
}

/** .http 编辑器工具栏：运行按钮与请求内动作。 */
export default function HttpEditorToolbar({
  path,
  getContents,
}: {
  /** 当前 `.http` 文件路径；未保存的缓冲传 null。 */
  path: string | null;
  /** 取编辑器里最新正文（不等文档同步，刚敲完就能跑）。 */
  getContents: () => string;
}) {
  const { t } = useI18n();
  const { running, rootEpoch } = useSyncExternalStore(subscribeHttpClient, httpClientSnapshot);
  const thisFileRunning = !!running && running.path === path;
  const environments = environmentsFor(path);
  const report = useCallback((cause: unknown) => {
    const raw = errorText(cause);
    if (isHttpCancelled(raw)) return;
    notificationCenter.notify({
      key: "http-client",
      groupId: "system",
      title: t("notifications.error"),
      content: describeError(raw, t),
      level: "error",
    });
  }, [t]);

  useEffect(() => {
    void loadEnvironments(path).catch(report);
  }, [path, rootEpoch, report]);

  const options = useMemo(
    () => [
      { value: "", label: t("http.noEnvironment") },
      ...environments.map((name) => ({ value: name, label: name })),
    ],
    [environments, t]
  );

  return (
    <div className={styles.toolbar}>
      <IconButton
        icon={<RunAllIcon />}
        title={t("http.runAllTitle")}
        disabled={!path}
        onClick={() => {
          if (!path) return;
          void runAll(path, getContents()).catch(report);
        }}
      />
      <IconButton
        icon="stop"
        title={t("http.stop")}
        disabled={!thisFileRunning}
        onClick={cancelRunning}
      />
      <span className={styles.toolbarLabel}>{t("http.runWith")}</span>
      <Select
        value={path ? effectiveEnvironment(path) ?? "" : ""}
        options={options}
        aria-label={t("http.environment")}
        disabled={!path}
        onChange={(value) => path && setEnvironment(path, value || null)}
      />
      <IconButton
        icon="refresh"
        title={t("http.reloadEnvironments")}
        disabled={!path}
        onClick={() => path && void loadEnvironments(path).catch(report)}
      />
    </div>
  );
}
