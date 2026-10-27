# 全局设置

一份 `settings.json` 管所有偏好。没有项目级设置。主题、语言、工作区与各栏开关只从这份文件来，旧值不迁移。
应用级快捷键覆盖、AI 会话草稿与发送历史、AI 侧栏视图偏好存在 WebView 本地存储，不进设置文件，
换了 WebView 源就看不到。另有两份文件各管一段：语言服务的配置存 `lsp.json`（默认值写在后端种子里，
这一栏的界面与落盘口径见 [../../plans/lsp-language-servers/](../../plans/lsp-language-servers/README.md)），
用户做过的流水存 `history.json`（见下）。三份文件同目录，命令都列在 [../../backend/commands.md](../../backend/commands.md)。

## 位置与读写

路径是系统配置目录下的 `settings.json`（`SETTINGS_FILE` 接 `app_config_dir()`）。Windows 上即
`%APPDATA%\app.forge.desktop\settings.json`，identifier 在 `src-tauri/tauri.conf.json`。命令只有两条：
`settings_load` 和 `settings_save`。写回时 `serde_json::to_string_pretty` 整份格式化，父目录不存在就
`create_dir_all` 补上。TS 侧的封装是 `loadSettings` 和 `saveSettings`：没有 Tauri 注入（纯浏览器跑前端）时
读退回默认值、写忽略失败，界面照常可用。

## 结构与默认值

Rust 侧的默认值在各结构体的 `Default`，前端那份镜像是 `DEFAULT_SETTINGS`，两边必须一致：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `theme` | `"system"` | `light` / `dark` / `system` |
| `language` | `""` | 空串跟随浏览器语言（`resolveLang` 读 `navigator.language`），显式值只有 `zh` / `en` |
| `closeBehavior` | `"quit"` | `quit` 退应用，`tray` 收进托盘（`../tray-lifecycle/`） |
| `editor.fontSize` | `13` | px，只给编辑器。两个控制台写死 12 |
| `editor.tabSize` | `2` | 界面只给 2 / 4 / 8 |
| `editor.minimap` | `true` | |
| `editor.keymap` | `"default"` | `default` / `idea` / `eclipse`，见 `../code-editor/` |
| `editor.savePolicy` | `"blur"` | 只有 `manual` / `blur` 两档，没有第三档 |
| `editor.saveOnExit` | `true` | 布尔，界面上和 `savePolicy` 是并排的两行 |
| `terminal.shell` | `""` | 空串用 `shell_probe` 排在第一的那条，见 `../terminal/` |
| `commit.showOnDoubleClick` / `commit.commitAllWhenNothingStaged` | `"preview"` / `true` | 由提交窗口头部的齿轮改 |
| `branches.actionsInSearch` / `showRecent` / `showTags` / `groupByDirectory` / `onSingleClick` / `favorites` | `true` / `true` / `true` / `true` / `"none"` / `[]` | 由分支弹层和日志分支面板的齿轮改 |
| `updates.autoDownload` / `updates.autoPromptInstall` / `updates.proxyEnabled` / `updates.proxyUrl` | `false` / `true` / `false` / `"https://gh-proxy.com/"` | 应用内更新与镜像加速，由「关于」栏改；行为见 `../release-update/` |

