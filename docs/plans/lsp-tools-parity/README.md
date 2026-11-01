**状态**：进行中（批次 1–3、5 已实施并通过验证；批次 4 待拍板）
**涉及模块**：lsp-language-servers、settings、shell-layout；后端 `src-tauri/src/lsp_config.rs`、`lsp_probe.rs`
**阻塞点**：LSP 迁移计划（T01–T40）完成的是协议与编辑器 seam；语言服务「工具链 UI」仍是对标 IDE 的旧逻辑——服务目录只有 11 个、右下角没有主动安装提醒、状态栏不显示服务名。

## 背景

对标 IDE 的语言服务体系分两层：协议/编辑器层（LSP 迁移计划已闭环）与工具链 UI 层（本轮范围）。工具链层对标物包含：

- 按 `languages/*.toml`（约 70 种语言）定义的语言服务目录，约 40 个服务，每个带命令、参数、工程根标志与安装提示。
- 完整安装器：npm / go / gem / pip / rustup / GitHub release 等方式，装到受管理目录并自动扩展 PATH，支持进度流、取消、卸载。
- 状态栏组件：服务名文本 + 状态色点（`rust-analyzer +2` 样式），弹层列出每个服务的语言、工程根与错误。
- 主动提醒：服务 missing 时发通知气泡（带 Install 动作，同一服务只提醒一次，切项目根重置）；被其它已装服务覆盖的 missing 不报（`servedByOther`）。

Forge 现状：`lsp_config.rs` 种子表 11 个服务；安装是平台命令字符串、无进度无卸载；状态栏是图标 + 数字；安装入口埋在弹层里，不主动提醒。

## 方案

按价值与风险分四批，前三批复用现有基建（探测、安装命令、会话对档、通知中心 `lsp` 组），不新造轮子：

### 批次 1：服务目录扩展（已完成）

- `src-tauri/src/lsp_config.rs` 的 `seed()` 从 11 个扩到约 33 个：补 vscode-html/css/json-language-server、bash、yaml、marksman、docker-langserver、graphql-lsp、vtsls、clojure-lsp、elixir-ls、dart、terraform-ls、metals、fsautocomplete、perlnavigator、R、sqls、buf、solargraph、basedpyright、ty、cmake-language-server、groovy-language-server 等。
- 每项填 languages（只认 `editorEnv.ts` 已有的语言 id）、rootMarkers、args 与三平台 install 命令；与工具链一起分发、没有独立安装命令的（dart、elixir-ls、R、groovy）留空 `install_command`。
- 明确不做并记录原因：haskell/zig/nix/latex/erlang/ocaml/godot（编辑器语言 id 还没有，服务永远不会路由）、taplo（TOML 在语言表里映射为 `ini`，会误触达 .ini）、powershell-editor-services（需要 zip + 环境变量的自定义启动，等受管理工具目录）、lemminx/phpactor/julia（二进制分发或自定义启动方式不同）。

### 批次 2：右下角主动提醒安装（已完成）

- 当前文档路由为 `missing` 且服务有安装命令时，经 `notificationCenter.notify` 发 `lsp` 组警告气泡，带「安装」动作（复用状态栏已有的 `prepareInstall` 链：先探测再弹确认框）。
- 按「项目根 + 服务」去重，同一服务只提醒一次；`key: lsp-missing-<id>` 让重复条件替换而非堆叠。
- 不做独立安装动作注册层（对标 IDE 的 `tools.install` action）：Forge 的安装入口在状态栏与设置页已有同一条链，气泡动作直接调它，不为一个按钮抽层。

### 批次 3：状态栏与弹层对标 `ServerStatus`（已完成）

