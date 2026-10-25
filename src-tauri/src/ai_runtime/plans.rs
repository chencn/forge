//! Codex 计划审阅的本地事实源。
//!
//! 移植自 ccgui 的 `plan_review.rs`：把 SQLite 表换成本会话目录里的
//! `plans.json`，状态机、CAS 抢占与「批准 ≠ 执行成功」的边界原样保留。
//! 计划只属于 Forge 会话；删会话时随目录一起消失，原生 history 不参与审批。
//!
//! 状态机：`awaiting_review → submitting → approved | changes_requested | deferred`，
//! 另有终态 `expired | superseded`。`deferred` 仍可再次提交；`submitting` 只允许
//! 一个提交者，双击或两个窗口只能有一个抢到。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::Mutex;

/// 串行化 plans.json 的读改写。只做本地小文件操作，不在锁内启动 CLI。
static PLAN_LOCK: Mutex<()> = Mutex::new(());
const FILE: &str = "plans.json";
const LOCK_FILE: &str = "plans.lock";
const CLAIM_LOCK_FILE: &str = "plan-claim.lock";
const MAX_FILE: u64 = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    AwaitingReview,
    Submitting,
    Approved,
    ChangesRequested,
    Deferred,
    Expired,
    Superseded,
}
impl Status {
    pub fn accepts_submission(self) -> bool {
        matches!(self, Self::AwaitingReview | Self::Deferred)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AwaitingReview => "awaiting_review",
            Self::Submitting => "submitting",
            Self::Approved => "approved",
            Self::ChangesRequested => "changes_requested",
            Self::Deferred => "deferred",
            Self::Expired => "expired",
            Self::Superseded => "superseded",
        }
    }
    /// 新版本到来时可以被取代的版本：已决策和终态保持原状，便于历史回看。
    fn is_open(self) -> bool {
        matches!(self, Self::AwaitingReview | Self::Submitting | Self::Deferred)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Execution {
    NotStarted,
    Running,
    Completed,
    Failed,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Approve,
    RequestChanges,
    Defer,
}
impl Decision {
    pub fn settled(self) -> Status {
        match self {
            Self::Approve => Status::Approved,
            Self::RequestChanges => Status::ChangesRequested,
            Self::Defer => Status::Deferred,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approve => "approve",
            Self::RequestChanges => "request_changes",
            Self::Defer => "defer",
        }
    }
}

/// 一份计划版本。`session_id` 是 Forge 会话，`native_id` 是 Codex thread；
/// 审批身份由 planId + revision 决定，内容指纹用于决策前重核。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReview {
    pub plan_id: String,
    pub session_id: String,
    pub native_id: String,
    pub workspace: String,
    pub run_id: Option<String>,
    pub revision: i64,
    pub title: String,
    pub content: String,
    pub content_hash: String,
    pub complete: bool,
    pub native_plan_id: String,
    /// 批准后沿用的权限快照；Forge 的 Codex 沿用项目原生配置。
    pub exec_permission: String,
    pub status: Status,
    pub execution: Execution,
    pub decision: Option<String>,
    pub applied_at: Option<u64>,
    pub created_at: u64,
    pub updated_at: u64,
    pub superseded_by: Option<i64>,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 非加密指纹：只用于发现正文在等待审批期间被改写，不承担安全绑定。
pub fn content_hash(content: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    content.len().hash(&mut hasher);
    content.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

pub fn load(dir: &Path) -> Result<Vec<PlanReview>, String> {
    let path = dir.join(FILE);
    match fs::metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
        Ok(meta) if meta.len() > MAX_FILE => return Err("计划记录过大".into()),
        Ok(_) => {}
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| format!("计划记录损坏：{error}"))
}

fn save(dir: &Path, plans: &[PlanReview]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let text = serde_json::to_string_pretty(plans).map_err(|error| error.to_string())?;
    // 写端和读端必须守同一上限；否则本次成功、下一次永远读不回，审批状态直接报废。
    if text.len() as u64 > MAX_FILE { return Err("计划记录过大".into()); }
    crate::sys::write_atomic(&dir.join(FILE), &text)
}

fn update_lock(dir: &Path) -> Result<crate::sys::ExclusiveFileLock, String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    crate::sys::ExclusiveFileLock::acquire(&dir.join(LOCK_FILE))
}

/// 一次计划决策从 CAS 抢占起持有到应用或回滚；进程崩溃时由内核释放。
pub fn claim(dir: &Path) -> Result<crate::ai_runtime::store::Lease, String> {
    if !dir.is_dir() { return Err("会话不存在".into()); }
    crate::ai_runtime::store::Lease::acquire(&dir.join(CLAIM_LOCK_FILE))
}

