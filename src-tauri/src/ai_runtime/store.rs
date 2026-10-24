//! Forge 自己维护的事件存储；原生历史只读适配器在 history.rs。
//! Forge-owned event store. Read-only native history adapters live in history.rs.
use super::events::{Event, Page};
use crate::ai_cli::Provider;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 所有落盘操作共用一把锁。事件追加与历史读取并发时，避免读到写了一半的行。
pub static IO_LOCK: Mutex<()> = Mutex::new(());
/// 单行日志上限。超出说明记录已损坏，跳过而不是把整份文件读进内存。
const MAX_LINE: u64 = 2 * 1024 * 1024;
/// 单个会话日志上限。到顶后不再追加，防止长期运行把磁盘写满。
const MAX_LOG: u64 = 256 * 1024 * 1024;

/// id 白名单：非空、不超过 80 字节、只允许字母数字与连字符。
/// 这些 id 会拼进文件路径，先卡住 `..` 与分隔符才谈得上安全。
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
/// 规范化工作区路径，作为会话归属与事件过滤的键。
/// 必须是已存在的绝对目录；Windows 上统一转小写，避免大小写不同被当成两个项目。
pub fn workspace(path: &str) -> Result<String, String> {
    let path = Path::new(path);
    if !path.is_absolute() || !path.is_dir() {
        return Err("请先打开有效的项目目录".into());
    }
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let value = path.to_string_lossy().into_owned();
    Ok(if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    })
}

/// 一把 OS 级独占租约。进程崩溃时内核自动释放，所以不需要靠 PID 判断陈旧锁。
pub struct Lease {
    /// 句柄必须活着：锁随句柄关闭而释放，Drop 即解锁。
    _file: File,
}
impl Lease {
    pub fn acquire(path: &Path) -> Result<Self, String> {
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        let file = options
            .open(path)
            .map_err(|e| format!("项目或会话正在其他窗口运行，或记录不可访问：{e}"))?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err("项目或会话正在其他窗口运行".into());
            }
        }
        Ok(Self { _file: file })
    }
}

/// 会话目录里的元数据（`meta.json`）。历史列表直接读它，不必扫整个事件日志。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    /// 元数据格式版本，将来结构变更时据此决定要不要迁移。
    pub format_version: u32,
    /// Forge 侧会话 id，与目录名一致。
    pub session_id: String,
    /// 该会话由哪个 CLI 驱动。
    pub provider: Provider,
    /// 规范化后的工作区根；历史列表按它过滤当前项目。
    pub workspace: String,
    /// 会话标题，用户可重命名。
    pub title: String,
    /// CLI 自己的会话 id，恢复对话时传给 CLI。
    pub native_id: Option<String>,
    /// 创建该会话时的 CLI 版本，用于解释协议差异。
    pub cli_version: String,
    /// 创建时间（毫秒时间戳）；旧文件没有这个字段时按 0 处理。
    #[serde(default)]
    pub created_at: u64,
    /// 归档只是从默认列表里收起，事件日志、原生会话绑定都不动，随时能翻回来。
    /// 旧文件没这个字段按未归档处理。
    #[serde(default)]
    pub archived: bool,
    /// 置顶只影响侧栏「置顶」章节的归位；旧文件没有这个字段按未置顶处理。
    #[serde(default)]
    pub pinned: bool,
    /// 置顶时间（毫秒时间戳），置顶章节按它倒序。未置顶为 None。
    #[serde(default)]
    pub pinned_at: Option<u64>,
}

