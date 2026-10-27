import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useI18n } from "../i18n";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard";
import type { TranslationKey } from "../i18n/lang/zh";

/**
 * Claude Code 的 hooks 管理面板。
 *
 * hooks 长在 `~/.claude/settings.json` 的 `hooks` 键下（对齐 snow-app 的九类模型，
 * Claude 原生支持八类事件）：`{ 事件名: [{ matcher, hooks: [{ type:"command", command, timeout }] }] }`。
 * 编辑在原 JSON 树上就地改：matcher 改规则对象、command/timeout 改 hook 条目，
 * 面板不认识的字段（prompt 型 hook、CLAUDE_PROJECT_DIR 之类）原样留在树里——
 * 无损编辑，保存只替换 `hooks` 键，文件其余部分后端不动。
 */

/** Claude Code 原生支持的 hook 事件，顺序即展示顺序。 */
const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Notification",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "PreCompact",
] as const;

type HookEvent = (typeof HOOK_EVENTS)[number];
type Json = Record<string, unknown>;

interface HookRow {
  /** 规则在树里的定位：事件名 + 规则下标 + hook 条目下标。 */
  event: HookEvent;
  ruleIndex: number;
  hookIndex: number;
  matcher: string;
  command: string;
  timeout: string;
}

const EVENT_LABEL: Record<HookEvent, TranslationKey> = {
  PreToolUse: "hooks.event.preToolUse",
  PostToolUse: "hooks.event.postToolUse",
  UserPromptSubmit: "hooks.event.userPromptSubmit",
  Notification: "hooks.event.notification",
  Stop: "hooks.event.stop",
  SubagentStop: "hooks.event.subagentStop",
  SessionStart: "hooks.event.sessionStart",
  PreCompact: "hooks.event.preCompact",
};

const EVENT_HINT: Record<HookEvent, TranslationKey> = {
  PreToolUse: "hooks.hint.preToolUse",
  PostToolUse: "hooks.hint.postToolUse",
  UserPromptSubmit: "hooks.hint.userPromptSubmit",
  Notification: "hooks.hint.notification",
  Stop: "hooks.hint.stop",
  SubagentStop: "hooks.hint.subagentStop",
  SessionStart: "hooks.hint.sessionStart",
  PreCompact: "hooks.hint.preCompact",
};

const readString = (value: unknown): string => (typeof value === "string" ? value : "");
const readObject = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);

/** 从 JSON 树里摘出可编辑的 command 型 hook 行；prompt 型等条目不进面板但也绝不丢。 */
function collectRows(doc: Json): HookRow[] {
  const rows: HookRow[] = [];
  for (const event of HOOK_EVENTS) {
    const rules = Array.isArray(doc[event]) ? doc[event] : [];
    rules.forEach((rule, ruleIndex) => {
      const object = readObject(rule);
      if (!object) return;
      const matcher = readString(object.matcher);
      const hooks = Array.isArray(object.hooks) ? object.hooks : [];
      hooks.forEach((hook, hookIndex) => {
        const entry = readObject(hook);
        if (!entry || entry.type !== "command") return;
        rows.push({
          event, ruleIndex, hookIndex, matcher,
          command: readString(entry.command),
          timeout: typeof entry.timeout === "number" ? String(entry.timeout) : "",
        });
      });
    });
  }
  return rows;
}

/** 就地更新树里的一行；返回新引用（顶层），浅拷贝路径上的对象。 */
function patchRow(doc: Json, row: HookRow, patch: Partial<Pick<HookRow, "matcher" | "command" | "timeout">>): Json {
  const next: Json = { ...doc };
  const rules = Array.isArray(next[row.event]) ? [...(next[row.event] as unknown[])] : [];
  const rule = readObject(rules[row.ruleIndex]);
  if (!rule) return next;
  const updatedRule: Json = { ...rule };
  if (patch.matcher !== undefined) updatedRule.matcher = patch.matcher;
  if (patch.command !== undefined || patch.timeout !== undefined) {
    const hooks = Array.isArray(updatedRule.hooks) ? [...(updatedRule.hooks as unknown[])] : [];
    const entry = readObject(hooks[row.hookIndex]);
    if (entry) {
      const updatedEntry: Json = { ...entry };
      if (patch.command !== undefined) updatedEntry.command = patch.command;
      if (patch.timeout !== undefined) {
        const parsed = Number.parseInt(patch.timeout, 10);
        if (Number.isFinite(parsed) && parsed > 0) updatedEntry.timeout = parsed;
        else delete updatedEntry.timeout;
      }
      hooks[row.hookIndex] = updatedEntry;
      updatedRule.hooks = hooks;
    }
  }
  rules[row.ruleIndex] = updatedRule;
  next[row.event] = rules;
  return next;
}

