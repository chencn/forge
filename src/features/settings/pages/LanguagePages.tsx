import { useState, useEffect } from "react";
import {
  Download,
  Loader2,
  Pencil,
  Play,
  RotateCw,
  ScrollText,
} from "lucide-react";
import { useI18n } from "../../../i18n";
import type { TranslationKey } from "../../../i18n/lang/zh";
import { useLspConfig, useLspSessionStatuses } from "../../../hooks/useLspConfig";
import { modesFor, serverEnabled, serverEntries } from "../../../lib/lspConfig";
import type { LspMode, LspServerConfig, LspServerEntry } from "../../../lib/lspConfig";
import { lspInstall, lspRetry } from "../../../lib/lsp";
import type { LspServerProbe, LspSessionStatus } from "../../../lib/lsp";
import { describeError } from "../../../lib/errors";
import { clearLspLogs, lspLogs, watchLspLogs, watchLspStatus } from "../../../lib/lspClient";
import type { WakeResult } from "../../../lib/lspClient";
import { languageNames } from "../../../lib/editorEnv";
import Select from "../../../components/Select";
import { LspInstallDialog, LspLogDialog, LspServerDialog } from "../../../components/LspDialogs";
import CopyButton from "../../../components/CopyButton";

type Runtime = "idle" | "running" | "problem" | "unknown";

const LSP_MODE_LABEL: Record<LspMode, TranslationKey> = {
  off: "lsp.mode.off",
  builtin: "lsp.mode.builtin",
  lsp: "lsp.mode.lsp",
};

const RUNTIME_LABEL: Record<Runtime, TranslationKey> = {
  idle: "lsp.runtime.idle",
  running: "lsp.runtime.running",
  problem: "lsp.runtime.problem",
  unknown: "lsp.runtime.unknown",
};

function probeRank(probe?: LspServerProbe): number {
  if (!probe) return 1;
  return probe.installed ? 0 : 2;
}

function runtimeOf(items: LspSessionStatus[] | undefined, stale: boolean): Runtime {
  if (stale) return "unknown";
  if (!items || items.length === 0) return "idle";
  return items.some((item) => item.status !== "running") ? "problem" : "running";
}

