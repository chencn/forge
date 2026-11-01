# 外挂语言服务

语义能力有两个来源：CodeMirror 编辑器侧的基础语言支持，和这一层拉起的外部语言服务进程。同一门语言只能留一个
语义来源。这一份管进程、协议帧、配置与会话生命周期；编辑器适配见 `src/lib/cm/lsp.ts`，配置栏的界面见
[../settings/](../settings/)，底部状态条那一格见 [../shell-layout/](../shell-layout/)，十二条后端命令的参数与返回见
[../../backend/commands.md](../../backend/commands.md) 的「语言服务」一节。

## 为什么要有这一层

编辑器侧的基础语言支持只掌握当前文档，不能直接读取项目里的 `node_modules`、`@types`、`tsconfig.json` 和其它源文件。
命令行 `tsc --noEmit` 走项目本地的 TS 与真实 `node_modules`，编辑器侧却可能无法解析同一份 `import`。外部进程拥有
完整文件系统和项目索引，因此能补上跨文件语义；没有启用外部服务的语言仍只提供编辑器侧已有的高亮、括号和基础编辑行为。

独立进程有完整文件系统，能解析整个工程。代价是接了外部服务的语言必须关闭同类内置语义：两套 provider 并列时会
重复弹出 hover、重复提供补全或产生两份诊断。

## 档位：三态收敛成一个枚举

配置的键是 **server**，不是语言 id。`.ts` / `.tsx` / `.js` / `.jsx` 在编辑器里分属 `typescript` 和
`javascript` 两个语言 id，却共用一个 `typescript-language-server`；按语言 id 配置会出现「TypeScript 已启用、
JavaScript 未启用」这种无法成立的组合。挂到 server 上之后 Rust / Go / Python / Java 是 1:1，只有 TS 系是 1:2。

| mode | 内置语义 | 外挂 LSP |
| --- | --- | --- |
| `off` | 关 | 关，只剩语法高亮 |
| `builtin` | 开 | 关 |
| `lsp` | 关 | 开 |

`builtin` 只有 `typescript` 能取，这条由文件里的 `supportsBuiltin` 表达。其余 server 只有 `off` 与 `lsp` 两档。
把「开 LSP 就关内置」写成一条要靠人遵守的规则不够：两个布尔字段并存时非法组合存得下，手改文件、迁移写错、
缺字段补默认都能造出「两个都开」；三态枚举让这个状态存不下，读的地方只有一处。同理 `enabled` 字段已删，
它与 `mode = off` 表达同一件事，两个下拉并列时判断不出该改哪一个，可用性判断收敛成 `mode === "lsp"` 一处。

默认 `typescript` 为 `builtin`、其余 `off`，正好等于接入之前的现状，不迁移也不回归。

降级没有「悄悄换回内置」这一说：内置语义只在 `builtin` 档开着，切到 `lsp` 而服务起不来就只剩高亮，界面上给一条
未找到或启动失败的说明，客户端不改动档位。真正会改文件的只有探测那一步：把「启用外部档但本机没装」的那一项写回
`off`，单向，绝不自动启用。

## 配置：一份 `lsp.json`

语言服务的配置从 `settings.json` 拆出来单独成文件，落 `<app_config_dir>/lsp.json`，Windows 上即
`%APPDATA%\app.forge.desktop\lsp.json`。首次启动把种子表整个写进去，文件自己就是真相源，手改能看懂全貌。
默认表只在后端一处（`lsp_config.rs` 的种子），前端不再有语言服务的默认值。

- 旧 `settings.json` 里的 `lsp` 段只在生成 `lsp.json` 那一刻读一次，之后不再读；第二次启动不重复迁移。
- 写盘是原子的：同目录 `lsp.json.tmp` 再 rename（`sys.rs::write_atomic`），`settings_save` 共用这一条。
- 档位合法性与空字段兜底在 `normalize` / `clamp` 里做，读写两侧各过一遍；非法 `mode` 退回该 server 的种子档位，
  前端拿到的值已经是可用的。文件损坏同样回退为种子并补齐一份完整配置。
