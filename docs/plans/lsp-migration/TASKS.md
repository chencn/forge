# LSP 迁移实施任务

本文件是 `lsp-migration` 的唯一执行清单。每一轮严格按以下顺序推进：

```text
实施任务 → 针对性测试 → 回头 review → 修复 review 问题 → 重新梳理下一轮
```

没有完成当前轮的 review 和修复，不进入下一轮。任务状态只在这里维护：

- `待做`：方案已经明确，但尚未开始。
- `进行中`：正在实施或测试。
- `已完成`：实施、测试、review、修复和文档同步均完成。
- `阻塞`：需要外部决策或环境变化；必须写清证据，不能用来代替未完成工作。

## 当前执行批次

T01–T40 已按“实施 → 测试 → review → 修复 → 重新梳理”完成。本轮 T40 已在真实 Tauri WebView 中完成
签名帮助、查找用法、格式化、Alt+Enter 代码动作和重命名的端到端验收，本计划任务清单全部闭环。
当前工作区存在并发 VCS
改动，所有后续任务都必须避开这些文件，除非明确确认冲突归属。

### T01：完成 WorkspaceEdit 文件事务边界

**状态**：已完成

**实施范围**：

- 在 `src/lib/lspWorkspaceEdit.ts` 中补齐预检查、提交、失败恢复三段式事务。
- 为 Create、Rename、Delete 和多文件 TextEdit 保存可恢复的原始状态。
- 文件系统资源和文本提交使用同一逆操作栈；编辑器 Undo 历史与 watcher 写回标识不在本轮伪装接入。
- Rename 后同步打开文档的 URI、路径、标签和 LSP 文档生命周期；失败时恢复旧路径。
- 保持 dirty buffer 优先，禁止用磁盘旧内容覆盖未保存文档。

**主要文件和接口**：

- `src/lib/lspWorkspaceEdit.ts`：事务计划、回滚记录、资源操作和编辑应用。
- `src/App.tsx`：打开文档适配器、Rename 后文档注册和标签同步。
- `src/hooks/useDocuments.ts`：Rename 后迁移打开文档路径、标签和保存时间索引。
- `src/lib/lspTypes.ts`：必要时补充事务结果、冲突和回滚错误的公开契约。

**验收测试**：

- 多文件 TextEdit 失败时已提交的文本和资源恢复到操作前状态；编辑器用户 Undo 事务仍列为后续缺口。
- 任一资源操作失败时，已提交的文本、创建、删除、Rename 都恢复到操作前状态。
- dirty 文档、版本冲突和不存在目标在提交前失败，工作区不发生部分写入。
- Rename 成功后打开文档、标签、URI 和后续 didChange 指向新路径；失败后全部保持旧路径。
- 现有保存路径的 watcher 抑制保持不回归；WorkspaceEdit 关闭文档写盘的事务标识仍列为后续缺口。
- 现有 `tests/lib/lspWorkspaceEdit.test.ts`、`tests/lib/lspClient.test.ts` 扩展公开行为断言，不测试私有调用顺序。

**进入 review 的条件**：定向前端测试通过，`git diff --check` 通过，且没有触碰并发 VCS 文件。已满足。

### T02：Review WorkspaceEdit

**状态**：已完成

Review 必须逐项检查：

- 回滚是否覆盖文本、资源、内存文档、磁盘和标签，而不是只返回失败。
- 事务是否存在部分成功窗口；任何不可恢复操作是否在预检查阶段被拒绝。
- 撤销是否真的是一个公开用户操作，是否污染普通编辑器撤销栈。
- watcher 抑制是否按写入指纹/事务标识收敛，是否会吞掉外部同内容修改或永久抑制事件。
- Rename 是否处理大小写变化、父目录、dirty 文档、重复打开和后续关闭。
- 错误结果是否能区分 `conflict`、`rollback`、`unavailable` 和普通失败。
- 测试是否验证公开契约，过时测试是否因契约变更而更新，而不是简单删除。
- 计划文档的“已做、未做、出处、状态”是否与代码一致。

**Review 输出**：记录问题的文件、符号、影响、复现测试和修复优先级；没有证据的问题不作为阻塞项。

**本轮 Review 记录**：

- `src/lib/lspWorkspaceEdit.ts` 的资源适配器可能先删除覆盖目标再执行后续操作，原实现会留下部分成功窗口；高优先级，已在 T03 修复并增加失败回滚测试。
- 目录/特殊条目没有可恢复快照；高优先级，已改为预检查返回 `code: "unavailable"`，不调用资源适配器。
- Rename 覆盖目标后，新 URI 的 TextEdit 读取顺序错误会拿到旧目标正文；高优先级，已修复并增加覆盖目标测试。
- 当前没有可验证的 CodeMirror 多文档统一 Undo seam；不声称已完成，保留为后续编辑器事务任务。
- watcher 的 `savedAtRef` 只覆盖现有保存路径，WorkspaceEdit 关闭文档写盘尚未登记事务标识；不扩大本轮范围，记录到 WorkspaceEdit 文档缺口。

### T03：解决 WorkspaceEdit Review 问题

**状态**：已完成

按 T02 的问题清单逐项修复。修复后必须重新运行 T01 的全部验收，并补充回归测试。若发现当前文件系统 API 无法提供可靠回滚，停止扩展接口，先将不可原子操作明确返回失败，并在文档记录边界；不得伪装成已回滚。

**修复结果**：资源逆操作在提交前登记，快照复制避免适配器原地修改污染回滚正文；Rename 新 URI 映射、覆盖目标恢复、非普通文件拒绝和结构化错误均已补齐。定向 LSP 测试 26/26、TypeScript 检查和 `git diff --check` 通过。

### T04：重新梳理配置与 session 任务

**状态**：已完成

T03 通过后，根据实际代码重新核对 `03-server-config-and-session.md`：

- 列出真实存在的用户级、项目级和运行时配置入口。
- 先确定项目配置文件名和优先级，再实现候选 server/fallback。
- 明确 root missing、probe unavailable、misconfigured、crashed 的状态边界。
- 重新确认 session 上限、空闲回收、失败退避和窗口隔离的现状。
- 生成 T05–T08 的精确文件清单、公开接口和测试命令。

**重梳理结果**：

- 当前真实配置入口是用户级系统配置目录 `lsp.json`，Rust 的 `normalize`、探测、原子保存和旧设置迁移已经存在；前端 `LspConfig` 仍缺 `maxSessions`、`idleTimeoutMin`。
- 项目级配置尚不存在，T05 暂定只读取项目根下 `.forge/lsp.json`；不读取其他编辑器配置文件。合并顺序为用户配置 → 项目覆盖 → 运行时探测，不把运行时状态写回用户意图。
- 当前 `serverForLanguage` 只返回按配置顺序找到的第一个 server，没有候选链、启动失败 fallback 或能力不满足 fallback。
- session 已有 `(window, server, normalizedRoot)` 身份、同键启动合并、Rust 侧空闲回收/总数淘汰/5 秒指数退避/连续失败上限 2 次，以及手动 Retry；T05 只补前端契约、候选选择和 fallback，不重写这些已有机制。
- root marker 解析和 root missing 跳过已有；misconfigured、probe unavailable、crashed 仍需统一成公开状态和 UI 口径。

**T05 精确范围**：

- 文件：`src/lib/lspConfig.ts`、`src/lib/lspClient.ts`、`src/hooks/useLspConfig.ts`、`src-tauri/src/lsp_config.rs`，新增项目配置读取适配器时再加入 `src/lib/projectConfig.ts`。
- 公开接口：项目配置加载/归一化、语言候选列表、候选选择原因、`LspConfig` 资源约束字段；session 继续由 `lspManager` 暴露，不让 UI 直接管理候选状态。
- 测试：扩展现有 `tests/lib/lspClient.test.ts` 与配置测试；必要时新增 `tests/lib/lspConfig.test.ts`。覆盖配置层级、候选顺序、fallback、root 切换、同一文档单活动 server、失败原因和配置保存后单次 reconcile。
- 验收命令：`npm run test:front -- tests/lib/lspClient.test.ts tests/lib/lspConfig.test.ts`、`npm run check:ts`、`npm run test:rs`、`npm run check:rs`、`git diff --check`。

这一步只重梳理，不提前实现 T05 的代码。

## 后续执行批次

下面的任务已经按同一节奏排好；每完成一个实现任务，都必须先测试、review、修复，再执行下一条“重新梳理”。如果实际代码使任务拆分发生变化，先更新本文件，再改代码。

### T05：实现 server 配置、候选链和 session 约束

**状态**：已完成

- 实现已拍板的项目级配置文件和层级合并规则。
- 实现有序候选、启动/初始化失败 fallback、单文档单活动 server。
- 收口 root 解析、配置变更 reconcile、session 上限、空闲回收和手动 Retry。
- 运行时状态不得反写用户意图；失败不得静默改 mode。

**测试**：坏配置归一化、候选顺序、fallback 原因、root 切换、窗口隔离、资源上限、保存后单次 reconcile。

**实施结果**：`lspConfig.ts` 增加用户资源约束字段、项目 `.forge/lsp.json` 运行时覆盖、候选顺序和字段校验；`lspClient.ts` 按文档选择候选，复用已有会话，主候选启动失败后顺序 fallback，保持单文档单活动 session。

