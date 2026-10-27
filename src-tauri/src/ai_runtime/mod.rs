//! 本地 CLI 对话的受限命令集：不接受任意 RPC，也不执行任意可执行文件。
//! Restricted desktop commands for local CLI conversations. No arbitrary RPC or executable IPC.
mod approvals;
mod checkpoint;
mod claude;
mod activity;
mod commands;
mod codex;
mod events;
mod history;
mod images;
#[cfg(test)]
mod integration_tests;
mod outline;
mod plans;
mod process;
mod protocol;
mod registry;
mod search;
// `ai_cli::codex_catalog` 要用这条通道现问 Codex 字段取值域（它起 app-server 的那套
// 进程与超时逻辑在这里，不再抄第二份），所以这个模块要对 crate 内可见。
pub(crate) mod options;
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
use std::fs;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc, Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
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
    /// Codex 入队时按生效沙箱算好的附加目录落点；同样不接受前端伪造。
    #[serde(skip)]
    codex_grant: Option<options::SandboxGrant>,
    #[serde(default)]
    command: Option<commands::CommandIntent>,
    /// 计划模式：这一轮只产出计划，不执行修改。旧的布尔入参，只用于没带 `mode` 的请求。
    #[serde(default)]
    plan_mode: bool,
    /// CLI 自己的模式 id（Claude 的 `--permission-mode` 取值、Codex 的 collaborationMode 取值）。
    /// 入队时按这版 CLI 报过的取值定稿，执行时不再回看界面。
    #[serde(default)]
    mode: Option<String>,
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
    /// 与 plans.lock 分离：后者只保护一次 RMW，这把锁保护完整的排队与启动生命周期。
    _claim: Arc<store::Lease>,
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
/// 队列只活在当前桌面进程；把 run id 一并交给前端，避免另一个 Forge 进程
/// 从共享日志看到 queued 后，误画出实际上无法操作的编辑/取消按钮。
fn queued_run_ids(session_id: &str) -> Vec<String> {
    queued().lock().unwrap_or_else(|e| e.into_inner()).get(session_id)
        .map(|items| items.iter().map(|request| request.run_id.clone()).collect())
        .unwrap_or_default()
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
/// 先解析源和目标，再改队列。目标来自另一个窗口的旧快照时必须原样失败，不能先把源任务删掉。
fn move_queued_run(items: &mut VecDeque<SendRequest>, run_id: &str, before_run_id: Option<&str>) -> Result<(), &'static str> {
    let old = items.iter().position(|item| item.run_id == run_id).ok_or(NOT_QUEUED_HERE)?;
    if before_run_id == Some(run_id) { return Ok(()); }
    let target = match before_run_id {
        Some(before) => items.iter().position(|item| item.run_id == before).ok_or(NOT_QUEUED_HERE)?,
        None => items.len(),
    };
    let item = items.remove(old).ok_or(NOT_QUEUED_HERE)?;
    // 删除发生在目标之前时，目标下标左移一位；None 的 len 也按同一规则落到新队尾。
    items.insert(target.saturating_sub(usize::from(old < target)), item);
    Ok(())
}
/// 只让明确的活动或写锁阻塞。Unknown/读取失败没有占用证据，按产品契约允许发送；
/// 真正的原生写锁冲突仍由 CLI 在启动握手时明确拒绝。
fn activity_blocks_dispatch(state: Result<activity::State, String>, writer_held: Result<bool, String>) -> bool {
    matches!(state, Ok(activity::State::Running | activity::State::External | activity::State::Conflict))
        || matches!(writer_held, Ok(true))
}

/// 自动恢复必须保守：只试一次，只续接已经真正开跑且没有悬空审批的普通回合。
/// 外部占用探测失败按失败处理，不能用一次不确定的重连抢写同一原生会话。
fn should_reconnect_after_disconnect(
    started: bool,
    attempts: u8,
    pending: bool,
    ordinary: bool,
    external: Result<bool, String>,
) -> Result<bool, String> {
    if !started || attempts >= 1 || pending || !ordinary { return Ok(false); }
    external.map(|occupied| !occupied).map_err(|error| format!("无法确认 CLI 会话是否被外部占用：{error}"))
}

