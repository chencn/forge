import { useState } from "react";
import { Archive, Copy, EllipsisVertical, Pencil, Pin, PinOff, Plus, Settings, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";
import type { AiSession, AiSessionAction } from "../lib/aiSessions";
import Popover from "./Popover";
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
 * 包含新建会话、重命名、复制会话 ID、置顶、归档、管理 CLI 和删除。
 */
export default function AiSessionTabMenu({
  session,
  onAction,
  onNew,
  onSettings,
}: AiSessionTabMenuProps) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [pending, setPending] = useState<{ action: "rename" | "delete"; session: AiSession } | null>(null);

  return (
    <>
      <button
        type="button"
        className="icon-button is-inline ai-session-tab-menu-btn"
        title={t("ai.sidebar.moreOptions")}
        aria-label={t("ai.sidebar.moreOptions")}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(event) => setAnchor(event.currentTarget)}
      >
        <EllipsisVertical size={15} aria-hidden />
      </button>

      {anchor ? (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} minWidth={200}>
          <div className="ai-add-menu" role="menu">
            {onNew ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAnchor(null);
                  onNew();
                }}
              >
                <Plus size={14} aria-hidden />
                {t("ai.newSession")}
              </button>
            ) : null}
            {onAction ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAnchor(null);
                  setPending({ action: "rename", session });
                }}
              >
                <Pencil size={14} aria-hidden />
                {t("menu.rename")}
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setAnchor(null);
                void navigator.clipboard.writeText(session.id);
              }}
            >
              <Copy size={14} aria-hidden />
              {t("ai.copySessionId")}
            </button>
            {onAction ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAnchor(null);
                  onAction({ type: "pin", id: session.id, pinned: session.pinned !== true });
                }}
              >
                {session.pinned === true ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />}
                {session.pinned === true ? t("ai.sidebar.unpin") : t("ai.sidebar.pin")}
              </button>
            ) : null}
            {onAction ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAnchor(null);
                  onAction({ type: "archive", id: session.id, archived: session.archived !== true });
                }}
              >
                <Archive size={14} aria-hidden />
                {session.archived === true ? t("ai.archived.restore") : t("ai.archived.button")}
              </button>
            ) : null}
            {onSettings ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAnchor(null);
                  onSettings();
                }}
              >
                <Settings size={14} aria-hidden />
                {t("ai.manageCli")}
              </button>
            ) : null}
            {onAction ? (
              <button
                type="button"
                role="menuitem"
                className="is-danger"
                onClick={() => {
                  setAnchor(null);
                  setPending({ action: "delete", session });
                }}
              >
                <Trash2 size={14} aria-hidden />
                {t("menu.delete")}
              </button>
            ) : null}
          </div>
        </Popover>
      ) : null}

      {pending ? (
        <AiActionDialog
          title={t(pending.action === "rename" ? "menu.rename" : "ai.deleteSession")}
          confirm={t(pending.action === "rename" ? "dialog.confirm" : "menu.delete")}
          initialValue={pending.action === "rename" ? pending.session.title : undefined}
          danger={pending.action === "delete"}
          onCancel={() => setPending(null)}
          onConfirm={(title) => {
            if (onAction) {
              onAction(
                pending.action === "rename"
                  ? { type: "rename", id: pending.session.id, title }
                  : { type: "delete", id: pending.session.id }
              );
            }
            setPending(null);
          }}
        >
          {pending.action === "delete" ? (
            <p className="dialog-body">
              {t("ai.deleteConfirm", { name: pending.session.title || t("ai.untitledSession") })}
            </p>
          ) : null}
        </AiActionDialog>
      ) : null}
    </>
  );
}