- 状态栏按钮 = 色点（红异常 / 绿运行 / 灰空闲）+ 服务名摘要（`rust-analyzer +1`），去掉原来的大括号图标与数字徽标。
- 弹层行按参照逐项对齐：色点 + 服务程序名 + 状态词 + 行尾图标重启按钮（RefreshCw）；「停用」从弹层移除（档位开关只在设置页，与参照一致）；服务错误串整段保留带复制。
- 元信息行：语言名 + 相对项目根（工作区内显示相对路径，外部根显示全路径）。
- 无会话时摘要回退当前文件路由状态词，不再显示长空态文案。
- 已知偏差：参照的 `servedByOther` 抑制由 Forge 的路由 fallback 天然承担（同语言有可用服务时路由不会落在 missing 上）；jdtls 的「下载 JDK」快捷修复未迁（Forge 无 JDK 管理模块）。
- 修复历史遗留布局缺陷：`.popover-item` 是 flex 行布局，路由区此前把块级段落塞进去被压成一字一行的竖条（用户截图实锤）；现在路由区纵排，与 `.lsp-bar-item` 同构。

### 批次 3b：设置页工具页搜索与布局（已完成）

- 设置页「语言与框架 › 语言服务器」顶部加搜索框（按语言名、服务程序名、服务 id 过滤）与「全部 / 缺失 / 已装」三个过滤 chip；无匹配时显示空态文案。
- 列表布局经两轮调整定稿：先按参照 IDE 做了「左列表 + 右详情」master-detail，用户拍板不要右侧详情（多一步选中才能操作），改回全宽平铺卡片——每张卡自带模式下拉、探测徽标、运行状态、安装、启动/重启、日志、编辑按钮与提示行，搜索过滤后逐行渲染。
- 已知偏离：与参照 IDE 工具页的左列表+右详情布局不同，按用户拍板保留平铺卡片；功能项（过滤、安装状态徽标、日志）与参照对齐。
- 实现位置：`src/features/settings/pages/LanguagePages.tsx`（搜索/过滤/卡片列表）、`src/styles.css`（`.lsp-toolbar/.lsp-search/.lsp-chip/.lsp-list/.lsp-card` 系列）；i18n 三语言补 `lsp.search.*` 与 `lsp.filter.*`。

### 批次 3c：服务目录逐项对齐参照（勘误，已完成）

批次 1 的目录是按印象补的，没有跟参照 registry 逐项对账，本轮勘误（`crates/ide-tools/src/registry.rs`
的语言服务条目 ↔ `lsp_config.rs` 种子表全量 diff）：

- **改名对齐**（用户保存过的旧键经 `migrate_legacy_ids` 带到新 id，档位/路径不丢）：`typescript` →
  `typescript-language-server`；`kotlin-lsp` → `kotlin-language-server`（参照的 kotlin-lsp 是 JetBrains
  另一个项目，我们装的从来都是 fwcd 的）；`docker-langserver` → `dockerfile-language-server`。
- **下架**（参照目录里没有、属于批次 1 自行发挥的）：dart、metals、r-language-server、groovy-language-server、
  sourcekit-lsp、cmake-language-server；CMake 换成参照在用的 `neocmakelsp`。
- **补齐**（参照有且 Forge 语言 id 可路由）：svelte-language-server、vue-language-server（参数与 root markers
  按 `languages/svelte.toml`、`languages/vue.toml`）。
- **维持排除并记录原因**：taplo（TOML 在 Forge 语言表映射为 `ini`，会误触达 .ini）、zls / texlab（没有 zig、
  latex 语言 id，服务永远不会被路由）、lemminx（MavenCentral jar 自定义启动，等批次 4 的受管理安装器）。
- **重复观感的根因在显示层**：参照同语言多服务本来就是多条（三个 Python 分析器、两条 TS、两条 Ruby），
  但参照列表行显示的是服务名；Forge 卡片标题此前显示语言名，三行都写「Python」像复制出来的。已改为
  卡片标题显示服务 id，语言名降为详情行小字。
- 验证：`npm run test:rs` 578 项通过（含新增 `legacy_ids_are_renamed_or_dropped` 迁移用例）。

### 批次 4：安装进度、取消、卸载（待拍板，方向性）

- 对标 IDE 的 `ide-tools` 受管理安装器（`<app-data>/tools/` + PATH 扩展 + 流式进度 + 取消 + 卸载 + 版本）是一个独立大件：要么整块迁，要么 Forge 继续用平台包管理器命令（winget/brew/apt）但补进度流与卸载。两条路线成本差一个数量级，拍板前不动。

