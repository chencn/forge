use serde_json::Value;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    mpsc, Arc, Condvar, Mutex, OnceLock,
};
use std::time::Duration;

/// 全局生命周期锁。启动运行、修改设置、管理 CLI 都要先拿它，
/// 用来把「检查有没有在跑」和「真正开始/停止」合成一个原子动作。
pub static LIFECYCLE: Mutex<()> = Mutex::new(());
/// 等一个回合彻底收尾的上限。CLI 被杀掉后仍可能在清理子进程，
/// 超过这个时间就如实报「还在清理」，绝不假装已经停止。
const STOP_CLEANUP_TIMEOUT: Duration = Duration::from_secs(15);
/// 当前所有运行中的任务，按 run id 索引；用 OnceLock 保证全局唯一。
static RUNS: OnceLock<Mutex<HashMap<String, Arc<Run>>>> = OnceLock::new();
fn runs() -> &'static Mutex<HashMap<String, Arc<Run>>> {
    RUNS.get_or_init(Mutex::default)
}

/// 运行中进程的控制消息。目前只有「答复请求」，以后要加停止之外的指令也走这里。
pub enum Control {
    /// 用户对某个待答复请求给出了答案。
    Answer {
        /// 运行时发给前端的请求 id，用它找回对应的协议内部键。
        request_id: String,
        /// 已校验的答复内容。
        answer: Value,
        /// 回执通道：写入线程处理完后回一个结果，调用方据此知道答复是否送达。
        reply: mpsc::SyncSender<Result<(), String>>,
    },
}

