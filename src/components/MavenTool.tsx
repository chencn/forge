import { lazy, Suspense } from "react";
import type { RunConfiguration } from "../lib/runConfigs";
import { useMavenProject } from "../hooks/useMavenProject";

const MavenPane = lazy(() => import("./MavenPane"));

/**
 * 右侧工具窗口里的 Maven 内容（标题栏由右侧边栏框架统一提供）。当前工作区
 * 探测到 Maven 工程（或扫描失败要报错）才挂上；探测没结束或不是 Maven 工程就不占位。
 * 扫描本身在工程进窗口之后才排队，不挡打开。
 */
export function MavenDock({
  workspace,
  running,
  onRun,
  onStop,
  onOpenFile,
}: {
  workspace: string | null;
  running: boolean;
  onRun: (config: RunConfiguration) => void;
  onStop: () => void;
  onOpenFile: (path: string) => void;
}) {
  const maven = useMavenProject();
  if (!workspace || maven.root !== workspace) return null;
  if (!maven.project && maven.status !== "failed") return null;
  return (
    <Suspense fallback={null}>
      <MavenPane
        workspace={workspace}
        project={maven.project}
        error={maven.error}
        refreshing={maven.status === "loading"}
        running={running}
        onRun={onRun}
        onStop={onStop}
        onOpenFile={onOpenFile}
      />
    </Suspense>
  );
}
