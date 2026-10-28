# 后端总览

Rust 侧的入口只有一处：`src-tauri/src/lib.rs` 的 `invoke_handler` 注册表，一共 210 条；本文件收录其中 109 条，
AI 助手的其余命令见 [../features/ai-assistants/](../features/ai-assistants/)。系统事件 13 条（`fs://` 两条、
`term://` 两条、`proc://` 两条、`lsp://` 三条、`app://flush`、`shell-open`，加浏览器那两条 `forge-browser-*`），
AI 运行时另走 `ai-runtime://events`。命令数只按注册表算，写了 `#[tauri::command]` 但没进表的不算契约。
命令契约逐条对着代码核过，见 [commands.md](./commands.md)；错误模型见 [error-model.md](./error-model.md)；
构建与工具链约束见 [toolchain.md](./toolchain.md)；辅助脚本见 [scripts.md](./scripts.md)。
界面怎么用这些命令属于 `docs/features/`，这里不重复。

`find_files` 与 `search_text` 已经接线：`src/lib/fs.ts` 的 `findFiles` / `searchText` 各包一条，发出调用的只有
随处搜索弹层 `src/components/SearchEverywhere.tsx`，底部查找窗口 `src/components/FindPane.tsx`
画的是弹层交过来的那一整页，自己不发查询。挂点、键位与作用域见 [../features/search/](../features/search/)，
替换与扫描中断还没做，见 [../plans/global-search/](../plans/global-search/)。

## 模块划分

行数按文件当前长度计，只在该模块被改动时重算那一行；没动过的模块可能落着，别把这张表当全量核对结果。

