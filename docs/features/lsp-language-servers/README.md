# 外挂语言服务

语义能力有两个来源：Monaco 自带的 worker 语言服务，和这一层拉起的外部语言服务进程。同一门语言只能留一个。
这一份管进程、协议帧、配置与会话生命周期；配置栏的界面见 [../settings/](../settings/)，底部状态条那一格见
[../shell-layout/](../shell-layout/)，内置语义在哪里让位见 [../code-editor/](../code-editor/)，
十二条命令的参数与返回见 [../../backend/commands.md](../../backend/commands.md) 的「语言服务」一节。

## 为什么要有这一层

Monaco 的 worker 跑在 Web Worker 里，没有文件系统：看不见磁盘上的 `node_modules`、`@types`、`tsconfig.json`，
也看不见同工程的其它文件，`import` 一律解析不到。命令行 `tsc --noEmit` 走项目本地的 TS 与真实 `node_modules`
是零错误，编辑器里却整片报红，根因只有这一个。内置语义另外只覆盖 `css` / `html` / `json` / `typescript`
四门，其余语言只有 tokenizer 的高亮与括号匹配。

独立进程有完整文件系统，能解析整个工程。代价是接了外部服务的语言必须把内置语义关掉：Monaco 的 provider 是并列
注册的，两套并存时 hover 弹两个框、诊断红线两个来源。

## 档位：三态收敛成一个枚举

配置的键是 **server**，不是语言 id。`.ts` / `.tsx` / `.js` / `.jsx` 在 Monaco 里分属 `typescript` 和
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
- 不存 `extensions`：扩展名到语言 id 的映射只在 `monacoEnv.ts` 那张表里，两处存就会对不上。

字段：`mode`、`program`、`path`（空串表示用探测到的那条）、`args`（一行文本，拆分在后端）、`languages`
（Monaco 语言 id）、`rootMarkers`、`installCommand`、`startupTimeoutMs`、`initOptions`、`supportsBuiltin`，
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

前端客户端自己写，只做握手、文档同步与 provider 分发三件事。`monaco-languageclient` 排除：11.x 依赖
`@codingame/monaco-vscode-api@^37`，是替换整个 Monaco 接入层的重型方案。`monaco.lsp.MonacoLspClient` 也排除：
它只提供 `WebSocketTransport` 与到 worker 的传输，没有 stdio 传输，公开面只有构造器，做不了文档同步与
provider 注册。

## Monaco 那一侧

`src/lib/lspClient.ts` 是模块级单例，不认识文档模型，只收 `{ path, language, text }` 的快照。

- 主入口 `reconcileLsp(root, settings, documents)` 幂等：算出该起哪些 server、不该留的停掉、文档按增删发改
  发 didOpen / didChange / didClose、内置语义开关跟着档位走。App 在文档列表、工作区或配置变动时调一次。
- 调用方每次击键都触发，而它又是异步的，外面套一层「最新优先」的合并队列：正在跑时再来的调用只更新待办参数。
  少了这层，两次对档会交叉执行，同一份文档可能被并发 didOpen。
- `opened` / `sent` 一律以规范化 URI 串为键，与请求侧 `model.uri.toString()` 一致。一处存原始路径、一处存
  `Uri.file()` 的输出时，Windows 上盘符大小写与分隔符不一致，请求会被「该文件未打开过」拦下，
  hover / 补全 / 跳转定义全部静默失效。
- `publishDiagnostics` 落成 `setModelMarkers`（owner 用固定串）。按 URI 直查 model 之外还要按归一化 fsPath
  再扫一次：server 回来的 URI 常带编码（`file:///c%3A/...`，盘符小写、冒号被编码），与 `Uri.file` 创建的不逐
  字节相同，只查一次会遗漏。
- provider 注册五样：hover、completion（触发字符 `. : < / @ " '`）、definition、references、documentSymbol，
  只对已经 didOpen 的 `file://` 文档发请求；比对面板那两份 `inmemory://` 模型排除在外。
- 诊断落盘时要把该语言所有 model 上 owner 为 `typescript` / `javascript` 的 marker 清空一次：
  `setModeConfiguration` 只关后续 worker 诊断，已经画在屏幕上的旧错误不会自己消失。
