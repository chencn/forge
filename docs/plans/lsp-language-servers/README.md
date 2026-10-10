# 外挂 LSP：多语言语言服务的通道与开关

**状态**：`待验收`。两轮共八块都已落地：第一轮的设置模型、设置页、后端进程通道、前端客户端对着真实
`typescript-language-server` 跑通过（见「已做」的验证一节）；第二轮的 `lsp.json`、探测与一键安装、
会话生命周期、技术栈根解析、状态条那段与设置页改造代码齐了，`check:rs` / `check:ts` / `build` 全过，
23 条 Rust 单测已在独立工程中全部通过。剩余事项是在本机运行一次应用完成人工验收。
**涉及模块**：`code-editor`（`src/lib/monacoEnv.ts`、`src/lib/monacoEditor.ts`、
`src/components/CodeEditor.tsx`）、`settings`
（`src/components/SettingsPage.tsx`、`src/lib/settings.ts`、`src/hooks/useSettings.tsx`、
`src-tauri/src/settings.rs`）、`shell-layout`（底部状态条）、`localization`（中英两份文案）；
后端新增 `src-tauri/src/lsp.rs`、`src-tauri/src/lsp_config.rs`、`src-tauri/src/lsp_probe.rs`、
`src-tauri/src/lsp_detect.rs`，前端新增 `src/lib/lsp.ts`、`src/lib/lspConfig.ts`、`src/lib/lspClient.ts`、
`src/hooks/useLspConfig.tsx` 与 `src/components/LspStatusBar.tsx`。
**阻塞点**：没有硬阻塞。人工验收要一台装了 server 的机器，本机已有
`typescript-language-server` 与 `rust-analyzer`。

## 背景

编辑器现在的语义能力只有一个来源，就是 Monaco 自带的语言服务，而它只覆盖四个语言：`css`、`html`、`json`、
`typescript`（`javascript` 共用同一套）。其余语言由 `basic-languages` 提供 tokenizer，只有语法高亮和括号匹配，
没有任何语义。也就是说 Rust、Go、Python、Java 这些现在连「报错」都做不到，不是冲突，是本来就没有。

TS 那套语义来自 worker 里的 tsserver，跑在 Web Worker 里，没有文件系统。它看不见磁盘上的 `node_modules`、
`@types`、`tsconfig.json`，也看不见同工程的其它文件。所以 `import` 任何模块都解析不到，相对路径也一样，
编辑器里整片报红。而命令行 `tsc --noEmit` 走项目本地的 TS 和真实的 `node_modules`，是零错误。两个结果对不上，
根因只有这一个：worker 够不着磁盘。

外挂 LSP 把语言服务挪到独立进程，那个进程有完整文件系统，能解析整个工程。代价是 TS 那套内置语义必须让位：
Monaco 的 provider 是并列注册的，内置的 hover 和外挂的 hover 会同时弹，诊断的 marker 也会混成两个来源。
所以接 LSP 就得把内置语义关掉，不是可选动作。

## 已做

### 这次已落地：设置模型与设置页那一栏

设置侧的数据模型已经按下面「设置模型」一节写进代码，能独立验证，不依赖任何 server：

- Rust 侧 `settings.rs` 新增 `LspServerSettings { mode, path }` 与 `LspSettings { servers: BTreeMap<..> }`，
  挂进 `Settings.lsp`。用 `BTreeMap` 是为了让键有序、落盘稳定。`mode` 用 String，跟 `keymap` 一样。
  Rust 不摆默认表：默认值全在前端，Rust 只存用户动过的那几项。
- 前端 `lib/settings.ts` 新增 `LspMode` 三态类型、`LspServerSettings`、`LspSettings`、注册表 `LSP_SERVERS`
  与 `modesFor()`，并在 `DEFAULT_SETTINGS` 里按注册表生成默认值（typescript 为 `builtin`，其余 `off`）。
  `merge()` 里 `mergeLsp()` 逐 server 校验：文件里缺的按默认补，`mode` 不在该 server 允许的档位里就退回默认。
- 设置页新增「语言服务」栏，每行一个 server：档位下拉（typescript 三档，其余两档）加路径输入框，下面一条说明。
- 两条 Rust 单测钉住 wire 契约：`lsp` 的键是前端写死的 server 名，结构体上的 `rename_all = "camelCase"`
  只改字段名、不能碰 map 的键（否则 `rust-analyzer` 这类名字会被改写，前端就找不到了）；旧文件缺 `lsp`
  字段要能读且读成空表。单测逻辑已在独立工程验证通过（本机的 Tauri 测试二进制有既存 DLL 加载问题，见「未做」）。

`monaco-languageclient` 这条路已排除：11.x 依赖 `@codingame/monaco-vscode-api@^37`，是替换整个 Monaco
接入层的重型方案，和现在直接 `import monaco-editor` 不兼容。接它等于重写编辑器接入层，违背重构优于重写。
前端客户端自己写，只做握手、文档同步与 provider 分发这三件事。

### 这次已落地：后端进程通道

`src-tauri/src/lsp.rs` 独立成模块，四条命令 `lsp_start` / `lsp_write` / `lsp_stop` / `lsp_reap`。
**没有改 `proc.rs` 的 stdin，也没有借 `term.rs`**：三条通道语义不同（`proc` 单向跑一行、`term` 是 PTY、
这条是普通管道上的双向字节流），合并会让三方都变复杂。文档前面「改 proc.rs 的 stdin」是复用旧设想，作废。

- 起进程：stdout / stderr / stdin 全 `Stdio::piped()`，不是 PTY。PTY 会做 CR/LF 转换、回显、注转义序列，
  会把 `Content-Length` 帧冲烂。
- 分帧读写：`take_message` 按 `Content-Length` 从缓冲里切完整消息，body 里的 `\r\n\r\n` 不会被误判成新帧头；
  长度按**字节**算，多字节字符不会错位。`lsp_write` 补 `Content-Length` 头再写 stdin——放后端做是因为
  字节长度在前端容易算错。
- 事件：`lsp://message` 送帧、`lsp://log` 送 stderr 的按行输出（stderr 必须有人读，否则管道满了 server 会卡）、
  `lsp://exit` 送退出。
- 可执行文件解析：`resolve_program` 认绝对路径，裸名字走 PATH；Windows 上再试 `.cmd` / `.exe` / `.bat`
  （npm 装的 `typescript-language-server` 是 `.cmd` 垫片）。`.cmd` / `.bat` 经 `cmd /C` 起。
- 停止走 `taskkill /F /T` 杀整棵树：语言服务常带子进程（rust-analyzer 起 rustc、gopls 起编译器）。
- 启动参数走后端 `parse_args` 拆：空白分隔，双引号里的整段算一个参数。只认双引号、不做反斜杠转义——
  路径里出现双引号的情形不存在，多一层转义规则只会让用户猜不透。设置在 `lsp.servers.<id>.args`，
  缺省值由前端注册表按 server 填（`typescript` / `pyright` 是 `--stdio`）。

共用工具顺手归位：`hide_console`、`is_file`、`env_path`、`env_raw`、`which` 从 `term.rs` / `proc.rs`
搬进 `sys.rs`，三处共用一份，不再各写一遍。

验证：分帧与参数解析的 11 条单测已抽取到独立工程执行并通过（本机 Tauri 测试二进制存在既有 DLL 问题，见「未做」）；
另外用一个假 LSP server 做了端到端闭环——真实启动进程、写入帧、server 回帧、`take_message` 解帧成功，
证明通道确实可用。前端 `src/lib/lsp.ts` 与 `lib/term.ts` 同构，只是 API 壳。

### 这次已落地：前端 LSP 客户端

`src/lib/lspClient.ts` 是模块级单例（照 `lib/termStore.ts` 的路子），不认识文档模型，只收
`{ path, language, text }` 的快照。

- 主入口 `reconcileLsp(root, settings, documents)`，幂等：算出该起哪些 server、不该留的停掉、
  文档按增删改发 didOpen / didChange / didClose、内置语义开关跟着设置走。App 在文档列表、工作区或
  语言服务设置变动时调一次，不需要到处挂回调。
- **重入防护**：调用方每次击键都会触发，而它又是异步的，所以外面套一层「最新优先」的合并队列
  （`pending` / `drain`）：正在跑时再来的调用只更新待办参数，不并排跑第二遍。少了这层，两次 reconcile
  会交叉执行，同一份文档可能被并发 didOpen。
- **URI 一致性**：`opened` / `sent` 一律以规范化 URI 串为键，与请求侧 `serverRequest` 用
  `model.uri.toString()` 一致。这是曾经遇到的问题——若一处存原始路径、一处存 `Uri.file()` 的输出，
  Windows 上盘符大小写与分隔符不一致，请求会被 `opened.has` 拦下，hover / 补全 / 跳转定义全部静默失效。
