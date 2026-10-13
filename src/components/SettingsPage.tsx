import { useEffect, useRef, useState } from "react";
import {
  Download,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  ScrollText,
} from "lucide-react";
import Select from "./Select";
import PromptDialog from "./PromptDialog";
import CopyButton from "./CopyButton";
import { LspInstallDialog, LspLogDialog, LspServerDialog } from "./LspDialogs";
import { useSettings } from "../hooks/useSettings";
import { useLspConfig, useLspSessionStatuses } from "../hooks/useLspConfig";
import { modesFor, serverEntries } from "../lib/lspConfig";
import type { LspMode, LspServerConfig } from "../lib/lspConfig";
import { lspInstall, lspRetry } from "../lib/lsp";
import type { LspServerProbe, LspSessionStatus } from "../lib/lsp";
import { describeError } from "../lib/errors";
import { useI18n } from "../i18n";
import type { Lang } from "../i18n";
import type { ThemeMode } from "../lib/window";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { clearLspLogs, lspLogs, watchLspLogs, watchLspStatus } from "../lib/lspClient";
import type { WakeResult } from "../lib/lspClient";
import type {
  CloseBehavior,
  KeymapScheme,
  NotificationPosition,
  SavePolicy,
  WorkspaceMode,
} from "../lib/settings";
import { shellProbe } from "../lib/term";
import type { ShellInfo } from "../lib/term";
import { languageNames } from "../lib/monacoEnv";
import type { TranslationKey } from "../i18n/lang/zh";
import {
  checkForUpdate,
  closeUpdate,
  currentVersion,
  downloadAndInstall,
  humanBytes,
  isUpdateFlowBusy,
  relaunchApp,
  setUpdateStatus,
  watchUpdateFlowBusy,
} from "../lib/updater";
import type { DownloadReport, UpdateInfo } from "../lib/updater";

/** 设置窗口左侧的模块，一行一个。 */
type Module = "general" | "editor" | "terminal" | "lsp" | "about";

const MODULES: Module[] = ["general", "editor", "terminal", "lsp", "about"];

const MODULE_LABEL: Record<Module, TranslationKey> = {
  general: "settings.general",
  editor: "settings.editor",
  terminal: "settings.terminal",
  lsp: "settings.lsp",
  about: "settings.about",
};

