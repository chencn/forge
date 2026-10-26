import { Fragment, forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type React from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { Plus, RotateCw, TerminalSquare } from "lucide-react";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor } from "./ContextMenu";
import { useAiInputMenu } from "./AiInputContext";
import { errorText, openExternal } from "../lib/fs";
import { describeError } from "../lib/errors";
import {
  closeTerm,
  needTermSession,
  openTerm,
  restartTerm,
  setActiveTermFor,
  setTermProfileResolver,
  termGroupOf,
  termSessionFor,
  unsplitTerm,
  watchTermTabs,
} from "../lib/termStore";
import type { SplitDirection, TermSession } from "../lib/termStore";
import { registerTermSlot, termControl, watchTermFindRequests } from "../lib/termSurface";
import { isHttpUrl } from "../lib/termUrl";
import { profileSpec } from "../lib/termProfiles";
import { TermTabList } from "./TerminalTabs";
import TermFindBar from "./TermFindBar";
import type { TermPlacement } from "./TerminalTabs";
import { useSettings } from "../hooks/useSettings";
import { useI18n } from "../i18n";

interface TerminalPaneProps {
  /** 新会话的起始目录；换工作区时重开一个 shell。 */
  cwd: string | null;
  /** 深浅色由宿主里的 xterm 自己换，这里留着是为了和原来的面板接口一致。 */
  dark: boolean;
  /** 停在底部还是编辑区；竖排页签的右键菜单和拖拽要用。 */
  placement?: TermPlacement;
}

/** 竖排页签那一列的宽度，拖过之后这一轮运行里都记着。 */
let sideWidth = 180;
const SIDE_RANGE = { min: 120, max: 420 };
/** 分屏里每一格的最小像素，再小就看不清了。 */
const PANE_MIN = 80;

/** 工具窗口头部那两颗按钮要能命令终端：作用于当前激活的那条会话。 */
export interface TerminalPaneHandle {
  clear: () => void;
  restart: () => void;
}

interface ActiveView {
  id: string;
  exited: boolean;
  exitCode: number | null;
  /** 同组（分屏）全部会话，按页签顺序。 */
  members: string[];
  direction: SplitDirection;
}

/** 激活会话里会让画面变的那几样；会话对象原地改，得拆成值才比得出变化。 */
function snapshot(session: TermSession | null): ActiveView | null {
  if (!session) return null;
  const group = termGroupOf(session.id);
  return {
    id: session.id,
    exited: session.exited,
    exitCode: session.exitCode,
    members: group.members.map((item) => item.id),
    direction: group.direction,
  };
}

function sameView(a: ActiveView | null, b: ActiveView | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.id === b.id &&
    a.exited === b.exited &&
    a.exitCode === b.exitCode &&
    a.direction === b.direction &&
    a.members.join("|") === b.members.join("|")
  );
}

