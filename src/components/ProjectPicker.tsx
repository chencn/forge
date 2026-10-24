import { useRef, useState } from "react";
import { ChevronDown, FolderOpen, LogOut, X } from "lucide-react";
import Popover from "./Popover";
import ProjectAvatar from "./ProjectAvatar";
import { basenameOf, samePath } from "../lib/format";
import type { WorkspaceMode } from "../lib/settings";
import { useI18n } from "../i18n";

/** 常驻工作区列表中每一项的状态摘要。 */
export interface FolderStatusItem {
  path: string;
  /** 该根下有正在运行的任务或存活的终端会话。 */
  running: boolean;
  /** AI 状态单独计数，避免和终端、构建任务混成一个圆点。 */
  aiRunning: number;
  aiQueued: number;
  aiExternal: number;
  /** 该根下有未保存的编辑器改动。 */
  dirty: boolean;
}

interface ProjectPickerProps {
  /** 当前工程根；null 表示还没打开文件夹。 */
  root: string | null;
  /** 工作区模式：multi（多工作区常驻）或 single（单工作区）。 */
  mode?: WorkspaceMode;
  /** 当前常驻打开的全部文件夹及其后台运行/脏状态。 */
  openFolders?: FolderStatusItem[];
  /** 最近打开过的文件夹，新的在前。 */
  recent: string[];
  onOpenFolder: () => void;
  onPick: (path: string) => void;
  /** 关闭某一个常驻文件夹（多工作区弹层行尾 × 使用）。 */
  onCloseFolder?: (path: string) => void;
  /** 从「最近项目」历史列表中移除某一项。 */
  onRemoveRecent?: (path: string) => void;
  onCloseProject: () => void;
}

/** IDEA 的工程入口在主工具栏最左边：一颗带下拉的芯片，不是一个静态标题。 */
export default function ProjectPicker({
  root,
  mode = "multi",
  openFolders = [],
  recent,
  onOpenFolder,
  onPick,
  onCloseFolder,
  onRemoveRecent,
  onCloseProject,
}: ProjectPickerProps) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  /** 弹层锚点用 ref 拿，别靠 event.currentTarget：updater 跑的时候它已经被清空。 */
  const chipRef = useRef<HTMLButtonElement>(null);

  const name = root ? basenameOf(root) : null;
  const isMulti = mode === "multi";
  /** 开启多工作区或当前已有多个常驻文件夹时，弹层显示「已打开」分组，避免切回单工作区后后台文件夹无法查看与关闭。 */
  const showOpenGroup = (isMulti && openFolders.length > 0) || openFolders.length > 1;
  const showCountBadge = openFolders.length > 1;
  /** 「已打开」分组出现时，最近项目里过滤掉已在打开列表中的项，避免同一文件夹在弹层里上下重复出现。 */
  const visibleRecent = showOpenGroup
    ? recent.filter((path) => !openFolders.some((item) => samePath(item.path, path)))
    : recent;
  /**
   * 没打开工程时也一样能翻历史：有历史就弹那张列表，「打开文件夹」是列表末尾那一条。
   * 一条历史都没有才直接开对话框——那时弹层里除了这一条没别的内容。
   */
  const pickable = name !== null || recent.length > 0 || openFolders.length > 0;

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
        {name && root ? (
          <ProjectAvatar name={name} path={root} anchorGradient />
        ) : (
          <FolderOpen size={16} aria-hidden="true" />
        )}
        <span className="toolbar-chip-label">{name ?? t("workspace.openFolder")}</span>
        {/* 工程名旁直接显示运行状态，不必先展开项目菜单才能发现后台任务。 */}
        {root && openFolders.some((item) => samePath(item.path, root) && item.running) ? <span className="ws-dot is-running" aria-label={t("project.runningDot")} title={t("project.runningDot")} /> : null}
        {showCountBadge ? <span className="ws-count">{openFolders.length}</span> : null}
        {pickable ? <ChevronDown size={13} aria-hidden="true" /> : null}
      </button>

      {pickable ? (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} minWidth={220} maxWidth={320}>
          {showOpenGroup ? (
            <>
              <p className="popover-label">
                {t("project.openCount", { count: openFolders.length })}
              </p>
              {openFolders.map((item) => {
                const isCurrent = root !== null && samePath(item.path, root);
                const folderName = basenameOf(item.path);
                return (
                  <div
                    key={item.path}
                    role="button"
                    tabIndex={0}
                    className={`popover-item ws-open-row${isCurrent ? " is-current" : ""}`}
                    title={item.path}
                    onClick={() => {
                      setAnchor(null);
                      if (!isCurrent) onPick(item.path);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setAnchor(null);
                        if (!isCurrent) onPick(item.path);
                      }
                    }}
                  >
                    <ProjectAvatar name={folderName} path={item.path} size={20} />
                    <span className="popover-item-label">{folderName}</span>
                    {item.aiRunning || item.aiQueued || item.aiExternal ? (
                      <span
                        className="ai-project-running"
                        title={t("project.runningDot")}
                        aria-label={t("project.runningDot")}
                      >{[
                        item.aiRunning ? t("ai.runtime.projectRunning", { count: item.aiRunning }) : "",
                        item.aiQueued ? t("ai.runtime.projectQueued", { count: item.aiQueued }) : "",
                        item.aiExternal ? t("ai.runtime.projectExternal", { count: item.aiExternal }) : "",
                      ].filter(Boolean).join(" · ")}</span>
                    ) : item.running ? (
                      <span className="ai-project-running" title={t("project.runningDot")} aria-label={t("project.runningDot")}>{t("ai.runtime.running")}</span>
                    ) : null}
                    {item.dirty ? (
                      <span
                        className="ws-dot is-dirty"
                        title={t("project.dirtyDot")}
                        aria-label={t("project.dirtyDot")}
                      />
                    ) : null}
                    <button
                      type="button"
                      className="ws-row-close"
                      title={t("project.closeNamed", { name: folderName })}
                      aria-label={t("project.closeNamed", { name: folderName })}
                      onClick={(event) => {
                        event.stopPropagation();
                        setAnchor(null);
                        onCloseFolder?.(item.path);
                      }}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                      }}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
              <div className="popover-sep" />
            </>
          ) : null}

          <p className="popover-label">{t("project.recent")}</p>
          {visibleRecent.length === 0 ? (
            <p className="popover-note">{t("project.none")}</p>
          ) : (
            visibleRecent.map((path) => {
              const isCurrent = root !== null && samePath(path, root);
              const folderName = basenameOf(path);
              return (
                <div
                  key={path}
                  role="button"
                  tabIndex={0}
                  className={`popover-item ws-open-row${isCurrent ? " is-current" : ""}`}
                  title={path}
                  onClick={() => {
                    setAnchor(null);
                    if (!isCurrent) onPick(path);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setAnchor(null);
                      if (!isCurrent) onPick(path);
                    }
                  }}
                >
                  <ProjectAvatar name={folderName} path={path} size={20} />
                  <span className="popover-item-label">{folderName}</span>
                  <button
                    type="button"
                    className="ws-row-close"
                    title={t("project.removeRecentNamed", { name: folderName })}
                    aria-label={t("project.removeRecentNamed", { name: folderName })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemoveRecent?.(path);
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              );
            })
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
            <span>{t(isMulti ? "project.addFolder" : "project.openOther")}</span>
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
              <span>
                {isMulti ? t("project.closeNamed", { name }) : t("workspace.closeFolder")}
              </span>
            </button>
          ) : null}
        </Popover>
      ) : null}
    </div>
  );
}
