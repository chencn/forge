export function VcsGeneralPage() {
  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <p className="settings-hint">
          Forge 原生集成 Git 版本控制系统，自动感知当前打开工程的 Git 仓库根目录与子模块。
        </p>
      </div>
    </div>
  );
}

export function VcsGitPage() {
  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <div className="settings-row">
          <span className="settings-label">Git 可执行文件路径</span>
          <input
            type="text"
            className="text-input"
            defaultValue="git"
            placeholder="git (默认使用系统 PATH)"
          />
        </div>
        <p className="settings-hint">
          支持直接使用系统已安装的 Git，自动关联提交日志、分支树与状态变更。
        </p>
      </div>
    </div>
  );
}

export function VcsConfirmationPage() {
  return (
    <div className="settings-rows">
      <div className="settings-rows-limit">
        <p className="settings-hint">
          进行文件回滚、硬重置（git reset --hard）、删除分支等不可逆危险操作时，默认均会触发确认提示弹窗。
        </p>
      </div>
    </div>
  );
}
