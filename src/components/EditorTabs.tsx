import { useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ReactNode } from "react";
import { Save, X } from "lucide-react";
import ContextMenu from "./ContextMenu";
import type { MenuAnchor, MenuItem } from "./ContextMenu";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/lang/zh";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const SAVE_SHORTCUT = IS_MAC ? "⌘S" : "Ctrl+S";

/** 标签的种类：文档、比对、底部工具窗口、设置页。 */
export type TabKind = "doc" | "diff" | "pane" | "settings";

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
}

/** 面板标签的关闭动作叫最小化，不叫关闭：任务还在后台跑。 */
const CLOSE_LABEL: Record<TabKind, TranslationKey> = {
  doc: "editor.closeTab",
  diff: "editor.closeTab",
  pane: "tool.minimize",
  settings: "editor.closeTab",
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
}: EditorTabsProps) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** 正在拖的那颗标签；dragover 落到别的标签上就换序。 */
  const dragId = useRef<string | null>(null);
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
    return items;
  };

  return (
    <>
      <div className="editor-tabs" role="tablist">
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
              <button
                type="button"
                className="tab-close"
                aria-label={t(CLOSE_LABEL[tab.kind])}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id, tab.kind);
                }}
              >
                {tab.dirty ? <span className="tab-dot" /> : <X size={13} />}
              </button>
            </div>
          );
        })}
        {docTabs.length > 0 ? (
          <div className="editor-tabs-actions">
            <button
              type="button"
              className={`editor-save-button${canSave ? " is-dirty" : ""}`}
              disabled={!canSave}
              onClick={handleSaveButton}
              title={`${t("editor.save")} (${SAVE_SHORTCUT})`}
              aria-label={t("editor.save")}
            >
              <Save size={13} aria-hidden="true" />
              <span>{t("editor.save")}</span>
            </button>
          </div>
        ) : null}
      </div>
      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </>
  );
}
