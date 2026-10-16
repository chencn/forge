import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor } from "./ContextMenu";
import { errorText, openExternal } from "../lib/fs";
import { describeError } from "../lib/errors";
import { needTermSession, restartTermSession, termSessionFor, watchTermTabs } from "../lib/termStore";
import { registerTermSlot, termControl } from "../lib/termSurface";
import { isHttpUrl } from "../lib/termUrl";
import { useSettings } from "../hooks/useSettings";
import { useI18n } from "../i18n";

interface TerminalPaneProps {
  /** 新会话的起始目录；换工作区时重开一个 shell。 */
  cwd: string | null;
  /** 深浅色由宿主里的 xterm 自己换，这里留着是为了和原来的面板接口一致。 */
  dark: boolean;
}

/** 工具窗口头部那两颗按钮要能命令终端：作用于当前激活的那条会话。 */
export interface TerminalPaneHandle {
  clear: () => void;
  restart: () => void;
}

export default forwardRef<TerminalPaneHandle, TerminalPaneProps>(function TerminalPane(
  { cwd },
  ref,
) {
  const { settings } = useSettings();
  const { t } = useI18n();
  const shellRef = useRef(settings.terminal.shell);
  shellRef.current = settings.terminal.shell;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const translateRef = useRef(t);
  translateRef.current = t;
  const [activeId, setActiveId] = useState<string | null>(() => termSessionFor(cwd)?.id ?? null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const findRef = useRef<HTMLInputElement>(null);

  useEffect(() => watchTermTabs(() => setActiveId(termSessionFor(cwd)?.id ?? null)), [cwd]);

  useEffect(() => {
    let cancelled = false;
    setFault(null);
    void needTermSession(cwd, shellRef.current, 80, 24).catch((cause: unknown) => {
      if (cancelled) return;
      setFault(describeError(errorText(cause), translateRef.current));
    });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  useEffect(() => {
    if (findOpen) findRef.current?.focus();
  }, [findOpen]);

  const restart = () => {
    const id = termSessionFor(cwdRef.current)?.id;
    if (!id) return;
    void restartTermSession(id, cwdRef.current, shellRef.current, 80, 24).catch((cause: unknown) => {
      setFault(describeError(errorText(cause), translateRef.current));
    });
  };

  useImperativeHandle(
    ref,
    () => ({
      clear: () => {
        const id = termSessionFor(cwdRef.current)?.id;
        if (id) termControl(id)?.clear();
      },
      restart,
    }),
    [],
  );

  const requestMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    const control = activeId ? termControl(activeId) : null;
    const selection = control?.selection().trim() ?? "";
    const selectedUrl = isHttpUrl(selection) ? selection : null;

    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        ...(selectedUrl
          ? [
              {
                label: t("terminal.openLink"),
                onSelect: () => void openExternal(selectedUrl).catch(() => {}),
              },
              {
                label: t("terminal.copyLink"),
                onSelect: () => void navigator.clipboard.writeText(selectedUrl).catch(() => {}),
              },
              { separator: true },
            ]
          : []),
        {
          label: t("action.copy"),
          disabled: !(control?.hasSelection() ?? false),
          onSelect: () => {
            const text = control?.selection();
            if (text) void navigator.clipboard.writeText(text);
          },
        },
        {
          label: t("action.paste"),
          onSelect: () => {
            void navigator.clipboard
              .readText()
              .then((text) => {
                if (text && activeId) termControl(activeId)?.paste(text);
              })
              .catch(() => {});
          },
        },
        { label: t("terminal.clear"), onSelect: () => control?.clear() },
        { label: t("terminal.find"), onSelect: () => setFindOpen(true) },
        { label: t("terminal.restart"), onSelect: restart },
      ],
    });
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      setFindOpen(true);
    }
  };

  const search = (forward: boolean) => {
    if (!activeId || !query) return;
    const control = termControl(activeId);
    if (forward) control?.findNext(query);
    else control?.findPrevious(query);
  };

  return (
    <>
      <div className="term-live" onKeyDownCapture={onKeyDown}>
        {findOpen ? (
          <div className="term-search">
            <input
              ref={findRef}
              className="settings-input"
              value={query}
              placeholder={t("terminal.find")}
              aria-label={t("terminal.find")}
              onChange={(event) => {
                const next = event.target.value;
                setQuery(next);
                if (activeId && next) termControl(activeId)?.findNext(next);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  search(!event.shiftKey);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setFindOpen(false);
                }
              }}
            />
          </div>
        ) : null}
        {fault ? <p className="term-fault">{fault}</p> : null}
        <div className="term-host" onContextMenu={requestMenu}>
          <div className="term-sticky">
            {activeId ? <TerminalSlot sessionId={activeId} /> : null}
          </div>
          <div className="term-spacer" aria-hidden="true" />
        </div>
      </div>
      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </>
  );
});

function TerminalSlot({ sessionId }: { sessionId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return registerTermSlot(sessionId, element);
  }, [sessionId]);
  return <div ref={ref} className="term-slot" />;
}
