//! 本地 CLI 对话的受限命令集：不接受任意 RPC，也不执行任意可执行文件。
//! Restricted desktop commands for local CLI conversations. No arbitrary RPC or executable IPC.
mod approvals;
mod claude;
mod activity;
mod commands;
mod codex;
mod events;
mod history;
mod images;
#[cfg(test)]
mod integration_tests;
mod options;
mod outline;
mod plans;
mod process;
mod protocol;
mod registry;
mod search;
mod store;
mod task_status;

use crate::ai_cli::{self, Provider};
use crate::offload::block;
use events::{Page, CHANNEL};
use process::{Input, Process};
use protocol::{Action, Protocol};
use registry::{Control, Run};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{atomic::Ordering, mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// 前端发起一轮对话的请求。`deny_unknown_fields` 让多余字段直接失败，
/// 避免前端悄悄传了拼错的名字却被静默忽略。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendRequest {
    /// 会话 id；必须是已存在或可新建的合法 id（只含字母数字与连字符）。
    session_id: String,
    /// 本轮运行 id；同会话内不能与正在跑的那一轮重复。
    run_id: String,
    /// 用哪个 CLI 跑这一轮。
    provider: Provider,
    /// 工作区根路径；后端会规范化并校验它确实存在。
    workspace: String,
    /// 会话标题；新会话用它写入元数据，已有会话以存储里的为准。
    title: String,
    /// 用户本轮输入。
    prompt: String,
    /// 由图片沙箱生成并复核的本地图片路径。
    #[serde(default)]
    images: Vec<String>,
    /// 用户是否已确认信任该项目及其 CLI 配置；未信任时前端不会发这条请求。
    trusted: bool,
    /// 指定的模型；不传则用 CLI 默认。
    #[serde(default)]
    model: Option<String>,
    /// 指定的思考强度；不传则用 CLI 默认，是否可用取决于模型。
    #[serde(default)]
    effort: Option<String>,
    #[serde(default)]
    permission: options::PermissionMode,
    #[serde(default)]
    fast: Option<bool>,
    /// Codex 入队时从 config/read 冻结的有效服务等级；不接受前端伪造。
    #[serde(skip)]
    service_tier: Option<String>,
    #[serde(default)]
    command: Option<commands::CommandIntent>,
    /// 计划模式：这一轮只产出计划，不执行修改。
    #[serde(default)]
    plan_mode: bool,
    /// 对已有计划的决策（仅 Codex 支持）。前端只提交 id/版本/决策/反馈。
    #[serde(default)]
    plan: Option<PlanRequest>,
    /// 用户已批准的额外目录。只接受已存在的绝对目录，由后端重新校验。
    #[serde(default)]
    additional_dirs: Vec<String>,
    /// 决策回合的内部执行快照；绝不从前端接收。
    #[serde(skip)]
    plan_turn: Option<PlanTurn>,
}

/// 前端提交的计划决策。批准不携带任何原生参数，执行指令由后端常量给出。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanRequest {
    plan_id: String,
    revision: i64,
    decision: plans::Decision,
    #[serde(default)]
    feedback: Option<String>,
}

/// 已被 CAS 抢占的决策；回合真正开起来才标记 applied，失败则退回/过期。
#[derive(Clone)]
struct PlanTurn {
    plan_id: String,
    revision: i64,
    decision: plans::Decision,
    previous: plans::Status,
    native_plan_id: String,
    content_hash: String,
}

/// 批准后发给模型的一句固定指令：批准路径不携带用户正文，
/// 否则「批准了什么」会被附言稀释。
const EXECUTE_PLAN_PROMPT: &str = "The plan has been reviewed and approved. Leave plan mode and implement it exactly as approved: do not rewrite the plan, start executing now.";

/// 待执行任务只保存在本次应用进程；状态会落盘，但崩溃后绝不自动重放工具操作。
static QUEUED: OnceLock<Mutex<HashMap<String, VecDeque<SendRequest>>>> = OnceLock::new();
/// Claude 旧帧只在顶层给结构化结果：单结果可直接关联，多结果必须按工具 ID 精确匹配。
fn structured_tool_result<'a>(value: Option<&'a Value>, id: &str, result_count: usize) -> Option<&'a Value> {
    let value = value?;
    if result_count == 1 { return Some(value); }
    if let Some(items) = value.as_array() {
        return items.iter().find(|item| item["tool_use_id"].as_str() == Some(id) || item["toolUseId"].as_str() == Some(id) || item["id"].as_str() == Some(id));
    }
    (value["tool_use_id"].as_str() == Some(id) || value["toolUseId"].as_str() == Some(id) || value["id"].as_str() == Some(id)).then_some(value)
}
fn queued() -> &'static Mutex<HashMap<String, VecDeque<SendRequest>>> { QUEUED.get_or_init(Mutex::default) }
fn has_queued(session_id: &str) -> bool {
    queued().lock().unwrap_or_else(|e| e.into_inner()).get(session_id).is_some_and(|items| !items.is_empty())
}
fn queued_count(session_id: &str) -> usize {
    queued().lock().unwrap_or_else(|e| e.into_inner()).get(session_id).map_or(0, VecDeque::len)
}

/// 队列调度属于桌面进程，不属于某个 React 页面。这样切换工程或关闭标签后，
/// 外部 CLI 一旦结束，等待中的队首仍会被唤醒。
pub fn start_queue_monitor(app: AppHandle) -> Result<(), String> {
    std::thread::Builder::new().name("forge-ai-queue-monitor".into()).spawn(move || loop {
        let session_ids = queued().lock().unwrap_or_else(|error| error.into_inner()).keys().cloned().collect::<Vec<_>>();
        for session_id in session_ids { let _ = schedule_next(&app, &session_id); }
        std::thread::sleep(Duration::from_secs(1));
    }).map(|_| ()).map_err(|error| format!("无法启动 AI 队列监控：{error}"))
}
/// 从内存队列中取出指定任务。取消必须按 run id 精确命中，不能误伤同会话的其他任务。
fn take_queued_run(run_id: &str) -> Result<Option<(String, SendRequest)>, String> {
    let mut all = queued().lock().map_err(|e| e.to_string())?;
    let session_id = all.iter().find_map(|(session_id, items)| {
        items.iter().any(|item| item.run_id == run_id).then(|| session_id.clone())
    });
    let Some(session_id) = session_id else { return Ok(None); };
    let items = all.get_mut(&session_id).expect("queued session disappeared while locked");
    let index = items.iter().position(|item| item.run_id == run_id).expect("queued run disappeared while locked");
    let request = items.remove(index);
    if items.is_empty() { all.remove(&session_id); }
    Ok(request.map(|request| (session_id, request)))
}
/// 排队状态只描述这一项自己的处境：只有队首可能被外部 CLI 直接挡住，排在后面的项
/// 是在排队首。两条路径（入队、顺序变更）共用这个判定，否则会写出互相矛盾的日志。
fn queued_status(is_front: bool, external_blocked: bool) -> &'static str {
    if is_front && external_blocked { task_status::WAITING_EXTERNAL } else { task_status::QUEUED }
}
/// 这一轮开不开得起来：外部进程占着会话，或 Codex 的原生写锁还握在别的窗口手里。
/// 后者是必须的——徽标会按回合边界把「持锁但没在跑」报成空闲，而 `thread/resume` 不认：
/// 只要锁有人握着就当场拒。探测失败按「不挡」处理，和判定改动前一致，不让读锁的IO错误堵住发送。
fn externally_blocked(base: &std::path::Path, session_id: &str, root: &str) -> bool {
    matches!(activity::state(base, session_id, root), Ok(activity::State::External | activity::State::Conflict))
        || activity::writer_held(base, session_id, root).unwrap_or(false)
}
/// 队列变更后把真实顺序写入事件流，所有窗口据此得到同一顺序。
fn emit_queue_order(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let items = queued().lock().map_err(|e| e.to_string())?.get(session_id).cloned().unwrap_or_default();
    // 只有队首真的被外部 CLI 挡住。排在后面的项是在等队首，不能一并贴上「等待外部任务」，
    // 否则整条队列看起来都被外部进程卡住，而真实原因只是排位靠后。
    let head_blocked = match items.front() {
        Some(request) if registry::for_session(session_id).is_none() => {
            let root = store::workspace(&request.workspace)?;
            let base = base(app)?;
            externally_blocked(&base, session_id, &root)
        }
        _ => false,
    };
    for (queue_index, request) in items.into_iter().enumerate() {
        // 每一项按自己的位置重新判定，整条队列一次写全，不允许只贴一部分。
        let status = queued_status(queue_index == 0, head_blocked);
        append_task_status(app, &request, status, json!({"prompt":request.prompt,"queueIndex":queue_index}), false)?;
    }
    Ok(())
}

/// 队列活在收下它的那个进程的内存里：这条查不到有两种真实原因——已经开始或结束了，
/// 或者是**另一个** Forge 窗口排的。只说「不存在」会把后一种推给「界面坏了」，
/// 所以把两种都点名，并说清去哪儿操作。跨窗口共用一份队列需要另建持久队列，现在还没到那一步。
const NOT_QUEUED_HERE: &str = "这条任务不在当前窗口的队列里：它可能已经开始或结束，也可能由另一个 Forge 窗口排队（排队时用的是哪个窗口，就到哪个窗口操作）";

#[tauri::command]
pub async fn ai_runtime_queue_update(app: AppHandle, run_id: String, prompt: String) -> Result<(), String> {
    block(move || {
        let _lifecycle = registry::LIFECYCLE.lock().map_err(|e| e.to_string())?;
        let prompt = prompt.trim();
        if prompt.is_empty() || prompt.len() > 64 * 1024 { return Err("消息不能为空，且不能超过 64 KiB".into()); }
        let session_id = {
            let mut all = queued().lock().map_err(|e| e.to_string())?;
            let (session_id, item) = all.iter_mut().find_map(|(session_id, items)| items.iter_mut().find(|item| item.run_id == run_id).map(|item| (session_id.clone(), item))).ok_or(NOT_QUEUED_HERE)?;
            item.prompt = prompt.to_owned();
            session_id
        };
        // 顺序事件已经带上新的 prompt，这里不再单独补一条：先落一条「queued」
        // 会把仍在等外部 CLI 的队首瞬间标成普通排队项。
        emit_queue_order(&app, &session_id)
    }).await
}

