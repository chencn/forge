import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Plus, RefreshCw, Save, Star, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import Select from "./Select";
import type { TranslationKey } from "../i18n/lang/zh";
import {
  CODEX_APPLY_PATCH_TYPES,
  CODEX_MODEL_FLAGS,
  CODEX_MULTI_AGENT_VERSIONS,
  CODEX_REASONING_SUMMARIES,
  CODEX_SHELL_TYPES,
  CODEX_TOOL_MODES,
  CODEX_VERBOSITIES,
  CODEX_VISIBILITIES,
  CODEX_WEB_SEARCH_TYPES,
  codexModelEfforts,
  emptyCodexModelOverride,
} from "../lib/aiManage";
import type { CodexCatalogIntent, CodexCatalogView, CodexCustomModel, CodexModelFlag, CodexModelOverride } from "../lib/aiManage";

type EnumKey = "toolMode" | "multiAgentVersion" | "defaultReasoningSummary" | "defaultVerbosity"
  | "shellType" | "applyPatchToolType" | "webSearchToolType" | "visibility";

/** 界面按这张表渲染枚举覆盖项；取值域全部是 Codex 实测能原样回显的值，写未知值会让整份目录被拒。 */
const OVERRIDE_ENUM_FIELDS: { key: EnumKey; label: TranslationKey; options: string[] }[] = [
  { key: "toolMode", label: "ai.catalog.toolMode", options: CODEX_TOOL_MODES },
  { key: "multiAgentVersion", label: "ai.catalog.multiAgentVersion", options: CODEX_MULTI_AGENT_VERSIONS },
  { key: "defaultReasoningSummary", label: "ai.catalog.reasoningSummary", options: CODEX_REASONING_SUMMARIES },
  { key: "defaultVerbosity", label: "ai.catalog.verbosity", options: CODEX_VERBOSITIES },
  { key: "shellType", label: "ai.catalog.shellType", options: CODEX_SHELL_TYPES },
  { key: "applyPatchToolType", label: "ai.catalog.applyPatch", options: CODEX_APPLY_PATCH_TYPES },
  { key: "webSearchToolType", label: "ai.catalog.webSearch", options: CODEX_WEB_SEARCH_TYPES },
  { key: "visibility", label: "ai.catalog.visibility", options: CODEX_VISIBILITIES },
];

const FLAG_LABEL: Record<CodexModelFlag, TranslationKey> = {
  support_verbosity: "ai.catalog.flagSupportVerbosity",
  supports_search_tool: "ai.catalog.flagSearchTool",
  supports_image_detail_original: "ai.catalog.flagImageDetail",
  include_apps_usage_instructions: "ai.catalog.flagAppsUsage",
  include_plugin_usage_instructions: "ai.catalog.flagPluginUsage",
  include_skills_usage_instructions: "ai.catalog.flagSkillsUsage",
  use_responses_lite: "ai.catalog.flagResponsesLite",
};

const slugOf = (model: Record<string, unknown>) => String(model.slug ?? "");
const nameOf = (model: Record<string, unknown>) => String(model.display_name ?? "") || slugOf(model);

function overrideIsEmpty(item: CodexModelOverride): boolean {
  return OVERRIDE_ENUM_FIELDS.every((field) => !item[field.key])
    && !item.defaultReasoningLevel
    && !item.contextWindow
    && !item.maxContextWindow
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
  loading: boolean;
  busy: boolean;
  dirty: boolean;
  /** config.toml 当前的 `model`，用来标出默认模型。 */
  currentModel: string;
  notice: { error: boolean; text: string } | null;
  onChange: (next: CodexCatalogIntent) => void;
  onPickDefault: (slug: string) => void;
  onSave: () => void;
  onClear: () => void;
  onReload: () => void;
}

/**
 * Codex 模型清单。`model_catalog_json` 是整份替换语义，所以这里编辑的都是「在 Codex 自带目录之上的覆盖项」，
 * 列表展示的是合并之后 Codex 实际会看到的值，而不是用户填的原始值。
 */
