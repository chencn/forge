import { memo, useRef, useState, type MouseEvent } from "react";
import { Icon } from "../../ui/Icon";
import { Menu, type MenuItem } from "../../ui/Menu";
import { useI18n } from "../../i18n";
import styles from "./ProjectHeader.module.css";

export type ProjectViewMode = "project" | "projectFiles" | "openFiles" | "changedFiles" | "scratches";

export interface ViewOptions {
  showHidden: boolean;
  showExcluded: boolean;
  compact: boolean;
  foldersFirst: boolean;
  autoscrollToSource: boolean;
  autoscrollFromSource: boolean;
  singleClickOpen: boolean;
  singleClickExpand: boolean;
  previewTab: boolean;
}

export const DEFAULT_VIEW_OPTIONS: ViewOptions = {
  showHidden: false,
  showExcluded: true,
  compact: true,
  foldersFirst: true,
  autoscrollToSource: false,
  // 对齐 openidea 默认值：不随标签切换自动跟随，仅点「选择已打开的文件」按钮才定位
  autoscrollFromSource: false,
  singleClickOpen: false,
  singleClickExpand: false,
  // 对齐 openidea/IDEA 默认：单击仅选中，双击才打开；previewTab 开启时单击才开标签
  previewTab: false,
};

export interface ProjectHeaderProps {
  mode: ProjectViewMode;
  onModeChange: (mode: ProjectViewMode) => void;
  options: ViewOptions;
  onOptionsChange: (options: ViewOptions) => void;
  onLocate?: () => void;
  /** 无已打开文件可定位时置灰（对齐旧版「定位文件位置」按钮的 disabled 行为） */
  locateDisabled?: boolean;
  onExpandAll?: () => void;
  onCollapseAll?: () => void;
  onHide?: () => void;
  /** 是否处于全屏/最大化状态 */
  isExpanded?: boolean;
  /** 切换全屏/最大化状态回调 */
  onToggleExpand?: () => void;
}

