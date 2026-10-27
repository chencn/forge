//! Claude 的 stream-json 与 SDK 控制信封。不读凭据，也不绕过权限确认。
//! Claude stream-json and SDK control envelopes; no credential access or permission bypass.
//! 只处理 Claude 的 stream-json 与 SDK 控制信封；不读凭据，也不绕过权限确认。
use super::protocol::{Action, Protocol};
/// 回合终态的词表；本文件另有一个同名的 todo 状态函数，所以用别名引入。
use super::task_status as turn;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

fn task_status(value: Option<&str>) -> &'static str {
    match value.unwrap_or("") {
        "completed" | "complete" => "complete",
        "in_progress" | "active" => "active",
        "blocked" => "blocked",
        "deleted" | "dropped" => "dropped",
        _ => "pending",
    }
}

/// Claude 的 TodoWrite / TaskCreate / TaskUpdate 统一成持久化 task_list 事件。
pub(crate) fn task_event(tool_id: &str, name: &str, input: &Value) -> Option<Action> {
    let (replace, items) = match name {
        "TodoWrite" => {
            let items: Vec<_> = input["todos"].as_array()?.iter().enumerate().filter_map(|(index, item)| {
                let content = ["content", "text", "title", "task", "subject"].iter()
                    .find_map(|key| item[*key].as_str()).map(str::trim).filter(|value| !value.is_empty())?;
                Some(json!({
                    "id":item["id"].as_str().or_else(|| item["taskId"].as_str()).map(str::to_owned).unwrap_or_else(|| format!("todo-{index}")),
                    "content":content,
                    "status":task_status(item["status"].as_str()),
                    "detail":item["description"],
                }))
            }).collect();
            (true, items)
        }
        "TaskCreate" => {
            let content = input["subject"].as_str()?.trim();
            if content.is_empty() { return None; }
            (false, vec![json!({"id":tool_id,"content":content,"status":task_status(input["status"].as_str()),"detail":input["description"]})])
        }
        "TaskUpdate" => {
            let id = input["taskId"].as_str()?.trim();
            if id.is_empty() { return None; }
            // TaskUpdate 是稀疏补丁；缺失字段不是“重置为默认值”。
            let mut item = json!({"id":id});
            if let Some(content) = input["subject"].as_str() { item["content"] = json!(content); }
            if let Some(status) = input["status"].as_str() { item["status"] = json!(task_status(Some(status))); }
            if let Some(detail) = input["description"].as_str() { item["detail"] = json!(detail); }
            (false, vec![item])
        }
        _ => return None,
    };
    Some(Action::Emit { kind: "task_list", data: json!({"replace":replace,"items":items}) })
}

/// 从 TaskCreate 的结构化结果或人类可读回执里取真实任务 ID。
/// Claude 版本不同，有的给 `{taskId:"7"}`，有的只给 `Task #7 created`。
fn created_task_id(value: &Value) -> Option<String> {
    if let Some(object) = value.as_object() {
        for key in ["taskId", "task_id", "id"] {
            if let Some(id) = object.get(key).and_then(|id| id.as_str()).map(str::trim).filter(|id| !id.is_empty()) {
                return Some(id.to_owned());
            }
        }
        for key in ["result", "data", "content", "text"] {
            if let Some(id) = object.get(key).and_then(created_task_id) { return Some(id); }
        }
    }
    if let Some(items) = value.as_array() {
        return items.iter().find_map(created_task_id);
    }
    let text = value.as_str()?.trim();
    if let Ok(parsed) = serde_json::from_str::<Value>(text) {
        if let Some(id) = created_task_id(&parsed) { return Some(id); }
    }
    let words = text.split_whitespace().collect::<Vec<_>>();
    for pair in words.windows(2) {
        if pair[0].trim_matches(|c: char| !c.is_ascii_alphabetic()).eq_ignore_ascii_case("task") {
            let id = pair[1].trim_start_matches('#').trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_');
            if !id.is_empty() { return Some(id.to_owned()); }
        }
    }
    None
}

/// TaskCreate 的真实 taskId 只在工具结果里出现；显式替换临时工具 ID，
/// 后续 TaskUpdate 才能命中同一项。
pub(crate) fn created_task_event(tool: &Value, structured: Option<&Value>, output: &Value) -> Option<Action> {
    if tool["name"] != "TaskCreate" { return None; }
    let id = structured.and_then(created_task_id).or_else(|| created_task_id(output))?;
    let content = tool["input"]["subject"].as_str()?.trim();
    if id.is_empty() || content.is_empty() { return None; }
    Some(Action::Emit { kind: "task_list", data: json!({"replace":false,"items":[{
        "id":id,"replacesId":tool["id"],"content":content,"status":task_status(structured.and_then(|value| value["status"].as_str())),"detail":tool["input"]["description"]
    }]}) })
}

/// 用户改过的工具入参：只替换原入参已有的键，其余一律按原样保留。
///
/// 「允许前端任意形状」等于给它一次往工具里塞新参数的机会——工具不认识那个键时的行为
/// 由 CLI 自己决定，我们无从审查。所以这里做形状钳制，改内容不改接口。
fn edited_input(original: &Value, edited: &Value) -> Result<Value, String> {
    let base = original.as_object().ok_or("工具入参格式不兼容")?;
    let changes = edited.as_object().ok_or("修改后的入参格式无效")?;
    if changes.is_empty() || changes.len() > base.len() {
        return Err("修改后的入参键数无效".into());
    }
    let mut merged = base.clone();
    for (key, value) in changes {
        if !base.contains_key(key) {
            return Err("修改后的入参含未知字段".into());
        }
        merged.insert(key.clone(), value.clone());
    }
    Ok(Value::Object(merged))
}

/// Claude 判定「headless 下被权限系统拒绝」的短语；大小写不敏感。
const DENIAL_PHRASES: &[&str] = &[
    "requested permissions",
    "haven't granted it yet",
    "have not granted it yet",
    "requires approval",
    "requires permission",
    "permission denied",
    "blocked for security",
    "blocked. for security",
    "allowed working directories",
    "may only write to files",
    "outside the allowed",
    "outside workspace",
];
fn looks_like_permission_denial(message: &str) -> bool {
    let normalized = message.trim().to_ascii_lowercase();
    !normalized.is_empty() && DENIAL_PHRASES.iter().any(|phrase| normalized.contains(phrase))
}
/// 错误文本里第一个像绝对路径的词；只在结构化入参拿不到路径时兜底。
fn extract_absolute_path(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        let cleaned = token.trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | ',' | ';' | ')' | '(' | '[' | ']' | '{' | '}' | '.'));
        let bytes = cleaned.as_bytes();
        if cleaned.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/') {
            return Some(cleaned.to_string());
        }
        if cleaned.starts_with('/') && cleaned.len() > 1 {
            return Some(cleaned.to_string());
        }
    }
    None
}
fn tool_result_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts.iter()
            .filter(|part| part["type"] == "text")
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}
/// 工具入参里要动的那个文件；命令类入参没有路径，返回 None。
fn tool_path(tool: &Value) -> Option<String> {
    ["file_path", "notebook_path", "path", "absolute_path", "target_file"].iter()
        .find_map(|key| tool["input"][*key].as_str().filter(|path| !path.trim().is_empty()).map(str::to_owned))
}

/// 子代理标题的兜底截断：取首个非空行、按字符截到 80，防止超长文本进 meta.title。
fn agent_title(text: &str) -> String {
    let line = text.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
    line.chars().take(80).collect()
}

