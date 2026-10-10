//! LSP 语言服务进程通道。
//!
//! 和 `proc.rs` / `term.rs` 是三条不同的通道，刻意不合并：
//! `proc.rs` 跑一行命令、输出单向；`term.rs` 是 PTY，会做 CR/LF 转换与回显；这一条是**普通管道上的
//! 双向字节流**，按 LSP 的 `Content-Length` 分帧。PTY 那套会把协议帧冲烂，所以这里不能借 `term.rs`。

use crate::error::{err, err_parts};
use crate::lsp_probe;
use crate::offload::{block, block_value};
use crate::sys::hide_console;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// 一次从 server stdout 取多少字节。索引期的诊断会成坨来，缓冲区大一点才分得出「还在涌」。
const READ_BYTES: usize = 64 * 1024;

/// 一个活着的语言服务会话。stdout 由读线程单独持有，stdin 留在这里给 `lsp_write` 写。
///
/// 会话身份就是表里的键：`窗口::server::工程根`。同一个键第二次请求不会重复起进程。
struct Session {
    server: String,
    root: String,
    window: String,
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    /// 通知读线程收尾。
    stop: mpsc::Sender<()>,
    /// 最后一次读写的时刻（unix 毫秒），空闲回收与 LRU 淘汰都读它。
    last_used_ms: AtomicU64,
}

type Sessions = Mutex<HashMap<String, Arc<Session>>>;

fn sessions() -> &'static Sessions {
    static TABLE: OnceLock<Sessions> = OnceLock::new();
    TABLE.get_or_init(|| Sessions::new(HashMap::new()))
}

/// 正在起进程的键。第二个请求要等同一个结果，不能并排 spawn 两份。
type Starting = (Mutex<HashMap<String, ()>>, Condvar);

fn starting() -> &'static Starting {
    static PAIR: OnceLock<Starting> = OnceLock::new();
    PAIR.get_or_init(|| (Mutex::new(HashMap::new()), Condvar::new()))
}

/// 起不来过的会话：连续失败次数与下次允许重试的时刻。
#[derive(Clone)]
struct Failure {
    count: u32,
    retry_at: Instant,
    message: String,
}

type Failures = Mutex<HashMap<String, Failure>>;

fn failures() -> &'static Failures {
    static TABLE: OnceLock<Failures> = OnceLock::new();
    TABLE.get_or_init(|| Failures::new(HashMap::new()))
}

/// 连续重启上限。超过之后不再自动起，等人在状态里手动重试。
const RESTART_LIMIT: u32 = 2;

/// 退避时长：5 秒起，每次翻倍，封顶 5 分钟。
fn backoff(count: u32) -> Duration {
    let seconds = 5u64.saturating_mul(1u64 << count.saturating_sub(1).min(6));
    Duration::from_secs(seconds.min(300))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

/// 锁被持有时另一侧线程 panic 也要继续干活，不能让语言服务整体卡死。
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 一条从 server 来的 LSP 消息，`body` 是去掉 `Content-Length` 头之后的 JSON 文本。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspMessage {
    pub id: String,
    pub body: String,
}

/// server 写到 stderr 的一段文字（日志、报错），按行转发，给界面一个能看的地方。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspLog {
    pub id: String,
    pub text: String,
}

/// 会话结束事件。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspExit {
    pub id: String,
    pub code: Option<i32>,
}

/// 一个会话的状态快照，给底部状态条那段和设置页用。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub id: String,
    pub server: String,
    pub root: String,
    pub window: String,
    /// `running` 进程在；`exited` 进程自己走了；`dead` 起不来、已被摘掉。
    pub status: String,
    /// 连续失败次数，退避就按它算。
    pub restart_count: u32,
    /// 最后一次读写的 unix 毫秒。
    pub last_used_ms: u64,
    /// 异常说明；`running` 时是 null。
    pub error: Option<String>,
}

