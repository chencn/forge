//! 有界输出、超时和子进程树清理；只供 AI CLI 管理的固定命令使用。
use crate::sys::hide_console;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// 单条命令留存的输出上限。npm 出错时会刷出很长的日志，这里只留尾部：
/// 界面要展示的是失败原因，不是完整流水账。
const OUTPUT_LIMIT: usize = 32 * 1024;

/// 一次命令执行的结果。`success` 由退出码决定，与是否解析出内容无关。
pub struct Output {
    /// 进程是否以 0 退出；非 0 也可能已经产生了有效输出。
    pub success: bool,
    /// 退出码；被信号终止时没有退出码，为 None。
    pub code: Option<i32>,
    /// 标准输出，已截断为最后 `OUTPUT_LIMIT` 字节。
    pub stdout: String,
    /// 标准错误，同样只保留尾部；npm 的失败原因通常在这里。
    pub stderr: String,
}
impl Output {
    /// 把两路输出拼成一段可展示的文本，空行裁掉。
    pub fn text(&self) -> String {
        format!("{}\n{}", self.stdout.trim(), self.stderr.trim()).trim().to_string()
    }
}

/// 起一个线程把管道读干，只保留最后 `OUTPUT_LIMIT` 字节。
///
/// 必须读到 EOF 才退出：调用方要等子进程退出后才放手，管道里残留的数据没人收就会把子进程卡死。
/// 读完发一个信号，让 `run` 知道输出已经收全，不必靠 sleep 猜。
fn capture(pipe: impl Read + Send + 'static, done: mpsc::Sender<()>, mode: Truncation) -> Arc<Mutex<Vec<u8>>> {
    let tail = Arc::new(Mutex::new(Vec::new()));
    let result = tail.clone();
    std::thread::spawn(move || {
        let mut pipe = pipe;
        let mut buffer = [0; 4096];
        while let Ok(count) = pipe.read(&mut buffer) {
            if count == 0 { break; }
            let mut bytes = tail.lock().unwrap_or_else(|e| e.into_inner());
            bytes.extend_from_slice(&buffer[..count]);
            if matches!(mode, Truncation::Tail) && bytes.len() > OUTPUT_LIMIT {
                let excess = bytes.len() - OUTPUT_LIMIT;
                bytes.drain(..excess);
            }
        }
        let _ = done.send(());
    });
    result
}

/// Windows 上用 Job Object 把子进程树圈住：句柄一关，整棵树跟着结束。
///
/// npm 会再拉起 node，只杀直接子进程会留下孤儿。`KILL_ON_JOB_CLOSE` 让清理变成
/// 「关句柄」这一个动作，Drop 里不需要再枚举进程。
#[cfg(windows)]
pub(crate) struct ProcessTree(windows::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl ProcessTree {
    pub(crate) fn new(child: &Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::*;
        unsafe {
            let job = Self(CreateJobObjectW(None, None).map_err(|e| e.to_string())?);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(job.0, JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&limits) as u32).map_err(|e| e.to_string())?;
            AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle())).map_err(|e| e.to_string())?;
            Ok(job)
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) { unsafe { let _ = windows::Win32::Foundation::CloseHandle(self.0); } }
}
/// Unix 上没有 Job Object，改为把子进程放进独立进程组，Drop 时按进程组发 SIGKILL。
#[cfg(unix)]
pub(crate) struct ProcessTree(u32);
#[cfg(unix)]
impl ProcessTree {
    pub(crate) fn new(child: &Child) -> Result<Self, String> { Ok(Self(child.id())) }
}
#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) { unsafe { libc::kill(-(self.0 as i32), libc::SIGKILL); } }
}

/// 跑一条命令并收全输出，超时则连同子进程树一起杀掉。
///
/// 几个不显眼但必要的约定：
/// - `DISABLE_AUTOUPDATER` / `CI` 压掉 CLI 自己的自更新和交互提示，否则输出会被更新横幅污染；
/// - 超时判定放在轮询循环里而不是外层 timer，保证「超时」这个错误能带上已经收到的输出；
/// - 清掉进程树后管道理应关闭，但仍给每次读取设上限，不让第三方工具把应用永久挂住。
pub fn run(command: Command, timeout: Duration) -> Result<Output, String> {
    run_with(command, timeout, Truncation::Tail)
}

/// 输出收集策略：短命令只留尾部；`codex debug models` 这类要整份解析的大输出必须全量。
pub enum Truncation { Tail, Full }