设置页左栏依次是 通用 / 编辑器 / 快捷键 / 终端 / 语言服务 / AI 提交 / AI 编程助手 / 模型供应商 / Skills / MCP / Hooks / 关于。
后五栏只在通用里的 AI 总开关打开后出现。`commit` 与 `branches` 两组存在同一份文件里，但修改它们的是
提交窗口的齿轮和分支弹层、日志分支面板的齿轮，不在这十二栏内。「关于」栏同时显示当前版本与手动检查更新，
修改的就是 `updates` 这一组。语言服务那一栏修改的不是 `settings.json`，
整份写回 `lsp.json`：一项一卡，左侧第一行是这门语言的显示名加档位下拉，第二行以「语言服务」标注那个进程的名字与参数
（两个名字不是一回事：C# 对应 `csharp-ls`，PHP 对应 `intelephense`，`typescript` 这一项跑的是
`typescript-language-server`，混着写会让人以为列表里多了几个看不懂的语言）。语言名不另存一份表，
按 `languages` 里的 Monaco 标识符取 `monacoEnv.languageLabel`，与状态栏显示的是同一个名字；一个服务管多种语言时并列。
右侧依次为会话状态、安装状态、动作按钮、编辑。
动作按钮按状态给一种：本机未安装只给「安装」；已安装、启用外部档、当前项目尚未启动，给「启动」；
已有会话则换成「重启」。未安装的项不提供「外部 LSP」选项，只给安装按钮和一句说明；安装命令原文只在确认弹窗中显示，
并写明该操作会修改本机环境。路径、参数、标志文件、握手超时、`initializationOptions` 都在编辑弹窗中修改，
JSON 非法或未写成对象时不允许保存。栏顶一条汇总，标题行右侧是重新探测，进入该栏自动探测一次。
行序按安装状态排列：已安装的在前，未安装的次之，未探测的在后。会话状态与底部状态条读取同一份轮询结果。
「启动」走 `lspClient.wakeLsp`：先向后端确认该语言的项目根，再按会话的完整路径启动进程、完成握手、同步文档。
不走这条路也可以拉起进程，但那条会话不在客户端的会话表内，既不会收到 `didOpen`，也不会被空闲回收，
会留下无人管理的进程。这条路返回的是结构化结果，不只是「成功／失败」：在项目内找不到该语言的标志文件时，
回执写明检索的是哪个目录、找的是哪几个标志文件；进程无法启动或握手未完成时，回执直接是后端返回的原文；
未打开项目时该按钮置灰。
卡片不提供独立的「停止」按钮：将档位改回关闭才是真正的停用，仅停止进程而配置未变时，下一次对档会按原配置重新启动。

## 报错与日志的复制

语言服务的失败信息有三处，三处都完整显示并可直接复制：状态条弹层里每条会话的失败原因（原先按宽度截断，
只剩悬停可见，等于无法取用，现改为整段换行并附复制按钮）、设置页卡片底部的失败回执（安装输出尾部、
启动失败原因，同样附复制按钮）、以及卡片上的「日志」弹窗。
翻译不能把上游的错误吞成一句通用文案：后端一句错误是「错误码 + 分段参数」拼起来的，卡片先按错误码取对应译文，
再把原文的码与参数一并附在括号里；本来就是一句系统报错、无码可译的那些只留原文。
「未在项目……中找到该语言的标志文件」这类通用描述只在确实没有上游错误可取时才作为兜底出现，
后端一旦回过具体原因，卡片显示的就是那一句。
日志弹窗内容是这些进程写到标准错误的输出：后端按行发 `lsp://log`，前端按项保留最近 200 行，
进程退出时补一行退出码，卡片据此决定「日志」按钮是否出现。上限按项计算，不区分会话，
因为需要复制的是「该项服务最近报告了什么」。有一类输出早于 `lsp_start` 返回（进程启动后立即崩溃的情况），
此时前端尚无法确定会话所属项，这些行先按会话 id 暂存，确认之后再并入，不会丢失；事件订阅也在拉起进程之前挂好，
否则第一次启动写入的输出无处暂存。
弹窗内可整段选中，「复制全部」一次取走，「清空」将该项归零，以便下一次启动只查看新的输出。
安装确认弹窗中的命令行同样设为单击整段选中。

## 解析失败退回整份默认值

`read()` 把「拿不到配置目录、读不出字符串、JSON 解析失败」串成一条链，任何一步失败就
`unwrap_or_default()`。退回的是整份默认值，不是坏掉的那一项，只有整份读不出来才走这条。单个字段缺了由
结构体上的 `#[serde(default)]` 逐字段补，改结构不用迁移旧文件。前端再套一层 `merge()` 做同样的逐层补齐，
并且 `savePolicy` 只认 `manual`，文件里写了别的值一律退回 `blur`。