/** 删一行 hook 条目；规则里没有 hook 了就连规则一起删，事件空了整段删。 */
function removeRow(doc: Json, row: HookRow): Json {
  const next: Json = { ...doc };
  const rules = Array.isArray(next[row.event]) ? [...(next[row.event] as unknown[])] : [];
  const rule = readObject(rules[row.ruleIndex]);
  if (!rule) return next;
  const updatedRule: Json = { ...rule };
  const hooks = Array.isArray(updatedRule.hooks) ? [...(updatedRule.hooks as unknown[])] : [];
  hooks.splice(row.hookIndex, 1);
  if (hooks.length === 0) {
    rules.splice(row.ruleIndex, 1);
  } else {
    updatedRule.hooks = hooks;
    rules[row.ruleIndex] = updatedRule;
  }
  if (rules.length === 0) delete next[row.event];
  else next[row.event] = rules;
  return next;
}

/** 新增一条规则：`{ matcher, hooks: [{ type: "command", command }] }`。 */
function appendRow(doc: Json, event: HookEvent, matcher: string, command: string): Json {
  const next: Json = { ...doc };
  const rules = Array.isArray(next[event]) ? [...(next[event] as unknown[])] : [];
  rules.push({ matcher, hooks: [{ type: "command", command }] });
  next[event] = rules;
  return next;
}

export default function HooksSettingsPanel() {
  const { t } = useI18n();
  const desktop = isTauri();
  const [doc, setDoc] = useState<Json | null>(null);
  const [baseline, setBaseline] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const serialize = (value: Json | null) => JSON.stringify(value ?? {}, null, 2);
  const dirty = doc !== null && serialize(doc) !== baseline;
  useUnsavedGuard(() => dirty);

  useEffect(() => {
    if (!desktop) return;
    setBusy(true);
    void invoke<Json>("ai_cli_claude_hooks_read")
      .then((hooks) => {
        setDoc(hooks ?? {});
        setBaseline(JSON.stringify(hooks ?? {}, null, 2));
      })
      .catch((cause: unknown) => setError(String(cause)))
      .finally(() => setBusy(false));
  }, [desktop]);

  const rows = useMemo(() => (doc ? collectRows(doc) : []), [doc]);

  const save = async () => {
    if (!doc) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const saved = await invoke<Json>("ai_cli_claude_hooks_save", { hooks: doc });
      setDoc(saved ?? {});
      setBaseline(JSON.stringify(saved ?? {}, null, 2));
      setNotice(t("hooks.saved"));
    } catch (cause) {
      setError(String(cause));
    } finally { setSaving(false); }
  };

  const mutate = (next: Json) => {
    setDoc(next);
    setNotice(null);
  };

  if (!desktop) {
    return <p className="settings-note">{t("hooks.desktopOnly")}</p>;
  }
  return (
    <div className="settings-rows">
      <p className="settings-note">{t("hooks.intro")}</p>
      {busy ? <p className="settings-note" role="status"><Loader2 size={12} className="is-spinning" aria-hidden /> {t("ai.runtime.loading")}</p> : null}
      {error ? <p className="settings-note" role="alert">{error}</p> : null}
      {notice ? <p className="settings-note" role="status">{notice}</p> : null}
      {HOOK_EVENTS.map((event) => {
        const eventRows = rows.filter((row) => row.event === event);
        return (
          <section className="hooks-event" key={event}>
            <header className="hooks-event-head">
              <span className="settings-label">{t(EVENT_LABEL[event])}</span>
              <span className="settings-note">{t(EVENT_HINT[event])}</span>
              <button
                type="button"
                className="button"
                disabled={doc === null}
                onClick={() => mutate(appendRow(doc!, event, "", ""))}
              >
                <Plus size={13} aria-hidden /> {t("hooks.addRule")}
              </button>
            </header>
            {eventRows.length === 0 ? (
              <p className="settings-note hooks-event-empty">{t("hooks.noRules")}</p>
            ) : eventRows.map((row) => (
              <div className="hooks-row" key={`${row.event}:${row.ruleIndex}:${row.hookIndex}`}>
                <input
                  className="settings-input hooks-matcher"
                  value={row.matcher}
                  placeholder={t("hooks.matcherPlaceholder")}
                  spellCheck={false}
                  onChange={(e) => mutate(patchRow(doc!, row, { matcher: e.target.value }))}
                />
                <input
                  className="settings-input hooks-command"
                  value={row.command}
                  placeholder={t("hooks.commandPlaceholder")}
                  spellCheck={false}
                  onChange={(e) => mutate(patchRow(doc!, row, { command: e.target.value }))}
                />
                <input
                  className="settings-input hooks-timeout"
                  type="number"
                  min={1}
                  value={row.timeout}
                  placeholder={t("hooks.timeoutPlaceholder")}
                  title={t("hooks.timeoutTitle")}
                  onChange={(e) => mutate(patchRow(doc!, row, { timeout: e.target.value }))}
                />
                <button
                  type="button"
                  className="icon-button is-inline"
                  title={t("hooks.delete")}
                  aria-label={t("hooks.delete")}
                  onClick={() => mutate(removeRow(doc!, row))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </section>
        );
      })}
      <div className="settings-row">
        <span className="settings-label" />
        <span className="settings-actions">
          <button type="button" className="button is-primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <Loader2 size={13} className="is-spinning" aria-hidden /> : <Save size={13} aria-hidden />} {t("hooks.save")}
          </button>
        </span>
      </div>
    </div>
  );
}