/// 登记一份新计划：同一 planId 的历史开放版本全部被取代，revision 递增。
pub fn record(
    dir: &Path,
    session_id: &str,
    native_id: &str,
    workspace: &str,
    run_id: &str,
    title: &str,
    content: &str,
    native_plan_id: &str,
) -> Result<PlanReview, String> {
    let _guard = PLAN_LOCK.lock().map_err(|error| error.to_string())?;
    let _file_guard = update_lock(dir)?;
    let mut plans = load(dir)?;
    let next = plans.iter().filter(|plan| plan.plan_id == plan_id_for(native_id)).map(|plan| plan.revision).max().unwrap_or(0) + 1;
    let plan_id = plan_id_for(native_id);
    let now = now_ms();
    for plan in plans.iter_mut().filter(|plan| plan.plan_id == plan_id && plan.status.is_open()) {
        plan.status = Status::Superseded;
        plan.superseded_by = Some(next);
        plan.updated_at = now;
    }
    let record = PlanReview {
        plan_id,
        session_id: session_id.into(),
        native_id: native_id.into(),
        workspace: workspace.into(),
        run_id: Some(run_id.into()),
        revision: next,
        title: title.to_string(),
        content: content.to_string(),
        content_hash: content_hash(content),
        complete: true,
        native_plan_id: native_plan_id.into(),
        exec_permission: "inherit".into(),
        status: Status::AwaitingReview,
        execution: Execution::NotStarted,
        decision: None,
        applied_at: None,
        created_at: now,
        updated_at: now,
        superseded_by: None,
    };
    plans.push(record.clone());
    save(dir, &plans)?;
    Ok(record)
}

/// 一个 thread 同时只有一份待审计划；修订版落在同一 planId 的下一个 revision。
pub fn plan_id_for(native_id: &str) -> String {
    format!("{native_id}/plan")
}

pub fn get(dir: &Path, plan_id: &str, revision: i64) -> Result<Option<PlanReview>, String> {
    let _guard = PLAN_LOCK.lock().map_err(|error| error.to_string())?;
    Ok(load(dir)?.into_iter().find(|plan| plan.plan_id == plan_id && plan.revision == revision))
}

pub enum Submit {
    /// 抢占成功；`previous` 用于写管道失败时原样退回。
    Claimed { review: PlanReview, previous: Status },
    /// 已被别人提交或状态已变；返回当前记录供界面呈现冲突。
    Conflict(PlanReview),
}

/// 原子抢占一次决策。`expected_revision` 与状态同时匹配才允许提交。
pub fn submit(dir: &Path, plan_id: &str, expected: i64, decision: Decision, feedback: Option<&str>) -> Result<Submit, String> {
    if decision == Decision::RequestChanges && feedback.map(str::trim).filter(|text| !text.is_empty()).is_none() {
        return Err("要求修改必须填写说明".into());
    }
    let _guard = PLAN_LOCK.lock().map_err(|error| error.to_string())?;
    let _file_guard = update_lock(dir)?;
    let mut plans = load(dir)?;
    let Some(current) = plans.iter().find(|plan| plan.plan_id == plan_id && plan.revision == expected).cloned() else {
        return Err("计划版本不存在或已失效".into());
    };
    if !current.complete {
        return Err("计划内容不完整，不能批准".into());
    }
    if !current.status.accepts_submission() {
        return Ok(Submit::Conflict(current));
    }
    let now = now_ms();
    let decision_json = serde_json::json!({"decision":decision.as_str(),"feedback":feedback}).to_string();
    let previous = current.status;
    let Some(record) = plans.iter_mut().find(|plan| plan.plan_id == plan_id && plan.revision == expected) else {
        return Err("计划版本不存在或已失效".into());
    };
    record.status = Status::Submitting;
    record.decision = Some(decision_json);
    record.updated_at = now;
    let review = record.clone();
    save(dir, &plans)?;
    Ok(Submit::Claimed { review, previous })
}

/// 原生回合确认启动后落账；批准不等于执行成功，执行状态另记。
pub fn mark_applied(dir: &Path, plan_id: &str, revision: i64, decision: Decision) -> Result<PlanReview, String> {
    let _guard = PLAN_LOCK.lock().map_err(|error| error.to_string())?;
    let _file_guard = update_lock(dir)?;
    let mut plans = load(dir)?;
    let now = now_ms();
    let Some(plan) = plans.iter_mut().find(|plan| plan.plan_id == plan_id && plan.revision == revision) else {
        return Err("计划版本不存在".into());
    };
    if plan.status != Status::Submitting {
        return Err(format!("计划提交状态已变化（当前状态 {}）", plan.status.as_str()));
    }
    let stored_decision = plan.decision.as_deref()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
        .and_then(|value| value["decision"].as_str().map(str::to_owned));
    if stored_decision.as_deref() != Some(decision.as_str()) {
        return Err("计划提交决策与应用决策不一致".into());
    }
    plan.status = decision.settled();
    plan.applied_at = Some(now);
    plan.updated_at = now;
    let record = plan.clone();
    save(dir, &plans)?;
    Ok(record)
}

