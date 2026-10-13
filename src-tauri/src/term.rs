use base64::{engine::general_purpose::STANDARD, Engine as _};
use crate::error::{err, err_parts};
use crate::offload::{block, block_value};
use crate::sys::{env_path, env_raw, is_file, which};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock};
use std::thread;
use tauri::{AppHandle, Emitter};

/// 一次从读端取多少字节。取大一点才分得出「这一波还在涌」和「读空了」。
const READ_BYTES: usize = 64 * 1024;
/// 攒够这么多才发一次事件。满了还继续读，等于把一次构建的输出压成几十条事件而不是一千多条。
const FLUSH_BYTES: usize = 32 * 1024;

/// 一个活着的终端会话。reader 线程单独持有 PTY 读端，退出时把会话从表里摘掉。
///
/// 用 `Arc` 装着是因为写入端要先从表里把会话取出来、放开表锁，再去写那根可能堵住的管道；
/// 握着表锁写，shell 一旦不取数据，整张表连带所有终端命令一起卡死。
struct Session {
    /// `dyn MasterPty` 本身不是 `Sync`，套一层锁才进得了 `Arc`：
    /// 会话要能被写入口从表里取走，放开表锁之后再动那根可能堵住的管道。
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    /// 通知 reader 线程收尾。
    stop: mpsc::Sender<()>,
}

type Sessions = Mutex<HashMap<String, Arc<Session>>>;

fn sessions() -> &'static Sessions {
    static SESSIONS: OnceLock<Sessions> = OnceLock::new();
    SESSIONS.get_or_init(|| Sessions::new(HashMap::new()))
}

/// 锁被持有时另一侧线程 panic 也要继续干活，不能让终端整体卡死。
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 后端吐给 xterm.js 的一段原始字节：base64 装，避免 JSON 拆坏半个 UTF-8 序列。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermChunk {
    pub id: String,
    pub data: String,
}

/// 会话结束事件，前端据此收起对应的终端。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermExit {
    pub id: String,
    pub code: Option<u32>,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// 一个能起的 shell：真实路径、界面上的名字、起会话时附带的参数。
#[derive(Serialize)]
pub struct ShellInfo {
    pub path: String,
    pub name: String,
    pub args: Vec<String>,
}

/// 扫这台机器上装着的 shell。排在最前那条就是没另行设置时起的那个，界面拿它当默认值。
#[tauri::command]
pub async fn shell_probe() -> Vec<ShellInfo> {
    block_value(shell_probe_impl, Vec::new).await
}

fn shell_probe_impl() -> Vec<ShellInfo> {
    let mut found: Vec<ShellInfo> = Vec::new();
    if cfg!(windows) {
        let system32 = env_path("SystemRoot", "System32");
        let no_logo = ["-NoLogo".to_string()];
        // 优先使用高版本 PowerShell（8 → 7 → 6），均未安装时再回退到系统内置 PowerShell。
        for version in ["8", "7", "6"] {
            push_shell(
                &mut found,
                &format!("PowerShell {version}"),
                &env_path("ProgramFiles", &format!("PowerShell\\{version}\\pwsh.exe")),
                &no_logo,
            );
        }
        push_shell(
            &mut found,
            "PowerShell",
            &format!("{system32}\\WindowsPowerShell\\v1.0\\powershell.exe"),
            &no_logo,
        );
        push_shell(&mut found, "pwsh", &which("pwsh.exe"), &no_logo);
        push_shell(&mut found, "cmd", &env_raw("ComSpec"), &[]);
        // 装了 Git 就认它 bin 下那份，PATH 里那条 usr\bin\bash.exe 是同一个程序的另一个入口。
        let git_bash = env_path("ProgramFiles", "Git\\bin\\bash.exe");
        let bash = if is_file(&git_bash) { git_bash } else { which("bash.exe") };
        push_shell(&mut found, "Git Bash", &bash, &[]);
        push_shell(&mut found, "WSL", &format!("{system32}\\wsl.exe"), &[]);
    } else {
        push_shell(&mut found, "login shell", &std::env::var("SHELL").unwrap_or_default(), &[]);
        for (name, path) in [
            ("bash", "/bin/bash"),
            ("zsh", "/bin/zsh"),
            ("fish", "/usr/bin/fish"),
            ("sh", "/bin/sh"),
        ] {
            push_shell(&mut found, name, path, &[]);
        }
    }
    found
}

/// 存在才列出来，同一路径不重复列。
fn push_shell(list: &mut Vec<ShellInfo>, name: &str, path: &str, args: &[String]) {
    if !is_file(path) || list.iter().any(|item| item.path == path) {
        return;
    }
    list.push(ShellInfo {
        path: path.to_string(),
        name: name.to_string(),
        args: args.to_vec(),
    });
}

/// 起会话用的 shell：设置里选了就用扫出来的那条（连参数一起），没选就用排在第一的。
fn resolve_shell(configured: Option<String>) -> (String, Vec<String>) {
    let shells = shell_probe_impl();
    let wanted = configured.unwrap_or_default().trim().to_string();
    if !wanted.is_empty() {
        if let Some(hit) = shells.iter().find(|item| item.path == wanted) {
            return (hit.path.clone(), hit.args.clone());
        }
        return (wanted, Vec::new());
    }
    match shells.first() {
        Some(first) => (first.path.clone(), first.args.clone()),
        None => ("powershell.exe".to_string(), Vec::new()),
    }
}