/// 把一个程序名解析成可执行的完整路径。探测与 spawn 共用这一条候选顺序。
///
/// Windows 上必须先挑 `.cmd` / `.exe`：npm 装的 CLI 在 `nodejs` 目录下同时有 `foo`
/// （无扩展名的 sh 脚本）、`foo.cmd`、`foo.ps1` 三份，先命中 sh 脚本会报 os error 193。
/// 候选顺序、PATH 补齐、`.ps1` 兜底这些都在 `lsp_probe` 里，两处共用一份，
/// 不会出现「界面报没装着、spawn 却能起来」的分叉。
fn resolve_program(program: &str) -> Option<String> {
    lsp_probe::resolve_command(program)
}

/// 把参数文本拆成一段段。空白分隔，双引号里的整段算一个（引号本身去掉）。
///
/// 少数 server 的参数带空格（`-configuration /path/with space`），所以要有引号规则。
/// 只认双引号，不做反斜杠转义——路径里出现双引号的情形不存在，多一层转义规则只会让用户猜不透。
fn parse_args(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut has_token = false;
    for character in text.chars() {
        match character {
            '"' => {
                quoted = !quoted;
                has_token = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has_token {
                    out.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        out.push(current);
    }
    out
}

/// Windows 上 `.cmd` / `.bat` 垫片不能直接 CreateProcess，要经 `cmd /C` 起。
fn build_command(resolved: &str, args: &[String]) -> Command {
    let lowered = resolved.to_ascii_lowercase();
    if cfg!(windows) && (lowered.ends_with(".cmd") || lowered.ends_with(".bat")) {
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut command = Command::new(comspec);
        command.arg("/D").arg("/C").arg(resolved);
        command.args(args);
        command
    } else {
        let mut command = Command::new(resolved);
        command.args(args);
        command
    }
}

/// 会话身份：窗口 + server + 工程根。同一条的第二、第三次请求拿到同一个 id，不会重复起进程。
fn session_id(window: &str, server: &str, root: &str) -> String {
    format!("{window}::{server}::{root}")
}

/// 占到这个键的启动权，并在拿到之后负责叫醒等待者。
///
/// 同键并发只 spawn 一份：后来者在这里等，等完回到调用处再查一次会话表。
/// 等待带超时兜底，占位那一路 panic 也不会把键永久钉住。
fn wait_for_starting(id: &str) {
    let (guard, condvar) = &*starting();
    let held = lock(guard);
    // 30 秒远大于一次 spawn 的耗时；真等这么久说明占位者已经没了。
    if let Ok((held, _)) =
        condvar.wait_timeout_while(held, Duration::from_secs(30), |map| map.contains_key(id))
    {
        drop(held);
    }
}

fn begin_starting(id: &str) -> bool {
    let (guard, _) = &*starting();
    let mut map = lock(guard);
    if map.contains_key(id) {
        return false;
    }
    map.insert(id.to_string(), ());
    true
}

fn end_starting(id: &str) {
    let (guard, condvar) = &*starting();
    if let Some(mut map) = guard.lock().ok() {
        map.remove(id);
    }
    condvar.notify_all();
}

/// 退避期内不允许再自动起，返回那条错误；没在退避就返回 None。
fn backoff_error(id: &str) -> Option<String> {
    let guard = lock(failures());
    let failure = guard.get(id)?;
    let now = Instant::now();
    if failure.retry_at > now {
        let wait = failure.retry_at.duration_since(now).as_millis().to_string();
        return Some(err_parts(
            "LSP_START_BACKOFF",
            &vec![wait, failure.message.clone()],
        ));
    }
    if failure.count > RESTART_LIMIT {
        return Some(err_parts(
            "LSP_START_LIMIT",
            &vec![failure.count.to_string(), failure.message.clone()],
        ));
    }
    None
}

/// 记一次起不来：次数加一，下次允许重试的时刻按翻倍退避算。
fn record_failure(id: &str, message: &str) {
    let mut guard = lock(failures());
    let next = guard.get(id).map(|failure| failure.count + 1).unwrap_or(1);
    guard.insert(
        id.to_string(),
        Failure {
            count: next,
            retry_at: Instant::now() + backoff(next),
            message: message.to_string(),
        },
    );
}

/// 起会话前先按配置清一遍：空闲超时的收掉，总数顶到上限就按最近最少用淘汰。
///
/// 这一步放在起之前而不是单独跑定时器：会话只在有人用的时候才需要腾位置。
fn sweep(app: &AppHandle) {
    let config = crate::lsp_config::load(app);
    let idle = Duration::from_secs(config.idle_timeout_min.saturating_mul(60));
    let now = now_ms();
    let stale: Vec<String> = {
        let guard = lock(sessions());
        guard
            .iter()
            .filter(|(_, session)| {
                now.saturating_sub(session.last_used_ms.load(Ordering::Relaxed))
                    > idle.as_millis() as u64
            })
            .map(|(id, _)| id.clone())
            .collect()
    };
    for id in &stale {
        stop_one(id);
    }
    // 上限淘汰：连空闲那些都收完还是满的，就摘最久没用的一条。
    loop {
        let victim = {
            let guard = lock(sessions());
            if guard.len() < config.max_sessions.max(1) {
                None
            } else {
                guard
                    .iter()
                    .min_by_key(|(_, session)| session.last_used_ms.load(Ordering::Relaxed))
                    .map(|(id, _)| id.clone())
            }
        };
        match victim {
            Some(id) => stop_one(&id),
            None => break,
        }
    }
}

/// 起一个语言服务会话，返回会话 id。
///
/// `server` 是配置里的键，只用来拼会话身份；`program` / `args` / `root` 由前端按配置算好传进来，
/// 免得两处各读一遍配置读出口径。找不到可执行文件回 `LSP_NOT_FOUND`，前端据此降级。
/// 退避期内回 `LSP_START_BACKOFF`（第二段是还能重试的毫秒数），连续失败超上限回 `LSP_START_LIMIT`。
#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    window: String,
    server: String,
    root: String,
    program: String,
    args: String,
) -> Result<String, String> {
    block(move || {
        lsp_start_impl(app, window, server, root, program, args)
    })
    .await
}

fn lsp_start_impl(
    app: AppHandle,
    window: String,
    server: String,
    root: String,
    program: String,
    args: String,
) -> Result<String, String> {
    let id = session_id(&window, &server, &root);
    loop {
        if lock(sessions()).contains_key(&id) {
            return Ok(id);
        }
        if let Some(message) = backoff_error(&id) {
            return Err(message);
        }
        if !begin_starting(&id) {
            wait_for_starting(&id);
            continue;
        }
        let outcome = spawn_session(&app, &id, &window, &server, &root, &program, &args);
        end_starting(&id);
        return outcome;
    }
}

/// 占到位之后的那一段：解析命令、起进程、挂两条读线程、进表。
fn spawn_session(
    app: &AppHandle,
    id: &str,
    window: &str,
    server: &str,
    root: &str,
    program: &str,
    args: &str,
) -> Result<String, String> {
    sweep(app);
    let Some(resolved) = resolve_program(program) else {
        let message = format!("没找到 {program}");
        record_failure(id, &message);
        return Err(err("LSP_NOT_FOUND", program));
    };

    let mut command = build_command(&resolved, &parse_args(args));
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // GUI 进程继承的是登录时那份 PATH 快照，装完 rustup / npm 全局包再起的目录对它不可见。
        .env("PATH", lsp_probe::augmented_path())
        // 从 VS Code / Cursor 系编辑器的集成终端启动时，终端会往环境里注入 Node 调试变量：
        // `NODE_OPTIONS` 里挂 `--require .../ms-vscode.js-debug/.../bootloader.js`，外加一条
        // `VSCODE_INSPECTOR_OPTIONS`。语言服务是我们自己拉起的子进程，不是用户的调试目标，
        // 继承这两个变量会让 Node 写的 server（typescript-language-server 这类）加载 bootloader
        // 后挂在调试等待上，永远不回 `initialize`；前端握手超时再把它当崩溃杀掉，界面就只剩
        // 「语言服务已退出」。这两条只服务于「调试被启动的 Node 进程」，语言服务用不到，摘掉。
        .env_remove("NODE_OPTIONS")
        .env_remove("VSCODE_INSPECTOR_OPTIONS");
    if !root.is_empty() {
        command.current_dir(root);
    }
    hide_console(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = format!("{resolved}: {error}");
            record_failure(id, &message);
            return Err(err_parts("LSP_SPAWN", &[resolved, error.to_string()]));
        }
    };
    let stdin = child.stdin.take().ok_or_else(|| err("LSP_IO", "stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| err("LSP_IO", "stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| err("LSP_IO", "stderr"))?;

    let (stop, stop_rx) = mpsc::channel::<()>();
    let session = Arc::new(Session {
        server: server.to_string(),
        root: root.to_string(),
        window: window.to_string(),
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        stop,
        last_used_ms: AtomicU64::new(now_ms()),
    });
    lock(sessions()).insert(id.to_string(), session);
    // 起成功就把失败记录清掉，退避只针对连着起不动的那几个。
    lock(failures()).remove(id);

    let out_id = id.to_string();
    let out_app = app.clone();
    thread::spawn(move || read_loop(stdout, stop_rx, out_app, out_id));

    let err_id = id.to_string();
    let err_app = app.clone();
    thread::spawn(move || stderr_loop(stderr, err_app, err_id));

    Ok(id.to_string())
}

/// 按 `Content-Length` 分帧读 stdout。每凑齐一条完整消息就发一条事件。
fn read_loop(mut reader: impl Read, stop_rx: mpsc::Receiver<()>, app: AppHandle, id: String) {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; READ_BYTES];
    // 已经取走的前缀长度。逐条 `drain` 会把剩下的整段搬一遍，
    // rust-analyzer 索引期一趟能塞进几千条帧，那就是几千次 memmove。
    let mut consumed = 0usize;
    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                buffer.extend_from_slice(&chunk[..count]);
                while let Some((next, body)) = take_message(&buffer, consumed) {
                    consumed = next;
                    let _ = app.emit("lsp://message", LspMessage { id: id.clone(), body });
                }
                if consumed > 0 {
                    buffer.drain(..consumed);
                    consumed = 0;
                }
            }
        }
    }

    let removed = lock(sessions()).remove(&id);
    let code = removed
        .as_ref()
        .and_then(|session| lock(&session.child).try_wait().ok().flatten())
        .and_then(|status| status.code());
    if removed.is_some() {
        // 表里还挂着这条，说明不是我们主动停的（主动停会先从表里摘掉）：
        // 进程自己走了，记一次失败，让下一次起按退避来，而不是被反复敲。
        let message = match code {
            Some(code) => format!("进程退出，代码 {code}"),
            None => "进程退出".to_string(),
        };
        record_failure(&id, &message);
    }
    let _ = app.emit("lsp://exit", LspExit { id, code });
}

