//! 任务状态的唯一来源，和前端 `src/lib/aiTaskStatus.ts` 一一对应。
//!
//! 状态字符串会进事件日志，重启后还要能原样投影回队列，所以改名等于改数据格式。
//! 两边只能靠字面量对齐，没有代码生成：下面的测试把「后端能发出的状态」「终态判定」
//! 「排队判定」钉死成一张表，任何一侧偷偷加一档就会红。
//!
//! `submitting` 只在前端存在（IPC 往返期间的乐观占位），后端绝不落盘，所以不进 `EMITTED`。

/// 已入队，等本会话的前一轮结束。
pub const QUEUED: &str = "queued";
/// 队首被别的 CLI 进程占着；它仍在队列里，只是不该伪装成「马上就跑」。
pub const WAITING_EXTERNAL: &str = "waitingExternal";
/// 本轮正在运行。
pub const RUNNING: &str = "running";
/// 本轮正常结束。
pub const COMPLETED: &str = "completed";
/// 用户停止，或清理时放弃。
pub const CANCELLED: &str = "cancelled";
/// 本轮失败，附错误说明。
pub const FAILED: &str = "failed";

/// 后端实际写进事件日志的全部状态；前端 `AI_TASK_BACKEND_STATUSES` 与它一一对应。
/// 运行时判定都走上面的具名常量，这张表只用来做词表守卫，所以不必进发布构建。
#[cfg(test)]
pub const EMITTED: &[&str] = &[QUEUED, WAITING_EXTERNAL, RUNNING, COMPLETED, CANCELLED, FAILED];

/// 终态：这一轮不会再产生输出，可以安全地启动下一条或提供重试。
pub fn is_terminal(status: &str) -> bool {
    matches!(status, COMPLETED | CANCELLED | FAILED)
}

/// 还没跑完、也没被取消的一轮。全日志摘要用它决定哪些任务仍然「活着」。
pub fn is_live(status: &str) -> bool {
    matches!(status, RUNNING) || is_queued(status)
}

/// 仍在队列里、还可以编辑/移动/直接取消的一项。运行中的回合不算。
pub fn is_queued(status: &str) -> bool {
    matches!(status, QUEUED | WAITING_EXTERNAL)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 词表本身就是数据契约：拼错一个字母，前端读到的就是没见过的状态。
    #[test]
    fn emitted_vocabulary_matches_the_frontend_contract() {
        assert_eq!(EMITTED, &["queued", "waitingExternal", "running", "completed", "cancelled", "failed"]);
    }

    /// 「未结束」与「终态」必须互补且互斥，任何一档都不许两边都不沾或两边都沾。
    #[test]
    fn every_emitted_status_falls_in_exactly_one_bucket() {
        for status in EMITTED {
            assert_eq!(is_live(status), !is_terminal(status), "{status}");
            if is_queued(status) { assert!(is_live(status), "{status}"); }
        }
        assert!(is_terminal(COMPLETED) && is_terminal(CANCELLED) && is_terminal(FAILED));
        assert!(is_queued(QUEUED) && is_queued(WAITING_EXTERNAL) && !is_queued(RUNNING));
        assert!(is_live(RUNNING) && !is_live(CANCELLED));
    }

    /// 未知字符串一律不当终态：宁可让任务留在视图里，也不悄悄判死。
    #[test]
    fn unknown_status_is_not_terminal_and_not_live() {
        for status in ["", "submitting", "Completed", "interrupted"] {
            assert!(!is_terminal(status), "{status}");
            assert!(!is_live(status), "{status}");
            assert!(!is_queued(status), "{status}");
        }
    }
}