/// 每次重连都重新生成参数。首轮可能用 `--session-id`，恢复时必须切成 `--resume`；
/// 复用旧 argv 会启动一条同名新会话，表面连上了，实际上下文已经断裂。
fn runtime_args(request: &SendRequest, claude_mode: &str, native: Option<&str>) -> Vec<String> {
    if request.provider == Provider::Codex { return vec!["app-server".into()]; }
    let mut args = vec![
        "-p".into(), "--input-format".into(), "stream-json".into(), "--output-format".into(),
        "stream-json".into(), "--verbose".into(), "--include-partial-messages".into(),
        "--permission-prompt-tool".into(), "stdio".into(), "--permission-mode".into(), claude_mode.into(),
    ];
    let read_only = claude_mode == "plan" || request.permission == options::PermissionMode::Read;
    if read_only {
        // 允许只读排查与任务清单工具；精确对应 Claude Code 内置的 Task 工具名。
        args.extend(["--allowedTools", "Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].map(str::to_owned));
        args.extend(["--disallowedTools", "Bash", "Edit", "Write", "NotebookEdit"].map(str::to_owned));
    }
    if claude_mode == "bypassPermissions" { args.push("--allow-dangerously-skip-permissions".into()); }
    if let Some(id) = native {
        args.extend(["--resume".into(), id.into()]);
    } else {
        // 只带 `--session-id`，绝不带 `--name`：Claude 会把名字写成 custom-title 记录，
        // 而 custom-title 压着 CLI 自己的 ai-title 和首条消息，会话就永远停在占位名上。
        args.extend(["--session-id".into(), request.session_id.clone()]);
    }
    if let Some(model) = &request.model { args.extend(["--model".into(), model.clone()]); }
    if let Some(effort) = &request.effort { args.extend(["--effort".into(), effort.clone()]); }
    for dir in &request.additional_dirs { args.extend(["--add-dir".into(), dir.clone()]); }
    args
}

fn spawn_runtime_process(request: &SendRequest, claude_mode: &str, native: Option<&str>) -> Result<(Process, String), String> {
    let args = runtime_args(request, claude_mode, native);
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let (command, version) = ai_cli::runtime_command(request.provider, &refs)?;
    Ok((Process::spawn(command, &request.workspace)?, version))
}

/// 新进程必须配新协议状态机。Codex 恢复态只附着 `recovery_turn`，不发送提示词；
/// Claude 没有 attach 协议，因此拒绝进入这条路径。
fn runtime_protocol(
    request: &SendRequest,
    native: Option<String>,
    service_tier: &str,
    codex_policy: &Option<Value>,
    claude_mode: &str,
    recovery_turn: Option<String>,
    claude_agents: Vec<(String, Option<String>)>,
) -> Result<Box<dyn Protocol>, String> {
    Ok(match request.provider {
        Provider::Codex => {
            let recovering = recovery_turn.is_some();
            let protocol = codex::Codex::new(request.workspace.clone(), if recovering { String::new() } else { request.prompt.clone() }, native)
                .with_images(if recovering { vec![] } else { request.images.clone() })
                .with_options(request.model.clone(), request.effort.clone())
                .with_policy(request.permission, service_tier.to_owned())
                .with_sandbox_policy(codex_policy.clone())
                .with_command(if recovering { None } else { request.command })
                .with_mode(request.mode.clone().unwrap_or_else(|| if request.plan_mode { "plan".into() } else { options::default_mode_id(Provider::Codex).into() }))
                .with_decision(if recovering { None } else { request.plan_turn.as_ref().map(|turn| codex::Decision {
                    mode: if turn.decision == plans::Decision::Approve { "default" } else { "plan" },
                    native_plan_id: turn.native_plan_id.clone(),
                    content_hash: turn.content_hash.clone(),
                }) });
            Box::new(if let Some(turn) = recovery_turn { protocol.with_recovery_turn(turn) } else { protocol })
        }
        Provider::Claude => {
            if recovery_turn.is_some() { return Err("Claude CLI 不支持附着正在生成的旧回合，已停止以避免重复执行".into()); }
            Box::new(claude::Claude::new(request.workspace.clone(), request.prompt.clone(), native)
                .with_agents(claude_agents)
                .with_images(images::claude_blocks(&request.images.iter().map(PathBuf::from).collect::<Vec<_>>())?)
                .with_model(request.model.clone()).with_command(request.command)
                .with_plan(claude_mode == "plan"))
        }
    })
}

/// 这一轮开不开得起来：外部进程占着会话，或 Codex 的原生写锁还握在别的窗口手里。
fn externally_blocked(base: &std::path::Path, session_id: &str, root: &str) -> bool {
    activity_blocks_dispatch(activity::state(base, session_id, root), activity::writer_held(base, session_id, root))
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
            move_queued_run(items, &run_id, before_run_id.as_deref())?;
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
            let run = registry::for_session(&session_id);
            // 锁内必须真的把停止位置上：只拿引用不置位，下面的等待就是在等一个
            // 没被要求停止的回合——白等 15 秒后必然报「任务仍在清理」。
            if let Some(run) = &run { run.request_stop(); }
            (session_id.clone(), run)
        };
        // 有回合在跑：置位即返回——它的收尾（finish → schedule_next）会带着队首这一项
        // 重新调度，等待放在锁外也不需要：一个卡住的回合不该按住队列调度。
        if stopping.is_some() { return Ok(()); }
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
/// 把当前标题推给 Codex 原生线程，并记下已同步的那个名字。
/// CLI 只给磁盘上真实存在（跑过回合、有 rollout）的线程改名，所以调用方一律按
/// 尽力而为处理：这一刻推不动，回合结束还会再推一次。
fn push_codex_title(store: &mut store::Store) -> Result<(), String> {
    if store.meta.provider != Provider::Codex || store.meta.title.trim().is_empty() { return Ok(()); }
    if store.meta.native_title_synced.as_deref() == Some(store.meta.title.as_str()) { return Ok(()); }
    let native = store.meta.native_id.clone().ok_or("Codex 会话尚未建立，无法命名")?;
    let title = store.meta.title.clone();
    options::codex_set_thread_name(&store.meta.workspace, &native, &title)?;
    store.meta.native_title_synced = Some(title);
    store.save()
}
/// 会话的第一条消息：标题立刻换成首句摘要，不等 CLI 也不等原生历史刷新。
/// 规则与原生历史解析共用 `history::auto_title`，两个来源写出的必须是同一个字符串。
/// 用户已经改过标题（`title_locked`）就不再动它。
fn title_first_message(store: &mut store::Store, request: &SendRequest, include_user: bool) -> Result<(), String> {
    if !include_user || store.seq != 0 || request.plan_turn.is_some() || store.meta.title_locked { return Ok(()); }
    if let Some(title) = history::human_text(&request.prompt).as_deref().and_then(history::auto_title) {
        if title == store.meta.title { return Ok(()); }
        store.meta.title = title;
        store.save()?;
        // 命名绝不能吃掉用户这条消息：线程还没建出来时这一步本来就会失败。
        let _ = push_codex_title(store);
    }
    Ok(())
}
/// 旧版 create 预建的 Codex 线程是个幽灵 ID：进程早已退出，磁盘上没有 rollout，
/// 拿它去 `thread/resume` 必然「no rollout found」。这类会话一条消息都没发过，
/// 丢掉这个 ID，首条消息自己 `thread/start` 出真正存在的线程。
fn drop_phantom_thread(store: &mut store::Store) -> Result<(), String> {
    if store.meta.provider != Provider::Codex || store.seq != 0 { return Ok(()); }
    if store.meta.native_id.as_deref() != Some(store.meta.session_id.as_str()) { return Ok(()); }
    store.meta.native_id = None;
    store.save()
}

fn append_task_status(app: &AppHandle, request: &SendRequest, status: &str, extra: Value, include_user: bool) -> Result<(), String> {
    let root = store::workspace(&request.workspace)?;
    let base = base(app)?;
    let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
    // 排队、取消、状态回写都可能发生在某一轮正在跑的时候，这里没有租约，
    // 绝不能走 `Store::open` 的「上次运行未正常结束」修复：那会把还活着的回合写成 cancelled。
    // 发送路径一律不种子标题：命名只由 `title_first_message` 和原生历史发现决定，
    // 客户端传来的旧标签名会把过期占位写进新建的 meta.json。
    let (mut store, tasks) = store::Store::open_for_append_with_tasks(&base, &request.session_id, &root, request.provider, "", "")?;
    // 用户消息永远落盘：它是这条排队项的正文，跳过就等于把消息弄丢了。
    if !include_user && status_already_recorded(tasks.get(&request.run_id), status, &extra) { return Ok(()); }
    // 会话的第一条事件（seq 归零说明日志刚建）：标题自动换成首条消息的摘要，
    // 否则新建会话永远顶着「新会话」，要等下次原生历史发现才被动改名。
    title_first_message(&mut store, request, include_user)?;
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

/// 日志里已经记着同一个状态、且这次要补的字段一个都没变，就是空转。
/// 秒级队列监控在外部 CLI 占着会话时每秒都会写一次 `waitingExternal`，
/// 顺序回写也会在没动过的队列上重写一遍 `queued`：真实日志里出现过连续三条
/// 字节完全相同的排队事件。挡掉它们，前端才不会每秒重新投影一次整条会话。
fn status_already_recorded(record: Option<&Value>, status: &str, extra: &Value) -> bool {
    let Some(record) = record else { return false; };
    if record["status"].as_str() != Some(status) { return false; }
    extra.as_object().is_none_or(|fields| fields.iter().all(|(key, value)| record.get(key.as_str()) == Some(value)))
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
    // 计划模式和斜杠命令不能同轮：命令自己决定这一轮做什么，模式参数会被它吞掉。
    // 「计划 + 完全访问」不再是冲突：Claude 的 --permission-mode 一档只能取一个值，
    // plan 与 bypassPermissions 天然互斥；Codex 的协作模式和沙箱档本来就是两条轴。
    let planned = request.plan_mode || request.mode.as_deref() == Some("plan");
    if planned && request.command.is_some() {
        return Err("计划模式不能同时使用斜杠命令".into());
    }
    if let Some(plan) = &request.plan {
        // 决策回合由后端生成唯一的执行正文；前端只能提交 id、版本、决策与反馈。
        if request.provider != Provider::Codex {
            return Err("计划审阅目前只支持 Codex".into());
        }
        if plan.plan_id.trim().is_empty() || plan.plan_id.len() > 512 || plan.revision < 1 {
            return Err("计划审阅标识无效".into());
        }
        if planned || request.command.is_some() || !request.images.is_empty() || !request.prompt.trim().is_empty() {
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
    Ok(())
}

/// 入队时固定本轮选项：显式选择优先，项目配置只补未选择的默认值。
fn freeze_codex_config(request: &mut SendRequest, config: &Value) {
    if request.model.is_none() { request.model = config["model"].as_str().map(str::to_owned); }
    if request.effort.is_none() { request.effort = config["effort"].as_str().map(str::to_owned); }
    if request.fast.is_none() { request.service_tier = config["serviceTier"].as_str().map(str::to_owned); }
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

const MAX_TEXT_ATTACHMENT_BYTES: usize = 16 * 1024 * 1024;
static TEXT_ATTACHMENT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/** 长选区只落到系统临时目录；工作区和项目源码目录永远不会收到这些中转文件。 */
fn save_text_attachment_to(directory: PathBuf, text: &str) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Err("临时附件内容不能为空".into());
    }
    if text.len() > MAX_TEXT_ATTACHMENT_BYTES {
        return Err("临时附件不能超过 16 MB".into());
    }
    fs::create_dir_all(&directory)
        .map_err(|error| format!("创建临时附件目录失败：{error}"))?;
    let directory = fs::canonicalize(&directory)
        .map_err(|error| format!("读取临时附件目录失败：{error}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = TEXT_ATTACHMENT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = directory.join(format!("context-{}-{stamp}-{sequence}.txt", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| format!("创建临时附件失败：{error}"))?;
    file.write_all(text.as_bytes())
        .map_err(|error| format!("保存临时附件失败：{error}"))?;
    Ok(json!({
        "path": path.to_string_lossy(),
        "directory": directory.to_string_lossy(),
    }))
}

#[tauri::command]
pub async fn ai_runtime_save_text_attachment(app: AppHandle, text: String) -> Result<Value, String> {
    block(move || {
        enabled(&app)?;
        save_text_attachment_to(std::env::temp_dir().join("forge-ai-context"), &text)
    })
    .await
}

fn file_line_count(path: &str) -> Result<u64, String> {
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() || path.as_os_str().len() > 32_768 {
        return Err("文件路径必须是绝对路径".into());
    }
    let mut file = fs::File::open(&path).map_err(|error| format!("读取文件失败：{error}"))?;
    if !file
        .metadata()
        .map_err(|error| format!("读取文件信息失败：{error}"))?
        .is_file()
    {
        return Err("目标不是文件".into());
    }
    // 按换行字节流式计数，不把大文件整份读进内存；空文件在编辑器里也有第 1 行。
    let mut lines = 1_u64;
    let mut previous_was_cr = false;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("读取文件失败：{error}"))?;
        if read == 0 {
            break;
        }
        for byte in &buffer[..read] {
            match *byte {
                b'\r' => {
                    lines = lines.saturating_add(1);
                    previous_was_cr = true;
                }
                b'\n' if previous_was_cr => previous_was_cr = false,
                b'\n' => lines = lines.saturating_add(1),
                _ => previous_was_cr = false,
            }
        }
    }
    Ok(lines)
}

#[tauri::command]
pub async fn ai_runtime_file_line_count(app: AppHandle, path: String) -> Result<u64, String> {
    block(move || {
        enabled(&app)?;
        file_line_count(&path)
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
        if provider == Provider::Claude {
            return Ok(options::claude_configured_models(catalog, &store::workspace(&workspace)?));
        }
        // Codex 的「模型清单」改的是它自己的目录文件，而 `model/list` 不读那份文件，
        // 所以排除与新增要由我们并进来，否则在清单里配完，对话框里还是老样子。
        Ok(options::apply_picker_patch(catalog, ai_cli::codex_catalog::picker_patch(&app)))
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
/// 新建会话：只建记录，不起名也不碰 CLI。标题等首条用户消息发出后由 `title_first_message`
/// 自动取；占位名一旦落成 custom-title / thread name，就把真正的自动标题永久压掉了。
/// Codex 也不在这里 `thread/start`：空线程只活在那个已退出的进程内存里，磁盘上没有
/// rollout，之后既不能 `thread/resume` 也不能 `thread/name/set`（实测 0.164.0 一律
/// 回「no rollout found」）。真正的线程由首条消息那一轮自己建出来再绑上。
#[tauri::command]
pub async fn ai_runtime_create(app: AppHandle, provider: Provider, workspace: String, session_id: Option<String>) -> Result<Value, String> {
    block(move || {
        let _lifecycle = registry::LIFECYCLE.lock().map_err(|e| e.to_string())?;
        let _cli_gate = ai_cli::runtime_gate(&app).map_err(|_| "CLI 管理进行中，请稍后创建会话")?;
        if ai_cli::management_busy() { return Err("CLI 管理进行中，请稍后创建会话".into()); }
        enabled(&app)?;
        if !ai_cli::settings::enabled(&app, provider) { return Err("该 CLI 已在设置中停用，请先在设置中启用".into()); }
        let root = store::workspace(&workspace)?;
        let base = base(&app)?;
        let id = session_id.filter(|id| store::valid_id(id)).ok_or("会话 ID 无效")?.to_owned();
        let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
        let target = store::Store::open(&base, &id, &root, provider, "", "")?;
        Ok(json!({"id":id,"provider":provider,"title":target.meta.title,"createdAt":target.meta.created_at}))
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
            let queued_run_ids = queued_run_ids(&id);
            // activeRunId/queuedRunIds 是控制权，不是展示提示：只有当前进程登记的 id
            // 才允许本窗口发送停止、编辑和重排命令。
            let active_run_id = registry::for_session(&id).map(|run| run.id.clone());
            records.push(json!({"sessionId":id,"state":state,"queuedCount":queued_run_ids.len(),
                "activeRunId":active_run_id,"queuedRunIds":queued_run_ids}));
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
        let _cli_gate = ai_cli::runtime_gate(&app).map_err(|_| "CLI 管理进行中，请稍后发送")?;
        if ai_cli::management_busy() { return Err("CLI 管理进行中，请稍后发送".into()); }
        enabled(&app)?;
        let root = store::workspace(&request.workspace)?;
        request.additional_dirs = validated_dirs(&request, &root)?;
        // 进入队列前冻结规范化路径；后续切换工程或页面刷新不会丢失附件。
        if request.provider == Provider::Codex {
            // 队列必须冻结发送当刻的项目有效配置；执行时再读会被后续 UI 修改串改。
            let config = options::codex_project_config(&root)?;
            freeze_codex_config(&mut request, &config);
            // 附加目录同样在入队时定档：本轮到底能不能收下这些目录，取决于此刻生效的沙箱，
            // 而不是执行时才飘忽的项目配置。
            if !request.additional_dirs.is_empty() {
                request.codex_grant = Some(options::codex_sandbox_grant(&config, request.permission, &request.additional_dirs));
            }
        }
        // 模型和模式都在入队这一刻对着「这版 CLI 报过的取值」定稿：执行时缓存可能已经
        // 被升级刷掉，而用户在界面上选的、界面上看到的就是按下发送时的档位。
        let cached = options::cached_models(&models_path(&app)?, request.provider);
        let catalog = if request.provider == Provider::Claude { options::claude_configured_models(cached, &root) } else { cached };
        if let Some(model) = request.model.as_deref() {
            let canonical = options::canonical_model(&catalog, model);
            request.model = Some(if request.provider == Provider::Claude { options::configured_model(&catalog, &canonical) } else { canonical });
        }
        request.mode = Some(options::canonical_mode(&catalog, request.provider, request.mode.as_deref(), request.plan_mode, request.permission)?);
        validate(&request)?;
        let base = base(&app)?;
        // 子代理会话没有直连 CLI 的通道：直接发送一律拒绝，统一走转发命令。
        if let Ok(meta) = store::Store::metadata(&base.join(&request.session_id), &root) {
            if meta.agent.is_some() {
                return Err("子代理会话不能直接发送消息：请在子代理窗口发送，将由父会话转发".into());
            }
        }
        // 计划决策先抢提交权：双击或两个窗口只能有一个进入队列。
        // 执行正文完全由后端生成，前端无法在批准时夹带额外指令。
        if let Some(plan) = request.plan.clone() {
            let dir = base.join(&request.session_id);
            if !dir.exists() {
                return Err("会话不存在".into());
            }
            let claim = Arc::new(plans::claim(&dir).map_err(|_| "计划正在另一窗口提交，请稍后重试")?);
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
                        _claim: claim,
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
        // 入队时绝不提前向会话追加用户消息，避免在上一轮未结束时打乱时间线时序；提示词存入 extra 供队列条展示。
        let status = queued_status(!queue_has_items, external_active);
        append_task_status(app, request, status, json!({"prompt": request.prompt}), false)?;
        queued().lock().map_err(|e| e.to_string())?.entry(request.session_id.clone()).or_default().push_back(request.clone());
        return Ok(json!({"status":status}));
    }
    launch_task(app.clone(), request.clone(), true)?;
    // 线程已登记，但 CLI 还没给出任何有效协议帧。前端保留 submitting，
    // 等 worker 真正确认连接后收到 running 事件，不能把“已受理”冒充“已连接”。
    Ok(json!({"status":"submitting"}))
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
    // 那会把仍在跑的回合误写成 cancelled。
    let mut store = store::Store::open_for_append(&base, &request.session_id, root, request.provider, "", "")?;
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
    let store = {
        let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
        // CLI resume 只依赖原生会话 ID；Forge 镜像是否已经分页读完不能阻塞发送。
        // 历史继续由 ai_runtime_load 惰性同步，避免大会话在发送路径上反复扫描。
        let mut target = store::Store::open_existing(&base, &request.session_id, &root, request.provider, "", "")?;
        // 这两步都发生在 reserve 之前：失败就不能留下没有工作线程的运行登记。
        drop_phantom_thread(&mut target)?;
        title_first_message(&mut target, &request, include_user)?;
        target
    };
    let (run, controls) = Run::reserve(request.run_id.clone(), request.session_id.clone(), root, request.workspace.clone())?;
    let worker_run = run.clone();
    let session_id = request.session_id.clone();
    let spawned = std::thread::Builder::new().name("forge-ai-runtime".into()).spawn(move || {
        let session_lease = session_lease;
        let mut worker = Worker { app, run: worker_run.clone(), store, pending: HashMap::new(), approvals: approvals::ApprovalMemory::default(), next_request: 0, batch: vec![], batch_bytes: 0, flushed: Instant::now(), plan_claim: None, plan_applied: None, native_turn_id: None, summary_start: 0, compaction_index: 0, compaction_done: false, agents: HashMap::new(), agent_batches: HashMap::new(), broken_agents: HashSet::new() };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| worker.execute(request, controls, include_user)));
        let outcome = match result { Ok(result) => result, Err(_) => Err("AI 运行线程异常退出，未自动重发".into()) };
        if let Err(error) = &outcome { worker.fail_plan_claim(error); }
        // 停止位只是意图；协议若已明确完成，就保留 completed。真正超时/EOF/强杀的
        // 取消路径会由 execute 自己返回 cancelled，不能在这里用一个 bool 改写 CLI 事实。
        let (status, error) = match outcome { Ok(status) => (status, None), Err(error) => (task_status::FAILED, Some(error)) };
        if status == task_status::CANCELLED { worker.fail_plan_claim("任务已取消"); }
        worker.finish(status, error);
        let next_app = worker.app.clone();
        drop(session_lease);
        // 回合跑过之后线程在 CLI 那边才真实存在，欠着的改名在这里补上（不占会话锁）。
        worker.sync_native_title();
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
        // 管理操作期间队首原地等待；不能先弹出再把一次合法请求记成失败。
        let Ok(_cli_gate) = ai_cli::runtime_gate(app) else { return Ok(()); };
        let root = store::workspace(&request.workspace)?;
        let base = base(app)?;
        if externally_blocked(&base, session_id, &root) {
            append_task_status(app, &request, task_status::WAITING_EXTERNAL, json!({}), false)?;
            return Ok(());
        }
        queued().lock().map_err(|e| e.to_string())?.get_mut(session_id).and_then(VecDeque::pop_front);
        // 上一轮全部输出已彻底终结，排队任务出队启动时才正式将用户消息写入会话时间线
        match launch_task(app.clone(), request.clone(), true) {
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

/// 子代理在 Worker 里的登记项：子会话存储句柄加上一份状态去重副本。
/// `Store::append` 每次从文件尾对齐序号，句柄可以长期持有；状态副本用来挡掉
/// CLI 的重复生命周期通知（started/completed 成对、REPLACE 全量刷新）。
struct AgentRoute {
    store: store::Store,
    last_status: String,
    /// meta.json 写失败后置位：本轮不再尝试改元数据（避免每条事件重复报错），
    /// 事件照常追加——正文日志与 meta 是两个文件，后者坏了不该拖垮前者。
    meta_broken: bool,
    /// 历史读取错误只提示一次，后续轮询仍可恢复，不影响协议事件路由。
    history_warned: bool,
}

/// 子会话 id 由父会话 id 与路由 key（Claude 的 parent_tool_use_id、Codex 的
/// agentThreadId）派生：前缀截到 48 字符保证总长不超 `valid_id` 的 80 上限，
/// 后缀是 key 的稳定散列，同一代理跨轮重建得到同一个 id。
fn child_session_id(parent: &str, key: &str) -> String {
    // 目录名会跨版本持久化，不能依赖 Rust 未承诺算法稳定的 DefaultHasher。
    let mut hash = 0xcbf29ce484222325u64;
    for byte in key.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{}-ag{:012x}", &parent[..parent.len().min(48)], hash & 0xffff_ffff_ffff)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

/// 子代理 meta 的「重读-改-落盘」。Worker 句柄里的 meta 是子会话创建时的快照，
/// 而按需回填（sync_subagent）与发现导入随时可能从外部绑定 native_id、补终态；
/// 拿陈旧快照整份回写会把这些改动抹掉，下次打开就误判「未导入」而重复灌正文。
/// 所以每次都从磁盘重读最新 meta，把要改的字段叠上去再写回，返回是否真有变化。
fn revise_agent_meta(
    dir: &Path,
    root: &str,
    key: &str,
    update: impl FnOnce(&mut store::AgentInfo) -> bool,
) -> Result<bool, String> {
    let mut meta = store::Store::metadata(dir, root)?;
    let info = meta.agent.get_or_insert_with(|| store::AgentInfo {
        native_agent_id: None,
        agent_type: None,
        title: String::new(),
        tool_id: key.to_owned(),
        model: None,
        status: String::new(),
        started_at: 0,
        ended_at: None,
    });
    let changed = update(info);
    if changed {
        store::Store { dir: dir.to_path_buf(), meta, seq: 0, poisoned: false }.save()?;
    }
    Ok(changed)
}

/// 只恢复当前父会话的 Claude 路由；读取旧状态不代表重新启动代理。
fn load_claude_agent_routes(base: &Path, parent: &str, root: &str) -> Result<(HashMap<String, AgentRoute>, Vec<String>), String> {
    let mut routes = HashMap::new();
    let mut warnings = vec![];
    for entry in fs::read_dir(base).map_err(|e| e.to_string())?.take(20000).flatten() {
        let Ok(meta) = store::Store::metadata(&entry.path(), root) else { continue; };
        if meta.provider != Provider::Claude || meta.parent_session_id.as_deref() != Some(parent) { continue; }
        let Some(info) = &meta.agent else { continue; };
        if info.tool_id.is_empty() || store::is_tombstoned(base, &meta.session_id) { continue; }
        let restored = store::Store::open_for_append(base, &meta.session_id, root, Provider::Claude, &meta.title, "");
        match restored {
            Ok(target) => {
                let last_status = target.meta.agent.as_ref().map(|info| info.status.clone()).unwrap_or_default();
                routes.insert(info.tool_id.clone(), AgentRoute { store: target, last_status, meta_broken: false, history_warned: false });
            }
            Err(cause) => warnings.push(format!("子代理「{}」路由恢复失败：{cause}", meta.title)),
        }
    }
    Ok((routes, warnings))
}

/// 进程退出时 starting 与 running 都是未结束；不能把未启动成功的代理永远挂住。
fn stop_active_agent(dir: &Path, root: &str, key: &str) -> Result<bool, String> {
    revise_agent_meta(dir, root, key, |info| {
        if !matches!(info.status.as_str(), "" | "starting" | "running") { return false; }
        info.status = "stopped".into();
        info.ended_at = Some(now_ms());
        true
    })
}

/// 首见 key：建子会话并落好归属元数据，把存储句柄交还给 Worker 登记。
/// 返回 `None` 表示父会话已删除（stop 之前迟到的通知），调用方直接忽略。
/// 失败向上传播，由调用方降级为通知——子代理簿记不该炸掉整轮主对话。
fn open_agent_route(
    app: &AppHandle,
    base: &Path,
    parent_id: &str,
    workspace: &str,
    provider: Provider,
    key: &str,
    title: &str,
    data: &Value,
    run_id: &str,
) -> Result<Option<(String, store::Store)>, String> {
    let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
    if store::is_tombstoned(base, parent_id) {
        return Ok(None);
    }
    let child = child_session_id(parent_id, key);
    let mut target = store::Store::open(base, &child, workspace, provider, title, "")?;
    target.meta.parent_session_id = Some(parent_id.to_owned());
    let fresh = target.seq == 0;
    {
        // 子会话可能在上一个父回合里已存在（SendMessage 复活续聊）：
        // 保留已落盘的元数据，只补这次通知里新出现的字段。
        let info = target.meta.agent.get_or_insert_with(|| store::AgentInfo {
            native_agent_id: None, agent_type: None, title: title.to_owned(), tool_id: key.to_owned(),
            model: None, status: "running".into(), started_at: now_ms(), ended_at: None,
        });
        if info.title.trim().is_empty() { info.title = title.to_owned(); }
        if info.native_agent_id.is_none() {
            info.native_agent_id = data["agentId"].as_str().filter(|value| !value.is_empty()).map(str::to_owned);
        }
        if info.agent_type.is_none() {
            info.agent_type = data["agentType"].as_str().filter(|value| !value.is_empty()).map(str::to_owned);
        }
        if info.model.is_none() {
            info.model = data["resolvedModel"].as_str().or(data["model"].as_str()).filter(|value| !value.is_empty()).map(str::to_owned);
        }
        info.status = data["status"].as_str().unwrap_or("running").into();
        info.ended_at = matches!(info.status.as_str(), "completed" | "failed" | "stopped").then(now_ms);
    }
    target.save()?;
    // spawn 通知若带任务正文（Claude 的 Agent 工具入参），作为子会话的
    // 第一条用户消息：子代理视图打开时能看到它被安排了什么，而不只是工具活动。
    if fresh {
        if let Some(prompt) = data["prompt"].as_str().map(str::trim).filter(|prompt| !prompt.is_empty()) {
            let events = target.append(run_id, vec![("user".into(), json!({"text": prompt, "agentTask": true}))])?;
            let _ = app.emit(CHANNEL, &events);
        }
    }
    // 首次生命周期也属于子会话；没有正文时仍要立即显示运行状态。
    let mut initial = data.clone();
    initial["sessionId"] = json!(child);
    let events = target.append(run_id, vec![("agent".into(), initial)])?;
    let _ = app.emit(CHANNEL, &events);
    Ok(Some((child, target)))
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
    /// CLI 确认的原生回合 ID；Codex 断线后只能附着这个回合，绝不能新开一轮。
    native_turn_id: Option<String>,
    /// 原生摘要关联范围固定在进程启动前，不能用收到结束事件时的 EOF。
    summary_start: u64,
    compaction_index: u64,
    compaction_done: bool,
    /// 子代理 key → 子会话句柄。协议层产出 `agent` 事件与带 `agentKey` 的条目，
    /// 这里负责建子会话、路由事件、维护状态。
    agents: HashMap<String, AgentRoute>,
    /// 子代理条目的批缓冲：key → 待落盘条目。流式 delta 逐条写盘 + 逐条广播
    /// 会拖垮磁盘也压垮前端，与父会话共用同一套 flush 节奏。
    agent_batches: HashMap<String, Vec<(String, Value)>>,
    /// 注册失败的子代理 key：本轮不再为它重建子会话，后续事件直接丢弃。
    broken_agents: std::collections::HashSet<String>,
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
        // 子代理批缓冲与父批同节奏落盘。
        self.flush_agents()?;
        self.batch_bytes = 0;
        self.flushed = Instant::now();
        Ok(())
    }
    /// 落盘并广播一个子代理攒的批。IO_LOCK 每把批拿一次，绝不嵌套：
    /// flush 与 route_agent 都只在外层无锁时进来。
    fn flush_agent(&mut self, key: &str) -> Result<(), String> {
        let Some(batch) = self.agent_batches.get_mut(key) else { return Ok(()); };
        if batch.is_empty() { return Ok(()); }
        let batch = std::mem::take(batch);
        let Some(route) = self.agents.get_mut(key) else { return Ok(()); };
        let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
        let events = route.store.append(&self.run.id, batch)?;
        let _ = self.app.emit(CHANNEL, &events);
        Ok(())
    }
    /// 落盘所有子代理攒批；一个失败不连累其他，返回第一个错误。
    fn flush_agents(&mut self) -> Result<(), String> {
        let keys: Vec<String> = self.agent_batches.keys().cloned().collect();
        let mut first_error = None;
        for key in keys {
            if let Err(cause) = self.flush_agent(&key) {
                first_error.get_or_insert(cause);
            }
        }
        match first_error {
            Some(cause) => Err(cause),
            None => Ok(()),
        }
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
                Action::Emit { kind, mut data } => {
                    // 子代理条目：协议层带 agentKey 的写进子会话，不进父时间线。
                    if let Some(key) = data.get("agentKey").and_then(Value::as_str).map(str::to_owned) {
                        if let Some(object) = data.as_object_mut() {
                            object.remove("agentKey");
                            object.remove("parent");
                        }
                        self.route_agent(&key, kind, data)?;
                        continue;
                    }
                    if kind == "agent" {
                        self.agent_event(data)?;
                        continue;
                    }
                    if kind == "turn" {
                        self.native_turn_id = data["nativeTurnId"].as_str().map(str::to_owned);
                    }
                    if kind == "compaction" {
                        let starting = matches!(data["status"].as_str(), Some("running" | "compacting"));
                        if self.compaction_index == 0 || starting && self.compaction_done { self.compaction_index += 1; }
                        self.compaction_done = !starting;
                        data["episodeId"] = json!(format!("{}:{}", self.run.id, self.compaction_index));
                        data["sourceStart"] = json!(self.summary_start);
                    }
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
    /// 维护一个子代理的生命周期：首见时建子会话，之后更新元数据状态并把
    /// `agent` 事件同时写进子会话（状态条）与父会话（委派卡、子代理列表）。
    /// CLI 会成对/重复发生命周期通知，状态与信息都没变的那次不落盘。
    /// 簿记失败一律降级为父时间线通知，绝不炸掉整轮主对话。
    fn agent_event(&mut self, data: Value) -> Result<(), String> {
        let Some(key) = data["key"].as_str().map(str::to_owned).filter(|key| !key.is_empty()) else {
            return Ok(());
        };
        if self.broken_agents.contains(&key) { return Ok(()); }
        if !self.agents.contains_key(&key) {
            // 防护孤立通知：只有包含合法子代理特征（带 agentType 或 prompt 任务内容）时才允许注册新建，
            // 绝不为孤立的普通后台工具/命令通知无中生有创建子会话目录。
            let is_valid_spawn = data.get("agentType").is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                || data.get("prompt").is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                || self.store.meta.provider == Provider::Codex;
            if !is_valid_spawn {
                return Ok(());
            }
            let Some(base) = self.store.dir.parent().map(Path::to_path_buf) else {
                return self.notice_safely("会话存储路径无效，子代理无法登记".into());
            };
            let title = data["title"].as_str().map(str::trim).filter(|title| !title.is_empty()).unwrap_or("子代理").to_owned();
            match open_agent_route(&self.app, &base, &self.run.session_id, &self.run.workspace, self.store.meta.provider, &key, &title, &data, &self.run.id) {
                Ok(None) => return Ok(()),
                Ok(Some((child, store))) => {
                    let last_status = data["status"].as_str().unwrap_or("running").to_owned();
                    self.agents.insert(key.clone(), AgentRoute { store, last_status, meta_broken: false, history_warned: false });
                    // 父侧卡片与抽屉靠它跳进子会话；派生规则不暴露给前端。
                    let mut data = data;
                    if let Some(object) = data.as_object_mut() { object.insert("sessionId".into(), json!(child)); }
                    return self.queue("agent", data);
                }
                Err(cause) => {
                    self.broken_agents.insert(key.clone());
                    return self.notice_safely(format!("子代理「{title}」登记失败，本轮不再跟踪它：{cause}"));
                }
            }
        }
        let status = data["status"].as_str().unwrap_or("running").to_owned();
        // 相同状态仍可能补回 agentId/model；丢掉身份更新会让下一父回合无法恢复路由。
        let has_payload = ["result", "usage", "detail", "agentId", "resolvedModel", "agentType", "model", "title"].iter().any(|field| data.get(field).is_some_and(|value| !value.is_null()));
        {
            let route = self.agents.get_mut(&key).expect("agent route exists");
            let append = route.last_status != status || has_payload;
            route.last_status = status.clone();
            if !append { return Ok(()); }
        }
        let agent_id = data["agentId"].as_str().filter(|value| !value.is_empty()).map(str::to_owned);
        let model = data["resolvedModel"].as_str().or(data["model"].as_str()).filter(|value| !value.is_empty()).map(str::to_owned);
        let agent_type = data["agentType"].as_str().filter(|value| !value.is_empty()).map(str::to_owned);
        let title = data["title"].as_str().map(str::trim).filter(|title| !title.is_empty()).map(str::to_owned);
        let display = title.clone().unwrap_or_else(|| key.clone());
        let mut data = data;
        {
            let route = self.agents.get(&key).expect("agent route exists");
            // 父侧卡片与抽屉靠它跳进子会话；派生规则不暴露给前端。
            if let Some(object) = data.as_object_mut() {
                object.insert("sessionId".into(), json!(route.store.meta.session_id.clone()));
            }
        }
        let mut meta_error = None;
        {
            let route = self.agents.get_mut(&key).expect("agent route exists");
            let dir = route.store.dir.clone();
            let workspace = route.store.meta.workspace.clone();
            let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
            if !route.meta_broken {
                // 元数据基于磁盘上的最新 meta 做「重读-合并-落盘」：句柄里的快照可能
                // 已被按需回填改过（绑定了 native_id），整份回写会把它抹掉，下次打开
                // 就误判「未导入」而重复灌正文。meta 写失败不连累事件追加，本轮只报一次。
                if let Err(cause) = revise_agent_meta(&dir, &workspace, &key, |info| {
                    let mut changed = false;
                    for (field, slot) in [
                        (agent_id.as_deref(), &mut info.native_agent_id),
                        (model.as_deref(), &mut info.model),
                        (agent_type.as_deref(), &mut info.agent_type),
                    ] {
                        if let Some(value) = field {
                            if slot.as_deref() != Some(value) { *slot = Some(value.to_owned()); changed = true; }
                        }
                    }
                    // spawn 通知先流式后完整信封会来两次；标题只在空占位时补。
                    if let Some(title) = &title {
                        if info.title.trim().is_empty() || info.title == "子代理" {
                            info.title = title.clone();
                            changed = true;
                        }
                    }
                    if info.status != status {
                        info.status = status.clone();
                        // 复活续聊清掉上一轮的结束时间；只有终态才盖新的。
                        if matches!(status.as_str(), "starting" | "running") { info.ended_at = None; }
                        else if matches!(status.as_str(), "completed" | "failed" | "stopped") { info.ended_at = Some(now_ms()); }
                        changed = true;
                    }
                    changed
                }) {
                    route.meta_broken = true;
                    meta_error = Some(cause);
                }
            }
            let events = route.store.append(&self.run.id, vec![("agent".into(), data.clone())])?;
            let _ = self.app.emit(CHANNEL, &events);
        }
        if let Some(cause) = meta_error {
            self.queue("notice", json!({"text": format!("子代理「{display}」元数据维护失败，状态以时间线为准：{cause}")}))?;
        }
        // 锁已释放才排队：queue 达到阈值会触发 flush 重入 IO_LOCK，普通 Mutex 不可重入。
        self.queue("agent", data)
    }
    /// 降级通知：连父时间线都送不进去时只剩旁路错误通道，绝不再向上传播。
    fn notice_safely(&mut self, text: String) -> Result<(), String> {
        match self.queue("notice", json!({"text": text})) {
            Ok(()) => Ok(()),
            Err(cause) => {
                let _ = self.app.emit("ai-runtime://errors", json!({
                    "sessionId":self.run.session_id,"runId":self.run.id,"error":cause
                }));
                Ok(())
            }
        }
    }
    /// Codex 父连接不转发子线程正文，从已定位的 rollout 增量补采并广播。
    fn poll_codex_agents(&mut self, discover: bool, drain: bool) {
        if self.store.meta.provider != Provider::Codex || self.agents.is_empty() { return; }
        let Some(base) = self.store.dir.parent().map(Path::to_path_buf) else { return; };
        let mut warnings = vec![];
        for route in self.agents.values_mut() {
            let result = (|| {
                let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
                history::sync_codex_subagent(&base, &route.store.meta.session_id, &self.run.workspace, discover, drain)
            })();
            match result {
                Ok(events) => { if !events.is_empty() { let _ = self.app.emit(CHANNEL, &events); } }
                Err(cause) if !route.history_warned => {
                    route.history_warned = true;
                    warnings.push(format!("子代理「{}」历史同步失败，将继续重试：{cause}", route.store.meta.title));
                }
                Err(_) => {}
            }
        }
        // queue 可能重入 IO_LOCK，必须等各子会话的读取锁释放后再提示。
        for warning in warnings { let _ = self.notice_safely(warning); }
    }
    /// 把子代理的对话事件攒进批缓冲，随 flush 统一落盘与广播。
    /// 句柄未建（生命周期事件还没到）或已登记失败就丢弃：
    /// 协议保证 spawn 通知先于任何子代理输出。
    fn route_agent(&mut self, key: &str, kind: &str, data: Value) -> Result<(), String> {
        if !self.agents.contains_key(key) { return Ok(()); }
        self.agent_batches
            .entry(key.to_owned())
            .or_default()
            .push((kind.to_owned(), data));
        // 攒批只受条数硬顶；字节与时间维度由 flush 的 32ms 节奏兜底。
        if self.agent_batches.get(key).is_some_and(|batch| batch.len() >= 128) {
            self.flush_agent(key)?;
        }
        Ok(())
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
        include_user: bool,
    ) -> Result<&'static str, String> {
        if self.run.cancelled.load(Ordering::Acquire) {
            return Ok(task_status::CANCELLED);
        }
        self.plan_claim = request.plan_turn.take();
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
        // 模式一律用 CLI 的原话 id 下发（入队时已按这版 CLI 报过的取值校验过）；
        // 没带 mode 的请求按旧的权限档映射，行为与升级前一致。
        let claude_mode = request.mode.clone().unwrap_or_else(|| request.permission.claude().to_owned());
        // 附加目录在 Codex 侧的落点是 turn/start 的 sandboxPolicy（入队时已按生效沙箱算好）。
        // 沙箱收不下这些目录时必须当场说出来：用户点过的授权不能既不生效又不吭声。
        let codex_policy = match request.provider {
            Provider::Codex => match request.codex_grant.as_ref() {
                Some(options::SandboxGrant::Policy(policy)) => Some(policy.clone()),
                Some(options::SandboxGrant::Unapplied(reason)) => {
                    self.queue("notice", json!({"text": reason}))?;
                    self.flush()?;
                    None
                }
                Some(options::SandboxGrant::AlreadyOpen) | None => None,
            },
            Provider::Claude => None,
        };
        let native = self.store.meta.native_id.clone();
        // 专用命令没有 turn/start 的参数契约；不能吞掉设置后假装已经应用。
        if matches!(request.command, Some(commands::CommandIntent::CodexCompact | commands::CommandIntent::CodexReview)) {
            if request.command == Some(commands::CommandIntent::CodexReview) && !request.additional_dirs.is_empty() {
                return Err("Codex /review 不支持本轮额外目录授权；请用普通消息发起审查以应用这些目录".into());
            }
            self.queue("notice", json!({"text":"Codex 此命令使用线程模型与审批设置，不支持本轮思考强度、Fast 开关和额外目录授权；这些本轮设置未应用。"}))?;
            self.flush()?;
        }
        if request.command == Some(commands::CommandIntent::CodexCompact) && native.is_none() {
            return Err("请先建立会话，再压缩上下文".into());
        }
        let (mut process, version) = spawn_runtime_process(&request, &claude_mode, native.as_deref())?;
        {
            let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
            self.store.meta.cli_version = version;
            self.store.save()?;
        }
        if self.run.cancelled.load(Ordering::Acquire) {
            return Ok(task_status::CANCELLED);
        }
        let mut claude_agents = vec![];
        if request.provider == Provider::Claude {
            let base = self.store.dir.parent().ok_or("会话路径无效")?;
            let restored = {
                let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
                load_claude_agent_routes(base, &self.run.session_id, &self.run.workspace)
            };
            match restored {
                Ok((routes, warnings)) => {
                    self.agents = routes;
                    for warning in warnings { self.notice_safely(warning)?; }
                }
                Err(cause) => { self.notice_safely(format!("子代理路由恢复失败：{cause}"))?; }
            }
            // 旧父进程已退出，遗留活动态先同时写入父子时间线；本轮 SendMessage 才能重启。
            let interrupted: Vec<_> = self.agents.iter().filter(|(_, route)| matches!(route.last_status.as_str(), "" | "starting" | "running")).map(|(key, _)| key.clone()).collect();
            for key in interrupted { self.agent_event(json!({"key":key,"status":"stopped"}))?; }
            let snapshots: Vec<_> = self.agents.iter().filter_map(|(key, route)| {
                let info = route.store.meta.agent.as_ref()?;
                claude_agents.push((key.clone(), info.native_agent_id.clone()));
                Some(json!({"key":key,"sessionId":route.store.meta.session_id,"title":info.title,"agentType":info.agent_type,"agentId":info.native_agent_id,"status":route.last_status}))
            }).collect();
            for snapshot in snapshots { self.queue("agent", snapshot)?; }
        }
        let mut protocol = runtime_protocol(&request, native, &service_tier, &codex_policy, &claude_mode, None, claude_agents)?;
        self.summary_start = history::summary_offset(&self.store)?;
        self.run.child_pid.store(process.id(), Ordering::Release);
        let handshake = protocol.start()?;
        if let Err(error) = self.actions(&mut *protocol, handshake, &mut process) {
            self.fail_plan_claim(&error);
            return Err(error);
        }
        let started = Instant::now();
        let mut stopping = None;
        let mut last_output = Instant::now();
        let mut summary_poll = Instant::now();
        let mut agent_poll = Instant::now();
        let mut agent_discovery = Instant::now() - Duration::from_secs(2);
        let mut summary_offset = self.summary_start;
        let mut connected = false;
        let mut reconnects = 0u8;
        loop {
            if agent_poll.elapsed() >= Duration::from_millis(250) {
                let discover = agent_discovery.elapsed() >= Duration::from_secs(2);
                self.poll_codex_agents(discover, false);
                agent_poll = Instant::now();
                if discover { agent_discovery = Instant::now(); }
            }
            // CLI 常常只把摘要写进原生历史；运行期间补采并广播，不等回合结束。
            if self.compaction_index > 0 && summary_poll.elapsed() >= Duration::from_secs(2) {
                self.flush()?;
                let events = {
                    let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
                    history::poll_summaries(&mut self.store, &mut summary_offset)?
                };
                if !events.is_empty() { let _ = self.app.emit(CHANNEL, &events); }
                summary_poll = Instant::now();
            }
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
                match control {
                    Control::Answer { request_id, answer, reply } => {
                        let result = (|| {
                            if stopping.is_some() || self.run.cancelled.load(Ordering::Acquire) {
                                return Err("任务正在停止，请求已失效".into());
                            }
                            let (key, kind) = self.pending.get(&request_id).cloned().ok_or("授权或提问已失效")?;
                            let grant = validate_answer(&kind, &answer)?;
                            let actions = protocol.respond(&key, answer.clone())?;
                            self.actions(&mut *protocol, actions, &mut process)?;
                            self.pending.remove(&request_id);
                            // 答案随失效事件落盘，重开会话时不会重新出现一张可答复卡片。
                            self.queue("invalidated", json!({"requestId":request_id, "answer":answer}))?;
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
                    Control::GoalStatus { status, reply } => {
                        let result = protocol.set_goal_status(&status)
                            .and_then(|actions| self.actions(&mut *protocol, actions, &mut process).map(|_| ()))
                            .and_then(|_| self.flush());
                        let _ = reply.send(result);
                    }
                    Control::AgentStop { task_id, reply } => {
                        // 停止单个后台子代理（Claude stop_task）。回包是普通
                        // control_response，request_id 不在已知集合里会被静默忽略。
                        let result = (|| {
                            if stopping.is_some() || self.run.cancelled.load(Ordering::Acquire) {
                                return Err("任务正在停止，子代理已一并停止".into());
                            }
                            self.actions(&mut *protocol, vec![Action::Write(
                                json!({"type":"control_request","request_id":format!("forge-stop-{task_id}"),"request":{"subtype":"stop_task","task_id":task_id}}),
                            )], &mut process).map(|_| ())
                        })();
                        let _ = reply.send(result);
                    }
                }
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
                    if !connected && protocol.turn_started() {
                        // 初始化成功不等于提示词已送达。必须等 CLI 确认真正建立原生回合，
                        // 再写 user + running；否则握手中断会留下根本没发送过的假消息。
                        self.begin_turn(&request, include_user)?;
                        connected = true;
                    }
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
                    // EOF 已经说明这条管道永久失效；不能再等子进程退出。CLI 可能仍挂着，
                    // 继续轮询同一个 Receiver 只会空转，正是“进程还在但 Forge 已失联”的状态。
                    let exit = process.status()?;
                    let diagnostics = process.diagnostics();
                    let failure = match exit {
                        Some(exit) if exit.success() => format!("CLI 未返回完整结果便退出：{diagnostics}"),
                        Some(exit) => format!("CLI 异常退出（{exit}）：{diagnostics}"),
                        None => format!("CLI 输出管道已断开：{diagnostics}"),
                    };
                    // 旧进程及其树必须先彻底回收，Codex writer lock/Claude PID 登记释放后，
                    // 外部占用探针才有意义。
                    process.terminate();
                    self.run.child_pid.store(0, Ordering::Release);
                    let ordinary = request.provider == Provider::Codex
                        && request.command.is_none() && request.plan_turn.is_none()
                        && self.native_turn_id.is_some();
                    let probe = if connected && reconnects < 1 && self.pending.is_empty() && ordinary {
                        let runtime_base = base(&self.app)?;
                        activity::externally_occupied(&runtime_base, &request.session_id, &self.run.workspace)
                    } else {
                        Ok(false)
                    };
                    let reconnect = should_reconnect_after_disconnect(
                        connected, reconnects, !self.pending.is_empty(), ordinary, probe,
                    ).map_err(|error| format!("{failure}；{error}"))?;
                    if !reconnect { return Err(failure); }

                    reconnects += 1;
                    self.queue("notice", json!({"text":"CLI 连接中断，正在重新附着当前回合。","reconnecting":true,"attempt":reconnects}))?;
                    self.flush()?;
                    let native = self.store.meta.native_id.clone().ok_or("CLI 断线后缺少可恢复的原生会话 ID")?;
                    let (next, version) = spawn_runtime_process(&request, &claude_mode, Some(&native))?;
                    process = next;
                    self.run.child_pid.store(process.id(), Ordering::Release);
                    {
                        let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
                        self.store.meta.cli_version = version;
                        self.store.save()?;
                    }
                    let turn = self.native_turn_id.clone().ok_or("CLI 断线后缺少原生回合 ID")?;
                    protocol = runtime_protocol(&request, Some(native), &service_tier, &codex_policy, &claude_mode, Some(turn), vec![])?;
                    let handshake = protocol.start()?;
                    self.actions(&mut *protocol, handshake, &mut process)?;
                    last_output = Instant::now();
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }
    fn begin_turn(&mut self, request: &SendRequest, include_user: bool) -> Result<(), String> {
        let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
        let mut events = vec![];
        // 计划决策不是用户正文：时间线上只记一条「已批准/已要求修改」。
        let include_user = include_user && request.plan_turn.is_none();
        if let Some(turn) = &request.plan_turn {
            events.push(("plan_decision".into(), json!({"planId":turn.plan_id,"revision":turn.revision,"decision":turn.decision})));
        }
        if include_user { events.push(("user".into(), json!({"text":request.prompt,"images":request.images}))); }
        events.push(("status".into(), json!({"status":task_status::RUNNING})));
        let events = self.store.append(&self.run.id, events)?;
        if include_user { images::mark_referenced(&self.app, &request.images); }
        let _ = self.app.emit(CHANNEL, &events);
        Ok(())
    }
    fn finish(&mut self, status: &str, error: Option<String>) {
        // 生命周期通知可能早于最后的正文落盘；摘除路由前读完当前完整尾部。
        self.poll_codex_agents(true, true);
        // 进程结束后所有待答复请求都已失效；卡片不能继续停在「可批准」。
        for id in self.pending.keys().cloned().collect::<Vec<_>>() {
            let _ = self.queue("invalidated", json!({"requestId":id}));
        }
        self.pending.clear();
        self.finish_plan_execution(status);
        // 先把子代理攒批落盘再结算终态：路由马上要从 agents 里摘除，之后再 flush 会丢批。
        if let Err(cause) = self.flush_agents() {
            let _ = self.app.emit("ai-runtime://errors", json!({
                "sessionId":self.run.session_id,"runId":self.run.id,"error":cause
            }));
        }
        // Claude 先落齐 stdout 的实时批次，再补原生缺口；反过来会让同一消息分属两个回合。
        if self.store.meta.provider == Provider::Claude {
            if let Some(base) = self.store.dir.parent().map(Path::to_path_buf) {
                let children: Vec<_> = self.agents.values().map(|route| route.store.meta.session_id.clone()).collect();
                for child in children {
                    let result = (|| {
                        let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
                        history::sync_claude_agent(&base, &child, &self.run.workspace)
                    })();
                    match result {
                        Ok(events) => { if !events.is_empty() { let _ = self.app.emit(CHANNEL, &events); } }
                        Err(cause) => { let _ = self.notice_safely(format!("子代理历史补齐失败：{cause}")); }
                    }
                }
            }
        }
        // CLI 进程退出后它的子代理不可能还活着：仍标 running 的子会话落一个
        // 诚实的终态，否则子代理列表永远显示「运行中」。已完成的子代理不动。
        for (key, mut route) in std::mem::take(&mut self.agents) {
            if route.store.meta.agent.is_none() { continue; }
            // 终态写盘同样走重读-合并：按需回填可能已把该子代理标成终态并绑定，
            // 陈旧回写会把它打回 running 或丢掉绑定。
            let was_running = match stop_active_agent(&route.store.dir, &route.store.meta.workspace, &key) {
                Ok(was_running) => was_running,
                Err(cause) => {
                    let _ = self.app.emit("ai-runtime://errors", json!({"sessionId":route.store.meta.session_id,"runId":self.run.id,"error":cause}));
                    false
                }
            };
            if !was_running { continue; }
            let settled = (|| {
                let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
                let events = route.store.append(&self.run.id, vec![("agent".into(), json!({"key":key,"status":"stopped","sessionId":route.store.meta.session_id}))])?;
                let _ = self.app.emit(CHANNEL, &events);
                Ok::<(), String>(())
            })();
            if let Err(cause) = settled {
                let _ = self.app.emit("ai-runtime://errors", json!({"sessionId":route.store.meta.session_id,"runId":self.run.id,"error":cause}));
            }
        }
        let history_result = self.flush().and_then(|_| {
            let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
            let base = self.store.dir.parent().ok_or("会话路径无效")?.to_path_buf();
            history::mark_current(&mut self.store, &base)
        });
        let data = match history_result {
            Err(cause) => json!({"status":task_status::FAILED,"error":cause}),
            Ok(events) => {
                // 补采已落盘，但不广播就只能重开会话后才看见摘要。
                if !events.is_empty() { let _ = self.app.emit(CHANNEL, &events); }
                json!({"status":status,"error":error})
            }
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
    /// 回合结束后补推标题。命名是锦上添花：CLI 不可用、线程仍不存在，都留给下一次
    /// 回合再试，绝不为此打扰用户。
    fn sync_native_title(&mut self) {
        let Ok(_io) = store::IO_LOCK.lock() else { return };
        let _ = push_codex_title(&mut self.store);
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
                // 找不到不是幂等成功：最常见的是历史快照指向另一个 Forge 窗口的运行。
                // 若这里回 Ok，前端会误以为当前进程已经把那个 CLI 中断。
                return Err("任务已结束或不属于当前窗口，未发送中断".into());
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

/// 子代理消息的转发序号：同一毫秒内的两次转发也要有互不相同的 run id。
static FORWARD_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 在子代理会话窗口里发送消息。两个 CLI 都没有客户端直发子代理的通道
/// （Claude 的 send_task_message 在本地引擎抛 Unsupported，Codex 明确禁止对子线程
/// turn/start），唯一通路是把消息包装成指令注入父会话，由父模型调 SendMessage /
/// followup_task 转达。父会话时间线会留下这条转发，用户能看到完整链路。
#[tauri::command]
pub async fn ai_runtime_agent_forward(app: AppHandle, session_id: String, workspace: String, prompt: String) -> Result<Value, String> {
    block(move || {
        enabled(&app)?;
        let prompt = prompt.trim().to_owned();
        if prompt.is_empty() || prompt.len() > 64 * 1024 {
            return Err("消息不能为空，且不能超过 64 KiB".into());
        }
        if !store::valid_id(&session_id) {
            return Err("无效会话 ID".into());
        }
        let root = store::workspace(&workspace)?;
        let _lifecycle = registry::LIFECYCLE.lock().map_err(|e| e.to_string())?;
        let _cli_gate = ai_cli::runtime_gate(&app).map_err(|_| "CLI 管理进行中，请稍后发送")?;
        if ai_cli::management_busy() { return Err("CLI 管理进行中，请稍后发送".into()); }
        let base = base(&app)?;
        let dir = base.join(&session_id);
        let meta = store::Store::metadata(&dir, &root)?;
        let agent = meta.agent.clone().ok_or("这条会话不是子代理会话")?;
        let parent_id = meta.parent_session_id.clone().ok_or("子代理会话缺少父会话")?;
        let parent_dir = base.join(&parent_id);
        let parent = store::Store::metadata(&parent_dir, &meta.workspace)?;
        let address = agent.native_agent_id.clone()
            .ok_or("该子代理还没有可寻址的标识，等它启动完成后再发送")?;
        let instruction = match parent.provider {
            Provider::Claude => format!(
                "[子代理消息转发] 用户在子代理「{title}」的会话窗口里输入了一条消息。请用 SendMessage 工具（to 参数填 \"{address}\"）把下面的消息原样转发给它，等待它的回复后把结果汇报给用户；不要自己代替它回答。\n\n用户消息：\n{prompt}",
                title = agent.title, address = address, prompt = prompt,
            ),
            Provider::Codex => format!(
                "[子代理消息转发] 用户在子代理「{title}」的会话窗口里输入了一条消息。请调用 functions.collaboration.followup_task（target 参数填 \"{address}\"）把下面的消息发给它，等待它的 FINAL_ANSWER 后把结果汇报给用户；不要自己代替它回答。\n\n用户消息：\n{prompt}",
                title = agent.title, address = address, prompt = prompt,
            ),
        };
        // 用户输入先落进子会话（标记 relay），界面立刻能看到自己发了什么；
        // 子代理的回复仍由父会话运行时按 agentKey 路由回来。
        {
            let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
            let mut child = store::Store::open_for_append(&base, &session_id, &meta.workspace, meta.provider, &meta.title, "")?;
            let events = child.append("relay", vec![("user".into(), json!({"text": prompt, "relay": true}))])?;
            let _ = app.emit(CHANNEL, &events);
        }
        let request = SendRequest {
            session_id: parent_id,
            run_id: format!("fwd-{}-{}", now_ms(), FORWARD_SEQ.fetch_add(1, Ordering::Relaxed)),
            provider: parent.provider,
            workspace: parent.workspace,
            prompt: instruction,
            images: vec![],
            trusted: true,
            model: None,
            effort: None,
            // 转发回合不覆盖任何档位：Claude 沿用 manual 审批流，Codex 让线程保持自己的设置。
            permission: options::PermissionMode::Inherit,
            fast: None,
            service_tier: None,
            codex_grant: None,
            command: None,
            plan_mode: false,
            mode: None,
            plan: None,
            additional_dirs: vec![],
            plan_turn: None,
        };
        dispatch_task(&app, &request, &request.workspace, &base)
    })
    .await
}

/// 停止单个后台子代理。只有 Claude 提供了 stop_task 控制请求；Codex 的
/// interrupt_agent 是模型侧工具，客户端没有通道，只能停整个父回合。
#[tauri::command]
pub async fn ai_runtime_agent_stop(app: AppHandle, session_id: String, workspace: String) -> Result<(), String> {
    block(move || {
        enabled(&app)?;
        if !store::valid_id(&session_id) {
            return Err("无效会话 ID".into());
        }
        let root = store::workspace(&workspace)?;
        let base = base(&app)?;
        let meta = store::Store::metadata(&base.join(&session_id), &root)?;
        if meta.provider != Provider::Claude {
            return Err("Codex 子代理暂不支持单独停止；请停止当前对话回合".into());
        }
        let agent = meta.agent.ok_or("这条会话不是子代理会话")?;
        let address = agent.native_agent_id.ok_or("该子代理还没有可停止的标识")?;
        let parent_id = meta.parent_session_id.clone().ok_or("子代理会话缺少父会话")?;
        let run = registry::for_session(&parent_id).ok_or("父会话当前没有运行，子代理已随之结束")?;
        let (reply, receive) = mpsc::sync_channel(1);
        run.controls
            .try_send(Control::AgentStop { task_id: address, reply })
            .map_err(|_| "运行繁忙或已经结束".to_string())?;
        receive
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "停止请求未确认；请勿重复操作".to_string())?
    })
    .await
}

/// 暂停或继续 Codex 原生 Goal。活动回合复用现有 app-server；空闲会话走短连接并落盘权威快照。
#[tauri::command]
pub async fn ai_runtime_set_goal_status(
    app: AppHandle,
    session_id: String,
    workspace: String,
    status: String,
) -> Result<(), String> {
    block(move || {
        enabled(&app)?;
        if !store::valid_id(&session_id) || !matches!(status.as_str(), "active" | "paused") {
            return Err("无效的 Goal 状态请求".into());
        }
        let root = store::workspace(&workspace)?;
        let runtime_base = base(&app)?;
        let native = {
            let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
            let target = store::Store::open_for_append(&runtime_base, &session_id, &root, Provider::Codex, "", "")?;
            if target.meta.provider != Provider::Codex {
                return Err("Goal 目前仅支持 Codex 会话".into());
            }
            target.meta.native_id.ok_or("Codex 会话尚未建立，无法修改 Goal")?
        };
        let send_active = |run: Arc<Run>| -> Result<(), String> {
            let (reply, receive) = mpsc::sync_channel(1);
            run.controls.try_send(Control::GoalStatus { status: status.clone(), reply })
                .map_err(|_| "运行繁忙或已经结束")?;
            receive.recv_timeout(Duration::from_secs(10))
                .map_err(|_| "Goal 状态请求未送达；请重试".to_string())?
        };
        if let Some(run) = registry::for_session(&session_id) {
            return send_active(run);
        }

        // 与发送共用生命周期锁，避免刚判为空闲就同时启动一个新回合和第二个管理连接。
        let _lifecycle = registry::LIFECYCLE.lock().map_err(|e| e.to_string())?;
        if let Some(run) = registry::for_session(&session_id) {
            return send_active(run);
        }
        let _cli_gate = ai_cli::runtime_gate(&app).map_err(|_| "CLI 管理进行中，请稍后修改 Goal")?;
        let goal = options::codex_set_goal_status(&root, &native, &status)?;
        let events = {
            let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
            let mut target = store::Store::open_for_append(&runtime_base, &session_id, &root, Provider::Codex, "", "")?;
            target.append("goal-control", vec![("goal".into(), json!({"goal":goal}))])?
        };
        let _ = app.emit(CHANNEL, &events);
        Ok(())
    }).await
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
        // 子代理会话由独立 rollout 或父事件写入；若尚未完成原生正文导入，打开时按需触发快速回填。
        let dir = base.join(&session_id);
        let meta = store::Store::metadata(&dir, &root).ok();
        let agent_session = meta.as_ref().map(|m| m.agent.is_some()).unwrap_or(false);
        if agent_session {
            let events_len = dir.join("events.jsonl").metadata().map(|m| m.len()).unwrap_or(0);
            // Claude 子会话也可能只有部分实时正文；每次空闲打开都按增量游标补齐。
            let needs_import = events_len <= 256 || meta.as_ref().map(|m| m.native_id.is_none()).unwrap_or(false)
                || meta.as_ref().is_some_and(|m| m.provider == Provider::Claude) || dir.join("native-source.json").exists();
            // 运行中由 Worker 消费并广播；打开视图不抢增量游标。空闲时继续补齐尾部。
            let parent_busy = meta.as_ref()
                .and_then(|m| m.parent_session_id.clone())
                .is_some_and(|parent| registry::for_session(&parent).is_some());
            if needs_import && !parent_busy && !has_queued(&session_id) {
                if let Ok(_lease) = store::Lease::acquire(&base.join(format!("{session_id}.lock"))) {
                    if let Err(cause) = history::sync_subagent(&base, &session_id, &root) { warning = Some(cause); }
                }
            }
        } else if registry::for_session(&session_id).is_none() {
            let needs_sync = dir.join("native-source.json").exists();
            let needs_plans = dir.join("plans.json").exists();
            // 只有当会话存在原生历史映射文件或计划残留时，才需要获取租约进行同步与恢复；
            // 纯净新建的会话既无原生历史也无计划残留，跳过无谓的持锁，彻底消除与并发发送任务之间的锁争用。
            if (needs_sync || needs_plans) && !has_queued(&session_id) {
                if let Ok(_lease) = store::Lease::acquire(&base.join(format!("{session_id}.lock"))) {
                    if needs_plans {
                        // 没有本进程回合、也没有排队决策时，plans.json 里的 submitting 就是上次
                        // 进程没来得及确认的残留；退回待审，别让计划卡永远消失。
                        let _ = plans::recover(&dir);
                    }
                    if needs_sync {
                        match history::sync(&base, &session_id, &root) {
                            Ok(more) => native_more = more,
                            Err(error) => warning = Some(error),
                        }
                        // 空闲会话重开时，补回曾被旧版本游标跳过的压缩摘要记录。
                        match history::repair_summaries(&base, &session_id, &root) {
                            Ok(more) => native_more |= more,
                            Err(error) => warning = Some(error),
                        }
                    }
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
/// 一条会话的删除组：它自己、各级子代理，以及旧版本按 `native-<provider>-<原生 ID>` 建的
/// 同一原生会话镜像壳。
///
/// 子代理会嵌套——Codex 的 delegate 能让子代理再开子代理，所以这里按 parent 链接滚到
/// 不动点；只扫一层会把孙代理留在磁盘上，父会话删完后它既进不了侧栏的父子结构，
/// 也再没有别的入口能带走。
///
/// 镜像壳必须一起走：列表只在「真 ID 的目录还在」时收起它，真删把原生文件和真 ID 目录
/// 一起带走后，它会带着当年的旧标题重新浮出来，变成一条再也打不开的幽灵行。
fn session_group(base: &Path, root: &str, session_id: &str) -> Result<Vec<String>, String> {
    let mut group = vec![session_id.to_owned()];
    let mut natives: Vec<String> = store::Store::metadata(&base.join(session_id), root)
        .ok()
        .and_then(|meta| meta.native_id)
        .into_iter()
        .collect();
    let mut links: Vec<(String, Option<String>, Option<String>)> = Vec::new();
    for entry in std::fs::read_dir(base).map_err(|e| e.to_string())?.take(20000).flatten() {
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() { continue; }
        let id = entry.file_name().to_string_lossy().into_owned();
        if !store::valid_id(&id) || id == session_id { continue; }
        if let Ok(meta) = store::Store::metadata(&entry.path(), root) {
            links.push((id, meta.parent_session_id, meta.native_id));
        }
    }
    // 每一轮把新收进来的成员的子代理与同原生 id 的镜像壳再扫一遍，直到没有新增。
    loop {
        let before = group.len();
        for (id, parent, native) in &links {
            if group.iter().any(|member| member == id) { continue; }
            let follows = parent.as_deref().is_some_and(|p| group.iter().any(|member| member == p))
                || native.as_deref().is_some_and(|n| natives.iter().any(|known| known == n));
            if follows {
                if let Some(native) = native {
                    if !natives.iter().any(|known| known == native) { natives.push(native.clone()); }
                }
                group.push(id.clone());
            }
        }
        if group.len() == before { return Ok(group); }
    }
}
/// 本项目里已归档的顶层会话；子代理随父一起走，不单独列出来。
fn archived_session_ids(base: &Path, root: &str) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    for entry in std::fs::read_dir(base).map_err(|e| e.to_string())?.take(20000).flatten() {
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() { continue; }
        let id = entry.file_name().to_string_lossy().into_owned();
        if !store::valid_id(&id) { continue; }
        if let Ok(meta) = store::Store::metadata(&entry.path(), root) {
            if meta.archived && meta.parent_session_id.is_none() { ids.push(id); }
        }
    }
    Ok(ids)
}
/// 停掉这一组会话的运行与排队。子代理必须各自停：只停父会话会让子进程在镜像删除后
/// 继续往原生历史里写，Codex 那边还可能把刚删掉的线程再落一次盘。
fn stop_group(app: &AppHandle, workspace: &str, root: &str, group: &[String]) -> Result<(), String> {
    let _guard = registry::LIFECYCLE.lock().map_err(|e| e.to_string())?;
    for id in group {
        let id = id.as_str();
        cancel_queued(app, |request| request.session_id == id && request.workspace == workspace)?;
        if let Some(run) = registry::for_session(id) {
            if run.workspace != root {
                return Err("项目归属不匹配".into());
            }
            run.stop()?;
        }
    }
    Ok(())
}
/// 删除时对 CLI 原生记录的态度。
#[derive(Clone, Copy, PartialEq, Eq)]
enum Purge {
    /// 只删 Forge 镜像：原生留在 CLI 里，靠屏蔽标记不再导回来。
    Off,
    /// 由这一次删除去删原生：任一条失败就整笔中止，Forge 镜像一行不动。
    Now,
    /// 调用方已经替这一组删过原生（批量删除的前置 pass）：这里不再删，也不必留屏蔽标记。
    Done,
}
/// 删一个会话目录及其旁路产物：附件回收、墓碑，以及原生 id 的屏蔽或撤除。
/// 调用方需已停好这一组的运行。锁文件留在原地不删——那是删除后挡住迟到写入的一部分，
/// 见 `store::events_lock_path`；它们随墓碑一起过期，见 `store::write_tombstones`。
fn remove_session_dir(app: &AppHandle, base: &Path, root: &str, session_id: &str, native_gone: bool) -> Result<(), String> {
    let _lease = store::Lease::acquire(&base.join(format!("{session_id}.lock")))?;
    let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
    // 与无租约的排队状态追加共用跨进程锁；删除赢得锁后，旧窗口只能得到“会话不存在”。
    let _events = crate::sys::ExclusiveFileLock::acquire(&store::events_lock_path(base, session_id))?;
    // 只校验归属，不在即将删除的日志里补写“中断”事件，也避免重入同一事件锁。
    store::Store::page(base, session_id, root, store::Window::After(0), 1, true)?;
    let dir = base.join(session_id);
    if dir.exists() {
        // 目录一删，事件日志里引用的附件就再没人认得了：先把它们收走，别留在沙箱里当孤儿。
        images::release_session(app, &dir);
        // 原生还在就靠屏蔽标记挡住「再发现」；原生已经删掉，标记反而该撤——
        // 它没有过期机制，留着就是只增不减。
        if native_gone {
            history::unhide(base, session_id, root);
        } else {
            history::hide(base, session_id, root)?;
        }
        std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
        // 删除落一条墓碑：迟到的创建请求（排队投递、旧标签 create、子代理注册）
        // 会在 load() 的 create 路径把目录凭空重建出来，变成打不开的幽灵会话。
        store::record_tombstone(base, session_id)?;
    }
    Ok(())
}
/// 删除一条会话，连它的子代理一起。`Purge::Now` 会先删 CLI 原生记录，
/// 任一条失败就整笔中止、Forge 镜像一行不动。
///
/// 顺序不能反：先删镜像再删原生，一旦原生失败就留下「镜像没了、原生还在但被
/// `hidden-native` 永久屏蔽」——用户以为删干净了，实际既没删到 CLI，也再也导不回来。
fn delete_session(app: &AppHandle, base: &Path, workspace: &str, root: &str, session_id: &str, purge: Purge) -> Result<(), String> {
    let group = session_group(base, root, session_id)?;
    stop_group(app, workspace, root, &group)?;
    if purge == Purge::Now {
        let outcomes = history::purge_natives(base, root, &group)?;
        if let Some(error) = outcomes.into_iter().find_map(Result::err) {
            return Err(error);
        }
    }
    let native_gone = purge != Purge::Off;
    remove_session_dir(app, base, root, session_id, native_gone)?;
    // 子代理尽力而为：拿不到租约或归属对不上时，父会话已经删掉，孤儿既进不了侧栏
    // （isChild 过滤）也失去了随父消失的 dock 入口，留在磁盘上只会被发现流程反复扫描。
    for child in group.iter().skip(1) {
        let _ = remove_session_dir(app, base, root, child, native_gone);
    }
    Ok(())
}
#[tauri::command]
pub async fn ai_runtime_delete(
    app: AppHandle,
    session_id: String,
    workspace: String,
    purge_native: Option<bool>,
) -> Result<(), String> {
    block(move || {
        if !store::valid_id(&session_id) {
            return Err("无效会话 ID".into());
        }
        let root = store::workspace(&workspace)?;
        let base = base(&app)?;
        delete_session(&app, &base, &workspace, &root, &session_id, if purge_native.unwrap_or(false) { Purge::Now } else { Purge::Off })
    })
    .await
}
/// 设置页「归档会话」用：一次性删掉本项目里所有已归档会话（含各自的子代理）。
///
/// 逐条复用 `delete_session` 的完整序列，不另写快路径。原生删除合并成一次：
/// N 个 Codex 线程走同一根 app-server 连接，而不是每条会话各起一个进程。
/// 单条失败只把那条留在列表里如实上报，不把整批的成功与否混成一锅。
#[tauri::command]
pub async fn ai_runtime_delete_archived(
    app: AppHandle,
    workspace: String,
    purge_native: Option<bool>,
) -> Result<Value, String> {
    block(move || {
        enabled(&app)?;
        let root = store::workspace(&workspace)?;
        let base = base(&app)?;
        let mut groups = Vec::new();
        for id in archived_session_ids(&base, &root)? {
            groups.push(session_group(&base, &root, &id)?);
        }
        // 先把所有运行停掉再动原生记录：还挂着的线程删不掉，也可能删完又被写回来。
        for group in &groups {
            stop_group(&app, &workspace, &root, group)?;
        }
        let flat: Vec<String> = groups.iter().flatten().cloned().collect();
        let mut failures: HashMap<String, String> = HashMap::new();
        let purge = purge_native.unwrap_or(false);
        if purge {
            let outcomes = history::purge_natives(&base, &root, &flat)?;
            for (id, outcome) in flat.into_iter().zip(outcomes) {
                if let Err(error) = outcome {
                    failures.insert(id, error);
                }
            }
        }
        let mut deleted = Vec::new();
        let mut failed = Vec::new();
        for group in groups {
            let Some(head) = group.first().cloned() else { continue };
            let title = store::Store::metadata(&base.join(&head), &root).map(|meta| meta.title).unwrap_or_default();
            // 组里任何一条原生没删干净就整组保留：只剩一半的父子会话比原样留着更难看。
            if let Some(error) = group.iter().find_map(|id| failures.get(id.as_str()).cloned()) {
                failed.push(json!({ "id": head, "title": title, "error": error }));
                continue;
            }
            // 原生已经在前置那一趟删掉了，这里只收尾镜像；再留屏蔽标记就是纯累赘。
            match delete_session(&app, &base, &workspace, &root, &head, if purge { Purge::Done } else { Purge::Off }) {
                Ok(()) => deleted.push(head),
                Err(error) => failed.push(json!({ "id": head, "title": title, "error": error })),
            }
        }
        Ok(json!({ "deleted": deleted, "failed": failed }))
    })
    .await
}
/// 批准写入类工具前，把目标文件的当前内容存成快照（事件同步进时间线）。
#[tauri::command]
pub async fn ai_session_checkpoint_save(
    app: AppHandle,
    session_id: String,
    workspace: String,
    paths: Vec<String>,
) -> Result<Value, String> {
    block(move || {
        enabled(&app)?;
        if !store::valid_id(&session_id) { return Err("无效会话 ID".into()); }
        let root = store::workspace(&workspace)?;
        let base = base(&app)?;
        // 锁归 checkpoint::record 内部的 append_event：IO_LOCK 绝不嵌套（见 flush 的注释），
        // 外层再拿一把会和 append_event 的二次加锁互相等待，把批准动作整个挂死。
        checkpoint::record(Some(&app), &base, &session_id, &root, &paths, "approval", None)
    })
    .await
}

/// 把一份快照写回磁盘；恢复前先把现状存成新快照，链式可退。
#[tauri::command]
pub async fn ai_session_checkpoint_restore(
    app: AppHandle,
    session_id: String,
    workspace: String,
    checkpoint_id: String,
) -> Result<Value, String> {
    block(move || {
        enabled(&app)?;
        if !store::valid_id(&session_id) { return Err("无效会话 ID".into()); }
        let root = store::workspace(&workspace)?;
        let base = base(&app)?;
        // 同 save：锁在 append_event 内部拿一次，外层持锁会死锁。
        checkpoint::restore(Some(&app), &base, &session_id, &root, &checkpoint_id)
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
        for entry in std::fs::read_dir(&base).map_err(|e|e.to_string())?.take(20000) {
            let entry=entry.map_err(|e|e.to_string())?;
            if !entry.file_type().map_err(|e|e.to_string())?.is_dir() { continue; }
            let id=entry.file_name().to_string_lossy().into_owned();
            if !store::valid_id(&id) { continue; }
            if let Ok(mut meta)=store::Store::metadata(&entry.path(),&root) {
                // Codex 会话在 CLI 侧的身份是原生线程 ID；目录名只是 Forge 主键，
                // 自建会话的目录名和它天生不同（线程要等首条消息才建出来）。
                let native = meta.native_id.clone().unwrap_or_default();
                // 旧版把 ID 包过一层，那条会话已按真实 ID 重建过镜像：只有真实 ID 的目录
                // 也在时才收起这个旧壳，否则同一次会话会在列表里出现两条。
                // 子会话的 native_id 存的是子代理标识，不适用这条过滤规则。
                if meta.agent.is_none() && !native.is_empty() && native != meta.session_id && base.join(&native).is_dir() { continue; }
                if meta.provider == Provider::Codex {
                    if let Some(thread) = codex_by_id.get(&native).filter(|_| !native.is_empty()) {
                        // 用户锁定过的标题以 Forge 为准；未锁定时原生线程名是权威来源。
                        // 原生没有名字（新建还没发过消息，或名字是早期写下的占位名）就什么都不动。
                        if !meta.title_locked {
                            if let Some(title) = thread["title"].as_str().filter(|title| !title.trim().is_empty() && !history::is_placeholder_title(title)) {
                                meta.title = title.to_owned();
                            }
                        }
                        if let Some(created) = thread["createdAt"].as_u64() { meta.created_at = created; }
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
                sessions.push(json!({"id":meta.session_id,"provider":meta.provider,"title":meta.title,"createdAt":meta.created_at,"archived":meta.archived,"pinned":meta.pinned,"pinnedAt":meta.pinned_at,"lastActivity":last_activity,"status":codex_by_id.get(&native).map(|v|v["status"].clone()),"parentSessionId":meta.parent_session_id,"agent":meta.agent}));
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
        let meta = store::Store::metadata(&dir, &root)?;
        let mut target = store::Store { dir, meta, seq: 0, poisoned: false };
        // 改名先落 Forge 侧：这是用户自己的动作，不能被 CLI 的可用性挡下来。
        // 置锁后原生历史同步不再拿 CLI 标题覆盖用户的选择。
        target.meta.title = title.trim().into();
        target.meta.title_locked = true;
        target.save()?;
        // Codex 有可写的原生线程名就顺手推一次；线程还没建出来（这条会话没跑过回合）
        // 或 CLI 报错，都留给回合结束补推。Claude 没有原生写入口，改名只落 Forge 侧。
        let _ = push_codex_title(&mut target);
        Ok(())
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
/// 设置保存锁内只携带这些句柄出去，registry 的具体类型不泄漏给设置模块。
pub struct StoppingRuns(Vec<Arc<Run>>);
pub fn stop_for_disable(app: &AppHandle) -> Result<StoppingRuns, String> {
    // 先清队列：否则 worker 收尾可能在设置尚未落盘前调度下一项。
    cancel_queued(app, |_| true)?;
    Ok(StoppingRuns(stop_registered()))
}
pub fn wait_for_disable(stopping: StoppingRuns) -> Result<(), String> {
    registry::wait_stopped(stopping.0)
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
    fn child_session_ids_are_stable_valid_and_scoped() {
        // 同一个 key 跨轮派生出同一个 id：live 路由与历史导入天然对齐。
        assert_eq!(child_session_id("parent", "toolu_agent_1"), child_session_id("parent", "toolu_agent_1"));
        assert_eq!(child_session_id("parent", "toolu_agent_1"), "parent-ag6e5aab0af93c");
        assert_ne!(child_session_id("parent", "toolu_agent_1"), child_session_id("parent", "toolu_agent_2"));
        assert_ne!(child_session_id("parent-a", "key"), child_session_id("parent-b", "key"));
        let id = child_session_id(&"p".repeat(80), "key");
        assert!(store::valid_id(&id), "{id} 必须能当目录名");
        assert!(id.starts_with(&"p".repeat(48)), "父会话前缀要能看出来源");
    }
    #[test]
    fn delete_scans_follow_the_parent_link_and_the_archive_flag() {
        let temp = std::env::temp_dir().join(format!(
            "forge-delete-scan-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = temp.join("project");
        let base = temp.join("mirror");
        fs::create_dir_all(&root).unwrap();
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let mut parent = store::Store::open(&base, "parent", &workspace, Provider::Codex, "父会话", "").unwrap();
        parent.meta.native_id = Some("thread-1".into());
        parent.save().unwrap();
        let mut child = store::Store::open(&base, "child", &workspace, Provider::Codex, "子代理", "").unwrap();
        child.meta.parent_session_id = Some("parent".into());
        child.meta.native_id = Some("thread-2".into());
        child.save().unwrap();
        // 旧版本给同一原生会话建过的镜像壳：真 ID 目录没了以后它就会浮出来当幽灵行。
        let mut shell = store::Store::open(&base, "native-codex-thread-1", &workspace, Provider::Codex, "# AGENTS.md 旧标题", "").unwrap();
        shell.meta.native_id = Some("thread-1".into());
        shell.save().unwrap();
        // 子代理还能再派生子代理（Codex 的 delegate 实测会套两层）：孙代理也得跟着走。
        let mut grandchild = store::Store::open(&base, "grandchild", &workspace, Provider::Codex, "孙代理", "").unwrap();
        grandchild.meta.parent_session_id = Some("child".into());
        grandchild.meta.native_id = Some("thread-3".into());
        grandchild.save().unwrap();
        store::Store::open(&base, "away", &workspace, Provider::Claude, "收起来的", "").unwrap();
        assert!(store::Store::set_archived(&base, "away", &workspace, true).unwrap());
        // 组的首项是它自己，然后子代理，最后镜像壳：停运行、清排队、删原生都按这一组走。
        assert_eq!(
            session_group(&base, &workspace, "parent").unwrap(),
            vec!["parent".to_string(), "child".to_string(), "grandchild".to_string(), "native-codex-thread-1".to_string()]
        );
        // 从子代理这一层单独删也要带走孙代理，不能只靠父会话那一次扫描。
        assert_eq!(session_group(&base, &workspace, "child").unwrap(), vec!["child".to_string(), "grandchild".to_string()]);
        // 「归档会话」页只列顶层会话；把子代理也列出来，一条父会话会显示成两行。
        assert_eq!(archived_session_ids(&base, &workspace).unwrap(), vec!["away".to_string()]);
        // 归属对不上就扫不到子代理——另一个项目的记录不该被这次删除带走。
        assert_eq!(session_group(&base, "other-project", "parent").unwrap(), vec!["parent".to_string()]);
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn revise_agent_meta_preserves_externally_bound_native_id() {
        let temp = std::env::temp_dir().join(format!(
            "forge-revise-agent-meta-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = temp.join("project");
        let base = temp.join("mirror");
        fs::create_dir_all(&root).unwrap();
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let mut session = store::Store::open(&base, "agent-child", &workspace, Provider::Codex, "子代理", "").unwrap();
        session.meta.agent = Some(store::AgentInfo {
            title: "子代理".into(),
            tool_id: "01a-child".into(),
            status: "running".into(),
            ..Default::default()
        });
        session.save().unwrap();
        // 模拟按需回填的 bind：Worker 句柄之外，磁盘上的 meta 已绑定了 native_id。
        let mut backfill = store::Store::metadata(&base.join("agent-child"), &workspace).unwrap();
        backfill.native_id = Some("01a-child".into());
        store::Store { dir: base.join("agent-child"), meta: backfill, seq: 0, poisoned: false }.save().unwrap();

        // 陈旧句柄式回写（live 路由只知道 running 时的快照）不得抹掉外部绑定。
        let dir = base.join("agent-child");
        let changed = revise_agent_meta(&dir, &workspace, "01a-child", |info| {
            if info.status != "completed" {
                info.status = "completed".into();
                info.ended_at = Some(123456);
                true
            } else { false }
        }).unwrap();
        assert!(changed);
        let meta = store::Store::metadata(&dir, &workspace).unwrap();
        assert_eq!(meta.native_id.as_deref(), Some("01a-child"), "外部 bind 不得被陈旧回写抹掉");
        let agent = meta.agent.unwrap();
        assert_eq!(agent.status, "completed");
        assert_eq!(agent.ended_at, Some(123456));
        assert_eq!(agent.tool_id, "01a-child");

        // 无变化的更新不落盘。
        assert!(!revise_agent_meta(&dir, &workspace, "01a-child", |_| false).unwrap());
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn claude_routes_survive_parent_turns_and_starting_settles_on_exit() {
        let temp = std::env::temp_dir().join(format!("forge-claude-routes-{}", now_ms()));
        let project = temp.join("project");
        let base = temp.join("mirror");
        fs::create_dir_all(&project).unwrap();
        let root = store::workspace(project.to_str().unwrap()).unwrap();
        for (id, parent, provider, status) in [
            ("child", "parent", Provider::Claude, "completed"),
            ("starting", "parent", Provider::Claude, "starting"),
            ("other-parent", "elsewhere", Provider::Claude, "running"),
            ("other-provider", "parent", Provider::Codex, "running"),
        ] {
            let mut target = store::Store::open(&base, id, &root, provider, "代理", "").unwrap();
            target.meta.parent_session_id = Some(parent.into());
            target.meta.agent = Some(store::AgentInfo { tool_id: id.into(), native_agent_id: Some(format!("native-{id}")), status: status.into(), ..Default::default() });
            target.save().unwrap();
        }
        let (routes, warnings) = load_claude_agent_routes(&base, "parent", &root).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(routes.len(), 2);
        assert_eq!(routes["child"].last_status, "completed");
        assert_eq!(routes["child"].store.meta.agent.as_ref().unwrap().native_agent_id.as_deref(), Some("native-child"));
        drop(routes);
        // 新 Worker 重建路由不改旧终态；退出只结算仍未启动完成的代理。
        let (restored, _) = load_claude_agent_routes(&base, "parent", &root).unwrap();
        assert_eq!(restored["child"].last_status, "completed");
        assert_eq!(restored["starting"].last_status, "starting");
        assert!(!stop_active_agent(&base.join("child"), &root, "child").unwrap());
        revise_agent_meta(&base.join("starting"), &root, "starting", |info| { info.status = "starting".into(); info.ended_at = None; true }).unwrap();
        assert!(stop_active_agent(&base.join("starting"), &root, "starting").unwrap());
        let meta = store::Store::metadata(&base.join("starting"), &root).unwrap();
        assert_eq!(meta.agent.as_ref().unwrap().status, "stopped");
        assert!(meta.agent.unwrap().ended_at.is_some());
        // 一个坏日志只影响它自己的路由，其他代理与父回合仍可恢复。
        fs::write(base.join("starting").join("events.jsonl"), "invalid-json\n").unwrap();
        let (healthy, warnings) = load_claude_agent_routes(&base, "parent", &root).unwrap();
        assert!(healthy.contains_key("child"));
        assert!(!healthy.contains_key("starting"));
        assert_eq!(warnings.len(), 1);
        fs::remove_dir_all(temp).unwrap();
    }
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
    fn invalid_queue_target_does_not_remove_the_source_run() {
        let mut items = VecDeque::from([base_request_with_id("first"), base_request_with_id("second")]);
        assert_eq!(move_queued_run(&mut items, "first", Some("missing")), Err(NOT_QUEUED_HERE));
        assert_eq!(items.iter().map(|item| item.run_id.as_str()).collect::<Vec<_>>(), ["first", "second"]);
    }
    #[test]
    fn dispatch_only_blocks_on_confirmed_activity_or_writer() {
        assert!(!activity_blocks_dispatch(Ok(activity::State::Idle), Ok(false)));
        for state in [activity::State::Running, activity::State::External, activity::State::Conflict] {
            assert!(activity_blocks_dispatch(Ok(state), Ok(false)), "{state:?}");
        }
        assert!(!activity_blocks_dispatch(Ok(activity::State::Unknown), Ok(false)));
        assert!(activity_blocks_dispatch(Ok(activity::State::Idle), Ok(true)));
        assert!(!activity_blocks_dispatch(Err("probe failed".into()), Ok(false)));
        assert!(!activity_blocks_dispatch(Ok(activity::State::Idle), Err("lock failed".into())));
        assert!(activity_blocks_dispatch(Err("probe failed".into()), Ok(true)));
    }
    #[test]
    fn disconnect_recovery_is_one_shot_and_fails_closed() {
        // 只有已经真正开跑的普通回合可以续接；握手失败、待审批、特殊命令、
        // 第二次断线以及无法确认外部占用时都不能盲目重发。
        assert!(should_reconnect_after_disconnect(true, 0, false, true, Ok(false)).unwrap());
        assert!(!should_reconnect_after_disconnect(false, 0, false, true, Ok(false)).unwrap());
        assert!(!should_reconnect_after_disconnect(true, 1, false, true, Ok(false)).unwrap());
        assert!(!should_reconnect_after_disconnect(true, 0, true, true, Ok(false)).unwrap());
        assert!(!should_reconnect_after_disconnect(true, 0, false, false, Ok(false)).unwrap());
        assert!(!should_reconnect_after_disconnect(true, 0, false, true, Ok(true)).unwrap());
        assert!(should_reconnect_after_disconnect(true, 0, false, true, Err("probe failed".into())).is_err());
    }
    #[test]
    fn repeated_noop_status_writes_never_reach_the_log() {
        let record = json!({"runId":"run","status":"queued","seq":7,"prompt":"提示词","queueIndex":0});
        // 秒级队列监控在外部 CLI 占着会话时每秒都写一次 waitingExternal，
        // 顺序回写也会在没动过的队列上重写一遍 queued：真实日志里出现过连续三条字节相同的排队事件。
        assert!(status_already_recorded(Some(&record), task_status::QUEUED, &json!({})));
        assert!(status_already_recorded(Some(&record), task_status::QUEUED, &json!({"prompt":"提示词","queueIndex":0})));
        // 顺序真的变了、状态真的换了、这一轮还没记过：三种都必须照写。
        assert!(!status_already_recorded(Some(&record), task_status::QUEUED, &json!({"queueIndex":2})));
        assert!(!status_already_recorded(Some(&record), task_status::QUEUED, &json!({"prompt":"改过的提示词"})));
        assert!(!status_already_recorded(Some(&record), task_status::WAITING_EXTERNAL, &json!({})));
        assert!(!status_already_recorded(None, task_status::QUEUED, &json!({})));
    }
    #[test]
    fn rejects_untrusted_oversized_and_injected_inputs() {
        let mut r = SendRequest {
            session_id: "session".into(),
            run_id: "run".into(),
            provider: Provider::Claude,
            workspace: "root".into(),
            prompt: "hello".into(),
            images: vec![],
            trusted: false,
            model: None,
            effort: None,
            permission: Default::default(),
            fast: None,
            service_tier: None,
            codex_grant: None,
            command: None,
            plan_mode: false,
            mode: None,
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
            prompt: "hello".into(),
            images: vec![],
            trusted: true,
            model: None,
            effort: None,
            permission: Default::default(),
            fast: None,
            service_tier: None,
            codex_grant: None,
            command: None,
            plan_mode: false,
            mode: None,
            plan: None,
            additional_dirs: vec![],
            plan_turn: None,
        }
    }
    fn base_request_with_id(run_id: &str) -> SendRequest {
        let mut request = base_request();
        request.run_id = run_id.to_owned();
        request
    }
    /// 用户改过标题后，首条消息不能再把它换成提示词摘要。
    #[test]
    fn locked_title_survives_the_first_prompt() {
        let temp = std::env::temp_dir().join(format!(
            "forge-locked-title-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let root = temp.join("project");
        let base = temp.join("mirror");
        for path in [&root, &base] { std::fs::create_dir_all(path).unwrap(); }
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let mut target = store::Store::open(&base, "session", &workspace, Provider::Codex, "用户改的标题", "").unwrap();
        target.meta.title_locked = true;
        target.save().unwrap();
        let mut request = base_request();
        request.workspace = root.to_string_lossy().into_owned();
        request.prompt = "第一条消息".into();
        title_first_message(&mut target, &request, true).unwrap();
        assert_eq!(target.meta.title, "用户改的标题");
        std::fs::remove_dir_all(temp).unwrap();
    }
    /// 新建会话的空标题必须发得出去，并在首条消息后自动题名。
    #[test]
    fn untitled_session_names_itself_from_the_first_prompt() {
        let temp = std::env::temp_dir().join(format!(
            "forge-untitled-title-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let root = temp.join("project");
        let base = temp.join("mirror");
        for path in [&root, &base] { std::fs::create_dir_all(path).unwrap(); }
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        // 与 ai_runtime_create 一致：新会话不带任何名字。
        let mut target = store::Store::open(&base, "session", &workspace, Provider::Claude, "", "").unwrap();
        let mut request = base_request();
        request.provider = Provider::Claude;
        request.workspace = root.to_string_lossy().into_owned();
        request.prompt = "修复登录页的跨域问题".into();
        assert!(validate(&request).is_ok());
        title_first_message(&mut target, &request, true).unwrap();
        assert_eq!(target.meta.title, "修复登录页的跨域问题");
        assert_eq!(store::Store::metadata(&base.join("session"), &workspace).unwrap().title, "修复登录页的跨域问题");
        std::fs::remove_dir_all(temp).unwrap();
    }
    /// 首条消息的命名不能被 CLI 侧改名拖住：这一刻 Codex 线程还不存在，
    /// 原生改名只能尽力而为，标题必须已经落在 Forge 侧。
    #[test]
    fn first_message_names_the_session_before_any_thread_exists() {
        let temp = std::env::temp_dir().join(format!(
            "forge-lazy-title-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let root = temp.join("project");
        let base = temp.join("mirror");
        for path in [&root, &base] { std::fs::create_dir_all(path).unwrap(); }
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let mut target = store::Store::open(&base, "session", &workspace, Provider::Codex, "", "").unwrap();
        let mut request = base_request();
        request.workspace = root.to_string_lossy().into_owned();
        request.prompt = "把侧栏最大宽度调小一点".into();
        title_first_message(&mut target, &request, true).unwrap();
        assert_eq!(target.meta.title, "把侧栏最大宽度调小一点");
        assert_eq!(target.meta.native_title_synced, None, "线程都还没有，不能声称已同步给 CLI");
        std::fs::remove_dir_all(temp).unwrap();
    }
    /// 旧版 create 预建的线程 ID 是幽灵（磁盘上什么都没有），拿它 resume 必失败；
    /// 只有一条消息都没发过的会话才丢，跑过回合的和原生 ID 本来就不同的都不动。
    #[test]
    fn only_an_untouched_phantom_thread_id_is_dropped() {
        let temp = std::env::temp_dir().join(format!(
            "forge-phantom-thread-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let root = temp.join("project");
        let base = temp.join("mirror");
        for path in [&root, &base] { std::fs::create_dir_all(path).unwrap(); }
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let mut target = store::Store::open(&base, "session", &workspace, Provider::Codex, "", "").unwrap();
        target.bind("session".into()).unwrap();
        drop_phantom_thread(&mut target).unwrap();
        assert_eq!(target.meta.native_id, None, "空会话的幽灵 ID 必须丢掉，让首条消息新建线程");

        target.bind("thread-real".into()).unwrap();
        target.append("run", vec![("user".into(), json!({"text":"第一条"}))]).unwrap();
        drop_phantom_thread(&mut target).unwrap();
        assert_eq!(target.meta.native_id.as_deref(), Some("thread-real"), "跑过回合的会话不能改绑");

        // Claude 的目录名就是原生会话 ID，这条规则不该碰它。
        let mut claude = store::Store::open(&base, "claude-session", &workspace, Provider::Claude, "", "").unwrap();
        claude.bind("claude-session".into()).unwrap();
        drop_phantom_thread(&mut claude).unwrap();
        assert_eq!(claude.meta.native_id.as_deref(), Some("claude-session"));
        std::fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn codex_enqueue_keeps_selected_model_effort_fast_and_permission() {
        let mut request = base_request();
        request.permission = options::PermissionMode::Auto;
        request.fast = Some(true);
        request.model = Some("chosen-model".into());
        request.effort = Some("low".into());
        freeze_codex_config(&mut request, &json!({"model":"cfg-model","effort":"high","serviceTier":"fast-id","permission":"read"}));
        assert_eq!(request.model.as_deref(), Some("chosen-model"));
        assert_eq!(request.effort.as_deref(), Some("low"));
        assert_eq!(request.service_tier, None);
        assert_eq!(request.fast, Some(true));
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
    fn plan_mode_rejects_a_slash_command_but_not_the_sandbox_preset() {
        let mut request = base_request();
        request.mode = Some("plan".into());
        // 模式与沙箱档在 Codex 上是两条轴：计划回合也可以用完全访问的沙箱，
        // 界面既然把两件事拆成两个选项，后端就不该再造一条「互斥」规则。
        assert!(validate(&request).is_ok());
        request.permission = options::PermissionMode::Full;
        assert!(validate(&request).is_ok());
        // 斜杠命令自己决定这一轮做什么，额外模式会被它吞掉，仍然拒绝。
        request.command = Some(commands::CommandIntent::CodexCompact);
        assert!(validate(&request).is_err());
        // 旧的 plan_mode 布尔与 mode 同义：带着斜杠命令时同样拒绝。
        request.mode = None;
        request.plan_mode = true;
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

    #[test]
    fn claude_plan_mode_whitelists_task_tools() {
        let mut request = base_request();
        // 显式指定 Claude 运行时，确保进入 Claude 参数组装分支。
        request.provider = Provider::Claude;
        let args = runtime_args(&request, "plan", None);
        assert!(args.contains(&"--allowedTools".into()));
        assert!(args.contains(&"TaskCreate".into()));
        assert!(args.contains(&"TaskUpdate".into()));
        assert!(args.contains(&"TaskList".into()));
        assert!(args.contains(&"TaskGet".into()));
        assert!(args.contains(&"TodoWrite".into()));
        assert!(args.contains(&"--disallowedTools".into()));
        assert!(args.contains(&"Edit".into()));
        assert!(args.contains(&"Write".into()));
    }

    #[test]
    fn long_text_attachment_is_utf8_and_stays_in_system_temp() {
        let root = std::env::temp_dir().join(format!("forge-ai-context-test-{}", std::process::id()));
        let saved = save_text_attachment_to(root.clone(), "第一行\nsecond line").unwrap();
        let path = PathBuf::from(saved["path"].as_str().unwrap());
        let directory = PathBuf::from(saved["directory"].as_str().unwrap());
        assert!(path.starts_with(std::fs::canonicalize(std::env::temp_dir()).unwrap()));
        assert_eq!(directory, std::fs::canonicalize(&root).unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "第一行\nsecond line");
        let next = save_text_attachment_to(root.clone(), "下一份").unwrap();
        assert_ne!(saved["path"], next["path"]);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn text_attachment_rejects_empty_and_oversized_content() {
        let root = std::env::temp_dir().join(format!("forge-ai-context-limit-test-{}", std::process::id()));
        assert!(save_text_attachment_to(root.clone(), "   ").is_err());
        assert!(save_text_attachment_to(root, &"x".repeat(MAX_TEXT_ATTACHMENT_BYTES + 1)).is_err());
    }

    #[test]
    fn file_lines_are_counted_without_loading_the_whole_file() {
        let path = std::env::temp_dir().join(format!("forge-ai-line-count-{}.txt", std::process::id()));
        std::fs::write(&path, b"one\r\ntwo\rthree\n").unwrap();
        assert_eq!(file_line_count(path.to_str().unwrap()).unwrap(), 4);
        std::fs::remove_file(path).ok();
        assert!(file_line_count("relative.txt").is_err());
    }
}
