# 编辑器 LSP 能力迁移

**状态**：T07–T27、T35–T38 已完成；进入下一轮能力梳理
**涉及模块**：code-editor、lsp-language-servers；`src/lib/cm/lsp.ts`、`src/components/CodeEditor.tsx`、编辑器弹层和结果面板
**阻塞点**：基础与高级编辑器能力、符号/层次结构、Document Links、虚拟文档容器、Auto Import、Save Actions、保存生命周期、`.editorconfig`、动态注册能力派生、完整多级跨文档撤销历史（T39）和真实编辑器工作流桌面验收（T40）全部接入；无剩余阻塞。

## 背景

IDEA 的编辑器能力不是一组独立按钮。Signature、Code Action、Rename、inlay、semantic token 和 CodeLens 共享请求取消、文档位置、WorkspaceEdit、装饰更新和 server 状态。

## 已做

- 当前已有 completion、hover、diagnostics、definition、declaration、type definition、implementation、references、format、Signature Help、Code Action 和 Rename。
- `src/lib/cm/lspDocumentLinks.ts` 已提供 Document Link 的安全归一化、悬停提示、Ctrl/⌘ 点击和过期结果清理；未知 URI scheme 不进入打开流程。
- `src/lib/virtualDocuments.ts` 与 `useDocuments.openVirtualUri` 已提供 URI 身份与内部键分离的只读虚拟文档容器；虚拟文档不参与磁盘读写和 LSP 文件同步。
- CodeMirror 已有 LSP 适配入口。
- 编辑器已有光标、选区、文档变更、保存和右键菜单上下文。
- 状态栏已有基础语言服务状态。

## 方案

先保持现有 CodeMirror 适配入口，所有模块通过 LspManager，不直接访问传输层或文件系统。第一批按“可复用位置导航 → tooltip → WorkspaceEdit 动作 → 重命名”推进。请求结果必须绑定路径和发起时的文档版本；过期结果直接丢弃，不能回写新文档。

T07 重梳理后的文件与边界见 `TASKS.md`；T08 只实现第一批基础能力，不提前引入全局 Action registry 或高级装饰系统。

原计划的目录拆分留到能力稳定后再做，避免在协议边界未收口前制造无意义的文件搬迁：

```text
src/lib/cm/lsp/
  index.ts
  protocol.ts
  completion.ts
  hover.ts
  diagnostics.ts
  navigation.ts
  signature.ts
  actions.ts
  rename.ts
  inlay.ts
  semantic.ts
  codeLens.ts
  inlineCompletion.ts
  workspaceSymbols.ts
  hierarchy.ts
  virtualDocuments.ts
```

按依赖顺序迁移：

1. Signature Help。先完成光标位置、触发字符、参数提示和取消。
2. Declaration、Type Definition、Implementation。复用 Location 结果导航。
3. Code Action 和 Alt+Enter。接入 WorkspaceEdit 和 server command。
4. Rename。实现原地输入、预览冲突和多文件撤销。
5. Document Highlight。使用当前文档范围和可见区更新。
6. Inlay Hints。按可见区请求，文档变更时取消旧请求。
7. Semantic Tokens。处理 full、delta、refresh 和主题映射。
8. CodeLens。显示命令、刷新和点击执行。
9. Inline Completion。提供 ghost text、接受、拒绝和取消。
10. Workspace Symbols。使用结果面板和跨文件导航。
11. Document Links。处理点击、悬停和过期 URI。
12. Call Hierarchy、Type Hierarchy。复用树状结果面板。
13. Virtual Documents。用只读临时文档查看，不混入普通 dirty 文档。
14. Auto Import、Save Actions。最后接入 WorkspaceEdit 和保存流程。

### Capability 规则

每个 provider 在发请求前读取当前 server capabilities。缺少能力时：

- 不发送请求。
- Action 显示 unavailable 或隐藏，取决于入口是否需要可解释反馈。
- 不改变编辑器已有内容。
- server 重启后重新读取 capability。

### UI 规则

- 弹层只负责展示和把用户选择交回 Action。
- 装饰只接受带文档版本的结果，旧版本结果丢弃。
- 长请求显示 busy，但不阻塞编辑器输入。
- 用户输入和 LSP 结果冲突时，用户 buffer 优先。
- 所有多文件修改都进入 WorkspaceEdit，不在 provider 内直接写盘。

## T08/T09 执行记录

