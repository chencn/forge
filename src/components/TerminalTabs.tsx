import { Fragment, useEffect, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Bell,
  Bot,
  ChevronDown,
  Columns2,
  Copy,
  Download,
  Eraser,
  PanelBottom,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Rows2,
  Search,
  SquareSplitHorizontal,
  X,
} from "lucide-react";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor, MenuItem } from "./ContextMenu";
import { useAiInputMenu } from "./AiInputContext";
import { shellProbe } from "../lib/term";
import type { ShellInfo } from "../lib/term";
import {
  closeOtherTerms,
  closeTerm,
  closeTermsToRight,
  closeUnpinnedTerms,
  duplicateTerm,
  moveTerm,
  openTerm,
  renameTerm,
  setActiveTermFor,
  splitTerm,
  termGroupOf,
  termSessionFor,
  termSessionsFor,
  toggleTermPin,
  unsplitTerm,
  watchTermTabs,
} from "../lib/termStore";
import type { SplitDirection, TermSession } from "../lib/termStore";
import { requestTermFind, termControl } from "../lib/termSurface";
import { isTabWorthyTitle } from "../lib/termTitle";
import { profileSpec } from "../lib/termProfiles";
import { writeFile } from "../lib/fs";
import { useSettings } from "../hooks/useSettings";
import { useI18n } from "../i18n";

/**
 * 终端页签。横排时住在工具窗口标题行里，竖排时是终端左侧一列；两处用同一个 `TermTabList`。
 *
 * 单独一个文件、不跟 `TerminalPane` 放一起：`TerminalPane` 是懒加载的（拖着 xterm），
 * 而标题行首屏就要画，不能被 xterm 拖下水。
 */

/** 拖拽时塞进 dataTransfer 的类型，别的拖放目标据此认出这不是文件。 */
const DRAG_TYPE = "application/x-forge-term";

/** 工具窗口停在底部还是在编辑区页签里，以及换过去的那个动作。 */
export interface TermPlacement {
  docked: boolean;
  toggle: () => void;
}

let shellList: Promise<ShellInfo[]> | null = null;

/** 标题行和竖排列表各要一份，探测只跑一次。 */
function probeShells(): Promise<ShellInfo[]> {
  shellList ??= shellProbe().catch(() => {
    shellList = null;
    return [];
  });
  return shellList;
}

function useShells(): ShellInfo[] {
  const [shells, setShells] = useState<ShellInfo[]>([]);
  useEffect(() => {
    let alive = true;
    void probeShells().then((list) => {
      if (alive) setShells(list);
    });
    return () => {
      alive = false;
    };
  }, []);
  return shells;
}

function useTermTabs(cwd: string | null) {
  const [store, setStore] = useState(() => termSessionsFor(cwd));
  useEffect(() => {
    setStore(termSessionsFor(cwd));
    return watchTermTabs(() => setStore(termSessionsFor(cwd)));
  }, [cwd]);
  return store;
}

function shellName(session: TermSession, shells: ShellInfo[]): string {
  const id = session.shell || shells[0]?.id || "";
  const known = shells.find((shell) => shell.id === id || shell.path === id);
  if (known) return known.name;
  const tail = id.split(/[\\/]/).pop() ?? id;
  return tail.replace(/\.exe$/i, "") || "terminal";
}

/**
 * 一条会话的页签名：用户起过名就用名字；程序报的标题够短够干净就用标题；
 * 再其次是配置档名；否则用探测列表里那条 shell 的名字，列表里没有就取路径去后缀的尾段。
 */
function tabLabel(session: TermSession, shells: ShellInfo[], profileName: (id: string) => string | null): string {
  if (session.name) return session.name;
  if (isTabWorthyTitle(session.title)) return session.title;
  const profile = session.profile ? profileName(session.profile) : null;
  return profile ?? shellName(session, shells);
}

/** 文件名里不能出现的字符换成下划线。 */
function fileSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/gu, "_").replace(/^_+|_+$/gu, "") || "terminal";
}

