//! 只读检查会话占用；不以历史 mtime 推测运行，也不停止外部进程。
use super::{history, registry, store};
use crate::ai_cli::Provider;
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::io::{Read, Seek, SeekFrom};

/// 会话占用探测的结论。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State { Idle, Running, External, Conflict, Unknown }

/// CLI 配置目录：环境变量（绝对路径）优先，否则用户主目录下的 `fallback`。
///
/// # Errors
///
/// 环境变量与用户目录均不可得时返回错误。
fn cli_home(variable: &str, fallback: &str) -> Result<PathBuf, String> {
    std::env::var_os(variable).map(PathBuf::from).or_else(|| {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(|home| PathBuf::from(home).join(fallback))
    }).ok_or("无法确定 CLI 配置目录".into())
}

/// 探测 CLI 会话的写锁是否被占用；锁文件不存在视为没有写者。
///
/// # Errors
///
/// 打开锁文件或加锁失败时返回错误原文。
fn writer_lock(path: &Path) -> Result<(bool, Option<File>), String> {
    let file = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((false, None)),
        Err(error) => return Err(error.to_string()),
    };
    // 句柄关闭即释放，不改变锁文件内容。
    if crate::lock::try_lock_exclusive(&file)? {
        Ok((false, Some(file)))
    } else {
        Ok((true, None))
    }
}

/// 活进程还须匹配创建时间，避免陈旧 PID 登记误认后来复用 PID 的程序。
fn process_matches(pid: u32, record: &Value) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use windows::Win32::{Foundation::{CloseHandle, FILETIME, ERROR_INVALID_PARAMETER}, System::Threading::{OpenProcess, GetProcessTimes, GetExitCodeProcess, PROCESS_QUERY_LIMITED_INFORMATION}};
        let handle = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
            Ok(handle) => handle,
            Err(error) if error.code() == ERROR_INVALID_PARAMETER.to_hresult() => return Ok(false),
            Err(error) => return Err(error.to_string()),
        };
        let result = (|| {
            let mut exit = 0;
            unsafe { GetExitCodeProcess(handle, &mut exit) }.map_err(|e| e.to_string())?;
            if exit != 259 { return Ok(false); }
            let (mut created, mut ended, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
            unsafe { GetProcessTimes(handle, &mut created, &mut ended, &mut kernel, &mut user) }.map_err(|e| e.to_string())?;
            let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
            if let Some(expected) = record["procStartFt"].as_str().and_then(|s| s.parse::<u64>().ok()) { return Ok(ticks == expected); }
            if let Some(expected) = record["procStart"].as_str().and_then(|s| s.parse::<u64>().ok()) {
                // 旧 CLI 的 CIM CreationDate.Ticks 是本地时间，不可直接与 UTC FILETIME 相比。
                let mut local = FILETIME::default();
                unsafe { windows::Win32::Storage::FileSystem::FileTimeToLocalFileTime(&created, &mut local) }.map_err(|e| e.to_string())?;
                let local_ticks = (u64::from(local.dwHighDateTime) << 32) | u64::from(local.dwLowDateTime);
                // CIM 日期序列化可能丢失亚微秒精度；只在同一微秒内认可。
                return Ok((local_ticks + 504_911_232_000_000_000) / 10 == expected / 10);
            }
            Err("会话登记缺少进程创建时间，无法确认占用".into())
        })();
        let _ = unsafe { CloseHandle(handle) };
        result
    }
    #[cfg(unix)]
    {
        let _ = record;
        if unsafe { libc::kill(pid as i32, 0) } == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) { return Ok(false); }
        Err("此平台暂不能核验外部 Claude 进程创建时间".into())
    }
}