- **诊断落地**：`publishDiagnostics` 是 server push 通知（`uri` + `diagnostics` 必填，`version` 可选）。
  `findModelByUri` 先按 URI 直接查，查不到再按归一化 fsPath 扫描一次——server 返回的 URI 常带编码
  （`file:///c%3A/...`，盘符小写、冒号被编码），与 `Uri.file` 创建的不逐字节相同，只查一次会遗漏。
- **provider**：hover / completion / definition / references / documentSymbol 各注册一个，转成 LSP 往返。
  只对已经 didOpen 的 `file://` 文档发请求，比对面板的两份 `inmemory://` 模型会被排除在外。
- **枚举映射**：`SymbolKind` 两边顺序一致，减一即可；`CompletionItemKind` 两边顺序**不同**
  （LSP 的 Text=1、Class=7，Monaco 的 Method=0、Class=5），必须显式映射表，不能减一。
- **关内置语义**：`monaco.typescript.typescriptDefaults.setModeConfiguration(...)` 逐项关。注意
  monaco 0.57 里 `monaco.languages.typescript` 已废弃，入口在顶层 `monaco.typescript`。状态加缓存，
  档位没变就不重设（重设会触发语言服务重算）。
- **降级**：启动失败的 server 记进 `unavailable`，不重复 spawn；用户填写路径后重试。状态经
  `watchLspStatus` 推到设置页该栏（正在启动 / 运行中 / 未找到）。

`monaco.lsp.MonacoLspClient` 这条路也排除了：它是 monaco 0.57 自带的 LSP 客户端，但只提供
`WebSocketTransport` / `createTransportToWorker` 这类传输层，没有 stdio 传输，且公开面只有构造器，
做不了文档同步与 provider 注册。

### 端到端验证（对着真实 server）

本机装了 `typescript-language-server` 与 `rust-analyzer`。用后端 `lsp.rs` 原样抽取的函数驱动真实
`typescript-language-server`，走完整序列 initialize → initialized → didOpen，验证结果：

- `resolve_program("typescript-language-server")` 选中 `...\typescript-language-server.cmd`（见下方修复）。
- `initialize` 握手成功，返回完整 capabilities。
- server 日志显示 `Using Typescript version (workspace) 5.9.3 from .../node_modules/typescript`——
  它真的读到了磁盘上的 `node_modules`，这正是 Monaco worker 做不到的。
- 打开一个含 `const bad: string = n` 的文件，收到 `publishDiagnostics`，诊断为
  `Type 'number' is not assignable to type 'string'`。**诊断链路完整跑通。**

验证顺带抓到一个真实 bug：`resolve_program` 原本先 `which(program)` 再试扩展名，而 npm 装的 CLI 在
`nodejs` 目录下同时有 `foo`（无扩展名的 sh 脚本）、`foo.cmd`、`foo.ps1`，`which("foo")` 先命中 sh 脚本，
它不是有效 Win32 程序，spawn 报 os error 193。已改成 Windows 上先按 `.exe` / `.cmd` / `.bat` / `.com` 找。

这条后来又回归过一次，根因是候选列表把**裸名字排在了最前**（`lsp_probe::candidates`），
于是那个无扩展名的 sh 脚本又被第一个命中，报的还是 `%1 不是有效的 Win32 应用程序 (os error 193)`。
现在定死：**Windows 上裸名字不进候选**，只按 `PATHEXT` 补扩展名、末尾再兜一个 `.ps1`。
只要 PATH 里同时存在无扩展名的 sh 脚本和 `.cmd` 垫片，这条就是硬约束。

### 调试器注入让 Node 语言服务假死（「语言服务已退出」）

从 VS Code / Cursor 系编辑器的集成终端启动 forge 时，终端会往环境注入 Node 调试变量：
`NODE_OPTIONS` 里挂 `--require .../ms-vscode.js-debug/.../bootloader.js` 与 `--inspect-publish-uid`，
外加一条 `VSCODE_INSPECTOR_OPTIONS`（`autoAttachMode: "always"`）。这是编辑器 auto-attach 的机制，
对象是「在终端里被启动的 Node 进程」。

语言服务是我们自己拉起的子进程，不是用户的调试目标。`spawn_session` 原本只覆盖 `PATH`，这两个变量
原样传给了子进程。Node 写的 server（`typescript-language-server` 这类）加载 bootloader 后会连
`VSCODE_INSPECTOR_OPTIONS.inspectorIpc` 那个 pipe，然后**挂在调试等待上，永不回 `initialize`**。
前端 `initialize` 握手超时（默认 30 秒）→ 当崩溃调 `lsp_stop` 杀掉 → `lsp://exit` → 界面显示
「语言服务已退出」，三连退避重试。Go 写的 server（`gopls`）不读 `NODE_OPTIONS`，所以只坏 TS 系。

实测：注入环境下 TS 语言服务 12 秒不响应握手；`env_remove` 掉这两条后正常握手、fork 出 tsserver。
修复落在 `lsp.rs::spawn_session` 与 `lsp_probe.rs::run_install`（一键安装走的 `npm` 同样是 Node 程序），
两处都 `env_remove("NODE_OPTIONS")` + `env_remove("VSCODE_INSPECTOR_OPTIONS")`。
`VSCODE_INJECTION` 留着无害，bootloader 只认前两个。

终端（`term_open`）与运行（`proc_start`）**不动**：那两条是用户主动跑命令的通道，
`npm run dev` 之类本就该能被调试器附加。

### 原本就在的底子

进程通道这一块是完整的，缺的从来不是执行能力。`proc.rs` 一条命令加两个事件就能跑任意一行命令：stdout 与
stderr 各一个线程读，8192 字节一块 base64 发 `proc://output`，退出码靠轮询取，停止走 `taskkill /F /T` 杀整棵树，
Windows 上 `CREATE_NO_WINDOW` 不弹控制台。但它的 stdin 写死了 `Stdio::null()`，只能单向，LSP 要双向，这一处要改。

探测外部程序有现成范式。`term.rs` 的 `shell_probe` 按固定候选路径加 `which` 扫，存在才列、同一路径不重复列，
设置里选了就用选的那条、没选用排第一的。server 的探测照这一套写，不用另起。

worker 分派也齐了。`monacoEditor.ts` 的 `MonacoEnvironment.getWorker` 按 label 分五个本地 worker，用 Vite 的 `?worker`
引，不走 CDN。LSP 客户端不碰这一层，语法高亮的 tokenizer 继续走主线程。

`modelUri` 返回的是 `monaco.Uri.file(path)`，是真实文件路径。LSP 要的正是这个，不用改。
`languageForPath` 两张表把路径映射到 Monaco 语言 id，给 LSP 选 server 时复用它。

设置侧的结构支持这组新配置。`Settings` 按 `editor` / `terminal` / `commit` / `branches` / `explorer` 分组，
每组一个结构体，`#[serde(default)]` 逐字段补，加字段不用迁移旧文件。新增一组 `lsp` 顺这个模式走。
前端 `lib/settings.ts` 有一份镜像类型，`merge()` 逐层补齐并对枚举做校验，`savePolicy` 只认 `manual` 就是这条。

## 方案

### 设置模型：每个 server 一个三态，TS 例外

配置的键是 **server**，不是语言 id。`.ts` / `.tsx` / `.js` / `.jsx` 在 Monaco 里分属 `typescript` 和 `javascript`
两个语言 id，但共用一个 `typescript-language-server`。按语言 id 配置会出现「TypeScript 已启用、JavaScript 未启用」
这种无法成立的组合，同一进程无法只服务一半。挂到 server 上，Rust / Go / Python / Java 是 1:1，只有 TS 系是 1:2，统一之后没有特例。

每个 server 一份配置，三个字段：`mode`、`path`、`args`。`mode` 是枚举：

| mode | 内置语义 | 外挂 LSP |
| --- | --- | --- |
| `off` | 关 | 关，只剩语法高亮 |
| `builtin` | 开 | 关 |
| `lsp` | 关 | 开 |

`builtin` 只有 `typescript` 能取。其余 server 只有 `off` 与 `lsp` 两态。

把「开 LSP 就关内置」做成一条需要遵守的规则是不够的：那样两个布尔字段各自可存，非法组合存得下，
手改文件、迁移脚本写错、缺字段补默认都能造出「两个都开」的状态，后果就是 hover 弹两个框、红线两个来源。
把三态收敛成一个枚举，这个状态就存不下，读的地方只有一处。

默认值：所有 server 为 `off`，`typescript` 为 `builtin`。这个默认正好等于今天的现状，不迁移、不回归。

Rust 侧结构体：

```
pub struct LspServerSettings { pub mode: String, pub path: String, pub args: String }
pub struct LspSettings { pub servers: BTreeMap<String, LspServerSettings> }
```

`mode` 用 String，跟 `keymap`、`save_policy` 一个路子，非法值在前端 `merge()` 里退回默认。
`path` 空串表示用探测到的那条，非空则用用户填的。带 `path` 是因为 server 可能在非标准位置。
`args` 是启动参数文本，缺省值由前端注册表按 server 填。
用 `BTreeMap` 而不是 `HashMap` 是让键有序、落盘稳定，同一份设置每次写出的字节一样。
默认表只放前端（`DEFAULT_SETTINGS` 按 `LSP_SERVERS` 生成），Rust 侧默认空表，只存用户动过的项。

