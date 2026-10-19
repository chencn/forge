import { lazy, Suspense, useEffect } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import {
  closeMaven,
  mavenIconVisible,
  reloadMaven,
  toggleMavenOpen,
  useMavenProject,
  watchMaven,
} from "../hooks/useMavenProject";
import type { RunConfiguration } from "../lib/runConfigs";
import { useI18n } from "../i18n";
import MavenIcon from "./MavenIcon";

const MavenPane = lazy(() => import("./MavenPane"));

/**
 * 右下角那一格。探测没结束、或者这个文件夹里没有 pom，就不占位置。
 * 扫描本身在工程进窗口之后才排队，不挡打开。
 */
export function MavenStatus({
  workspace,
  onWillOpen,
}: {
  workspace: string | null;
  /** 右侧一次只留一块。通知还停在右侧时，先把它让开再打开 Maven。 */
  onWillOpen?: () => void;
}) {
  const { t } = useI18n();
  const maven = useMavenProject();
  useEffect(() => watchMaven(workspace), [workspace]);
  if (!mavenIconVisible(maven, workspace)) return null;
  return (
    <button
      type="button"
      className={`status-maven${maven.open ? " is-on" : ""}`}
      aria-pressed={maven.open}
      aria-label={t("maven.title")}
      title={t("maven.title")}
      onClick={() => {
        if (!maven.open) onWillOpen?.();
        toggleMavenOpen();
      }}
    >
      <MavenIcon size={14} />
    </button>
  );
}

const RIGHT_DOCK_MIN = 220;

/** 右侧工具窗左缘那条缝。往左拖变宽，松手才把宽度交回去。 */
export function RightDockSplitter({
  width,
  panelRef,
  dragRef,
  onCommit,
}: {
  width: number;
  panelRef: RefObject<HTMLElement | null>;
  dragRef: RefObject<{ startX: number; startWidth: number; live: number } | null>;
  onCommit: (width: number) => void;
}) {
  const clamp = (grown: number) => {
    const max = Math.max(RIGHT_DOCK_MIN, window.innerWidth - 480);
    return Math.max(RIGHT_DOCK_MIN, Math.min(max, grown));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="panel-splitter is-vertical"
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        dragRef.current = { startX: event.clientX, startWidth: width, live: width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag) return;
        drag.live = clamp(drag.startWidth + drag.startX - event.clientX);
        if (panelRef.current) panelRef.current.style.width = `${drag.live}px`;
      }}
      onPointerUp={() => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (drag) onCommit(drag.live);
      }}
      onLostPointerCapture={() => {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;
        onCommit(drag.live);
      }}
    />
  );
}

/** 点状态栏图标之后才挂上的工具窗口，挂在编辑区右侧。 */
export function MavenDock({
  workspace,
  running,
  width,
  paneRef,
  dragRef,
  onWidth,
  onRun,
  onStop,
  onOpenFile,
}: {
  workspace: string | null;
  running: boolean;
  width: number;
  paneRef: RefObject<HTMLElement | null>;
  dragRef: RefObject<{ startX: number; startWidth: number; live: number } | null>;
  onWidth: (width: number) => void;
  onRun: (config: RunConfiguration) => void;
  onStop: () => void;
  onOpenFile: (path: string) => void;
}) {
  const maven = useMavenProject();
  if (!workspace || !maven.open || maven.root !== workspace) return null;
  if (!maven.project && maven.status !== "failed") return null;
  return (
    <>
      <RightDockSplitter width={width} panelRef={paneRef} dragRef={dragRef} onCommit={onWidth} />
      <Suspense fallback={null}>
        <MavenPane
          workspace={workspace}
          project={maven.project}
          error={maven.error}
          refreshing={maven.status === "loading"}
          running={running}
          width={width}
          paneRef={paneRef}
          onClose={closeMaven}
          onReload={reloadMaven}
          onRun={onRun}
          onStop={onStop}
          onOpenFile={onOpenFile}
        />
      </Suspense>
    </>
  );
}