| 模块 | 行数 | 管什么 | 命令数 |
| --- | --- | --- | --- |
| `src-tauri/src/fs/mod.rs` | 617 | 列目录、读写、新建/改名/复制/移动/删除、定位、指纹、asset 授权、外部打开 | 13 |
| `src-tauri/src/fs/search.rs` | 798 | 按名字找文件、逐文件扫正文；深度、条目数、单文件大小、返回条数四道上限定在这一层 | 2 |
| `src-tauri/src/fs/windows.rs` | 103 | kernel32 / shell32 直接 FFI：属性位、`explorer /select`、`ShellExecuteW` | — |
| `src-tauri/src/fs/unix.rs` | 59 | 同三个入口的 unix 实现：点开头当隐藏、`open -R` / `xdg-open` | — |
| `src-tauri/src/git/mod.rs` | 2681 | 以参数数组 spawn 系统 git，解析 porcelain / numstat / for-each-ref / log；两路输出各有 64 MiB 上限，超了报 `GIT_OUTPUT_TOO_LARGE` 而不是截半份 | 49 |
| `src-tauri/src/term.rs` | 269 | portable-pty 的 shell 会话，输出 base64 走事件；`shell_probe` 扫本机 shell | 6 |
| `src-tauri/src/proc.rs` | 182 | 跑一行命令并转发两路输出，停止时整棵进程树一起杀；`env` 那组变量逐条叠在继承来的父环境上 | 2 |
| `src-tauri/src/run/mod.rs` | 82 | 运行配置的数据模型：类型、命令行、工作目录、环境变量、缺工具的原因、起跑前要落盘的辅助文件 | — |
| `src-tauri/src/run/detect.rs` | 3176 | 扫工程出候选配置：npm 脚本、pom / gradle 两族、Spring 插件标记、裸 `.java` 的单文件启动；本机 `mvn` / `gradle` / `java` 与 wrapper 的解析也在这层。标志文件在不在一律问 `run/scan.rs` 那份名单，不再逐个 stat | 2 |
| `src-tauri/src/run/scan.rs` | 365 | 一层目录列一次得到的构建标志文件名单，识别与依赖探测共用；监听的新增/删除/改名即时作废，另带 2s TTL 兜底没被监听的根 | — |
| `src-tauri/src/run/dep_sync.rs` | 1505 | 依赖同步探测：按清单算语义指纹（注释/空行/版本字段不参与）、判断本地装没装、给出安装命令 | 1 |
| `src-tauri/src/run/store.rs` | 189 | `runConfigs.json` 按工程读写，落盘前只留用户自己建的那几条与三个 id 列表 | 2 |
| `src-tauri/src/watch.rs` | 505 | notify 递归监听，150ms 静默去抖、1s 封顶，攒下的路径按 256 拆批发 `fs://change`；新增/删除/改名顺手作废 `run/scan.rs` 那份名单 | 2 |
| `src-tauri/src/lsp.rs` | 752 | 语言服务会话表：stdio 管道、`Content-Length` 分帧读写、stderr 按行转事件、按窗口/server/根三份身份记账、退避与空闲回收、状态快照 | 7 |
| `src-tauri/src/lsp_config.rs` | 704 | `lsp.json` 读写：12 语言种子表、档位与空字段归一化、旧 `settings.json` 的 `lsp` 段一次性迁移、原子写 | 2 |
| `src-tauri/src/lsp_probe.rs` | 350 | 安装状态探测（PATH 补齐、`PATHEXT`、`.ps1`、rust-analyzer 的 shim 复核）与一键安装 | 2 |
| `src-tauri/src/lsp_detect.rs` | 310 | 按 `rootMarkers` 在工程里找语言服务的真根：向上越界即停、向下 2 层、结果缓存 60 秒 | 1 |
| `src-tauri/src/ai_commit.rs` | 872 | AI 提交说明：`ai-commit.json` 读写、三家协议请求计划、敏感路径拦截、可取消的在飞请求；所有请求共用一个连接池 | 5 |
| `src-tauri/src/settings.rs` | 511 | `settings.json` 读写，全在系统配置目录：读缺字段按 `Default` 补，写是 RFC 7396 按字段合并（不整份覆盖别的窗口的设置），落盘走 `write_atomic` | 2 |
| `src-tauri/src/history.rs` | 191 | `history.json` 读写：上次开的项目、最近项目/分支/提交说明；首次从旧 `settings.json` 迁移，坏文件退回空表 | 2 |
| `src-tauri/src/tray.rs` | 135 | 托盘图标与两项菜单、点关闭是收起还是先存盘再退 | 2 |
| `src-tauri/src/sys.rs` | 199 | kernel32 取本进程工作集与物理内存总量；`which_program`（Windows 要带扩展名候选）、`capture_text`（`java -version` 打在 stderr）、`hide_console`、`write_atomic` 几个共用小工具 | 1 |
| `src-tauri/src/browser/mod.rs` | 980 | 内置浏览器的宿主侧：`State` 那张表（页面、授权租约、待回收视图）、命名管道 broker、八条 `browser_panel_*` 与 `PanelCommand` | 8 |
| `src-tauri/src/browser/surface.rs` | 562 | wry 子 webview 的建 / 显 / 关与 CDP 通道；COM 只在 UI 线程碰，`ui()` 超时之后 closure 不再派发 | — |
| `src-tauri/src/browser/tools.rs` | 778 | AI 那一侧的 `forge_browser` 工具派发：票据复查、快照与动作、页面归属与地址策略 | — |
| `src-tauri/src/browser/picker.rs` | 601 | 元素选取：隔离世界里画框、样式预览与还原、选取自己那条队列 | — |
| `src-tauri/src/browser/annotation.rs` | 290 | 批注浮层的原生视图与请求回路（浮层文案在 `annotation.html` 自带那份三语言表里） | — |
| `src-tauri/src/browser/emulation.rs` | 218 | 设备仿真参数、视口矩形与 `present` 的尺寸判定 | — |
| `src-tauri/src/browser/launch.rs` | 74 | companion 的路径解析（装机那套带 target triple 的名字与 cargo 的裸名两档）与 endpoint/token 注入 | — |
| `src-tauri/crates/forge-browser/` | 580 | companion 那一侧：协议与参数校验、URL 地址策略、命名管道 transport、MCP 工具表 | — |
| `src-tauri/src/error.rs` | 24 | 错误出口：只拼「稳定代码 + 原文」 | — |
| `src-tauri/src/lib.rs` | 378 | 模块声明、插件注册、托管状态、`invoke_handler`、窗口关闭事件、setup 里的 `browser::init` 与退出清理里的 `browser::shutdown` | — |