/// stderr 要有人读，否则管道缓冲满了 server 会卡住；内容按行发出去当日志。
fn stderr_loop(mut reader: impl Read, app: AppHandle, id: String) {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                buffer.extend_from_slice(&chunk[..count]);
                while let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=index).collect();
                    let text = String::from_utf8_lossy(&line).trim_end().to_string();
                    if !text.is_empty() {
                        let _ = app.emit("lsp://log", LspLog { id: id.clone(), text });
                    }
                }
            }
        }
    }
}

/// 从缓冲的 `from` 处取一条完整消息，返回「这条占到哪儿」和 JSON 正文。
/// 不足一条时返回 None 且不动缓冲。
///
/// LSP 帧头是若干 `Key: Value\r\n`，以一个空行结束，随后是 `Content-Length` 个字节的 UTF-8 body。
/// 规范要求键名大小写不敏感（例如 Content-Length: 与 content-length: 均合法）。
fn take_message(buffer: &[u8], from: usize) -> Option<(usize, String)> {
    let mut offset = from;
    loop {
        let rest = &buffer[offset..];
        let header_end = find(rest, b"\r\n\r\n")?;
        let header = String::from_utf8_lossy(&rest[..header_end]);
        let mut length: Option<usize> = None;
        for line in header.split("\r\n") {
            if let Some((k, v)) = line.trim().split_once(':') {
                if k.trim().eq_ignore_ascii_case("content-length") {
                    length = v.trim().parse::<usize>().ok();
                }
            }
        }
        let Some(length) = length else {
            // 没有有效 Content-Length 的损坏帧头，跳过该段继续向后寻找有效帧，防止缓冲区死循环膨胀
            offset += header_end + 4;
            continue;
        };
        let start = offset + header_end + 4;
        let end = start + length;
        if buffer.len() < end {
            return None;
        }
        let body = String::from_utf8_lossy(&buffer[start..end]).into_owned();
        return Some((end, body));
    }
}

