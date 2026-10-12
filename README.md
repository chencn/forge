# Forge

一个长得像 IntelliJ IDEA 的轻量代码编辑器。

界面不用重新学。左边资源管理器，顶上工程下拉、分支下拉、运行按钮，提交面板、Git 日志、终端、运行窗口都在你习惯的位置，右键菜单的排法也照着 IDEA。但它不是 IDEA：没有 JVM，没有后台索引，启动就是启动，不用等它"加载项目"。底部状态条上随时能看到整个应用占了多少内存，悬停还能分开看到 WebView 渲染、宿主与各路子进程。

适合这几种情况：

- 你习惯了 IDEA 的操作，但不想为了改几十行代码开一个吃两三个 G 内存的 IDE。
- 代码大部分是 AI 写的，你的活是看、改、提交、跑起来验证。IDEA 那套重构、调试、框架支持在这里用不上，但你需要那颗资源管理器和那个 Git 面板。
- 同时开好几个项目的窗口，不想每个都是几百兆。
- 只需要一个能读代码、能 diff、能提交、能跑脚本的编辑器。

Git 功能是完整的，日常那几件事都能在这里做完，不用切回命令行。它调用系统的 `git` 命令，所以不用另外装什么，你的 git 配置和凭证也照用。

## 有什么

界面

- 主工具栏：打开工程、切分支、挑一条运行配置开跑。
- 活动栏：资源管理器、提交、终端、运行、Git 日志、设置。
- 终端、运行、Git 日志可以在底部槽和编辑器页签之间挪，侧栏宽度和底栏高度能拖。
- 浅色深色，中文英文，快捷键方案可选 IntelliJ IDEA 或 Eclipse。

编辑器

- Monaco，多标签，标签拖拽排序，未保存显示圆点，中键关闭。
- Markdown 有源码和预览两个视图，SVG 有图片和源码两个视图，PNG/JPG 直接预览并可以缩放。
- 差异视图：在变更列表里单击文件就打开，也能比较两个文件或两次提交。
- 文件改动自动刷新，不用手点。

Git

- 提交面板：变更按 未合并 / 已暂存 / 未暂存 / 未进行版本控制 / 已忽略 分组，就地暂存、全部暂存、按目录或模块分组、显示忽略的文件，写说明提交或提交并推送，勾"修正"展开上一次提交重写。
- 分支：签出、新建、重命名、删除、合并、变基、新建 worktree、打标签、推送。
- Git 日志：三栏，分支树 / 提交列表 / 提交详情。按文本、作者、日期筛，提交能多选。右键可以做复制修订号、创建补丁、cherry-pick、revert、把当前分支重置到此处（软 / 混合 / 硬）、比较版本、编辑提交消息、推送此前所有提交、新建分支或标签。
- 冲突处理：逐个文件选采用哪一边；仓库停在合并、变基、cherry-pick、revert 中间时给继续和中止。
- 抓取全部远端，`--ff-only` 更新，推送时没有上游自动建。

文件和终端

- 目录树支持新建、重命名、复制、移动、删除、多选批量右键、在资源管理器中显示、用关联程序打开。
- 隐藏文件默认不显示，被 git 忽略的文件默认显示，两个都在设置的通用栏里可以各自开关。
- 搜索：双击 Shift 或顶栏那颗放大镜开「随处搜索」，`Ctrl+Shift+N` 按名字找文件，`Ctrl+Shift+F` 在文件里找词
  （编辑器里选中一段再按它会直接拿这段去搜）。点开的那一条会在左边的目录树里定位出来，文件夹也会跟着摊开。
  正文命中除了跳进去，还会把整页结果放到下面的「查找」窗口里，可以逐个双击着跳。
  树里右键一个目录可以只在这个目录里找。大小写、整词、正则、文件名掩码都有。
  搜索不建索引，是当场扫盘，结果条数有上限，超了会告诉你「这不是全部」。
- 内置终端跑系统 shell，默认 PowerShell，可以换。终端窗口收起或者挪到页签栏都不会中断正在跑的进程。
- 运行认得出二十四族工程：`package.json` 的脚本、Maven（含 Spring Boot）、Gradle、裸 `.java`、Go 包（含 Wails v2 / v3）、Cargo、Python（Django / FastAPI / Flask / Streamlit / 包与脚本）、.NET 与 F#、PHP、Ruby、Dart / Flutter、Scala、Elixir、C / C++、Zig、Deno、Clojure、Haskell、Julia、Lua、Swift，还有根上的 `run.sh`；每条配置能改名、挑工作目录、加环境变量；支持运行、重跑、停止，每次一个独立会话标签，停止会把子进程一起杀掉。
- 右下角有通知气泡，出错和 git 操作的结果会留在那里，可以回看最近 7 天的记录。

## 装和跑

环境要求：

- Rust `stable-x86_64-pc-windows-gnu`
- MinGW-w64 GCC，PATH 里能找到 `windres`、`dlltool`、`ld`
- Node 18+
- 系统 `git` 命令
- WebView2 运行时，Win11 自带

```bash
npm install
npm run tauri:dev      # 开发：起 Vite，编译 Rust，开原生窗口
npm run tauri:build    # 打包，安装包在 src-tauri/target/release/bundle/
```