export default function CodexCatalogSection(props: CodexCatalogSectionProps) {
  const { view, draft, loading, busy, dirty, currentModel, notice } = props;
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const customSlugs = new Set(draft.customs.map((item) => item.slug).filter((slug) => slug !== ""));
  const models = view?.models ?? [];
  const officials = models.filter((model) => !customSlugs.has(slugOf(model)));

  /** 覆盖项的读写按目标走：官方模型进 `overrides[slug]`，自定义模型进 `customs[i].overrides`。 */
  const editorFor = (read: () => CodexModelOverride, write: (next: CodexModelOverride) => void, model: Record<string, unknown>) => {
    const current = read();
    const apply = (patch: Partial<CodexModelOverride>) => {
      const next = { ...current, ...patch };
      write(next);
    };
    const efforts = codexModelEfforts(model);
    return (
      <div className="ai-catalog-override">
        <div className="ai-cli-grid">
          {OVERRIDE_ENUM_FIELDS.map((field) => (
            <div className="ai-cli-field" key={field.key}>
              <span>{t(field.label)}</span>
              <Select
                value={(current[field.key] as string | null | undefined) ?? ""}
                label={t(field.label)}
                placeholder={t("ai.catalog.unset")}
                options={[{ value: "", label: t("ai.catalog.unset") }, ...field.options.map((option) => ({ value: option, label: option }))]}
                onChange={(value) => apply({ [field.key]: value === "" ? undefined : value } as Partial<CodexModelOverride>)} />
            </div>
          ))}
          <div className="ai-cli-field">
            <span>{t("ai.catalog.reasoningLevel")}</span>
            <Select
              value={current.defaultReasoningLevel ?? ""}
              label={t("ai.catalog.reasoningLevel")}
              placeholder={t("ai.catalog.unset")}
              options={[{ value: "", label: t("ai.catalog.unset") }, ...efforts.map((effort) => ({ value: effort, label: effort }))]}
              onChange={(value) => apply({ defaultReasoningLevel: value === "" ? undefined : value })} />
            <em className="ai-cli-hint">{efforts.length ? t("ai.catalog.reasoningLevelHint") : t("ai.catalog.reasoningLevelNone")}</em>
          </div>
          <NumberField label={t("ai.catalog.contextWindow")} invalidHint={t("ai.catalog.numberOnly")} value={current.contextWindow}
            placeholder={String(model.context_window ?? "—")}
            onCommit={(contextWindow) => apply({ contextWindow })} />
          <NumberField label={t("ai.catalog.maxContextWindow")} invalidHint={t("ai.catalog.numberOnly")} value={current.maxContextWindow}
            placeholder={String(model.max_context_window ?? "—")}
            onCommit={(maxContextWindow) => apply({ maxContextWindow })} />
        </div>
        {CODEX_MODEL_FLAGS.map((flag) => (
          <div className="ai-cli-row-switch" key={flag}>
            <span>{t(FLAG_LABEL[flag])}</span>
            <button type="button" role="switch" className="ai-enable-switch" aria-checked={model[flag] === true} aria-label={t(FLAG_LABEL[flag])}
              disabled={busy} onClick={() => apply({ flags: { ...current.flags, [flag]: model[flag] !== true } })}>
              <span />
            </button>
          </div>
        ))}
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
  );

  const renderModelRow = (model: Record<string, unknown>, excluded: boolean) => {
    const slug = slugOf(model);
    return (
      <div className={`ai-catalog-row${excluded ? " is-excluded" : ""}`} key={slug}>
        <div className="ai-catalog-row-main">
          {!excluded ? (
            <button type="button" className="lsp-action ai-catalog-star" title={t("ai.catalog.default")}
              aria-label={t("ai.catalog.default")} aria-pressed={currentModel === slug}
              disabled={busy} onClick={() => props.onPickDefault(slug)}>
              <Star size={13} />
            </button>
          ) : <span className="ai-catalog-star-spacer" aria-hidden="true" />}
          <div className="ai-catalog-row-name">
            <strong>{nameOf(model)}</strong>
            <code>{slug}</code>
            {currentModel === slug && !excluded ? <span className="ai-cli-badge is-checking">{t("ai.catalog.default")}</span> : null}
            {draft.overrides[slug] ? <span className="ai-cli-badge is-idle">{t("ai.catalog.overridden")}</span> : null}
            {excluded ? <span className="ai-cli-badge is-warn">{t("ai.catalog.excludedLabel")}</span> : null}
          </div>
          <div className="ai-catalog-row-actions">
            <button type="button" className="lsp-action" disabled={busy} onClick={() => toggleExclude(slug)}>
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

  const addCustom = () => {
    const base = officials[0];
    if (!base) return;
    props.onChange({
      ...draft,
      customs: [...draft.customs, { slug: "", displayName: "", description: "", base: slugOf(base), overrides: emptyCodexModelOverride() }],
    });
  };

  const renderCustomRow = (item: CodexCustomModel, index: number) => {
    const key = `custom:${index}`;
    // 自定义模型的参数来自模板条目：合并后的结果在 view 里，编辑覆盖项时要拿同一份做参照。
    const merged = models.find((model) => slugOf(model) === item.slug) ?? officials.find((model) => slugOf(model) === item.base) ?? {};
    const invalidSlug = item.slug.trim() !== "" && !/^[A-Za-z0-9\-_.:/]{1,64}$/.test(item.slug.trim());
    const duplicate = item.slug.trim() !== "" && officials.some((model) => slugOf(model) === item.slug.trim());
    return (
      <div className="ai-catalog-custom" key={key}>
        <div className="ai-catalog-row-main">
          <span className="ai-catalog-star-spacer" aria-hidden="true" />
          <div className="ai-catalog-row-name">
            <strong>{item.displayName.trim() || item.slug.trim() || t("ai.catalog.newCustom")}</strong>
            <code>{item.slug.trim() || "—"}</code>
            <span className="ai-cli-badge is-idle">{t("ai.catalog.custom")}</span>
            {item.base ? <em className="ai-cli-hint">{t("ai.catalog.baseOf", { name: item.base })}</em> : null}
          </div>
          <div className="ai-catalog-row-actions">
            <button type="button" className="lsp-action" disabled={busy}
              onClick={() => props.onChange({ ...draft, customs: draft.customs.filter((_, position) => position !== index) })}>
              <Trash2 size={13} />{t("ai.catalog.removeCustom")}
            </button>
            <button type="button" className="lsp-action" aria-expanded={open === key}
              onClick={() => setOpen((value) => value === key ? null : key)}>
              {open === key ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {t("ai.catalog.override")}
            </button>
          </div>
        </div>
        <div className="ai-cli-grid">
          <label className="ai-cli-field">
            <span>{t("ai.catalog.slug")}</span>
            <input className="text-input" spellCheck={false} value={item.slug} maxLength={64} placeholder="my-gateway/claude-opus"
              onChange={(event) => updateCustom(index, { slug: event.target.value })} />
            {invalidSlug || duplicate ? <em className="ai-cli-warning">{t("ai.catalog.slugInvalid")}</em> : null}
          </label>
          <label className="ai-cli-field">
            <span>{t("ai.catalog.displayName")}</span>
            <input className="text-input" spellCheck={false} value={item.displayName} maxLength={80}
              onChange={(event) => updateCustom(index, { displayName: event.target.value })} />
          </label>
          <div className="ai-cli-field">
            <span>{t("ai.catalog.base")}</span>
            <Select value={item.base} label={t("ai.catalog.base")} placeholder={t("ai.catalog.base")}
              options={officials.map((model) => ({ value: slugOf(model), label: nameOf(model) }))}
              onChange={(base) => updateCustom(index, { base })} />
            <em className="ai-cli-hint">{t("ai.catalog.baseHint")}</em>
          </div>
          <label className="ai-cli-field">
            <span>{t("ai.catalog.description")}</span>
            <input className="text-input" spellCheck={false} value={item.description} maxLength={500}
              onChange={(event) => updateCustom(index, { description: event.target.value })} />
          </label>
        </div>
        {open === key ? editorFor(
          () => item.overrides,
          (next) => updateCustom(index, { overrides: next }),
          merged,
        ) : null}
      </div>
    );
  };

  return (
    <section className="ai-cli-section" aria-label={t("ai.catalog.title")}>
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

      <p className="ai-cli-hint">{t("ai.catalog.hint")}</p>
      {view?.error ? <p className="ai-cli-warning" role="alert">{t("ai.catalog.stale", { message: view.error })}</p> : null}
      {view ? <p className="ai-cli-hint"><code>{view.path}</code></p> : null}

      {loading && !view ? (
        <p className="ai-cli-hint" role="status">{t("ai.catalog.loading")}</p>
      ) : !view || !models.length ? (
        <p className="ai-cli-hint">{t("ai.catalog.unavailable")}</p>
      ) : (
        <div className="ai-catalog-list">
          {officials.map((model) => renderModelRow(model, false))}
          {(view.hidden ?? []).map((model) => renderModelRow(model, true))}
          {draft.customs.map(renderCustomRow)}
        </div>
      )}

      <div className="ai-cli-section-foot">
        {notice ? <p className={notice.error ? "ai-error" : "ai-success"} role="status">{notice.text}</p> : <span />}
        <div className="ai-cli-actions">
          <button type="button" className="lsp-action" disabled={!officials.length || busy} onClick={addCustom}>
            <Plus size={13} />{t("ai.catalog.addCustom")}
          </button>
          {view?.active ? (
            <button type="button" className="lsp-action" disabled={busy} onClick={props.onClear}>
              <Check size={13} />{t("ai.catalog.clear")}
            </button>
          ) : null}
          <button type="button" className="lsp-action" disabled={busy || loading || !view} onClick={props.onSave}>
            {busy ? <RefreshCw size={13} className="is-spinning" /> : <Save size={13} />}
            {busy ? t("ai.saving") : t("ai.catalog.save")}
          </button>
        </div>
      </div>
    </section>
  );
}
