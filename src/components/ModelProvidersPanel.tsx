import { useEffect, useState } from "react";
import { Eye, EyeOff, Loader2, Plus, Save, Send, Server, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard";
import { refreshAiCliSettings } from "../lib/aiCli";
import {
  CLAUDE_MODEL_SLOTS,
  applyModelProvider,
  cliAdminAvailable,
  emptyModelProvider,
  loadModelProviders,
  saveModelProviders,
} from "../lib/aiManage";
import type { ClaudeModelSlot, ModelProvider } from "../lib/aiManage";
import { AI_NAMES } from "../lib/aiCli";
import type { AiProvider } from "../lib/aiCli";
import Select from "./Select";
import AiActionDialog from "./AiActionDialog";
import type { TranslationKey } from "../i18n/lang/zh";

const SLOT_LABEL: Record<ClaudeModelSlot, TranslationKey> = {
  main: "ai.cfg.claudeMain",
  reasoning: "ai.cfg.claudeReasoning",
  haiku: "ai.cfg.claudeHaiku",
  sonnet: "ai.cfg.claudeSonnet",
  opus: "ai.cfg.claudeOpus",
  fable: "ai.cfg.claudeFable",
};

const SLOT_PLACEHOLDER: Record<ClaudeModelSlot, string> = {
  main: "claude-sonnet-4-5",
  reasoning: "claude-opus-4-1",
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-5",
  opus: "claude-opus-4-1",
  fable: "claude-fable-5-1",
};

/**
 * 比较用的快照：后端保存时会 trim 并丢掉空槽位，这里先归一化，
 * 免得「只是敲了个空格」也被当成未保存的修改。
 */
const snapshot = (item: ModelProvider): string => {
  const models: Record<string, string> = {};
  for (const slot of CLAUDE_MODEL_SLOTS) {
    const value = (item.models[slot] ?? "").trim();
    if (value) models[slot] = value;
  }
  return JSON.stringify({
    name: item.name.trim(),
    kind: item.kind,
    apiUrl: item.apiUrl.trim(),
    apiKey: item.apiKey,
    model: item.model.trim(),
    models,
  });
};

/**
 * 模型供应商：保存常用端点 + 密钥 + 模型，应用时写进 CLI 真正读取的位置。
 * Claude 的 settings.json env、Codex 的 auth.json/config.toml 都会同步，不只是 Forge 覆盖层。
 */
export default function ModelProvidersPanel() {
  const { t } = useI18n();
  const desktop = cliAdminAvailable();
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [draft, setDraft] = useState<ModelProvider | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [secret, setSecret] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ModelProvider | null>(null);
  /** 非空表示有一个「放弃未保存修改」确认框，确认后才执行挂起的切换动作。 */
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const [baseline, setBaseline] = useState("");
  const dirty = draft !== null && snapshot(draft) !== baseline;
  const guard = (action: () => void) => {
    if (dirty) setPendingLeave(() => action);
    else action();
  };
  useUnsavedGuard(() => dirty);

  const select = (item: ModelProvider, isNewProvider: boolean) => {
    setDraft(item);
    setIsNew(isNewProvider);
    setBaseline(snapshot(item));
    setNotice(null);
  };

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    setBusy(true);
    loadModelProviders()
      .then((list) => {
        if (!active) return;
        setProviders(list);
        const first = list[0];
        if (first) select({ ...first }, false);
      })
      .catch((error) => { if (active) setNotice({ error: true, text: t("providers.loadFailed", { message: String(error) }) }); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [desktop]);

  const edit = (patch: Partial<ModelProvider>) => setDraft((current) => current ? { ...current, ...patch } : current);

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true); setNotice(null);
    try {
      const next = isNew ? [...providers, draft] : providers.map((item) => item.id === draft.id ? draft : item);
      const saved = await saveModelProviders(next);
      setProviders(saved);
      const current = saved.find((item) => item.id === draft.id) ?? saved[0] ?? null;
      if (current) select({ ...current }, false);
      else setDraft(null);
      setNotice({ error: false, text: t("providers.saved") });
    } catch (error) {
      setNotice({ error: true, text: t("providers.saveFailed", { message: String(error) }) });
    } finally { setBusy(false); }
  };

  const apply = async () => {
    if (!draft || isNew || busy) return;
    setBusy(true); setNotice(null);
    try {
      // 先落盘再应用：否则界面上改过的值不会被写进 CLI。
      const next = providers.map((item) => item.id === draft.id ? draft : item);
      const saved = await saveModelProviders(next);
      setProviders(saved);
      await applyModelProvider(draft.id);
      await refreshAiCliSettings(true);
      const current = saved.find((item) => item.id === draft.id) ?? null;
      if (current) select({ ...current }, false);
      setNotice({ error: false, text: t("providers.applied", { name: AI_NAMES[draft.kind] }) });
    } catch (error) {
      setNotice({ error: true, text: t("providers.applyFailed", { message: String(error) }) });
    } finally { setBusy(false); }
  };

  const remove = async (target: ModelProvider) => {
    setPendingDelete(null);
    setBusy(true); setNotice(null);
    try {
      const saved = await saveModelProviders(providers.filter((item) => item.id !== target.id));
      setProviders(saved);
      const current = saved[0] ?? null;
      if (current) select({ ...current }, false);
      else setDraft(null);
    } catch (error) {
      setNotice({ error: true, text: t("providers.saveFailed", { message: String(error) }) });
    } finally { setBusy(false); }
  };

  return (
    <div className="ai-manage-page" aria-label={t("providers.title")}>
      <aside className="ai-cli-list" aria-label={t("providers.title")}>
        <div className="ai-cli-list-head">
          <span>{t("providers.title")}</span>
          <button type="button" className="icon-button is-inline" title={t("providers.add")} aria-label={t("providers.add")}
            disabled={!desktop || busy} onClick={() => guard(() => select(emptyModelProvider("claude"), true))}>
            <Plus size={14} />
          </button>
        </div>
        <div className="ai-cli-list-body">
          {providers.map((item) => (
            <button type="button" key={item.id}
              className={`ai-cli-row${!isNew && draft?.id === item.id ? " is-active" : ""}`}
              onClick={() => guard(() => select({ ...item }, false))}>
              <Server size={14} className="ai-cli-grip" aria-hidden="true" />
              <span className="ai-cli-row-name">{item.name || t("providers.untitled")}</span>
              <span className="ai-cli-badge is-idle">{AI_NAMES[item.kind]}</span>
            </button>
          ))}
          {!providers.length ? <p className="ai-cli-list-note">{desktop ? t("providers.empty") : t("ai.desktopOnly")}</p> : null}
        </div>
      </aside>

      <section className="ai-cli-detail" aria-label={t("providers.detail")}>
        {draft ? <>
          <header className="ai-cli-detail-head">
            <div className="ai-cli-detail-title">
              <Server size={18} aria-hidden="true" />
              <h3>{isNew ? t("providers.new") : draft.name || t("providers.untitled")}</h3>
              <span className="ai-cli-badge is-idle">{AI_NAMES[draft.kind]}</span>
              {dirty ? <span className="ai-cli-badge is-checking">{t("providers.unsaved")}</span> : null}
            </div>
          </header>
          <div className="ai-cli-detail-body">
            <p className="ai-muted">{t("providers.hint")}</p>
            <div className="ai-cli-form">
              <div className="ai-cli-grid">
                <label className="ai-cli-field">
                  <span>{t("providers.name")}</span>
                  <input className="text-input" spellCheck={false} value={draft.name} maxLength={80}
                    onChange={(event) => edit({ name: event.target.value })} />
                </label>
                <div className="ai-cli-field">
                  <span>{t("providers.kind")}</span>
                  <Select value={draft.kind} label={t("providers.kind")} placeholder={t("providers.kind")}
                    options={(["claude", "codex"] as AiProvider[]).map((kind) => ({ value: kind, label: AI_NAMES[kind] }))}
                    onChange={(kind) => edit({ kind })} />
                </div>
              </div>
              <div className="ai-cli-grid">
                <label className="ai-cli-field">
                  <span>{t("ai.cfg.apiUrl")}</span>
                  <input className="text-input" spellCheck={false} value={draft.apiUrl} maxLength={2048}
                    placeholder="https://api.example.com"
                    onChange={(event) => edit({ apiUrl: event.target.value })} />
                </label>
                <label className="ai-cli-field">
                  <span>{t("ai.cfg.apiKey")}</span>
                  <div className="ai-cli-inline">
                    <input className="text-input" spellCheck={false} type={secret ? "text" : "password"} value={draft.apiKey}
                      placeholder="sk-..." onChange={(event) => edit({ apiKey: event.target.value })} />
                    <button type="button" className="lsp-action ai-cli-secret-toggle"
                      aria-label={t(secret ? "ai.cfg.hideKey" : "ai.cfg.showKey")}
                      title={t(secret ? "ai.cfg.hideKey" : "ai.cfg.showKey")}
                      onClick={() => setSecret((value) => !value)}>
                      {secret ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                </label>
              </div>

              {draft.kind === "claude" ? (
                <div className="ai-cli-field">
                  <span>{t("providers.claudeModels")}</span>
                  <div className="ai-cli-grid">
                    {CLAUDE_MODEL_SLOTS.map((slot) => (
                      <label className="ai-cli-field" key={slot}>
                        <span>{t(SLOT_LABEL[slot])}</span>
                        <input className="text-input" spellCheck={false}
                          value={slot === "main" ? draft.model : draft.models[slot] ?? ""}
                          placeholder={SLOT_PLACEHOLDER[slot]}
                          onChange={(event) => edit(slot === "main"
                            ? { model: event.target.value }
                            : { models: { ...draft.models, [slot]: event.target.value } })} />
                      </label>
                    ))}
                  </div>
                  <em className="ai-cli-hint">{t("providers.modelHint")}</em>
                </div>
              ) : (
                <label className="ai-cli-field">
                  <span>{t("providers.model")}</span>
                  <input className="text-input" spellCheck={false} value={draft.model} placeholder="gpt-5-codex"
                    onChange={(event) => edit({ model: event.target.value })} />
                  <em className="ai-cli-hint">{t("providers.modelHint")}</em>
                </label>
              )}
            </div>
          </div>
          <div className="ai-manage-foot">
            {notice ? <p className={notice.error ? "ai-error" : "ai-success"} role="status">{notice.text}</p> : <span />}
            <div className="ai-cli-actions">
              {!isNew ? <button type="button" className="lsp-action" disabled={!desktop || busy} onClick={() => void apply()}>
                <Send size={13} />{t("providers.apply", { name: AI_NAMES[draft.kind] })}
              </button> : null}
              {!isNew ? <button type="button" className="lsp-action" disabled={!desktop || busy} onClick={() => setPendingDelete(draft)}>
                <Trash2 size={13} />{t("providers.delete")}
              </button> : null}
              <button type="button" className="lsp-action" disabled={!desktop || busy} onClick={() => void save()}>
                {busy ? <Loader2 size={13} className="is-spinning" /> : <Save size={13} />}
                {busy ? t("ai.saving") : t("providers.save")}
              </button>
            </div>
          </div>
        </> : <p className="ai-cli-empty">{desktop ? (busy ? t("ai.cfg.loading") : notice?.error ? notice.text : t("providers.selectHint")) : t("ai.desktopOnly")}</p>}
      </section>

      {pendingDelete ? <AiActionDialog title={t("providers.delete")} confirm={t("providers.delete")} danger
        onCancel={() => setPendingDelete(null)} onConfirm={() => void remove(pendingDelete)}>
        <p className="dialog-body">{t("providers.deleteConfirm", { name: pendingDelete.name || t("providers.untitled") })}</p>
      </AiActionDialog> : null}

      {pendingLeave ? <AiActionDialog title={t("providers.discardTitle")} confirm={t("providers.discard")} danger
        onCancel={() => setPendingLeave(null)}
        onConfirm={() => { const run = pendingLeave; setPendingLeave(null); run(); }}>
        <p className="dialog-body">{t("providers.discardHint")}</p>
      </AiActionDialog> : null}
    </div>
  );
}
