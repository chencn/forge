# Browser Use 实施与验收

**状态**：Windows 核心已实施并完成三轮审查；当前实测结果和未完成项见 [实施记录](./implementation.md)，下文仍作为完整目标的验收标准。
**涉及模块**：browser、ai-assistants、settings、shell-layout、run、发布打包。
**阻塞点**：原生内嵌和两家运行时 MCP 加载已实测；真实模型任务、历史续聊与子代理身份继承尚未验收，P2/P3 仍有未实现能力。

<!-- 验收覆盖公开行为、权限与协议，不通过搜索源码或匹配实现顺序冒充测试。 -->

## 背景

最容易失败的地方是原生页面生命周期、实际输入、会话授权和代理恢复。先验证这四条，再扩展工具数量。

方案主文档见 [README](./README.md)，两家启动细节见 [代理接入](./agent-integration.md)。本文件中的 P0/P1/P2/P3 表示交付顺序，不是已完成状态。

## 已做

已完成 Forge、snow-app、codeg 调查、本机 CLI 契约核对及 Windows 核心实现，完成三轮代码与方案审查。27 组真实 WebView2 / CLI 回归已通过，另以真实窗口 UI Automation 验证右侧栏、表单、查找、权限、元素标记和草稿追加；未运行真实模型端到端任务与历史会话续聊，完整验证结果见 [实施记录](./implementation.md)。

## 方案

### 元素问题标记（已实施）

- 工具栏有明确的“选取元素”入口；悬停高亮，点击选中并保持边框，不触发目标元素原有点击行为。
- 标记卡显示元素定位与文字，填写问题后可添加到当前或最近活动对话；没有可用会话时打开新对话草稿。只追加输入，保留原草稿，由用户点击聊天发送按钮。
- 输入投递同时隔离工作区和会话，快速卸载后的旧回放不覆盖新输入。长上下文转为临时附件时，新建会话继承所需目录授权。
- Esc、取消、清除、切页、导航、关闭侧栏和关闭浏览器能力后不留下旧选取模式；异步读取中的旧结果不能复活。
- 只读取选中元素的有限元数据，不读表单值、可编辑子树、隐藏文字或整页 HTML；iframe 内部选取暂不支持。
- 验证复用现有 `smoke.rs`、`aiInputBridge.test.ts`、`aiOptions.test.ts`，真实桌面交互使用 Windows UI Automation 和原生鼠标/键盘输入。

### P0：先证明架构可用

交付范围只做最小链路，验证代码和运行产物进入用户 TEMP/应用缓存，不把临时探针文件写入项目源码。

| 验证 | 通过条件 | 失败后的处理 |
| --- | --- | --- |
| 原生内嵌 | 创建、缩放、隐藏、销毁 child；`main` 仍可被原有 API 获取，托盘与窗口按钮正常 | 调整原生 child 实现；未通过前不写完整 UI |
| 主窗口与网页隔离 | 网页不能 invoke Forge 命令、不能访问工作台 profile/asset/宿主对象 | 修复视图创建与能力匹配，不能放宽 remote 权限 |
| CDP/输入 | 在真实 WebView2 页面获取 AX、截图，完成 trusted click、键盘和文本，事件与默认行为正确 | 逐项标记不支持，禁止假装合成事件等价 |
| Codex MCP | 无模型管理请求下确认候选配置解析、companion 启动、tools/list、new/resume 均有工具 | 修正实际注入方式，不根据自由 config schema 猜字段 |
| Claude MCP | 先独立验证 companion 协议；再用实际 `system/init` 确认服务、工具与 resume 挂载。独立无模型查询通道未核实时由首个真实回合验证 | 检查参数、临时配置与版本能力，不能以 companion 测试替代 CLI 加载 |
| Claude 续聊提示 | snapshot off 生效；已有会话确实获得稳定路由，不只看 argv | 使用明确降级说明，不能宣称注入成功 |
| 最小闭环 | 两家各一次自然语言任务，打开本地测试页、观察、填写、核对结果 | 定位加载/选择/执行/观察哪一层失败 |

P0 完成后记录实际 CLI、WebView2、Tauri/wry 版本、支持命令与剩余能力限制。OpenAI 官方访问恢复时补核实，但不让网页 403 代替本机协议验证。

### P1：可日常使用的核心闭环

实现：BrowserHost、受限 broker、companion 打包、按会话 profile 和权限、标签 UI、两家默认接入、AX/ref、可信基础操作、截图、console、基础失败请求、停止/接管、项目预览。

