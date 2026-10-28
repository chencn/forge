import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { ReactNode } from "react";
import { Columns2, Save, X } from "lucide-react";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor, MenuItem } from "./ContextMenu";
import { useI18n } from "../i18n";
import { createEditorTabListId, editorTabDropTarget, editorTabList, registerEditorTabList, unregisterEditorTabList } from "../lib/editorSplit";
import AiSessionActivity from "./AiSessionActivity";
import type { TranslationKey } from "../i18n/lang/zh";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const SAVE_SHORTCUT = IS_MAC ? "⌘S" : "Ctrl+S";

/** 标签的种类：文档、比对、底部工具窗口、设置页、AI 会话。 */
export type TabKind = "doc" | "diff" | "pane" | "settings" | "ai";

/**
 * 编辑区页签栏上的一项。
 * 面板和设置也走这一条栏，所以这里只认描述，不认识具体是谁。
 */
export interface TabItem {
  /** 稳定键，前缀区分种类：doc| / diff| / pane| / settings。 */
  id: string;
  kind: TabKind;
  /** 标签上显示的名字。 */
  name: string;
  /** 悬停提示：完整路径、比对的两侧、面板的说明。 */
  title: string;
  /** 侧边栏里能定位到的绝对路径。比对在工作区没有对应文件时不给。 */
  filePath?: string;
  /** 有没保存的改动，画成小圆点。 */
  dirty: boolean;
  /** 种类图标；文档按文件名取，和资源管理器同一套。 */
  icon?: ReactNode;
}

interface EditorTabsProps {
  tabs: TabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** 关闭一颗标签；面板那类是最小化，具体落到上层按 kind 分派。 */
  onClose: (id: string, kind: TabKind) => void;
  onCloseOthers: (id: string) => void;
  onCloseAll: () => void;
  /** 拖到另一颗标签上：把 from 落到 to 前面。to 为空表示接到这一栏末尾。 */
  onReorder: (from: string, to: string | null) => void;
  /** 从另一栏放下。`beforeId` 为空表示接到这一栏末尾。没有分栏时不传。 */
  onImport?: (id: string, beforeId: string | null) => void;
  onSave: (path: string) => void;
  onSaveAll?: () => void;
  isDirty: (path: string) => boolean;
  /** 在侧边栏资源管理器里展开并选中这篇文件。 */
  onRevealInSidebar?: (path: string) => void;
  /** 向右拆分编辑器。 */
  onSplitRight?: (id: string) => void;
  /** 向下拆分编辑器。 */
  onSplitDown?: (id: string) => void;
  /** 关闭当前拆分栏。 */
  onCloseSplit?: () => void;
  /** 当前是否处于拆分视图。 */
  isSplit?: boolean;
  /** 打开文件的本地历史时间线。 */
  onShowLocalHistory?: (path: string) => void;
  /** 页签栏右侧自定义操作区（如当前激活 AI 会话的三个点菜单）。 */
  actions?: ReactNode;
  /** 页签右键菜单扩展项（如 AI 会话的复制 ID、发给进行中会话）。 */
  onContextMenuItems?: (tab: TabItem) => MenuItem[];
}

/**
 * 面板标签的关闭动作叫最小化，不叫关闭：任务还在后台跑。
 * AI 标签用「关闭」：关闭时会在有任务的情况下询问是否停止。
 */
const CLOSE_LABEL: Record<TabKind, TranslationKey> = {
  doc: "editor.closeTab",
  diff: "editor.closeTab",
  pane: "tool.minimize",
  settings: "editor.closeTab",
  ai: "editor.closeTab",
};