**测试结果**：LSP 相关前端测试 31/31，`npm run check:ts`、`git diff --check` 通过；Rust 全量库测试 581 项通过，已有 Windows 链接器 manifest warning。项目资源上限未实现，因为 Rust 后端当前只从用户级 `lsp.json` 读取该字段，已明确不伪装支持。

### T06：Review 并修复配置与 session

**状态**：已完成

先检查候选链是否会产生两个活动 session、root 是否可能错配、失败重试是否失控、持久化是否覆盖运行态；再修复所有高优先级问题，重复测试并更新 `03-server-config-and-session.md`。

**Review 与修复结果**：候选顺序先筛语言再排序；项目配置使用平台路径拼接并带 1 秒缓存；项目 JSON 已补 server patch 字段校验并拒绝非法 `builtin` 候选；确认全局 session 资源限制仍只来自用户配置；未发现两个活动 session 的可复现窗口。

### T07：重新梳理编辑器基础能力

**状态**：已完成

根据实际代码，第一批只收口编辑器里已经具备协议基础、且能复用现有适配层的能力：

- `Declaration`、`Type Definition`、`Implementation`：统一复用 `src/lib/cm/lsp.ts` 的位置请求、URI 过滤、去重、排序和 `src/lib/cm/locations.ts` 结果面板。
- `Find Usages`：继续使用 `textDocument/references`，结果只进入位置面板，不伪装成全文搜索。
- `Signature Help`：在 `src/lib/cm/lsp.ts` 内新增 CodeMirror tooltip 状态；请求带光标位置，结果必须按文档路径和请求快照丢弃，支持关闭和 capability 缺失降级。
- `Code Action`：在光标/选区范围请求 `textDocument/codeAction`；动作列表 UI 只展示可执行动作；`edit` 统一交给 `lspManager.applyWorkspaceEdit`，`command` 统一交给 Manager 的 JSON-RPC 请求边界，禁止 UI 直接写文件。
- `Rename`：复用现有 `WorkspaceEdit`；编辑器内使用 CodeMirror 临时输入浮层，先按当前文档和位置请求 `textDocument/rename`，结果回来时校验路径和文档版本，再应用编辑。

明确不在本轮做：跨文档统一 CodeMirror Undo、预览 diff、命令面板 Action registry、CodeLens/inlay/semantic token、真实 server 矩阵验收。这些分别留给后续 T10/T13/T16。

**真实文件清单**：

- `src/lib/cm/lsp.ts`：协议结果、取消/过期校验、tooltip、动作和重命名命令。
- `src/lib/cm/keymap.ts`：IDEA 方案的 Declaration、Type Definition、Code Action、Rename、Signature Help 快捷键。
- `src/components/CodeEditor.tsx`：编辑器上下文把 WorkspaceEdit handler 接入 Manager；不在组件内实现协议。
- `src/lib/lspTypes.ts`、`src/lib/lspManager.ts`：只在现有公开 seam 不足时补 capability/command 契约。
- `src/i18n/lang/zh.ts`、`src/i18n/lang/en.ts`、`src/styles.css`：动作标题、空状态和编辑器浮层样式。
- `tests/lib/cmLsp.test.ts`：新增协议归一化、过期结果、动作和重命名公开行为测试；若现有测试文件不存在则新建。

**进入 T08 的验收标准**：能力缺失不发请求；请求失败/取消不污染编辑器；切换文档或版本后旧结果丢弃；位置 URI 只接受可打开的文件；WorkspaceEdit 不绕过 Manager；dirty 文档仍由当前编辑器状态作为冲突边界。

### T08：实现编辑器基础能力

**状态**：已完成

- 第一阶段先实现 Declaration、Type Definition、Signature Help 和 Code Action。
- 第二阶段实现 Rename，并补齐 IDEA 快捷键接线。
- Find Usages 仅补 capability/过期结果边界和测试，不重复实现已有 references 面板。

**测试**：覆盖 capability 缺失、请求取消、旧路径/旧文档版本结果、空结果、WorkspaceEdit 失败和 dirty 文档冲突；再跑前端 LSP 定向测试、TypeScript 检查和 diff 检查。

**实施记录**：已完成 declaration/type definition/implementation 导航复用、Signature Help tooltip、Code Action 选择与 WorkspaceEdit/command 执行、Rename 输入与 WorkspaceEdit、references capability 边界；新增 `workspace/executeCommand` Manager seam。涉及 `src/lib/cm/lsp.ts`、`src/lib/cm/keymap.ts`、`src/lib/lspClient.ts`、`src/lib/lspManager.ts`、`src/lib/lspTypes.ts`、三份语言包、`src/styles.css` 和 LSP/键位测试。

**测试记录**：全量前端 134 个测试文件、1397 项通过；TypeScript 检查通过；定向 LSP/编辑器测试 25 项通过；`git diff --check` 通过。

### T09：Review 并修复编辑器基础能力

**状态**：已完成

检查 provider 是否绕过 Manager、是否直接写文件、异步结果是否复活、导航 URI 是否越界、Action/命令结果是否安全执行；修复后重跑相关前端测试和类型检查，并更新 `05-editor-capabilities.md`。

**Review 记录**：发现 Code Action 执行失败后按钮会永久 disabled、Rename 收到非法结果后输入框会永久 disabled，均为中优先级可复现交互问题；未发现 provider 直接写文件、旧文档结果落新文档或导航接受虚拟 URI 的问题。

**修复记录**：失败改为抛回动作 UI，统一恢复按钮并显示错误；Rename 非法结果恢复输入框和提交状态。旧结果仍由 `EditorState.doc` 和当前路径双重校验丢弃。

**重梳理**：进入 T10，先核对装饰/高级能力的可见区、版本、取消和刷新 seam，再决定 T11 的最小实现组。

### T10：重新梳理编辑器装饰与高级能力

**状态**：已完成

以已经稳定的请求生命周期为前提，重新确认可见区模型、文档版本和主题映射，排列 Inlay Hints、Semantic Tokens、CodeLens、Inline Completion、Workspace Symbols、Call Hierarchy、Type Hierarchy、Document Links、Virtual Documents、Auto Import/Save Actions 的实施顺序和边界。

**本轮先查**：`src/lib/cm/lsp.ts`、`src/lib/cmEditor.ts`、`src/lib/lspClient.ts`、`src/lib/lspTypes.ts`、`src/lib/editorEnv.ts` 和现有结果面板；不先写高级能力代码。重点确认 LSP 文档版本是否能覆盖装饰结果、CodeMirror 可见区变化是否有稳定监听、server 刷新/退出后是否有订阅恢复点，以及只读虚拟文档是否已有容器。

**梳理结果**：CodeMirror 的 `visibleRanges`、`viewportChanged`、`docChanged` 可直接作为可见区边界；Manager 已有 AbortSignal，但 server 文档版本受 didChange 防抖影响，装饰结果必须同时绑定 `EditorState.doc` 身份；`watchStatus` 可作为 ready 后刷新入口；当前没有语义 token delta 缓存、CodeLens command 面板或虚拟文档容器。因此先做 Inlay Hints，其他能力拆开，避免把不同刷新模型塞进一个插件。

**进入 T11 的精确范围**：新增独立 `src/lib/cm/lspDecorations.ts`，只实现 `textDocument/inlayHint` 的可见区请求、请求取消、旧正文丢弃、server ready 重取和只读 inline widget；新增协议归一化测试与样式。不得改动语义 token、CodeLens、Inline Completion 或虚拟文档。

### T11：实现编辑器装饰与高级能力

**状态**：已完成

- Inlay Hints：只请求当前 `visibleRanges` 合并范围。
- 文档、视口或语言服务 ready 变化时取消上一请求；结果必须同时匹配路径、正文快照和请求序号。
- 只生成只读 Decoration widget，不改正文、不进入 Undo、不写磁盘。
- capability 缺失、无可见区、请求失败和空结果都回到无装饰状态。

**测试**：覆盖 label 归一化、非法位置过滤、能力缺失不请求、旧结果丢弃和请求取消；再跑前端全量、TypeScript 与 diff 检查。

**实施记录**：新增 `src/lib/cm/lspDecorations.ts`，实现 Inlay Hints 可见区请求、AbortSignal 取消、正文快照/序号校验、server ready 重取和只读 widget；`src/lib/cm/lsp.ts` 挂载扩展，`src/styles.css` 增加提示样式。

**测试记录**：全量前端 135 个测试文件、1401 项通过；TypeScript 检查通过；`git diff --check` 通过。

### T12：Review 并修复编辑器装饰与高级能力

**状态**：已完成

检查可见区请求风暴、AbortController 泄漏、视图销毁后的回调、server 重启后的刷新、Decoration 映射和大文件性能；修复后更新 `05-editor-capabilities.md`，再进入下一轮高级能力梳理。

**Review 记录**：确认可见区/正文变化会取消旧请求，视图销毁递增序号并退订 status watcher；发现 capability 明确为 `false` 时仍可能请求，已修复并补测试；负坐标归一化已修复。

**重梳理**：进入 T13，检查统一 Action registry、右键菜单、命令面板、设置页和状态栏的真实入口，先确定 LSP 动作的唯一上下文和可用性来源。

### T13：重新梳理统一 Action 与 UI

**状态**：已完成