const THEME_OPTIONS: ThemeMode[] = ["light", "dark", "system"];
const THEME_LABEL: Record<ThemeMode, TranslationKey> = {
  light: "theme.light",
  dark: "theme.dark",
  system: "theme.system",
};
const NOTIFICATION_POSITION_OPTIONS: NotificationPosition[] = [
  "bottom-right",
  "top-right",
  "bottom-left",
  "top-left",
];
const NOTIFICATION_POSITION_LABEL: Record<NotificationPosition, TranslationKey> = {
  "bottom-right": "notificationPosition.bottomRight",
  "top-right": "notificationPosition.topRight",
  "bottom-left": "notificationPosition.bottomLeft",
  "top-left": "notificationPosition.topLeft",
};
const LANG_OPTIONS: { value: Lang; label: string }[] = [
  { value: "zh", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" },
];
const TAB_SIZES = [2, 4, 8];
const WORKSPACE_MODES: WorkspaceMode[] = ["multi", "single"];
const WORKSPACE_MODE_LABEL: Record<WorkspaceMode, TranslationKey> = {
  multi: "workspaceMode.multi",
  single: "workspaceMode.single",
};
const CLOSE_BEHAVIORS: CloseBehavior[] = ["quit", "tray"];
const CLOSE_LABEL: Record<CloseBehavior, TranslationKey> = {
  quit: "closeBehavior.quit",
  tray: "closeBehavior.tray",
};
const SAVE_POLICIES: SavePolicy[] = ["manual", "blur"];
const SAVE_POLICY_LABEL: Record<SavePolicy, TranslationKey> = {
  manual: "savePolicy.manual",
  blur: "savePolicy.blur",
};
/** 是 / 否两档的下拉，值写回设置时换成布尔。 */
const SWITCHES = ["yes", "no"] as const;
type Switch = (typeof SWITCHES)[number];
const SWITCH_LABEL: Record<Switch, TranslationKey> = { yes: "common.yes", no: "common.no" };
const KEYMAPS: KeymapScheme[] = ["default", "idea", "eclipse"];
const KEYMAP_LABEL: Record<KeymapScheme, TranslationKey> = {
  default: "keymap.default",
  idea: "keymap.idea",
  eclipse: "keymap.eclipse",
};
const LSP_MODE_LABEL: Record<LspMode, TranslationKey> = {
  off: "lsp.mode.off",
  builtin: "lsp.mode.builtin",
  lsp: "lsp.mode.lsp",
};

/**
 * 列表的次序：已安装的在前，未安装的次之，未探测的在后。
 * 同组内保持后端那份的字典序（`Array.prototype.sort` 是稳定的），装完一项它就往前挪。
 */
function probeRank(probe: LspServerProbe | undefined): number {
  if (!probe) return 2;
  return probe.installed ? 0 : 1;
}

/** 单个 server 的会话汇总：运行中、存在异常、未启动（空闲）三种，外加状态获取失败。 */
type Runtime = "running" | "problem" | "idle" | "unknown";

const RUNTIME_LABEL: Record<Runtime, TranslationKey> = {
  running: "lsp.runtime.running",
  problem: "lsp.runtime.problem",
  idle: "lsp.runtime.idle",
  unknown: "lsp.runtime.unknown",
};

/** 单个 server 取哪一个状态上报：存在异常优先，其次取第一条，没有会话即为空闲。 */
function runtimeOf(items: LspSessionStatus[] | undefined, stale: boolean): Runtime {
  if (stale) return "unknown";
  if (!items || items.length === 0) return "idle";
  return items.some((item) => item.status !== "running") ? "problem" : "running";
}

/** 应用内更新走到哪一步了：界面只反映这几档，插件内部的细节不外露。 */
type UpdateStep =
  | "idle"
  | "checking"
  | "latest"
  | "available"
  | "downloading"
  | "installed"
  | "error";

interface Props {
  /** 当前项目根；未打开项目时没有可启动的会话，「启动」按钮禁用。 */
  workspace: string | null;
  /** 变更进程之后需要重新执行一次文档与配置的对档。 */
  onLspKick?: () => void;
  /** 让指定 server 立即在项目中启动；返回未能启动的原因。 */
  onLspWake?: (serverId: string) => Promise<WakeResult>;
}

export default function SettingsPage({ workspace, onLspKick, onLspWake }: Props) {
  const { t, lang, setLang } = useI18n();
  const { settings, patch } = useSettings();
  const { config, patchServer, probes, reprobe, probing } = useLspConfig();
  const sessions = useLspSessionStatuses();
  const [module, setModule] = useState<Module>("general");
  /** 「重置所有设置」的二次确认框；确认后才把整份设置写回默认值。 */
  const [confirmReset, setConfirmReset] = useState(false);
  /** 这台机器上可用的 shell；排在第一位的是终端默认使用的那个。 */
  const [shells, setShells] = useState<ShellInfo[]>([]);
  /** 正在安装哪一个条目（同一时刻只允许一个）。 */
  const [installing, setInstalling] = useState<string | null>(null);
  /** 正在启动或重启哪一个条目；同一时刻只允许一个按钮处于进行中。 */
  const [waking, setWaking] = useState<string | null>(null);
  /** 每个安装命令最近一次的执行回报，按 server id 存放。 */
  const [installNote, setInstallNote] = useState<Record<string, string>>({});
  /** 正在编辑哪一个条目（编辑弹窗打开中）；null 表示未打开。 */
  const [editing, setEditing] = useState<string | null>(null);
  /** 正在查看哪一个条目的输出日志；null 表示未打开。 */
  const [viewingLog, setViewingLog] = useState<string | null>(null);
  /** 等待用户确认安装哪一个条目；确认之后才执行该命令。 */
  const [pendingInstall, setPendingInstall] = useState<string | null>(null);
  /** 客户端未启动该项的原因（未找到标志文件、握手未返回），按 server id 存放；空串表示没有原因。 */
  const [lspReasons, setLspReasons] = useState<Record<string, string>>({});
  /** 存在可查输出日志的条目；日志变化时重新计算，卡片上的「日志」按钮随之显示或收起。 */
  const [logged, setLogged] = useState<string[]>([]);
  /** 应用内更新走到哪一步；进页面是待检查，动作只有「检查更新」与「下载安装」。 */
  const [updateStep, setUpdateStep] = useState<UpdateStep>("idle");
  /** 检查到的更新；下载安装都要拿着插件返回的这个对象。 */
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  /** 下载进度：已收字节与总字节（服务端没给长度时为 null，此时只报字节）。 */
  const [progress, setProgress] = useState<DownloadReport>({ received: 0, total: null });
  /** 检查或下载失败的原因；updater 的报错没有错误码，原样展示。 */
  const [updateError, setUpdateError] = useState("");
  /** 「重启应用」进行中；relaunch 成功进程就没了，失败要允许再点。 */
  const [restarting, setRestarting] = useState(false);
  /** 本机应用版本；纯浏览器预览没有 Tauri 接口，留空显示 —。 */
  const [appVersion, setAppVersion] = useState("");
  /** 自动更新流程（启动时那次）是否占着锁；占着就把手动按钮置灰。 */
  const [flowBusy, setFlowBusy] = useState(isUpdateFlowBusy());

  useEffect(() => {
    const sync = () =>
      setLogged(
        serverEntries(config).filter((entry) => lspLogs(entry.id).length > 0).map((e) => e.id)
      );
    sync();
    return watchLspLogs(sync);
  }, [config]);

  useEffect(() => {
    return watchLspStatus((serverId, status, detail) => {
      setLspReasons((current) => {
        const next = status === "missing" ? (detail ?? "") : "";
        return (current[serverId] ?? "") === next ? current : { ...current, [serverId]: next };
      });
    });
  }, []);
  /** 进入该栏时只自动探测一次，探测失败后交由用户手动刷新。 */
  const probeTried = useRef(false);

  useEffect(() => {
    if (module !== "lsp" || probes || probeTried.current) return;
    probeTried.current = true;
    void reprobe();
  }, [module, probes, reprobe]);

  /**
   * 后端错误串 → 界面句子，后面附上原始码与分段。
   *
   * 翻译只负责把错误码换成对应文案，不该把上游给的信息吃掉：照着 `LSP_SPAWN / gopls / …` 这种形式才能查到是哪条命令、
   * 哪个环节报的，所以翻不出或翻完丢了细节时都保留原文。
   */
  const explain = (raw: string): string => {
    if (!raw) return "";
    const code = raw.split("\u0001").join(" / ");
    const text = describeError(raw, t);
    return text === code ? code : `${text}（${code}）`;
  };

  /**
   * 执行安装命令。不设超时：全局安装耗时数分钟是常态。
   *
   * 命令原文已在确认弹窗中显示过一次，执行后不再重复。安装成功也不额外留言：重新探测会把该项从
   * 「未安装」改为「已安装」，那即是回执。只有失败时才把退出码与输出尾部保留在卡片上，完整输出看「日志」弹窗。
   */
  const runInstall = (id: string) => {
    setInstalling(id);
    lspInstall(id)
      .then((result) => {
        const tail = result.output.trimEnd().split("\n").slice(-3).join(" / ");
        setInstallNote((current) => ({
          ...current,
          [id]:
            result.exitCode === 0
              ? ""
              : `${t("lsp.install.failed", { code: result.exitCode ?? -1 })}：${tail}`,
        }));
        return reprobe();
      })
      .catch((error: unknown) => {
        const text = typeof error === "string" ? error : String(error);
        setInstallNote((current) => ({ ...current, [id]: explain(text) }));
      })
      .finally(() => setInstalling(null));
  };

  /** 重启该项的全部会话：清除后端的退避记录，再执行一次文档对档，进程由对档流程重新启动。 */
  const restart = (items: LspSessionStatus[]) => {
    setWaking(items[0].server);
    Promise.all(items.map((item) => lspRetry(item.id)))
      .then(() => {
        onLspKick?.();
        sessions.refresh();
      })
      .catch((error: unknown) => {
        const text = typeof error === "string" ? error : String(error);
        setInstallNote((current) => ({ ...current, [items[0].server]: explain(text) }));
      })
      .finally(() => setWaking(null));
  };

  /**
   * 启动该项：不等待用户打开该语言的文件，立即在当前项目中拉起进程。
   *
   * 走 `lspClient` 的完整流程（启动进程、握手、同步文档）；未找到标志文件时明确给出无法启动的原因。
   */
  /**
   * 「启动」的回报文案。
   *
   * 没启动成时要把上游原因原样留在卡片上：未找到标志文件要写清搜过哪个目录、找的是哪些文件名；
   * 后端或握手报错先按错误码翻成句子，句子后面仍附原始串，否则照着界面无从查起。
   */
  const wakeNote = (result: WakeResult, id: string): string => {
    if (result.state === "no-root") {
      return t("lsp.wake.noRoot", {
        root: result.root ?? "",
        markers: (result.markers ?? []).join(" / "),
      });
    }
    if (result.state !== "failed") return "";
    const line = explain(result.detail ?? "");
    if (!line) return "";
    return lspLogs(id).length > 0 ? `${line}${t("lsp.wake.logHint")}` : line;
  };

  const wake = (id: string) => {
    if (!onLspWake) return;
    setWaking(id);
    onLspWake(id)
      .then((result) => {
        setInstallNote((current) => ({ ...current, [id]: wakeNote(result, id) }));
        onLspKick?.();
        sessions.refresh();
      })
      .catch((error: unknown) => {
        const text = typeof error === "string" ? error : String(error);
        setInstallNote((current) => ({ ...current, [id]: explain(text) }));
      })
      .finally(() => setWaking(null));
  };

  // 排序规则：已安装的在前，未安装的次之，未探测的在后；探测结果未返回时保持落盘的文件顺序。
  const lspRows = [...serverEntries(config)].sort(
    (a, b) => probeRank(probes?.[a.id]) - probeRank(probes?.[b.id])
  );
  // 弹窗打开中的条目：每次都从当前配置读取，保存后的显示随之更新。
  const editingEntry = editing
    ? (serverEntries(config).find((entry) => entry.id === editing) ?? null)
    : null;
  const installEntry = pendingInstall
    ? (serverEntries(config).find((entry) => entry.id === pendingInstall) ?? null)
    : null;
  const logEntry = viewingLog
    ? (serverEntries(config).find((entry) => entry.id === viewingLog) ?? null)
    : null;

  useEffect(() => {
    let alive = true;
    shellProbe()
      .then((list) => {
        if (alive) setShells(list);
      })
      .catch(() => {
        // 纯浏览器预览时没这条命令，下拉就空着。
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    currentVersion()
      .then(setAppVersion)
      .catch(() => {
        // 纯浏览器预览时没有应用接口，版本留空显示 —。
      });
  }, []);

  useEffect(() => watchUpdateFlowBusy(() => setFlowBusy(isUpdateFlowBusy())), []);

  // 离开设置页或组件卸载时，若仍持有未安装的 Update 资源，及时释放后端句柄
  useEffect(() => {
    return () => {
      if (updateInfo) {
        void closeUpdate(updateInfo.update);
      }
    };
  }, [updateInfo]);

  /**
   * 检查更新：支持镜像加速代理前缀。
   * 检查前先释放上一次未安装的更新资源句柄。
   */
  const checkUpdate = () => {
    if (isUpdateFlowBusy()) return;
    if (updateInfo) {
      void closeUpdate(updateInfo.update);
      setUpdateInfo(null);
    }
    setUpdateStep("checking");
    const proxyUrl = settings.updates.proxyEnabled ? settings.updates.proxyUrl : undefined;
    checkForUpdate({ proxyUrl })
      .then((info) => {
        setUpdateInfo(info);
        setUpdateStep(info ? "available" : "latest");
        if (info) {
          setUpdateStatus({ phase: "available", version: info.version });
        }
      })
      .catch((error: unknown) => {
        setUpdateError(typeof error === "string" ? error : String(error));
        setUpdateStep("error");
      });
  };

  /**
   * 下载并安装，接入全局互斥锁与状态栏同步通知。
   */
  const installUpdate = () => {
    if (!updateInfo) return;
    setProgress({ received: 0, total: null });
    setUpdateStep("downloading");
    setUpdateStatus({ phase: "downloading", version: updateInfo.version });
    downloadAndInstall(updateInfo.update, (report) => {
      setProgress(report);
      setUpdateStatus({ downloadProgress: report });
    })
      .then(() => {
        setUpdateStep("installed");
        setUpdateStatus({ phase: "ready", version: updateInfo.version });
      })
      .catch((error: unknown) => {
        setUpdateError(typeof error === "string" ? error : String(error));
        setUpdateStep("error");
        setUpdateStatus({ phase: "error", error: typeof error === "string" ? error : String(error) });
      });
  };

  /** 重启应用让新版本生效；Windows 上通常由安装器重启，这个按钮是给 mac/Linux 的。 */
  const restartForUpdate = () => {
    setRestarting(true);
    relaunchApp().catch(() => setRestarting(false));
  };

  return (
    <div className="settings-page">
        <nav className="settings-nav" aria-label={t("settings.title")}>
          <p className="settings-nav-title">{t("settings.title")}</p>
          {MODULES.map((key) => (
            <button
              key={key}
              type="button"
              className={`settings-nav-item${module === key ? " is-active" : ""}`}
              onClick={() => setModule(key)}
            >
              {t(MODULE_LABEL[key])}
            </button>
          ))}
        </nav>

        <div className="settings-body">
          <header className="settings-head">
            <span className="settings-head-title">{t(MODULE_LABEL[module])}</span>
            <span className="settings-head-spacer" />
            {/* IDEA 把「恢复默认值」放在通用页标题行右端；点开先过一遍确认框。 */}
            {module === "general" ? (
              <button
                type="button"
                className="icon-button settings-reset"
                title={t("settings.resetAll")}
                aria-label={t("settings.resetAll")}
                onClick={() => setConfirmReset(true)}
              >
                <RotateCcw size={14} />
              </button>
            ) : null}
            {/* 探测是整栏一件动作，放标题行右端，不在每条里重复。
                图标 + 文字用 `lsp-action`（同栏卡片按钮的范式），不用 `icon-button`：
                后者是固定 30×30 的纯图标按钮，塞不下「重新探测」四个字，grid 会把文字换行挤出框外。 */}
            {module === "lsp" ? (
              <button
                type="button"
                className="lsp-action"
                disabled={probing}
                title={t("lsp.probe.refresh")}
                aria-label={t("lsp.probe.refresh")}
                onClick={() => void reprobe()}
              >
                {probing ? (
                  <span className="is-spinning">
                    <Loader2 size={14} />
                  </span>
                ) : (
                  <RefreshCw size={14} />
                )}
                <span>{t(probing ? "lsp.probe.probing" : "lsp.probe.refresh")}</span>
              </button>
            ) : null}
          </header>

          {module === "general" ? (
            <div className="settings-rows">
              <div className="settings-row">
                <span className="settings-label">{t("theme.label")}</span>
                <Select
                  label={t("theme.label")}
                  placeholder="—"
                  value={settings.theme}
                  options={THEME_OPTIONS.map((option) => ({
                    value: option,
                    label: t(THEME_LABEL[option]),
                  }))}
                  onChange={(option) => patch({ theme: option })}
                />
              </div>

              <div className="settings-row">
                <span className="settings-label">{t("language.label")}</span>
                <Select
                  label={t("language.label")}
                  placeholder="—"
                  value={lang}
                  options={LANG_OPTIONS}
                  onChange={setLang}
                />
              </div>

              <div className="settings-row">
                <span className="settings-label">{t("settings.workspaceMode")}</span>
                <Select
                  label={t("settings.workspaceMode")}
                  placeholder="—"
                  value={settings.workspaceMode}
                  options={WORKSPACE_MODES.map((option) => ({
                    value: option,
                    label: t(WORKSPACE_MODE_LABEL[option]),
                  }))}
                  onChange={(workspaceMode) => patch({ workspaceMode })}
                />
              </div>

              <div className="settings-row">
                <span className="settings-label">{t("settings.closeBehavior")}</span>
                <Select
                  label={t("settings.closeBehavior")}
                  placeholder="—"
                  value={settings.closeBehavior}
                  options={CLOSE_BEHAVIORS.map((option) => ({
                    value: option,
                    label: t(CLOSE_LABEL[option]),
                  }))}
                  onChange={(closeBehavior) => patch({ closeBehavior })}
                />
              </div>

              <div className="settings-row">
                <span className="settings-label">{t("settings.notificationPosition")}</span>
                <Select
                  label={t("settings.notificationPosition")}
                  placeholder="—"
                  value={settings.notificationPosition}
                  options={NOTIFICATION_POSITION_OPTIONS.map((pos) => ({
                    value: pos,
                    label: t(NOTIFICATION_POSITION_LABEL[pos]),
                  }))}
                  onChange={(notificationPosition) => patch({ notificationPosition })}
                />
              </div>

              <div className="settings-row">
                <span className="settings-label">{t("explorer.showIgnored")}</span>
                <Select
                  label={t("explorer.showIgnored")}
                  placeholder="—"
                  value={settings.explorer.showIgnored ? "yes" : "no"}
                  options={SWITCHES.map((option) => ({ value: option, label: t(SWITCH_LABEL[option]) }))}
                  onChange={(next) =>
                    patch({ explorer: { ...settings.explorer, showIgnored: next === "yes" } })
                  }
                />
              </div>

              <div className="settings-row">
                <span className="settings-label">{t("explorer.showHidden")}</span>
                <Select
                  label={t("explorer.showHidden")}
                  placeholder="—"
                  value={settings.explorer.showHidden ? "yes" : "no"}
                  options={SWITCHES.map((option) => ({ value: option, label: t(SWITCH_LABEL[option]) }))}
                  onChange={(next) =>
                    patch({ explorer: { ...settings.explorer, showHidden: next === "yes" } })
                  }
                />
              </div>
              <p className="settings-note">{t("language.note")}</p>
              <p className="settings-note">{t("workspaceMode.note")}</p>
              {settings.closeBehavior === "tray" ? (
                <p className="settings-note">{t("closeBehavior.note")}</p>
              ) : null}
            </div>
          ) : null}

          {module === "editor" ? (
            <div className="settings-rows">
              <div className="settings-row">
                <span className="settings-label">{t("settings.fontSize")}</span>
                <input
                  className="settings-input"
                  type="number"
                  min={10}
                  max={28}
                  value={settings.editor.fontSize}
                  onChange={(event) =>
                    patch({
                      editor: {
                        ...settings.editor,
                        fontSize: Math.min(28, Math.max(10, Number(event.target.value) || 13)),
                      },
                    })
                  }
                />
              </div>

              <div className="settings-row">
                <span className="settings-label">{t("settings.tabSize")}</span>
                <Select
                  label={t("settings.tabSize")}
                  placeholder="—"
                  value={settings.editor.tabSize}
                  options={TAB_SIZES.map((size) => ({ value: size, label: String(size) }))}
                  onChange={(size) => patch({ editor: { ...settings.editor, tabSize: size } })}
                />
              </div>

              <div className="settings-row">
                <span className="settings-label">{t("settings.keymap")}</span>
                <Select
                  label={t("settings.keymap")}
                  placeholder="—"
                  value={settings.editor.keymap}
                  options={KEYMAPS.map((scheme) => ({
                    value: scheme,
                    label: t(KEYMAP_LABEL[scheme]),
                  }))}
                  onChange={(keymap) => patch({ editor: { ...settings.editor, keymap } })}
                />
              </div>
              <div className="settings-row">
                <span className="settings-label">{t("settings.savePolicy")}</span>
                <Select
                  label={t("settings.savePolicy")}
                  placeholder="—"
                  value={settings.editor.savePolicy}
                  options={SAVE_POLICIES.map((option) => ({
                    value: option,
                    label: t(SAVE_POLICY_LABEL[option]),
                  }))}
                  onChange={(savePolicy) => patch({ editor: { ...settings.editor, savePolicy } })}
                />
              </div>

              <div className="settings-row">
                <span className="settings-label">{t("settings.saveOnExit")}</span>
                <Select
                  label={t("settings.saveOnExit")}
                  placeholder="—"
                  value={settings.editor.saveOnExit ? "yes" : "no"}
                  options={SWITCHES.map((option) => ({ value: option, label: t(SWITCH_LABEL[option]) }))}
                  onChange={(next) =>
                    patch({ editor: { ...settings.editor, saveOnExit: next === "yes" } })
                  }
                />
              </div>

              <div className="settings-row">
                <span className="settings-label">{t("settings.minimap")}</span>
                <Select
                  label={t("settings.minimap")}
                  placeholder="—"
                  value={settings.editor.minimap ? "yes" : "no"}
                  options={SWITCHES.map((option) => ({ value: option, label: t(SWITCH_LABEL[option]) }))}
                  onChange={(next) => patch({ editor: { ...settings.editor, minimap: next === "yes" } })}
                />
              </div>
            </div>
          ) : null}

          {module === "terminal" ? (
            <div className="settings-rows">
              <div className="settings-row">
                <span className="settings-label">{t("settings.shell")}</span>
                <Select
                  className="is-wide"
                  label={t("settings.shell")}
                  placeholder="—"
                  value={settings.terminal.shell || shells[0]?.path || ""}
                  options={shells.map((shell) => ({
                    value: shell.path,
                    label: shell.name,
                    detail: shell.path,
                  }))}
                  onChange={(shell) => patch({ terminal: { ...settings.terminal, shell } })}
                />
              </div>
            </div>
          ) : null}

          {module === "lsp" ? (
            <div className="settings-rows lsp-list">
              <p className="lsp-summary">
                {t("lsp.summary", {
                  total: lspRows.length,
                  installed: lspRows.filter((row) => probes?.[row.id]?.installed).length,
                  on: lspRows.filter((row) => row.mode === "lsp").length,
                })}
              </p>
              {lspRows.map((server) => {
                const label = languageNames(server.languages);
                const update = (next: Partial<LspServerConfig>) => patchServer(server.id, next);
                const probe = probes?.[server.id];
                // 三种状态分别处理界面：未探测、未安装、已安装，用户不需要自行判断本机是否装有该程序。
                const installed = probe ? probe.installed : null;
                const note = installNote[server.id];
                // 该项在本机存活的会话；一条也没有时，动作按钮即为「启动」。
                const sessionsOf = sessions.byServer[server.id] ?? [];
                const hasSession = sessionsOf.length > 0;
                const runtime = runtimeOf(sessionsOf, sessions.stale);
                // 标题是语言，本行是那个服务的名字加参数：C# 对应 csharp-ls，PHP 对应 intelephense。
                const detail = `${server.program}${server.args ? ` ${server.args}` : ""}`;
                // 卡片底部一行只写下一步：未安装提示安装、未探测提示探测、已安装但未启动则说明失败原因。
                const reason = lspReasons[server.id] ?? "";
                const line =
                  installed === false
                    ? t(server.installCommand ? "lsp.install.hint" : "lsp.install.none")
                    : installed === null
                      ? t("lsp.probe.hint")
                      : explain(reason);
                return (
                  <div key={server.id} className="lsp-card">
                    <div className="lsp-card-main">
                      <div className="lsp-card-title-row">
                        <span className="lsp-card-name">{label}</span>
                        <Select
                          className="lsp-mode"
                          label={`${label} ${t("lsp.dialog.mode")}`}
                          placeholder="—"
                          value={server.mode}
                          // 未安装的项不提供「外部 LSP」选项：探测已将其回退为 off，安装完成之后再谈启用。
                          options={modesFor(server)
                            .filter((mode) => mode !== "lsp" || installed !== false)
                            .map((mode) => ({ value: mode, label: t(LSP_MODE_LABEL[mode]) }))}
                          onChange={(mode) => update({ mode })}
                        />
                      </div>
                      <span className="lsp-card-detail" title={probe?.path || detail}>
                        <span className="lsp-card-kind">{t("lsp.card.server")}</span>
                        {detail}
                      </span>
                    </div>
                    <div className="lsp-card-actions">
                      {/* 只有外部档才有进程可报：跑着几条、有没有出问题看这一条。 */}
                      {server.mode === "lsp" ? (
                        <span
                          className={`lsp-runtime is-${runtime}`}
                          title={
                            hasSession
                              ? sessionsOf
                                  .map((item) => `${item.root}：${item.error ?? item.status}`)
                                  .join("\n")
                              : reason || undefined
                          }
                        >
                          {t(RUNTIME_LABEL[runtime])}
                        </span>
                      ) : null}
                      {/* 是否安装是这台机器的事实，档位是用户的选择，两者各说明一件事。 */}
                      {probe ? (
                        <span
                          className={`lsp-probe is-${installed ? "installed" : "missing"}`}
                          title={probe.path || probe.program}
                        >
                          {t(installed ? "lsp.probe.installed" : "lsp.probe.missing")}
                        </span>
                      ) : (
                        <span className="lsp-probe">{t("lsp.probe.unknown")}</span>
                      )}
                      {installed === false && server.installCommand ? (
                        <button
                          type="button"
                          className="lsp-action"
                          disabled={installing !== null}
                          onClick={() => setPendingInstall(server.id)}
                        >
                          {installing === server.id ? (
                            <span className="is-spinning">
                              <Loader2 size={13} />
                            </span>
                          ) : (
                            <Download size={13} />
                          )}
                          <span>
                            {t(installing === server.id ? "lsp.install.running" : "lsp.install")}
                          </span>
                        </button>
                      ) : null}
                      {/* 启动与重启是同一按钮的两种状态：该项存在会话时重启，没有会话时启动。 */}
                      {installed === true && server.mode === "lsp" ? (
                        <button
                          type="button"
                          className="lsp-action"
                          disabled={waking !== null || (!hasSession && !workspace)}
                          title={!hasSession && !workspace ? t("lsp.wake.noWorkspace") : undefined}
                          onClick={() => (hasSession ? restart(sessionsOf) : wake(server.id))}
                        >
                          {waking === server.id ? (
                            <span className="is-spinning">
                              <Loader2 size={13} />
                            </span>
                          ) : hasSession ? (
                            <RotateCw size={13} />
                          ) : (
                            <Play size={13} />
                          )}
                          <span>
                            {t(
                              hasSession
                                ? "lsp.restart"
                                : waking === server.id
                                  ? "lsp.wake.running"
                                  : "lsp.wake"
                            )}
                          </span>
                        </button>
                      ) : null}
                      {/* 进程写过标准错误就有内容可查：安装失败、握手超时的输出都在这里。 */}
                      {logged.includes(server.id) ? (
                        <button
                          type="button"
                          className="lsp-action"
                          onClick={() => setViewingLog(server.id)}
                        >
                          <ScrollText size={13} />
                          <span>{t("lsp.log")}</span>
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="icon-button"
                        title={t("lsp.edit")}
                        aria-label={`${t("lsp.edit")} ${label}`}
                        onClick={() => setEditing(server.id)}
                      >
                        <Pencil size={14} />
                      </button>
                    </div>
                    {/* 路径、参数等在编辑弹窗中修改；卡片上只保留这一行下一步提示。 */}
                    {line ? (
                      <p className="lsp-card-hint">
                        {line}
                        {reason && !note ? <CopyButton text={line} /> : null}
                      </p>
                    ) : null}
                    {note ? (
                      <p className="lsp-card-note">
                        {note}
                        <CopyButton text={note} />
                      </p>
                    ) : null}
                  </div>
                );
              })}
              <p className="settings-note">{t("lsp.note")}</p>
            </div>
          ) : null}

          {module === "about" ? (
            <div className="settings-rows">
              <div className="settings-row">
                <span className="settings-label">{t("settings.updates.autoDownload")}</span>
                <Select
                  label={t("settings.updates.autoDownload")}
                  placeholder="—"
                  value={settings.updates.autoDownload ? "yes" : "no"}
                  options={SWITCHES.map((option) => ({ value: option, label: t(SWITCH_LABEL[option]) }))}
                  onChange={(next) =>
                    patch({ updates: { ...settings.updates, autoDownload: next === "yes" } })
                  }
                />
              </div>

              {/* 这一行以「自动下载更新」为前提：没开自动下载就没有「下载完成后」可言。 */}
              {settings.updates.autoDownload ? (
                <div className="settings-row">
                  <span className="settings-label">{t("settings.updates.autoPromptInstall")}</span>
                  <Select
                    label={t("settings.updates.autoPromptInstall")}
                    placeholder="—"
                    value={settings.updates.autoPromptInstall ? "yes" : "no"}
                    options={SWITCHES.map((option) => ({
                      value: option,
                      label: t(SWITCH_LABEL[option]),
                    }))}
                    onChange={(next) =>
                      patch({ updates: { ...settings.updates, autoPromptInstall: next === "yes" } })
                    }
                  />
                </div>
              ) : null}

              <div className="settings-row">
                <span className="settings-label">{t("settings.updates.proxyEnabled")}</span>
                <Select
                  label={t("settings.updates.proxyEnabled")}
                  placeholder="—"
                  value={settings.updates.proxyEnabled ? "yes" : "no"}
                  options={SWITCHES.map((option) => ({ value: option, label: t(SWITCH_LABEL[option]) }))}
                  onChange={(next) =>
                    patch({ updates: { ...settings.updates, proxyEnabled: next === "yes" } })
                  }
                />
              </div>

              {settings.updates.proxyEnabled ? (
                <div className="settings-row">
                  <span className="settings-label">{t("settings.updates.proxyUrl")}</span>
                  <input
                    type="text"
                    className="settings-input is-url"
                    value={settings.updates.proxyUrl}
                    placeholder="https://gh-proxy.com/"
                    onChange={(e) =>
                      patch({ updates: { ...settings.updates, proxyUrl: e.target.value } })
                    }
                  />
                </div>
              ) : null}

              <div className="settings-row">
                <span className="settings-label">{t("about.version")}</span>
                <span className="about-value">{appVersion || "—"}</span>
              </div>

              <div className="settings-row">
                <span className="settings-label">{t("about.check")}</span>
                <button
                  type="button"
                  className="lsp-action"
                  disabled={updateStep === "checking" || flowBusy}
                  onClick={checkUpdate}
                >
                  {updateStep === "checking" ? (
                    <span className="is-spinning">
                      <Loader2 size={13} />
                    </span>
                  ) : (
                    <RefreshCw size={13} />
                  )}
                  <span>{t(updateStep === "checking" ? "about.checking" : "about.check")}</span>
                </button>
              </div>

              {updateStep === "latest" ? (
                <p className="settings-note">{t("about.latest")}</p>
              ) : null}
              {updateStep === "error" ? (
                <p className="settings-note">
                  {t("about.error")} {updateError}
                </p>
              ) : null}

              {updateStep === "available" && updateInfo ? (
                <>
                  <div className="settings-row">
                    <span className="settings-label">{t("about.newVersion")}</span>
                    <span className="about-value">{updateInfo.version}</span>
                    <button type="button" className="lsp-action" onClick={installUpdate}>
                      <Download size={13} />
                      <span>{t("about.download")}</span>
                    </button>
                  </div>
                  {/* 发版说明按行写的，保留换行展示；内容来自 Release 的说明文本。 */}
                  {updateInfo.notes ? <pre className="about-notes">{updateInfo.notes}</pre> : null}
                </>
              ) : null}

              {updateStep === "downloading" ? (
                <div className="settings-row">
                  <span className="settings-label">{t("about.progress")}</span>
                  <span className="about-value">
                    {progress.total
                      ? `${Math.min(100, Math.round((progress.received / progress.total) * 100))}%`
                      : humanBytes(progress.received)}
                  </span>
                </div>
              ) : null}

              {updateStep === "installed" ? (
                <div className="settings-row">
                  <span className="settings-label">{t("about.installed")}</span>
                  <button
                    type="button"
                    className="lsp-action"
                    disabled={restarting}
                    onClick={restartForUpdate}
                  >
                    <RotateCw size={13} />
                    <span>{t("about.restart")}</span>
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {editingEntry ? (
          <LspServerDialog
            server={editingEntry}
            probe={probes?.[editingEntry.id]}
            onSave={(next) => {
              patchServer(editingEntry.id, next);
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : null}

        {installEntry && installEntry.installCommand ? (
          <LspInstallDialog
            server={installEntry.program}
            command={installEntry.installCommand}
            onConfirm={() => {
              const id = installEntry.id;
              setPendingInstall(null);
              runInstall(id);
            }}
            onCancel={() => setPendingInstall(null)}
          />
        ) : null}

        {logEntry ? (
          <LspLogDialog
            label={`${languageNames(logEntry.languages)} · ${logEntry.program}`}
            lines={lspLogs(logEntry.id)}
            onClear={() => clearLspLogs(logEntry.id)}
            onClose={() => setViewingLog(null)}
          />
        ) : null}

        {confirmReset ? (
          <PromptDialog
            request={{ kind: "resetSettings", name: "" }}
            onSubmit={() => {
              setConfirmReset(false);
              // 只把通用页这几项恢复默认；编辑器、终端等其它页与最近使用记录都不动。
              patch({
                theme: DEFAULT_SETTINGS.theme,
                language: DEFAULT_SETTINGS.language,
                workspaceMode: DEFAULT_SETTINGS.workspaceMode,
                closeBehavior: DEFAULT_SETTINGS.closeBehavior,
                notificationPosition: DEFAULT_SETTINGS.notificationPosition,
                explorer: { ...DEFAULT_SETTINGS.explorer },
              });
            }}
            onCancel={() => setConfirmReset(false)}
          />
        ) : null}
    </div>
  );
}