- 枚举映射：`SymbolKind` 两边顺序一致，减一即可；`CompletionItemKind` 两边顺序**不同**（LSP 的 Text=1、Class=7，
  Monaco 的 Method=0、Class=5），必须走显式映射表。
- 关内置语义走 `monaco.typescript.typescriptDefaults.setModeConfiguration(...)` 逐项关（0.57 里
  `monaco.languages.typescript` 已废弃，入口在顶层）。关的十项是 completionItems、hovers、definitions、
  references、rename、diagnostics、documentSymbols、signatureHelp、documentHighlights、codeActions；
  开内置时这十项整份恢复。判定是 `mode === "builtin"` 才开，`off` 与 `lsp` 都关，所以「只高亮不报错」
  对应的是 `off` 档。状态带缓存，档位没变不重设，重设会触发语言服务重算。
- 语法高亮不在这层，走主线程 tokenizer，关掉这些不影响高亮。
- 本地改动进 150ms 防抖窗口：窗口内每次对档只刷新待发文本并重置计时，到期才用最新那份发一条 `didChange`，
  版本号自增。少这一层，每次击键的全文与 server 重解析开销全花在中间态上，诊断反而更慢。
- 请求超时 60 秒。`initialize` 另按各项自己的 `startupTimeoutMs` 计（JVM 那两个 120 秒）。
- 发给 server 的 languageId 要规范化：`.tsx` 传 `typescriptreact`、`.jsx` 传 `javascriptreact`，
  否则 tsserver 按纯 ts/js 语法解析，把 JSX 报成一片语法错误。

## 端到端跑通的样子

对着真实 `typescript-language-server` 走完 initialize → initialized → didOpen：握手回完整 capabilities；
server 日志显示它读到了磁盘上的 `node_modules/typescript`（`Using Typescript version (workspace) 5.9.3`），
这正是 worker 做不到的；打开一个含 `const bad: string = n` 的文件，收到 `publishDiagnostics`，诊断为
`Type 'number' is not assignable to type 'string'`。

## 已知边界

- 首次切入 `lsp` 档的启动延迟与内存没有实测过（rust-analyzer 首次索引尤其重）。是否需要更显眼的
  「正在启动语言服务」状态，等实测再定。
- `lsp` 档下重命名、签名帮助、高亮同项与 quick fix 不可用：内置那十项一起关了，外挂这侧只接了五个 provider。
- 改动仍然每次发整篇正文（`contentChanges: [{ text }]`），只有 150ms 防抖压住了频率。协议上合法，
  大文件改一行也要把全文送一遍；换成增量 range 变更没做。
- 项目级覆盖不做。forge 的定位是全局设置，要按工程换 server 得先决定配置往哪儿放。
- 界面上添加与删除条目没做。`lsp.json` 是「种子表 + 用户改过的那几项」，`normalize` 会把种子里缺的键补回来，
  删掉一项会在下一次写盘时复活。自填 server 仍然能加：手改文件写一个新键，`normalize` 认它
  （单测 `custom_server_keys_are_kept` 钉着），编辑弹窗那套字段全都用得上。
