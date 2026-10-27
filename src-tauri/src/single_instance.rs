//! 单实例管理与进程间命令行参数转发。
//!
//! 当用户在系统文件资源管理器右键打开文件或重复启动应用时，
//! 如果已有 Forge 实例在运行，新启动的进程会将待打开的路径通过 Windows 命名管道
//! 发送给正在运行的主实例并在已有窗口中打开，随后新进程立即退出，避免重复创建窗口和黑窗。

#![allow(unused_variables)]

#[cfg(windows)]
mod imp {
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::AppHandle;
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows::Win32::Storage::FileSystem::{
        ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
    };
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
        PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    static RUNNING: AtomicBool = AtomicBool::new(true);

    /// 获取与当前登录用户隔离的唯一命名管道名称。
    ///
    /// 开发构建单独一条管道：它和已安装版本的数据目录、WebView 源都不同，
    /// 共用一个名字会让 `tauri dev` 把启动参数转给已安装实例后自己退出。
    fn pipe_name() -> String {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
        // 正式版沿用原名，避免升级后新旧实例各占一条管道。
        let suffix = if cfg!(debug_assertions) { "_dev" } else { "" };
        format!(r"\\.\pipe\forge_single_instance_{user}{suffix}")
    }

    /// 尝试将启动参数转发给已在运行的主实例。
    ///
    /// 若连接并发送成功，返回 true，表示当前进程应该直接退出；
    /// 若管道无法连接（没有主实例运行），返回 false。
    pub fn try_forward(args: &[String]) -> bool {
        let name = pipe_name();
        // 尝试打开已存在的命名管道；若不存在或失败则代表无主实例
        let Ok(mut stream) = std::fs::OpenOptions::new().read(true).write(true).open(&name) else {
            return false;
        };

        let Ok(payload) = serde_json::to_vec(args) else {
            return false;
        };

        let len_bytes = (payload.len() as u32).to_le_bytes();
        if stream.write_all(&len_bytes).is_err() {
            return false;
        }
        if stream.write_all(&payload).is_err() {
            return false;
        }
        if stream.flush().is_err() {
            return false;
        }

        // 读取 1 字节确认，确保主实例已经接收完毕
        let mut ack = [0u8; 1];
        let _ = stream.read_exact(&mut ack);
        true
    }

    /// 在后台线程中监听命名管道，接收从实例传过来的参数并递交给主窗口。
    pub fn start_server(app: AppHandle) {
        let name = pipe_name();
        let wide_name = HSTRING::from(name);

        std::thread::Builder::new()
            .name("forge-single-instance-pipe".into())
            .spawn(move || {
                let mut first = true;
                while RUNNING.load(Ordering::Relaxed) {
                    let open_mode = PIPE_ACCESS_DUPLEX
                        | if first {
                            FILE_FLAG_FIRST_PIPE_INSTANCE
                        } else {
                            windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0)
                        };
                    let pipe_mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT;

                    let pipe = unsafe {
                        CreateNamedPipeW(
                            PCWSTR(wide_name.as_ptr()),
                            open_mode,
                            pipe_mode,
                            1,      // 每次仅允许 1 个连接进入
                            65536,  // 输出缓冲
                            65536,  // 输入缓冲
                            5000,   // 超时 ms
                            None,
                        )
                    };

                    if pipe == INVALID_HANDLE_VALUE {
                        // 首次建立如果失败，休眠片刻后重试
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        continue;
                    }

                    first = false;

                    // 等待从实例连接
                    let connected = unsafe { ConnectNamedPipe(pipe, None).is_ok() };
                    if connected {
                        handle_client(pipe, &app);
                    }

                    unsafe {
                        let _ = DisconnectNamedPipe(pipe);
                        let _ = CloseHandle(pipe);
                    }
                }
            })
            .ok();
    }

    fn handle_client(pipe: HANDLE, app: &AppHandle) {
        let mut len_buf = [0u8; 4];
        let mut bytes_read = 0u32;
        let ok = unsafe {
            ReadFile(
                pipe,
                Some(&mut len_buf),
                Some(&mut bytes_read),
                None,
            )
        };
        if ok.is_err() || bytes_read != 4 {
            return;
        }

        let len = u32::from_le_bytes(len_buf) as usize;
        // 限制参数消息体最大 1MB，防恶意泛洪
        if len > 1024 * 1024 {
            return;
        }

        let mut data = vec![0u8; len];
        let mut total = 0;
        while total < len {
            let mut chunk = 0u32;
            let read_ok = unsafe {
                ReadFile(
                    pipe,
                    Some(&mut data[total..]),
                    Some(&mut chunk),
                    None,
                )
            };
            if read_ok.is_err() || chunk == 0 {
                break;
            }
            total += chunk as usize;
        }

        if total == len {
            if let Ok(args) = serde_json::from_slice::<Vec<String>>(&data) {
                // 唤醒并派发文件打开给主实例
                crate::shell_open::deliver(app, &args);
            }
        }

        // 发送 1 字节 ACK 确认
        let ack = [1u8];
        let mut written = 0u32;
        unsafe {
            let _ = WriteFile(pipe, Some(&ack), Some(&mut written), None);
        }
    }

    pub fn stop_server() {
        RUNNING.store(false, Ordering::Relaxed);
    }
}

#[cfg(not(windows))]
mod imp {
    use tauri::AppHandle;

    pub fn try_forward(_args: &[String]) -> bool {
        false
    }

    pub fn start_server(_app: AppHandle) {}

    pub fn stop_server() {}
}

pub use imp::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forward_returns_false_when_no_server() {
        let args = vec!["--test-arg".to_string(), "foo.txt".to_string()];
        // 在没有启动命名管道服务时，try_forward 应当安全返回 false 而非崩溃
        assert!(!try_forward(&args));
    }
}

