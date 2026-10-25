import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, Plus, RefreshCw, Save, Star, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import Select from "./Select";
import type { TranslationKey } from "../i18n/lang/zh";
import {
  CODEX_CLEAR,
  CODEX_INHERIT,
  applyCodexCompatPreset,
  codexFieldDomain,
  codexModelEfforts,
  emptyCodexModelOverride,
  isCodexCompatModel,
  readAiCliCodexCatalogText,
} from "../lib/aiManage";
import type { CodexCatalogIntent, CodexCatalogView, CodexCustomModel, CodexEnumKey, CodexModelOverride } from "../lib/aiManage";

/**
 * 界面按这张表渲染枚举覆盖项。选项不写死：每个字段的取值域和「能不能清除」都来自后端
 * 现问 Codex 的结果（`view.domains`），问不到才退回兜底表并标成未核实——写非法值或往必填
 * 字段写 null 会让整份目录被 Codex 拒掉，所以这张表必须是这一版 CLI 的话。
 */
const OVERRIDE_ENUM_FIELDS: { key: CodexEnumKey; label: TranslationKey; protocol: boolean }[] = [
  { key: "toolMode", label: "ai.catalog.toolMode", protocol: true },
  { key: "multiAgentVersion", label: "ai.catalog.multiAgentVersion", protocol: true },
  { key: "defaultReasoningSummary", label: "ai.catalog.reasoningSummary", protocol: false },
  { key: "defaultVerbosity", label: "ai.catalog.verbosity", protocol: false },
  { key: "shellType", label: "ai.catalog.shellType", protocol: false },
  { key: "applyPatchToolType", label: "ai.catalog.applyPatch", protocol: false },
  { key: "webSearchToolType", label: "ai.catalog.webSearch", protocol: false },
  { key: "visibility", label: "ai.catalog.visibility", protocol: false },
];

/** 开关的中文名；CLI 里新出现的键原样报出它的名字，不替 Codex 编文案。 */
const FLAG_LABEL: Record<string, TranslationKey> = {
  support_verbosity: "ai.catalog.flagSupportVerbosity",
  supports_search_tool: "ai.catalog.flagSearchTool",
  supports_image_detail_original: "ai.catalog.flagImageDetail",
  include_apps_usage_instructions: "ai.catalog.flagAppsUsage",
  include_plugin_usage_instructions: "ai.catalog.flagPluginUsage",
  include_skills_usage_instructions: "ai.catalog.flagSkillsUsage",
  use_responses_lite: "ai.catalog.flagResponsesLite",
  supports_reasoning_summary_parameter: "ai.catalog.flagSummaryParam",
};

const slugOf = (model: Record<string, unknown>) => String(model.slug ?? "");
const nameOf = (model: Record<string, unknown>) => String(model.display_name ?? "") || slugOf(model);
/** Codex 的目录里本来就有不进菜单的条目（0.164：daybreak 两个与 codex-auto-review）。
 *  它们不该出现在可排除的名单里——把它们排除掉，等于悄悄把 Codex 自己在用的内部模型删了。 */
const isListable = (model: Record<string, unknown>) => String(model.visibility ?? "list") === "list";

/**
 * 覆盖项是否等于没覆盖。空串是「显式清除」，那是一个真实的覆盖，不能当成空——
 * 后端会拒绝空覆盖项，误判成空只会让保存失败或把用户刚点的清除丢掉。
 */
function overrideIsEmpty(item: CodexModelOverride): boolean {
  const has = (value: string | null | undefined) => value !== undefined && value !== null;
  return OVERRIDE_ENUM_FIELDS.every((field) => !has(item[field.key] as string | null | undefined))
    && !has(item.baseInstructions)
    && item.contextWindow === undefined
    && item.maxContextWindow === undefined
    && Object.keys(item.flags).length === 0;
}