代码里有一张默认表，文件里缺的 server 用默认补，用户没改过的 server 不落盘。加一个新 server 等于往默认表加一行。

默认表：

| server 键 | 覆盖语言 | 默认 mode | 缺省参数 | 探测候选 |
| --- | --- | --- | --- | --- |
| `typescript` | ts / tsx / js / jsx / mts / cts / mjs / cjs | `builtin` | `--stdio` | `typescript-language-server` |
| `rust-analyzer` | rs | `off` | 空 | `rust-analyzer` |
| `gopls` | go | `off` | 空 | `gopls` |
| `pyright` | py | `off` | `--stdio` | `pyright-langserver` |
| `jdtls` | java | `off` | 空 | `jdtls` |

### 语言无关的四个部件

不为每个语言写一套逻辑。四个部件对语言一视同仁：

1. 前端 LSP 客户端：`initialize` 握手、`textDocument/didOpen|didChange|didClose` 同步、把响应分发到 Monaco provider。
2. server 注册表：声明式的表，一个 server 一条，含命令、参数、探测路径、初始化选项。加语言只改这张表。
3. Rust 进程管理器：起进程、按帧读写、emit 事件、生命周期。照 `proc.rs` 改。
4. 探测层：照 `shell_probe` 扫本机装了哪些 server。

一条 `lsp_write(id, data)` 命令把前端消息写回 stdin，一个独立事件 `lsp://message` 把进程输出送上来。
和 `proc://output` 分开，两条通道语义不同，不能混。

### 分帧：用管道，不用 PTY（已落地）

LSP 的消息是 `Content-Length: N\r\n\r\n` 加 N 字节的 UTF-8 JSON。body 可以含换行，所以只能按头里的长度精确读 N 字节，
不能按行读。这条决定了**不能用 `portable-pty`**：PTY 是终端语义，会做 CR/LF 转换、回显、注入转义序列，
协议帧会被冲烂。所以 `lsp.rs` 走普通管道，stdin / stdout / stderr 全 `Stdio::piped()`。

### provider 映射

LSP 响应落到 Monaco 的这几处：

| LSP 方法 | Monaco 侧 |
| --- | --- |
| `textDocument/publishDiagnostics` | `monaco.editor.setModelMarkers`，owner 用固定串 |
| `textDocument/hover` | `monaco.languages.registerHoverProvider` |
| `textDocument/completion` | `monaco.languages.registerCompletionItemProvider` |
| `textDocument/definition` | `monaco.languages.registerDefinitionProvider` |
| `textDocument/references` | `monaco.languages.registerReferenceProvider` |
| `textDocument/rename` | `monaco.languages.registerRenameProvider` |
| `textDocument/documentSymbol` | `monaco.languages.registerDocumentSymbolProvider` |

关内置语义走 `typescriptDefaults` / `javascriptDefaults` 的 `setModeConfiguration`，可逐项关，
不是只有 `noSemanticValidation` 那种一刀切：

```
monaco.languages.typescript.typescriptDefaults.setModeConfiguration({
  completionItems: false, hovers: false, definitions: false, references: false,
  rename: false, diagnostics: false, documentSymbols: false, signatureHelp: false,
  documentHighlights: false, codeActions: false,
});
```

字段全集在 `monaco.d.ts` 的 `ModeConfiguration`，另有 `documentRangeFormattingEdits`、`onTypeFormattingEdits`、
`inlayHints`。不列的项保持内置。语法高亮不在这层，走主线程 tokenizer，关掉这些不影响高亮。

`typescript` 切到 `lsp` 时才关；`off` 与 `builtin` 都不关，因为 `off` 只是不做任何配置，内置按默认档继续工作。
这一条要在实现时点明，否则「关掉内置」和「不启用 LSP」会被混成一件事。

### server 从哪来

这是唯一真正的取舍，其余都是实现细节。三条路：

- 打包进安装包。不行。jdtls 要跟一个 JRE，rust-analyzer 必须匹配用户的 rustc，gopls 必须匹配 go 版本，
  这些 server 和语言工具链强耦合，打包必然版本错配，体积还会翻几倍。
- 应用自动下载。要联网、管版本、处理代理，跟离线优先的定位冲突。
- 探测本机加手动填路径。先扫 PATH 和常见安装位置，扫到就用，扫不到让用户在设置里填。server 不在就静默降级。

第三条是取的。它引入一个前提：语义能力依赖用户本机已装好对应的语言工具链。这跟「不依赖 CDN」不冲突，
因为它不联网、不下载，只是用本机已有的。

### 降级

用户开了 `lsp` 但本机没有那个 server 时：

- `typescript`：退回 `builtin`，界面出一条提示。至少还有语义，不至于突然全没。
- 其余：退回 `off`，只有高亮，提示未找到 server。

降级只影响运行时，**不改设置**。用户装好 server 之后下次打开文件自动生效。
`mode` 保持 `lsp` 不变，因为用户的意图是这个，只是当下落不了地。

## 第二轮：lsp.json、安装、会话生命周期与状态

参照实现来自 snow-app（`D:\app\code\snow-app`，Electron + napi-rs），它的设计文档是
`docs/zh-CN/4-架构与开发/7-LSP外部语言服务器接入设计.md`。只抄管理层，不抄协议层：
snow-app 的 LSP 客户端在 Rust（tokio + async-lsp + lsp-types），消费者是 agent 工具；
forge 的客户端在 webview，`src/lib/lspClient.ts` 已经跑通 Monaco provider 那条路，
monaco-languageclient 第一轮已排除。forge 也没有 tokio（依赖只有 tauri、serde、portable-pty、
notify、regex、walkdir，edition 2021、rust-version 1.80），引 async-lsp 等于换运行时。

### 决策

- 语言服务配置从 `settings.json` 拆出来，单独一份 `lsp.json`，落 `app.path().app_config_dir()`，
  即 `%APPDATA%\app.forge.desktop\lsp.json`。
- 全量落盘。首次启动把种子表整个写进文件，文件自己就是真相源，手改能看懂全貌。
  默认表（现在的 `LSP_SERVERS`）从前端迁到 Rust 的 `lsp_config.rs::seed_servers`，
  文件里缺某个键时用种子补，缺整个文件时写种子。前端不再有语言服务的默认值。
- `Settings.lsp` 与 `settings.rs` 的 `LspSettings` / `LspServerSettings` 删除。
  迁移只做一次：读到旧 `settings.json` 里有 `lsp` 段就并进 `lsp.json` 对应条目，之后不再读那段。
- 写盘改原子：写同目录 `lsp.json.tmp` 再 rename。`settings_save` 现在是裸 `fs::write`，一并改掉。
- 是否安装与使用哪档是两件事，但只用一个字段表达意图：`mode`。界面按「是否已安装」决定可提供哪些档位，
  未安装的项只提供安装这一个动作，安装完成后才允许切换到外部档。
  校正只做单向：探测结果为未安装却启用着外部档的，档位回退为 `off`，绝不自动启用，用户安装完成后需自行切换。
  第一轮记录的 `enabled` 字段已删除：它与 `mode=off` 表达同一件事，两个下拉并列时无法判断应修改哪一个。
  可用性判断从 `enabled && mode === "lsp"` 收敛为 `mode === "lsp"` 一处。
  这条边界沿用 snow-app 的单向校正，该实现说明了此前「启用但未安装」的状态会让 agent 持续发起必然失败的调用。

### lsp.json 结构

```json
{
  "version": 1,
  "servers": {
    "rust-analyzer": {
      "mode": "lsp",
      "program": "rust-analyzer",
      "path": "",
      "args": "",
      "languages": ["rust"],
      "rootMarkers": ["Cargo.toml"],
      "installCommand": "rustup component add rust-analyzer",
      "startupTimeoutMs": 30000,
      "initOptions": null,
      "supportsBuiltin": false
    }
  }
}
```

字段沿用第一轮：`mode` 三态 `off` / `builtin` / `lsp`，`builtin` 只有 `typescript` 可取，
这条由文件里的 `supportsBuiltin` 表达，不再写在前端；`path` 空串表示用探测结果；`args` 是一行文本，
拆分仍走后端 `parse_args`。新增 `languages`（Monaco 语言 id）、`rootMarkers`、`installCommand`、
`startupTimeoutMs`、`initOptions`、`supportsBuiltin`。
不存 `extensions`：扩展名到语言 id 的映射只在 `src/lib/monacoEnv.ts` 那张表里，两处存就会对不上。
`maxSessions`（默认 5）与 `idleTimeoutMin`（默认 30）在第 3 步里已经真的被 `sweep()` 读，所以一起落进文件。
serde 一律 `rename_all = "camelCase"` + `#[serde(default)]`。
档位合法性与空字段兜底在 Rust 的 `normalize` / `clamp` 里做，读写两侧都过一遍，
非法 `mode` 退回该 server 的种子档位，前端拿到的值已经是可用的。

