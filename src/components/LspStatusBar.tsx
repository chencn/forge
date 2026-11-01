import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Popup } from "../ui/Popup";
import { Button, IconButton } from "../ui";
import { lspRetry, lspInstall } from "../lib/lsp";
import { lspManager } from "../lib/lspManager";
import { notificationCenter } from "../lib/notifications";
import { useLspConfig, useLspSessionStatuses } from "../hooks/useLspConfig";
import { serverEntries } from "../lib/lspConfig";
import { languageLabel } from "../lib/editorEnv";
import { describeError, errorCodeOf } from "../lib/errors";
import { pathWithin } from "../lib/format";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/lang/zh";
import { LspInstallDialog } from "./LspDialogs";

/** 一行服务器状态；字段与语义对标 IDE 的 ServerEntry。 */
type RowStatus = "starting" | "ready" | "busy" | "crashed" | "stopped" | "missing";

interface ServerRow {
  serverId: string;
  name: string;
  status: RowStatus;
  message: string | null;
  languages: string[];
  root: string | null;
  /** 会话行才有：重启按钮作用于这条会话。 */
  sessionId?: string;
}

const ROW_STATE_LABEL: Record<RowStatus, TranslationKey> = {
  starting: "lsp.status.starting",
  ready: "lsp.status.ready",
  busy: "lsp.status.busy",
  crashed: "lsp.state.dead",
  stopped: "lsp.state.exited",
  missing: "lsp.probe.missing",
};

function toneOf(status: RowStatus): "ok" | "busy" | "error" | "idle" {
  if (status === "ready") return "ok";
  // 「索引中」与「正在启动」在状态栏是同一档：都在动，都别让人以为它卡住了。
  if (status === "starting" || status === "busy") return "busy";
  if (status === "crashed" || status === "missing") return "error";
  return "idle";
}

/** 同语言已被别的在跑服务兜住时，missing 不算异常：点色降灰，摘要也不算坏。 */
function servedByOther(row: ServerRow, rows: readonly ServerRow[]): boolean {
  return (
    row.languages.length > 0 &&
    row.languages.every((l) =>
      rows.some((other) => other !== row && other.status !== "missing" && other.languages.includes(l))
    )
  );
}

/** 状态栏摘要：坏 > 启动中 > 在跑 > 空闲；文本是服务名，第一个名后面跟 +N。没有行就不画。 */
function serversSummary(
  rows: readonly ServerRow[]
): { text: string; tone: "ok" | "busy" | "error" | "idle" } | null {
  if (rows.length === 0) return null;
  const bad = rows.filter(
    (row) => row.status === "crashed" || (row.status === "missing" && !servedByOther(row, rows))
  );
  const busy = rows.filter((row) => row.status === "starting" || row.status === "busy");
  const tone = bad.length ? "error" : busy.length ? "busy" : rows.some((r) => r.status === "ready") ? "ok" : "idle";
  // 被别的服务接管的（stopped）不值得在状态栏点名。
  const active = rows.filter((row) => row.status !== "stopped");
  const names = [...new Set((active.length ? active : rows).map((row) => row.name))];
  return {
    text: names.length === 1 ? names[0]! : `${names[0]} +${names.length - 1}`,
    tone,
  };
}

interface Props {
  /** 当前工程根；没开工程时这一格不画，语言服务都按工程根起。 */
  workspace: string | null;
  /** 当前活动文档；用于显示同编辑器请求一致的自动识别路由。 */
  activeDocument: { path: string; language: string } | null;
  /** 动过进程之后要再对一趟文档与配置。 */
  onKicked: () => void;
  /** 报一条错给右下角的气泡；文案由前端按错误码拼，所以收的是后端那条原样串。 */
  onError: (text: string) => void;
}

