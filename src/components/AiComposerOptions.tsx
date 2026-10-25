import { useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { Ref } from "react";
import type { LocalCommand } from "../lib/aiCommands";
export interface AiComposerHandle { execute: (command: LocalCommand, args: string) => Promise<void> }
import { Check, ChevronDown, Search } from "lucide-react";
import { useI18n } from "../i18n";
import { loadAiCapabilities, refreshAiCapabilities, saveAiCustomModel } from "../lib/aiRuntime";
import type { AiCapabilities, AiRunOptions } from "../lib/aiRuntime";
import type { AiProvider } from "../lib/aiCli";
import { cliDesktopAvailable } from "../lib/aiCli";
import { aiNormalMode, resolveAiModel } from "../lib/aiOptions";
import AiProviderIcon from "./AiProviderIcon";
import Popover from "./Popover";
import AiActionDialog from "./AiActionDialog";
export { readAiOptions } from "../lib/aiOptions";

interface AiComposerOptionsProps {
  commandRef?: Ref<AiComposerHandle>;
  provider: AiProvider;
  workspace: string | null;
  value: AiRunOptions;
  onChange: (value: AiRunOptions) => void;
  disabled?: boolean;
  /** 实际运行的模型（CLI 上报）；`/model` 无参默认与匹配提示用。 */
  actualModel?: string;
}

const effortKeys = { none: "ai.chat.effort.none", minimal: "ai.chat.effort.minimal", low: "ai.chat.effort.low", medium: "ai.chat.effort.medium", high: "ai.chat.effort.high", xhigh: "ai.chat.effort.xhigh", max: "ai.chat.effort.max" } as const;
/** Claude 的 --effort 是会话级参数，不随别名（例如 Haiku）被目录里的空档位列表挡住。 */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/**
 * 已知模式一律用本地名字，中文界面里不夹 `auto`、`dontAsk` 这种半截英文。
 * CLI 新增、我们还没命名的档位原样报出它的 id：不替别人的功能编名字，也不因为「没翻译」就把它藏掉。
 */
const modeKeys = {
  default: "ai.chat.modeDefault",
  plan: "ai.chat.planMode",
  manual: "ai.chat.permissionAsk",
  acceptEdits: "ai.chat.permissionEdits",
  auto: "ai.chat.modeAuto",
  dontAsk: "ai.chat.modeDontAsk",
  bypassPermissions: "ai.chat.permissionFull",
} as const;
/** 档位名本身说不清放行了什么，鼠标停上去要能看见边界。 */
const modeHintKeys = {
  default: "ai.chat.modeDefaultHint",
  plan: "ai.chat.planModeHint",
  manual: "ai.chat.modeManualHint",
  acceptEdits: "ai.chat.modeEditsHint",
  auto: "ai.chat.modeAutoHint",
  dontAsk: "ai.chat.modeDontAskHint",
  bypassPermissions: "ai.chat.modeBypassHint",
} as const;
/** 探测没成功时的兜底表，只够把界面摆出来，不能当成这版 CLI 的事实。 */
const FALLBACK_MODES: Record<AiProvider, string[]> = {
  claude: ["manual", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"],
  codex: ["default", "plan"],
};
/** 跳过全部工具审批的档位：点它要当面确认。 */
const DANGEROUS_MODES = ["bypassPermissions"];
/** 旧 /permissions 的四档别名 → Claude 的模式原话（Claude 的权限档和模式是同一条轴）。 */
const CLAUDE_MODE_ALIASES: Record<string, string> = { read: "plan", ask: "manual", auto: "acceptEdits", full: "bypassPermissions" };

/**
 * 输入框的「设置芯片」：模型 / 强度 / 模式 / 权限收进一颗圆角芯片，点开向上弹出
 * 参考样式的设置面板——可搜索的模型列表（勾选、等宽 id 提示、默认徽标）、
 * 强度、模式和权限的分段控件、Fast 开关。模式档位来自 CLI 自己报出的取值，
 * 计划模式是其中一项而不是一个开关。自定义模型在设置页维护，
 * 输入框里只负责选择，不提供增删或手动刷新入口。
 *
 * 兼容旧斜杠命令：`commandRef.execute` 仍支持 /model /effort /permissions /fast
 * 与无参打开面板；上下文芯片已拆去 `AiContextChip`（盒下状态行）。
 */
export default function AiComposerOptions({ commandRef, provider, workspace, value, onChange, disabled = false, actualModel }: AiComposerOptionsProps) {
  const { t } = useI18n();
  const effortLabel = (effort: string) => effort in effortKeys ? t(effortKeys[effort as keyof typeof effortKeys]) : effort;
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<AiCapabilities | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<AiRunOptions | null>(null);
  const [open, setOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  // 用户保存优先于更早发出的后台刷新，避免迟到结果暂时隐藏自定义模型。
  const catalogRevision = useRef(0);
  const id = useId();
  // 记忆上一次选择：两个引擎都读写 Forge 的会话选项（随会话持久化），不碰 CLI 原生配置。
  const configuredValue = value;
  const selectedModelId = resolveAiModel(capabilities, configuredValue?.model);
  const actualModelId = resolveAiModel(capabilities, actualModel);
  const effectiveModelId = selectedModelId || actualModelId;
  const model = capabilities?.models.find((item) => effectiveModelId ? item.id === effectiveModelId : item.isDefault);
  const isCustomSelected = !model && !!configuredValue?.model;
  // 修正已保存的显示名/大小写变体；不重置强度、权限或未知自定义 ID。
  useEffect(() => {
    if (capabilities && value.model && selectedModelId !== value.model) onChange({ ...value, model: selectedModelId });
  }, [provider, capabilities, value.model, selectedModelId]);
  const fastTier = model?.serviceTiers?.find((tier) => tier.name.toLowerCase() === "fast")?.id;
  const fastAvailable = !!fastTier;
  const fastEnabled = !!fastTier && value.fast === true;
  const efforts = provider === "claude"
    ? (capabilities?.efforts?.length ? capabilities.efforts : CLAUDE_EFFORTS)
    : model?.efforts ?? capabilities?.efforts ?? [];
  // 目录来源要说清三件事：是不是 CLI 亲口报的、是不是这次现问的、哪一版报的。
  const catalogSource = !capabilities ? null : capabilities.authoritative
    ? t(capabilities.remote ? "ai.chat.catalogCliLive" : "ai.chat.catalogCliCached", { version: capabilities.cliVersion ?? "—" })
    : t("ai.chat.catalogBuiltIn");
  const close = () => { setOpen(false); chip.current?.focus(); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!workspace || !cliDesktopAvailable()) return;
    let cancelled = false;
    const revision = catalogRevision.current;
    setLoading(true);
    // 先发布本地目录，后台探测再写回；两步都不禁用模型输入或发送。
    void (async () => {
      try {
        const data = await loadAiCapabilities(provider, workspace);
        if (cancelled || revision !== catalogRevision.current) return;
        setCapabilities(data); setError(null);
      } catch (cause) {
        if (!cancelled) setLoading(false);
        return;
      }
      try {
        const fresh = await refreshAiCapabilities(provider, workspace);
        if (!cancelled && revision === catalogRevision.current) setCapabilities(fresh);
      } catch { /* 缓存仍可用；只有用户手动刷新才展示失败。 */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [provider, workspace]);
  const rememberModel = async (target: string) => {
    if (!target || capabilities?.models.some((item) => item.id === target)) return;
    const revision = ++catalogRevision.current;
    await saveAiCustomModel(provider, target);
    const data = workspace ? await loadAiCapabilities(provider, workspace) : null;
    if (alive.current && revision === catalogRevision.current && data) setCapabilities(data);
  };
  useEffect(() => {
    if (!open) { setModelQuery(""); return; }
    popover.current?.focus();
    // 设置页随时可能增删自定义模型：每次打开都从 Forge 的目录缓存重读一次，
    // 只读磁盘、不探测 CLI，因此不会因为少了刷新按钮而看不到新模型。
    const revision = catalogRevision.current;
    if (workspace) void loadAiCapabilities(provider, workspace)
      .then((data) => { if (alive.current && revision === catalogRevision.current) setCapabilities(data); })
      .catch(() => { /* 保留当前列表 */ });
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || (event.target as HTMLElement)?.closest?.('[role="listbox"]')) return;
      event.preventDefault(); close();
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", dismiss, true); window.removeEventListener("keydown", escape); };
  }, [open, provider, workspace]);

  const pickModel = async (nextId: string | undefined, targetModel = capabilities?.models.find((item) => nextId ? item.id === nextId : item.isDefault)) => {
    onChange({
      ...value, model: nextId || undefined,
      // Claude 的强度属于会话，切换模型不清掉；Codex 的强度是模型能力，换到不支持的模型才清。
      effort: provider === "claude" || !value.effort || !targetModel || targetModel.efforts.includes(value.effort) ? value.effort : undefined,
      fast: value.fast && !!targetModel?.serviceTiers?.some((tier) => tier.name.toLowerCase() === "fast"),
    });
  };
  // Codex 的权限档（沙箱与审批）和协作模式是两条轴，两个控件并存；
  // Claude 只有一个 --permission-mode，计划模式就排在这条列表里。
  const permissionOptions = useMemo(() => [
    { value: "read", label: t("ai.chat.permissionRead") },
    { value: "ask", label: t("ai.chat.permissionAsk") },
    { value: "auto", label: t("ai.chat.permissionEdits") },
    { value: "full", label: t("ai.chat.permissionFull") },
  ], [t]);
  const permission = value.permission ?? (provider === "codex" ? "inherit" : "ask");
  const modeLabel = (id: string) => id in modeKeys ? t(modeKeys[id as keyof typeof modeKeys]) : id;
  const modeHint = (id: string) => id in modeHintKeys ? t(modeHintKeys[id as keyof typeof modeHintKeys]) : undefined;
  // 模式列表来自 CLI 亲口报的取值；没探测到才用兜底表，避免面板整个空掉。
  // 只把「正常」档挪到第一格：CLI 的取值是字母序，照原样排会让完全访问抢在按需审批前面。
  const modes = useMemo(() => {
    const ids = capabilities?.modes?.length ? capabilities.modes : FALLBACK_MODES[provider];
    const normal = aiNormalMode(provider);
    return ids.includes(normal) ? [normal, ...ids.filter((id) => id !== normal)] : ids;
  }, [capabilities, provider]);
  // 旧会话只有 planMode/permission：按同一语义迁移成一项模式，而不是当成没选。
  const mode = value.mode ?? (value.planMode ? "plan" : provider === "codex" ? "default" : CLAUDE_MODE_ALIASES[permission] ?? aiNormalMode(provider));
  const setMode = (next: string) => {
    // 选中新模式就把旧的计划模式布尔清掉：两者同义，留着会让徽标一直亮。
    if (DANGEROUS_MODES.includes(next)) { setPending({ ...value, planMode: undefined, mode: next }); return; }
    onChange({ ...value, planMode: undefined, mode: next });
  };
  const setPermission = (next: string) => {
    if (next === "custom") return;
    if (next === "full") { setPending({ ...value, permission: "full" }); return; }
    onChange({ ...value, permission: next as AiRunOptions["permission"] });
  };
  // CLI 升级后撤掉的档位不能继续显示成「用户正选着它」：退回正常档并说明原因。
  // 只有实测回报过的列表才有资格下这个结论，兜底表不能反过来否定用户的记忆。
  useEffect(() => {
    if (!capabilities?.modes?.length || !capabilities.modesAuthoritative) return;
    if (!value.mode || value.mode === aiNormalMode(provider) || capabilities.modes.includes(value.mode)) return;
    onChange({ ...value, planMode: undefined, mode: aiNormalMode(provider) });
    setError(t("ai.chat.modeRetired", { mode: value.mode }));
  }, [capabilities, value, provider, t]);

  /** 模型列表按「默认 / 自定义 / 目录」分组，输入框按名称与 id 过滤。 */
  const query = modelQuery.trim().toLowerCase();
  const models = useMemo(() => {
    if (!capabilities) return [];
    return capabilities.models.filter((item) => !query || [item.id, item.name, item.catalogId].some((text) => text?.toLowerCase().includes(query)));
  }, [capabilities, query]);
  /** 用户自己加的模型单独成组，排在目录之后：先给 CLI 自带/配置好的，再放自己加的。 */
  const modelGroups = useMemo(() => {
    const custom = new Set(capabilities?.customModels ?? []);
    const own = models.filter((item) => custom.has(item.id) || item.customOption);
    const rest = models.filter((item) => !custom.has(item.id) && !item.customOption);
    return [
      { key: "catalog", label: own.length && rest.length ? t("ai.chat.modelGroupCatalog") : "", items: rest },
      { key: "custom", label: own.length ? t("ai.custom.title") : "", items: own },
    ].filter((group) => group.items.length);
  }, [capabilities, models, t]);
  const summaryParts = [
    model?.name ?? (configuredValue?.model || actualModel || t("ai.chat.model")),
    efforts.length ? effortLabel(configuredValue?.effort ?? model?.defaultEffort ?? "") : "",
    modeLabel(mode),
    provider === "codex" && value.permission ? permissionOptions.find((option) => option.value === value.permission)?.label ?? "" : "",
  ].filter(Boolean);

  useImperativeHandle(commandRef, () => ({ execute: async (command, rawArgs) => {
    const arg = rawArgs.trim();
    const invalid = () => new Error(t("ai.commands.invalidArgs"));
    if (command === "settings") {
      if (arg) throw invalid();
      if (disabled) throw new Error(t("ai.commands.busy"));
      setOpen(true); return;
    }
    if (disabled) throw new Error(t("ai.commands.busy"));
    if (!arg && (command === "model" || command === "effort" || command === "permissions")) { setOpen(true); return; }
    if (command === "fast" && (provider !== "codex" || !["", "on", "off"].includes(arg))) throw invalid();
    if (command === "fast" && (arg === "off" || !arg && fastEnabled)) {
      onChange({ ...value, fast: false });
      return;
    }
    if (!workspace) throw new Error(t("ai.noWorkspace"));
    const catalog = capabilities ?? await loadAiCapabilities(provider, workspace);
    if (!alive.current) throw new Error(t("ai.commands.busy"));
    setCapabilities(catalog);
    const selectedId = resolveAiModel(catalog, configuredValue?.model || actualModel);
    const selected = catalog.models.find((item) => selectedId ? item.id === selectedId : item.isDefault);
    if (command === "model") {
      const next = arg === "default" ? undefined : resolveAiModel(catalog, arg);
      if (next && (/\s/u.test(next) || next.length > 200 || next.startsWith("-"))) throw invalid();
      const target = catalog.models.find((item) => next ? item.id === next : item.isDefault);
      if (next && !target && !catalog.customModel) throw invalid();
      if (next && !target) await rememberModel(next);
      await pickModel(next, target);
    } else if (command === "effort") {
      const allowed = provider === "claude" ? CLAUDE_EFFORTS : selected?.efforts ?? catalog.efforts;
      if (arg !== "default" && !allowed.includes(arg)) throw invalid();
      onChange({ ...value, effort: arg === "default" ? undefined : arg });
    } else if (command === "permissions") {
      // 参数先按这版 CLI 报出的模式原话匹配，再用旧别名兜住既有用法；
      // 两边都不认就报错：没验证过的字符串不能当成模式发给 CLI。
      const ids = catalog.modes?.length ? catalog.modes : FALLBACK_MODES[provider];
      const alias = ids.includes(arg) ? arg : provider === "claude" ? CLAUDE_MODE_ALIASES[arg] : undefined;
      if (alias && ids.includes(alias)) setMode(alias);
      else if (provider === "codex" && ["read", "ask", "auto", "full"].includes(arg)) setPermission(arg);
      else throw invalid();
    } else if (command === "fast") {
      const tier = (selected ?? catalog.models.find((item) => item.isDefault))?.serviceTiers?.find((item) => item.name.toLowerCase() === "fast");
      if (!tier) throw invalid();
      onChange({ ...value, fast: true });
    } else throw invalid();
  } }), [provider, workspace, value, configuredValue, capabilities, actualModel, disabled, fastEnabled]);

  return <div ref={root} className="ai-options">
    <button
      ref={chip}
      type="button"
      className="ai-settings-chip"
      title={`${t("ai.chat.settings")} · ${summaryParts.join(" / ")}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      disabled={disabled}
      onClick={() => setOpen((value) => !value)}
    >
      <AiProviderIcon provider={provider} size={14} />
      <span className="ai-settings-summary">{summaryParts.join(" / ")}</span>
      <ChevronDown size={12} aria-hidden />
    </button>
    {open ? (
      <Popover anchor={chip.current} onClose={close} minWidth={352} maxWidth={352} modal={false}>
        <div ref={popover} className="ai-settings-popover" role="dialog" aria-label={t("ai.chat.settings")} tabIndex={-1}>
          <div className="ai-model-block">
            <label className="ai-model-search">
              <Search size={14} aria-hidden />
              <input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} role="combobox"
                aria-expanded aria-controls={`${id}-models`} aria-label={t("ai.chat.searchModels")}
                placeholder={t("ai.chat.searchModels")} spellCheck={false} />
            </label>
            <div className="ai-model-list" id={`${id}-models`} role="listbox" aria-label={t("ai.chat.model")}>
              {loading && !capabilities ? <p className="ai-model-status">{t("ai.chat.loading")}</p> : null}
              {modelGroups.map((group) => <div key={group.key} className="ai-model-section">
                {group.label ? <p className="ai-model-group" role="presentation">{group.label}</p> : null}
                {group.items.map((item) => {
                  const active = effectiveModelId ? item.id === effectiveModelId : item.isDefault;
                  return <button key={item.id} type="button" role="option" aria-selected={active}
                    className={`ai-model-option${active ? " is-selected" : ""}`}
                    onClick={() => void pickModel(item.id)}>
                    <span className="ai-option-check" aria-hidden>{active ? <Check size={14} /> : null}</span>
                    <span className="ai-option-body">
                      <span className="ai-option-name">
                        <span className="ai-option-title">{item.name}</span>
                        {item.isDefault ? <span className="ai-option-badge">{t("ai.chat.defaultModel")}</span> : null}
                      </span>
                      {item.customOption && item.description ? <span className="ai-option-hint" title={item.description}>{item.description}</span>
                        : item.customSlot ? <span className="ai-option-hint">{t("ai.chat.customSlotModel", { slot: item.customSlot })}</span>
                        : item.id === "default" && item.configuredModel ? <span className="ai-option-hint" title={item.configuredModel}>{item.configuredModel}</span>
                        : item.id !== item.name ? <span className="ai-option-hint" title={item.id}>{item.id}</span> : null}
                    </span>
                  </button>;
                })}
              </div>)}
              {capabilities && !models.length && !isCustomSelected ? <p className="ai-model-status">{t("ai.chat.noModels")}</p> : null}
            </div>
          </div>
          {efforts.length ? <>
            <div className="ai-settings-sep" aria-hidden />
            <div className="ai-settings-block">
              <div className="ai-settings-header"><span>{t("ai.chat.effort")}</span></div>
              <div className="ai-segmented" role="group" aria-label={t("ai.chat.effort")}>
                {(provider === "codex" ? [] : [{ value: "", label: t("ai.chat.defaultEffort") }]).concat(efforts.map((effort) => ({ value: effort, label: effortLabel(effort) }))).map((option) => {
                  const effortValue = value.effort ?? "";
                  const active = effortValue === option.value;
                  return <button key={option.value || "default"} type="button" aria-pressed={active} className={active ? "is-on" : ""}
                    onClick={() => onChange({ ...value, effort: option.value || undefined })}>
                    {option.label}
                  </button>;
                })}
              </div>
            </div>
          </> : null}
          <div className="ai-settings-sep" aria-hidden />
          <div className="ai-settings-block">
            <div className="ai-settings-header"><span>{t("ai.chat.mode")}</span></div>
            <div className="ai-segmented" role="group" aria-label={t("ai.chat.mode")}>
              {modes.map((option) => {
                const active = mode === option;
                return <button key={option} type="button" aria-pressed={active} className={active ? "is-on" : ""}
                  disabled={disabled} title={modeHint(option)}
                  onClick={() => setMode(option)}>{modeLabel(option)}</button>;
              })}
            </div>
          </div>
          {/* Claude 的 --permission-mode 就是上面这条列表，没有第二条轴；Codex 的沙箱档与协作模式互不相干。 */}
          {provider === "codex" ? <>
            <div className="ai-settings-sep" aria-hidden />
            <div className="ai-settings-block">
              <div className="ai-settings-header"><span>{t("ai.chat.permissions")}</span></div>
              <div className="ai-segmented" role="group" aria-label={t("ai.chat.permissions")}>
                {permissionOptions.map((option) => (
                  <button key={option.value} type="button" disabled={disabled} aria-pressed={permission === option.value} className={permission === option.value ? "is-on" : ""}
                    onClick={() => setPermission(option.value)}>{option.label}</button>
                ))}
              </div>
            </div>
          </> : null}
          {mode === "plan" ? <p className="ai-settings-source">{t("ai.chat.planModeHint")}</p> : null}
          {provider === "codex" ? <>
            <div className="ai-settings-sep" aria-hidden />
            <label className="ai-switch-row" title={t(fastAvailable ? "ai.chat.fastHint" : "ai.chat.fastUnavailable")}>
              <span>{t("ai.chat.fast")}</span>
              <button type="button" role="switch" aria-checked={fastEnabled} disabled={disabled || !fastAvailable}
                onClick={() => onChange({ ...value, fast: !fastEnabled })}>
                <span className="ai-switch-knob" aria-hidden />
              </button>
            </label>
          </> : null}
          {error ? <p className="ai-error" role="alert">{error}</p> : null}
          <p className="ai-settings-source" title={catalogSource ?? undefined}>{catalogSource}</p>
        </div>
      </Popover>
    ) : null}
    {pending ? <AiActionDialog danger title={t("ai.chat.permissionFull")} confirm={t("ai.chat.confirmFull")} onCancel={() => setPending(null)}
      onConfirm={() => { if (!disabled) onChange(pending); setPending(null); }}>
      <p className="dialog-body">{t("ai.chat.fullWarning")}</p>
    </AiActionDialog> : null}
  </div>;
}
