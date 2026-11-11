//! 跨进程独占文件锁。
//!
//! 进程内的 `Mutex` 管不到另一个进程实例；需要「同一个文件同一时刻只有一个写者」
//! 的地方（本地历史、CLI 会话写锁）共用这里的字节锁。锁跟着句柄走，句柄关闭即
//! 释放；锁文件内容从不参与同步，只当租约。

use std::fs::File;

/// 对已打开的句柄尝试取独占字节锁，不等待。
///
/// 返回 `true` 表示锁已持有到该句柄关闭；`false` 表示别的进程或别的句柄正持有。
/// 锁覆盖整个文件，但文件内容从不读写。
///
/// # Errors
///
/// 系统调用失败（句柄无效、平台不支持等）时返回错误原文。
pub(crate) fn try_lock_exclusive(file: &File) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::{ERROR_LOCK_VIOLATION, HANDLE};
        use windows::Win32::Storage::FileSystem::{
            LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
        };
        use windows::Win32::System::IO::OVERLAPPED;
        let mut overlapped = OVERLAPPED::default();
        match unsafe {
            LockFileEx(
                HANDLE(file.as_raw_handle()),
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                Some(0),
                u32::MAX,
                u32::MAX,
                &mut overlapped,
            )
        } {
            Ok(()) => Ok(true),
            Err(error) if error.code() == ERROR_LOCK_VIOLATION.to_hresult() => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(true);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::WouldBlock {
            Ok(false)
        } else {
            Err(error.to_string())
        }
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = file;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;
    use std::path::PathBuf;

    /// 每个测试独占的临时目录。
    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::UNIX_EPOCH
            .elapsed()
            .map(|since| since.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "forge-lock-{name}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn second_handle_is_refused_until_the_first_is_dropped() {
        let dir = temp_dir("exclusive");
        let path = dir.join(".write.lock");
        let first = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&path)
            .unwrap();
        assert!(try_lock_exclusive(&first).unwrap(), "空文件应当能拿到锁");
        let second = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert!(
            !try_lock_exclusive(&second).unwrap(),
            "另一个句柄不能同时持有同一把锁"
        );
        drop(first);
        assert!(
            try_lock_exclusive(&second).unwrap(),
            "前一个句柄释放后应当能拿到"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
