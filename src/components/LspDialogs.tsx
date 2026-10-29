import { useEffect, useRef, useState } from "react";
import Select from "./Select";
import { modesFor } from "../lib/lspConfig";
import type { LspMode, LspServerEntry } from "../lib/lspConfig";
import type { LspServerProbe } from "../lib/lsp";
import { languageNames } from "../lib/editorEnv";
import { useI18n } from "../i18n";
import { Copy, Download, X } from "lucide-react";

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

/** 超时给的范围：低于 5 秒基本没 server 能起完，高于 10 分钟是没在等。 */
const TIMEOUT_MIN = 5_000;
const TIMEOUT_MAX = 600_000;

interface ServerDialogProps {
  /** 要改的那一项。弹窗只在打开时存在，所以初值直接取它。 */
  server: LspServerEntry;
  /** 探测结果，只为把「本机这个装在哪」显示出来。 */
  probe?: LspServerProbe;
  /** 保存：把改过的字段交回上层整份写盘。 */
  onSave: (next: Partial<LspServerEntry>) => void;
  onCancel: () => void;
}

/**
 * 一个语言服务的编辑弹窗。
 *
 * 列表上不显示这些字段：命令名、路径、参数、标志文件、安装命令、握手超时、initializationOptions
 * 全部在此修改。参数是一行文本（含空格的片段用双引号包住，拆分在后端），列表类字段以逗号分隔。
 */