/// 在字节串里找一段子串第一次出现的位置。
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

/// 发一条消息给 server。`body` 是 JSON 文本，这里补上 `Content-Length` 头再写。
///
/// 分帧放后端做，是因为 `Content-Length` 要的是字节数，前端算 UTF-8 字节长度容易错。
#[tauri::command]
pub async fn lsp_write(id: String, body: String) -> Result<(), String> {
    block(move || {
        // 先把会话取出来、放开表锁再写：server 正在重索引时这根管道会堵，
        // 握着表锁堵在这儿，别的会话连查状态、起停都做不了。
        let session = lock(sessions())
            .get(&id)
            .cloned()
            .ok_or_else(|| err("LSP_GONE", &id))?;
        // 每条发出去的消息都算「用过」，空闲回收与上限淘汰读的就是这个时刻。
        session.last_used_ms.store(now_ms(), Ordering::Relaxed);
        let frame = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
        let written = lock(&session.stdin)
            .write_all(frame.as_bytes())
            .map_err(|error| err("LSP_IO", error));
        written
    })
    .await
}

/// 先杀进程再摘会话；读线程随后补发退出事件。
#[tauri::command]
pub async fn lsp_stop(id: String) -> Result<(), String> {
    block(move || {
        stop_one(&id);
        Ok(())
    })
    .await
}