/// Claude 的协议适配器。
///
/// 状态基本都围绕「流式增量」与「完整消息」两条通道：增量负责实时上屏，
/// 完整消息负责收尾校正，两者用消息 id 关联，所以这里存了不少中间态。
pub struct Claude {
    /// 用户本轮输入的提示词，初始化握手成功后原样发出去。
    prompt: String,
    /// 已按 Claude SDK stream-json 线格式编码的图片内容块。
    images: Vec<Value>,
    /// 用户本轮选择的模型（可能是别名），用于快照与选择器一致性判断。
    requested_model: Option<String>,
    /// CLI 自己的会话 id。恢复对话时先带上旧值，`init` 事件再核对是否一致。
    native: Option<String>,
    /// 提示词是否已经发出。用来拒绝重复的初始化响应，避免同一轮发两遍。
    sent: bool,
    /// 收到 system/init 才说明 CLI 已经接收本轮用户输入；控制协议初始化回包不算开跑。
    started: bool,
    /// 是否已被中断。置位后不再接受授权答复，也不再放行新请求。
    stopped: bool,
    /// 作用域（`parent_tool_use_id`）→ 当前消息 id。子代理有独立作用域，不能互相覆盖。
    messages: HashMap<String, String>,
    /// 已处理过的完整消息信封哈希。同一个消息 id 会来多个信封（文本/思考/工具），
    /// 要去重的是信封本身而不是 id，否则后面几段会被丢掉。
    complete: HashSet<u64>,
    /// 消息 id → 已流式累计的文本。完整消息只带最后一段时用它拼回全文。
    streamed_text: HashMap<String, String>,
    /// 本轮是否产出过正文。没产出时用 `result` 里的文本兜底，避免空白回复。
    had_text: bool,
    /// 待答复请求：请求 id → 原始请求内容。答复时要用它还原 `updatedInput`。
    pending: HashMap<String, Value>,
    /// 工具 id → 工具块。工具结果回来时要查它的名字，判断是否改了文件。
    tools: HashMap<String, Value>,
    /// 成功回合后是否正在等待只读上下文分类。
    context_pending: bool,
    command: Option<super::commands::CommandIntent>,
    commands: Vec<Value>,
    terminal_commands: Vec<String>,
    /// (作用域, 块索引) → (工具 id, 参数 JSON 片段)。
    blocks: HashMap<(String, u64), (String, String)>,
    /// 本轮是计划回合：启动参数由运行时负责，这里只用于对外说明。
    plan_mode: bool,
    /// CLI 报告仍在运行的后台任务数。大于 0 时 result 不是本轮终点。
    background: usize,
    /// 回合已交还用户，但进程留在原地等后台任务自发的后续回合。
    parked: bool,
    /// 已经报过的权限拒绝，按工具/路径去重，避免 result 与 tool_result 各报一次。
    denied: HashSet<String>,
    /// 子代理 agentId → Agent 工具调用 id。task_notification 只带 task_id（即 agentId）
    /// 时靠它找回 key；同一 agent 复活续聊会覆盖旧值，与 CLI 的地址语义一致。
    agent_ids: HashMap<String, String>,
}
impl Claude {
    pub fn new(_cwd: String, prompt: String, native: Option<String>) -> Self {
        Self {
            prompt,
            images: vec![],
            requested_model: None,
            native,
            sent: false,
            started: false,
            stopped: false,
            messages: HashMap::new(),
            complete: HashSet::new(),
            streamed_text: HashMap::new(),
            had_text: false,
            pending: HashMap::new(),
            tools: HashMap::new(),
            context_pending: false,
            command: None,
            commands: vec![],
            terminal_commands: vec![],
            blocks: HashMap::new(),
            plan_mode: false,
            background: 0,
            parked: false,
            denied: HashSet::new(),
            agent_ids: HashMap::new(),
        }
    }
    pub fn with_plan(mut self, plan: bool) -> Self {
        self.plan_mode = plan;
        self
    }
    /// 新父回合可用 SendMessage 续聊旧代理，通知里的 agentId 仍指向旧工具调用。
    pub fn with_agents(mut self, agents: Vec<(String, Option<String>)>) -> Self {
        for (key, agent_id) in agents {
            self.tools.insert(key.clone(), json!({"id":key,"name":"Agent"}));
            if let Some(id) = agent_id { self.agent_ids.insert(id, key); }
        }
        self
    }
    pub fn with_model(mut self, model: Option<String>) -> Self {
        self.requested_model = model;
        self
    }
    pub fn with_images(mut self, images: Vec<Value>) -> Self {
        self.images = images;
        self
    }
    pub fn with_command(mut self, command: Option<super::commands::CommandIntent>) -> Self {
        self.command = command;
        self
    }
    fn catalog_event(&self) -> Action {
        Action::Emit { kind: "commands", data: json!({"commands":self.commands,"terminal":self.terminal_commands}) }
    }
    fn update_commands(&mut self, commands: &Value) -> Option<Action> {
        let list = commands.as_array()?;
        self.commands = list.iter().filter_map(|c| {
            let name = c["name"].as_str()?;
            if name.is_empty() || name.len() > 200 || name.chars().any(|c| c.is_whitespace() || c.is_control() || c == '/' || c == '\\') { return None; }
            let aliases: Vec<_> = c["aliases"].as_array().into_iter().flatten().filter_map(Value::as_str)
                .filter(|alias| !alias.is_empty() && alias.len() <= 200 && !alias.chars().any(|c| c.is_whitespace() || c.is_control() || c == '/' || c == '\\')).collect();
            let mut item = json!({"name":name,"description":c["description"].as_str().unwrap_or(""),"argumentHint":c["argumentHint"].as_str().unwrap_or(""),"aliases":aliases});
            if let Some(builtin) = c["builtin"].as_bool() { item["builtin"] = json!(builtin); }
            Some(item)
        }).collect();
        Some(self.catalog_event())
    }
    fn validate_slash(&self) -> Result<(), String> {
        let (name, _) = super::commands::parse(&self.prompt).ok_or("无效斜杠命令")?;
        let exact: Vec<_> = self.commands.iter().filter(|c| c["name"].as_str() == Some(name)).collect();
        let matches: Vec<_> = if exact.is_empty() {
            self.commands.iter().filter(|c| c["aliases"].as_array().is_some_and(|aliases| aliases.iter().any(|a| a.as_str() == Some(name)))).collect()
        } else { exact };
        let command = matches.iter().find(|c| c["builtin"] == true).copied().or_else(|| matches.first().copied())
            .ok_or("CLI 未确认此命令；未发送给模型。请先发送普通消息以加载命令目录")?;
        let canonical = command["name"].as_str().unwrap_or("");
        // This per-turn integration cannot preserve arbitrary terminal-local state changes.
        if self.terminal_commands.iter().any(|c| c == name || c == canonical)
            || !(matches!(canonical, "compact" | "usage") || command["builtin"] != true) {
            return Err("此命令需要终端交互或尚未适配；未发送给模型".into());
        }
        Ok(())
    }
    fn reply(id: &str, response: Value) -> Action {
        Action::Write(
            json!({"type":"control_response","response":{"subtype":"success","request_id":id,"response":response}}),
        )
    }
    /// 子代理的消息（`parent_tool_use_id` 非空）打上归属。`parent` 供旧日志的委派卡
    /// 分组兼容，`agentKey` 是运行时路由子会话的信号：带它的条目会写进子代理会话，
    /// 不再平铺进主对话。
    fn scoped(mut data: Value, scope: &str) -> Value {
        if !scope.is_empty() {
            data["parent"] = json!(scope);
            data["agentKey"] = json!(scope);
        }
        data
    }
    // 任务清单与正文走同一归属规则，尤其 TodoWrite 的 replace 不能落到父会话。
    fn scoped_action(action: Action, scope: &str) -> Action {
        match action {
            Action::Emit { kind, data } => Action::Emit { kind, data: Self::scoped(data, scope) },
            other => other,
        }
    }
    /// 真正的子代理委派工具仅为 `Agent`。除普通工具事件外，再发一条 `agent`
    /// 生命周期事件：运行时据此建子会话，前端据此画委派卡与子代理列表。
    /// 注意：Task 是后台任务概念（或任务清单），绝不能当作子代理派生。
    fn agent_spawn_event(block: &Value) -> Option<Action> {
        if block["name"].as_str() != Some("Agent") { return None; }
        // 流式 start 常只有空 input；参数齐全后再登记，避免发出无法路由的占位。
        if !["prompt", "subagent_type"].iter().any(|key| block["input"][*key].as_str().is_some_and(|text| !text.trim().is_empty())) { return None; }
        // 标题只承担扫视：description 取首行再截断，回退到 prompt 时压成一行短标题——
        // 最长 4000 字的正文进了 meta.title 会一直顶在侧栏提示与子会话头上。
        let title = match block["input"]["description"].as_str().map(str::trim).filter(|text| !text.is_empty()) {
            Some(text) => agent_title(text),
            None => block["input"]["prompt"].as_str().and_then(super::history::auto_title).unwrap_or_else(|| "子代理".into()),
        };
        // 任务正文截一段带出：子会话的第一条用户消息靠它，子代理视图才知道自己被安排了什么。
        let prompt = block["input"]["prompt"].as_str().map(str::trim).filter(|text| !text.is_empty())
            .map(|text| text.chars().take(4000).collect::<String>());
        Some(Action::Emit { kind: "agent", data: json!({
            "key": block["id"],
            "title": title,
            "agentType": block["input"]["subagent_type"],
            "model": block["input"]["model"],
            "background": block["input"]["run_in_background"],
            "prompt": prompt,
            "status": "starting",
        }) })
    }
    /// Agent 工具的回执：后台启动回执带 agentId/resolvedModel，子会话由此绑定 CLI 侧
    /// 身份并开始接收路由事件；同步代理的回执（AgentOutput）就是最终报告与运行总量。
    fn agent_result_event(&mut self, id: &str, structured: Option<&Value>, ok: bool) -> Option<Action> {
        if !self.tools.get(id).is_some_and(|tool| tool["name"].as_str() == Some("Agent")) { return None; }
        // 失败回执不保证带结构化结果，但失败本身已经是明确的终态。
        if !ok {
            return Some(Action::Emit { kind: "agent", data: json!({"key":id,"status":"failed"}) });
        }
        let structured = structured?;
        if let Some(agent_id) = structured["agentId"].as_str().filter(|value| !value.is_empty()) {
            self.agent_ids.insert(agent_id.to_owned(), id.to_owned());
        }
        if structured["isAsync"] == true || structured["status"] == "async_launched" {
            return Some(Action::Emit { kind: "agent", data: json!({
                "key": id, "agentId": structured["agentId"],
                "resolvedModel": structured["resolvedModel"],
                "status": "running",
            }) });
        }
        let text = structured["content"].as_array().map(|blocks| blocks.iter()
            .filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n"))
            .filter(|text| !text.is_empty());
        Some(Action::Emit { kind: "agent", data: json!({
            "key": id, "agentId": structured["agentId"],
            "resolvedModel": structured["resolvedModel"],
            "status": if ok { "completed" } else { "failed" },
            "result": text,
            "usage": {"totalTokens": structured["totalTokens"], "toolUses": structured["totalToolUseCount"], "durationMs": structured["totalDurationMs"]},
        }) })
    }
    fn tool(&mut self, block: &Value, scope: &str) -> Result<Vec<Action>, String> {
        let id = block["id"]
            .as_str()
            .ok_or("Claude 工具缺少 ID")?
            .to_string();
        // 完整信封会补齐流式开始时的空参数；只去重相同输入，否则文件路径永远传不到前端。
        let updating = self.tools.contains_key(&id);
        if self.tools.get(&id).is_some_and(|old| old["input"] == block["input"] && old["name"] == block["name"]) {
            return Ok(vec![]);
        }
        self.tools.insert(id.clone(), block.clone());
        let mut out = vec![Action::Emit {
            kind: "tool",
            data: Self::scoped(if updating { json!({"id":id,"name":block["name"],"input":block["input"]}) } else { json!({"id":id,"name":block["name"],"input":block["input"],"status":"running"}) }, scope),
        }];
        if scope.is_empty() {
            if let Some(event) = Self::agent_spawn_event(block) { out.push(event); }
            if block["name"] == "SendMessage" {
                if let Some(key) = block["input"]["to"].as_str().and_then(|id| self.agent_ids.get(id)) {
                    out.push(Action::Emit { kind: "agent", data: json!({"key":key,"status":"running"}) });
                }
            }
        }
        if let Some(event) = task_event(&id, block["name"].as_str().unwrap_or(""), &block["input"]) { out.push(Self::scoped_action(event, scope)); }
        Ok(out)
    }
    /// 仅供协议集成测试确认辅助上下文查询已释放，不能进入生产协议接口。
    #[cfg(test)]
    pub(crate) fn context_pending(&self) -> bool { self.context_pending }
}
impl Protocol for Claude {
    fn start(&mut self) -> Result<Vec<Action>, String> {
        // forwardSubagentText：让 CLI 把子代理的正文与思考也实时转发出来
        // （默认只转发 tool_use/tool_result 块）。子代理会话视图靠它拿到全文；
        // 旧版 CLI 不认识此字段时按 Zod 默认行为丢弃，不影响握手。
        Ok(vec![Action::Write(
            json!({"type":"control_request","request_id":"forge-initialize","request":{"subtype":"initialize","hooks":null,"forwardSubagentText":true}}),
        )])
    }
    fn receive(&mut self, value: Value) -> Result<Vec<Action>, String> {
        let mut out = vec![];
        let scope = value["parent_tool_use_id"]
            .as_str()
            .unwrap_or("")
            .to_string();
        match value["type"].as_str().ok_or("Claude 协议消息缺少类型")? {
            "control_response" => {
                let r = &value["response"];
                if r["request_id"] == "forge-context-summary" {
                    if !self.context_pending { return Ok(out); }
                    self.context_pending = false;
                    let data = &r["response"];
                    if r["subtype"] == "success" && data["categories"].is_array() {
                        out.push(Action::Emit { kind: "context", data: json!({
                            "detail":"summary", "capturedAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
                            "requestedModel":self.requested_model,
                            "model":data["model"], "totalTokens":data["totalTokens"], "rawMaxTokens":data["rawMaxTokens"],
                            "categories":data["categories"], "mcpTools":data["mcpTools"], "memoryFiles":data["memoryFiles"],
                            "systemPromptSections":data["systemPromptSections"], "systemTools":data["systemTools"],
                            "deferredBuiltinTools":data["deferredBuiltinTools"],
                            "agents":data["agents"], "skills":data["skills"], "messageBreakdown":data["messageBreakdown"]
                        }) });
                    } else {
                        out.push(Action::Emit { kind: "context_unavailable", data: json!({"reason":"unsupported_or_invalid"}) });
                    }
                } else if r["request_id"] == "forge-initialize" {
                    if self.stopped { return Ok(out); }
                    if r["subtype"] != "success" {
                        return Err(format!("Claude 控制协议初始化失败：{}", r["error"]));
                    }
                    if self.sent {
                        return Err("Claude 重复初始化响应".into());
                    }
                    if let Some(event) = self.update_commands(&r["response"]["commands"]) { out.push(event); }
                    if self.command == Some(super::commands::CommandIntent::ClaudeSlash) {
                        if let Err(error) = self.validate_slash() {
                            out.push(Action::Finish { status: turn::FAILED, error: Some(error) });
                            return Ok(out);
                        }
                    }
                    self.sent = true;
                    let content = if self.images.is_empty() {
                        json!(self.prompt)
                    } else {
                        let mut blocks = std::mem::take(&mut self.images);
                        if !self.prompt.trim().is_empty() { blocks.push(json!({"type":"text","text":self.prompt})); }
                        json!(blocks)
                    };
                    out.push(Action::Write(json!({"type":"user","session_id":self.native.as_deref().unwrap_or(""),"message":{"role":"user","content":content},"parent_tool_use_id":null,"origin":{"kind":"human"}})));
                    // 上下文摘要是辅助缓存：在回合进行期间机会式刷新，不能等结果出来后再阻塞终态。
                    out.extend(self.request_context());
                }
            }
            "system" => match value["subtype"].as_str().unwrap_or("") {
                "init" => {
                    let id = value["session_id"]
                        .as_str()
                        .ok_or("Claude 未返回会话 ID")?
                        .to_string();
                    if self.native.as_ref().is_some_and(|old| old != &id) {
                        return Err("Claude 恢复到了不同会话".into());
                    }
                    self.native = Some(id.clone());
                    self.started = true;
                    out.push(Action::Bind(id));
                    self.terminal_commands = value["terminal_slash_commands"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect();
                    out.push(self.catalog_event());
                    out.push(Action::Emit {kind:"configuration",data:json!({"model":value["model"],"permissionMode":value["permissionMode"],"cliVersion":value["claude_code_version"]})});
                    // init 是 CLI 唯一报告「实际加载了哪些 MCP 服务」的地方；只投影名字与状态，
                    // 不把服务配置或凭据带出后端。
                    if let Some(servers) = value.get("mcp_servers").or_else(|| value.get("mcpServers")).and_then(Value::as_array) {
                        let servers: Vec<_> = servers.iter().filter_map(|server| {
                            let name = server["name"].as_str()?.trim();
                            if name.is_empty() { return None; }
                            Some(json!({"name":name,"status":server["status"]}))
                        }).collect();
                        if !servers.is_empty() {
                            out.push(Action::Emit { kind: "mcp_servers", data: json!({"servers":servers,"tools":value["tools"]}) });
                        }
                    }
                }
                "background_tasks_changed" => {
                    let pending = value["tasks"].as_array().map_or(0, Vec::len);
                    self.background = pending;
                    out.push(Action::Emit { kind: "background", data: json!({"pending":pending,"settled":self.parked}) });
                    // 回合已经交了、后台任务也全结束了：关 stdin 让 CLI 自己退出，
                    // stdout 仍继续读，避免把最后一帧跟进消息丢掉。
                    if self.parked && pending == 0 {
                        out.push(Action::CloseInput);
                    }
                }
                "task_notification" => {
                    out.push(Action::Emit {
                        kind: "background",
                        data: json!({"pending":self.background,"settled":self.parked,"task":value["task"]}),
                    });
                    // 子代理终态的权威信号：task_id 即 agentId，tool_use_id 指回发起的
                    // Agent 调用；同一 task_id 可多次通知（复活续聊），后者覆盖前者。
                    let task_id = value["task_id"].as_str().or_else(|| value["taskId"].as_str()).filter(|id| !id.is_empty());
                    let key = value["tool_use_id"].as_str().or_else(|| value["toolUseId"].as_str()).map(str::to_owned)
                        .or_else(|| task_id.and_then(|id| self.agent_ids.get(id).cloned()));
                    if let (Some(task_id), Some(key)) = (task_id, key) {
                        // 过滤非子代理调用：普通后台 Bash 等工具也会产生 task_notification，
                        // 必须严格校验该调用来源于真正的 Agent 工具（已通过 agent_spawn/agent_result 注册或工具名为 Agent），
                        // 绝不能将普通 Shell 命令广播为子代理。
                        let is_agent_tool = self.agent_ids.contains_key(task_id)
                            || self.tools.get(&key).is_some_and(|tool| tool["name"].as_str() == Some("Agent"));
                        if is_agent_tool {
                            let status = match value["status"].as_str() {
                                Some("completed") => "completed",
                                Some("failed") => "failed",
                                _ => "stopped",
                            };
                            out.push(Action::Emit { kind: "agent", data: json!({
                                "key": key, "agentId": task_id, "status": status,
                                "result": value["summary"],
                                "usage": value["usage"],
                            }) });
                        }
                    }
                }
                "commands_changed" => { if let Some(event) = self.update_commands(&value["commands"]) { out.push(event); } }
                "local_command_output" => {
                    if let (Some(id), Some(text)) = (value["uuid"].as_str(), value["content"].as_str()) {
                        self.had_text = true;
                        out.push(Action::Emit { kind: "command_output", data: json!({"id":id,"text":text}) });
                    }
                }
                "compact_boundary" | "status" if value["subtype"] == "compact_boundary" || value["status"] == "compacting" => out.push(Action::Emit { kind: "compaction", data: json!({"metadata":value["compact_metadata"],"status":if value["subtype"] == "compact_boundary" { "completed" } else { "compacting" }}) }),
                "api_retry" => out.push(Action::Emit {
                    kind: "retry",
                    data: json!({"attempt":value["attempt"],"error":value["error"]}),
                }),
                _ => {}
            },
            "stream_event" => {
                let event = &value["event"];
                match event["type"].as_str().unwrap_or("") {
                    "message_start" => {
                        let id = event["message"]["id"]
                            .as_str()
                            .ok_or("Claude 流消息缺少 ID")?;
                        self.messages.insert(scope.clone(), id.into());
                    }
                    "content_block_start" => {
                        let block = &event["content_block"];
                        if block["type"] == "tool_use" {
                            out.extend(self.tool(block, &scope)?);
                            let index = event["index"].as_u64().ok_or("Claude 工具缺少块索引")?;
                            self.blocks.insert(
                                (scope.clone(), index),
                                (block["id"].as_str().unwrap().into(), String::new()),
                            );
                        } else if block["type"] == "thinking" {
                            if let Some(id) = self.messages.get(&scope) {
                                out.push(Action::Emit { kind: "reasoning_delta", data: Self::scoped(json!({"id":format!("{id}-{}",event["index"].as_u64().unwrap_or(0)),"text":block["thinking"].as_str().unwrap_or("")}), &scope) });
                            }
                        } else if block["type"] == "text" {
                            if let Some(text) = block["text"].as_str().filter(|s| !s.is_empty()) {
                                let id =
                                    self.messages.get(&scope).ok_or("Claude 文本缺少消息边界")?;
                                if scope.is_empty() { self.had_text = true; }
                                self.streamed_text.entry(id.clone()).or_default().push_str(text);
                                out.push(Action::Emit {
                                    kind: "text",
                                    data: Self::scoped(json!({"id":id,"text":text}), &scope),
                                });
                            }
                        }
                    }
                    "content_block_delta" => {
                        let delta = &event["delta"];
                        if delta["type"] == "text_delta" {
                            let id = self.messages.get(&scope).ok_or("Claude 增量缺少消息边界")?;
                            let text = delta["text"].as_str().ok_or("Claude 文本增量无效")?;
                            self.streamed_text.entry(id.clone()).or_default().push_str(text);
                            if scope.is_empty() { self.had_text = true; }
                            out.push(Action::Emit {kind:"text",data:Self::scoped(json!({"id":id,"text":text}), &scope)});
                        } else if delta["type"] == "thinking_delta" {
                            if let Some(id) = self.messages.get(&scope) {
                                out.push(Action::Emit { kind: "reasoning_delta", data: Self::scoped(json!({"id":format!("{id}-{}",event["index"].as_u64().unwrap_or(0)),"text":delta["thinking"]}), &scope) });
                            }
                        } else if delta["type"] == "input_json_delta" {
                            let index = event["index"].as_u64().ok_or("Claude 工具缺少索引")?;
                            if let Some((_, text)) = self.blocks.get_mut(&(scope.clone(), index)) {
                                text.push_str(
                                    delta["partial_json"]
                                        .as_str()
                                        .ok_or("Claude 工具参数增量无效")?,
                                );
                                if text.len() > 1024 * 1024 {
                                    return Err("Claude 工具参数过大".into());
                                }
                            }
                        }
                    }
                    "content_block_stop" => {
                        if let Some(index) = event["index"].as_u64() {
                            if let Some((id, text)) = self.blocks.remove(&(scope.clone(), index)) {
                                if !text.is_empty() {
                                    let input: Value = serde_json::from_str(&text)
                                        .map_err(|e| format!("Claude 工具参数损坏：{e}"))?;
                                    if let Some(mut tool) = self.tools.get(&id).cloned() {
                                        // 参数补全复用完整工具通道，同时登记 Agent 与任务；随后完整信封照常去重。
                                        tool["input"] = input;
                                        out.extend(self.tool(&tool, &scope)?);
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            "assistant" => {
                let message = &value["message"];
                let id = message["id"].as_str().ok_or("Claude 完整消息缺少 ID")?;
                // 同一个消息 id 会拆成多个信封送来（文本、思考、工具各一封），
                // 所以要去重的是信封内容本身，而不是消息 id——按 id 去重会把后几段丢掉。
                use std::hash::{Hash, Hasher};
                let mut hash = std::collections::hash_map::DefaultHasher::new();
                message.to_string().hash(&mut hash);
                if !self.complete.insert(hash.finish()) { return Ok(vec![]); }
                let mut text = String::new();
                for (index, block) in message["content"].as_array().ok_or("Claude 消息内容无效")?.iter().enumerate() {
                    if block["type"] == "thinking" {
                        out.push(Action::Emit { kind: "reasoning", data: Self::scoped(json!({"id":format!("{id}-{index}"),"text":block["thinking"].as_str().unwrap_or("")}), &scope) });
                    }
                    if block["type"] == "text" {
                        text.push_str(block["text"].as_str().unwrap_or(""));
                    }
                    if block["type"] == "tool_use" {
                        out.extend(self.tool(block, &scope)?);
                    }
                }
                if !text.is_empty() {
                    // 部分信封只带最后一个文本块；若它正是流式全文的后缀，就用全文替换，
                    // 避免把已经上屏的前半段覆盖成只剩一段。
                    if let Some(streamed) = self.streamed_text.get(id) {
                        if streamed.ends_with(&text) { text = streamed.clone(); }
                    }
                    if scope.is_empty() { self.had_text = true; }
                    out.push(Action::Emit {
                        kind: "message",
                        data: Self::scoped(json!({"id":id,"text":text}), &scope),
                    });
                }
                if scope.is_empty() && message["model"].is_string() {
                    out.push(Action::Emit { kind: "configuration", data: json!({"model":message["model"]}) });
                }
                if scope.is_empty() && message.get("usage").is_some() {
                    out.push(Action::Emit {
                        kind: "usage",
                        data: message["usage"].clone(),
                    });
                }
            }
            "user" => {
                let blocks = value["message"]["content"].as_array().map(Vec::as_slice).unwrap_or_default();
                let result_count = blocks.iter().filter(|block| block["type"] == "tool_result").count();
                for block in blocks {
                    if block["type"] != "tool_result" {
                        continue;
                    }
                    let id = block["tool_use_id"]
                        .as_str()
                        .ok_or("Claude 工具结果缺少 ID")?;
                    if block["is_error"] == true {
                        // headless -p 不能现场追问：被权限系统拒绝的调用只剩错误文本。
                        // 把它转成可行动的事件，界面才能提供「允许此目录」而不是让模型空口解释。
                        let text = tool_result_text(block);
                        if looks_like_permission_denial(&text) {
                            let tool = self.tools.get(id).and_then(|tool| tool["name"].as_str()).map(str::to_owned);
                            let path = self.tools.get(id).and_then(tool_path)
                                .or_else(|| extract_absolute_path(&text));
                            if self.denied.insert(format!("{tool:?}:{path:?}")) {
                                out.push(Action::Emit { kind: "permission_denied", data: json!({
                                    "tool":tool, "path":path,
                                    "text":text.trim().chars().take(500).collect::<String>(),
                                }) });
                            }
                        }
                    }
                    // 结构化结果包含真实读取范围与补丁，不能只保留发给模型的文本摘要。
                    let mut result = Self::scoped(json!({"id":id,"output":block["content"],"status":if block["is_error"]==true {"failed"} else {"completed"}}), &scope);
                    // 完成事件必须能独立投影：分页可能没有加载工具开始所在的旧页。
                    if let Some(tool) = self.tools.get(id) {
                        result["name"] = tool["name"].clone();
                        result["input"] = tool["input"].clone();
                    }
                    let structured = super::structured_tool_result(value.get("tool_use_result").or_else(|| value.get("toolUseResult")), id, result_count);
                    if let Some(structured) = structured { result["result"] = structured.clone(); }
                    if scope.is_empty() {
                        if let Some(event) = self.agent_result_event(id, structured, block["is_error"] != true) { out.push(event); }
                    }
                    out.push(Action::Emit {kind:"tool",data:result});
                    if block["is_error"] != true {
                        if let Some(tool) = self.tools.get(id) {
                            if let Some(event) = created_task_event(tool, structured, &block["content"]) { out.push(Self::scoped_action(event, &scope)); }
                        }
                    }
                    if block["is_error"] != true && !structured.is_some_and(|result| result["staged"] == true) {
                        if let Some(tool) = self.tools.get(id) {
                            if matches!(
                                tool["name"].as_str(),
                                Some("Write" | "Edit" | "MultiEdit" | "NotebookEdit")
                            ) {
                                if let Some(path) = tool["input"]["file_path"]
                                    .as_str()
                                    .or_else(|| tool["input"]["notebook_path"].as_str())
                                {
                                    out.push(Action::Emit {
                                        kind: "files",
                                        data: json!({"paths":[path]}),
                                    });
                                }
                            }
                        }
                    }
                }
            }
            "control_request" => {
                let id = value["request_id"]
                    .as_str()
                    .ok_or("Claude 请求缺少 ID")?
                    .to_string();
                let request = &value["request"];
                if self.stopped || request["subtype"] != "can_use_tool" {
                    return Ok(vec![Action::Write(
                        json!({"type":"control_response","response":{"subtype":"error","request_id":id,"error":"Unsupported control request; no permission granted"}}),
                    )]);
                }
                if self.pending.contains_key(&id) {
                    return Err("Claude 重复使用待处理请求 ID".into());
                }
                if !request["input"].is_object() || request["tool_name"].as_str().is_none() {
                    return Err("Claude 工具授权格式不兼容".into());
                }
                let question = request["tool_name"] == "AskUserQuestion";
                let data = if question {
                    let list = request["input"]["questions"]
                        .as_array()
                        .filter(|q| !q.is_empty() && q.len() <= 32)
                        .ok_or("Claude 提问格式无效")?;
                    let mut questions = vec![];
                    for (index, q) in list.iter().enumerate() {
                        if !q["question"].is_string() {
                            return Err("Claude 提问缺少正文".into());
                        }
                        let mut q = q.clone();
                        q["id"] = json!(index.to_string());
                        questions.push(q);
                    }
                    // 原始请求 id（can_use_tool 的 request_id 就是 tool_use id）：前端拿它把
                    // 工具条目与请求卡认成同一次提问，工具记录才能给请求卡让位——没有这个
                    // 关联，两边各画一张卡，同一次提问就出现两次。
                    json!({"title":"Claude Code","toolId":id,"questions":questions})
                } else {
                    // canEdit 是服务端事实：Claude 的 can_use_tool 答复有 updatedInput 这个位置，
                    // Codex 没有，它自己会拒。
                    json!({"title":request["tool_name"],"toolId":id,"toolName":request["tool_name"],"input":request["input"],"reason":request["decision_reason"],"blockedPath":request["blocked_path"],"canEdit":true})
                };
                self.pending.insert(id.clone(), request.clone());
                out.push(Action::Request {
                    key: id,
                    kind: if question { "question" } else { "permission" },
                    data,
                });
            }
            "control_cancel_request" => {
                if let Some(id) = value["request_id"].as_str() {
                    self.pending.remove(id);
                    out.push(Action::Invalidate(id.into()));
                }
            }
            "result" => {
                let id = value["session_id"]
                    .as_str()
                    .ok_or("Claude 结果缺少会话 ID")?;
                if self.native.as_deref() != Some(id) {
                    return Err("Claude 最终会话标识不一致".into());
                }
                if value["is_error"] == true || value["subtype"] != "success" {
                    return Err(format!(
                        "Claude 运行失败：{}",
                        value
                            .get("errors")
                            .filter(|v| v.as_array().is_some_and(|a| !a.is_empty()))
                            .unwrap_or(&value["result"])
                    ));
                }
                if !self.had_text {
                    if let Some(text) = value["result"].as_str().filter(|s| !s.is_empty()) {
                        out.push(Action::Emit {
                            kind: "message",
                            data: json!({"id":"result","text":text}),
                        });
                    }
                }
                // 最终结果里的结构化拒绝清单是兜底：tool_result 已报过的按工具/路径去重。
                if let Some(denials) = value["permission_denials"].as_array() {
                    for denial in denials {
                        let tool = denial["tool_name"].as_str().map(str::trim).filter(|tool| !tool.is_empty()).map(str::to_owned);
                        let path = tool_path(&json!({"input":denial["tool_input"]}));
                        if tool.is_none() && path.is_none() { continue; }
                        // 提取命令文本或拒绝原因，避免向前端发射空说明导致的空白提示横幅
                        let text = denial["tool_input"]["command"].as_str()
                            .or_else(|| denial["message"].as_str())
                            .or_else(|| denial["reason"].as_str())
                            .unwrap_or("")
                            .trim()
                            .to_owned();
                        if self.denied.insert(format!("{tool:?}:{path:?}")) {
                            out.push(Action::Emit { kind: "permission_denied", data: json!({"tool":tool,"path":path,"text":text}) });
                        }
                    }
                }
                out.push(Action::Emit {
                    kind: "usage",
                    data: json!({"usage":value["usage"],"total_cost_usd":value["total_cost_usd"],"modelUsage":value["modelUsage"],"scope":"turn"}),
                });
                if self.background > 0 && !self.stopped {
                    // 后台任务还在跑：这一轮对用户已结束，但进程与 stdout 必须留着，
                    // CLI 会在任务完成后自己开一个后续回合。
                    self.parked = true;
                    self.had_text = false;
                    out.push(Action::Emit {
                        kind: "background",
                        data: json!({"pending":self.background,"settled":true}),
                    });
                    return Ok(out);
                }
                self.parked = false;
                out.push(Action::Finish {
                    status: if self.stopped {
                        turn::CANCELLED
                    } else {
                        turn::COMPLETED
                    },
                    error: None,
                });
            }
            _ => {}
        }
        Ok(out)
    }
    fn respond(&mut self, key: &str, answer: Value) -> Result<Vec<Action>, String> {
        if self.stopped {
            return Err("任务已停止".into());
        }
        let request = self.pending.get(key).ok_or("请求已失效")?;
        let response = if request["tool_name"] == "AskUserQuestion" {
            let answers = answer["answers"].as_object().ok_or("回答无效")?;
            let questions = request["input"]["questions"].as_array().ok_or("问题无效")?;
            if answers.len() != questions.len() {
                return Err("请回答所有问题".into());
            }
            let mut input = request["input"].clone();
            let mut mapped = serde_json::Map::new();
            for (index, q) in questions.iter().enumerate() {
                let parts = answers
                    .get(&index.to_string())
                    .and_then(Value::as_array)
                    .filter(|a| !a.is_empty() && a.iter().all(Value::is_string))
                    .ok_or("答案无效")?;
                if q["multiSelect"] != true && parts.len() != 1 {
                    return Err("该问题只能选择一个答案".into());
                }
                mapped.insert(
                    q["question"].as_str().ok_or("问题无效")?.into(),
                    json!(parts
                        .iter()
                        .map(|s| s.as_str().unwrap())
                        .collect::<Vec<_>>()
                        .join(", ")),
                );
            }
            input["answers"] = Value::Object(mapped);
            json!({"behavior":"allow","updatedInput":input})
        } else if answer["allow"].as_bool().ok_or("授权回答无效")? {
            // 改完再允许：can_use_tool 的答复本来就带 updatedInput，这里只把用户改过的值交回去。
            // 只认原入参里已有的键——前端能加键就等于能给工具塞它自己没打算收的参数。
            let input = match answer.get("input") {
                None => request["input"].clone(),
                Some(edited) => edited_input(&request["input"], edited)?,
            };
            json!({"behavior":"allow","updatedInput":input})
        } else {
            json!({"behavior":"deny","message":"User denied this operation"})
        };
        self.pending.remove(key);
        Ok(vec![Self::reply(key, response)])
    }
    fn request_context(&mut self) -> Vec<Action> {
        if self.stopped || self.context_pending { return vec![]; }
        self.context_pending = true;
        // 官方 SDK 的 summary 路径不做逐分类 token-count API 调用。
        vec![Action::Write(json!({"type":"control_request","request_id":"forge-context-summary","request":{"subtype":"get_context_usage","detail":"summary"}}))]
    }
    fn context_timeout(&mut self) -> Vec<Action> {
        if !self.context_pending { return vec![]; }
        self.context_pending = false;
        vec![Action::Emit { kind: "context_unavailable", data: json!({"reason":"timeout"}) }]
    }
    fn interrupt(&mut self) -> Vec<Action> {
        self.stopped = true;
        self.context_pending = false;
        self.parked = false;
        self.background = 0;
        self.pending.clear();
        vec![Action::Write(
            json!({"type":"control_request","request_id":"forge-interrupt","request":{"subtype":"interrupt"}}),
        )]
    }
    fn turn_started(&self) -> bool { self.started }
    fn parked(&self) -> bool {
        self.parked
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn turn_is_started_only_after_claude_confirms_system_init() {
        let mut protocol = Claude::new("root".into(), "hi".into(), None);
        protocol.start().unwrap();
        assert!(!protocol.turn_started());
        // 控制协议握手只是允许发送 user 帧，真正接单边界是随后到达的 system/init。
        protocol.receive(json!({"type":"control_response","response":{"request_id":"forge-initialize","subtype":"success","response":{"commands":[]}}})).unwrap();
        assert!(!protocol.turn_started());
        protocol.receive(json!({"type":"system","subtype":"init","session_id":"native"})).unwrap();
        assert!(protocol.turn_started());
    }
    #[test]
    fn completed_edit_is_self_contained_after_empty_stream_start() {
        for field in ["tool_use_result", "toolUseResult"] {
            let mut p = Claude::new("root".into(), "hi".into(), None);
            p.receive(json!({"type":"stream_event","event":{"type":"content_block_start","index":0,
                "content_block":{"type":"tool_use","id":"edit","name":"Edit","input":{}}}})).unwrap();
            let input = json!({"file_path":"a.ts","old_string":"old","new_string":"new"});
            p.receive(json!({"type":"assistant","message":{"id":"m","content":[
                {"type":"tool_use","id":"edit","name":"Edit","input":input}
            ]}})).unwrap();
            let mut reply = json!({"type":"user","message":{"content":[
                {"type":"tool_result","tool_use_id":"edit","content":"updated"}
            ]}});
            reply[field] = json!({"filePath":"a.ts","oldString":"old","newString":"new"});
            let actions = p.receive(reply).unwrap();
            assert!(actions.iter().any(|action| matches!(action, Action::Emit {kind:"tool",data}
                if data["name"] == "Edit" && data["input"] == input && data["status"] == "completed"
                    && data["result"]["filePath"] == "a.ts")));
            assert!(actions.iter().any(|action| matches!(action, Action::Emit {kind:"files",data}
                if data["paths"] == json!(["a.ts"]))));
        }
    }
    #[test]
    fn pasted_images_use_claude_base64_content_blocks() {
        let image = json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}});
        let mut protocol = Claude::new("root".into(), "".into(), None).with_images(vec![image.clone()]);
        protocol.start().unwrap();
        let actions = protocol.receive(json!({"type":"control_response","response":{"request_id":"forge-initialize","subtype":"success","response":{"commands":[]}}})).unwrap();
        let content = actions.iter().find_map(|action| match action {
            Action::Write(value) if value["type"] == "user" => value["message"]["content"].as_array(),
            _ => None,
        }).unwrap();
        assert_eq!(content, &vec![image]);
    }
    #[test]
    fn structured_read_and_edit_results_are_preserved_and_staged_edits_do_not_report_writes() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        for (id, name, result) in [
            ("read", "Read", json!({"type":"text","file":{"filePath":"a.ts","content":"a\nb","startLine":10,"numLines":2}})),
            ("edit", "Edit", json!({"filePath":"a.ts","structuredPatch":[{"oldStart":10,"oldLines":1,"newStart":10,"newLines":1,"lines":["-a","+b"]}],"staged":true})),
        ] {
            p.receive(json!({"type":"assistant","message":{"id":format!("message-{id}"),"content":[{"type":"tool_use","id":id,"name":name,"input":{"file_path":"a.ts"}}]}})).unwrap();
            let actions = p.receive(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"content":"summary"}]},"tool_use_result":result})).unwrap();
            assert!(actions.iter().any(|a| matches!(a, Action::Emit{kind:"tool",data} if data["id"] == id && data["result"] == result && data["output"] == "summary")));
            assert!(!actions.iter().any(|a| matches!(a, Action::Emit{kind:"files",..})));
        }
    }
    #[test]
    fn task_create_rebinds_the_temporary_tool_id_to_the_cli_task_id() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        let created = p.receive(json!({"type":"assistant","message":{"id":"message-task","content":[{
            "type":"tool_use","id":"tool-create","name":"TaskCreate","input":{"subject":"实现队列","description":"保持 FIFO"}
        }]}})).unwrap();
        assert!(created.iter().any(|action| matches!(action, Action::Emit { kind:"task_list", data }
            if data["items"][0]["id"] == "tool-create" && data["items"][0]["content"] == "实现队列")));
        let rebound = p.receive(json!({"type":"user","message":{"content":[{
            "type":"tool_result","tool_use_id":"tool-create","content":"Task #7 created"
        }]},"tool_use_result":{"taskId":"7","status":"pending"}})).unwrap();
        assert!(rebound.iter().any(|action| matches!(action, Action::Emit { kind:"task_list", data }
            if data["items"][0]["id"] == "7" && data["items"][0]["content"] == "实现队列")));
        let updated = p.receive(json!({"type":"assistant","message":{"id":"message-update","content":[{
            "type":"tool_use","id":"tool-update","name":"TaskUpdate","input":{"taskId":"7","status":"in_progress"}
        }]}})).unwrap();
        assert!(updated.iter().any(|action| matches!(action, Action::Emit { kind:"task_list", data }
            if data["items"][0]["id"] == "7" && data["items"][0]["status"] == "active")));