## 批次 5：语言目录与种子表 1:1（进行中）

上一轮批次 3c 的「逐项对齐」仍是按 Forge 语言 id 能不能路由裁剪的目录，不是对标 IDE 目录的抄本；本轮按
「以参照实现为唯一事实源」重做，范围与结论如下。

### 已完成：语言目录 1:1（72 门）

- `src/lib/editorEnv.ts` 重写为静态语言目录：72 门语言（此前误记 71，参照 `languages/` 目录实际 72 个
  toml）的 id、显示名、扩展名、文件名逐字对齐，包括 `go.mod`、`go.work`、`ocaml.interface` 三个点号 id
  与 `typescriptreact` / `javascriptreact` 两门独立 JSX 语言。
- 编辑器专用补充语言（batch、nsis、solidity、pascal 等 23 门）拆进 `EDITOR_EXTRA`：参与识别与显示，
  不进语言服务目录；`languageChoices` 由 `languageCatalog` 取代（目录全量导出，接口新增）。
- 语法侧配套：`cm/grammars.ts` 的 SPELLINGS 补目录 id → CM 语法名的映射（`shellscript→shell`、
  `go.mod→gomod`、`terraform→hcl` 等）；`cm/extraGrammars.ts` 补 `gowork` 语法。
- `lspClient.ts` 的 `lspLanguageId` 不再按后缀翻译 tsx/jsx——目录 id 本身就是协议 languageId。
- **白屏事故与修复**：文件名通配（`*.Dockerfile`、`.env.*`）生成正则时先转义后替换通配符，产出
  `/*\.dockerfile/`（Nothing to repeat），模块顶层抛错 → 整个前端白屏。修复为逐字符转换（`*` → `.*`，
  其余转义）；`tests/lib/editorEnv.test.ts` 按新目录 id 更新并新增 72 门目录完整性断言。

### 已完成：种子表 1:1（53 个服务）

- `src-tauri/src/lsp_config.rs` 的 `seed()` 推倒重写：服务并集 = 参照 72 个 toml 的
  `[[language-servers]]` 全部条目（主服务 + fallback），program/args/root markers/initializationOptions
  逐字取自 toml（含 jdtls 全量 init options、basedpyright typeCheckingMode=standard、PowerShell
  Editor Services 启动行）。
- 新增 `homepage` 与 `install_hint` 字段：有受管安装方式（npm/go/gem/pip/dotnet/rustup/cargo）的服务
  渲染三平台 `install_command`；没有的（kotlin-lsp、texlab 之外的手装件、godot、elp、nil 等）留空
  install_command 并把官方提示写进 `install_hint`，UI 手动安装提示取这一段。
- 档位策略：toml 主服务缺省 `lsp`，fallback 服务缺省 `off`（Forge 尚无运行时 fallback，同语言双开
  会双起进程）；`typescript-language-server` 保留 `supports_builtin`；`godot`（TCP connect）与
  `powershell-editor-services`（环境变量注入）目录保留但缺省 `off`，偏差已记录。
- `migrate_legacy_ids` 收敛为纯改名（typescript→typescript-language-server、kotlin-lsp→kotlin-language-server、
  docker-langserver→dockerfile-language-server）；批次 3c 下架的 dart/metals/r-language-server 等
  随 1:1 目录回归种子表。
- `tests/lib/lspClient.test.ts`、`tests/lib/lspConfig.test.ts` 补新字段；后端新增
  `seed_matches_reference_catalog`（53 项全列）与 `manual_servers_have_install_hint` 两条契约测试。

### 未完成（下一步）

- **右下角状态栏弹层 1:1（已完成）**：`LspStatusBar.tsx` 的浮层按参照 `ServerStatus.tsx` +
  `ServerStatus.module.css` 逐项重写：340px 面板、头部小字、6px 四档状态点（异常红 / 启动中蓝
  带 1.2s 脉冲 / 在跑绿 / 空闲灰，reduced-motion 关动画）、行结构
  dot + 服务名 + 状态词 + spacer + 行尾动作、meta/message 缩进排版、安装提示等宽可选中。
  missing 且同语言已被别的在跑服务兜住时点色降为灰（`servedByOther` 语义）；按钮摘要
  `rust-analyzer +1` + 四档点色。弹层底部自创的常驻「设置」入口按参照删除，设置入口收敛到
  路由行的动作位（unconfigured → 设置 / missing → 安装）。