- 本机的 Tauri 测试二进制受 `0xc0000139` 限制（见 [../../backend/toolchain.md](../../backend/toolchain.md)），
  `npm run test:rs` 跑不起来；语言服务这 23 条单测（配置 10、探测 6、根解析 7）已在独立工程执行通过。
  退避、淘汰、状态合成与安装取尾、单向校正这几段需要真起进程才能覆盖，没有单测，靠人工验收兜。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src-tauri/src/lsp.rs` | 缓冲上限常量 `:22-33`、失败记录与 `RESTART_LIMIT` `:67-81`、`backoff` `:84`、`SessionStatus` `:139`、`parse_args` `:168`、`build_command` `:198`、`session_id` `:222`、起锁 `:241`、`backoff_error` `:260`、`sweep` `:297`、`lsp_start` `:341`、`spawn_session`（含两处 `env_remove`）`:382-412`、`read_loop` `:459`、`take_message` `:575`、`lsp_write` `:616`、`lsp_stop` `:637`、`lsp_reap` `:671`、`lsp_session_statuses` `:698`、`lsp_failed` `:801`、`lsp_retry` `:811` |
| `src-tauri/src/lsp_config.rs` | `LSP_FILE` `:42`、`LspServerConfig` / `LspConfig` 与 `allowed_modes`、种子表、`DEFAULT_MAX_SESSIONS` `:354` 与 `DEFAULT_IDLE_TIMEOUT_MIN` `:356`、`default_config` `:371`、`effective_program`、`normalize` 与 `clamp`、`migrate_from_settings`、`load_in` `:491`、`save_in` `:529`、两条命令 `:576` 与 `:582` |
| `src-tauri/src/lsp_probe.rs` | `PROBE_TTL` `:21`、`OUTPUT_TAIL` `:24`、`candidates` 与 `search_dirs`、`augmented_path` `:150`、`is_functional`、`resolve_command` `:190`、`run_install`、`lsp_probe` `:310`、`lsp_install` `:316`、`probe_and_reconcile` |
| `src-tauri/src/lsp_detect.rs` | `CACHE_TTL` `:16`、`MISS_TTL` `:19`、`CACHE_LIMIT` `:21`、`MAX_DEPTH` `:23`、`SKIP_DIRS` `:25`、`marker_matches` / `hit_in` / `search_up` / `search_down`、`resolve` `:146`、`cached`、`lsp_resolve_root` `:215` |
| `src/lib/lspClient.ts` | `rememberSkip` `:71`、`emitStatus` / `watchLspStatus` `:114-119`、`toUri` `:135`、`sessionKey` `:145`、`ROOTS_TTL` `:150`、`resolveRoot` `:158`、`initialize` `:231`、`startServer` `:291`、`launchSession` `:303`、`ensureSubscriptions` `:358`、日志的保留与并入 `:386-450`、`handleMessage` `:461`、`applyDiagnostics` `:544`、`findModelByUri` `:577`、`ensureProviders` `:609`、`completionsFromLsp` `:667`、`completionKind` `:761`、`reconcileLsp` 与 `reconcileOnce`、`syncDocuments`、`wakeLsp`、`configureBuiltin` |
| `src/lib/lsp.ts` | 与 `lib/term.ts` 同构的 API 壳：十二条命令与状态 / 探测 / 根命中的镜像类型 |
| `src/lib/lspConfig.ts` | 类型镜像、`modesFor`、`programOf`、`serverEntries` / `serverForLanguage`、读写两条封装 |
| `src/hooks/useLspConfig.tsx` | 配置的唯一持有处：`config` / `patchServer` / `probes` / `reprobe` / `probing` 与会话状态；探测回来的那份走 `skipSave` 不再写盘 |
| `src/hooks/useLspSessions.ts` | 一份轮询两处用（状态条与设置页）：`POLL_MS` 3 秒、序号丢旧快照、上一次落定之后再排下一次 |
| `src/components/LspStatusBar.tsx` | 底部那一格与弹层；未打开项目或没有外部档时不绘制；只列当前窗口的会话 |
| `src/components/LspDialogs.tsx` | 编辑弹窗（九个字段、`initOptions` 的 JSON 校验、超时夹区间）、安装确认弹窗（命令原文只在这里）、输出日志弹窗 |
| `src/lib/monacoEnv.ts` | 语言显示名的唯一来源：`LANGUAGE_LABELS`、`languageLabel`、`languageNames`；设置页卡片、编辑弹窗标题行与状态条弹层三处共用 |
| `src/lib/format.ts` | `normPath` / `samePath` / `pathWithin`：路径比较只有一份规则 |
| `src/lib/window.ts` | `windowLabel`，会话身份的第一段 |
| `src/lib/errors.ts` | LSP 那九条码的映射 |
| `src/App.tsx` | 对档 effect、`wakeLspServer`、状态条挂点 |
| `src/main.tsx` | 起手并读设置与语言服务配置；`termReap` 之后紧跟 `lspReap`，走 `lib/lsp` 那个薄壳，不引 `lib/lspClient`，否则启动路径上多打出一个几百模块的 monaco chunk |
