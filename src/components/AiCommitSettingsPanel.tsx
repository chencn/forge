import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import Select from "./Select";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/lang/zh";
import {
  COMMIT_EFFORTS,
  COMMIT_FORMATS,
  COMMIT_PROTOCOLS,
  CHAT_TOKEN_LIMIT_FIELDS,
  DEFAULT_AI_COMMIT_CONFIG,
  getCommitFormatPreview,
  listAiCommitModels,
  loadAiCommitConfig,
  newAiCommitProvider,
  saveAiCommitConfig,
  type AiCommitConfig,
  type AiCommitProvider,
  type CommitEffort,
  type CommitFormat,
  type CommitProtocol,
  type ChatTokenLimitField,
} from "../lib/aiCommit";

const SWITCHES = ["yes", "no"] as const;
type Switch = (typeof SWITCHES)[number];

export default function AiCommitSettingsPanel() {
  const { t } = useI18n();
  const [config, setConfig] = useState<AiCommitConfig>(DEFAULT_AI_COMMIT_CONFIG);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [savedTip, setSavedTip] = useState(false);

  // 模型拉取与下拉交互状态
  const [modelsMap, setModelsMap] = useState<Record<string, string[]>>({});
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchSuccessTip, setFetchSuccessTip] = useState<string | null>(null);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const [providerToDelete, setProviderToDelete] = useState<AiCommitProvider | null>(null);
  const [subjectMaxLenInput, setSubjectMaxLenInput] = useState<string>("256");
  const [maxDiffCharsInput, setMaxDiffCharsInput] = useState<string>("32000");

  useEffect(() => {
    let alive = true;
    loadAiCommitConfig()
      .then((loaded) => {
        if (!alive) return;
        setConfig(loaded);
        setSelectedProviderId(loaded.activeProviderId ?? loaded.providers[0]?.id ?? null);
        setSubjectMaxLenInput(String(loaded.subjectMaximumLength ?? 256));
        setMaxDiffCharsInput(String(loaded.maximumDiffCharacters ?? 32000));
      })
      .catch(() => {
        // 加载失败时沿用默认配置
      });
    return () => {
      alive = false;
    };
  }, []);

  // 点击外部收起模型下拉菜单
  useEffect(() => {
    if (!modelDropdownOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!modelDropdownRef.current?.contains(event.target as Node)) {
        setModelDropdownOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [modelDropdownOpen]);

  // 按 Escape 键关闭删除确认弹窗
  useEffect(() => {
    if (!providerToDelete) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProviderToDelete(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [providerToDelete]);

  const persistConfig = (next: AiCommitConfig) => {
    setConfig(next);
    void saveAiCommitConfig(next)
      .then(() => {
        setSavedTip(true);
        setTimeout(() => setSavedTip(false), 2000);
      })
      .catch(() => {});
  };

  const updateConfig = (patch: Partial<AiCommitConfig>) => {
    const next = { ...config, ...patch };
    persistConfig(next);
  };

  const activeProvider =
    config.providers.find((p) => p.id === (selectedProviderId ?? config.activeProviderId)) ??
    config.providers[0] ??
    null;

  const updateActiveProvider = (patch: Partial<AiCommitProvider>) => {
    if (!activeProvider) return;
    const nextProviders = config.providers.map((p) =>
      p.id === activeProvider.id ? { ...p, ...patch } : p
    );
    persistConfig({ ...config, providers: nextProviders });
  };

  const handleAddProvider = () => {
    const nextProvider = newAiCommitProvider(`Provider ${config.providers.length + 1}`);
    const nextProviders = [...config.providers, nextProvider];
    const nextActiveId = config.activeProviderId ?? nextProvider.id;
    setSelectedProviderId(nextProvider.id);
    persistConfig({
      ...config,
      providers: nextProviders,
      activeProviderId: nextActiveId,
    });
  };

  const handleRemoveProvider = (id: string) => {
    if (config.providers.length === 0) return;
    const nextProviders = config.providers.filter((p) => p.id !== id);
    const nextActiveId =
      config.activeProviderId === id ? nextProviders[0]?.id ?? null : config.activeProviderId;
    setSelectedProviderId(nextProviders[0]?.id ?? null);
    persistConfig({
      ...config,
      providers: nextProviders,
      activeProviderId: nextActiveId,
    });
  };

  const handleFetchModels = async () => {
    if (!activeProvider || !activeProvider.endpoint.trim()) return;
    setFetchingModels(true);
    setFetchError(null);
    setFetchSuccessTip(null);
    const startTime = Date.now();
    try {
      const models = await listAiCommitModels({
        endpoint: activeProvider.endpoint,
        apiKey: activeProvider.apiKey,
        allowsInsecureHttp: activeProvider.allowsInsecureHttp,
      });
      // 至少平滑展示 750ms，避免极快返回导致转圈太急促、一闪而过
      const elapsed = Date.now() - startTime;
      if (elapsed < 750) {
        await new Promise((resolve) => setTimeout(resolve, 750 - elapsed));
      }
      setModelsMap((prev) => ({ ...prev, [activeProvider.id]: models }));
      setFetchSuccessTip(
        t("aiCommit.fetchModelsSuccess").replace("{count}", String(models.length))
      );
      setModelDropdownOpen(true);
      setTimeout(() => setFetchSuccessTip(null), 3000);
    } catch (err) {
      const elapsed = Date.now() - startTime;
      if (elapsed < 600) {
        await new Promise((resolve) => setTimeout(resolve, 600 - elapsed));
      }
      setFetchError(String(err));
    } finally {
      setFetchingModels(false);
    }
  };

  const formatLabels: Record<CommitFormat, TranslationKey> = {
    conventional: "aiCommit.format.conventional",
    concise: "aiCommit.format.concise",
    imperative: "aiCommit.format.imperative",
    descriptive: "aiCommit.format.descriptive",
    releaseNote: "aiCommit.format.releaseNote",
    custom: "aiCommit.format.custom",
  };

  const protocolLabels: Record<CommitProtocol, TranslationKey> = {
    chatCompletions: "aiCommit.protocol.chatCompletions",
    anthropicMessages: "aiCommit.protocol.anthropicMessages",
    responses: "aiCommit.protocol.responses",
  };

  const effortLabels: Record<CommitEffort, TranslationKey> = {
    default: "aiCommit.reasoning.default",
    none: "aiCommit.reasoning.none",
    minimal: "aiCommit.reasoning.minimal",
    low: "aiCommit.reasoning.low",
    medium: "aiCommit.reasoning.medium",
    high: "aiCommit.reasoning.high",
  };

  const tokenLimitLabels: Record<ChatTokenLimitField, TranslationKey> = {
    max_completion_tokens: "aiCommit.tokenLimitField.max_completion_tokens",
    max_tokens: "aiCommit.tokenLimitField.max_tokens",
  };

  const availableModels = activeProvider ? modelsMap[activeProvider.id] ?? [] : [];
  const filteredModels = availableModels.filter((m) =>
    m.toLowerCase().includes(modelSearch.toLowerCase().trim())
  );

  const previewInfo = getCommitFormatPreview(
    config.format,
    config.language,
    config.includeBody,
    config.customInstructions
  );

  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
      {/* 全局开关 */}
      <div className="settings-row">
        <span className="settings-label">{t("aiCommit.enabled")}</span>
        <Select<Switch>
          label={t("aiCommit.enabled")}
          placeholder="—"
          value={config.enabled ? "yes" : "no"}
          options={[
            { value: "yes", label: t("common.yes") },
            { value: "no", label: t("common.no") },
          ]}
          onChange={(val) => updateConfig({ enabled: val === "yes" })}
        />
      </div>

      <div style={{ height: 1, background: "var(--border-color)", margin: "8px 0" }} />

      {/* 服务商管理板块 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 600 }}>{t("aiCommit.providers")}</h3>
        <button
          type="button"
          className="button is-small"
          onClick={handleAddProvider}
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          <Plus size={13} />
          <span>{t("aiCommit.addProvider")}</span>
        </button>
      </div>

      {config.providers.length === 0 ? (
        <div
          style={{
            border: "1px dashed var(--border-color)",
            borderRadius: "var(--radius-sm, 6px)",
            padding: "20px 24px",
            textAlign: "center",
            background: "var(--bg-secondary)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {t("aiCommit.emptyProvidersTip")}
          </span>
          <button
            type="button"
            className="button is-primary is-small"
            onClick={handleAddProvider}
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <Plus size={13} />
            <span>{t("aiCommit.addProvider")}</span>
          </button>
        </div>
      ) : (
        <>
          {/* 当前选择与切换 */}
          <div className="settings-row">
            <span className="settings-label">{t("aiCommit.activeProvider")}</span>
            <Select<string>
              className="is-wide"
              label={t("aiCommit.activeProvider")}
              placeholder={t("aiCommit.noProvider")}
              value={config.activeProviderId}
              options={config.providers.map((p) => ({
                value: p.id,
                label: p.name || p.id,
                detail: p.model || p.endpoint,
              }))}
              onChange={(id) => {
                setSelectedProviderId(id);
                updateConfig({ activeProviderId: id });
              }}
            />
          </div>

          {/* 服务商详情卡片 */}
          {activeProvider ? (
            <div
              style={{
                border: "1px solid var(--border-color)",
                borderRadius: "var(--radius-sm)",
                padding: "14px 16px",
                background: "var(--bg-secondary)",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                  {activeProvider.name}{" "}
                  {activeProvider.id === config.activeProviderId
                    ? `(${t("aiCommit.activeProvider")})`
                    : ""}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {activeProvider.id !== config.activeProviderId ? (
                    <button
                      type="button"
                      className="button is-small"
                      onClick={() => updateConfig({ activeProviderId: activeProvider.id })}
                    >
                      {t("aiCommit.activeProvider")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="icon-button"
                    title={t("aiCommit.removeProvider")}
                    onClick={() => setProviderToDelete(activeProvider)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <div className="settings-row">
                <span className="settings-label">{t("aiCommit.providerName")}</span>
                <input
                  type="text"
                  className="settings-input is-wide"
                  style={{ width: 280 }}
                  value={activeProvider.name}
                  onChange={(e) => updateActiveProvider({ name: e.target.value })}
                />
              </div>

              <div className="settings-row">
                <span className="settings-label">{t("aiCommit.protocol")}</span>
                <Select<CommitProtocol>
                  className="is-wide"
                  label={t("aiCommit.protocol")}
                  placeholder="—"
                  value={activeProvider.apiProtocol}
                  options={COMMIT_PROTOCOLS.map((p) => ({ value: p, label: t(protocolLabels[p]) }))}
                  onChange={(proto) => updateActiveProvider({ apiProtocol: proto })}
                />
              </div>

              <div className="settings-row">
                <span className="settings-label">{t("aiCommit.endpoint")}</span>
                <input
                  type="text"
                  className="settings-input is-url is-wide"
                  style={{ width: 340 }}
                  placeholder={t("aiCommit.endpointPlaceholder")}
                  value={activeProvider.endpoint}
                  onChange={(e) => updateActiveProvider({ endpoint: e.target.value })}
                />
              </div>

              {/* 模型名称支持手动输入与 /v1/models 下拉 */}
              <div className="settings-row" style={{ alignItems: "flex-start" }}>
                <span className="settings-label" style={{ marginTop: 6 }}>
                  {t("aiCommit.model")}
                </span>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div
                    ref={modelDropdownRef}
                    style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
                      <input
                        type="text"
                        className="settings-input is-wide"
                        style={{ width: 280, paddingRight: 28 }}
                        placeholder={t("aiCommit.modelPlaceholder")}
                        value={activeProvider.model}
                        onChange={(e) => updateActiveProvider({ model: e.target.value })}
                        onFocus={() => {
                          if (availableModels.length > 0) {
                            setModelDropdownOpen(true);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="icon-button"
                        style={{
                          position: "absolute",
                          right: 4,
                          padding: 2,
                          opacity: 0.7,
                          height: 22,
                          width: 22,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                        title={modelDropdownOpen ? "收起模型列表" : "展开模型列表"}
                        onClick={() => {
                          setModelDropdownOpen((prev) => !prev);
                          if (!modelDropdownOpen && availableModels.length === 0 && !fetchingModels) {
                            void handleFetchModels();
                          }
                        }}
                      >
                        {modelDropdownOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                      </button>
                    </div>

                    <button
                      type="button"
                      className="button is-small"
                      disabled={fetchingModels || !activeProvider.endpoint.trim()}
                      title={t("aiCommit.fetchModels")}
                      onClick={() => void handleFetchModels()}
                      style={{ display: "inline-flex", alignItems: "center", gap: 4, height: 28 }}
                    >
                      <RefreshCw
                        size={13}
                        className={fetchingModels ? "is-spinning" : undefined}
                        data-spin={fetchingModels ? "true" : undefined}
                        style={{
                          display: "inline-block",
                          transformOrigin: "50% 50%",
                          animation: fetchingModels ? "spin 1.4s linear infinite" : "none",
                        }}
                      />
                      <span>{fetchingModels ? t("aiCommit.fetchingModels") : "拉取模型"}</span>
                    </button>

                    {/* 下拉浮层 */}
                    {modelDropdownOpen ? (
                      <div
                        style={{
                          position: "absolute",
                          top: "calc(100% + 4px)",
                          left: 0,
                          width: 320,
                          maxHeight: 280,
                          background: "var(--bg-primary)",
                          border: "1px solid var(--border-color)",
                          borderRadius: "var(--radius-sm, 6px)",
                          boxShadow: "0 6px 16px rgba(0,0,0,0.25)",
                          zIndex: 100,
                          display: "flex",
                          flexDirection: "column",
                          overflow: "hidden",
                        }}
                      >
                        {/* 过滤搜索栏 */}
                        <div
                          style={{
                            padding: "6px 8px",
                            borderBottom: "1px solid var(--border-color)",
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            background: "var(--bg-secondary)",
                          }}
                        >
                          <Search size={12} style={{ opacity: 0.5 }} />
                          <input
                            type="text"
                            style={{
                              flex: 1,
                              border: "none",
                              background: "transparent",
                              fontSize: 12,
                              color: "var(--text-primary)",
                              outline: "none",
                            }}
                            placeholder={t("aiCommit.searchModelPlaceholder")}
                            value={modelSearch}
                            onChange={(e) => setModelSearch(e.target.value)}
                            autoFocus
                          />
                          {modelSearch ? (
                            <button
                              type="button"
                              className="icon-button"
                              style={{ padding: 2, height: 16, width: 16 }}
                              onClick={() => setModelSearch("")}
                            >
                              <X size={11} />
                            </button>
                          ) : null}
                        </div>

                        {/* 候选列表 */}
                        <div style={{ flex: 1, overflowY: "auto", maxHeight: 200, padding: "4px 0" }}>
                          {availableModels.length === 0 ? (
                            <div
                              style={{
                                padding: "14px",
                                textAlign: "center",
                                fontSize: 12,
                                color: "var(--text-muted)",
                              }}
                            >
                              {fetchingModels ? (
                                <span>{t("aiCommit.fetchingModels")}</span>
                              ) : (
                                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                  <span>未获取到模型列表</span>
                                  <button
                                    type="button"
                                    className="button is-small"
                                    onClick={() => void handleFetchModels()}
                                  >
                                    立即请求 /v1/models
                                  </button>
                                </div>
                              )}
                            </div>
                          ) : filteredModels.length === 0 ? (
                            <div
                              style={{
                                padding: "10px 14px",
                                textAlign: "center",
                                fontSize: 12,
                                color: "var(--text-muted)",
                              }}
                            >
                              {t("aiCommit.noModelsFound")}
                            </div>
                          ) : (
                            filteredModels.map((m) => {
                              const isSelected = activeProvider.model === m;
                              return (
                                <div
                                  key={m}
                                  style={{
                                    padding: "6px 12px",
                                    fontSize: 12,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    cursor: "pointer",
                                    background: isSelected ? "var(--bg-secondary)" : "transparent",
                                    color: isSelected
                                      ? "var(--color-primary, #3b82f6)"
                                      : "var(--text-primary)",
                                    fontFamily: "var(--font-mono)",
                                  }}
                                  onMouseEnter={(e) => {
                                    e.currentTarget.style.background = "var(--bg-tertiary)";
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.background = isSelected
                                      ? "var(--bg-secondary)"
                                      : "transparent";
                                  }}
                                  onClick={() => {
                                    updateActiveProvider({ model: m });
                                    setModelDropdownOpen(false);
                                    setModelSearch("");
                                  }}
                                >
                                  <span
                                    style={{
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {m}
                                  </span>
                                  {isSelected ? <Check size={13} /> : null}
                                </div>
                              );
                            })
                          )}
                        </div>

                        {/* 底部信息栏 */}
                        {availableModels.length > 0 ? (
                          <div
                            style={{
                              padding: "4px 10px",
                              borderTop: "1px solid var(--border-color)",
                              fontSize: 11,
                              color: "var(--text-muted)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              background: "var(--bg-secondary)",
                            }}
                          >
                            <span>共 {availableModels.length} 个模型</span>
                            <span
                              style={{ cursor: "pointer", textDecoration: "underline" }}
                              onClick={() => void handleFetchModels()}
                            >
                              重新获取
                            </span>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  {/* 状态提示反馈 */}
                  {fetchSuccessTip ? (
                    <span
                      style={{
                        fontSize: 11.5,
                        color: "var(--color-success, #22c55e)",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <Check size={12} />
                      {fetchSuccessTip}
                    </span>
                  ) : null}
                  {fetchError ? (
                    <span style={{ fontSize: 11.5, color: "var(--color-danger, #ef4444)" }}>
                      {t("aiCommit.fetchModelsFailed")}: {fetchError}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="settings-row">
                <span className="settings-label">{t("aiCommit.apiKey")}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type={showApiKey ? "text" : "password"}
                    className="settings-input is-wide"
                    style={{ width: 280, fontFamily: "var(--font-mono)", fontSize: 12 }}
                    placeholder={t("aiCommit.apiKeyPlaceholder")}
                    value={activeProvider.apiKey}
                    onChange={(e) => updateActiveProvider({ apiKey: e.target.value })}
                  />
                  <button
                    type="button"
                    className="icon-button is-inline"
                    onClick={() => setShowApiKey((v) => !v)}
                    title={showApiKey ? "隐藏" : "显示"}
                  >
                    {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              {activeProvider.apiProtocol === "chatCompletions" ? (
                <div className="settings-row">
                  <span className="settings-label">{t("aiCommit.tokenLimitField")}</span>
                  <Select<ChatTokenLimitField>
                    className="is-wide"
                    label={t("aiCommit.tokenLimitField")}
                    placeholder="—"
                    value={activeProvider.chatTokenLimitField}
                    options={CHAT_TOKEN_LIMIT_FIELDS.map((f) => ({
                      value: f,
                      label: t(tokenLimitLabels[f]),
                    }))}
                    onChange={(field) => updateActiveProvider({ chatTokenLimitField: field })}
                  />
                </div>
              ) : null}

              <div className="settings-row">
                <span className="settings-label">{t("aiCommit.allowInsecureHttp")}</span>
                <Select<Switch>
                  label={t("aiCommit.allowInsecureHttp")}
                  placeholder="—"
                  value={activeProvider.allowsInsecureHttp ? "yes" : "no"}
                  options={[
                    { value: "yes", label: t("common.yes") },
                    { value: "no", label: t("common.no") },
                  ]}
                  onChange={(val) => updateActiveProvider({ allowsInsecureHttp: val === "yes" })}
                />
              </div>
            </div>
          ) : null}
        </>
      )}

      <div style={{ height: 1, background: "var(--border-color)", margin: "8px 0" }} />

      {/* 提交说明规则偏好 */}
      <h3 style={{ margin: "4px 0", fontSize: 13.5, fontWeight: 600 }}>{t("aiCommit.rules")}</h3>

      <div className="settings-row">
        <span className="settings-label">{t("aiCommit.language")}</span>
        <Select<"simplifiedChinese" | "english">
          label={t("aiCommit.language")}
          placeholder="—"
          value={config.language}
          options={[
            { value: "simplifiedChinese", label: t("aiCommit.language.simplifiedChinese") },
            { value: "english", label: t("aiCommit.language.english") },
          ]}
          onChange={(lang) => updateConfig({ language: lang })}
        />
      </div>

      <div className="settings-row">
        <span className="settings-label">{t("aiCommit.format")}</span>
        <Select<CommitFormat>
          className="is-wide"
          label={t("aiCommit.format")}
          placeholder="—"
          value={config.format}
          options={COMMIT_FORMATS.map((f) => ({ value: f, label: t(formatLabels[f]) }))}
          onChange={(format) => updateConfig({ format })}
        />
      </div>

      {config.format === "custom" ? (
        <div className="settings-row is-stack" style={{ alignItems: "flex-start" }}>
          <span className="settings-label">{t("aiCommit.customInstructions")}</span>
          <textarea
            className="settings-input is-wide"
            style={{ width: "100%", maxWidth: 500, height: 72, padding: "6px 8px", resize: "vertical" }}
            placeholder={t("aiCommit.customInstructionsPlaceholder")}
            value={config.customInstructions}
            onChange={(e) => updateConfig({ customInstructions: e.target.value })}
          />
        </div>
      ) : null}

      <div className="settings-row">
        <span className="settings-label">{t("aiCommit.includeBody")}</span>
        <Select<Switch>
          label={t("aiCommit.includeBody")}
          placeholder="—"
          value={config.includeBody ? "yes" : "no"}
          options={[
            { value: "yes", label: t("common.yes") },
            { value: "no", label: t("common.no") },
          ]}
          onChange={(val) => updateConfig({ includeBody: val === "yes" })}
        />
      </div>

      {/* 提交格式效果实时预览 */}
      <div
        style={{
          border: "1px solid var(--border-color)",
          borderRadius: "var(--radius-sm, 6px)",
          padding: "12px 14px",
          background: "var(--bg-secondary)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          margin: "6px 0 10px 0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Sparkles size={13} style={{ color: "var(--color-primary, #3b82f6)" }} />
            <span style={{ fontSize: 12, fontWeight: 600 }}>{t("aiCommit.formatPreview")}</span>
            <span
              style={{
                fontSize: 11,
                padding: "1px 6px",
                borderRadius: 4,
                background: "var(--bg-tertiary)",
                border: "1px solid var(--border-color)",
                color: "var(--text-secondary)",
              }}
            >
              {previewInfo.badge}
            </span>
          </div>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {previewInfo.description}
          </span>
        </div>
        <pre
          style={{
            margin: 0,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            padding: "8px 12px",
            background: "var(--bg-primary)",
            borderRadius: "var(--radius-xs, 4px)",
            border: "1px solid var(--border-color)",
            color: "var(--text-primary)",
          }}
        >
          {previewInfo.sample}
        </pre>
      </div>

      <div className="settings-row">
        <span className="settings-label">{t("aiCommit.subjectMaxLength")}</span>
        <input
          type="number"
          min={10}
          max={500}
          className="settings-input"
          style={{ width: 110 }}
          value={subjectMaxLenInput}
          onChange={(e) => {
            const raw = e.target.value;
            setSubjectMaxLenInput(raw);
            const val = parseInt(raw, 10);
            if (!isNaN(val) && val >= 10 && val <= 500) {
              updateConfig({ subjectMaximumLength: val });
            }
          }}
          onBlur={() => {
            const val = parseInt(subjectMaxLenInput, 10);
            const clamped = isNaN(val) ? 256 : Math.min(500, Math.max(10, val));
            setSubjectMaxLenInput(String(clamped));
            updateConfig({ subjectMaximumLength: clamped });
          }}
        />
      </div>

      <div className="settings-row">
        <span className="settings-label">{t("aiCommit.maxDiffChars")}</span>
        <input
          type="number"
          min={2000}
          max={1000000}
          step={5000}
          className="settings-input"
          style={{ width: 110 }}
          value={maxDiffCharsInput}
          onChange={(e) => {
            const raw = e.target.value;
            setMaxDiffCharsInput(raw);
            const val = parseInt(raw, 10);
            if (!isNaN(val) && val >= 2000 && val <= 1000000) {
              updateConfig({ maximumDiffCharacters: val });
            }
          }}
          onBlur={() => {
            const val = parseInt(maxDiffCharsInput, 10);
            const clamped = isNaN(val) ? 64000 : Math.min(1000000, Math.max(2000, val));
            setMaxDiffCharsInput(String(clamped));
            updateConfig({ maximumDiffCharacters: clamped });
          }}
        />
      </div>

      <div className="settings-row">
        <span className="settings-label">{t("aiCommit.reasoningEffort")}</span>
        <Select<CommitEffort>
          label={t("aiCommit.reasoningEffort")}
          placeholder="—"
          value={config.reasoningEffort}
          options={COMMIT_EFFORTS.map((e) => ({ value: e, label: t(effortLabels[e]) }))}
          onChange={(effort) => updateConfig({ reasoningEffort: effort })}
        />
      </div>

      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
        <button
          type="button"
          className="button is-primary"
          onClick={() => persistConfig(config)}
        >
          {t("aiCommit.saveConfig")}
        </button>
        {savedTip ? (
          <span
            style={{
              fontSize: 12,
              color: "var(--color-success, #22c55e)",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <Check size={14} />
            {t("aiCommit.saved")}
          </span>
        ) : null}
      </div>

      {/* 删除服务商确认弹窗 */}
      {providerToDelete ? (
        <div
          className="dialog-backdrop"
          onClick={() => setProviderToDelete(null)}
          role="presentation"
        >
          <div
            className="dialog"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 420 }}
          >
            <h3 className="dialog-title">{t("aiCommit.deleteConfirmTitle")}</h3>
            <p className="dialog-body">
              {t("aiCommit.deleteConfirmBody").replace(
                "{name}",
                providerToDelete.name || providerToDelete.id
              )}
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="button"
                onClick={() => setProviderToDelete(null)}
              >
                {t("dialog.cancel")}
              </button>
              <button
                type="button"
                className="button is-danger"
                autoFocus
                onClick={() => {
                  handleRemoveProvider(providerToDelete.id);
                  setProviderToDelete(null);
                }}
              >
                {t("dialog.delete")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </div>
  );
}