先只读盘点 `src/lib/commands.ts`、`src/lib/editorEnv.ts`、`src/lib/cmEditor.ts`、项目树菜单、命令搜索、设置页和 LSP 状态栏；确认当前是否已有统一 Action registry、哪些入口仍直接调用协议/文件系统、以及 capability 缺失和未 ready 的展示来源。完成盘点后再拆 T14 的最小改动。

**梳理结果**：已有 `ForgeCommand[]` 是命令搜索的唯一数据源，但编辑器 LSP 入口仍只在 CodeMirror keymap 和项目树局部回调；命令对象没有可用性字段；LSP capability 只能从 Manager 查询，App 没有 status 刷新订阅。T14 只补命令可用性和编辑器门面，不重写项目树菜单或另造 registry。

### T14：实现统一 Action、设置页和状态栏

**状态**：已完成

- `ForgeCommand` 增加 `enabled`；动作搜索和最近动作过滤不可执行项。
- `editorEnv`/`cmEditor` 增加导航、Code Action、Rename、Signature Help 的当前文档命令门面。
- App 命令面板加入这些 LSP 动作，并按 Manager capability 与 status revision 更新可用性。
- 快捷键、命令面板、项目树现有入口继续共用底层命令，不在 UI 层直接调用 JSON-RPC。

**测试**：TypeScript 检查通过；`seModel`、`seController`、`cmKeymap` 定向 62 项通过；全量测试待 T15 review 后执行。

### T15：Review 并修复 Action 与 UI

**状态**：已完成

检查动作是否绕过 Manager、不可用项是否仍进入最近/搜索、status 是否多源拼接、编辑器未挂载时是否误报成功，以及快捷键是否冲突；完成后使用现有前端测试和 Forge 浏览器/桌面流程验收，不引入 Playwright。

**Review 记录**：发现命令面板 Rename 没有把只读文档纳入 enabled 条件，已修复；确认动作搜索和最近动作均过滤 `enabled: false`，编辑器命令统一经过 `editorEnv`/`cmEditor`，没有直接调用 JSON-RPC 或 Tauri。

**测试记录**：全量前端 135 个测试文件、1402 项通过；TypeScript 检查和 `git diff --check` 通过。Forge 浏览器本地烟测页面完成但仅渲染根节点，控制台有 `Uncaught (in promise)`；原因是浏览器预览没有 Tauri bridge，桌面编辑器工作流未伪装成已通过。

**重梳理**：进入 T16，核对本机真实语言服务安装状态、版本、root 样例和可执行验收命令。

### T16：重新梳理真实语言服务验收矩阵

**状态**：已完成

只读探测 `typescript-language-server`、`rust-analyzer`、`gopls`、`pyright`、`jdtls` 及其版本；同时核对项目已有语言配置、测试 fixture 和启动命令。缺失的环境依赖只记录，不为验收临时安装或改用户环境。

**矩阵结果**：`rust-analyzer` 可用，版本 `1.99.0 (b940084d 2026-09-28)`；`gopls` 可用，版本 `golang.org/x/tools/gopls v0.23.0`；`typescript-language-server`、`pyright`、`jdtls` 未找到。Rust root 样例为 `src-tauri/Cargo.toml`；当前没有可直接复用的 Go/TypeScript/Python/Java fixture。T17 只验收 Rust/Go，后三项记录跳过原因。

### T17：执行真实语言服务验收并修复环境/协议问题

**状态**：已完成

每个可用 server 至少验证 initialize、didOpen、诊断、补全、定义、格式化、一个 WorkspaceEdit 和崩溃恢复。协议或代码问题修复在相应模块；纯环境缺失只记录证据和跳过原因。

**验收记录**：用户 Temp 标准 LSP 帧探针直接启动真实进程。rust-analyzer 通过 initialize、didOpen、completion、definition、formatting、shutdown；gopls 同项通过，收到 2 次 publishDiagnostics，rename 返回 WorkspaceEdit。rust-analyzer stderr 只有不存在监视路径 warning，来自探针 URI；三个未安装 server 按 T16 跳过。未对进程崩溃自动恢复做桌面断言，Manager 退出/重试逻辑仍由前端生命周期测试覆盖。

**重梳理**：进入 T18，执行最终公开接口、状态机、并发、安全、文档和全量测试收口。

### T18：最终 review、文档收敛和核心批次收口

**状态**：已完成

- Review 全部公开接口、状态机、错误、资源回收、并发、性能和安全边界。
- 跑前端测试、Rust 检查/测试、构建、`git diff --check`，区分既有并发错误与本计划回归。
- 将稳定行为并入 `docs/features/lsp-language-servers/README.md` 及相关 feature 文档。
- 更新 `docs/plans/README.md` 索引；只删除已经定稿的计划文档，未完成项不得被隐藏。
- 再次确认没有修改用户并发 VCS 改动。

**实施**：完成公开接口、状态机、并发、资源回收和安全边界 review；将稳定的 server、Manager、WorkspaceEdit、编辑器
能力、Action 和真实 server 验收结论同步到 feature/backend 文档。未实现的高级能力和编辑器事务边界继续留在本计划。

**测试**：`npm run test:front` 通过（135 个文件、1402 项）；`npm run check:ts` 通过；`npm run check:rs` 通过；
`npm run test:rs` 通过（576 passed、5 ignored）；`npm run build` 通过；`git diff --check` 通过；代码、文档和测试中未发现禁用
产品名。Vite 仍报告既有的大 chunk 和无效动态导入警告，Rust 保留既有 Windows linker manifest warning。

**Review**：发现并修正稳定 LSP 文档仍描述旧编辑器接入、阶段状态落后于代码、真实 server 矩阵把未安装环境误写成验收
要求的问题；未发现新的代码级回归。Forge 浏览器预览因没有 Tauri bridge 只完成加载烟测，未伪装成桌面流程通过。

**修复**：更新 `docs/features/lsp-language-servers/README.md`、`docs/plans/lsp-migration/README.md`、阶段文档和计划索引；
保留 Document Links、Virtual Documents 的明确缺口；跨文档 Undo、关闭文档 watcher 标识、Semantic Tokens、CodeLens、
Inline Completion 和层次结构已在后续 T19–T23 完成。

**重梳理**：下一轮应先为上述缺口建立独立任务，不再把不同刷新模型塞回 `src/lib/cm/lsp.ts`；优先顺序为 WorkspaceEdit
撤销/写回标识 → Semantic Tokens → CodeLens → Inline Completion → Symbols/Hierarchy/Virtual Documents。每项仍需单独
实施、测试、review、修复后再进入下一项。

## 每轮固定验收模板

每个实施任务结束时，在对应计划文档留下以下记录：

```text
实施：完成了哪些公开行为，涉及哪些文件和接口。
测试：命令、通过/失败结果、失败是否为既有环境问题。
Review：发现的问题、证据、优先级。
修复：哪些问题已修复，新增或调整了哪些公开行为测试。
重梳理：下一轮目标、进入条件、仍未完成的边界。
```

测试过时只能在公开契约变化且新断言覆盖新契约时更新；不能用删除测试掩盖失败。所有代码和文档对照产品时统一使用“IDEA”或“对标 IDEA”的说法。

### T19：完成 WorkspaceEdit 用户撤销与 watcher 回声边界

**状态**：已完成

**实施**：`WorkspaceEditContext.registerUndo` 登记成功事务的逆操作，CodeMirror 只保留最近一次跨文档撤销；普通用户输入会清掉该入口，撤销前校验事务后的正文和资源仍未变化。App 为关闭文档写盘登记路径、正文和 1.2 秒生命周期，watcher 先读盘核验，外部不同内容继续刷新。

**测试**：`tests/lib/lspWorkspaceEdit.test.ts` 覆盖单次多文档撤销和外部改写冲突；前端全量测试通过。

**Review**：发现无条件恢复快照可能覆盖事务后的外部改动；已增加正文/资源状态校验。watcher 事件没有事务 id，不能只按全局时间静默，已收敛为路径 + 正文 + 有限生命周期。

**修复**：撤销冲突返回失败，不写入外部新内容；关闭文档写回不再使用全局 watcher 抑制。

**重梳理**：进入 Semantic Tokens，保持可见区/正文快照/取消模型独立，不复用 CodeLens 的刷新实现。

### T20：实现 Semantic Tokens

**状态**：已完成

**实施**：新增 `src/lib/cm/lspSemanticTokens.ts`，解码相对五元组、映射 legend 和 modifier、按 range/full 请求并绑定协商位置编码；正文/视口/ready 变化取消旧请求，结果绑定文档身份。

**测试**：`tests/lib/cmLspDecorations.test.ts` 覆盖相对位置、modifier、非法数据、capability 关闭、range 请求和旧正文丢弃。

**Review**：发现 CodeMirror 插件构造期间同步 dispatch 会重入更新；改为仅在已有装饰时清空，初始状态不派发。初始化能力补全标准 token 类型和 modifier。

**修复**：避免插件构造重入，真实 server 可获得完整语义 token 客户端能力声明。

**重梳理**：进入 CodeLens，结果必须是可执行 command，unresolved lens 不进入 UI。

### T21：实现 CodeLens

**状态**：已完成

**实施**：新增 `src/lib/cm/lspCodeLens.ts`，按文档请求 CodeLens，在代码行上方挂只读可点击 widget，command 统一交给 `LspManager.executeCommand`；定位使用服务端协商编码。

**测试**：覆盖 command/range 归一化和 capability 缺失不请求；定向 LSP 测试通过。

