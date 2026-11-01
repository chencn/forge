# LSP Review 与验收

**状态**：T17、T18、T34、T35、T36、T38 已完成；后续高级能力按 TASKS.md 新建独立任务
**涉及模块**：lsp-language-servers、code-editor、settings、shell-layout；前端、Rust、测试和真实语言服务器
**阻塞点**：真实 Tauri IPC/UI 验收、动态注册能力派生、完整多级撤销和真实编辑器工作流桌面验收全部完成（T34/T35/T38/T39/T40）。浏览器预览缺少 Tauri bridge，桌面验收由 `test:lsp-native` 与 `test:lsp-ui-native` 承担。

## 背景

本计划要求每一步完成后回头 review。review 不只检查编译，而是检查接口深度、状态不变量、用户行为、文档是否仍准确和测试是否只验证公开契约。

## 已做

- 仓库已有前端测试、Rust 测试、类型检查和构建脚本。
- 当前 LSP 文档已有进程、配置、root、探测、provider 和端到端现状。
- 当前测试约束要求测试公开 API、归一化、错误、状态转换、持久化、wire contract 和浏览器工作流，不测试私有实现顺序。

## 方案

### 每阶段 review 流程

每阶段都按以下顺序：

1. 对照对应计划文档检查文件和接口是否完整。
2. 检查新增模块是否变深，调用方是否变薄。
3. 检查是否把协议、session 或 WorkspaceEdit 细节泄漏到 UI。
4. 检查错误状态是否可区分，取消是否与失败区分。
5. 扩展现有测试文件，删除过时的实现细节断言。
6. 跑受影响测试、类型检查、Rust 检查和构建。
7. 用真实 server 做至少一条用户工作流。
8. 修正文档中的已做、未做、出处和验收条件。
9. review 通过后才进入下一阶段。

### 阶段检查表

#### 阶段 01：接口与基线

- 类型只有一个公开来源。
- URI、位置编码、版本和状态不变量明确。
- 基线测试验证公开行为。

#### 阶段 02：Manager 与协议

- request、response、notification、server request 均可处理。
- cancel、timeout、progress 和 crash 不会串状态。
- 文档可以重放，旧 session 结果会丢弃。
- 既有基础 provider 无回归。

#### 阶段 03：配置与会话

- 候选链只产生一个活动 server。
- fallback 顺序、root、窗口隔离和资源上限可验证。
- 配置持久化和运行时状态不互相覆盖。

#### 阶段 04：WorkspaceEdit

- 多文件、未保存文件、版本冲突、资源操作和撤销可验证。
- 文件监听和本地历史没有被绕过。
- Rename 与 Code Action 使用同一执行模块。

#### 阶段 05：编辑器能力

- 每项能力均检查 capability。
- 旧版本装饰和异步结果不会复活。
- 所有写文件结果经过 WorkspaceEdit。

#### 阶段 06：Action 与 UI

- 快捷键、命令搜索、编辑器菜单和项目树菜单共用 Action。
- 设置页、状态栏和编辑器使用同一状态派生。
- UI 不直接调用 Tauri LSP command。

### 测试矩阵

协议和生命周期：

- Content-Length 分帧和多字节 UTF-8。
- JSON-RPC response、notification、server request 和错误。
- Windows URI、中文路径、空格路径和盘符大小写。
- UTF-16、UTF-8、UTF-32 position。
- cancellation、timeout、progress、dynamic registration。
- initialize 失败、进程退出、重启、文档重放。

配置和 session：

- mode 归一化和坏配置修复。
- root marker 命中、未命中和 monorepo 子 root。
- 候选 server、fallback、session 上限、空闲回收。
- 两窗口同项目不串 session。

WorkspaceEdit：

- 单文件和多文件 TextEdit。
- 未打开、已打开、dirty 文件。
- 创建、删除、重命名。
- 版本冲突和一次整体撤销。

编辑器工作流（T40 已在真实 WebView 全部走通）：

- 补全、Hover、Signature Help。
- 定义、声明、类型定义、实现和引用。
- Alt+Enter、Rename、Format、Optimize Imports、Find Usages。
- Inlay Hints、Semantic Tokens、CodeLens、Inline Completion。
- Workspace Symbols、Call Hierarchy、Type Hierarchy。

真实 server：

```text
typescript-language-server
rust-analyzer
gopls
pyright
jdtls
```

每个 server 至少验证 initialize、didOpen、诊断、补全、定义、格式化、一个 WorkspaceEdit 和崩溃恢复。