/** 数字框自己拿字符串：直接绑数字会让用户打一半就被吃掉。 */
function NumberField({ label, invalidHint, value, placeholder, onCommit }: {
  label: string;
  invalidHint: string;
  value: number | null | undefined;
  placeholder: string;
  onCommit: (next: number | undefined) => void;
}) {
  const [text, setText] = useState(value === undefined || value === null ? "" : String(value));
  const [dirtyText, setDirtyText] = useState(false);
  const invalid = dirtyText && text.trim() !== "" && !/^\d+$/.test(text.trim());
  return (
    <label className="ai-cli-field">
      <span>{label}</span>
      <input className="text-input" inputMode="numeric" spellCheck={false} value={text}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          setDirtyText(true);
          const trimmed = next.trim();
          if (trimmed === "") { onCommit(undefined); setDirtyText(false); return; }
          if (/^\d+$/.test(trimmed)) { onCommit(Number(trimmed)); setDirtyText(false); }
        }} />
      {invalid ? <em className="ai-cli-warning">{invalidHint}</em> : null}
    </label>
  );
}

interface CodexCatalogSectionProps {
  view: CodexCatalogView | null;
  draft: CodexCatalogIntent;
  loading?: boolean;
  busy?: boolean;
  dirty?: boolean;
  /** config.toml 当前的 `model`，用来标出默认模型。 */
  currentModel?: string;
  notice?: { error: boolean; text: string } | null;
  /** 嵌入在供应商抽屉模式：隐藏独立保存/清退按钮与外层独立标题。 */
  embedded?: boolean;
  readOnly?: boolean;
  onChange: (next: CodexCatalogIntent) => void;
  onPickDefault?: (slug: string) => void;
  onSave?: () => void;
  onClear?: () => void;
  onReload?: () => void;
}

/**
 * Codex 模型清单。`model_catalog_json` 是整份替换语义，所以这里编辑的都是「在 Codex 自带目录之上的覆盖项」，
 * 列表展示的是合并之后 Codex 实际会看到的值，而不是用户填的原始值。
 */
