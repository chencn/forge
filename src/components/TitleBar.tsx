import type { ReactNode } from "react";
import { Maximize, Minimize, Minus, PanelLeft, X } from "lucide-react";
import { useWindowControls } from "../lib/window";
import { useI18n } from "../i18n";
import appMark from "../../src-tauri/icons/icon.svg";

interface TitleBarProps {
  /** 侧栏开关状态，按钮显示对应方向箭头。 */
  sidebarOpen: boolean;
  /** 侧栏工具窗口当前宽度，收起按钮要跟着它左右走。 */
  sidebarWidth: number;
  onToggleSidebar: () => void;
  /** 主工具栏左段：工程芯片。 */
  project: ReactNode;
  /** 主工具栏左段：分支芯片。 */
  branch: ReactNode;
  /** 主工具栏左段：冲突期间的继续 / 中止，紧挨分支控件，平时不出现。 */
  conflict?: ReactNode;
  /** 主工具栏右段：运行配置与运行/停止。 */
  run: ReactNode;
  /** 主工具栏右段：随处搜索，跟在运行控件后面。 */
  search?: ReactNode;
  /** 窗口控件左侧：设置入口，紧挨最小化那颗。 */
  settings: ReactNode;
}

/**
 * IDEA 的主工具栏：最左那格是应用标记，工程与分支芯片紧跟其后，运行控件在右，
 * 中间整条都是可拖拽区。收起侧栏的那颗浮在侧栏右边缘；侧栏一收，它搬回应用标记
 * 那一格，标记跟着让位。窗口控件固定在最右。
 */
export default function TitleBar({
  sidebarOpen,
  sidebarWidth,
  onToggleSidebar,
  project,
  branch,
  conflict,
  run,
  search,
  settings,
}: TitleBarProps) {
  const { maximized, minimize, toggleMaximize, dismiss } = useWindowControls();
  const { t } = useI18n();

  const collapse = (
    <button
      type="button"
      className={`icon-button is-toolbar${sidebarOpen ? " is-on" : ""}`}
      onClick={onToggleSidebar}
      title={t(sidebarOpen ? "sidebar.hide" : "sidebar.show")}
      aria-pressed={sidebarOpen}
    >
      <PanelLeft size={17} />
    </button>
  );

  return (
    <header className="titlebar">
      {/* 44px 与活动栏等宽：开着是应用标记，收起后这一格让给折叠那颗。 */}
      <span className="titlebar-app" data-tauri-drag-region>
        {sidebarOpen ? (
          <img
            className="titlebar-app-icon"
            src={appMark}
            width={18}
            height={18}
            alt=""
            draggable={false}
            data-tauri-drag-region
          />
        ) : (
          collapse
        )}
      </span>

      {/* 折叠那颗浮在侧栏那一段的右缘，宽度跟着侧栏走；它不占流程，芯片不会被顶走。 */}
      {sidebarOpen ? (
        <div className="titlebar-sideband" style={{ width: sidebarWidth }}>
          {collapse}
        </div>
      ) : null}

      <div className="titlebar-drag" data-tauri-drag-region>
        {/* 侧栏一收，标记·工程·分支这一段跟着收掉，只留那颗折叠开关；冲突那对按钮不跟着收。 */}
        {sidebarOpen ? project : null}
        {sidebarOpen ? branch : null}
        {conflict}
        <span className="titlebar-gap" data-tauri-drag-region />
        {run}
        {search}
      </div>

      <div className="titlebar-actions">
        {settings}

        <span className="titlebar-divider" />

        <button
          type="button"
          className="window-control"
          onClick={minimize}
          title={t("window.minimize")}
        >
          <Minus size={15} />
        </button>
        <button
          type="button"
          className="window-control"
          onClick={toggleMaximize}
          title={t(maximized ? "window.restore" : "window.maximize")}
        >
          {maximized ? <Minimize size={13} /> : <Maximize size={13} />}
        </button>
        <button
          type="button"
          className="window-control is-close"
          onClick={dismiss}
          title={t("window.close")}
        >
          <X size={16} />
        </button>
      </div>
    </header>
  );
}