#[tauri::command]
pub async fn ai_runtime_queue_move(app: AppHandle, run_id: String, before_run_id: Option<String>) -> Result<(), String> {
    block(move || {
        let _lifecycle = registry::LIFECYCLE.lock().map_err(|e| e.to_string())?;
        let session_id = {
            let mut all = queued().lock().map_err(|e| e.to_string())?;
            let session_id = all.iter().find_map(|(session_id, items)| items.iter().any(|item| item.run_id == run_id).then(|| session_id.clone())).ok_or(NOT_QUEUED_HERE)?;
            let items = all.get_mut(&session_id).ok_or("排队会话不存在")?;
            let old = items.iter().position(|item| item.run_id == run_id).ok_or(NOT_QUEUED_HERE)?;
            if before_run_id.as_deref() == Some(run_id.as_str()) { return Ok(()); }
            let item = items.remove(old).ok_or(NOT_QUEUED_HERE)?;
            // 用稳定 run id 定位，避免另一个窗口改过队列后旧下标把任务移错位置。
            let target = match before_run_id.as_deref() {
                Some(before) => items.iter().position(|item| item.run_id == before).ok_or(NOT_QUEUED_HERE)?,
                None => items.len(),
            };
            items.insert(target, item);
            session_id
        };
        emit_queue_order(&app, &session_id)
    }).await
}

#[tauri::command]
pub async fn ai_runtime_queue_run_now(app: AppHandle, run_id: String) -> Result<(), String> {
    block(move || {
        let (session_id, stopping) = {
            let _lifecycle = registry::LIFECYCLE.lock().map_err(|e| e.to_string())?;
            let session_id = {
                let mut all = queued().lock().map_err(|e| e.to_string())?;
                let session_id = all.iter().find_map(|(session_id, items)| items.iter().any(|item| item.run_id == run_id).then(|| session_id.clone())).ok_or(NOT_QUEUED_HERE)?;
                let items = all.get_mut(&session_id).ok_or("排队会话不存在")?;
                let index = items.iter().position(|item| item.run_id == run_id).ok_or(NOT_QUEUED_HERE)?;
                let item = items.remove(index).ok_or(NOT_QUEUED_HERE)?;
                items.push_front(item);
                session_id
            };
            emit_queue_order(&app, &session_id)?;
            // 单会话只能有一个回合；“立即执行”先在锁内决定停掉当前 Forge 回合，
            // 退出后由该回合的收尾统一调度队首。
            (session_id.clone(), registry::for_session(&session_id))
        };
        // 等待清理放在锁外：一个卡住的回合不该按住所有会话的发送和队列调度。
        if let Some(run) = stopping { return run.wait_until_stopped(); }
        schedule_next(&app, &session_id)
    }).await
}

#[tauri::command]
pub async fn ai_runtime_queue_clear(app: AppHandle, session_id: String) -> Result<(), String> {
    block(move || {
        let _lifecycle = registry::LIFECYCLE.lock().map_err(|e| e.to_string())?;
        if !store::valid_id(&session_id) { return Err("无效会话 ID".into()); }
        cancel_queued(&app, |request| request.session_id == session_id)
    }).await
}

/// 清空符合条件的排队任务，并把每项都落成 cancelled；任务从内存移除后绝不自动重放。
fn cancel_queued(app: &AppHandle, mut matches: impl FnMut(&SendRequest) -> bool) -> Result<(), String> {
    let removed = {
        let mut all = queued().lock().map_err(|e| e.to_string())?;
        let mut removed = Vec::new();
        all.retain(|_, items| {
            let mut kept = VecDeque::new();
            while let Some(item) = items.pop_front() {
                if matches(&item) { removed.push(item); } else { kept.push_back(item); }
            }
            *items = kept;
            !items.is_empty()
        });
        removed
    };
    let mut first_error = None;
    for request in removed {
        if let Err(error) = append_task_status(app, &request, task_status::CANCELLED, json!({}), false) {
            if first_error.is_none() { first_error = Some(error); }
        }
        // 排队中的计划决策被取消时，提交权必须退回待审，否则计划会永远停在 submitting。
        if let Some(claim) = &request.plan_turn {
            settle_plan_failure(app, &request, claim, "任务已取消");
        }
    }
    first_error.map_or(Ok(()), Err)
}
/// 锁内给所有已登记的回合置停止位，句柄交给调用方，等待一律放到锁外。
fn stop_registered() -> Vec<Arc<Run>> {
    let runs = registry::all();
    registry::flag_stop(&runs);
    runs
}
fn append_task_status(app: &AppHandle, request: &SendRequest, status: &str, extra: Value, include_user: bool) -> Result<(), String> {
    let root = store::workspace(&request.workspace)?;
    let base = base(app)?;
    let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
    let mut store = store::Store::open(&base, &request.session_id, &root, request.provider, &request.title, "")?;
    let mut data = json!({"status":status});
    if let (Some(target), Some(source)) = (data.as_object_mut(), extra.as_object()) { target.extend(source.clone()); }
    let mut events = vec![];
    if include_user { events.push(("user".into(), json!({"text":request.prompt,"images":request.images}))); }
    events.push(("status".into(), data));
    let events = store.append(&request.run_id, events)?;
    // 附件只有写进日志才算被历史引用：标记打在 append 之后，失败的写入不留标记。
    if include_user {
        images::mark_referenced(app, &request.images);
    }
    let _ = app.emit(CHANNEL, &events);
    Ok(())
}
fn base(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("ai-sessions-v1");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
fn enabled(app: &AppHandle) -> Result<(), String> {
    if crate::settings::read(app).ai_assistants_enabled {
        Ok(())
    } else {
        Err("AI 助手已关闭".into())
    }
}
fn validate(request: &SendRequest) -> Result<(), String> {
    commands::validate(request.provider, &request.prompt, request.command)?;
    if request.command.is_some() && !request.images.is_empty() {
        return Err("斜杠命令不能附加图片".into());
    }
    if request.plan_mode && (request.command.is_some() || request.permission == options::PermissionMode::Full) {
        return Err("计划模式不能同时使用斜杠命令或完全访问".into());
    }
    if let Some(plan) = &request.plan {
        // 决策回合由后端生成唯一的执行正文；前端只能提交 id、版本、决策与反馈。
        if request.provider != Provider::Codex {
            return Err("计划审阅目前只支持 Codex".into());
        }
        if plan.plan_id.trim().is_empty() || plan.plan_id.len() > 512 || plan.revision < 1 {
            return Err("计划审阅标识无效".into());
        }
        if request.plan_mode || request.command.is_some() || !request.images.is_empty() || !request.prompt.trim().is_empty() {
            return Err("计划决策不能附带正文、命令、图片或计划模式".into());
        }
        if plan.decision == plans::Decision::Defer {
            return Err("暂不执行不会启动回合".into());
        }
        if plan.decision == plans::Decision::RequestChanges
            && plan.feedback.as_deref().map(str::trim).filter(|text| !text.is_empty()).is_none()
        {
            return Err("要求修改必须填写说明".into());
        }
    }
    if request.provider == Provider::Claude && request.fast == Some(true) {
        return Err("Fast 目前仅支持 Codex".into());
    }
    options::validate(
        request.provider,
        request.model.as_deref(),
        request.effort.as_deref(),
    )?;
    if !store::valid_id(&request.session_id) || !store::valid_id(&request.run_id) {
        return Err("无效会话或运行 ID".into());
    }
    if !request.trusted {
        return Err("启动前需要确认信任此项目及其 CLI 配置、hooks 和 MCP".into());
    }
    if request.prompt.trim().is_empty() && request.images.is_empty() && request.plan.is_none() || request.prompt.len() > 64 * 1024 {
        return Err("消息和图片不能同时为空，且消息不能超过 64 KiB".into());
    }
    if request.title.trim().is_empty() || request.title.chars().count() > 120 {
        return Err("无效会话标题".into());
    }
    Ok(())
}

/// Codex 入队时冻结项目配置的模型、强度与服务等级；权限是本轮输入框的显式选择，
/// 不在这里覆盖，否则每次发送都会退回原生配置、界面选过的档位等于没选。
fn freeze_codex_config(request: &mut SendRequest, config: &Value) {
    request.model = config["model"].as_str().map(str::to_owned);
    request.effort = config["effort"].as_str().map(str::to_owned);
    request.service_tier = config["serviceTier"].as_str().map(str::to_owned);
    request.fast = None;
}

/// 额外目录：绝对、存在、是目录、去重且不与工作区重复；上限防止把参数表撑爆。
fn validated_dirs(request: &SendRequest, root: &str) -> Result<Vec<String>, String> {
    if request.additional_dirs.len() > 16 {
        return Err("额外目录最多 16 个".into());
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in &request.additional_dirs {
        let path = PathBuf::from(raw.trim());
        if !path.is_absolute() || raw.len() > 1024 {
            return Err("额外目录必须是绝对路径".into());
        }
        let canonical = std::fs::canonicalize(&path).map_err(|_| format!("额外目录不存在：{}", path.display()))?;
        if !canonical.is_dir() {
            return Err("额外目录必须是文件夹".into());
        }
        let value = canonical.to_string_lossy().into_owned();
        if same_workspace_path(&value, root) || !seen.insert(value.clone()) {
            continue;
        }
        out.push(value);
    }
    Ok(out)
}

#[tauri::command]
pub async fn ai_runtime_save_pasted_image(app: AppHandle, data_url: String) -> Result<Value, String> {
    // 与其他 AI 命令一致：总开关关掉时不写盘。否则关闭状态仍能借这个入口往缓存里堆文件。
    block(move || {
        enabled(&app)?;
        // 保存成功后前端立刻拿沙箱路径经 asset 协议回显（欢迎页不经过 ai_runtime_load，
        // 那里的授权不会顺带建立），这里先授一次；重复授权是幂等的。
        images::allow_assets(&app)?;
        images::save(&app, &data_url)
    })
    .await
}

/// 文件选择器与拖拽投放的入口：交进来的是本机绝对路径，复制进沙箱后 CLI 只读副本。
#[tauri::command]
pub async fn ai_runtime_save_image_file(app: AppHandle, path: String) -> Result<Value, String> {
    block(move || {
        enabled(&app)?;
        images::allow_assets(&app)?;
        images::save_file(&app, &path)
    })
    .await
}

/// 输入框里撤掉一张还没发出去的附件；已经进历史的由后端拒绝，只能随会话删除。
#[tauri::command]
pub async fn ai_runtime_delete_image(app: AppHandle, path: String) -> Result<(), String> {
    block(move || {
        enabled(&app)?;
        images::delete(&app, &path)
    })
    .await
}

/// 附件上限的唯一来源：前端拿它做前置提示，不再自己抄一份数字。
#[tauri::command]
pub async fn ai_runtime_image_limits(app: AppHandle) -> Result<Value, String> {
    block(move || {
        enabled(&app)?;
        // 欢迎页挂载时只调这一个命令；顺手把回显要用的授权建好。
        images::allow_assets(&app)?;
        Ok(images::limits())
    })
    .await
}

/// 权限拒绝通常指向一个文件；`--add-dir` 要的是目录。由后端判断真实类型，
/// 前端不靠扩展名猜「这是文件还是文件夹」。
#[tauri::command]
pub async fn ai_runtime_directory_for_path(app: AppHandle, path: String) -> Result<String, String> {
    block(move || {
        enabled(&app)?;
        let candidate = PathBuf::from(path.trim());
        if !candidate.is_absolute() || path.len() > 1024 {
            return Err("需要绝对路径才能授权目录".into());
        }
        let canonical = std::fs::canonicalize(&candidate).map_err(|_| "路径已不存在".to_string())?;
        let dir = if canonical.is_dir() {
            canonical
        } else {
            canonical.parent().ok_or("无法确定文件所在目录")?.to_path_buf()
        };
        Ok(dir.to_string_lossy().into_owned())
    }).await
}

#[tauri::command]
pub async fn ai_runtime_project_config(app: AppHandle, workspace: String) -> Result<Value, String> {
    block(move || { enabled(&app)?; options::codex_project_config(&store::workspace(&workspace)?) }).await
}

#[tauri::command]
pub async fn ai_runtime_update_project_config(app: AppHandle, workspace: String, patch: Value) -> Result<Value, String> {
    block(move || {
        enabled(&app)?;
        if ai_cli::management_busy() { return Err("CLI 管理进行中，无法修改项目配置".into()); }
        options::update_codex_project_config(&store::workspace(&workspace)?, &patch)
    }).await
}

#[tauri::command]
pub async fn ai_runtime_project_trusted(workspace: String) -> Result<bool, String> {
    block(move || { store::workspace(&workspace)?; Ok(options::codex_project_trusted(&workspace)) }).await
}

#[tauri::command]
pub async fn ai_runtime_models(
    app: AppHandle,
    provider: Provider,
    workspace: String,
) -> Result<Value, String> {
    block(move || {
        enabled(&app)?;
        let catalog = options::cached_models(&models_path(&app)?, provider);
        Ok(if provider == Provider::Claude { options::claude_configured_models(catalog, &store::workspace(&workspace)?) } else { catalog })
    })
    .await
}

fn models_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("ai-models.json"))
}

