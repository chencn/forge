import { check, Update } from "@tauri-apps/plugin-updater";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { Channel, invoke } from "@tauri-apps/api/core";
import { translate } from "../i18n";
import { codedError } from "./errors";
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
 * 已下到本地缓存、随时能装的更新：版本号 → 后端句柄。
 *
 * 句柄只是清单元数据，整包字节在盘上，留着不占内存；留着的意义是装之前不必再联网
 * 检查一遍——离线时也能把已下载的那版装上。
 */
const readyUpdates = new Map<string, Update>();

function remember(update: Update): void {
  readyUpdates.set(update.version, update);
}

/**
 * 安全释放 Update 的后端 Resource 句柄。盘上缓存的安装包不受影响，之后要装再检查一次即可。
 */
export async function closeUpdate(update?: Update | null): Promise<void> {
  if (!update) return;
  if (readyUpdates.get(update.version) === update) readyUpdates.delete(update.version);
  try {
    await update.close();
  } catch {
    // 忽略重复关闭异常
  }
}

/** 这一版在本地缓存里吗；在就返回字节数。读不到一律当没有——顶多多下一遍，不会装错包。 */
export async function cacheState(version: string): Promise<number | null> {
  try {
    return await invoke<number | null>("update_cache_state", { version });
  } catch {
    return null;
  }
}

/** 把安装包下到本地缓存目录，返回落盘字节数；onProgress 在下载期间回报。 */
export async function downloadToCache(
  update: Update,
  onProgress?: (report: DownloadReport) => void
): Promise<number> {
  const channel = new Channel<DownloadEvent>();
  let report: DownloadReport = { received: 0, total: null };
  channel.onmessage = (event) => {
    report = reduceDownloadEvent(report, event);
    onProgress?.(report);
  };
  return invoke<number>("update_download_cached", { rid: update.rid, onEvent: channel });
}

/** 装本地缓存里这一版。Windows 上拉起安装器后当前进程直接退出。 */
export async function installFromCache(update: Update): Promise<void> {
  await invoke("update_install_cached", { rid: update.rid });
  readyUpdates.delete(update.version);
}

/**
 * 保证这一版的安装包在本地缓存里，返回这一趟是否真的下了。
 *
 * 下不下只看盘上有没有，不看这是第几次走到这一步——延后安装、退出应用、补装时
 * 安装器被取消，都不会再产生第二份下载。
 */
export async function ensureCached(
  update: Update,
  onProgress?: (report: DownloadReport) => void
): Promise<boolean> {
  // 只认「有非零字节的包」这一种命中：空文件等于没下成，重下一遍比撞验签失败再报错省事。
  if (await cacheState(update.version)) {
    remember(update);
    return false;
  }
  await downloadToCache(update, onProgress);
  remember(update);
  return true;
}

/** 删掉某一版的本地缓存。 */
export async function removeCache(version: string): Promise<void> {
  try {
    await invoke("update_cache_remove", { version });
  } catch {
    // 缓存目录本来就没有这一版，没什么可删
  }
}

/**
 * 装上某一版：句柄不在手上先检查一次拿句柄，包不在缓存里就先下。
 * Windows 由安装器接管重启，其余平台由调用方接着请求 relaunch。
 */
