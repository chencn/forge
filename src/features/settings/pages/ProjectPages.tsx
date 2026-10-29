export function ProjectSdkPage({ workspace }: { workspace: string | null }) {
  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <div className="settings-row">
          <span className="settings-label">当前工程路径</span>
          <span className="settings-value">{workspace || "未打开任何工程"}</span>
        </div>
        <p className="settings-hint">
          Forge 自动探测工程根目录下的开发工具链（如 Rust Cargo、Node.js NPM、Java Maven 等）。
        </p>
      </div>
    </div>
  );
}

export function ProjectRootsPage({ workspace }: { workspace: string | null }) {
  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <div className="settings-row">
          <span className="settings-label">主工作区根目录</span>
          <span className="settings-value">{workspace || "—"}</span>
        </div>
        <p className="settings-hint">
          在多工作区模式（Multi-root）下，左侧文件树会同时挂载多个独立的根文件夹。
        </p>
      </div>
    </div>
  );
}
