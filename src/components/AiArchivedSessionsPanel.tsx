import { useMemo, useState } from "react";
import { Archive, Loader2, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import { AI_NAMES, cliDesktopAvailable } from "../lib/aiCli";
import type { AiProvider } from "../lib/aiCli";
import type { AiSession } from "../lib/aiSessions";
import { loadNativePurgeDefault, saveNativePurgeDefault } from "../lib/aiSessions";
import { formatAiRelativeTime } from "../lib/aiSidebarView";
import { deleteAiRuntimeSession, deleteArchivedAiRuntimeSessions } from "../lib/aiRuntime";
import { refreshAiSessionHistory, useAiSessions } from "../hooks/useAiSessions";
import AiActionDialog from "./AiActionDialog";

/** 一次批量删除的结果明细；失败的那几条要能指名道姓地摊开，不能只报一个总数。 */
interface PurgeFailure { id: string; title: string; error: string }

/**
 * 设置页的「归档会话」。
 *
 * 归档只是从侧栏收起来，随时能取消；这一页负责另一件事——把收起来的会话真删掉。
 * 默认只删 Forge 镜像，勾选后才连 CLI 原生记录一起删（不可逆），勾选态按引擎分别记住。
 * 整页只有一条清单，没有可编辑的详情，所以走单列铺满：左右两栏会把一半宽度留给空话。
 */
export default function AiArchivedSessionsPanel({ workspace }: { workspace: string | null }) {
  const { t } = useI18n();
  const desktop = cliDesktopAvailable();
  const { sessions, dispatch } = useAiSessions(workspace);
  /** 已归档的顶层会话；子代理随父一起走，不单独列一行。 */
  const archived = useMemo(() => sessions
    .filter((item) => item.archived === true && !item.parentSessionId)
    .sort((a, b) => (b.lastActivity ?? b.createdAt) - (a.lastActivity ?? a.createdAt)), [sessions]);
  /**
   * CLI 页签：null 是「全部」。批量删除的范围跟着它走——页签写着 Codex 却把 Claude 的
   * 归档会话一起清掉，是用户看不见的那一半在动磁盘。
   */
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const rows = useMemo(() => (provider ? archived.filter((item) => item.provider === provider) : archived), [archived, provider]);
  const counts = useMemo(() => ({
    all: archived.length,
    claude: archived.filter((item) => item.provider === "claude").length,
    codex: archived.filter((item) => item.provider === "codex").length,
  }), [archived]);
  /** 等待确认的删除目标；单条带这次的勾选态，整批的勾选态每次从默认起。 */
  const [pending, setPending] = useState<{ scope: "one"; session: AiSession; purgeNative: boolean } | { scope: "all"; purgeNative: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<PurgeFailure[]>([]);
  /** 页签上的 CLI 名，也用来在确认文案里点明这一次删的是哪一路。 */
  const scope = provider ? AI_NAMES[provider] : t("ai.archived.filterAll");

  /** 删除成功后本地立刻收掉这条，再让后端带回来的权威列表覆盖一次，避免侧栏残留。 */
  const settle = (ids: string[], purgeNative: boolean) => {
    for (const id of ids) dispatch({ type: "delete", id, purgeNative });
    refreshAiSessionHistory();
  };

  const removeOne = async (session: AiSession, purgeNative: boolean) => {
    if (!workspace || busy) return;
    setBusy(true); setNotice(null); setError(null);
    try {
      await deleteAiRuntimeSession(session.id, workspace, purgeNative);
      settle([session.id], purgeNative);
      setNotice(t("ai.archived.deletedOne", { name: session.title || t("ai.untitledSession") }));
    } catch (reason) {
      setError(t("ai.archived.failedOne", { name: session.title || t("ai.untitledSession"), message: String(reason) }));
    } finally { setBusy(false); }
  };

  const removeAll = async (purgeNative: boolean) => {
    if (!workspace || busy) return;
    setBusy(true); setNotice(null); setError(null); setFailures([]);
    try {
      const result = await deleteArchivedAiRuntimeSessions(workspace, purgeNative, provider);
      const deleted = result.deleted ?? [];
      settle(deleted, purgeNative);
      const failed = result.failed ?? [];
      setFailures(failed);
      if (failed.length) setError(t("ai.archived.partial", { deleted: deleted.length, failed: failed.length }));
      else if (deleted.length) setNotice(t("ai.archived.deletedCount", { count: deleted.length }));
      else setNotice(t("ai.archived.empty"));
    } catch (reason) {
      setError(t("ai.archived.deleteAllFailed", { message: String(reason) }));
    } finally { setBusy(false); }
  };

  const confirm = (next: typeof pending) => {
    if (!next) return;
    setPending(null);
    if (next.scope === "one") void removeOne(next.session, next.purgeNative);
    else void removeAll(next.purgeNative);
  };

  return (
    <div className="ai-manage-panel" aria-label={t("settings.aiArchived")}>
      <div className="ai-manage-toolbar ai-archived-toolbar">
        <div className="ai-manage-tabs" role="group" aria-label={t("ai.archived.filter")}>
          <button type="button" className="lsp-action" aria-pressed={provider === null}
            disabled={busy} onClick={() => setProvider(null)}>
            {t("ai.archived.filterAll")}<span className="ai-cli-badge is-idle">{counts.all}</span>
          </button>
          {(["claude", "codex"] as AiProvider[]).map((item) => (
            <button type="button" key={item} className="lsp-action" aria-pressed={provider === item}
              disabled={busy} onClick={() => setProvider(item)}>
              {AI_NAMES[item]}<span className="ai-cli-badge is-idle">{counts[item]}</span>
            </button>
          ))}
        </div>
        <span className="ai-cli-hint">{t("ai.archived.count", { count: rows.length })}</span>
        <button type="button" className="lsp-action is-danger" disabled={!workspace || !desktop || busy || rows.length === 0}
          onClick={() => setPending({ scope: "all", purgeNative: false })}>
          <Trash2 size={13} />{t("ai.archived.deleteAll")}
        </button>
      </div>

      <div className="ai-cli-list ai-archived-list" aria-label={t("settings.aiArchived")}>
        <div className="ai-cli-list-body">
          {rows.map((session) => (
            <div key={session.id} className="ai-cli-row is-static">
              <Archive size={14} className="ai-cli-grip" aria-hidden="true" />
              <span className="ai-cli-row-name">{session.title || t("ai.untitledSession")}</span>
              {/* 页签已经限定 CLI 时不必再重复一遍徽章，那部分宽度留给标题。 */}
              {provider ? null : <span className="ai-cli-badge is-idle">{AI_NAMES[session.provider]}</span>}
              <span className="ai-cli-row-meta">{formatAiRelativeTime(session.lastActivity ?? session.createdAt, Date.now())}</span>
              <button type="button" className="lsp-action is-danger" disabled={!workspace || busy}
                aria-label={t("menu.delete")} title={t("menu.delete")}
                onClick={() => setPending({ scope: "one", session, purgeNative: loadNativePurgeDefault(session.provider) })}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {!rows.length ? <p className="ai-cli-list-note">{t("ai.archived.empty")}</p> : null}
          {!workspace ? <p className="ai-cli-list-note">{t("ai.archived.noWorkspace")}</p> : null}
          {!desktop ? <p className="ai-cli-list-note">{t("ai.desktopOnly")}</p> : null}
        </div>
        <div className="ai-manage-foot ai-archived-foot">
          <p className="ai-muted">{t("ai.archived.hint")}</p>
          <span className="ai-archived-status">
            {busy ? <p className="ai-cli-hint" role="status"><Loader2 size={13} className="is-spinning" aria-hidden="true" />{t("ai.archived.deleting")}</p> : null}
            {notice ? <p className="ai-success" role="status">{notice}</p> : null}
            {error ? <p className="ai-error" role="alert">{error}</p> : null}
          </span>
        </div>
        {failures.length ? (
          <ul className="ai-archived-failures">
            {failures.map((item) => <li key={item.id}>{t("ai.archived.failedOne", { name: item.title || t("ai.untitledSession"), message: item.error })}</li>)}
          </ul>
        ) : null}
      </div>

      {pending ? (
        <AiActionDialog
          title={t(pending.scope === "all" ? "ai.archived.deleteAll" : "ai.deleteSession")}
          confirm={t("menu.delete")} danger
          nativePurge={{
            checked: pending.purgeNative,
            onChange: (value) => {
              // 整批的会话可能混着两个引擎，没有「哪一个的默认值」可记，只在单条时按 provider 存。
              if (pending.scope === "one") saveNativePurgeDefault(pending.session.provider, value);
              setPending({ ...pending, purgeNative: value });
            },
            label: t("ai.deletePurgeNative"),
          }}
          onCancel={() => setPending(null)}
          onConfirm={() => confirm(pending)}>
          <p className="dialog-body">
            {pending.scope === "all"
              ? t(pending.purgeNative ? "ai.archived.allConfirmPurge" : "ai.archived.allConfirm", { count: rows.length, scope })
              : t(pending.purgeNative ? "ai.deleteConfirmPurge" : "ai.deleteConfirm", { name: pending.session.title || t("ai.untitledSession") })}
          </p>
        </AiActionDialog>
      ) : null}
    </div>
  );
}
