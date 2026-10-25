//! 专用的有界 JSONL 传输层，与 CLI 安装时的输出捕获分开。
//! Dedicated bounded JSONL transport, separate from CLI installation capture.
use crate::ai_cli::process::ProcessTree;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{
    mpsc::{self, Receiver, SyncSender},
    Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::Duration;

/// stdout 单行上限。CLI 会一行吐一个 JSON，超大行通常意味着协议错乱或进程异常，
/// 到上限就断开而不是无限吃内存。正常事件只有几 KB，但工具结果整段回显可能很大，
/// 阈值取 16 MiB，与参考实现同一口径：太小会把合法的大结果当成协议错乱。
const MAX_READ: u64 = 16 * 1024 * 1024;

/// 出站单条上限。必须容得下界面允许发出的最大一次请求：`MAX_IMAGES` 张
/// `MAX_IMAGE_BYTES` 的图片内联成 base64。卡得更小，界面上允许贴的附件
/// 会在发送时才失败。
const MAX_WRITE: u64 =
    super::images::MAX_IMAGES as u64 * (super::images::MAX_IMAGE_BYTES as u64 / 3 * 4 + 8)
        + 1024 * 1024;

/// 从 CLI 读到的输入。把「解析成功」「正常结束」「出错」三种情况分开，
/// 消费方不必自己区分管道关闭与 JSON 损坏。
pub enum Input {
    /// 一行解析成功的 JSON 消息。
    Json(Value),
    /// 管道正常关闭（CLI 退出），不再有后续消息。
    Eof,
    /// 读取或解析失败，附带原因。
    Error(String),
}

/// 一个正在运行的 CLI 子进程及其管道。
///
/// 写入走单独线程 + 有界通道：调用方（UI 命令）不能被一个卡住的 stdin 阻塞，
/// 写失败也要能作为错误回到事件流里，而不是静默丢消息。
pub struct Process {
    /// 子进程句柄，退出时用它回收。
    child: Child,
    /// 进程树守卫；Drop 时连同子进程一起清掉，避免留下孤儿。
    tree: Option<ProcessTree>,
    /// 写入线程的投递端；None 表示写入线程已结束或尚未建立。
    writer: Option<SyncSender<Vec<u8>>>,
    /// 读取端：解析后的消息、EOF 与错误都从这里出来，供运行时循环消费。
    pub incoming: Receiver<Input>,
    /// stderr 的尾部内容，进程失败时拼进错误信息，方便定位。
    stderr: Arc<Mutex<Vec<u8>>>,
    /// 读写线程的句柄，Drop 时等待它们收尾，防止管道被提前关闭。
    threads: Vec<JoinHandle<()>>,
}
impl Process {
    pub fn id(&self) -> u32 { self.child.id() }
    pub fn spawn(mut command: Command, cwd: &str) -> Result<Self, String> {
        command
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
            .env("PATH", crate::lsp_probe::augmented_path())
            .env("DISABLE_AUTOUPDATER", "1");
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        crate::sys::hide_console(&mut command);
        let mut child = command.spawn().map_err(|e| format!("无法启动 CLI：{e}"))?;
        let tree = match ProcessTree::new(&child) {
            Ok(tree) => tree,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("无法隔离 CLI 进程树：{e}"));
            }
        };
        let stdin = child.stdin.take().ok_or("CLI 缺少 stdin")?;
        let stdout = child.stdout.take().ok_or("CLI 缺少 stdout")?;
        let stderr_pipe = child.stderr.take().ok_or("CLI 缺少 stderr")?;
        let (tx, incoming) = mpsc::sync_channel(64);
        let errors = tx.clone();
        let (writer, writes) = mpsc::sync_channel::<Vec<u8>>(32);
        let write_thread = std::thread::spawn(move || {
            let mut stdin = stdin;
            while let Ok(bytes) = writes.recv() {
                if let Err(e) = stdin.write_all(&bytes).and_then(|_| stdin.flush()) {
                    let _ = errors.send(Input::Error(format!("写入 CLI 失败：{e}")));
                    break;
                }
            }
        });
        let read_thread = std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_message(&mut reader) {
                    Ok(Some(value)) => {
                        if tx.send(Input::Json(value)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => {
                        let _ = tx.send(Input::Eof);
                        break;
                    }
                    Err(e) => {
                        let _ = tx.send(Input::Error(e));
                        break;
                    }
                }
            }
        });
        let stderr = Arc::new(Mutex::new(Vec::<u8>::new()));
        let tail = stderr.clone();
        let err_thread = std::thread::spawn(move || {
            let mut pipe = stderr_pipe;
            let mut buf = [0; 4096];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut tail = tail.lock().unwrap_or_else(|e| e.into_inner());
                tail.extend_from_slice(&buf[..n]);
                if tail.len() > 32 * 1024 {
                    let excess = tail.len() - 32 * 1024;
                    tail.drain(..excess);
                }
            }
        });
        Ok(Self {
            child,
            tree: Some(tree),
            writer: Some(writer),
            incoming,
            stderr,
            threads: vec![write_thread, read_thread, err_thread],
        })
    }
    pub fn write(&self, value: &Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_WRITE {
            return Err(format!("发送给 CLI 的消息过大（{} MiB 上限）", MAX_WRITE / (1024 * 1024)));
        }
        bytes.push(b'\n');
        self.writer
            .as_ref()
            .ok_or("CLI 输入已关闭")?
            .try_send(bytes)
            .map_err(|_| "CLI 输入阻塞或已关闭，停止本轮执行".into())
    }
    pub fn close_input(&mut self) {
        self.writer.take();
    }
    pub fn status(&mut self) -> Result<Option<ExitStatus>, String> {
        self.child.try_wait().map_err(|e| e.to_string())
    }
    pub fn diagnostics(&self) -> String {
        String::from_utf8_lossy(&self.stderr.lock().unwrap_or_else(|e| e.into_inner())).into_owned()
    }
    pub fn terminate(&mut self) {
        self.writer.take();
        self.tree.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        let (_, empty) = mpsc::sync_channel(1);
        self.incoming = empty;
        // 结束进程树会释放管道的写入端，理论上线程随即退出；仍给 join 设上限，
        // 以防第三方包装器逃出进程组把应用退出永久卡住。
        let start = std::time::Instant::now();
        while self.threads.iter().any(|h| !h.is_finished())
            && start.elapsed() < Duration::from_secs(2)
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        for thread in self.threads.drain(..) {
            if thread.is_finished() {
                let _ = thread.join();
            }
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        self.terminate();
    }
}
fn read_message(reader: &mut impl BufRead) -> Result<Option<Value>, String> {
    loop {
        let mut bytes = vec![];
        let n = reader
            .take(MAX_READ + 1)
            .read_until(b'\n', &mut bytes)
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(None);
        }
        if n as u64 > MAX_READ {
            return Err(format!("CLI 输出单行超出 {} MiB 上限", MAX_READ / (1024 * 1024)));
        }
        if bytes.last() != Some(&b'\n') {
            return Err("CLI 协议输出被截断".into());
        }
        if bytes.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        return serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("CLI 输出不是有效 JSON 协议：{e}"));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn json_unicode_and_bounded_frames() {
        let mut r = std::io::Cursor::new("\n{\"text\":\"中文😀\"}\n".as_bytes());
        assert_eq!(read_message(&mut r).unwrap().unwrap()["text"], "中文😀");
        assert!(read_message(&mut r).unwrap().is_none());
        assert!(read_message(&mut std::io::Cursor::new(b"{\"x\":1}")).is_err());
        assert!(
            read_message(&mut std::io::Cursor::new(vec![b'x'; MAX_READ as usize + 2])).is_err()
        );
    }
    #[test]
    fn real_pipes_round_trip_and_cleanup_without_model_calls() {
        #[cfg(windows)]
        let command = {
            let mut c = crate::ai_cli::process::powershell();
            c.args(["-Command","$s=[Console]::ReadLine(); [Console]::WriteLine($s); [Console]::Error.WriteLine('diagnostic')"]);
            c
        };
        #[cfg(unix)]
        let command = {
            let mut c = Command::new("/bin/sh");
            c.args([
                "-c",
                "IFS= read -r line; printf '%s\\n' \"$line\"; printf diagnostic >&2",
            ]);
            c
        };
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let mut p = Process::spawn(command, &cwd).unwrap();
        p.write(&serde_json::json!({"text":"中文😀"})).unwrap();
        match p.incoming.recv_timeout(Duration::from_secs(10)).unwrap() {
            Input::Json(v) => assert_eq!(v["text"], "中文😀"),
            _ => panic!("missing frame"),
        }
        p.terminate();
        assert!(p.status().unwrap().is_some());
    }
}