// 记「哪一版 CLI 探过」：CLI 升级会带来新模型，一次探测不能封住整个进程的目录。
static MODEL_REFRESH: tokio::sync::Mutex<Vec<(Provider, String)>> = tokio::sync::Mutex::const_new(Vec::new());
#[tauri::command]
pub async fn ai_runtime_refresh_models(app: AppHandle, provider: Provider, workspace: String, force: bool) -> Result<Value, String> {
    let path = models_path(&app)?;
    let (probe_provider, probe_path) = (provider, path.clone());
    let (version, current) = block(move || {
        // 版本探测自身会跑 `--version`，结果进程级缓存；取不到版本就退回「本进程只试一次」。
        let version = ai_cli::installed_version(probe_provider).unwrap_or_default();
        let current = !version.is_empty() && options::is_current(&probe_path, probe_provider, &version);
        Ok((version, current))
    })
    .await?;
    let mut attempted = MODEL_REFRESH.lock().await;
    let key = (provider, version);
    if !force && (current || attempted.contains(&key)) { return ai_runtime_models(app, provider, workspace).await; }
    enabled(&app)?;
    if ai_cli::management_busy() { return Err("CLI 管理进行中，请稍后刷新模型".into()); }
    if !attempted.contains(&key) { attempted.push(key); }
    block(move || {
        let root = store::workspace(&workspace)?;
        let catalog = options::models(provider, &root)?;
        let mut saved = options::save_models(&path, provider, Some(catalog), None)?;
        // 这一次是现问 CLI 拿的，和从磁盘读缓存不同；前端靠它区分「实测」与「沿用上次目录」。
        saved["remote"] = json!(true);
        Ok(if provider == Provider::Claude { options::claude_configured_models(saved, &root) } else { saved })
    }).await
}

#[tauri::command]
pub async fn ai_runtime_save_model(app: AppHandle, provider: Provider, model: String) -> Result<Value, String> {
    block(move || {
        enabled(&app)?;
        options::save_models(&models_path(&app)?, provider, None, Some(model.trim()))
    }).await
}

/// 设置页要列出用户自己加过的模型；这条命令不探测 CLI，也不依赖当前项目。
#[tauri::command]
pub async fn ai_runtime_custom_models(app: AppHandle, provider: Provider) -> Result<Vec<String>, String> {
    block(move || {
        enabled(&app)?;
        let catalog = options::cached_models(&models_path(&app)?, provider);
        Ok(catalog["customModels"].as_array().map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default())
    })
    .await
}