手动编辑该文件时，JSON 写错不再等同于丢失全部偏好：**读宽容，写严格**。合并保存走的是另一条
`read_document()`，文件读不出来或 JSON 坏了就直接报错，绝不拿空对象当底稿。于是界面仍然显示成默认值
（读的那条链照旧宽容），但任何一次保存都会失败并把错误抛回前端，损坏的旧内容原样留在盘上——
以前是应用一开、那次整份写回就把它覆盖掉了。

## 改动即时生效，按字段合并落盘

`patch()` 只把**改动的那几个字段**发给 `settings_save`，后端用 JSON Merge Patch（RFC 7396，
`json_patch::merge`）合并进文件里现有的内容：只覆盖出现过的键，其余原样保留，连结构体不认识的旧段落
（例如搬去 `lsp.json` 之前残留的 `lsp`）也不删。命令返回合并后的全量设置，前端拿它覆盖本地状态，
所以每个窗口最终都跟文件一致，而不是各留一份真相。

为什么不整份写回：dev 与安装版（或两个窗口）共用同一个 `settings.json`，而每个窗口都把自己内存里那份
`Settings` 全量落盘。旧副本一保存就把新设置连别的字段一起抹回旧值——AI 助手开关反复「丢失」就是这么来的。
按字段合并之后，「改一个字段」只可能影响那一个字段。

落盘仍然原子（`.tmp` 再改名），进程内用 `SETTINGS_LOCK` 把读-合并-写串起来；跨进程不靠这把锁，
靠的就是上面那条只写改动项的规则。没有「应用」按钮，没有草稿态；挂载时也不再写盘——一开窗就重写一遍
文件没有任何意义。

关闭 AI 助手仍然要先把在跑的 CLI 停掉并等它们退出（`lifecycle_lock` 与启动路径共用同一把锁），
但只在**这次合并把它从开变成关**时才停：否则一次无关的保存（改个字号）也会把正在跑的任务全杀掉。

主题：`resolveTheme` 把模式算成实际深浅色写到 `data-theme`，`system` 那档额外挂 `matchMedia` 监听。
`applied` 的初值跟着 DOM 而不是跟着模式。属性还没落地时子组件取色读到的就是浅色，状态先如实记成浅色，
落地后那次 setState 再把取色副作用跑一遍；Monaco 和 xterm 只认十六进制，靠这一步拿到令牌值。

语言：`SettingsProvider` 把语言递给 `I18nProvider`，界面即时切。monaco 在模块求值时就固化自己的文案，所以
入口先执行 `loadSettings()`，再决定是否加载中文语言表，之后才 import 界面。切换语言需要重新打开窗口才会作用到编辑器，
设置页 `language.note` 说明的即是这一点。

## 历史记录住在 history.json

用户做过的流水单独一份 `history.json`，与 `settings.json` 同目录。四项：`lastFolder`（上次打开的文件夹，
启动时据此恢复工作区）、`recentFolders`（工程下拉的最近项目）、`recentBranches`（分支弹层的「最近」节）、
`commitMessages`（提交框的历史菜单）。分开的理由是写入频率：这四项每次开项目、每次切分支、每次提交都要
整份重写，而主题、字号那类偏好几个月不动一次，混在一份文件里就是让设置文件天天被整份写一遍。

那三份列表各留 8 条（`RECENT_CAP`）。新的在前：写进去之前先按值去重，重复的那条挪到最前，超出上限的尾部
截掉，这一段逻辑在 `withRemembered`，由 `HistoryProvider` 的 `remember` 调用。

写入点：打开文件夹和工程下拉选中记 `recentFolders`；切分支成功、新建分支成功记 `recentBranches`，失败的
签出不进列表；提交成功记 `commitMessages`。`checkoutRev` 不记，它可能签出标签或任意修订号，记进「最近」也
没有对应的分支可切。`lastFolder` 跟着 `workspaceRoot` 写。