## 全局约定

文件读写不走 `@tauri-apps/plugin-fs`。插件的 scope 模型是给 webview 受限访问用的：声明一批允许读的根，
越界即拒。编辑器的本职是打开本机任意代码目录，`fs` 那批命令接受任何绝对路径，套 scope 的结果是换个工程
就拒。调用方只有本应用自己的前端，封装在 `src/lib/fs.ts`，没有第三方页面，所以直接写 `#[tauri::command]`。
装着的插件只有 `tauri-plugin-dialog`，给「打开文件夹」用（`src/App.tsx` 引它的 `open`）。

git 一律参数数组 spawn，不经过 shell（`run_git`）。`Command::new("git")` 后面接 `.args([...])`，分支名、
修订号、路径都是数组元素，拼不出一条命令行，所以没有命令注入这条路。每条都带
`-C <root> -c core.quotepath=false --no-optional-locks`：前者不依赖进程当前目录，中间那条让中文文件名原样
输出而不是八进制转义，最后一条不去抢 git 自己的锁。字符集校验（`valid_branch_name`、`valid_rev`、
`valid_relative`）是第二层，主要挡「以 `-` 开头被当成选项」和 `..` 越界，不承担注入防线。
反例是 `proc_start`，它走 shell（Windows 用 `%COMSPEC% /D /C`），跑的是用户自己写的一行命令，
语义就是命令行。

参数名前端 camelCase，Tauri 映射到 Rust 的 snake_case（`git.ts` 传 `revision`、`fs.ts` 传 `lineEnding`
对 `line_ending`）。返回方向靠 serde：结构体一律 `#[serde(rename_all = "camelCase")]`，前端 TS 里逐字段
镜像并写注释。

## 平台差异的切法

只有 `fs` 一处做整文件级切换：`src-tauri/src/fs/mod.rs` 里 `#[cfg(windows)] mod windows;` /
`#[cfg(not(windows))] mod unix;`，再 `use windows as platform`。业务代码只叫 `platform::flags` /
`platform::reveal` / `platform::open_external` 三个名字。Windows 侧是 kernel32 / shell32 的
`extern "system"` 裸声明，没有另引 crate。unix 侧退化成文件名以点开头算隐藏，Linux 没有通用的
「在文件管理器里选中该项」，所以打开父目录。`sys.rs` 用同样手法，但两个实现写在同一文件的两个 `mod win`
里，非 Windows 直接返回 `(0, 0)`，前端据此不画那行读数。`term.rs` / `proc.rs` 的差异小，用 `cfg!` 分支。

## 权限：capabilities/default.json

`src-tauri/capabilities/default.json` 只放行 `windows: ["main"]`，权限 8 条：`core:default`，加上
`core:window:allow-close` / `allow-minimize` / `allow-toggle-maximize` / `allow-start-dragging` /
`allow-is-maximized` / `allow-set-focus`，最后是 `dialog:default`。前六条全是自定义标题栏用的：窗口
`"decorations": false`（`tauri.conf.json`），最小化、最大化、拖动、关闭都得前端自己发
（`src/lib/window.ts` 的 `useWindowControls`）。没有给文件系统、shell、http 任何权限，所有越过 webview
的动作都走那 92 条命令，能力清单因此可以只留窗口控制。

## asset 协议的授权

markdown 正文里的本地图片要经 asset 协议进 `<img>`，直接写 `file://` 会被 CSP 挡，所以 `Cargo.toml` 给
tauri 打开了 `protocol-asset` 特性。`tauri.conf.json` 里 scope 的 `allow` 是空数组：工程目录是用户运行时
选的，不能预先写死。开工作区时前端调 `fs_allow_asset(root)`，它把该目录连整棵子树加进允许名单，递归是真
需要的，文档引用的子目录图片否则进不来。授权不落盘，重启即失效，所以每次打开工作区都要重授一遍
（`src/App.tsx` 里那个 effect）。`requireLiteralLeadingDot: false` 是配套的：不加这条，点开头的目录与文件
不在递归授权的覆盖范围内，要逐段字面列出才认。