/// 写管道失败：决策意图留存，状态退回抢占前，绝不显示已批准。
pub fn revert(dir: &Path, plan_id: &str, revision: i64, previous: Status) -> Result<PlanReview, String> {
    let _guard = PLAN_LOCK.lock().map_err(|error| error.to_string())?;
    let _file_guard = update_lock(dir)?;
    let mut plans = load(dir)?;
    let Some(plan) = plans.iter_mut().find(|plan| plan.plan_id == plan_id && plan.revision == revision) else {
        return Err("计划版本不存在".into());
    };
    if plan.status == Status::Submitting {
        plan.status = previous;
        plan.updated_at = now_ms();
    }
    let record = plan.clone();
    save(dir, &plans)?;
    Ok(record)
}

/// 计划正文在等待审批期间被改写或消失：该版本只能过期，不能继续挂着旧正文。
pub fn expire(dir: &Path, plan_id: &str, revision: i64) -> Result<Option<PlanReview>, String> {
    let _guard = PLAN_LOCK.lock().map_err(|error| error.to_string())?;
    let _file_guard = update_lock(dir)?;
    let mut plans = load(dir)?;
    let Some(plan) = plans.iter_mut().find(|plan| plan.plan_id == plan_id && plan.revision == revision) else {
        return Ok(None);
    };
    plan.status = Status::Expired;
    plan.updated_at = now_ms();
    let record = plan.clone();
    save(dir, &plans)?;
    Ok(Some(record))
}

pub fn mark_execution(dir: &Path, plan_id: &str, revision: i64, execution: Execution) -> Result<(), String> {
    let _guard = PLAN_LOCK.lock().map_err(|error| error.to_string())?;
    let _file_guard = update_lock(dir)?;
    let mut plans = load(dir)?;
    let Some(plan) = plans.iter_mut().find(|plan| plan.plan_id == plan_id && plan.revision == revision) else {
        return Ok(());
    };
    plan.execution = execution;
    plan.updated_at = now_ms();
    save(dir, &plans)
}

/// 打开会话时修复「提交了但没有回合」的残留：进程崩溃或应用退出会让 submitting
/// 永远等不到确认。活提交者持有 claim，拿不到时绝不能靠时间猜它已经死了。
pub fn recover(dir: &Path) -> Result<(), String> {
    let Ok(_claim) = claim(dir) else { return Ok(()); };
    let _guard = PLAN_LOCK.lock().map_err(|error| error.to_string())?;
    let _file_guard = update_lock(dir)?;
    let mut plans = load(dir)?;
    let now = now_ms();
    let mut changed = false;
    for plan in plans.iter_mut().filter(|plan| plan.status == Status::Submitting) {
        plan.status = Status::AwaitingReview;
        plan.updated_at = now;
        changed = true;
    }
    if changed { save(dir, &plans)?; }
    Ok(())
}

