use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 前端监听的事件通道名，与 `lib.rs` 注册的 emit 目标必须一致。
pub const CHANNEL: &str = "ai-runtime://events";

/// 一条运行时事件。前端按 `seq` 排序去重，所以序号必须单调递增且连续。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// 事件属于哪个会话，前端据此把事件投进对应会话的状态里。
    pub session_id: String,
    /// 事件属于哪一轮运行；同会话里新一轮的 `seq` 重新计数。
    pub run_id: String,
    /// 会话内的单调序号，前端靠它排序、去重与判断是否漏事件。
    pub seq: u64,
    /// 事件类型，决定前端怎么渲染：`text`、`tool`、`status`、`files` 等。
    pub kind: String,
    /// 与 `kind` 配套的载荷；结构随类型变化，前端按类型解读。
    pub data: Value,
}

/// 一次历史分页查询的结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    /// 本次返回的事件，按 `seq` 升序。
    pub events: Vec<Event>,
    /// 往前翻的那一页：是否还有更早的记录没被这一页装下。往后翻时恒为 false。
    pub has_older: bool,
    /// 往后翻的那一页：是否还有更新的记录没被这一页装下。往前翻时恒为 false。
    pub has_more: bool,
    /// 下一次分页的游标：往前翻是这一页最小的 `seq`（下一页取它之前），往后翻是这一页最大的。
    pub next_seq: u64,
    /// CLI 原生的会话 id；用于恢复时告诉 CLI 接着哪一段对话。
    pub native_id: Option<String>,
    /// 会话当前状态（running / completed / cancelled / failed）；未知时为 None。
    pub status: Option<String>,
    /// 该会话已知的最大序号，前端据此判断是否要重新拉取。
    pub latest_seq: u64,
    /// 最大序号所属的 `run_id`；配合 `latest_seq` 判断是否有新一轮开始。
    pub latest_run_id: Option<String>,
    /// 当前仍在运行或排队的任务。历史分页可能尚未读到这些事件，所以单独返回轻量摘要。
    pub active_tasks: Vec<Value>,
    /// 模型拆出的最新任务清单。它是会话级状态，不能依赖当前时间线页是否碰巧含有 task_list 事件。
    pub task_list: Option<Value>,
    /// Codex 线程的最新 Goal 快照；外层携带事件序号，清除 Goal 时内部 goal 为 null。
    pub goal: Option<Value>,
    /// 读取过程中的非致命问题（例如某条记录损坏被跳过），有值就提示用户。
    pub warning: Option<String>,
    /// 该会话的全部计划版本；前端按 planId 取最新一版渲染审阅卡片。
    pub plans: Vec<Value>,
}
