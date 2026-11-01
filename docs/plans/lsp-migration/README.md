# IDEA LSP 能力迁移

**状态**：已完成（T01–T40 全部闭环，待并入 docs/features 后清理本目录）
**涉及模块**：lsp-language-servers、code-editor、settings、shell-layout；后端 `src-tauri/src/lsp.rs`、`lsp_config.rs`、`lsp_probe.rs`、`lsp_detect.rs`
**阻塞点**：核心 seam、WorkspaceEdit 撤销/写回回声、编辑器高级能力、符号/层次结构、Document Links、虚拟文档容器、Auto Import、Save Actions、保存生命周期、`.editorconfig` 变更失效、动态注册能力派生、真实 Tauri UI 验收、有界多级跨文档撤销历史和真实编辑器工作流桌面验收全部完成；无剩余阻塞。

**执行清单**：[TASKS.md](./TASKS.md) 是本计划的任务入口。每轮必须依次完成“实施 → 测试 → review → 修复 → 重新梳理下一轮”，不得跳过 review 直接扩展下一阶段。

## 背景

迁移对象是 IDEA 的 `ide-lsp`，不是 OpenCode 的 `opencode acp`。前者负责语言服务器进程、LSP 请求和编辑器语义，后者是 Agent 提供商协议。

Forge 当前已经能启动外部语言服务，完成基础 JSON-RPC 分帧、文档同步、补全、悬停、诊断、定义、引用和格式化。逻辑分散在 `App.tsx`、`lspClient.ts`、CodeMirror LSP 适配和 Tauri command 之间。

最有影响的问题是调用方掌握了 session 细节。新增一个 LSP 能力时，必须同时修改应用启动路径、请求分发、编辑器 provider、状态栏和错误处理，导致能力之间互相泄漏。

本计划把复杂度收进一个深模块。外部接口保持小，内部实现可以拆成 session、协议、文档、编辑和状态几个内部模块。调用方获得 leverage，错误和验证集中在 LSP seam，维护保持 locality。

## 已做

- `src-tauri/src/lsp.rs` 已提供 stdio 进程、Content-Length 分帧、stderr、退出事件、重试和回收。
- `src-tauri/src/lsp_config.rs` 已提供独立 `lsp.json`、三态 mode、默认 server、配置迁移和原子保存。
- `src-tauri/src/lsp_probe.rs` 与 `lsp_detect.rs` 已提供 PATH 增强、探测、安装和 root marker 解析。
- `src/lib/lspClient.ts` 已提供单例 client、initialize、文档同步、诊断和基础请求。
- `src/lib/cm/lsp.ts` 已提供 CodeMirror 的 completion、hover、diagnostics、definition、declaration、type definition、implementation、references、format、Signature Help、Code Action 和 Rename 适配。
- `src/lib/cm/lspDocumentLinks.ts` 与 `src/lib/virtualDocuments.ts` 已提供安全的 Document Link 和只读虚拟 URI 容器；未知 scheme 不进入本地路径流程。
- `src/lib/cm/lspDecorations.ts` 已提供带取消和过期结果校验的可见区 Inlay Hints。
- `src/lib/cm/lspSemanticTokens.ts`、`lspCodeLens.ts`、`lspInlineCompletion.ts` 已提供语义 token、CodeLens 和 ghost text；结果绑定 CodeMirror 文档快照。
- `LspManager.requestRaw` 已承载 `workspace/symbol` 和层级后续请求；文档符号、工作区符号、调用层级和类型层级统一复用位置结果面板。
- `src/lib/lspManager.ts` 已成为请求、能力、状态、日志、WorkspaceEdit 和 server command 的唯一前端入口。
- `src/lib/editorConfig.ts` 已提供工作区根约束的 `.editorconfig` 层级解析、glob 匹配、短 TTL 缓存和代码样式/保存规则覆盖。
- `textDocument/willSave`、`willSaveWaitUntil`、`didSave` 已接入统一保存链；保存前编辑继续经过带版本的 WorkspaceEdit。
- `LspStatusBar`、`LspDialogs` 和设置页已有基础状态、探测、安装和重试入口。
- IDEA 的 `ide-lsp` 已确认覆盖文档生命周期、补全、hover、signature、导航、引用、code action、重命名、格式化、inlay、semantic token、CodeLens、inline completion、层次结构和虚拟文档。

## 方案

迁移按以下顺序执行。每一步完成后先运行该步验收，再回头审查本步代码、计划文档和测试；review 通过后才进入下一步。

```text
01 接口与基线
  ↓
02 LspManager 与完整 JSON-RPC
  ↓
03 server 配置、候选链与 session
  ↓
04 WorkspaceEdit 与文件操作
  ↓
05 编辑器 LSP 能力
  ↓
06 Action、设置页、状态栏与右键菜单
  ↓
07 真实 server 验收、最终 review、文档收敛
```

