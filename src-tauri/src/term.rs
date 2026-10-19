use base64::{engine::general_purpose::STANDARD, Engine as _};
use crate::error::{err, err_parts};
use crate::offload::{block, block_value};
use crate::sys::{env_path, env_raw, is_file, which};
use crate::term_long_input::{self, LongInputShell};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::thread;
use tauri::{AppHandle, Emitter};

/// 一次从读端取多少字节。取大一点才分得出「这一波还在涌」和「读空了」。
const READ_BYTES: usize = 64 * 1024;
/// 攒够这么多才发一次事件。满了还继续读，等于把一次构建的输出压成几十条事件而不是一千多条。
const FLUSH_BYTES: usize = 32 * 1024;

/// 前端来不及画时让 reader 线程停在下一次 `read` 之前。
///
/// 停住之后 PTY 管道写满，shell 自己的写入被阻塞，输出就不会在 webview 里越堆越多。
#[derive(Default)]
struct ReaderGate {
    paused: Mutex<bool>,
    resumed: Condvar,
}

impl ReaderGate {
    fn set_paused(&self, paused: bool) {
        let mut current = lock(&self.paused);
        *current = paused;
        if !paused {
            self.resumed.notify_all();
        }
    }

    fn wait_until_resumed(&self) {
        let mut paused = lock(&self.paused);
        while *paused {
            paused = self.resumed.wait(paused).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

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
    gate: Arc<ReaderGate>,
    /// cmd / PowerShell 会话才有：超长命令要改道成临时脚本。
    long_input: Option<LongInputShell>,
    /// 改道写出的临时脚本，会话结束时删。PowerShell 那份执行完自己删，cmd 的留到这里。
    scripts: Mutex<Vec<PathBuf>>,
}

impl Session {
    fn remove_scripts(&self) {
        for path in lock(&self.scripts).drain(..) {
            let _ = std::fs::remove_file(path);
        }
    }
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

/// 一个能起的 shell。
///
/// `id` 是写回设置、页签记着的那个值。多数 shell 就是可执行文件路径；
/// WSL 的每个发行版共用同一个 `wsl.exe`，所以写成 `wsl:<发行版>`。
#[derive(Serialize, Clone)]
pub struct ShellInfo {
    pub id: String,
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
        let login = ["--login".to_string(), "-i".to_string()];
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
        // 不退回 PATH 上的裸 bash.exe：System32 里那个是 WSL 的入口，不是 Git Bash。
        push_shell(&mut found, "Git Bash", &env_path("ProgramFiles", "Git\\bin\\bash.exe"), &login);
        push_shell(&mut found, "nu", &which("nu.exe"), &[]);
        for (name, root, bash, marker) in posix_roots() {
            if is_file(&format!("{root}\\{marker}")) {
                push_shell(&mut found, name, &format!("{root}\\{bash}"), &login);
            }
        }
        let wsl = format!("{system32}\\wsl.exe");
        push_shell(&mut found, "WSL", &wsl, &[]);
        if is_file(&wsl) {
            for distro in wsl_distributions() {
                push_shell_as(
                    &mut found,
                    &format!("wsl:{distro}"),
                    &format!("WSL: {distro}"),
                    &wsl,
                    &["--distribution".to_string(), distro.clone()],
                );
            }
        }
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

/// MSYS2 和 Cygwin 常见的安装位置：名字、根目录、bash 的相对路径、认它用的标记文件。
fn posix_roots() -> Vec<(&'static str, String, &'static str, &'static str)> {
    let drive = env_raw("SystemDrive");
    let drive = if drive.is_empty() { "C:".to_string() } else { drive };
    let mut roots = Vec::new();
    for dir in ["msys64", "msys32"] {
        roots.push(("MSYS2 Bash", format!("{drive}\\{dir}"), "usr\\bin\\bash.exe", "msys2_shell.cmd"));
    }
    for dir in ["cygwin64", "cygwin"] {
        roots.push(("Cygwin Bash", format!("{drive}\\{dir}"), "bin\\bash.exe", "bin\\cygwin1.dll"));
    }
    roots
}

/// 注册表里登记过的 WSL 发行版。只读登记信息：打开 shell 菜单不该把虚拟机拉起来。
#[cfg(windows)]
fn wsl_distributions() -> Vec<String> {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
        RRF_RT_REG_SZ,
    };
    let mut names = Vec::new();
    unsafe {
        let mut key = HKEY::default();
        let root = HSTRING::from(r"Software\Microsoft\Windows\CurrentVersion\Lxss");
        if RegOpenKeyExW(HKEY_CURRENT_USER, &root, None, KEY_READ, &mut key).0 != 0 {
            return names;
        }
        for index in 0..256u32 {
            let mut sub = [0u16; 256];
            let mut sub_len = sub.len() as u32;
            let status = RegEnumKeyExW(
                key,
                index,
                Some(PWSTR(sub.as_mut_ptr())),
                &mut sub_len,
                None,
                None,
                None,
                None,
            );
            if status.0 != 0 {
                break;
            }
            let sub_key = HSTRING::from_wide(&sub[..sub_len as usize]);
            let mut buf = [0u16; 256];
            let mut size = (buf.len() * 2) as u32;
            let read = RegGetValueW(
                key,
                &sub_key,
                &HSTRING::from("DistributionName"),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut size),
            );
            if read.0 != 0 {
                continue;
            }
            let units: Vec<u16> = buf.iter().copied().take_while(|unit| *unit != 0).collect();
            if let Ok(name) = String::from_utf16(&units) {
                names.push(name);
            }
        }
        let _ = RegCloseKey(key);
    }
    keep_user_distributions(names)
}

#[cfg(not(windows))]
fn wsl_distributions() -> Vec<String> {
    Vec::new()
}

/// Docker Desktop、Rancher Desktop 自带的服务发行版进不了交互 shell，不列。
fn keep_user_distributions(mut names: Vec<String>) -> Vec<String> {
    names.retain(|name| {
        !name.trim().is_empty()
            && !name.starts_with("docker-desktop")
            && !name.starts_with("rancher-desktop")
    });
    names.sort();
    names.dedup();
    names
}

/// 存在才列出来，同一路径不重复列。
fn push_shell(list: &mut Vec<ShellInfo>, name: &str, path: &str, args: &[String]) {
    push_shell_as(list, path, name, path, args);
}

fn push_shell_as(list: &mut Vec<ShellInfo>, id: &str, name: &str, path: &str, args: &[String]) {
    if !is_file(path) || list.iter().any(|item| item.id == id) {
        return;
    }
    list.push(ShellInfo {
        id: id.to_string(),
        path: path.to_string(),
        name: name.to_string(),
        args: args.to_vec(),
    });
}

/// 起会话用的 shell：设置里选了就用扫出来的那条（连参数一起），没选就用排在第一的。
///
/// 先按 id 认，再按路径认：老设置里存的是路径，多数 shell 的 id 也就是路径。
fn resolve_shell(configured: Option<String>) -> (String, Vec<String>) {
    let shells = shell_probe_impl();
    let wanted = configured.unwrap_or_default().trim().to_string();
    if !wanted.is_empty() {
        if let Some(hit) = shells
            .iter()
            .find(|item| item.id == wanted)
            .or_else(|| shells.iter().find(|item| item.path == wanted))
        {
            return (hit.path.clone(), hit.args.clone());
        }
        return (wanted, Vec::new());
    }
    match shells.first() {
        Some(first) => (first.path.clone(), first.args.clone()),
        None => ("powershell.exe".to_string(), Vec::new()),
    }
}

fn executable_name(program: &str) -> String {
    program.rsplit(['/', '\\']).next().unwrap_or(program).to_ascii_lowercase()
}

/// 外层终端留在环境里的身份标记。shell 和 CLI 据此判断「我在哪个终端里」，带过来就认错了宿主。
const INHERITED_MARKERS: &[&str] = &["WT_SESSION", "WT_PROFILE_ID", "TERM_SESSION_ID", "VTE_VERSION", "TMUX", "TMUX_PANE"];
const INHERITED_MARKER_PREFIXES: &[&str] = &["KITTY_", "GHOSTTY_", "WEZTERM_", "ITERM_"];

fn is_inherited_marker(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    INHERITED_MARKERS.contains(&upper.as_str())
        || INHERITED_MARKER_PREFIXES.iter().any(|prefix| upper.starts_with(prefix))
}

/// 起 shell 前补环境：声明真彩色与终端身份，摘掉外层终端的标记和强制关色的开关。
fn apply_environment(command: &mut CommandBuilder, program: &str) {
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "forge");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    command.env("CLICOLOR", "1");
    for (key, _) in std::env::vars_os() {
        if is_inherited_marker(&key.to_string_lossy()) {
            command.env_remove(&key);
        }
    }
    // 从别的终端里启动 Forge 时这几个会跟进来，整个终端从此没有颜色或被迫上色。
    for key in ["NO_COLOR", "FORCE_COLOR", "CLICOLOR_FORCE"] {
        command.env_remove(key);
    }
    if cfg!(windows) {
        if std::env::var_os("HOME").is_none() {
            if let Some(profile) = std::env::var_os("USERPROFILE") {
                command.env("HOME", profile);
            }
        }
        // Git Bash / MSYS2 / Cygwin 的登录 shell 默认会 cd 到家目录，这个变量让它留在起始目录。
        if executable_name(program) == "bash.exe" {
            command.env("CHERE_INVOKING", "1");
        }
    }
}

/// 配置档带来的额外启动参数与环境变量。
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TermLaunch {
    /// 追加在 shell 自带参数后面。
    pub args: Vec<String>,
    /// 覆盖或新增的环境变量；值为空串表示把这个变量摘掉。
    pub env: HashMap<String, String>,
}

/// 起一个终端会话，返回会话 id。cwd 为空时落在进程当前目录。
#[tauri::command]
pub async fn term_open(
    app: AppHandle,
    cwd: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    launch: Option<TermLaunch>,
) -> Result<String, String> {
    block(move || term_open_impl(app, cwd, shell, cols, rows, launch.unwrap_or_default())).await
}

fn term_open_impl(
    app: AppHandle,
    cwd: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    launch: TermLaunch,
) -> Result<String, String> {
    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|error| err("TERM_OPEN", error))?;

