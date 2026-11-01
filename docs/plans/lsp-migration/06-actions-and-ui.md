# LSP Action 与 UI

**状态**：T13–T18 已完成
**涉及模块**：code-editor、lsp-language-servers、settings、shell-layout、file-explorer；`src/App.tsx`、`LspStatusBar.tsx`、`LspDialogs.tsx`、设置页和菜单模块
**阻塞点**：LSP 编辑器动作和命令面板已通过统一门面并按 capability 过滤；项目树菜单仍沿用既有文件动作，不属于本轮 LSP Action 扩展。

## 背景

功能迁移到编辑器后，用户会从多个入口触发同一动作。每个入口各自实现会造成快捷键能用、右键菜单不能用，或菜单显示可用但 server 未 ready。

## 已做

- 编辑器已有基础右键和快捷键入口。
- 项目树已有上下文菜单和动作注册位置。
- `LspStatusBar` 和 `LspDialogs` 已有 server 状态、安装、重试和日志的基础 UI。
- 设置页已有语言服务配置入口。

T13–T15 已完成的收口：已有 `ForgeCommand[]` 承担命令搜索 registry；编辑器 LSP 动作通过 `editorEnv`/`cmEditor` 门面进入当前 EditorView，并用 `ForgeCommand.enabled` 按 capability 过滤。项目树既有回调暂不重写，review 已确认它们不绕过 Manager。T16–T18 补完真实 server 验收、文档和最终状态收敛。

T15 记录：只读文档不再显示 Rename；不可用动作不会进入动作搜索和最近动作；全量前端 1402 项通过。浏览器预览因缺少 Tauri bridge 无法完成桌面编辑器交互，只记录为环境限制。

## 方案

新增 Action 模块：

```text
src/lib/actions/
  actionRegistry.ts
  lspActions.ts
  editorActions.ts
```

### Action 接口

每个 Action 包含 id、标题、快捷键提示、可用性和执行函数。可用性由统一上下文计算：

- 当前 URI。
- 当前光标和选区。
- 当前项目 root。
- active server state。
- server capabilities。
- 文件是否可写。
- 是否有未完成 WorkspaceEdit。

Action 执行函数只调用 LspManager、WorkspaceEdit 和导航模块，不操作 JSON-RPC 或 Tauri command。

### LSP Action 清单

统一注册以下动作：

- Go to Definition。
- Go to Declaration。
- Go to Type Definition。
- Go to Implementation。
- Find Usages。
- Rename。
- Quick Documentation。
- Show Signature Help。
- Show Context Actions。
- Reformat Code。
- Optimize Imports。
- Fix All。
- Generate。
- Implement Methods。
- Override Methods。

同一个 Action 可被快捷键、命令搜索、编辑器右键菜单、项目树右键菜单和工具栏复用。

### 设置页

设置页显示：

- server 列表和 mode。
- command、args、env、path。
- root markers。
- fallback 顺序。
- 项目级覆盖。
- install hint 和探测结果。
- runtime 版本和 Java 检查。
- 当前版本、PID、状态和最近错误。
- capability 摘要。
- 日志、重启和 Retry。

设置页不直接启动或停止进程。所有变更先保存配置，再由 Manager reconcile。

### 状态栏

状态栏使用 Manager 的派生状态：

```text
Missing / Starting / Initializing / Ready / Busy / Crashed / Restarting / Disabled / Misconfigured
```

状态栏提供当前语言、active server、root、状态、打开设置、查看日志和手动 Retry。`running` 只能表示进程存在，不能直接显示为 Ready。

### 菜单和编辑器 UI

- capability 不支持的动作不显示为可点击。
- server 未 ready 时可显示动作，但执行时返回明确 unavailable；不发送无效协议请求。
- Alt+Enter 打开 Code Action 列表。
- Rename 使用原地编辑器，并在多文件编辑前显示冲突。
- Signature Help、Quick Documentation 和 Hover 使用独立弹层，不复用不兼容的补全状态。
- References、Workspace Symbols、Call Hierarchy、Type Hierarchy 使用结果面板。
- 诊断标签、概览条和 LSP 状态使用同一来源。

## 已验收与未完成

- 已验收：快捷键、命令搜索、编辑器入口和状态栏通过同一 Manager/Action seam；capability 缺失时不发送无效请求。
- 已验收：设置页保存只触发一次 reconcile；状态栏区分路由、运行状态、安装状态和项目根；右键菜单不直接访问 `lspClient` 或 Tauri invoke。
- 已验收：设置页探测、安装确认、失败退出码、stderr 日志、手动重启和右下角自动路由已由真实 Tauri WebView smoke 覆盖。
- Alt+Enter、Rename、Signature Help、Find Usages 和 Reformat Code 的完整真实编辑器工作流桌面验收已完成（T40，`npm run test:lsp-ui-native` 10 项结构化检查全部通过）。
- 阶段结束后执行 review 文档的“阶段 06”清单。

## 出处

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `src/App.tsx` | 当前 LSP 文档收集、reconcile 和状态连接 | `:602-658` |
| `src/components/LspStatusBar.tsx` | 当前状态栏 | 文件全文 |
| `src/components/LspDialogs.tsx` | 当前 LSP 对话框 | 文件全文 |
| `src/features/settings/pages/LanguagePages.tsx` | 当前语言服务设置页 | 文件全文 |
| `src/components/ContextMenu.tsx` | 项目树和上下文菜单入口 | 文件全文 |
| `src/lib/shortcuts.ts`、`src/lib/cm/keymap.ts` | 全局快捷键与编辑器键位方案 | 文件全文 |
| 外部 IDEA 对标资料 `src/features/tools/LanguageServersPage.tsx` | IDEA 语言服务设置 | 文件全文 |
| 外部 IDEA 对标资料 `src/features/tools/ServerSettings.tsx` | IDEA server 设置 | 文件全文 |
| 外部 IDEA 对标资料 `src/features/code-insight/ServerStatus.tsx` | IDEA server 状态 | 文件全文 |