### 种子表

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

`sourcekit-lsp` 在非 Windows 才入种子（Windows 支持不成熟）。缺省档位第一轮那条不变：
`typescript` 为 `builtin`，其余为 `off`。JVM 那两个 120s，参考 snow-app 的
`initialize_timeout_for`。

`installCommand` 按平台分支，Windows 取 snow-app 那份多包管理器容错串：
`winget install Rustlang.Rustup` 兜 rustup、`winget install LLVM.LLVM` 兜 clangd、
`npm install -g typescript-language-server typescript || pnpm add -g ... || yarn global add ...`、
`npm install -g pyright || pip install pyright`、
`(go env -w GOPROXY=https://goproxy.cn,direct) && go install golang.org/x/tools/gopls@latest`、
`dotnet tool install --global csharp-ls`、`scoop install jdtls || choco install eclipse-jdtls`、
`npm install -g intelephense`、`gem install ruby-lsp`、`winget install lua-language-server`。

### 探测与安装

新增 `src-tauri/src/lsp_probe.rs`，逻辑照搬 snow-app 的 `lsp/probe.rs`：

- 增强 PATH。在进程 PATH 之外追加：Windows `%APPDATA%\npm`、
  `%LOCALAPPDATA%\Programs\Python\Launcher`、`%LOCALAPPDATA%\Microsoft\WindowsApps`、
  `~\.cargo\bin`、`~\go\bin`；类 unix `~/.local/bin`、`~/.npm-global/bin`、`~/.cargo/bin`、
  `~/go/bin`、`/usr/local/bin`、`/opt/homebrew/bin`、`/home/linuxbrew/.linuxbrew/bin`。
  去重且只保留存在的目录。这一层是必须的：从开始菜单起的进程拿不到装完 rustup/go 之后新增的 PATH 项。
- Windows 候选名按 `PATHEXT` 生成，再额外补一条 `.ps1`。npm 的 cmd-shim 会同时生成 `.cmd` 和 `.ps1`，
  `PATHEXT` 默认不含 `.ps1`，不补就会出现探测说不存在、spawn 却能起来。命令里含 `\` 或 `/`
  时按显式路径直接判存在。
- 只有 `rust-analyzer` 额外跑一次 `--version`，`stderr` 含 `Unknown binary` 或 `is not installed`
  判为未安装。rustup 的占位 shim 会占住该文件名但组件实际未安装。其余 server 一律不 spawn，探测无副作用。
- 结果缓存 10 秒。环境改了要等缓存过期或手动刷新，不承诺即时。
- forge 现有的 `resolve_program` 和 `sys.rs::which` 合并到这一份，spawn 与探测共用同一条候选顺序，
  第一轮那个「先命中无扩展名的 sh 脚本、spawn 报 os error 193」的 bug 不会再各写一遍。

两条命令：

- `lsp_probe(programs) -> [{ program, installed, path }]`，批量、去重。
- `lsp_install(server)`：从 `lsp.json` 取 `installCommand`，Windows 走 `cmd /D /C <line>`、
  其余走 `/bin/sh -c`，`hide_console`，stdout 与 stderr 合起来累积、只保留尾部 32KB，不设超时
  （全局安装可能跑几分钟）。返回 `{ command, output, exitCode }`，非 0 进通知气泡留档。

### 会话生命周期

会话表从随机 `lsp-N` 改成确定性 key：`{ 窗口 label }/{ server 键 }/{ 规范化 root }`。

- `lsp_start` 变幂等的 ensure：同 key 已有会话直接返回原 id，绝不重复 spawn。
  表里加一个 pending 槽（`Mutex<HashMap<key, Slot>>`），第一个到达的负责起，后到的等同一个结果。
  snow-app 用 `Notify` + Drop 守卫处理同一件事，forge 这边 `std::sync::Mutex` 加条件变量就够。
- 启动失败按 key 记账：连续失败退避 `5s * 2^(n-1)`，封顶 300s；重启上限 2 次，超了不再自动起，
  等用户在状态里手动重启（手动重启会清掉这个 key 的失败记录）。
- 空闲回收：`last_used` 超过 `idleTimeoutMin`（默认 30 分钟）在下一次 reconcile 时收掉。
  先走 LSP `shutdown` 请求，等 3 秒，再 `taskkill /F /T` 兜底。
- 进程数上限 `maxSessions`（默认 5），超了按 `last_used` 淘汰最久未用的。
  rust-analyzer 单进程实测 500MB 到 1GB，这条上限是内存兜底，和状态条那串数字配着看。
- 崩溃检测沿用现有的 `lsp://exit`：读线程退出即从表里摘除并记一次失败，前端 reconcile 时按退避重启。

三条新命令：

- `lsp_session_statuses(window) -> [{ server, root, status, restartCount, lastUsedMs, error }]`。
  `status` 是 `running` / `dead` / `exited`。采样只做非阻塞 `try_wait`，不创建也不回收会话。
  会话正被占用时返回 `running` 并附一句「本轮未采样进程状态」，不阻塞前端。
  `error` 里带 `retryAfterEpochMs`，抄 snow-app 那行文本。
- `lsp_session_stop(server, root)`、`lsp_session_restart(server, root)`。

不抄跨窗口共享。Tauri 的 `app.emit` 向所有窗口广播，`lsp://message` 不分窗口，
两个窗口共用一条管道会把 JSON-RPC 的 request id 串到别的窗口。会话按窗口归属，
同一项目在两个窗口各跑一份进程；前端只处理自己已知的 id，其余丢弃。

### 技术栈根解析

新增 `lsp_resolve_root(server, workspaceRoot, filePath) -> { root, marker } | null`，
抄 snow-app 的 `detect.rs::markers_for_lang` 与 `find_lang_root`：

- 文件级请求：从 `filePath` 所在目录向上找 `rootMarkers`，到 `workspaceRoot` 之上就停。
- 项目级请求（没有文件）：从 `workspaceRoot` 向下扫，深度不超过 2，取该语言最浅的命中目录。
- `rootMarkers` 支持 `*.csproj` 这类后缀通配。
- 两种都没命中返回 null，`lspClient` 据此不起进程，状态里说明缺哪个标志文件。
- 结果缓存 60 秒。

这一条解决的是真实故障：forge 现在把 `cwd` 和 `rootUri` 恒等于工作区根，
`Cargo.toml` 在子目录时 rust-analyzer 认不出 workspace，退成 detached 单文件模式，
跨文件跳转失效、类型诊断缺失、`dead_code` 误报。monorepo 里每个子根各起各的会话。

### 状态查看

底部状态条加一段，和内存那串并排：`LSP 运行中 N`，有异常时改成异常数并换配色。
点开一个弹层，每行 `语言 · 服务名 · root · 状态 · error`，行内动作是 重试 / 停用。

- 轮询 3 秒。排下一次要等上一次 settle，不用 `setInterval`，否则慢响应会并排发、后到的旧快照覆盖新快照。
- 请求失败时保留上一批数据，只把整块标成 stale，不清空。这两条沿用 snow-app `LspStatusBadge` 的做法。
- 文案要明确这是进程存活状态，不是索引就绪。rust-analyzer 从启动进程到可查询语义之间还有一段时间。
- 设置页「语言服务」栏改为卡片列表：一张卡回答「本机是否已安装」与「该项使用哪档」。未安装的项只提供安装动作
  与一句说明，路径与参数在安装完成之后才出现；`lsp_probe` 一次并行探测全部条目。i18n 中英两份同步补充。

### 分步实施

1. 已做，见下面「已做：第 1 步 配置层」：`lsp_config.rs`，结构体、种子表、原子写、旧 `settings.json`
   的 `lsp` 段一次性迁移；`lsp_config_load` / `lsp_config_save` 两条命令；前端 `lib/lspConfig.ts` 取代 `LSP_SERVERS`
   与 `DEFAULT_SETTINGS.lsp`。
2. 已做，见「已做：第 2 步 探测与安装」：`lsp_probe.rs` 与 `lsp_probe` / `lsp_install` 两条命令；
   `sys.rs` 的 `which` 没并进来，探测自己那套候选顺序在 `lsp_probe.rs` 里，`lsp.rs` 反过来用它。
3. 已做，见「已做：第 3 步 会话生命周期」：`lsp.rs` 会话表改确定性 key、ensure 幂等、失败退避、
   空闲回收与上限淘汰，加 `lsp_session_statuses` / `lsp_failed` / `lsp_retry`。
4. 已做，见「已做：第 4 步 根解析」：`lsp_detect.rs` 与 `lsp_resolve_root`，`lspClient.ts` 用它定根，
   会话 key 交给后端。
5. 已做，见「已做：第 5 步 状态查看与设置页」：底部状态条那段与弹层、设置页列表改造、中英文案。