- 不存 `extensions`：扩展名到语言 id 的映射只在 `src/lib/editorEnv.ts`，两处存就会对不上。

字段：`mode`、`program`、`path`（空串表示用探测到的那条）、`args`（一行文本，拆分在后端）、`languages`
（编辑器语言 id）、`rootMarkers`、`installCommand`、`startupTimeoutMs`、`initOptions`、`supportsBuiltin`，
外加全局的 `maxSessions` 与 `idleTimeoutMin`。serde 一律 `rename_all = "camelCase"` 配 `#[serde(default)]`。
`program` 这类键名不参与 `rename_all` 的改写，所以 `rust-analyzer` 这种带连字符的键能原样落地。

种子 12 项（`sourcekit-lsp` 在非 Windows 才入，Windows 那侧 11 项）：

| server 键 | program | 缺省参数 | 管哪些语言 id | rootMarkers | 启动超时 |
| --- | --- | --- | --- | --- | --- |
| `typescript` | `typescript-language-server` | `--stdio` | typescript, javascript | `tsconfig.json` `jsconfig.json` `package.json` | 30s |
| `pyright` | `pyright-langserver` | `--stdio` | python | `pyproject.toml` `setup.py` `setup.cfg` `requirements.txt` `Pipfile` | 30s |
| `gopls` | `gopls` | 空 | go | `go.mod` `go.work` | 30s |
| `rust-analyzer` | `rust-analyzer` | 空 | rust | `Cargo.toml` | 30s |
| `clangd` | `clangd` | `--background-index` | c, cpp | `compile_commands.json` `CMakeLists.txt` `meson.build` | 30s |
| `csharp-ls` | `csharp-ls` | 空 | csharp | `*.csproj` `*.sln` `*.fsproj` | 30s |
| `jdtls` | `jdtls` | 空 | java | `pom.xml` `build.gradle` `build.gradle.kts` `settings.gradle.kts` | 120s |
| `kotlin-lsp` | `kotlin-language-server` | `--stdio` | kotlin | `build.gradle.kts` `*.kt` | 120s |
| `intelephense` | `intelephense` | `--stdio` | php | `composer.json` | 30s |
| `ruby-lsp` | `ruby-lsp` | `--stdio` | ruby | `Gemfile` `*.gemspec` | 30s |
| `lua-language-server` | `lua-language-server` | 空 | lua | `.luarc.json` `.luacheckrc` | 30s |
| `sourcekit-lsp` | `sourcekit-lsp` | 空 | swift | `Package.swift` `*.xcodeproj` | 30s |

JVM 那两个 120s。`maxSessions` 默认 5，`idleTimeoutMin` 默认 30。rust-analyzer 单进程实测 500MB 到 1GB，
那条上限是内存兜底。

## 进程通道与分帧

`lsp.rs` 独立成模块。没有改 `proc.rs` 的 stdin，也没有借 `term.rs`：`proc` 是单向跑一行、`term` 是 PTY、
这条是普通管道上的双向字节流，三者语义不同，合并会让三方都变复杂。

- stdin / stdout / stderr 全 `Stdio::piped()`，不是 PTY。PTY 会做 CR/LF 转换、回显、注入转义序列，
  把 `Content-Length` 帧冲烂。
- 帧是 `Content-Length: N\r\n\r\n` 加 N 字节 UTF-8 JSON。body 可以含换行，所以只能按头里的长度精确读 N 字节；
  长度按**字节**算，多字节字符不错位；body 里的 `\r\n\r\n` 不会被误判成新帧头。补头在后端做，字节长度在前端易算错。
- 三条事件：`lsp://message` 送帧、`lsp://log` 送 stderr 的按行输出、`lsp://exit` 送退出码。
  stderr 必须有人读，管道满了 server 会卡。
