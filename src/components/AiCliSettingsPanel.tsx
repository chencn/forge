import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  FileCode2,
  GripVertical,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Send,
  Trash2,
  XCircle,
} from "lucide-react";
import { useI18n } from "../i18n";
import { loadAiCustomModels, removeAiCustomModel, saveAiCustomModel } from "../lib/aiRuntime";
import { IS_WINDOWS } from "../lib/sys";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard";
import { useSettings } from "../hooks/useSettings";
import {
  AI_NAMES,
  CODEX_APPROVAL_POLICIES,
  CODEX_INHERIT_VALUES,
  CODEX_PERSISTENCE_VALUES,
  CODEX_SANDBOX_MODES,
  CODEX_SUMMARY_VALUES,
  CODEX_VERBOSITY_VALUES,
  CODEX_WEB_SEARCH_VALUES,
  CODEX_WINDOWS_SANDBOX_VALUES,
  RESERVED_AI_CLI_ENV,
  aiCliEnvText,
  canManageCli,
  claudeAuthModeOf,
  cliDesktopAvailable,
  codexAuthModeOf,
  manageAiCli,
  orderedAiProviders,
  parseAiCliEnvText,
  patchAiCliEnvText,
  readAiCliClaudeSettings,
  readAiCliCodexSettings,
  readAiCliConfig,
  refreshAiCli,
  refreshAiCliSettings,
  refreshAiCliUpdates,
  reorderAiCliAgents,
  runAiCliDiagnostics,
  saveAiCliClaudeSettings,
  saveAiCliCodexSettings,
  saveAiCliConfig,
  updateAiCliAgent,
  useAiCli,
  useAiCliSettings,
  validateAiCliEnv,
} from "../lib/aiCli";
import type {
  AiCliAction,
  AiCliCheck,
  AiCliClaudeSettings,
  AiCliCodexGranular,
  AiCliCodexSettings,
  AiCliConfigFile,
  AiProvider,
  ClaudeAuthMode,
  CodexAuthMode,
} from "../lib/aiCli";
import { applyModelProvider, loadModelProviders } from "../lib/aiManage";
import {
  codexModelEfforts,
  emptyCodexCatalogIntent,
  normalizeCodexCatalogIntent,
  readAiCliCodexCatalog,
  saveAiCliCodexCatalog,
} from "../lib/aiManage";
import type { CodexCatalogIntent, CodexCatalogView, ModelProvider } from "../lib/aiManage";
import CodexCatalogSection from "./CodexCatalogSection";
import Select from "./Select";
import AiActionDialog from "./AiActionDialog";
import { hasAiRuns, stopAllAiRuns } from "../lib/aiRuntime";
import AiProviderIcon from "./AiProviderIcon";
import type { TranslationKey } from "../i18n/lang/zh";

/** AI 助手页标题栏只负责重新检测；总开关属于应用级设置，放在「通用」。 */
export function AiCliSettingsControls() {
  const { t } = useI18n();
  const { settings } = useSettings();
  const cli = useAiCli();
  if (!settings.aiAssistantsEnabled) return null;
  return <div className="ai-settings-controls">
    <button type="button" className="icon-button is-inline"
      disabled={!cliDesktopAvailable() || cli.checking || cli.operation !== null}
      onClick={() => void refreshAiCli(true).then(refreshAiCliUpdates)} title={t("ai.check")} aria-label={t("ai.check")}>
      {cli.checking ? <Loader2 size={14} className="is-spinning" /> : <RefreshCw size={14} />}
    </button>
  </div>;
}

/**
 * 「通用」里的 AI 总开关。关闭时若仍有会话运行，必须先停止进程再落设置，
 * 不能只把导航和活动栏藏掉后留下后台任务。
 */
export function AiAssistantsToggle() {
  const { t } = useI18n();
  const { settings, patch } = useSettings();
  const cli = useAiCli();
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);
  const disable = async () => {
    setDisabling(true); setDisableError(null);
    try { await stopAllAiRuns(); patch({ aiAssistantsEnabled: false }); setConfirmDisable(false); }
    catch (error) { setDisableError(String(error)); }
    finally { setDisabling(false); }
  };
  return <div className="ai-settings-controls">
    <button type="button" role="switch" className="ai-enable-switch"
      aria-checked={settings.aiAssistantsEnabled} aria-label={t("ai.enable")}
      title={t(cli.operation ? "ai.operationRunning" : "ai.enable")}
      disabled={cli.operation !== null || disabling}
      onClick={() => {
        if (settings.aiAssistantsEnabled && hasAiRuns()) { setConfirmDisable(true); return; }
        patch({ aiAssistantsEnabled: !settings.aiAssistantsEnabled });
      }}>
      <span />
    </button>
    {confirmDisable ? <AiActionDialog title={t("ai.lifecycle.disableTitle")} confirm={t("ai.lifecycle.stopDisable")} danger
      onCancel={() => { if (!disabling) setConfirmDisable(false); }} onConfirm={() => { if (!disabling) void disable(); }}>
      <p className="dialog-body">{t("ai.lifecycle.disableHint")}</p>
      {disableError ? <p className="ai-error" role="alert">{disableError}</p> : null}
      {disabling ? <p role="status">{t("ai.lifecycle.stopping")}</p> : null}
    </AiActionDialog> : null}
  </div>;
}

/**
 * 设置页的 AI 助手模块。功能关闭时整块不渲染——关闭状态下不该出现任何安装入口。
 */
export default function AiCliSettingsPanel() {
  const { settings } = useSettings();
  return settings.aiAssistantsEnabled ? <EnabledAiCliSettingsPanel /> : null;
}

const CHECK_LABEL: Record<string, TranslationKey> = {
  binary: "ai.checks.binary",
  version: "ai.checks.version",
  node: "ai.checks.node",
  npm: "ai.checks.npm",
  config: "ai.checks.config",
  env: "ai.checks.env",
  latest: "ai.checks.latest",
  conflict: "ai.checks.conflict",
};

/** Claude Code 的模型环境变量；留空即使用 CLI 自己的默认模型。 */
const CLAUDE_MODEL_FIELDS: { key: string; label: TranslationKey; placeholder: string }[] = [
  { key: "ANTHROPIC_MODEL", label: "ai.cfg.claudeMain", placeholder: "claude-sonnet-4-5" },
  { key: "ANTHROPIC_REASONING_MODEL", label: "ai.cfg.claudeReasoning", placeholder: "claude-opus-4-1" },
  { key: "ANTHROPIC_DEFAULT_HAIKU_MODEL", label: "ai.cfg.claudeHaiku", placeholder: "claude-haiku-4-5" },
  { key: "ANTHROPIC_DEFAULT_SONNET_MODEL", label: "ai.cfg.claudeSonnet", placeholder: "claude-sonnet-4-5" },
  { key: "ANTHROPIC_DEFAULT_OPUS_MODEL", label: "ai.cfg.claudeOpus", placeholder: "claude-opus-4-1" },
  { key: "ANTHROPIC_DEFAULT_FABLE_MODEL", label: "ai.cfg.claudeFable", placeholder: "claude-fable-5-1" },
];

const CLAUDE_CUSTOM_MODEL_FIELDS: { key: string; label: TranslationKey; placeholder: string }[] = [
  { key: "ANTHROPIC_CUSTOM_MODEL_OPTION", label: "ai.cfg.customOptionId", placeholder: "my-gateway/claude-opus-4-1" },
  { key: "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME", label: "ai.cfg.customOptionName", placeholder: "Gateway Opus" },
  { key: "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION", label: "ai.cfg.customOptionDescription", placeholder: "Routed via custom gateway" },
];

/** 配置管理块托管的变量：保存时写回原生 settings.json，并从 Forge 覆盖层移除同名键，避免两处各说一套。 */
const CLAUDE_MANAGED_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  ...CLAUDE_MODEL_FIELDS.map((field) => field.key),
  ...CLAUDE_CUSTOM_MODEL_FIELDS.map((field) => field.key),
];

/** 三档认证方式的标签与说明；第三档共用「绑定模型供应商」。 */
const CLAUDE_MODE_LABEL: Record<ClaudeAuthMode, TranslationKey> = {
  official: "ai.cfg.claudeOfficial",
  custom: "ai.cfg.claudeCustom",
  provider: "ai.cfg.modeProvider",
};
const CLAUDE_MODE_HINT: Record<ClaudeAuthMode, TranslationKey> = {
  official: "ai.cfg.claudeOfficialHint",
  custom: "ai.cfg.claudeCustomHint",
  provider: "ai.cfg.providerHint",
};
const CODEX_MODE_LABEL: Record<CodexAuthMode, TranslationKey> = {
  subscription: "ai.cfg.codexSubscription",
  api_key: "ai.cfg.codexApiKey",
  provider: "ai.cfg.modeProvider",
};
const CODEX_MODE_HINT: Record<CodexAuthMode, TranslationKey> = {
  subscription: "ai.cfg.codexSubscriptionHint",
  api_key: "ai.cfg.codexApiKeyHint",
  provider: "ai.cfg.providerHint",
};

const CODEX_GRANULAR_FIELDS: { key: keyof AiCliCodexGranular; label: TranslationKey }[] = [  { key: "sandboxApproval", label: "ai.cfg.granularSandboxApproval" },
  { key: "rules", label: "ai.cfg.granularRules" },
  { key: "skillApproval", label: "ai.cfg.granularSkillApproval" },
  { key: "requestPermissions", label: "ai.cfg.granularRequestPermissions" },
  { key: "mcpElicitations", label: "ai.cfg.granularMcpElicitations" },
];

const CODEX_SUMMARY_LABELS: Record<string, TranslationKey> = {
  auto: "ai.cfg.summary.auto", concise: "ai.cfg.summary.concise",
  detailed: "ai.cfg.summary.detailed", none: "ai.cfg.summary.none",
};
const CODEX_VERBOSITY_LABELS: Record<string, TranslationKey> = {
  low: "ai.cfg.verbosity.low", medium: "ai.cfg.verbosity.medium", high: "ai.cfg.verbosity.high",
};
const CODEX_WEB_SEARCH_LABELS: Record<string, TranslationKey> = {
  disabled: "ai.cfg.webSearch.disabled", cached: "ai.cfg.webSearch.cached",
  indexed: "ai.cfg.webSearch.indexed", live: "ai.cfg.webSearch.live",
};
const CODEX_INHERIT_LABELS: Record<string, TranslationKey> = {
  core: "ai.cfg.inherit.core", all: "ai.cfg.inherit.all", none: "ai.cfg.inherit.none",
};
const CODEX_PERSISTENCE_LABELS: Record<string, TranslationKey> = {
  "save-all": "ai.cfg.persistence.save-all", none: "ai.cfg.persistence.none",
};
const CODEX_WINDOWS_SANDBOX_LABELS: Record<string, TranslationKey> = {
  elevated: "ai.cfg.winSandbox.elevated", unelevated: "ai.cfg.winSandbox.unelevated", mxc: "ai.cfg.winSandbox.mxc",
};