export default function CodexCatalogSection(props: CodexCatalogSectionProps) {
  const { view, draft, loading = false, busy = false, dirty = false, currentModel = "", notice = null, embedded = false, readOnly = false } = props;
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const customSlugs = new Set(draft.customs.map((item) => item.slug).filter((slug) => slug !== ""));
  const models = view?.models ?? [];
  // 可克隆的模板是全部官方条目；但只有会进菜单的那些才列出来供排除。
  const officials = models.filter((model) => !customSlugs.has(slugOf(model)));
  const listableOfficials = officials.filter(isListable);
  /** 开关列表由后端实测；探不到时它给的是整张候选表，界面另加一句「未核实」。 */
  const flags = view?.flags?.length ? view.flags : [];
  const [instructions, setInstructions] = useState<Record<string, { text: string; loaded: boolean }>>({});
  /** 展开谁就取谁的模板条目文本；整份目录里这一段占两成体积，不跟着列表一起塞进来。 */
  const pendingSlug = open === null ? "" : open.startsWith("custom:")
    ? draft.customs[Number(open.slice("custom:".length))]?.base ?? ""
    : open;
  useEffect(() => {
    if (!pendingSlug || instructions[pendingSlug]) return;
    let alive = true;
    void readAiCliCodexCatalogText(pendingSlug)
      .then((text) => { if (alive) setInstructions((value) => ({ ...value, [pendingSlug]: { text: text ?? "", loaded: true } })); })
      .catch(() => { if (alive) setInstructions((value) => ({ ...value, [pendingSlug]: { text: "", loaded: true } })); });
    return () => { alive = false; };
  }, [pendingSlug, instructions]);
  const inheritedText = (slug: string) => instructions[slug] ?? { text: "", loaded: false };

  const isShown = (slug: string) =>
    draft.customs.some((c) => c.slug === slug) ||
    listableOfficials.some((m) => slugOf(m) === slug);
  const effectiveDefault =
    draft.default && isShown(draft.default)
      ? draft.default
      : (draft.customs[0]?.slug || (listableOfficials[0] ? slugOf(listableOfficials[0]) : "") || currentModel);

  const pickDefault = (slug: string) => {
    props.onChange({ ...draft, default: slug });
    props.onPickDefault?.(slug);
  };

  /** 覆盖项的读写按目标走：官方模型进 `overrides[slug]`，自定义模型进 `customs[i].overrides`。 */
  const editorFor = (read: () => CodexModelOverride, write: (next: CodexModelOverride) => void, model: Record<string, unknown>, templateSlug: string) => {
    const current = read();
    const apply = (patch: Partial<CodexModelOverride>) => {
      const next = { ...current, ...patch };
      write(next);
    };
    const efforts = codexModelEfforts(model);
    /** 三个字段的分组照 Codex 目录自己的意思分：能不能连上、怎么表现、发什么提示词。 */
    const fieldFor = (field: (typeof OVERRIDE_ENUM_FIELDS)[number]) => {
      const domain = codexFieldDomain(view, field.key);
      const value = current[field.key] as string | null | undefined;
      const options = [
        { value: CODEX_INHERIT, label: t("ai.catalog.unset") },
        // 「无」= 往目录里写 null。Codex 只在可选字段上接受它，必填字段给了就是整份拒掉。
        ...(domain.nullable ? [{ value: CODEX_CLEAR, label: t("ai.catalog.none") }] : []),
        ...domain.values.map((option) => ({ value: option, label: option })),
      ];
      return (
        <div className="ai-cli-field" key={field.key}>
          <span>{t(field.label)}</span>
          <Select
            value={value === undefined || value === null ? CODEX_INHERIT : value === "" ? CODEX_CLEAR : value}
            label={t(field.label)}
            placeholder={t("ai.catalog.unset")}
            options={options}
            onChange={(next) => apply({
              [field.key]: next === CODEX_INHERIT ? undefined : next === CODEX_CLEAR ? "" : next,
            } as Partial<CodexModelOverride>)} />
        </div>
      );
    };
    const flagFor = (flag: string) => {
      const label = FLAG_LABEL[flag] ?? null;
      return (
        <div className="ai-cli-row-switch" key={flag}>
          <span>{label ? t(label) : flag}</span>
          <button type="button" role="switch" className="ai-enable-switch" aria-checked={model[flag] === true} aria-label={label ? t(label) : flag}
            disabled={busy} onClick={() => apply({ flags: { ...current.flags, [flag]: model[flag] !== true } })}>
            <span />
          </button>
        </div>
      );
    };
    const inherited = inheritedText(templateSlug);
    return (
      <div className="ai-catalog-override">
        {view && (!view.flagsVerified || Object.values(view.domains ?? {}).some((domain) => !domain.verified))
          ? <em className="ai-cli-hint">{t("ai.catalog.unverified")}</em>
          : null}
        <p className="ai-cli-group">{t("ai.catalog.groupProtocol")}</p>
        <div className="ai-cli-grid">
          {OVERRIDE_ENUM_FIELDS.filter((field) => field.protocol).map(fieldFor)}
          {flags.filter((flag) => flag === "use_responses_lite").map(flagFor)}
        </div>
        <p className="ai-cli-group">{t("ai.catalog.groupBehavior")}</p>
        <div className="ai-cli-grid">
          <div className="ai-cli-field">
            <span>{t("ai.catalog.reasoningLevel")}</span>
            <Select
              value={current.defaultReasoningLevel ?? CODEX_INHERIT}
              label={t("ai.catalog.reasoningLevel")}
              placeholder={t("ai.catalog.unset")}
              options={[{ value: CODEX_INHERIT, label: t("ai.catalog.unset") }, ...efforts.map((effort) => ({ value: effort, label: effort }))]}
              onChange={(value) => apply({ defaultReasoningLevel: value === CODEX_INHERIT ? undefined : value })} />
            <em className="ai-cli-hint">{efforts.length ? t("ai.catalog.reasoningLevelHint") : t("ai.catalog.reasoningLevelNone")}</em>
          </div>
          {OVERRIDE_ENUM_FIELDS.filter((field) => !field.protocol).map(fieldFor)}
          <NumberField label={t("ai.catalog.contextWindow")} invalidHint={t("ai.catalog.numberOnly")} value={current.contextWindow}
            placeholder={String(model.context_window ?? "—")}
            onCommit={(contextWindow) => apply({ contextWindow })} />
          <NumberField label={t("ai.catalog.maxContextWindow")} invalidHint={t("ai.catalog.numberOnly")} value={current.maxContextWindow}
            placeholder={String(model.max_context_window ?? "—")}
            onCommit={(maxContextWindow) => apply({ maxContextWindow })} />
        </div>
        {flags.filter((flag) => flag !== "use_responses_lite").map(flagFor)}
        <p className="ai-cli-group">{t("ai.catalog.groupInstructions")}</p>
        <label className="ai-cli-field">
          <span>{t("ai.catalog.baseInstructions")}</span>
          <textarea className="text-input ai-catalog-instructions" spellCheck={false} rows={6}
            value={current.baseInstructions ?? (inherited.loaded ? inherited.text : "")}
            placeholder={inherited.loaded ? t("ai.catalog.baseInstructionsEmpty") : t("ai.catalog.instructionsLoading")}
            onChange={(event) => apply({ baseInstructions: event.target.value === "" ? undefined : event.target.value })} />
          <em className="ai-cli-hint">{t("ai.catalog.baseInstructionsHint")}</em>
        </label>
      </div>
    );
  };

  const toggleExclude = (slug: string) => {
    props.onChange({
      ...draft,
      excluded: draft.excluded.includes(slug) ? draft.excluded.filter((item) => item !== slug) : [...draft.excluded, slug],
    });
  };

  /** 官方模型的覆盖项落在 `overrides[slug]`。 */
  const officialEditor = (slug: string, model: Record<string, unknown>) => editorFor(
    () => draft.overrides[slug] ?? emptyCodexModelOverride(),
    (next) => {
      const overrides = { ...draft.overrides };
      // 最后一个字段清掉时整条删除：后端会拒绝空覆盖项，留着只会让保存失败。
      if (overrideIsEmpty(next)) delete overrides[slug];
      else overrides[slug] = next;
      props.onChange({ ...draft, overrides });
    },
    model,
    slug,
  );

  const renderModelRow = (model: Record<string, unknown>, excluded: boolean) => {
    const slug = slugOf(model);
    const isDefault = !excluded && ((draft.default ? draft.default === slug : effectiveDefault === slug) || currentModel === slug);
    return (
      <div className={`ai-catalog-row${excluded ? " is-excluded" : ""}`} key={slug}>
        <div className="ai-catalog-row-main">
          {!excluded ? (
            <button type="button" className="lsp-action ai-catalog-star" title={t("ai.catalog.default")}
              aria-label={t("ai.catalog.default")} aria-pressed={isDefault}
              disabled={busy || readOnly} onClick={() => pickDefault(slug)}>
              <Star size={13} />
            </button>
          ) : <span className="ai-catalog-star-spacer" aria-hidden="true" />}
          <div className="ai-catalog-row-name">
            <strong>{nameOf(model)}</strong>
            <code>{slug}</code>
            {isDefault ? <span className="ai-cli-badge is-checking">{t("ai.catalog.default")}</span> : null}
            {draft.overrides[slug] ? <span className="ai-cli-badge is-idle">{t("ai.catalog.overridden")}</span> : null}
            {excluded ? <span className="ai-cli-badge is-warn">{t("ai.catalog.excludedLabel")}</span> : null}
          </div>
          <div className="ai-catalog-row-actions">
            <button type="button" className="lsp-action" disabled={busy || readOnly} onClick={() => toggleExclude(slug)}>
              {excluded ? <Plus size={13} /> : <Trash2 size={13} />}
              {t(excluded ? "ai.catalog.include" : "ai.catalog.exclude")}
            </button>
            {!excluded ? (
              <button type="button" className="lsp-action" aria-expanded={open === slug}
                onClick={() => setOpen((value) => value === slug ? null : slug)}>
                {open === slug ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {t("ai.catalog.override")}
              </button>
            ) : null}
          </div>
        </div>
        {!excluded && open === slug ? officialEditor(slug, model) : null}
      </div>
    );
  };

  const updateCustom = (index: number, patch: Partial<CodexCustomModel>) => {
    props.onChange({ ...draft, customs: draft.customs.map((item, position) => position === index ? { ...item, ...patch } : item) });
  };

  /** 两种自定义模型的区别只在协议预设：网关要的是标准 OpenAI Responses，GPT 用 Codex 的私有方言。 */
  const addCustom = (compat: boolean) => {
    const baseModel = officials[0] ?? models[0];
    const baseSlug = baseModel ? slugOf(baseModel) : "";
    const item: CodexCustomModel = {
      slug: "",
      displayName: "",
      contextWindow: undefined,
      description: "",
      base: baseSlug,
      overrides: emptyCodexModelOverride(),
    };
    props.onChange({
      ...draft,
      customs: [...draft.customs, { ...item, overrides: compat ? applyCodexCompatPreset(item, baseModel ?? {}, true) : item.overrides }],
    });
  };

  const renderCustomRow = (item: CodexCustomModel, index: number) => {
    const key = `custom:${index}`;
    // 自定义模型的参数来自模板条目：合并后的结果在 view 里，编辑覆盖项时要拿同一份做参照。
    const template = officials.find((model) => slugOf(model) === item.base);
    const merged = models.find((model) => slugOf(model) === item.slug) ?? template ?? {};
    const compat = isCodexCompatModel(item, template);
    const invalidSlug = item.slug.trim() !== "" && !/^[A-Za-z0-9\-_.:/]{1,64}$/.test(item.slug.trim());
    const duplicate = item.slug.trim() !== "" && officials.some((model) => slugOf(model) === item.slug.trim());
    const isDefault = Boolean(item.slug) && ((draft.default ? draft.default === item.slug : effectiveDefault === item.slug) || currentModel === item.slug);
    return (
      <div className="ai-catalog-custom" key={key}>
        <div className="ai-catalog-row-main">
          <button type="button" className="lsp-action ai-catalog-star" title={t("ai.catalog.default")}
            aria-label={t("ai.catalog.default")} aria-pressed={isDefault}
            disabled={busy || readOnly || !item.slug} onClick={() => pickDefault(item.slug)}>
            <Star size={13} />
          </button>
          <div className="ai-catalog-row-name">
            <strong>{item.displayName.trim() || item.slug.trim() || t("ai.catalog.newCustom")}</strong>
            <code>{item.slug.trim() || "—"}</code>
            <span className="ai-cli-badge is-idle">{t("ai.catalog.custom")}</span>
            {isDefault ? <span className="ai-cli-badge is-checking">{t("ai.catalog.default")}</span> : null}
            {compat ? <span className="ai-cli-badge is-idle">{t("ai.catalog.presetCompat")}</span> : null}
            {item.contextWindow ? <span className="ai-cli-badge is-idle">{item.contextWindow} tok</span> : null}
            {item.base ? <em className="ai-cli-hint">{t("ai.catalog.baseOf", { name: item.base })}</em> : null}
          </div>
          <div className="ai-catalog-row-actions">
            <button type="button" className="lsp-action" disabled={busy || readOnly}
              onClick={() => props.onChange({
                ...draft,
                customs: draft.customs.filter((_, position) => position !== index),
                default: draft.default === item.slug ? undefined : draft.default,
              })}>
              <Trash2 size={13} />{t("ai.catalog.removeCustom")}
            </button>
            <button type="button" className="lsp-action" aria-expanded={open === key}
              onClick={() => setOpen((value) => value === key ? null : key)}>
              {open === key ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {t("ai.catalog.override")}
            </button>
          </div>
        </div>
        <div className="ai-cli-grid ai-catalog-custom-grid">
          <label className="ai-cli-field">
            <span>{t("ai.catalog.slug")}</span>
            <input className="text-input" spellCheck={false} value={item.slug} maxLength={64} placeholder="my-gateway/claude-opus"
              disabled={readOnly}
              onChange={(event) => updateCustom(index, { slug: event.target.value })} />
            {invalidSlug || duplicate ? <em className="ai-cli-warning">{t("ai.catalog.slugInvalid")}</em> : null}
          </label>
          <label className="ai-cli-field">
            <span>{t("ai.catalog.displayName")}</span>
            <input className="text-input" spellCheck={false} value={item.displayName} maxLength={80}
              placeholder={t("ai.catalog.displayName")}
              disabled={readOnly}
              onChange={(event) => updateCustom(index, { displayName: event.target.value })} />
          </label>
          <label className="ai-cli-field">
            <span>{t("ai.catalog.contextWindow")}</span>
            <input className="text-input" type="number" min={1} spellCheck={false}
              value={item.contextWindow ?? ""}
              placeholder={t("ai.catalog.contextWindow")}
              disabled={readOnly}
              onChange={(event) => {
                const val = event.target.value.trim();
                const n = parseInt(val, 10);
                updateCustom(index, { contextWindow: val !== "" && Number.isFinite(n) && n > 0 ? n : undefined });
              }} />
          </label>
        </div>
        {open === key ? (
          <>
            <div className="ai-cli-grid">
              <div className="ai-cli-field">
                <span>{t("ai.catalog.base")}</span>
                <Select value={item.base} label={t("ai.catalog.base")} placeholder={t("ai.catalog.base")}
                  options={officials.map((model) => ({ value: slugOf(model), label: nameOf(model) }))}
                  disabled={readOnly}
                  onChange={(base) => updateCustom(index, { base })} />
                <em className="ai-cli-hint">{t("ai.catalog.baseHint")}</em>
              </div>
              <label className="ai-cli-field">
                <span>{t("ai.catalog.description")}</span>
                <input className="text-input" spellCheck={false} value={item.description} maxLength={500}
                  disabled={readOnly}
                  onChange={(event) => updateCustom(index, { description: event.target.value })} />
              </label>
            </div>
            <div className="ai-cli-field">
              <span>{t("ai.catalog.preset")}</span>
              <div className="ai-catalog-presets">
                <button type="button" className="lsp-action" disabled={busy || readOnly} aria-pressed={!compat}
                  onClick={() => updateCustom(index, { overrides: applyCodexCompatPreset(item, template, false) })}>
                  {t("ai.catalog.presetGpt")}
                </button>
                <button type="button" className="lsp-action" disabled={busy || readOnly} aria-pressed={compat}
                  onClick={() => updateCustom(index, { overrides: applyCodexCompatPreset(item, template, true) })}>
                  {t("ai.catalog.presetCompat")}
                </button>
              </div>
              <em className="ai-cli-hint">{t("ai.catalog.presetHint")}</em>
            </div>
            {editorFor(
              () => item.overrides,
              (next) => updateCustom(index, { overrides: next }),
              merged,
              item.base,
            )}
          </>
        ) : null}
      </div>
    );
  };

  return (
    <section className={`ai-cli-section${embedded ? " is-embedded" : ""}`} aria-label={t("ai.catalog.title")}>
      {!embedded ? (
        <div className="ai-cli-section-head">
          <div>
            <strong>{t("ai.catalog.title")}</strong>
            <span className="ai-muted">{t(view?.active ? "ai.catalog.active" : "ai.catalog.inactive")}</span>
            {dirty ? <span className="ai-cli-badge is-checking">{t("ai.unsaved")}</span> : null}
          </div>
          <button type="button" className="lsp-action" disabled={loading || busy} title={t("ai.catalog.reload")}
            aria-label={t("ai.catalog.reload")} onClick={props.onReload}>
            <RefreshCw size={13} className={loading ? "is-spinning" : undefined} />
          </button>
        </div>
      ) : null}

      <p className="ai-cli-hint">{t("ai.catalog.hint")}</p>
      {view?.error ? <p className="ai-cli-warning" role="alert">{t("ai.catalog.stale", { message: view.error })}</p> : null}
      {!embedded && view ? <p className="ai-cli-hint"><code>{view.path}</code></p> : null}

      {loading && !view ? (
        <p className="ai-cli-hint" role="status">{t("ai.catalog.loading")}</p>
      ) : (
        <div className="ai-catalog-list">
          {listableOfficials.map((model) => renderModelRow(model, draft.excluded.includes(slugOf(model))))}
          {(view?.hidden ?? []).map((model) => renderModelRow(model, true))}
          {draft.customs.map(renderCustomRow)}
        </div>
      )}

      <div className="ai-cli-section-foot">
        {notice ? <p className={notice.error ? "ai-error" : "ai-success"} role="status">{notice.text}</p> : <span />}
        <div className="ai-cli-actions">
          <button type="button" className="lsp-action" disabled={busy || readOnly} onClick={() => addCustom(false)}>
            <Plus size={13} />{t("ai.catalog.addGpt")}
          </button>
          <button type="button" className="lsp-action" disabled={busy || readOnly} onClick={() => addCustom(true)}>
            <Plus size={13} />{t("ai.catalog.addCompat")}
          </button>
          {!embedded && view?.active ? (
            <button type="button" className="lsp-action" disabled={busy || readOnly} onClick={props.onClear}>
              <Check size={13} />{t("ai.catalog.clear")}
            </button>
          ) : null}
          {!embedded ? (
            <button type="button" className="lsp-action" disabled={busy || loading || !view || readOnly} onClick={props.onSave}>
              {busy ? <RefreshCw size={13} className="is-spinning" /> : <Save size={13} />}
              {busy ? t("ai.saving") : t("ai.catalog.save")}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