公开工具先开放 status/tabs/navigate/snapshot/screenshot/act/wait/console/network 的可用子集；其余工具按实际实现发布，未实现能力不进 tools/list。

必须可以完成：

1. 在 Forge 打开项目，开启 AI，新建 Codex 会话。
2. 用户要求“运行项目并检查登录表单”，Codex 默认使用 Forge browser，创建自己的标签。
3. 操作页面、读取失败请求/console，修改代码并等待热更新。
4. 重新快照定位并验证 UI 行为，返回截图/文本证据。
5. Claude 在独立会话完成同样流程，两个会话不串 profile、标签或日志。
6. 两家原生会话关闭后续聊，浏览器工具仍加载；用户接管和撤销立即生效。

### P2：复杂页面与完整工作流

补齐复杂表单、滚动容器、组合键、富文本、drag、iframe/OOPIF、shadow DOM、upload/download、dialog、network body/mock、设备/网络仿真、持久 profile、整页与元素截图、元素发送到聊天。

macOS/Linux 基础载体在此阶段按平台落实与标注；如果产品要求相同 Chromium 全能力，按主方案引入受管 Chromium 实现，不能用平台脚本模拟后声称完全等价。

P2 完成不要求 heap/trace，但必须能处理常见前端开发、登录后页面和文件交换任务。

### P3：深度诊断与过程记录

在既有授权体系中增加 trace、性能分析、heap snapshot/比较、可访问性审计、录制、受限 storage 诊断；全部长任务使用 jobId，支持取消、预算和产物管理。

页面自定义工具只有在核实具体规范、发现机制和权限后单独实现；不得把 `window.xxx` 自定义注册表称为标准 WebMCP。

## 未做与验收

### 1. 有意义的自动化覆盖

优先扩展已有测试文件。当前 `ai_runtime/codex.rs`、`mod.rs`、`claude.rs` 与集成 fixture 适合扩展协议与生命周期用例；新增 browser 模块无已有归属时，才为其公开授权、操作回执及 broker 契约建立测试文件，并在实现说明中说明原因。

| 契约 | 必须覆盖的行为 |
| --- | --- |
| 默认值与归一化 | 旧设置缺 browser 字段补默认；总开关关闭时有效能力为零；非法枚举与上限拒绝 |
| 身份与范围 | A 工程/会话 token 对 B 标签的 list/snapshot/console/act 均不可访问；不能伪造 context |
| frame 与渲染像素 | 主页面共享、跨站 frame 未共享时，AX/DOM/日志过滤；截图只有明确 rendered-pixels 许可才可包含内嵌内容，否则遮罩或拒绝；frame 导航/撤销竞态不返回旧结果 |
| 撤销 | token 过期、停止、总/子开关关闭、origin 改变、控制权移交后旧请求不能执行 |
| 执行竞态 | 定位后撤销、导航、用户接管时，派发前复查；已部分派发不二次执行 |
| ref | 同文档有效，刷新/frame 更换/SPA A→B→A 失效，虚拟节点复用返回目标变化 |
| URL | IDN、默认端口、localhost、IPv6、通配域标签边界、危险 scheme、重定向及受限目标 |
| 文件 | canonical path 越界、junction/symlink、上传范围、下载路径穿越和同名不覆盖 |
| 结果 | structuredContent 与错误码、派发/观察区分、truncated、日志游标丢失、图像 content |
| 幂等 | 同实例 requestId 重复返回已知结果；宿主重启不重放，明确执行未知 |
| MCP | initialize、tools/list、tools/call、取消、非法参数、unknown method、版本不匹配、stdout 无诊断污染 |
| CLI 接入 | new/resume/reconnect 使用实际运行配置；非浏览器 MCP 保留；同名冲突明确失败 |
| 生命周期 | 启动失败回收 token；后台任务继续与用户停止有区别；多标签独立；关闭不误杀其他会话 |

解析 JSON/MCP 内容后断言公共字段和状态；不按原始 JSON 字符串片段或内部 argv 拼接顺序写脆弱测试。

不为文档、CSS、静态 UI 排版、文案、字段注释或文件拆分新增测试；对应改动用现有类型检查、构建和手工验证。

### 2. 真实浏览器验收

优先使用可用的浏览器/Chrome 插件观察 Forge 场景，执行层用 Forge 自己的 browser use。不得引入 Playwright 作为本项目默认执行或验收依赖。

工具环境未提供浏览器插件时，以真实 Forge/WebView2 手工运行与公开 browser 协议驱动验收；不能用普通 Chromium 页面通过代替原生 WebView2 通过。