/**
 * 底部状态条上的语言服务那一格（对标 IDE 的 ServerStatus）：
 *
 * - 一行 = 一个服务（跑着的会话 + 当前文件自动识别出的 missing/starting），不是一段自由文本。
 * - 按钮摘要只显示服务名（`rust-analyzer +1`），没有行就整个不渲染——参照里没有
 *   「空闲」「状态获取失败」这类兜底文案，也没有自创的「当前文件路由」段。
 * - 点击开合；行尾动作是「安装」（missing 且有安装命令）或重启图标按钮，其余全在设置页。
 */
export default function LspStatusBar({ workspace, activeDocument, onKicked, onError }: Props) {
  const { t } = useI18n();
  const { config, probes, reprobe, probeError } = useLspConfig();
  const sessions = useLspSessionStatuses();
  /** 服务端 `$/progress` 还没结束的会话：运行中但要显示成「索引中」（对标 IDE 的 Busy）。 */
  const [busySessions, setBusySessions] = useState<ReadonlySet<string>>(() => lspManager.busySessionIds());
  useEffect(() => lspManager.subscribeBusy(() => setBusySessions(lspManager.busySessionIds())), []);
  const [open, setOpen] = useState(false);
  const [pendingInstall, setPendingInstall] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [checkingInstall, setCheckingInstall] = useState<string | null>(null);
  const [installNote, setInstallNote] = useState<{ serverId: string; text: string } | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  /** 「根 + 服务」提醒过去一次就不再弹；换工程根会换键，对标 IDE 的重置节奏。 */
  const notifiedMissing = useRef<Set<string>>(new Set());

  const entriesById = useMemo(
    () => new Map(serverEntries(config).map((entry) => [entry.id, entry])),
    [config]
  );
  const route = activeDocument && workspace ? lspManager.route(activeDocument.path, activeDocument.language) : null;

  /** 会话行 + 当前文件的 missing/starting 行，按服务名排序，与参照同构。 */
  const rows = useMemo<ServerRow[]>(() => {
    const list: ServerRow[] = [];
    if (workspace) {
      for (const item of Object.values(sessions.byServer).flat()) {
        if (!pathWithin(workspace, item.root)) continue;
        const entry = entriesById.get(item.server);
        // 进程起不来但其实是「可执行文件没找到」（后端 spawn_session 以 LSP_NOT_FOUND
        // 稳定码记录）：参照的 missing，不是 crashed——行尾给「安装」，提示语给
        // 安装命令，不给重启图标。状态栏场景探测往往没跑过，报错码是唯一信号；
        // 但探测已经跑过且说装上了，就以探测为准——安装成功后死会话里的旧报错
        // 不能把这一行永远钉在「未安装」上。
        const probe = probes?.[item.server];
        const notInstalled = probe ? probe.installed === false : errorCodeOf(item.error ?? "") === "LSP_NOT_FOUND";
        list.push({
          serverId: item.server,
          name: entry?.program || item.server,
          status:
            item.status === "running"
              ? busySessions.has(item.id)
                ? "busy"
                : "ready"
              : notInstalled
                ? "missing"
                : item.status === "dead"
                  ? "crashed"
                  : "stopped",
          message:
            notInstalled && item.status !== "running"
              ? entry?.installCommand || entry?.installHint || item.error
              : item.error,
          languages: entry?.languages ?? [],
          root: item.root,
          sessionId: item.id,
        });
      }
    }
    if (route?.serverId && (route.status === "missing" || route.status === "starting")) {
      const entry = entriesById.get(route.serverId);
      if (!list.some((row) => row.serverId === route.serverId)) {
        list.push({
          serverId: route.serverId,
          name: entry?.program || route.serverId,
          status: route.status,
          message: entry?.installCommand || entry?.installHint || (route.detail ?? null),
          languages: entry?.languages ?? [route.language],
          root: route.root,
        });
      }
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [workspace, sessions.byServer, entriesById, route, busySessions]);

  const summary = serversSummary(rows);

  /** 当前文件需要的语言服务没装：右下角弹一次安装提醒，动作直接走状态栏这条安装链。 */
  const missingInstallable = rows
    .filter((row) => row.status === "missing" && entriesById.get(row.serverId)?.installCommand)
    .map((row) => row.serverId)
    .join(",");
  useEffect(() => {
    if (!workspace || !missingInstallable) return;
    for (const serverId of missingInstallable.split(",")) {
      const entry = entriesById.get(serverId);
      if (!entry?.installCommand) continue;
      const dedupKey = `${workspace}::${serverId}`;
      if (notifiedMissing.current.has(dedupKey)) continue;
      notifiedMissing.current.add(dedupKey);
      notificationCenter.notify({
        groupId: "lsp",
        key: `lsp-missing-${serverId}`,
        title: t("lsp.missing.title", { server: entry.program }),
        content: t("lsp.missing.body"),
        level: "warning",
        actions: [
          {
            label: t("lsp.install"),
            primary: true,
            run: () => {
              setOpen(true);
              void prepareInstall(serverId);
            },
          },
        ],
      });
    }
    // 探测状态变化（probes 首次就绪）时才需要重新判定；dedup 兜底防重复。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, missingInstallable, probes, t, entriesById]);

  /** 参照 IDE：项目内根显示相对路径，别的盘/外部根显示全路径。 */
  const relativeRoot = (root: string) => {
    if (!workspace) return root;
    const normRoot = root.replaceAll("/", "\\");
    const normWorkspace = workspace.replaceAll("/", "\\");
    if (normRoot.toLowerCase().startsWith(normWorkspace.toLowerCase() + "\\")) {
      return normRoot.slice(normWorkspace.length + 1);
    }
    return root;
  };
  /** 根相同（大小写、斜杠、末尾分隔符差异）就不显示根，参照按字符串不等才带根。 */
  const rootDiffers = (root: string) => {
    const normalize = (p: string) => p.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
    return normalize(root) !== normalize(workspace!);
  };

  /** 重启一条会话：清掉后端的退避记录，剩下的交给下一次对档去起进程。 */
  const retry = (id: string) => {
    lspRetry(id)
      .then(() => {
        sessions.refresh();
        onKicked();
      })
      .catch((error: unknown) => onError(typeof error === "string" ? error : String(error)));
  };

  /** 首次从状态栏安装时先补一轮探测，不能把「未知」误报成「未安装」。 */
  const prepareInstall = async (serverId: string) => {
    if (installing || checkingInstall) return;
    const entry = entriesById.get(serverId);
    if (!entry?.installCommand) return;
    setCheckingInstall(serverId);
    setInstallNote(null);
    try {
      const report = probes ? null : await reprobe();
      const probe = report?.servers.find((item) => item.id === serverId) ?? probes?.[serverId];
      if (!probe) {
        const detail = probeError ?? t("lsp.probe.unknown");
        const message = t("lsp.probe.failed", { detail });
        setInstallNote({ serverId, text: message });
        onError(message);
        return;
      }
      if (probe.installed) {
        setInstallNote({ serverId, text: t("lsp.install.already") });
        return;
      }
      setPendingInstall(serverId);
      setOpen(false);
    } finally {
      setCheckingInstall(null);
    }
  };

  const runInstall = async (serverId: string) => {
    if (installing) return;
    const entry = entriesById.get(serverId);
    if (!entry?.installCommand) return;
    setInstalling(true);
    setInstallNote(null);
    try {
      const result = await lspInstall(serverId);
      if (result.exitCode !== 0) {
        const output = result.output.trim();
        const message = `${t("lsp.install.failed", { code: result.exitCode ?? "?" })}${output ? `\n${output}` : ""}`;
        setInstallNote({ serverId, text: message });
        onError(message);
        return;
      }
      setInstallNote({ serverId, text: t("lsp.install.success") });
      await reprobe();
      // 死会话里还留着「没找到」的旧账：清掉退避并踢一次对档，服务马上就能起来，
      // 不用等用户手动开合文件。
      const dead = Object.values(sessions.byServer)
        .flat()
        .filter((item) => item.server === serverId);
      await Promise.all(dead.map((item) => lspRetry(item.id).catch(() => {})));
      sessions.refresh();
      onKicked();
    } catch (error) {
      const message = t("lsp.install.error", { detail: describeError(String(error), t) });
      setInstallNote({ serverId, text: message });
      onError(message);
    } finally {
      setInstalling(false);
      setPendingInstall(null);
    }
  };

  // 没有任何一行要展示时不占状态条：参照在 servers 为空时整个组件返回 null。
  if (!workspace || !summary) return null;

  return (
    <span className="status-lsp">
      <button
        ref={anchor}
        type="button"
        className="status-lsp-button"
        aria-label={t("lsp.bar.aria", { text: summary.text })}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`lsp-dot is-${summary.tone}`} aria-hidden="true" />
        <span className="status-lsp-name">{summary.text}</span>
      </button>
      {open ? (
        <Popup
          open
          anchor={anchor.current}
          placement="top-end"
          offset={6}
          onClose={() => setOpen(false)}
          aria-label={t("lsp.bar.title")}
        >
          <div className="lsp-panel">
            <div className="lsp-panel-header">
              <span>{t("lsp.bar.title")}</span>
            </div>
            {rows.map((row) => {
              const entry = entriesById.get(row.serverId);
              const gray = row.status === "missing" && servedByOther(row, rows);
              return (
                <div key={`${row.serverId}:${row.sessionId ?? "route"}`} className="lsp-server">
                  <div className="lsp-line">
                    <span className={`lsp-dot ${gray ? "is-idle" : `is-${toneOf(row.status)}`}`} aria-hidden="true" />
                    <span className="lsp-name">{row.name}</span>
                    <span className="lsp-status-text">{t(ROW_STATE_LABEL[row.status])}</span>
                    <span className="lsp-spacer" />
                    {row.status === "missing" && entry?.installCommand ? (
                      <Button
                        size="small"
                        disabled={checkingInstall !== null || installing}
                        onClick={() => void prepareInstall(row.serverId)}
                      >
                        {checkingInstall === row.serverId ? t("lsp.probe.probing") : t("lsp.install")}
                      </Button>
                    ) : (
                      <IconButton
                        icon="refresh"
                        size="small"
                        title={t("lsp.bar.retry")}
                        aria-label={t("lsp.bar.retry")}
                        disabled={row.status === "missing" || row.status === "starting" || !row.sessionId}
                        onClick={() => row.sessionId && retry(row.sessionId)}
                      />
                    )}
                  </div>
                  {row.languages.length > 0 || row.root ? (
                    <div className="lsp-meta">
                      {row.languages.map(languageLabel).join(", ")}
                      {row.root && rootDiffers(row.root) ? ` · ${relativeRoot(row.root)}` : ""}
                    </div>
                  ) : null}
                  {row.message ? (
                    <div className={clsx("lsp-message", row.status === "missing" && "is-install")}>{row.message}</div>
                  ) : null}
                  {/* 装完并起来后这条反馈就没意义了，别让它一直挂着。 */}
                  {installNote?.serverId === row.serverId && row.status !== "ready" ? (
                    <div className="lsp-message is-install">{installNote.text}</div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Popup>
      ) : null}
      {pendingInstall && entriesById.get(pendingInstall)?.installCommand ? (
        <LspInstallDialog
          server={entriesById.get(pendingInstall)?.program ?? pendingInstall}
          command={entriesById.get(pendingInstall)!.installCommand}
          onConfirm={() => {
            const serverId = pendingInstall;
            setPendingInstall(null);
            void runInstall(serverId);
          }}
          onCancel={() => {
            if (!installing) setPendingInstall(null);
          }}
        />
      ) : null}
    </span>
  );
}
