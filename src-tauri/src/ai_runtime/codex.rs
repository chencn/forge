//! Codex app-server 稳定 JSONL 协议适配器。
use super::protocol::{Action, Protocol};
use super::task_status;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// 计划批准后的执行回合：先核对被审阅的计划仍在且正文未变，再开一次普通回合。
#[derive(Clone, Debug)]
pub struct Decision {
    /// `default`（批准执行）或 `plan`（要求修改，继续规划）。
    pub mode: &'static str,
    pub native_plan_id: String,
    pub content_hash: String,
}

/// 异步提问的上下文：app-server 把问题挂在 AgentMessage 上，
/// 答复不是 JSON-RPC 回包，而是往当前回合 `turn/steer` 一条用户消息。
#[derive(Clone, Debug)]
struct AsyncQuestion {
    thread_id: String,
    turn_id: String,
    /// 前端题号 → 服务端问题正文；答复按正文回填。
    titles: HashMap<String, String>,
}

const TASK_TOOL_NAMESPACE: &str = "forge";
const TASK_TOOL_NAME: &str = "update_tasks";

/// Codex 的协议适配器。
///
/// 与 Claude 不同，Codex 是「先 initialize、再开线程、最后开回合」的三段握手，
/// `phase` 就是这三段的进度；请求与响应靠自增 id 配对，所以待答复的请求要连 id 一起存。
pub struct Codex {
    /// 工作目录，开线程与开回合时都要带上，CLI 据此决定在哪读文件。
    cwd: String,
    /// 用户本轮输入的提示词，握手完成后作为回合的输入发出去。
    prompt: String,
    /// Forge 图片沙箱中的绝对路径；app-server 通过 localImage 原生输入读取。
    images: Vec<String>,
    /// 当前线程 id。恢复对话时先填旧值，CLI 返回后核对。
    thread: Option<String>,
    /// 当前回合 id。开回合后才有，中断与收尾都靠它定位。
    turn: Option<String>,
    /// 断线恢复只附着这一个既有回合；设置后禁止发送新的 `turn/start`。
    recovery_turn: Option<String>,
    /// 握手进度：0 未初始化、1 已发 initialize、2 已开线程、3 已开回合。
    /// 用它挡住乱序与重复的初始化请求。
    phase: u8,
    /// 待答复请求：请求 id → (原始 id、方法名、参数)。答复时要按方法名决定回什么结构。
    pending: HashMap<String, (Value, String, Value)>,
    /// 是否已被中断。置位后拒绝新请求，也不再放行授权。
    stopped: bool,
    /// 用户选择的模型；为空则沿用 CLI 默认。
    model: Option<String>,
    /// 用户选择的思考强度；为空则沿用 CLI 默认。是否支持由模型列表决定。
    effort: Option<String>,
    permission: super::options::PermissionMode,
    service_tier: String,
    /// 本轮按附加目录算好的沙箱策略；None 表示不发覆盖，沿用线程生效的沙箱。
    sandbox_policy: Option<Value>,
    command: Option<super::commands::CommandIntent>,
    /// 本轮的协作模式，取自这版 CLI 报出的取值（`plan`/`default`/…）。
    /// 它取代了旧的 plan_mode 布尔：模式是选项，不是开或关。
    mode: String,
    /// 远端 Codex 会话当前是否持久处于计划模式。
    thread_plan_mode: bool,
    /// CLI 最近一次报的上下文字符数（`thread/tokenUsage/updated` 的 `tokenUsage.last.totalTokens`）。
    /// 上下文芯片用的就是这一个数，压缩卡片也必须跟它同源，否则同一件事在界面上有两个值。
    context_tokens: Option<u64>,
    /// 正在等压缩后的第一次用量上报：Codex 的压缩条目本身不带前后字符数，
    /// 但它紧接着就会报新的 `tokenUsage`，那一趟就是「压缩到多少」。
    compact_pending: Option<u64>,
    /// 本轮是计划决策回合；它为一些线程先核对被审阅的计划。
    decision: Option<Decision>,
    /// 计划核验的分页状态；游标去重和页数上限同时防住服务端循环页。
    plan_cursors: HashSet<String>,
    plan_pages: usize,
    /// thread/resume 报告的实际模型与强度；collaborationMode.settings 必须带模型。
    thread_model: Option<String>,
    thread_effort: Option<String>,
    /// 异步提问：内部请求键 → steer 所需上下文。
    async_questions: HashMap<String, AsyncQuestion>,
    /// 已发出的 turn/steer 请求 id；它们的回包只需吞掉，不能当成握手响应。
    steers: HashSet<u64>,
    next_steer: u64,
    /// 本轮问到的 MCP 服务与状态全表。前端按整张表替换快照，所以启动通知必须改写
    /// 这张表再整体发出，不能只报那一台——八台的表会被压成一行。
    mcp_servers: Vec<Value>,
    /// 只有完整非空列表到达后，启动通知才有权改写并广播全表。
    mcp_ready: bool,
    /// 完整列表之前到达的通知先缓存；探测失败或为空时整批丢弃。
    pending_mcp_status: HashMap<String, String>,
    /// 已发出的 mcpServerStatus/list 探测 id；回包同样不是握手响应。
    mcp_probes: HashSet<u64>,
    next_mcp_probe: u64,
    /// 已发出的 thread/goal/get 探测 id；Goal 是线程状态，恢复时不能等下一次通知。
    goal_probes: HashSet<u64>,
    next_goal_probe: u64,
    /// Goal 状态写请求先等服务端确认，再回读完整快照，避免前端伪造原生状态。
    goal_sets: HashSet<u64>,
    next_goal_set: u64,
    /// `spawn_agent` 的 call id → 用户定义的 task_name。SubAgentActivity 只给线程与路径，
    /// 必须靠 call id 把真正的任务名接回来，不能拿随机 agentNickname 冒充标题。
    pending_agent_titles: HashMap<String, String>,
    /// `spawn_agent` 的 call id → 任务正文。协议没有承诺正文的字段名，尽力从常见命名
    /// 里取一段带出，让子代理视图打开时能看到它被安排了什么（Claude 侧一直有）。
    pending_agent_prompts: HashMap<String, String>,
    /// 子代理线程 → 已解析标题。completed/interacted 的 item id 会变化，后续事件靠线程续用首个标题。
    agent_titles: HashMap<String, String>,
}
/// `declined` 的 fileChange 条目里，changes 的键就是要写的那个文件。
/// 只有整个键本身就是绝对路径才配得上「授予这个目录」：相对写法交给后端复核会直接报错，
/// 那样按钮点了就是坏的，不如不显示按钮。
fn absolute_file(value: Option<&str>) -> Option<String> {
    let path = value?.trim();
    let bytes = path.as_bytes();
    let drive = path.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/');
    (drive || (path.starts_with('/') && path.len() > 1)).then(|| path.to_owned())
}

/// 把 Codex 的任务标识转成面向用户的名字。task_name 最权威，历史恢复时才退到 agent_path/role；
/// agent_nickname 是随机内部代号，故意不进入这个函数。
pub(super) fn subagent_title(task_name: Option<&str>, path: Option<&str>, role: Option<&str>) -> Option<String> {
    let raw = task_name.and_then(|value| (!value.trim().is_empty()).then_some(value.trim()))
        .or_else(|| path.and_then(|value| value.rsplit('/').find(|part| !part.trim().is_empty())).map(str::trim))
        .or_else(|| role.and_then(|value| (!value.trim().is_empty()).then_some(value.trim())))?;
    // task_name 的协议格式是 snake_case；空格比下划线更像真正的标题，连续空白顺手收敛。
    Some(raw.replace('_', " ").split_whitespace().collect::<Vec<_>>().join(" "))
}

/// 把申请来的权限集翻成一句人话。卡片得让人看懂「批准等于给什么」，
/// 而不是先读一遍 JSON 再自己推。路径按 CLI 给的原文引用，不替它解释成目录。
fn permission_request_text(permissions: &Value) -> String {
    let mut listed: Vec<String> = Vec::new();
    let file_system = &permissions["fileSystem"];
    for entry in file_system["entries"].as_array().into_iter().flatten() {
        let access = entry["access"].as_str().unwrap_or("?");
        let path = match entry["path"]["type"].as_str() {
            Some("path") => entry["path"]["path"].as_str().unwrap_or("").to_owned(),
            Some("glob_pattern") => entry["path"]["pattern"].as_str().unwrap_or("").to_owned(),
            Some("special") => entry["path"]["value"].to_string(),
            _ => String::new(),
        };
        if !path.is_empty() { listed.push(format!("{access} {path}")); }
    }
    // 旧版 read/write 字符串数组仍在协议里，标注 deprecated 但 CLI 还会发。
    for key in ["read", "write"] {
        for path in file_system[key].as_array().into_iter().flatten().filter_map(Value::as_str) {
            listed.push(format!("{key} {path}"));
        }
    }
    let mut parts = Vec::new();
    if !listed.is_empty() { parts.push(format!("文件系统：{}", listed.join("、"))); }
    if permissions["network"]["enabled"].as_bool() == Some(true) { parts.push("联网".into()); }
    if parts.is_empty() { return "没有说明具体要什么权限".into(); }
    parts.join("；")
}

