# 上下文组成：协议依据与实现边界

核对日期：2026-10-22。目标是系统提示词、工具定义、会话消息、文件等在上下文窗口内的 token 组成，而不是输入输出消费或费用报告。

## 一手依据

1. 本机官方 `@anthropic-ai/claude-agent-sdk` **0.3.293** 的 `sdk.d.ts`：
   - `SDKControlGetContextUsageRequest`（3956 行附近）：请求 subtype 为 `get_context_usage`，`detail` 为 `summary` 或 `full`。
   - 注释明确：`full` 为默认值，会逐分类调用 token-count API；`summary` 使用最近响应 usage 与本地估算，不做逐分类 token-count 调用。因此 Forge 显式传 `summary`，不依赖默认值。
   - `SDKControlGetContextUsageResponse`（3967 行附近）：返回 `categories`、`totalTokens`、`rawMaxTokens`、`model`，以及可选/可为空的系统提示分段、系统工具、MCP 工具、记忆文件、agents、skills、messageBreakdown 等明细。
   - 分类依据是 `kind: used | free | buffer | deferred`，不能根据英文 `name` 判定。`deferred` 是窗口外工具 schema，不能计入已用占比；free 和 buffer 也不是已用内容。
   - `SDKContextUsage`（3797 行附近）的 `raw_max_tokens` 明确定义为 resolved autocompact window，可能是模型上限，也可能是更小的压缩策略窗口。Forge 保守标注为压缩窗口，不把控制响应的 `rawMaxTokens` 宣称为模型绝对硬上限。
   - 本机来源：`C:/nvm4w/nodejs/node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`。官方入口：[TypeScript SDK 文档](https://platform.claude.com/docs/en/agent-sdk/typescript)、[官方 SDK 包](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)。
2. 本机 **Codex 0.163.0** 生成的稳定 app-server schema：
   - `ClientRequest.json` 方法集合没有上下文分类查询方法。
   - `v2/ThreadTokenUsageUpdatedNotification.json` 提供 last/total/modelContextWindow 等总量，没有系统提示、MCP、消息组成字段。
   - 因此本实现仅说明该版本稳定接口的限制，不声称所有 Codex 版本都不支持，也不从日志字符长度推算虚假分类。
   - 本机核对产物位于临时目录 `forge-ai-protocol-schema`。官方入口：[app-server](https://developers.openai.com/codex/app-server)。

SDK 类型核对不等同于真实 Claude Code **2.1.308** 的运行验收。当前 CLI 为打包二进制，本次没有运行真实会话探测该请求；对不支持、超时或不兼容返回提供明确降级，而不是宣称真实账号数据已验证。

## 数据通路

- Claude 成功 `result` 后、关闭 stdin 前发送只读 `get_context_usage(detail: summary)`，不发送新的 user 消息，也不以 `/context` 提示词触发额外回合。
- 分类诊断最多等待约 2 秒，随后关闭输入；原有 result 后 5 秒退出期限、非零退出校验和取消守卫仍保留。
- 不支持、管道提前关闭、诊断写失败和超时只令分类不可用，不将其作为模型回合失败；真实进程非零退出仍失败。
- 适配器输出独立 `context` / `context_unavailable` 事件，正常持久化和回放。只保留所需上下文字段，不转发 `apiUsage`、费用或任意顶层返回字段。
- 前端 `aiContext.ts` 与 `aiUsage.ts` 分离。分类、总数、窗口校验非负有限数；缺少关键数据或未知 kind 不伪装成零。
- UI 展示分类 token 数、窗口占比；实际返回的分项可展开。MCP 定义与会话内工具调用/返回内容分开；明细属于已有分类，不能再次相加。未加载工具不计算占用比例。
- 新回合、压缩和实际模型改变会令旧快照过期；选择器改变请求模型也令显示过期。记录请求模型别名，避免 `sonnet` 与解析后的模型 ID 不同而误判。过期快照保留时间与模型供回看，常驻概览不继续使用其比例。
- Claude 概览取分类快照；Codex 可继续显示稳定接口提供的总量，但浮层明确说明无分类接口。浮层不显示输入、输出、缓存、推理用量和费用。

## 压缩提示与窗口记忆

压缩本身仍由 CLI 执行，Forge 只负责挑时机和发指令（Claude 走原生 `/compact`，Codex 走 `codexCompact`，都不带参数）。

- `aiContextMemory.ts` 按 (引擎, 模型) 记住 CLI **亲口报告过**的窗口：只收正安全整数，模型写法原样保存（大小写变体各算一条，不猜它们是同一个），第二次报告覆盖第一次（包括变小的），最多留 24 条，坏数据逐条丢弃。窗口属于模型，删会话不清它。
- 记录点在输入区概览：本轮分类快照未过期时按快照的模型与时间记，否则按用量报到的 `window` 记。没报告过就没有这一条——Forge 不从模型名猜档位，也不用内置目录的常见值兜底。
- `aiCompact.ts` 判定分子与分母：过期快照不算本轮占用；分母优先本轮报告，取不到时可用该模型上次报告的窗口，但来源要一路说清。凑不出一对可信数字就什么都不提（`ai.compact.blockNoNumbers`），而不是显示一个猜的百分比。
- 硬阻断（连提示都不出）：会话没绑上原生对话、正在停止、本轮仍在运行、还有请求等用户回答、还有排队消息没发出去。运行中交给 CLI 按自己的节奏压缩。
- 默认只提示，用户点头才压。自动那档要用户自己打开，且永远不早于 90%（`AUTO_COMPACT_MIN_PERCENT`），即使提示阈值调得更低。
- 待输入保护：分母来自记忆、或输入框里还有没发出去的内容时，自动压缩停手，提示照旧——压缩会改写之后的历史，不能在用户不知情时换掉上下文。
- 「这次不用」按 (引擎, 窗口, 5% 一档) 静音，跨过下一档或换了模型才重新提；数字仍在概览里显示。

## 验证

所有样本均为合成数据，没有读取真实聊天正文、凭据，没有调用真实模型或 token-count API。

- Rust 适配测试：summary 请求、响应白名单、重复/迟到响应、不支持、超时、停止。
- 模拟 CLI 的真实操作系统管道测试：result 后保持 stdin，采集分类；不支持、超时、提前 EOF 保持已成功回合状态。这不是完整 Tauri 桌面端到端测试。
- 前端：分类归一化、kind 语义、deferred 排除、占比与超限、缺失字段、回放/增量一致、过期状态、模型别名、分类界面和消费统计移除；窗口记忆的取值边界与覆盖、压缩判定的阻断顺序、阈值与自动下限、待输入保护、按档静音，以及提示条渲染。
- 本轮自动验证结果：前端 75 文件 681 测试通过；Rust 357 通过、4 忽略。数字是当前完整套件总数，并非本轮新增数。

真实 CLI 是否在此生命周期阶段返回完整分项、估算与终端 `/context` 是否一致，仍需用户在允许的真实会话中验收。这里只报告已经完成的协议接线与模拟验证。
