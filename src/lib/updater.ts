import { check, Update } from "@tauri-apps/plugin-updater";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { translate } from "../i18n";
import type { UpdateSettings } from "./settings";

/** 一次可安装的更新：新版本号与更新日志（取自 latest.json 的 notes 字段）。 */
export interface UpdateInfo {
  /** 新版本号。 */
  version: string;
  /** 更新日志，发版时由 CI 写入 Release 说明；可能为空。 */
  notes: string;
  /** 插件返回的更新对象，下载安装时要用，调用方原样传回即可。 */
  update: Update;
}

/** 当前应用版本（tauri.conf.json 的 version，发布时由 CI 按 tag 强制覆盖）。 */
export async function currentVersion(): Promise<string> {
  return getVersion();
}

/** 后端返回的更新元数据，直接与 Update 类的构造参数一致。 */
interface UpdateCheckMetadata {
  rid: number;
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  rawJson: Record<string, unknown>;
}

/**
 * 检查更新；没有新版返回 null。
 *
 * 支持传入镜像加速代理前缀（如 https://gh-proxy.com/），加速检查与安装包下载。
 * 验签依然在客户端本地由固定公钥进行 minisign 强校验。
 */
export async function checkForUpdate(options?: { proxyUrl?: string }): Promise<UpdateInfo | null> {
  try {
    const meta = await invoke<UpdateCheckMetadata | null>("update_check", {
      proxyUrl: options?.proxyUrl || null,
    });
    if (!meta) return null;
    const update = new Update(meta);
    return { version: update.version, notes: update.body ?? "", update };
  } catch {
    // 纯网页环境或降级时回退到默认插件 check
    const update = await check();
    if (!update) return null;
    return { version: update.version, notes: update.body ?? "", update };
  }
}

/** 下载进度回报；total 未知（服务端没给长度）时为 null。 */
export interface DownloadReport {
  /** 已收字节数。 */
  received: number;
  /** 总字节数，未知时为 null。 */
  total: number | null;
}

/**
 * 把插件的三类下载事件折成「已收 / 总量」两个数。
 */
export function reduceDownloadEvent(
  report: DownloadReport,
  event: DownloadEvent
): DownloadReport {
  switch (event.event) {
    case "Started":
      return { received: 0, total: event.data.contentLength ?? null };
    case "Progress":
      return { ...report, received: report.received + event.data.chunkLength };
    case "Finished":
      return report;
    default:
      return report;
  }
}

/**
 * 安全释放 Update 持有的 Rust 后端 Resource 句柄与安装包内存。
 */
export async function closeUpdate(update?: Update | null): Promise<void> {
  if (!update) return;
  try {
    await update.close();
  } catch {
    // 忽略重复关闭异常
  }
}

/**
 * 下载并安装（手动流程用）。onProgress 在下载期间回报进度。
 */
export async function downloadAndInstall(
  update: Update,
  onProgress?: (report: DownloadReport) => void
): Promise<void> {
  let report: DownloadReport = { received: 0, total: null };
  await update.downloadAndInstall((event) => {
    report = reduceDownloadEvent(report, event);
    onProgress?.(report);
  });
}

/**
 * 只下载不安装；安装包字节暂存在后端进程里。
 */
export async function downloadOnly(
  update: Update,
  onProgress?: (report: DownloadReport) => void
): Promise<void> {
  let report: DownloadReport = { received: 0, total: null };
  await update.download((event) => {
    report = reduceDownloadEvent(report, event);
    onProgress?.(report);
  });
}

/** 安装 downloadOnly 下好的包。Windows 上会拉起安装器并退出进程。 */
export async function installDownloaded(update: Update): Promise<void> {
  await update.install();
}

/** 重启应用，让装好的新版本生效。 */
export async function relaunchApp(): Promise<void> {
  await relaunch();
}

/** 挂起标记的形态，对应 Rust `update::PendingUpdate`。 */
export interface PendingUpdateMarker {
  version: string;
  attempts?: number;
}

/** 读挂起标记；没有 Tauri 或读坏了都当没有。 */
export async function loadPendingUpdate(): Promise<PendingUpdateMarker | null> {
  try {
    return await invoke<PendingUpdateMarker | null>("update_pending_load");
  } catch {
    return null;
  }
}

/** 记挂起标记，记录尝试次数以防止死循环。 */
export async function savePendingUpdate(version: string, attempts = 0): Promise<void> {
  try {
    await invoke("update_pending_save", { version, attempts });
  } catch {
    // 忽略
  }
}

/** 清挂起标记。 */
export async function clearPendingUpdate(): Promise<void> {
  try {
    await invoke("update_pending_clear");
  } catch {
    // 忽略
  }
}

/** 更新流程的全局互斥锁。 */
let busy = false;
const busyListeners = new Set<() => void>();

export function isUpdateFlowBusy(): boolean {
  return busy;
}

export function watchUpdateFlowBusy(listener: () => void): () => void {
  busyListeners.add(listener);
  return () => busyListeners.delete(listener);
}

export function beginUpdateFlow(): boolean {
  if (busy) return false;
  busy = true;
  busyListeners.forEach((listener) => listener());
  return true;
}

export function endUpdateFlow(): void {
  busy = false;
  busyListeners.forEach((listener) => listener());
}

/** 更新状态机的阶段。 */
export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

export interface GlobalUpdateState {
  phase: UpdatePhase;
  version: string | null;
  downloadProgress: DownloadReport | null;
  error: string | null;
}

let globalUpdateState: GlobalUpdateState = {
  phase: "idle",
  version: null,
  downloadProgress: null,
  error: null,
};

const statusListeners = new Set<(state: GlobalUpdateState) => void>();

