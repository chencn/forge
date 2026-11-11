import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Loader2, Plus, Save, Send, Server, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard";
import { refreshAiCliSettings } from "../lib/aiCli";
import {
  CLAUDE_CUSTOM_SLOTS,
  CLAUDE_MODEL_SLOTS,
  applyModelProvider,
  cliAdminAvailable,
  codexCatalogFromEndpoint,
  codexCatalogModelIds,
  emptyCodexCatalogIntent,
  emptyModelProvider,
  loadModelProviders,
  listProviderModels,
  normalizeCodexCatalogIntent,
  parseCodexCatalogIntent,
  readAiCliCodexCatalog,
  saveModelProviders,
  serializeCodexCatalogIntent,
} from "../lib/aiManage";
import type { ClaudeModelSlot, CodexCatalogView, ModelProvider } from "../lib/aiManage";
import { AI_NAMES } from "../lib/aiCli";
import type { AiProvider } from "../lib/aiCli";
import Select from "./Select";
import AiActionDialog from "./AiActionDialog";
import CodexCatalogSection from "./CodexCatalogSection";
import ClaudeProviderModels from "./ClaudeProviderModels";
import type { TranslationKey } from "../i18n/lang/zh";

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
 * 编辑时密钥留空表示「沿用原值」，所以只有新建才要求它。
 */
const missingField = (item: ModelProvider, isNew: boolean): TranslationKey | null => {
  if (!item.name.trim()) return "providers.nameRequired";
  if (!item.apiUrl.trim()) return "providers.apiUrlRequired";
  if (isNew && !item.apiKey.trim()) return "providers.apiKeyRequired";
  return null;
};

