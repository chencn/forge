import { useEffect, useMemo, useState } from "react";
import { BookOpenText, Eye, Loader2, Pencil, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard";
import { AI_NAMES } from "../lib/aiCli";
import type { AiProvider } from "../lib/aiCli";
import {
  cliAdminAvailable,
  deleteSkill,
  listSkills,
  readSkill,
  saveSkill,
  skillHasFrontMatter,
  skillTemplate,
} from "../lib/aiManage";
import type { SkillItem, SkillList } from "../lib/aiManage";
import { renderChatMarkdown } from "../lib/markdown";
import Select from "./Select";
import AiActionDialog from "./AiActionDialog";
import type { TranslationKey } from "../i18n/lang/zh";

const LOCATION_LABEL: Record<string, TranslationKey> = {
  claude: "skills.location.claude",
  codex: "skills.location.codex",
  agents: "skills.location.agents",
};

const locationLabel = (id: string, t: (key: TranslationKey) => string) =>
  LOCATION_LABEL[id] ? t(LOCATION_LABEL[id]) : id;

/**
 * Skills：直接编辑用户级目录里的 `<id>/SKILL.md`。
 * Claude 在 `~/.claude/skills`，Codex 在 `~/.codex/skills` 和共享的 `~/.agents/skills`。
 */
export default function SkillsPanel() {
  const { t } = useI18n();
  const desktop = cliAdminAvailable();
  const [provider, setProvider] = useState<AiProvider>("claude");
  const [list, setList] = useState<SkillList | null>(null);
  const [selected, setSelected] = useState<{ location: string; id: string } | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [id, setId] = useState("");
  const [location, setLocation] = useState("claude");
  const [content, setContent] = useState("");
  const [search, setSearch] = useState("");
  // 预览是默认态，和 codeg 一致：技能正文主要是读的内容，编辑要显式切过去。
  const [preview, setPreview] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SkillItem | null>(null);
  /** 非空表示有一个「放弃未保存修改」确认框，确认后才执行挂起的导航动作。 */
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  /** 打开/新建时的原始内容，用来判断是否有未保存的编辑。 */
  const [baseline, setBaseline] = useState("");
  const dirty = (isNew || selected !== null) && content !== baseline;
  const guard = (action: () => void) => {
    if (dirty) setPendingLeave(() => action);
    else action();
  };
  useUnsavedGuard(() => dirty);

  const open = async (providerId: AiProvider, item: SkillItem) => {
    // 上一次读取还没回来时忽略点击，避免两个响应竞争后把内容写到错误的技能上。
    if (busy) return;
    setBusy(true); setNotice(null);
    try {
      const text = await readSkill(providerId, item.location, item.id);
      // 读成功后再切换选中项，避免读取失败时把上一个技能的内容写进新技能。
      setSelected({ location: item.location, id: item.id });
      setIsNew(false); setId(item.id); setLocation(item.location); setPreview(true);
      setContent(text);
      setBaseline(text);
    } catch (error) {
      setSelected(null); setIsNew(false); setId(""); setContent(""); setBaseline("");
      setNotice({ error: true, text: t("skills.loadFailed", { message: String(error) }) });
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    setBusy(true); setNotice(null); setList(null); setSelected(null); setIsNew(false); setContent(""); setBaseline(""); setPreview(true);
    listSkills(provider)
      .then((value) => {
        if (!active) return;
        setList(value);
        setLocation(value.locations[0]?.id ?? provider);
        const first = value.skills[0];
        if (!first) { setBusy(false); return; }
        setSelected({ location: first.location, id: first.id });
        setId(first.id); setLocation(first.location);
        readSkill(provider, first.location, first.id)
          .then((text) => { if (active) { setContent(text); setBaseline(text); setBusy(false); } })
          .catch((error) => {
            if (!active) return;
            setSelected(null); setId("");
            setNotice({ error: true, text: t("skills.loadFailed", { message: String(error) }) });
            setBusy(false);
          });
      })
      .catch((error) => {
        if (!active) return;
        setNotice({ error: true, text: t("skills.loadFailed", { message: String(error) }) });
        setBusy(false);
      });
    return () => { active = false; };
  }, [provider, desktop, reloadToken]);

  const startNew = () => {
    const nextLocation = list?.locations[0]?.id ?? provider;
    const template = skillTemplate("my-skill");
    setSelected(null); setIsNew(true); setId("my-skill");
    setLocation(nextLocation);
    setContent(template); setBaseline(template);
    setPreview(true); setNotice(null);
  };

  const changeId = (next: string) => {
    const clean = next.trim();
    // 骨架内容跟着 ID 联动，且不算用户改动；改过正文后就不再覆盖。
    if (content === skillTemplate(id)) {
      const updated = skillTemplate(clean);
      setContent(updated);
      setBaseline(updated);
    }
    setId(next);
  };

  const save = async () => {
    const clean = id.trim();
    if (!clean || busy) return;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(clean)) {
      setNotice({ error: true, text: t("skills.idInvalid") });
      return;
    }
    if (isNew && list?.skills.some((item) => item.id === clean && item.location === location)) {
      setNotice({ error: true, text: t("skills.idExists", { id: clean }) });
      return;
    }
    setBusy(true); setNotice(null);
    try {
      const saved = await saveSkill(provider, location, clean, content);
      setList(saved); setIsNew(false); setSelected({ location, id: clean });
      setId(clean); setBaseline(content);
      setNotice({ error: false, text: t("skills.saved") });
    } catch (error) {
      setNotice({ error: true, text: t("skills.saveFailed", { message: String(error) }) });
    } finally { setBusy(false); }
  };

  const remove = async (item: SkillItem) => {
    setPendingDelete(null);
    setBusy(true); setNotice(null);
    try {
      const saved = await deleteSkill(provider, item.location, item.id);
      setList(saved);
      if (selected?.id === item.id && selected.location === item.location) {
        setSelected(null); setIsNew(false); setId(""); setContent(""); setBaseline("");
      }
    } catch (error) {
      setNotice({ error: true, text: t("skills.deleteFailed", { message: String(error) }) });
    } finally { setBusy(false); }
  };

  const query = search.trim().toLowerCase();
  const skills = (list?.skills ?? []).filter((item) => !query
    || item.id.toLowerCase().includes(query)
    || item.name.toLowerCase().includes(query)
    || (item.description ?? "").toLowerCase().includes(query));

  const rendered = useMemo(() => renderChatMarkdown(content, ""), [content]);
  const editing = isNew || selected !== null;
  // 只有一个来源目录时，每行再挂同一个 CLI 徽标纯属噪音；多来源（如 Codex 的 .codex/skills 与共享 .agents/skills）才需要区分。
  const multiLocation = new Set(skills.map((item) => item.location)).size > 1;
  const currentItem = !isNew ? list?.skills.find((item) => item.id === id && item.location === location) : undefined;
  const missingFrontMatter = editing && content.trim() !== "" && !skillHasFrontMatter(content);

  return (
    <div className="ai-manage-panel">
      <div className="ai-manage-toolbar">
        <Select value={provider} label={t("skills.provider")} placeholder={t("skills.provider")}
          options={(["claude", "codex"] as AiProvider[]).map((item) => ({ value: item, label: AI_NAMES[item] }))}
          onChange={(next) => guard(() => setProvider(next))} />
        <input className="text-input" value={search} placeholder={t("skills.search")}
          aria-label={t("skills.search")} onChange={(event) => setSearch(event.target.value)} />
        <button type="button" className="lsp-action" disabled={!desktop || busy}
          title={t("skills.refresh")} aria-label={t("skills.refresh")}
          onClick={() => guard(() => setReloadToken((value) => value + 1))}>
          <RefreshCw size={13} />
        </button>
        <button type="button" className="lsp-action" disabled={!desktop || busy} onClick={() => guard(startNew)}>
          <Plus size={13} />{t("skills.add")}
        </button>
      </div>

      <div className="ai-manage-page">
        <aside className="ai-cli-list" aria-label={t("skills.title")}>
          <div className="ai-cli-list-head">
            <span>{t("skills.title")}</span>
            <span className="ai-cli-list-hint">{t("skills.hint")}</span>
          </div>
          <div className="ai-cli-list-body">
            {skills.map((item) => (
              <button type="button" key={`${item.location}:${item.id}`}
                className={`ai-cli-row${selected?.id === item.id && selected.location === item.location ? " is-active" : ""}`}
                onClick={() => guard(() => void open(provider, item))}>
                <BookOpenText size={13} className="ai-cli-grip" aria-hidden="true" />
                <span className="ai-cli-row-name" title={item.description ?? undefined}>{item.name}</span>
                {item.linked ? <span className="ai-cli-badge is-warn">{t("skills.linked")}</span> : null}
                {multiLocation ? <span className="ai-cli-badge is-idle">{locationLabel(item.location, t)}</span> : null}
              </button>
            ))}
            {!skills.length ? <p className="ai-cli-list-note">{desktop ? (busy ? t("ai.cfg.loading") : notice?.error ? notice.text : t("skills.empty")) : t("ai.desktopOnly")}</p> : null}
          </div>
        </aside>

        <section className="ai-cli-detail" aria-label={t("skills.detail")}>
          {editing ? <>
            <header className="ai-cli-detail-head">
              <div className="ai-cli-detail-title">
                <BookOpenText size={18} aria-hidden="true" />
                <h3>{isNew ? t("skills.new") : id}</h3>
                <span className="ai-cli-badge is-idle">{locationLabel(location, t)}</span>
                {currentItem?.linked ? <span className="ai-cli-badge is-warn">{t("skills.linked")}</span> : null}
                {dirty ? <span className="ai-cli-badge is-checking">{t("skills.unsaved")}</span> : null}
              </div>
              <button type="button" className="lsp-action" onClick={() => setPreview((value) => !value)}>
                {preview ? <Pencil size={13} /> : <Eye size={13} />}
                {preview ? t("skills.edit") : t("skills.preview")}
              </button>
            </header>
            <div className="ai-cli-detail-body">
              <div className="ai-cli-grid">
                <label className="ai-cli-field">
                  <span>{t("skills.id")}</span>
                  <input className="text-input" spellCheck={false} value={id} disabled={!isNew} maxLength={64}
                    placeholder="my-skill" onChange={(event) => changeId(event.target.value)} />
                  <em className="ai-cli-hint">{t("skills.idHint")}</em>
                </label>
                <div className="ai-cli-field">
                  <span>{t("skills.location")}</span>
                  <Select value={location} label={t("skills.location")} placeholder={t("skills.location")}
                    disabled={!isNew}
                    options={(list?.locations ?? []).map((item) => ({ value: item.id, label: locationLabel(item.id, t) }))}
                    onChange={setLocation} />
                  <em className="ai-cli-hint">{list?.locations.find((item) => item.id === location)?.path ?? ""}</em>
                </div>
              </div>
              <label className="ai-cli-field ai-skill-editor">
                <span>{t("skills.content")}</span>
                {preview
                  ? <div className="ai-skill-preview ai-message-markdown" dangerouslySetInnerHTML={{ __html: rendered }} />
                  : <textarea className="ai-cli-env ai-skill-text" spellCheck={false} value={content}
                    onChange={(event) => setContent(event.target.value)} />}
                {!preview && missingFrontMatter ? <em className="ai-cli-warning">{t("skills.frontMatterMissing")}</em> : null}
                {currentItem?.linked ? <em className="ai-cli-hint">{t("skills.linkedHint")}</em> : null}
              </label>
            </div>
            <div className="ai-manage-foot">
              {notice ? <p className={notice.error ? "ai-error" : "ai-success"} role="status">{notice.text}</p> : <span />}
              <div className="ai-cli-actions">
                {!isNew && selected ? <button type="button" className="lsp-action" disabled={!desktop || busy}
                  onClick={() => { const item = list?.skills.find((entry) => entry.id === selected.id && entry.location === selected.location); if (item) setPendingDelete(item); }}>
                  <Trash2 size={13} />{t("skills.delete")}
                </button> : null}
                <button type="button" className="lsp-action" disabled={!desktop || busy || !id.trim()} onClick={() => void save()}>
                  {busy ? <Loader2 size={13} className="is-spinning" /> : <Save size={13} />}
                  {busy ? t("ai.saving") : t("skills.save")}
                </button>
              </div>
            </div>
          </> : <p className="ai-cli-empty">{desktop ? (busy ? t("ai.cfg.loading") : notice?.error ? notice.text : t("skills.selectHint")) : t("ai.desktopOnly")}</p>}
        </section>
      </div>

      {pendingDelete ? <AiActionDialog title={t("skills.delete")} confirm={t("skills.delete")} danger
        onCancel={() => setPendingDelete(null)} onConfirm={() => void remove(pendingDelete)}>
        <p className="dialog-body">{t(pendingDelete.linked ? "skills.deleteLinkConfirm" : "skills.deleteConfirm", { id: pendingDelete.id })}</p>
      </AiActionDialog> : null}

      {pendingLeave ? <AiActionDialog title={t("skills.discardTitle")} confirm={t("skills.discard")} danger
        onCancel={() => setPendingLeave(null)}
        onConfirm={() => { const run = pendingLeave; setPendingLeave(null); run(); }}>
        <p className="dialog-body">{t("skills.discardHint")}</p>
      </AiActionDialog> : null}
    </div>
  );
}
