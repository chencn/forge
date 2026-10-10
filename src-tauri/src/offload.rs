//! 同步工作挪到阻塞线程池上跑的共用出口。
//!
//! 非 `async` 的 `#[tauri::command]` 在主线程执行：一次目录遍历、一次子进程、一次读盘
//! 都会把整个窗口冻住。前端那边 `invoke` 本来就是异步的，命令写成 `async` 不改变调用方式。
//! `git` 模块自己有一份同形的 `block`，那条要把失败折成 `GIT_SPAWN`，所以留在那边。

use crate::error::err;

/// 跑一段阻塞工作并把结果送回前端。`Err` 只在线程 panic 时出现。
pub async fn block<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| err("BLOCK_SPAWN", e.to_string()))?
}

/// 跑一段本身不会失败的阻塞工作。线程 panic 时用 `empty` 兜底：
/// 命令签名保持非 `Result`，前端不必为「后端线程炸了」这一条加分支。
pub async fn block_value<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
    empty: impl FnOnce() -> T,
) -> T {
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[forge] 阻塞任务未能启动：{error}");
            empty()
        }
    }
}