改完 Rust 跑 `npm run check:rs`。`npm run test:rs` 在本机会报 `STATUS_ENTRYPOINT_NOT_FOUND`，暂时用不了，原因见 `docs/backend/toolchain.md`。只想在浏览器里看界面用 `npm run dev`，但所有后端调用都会失败。

## 发版与更新

**发版：打 tag 即发。** 推一个 `v1.2.3` 形式的 tag，GitHub Actions（`.github/workflows/release.yml`）会在三个平台上构建并把安装包发布成 GitHub Release。版本号以 tag 为唯一事实来源，构建时 CI 直接用 tag 覆盖 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 里的版本，发版前不需要改任何文件。tag 带减号（如 `v1.2.3-beta.1`）会标成预发布。

| 平台 | Release 里的产物 |
| --- | --- |
| Windows | `Forge_x.y.z_x64-setup.exe`（NSIS 安装器）、`Forge_x.y.z_x64_en-US.msi` |
| Linux | `Forge_x.y.z_amd64.deb`、`Forge_x.y.z_amd64.AppImage` |
| macOS | `Forge_x.y.z_universal.dmg`（x64 与 arm64 双架构一份包） |

每个安装包都带 `.sig` 签名，Release 里另有一份 `latest.json`（各平台条目与签名），应用内更新靠它驱动。细节见 `docs/features/release-update/`。

**应用内更新。** 设置 → 关于 → 检查更新是手动路子：检查、下载并安装。另有两条偏好可开自动：

- **自动下载更新**（默认关）：启动后检查到新版本就后台下载。配套「**下载完成后询问安装**」（默认开）：开着会在下载完弹窗让你选是或否——选「是」立即安装，选「取消」下次启动时自动安装；关掉则下载完直接静默安装。
- 关掉自动下载就只走手动检查，但**已经下载过还没装的更新，下次启动时会自动安装**。
- Windows 按当前安装方式自动选包。MSI 装的下载 MSI，安装器装的下载 `-setup.exe`。拉起安装器时应用退出，装完由安装器重启；macOS / Linux 原地替换应用文件，装完重启应用生效。

应用默认只向 GitHub Releases 请求一个地址（端点与验签公钥都钉死在 `src-tauri/tauri.conf.json` 的 `plugins.updater`）；设置中亦提供可选的更新镜像加速前缀（默认 `https://gh-proxy.com/`，默认关闭），即便走代理下载依然由客户端本地钉死的公钥执行 minisign 签名校验。

**首次配置（只做一次）。** 更新签名密钥已生成：公钥已写进 `tauri.conf.json`，私钥在 `%TEMP%\forge-updater\forge.key`（不进仓库，丢了旧版应用将无法验证任何新包，务必备份）。到 GitHub 仓库 Settings → Secrets and variables → Actions 配两条 Secret：`TAURI_SIGNING_PRIVATE_KEY` 填 `forge.key` 文件的全部内容；`TAURI_SIGNING_PRIVATE_PASSWORD` 留空（私钥未设密码）。

**macOS 未签名，首次打开要绕一下 Gatekeeper。** 没有 Apple 开发者证书，dmg 不做签名与公证；浏览器下载的 dmg 自带 quarantine 属性，直接双击会被系统拦下。三种绕法任选其一：右键点 Forge 选「打开」；或系统设置 → 隐私与安全性 → 点「仍要打开」；或终端执行 `xattr -cr /Applications/Forge.app`。这只是首次安装的事：应用内更新替换的文件不带 quarantine 属性，之后更新完启动不会再被拦。

## 设置

设置在 `%APPDATA%\app.forge.desktop\settings.json`，全局生效，没有项目级设置。可改：外观、语言、点击关闭时是退出还是收进托盘、上次打开的文件夹、字号、制表宽度、缩略图、快捷键方案、代码保存策略、退出前是否保存未保存的改动、显示隐藏文件、显示被 git 忽略的文件、Shell 程序、自动下载更新、下载完成后询问安装、更新下载加速与代理地址。

切语言后界面立即变，编辑器内置的右键菜单和查找框要重启窗口才跟着变。

## 还不行的地方

- 删除文件不进回收站。
- 只支持 UTF-8 文本，单文件 8 MiB 上限。
- 同一个文件在磁盘和编辑器里都被改了时不做合并，保存会覆盖磁盘那份。
- 没有调试器，只能运行和停止。
- 运行交给构建工具自己启动（`mvn` / `gradle` / JDK），IDE 这边不算 classpath，改一行代码要重跑，没有热部署。
- `Cargo.toml` 还没接，Rust 工程要在终端里手敲。
- 跑起来的进程读不到键盘输入，要交互就用终端。
- 搜索没有替换，找到只能跳过去自己改。
- 搜索一次只显示一趟结果，不能像 IDEA 那样开好几个结果标签并存；扫描中途也不能取消。
- 终端一次只跟一条会话。

## 开发文档

- `docs/README.md`：目录结构和模块索引。
- `docs/features/`：按模块写的实现细节和设计原因，改哪块先看那块。
- `docs/backend/`：Rust 侧命令契约、错误模型、工具链约束。
- `docs/plans/`：设计了但还没做完的需求。
