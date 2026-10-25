//! Provider wire protocols stay behind this boundary; the UI never submits native RPC.
//! 各家线上协议只留在适配层内部：前端只发结构化意图，永远不直接提交原生 RPC 文本。
use serde_json::Value;

/// 适配层要求运行时执行的单个动作。把「解析协议」和「操作进程/存储」分开，
/// 适配层因此可以纯函数式地测试，不必真的起子进程。
#[derive(Debug, PartialEq)]
pub enum Action {
    /// 往 CLI 的 stdin 写一行协议数据。
    Write(Value),
    /// 关闭 stdin，但保留 stdout 继续读。用于后台任务已结束、可让 CLI 自然退出的场景。
    CloseInput,
    /// 向 UI 发一条事件，`kind` 决定前端如何渲染，`data` 是载荷。
    Emit {
        kind: &'static str,
        data: Value,
    },
    /// 记录 CLI 自己的会话 id，供之后恢复对话时使用。
    Bind(String),
    /// 需要用户答复的请求（授权或提问）。
    Request {
        /// 适配层内部用的关联键，运行时把它换成不可猜测的请求 id 再发给前端。
        key: String,
        /// `permission`（授权）或 `question`（提问）。
        kind: &'static str,
        /// 展示内容：标题、详情、可选项等。
        data: Value,
    },
    /// 之前的请求已失效，通知前端收起对应卡片。
    Invalidate(String),
    /// 计划模式产出了一份完整计划。运行时负责登记 revision、落盘并广播审阅卡片；
    /// 适配层不碰文件，也不知道当前是第几版。
    Plan {
        title: String,
        content: String,
        native_plan_id: String,
    },
    /// 本轮运行结束，带上终态与失败原因。
    Finish {
        /// `completed` / `cancelled` / `failed`。
        status: &'static str,
        /// 失败原因；正常结束时为 None。
        error: Option<String>,
    },
}

/// 一个 CLI 的协议适配器。实现方只管翻译，不碰进程与磁盘。
pub trait Protocol: Send {
    /// 会话开始时需要发给 CLI 的初始动作（握手、初始化请求等）。
    fn start(&mut self) -> Result<Vec<Action>, String>;
    /// 处理 CLI 吐来的一行消息，返回由此产生的后续动作。
    fn receive(&mut self, message: Value) -> Result<Vec<Action>, String>;
    /// 把用户答复转成协议消息。`answer` 形如 `{allow: bool}` 或 `{answers: {questionId: string[]}}`。
    fn respond(&mut self, key: &str, answer: Value) -> Result<Vec<Action>, String>;
    /// 修改线程级 Goal 状态。只有原生支持 Goal 的协议实现会覆盖它。
    fn set_goal_status(&mut self, _status: &str) -> Result<Vec<Action>, String> {
        Err("当前 CLI 不支持 Goal 状态控制".into())
    }
    /// 回合完成后、关闭 stdin 前获取只读上下文快照；不发模型消息。
    fn request_context(&mut self) -> Vec<Action> { vec![] }
    /// 诊断失败不能改变对话的成功终态。
    fn context_timeout(&mut self) -> Vec<Action> { vec![] }
    /// 中断当前回合；返回要发给 CLI 的收尾动作。
    fn interrupt(&mut self) -> Vec<Action>;
    /// CLI 已确认本轮用户输入并建立原生回合。初始化回包不算：只有到这个边界以后，
    /// 管道断开才允许按“运行中失联”恢复，也只有这时才能把 Forge 状态写成 running。
    fn turn_started(&self) -> bool { false }
    /// 回合已经交还给用户，但进程仍留在原地等后台任务自发的后续回合。
    /// 运行时据此区分「卡死」和「有事在跑」：前者要报错，后者不能报错也不能重发。
    fn parked(&self) -> bool {
        false
    }
}
