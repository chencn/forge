# 发版与更新

GitHub Actions 打 tag 即发版，应用内更新从 GitHub Releases 拉。两件事共享同一批构件：
Release 里的安装包给人下载，`latest.json` 给 updater。实现落在三处：
`.github/workflows/release.yml`（CI）、`src-tauri/tauri.conf.json` 的 `bundle.targets` 与
`plugins.updater`（打包目标、更新端点与公钥）、`src/lib/updater.ts` 加设置页「关于」栏（界面）。

## 版本号：tag 是唯一事实来源

推 `v1.2.3` 形式的 tag 触发发版。CI 在构建前用 tag 覆盖三处版本，发版前不需要改任何文件：

- `package.json` 与 `package-lock.json`：`npm version --no-git-tag-version`；
- `src-tauri/tauri.conf.json`：应用版本，安装包文件名与 latest.json 的 version 都从这里来；
- `src-tauri/Cargo.toml`：只替换 `[package]` 顶部那行 `version = "..."`，依赖项里的 `version=` 不动。

不做本地 bump 脚本：脚本要靠人记得跑，忘了就发出版本号对不上的包。覆盖放在 CI 里，
流程里没有需要人记的步骤。tag 形式不过关（不是 `v主.次.补`）直接校验失败，不给模糊空间。

## 平台产物

| 平台 | 产物 | 应用内更新用什么 |
| --- | --- | --- |
| Windows | NSIS 多语言安装器（`-setup.exe`，内置简/繁/英，自适应系统语言） | `-setup.exe` 安装包 |
| Linux | deb + AppImage | AppImage 原地替换；deb 走系统包管理器 |
| macOS | universal dmg（x64 + arm64 一份包） | `app.tar.gz` 原地替换 |

`bundle.targets` 按平台写死（不再用 `"all"`），`bundle.createUpdaterArtifacts: true` 让
tauri-bundler 产出带 `.sig` 的更新工件。macOS 走 `--target universal-apple-darwin`，
一份包同时含两个架构，latest.json 里由 tauri-action 拆成 `darwin-aarch64-app` 与
`darwin-x86_64-app` 两条。

Linux runner 用 ubuntu-22.04 不用最新：glibc 与 webkit 版本越老，AppImage 能跑的发行版越多。

## Windows 多语言安装器（NSIS）

Windows 仅发布 NSIS 安装器（`Forge_x.y.z_x64-setup.exe`），彻底移除带单语言代码页限制的 WiX MSI 安装包。
- **多语言支持**：安装器内嵌 `SimpChinese`、`TradChinese`、`English`，根据用户系统语言自动选择，且开启 `displayLanguageSelector` 允许用户在安装起始手动切换语言。
- **体积与效率**：安装包仅 7.39 MiB，CI 构建时间减半，无任何多余的语言后缀命名。
- **更新流程**：latest.json 里 Windows 统一对应 `windows-x86_64-nsis`。安装器拉起时当前应用直接退出（`installMode: "passive"`，安装器自带进度条），装完由安装器重启应用。

## 签名、端点与镜像加速

- 更新包必须经 minisign 签名：私钥只在本地 `%TEMP%\forge-updater\forge.key` 与
  GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`（未设密码，`TAURI_SIGNING_PRIVATE_PASSWORD` 留空），
  公钥钉在 `tauri.conf.json` 的 `plugins.updater.pubkey`。私钥丢失则旧版应用无法再验证新包，必须备份。
- 端点固定一条：`https://github.com/chencn/forge/releases/latest/download/latest.json`。
  这是 GitHub 的 302 跳转地址，最终落在最新 Release 的资产上，所以 Release 必须直接发布
  （`releaseDraft: false`），草稿状态取不到。
- **镜像加速**：设置页提供「更新下载加速」（`proxyEnabled`，默认关）与前缀地址（`proxyUrl`，默认 `https://gh-proxy.com/`）。
  开启后在 Rust 侧改写清单请求端点与安装包二进制下载地址，加速国内访问；验签依然由本地客户端固定公钥进行 minisign 强校验，防篡改闭环。

## 界面状态机与右下角状态指示

- 设置 → 关于：`idle → checking → latest | available → downloading → installed`，失败进 `error`。
- **右下角状态栏指示器（`UpdateStatusBar`）**：
  - `idle`：无更新时静默隐藏不占位；
  - `available`：显示「发现新版本 vX.Y.Z」，点击跳转关于页；
  - `downloading`：展示实时下载百分比与旋转动画；
  - `ready`：高亮常驻「新版本已就绪，点击重启」，点击弹出重启确认框；
  - `error`：异常提示，点击查看详情。
- **生命周期与资源释放**：Tauri 2 中 `Update` 为后端 `Resource`，未安装和推迟分支显式调用 `update.close()` 释放几十 MB 安装包内存与句柄。自动与手动流程统一通过 `withUpdateLock` 互斥保护。

## 自动下载、挂起补装与防死循环

设置里有更新偏好（`settings.json` 的 `updates` 组，Rust `UpdateSettings`）：
- `autoDownload`（默认关）
- `autoPromptInstall`（默认开，关掉时下载完置为就绪，不强杀工作中的进程）
- `proxyEnabled`（默认关）与 `proxyUrl`（默认 `https://gh-proxy.com/`）

启动时的自动流程（`runAutoUpdateFlow`）：
1. 检查挂起标记（`update-pending.json`，含 `version` 与 `attempts`）：
   - `pending.version === current`：已装好，清标。
   - `pending.attempts >= 1`：上次已尝试拉起安装器但仍未更新（用户在 UAC 选否或取消），清标并在状态栏提醒可用，杜绝重复闪退死循环。
   - 否则静默补装。
2. 后台自动检查失败保持静默，不弹 Toast 骚扰用户。
3. 下载完成后先落挂起标记，随后询问或置为就绪。用户点稍后立即调用 `closeUpdate` 释放内存。

## macOS 未签名

没有 Apple 开发者证书，dmg 不签名不公证。浏览器下载的 dmg 带 quarantine 属性，
首次双击会被 Gatekeeper 拦，绕法：右键 → 打开，或系统设置 → 隐私与安全性 → 仍要打开，
或 `xattr -cr /Applications/Forge.app`。这只是首次安装的事：应用内更新下载替换的文件
不带 quarantine 属性，更新后启动不会再被拦。若日后拿到开发者账号，在 CI 里加签名与
公证步骤即可，端点与密钥机制不变。