**Review**：发现初版行定位默认按 UTF-16；已改用 `positionEncoding`，避免 UTF-8/UTF-32 服务端错位。

**修复**：CodeLens 起始位置和结果应用统一使用协商编码。

**重梳理**：进入 Inline Completion，ghost text 必须在接受前不改变正文。

### T22：实现 Inline Completion

**状态**：已完成

**实施**：新增 `src/lib/cm/lspInlineCompletion.ts`，支持数组/对象结果、可选 range、取消和过期结果丢弃；ghost text 只读展示，Tab 接受为一次普通输入，Escape 清除。

**测试**：覆盖返回形状、空/非法 range、provider 关闭、请求参数和接受后正文变化。

**Review**：发现非法 range 若降级到光标位置会把服务端错误内容误插入；已改为丢弃该 item。客户端初始化声明 inline completion 能力。

**修复**：非法 range 不再产生隐式插入，普通补全和 ghost text 的撤销边界分离。

**重梳理**：进入 Raw request 与符号/层级入口，workspace/symbol 和 hierarchy 后续请求不得附加 textDocument。

### T23：补齐 Raw request、符号和层级入口

**状态**：已完成

**实施**：增加 `LspManager.requestRaw`；接入 Document Symbols、Workspace Symbols、Incoming/Outgoing Calls、Supertypes/Subtypes，并统一复用位置结果面板。命令面板按 capability 过滤入口。

**测试**：`tests/lib/lspClient.test.ts` 验证 raw request 的参数不包含 `textDocument`；前端全量 135 个文件、1413 项通过，生产构建通过。

**Review**：确认 workspace/symbol、call hierarchy 和 type hierarchy 的请求形状分离；结果都绑定当前文档身份，非法 URI/范围沿用位置面板过滤。

**修复**：补齐 raw seam 和层级 capability 类型；不让 UI 直接管理 session 或 JSON-RPC。

**重梳理**：下一轮只处理 Document Links 与 Virtual Documents；在只读容器和链接安全策略定稿前，不把虚拟 URI 直接塞进现有文件打开流程。

### T24：Document Links 与 Virtual Documents

**状态**：已完成

**范围**：链接目标校验、可点击 document link、只读虚拟文档容器、虚拟 URI 生命周期与关闭清理；不得把未知 scheme 直接转成本地路径。

**实施**：新增 `src/lib/cm/lspDocumentLinks.ts`，接入 `textDocument/documentLink`、capability 判断、请求取消、正文快照校验、服务重启重取、悬停提示和 Ctrl/⌘ 点击打开；目标只接受有效的 `file:` URI，未知 scheme、非法范围和空目标在协议边界丢弃。新增 `src/lib/virtualDocuments.ts`，将非 `file:` URI 编码为 `virtual:lsp/...` 内部键；`useDocuments` 通过 `openVirtualUri` 保存原始 URI 元数据，虚拟文档继续只读、不可保存、不进入 LSP 磁盘文档同步，关闭时随文档列表清理。

**测试**：新增 `tests/lib/cmLspDocumentLinks.test.ts`、`tests/lib/virtualDocuments.test.ts`；补充 `FILE:` URI 归一化测试。定向 LSP/URI/虚拟文档测试 46 项通过，TypeScript 检查通过。

**Review**：确认 Document Link 不调用未知 scheme 的路径转换；确认 `virtualUri` 不参与 `readFile`、`writeFile`、WorkspaceEdit 或 LSP 文档同步；确认旧正文结果、服务重启和文档关闭不会复活链接或虚拟文档。发现 `openVirtual` 可被错误传入 `file:` 元数据，以及 Windows 路径 `D:/...` 会被误识别为 URI scheme。

**修复**：`openVirtual` 仅记录合法的非 `file:` URI；虚拟 URI 判定排除 Windows 盘符路径；`uriToPath` 对 URI scheme 大小写不敏感。全量前端并行运行时有两个既有测试偶发失败，单独串行重跑均通过，未修改无关模块。

**重梳理**：下一轮进入 T25，只审查 Auto Import 与 Save Actions 的请求形状、WorkspaceEdit/保存冲突边界、触发时机和 UI 入口；先形成实施拆分，再按“实施 → 测试 → review → 修复 → 重新梳理”推进。Document Link 的 resolveProvider 和非文件协议不在下一轮扩展。

### T25：Auto Import 与 Save Actions

**状态**：已完成

**实施**：

- 补全候选含 `additionalTextEdits` 时，将主编辑和附加编辑组装为一个带文档版本的 WorkspaceEdit，统一交给 `lspManager.applyWorkspaceEdit`；旧正文、路径变化或版本冲突时不提交。带附加编辑的 snippet 以默认文本安全降级，避免把占位符写入源码。
- 保存链增加唯一的 `prepareSave` 入口：可选的 `textDocument/formatting` 先按旧正文请求，再通过 WorkspaceEdit 应用；裁尾随空白与补末尾换行使用纯函数，最后才进入现有乐观锁保存。
- `useDocuments.get` 在异步保存动作后返回最新文档；格式化期间用户产生新编辑时放弃本次保存动作，不覆盖用户正文。格式化失败或 WorkspaceEdit 冲突不继续写盘；只读、虚拟和干净文档不执行保存动作。
- 编辑器设置新增 `formatOnSave`、`trimTrailingWhitespace`、`insertFinalNewline`，前端、Rust 默认值和设置页保持一致；活动保存把当前行传入裁尾空白动作，避免光标所在行被改写。

**测试**：新增 `tests/lib/saveActions.test.ts`，扩展 `tests/lib/cmLsp.test.ts`；T25 定向测试 20 项通过，TypeScript 检查通过，`git diff --check` 通过。Rust `cargo check` 曾因已有 Windows 构建产物被其它进程占用（`os error 32`）未进入源码检查，待独立构建锁释放后重跑。

**Review**：发现带 `additionalTextEdits` 的 snippet 不能同时保留 CodeMirror 占位状态和 WorkspaceEdit 原子性；已改为事务内默认文本降级并补回归测试。确认保存动作没有调用 `writeFile` 绕过文档保存链，未保存内容和 watcher 回声仍由既有 `useDocuments.save` / WorkspaceEdit 适配器处理。

**重梳理**：下一轮回到高级编辑能力的未完成项，优先核对 `willSaveWaitUntil`、`.editorconfig` 和跨文档撤销是否有真实协议/宿主接缝；本轮不把尚未实现的协议写成已完成。

### T26：保存生命周期、项目代码样式与 WorkspaceEdit 撤销边界

**状态**：已完成

**实施**：

- `src/lib/lspClient.ts` 在 initialize 中声明 `willSave`、`willSaveWaitUntil` 和 `didSave` 客户端能力；按服务端 `textDocumentSync` 能力发送 `textDocument/willSave`、请求 `textDocument/willSaveWaitUntil`，写盘成功后按 `save.includeText` 发送 `textDocument/didSave`。这些接口经 `src/lib/lspManager.ts` 暴露，保存链不直接碰传输层。
- `src/App.tsx` 将手动保存、失焦保存、关闭工作区保存和退出保存统一接入 `prepareSave`。保存前编辑使用带文档版本的 WorkspaceEdit；服务端超时、没有该能力或返回空编辑时保持原保存路径，正文在等待期间发生变化则放弃旧保存动作。
- 新增 `src/lib/editorConfig.ts`：从工作区根向文件目录逐层读取 `.editorconfig`，支持 `root=true` 截断、最近层覆盖、basename/目录 glob、组合扩展名、`unset`，以及 `indent_style`、`indent_size`、`tab_width`、`end_of_line`、`insert_final_newline`、`trim_trailing_whitespace`。解析结果按短 TTL 缓存，不改变用户设置文件。
- `OpenDocument` 保存匹配到的文件级配置；CodeMirror 使用有效 `tabSize`，保存使用有效行尾和卫生规则。全局设置仍是未被项目文件覆盖时的回退值，未引入设置页开关。
- 审查现有跨文档 WorkspaceEdit 撤销：成功事务已经通过 `registerWorkspaceUndo` 注册为最近一次用户级撤销，普通用户输入会清除它，执行前会校验正文/资源未被外部改写；本轮不扩展为完整多级编辑器历史，边界保持文档化。

**测试**：新增 `tests/lib/editorConfig.test.ts`；扩展 `tests/lib/lspClient.test.ts`。T26 定向测试 35 项通过；全量前端 139 个测试文件、1434 项通过；`npm run check:ts`、生产构建和 `git diff --check` 通过。Rust 本轮未修改；`cargo check` 仍受 Windows 构建产物占用问题影响，未删除 target、未杀进程、未回滚工作区。

**Review**：发现打开文档已有状态的配置加载存在两次状态写入窗口，以及 `unset`/组合模式未正确处理；前者合并为一次异步更新，后者补齐解析和回归测试。确认 `willSaveWaitUntil` 不绕过版本校验，`didSave` 不在服务端未声明保存能力时伪造发送，`.editorconfig` 的 `cr` 行尾因当前磁盘 API 只有 LF/CRLF 而明确忽略。

**修复**：完成上述两项 review 修复并重跑定向、全量测试和生产构建。