读坏的 `history.json` 退回空表而不是半份：记的是流水，丢了顶多重新打开一次项目。文件不在时从同目录旧
`settings.json` 里那四项迁移一次并立刻落盘，之后那份设置里残留的四个键由 `Settings` 读到时忽略。

## 快捷键

应用级快捷键只收挂在窗口上的那几条，注册表在 `src/lib/shortcuts.ts`，共 8 条：
`Mod+Shift+F` 在工作区里查找、`Mod+Shift+N` 转到文件、`Mod+S` 保存、`Shift+F10` 运行、
`Mod+F5` 重跑、`Mod+F2` 停止、`Alt+Shift+F10` 选择运行配置、`Alt+4` 开关运行工具窗口。
`Mod` 指平台主修饰键（macOS 是 Cmd，其余是 Ctrl）。Monaco 内的键位归 `lib/keymap.ts`，
目录树上的焦点相关键不进这张表。

覆盖写在 WebView 本地存储的 `forge:shortcuts:v1`，值必须是 `parseCombo` 认得的规范串，读的时候认不出就丢。
设置页一列一条：点「修改」后下一次按键就是新组合。捕获挂在 window 捕获阶段并吞掉默认行为，
只按到修饰键时继续等主键，Esc 取消。新组合和别的动作撞了就不落盘，报出对方的展示名。
判等走解析后的签名，`Ctrl+S` / `Cmd+S` 这类别名写法与默认的 `Mod+S` 算同一条。
每条可单独还原默认，也可以一次清空全部覆盖。保存后在进程内广播，挂键位的 effect 立刻按新值重挂，不用重启。

## Hooks

面板按 Claude / Codex 切换，只管理用户级配置。Claude 修改 `~/.claude/settings.json` 的 `hooks` 键；
Codex 修改 `$CODEX_HOME/hooks.json`（默认 `~/.codex/hooks.json`），不把规则写入 `config.toml`。
路径分别遵循现有 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 解析，界面展示实际文件路径。
两种文件均使用 `{ "hooks": { 事件名: [{ matcher, hooks: [{ type, command, timeout }] }] } }`。

Claude 保留面板现有 8 个可编辑事件：PreToolUse、PostToolUse、UserPromptSubmit、Notification、Stop、
SubagentStop、SessionStart、PreCompact。Codex 0.164.0 已用隔离 CLI 验证 14 个磁盘事件：
PreModelRequest、PostModelRequest、PreToolUse、PermissionRequest、PostToolUse、PreCompact、PostCompact、
SessionStart、SessionEnd、UserPromptSubmit、SubagentStart、SubagentStop、Stop、Interrupt。

只编辑 command 类型。其它类型、未支持事件和未知字段保留，并可在只读原文中查看。
每条命令支持 matcher、command、timeout，Codex 另可编辑 async；SessionEnd 仅同步，
SessionEnd / Interrupt 超时不超过 3 秒。不使用 matcher 的 Codex 事件会禁用该输入框。
超时为非负整数秒，空值删除字段；Codex 将 0 归一为 1 秒，普通事件省略时默认 600 秒，
SessionEnd / Interrupt 默认 1 秒。新增规则的空命令或非法超时阻止保存。
删除最后一条 handler 时删除对应规则，事件空时移除该事件。

读写走 `ai_cli_hooks_read(provider)` / `ai_cli_hooks_save(provider, hooks, expected)`，返回 `{path, hooks}`。
保存时比较读取基线，发现外部修改则报错；重读文件保留其它设置，只替换 `hooks` 键，空对象移除该键。
缺文件视为空配置，已有文件的坏 JSON、空文件或错误树结构拒绝覆盖；写前备份，落盘用原子写入。
切换 CLI、重新读取或离开设置页时保护未保存内容；保存期间禁止编辑和导航，旧响应不覆盖新页面。