每步都能单独验：1 看文件内容，2 看探测结果，3 看任务管理器里的进程数，4 看子目录 Rust 工程的跳定义，
5 看界面。

### 已做：第 1 步 配置层

- `src-tauri/src/lsp_config.rs` 一个模块管完：`LspServerConfig` / `LspConfig` 两个结构、`seed()`
  12 项（Windows 11 项，`sourcekit-lsp` 不入）、`normalize` 与 `clamp` 做归一化、
  `migrate_from_settings` 读旧段、`load_in` / `save_in` 收发文件。
  文件读写按目录参数化，命令壳只做 `app_config_dir()` 解析，这样落盘那段能单独测。
- `lsp_config_load` / `lsp_config_save` 进注册表。`sys.rs` 新增 `write_atomic`（`.tmp` 再 rename），
  `settings_save` 一并改用。
- `settings.rs` 的 `LspSettings` / `LspServerSettings` 与 `Settings.lsp` 删除。
  旧 `settings.json` 里残留的 `lsp` 段被 serde 忽略，只在生成 `lsp.json` 那一刻被读一次。
- 前端新增 `lib/lspConfig.ts`（类型 + `loadLspConfig` / `saveLspConfig` +
  `modesFor` / `programOf` / `serverEntries` / `serverForLanguage`）与 `hooks/useLspConfig.tsx`。
  `main.tsx` 把它和通用设置一起 await，首帧 reconcile 就有配置；`App.tsx` 传的是 `lspConfig` 而不是 `settings`。
- `lib/settings.ts` 里的 `LSP_SERVERS`、`LspSettings`、`mergeLsp` 全删，默认表只在前端一处变成了只在后端一处。
- `lspClient.ts` 收 `LspConfig`：`mode === "lsp"` 才起进程；
  `initialize` 带 `initializationOptions`，并按 `startupTimeoutMs` 设时限（原来没有时限，
  进程活着但不回 initialize 会永远挂着）；provider 回调按模块级 `current` 查语言归属，
  那份配置在每次 reconcile 开头落地。
- i18n 补 8 个 server 名（clangd / csharp-ls / kotlin-lsp / intelephense / ruby-lsp /
  lua-language-server / sourcekit-lsp），`lsp.note` 改成不再逐个点名。
- 单测 10 条：键不被 `rename_all` 改写、非法档位退回种子、空字段按种子补、自填 server 的键保留、
  种子档位全合法、首次读生成完整一表、同目录旧设置迁移进来、坏文件退回种子并重写、写盘前先归一化。
  本机 `npm run test:rs` 仍受 `0xc0000139` 限制（见 `../../backend/toolchain.md`），
  这 10 条已将纯逻辑与文件读写抽取到独立工程执行，全部通过。
- 待人工：跑一次应用看 `lsp.json` 实际落地（这台机器 1420 端口上已有一个 dev 实例在跑，没去动它）。

### 已做：第 2 步 探测与安装

- `src-tauri/src/lsp_probe.rs` 负责「是否已安装」与「如何安装」。候选名按 `PATHEXT` 逐个构造，并额外补充一份
  `.ps1`：npm 的 cmd-shim 会同时生成 `.ps1`，而 `PATHEXT` 默认不含该扩展名，不补充会出现「探测判定不存在、
  spawn 却能成功」的分歧。带分隔符的写法直接按路径处理，不再拼候选。
- 搜索目录是进程 PATH 再加几个安装后不会立即进入 PATH 的位置：`%APPDATA%\npm`、
  `%LOCALAPPDATA%\Programs\Python\Launcher`、`%LOCALAPPDATA%\Microsoft\WindowsApps`、`~/.cargo/bin`、`~/go/bin`；
  非 Windows 另加 `~/.local/bin`、`~/.npm-global/bin`、`/usr/local/bin`、`/opt/homebrew/bin`、
  `/home/linuxbrew/.linuxbrew/bin`。去重且只保留确实存在的目录。
  `augmented_path()` 把这份表拼成 PATH，启动语言服务时覆盖继承来的那一条：GUI 进程使用登录时的环境快照，
  安装 rustup 或 npm 全局包后新增的目录对其不可见。
- `is_functional()` 只对 `rust-analyzer` 额外执行一次 `--version`。rustup 的占位 shim 正好位于该文件名上，
  组件未安装时文件存在但无法启动，仅判断文件存在会得出错误结论。
- `resolve_command()` 带 10 秒缓存，同一轮内设置页与 `lsp_start` 得到同一个结果。
  `lsp.rs` 的 `resolve_program` 改为转调它，两处共用同一份候选顺序，不再出现「界面判定未安装、spawn 却能成功」。
- `lsp_install` 执行配置中的 `installCommand`：Windows 使用 `%COMSPEC% /D /C`，其余使用 `/bin/sh -c`，
  不设超时（全局安装通常需要数分钟）。使用 shell 是因为该命令本身是多个包管理器串联的容错链，不是单程序加参数。
  stdout 与 stderr 合并后只保留尾部 32 KiB，截尾按字符处理，不按字节截断多字节序列。
- `lsp_probe` 探测全部条目并做单向校正：只把「启用外部档但本机未安装」的档位回退为 `off`，安装完成后不自动启用，
  因为用户可能有意保持该项关闭。确有改动时才写回 `lsp.json`，校正后的配置连同报告一起返回，
  前端拿到后不再回写，避免两侧各落盘一次。该逻辑只在界面主动请求探测时执行，不在应用启动时执行。
- 单测 6 条：带分隔符的写法只算一份候选、空名没有候选、`PATHEXT` 缺少 `.ps1` 时补上、已存在就不重复补充、
  搜索目录只保留确实存在的、拼出的 PATH 非空。取尾与单向校正两段需要实际执行安装才能覆盖，未单独测试。

### 已做：第 3 步 会话生命周期

- 会话表的键是 `<窗口>::<server 键>::<根>` 三段拼出来的，`lsp_start` 收 `window` / `server` / `root` /
  `program` / `args`，返回的就是这个键，前端后续 `lsp_write` / `lsp_stop` 都拿它当 id。
  同一身份再调一次直接回原 id，不重起进程。窗口名进键是因为事件是广播给所有窗口的，
  哪个窗口起的会话只有那个窗口自己会去读。
- 另有一张「正在启动」表加一把条件变量：并发请求同一身份时，后到的等待前一条完成后再返回，不重复 spawn。
- 失败退避单独一张表。启动失败或握手超时记录一次，允许重试的时刻按 `5s*2^n` 推后、上限 300 秒，
  连续超过 2 次后不再自动尝试，`lsp_start` 直接返回 `LSP_START_LIMIT`。启动成功即清除记录，退避只针对连续失败的情况。
  前端侧（initialize 超时、未收到返回）调用 `lsp_failed` 计入同一张表，两侧共用一个计数器。
- 回收不使用定时器：每次启动之前执行 `sweep()` 扫描一遍，空闲超过 `idleTimeoutMin` 的先回收，总数仍达到
  `maxSessions` 时摘除最久未使用的一条。`last_used_ms` 由 `lsp_write` 刷新，因此「在使用」的定义是确实发送过消息。
  会话只在实际使用时才需要腾出位置，单独的定时线程只会增加一个唤醒点。
- `lsp_session_statuses` 是实时采集的：`try_lock` 住 child 再执行 `try_wait`。锁被占用时不返回错误，上报
  `running` 并附一句「本轮未采集到」；从未启动成功、只存在于失败记录中的那些合成一条 `dead`，按 id 前缀过滤当前窗口。
  `running` 只表示进程存在，不表示服务器已完成索引，界面文案按此口径撰写。
- 读线程遇到 EOF，或退出并非本模块主动发起时，记录一次失败，让下一次 reconcile 走退避而不是立即重试。
- `lsp_reap` 保留，页面开头调用一次，回收上一次遗留的会话。
- 单测保留第一轮那些（`parse_args` 的引号规则 4 条、`take_message` 的分帧 6 条、`find` 1 条）。
  退避、淘汰与状态合成三段需要实际启动进程才能覆盖，未单独测试，依靠后文的人工验收条目兜底。

### 已做：第 4 步 根解析

- `src-tauri/src/lsp_detect.rs` 按配置中的 `rootMarkers` 确定真正的项目根。先用文件所在目录向上查找，
  越出工作区根即停止；未命中时再从工作区根向下扫描 2 层，跳过 `node_modules` / `.git` / `target` / `dist` /
  `build` / `out` / `vendor` / `__pycache__` / `.venv`。标志名支持 `*` 前缀（如 `*.csproj`）。
- 标志表为空时直接返回工作区根，这条让未配置 `rootMarkers` 的自填 server 同样可以启动。
- 结果缓存 60 秒，键是「标志表 + 工作区根 + 文件路径」拼出的字符串，因此更换标志表或更换文件都会重新扫描；
  目录不存在、未命中一律返回 null，不报错。