- 缓冲上限：读块 64 KiB、单条消息缓冲 16 MiB、内部 stderr 行 1 MiB、送给界面的单行 64 KiB。
- `parse_args` 按空白拆分，双引号里的整段算一个参数；只认双引号、不做反斜杠转义，路径里出现双引号的情形不存在，
  多一层转义规则只会让人猜不透。
- `.cmd` / `.bat` 经 `cmd /C` 起（npm 装的 CLI 是 `.cmd` 垫片）；停止走 `taskkill /F /T` 杀整棵树，
  因为语言服务常带子进程（rust-analyzer 起 rustc、gopls 起编译器）。

## 会话身份与生命周期

会话身份是 `<窗口>::<server 键>::<规范化根>` 三段拼接，它同时就是 `lsp_write` / `lsp_stop` 收的 id。
窗口名进键是因为 `app.emit` 向所有窗口广播，两个窗口共用一条管道会把 JSON-RPC 的请求 id 串到别的窗口上去；
会话按窗口归属，同一项目在两个窗口各跑一份进程，前端只处理自己已知的 id。

- `lsp_start` 是幂等的 ensure：身份已在表内直接回原 id，绝不重复 spawn。另有一张「正在启动」表加条件变量，
  并发请求同一身份时后到的等前一条完成。
- 失败退避单独一张表：启动失败或握手超时记一次，允许重试的时刻按 `5s * 2^n` 推后、封顶 300 秒，连续超过 2 次
  不再自动尝试并回 `LSP_START_LIMIT`。前端等不到 `initialize` 回执时调 `lsp_failed`，计入同一张表。
  启动成功即清除记录；`lsp_retry` 清掉残留会话与失败记录，让下一次能立即重试。
- 回收不用定时器：每次启动之前跑一次 `sweep()`，空闲超过 `idleTimeoutMin` 的先收，总数仍达 `maxSessions` 时
  摘除最久未用的一条。`last_used_ms` 由 `lsp_write` 刷新，所以「在使用」的定义是确实发送过消息。
  回收先发 LSP `shutdown` 请求，等 3 秒，再 `taskkill /F /T` 兜底。单独的定时线程只会多一个唤醒点。
- 读线程遇到 EOF、或退出并非本模块主动发起时记一次失败，让下一次对档走退避而不是立即重试。
  `lsp_reap` 保留，只在页面开头调一次，收上一回遗留的会话。
- `lsp_session_statuses` 是实时采集：`try_lock` 住 child 再 `try_wait`，锁被占用时不报错，报 `running`
  并附一句「本轮未采集到」；从未启动成功、只存在于失败记录里的合成一条 `dead`；`running` 只表示进程存在，
  不表示服务器已完成索引，界面文案按这个口径写。

## 技术栈根解析

`lsp_resolve_root(server, workspaceRoot, file?)` 定真正的项目根：先从文件所在目录向上找 `rootMarkers`，
越出工作区根即停；未命中再从工作区根向下扫 2 层，跳过 `node_modules` / `.git` / `target` / `dist` / `build` /
`out` / `vendor` / `__pycache__` / `.venv`。标志名支持 `*` 前缀（`*.csproj`）。标志表为空时直接返回工作区根，
这条让没配 `rootMarkers` 的自填 server 也能启动。命中缓存 60 秒、未命中缓存 5 秒、表上限 512 条；
目录不存在或未命中一律回 null，不报错。

解决的是真实故障：`cwd` 与 `rootUri` 恒等于工作区根时，`Cargo.toml` 落在子目录会让 rust-analyzer 认不出
workspace，退成 detached 单文件模式，跨文件跳转失效、类型诊断缺失、`dead_code` 误报。对档时按 (server, 根)
分组，每组一条会话，`initialize` 的 `rootUri` 与 `lsp_start` 的 `cwd` 都用这一组自己的根；请求侧按路径挑最深
的那个根来发，monorepo 里每个子根各有一套索引。档位是 `lsp` 而根没解析出来的，按**文件所在目录**记一条跳过说明
（「没找到标志文件（…」），有效期与根解析同为 60 秒，不把整个工作区锁死；命令或参数一变说明即失效并重试，
填完路径不必等 TTL。