| 阶段 | 主文档 | 交付物 | 进入下一步的条件 |
| --- | --- | --- | --- |
| 01 | [接口与基线](./01-contract-and-baseline.md) | 类型、状态、URI、错误和基线清单 | 公开接口和不变量已定，现有行为基线已记录 |
| 02 | [Manager 与协议](./02-manager-and-protocol.md) | LspManager、双向 JSON-RPC、文档同步和重启 | 现有补全、hover、诊断、导航、格式化不回归 |
| 03 | [配置与会话](./03-server-config-and-session.md) | 候选 server、fallback、项目配置和 session pool | 启动、失败、重试、回收和配置持久化可验收 |
| 04 | [WorkspaceEdit](./04-workspace-edit.md) | 多文件编辑、资源操作、未保存内容、失败恢复和用户撤销 | Rename/Code Action 有可靠的编辑执行 seam；撤销前有外部改写冲突保护 |
| 05 | [编辑器能力](./05-editor-capabilities.md) | Signature、导航、Code Action、Rename、Inlay Hints | 已实现能力有 capability 判断、状态和用户工作流；高级能力另拆任务 |
| 06 | [Action 与 UI](./06-actions-and-ui.md) | 全局 Action、设置页、状态栏、菜单和面板 | 所有入口调用同一 Action，UI 不直接碰 session |
| 07 | [Review 与验收](./07-review-and-validation.md) | 协议、文件、UI、真实 server 和发布验收 | review 清单通过，稳定结论并入 features |

### 不迁移的实现细节

- 不复制 IDEA 的 Rust 代码结构。Forge 保留现有 Tauri 传输 Adapter，迁移行为和能力。
- 不引入 `monaco-languageclient`。当前编辑器是 CodeMirror，直接引入会替换编辑器接入层。
- 第一版文档变更继续发送全文，不在没有性能证据时增加增量 diff 算法。
- 同一文档只绑定一个活动 server。多个配置项表示候选和 fallback，不合并多个 server 的语义结果。
- 不在本计划中迁移 OpenCode ACP、插件系统、全局索引或 DAP。

## 未做与验收

本计划已经修改源代码。T01–T40 已完成统一类型、协议解析、Manager seam、候选与 fallback、WorkspaceEdit 事务恢复与有界多级撤销历史、编辑器基础/高级能力、Action 门面、符号/层级入口、Document Link、只读虚拟文档容器、Auto Import、Save Actions、保存生命周期、`.editorconfig` 变更失效、动态注册能力派生、真实语言服务 IPC 验收、真实 Tauri UI 验收和真实编辑器工作流桌面验收（签名帮助、查找用法、格式化、代码动作、重命名）。

实现阶段的最低验收要求：

- LspManager 是唯一的外部 LSP seam。`App.tsx`、CodeMirror provider、设置页和状态栏不直接发送 JSON-RPC 或管理进程。
- server 进程崩溃后，打开文档能够重新初始化并重放；失败状态不会伪装成 ready。
- WorkspaceEdit 不覆盖未保存内容，不吞版本冲突；成功事务按时间序登记为有界多级跨文档用户撤销（普通输入清栈），每级回放前校验正文/资源没有被外部改写；关闭文档写盘回声按路径、正文和有限生命周期抑制。真实 WebView 中代码动作与重命名已经走通这条链（T40）。
- 所有编辑器能力在 capability 缺失时返回明确的 unavailable，不发送无效请求。
- UI 菜单、快捷键、命令面板和项目树入口调用同一 Action。
- 每一步 review 之后才推进下一步；虚拟文档协议继续留在本目录，完成后才并入 `docs/features/`。

## 出处

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `docs/features/lsp-language-servers/README.md` | 当前档位、配置、进程通道、会话生命周期、root 解析、探测和编辑器适配 | `:1-260`、`:300-430` |
| `src/lib/lspClient.ts` | 当前 client、initialize、请求、reconcile、文档同步和关闭 | `:18-875` |
| `src/lib/lsp.ts` | Tauri LSP command 的前端 Adapter | `:1-141` |
| `src/lib/lspConfig.ts` | 前端配置类型、server 选择和读写 | `:1-85` |
| `src/lib/cm/lsp.ts` | 当前 CodeMirror LSP provider | 文件全文 |
| `src-tauri/src/lsp.rs` | 进程、分帧、事件、session、失败退避和回收 | `:1-850` |
| `src-tauri/src/lsp_config.rs` | 配置模型、种子、归一化、迁移和保存 | `:1-740` |
| `src-tauri/src/lsp_probe.rs` | 探测和安装 | `:1-390` |
| `src-tauri/src/lsp_detect.rs` | root marker 解析 | 文件全文 |
| 外部 IDEA 对标资料 `crates/ide-lsp/src/lib.rs` | IDEA LspManager 能力范围和生命周期 | `:611-2055` |
| 外部 IDEA 对标资料 `crates/ide-language/src/lib.rs` | IDEA server 配置模型 | `:21-101` |