### 命令和结果记录

实施时按仓库实际脚本运行：

```text
npm run check:ts
npm run check:rs
npm run test:front -- <受影响的现有测试>
npm run test:rs -- <相关模块过滤>
npm run build
git diff --check
```

## T17 真实 server 结果

| server | 安装 | initialize | didOpen | diagnostics | completion | definition | formatting | WorkspaceEdit | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rust-analyzer 1.99.0 | 已安装 | 通过 | 通过 | 0 条 | 通过 | 通过 | 通过 | 未返回 | stderr 只有不存在监视路径 warning，协议响应正常 |
| gopls v0.23.0 | 已安装 | 通过 | 通过 | 2 条通知 | 通过 | 通过 | 通过 | rename 返回 | 使用临时 Go 文本，未写盘 |
| typescript-language-server | 未安装 | 跳过 | 跳过 | 跳过 | 跳过 | 跳过 | 跳过 | 跳过 | PATH 未找到 |
| pyright | 未安装 | 跳过 | 跳过 | 跳过 | 跳过 | 跳过 | 跳过 | 跳过 | PATH 未找到 |
| jdtls | 未安装 | 跳过 | 跳过 | 跳过 | 跳过 | 跳过 | 跳过 | 跳过 | PATH 未找到 |

测试过时则更新公开行为断言，并在阶段文档记录原因。不能用删除测试代替修复行为；只有断言已不存在的契约时才删除。

### T18 最终结果

- 前端全量测试 135 个文件、1402 项通过；TypeScript、Rust check、Rust 库测试和生产构建通过。
- Rust 测试为 576 passed、5 ignored；Windows linker 的 manifest warning 属于既有环境告警。
- `rust-analyzer` 和 `gopls` 的标准 LSP 探针通过 initialize、didOpen、completion、definition、formatting、shutdown；gopls 另验证 diagnostics 与 Rename WorkspaceEdit。
- `typescript-language-server`、`pyright`、`jdtls` 未安装，记录为跳过；Forge 浏览器预览因缺少 Tauri bridge，只能验证加载，控制台异常不计为桌面流程通过。
- 稳定行为已并入 `docs/features/lsp-language-servers/README.md` 和后端命令文档，未完成高级能力仍保留在计划区。

### 文档收敛

迁移未完成时，所有方案和未完成项留在本目录。完成后：

1. 将稳定行为合并到 `docs/features/lsp-language-servers/README.md` 或对应 feature 文档。
2. 更新 `docs/backend/commands.md` 的命令契约。
3. 更新设置、编辑器和 shell-layout 的交叉链接。
4. 从本目录移除已经定稿的计划文档。
5. 保留仍未完成的后续能力，并让 `docs/plans/README.md` 的索引与状态一致。

## 已验收与未完成

- 已验收：阶段 01 至 06 均完成 review，并在对应文档留下测试结果和未完成项。
- 已验收：真实 Node LSP fixture 完成 IPC、保存/编辑、WorkspaceEdit、重启、stderr 和退出事件流程；真实 Tauri UI fixture 完成设置页/安装/日志/状态栏流程。不能把本机未安装的 rust-analyzer、gopls 等环境依赖写成五类真实 server 全部通过。
- 已验收：前端、Rust、类型检查、生产构建、diff 检查和禁用名称扫描通过。
- 已验收：UI 验收使用真实 Tauri WebView，不引入 Playwright；Forge 浏览器预览只作为无 bridge 的页面加载检查。
- 完整多级跨文档撤销（T39）和真实编辑器工作流桌面验收（T40）已完成；本阶段无遗留未验收项。
- 最终 review 确认没有修改用户并发改动：`.IDEA/`、`src/features/vcs/`、`src/components/GitPanel.tsx`、`tests/features/vcsChanges.test.ts`。
- 完成能力已并入 features 文档，未完成能力仍在 plans 文档，没有把计划目录误当成稳定文档。

## 出处

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `docs/README.md` | 计划、features、backend 的职责和写作规范 | `:1-90` |
| `docs/plans/README.md` | 计划目录格式、状态和流转规则 | `:1-55` |
| `package.json` | 前端检查、测试和构建脚本 | 文件全文 |
| `src-tauri/src/lsp.rs` | Rust LSP 测试和后端公开 command | `:616-835` |
| `tests/` | 前端公开行为测试 | 受影响测试文件 |
| `docs/features/lsp-language-servers/README.md` | 现有 LSP 验收和约束 | 文件全文 |