- `lspClient.ts` 一侧：`reconcileOnce` 先按 (server, 根) 分组，每组一条会话，`initialize` 的 `rootUri` 和
  后端 `lsp_start` 的 `cwd` 都用这一组自己的根，不是工作区根。请求侧按路径挑最深的那个根来发，
  所以两个 crate 工程各有一套索引。
- 文档 URI 一律使用规范化之后的字符串作为键。若存原始路径、查 `uri.toString()`，Windows 上盘符大小写与分隔符
  不一致，请求会被「该文件未打开过」拦下，hover / 补全 / 跳转定义全部静默失效。
- 档位是 `lsp` 但根没解析出来的，记一条跳过说明（「没找到标志文件（…」），不静默消失。
- `pathWithin` 与 `samePath` 一起收进 `lib/format.ts`，路径比较那套规则（统一分隔符、Windows 形状忽略大小写）只有一份。

### 已做：第 5 步 状态查看与设置页

- `src/components/LspStatusBar.tsx`：底部状态条增加一格计数，点开是弹层，每行一条会话，显示 server、项目根、
  状态与说明。只列当前窗口。
- 该格只在已打开项目且至少有一项切换到 `lsp` 档时绘制，否则不占用状态条位置。按钮上的数字是运行中的会话数，
  存在异常或采集失败时按钮转红，悬停文案随之变化（几个存在异常 / 状态获取失败 / 没有运行中的会话）。
  弹层底部一条「打开设置」。
- 每行两个动作：重试（`lsp_retry` 清除退避记录，再触发一次 reconcile）与停用（把该项 `mode` 写为 `off`）。
  动作不叫「停止」：仅调用 `lsp_stop` 而配置未变时，下一次 reconcile 会按原配置重新启动，按钮标注停止与实际
  效果不符。
- `src/hooks/useLspConfig.tsx` 是配置的唯一持有处：`config` / `patchServer` / `probes` / `reprobe` / `probing`，
  外加一份会话状态（`sessions`）。修改后立即落盘并触发一次 reconcile，没有「应用」按钮。
  探测回来的那份配置走 `skipSave`，不再写盘。
- 设置页「语言服务」栏一项一卡，左右两栏。左侧两行：第一行是语言的显示名加档位下拉，第二行以「语言服务」标注
  那个进程的名字与参数（悬停是探测到的完整路径）。`gopls`、`csharp-ls`、`intelephense` 是进程的名字，
  分别管 Go、C#、PHP；原先按 server id 查一份界面名表，表里只登了五项，其余七项直接退回显示 id，
  看起来就像列表里多了七个看不懂的语言。现在语言名一律按 `languages` 里的 Monaco 标识符从
  `monacoEnv.languageLabel` 取，与状态栏同一份来源，不再另存一张表；一个服务管多种语言时并列显示。
  右侧依次为会话状态、安装状态、动作按钮、编辑。
- 动作按钮按状态给一种，不缺档：本机未安装是「安装」；已安装、启用外部档、当前项目尚未启动是「启动」；
  已有会话则改为「重启」。位置与样式相同（`.lsp-action`），只更换图标与文案，同一时刻只允许一个操作在进行
  （`waking`）。未安装的项在档位下拉中不提供「外部 LSP」选项（探测已把该项回退为 `off`，安装完成之前没有可启用的
  进程）。会话状态的悬停内容是每条根一行 `根：说明`。卡片底部一行只写下一步：未安装提示安装、未探测提示探测、
  已安装但未启动则说明失败原因（该原因来自 `watchLspStatus`，文案中带搜索的目录与标志文件列表）。
  卡片不加装饰色条，档位下拉本身已表明状态。
- 「启动」不等待用户打开该语言的文件，立即在当前项目中拉起进程，走 `lspClient.wakeLsp`：`lsp_resolve_root`
  确认该语言的项目根 → `startServer`（启动进程、挂订阅、完成握手）→ 再同步一次文档。必须走这条路：绕过
  `startServer` 自行 spawn 的会话不在 `running` 表内，既不会收到 `didOpen`，`lsp://exit` 也无法认领，空闲回收
  同样找不到它，结果是一个无人管理的孤儿进程。返回的是结构化结果而不是状态标记：已有会话记 `running`，
  不重复启动；项目内找不到标志文件记 `no-root`，同时带回搜索的目录与该项的标志文件列表；进程无法启动或
  握手未完成记 `failed`，`detail` 即后端返回的原文。未打开项目时按钮置灰，悬停说明无法确定启动目录。
  启动完成后触发一次 reconcile，会话轮询随即再采一轮。点击启动的同时用户正在编辑是常见情况，两趟会选中同一条
  会话键，因此 `startServer` 上加了一把 `starting` 键锁：在途的那一趟完成之前，第二趟直接并入，同一条进程不会被
  `initialize` 两次。
- 「重启」是另一条路径：`lsp_retry` 清除后端的退避记录并停止进程，`lsp://exit` 让 `lspClient` 丢弃该条会话，
  下一次 reconcile 重新拉起。该按钮只在存在会话时出现，因为没有会话就没有可清除记录的 id。
- 报错与日志均可复制：状态条弹层中每条会话的失败原因整段换行显示并附复制按钮（此前按宽度截断，
  只能悬停查看，无法取用）；设置页卡片底部的失败回执同样附复制按钮；卡片上另有「日志」按钮，
  打开后是该项最近 200 行的标准错误输出（由 `lsp://log` 按行汇入），可整段选中、一次复制全部、可清空。
  有一类输出早于 `lsp_start` 返回（进程一启动即崩溃的情况），此时前端尚无法确定会话所属项，这几行先按会话 id
  暂存，`startServer` 确认之后并入该项，不会丢失；事件订阅也提前到拉起进程之前挂好。
  进程退出时补一行退出码，因此复制到的内容自带结尾。安装确认弹窗中的命令行设为单击整段选中。
- 翻译文案不能把上游的错误吞成一句通用提示：后端一句错误是「错误码 + 分段参数」拼起来的，`explain` 先按错误码
  取对应译文，再把原文的码与参数附在括号里；本来就是一句系统报错、无码可译的那些只留原文。
  `startServer` / `launchSession` 因而改为把失败字符串回传，而不是只发一个状态徽章；`lsp_resolve_root` 报错也不
  并进 `no-root`，单独记 `failed`。「未找到标志文件」这类通用文案只在确实没有上游错误可取时才作为兜底出现，
  存在标准错误输出时回执末尾再追加一句指向「日志」。
- 安装命令原文不常驻界面，也不放在悬停里：点击安装先出现确认弹窗，命令显示在弹窗中，并说明该操作会修改本机
  环境（全局安装）。确认之后弹窗立即关闭，进度回到卡片按钮上（安装常需数分钟，保留模态窗口没有意义）。
  安装成功不额外留言，徽章变为「已安装」即是回执；失败时才把退出码与输出尾部保留在卡片一行内。
- 编辑弹窗（`LspDialogs.tsx`）包含全部字段：档位、命令、可执行文件路径、启动参数、语言、标志文件、
  安装命令、握手超时、`initializationOptions`。列表类字段以逗号分隔，`initOptions` 是 JSON 文本框，
  保存前校验：不是合法 JSON、未写成对象、命令或语言为空都会拦下。超时限制在 5 秒到 10 分钟之间。
  字段高度超过一屏时弹窗自身滚动，取消与保存固定在底部。
- 「重新探测」位于标题行右侧，与通用页的「恢复默认值」同位。进入该栏自动探测一次，仅一次。
  行序按安装状态排列：已安装的在前，未安装的次之，未探测的在后，同组内保持落盘的字典序，安装完成后该项前移。
  栏顶一条汇总：共几项、本机已安装几个、几个使用外部服务。
- 会话状态只有一份轮询：`hooks/useLspSessions.ts` 每 3 秒采一次，挂在 `useLspConfig` 的 provider 上，
  底部状态条与设置页读的是同一份，不再各排各的定时器。上一次落定之后再排下一次，
  慢响应不并排发，后到的旧快照盖不掉新快照，读不到就留着上一轮并标陈旧。
- 文案：`errors.ts` 加五条码（`LSP_START_BACKOFF` / `LSP_START_LIMIT` / `LSP_NO_SERVER` /
  `LSP_NO_INSTALL` / `LSP_INSTALL_SPAWN`），zh / en 两份各补对应句子、八个 server 名、
  状态条那段（`lsp.bar.*`）、三种会话状态与动作按钮（`lsp.wake*`）；`lsp.note` 重写，不再逐个点名。
  两份字典由 `Record<TranslationKey, string>` 约束，缺少任意一条即编译失败。
- `main.tsx` 起手把 `loadSettings()` 与 `loadLspConfig()` 并读，两份都到位才渲染；
  `termReap` 之后紧跟 `lspReap`，这条走 `lib/lsp` 那个薄壳，不引 `lib/lspClient`，
  否则启动路径上会多打出一个几百模块的 monaco chunk。

### 不抄的部分

