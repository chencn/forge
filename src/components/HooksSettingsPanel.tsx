import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useI18n } from "../i18n";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard";
import type { TranslationKey } from "../i18n/lang/zh";
import { AI_NAMES } from "../lib/aiCli";
import type { AiProvider } from "../lib/aiCli";
import Select from "./Select";
import AiActionDialog from "./AiActionDialog";

/**
 * 用户级 Hooks 管理：Claude 写 settings.json，Codex 写独立的 hooks.json。
 * 两者的事件与执行约束分别处理，不能把 RPC 的 camelCase 字段写回原生 JSON。
 * 编辑在原 JSON 树上就地改：matcher 改规则对象、command/timeout 改 hook 条目，
 * 面板不认识的字段（prompt 型 hook、CLAUDE_PROJECT_DIR 之类）原样留在树里——
 * 无损编辑，保存只替换 `hooks` 键，文件其余部分后端不动。
 */

/** Claude 现有可编辑事件；其它原生事件只读保留。 */
const CLAUDE_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Notification",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "PreCompact",
] as const;

/** Codex 0.164.0 的原生磁盘事件名，已经用 hooks/list 隔离验证。 */
const CODEX_EVENTS = [
  "PreModelRequest", "PostModelRequest", "PreToolUse", "PermissionRequest", "PostToolUse",
  "PreCompact", "PostCompact", "SessionStart", "SessionEnd", "UserPromptSubmit",
  "SubagentStart", "SubagentStop", "Stop", "Interrupt",
] as const;
/** Codex 在其它事件上会忽略 matcher，界面直接禁用，避免产生无效配置。 */
const CODEX_MATCHER_EVENTS: readonly string[] = [
  "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact",
  "SessionStart", "SessionEnd", "SubagentStart", "SubagentStop",
];
type HookEvent = (typeof CLAUDE_EVENTS)[number] | (typeof CODEX_EVENTS)[number];
type Json = Record<string, unknown>;
interface HooksConfig { path: string; hooks: Json }
interface NativeHook {
  key: string; eventName: string; handlerType: string; command?: string;
  sourcePath: string; trustStatus: string; enabled: boolean;
}
interface HooksStatus {
  data: { cwd: string; hooks: NativeHook[]; errors: { path: string; message: string }[]; warnings: string[] }[];
}

interface HookRow {
  /** 规则在树里的定位：事件名 + 规则下标 + hook 条目下标。 */
  event: HookEvent;
  ruleIndex: number;
  hookIndex: number;
  matcher: string;
  command: string;
  timeout: string;
  async: boolean;
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
  PreModelRequest: "hooks.event.preModelRequest",
  PostModelRequest: "hooks.event.postModelRequest",
  PermissionRequest: "hooks.event.permissionRequest",
  PostCompact: "hooks.event.postCompact",
  SessionEnd: "hooks.event.sessionEnd",
  SubagentStart: "hooks.event.subagentStart",
  Interrupt: "hooks.event.interrupt",
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
  PreModelRequest: "hooks.hint.preModelRequest",
  PostModelRequest: "hooks.hint.postModelRequest",
  PermissionRequest: "hooks.hint.permissionRequest",
  PostCompact: "hooks.hint.postCompact",
  SessionEnd: "hooks.hint.sessionEnd",
  SubagentStart: "hooks.hint.subagentStart",
  Interrupt: "hooks.hint.interrupt",
};

const readString = (value: unknown): string => (typeof value === "string" ? value : "");
const readObject = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);

/** 从 JSON 树里摘出可编辑的 command 型 hook 行；prompt 型等条目不进面板但也绝不丢。 */
function collectRows(doc: Json, events: readonly HookEvent[]): HookRow[] {
  const rows: HookRow[] = [];
  for (const event of events) {
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
          timeout: typeof entry.timeout === "number" ? String(entry.timeout) : readString(entry.timeout),
          async: entry.async === true,
        });
      });
    });
  }
  return rows;
}

