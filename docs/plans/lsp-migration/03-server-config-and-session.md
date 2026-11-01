# Server 配置与会话

**状态**：已完成
**涉及模块**：lsp-language-servers、settings；`src/lib/lspConfig.ts`、`src-tauri/src/lsp_config.rs`、`src-tauri/src/lsp_probe.rs`、`src-tauri/src/lsp_detect.rs`
**阻塞点**：核心配置、项目覆盖、候选链、fallback 和 session 生命周期已落地；fallback 失败详情的统一 UI 状态仍可独立增强。

## 背景

配置必须表达用户意图、实际可用性和当前会话三件不同的事。`mode` 表达是否启用，探测报告表达能否启动，session 状态表达当前是否运行，三者不能互相覆盖。

## 已做

- `lsp.json` 已从 `settings.json` 拆出，默认配置由 Rust seed 提供。
- `off`、`builtin`、`lsp` 已收敛成单一 mode；前端配置类型仍未暴露 Rust 已支持的资源约束字段。
- server 已有 command、args、env、root markers、安装命令、初始化选项和启动超时。
- PATH 增强、Windows `.cmd`/`.ps1` 探测、安装命令和 root marker 解析已经存在。
- session id 已包含窗口、server 和规范化 root，避免窗口间消息串线；同键启动合并、失败退避、手动 Retry、空闲回收和总数淘汰已有实现。
- 当前语言选择已支持项目 `.forge/lsp.json` 的候选顺序，并在启动/初始化失败后按顺序 fallback；runtime 版本检查和 TCP server 连接配置仍未实现。
- 项目级读取器已实现为工作区根下 `.forge/lsp.json` 的运行时覆盖；不读取其他编辑器配置。

## 方案

### 配置层级

保留三层：

1. 用户级 `lsp.json`：默认 server、可执行路径、安装命令和全局资源上限。
2. 项目级语言服务配置：项目 root、server 候选、参数覆盖和 workspace settings。
3. 运行时状态：探测结果、失败退避、当前 session 和 capabilities，不写入用户配置。

项目配置格式已固定为项目根下 `.forge/lsp.json`；不能把任意其他编辑器配置静默当成 Forge 配置。项目配置只覆盖已有 server 字段和候选顺序，不覆盖后端从用户配置读取的全局 session 资源限制。

### Server 候选和 fallback

一个语言文档只选择一个活动 server。配置可以列出有序候选：

```text
语言文档
  → 项目级候选
  → 用户级候选
  → seed 默认候选
  → 探测可用性
  → 按 priority 选择一个
  → 启动失败时按顺序 fallback
```

fallback 只在启动失败、初始化失败或能力不满足时使用。已成功运行的主 server 不与 fallback 并行，也不合并 diagnostics、completion 或 semantic tokens，避免一份文档出现重复语义。

格式化、Rename、Code Action 等会写文件的能力只能交给当前活动 server，不能把同一编辑请求发给多个候选。

### Root 和 session

- 按 `(window, server, normalizedRoot)` 建立 session。
- 同一窗口、同一 server、同一 root 的并发启动合并为一个 ensure。
- monorepo 中按文件选择最深的已解析 root。
- root 无法解析时，不自动把整个工作区当成项目；状态显示 root missing。
- 配置变化、项目切换和窗口关闭都触发 session reconcile。

### 资源和失败策略

- `maxSessions` 默认 5。
- `idleTimeoutMin` 默认 30。
- 启动失败使用现有指数退避，上限 300 秒，连续失败超过 2 次停止自动重试。
- 手动 Retry 清理该 session 的失败记录并立即重试。
- 回收先发送 `shutdown`，等待 3 秒，再执行进程树终止。
- 不因探测失败自动把用户配置从 `lsp` 改成 `builtin`；用户选择仍然保留。

### 配置和运行时约束

迁移 IDEA 配置能力：

- command、args、env。
- root markers。
- initialization options。
- workspace settings。
- install hint。
- TCP server 连接方式。
- runtime 版本限制。
- Java 等启动前检查。

Windows 的 `.cmd`、PATH 增强、Node 调试注入清理和 `taskkill /T` 行为继续使用 Forge 现有实现。

## 未做与验收

- 同一语言配置两个候选时，启动只产生一个活动 session，主候选失败后按顺序尝试 fallback：已实现并由前端测试覆盖。
- fallback 的原始失败详情留在候选 skip 状态和日志路径；状态条当前展示最终活动 session，候选链每一步的失败明细仍不是独立 UI 列表。
- 项目切换不会复用旧 root 的 session。
- 配置保存后只影响新一轮 reconcile，不会在写盘中途破坏正在运行的 session。
- 未安装、root missing、启动中、ready、crashed、disabled 和 misconfigured 的公开状态在 Manager 与设置/状态栏入口使用同一套 capability 和 session 来源；候选链逐项失败明细仍按日志排查。
- 项目配置只读取 `.forge/lsp.json`，不隐式读取其他编辑器配置：已实现。
- 阶段结束后执行 review 文档的“阶段 03”清单。

## T16 真实环境矩阵

只读探测结果：Windows 当前可用 `rust-analyzer 1.99.0 (b940084d 2026-09-28)`、`gopls v0.23.0`；`typescript-language-server`、`pyright`、`jdtls` 不在 PATH。T17 只对前两项做真实协议验收，不为缺失依赖临时安装。

## 出处

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `src/lib/lspConfig.ts` | 配置类型、mode、语言选择和读写 | `:1-85` |
| `src-tauri/src/lsp_config.rs` | 配置 seed、normalize、迁移、保存和 probe report | `:42-84`、`:373-578` |
| `src-tauri/src/lsp.rs` | session identity、启动合并、退避、回收和状态 | `:50-100`、`:222-341`、`:698-835` |
| `src-tauri/src/lsp_probe.rs` | PATH、探测、安装和输出上限 | `:55-323` |
| `src-tauri/src/lsp_detect.rs` | root marker 解析和缓存 | 文件全文 |
| `docs/features/lsp-language-servers/README.md` | 当前配置、root、探测和资源约束 | `:25-180` |
| 外部 IDEA 对标资料 `crates/ide-language/src/lib.rs` | IDEA command、root、settings、fallback 和 runtime 配置 | `:21-101` |