**重梳理**：下一轮建立 T27，优先处理保存协议的真实 server 验收和 `.editorconfig` 文件变更后的缓存失效；随后再决定是否扩展 WorkspaceEdit 撤销历史。T27 不重复修改已经稳定的保存链，也不提前扩展设置 UI。

### T27：配置变更失效与保存协议边界收口

**状态**：已完成

**实施**：

- `src/lib/editorConfig.ts` 的缓存清理契约明确为“只清缓存，不碰打开文档”；`.editorconfig` 事件由 watcher 统一触发清理。
- `src/hooks/useDocuments.ts` 增加 `refreshEditorConfigs(root)`：只遍历该工作区下的真实磁盘文档，异步重新计算有效配置，只替换 `editorConfig`，保留正文、baseline、编码、行尾、光标关联状态和 dirty 状态。
- `src/App.tsx` 在过滤 `.git` 路径后识别 `.editorconfig` 变化，清理缓存并刷新已打开文档；不把配置变化误送入普通正文外部修改重载。
- 保存协议的 initialize 客户端能力、服务端能力缺失降级和 `didOpen → willSave → willSaveWaitUntil → didSave` 顺序补成公开行为测试。

**测试**：

- `tests/lib/editorConfig.test.ts` 验证缓存命中、外部内容变化和显式清理后的重新读取，并覆盖 Windows 路径分隔符。
- `tests/lib/lspClient.test.ts` 验证 initialize 能力声明、`willSaveWaitUntil` 缺失时不发请求、`save` 能力缺失时不伪造 `didSave`，以及保存消息顺序。
- 定向测试：2 个文件、23 项通过。
- 全量前端测试：139 个文件、1437 项通过。
- `npm run check:ts`、`npm run build`、`git diff --check` 通过。
- 本轮未修改 Rust；Rust 检查沿用上一轮 Windows 构建产物占用边界，未删除 target、未终止进程、未回滚工作区。

**Review**：

- 确认配置刷新只改 `editorConfig`，不会重读正文或覆盖未保存内容；`onDisk` 过滤避免虚拟文档进入磁盘配置加载。
- 确认 watcher 先排除 `.git`，配置事件不会伪装成 Git 元数据变化；缓存清理后由工作区根约束刷新文档。
- 确认 LSP 测试锁定的是初始化能力、能力协商和消息契约，不测试私有 helper 或实现顺序。
- 初版测试 mock 未按 Windows 原生分隔符归一化，已修正测试边界并重跑定向、全量测试和构建。

**修复**：完成上述测试边界修复；业务实现未发现需要回滚或扩大范围的问题。

**重梳理**：进入 T28。先用可控的真实语言服务进程验收 initialize、文档生命周期、保存协议、WorkspaceEdit 和 server 重启；同时记录不同服务的能力差异。真实 server 验收通过后，再决定是否实现完整多级 WorkspaceEdit 撤销历史。本轮不重复修改 `.editorconfig` 刷新链，不新增设置 UI。

### T28：真实语言服务进程验收矩阵

**状态**：已完成（并入 T17 与 T34 的验收链）

**实施**：

- 本轮立项目标（真实进程验收 initialize、文档生命周期、保存协议、WorkspaceEdit、server 重启与会话隔离）没有另起 fixture：T17 已用用户 Temp 的标准 LSP 帧探针覆盖 rust-analyzer 和 gopls 的协议矩阵，T34 又以真实 Tauri `AppHandle` 原生入口补齐双 root 会话隔离、`workspace/applyEdit`、`willSaveWaitUntil`/didSave、stderr 与退出事件。
- 两轮验收结果已分别记录在 T17 与 T34 条目；这里补记条目本身，避免清单编号断档造成“T28 去向不明”。

**测试**：沿用 T17（探针矩阵）与 T34（`npm run test:lsp-native`）的验收结果，不重复执行。

**Review**：确认 T28 的全部验收点在 T17 + T34 中均有结构化结果与失败路径覆盖，无遗漏项，也无只在本轮才需要的独立实现。

**修复**：无业务代码改动。

**重梳理**：完整多级 WorkspaceEdit 撤销历史在 T39 落地；真实编辑器工作流桌面验收排在 T40。

### T29：补齐语言服务设置页探测与安装闭环

**状态**：已完成

**实施**：

- `src/hooks/useLspConfig.tsx` 增加探测错误公开状态，并为重复调用复用同一个进行中的探测请求；失败时保留上一次有效探测结果，不再静默伪装成「未探测」。
- `src/features/settings/pages/LanguagePages.tsx` 在进入语言服务设置页时自动探测，显示探测错误；安装调用改为传递 server ID，检查安装进程退出码，成功后自动重新探测并触发语言服务对档。
- `src/components/SettingsPage.tsx` 将探测按钮接入设置页标题栏，探测期间按钮禁用并显示进行中状态。
- `src/i18n/lang/zh.ts`、`src/i18n/lang/en.ts`、`src/i18n/lang/zh-TW.ts` 补齐探测失败和安装完成状态文案。

**测试**：

- `npm run test:front -- tests/lib/lspConfig.test.ts tests/lib/lspClient.test.ts`：2 个文件、22 项通过。
- `npm run check:ts`：通过。
- `npm run build`：通过；保留既有大 chunk 和无效动态导入警告。
- `npm run test:front`：首次并发运行 141 个文件、1444 项中 1443 项通过，`tests/lib/termHistoryBudget.test.ts` 超时；随后使用单 worker 串行重跑该文件，4 项全部通过，判定为既有并发/环境波动，不修改该测试。
- `git diff --check`：通过。
- Forge 浏览器预览只加载根节点，因无 Tauri bridge 无法执行桌面探测和安装流程，不将其伪装成通过。

**Review**：

- 发现原安装按钮把安装命令传给了后端，而后端契约要求 server ID；本轮已修正并通过 TypeScript/构建验证。
- 发现原实现不检查退出码，安装命令非零退出也会显示成功；本轮改为非零退出展示退出码和输出尾部。
- 发现探测能力已有但没有任何 UI 调用 `reprobe`；本轮补上进入页面自动探测和标题栏手动探测。
- 仍未解决右下角状态栏展示「当前文件 → 自动识别的语言服务/项目根」的问题；现有状态栏只展示已启动会话，下一轮单独处理路由结果公开接口和状态入口。

**修复**：完成上述设置页、探测和安装问题修复；未修改后端探测/安装契约，避免重复实现同一逻辑。

**重梳理**：下一轮进入 T30，先公开当前文档的语言服务路由结果（语言、候选 server、命中的项目根、运行状态），再接入右下角状态栏；随后把“未安装/未启用/无根目录/启动失败”转换成可点击的设置或安装入口。

### T30：右下角当前文件自动识别状态

**状态**：已完成

**实施**：

- `src/lib/lspClient.ts` 新增只读 `routeFor(path, language)`：复用现有 server 候选和最深项目根选择，返回当前文件的语言、server ID、项目根和 `running/starting/missing/unconfigured` 状态；不启动进程、不写配置、不重复解析文件系统。
- `src/lib/lspTypes.ts`、`src/lib/lspManager.ts` 将路由查询纳入统一 Manager seam，避免状态栏直接读取客户端内部表或自行复制候选逻辑。
- `src/components/LspStatusBar.tsx` 接收当前活动文档，在右下角浮层中显示自动识别语言、实际服务、项目根和状态；无活动会话时也能显示未配置、等待启动或服务不可用，而不是只显示「没有运行中的服务」。
- `src/App.tsx` 把当前文档路径和语言传入状态栏；三份语言包补齐路由状态文案。
- `tests/lib/lspClient.test.ts` 增加真实 reconcile 路径测试，锁定当前文档与实际运行 server/root 的公开路由契约。

**测试**：

- `npm run test:front -- tests/lib/lspClient.test.ts`：19 项通过。
- `npm run check:ts`：通过。
- `npm run build`：通过；保留既有大 chunk 和无效动态导入警告。
- `git diff --check`：通过。
- 禁用产品名称扫描：无结果。

**Review**：

- 新测试初次按输入路径大小写断言项目根，发现既有 canonicalPath 契约会统一为小写盘符；已改为断言公开归一化结果，未改变业务实现。
- 确认状态栏只通过 `lspManager.route` 查询，不直接访问 `running`、`skipped` 或 JSON-RPC；状态栏的重试、停用和设置入口仍沿用已有边界。
- 确认没有启用 server 时，只要当前有文件仍显示自动识别入口；没有活动文件且没有启用项时不占状态栏空间。
- 当前状态栏还不能从“未安装/未启用/无项目根/启动失败”直接跳到对应安装或配置卡片；下一轮处理可操作入口，不把错误详情继续堆在状态文本里。

**修复**：修正新测试的 Windows 路径断言；路由实现本身未发现需要回滚的问题。

**重梳理**：下一轮进入 T31，统一右下角路由状态的可操作动作：未安装打开安装确认，未配置打开语言服务设置，缺少项目根显示标志文件提示，启动失败提供重试和日志；随后再做设置页与状态栏的真实桌面验收。

### T31：右下角语言服务状态的可操作入口

**状态**：已完成

**实施**：

- `src/components/LspStatusBar.tsx` 根据当前路由和探测结果提供直接安装入口；确认后调用 `lspInstall(serverId)`，安装完成重新探测并触发 LSP 对档，失败通过现有错误气泡显示退出码和输出尾部。
- 当前路由未配置或不可用时，状态浮层提供打开语言服务设置的动作；已有会话的重试、停用、日志动作保持原路径。
- 安装确认继续复用 `src/components/LspDialogs.tsx`，没有在状态栏复制确认文案和危险操作说明。
- Review 后补充失败记录的项目根隔离：同一 server 在其他工程的启动失败不会污染当前文件的右下角状态。

