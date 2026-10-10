use base64::{engine::general_purpose::STANDARD, Engine as _};
use crate::error::{err, err_parts};
use crate::offload::block;
use crate::run::EnvVar;
use crate::sys::hide_console;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// 一次从管道取多少字节；读满了说明后面还在涌，没读满说明眼下已经空了。
const READ_BYTES: usize = 64 * 1024;
/// 攒够这么多才发一次事件。一段一发时，一次构建能出上千条 IPC，开销全在序列化与投递上。
const FLUSH_BYTES: usize = 32 * 1024;

/// 一个跑着的构建 / 运行进程。输出靠事件转发，退出码由轮询取回。
///
/// 用 `Arc` 装着：`proc_kill` 要先把条目从表里取出来、放开表锁，再去等 `taskkill`；
/// 握着表杀进程，别的会话连「查状态」都做不了。
struct Running {
    child: Mutex<Child>,
    stop: mpsc::Sender<()>,
}

type Table = Mutex<HashMap<String, Arc<Running>>>;

fn table() -> &'static Table {
    static TABLE: OnceLock<Table> = OnceLock::new();
    TABLE.get_or_init(|| Table::new(HashMap::new()))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 一段进程输出，base64 装原始字节。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcChunk {
    pub id: String,
    pub data: String,
}

/// 进程结束事件。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcExit {
    pub id: String,
    /// 退出码；被强杀或取不到时为 null。
    pub code: Option<i32>,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// 用系统 shell 跑一行命令：Windows 走 cmd /C，其余走 sh -c。
fn shell_command(line: &str) -> (String, Vec<String>) {
    if cfg!(windows) {
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        (comspec, vec!["/D".to_string(), "/C".to_string(), line.to_string()])
    } else {
        ("/bin/sh".to_string(), vec!["-c".to_string(), line.to_string()])
    }
}

/// 读一路输出直到 EOF，边读边发给前端；读到头时通知等待方这一路收干净了。
fn pump(
    mut pipe: impl Read + Send + 'static,
    app: AppHandle,
    id: String,
    done: mpsc::Sender<()>,
) {
    let mut buffer = vec![0u8; READ_BYTES];
    let mut pending: Vec<u8> = Vec::with_capacity(FLUSH_BYTES);
    let mut encoded = String::new();
    loop {
        let count = match pipe.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        pending.extend_from_slice(&buffer[..count]);
        if pending.len() >= FLUSH_BYTES || count < buffer.len() {
            flush(&app, &id, &mut pending, &mut encoded);
        }
    }
    flush(&app, &id, &mut pending, &mut encoded);
    let _ = done.send(());
}

/// 把攒下的字节编成一条事件发出去；两个缓冲区都复用，不在每段上现分配。
fn flush(app: &AppHandle, id: &str, pending: &mut Vec<u8>, encoded: &mut String) {
    if pending.is_empty() {
        return;
    }
    encoded.clear();
    STANDARD.encode_string(pending.as_slice(), encoded);
    let _ = app.emit(
        "proc://output",
        ProcChunk {
            id: id.to_string(),
            data: std::mem::take(encoded),
        },
    );
    pending.clear();
}

/// 跑一行命令，返回进程会话 id；输出走 proc://output，退出走 proc://exit。
///
/// `env` 是这条配置自带的变量，叠在本进程的环境之上（IDEA 里 pass-parent-envs 默认开着，
/// 这里同样不清空父环境）。同名变量以这一份为准。
#[tauri::command]
pub async fn proc_start(
    app: AppHandle,
    cwd: String,
    line: String,
    env: Vec<EnvVar>,
) -> Result<String, String> {
    block(move || proc_start_impl(app, cwd, line, env)).await
}

fn proc_start_impl(
    app: AppHandle,
    cwd: String,
    line: String,
    env: Vec<EnvVar>,
) -> Result<String, String> {
    if line.trim().is_empty() {
        return Err(err("NO_COMMAND", ""));
    }
    let (program, args) = shell_command(line.trim());
    let mut command = Command::new(&program);
    command
        .args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for item in &env {
        if !item.name.trim().is_empty() {
            command.env(&item.name, &item.value);
        }
    }
    hide_console(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| err_parts("SPAWN", &[program.clone(), error.to_string()]))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let id = format!("proc-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    let (stop, stop_rx) = mpsc::channel::<()>();
    let (done_tx, done_rx) = mpsc::channel::<()>();
    lock(table()).insert(
        id.clone(),
        Arc::new(Running {
            child: Mutex::new(child),
            stop,
        }),
    );

    if let Some(pipe) = stderr {
        let thread_id = id.clone();
        let stderr_app = app.clone();
        let done = done_tx.clone();
        thread::spawn(move || pump(pipe, stderr_app, thread_id, done));
    }
    if let Some(pipe) = stdout {
        let thread_id = id.clone();
        let stdout_app = app.clone();
        thread::spawn(move || pump(pipe, stdout_app, thread_id, done_tx));
    }
    // 退出事件不能等 stdout 关完：被终止的进程常把管道留给没死透的子进程，
    // 那样点「停止」要等到整棵进程树自己跑完才反馈回界面。
    let waiter_id = id.clone();
    thread::spawn(move || wait_and_finish(app, waiter_id, stop_rx, done_rx));
    Ok(id)
}

/// 正常退出后给两路管道各留一点收尾时间（上限 `DRAIN_GRACE`），让最后一批输出先进缓冲，
/// 再发退出事件；主动停止时不等，那本来就是要掐断的。
const DRAIN_GRACE: Duration = Duration::from_millis(400);

/// 轮询退出码：stdout 关掉基本等于进程收尾，最多再等一会儿。
///
/// 条目一开头就取出来留着，之后只碰它自己那把子进程锁——每 80 ms 抢一次全表锁，
/// 几个会话同时在跑时会互相排队，还把 `proc_start` 也一起堵住。
fn wait_and_finish(
    app: AppHandle,
    id: String,
    stop_rx: mpsc::Receiver<()>,
    done_rx: mpsc::Receiver<()>,
) {
    let running = lock(table()).get(&id).cloned();
    let mut killed = false;
    let code = match running {
        None => None,
        Some(running) => loop {
            if let Ok(Some(status)) = lock(&running.child).try_wait() {
                break status.code();
            }
            if stop_rx.try_recv().is_ok() {
                killed = true;
                break None;
            }
            thread::sleep(Duration::from_millis(80));
        },
    };
    if !killed {
        let deadline = Instant::now() + DRAIN_GRACE;
        for _ in 0..2 {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() || done_rx.recv_timeout(left).is_err() {
                break;
            }
        }
    }
    let _ = lock(table()).remove(&id);
    let _ = app.emit("proc://exit", ProcExit { id, code });
}

#[tauri::command]
pub async fn proc_kill(id: String) -> Result<(), String> {
    block(move || {
        let Some(running) = lock(table()).get(&id).cloned() else {
            return Ok(());
        };
        let _ = running.stop.send(());
        let pid = lock(&running.child).id().to_string();
        // cmd /C 只是壳，杀它会把真正的子进程留在后台继续占着输出管道。
        #[cfg(windows)]
        {
            let mut killer = Command::new("taskkill");
            killer.args(["/F", "/T", "/PID", pid.as_str()]);
            hide_console(&mut killer);
            let _ = killer.output();
        }
        #[cfg(not(windows))]
        {
            let _ = pid;
        }
        let _ = lock(&running.child).kill();
        Ok(())
    })
    .await
}