export function getUpdateStatus(): GlobalUpdateState {
  return globalUpdateState;
}

export function setUpdateStatus(partial: Partial<GlobalUpdateState>): void {
  globalUpdateState = { ...globalUpdateState, ...partial };
  statusListeners.forEach((listener) => listener(globalUpdateState));
}

export function watchUpdateStatus(listener: (state: GlobalUpdateState) => void): () => void {
  statusListeners.add(listener);
  listener(globalUpdateState);
  return () => statusListeners.delete(listener);
}

/** 自动更新流程给界面的出口。 */
export interface AutoUpdateHooks {
  /** 下载完成后询问是否立即安装；resolve(true)=立即装，false=下次启动装。 */
  onPromptInstall: (version: string) => Promise<boolean>;
  /** 通报进度与结果，走右下角通知。 */
  notify: (level: "info" | "warn", title: string, content: string) => void;
}

/**
 * 启动时的自动更新流程，App 挂载后跑一次：
 * 任何失败只在必要时发通知，绝不打断启动，更不会无限闪退卡死。
 */
export async function runAutoUpdateFlow(
  prefs: UpdateSettings,
  hooks: AutoUpdateHooks
): Promise<void> {
  let current: string;
  try {
    current = await currentVersion();
  } catch {
    return;
  }
  if (!beginUpdateFlow()) return;
  try {
    const pending = await loadPendingUpdate();
    if (pending) {
      if (pending.version === current) {
        await clearPendingUpdate();
      } else if ((pending.attempts ?? 0) >= 1) {
        // 上次已经尝试拉起过安装器但依然未更新（如用户在 UAC 选否或取消），绝不再次强制静默闪退
        await clearPendingUpdate();
        setUpdateStatus({ phase: "available", version: pending.version });
      } else {
        await installPendingUpdate(pending.version, current, prefs, hooks);
        return;
      }
    }

    if (!prefs.autoDownload) return;

    // 启动期的自动检查：网络错误保持静默，不弹 Toast 骚扰用户
    const proxyUrl = prefs.proxyEnabled ? prefs.proxyUrl : undefined;
    let info: UpdateInfo | null = null;
    try {
      info = await checkForUpdate({ proxyUrl });
    } catch {
      // 静默吞掉网络错误
      return;
    }
    if (!info) return;

    setUpdateStatus({ phase: "available", version: info.version });
    hooks.notify(
      "info",
      translate("update.notifyFoundTitle"),
      translate("update.notifyFoundBody", { version: info.version })
    );

    try {
      setUpdateStatus({ phase: "downloading", version: info.version });
      await downloadOnly(info.update, (report) => {
        setUpdateStatus({ downloadProgress: report });
      });

      // 先落标记（attempts = 0）
      await savePendingUpdate(info.version, 0);

      if (!prefs.autoPromptInstall) {
        // 用户关闭询问：不要在编码中突袭杀进程！置为就绪，提示用户可重启生效
        setUpdateStatus({ phase: "ready", version: info.version });
        hooks.notify(
          "info",
          translate("update.notifyInstalledTitle"),
          translate("update.notifyInstalledBody", { version: info.version })
        );
        return;
      }

      const now = await hooks.onPromptInstall(info.version);
      if (now) {
        await savePendingUpdate(info.version, 1);
        await installDownloaded(info.update);
        await clearPendingUpdate();
        setUpdateStatus({ phase: "ready", version: info.version });
        hooks.notify(
          "info",
          translate("update.notifyInstalledTitle"),
          translate("update.notifyInstalledBody", { version: info.version })
        );
      } else {
        // 用户选了稍后：释放已下载的内存句柄，避免几十 MB 内存泄漏
        await closeUpdate(info.update);
        setUpdateStatus({ phase: "ready", version: info.version });
        hooks.notify(
          "info",
          translate("update.notifyDeferredTitle"),
          translate("update.notifyDeferredBody", { version: info.version })
        );
      }
    } catch (error) {
      await closeUpdate(info.update);
      setUpdateStatus({ phase: "error", error: errorText(error) });
      hooks.notify("warn", translate("update.notifyFailedTitle"), errorText(error));
    }
  } finally {
    endUpdateFlow();
  }
}

/** 静默补装挂起的更新。 */
async function installPendingUpdate(
  version: string,
  current: string,
  prefs: UpdateSettings,
  hooks: AutoUpdateHooks
): Promise<void> {
  if (version === current) {
    await clearPendingUpdate();
    return;
  }
  hooks.notify(
    "info",
    translate("update.notifyPendingTitle"),
    translate("update.notifyPendingBody", { version })
  );
  const proxyUrl = prefs.proxyEnabled ? prefs.proxyUrl : undefined;
  try {
    const info = await checkForUpdate({ proxyUrl });
    if (!info) {
      await clearPendingUpdate();
      return;
    }
    setUpdateStatus({ phase: "downloading", version: info.version });
    await downloadOnly(info.update, (report) => {
      setUpdateStatus({ downloadProgress: report });
    });
    // 标记已尝试
    await savePendingUpdate(info.version, 1);
    await installDownloaded(info.update);
    await clearPendingUpdate();
    setUpdateStatus({ phase: "ready", version: info.version });
    hooks.notify(
      "info",
      translate("update.notifyInstalledTitle"),
      translate("update.notifyInstalledBody", { version: info.version })
    );
  } catch (error) {
    await clearPendingUpdate();
    setUpdateStatus({ phase: "error", error: errorText(error) });
    hooks.notify("warn", translate("update.notifyFailedTitle"), errorText(error));
  }
}

function errorText(error: unknown): string {
  return typeof error === "string" ? error : String(error);
}

/** 字节数转换。 */
export function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