/// 一个会话的存储句柄：目录、元数据与当前序号。
pub struct Store {
    /// 该会话独占的目录，事件日志与元数据都在里面。
    pub dir: PathBuf,
    /// 已加载的元数据；改名时整份写回。
    pub meta: Metadata,
    /// 已写入的最大事件序号，新事件从它往后递增。
    pub seq: u64,
    /// 日志曾被判定损坏（例如末行不完整）。置位后只读，不再追加。
    pub poisoned: bool,
}
impl Store {
    pub fn open(
        base: &Path,
        id: &str,
        root: &str,
        provider: Provider,
        title: &str,
        version: &str,
    ) -> Result<Self, String> {
        if !valid_id(id) {
            return Err("无效的会话 ID".into());
        }
        let dir = base.join(id);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let meta = if dir.join("meta.json").exists() {
            Self::metadata(&dir, root)?
        } else {
            Metadata {
                format_version: 1,
                session_id: id.into(),
                provider,
                workspace: root.into(),
                title: title.into(),
                native_id: None,
                cli_version: version.into(),
                created_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                archived: false,
                pinned: false,
                pinned_at: None,
            }
        };
        if meta.provider != provider {
            return Err("会话工具不匹配，禁止跨工具续聊".into());
        }
        let scan = scan_events(&dir.join("events.jsonl"), true, Window::After(0), 0, id)?;
        let mut store = Self {
            dir,
            meta,
            seq: scan.seq,
            poisoned: false,
        };
        if !version.is_empty() {
            store.meta.cli_version = version.into();
        }
        store.meta.title = title.into();
        // 记录停在 running、却又拿不到 OS 租约，说明上一次进程是被打断的：
        // 这里把它标成已取消，并且不自动重发消息，避免重复执行工具。
        if let Some(event) = scan.last_status {
            if event.data["status"] == "running" {
                store.append(&event.run_id, vec![("status".into(), serde_json::json!({"status":"cancelled","error":"上次运行未正常结束；未自动重发消息"}))])?;
            }
        }
        store.save_meta()?;
        Ok(store)
    }
    pub fn metadata(dir: &Path, root: &str) -> Result<Metadata, String> {
        let path = dir.join("meta.json");
        if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 64 * 1024 {
            return Err("会话元数据过大".into());
        }
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        let meta: Metadata =
            serde_json::from_slice(&bytes).map_err(|e| format!("会话记录损坏：{e}"))?;
        if meta.format_version != 1
            || meta.workspace != root
            || !valid_id(&meta.session_id)
            || dir.file_name().and_then(|s| s.to_str()) != Some(meta.session_id.as_str())
        {
            return Err("会话版本或项目归属不匹配".into());
        }
        Ok(meta)
    }
    pub fn save(&self) -> Result<(), String> {
        self.save_meta()
    }
    /// 归档 / 取消归档。只重写元数据，不碰事件日志，也不通知 CLI：
    /// 这是 Forge 侧的收纳动作，原生会话仍然可以照常恢复。
    /// 返回写入后的状态，便于前端在并发下确认自己看到的到底是不是最终值。
    pub fn set_archived(base: &Path, id: &str, root: &str, archived: bool) -> Result<bool, String> {
        if !valid_id(id) {
            return Err("无效的会话 ID".into());
        }
        let dir = base.join(id);
        let _lease = Lease::acquire(&base.join(format!("{id}.lock")))?;
        let _io = IO_LOCK.lock().map_err(|e| e.to_string())?;
        let mut meta = Self::metadata(&dir, root)?;
        meta.archived = archived;
        Self {
            dir,
            meta,
            seq: 0,
            poisoned: false,
        }
        .save()?;
        Ok(archived)
    }
    /// 置顶 / 取消置顶。同样只重写元数据：它只是侧栏里的归位动作，
    /// 事件日志与原生会话都不受影响。置顶时记下时间戳，置顶章节按它倒序。
    pub fn set_pinned(base: &Path, id: &str, root: &str, pinned: bool) -> Result<bool, String> {
        if !valid_id(id) {
            return Err("无效的会话 ID".into());
        }
        let dir = base.join(id);
        let _lease = Lease::acquire(&base.join(format!("{id}.lock")))?;
        let _io = IO_LOCK.lock().map_err(|e| e.to_string())?;
        let mut meta = Self::metadata(&dir, root)?;
        meta.pinned = pinned;
        meta.pinned_at = pinned.then(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
        });
        Self {
            dir,
            meta,
            seq: 0,
            poisoned: false,
        }
        .save()?;
        Ok(pinned)
    }
    fn save_meta(&self) -> Result<(), String> {
        crate::sys::write_atomic(
            &self.dir.join("meta.json"),
            &serde_json::to_string(&self.meta).map_err(|e| e.to_string())?,
        )
    }
    pub fn bind(&mut self, native: String) -> Result<(), String> {
        if native.is_empty() || native.len() > 512 || native.chars().any(char::is_control) {
            return Err("CLI 返回了无效会话标识".into());
        }
        if self
            .meta
            .native_id
            .as_ref()
            .is_some_and(|old| old != &native)
        {
            return Err("CLI 返回的会话与恢复目标不一致".into());
        }
        self.meta.native_id = Some(native);
        self.save_meta()
    }
    pub fn append(
        &mut self,
        run: &str,
        values: Vec<(String, serde_json::Value)>,
    ) -> Result<Vec<Event>, String> {
        if self.poisoned {
            return Err("本轮记录写入已失败，禁止继续追加；请重新加载会话".into());
        }
        let path = self.dir.join("events.jsonl");
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        let original_len = file.metadata().map_err(|e| e.to_string())?.len();
        let mut events = Vec::new();
        let mut bytes = Vec::new();
        for (kind, data) in values {
            let event = Event {
                session_id: self.meta.session_id.clone(),
                run_id: run.into(),
                seq: self.seq + events.len() as u64 + 1,
                kind,
                data,
            };
            let line = serde_json::to_vec(&event).map_err(|e| e.to_string())?;
            if line.len() as u64 >= MAX_LINE {
                return Err("单条 AI 事件超出存储上限".into());
            }
            bytes.extend(line);
            bytes.push(b'\n');
            events.push(event);
        }
        if original_len + bytes.len() as u64 > MAX_LOG {
            return Err("会话记录已达到 256 MiB，请创建新会话".into());
        }
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_data()) {
            // 写了一半的批次后面绝不能接一条沿用旧序号的新事件，否则日志会错位；
            // 即使回滚失败，也把实例标记为损坏，直到重新打开为止。
            self.poisoned = true;
            let rollback = file.set_len(original_len).and_then(|_| file.sync_data());
            return Err(format!(
                "保存对话失败，已停止执行：{error}；回滚结果：{rollback:?}"
            ));
        }
        self.seq += events.len() as u64;
        Ok(events)
    }
    pub fn page(
        base: &Path,
        id: &str,
        root: &str,
        window: Window,
        limit: usize,
        active: bool,
    ) -> Result<Page, String> {
        if !valid_id(id) {
            return Err("无效的会话 ID".into());
        }
        let dir = base.join(id);
        if !dir.exists() {
            // 空页面只能代表已存在但尚无事件的会话；不存在的目录必须暴露给调用方。
            return Err("会话不存在".into());
        }
        let meta = Self::metadata(&dir, root)?;
        let limit = limit.clamp(1, 500);
        let mut scan = scan_events(&dir.join("events.jsonl"), false, window, limit, id)?;
        if !active && !scan.active_tasks.is_empty() {
            // 活动摘要可能同时含一个运行项和多个排队项；只有拿到租约才敢逐项修复。
            if let Ok(_lease) = Lease::acquire(&base.join(format!("{id}.lock"))) {
                scan = scan_events(&dir.join("events.jsonl"), true, window, limit, id)?;
                if !scan.active_tasks.is_empty() {
                    let mut interrupted: Vec<_> = scan.active_tasks.values().filter_map(|task| {
                        Some((task["runId"].as_str()?.to_owned(), task["seq"].as_u64().unwrap_or_default()))
                    }).collect();
                    interrupted.sort_by_key(|(_, seq)| *seq);
                    let mut store = Self {
                        dir,
                        meta: meta.clone(),
                        seq: scan.seq,
                        poisoned: false,
                    };
                    for (run_id, _) in interrupted {
                        let event = store.append(
                            &run_id,
                            vec![(
                                "status".into(),
                                serde_json::json!({"status":"cancelled","error":"上次任务已中断"}),
                            )],
                        )?.remove(0);
                        scan.seq = event.seq;
                        // 修复写下的那一条就是日志的最新一条：照常交给窗口，往前翻时它必然进页，
                        // 并把这一页原本最老的那条挤出去——那才是「还有更早的」真实含义。
                        let bytes = serde_json::to_string(&event).map(|line| line.len() as u64 + 1).unwrap_or(0);
                        scan.accept(window, limit, event.clone(), bytes);
                        scan.last_status = Some(event);
                        scan.active_tasks.remove(&run_id);
                    }
                }
            }
        }
        let status = scan
            .last_status
            .as_ref()
            .and_then(|e| e.data["status"].as_str())
            .map(str::to_owned);
        let mut active_tasks: Vec<_> = std::mem::take(&mut scan.active_tasks).into_values().collect();
        active_tasks.sort_by_key(|task| task["seq"].as_u64().unwrap_or_default());
        let (has_more, has_older, latest_seq) = (scan.has_more, scan.has_older, scan.seq);
        let latest_run_id = scan.last_status.take().map(|event| event.run_id);
        let events = scan.take_events();
        // 游标跟着取的那一头走：往前翻停在「这一页最老一条之前」，往后翻停在「最新一条之后」。
        // 给反了就是同一页翻两次，或者永远翻不动。
        let next_seq = match window {
            Window::Before(_) => events.first().map_or(0, |event| event.seq),
            Window::After(after) => events.last().map_or(after, |event| event.seq),
        };
        Ok(Page {
            next_seq,
            events,
            has_more,
            has_older,
            native_id: meta.native_id,
            status,
            latest_seq,
            latest_run_id,
            active_tasks,
            warning: None,
            plans: Vec::new(),
        })
    }
}

