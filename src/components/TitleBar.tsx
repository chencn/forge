import type { ReactNode } from "react";
import { PanelLeft, PanelRight } from "lucide-react";
import { useWindowControls } from "../lib/window";
import { useI18n } from "../i18n";
import appMark from "../../src-tauri/icons/icon.svg";

interface TitleBarProps {
  /** 侧栏开关状态，按钮显示对应方向箭头。 */
  sidebarOpen: boolean;
  /** 侧栏工具窗口当前宽度，收起按钮要跟着它左右走。 */
  sidebarWidth: number;
  onToggleSidebar: () => void;
  /** 右侧工具窗口是否有可显示的入口；没有内容时不显示无效按钮。 */
  rightSidebarAvailable: boolean;
  /** 右侧内容面板当前是否展开。 */
  rightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
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
 * 收起侧栏的那颗浮在侧栏右边缘；侧栏一收，它搬回应用标记那一格，标记跟着让位。
 * 工程和分支只在侧栏开着时留在这一行。
 */
export default function TitleBar({
  sidebarOpen,
  sidebarWidth,
  onToggleSidebar,
  rightSidebarAvailable,
  rightSidebarOpen,
  onToggleRightSidebar,
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
      {/* 38px 与活动条等宽：开着是应用标记，收起后这一格让给折叠那颗。 */}
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
        {/* 侧栏一收，工程和分支跟着收掉，只留那颗折叠开关；冲突那对按钮不跟着收。
            按钮不占流程，这一段的宽度收到按钮之前，长分支名才不会从按钮底下穿过去。
            按钮左缘相对拖拽内容起点 = 侧栏宽 - 右内边距 6 - 按钮 25 - 拖拽左内边距 10，再留 8px。 */}
        <div
          className="titlebar-leading"
          style={sidebarOpen ? { maxWidth: Math.max(0, sidebarWidth - 49) } : undefined}
        >
          {sidebarOpen ? project : null}
          {sidebarOpen ? branch : null}
          {conflict}
        </div>
        <span className="titlebar-gap" data-tauri-drag-region />
        {run}
        {search}
      </div>

      <div className="titlebar-actions">
        {rightSidebarAvailable ? (
          <button
            type="button"
            className={`icon-button is-toolbar${rightSidebarOpen ? " is-on" : ""}`}
            onClick={onToggleRightSidebar}
            title={t(rightSidebarOpen ? "sidebar.hide" : "sidebar.show")}
            aria-pressed={rightSidebarOpen}
          >
            <PanelRight size={17} />
          </button>
        ) : null}
        {settings}

        <span className="titlebar-divider" />

        <div className="window-controls">
          <button
            type="button"
            className="window-control"
            onClick={minimize}
            title={t("window.minimize")}
          >
            <WindowGlyph kind="minimize" />
          </button>
          <button
            type="button"
            className="window-control"
            onClick={toggleMaximize}
            title={t(maximized ? "window.restore" : "window.maximize")}
          >
            <WindowGlyph kind={maximized ? "restore" : "maximize"} />
          </button>
          <button
            type="button"
            className="window-control is-close"
            onClick={dismiss}
            title={t("window.close")}
          >
            <WindowGlyph kind="close" />
          </button>
        </div>
      </div>
    </header>
  );
}

const WINDOW_GLYPHS = {
  minimize: "\uE921",
  maximize: "\uE922",
  restore: "\uE923",
  close: "\uE8BB",
} as const;

/** Windows 标题栏那套 Segoe 字形，和 Lithe 的窗口按钮同一套。 */
function WindowGlyph({ kind }: { kind: keyof typeof WINDOW_GLYPHS }) {
  return (
    <span className="window-glyph" aria-hidden="true">
      {WINDOW_GLYPHS[kind]}
    </span>
  );
}
