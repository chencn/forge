import { useRef, useState } from "react";
import { ChevronDown, FolderOpen, LogOut, PanelTop } from "lucide-react";
import Popover from "./Popover";
import { basenameOf } from "../lib/format";
import { useI18n } from "../i18n";

interface ProjectPickerProps {
  /** 当前工程根；null 表示还没打开文件夹。 */
  root: string | null;
  /** 最近打开过的文件夹，新的在前。 */
  recent: string[];
  onOpenFolder: () => void;
  onPick: (path: string) => void;
  onCloseProject: () => void;
}

/** IDEA 的工程入口在主工具栏最左边：一颗带下拉的芯片，不是一个静态标题。 */
export default function ProjectPicker({
  root,
  recent,
  onOpenFolder,
  onPick,
  onCloseProject,
}: ProjectPickerProps) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  /** 弹层锚点用 ref 拿，别靠 event.currentTarget：updater 跑的时候它已经被清空。 */
  const chipRef = useRef<HTMLButtonElement>(null);

  const name = root ? basenameOf(root) : null;
  /**
   * 没打开工程时也一样能翻历史：有历史就弹那张列表，「打开文件夹」是列表末尾那一条。
   * 一条历史都没有才直接开对话框——那时弹层里除了这一条没别的内容。
   */
  const pickable = name !== null || recent.length > 0;

  return (
    <div className="toolbar-chip-host">
      <button
        type="button"
        ref={chipRef}
        className="toolbar-chip"
        aria-label={t("project.label")}
        aria-expanded={anchor !== null}
        title={root ?? t("workspace.openFolder")}
        onClick={() => {
          if (!pickable) {
            onOpenFolder();
            return;
          }
          setAnchor((current) => (current ? null : chipRef.current));
        }}
      >
        <PanelTop size={14} aria-hidden="true" />
        <span className="toolbar-chip-label">{name ?? t("workspace.openFolder")}</span>
        {pickable ? <ChevronDown size={13} aria-hidden="true" /> : null}
      </button>

      {pickable ? (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} minWidth={280}>
          <p className="popover-label">{t("project.recent")}</p>
          {recent.length === 0 ? (
            <p className="popover-note">{t("project.none")}</p>
          ) : (
            recent.map((path) => (
              <button
                key={path}
                type="button"
                className={`popover-item${path === root ? " is-current" : ""}`}
                onClick={() => {
                  setAnchor(null);
                  if (path !== root) onPick(path);
                }}
              >
                <FolderOpen size={14} aria-hidden="true" />
                <span className="popover-item-label">{basenameOf(path)}</span>
                <span className="popover-item-detail" title={path}>
                  {path}
                </span>
              </button>
            ))
          )}
          <div className="popover-sep" />
          <button
            type="button"
            className="popover-item"
            onClick={() => {
              setAnchor(null);
              onOpenFolder();
            }}
          >
            <FolderOpen size={14} aria-hidden="true" />
            <span>{t("project.openOther")}</span>
          </button>
          {name ? (
            <button
              type="button"
              className="popover-item"
              onClick={() => {
                setAnchor(null);
                onCloseProject();
              }}
            >
              <LogOut size={14} aria-hidden="true" />
              <span>{t("workspace.closeFolder")}</span>
            </button>
          ) : null}
        </Popover>
      ) : null}
    </div>
  );
}