- 实施：位置导航复用统一面板；Signature Help 使用带路径和正文快照校验的 tooltip；Code Action 支持 `edit` 与 `command`，前者进入 `lspManager.applyWorkspaceEdit`，后者进入 `workspace/executeCommand`；Rename 使用临时输入并复用 WorkspaceEdit。
- 测试：全量前端 134 个测试文件、1397 项通过；TypeScript 检查通过；定向 LSP/编辑器 25 项通过；`git diff --check` 通过。
- Review：发现并修复 Code Action 失败按钮、Rename 非法结果输入框的永久 disabled 问题；确认没有 provider 直接写盘或旧结果覆盖新文档。
- 边界：Auto Import 与 Save Actions 已完成；Action registry 已由现有 `ForgeCommand[]` 承担，不另造第二套。

## 下一轮梳理

T25 已完成 Auto Import 与 Save Actions。`additionalTextEdits` 与主补全现在统一进入带版本的 WorkspaceEdit；保存前格式化通过同一 WorkspaceEdit 入口，尾随空白和末尾换行由纯函数处理，最后复用现有乐观锁保存。格式化等待期间若正文变化则放弃本次保存，WorkspaceEdit 冲突不继续写盘。

T26 已补齐保存生命周期：客户端按 server 能力发送 `willSave`，等待并带版本应用 `willSaveWaitUntil` 编辑，写盘成功后发送 `didSave`；没有对应能力时不发无效请求。`.editorconfig` 从工作区根逐层读取，覆盖 tab 宽度、缩进风格、行尾、末尾换行和尾随空白策略，未配置项回退到全局设置。跨文档 WorkspaceEdit 撤销仍是最近一次事务的用户级撤销，具备外部改写冲突保护，但不是完整的多级历史。

带附加编辑的 snippet 为保证原子性降级为默认文本，普通 snippet 仍保留占位跳转。

T26 已完成“实施 → 定向测试 → review → 修复 → 文档同步”。下一轮先做真实语言服务保存协议验收和 `.editorconfig` 缓存失效，再决定是否扩展撤销历史。

## 已验收与未完成

- 已验收：各能力在 capability 缺失、请求取消、旧文档结果和 server 状态变化时按统一边界处理。
- 已验收：Signature Help、Code Action、Rename、Inlay、semantic token、CodeLens、Inline Completion、诊断、符号/层级、Document Link 和虚拟文档均有公开 seam 或行为测试。
- 已验收：Document Link 只接受有效 `file:` 目标；虚拟 URI 不参与普通磁盘保存和 LSP `didOpen`。
- 已完成：动态注册已并入 capability 派生，注销和 server 重启不会残留旧能力；Alt+Enter、Rename、Signature Help、Find Usages、Reformat Code 已在真实 WebView 中按 IDEA 键位方案完成桌面验收（T40，`npm run test:lsp-ui-native`）。
- 仍未完成：完整多级跨文档 CodeMirror Undo；当前只保证最近一次 WorkspaceEdit 撤销和外部改写冲突保护。
- 阶段结束后执行 review 文档的“阶段 05”清单。

## 出处

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `src/lib/cm/lsp.ts` | 当前编辑器 LSP provider | 文件全文 |
| `src/lib/cm/lspDocumentLinks.ts` | Document Link 请求、file URI 校验、悬停、点击和过期结果清理 | 文件全文 |
| `src/lib/virtualDocuments.ts` | 虚拟 URI scheme 校验与 `virtual:lsp/...` 内部键 | 文件全文 |
| `src/hooks/useDocuments.ts` | 只读虚拟文档元数据、`openVirtualUri` 和关闭清理 | `:33-74`、`:378-432`、`:827-876` |
| `src/components/CodeEditor.tsx` | 编辑器生命周期、上下文和交互入口 | 文件全文 |
| `src/lib/lspClient.ts` | 当前请求、诊断、文档同步和超时 | `:222-611`、`:775-875` |
| 外部 IDEA 对标资料 `src/editor/lsp/index.ts` | IDEA 前端 LSP 入口 | 文件全文 |
| 外部 IDEA 对标资料 `src/editor/lsp/completion.ts` | 补全能力 | 文件全文 |
| 外部 IDEA 对标资料 `src/editor/lsp/signature.ts` | Signature Help | 文件全文 |
| 外部 IDEA 对标资料 `src/editor/lsp/inplaceRename.ts` | 原地重命名 | 文件全文 |
| 外部 IDEA 对标资料 `src/editor/lsp/inlay.ts` | Inlay Hints | 文件全文 |
| 外部 IDEA 对标资料 `src/editor/lsp/semantic.ts` | Semantic Tokens | 文件全文 |
| 外部 IDEA 对标资料 `src/editor/lsp/codeLens.ts` | CodeLens | 文件全文 |

