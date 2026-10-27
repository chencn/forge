import { useState } from "react";
import { Archive, EllipsisVertical, Pencil, Plus, Settings, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import type { AiSession, AiSessionAction } from "../lib/aiSessions";
import { loadNativePurgeDefault, saveNativePurgeDefault } from "../lib/aiSessions";
import ContextMenu, { flatMenu } from "./ContextMenu";
import type { MenuAnchor, MenuItem } from "./ContextMenu";
import AiActionDialog from "./AiActionDialog";

export interface AiSessionTabMenuProps {
  session: AiSession;
  onAction?: (action: AiSessionAction) => void;
  onNew?: () => void;
  onSettings?: () => void;
}

/**
 * 标签栏右侧 AI 会话操作菜单（⋮）。
 *
 * 对应将原本会话面板顶部的三点菜单提升到标签栏最右侧操作区，
 * 包含新建会话、重命名、归档、管理 CLI 和删除。
 */
export default function AiSessionTabMenu({
  session,
  onAction,
  onNew,
  onSettings,
}: AiSessionTabMenuProps) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [pending, setPending] = useState<{ action: "rename"; session: AiSession } | { action: "delete"; session: AiSession; purgeNative: boolean } | null>(null);

  const openTabMenu = (x: number, y: number) => {
    const archivedNow = session.archived === true;
    const items: MenuItem[][] = [
      onNew ? [{ icon: Plus, label: t("ai.newSession"), onSelect: onNew }] : [],
      [
        ...(onAction ? [{ icon: Pencil, label: t("menu.rename"), onSelect: () => setPending({ action: "rename", session }) }] : []),
        ...(onAction
          ? [
              archivedNow
                ? { icon: Archive, label: t("ai.archived.restore"), onSelect: () => onAction({ type: "archive", id: session.id, archived: false }) }
                : { icon: Archive, label: t("ai.archived.button"), onSelect: () => onAction({ type: "archive", id: session.id, archived: true }) },
            ]
          : []),
        ...(onSettings ? [{ icon: Settings, label: t("ai.manageCli"), onSelect: onSettings }] : []),
      ],
      onAction ? [{ icon: Trash2, label: t("menu.delete"), danger: true, onSelect: () => setPending({ action: "delete", session, purgeNative: loadNativePurgeDefault(session.provider) }) }] : [],
    ];
    setMenu({ x, y, items: flatMenu(items) });
  };

  return (
    <>
      <button
        type="button"
        className="icon-button is-inline ai-session-tab-menu-btn"
        title={t("ai.sidebar.moreOptions")}
        aria-label={t("ai.sidebar.moreOptions")}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          openTabMenu(rect.left, rect.bottom + 4);
        }}
      >
        <EllipsisVertical size={15} aria-hidden />
      </button>

      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}

      {pending ? (
        <AiActionDialog
          title={t(pending.action === "rename" ? "menu.rename" : "ai.deleteSession")}
          confirm={t(pending.action === "rename" ? "dialog.confirm" : "menu.delete")}
          initialValue={pending.action === "rename" ? pending.session.title : undefined}
          danger={pending.action === "delete"}
          nativePurge={pending.action === "delete" ? {
            checked: pending.purgeNative,
            onChange: (value) => { saveNativePurgeDefault(pending.session.provider, value); setPending({ ...pending, purgeNative: value }); },
            label: t("ai.deletePurgeNative"),
          } : undefined}
          onCancel={() => setPending(null)}
          onConfirm={(title) => {
            if (onAction) {
              onAction(
                pending.action === "rename"
                  ? { type: "rename", id: pending.session.id, title }
                  : { type: "delete", id: pending.session.id, purgeNative: pending.purgeNative }
              );
            }
            setPending(null);
          }}
        >
          {pending.action === "delete" ? (
            <p className="ai-action-tip">
              {t(pending.purgeNative ? "ai.deleteConfirmPurge" : "ai.deleteConfirm", { name: pending.session.title || t("ai.untitledSession") })}
            </p>
          ) : null}
        </AiActionDialog>
      ) : null}
    </>
  );
}