- **文件树「正在加载」死锁（已修复 + 回归测试）**：`git check-ignore --stdin` 流式边读边写，
  输入/输出都超过 64KB 管道缓冲时旧写法（先写完 stdin 再读 stdout）两头互等。`run_git_raw`
  的 stdin 写入挪到独立线程；新增 `listing_survives_check_ignore_larger_than_pipe_buffer`
  （3000 个忽略名，输入输出各约 190KB）锁死该场景。
- **探测降级移除（已修复）**：探测不再把「启用但未装」的服务落盘降级为 off——对标 IDE 的
  语义是保持启用、开文件报 missing 并提醒安装。旧配置文件里已被降级的条目要删 `lsp.json`
  重新生成才能恢复（一次性数据损伤，非代码问题）。
- **卸载链路（已完成）**：`uninstall_command` 按包管理器从安装命令推导
  （npm/gem/dotnet/rustup/cargo/pip 可卸载；brew/apt/go install 无可靠卸载路径则不给按钮），
  后端 `lsp_uninstall`、设置页卸载按钮 + 确认对话框、i18n 三语。
- **设置页 master-detail 重写（已完成）**：`LanguagePages.tsx` 从平铺卡片整体重写为参照
  `LanguageServersPage.tsx` + `ServerSettings.tsx`（含两个 module.css）的 1:1：左 264px 列表
  （+/− IconButton、1px 分隔线、Spinner/refresh、搜索框；「全部 / 未安装 (n) / 已安装」三段；
  「可用 n / 缺失 n」分组；行 = 色点徽章 + 服务名（max-width 60%）+ kindTag（内置/已停用）+ 右对齐
  语言名）｜右详情（标题 + 状态徽章、命令行 · 运行状态 · 主页链接、安装/重装/卸载/启动动作行、
  role=alert 错误、notice、日志 linkButton 折叠 pre、ServerSettings 表单：启用勾选、可执行文件
  （名称/路径覆盖/标志文件）、启动折叠段（参数/initializationOptions）、安装折叠段（安装命令/握手超时）、
  「恢复默认」）+ 新增服务对话框（命令/名称/语言勾选浮层）。CSS 变量与 Forge `ideaTokens.css`
  同名（--fg-secondary/--border/--bg-selected 等），module.css 数值逐条搬运到 `styles.css` 的
  `.lsps-*` 系列并删除旧 `.lsp-card/.lsp-action/.lsp-probe` 系列。配套改动：后端新增
  `lsp_config_defaults` 命令（「恢复默认」与种子表逐字段比对后整体替换该项）；安装改为立即执行
  （对标 IDE），卸载保留确认弹窗（破坏性操作）；冒烟脚本设置段同步重写为「点左列表行 → 断言右详情」。

#### 设置页 1:1 的已知偏离（有意为之，非遗漏）

- 参照的安装有受管安装器进度（JobRow 进度条/取消），Forge 是一次性平台命令，不画假进度；
  失败信息直接落在详情栏 role=alert 区并附复制按钮。
- 参照的「Workspace Configuration」节没有迁：Forge 的 `LspServerConfig` 没有 settings 字段，
  加字段要动后端契约，属新功能不属于 1:1 迁移。
- 参照的 Python 分析器选择器没有迁：它依赖参照的设置暂存表单（Apply/OK）与项目作用域，
  Forge 是直接落盘模型。
- 参照的 − 号只对「设置里自定义的服务」可用；Forge 的 lsp.json 本身就是用户文件，− 对任何
  选中项可用但加了确认对话框（从 lsp.json 移除，不卸载本机软件）。
- 参照新增服务是「暂存到 Apply」，Forge 直接落盘并选中，档位缺省 `lsp`。

#### 三轮 review（只针对本轮设置页工作）

