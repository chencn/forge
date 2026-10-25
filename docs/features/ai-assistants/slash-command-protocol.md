# 斜杠命令与参数：协议依据、实现范围与验证边界

## 结论与版本范围

Forge 将斜杠输入分为本地设置操作、Claude 会话命令、Codex 专用协议操作。它们不是同一种调用：不能把所有终端命令原样发给模型，也不能猜测命令参数对应的 RPC 字段。

协议取证时的版本是 Codex **0.163.0**、Claude Code **2.1.308**，它们只说明证据来源，不是运行时门槛（Forge 不按版本号拦截启动）。Codex 字段依据本机生成的 0.163.0 JSON schema，并对照官方固定 tag 的测试。Claude 的结构依据本机官方 Agent SDK **0.3.293** 类型声明及官方在线文档；SDK 版本与 CLI 版本不同，类型声明不是对 CLI 2.1.308 的真实会话实测。目录或字段缺失时保守拒绝派发，不假装已验证全部内置命令。

## 主来源

1. [Claude Agent SDK 命令文档](https://platform.claude.com/docs/en/agent-sdk/slash-commands)（当前重定向到 skills 文档的 “Commands in Agent SDK sessions”）：发现、通过 prompt 派发、未知命令回退行为、compact 与 clear 的语义。
2. 本机官方 `@anthropic-ai/claude-agent-sdk@0.3.293` 的 `sdk.d.ts`，位于 `C:/nvm4w/nodejs/node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk/`：`SlashCommand`、`SDKControlInitializeResponse`、`SDKCommandsChangedMessage`、`SDKLocalCommandOutputMessage`、`SDKMessageOrigin`、`SDKUserMessage` 及 init 的 `terminal_slash_commands`。只读取安装包声明，不读取账号或聊天文件。
3. Codex 0.163.0 本机生成的 `v2/ThreadCompactStartParams.json`、`ThreadCompactStartResponse.json`、`ReviewStartParams.json`、`ReviewStartResponse.json`，生成目录 `C:/Users/shengganbao/AppData/Local/Temp/forge-ai-protocol-schema/`。生成方法与版本校验见 [协议验证记录](protocol-validation.md)。
4. [Codex rust-v0.163.0 官方 compaction 测试](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/tests/suite/v2/compaction.rs)，尤其 `thread_compact_start_triggers_compaction_and_returns_empty_response`：空响应后等待压缩 item 和对应 `turn/completed`；从 item 的 `turn_id` 关联回合。
5. [Claude Code 命令参考](https://code.claude.com/docs/en/commands)：明确 `/compact [instructions]`，命令名称后的文本为参数；完整参考包含许多仅终端可用或依赖状态的命令，不能全部照搬。

在线文档会更新；本次只将已核实部分映射到固定版本的实现，不据此声称覆盖未来版本。

## 支持的命令和参数

### Forge 本地命令

- `/help`：列出当前支持的命令，不接受参数。
- `/model [model-id | default]`：无参数打开模型选择器；带参数选择模型或恢复默认。模型 ID 不做 shell 去引号；支持目录外 ID 与否由能力目录的 `customModel` 决定。切换模型清除不兼容的强度和 Fast。
- `/effort [level | default]`：无参数打开强度选择器；带参数按所选模型能力校验，不猜测档位。
- `/permissions [read | ask | auto | full]`：无参数打开权限选择器；`permission`、`approvals` 为本地别名，`read` 仅 Codex 提供。`full` 仍需独立风险确认，不因输入命令就直接提权。选择按会话与全局默认持久化，重启后沿用。
- `/fast [on | off]`：仅 Codex；无参数切换，开启必须有模型目录明确声明的 Fast 等级。使用目录实际 ID，不硬编码其服务等级值。
- `/context`：仅 Claude 可打开上下文明细，Codex 没有对应入口。`/settings` 打开设置浮层；两者都不接受参数。

这些是 Forge 设置入口，不把它们作为供应商命令发送。模型能力加载可以启动 Codex 的只读 app-server 握手与 `model/list`，但不创建模型回合；Claude 能力仍使用既有别名列表，不为本地设置额外启动 Claude 会话。

### Claude 会话命令

- 初始化控制响应的 `commands` 提供名称、说明、`argumentHint`、别名和可选 `builtin`。`builtin: true` 表示内置命令，用户、项目、插件和 MCP 命令的该字段可以缺省。[来源 2]
- 同名时内置项优先；真实名称优先于另一个命令的别名。`system/commands_changed` 是完整替换，不追加合并。[来源 2]
- 当前开放目录报告的自定义命令、skills、MCP 命令；内置命令仅适配 `compact`、`usage`。其别名如 `cost` 以目录实际返回为准。Forge 本地命令名称优先保留。
- `terminal_slash_commands` 标记的终端专用命令不显示、不允许选择。其它内置状态操作及终端交互命令也不开放；尤其 `/clear` 会改变上下文/会话，当前每轮独立进程且严格绑定原会话 ID，不将它冒充为同会话清空。[来源 1、2]
- 正常会话初始化后获取动态目录；首次打开页面不为了列菜单额外启动 Claude，避免 hooks 和 MCP 初始化副作用。没有结构化目录时仍能用 Forge 本地命令，原生命令暂不发送。
- 每次执行在新进程 initialize 响应后再次核验名称，再写入 user 消息。官方明确 **2.1.274 起未知 slash 会退回普通模型消息并消耗一个回合**，因此不能只相信上轮缓存。[来源 1]
- 真人输入带 `origin: {kind: "human"}`。仅把命令元数据传给前端，不转发 initialize 的 account 数据。[来源 2]
- 原生命令整段文本通过 JSON stdin 写入，包括参数引号、Unicode、换行和尾部空格；不作为 shell 命令拼接，不在 Forge 内自行解释 skills 的参数替换规则。
- `/compact` 可以携带 CLI 自己解释的说明参数；`argumentHint` 展示实际元数据。成功 result 仅表示命令结束，只有 `compact_boundary` 才能证明发生了压缩，历史不足可以成功返回但没有压缩。[来源 1、5]
- `system/local_command_output.content` 独立显示为“命令输出”，使用与助手回复相同的安全 Markdown；后续 result 不重复添加同一输出。[来源 2]

限制：terminal 列表可能晚于 initialize 响应在 `system/init` 中出现，实际命令派发前无法保证已收到该列表；因此内置名单保持保守。动态目录核验不能消除 CLI 内部在检查与派发之间再次改变命令的竞态。目标 CLI 的目录、别名及本地输出行为仍需用户授权的真实环境验收。

### Codex 专用操作

- `/compact`：仅已有原生会话；调用 `thread/compact/start`，参数只有 `threadId`。**拒绝附加说明**，不能将 Claude 的 compact 参数语义移植过来。[来源 3]
- 空响应只是接收确认；压缩 item 完成也不是整个回合结束。通过 `turn/started` 或 contextCompaction 的 `item/started.turnId` 关联回合，等待 `turn/completed`。[来源 4]
- `/review`：调用 `review/start`，`delivery: "inline"`，target 为 `uncommittedChanges`。
- `/review <instructions>`：target 为 `custom`，剩余参数作为一个完整 `instructions` 字符串。只去掉名称与参数之间的第一个分隔空白，其余空白、引号、换行保留。不把 `--base`、`--commit` 等文字猜成命令行开关。
- 协议另有 `baseBranch` 和 `commit` 目标，但当前没有为它们定义 slash 参数语法。返回的 `reviewThreadId` 必须是原 thread；`exitedReviewMode.review` 展示审查结果。[来源 3]
- compact/review 不支持 `turn/start` 的 `serviceTierForTurn` 与本轮 `effort` 参数；不会发送这些字段，也不宣称当前 Fast/强度选择已应用。thread 建立或恢复仍按原流程设置模型与审批策略。
- 这些是 Forge 到稳定 app-server 方法的映射，不是从 Codex 终端获得的完整斜杠目录。未适配命令直接报错，不退回普通 prompt。

原生命令（尤其 skills、review、compact）可能调用模型并产生费用；“斜杠命令”不等于“免费本地操作”。

## 交互与失败处理

- 输入 `/` 展示命令名称、说明与参数提示；上下键选择，Tab/Enter 补全，Ctrl/Cmd+Enter 执行，Shift+Enter 保留换行，Esc 或点击外部收起。
- 补全仅替换首个命令名称，不破坏已有参数；输入空白进入参数区后仍显示该命令的用法提示。
- IME `isComposing` 或 keyCode 229 时不补全、不发送，避免中文输入确认误触。
- 单斜杠开头按命令处理；正文中间的斜杠不处理。`//` 作为原样普通文本发送，不承诺会去掉一个斜杠形成转义。
- 本地命令可以在历史未加载完时执行，按钮与键盘规则一致；原生命令仍要求历史完整、项目可信及未保存文件检查。运行中禁用发送；信任确认期间锁定输入和运行设置。
- 参数或名称在前端校验失败时保留草稿。后端已接受运行后才发现目录过期的失败会记入该轮，不自动重发；此时前端草稿可能已清空，可从该轮用户输入取回，不能声称所有异步失败都保留草稿。
- 无参数命令的目标控件正在加载或不可用时明确报错，不清草稿并假装成功。
- 停止发生在初始化期间时，迟到的握手响应不能再创建 thread 或发送新 user/turn。已有任务继续沿用停止和子进程树清理逻辑。

## 自动验证与人工验收

自动测试完全使用合成数据与本地 Node 模拟协议进程，不调用官方 CLI 会话、不读取真实聊天/凭据、不消耗模型额度：

- 解析与目录：参数保真、名称与别名优先级、内置/终端筛选、空目录完整替换。
- 前端事件：目录回放和增量一致、迟到目录不覆盖当前运行、命令输出替换去重、显式 IPC intent 与全文参数。
- 组件处理器：Tab 补全、参数提示、IME、未知命令及错误 compact 参数拦截、草稿保留、本地 help 不受历史分页阻塞、安全 Markdown 配置。
- 本地设置执行：模型与强度能力校验、Fast 能力、完全访问二次确认、无参数选择器不可用错误。
- Rust 适配器及真实操作系统管道：Claude 命令重验/真人来源/输出/目录替换；未知命令不写 user；Codex compact/review 发送专用 RPC 而非 turn/start；多字节分帧；ack/item 后继续等待回合完成。

以上不等同于浏览器焦点、窄栏滚动或真实 Windows 桌面验收。后续人工验收需要重新编译并由用户自行启动 Tauri，在允许产生费用的专用会话中分别检查动态 skills 参数、usage、compact 历史不足与正常压缩、review 输出和停止。当前没有代用户重启或关闭程序。
