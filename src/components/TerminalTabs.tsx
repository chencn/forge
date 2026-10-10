import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor } from "./ContextMenu";
import { shellProbe } from "../lib/term";
import type { ShellInfo } from "../lib/term";
import {
  closeTerm,
  openTerm,
  setActiveTerm,
  termSessions,
  watchTermTabs,
} from "../lib/termStore";
import type { TermSession } from "../lib/termStore";
import { useSettings } from "../hooks/useSettings";
import { useI18n } from "../i18n";

/**
 * 终端标题行里的页签栏，照 IDEA：一页签一条会话（带关闭），后面跟 `+` 新建与 `⌄` 选 shell。
 *
 * 单独一个文件、不跟 `TerminalPane` 放一起：`TerminalPane` 是懒加载的（拖着 xterm），
 * 而页签栏住在头部那一行、首屏就要画，不能被 xterm 拖下水。
 */

/** 一条会话的页签名：优先用 shell 的可读名，退回落盘路径的尾段。 */
function shellLabel(shell: string): string {
  const tail = shell.split(/[\\/]/).pop() ?? shell;
  return tail.replace(/\.exe$/i, "") || shell;
}

export default function TerminalTabs({ cwd }: { cwd: string | null }) {
  const { settings } = useSettings();
  const { t } = useI18n();
  const [store, setStore] = useState<{ sessions: TermSession[]; activeId: string | null }>({
    sessions: [],
    activeId: null,
  });
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setStore(termSessions());
    return watchTermTabs(() => setStore(termSessions()));
  }, []);

  useEffect(() => {
    void shellProbe()
      .then((list) => setShells(list))
      .catch(() => setShells([]));
  }, []);

  const newTab = (shell: string) => {
    void openTerm(cwd, shell, 80, 24).catch(() => {});
  };

  const openShellMenu = () => {
    const rect = moreRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({
      x: rect.left,
      y: rect.bottom,
      items: shells.map((shell) => ({ label: shell.name, onSelect: () => newTab(shell.path) })),
    });
  };

  return (
    <>
      <div className="term-tabs" role="tablist" aria-label={t("panel.terminal")}>
        {store.sessions.map((session) => (
          <div
            key={session.id}
            className={`term-tab${session.id === store.activeId ? " is-active" : ""}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={session.id === store.activeId}
              className="term-tab-label"
              onClick={() => setActiveTerm(session.id)}
            >
              {shellLabel(session.shell)}
            </button>
            <button
              type="button"
              className="term-tab-close"
              title={t("terminal.closeTab")}
              onClick={() => void closeTerm(session.id)}
            >
              <X size={11} aria-hidden="true" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="term-tab-new"
          title={t("terminal.newTab")}
          onClick={() => newTab(settings.terminal.shell || shells[0]?.path || "")}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
        <button
          ref={moreRef}
          type="button"
          className="term-tab-more"
          disabled={shells.length === 0}
          title={t("terminal.chooseShell")}
          onClick={openShellMenu}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
      {anchor ? <ContextMenu anchor={anchor} onClose={() => setAnchor(null)} /> : null}
    </>
  );
}