fn stop_one(id: &str) {
    if let Some(session) = lock(sessions()).remove(id) {
        let _ = session.stop.send(());
        let pid = lock(&session.child).id().to_string();
        // 语言服务常带子进程（rust-analyzer 起 rustc、gopls 起编译器），杀壳不管用，要杀整棵树。
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
        let _ = lock(&session.child).kill();
    }
}

/// 页面重载时来不及发 `lsp_stop`，旧进程就这么留在表里。新页面一开头调一次，把上一回剩的全收掉。
#[tauri::command]
pub async fn lsp_reap() {
    block_value(reap_impl, || {}).await
}

fn reap_impl() {
    let stale: Vec<String> = lock(sessions()).keys().cloned().collect();
    // 一棵树一次 `taskkill`，几棵同时收就是几百毫秒；这是启动路径，别排着来。
    std::thread::scope(|scope| {
        for id in &stale {
            scope.spawn(move || stop_one(id));
        }
    });
}

/// 会话状态快照。只读表和非阻塞 `try_wait`，不起进程也不收进程，界面轮询它就够。
///
/// 采到 `running` 只代表进程还活着，不代表服务器已经把工程索引完。
/// 锁被占住时不阻塞调用方：报 `running` 并附一句「本轮没采到进程状态」。
#[tauri::command]
pub async fn lsp_session_statuses(window: Option<String>) -> Vec<SessionStatus> {
    block_value(move || session_statuses_impl(window), Vec::new).await
}