pub fn run_with(mut command: Command, timeout: Duration, mode: Truncation) -> Result<Output, String> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.env("PATH", crate::lsp_probe::augmented_path());
    command.env("DISABLE_AUTOUPDATER", "1").env("CI", "1");
    #[cfg(unix)]
    { use std::os::unix::process::CommandExt; command.process_group(0); }
    hide_console(&mut command);
    let mut child = command.spawn().map_err(|e| format!("无法启动命令：{e}"))?;
    let tree = match ProcessTree::new(&child) {
        Ok(tree) => tree,
        Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(format!("无法隔离安装进程：{error}")); }
    };
    let (done, receiver) = mpsc::channel();
    let stdout = capture(child.stdout.take().unwrap(), done.clone(), mode);
    let stderr = capture(child.stderr.take().unwrap(), done, Truncation::Tail);
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Err(error) => break Err(error.to_string()),
            Ok(None) if start.elapsed() >= timeout => break Err(format!("命令执行超时（{} 秒），已终止子进程树", timeout.as_secs())),
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
        }
    };
    drop(tree);
    if status.is_err() { let _ = child.kill(); let _ = child.wait(); }
    // 清理树后管道应关闭；仍设上限，不让第三方工具永久阻塞应用。
    for _ in 0..2 { let _ = receiver.recv_timeout(Duration::from_secs(2)); }
    let decode = |value: Arc<Mutex<Vec<u8>>>| String::from_utf8_lossy(&value.lock().unwrap_or_else(|e| e.into_inner())).into_owned();
    let stdout = decode(stdout);
    let stderr = decode(stderr);
    let status = status.map_err(|error| format!("{error}\n{stdout}\n{stderr}"))?;
    Ok(Output { success: status.success(), code: status.code(), stdout, stderr })
}

/// 用于「只需要知道成不成功」的短命令（版本探测、npm prefix 等），统一 20 秒上限。
pub fn checked(command: Command) -> Result<String, String> {
    let result = run(command, Duration::from_secs(20))?;
    if result.success { Ok(result.stdout.trim().to_string()) }
    else { Err(format!("命令失败（{:?}）：{}", result.code, result.text())) }
}

/// 需要整份 stdout 的命令（如 `codex debug models`，原始输出可达数百 KB）：
/// 走不截断通道，超时放宽到 60 秒覆盖 CLI 冷启动。
pub fn checked_full(command: Command) -> Result<String, String> {
    let result = run_with(command, Duration::from_secs(60), Truncation::Full)?;
    if result.success { Ok(result.stdout.trim().to_string()) }
    else { Err(format!("命令失败（{:?}）：{}", result.code, result.text())) }
}

/// npm 的 Windows .cmd 启动器不能直接交给 CreateProcess；使用固定 PowerShell
/// 脚本及环境变量传参，不拼接路径/包版本成可执行脚本文本。
pub fn command(path: &std::path::Path, args: &[&str]) -> Command {
    #[cfg(windows)]
    if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat") || ext.eq_ignore_ascii_case("ps1")) {
        let mut command = powershell();
        let mut script = String::from("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; & $env:FORGE_AI_PROGRAM");
        for index in 0..args.len() {
            script.push_str(&format!(" $env:FORGE_AI_ARG_{index}"));
            command.env(format!("FORGE_AI_ARG_{index}"), args[index]);
        }
        script.push_str("; exit $LASTEXITCODE");
        command.args(["-Command", &script]).env("FORGE_AI_PROGRAM", path);
        return command;
    }
    let mut command = Command::new(path);
    command.args(args);
    command
}

#[cfg(windows)]
/// 系统自带的 Windows PowerShell，固定绝对路径，不依赖 PATH 里的同名程序。
pub fn powershell() -> Command {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let mut command = Command::new(std::path::PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe"));
    command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(windows_script: &str, unix_script: &str) -> Command {
        #[cfg(windows)]
        {
            let _ = unix_script;
            let mut cmd = powershell();
            cmd.args(["-Command", windows_script]);
            cmd
        }
        #[cfg(unix)]
        {
            let _ = windows_script;
            let mut cmd = Command::new("/bin/sh");
            cmd.args(["-c", unix_script]);
            cmd
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_launcher_preserves_utf8_and_exit_code() {
        let path = std::env::temp_dir().join(format!("forge-ai-utf8-{}.ps1", std::process::id()));
        std::fs::write(&path, "[Console]::WriteLine(([string][char]0x4e2d)+[char]0x6587); [Console]::Error.WriteLine(([string][char]0x5931)+[char]0x8d25); exit 7").unwrap();
        let result = run(command(&path, &[]), Duration::from_secs(20));
        let _ = std::fs::remove_file(path);
        let output = result.unwrap();
        assert_eq!(output.stdout.trim(), "中文");
        assert_eq!(output.stderr.trim(), "失败");
        assert_eq!(output.code, Some(7));
        assert!(!output.success);
    }

    #[test]
    fn captures_output_and_nonzero_exit() {
        let output = run(script(
            "[Console]::Out.Write('out'); [Console]::Error.Write('err'); exit 7",
            "printf out; printf err >&2; exit 7",
        ), Duration::from_secs(20)).unwrap();
        assert!(!output.success);
        assert_eq!(output.code, Some(7));
        assert_eq!(output.stdout, "out");
        assert_eq!(output.stderr, "err");
    }

    #[test]
    fn retains_only_bounded_output_tail() {
        let (done, receiver) = mpsc::channel();
        let mut data = vec![b'x'; OUTPUT_LIMIT * 3];
        data.extend_from_slice(b"END");
        let bytes = capture(std::io::Cursor::new(data), done, Truncation::Tail);
        receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        let bytes = bytes.lock().unwrap();
        assert_eq!(bytes.len(), OUTPUT_LIMIT);
        assert!(bytes.ends_with(b"END"));
    }

    #[test]
    fn timeout_returns_without_waiting_for_command_completion() {
        let start = Instant::now();
        let result = run(script("Start-Sleep -Seconds 30", "sleep 30"), Duration::from_millis(100));
        assert!(result.err().unwrap().contains("超时"));
        assert!(start.elapsed() < Duration::from_secs(10));
    }
}