    let (program, args) = resolve_shell(shell);
    let mut command = CommandBuilder::new(&program);
    for arg in args.iter().chain(launch.args.iter()) {
        command.arg(arg);
    }
    apply_environment(&mut command, &program);
    for (key, value) in &launch.env {
        if key.is_empty() || key.contains('=') {
            continue;
        }
        if value.is_empty() {
            command.env_remove(key);
        } else {
            command.env(key, value);
        }
    }
    if let Some(dir) = cwd.filter(|dir| !dir.is_empty()) {
        // wsl.exe 不认进程的工作目录，要显式告诉它落在哪。
        if executable_name(&program) == "wsl.exe" {
            command.arg("--cd");
            command.arg(&dir);
        }
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
    let gate = Arc::new(ReaderGate::default());
    let thread_gate = gate.clone();
    let long_input = if cfg!(windows) { term_long_input::shell_kind(&program) } else { None };
    lock(sessions()).insert(
        id.clone(),
        Arc::new(Session {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            stop,
            gate,
            long_input,
            scripts: Mutex::new(Vec::new()),
        }),
    );

    thread::spawn(move || read_loop(reader, stop_rx, thread_gate, app, thread_id));
    Ok(id)
}

/// 读端一路转发到前端；读到 EOF（shell 退出）就摘会话并发退出事件。
///
/// 攒着发：一次 `cargo build` 每秒能出上千小段输出，一段发一条事件的话，
/// serde 序列化加 webview 投递的开销比字节本身还大，读线程的吞吐就被 IPC 卡住。
/// 攒的边界用「这一趟没读满缓冲区」判——读满了说明后面还在涌，没读满说明眼下已经空了，
/// 这时候立刻发，交互回显一点延迟都不多付。读满必然超过 `FLUSH_BYTES`，
/// 所以停在闸门前时手里不会压着没发的字节。
fn read_loop(
    mut reader: Box<dyn Read + Send>,
    stop_rx: mpsc::Receiver<()>,
    gate: Arc<ReaderGate>,
    app: AppHandle,
    id: String,
) {
    let mut buffer = vec![0u8; READ_BYTES];
    let mut pending: Vec<u8> = Vec::with_capacity(FLUSH_BYTES);
    let mut encoded = String::new();
    loop {
        gate.wait_until_resumed();
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

    // 还在表里说明是 shell 自己退的：读端 EOF 时进程多半已经结束，等它交出退出码。
    // 被 `term_close` 收掉的那条已经摘走了，码是 null。
    let removed = lock(sessions()).remove(&id);
    let code = removed.and_then(|session| {
        session.remove_scripts();
        let mut child = lock(&session.child);
        let status = child.try_wait().ok().flatten().or_else(|| child.wait().ok());
        status.map(|status| status.exit_code())
    });
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

fn session_of(id: &str) -> Result<Arc<Session>, String> {
    lock(sessions())
        .get(id)
        .cloned()
        .ok_or_else(|| err("TERM_GONE", id))
}

fn write_bytes(session: &Session, data: &[u8]) -> Result<(), String> {
    let mut writer = lock(&session.writer);
    writer
        .write_all(data)
        .and_then(|_| writer.flush())
        .map_err(|error| err("TERM_IO", error))
}

/// 键盘输入原样写进 PTY，行编辑交给 shell 自己做。
///
/// 先把会话从表里取出来、放开表锁再去写：shell 卡住不取数据时这根管道会堵，
/// 握着表锁堵在这儿，别的终端命令连「关掉会话」都做不了。
#[tauri::command]
pub async fn term_write(id: String, data: String) -> Result<(), String> {
    block(move || {
        let session = session_of(&id)?;
        let Some(shell) = session.long_input else {
            return write_bytes(&session, data.as_bytes());
        };
        match term_long_input::prepare(shell, &data, &std::env::temp_dir())? {
            None => write_bytes(&session, data.as_bytes()),
            Some((invocation, script)) => {
                let written = write_bytes(&session, invocation.as_bytes());
                if written.is_err() {
                    let _ = std::fs::remove_file(&script);
                } else {
                    lock(&session.scripts).push(script);
                }
                written
            }
        }
    })
    .await
}

/// 不是 UTF-8 的输入原样写进 PTY：鼠标上报的老式编码里有大于 127 的单字节。
#[tauri::command]
pub async fn term_write_bytes(id: String, data: Vec<u8>) -> Result<(), String> {
    block(move || write_bytes(&*session_of(&id)?, &data)).await
}

/// 前端画不过来时停读，追上之后再放开。
#[tauri::command]
pub async fn term_set_paused(id: String, paused: bool) -> Result<(), String> {
    block(move || {
        session_of(&id)?.gate.set_paused(paused);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn term_resize(
    id: String,
    cols: u16,
    rows: u16,
    pixel_width: Option<u16>,
    pixel_height: Option<u16>,
) -> Result<(), String> {
    block(move || {
        let session = session_of(&id)?;
        let resized = lock(&session.master)
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: pixel_width.unwrap_or(0),
                pixel_height: pixel_height.unwrap_or(0),
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
        // 停在闸门前的 reader 线程要先放开，才看得到停止信号。
        session.gate.set_paused(false);
        let _ = lock(&session.child).kill();
        session.remove_scripts();
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

/// Windows 构建号。xterm 用它决定 ConPTY 的换行补救开不开。
#[tauri::command]
pub fn term_windows_build() -> Option<u32> {
    windows_build_number()
}

#[cfg(windows)]
fn windows_build_number() -> Option<u32> {
    #[repr(C)]
    struct OsVersionInfoExW {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        csd_version: [u16; 128],
        service_pack_major: u16,
        service_pack_minor: u16,
        suite_mask: u16,
        product_type: u8,
        reserved: u8,
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut OsVersionInfoExW) -> i32;
    }

    let mut info = unsafe { std::mem::zeroed::<OsVersionInfoExW>() };
    info.size = std::mem::size_of::<OsVersionInfoExW>() as u32;
    let status = unsafe { RtlGetVersion(&mut info) };
    if status < 0 { None } else { Some(info.build) }
}

#[cfg(not(windows))]
fn windows_build_number() -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn service_distributions_are_hidden_and_names_are_unique() {
        let names = keep_user_distributions(
            ["Ubuntu", "Debian", "Ubuntu", "", "docker-desktop", "rancher-desktop-data"]
                .map(str::to_string)
                .to_vec(),
        );
        assert_eq!(names, ["Debian", "Ubuntu"]);
    }

    #[test]
    fn outer_terminal_markers_are_recognized() {
        assert!(is_inherited_marker("WT_SESSION"));
        assert!(is_inherited_marker("wezterm_pane"));
        assert!(!is_inherited_marker("PATH"));
    }

    #[test]
    fn reader_gate_blocks_until_resumed() {
        let gate = Arc::new(ReaderGate::default());
        gate.set_paused(true);
        let worker_gate = gate.clone();
        let (sender, receiver) = mpsc::channel();
        let worker = thread::spawn(move || {
            worker_gate.wait_until_resumed();
            sender.send(()).unwrap();
        });
        assert!(receiver.recv_timeout(Duration::from_millis(30)).is_err());
        gate.set_paused(false);
        assert!(receiver.recv_timeout(Duration::from_secs(1)).is_ok());
        worker.join().unwrap();
    }
}