## 探测与安装

「是否已安装」与「用哪一档」是两件事，只用 `mode` 一个字段表达意图；可用性判断只看 `mode === "lsp"`。

- 搜索目录是进程 PATH 再加几个装完不会立即进入 PATH 的位置：Windows 加 `%APPDATA%\npm`、
  `%LOCALAPPDATA%\Programs\Python\Launcher`、`%LOCALAPPDATA%\Microsoft\WindowsApps`、`~/.cargo/bin`、
  `~/go/bin`；类 unix 加 `~/.local/bin`、`~/.npm-global/bin`、`~/.cargo/bin`、`~/go/bin`、`/usr/local/bin`、
  `/opt/homebrew/bin`、`/home/linuxbrew/.linuxbrew/bin`。去重且只保留确实存在的目录。这一层是必须的：
  从开始菜单起的进程用的是登录时的环境快照，装完 rustup 或 npm 全局包新增的目录对它不可见。
  启动语言服务时用这份增强 PATH 覆盖继承来的那条。
- Windows 候选名按 `PATHEXT` 逐个构造，再额外补一条 `.ps1`：npm 的 cmd-shim 会同时生成 `.cmd` 与 `.ps1`，
  而 `PATHEXT` 默认不含 `.ps1`，不补就出现「探测说不存在、spawn 却能起来」的分歧。命令里含 `\` 或 `/` 时按显式
  路径直接判存在。**Windows 上裸名字不进候选**：只要 PATH 里同时有无扩展名的 sh 脚本和 `.cmd` 垫片，
  裸名字排最前就会先命中 sh 脚本，spawn 报 os error 193（`%1 不是有效的 Win32 应用程序`）。
- 只有 `rust-analyzer` 额外跑一次 `--version`，`stderr` 含 `Unknown binary` 或 `is not installed` 判为未安装：
  rustup 的占位 shim 正好占住该文件名，组件没装时文件在但起不来。其余 server 一律不 spawn，探测无副作用。
- 单次结果缓存 10 秒；`lsp.rs` 的解析程序转调同一份候选顺序，spawn 与探测不再各写一套。
- `lsp_install` 执行配置里的 `installCommand`：Windows 走 `%COMSPEC% /D /C`，其余走 `/bin/sh -c`，
  不设超时（全局安装常需数分钟），两路输出合起来只留尾部 32 KiB，截尾按字符处理，不把多字节序列截断。
  用 shell 是因为这条命令本身是多个包管理器串联的容错链，不是单程序加参数。
- 校正只做单向：探测为未安装却启用着外部档的，档位回退为 `off`，绝不自动启用，因为用户可能有意保持该项关闭；
  安装完成后要人自己切。确有改动才写回 `lsp.json`，校正后的配置随报告带回，前端拿到后不再回写，避免两侧各落盘一次。
  这条逻辑只在界面主动请求探测时执行，不在应用启动时执行。

## 调试器注入会让 Node 语言服务假死

从 VS Code / Cursor 系编辑器的集成终端启动应用时，终端会往环境注入 `NODE_OPTIONS`（挂
`--require .../ms-vscode.js-debug/.../bootloader.js` 与 `--inspect-publish-uid`）和一条
`VSCODE_INSPECTOR_OPTIONS`（`autoAttachMode: "always"`）。这是编辑器 auto-attach 的机制，对象是「在终端里
被启动的 Node 进程」。语言服务是我们自己拉起的子进程，不是用户的调试目标，但原先只覆盖 `PATH`，两个变量原样传下去。
Node 写的 server 加载 bootloader 后会连 `inspectorIpc` 那个管道，然后挂在调试等待上，永不回 `initialize`；
前端握手超时（30 秒）当崩溃杀掉，界面显示「语言服务已退出」并三连退避。Go 写的 `gopls` 不读 `NODE_OPTIONS`，
所以只坏 TS 系。

修复是起进程与跑安装两条路各 `env_remove` 掉这两个变量（`VSCODE_INJECTION` 留着无害，bootloader 只认前两个）。
终端与运行两条通道**不动**：那是用户主动跑命令的地方，`npm run dev` 之类本就该能被调试器附加。

## server 从哪来

三条路里取的是第三条。

- 打包进安装包：不行。jdtls 要跟一个 JRE，rust-analyzer 必须匹配用户的 rustc，gopls 必须匹配 go 版本，
  这些 server 与语言工具链强耦合，打包必然版本错配，体积还会翻几倍。
- 应用自动下载：要联网、管版本、处理代理，与离线优先的定位冲突。
- 探测本机加手动填路径：先扫 PATH 与常见安装位置，扫到就用，扫不到让人在设置里填，不在就静默降级。

第三条引入一个前提：语义能力依赖本机已装好对应的语言工具链。这与「不依赖 CDN」不冲突，它不联网、不下载，
只是用本机已有的。

前端客户端自己写，只做握手、文档同步、请求路由和编辑器适配。`src/lib/lspManager.ts` 是唯一公开 seam，调用方
不直接操作 JSON-RPC、Tauri command 或 session 表；底层 `src/lib/lspClient.ts` 负责进程会话、文档同步、能力和诊断缓存。

## CodeMirror 适配

`src/lib/cm/lsp.ts` 把 LSP 结果映射到当前编辑器，不持有进程状态：

- `reconcileLsp(root, config, documents)` 幂等计算会话、文档生命周期和内置语义档位；调用方通过 `lspManager` 进入。
- completion、hover、diagnostics、definition、declaration、type definition、implementation、references、formatting、
  signature help、code action 和 rename 均先检查 capability，再通过 Manager 请求。
- 位置结果按用途分流：定义 / 声明 / 类型定义 / 实现多处命中时，锚在发起跳转的光标位置弹「选择声明」弹层
  （`src/lib/cm/lspChooser.ts`，候选行 = 符号名 + 行预览 + 文件:行号，上下键换候选、回车跳转、Escape 收起；
  异文件候选的正文与符号名读盘后异步补全），一处命中直接跳；「查找用法」与符号 / 层级类结果仍进位置结果面板。
  Code Action 和 Rename 的所有写入统一进入 `lspManager.applyWorkspaceEdit`，server command 统一走
  `workspace/executeCommand`，UI 不直接写文件。
- Inlay Hints 在 `src/lib/cm/lspDecorations.ts` 中只请求可见区，视口、正文或 ready 状态变化会取消旧请求；结果同时校验
  文档身份、路径和序号，只生成只读 widget，不改变正文、不进入撤销栈。
- Semantic Tokens 在 `src/lib/cm/lspSemanticTokens.ts` 中按服务端 legend 解码相对 token 流，使用协商的位置编码生成只读标记；
  CodeLens 在代码行上方展示可点击 command，Inline Completion 使用只读 ghost text，Tab 接受时才写入正文。
- Document Symbols、Workspace Symbols、Incoming/Outgoing Calls、Supertypes/Subtypes 统一转换为位置结果面板；
  `workspace/symbol` 与层级后续请求使用 `LspManager.requestRaw`，不错误附加 `textDocument`。
- Document Link 使用独立适配层请求 `textDocument/documentLink`；只有有效 `file:` 目标才会显示为可点击链接，悬停显示目标提示，Ctrl/⌘ 点击通过 App 的文档入口打开。未知 scheme、非法范围和过期正文结果都会丢弃。
- 虚拟文档使用 `virtual:lsp/...` 内部键承载非磁盘 URI，原始 URI 只保存在文档元数据中；它们固定只读、不可保存、不进入语言服务的磁盘文档同步，关闭页签即清理。
- 文档同步使用规范化 `file://` URI 和 UTF-16/8/32 位置编码；`didChange` 有 150ms 防抖，过期结果不能落到新正文。
- 外部服务档位通过 `configureBuiltin` 关闭同类内置语义；`off` 只保留编辑器基础能力，`lsp` 只使用外部服务。