interface DropHint {
  id: string;
  after: boolean;
}

interface TermTabListProps {
  cwd: string | null;
  orientation: "horizontal" | "vertical";
  placement?: TermPlacement;
}

export function TermTabList({ cwd, orientation, placement }: TermTabListProps) {
  const { settings } = useSettings();
  const { t } = useI18n();
  const store = useTermTabs(cwd);
  const shells = useShells();
  const aiInputMenu = useAiInputMenu();
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string; original: string } | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const dragging = useRef<TermSession | null>(null);
  /** Esc 取消后输入框卸载还会补一次 blur，那次不能当成确认。 */
  const cancelled = useRef(false);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const vertical = orientation === "vertical";
  const profileName = (id: string) => settings.terminal.profiles.find((item) => item.id === id)?.name ?? null;
  const label = (session: TermSession) => tabLabel(session, shells, profileName);

  useEffect(() => {
    if (!store.activeId) return;
    tabRefs.current.get(store.activeId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [store.activeId, store.sessions.length]);

  useEffect(() => {
    if (editing && !store.sessions.some((session) => session.id === editing.id)) setEditing(null);
  }, [editing, store.sessions]);

  const activate = (id: string) => setActiveTermFor(cwd, id);

  const focusTerminal = (id: string) => {
    requestAnimationFrame(() => termControl(id)?.focus());
  };

  const startRename = (session: TermSession) => {
    activate(session.id);
    const current = label(session);
    cancelled.current = false;
    setEditing({ id: session.id, value: current, original: current });
  };

  const commitRename = () => {
    if (!editing || cancelled.current) return;
    if (editing.value.trim() !== editing.original) renameTerm(editing.id, editing.value);
    const id = editing.id;
    setEditing(null);
    focusTerminal(id);
  };

  const exportOutput = async (session: TermSession) => {
    const text = termControl(session.id)?.text() ?? "";
    const date = new Date().toISOString().slice(0, 10);
    const path = await save({
      defaultPath: `${fileSafe(label(session))}-${date}.txt`,
      filters: [
        { name: t("terminal.textFiles"), extensions: ["txt", "log"] },
        { name: t("terminal.allFiles"), extensions: ["*"] },
      ],
    }).catch(() => null);
    if (!path) return;
    await writeFile(path, `${text}\n`, "lf", false).catch(() => {});
  };

  const split = (session: TermSession, direction: SplitDirection) => {
    void splitTerm(session.id, direction, 80, 24).catch(() => {});
  };

  const menuFor = (session: TermSession, x: number, y: number) => {
    const index = store.sessions.findIndex((item) => item.id === session.id);
    const hasOthers = store.sessions.some((item) => item.id !== session.id && !item.pinned);
    const hasRight = store.sessions.slice(index + 1).some((item) => !item.pinned);
    const grouped = termGroupOf(session.id).members.length > 1;
    // 终端 → AI 会话桥：最近输出的尾巴交出去，路由（直接投/选会话/没开 AI）由桥统一处理。
    const recent = termControl(session.id)?.text() ?? "";
    const output = recent.length > 4000 ? recent.slice(-4000) : recent;
    const sendToAi = aiInputMenu({
      kind: "text",
      text: output.trim(),
      source: t("terminal.sendToAiSource", { name: label(session) }),
    });
    const items: MenuItem[] = [
      {
        label: session.pinned ? t("terminal.unpin") : t("terminal.pin"),
        icon: session.pinned ? PinOff : Pin,
        onSelect: () => toggleTermPin(session.id),
      },
      { separator: true },
      { label: t("terminal.splitRight"), icon: Columns2, shortcut: "Ctrl+Shift+5", onSelect: () => split(session, "row") },
      { label: t("terminal.splitDown"), icon: Rows2, shortcut: "Ctrl+Shift+-", onSelect: () => split(session, "column") },
      ...(grouped
        ? [{ label: t("terminal.unsplit"), icon: SquareSplitHorizontal, onSelect: () => unsplitTerm(session.id) }]
        : []),
      {
        label: t("terminal.duplicate"),
        icon: Copy,
        onSelect: () => void duplicateTerm(session.id, 80, 24).catch(() => {}),
      },
      { separator: true },
      { label: t("terminal.clear"), icon: Eraser, onSelect: () => termControl(session.id)?.clear() },
      { label: t("terminal.rename"), icon: Pencil, shortcut: "F2", onSelect: () => startRename(session) },
      { label: t("terminal.export"), icon: Download, onSelect: () => void exportOutput(session) },
      { ...sendToAi, icon: Bot },
      ...(placement
        ? [
            {
              label: placement.docked ? t("terminal.moveToEditor") : t("terminal.moveToBottom"),
              icon: PanelBottom,
              onSelect: () => {
                activate(session.id);
                placement.toggle();
              },
            },
          ]
        : []),
      { separator: true },
      { label: t("terminal.closeTab"), icon: X, onSelect: () => void closeTerm(session.id) },
      {
        label: t("terminal.closeOthers"),
        disabled: !hasOthers,
        onSelect: () => void closeOtherTerms(session.id),
      },
      {
        label: t("terminal.closeRight"),
        disabled: !hasRight,
        onSelect: () => void closeTermsToRight(session.id),
      },
      { label: t("terminal.closeAll"), onSelect: () => void closeUnpinnedTerms(cwd) },
    ];
    setAnchor({ x, y, items });
  };

  const onTabKey = (event: ReactKeyboardEvent<HTMLDivElement>, session: TermSession) => {
    if (editing?.id === session.id) return;
    const index = store.sessions.findIndex((item) => item.id === session.id);
    const forward = vertical ? "ArrowDown" : "ArrowRight";
    const back = vertical ? "ArrowUp" : "ArrowLeft";
    const step = event.key === forward ? 1 : event.key === back ? -1 : 0;
    if (step !== 0 || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const count = store.sessions.length;
      const nextIndex =
        event.key === "Home" ? 0 : event.key === "End" ? count - 1 : (index + step + count) % count;
      const next = store.sessions[nextIndex];
      if (!next) return;
      activate(next.id);
      tabRefs.current.get(next.id)?.focus();
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      startRename(session);
    } else if ((event.key === "Delete" || event.key === "Backspace") && !session.pinned) {
      event.preventDefault();
      void closeTerm(session.id);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(session.id);
      focusTerminal(session.id);
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      menuFor(session, rect.left + 8, rect.bottom + 4);
    }
  };

  const onAuxClick = (event: ReactMouseEvent, session: TermSession) => {
    if (event.button !== 1) return;
    event.preventDefault();
    if (!session.pinned) void closeTerm(session.id);
  };

  const onDragStart = (event: DragEvent<HTMLDivElement>, session: TermSession) => {
    dragging.current = session;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_TYPE, session.id);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>, session: TermSession) => {
    const moving = dragging.current;
    if (!moving || moving.pinned !== session.pinned) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (moving.id === session.id) {
      setDropHint(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const after = vertical
      ? event.clientY > rect.top + rect.height / 2
      : event.clientX > rect.left + rect.width / 2;
    setDropHint((hint) => (hint?.id === session.id && hint.after === after ? hint : { id: session.id, after }));
  };

  /** 拖出页签栏、落在编辑区上：整个终端窗口挪进编辑区页签，被拖的那条成为激活的。 */
  const onDragEnd = (event: DragEvent<HTMLDivElement>) => {
    const moving = dragging.current;
    dragging.current = null;
    setDropHint(null);
    if (!moving || !placement?.docked || event.dataTransfer.dropEffect !== "none") return;
    const landed = document.elementFromPoint(event.clientX, event.clientY);
    if (landed?.closest(".editor-region")) {
      activate(moving.id);
      placement.toggle();
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>, session: TermSession) => {
    const moving = dragging.current;
    event.preventDefault();
    if (moving && dropHint?.id === session.id) moveTerm(moving.id, session.id, dropHint.after);
    dragging.current = null;
    setDropHint(null);
  };

  const tooltip = (session: TermSession, name: string) => {
    const lines = [name];
    if (session.title && session.title !== name) lines.push(session.title);
    const dir = session.currentDir ?? session.dir ?? session.cwd;
    if (dir) lines.push(dir);
    if (session.exited) {
      lines.push(
        session.exitCode === null
          ? t("terminal.exited")
          : t("terminal.exitedWithCode", { code: session.exitCode }),
      );
    } else if (session.bell) {
      lines.push(t("terminal.bellRang"));
    } else if (session.unread) {
      lines.push(t("terminal.newOutput"));
    }
    return lines.join("\n");
  };

  const renderTab = (session: TermSession) => {
    const active = session.id === store.activeId;
    const name = label(session);
    const renaming = editing?.id === session.id;
    const hint = dropHint?.id === session.id ? (dropHint.after ? " drop-after" : " drop-before") : "";
    return (
      <div
        key={session.id}
        ref={(element) => {
          if (element) tabRefs.current.set(session.id, element);
          else tabRefs.current.delete(session.id);
        }}
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        className={`term-tab${active ? " is-active" : ""}${session.exited ? " is-exited" : ""}${
          session.pinned ? " is-pinned" : ""
        }${hint}`}
        title={renaming ? undefined : tooltip(session, name)}
        draggable={!renaming}
        onClick={() => {
          if (!renaming) activate(session.id);
        }}
        onDoubleClick={() => startRename(session)}
        onAuxClick={(event) => onAuxClick(event, session)}
        onMouseDown={(event) => {
          // 中键按下默认会进自动滚动模式。
          if (event.button === 1) event.preventDefault();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          menuFor(session, event.clientX, event.clientY);
        }}
        onKeyDown={(event) => onTabKey(event, session)}
        onDragStart={(event) => onDragStart(event, session)}
        onDragOver={(event) => onDragOver(event, session)}
        onDragLeave={() => setDropHint((current) => (current?.id === session.id ? null : current))}
        onDrop={(event) => onDrop(event, session)}
        onDragEnd={onDragEnd}
      >
        {session.exited ? (
          <span className="term-tab-dot is-failed" aria-hidden="true" />
        ) : session.bell ? (
          <Bell className="term-tab-bell" size={11} aria-hidden="true" />
        ) : session.unread ? (
          <span className="term-tab-dot is-unread" aria-hidden="true" />
        ) : null}
        {renaming ? (
          <input
            className="term-tab-rename"
            value={editing.value}
            autoFocus
            spellCheck={false}
            placeholder={shellName(session, shells)}
            aria-label={t("terminal.rename")}
            size={Math.max(4, editing.value.length + 1)}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              const value = event.target.value;
              setEditing((current) => (current ? { ...current, value } : current));
            }}
            onBlur={commitRename}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelled.current = true;
                setEditing(null);
                focusTerminal(session.id);
              }
            }}
          />
        ) : (
          <span className="term-tab-label">{name}</span>
        )}
        {renaming ? null : session.pinned ? (
          <button
            type="button"
            className="term-tab-close is-pin"
            tabIndex={-1}
            title={t("terminal.unpin")}
            onClick={(event) => {
              event.stopPropagation();
              toggleTermPin(session.id);
            }}
          >
            <Pin size={11} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="term-tab-close"
            tabIndex={-1}
            title={t("terminal.closeTab")}
            onClick={(event) => {
              event.stopPropagation();
              void closeTerm(session.id);
            }}
          >
            <X size={11} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  };

  // 同组（分屏）的页签包在一起画，一眼看得出哪几条是一屏的。
  const runs: TermSession[][] = [];
  for (const session of store.sessions) {
    const last = runs[runs.length - 1];
    if (last && last[0].group === session.group) last.push(session);
    else runs.push([session]);
  }

  return (
    <>
      <div
        className={`term-tabs-scroll${vertical ? " is-vertical" : ""}`}
        role="tablist"
        aria-orientation={orientation}
        aria-label={t("panel.terminal")}
        onWheel={(event) => {
          if (!vertical && event.deltaX === 0 && event.deltaY !== 0) {
            event.currentTarget.scrollLeft += event.deltaY;
          }
        }}
      >
        {runs.map((run) =>
          run.length > 1 ? (
            <div key={run[0].id} className="term-tab-group" role="group">
              {run.map(renderTab)}
            </div>
          ) : (
            <Fragment key={run[0].id}>{renderTab(run[0])}</Fragment>
          ),
        )}
      </div>
      {anchor ? <ContextMenu anchor={anchor} onClose={() => setAnchor(null)} /> : null}
    </>
  );
}

/** 页签栏右边那几颗：新建、选 shell / 配置档、拆分、查找。 */
export function TermTabActions({ cwd }: { cwd: string | null }) {
  const { settings } = useSettings();
  const { t } = useI18n();
  const shells = useShells();
  const store = useTermTabs(cwd);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const defaultShell = settings.terminal.shell || shells[0]?.id || "";

  const newTab = (shell: string) => {
    void openTerm(cwd, shell, 80, 24).catch(() => {});
  };

  const openShellMenu = () => {
    const rect = moreRef.current?.getBoundingClientRect();
    if (!rect) return;
    const profiles = settings.terminal.profiles;
    const items: MenuItem[] = shells.map((shell) => ({ label: shell.name, onSelect: () => newTab(shell.id) }));
    if (profiles.length > 0) {
      items.push({ separator: true });
      for (const profile of profiles) {
        items.push({
          label: profile.name,
          onSelect: () => {
            const { shell, ...extra } = profileSpec(profile, cwd, defaultShell);
            void openTerm(cwd, shell, 80, 24, extra).catch(() => {});
          },
        });
      }
    }
    setAnchor({ x: rect.left, y: rect.bottom, items });
  };

  const splitActive = () => {
    const active = termSessionFor(cwd);
    if (active) void splitTerm(active.id, "row", 80, 24).catch(() => {});
  };

  return (
    <>
      <button
        type="button"
        className="term-tab-new"
        title={t("terminal.newTab")}
        onClick={() => newTab(defaultShell)}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
      <button
        ref={moreRef}
        type="button"
        className="term-tab-more"
        disabled={shells.length === 0 && settings.terminal.profiles.length === 0}
        title={t("terminal.chooseShell")}
        onClick={openShellMenu}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="term-tab-more"
        disabled={store.sessions.length === 0}
        title={`${t("terminal.splitRight")} (Ctrl+Shift+5)`}
        onClick={splitActive}
      >
        <Columns2 size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="term-tab-more"
        disabled={store.sessions.length === 0}
        title={`${t("terminal.find")} (Ctrl+F)`}
        onClick={requestTermFind}
      >
        <Search size={13} aria-hidden="true" />
      </button>
      {anchor ? <ContextMenu anchor={anchor} onClose={() => setAnchor(null)} /> : null}
    </>
  );
}

/** 工具窗口标题行里那一段：横排时页签加按钮，竖排时页签挪到终端左侧，这里只剩按钮。 */
export default function TerminalTabs({ cwd, placement }: { cwd: string | null; placement?: TermPlacement }) {
  const { settings } = useSettings();
  const vertical = settings.terminal.tabLayout === "vertical";
  return (
    <div className="term-tabs">
      {vertical ? <span className="status-spacer" /> : (
        <TermTabList cwd={cwd} orientation="horizontal" placement={placement} />
      )}
      <TermTabActions cwd={cwd} />
    </div>
  );
}