/// 起一个终端会话，返回会话 id。cwd 为空时落在进程当前目录。
#[tauri::command]
pub async fn term_open(
    app: AppHandle,
    cwd: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    block(move || term_open_impl(app, cwd, shell, cols, rows)).await
}

fn term_open_impl(
    app: AppHandle,
    cwd: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|error| err("TERM_OPEN", error))?;

    let (program, args) = resolve_shell(shell);
    let mut command = CommandBuilder::new(&program);
    for arg in &args {
        command.arg(arg);
    }
    command.env("TERM", "xterm-256color");
    if let Some(dir) = cwd.filter(|dir| !dir.is_empty()) {
        command.cwd(dir);
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| err_parts("SPAWN", &[program.clone(), error.to_string()]))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| err("TERM_OPEN", error))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| err("TERM_OPEN", error))?;

    let id = format!("term-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    let thread_id = id.clone();
    let (stop, stop_rx) = mpsc::channel::<()>();
    lock(sessions()).insert(
        id.clone(),
        Arc::new(Session {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            stop,
        }),
    );

    thread::spawn(move || read_loop(reader, stop_rx, app, thread_id));
    Ok(id)
}

/// 读端一路转发到前端；读到 EOF（shell 退出）就摘会话并发退出事件。
///
/// 攒着发：一次 `cargo build` 每秒能出上千小段输出，一段发一条事件的话，
/// serde 序列化加 webview 投递的开销比字节本身还大，读线程的吞吐就被 IPC 卡住。
/// 攒的边界用「这一趟没读满缓冲区」判——读满了说明后面还在涌，没读满说明眼下已经空了，
/// 这时候立刻发，交互回显一点延迟都不多付。
fn read_loop(
    mut reader: Box<dyn Read + Send>,
    stop_rx: mpsc::Receiver<()>,
    app: AppHandle,
    id: String,
) {
    let mut buffer = vec![0u8; READ_BYTES];
    let mut pending: Vec<u8> = Vec::with_capacity(FLUSH_BYTES);
    let mut encoded = String::new();
    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }
        let count = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        pending.extend_from_slice(&buffer[..count]);
        if pending.len() >= FLUSH_BYTES || count < buffer.len() {
            flush(&app, &id, &mut pending, &mut encoded);
        }
    }
    flush(&app, &id, &mut pending, &mut encoded);

    let code = lock(sessions())
        .remove(&id)
        .and_then(|session| lock(&session.child).try_wait().ok().flatten())
        .map(|status| status.exit_code());
    let _ = app.emit("term://exit", TermExit { id, code });
}

/// 把攒下的字节编成一条事件发出去；两个缓冲区都复用，不在每段上现分配。
fn flush(app: &AppHandle, id: &str, pending: &mut Vec<u8>, encoded: &mut String) {
    if pending.is_empty() {
        return;
    }
    encoded.clear();
    STANDARD.encode_string(pending.as_slice(), encoded);
    let _ = app.emit(
        "term://output",
        TermChunk {
            id: id.to_string(),
            data: std::mem::take(encoded),
        },
    );
    pending.clear();
}

/// 键盘输入原样写进 PTY，行编辑交给 shell 自己做。
///
/// 先把会话从表里取出来、放开表锁再去写：shell 卡住不取数据时这根管道会堵，
/// 握着表锁堵在这儿，别的终端命令连「关掉会话」都做不了。
#[tauri::command]
pub async fn term_write(id: String, data: String) -> Result<(), String> {
    block(move || {
        let session = lock(sessions())
            .get(&id)
            .cloned()
            .ok_or_else(|| err("TERM_GONE", &id))?;
        let written = lock(&session.writer)
            .write_all(data.as_bytes())
            .map_err(|error| err("TERM_IO", error));
        written
    })
    .await
}

#[tauri::command]
pub async fn term_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    block(move || {
        let session = lock(sessions())
            .get(&id)
            .cloned()
            .ok_or_else(|| err("TERM_GONE", &id))?;
        let resized = lock(&session.master)
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| err("TERM_IO", error));
        resized
    })
    .await
}

/// 先杀进程再摘会话；reader 线程随后补发退出事件。
#[tauri::command]
pub async fn term_close(id: String) -> Result<(), String> {
    block(move || {
        close_one(&id);
        Ok(())
    })
    .await
}

fn close_one(id: &str) {
    if let Some(session) = lock(sessions()).remove(id) {
        let _ = session.stop.send(());
        let _ = lock(&session.child).kill();
    }
}

/// 页面重载时来不及发 `term_close`，旧 shell 就这么留在表里。
/// 新页面一开头调一次，把上一回剩的全收掉。
#[tauri::command]
pub async fn term_reap() {
    block_value(reap_impl, || {}).await
}

fn reap_impl() {
    let stale: Vec<String> = lock(sessions()).keys().cloned().collect();
    for id in stale {
        close_one(&id);
    }
}

/// 应用退出前把还开着的终端 shell 全关掉。
///
/// 必须是同步函数——退出路径上没有 async runtime 来服务 `term_reap`。
/// 会话从表里摘掉后 ConPTY 随之关闭，shell 不留孤儿。
pub fn reap_all_for_exit() {
    reap_impl();
}
