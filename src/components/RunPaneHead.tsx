import { useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { MoreVertical, Square, X } from "lucide-react";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor } from "./ContextMenu";
import { RerunIcon, ScrollToEndIcon } from "./RunIcons";
import { RunConfigIcon } from "../lib/runIcons";
import type { RunController } from "../hooks/useRunSessions";
import { useI18n } from "../i18n";

/**
 * 运行面板头部的两行，照 IDEA 的 Run 工具窗口：
 * 第一行是「标题 + 会话页签」，第二行是一排动作图标。标题行由 App 的 paneFrame 画，
 * 页签（`RunSessionTabs`）与动作条（`RunPaneToolbar`）拆出来各自渲染。
 */

/** 第一行右侧的会话页签：一条会话一个标签，点切换、点 × 关。 */
export function RunSessionTabs({ run }: { run: RunController }) {
  const { t } = useI18n();
  if (run.sessions.length === 0) return null;
  return (
    <div className="run-sessions" role="tablist" aria-label={t("run.sessions")}>
      {run.sessions.map((session) => (
        <div
          key={session.id}
          className={`run-session${session.id === run.activeId ? " is-active" : ""}`}
        >
          <button
            type="button"
            role="tab"
            aria-selected={session.id === run.activeId}
            className="run-session-tab"
            title={`${session.name}\n${session.command}`}
            onClick={() => run.setActiveId(session.id)}
          >
            <RunConfigIcon config={session.config} root={session.root} />
            <span className={`run-dot is-${session.status}`} aria-hidden="true" />
            <span className="run-session-name">{session.name}</span>
          </button>
          <button
            type="button"
            className="run-session-close"
            title={t("run.closeSession")}
            onClick={() => run.closeSession(session.id)}
          >
            <X size={11} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** 第二行的动作条：重跑、停止、清空、更多。动作针对当前选中的那条会话。 */
export function RunPaneToolbar({ run }: { run: RunController }) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const active = run.activeSession;
  const activeRunning = active?.status === "running";

  const requestMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    const id = run.activeId;
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          label: t("run.rerun"),
          // 重开当前这条会话：就地重启，不新开一个标签。
          disabled: !id,
          onSelect: () => id && run.restartSession(id),
        },
        { label: t("run.stop"), disabled: !activeRunning, onSelect: () => run.stop(id) },
        { separator: true },
        {
          label: t("run.clearAll"),
          disabled: run.sessions.length === 0,
          onSelect: run.clearAll,
        },
        {
          label: t("run.closeSession"),
          disabled: !id,
          onSelect: () => id && run.closeSession(id),
        },
      ],
    });
  };

  return (
    <div className="run-pane-toolbar">
      <button
        type="button"
        className="icon-button is-inline is-rerun"
        disabled={!run.activeId}
        title={active ? t("run.rerunNamed", { name: active.name }) : t("run.rerun")}
        onClick={() => run.activeId && run.restartSession(run.activeId)}
      >
        <RerunIcon size={14} />
      </button>
      <button
        type="button"
        className="icon-button is-inline is-stop"
        disabled={!activeRunning}
        title={active ? t("run.stopNamed", { name: active.name }) : t("run.stop")}
        onClick={() => run.stop(run.activeId)}
      >
        <Square size={12} />
      </button>
      <span className="run-toolbar-sep" aria-hidden="true" />
      <button
        type="button"
        className="icon-button is-inline"
        disabled={!run.activeId}
        title={t("run.scrollToEnd")}
        onClick={() => window.dispatchEvent(new Event("forge:run-scroll-end"))}
      >
        <ScrollToEndIcon size={14} />
      </button>
      <button
        type="button"
        className="icon-button is-inline"
        title={t("run.moreActions")}
        onClick={requestMenu}
      >
        <MoreVertical size={14} />
      </button>
      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