Codex 加载状态独立走 `ai_cli_codex_hooks_status`，只调用原生 `hooks/list`，不创建线程或调用模型。
展示原生解析错误、警告、启停和信任状态；查询失败不影响已保存结果。旧 CLI 不提供该接口时显示查询失败。
新增规则为 untrusted，修改已信任规则会变为 modified；用户需在 Codex 原生 `/hooks` 中确认信任。
原生启停与信任保存在 config.toml 的 `hooks.state`，本面板只读展示，不写入伪造的 hooks.json enabled 字段。
`hooks/list` 会重读磁盘，但活跃线程的执行刷新时机尚未验证，保存提示不承诺立即生效。

## 入口与版面

设置页走编辑区的共用页签栏（照 VSCode），不是盖住窗口的弹框；整页面板都挂在这条栏上，设置页是其中一页。
主工具栏右侧的齿轮按钮调 `openSettingsTab()`：已经开着就跳到那一页，否则新开一页。标签由 `tabCatalog` 追加，
图标是 13px 的 Settings。关掉这颗标签就是 `setSettingsTab(false)`。

版面：左 nav 176px、一行一个模块，右列头部 44px，标签列 150px，数字输入框 92×28，下拉最小 148px，
shell 一行最宽 420px。字号一行是 `number` 输入，`min=10 max=28`，值超出范围时收敛到边界，清空后回退为 13。
「是 / 否」两档的下拉在写回文件时转换为布尔值。

## 关闭按钮读的是磁盘上那份

