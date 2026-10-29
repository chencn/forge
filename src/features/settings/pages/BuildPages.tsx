export function BuildToolsPage() {
  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <p className="settings-hint">
          Forge 内置对 Rust (Cargo)、Java (Maven)、Node.js (NPM/Vite) 的脚本执行与依赖管理支持。
        </p>
      </div>
    </div>
  );
}

export function BuildRunConfigsPage() {
  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <p className="settings-hint">
          可在顶部工具栏的“编辑运行配置”中为每个项目定制独立的构建与运行脚本。
        </p>
      </div>
    </div>
  );
}

export function BuildDeploymentPage() {
  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <p className="settings-hint">
          支持远端环境部署与路径映射（规划中，后续版本将支持 SSH 远端同步）。
        </p>
      </div>
    </div>
  );
}