export function LanguageLspPage({
  workspace,
  onLspKick,
  onLspWake,
}: {
  workspace: string | null;
  onLspKick?: () => void;
  onLspWake?: (serverId: string) => Promise<WakeResult>;
}) {
  const { t } = useI18n();
  const { config, patchServer, probes } = useLspConfig();
  const sessions = useLspSessionStatuses();

  const [installing, setInstalling] = useState<string | null>(null);
  const [waking, setWaking] = useState<string | null>(null);
  const [installNote, setInstallNote] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [viewingLog, setViewingLog] = useState<string | null>(null);
  const [pendingInstall, setPendingInstall] = useState<string | null>(null);
  const [lspReasons, setLspReasons] = useState<Record<string, string>>({});
  const [, setLogTick] = useState(0);

  useEffect(() => {
    return watchLspStatus((serverId, _status, detail) => {
      setLspReasons((current) => {
        if (current[serverId] === detail) return current;
        return { ...current, [serverId]: detail ?? "" };
      });
    });
  }, []);

  useEffect(() => {
    return watchLspLogs(() => setLogTick((tick) => tick + 1));
  }, []);

  const wake = async (id: string) => {
    setWaking(id);
    try {
      if (onLspWake) await onLspWake(id);
    } finally {
      setWaking(null);
    }
  };

  const restart = async (items: LspSessionStatus[]) => {
    if (items.length === 0) return;
    const serverId = items[0]!.server;
    setWaking(serverId);
    try {
      await Promise.all(items.map((item) => lspRetry(item.id)));
    } finally {
      setWaking(null);
    }
  };

  const runInstall = async (id: string) => {
    const entry = serverEntries(config).find((s) => s.id === id);
    if (!entry || !entry.installCommand) return;
    setInstalling(id);
    try {
      await lspInstall(entry.installCommand);
      setInstallNote((current) => ({
        ...current,
        [id]: "安装完成",
      }));
      if (onLspKick) onLspKick();
    } catch (error) {
      setInstallNote((current) => ({
        ...current,
        [id]: `安装失败：${describeError(String(error), t)}`,
      }));
    } finally {
      setInstalling(null);
    }
  };

  const lspRows = [...serverEntries(config)].sort(
    (a, b) => probeRank(probes?.[a.id]) - probeRank(probes?.[b.id])
  );

  const editingEntry = editing
    ? (serverEntries(config).find((entry) => entry.id === editing) ?? null)
    : null;
  const installEntry = pendingInstall
    ? (serverEntries(config).find((entry) => entry.id === pendingInstall) ?? null)
    : null;
  const logEntry = viewingLog
    ? (serverEntries(config).find((entry) => entry.id === viewingLog) ?? null)
    : null;

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit lsp-list">
        <p className="lsp-summary">
          {t("lsp.summary", {
            total: lspRows.length,
            installed: lspRows.filter((row) => probes?.[row.id]?.installed).length,
            on: lspRows.filter((row) => row.mode === "lsp").length,
          })}
        </p>

        {lspRows.map((server) => {
          const probe = probes?.[server.id];
          const installed = probe ? probe.installed : null;
          const label = languageNames(server.languages);
          const sessionsOf = sessions.byServer[server.id] ?? [];
          const hasSession = sessionsOf.length > 0;
          const runtime = runtimeOf(sessionsOf, sessions.stale);
          const detail = `${server.program}${server.args ? ` ${server.args}` : ""}`;
          const reason = lspReasons[server.id] ?? "";
          const note = installNote[server.id];
          const line =
            installed === false
              ? t(server.installCommand ? "lsp.install.hint" : "lsp.install.none")
              : installed === null
                ? t("lsp.probe.hint")
                : reason;

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
                    options={modesFor(server)
                      .filter((mode) => mode === "off" || installed !== false)
                      .map((mode) => ({ value: mode, label: t(LSP_MODE_LABEL[mode]) }))}
                    onChange={(mode) => patchServer(server.id, { mode })}
                  />
                </div>
                <span className="lsp-card-detail" title={probe?.path || detail}>
                  <span className="lsp-card-kind">{t("lsp.card.server")}</span>
                  {detail}
                </span>
              </div>

              <div className="lsp-card-actions">
                {serverEnabled(server) ? (
                  <span
                    className={`lsp-runtime is-${runtime}`}
                    title={
                      hasSession
                        ? sessionsOf.map((item) => `${item.root}：${item.error ?? item.status}`).join("\n")
                        : reason || undefined
                    }
                  >
                    {t(RUNTIME_LABEL[runtime])}
                  </span>
                ) : null}

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
                    <span>{t(installing === server.id ? "lsp.install.running" : "lsp.install")}</span>
                  </button>
                ) : null}

                {installed === true && serverEnabled(server) ? (
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
                      {t(hasSession ? "lsp.restart" : waking === server.id ? "lsp.wake.running" : "lsp.wake")}
                    </span>
                  </button>
                ) : null}

                {lspLogs(server.id).length > 0 ? (
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
      </div>

      {editingEntry ? (
        <LspServerDialog
          server={editingEntry}
          probe={probes?.[editingEntry.id]}
          onSave={(patch: Partial<LspServerEntry>) => {
            patchServer(editingEntry.id, patch as Partial<LspServerConfig>);
            setEditing(null);
            if (onLspKick) onLspKick();
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
            void runInstall(id);
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
    </div>
  );
}

export function LanguageSchemasPage() {
  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <p className="settings-hint">
          Forge 编辑器默认自动匹配常见配置文件模式（package.json、Cargo.toml、tsconfig.json 等），提供智能补全与语法检查。
        </p>
      </div>
    </div>
  );
}
