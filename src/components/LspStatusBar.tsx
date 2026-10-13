import { useRef, useState } from "react";
import { Braces } from "lucide-react";
import Popover from "./Popover";
import CopyButton from "./CopyButton";
import { lspRetry } from "../lib/lsp";
import type { LspSessionStatus } from "../lib/lsp";
import { useLspConfig, useLspSessionStatuses } from "../hooks/useLspConfig";
import { serverEntries } from "../lib/lspConfig";
import { languageNames } from "../lib/monacoEnv";
import { pathWithin } from "../lib/format";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/lang/zh";

const STATE_LABEL: Record<LspSessionStatus["status"], TranslationKey> = {
  running: "lsp.state.running",
  dead: "lsp.state.dead",
  exited: "lsp.state.exited",
};

/** 会话状态点：跑着绿，出问题红，读不到灰。 */
const STATE_CLASS: Record<LspSessionStatus["status"], string> = {
  running: "is-ready",
  dead: "is-missing",
  exited: "is-missing",
};

interface Props {
  /** 当前工程根；没开工程时这一段不画，语言服务都按工程根起。 */
  workspace: string | null;
  /** 动过进程之后要再对一趟文档与配置。 */
  onKicked: () => void;
  /** 打开设置页那一栏。 */
  onOpenSettings: () => void;
  /** 报一条错给右下角的气泡；文案由前端按错误码拼，所以收的是后端那条原样串。 */
  onError: (text: string) => void;
}

/**
 * 底部状态条上的语言服务那一格。
 *
 * 说的是进程存活，不是索引就绪：rust-analyzer 从起进程到能查语义中间还有一段，
 * 这一格看不出来，也不假装看得出来。会话状态取自 `useLspConfig`，与设置页那栏是同一份轮询。
 */
export default function LspStatusBar({ workspace, onKicked, onOpenSettings, onError }: Props) {
  const { t } = useI18n();
  const { config, patchServer } = useLspConfig();
  const sessions = useLspSessionStatuses();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef(0);

  // 与旁边内存那格同一套：指针从这一格挪进浮层要穿过 4px 间隙，穿过的一瞬间会算「离开」，
  // 所以收起延后一拍，别让浮层闪掉。浮层在 DOM 上是这一格的子孙，停在浮层里不算离开。
  const show = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 150);
  };

  // 没有任何一项处在外部 LSP 档时不占状态条的一格。
  const wanted = serverEntries(config).some((entry) => entry.mode === "lsp");
  if (!workspace || !wanted) return null;

  const items = Object.values(sessions.byServer)
    .flat()
    .filter((item) => pathWithin(workspace, item.root));
  // 会话身份用的是服务键，人认的是语言：弹层一行给语言名，后面跟真正在跑的那个程序名。
  const entriesById = new Map(serverEntries(config).map((entry) => [entry.id, entry]));
  const runningCount = items.filter((item) => item.status === "running").length;
  const problemCount = items.length - runningCount;
  const title = sessions.stale
    ? t("lsp.bar.stale")
    : items.length === 0
      ? t("lsp.bar.empty")
      : problemCount > 0
        ? t("lsp.bar.problems", { count: problemCount })
        : t("lsp.bar.running", { count: runningCount });

  /** 重启一条会话：清掉后端的退避记录，剩下的交给下一次对档去起进程。 */
  const retry = (id: string) => {
    lspRetry(id)
      .then(() => onKicked())
      .catch((error: unknown) => onError(typeof error === "string" ? error : String(error)));
  };
  /** 该动作命名为「停用」而不是「停止」：直接将档位设为 off。仅停止进程而配置未变时，下一次对档会重新启动它。 */
  const disable = (server: string) => {
    patchServer(server, { mode: "off" });
    onKicked();
  };

  return (
    <span className="status-lsp" ref={anchor} onMouseEnter={show} onMouseLeave={hide}>
      <button
        type="button"
        className={`status-lsp-button${problemCount > 0 || sessions.stale ? " is-missing" : runningCount > 0 ? " is-ready" : ""}`}
        aria-label={title}
        aria-expanded={open}
        onClick={show}
      >
        <Braces size={12} aria-hidden="true" />
        {runningCount > 0 ? <span className="status-lsp-count">{runningCount}</span> : null}
      </button>
      {open ? (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)} maxWidth={350} modal={false}>
          <div className="popover-head">
            <span className="popover-label">{t("lsp.bar.title")}</span>
          </div>
          <p className="popover-note">{t("lsp.bar.note")}</p>
          {sessions.stale ? <p className="popover-note">{t("lsp.bar.stale")}</p> : null}
          {items.length === 0 && !sessions.stale ? (
            <p className="popover-note">{t("lsp.bar.empty")}</p>
          ) : null}
          {items.map((item) => {
            const entry = entriesById.get(item.server);
            return (
              <div key={item.id} className="popover-item lsp-bar-item">
                <div className="lsp-bar-line">
                  <span className={`lsp-status ${STATE_CLASS[item.status]}`} aria-hidden="true" />
                  <span className="popover-item-label">
                    {entry ? languageNames(entry.languages) : item.server}
                  </span>
                  <span className="lsp-bar-state">{t(STATE_LABEL[item.status])}</span>
                  <button type="button" className="lsp-action" onClick={() => retry(item.id)}>
                    {t("lsp.bar.retry")}
                  </button>
                  <button
                    type="button"
                    className="lsp-action"
                    onClick={() => {
                      disable(item.server);
                      setOpen(false);
                    }}
                  >
                    {t("lsp.bar.disable")}
                  </button>
                </div>
                {item.error ? (
                  <span className="lsp-bar-error">
                    {item.error}
                    <CopyButton text={item.error} />
                  </span>
                ) : null}
              </div>
            );
          })}
          <div className="popover-sep" />
          <button
            type="button"
            className="lsp-action"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            {t("lsp.bar.settings")}
          </button>
        </Popover>
      ) : null}
    </span>
  );
}