**测试**：

- `npm run test:front -- tests/lib/lspClient.test.ts tests/lib/lspConfig.test.ts`：2 个文件、24 项通过。
- `npm run check:ts`：通过。
- `git diff --check`：通过。
- T30 已通过生产构建；本轮状态栏改动后需在本轮总验收再次跑构建。

**Review**：

- 安装动作仍只通过 `lspInstall` 和 `reprobe` 进入后端，不直接执行 shell，不修改配置文件，不把安装命令当作 server ID。
- 非零退出码和 shell 异常都通过错误气泡反馈；确认弹窗在执行后关闭，避免重复点击。
- Review 发现初版路由失败状态只按 server ID 匹配，可能串入另一个项目根；已改为同时校验当前文件是否位于失败记录的 root，并增加跨工程回归测试。
- 未安装判断来自统一探测结果；没有探测结果时不会凭空显示安装按钮，避免把“未知”误报成“未安装”。
- Forge 浏览器预览缺少 Tauri bridge，不能在当前预览中执行真实安装；保留为桌面验收项。

**修复**：完成状态栏安装/设置入口接线；未发现需要修改后端契约的问题。

**重梳理**：下一轮进入 T32，跑一次完整前端测试和生产构建，并做真实桌面流程验收；若通过，再处理设置页安装输出、会话状态和右下角路由状态的文案/状态源统一，避免三处各自维护错误文本。

### T32：统一探测、安装、会话轮询与手动唤醒闭环

**状态**：已完成

**实施**：

- `src/hooks/useLspConfig.tsx` 的 `reprobe` 现在返回本轮结构化探测报告，同时继续由 Provider 保存探测表、校正后的配置和错误；状态栏首次点击安装时可以等待同一轮探测，不复制探测逻辑。
- `src/components/LspStatusBar.tsx` 在安装状态未知时先探测，再按真实结果打开已有的安装确认框；已安装不会误执行安装命令，探测失败通过统一错误气泡反馈。重启、停用和安装完成后主动刷新共享会话轮询。
- `src/features/settings/pages/LanguagePages.tsx` 的启动、重启和安装完成路径复用同一份会话刷新入口，并将异常安装文案与状态栏统一为 i18n 文案。
- `src/lib/lspClient.ts` 将 `wake` 的运行判断限定为 `server + canonical root`；手动唤醒不再把另一个项目的同名会话当成当前项目已启动，也不再在无打开文件时启动后立即被空文档对档收掉。已有文档仅同步给当前 server 管理且落在当前根内的文件。
- `src/App.tsx` 移除唤醒完成后多余的全量对档触发，避免手动启动结果被下一轮空集合覆盖；正常文档/配置变化仍由既有 reconcile 链负责。
- `src/i18n/lang/zh.ts`、`src/i18n/lang/en.ts`、`src/i18n/lang/zh-TW.ts` 补齐已安装、安装异常和探测后安装反馈文案。

**测试**：

- `npm run test:front -- tests/lib/lspClient.test.ts`：21 项通过；新增“同一 server 跨项目唤醒”和“无打开文件时会话不被收掉”回归测试。
- `npm run check:ts`：通过。
- `npm run test:front -- --maxWorkers=1`：141 个文件、1447 项通过。
- `npm run build`：通过；保留既有大 chunk 和无效动态导入警告。
- `git diff --check`：通过；禁用产品名称扫描无结果。
- Forge 浏览器已检查页面加载；预览只有根节点且无 Tauri bridge，无法执行真实桌面探测、安装和启动流程，保留为桌面验收边界。

**Review**：

- 检查了探测竞态：状态栏只在无探测结果时等待 `reprobe` 返回值，成功报告直接决定是否弹窗，不依赖尚未完成的 React 状态刷新；进行中的探测仍由 Provider 合并复用。
- 检查了安装边界：入口仍要求配置存在 `installCommand`，已安装状态不会执行命令，非零退出码和 IPC 异常均进入错误反馈；安装调用仍传 server ID，不把命令文本传给后端。
- 检查了会话身份：运行、失败和手动唤醒均按 canonical root 隔离；回归测试证明其它项目的同名服务不会短路当前项目启动。
- 检查了手动唤醒生命周期：移除多余 reconcile 后，空文档启动的会话不会立即被回收；已有文档只通过 `syncDocuments` 进入匹配的 server，未绕过 Manager 或直接 spawn。

**修复**：

- 修复跨项目同名 server 被误判为已运行的问题。
- 修复设置页“启动”在没有打开对应语言文件时启动后立即消失的问题。
- 修复状态栏首次打开时因探测表为空而没有安装入口的问题，并统一安装异常文案。
- 修正手动唤醒注释，使文档描述与实际生命周期一致。

**重梳理**：下一轮进入 T33，做真实桌面语言服务验收：准备可控的本机测试 server，验证设置页自动探测、状态栏当前文件路由、安装确认/退出码、手动启动、跨项目会话和日志反馈；若桌面验收发现协议边界问题，只修正真实失败链，不继续堆状态字段。桌面验收前不扩展新的编辑器能力。

### T33：真实桌面语言服务验收

**状态**：已完成（当时的环境阻塞由 T34/T35 收口）

**实施**：

- 复核现有真实 server 验收结果：T17 已用用户 Temp 中的标准 LSP 帧探针验证 rust-analyzer 和 gopls 的 initialize、didOpen、诊断、补全、定义、格式化、WorkspaceEdit 和 shutdown；本轮不重复造一个只测 server 自身的 fixture。
- 复核当前桌面验收入口：`scripts/test-browser.mjs` 只验证浏览器原生能力，Forge 浏览器页面连接的是 Vite 页面，不是 Tauri WebView；当前页面只有根节点，且没有 Tauri bridge。
- 复核前端与后端接线：设置页自动/手动探测、状态栏路由、安装确认和退出码、手动唤醒、`server + canonical root` 会话隔离及 stderr 日志均已有真实代码路径；本轮未发现需要扩大状态模型的代码缺口。

**测试**：

- `npm run test:front -- tests/lib/lspClient.test.ts tests/lib/lspConfig.test.ts`：2 个文件、25 项通过。
- `npm run test:rs`：577 passed、5 ignored；仅保留既有 Windows linker manifest warning。
- `npm run check:ts`：通过。
- `npm run build`：通过；保留既有大 chunk 和无效动态导入警告。
- `git diff --check`：通过。
- 禁用产品名称扫描：无结果。
- Forge 浏览器 `browser_status` / `browser_tabs` / `browser_snapshot`：页面可加载，但没有桌面 Tauri bridge，无法操作设置页、安装确认、手动启动或原生会话日志；不能将这些步骤记为通过。

**Review**：

- 根因不是缺少 LSP 协议测试，而是当前验收工具链只能控制普通浏览器页面，不能控制已启动的 Tauri 原生窗口；增加 Node 假 server 只能重复 T17，不能证明设置页到 IPC 的真实链路。
- 已确认安装失败退出码、日志转发和跨项目 root 隔离的公开边界分别有前端回归测试、Rust 进程/分帧实现和 T32 跨项目测试支撑；没有证据表明需要修改业务代码。
- 阻塞证据：Forge 浏览器能力声明为主框架无障碍树和普通浏览器输入，目标页 URL 为 `http://127.0.0.1:1420/`，页面无 Tauri bridge；当前没有可用的原生窗口控制或桌面事件注入入口。

**修复**：

- 本轮无业务代码修复；避免添加不能接入真实后端的伪集成测试。
- 将 T33 明确标记为环境阻塞，保留已有测试结果和未完成的桌面验收项，不把浏览器加载烟测冒充桌面通过。

**收口**：阻塞根因是验收工具链无法控制 Tauri 原生窗口。T34 提供 `lsp-smoke` 原生 IPC 入口，T35 通过 `lsp-ui-smoke` 在真实 WebView 中完成设置页探测、安装确认、非零退出码、日志面板、手动重启与状态栏路由验收，T33 余项全部闭环；状态由阻塞改为已完成，原始阻塞证据保留在上文。

**重梳理**：下一轮进入 T34，优先提供可重复的原生窗口验收入口（由桌面测试环境提供 Tauri WebView 控制或由 CI 提供等价的原生驱动），再按“设置页探测 → 状态栏路由 → 安装确认/非零退出 → 手动启动 → 跨项目会话 → 日志反馈”顺序完成 T33 余项。入口具备前不再扩展 LSP 状态字段，也不重复修改已通过的协议链。

### T34：原生 LSP IPC 验收入口

**状态**：已完成

**实施**：

