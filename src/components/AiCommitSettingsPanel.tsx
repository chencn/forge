import { useEffect, useState } from "react";
import { Check, Sparkles } from "lucide-react";
import Select from "./Select";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/lang/zh";
import {
  CODEX_PROTOCOLS,
  COMMIT_EFFORTS,
  COMMIT_FORMATS,
  DEFAULT_AI_COMMIT_CONFIG,
  getCommitFormatPreview,
  listAiCommitModels,
  loadAiCommitConfig,
  saveAiCommitConfig,
  type AiCommitConfig,
  type AiCommitModel,
  type CodexProtocol,
  type CommitEffort,
  type CommitFormat,
} from "../lib/aiCommit";
import { AI_NAMES } from "../lib/aiCli";
import { loadModelProviders } from "../lib/aiManage";
import type { ModelProvider } from "../lib/aiManage";
import { describeError } from "../lib/errors";

/** 布尔下拉的候选值。 */
const SWITCHES = ["yes", "no"] as const;
/** {@link SWITCHES} 的成员类型。 */
type Switch = (typeof SWITCHES)[number];

/** AI 提交设置页的入参。 */
interface Props {
  /** 打开设置里的「模型供应商」页；供应商为空或失效时由这里引导用户去配置 */
  onOpenProviders: () => void;
}

/**
 * AI 智能提交设置页：选模型供应商与模型，再调写作规则与各项上限。
 *
 * 地址、密钥与协议不在这里维护——它们属于设置里的模型供应商；模型可选项来自
 * 该供应商自己的槽位（claude）或目录投影（codex），留空即沿用供应商的默认模型。
 * 协议按供应商类型推导：claude 走 Anthropic Messages，codex 走 Responses。
 */