#[tauri::command]
pub async fn ai_runtime_remove_model(app: AppHandle, provider: Provider, model: String) -> Result<(), String> {
    block(move || { enabled(&app)?; options::remove_model(&models_path(&app)?, provider, &model) }).await
}
#[tauri::command]
pub async fn ai_runtime_create(app: AppHandle, provider: Provider, workspace: String, session_id: Option<String>, title: String) -> Result<Value, String> {
    block(move || {
        enabled(&app)?;
        if !ai_cli::settings::enabled(&app, provider) { return Err("该 CLI 已在设置中停用，请先在设置中启用".into()); }
        let root = store::workspace(&workspace)?;
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 120 { return Err("无效会话标题".into()); }
        let base = base(&app)?;
        let record = if provider == Provider::Codex {
            options::codex_create_thread(&root, title)?
        } else {
            let id = session_id.filter(|id| store::valid_id(id)).ok_or("Claude 会话 ID 无效")?;
            json!({"id":id,"title":title,"createdAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as u64})
        };
        let id = record["id"].as_str().ok_or("CLI 未返回会话 ID")?;
        let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
        let mut target = store::Store::open(&base, id, &root, provider, title, "")?;
        if provider == Provider::Codex { target.bind(id.to_owned())?; }
        Ok(json!({"id":id,"provider":provider,"title":record["title"],"createdAt":record["createdAt"]}))
    }).await
}
#[tauri::command]
pub async fn ai_runtime_activity(app: AppHandle, workspace: String, session_ids: Vec<String>) -> Result<Vec<Value>, String> {
    block(move || {
        enabled(&app)?;
        if session_ids.len() > 2000 { return Err("会话数量超过单次检查上限".into()); }
        let root = store::workspace(&workspace)?;
        let base = base(&app)?;
        let mut probe = activity::Probe::default();
        let mut records = Vec::with_capacity(session_ids.len());
        for id in session_ids {
            let mut state = probe.state(&base, &id, &root).unwrap_or(activity::State::Unknown);
            // 外部 CLI 的真实 task 结束后，由轮询唤醒 FIFO 队首；空闲窗口从来不会挡队列。
            if has_queued(&id) && matches!(state, activity::State::Idle) {
                schedule_next(&app, &id)?;
                state = probe.state(&base, &id, &root).unwrap_or(activity::State::Unknown);
            }
            let count = queued_count(&id);
            records.push(json!({"sessionId":id,"state":state,"queuedCount":count}));
        }
        Ok(records)
    }).await
}

#[tauri::command]
pub async fn ai_runtime_send(app: AppHandle, mut request: SendRequest) -> Result<Value, String> {
    block(move || {
        // 附件复核最多读 8 张 ×8 MiB 并重算魔数，先做完再拿跨会话锁：握着锁读盘会把
        // 其他会话的发送、队列调度和停止一起按住。开关在锁外先快速失败，锁内再判一次，
        // 因为「是否还允许入队」必须和取锁原子。
        enabled(&app)?;
        request.images = images::validate_paths(&app, &request.images)?
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        let _lifecycle = registry::LIFECYCLE.lock().map_err(|e| e.to_string())?;
        enabled(&app)?;
        let root = store::workspace(&request.workspace)?;
        request.additional_dirs = validated_dirs(&request, &root)?;
        // 进入队列前冻结规范化路径；后续切换工程或页面刷新不会丢失附件。
        if request.provider == Provider::Codex {
            // 队列必须冻结发送当刻的项目有效配置；执行时再读会被后续 UI 修改串改。
            let config = options::codex_project_config(&root)?;
            freeze_codex_config(&mut request, &config);
        }
        if let Some(model) = request.model.as_deref() {
            let cached = options::cached_models(&models_path(&app)?, request.provider);
            let catalog = if request.provider == Provider::Claude { options::claude_configured_models(cached, &root) } else { cached };
            let canonical = options::canonical_model(&catalog, model);
            request.model = Some(if request.provider == Provider::Claude { options::configured_model(&catalog, &canonical) } else { canonical });
        }
        validate(&request)?;
        let base = base(&app)?;
        // 计划决策先抢提交权：双击或两个窗口只能有一个进入队列。
        // 执行正文完全由后端生成，前端无法在批准时夹带额外指令。
        if let Some(plan) = request.plan.clone() {
            let dir = base.join(&request.session_id);
            if !dir.exists() {
                return Err("会话不存在".into());
            }
            match plans::submit(&dir, &plan.plan_id, plan.revision, plan.decision, plan.feedback.as_deref())? {
                plans::Submit::Conflict(current) => {
                    return Err(format!("计划已被处理或版本已变化（当前状态 {}），请刷新后重试", current.status.as_str()));
                }
                plans::Submit::Claimed { review, previous } => {
                    let prompt = match plan.decision {
                        plans::Decision::Approve => EXECUTE_PLAN_PROMPT.to_owned(),
                        plans::Decision::RequestChanges => plan.feedback.as_deref().unwrap_or_default().trim().to_owned(),
                        plans::Decision::Defer => return Err("暂不执行不会启动回合".into()),
                    };
                    request.plan_turn = Some(PlanTurn {
                        plan_id: plan.plan_id.clone(),
                        revision: plan.revision,
                        decision: plan.decision,
                        previous,
                        native_plan_id: review.native_plan_id.clone(),
                        content_hash: review.content_hash.clone(),
                    });
                    request.prompt = prompt;
                    // 先把「正在启动」写进事件流：排队期间界面也不会重复显示可批准状态。
                    emit_plan_record(&app, &request, &root, &base, review)?;
                }
            }
        }
        let result = dispatch_task(&app, &request, &root, &base);
        if let Err(error) = &result {
            if let Some(claim) = &request.plan_turn {
                settle_plan_failure(&app, &request, claim, error);
            }
        }
        result
    }).await
}

/// 立即启动或按 FIFO 入队；调用方已持有生命周期锁。
fn dispatch_task(app: &AppHandle, request: &SendRequest, root: &str, base: &std::path::Path) -> Result<Value, String> {
    let local_active = registry::for_session(&request.session_id).is_some();
    let external_active = !local_active && externally_blocked(base, &request.session_id, root);
    // 队列本身也是占用状态。外部任务刚结束、轮询尚未取出队首时，新消息仍必须排到旧任务后面。
    let queue_has_items = has_queued(&request.session_id);
    if local_active || external_active || queue_has_items {
        {
            let all = queued().lock().map_err(|e| e.to_string())?;
            let session_count = all.get(&request.session_id).map_or(0, VecDeque::len);
            let total: usize = all.values().map(VecDeque::len).sum();
            if session_count >= 32 || total >= 256 { return Err("任务队列已满".into()); }
        }
        // 这一条永远排在最后，所以只有队列为空时它才是队首，才可能被外部 CLI 直接挡住。
        let status = queued_status(!queue_has_items, external_active);
        append_task_status(app, request, status, json!({}), request.plan_turn.is_none())?;
        queued().lock().map_err(|e| e.to_string())?.entry(request.session_id.clone()).or_default().push_back(request.clone());
        return Ok(json!({"status":status}));
    }
    launch_task(app.clone(), request.clone(), true)?;
    Ok(json!({"status":task_status::RUNNING}))
}

/// 决策回合没能开起来：正文变了就过期，其它失败退回待审；两种情况都广播最终状态。
fn settle_plan_failure(app: &AppHandle, request: &SendRequest, claim: &PlanTurn, error: &str) {
    let (Ok(root), Ok(base)) = (store::workspace(&request.workspace), base(app)) else { return; };
    let dir = base.join(&request.session_id);
    let record = if error.starts_with("codex plan is stale:") {
        plans::expire(&dir, &claim.plan_id, claim.revision).ok().flatten()
    } else {
        plans::revert(&dir, &claim.plan_id, claim.revision, claim.previous).ok()
    };
    if let Some(record) = record {
        if let Err(cause) = emit_plan_record(app, request, &root, &base, record) {
            let _ = app.emit("ai-runtime://errors", json!({"sessionId":request.session_id,"runId":request.run_id,"error":cause}));
        }
    }
}

/// 计划状态变化与正文一样进同一条事件流，刷新历史后仍能恢复到同一张卡片。
fn emit_plan_record(app: &AppHandle, request: &SendRequest, root: &str, base: &std::path::Path, record: plans::PlanReview) -> Result<(), String> {
    let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
    // 这里可能正有一轮在跑（决策已排队），不能用 Store::open 的「上次运行未结束」修复：
    // 那会把仍在跑的回合误写成 cancelled。只读元数据与最新序号，直接追加。
    let dir = base.join(&request.session_id);
    let meta = store::Store::metadata(&dir, root)?;
    let page = store::Store::page(base, &request.session_id, root, store::Window::After(0), 1, true)?;
    let mut store = store::Store { dir, meta, seq: page.latest_seq, poisoned: false };
    let events = store.append(&request.run_id, vec![("plan_review".into(), serde_json::to_value(record).map_err(|e| e.to_string())?)])?;
    let _ = app.emit(CHANNEL, &events);
    Ok(())
}

/// 「暂不执行」只在本地落账，不启动任何回合：计划保持可再次提交。
#[tauri::command]
pub async fn ai_runtime_plan_defer(app: AppHandle, session_id: String, workspace: String, plan_id: String, revision: i64) -> Result<(), String> {
    block(move || {
        enabled(&app)?;
        if !store::valid_id(&session_id) || plan_id.trim().is_empty() {
            return Err("无效会话或计划标识".into());
        }
        let root = store::workspace(&workspace)?;
        let base = base(&app)?;
        let _lifecycle = registry::LIFECYCLE.lock().map_err(|e| e.to_string())?;
        if registry::for_session(&session_id).is_some() {
            return Err("本轮运行中，请等结束后再处理计划".into());
        }
        let lease = store::Lease::acquire(&base.join(format!("{session_id}.lock")))?;
        let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
        let dir = base.join(&session_id);
        let meta = store::Store::metadata(&dir, &root)?;
        if meta.provider != Provider::Codex {
            return Err("计划审阅目前只支持 Codex".into());
        }
        // CAS 与原生回合走同一条规则：只有待审/暂缓版本能被处理，过期版本会明确报冲突。
        let review = match plans::submit(&dir, &plan_id, revision, plans::Decision::Defer, None)? {
            plans::Submit::Conflict(current) => return Err(format!("计划已被处理或版本已变化（当前状态 {}）", current.status.as_str())),
            plans::Submit::Claimed { review, .. } => review,
        };
        let record = plans::mark_applied(&dir, &plan_id, revision, plans::Decision::Defer)?;
        let run_id = review.run_id.unwrap_or_else(|| "plan-defer".into());
        let mut store = store::Store::open(&base, &session_id, &root, meta.provider, &meta.title, "")?;
        let events = store.append(&run_id, vec![("plan_review".into(), serde_json::to_value(record).map_err(|e| e.to_string())?)])?;
        let _ = app.emit(CHANNEL, &events);
        drop(lease);
        Ok(())
    }).await
}

/// 在已经持有生命周期锁时启动一项任务；排队任务的用户消息此前已经落盘。
fn launch_task(app: AppHandle, request: SendRequest, include_user: bool) -> Result<(), String> {
    let root = store::workspace(&request.workspace)?;
    let base = base(&app)?;
    let session_lease = store::Lease::acquire(&base.join(format!("{}.lock", request.session_id)))?;
    let mut store = {
        let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
        // CLI resume 只依赖原生会话 ID；Forge 镜像是否已经分页读完不能阻塞发送。
        // 历史继续由 ai_runtime_load 惰性同步，避免大会话在发送路径上反复扫描。
        store::Store::open(&base, &request.session_id, &root, request.provider, &request.title, "")?
    };
    let (run, controls) = Run::reserve(request.run_id.clone(), request.session_id.clone(), root, request.workspace.clone())?;
    let initial = {
        let _io = store::IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut events = vec![];
        // 计划决策不是用户正文：时间线上只记一条「已批准/已要求修改」，
        // 绝不能把后端生成的执行指令伪装成用户说的话。
        let include_user = include_user && request.plan_turn.is_none();
        if let Some(turn) = &request.plan_turn {
            events.push(("plan_decision".into(), json!({"planId":turn.plan_id,"revision":turn.revision,"decision":turn.decision})));
        }
        if include_user { events.push(("user".into(), json!({"text":request.prompt,"images":request.images}))); }
        events.push(("status".into(), json!({"status":task_status::RUNNING})));
        store.append(&run.id, events)
    };
    match initial {
        Ok(events) => {
            if include_user {
                images::mark_referenced(&app, &request.images);
            }
            let _ = app.emit(CHANNEL, &events);
        }
        Err(error) => { run.finish(); return Err(error); }
    }
    let worker_run = run.clone();
    let session_id = request.session_id.clone();
    let spawned = std::thread::Builder::new().name("forge-ai-runtime".into()).spawn(move || {
        let session_lease = session_lease;
        let mut worker = Worker { app, run: worker_run.clone(), store, pending: HashMap::new(), approvals: approvals::ApprovalMemory::default(), next_request: 0, batch: vec![], batch_bytes: 0, flushed: Instant::now(), plan_claim: None, plan_applied: None };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| worker.execute(request, controls)));
        let outcome = match result { Ok(result) => result, Err(_) => Err("AI 运行线程异常退出，未自动重发".into()) };
        if let Err(error) = &outcome { worker.fail_plan_claim(error); }
        if worker_run.cancelled.load(Ordering::Acquire) { worker.fail_plan_claim("任务已取消"); }
        let (status, error) = if worker_run.cancelled.load(Ordering::Acquire) { (task_status::CANCELLED, None) }
            else { match outcome { Ok(status) => (status, None), Err(error) => (task_status::FAILED, Some(error)) } };
        worker.finish(status, error);
        let next_app = worker.app.clone();
        drop(session_lease);
        worker_run.finish();
        let _ = schedule_next(&next_app, &session_id);
    });
    if let Err(error) = spawned { run.finish(); return Err(format!("无法创建 AI 运行线程：{error}")); }
    Ok(())
}

fn schedule_next(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let _lifecycle = registry::LIFECYCLE.lock().map_err(|e| e.to_string())?;
    if registry::for_session(session_id).is_some() { return Ok(()); }
    loop {
        let next = queued().lock().map_err(|e| e.to_string())?.get(session_id).and_then(|items| items.front()).cloned();
        let Some(request) = next else { return Ok(()); };
        let root = store::workspace(&request.workspace)?;
        let base = base(app)?;
        if externally_blocked(&base, session_id, &root) {
            append_task_status(app, &request, task_status::WAITING_EXTERNAL, json!({}), false)?;
            return Ok(());
        }
        queued().lock().map_err(|e| e.to_string())?.get_mut(session_id).and_then(VecDeque::pop_front);
        match launch_task(app.clone(), request.clone(), false) {
            Ok(()) => return Ok(()),
            // 启动失败几乎都是会话级原因（会话目录、租约、进程创建），不是这一条提示的问题。
            // 继续往下弹只会把整队提示在一次抖动里全部判死，所以留下其余排队项，
            // 让秒级监控器稍后重试管首：没有任何 CLI 启动过，重试不等于自动重发。
            Err(error) => {
                append_task_status(app, &request, task_status::FAILED, json!({"error":error}), false)?;
                if let Some(claim) = &request.plan_turn {
                    settle_plan_failure(app, &request, claim, &error);
                }
                return Ok(());
            }
        }
    }
}