/// 一页从会话日志的哪一头取。
#[derive(Clone, Copy)]
pub enum Window {
    /// 严格晚于这一序号，往新取最多 `limit` 条。
    After(u64),
    /// 严格早于这一序号，取其中**最新**的那 `limit` 条；`u64::MAX` 就是最后面一页。
    /// 打开会话必须走这一头：几 MB 的会话若从第一行开始翻，用户永远翻不到正在聊的那里。
    Before(u64),
}

/// 单页字节预算。一条事件最大 2 MiB，所以最坏情况是预算再加一条，不跟着会话长度走。
const PAGE_BYTES: u64 = 4 * 1024 * 1024;

/// 扫描日志时累积的结果。只留一页事件和最后一条状态，
/// 因此内存占用与对话长度无关，不会因为历史很长而撑爆。
#[derive(Default)]
struct Scan {
    /// 落在请求区间内的事件，最多一页。连着行宽存着：往前翻挤出头部时才知道该退回多少字节。
    page: std::collections::VecDeque<(Event, u64)>,
    /// 已计入这一页的字节数。
    page_bytes: u64,
    /// 已读到的最大序号，用于回填 `next_seq`。
    seq: u64,
    /// 日志里最后一条状态事件；分页时要靠它告诉前端当前是运行中还是已结束。
    last_status: Option<Event>,
    /// 只保留未终结任务，数量受运行与队列上限约束，不随历史长度增长。
    active_tasks: std::collections::HashMap<String, serde_json::Value>,
    /// user 与紧随其后的 status 分开写入；暂存提示词用于活动任务摘要。
    pending_prompts: std::collections::HashMap<String, String>,
    /// 往后翻：还有更新的事件没被这一页装下。
    has_more: bool,
    /// 往前翻：还有更早的事件没被这一页装下。
    has_older: bool,
}