export default function EditorTabs({
  tabs,
  activeId,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
  onReorder,
  onImport,
  onSave,
  onSaveAll,
  isDirty,
  onRevealInSidebar,
  onSplitRight,
  onSplitDown,
  onCloseSplit,
  isSplit,
  onShowLocalHistory,
  actions,
  onContextMenuItems,
}: EditorTabsProps) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** WebView2 接管 HTML5 拖放后会画出禁止符号，所以排序和跨栏都走指针。 */
  const pointerDrag = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
    offsetX: number;
    offsetY: number;
    ghost: HTMLElement | null;
    drop: { listId: string; beforeId: string | null } | null;
  } | null>(null);
  const suppressClick = useRef(false);
  const listKey = useRef("");
  if (!listKey.current) listKey.current = createEditorTabListId();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Lithe `useTabWheelScroll`：条藏掉之后，竖着滚轮也改成左右挪标签。
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      if (event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey) return;
      const maxScrollLeft = container.scrollWidth - container.clientWidth;
      if (maxScrollLeft <= 0) return;
      const delta = event.deltaX || event.deltaY;
      const nextScrollLeft = Math.max(0, Math.min(container.scrollLeft + delta, maxScrollLeft));
      if (nextScrollLeft === container.scrollLeft) return;
      event.preventDefault();
      container.scrollLeft = nextScrollLeft;
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [tabs.length]);

  useEffect(() => {
    const id = listKey.current;
    return () => unregisterEditorTabList(id);
  }, []);

  useEffect(() => {
    const container = scrollRef.current;
    const activeTab = container?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!container || !activeTab) return;
    const tabRect = activeTab.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (tabRect.left < containerRect.left || tabRect.right > containerRect.right) {
      activeTab.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [activeId, tabs.length]);

  if (tabs.length === 0 && !onImport) {
    unregisterEditorTabList(listKey.current);
    return null;
  }
  registerEditorTabList(listKey.current, { ids: tabs.map((tab) => tab.id), onImport });

  const clearDropPaint = () => {
    if (typeof document === "undefined") return;
    document.querySelectorAll("[data-editor-tablist].is-importing").forEach((element) => {
      element.classList.remove("is-importing");
    });
  };
  const paintDrop = (drop: { listId: string; beforeId: string | null } | null) => {
    clearDropPaint();
    if (!drop?.beforeId && drop) document.querySelector(`[data-editor-tablist="${drop.listId}"]`)?.classList.add("is-importing");
  };
  /** 拖起来的标签跟着指针走。幽灵层不接指针，底下的落点仍能被点到。 */
  const moveGhost = (source: HTMLDivElement, x: number, y: number) => {
    const drag = pointerDrag.current;
    if (!drag || typeof document === "undefined") return;
    if (!drag.ghost) {
      const rect = source.getBoundingClientRect();
      const ghost = source.cloneNode(true) as HTMLElement;
      ghost.classList.add("is-drag-ghost");
      ghost.removeAttribute("data-editor-tab");
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      document.body.appendChild(ghost);
      source.classList.add("is-drag-source");
      document.body.classList.add("is-editor-tab-dragging");
      drag.ghost = ghost;
      drag.offsetX = x - rect.left;
      drag.offsetY = y - rect.top;
    }
    drag.ghost.style.left = `${x - drag.offsetX}px`;
    drag.ghost.style.top = `${y - drag.offsetY}px`;
  };
  const removeGhost = (source: HTMLElement | null) => {
    pointerDrag.current?.ghost?.remove();
    if (pointerDrag.current) pointerDrag.current.ghost = null;
    source?.classList.remove("is-drag-source");
    document.body?.classList.remove("is-editor-tab-dragging");
  };
  const dropAt = (x: number, y: number, fromId: string) => {
    if (typeof document === "undefined") return null;
    const hit = document.elementFromPoint(x, y);
    const listElement = hit?.closest<HTMLElement>("[data-editor-tablist]");
    const listId = listElement?.dataset.editorTablist;
    const list = listId ? editorTabList(listId) : null;
    if (!listId || !list) return null;
    const tabElement = hit?.closest<HTMLElement>("[data-editor-tab]");
    const tabId = tabElement?.dataset.editorTab ?? null;
    const after = !!tabElement && x > tabElement.getBoundingClientRect().left + tabElement.getBoundingClientRect().width / 2;
    const target = editorTabDropTarget(fromId, list.ids, !!list.onImport, tabId, after);
    return target ? { listId, beforeId: target.beforeId } : null;
  };
  const finishPointerDrag = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const drop = drag.drop;
    removeGhost(event.currentTarget);
    pointerDrag.current = null;
    clearDropPaint();
    if (drag.active) {
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
    }
    if (!commit || !drag.active || !drop) return;
    const list = editorTabList(drop.listId);
    if (!list) return;
    if (list.ids.includes(drag.id)) onReorder(drag.id, drop.beforeId);
    else list.onImport?.(drag.id, drop.beforeId);
  };

  const docTabs = tabs.filter((tab) => tab.kind === "doc");
  const activeDocTab = docTabs.find((tab) => tab.id === activeId) ?? null;
  const dirtyDocTabs = docTabs.filter((tab) => tab.dirty);
  const canSave = dirtyDocTabs.length > 0;

  /** 点击页签栏右侧保存按钮：当前标签是脏文档则存当前这篇，否则存所有未保存文档。 */
  const handleSaveButton = () => {
    if (activeDocTab && activeDocTab.dirty) {
      onSave(activeDocTab.id.slice(4));
      return;
    }
    if (onSaveAll) {
      onSaveAll();
      return;
    }
    for (const tab of dirtyDocTabs) {
      onSave(tab.id.slice(4));
    }
  };

  const openMenu = (event: ReactMouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const menuFor = (tab: TabItem): MenuItem[] => {
    const custom = onContextMenuItems ? onContextMenuItems(tab) : [];
    const path = tab.kind === "doc" ? tab.id.slice(4) : tab.title;
    const items: MenuItem[] = [];
    if (tab.kind === "doc") {
      // 保存平时是 Ctrl+S，但菜单里没有它的话，记不住键位的人就只能去猜。
      items.push({
        label: t("editor.save"),
        disabled: !isDirty(path),
        onSelect: () => onSave(path),
      });
    }
    items.push({ label: t(CLOSE_LABEL[tab.kind]), onSelect: () => onClose(tab.id, tab.kind) });
    items.push({
      label: t("menu.closeOthers"),
      disabled: tabs.length < 2,
      onSelect: () => onCloseOthers(tab.id),
    });
    items.push({ label: t("menu.closeAll"), onSelect: onCloseAll });
    if (tab.kind === "doc" || tab.kind === "diff") {
      items.push({ label: t("menu.copyPath"), onSelect: () => void navigator.clipboard.writeText(path) });
    }
    if (tab.filePath && onRevealInSidebar) {
      const target = tab.filePath;
      items.push({
        label: t("menu.locateInSidebar"),
        onSelect: () => onRevealInSidebar(target),
      });
    }
    // 拆分属于标签容器能力，所有标签类型共用同一个入口。
    if (onSplitRight) {
      items.push({
        label: t("menu.splitRight"),
        onSelect: () => onSplitRight(tab.id),
      });
    }
    if (onSplitDown) {
      items.push({
        label: t("menu.splitDown"),
        onSelect: () => onSplitDown(tab.id),
      });
    }
    if (isSplit && onCloseSplit) {
      items.push({
        label: t("menu.unsplit"),
        onSelect: () => onCloseSplit(),
      });
    }
    if (tab.kind === "doc" && onShowLocalHistory) {
      items.push({
        label: t("menu.localHistory"),
        onSelect: () => onShowLocalHistory(path),
      });
    }
    // 标签特定的扩展操作（如 AI 会话的复制 ID、发给进行中会话）排在标签基础操作之后，不占用菜单首位
    if (custom.length > 0) {
      items.push(...custom);
    }
    return items;
  };

  return (
    <>
      <div
        className="editor-tabs"
        role="tablist"
        data-editor-tablist={listKey.current}
      >
        <div className="editor-tabs-scroll" ref={scrollRef}>
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              className={`editor-tab is-${tab.kind}${active ? " is-active" : ""}${
                tab.dirty ? " is-dirty" : ""
              }`}
              title={tab.title}
              data-editor-tab={tab.id}
              onClick={() => {
                if (suppressClick.current) return;
                onSelect(tab.id);
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
                pointerDrag.current = {
                  id: tab.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
                  active: false, offsetX: 0, offsetY: 0, ghost: null, drop: null,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = pointerDrag.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
                drag.active = true;
                event.preventDefault();
                moveGhost(event.currentTarget, event.clientX, event.clientY);
                drag.drop = dropAt(event.clientX, event.clientY, drag.id);
                paintDrop(drag.drop);
              }}
              onPointerUp={(event) => finishPointerDrag(event, true)}
              onPointerCancel={(event) => finishPointerDrag(event, false)}
              onContextMenu={(event) => openMenu(event, menuFor(tab))}
              onAuxClick={(event) => {
                if (event.button === 1) onClose(tab.id, tab.kind);
              }}
            >
              {tab.icon}
              <span className="tab-label">{tab.name}</span>
              {tab.kind === "ai" && tab.id !== "ai|draft" ? <AiSessionActivity sessionId={tab.id.slice(3)} /> : null}
              {tab.dirty ? <span className="tab-dot" title={t("editor.dirty")} /> : null}
              <button
                type="button"
                className={`tab-close${active ? " is-visible" : ""}`}
                aria-label={t(CLOSE_LABEL[tab.kind])}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id, tab.kind);
                }}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
        </div>
        {docTabs.length > 0 || (isSplit && onCloseSplit) || actions ? (
          <div className="editor-tabs-actions">
            {docTabs.length > 0 ? (
              <button
                type="button"
                className="icon-button is-inline"
                disabled={!canSave}
                onClick={handleSaveButton}
                title={`${t("editor.save")} (${SAVE_SHORTCUT})`}
                aria-label={t("editor.save")}
              >
                <Save size={15} aria-hidden="true" />
              </button>
            ) : null}
            {isSplit && onCloseSplit ? (
              <button
                type="button"
                className="icon-button is-inline"
                onClick={onCloseSplit}
                title={t("menu.unsplitTip")}
                aria-label={t("menu.unsplitTip")}
              >
                <Columns2 size={15} aria-hidden="true" />
              </button>
            ) : null}
            {actions}
          </div>
        ) : null}
      </div>
      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </>
  );
}
