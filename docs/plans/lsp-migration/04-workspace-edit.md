# WorkspaceEdit 与文件操作

**状态**：已完成（文件事务、编辑器撤销事务和关闭文档写回标识均已接入）
**涉及模块**：lsp-language-servers、code-editor、workspace-watch；`src/lib/lspWorkspaceEdit.ts`、文档 store、文件系统和撤销栈
**当前缺口**：文件事务和用户撤销边界已完成；虚拟文档/特殊资源仍按高级能力单独处理，不在普通 WorkspaceEdit 中伪装支持。

## 背景

IDEA 的 Rename、Code Action、自动导入、重构和文件移动都依赖 WorkspaceEdit。直接在 provider 中改文本会绕过未保存内容、版本、撤销和文件监听。

## 已做

- Forge 已有打开文档和编辑器 buffer。
- LSP 请求和结果已经能通过 URI 定位文件。
- 文件系统、文档保存、工作区监听和本地历史分别已有实现。
- 当前已有跨文件统一执行入口，成功事务登记为一次 CodeMirror 用户级撤销，并在执行前做正文/资源冲突校验。
- 已新增 `src/lib/lspWorkspaceEdit.ts`，并由 `lspManager` 和 `workspace/applyEdit` 共用。
- App 已注册文档适配器：打开文档只更新内存 buffer，关闭文档才写磁盘；位置编码使用 server 协商值。

## 方案

### 模块接口

新增 `src/lib/lspWorkspaceEdit.ts`。它的外部接口只表达一次用户编辑：

```ts
apply(edit: LspWorkspaceEdit, context: LspEditContext): Promise<LspApplyEditResult>
```

实现内部负责：

- URI 到文档或文件的定位。
- 文档内存内容和磁盘内容的选择。
- position encoding 转换。
- 多 range 的逆序应用。
- 文档版本检查。
- Create、Delete、Rename 文件操作。
- 单次撤销事务。
- 文件监听抑制和刷新；关闭文档写盘用路径、正文和有限生命周期标识回声。

### 内容来源

目标文件按以下顺序取内容：

1. 当前打开文档的内存 buffer。
2. 文件系统中的磁盘内容。
3. 文件不存在时使用空内容，仅允许 CreateFile 或明确的新文件编辑。

WorkspaceEdit 不能用磁盘副本覆盖 dirty buffer。应用后，打开文档继续保持 editor buffer 为真相，并标记 dirty。

### 操作顺序

一批 WorkspaceEdit 按以下规则执行：

1. 解析并校验所有 URI、版本和操作选项。
2. 预读所有文件内容。
3. 对同一文件按 descending position 应用 TextEdit。
4. 先处理 Create、Rename 的路径映射，再处理目标文本。
5. 处理 Delete，并拒绝删除仍有未保存内容的文件，除非用户确认策略允许。
6. 一次性提交编辑器 buffer、磁盘变更和撤销事务。
7. 通知文件监听和 LSP 文件操作。

当前实现先完整预读和校验文本、版本、range 与 URI，再提交资源操作和文本；普通文件资源与文本失败会按逆序恢复，目录和特殊条目在提交前返回 `unavailable`。编辑器侧跨文档撤销已经接通（有界多级历史栈，见 T19 与 T39）；WorkspaceEdit 对关闭文档写盘的 watcher 标识仍未接入。

### 版本和冲突

- `TextDocumentEdit.version` 与当前文档版本不符时返回 conflict。
- 没有版本号时只在文档未发生并发变更时应用。
- 冲突结果包含 URI、server 来源、期望版本和实际版本。
- UI 提供查看差异、重新应用和取消，不自动覆盖。

### LSP 入口

WorkspaceEdit 统一承接：

- `workspace/applyEdit`。
- Rename 返回值。
- Code Action 返回值。
- Organize Imports、Fix All、Refactor。
- Generate、Implement Methods、Override Methods。
- 文件移动后的 `workspace/didRenameFiles`。

## 未做与验收

- 两个打开文件和一个未打开文件可以被一批 TextEdit 同时修改：已覆盖执行器测试，App 适配器仍需真实工作区验证。
- dirty 文档的内存内容不会被磁盘旧内容覆盖：已实现打开文档优先读取内存。
- UTF-16、UTF-8、UTF-32 range 都能落在正确字符边界：已覆盖协议和执行器测试。
- Create、Delete、Rename 的选项已进入适配器接口，真实目录存在性和递归删除仍需补桌面验证。
- 版本冲突返回带 `conflict`、URI 和期望/实际版本的失败结果，并在预提交阶段阻止文本写入：已覆盖执行器测试。
- 一批编辑在编辑器内可作为一次操作撤销：已接（T19 单级撤销 seam，T39 扩成上限 10 条的有界多级历史栈；普通用户输入清整栈，逐级回放前校验正文/资源未被外部改写）；T40 在真实 WebView 中通过代码动作与重命名走通了这条 WorkspaceEdit 链。
- 文件监听不会把自身写入误报为外部覆盖：现有保存路径已做；WorkspaceEdit 对关闭文档的直接写盘尚未登记 `savedAtRef` 标识。
- `workspace/applyEdit`、Rename 和 Code Action 共用同一执行入口；跨文档撤销历史已接通（同上）。
- 阶段结束后执行 review 文档的“阶段 04”清单。

## 出处

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `src/lib/lspClient.ts` | 当前文档快照、版本和请求结果 | `:18-32`、`:578-611`、`:775-842` |
| `src/lib/cm/lsp.ts` | 当前 provider 对编辑器的适配 | 文件全文 |
| `src/lib/fs.ts` | 前端文件操作入口 | 文件全文 |
| `src/hooks/useDocuments.ts` | 文档 buffer、保存和 dirty 状态 | 文件全文 |
| `src-tauri/src/watch.rs` | 文件监听与外部变更 | 文件全文 |
| `src-tauri/src/history.rs` | 本地历史与恢复 | 文件全文 |
| 外部 IDEA 对标资料 `crates/ide-lsp/src/lib.rs` | Code Action、Rename、文件移动和格式化 | `:1185-1586` |