点关闭那条路读的是磁盘文件，不是 React state：`handle_close` 第一步就调 `settings::read`。Rust 侧拿不到
前端内存里的值，能依赖的只有那份文件，而「任何改动立刻整份写回」正好保证了它和界面同步。细节见
`../tray-lifecycle/`。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src-tauri/src/settings.rs` | `SETTINGS_FILE` `:9`、五个结构体与 `Default` `:11-148`、`settings_path` `:151-156`、`read` 的清零链 `:160-166`、`settings_load` 与 `settings_save` `:169-184`（写盘走 `sys::write_atomic`）；历史四项已搬去 `history.json`，旧文件里那些键读到时忽略 |
| `src-tauri/src/history.rs` | `HISTORY_FILE` `:15`、`History` `:25-33`、旧 `settings.json` 四项迁移 `:38-63`、`load_in` `:71-81`、`save_in` `:84-89`、`read` `:92-97`、两条命令 `:101-117` |
| `src-tauri/src/lsp_config.rs` | 语言服务那份文件：结构 `:18-58`、种子 `:105-324`、归一化 `:354` 与 `:384`、旧 `settings.json` 的 `lsp` 段迁移 `:427`、读写 `:463` 与 `:485` |
| `src/lib/settings.ts` | `DEFAULT_SETTINGS`、`merge` 与 `savePolicy` 白名单、`loadSettings` 与 `saveSettings` |
| `src/lib/history.ts` | `History` 与 `DEFAULT_HISTORY`、`RECENT_CAP` 8、`withRemembered`、`merge`、`loadHistory` 与 `saveHistory` |
| `src/lib/lspConfig.ts` | 语言服务那栏的类型与读写封装；`modesFor` 决定每行给几档，`programOf` 让手填路径盖过命令名 |
| `src/hooks/useSettings.tsx` | `patch` `:36-38`、整份落盘的 effect `:41-43`、`applied` 初值 `:49-51`、主题与 `matchMedia` `:52-63`、`I18nProvider` `:65-74` |
| `src/hooks/useHistory.tsx` | `RecentKey`、`patch`、`remember`（走 `withRemembered`）、整份落盘的 effect、`HistoryProvider` |
| `src/hooks/useLspConfig.tsx` | 配置持有、探测缓存与一份会话轮询（探测回来的那份不回写） |
| `src/hooks/useLspSessions.ts` | 会话状态的唯一轮询：3 秒、落定之后再排下一次、读不到留住上一轮 |
| `src/components/LspDialogs.tsx` | 编辑弹窗 `:42`（标题行 `语言 · 服务名` `:129`、`lsp.dialog.program.hint` `:166`、`initOptions` 校验）、安装确认弹窗 `:287`（命令原文只在这里）、输出日志弹窗 `:343`（选中全部与清空） |
| `src/components/CopyButton.tsx` | 一小颗复制开关，报错行与日志行共用 |
| `src/components/SettingsPage.tsx` | 模块常量与 AI 模块集合 `:78-81`、终端光标与页签布局标签表 `:98-108`、各栏候选值与语言服务档位标签 `:109-168`、`probeRank` `:174` 与 `runtimeOf` `:190`、`Props` 里的项目根与启动回调 `:206-214`、日志订阅 `:315-322`、进栏自动探测 `:332-339`、`explain` 解码上游错误 `:347`、`runInstall` `:360-379`、重启 `:382-394`、`wakeNote` 把结构化结果写成卡片回执 `:407-418`、启动 `:420-434`、`lspRows` `:437-439`、`shellProbe` `:451-463`、标题行的重新探测 `:578-595`、「语言服务」栏 `:1048-1214`、卡片标题取语言显示名 `:1082`、「语言服务」前缀 `:1096`、安装按钮 `:1127-1145`、启动／重启按钮 `:1147-1174`、「日志」按钮 `:1176-1185`、带复制的回执两行 `:1197-1208`、快捷键栏接线 `:897`、Hooks 栏接线 `:1221`、三个弹窗的接线 `:1363-1399` |
| `src/lib/shortcuts.ts` | 8 条注册表 `:21-30`、本地存储键与覆盖读写 `:32-59`、进程内广播 `:61-70`、`parseCombo` `:91`、`comboFromEvent` `:129` 与 `comboMatchesEvent` `:146`、`comboOwner` 与 `comboSignature` `:170` / `:181` |
| `src/components/ShortcutSettingsPanel.tsx` | 捕获 effect `:39-66`（window 捕获、Esc 取消、撞键不落盘）、单条还原与全部还原 `:68-79`、列表 `:84-120` |
| `src/components/HooksSettingsPanel.tsx` | `CLAUDE_EVENTS` / `CODEX_EVENTS`、原生树编辑、CLI 切换与未保存保护、加载与信任状态 |
| `src-tauri/src/ai_cli/settings.rs` | `hooks_path`、`read_hooks_at` / `save_hooks_at`、校验与外部修改检查、三条 Hooks 命令 |
| `src/lib/monacoEnv.ts` | 语言显示名的来源：`LANGUAGE_LABELS` `:87-122`、`languageLabel` `:125`、`languageNames` `:135`（一项服务管多种语言时并列）；这个模块不许 import monaco-editor |
| `src/App.tsx` | `useHistory` `:373`、`workspaceRoot` 初值 `:386-390`、`lastFolder` 写回 `:1173`、`recentFolders` 写入 `:2237` 与下拉读取 `:4840`、`recentBranches` `:3682` / `:4311`、`commitMessages` `:4569`、快捷键覆盖订阅 `:1934`、各键位匹配 `:1988-2052` / `:2557` |
| `src/lib/lspClient.ts` | 会话表与协议客户端；`starting` 键锁 `:220`、`startServer` `:223` 与 `launchSession` `:235` 把失败原因原样回传、`WakeResult` `:994` 与 `wakeLsp` `:1011` 是「启动」按钮的执行路径（确认项目根 → 启动进程 → 握手 → 同步文档，每一步失败都带 detail）、输出日志的保留与并入见 `appendLog` `:338` / `adoptLogs` / `lspLogs` `:362` / `watchLspLogs` / `clearLspLogs` `:375` |
| `src/main.tsx` | 先并读三份配置（设置 / 历史 / 语言服务）、再装语言表、后 import 界面 `:14-38` |
| `src/i18n/index.tsx` | `resolveLang` 跟随浏览器 `:12-15` |
| `src/styles.css` | 设置页版面、语言服务一栏（一项一卡、「语言服务」前缀、动作按钮、三个弹窗、日志块与复制按钮）、状态条那一格与探测徽章、快捷键行与捕获提示、Hooks 事件块 |
| `src-tauri/src/tray.rs` | 关闭那条路重读磁盘 `:80` |
| `src-tauri/tauri.conf.json` | identifier `:5` |