| 场景 | 预期 |
| --- | --- |
| React 受控输入、中文、emoji、富文本、Enter 默认动作 | 值、事件、焦点及页面结果正确，实际 trusted/synthetic 如实报告 |
| 持续轮询/WebSocket 页面 | wait 由指定条件结束，不无限等 network idle |
| 导航、回退、SPA、刷新、iframe 移除 | 旧 ref/frame 拒绝，重新观察后可操作 |
| 页面点击开始下载/打开 JS dialog/新窗口 | 回执关联实际事件，未授权新页内容不泄漏 |
| HTTPS 登录、OAuth、验证码 | 人工可接管，恢复后权限明确，profile 不串会话 |
| 用户切标签、后台、最小化 | 不误点活动页；不能采集时返回明确原因 |
| 原生菜单、审批弹框、拖分隔线 | 浏览器不盖弹框、不吞输入，取消/关闭后恢复正确 |
| 跨屏 DPR、缩放、滚动、元素裁剪 | 点击落点与截图坐标变换一致 |
| 同页用户输入与 AI 输入竞争 | 接管暂停队列，不悄悄覆盖用户内容 |
| DevTools 与 Agent 同时启用 | 验证共存或明确返回冲突，不静默断开和重放 |
| 故障/进程树清理 | 页面、companion、CLI 均可控收尾；工作台不冻结 |

### 3. 两家代理矩阵

| 代理 | 必测 |
| --- | --- |
| Codex | 新建、原生 resume、导入会话、attach 恢复、配置覆盖、原有指令保留、MCP 状态、图片、子代理继承 |
| Claude | 新建、resume、snapshot off、主/子代理提示、自定义 tools、后台任务、no-chrome、已有 MCP 叠加 |
| 共同 | 只读/计划模式、用户明确指定其他工具、同名服务冲突、组织策略拒绝、缺失二进制、协议不匹配 |

每家以同一组自然语言任务连续运行至少 5 次观察默认选择，记录实际工具调用和失败原因。这个样本用于发现路由问题，不作为统计保证，更不能宣称 100% 强制选用。

子代理继承未通过时，标明“浏览器由主代理执行”。不能把主代理成功当作子代理支持证据。

### 4. 性能、缓存与发布

- AI 关闭或尚未使用浏览器时，不创建 WebView/profile/companion；启用后的轻量 broker 可按需建立。
- 日志和截图按主方案双上限控制，制造超量事件确认不无限增长，丢失游标可见。
- 长任务在后台等待，可取消，不阻塞 UI 主线程；对截图、网络正文和 heap 制造超限验证。
- 关闭标签释放原生 surface 与关联订阅；临时 profile 的释放受引擎句柄寿命约束，不能在仍被使用时强删。
- 安装包验证 companion 路径、空格路径、非 ASCII 用户目录、首次启动权限与版本握手。
- Windows 验证 NSIS；macOS/Linux 对各自产物分别检查，未完成的能力在产品中明示。
- 更新时先停止浏览器调用、清理 companion，再切换同版本程序；旧连接不得继续连接新宿主。

常规实现完成后按仓库脚本执行：

```text
npm run check:ts
npm run check:rs
npm run test:front -- <受影响的现有测试>
npm run test:rs -- <相关模块过滤>
npm run build
```

companion 的 `cargo check/test` 命令在确定 workspace/crate 结构后加入正式脚本；不提前编造不存在的命令。纯文档方案不触发源码构建或新增测试。

### 5. 上线判定

P1 可用的最低条件：

- 两家 CLI 均实际完成一次项目修复与浏览器复验；new/resume 不丢工具。
- AI/浏览器关闭、权限撤销、多会话隔离、旧 token 重放均通过。
- 页面无法访问宿主 IPC；工作台主窗口、托盘、焦点与原有 AI 功能无回归。
- 结果区分派发与业务成功，失败不重复点击或提交。
- 未实现/平台不支持的能力不会出现在“已支持”列表。
- 已完成范围写入 features；未完成的 P2/P3 保留在 plans，不将整个目录误当成已交付。

## 出处

- [总体方案与源码依据](./README.md#出处)。
- [CLI 接入与文档依据](./agent-integration.md#出处)。
- 仓库测试脚本：根 `package.json`。
- 既有协议测试位置：`src-tauri/src/ai_runtime/codex.rs`、`claude.rs`、`mod.rs`、`integration_tests.rs`。