- `src-tauri/Cargo.toml` 增加 opt-in `lsp-smoke` feature 和 `lsp-smoke` binary；不进入默认产品构建，不注册生产 invoke handler。
- 新增 `src-tauri/src/lsp_smoke.rs` 和 `src-tauri/src/bin/lsp_smoke.rs`：启动隔离的 Tauri 事件循环，通过真实 `AppHandle` 调用 `lsp_start`、`lsp_write`、`lsp_session_statuses`，监听 `lsp://message`、`lsp://log`、`lsp://exit`。
- 测试 server 使用写入用户 Temp 的 Node stdio fixture；覆盖不同工程根的会话隔离、initialize、didOpen、诊断、`workspace/applyEdit`、`willSaveWaitUntil`、didSave、stderr 和退出事件。
- `scripts/test-lsp-native.mjs` 负责构建、设置隔离 `APPDATA`/`LOCALAPPDATA`、运行 binary 和读取结构化结果；`package.json` 增加 `npm run test:lsp-native`。
- Review 修复 Windows `\\?\\` 扩展路径传给 Node 导致 fixture 在启动前退出、失败路径遗留语言服务、退出码 `null` 被误判为非零和测试窗口可见四个问题；fixture 与结果只落用户 Temp。

**测试**：

- `npm run test:lsp-native`：通过；真实 Tauri `AppHandle` 启动两个不同 root 会话，协议、日志和退出事件全部通过。
- `npm run test:front -- --maxWorkers=1`：141 个文件、1447 项通过。
- `npm run test:rs`：577 passed、5 ignored。
- `npm run check:rs`、`npm run check:ts`、`npm run build`：通过。
- `git diff --check`：通过；禁用产品名称扫描无结果。
- 保留既有 Windows linker manifest、Vite 大 chunk 和无效动态导入 warning，不把 warning 当失败。

**Review**：

- 原生入口调用的是生产 LSP command 和真实 Tauri event，不是前端 mock；双 root 断言证明会话 key 不会串项目。
- fixture 参数只使用 Temp 中的普通 Win32 路径；失败时写出 session 状态和 fixture trace，并在退出前统一回收所有 LSP 子进程。
- 退出事件的 `code` 遵守公开契约：明确非零才失败，`null` 表示读管道先结束时尚未取得进程码，不能误报。
- 本轮仍没有设置页/状态栏 DOM 自动化；当前入口验证 IPC/事件边界，不把它扩展成伪 UI 测试。

**修复**：

- 修复原生验收入口的 binary 名称、Windows 长路径、stderr 日志等待、退出码断言和失败清理。
- 未修改生产 LSP 状态机、设置页或状态栏实现；现有前端回归测试继续作为 UI 状态模型的边界保障。

**重梳理**：下一轮进入 T35，使用具备 Tauri WebView 控制能力的桌面测试环境完成真正 UI 验收：设置页自动探测/手动探测、状态栏当前文件路由、安装确认和非零退出反馈、手动启动、跨项目会话、日志面板。T35 不再修改 IPC 和 LSP 状态字段，发现失败只修对应 UI 接线。

### T35：真实 Tauri WebView LSP UI 验收

**状态**：已完成

**实施**：

- `src-tauri/Cargo.toml` 增加 opt-in `lsp-ui-smoke` feature；`src-tauri/src/lib.rs` 只在该 feature 下注册 UI smoke 模块和测试入口，不改变默认产品构建。
- 新增 `src-tauri/src/lsp_ui_smoke.rs`：在用户 Temp 创建隔离工作区、Node stdio fixture 和 LSP 配置，通过真实主 WebView 注入脚本，驱动公开设置页、安装确认、日志、重启和状态栏路由。
- 新增 `scripts/test-lsp-ui-native.mjs`，自动构建带 feature 的桌面程序并启动 Vite dev server；测试使用隔离 `APPDATA`、`LOCALAPPDATA`、工作区和结果文件，不污染项目配置。
- `package.json` 增加 `npm run test:lsp-ui-native`，支持 `FORGE_SKIP_FRONTEND_BUILD=1` 进行本地 Rust/UI smoke 迭代。

**测试**：

- `npm run test:lsp-ui-native`：通过真实 Tauri WebView 完成设置页自动探测、缺失服务安装按钮、安装确认、非零退出码 7、stderr 日志面板、手动重启/运行状态和右下角当前文件语言服务/项目根路由验收。
- 发现 Windows `cmd /C` 通过普通参数传递命令时会破坏安装命令内部引号，导致 `node -e "process.exit(7)"` 被误报为成功；该问题在 `src-tauri/src/lsp_probe.rs` 修复后由同一 UI smoke 回归通过。
- T34 已覆盖跨项目会话隔离；T35 不重复伪造跨项目 UI 操作，只验证 UI 对当前工作区真实会话的消费。

**Review**：

- 首次 smoke 失败原因一：验收脚本按内部 server ID 查找卡片，但 UI 展示的是配置中的 `program`；已改为按用户可见服务名定位。
- 首次 smoke 失败原因二：卡片先于异步探测结果渲染，脚本过早断言安装按钮；已改为等待目标卡片完成探测并出现安装按钮。
- 首次 smoke 失败原因三：Windows 安装命令的引号在 `Command::args` 边界被改写，产品错误地走成功分支；这是实际安装契约缺陷，不是测试选择器问题。
- 确认 UI smoke 通过真实 Tauri invoke、真实 WebView DOM 和真实 Node 进程，不依赖浏览器 mock；失败结果由 WebView 结构化回传，避免错误链覆盖原始断言。

**修复**：

- `src-tauri/src/lsp_ui_smoke.rs`：修正缺失服务可见文本定位，并等待探测完成后的安装按钮。
- `src-tauri/src/lsp_probe.rs`：Windows 使用 `CommandExt::raw_arg` 原样传递 `/C` 后的 shell 命令，保留命令内部引号和退出码语义；Unix 路径不变。
- 修复后重新运行 UI smoke，5 项结构化检查全部通过；保留既有 Windows linker manifest 和 WebView 清理 warning，不将其误报为业务失败。

**重梳理**：下一轮进入 T36。先做 T35 之后的代码与文档总 review，核对 opt-in smoke 入口不会进入生产注册、临时目录不会落入项目、安装命令退出码和日志契约在 Rust/前端/i18n 三层一致；再根据 review 结果决定是否补充 CI 原生窗口运行条件。未完成总 review 前不扩展新的 LSP UI 功能。

### T36：T35 总 review 与测试入口收口

**状态**：已完成

**Review**：

- `lsp-ui-smoke` 只通过显式 feature 编译；默认 `forge` 构建不编译 `lsp_ui_smoke`，默认 invoke handler 也不注册验收入口。Tauri 页面仍通过真实 `on_page_load` 和 `eval_with_callback` 读取结果，不再保留未使用的前端回传 command。
- `scripts/test-lsp-ui-native.mjs` 为 `APPDATA`、`LOCALAPPDATA`、工作区和结果文件创建独立用户 Temp 根；Rust `prepare` 对工作区再次执行 Temp 根校验。fixture、配置和结果均未写入项目目录。
- 安装结果契约已闭合：Rust 返回 `command/output/exitCode`，Windows shell 原样保留命令引号；设置页与右下角状态栏都按 `exitCode !== 0` 展示退出码和输出尾部，日志面板继续消费 `lsp://log` 的 stderr。
- 当前 `.github/workflows` 只有清理和发布流程，没有可保证交互式 WebView2/可见桌面会话的 Windows UI runner；本轮不把普通 CI 当作原生 UI 验收，也不新增无法运行的伪 CI job。手工 Windows 验收脚本已可重复执行。

**修复**：

- 删除 `src-tauri/src/lib.rs` 中仅为未使用 `lsp_ui_smoke_report` 服务的 feature 专用 invoke 宏。
- 删除 `src-tauri/src/lsp_ui_smoke.rs` 中未被 UI 脚本调用的回传 command，保留结构化 WebView callback 结果链，缩小验收构建的 IPC 面。

**测试**：

- `npm run test:lsp-ui-native`：通过，5 项真实 UI 检查全部通过。
- `npm run check:rs`：通过。
- T35 已完成的 `npm run test:front -- --maxWorkers=1`（141 个文件、1447 项）、`npm run test:rs`（577 passed、5 ignored）、`npm run check:ts`、`npm run build`、`git diff --check` 和禁用名称扫描结果仍有效；T36 删除仅影响验收入口的死代码后重新跑了 Rust 检查和原生 UI smoke。
- 全局 `cargo fmt --check` 仍会报告工作区既有的大量格式差异，本轮没有对无关文件做批量格式化；本轮目标文件的编译、类型和行为验证均已通过。

**重梳理**：下一轮进入 T37，回到迁移计划的未完成能力清单，先核对当前 LSP 文档、实现和测试是否存在“已完成但没有公开验收”的声明，再选择下一个真实缺口；不再继续扩大原生 smoke 入口，也不把 CI 环境能力写成产品功能。

### T37：迁移文档事实核对与未完成能力重新分界

**状态**：已完成

**Review**：

- 发现 `docs/plans/lsp-migration/README.md` 仍停在 T27，且 `docs/plans/README.md` 仍把 Auto Import/Save Actions 写成排队；两处都落后于 TASKS.md 的 T25–T36 实际结果。
- 发现阶段 05、06 的“未做与验收”把已经有公开 seam、行为测试或真实 UI smoke 的能力继续列成未完成，无法区分“代码已完成但缺桌面工作流验收”和“功能尚未实现”。
- 发现阶段 02 对 dynamic registration 的边界已有记录，但总计划没有把它列为下一轮真实缺口；不能把协议应答误写成 capability 派生已完成。
- 发现阶段 07 仍以浏览器无 Tauri bridge 和缺少本机 server 作为当前阻塞，未反映 T34–T36 已建立并通过的真实 Tauri IPC/UI fixture 验收。

