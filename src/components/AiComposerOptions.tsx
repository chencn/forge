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
import { resolveAiModel } from "../lib/aiOptions";
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
 * 输入框的「设置芯片」：模型 / 强度 / 权限收进一颗圆角芯片，点开向上弹出
 * 参考样式的设置面板——可搜索的模型列表（勾选、等宽 id 提示、默认徽标）、
 * 强度与权限的分段控件、Fast 开关。自定义模型在设置页维护，
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
  const [confirmFull, setConfirmFull] = useState(false);
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
  const permissionOptions = useMemo(() => [
    ...(provider === "codex" ? [{ value: "read", label: t("ai.chat.permissionRead") }] : []),
    { value: "ask", label: t("ai.chat.permissionAsk") },
    { value: "auto", label: t("ai.chat.permissionEdits") },
    { value: "full", label: t("ai.chat.permissionFull") },
  ], [provider, t]);
  const permission = value.permission ?? (provider === "codex" ? "inherit" : "ask");
  const setPermission = (next: string) => {
    if (next === "custom") return;
    // 计划模式与完全访问互斥：计划只读，完全访问会绕过它。
    if (next === "full") setConfirmFull(true);
    else onChange({ ...value, permission: next as AiRunOptions["permission"] });
  };

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
    value.permission ? permissionOptions.find((option) => option.value === value.permission)?.label ?? "" : "",
    value.planMode ? t("ai.chat.planMode") : "",
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
    if (command === "permissions") {
      if (!["ask", "auto", "full", ...(provider === "codex" ? ["read"] : [])].includes(arg)) throw invalid();
      setPermission(arg); return;
    }
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
            <div className="ai-settings-header"><span>{t("ai.chat.permissions")}</span></div>
            <div className="ai-segmented" role="group" aria-label={t("ai.chat.permissions")}>
              {permissionOptions.map((option) => (
                <button key={option.value} type="button" aria-pressed={permission === option.value} className={permission === option.value ? "is-on" : ""}
                  onClick={() => setPermission(option.value)}>{option.label}</button>
              ))}
            </div>
          </div>
          <div className="ai-settings-sep" aria-hidden />
          <label className="ai-switch-row" title={t("ai.chat.planModeHint")}>
            <span>{t("ai.chat.planMode")}</span>
            <button type="button" role="switch" aria-checked={value.planMode === true} disabled={disabled || permission === "full"}
              onClick={() => onChange({ ...value, planMode: !value.planMode })}>
              <span className="ai-switch-knob" aria-hidden />
            </button>
          </label>
          {value.planMode ? <p className="ai-settings-source">{t("ai.chat.planModeHint")}</p> : null}
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
    {confirmFull ? <AiActionDialog danger title={t("ai.chat.permissionFull")} confirm={t("ai.chat.confirmFull")} onCancel={() => setConfirmFull(false)}
      onConfirm={() => { if (!disabled) onChange({ ...value, permission: "full", planMode: false }); setConfirmFull(false); }}>
      <p className="dialog-body">{t("ai.chat.fullWarning")}</p>
    </AiActionDialog> : null}
  </div>;
}
