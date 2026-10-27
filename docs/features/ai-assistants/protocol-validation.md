# 本机 CLI 协议适配与验证记录

## 当前边界

Forge 已实现 Rust 直连本机 CLI 的聊天运行层与 React 界面。自动验证使用本地模拟 CLI，不调用真实模型、不读取登录令牌，不执行安装、更新或卸载。

**实现与模拟测试通过不等于真实账号验收完成。** 真实登录、额度、网络错误、供应商实际审批行为、原生历史续聊以及 Windows 桌面端交互仍需在用户指定的测试目录内验收。

## 适配版本

- Codex CLI：`0.163.0`。本机 `--version` 和 `app-server generate-json-schema` 已核对。
- Claude Code CLI：`2.1.308`。本机 `--version`、`--help` 已核对；控制消息参考官方 Python Agent SDK 的实现。
- 运行入口**不校验版本号**：CLI 升到任何版本都照常启动，字段不兼容由协议适配器在本轮按真实帧报错。上面两行记录的是取证时的版本，只用于说明证据来源，不构成运行时门槛；代码里不写任何 CLI 版本常量。
- 新增能力一律先向 CLI 探测再使用，探测不到就降级并标明来源。安装管理仍独立查询并安装官方稳定版本，与能否启动对话无关。
- 版本匹配只表示当前代码使用该版本对应的字段，不能证明已登录、账号可用或第三方订阅使用已获许可。

## Codex

通信顺序：`initialize` → `initialized` → `thread/start` 或 `thread/resume` → `turn/start`。

- stdio JSONL；不开放监听端口。
- `experimentalApi: false`，不默认启用实验能力。
- 默认使用 `sandbox: "workspace-write"`、`approvalPolicy: "on-request"`、`approvalsReviewer: "user"`。输入区可选择项目内自动允许（workspace-write + never）或完全访问（danger-full-access + never）；完全访问需要独立风险确认。
- 按所选模式校验 thread 响应的审批策略、人工审批路由及 `sandbox.type`，不符合则不发送回合消息。请求枚举与响应对象的拼写不同，以本机 schema 为准。
- Fast 从当前版本 `model/list` 的 `serviceTiers` 读取名称为 Fast 的服务等级 ID，不硬编码 fast/priority。发送前后端再次核实模型目录，并通过稳定字段 `turn/start.serviceTierForTurn` 传递；关闭时显式传 `default`，避免恢复会话继续沿用旧速度。目录未提供 Fast 则禁用入口或报错，不假装生效。该等级可能增加额度消耗，真实账号可用性尚未验收。
- 普通命令与文件修改审批只支持 `accept` / `decline`，不保存会话级允许规则。
- 收到额外权限请求时返回空权限；MCP elicitation 返回拒绝；未知服务端请求返回协议错误，不放行。
- 用户提问有独立响应映射，但第一版不主动开启实验能力，因此不能保证每种 Codex 模式都能产生提问卡片。
- `turn/completed` 的实际状态决定完成、中断或失败；发送和恢复均校验原生标识。
- 停止优先发送 `turn/interrupt`，超时清理进程树。

## Claude Code

启动参数：`-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --permission-mode manual`。续聊追加 `--resume` 与已保存的原生 ID。

- 默认权限模式为 `manual`，不再使用旧参数 `default`。输入区另支持 `acceptEdits`（自动允许编辑）与 `bypassPermissions`（完全访问，确认后附加 `--allow-dangerously-skip-permissions`）；这些取值均核对本机 2.1.308 `--help`，真实账号行为待验收。
- 先发送 `control_request` / `initialize`（`hooks: null`），成功后发送结构化 user 消息；提示词不拼入 shell。
- `can_use_tool` 的原始 input 只保留在后端。普通授权的前端响应只有允许或拒绝，允许一次时回传原始 `updatedInput`，不更新全局权限。
- `AskUserQuestion` 独立处理，答案不能作为普通工具授权。
- `control_cancel_request` 和停止会让请求失效，过期请求不能继续批准。
- message ID 关联文本增量和完整消息，完整消息覆盖增量，避免重复显示。
- 成功 result 后先在 stdin 仍打开时发送只读 `get_context_usage(detail: summary)`，最多等待约 2 秒后关闭输入。分类查询不支持、超时或管道提前结束不会把已完成回合改成失败；真实非零退出和原有 5 秒退出期限仍保留。分类字段依据官方 TypeScript SDK 0.3.293，真实 CLI 2.1.308 行为尚待验收，详见 [上下文组成](context-composition.md)。
- 未使用 `--bare`，CLI 仍可能加载已有配置、指令、hooks 和 MCP。项目可信确认不是文件系统沙箱；CLI 既有允许规则可能使操作无需再次询问。