/**
 * 模型供应商：名称、API 地址、API 密钥、智能体类型，
 * 然后按类型给模型：Claude 六个可选或手填的槽位，Codex 模型清单。
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
  /** Codex 官方目录只提供参数模板，供应商可用模型来自自己的端点。 */
  const [catalog, setCatalog] = useState<CodexCatalogView | null | undefined>(undefined);
  /** 本机目录只用于恢复已保存模型及参数模板，不触发远程模型请求。 */
  const [catalogLoading, setCatalogLoading] = useState(false);
  /** 当前端点已加载的模型 ID；刷新累积，重置替换，null 表示尚未成功获取。 */
  const [endpointModels, setEndpointModels] = useState<string[] | null>(null);
  /** 端点请求和模板读取的共同状态。 */
  const [modelsLoading, setModelsLoading] = useState(false);
  /** 端点失败只显示错误，不把官方目录伪装成端点结果。 */
  const [modelsError, setModelsError] = useState<string | null>(null);
  /** 用户主动刷新或重置时重新请求同一端点。 */
  const [modelsVersion, setModelsVersion] = useState(0);
  /** 下一次请求的操作类型，启动时消费，避免重置影响后续端点切换。 */
  const pendingModelsAction = useRef<"refresh" | "reset" | null>(null);
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

  /** 拉取时遵循保存的密钥语义：编辑框留空则沿用该供应商已保存的密钥。 */
  const modelApiKey = draft?.apiKey.trim() || providers.find((item) => item.id === draft?.id)?.apiKey || "";
  /** 未手动刷新时从已保存意图恢复清单；新建空配置不导入本机官方模型。 */
  const visibleEndpointModels = endpointModels ?? (draft?.model ? codexCatalogModelIds(parseCodexCatalogIntent(draft.model), catalog ?? null) : []);
  // 页面进入只读取本机模板，保持供应商模型草稿原样。
  useEffect(() => {
    if (!desktop || draft?.kind !== "codex") return;
    /** 切换供应商后忽略旧本机目录响应。 */
    let active = true;
    setCatalogLoading(true);
    void readAiCliCodexCatalog()
      .then((view) => { if (active) setCatalog(view); })
      .catch(() => { if (active) setCatalog(null); })
      .finally(() => { if (active) setCatalogLoading(false); });
    return () => { active = false; };
  }, [desktop, draft?.id, draft?.kind]);
  /**
   * 重新获取远程模型，在请求成功后增量合并或替换草稿。
   * @param action - refresh 保留现有配置；reset 恢复为远程清单
   * @returns 触发请求；忙碌、未选中 Codex 或端点为空时不操作
   */
  const reloadModels = (action: "refresh" | "reset") => {
    if (busy || catalogLoading || modelsLoading || draft?.kind !== "codex" || !draft.apiUrl.trim()) return;
    pendingModelsAction.current = action;
    setModelsVersion((value) => value + 1);
  };
  /**
   * 更新 Claude 模型槽位，主模型写入快捷字段。
   * @param slot - 要修改的模型槽位
   * @param modelId - 模型 ID，可带上下文后缀；空字符串表示清除
   * @returns 更新草稿；未选中供应商时不执行操作
   */
  const fillSlot = (slot: ClaudeModelSlot, modelId: string) => {
    setDraft((current) => current ? slot === "main"
      ? { ...current, model: modelId }
      : { ...current, models: { ...current.models, [slot]: modelId } }
      : current);
  };
  // 端点变化只取消旧结果；仅按钮产生的操作允许发起远程请求。
  useEffect(() => {
    /** 显式操作只作用于本轮请求，页面进入或配置变化不联网。 */
    const action = pendingModelsAction.current;
    pendingModelsAction.current = null;
    setModelsError(null);
    if (!action || !desktop || draft?.kind !== "codex") {
      setEndpointModels(null);
      setModelsLoading(false);
      return;
    }
    /** 此轮请求是否仍属于当前供应商及端点。 */
    let active = true;
    /** 保留已展示来源，使刷新不会移除远程此次未返回的旧模型。 */
    const previousIds = visibleEndpointModels;
    setModelsLoading(Boolean(draft.apiUrl.trim()));
    if (!draft.apiUrl.trim()) return;
    void Promise.all([listProviderModels("codex", draft.apiUrl, modelApiKey), readAiCliCodexCatalog().catch(() => null)])
      .then(([ids, view]) => {
        if (!active) return;
        /** 重置仅使用本轮远程结果；刷新对来源 ID 去重并保留原顺序。 */
        const nextIds = action === "refresh" ? [...new Set([...previousIds, ...ids])] : ids;
        setCatalog(view);
        setEndpointModels(nextIds);
        setDraft((current) => {
          if (!current) return current;
          /** 重置清除手填和参数覆盖；刷新保留已有模型的编辑意图。 */
          const intent = action === "reset" ? emptyCodexCatalogIntent() : parseCodexCatalogIntent(current.model);
          // 新出现的官方模型可能因之前不在端点中被自动排除，需要随刷新恢复。
          if (action === "refresh") intent.excluded = intent.excluded.filter((id) => previousIds.includes(id) || !ids.includes(id));
          return { ...current, model: serializeCodexCatalogIntent(codexCatalogFromEndpoint(intent, nextIds, view)) };
        });
      })
      .catch((error) => { if (active) setModelsError(String(error)); })
      .finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, [desktop, draft?.id, draft?.kind, draft?.apiUrl, modelApiKey, modelsVersion]);

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
    <div className="ai-manage-page is-providers" aria-label={t("providers.title")}>
      <aside className="ai-cli-list" aria-label={t("providers.title")}>
        <div className="ai-cli-list-head">
          <span>{t("providers.title")}</span>
          <button type="button" className="panel-action" disabled={!desktop || busy}
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
              {dirty ? <span className="ai-cli-badge is-warn">{t("providers.unsaved")}</span> : null}
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
                <ClaudeProviderModels key={draft.id} apiUrl={draft.apiUrl} apiKey={modelApiKey}
                  values={{ ...draft.models, main: draft.model }}
                  busy={busy} onChange={fillSlot} />
              ) : (
                <div className="ai-cli-field">
                  {modelsError ? <div role="alert" className="ai-error">
                    {t("providers.fetchModelsFailed", { message: modelsError })}
                  </div> : null}
                  {endpointModels?.length === 0 ? <p className="ai-cli-hint">{t("providers.fetchModelsEmpty")}</p> : null}
                  <CodexCatalogSection
                    embedded
                    view={catalog ?? null}
                    endpointModels={visibleEndpointModels}
                    draft={parseCodexCatalogIntent(draft.model)}
                    loading={catalogLoading || modelsLoading}
                    busy={busy || catalogLoading || modelsLoading}
                    onRefreshEndpoint={draft.apiUrl.trim() ? () => reloadModels("refresh") : undefined}
                    onResetEndpoint={draft.apiUrl.trim() ? () => reloadModels("reset") : undefined}
                    onChange={(nextIntent) => edit({ model: serializeCodexCatalogIntent(nextIntent) })}
                  />
                </div>
              )}
            </div>
          </div>
          <div className="ai-manage-foot">
            {notice ? <p className={notice.error ? "ai-error" : "ai-success"} role="status">{notice.text}</p> : <span />}
            <div className="ai-cli-actions">
              {!isNew ? <button type="button" className="panel-action" disabled={!desktop || busy || (draft.kind === "codex" && modelsLoading)} onClick={() => void apply()}>
                <Send size={13} />{t("providers.apply", { name: AI_NAMES[draft.kind] })}
              </button> : null}
              {!isNew ? <button type="button" className="panel-action is-danger" disabled={!desktop || busy} onClick={() => setPendingDelete(draft)}>
                <Trash2 size={13} />{t("providers.delete")}
              </button> : null}
              <button type="button" className="panel-action" disabled={!desktop || busy || (draft.kind === "codex" && modelsLoading)} onClick={() => void save()}>
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