export default forwardRef<TerminalPaneHandle, TerminalPaneProps>(function TerminalPane(
  { cwd, placement },
  ref,
) {
  const { settings } = useSettings();
  const vertical = settings.terminal.tabLayout === "vertical";
  const [side, setSide] = useState(sideWidth);
  /** 分屏各格的 flex 比例，按会话 id 记。 */
  const [weights, setWeights] = useState<Record<string, number>>({});
  const panesRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const aiInputMenu = useAiInputMenu();
  const shellRef = useRef(settings.terminal.shell);
  shellRef.current = settings.terminal.shell;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const translateRef = useRef(t);
  translateRef.current = t;
  const [active, setActive] = useState(() => snapshot(termSessionFor(cwd)));
  const activeId = active?.id ?? null;
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  /** 面板挂上后第一条 shell 还在起，这时不画空状态，免得闪一下。 */
  const [starting, setStarting] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findSeed, setFindSeed] = useState("");
  const emptyRef = useRef<HTMLButtonElement>(null);

  useEffect(
    () =>
      watchTermTabs(() => {
        const next = snapshot(termSessionFor(cwd));
        setActive((current) => (sameView(current, next) ? current : next));
      }),
    [cwd],
  );

  // 恢复页签、重开会话时按配置档的最新内容起，不用存盘时那一份。
  const { profiles, shell: defaultShell } = settings.terminal;
  useEffect(() => {
    setTermProfileResolver((id) => {
      const profile = profiles.find((item) => item.id === id);
      if (!profile) return null;
      const { command: _command, dir: _dir, ...rest } = profileSpec(profile, cwd, defaultShell);
      return rest;
    });
  }, [profiles, cwd, defaultShell]);

  useEffect(() => {
    let cancelled = false;
    setFault(null);
    setStarting(true);
    void needTermSession(cwd, shellRef.current, 80, 24)
      .catch((cause: unknown) => {
        if (cancelled) return;
        setFault(describeError(errorText(cause), translateRef.current));
      })
      .finally(() => {
        if (!cancelled) setStarting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // 最后一条刚关掉时焦点落在已经拆掉的终端上，挪到「新建」上，回车就能再开一条。
  const hadSession = useRef(activeId !== null);
  useEffect(() => {
    if (!activeId && hadSession.current) emptyRef.current?.focus({ preventScroll: true });
    hadSession.current = activeId !== null;
  }, [activeId]);

  const openFind = () => {
    const selection = activeId ? (termControl(activeId)?.selection() ?? "") : "";
    setFindSeed(selection && !selection.includes("\n") ? selection : "");
    setFindOpen(true);
  };
  const openFindRef = useRef(openFind);
  openFindRef.current = openFind;
  useEffect(() => watchTermFindRequests(() => openFindRef.current()), []);

  const newTerminal = () => {
    setFault(null);
    void openTerm(cwdRef.current, shellRef.current, 80, 24).catch((cause: unknown) => {
      setFault(describeError(errorText(cause), translateRef.current));
    });
  };

  const restart = () => {
    const id = termSessionFor(cwdRef.current)?.id;
    if (!id) return;
    void restartTerm(id).catch((cause: unknown) => {
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

  const requestMenu = (event: ReactMouseEvent, sessionId: string) => {
    event.preventDefault();
    if (sessionId !== activeId) setActiveTermFor(cwdRef.current, sessionId);
    const control = termControl(sessionId);
    const grouped = (active?.members.length ?? 0) > 1;
    const rawSelection = control?.selection() ?? "";
    const selection = rawSelection.trim();
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
        aiInputMenu({ kind: "text", text: rawSelection, source: t("panel.terminal") }),
        {
          label: t("action.paste"),
          onSelect: () => {
            void navigator.clipboard
              .readText()
              .then((text) => {
                if (text) termControl(sessionId)?.paste(text);
              })
              .catch(() => {});
          },
        },
        { label: t("terminal.clear"), onSelect: () => control?.clear() },
        { label: t("terminal.find"), shortcut: "Ctrl+F", onSelect: openFind },
        { separator: true },
        ...(grouped ? [{ label: t("terminal.unsplit"), onSelect: () => unsplitTerm(sessionId) }] : []),
        { label: t("terminal.restart"), onSelect: () => void restartTerm(sessionId).catch(() => {}) },
        { label: t("terminal.closeTab"), onSelect: () => void closeTerm(sessionId) },
      ],
    });
  };

  /** 分屏格子之间那条分隔条：拖动只改相邻两格的比例，别的格子不动。 */
  const startPaneResize = (event: React.PointerEvent<HTMLDivElement>, before: string, after: string) => {
    const container = panesRef.current;
    const left = container?.querySelector<HTMLElement>(`[data-pane="${before}"]`);
    const right = container?.querySelector<HTMLElement>(`[data-pane="${after}"]`);
    if (!container || !left || !right || !active) return;
    event.preventDefault();
    const row = active.direction === "row";
    const start = row ? event.clientX : event.clientY;
    const sizeA = row ? left.offsetWidth : left.offsetHeight;
    const sizeB = row ? right.offsetWidth : right.offsetHeight;
    const growA = weights[before] ?? 1;
    const growB = weights[after] ?? 1;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const delta = (row ? moveEvent.clientX : moveEvent.clientY) - start;
      const nextA = Math.min(sizeA + sizeB - PANE_MIN, Math.max(PANE_MIN, sizeA + delta));
      const share = nextA / (sizeA + sizeB);
      setWeights((current) => ({
        ...current,
        [before]: (growA + growB) * share,
        [after]: (growA + growB) * (1 - share),
      }));
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };

  const startSideResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const start = event.clientX;
    const from = side;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const next = Math.min(SIDE_RANGE.max, Math.max(SIDE_RANGE.min, from + moveEvent.clientX - start));
      sideWidth = next;
      setSide(next);
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      openFind();
    }
  };

  return (
    <>
      <div className="term-live" onKeyDownCapture={onKeyDown}>
        {findOpen && activeId ? (
          <TermFindBar
            key={findSeed /* 每次从选区带出关键字时换一个，浮层重新起一份 */}
            control={termControl(activeId)}
            initialQuery={findSeed}
            onClose={() => setFindOpen(false)}
          />
        ) : null}
        {fault ? <p className="term-fault">{fault}</p> : null}
        <div className="term-body">
          {vertical ? (
            <>
              <aside className="term-side" style={{ width: side }}>
                <TermTabList cwd={cwd} orientation="vertical" placement={placement} />
              </aside>
              <div
                className="term-side-resizer"
                role="separator"
                aria-orientation="vertical"
                onPointerDown={startSideResize}
              />
            </>
          ) : null}
          {active ? (
            <div ref={panesRef} className={`term-panes is-${active.direction}`}>
              {active.members.map((id, index) => (
                <Fragment key={id}>
                  {index > 0 ? (
                    <div
                      className="term-pane-resizer"
                      role="separator"
                      aria-orientation={active.direction === "row" ? "vertical" : "horizontal"}
                      onPointerDown={(event) => startPaneResize(event, active.members[index - 1], id)}
                    />
                  ) : null}
                  <div
                    data-pane={id}
                    className={`term-pane${
                      active.members.length > 1 && id === active.id ? " is-focused" : ""
                    }`}
                    style={{ flex: `${weights[id] ?? 1} 1 0` }}
                  >
                    <div className="term-host" onContextMenu={(event) => requestMenu(event, id)}>
                      <div className="term-sticky">
                        <TerminalSlot sessionId={id} />
                      </div>
                      <div className="term-spacer" aria-hidden="true" />
                    </div>
                  </div>
                </Fragment>
              ))}
            </div>
          ) : starting ? null : (
          <div className="term-empty">
            <TerminalSquare size={28} strokeWidth={1.4} aria-hidden="true" />
            <p>{t("terminal.empty")}</p>
            <button ref={emptyRef} type="button" className="term-empty-action" onClick={newTerminal}>
              <Plus size={14} aria-hidden="true" />
              {t("terminal.newTab")}
            </button>
          </div>
          )}
        </div>
        {active?.exited ? (
          <div className="term-exit-bar" role="status">
            <span className="term-exit-text">
              {active.exitCode === null
                ? t("terminal.exited")
                : t("terminal.exitedWithCode", { code: active.exitCode })}
            </span>
            <span className="status-spacer" />
            <button type="button" className="term-exit-action" onClick={restart}>
              <RotateCw size={12} aria-hidden="true" />
              {t("terminal.restart")}
              <kbd>Enter</kbd>
            </button>
            <button
              type="button"
              className="term-exit-action"
              onClick={() => void closeTerm(active.id)}
            >
              {t("terminal.closeTab")}
            </button>
          </div>
        ) : null}
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
