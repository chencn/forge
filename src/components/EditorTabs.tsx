import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ReactNode } from "react";
import { Columns2, Save, X } from "lucide-react";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor, MenuItem } from "./ContextMenu";
import { useI18n } from "../i18n";
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
  /** 拖到另一颗标签上：把 from 落到 to 现在的位子。 */
  onReorder: (from: string, to: string) => void;
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
}: EditorTabsProps) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** 正在拖的那颗标签；dragover 落到别的标签上就换序。 */
  const dragId = useRef<string | null>(null);
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
    const container = scrollRef.current;
    const activeTab = container?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!container || !activeTab) return;
    const tabRect = activeTab.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (tabRect.left < containerRect.left || tabRect.right > containerRect.right) {
      activeTab.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [activeId, tabs.length]);

  if (tabs.length === 0) return null;

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
    return items;
  };

  return (
    <>
      <div className="editor-tabs" role="tablist">
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
              draggable
              onClick={() => onSelect(tab.id)}
              onDragStart={(event) => {
                dragId.current = tab.id;
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                const from = dragId.current;
                if (!from || from === tab.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                onReorder(from, tab.id);
              }}
              onDrop={(event) => event.preventDefault()}
              onDragEnd={() => {
                dragId.current = null;
              }}
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
