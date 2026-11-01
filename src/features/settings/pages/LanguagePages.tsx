import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import { useI18n } from "../../../i18n";
import type { TranslationKey } from "../../../i18n/lang/zh";
import { useLspConfig, useLspSessionStatuses } from "../../../hooks/useLspConfig";
import { serverEnabled, serverEntries } from "../../../lib/lspConfig";
import type { LspServerConfig, LspServerEntry } from "../../../lib/lspConfig";
import { lspConfigDefaults, lspInstall, lspRetry, lspUninstall } from "../../../lib/lsp";
import type { LspServerProbe, LspSessionStatus } from "../../../lib/lsp";
import { describeError } from "../../../lib/errors";
import { lspManager } from "../../../lib/lspManager";
import type { LspWakeResult as WakeResult } from "../../../lib/lspTypes";
import { languageCatalog, languageNames } from "../../../lib/editorEnv";
import { Badge, Button, Checkbox, EmptyState, Icon, IconButton, Input, Popup, Spinner } from "../../../ui";
import CopyButton from "../../../components/CopyButton";

type Runtime = "idle" | "running" | "problem" | "unknown";

const RUNTIME_LABEL: Record<Runtime, TranslationKey> = {
  idle: "lsp.runtime.idle",
  running: "lsp.runtime.running",
  problem: "lsp.runtime.problem",
  unknown: "lsp.runtime.unknown",
};

type ProbeState = "installed" | "missing" | "unknown";

const STATE_LABEL: Record<ProbeState, TranslationKey> = {
  installed: "lsp.probe.installed",
  missing: "lsp.probe.missing",
  unknown: "lsp.probe.unknown",
};

const STATE_TONE: Record<ProbeState, "success" | "warning" | "neutral"> = {
  installed: "success",
  missing: "warning",
  unknown: "neutral",
};

function probeState(probe?: LspServerProbe): ProbeState {
  if (!probe) return "unknown";
  return probe.installed ? "installed" : "missing";
}

function runtimeOf(items: LspSessionStatus[] | undefined, stale: boolean): Runtime {
  if (stale) return "unknown";
  if (!items || items.length === 0) return "idle";
  return items.some((item) => item.status !== "running") ? "problem" : "running";
}

/** 逗号分隔的列表字段：写回时去空白、去空项。 */
function splitList(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function joinList(items: string[]): string {
  return items.join(", ");
}

/** 含空格的参数片段用双引号包住，与后端拆分规则一致。 */
function quoteArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg;
}

/** 命令行 → 词数组；引号包住的算一段，引号不配对时 quoteError 为真。 */
function parseCommand(line: string): { words: string[]; quoteError: boolean } {
  const words: string[] = [];
  let current = "";
  let has = false;
  let quoted = false;
  for (const char of line.trim()) {
    if (char === '"') {
      quoted = !quoted;
      has = true;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (has) {
        words.push(current);
        current = "";
        has = false;
      }
      continue;
    }
    current += char;
    has = true;
  }
  if (has) words.push(current);
  return { words, quoteError: quoted };
}

/** "ruff server" → ruff：新服务的缺省名取命令的末段。 */
function nameFromCommand(command: string): string {
  return command.split(/[\\/]/).pop() ?? command;
}

/** 服务键只能由这些字符组成：它同时是 lsp.json 的键与进程名的缺省。 */
const SERVER_NAME = /^[A-Za-z0-9_+\-]+$/;

/** 握手超时的合法范围：低于 5 秒基本没 server 能起完，高于 10 分钟是没在等。 */
const TIMEOUT_MIN = 5_000;
const TIMEOUT_MAX = 600_000;

/** 逐字段比较：lsp.json 是用户手改的文件，不能用引用或键序判断是否被改过。 */
const SERVER_FIELDS = [
  "mode",
  "program",
  "path",
  "args",
  "languages",
  "rootMarkers",
  "installCommand",
  "uninstallCommand",
  "startupTimeoutMs",
  "initOptions",
  "supportsBuiltin",
  "homepage",
  "installHint",
] as const;