impl Codex {
    /// 给新线程注册一个 Forge 自己拥有的任务清单工具。
    ///
    /// 每次调用都提交完整快照，避免在协议层再维护一套增删改命令与部分更新状态机。
    pub(super) fn task_tools() -> Value {
        json!([{
            "type": "namespace",
            "name": TASK_TOOL_NAMESPACE,
            "description": "Update Forge conversation UI state.",
            "tools": [{
                "type": "function",
                "name": TASK_TOOL_NAME,
                "description": "Replace the current task checklist. Use for multi-step work and call again whenever progress changes.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tasks": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 32,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "step": { "type": "string", "minLength": 1, "maxLength": 500 },
                                    "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] }
                                },
                                "required": ["step", "status"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["tasks"],
                    "additionalProperties": false
                }
            }]
        }])
    }

    /// 校验动态工具提交的完整快照，并转换成 Forge 已有的 task_list 词表。
    fn task_list(arguments: &Value) -> Result<Value, String> {
        let tasks = arguments["tasks"].as_array().ok_or("tasks 必须是数组")?;
        if tasks.is_empty() || tasks.len() > 32 {
            return Err("tasks 必须包含 1 到 32 项".into());
        }
        let mut active = 0usize;
        let mut items = Vec::with_capacity(tasks.len());
        for (index, task) in tasks.iter().enumerate() {
            let content = task["step"].as_str().map(str::trim).filter(|step| !step.is_empty())
                .ok_or_else(|| format!("第 {} 项任务缺少正文", index + 1))?;
            if content.chars().count() > 500 {
                return Err(format!("第 {} 项任务正文超过 500 字", index + 1));
            }
            let status = match task["status"].as_str() {
                Some("pending") => "pending",
                Some("in_progress") => { active += 1; "active" }
                Some("completed") => "complete",
                _ => return Err(format!("第 {} 项任务状态无效", index + 1)),
            };
            items.push(json!({"id":format!("task-{index}"),"content":content,"status":status}));
        }
        if active > 1 {
            return Err("任务清单最多只能有一项正在执行".into());
        }
        Ok(json!({"replace":true,"items":items}))
    }

    fn dynamic_tool_result(id: Value, success: bool, text: &str) -> Action {
        Action::Write(json!({"id":id,"result":{
            "contentItems":[{"type":"inputText","text":text}],
            "success":success
        }}))
    }

    pub fn new(cwd: String, prompt: String, native_id: Option<String>) -> Self {
        Self {
            cwd,
            prompt,
            images: vec![],
            thread: native_id,
            turn: None,
            recovery_turn: None,
            phase: 0,
            pending: HashMap::new(),
            stopped: false,
            model: None,
            effort: None,
            permission: Default::default(),
            service_tier: "default".into(),
            sandbox_policy: None,
            command: None,
            mode: super::options::default_mode_id(crate::ai_cli::Provider::Codex).to_owned(),
            thread_plan_mode: false,
            context_tokens: None,
            compact_pending: None,
            decision: None,
            plan_cursors: HashSet::new(),
            plan_pages: 0,
            thread_model: None,
            thread_effort: None,
            async_questions: HashMap::new(),
            steers: HashSet::new(),
            next_steer: 1_000_000,
            mcp_servers: vec![],
            mcp_ready: false,
            pending_mcp_status: HashMap::new(),
            mcp_probes: HashSet::new(),
            next_mcp_probe: 2_000_000,
            goal_probes: HashSet::new(),
            next_goal_probe: 3_000_000,
            goal_sets: HashSet::new(),
            next_goal_set: 4_000_000,
            pending_agent_titles: HashMap::new(),
            pending_agent_prompts: HashMap::new(),
            agent_titles: HashMap::new(),
        }
    }
    pub fn with_options(mut self, model: Option<String>, effort: Option<String>) -> Self {
        self.model = model;
        self.effort = effort;
        self
    }
    pub fn with_images(mut self, images: Vec<String>) -> Self {
        self.images = images;
        self
    }
    pub fn with_recovery_turn(mut self, turn: String) -> Self {
        self.recovery_turn = Some(turn);
        self
    }
    pub fn with_policy(mut self, permission: super::options::PermissionMode, service_tier: String) -> Self {
        self.permission = permission;
        self.service_tier = service_tier;
        self
    }
    pub fn with_sandbox_policy(mut self, policy: Option<Value>) -> Self {
        self.sandbox_policy = policy;
        self
    }
    pub fn with_command(mut self, command: Option<super::commands::CommandIntent>) -> Self {
        self.command = command;
        self
    }
    pub fn with_mode(mut self, mode: String) -> Self {
        self.mode = mode;
        self
    }
    /// 只有 `plan` 这一档会产出计划卡片，其余取值都是「照常干活」。
    fn plan(&self) -> bool {
        self.mode == "plan"
    }
    /// 压缩条目自己不带前后字符数（实测 0.164：`contextCompaction` 只有 message，
    /// `contextCompacted` 通知只有 threadId/turnId），但压缩前的上下文就是上一次用量上报。
    /// 每次收到压缩事件都重新记一次：万一上一段没等到后续用量，旧值会挂到新一段头上，宁可取新的。
    fn remember_compaction(&mut self) { self.compact_pending = self.context_tokens; }
    /// 压缩后的第一次用量上报即「压到了多少」。取不到就返回 None，卡片退回不带数字的说法。
    fn take_compaction_delta(&mut self) -> Option<Action> {
        let before = self.compact_pending.take()?;
        let after = self.context_tokens?;
        if before == after { return None; }
        Some(Action::Emit {
            kind: "compaction",
            data: json!({"status":"completed","metadata":{"preTokens":before,"postTokens":after}}),
        })
    }
    pub fn with_decision(mut self, decision: Option<Decision>) -> Self {
        self.decision = decision;
        self
    }
    /// 附加目录只有 turn/start 的沙箱策略这个落点：策略是整份替换，
    /// 内容由 options::codex_sandbox_grant 按项目生效值合并后再发过来。
    /// 规划回合不发：那一轮的本意就是不动工作区，顺手把可写根目录摊宽等于自己拆自己的约束。
    /// 批准后的执行回合（decision）照发，否则批准完还是写不进去。
    fn apply_sandbox_policy(&self, turn: &mut Value) {
        // “要求修改”通过 decision 进入规划模式，也不能扩大规划回合的可写目录。
        if self.plan() || self.decision.as_ref().is_some_and(|decision| decision.mode == "plan") { return; }
        if let Some(policy) = &self.sandbox_policy { turn["sandboxPolicy"] = policy.clone(); }
    }
    /// 问 CLI「这条线程实际加载了哪些 MCP 服务」。只读探测，和 Claude 从 init 帧读到的
    /// 那份快照投成同一个事件形状，前端不需要知道两家协议的区别。
    fn mcp_probe(&mut self, thread: &str) -> Value {
        let id = self.next_mcp_probe;
        self.next_mcp_probe += 1;
        self.mcp_probes.insert(id);
        json!({"id":id,"method":"mcpServerStatus/list","params":{"threadId":thread,"detail":"toolsAndAuthOnly"}})
    }
    fn mcp_snapshot(&self) -> Action {
        Action::Emit {
            kind: "mcp_servers",
            data: json!({"servers": self.mcp_servers.iter().map(|server| json!({"name":server["name"],"status":server["status"]})).collect::<Vec<_>>()}),
        }
    }
    /// Goal 由 Codex 线程原生持有；每次接上线程后读取一次，避免恢复会话只能等后续变更通知。
    fn goal_probe(&mut self, thread: &str) -> Value {
        let id = self.next_goal_probe;
        self.next_goal_probe += 1;
        self.goal_probes.insert(id);
        json!({"id":id,"method":"thread/goal/get","params":{"threadId":thread}})
    }
    /// 通知只能改完整列表里已有的服务器；未知名字不能凭一条局部通知扩成“全表”。
    fn record_mcp_status(&mut self, name: &str, status: &str) -> bool {
        let Some(server) = self.mcp_servers.iter_mut().find(|server| server["name"].as_str() == Some(name)) else { return false; };
        server["status"] = json!(status);
        true
    }
    /// collaborationMode 的 settings.model 是必填项；拿不到模型就失败关闭，
    /// 发一个缺少必填字段的对象不是协商，而是无效请求。
    fn collaboration(mode: &str, model: Option<&str>, effort: Option<&str>) -> Result<Value, String> {
        let model = model.map(str::trim).filter(|model| !model.is_empty())
            .ok_or("Codex 未报告当前模型，无法设置协作模式")?;
        let mut settings = serde_json::Map::new();
        settings.insert("model".into(), json!(model));
        if let Some(effort) = effort.map(str::trim).filter(|effort| !effort.is_empty()) {
            settings.insert("reasoning_effort".into(), json!(effort));
        }
        Ok(json!({"mode":mode,"settings":Value::Object(settings)}))
    }
    /// `thread/turns/list`（itemsView=full）里核对被审阅的最终计划：
    /// id 与正文指纹都要对上，否则整个决策在开回合前失败。
    fn check_plan(page: &Value, native_plan_id: &str, expected_hash: &str) -> Result<bool, String> {
        let turns = page["data"].as_array().ok_or("thread/turns/list 未返回回合页")?;
        for turn in turns {
            for item in turn["items"].as_array().into_iter().flatten() {
                if item["type"] != "plan" || item["id"].as_str() != Some(native_plan_id) {
                    continue;
                }
                let text = item["text"].as_str().ok_or("codex plan is stale: 计划条目缺少正文")?;
                return if super::plans::content_hash(text) == expected_hash {
                    Ok(true)
                } else {
                    Err("codex plan is stale: 计划正文在等待审批期间已改变".into())
                };
            }
        }
        Ok(false)
    }
    fn plan_page(thread: &str, cursor: Option<&str>) -> Value {
        let mut params = json!({"threadId":thread,"itemsView":"full","limit":16,"sortDirection":"desc"});
        if let Some(cursor) = cursor { params["cursor"] = json!(cursor); }
        json!({"id":3,"method":"thread/turns/list","params":params})
    }
    /// 把 AgentMessage 上的 `questions` 转成通用提问卡；没有问题的消息返回空。
    /// 单题缺 title 时跳过那一题而不是整组丢弃：一题格式坏了不该把其余能答的问题一起藏掉。
    fn async_cards(item: &Value) -> Option<(Value, AsyncQuestion)> {
        let questions = item["questions"].as_array().filter(|list| !list.is_empty() && list.len() <= 32)?;
        let mut cards = vec![];
        let mut titles = HashMap::new();
        for (index, question) in questions.iter().enumerate() {
            let Some(title) = question["title"].as_str().map(str::trim).filter(|title| !title.is_empty()) else { continue };
            let options: Vec<_> = question["options"].as_array().into_iter().flatten()
                .filter_map(Value::as_str).map(str::trim).filter(|label| !label.is_empty())
                .map(|label| json!({"label":label})).collect();
            let id = index.to_string();
            titles.insert(id.clone(), title.to_string());
            cards.push(json!({"id":id,"question":title,"header":format!("Q{}", index + 1),"options":options,"multiSelect":false}));
        }
        (!cards.is_empty()).then(|| (json!({"title":"Codex","questions":cards}), AsyncQuestion { thread_id: String::new(), turn_id: String::new(), titles }))
    }
    fn request(&mut self, id: Value, method: &str, params: Value) -> Result<Vec<Action>, String> {
        let key = id.to_string();
        if self.pending.contains_key(&key) {
            return Err("Codex 重复使用待处理请求 ID".into());
        }
        if self.stopped
            || params["threadId"]
                .as_str()
                .is_some_and(|id| self.thread.as_deref() != Some(id))
        {
            return Ok(vec![Action::Write(
                json!({"id":id,"error":{"code":-32600,"message":"Inactive thread"}}),
            )]);
        }
        match method {
            "item/tool/call" if params["namespace"].as_str() == Some(TASK_TOOL_NAMESPACE)
                && params["tool"].as_str() == Some(TASK_TOOL_NAME) => {
                match Self::task_list(&params["arguments"]) {
                    Ok(data) => Ok(vec![
                        Action::Emit { kind: "task_list", data },
                        Self::dynamic_tool_result(id, true, "Task list updated."),
                    ]),
                    Err(error) => Ok(vec![Self::dynamic_tool_result(id, false, &error)]),
                }
            }
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                self.pending
                    .insert(key.clone(), (id, method.into(), params.clone()));
                // `input` 保留完整原生参数供工具详情展示，原因同时作为权限卡摘要。
                let reason = params["reason"].clone();
                Ok(vec![Action::Request {
                    key,
                    kind: "permission",
                    // 权限卡片复用普通工具展示，不再要求用户阅读一整块原始 JSON。
                    data: json!({
                        "title":if method.contains("commandExecution") { "执行命令" } else { "修改文件" },
                        "toolName":if method.contains("commandExecution") { "exec" } else { "apply_patch" },
                        "input":params,
                        "reason":reason,
                        // Codex 的答复只有决定位，改不了入参，所以这里明确告诉前端别出那个按钮。
                        "canEdit":false,
                    }),
                }])
            }
            "item/tool/requestUserInput" => {
                let questions = params["questions"]
                    .as_array()
                    .filter(|q| !q.is_empty() && q.len() <= 32)
                    .ok_or("Codex 问题格式不兼容")?;
                if questions
                    .iter()
                    .any(|q| q["id"].as_str().is_none() || q["question"].as_str().is_none())
                {
                    return Err("Codex 问题缺少标识或正文".into());
                }
                let data = json!({"title":"Codex","questions":questions});
                self.pending
                    .insert(key.clone(), (id, method.into(), params));
                Ok(vec![Action::Request {
                    key,
                    kind: "question",
                    data,
                }])
            }
            "item/permissions/requestApproval" => {
                // 这条请求要的是「放宽沙箱」，答复位是一份授予集，不是 accept/decline。
                // 批准 = 把 CLI 申请的那份原样授予：Forge 不重新解释路径、也不加宽，
                // 自己翻译一遍等于多一处能把授权范围改大或改小的地方。
                let asked = permission_request_text(&params["permissions"]);
                let reason = params["reason"].as_str().map(str::trim).filter(|text| !text.is_empty())
                    .map(|text| format!("{text}（申请授予：{asked}）"))
                    .unwrap_or_else(|| format!("申请授予：{asked}"));
                self.pending.insert(key.clone(), (id, method.into(), params.clone()));
                Ok(vec![Action::Request {
                    key,
                    kind: "permission",
                    data: json!({
                        "title": "Codex 申请扩大权限",
                        // 没有工具名就没有「本轮不再询问」：这条答复授予的是沙箱范围，
                        // 让 Forge 代答下一次同类申请，等于替 CLI 记住越权。
                        "toolName": "",
                        // 与执行命令/改文件两张卡同一规则：input 留原生参数供详情展开，
                        // 人话摘要走 reason，不把展示文本混进原生参数里。
                        "input": params,
                        "reason": reason,
                        "canEdit": false,
                    }),
                }])
            }
            "mcpServer/elicitation/request" => Ok(vec![
                Action::Emit { kind: "notice", data: json!({"text":"Codex 内的 MCP 服务想追加一轮提问，Forge 不代答，已拒绝。","auto":"declined"}) },
                Action::Write(json!({"id":id,"result":{"action":"decline"}})),
            ]),
            _ => Ok(vec![
                Action::Emit { kind: "notice", data: json!({"text":format!("Codex 请求了 Forge 不认识的授权类型（{method}），已按不授予处理。"),"auto":"declined"}) },
                Action::Write(json!({"id":id,"error":{"code":-32601,"message":"Unsupported request; no permission granted"}})),
            ]),
        }
    }
}
impl Protocol for Codex {
    fn start(&mut self) -> Result<Vec<Action>, String> {
        if self.phase != 0 {
            return Err("Codex 已初始化".into());
        }
        self.phase = 1;
        // dynamicTools 是实验字段；所有 Forge 对话都依赖任务工具，因此握手必须声明实验能力。
        let experimental = true;
        Ok(vec![Action::Write(
            json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"forge","title":"Forge","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":experimental}}}),
        )])
    }
    fn receive(&mut self, message: Value) -> Result<Vec<Action>, String> {
        if let Some(method) = message["method"].as_str() {
            let p = &message["params"];
            if let Some(id) = message.get("id") {
                return self.request(id.clone(), method, p.clone());
            }
            if p["threadId"]
                .as_str()
                .is_some_and(|id| self.thread.as_deref() != Some(id))
            {
                return Ok(vec![]);
            }
            let mut out = vec![];
            if self.phase == 3 && self.command == Some(super::commands::CommandIntent::CodexCompact)
                && self.turn.is_none() && method == "item/started" && p["item"]["type"] == "contextCompaction"
                && p["threadId"].as_str() == self.thread.as_deref() {
                if let Some(id) = p["turnId"].as_str() {
                    self.turn = Some(id.into());
                    if self.stopped { out.extend(self.interrupt()); }
                }
            }
            match method {
                "turn/started" => {
                    if let Some(id) = p["turn"]["id"].as_str() {
                        self.turn = Some(id.into());
                    }
                }
                "item/agentMessage/delta" => {
                    let id = p["itemId"].as_str().ok_or("Codex 文本缺少 itemId")?;
                    let text = p["delta"].as_str().ok_or("Codex 文本增量无效")?;
                    out.push(Action::Emit {
                        kind: "text",
                        data: json!({"id":id,"text":text}),
                    });
                }
                // 计划正文的流式预览；schema 明确说拼接结果未必等于最终条目，
                // 所以它只用于上屏，审阅正文永远取完成后的 plan item。
                "item/plan/delta" => {
                    if let (Some(thread), Some(text)) = (p["threadId"].as_str(), p["delta"].as_str().filter(|text| !text.is_empty())) {
                        out.push(Action::Emit {
                            kind: "plan_draft",
                            data: json!({"planId":super::plans::plan_id_for(thread),"text":text,"append":true}),
                        });
                    }
                }
                "item/started" | "item/completed" => {
                    let item = &p["item"];
                    let id = item["id"].as_str().ok_or("Codex 工具或消息缺少 ID")?;
                    let done = method == "item/completed";
                    match item["type"].as_str().unwrap_or("") {
                        "agentMessage" if done => {
                            out.push(Action::Emit {
                                kind: "message",
                                data: json!({"id":id,"text":item["text"].as_str().unwrap_or("")}),
                            });
                            // app-server 也可能把提问挂在 AgentMessage 上；这类答复
                            // 不是 JSON-RPC 回包，而是往当前回合 steer 一条消息。
                            if let Some((data, mut question)) = Self::async_cards(item) {
                                if let (Some(thread), Some(turn)) = (
                                    p["threadId"].as_str().or(self.thread.as_deref()),
                                    self.turn.as_deref(),
                                ) {
                                    question.thread_id = thread.into();
                                    question.turn_id = turn.into();
                                    let key = format!("async:{id}");
                                    self.async_questions.insert(key.clone(), question);
                                    self.pending.insert(key.clone(), (Value::String(id.into()), "asyncQuestion".into(), data.clone()));
                                    out.push(Action::Request { key, kind: "question", data });
                                }
                            }
                        }
                        "commandExecution" | "fileChange" | "mcpToolCall" | "webSearch" | "dynamicToolCall" => {
                            // app-server 先发 spawn_agent 的动态工具条目，再用同一个 call id 发
                            // SubAgentActivity(started)。这里只缓存展示名，生命周期仍由后者驱动。
                            if !done && item["type"] == "dynamicToolCall" && item["tool"] == "spawn_agent" {
                                if let Some(title) = subagent_title(item["arguments"]["task_name"].as_str(), None, None) {
                                    self.pending_agent_titles.insert(id.to_owned(), title);
                                }
                                let prompt = ["task", "prompt", "message", "description", "instructions"].iter().find_map(|key| {
                                    item["arguments"][key].as_str().map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned)
                                });
                                if let Some(prompt) = prompt {
                                    self.pending_agent_prompts.insert(id.to_owned(), prompt);
                                }
                            }
                            let status = if !done {
                                "running"
                            } else if item["status"] == "interrupted" {
                                "cancelled"
                            } else if matches!(item["status"].as_str(), Some("failed" | "declined"))
                                || item["exitCode"].as_i64().is_some_and(|code| code != 0)
                                || item["type"] == "dynamicToolCall" && item["success"] == false
                                || item["type"] == "mcpToolCall" && item.get("error").is_some_and(|error| {
                                    !error.is_null() && error.as_str().map_or(true, |message| !message.is_empty())
                                })
                            {
                                "failed"
                            } else {
                                "completed"
                            };
                            let (name, input, result, output) = match item["type"].as_str().unwrap_or("") {
                                "commandExecution" => ("exec".to_owned(), json!({"command":item["command"],"description":item["description"],"cwd":item["cwd"],"commandActions":item["commandActions"]}), json!({"exitCode":item["exitCode"],"durationMs":item["durationMs"]}), item["aggregatedOutput"].clone()),
                                "fileChange" => {
                            // changes 原生是 { 路径: {type, unified_diff} } 映射；转成数组，
                            // 前端的补丁解析（path/kind/diff）只吃数组形态。
                            let changes = item["changes"].as_object().map(|map| {
                                let list: Vec<Value> = map.iter().map(|(path, change)| {
                                    json!({"path":path,"kind":change["type"],"diff":change["unified_diff"]})
                                }).collect();
                                json!(list)
                            }).unwrap_or_else(|| item["changes"].clone());
                            ("apply_patch".to_owned(), json!({"changes":changes}), json!({"status":item["status"]}), item["aggregatedOutput"].clone())
                        }
                                "mcpToolCall" => (item["tool"].as_str().unwrap_or("mcp").to_owned(), json!({"kind":"mcp","server":item["server"],"tool":item["tool"],"arguments":item["arguments"]}), json!({"result":item["result"],"error":item["error"],"status":item["status"]}), item["result"].clone()),
                                "dynamicToolCall" => (item["tool"].as_str().unwrap_or("tool").to_owned(), json!({"kind":"dynamic","namespace":item["namespace"],"tool":item["tool"],"arguments":item["arguments"]}), json!({"success":item["success"],"contentItems":item["contentItems"]}), item["contentItems"].clone()),
                                "webSearch" => ("webSearch".to_owned(), json!({"kind":"search","query":item["query"],"action":item["action"]}), json!({"results":item["results"]}), item["results"].clone()),
                                _ => unreachable!(),
                            };
                            // 被沙箱拒掉不是工具跑坏了：说清楚是谁被拒、为哪条命令，
                            // 让用户能像 Claude 那样把目标目录授权给下一轮。
                            if done && item["status"] == "declined" {
                                let path = match item["type"].as_str() {
                                    Some("fileChange") => item["changes"].as_object()
                                        .into_iter()
                                        .flat_map(|changes| changes.keys())
                                        .find_map(|key| absolute_file(Some(key.as_str()))),
                                    _ => None,
                                };
                                let text = item["command"].as_str()
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| "Codex 申请写入会话工作区之外的位置，已被拒绝。".to_owned());
                                let mut data = json!({"tool": name.clone(), "text": text});
                                if let Some(path) = path { data["path"] = json!(path); }
                                out.push(Action::Emit { kind: "permission_denied", data });
                            }
                            out.push(Action::Emit {kind:"tool",data:json!({"id":id,"name":name,"input":input,"result":result,"output":output,"status":status})});
                            if done && item["type"] == "fileChange" {
                                // 上面已把原生路径映射规范化成 changes 数组；文件事件必须复用同一份数据。
                                let paths: Vec<_> = input["changes"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .filter_map(|v| v["path"].as_str())
                                    .collect();
                                out.push(Action::Emit {
                                    kind: "files",
                                    data: json!({"paths":paths}),
                                });
                            }
                        }
                        "reasoning" if done => {
                            let sections = |key: &str| -> Vec<String> {
                                item[key].as_array().into_iter().flatten()
                                    .filter_map(|section| section.as_str())
                                    .filter(|text| !text.is_empty())
                                    .map(str::to_owned)
                                    .collect()
                            };
                            // 摘要优先：那是 CLI 给的展示文本。只有这一条完全没有摘要时才退回原始轨迹——
                            // 两份都发就同一段思考出现两张卡，而摘要永远比轨迹短且更干净。
                            // contentIndex 与 summaryIndex 是两个独立索引空间，所以这两条路的 id
                            // 绝不能同时出现，否则前端按 id 分卡时会把两段文字并成一张。
                            let text = sections("summary");
                            let fallback = if text.is_empty() { sections("content") } else { text };
                            for (index, section) in fallback.into_iter().enumerate() {
                                out.push(Action::Emit { kind: "reasoning", data: json!({"id":format!("{id}-{index}"),"text":section}) });
                            }
                        }
                        "exitedReviewMode" if done => out.push(Action::Emit { kind: "message", data: json!({"id":id,"text":item["review"].as_str().unwrap_or("")}) }),
                        // 完成后的 plan item 才是权威正文；无论用户主动开没开 plan_mode，只要模型产出了计划条目，
                        // 都立即替换流式预览并广播审阅卡片，使用户能审阅或批准执行，避免卡在计划死锁态。
                        "plan" if done => {
                            let text = item["text"].as_str().unwrap_or("");
                            if !text.trim().is_empty() {
                                if let Some(thread) = p["threadId"].as_str().or(self.thread.as_deref()) {
                                    out.push(Action::Emit {
                                        kind: "plan_draft",
                                        data: json!({"planId":super::plans::plan_id_for(thread),"text":text,"append":false,"complete":true}),
                                    });
                                    out.push(Action::Plan {
                                        title: super::plans::title(text),
                                        content: text.into(),
                                        native_plan_id: id.into(),
                                    });
                                }
                            }
                        }
                        // rollout 里是 PascalCase，app-server 线格式是 camelCase，都认。
                        "subAgentActivity" | "SubAgentActivity" if done => {
                            // multi-agent v2：子代理在父连接上只有摘要级活动
                            // （`SubAgentActivity` item），细粒度转写不转发。
                            // app-server 线格式是 camelCase，rollout 的 snake_case 做兼容。
                            // key 用 agentThreadId 路由子会话；agentPath 是可寻址名（转发消息用）。
                            let thread_id = item["agentThreadId"].as_str().or_else(|| item["agent_thread_id"].as_str()).filter(|id| !id.is_empty());
                            let status = match item["kind"].as_str().unwrap_or("") {
                                "completed" => Some("completed"),
                                "started" | "interacted" => Some("running"),
                                _ => None,
                            };
                            if let (Some(thread_id), Some(status)) = (thread_id, status) {
                                let path = item["agentPath"].as_str().or_else(|| item["agent_path"].as_str()).filter(|path| !path.is_empty());
                                let role = item["agentRole"].as_str().or_else(|| item["agent_role"].as_str()).filter(|role| !role.trim().is_empty());
                                let title = self.agent_titles.get(thread_id).cloned()
                                    .or_else(|| self.pending_agent_titles.remove(id))
                                    .or_else(|| subagent_title(None, path, role))
                                    .unwrap_or_else(|| "子代理".into());
                                self.agent_titles.entry(thread_id.to_owned()).or_insert_with(|| title.clone());
                                let mut data = json!({
                                    "key": thread_id,
                                    "toolId": id,
                                    "title": title,
                                    "model": item["model"],
                                    "effort": item["reasoningEffort"].as_str().or_else(|| item["reasoning_effort"].as_str()),
                                    "status": status,
                                    "activity": item["kind"],
                                });
                                // 首次 started 带出任务正文：agent 事件首见时运行时会把它
                                // 写成子会话的第一条用户消息（remove 保证只带一次）。
                                if item["kind"].as_str() == Some("started") {
                                    if let Some(prompt) = self.pending_agent_prompts.remove(id) {
                                        data["prompt"] = json!(prompt);
                                    }
                                }
                                if let Some(role) = role { data["agentType"] = json!(role); }
                                if let Some(path) = path {
                                    data["agentId"] = json!(path);
                                }
                                out.push(Action::Emit { kind: "agent", data });
                            }
                        }
                        "collabAgentToolCall" if done => {
                            // multi-agent v1（collab 工具）best-effort：每个接收方的最新
                            // 状态转成 agent 事件。线形状未在本机实证，字段缺失就静默跳过。
                            for (thread_id, state) in item["agentsStates"].as_object().into_iter().flatten() {
                                let status = match state["status"].as_str().unwrap_or("") {
                                    "completed" => "completed",
                                    "errored" | "failed" => "failed",
                                    "shutdown" | "interrupted" => "stopped",
                                    _ => "running",
                                };
                                out.push(Action::Emit { kind: "agent", data: json!({
                                    "key": thread_id,
                                    "toolId": id,
                                    "title": state["name"].as_str().or_else(|| state["task"].as_str()),
                                    "agentId": state["target"].as_str(),
                                    "status": status,
                                    "detail": state["message"],
                                }) });
                            }
                        }
                        "contextCompaction" => {
                            let text = item.get("message").or_else(|| item.get("summary")).or_else(|| item.get("text")).and_then(|v| v.as_str()).unwrap_or("");
                            self.remember_compaction();
                            out.push(Action::Emit {
                                kind: "compaction",
                                data: json!({"id":id,"status":if done {"completed"} else {"running"},"text":text}),
                            });
                        }
                        _ => {}
                    }
                }
                "thread/settings/updated" => {
                    let mode = p["threadSettings"]["collaborationMode"]["mode"].as_str()
                        .or_else(|| p["collaborationMode"]["mode"].as_str());
                    if let Some(mode) = mode {
                        let in_plan = mode == "plan";
                        self.thread_plan_mode = in_plan;
                        // 把 CLI 亲口报的模式原样送回界面：CLI 自己切换档位时芯片要跟着走，
                        // 不能只显示用户按下发送时选的那一档。
                        out.push(Action::Emit {
                            kind: "configuration",
                            data: json!({ "planMode": in_plan, "threadPlanMode": in_plan, "mode": mode }),
                        });
                    }
                }
                "item/reasoning/summaryTextDelta" => out.push(Action::Emit { kind: "reasoning_delta", data: json!({"id":format!("{}-{}",p["itemId"].as_str().unwrap_or(""),p["summaryIndex"].as_u64().unwrap_or(0)),"text":p["delta"]}) }),
                "turn/plan/updated" => {
                    // 两家 CLI 都落成同一 task_list 事件，UI 与历史恢复不再理解供应商字段。
                    let items: Vec<_> = p["plan"].as_array().into_iter().flatten().enumerate().filter_map(|(index, item)| {
                        let content = item["step"].as_str()?.trim();
                        if content.is_empty() { return None; }
                        let status = match item["status"].as_str().unwrap_or("") {
                            "completed" => "complete",
                            "inProgress" => "active",
                            _ => "pending",
                        };
                        Some(json!({"id":format!("plan-{index}"),"content":content,"status":status}))
                    }).collect();
                    out.push(Action::Emit { kind: "task_list", data: json!({"replace":true,"items":items}) });
                }
                // Goal 是线程级目标，不是任务清单；保留 Codex 的原生状态与用量字段原样落盘。
                "thread/goal/updated" => {
                    if p["goal"].is_object() {
                        out.push(Action::Emit { kind: "goal", data: json!({"goal":p["goal"]}) });
                    }
                }
                "thread/goal/cleared" => {
                    out.push(Action::Emit { kind: "goal", data: json!({"goal":null}) });
                }
                // thread/compacted 中携带着会话压缩的总结文本 message，将其转成 compaction 事件补全摘要。
                "thread/compacted" => {
                    let text = p.get("message").or_else(|| p.get("summary")).and_then(|v| v.as_str()).unwrap_or("");
                    if !text.is_empty() {
                        self.remember_compaction();
                        out.push(Action::Emit {
                            kind: "compaction",
                            data: json!({"status":"completed","text":text}),
                        });
                    }
                },
                "model/rerouted" => out.push(Action::Emit { kind: "configuration", data: json!({"model":p["toModel"]}) }),
                "item/fileChange/patchUpdated" => out.push(Action::Emit {
                    kind: "tool",
                    data: json!({"id":p["itemId"],"inputPatch":{"changes":p["changes"]}}),
                }),
                "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => out.push(Action::Emit {
                    kind: "tool",
                    data: json!({"id":p["itemId"],"outputDelta":p["delta"]}),
                }),
                "thread/tokenUsage/updated" => {
                    self.context_tokens = p["tokenUsage"]["last"]["totalTokens"].as_u64();
                    // 压缩后的第一次用量上报就是「压到了多少」；没有它就只能说「已压缩」。
                    if let Some(before) = self.take_compaction_delta() { out.push(before); }
                    out.push(Action::Emit { kind: "usage", data: p.clone() });
                }
                // 一台服务器的启动状态变了：改写全表再整体发，只发这一台会把表压成一行。
                "mcpServer/startupStatus/updated" => {
                    let name = p["name"].as_str().map(str::trim).filter(|name| !name.is_empty());
                    let status = p["status"].as_str().filter(|status| !status.is_empty());
                    if let (Some(name), Some(status)) = (name, status) {
                        if self.mcp_ready {
                            if self.record_mcp_status(name, status) { out.push(self.mcp_snapshot()); }
                        } else {
                            self.pending_mcp_status.insert(name.to_owned(), status.to_owned());
                        }
                    }
                }
                "serverRequest/resolved" => {
                    if let Some(id) = p.get("requestId") {
                        let key = id.to_string();
                        self.pending.remove(&key);
                        out.push(Action::Invalidate(key));
                    }
                }
                "turn/completed" => {
                    if self.phase < 3 {
                        return Err("Codex 在发送前报告回合完成".into());
                    }
                    if self
                        .turn
                        .as_deref()
                        .is_some_and(|id| p["turn"]["id"].as_str() != Some(id))
                    {
                        return Ok(vec![]);
                    }
                    // 回合结束后异步提问的会话已不存在；卡片必须立刻失效。
                    for key in self.async_questions.keys() {
                        out.push(Action::Invalidate(key.clone()));
                    }
                    self.async_questions.clear();
                    self.pending.retain(|_, (_, method, _)| method != "asyncQuestion");
                    // 左边是 Codex 自己的协议字符串，右边才是 Forge 落盘的回合终态。
                    let (status, error) = match p["turn"]["status"].as_str() {
                        Some("completed") => (task_status::COMPLETED, None),
                        Some("interrupted") => (task_status::CANCELLED, None),
                        Some("failed") => (
                            task_status::FAILED,
                            Some(
                                p["turn"]["error"]["message"]
                                    .as_str()
                                    .unwrap_or("Codex 回合失败")
                                    .into(),
                            ),
                        ),
                        _ => return Err("Codex 返回未知终态，未确认执行结果".into()),
                    };
                    out.push(Action::Finish { status, error });
                }
                "error" => {
                    if p["willRetry"] != true {
                        return Err(p["error"]["message"]
                            .as_str()
                            .unwrap_or("Codex 运行失败")
                            .into());
                    }
                    out.push(Action::Emit {
                        kind: "retry",
                        data: p.clone(),
                    });
                }
                _ => {}
            }
            return Ok(out);
        }
        let Some(id) = message["id"].as_u64() else {
            return Err("Codex 返回无效协议帧".into());
        };
        // turn/steer 的回包只说明插话有没有被接住，不能当成握手响应。
        if self.steers.remove(&id) {
            if let Some(error) = message.get("error") {
                return Ok(vec![Action::Emit {
                    kind: "notice",
                    data: json!({"text":format!("Codex 未接受这次插话：{}", error["message"].as_str().unwrap_or("unknown"))}),
                }]);
            }
            return Ok(vec![]);
        }
        // MCP 快照的回包只投事件，不参与握手状态机。CLI 说没有就是没有，不猜。
        if self.mcp_probes.remove(&id) {
            if message.get("error").is_some() {
                self.mcp_ready = false;
                self.mcp_servers.clear();
                self.pending_mcp_status.clear();
                return Ok(vec![self.mcp_snapshot()]);
            }
            // 全量结果按权威处理：它是在同一刻问出来的，比之前收到的零散启动通知更完整。
            let mut servers = Vec::new();
            for server in message["result"]["data"].as_array().into_iter().flatten() {
                let Some(name) = server["name"].as_str().map(str::trim).filter(|name| !name.is_empty()) else { continue };
                // runtimeStatus 为 null 只说明 CLI 当下没连上或配置变了；名字仍要留，状态交给界面留空。
                servers.push(json!({"name":name,"status":server["runtimeStatus"]}));
            }
            self.mcp_servers = servers;
            if self.mcp_servers.is_empty() {
                self.mcp_ready = false;
                self.pending_mcp_status.clear();
                return Ok(vec![self.mcp_snapshot()]);
            }
            self.mcp_ready = true;
            for (name, status) in std::mem::take(&mut self.pending_mcp_status) {
                self.record_mcp_status(&name, &status);
            }
            return Ok(vec![self.mcp_snapshot()]);
        }
        // Goal 探测失败不影响聊天；成功时即使为空也要广播清除，防止前端残留旧快照。
        if self.goal_probes.remove(&id) {
            if message.get("error").is_some() {
                return Ok(vec![]);
            }
            let goal = message["result"].get("goal").cloned().unwrap_or(Value::Null);
            return Ok(vec![Action::Emit { kind: "goal", data: json!({"goal":goal}) }]);
        }
        // 写成功后再读一次完整 Goal；通知可能被旧版 CLI 漏掉，但 UI 仍必须拿权威快照。
        if self.goal_sets.remove(&id) {
            if let Some(error) = message.get("error") {
                return Ok(vec![Action::Emit {
                    kind: "notice",
                    data: json!({"text":format!("Goal 状态修改失败：{}", error["message"].as_str().unwrap_or("unknown"))}),
                }]);
            }
            let thread = self.thread.clone().ok_or("Codex Goal 缺少线程 ID")?;
            return Ok(vec![Action::Write(self.goal_probe(&thread))]);
        }
        if let Some(error) = message.get("error") {
            let text = error["message"].as_str().unwrap_or("unknown");
            // 复用会话时被另一个窗口或 CLI 占着写锁，Codex 只丢一句 "already has an active writer"，
            // 看着像账号或协议坏了。说出是谁挡的路、该怎么办，比转述一句英文错误有用。
            if text.contains("active writer") {
                return Err("这条 Codex 会话正被另一个窗口或 CLI 占着：关掉那边的会话，或等它这一轮跑完再发。".into());
            }
            return Err(format!("Codex 协议或账号错误：{text}"));
        }
        let result = message.get("result").ok_or("Codex 响应缺少结果")?;
        if self.stopped && self.phase < 3 { return Ok(vec![]); }
        match (self.phase, id) {
            (1, 1) => {
                self.phase = 2;
                let mut params = json!({"cwd":self.cwd});
                // 未显式选择时保留 CLI 的项目配置；信任项目不等于授予完全访问。
                if self.permission != super::options::PermissionMode::Inherit {
                    params["sandbox"] = json!(self.permission.codex_sandbox());
                    params["approvalPolicy"] = json!(self.permission.codex_policy());
                    params["approvalsReviewer"] = json!("user");
                }
                if let Some(model) = &self.model {
                    params["model"] = json!(model);
                }
                // Dynamic tools belong to the thread and can only be supplied at thread/start.
                // Existing native threads keep their original tool set when resumed.
                if self.thread.is_none() {
                    params["dynamicTools"] = Self::task_tools();
                }
                let method = if let Some(id) = &self.thread {
                    params["threadId"] = json!(id);
                    params["excludeTurns"] = json!(true);
                    "thread/resume"
                } else {
                    "thread/start"
                };
                Ok(vec![
                    Action::Write(json!({"method":"initialized","params":{}})),
                    Action::Write(json!({"id":2,"method":method,"params":params})),
                ])
            }
            (2, 2) => {
                if self.permission != super::options::PermissionMode::Inherit && (result["approvalPolicy"] != self.permission.codex_policy()
                    || result["approvalsReviewer"] != "user"
                    || result["sandbox"]["type"] != self.permission.codex_sandbox_type())
                {
                    return Err("Codex 未确认所要求的沙箱与人工审批策略，未发送消息".into());
                }
                let id = result["thread"]["id"]
                    .as_str()
                    .ok_or("Codex 未返回 thread ID")?
                    .to_string();
                if self.thread.as_ref().is_some_and(|old| old != &id) {
                    return Err("Codex 恢复到了不同会话".into());
                }
                self.thread = Some(id.clone());
                self.thread_model = result["model"].as_str().map(str::to_string);
                self.thread_effort = result["effort"].as_str()
                    .or_else(|| result["reasoningEffort"].as_str())
                    .map(str::to_string);
                let thread_plan_mode = result["collaborationMode"]["mode"].as_str()
                    .or_else(|| result["threadSettings"]["collaborationMode"]["mode"].as_str())
                    .map(|m| m == "plan")
                    .unwrap_or(false);
                self.thread_plan_mode = thread_plan_mode;
                if self.recovery_turn.is_some() {
                    // 恢复只查原回合并重新接收它的 live 通知；绝不能发 turn/start。
                    self.phase = 6;
                    return Ok(vec![
                        Action::Bind(id.clone()),
                        Action::Emit { kind: "configuration", data: json!({
                            "model":result["model"],"modelProvider":result["modelProvider"],
                            "approvalPolicy":result["approvalPolicy"],"sandbox":result["sandbox"],
                            "planMode":self.plan(),"mode":self.mode,"threadPlanMode":thread_plan_mode,
                        }) },
                        Action::Write(json!({"id":3,"method":"thread/turns/list","params":{
                            "threadId":id,"itemsView":"full","limit":16,"sortDirection":"desc"
                        }})),
                        Action::Write(self.mcp_probe(&id)),
                        Action::Write(self.goal_probe(&id)),
                    ]);
                }
                if self.decision.is_some() {
                    // 决策回合先重取最终计划条目，证明它仍在线且正文未变；
                    // 对不上就在开回合之前失败，绝不执行一份已经变过的计划。
                    self.phase = 4;
                    self.plan_pages = 1;
                    self.plan_cursors.clear();
                    return Ok(vec![
                        Action::Write(Self::plan_page(&id, None)),
                        Action::Write(self.goal_probe(&id)),
                    ]);
                }
                self.phase = 3;
                let mut input = vec![];
                if !self.prompt.trim().is_empty() { input.push(json!({"type":"text","text":self.prompt})); }
                input.extend(self.images.iter().map(|path| json!({"type":"localImage","path":path})));
                let mut turn = json!({"threadId":id,"input":input});
                self.apply_sandbox_policy(&mut turn);
                // 普通回合声明 experimentalApi:false，不能再偷带实验 collaborationMode。
                // 只有本轮明确进入计划模式时使用它；普通回合始终走稳定的顶层模型字段。
                if !self.plan() {
                    if let Some(model) = &self.model {
                        turn["model"] = json!(model);
                    }
                    if let Some(effort) = &self.effort {
                        turn["effort"] = json!(effort);
                    }
                } else {
                    turn["collaborationMode"] = Self::collaboration(
                        &self.mode,
                        self.model.as_deref().or(self.thread_model.as_deref()),
                        self.effort.as_deref(),
                    )?;
                }
                if !self.service_tier.is_empty() { turn["serviceTierForTurn"] = json!(self.service_tier); }
                let (method, params) = match self.command {
                    Some(super::commands::CommandIntent::CodexCompact) => ("thread/compact/start", json!({"threadId":id})),
                    Some(super::commands::CommandIntent::CodexReview) => {
                        let (_, instructions) = super::commands::parse(&self.prompt).ok_or("无效审查命令")?;
                        let target = if instructions.trim().is_empty() { json!({"type":"uncommittedChanges"}) }
                            else { json!({"type":"custom","instructions":instructions}) };
                        ("review/start", json!({"threadId":id,"delivery":"inline","target":target}))
                    }
                    Some(_) => return Err("Codex 不支持此命令类型".into()),
                    None => ("turn/start", turn),
                };
                Ok(vec![
                    Action::Bind(id.clone()),
                    Action::Emit {
                        kind: "configuration",
                        data: json!({
                            "model": result["model"],
                            "modelProvider": result["modelProvider"],
                            "approvalPolicy": result["approvalPolicy"],
                            "sandbox": result["sandbox"],
                            "planMode": self.plan(),
                            "mode": self.mode,
                            "threadPlanMode": thread_plan_mode,
                        }),
                    },
                    Action::Write(json!({"id":3,"method":method,"params":params})),
                    // 快照排在回合之后发：一台卡住的 MCP 服务不该把用户的消息挡在回合门口。
                    Action::Write(self.mcp_probe(&id)),
                    Action::Write(self.goal_probe(&id)),
                ])
            }
            (4, 3) => {
                let decision = self.decision.clone().ok_or("Codex 决策状态丢失")?;
                if !Self::check_plan(result, &decision.native_plan_id, &decision.content_hash)? {
                    let cursor = result["nextCursor"].as_str().map(str::trim).filter(|value| !value.is_empty())
                        .ok_or("codex plan is stale: 被审阅的计划已不在会话中")?.to_owned();
                    if self.plan_pages >= 64 || !self.plan_cursors.insert(cursor.clone()) {
                        return Err("codex plan is stale: 计划历史分页没有推进".into());
                    }
                    self.plan_pages += 1;
                    let thread = self.thread.as_deref().ok_or("Codex 决策缺少会话")?;
                    return Ok(vec![Action::Write(Self::plan_page(thread, Some(&cursor)))]);
                }
                let thread = self.thread.clone().ok_or("Codex 决策缺少会话")?;
                let mut turn = json!({"threadId":thread,"input":[{"type":"text","text":self.prompt}]});
                self.apply_sandbox_policy(&mut turn);
                // 显式选择优先；线程返回值只补未选择的模型/强度。
                turn["collaborationMode"] = Self::collaboration(
                    decision.mode,
                    self.model.as_deref().or(self.thread_model.as_deref()),
                    self.effort.as_deref().or(self.thread_effort.as_deref()),
                )?;
                if !self.service_tier.is_empty() { turn["serviceTierForTurn"] = json!(self.service_tier); }
                self.phase = 5;
                let thread_for_probe = thread.clone();
                Ok(vec![
                    Action::Write(json!({"id":4,"method":"turn/start","params":turn})),
                    // 决策回合同样是新进程，快照也要重新问一次，否则批准执行那一轮底部会空掉。
                    Action::Write(self.mcp_probe(&thread_for_probe)),
                ])
            }
            (6, 3) => {
                let expected = self.recovery_turn.clone().ok_or("Codex 恢复回合 ID 丢失")?;
                let recovered_turn = result["data"].as_array().into_iter().flatten()
                    .find(|turn| turn["id"].as_str() == Some(&expected))
                    .ok_or("Codex 原回合不在可恢复历史中")?.clone();
                self.turn = Some(expected.clone());
                let mut out = Vec::new();
                // turns/list 的 item 与实时 item/completed 使用同一 v2 结构；走同一解析器补齐断线期间的输出。
                for item in recovered_turn["items"].as_array().into_iter().flatten() {
                    out.extend(self.receive(json!({"method":"item/completed","params":{
                        "threadId":self.thread,"turnId":expected,"item":item
                    }}))?);
                }
                match recovered_turn["status"].as_str() {
                    Some("inProgress") => {}
                    Some("completed") => out.push(Action::Finish { status: task_status::COMPLETED, error: None }),
                    Some("interrupted") => out.push(Action::Finish { status: task_status::CANCELLED, error: None }),
                    Some("failed") => out.push(Action::Finish { status: task_status::FAILED, error: Some(
                        recovered_turn["error"]["message"].as_str().unwrap_or("Codex 原回合失败").into()
                    ) }),
                    _ => return Err("Codex 原回合状态无效".into()),
                }
                Ok(out)
            }
            (3, 3) | (5, 4) => {
                // Compaction acknowledgement is empty, not a completion signal.
                if self.command == Some(super::commands::CommandIntent::CodexCompact) { return Ok(vec![]); }
                if self.command == Some(super::commands::CommandIntent::CodexReview)
                    && result["reviewThreadId"].as_str() != self.thread.as_deref() {
                    return Err("Codex 审查返回了不同会话".into());
                }
                self.turn = Some(
                    result["turn"]["id"]
                        .as_str()
                        .ok_or("Codex 未返回 turn ID")?
                        .into(),
                );
                Ok(vec![Action::Emit {
                    kind: "turn",
                    data: json!({"nativeTurnId":self.turn}),
                }])
            }
            (_, 4) => Ok(vec![]),
            _ => Err("Codex 响应顺序或 ID 不匹配".into()),
        }
    }
    fn respond(&mut self, key: &str, answer: Value) -> Result<Vec<Action>, String> {
        if self.stopped {
            return Err("任务已停止".into());
        }
        let (id, method, params) = self.pending.get(key).cloned().ok_or("请求已失效")?;
        if method == "asyncQuestion" {
            let question = self.async_questions.get(key).cloned().ok_or("提问已失效")?;
            if self.stopped || self.turn.is_none() {
                return Err("当前回合已结束，无法再回答这次提问".into());
            }
            let answers = answer["answers"].as_object().ok_or("问题回答无效")?;
            if answers.len() != question.titles.len() {
                return Err("请回答所有问题".into());
            }
            let mut by_title = serde_json::Map::new();
            for (index, title) in &question.titles {
                let value = answers.get(index)
                    .and_then(Value::as_array)
                    .filter(|labels| !labels.is_empty() && labels.iter().all(Value::is_string))
                    .ok_or("问题答案无效")?;
                by_title.insert(title.clone(), json!(value));
            }
            let call_id = id.as_str().map(str::to_owned).unwrap_or_else(|| id.to_string());
            let message = format!(
                "The user answered your async question (call_id: {call_id}). Answers by question title: {}",
                Value::Object(by_title)
            );
            let steer = self.next_steer;
            self.next_steer += 1;
            self.steers.insert(steer);
            self.pending.remove(key);
            self.async_questions.remove(key);
            return Ok(vec![Action::Write(json!({
                "id":steer,"method":"turn/steer","params":{
                    "threadId":question.thread_id,
                    "expectedTurnId":question.turn_id,
                    "input":[{"type":"text","text":message}],
                }
            }))]);
        }
        let result = if method == "item/tool/requestUserInput" {
            let answers = answer["answers"].as_object().ok_or("问题回答无效")?;
            let questions = params["questions"].as_array().ok_or("问题格式无效")?;
            let mut response = serde_json::Map::new();
            if answers.len() != questions.len() {
                return Err("请回答所有问题".into());
            }
            for q in questions {
                let key = q["id"].as_str().ok_or("问题 ID 无效")?;
                let value = answers
                    .get(key)
                    .and_then(Value::as_array)
                    .filter(|a| !a.is_empty() && a.iter().all(Value::is_string))
                    .ok_or("问题答案无效")?;
                response.insert(key.into(), json!({"answers":value}));
            }
            json!({"answers":response})
        } else if method == "item/permissions/requestApproval" {
            // 授予位只吃「批准/不批准」：改过的入参和本地代答规则在这里都没有位置，
            // 出现了就整条拒掉，不能让一个看不懂的键换回一次沙箱放宽。
            if answer.get("input").is_some() || answer.get("remember").is_some() {
                return Err("权限扩大申请只能批准或拒绝，不支持改入参或让 Forge 代答".into());
            }
            let allow = answer["allow"].as_bool().ok_or("授权回答无效")?;
            // 批准原样发回 CLI 申请的那份；拒绝才是空授予集。
            let granted = if allow { params["permissions"].clone() } else { json!({}) };
            if granted.is_null() { return Err("Codex 未说明要申请什么权限".into()); }
            json!({ "permissions": granted })
        } else {
            // Codex 的授权答复只有 accept/decline 一个决定位，没有放「改过的入参」的地方。
            // 答应了改却照原样执行，比压根不给这个按钮更危险，所以这里拒收。
            if answer.get("input").is_some() {
                return Err("Codex 不支持改完再允许；如需修改请在 CLI 侧调整后重新批准".into());
            }
            let allow = answer["allow"].as_bool().ok_or("授权回答无效")?;
            if allow
                && params["availableDecisions"]
                    .as_array()
                    .is_some_and(|v| !v.contains(&json!("accept")))
            {
                return Err("当前请求不支持仅允许一次".into());
            }
            json!({"decision":if allow {"accept"} else {"decline"}})
        };
        let response = Action::Write(json!({"id":id,"result":result}));
        self.pending.remove(key);
        Ok(vec![response])
    }
    fn set_goal_status(&mut self, status: &str) -> Result<Vec<Action>, String> {
        if !matches!(status, "active" | "paused") {
            return Err("Goal 状态只允许 active 或 paused".into());
        }
        let thread = self.thread.as_deref().ok_or("Codex Goal 缺少线程 ID")?;
        let id = self.next_goal_set;
        self.next_goal_set += 1;
        self.goal_sets.insert(id);
        Ok(vec![Action::Write(json!({
            "id":id,
            "method":"thread/goal/set",
            "params":{"threadId":thread,"status":status,"origin":"user"}
        }))])
    }
    fn interrupt(&mut self) -> Vec<Action> {
        self.stopped = true;
        self.pending.clear();
        self.async_questions.clear();
        self.steers.clear();
        match (&self.thread, &self.turn) {
            (Some(thread), Some(turn)) => vec![Action::Write(
                json!({"id":4,"method":"turn/interrupt","params":{"threadId":thread,"turnId":turn}}),
            )],
            _ => vec![],
        }
    }
    fn turn_started(&self) -> bool { self.turn.is_some() }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sub_agent_activity_items_become_agent_events() {
        let mut p = Codex::new("root".into(), "派活".into(), Some("native".into()));
        p.start().unwrap();
        p.receive(json!({"id":1,"result":{}})).unwrap();
        p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"}}})).unwrap();
        p.receive(json!({"id":3,"result":{"turn":{"id":"turn-1"}}})).unwrap();
        // spawn_agent 的 task_name 是真实展示名；started 活动会用同一个 call id 把它接回。
        p.receive(json!({"method":"item/started","params":{"threadId":"native","item":{
            "id":"call_spawn","type":"dynamicToolCall","tool":"spawn_agent","arguments":{"task_name":"review_backend"},
            "status":"running"
        }}})).unwrap();
        // started 活动（item/completed 承载）→ running；agentPath 提供任务名与可寻址名，
        // 随机 agentNickname 不能泄漏成用户看到的标题或类型。
        let started = p.receive(json!({"method":"item/completed","params":{"threadId":"native","item":{
            "id":"call_spawn","type":"subAgentActivity","kind":"started","model":"gpt-6-astra","reasoningEffort":"medium",
            "agentThreadId":"01a16be3-child","agentPath":"/root/backend_trace","agentNickname":"Lorentz"
        }}})).unwrap();
        assert!(started.iter().any(|a| matches!(a, Action::Emit{kind:"agent",data}
            if data["key"] == "01a16be3-child" && data["status"] == "running"
                && data["agentId"] == "/root/backend_trace" && data["title"] == "review backend"
                && data.get("agentType").is_none() && data["model"] == "gpt-6-astra")));
        // completed 活动 → completed 终态。
        let done = p.receive(json!({"method":"item/completed","params":{"threadId":"native","item":{
            "id":"subagent-completed-turn-1","type":"subAgentActivity","kind":"completed",
            "agentThreadId":"01a16be3-child","agentPath":"/root/backend_trace"
        }}})).unwrap();
        assert!(done.iter().any(|a| matches!(a, Action::Emit{kind:"agent",data}
            if data["key"] == "01a16be3-child" && data["status"] == "completed")));
        // 未知活动类型与 item/started（未完成）不产事件。
        assert!(p.receive(json!({"method":"item/completed","params":{"threadId":"native","item":{
            "id":"call_x","type":"subAgentActivity","kind":"mystery","agentThreadId":"t"
        }}})).unwrap().iter().all(|a| !matches!(a, Action::Emit{kind:"agent",..})));
        assert!(p.receive(json!({"method":"item/started","params":{"threadId":"native","item":{
            "id":"call_spawn2","type":"subAgentActivity","kind":"started","agentThreadId":"t2"
        }}})).unwrap().iter().all(|a| !matches!(a, Action::Emit{kind:"agent",..})));
        // rollout 的 snake_case 字段做兼容。
        let snake = p.receive(json!({"method":"item/completed","params":{"threadId":"native","item":{
            "id":"call_spawn3","type":"SubAgentActivity","kind":"started",
            "agent_thread_id":"01a1-snake","agent_path":"/root/snake"
        }}})).unwrap();
        assert!(snake.iter().any(|a| matches!(a, Action::Emit{kind:"agent",data}
            if data["key"] == "01a1-snake" && data["title"] == "snake")));
        // 没有任务名、路径或角色时宁可显示稳定通用名，也不能显示随机 nickname。
        let unnamed = p.receive(json!({"method":"item/completed","params":{"threadId":"native","item":{
            "id":"call_spawn4","type":"subAgentActivity","kind":"started",
            "agentThreadId":"01a1-unnamed","agentNickname":"Kepler"
        }}})).unwrap();
        assert!(unnamed.iter().any(|a| matches!(a, Action::Emit{kind:"agent",data}
            if data["key"] == "01a1-unnamed" && data["title"] == "子代理" && data.get("agentType").is_none())));
    }
    #[test]
    fn turn_is_started_only_after_codex_accepts_the_native_turn() {
        let mut protocol = Codex::new("root".into(), "hi".into(), Some("native".into()));
        protocol.start().unwrap();
        assert!(!protocol.turn_started());
        // initialize 和 thread/resume 只证明进程可用，不能把消息提前标成 running。
        protocol.receive(json!({"id":1,"result":{}})).unwrap();
        assert!(!protocol.turn_started());
        protocol.receive(json!({"id":2,"result":{"thread":{"id":"native"},"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"}}})).unwrap();
        assert!(!protocol.turn_started());
        protocol.receive(json!({"id":3,"result":{"turn":{"id":"turn-1"}}})).unwrap();
        assert!(protocol.turn_started());
    }
    #[test]
    fn pasted_images_use_native_local_image_inputs() {
        let mut protocol = Codex::new("root".into(), "".into(), Some("native".into()))
            .with_images(vec![r"C:\cache\one.png".into(), r"C:\cache\two.webp".into()]);
        protocol.start().unwrap();
        protocol.receive(json!({"id":1,"result":{}})).unwrap();
        let actions = protocol.receive(json!({"id":2,"result":{"thread":{"id":"native"},"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"}}})).unwrap();
        let input = actions.iter().find_map(|action| match action {
            Action::Write(value) if value["method"] == "turn/start" => value["params"]["input"].as_array(),
            _ => None,
        }).unwrap();
        assert_eq!(input, &vec![
            json!({"type":"localImage","path":r"C:\cache\one.png"}),
            json!({"type":"localImage","path":r"C:\cache\two.webp"}),
        ]);
    }
    #[test]
    fn granted_directories_travel_in_the_turn_sandbox_policy() {
        let policy = json!({"type":"workspaceWrite","writableRoots":["D:\\extra"]});
        let mut protocol = Codex::new("root".into(), "写进去".into(), Some("native".into()))
            .with_sandbox_policy(Some(policy.clone()));
        protocol.start().unwrap();
        protocol.receive(json!({"id":1,"result":{}})).unwrap();
        let actions = protocol.receive(json!({"id":2,"result":{"thread":{"id":"native"},"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"}}})).unwrap();
        let turn = actions.iter().find_map(|action| match action {
            Action::Write(value) if value["method"] == "turn/start" => Some(value["params"].clone()),
            _ => None,
        }).unwrap();
        assert_eq!(turn["sandboxPolicy"], policy);
        // 规划回合不动工作区，可写根目录也不该跟着发过去。
        let mut planning = Codex::new("root".into(), "先出计划".into(), Some("native".into()))
            .with_sandbox_policy(Some(policy)).with_mode("plan".into());
        planning.start().unwrap();
        planning.receive(json!({"id":1,"result":{}})).unwrap();
        let actions = planning.receive(json!({"id":2,"result":{"thread":{"id":"native"},"model":"gpt-5","approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"}}})).unwrap();
        let turn = actions.iter().find_map(|action| match action {
            Action::Write(value) if value["method"] == "turn/start" => Some(value["params"].clone()),
            _ => None,
        }).unwrap();
        assert!(turn.get("sandboxPolicy").is_none());
    }
    #[test]
    fn declined_items_name_the_tool_and_the_file_they_wanted() {
        let mut p = Codex::new("root".into(), "改文件".into(), Some("native".into()));
        p.start().unwrap();
        p.receive(json!({"id":1,"result":{}})).unwrap();
        p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"}}})).unwrap();
        p.receive(json!({"id":3,"result":{"turn":{"id":"turn-1"}}})).unwrap();
        let actions = p.receive(json!({"method":"item/completed","params":{"threadId":"native","item":{
            "id":"patch","type":"fileChange","status":"declined",
            "changes":{"D:\\outside\\a.ts":{"type":"add","unified_diff":"@@ -0 +1 @@\n+a"}}
        }}})).unwrap();
        assert!(matches!(&actions[0], Action::Emit{kind:"permission_denied", data}
            if data["tool"] == "apply_patch" && data["path"] == "D:\\outside\\a.ts"));
        // 命令没有文件可指：提示照给，但不给一个点了会报错的目录按钮。
        let actions = p.receive(json!({"method":"item/completed","params":{"threadId":"native","item":{
            "id":"exec","type":"commandExecution","status":"declined","command":"rm -rf /tmp/x"
        }}})).unwrap();
        assert!(matches!(&actions[0], Action::Emit{kind:"permission_denied", data}
            if data["tool"] == "exec" && data["text"] == "rm -rf /tmp/x" && data.get("path").is_none()));
    }
    #[test]
    fn reasoning_falls_back_to_the_raw_trace_only_when_there_is_no_summary() {
        let mut p = Codex::new("root".into(), "想想".into(), Some("native".into()));
        p.start().unwrap();
        p.receive(json!({"id":1,"result":{}})).unwrap();
        p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"}}})).unwrap();
        p.receive(json!({"id":3,"result":{"turn":{"id":"turn-1"}}})).unwrap();
        // 有摘要：只显示摘要那几段，绝不把同一段轨迹再发一遍。
        let actions = p.receive(json!({"method":"item/completed","params":{"threadId":"native","item":{
            "id":"r1","type":"reasoning","summary":["第一段","第二段"],"content":["轨迹一","轨迹二"]
        }}})).unwrap();
        let texts = actions.iter().filter_map(|action| match action {
            Action::Emit { kind: "reasoning", data } => Some(data["text"].as_str().unwrap_or("").to_owned()),
            _ => None,
        }).collect::<Vec<_>>();
        assert_eq!(texts, vec!["第一段".to_owned(), "第二段".to_owned()]);
        // 没摘要（部分模型与配置就是不发）：整卡不该空着，退回 content 原文。
        let actions = p.receive(json!({"method":"item/completed","params":{"threadId":"native","item":{
            "id":"r2","type":"reasoning","summary":[],"content":["只有轨迹"]
        }}})).unwrap();
        assert!(actions.iter().any(|action| matches!(action,
            Action::Emit { kind: "reasoning", data } if data["text"] == "只有轨迹" && data["id"] == "r2-0")));
    }
    #[test]
    fn mcp_snapshot_stays_one_table_across_probe_and_startup_updates() {
        let mut p = Codex::new("root".into(), "跑一下".into(), Some("native".into()));
        p.start().unwrap();
        p.receive(json!({"id":1,"result":{}})).unwrap();
        let actions = p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"}}})).unwrap();
        let methods = actions.iter().filter_map(|action| match action {
            Action::Write(value) => value["method"].as_str().map(str::to_owned),
            _ => None,
        }).collect::<Vec<_>>();
        // 探测排在回合之后：一台卡住的 MCP 服务不该挡在用户消息门口。
        assert_eq!(methods, vec!["turn/start".to_owned(), "mcpServerStatus/list".to_owned(), "thread/goal/get".to_owned()]);
        let probe = actions.iter().find_map(|action| match action {
            Action::Write(value) if value["method"] == "mcpServerStatus/list" => value["id"].as_u64(),
            _ => None,
        }).expect("回合起来后必须问一次 MCP 快照");
        assert_eq!(actions.iter().find_map(|action| match action {
            Action::Write(value) if value["id"] == json!(probe) => Some(value["params"]["detail"].as_str()),
            _ => None,
        }), Some(Some("toolsAndAuthOnly")), "只要名字与状态，不拉工具清单");
        // 完整列表之前到达的通知只能缓存，不能拿一台服务器冒充全表。
        let early = p.receive(json!({"method":"mcpServer/startupStatus/updated","params":{"threadId":"native","name":"b","status":"failed"}})).unwrap();
        assert!(early.is_empty());
        let actions = p.receive(json!({"id":probe,"result":{"data":[
            {"name":"a","runtimeStatus":"connected"},{"name":"b","runtimeStatus":null}
        ]}})).unwrap();
        assert!(matches!(&actions[0], Action::Emit{kind:"mcp_servers",data} if data["servers"] == json!([
            {"name":"a","status":"connected"},{"name":"b","status":"failed"}
        ])), "完整列表到达后才应用早到的状态更新");
        // 启动通知只改一台：整张表必须还是两张。
        let actions = p.receive(json!({"method":"mcpServer/startupStatus/updated","params":{"threadId":"native","name":"b","status":"failed"}})).unwrap();
        assert!(matches!(&actions[0], Action::Emit{kind:"mcp_servers",data}
            if data["servers"].as_array().is_some_and(|list| list.len() == 2) && data["servers"][1]["status"] == "failed"));
    }
    #[test]
    fn a_failed_or_empty_mcp_probe_clears_old_state_without_leaking_partial_updates() {
        for reply in [json!({"error":{"code":-32601,"message":"unknown method"}}), json!({"result":{"data":[]}})] {
            let mut p = Codex::new("root".into(), "跑一下".into(), Some("native".into()));
            p.start().unwrap();
            p.receive(json!({"id":1,"result":{}})).unwrap();
            let actions = p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"}}})).unwrap();
            let probe = actions.iter().find_map(|action| match action {
                Action::Write(value) if value["method"] == "mcpServerStatus/list" => value["id"].as_u64(),
                _ => None,
            }).unwrap();
            assert!(p.receive(json!({"method":"mcpServer/startupStatus/updated","params":{"threadId":"native","name":"partial","status":"connected"}})).unwrap().is_empty());
            // 探测失败或报空：显式清空前端旧快照，但绝不能把缓存的一台服务器带出去。
            let mut message = json!({"id":probe});
            for (key, value) in reply.as_object().unwrap() { message[key] = value.clone(); }
            let actions = p.receive(message).unwrap();
            assert!(matches!(&actions[..], [Action::Emit{kind:"mcp_servers",data}] if data["servers"] == json!([])));
        }
    }
    #[test]
    fn patch_updates_and_interrupted_commands_keep_their_real_status_and_data() {
        let (mut p, _) = ready_command("/compact", super::super::commands::CommandIntent::CodexCompact);
        let changes = json!([{"path":"a.ts","kind":{"type":"update","move_path":"b.ts"},"diff":"@@ -1 +1 @@\n-a\n+b"}]);
        let actions = p.receive(json!({"method":"item/fileChange/patchUpdated","params":{"threadId":"native","itemId":"patch","changes":changes}})).unwrap();
        assert!(actions.iter().any(|a| matches!(a, Action::Emit{kind:"tool",data} if data["id"] == "patch" && data["inputPatch"]["changes"] == changes)));
        let actions = p.receive(json!({"method":"item/fileChange/outputDelta","params":{"threadId":"native","itemId":"patch","delta":"applying"}})).unwrap();
        assert!(actions.iter().any(|a| matches!(a, Action::Emit{kind:"tool",data} if data["outputDelta"] == "applying")));
        let actions = p.receive(json!({"method":"item/completed","params":{"threadId":"native","item":{"id":"cmd","type":"commandExecution","command":"npm test","status":"interrupted"}}})).unwrap();
        assert!(actions.iter().any(|a| matches!(a, Action::Emit{kind:"tool",data} if data["status"] == "cancelled" && data["input"]["command"] == "npm test")));
    }
    #[test]
    fn completed_file_change_emits_paths_from_the_native_change_map() {
        let mut p = Codex::new("root".into(), "改文件".into(), Some("native".into()));
        let actions = p.receive(json!({"method":"item/completed","params":{"threadId":"native","item":{
            "id":"patch","type":"fileChange","status":"completed",
            "changes":{"src/a.ts":{"type":"update","unified_diff":"@@ -1 +1 @@\n-a\n+b"},"src/b.ts":{"type":"add","unified_diff":"@@ -0 +1 @@\n+b"}}
        }}})).unwrap();
        assert!(actions.iter().any(|action| matches!(action, Action::Emit { kind: "files", data }
            if data["paths"] == json!(["src/a.ts", "src/b.ts"]))));
    }
    fn ready_command(prompt: &str, intent: super::super::commands::CommandIntent) -> (Codex, Vec<Action>) {
        let mut p = Codex::new("root".into(), prompt.into(), Some("native".into())).with_command(Some(intent));
        p.start().unwrap(); p.receive(json!({"id":1,"result":{}})).unwrap();
        let actions = p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"}}})).unwrap();
        (p, actions)
    }
    #[test]
    fn compact_uses_rpc_and_waits_for_turn_completion_not_ack_or_item() {
        let (mut p, actions) = ready_command("/compact", super::super::commands::CommandIntent::CodexCompact);
        assert!(actions.iter().any(|a| matches!(a, Action::Write(v) if v["method"] == "thread/compact/start" && v["params"] == json!({"threadId":"native"}))));
        assert!(!actions.iter().any(|a| matches!(a, Action::Write(v) if v["method"] == "turn/start")));
        assert!(p.receive(json!({"id":3,"result":{}})).unwrap().is_empty());
        p.receive(json!({"method":"item/started","params":{"threadId":"native","turnId":"compact-turn","item":{"id":"compaction","type":"contextCompaction"}}})).unwrap();
        assert_eq!(p.turn.as_deref(), Some("compact-turn"));
        let actions = p.receive(json!({"method":"item/completed","params":{"threadId":"native","item":{"id":"compaction","type":"contextCompaction"}}})).unwrap();
        assert!(!actions.iter().any(|a| matches!(a, Action::Finish{..})));
        let actions = p.receive(json!({"method":"turn/completed","params":{"threadId":"native","turn":{"id":"compact-turn","status":"completed"}}})).unwrap();
        assert!(matches!(&actions[0], Action::Finish{status:"completed",..}));
    }
    #[test]
    fn review_maps_full_arguments_and_returns_review_output() {
        for (prompt, expected) in [
            ("/review", json!({"type":"uncommittedChanges"})),
            ("/review \t\n", json!({"type":"uncommittedChanges"})),
            ("/review 检查 \"a b\"\n换行", json!({"type":"custom","instructions":"检查 \"a b\"\n换行"})),
            ("/review  \"a b\"\n第二行  ", json!({"type":"custom","instructions":" \"a b\"\n第二行  "})),
            ("/review\t\t检查\r\n下一行", json!({"type":"custom","instructions":"\t检查\r\n下一行"})),
            ("/review\u{3000}检查", json!({"type":"custom","instructions":"检查"})),
            ("/review --base main --commit abc", json!({"type":"custom","instructions":"--base main --commit abc"})),
            ("/review C:\\work\\file.ts; $(echo literal)", json!({"type":"custom","instructions":"C:\\work\\file.ts; $(echo literal)"})),
        ] {
            let (mut p, actions) = ready_command(prompt, super::super::commands::CommandIntent::CodexReview);
            assert!(actions.iter().any(|a| matches!(a, Action::Write(v) if v["method"] == "review/start" && v["params"]["delivery"] == "inline" && v["params"]["target"] == expected && v["params"].get("serviceTierForTurn").is_none())));
            p.receive(json!({"id":3,"result":{"reviewThreadId":"native","turn":{"id":"review-turn"}}})).unwrap();
            let actions = p.receive(json!({"method":"item/completed","params":{"threadId":"native","item":{"id":"review","type":"exitedReviewMode","review":"review result"}}})).unwrap();
            assert!(matches!(&actions[0], Action::Emit{kind:"message",data} if data["text"] == "review result"));
        }
    }
    #[test]
    fn stop_during_handshake_prevents_new_thread_or_turn() {
        let mut p = Codex::new("root".into(), "hello".into(), None);
        p.start().unwrap(); p.interrupt();
        assert!(p.receive(json!({"id":1,"result":{}})).unwrap().is_empty());
        let mut p = Codex::new("root".into(), "hello".into(), None);
        p.start().unwrap(); p.receive(json!({"id":1,"result":{}})).unwrap(); p.interrupt();
        assert!(p.receive(json!({"id":2,"result":{"thread":{"id":"native"}}})).unwrap().is_empty());
    }
    #[test]
    fn inherited_project_configuration_does_not_send_default_overrides() {
        let mut p = Codex::new("root".into(), "hello".into(), None)
            .with_policy(super::super::options::PermissionMode::Inherit, String::new());
        let init = p.start().unwrap();
        assert!(matches!(&init[0], Action::Write(value) if value["params"]["capabilities"]["experimentalApi"] == true));
        let actions = p.receive(json!({"id":1,"result":{}})).unwrap();
        let params = actions.iter().find_map(|a| match a { Action::Write(v) if v["method"] == "thread/start" => Some(&v["params"]), _ => None }).unwrap();
        assert_eq!(params["cwd"], "root");
        assert!(params.get("model").is_none() && params.get("sandbox").is_none() && params.get("approvalPolicy").is_none());
        assert_eq!(params["dynamicTools"][0]["name"], TASK_TOOL_NAMESPACE);
        assert_eq!(params["dynamicTools"][0]["tools"][0]["name"], TASK_TOOL_NAME);
        let actions = p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"model":"configured","approvalPolicy":"never","sandbox":{"type":"readOnly"}}})).unwrap();
        let params = actions.iter().find_map(|a| match a { Action::Write(v) if v["method"] == "turn/start" => Some(&v["params"]), _ => None }).unwrap();
        assert!(params.get("serviceTierForTurn").is_none());
        assert!(params.get("model").is_none());
        assert!(params.get("effort").is_none());
    }

    #[test]
    fn forge_precreated_thread_enables_the_experimental_task_tool_contract() {
        // 工具已在预创建 thread/start 注册；首次发送走 resume 时仍须启用同一实验协议面。
        let mut protocol = Codex::new("root".into(), "执行三个任务".into(), Some("native".into()));
        let init = protocol.start().unwrap();
        assert!(matches!(&init[0], Action::Write(value)
            if value["params"]["capabilities"]["experimentalApi"] == true));
        let actions = protocol.receive(json!({"id":1,"result":{}})).unwrap();
        let params = actions.iter().find_map(|action| match action {
            Action::Write(value) if value["method"] == "thread/resume" => Some(&value["params"]),
            _ => None,
        }).expect("Forge 预创建线程首次发送必须走 resume");
        assert!(params.get("dynamicTools").is_none(), "resume 不支持重新注册线程工具");
    }

    #[test]
    fn selected_model_and_effort_are_sent_and_only_public_summary_is_exposed() {
        let mut p = Codex::new("root".into(), "hi".into(), None)
            .with_options(Some("chosen".into()), Some("high".into()));
        p.start().unwrap();
        let actions = p.receive(json!({"id":1,"result":{}})).unwrap();
        assert!(actions
            .iter()
            .any(|a| matches!(a,Action::Write(v) if v["params"]["model"]=="chosen")));
        let actions=p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"model":"chosen","sandbox":{"type":"workspaceWrite"},"approvalPolicy":"on-request","approvalsReviewer":"user"}})).unwrap();
        assert!(actions.iter().any(|a| matches!(a,Action::Write(v) if v["method"]=="turn/start" && v["params"]["model"]=="chosen" && v["params"]["effort"]=="high")));
        let actions=p.receive(json!({"method":"item/reasoning/summaryTextDelta","params":{"threadId":"native","itemId":"r","summaryIndex":0,"delta":"public"}})).unwrap();
        assert!(
            matches!(&actions[0],Action::Emit{kind:"reasoning_delta",data} if data["text"]=="public")
        );
        let actions=p.receive(json!({"method":"item/completed","params":{"threadId":"native","item":{"id":"r","type":"reasoning","summary":["public"],"content":["hidden"]}}})).unwrap();
        assert!(
            matches!(&actions[0],Action::Emit{kind:"reasoning",data} if data["text"]=="public" && !data.to_string().contains("hidden"))
        );
    }
    #[test]
    fn selected_permissions_and_speed_are_sent_and_verified() {
        use super::super::options::PermissionMode;
        for permission in [PermissionMode::Read, PermissionMode::Ask, PermissionMode::Auto, PermissionMode::Full] {
            for tier in ["default", "catalog-fast-id"] {
                let mut p = Codex::new("root".into(), "hello".into(), None).with_policy(permission, tier.into());
                p.start().unwrap();
                let out = p.receive(json!({"id":1,"result":{}})).unwrap();
                assert!(out.iter().any(|a| matches!(a, Action::Write(v) if v["params"]["sandbox"] == permission.codex_sandbox() && v["params"]["approvalPolicy"] == permission.codex_policy())));
                let out = p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"approvalPolicy":permission.codex_policy(),"approvalsReviewer":"user","sandbox":{"type":permission.codex_sandbox_type()}}})).unwrap();
                assert!(out.iter().any(|a| matches!(a, Action::Write(v) if v["method"] == "turn/start" && v["params"]["serviceTierForTurn"] == tier)));
            }
        }
        let mut p = Codex::new("root".into(), "hello".into(), None).with_policy(PermissionMode::Auto, "default".into());
        p.start().unwrap(); p.receive(json!({"id":1,"result":{}})).unwrap();
        assert!(p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"dangerFullAccess"}}})).is_err());
    }
    #[test]
    fn handshake_resume_and_safe_policy() {
        let mut p = Codex::new("root".into(), "中文😀".into(), Some("native".into()));
        p.start().unwrap();
        let out = p.receive(json!({"id":1,"result":{}})).unwrap();
        assert!(
            matches!(&out[1],Action::Write(v) if v["method"]=="thread/resume"&&v["params"]["sandbox"]=="workspace-write"&&v["params"]["approvalPolicy"]=="on-request")
        );
        assert!(p.receive(json!({"id":2,"result":{"thread":{"id":"different"},"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"}}})).is_err());
    }
    #[test]
    fn unexpected_sandbox_or_automatic_reviewer_prevents_turn_start() {
        for (sandbox, reviewer) in [
            ("dangerFullAccess", "user"),
            ("workspaceWrite", "auto_review"),
        ] {
            let mut p = Codex::new("root".into(), "hi".into(), None);
            p.start().unwrap();
            p.receive(json!({"id":1,"result":{}})).unwrap();
            assert!(p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"approvalPolicy":"on-request","approvalsReviewer":reviewer,"sandbox":{"type":sandbox}}})).is_err());
        }
    }
    #[test]
    fn user_answers_and_extra_permissions_are_fail_closed() {
        let mut p = Codex::new("root".into(), "hi".into(), None);
        p.receive(json!({"id":"q","method":"item/tool/requestUserInput","params":{"questions":[{"id":"language","question":"语言？"}]}})).unwrap();
        assert!(p.respond("\"q\"", json!({"allow":true})).is_err());
        let out = p
            .respond("\"q\"", json!({"answers":{"language":["中文"]}}))
            .unwrap();
        assert!(
            matches!(&out[0],Action::Write(v) if v["result"]["answers"]["language"]["answers"][0]=="中文")
        );
        // 扩权限不再「一个权限都不给」地静默拒绝：它先问用户（授予内容见 permission_widening_…），
        // 这条守的是另一半——没等到答复之前，绝不擅自写出任何授予。
        let out=p.receive(json!({"id":20,"method":"item/permissions/requestApproval","params":{"permissions":{"network":{"enabled":true}}}})).unwrap();
        assert!(matches!(&out[0],Action::Request{kind:"permission",..}));
        assert!(!out.iter().any(|action| matches!(action, Action::Write(_))), "没等到答复就回授予，等于替用户点允许");
    }
    #[test]
    fn resolved_requests_and_failed_tools_do_not_appear_approved_or_successful() {
        let mut p = Codex::new("root".into(), "hi".into(), None);
        p.receive(json!({"id":"approval","method":"item/fileChange/requestApproval","params":{}}))
            .unwrap();
        p.receive(json!({"method":"serverRequest/resolved","params":{"requestId":"approval"}}))
            .unwrap();
        assert!(p.respond("\"approval\"", json!({"allow":true})).is_err());
        let out=p.receive(json!({"method":"item/completed","params":{"item":{"type":"commandExecution","id":"cmd","status":"completed","exitCode":1}}})).unwrap();
        assert!(matches!(&out[0],Action::Emit{kind:"tool",data} if data["status"]=="failed"));
        for item in [
            json!({"type":"dynamicToolCall","id":"dynamic","status":"completed","success":false}),
            json!({"type":"mcpToolCall","id":"mcp","status":"completed","error":{"message":"boom"}}),
        ] {
            let out = p.receive(json!({"method":"item/completed","params":{"item":item}})).unwrap();
            assert!(matches!(&out[0],Action::Emit{kind:"tool",data} if data["status"]=="failed"));
        }
    }
    #[test]
    fn denial_is_one_shot_and_unknown_requests_fail_closed() {
        let mut p = Codex::new("root".into(), "text".into(), None);
        p.receive(json!({"id":"request","method":"item/commandExecution/requestApproval","params":{"command":"test"}})).unwrap();
        let a = p.respond("\"request\"", json!({"allow":false})).unwrap();
        assert!(matches!(&a[0],Action::Write(v) if v["result"]["decision"]=="decline"));
        assert!(p.respond("\"request\"", json!({"allow":true})).is_err());
        // 「改完再允许」在 Codex 这儿没有落点：请求还活着时也必须拒收，不能答应改了却照原样跑。
        p.receive(json!({"id":"editable","method":"item/commandExecution/requestApproval","params":{"command":"ls"}})).unwrap();
        assert!(p.respond("\"editable\"", json!({"allow":true,"input":{"command":"ls -l"}})).is_err());
        assert!(p.respond("\"editable\"", json!({"allow":true})).is_ok());
        let unknown = p.receive(json!({"id":10,"method":"unknown","params":{}})).unwrap();
        assert!(matches!(&unknown[1],Action::Write(v) if v.get("error").is_some()));
        // 拒绝照旧失败关闭，但现在会先在时间线上说一声，不再悄悄替用户决定。
        assert!(matches!(&unknown[0],Action::Emit{kind:"notice",data} if data["auto"]=="declined" && !data["text"].as_str().unwrap_or_default().is_empty()));
    }
    #[test]
    fn silently_refused_requests_now_appear_in_the_timeline() {
        // MCP 服务想追加一轮提问仍然代拒：那不是 Codex 自己的权限请求，Forge 更答不了。
        let mut p = Codex::new("root".into(), "text".into(), None);
        let actions = p.receive(json!({"id":7,"method":"mcpServer/elicitation/request","params":{"message":"需要额外授权"}})).unwrap();
        assert!(matches!(&actions[0],Action::Emit{kind:"notice",data} if data["auto"]=="declined"), "elicitation 没有说明被拒");
        assert!(matches!(&actions[1],Action::Write(v) if v["id"] == json!(7)), "elicitation 没有回信");
        // 认不出的授权类型照样按不授予处理，但一定有回信：沉默会把整轮死锁。
        let mut p = Codex::new("root".into(), "text".into(), None);
        let actions = p.receive(json!({"id":9,"method":"approval/unknown","params":{}})).unwrap();
        assert!(matches!(&actions[0],Action::Emit{kind:"notice",data} if data["auto"]=="declined"));
        assert!(matches!(&actions[1],Action::Write(v) if v["error"]["code"] == -32601));
    }

    #[test]
    fn permission_widening_becomes_a_card_and_approving_grants_exactly_the_ask() {
        let params = json!({"reason":"需要写到工作区外","permissions":{
            "fileSystem":{"entries":[{"access":"write","path":{"type":"path","path":"D:\\outside"}}]},
            "network":{"enabled":true}
        }});
        let ask = |params: &Value| -> (String, Value) {
            let mut p = Codex::new("root".into(), "text".into(), None);
            let actions = p.receive(json!({"id":7,"method":"item/permissions/requestApproval","params":params.clone()})).unwrap();
            match &actions[0] {
                Action::Request { key, kind, data } => { assert_eq!(*kind, "permission"); (key.clone(), data.clone()) }
                other => panic!("扩权限申请必须变成可答复的卡片，实际是 {other:?}"),
            }
        };
        let (key, data) = ask(&params);
        // 卡片要说清「批准等于给什么」，而不是让用户自己读 JSON。
        assert_eq!(data["reason"], json!("需要写到工作区外（申请授予：文件系统：write D:\\outside；联网）"));
        // 没有工具名 → 界面不会出现「本轮不再询问」：Forge 不替 CLI 记住越权。
        assert_eq!(data["toolName"], json!(""));
        assert_eq!(data["canEdit"], json!(false));
        // 批准 = 原样授予它申请的那份，不加宽也不翻译。
        let mut p = Codex::new("root".into(), "text".into(), None);
        p.receive(json!({"id":7,"method":"item/permissions/requestApproval","params":params.clone()})).unwrap();
        let actions = p.respond(&key, json!({"allow":true})).unwrap();
        assert!(matches!(&actions[0], Action::Write(v) if v["result"]["permissions"] == params["permissions"]));
        // 拒绝才是空授予集。
        let mut p = Codex::new("root".into(), "text".into(), None);
        p.receive(json!({"id":7,"method":"item/permissions/requestApproval","params":params.clone()})).unwrap();
        let actions = p.respond(&key, json!({"allow":false})).unwrap();
        assert!(matches!(&actions[0], Action::Write(v) if v["result"]["permissions"].as_object().is_some_and(|map| map.is_empty())));
        // 「让 Forge 代答下一次」在这里没有位置：出现了就整条拒掉，换一个看不懂的键不该换来一次沙箱放宽。
        let mut p = Codex::new("root".into(), "text".into(), None);
        p.receive(json!({"id":7,"method":"item/permissions/requestApproval","params":params.clone()})).unwrap();
        assert!(p.respond(&key, json!({"allow":true,"remember":{"tool":"request_permissions"}})).is_err());
    }

    fn started_thread(p: &mut Codex) {
        p.start().unwrap();
        p.receive(json!({"id":1,"result":{}})).unwrap();
        p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"model":"gpt-5","approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"}}})).unwrap();
        p.receive(json!({"id":3,"result":{"turn":{"id":"turn-1"}}})).unwrap();
    }

    #[test]
    fn plan_turn_uses_collaboration_mode_and_emits_the_completed_plan() {
        let mut p = Codex::new("root".into(), "设计一下".into(), Some("native".into())).with_policy(super::super::options::PermissionMode::Inherit, String::new()).with_mode("plan".into());
        let init = p.start().unwrap();
        assert!(matches!(&init[0], Action::Write(v) if v["params"]["capabilities"]["experimentalApi"] == true));
        p.receive(json!({"id":1,"result":{}})).unwrap();
        let out = p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"model":"gpt-5","effort":"high"}})).unwrap();
        let turn = out.iter().find_map(|action| match action {
            Action::Write(value) if value["method"] == "turn/start" => Some(value["params"].clone()),
            _ => None,
        }).unwrap();
        assert_eq!(turn["collaborationMode"], json!({"mode":"plan","settings":{"model":"gpt-5"}}));
        assert!(turn.get("model").is_none() && turn.get("effort").is_none());
        p.receive(json!({"id":3,"result":{"turn":{"id":"turn-1"}}})).unwrap();
        let out = p.receive(json!({"method":"item/plan/delta","params":{"threadId":"native","delta":"# 计划\n"}})).unwrap();
        assert!(matches!(&out[0], Action::Emit{kind:"plan_draft",data} if data["append"] == true));
        let out = p.receive(json!({"method":"item/completed","params":{"threadId":"native","item":{"id":"plan-item","type":"plan","text":"# 计划\n第一步"}}})).unwrap();
        assert!(matches!(&out[0], Action::Emit{kind:"plan_draft",data} if data["complete"] == true && data["text"] == "# 计划\n第一步"));
        assert!(matches!(&out[1], Action::Plan{title,content,native_plan_id} if title == "计划" && content == "# 计划\n第一步" && native_plan_id == "plan-item"));
    }

    #[test]
    fn turn_plan_update_emits_model_task_list_in_protocol_order() {
        let mut protocol = Codex::new("root".into(), "执行".into(), Some("native".into()));
        let out = protocol.receive(json!({"method":"turn/plan/updated","params":{
            "threadId":"native","turnId":"turn-1","explanation":null,
            "plan":[
                {"step":"检查协议","status":"completed"},
                {"step":"修复历史恢复","status":"inProgress"},
                {"step":"运行验证","status":"pending"}
            ]
        }})).unwrap();
        assert!(matches!(&out[0], Action::Emit { kind:"task_list", data } if data == &json!({
            "replace":true,
            "items":[
                {"id":"plan-0","content":"检查协议","status":"complete"},
                {"id":"plan-1","content":"修复历史恢复","status":"active"},
                {"id":"plan-2","content":"运行验证","status":"pending"}
            ]
        })));
    }

    #[test]
    fn forge_task_tool_replaces_the_model_task_list_and_acknowledges_the_call() {
        let mut protocol = Codex::new("root".into(), "执行".into(), Some("native".into()));
        started_thread(&mut protocol);
        let out = protocol.receive(json!({
            "id": 9,
            "method": "item/tool/call",
            "params": {
                "threadId": "native",
                "turnId": "turn-1",
                "callId": "task-call",
                "namespace": TASK_TOOL_NAMESPACE,
                "tool": TASK_TOOL_NAME,
                "arguments": {"tasks": [
                    {"step":"检查项目","status":"completed"},
                    {"step":"运行验证","status":"in_progress"},
                    {"step":"汇总结果","status":"pending"}
                ]}
            }
        })).unwrap();
        assert!(matches!(&out[0], Action::Emit { kind:"task_list", data } if data == &json!({
            "replace":true,
            "items":[
                {"id":"task-0","content":"检查项目","status":"complete"},
                {"id":"task-1","content":"运行验证","status":"active"},
                {"id":"task-2","content":"汇总结果","status":"pending"}
            ]
        })));
        assert!(matches!(&out[1], Action::Write(value)
            if value["id"] == 9 && value["result"]["success"] == true));
    }

    #[test]
    fn forge_task_tool_rejects_invalid_snapshots_without_changing_the_list() {
        let mut protocol = Codex::new("root".into(), "执行".into(), Some("native".into()));
        started_thread(&mut protocol);
        let out = protocol.receive(json!({
            "id": 10,
            "method": "item/tool/call",
            "params": {
                "threadId": "native",
                "turnId": "turn-1",
                "namespace": TASK_TOOL_NAMESPACE,
                "tool": TASK_TOOL_NAME,
                "arguments": {"tasks": [
                    {"step":"步骤一","status":"in_progress"},
                    {"step":"步骤二","status":"in_progress"}
                ]}
            }
        })).unwrap();
        assert_eq!(out.len(), 1);
        assert!(matches!(&out[0], Action::Write(value)
            if value["id"] == 10
                && value["result"]["success"] == false
                && value["result"]["contentItems"][0]["text"].as_str().is_some_and(|text| text.contains("最多只能有一项"))));
    }

    #[test]
    fn native_goal_probe_updates_and_clear_emit_independent_goal_events() {
        let mut protocol = Codex::new("root".into(), "执行".into(), Some("native".into()));
        protocol.start().unwrap();
        protocol.receive(json!({"id":1,"result":{}})).unwrap();
        let connected = protocol.receive(json!({"id":2,"result":{
            "thread":{"id":"native"},"model":"gpt-5","approvalPolicy":"on-request",
            "approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"}
        }})).unwrap();
        let probe = connected.iter().find_map(|action| match action {
            Action::Write(value) if value["method"] == "thread/goal/get" => value["id"].as_u64(),
            _ => None,
        }).expect("接上线程后必须读取 Goal");
        let goal = json!({
            "threadId":"native","objective":"完成 Goal 与 Task 联测","status":"active",
            "tokenBudget":10000,"tokensUsed":1200,"timeUsedSeconds":30,
            "createdAt":1,"updatedAt":2
        });
        let loaded = protocol.receive(json!({"id":probe,"result":{"goal":goal}})).unwrap();
        assert!(matches!(&loaded[..], [Action::Emit { kind:"goal", data }] if data["goal"]["objective"] == "完成 Goal 与 Task 联测"));

        let setting = protocol.set_goal_status("paused").unwrap();
        let request = match &setting[..] {
            [Action::Write(value)] => value,
            _ => panic!("Goal 状态必须只发送一条原生请求"),
        };
        assert_eq!(request["method"], "thread/goal/set");
        assert_eq!(request["params"], json!({"threadId":"native","status":"paused","origin":"user"}));
        let refresh = protocol.receive(json!({"id":request["id"],"result":{}})).unwrap();
        assert!(matches!(&refresh[..], [Action::Write(value)]
            if value["method"] == "thread/goal/get" && value["params"]["threadId"] == "native"));
        assert!(protocol.set_goal_status("complete").is_err(), "用户控制只允许暂停或继续");

        let updated = protocol.receive(json!({"method":"thread/goal/updated","params":{
            "threadId":"native","turnId":"turn-1","goal":{
                "threadId":"native","objective":"完成 Goal 与 Task 联测","status":"complete",
                "tokenBudget":10000,"tokensUsed":8000,"timeUsedSeconds":90,
                "createdAt":1,"updatedAt":3
            }
        }})).unwrap();
        assert!(matches!(&updated[..], [Action::Emit { kind:"goal", data }] if data["goal"]["status"] == "complete"));
        let cleared = protocol.receive(json!({"method":"thread/goal/cleared","params":{"threadId":"native"}})).unwrap();
        assert!(matches!(&cleared[..], [Action::Emit { kind:"goal", data }] if data["goal"].is_null()));
    }

    #[test]
    fn plan_mode_without_a_model_fails_closed_instead_of_sending_invalid_settings() {
        let mut p = Codex::new("root".into(), "设计".into(), None).with_policy(super::super::options::PermissionMode::Inherit, String::new()).with_mode("plan".into());
        p.start().unwrap();
        p.receive(json!({"id":1,"result":{}})).unwrap();
        assert!(p.receive(json!({"id":2,"result":{"thread":{"id":"native"}}})).is_err());
    }

    #[test]
    fn a_decision_turn_verifies_the_plan_and_restates_the_mode() {
        let content = "# 计划\n第一步";
        let mut p = Codex::new("root".into(), "execute".into(), Some("native".into()))
            .with_policy(super::super::options::PermissionMode::Inherit, String::new())
            .with_decision(Some(Decision { mode: "default", native_plan_id: "plan-item".into(), content_hash: super::super::plans::content_hash(content) }));
        let init = p.start().unwrap();
        assert!(matches!(&init[0], Action::Write(v) if v["params"]["capabilities"]["experimentalApi"] == true));
        p.receive(json!({"id":1,"result":{}})).unwrap();
        let out = p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"model":"gpt-5"}})).unwrap();
        assert!(matches!(&out[0], Action::Write(v) if v["method"] == "thread/turns/list" && v["params"]["itemsView"] == "full"));
        let out = p.receive(json!({"id":3,"result":{"data":[{"items":[{"id":"plan-item","type":"plan","text":content}]}]}})).unwrap();
        let turn = out.iter().find_map(|action| match action {
            Action::Write(value) if value["method"] == "turn/start" => Some(value["params"].clone()),
            _ => None,
        }).unwrap();
        assert_eq!(turn["collaborationMode"], json!({"mode":"default","settings":{"model":"gpt-5"}}));
        assert_eq!(turn["input"][0]["text"], "execute");
    }

    #[test]
    fn a_decision_turn_pages_until_it_finds_the_reviewed_plan() {
        let content = "older approved plan";
        let mut p = Codex::new("root".into(), "execute".into(), Some("native".into()))
            .with_policy(super::super::options::PermissionMode::Inherit, String::new())
            .with_decision(Some(Decision { mode: "default", native_plan_id: "plan-item".into(), content_hash: super::super::plans::content_hash(content) }));
        p.start().unwrap();
        p.receive(json!({"id":1,"result":{}})).unwrap();
        p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"model":"gpt-5"}})).unwrap();
        let next = p.receive(json!({"id":3,"result":{"data":[],"nextCursor":"older"}})).unwrap();
        assert!(matches!(&next[0], Action::Write(value)
            if value["method"] == "thread/turns/list" && value["params"]["cursor"] == "older"));
        assert!(!next.iter().any(|action| matches!(action, Action::Write(value) if value["method"] == "turn/start")));
        let found = p.receive(json!({"id":3,"result":{"data":[{"items":[{"id":"plan-item","type":"plan","text":content}]}]}})).unwrap();
        assert!(found.iter().any(|action| matches!(action, Action::Write(value) if value["method"] == "turn/start")));
    }

    #[test]
    fn a_decision_turn_rejects_repeated_pagination_cursors() {
        let mut p = Codex::new("root".into(), "execute".into(), Some("native".into()))
            .with_policy(super::super::options::PermissionMode::Inherit, String::new())
            .with_decision(Some(Decision { mode: "default", native_plan_id: "plan-item".into(), content_hash: "hash".into() }));
        p.start().unwrap();
        p.receive(json!({"id":1,"result":{}})).unwrap();
        p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"model":"gpt-5"}})).unwrap();
        p.receive(json!({"id":3,"result":{"data":[],"nextCursor":"same"}})).unwrap();
        assert!(p.receive(json!({"id":3,"result":{"data":[],"nextCursor":"same"}})).is_err());
    }

    #[test]
    fn decision_keeps_explicit_model_and_effort_over_thread_defaults() {
        let content = "approved plan";
        let mut protocol = Codex::new("root".into(), "execute".into(), Some("native".into()))
            .with_options(Some("chosen".into()), Some("high".into()))
            .with_policy(super::super::options::PermissionMode::Inherit, "default".into())
            .with_decision(Some(Decision { mode: "default", native_plan_id: "plan-item".into(), content_hash: super::super::plans::content_hash(content) }));
        protocol.start().unwrap();
        protocol.receive(json!({"id":1,"result":{}})).unwrap();
        protocol.receive(json!({"id":2,"result":{"thread":{"id":"native"},"model":"thread-default","effort":"low"}})).unwrap();
        let actions = protocol.receive(json!({"id":3,"result":{"data":[{"items":[{"id":"plan-item","type":"plan","text":content}]}]}})).unwrap();
        let turn = actions.iter().find_map(|action| match action {
            Action::Write(value) if value["method"] == "turn/start" => Some(&value["params"]),
            _ => None,
        }).unwrap();
        assert_eq!(turn["collaborationMode"]["settings"], json!({"model":"chosen","reasoning_effort":"high"}));
        assert_eq!(turn["serviceTierForTurn"], "default");
    }

    #[test]
    fn ordinary_turn_never_sends_experimental_collaboration_mode() {
        // 用户 UI 上没有开 plan 模式，但 Codex 服务端记录该 thread 处于 plan 模式：
        // 握手为 Task 工具声明实验能力，不代表普通回合可以偷带 collaborationMode。
        let mut p = Codex::new("root".into(), "修改代码".into(), Some("native".into()))
            .with_policy(super::super::options::PermissionMode::Inherit, String::new());
        let init = p.start().unwrap();
        assert!(matches!(&init[0], Action::Write(value) if value["params"]["capabilities"]["experimentalApi"] == true));
        p.receive(json!({"id":1,"result":{}})).unwrap();
        let out = p.receive(json!({
            "id": 2,
            "result": {
                "thread": {"id": "native"},
                "model": "gpt-5",
                "collaborationMode": {"mode": "plan", "settings": {"model": "gpt-5"}}
            }
        })).unwrap();
        let config = out.iter().find_map(|action| match action {
            Action::Emit { kind, data } if *kind == "configuration" => Some(data.clone()),
            _ => None,
        }).unwrap();
        assert_eq!(config["threadPlanMode"], true);
        assert_eq!(config["planMode"], false);

        let turn = out.iter().find_map(|action| match action {
            Action::Write(value) if value["method"] == "turn/start" => Some(value["params"].clone()),
            _ => None,
        }).unwrap();
        assert!(turn.get("collaborationMode").is_none());
    }

    #[test]
    fn a_changed_or_missing_plan_never_starts_the_execution_turn() {
        for result in [
            json!({"data":[{"items":[{"id":"plan-item","type":"plan","text":"# 计划\n改过了"}]}]}),
            json!({"data":[{"items":[{"id":"other","type":"plan","text":"# 计划\n第一步"}]}]}),
            json!({"data":"invalid"}),
        ] {
            let mut p = Codex::new("root".into(), "execute".into(), Some("native".into()))
                .with_policy(super::super::options::PermissionMode::Inherit, String::new())
                .with_decision(Some(Decision { mode: "default", native_plan_id: "plan-item".into(), content_hash: super::super::plans::content_hash("# 计划\n第一步") }));
            p.start().unwrap();
            p.receive(json!({"id":1,"result":{}})).unwrap();
            p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"model":"gpt-5"}})).unwrap();
            let error = match p.receive(json!({"id":3,"result":result})) {
                Ok(_) => panic!("stale plan must not start a turn"),
                Err(error) => error,
            };
            assert!(error.starts_with("codex plan is stale:") || error.contains("未返回回合页"), "{error}");
        }
    }

    #[test]
    fn async_questions_are_answered_by_steering_the_live_turn() {
        let mut p = Codex::new("root".into(), "hi".into(), Some("native".into()));
        started_thread(&mut p);
        let out = p.receive(json!({"method":"item/completed","params":{"threadId":"native","item":{
            "id":"call-1","type":"agentMessage","text":"要不要继续？",
            "questions":[{"title":"继续吗？","options":["继续","停止"]}]
        }}})).unwrap();
        let request = out.iter().find_map(|action| match action {
            Action::Request { key, kind, data } => Some((key.clone(), *kind, data.clone())),
            _ => None,
        }).unwrap();
        assert_eq!(request.0, "async:call-1");
        assert_eq!(request.1, "question");
        assert_eq!(request.2["questions"][0]["question"], "继续吗？");
        assert!(p.respond("async:call-1", json!({"answers":{"1":["继续"]}})).is_err());
        let out = p.respond("async:call-1", json!({"answers":{"0":["继续"]}})).unwrap();
        let steer = match &out[0] {
            Action::Write(value) => value,
            other => panic!("{other:?}"),
        };
        assert_eq!(steer["method"], "turn/steer");
        assert_eq!(steer["params"]["expectedTurnId"], "turn-1");
        let text = steer["params"]["input"][0]["text"].as_str().unwrap();
        assert!(text.contains("call_id: call-1") && text.contains("继续吗？"));
        // steer 的回包不是握手响应，只能吞掉。
        assert!(p.receive(json!({"id":steer["id"],"result":{}})).unwrap().is_empty());
    }
}