export function LspServerDialog({
  server,
  probe,
  onSave,
  onCancel,
}: ServerDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [mode, setMode] = useState<LspMode>(server.mode);
  const [program, setProgram] = useState(server.program);
  const [path, setPath] = useState(server.path);
  const [args, setArgs] = useState(server.args);
  const [languages, setLanguages] = useState(joinList(server.languages));
  const [markers, setMarkers] = useState(joinList(server.rootMarkers));
  const [install, setInstall] = useState(server.installCommand);
  const [timeout, setTimeout] = useState(String(server.startupTimeoutMs));
  const [init, setInit] = useState(
    server.initOptions === null || server.initOptions === undefined
      ? ""
      : JSON.stringify(server.initOptions, null, 2)
  );
  const [error, setError] = useState("");
  const programRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    programRef.current?.focus();
  }, []);

  const submit = () => {
    const trimmedProgram = program.trim();
    if (!trimmedProgram) {
      setError(t("lsp.error.program"));
      return;
    }
    const langs = splitList(languages);
    if (langs.length === 0) {
      setError(t("lsp.error.languages"));
      return;
    }
    // initializationOptions 只收对象：null 表示不传，写成数组或标量 server 侧读不懂。
    let options: unknown = null;
    const trimmedInit = init.trim();
    if (trimmedInit) {
      try {
        const parsed: unknown = JSON.parse(trimmedInit);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          setError(t("lsp.error.initObject"));
          return;
        }
        options = parsed;
      } catch {
        setError(t("lsp.error.initJson"));
        return;
      }
    }
    const ms = Number(timeout);
    onSave({
      mode,
      program: trimmedProgram,
      path: path.trim(),
      args: args.trim(),
      languages: langs,
      rootMarkers: splitList(markers),
      installCommand: install.trim(),
      startupTimeoutMs: Number.isFinite(ms)
        ? Math.min(Math.max(Math.round(ms), TIMEOUT_MIN), TIMEOUT_MAX)
        : server.startupTimeoutMs,
      initOptions: options,
    });
  };

  return (
    <div
      className="dialog-backdrop is-wide"
      onClick={onCancel}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <div
        className="dialog lsp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("lsp.dialog.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="dialog-title">{t("lsp.dialog.title")}</p>
        <p className="dialog-note" title={server.id}>
          {`${languageNames(server.languages)} · ${server.program}`}
        </p>
        {probe?.installed && probe.path ? (
          <p className="dialog-note">{t("lsp.found.at", { path: probe.path })}</p>
        ) : null}

        <div className="lsp-dialog-row">
          <label className="dialog-field lsp-dialog-mode">
            <span>{t("lsp.dialog.mode")}</span>
            <Select
              label={t("lsp.dialog.mode")}
              placeholder="—"
              value={mode}
              options={modesFor(server).map((item) => ({
                value: item,
                label: t(
                  item === "off"
                    ? "lsp.mode.off"
                    : item === "builtin"
                      ? "lsp.mode.builtin"
                      : "lsp.mode.lsp"
                ),
              }))}
              onChange={setMode}
            />
          </label>
          <label className="dialog-field">
            <span>{t("lsp.dialog.program")}</span>
            <input
              ref={programRef}
              className="text-input"
              type="text"
              spellCheck={false}
              value={program}
              placeholder="rust-analyzer"
              onChange={(event) => setProgram(event.target.value)}
            />
            <span className="lsp-dialog-hint">{t("lsp.dialog.program.hint")}</span>
          </label>
        </div>

        <label className="dialog-field">
          <span>{t("lsp.path")}</span>
          <input
            className="text-input"
            type="text"
            spellCheck={false}
            value={path}
            placeholder={t("lsp.path.placeholder")}
            onChange={(event) => setPath(event.target.value)}
          />
        </label>

        <label className="dialog-field">
          <span>{t("lsp.args")}</span>
          <input
            className="text-input"
            type="text"
            spellCheck={false}
            value={args}
            placeholder="--stdio"
            onChange={(event) => setArgs(event.target.value)}
          />
        </label>

        <label className="dialog-field">
          <span>{t("lsp.dialog.languages")}</span>
          <input
            className="text-input"
            type="text"
            spellCheck={false}
            value={languages}
            placeholder="typescript, javascript"
            onChange={(event) => setLanguages(event.target.value)}
          />
          <span className="lsp-dialog-hint">{t("lsp.dialog.languages.hint")}</span>
        </label>

        <label className="dialog-field">
          <span>{t("lsp.dialog.markers")}</span>
          <input
            className="text-input"
            type="text"
            spellCheck={false}
            value={markers}
            placeholder="Cargo.toml, *.csproj"
            onChange={(event) => setMarkers(event.target.value)}
          />
          <span className="lsp-dialog-hint">{t("lsp.dialog.markers.hint")}</span>
        </label>

        <label className="dialog-field">
          <span>{t("lsp.dialog.install")}</span>
          <input
            className="text-input"
            type="text"
            spellCheck={false}
            value={install}
            placeholder="npm install -g ..."
            onChange={(event) => setInstall(event.target.value)}
          />
        </label>

        <label className="dialog-field">
          <span>{t("lsp.dialog.timeout")}</span>
          <input
            className="text-input"
            type="number"
            min={TIMEOUT_MIN}
            max={TIMEOUT_MAX}
            step={1000}
            value={timeout}
            onChange={(event) => setTimeout(event.target.value)}
          />
        </label>

        <label className="dialog-field">
          <span>{t("lsp.dialog.init")}</span>
          <textarea
            className="text-input lsp-dialog-json"
            rows={4}
            spellCheck={false}
            value={init}
            placeholder="{ }"
            onChange={(event) => setInit(event.target.value)}
          />
        </label>

        {error ? <p className="lsp-dialog-error">{error}</p> : null}

        <div className="dialog-actions">
          <button type="button" className="button" onClick={onCancel}>
            <X size={14} />
            <span>{t("dialog.cancel")}</span>
          </button>
          <button type="button" className="button is-primary" onClick={submit}>
            {t("lsp.dialog.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

interface InstallDialogProps {
  /** 要装的 server 键。 */
  server: string;
  /** 配置中的安装命令，原样显示在此处——只在用户确实要执行时才展示。 */
  command: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 安装前的确认。
 *
 * 确认之后弹窗即关闭，进度回到卡片的安装按钮上，因此这里不等待执行结果。
 */
export function LspInstallDialog({
  server,
  command,
  onConfirm,
  onCancel,
}: InstallDialogProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div
      className="dialog-backdrop is-wide"
      onClick={onCancel}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("lsp.install.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="dialog-title">{t("lsp.install.title")}</p>
        <p className="dialog-body">{t("lsp.install.body", { server })}</p>
        <p className="lsp-install-command" title={command}>
          {command}
        </p>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onCancel}>
            {t("dialog.cancel")}
          </button>
          <button type="button" className="button is-primary" onClick={onConfirm}>
            <Download size={14} />
            <span>{t("lsp.install")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

interface LogDialogProps {
  /** 「语言 · 服务名」，标题行用它。 */
  label: string;
  /** 最近的语言服务输出，最新一行在末尾。 */
  lines: string[];
  onClear: () => void;
  onClose: () => void;
}

/**
 * 语言服务的输出日志。
 *
 * 内容是这个进程写到标准错误的那些行（启动失败、索引报错都在里面），全文留着不截断，
 * 一屏看不完就滚；「复制全部」把整段一次取走，方便贴进终端或 issue 对比。
 */
export function LspLogDialog({
  label,
  lines,
  onClear,
  onClose,
}: LogDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const body = useRef<HTMLPreElement>(null);
  // 打开就停在最新那行：报错总是在末尾。
  useEffect(() => {
    const node = body.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines.length]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    navigator.clipboard
      .writeText(lines.join("\n"))
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
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
        aria-label={t("lsp.log.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="dialog-title">{t("lsp.log.title")}</p>
        <p className="dialog-note">
          {label} · {t("lsp.log.lines", { count: lines.length })}
        </p>
        <p className="dialog-note">{t("lsp.log.note")}</p>
        {lines.length === 0 ? (
          <p className="lsp-log is-empty">{t("lsp.log.empty")}</p>
        ) : (
          <pre ref={body} className="lsp-log">
            {lines.join("\n")}
          </pre>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("error.dismiss")}
          </button>
          <button type="button" className="button" onClick={onClear} disabled={lines.length === 0}>
            <span>{t("lsp.log.clear")}</span>
          </button>
          <button
            type="button"
            className="button is-primary"
            onClick={copy}
            disabled={lines.length === 0}
          >
            <Copy size={14} />
            <span>{t(copied ? "lsp.log.copied" : "lsp.log.copy")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