/// 一次运行在全局登记表里的条目。UI 命令通过它判断能否停止、停止哪个项目。
pub struct Run {
    /// 本次运行的唯一 id，事件里的 `runId` 与它对应。
    pub id: String,
    /// 所属会话 id；同一会话同时只允许一个运行。
    pub session_id: String,
    /// 规范化后的工作区根（已解析符号链接），用于按项目停止与事件过滤。
    pub workspace: String,
    /// 前端原始传入的工作区路径；规范化失败时用它回报错误，便于用户对照。
    pub requested_workspace: String,
    /// 停止标记。置位后运行循环在下一个检查点退出，不再继续处理协议消息。
    pub cancelled: AtomicBool,
    /// 排除本轮自己启动的 Claude PID，才能识别运行中途出现的外部占用。
    pub child_pid: AtomicU32,
    /// 把控制消息投递给运行线程的通道。
    pub controls: mpsc::SyncSender<Control>,
    /// 完成标记与条件变量：等它变真即可确认线程已彻底退出，而非只是置了取消位。
    done: (Mutex<bool>, Condvar),
}
impl Run {
    pub fn reserve(
        id: String,
        session_id: String,
        workspace: String,
        requested_workspace: String,
    ) -> Result<(Arc<Self>, mpsc::Receiver<Control>), String> {
        let mut all = runs().lock().map_err(|e| e.to_string())?;
        if all.contains_key(&id)
            || all
                .values()
                // 任务互斥属于会话；同一工程的独立会话允许并行。
                .any(|run| run.session_id == session_id)
        {
            return Err("该会话已有 AI 任务运行，请先停止或等待完成".into());
        }
        if all.len() >= 8 {
            return Err("同时运行的任务已达到上限".into());
        }
        let (controls, receive) = mpsc::sync_channel(16);
        let run = Arc::new(Self {
            id: id.clone(),
            session_id,
            workspace,
            requested_workspace,
            cancelled: AtomicBool::new(false),
            child_pid: AtomicU32::new(0),
            controls,
            done: (Mutex::new(false), Condvar::new()),
        });
        all.insert(id, run.clone());
        Ok((run, receive))
    }
    pub fn finish(&self) {
        let mut all = runs().lock().unwrap_or_else(|e| e.into_inner());
        all.remove(&self.id);
        *self.done.0.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.done.1.notify_all();
    }
    pub fn stop(&self) -> Result<(), String> {
        self.request_stop();
        self.wait_until_stopped()
    }
    /// 只置停止位，不等清理结束。全局锁内做这一步就够了：
    /// 「查到在跑」和「决定停它」必须原子，等待则可以放到锁外。
    pub fn request_stop(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
    /// 等运行线程彻底退出。单独调用而没先 `request_stop` 只会白等到超时。
    pub fn wait_until_stopped(&self) -> Result<(), String> {
        self.wait_within(STOP_CLEANUP_TIMEOUT)
    }
    fn wait_within(&self, timeout: Duration) -> Result<(), String> {
        let done = self.done.0.lock().map_err(|e| e.to_string())?;
        let (done, _) = self
            .done
            .1
            .wait_timeout_while(done, timeout, |done| !*done)
            .map_err(|e| e.to_string())?;
        if !*done {
            return Err("任务仍在清理，尚未关闭；请稍后重试".into());
        }
        Ok(())
    }
}
pub fn get(id: &str) -> Option<Arc<Run>> {
    runs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .cloned()
}
pub fn for_session(id: &str) -> Option<Arc<Run>> {
    runs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .find(|r| r.session_id == id)
        .cloned()
}
pub fn all() -> Vec<Arc<Run>> {
    runs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .cloned()
        .collect()
}
/// 先统一置停止位，再逐个等清理结束：总耗时是「最慢的那个」，不是每个上限相加。
/// 某个任务超时也继续等完其余的，否则会留下没人管的进程。
pub fn stop_all() -> Result<(), String> {
    let all = all();
    flag_stop(&all);
    wait_stopped(all)
}
/// 给这一批回合统一置停止位。等待留给调用方在锁外做，见 `Run::request_stop`。
pub fn flag_stop(runs: &[Arc<Run>]) {
    for run in runs {
        run.request_stop();
    }
}
/// 逐个等完再报第一个错误：中途返回会留下没人管的进程。
/// 收 `IntoIterator` 是为了让「只停一个回合」的调用方也能用同一份等待逻辑。
pub fn wait_stopped(runs: impl IntoIterator<Item = Arc<Run>>) -> Result<(), String> {
    let mut first_error = None;
    for run in runs {
        if let Err(error) = run.wait_until_stopped() {
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_and_session_reservation_precede_launch() {
        let (a, _) = Run::reserve(
            "registry-a".into(),
            "registry-s".into(),
            "registry-root".into(),
            "registry-root".into(),
        )
        .unwrap();
        let (b, _) = Run::reserve(
            "registry-b".into(),
            "registry-other".into(),
            "registry-root".into(),
            "registry-root".into()
        )
        .unwrap();
        b.finish();
        assert!(Run::reserve(
            "registry-c".into(),
            "registry-s".into(),
            "registry-other".into(),
            "registry-other".into()
        )
        .is_err());
        a.finish();
        assert!(a.stop().is_ok());
        assert!(get("registry-a").is_none());
    }

    /// 停止拆成「置位」和「等收尾」两步：命令层只能在锁内置位，
    /// 等待必须放到锁外，否则一个卡死的 CLI 会按住所有会话的发送与队列调度。
    #[test]
    fn flagging_stop_does_not_wait_for_cleanup() {
        let (run, _) = Run::reserve(
            "stop-flag-a".into(),
            "stop-flag-s".into(),
            "root".into(),
            "root".into(),
        )
        .unwrap();
        let started = std::time::Instant::now();
        run.request_stop();
        assert!(started.elapsed() < Duration::from_millis(200), "置位不该等待收尾");
        assert!(run.cancelled.load(Ordering::Acquire));
        // 没人收尾时，等待要如实失败，而不是因为置了位就报成功。
        assert!(run.wait_within(Duration::from_millis(50)).is_err());
        let finished = run.clone();
        std::thread::spawn(move || finished.finish());
        assert!(run.wait_until_stopped().is_ok());
        assert!(get("stop-flag-a").is_none());
    }

    /// `stop_all` 与「按项目停止」都走这条顺序：先给整批统一置位，再逐个等收尾。
    /// 反过来「逐个停并等待」会把总耗时叠成每个上限相加，还会让后面的回合根本没收到停止信号。
    #[test]
    fn flagging_a_batch_stops_every_run_before_any_wait() {
        let (first, _) = Run::reserve(
            "stop-all-1".into(),
            "stop-all-s1".into(),
            "root".into(),
            "root".into(),
        )
        .unwrap();
        let (second, _) = Run::reserve(
            "stop-all-2".into(),
            "stop-all-s2".into(),
            "root".into(),
            "root".into(),
        )
        .unwrap();
        flag_stop(&[first.clone(), second.clone()]);
        assert!(first.cancelled.load(Ordering::Acquire));
        assert!(second.cancelled.load(Ordering::Acquire));
        // 等待阶段才可能超时；到这里两个回合都已经收到信号。
        first.finish();
        second.finish();
        assert!(first.wait_until_stopped().is_ok());
        assert!(second.wait_until_stopped().is_ok());
    }
}