function sameServer(a: LspServerConfig, b: LspServerConfig): boolean {
  return SERVER_FIELDS.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

// ---------------------------------------------------------------------------
// 表单构件（对标 IDE 布局：标题分隔线 + 「标签：控件」+ 标签下方的说明）

/** 带标题的分隔线；collapsible 的可以像 IDE 的可隐藏分隔线一样折起来。 */
function Section({
  title,
  note,
  collapsible,
  defaultOpen = true,
  children,
}: {
  title: string;
  note?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shown = !collapsible || open;
  return (
    <section className="lsps-section" aria-label={title}>
      {collapsible ? (
        <button
          type="button"
          className="lsps-section-title lsps-section-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon icon={open ? "chevron-down" : "chevron-right"} size={12} />
          <span>{title}</span>
          <span className="lsps-section-rule" aria-hidden />
        </button>
      ) : (
        <div className="lsps-section-title">
          <span>{title}</span>
          <span className="lsps-section-rule" aria-hidden />
        </div>
      )}
      {shown ? (
        <div className="lsps-section-body">
          {note ? <div className="lsps-note">{note}</div> : null}
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** 标签在上、控件在下（详情栏窄，放不下左右两栏），说明在最下面。 */
function Row({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="lsps-row">
      <label className="lsps-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="lsps-control">{children}</div>
      {hint ? <div className="lsps-hint">{hint}</div> : null}
    </div>
  );
}

interface FieldProps {
  label: string;
  value: string;
  /** 文本 → 提交值；返回 null 表示整项清空；抛错视为非法。 */
  parse: (text: string) => string | null;
  onCommit: (value: string | null) => void;
  placeholder?: string;
  hint?: ReactNode;
  multiline?: boolean;
}

/**
 * 一个文本字段：输入时不落盘（lsp.json 是整份原子写，逐键写盘太重），
 * 失焦或回车才提交；非法文本留在框里并标记，不会写坏配置。
 */
function Field({ label, value, parse, onCommit, placeholder, hint, multiline }: FieldProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const text = draft ?? value;
  const change = (next: string) => {
    setDraft(next);
    try {
      parse(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const commit = () => {
    if (draft === null) return;
    try {
      const next = parse(draft);
      setError(null);
      setDraft(null);
      onCommit(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Row
      label={label}
      htmlFor={id}
      hint={error ? (
        <span className="lsps-error" role="alert">
          {error}
        </span>
      ) : (
        hint
      )}
    >
      {multiline ? (
        <textarea
          id={id}
          value={text}
          placeholder={placeholder}
          spellCheck={false}
          rows={Math.min(14, Math.max(3, text.split("\n").length + 1))}
          aria-invalid={error ? true : undefined}
          className={clsx("lsps-area", error && "lsps-invalid")}
          onChange={(e) => change(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commit();
            }
          }}
        />
      ) : (
        <Input
          id={id}
          mono
          value={text}
          placeholder={placeholder}
          invalid={!!error}
          className="lsps-grow"
          onChange={(e) => change(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
      )}
    </Row>
  );
}

/** "Python, TypeScript ▾"：带过滤的语言勾选浮层，语言目录来自编辑器语言表。 */
function LanguagePicker({
  value,
  onChange,
  invalid,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  invalid?: boolean;
}) {
  const { t } = useI18n();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const catalog = useMemo(() => languageCatalog(), []);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? catalog.filter((l) => l.label.toLowerCase().includes(q) || l.id.includes(q)) : catalog;
  }, [catalog, query]);
  const label = languageNames(value);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={invalid || undefined}
        className={clsx("lsps-picker", invalid && "lsps-invalid")}
        onClick={() => setOpen(!open)}
      >
        <span className={clsx("lsps-picker-text", !label && "is-placeholder")}>
          {label || t("lsp.new.choose")}
        </span>
        <Icon icon="chevron-down" size={12} />
      </button>
      <Popup
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        placement="bottom-start"
        role="dialog"
        aria-label={t("lsp.new.languages")}
        className="lsps-picker-popup"
      >
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("lsp.language.filter")}
          aria-label={t("lsp.language.filter")}
        />
        <div className="lsps-picker-list">
          {shown.map((l) => (
            <Checkbox
              key={l.id}
              checked={value.includes(l.id)}
              label={l.label}
              onChange={(on) => onChange(on ? [...value, l.id] : value.filter((v) => v !== l.id))}
            />
          ))}
          {shown.length === 0 ? <div className="lsps-note">{t("lsp.language.empty")}</div> : null}
        </div>
      </Popup>
    </>
  );
}

// ---------------------------------------------------------------------------
// 左列的行与右栏的详情

function ToolRow({
  row,
  probe,
  selected,
  onSelect,
}: {
  row: LspServerEntry;
  probe?: LspServerProbe;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const state = probeState(probe);
  return (
    <li className={clsx("lsps-row", selected && "lsps-row-selected")}>
      <button
        type="button"
        className={clsx("lsps-row-main", row.mode === "off" && "lsps-row-off")}
        aria-current={selected || undefined}
        data-tool={row.id}
        title={`${row.id} — ${languageNames(row.languages)}`}
        onClick={onSelect}
      >
        <Badge dot tone={STATE_TONE[state]}>
          {t(STATE_LABEL[state])}
        </Badge>
        <span className="lsps-row-name">{row.id}</span>
        {row.mode === "builtin" ? <span className="lsps-kind-tag">{t("lsp.mode.builtin")}</span> : null}
        {row.mode === "off" ? <span className="lsps-kind-tag">{t("lsp.tag.disabled")}</span> : null}
        <span className="lsps-row-langs">{languageNames(row.languages)}</span>
      </button>
    </li>
  );
}

interface DetailsProps {
  row: LspServerEntry;
  probe?: LspServerProbe;
  note: { tone: "error" | "ok"; text: string } | null;
  installing: boolean;
  uninstalling: boolean;
  waking: boolean;
  sessionItems: LspSessionStatus[];
  stale: boolean;
  reason: string;
  hasWorkspace: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onStart: () => void;
}

/** 右栏：头部（标题、状态、动作）→ 安装反馈 → 日志 → 设置表单。 */
function Details({
  row,
  probe,
  note,
  installing,
  uninstalling,
  waking,
  sessionItems,
  stale,
  reason,
  hasWorkspace,
  onInstall,
  onUninstall,
  onStart,
}: DetailsProps) {
  const { t } = useI18n();
  const [logOpen, setLogOpen] = useState(false);
  const state = probeState(probe);
  const missing = state === "missing";
  const installed = state === "installed";
  const runtime = runtimeOf(sessionItems, stale);
  const logLines = lspManager.logs(row.id);

  const subtitle: ReactNode[] = [];
  const push = (node: ReactNode) => {
    if (subtitle.length > 0) subtitle.push(<span key={`sep-${subtitle.length}`}>{" · "}</span>);
    subtitle.push(node);
  };
  push(
    <code key="command" className="lsps-code">
      {row.program}
      {row.args ? ` ${row.args}` : ""}
    </code>
  );
  if (serverEnabled(row)) push(<span key="runtime">{t(RUNTIME_LABEL[runtime])}</span>);
  if (row.homepage) {
    push(
      <a key="homepage" href={row.homepage} target="_blank" rel="noreferrer">
        {t("lsp.homepage")}
      </a>
    );
  }

  return (
    <div className="lsps-details" aria-label={`${row.id} details`}>
      <div className="lsps-header">
        <div className="lsps-header-text">
          <div className="lsps-title">
            <span>{row.id}</span>
            <Badge tone={STATE_TONE[state]}>{t(STATE_LABEL[state])}</Badge>
          </div>
          <div className="lsps-subtitle">{subtitle}</div>
        </div>
        <div className="lsps-actions">
          {missing && row.installCommand ? (
            <Button size="small" variant="primary" disabled={installing} onClick={onInstall}>
              {t(installing ? "lsp.install.running" : "lsp.install")}
            </Button>
          ) : null}
          {installed && row.installCommand ? (
            <Button size="small" variant="secondary" disabled={installing || uninstalling} onClick={onInstall}>
              {t("lsp.action.reinstall")}
            </Button>
          ) : null}
          {installed && row.uninstallCommand ? (
            <Button size="small" variant="ghost" disabled={installing || uninstalling} onClick={onUninstall}>
              {t("lsp.uninstall")}
            </Button>
          ) : null}
          {serverEnabled(row) ? (
            <Button
              size="small"
              variant="ghost"
              disabled={waking || (sessionItems.length === 0 && !hasWorkspace)}
              title={sessionItems.length === 0 && !hasWorkspace ? t("lsp.wake.noWorkspace") : undefined}
              onClick={onStart}
            >
              {t(sessionItems.length > 0 ? "lsp.restart" : waking ? "lsp.wake.running" : "lsp.wake")}
            </Button>
          ) : null}
        </div>
      </div>
      {note && note.tone === "error" ? (
        <div className="lsps-error" role="alert">
          <span>{note.text}</span>
          <CopyButton text={note.text} />
        </div>
      ) : null}
      {missing && !row.installCommand ? (
        <div className="lsps-notice">{row.installHint || t("lsp.install.none")}</div>
      ) : null}
      {state === "unknown" ? <div className="lsps-notice">{t("lsp.probe.hint")}</div> : null}
      {reason && serverEnabled(row) ? (
        <div className="lsps-hint">
          <span>{reason}</span>
          <CopyButton text={reason} />
        </div>
      ) : null}
      {logLines.length > 0 ? (
        <div>
          <button
            type="button"
            className="lsps-link-button"
            aria-expanded={logOpen}
            onClick={() => setLogOpen(!logOpen)}
          >
            {t(logOpen ? "lsp.details.hideLog" : "lsp.details.showLog")}
          </button>
          {logOpen ? (
            <pre className="lsps-log" aria-label={`${row.id} log`}>
              {logLines.join("\n")}
            </pre>
          ) : null}
        </div>
      ) : null}
      <ServerForm row={row} probe={probe} />
      <RestoreDefaults row={row} />
    </div>
  );
}

/** 一个语言服务的设置：启用、可执行文件、启动项、安装项。直接落盘，没有暂存。 */
function ServerForm({ row, probe }: { row: LspServerEntry; probe?: LspServerProbe }) {
  const { t } = useI18n();
  const { patchServer } = useLspConfig();
  const set = (next: Partial<LspServerConfig>) => patchServer(row.id, next);
  const hasInit = typeof row.initOptions === "object" && row.initOptions !== null;
  const initText = hasInit ? JSON.stringify(row.initOptions, null, 2) : "";
  const executableHint = !probe
    ? t("lsp.probe.hint")
    : probe.installed && probe.path
      ? t("lsp.hint.using", { path: probe.path })
      : t("lsp.hint.notFound");
  return (
    <div className="lsps-form">
      <Checkbox
        checked={row.mode !== "off"}
        label={t("lsp.use", { name: row.id })}
        onChange={(on) => set({ mode: on ? "lsp" : "off" })}
      />
      <Section title={t("lsp.section.executable")}>
        <Field
          label={t("lsp.field.program")}
          value={row.program}
          parse={(text) => {
            const trimmed = text.trim();
            if (!trimmed) throw new Error(t("lsp.error.program"));
            return trimmed;
          }}
          onCommit={(value) => value && set({ program: value })}
          placeholder="rust-analyzer"
        />
        <Field
          label={t("lsp.field.path")}
          value={row.path}
          parse={(text) => text.trim()}
          onCommit={(value) => set({ path: value ?? "" })}
          placeholder={t("lsp.field.path.hint")}
          hint={executableHint}
        />
        <Field
          label={t("lsp.dialog.markers")}
          value={joinList(row.rootMarkers)}
          parse={(text) => joinList(splitList(text))}
          onCommit={(value) => set({ rootMarkers: splitList(value ?? "") })}
          placeholder="Cargo.toml, *.csproj"
          hint={t("lsp.dialog.markers.hint")}
        />
      </Section>
      <Section
        title={t("lsp.section.startup")}
        note={t("lsp.startup.note")}
        collapsible
        defaultOpen={row.args.trim() !== "" || hasInit}
      >
        <Field
          label={t("lsp.args")}
          value={row.args}
          parse={(text) => text.trim()}
          onCommit={(value) => set({ args: value ?? "" })}
          placeholder="--stdio"
        />
        <Field
          label={t("lsp.dialog.init")}
          value={initText}
          multiline
          parse={(text) => {
            const trimmed = text.trim();
            if (!trimmed) return "";
            let parsed: unknown;
            try {
              parsed = JSON.parse(trimmed);
            } catch {
              throw new Error(t("lsp.error.initJson"));
            }
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error(t("lsp.error.initObject"));
            }
            return JSON.stringify(parsed, null, 2);
          }}
          onCommit={(value) => {
            if (value === null || value === "") {
              set({ initOptions: null });
              return;
            }
            try {
              set({ initOptions: JSON.parse(value) });
            } catch {
              // 非法文本在 parse 里就被挡住了，这里只是兜底。
            }
          }}
          placeholder={'{ "key": "value" }'}
        />
      </Section>
      <Section title={t("lsp.section.install")} collapsible defaultOpen={false}>
        <Field
          label={t("lsp.dialog.install")}
          value={row.installCommand}
          parse={(text) => text.trim()}
          onCommit={(value) => value !== null && set({ installCommand: value })}
          placeholder="npm install -g ..."
        />
        <Field
          label={t("lsp.dialog.timeout")}
          value={String(row.startupTimeoutMs)}
          parse={(text) => {
            const trimmed = text.trim();
            if (!trimmed) return null;
            const ms = Number(trimmed);
            if (!Number.isFinite(ms) || Math.round(ms) !== ms || ms < TIMEOUT_MIN || ms > TIMEOUT_MAX) {
              throw new Error(t("lsp.error.timeout"));
            }
            return String(Math.round(ms));
          }}
          onCommit={(value) => value !== null && set({ startupTimeoutMs: Number(value) })}
        />
      </Section>
    </div>
  );
}

/** 恢复默认：与后端种子表逐字段比对，改过才显示。自填的服务没有默认可言。 */
function RestoreDefaults({ row }: { row: LspServerEntry }) {
  const { t } = useI18n();
  const { putServer } = useLspConfig();
  // undefined 是还没读到，null 是默认表里没有这一项。
  const [defaults, setDefaults] = useState<LspServerConfig | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void lspConfigDefaults().then((config) => {
      if (live) setDefaults(config.servers[row.id] ?? null);
    });
    return () => {
      live = false;
    };
  }, [row.id]);
  if (!defaults || sameServer(row, defaults)) return null;
  return (
    <div>
      <button type="button" className="lsps-link" onClick={() => putServer(row.id, defaults)}>
        {t("lsp.restore")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 新增语言服务

/** 问命令、名称与语言；确定后立即落盘，列表选中这一项。 */
function NewServerDialog({
  existing,
  onClose,
  onAdded,
}: {
  existing: readonly string[];
  onClose: () => void;
  onAdded: (name: string) => void;
}) {
  const { t } = useI18n();
  const { putServer } = useLspConfig();
  const [commandLine, setCommandLine] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [languages, setLanguages] = useState<string[]>([]);
  // "ruff server"：可执行文件在前，其余是参数。
  const { words, quoteError } = parseCommand(commandLine);
  const [command = "", ...args] = words;
  const effectiveName = (name ?? nameFromCommand(command)).trim();
  const problem = quoteError
    ? t("lsp.new.error.quote")
    : !command
      ? t("lsp.new.error.command")
      : !SERVER_NAME.test(effectiveName)
        ? t("lsp.new.error.name")
        : existing.includes(effectiveName)
          ? t("lsp.new.error.exists", { name: effectiveName })
          : languages.length === 0
            ? t("lsp.error.languages")
            : null;
  const add = () => {
    if (problem) return;
    putServer(effectiveName, {
      mode: "lsp",
      program: command,
      path: "",
      args: args.map(quoteArg).join(" "),
      languages,
      rootMarkers: [],
      installCommand: "",
      uninstallCommand: "",
      startupTimeoutMs: 30_000,
      initOptions: null,
      supportsBuiltin: false,
      homepage: "",
      installHint: "",
    });
    onAdded(effectiveName);
  };
  return (
    <div
      className="dialog-backdrop is-wide"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        className="dialog lsp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("lsp.new.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="dialog-title">{t("lsp.new.title")}</p>
        <div className="lsps-dialog-body">
          <Row label={t("lsp.new.command")} htmlFor="lsp-new-command">
            <Input
              id="lsp-new-command"
              mono
              autoFocus
              className="lsps-grow"
              value={commandLine}
              placeholder="ruff server"
              onChange={(e) => setCommandLine(e.target.value)}
            />
          </Row>
          <Row label={t("lsp.new.name")} htmlFor="lsp-new-name">
            <Input
              id="lsp-new-name"
              mono
              className="lsps-grow"
              value={name ?? nameFromCommand(command)}
              onChange={(e) => setName(e.target.value)}
            />
          </Row>
          <Row label={t("lsp.new.languages")}>
            <LanguagePicker value={languages} onChange={setLanguages} invalid={languages.length === 0} />
          </Row>
          <div className="lsps-note">{problem ?? t("lsp.new.note")}</div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("dialog.cancel")}
          </button>
          <button type="button" className="button is-primary" disabled={!!problem} title={problem ?? undefined} onClick={add}>
            {t("dialog.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页面：左列（工具栏 + 分段过滤 + 分组列表），右栏（详情 + 设置）

export function LanguageLspPage({
  workspace,
  onLspKick,
  onLspWake,
}: {
  workspace: string | null;
  onLspKick?: () => void;
  onLspWake?: (serverId: string) => Promise<WakeResult>;
}) {
  const { t } = useI18n();
  const { config, removeServer, probes, reprobe, probing, probeError } = useLspConfig();
  const sessions = useLspSessionStatuses();

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "missing" | "installed">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [waking, setWaking] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, { tone: "error" | "ok"; text: string }>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [, setLogTick] = useState(0);

  useEffect(() => {
    // 设置页是用户明确查看本机状态的入口；进入就探测，列表才不是「未探测」。
    void reprobe();
  }, [reprobe]);

  useEffect(() => {
    return lspManager.watchStatus((serverId, _status, detail) => {
      setReasons((current) => {
        if (current[serverId] === (detail ?? "")) return current;
        return { ...current, [serverId]: detail ?? "" };
      });
    });
  }, []);

  useEffect(() => {
    return lspManager.watchLogs(() => setLogTick((tick) => tick + 1));
  }, []);

  const rows = useMemo(() => serverEntries(config), [config]);
  const queryText = query.trim().toLowerCase();
  const isMissing = (row: LspServerEntry) => probes?.[row.id]?.installed === false;
  const shown = useMemo(
    () =>
      rows.filter((row) => {
        if (filter === "missing" && !isMissing(row)) return false;
        if (filter === "installed" && isMissing(row)) return false;
        if (!queryText) return true;
        return [row.id, row.program, row.path, languageNames(row.languages), ...row.languages].some((text) =>
          text.toLowerCase().includes(queryText)
        );
      }),
    // isMissing 只依赖 probes，直接列进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, probes, filter, queryText]
  );
  const ready = shown.filter((row) => !isMissing(row));
  const missing = shown.filter((row) => isMissing(row));
  const ordered = [...ready, ...missing];
  const selected = ordered.find((row) => row.id === selectedId) ?? ordered[0] ?? null;
  const missingCount = rows.filter((row) => isMissing(row)).length;

  const wake = async (id: string) => {
    setWaking(id);
    try {
      if (onLspWake) {
        await onLspWake(id);
        sessions.refresh();
      }
    } finally {
      setWaking(null);
    }
  };

  const restart = async (items: LspSessionStatus[]) => {
    if (items.length === 0) return;
    const serverId = items[0]!.server;
    setWaking(serverId);
    try {
      await Promise.all(items.map((item) => lspRetry(item.id)));
      sessions.refresh();
    } finally {
      setWaking(null);
    }
  };

  const start = (row: LspServerEntry) => {
    const items = sessions.byServer[row.id] ?? [];
    if (items.length > 0) void restart(items);
    else void wake(row.id);
  };

  const runInstall = async (id: string) => {
    const entry = rows.find((row) => row.id === id);
    if (!entry || !entry.installCommand) return;
    setInstalling(id);
    try {
      const result = await lspInstall(id);
      if (result.exitCode !== 0) {
        const output = result.output.trim();
        setNotes((current) => ({
          ...current,
          [id]: {
            tone: "error",
            text: `${t("lsp.install.failed", { code: result.exitCode ?? "?" })}${output ? `\n${output}` : ""}`,
          },
        }));
        return;
      }
      setNotes((current) => ({ ...current, [id]: { tone: "ok", text: t("lsp.install.success") } }));
      await reprobe();
      sessions.refresh();
      if (onLspKick) onLspKick();
    } catch (error) {
      setNotes((current) => ({
        ...current,
        [id]: { tone: "error", text: t("lsp.install.error", { detail: describeError(String(error), t) }) },
      }));
    } finally {
      setInstalling(null);
    }
  };

  const runUninstall = async (id: string) => {
    const entry = rows.find((row) => row.id === id);
    if (!entry || !entry.uninstallCommand) return;
    setUninstalling(id);
    try {
      const result = await lspUninstall(id);
      if (result.exitCode !== 0) {
        const output = result.output.trim();
        setNotes((current) => ({
          ...current,
          [id]: {
            tone: "error",
            text: `${t("lsp.uninstall.failed", { code: result.exitCode ?? "?" })}${output ? `\n${output}` : ""}`,
          },
        }));
        return;
      }
      setNotes((current) => ({ ...current, [id]: { tone: "ok", text: t("lsp.uninstall.success") } }));
      await reprobe();
      sessions.refresh();
      if (onLspKick) onLspKick();
    } catch (error) {
      setNotes((current) => ({
        ...current,
        [id]: { tone: "error", text: t("lsp.uninstall.error", { detail: describeError(String(error), t) }) },
      }));
    } finally {
      setUninstalling(null);
      setPendingUninstall(null);
    }
  };

  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = selected ? ordered.findIndex((row) => row.id === selected.id) : -1;
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    setSelectedId(next.id);
    event.currentTarget.querySelector<HTMLElement>(`[data-tool="${CSS.escape(next.id)}"]`)?.focus();
  };

  const group = (title: string, list: LspServerEntry[]) =>
    list.length > 0 ? (
      <>
        <li className="lsps-group" role="presentation">
          <span>{title}</span>
          <span className="lsps-group-count">{list.length}</span>
        </li>
        {list.map((row) => (
          <ToolRow
            key={row.id}
            row={row}
            probe={probes?.[row.id]}
            selected={selected?.id === row.id}
            onSelect={() => setSelectedId(row.id)}
          />
        ))}
      </>
    ) : null;

  return (
    <div className="settings-rows">
      <div className="lsps-page">
        <p className="lsps-intro">{t("lsp.page.intro")}</p>
        {probeError ? (
          <p className="lsps-error">
            {t("lsp.probe.failed", { detail: describeError(probeError, t) })}
            <CopyButton text={probeError} />
          </p>
        ) : null}
        <div className="lsps-body">
          <div className="lsps-side">
            <div className="lsps-toolbar">
              <IconButton icon="plus" size="small" title={t("lsp.toolbar.add")} onClick={() => setAdding(true)} />
              <IconButton
                icon="minus"
                size="small"
                title={t("lsp.toolbar.remove")}
                disabled={!selected}
                onClick={() => selected && setPendingRemove(selected.id)}
              />
              <span className="lsps-toolbar-sep" aria-hidden />
              {probing ? (
                <Spinner size={14} label={t("lsp.toolbar.checking")} />
              ) : (
                <IconButton
                  icon="refresh"
                  size="small"
                  title={t("lsp.toolbar.recheck")}
                  onClick={() => void reprobe()}
                />
              )}
              <Input
                type="search"
                className="lsps-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("lsp.search.filter")}
                aria-label={t("lsp.search.filter")}
              />
            </div>
            <div className="lsps-segmented" role="radiogroup" aria-label={t("lsp.filter.show")}>
              {(["all", "missing", "installed"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={filter === key}
                  className={clsx("lsps-segment", filter === key && "is-on")}
                  onClick={() => setFilter(key)}
                >
                  {key === "all"
                    ? t("lsp.filter.all")
                    : key === "missing"
                      ? t("lsp.filter.missing.n", { count: missingCount })
                      : t("lsp.filter.installed")}
                </button>
              ))}
            </div>
            <ul className="lsps-list" aria-label={t("lsp.card.server")} onKeyDown={onListKey}>
              {group(t("lsp.group.available"), ready)}
              {group(t("lsp.group.missing"), missing)}
              {shown.length === 0 && probes !== null ? (
                <li className="lsps-list-empty">{t("lsp.search.empty")}</li>
              ) : null}
              {probes === null && !probeError ? <li className="lsps-list-empty">{t("lsp.list.loading")}</li> : null}
            </ul>
          </div>
          {selected ? (
            <Details
              key={selected.id}
              row={selected}
              probe={probes?.[selected.id]}
              note={notes[selected.id] ?? null}
              installing={installing === selected.id}
              uninstalling={uninstalling === selected.id}
              waking={waking !== null}
              sessionItems={sessions.byServer[selected.id] ?? []}
              stale={sessions.stale}
              reason={reasons[selected.id] ?? ""}
              hasWorkspace={!!workspace}
              onInstall={() => void runInstall(selected.id)}
              onUninstall={() => setPendingUninstall(selected.id)}
              onStart={() => start(selected)}
            />
          ) : (
            <EmptyState
              className="lsps-details-empty"
              title={probes === null ? t("lsp.list.loading") : t("lsp.search.empty")}
            />
          )}
        </div>
      </div>

      {pendingRemove ? (
        <div
          className="dialog-backdrop"
          onClick={() => setPendingRemove(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setPendingRemove(null);
          }}
        >
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("lsp.toolbar.remove")}
            onClick={(event) => event.stopPropagation()}
          >
            <p className="dialog-title">{t("lsp.toolbar.remove")}</p>
            <p className="dialog-body">{t("lsp.toolbar.remove.body", { name: pendingRemove })}</p>
            <div className="dialog-actions">
              <button type="button" className="button" onClick={() => setPendingRemove(null)}>
                {t("dialog.cancel")}
              </button>
              <button
                type="button"
                className="button is-primary"
                onClick={() => {
                  removeServer(pendingRemove);
                  setPendingRemove(null);
                }}
              >
                {t("lsp.remove.confirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingUninstall ? (
        <div
          className="dialog-backdrop is-wide"
          onClick={() => setPendingUninstall(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setPendingUninstall(null);
          }}
        >
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("lsp.uninstall.title")}
            onClick={(event) => event.stopPropagation()}
          >
            <p className="dialog-title">{t("lsp.uninstall.title")}</p>
            <p className="dialog-body">{t("lsp.uninstall.body", { server: pendingUninstall })}</p>
            <p className="lsp-install-command">
              {rows.find((row) => row.id === pendingUninstall)?.uninstallCommand}
            </p>
            <div className="dialog-actions">
              <button type="button" className="button" onClick={() => setPendingUninstall(null)}>
                {t("dialog.cancel")}
              </button>
              <button type="button" className="button is-primary" onClick={() => void runUninstall(pendingUninstall)}>
                <span>{t(uninstalling === pendingUninstall ? "lsp.uninstall.running" : "lsp.uninstall")}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {adding ? (
        <NewServerDialog
          existing={rows.map((row) => row.id)}
          onClose={() => setAdding(false)}
          onAdded={(name) => {
            setAdding(false);
            setFilter("all");
            setQuery("");
            setSelectedId(name);
          }}
        />
      ) : null}
    </div>
  );
}

export function LanguageSchemasPage() {
  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <p className="settings-hint">
          Forge 编辑器默认自动匹配常见配置文件模式（package.json、Cargo.toml、tsconfig.json 等），提供智能补全与语法检查。
        </p>
      </div>
    </div>
  );
}