## 公共运行与存储

- 同一会话一个运行任务并带 FIFO 队列，不同会话最多八项并行；会话租约防止多个进程同时写入同一记录。外部 CLI 只有真实 task 活跃时才使同会话队首等待，空闲窗口不算运行。
- 每回合独立进程，原生 ID 持久化用于下一回合恢复，不支持需要长期存活的后台代理任务。
- stdout 单帧上限 16 MiB（正常事件只有几 KB，但工具结果整段回显可能很大）；出站单条上限按「8 张 8 MiB 图片内联 base64」倒推，不能卡得比界面允许发出的请求更小；两侧超限都整轮失败并报出方向与 MiB 数。stderr 只保留 32 KiB 诊断尾部；输入输出队列和事件批次有界。
- 单条落盘事件上限 2 MiB；超过时在落盘前裁剪过长的字符串（保留前段并加截断标记），不再让整轮因记录过大失败，裁剪后的内容同时用于广播，实时视图与重新打开的历史一致；单会话日志上限 256 MiB；一页最多 500 条且原始字节不超 4 MiB（至少留一条，不返回空页）。方向由 `Window::After(seq)` / `Window::Before(seq)` 决定，不带游标时取最新一页，所以打开会话直接落在当前对话上；`has_more`（往后还有）与 `has_older`（往前还有）分开报，游标按方向各走各的。`events.idx` 每 64 条记录序号与字节偏移，并缓存最新序号、未终结任务和最后状态；索引命中时分页从最近锚点 seek，只保留请求页及状态。索引缺失、损坏、版本不符或与日志边界不一致时才全量扫描并重建，日志仍是唯一事实来源。
- 记录保存在应用本地数据目录的 `ai-sessions-v1` 下，包含版本化元数据与 JSONL 事件。另有只读原生历史适配器，只投影当前项目；镜像、追加游标和隐藏标记仍只写 Forge 数据目录，只有用户对某一条会话勾选「同时删除 CLI 原生记录」才动原生文件，详见 [聊天扩展](chat-experience.md)。
- 元数据原子替换；日志持久化后才广播。磁盘错误通过独立错误通道报告，避免未落盘事件占用后续持久化序号。
- 尾部不完整写入仅在取得独占锁后修复；日志中段损坏保留原文件并报错。没有运行锁的旧 running 记录恢复为中断，不重发消息。
- 对话和工具输入输出可能含敏感内容，本地日志未额外加密；删除 Forge 会话会删除这些记录，但不删除 CLI 原生历史和账号配置。
- Codex 通过 `config/read` 读取项目有效模型、强度、权限和服务等级，设置页控件直接选中这些真实值；修改走 `config/batchWrite`。任务入队时再次读取并冻结模型、强度与服务等级，输入区本轮选择的权限随请求原样发送（`inherit` 才不发送覆盖）。Claude 使用官方模型别名/自定义 ID 与 `--model/--effort`。界面区分调用 ID、显示名、别名目标与 CLI 实际报告，未知实际值不推测。

## 模拟样本与测试

`tests/fixtures/ai-runtime-cli.mjs` 是人工编写的确定性协议样本，不是真实账号输出，也不从参考项目复制。临时目录中仅在收到允许一次后写入测试标记文件。

自动测试覆盖：