/// 一轮运行的执行上下文：负责把协议动作落成事件、写进存储并发给前端。
struct Worker {
    /// 用于读取数据目录并发事件给前端。
    app: AppHandle,
    /// 本轮的登记条目，停止与事件过滤都靠它。
    run: Arc<Run>,
    /// 本轮的存储句柄，事件序号与落盘都走它。
    store: store::Store,
    /// 内部请求键 → (对外请求 id, 类型)。答复时把对外的 id 换回协议内部键。
    pending: HashMap<String, (String, String)>,
    /// 本轮攒下的「不再询问」规则。只活在这个 Worker 里，结束即消失，绝不落盘。
    approvals: approvals::ApprovalMemory,
    /// 对外请求 id 的自增计数，保证 id 不可预测且不重复。
    next_request: u64,
    /// 待批量发送的事件。逐条 emit 会把前端压垮，攒一批再发。
    batch: Vec<(String, Value)>,
    /// 当前批次已累计的字节数，达到阈值就先 flush。
    batch_bytes: usize,
    /// 上次 flush 的时刻，用来做时间维度上的兜底刷新。
    flushed: Instant,
    /// 决策回合的提交权；回合真正开起来之前失败要退回或过期。
    plan_claim: Option<PlanTurn>,
    /// 已确认启动的决策版本；收尾时据此记录执行状态。
    plan_applied: Option<(String, i64)>,
}
impl Worker {
    fn queue(&mut self, kind: &str, data: Value) -> Result<(), String> {
        self.batch_bytes += data.to_string().len();
        self.batch.push((kind.into(), data));
        if self.batch_bytes >= 64 * 1024 || self.batch.len() >= 128 {
            self.flush()?;
        }
        Ok(())
    }
    fn flush(&mut self) -> Result<(), String> {
        if !self.batch.is_empty() {
            let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
            let events = self
                .store
                .append(&self.run.id, std::mem::take(&mut self.batch))?;
            // 前端断开（webview 关闭）不该让已经落盘的运行停下来，emit 失败直接忽略。
            let _ = self.app.emit(CHANNEL, &events);
        }
        self.batch_bytes = 0;
        self.flushed = Instant::now();
        Ok(())
    }
    fn actions(
        &mut self,
        protocol: &mut dyn Protocol,
        actions: Vec<Action>,
        process: &mut Process,
    ) -> Result<Option<&'static str>, String> {
        // 自动允许会把答复动作接回同一条流水线，所以用队列而不是 for 循环：
        // 一次调用产生的连锁动作在这里就地消化，不必回到主循环再绕一圈。
        let mut queue: VecDeque<Action> = actions.into();
        let mut terminal = None;
        let mut auto_allowed = 0usize;
        while let Some(action) = queue.pop_front() {
            match action {
                Action::Write(value) => process.write(&value)?,
                Action::CloseInput => process.close_input(),
                Action::Emit { kind, data } => {
                    // 回合被 CLI 确认启动后，计划决策才算落地；批准不等于执行成功。
                    if kind == "turn" {
                        if let Some(claim) = self.plan_claim.take() {
                            let record = plans::mark_applied(&self.store.dir, &claim.plan_id, claim.revision, claim.decision)?;
                            self.plan_applied = Some((claim.plan_id, claim.revision));
                            self.queue("plan_review", serde_json::to_value(record).map_err(|e| e.to_string())?)?;
                        }
                    }
                    self.queue(kind, data)?;
                }
                Action::Plan { title, content, native_plan_id } => self.record_plan(title, content, native_plan_id)?,
                Action::Bind(native) => {
                    self.flush()?;
                    {
                        let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
                        self.store.bind(native.clone())?;
                    }
                    self.queue("bound", json!({"nativeId":native}))?;
                    self.flush()?;
                }
                Action::Request {
                    key,
                    kind,
                    mut data,
                } => {
                    if self.run.cancelled.load(Ordering::Acquire) {
                        continue;
                    }
                    // 本轮已经授权过同一个工具（或同目录）：时代答一次，并在时间线说清是谁替谁放的。
                    if kind == "permission" && self.pending.len() < 64 {
                        if let Some(rule) = auto_answer_for(&self.approvals, &data) {
                            auto_allowed += 1;
                            if auto_allowed > 64 {
                                return Err("自动允许的请求过多，已停止本轮；未自动重发".into());
                            }
                            let reply = protocol.respond(&key, json!({"allow": true}))?;
                            self.queue(
                                "notice",
                                json!({
                                    "text": format!(
                                        "{} 已被本轮授权自动允许：{}",
                                        data["toolName"].as_str().unwrap_or_default(),
                                        rule.explain()
                                    ),
                                    "toolName": data["toolName"],
                                    "requestKey": key,
                                }),
                            )?;
                            queue.extend(reply);
                            continue;
                        }
                    }
                    if self.pending.len() >= 64
                        || !matches!(kind, "permission" | "question")
                        || !data.is_object()
                    {
                        return Err("CLI 审批请求无效或过多".into());
                    }
                    self.next_request += 1;
                    let id = format!("{}-{}", self.run.id, self.next_request);
                    data["requestId"] = json!(id);
                    self.pending.insert(id, (key, kind.into()));
                    self.queue(kind, data)?;
                    self.flush()?;
                }
                Action::Invalidate(key) => {
                    let ids: Vec<_> = self
                        .pending
                        .iter()
                        .filter(|(_, v)| v.0 == key)
                        .map(|(k, _)| k.clone())
                        .collect();
                    for id in ids {
                        self.pending.remove(&id);
                        self.queue("invalidated", json!({"requestId":id}))?;
                    }
                }
                Action::Finish { status, error } => {
                    if let Some(error) = error {
                        return Err(error);
                    }
                    if !task_status::is_terminal(status) {
                        return Err("未知 CLI 终态".into());
                    }
                    terminal = Some(status);
                }
            }
        }
        Ok(terminal)
    }
    /// 计划回合产出的权威正文：登记 revision 后立刻广播审阅卡片。
    fn record_plan(&mut self, title: String, content: String, native_plan_id: String) -> Result<(), String> {
        let native = self.store.meta.native_id.clone().ok_or("计划缺少原生会话标识")?;
        self.flush()?;
        let record = plans::record(
            &self.store.dir,
            &self.store.meta.session_id,
            &native,
            &self.run.workspace,
            &self.run.id,
            &title,
            &content,
            &native_plan_id,
        )?;
        self.queue("plan_review", serde_json::to_value(record).map_err(|e| e.to_string())?)?;
        self.flush()
    }
    /// 决策回合在开起来之前失败：正文变了就过期，其它失败退回待审。
    fn fail_plan_claim(&mut self, error: &str) {
        let Some(claim) = self.plan_claim.take() else { return; };
        let record = if error.starts_with("codex plan is stale:") {
            plans::expire(&self.store.dir, &claim.plan_id, claim.revision).ok().flatten()
        } else {
            plans::revert(&self.store.dir, &claim.plan_id, claim.revision, claim.previous).ok()
        };
        let Some(record) = record else { return; };
        let event = serde_json::to_value(record).map_err(|error| error.to_string());
        let result = event.and_then(|data| { self.queue("plan_review", data)?; self.flush() });
        if let Err(cause) = result {
            let _ = self.app.emit("ai-runtime://errors", json!({
                "sessionId":self.run.session_id,"runId":self.run.id,"error":cause
            }));
        }
    }
    fn finish_plan_execution(&mut self, status: &str) {
        let Some((plan_id, revision)) = self.plan_applied.take() else { return; };
        let execution = match status {
            task_status::COMPLETED => plans::Execution::Completed,
            task_status::FAILED => plans::Execution::Failed,
            _ => plans::Execution::Unknown,
        };
        if plans::mark_execution(&self.store.dir, &plan_id, revision, execution).is_ok() {
            // 执行状态也进事件流：批准后这一轮结束时，卡片要原位更新而不是等下次打开会话。
            if let Ok(Some(record)) = plans::get(&self.store.dir, &plan_id, revision) {
                if let Ok(data) = serde_json::to_value(record) {
                    let _ = self.queue("plan_review", data);
                }
            }
        }
    }
    fn execute(
        &mut self,
        mut request: SendRequest,
        controls: mpsc::Receiver<Control>,
    ) -> Result<&'static str, String> {
        if self.run.cancelled.load(Ordering::Acquire) {
            return Ok(task_status::CANCELLED);
        }
        self.plan_claim = request.plan_turn.clone();
        // 排队期间缓存文件可能变化；真正启动 CLI 前必须重新校验根目录、魔数和大小。
        request.images = images::validate_paths(&self.app, &request.images)?.into_iter().map(|path| path.to_string_lossy().into_owned()).collect();
        let service_tier = if let Some(tier) = request.service_tier.clone() {
            tier
        } else if request.fast == Some(true) && request.command.is_none() {
            let catalog = options::cached_models(&models_path(&self.app)?, Provider::Codex);
            let (model, tier) = options::fast_tier(&catalog, request.model.as_deref())?;
            request.model = Some(model);
            tier
        } else if request.fast == Some(false) { "default".into() } else { String::new() };
        let mut args = match request.provider {
            Provider::Codex => vec!["app-server"],
            Provider::Claude => vec![
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--permission-prompt-tool",
                "stdio",
            ],
        };
        if request.provider == Provider::Claude {
            // 计划模式只读：模式本身拒绝写操作，再显式列出允许/禁止的工具，
            // 防止不同 CLI 版本对 plan 的解析差异让某个写工具漏过来。
            let mode = if request.plan_mode { "plan" } else { request.permission.claude() };
            args.extend(["--permission-mode", mode]);
            if request.plan_mode {
                args.extend(["--allowedTools", "Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "TodoWrite", "Task"]);
                args.extend(["--disallowedTools", "Bash", "Edit", "Write", "NotebookEdit"]);
            }
        }
        if request.provider == Provider::Codex && !request.additional_dirs.is_empty() {
            return Err("Codex 暂不支持附加目录；请在项目原生配置中调整".into());
        }
        let native = self.store.meta.native_id.clone();
        if request.command == Some(commands::CommandIntent::CodexCompact) && native.is_none() {
            return Err("请先建立会话，再压缩上下文".into());
        }
        if request.provider == Provider::Claude {
            if request.permission == options::PermissionMode::Full {
                args.push("--allow-dangerously-skip-permissions");
            }
            if let Some(id) = native.as_deref() {
                args.extend(["--resume", id]);
            } else {
                // CLI 公共参数允许宿主指定原生 ID；首轮前后与 /resume 使用同一个会话。
                args.extend(["--session-id", request.session_id.as_str(), "--name", request.title.as_str()]);
            }
            if let Some(model) = request.model.as_deref() {
                args.extend(["--model", model]);
            }
            if let Some(effort) = request.effort.as_deref() {
                args.extend(["--effort", effort]);
            }
            // 目录授权每次启动都带上：CLI 不能在进程中途扩容，而每一轮都是新进程。
            for dir in &request.additional_dirs {
                args.extend(["--add-dir", dir]);
            }
        }
        let (command, version) = ai_cli::runtime_command(request.provider, &args)?;
        {
            let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
            self.store.meta.cli_version = version;
            self.store.save()?;
        }
        if self.run.cancelled.load(Ordering::Acquire) {
            return Ok(task_status::CANCELLED);
        }
        let mut protocol: Box<dyn Protocol> = match request.provider {
            Provider::Codex => Box::new(
                codex::Codex::new(self.run.workspace.clone(), request.prompt.clone(), native)
                    .with_images(request.images.clone())
                    .with_options(request.model.clone(), request.effort.clone())
                    .with_policy(request.permission, service_tier)
                    .with_command(request.command)
                    .with_plan(request.plan_mode)
                    .with_decision(request.plan_turn.as_ref().map(|turn| codex::Decision {
                        mode: if turn.decision == plans::Decision::Approve { "default" } else { "plan" },
                        native_plan_id: turn.native_plan_id.clone(),
                        content_hash: turn.content_hash.clone(),
                    })),
            ),
            Provider::Claude => Box::new(claude::Claude::new(
                self.run.workspace.clone(),
                request.prompt.clone(),
                native,
            ).with_images(images::claude_blocks(&request.images.iter().map(PathBuf::from).collect::<Vec<_>>())?)
                .with_model(request.model.clone()).with_command(request.command)
                .with_plan(request.plan_mode)),
        };
        let mut process = Process::spawn(command, &self.run.workspace)?;
        self.run.child_pid.store(process.id(), Ordering::Release);
        let handshake = protocol.start()?;
        if let Err(error) = self.actions(&mut *protocol, handshake, &mut process) {
            self.fail_plan_claim(&error);
            return Err(error);
        }
        let started = Instant::now();
        let mut stopping = None;
        let mut last_output = Instant::now();
        loop {
            if self.run.cancelled.load(Ordering::Acquire) && stopping.is_none() {
                stopping = Some(Instant::now());
                let interrupt = protocol.interrupt();
                let _ = self.actions(&mut *protocol, interrupt, &mut process);
                for id in self.pending.keys().cloned().collect::<Vec<_>>() {
                    self.queue("invalidated", json!({"requestId":id}))?;
                }
                self.pending.clear();
                self.flush()?;
            }
            if stopping.is_some_and(|at: Instant| at.elapsed() > Duration::from_secs(3)) {
                return Ok(task_status::CANCELLED);
            }
            if started.elapsed() > Duration::from_secs(2 * 60 * 60)
                || (!protocol.parked() && self.pending.is_empty() && last_output.elapsed() > Duration::from_secs(10 * 60))
            {
                return Err("CLI 长时间无响应，已停止本轮；未自动重发".into());
            }
            if let Ok(control) = controls.try_recv() {
                let Control::Answer {
                    request_id,
                    answer,
                    reply,
                } = control;
                let result = (|| {
                    if stopping.is_some() || self.run.cancelled.load(Ordering::Acquire) {
                        return Err("任务正在停止，请求已失效".into());
                    }
                    let (key, kind) = self
                        .pending
                        .get(&request_id)
                        .cloned()
                        .ok_or("授权或提问已失效")?;
                    let grant = validate_answer(&kind, &answer)?;
                    let actions = protocol.respond(&key, answer.clone())?;
                    self.actions(&mut *protocol, actions, &mut process)?;
                    self.pending.remove(&request_id);
                    // 把答案一起记进这条失效事件：卡片要分得清「用户答过了，这就是当时选的」和
                    // 「没等到答复就失效了」，而且这份事实得进日志——重开会话时不能又变成可答复，
                    // 也不能把用户选过的那几项显示成空白。
                    self.queue("invalidated", json!({"requestId":request_id, "answer":answer}))?;
                    // 规则在答复之后才登记：本轮这一次仍是用户亲手点的，之后同工具的请求才由它代答。
                    if let Some(rule) = grant {
                        let explanation = rule.explain();
                        if self.approvals.remember(rule) {
                            self.queue("notice", json!({"text": explanation, "approval": true}))?;
                        }
                    }
                    self.flush()
                })();
                let _ = reply.send(result);
            }
            if self.flushed.elapsed() >= Duration::from_millis(32) {
                self.flush()?;
            }
            match process.incoming.recv_timeout(Duration::from_millis(20)) {
                Ok(Input::Json(value)) => {
                    last_output = Instant::now();
                    let actions = match protocol.receive(value) {
                        Ok(actions) => actions,
                        Err(error) => {
                            self.fail_plan_claim(&error);
                            return Err(error);
                        }
                    };
                    let terminal = match self.actions(&mut *protocol, actions, &mut process) {
                        Ok(terminal) => terminal,
                        Err(error) => {
                            self.fail_plan_claim(&error);
                            return Err(error);
                        }
                    };
                    if let Some(status) = terminal {
                        // 辅助上下文若尚未返回，只把旧缓存标记为过期；终态、锁释放和队列调度立即继续。
                        let timeout = protocol.context_timeout();
                        self.actions(&mut *protocol, timeout, &mut process)?;
                        return Ok(status);
                    }
                }
                Ok(Input::Error(e)) => return Err(e),
                Ok(Input::Eof) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let timeout = protocol.context_timeout();
                    self.actions(&mut *protocol, timeout, &mut process)?;
                    process.close_input();
                    if stopping.is_some() {
                        return Ok(task_status::CANCELLED);
                    }
                    // 后台任务还在等跟进回合时，CLI 正常退出不是「结果丢失」：
                    // 这一轮对用户已经结束，收尾按完成处理。
                    if protocol.parked() {
                        return Ok(task_status::COMPLETED);
                    }
                    if let Some(exit) = process.status()? {
                        if exit.success() { return Err(format!("CLI 未返回完整结果便退出：{}", process.diagnostics())); }
                        return Err(format!("CLI 异常退出（{exit}）：{}", process.diagnostics()));
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }
    fn finish(&mut self, status: &str, error: Option<String>) {
        // 进程结束后所有待答复请求都已失效；卡片不能继续停在「可批准」。
        for id in self.pending.keys().cloned().collect::<Vec<_>>() {
            let _ = self.queue("invalidated", json!({"requestId":id}));
        }
        self.pending.clear();
        self.finish_plan_execution(status);
        let history_result = self.flush().and_then(|_| {
            let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
            let base = self.store.dir.parent().ok_or("会话路径无效")?.to_path_buf();
            history::mark_current(&mut self.store, &base)
        });
        let data = if let Err(cause) = history_result {
            json!({"status":task_status::FAILED,"error":cause})
        } else {
            json!({"status":status,"error":error})
        };
        self.batch.push(("status".into(), data));
        if let Err(error) = self.flush() {
            // 诊断信息不能占用未提交的序号：后面真正落盘的事件可能合法地用同一个号，
            // 所以这里直接走旁路通道发给前端，不经过事件存储。
            let _ = self.app.emit(
                "ai-runtime://errors",
                json!({"sessionId":self.run.session_id,"runId":self.run.id,"error":error}),
            );
        }
    }
}
/// 这条授权请求能否由本轮已记下的规则代答。
///
/// 认不出工具名、认不出入参形状，都回到「问用户」——代答只在信息完整时发生。
fn auto_answer_for(
    approvals: &approvals::ApprovalMemory,
    data: &Value,
) -> Option<approvals::StandingRule> {
    if !data["toolName"].is_string() || !data["input"].is_object() {
        return None;
    }
    approvals.covers(data["toolName"].as_str(), &data["input"]).cloned()
}

/// 校验前端送来的答复；授权答复额外返回用户要求「本轮记住」的规则，提问答复没有规则。
///
/// 答复里「改过的入参」能不能兑现，只有各家协议自己知道，所以由 `Protocol::respond`
/// 负责拒绝（见 codex.rs）；这里只统一形状与尺寸。
fn validate_answer(kind: &str, answer: &Value) -> Result<Option<approvals::StandingRule>, String> {
    if kind == "permission" {
        let (_, _, rule) = approvals::parse_permission_answer(answer)?;
        return Ok(rule);
    }
    let object = answer.as_object().ok_or("无效回答")?;
    if object.len() != 1 {
        return Err("无效提问回答".into());
    }
    let answers = answer["answers"].as_object().ok_or("无效提问回答")?;
    if answers.len() > 32
        || answer.to_string().len() > 64 * 1024
        || answers.values().any(|a| {
            a.as_array()
                .map_or(true, |v| v.len() > 32 || v.iter().any(|s| !s.is_string()))
        })
    {
        return Err("提问回答过大或格式无效".into());
    }
    Ok(None)
}
#[tauri::command]
pub async fn ai_runtime_stop(app: AppHandle, run_id: String) -> Result<(), String> {
    block(move || {
        // 锁内只做「查到哪一个、决定停它」；等待清理结束放到锁外，
        // 否则一个卡住的 CLI 会把其他会话的发送、队列调度一起按住最长 15 秒。
        let stopping = {
            let _guard = registry::LIFECYCLE.lock().map_err(|e| e.to_string())?;
            if let Some(run) = registry::get(&run_id) {
                run.request_stop();
                Some(run)
            } else if let Some((session_id, request)) = take_queued_run(&run_id)? {
                append_task_status(&app, &request, task_status::CANCELLED, json!({}), false)?;
                if let Some(claim) = &request.plan_turn {
                    settle_plan_failure(&app, &request, claim, "任务已取消");
                }
                emit_queue_order(&app, &session_id)?;
                None
            } else {
                None
            }
        };
        registry::wait_stopped(stopping)
    })
    .await
}
#[tauri::command]
pub async fn ai_runtime_stop_all(app: AppHandle) -> Result<(), String> {
    block(move || {
        let stopping = {
            let _guard = registry::LIFECYCLE.lock().map_err(|e| e.to_string())?;
            // 先清队列再放回合去死：worker 收尾会立即调度队首，锁一释放就可能把
            // 用户刚刚要求「全部停止」的任务又启动起来。
            cancel_queued(&app, |_| true)?;
            stop_registered()
        };
        registry::wait_stopped(stopping)
    })
    .await
}
#[tauri::command]
pub async fn ai_runtime_respond(
    app: AppHandle,
    run_id: String,
    request_id: String,
    answer: Value,
) -> Result<(), String> {
    block(move || {
        enabled(&app)?;
        let run = registry::get(&run_id).ok_or("运行已结束")?;
        if run.cancelled.load(Ordering::Acquire) {
            return Err("任务正在停止".into());
        }
        let (reply, receive) = mpsc::sync_channel(1);
        run.controls
            .try_send(Control::Answer {
                request_id,
                answer,
                reply,
            })
            .map_err(|_| "运行繁忙或已经结束")?;
        receive
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "回应结果未确认；请勿重复批准".to_string())?
    })
    .await
}
#[tauri::command]
pub async fn ai_runtime_load(
    app: AppHandle,
    session_id: String,
    workspace: String,
    after_seq: Option<u64>,
    before_seq: Option<u64>,
    limit: Option<usize>,
) -> Result<Page, String> {
    block(move || {
        enabled(&app)?;
        images::allow_assets(&app)?;
        let root = store::workspace(&workspace)?;
        let base = base(&app)?;
        let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
        if !store::valid_id(&session_id) {
            return Err("无效会话 ID".into());
        }
        let mut warning = None;
        let mut native_more = false;
        if registry::for_session(&session_id).is_none() {
            if let Ok(_lease) = store::Lease::acquire(&base.join(format!("{session_id}.lock"))) {
                // 没有本进程回合、也没有排队决策时，plans.json 里的 submitting 就是上次
                // 进程没来得及确认的残留；退回待审，别让计划卡永远消失。
                if !has_queued(&session_id) {
                    let _ = plans::recover(&base.join(&session_id));
                }
                match history::sync(&base, &session_id, &root) {
                    Ok(more) => native_more = more,
                    Err(error) => warning = Some(error),
                }
            }
        }
        // 首屏永远取最新一页：两头都没给就是「最后面那一页」，只给了 after 才按老语义往后翻。
        let window = match (before_seq, after_seq) {
            (Some(before), _) => store::Window::Before(before),
            (None, Some(after)) => store::Window::After(after),
            (None, None) => store::Window::Before(u64::MAX),
        };
        let mut page = store::Store::page(
            &base,
            &session_id,
            &root,
            window,
            limit.unwrap_or(500),
            registry::for_session(&session_id).is_some() || has_queued(&session_id),
        )?;
        page.warning = warning;
        page.has_more |= native_more;
        // 计划审批的事实源是 plans.json，不在事件分页里：会话打开时必须单独带上，
        // 否则翻到旧页时看不到仍在等待的审阅卡片。
        if let Ok(records) = plans::load(&base.join(&session_id)) {
            page.plans = records.into_iter().filter_map(|record| serde_json::to_value(record).ok()).collect();
        }
        // 回显过的历史图片补引用标记：清理上线之前存的附件没有 .ref，不补就会被当孤儿收走。
        images::mark_events(&app, &page.events);
        Ok(page)
    })
    .await
}
/// 消息导航用的轮次索引：最近这么多轮用户消息的开头一行，加上每一轮改过的文件数。
///
/// 为什么不并进 `ai_runtime_load`：正文分页一页只装得下几百条事件，长会话里连一轮都铺不满，
/// 导航于是只显示一条。索引不碰正文与工具输出，才有把握一次列全整个会话。
/// 这里同样不拿 `IO_LOCK`（理由见 `ai_runtime_search`）：扫长日志期间把事件写入卡住不值当。
#[tauri::command]
pub async fn ai_runtime_outline(
    app: AppHandle,
    session_id: String,
    workspace: String,
) -> Result<Value, String> {
    block(move || {
        enabled(&app)?;
        if !store::valid_id(&session_id) {
            return Err("无效会话 ID".into());
        }
        let root = store::workspace(&workspace)?;
        let base = base(&app)?;
        outline::turns(&base, &session_id, &root)
    })
    .await
}
#[tauri::command]
pub async fn ai_runtime_delete(
    app: AppHandle,
    session_id: String,
    workspace: String,
) -> Result<(), String> {
    block(move || {
        if !store::valid_id(&session_id) {
            return Err("无效会话 ID".into());
        }
        let root = store::workspace(&workspace)?;
        let base = base(&app)?;
        let _guard = registry::LIFECYCLE.lock().map_err(|e| e.to_string())?;
        cancel_queued(&app, |request| request.session_id == session_id && request.workspace == workspace)?;
        if let Some(run) = registry::for_session(&session_id) {
            if run.workspace != root {
                return Err("项目归属不匹配".into());
            }
            run.stop()?;
        }
        let _lease = store::Lease::acquire(&base.join(format!("{session_id}.lock")))?;
        let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
        store::Store::page(&base, &session_id, &root, store::Window::After(0), 1, false)?;
        let dir = base.join(&session_id);
        if dir.exists() {
            // 目录一删，事件日志里引用的附件就再没人认得了：先把它们收走，别留在沙箱里当孤儿。
            images::release_session(&app, &dir);
            history::hide(&base, &session_id, &root)?;
            std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn ai_runtime_list(app: AppHandle, workspace: String) -> Result<Vec<Value>, String> {
    block(move || {
        enabled(&app)?; let root=store::workspace(&workspace)?; let base=base(&app)?;
        { let _io=store::IO_LOCK.lock().map_err(|e|e.to_string())?; history::discover(&base, &root)?; }
        // thread/list 与 Codex /resume 同源；失败时保留磁盘镜像，不能连带阻塞 Claude。
        let codex = options::codex_threads(&root).unwrap_or_default();
        let codex_by_id: HashMap<String, Value> = codex.into_iter().filter_map(|item| Some((item["id"].as_str()?.to_owned(), item))).collect();
        let _io=store::IO_LOCK.lock().map_err(|e|e.to_string())?;
        let mut sessions=vec![];
        for entry in std::fs::read_dir(base).map_err(|e|e.to_string())?.take(20000) {
            let entry=entry.map_err(|e|e.to_string())?;
            if !entry.file_type().map_err(|e|e.to_string())?.is_dir() { continue; }
            let id=entry.file_name().to_string_lossy().into_owned();
            if !store::valid_id(&id) { continue; }
            if let Ok(mut meta)=store::Store::metadata(&entry.path(),&root) {
                // 旧版包装 ID 不再进入 UI；原生历史已按真实 ID 重建只读镜像。
                if meta.native_id.as_deref().is_some_and(|native| native != meta.session_id) { continue; }
                if meta.provider == Provider::Codex {
                    if let Some(native) = codex_by_id.get(&meta.session_id) {
                        if let Some(title) = native["title"].as_str() { meta.title = title.to_owned(); }
                        if let Some(created) = native["createdAt"].as_u64() { meta.created_at = created; }
                        let _ = store::Store { dir: entry.path(), meta: meta.clone(), seq: 0, poisoned: false }.save();
                    }
                }
                // 最近活动取事件日志的修改时间：每轮对话都会追加事件，比读取正文便宜得多，
                // 也覆盖 Claude 与 Codex 两种来源。没有日志（新建未发言）回落到创建时间。
                let last_activity = std::fs::metadata(entry.path().join("events.jsonl"))
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64)
                    .filter(|ts| *ts > 0)
                    .unwrap_or(meta.created_at);
                sessions.push(json!({"id":meta.session_id,"provider":meta.provider,"title":meta.title,"createdAt":meta.created_at,"archived":meta.archived,"pinned":meta.pinned,"pinnedAt":meta.pinned_at,"lastActivity":last_activity,"status":codex_by_id.get(&meta.session_id).map(|v|v["status"].clone())}));
            }
        }
        sessions.sort_by_key(|item| std::cmp::Reverse(item["createdAt"].as_u64().unwrap_or_default()));
        Ok(sessions)
    }).await
}
#[tauri::command]
pub async fn ai_runtime_rename(
    app: AppHandle,
    session_id: String,
    workspace: String,
    title: String,
) -> Result<(), String> {
    block(move || {
        if !store::valid_id(&session_id) || title.trim().is_empty() || title.chars().count() > 120 {
            return Err("无效会话或标题".into());
        }
        let root = store::workspace(&workspace)?;
        let base = base(&app)?;
        let _guard = registry::LIFECYCLE.lock().map_err(|e| e.to_string())?;
        let dir = base.join(&session_id);
        if !dir.exists() {
            return Ok(());
        }
        let _lease = store::Lease::acquire(&base.join(format!("{session_id}.lock")))?;
        let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
        let mut meta = store::Store::metadata(&dir, &root)?;
        if meta.provider == Provider::Codex {
            let native = meta.native_id.as_deref().unwrap_or(&meta.session_id);
            options::codex_set_thread_name(&root, native, title.trim())?;
        } else {
            return Err("Claude 会话标题由 CLI 管理，请在 Claude Code 中使用 /rename".into());
        }
        meta.title = title.trim().into();
        store::Store {
            dir,
            meta,
            seq: 0,
            poisoned: false,
        }
        .save()
    })
    .await
}
/// 归档 / 取消归档。只改 `meta.json` 的一个布尔位：事件日志、CLI 原生会话都不动，
/// 所以归档不是删除，随时能原样翻回来。
#[tauri::command]
pub async fn ai_runtime_archive(
    app: AppHandle,
    session_id: String,
    workspace: String,
    archived: bool,
) -> Result<bool, String> {
    block(move || {
        enabled(&app)?;
        let root = store::workspace(&workspace)?;
        let base = base(&app)?;
        store::Store::set_archived(&base, &session_id, &root, archived)
    })
    .await
}
/// 置顶 / 取消置顶。同样只改 `meta.json`：置顶只是侧栏「置顶」章节的归位，
/// 事件日志与 CLI 原生会话都不动。
#[tauri::command]
pub async fn ai_runtime_set_pinned(
    app: AppHandle,
    session_id: String,
    workspace: String,
    pinned: bool,
) -> Result<bool, String> {
    block(move || {
        enabled(&app)?;
        let root = store::workspace(&workspace)?;
        let base = base(&app)?;
        store::Store::set_pinned(&base, &session_id, &root, pinned)
    })
    .await
}
/// 在本项目的会话正文里搜索。
///
/// 这里故意不拿 `IO_LOCK`：一次扫描最多读上百 MiB，握着锁会把正在运行的会话的
/// 事件写入一起卡住。追加式日志的最后一行有可能正被写了一半，而扫描本来就跳过
/// 解析不了的行——宁可漏掉那半行，也不冻结对话。
#[tauri::command]
pub async fn ai_runtime_search(
    app: AppHandle,
    workspace: String,
    query: String,
    limit: Option<usize>,
    include_archived: Option<bool>,
) -> Result<Value, String> {
    block(move || {
        enabled(&app)?;
        let root = store::workspace(&workspace)?;
        let base = base(&app)?;
        search::search(
            &base,
            &root,
            &query,
            limit.unwrap_or(search::MAX_HITS),
            include_archived.unwrap_or(false),
        )
    })
    .await
}
#[tauri::command]
pub async fn ai_runtime_stop_project(app: AppHandle, workspace: String) -> Result<(), String> {
    block(move || {
        // 项目被删除（包括原本用来打开它的符号链接已消失）时，关闭操作仍要能完成；
        // 只有「启动运行」才要求目录真实存在。
        let stopping = {
            let _guard = registry::LIFECYCLE.lock().map_err(|e| e.to_string())?;
            let root = store::workspace(&workspace).ok();
            // 先收掉这个项目的排队项，再放回合去停：worker 收尾会立即调度队首，
            // 反过来做就可能把用户正要删掉的项目又跑起来一条。
            cancel_queued(&app, |request| {
                root.as_deref() == store::workspace(&request.workspace).ok().as_deref()
                    || same_workspace_path(&workspace, &request.workspace)
            })?;
            let runs = registry::all().into_iter().filter(|r| {
                root.as_deref() == Some(r.workspace.as_str())
                    || same_workspace_path(&workspace, &r.requested_workspace)
                    || same_workspace_path(&workspace, &r.workspace)
            }).collect::<Vec<_>>();
            registry::flag_stop(&runs);
            runs
        };
        registry::wait_stopped(stopping)
    })
    .await
}
fn same_workspace_path(a: &str, b: &str) -> bool {
    fn key(path: &str) -> String {
        if cfg!(windows) {
            let path = path.replace('/', "\\").to_lowercase();
            let path = path
                .strip_prefix("\\\\?\\unc\\")
                .map(|p| format!("\\\\{p}"))
                .unwrap_or_else(|| path.strip_prefix("\\\\?\\").unwrap_or(&path).to_owned());
            path.trim_end_matches('\\').to_string()
        } else {
            path.trim_end_matches('/').to_string()
        }
    }
    key(a) == key(b)
}
pub fn lifecycle_lock() -> std::sync::MutexGuard<'static, ()> {
    registry::LIFECYCLE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}
pub fn stop_for_disable(app: &AppHandle) -> Result<(), String> {
    registry::stop_all()?;
    cancel_queued(app, |_| true)
}
pub fn has_runs() -> bool {
    !registry::all().is_empty() || queued().lock().unwrap_or_else(|e| e.into_inner()).values().any(|items| !items.is_empty())
}
pub fn reap_all_for_exit() {
    let _guard = registry::LIFECYCLE
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _ = registry::stop_all();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_close_identity_does_not_require_existing_directory() {
        assert!(same_workspace_path("missing/root/", "missing/root"));
        assert!(!same_workspace_path("missing/root", "missing/other"));
        #[cfg(windows)]
        {
            assert!(same_workspace_path(
                r"D:/Gone/Project/",
                r"\\?\d:\gone\project"
            ));
            assert!(same_workspace_path(
                r"//server/share/project",
                r"\\?\UNC\server\share\project"
            ));
        }
    }
    #[test]
    fn only_the_queue_head_may_claim_an_external_blocker() {
        // 入队和顺序变更共用同一判定：非队首永远不许说「被外部任务挡住」。
        assert_eq!(queued_status(true, true), task_status::WAITING_EXTERNAL);
        assert_eq!(queued_status(false, true), task_status::QUEUED);
        assert_eq!(queued_status(true, false), task_status::QUEUED);
        assert_eq!(queued_status(false, false), task_status::QUEUED);
    }
    #[test]
    fn rejects_untrusted_oversized_and_injected_inputs() {
        let mut r = SendRequest {
            session_id: "session".into(),
            run_id: "run".into(),
            provider: Provider::Claude,
            workspace: "root".into(),
            title: "title".into(),
            prompt: "hello".into(),
            images: vec![],
            trusted: false,
            model: None,
            effort: None,
            permission: Default::default(),
            fast: None,
            service_tier: None,
            command: None,
            plan_mode: false,
            plan: None,
            additional_dirs: vec![],
            plan_turn: None,
        };
        assert!(validate(&r).is_err());
        r.trusted = true;
        assert!(validate(&r).is_ok());
        r.prompt.clear();
        r.images.push("cached.png".into());
        assert!(validate(&r).is_ok());
        r.images.clear();
        assert!(validate(&r).is_err());
        r.prompt = "hello".into();
        r.session_id = "../x".into();
        assert!(validate(&r).is_err());
    }
    fn base_request() -> SendRequest {
        SendRequest {
            session_id: "session".into(),
            run_id: "run".into(),
            provider: Provider::Codex,
            workspace: "root".into(),
            title: "title".into(),
            prompt: "hello".into(),
            images: vec![],
            trusted: true,
            model: None,
            effort: None,
            permission: Default::default(),
            fast: None,
            service_tier: None,
            command: None,
            plan_mode: false,
            plan: None,
            additional_dirs: vec![],
            plan_turn: None,
        }
    }
    #[test]
    fn codex_enqueue_freezes_project_config_but_keeps_the_turn_permission() {
        let mut request = base_request();
        request.permission = options::PermissionMode::Auto;
        request.fast = Some(true);
        freeze_codex_config(&mut request, &json!({"model":"cfg-model","effort":"high","serviceTier":"fast-id","permission":"read"}));
        assert_eq!(request.model.as_deref(), Some("cfg-model"));
        assert_eq!(request.effort.as_deref(), Some("high"));
        assert_eq!(request.service_tier.as_deref(), Some("fast-id"));
        assert_eq!(request.fast, None);
        // 权限来自本轮选择，不能被项目配置或默认值改写。
        assert!(matches!(request.permission, options::PermissionMode::Auto));
    }
    #[test]
    fn plan_decisions_accept_only_the_backend_generated_turn() {
        let mut request = base_request();
        request.prompt.clear();
        request.plan = Some(PlanRequest { plan_id: "thread/plan".into(), revision: 1, decision: plans::Decision::Approve, feedback: None });
        assert!(validate(&request).is_ok());
        // 批准路径不允许夹带正文、图片或第二个模式。
        request.prompt = "顺便改一下".into();
        assert!(validate(&request).is_err());
        request.prompt.clear();
        request.plan_mode = true;
        assert!(validate(&request).is_err());
        request.plan_mode = false;
        // 要求修改必须写清反馈；暂不执行不启动回合。
        request.plan = Some(PlanRequest { plan_id: "thread/plan".into(), revision: 1, decision: plans::Decision::RequestChanges, feedback: Some("  ".into()) });
        assert!(validate(&request).is_err());
        request.plan = Some(PlanRequest { plan_id: "thread/plan".into(), revision: 1, decision: plans::Decision::Defer, feedback: None });
        assert!(validate(&request).is_err());
        // Claude 没有 next_turn 审批契约，不能假装支持。
        request.plan = Some(PlanRequest { plan_id: "thread/plan".into(), revision: 1, decision: plans::Decision::Approve, feedback: None });
        request.provider = Provider::Claude;
        assert!(validate(&request).is_err());
    }
    #[test]
    fn plan_mode_is_read_only_and_cannot_combine_with_full_access() {
        let mut request = base_request();
        request.plan_mode = true;
        assert!(validate(&request).is_ok());
        request.permission = options::PermissionMode::Full;
        assert!(validate(&request).is_err());
        request.permission = options::PermissionMode::Ask;
        request.command = Some(commands::CommandIntent::CodexCompact);
        assert!(validate(&request).is_err());
    }
    #[test]
    fn extra_directories_must_be_absolute_existing_and_unique() {
        let root = std::env::temp_dir().join(format!("forge-ai-dirs-{}", std::process::id()));
        let nested = root.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let mut request = base_request();
        request.additional_dirs = vec![nested.to_string_lossy().into_owned(), nested.to_string_lossy().into_owned(), root.to_string_lossy().into_owned()];
        let canonical_root = std::fs::canonicalize(&root).unwrap().to_string_lossy().into_owned();
        let dirs = validated_dirs(&request, &canonical_root).unwrap();
        assert_eq!(dirs.len(), 1);
        request.additional_dirs = vec!["relative/dir".into()];
        assert!(validated_dirs(&request, "ignored").is_err());
        request.additional_dirs = vec![std::env::temp_dir().join("forge-ai-missing-dir").to_string_lossy().into_owned()];
        assert!(validated_dirs(&request, "ignored").is_err());
        request.additional_dirs = (0..17).map(|index| root.join(index.to_string()).to_string_lossy().into_owned()).collect();
        assert!(validated_dirs(&request, "ignored").is_err());
        std::fs::remove_dir_all(root).ok();
    }
    #[test]
    fn permission_answers_are_shaped_before_any_protocol_sees_them() {        // 「改完再允许」是有条件的能力：这里只管形状，能不能兑现由各协议自己拒。
        assert!(validate_answer("permission", &json!({"allow":true,"input":{"command":"ls"}})).unwrap().is_none());
        assert!(validate_answer("permission", &json!({"allow":true,"command":"bad"})).is_err());
        assert!(validate_answer("permission", &json!({"allow":true,"remember":{"tool":"Edit","root":"src/main.rs"}})).is_err());
        assert!(validate_answer("permission", &json!({"allow":false,"remember":{"tool":"Edit"}})).is_err());
        assert_eq!(
            validate_answer("permission", &json!({"allow":true,"remember":{"tool":"Edit"}})).unwrap().map(|rule| rule.tool),
            Some("Edit".into())
        );
        assert!(validate_answer("question", &json!({"allow":true})).is_err());
        assert!(validate_answer("permission", &json!({"allow":false})).is_ok());
    }
    #[test]
    fn the_worker_only_auto_answers_requests_it_can_read() {
        let root = std::env::temp_dir().join("forge-ai-runtime-auto-allow");
        let mut memory = approvals::ApprovalMemory::default();
        assert!(memory.remember(approvals::StandingRule { tool: "Edit".into(), root: Some(root.clone()) }));
        let inside = json!({"toolName":"Edit","input":{"file_path":root.join("src").join("new.rs").to_string_lossy()}});
        assert!(auto_answer_for(&memory, &inside).is_some());
        // 目录外的目标、没有工具名、没有入参对象、命令类入参——全部回到问用户。
        assert!(auto_answer_for(&memory, &json!({"toolName":"Edit","input":{"file_path":"C:/elsewhere/x.rs"}})).is_none());
        assert!(auto_answer_for(&memory, &json!({"input":{"file_path":root.join("x.rs").to_string_lossy()}})).is_none());
        assert!(auto_answer_for(&memory, &json!({"toolName":"Edit"})).is_none());
        assert!(auto_answer_for(&memory, &json!({"toolName":"Bash","input":{"command":"ls"}})).is_none());
        // 提问卡片即使带着 toolName 也不算授权请求：调用方按 kind 分流，这里只保证读不懂时不猜。
        assert!(auto_answer_for(&approvals::ApprovalMemory::default(), &inside).is_none());
    }
}