        let partial = task_event("tool-update", "TaskUpdate", &json!({"taskId":"7","description":"等待复核"})).unwrap();
        assert!(matches!(partial, Action::Emit { kind:"task_list", data }
            if data["items"][0].get("status").is_none() && data["items"][0].get("content").is_none()));

        // 部分 Claude 版本没有结构化 tool_use_result，只在可读回执里给真实 ID。
        let mut text_only = Claude::new("root".into(), "hi".into(), None);
        text_only.receive(json!({"type":"assistant","message":{"id":"message-text-task","content":[{
            "type":"tool_use","id":"tool-text-create","name":"TaskCreate","input":{"subject":"修复状态机"}
        }]}})).unwrap();
        let rebound = text_only.receive(json!({"type":"user","message":{"content":[{
            "type":"tool_result","tool_use_id":"tool-text-create","content":"Task #42 created successfully"
        }]}})).unwrap();
        assert!(rebound.iter().any(|action| matches!(action, Action::Emit { kind:"task_list", data }
            if data["items"][0]["id"] == "42" && data["items"][0]["content"] == "修复状态机")));
    }
    #[test]
    fn multiple_tool_results_never_share_an_unmatched_top_level_result() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        for id in ["a", "b"] {
            p.receive(json!({"type":"assistant","message":{"id":format!("message-{id}"),"content":[{"type":"tool_use","id":id,"name":"Read","input":{"file_path":format!("{id}.ts")}}]}})).unwrap();
        }
        let actions = p.receive(json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"a","content":"A"},
            {"type":"tool_result","tool_use_id":"b","content":"B"}
        ]},"tool_use_result":{"filePath":"wrong.ts"}})).unwrap();
        assert_eq!(actions.iter().filter(|action| matches!(action, Action::Emit { kind: "tool", data } if data.get("result").is_some())).count(), 0);
        let matched = p.receive(json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"a","content":"A"},
            {"type":"tool_result","tool_use_id":"b","content":"B"}
        ]},"tool_use_result":[{"tool_use_id":"a","filePath":"a.ts"},{"tool_use_id":"b","filePath":"b.ts"}]})).unwrap();
        assert!(matched.iter().any(|action| matches!(action, Action::Emit { kind: "tool", data } if data["id"] == "a" && data["result"]["filePath"] == "a.ts")));
        assert!(matched.iter().any(|action| matches!(action, Action::Emit { kind: "tool", data } if data["id"] == "b" && data["result"]["filePath"] == "b.ts")));
    }
    fn command_init(commands: Value) -> Value {
        json!({"type":"control_response","response":{"subtype":"success","request_id":"forge-initialize","response":{"commands":commands,"account":{"secret":"must not leak"}}}})
    }
    #[test]
    fn slash_preserves_arguments_and_marks_human_origin() {
        let prompt = "/check \"a b\" --flag\n第二行";
        let mut p = Claude::new("root".into(), prompt.into(), None).with_command(Some(super::super::commands::CommandIntent::ClaudeSlash));
        let actions = p.receive(command_init(json!([{"name":"check","argumentHint":"<file>","description":"check files","aliases":["c",{"secret":"discard"},"invalid name"]}]))).unwrap();
        assert!(actions.iter().any(|a| matches!(a, Action::Write(v) if v["message"]["content"] == prompt && v["origin"]["kind"] == "human")));
        assert!(matches!(&actions[0], Action::Emit{kind:"commands",data} if data.get("account").is_none() && data["commands"][0]["aliases"] == json!(["c"]) && data["commands"][0]["argumentHint"] == "<file>"));
    }
    #[test]
    fn unknown_and_stateful_slashes_never_fall_back_to_a_prompt() {
        for (prompt, commands) in [
            ("/unknown args", json!([])),
            ("/clear", json!([{"name":"clear"},{"name":"clear","builtin":true}])),
            ("/quit", json!([{"name":"exit","builtin":true,"aliases":["quit"]}])),
        ] {
            let mut p = Claude::new("root".into(), prompt.into(), None).with_command(Some(super::super::commands::CommandIntent::ClaudeSlash));
            let actions = p.receive(command_init(commands)).unwrap();
            assert!(!actions.iter().any(|a| matches!(a, Action::Write(_))));
            assert!(actions.iter().any(|a| matches!(a, Action::Finish{status:"failed",..})));
        }
    }
    #[test]
    fn real_names_override_aliases_and_changed_catalog_replaces() {
        let mut p = Claude::new("root".into(), "/cost args".into(), None).with_command(Some(super::super::commands::CommandIntent::ClaudeSlash));
        let actions = p.receive(command_init(json!([{"name":"exit","builtin":true,"aliases":["cost"]},{"name":"cost"}]))).unwrap();
        assert!(actions.iter().any(|a| matches!(a, Action::Write(_))));
        let actions = p.receive(json!({"type":"system","subtype":"commands_changed","commands":[]})).unwrap();
        assert!(matches!(&actions[0], Action::Emit{kind:"commands",data} if data["commands"] == json!([])));
        let actions = p.receive(json!({"type":"system","subtype":"local_command_output","uuid":"output","content":"command result"})).unwrap();
        assert!(matches!(&actions[0], Action::Emit{kind:"command_output",data} if data["text"] == "command result"));
        assert!(p.had_text);
    }
    #[test]
    fn cancelled_initialization_never_sends_user_input() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        p.interrupt();
        assert!(p.receive(command_init(json!([]))).unwrap().is_empty());
    }
    #[test]
    fn context_summary_is_read_only_and_excludes_consumption_data() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        let actions = p.request_context();
        assert!(matches!(&actions[0], Action::Write(v) if v["request"]["subtype"] == "get_context_usage" && v["request"]["detail"] == "summary"));
        assert!(p.request_context().is_empty());
        let response = json!({"type":"control_response","response":{"request_id":"forge-context-summary","subtype":"success","response":{
            "categories":[{"name":"System prompt","tokens":100,"kind":"used"}],
            "totalTokens":100,"rawMaxTokens":1000,"model":"fixture",
            "systemPromptSections":[{"name":"Base","tokens":100}],"apiUsage":{"input_tokens":999},"secret":"not forwarded"
        }}});
        let actions = p.receive(response.clone()).unwrap();
        assert!(matches!(&actions[0], Action::Emit{kind:"context",data} if data["categories"][0]["tokens"] == 100 && data["systemPromptSections"][0]["tokens"] == 100 && data.get("apiUsage").is_none() && data.get("secret").is_none()));
        assert!(!p.context_pending());
        assert!(p.receive(response).unwrap().is_empty());
    }
    #[test]
    fn context_failure_timeout_and_cancel_are_nonterminal_and_ignore_late_replies() {
        for response in [json!({"subtype":"error","error":"unsupported"}), json!({"subtype":"success","response":{}})] {
            let mut p = Claude::new("root".into(), "hi".into(), None);
            p.request_context();
            let mut response = response;
            response["request_id"] = json!("forge-context-summary");
            let actions = p.receive(json!({"type":"control_response","response":response})).unwrap();
            assert!(matches!(&actions[0], Action::Emit{kind:"context_unavailable",..}));
            assert!(!p.context_pending());
        }
        let mut p = Claude::new("root".into(), "hi".into(), None);
        p.request_context();
        assert!(matches!(&p.context_timeout()[0], Action::Emit{kind:"context_unavailable",..}));
        assert!(p.context_timeout().is_empty());
        p.request_context();
        p.interrupt();
        assert!(!p.context_pending());
        assert!(p.request_context().is_empty());
        assert!(p.receive(json!({"type":"control_response","response":{"request_id":"forge-context-summary","subtype":"success","response":{"categories":[]}}})).unwrap().is_empty());
    }
    #[test]
    fn public_thinking_usage_and_effective_model_are_retained_without_redacted_data() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        let out=p.receive(json!({"type":"assistant","message":{"id":"m","model":"effective","content":[{"type":"thinking","thinking":"public"},{"type":"redacted_thinking","data":"secret"},{"type":"text","text":"answer"}],"usage":{"input_tokens":3}}})).unwrap();
        assert!(out
            .iter()
            .any(|a| matches!(a,Action::Emit{kind:"reasoning",data} if data["text"]=="public")));
        assert!(out.iter().any(
            |a| matches!(a,Action::Emit{kind:"configuration",data} if data["model"]=="effective")
        ));
        assert!(!format!("{out:?}").contains("secret"));
        let out=p.receive(json!({"type":"assistant","parent_tool_use_id":"child","message":{"id":"child-message","model":"child-model","content":[],"usage":{"input_tokens":999}}})).unwrap();
        assert!(!out.iter().any(|a| matches!(
            a,
            Action::Emit {
                kind: "usage" | "configuration",
                ..
            }
        )));
    }
    #[test]
    fn agent_tool_lifecycle_becomes_agent_events_with_keys() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        // Agent tool_use（主线程作用域）→ starting 事件，带标题与任务正文。
        let spawn = p.receive(json!({"type":"assistant","message":{"id":"m","content":[
            {"type":"tool_use","id":"toolu_agent_1","name":"Agent","input":{
                "description":"输出数字","prompt":"从 1 输出到 100","subagent_type":"general-purpose","run_in_background":true
            }}
        ]}})).unwrap();
        assert!(spawn.iter().any(|a| matches!(a, Action::Emit{kind:"agent",data}
            if data["key"] == "toolu_agent_1" && data["status"] == "starting"
                && data["title"] == "输出数字" && data["agentType"] == "general-purpose"
                && data["prompt"].as_str().is_some_and(|text| text.contains("100")))));
        // 后台启动回执 → running + agentId 绑定。
        let launched = p.receive(json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"toolu_agent_1","content":"Async agent launched"}
        ]},"tool_use_result":{"isAsync":true,"status":"async_launched","agentId":"a70f6004","resolvedModel":"gemini-flash","canContinueAgent":true}})).unwrap();
        assert!(launched.iter().any(|a| matches!(a, Action::Emit{kind:"agent",data}
            if data["key"] == "toolu_agent_1" && data["agentId"] == "a70f6004" && data["status"] == "running")));
        // task_notification 只带 task_id 时，靠 agentId → key 映射找回归属。
        let done = p.receive(json!({"type":"system","subtype":"task_notification","task_id":"a70f6004",
            "status":"completed","summary":"Agent finished","usage":{"total_tokens":10555,"duration_ms":5880}})).unwrap();
        assert!(done.iter().any(|a| matches!(a, Action::Emit{kind:"agent",data}
            if data["key"] == "toolu_agent_1" && data["status"] == "completed" && data["result"] == "Agent finished")));
        // 子代理流事件带 agentKey：运行时据此把条目路由进子会话。
        p.receive(json!({"type":"stream_event","parent_tool_use_id":"toolu_agent_1","event":{
            "type":"message_start","message":{"id":"child-message"}}})).unwrap();
        let text = p.receive(json!({"type":"stream_event","parent_tool_use_id":"toolu_agent_1","event":{
            "type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"child"}}})).unwrap();
        assert!(text.iter().any(|a| matches!(a, Action::Emit{kind:"text",data} if data["agentKey"] == "toolu_agent_1")));
    }
    #[test]
    fn sync_agent_receipt_maps_to_completed_with_report() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        p.receive(json!({"type":"assistant","message":{"id":"m","content":[
            {"type":"tool_use","id":"tool_sync","name":"Agent","input":{"description":"查一下","prompt":"去查"}}
        ]}})).unwrap();
        let done = p.receive(json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"tool_sync","content":"ok"}
        ]},"tool_use_result":{"agentId":"ab07","content":[{"type":"text","text":"最终报告"}],"totalTokens":42,"totalToolUseCount":3,"totalDurationMs":1000}})).unwrap();
        assert!(done.iter().any(|a| matches!(a, Action::Emit{kind:"agent",data}
            if data["key"] == "tool_sync" && data["status"] == "completed" && data["result"] == "最终报告")));
        // 失败的同步回执映射 failed，不能谎报完成。
        p.receive(json!({"type":"assistant","message":{"id":"m2","content":[
            {"type":"tool_use","id":"tool_err","name":"Agent","input":{"description":"再查","prompt":"再"}}
        ]}})).unwrap();
        let failed = p.receive(json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"tool_err","is_error":true,"content":"boom"}
        ]},"tool_use_result":{"agentId":"ab08"}})).unwrap();
        assert!(failed.iter().any(|a| matches!(a, Action::Emit{kind:"agent",data}
            if data["key"] == "tool_err" && data["status"] == "failed")));
    }
    #[test]
    fn subagent_scope_events_carry_parent_for_delegation_grouping() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        // 主对话先有消息边界；它的文本不带 parent。
        p.receive(json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m"}}})).unwrap();
        let main = p.receive(json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"main"}}})).unwrap();
        assert!(!main.iter().any(|a| matches!(a, Action::Emit{kind:"text",data} if data.get("parent").is_some())));
        // 子代理作用域（parent_tool_use_id 非空）下的正文、思考与工具调用都带归属。
        let child = p.receive(json!({"type":"stream_event","parent_tool_use_id":"task-1","event":{"type":"message_start","message":{"id":"child-m"}}})).unwrap();
        assert!(child.iter().all(|a| !matches!(a, Action::Emit{..})));
        let text = p.receive(json!({"type":"stream_event","parent_tool_use_id":"task-1","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"child words"}}})).unwrap();
        assert!(text.iter().any(|a| matches!(a, Action::Emit{kind:"text",data} if data["parent"]=="task-1")));
        let tool = p.receive(json!({"type":"assistant","parent_tool_use_id":"task-1","message":{"id":"child-m2","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"}}]}})).unwrap();
        assert!(tool.iter().any(|a| matches!(a, Action::Emit{kind:"tool",data} if data["id"]=="t1" && data["parent"]=="task-1")));
        // 完整信封与 tool_result 也一样带。
        let full = p.receive(json!({"type":"assistant","parent_tool_use_id":"task-1","message":{"id":"child-m3","content":[{"type":"thinking","thinking":"hmm"}]}})).unwrap();
        assert!(full.iter().any(|a| matches!(a, Action::Emit{kind:"reasoning",data} if data["parent"]=="task-1")));
        let result = p.receive(json!({"type":"user","parent_tool_use_id":"task-1","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}})).unwrap();
        assert!(result.iter().any(|a| matches!(a, Action::Emit{kind:"tool",data} if data["id"]=="t1" && data["parent"]=="task-1")));
    }
    #[test]
    fn same_tool_use_from_stream_and_full_envelope_emits_once() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        // 流式 content_block_start 先到：发一次工具事件。
        let first = p.receive(json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"}}}})).unwrap();
        assert_eq!(first.iter().filter(|a| matches!(a, Action::Emit{kind:"tool",..})).count(), 1);
        // 完整 assistant 信封再带同一个 tool_use：只补全入参，不再发第二遍事件。
        let second = p.receive(json!({"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"}}]}})).unwrap();
        assert_eq!(second.iter().filter(|a| matches!(a, Action::Emit{kind:"tool",..})).count(), 0);
        // 没经过流式的新工具（另一封信封、新 id）照常发事件。
        let third = p.receive(json!({"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"b.ts"}}]}})).unwrap();
        assert_eq!(third.iter().filter(|a| matches!(a, Action::Emit{kind:"tool",..})).count(), 1);
    }
    #[test]
    fn shared_message_id_does_not_drop_later_text_blocks_or_tools() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        p.receive(
            json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m"}}}),
        )
        .unwrap();
        p.receive(json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first"}}})).unwrap();
        p.receive(json!({"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"first"}]}})).unwrap();
        let tools=p.receive(json!({"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"tool","name":"Read","input":{"file_path":"a"}}]}})).unwrap();
        assert!(tools
            .iter()
            .any(|a| matches!(a, Action::Emit { kind: "tool", .. })));
        p.receive(json!({"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"second"}}})).unwrap();
        let out=p.receive(json!({"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"second"}]}})).unwrap();
        assert!(out
            .iter()
            .any(|a| matches!(a,Action::Emit{kind:"message",data} if data["text"]=="firstsecond")));
    }
    #[test]
    fn a_permission_answer_is_one_shot_and_an_edit_replaces_only_that_key() {
        let mut p = Claude::new("root".into(), "hello".into(), None);
        p.receive(json!({"type":"control_request","request_id":"x","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"safe","timeout":5}}})).unwrap();
        let result = p
            .respond("x", json!({"allow":true,"input":{"command":"changed"}}))
            .unwrap();
        assert!(
            matches!(&result[0],Action::Write(v) if v["response"]["response"]["updatedInput"]["command"]=="changed")
        );
        // 改一个键不该顺手把别的键清掉：那等于用户没同意过的第二笔授权。
        assert!(
            matches!(&result[0],Action::Write(v) if v["response"]["response"]["updatedInput"]["timeout"]==5)
        );
        assert!(p.respond("x", json!({"allow":true})).is_err());
        // 不附带 input 时，原入参一字不改地交回去。
        p.receive(json!({"type":"control_request","request_id":"y","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"safe"}}})).unwrap();
        let plain = p.respond("y", json!({"allow":true})).unwrap();
        assert!(matches!(&plain[0],Action::Write(v) if v["response"]["response"]["updatedInput"]["command"]=="safe"));
    }
    #[test]
    fn questions_keep_answers_separate_from_tool_permissions() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        p.receive(json!({"type":"control_request","request_id":"question","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"选择语言？","multiSelect":false,"options":[{"label":"中文"}]}]}}})).unwrap();
        assert!(p.respond("question", json!({"allow":true})).is_err());
        let out = p
            .respond("question", json!({"answers":{"0":["中文"]}}))
            .unwrap();
        assert!(
            matches!(&out[0],Action::Write(v) if v["response"]["response"]["updatedInput"]["answers"]["选择语言？"]=="中文")
        );
        assert!(p
            .respond("question", json!({"answers":{"0":["中文"]}}))
            .is_err());
    }
    #[test]
    fn cancelled_requests_and_stopped_runs_cannot_grant_permissions() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        let request = json!({"type":"control_request","request_id":"permission","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"safe"}}});
        p.receive(request.clone()).unwrap();
        let out = p
            .receive(json!({"type":"control_cancel_request","request_id":"permission"}))
            .unwrap();
        assert!(matches!(&out[0],Action::Invalidate(id) if id=="permission"));
        assert!(p.respond("permission", json!({"allow":true})).is_err());
        p.receive(request.clone()).unwrap();
        p.interrupt();
        assert!(p.respond("permission", json!({"allow":true})).is_err());
        assert!(
            matches!(&p.receive(request).unwrap()[0],Action::Write(v) if v["response"]["subtype"]=="error")
        );
    }
    #[test]
    fn initialization_and_resume_mismatches_fail_without_sending_prompt() {
        let mut p = Claude::new("root".into(), "hi".into(), Some("old".into()));
        assert!(p.receive(json!({"type":"control_response","response":{"request_id":"forge-initialize","subtype":"error","error":"unsupported"}})).is_err());
        assert!(p
            .receive(json!({"type":"system","subtype":"init","session_id":"new"}))
            .is_err());
        assert!(p
            .receive(json!({"type":"result","subtype":"success","session_id":"new"}))
            .is_err());
    }
    #[test]
    fn full_messages_replace_stream_and_results_do_not_duplicate() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        p.receive(json!({"type":"system","subtype":"init","session_id":"native"}))
            .unwrap();
        p.receive(
            json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m"}}}),
        )
        .unwrap();
        assert!(matches!(&p.receive(json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"中文😀"}}})).unwrap()[0],Action::Emit{kind:"text",..}));
        let message = json!({"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"中文😀"}]}});
        assert!(matches!(
            &p.receive(message.clone()).unwrap()[0],
            Action::Emit {
                kind: "message",
                ..
            }
        ));
        assert!(p.receive(message).unwrap().is_empty());
        let out=p.receive(json!({"type":"result","subtype":"success","is_error":false,"session_id":"native","result":"中文😀"})).unwrap();
        assert!(!out.iter().any(|a| matches!(
            a,
            Action::Emit {
                kind: "message",
                ..
            }
        )));
    }
    #[test]
    fn streamed_agent_arguments_register_once_when_complete() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        let input = json!({"prompt":"检查状态路由","subagent_type":"Explore"});
        let mut actions = p.receive(json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"agent-tool","name":"Agent","input":{}}}})).unwrap();
        actions.extend(p.receive(json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":input.to_string()}}})).unwrap());
        actions.extend(p.receive(json!({"type":"stream_event","event":{"type":"content_block_stop","index":0}})).unwrap());
        actions.extend(p.receive(json!({"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"agent-tool","name":"Agent","input":input}]}})).unwrap());
        let agents: Vec<_> = actions.iter().filter_map(|a| match a { Action::Emit {kind:"agent",data} => Some(data), _ => None }).collect();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0]["prompt"], "检查状态路由");
        assert_eq!(agents[0]["agentType"], "Explore");
    }
    #[test]
    fn child_task_lists_keep_scope_including_streamed_input_and_real_ids() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        let mut actions = p.receive(json!({"type":"assistant","parent_tool_use_id":"agent-tool","message":{"id":"m","content":[{"type":"tool_use","id":"todo","name":"TodoWrite","input":{"todos":[{"content":"子任务"}]}}]}})).unwrap();
        actions.extend(p.receive(json!({"type":"stream_event","parent_tool_use_id":"agent-tool","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"create","name":"TaskCreate","input":{}}}})).unwrap());
        actions.extend(p.receive(json!({"type":"stream_event","parent_tool_use_id":"agent-tool","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"subject\":\"检查正文\"}"}}})).unwrap());
        actions.extend(p.receive(json!({"type":"stream_event","parent_tool_use_id":"agent-tool","event":{"type":"content_block_stop","index":0}})).unwrap());
        actions.extend(p.receive(json!({"type":"user","parent_tool_use_id":"agent-tool","message":{"content":[{"type":"tool_result","tool_use_id":"create","content":"Task #7 created"}]}})).unwrap());
        let tasks: Vec<_> = actions.iter().filter_map(|a| match a { Action::Emit {kind:"task_list",data} => Some(data), _ => None }).collect();
        assert_eq!(tasks.len(), 3);
        assert!(tasks.iter().all(|data| data["agentKey"] == "agent-tool"));
        assert_eq!(tasks[2]["items"][0]["id"], "7");
    }
    #[test]
    fn child_text_does_not_suppress_parent_result_fallback() {
        for streaming in [false, true] {
            let mut p = Claude::new("root".into(), "hi".into(), Some("native".into()));
            if streaming {
                p.receive(json!({"type":"stream_event","parent_tool_use_id":"agent-tool","event":{"type":"message_start","message":{"id":"child"}}})).unwrap();
                p.receive(json!({"type":"stream_event","parent_tool_use_id":"agent-tool","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"子报告"}}})).unwrap();
                p.receive(json!({"type":"stream_event","parent_tool_use_id":"agent-tool","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"补充"}}})).unwrap();
            } else {
                p.receive(json!({"type":"assistant","parent_tool_use_id":"agent-tool","message":{"id":"child","content":[{"type":"text","text":"子报告"}]}})).unwrap();
            }
            let actions = p.receive(json!({"type":"result","subtype":"success","session_id":"native","result":"父最终报告"})).unwrap();
            assert!(actions.iter().any(|a| matches!(a, Action::Emit {kind:"message",data} if data["text"] == "父最终报告" && data["agentKey"].is_null())));
        }
    }
    #[test]
    fn agent_error_without_structured_result_is_failed() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        p.receive(json!({"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"agent-tool","name":"Agent","input":{"prompt":"检查"}}]}})).unwrap();
        let actions = p.receive(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"agent-tool","is_error":true,"content":"启动失败"}]}})).unwrap();
        assert!(actions.iter().any(|a| matches!(a, Action::Emit {kind:"agent",data} if data["key"] == "agent-tool" && data["status"] == "failed")));
    }
    #[test]
    fn restored_agent_can_resume_and_finish_without_another_agent_call() {
        let mut p = Claude::new("root".into(), "继续".into(), None)
            .with_agents(vec![("old-tool".into(), Some("old-agent".into()))]);
        let resumed = p.receive(json!({"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"send","name":"SendMessage","input":{"to":"old-agent","message":"继续检查"}}]}})).unwrap();
        assert!(resumed.iter().any(|a| matches!(a, Action::Emit {kind:"agent",data} if data["key"] == "old-tool" && data["status"] == "running")));
        let done = p.receive(json!({"type":"system","subtype":"task_notification","task_id":"old-agent","status":"completed","summary":"已检查"})).unwrap();
        assert!(done.iter().any(|a| matches!(a, Action::Emit {kind:"agent",data} if data["key"] == "old-tool" && data["status"] == "completed")));
        let shell = p.receive(json!({"type":"system","subtype":"task_notification","task_id":"bash-task","tool_use_id":"bash","status":"completed"})).unwrap();
        assert!(!shell.iter().any(|a| matches!(a, Action::Emit {kind:"agent",..})));
    }
    fn edit_request() -> Value {
        json!({"type":"control_request","request_id":"tool-1","request":{
            "subtype":"can_use_tool","tool_name":"Edit",
            "input":{"file_path":"a.ts","old_string":"one","new_string":"two"}
        }})
    }
    #[test]
    fn edit_before_allow_returns_the_edited_input_without_new_keys() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        let actions = p.receive(edit_request()).unwrap();
        // canEdit 是服务端事实：只有 Claude 的答复有 updatedInput 这个位置，前端才准出现「改完再允许」。
        assert!(matches!(&actions[0], Action::Request { kind:"permission", data, .. } if data["canEdit"] == true));
        let written = p
            .respond("tool-1", json!({"allow": true, "input": {"new_string": "safe"}}))
            .unwrap();
        let updated = match &written[0] {
            Action::Write(value) => value["response"]["response"]["updatedInput"].clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(updated["new_string"], json!("safe"));
        // 没改到的键必须原样留着：改一个字段不该把文件路径也一起换掉。
        assert_eq!(updated["file_path"], json!("a.ts"));
        assert_eq!(updated["old_string"], json!("one"));
    }
    #[test]
    fn an_edit_that_reaches_outside_the_tool_contract_is_refused() {
        for answer in [
            json!({"allow":true,"input":{"bypass_permissions":true}}),
            json!({"allow":true,"input":{"file_path":"b.ts","old_string":"x","new_string":"y","extra":"z"}}),
            json!({"allow":true,"input":{}}),
            json!({"allow":true,"input":"a.ts"}),
        ] {
            let mut p = Claude::new("root".into(), "hi".into(), None);
            p.receive(edit_request()).unwrap();
            assert!(p.respond("tool-1", answer.clone()).is_err(), "{answer} 不该被接受");
        }
        // 不带 input 的普通允许照旧。
        let mut p = Claude::new("root".into(), "hi".into(), None);
        p.receive(edit_request()).unwrap();
        let written = p.respond("tool-1", json!({"allow":true})).unwrap();
        assert!(matches!(&written[0], Action::Write(v) if v["response"]["response"]["updatedInput"]["file_path"] == "a.ts"));
    }

    #[test]
    fn a_turn_with_background_tasks_parks_instead_of_finishing() {
        let mut p = Claude::new("root".into(), "hi".into(), Some("native".into()));
        let out = p.receive(json!({"type":"system","subtype":"background_tasks_changed","tasks":[{},{}]})).unwrap();
        assert!(matches!(&out[0], Action::Emit{kind:"background",data} if data["pending"] == 2));
        let out = p.receive(json!({"type":"result","subtype":"success","is_error":false,"session_id":"native","result":"done"})).unwrap();
        assert!(p.parked());
        assert!(!out.iter().any(|action| matches!(action, Action::Finish{..})), "后台任务未结束时不能报终态");
        assert!(out.iter().any(|action| matches!(action, Action::Emit{kind:"background",data} if data["settled"] == true)));
        // 后台任务全部结束后关 stdin，让 CLI 自己退出；跟进回合同样会到这里。
        let out = p.receive(json!({"type":"system","subtype":"background_tasks_changed","tasks":[]})).unwrap();
        assert!(out.iter().any(|action| matches!(action, Action::CloseInput)));
        let out = p.receive(json!({"type":"result","subtype":"success","is_error":false,"session_id":"native","result":"follow-up"})).unwrap();
        assert!(!p.parked());
        assert!(matches!(&out[out.len()-1], Action::Finish{status:"completed",..}));
    }

    #[test]
    fn permission_denials_and_mcp_snapshots_become_actions_not_silent_failures() {
        let mut p = Claude::new("root".into(), "hi".into(), None);
        let init = p.receive(json!({"type":"system","subtype":"init","session_id":"native","mcp_servers":[{"name":"docs","status":"connected"}],"tools":["mcp__docs__search"]})).unwrap();
        assert!(init.iter().any(|action| matches!(action, Action::Emit{kind:"mcp_servers",data} if data["servers"][0]["name"] == "docs")));
        p.receive(json!({"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"tool","name":"Read","input":{"file_path":"C:\\outside\\secret.txt"}}]}})).unwrap();
        let out = p.receive(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool","is_error":true,"content":"File access requires approval: outside workspace"}]}})).unwrap();
        assert!(out.iter().any(|action| matches!(action, Action::Emit{kind:"permission_denied",data} if data["tool"] == "Read" && data["path"] == "C:\\outside\\secret.txt")));
        // 同一拒绝在 result 的兜底清单里不再重复上报。
        let out = p.receive(json!({"type":"result","subtype":"success","is_error":false,"session_id":"native","result":"ok",
            "permission_denials":[{"tool_name":"Read","tool_input":{"file_path":"C:\\outside\\secret.txt"}}]})).unwrap();
        assert!(!out.iter().any(|action| matches!(action, Action::Emit{kind:"permission_denied",..})));
    }
}