- 运行时依赖：tokio、async-lsp、lsp-types、tower-async-lsp。
- 协议实现：`client.rs` 的请求封装、`session.rs` 的状态机、`format.rs` 的 agent 输出。
- agent 工具面：批量诊断、call hierarchy / type hierarchy、rename 预览凭证、prompt context。
- 能力表过滤（`capabilities.rs`）：forge 的 provider 是前端固定注册，没有「按已启用服务器能力
  动态暴露子工具」这一层需求。
- 配置存储：SQLite 表、`lsp_server_configs` 建表、`project_lsp_server_configs` 项目级覆盖、
  legacy `lsp-config.json` 迁移。forge 的定位是全局设置，项目级覆盖不做。
- 持久化诊断缓存（`lsp_diagnostic_cache`）。forge 不做 agent 侧诊断复用。

### 第二轮验收

代码侧已核对的（单测或在独立工程中执行通过）：

- 删掉 `lsp.json` 重开应用：文件按种子重建，12 个 server（Windows 无 swift）都在，
  `mode` 除 `typescript` 为 `builtin` 外全是 `off`。
- 旧 `settings.json` 带 `lsp.servers.typescript.mode = "lsp"`：迁移后 `lsp.json` 里该项为 `lsp`，
  `settings.json` 里那段不再被读，第二次启动不重复迁移。
- 手动修改 `lsp.json` 写入非法 `mode`：该项回退为种子值，其余项不受影响；文件损坏时同样回退为种子并补齐一份完整配置。
- 同一 server 连续启动失败：第 1 次等待 `5s`、第 2 次等待 `10s`（`5s*2^n`，上限 300 秒），累计到第 3 次之后
  `lsp_start` 直接返回 `LSP_START_LIMIT`，不再自动尝试；状态弹层该行的说明中包含「连续失败次数、还需等待多久」。
  执行 `lsp_retry` 清除记录后可立即重试，启动成功也会自动清除计数。

要在界面里人工核对的：

- 未安装 gopls 时打开 Go 项目：设置页该行徽章为「未安装」，状态条中不含 gopls；点击安装执行
  `go install ... gopls@latest`，输出尾部显示在该行下方；安装后重新探测变为「已安装」，档位仍需手动切换。
- 在 `Cargo.toml` 位于子目录的项目中打开 `.rs` 文件：状态弹层中的 root 是该子目录，跳转定义可跨文件。
- 空闲回收只在下一次启动会话时扫描，因此该条需要这样验证：让一条会话空闲超过 30 分钟，再打开另一种语言的文档，
  此前那条应被回收，任务管理器中不残留语言服务进程。
- 窗口关闭后 `lsp_reap` 清理彻底；两个窗口并排时，关闭其中一个不影响另一个，状态段只显示当前窗口的会话。
- 会话启动后底部状态条该格的计数与弹层内容一致；将较慢的 server（jdtls）设为 `lsp`，
  握手超时那行应显示退避说明，点击重试能够再次启动。
- 动作按钮的三种状态：未安装 gopls 的机器上显示「安装」；安装完成后不打开 `.go` 文件时卡片显示「启动」，
  点击后按钮变为「正在启动…」，数秒后改为「重启」，底部状态条该格同时加一，任务管理器中多出一个 `gopls`；
  此时打开一个 `.go` 文档，补全与悬停直接可用（无需等待第二次 reconcile 启动进程）。
  在纯 JS 项目中点击「启动」，卡片应显示「未在项目「该项目的绝对路径」中找到该语言的标志文件（go.mod）」，
  且不遗留进程——该次调用没有走到 spawn。
  未打开项目时「启动」为禁用状态，悬停说明无法确定启动目录。
- 点击「重启」之后任务管理器中旧的 `gopls` 进程消失、新进程启动（PID 已变化），
  期间不出现第二个同语言的孤儿进程。
- 失败原因需包含原始错误码与搜索目录：将某项 `program` 改为不存在的名称后点击「启动」，卡片回执除对应的中文文案之外，
  括号里还应出现 `LSP_NOT_FOUND / 该程序名` 这样的码与参数，而不是只剩一句通用提示；
  整段可复制。把 `args` 写成会让进程立即退出的内容，回执末尾追加一句指向「日志」。
- 报错与日志可复制：将某项的 `program` 改为不存在的名称，触发启动失败，状态条弹层该行给出完整原因，
  点击复制按钮可取得整段文本（不再只有省略号）；设置页卡片底部的回执同样带复制按钮。
  再将 `rust-analyzer` 的路径指向一个立即退出的程序，卡片上出现「日志」按钮，
  打开后可见该进程写入标准错误的各行，「复制全部」取得的内容与弹窗显示一致，「清空」后按钮消失。

### 待人工验收：档位与降级（第一轮那几条，落盘位置已改）

- 设置页「语言服务」栏：已安装的项是带路径与参数的卡片，未安装的项只有安装按钮与一句说明，无法切换到外部档。
  `typescript` 三档，其余两档。修改后立即生效，无「应用」按钮，落盘写入 `lsp.json`。
- 手动修改 `lsp.json`，把某个 `mode` 写成非法值，重开应用后该项回退为种子值，其余项不受影响。
- 全部使用默认值（`typescript` 走 `builtin`）：打开 TS 文件，报错表现与接入 LSP 之前一致，来自内置语义。
  该条用于确认没有回归。
- 把 `typescript` 切到 `lsp`：相对路径 `import` 不再报错，鼠标悬停只弹出一个框，跳转定义可到达同工程另一个文件。
- 把 `typescript` 切到 `lsp` 但路径指向不存在的文件：回退到内置语义，设置页该栏显示「未找到」，
  `lsp.json` 中的 `mode` 仍为 `lsp`。
- 把 `rust-analyzer` 切到 `lsp`：`.rs` 文件悬停显示类型，`F12` 跳转定义。该条验证「新增语言只需修改注册表」这一结论。
- 说明：本机的 Tauri 测试二进制当前无法执行（`0xc0000139`，缺少 WinRT 导出的 DLL），
  `npm run test:rs` 会失败，这不是本次改动引入的。全部单测逻辑已在独立工程中执行，23 条通过
  （`lsp_config` 10、`lsp_probe` 6、`lsp_detect` 7），待本机可运行 `cargo test` 后再复跑。
  `npm run check:rs`、`npm run check:ts` 与 `npm run build` 均通过。
- 启动 `npm run tauri:dev` 之前需要先停止本机 1420 端口上的 vite 实例，该端口被占用时 dev 无法启动。

## 未做

两轮代码都已落地，协议层对着真实 server 验过（见「已做」的端到端验证），上面「第二轮验收」与
「待人工验收」是还没在界面里过的那几项。往后要做的：

- 首次切入 LSP 时的启动延迟与内存。独立进程加真实工程解析（rust-analyzer 首次索引尤其重）比 worker 重得多，
  需要实测再定要不要给一个更显眼的「正在启动语言服务」状态。设置页已有状态点，够不够看实测。
- 文档同步目前每次都发全文（`contentChanges: [{ text }]`）。协议上合法，但大文件每次击键传全文偏费。
  真觉得卡再换成增量 range 变更。
- 项目级覆盖不做（见「不抄的部分」），真要按工程换 server，得先决定配置往哪儿放。
- 添加与删除某一项没做。snow-app 那两颗按钮背后是数据库表，删一行就少一行；forge 的 `lsp.json`
  是「种子表 + 用户改过的那几项」，`normalize` 会把种子里缺的键补回来，所以删掉一项会在下一次写盘时复活。
  要真支持删除，得先记一份「用户删过哪些键」，或把种子改成只在文件完全不存在时铺一次。
  自填 server 现在仍然能加：手改 `lsp.json` 写一个新键，`normalize` 认它（单测
  `custom_server_keys_are_kept` 钉着），编辑弹窗那套字段全都用得上。

## 出处