- **R1 数据对照**：参照 ToolInfo ↔ Forge `LspServerEntry + LspServerProbe` 逐字段核对：
  status 三态（已装/未装/未探测，未探测计为可用）、canInstall/canUninstall ↔ install/uninstall
  命令非空、installHint ↔ notice、homepage ↔ 副标题链接；probe 无 version 字段，副标题按
  「命令行 · 运行状态 · 主页」组句，不编造版本号。过滤/分组/排序语义与参照一致（可用在前）。
- **R2 UI 对照**：两个 module.css 逐条核对——264px 列表、toolbar margin 8px 8px 6px、segmented
  `--h-control-small` + inset 描边、行高 `--h-row`、rowName 60%、kindTag `--fs-tiny`/16px、
  详情 padding 12px 16px 16px、标题 `--fs-input-large` 600、日志 max-height 240px、表单 gap
  16px/10px、section 标题 22px + 1px 规则线、picker 260px/240px、对话框 90px 网格。Forge
  token 与参照同名，全部原值落地；仅有意增补：错误/提示行加 CopyButton（`lsps-error` 需 flex
  排版）、列表行补 cursor:pointer。
- **R3 行为回归**：`npm run test:lsp-ui-native` 真实窗口 9 项检查全过（自动探测、缺失服务一键
  安装的退出码反馈、stderr 日志面板、手动启动/重启 + 运行状态、右下角当前文件自动识别、签名帮助、
  查找用法、格式化、代码动作、重命名——详见下节验收）；`node scripts/run-rust.mjs test --lib`
  581 项、`npm run test:front -- --maxWorkers=1` 1459 项、`npm run check:ts` 全绿。

### 批次 5b：状态栏弹层截图对照勘误（已完成）

用户拿真实截图对照后（对标 IDE 缺服务态 vs Forge 死会话态），逐项勘误并重写：

- **行语义**：会话死了但探测确认本机没装、或报错含「没找到」（后端 `lsp.rs` 只在
  `resolve_program` 失败时产出这句，状态栏场景探测往往没跑过，这条信号不能省）→ 按
  missing 处理（未安装 + 安装按钮 + 提示语给安装命令/installHint），不再显示
  「启动失败 + 重启图标」；路由 missing 行同样优先显示安装命令。参照的 missing 行
  message 就是那条 npm 命令。回归测试锁死：死会话报「没找到」必须渲染安装按钮与
  安装命令，且不出现重启入口。
- **行布局**：服务名不裁省略号、按 flex 自然换行（`--fg-emphasis`）；状态词用 `--fg-subtle`
  小字；行尾动作换成组件库 `Button size=small`（安装）/`IconButton`（重启），删除自绘
  `.lsp-action/.lsp-icon-action`。CSS token 逐项换回参照名：面板 340px + `--fs-small`、
  行分隔 `--border-popup`、头/状态/meta `--fg-subtle`、message `--fg-muted`、
  `.is-install` 等宽 `--fg` 可选中、状态点 `--success/--accent/--danger/--fg-faint`。
- **根显示 bug**：meta 里的根比较只归一了 workspace 的斜杠没归一 root 的，正斜杠路径永远
  被判成「外部根」整段打印；两边统一 `\\` 归一 + 大小写折叠后再比，相同即省略。
- **顺带修复**：上一轮误删 `.lsp-action` 基础样式导致状态栏按钮裸奔、`.lsp-icon-action`
  选择器重复引发 CSS Unclosed block → 整应用白屏（已删重复行并补齐回归验证）；
  冒烟 harness 用 8.3 短路径（SHENGG~1）下传工作区，与后端 canonicalize 的长路径比较
  永远不等，`realpathSync` 换长路径后下传。
- **tsx/jsx 高亮回归修复**：语言目录 1:1 后 `.tsx`/`.jsx` 的 id 变成
  `typescriptreact`/`javascriptreact`，而 `cm/grammars.ts` 的 WRONG 集合还在把这两个 id
  直接拒成 null（旧目录时代它们从不作为语言 id 出现），整门掉高亮。现按 CM 的实际语法名
  映射（TSX/JSX），围栏标注同样受益；`cmGrammars.test.ts` 的旧契约（react id 必须为
  null）更新为新契约，并用全目录枚举探针确认除 log/nix/zig（本来就没有语法，E-30 范围）
  外无其它断链。
