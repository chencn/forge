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
    command: Option<super::commands::CommandIntent>,
    /// 本轮是计划回合：计划正文与审阅卡片只在计划回合里产生。
    plan_mode: bool,
    /// 本轮是计划决策回合；它为一些线程先核对被审阅的计划。
    decision: Option<Decision>,
    /// thread/resume 报告的实际模型与强度；collaborationMode.settings 必须带模型。
    thread_model: Option<String>,
    thread_effort: Option<String>,
    /// 异步提问：内部请求键 → steer 所需上下文。
    async_questions: HashMap<String, AsyncQuestion>,
    /// 已发出的 turn/steer 请求 id；它们的回包只需吞掉，不能当成握手响应。
    steers: HashSet<u64>,
    next_steer: u64,
}
impl Codex {
    pub fn new(cwd: String, prompt: String, native_id: Option<String>) -> Self {
        Self {
            cwd,
            prompt,
            images: vec![],
            thread: native_id,
            turn: None,
            phase: 0,
            pending: HashMap::new(),
            stopped: false,
            model: None,
            effort: None,
            permission: Default::default(),
            service_tier: "default".into(),
            command: None,
            plan_mode: false,
            decision: None,
            thread_model: None,
            thread_effort: None,
            async_questions: HashMap::new(),
            steers: HashSet::new(),
            next_steer: 1_000_000,
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
    pub fn with_policy(mut self, permission: super::options::PermissionMode, service_tier: String) -> Self {
        self.permission = permission;
        self.service_tier = service_tier;
        self
    }
    pub fn with_command(mut self, command: Option<super::commands::CommandIntent>) -> Self {
        self.command = command;
        self
    }
    pub fn with_plan(mut self, plan: bool) -> Self {
        self.plan_mode = plan;
        self
    }
    pub fn with_decision(mut self, decision: Option<Decision>) -> Self {
        self.decision = decision;
        self
    }
    /// collaborationMode 的 settings.model 是必填项；拿不到模型就失败关闭，
    /// 发一个缺少必填字段的对象不是协商，而是无效请求。
    fn collaboration(mode: &str, model: Option<&str>, effort: Option<&str>) -> Result<Value, String> {
        let model = model.map(str::trim).filter(|model| !model.is_empty())
            .ok_or("Codex 未报告当前模型，无法进入计划模式")?;
        let mut settings = serde_json::Map::new();
        settings.insert("model".into(), json!(model));
        if let Some(effort) = effort.map(str::trim).filter(|effort| !effort.is_empty()) {
            settings.insert("reasoning_effort".into(), json!(effort));
        }
        Ok(json!({"mode":mode,"settings":Value::Object(settings)}))
    }
    /// `thread/turns/list`（itemsView=full）里核对被审阅的最终计划：
    /// id 与正文指纹都要对上，否则整个决策在开回合前失败。
    fn check_plan(page: &Value, native_plan_id: &str, expected_hash: &str) -> Result<(), String> {
        let turns = page["data"].as_array().ok_or("thread/turns/list 未返回回合页")?;
        for turn in turns {
            for item in turn["items"].as_array().into_iter().flatten() {
                if item["type"] != "plan" || item["id"].as_str() != Some(native_plan_id) {
                    continue;
                }
                let text = item["text"].as_str().ok_or("codex plan is stale: 计划条目缺少正文")?;
                return if super::plans::content_hash(text) == expected_hash {
                    Ok(())
                } else {
                    Err("codex plan is stale: 计划正文在等待审批期间已改变".into())
                };
            }
        }
        Err("codex plan is stale: 被审阅的计划已不在会话中".into())
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
            "item/permissions/requestApproval" => Ok(vec![
                // 过去这里直接回一个空的权限集，用户在时间线上什么都看不到：请求发生了、被拒了，
                // 但只有 CLI 知道。拒绝本身没错，悄悄拒绝才是问题。
                Action::Emit { kind: "notice", data: json!({"text":"Codex 申请扩大本会话权限，Forge 未批准，已按最小权限答复。","auto":"declined"}) },
                Action::Write(json!({"id":id,"result":{"permissions":{}}})),
            ]),
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
        // collaborationMode 与 plan item 在 0.163.0 schema 里属于实验能力：
        // 只有计划回合/决策回合才显式打开，普通对话保持关闭。
        let experimental = self.plan_mode || self.decision.is_some();
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
                "item/plan/delta" if self.plan_mode => {
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
                                "commandExecution" => ("exec".to_owned(), json!({"command":item["command"],"cwd":item["cwd"],"commandActions":item["commandActions"]}), json!({"exitCode":item["exitCode"],"durationMs":item["durationMs"]}), item["aggregatedOutput"].clone()),
                                "fileChange" => ("apply_patch".to_owned(), json!({"changes":item["changes"]}), json!({"status":item["status"]}), item["aggregatedOutput"].clone()),
                                "mcpToolCall" => (item["tool"].as_str().unwrap_or("mcp").to_owned(), json!({"kind":"mcp","server":item["server"],"tool":item["tool"],"arguments":item["arguments"]}), json!({"result":item["result"],"error":item["error"],"status":item["status"]}), item["result"].clone()),
                                "dynamicToolCall" => (item["tool"].as_str().unwrap_or("tool").to_owned(), json!({"kind":"dynamic","namespace":item["namespace"],"tool":item["tool"],"arguments":item["arguments"]}), json!({"success":item["success"],"contentItems":item["contentItems"]}), item["contentItems"].clone()),
                                "webSearch" => ("webSearch".to_owned(), json!({"kind":"search","query":item["query"],"action":item["action"]}), json!({"results":item["results"]}), item["results"].clone()),
                                _ => unreachable!(),
                            };
                            out.push(Action::Emit {kind:"tool",data:json!({"id":id,"name":name,"input":input,"result":result,"output":output,"status":status})});
                            if done && item["type"] == "fileChange" {
                                let paths: Vec<_> = item["changes"]
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
                            for (index, summary) in item["summary"].as_array().into_iter().flatten().enumerate() {
                                if let Some(text) = summary.as_str() { out.push(Action::Emit { kind: "reasoning", data: json!({"id":format!("{id}-{index}"),"text":text}) }); }
                            }
                        }
                        "exitedReviewMode" if done => out.push(Action::Emit { kind: "message", data: json!({"id":id,"text":item["review"].as_str().unwrap_or("")}) }),
                        // 完成后的 plan item 才是权威正文；它替换流式预览，并成为审阅卡片。
                        "plan" if done && self.plan_mode => {
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
                        "contextCompaction" => out.push(Action::Emit { kind: "compaction", data: json!({"id":id,"status":if done {"completed"} else {"running"}}) }),
                        _ => {}
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
                // thread/compacted 已被 schema 标记废弃；contextCompaction item 才有稳定 ID 和起止状态。
                "thread/compacted" => {},
                "model/rerouted" => out.push(Action::Emit { kind: "configuration", data: json!({"model":p["toModel"]}) }),
                "item/fileChange/patchUpdated" => out.push(Action::Emit {
                    kind: "tool",
                    data: json!({"id":p["itemId"],"inputPatch":{"changes":p["changes"]}}),
                }),
                "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => out.push(Action::Emit {
                    kind: "tool",
                    data: json!({"id":p["itemId"],"outputDelta":p["delta"]}),
                }),
                "thread/tokenUsage/updated" => out.push(Action::Emit {
                    kind: "usage",
                    data: p.clone(),
                }),
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
                if self.decision.is_some() {
                    // 决策回合先重取最终计划条目，证明它仍在线且正文未变；
                    // 对不上就在开回合之前失败，绝不执行一份已经变过的计划。
                    self.phase = 4;
                    return Ok(vec![Action::Write(json!({"id":3,"method":"thread/turns/list","params":{
                        "threadId":id,"itemsView":"full","limit":16,"sortDirection":"desc"
                    }}))]);
                }
                self.phase = 3;
                let mut input = vec![];
                if !self.prompt.trim().is_empty() { input.push(json!({"type":"text","text":self.prompt})); }
                input.extend(self.images.iter().map(|path| json!({"type":"localImage","path":path})));
                let mut turn = json!({"threadId":id,"input":input});
                if self.plan_mode {
                    // collaborationMode 优先于顶层 model/effort，两者只能发一种。
                    turn["collaborationMode"] = Self::collaboration(
                        "plan",
                        self.model.as_deref().or(self.thread_model.as_deref()),
                        self.effort.as_deref(),
                    )?;
                } else {
                    if let Some(model) = &self.model {
                        turn["model"] = json!(model);
                    }
                    if let Some(effort) = &self.effort {
                        turn["effort"] = json!(effort);
                    }
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
                        data: json!({"model":result["model"],"modelProvider":result["modelProvider"],"approvalPolicy":result["approvalPolicy"],"sandbox":result["sandbox"]}),
                    },
                    Action::Write(json!({"id":3,"method":method,"params":params})),
                ])
            }
            (4, 3) => {
                let decision = self.decision.clone().ok_or("Codex 决策状态丢失")?;
                Self::check_plan(result, &decision.native_plan_id, &decision.content_hash)?;
                let thread = self.thread.clone().ok_or("Codex 决策缺少会话")?;
                let mut turn = json!({"threadId":thread,"input":[{"type":"text","text":self.prompt}]});
                // 线程元数据没有模式字段，客户端必须显式重申；settings 继承当前模型/强度。
                turn["collaborationMode"] = Self::collaboration(
                    decision.mode,
                    self.thread_model.as_deref(),
                    self.thread_effort.as_deref(),
                )?;
                if !self.service_tier.is_empty() { turn["serviceTierForTurn"] = json!(self.service_tier); }
                self.phase = 5;
                Ok(vec![Action::Write(json!({"id":4,"method":"turn/start","params":turn}))])
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
}
#[cfg(test)]
mod tests {
    use super::*;
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
        p.start().unwrap();
        let actions = p.receive(json!({"id":1,"result":{}})).unwrap();
        let params = actions.iter().find_map(|a| match a { Action::Write(v) if v["method"] == "thread/start" => Some(&v["params"]), _ => None }).unwrap();
        assert_eq!(params, &json!({"cwd":"root"}));
        let actions = p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"model":"configured","approvalPolicy":"never","sandbox":{"type":"readOnly"}}})).unwrap();
        let params = actions.iter().find_map(|a| match a { Action::Write(v) if v["method"] == "turn/start" => Some(&v["params"]), _ => None }).unwrap();
        assert!(params.get("serviceTierForTurn").is_none());
        assert!(params.get("model").is_none());
        assert!(params.get("effort").is_none());
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
        let out=p.receive(json!({"id":20,"method":"item/permissions/requestApproval","params":{"permissions":{"network":{"enabled":true}}}})).unwrap();
        // 一个权限都不给：答复仍是空的权限集，只是现在先在对人的一侧重复一遍。
        assert!(matches!(&out[1],Action::Write(v) if v["result"]["permissions"]==json!({})));
        assert!(matches!(&out[0],Action::Emit{kind:"notice",data} if data["auto"]=="declined"));
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
    fn silently_refused_requests_now_appear_in_the_timeline() {        for (method, params) in [
            ("item/permissions/requestApproval", json!({"permissions":{"network":"enable"}})),
            ("mcpServer/elicitation/request", json!({"message":"需要额外授权"})),
        ] {
            let mut p = Codex::new("root".into(), "text".into(), None);
            let actions = p.receive(json!({"id":7,"method":method,"params":params})).unwrap();
            assert!(matches!(&actions[0],Action::Emit{kind:"notice",data} if data["auto"]=="declined"), "{method} 仍被静默拒绝");
            assert!(matches!(&actions[1],Action::Write(v) if v["id"] == json!(7)), "{method} 没有回信");
        }
        // 扩权限那条仍然一个权限都不给。
        let mut p = Codex::new("root".into(), "text".into(), None);
        let actions = p.receive(json!({"id":8,"method":"item/permissions/requestApproval","params":{}})).unwrap();
        assert!(matches!(&actions[1],Action::Write(v) if v["result"]["permissions"].as_object().is_some_and(|map| map.is_empty())));
    }

    fn started_thread(p: &mut Codex) {
        p.start().unwrap();
        p.receive(json!({"id":1,"result":{}})).unwrap();
        p.receive(json!({"id":2,"result":{"thread":{"id":"native"},"model":"gpt-5","approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"}}})).unwrap();
        p.receive(json!({"id":3,"result":{"turn":{"id":"turn-1"}}})).unwrap();
    }

    #[test]
    fn plan_turn_uses_collaboration_mode_and_emits_the_completed_plan() {
        let mut p = Codex::new("root".into(), "设计一下".into(), Some("native".into())).with_policy(super::super::options::PermissionMode::Inherit, String::new()).with_plan(true);
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
    fn plan_mode_without_a_model_fails_closed_instead_of_sending_invalid_settings() {
        let mut p = Codex::new("root".into(), "设计".into(), None).with_policy(super::super::options::PermissionMode::Inherit, String::new()).with_plan(true);
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
