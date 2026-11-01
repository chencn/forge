# LSP 接口与基线

**状态**：已完成
**涉及模块**：lsp-language-servers、code-editor；`src/lib/lspClient.ts`、`src/lib/lsp.ts`、`src/lib/cm/lsp.ts`
**阻塞点**：公开类型、状态、URI、位置编码和错误边界已冻结并由 LspManager 对外承接；后续只在新增能力需要时扩展契约。

## 背景

LSP 能力依赖同一组协议不变量。URI、位置编码、文档版本、server 状态和 capability 如果各自定义，补全、导航和 WorkspaceEdit 会得到不同结果。

## 已做

- 当前前端使用 session id 连接 Tauri 进程。
- 当前文档快照包含路径、语言和全文。
- 当前 server 配置以 server key 为索引，mode 为 `off`、`builtin`、`lsp`。
- 当前诊断通过 URI 回写编辑器模型。
- 当前路径和 URI 已在多个调用点分别规范化。
- 已新增统一领域类型、JSON-RPC 消息判别和 UTF-8/16/32 位置转换。
- 现有编辑器和应用调用已切到 `lspManager` seam，基础 session 行为保持不变。

## 方案

### 公开类型

新增统一类型模块，建议位置为 `src/lib/lspTypes.ts`。类型只描述公开行为，不暴露 Tauri event 载荷和内部 session 表。

必须定义：

- `LspDocument`：URI、languageId、text、version、dirty。
- `LspPosition`、`LspRange`、`LspLocation`。
- `LspTextEdit`、`LspWorkspaceEdit`、`LspResourceOperation`。
- `LspDiagnostic`、`LspDiagnosticTag`、`LspPublishDiagnostics`。
- `LspServerCapabilities`，使用可选能力而不是一组 UI 布尔值。
- `LspServerState`：`missing`、`starting`、`initializing`、`ready`、`busy`、`crashed`、`restarting`、`disabled`、`misconfigured`。
- `LspError`：transport、protocol、server、timeout、cancelled、conflict、unavailable。
- `LspPositionEncoding`：`utf-8`、`utf-16`、`utf-32`。

### URI 和位置不变量

- LSP 内部统一使用 URI，文件系统操作只在 Adapter 处转换为 Windows 路径。
- Windows 盘符、大小写、反斜杠、空格和中文路径经过同一规范化函数。
- 初始化完成前使用 server 协商出的 position encoding；未协商时使用 LSP 默认 `utf-16`。
- 编辑器偏移转换集中在一个模块，不能由每个 provider 自己计算。
- 文档版本单调递增；关闭文档后不再接受该版本的 server 结果。

### Manager 接口

上层只需要以下操作：

```ts
openDocument(document: LspDocument): Promise<void>
changeDocument(change: LspDocumentChange): Promise<void>
saveDocument(uri: string): Promise<void>
closeDocument(uri: string): Promise<void>
request<T>(uri: string, method: string, params: unknown): Promise<T>
cancel(requestId: number): void
applyWorkspaceEdit(edit: LspWorkspaceEdit): Promise<LspApplyEditResult>
getState(uri: string): LspServerState
getCapabilities(uri: string): LspServerCapabilities | undefined
subscribe(listener: LspEventListener): () => void
```

接口包含顺序约束：`openDocument` 必须先于文档请求；`changeDocument` 的 version 不能回退；`closeDocument` 必须使后续结果失效。

### 基线

实施前记录以下现状：

- 已启用 TypeScript LSP 时，打开、编辑、保存、关闭一份文档的事件顺序。
- 补全、hover、诊断、定义、引用和格式化各一条成功请求。
- server 不存在、启动超时、进程退出、手动重试四种错误状态。
- 中文路径、空格路径和 Windows 盘符路径。
- 现有前端测试、Rust 测试、类型检查和构建结果。

基线只记录公开行为，不记录 request id、函数调用顺序或内部 Map 结构。

## 未做与验收

- 新增类型后，现有 LSP 前端和 CodeMirror provider 使用统一类型，不能继续定义重复的公开类型。
- 给定 `C:\项目\中文\a.ts`，URI 往返转换后路径相等。
- 给定 UTF-16、UTF-8、UTF-32 三种编码，公开位置转换的 range 不越界。
- 文档版本倒退、关闭后回包、未知 session 和取消请求都返回明确错误。
- 现有基础能力的行为与基线一致。
- 阶段 01 的 LSP 定向测试已通过；全局 TypeScript 检查仍被用户并发 VCS 改动阻断。
- 阶段结束后执行 [review 与验收](./07-review-and-validation.md) 的“阶段 01”清单。

## 出处

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `src/lib/lspClient.ts` | `LspDocument`、请求、诊断、文档同步 | `:18-32`、`:512-611`、`:775-875` |
| `src/lib/lsp.ts` | session、消息、退出和配置载荷 | `:1-141` |
| `src/lib/lspConfig.ts` | mode、server 配置和语言选择 | `:1-85` |
| `src/lib/cm/lsp.ts` | provider 请求和编辑器位置转换 | 文件全文 |
| `docs/features/lsp-language-servers/README.md` | URI、文档同步、请求超时和 provider 现状 | `:190-260` |

