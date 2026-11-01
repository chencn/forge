# LspManager 与 JSON-RPC

**状态**：已完成（基础协议与 Manager 链路）
**涉及模块**：lsp-language-servers；`src/lib/lspClient.ts`、`src/lib/lsp.ts`、`src-tauri/src/lsp.rs`
**阻塞点**：基础请求、通知、取消、超时、状态和退出恢复已收敛；progress、dynamic registration 等尚未使用的协议扩展不在当前批次。

## 背景

IDEA 的 LspManager 把 server session、文档同步、请求、诊断、配置和重启放在同一生命周期模型下。Forge 的传输 Adapter 已经够用，缺的是协议状态的深模块。

## 已做

- Tauri 后端已经按 Content-Length 读取 stdout，并通过 `lsp://message`、`lsp://log`、`lsp://exit` 发事件。
- 前端已经处理 initialize、response、diagnostics 和基础 request。
- 后端已经提供 start、write、stop、reap、failed、retry、probe、install 和 resolve root command。
- 当前文档变更以全文方式发送，并带有防抖。
- 已建立 `lspManager` seam，App、CodeMirror、语言服务设置页和 LSP 测试通过 Manager 调用。
- 已缓存 initialize 返回的 capabilities 和 position encoding，编辑器位置转换使用协商编码。
- 已统一解析 JSON-RPC request、notification、response，并对未知 server request 返回 `-32601`。
- 已支持 `AbortSignal` 取消请求，发送 `$/cancelRequest` 并清理 pending。
- 已新增 `LspWorkspaceEditHandler` seam；`workspace/applyEdit` 会等待执行器完成后返回结构化结果，携带 server 的位置编码和来源。

## 方案

### 模块和 seam

新增 `src/lib/lspManager.ts`，保留 `src/lib/lsp.ts` 为 Tauri Adapter。

`lspManager` 对外隐藏：

- session id 和 request id 分配。
- JSON-RPC 帧和事件名称。
- initialize 以及 initialized 的顺序。
- capability 和 position encoding 缓存。
- pending request、timeout、cancel 和重试。
- server notification、server request 和 progress。
- server 状态派生。

CodeMirror、`App.tsx`、设置页和状态栏只能调用 Manager 接口。

### 初始化状态机

```text
missing
  → starting
  → initializing
  → ready
  → busy
  → ready
  → crashed
  → restarting
  → initializing
```

启动顺序固定为：

1. 解析活动 server 和 root。
2. 通过 Tauri Adapter ensure session。
3. 发送 `initialize`。
4. 记录 capabilities 和 position encoding。
5. 发送 `initialized`。
6. 重放待打开文档。
7. 派发 ready。

初始化失败不能进入 ready。请求超时只结束该请求；进程退出才进入 crashed。

### JSON-RPC 双向消息

前端必须处理：

- request / response / notification。
- server → client request。
- 错误 response。
- `$/cancelRequest`。
- `$/progress`。
- `client/registerCapability`、`client/unregisterCapability`。

第一批 server → client 方法：

```text
workspace/configuration
workspace/applyEdit
window/showMessage
window/showMessageRequest
window/logMessage
window/workDoneProgress/create
client/registerCapability
client/unregisterCapability
```

未知 server request 返回方法未实现错误，不阻塞主消息循环。

### 文档同步

第一版继续使用全文 `didChange`：

```text
didOpen → didChange(full text)* → didSave → didClose
```

文档快照由 Manager 保存。server 重启后先重新 initialize，再按打开顺序重放当前快照。旧 session 的诊断和请求结果按 session generation 丢弃。

### Tauri 后端边界

`src-tauri/src/lsp.rs` 继续只负责进程和字节流：

- spawn、stdin、stdout、stderr、exit。
- Content-Length 编码和解码。
- 进程树停止和回收。
- 稳定事件载荷。

Rust 不实现编辑器 provider、WorkspaceEdit 或 UI 状态。这样可以保留当前传输实现，减少迁移面。

## 未做与验收

- server 能发送 `workspace/configuration` 并收到结构化响应：已完成并有协议测试。
- server 能发送 `workspace/applyEdit`，请求进入 WorkspaceEdit 执行器并获得 `applied/failureReason` 结果：已完成并有 Manager 测试。
- progress 可以派生为 busy，结束或取消后恢复 ready。
- server 退出后，状态栏显示 crashed/restarting，文档能够重放。
- initialize 返回的 capability 和 position encoding 可被请求方读取：已完成并有 Manager 测试。
- `workspace/applyEdit` 已接入执行器；执行器的文件系统与打开文档适配器由 App 注册，未注册时明确返回失败。
- 已完成：动态注册保存注册 id、按方法并入公开 capability；注销后恢复剩余注册或 initialize 静态值，重启会话清空动态状态，并通过既有状态通知让编辑器和 Action 重新读取能力。
- 同一 session 的消息不会被另一窗口消费。
- 阶段结束后执行 review 文档的“阶段 02”清单。

## 出处

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `src/lib/lspClient.ts` | 当前 initialize、消息处理、请求、reconcile 和关闭 | `:222-611`、`:611-875` |
| `src/lib/lsp.ts` | Tauri Adapter | `:76-141` |
| `src-tauri/src/lsp.rs` | session、读写、事件、退出和回收 | `:35-140`、`:341-698` |
| `docs/features/lsp-language-servers/README.md` | 分帧、事件、启动退避和文档同步 | `:80-190` |
| 外部 IDEA 对标资料 `crates/ide-lsp/src/lib.rs` | IDEA 文档生命周期、服务器状态和关闭 | `:611-763`、`:1805-2055` |