| 文件 | 内容 |
| --- | --- |
| `src/lib/monacoEnv.ts` | `languageForPath` 那两张表 `:75` 起（扩展名与文件名特例）；`languageLabel` `:125-126` |
| `src/lib/monacoEditor.ts` | worker 分派 `:19-40`；`modelUri` `:43-45`；别名表 `:76-86`；`attachMonacoBridge` `:133` |
| `src/hooks/useDocuments.ts` | 建 model 时的 `language` 由 `languageForPath(path)` 定 `:198`、`:471`，语言服务的语言归属跟着它 |
| `src-tauri/src/lsp.rs` | 会话表与 `Session` `:23-41`、失败表与 `backoff` `:51-72`、`SessionStatus` `:113-126`、`parse_args` `:142`、`build_command` `:172`、`session_id` `:188`、起锁 `:196-224`、`backoff_error` `:226`、`sweep` `:263`、`lsp_start` `:307`、`spawn_session` `:334`、`read_loop` `:400`、`stderr_loop` `:436`、`take_message` / `find` 解帧 `:460-484`、`lsp_write` `:491`、`lsp_stop` `:505`、`lsp_reap` `:532`、`lsp_session_statuses` `:544`、`lsp_failed` `:633`、`lsp_retry` `:639`、单测 `:665` 起 |
| `src-tauri/src/lsp_config.rs` | 两个结构 `:18-58`、`allowed_modes` `:60`、`seed` `:105-324`、两个默认常量 `:326-328`、`effective_program` `:332`、`normalize` `:354`、`clamp` `:384`、`migrate_from_settings` `:427`、`load_in` `:463`、`save_in` `:485`、探测报告结构 `:507-524`、两条命令 `:527-536`、单测 10 条 `:539` 起 |
| `src-tauri/src/lsp_probe.rs` | `PROBE_TTL` `:19`、`OUTPUT_TAIL` `:22`、`candidates` `:52`、`search_dirs` `:84`（进程 PATH 在前，补的那几个目录垫后）、`augmented_path` `:131`、`is_functional` `:143`、`resolve_command` `:170`、不带缓存的那段 `search_command` `:190`、`run_install` `:212`、两条命令 `:252-273`、`probe_and_reconcile` `:276`、单测 6 条 `:302` 起 |
| `src-tauri/src/lsp_detect.rs` | `CACHE_TTL` `:15`、`MAX_DEPTH` `:17`、`SKIP_DIRS` `:19`、`marker_matches` `:39`、`hit_in` `:50`、`search_up` `:87`、`search_down` `:103`、`resolve` `:140`、`cached` `:162`、`lsp_resolve_root` `:188`、单测 7 条 `:208` 起 |
| `src/lib/lsp.ts` | 前端 API 壳，与 `lib/term.ts` 同构：十二条命令 `:71-132`、状态与探测的镜像类型 `:26-68` |
| `src/lib/lspConfig.ts` | 类型镜像 `:12-46`、`modesFor` `:49`、`programOf` `:54`、`serverEntries` / `serverForLanguage` `:59-70`、读写 `:72-83` |
| `src/hooks/useLspConfig.tsx` | 配置持有、探测缓存与一份会话轮询：`patchServer` `:58`、`reprobe` `:66`、`skipSave` `:48`、`sessions` `:84` |
| `src/components/LspStatusBar.tsx` | 状态点与文案 `:12-23`、`wanted` `:49`、未打开项目或没有外部档时不绘制 `:50`、会话取自 provider `:52`、`entriesById` `:55`、重试 `:66`、停用 `:72`、弹层一行的语言名与进程名 `:100-131` |
| `src-tauri/src/sys.rs` | `hide_console`、`is_file`、`env_path`、`env_raw`、`which` 共用的工具，另有 `write_atomic` `:25-33` |
| `src-tauri/src/proc.rs` | 进程通道参照 `:98-165`；stdin `Stdio::null()` 的对照；树杀 `:167-188` |
| `src-tauri/src/term.rs` | `shell_probe` 探测范式；`push_shell` / `resolve_shell` |
| `src-tauri/src/settings.rs` | 分组结构；`Settings` 与 `Default` `:120-164`；`settings_save` 走 `write_atomic` `:192`。`LspSettings` / `LspServerSettings` 已删，旧文件里的 `lsp` 段读到时忽略，单测 `old_lsp_section_is_ignored` 钉住这条 |
| `src/lib/settings.ts` | `LSP_SERVERS` 注册表、`LspSettings`、`mergeLsp()` 已全删，语言服务那段搬去 `lib/lspConfig.ts` |
| `src/lib/lspClient.ts` | 前端客户端：会话键 `:74-116`、`roots` 缓存与 `ROOTS_TTL` `:118`、`initialize` `:167`、`starting` 键锁 `:220`、`startServer` `:223`、`launchSession` `:235`（订阅在 spawn 之前挂上，失败字符串原样回传）、输出日志的保留与并入 `:316-379`（`appendLog` `:338`、`lspLogs` `:362`、`clearLspLogs` `:375`）、`handleExit` `:426`、`reconcileLsp` `:860`、`reconcileOnce` `:886`、`syncDocuments` `:952`、`WakeResult` `:994` 与 `wakeLsp` `:1011-1039`、`shutdownLsp` `:1042`；`handleMessage`、`applyDiagnostics` / `findModelByUri`、各 provider 与枚举映射、`configureBuiltin`、`watchLspStatus` 保持第一轮的形状 |
| `src/lib/format.ts` | `normPath` `:102`、`samePath` `:111`、`pathWithin` `:119` |
| `src/lib/window.ts` | `windowLabel` `:13`，会话身份的第一段 |
| `src/lib/errors.ts` | LSP 九条码的映射 `:78-89` |
| `src/components/SettingsPage.tsx` | 「语言服务」栏 `:566-733`：卡左（语言显示名取 `languageNames` `:575` + 档位下拉、第二行以「语言服务」前缀 `:613` 标注进程名与参数）、卡右（会话状态、安装状态、安装按钮 `:644`、启动／重启按钮 `:664-691`、「日志」按钮 `:693-702`、编辑）、卡底带复制按钮的回执两行 `:712-724`；行序 `probeRank` `:105-108` 与 `lspRows` `:284`；会话汇总 `runtimeOf` `:121-125`；日志订阅 `:159-170`；自动探一次 `:182-186`；`explain` 解码上游错误 `:194`；安装 `:207`；重启 `:229`；`wakeNote` `:254` 与启动 `:267`；三个弹窗的接线 `:735-766` |
| `src/lib/monacoEnv.ts` | 语言显示名的唯一来源：`LANGUAGE_LABELS` `:87-122`、`languageLabel` `:125`、`languageNames` `:135`。设置页卡片、编辑弹窗标题行、状态条弹层三处都取它，不再有按 server id 查界面名那张表 |
| `src/components/LspDialogs.tsx` | 编辑弹窗 `:42` 起：标题行 `语言 · 服务名` `:129`、`lsp.dialog.program.hint` `:166`、九个字段、`initOptions` 的 JSON 校验与超时夹区间；安装确认弹窗 `:287`（命令原文只在这里）；输出日志弹窗 `:343`（整段选中、复制全部、清空） |
| `src/components/CopyButton.tsx` | 复制开关：写剪贴板、两秒内改口「已复制」，报错行与日志行共用 |
| `src/hooks/useLspSessions.ts` | 一份轮询两处用：`POLL_MS` `:7`、序号丢旧快照 `:31-49`、落定之后再排 `:51-67` |
| `src/App.tsx` | `lspDocuments` `:291`、reconcile effect `:299-305`（文档列表 / 工作区 / 配置变动 / 重试时触发一次）、`wakeLspServer` `:308`、设置页「启动」按钮的接线 `:2562-2566`；状态条挂点 `:2646` |
| `src/main.tsx` | 两份配置并读 `:16`、启动时 `termReap` `:20-21` 与 `lspReap` `:22-23`（走 `lib/lsp`，不引 `lib/lspClient`，避免启动路径多打一个 monaco chunk） |
| `node_modules/monaco-editor/monaco.d.ts` | `ModeConfiguration` 全集 `:9926-9985`；`setModeConfiguration` `:9992`；`typescriptDefaults` / `javascriptDefaults` `:10164-10165`；`monaco.languages.typescript` 已废弃、入口在顶层 `monaco.typescript` `:10260` |
| `docs/features/code-editor/README.md` | worker 与语言映射、颜色链路、三套键位、右键菜单四段 |
| `docs/features/settings/README.md` | 结构、默认值表、解析失败退回、改动即时生效 |

### 参照（snow-app，不在本仓库）

| 文件 | 内容 |
| --- | --- |
| `docs/zh-CN/4-架构与开发/7-LSP外部语言服务器接入设计.md` | 会话粒度、关键参数、安装状态识别的设计与理由 |
| `native/src/mcp/servers/lsp/probe.rs` | `executable_candidates` `:20`、`is_executable_functional` `:57`、`get_augmented_search_dirs` `:88`、`resolve_command` `:151` |
| `native/src/mcp/servers/lsp/detect.rs` | `markers_for_lang`、`find_lang_root`、60s TTL |
| `native/src/mcp/servers/lsp/manager.rs` | 参数表 `:27-40`、`SessionStatus` `:44`、`failure_delay` `:77`、`session_statuses` `:666`、`stop_session` `:753`、`start_session` `:782`、`restart_session` `:807` |
| `native/src/mcp/servers/lsp/client.rs` | `initialize_timeout_for` `:108`、`spawn_client` `:206`、`initialize` `:508` |
| `native/src/storage/services/lsp_server_configs.rs` | `default_seed_servers` `:364` 起，12 语言的命令 / 参数 / 扩展名 / 安装串 |
| `src/main/ipc/handlers/configHandlers.ts` | 安装通道 `:343-431`、探测与状态通道 `:273-338` |
| `src/renderer/components/mainContent/chatInput/LspStatusBadge.tsx` | 轮询排程 `:73-111`、stale 保留 `:89-99` |