fn session_statuses_impl(window: Option<String>) -> Vec<SessionStatus> {
    let filter = window.map(|name| name.trim().to_string()).filter(|name| !name.is_empty());
    let handles: Vec<(String, Arc<Session>)> = lock(sessions())
        .iter()
        .filter(|(_, session)| {
            filter.as_deref().map_or(true, |name| session.window == name)
        })
        .map(|(id, session)| (id.clone(), session.clone()))
        .collect();
    // 活着的会话 id 先收成集合：下面要从失败记录里挑出「没留下会话的那些」，
    // 用 Vec::contains 逐条比是平方量级，而失败记录在装了一堆语言服务的机器上能有大几十条。
    let alive: HashSet<String> = handles.iter().map(|(id, _)| id.clone()).collect();

    let mut out: Vec<SessionStatus> = Vec::with_capacity(handles.len());
    for (id, session) in handles {
        let (status, error) = match session.child.try_lock() {
            Ok(mut child) => match child.try_wait() {
                Ok(Some(exit)) => (
                    "exited",
                    Some(format!("进程退出，代码 {}", exit.code().unwrap_or(-1))),
                ),
                Ok(None) => ("running", None),
                Err(error) => ("dead", Some(error.to_string())),
            },
            Err(_) => (
                "running",
                Some("会话正被占用，本轮没采到进程状态".to_string()),
            ),
        };
        // 逐条在锁里查，不整份 clone：绝大多数轮次失败记录是空的，clone 纯属白抄。
        let failure = lock(failures()).get(&id).cloned();
        let restart_count = failure.as_ref().map(|failure| failure.count).unwrap_or(0);
        let error = match failure {
            Some(failure) if status != "running" => Some(format!(
                "{status}：起不来 {count} 次，{retry}：{message}",
                status = status,
                count = failure.count,
                retry = retry_hint(failure.retry_at),
                message = merge_detail(error.as_deref(), &failure.message)
            )),
            _ => error,
        };
        out.push(SessionStatus {
            id,
            server: session.server.clone(),
            root: session.root.clone(),
            window: session.window.clone(),
            status: status.to_string(),
            restart_count,
            last_used_ms: session.last_used_ms.load(Ordering::Relaxed),
            error,
        });
    }

    // 起不来又没留下会话的那些：进程从没成功起来，只能从失败记录里合成一条。
    let extras: Vec<(String, Failure)> = {
        let recorded = lock(failures());
        if recorded.is_empty() {
            Vec::new()
        } else {
            recorded
                .iter()
                .filter(|(id, _)| !alive.contains(id.as_str()))
                .map(|(id, failure)| (id.clone(), failure.clone()))
                .collect()
        }
    };
    for (id, failure) in extras {
        if let Some(name) = filter.as_deref() {
            if !id.starts_with(&format!("{name}::")) {
                continue;
            }
        }
        let mut parts = id.splitn(3, "::");
        let window = parts.next().unwrap_or_default().to_string();
        let server = parts.next().unwrap_or_default().to_string();
        let root = parts.next().unwrap_or_default().to_string();
        out.push(SessionStatus {
            id,
            server,
            root,
            window,
            status: "dead".to_string(),
            restart_count: failure.count,
            last_used_ms: 0,
            error: Some(format!(
                "起不来 {count} 次，{retry}：{message}",
                count = failure.count,
                retry = retry_hint(failure.retry_at),
                message = failure.message
            )),
        });
    }
    out.sort_by(|a, b| a.server.cmp(&b.server).then(a.root.cmp(&b.root)));
    out
}

/// 前端报一次起不来（握手超时之类），让它进同一套退避记账。
#[tauri::command]
pub async fn lsp_failed(id: String, message: String) {
    block_value(
        move || record_failure(&id, message.trim()),
        || {},
    )
    .await
}

/// 手动重试：清掉失败记录并收干净残留，下一次 `lsp_start` 立刻能再起。
#[tauri::command]
pub async fn lsp_retry(id: String) {
    block_value(
        move || {
            stop_one(&id);
            lock(failures()).remove(&id);
        },
        || {},
    )
    .await
}

/// 退避还剩多久。给界面的错误串里带上绝对时刻，前端不用自己估。
fn retry_hint(retry_at: Instant) -> String {
    let now = Instant::now();
    let ms = if retry_at > now {
        retry_at.duration_since(now).as_millis()
    } else {
        0
    };
    let epoch = now_ms() + ms as u64;
    format!("{ms} 毫秒后可重试（{epoch}）")
}