/** 就地更新树里的一行；返回新引用（顶层），浅拷贝路径上的对象。 */
function patchRow(doc: Json, row: HookRow, patch: Partial<Pick<HookRow, "matcher" | "command" | "timeout" | "async">>): Json {
  const next: Json = { ...doc };
  const rules = Array.isArray(next[row.event]) ? [...(next[row.event] as unknown[])] : [];
  const rule = readObject(rules[row.ruleIndex]);
  if (!rule) return next;
  const updatedRule: Json = { ...rule };
  if (patch.matcher !== undefined) updatedRule.matcher = patch.matcher;
  if (patch.command !== undefined || patch.timeout !== undefined || patch.async !== undefined) {
    const hooks = Array.isArray(updatedRule.hooks) ? [...(updatedRule.hooks as unknown[])] : [];
    const entry = readObject(hooks[row.hookIndex]);
    if (entry) {
      const updatedEntry: Json = { ...entry };
      if (patch.command !== undefined) updatedEntry.command = patch.command;
      if (patch.async !== undefined) updatedEntry.async = patch.async;
      if (patch.timeout !== undefined) {
        // 非法输入留在草稿并阻止保存，不能用 parseInt 把 1.5 或 1e2 静默截断。
        if (patch.timeout === "") delete updatedEntry.timeout;
        else updatedEntry.timeout = /^\d+$/.test(patch.timeout) && Number.isSafeInteger(Number(patch.timeout))
          ? Number(patch.timeout) : patch.timeout;
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
  const [provider, setProvider] = useState<AiProvider>("claude");
  const [path, setPath] = useState("");
  const [doc, setDoc] = useState<Json | null>(null);
  const [baseline, setBaseline] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<HooksStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const saveLock = useRef(false);
  const events = provider === "codex" ? CODEX_EVENTS : CLAUDE_EVENTS;

  const serialize = (value: Json | null) => JSON.stringify(value ?? {}, null, 2);
  const dirty = doc !== null && serialize(doc) !== baseline;
  useUnsavedGuard(() => dirty || saveLock.current);

  const guard = (action: () => void) => {
    if (saveLock.current) return;
    if (dirty) setPendingLeave(() => action);
    else action();
  };
  const checkStatus = async (id: number) => {
    setChecking(true); setStatus(null); setStatusError(null);
    try {
      const result = await invoke<HooksStatus>("ai_cli_codex_hooks_status");
      if (id === generation.current) setStatus(result);
    } catch (cause) {
      if (id === generation.current) setStatusError(String(cause));
    } finally { if (id === generation.current) setChecking(false); }
  };

  useEffect(() => {
    if (!desktop) return;
    const id = ++generation.current;
    setBusy(true); setDoc(null); setPath(""); setError(null); setNotice(null);
    setStatus(null); setStatusError(null); setChecking(false);
    void invoke<HooksConfig>("ai_cli_hooks_read", { provider })
      .then((config) => {
        if (id !== generation.current) return;
        setDoc(config.hooks); setPath(config.path);
        setBaseline(serialize(config.hooks));
        if (provider === "codex") void checkStatus(id);
      })
      .catch((cause: unknown) => { if (id === generation.current) setError(String(cause)); })
      .finally(() => { if (id === generation.current) setBusy(false); });
    // 切换 CLI、刷新或离开面板后，旧请求不得再修改当前草稿或状态。
    return () => { generation.current += 1; };
  }, [desktop, provider, reload]);

  const rows = useMemo(() => (doc ? collectRows(doc, events) : []), [doc, events]);
  const invalid = rows.some((row) => !row.command.trim() || (row.timeout !== "" &&
    (!/^\d+$/.test(row.timeout) || !Number.isSafeInteger(Number(row.timeout)))) ||
    (provider === "codex" && ((["SessionEnd", "Interrupt"].includes(row.event) && Number(row.timeout) > 3) ||
      (row.event === "SessionEnd" && row.async))));
  // 不支持的事件/类型仍可查看原文，且始终留在待保存树里。
  const readOnly = doc ? Object.fromEntries(Object.entries(doc).flatMap(([event, rules]) => {
    if (!(events as readonly string[]).includes(event)) return [[event, rules]];
    const kept = (rules as Json[]).map((rule) => ({ ...rule, hooks: (rule.hooks as Json[]).filter((hook) => hook.type !== "command") }))
      .filter((rule) => rule.hooks.length > 0);
    return kept.length ? [[event, kept]] : [];
  })) : {};

  const save = async () => {
    if (!doc || busy || invalid || saveLock.current) return;
    saveLock.current = true;
    const id = ++generation.current;
    // 保存会使先前的状态查询失效；即使保存失败，也不能遗留它的加载标记。
    setChecking(false);
    setSaving(true); setError(null); setNotice(null);
    try {
      const saved = await invoke<HooksConfig>("ai_cli_hooks_save", { provider, hooks: doc, expected: JSON.parse(baseline) });
      if (id !== generation.current) return;
      setDoc(saved.hooks); setPath(saved.path);
      setBaseline(serialize(saved.hooks));
      setNotice(t("hooks.saved", { provider: AI_NAMES[provider] }));
      if (provider === "codex") void checkStatus(id);
    } catch (cause) {
      if (id === generation.current) setError(String(cause));
    } finally { saveLock.current = false; setSaving(false); }
  };

  const mutate = (next: Json) => {
    setDoc(next);
    setNotice(null);
  };

  if (!desktop) {
    return <p className="settings-note">{t("hooks.desktopOnly")}</p>;
  }
  return (
    <div className="settings-rows hooks-settings">
      <div className="settings-row hooks-toolbar">
        <span className="settings-label">{t("hooks.provider")}</span>
        <Select value={provider} label={t("hooks.provider")} placeholder={t("hooks.provider")} disabled={saving}
          options={(["claude", "codex"] as AiProvider[]).map((value) => ({ value, label: AI_NAMES[value] }))}
          onChange={(next) => { if (next !== provider) guard(() => setProvider(next)); }} />
        <button type="button" className="button" disabled={saving} onClick={() => guard(() => setReload((value) => value + 1))}>
          <RefreshCw size={13} aria-hidden /> {t("hooks.reload")}
        </button>
      </div>
      <p className="settings-note">{t(provider === "codex" ? "hooks.codexIntro" : "hooks.intro")}</p>
      {path ? <p className="settings-note hooks-path">{path}</p> : null}
      {busy ? <p className="settings-note" role="status"><Loader2 size={12} className="is-spinning" aria-hidden /> {t("ai.runtime.loading")}</p> : null}
      {error ? <p className="settings-note" role="alert">{error}</p> : null}
      {notice ? <p className="settings-note" role="status">{notice}</p> : null}
      {dirty && invalid ? <p className="settings-note" role="alert">{t("hooks.invalid")}</p> : null}
      <fieldset className="hooks-fields" disabled={doc === null || busy || saving}>
        {events.map((event) => {
          const eventRows = rows.filter((row) => row.event === event);
          return (
            <section className="hooks-event" key={event}>
              <header className="hooks-event-head">
                <span className="settings-label">{t(EVENT_LABEL[event])}</span>
                <span className="settings-note">{t(EVENT_HINT[event])}</span>
                <button
                  type="button"
                  className="button"
                  aria-label={`${event} ${t("hooks.addRule")}`}
                  disabled={doc === null || saving}
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
                    aria-label={`${event} matcher`}
                    disabled={provider === "codex" && !CODEX_MATCHER_EVENTS.includes(event)}
                    title={provider === "codex" && !CODEX_MATCHER_EVENTS.includes(event) ? t("hooks.matcherIgnored") : undefined}
                    placeholder={t(provider === "codex" ? "hooks.codexMatcher" : "hooks.matcherPlaceholder")}
                    spellCheck={false}
                    onChange={(e) => mutate(patchRow(doc!, row, { matcher: e.target.value }))}
                  />
                  <textarea
                    className="settings-input hooks-command"
                    rows={2}
                    wrap="soft"
                    value={row.command}
                    aria-label={`${event} command`}
                    placeholder={t("hooks.commandPlaceholder")}
                    spellCheck={false}
                    onChange={(e) => mutate(patchRow(doc!, row, { command: e.target.value }))}
                  />
                  <input
                    className="settings-input hooks-timeout"
                    type="number"
                    min={0}
                    step={1}
                    max={provider === "codex" && ["SessionEnd", "Interrupt"].includes(event) ? 3 : undefined}
                    value={row.timeout}
                    aria-label={`${event} timeout`}
                    placeholder={t("hooks.timeoutPlaceholder")}
                    title={t("hooks.timeoutTitle")}
                    onChange={(e) => mutate(patchRow(doc!, row, { timeout: e.target.value }))}
                  />
                  {provider === "codex" ? <label className="settings-note hooks-async">
                    <input type="checkbox" checked={row.async} aria-label={`${event} async`}
                      disabled={event === "SessionEnd" && !row.async}
                      onChange={(e) => mutate(patchRow(doc!, row, { async: e.target.checked }))} /> {t("hooks.async")}
                  </label> : null}
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
      </fieldset>
      {Object.keys(readOnly).length ? <details><summary className="settings-note">{t("hooks.readOnly")}</summary>
        <pre className="hooks-raw">{JSON.stringify(readOnly, null, 2)}</pre>
      </details> : null}
      <div className="hooks-actions">
        <button type="button" className="button is-primary" disabled={!dirty || invalid || busy || saving} onClick={() => void save()}>
          {saving ? <Loader2 size={13} className="is-spinning" aria-hidden /> : <Save size={13} aria-hidden />} {t("hooks.save")}
        </button>
      </div>
      {provider === "codex" && doc ? <section className="hooks-status">
        <p className="settings-note">{t("hooks.trustHint")}</p>
        {dirty ? <p className="settings-note">{t("hooks.statusAfterSave")}</p> : <>
          {checking ? <p className="settings-note" role="status">{t("hooks.checking")}</p> : null}
          {statusError ? <p className="settings-note" role="alert">{t("hooks.statusFailed", { message: statusError })}</p> : null}
          {status?.data.map((entry) => <div className="hooks-status" key={entry.cwd}>
            {entry.errors.map((item, index) => <div className="settings-note" role="alert" key={`error:${index}`}>
              <p className="hooks-path">{item.path}</p>
              <p>{item.message}</p>
            </div>)}
            {entry.warnings.map((warning, index) => <p className="settings-note" role="status" key={`warning:${index}`}>{warning}</p>)}
            {entry.hooks.map((hook) => <div className="settings-note hooks-status-item" key={hook.key}>
              <div className="hooks-status-meta">
                <span>{hook.eventName}</span>
                <span>{t("hooks.nativeState", {
                  trust: t(({ managed: "hooks.trust.managed", trusted: "hooks.trust.trusted", untrusted: "hooks.trust.untrusted", modified: "hooks.trust.modified" } as Record<string, TranslationKey>)[hook.trustStatus] ?? "hooks.trust.unknown"),
                  enabled: t(hook.enabled ? "hooks.enabled" : "hooks.disabled"),
                })}</span>
              </div>
              <pre className="hooks-status-command">{hook.command ?? hook.handlerType}</pre>
              <p className="hooks-path">{hook.sourcePath}</p>
            </div>)}
          </div>)}
        </>}
      </section> : null}
      {pendingLeave ? <AiActionDialog title={t("settings.unsavedTitle")} confirm={t("settings.unsavedConfirm")} danger
        onCancel={() => setPendingLeave(null)} onConfirm={() => { const action = pendingLeave; setPendingLeave(null); action(); }}>
        <p className="dialog-body">{t("settings.unsavedHint")}</p>
      </AiActionDialog> : null}
    </div>
  );
}