impl Scan {
    /// 把一条事件交给窗口。往前翻装满就从头部挤出并记「还有更早的」，
    /// 但永远留住至少一条：否则一条巨大的最新事件会让首屏一片空白。
    fn accept(&mut self, window: Window, limit: usize, event: Event, bytes: u64) {
        match window {
            Window::After(after) => {
                if event.seq <= after {
                    return;
                }
                if !self.has_more
                    && self.page.len() < limit
                    && (self.page.is_empty() || self.page_bytes + bytes <= PAGE_BYTES)
                {
                    self.page_bytes += bytes;
                    self.page.push_back((event, bytes));
                } else {
                    self.has_more = true;
                }
            }
            Window::Before(before) => {
                if event.seq >= before {
                    return;
                }
                self.page_bytes += bytes;
                self.page.push_back((event, bytes));
                while self.page.len() > 1 && (self.page.len() > limit || self.page_bytes > PAGE_BYTES) {
                    if let Some((_, dropped)) = self.page.pop_front() {
                        self.page_bytes -= dropped;
                    }
                    self.has_older = true;
                }
            }
        }
    }
    /// 只给测试看：断言窗口里到底装了哪几条。
    #[cfg(test)]
    fn events(&self) -> Vec<Event> {
        self.page.iter().map(|(event, _)| event.clone()).collect()
    }
    fn take_events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.page).into_iter().map(|(event, _)| event).collect()
    }
}