- **安装成功后的卡死行修复**：截图实锤——安装成功、提示「安装完成」后，行仍钉在
  「未安装 + 安装按钮」。根因是「报错含『没找到』→ missing」的判定没有出口：死会话里
  的旧报错永远存在。改为探测结果优先（探测明确已装即不再按 missing 渲染），且安装成功
  后自动 `lspRetry` 该服务的死会话并踢一次对档，服务立刻起来；「安装完成」反馈在行变成
  运行中后隐藏。回归测试：已装探测 + 死会话旧报错 → 不再渲染安装按钮、回到重启入口。
- **验证**：`npm run check:ts`、前端 143 文件 1459 项、Rust 581 项、`npm run build`、
  `npm run test:lsp-ui-native` 9 项检查全部通过。

### 验收（批次 5）

- `node scripts/run-rust.mjs test --lib`：581 项通过（含设置页新增 `lsp_config_defaults` 后的编译与
  全部既有契约测试）；`npm run check:ts` 通过（`npm run build` 在 `test:lsp-ui-native` 内执行通过）。
- `npm run test:front -- --maxWorkers=1`：143 个文件、1459 项通过（含更新后的 editorEnv 契约测试）。
- `npm run test:lsp-ui-native`：真实 WebView 冒烟 9 项检查全部通过——设置页段已重写为 master-detail
  断言（行选择 → 详情动作 → 立即安装的退出码反馈 → 日志面板 → 启动/重启运行状态），编辑器四件套与
  右下角路由段不变；冒烟脚本同步删掉了旧的卡片选择器（`.lsp-card`/`.lsp-action`）。

## 未做与验收

### 已验收（批次 1–3）

- `npm run test:rs`：578 项通过（含扩展后 seed 表的 normalize/迁移测试与旧 id 迁移用例）。
- `tests/components/LspStatusBar.test.ts`（新增）：missing 路由触发一次带安装动作的 `lsp` 组警告通知（按根 + 服务去重）；状态栏摘要显示语言名（`Rust +1` 样式）而非数字。
- `npm run test:front -- --maxWorkers=1`：142 个文件、1456 项通过；`npm run check:ts`、`npm run build` 通过。
- 批次 3b：`npm run test:lsp-ui-native` 真实 WebView 冒烟 10 项检查通过（缺失服务安装按钮、安装非零退出反馈、日志面板、手动启动/重启、右下角自动识别、签名帮助、查找用法、格式化、代码动作、重命名）。
- seed 数量 11 → 33（Windows）/ 34（非 Windows，含 sourcekit-lsp）。

### 待验收（批次 4，拍板后实施）

- 打开一个 .html / .yaml / .clj / .ex / .dart 文件，在没装对应服务的机器上：右下角弹 `lsp` 组警告气泡，带「安装」按钮，点它走确认对话框；同一会话不重复弹（组件测试已锁，真实桌面链路沿用 T35 的 `test:lsp-ui-native` 扩展验收，待批次 4 一并做）。
- 安装进度条、取消、卸载、版本显示。

## 出处

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `src-tauri/src/lsp_config.rs` | 种子服务表与三平台安装命令 | `:141-360` |
| `src/components/LspStatusBar.tsx` | 状态栏弹层、路由、安装链 | 文件全文 |
| `src/lib/notifications.ts` | 通知中心 `lsp` 组与 actions | `:20`、`:57-73`、`:268` |
| `src/lib/editorEnv.ts` | 语言 id 表（服务路由的边界） | `:10-200` |
| `src/features/settings/pages/LanguagePages.tsx` | 设置页 master-detail（对标工具页布局与表单） | 文件全文 |
| 对标资料 `crates/ide-tools/src/lib.rs` | 受管理安装器与 ToolInfo 模型 | 文件全文 |
| 对标资料 `src/features/code-insight/ServerStatus.tsx` | 状态栏组件与主动提醒 | 文件全文 |
| 对标资料 `src/features/tools/LanguageServersPage.tsx` | 工具页安装进度与过滤 | 文件全文 |