/// 计划卡片的标题取正文里第一个 ATX 标题；没有就用固定名。
pub fn title(content: &str) -> String {
    for line in content.lines() {
        let line = line.trim_start();
        let hashes = line.chars().take_while(|c| *c == '#').count();
        if hashes == 0 || hashes > 6 {
            continue;
        }
        let rest = &line[hashes..];
        if !rest.starts_with(' ') && !rest.starts_with('\t') {
            continue;
        }
        let title = rest.trim();
        if !title.is_empty() {
            return title.chars().take(80).collect();
        }
    }
    "Codex plan".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn dir(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "forge-plans-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn add(path: &Path, content: &str) -> PlanReview {
        let name = title(content);
        record(path, "s1", "thread-1", "root", "run-1", &name, content, "item-1").unwrap()
    }

    #[test]
    fn a_revision_supersedes_only_open_versions() {
        let path = dir("rev");
        assert_eq!(add(&path, "# 计划\n第一步").revision, 1);
        assert_eq!(add(&path, "# 计划\n第二步").revision, 2);
        let old = get(&path, &plan_id_for("thread-1"), 1).unwrap().unwrap();
        assert_eq!(old.status, Status::Superseded);
        assert_eq!(old.superseded_by, Some(2));
        assert_eq!(add(&path, "# 计划\n第三步").revision, 3);
        assert_eq!(get(&path, &plan_id_for("thread-1"), 2).unwrap().unwrap().status, Status::Superseded);
        fs::remove_dir_all(path).ok();
    }

    #[test]
    fn cas_claims_once_and_double_submit_conflicts() {
        let path = dir("cas");
        add(&path, "# 计划");
        let plan_id = plan_id_for("thread-1");
        assert!(matches!(submit(&path, &plan_id, 1, Decision::Approve, None).unwrap(), Submit::Claimed { previous: Status::AwaitingReview, .. }));
        assert!(matches!(submit(&path, &plan_id, 1, Decision::Approve, None).unwrap(), Submit::Conflict(plan) if plan.status == Status::Submitting));
        assert!(submit(&path, &plan_id, 99, Decision::Approve, None).is_err());
        fs::remove_dir_all(path).ok();
    }

    #[test]
    fn oversized_plan_is_rejected_before_it_can_poison_the_store() {
        let path = dir("oversized");
        let content = "x".repeat(MAX_FILE as usize + 1);
        let error = record(&path, "s1", "thread-1", "root", "run-1", "large", &content, "item-1").unwrap_err();
        assert!(error.contains("计划记录过大"));
        assert!(load(&path).unwrap().is_empty());
        fs::remove_dir_all(path).ok();
    }

    #[test]
    fn request_changes_requires_feedback_and_defer_can_resubmit() {
        let path = dir("feedback");
        add(&path, "# 计划");
        let plan_id = plan_id_for("thread-1");
        assert!(submit(&path, &plan_id, 1, Decision::RequestChanges, None).is_err());
        assert!(submit(&path, &plan_id, 1, Decision::RequestChanges, Some("  ")).is_err());
        assert!(matches!(submit(&path, &plan_id, 1, Decision::Defer, None).unwrap(), Submit::Claimed { .. }));
        let deferred = mark_applied(&path, &plan_id, 1, Decision::Defer).unwrap();
        assert_eq!(deferred.status, Status::Deferred);
        assert!(matches!(submit(&path, &plan_id, 1, Decision::Approve, None).unwrap(), Submit::Claimed { .. }));
        fs::remove_dir_all(path).ok();
    }

    #[test]
    fn failed_pipe_reverts_without_claiming_success_and_stale_expires() {
        let path = dir("revert");
        add(&path, "# 计划");
        let plan_id = plan_id_for("thread-1");
        submit(&path, &plan_id, 1, Decision::Approve, None).unwrap();
        let reverted = revert(&path, &plan_id, 1, Status::AwaitingReview).unwrap();
        assert_eq!(reverted.status, Status::AwaitingReview);
        assert!(reverted.applied_at.is_none());
        assert!(reverted.decision.is_some());
        let expired = expire(&path, &plan_id, 1).unwrap().unwrap();
        assert_eq!(expired.status, Status::Expired);
        fs::remove_dir_all(path).ok();
    }

    #[test]
    fn recovery_respects_a_live_claim_and_reclaims_after_it_is_released() {
        let path = dir("recover");
        add(&path, "# 计划");
        let plan_id = plan_id_for("thread-1");
        let claim = claim(&path).unwrap();
        submit(&path, &plan_id, 1, Decision::Approve, None).unwrap();
        recover(&path).unwrap();
        assert_eq!(get(&path, &plan_id, 1).unwrap().unwrap().status, Status::Submitting);
        drop(claim);
        recover(&path).unwrap();
        assert_eq!(get(&path, &plan_id, 1).unwrap().unwrap().status, Status::AwaitingReview);
        assert!(mark_applied(&path, &plan_id, 1, Decision::Approve).is_err(), "已恢复的提交不能假装应用成功");
        fs::remove_dir_all(path).ok();
    }

    #[test]
    fn applied_decision_must_match_the_claimed_decision() {
        let path = dir("decision");
        add(&path, "# 计划");
        let plan_id = plan_id_for("thread-1");
        submit(&path, &plan_id, 1, Decision::Approve, None).unwrap();
        assert!(mark_applied(&path, &plan_id, 1, Decision::RequestChanges).is_err());
        assert_eq!(get(&path, &plan_id, 1).unwrap().unwrap().status, Status::Submitting);
        fs::remove_dir_all(path).ok();
    }

    #[test]
    fn title_reads_the_first_real_heading() {
        assert_eq!(title("intro\n## 实施步骤\nbody"), "实施步骤");
        assert_eq!(title("#nothash\nplain"), "Codex plan");
        assert_eq!(title("####### too deep"), "Codex plan");
    }
}