- 两家协议的初始化、原生 ID、续聊、分块中文/emoji、完整消息去重。
- 普通授权允许/拒绝、请求失效、提问与授权分离、恢复 ID 不匹配。
- 真实操作系统管道、子孙进程清理、超长输出、截断 JSON、异常退出和输出队列清理。
- 会话分页、尾部修复、中段损坏、项目归属、锁释放及中断恢复。
- 前端首事件早到、重复/过晚事件、历史与实时事件交错、IPC 失败不重发、删除后晚事件。

上述进程测试验证的是模拟 CLI 与 Forge 传输/适配模块，不是两家真实 CLI 的执行行为，也不是完整 Tauri 命令与桌面交互端到端验证。

## 斜杠命令增量验证

完整来源、支持名单与参数语义见 [斜杠命令协议](slash-command-protocol.md)。此节记录后续增量，不改变前述真实账号尚未验收的结论。

- Claude 动态命令目录、别名与本地命令输出依据官方 TypeScript Agent SDK 0.3.293 声明和官方命令文档，尚未以真实 CLI 2.1.308 会话验证。每轮 initialize 后重验命令，目录失效时不发送 user 正文。
- Codex `/review <instructions>` 映射到 `review/start` 的 custom target；参数中的空格、引号、制表符、换行、路径及类似 `--base` 的文字按原文保留，不作为 shell 或额外开关解析。无参数时审查未提交改动。
- Codex `/compact` 只接受已有会话且不接受附加参数；确认响应和压缩 item 完成都不会提前结束运行，继续等待 `turn/completed`。Claude `/compact [instructions]` 按其自身协议保留说明参数。
- 合成测试覆盖命令发现/补全、参数提示、输入法保护、本地设置校验与完全访问二次确认、目录完整替换、独立命令输出及未知命令不回退模型消息。
- 最终回归：前端 52 个文件、427 项通过；Rust 293 项通过、4 项既有忽略；独立目录构建及 TypeScript 检查通过。数字为当前完整套件总数，并非本轮新增数。
- 所有本轮协议执行验证使用合成数据与模拟 CLI，未读取真实聊天或凭据、未调用真实模型、未消耗模型额度。真实动态命令、实际压缩/审查、焦点和 Windows 桌面交互仍待人工验收。

## 计划审阅、后台任务与异步提问增量验证

本轮从 ccgui 移植服务端实现、从 codeg 对照界面；以下结论仍只覆盖合成数据与模拟 CLI。服务端机制参考 `desktop-cc-gui`（MIT，版权归其作者 zhukunpenglinyutong，https://github.com/zhukunpenglinyutong/desktop-cc-gui）；Forge 按本项目的存储与协议结构重写，未直接复制其文件。