export const ProjectHeader = memo(function ProjectHeader({
  mode,
  onModeChange,
  options,
  onOptionsChange,
  onLocate,
  locateDisabled,
  onExpandAll,
  onCollapseAll,
  onHide,
  isExpanded,
  onToggleExpand,
}: ProjectHeaderProps) {
  const { t } = useI18n();

  const [titleMenuOpen, setTitleMenuOpen] = useState(false);
  const [optionsMenuOpen, setOptionsMenuOpen] = useState(false);
  const [titleAnchor, setTitleAnchor] = useState<{ x: number; y: number } | null>(null);
  const [optionsAnchor, setOptionsAnchor] = useState<{ x: number; y: number } | null>(null);

  const titleRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLButtonElement>(null);

  const modeLabels: Record<ProjectViewMode, string> = {
    project: t("project.view.title"),
    projectFiles: t("project.view.projectFiles"),
    openFiles: t("project.view.openFiles"),
    changedFiles: t("project.view.allChangedFiles"),
    scratches: t("project.view.scratches"),
  };

  const titleMenuItems: MenuItem[] = [
    {
      label: t("project.view.title"),
      checked: mode === "project",
      run: () => onModeChange("project"),
    },
    {
      label: t("project.view.projectFiles"),
      checked: mode === "projectFiles",
      run: () => onModeChange("projectFiles"),
    },
    {
      label: t("project.view.openFiles"),
      checked: mode === "openFiles",
      run: () => onModeChange("openFiles"),
    },
    {
      label: t("project.view.allChangedFiles"),
      checked: mode === "changedFiles",
      run: () => onModeChange("changedFiles"),
    },
    {
      label: t("project.view.scratches"),
      checked: mode === "scratches",
      run: () => onModeChange("scratches"),
    },
  ];

  const updateOption = (key: keyof ViewOptions, val: boolean) => {
    onOptionsChange({ ...options, [key]: val });
  };

  const optionsMenuItems: MenuItem[] = [
    { kind: "header", label: t("project.view.appearance") },
    {
      label: t("project.view.showHidden"),
      checked: options.showHidden,
      run: () => updateOption("showHidden", !options.showHidden),
    },
    {
      label: t("project.view.showExcluded"),
      checked: options.showExcluded,
      run: () => updateOption("showExcluded", !options.showExcluded),
    },
    {
      label: t("project.view.compactMiddle"),
      checked: options.compact,
      run: () => updateOption("compact", !options.compact),
    },
    {
      label: t("project.view.foldersFirst"),
      checked: options.foldersFirst,
      run: () => updateOption("foldersFirst", !options.foldersFirst),
    },
    { kind: "separator" },
    { kind: "header", label: t("project.view.behavior") },
    {
      label: t("project.view.autoscrollTo"),
      checked: options.autoscrollToSource,
      run: () => updateOption("autoscrollToSource", !options.autoscrollToSource),
    },
    {
      label: t("project.view.autoscrollFrom"),
      checked: options.autoscrollFromSource,
      run: () => updateOption("autoscrollFromSource", !options.autoscrollFromSource),
    },
    {
      label: t("project.view.singleClickOpen"),
      checked: options.singleClickOpen,
      run: () => updateOption("singleClickOpen", !options.singleClickOpen),
    },
    {
      label: t("project.view.singleClickExpand"),
      checked: options.singleClickExpand,
      run: () => updateOption("singleClickExpand", !options.singleClickExpand),
    },
    {
      label: t("project.view.previewTab"),
      checked: options.previewTab,
      run: () => updateOption("previewTab", !options.previewTab),
    },
  ];

  const openTitleMenu = (e: MouseEvent) => {
    const rect = titleRef.current?.getBoundingClientRect();
    if (rect) {
      setTitleAnchor({ x: rect.left, y: rect.bottom + 2 });
    } else {
      setTitleAnchor({ x: e.clientX, y: e.clientY });
    }
    setTitleMenuOpen(true);
  };

  const openOptionsMenu = (e: MouseEvent) => {
    const rect = optionsRef.current?.getBoundingClientRect();
    if (rect) {
      setOptionsAnchor({ x: rect.right, y: rect.bottom + 2 });
    } else {
      setOptionsAnchor({ x: e.clientX, y: e.clientY });
    }
    setOptionsMenuOpen(true);
  };

  return (
    <div
      className={styles.header}
      role="toolbar"
      aria-label="Project Header"
      onDoubleClick={(e) => {
        // 双击顶栏空白处切换全屏最大化
        if (e.target === e.currentTarget && onToggleExpand) {
          onToggleExpand();
        }
      }}
    >
      <div
        ref={titleRef}
        className={styles.titleArea}
        onClick={openTitleMenu}
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={titleMenuOpen}
        title={modeLabels[mode]}
      >
        <span>{modeLabels[mode]}</span>
        <span className={styles.titleChevron}>
          <Icon name="chevron-down" size={12} />
        </span>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.actionButton}
          onClick={onLocate}
          disabled={locateDisabled}
          title={t("project.view.locate")}
          aria-label={t("project.view.locate")}
        >
          <Icon name="locate" size={14} />
        </button>
        <button
          type="button"
          className={styles.actionButton}
          onClick={onExpandAll}
          title={t("project.view.expandAll")}
          aria-label={t("project.view.expandAll")}
        >
          <Icon name="expand-all" size={14} />
        </button>
        <button
          type="button"
          className={styles.actionButton}
          onClick={onCollapseAll}
          title={t("project.view.collapseAll")}
          aria-label={t("project.view.collapseAll")}
        >
          <Icon name="collapse-all" size={14} />
        </button>
        <button
          ref={optionsRef}
          type="button"
          className={styles.actionButton}
          onClick={openOptionsMenu}
          aria-haspopup="menu"
          aria-expanded={optionsMenuOpen}
          title={t("project.view.appearance")}
          aria-label="Options"
        >
          <Icon name="more" size={14} />
        </button>
        {onToggleExpand && (
          <button
            type="button"
            className={styles.actionButton}
            onClick={onToggleExpand}
            title={isExpanded ? t("window.restore") || "Restore" : t("window.maximize") || "Maximize"}
            aria-label={isExpanded ? t("window.restore") || "Restore" : t("window.maximize") || "Maximize"}
            aria-pressed={isExpanded}
          >
            <Icon name={isExpanded ? "minimize" : "maximize"} size={14} />
          </button>
        )}
        {onHide && (
          <button
            type="button"
            className={styles.actionButton}
            onClick={onHide}
            title={t("tool.closePanel") || "Hide"}
            aria-label="Hide"
          >
            <Icon name="minus" size={14} />
          </button>
        )}
      </div>

      {titleMenuOpen && titleAnchor && (
        <Menu
          open={titleMenuOpen}
          anchor={titleAnchor}
          placement="bottom-start"
          items={titleMenuItems}
          onClose={() => setTitleMenuOpen(false)}
        />
      )}

      {optionsMenuOpen && optionsAnchor && (
        <Menu
          open={optionsMenuOpen}
          anchor={optionsAnchor}
          placement="bottom-end"
          items={optionsMenuItems}
          onClose={() => setOptionsMenuOpen(false)}
        />
      )}
    </div>
  );
});