/// 批量读 Claude 的 PID 登记目录，产出 `(pid, record)` 列表。
///
/// 单份登记超过 64 KB、解析失败或正被写一半的都跳过，不让个别坏文件阻塞整个探测。
///
/// # Errors
///
/// 目录读取失败（不存在不算）或条目元数据失败时返回错误。
fn claude_records(dir: &Path) -> Result<Vec<(u32, Value)>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error.to_string()),
    };
    let mut records = vec![];
    for entry in entries.take(4096) {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() { continue; }
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let Some(pid) = path.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<u32>().ok()).filter(|pid| *pid > 0) else { continue; };
        if entry.metadata().map_err(|e| e.to_string())?.len() > 64 * 1024 { continue; }
        // 登记可能正被替换或删除；不让其他会话的一份半写文件阻塞整个工程。
        let Some(record) = fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()) else { continue; };
        records.push((pid, record));
    }
    Ok(records)
}

/// 每次批量轮询只扫描一次 Claude 小型 PID 登记，不重复读取 N 份目录。
#[derive(Default)]
pub struct Probe { claude: Option<Result<Vec<(u32, Value)>, String>> }
impl Probe {
/// 探测一条原生会话是否正被外部进程执行；Claude 走 PID 登记，Codex 走线程写锁。
/// Claude 的登记结果按探针实例缓存（见 [`Probe`] 字段），批量轮询只扫一遍目录。
///
/// # Errors
///
/// 原生 ID 非法、配置目录不可得或登记读取失败时返回错误。
fn external(&mut self, provider: Provider, native: &str, own_pid: u32) -> Result<bool, String> {
    if !store::valid_id(native) { return Err("无效原生会话 ID".into()); }
    if provider == Provider::Codex { return codex_occupied(&cli_home("CODEX_HOME", ".codex")?.join("thread-writer-locks"), native); }
    let records = self.claude.get_or_insert_with(|| cli_home("CLAUDE_CONFIG_DIR", ".claude").and_then(|home| claude_records(&home.join("sessions"))));
    match records {
        Ok(records) => claude_occupied(records, native, own_pid, process_matches),
        Err(error) => Err(error.clone()),
    }
}
    /// 探测一条会话的占用状态（实例方法入口）。
    pub fn state(&mut self, base: &Path, id: &str, root: &str) -> Result<State, String> {
    state_with(self, base, id, root)
}
}
/// 在 Claude PID 登记里找同会话的外部活动任务：ID 匹配、状态 busy/waiting、
/// 排除自身进程，且 PID 对应进程确实存活（`matches` 校验创建时间）。
///
/// # Errors
///
/// [`process_matches`] 的错误原样透传。
fn claude_occupied(records: &[(u32, Value)], native: &str, own_pid: u32, matches: impl Fn(u32, &Value) -> Result<bool, String>) -> Result<bool, String> {
    for (pid, record) in records {
        // 窗口存活不是任务运行；只有执行中或等待工具答复才计入活动任务。
        if *pid != own_pid && record["sessionId"] == native
            && matches!(record["status"].as_str(), Some("busy" | "waiting"))
            && matches(*pid, record)? { return Ok(true); }
    }
    Ok(false)
}

/// 检查 Codex 的线程写锁占用情况。
///
/// 先查交接锁 `.coordination.lock`：正被占着说明交接进行中，按错误报；
/// 再查会话锁 `<native>.lock`：被别的进程握着即占用。
///
/// # Errors
///
/// 交接锁被占（中文提示）或底层锁检查失败时返回错误。
fn codex_occupied(dir: &Path, native: &str) -> Result<bool, String> {
    // 与官方 writer_lock.rs 相同顺序，防止检查到清理/重建之前的旧文件。
    let (busy, _coordination) = writer_lock(&dir.join(".coordination.lock"))?;
    if busy { return Err("Codex 正在交接会话写锁，请稍后重试".into()); }
    Ok(writer_lock(&dir.join(format!("{native}.lock")))?.0)
}

/// 写锁只和原生 ID 有关，不必先读会话元数据的那份目录。
fn codex_thread_locks() -> Result<PathBuf, String> {
    Ok(cli_home("CODEX_HOME", ".codex")?.join("thread-writer-locks"))
}