/// 线性扫一遍日志做校验，同时只保留一页结果与最新状态。
/// 逐行读取而非整份载入，损坏的行跳过并在需要时修复尾部。
/// 整份扫描不能省：活动任务摘要、`latest_seq` 与序号连续性检查都要看完才能给。
fn scan_events(
    path: &Path,
    repair: bool,
    window: Window,
    limit: usize,
    session_id: &str,
) -> Result<Scan, String> {
    let file = match OpenOptions::new().read(true).write(repair).open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Scan::default()),
        Err(e) => return Err(e.to_string()),
    };
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_LOG {
        return Err("会话日志超出上限".into());
    }
    let mut reader = BufReader::new(file);
    let mut scan = Scan::default();
    let mut offset = 0;
    loop {
        let mut bytes = vec![];
        let count = reader
            .by_ref()
            .take(MAX_LINE + 1)
            .read_until(b'\n', &mut bytes)
            .map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        if count as u64 > MAX_LINE {
            return Err("会话事件过大".into());
        }
        if bytes.last() != Some(&b'\n') {
            if repair {
                reader
                    .get_mut()
                    .set_len(offset)
                    .and_then(|_| reader.get_mut().seek(SeekFrom::Start(offset)))
                    .and_then(|_| reader.get_mut().sync_data())
                    .map_err(|e| e.to_string())?;
            }
            break;
        }
        let event: Event = serde_json::from_slice(&bytes)
            .map_err(|e| format!("会话日志中段损坏，保留原文件：{e}"))?;
        if event.seq != scan.seq + 1 {
            return Err("会话事件序列不连续".into());
        }
        if event.session_id != session_id || !valid_id(&event.run_id) {
            return Err("会话事件归属不匹配".into());
        }
        scan.seq = event.seq;
        if event.kind == "user" {
            if let Some(prompt) = event.data["text"].as_str() {
                scan.pending_prompts.insert(event.run_id.clone(), prompt.to_owned());
            }
        }
        if event.kind == "status" {
            let status = event.data["status"].as_str().unwrap_or_default();
            if super::task_status::is_live(status) {
                let prompt = scan.pending_prompts.remove(&event.run_id)
                    .or_else(|| scan.active_tasks.get(&event.run_id).and_then(|task| task["prompt"].as_str()).map(str::to_owned));
                scan.active_tasks.insert(event.run_id.clone(), serde_json::json!({
                    "runId": event.run_id,
                    "status": status,
                    "seq": event.seq,
                    "prompt": prompt,
                }));
            } else if super::task_status::is_terminal(status) {
                scan.active_tasks.remove(&event.run_id);
                scan.pending_prompts.remove(&event.run_id);
            }
            scan.last_status = Some(event.clone());
        }
        scan.accept(window, limit, event, count as u64);
        offset += count as u64;
    }
    Ok(scan)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "forge-runtime-store-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }
    #[test]
    fn ids_cannot_escape_store() {
        for id in ["", "../x", "a/b", "a\\b", ".", "a:stream"] {
            assert!(!valid_id(id));
        }
        assert!(valid_id("abc-123"));
    }
    #[test]
    fn missing_session_is_not_an_empty_page() {
        let p = fixture();
        let error = match Store::page(&p, "missing", "root", Window::After(0), 10, false) {
            Ok(_) => panic!("不存在的会话不能返回空页"),
            Err(error) => error,
        };
        assert_eq!(error, "会话不存在");
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn unicode_paging_binding_and_tail_recovery() {
        let p = fixture();
        let mut s = Store::open(&p, "session", "root", Provider::Codex, "title", "1").unwrap();
        s.bind("native".into()).unwrap();
        assert!(s.bind("different".into()).is_err());
        s.append(
            "run",
            vec![
                ("text".into(), serde_json::json!({"text":"中文😀"})),
                ("status".into(), serde_json::json!({"status":"completed"})),
            ],
        )
        .unwrap();
        let page = Store::page(&p, "session", "root", Window::After(0), 1, false).unwrap();
        assert_eq!(page.events[0].data["text"], "中文😀");
        assert!(page.has_more);
        assert_eq!(page.next_seq, 1);
        OpenOptions::new()
            .append(true)
            .open(s.dir.join("events.jsonl"))
            .unwrap()
            .write_all(b"{broken")
            .unwrap();
        let s = Store::open(&p, "session", "root", Provider::Codex, "title", "").unwrap();
        assert_eq!(s.seq, 2);
        assert_eq!(s.meta.cli_version, "1");
        assert!(Store::page(&p, "session", "other", Window::After(0), 10, false).is_err());
        assert!(Store::open(&p, "session", "root", Provider::Claude, "title", "1").is_err());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn interrupted_run_is_not_replayed() {
        let p = fixture();
        let mut s = Store::open(&p, "session", "root", Provider::Claude, "title", "1").unwrap();
        s.append(
            "run",
            vec![("status".into(), serde_json::json!({"status":"running"}))],
        )
        .unwrap();
        let page = Store::page(&p, "session", "root", Window::After(0), 10, false).unwrap();
        assert_eq!(page.status.as_deref(), Some("cancelled"));
        assert_eq!(page.events.len(), 2);
        let mut queued = Store::open(&p, "queued-session", "root", Provider::Claude, "title", "1").unwrap();
        queued.append("queued-run", vec![("user".into(), serde_json::json!({"text":"next"})), ("status".into(), serde_json::json!({"status":"queued"}))]).unwrap();
        queued.append("waiting-run", vec![("user".into(), serde_json::json!({"text":"later"})), ("status".into(), serde_json::json!({"status":"waitingExternal"}))]).unwrap();
        let active = Store::page(&p, "queued-session", "root", Window::After(0), 10, true).unwrap();
        assert_eq!(active.active_tasks[0]["runId"], "queued-run");
        assert_eq!(active.active_tasks[0]["prompt"], "next");
        assert_eq!(active.active_tasks[1]["runId"], "waiting-run");
        let recovered = Store::page(&p, "queued-session", "root", Window::After(0), 10, false).unwrap();
        assert_eq!(recovered.status.as_deref(), Some("cancelled"));
        assert!(recovered.active_tasks.is_empty());
        assert_eq!(recovered.events.iter().filter(|event| event.data["status"] == "cancelled").count(), 2);
        // 修复写下的那一条是日志的最新一条：往前翻的首屏必须看得见它，否则界面会停在「还在跑」。
        let tail = Store::page(&p, "session", "root", Window::Before(u64::MAX), 1, false).unwrap();
        assert_eq!(tail.events.len(), 1);
        assert_eq!(tail.events[0].data["status"], "cancelled");
        assert!(tail.has_older);
        fs::remove_dir_all(p).unwrap();
    }
    /// 打开会话落到的那一页必须是最新的记录，游标则停在页内最老一条之前；
    /// 反过来的话，几个 MB 的会话要一路点「加载更多」才看得到正在聊的那里。
    #[test]
    fn a_long_session_opens_on_the_newest_page_and_walks_back() {
        let p = fixture();
        let mut s = Store::open(&p, "session", "root", Provider::Codex, "title", "1").unwrap();
        s.append(
            "run",
            (0..1200)
                .map(|n| ("text".into(), serde_json::json!({"text":n})))
                .collect(),
        )
        .unwrap();
        let last = Store::page(&p, "session", "root", Window::Before(u64::MAX), 10, false).unwrap();
        assert_eq!(last.events.len(), 10);
        assert_eq!(last.events.last().unwrap().data["text"], 1199);
        assert_eq!(last.next_seq, 1191);
        assert!(last.has_older);
        assert!(!last.has_more);
        assert_eq!(last.latest_seq, 1200);
        let older = Store::page(&p, "session", "root", Window::Before(last.next_seq), 10, false).unwrap();
        assert_eq!(older.events.first().unwrap().seq, 1181);
        assert_eq!(older.events.last().unwrap().seq, 1190);
        assert_eq!(older.next_seq, 1181);
        assert!(older.has_older);
        // 翻到最前面一页：更早的确实没有了，游标就是第一条的序号。
        let head = Store::page(&p, "session", "root", Window::Before(3), 10, false).unwrap();
        assert_eq!(head.events.len(), 2);
        assert!(!head.has_older);
        assert_eq!(head.next_seq, 1);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn scans_keep_only_the_requested_page_and_reject_middle_corruption() {
        let p = fixture();
        let mut s = Store::open(&p, "session", "root", Provider::Codex, "title", "1").unwrap();
        s.append(
            "run",
            (0..1200)
                .map(|n| ("text".into(), serde_json::json!({"text":n})))
                .collect(),
        )
        .unwrap();
        let scan = scan_events(&s.dir.join("events.jsonl"), false, Window::After(1000), 10, "session").unwrap();
        assert_eq!(scan.events().len(), 10);
        assert_eq!(scan.events()[0].seq, 1001);
        assert_eq!(scan.seq, 1200);
        assert!(scan.has_more);
        assert!(
            scan_events(&s.dir.join("events.jsonl"), false, Window::After(0), 0, "session")
                .unwrap()
                .events()
                .is_empty()
        );
        let path = s.dir.join("events.jsonl");
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{broken}\n")
            .unwrap();
        let before = fs::read(&path).unwrap();
        assert!(Store::open(&p, "session", "root", Provider::Codex, "title", "1").is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn metadata_cannot_claim_another_session_and_poisoned_writer_cannot_append() {
        let p = fixture();
        let mut s = Store::open(&p, "session", "root", Provider::Claude, "title", "1").unwrap();
        s.poisoned = true;
        assert!(s
            .append(
                "run",
                vec![("text".into(), serde_json::json!({"text":"no"}))]
            )
            .is_err());
        assert!(!s.dir.join("events.jsonl").exists());
        s.meta.session_id = "other".into();
        s.save().unwrap();
        assert!(Store::metadata(&s.dir, "root").is_err());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn page_byte_budget_keeps_contiguous_cursor() {
        let p = fixture();
        let mut s = Store::open(&p, "session", "root", Provider::Codex, "title", "1").unwrap();
        s.append(
            "run",
            (0..6)
                .map(|_| {
                    (
                        "text".into(),
                        serde_json::json!({"text":"x".repeat(1024*1024)}),
                    )
                })
                .collect(),
        )
        .unwrap();
        let first = Store::page(&p, "session", "root", Window::After(0), 500, false).unwrap();
        assert_eq!(first.events.len(), 3);
        assert!(first.has_more);
        assert_eq!(first.next_seq, 3);
        let second = Store::page(&p, "session", "root", Window::After(first.next_seq), 500, false).unwrap();
        assert_eq!(second.events.len(), 3);
        assert!(!second.has_more);
        assert_eq!(second.next_seq, 6);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn lease_rejects_second_owner_and_releases() {
        let p = fixture();
        let a = Lease::acquire(&p.join("lock")).unwrap();
        assert!(Lease::acquire(&p.join("lock")).is_err());
        drop(a);
        assert!(Lease::acquire(&p.join("lock")).is_ok());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn archive_is_a_flag_that_survives_reopen() {
        let p = fixture();
        let mut s = Store::open(&p, "s1", "root", Provider::Codex, "标题", "1").unwrap();
        assert!(!s.meta.archived);
        s.append("r1", vec![("text".into(), serde_json::json!({"text":"正文"}))])
            .unwrap();
        assert!(Store::set_archived(&p, "s1", "root", true).unwrap());
        // 重新打开会整份写回元数据，归档位不能被这一步洗掉。
        let s = Store::open(&p, "s1", "root", Provider::Codex, "标题", "2").unwrap();
        assert!(s.meta.archived);
        assert_eq!(s.seq, 1);
        // 事件日志一个字都没动：归档不是删除。
        assert_eq!(
            Store::page(&p, "s1", "root", Window::After(0), 10, false).unwrap().events.len(),
            1
        );
        assert!(!Store::set_archived(&p, "s1", "root", false).unwrap());
        // 别的项目不能顺手改动这个会话的状态，也不能被路径拼进去。
        assert!(Store::set_archived(&p, "s1", "other", true).is_err());
        assert!(Store::set_archived(&p, "../s1", "root", true).is_err());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn meta_without_the_archive_field_reads_as_unarchived() {
        let p = fixture();
        Store::open(&p, "s1", "root", Provider::Codex, "标题", "1")
            .unwrap()
            .save()
            .unwrap();
        // 老版本写下的 meta.json 没有 archived 字段，缺省必须解释为「未归档」。
        fs::write(
            p.join("s1/meta.json"),
            r#"{"formatVersion":1,"sessionId":"s1","provider":"codex","workspace":"root","title":"标题","nativeId":null,"cliVersion":"1","createdAt":5}"#,
        )
        .unwrap();
        assert!(!Store::metadata(&p.join("s1"), "root").unwrap().archived);
        // 归档一个老会话：写回的文件带上字段，读出来就是已归档。
        assert!(Store::set_archived(&p, "s1", "root", true).unwrap());
        assert!(Store::metadata(&p.join("s1"), "root").unwrap().archived);
        fs::remove_dir_all(p).unwrap();
    }
}