**修复**：

- 更新 `docs/plans/lsp-migration/README.md`、`docs/plans/README.md`、阶段 02/05/06/07 文档，把 T36、真实 Tauri UI smoke、Auto Import/Save Actions 和动态注册边界写成当前事实。
- 将阶段文档统一改为“已验收与未完成”：已完成的协议/适配能力单独列出；仍未完成的只有动态注册能力派生、完整多级跨文档撤销和真实编辑器工作流桌面验收。
- 不修改业务代码，不把当前环境可运行的 Node fixture 冒充为五类真实语言服务全部通过。

**测试**：

- 文档引用、状态和未完成项通过 `rg` 交叉核对；`git diff --check` 通过。
- 禁用名称扫描无结果。
- 代码行为沿用 T35/T36 已通过的前端 1447 项、Rust 577 passed、TypeScript/Rust 检查、生产构建和真实 Tauri UI smoke 结果；本轮文档-only 修复不重复运行耗时的全量桌面流程。

**重梳理**：下一轮进入 T38，先实现 dynamic registration 的 capability 派生闭环：定义注册/注销的公开能力快照、与静态 initialize capability 合并、在 server 重启/文档关闭时清理，并补充 capability 缺失与动态注册回归测试。真实编辑器工作流和完整多级撤销继续排在后续任务，不与协议状态改造混做。

### T38：dynamic registration capability 派生闭环

**状态**：已完成

**实施**：

- `src/lib/lspClient.ts` 为每个运行会话分离保存 initialize 静态 capability 与动态注册表；`client/registerCapability` 按注册 id 写入，`client/unregisterCapability` 按 `unregisterations` 删除。
- 动态注册方法映射到公开 capability 字段，支持补全、悬停、签名、导航、重命名、Code Action、格式化、语义 token、CodeLens、Inline Completion、Document Link、折叠、层级、诊断和 command 等常见 LSP 能力；未知方法只应答，不伪造 UI 能力。
- capability 每次从静态基线和当前注册表重建；多个注册同一方法时保留最后一项，注销后恢复上一项或静态值；会话重启重新建立空动态表。
- 动态注册成功后复用既有 `ready` 状态通知，让 CodeMirror 装饰插件、命令面板和 App capability 查询重新读取公开快照；未增加第二套 UI 状态源。
- `src/lib/lspTypes.ts` 补充动态注册可能映射到的公开 capability 字段。

**测试**：

- `tests/lib/lspClient.test.ts` 增加动态注册/注销、多注册共存、坏载荷 `-32602`、状态通知和重启清理测试。
- `npm run test:front -- tests/lib/lspClient.test.ts`：24 项通过。
- `npm run test:front -- --maxWorkers=1`：141 个文件、1450 项通过。
- `npm run check:ts`、`npm run build`：通过；保留既有 Vite 大 chunk 和无效动态导入 warning。

**Review**：

- 首次定向测试发现实现读取了 `registrations`，但注销协议字段实际是 `unregisterations`；因此注销没有生效，动态能力会残留。
- 修复后增加注销响应断言，确认协议成功返回 `result: null`，并确认 capability 恢复到剩余注册/静态值。
- 确认动态能力不写回配置、不跨会话复用、不覆盖 initialize 静态基线；通过 `ready` 通知触发现有消费者刷新。

**修复**：

- 修正注销载荷字段读取和校验。
- 补充公开状态通知及注册/注销/重启回归断言。

**重梳理**：下一轮进入 T39，处理完整多级跨文档 WorkspaceEdit 撤销历史，先核对现有“最近一次撤销”与 CodeMirror 普通 Undo 的边界，再决定是否能建立可验证的历史栈；真实编辑器工作流桌面验收单独排在其后。

### T39：完整多级跨文档 WorkspaceEdit 撤销历史

**状态**：已完成

**实施**：

- `src/lib/cmEditor.ts` 把“最近一次”单槽撤销换成有界历史栈（上限 10 条）：`registerWorkspaceUndo` 追加，超限丢最旧；`clearWorkspaceUndo` 在普通用户输入时清空整栈，避免旧事务回放撞上新正文。
- Ctrl+Z（`undoWorkspaceEdit`）从栈顶逐级弹出回放；上一级回放未落地时吞掉连按，不落回普通 CodeMirror undo。
- 回放前每条撤销沿用 `lspWorkspaceEdit.ts` 的 `assertUndoState`：正文/资源被外部改写即拒绝覆盖；多级场景先撤后一批，前一批校验的是回放后的正文。
- 事务应用与打开文档写回路径不变：`updateOpened` 走 swapping 回声，撤销回放不会被误判成用户输入清栈。

**测试**：

- `tests/lib/cmEditor.test.ts` 增加“WorkspaceEdit 撤销栈”：后注册先撤的 LIFO 回放、回放中吞连按、普通输入清整栈。
- `tests/lib/lspWorkspaceEdit.test.ts` 增加两批编辑依次提交后逐级回放，确认前一批冲突校验认回放后的正文。
- `npm run test:front -- tests/lib/lspWorkspaceEdit.test.ts tests/lib/cmEditor.test.ts --maxWorkers=1`：43 项通过。
- `npm run test:front -- --maxWorkers=1`：141 个文件、1454 项通过。
- `npm run check:ts`、`npm run build`：通过；`git diff --check` 干净；禁用产品名称扫描（src/tests/docs）无命中。

**Review**：

- 首次定向测试暴露回放完成要等微任务落地：同步连按会被运行守卫吞掉，测试补了落地等待；实现语义保持“回放未落地时连按不落普通 undo”。
- 确认普通输入清整栈是正确边界：用户编辑后正文不再是任何事务的落点，保留旧条目只会换来必然失败的冲突校验。
- 上限取 10 条，超出丢最旧；回放失败的条目照旧弹出并保留普通历史，错误不进编辑器事件循环。

**修复**：

- 测试侧补充微任务等待，无生产代码修复。

**重梳理**：下一轮进入 T40，处理真实编辑器工作流桌面验收：Alt+Enter code action、Rename、Signature Help、Find Usages、Reformat Code 等走真实语言服务与真实编辑器的端到端流程；本轮只记录验收证据，不新开 UI 面。

### T40：真实编辑器工作流桌面验收

**状态**：已完成

**实施**：

- `src-tauri/src/lsp_ui_smoke.rs` 的 fixture server 从“补全/定义/重命名”扩到完整工作流矩阵：`codeActionProvider`、`signatureHelpProvider`、`referencesProvider`、`documentFormattingProvider`；所有响应按 fixture 自己维护的最新正文（didOpen/didChange 全量同步）现算 range，保证与编辑器当前文本逐字一致。
- fixture 动作链与生产路径一一对应：代码动作返回 `WorkspaceEdit`（追加标记行），重命名返回对 `fixtureValue` 全部出现处的 `changes`，格式化返回整篇替换（补末换行），references 返回两处 Location。
- 冒烟工作区 `main.ts` 改为含两处 `fixtureValue` 的两行文档；设置预置 `settings.json` 把键位方案定为 `idea`（Alt+F7 / Ctrl+Alt+L 只在这一档有绑定），其余设置由前端合并默认值。
- UI 脚本在 T35 的设置页/状态栏检查之后追加编辑器工作流：真实键盘事件驱动 Ctrl+P（签名帮助浮层）、Alt+F7（用法列表两行）、Ctrl+Alt+L（行数变化验证格式化）、Alt+Enter（点击浮层动作后正文出现标记行）、Shift+F6（输入框改名后两处出现处全部生效）。

**测试**：

- `npm run test:lsp-ui-native`：真实 Tauri WebView 退出码 0，10 项结构化检查全部通过（T35 原有 5 项 + 编辑器工作流 5 项）。
- `npm run test:front -- --maxWorkers=1`：141 个文件、1454 项通过。
- `npm run check:ts`、`npm run build`（随 smoke 前置构建）通过；`git diff --check` 干净；禁用产品名称扫描无命中。

**Review**：

- 首跑在“查找用法”超时：通过的键位（Ctrl+P、Alt+Enter）在引擎内置键位表里本来就有，而 Alt+F7 / Ctrl+Alt+L 只在 `cm/keymap.ts` 的 IDEA 方案里，冒烟环境默认方案是 `default`（仅一条 Ctrl+D）。根因是测试环境键位方案与目标工作流不匹配，不是产品缺陷。
- 修复选择预置设置而非往引擎里加重复键位：生产里 IDEA 方案本来就有这些键，缺的只是冒烟环境选择哪一档；往内置键位表塞副本反而造成两套键位来源。
- 逐项确认验收走的是公开链路：真实 WebView DOM 键盘事件 → CodeMirror 键位 → `lspManager.request` → 真实 stdio fixture → WorkspaceEdit 经 App 适配器回写文档；没有 mock、没有直接调用内部函数。

**修复**：

- `prepare()` 增加 `settings.json` 预置（`editor.keymap: "idea"`）；fixture 与 UI 脚本按上述矩阵扩展。

**重梳理**：T01–T40 全部完成，本计划任务清单闭环。按 `docs/plans/README.md` 的流转规则，结论应并入 `docs/features/lsp-language-servers/` 与 `docs/features/code-editor/`（如适用），随后删除 plans 下的 `lsp-migration/`；删除属于文件清理动作，等用户确认后执行。