/// 这条会话的原生写锁此刻有没有被别的进程拿着。和 `state` 的徽标是两回事：那边要分清
/// 「开着但没在跑」，而 `thread/resume` 不认——锁只要有人握着就当场拒。
pub fn writer_held(base: &Path, id: &str, root: &str) -> Result<bool, String> {
    held_in(base, id, root, &codex_thread_locks()?)
}

/// [`writer_held`] 的实际执行体；`locks` 参数化是为了测试注入临时目录。
///
/// 只对绑定了原生 ID 的 Codex 会话有意义，其余一律不挡。
///
/// # Errors
///
/// 会话 ID 非法、元数据读取失败或原生 ID 非法时返回错误。
fn held_in(base: &Path, id: &str, root: &str, locks: &Path) -> Result<bool, String> {
    if !store::valid_id(id) { return Err("无效会话 ID".into()); }
    let meta = store::Store::metadata(&base.join(id), root)?;
    // 只有 Codex 有这份跨进程的线程写锁；Claude 的复用靠 PID 登记，另有一条路。
    if meta.provider != Provider::Codex { return Ok(false); }
    // 还没原生 ID 的会话走 thread/start，谈不上复用，也就没人挡路。
    let Some(native) = meta.native_id.as_deref() else { return Ok(false); };
    if !store::valid_id(native) { return Err("无效原生会话 ID".into()); }
    match codex_occupied(locks, native) {
        Ok(held) => Ok(held),
        // 交接锁正被占着：这一刻没人能安全接手这条会话。按「挡住」报，让队列等下一轮轮询。
        Err(_) => Ok(true),
    }
}

/// 用默认探针探测一条会话的占用状态。
pub fn state(base: &Path, id: &str, root: &str) -> Result<State, String> {
    Probe::default().state(base, id, root)
}
/// 断线恢复时只检查原生会话是否被外部 CLI 占用，不能走 `state`：当前 Worker
/// 仍在 registry 中，`state` 必然返回 Running，反而会把自己的恢复挡住。
pub fn externally_occupied(base: &Path, id: &str, root: &str) -> Result<bool, String> {
    if !store::valid_id(id) { return Err("无效会话 ID".into()); }
    let meta = store::Store::metadata(&base.join(id), root)?;
    let Some(native) = meta.native_id.as_deref() else { return Ok(false); };
    Probe::default().external(meta.provider, native, 0)
}
/// [`state`] 的实际执行体，允许测试注入自定义探针。
///
/// 判定顺序：本窗口在跑 → Running；另一 Forge 窗口持租约 → External；
/// 原生 CLI 还活着 → External/Idle（Codex 按任务边界细分）；都不占 → Idle。
///
/// # Errors
///
/// 会话 ID 非法、项目不匹配或元数据读取失败时返回错误。
fn state_with(probe: &mut Probe, base: &Path, id: &str, root: &str) -> Result<State, String> {
    if !store::valid_id(id) { return Err("无效会话 ID".into()); }
    if let Some(run) = registry::for_session(id) {
        if run.workspace != root { return Err("会话项目不匹配".into()); }
        if let Ok(meta) = store::Store::metadata(&base.join(id), root) {
            if meta.provider == Provider::Claude {
                if let Some(native) = meta.native_id.as_deref() {
                    if probe.external(meta.provider, native, run.child_pid.load(std::sync::atomic::Ordering::Acquire))? { return Ok(State::Conflict); }
                }
            }
        }
        return Ok(State::Running);
    }
    let dir = base.join(id);
    if !dir.exists() { return Ok(State::Idle); }
    let meta = store::Store::metadata(&dir, root)?;
    if let Some(parent) = meta.parent_session_id.as_deref().filter(|_| meta.agent.is_some()) {
        // 展示依据委派生命周期；控制权仍只属于父 registry，子会话没有独立 Run。
        let page = store::Store::page(base, id, root, store::Window::Before(u64::MAX), 1, true)?;
        if page.status.as_deref() != Some("running") { return Ok(State::Idle); }
        if let Some(run) = registry::for_session(parent) {
            if run.workspace != root { return Err("会话项目不匹配".into()); }
            return Ok(if page.latest_run_id.as_deref() == Some(run.id.as_str()) { State::Running } else { State::Idle });
        }
        // 跨窗口的父租约同样代表外部活动，不向子窗口授予停止权限。
        if parent != id && store::valid_id(parent) {
            let parent_meta = store::Store::metadata(&base.join(parent), root)?;
            if parent_meta.parent_session_id.is_none() {
                match state_with(probe, base, parent, root)? {
                    State::External | State::Conflict => return Ok(State::External),
                    _ => {}
                }
            }
        }
    }
    // 另一个 Forge 进程遵守同一租约；不能把它当作本窗口可停止的任务。
    let lock = base.join(format!("{id}.lock"));
    if lock.exists() {
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            if let Err(error) = OpenOptions::new().read(true).share_mode(0).open(&lock) {
                if error.raw_os_error() == Some(32) { return Ok(State::External); }
                return Err(error.to_string());
            }
        }
        #[cfg(unix)]
        if writer_lock(&lock)?.0 { return Ok(State::External); }
    }
    let live = meta.native_id.as_deref().map(|id| probe.external(meta.provider, id, 0)).transpose()?.unwrap_or(false);
    if !live { return Ok(State::Idle); }
    if meta.provider == Provider::Codex {
        // 写锁持续到窗口退出；另读真实 turn 边界，不能把持锁等同执行任务。
        let Some(source) = history::source(base, id, root)? else { return Ok(State::Unknown); };
        return Ok(match codex_task_active(&source.path)? { Some(true) => State::External, Some(false) => State::Idle, None => State::Unknown });
    }
    Ok(State::External)
}