- Codex 计划模式：`initialize.capabilities.experimentalApi` 只在计划/决策回合为 true；`turn/start.collaborationMode` 的 `settings.model` 必填，拿不到模型就失败关闭。完成的 `plan` item 才是权威正文，流式 `item/plan/delta` 只作预览。
- 计划审阅：版本与 CAS 在会话目录 `plans.json`；批准/要求修改/暂不执行三种决策，`request_changes` 必须带反馈。决策回合先用 `thread/turns/list`（itemsView=full）核对计划 id 与正文指纹，正文变化或条目消失报 `codex plan is stale:` 并过期该版本；回合确认启动后才标记 applied，执行完成/失败另记。启动失败、排队决策被取消或停止都会把提交权退回待审；打开会话只回收超过 10 秒仍停在 submitting 的残留，避免与正在启动的决策抢版本。
- Claude 计划模式：`--permission-mode plan` 叠加只读 `--allowedTools` 与显式 `--disallowedTools`；不产生类型化审阅记录。Claude 没有独立的只读档——`PermissionMode::Read` 同样映射成 `plan`，所以白名单对「计划模式」和「只读」两档一起生效，输入框的 `/permissions read` 在 Claude 上等于打开计划模式，而不是再摆一个同效开关。
- Claude 后台任务：`system/background_tasks_changed` 与 `system/task_notification` 投影为后台任务事件；`result` 到达时仍有任务则不结束进程，任务清零后关闭 stdin，驻留期间的 EOF 按完成收尾。用户新消息仍走同会话 FIFO，不直接写入驻留进程。
- 权限拒绝：Claude 由 `tool_result.is_error` 的拒绝文本与 `result.permission_denials` 结构化清单去重后成为 `permission_denied` 事件；Codex 直接用原生 `status:"declined"` 条目——fileChange 取 `changes` 里第一个绝对路径键，commandExecution 只报命令原文、不给目录按钮（没有可信路径就不做会报错的入口）。确认目录后 Claude 以 `--add-dir` 进入下一轮启动参数；Codex 走 `turn/start.sandboxPolicy`，且必须与 `config/read` 读回的生效 `writable_roots`、`network_access` 合并后再发：这份策略是整份替换而不是追加，只发自己那几条会顶掉用户项目里已配的设置。完全访问本就覆盖这些目录，只读沙箱收不下它们——后者当场说明原因，绝不静默丢掉用户点过的授权。
- MCP：Claude 从 `system/init.mcp_servers` 读已加载服务与工具名；Codex 在回合起来后用 `mcpServerStatus/list`（`detail:"toolsAndAuthOnly"`）问一次全表，并接 `mcpServer/startupStatus/updated` 改写其中一台后整表重发——只发那一台会把多行表压成一行。探测排在 `turn/start` 之后：一台卡住的 MCP 服务不该挡在用户消息门口。探测失败或报空时整块不出现，不摆一张「都查过了」的空表。两家都只做只读展示，Forge 不向会话注入任意 MCP 命令。
- Codex 权限扩大申请：`item/permissions/requestApproval` 进审批卡，卡片正文写清「申请授予什么」（`entries` 与新读的 `access` 与路径、`network.enabled`），批准就是把 CLI 申请的那份原样发回（`{"permissions": <申请的权限集>}`，作用域按协议默认 `turn`），拒绝才是空授予集。这条请求不给工具名，因此界面不会出现「本轮不再询问」：让 Forge 代答下一次同类申请，等于替 CLI 记住越权；答复里出现 `input` 或 `remember` 一律整条拒收。
- Codex 异步提问：AgentMessage 上的 `questions` 进入提问卡，回答生成 `turn/steer`（携带 call id 与按题目标题的答案），其回包不参与握手状态机。
- Codex 推理展示：完成条目里 `summary[]` 与 `content[]` 只发一份——有摘要用摘要，摘要为空才退回原始轨迹。两条流式通知 `item/reasoning/summaryTextDelta`（`summaryIndex`）与 `item/reasoning/textDelta`（`contentIndex`）是**两个独立索引空间**，前端按 `itemId-index` 分卡，所以两者绝不同时对接：并到同一个 id 会把两段不同文字串进同一张思考卡。`encrypted_content` 一律不解析、不声称展示供应商隐藏推理。CLI 侧自己跑掉的回合只能从原生日志恢复，那里的推理条目只有摘要，因此这类回合永远显示摘要。
- 自动测试覆盖上述状态机、过期、去重、事件投影与模拟管道；真实账号的计划条目字段、后台任务行为、权限拒绝文案和 `turn/steer` 语义仍待人工验收。

## 人工验收步骤（尚未执行）

1. 用户自行在官方 CLI 登录，并指定可修改的临时测试项目；先确认供应商条款适用。
2. 在 Forge 开启功能，分别发送一条文本消息，检查首条流式消息、中文与 emoji。
3. 请求一个需要审批的临时文件操作，分别拒绝和允许，核对磁盘与工具记录。
4. 输出期间切换标签、选择后台继续；再停止，检查对应进程和后代均结束。
5. 重启 Forge，核对历史恢复；使用同一原生 ID 继续对话。
6. 验证未保存文档拦截、实际文件刷新、删除运行会话、关闭项目和总开关。
7. 验证账号失效、断网、额度错误与 CLI 版本改变；确认没有自动重发或隐式新建会话。

官方依据：

- https://developers.openai.com/codex/app-server
- https://code.claude.com/docs/en/headless
- https://raw.githubusercontent.com/anthropics/claude-agent-sdk-python/main/src/claude_agent_sdk/_internal/query.py
- https://code.claude.com/docs/en/agent-sdk/overview