## 事件

命名一律 `<域>://<动作>`，九条：`fs://change`（载荷只有 `paths`）、`term://output` 与 `term://exit`、
`proc://output` 与 `proc://exit`、`lsp://message`（`{id, body}`，`body` 是去掉帧头之后的 JSON 文本）、
`lsp://log`（`{id, text}`，server 写到 stderr 的按行转发）、`lsp://exit`（`{id, code}`）、`app://flush`
（退出前让前端把脏文档写完）。字节类载荷都是 base64 字符串，
理由是 JSON 会把半个 UTF-8 序列拆坏；`lsp://message` 是唯一带 JSON 文本的那条，因为它整条就是 JSON-RPC。
事件是广播给所有窗口的，所以语言服务的会话身份里带了窗口名，前端只采自己那一份。git 命令不发事件：前端在写操作后自己 `git.refresh()`，磁盘侧统一靠
`fs://change` 那一条。`app://flush` 之后前端存完盘调 `app_exit`；`FLUSH_TIMEOUT` 是 5 秒，到点没回音，
看门狗自己 `app.exit(0)`。

## 状态与生命周期

托管状态只有两份：`WatchSlot`（装着当前 `RecommendedWatcher`，丢掉句柄就等于停了监听那条线程）和
`TrayMenu`（换菜单文字用）。终端会话表、进程表和语言服务会话表用 `OnceLock<Mutex<HashMap<..>>>` 的进程级全局。
终端与进程按 `term-<n>` / `proc-<n>` 这类自增 id 定位会话；语言服务的键由 `<窗口>::<server 键>::<根>` 三段拼接而成，
同一窗口对同一根第二次启动直接返回原 id，启动过程中另有一张「正在启动」表加条件变量，让并发请求等待结果而不是重复
spawn。语言服务另有一张失败记录表：启动失败记录一次，下次允许重试的时刻按 `5s*2^n`（上限 300 秒）推后，连续超过 2
次后不再自动尝试，界面侧的「重试」调用 `lsp_retry` 清除记录。回收不使用定时器：每次 `lsp_start` 之前扫描一遍，空闲超过
`idleTimeoutMin` 的先回收，总数仍达到 `maxSessions` 时摘除最久未使用的一条。两处 `last_used_ms` 由 `lsp_write` 更新。
页面重载时上一条 shell 的 `term_close` 往往来不及送达，所以
新页面一开头先调 `term_reap`，把上一回剩下的会话收掉；语言服务同理调 `lsp_reap`。锁中毒一律 `unwrap_or_else(|p| p.into_inner())`
继续走，一侧线程 panic 不把终端和进程表整体卡住。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src-tauri/src/lib.rs` | 模块声明 `:1-13`、插件注册与 `WatchSlot` 托管 `:19-20`、关闭事件 `:26-30`、`invoke_handler` 全表 `:31-121`、两条搜索命令的注册 `:43-44`、语言服务那 12 条的注册 `:104-115` |
| `src-tauri/src/fs/mod.rs` | `io_err` `:9-11`、平台模块切换 `:13-27`、`EDITOR_CEILING` 8 MiB `:30`、读写命令 `:194-264`、asset 授权 `:372-377`、单测 `:385-534` |
| `src-tauri/src/fs/search.rs` | 扫描阈值常量 `:15-32`、剪掉的目录名 `:34-47`（含 `dist`）、名字打分四档 `:79-99`、`find_files` `:196-208`、`TextOptions` `:211-224`、`search_text` `:538-550`、单测 `:552-798`、`scan_prunes_build_directories` `:705-727` |
| `src-tauri/src/fs/windows.rs` | `extern "system"` 声明 `:12-29`、`ShellExecuteW` 的使用与失败码约定 `:76-94` |
| `src-tauri/src/fs/unix.rs` | 点开头算隐藏 `:17`、Linux 打开父目录 `:32-38` |
| `src-tauri/src/git/mod.rs` | `run_git` 与三条前缀参数 `:152-166`、`valid_branch_name` `:702-711`、`valid_rev` `:1340-1347`、`valid_relative` `:1506-1512` |
| `src-tauri/src/proc.rs` | `shell_command` 的 `%COMSPEC% /D /C` 与 `/bin/sh -c` `:71-78` |
| `src-tauri/src/watch.rs` | `SETTLE` 150ms `:19`、`BATCH_CAP` 256 `:22`、`WatchSlot` `:33-36`、`fs_watch_start` `:83-144`、攒批转发线程 `:173` |
| `src-tauri/src/term.rs` | 会话表 `:23-26`、锁中毒处理 `:29-31`、base64 载荷的理由 `:33-39`、reader 线程发两个事件 `:220-248`、`term_reap` `:293-299` |
| `src-tauri/src/tray.rs` | `FLUSHING` `:23`、`FLUSH_TIMEOUT` 5 秒 `:26`、`TrayMenu` `:29-32`、托盘建起来并 `manage` `:35-65`、`request_flush` 与看门狗 `:106-119` |
| `src-tauri/src/settings.rs` | `Settings` 结构与默认值 `:120-164`、`settings_path` `:166-172`、读写命令 `:185-200`（`lsp` 段已搬到 `lsp.json`，旧文件里那一节读到时忽略） |
| `src-tauri/src/sys.rs` | `write_atomic` 的 tmp+rename `:25-33`、`which` `:51`、windows 侧 `mod win` `:73-139`、非 Windows 返回 `(0, 0)` `:141-146` |
| `src-tauri/capabilities/default.json` | `windows` `:5`、8 条权限 `:6-15` |
| `src-tauri/tauri.conf.json` | 窗口 `decorations: false` `:22`、`assetProtocol` `:28-34` |
| `src-tauri/Cargo.toml` | `crate-type` 与那句注释 `:8-11`、`protocol-asset` 特性 `:18` |
| `src/lib/fs.ts` | `FsEntry` 等结构逐字段镜像 `:6-54`、`lineEnding` 的传法 `:67`、搜索两个封装 `:226-233`、`errorText` `:236-239` |
| `src/lib/window.ts` | `setTrayLabels` `:14-16`、`useWindowControls` 与纯浏览器容错 `:29-56`、导出的 `windowLabel` 给语言服务会话身份用 |
| `src/lib/lsp.ts` | 十二条命令的薄封装，纯 Tauri 壳、不引 monaco |
| `src/lib/lspClient.ts` | 会话键的三段拼接 `:74-116`、`lspStart` 的传法 `:144`、`initialize` 握手 `:167`、`startServer` `:220`、`reconcileLsp` `:768`、文档同步 `:858`、退出时收会话 `:900` |
| `src/hooks/useLspConfig.tsx` | 配置的唯一持有处、探测缓存与一份会话轮询：起手读一份，探测回的配置不再写回磁盘 |
| `src/hooks/useLspSessions.ts` | 会话状态的唯一轮询：3 秒一次，一次请求落定再排下一次，拉失败留住上一轮数据；底部状态条与设置页共用 |
| `src/main.tsx` | 起手调 `termReap` `:20-21`、`lspReap` `:22-23`、两份配置并读 `:16` |
| `src/App.tsx` | `open` 来自 plugin-dialog `:3`、`allowAssetDir` 的 effect `:423-425`、`app://flush` 的监听 `:448-454`、reconcile 的挂点 `:296` |
| `src/components/SearchEverywhere.tsx` | 调 `findFiles` `:136`、调 `searchText` `:150` |
| `src/components/FindPane.tsx` | 不发查询，按 `path` 聚合交过来的命中 `:44-52` |