## 端到端跑通的样子

真实探针已对 `rust-analyzer 1.99.0` 和 `gopls v0.23.0` 验证 initialize、didOpen、completion、definition、formatting
和 shutdown；gopls 还返回了 diagnostics 与 Rename 的 WorkspaceEdit。探针脚本放在用户 Temp，不进入仓库。
`typescript-language-server`、`pyright` 和 `jdtls` 当前未安装，因此只记录为环境跳过，不把它们写成通过。

## 已知边界

- 首次切入 `lsp` 档的启动延迟与内存没有实测过（rust-analyzer 首次索引尤其重）。是否需要更显眼的
  「正在启动语言服务」状态，等实测再定。
- Document Link 当前只打开本地 `file:` 目标；非文件 URI 没有通用内容读取协议，因此只提供安全的虚拟文档容器，不自动拉取未知协议内容。
- 改动仍然每次发整篇正文（`contentChanges: [{ text }]`），只有 150ms 防抖压住了频率。协议上合法，
  大文件改一行也要把全文送一遍；换成增量 range 变更没做。
- 项目级覆盖只读取项目根 `.forge/lsp.json` 的候选顺序和 server patch，不反写用户配置；其它编辑器的配置文件不读取。
- 界面上添加与删除条目没做。`lsp.json` 是「种子表 + 用户改过的那几项」，`normalize` 会把种子里缺的键补回来，
  删掉一项会在下一次写盘时复活。自填 server 仍然能加：手改文件写一个新键，`normalize` 认它
  （单测 `custom_server_keys_are_kept` 钉着），编辑弹窗那套字段全都用得上。
