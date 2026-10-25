import { useEffect, useState } from "react";
import { Eye, EyeOff, Loader2, Plus, Save, Send, Server, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard";
import { refreshAiCliSettings } from "../lib/aiCli";
import {
  CLAUDE_CUSTOM_SLOTS,
  CLAUDE_MODEL_SLOTS,
  applyModelProvider,
  cliAdminAvailable,
  emptyModelProvider,
  loadModelProviders,
  normalizeCodexCatalogIntent,
  parseCodexCatalogIntent,
  readAiCliCodexCatalog,
  saveModelProviders,
  serializeCodexCatalogIntent,
} from "../lib/aiManage";
import type { ClaudeCustomSlot, ClaudeModelSlot, CodexCatalogView, ModelProvider } from "../lib/aiManage";
import { AI_NAMES } from "../lib/aiCli";
import type { AiProvider } from "../lib/aiCli";
import Select from "./Select";
import AiActionDialog from "./AiActionDialog";
import CodexCatalogSection from "./CodexCatalogSection";
import type { TranslationKey } from "../i18n/lang/zh";

const SLOT_LABEL: Record<ClaudeModelSlot, TranslationKey> = {
  main: "providers.claudeMainModel",
  reasoning: "providers.claudeReasoningModel",
  haiku: "providers.claudeHaikuDefaultModel",
  sonnet: "providers.claudeSonnetDefaultModel",
  opus: "providers.claudeOpusDefaultModel",
  fable: "providers.claudeFableDefaultModel",
};

const SLOT_PLACEHOLDER: Record<ClaudeModelSlot, string> = {
  main: "claude-sonnet-5-5",
  reasoning: "claude-opus-5-5",
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1",
};

const CUSTOM_LABEL: Record<ClaudeCustomSlot, TranslationKey> = {
  customOption: "providers.customOption",
  customOptionName: "providers.customOptionName",
  customOptionDescription: "providers.customOptionDescription",
};

const CUSTOM_PLACEHOLDER: Record<ClaudeCustomSlot, string> = {
  customOption: "my-gateway/claude-opus-5-5",
  customOptionName: "Gateway Opus",
  customOptionDescription: "Routed via custom gateway",
};

/**
 * 比较用的快照：后端保存时会 trim 并丢掉空槽位，这里先归一化，
 * 免得「只是敲了个空格」也被当成未保存的修改。Codex 模型字段存储意图 JSON，
 * 采用 normalizeCodexCatalogIntent 保证键顺序稳定比对。
 */
const snapshot = (item: ModelProvider): string => {
  const models: Record<string, string> = {};
  for (const slot of [...CLAUDE_MODEL_SLOTS, ...CLAUDE_CUSTOM_SLOTS]) {
    const value = (item.models[slot] ?? "").trim();
    if (value) models[slot] = value;
  }
  const modelValue = item.kind === "codex"
    ? normalizeCodexCatalogIntent(parseCodexCatalogIntent(item.model))
    : item.model.trim();
  return JSON.stringify({
    name: item.name.trim(),
    kind: item.kind,
    apiUrl: item.apiUrl.trim(),
    apiKey: item.apiKey,
    model: modelValue,
    models,
  });
};

/**
 * 保存前的必填校验：端点与密钥是供应商存在的意义，缺一个就不该保存。
 * 编辑时密钥留空表示「沿用原值」（与 codeg 一致），所以只有新建才要求它。
 */
const missingField = (item: ModelProvider, isNew: boolean): TranslationKey | null => {
  if (!item.name.trim()) return "providers.nameRequired";
  if (!item.apiUrl.trim()) return "providers.apiUrlRequired";
  if (isNew && !item.apiKey.trim()) return "providers.apiKeyRequired";
  return null;
};

/**
 * 模型供应商：字段与 codeg 的供应商表单一一对应——名称、API 地址、API 密钥、智能体类型，
 * 然后按类型给模型：Claude 六个槽位加「自定义模型选项」三项，Codex 一个模型。
 * 应用时写进 CLI 真正读取的位置：Claude 的 settings.json env、Codex 的 auth.json/config.toml。
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
  /** Codex 的模型清单：只用来给模型输入框做候选，读不到就退回手填。 */
  const [catalog, setCatalog] = useState<CodexCatalogView | null | undefined>(undefined);
  const dirty = draft !== null && snapshot(draft) !== baseline;
  const guard = (action: () => void) => {
    if (dirty) setPendingLeave(() => action);
    else action();
  };
  useUnsavedGuard(() => dirty);

  const select = (item: ModelProvider, isNewProvider: boolean) => {
    // 编辑时密钥置空：界面上不显示已存的密钥，留空即沿用（后端 keep_keys 负责填回）。
    const next = { ...item, apiKey: isNewProvider ? item.apiKey : "" };
    setDraft(next);
    setIsNew(isNewProvider);
    setBaseline(snapshot(next));
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

  // Codex 的模型清单来自 CLI 自己的模型清单，只在编辑 Codex 供应商时按需读取。
  useEffect(() => {
    if (!desktop || draft?.kind !== "codex" || catalog !== undefined) return;
    let active = true;
    readAiCliCodexCatalog()
      .then((view) => { if (active) setCatalog(view); })
      .catch(() => { if (active) setCatalog(null); });
    return () => { active = false; };
  }, [desktop, draft?.kind, catalog]);

  const save = async () => {
    if (!draft || busy) return;
    const missing = missingField(draft, isNew);
    if (missing) { setNotice({ error: true, text: t(missing) }); return; }
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
    const missing = missingField(draft, isNew);
    if (missing) { setNotice({ error: true, text: t(missing) }); return; }
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
      // 后端会拒绝删除仍被某个 CLI 绑定的供应商，并把是哪一个 CLI 说清楚。
      setNotice({ error: true, text: t("providers.deleteFailed", { message: String(error) }) });
    } finally { setBusy(false); }
  };

  return (
    <div className="ai-manage-page" aria-label={t("providers.title")}>
      <aside className="ai-cli-list" aria-label={t("providers.title")}>
        <div className="ai-cli-list-head">
          <span>{t("providers.title")}</span>
          <button type="button" className="lsp-action" disabled={!desktop || busy}
            onClick={() => guard(() => select(emptyModelProvider("claude"), true))}>
            <Plus size={13} />{t("providers.add")}
          </button>
        </div>
        <div className="ai-cli-list-body">
          {providers.map((item) => (
            <button type="button" key={item.id}
              className={`ai-cli-row${!isNew && draft?.id === item.id ? " is-active" : ""}`}
              onClick={() => guard(() => select({ ...item }, false))}>
              <Server size={14} className="ai-cli-grip" aria-hidden="true" />
              <span className="ai-cli-row-text">
                <span className="ai-cli-row-name">{item.name || t("providers.untitled")}</span>
                {item.apiUrl ? <code className="ai-provider-url">{item.apiUrl}</code> : null}
              </span>
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
              <h3>{isNew ? t("providers.add") : t("providers.edit")}</h3>
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
                    placeholder={t("providers.namePlaceholder")}
                    onChange={(event) => edit({ name: event.target.value })} />
                </label>
                <label className="ai-cli-field">
                  <span>{t("providers.apiUrl")}</span>
                  <input className="text-input" spellCheck={false} value={draft.apiUrl} maxLength={2048}
                    placeholder={t("providers.apiUrlPlaceholder")}
                    onChange={(event) => edit({ apiUrl: event.target.value })} />
                </label>
              </div>
              <div className="ai-cli-grid">
                <label className="ai-cli-field">
                  <span>{t("providers.apiKey")}</span>
                  <div className="ai-cli-inline">
                    <input className="text-input" spellCheck={false} type={secret ? "text" : "password"} value={draft.apiKey}
                      placeholder={t(isNew ? "providers.apiKeyPlaceholder" : "providers.apiKeyKeepCurrent")}
                      onChange={(event) => edit({ apiKey: event.target.value })} />
                    <button type="button" className="ai-cli-secret-toggle"
                      aria-label={t(secret ? "ai.cfg.hideKey" : "ai.cfg.showKey")}
                      title={t(secret ? "ai.cfg.hideKey" : "ai.cfg.showKey")}
                      onClick={() => setSecret((value) => !value)}>
                      {secret ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                </label>
                <div className="ai-cli-field">
                  <span>{t("providers.agentType")}</span>
                  {isNew ? (
                    <Select value={draft.kind} label={t("providers.agentType")} placeholder={t("providers.agentType")}
                      options={(["claude", "codex"] as AiProvider[]).map((kind) => ({ value: kind, label: AI_NAMES[kind] }))}
                      onChange={(kind) => edit({ kind, model: "", models: {} })} />
                  ) : (
                    <>
                      <Select value={draft.kind} label={t("providers.agentType")} placeholder={t("providers.agentType")}
                        options={(["claude", "codex"] as AiProvider[]).map((kind) => ({ value: kind, label: AI_NAMES[kind] }))}
                        disabled onChange={() => {}} />
                      <em className="ai-cli-hint">{t("providers.agentTypeImmutable")}</em>
                    </>
                  )}
                </div>
              </div>

              {draft.kind === "claude" ? (
                <>
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
                  <div className="ai-cli-grid is-triplet">
                    <label className="ai-cli-field">
                      <span>{t(CUSTOM_LABEL.customOption)}</span>
                      <input className="text-input" spellCheck={false} value={draft.models.customOption ?? ""}
                        placeholder={CUSTOM_PLACEHOLDER.customOption}
                        onChange={(event) => edit({ models: { ...draft.models, customOption: event.target.value } })} />
                    </label>
                    <label className="ai-cli-field">
                      <span>{t(CUSTOM_LABEL.customOptionName)}</span>
                      <input className="text-input" spellCheck={false} value={draft.models.customOptionName ?? ""}
                        placeholder={CUSTOM_PLACEHOLDER.customOptionName}
                        onChange={(event) => edit({ models: { ...draft.models, customOptionName: event.target.value } })} />
                    </label>
                    <label className="ai-cli-field">
                      <span>{t(CUSTOM_LABEL.customOptionDescription)}</span>
                      <input className="text-input" spellCheck={false} value={draft.models.customOptionDescription ?? ""}
                        placeholder={CUSTOM_PLACEHOLDER.customOptionDescription}
                        onChange={(event) => edit({ models: { ...draft.models, customOptionDescription: event.target.value } })} />
                    </label>
                  </div>
                  <em className="ai-cli-hint">{t("providers.customOptionHint")}</em>
                </>
              ) : (
                <div className="ai-cli-field">
                  <CodexCatalogSection
                    embedded
                    view={catalog ?? null}
                    draft={parseCodexCatalogIntent(draft.model)}
                    loading={catalog === undefined}
                    busy={busy}
                    onChange={(nextIntent) => edit({ model: serializeCodexCatalogIntent(nextIntent) })}
                    onReload={() => {
                      setCatalog(undefined);
                    }}
                  />
                </div>
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

      {pendingDelete ? <AiActionDialog title={t("providers.deleteConfirmTitle")} confirm={t("dialog.delete")} danger
        onCancel={() => setPendingDelete(null)} onConfirm={() => void remove(pendingDelete)}>
        <p className="dialog-body">{t("providers.deleteConfirmMessage", { name: pendingDelete.name || t("providers.untitled") })}</p>
      </AiActionDialog> : null}

      {pendingLeave ? <AiActionDialog title={t("providers.discardTitle")} confirm={t("providers.discard")} danger
        onCancel={() => setPendingLeave(null)}
        onConfirm={() => { const run = pendingLeave; setPendingLeave(null); run(); }}>
        <p className="dialog-body">{t("providers.discardHint")}</p>
      </AiActionDialog> : null}
    </div>
  );
}