/// 两条说明拼一条，空的那条不参与。
fn merge_detail(first: Option<&str>, second: &str) -> String {
    match first {
        Some(text) if !text.trim().is_empty() => format!("{text}；{second}"),
        _ => second.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{find, parse_args, take_message};

    /// 空白分隔的普通参数。
    #[test]
    fn parses_plain_args() {
        assert_eq!(parse_args("--stdio"), vec!["--stdio"]);
        assert_eq!(parse_args("--stdio --log-level 4"), vec!["--stdio", "--log-level", "4"]);
    }

    /// 空文本拆出空表，不是一条空参数。
    #[test]
    fn empty_text_yields_no_args() {
        assert!(parse_args("").is_empty());
        assert!(parse_args("   ").is_empty());
    }

    /// 双引号里的空格算同一个参数，引号本身去掉。
    #[test]
    fn quoted_segment_keeps_spaces() {
        assert_eq!(
            parse_args("-configuration \"/opt/jdt/config dir\""),
            vec!["-configuration", "/opt/jdt/config dir"]
        );
    }

    /// 空引号是一段空参数，不是「没有参数」。
    #[test]
    fn empty_quotes_yield_empty_arg() {
        assert_eq!(parse_args("\"\""), vec![""]);
    }

    /// 照读线程那样连着取：返回取到的正文与游标停在哪儿。
    fn take_all(buffer: &[u8]) -> (Vec<String>, usize) {
        let mut bodies = Vec::new();
        let mut consumed = 0usize;
        while let Some((next, body)) = take_message(buffer, consumed) {
            consumed = next;
            bodies.push(body);
        }
        (bodies, consumed)
    }

    /// 一条完整的帧要被原样取出来，游标停在帧尾。
    #[test]
    fn takes_one_complete_frame() {
        let buffer = b"Content-Length: 11\r\n\r\n{\"a\":\"bcd\"}";
        let (bodies, consumed) = take_all(buffer);
        assert_eq!(bodies, vec!["{\"a\":\"bcd\"}".to_string()]);
        assert_eq!(consumed, buffer.len());
    }

    /// 两条帧连在一起时要能一条条取干净。
    #[test]
    fn takes_two_frames_in_sequence() {
        let buffer = b"Content-Length: 2\r\n\r\n[]Content-Length: 2\r\n\r\n{}";
        let (bodies, consumed) = take_all(buffer);
        assert_eq!(bodies, vec!["[]".to_string(), "{}".to_string()]);
        assert_eq!(consumed, buffer.len());
    }

    /// body 没到齐时不能取，游标也不能前进——头要留着等下一趟。
    #[test]
    fn waits_for_incomplete_body() {
        let buffer = b"Content-Length: 10\r\n\r\nshort";
        let (bodies, consumed) = take_all(buffer);
        assert!(bodies.is_empty());
        assert_eq!(consumed, 0);
    }

    /// 头还没收全时也要等，不能误判成一条空消息。
    #[test]
    fn waits_for_incomplete_header() {
        let buffer = b"Content-Length: 5\r\n";
        let (bodies, consumed) = take_all(buffer);
        assert!(bodies.is_empty());
        assert_eq!(consumed, 0);
    }

    /// body 里带 `\r\n\r\n` 不能被当成新的帧头；长度以 `Content-Length` 为准。
    #[test]
    fn body_containing_crlf_is_intact() {
        let payload = "{\r\n\r\n\"x\": 1}";
        let buffer = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload).into_bytes();
        let (bodies, _) = take_all(&buffer);
        assert_eq!(bodies, vec![payload.to_string()]);
    }

    /// 多字节字符按字节数算，不能被字符数带偏。
    #[test]
    fn counts_bytes_not_chars() {
        let payload = "{\"x\":\"中文\"}";
        let buffer = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload).into_bytes();
        let (bodies, consumed) = take_all(&buffer);
        assert_eq!(bodies, vec![payload.to_string()]);
        assert_eq!(consumed, buffer.len());
    }

    #[test]
    fn find_locates_separator() {
        assert_eq!(find(b"abc\r\n\r\nxyz", b"\r\n\r\n"), Some(3));
        assert_eq!(find(b"headersonly", b"\r\n\r\n"), None);
    }

    #[test]
    fn takes_frame_with_lowercase_content_length() {
        let buffer = b"content-length: 11\r\n\r\n{\"a\":\"bcd\"}";
        let (bodies, consumed) = take_all(buffer);
        assert_eq!(bodies, vec!["{\"a\":\"bcd\"}".to_string()]);
        assert_eq!(consumed, buffer.len());
    }

    #[test]
    fn skips_malformed_header_without_content_length() {
        let buffer = b"Stray text\r\n\r\nContent-Length: 2\r\n\r\n{}";
        let (bodies, consumed) = take_all(buffer);
        assert_eq!(bodies, vec!["{}".to_string()]);
        assert_eq!(consumed, buffer.len());
    }
}