- Rust 库测试在当前环境可运行并通过；仍有 Windows linker 的既有 manifest warning。退避、淘汰、状态合成与安装取尾、
  单向校正已由实现和配置测试覆盖，真实桌面进程崩溃恢复仍需在带 Tauri bridge 的桌面流程补验。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src-tauri/src/lsp.rs` | 缓冲上限常量 `:22-33`、失败记录与 `RESTART_LIMIT` `:67-81`、`backoff` `:84`、`SessionStatus` `:139`、`parse_args` `:168`、`build_command` `:198`、`session_id` `:222`、起锁 `:241`、`backoff_error` `:260`、`sweep` `:297`、`lsp_start` `:341`、`spawn_session`（含两处 `env_remove`）`:382-412`、`read_loop` `:459`、`take_message` `:575`、`lsp_write` `:616`、`lsp_stop` `:637`、`lsp_reap` `:671`、`lsp_session_statuses` `:698`、`lsp_failed` `:801`、`lsp_retry` `:811` |
| `src-tauri/src/lsp_config.rs` | `LSP_FILE` `:42`、`LspServerConfig` / `LspConfig` 与 `allowed_modes`、种子表、`DEFAULT_MAX_SESSIONS` `:354` 与 `DEFAULT_IDLE_TIMEOUT_MIN` `:356`、`default_config` `:371`、`effective_program`、`normalize` 与 `clamp`、`migrate_from_settings`、`load_in` `:491`、`save_in` `:529`、两条命令 `:576` 与 `:582` |
| `src-tauri/src/lsp_probe.rs` | `PROBE_TTL` `:21`、`OUTPUT_TAIL` `:24`、`candidates` 与 `search_dirs`、`augmented_path` `:150`、`is_functional`、`resolve_command` `:190`、`run_install`、`lsp_probe` `:310`、`lsp_install` `:316`、`probe_and_reconcile` |
| `src-tauri/src/lsp_detect.rs` | `CACHE_TTL` `:16`、`MISS_TTL` `:19`、`CACHE_LIMIT` `:21`、`MAX_DEPTH` `:23`、`SKIP_DIRS` `:25`、`marker_matches` / `hit_in` / `search_up` / `search_down`、`resolve` `:146`、`cached`、`lsp_resolve_root` `:215` |
| `src/lib/lspClient.ts` | `rememberSkip` `:71`、`emitStatus` / `watchLspStatus` `:114-119`、`toUri` `:135`、`sessionKey` `:145`、`ROOTS_TTL` `:150`、`resolveRoot` `:158`、`initialize` `:231`、`startServer` `:291`、`launchSession` `:303`、`ensureSubscriptions` `:358`、日志的保留与并入 `:386-450`、`handleMessage` `:461`、`applyDiagnostics` `:544`、`findModelByUri` `:577`、`ensureProviders` `:609`、`completionsFromLsp` `:667`、`completionKind` `:761`、`reconcileLsp` 与 `reconcileOnce`、`syncDocuments`、`wakeLsp`、`configureBuiltin` |
| `src/lib/cm/lspDocumentLinks.ts` | `textDocument/documentLink` 请求、`file:` 目标校验、悬停提示、Ctrl/⌘ 点击和正文快照失效 |
| `src/lib/cm/lspChooser.ts` | 跳转目标选择器：`showDeclarationChooser`、候选态 StateField + `showTooltip`、高优先键位（上下/回车/Escape）、异文件预览异步补全 |
| `tests/lib/cmChooser.test.ts` | 选择器行为：锚点弹层条目、点击跳转、键盘选择、Escape 收起 |
| `src/lib/virtualDocuments.ts` | 非 `file:` URI 校验与 `virtual:lsp/...` 内部键生成 |
| `src/hooks/useDocuments.ts` | 虚拟 URI 元数据、只读容器和 `openVirtualUri` 生命周期 |
| `src/lib/lsp.ts` | 与 `lib/term.ts` 同构的 API 壳：十二条命令与状态 / 探测 / 根命中的镜像类型 |
| `src/lib/lspConfig.ts` | 类型镜像、`modesFor`、`programOf`、`serverEntries` / `serverForLanguage`、读写两条封装 |
| `src/hooks/useLspConfig.tsx` | 配置的唯一持有处：`config` / `patchServer` / `probes` / `reprobe` / `probing` 与会话状态；探测回来的那份走 `skipSave` 不再写盘 |
| `src/hooks/useLspSessions.ts` | 一份轮询两处用（状态条与设置页）：`POLL_MS` 3 秒、序号丢旧快照、上一次落定之后再排下一次 |
| `src/components/LspStatusBar.tsx` | 底部那一格与弹层；未打开项目或没有外部档时不绘制；只列当前窗口的会话 |
| `src/components/LspDialogs.tsx` | 编辑弹窗（九个字段、`initOptions` 的 JSON 校验、超时夹区间）、安装确认弹窗（命令原文只在这里）、输出日志弹窗 |
| `src/lib/editorEnv.ts` | 语言显示名和扩展名映射的编辑器无关门面；设置页、编辑器和状态条不各自维护语言 id |
| `src/lib/format.ts` | `normPath` / `samePath` / `pathWithin`：路径比较只有一份规则 |
| `src/lib/window.ts` | `windowLabel`，会话身份的第一段 |
| `src/lib/errors.ts` | LSP 那九条码的映射 |
| `src/App.tsx` | 对档 effect、`wakeLspServer`、状态条挂点 |
| `src/main.tsx` | 起手并读设置与语言服务配置；启动时回收遗留 LSP 会话，具体请求延迟到 `lspManager`，避免在启动路径提前加载编辑器 provider |