export default function AiCommitSettingsPanel({ onOpenProviders }: Props) {
  const { t } = useI18n();
  const [config, setConfig] = useState<AiCommitConfig>(DEFAULT_AI_COMMIT_CONFIG);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  /** 供应商清单是否已加载完；加载前不显示「未配置」，免得先闪一下误导用户。 */
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [savedTip, setSavedTip] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [subjectMaxLenInput, setSubjectMaxLenInput] = useState(String(DEFAULT_AI_COMMIT_CONFIG.subjectMaximumLength));
  const [maxDiffCharsInput, setMaxDiffCharsInput] = useState(String(DEFAULT_AI_COMMIT_CONFIG.maximumDiffCharacters));
  const [maxOutputTokensInput, setMaxOutputTokensInput] = useState(String(DEFAULT_AI_COMMIT_CONFIG.maximumOutputTokens));
  /** 当前供应商的候选模型；null 表示还在读取，空数组表示这个供应商没有可选模型。 */
  const [models, setModels] = useState<AiCommitModel[] | null>(null);

  useEffect(() => {
    let alive = true;
    loadAiCommitConfig()
      .then((loaded) => {
        if (!alive) return;
        setConfig(loaded);
        setSubjectMaxLenInput(String(loaded.subjectMaximumLength));
        setMaxDiffCharsInput(String(loaded.maximumDiffCharacters));
        setMaxOutputTokensInput(String(loaded.maximumOutputTokens));
      })
      .catch(() => {
        // 加载失败时沿用默认配置
      });
    loadModelProviders()
      .then((list) => {
        if (alive) setProviders(list);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setProvidersLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 供应商换了就重取模型清单；读不到只影响这一档，不阻塞其余设置项。
  useEffect(() => {
    const providerId = config.providerId;
    if (!providerId) {
      setModels(null);
      return;
    }
    let alive = true;
    setModels(null);
    listAiCommitModels(providerId)
      .then((list) => {
        if (alive) setModels(list);
      })
      .catch(() => {
        if (alive) setModels([]);
      });
    return () => {
      alive = false;
    };
  }, [config.providerId]);

  /** 没显式选过模型时，界面停在供应商的默认模型上。 */
  const defaultModelId = models?.find((model) => model.isDefault)?.id ?? models?.[0]?.id ?? null;
  /** 当前选中的供应商；只有 codex 类型才需要选接口协议。 */
  const selectedProvider = providers.find((provider) => provider.id === config.providerId) ?? null;

  const persistConfig = (next: AiCommitConfig) => {
    setConfig(next);
    setSaveError(null);
    void saveAiCommitConfig(next)
      .then(() => {
        setSavedTip(true);
        setTimeout(() => setSavedTip(false), 2000);
      })
      .catch((cause: unknown) => {
        // 保存失败不能静默：界面亮着新值、磁盘还是旧值，重启后会悄悄弹回。
        // 回滚取磁盘上的权威值而不是上次内存快照——连续改动时中间态可能已被
        // 另一次在飞的保存覆盖，previous 未必是用户最后认可的那份。
        void loadAiCommitConfig()
          .then((authoritative) => setConfig(authoritative))
          .catch(() => {});
        setSaveError(t("aiCommit.saveFailed", { detail: describeError(typeof cause === "string" ? cause : String(cause), t) }));
      });
  };

  const updateConfig = (patch: Partial<AiCommitConfig>) => {
    const next = { ...config, ...patch };
    persistConfig(next);
  };

  /** 选中的供应商已被删除；只在清单加载完后判定，避免开头误报。 */
  const providerMissing =
    providersLoaded && config.providerId !== null && !providers.some((provider) => provider.id === config.providerId);
  const providersEmpty = providersLoaded && providers.length === 0;

  const formatLabels: Record<CommitFormat, TranslationKey> = {
    conventional: "aiCommit.format.conventional",
    concise: "aiCommit.format.concise",
    imperative: "aiCommit.format.imperative",
    descriptive: "aiCommit.format.descriptive",
    releaseNote: "aiCommit.format.releaseNote",
    custom: "aiCommit.format.custom",
  };

  const effortLabels: Record<CommitEffort, TranslationKey> = {
    default: "aiCommit.reasoning.default",
    none: "aiCommit.reasoning.none",
    minimal: "aiCommit.reasoning.minimal",
    low: "aiCommit.reasoning.low",
    medium: "aiCommit.reasoning.medium",
    high: "aiCommit.reasoning.high",
  };

  const previewInfo = getCommitFormatPreview(
    config.format,
    config.language,
    config.includeBody,
    config.customInstructions
  );

  return (
    <div className="settings-rows is-ai-commit">
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

      {/* 模型供应商：地址、密钥与模型都取自设置里的同名配置 */}
      <h3 style={{ margin: "4px 0", fontSize: 13.5, fontWeight: 600, color: "var(--fg-strong)" }}>
        {t("aiCommit.modelProvider")}
      </h3>
      <p style={{ margin: "0 0 6px", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
        {t("aiCommit.modelProviderHint")}
      </p>

      <div className="settings-row">
        <span className="settings-label">{t("aiCommit.modelProvider")}</span>
        <Select<string>
          className="is-wide"
          label={t("aiCommit.modelProvider")}
          placeholder={t("aiCommit.noProvider")}
          value={config.providerId}
          options={providers.map((provider) => ({
            value: provider.id,
            label: provider.name || t("providers.untitled"),
            detail: `${AI_NAMES[provider.kind]} · ${provider.apiUrl}`,
          }))}
          onChange={(id) => updateConfig({ providerId: id, model: null })}
        />
      </div>

      {/* 模型：候选来自供应商自身的槽位或目录投影，留空即用供应商默认 */}
      {config.providerId && !providerMissing ? (
        <div className="settings-row">
          <span className="settings-label">{t("aiCommit.model")}</span>
          {models === null ? (
            <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{t("aiCommit.modelLoading")}</span>
          ) : models.length === 0 ? (
            <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{t("aiCommit.modelUnavailable")}</span>
          ) : (
            <Select<string>
              className="is-wide"
              label={t("aiCommit.model")}
              placeholder={t("aiCommit.model")}
              value={config.model ?? defaultModelId}
              options={models.map((model) => ({
                value: model.id,
                label: model.isDefault ? t("aiCommit.modelDefault", { name: model.name }) : model.name,
                detail: model.name === model.id ? undefined : model.id,
              }))}
              onChange={(id) => updateConfig({ model: id })}
            />
          )}
        </div>
      ) : null}

      {/* 接口协议：只对 codex 类型可见；codex CLI 侧固定 Responses，这里的切换只影响提交请求 */}
      {selectedProvider?.kind === "codex" ? (
        <div className="settings-row">
          <span className="settings-label">{t("aiCommit.codexProtocol")}</span>
          <Select<CodexProtocol>
            label={t("aiCommit.codexProtocol")}
            placeholder="—"
            value={config.codexProtocol}
            options={CODEX_PROTOCOLS.map((protocol) => ({
              value: protocol,
              label: t(protocol === "chatCompletions" ? "aiCommit.codexProtocol.chatCompletions" : "aiCommit.codexProtocol.responses"),
            }))}
            onChange={(protocol) => updateConfig({ codexProtocol: protocol })}
          />
        </div>
      ) : null}

      {providersEmpty || providerMissing ? (
        <div
          style={{
            border: "1px dashed var(--border-color)",
            borderRadius: "var(--radius-sm, 6px)",
            padding: "10px 14px",
            background: "var(--bg-secondary)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
            {t(providersEmpty ? "aiCommit.modelProviderEmpty" : "aiCommit.modelProviderMissing")}
          </span>
          <button type="button" className="button is-small" onClick={onOpenProviders}>
            {t("aiCommit.manageProviders")}
          </button>
        </div>
      ) : null}

      <div style={{ height: 1, background: "var(--border-color)", margin: "8px 0" }} />

      {/* 提交说明规则偏好 */}
      <h3 style={{ margin: "4px 0", fontSize: 13.5, fontWeight: 600, color: "var(--fg-strong)" }}>{t("aiCommit.rules")}</h3>

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
            <Sparkles size={13} style={{ color: "var(--fg-secondary)" }} />
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
          min={0}
          aria-label={t("aiCommit.subjectMaxLength")}
          className="settings-input"
          style={{ width: 110 }}
          value={subjectMaxLenInput}
          onChange={(e) => {
            const raw = e.target.value;
            setSubjectMaxLenInput(raw);
            const val = Number(raw);
            if (raw.trim() && Number.isSafeInteger(val) && val >= 0) {
              updateConfig({ subjectMaximumLength: val });
            }
          }}
          onBlur={() => {
            // 非法编辑恢复当前已保存值，不能把用户的大预算悄悄重置成小预算。
            setSubjectMaxLenInput(String(config.subjectMaximumLength));
          }}
        />
      </div>

      <div className="settings-row">
        <span className="settings-label">{t("aiCommit.maxDiffChars")}</span>
        <input
          type="number"
          min={0}
          aria-label={t("aiCommit.maxDiffChars")}
          className="settings-input"
          style={{ width: 110 }}
          value={maxDiffCharsInput}
          onChange={(e) => {
            const raw = e.target.value;
            setMaxDiffCharsInput(raw);
            const val = Number(raw);
            if (raw.trim() && Number.isSafeInteger(val) && val >= 0) {
              updateConfig({ maximumDiffCharacters: val });
            }
          }}
          onBlur={() => {
            setMaxDiffCharsInput(String(config.maximumDiffCharacters));
          }}
        />
      </div>

      <div className="settings-row">
        <span className="settings-label">{t("aiCommit.maxOutputTokens")}</span>
        <input
          type="number"
          min={0}
          aria-label={t("aiCommit.maxOutputTokens")}
          title={t("aiCommit.maxOutputTokensHint")}
          className="settings-input"
          style={{ width: 110 }}
          value={maxOutputTokensInput}
          onChange={(e) => {
            const raw = e.target.value;
            setMaxOutputTokensInput(raw);
            const val = Number(raw);
            if (raw.trim() && Number.isSafeInteger(val) && val >= 0) {
              updateConfig({ maximumOutputTokens: val });
            }
          }}
          onBlur={() => setMaxOutputTokensInput(String(config.maximumOutputTokens))}
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
              color: "var(--success)",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <Check size={14} />
            {t("aiCommit.saved")}
          </span>
        ) : null}
        {saveError ? (
          <span style={{ fontSize: 12, color: "var(--danger)" }}>{saveError}</span>
        ) : null}
      </div>
      </div>
    </div>
  );
}
