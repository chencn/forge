import { useMemo, useState } from "react";
import { Archive, Loader2, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import { cliDesktopAvailable, AI_NAMES } from "../lib/aiCli";
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
 */
export default function AiArchivedSessionsPanel({ workspace }: { workspace: string | null }) {
  const { t } = useI18n();
  const desktop = cliDesktopAvailable();
  const { sessions, dispatch } = useAiSessions(workspace);
  /** 已归档的顶层会话；子代理随父一起走，不单独列一行。 */
  const archived = useMemo(() => sessions
    .filter((item) => item.archived === true && !item.parentSessionId)
    .sort((a, b) => (b.lastActivity ?? b.createdAt) - (a.lastActivity ?? a.createdAt)), [sessions]);
  /** 等待确认的删除目标；单条带这次的勾选态，整批的勾选态每次从默认起。 */
  const [pending, setPending] = useState<{ scope: "one"; session: AiSession; purgeNative: boolean } | { scope: "all"; purgeNative: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<PurgeFailure[]>([]);

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
      const result = await deleteArchivedAiRuntimeSessions(workspace, purgeNative);
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
    <div className="ai-manage-page" aria-label={t("settings.aiArchived")}>
      <aside className="ai-cli-list" aria-label={t("settings.aiArchived")}>
        <div className="ai-cli-list-head">
          <span>{t("ai.archived.count", { count: archived.length })}</span>
          <button type="button" className="lsp-action is-danger" disabled={!workspace || !desktop || busy || archived.length === 0}
            onClick={() => setPending({ scope: "all", purgeNative: false })}>
            <Trash2 size={13} />{t("ai.archived.deleteAll")}
          </button>
        </div>
        <div className="ai-cli-list-body">
          {archived.map((session) => (
            <div key={session.id} className="ai-cli-row is-static">
              <Archive size={14} className="ai-cli-grip" aria-hidden="true" />
              <span className="ai-cli-row-text">
                <span className="ai-cli-row-name">{session.title || t("ai.untitledSession")}</span>
                <span className="ai-cli-row-meta">{formatAiRelativeTime(session.lastActivity ?? session.createdAt, Date.now())}</span>
              </span>
              <span className="ai-cli-badge is-idle">{AI_NAMES[session.provider]}</span>
              <button type="button" className="lsp-action is-danger" disabled={!workspace || busy}
                aria-label={t("menu.delete")} title={t("menu.delete")}
                onClick={() => setPending({ scope: "one", session, purgeNative: loadNativePurgeDefault(session.provider) })}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {!archived.length ? <p className="ai-cli-list-note">{t("ai.archived.empty")}</p> : null}
          {!workspace ? <p className="ai-cli-list-note">{t("ai.archived.noWorkspace")}</p> : null}
          {!desktop ? <p className="ai-cli-list-note">{t("ai.desktopOnly")}</p> : null}
        </div>
      </aside>

      <section className="ai-cli-detail" aria-label={t("ai.archived.hint")}>
        <div className="ai-cli-detail-body">
          <p className="ai-muted">{t("ai.archived.hint")}</p>
          {busy ? <p className="ai-cli-hint" role="status"><Loader2 size={13} className="is-spinning" aria-hidden="true" />{t("ai.archived.deleting")}</p> : null}
          {notice ? <p className="ai-success" role="status">{notice}</p> : null}
          {error ? <p className="ai-error" role="alert">{error}</p> : null}
          {failures.length ? (
            <ul className="ai-archived-failures">
              {failures.map((item) => <li key={item.id}>{t("ai.archived.failedOne", { name: item.title || t("ai.untitledSession"), message: item.error })}</li>)}
            </ul>
          ) : null}
        </div>
      </section>

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
              ? t(pending.purgeNative ? "ai.archived.allConfirmPurge" : "ai.archived.allConfirm", { count: archived.length })
              : t(pending.purgeNative ? "ai.deleteConfirmPurge" : "ai.deleteConfirm", { name: pending.session.title || t("ai.untitledSession") })}
          </p>
        </AiActionDialog>
      ) : null}
    </div>
  );
}