export async function installReadyUpdate(
  version: string,
  options?: { proxyUrl?: string }
): Promise<void> {
  const update = readyUpdates.get(version) ?? (await checkForUpdate(options))?.update;
  if (!update || update.version !== version) {
    throw new Error(codedError("UPDATE_GONE", version));
  }
  await ensureCached(update);
  await installFromCache(update);
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

/** 启动时检查一次，此后每小时读取最新偏好；返回卸载时清理定时器的函数。 */
export function startAutoUpdateChecks(
  readPrefs: () => UpdateSettings,
  hooks: AutoUpdateHooks
): () => void {
  void runAutoUpdateFlow(readPrefs(), hooks);
  const timer = setInterval(() => {
    void runAutoUpdateFlow(readPrefs(), hooks, "periodic");
  }, 60 * 60 * 1000);
  return () => clearInterval(timer);
}

/**
 * 自动更新流程：仅启动时补装挂起更新，定时检查绝不能把「稍后安装」变成自动安装。
 * 任何失败只在必要时发通知，绝不打断启动，更不会无限闪退卡死。
 */
export async function runAutoUpdateFlow(
  prefs: UpdateSettings,
  hooks: AutoUpdateHooks,
  trigger: "startup" | "periodic" = "startup"
): Promise<void> {
  // 已下载的更新交给用户决定何时安装，后续轮询不重复下载、询问或覆盖缓存。
  if (trigger === "periodic" && (!prefs.autoDownload || getUpdateStatus().phase === "ready")) return;
  let current: string;
  try {
    current = await currentVersion();
  } catch {
    return;
  }
  if (!beginUpdateFlow()) return;
  try {
    const pending = trigger === "startup" ? await loadPendingUpdate() : null;
    if (pending) {
      if (pending.version === current) {
        // 上次其实装完了（Windows 由安装器重启）：标记和那一版的安装包都不再需要。
        await clearPendingUpdate();
        await removeCache(current);
      } else if ((pending.attempts ?? 0) >= 1) {
        // 上次已经尝试拉起过安装器但依然未更新（如用户在 UAC 选否或取消），绝不再次强制静默闪退。
        // 缓存那份包留着：用户手动装这一版时不必再下一遍。
        await clearPendingUpdate();
        setUpdateStatus({ phase: "available", version: pending.version });
      } else {
        await installPendingUpdate(pending.version, current, prefs, hooks);
        return;
      }
    }

    if (!prefs.autoDownload) return;

    // 后台自动检查：网络错误保持静默，等待下一轮检查。
    const proxyUrl = prefs.proxyEnabled ? prefs.proxyUrl : undefined;
    let info: UpdateInfo | null = null;
    try {
      info = await checkForUpdate({ proxyUrl });
    } catch {
      // 静默吞掉网络错误
      return;
    }
    if (!info) return;
    // 进度回调里读不到上面那句 if 的收窄，钉一个非空的本地名。
    const found = info;

    setUpdateStatus({ phase: "available", version: found.version });
    hooks.notify(
      "info",
      translate("update.notifyFoundTitle"),
      translate("update.notifyFoundBody", { version: found.version })
    );

    try {
      // 盘上已经有这一版时一个进度事件都不会来，状态直接从 available 走到 ready。
      await ensureCached(found.update, (report) => {
        setUpdateStatus({ phase: "downloading", version: found.version, downloadProgress: report });
      });

      // 先落标记（attempts = 0）：包已经在缓存目录里，重启后认得它。
      await savePendingUpdate(found.version, 0);

      if (!prefs.autoPromptInstall) {
        // 用户关闭询问：不要在编码中突袭杀进程！置为就绪，提示用户可重启生效
        setUpdateStatus({ phase: "ready", version: found.version });
        hooks.notify(
          "info",
          translate("update.notifyInstalledTitle"),
          translate("update.notifyInstalledBody", { version: found.version })
        );
        return;
      }

      const now = await hooks.onPromptInstall(found.version);
      if (now) {
        await savePendingUpdate(found.version, 1);
        await installFromCache(found.update);
        // Windows 上这一句之后进程就被安装器接管了，下面几句只给 mac / Linux 报平安。
        await clearPendingUpdate();
        setUpdateStatus({ phase: "ready", version: found.version });
        hooks.notify(
          "info",
          translate("update.notifyInstalledTitle"),
          translate("update.notifyInstalledBody", { version: found.version })
        );
        // macOS / Linux 下安装器不会强杀进程，用户明确选择立即安装时主动触发重启使新代码生效
        await relaunchApp();
      } else {
        // 用户选了稍后：包留在缓存目录、句柄留在手上，之后点「重启」直接装，不再下载。
        setUpdateStatus({ phase: "ready", version: found.version });
        hooks.notify(
          "info",
          translate("update.notifyDeferredTitle"),
          translate("update.notifyDeferredBody", { version: found.version })
        );
      }
    } catch (error) {
      await closeUpdate(found.update);
      setUpdateStatus({ phase: "error", error: errorText(error) });
      hooks.notify("warn", translate("update.notifyFailedTitle"), errorText(error));
    }
  } finally {
    endUpdateFlow();
  }
}

/** 静默补装挂起的更新：包已在缓存里就直接装，不在才补一次下载。 */
async function installPendingUpdate(
  version: string,
  current: string,
  prefs: UpdateSettings,
  hooks: AutoUpdateHooks
): Promise<void> {
  if (version === current) {
    await clearPendingUpdate();
    await removeCache(current);
    return;
  }
  hooks.notify(
    "info",
    translate("update.notifyPendingTitle"),
    translate("update.notifyPendingBody", { version })
  );
  const proxyUrl = prefs.proxyEnabled ? prefs.proxyUrl : undefined;
  let info: UpdateInfo | null = null;
  try {
    // 装包要经更新句柄，所以哪怕包早就在盘上，也得先拿一次清单。
    info = await checkForUpdate({ proxyUrl });
    if (!info) {
      await clearPendingUpdate();
      await removeCache(version);
      return;
    }
    // 进度回调里读不到 if 的收窄，钉一个非空的本地名。
    const found = info;
    await ensureCached(found.update, (report) => {
      setUpdateStatus({ phase: "downloading", version: found.version, downloadProgress: report });
    });
    // 标记已尝试
    await savePendingUpdate(found.version, 1);
    await installFromCache(found.update);
    await clearPendingUpdate();
    setUpdateStatus({ phase: "ready", version: found.version });
    hooks.notify(
      "info",
      translate("update.notifyInstalledTitle"),
      translate("update.notifyInstalledBody", { version: found.version })
    );
  } catch (error) {
    if (info) await closeUpdate(info.update);
    // 标记清掉但缓存留着：下次手动装这一版不必重下，只是不再自动闪退重试。
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