/// 有界尾读只检查完整 JSON 行的任务边界，不以文件修改时间猜运行。
fn codex_task_active(path: &Path) -> Result<Option<bool>, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let offset = len.saturating_sub(256 * 1024);
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(256 * 1024).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let lines: Vec<_> = bytes.split(|b| *b == b'\n').collect();
    for line in lines.iter().take(lines.len().saturating_sub(1)).skip(usize::from(offset > 0)).rev() {
        let Ok(value) = serde_json::from_slice::<Value>(line) else { continue; };
        if value["type"] != "event_msg" { continue; }
        match value["payload"]["type"].as_str() {
            Some("task_started" | "turn_started") => return Ok(Some(true)),
            Some("task_complete" | "turn_complete" | "turn_aborted") => return Ok(Some(false)),
            _ => {},
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    /// 测试夹具：唯一临时目录，Drop 时整体清理。
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!("forge-activity-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
            fs::create_dir_all(&path).unwrap(); Self(path)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn codex_writer_lock_is_session_scoped_and_releases_on_close() {
        let fixture = Fixture::new();
        let path = fixture.0.join("native.lock");
        fs::write(&path, []).unwrap();
        fs::write(fixture.0.join(".coordination.lock"), []).unwrap();
        assert!(!codex_occupied(&fixture.0, "native").unwrap());
        let (_, held) = writer_lock(&path).unwrap();
        assert!(held.is_some());
        assert!(codex_occupied(&fixture.0, "native").unwrap());
        assert!(!codex_occupied(&fixture.0, "other").unwrap());
        drop(held);
        assert!(!codex_occupied(&fixture.0, "native").unwrap());
        let (_, coordinator) = writer_lock(&fixture.0.join(".coordination.lock")).unwrap();
        assert!(codex_occupied(&fixture.0, "native").is_err());
        drop(coordinator);
        assert_eq!(fs::metadata(path).unwrap().len(), 0);
        assert!(!fixture.0.join("other.lock").exists());
    }

    #[test]
    fn codex_activity_uses_task_boundaries_and_ignores_partial_writes() {
        let fixture = Fixture::new();
        let path = fixture.0.join("rollout.jsonl");
        let start = json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"one"}}).to_string();
        let end = json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"one"}}).to_string();
        fs::write(&path, format!("{start}\n")).unwrap();
        assert_eq!(codex_task_active(&path).unwrap(), Some(true));
        fs::write(&path, format!("{start}\n{end}")).unwrap();
        assert_eq!(codex_task_active(&path).unwrap(), Some(true));
        fs::write(&path, format!("{start}\n{end}\n")).unwrap();
        assert_eq!(codex_task_active(&path).unwrap(), Some(false));
        fs::write(&path, "{\"type\":\"session_meta\"}\n").unwrap();
        assert_eq!(codex_task_active(&path).unwrap(), None);
    }

    #[test]
    fn codex_writer_lock_blocks_resume_even_when_that_window_is_idle() {
        let fixture = Fixture::new();
        let mut record = store::Store::open(&fixture.0, "writer-session", "writer-root", Provider::Codex, "title", "").unwrap();
        record.bind("native-thread".into()).unwrap();
        let locks = fixture.0.join("thread-writer-locks");
        fs::create_dir_all(&locks).unwrap();
        fs::write(locks.join(".coordination.lock"), []).unwrap();
        let path = locks.join("native-thread.lock");
        fs::write(&path, []).unwrap();
        // 文件留着不等于有人持锁：没进程握着就放行复用。
        assert!(!held_in(&fixture.0, "writer-session", "writer-root", &locks).unwrap());
        let (_guard, held) = writer_lock(&path).unwrap();
        // 另一个窗口只是开着这条会话、这一轮早跑完了：徽标是空闲，但 resume 会被 Codex 拒。
        assert!(held_in(&fixture.0, "writer-session", "writer-root", &locks).unwrap());
        drop(held);
        assert!(!held_in(&fixture.0, "writer-session", "writer-root", &locks).unwrap());
        // 还没原生 ID 的会话谈不上复用，也不该去猜 CODEX_HOME。
        store::Store::open(&fixture.0, "fresh-session", "fresh-root", Provider::Codex, "title", "").unwrap();
        assert!(!held_in(&fixture.0, "fresh-session", "fresh-root", &fixture.0.join("没有这个目录")).unwrap());
        // Claude 没有这份线程写锁，别拿它挡 Claude 的复用。
        let mut claude = store::Store::open(&fixture.0, "claude-session", "claude-root", Provider::Claude, "title", "").unwrap();
        claude.bind("native-thread".into()).unwrap();
        assert!(!held_in(&fixture.0, "claude-session", "claude-root", &locks).unwrap());
        // 交接锁正被占着时按「挡住」报，而不是把发送路径整个失败掉。
        let (_guard, coordinator) = writer_lock(&locks.join(".coordination.lock")).unwrap();
        assert!(held_in(&fixture.0, "writer-session", "writer-root", &locks).unwrap());
        drop(coordinator);
    }

    #[test]
    fn claude_matches_native_session_and_live_pid_excluding_own_process() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("101.json"), json!({"sessionId":"native","status":"busy","procStartFt":"123"}).to_string()).unwrap();
        fs::write(fixture.0.join("102.json"), json!({"sessionId":"other","status":"busy"}).to_string()).unwrap();
        fs::write(fixture.0.join("103.json"), "half-written").unwrap();
        let records = claude_records(&fixture.0).unwrap();
        assert!(claude_occupied(&records, "native", 0, |_,_| Ok(true)).unwrap());
        assert!(!claude_occupied(&records, "missing", 0, |_,_| panic!("不应查询其他会话进程")).unwrap());
        assert!(!claude_occupied(&records, "native", 101, |_,_| panic!("不应把自身算作外部进程")).unwrap());
        assert!(!claude_occupied(&records, "native", 0, |_,_| Ok(false)).unwrap());
        assert!(claude_occupied(&records, "native", 0, |_,_| Err("access denied".into())).is_err());
        assert!(!claude_occupied(&[(101, json!({"sessionId":"native","status":"idle"}))], "native", 0, |_,_| panic!("空闲窗口不是任务")).unwrap());
    }

    #[test]
    fn forge_activity_distinguishes_local_runs_other_windows_and_idle() {
        let fixture = Fixture::new();
        store::Store::open(&fixture.0, "activity-session", "activity-root", Provider::Codex, "title", "").unwrap();
        let (run, _) = registry::Run::reserve("activity-run".into(), "activity-session".into(), "activity-root".into(), "activity-root".into()).unwrap();
        assert_eq!(state(&fixture.0, "activity-session", "activity-root").unwrap(), State::Running);
        run.finish();
        let lease = store::Lease::acquire(&fixture.0.join("activity-session.lock")).unwrap();
        assert_eq!(state(&fixture.0, "activity-session", "activity-root").unwrap(), State::External);
        drop(lease);
        assert_eq!(state(&fixture.0, "activity-session", "activity-root").unwrap(), State::Idle);
        assert!(state(&fixture.0, "activity-session", "wrong-root").is_err());
    }

    /// 子代理展示父 Worker 维护的生命周期，但旧父回合不能被新回合复活。
    #[test]
    fn child_activity_tracks_parent_run_and_terminal_without_child_registry() {
        let fixture = Fixture::new();
        let mut parent = store::Store::open(&fixture.0, "agent-parent", "agent-root", Provider::Codex, "parent", "").unwrap();
        parent.append("agent-run", vec![("status".into(), json!({"status":"running"}))]).unwrap();
        let mut child = store::Store::open(&fixture.0, "agent-child", "agent-root", Provider::Codex, "child", "").unwrap();
        child.meta.parent_session_id = Some("agent-parent".into());
        child.meta.agent = Some(store::AgentInfo { tool_id: "agent".into(), status: "running".into(), ..Default::default() });
        child.save().unwrap();
        child.append("agent-run", vec![("agent".into(), json!({"key":"agent","sessionId":"agent-child","status":"running"}))]).unwrap();
        let (run, _) = registry::Run::reserve("agent-run".into(), "agent-parent".into(), "agent-root".into(), "agent-root".into()).unwrap();
        assert_eq!(state(&fixture.0, "agent-child", "agent-root").unwrap(), State::Running);
        assert!(registry::for_session("agent-child").is_none());
        child.append("native", vec![("agent".into(), json!({"key":"agent","sessionId":"agent-child","status":"completed"}))]).unwrap();
        assert_eq!(state(&fixture.0, "agent-child", "agent-root").unwrap(), State::Idle);
        child.append("old-run", vec![("agent".into(), json!({"key":"agent","sessionId":"agent-child","status":"running"}))]).unwrap();
        assert_eq!(state(&fixture.0, "agent-child", "agent-root").unwrap(), State::Idle);
        run.finish();
        parent.append("old-run", vec![("status".into(), json!({"status":"running"}))]).unwrap();
        let lease = store::Lease::acquire(&fixture.0.join("agent-parent.lock")).unwrap();
        assert_eq!(state(&fixture.0, "agent-child", "agent-root").unwrap(), State::External);
        parent.append("new-run", vec![("status".into(), json!({"status":"running"}))]).unwrap();
        assert_eq!(state(&fixture.0, "agent-child", "agent-root").unwrap(), State::Idle);
        let page = store::Store::page(&fixture.0, "agent-child", "agent-root", store::Window::Before(u64::MAX), 1, false).unwrap();
        assert_eq!(page.status.as_deref(), Some("cancelled"));
        assert!(page.active_tasks.is_empty());
        drop(lease);
        assert_eq!(state(&fixture.0, "agent-child", "agent-root").unwrap(), State::Idle);
    }

    #[test]
    #[cfg(windows)]
    fn claude_reused_pid_does_not_count_as_live_session_owner() {
        assert!(!process_matches(std::process::id(), &json!({"procStartFt":"1"})).unwrap());
        assert!(!process_matches(u32::MAX, &json!({"procStartFt":"1"})).unwrap());
    }
}