/** Codex 会把相对路径解析到 CODEX_HOME，所以只接受绝对路径。 */
function isAbsoluteRoot(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

/** 枚举下拉：先给「不设置」，其余值直接用 TOML 里写的那个词，有译名就显示译名。 */
function codexEnumOptions(values: readonly string[], labels: Partial<Record<string, TranslationKey>>, current: string, t: (key: TranslationKey) => string) {
  const list = [...values];
  // 文件里可能是新版 Codex 才有的值：列出来才能原样保存回去，而不是被下拉悄悄改掉。
  if (current !== "" && !list.includes(current)) list.unshift(current);
  return [{ value: "", label: t("ai.cfg.codexDefault") },
    ...list.map((value) => ({ value, label: labels[value] ? t(labels[value] as TranslationKey) : value }))];
}

/** 一个 Codex 枚举设置：标签 + 下拉 + 可选说明。 */
function CodexEnumField(props: {
  label: string;
  hint?: string;
  value: string;
  values: readonly string[];
  labels?: Partial<Record<string, TranslationKey>>;
  disabled?: boolean;
  onPick: (value: string) => void;
}) {
  const { t } = useI18n();
  return <label className="ai-cli-field">
    <span>{props.label}</span>
    <Select value={props.value} label={props.label} placeholder={t("ai.cfg.codexDefault")} disabled={props.disabled}
      options={codexEnumOptions(props.values, props.labels ?? {}, props.value, t)}
      onChange={(value) => props.onPick(value)} />
    {props.hint ? <em className="ai-cli-hint">{props.hint}</em> : null}
  </label>;
}

/** 数值设置：留空表示不写这个键。 */
function CodexNumberField(props: { label: string; hint?: string; value: number | null; onPick: (value: number | null) => void }) {
  const { t } = useI18n();
  return <label className="ai-cli-field">
    <span>{props.label}</span>
    <input className="text-input" type="number" min={1} step={1000} spellCheck={false}
      value={props.value === null ? "" : String(props.value)} placeholder={t("ai.cfg.codexDefault")}
      onChange={(event) => {
        const raw = event.target.value.trim();
        const number = Number(raw);
        props.onPick(raw === "" || !Number.isFinite(number) ? null : Math.max(0, Math.trunc(number)));
      }} />
    {props.hint ? <em className="ai-cli-hint">{props.hint}</em> : null}
  </label>;
}

type CheckTone = "pass" | "warn" | "fail" | "checking" | "unchecked" | "disabled";

function CheckIcon({ status }: { status: AiCliCheck["status"] }) {
  if (status === "pass") return <CheckCircle2 size={13} className="ai-cli-check-icon is-pass" />;
  if (status === "warn") return <AlertTriangle size={13} className="ai-cli-check-icon is-warn" />;
  return <XCircle size={13} className="ai-cli-check-icon is-fail" />;
}

/** 比较用的快照：只看键值集合，顺序和格式不影响「是否改动过」。 */
const envSnapshot = (env: Record<string, string>) =>
  JSON.stringify(Object.entries(env).sort(([left], [right]) => left.localeCompare(right)));

/** 「绑定模型供应商」那一档的选择器 + 应用按钮，两个 CLI 共用。 */
function ProviderPicker({ boundId, choices, applying, missing, onPick, onApply }: {
  boundId: string;
  choices: ModelProvider[];
  applying: boolean;
  missing: boolean;
  onPick: (id: string) => void;
  onApply: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="ai-cli-field">
      <span>{t("ai.cfg.providerPick")}</span>
      {choices.length ? (
        <Select value={boundId} label={t("ai.cfg.providerPick")} placeholder={t("ai.cfg.providerPick")}
          options={choices.map((item) => ({ value: item.id, label: item.name || t("providers.untitled") }))}
          onChange={onPick} />
      ) : (
        <p className="ai-cli-hint">{t("ai.cfg.providerEmpty")}</p>
      )}
      {missing ? <em className="ai-cli-warning" role="alert">{t("ai.cfg.providerMissing")}</em> : null}
      {boundId ? (
        <em className="ai-cli-hint">{t("ai.cfg.providerApplyHint")}</em>
      ) : null}
      {boundId ? (
        <button type="button" className="lsp-action" disabled={applying} onClick={onApply}>
          {applying ? <Loader2 size={13} className="is-spinning" /> : <Send size={13} />}
          {t("ai.cfg.providerApply")}
        </button>
      ) : null}
    </div>
  );
}

/**
 * 启用后的 CLI 管理面板：左边是列表（排序、启停、检查状态），右边是选中 CLI 的详情。
 *
 * 安装状态与联网查询仍由 `useAiCli` 负责；启停、顺序、环境变量来自独立的设置 store；
 * 本地检查与原生配置每次只针对当前选中的 CLI 读取，避免一进页面就把两个 CLI 的
 * 配置文件都读一遍。
 */
function EnabledAiCliSettingsPanel() {
  const { t } = useI18n();
  const cli = useAiCli();
  const store = useAiCliSettings();
  const desktop = cliDesktopAvailable();
  const [selected, setSelected] = useState<AiProvider | null>(null);
  const [envDrafts, setEnvDrafts] = useState<Partial<Record<AiProvider, string>>>({});
  const [envSaving, setEnvSaving] = useState<AiProvider | null>(null);
  const [envNotice, setEnvNotice] = useState<{ provider: AiProvider; error: boolean; text: string } | null>(null);
  const [checks, setChecks] = useState<Partial<Record<AiProvider, AiCliCheck[]>>>({});
  const [checking, setChecking] = useState<Partial<Record<AiProvider, boolean>>>({});
  const [files, setFiles] = useState<Partial<Record<AiProvider, AiCliConfigFile>>>({});
  const [fileDrafts, setFileDrafts] = useState<Partial<Record<AiProvider, string>>>({});
  // 原生配置默认展开（对照 codeg 的原始配置编辑器）；收起仍然可用。
  const [fileOpen, setFileOpen] = useState<Partial<Record<AiProvider, boolean>>>({ claude: true, codex: true });
  const [fileBusy, setFileBusy] = useState<AiProvider | null>(null);
  const [fileNotice, setFileNotice] = useState<{ provider: AiProvider; error: boolean; text: string } | null>(null);
  const [dragging, setDragging] = useState<AiProvider | null>(null);
  /** 已点下、等待确认的管理动作；非空时弹出确认框。 */
  const [pending, setPending] = useState<{ provider: AiProvider; action: AiCliAction } | null>(null);
  const [codexDraft, setCodexDraft] = useState<AiCliCodexSettings | null>(null);
  /** 结构化字段最近一次从磁盘读回 / 存盘的快照；和草稿不一致就是没保存。 */
  const [codexBaseline, setCodexBaseline] = useState<string | null>(null);
  const [codexLoading, setCodexLoading] = useState(() => cliDesktopAvailable());
  const [codexSaving, setCodexSaving] = useState(false);
  const [claudeConfig, setClaudeConfig] = useState<AiCliClaudeSettings | null>(null);
  const [claudeBaseline, setClaudeBaseline] = useState<string | null>(null);
  const [claudeLoading, setClaudeLoading] = useState(() => cliDesktopAvailable());
  /** 认证方式是显式选择：不能从环境变量实时推导，否则选 custom 会立刻被弹回 official。 */
  const [claudeMode, setClaudeMode] = useState<ClaudeAuthMode | null>(null);
  const [codexMode, setCodexMode] = useState<CodexAuthMode | null>(null);
  const [manageNotice, setManageNotice] = useState<{ provider: AiProvider; error: boolean; text: string } | null>(null);
  const [secretShown, setSecretShown] = useState<Partial<Record<AiProvider, boolean>>>({});
  /** 「绑定模型供应商」这一档要列出已保存的供应商；和供应商页共用同一份存储。 */
  const [providerOptions, setProviderOptions] = useState<ModelProvider[]>([]);
  const [applyingProvider, setApplyingProvider] = useState(false);
  /** Codex 模型清单：view 是后端合并后的真相，draft 是界面上还没保存的意图。 */
  const [catalog, setCatalog] = useState<CodexCatalogView | null>(null);
  const [catalogDraft, setCatalogDraft] = useState<CodexCatalogIntent>(emptyCodexCatalogIntent);
  const [catalogBaseline, setCatalogBaseline] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(() => cliDesktopAvailable());
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogNotice, setCatalogNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [catalogToken, setCatalogToken] = useState(0);
  /** 会话模型列表里的自定义 ID：全局存储，和自动发现的 CLI 目录分开。 */
  const [customModels, setCustomModels] = useState<Partial<Record<AiProvider, string[]>>>({});
  const [customDraft, setCustomDraft] = useState("");
  const [customBusy, setCustomBusy] = useState(false);
  const [customNotice, setCustomNotice] = useState<{ provider: AiProvider; error: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!cliDesktopAvailable()) return;
    let active = true;
    loadModelProviders()
      .then((list) => { if (active) setProviderOptions(list); })
      // 读不到供应商不影响其余配置区块，只是这一档没有可选项。
      .catch(() => { if (active) setProviderOptions([]); });
    return () => { active = false; };
  }, []);

  const ordered = useMemo(() => orderedAiProviders(store.settings), [store.settings]);
  // 默认停在第一个已安装的 CLI 上；都没装时也至少有详情可看，而不是空面板。
  const current = selected ?? ordered.find((provider) => cli.statuses[provider]?.installed) ?? ordered[0] ?? null;
  const status = current ? cli.statuses[current] : undefined;
  const agent = current ? store.settings.agents[current] : undefined;
  const busy = cli.checking || cli.operation !== null || store.saving;

  // 两套数据各自只加载一次；之后的刷新交给用户按钮。
  useEffect(() => { void refreshAiCliSettings(); }, []);
  useEffect(() => { if (!cli.checked) void refreshAiCli(); }, [cli.checked]);
  useEffect(() => { if (cli.checked) void refreshAiCliUpdates(); }, [cli.checked]);

  const loadChecks = useCallback(async (provider: AiProvider) => {
    if (!cliDesktopAvailable()) return;
    setChecking((value) => ({ ...value, [provider]: true }));
    try {
      const result = await runAiCliDiagnostics(provider);
      setChecks((value) => ({ ...value, [provider]: result }));
    } catch (error) {
      setChecks((value) => ({ ...value, [provider]: [{ id: "binary", status: "fail", value: null, hint: String(error) }] }));
    } finally {
      setChecking((value) => ({ ...value, [provider]: false }));
    }
  }, []);

  // 切换选中项只检查当前 CLI；检查本身不联网，开销可控。
  useEffect(() => { if (current) void loadChecks(current); }, [current, loadChecks]);

  // Codex 的结构化字段只在第一次打开它的详情时读磁盘；之后保留草稿，切换 CLI 不丢未保存的修改。
  useEffect(() => {
    if (current !== "codex" || !cliDesktopAvailable() || codexDraft) return;
    let active = true;
    setCodexLoading(true);
    readAiCliCodexSettings()
      .then((value) => {
        if (!active) return;
        setCodexDraft(value);
        setCodexBaseline(JSON.stringify(value));
        setCodexMode(codexAuthModeOf(value));
      })
      .catch((error) => { if (active) setManageNotice({ provider: "codex", error: true, text: `${t("ai.cfg.loadFailed")} ${String(error)}` }); })
      .finally(() => { if (active) setCodexLoading(false); });
    return () => { active = false; };
  }, [current, codexDraft, t]);

  // Claude 的认证与模型直接读原生 settings.json，首次打开详情时加载一次。
  useEffect(() => {
    if (current !== "claude" || !cliDesktopAvailable() || claudeConfig) return;
    let active = true;
    setClaudeLoading(true);
    readAiCliClaudeSettings()
      .then((value) => {
        if (!active) return;
        // 读取期间用户可能已经改了草稿：保留草稿里的键，其余用刚读到的原生值补齐。
        setClaudeConfig((config) => config
          ? { ...value, env: { ...value.env, ...config.env } }
          : value);
        setClaudeBaseline(envSnapshot(value.env));
        setClaudeMode((mode) => mode ?? claudeAuthModeOf(value.env));
      })
      .catch((error) => { if (active) setManageNotice({ provider: "claude", error: true, text: `${t("ai.cfg.loadFailed")} ${String(error)}` }); })
      .finally(() => { if (active) setClaudeLoading(false); });
    return () => { active = false; };
  }, [current, claudeConfig, t]);

  // Codex 的模型清单要起一次 CLI 调用（`codex debug models`），只在打开 Codex 详情时读一次。
  useEffect(() => {
    if (current !== "codex" || !cliDesktopAvailable()) return;
    let active = true;
    setCatalogLoading(true);
    readAiCliCodexCatalog()
      .then((value) => {
        if (!active) return;
        setCatalog(value);
        setCatalogDraft(value.intent);
        setCatalogBaseline(normalizeCodexCatalogIntent(value.intent));
      })
      .catch((error) => {
        if (active) {
          setCatalog(null);
          setCatalogNotice({ error: true, text: t("ai.catalog.loadFailed", { message: String(error) }) });
        }
      })
      .finally(() => { if (active) setCatalogLoading(false); });
    return () => { active = false; };
  }, [current, catalogToken, t]);

  const runCatalogSave = async (intent: CodexCatalogIntent) => {
    if (catalogBusy) return;
    setCatalogBusy(true); setCatalogNotice(null);
    try {
      const next = await saveAiCliCodexCatalog(intent);
      setCatalog(next);
      setCatalogDraft(next.intent);
      setCatalogBaseline(normalizeCodexCatalogIntent(next.intent));
      // 清单落盘会给 config.toml 加/删一行，原生配置编辑器里的那份快照已经过时。
      if (fileOpen.codex) {
        const loaded = files.codex?.content;
        const rawDraft = fileDrafts.codex;
        try {
          const fresh = await readAiCliConfig("codex");
          setFiles((value) => ({ ...value, codex: fresh }));
          setFileDrafts((value) => rawDraft === loaded || loaded === undefined ? { ...value, codex: fresh.content } : value);
        } catch { /* 编辑器保持原样，用户可自行重新加载。 */ }
      }
      await loadChecks("codex");
      setCatalogNotice({ error: false, text: t("ai.catalog.saved") });
    } catch (error) {
      setCatalogNotice({ error: true, text: t("ai.catalog.saveFailed", { message: String(error) }) });
    } finally { setCatalogBusy(false); }
  };

  // 自定义模型只读 Forge 自己的存储；切回已读过的引擎直接复用，不重复探测 CLI。
  useEffect(() => {
    if (!current || customModels[current] !== undefined || !cliDesktopAvailable()) return;
    let active = true;
    loadAiCustomModels(current)
      .then((list) => { if (active) setCustomModels((value) => ({ ...value, [current]: list })); })
      // 读不到就当空列表，不让设置页因此打不开。
      .catch(() => { if (active) setCustomModels((value) => ({ ...value, [current]: [] })); });
    return () => { active = false; };
  }, [current, customModels]);

  // 切换引擎时清空输入框：上一个引擎的 ID 不该被顺手加到另一个引擎。
  useEffect(() => { setCustomDraft(""); }, [current]);

  const addCustomModel = async () => {
    const target = customDraft.trim();
    if (!current || !target || customBusy) return;
    setCustomBusy(true); setCustomNotice(null);
    try {
      const catalog = await saveAiCustomModel(current, target);
      setCustomModels((value) => ({ ...value, [current]: catalog.customModels ?? [] }));
      setCustomDraft("");
      setCustomNotice({ provider: current, error: false, text: t("ai.custom.added", { model: target }) });
    } catch (error) {
      setCustomNotice({ provider: current, error: true, text: String(error) });
    } finally { setCustomBusy(false); }
  };

  const dropCustomModel = async (model: string) => {
    if (!current || customBusy) return;
    setCustomBusy(true); setCustomNotice(null);
    try {
      await removeAiCustomModel(current, model);
      setCustomModels((value) => ({ ...value, [current]: (value[current] ?? []).filter((item) => item !== model) }));
      setCustomNotice({ provider: current, error: false, text: t("ai.custom.removed", { model }) });
    } catch (error) {
      setCustomNotice({ provider: current, error: true, text: String(error) });
    } finally { setCustomBusy(false); }
  };

  // 环境变量草稿只在第一次看到该 CLI 时播种，之后的编辑不被后台刷新覆盖。
  // Claude 必须等原生 settings.json 读回来再播种：覆盖层现在是空的，先播种会把原生 env 盖成空串。
  useEffect(() => {
    if (!current) return;
    if (current === "claude") {
      if (!claudeConfig) return;
      setEnvDrafts((value) => value.claude === undefined
        ? { ...value, claude: aiCliEnvText(claudeConfig.env) }
        : value);
      return;
    }
    if (!store.loaded) return;
    setEnvDrafts((value) => value.codex === undefined
      ? { ...value, codex: aiCliEnvText(store.settings.agents.codex.env) }
      : value);
  }, [current, store.loaded, store.settings, claudeConfig]);

  const refreshStatus = async (provider: AiProvider) => {
    await refreshAiCli(true).then(refreshAiCliUpdates);
    await loadChecks(provider);
    if (provider === "codex") {
      setCatalogToken((value) => value + 1);
    }
  };

  const validateEnvDraft = (text: string): string | null => {
    const env = parseAiCliEnvText(text);
    const reserved = Object.keys(env).find((key) => RESERVED_AI_CLI_ENV.some((item) => item.toLowerCase() === key.toLowerCase()));
    if (reserved) return t("ai.env.reserved", { key: reserved });
    const invalid = validateAiCliEnv(env);
    return invalid ? t("ai.env.invalidKey", { key: invalid }) : null;
  };

  const persistEnvText = async (provider: AiProvider, text: string) => {
    const env = parseAiCliEnvText(text);
    if (provider === "claude") {
      // 删掉一整行等于删掉这个键：后端按「传入的键」局部更新，未提及的键会原样保留。
      for (const key of Object.keys(claudeConfig?.env ?? {})) if (!(key in env)) env[key] = "";
      // Claude 会把自己 settings.json 的 env 应用到进程，晚于父进程注入——只写 Forge 覆盖层
      // 永远会被原生旧值盖住。这里直接写原生文件（保留其他配置），并清空覆盖层。
      const fresh = await saveAiCliClaudeSettings(env);
      await updateAiCliAgent("claude", { env: {} });
      setClaudeConfig(fresh);
      setClaudeBaseline(envSnapshot(fresh.env));
      setEnvDrafts((drafts) => ({ ...drafts, claude: aiCliEnvText(fresh.env) }));
      return;
    }
    await updateAiCliAgent(provider, { env });
    setEnvDrafts((drafts) => ({ ...drafts, [provider]: text }));
  };

  const saveEnv = async (provider: AiProvider) => {
    const text = envDrafts[provider] ?? "";
    const invalid = validateEnvDraft(text);
    if (invalid) {
      setEnvNotice({ provider, error: true, text: invalid });
      return;
    }
    setEnvSaving(provider); setEnvNotice(null);
    try {
      await persistEnvText(provider, text);
      setEnvNotice({ provider, error: false, text: t("ai.env.saved") });
      await loadChecks(provider);
    } catch (error) {
      setEnvNotice({ provider, error: true, text: t("ai.env.saveFailed", { message: String(error) }) });
    } finally { setEnvSaving(null); }
  };

  const toggleAgent = async (provider: AiProvider) => {
    try { await updateAiCliAgent(provider, { enabled: !store.settings.agents[provider].enabled }); }
    catch (error) { setEnvNotice({ provider, error: true, text: t("ai.saveFailed", { message: String(error) }) }); }
  };

  const openFile = async (provider: AiProvider) => {
    setFileOpen((value) => ({ ...value, [provider]: true }));
    if (files[provider]) return;
    setFileBusy(provider);
    try {
      const file = await readAiCliConfig(provider);
      setFiles((value) => ({ ...value, [provider]: file }));
      setFileDrafts((value) => ({ ...value, [provider]: file.content }));
      if (file.error) setFileNotice({ provider, error: true, text: t("ai.config.loadFailed", { message: file.error }) });
    } catch (error) {
      setFileNotice({ provider, error: true, text: t("ai.config.loadFailed", { message: String(error) }) });
    } finally { setFileBusy(null); }
  };

  // 展开是默认态，内容也要在进页面时就位；顺序读避免 fileBusy 单值互相踩。
  useEffect(() => {
    if (!cliDesktopAvailable()) return;
    void (async () => {
      await openFile("claude");
      await openFile("codex");
    })();
    // 只在挂载时展开一次；openFile 内部对已读过的文件不重复读盘。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 原生配置文件被手动编辑后，结构化字段跟着重新读盘，避免界面上还是旧值。 */
  const syncStructuredConfig = async (provider: AiProvider) => {
    try {
      if (provider === "codex") {
        const next = await readAiCliCodexSettings();
        setCodexDraft(next);
        setCodexBaseline(JSON.stringify(next));
        setCodexMode(codexAuthModeOf(next));
      } else {
        const next = await readAiCliClaudeSettings();
        setClaudeConfig(next);
        setClaudeBaseline(envSnapshot(next.env));
        setClaudeMode(claudeAuthModeOf(next.env));
      }
    } catch { /* 结构化字段保持旧值，用户可先修好下方原生配置。 */ }
  };

  const reloadFile = async (provider: AiProvider) => {
    setFileBusy(provider);
    try {
      const file = await readAiCliConfig(provider);
      setFiles((value) => ({ ...value, [provider]: file }));
      setFileDrafts((value) => ({ ...value, [provider]: file.content }));
      setFileNotice(null);
      await syncStructuredConfig(provider);
    } catch (error) {
      setFileNotice({ provider, error: true, text: t("ai.config.loadFailed", { message: String(error) }) });
    } finally { setFileBusy(null); }
  };

  // 展开是默认态，内容也要在进页面时就位；顺序读避免 fileBusy 单值互相踩。
  useEffect(() => {
    if (!cliDesktopAvailable()) return;
    void (async () => {
      await openFile("claude");
      await openFile("codex");
    })();
    // 只在挂载时展开一次；openFile 内部对已读过的文件不重复读盘。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveFile = async (provider: AiProvider) => {
    setFileBusy(provider); setFileNotice(null);
    try {
      const file = await saveAiCliConfig(provider, fileDrafts[provider] ?? "");
      setFiles((value) => ({ ...value, [provider]: file }));
      setFileDrafts((value) => ({ ...value, [provider]: file.content }));
      setFileNotice({ provider, error: false, text: t("ai.config.saved") });
      await syncStructuredConfig(provider);
      await loadChecks(provider);
    } catch (error) {
      setFileNotice({ provider, error: true, text: t("ai.config.saveFailed", { message: String(error) }) });
    } finally { setFileBusy(null); }
  };

  // 展开是默认态，内容也要在进页面时就位；顺序读避免 fileBusy 单值互相踩。
  useEffect(() => {
    if (!cliDesktopAvailable()) return;
    void (async () => {
      await openFile("claude");
      await openFile("codex");
    })();
    // 只在挂载时展开一次；openFile 内部对已读过的文件不重复读盘。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dropOn = (target: AiProvider) => {
    if (!dragging || dragging === target) { setDragging(null); return; }
    const order = ordered.filter((provider) => provider !== dragging);
    order.splice(order.indexOf(target), 0, dragging);
    setDragging(null);
    void reorderAiCliAgents(order);
  };

  // 环境变量 textarea 是 Forge 的覆盖层；Claude 的结构化字段则读写原生 settings.json。
  const envText = current ? envDrafts[current] ?? "" : "";
  // 原生配置还没读回来时先用覆盖层的值占位，避免整块表单先闪一下空白。
  const claudeEnvFallback = store.settings.agents.claude.env;
  const claudeEnv = claudeConfig?.env ?? claudeEnvFallback;
  const claudeEnvValue = (key: string) => claudeEnv[key] ?? "";
  const patchClaudeEnv = (patch: Record<string, string>) => {
    setClaudeConfig((config) => {
      const base = config ?? { path: "", exists: false, error: null, env: { ...claudeEnvFallback } };
      return { ...base, env: { ...base.env, ...patch } };
    });
  };
  const claudeKeyName = claudeEnvValue("ANTHROPIC_AUTH_TOKEN") === "" && claudeEnvValue("ANTHROPIC_API_KEY") !== ""
    ? "ANTHROPIC_API_KEY"
    : "ANTHROPIC_AUTH_TOKEN";
  // 绑定了供应商就以供应商为准：端点与密钥由「模型供应商」页维护，这里只展示当前生效值并负责「应用」。
  const claudeBinding = store.settings.agents.claude.provider;
  const codexBinding = store.settings.agents.codex.provider;
  const currentClaudeMode: ClaudeAuthMode = claudeBinding ? "provider" : claudeMode ?? claudeAuthModeOf(claudeEnv);
  const currentCodexMode: CodexAuthMode = codexBinding ? "provider" : codexMode ?? (codexDraft ? codexAuthModeOf(codexDraft) : "subscription");
  const providerChoices = (kind: AiProvider) => providerOptions.filter((item) => item.kind === kind);
  const boundIdOf = (kind: AiProvider) => kind === "claude" ? claudeBinding : codexBinding;
  const codexRelativeRoot = codexDraft?.writableRoots
    .map((root) => root.trim())
    .filter((root) => root !== "" && !isAbsoluteRoot(root))[0] ?? null;
  const codexWorkspaceWriteApplies = !codexDraft?.sandboxMode || codexDraft.sandboxMode === "workspace-write";
  const managedBusy = (current !== null && envSaving === current) || codexSaving
    || (current === "codex" && (codexLoading || !codexDraft))
    || (current === "claude" && (claudeLoading || !claudeConfig?.path));

  // 这一页挂着四份草稿：两个 CLI 的环境变量、原生配置文件、Claude/Codex 的结构化字段。
  // 切去别的设置模块会连组件一起卸载，所以离开前先问一句。
  const envDirty = (provider: AiProvider) => {
    const draft = envDrafts[provider];
    // Claude 的 env 活在原生 settings.json 里；和覆盖层比会永远显示「未保存」。
    const saved = provider === "claude" ? claudeConfig?.env : store.settings.agents[provider].env;
    return draft !== undefined && envSnapshot(parseAiCliEnvText(draft)) !== envSnapshot(saved ?? {});
  };
  const fileDirty = (provider: AiProvider) => {
    const draft = fileDrafts[provider];
    const file = files[provider];
    return draft !== undefined && file !== undefined && draft !== file.content;
  };
  // 快照还没建立时，界面上已有的值只能算用户改出来的（读取失败时也要拦住离开）。
  const claudeDirty = claudeConfig !== null && (claudeBaseline === null || envSnapshot(claudeConfig.env) !== claudeBaseline);
  const codexDirty = codexDraft !== null && (codexBaseline === null || JSON.stringify(codexDraft) !== codexBaseline);
  const catalogDirty = catalog !== null && normalizeCodexCatalogIntent(catalogDraft) !== catalogBaseline;
  // 推理档位的合法值只由 Codex 自己的模型清单给出；清单没读回来时不给选项，免得写进一个 Codex 不认的档位。
  const codexEfforts = useMemo(() => {
    const models = catalog?.models ?? [];
    const current = models.find((model) => model.slug === (codexDraft?.model ?? ""));
    const pool = current ? codexModelEfforts(current) : [...new Set(models.flatMap(codexModelEfforts))];
    const value = codexDraft?.modelReasoningEffort ?? "";
    return value !== "" && !pool.includes(value) ? [value, ...pool] : pool;
  }, [catalog, codexDraft?.model, codexDraft?.modelReasoningEffort]);
  const dirty = (["claude", "codex"] as AiProvider[]).some((provider) => envDirty(provider) || fileDirty(provider))
    || claudeDirty || codexDirty || (current === "codex" ? catalogDirty : false);
  /** 「配置管理」这一块一次只展示一个 CLI 的结构化字段，徽标跟着当前选中的那个。 */
  const manageUnsaved = current === "claude" ? claudeDirty : current === "codex" ? (codexDirty || catalogDirty) : false;
  useUnsavedGuard(() => dirty);
  /** 重新读取会拿磁盘上的值覆盖草稿，所以脏的时候先确认；非空即待确认的动作。 */
  const [pendingReload, setPendingReload] = useState<(() => void) | null>(null);
  const guard = (action: () => void) => {
    if (dirty) setPendingReload(() => action);
    else action();
  };

  const bindProvider = async (kind: AiProvider, id: string) => {
    try { await updateAiCliAgent(kind, { provider: id }); }
    catch (error) { setManageNotice({ provider: kind, error: true, text: t("ai.env.saveFailed", { message: String(error) }) }); }
  };

  const applyBoundProvider = async (kind: AiProvider) => {
    const id = boundIdOf(kind);
    if (!id || applyingProvider) return;
    setApplyingProvider(true); setManageNotice(null);
    try {
      await applyModelProvider(id);
      await refreshAiCliSettings(true);
      // 应用改的是 CLI 真正读取的文件，界面上那份草稿要跟着重新读回来，否则显示的还是旧端点。
      await syncStructuredConfig(kind);
      setManageNotice({ provider: kind, error: false, text: t("ai.cfg.providerApplied") });
    } catch (error) {
      setManageNotice({ provider: kind, error: true, text: t("providers.applyFailed", { message: String(error) }) });
    } finally { setApplyingProvider(false); }
  };

  const changeClaudeMode = (mode: ClaudeAuthMode) => {
    setClaudeMode(mode);
    // 切回官方订阅时清空草稿；保存时才会真正从 settings.json 里删除这些键。
    if (mode === "official") patchClaudeEnv({ ANTHROPIC_BASE_URL: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "" });
    if (mode !== "provider" && claudeBinding) void bindProvider("claude", "");
  };

  const editCodex = (patch: Partial<AiCliCodexSettings>) => {
    setCodexDraft((draft) => draft ? { ...draft, ...patch } : draft);
  };
  const changeCodexMode = (mode: CodexAuthMode) => {
    setCodexMode(mode);
    if (mode === "subscription") editCodex({ apiBaseUrl: "", apiKey: "" });
    if (mode !== "provider" && codexBinding) void bindProvider("codex", "");
  };
  const editGranular = (key: keyof AiCliCodexGranular, checked: boolean) => {
    setCodexDraft((draft) => draft ? { ...draft, granular: { ...draft.granular, [key]: checked } } : draft);
  };

  const saveClaudeManage = async () => {
    if (current !== "claude" || !claudeConfig?.path) return;
    const env: Record<string, string> = {};
    const clearAuth = currentClaudeMode === "official";
    for (const key of CLAUDE_MANAGED_KEYS) {
      env[key] = clearAuth && (key === "ANTHROPIC_BASE_URL" || key === "ANTHROPIC_AUTH_TOKEN" || key === "ANTHROPIC_API_KEY")
        ? ""
        : claudeEnvValue(key);
    }
    // 只保留一个密钥变量：AUTH_TOKEN 优先，避免旧的 API_KEY 继续被 CLI 读到。
    if (!clearAuth) {
      if (env.ANTHROPIC_AUTH_TOKEN.trim()) env.ANTHROPIC_API_KEY = "";
      else if (env.ANTHROPIC_API_KEY.trim()) env.ANTHROPIC_AUTH_TOKEN = "";
    }
    // 两个隐私开关按界面上的默认值落盘，避免「看起来关着、实际没写」。
    env.CLAUDE_CODE_ATTRIBUTION_HEADER = env.CLAUDE_CODE_ATTRIBUTION_HEADER === "1" ? "1" : "0";
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = (env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || "1") === "0" ? "0" : "1";
    const invalidKey = validateAiCliEnv(env);
    if (invalidKey) { setManageNotice({ provider: "claude", error: true, text: t("ai.env.invalidKey", { key: invalidKey }) }); return; }
    setEnvSaving("claude"); setManageNotice(null);
    try {
      await saveAiCliClaudeSettings(env);
      // 这些键已改由原生文件负责；覆盖层里的同名旧值会在原生键删除后重新冒出来，直接从覆盖层删掉。
      const overlay = { ...store.settings.agents.claude.env };
      for (const key of CLAUDE_MANAGED_KEYS) delete overlay[key];
      if (Object.keys(overlay).length !== Object.keys(store.settings.agents.claude.env).length) await updateAiCliAgent("claude", { env: overlay });
      const fresh = await readAiCliClaudeSettings();
      setClaudeConfig(fresh);
      setClaudeBaseline(envSnapshot(fresh.env));
      setClaudeMode(claudeAuthModeOf(fresh.env));
      setEnvDrafts((drafts) => ({ ...drafts, claude: aiCliEnvText(fresh.env) }));
      setManageNotice({ provider: "claude", error: false, text: t("ai.cfg.saved") });
      await loadChecks("claude");
    } catch (error) {
      setManageNotice({ provider: "claude", error: true, text: t("ai.env.saveFailed", { message: String(error) }) });
    } finally { setEnvSaving(null); }
  };

  const saveCodexManage = async () => {
    if (current !== "codex" || !codexDraft) return;
    const roots = codexDraft.writableRoots.map((root) => root.trim()).filter((root) => root !== "");
    const relative = roots.find((root) => !isAbsoluteRoot(root));
    if (relative) {
      setManageNotice({ provider: "codex", error: true, text: t("ai.cfg.writableRootsInvalid", { path: relative }) });
      return;
    }
    // 绑定供应商时端点与密钥同样按 API Key 方式落盘，只是界面上只读、来源是供应商的「应用」。
    const apiMode = currentCodexMode !== "subscription";
    const apiKey = apiMode ? codexDraft.apiKey.trim() : "";
    const apiBaseUrl = apiMode ? codexDraft.apiBaseUrl.trim() : "";
    // 认证信息留在 Forge 的环境变量层，模型/沙箱写 config.toml；auth.json 由后端按模式同步。
    const nextEnv = patchAiCliEnvText(envText, {
      OPENAI_API_KEY: apiKey,
      OPENAI_BASE_URL: apiBaseUrl,
    });
    const invalid = validateEnvDraft(nextEnv);
    if (invalid) { setManageNotice({ provider: "codex", error: true, text: invalid }); return; }
    setCodexSaving(true); setManageNotice(null);
    try {
      await persistEnvText("codex", nextEnv);
      const saved = await saveAiCliCodexSettings({ ...codexDraft, apiKey, apiBaseUrl, writableRoots: roots });
      setCodexDraft(saved);
      setCodexBaseline(JSON.stringify(saved));
      setCodexMode(codexAuthModeOf(saved));
      if (fileOpen.codex) {
        const loaded = files.codex?.content;
        const rawDraft = fileDrafts.codex;
        try {
          const fresh = await readAiCliConfig("codex");
          setFiles((value) => ({ ...value, codex: fresh }));
          // 用户有未保存的手工修改时不动草稿，避免把编辑内容冲掉。
          setFileDrafts((value) => rawDraft === loaded || loaded === undefined
            ? { ...value, codex: fresh.content }
            : value);
        } catch { /* 原生编辑器保持原样，用户可手动重新加载。 */ }
      }
      setManageNotice({ provider: "codex", error: false, text: t("ai.cfg.saved") });
      await loadChecks("codex");
    } catch (error) {
      setManageNotice({ provider: "codex", error: true, text: t("ai.env.saveFailed", { message: String(error) }) });
    } finally { setCodexSaving(false); }
  };

  const summaryOf = (provider: AiProvider): CheckTone => {
    if (!store.settings.agents[provider].enabled) return "disabled";
    if (checking[provider]) return "checking";
    const list = checks[provider];
    if (!list?.length) return "unchecked";
    if (list.some((check) => check.status === "fail")) return "fail";
    if (list.some((check) => check.status === "warn")) return "warn";
    return "pass";
  };

  const toneLabel = (tone: CheckTone) => t(`ai.state.${tone}` as TranslationKey);

  // 最新版本来自联网查询，和本地检查分开拼；没查到就明确说没查，不当成通过。
  const latest: AiCliCheck | null = status
    ? status.latestError
      ? { id: "latest", status: "fail", value: null, hint: `${t("ai.latestFailed")} ${status.latestError}` }
      : status.latestVersion
        ? { id: "latest", status: status.updateAvailable ? "warn" : "pass", value: status.latestVersion,
          hint: status.latestSource === "npmmirror" ? t("ai.mirrorVersionHint") : null }
        : { id: "latest", status: "warn", value: null, hint: t("ai.checks.latestPending") }
    : null;
  const allChecks = [...(current ? checks[current] ?? [] : []), ...(latest ? [latest] : [])];

  return (
    <div className="ai-cli-page">
      <aside className="ai-cli-list" aria-label={t("ai.agentList")}>
        <div className="ai-cli-list-head">
          <span>{t("ai.agentList")}</span>
          <span className="ai-cli-list-hint">{t("ai.agentListHint")}</span>
        </div>
        <div className="ai-cli-list-body">
          {ordered.map((provider) => {
            const tone = summaryOf(provider);
            const enabled = store.settings.agents[provider].enabled;
            return (
              <div key={provider} role="button" tabIndex={0}
                className={`ai-cli-row${current === provider ? " is-active" : ""}${dragging === provider ? " is-dragging" : ""}`}
                aria-pressed={current === provider}
                onMouseDown={(event) => { if (event.button === 0) setSelected(provider); }}
                onClick={() => setSelected(provider)}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(provider); } }}
                onDragOver={(event) => { if (dragging) event.preventDefault(); }}
                onDrop={() => dropOn(provider)}>
                {/* 只有手柄可拖：整行 draggable 会让点击在 WebView 里被拖拽会话吞掉。 */}
                <span className="ai-cli-grip" draggable title={t("ai.agentListHint")} aria-hidden="true"
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", provider);
                    setDragging(provider);
                  }}
                  onDragEnd={() => setDragging(null)}>
                  <GripVertical size={13} />
                </span>
                <AiProviderIcon provider={provider} size={16} />
                <span className="ai-cli-row-name">{AI_NAMES[provider]}</span>
                {enabled ? <span className="ai-cli-enabled-dot" title={t("ai.agentEnabled")} /> : null}
                <span className={`ai-cli-badge is-${tone}`}>
                  {checking[provider] ? <Loader2 size={11} className="is-spinning" /> : null}
                  {toneLabel(tone)}
                </span>
              </div>
            );
          })}
          <p className="ai-cli-list-note">{t("ai.installCacheHint")}</p>
        </div>
      </aside>

      <section className="ai-cli-detail" aria-label={t("ai.agentDetail")}>
        {current && agent ? <>
          <header className="ai-cli-detail-head">
            <div className="ai-cli-detail-title">
              <AiProviderIcon provider={current} size={20} />
              <h3>{AI_NAMES[current]}</h3>
              <span className="ai-cli-badge is-idle">CLI</span>
              <span className={`ai-cli-badge is-${summaryOf(current)}`}>{toneLabel(summaryOf(current))}</span>
            </div>
            <button type="button" role="switch" className="ai-enable-switch ai-cli-agent-switch"
              aria-checked={agent.enabled} aria-label={t(agent.enabled ? "ai.disableAgent" : "ai.enableAgent", { name: AI_NAMES[current] })}
              title={t(agent.enabled ? "ai.disableAgent" : "ai.enableAgent", { name: AI_NAMES[current] })}
              disabled={store.saving}
              onClick={() => void toggleAgent(current)}>
              <span />
            </button>
          </header>

          <div className="ai-cli-detail-body">
            <div className="ai-cli-summary">
              <p className="ai-muted">{t(current === "claude" ? "ai.claudeMethod" : "ai.codexMethod")}</p>
              <p className="ai-muted">{t(agent.enabled ? "ai.agentEnabledHint" : "ai.agentDisabledHint")}</p>
              {!desktop ? <p className="ai-notice">{t("ai.desktopOnly")}</p> : null}
              {cli.error ? <p className="ai-error" role="alert">{cli.error}</p> : null}
            </div>

            <section className="ai-cli-section" aria-label={t("ai.checks.title")}>
              <div className="ai-cli-section-head">
                <div>
                  <strong>{t("ai.checks.title")}</strong>
                  <span className="ai-muted">{t("ai.checks.count", { count: allChecks.length })}</span>
                </div>
                <button type="button" className="lsp-action" disabled={!desktop || checking[current]}
                  onClick={() => { void refreshStatus(current); }}>
                  {checking[current] ? <Loader2 size={13} className="is-spinning" /> : <RefreshCw size={13} />}
                  {t("ai.checks.refresh")}
                </button>
              </div>
              <div className="ai-cli-checks">
                {allChecks.length ? allChecks.map((check) => (
                  <div key={check.id} className={`ai-cli-check is-${check.status}`}>
                    <CheckIcon status={check.status} />
                    <div className="ai-cli-check-text">
                      <strong>{t(CHECK_LABEL[check.id] ?? "ai.checks.other")}</strong>
                      {check.hint ? <span>{check.hint}</span> : null}
                    </div>
                    {check.id === "env" && check.value
                      ? <span className="ai-cli-check-value">{t("ai.checks.envCount", { count: check.value })}</span>
                      : check.value ? <span className="ai-cli-check-value" title={check.value}>{check.value}</span> : null}
                  </div>
                )) : <p className="ai-muted">{t("ai.checks.empty")}</p>}
              </div>
            </section>

            <section className="ai-cli-section" aria-label={t("ai.versionSection")}>
              <div className="ai-cli-section-head">
                <div>
                  <strong>{t("ai.versionSection")}</strong>
                  <span className="ai-muted">{t("ai.manageNote")}</span>
                </div>
              </div>
              <dl className="ai-cli-facts">
                <div><dt>{t("ai.installed")}</dt><dd>{t(!status || status.probeError ? "ai.unknown" : status.installed ? "ai.installed" : "ai.missing")}</dd></div>
                <div><dt>{t("ai.currentVersion")}</dt><dd>{status?.version ?? "—"}</dd></div>
                <div><dt>{t("ai.latestVersion")}</dt><dd>{status?.latestVersion ?? "—"}{status?.updateAvailable ? <span className="ai-update-badge">{t("ai.updateAvailable")}</span> : null}</dd></div>
                <div><dt>{t("ai.source")}</dt><dd>{status?.source ? t(`ai.source.${status.source}`) : "—"}</dd></div>
                <div><dt>{t("ai.path")}</dt><dd className="ai-cli-path">{status?.path ?? "—"}</dd></div>
              </dl>
              {status?.probeError ? <p className="ai-error" role="alert">{t("ai.probeFailed")} {status.probeError}</p> : null}
              {status?.latestError ? <p className="ai-error" role="alert">{t("ai.latestFailed")} {status.latestError}</p> : null}
              {status?.prerequisiteError ? <p className="ai-notice">{status.prerequisiteError}</p> : null}
              {status?.installed && !status.canUpdate && !status.canUninstall ? <p className="ai-notice">{t("ai.externalHint")}</p> : null}
              <div className="ai-cli-actions">
                {(["install", "update", "uninstall"] as const).map((action) => (
                  <button key={action} type="button" className="lsp-action"
                    disabled={!desktop || busy || !canManageCli(status, action)}
                    onClick={() => setPending({ provider: current, action })}>
                    {cli.operation?.provider === current && cli.operation.action === action
                      ? <Loader2 size={13} className="is-spinning" />
                      : action === "install" ? <Download size={13} /> : action === "update" ? <RefreshCw size={13} /> : <Trash2 size={13} />}
                    {t(`ai.${action}`)}
                  </button>
                ))}
              </div>
              {cli.operation?.provider === current ? <p className="ai-notice" role="status">{t("ai.operationRunning")}</p> : null}
              {cli.results[current] ? <div role="status">
                <p className={cli.results[current]?.success ? "ai-success" : "ai-error"}>
                  {t(cli.results[current]?.success ? "ai.operationSuccess" : "ai.operationFailed")}
                  {cli.results[current]?.exitCode !== null ? ` (${cli.results[current]?.exitCode})` : ""}
                </p>
                {cli.results[current]?.output ? <details className="ai-cli-output" open={!cli.results[current]?.success}>
                  <summary>{t("ai.output")}</summary><pre>{cli.results[current]?.output}</pre>
                </details> : null}
              </div> : null}
            </section>

            <section className="ai-cli-section" aria-label={t("ai.env.title")}>
              <div className="ai-cli-section-head">
                <div>
                  <strong>{t("ai.env.title")}</strong>
                  <span className="ai-muted">{t(current === "claude" ? "ai.env.hintClaude" : "ai.env.hint")}</span>
                  {current && envDirty(current) ? <span className="ai-cli-badge is-checking">{t("ai.unsaved")}</span> : null}
                </div>
              </div>
              <textarea className="ai-cli-env" spellCheck={false} rows={4}
                value={envDrafts[current] ?? ""}
                placeholder={t("ai.env.placeholder")}
                onChange={(event) => setEnvDrafts((value) => ({ ...value, [current]: event.target.value }))} />
              {current === "claude" && claudeConfig?.path
                ? <p className="ai-cli-hint">{t("ai.env.storedIn")} <code>{claudeConfig.path}</code></p>
                : null}
              <div className="ai-cli-section-foot">
                {envNotice?.provider === current
                  ? <p className={envNotice.error ? "ai-error" : "ai-success"} role="status">{envNotice.text}</p>
                  : <span />}
                <button type="button" className="lsp-action" disabled={!desktop || store.saving || envSaving === current}
                  onClick={() => void saveEnv(current)}>
                  {envSaving === current ? <Loader2 size={13} className="is-spinning" /> : <Save size={13} />}
                  {envSaving === current ? t("ai.saving") : t("ai.env.save")}
                </button>
              </div>
            </section>

            <section className="ai-cli-section" aria-label={t("ai.cfg.title")}>
              <div className="ai-cli-section-head">
                <div>
                  <strong>{t("ai.cfg.title")}</strong>
                  <span className="ai-muted">{t(current === "claude" ? "ai.cfg.claudeHint" : "ai.cfg.codexHint")}</span>
                  {manageUnsaved ? <span className="ai-cli-badge is-checking">{t("ai.unsaved")}</span> : null}
                </div>
              </div>

              {current === "claude" ? (
                <div className="ai-cli-form">
                  {claudeConfig?.error
                    ? <p className="ai-error" role="alert">{claudeConfig.error}</p>
                    : claudeConfig
                      ? <p className="ai-cli-hint"><code>{claudeConfig.path}</code>{claudeConfig.exists ? null : ` · ${t("ai.config.missing")}`}</p>
                      : <p className="ai-cli-hint" role="status">{claudeLoading ? t("ai.cfg.loading") : t("ai.cfg.unavailable")}</p>}

                  <div className="ai-cli-field">
                    <span>{t("ai.cfg.claudeAuthMode")}</span>
                    <Select value={currentClaudeMode} label={t("ai.cfg.claudeAuthMode")} placeholder={t("ai.cfg.claudeAuthMode")}
                      options={(["official", "custom", "provider"] as ClaudeAuthMode[]).map((mode) => ({ value: mode, label: t(CLAUDE_MODE_LABEL[mode]) }))}
                      onChange={changeClaudeMode} />
                    <em className="ai-cli-hint">{t(CLAUDE_MODE_HINT[currentClaudeMode])}</em>
                  </div>

                  {currentClaudeMode === "provider" ? (
                    <ProviderPicker boundId={claudeBinding} choices={providerChoices("claude")} applying={applyingProvider}
                      missing={claudeBinding !== "" && !providerOptions.some((item) => item.id === claudeBinding)}
                      onPick={(id) => void bindProvider("claude", id)} onApply={() => void applyBoundProvider("claude")} />
                  ) : null}

                  {currentClaudeMode !== "official" ? (
                    <div className="ai-cli-grid">
                      <label className="ai-cli-field">
                        <span>{t("ai.cfg.apiUrl")}</span>
                        <input className="text-input" spellCheck={false} value={claudeEnvValue("ANTHROPIC_BASE_URL")} placeholder="https://api.example.com"
                          readOnly={currentClaudeMode === "provider"} onChange={(event) => patchClaudeEnv({ ANTHROPIC_BASE_URL: event.target.value })} />
                      </label>
                      <label className="ai-cli-field">
                        <span>{t("ai.cfg.apiKey")}</span>
                        <div className="ai-cli-inline">
                          <input className="text-input" spellCheck={false} type={secretShown.claude ? "text" : "password"}
                            value={claudeEnvValue(claudeKeyName)} placeholder="sk-..."
                            readOnly={currentClaudeMode === "provider"}
                            onChange={(event) => patchClaudeEnv({ [claudeKeyName]: event.target.value })} />
                          <button type="button" className="ai-cli-secret-toggle"
                            aria-label={t(secretShown.claude ? "ai.cfg.hideKey" : "ai.cfg.showKey")}
                            title={t(secretShown.claude ? "ai.cfg.hideKey" : "ai.cfg.showKey")}
                            onClick={() => setSecretShown((value) => ({ ...value, claude: !value.claude }))}>
                            {secretShown.claude ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                        </div>
                      </label>
                    </div>
                  ) : null}

                  <div className="ai-cli-field">
                    <span>{t("ai.cfg.claudeModels")}</span>
                    <div className="ai-cli-grid">
                      {CLAUDE_MODEL_FIELDS.map((field) => (
                        <label key={field.key} className="ai-cli-field">
                          <span>{t(field.label)}</span>
                          <input className="text-input" spellCheck={false} value={claudeEnvValue(field.key)} placeholder={field.placeholder}
                            onChange={(event) => patchClaudeEnv({ [field.key]: event.target.value })} />
                        </label>
                      ))}
                    </div>
                    <em className="ai-cli-hint">{t("ai.cfg.claudeModelHint")}</em>
                  </div>

                  <div className="ai-cli-field">
                    <span>{t("ai.cfg.customOption")}</span>
                    <div className="ai-cli-grid">
                      {CLAUDE_CUSTOM_MODEL_FIELDS.map((field) => (
                        <label key={field.key} className="ai-cli-field">
                          <span>{t(field.label)}</span>
                          <input className="text-input" spellCheck={false} value={claudeEnvValue(field.key)} placeholder={field.placeholder}
                            onChange={(event) => patchClaudeEnv({ [field.key]: event.target.value })} />
                        </label>
                      ))}
                    </div>
                    <em className="ai-cli-hint">{t("ai.cfg.customOptionHint")}</em>
                  </div>

                  <div className="ai-cli-row-switch">
                    <span>{t("ai.cfg.sendAttribution")}</span>
                    <button type="button" role="switch" className="ai-enable-switch"
                      aria-checked={claudeEnvValue("CLAUDE_CODE_ATTRIBUTION_HEADER") === "1"}
                      aria-label={t("ai.cfg.sendAttribution")} disabled={!desktop || store.saving}
                      onClick={() => patchClaudeEnv({ CLAUDE_CODE_ATTRIBUTION_HEADER: claudeEnvValue("CLAUDE_CODE_ATTRIBUTION_HEADER") === "1" ? "0" : "1" })}>
                      <span />
                    </button>
                  </div>
                  <div className="ai-cli-row-switch">
                    <span>{t("ai.cfg.disableNonessential")}</span>
                    <button type="button" role="switch" className="ai-enable-switch"
                      aria-checked={(claudeEnvValue("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC") || "1") !== "0"}
                      aria-label={t("ai.cfg.disableNonessential")} disabled={!desktop || store.saving}
                      onClick={() => patchClaudeEnv({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: (claudeEnvValue("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC") || "1") === "0" ? "1" : "0" })}>
                      <span />
                    </button>
                  </div>
                </div>
              ) : codexLoading || !codexDraft ? (
                <p className="ai-cli-hint" role="status">
                  {codexLoading ? <Loader2 size={12} className="is-spinning" /> : null}
                  {codexLoading ? t("ai.cfg.loading") : t("ai.cfg.unavailable")}
                </p>
              ) : (
                <div className="ai-cli-form">
                  <div className="ai-cli-field">
                    <span>{t("ai.cfg.codexAuthMode")}</span>
                    <Select value={currentCodexMode} label={t("ai.cfg.codexAuthMode")} placeholder={t("ai.cfg.codexAuthMode")}
                      options={(["subscription", "api_key", "provider"] as CodexAuthMode[]).map((mode) => ({ value: mode, label: t(CODEX_MODE_LABEL[mode]) }))}
                      onChange={changeCodexMode} />
                    <em className="ai-cli-hint">{t(CODEX_MODE_HINT[currentCodexMode])}</em>
                    {codexDraft.modelProvider
                      ? <em className="ai-cli-hint">{t("ai.cfg.codexProviderHint", { provider: codexDraft.modelProvider })}</em>
                      : null}
                    {codexDraft.authError ? <em className="ai-cli-warning" role="alert">{codexDraft.authError}</em> : null}
                  </div>

                  {currentCodexMode === "provider" ? (
                    <ProviderPicker boundId={codexBinding} choices={providerChoices("codex")} applying={applyingProvider}
                      missing={codexBinding !== "" && !providerOptions.some((item) => item.id === codexBinding)}
                      onPick={(id) => void bindProvider("codex", id)} onApply={() => void applyBoundProvider("codex")} />
                  ) : null}

                  {currentCodexMode !== "subscription" ? (
                    <div className="ai-cli-grid">
                      <label className="ai-cli-field">
                        <span>{t("ai.cfg.apiUrl")}</span>
                        <input className="text-input" spellCheck={false} value={codexDraft.apiBaseUrl} placeholder="https://api.openai.com/v1"
                          readOnly={currentCodexMode === "provider"} onChange={(event) => editCodex({ apiBaseUrl: event.target.value })} />
                      </label>
                      <label className="ai-cli-field">
                        <span>{t("ai.cfg.apiKey")}</span>
                        <div className="ai-cli-inline">
                          <input className="text-input" spellCheck={false} type={secretShown.codex ? "text" : "password"}
                            value={codexDraft.apiKey} placeholder="sk-..."
                            readOnly={currentCodexMode === "provider"}
                            onChange={(event) => editCodex({ apiKey: event.target.value })} />
                          <button type="button" className="ai-cli-secret-toggle"
                            aria-label={t(secretShown.codex ? "ai.cfg.hideKey" : "ai.cfg.showKey")}
                            title={t(secretShown.codex ? "ai.cfg.hideKey" : "ai.cfg.showKey")}
                            onClick={() => setSecretShown((value) => ({ ...value, codex: !value.codex }))}>
                            {secretShown.codex ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                        </div>
                      </label>
                    </div>
                  ) : null}

                  <label className="ai-cli-field">
                    <span>{t("ai.cfg.model")}</span>
                    <input className="text-input" spellCheck={false} value={codexDraft.model} placeholder="gpt-5-codex"
                      onChange={(event) => editCodex({ model: event.target.value })} />
                    <em className="ai-cli-hint">{t("ai.cfg.codexModelHint")}</em>
                  </label>

                  <div className="ai-cli-subgroup">
                    <div className="ai-cli-subgroup-head">
                      <strong>{t("ai.cfg.reasoning")}</strong>
                      <span className="ai-cli-hint">{t("ai.cfg.reasoningHint")}</span>
                    </div>
                    {/* 第一行（3 个短枚举选择框）：推理强度、思考摘要、详细级别同行 3 列紧凑展示，绝不拉满全行 */}
                    <div className="ai-cli-grid is-triplet">
                      {codexEfforts.length ? (
                        <CodexEnumField label={t("ai.cfg.effort")} value={codexDraft.modelReasoningEffort}
                          hint={t("ai.cfg.effortHint")} values={codexEfforts}
                          onPick={(value) => editCodex({ modelReasoningEffort: value })} />
                      ) : (
                        <label className="ai-cli-field">
                          <span>{t("ai.cfg.effort")}</span>
                          <input className="text-input" spellCheck={false} value={codexDraft.modelReasoningEffort}
                            placeholder={t("ai.cfg.codexDefault")} onChange={(event) => editCodex({ modelReasoningEffort: event.target.value.trim() })} />
                          <em className="ai-cli-hint">{t("ai.cfg.effortNoCatalog")}</em>
                        </label>
                      )}
                      <CodexEnumField label={t("ai.cfg.summary")} value={codexDraft.modelReasoningSummary}
                        values={CODEX_SUMMARY_VALUES} labels={CODEX_SUMMARY_LABELS}
                        onPick={(value) => editCodex({ modelReasoningSummary: value })} />
                      <CodexEnumField label={t("ai.cfg.verbosity")} value={codexDraft.modelVerbosity}
                        hint={t("ai.cfg.verbosityHint")} values={CODEX_VERBOSITY_VALUES} labels={CODEX_VERBOSITY_LABELS}
                        onPick={(value) => editCodex({ modelVerbosity: value })} />
                    </div>
                    {/* 第二行（2 个数字框）：上下文窗口与自动压缩阈值成对同行双列，杜绝单数字输入框独占全行 */}
                    <div className="ai-cli-grid">
                      <CodexNumberField label={t("ai.cfg.contextWindow")} value={codexDraft.modelContextWindow}
                        hint={t("ai.cfg.contextWindowHint")} onPick={(value) => editCodex({ modelContextWindow: value })} />
                      <CodexNumberField label={t("ai.cfg.autoCompact")} value={codexDraft.modelAutoCompactTokenLimit}
                        hint={t("ai.cfg.autoCompactHint")} onPick={(value) => editCodex({ modelAutoCompactTokenLimit: value })} />
                    </div>
                  </div>

                  <div className="ai-cli-subgroup">
                    <div className="ai-cli-subgroup-head">
                      <strong>{t("ai.cfg.tools")}</strong>
                      <span className="ai-cli-hint">{t("ai.cfg.toolsHint")}</span>
                    </div>
                    {/* 选项简短的枚举成对双列排布 */}
                    <div className="ai-cli-grid">
                      <CodexEnumField label={t("ai.cfg.webSearch")} value={codexDraft.webSearch}
                        hint={t("ai.cfg.webSearchHint")} values={CODEX_WEB_SEARCH_VALUES} labels={CODEX_WEB_SEARCH_LABELS}
                        onPick={(value) => editCodex({ webSearch: value })} />
                      <CodexEnumField label={t("ai.cfg.inherit")} value={codexDraft.shellEnvInherit}
                        hint={t("ai.cfg.inheritHint")} values={CODEX_INHERIT_VALUES} labels={CODEX_INHERIT_LABELS}
                        onPick={(value) => editCodex({ shellEnvInherit: value })} />
                    </div>
                  </div>

                  <div className="ai-cli-subgroup">
                    <div className="ai-cli-subgroup-head">
                      <strong>{t("ai.cfg.history")}</strong>
                      <span className="ai-cli-hint">{t("ai.cfg.historyHint")}</span>
                    </div>
                    {/* 会话持久化与容量上限成对双列排布 */}
                    <div className="ai-cli-grid">
                      <CodexEnumField label={t("ai.cfg.persistence")} value={codexDraft.historyPersistence}
                        values={CODEX_PERSISTENCE_VALUES} labels={CODEX_PERSISTENCE_LABELS}
                        onPick={(value) => editCodex({ historyPersistence: value })} />
                      <CodexNumberField label={t("ai.cfg.historyBytes")} value={codexDraft.historyMaxBytes}
                        hint={t("ai.cfg.historyBytesHint")} onPick={(value) => editCodex({ historyMaxBytes: value })} />
                    </div>
                  </div>

                  {/* 功能交互开关：成对双列排布，卡片定高居中，提示外挂下方，拒绝大长横条拉满全行 */}
                  <div className="ai-cli-grid">
                    <div className="ai-cli-switch-group">
                      <div className="ai-cli-switch-card">
                        <span className="ai-cli-switch-title">{t("ai.cfg.websocket")}</span>
                        <button type="button" role="switch" className="ai-enable-switch"
                          disabled={!codexDraft.providerDefined}
                          aria-checked={codexDraft.providerDefined && codexDraft.supportsWebsockets === true}
                          aria-label={t("ai.cfg.websocket")}
                          onClick={() => codexDraft.providerDefined && editCodex({ supportsWebsockets: codexDraft.supportsWebsockets !== true })}>
                          <span />
                        </button>
                      </div>
                      <em className="ai-cli-hint">
                        {codexDraft.providerDefined ? t("ai.cfg.websocketHint") : t("ai.cfg.websocketAbsent")}
                      </em>
                    </div>

                    <div className="ai-cli-switch-group">
                      <div className="ai-cli-switch-card">
                        <span className="ai-cli-switch-title">{t("ai.cfg.requestUserInput")}</span>
                        <button type="button" role="switch" className="ai-enable-switch"
                          aria-checked={codexDraft.defaultModeRequestUserInput}
                          aria-label={t("ai.cfg.requestUserInput")}
                          onClick={() => editCodex({ defaultModeRequestUserInput: !codexDraft.defaultModeRequestUserInput })}>
                          <span />
                        </button>
                      </div>
                      <em className="ai-cli-hint">{t("ai.cfg.requestUserInputHint")}</em>
                    </div>
                  </div>

                  <div className="ai-cli-subgroup">
                    <div className="ai-cli-subgroup-head">
                      <strong>{t("ai.cfg.sandbox")}</strong>
                      <span className="ai-cli-hint">{t("ai.cfg.sandboxHint")}</span>
                    </div>
                    {codexDraft.permissionsDefined
                      ? <p className="ai-cli-warning">{t("ai.cfg.shadowedPermissions")}</p>
                      : codexDraft.shadowed ? <p className="ai-cli-warning">{t("ai.cfg.shadowed")}</p> : null}

                    {/* 审批策略与沙箱模式双列同行，绝不各占满一整行全宽 */}
                    <div className="ai-cli-grid">
                      <label className="ai-cli-field">
                        <span>{t("ai.cfg.approval")}</span>
                        <Select value={codexDraft.approvalPolicy} label={t("ai.cfg.approval")} placeholder={t("ai.cfg.approval")}
                          options={CODEX_APPROVAL_POLICIES.map((policy) => ({
                            value: policy,
                            label: policy ? t(`ai.cfg.approval.${policy}` as TranslationKey) : t("ai.cfg.approvalUnset"),
                          }))}
                          onChange={(policy) => editCodex({ approvalPolicy: policy })} />
                      </label>

                      <label className="ai-cli-field">
                        <span>{t("ai.cfg.sandboxMode")}</span>
                        <Select value={codexDraft.sandboxMode} label={t("ai.cfg.sandboxMode")} placeholder={t("ai.cfg.sandboxMode")}
                          disabled={codexDraft.shadowed}
                          options={CODEX_SANDBOX_MODES.map((mode) => ({
                            value: mode,
                            label: mode ? t(`ai.cfg.sandbox.${mode}` as TranslationKey) : t("ai.cfg.sandboxUnset"),
                          }))}
                          onChange={(mode) => editCodex({ sandboxMode: mode })} />
                        <em className="ai-cli-hint">{t("ai.cfg.sandboxModeHint")}</em>
                      </label>
                    </div>

                    {/* Windows 沙箱后端：半宽网格展示，拒绝占满全行 */}
                    {IS_WINDOWS ? (
                      <div className="ai-cli-grid">
                        <CodexEnumField label={t("ai.cfg.winSandbox")} value={codexDraft.windowsSandbox}
                          hint={t("ai.cfg.winSandboxHint")} values={CODEX_WINDOWS_SANDBOX_VALUES} labels={CODEX_WINDOWS_SANDBOX_LABELS}
                          onPick={(value) => editCodex({ windowsSandbox: value })} />
                      </div>
                    ) : null}

                    {/* 细粒度审批列表：内嵌紧凑虚线卡片（与 codeg 一致） */}
                    {codexDraft.approvalPolicy === "granular" ? (
                      <div className="ai-cli-switch-list">
                        <span className="ai-cli-hint">{t("ai.cfg.granularHint")}</span>
                        {CODEX_GRANULAR_FIELDS.map((field) => (
                          <div className="ai-cli-switch-item" key={field.key}>
                            <span>{t(field.label)}</span>
                            <button type="button" role="switch" className="ai-enable-switch"
                              aria-checked={codexDraft.granular[field.key]} aria-label={t(field.label)}
                              onClick={() => editGranular(field.key, !codexDraft.granular[field.key])}>
                              <span />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {/* 工作区写保护辅助配置：对照 codeg 的内嵌虚线卡片 */}
                    {codexWorkspaceWriteApplies ? (
                      <div className="ai-cli-nested-box">
                        <label className="ai-cli-field">
                          <span>{t("ai.cfg.writableRoots")}</span>
                          <textarea className="ai-cli-env" rows={3} spellCheck={false}
                            value={codexDraft.writableRoots.join("\n")}
                            placeholder={"/Users/me/shared\n/srv/cache"}
                            onChange={(event) => editCodex({ writableRoots: event.target.value.split(/\r?\n/) })} />
                          {codexRelativeRoot
                            ? <em className="ai-cli-warning">{t("ai.cfg.writableRootsInvalid", { path: codexRelativeRoot })}</em>
                            : <em className="ai-cli-hint">{t("ai.cfg.writableRootsHint")}</em>}
                        </label>
                        <div className="ai-cli-switch-item">
                          <span>{t("ai.cfg.networkAccess")}</span>
                          <button type="button" role="switch" className="ai-enable-switch"
                            aria-checked={codexDraft.networkAccess} aria-label={t("ai.cfg.networkAccess")}
                            onClick={() => editCodex({ networkAccess: !codexDraft.networkAccess })}>
                            <span />
                          </button>
                        </div>
                        <div className="ai-cli-switch-item">
                          <span>{t("ai.cfg.excludeTmpdir")}</span>
                          <button type="button" role="switch" className="ai-enable-switch"
                            aria-checked={codexDraft.excludeTmpdirEnvVar} aria-label={t("ai.cfg.excludeTmpdir")}
                            onClick={() => editCodex({ excludeTmpdirEnvVar: !codexDraft.excludeTmpdirEnvVar })}>
                            <span />
                          </button>
                        </div>
                        <div className="ai-cli-switch-item">
                          <span>{t("ai.cfg.excludeSlashTmp")}</span>
                          <button type="button" role="switch" className="ai-enable-switch"
                            aria-checked={codexDraft.excludeSlashTmp} aria-label={t("ai.cfg.excludeSlashTmp")}
                            onClick={() => editCodex({ excludeSlashTmp: !codexDraft.excludeSlashTmp })}>
                            <span />
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              )}

              <div className="ai-cli-section-foot">
                {manageNotice?.provider === current
                  ? <p className={manageNotice.error ? "ai-error" : "ai-success"} role="status">{manageNotice.text}</p>
                  : <p className="ai-cli-hint">{t("ai.cfg.applyHint")}</p>}
                <button type="button" className="lsp-action" disabled={!desktop || managedBusy}
                  onClick={() => current === "claude" ? void saveClaudeManage() : void saveCodexManage()}>
                  {managedBusy ? <Loader2 size={13} className="is-spinning" /> : <Save size={13} />}
                  {managedBusy ? t("ai.saving") : t("ai.cfg.save")}
                </button>
              </div>
            </section>

            {current && (current === "claude" || (customModels[current] ?? []).length > 0) ? (
              <section className="ai-cli-section" aria-label={t("ai.custom.title")}>
                <div className="ai-cli-section-head">
                  <div>
                    <strong>{t("ai.custom.title")}</strong>
                    <span className="ai-muted">{t(current === "claude" ? "ai.custom.hint" : "ai.custom.codexRetired")}</span>
                  </div>
                </div>
                {(customModels[current] ?? []).length ? (
                  <div className="ai-custom-models">
                    {(customModels[current] ?? []).map((model) => (
                      <div className="ai-custom-model-row" key={model}>
                        <code title={model}>{model}</code>
                        <button type="button" className="lsp-action" disabled={customBusy} onClick={() => void dropCustomModel(model)}>
                          <Trash2 size={13} />{t("ai.custom.remove")}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : <p className="ai-cli-hint">{t("ai.custom.empty")}</p>}
                <div className="ai-cli-section-foot">
                  {customNotice?.provider === current
                    ? <p className={customNotice.error ? "ai-error" : "ai-success"} role="status">{customNotice.text}</p>
                    : <span />}
                  <div className="ai-cli-actions">
                    {current === "claude" ? (
                      <>
                        <input className="text-input ai-custom-model-input" value={customDraft} maxLength={200} spellCheck={false}
                          placeholder={t("ai.custom.placeholder")} aria-label={t("ai.custom.placeholder")}
                          onChange={(event) => setCustomDraft(event.target.value)}
                          onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void addCustomModel(); } }} />
                        <button type="button" className="lsp-action" disabled={customBusy || !customDraft.trim()} onClick={() => void addCustomModel()}>
                          {customBusy ? <Loader2 size={13} className="is-spinning" /> : <Plus size={13} />}
                          {t("ai.custom.add")}
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              </section>
            ) : null}

            {current === "codex" ? (
              <CodexCatalogSection
                view={catalog}
                draft={catalogDraft}
                loading={catalogLoading}
                busy={catalogBusy}
                dirty={catalogDirty}
                currentModel={codexDraft?.model ?? ""}
                readOnly={currentCodexMode === "provider"}
                notice={catalogNotice}
                onChange={setCatalogDraft}
                onPickDefault={(slug) => {
                  editCodex({ model: slug });
                  setCatalogDraft((prev) => ({ ...prev, default: slug }));
                }}
                onSave={() => void runCatalogSave(catalogDraft)}
                onClear={() => void runCatalogSave(emptyCodexCatalogIntent())}
                onReload={() => guard(() => setCatalogToken((value) => value + 1))} />
            ) : null}

            <section className="ai-cli-section" aria-label={t("ai.config.title")}>
              <div className="ai-cli-section-head">
                <div>
                  <strong>{t("ai.config.title")}</strong>
                  <span className="ai-muted">{t("ai.config.hint", { backup: ".forge.bak" })}</span>
                  {current && fileDirty(current) ? <span className="ai-cli-badge is-checking">{t("ai.unsaved")}</span> : null}
                </div>
                <button type="button" className="lsp-action" disabled={!desktop || fileBusy === current}
                  onClick={() => { if (fileOpen[current]) setFileOpen((value) => ({ ...value, [current]: false })); else void openFile(current); }}>
                  {fileOpen[current] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <FileCode2 size={13} />
                  {t(fileOpen[current] ? "ai.config.hide" : "ai.config.open")}
                </button>
              </div>
              {fileOpen[current] ? <div className="ai-cli-config">
                <div className="ai-cli-config-path">
                  <code>{files[current]?.path ?? "—"}</code>
                  {files[current] && !files[current]?.exists ? <span className="ai-muted">{t("ai.config.missing")}</span> : null}
                </div>
                {files[current]?.error ? <p className="ai-error" role="alert">{files[current]?.error}</p> : null}
                <textarea className="ai-cli-env ai-cli-config-text" spellCheck={false} rows={10}
                  value={fileDrafts[current] ?? ""}
                  aria-label={t("ai.config.title")}
                  onChange={(event) => setFileDrafts((value) => ({ ...value, [current]: event.target.value }))} />
                <div className="ai-cli-section-foot">
                  {fileNotice?.provider === current
                    ? <p className={fileNotice.error ? "ai-error" : "ai-success"} role="status">{fileNotice.text}</p>
                    : <span />}
                  <div className="ai-cli-actions">
                    <button type="button" className="lsp-action" disabled={!desktop || fileBusy === current}
                      onClick={() => guard(() => void reloadFile(current))}>
                      {fileBusy === current ? <Loader2 size={13} className="is-spinning" /> : <RefreshCw size={13} />}
                      {t("ai.config.reload")}
                    </button>
                    <button type="button" className="lsp-action" disabled={!desktop || fileBusy === current}
                      onClick={() => void saveFile(current)}>
                      {fileBusy === current ? <Loader2 size={13} className="is-spinning" /> : <Save size={13} />}
                      {t("ai.config.save")}
                    </button>
                  </div>
                </div>
              </div> : null}
            </section>
          </div>
        </> : <p className="ai-cli-empty">{t("ai.selectAgentHint")}</p>}
      </section>

      {pending ? <AiActionDialog title={`${t(`ai.${pending.action}`)} ${AI_NAMES[pending.provider]}`}
        confirm={t(`ai.${pending.action}`)} danger={pending.action === "uninstall"}
        onCancel={() => setPending(null)} onConfirm={() => {
          const target = pending.provider;
          void manageAiCli(target, pending.action).then(() => loadChecks(target));
          setPending(null);
        }}>
        <p className="dialog-body">{t(pending.action === "uninstall" ? "ai.uninstallConfirm" : "ai.installConfirm", { name: AI_NAMES[pending.provider] })}</p>
        {pending.action !== "uninstall" ? <p className="dialog-note">{t(pending.provider === "claude" ? "ai.claudeMethod" : "ai.codexMethod")} · {cli.statuses[pending.provider]?.latestVersion ?? "—"}</p> : null}
        <p className="dialog-note">{t("ai.confirmRecheck")}</p>
      </AiActionDialog> : null}

      {pendingReload ? <AiActionDialog title={t("ai.discardTitle")} confirm={t("ai.discard")} danger
        onCancel={() => setPendingReload(null)}
        onConfirm={() => { const run = pendingReload; setPendingReload(null); run(); }}>
        <p className="dialog-body">{t("ai.discardHint")}</p>
      </AiActionDialog> : null}
    </div>
  );
}
