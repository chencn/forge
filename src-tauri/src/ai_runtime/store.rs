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
/// 单条事件落盘前的裁剪目标：给事件外壳与截断标记留出余量。
const FIT_TARGET: usize = MAX_LINE as usize - 4096;
/// 单个字符串的兜底上限：一条事件里的大字符串不止一个时统一压到这个长度。
const FIT_STRING: usize = 64 * 1024;
/// 就地裁剪的标记。留一小段前缀，读的人能看出截断发生在哪里。
const CUT_MARK: &str = "\n…（内容过大，已截断）";
/// 单个会话日志上限。到顶后不再追加，防止长期运行把磁盘写满。
const MAX_LOG: u64 = 256 * 1024 * 1024;

/// 工具输出（整段命令输出、大文件内容、补丁）可能远超单事件上限。落盘前把过长的
/// 字符串裁短，让这一轮仍能保存：整条拒收会连同上一条状态一起丢掉，代价比丢一截
/// 输出大。裁剪发生在落盘之前，广播给前端的也是裁剪后的同一份内容，实时视图与
/// 重新打开的历史不会对不上。
fn fit_event_data(mut data: serde_json::Value) -> serde_json::Value {
    let Ok(mut bytes) = serde_json::to_vec(&data) else {
        return data;
    };
    if bytes.len() <= FIT_TARGET {
        return data;
    }
    let original = bytes.len();
    // 常见情况：一条事件里只有一个超大字符串（工具输出或补丁），裁它一个就够。
    if cut_longest(&mut data, bytes.len() - FIT_TARGET) {
        bytes = match serde_json::to_vec(&data) {
            Ok(bytes) => bytes,
            Err(_) => return data,
        };
        if bytes.len() <= FIT_TARGET {
            return data;
        }
    }
    // 多个大字符串：统一压到 64 KiB 再看一次。
    cap_strings(&mut data);
    match serde_json::to_vec(&data) {
        Ok(bytes) if bytes.len() <= FIT_TARGET => data,
        _ => serde_json::json!({"truncated": true, "bytes": original}),
    }
}

fn longest_string(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::String(text) => text.len(),
        serde_json::Value::Array(items) => items.iter().map(longest_string).max().unwrap_or(0),
        serde_json::Value::Object(map) => map.values().map(longest_string).max().unwrap_or(0),
        _ => 0,
    }
}

/// 把最长的那个字符串裁掉 `excess` 字节左右并补上标记；没有可裁的返回 false。
fn cut_longest(value: &mut serde_json::Value, excess: usize) -> bool {
    let longest = longest_string(value);
    if longest <= CUT_MARK.len() {
        return false;
    }
    cut_first(value, longest, excess)
}

fn cut_first(value: &mut serde_json::Value, target: usize, excess: usize) -> bool {
    match value {
        serde_json::Value::String(text) if text.len() == target => {
            let mut keep = text.len().saturating_sub(excess.saturating_add(CUT_MARK.len()));
            // 截断点必须落在字符边界上，否则 String::truncate 会 panic。
            while !text.is_char_boundary(keep) {
                keep -= 1;
            }
            text.truncate(keep);
            text.push_str(CUT_MARK);
            true
        }
        serde_json::Value::Array(items) => {
            items.iter_mut().any(|item| cut_first(item, target, excess))
        }
        serde_json::Value::Object(map) => {
            map.values_mut().any(|item| cut_first(item, target, excess))
        }
        _ => false,
    }
}

fn cap_strings(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) if text.len() > FIT_STRING => {
            let mut keep = FIT_STRING;
            while !text.is_char_boundary(keep) {
                keep -= 1;
            }
            text.truncate(keep);
            text.push_str(CUT_MARK);
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(cap_strings),
        serde_json::Value::Object(map) => map.values_mut().for_each(cap_strings),
        _ => {}
    }
}

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

/// 事件锁放在会话目录旁边；删除目录时锁文件仍在，旧进程不能在删除后重新追加并复活会话。
pub fn events_lock_path(base: &Path, id: &str) -> PathBuf {
    base.join(format!("{id}.events.lock"))
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
    /// 打开日志准备追加，并修复「上次进程被打断」留下的 running。
    /// 只有已持有租约的调用方才能用它：拿到租约说明当前进程里没有这一轮的 worker，
    /// 日志停在 running 必然是上一次崩溃或被杀，标成 cancelled 才不会再启动一次工具。
    pub fn open(
        base: &Path,
        id: &str,
        root: &str,
        provider: Provider,
        title: &str,
        version: &str,
    ) -> Result<Self, String> {
        Self::open_mode(base, id, root, provider, title, version, true)
    }
    /// 打开已经存在的会话准备启动运行。发送链路绝不能凭一个旧标签或外部队列重建已删除会话。
    pub fn open_existing(
        base: &Path,
        id: &str,
        root: &str,
        provider: Provider,
        title: &str,
        version: &str,
    ) -> Result<Self, String> {
        Self::open_mode(base, id, root, provider, title, version, false)
    }
    fn open_mode(
        base: &Path,
        id: &str,
        root: &str,
        provider: Provider,
        title: &str,
        version: &str,
        create: bool,
    ) -> Result<Self, String> {
        let (mut store, scan) = Self::load(base, id, root, provider, title, version, create)?;
        // 调用方握着租约，就说明本进程里没有这一轮的 worker：日志停在 running
        // 必然是上一次进程被打断的。标成已取消，并且不自动重发消息，避免重复执行工具。
        if let Some(event) = scan.last_status {
            if event.data["status"] == "running" {
                store.append(&event.run_id, vec![("status".into(), serde_json::json!({"status":"cancelled","error":"上次运行未正常结束；未自动重发消息"}))])?;
            }
        }
        Ok(store)
    }
    /// 打开日志只为追加，不做任何状态修复。
    /// 排队、计划决策、状态回写这些调用方没拿租约，此刻很可能正有一轮在跑：
    /// 走 `open` 会把那一轮写成 cancelled，前端的停止按钮和「运行中」标记随即消失，
    /// 而 worker 还在继续往同一个 runId 追加事件——只在竞态下暴露的状态翻转就是这么来的。
    pub fn open_for_append(
        base: &Path,
        id: &str,
        root: &str,
        provider: Provider,
        title: &str,
        version: &str,
    ) -> Result<Self, String> {
        Self::load(base, id, root, provider, title, version, false).map(|(store, _)| store)
    }
    /// 同上，另外带回日志当前的活动任务表（runId → 最后一次未终结的状态记录）。
    /// 写状态前拿它比一比：秒级监控和重复的顺序回写会一遍遍写同一个状态，
    /// 照单全收既撑大事件日志，也让前端每秒重新投影整条会话。
    pub fn open_for_append_with_tasks(
        base: &Path,
        id: &str,
        root: &str,
        provider: Provider,
        title: &str,
        version: &str,
    ) -> Result<(Self, std::collections::HashMap<String, serde_json::Value>), String> {
        let (store, scan) = Self::load(base, id, root, provider, title, version, false)?;
        Ok((store, scan.active_tasks))
    }
    /// 两个打开方式共用的部分：建目录、读元数据、扫出最新序号。
    fn load(
        base: &Path,
        id: &str,
        root: &str,
        provider: Provider,
        title: &str,
        version: &str,
        create: bool,
    ) -> Result<(Self, Scan), String> {
        if !valid_id(id) {
            return Err("无效的会话 ID".into());
        }
        let dir = base.join(id);
        if create {
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        } else if !dir.is_dir() {
            return Err("会话不存在".into());
        }
        // 已有标题以持久化记录为准，旧标签页发送时不能覆盖重命名结果。
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
        let path = dir.join("events.jsonl");
        let length = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let scan = match LogIndex::current(&path, &dir, id) {
            // 索引只认「补读到日志末尾」的那一份：序号连续与归属都是补读时校验过的，
            // 最新序号和活动任务直接取它，不必为了开一次会话把整份日志再解析一遍。
            // 尾巴上有写了一半的行时长度对不上，交给下面那条会截断修复的全量扫描。
            Some(index) if index.length == length => Scan {
                seq: index.latest_seq,
                // 最后一条状态也算「必须在场」：`open` 靠它认出上一次进程被打断的 running。
                last_status: index.status.clone(),
                active_tasks: index.active.iter().filter_map(|task| {
                    Some((task["runId"].as_str()?.to_owned(), task.clone()))
                }).collect(),
                ..Default::default()
            },
            _ => scan_events(&path, true, Window::After(0), 0, id)?,
        };
        let mut store = Self {
            dir,
            meta,
            seq: scan.seq,
            poisoned: false,
        };
        if !version.is_empty() {
            store.meta.cli_version = version.into();
        }
        store.save_meta()?;
        Ok((store, scan))
    }
    /// 共享日志尾部是序号权威来源；非空日志读不出时禁止沿用实例缓存继续写。
    fn tail_seq(file: &mut std::fs::File, len: u64) -> Result<u64, String> {
        if len == 0 {
            return Ok(0);
        }
        let window = len.min(MAX_LINE + 1);
        file.seek(SeekFrom::Start(len - window)).map_err(|e| e.to_string())?;
        let mut buffer = Vec::with_capacity(window as usize);
        std::io::Read::read_to_end(file, &mut buffer).map_err(|e| e.to_string())?;
        // 半行交给打开日志时的恢复流程，不能在半行后直接拼接新事件。
        if buffer.last() != Some(&b'\n') { return Err("会话日志尾部不完整，停止追加".into()); }
        let end = buffer.len() - 1;
        let complete = &buffer[..end];
        let start = complete.iter().rposition(|b| *b == b'\n').map(|p| p + 1).unwrap_or(0);
        let event: Event = serde_json::from_slice(&complete[start..]).map_err(|e| format!("会话日志尾部损坏，停止追加：{e}"))?;
        Ok(event.seq)
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
        let base = self.dir.parent().ok_or("会话存储路径无效")?;
        // 进程内 IO_LOCK 只能挡住本窗口；这个锁覆盖跨进程的尾序号读取与整批追加。
        let _events = crate::sys::ExclusiveFileLock::acquire(&events_lock_path(base, &self.meta.session_id))?;
        if !self.dir.is_dir() {
            return Err("会话不存在".into());
        }
        let path = self.dir.join("events.jsonl");
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        let original_len = file.metadata().map_err(|e| e.to_string())?.len();
        // 共享日志的序号不能只信实例缓存：排队状态、计划结算、导入镜像都是另开 Store
        // 实例的写者，它们推进的序号不会同步进这里的 `self.seq`——照缓存写就会回卷重复
        // （实测日志里 seq 从 8433 倒回 8428）。每次落盘前从文件尾部实读最后一条完整
        // 事件对齐；调用方持有 IO_LOCK，跨进程再由 events.lock 串行，这份实读就是权威值。
        self.seq = Self::tail_seq(&mut file, original_len)?;
        let mut events = Vec::new();
        let mut bytes = Vec::new();
        for (kind, data) in values {
            let mut event = Event {
                session_id: self.meta.session_id.clone(),
                run_id: run.into(),
                seq: self.seq + events.len() as u64 + 1,
                kind,
                data,
            };
            let mut line = serde_json::to_vec(&event).map_err(|e| e.to_string())?;
            if line.len() as u64 >= MAX_LINE {
                event.data = fit_event_data(event.data);
                line = serde_json::to_vec(&event).map_err(|e| e.to_string())?;
            }
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
        let path = dir.join("events.jsonl");
        // 索引把「整份日志」的代价挪到它自己身上：翻页只解析这一页附近，
        // 摘要配对素材、最新序号、活动任务也一并从它那里取。
        let index = LogIndex::current(&path, &dir, id);
        let index_file = LogIndex::file(&dir);
        let fold = match &index {
            Some(index) => pair_compactions(&mut index.episodes.clone(), &index.summaries),
            // 索引建不起来（日志损坏、超出上限）：退回全量扫描，行为与没有索引时一致。
            None => compaction_fold(&path),
        };
        let read_page = |repair: bool| -> Result<Scan, String> {
            if let Some(index) = &index {
                match scan_indexed(&path, repair, window, limit, id, index, &fold) {
                    Ok(scan) => return Ok(scan),
                    // 索引和日志对不上就当它没建过：这一页全量扫，下次重建。
                    Err(_) => { let _ = fs::remove_file(&index_file); }
                }
            }
            scan_events_folded(&path, repair, window, limit, id, &fold)
        };
        let mut scan = read_page(false)?;
        if !active && !scan.active_tasks.is_empty() {
            // 活动摘要可能同时含一个运行项和多个排队项；只有拿到租约才敢逐项修复。
            if let Ok(_lease) = Lease::acquire(&base.join(format!("{id}.lock"))) {
                scan = read_page(true)?;
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
        // 索引是正常路径；索引不可用时，全量扫描仍按同一规则折叠，不返回半张清单。
        let task_list = index.as_ref().and_then(|index| index.task_list.clone()).or_else(|| scan.task_list.clone());
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
            task_list,
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
    /// 全量扫描折叠出的最新模型任务清单；分页窗口不参与这份状态的计算。
    task_list: Option<serde_json::Value>,
    /// 往后翻：还有更新的事件没被这一页装下。
    has_more: bool,
    /// 往前翻：还有更早的事件没被这一页装下。
    has_older: bool,
}

/// task_list 既会发完整快照，也会发 TaskUpdate 稀疏补丁；这里统一折叠成可独立返回的完整状态。
fn fold_task_list(previous: Option<&serde_json::Value>, event: &Event) -> serde_json::Value {
    fn patch(item: &serde_json::Value, index: usize) -> Option<serde_json::Map<String, serde_json::Value>> {
        let source = item.as_object()?;
        let content = source.get("content").and_then(|value| value.as_str());
        let id = source.get("id").and_then(|value| value.as_str()).filter(|value| !value.is_empty())
            .map(str::to_owned).or_else(|| content.filter(|value| !value.is_empty()).map(str::to_owned))
            .unwrap_or_else(|| format!("task-{index}"));
        let mut out = serde_json::Map::new();
        out.insert("id".into(), serde_json::json!(id));
        for key in ["content", "replacesId", "status", "detail"] {
            if let Some(value) = source.get(key).and_then(|value| value.as_str()) {
                out.insert(key.into(), serde_json::json!(value));
            }
        }
        Some(out)
    }
    fn complete(mut item: serde_json::Map<String, serde_json::Value>) -> serde_json::Value {
        item.entry("content").or_insert_with(|| serde_json::json!(""));
        item.entry("status").or_insert_with(|| serde_json::json!("pending"));
        // replacesId 只参与一次身份迁移，不属于最终任务状态。
        item.remove("replacesId");
        serde_json::Value::Object(item)
    }

    let incoming: Vec<_> = event.data["items"].as_array().into_iter().flatten().enumerate()
        .filter_map(|(index, item)| patch(item, index)).collect();
    let replace = event.data["replace"] == true;
    let mut items = previous.and_then(|snapshot| snapshot["items"].as_array()).cloned().unwrap_or_default();
    if replace {
        items = incoming.into_iter().map(complete).collect();
    } else {
        for update in incoming {
            let id = update["id"].as_str().unwrap_or_default();
            let replaces = update.get("replacesId").and_then(|value| value.as_str());
            let found = items.iter().position(|old| old["id"].as_str() == Some(id)
                || replaces.is_some_and(|old_id| old["id"].as_str() == Some(old_id)));
            if let Some(index) = found {
                let mut merged = items[index].as_object().cloned().unwrap_or_default();
                for (key, value) in update {
                    // 空 subject 是 Claude 的“字段缺失”旧形状，不能洗掉 TaskCreate 的正文。
                    if key == "content" && value.as_str().is_some_and(str::is_empty) { continue; }
                    merged.insert(key, value);
                }
                items[index] = complete(merged);
            } else {
                items.push(complete(update));
            }
        }
    }
    serde_json::json!({"seq":event.seq,"runId":event.run_id,"items":items})
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

/// 一次压缩在日志里占的那一段。同一段的几条事件挨着写（开始 → 结束 → 带元数据），
/// 前端把它们合成一张卡；这里只需要这一段落在哪、有没有自己的正文。
#[derive(Clone, Serialize, Deserialize)]
struct CompactionEpisode {
    /// 这一段最后一条事件的序号。正文并到末尾那一条：首屏只装得下日志尾部时也带得上。
    last: u64,
    run_id: String,
    /// 后端在实时事件上盖的段落标识；旧日志里没有，只能按顺序认。
    episode_id: Option<String>,
    /// 这一段开始时原生历史已经写到的字节位置。摘要的 `summaryId` 里带着自己的偏移，
    /// 偏移落在起点之前就不可能是这一段捞出来的——按顺序认亲时也要守这条。
    source_start: Option<u64>,
    has_text: bool,
    /// 上一条是否已经收尾。又来一条「开始」才算新的一次压缩，口径同 `Worker::actions`。
    done: bool,
    /// 已经认领过一条原生摘要。
    resolved: bool,
}

/// 从原生历史捞回来的一条摘要。配对素材随索引存着，读的时候现配。
#[derive(Clone, Serialize, Deserialize)]
struct CompactionSummary {
    seq: u64,
    episode_id: Option<String>,
    /// `summaryId`（`native-1418700`）里带的原生字节偏移。
    at: Option<u64>,
    /// 对应事件行在 Forge 日志里的偏移；索引不复制正文，读取时只 seek 这一行。
    #[serde(default)]
    offset: Option<u64>,
    #[serde(default, skip_serializing)]
    text: String,
}

/// 原生摘要与它所属那一段的对应关系。
#[derive(Default)]
pub struct CompactionFold {
    /// 段落末尾事件的序号 → 要并进去的摘要正文。
    pub text: std::collections::HashMap<u64, String>,
    /// 段落末尾事件序号 →（摘要事件序号，摘要行偏移）。索引路径按需读取正文，
    /// 不再为每次翻页预读会话里的全部压缩摘要。
    offsets: std::collections::HashMap<u64, (u64, u64)>,
    /// 正文已经并走的摘要事件序号 → 它并入的那一条。摘要本身不再单独出现，
    /// 否则同一次压缩在时间线上排两遍；搜索也按这份口径改报命中位置，
    /// 点进去才跳得到一条界面上真有的事件。
    pub merged: std::collections::HashMap<u64, u64>,
}

/// 摘要正文在事件行里的标记；只有含它的行才值得解析，其余整行跳过。
const COMPACTION_MARK: &[u8] = b"\"compaction\"";

/// 把一条 `compaction` 事件并进压缩素材。
///
/// 索引构建与兜底的全量扫描共用这一份口径：两处各写一遍，迟早会出现
/// 「重建一次索引之后摘要配对变了」这种只在长会话里才看得见的偏差。
fn classify_compaction(
    event: &Event,
    episodes: &mut Vec<CompactionEpisode>,
    summaries: &mut Vec<CompactionSummary>,
    offset: Option<u64>,
) {
    let text = event.data["text"].as_str().unwrap_or_default();
    let episode_id = event.data["episodeId"].as_str().map(str::to_owned);
    if let Some(id) = event.data["summaryId"].as_str().filter(|_| !text.is_empty()) {
        summaries.push(CompactionSummary {
            seq: event.seq,
            episode_id,
            at: id.strip_prefix("native-").and_then(|digits| digits.parse::<u64>().ok()),
            offset,
            text: text.to_owned(),
        });
        return;
    }
    let source_start = event.data["sourceStart"].as_u64();
    if let Some(id) = &episode_id {
        if let Some(hit) = episodes.iter_mut().find(|episode| episode.episode_id.as_deref() == Some(id)) {
            hit.has_text |= !text.is_empty();
            hit.source_start = hit.source_start.or(source_start);
            hit.last = event.seq;
            return;
        }
    }
    let starting = matches!(event.data["status"].as_str(), Some("running" | "compacting"));
    match episodes.last_mut() {
        // 同一段的后续事件；「已经收尾又开始」才是新的一次压缩。
        Some(last) if last.run_id == event.run_id && episode_id.is_none() && !(starting && last.done) => {
            last.has_text |= !text.is_empty();
            last.source_start = last.source_start.or(source_start);
            last.done = !starting;
            last.last = event.seq;
        }
        _ => episodes.push(CompactionEpisode {
            last: event.seq,
            run_id: event.run_id.clone(),
            episode_id,
            source_start,
            has_text: !text.is_empty(),
            done: !starting,
            resolved: false,
        }),
    }
}

/// 把摘要配回它所属那一段。
///
/// 旧日志里的摘要没有段落标识，只能按顺序认：正文只可能是那一段自己没写出来的，
/// 而捞回来的顺序就是原生顺序，两边一路排下来一一对应。认不出来就原样留着，宁可多一张卡，
/// 也不把摘要贴到另一次压缩上。
fn pair_compactions(episodes: &mut [CompactionEpisode], summaries: &[CompactionSummary]) -> CompactionFold {
    let mut fold = CompactionFold::default();
    let mut by_id = std::collections::HashMap::<String, std::collections::VecDeque<usize>>::new();
    for (index, episode) in episodes.iter().enumerate() {
        if let Some(id) = &episode.episode_id {
            by_id.entry(id.clone()).or_default().push_back(index);
        }
    }
    let mut legacy = 0usize;
    for summary in summaries {
        // 有身份的现代日志直接按 id 取；旧日志按顺序单调前进。两条路径都只看每个段落一次。
        let hit = if let Some(id) = &summary.episode_id {
            let mut found = None;
            if let Some(queue) = by_id.get_mut(id) {
                while let Some(&index) = queue.front() {
                    let episode = &episodes[index];
                    if episode.resolved || episode.has_text {
                        queue.pop_front();
                        continue;
                    }
                    // 摘要只可能认领排在它之前的段落；未来摘要仍可能认领这一条，不能弹掉。
                    if episode.last >= summary.seq { break; }
                    queue.pop_front();
                    found = Some(index);
                    break;
                }
            }
            found
        } else {
            let mut found = None;
            while legacy < episodes.len() {
                let index = legacy;
                let episode = &episodes[index];
                if episode.episode_id.is_some() || episode.resolved || episode.has_text {
                    legacy += 1;
                    continue;
                }
                if episode.last >= summary.seq { break; }
                // 原生偏移按时间递增；当前段落起点已经越过摘要时，宁可不配，也不向后误配。
                if matches!((episode.source_start, summary.at), (Some(start), Some(at)) if start > at) { break; }
                legacy += 1;
                found = Some(index);
                break;
            }
            found
        };
        if let Some(index) = hit {
            let episode = &mut episodes[index];
            episode.resolved = true;
            episode.has_text = true;
            fold.merged.insert(summary.seq, episode.last);
            if !summary.text.is_empty() {
                fold.text.insert(episode.last, summary.text.clone());
            }
            if let Some(offset) = summary.offset {
                fold.offsets.insert(episode.last, (summary.seq, offset));
            }
        }
    }
    fold
}

/// 扫一遍日志收集压缩素材。配对本身要等两边都到齐，很便宜，所以单独一步。
fn compaction_material(path: &Path) -> (Vec<CompactionEpisode>, Vec<CompactionSummary>) {
    let mut episodes = vec![];
    let mut summaries = vec![];
    let Ok(file) = File::open(path) else { return (episodes, summaries) };
    let mut reader = BufReader::new(file);
    let mut bytes = vec![];
    loop {
        bytes.clear();
        let count = reader.by_ref().take(MAX_LINE + 1).read_until(b'\n', &mut bytes).unwrap_or(0);
        if count == 0 {
            break;
        }
        if count as u64 > MAX_LINE {
            return (vec![], vec![]);
        }
        if memchr::memmem::find(&bytes, COMPACTION_MARK).is_none() {
            continue;
        }
        let Ok(event) = serde_json::from_slice::<Event>(&bytes) else { continue };
        if event.kind != "compaction" {
            continue;
        }
        classify_compaction(&event, &mut episodes, &mut summaries, None);
    }
    (episodes, summaries)
}

/// 把「从原生日志捞回来的压缩摘要」并回它发生的位置。
///
/// 实时协议不带摘要正文（Claude 只报边界，Codex 只报开始/结束），正文只存在于原生历史里，
/// 而捞回来是追加到 Forge 自己日志末尾的，于是拿到最大序号、渲染到时间线最下面——同一次压缩
/// 出现两遍，第二遍还离原位很远。前端没法修：它只看得到当前这一页，两张卡很少同页。
/// 所以配对在这里做，看的是整份日志。
pub fn compaction_fold(path: &Path) -> CompactionFold {
    let (mut episodes, summaries) = compaction_material(path);
    pair_compactions(&mut episodes, &summaries)
}

/// 已索引到日志的哪个字节位置、每 `ANCHOR_EVERY` 条事件的一次落点。
const INDEX_VERSION: u32 = 3;
const ANCHOR_EVERY: u64 = 64;
const MAX_INDEX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_INDEX_PROMPTS: usize = 64;

/// 事件日志的稀疏索引，与日志放在同一个会话目录里（`events.idx`）。
///
/// 翻一页原本要把整份日志从第 0 字节读一遍、每行都解析：10 MB 的会话一页 300 ms，
/// 而且往前翻第 2 页和第 20 页一样贵。索引每 64 条事件记一次「序号 → 字节偏移」，
/// 翻页时 seek 过去只解析这一页附近；同一趟扫描顺带留下最新序号、活动任务、最后一条状态
/// 与压缩素材——这几样原本也要求看完整个文件，才让「整份扫描不能省」说得通。
///
/// 索引只是缓存：内容全部由日志推导，对不上就整份重建。日志只追加，所以过期只有一种形态
/// ——比日志短一段，补读那一段即可；比日志还长只可能是日志被截断，重建。
#[derive(Serialize, Deserialize)]
struct LogIndex {
    version: u32,
    /// 索引只属于目录名对应的会话；复制来的同长度缓存也不能冒充。
    session_id: String,
    length: u64,
    latest_seq: u64,
    /// (事件序号, 该行在文件里的起始字节)。升序。
    anchors: Vec<(u64, u64)>,
    /// 未终结任务的最新摘要，形状与扫描时写进 `Scan::active_tasks` 的一模一样。
    active: Vec<serde_json::Value>,
    /// 还没被某个「运行中」状态消费掉的提示词（runId → 正文）。
    /// 一个回合在第一次状态出现时就消费掉，剩下的多是导入历史那种没有状态的 runId。
    prompts: Vec<(String, String)>,
    /// 最后一条状态事件。
    status: Option<Event>,
    /// 最新模型任务清单的完整快照；与时间线分页分离，重开会话也能直接恢复。
    task_list: Option<serde_json::Value>,
    episodes: Vec<CompactionEpisode>,
    summaries: Vec<CompactionSummary>,
}

impl LogIndex {
    fn file(dir: &Path) -> PathBuf {
        dir.join("events.idx")
    }
    fn empty(session_id: &str) -> Self {
        Self {
            version: INDEX_VERSION,
            session_id: session_id.to_owned(),
            length: 0,
            latest_seq: 0,
            anchors: vec![],
            active: vec![],
            prompts: vec![],
            status: None,
            task_list: None,
            episodes: vec![],
            summaries: vec![],
        }
    }
    /// 读一份版本对得上的索引；坏了或版本不符都当没有，由调用方重建。
    fn read(dir: &Path) -> Option<Self> {
        let path = Self::file(dir);
        // 先看 metadata，再读内容；坏掉的超大缓存不能先整份分配进内存。
        if fs::metadata(&path).ok()?.len() > MAX_INDEX_BYTES { return None; }
        let bytes = fs::read(path).ok()?;
        let index: Self = serde_json::from_slice(&bytes).ok()?;
        (index.version == INDEX_VERSION).then_some(index)
    }
    fn save(&self, dir: &Path) -> Result<(), String> {
        let text = serde_json::to_string(self).map_err(|e| e.to_string())?;
        if text.len() as u64 > MAX_INDEX_BYTES { return Err("会话事件索引超过容量上限".into()); }
        crate::sys::write_atomic(
            &Self::file(dir),
            &text,
        )
    }
    /// 取一份与日志对齐的索引：没有就建（一次全量扫描），过期就只补读新增的那一段。
    fn current(path: &Path, dir: &Path, session_id: &str) -> Option<Self> {
        if let Some(mut index) = Self::read(dir).filter(|index| index.session_id == session_id) {
            match index.catch_up(path, session_id) {
                Ok(changed) => {
                    if changed {
                        let _ = index.save(dir);
                    }
                    return Some(index);
                }
                // 比日志长（日志被截断）或中段对不上：这份缓存作废，下面重建。
                Err(_) => {}
            }
        }
        let mut index = Self::empty(session_id);
        if index.catch_up(path, session_id).is_err() {
            return None;
        }
        let _ = index.save(dir);
        Some(index)
    }
    /// 把索引推进到日志当前末尾，只解析新增的那一段。返回索引是否长长了。
    fn catch_up(&mut self, path: &Path, session_id: &str) -> Result<bool, String> {
        let length = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if length < self.length {
            return Err("日志比索引短".into());
        }
        if length == self.length {
            return Ok(false);
        }
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        file.seek(SeekFrom::Start(self.length)).map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(file);
        let mut offset = self.length;
        let mut bytes = vec![];
        loop {
            bytes.clear();
            let count = reader.by_ref().take(MAX_LINE + 1).read_until(b'\n', &mut bytes).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            if count as u64 > MAX_LINE {
                return Err("会话事件过大".into());
            }
            // 写了一半的尾巴不进索引：它还不是一条完整事件，留给下一次。
            if bytes.last() != Some(&b'\n') {
                break;
            }
            let event: Event = serde_json::from_slice(&bytes)
                .map_err(|e| format!("会话日志中段损坏，保留原文件：{e}"))?;
            if event.seq != self.latest_seq + 1 {
                return Err("会话事件序列不连续".into());
            }
            if event.session_id != session_id || !valid_id(&event.run_id) {
                return Err("会话事件归属不匹配".into());
            }
            self.push(event, offset);
            offset += count as u64;
        }
        self.length = offset;
        Ok(true)
    }
    /// 把一条事件并进索引。`offset` 是这一行在日志里的起始字节。
    fn push(&mut self, event: Event, offset: u64) {
        if (event.seq - 1) % ANCHOR_EVERY == 0 {
            self.anchors.push((event.seq, offset));
        }
        self.latest_seq = event.seq;
        if event.kind == "task_list" {
            self.task_list = Some(fold_task_list(self.task_list.as_ref(), &event));
        }
        match event.kind.as_str() {
            "compaction" => classify_compaction(&event, &mut self.episodes, &mut self.summaries, Some(offset)),
            // 用户消息里混着 CLI 自己写的注入：投影时挡、扫描时挡，这里也要挡，
            // 因为活动任务摘要里的 prompt 正是从这里取的。
            "user" => {
                if let Some(body) = event.data["text"].as_str() {
                    if let Some(spoken) = super::history::human_text(body) {
                        match self.prompts.iter_mut().find(|(run, _)| run == &event.run_id) {
                            Some(entry) => entry.1 = spoken.to_owned(),
                            None => self.prompts.push((event.run_id.clone(), spoken.to_owned())),
                        }
                        if self.prompts.len() > MAX_INDEX_PROMPTS {
                            self.prompts.drain(..self.prompts.len() - MAX_INDEX_PROMPTS);
                        }
                    }
                }
            }
            "status" => self.push_status(event),
            _ => {}
        }
    }
    fn take_prompt(&mut self, run: &str) -> Option<String> {
        let at = self.prompts.iter().position(|(old, _)| old == run)?;
        Some(self.prompts.remove(at).1)
    }
    /// 与 `scan_events_folded` 里那段状态处理逐条对齐：两边写出来的 `active_tasks`
    /// 必须是同一份数据，否则「有没有活动任务」这个判定会随读到哪一页而变。
    fn push_status(&mut self, event: Event) {
        let status = event.data["status"].as_str().unwrap_or_default().to_owned();
        if super::task_status::is_live(&status) {
            let previous = self.active.iter()
                .find(|task| task["runId"].as_str() == Some(event.run_id.as_str()))
                .cloned();
            let prompt = event.data["prompt"].as_str().map(str::to_owned)
                .or_else(|| self.take_prompt(&event.run_id))
                .or_else(|| previous.as_ref().and_then(|task| task["prompt"].as_str()).map(str::to_owned));
            let queue_index = event.data["queueIndex"].as_u64()
                .or_else(|| previous.as_ref().and_then(|task| task["queueIndex"].as_u64()));
            let task = serde_json::json!({
                "runId": event.run_id.clone(),
                "status": status,
                "seq": event.seq,
                "prompt": prompt,
                "queueIndex": queue_index,
            });
            match self.active.iter_mut().find(|old| old["runId"] == task["runId"]) {
                Some(old) => *old = task,
                None => self.active.push(task),
            }
        } else if super::task_status::is_terminal(&status) {
            self.active.retain(|task| task["runId"].as_str() != Some(event.run_id.as_str()));
            self.prompts.retain(|(run, _)| run != &event.run_id);
        }
        self.status = Some(event);
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
    scan_events_folded(path, repair, window, limit, session_id, &CompactionFold::default())
}

fn scan_events_folded(
    path: &Path,
    repair: bool,
    window: Window,
    limit: usize,
    session_id: &str,
    fold: &CompactionFold,
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
        let mut event: Event = serde_json::from_slice(&bytes)
            .map_err(|e| format!("会话日志中段损坏，保留原文件：{e}"))?;
        if event.seq != scan.seq + 1 {
            return Err("会话事件序列不连续".into());
        }
        if event.session_id != session_id || !valid_id(&event.run_id) {
            return Err("会话事件归属不匹配".into());
        }
        scan.seq = event.seq;
        if event.kind == "task_list" {
            scan.task_list = Some(fold_task_list(scan.task_list.as_ref(), &event));
        }
        // role=user 的记录里混着 CLI 自己写的系统注入（AGENTS.md 指令、环境上下文、任务通知）。
        // 回放时已经不再写入这种事件，但旧日志里躺着的那些仍会被翻出来当成用户气泡，
        // 所以在读的这一层一并挡掉：整条都是注入就不进页，混着人话就只留人话。
        if event.kind == "user" {
            if let Some(body) = event.data["text"].as_str() {
                match super::history::human_text(body) {
                    Some(spoken) => {
                        if spoken != body {
                            event.data["text"] = serde_json::json!(spoken);
                        }
                        scan.pending_prompts.insert(event.run_id.clone(), spoken);
                    }
                    None => {
                        offset += count as u64;
                        continue;
                    }
                }
            }
        }
        // 正文已经并进所属那一段的原生摘要，不再单独进页：它追加在日志末尾，
        // 单独出现就是同一次压缩在时间线上排两遍，第二遍还离原位很远。
        if fold.merged.contains_key(&event.seq) {
            offset += count as u64;
            continue;
        }
        // 并进来的正文让这一行变宽，页预算要按变宽之后的算；文件偏移仍按读到的原始行宽走。
        let mut width = count as u64;
        if event.kind == "compaction" {
            if let Some(text) = fold.text.get(&event.seq) {
                event.data["text"] = serde_json::json!(text);
                width += text.len() as u64;
            }
        }
        if event.kind == "status" {
            let status = event.data["status"].as_str().unwrap_or_default();
            if super::task_status::is_live(status) {
                let pending_prompt = scan.pending_prompts.remove(&event.run_id);
                // 编辑和重排写在状态事件里，摘要必须保留最新值。
                let previous = scan.active_tasks.get(&event.run_id);
                let prompt = event.data["prompt"].as_str().map(str::to_owned).or(pending_prompt)
                    .or_else(|| scan.active_tasks.get(&event.run_id).and_then(|task| task["prompt"].as_str()).map(str::to_owned));
                let queue_index = event.data["queueIndex"].as_u64().or_else(|| previous.and_then(|task| task["queueIndex"].as_u64()));
                scan.active_tasks.insert(event.run_id.clone(), serde_json::json!({
                    "runId": event.run_id,
                    "status": status,
                    "seq": event.seq,
                    "prompt": prompt,
                    "queueIndex": queue_index,
                }));
            } else if super::task_status::is_terminal(status) {
                scan.active_tasks.remove(&event.run_id);
                scan.pending_prompts.remove(&event.run_id);
            }
            scan.last_status = Some(event.clone());
        }
        scan.accept(window, limit, event, width);
        offset += count as u64;
    }
    Ok(scan)
}

/// 用索引取一页。往前翻要求凑满一页：被挡掉的注入消息、被并走的摘要都不占条目，
/// 只按事件数挑锚点会短一截，短了就退到更早一个锚点重来，退到日志开头为止。
fn scan_indexed(
    path: &Path,
    repair: bool,
    window: Window,
    limit: usize,
    session_id: &str,
    index: &LogIndex,
    fold: &CompactionFold,
) -> Result<Scan, String> {
    if index.latest_seq == 0 {
        return Ok(Scan::default());
    }
    let mut start = start_anchor(index, window, limit);
    let mut retreat = 1usize;
    loop {
        let mut scan = scan_from_anchor(path, repair, window, limit, session_id, index, fold, start)?;
        let short = matches!(window, Window::Before(_)) && scan.page.len() < limit && !scan.has_older;
        if short && start > 0 {
            // 被过滤的长尾不能每次只退一个锚点并重扫同一后缀；指数退避让累计解析量保持线性。
            start = start.saturating_sub(retreat);
            retreat = retreat.saturating_mul(2);
            continue;
        }
        // 从日志开头都读过了就是真的没有更早的了（`accept` 挤出过条目时它自己已经记了）。
        if matches!(window, Window::Before(_)) && start > 0 {
            scan.has_older = true;
        }
        return Ok(scan);
    }
}

/// 这一页从哪个锚点开始读。
fn start_anchor(index: &LogIndex, window: Window, limit: usize) -> usize {
    let want = match window {
        // 最后一个不晚于 `after` 的锚点：从它读起，前面那几十条按窗口跳过。
        Window::After(after) => after,
        // 这一页装的是「窗口之前最近的那些」，解析区间至少要够 limit 条事件。
        Window::Before(before) => (index.latest_seq + 1).min(before).saturating_sub(limit as u64),
    };
    index.anchors.partition_point(|(seq, _)| *seq <= want).saturating_sub(1)
}

/// 从一个锚点读到这一页的窗口边界。`repair` 时把写了一半的尾巴截掉，口径同全量扫描。
fn scan_from_anchor(
    path: &Path,
    repair: bool,
    window: Window,
    limit: usize,
    session_id: &str,
    index: &LogIndex,
    fold: &CompactionFold,
    start: usize,
) -> Result<Scan, String> {
    let (start_seq, start_offset) = index.anchors.get(start).copied().unwrap_or((1, 0));
    let mut scan = Scan {
        // 这几项原本要靠看完整个文件才算得出来，索引在补读日志时已经按同一份口径算过。
        seq: index.latest_seq,
        last_status: index.status.clone(),
        active_tasks: index.active.iter().filter_map(|task| {
            Some((task["runId"].as_str()?.to_owned(), task.clone()))
        }).collect(),
        ..Default::default()
    };
    let mut file = match OpenOptions::new().read(true).write(repair).open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Scan::default()),
        Err(e) => return Err(e.to_string()),
    };
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_LOG {
        return Err("会话日志超出上限".into());
    }
    file.seek(SeekFrom::Start(start_offset)).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let mut offset = start_offset;
    let mut previous = start_seq.saturating_sub(1);
    let mut bytes = vec![];
    loop {
        bytes.clear();
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
        let mut event: Event = serde_json::from_slice(&bytes)
            .map_err(|e| format!("会话日志中段损坏，保留原文件：{e}"))?;
        if event.seq != previous + 1 {
            return Err("会话事件序列不连续".into());
        }
        if event.session_id != session_id || !valid_id(&event.run_id) {
            return Err("会话事件归属不匹配".into());
        }
        previous = event.seq;
        // 窗口之外的事件与这一页无关：往前翻到边界就停，不必读到日志末尾。
        if matches!(window, Window::Before(before) if event.seq >= before) {
            break;
        }
        if event.kind == "user" {
            if let Some(body) = event.data["text"].as_str() {
                if let Some(spoken) = super::history::human_text(body) {
                    if spoken != body {
                        event.data["text"] = serde_json::json!(spoken);
                    }
                } else {
                    offset += count as u64;
                    continue;
                }
            }
        }
        if fold.merged.contains_key(&event.seq) {
            offset += count as u64;
            continue;
        }
        let mut width = count as u64;
        if event.kind == "compaction" {
            if let Some(text) = fold.text.get(&event.seq) {
                event.data["text"] = serde_json::json!(text);
                width += text.len() as u64;
            } else if let Some((summary_seq, summary_offset)) = fold.offsets.get(&event.seq) {
                let text = read_compaction_summary(path, *summary_offset, *summary_seq)?;
                event.data["text"] = serde_json::json!(text);
                width += event.data["text"].as_str().map_or(0, |value| value.len() as u64);
            }
        }
        scan.accept(window, limit, event, width);
        offset += count as u64;
        // 往后翻装不下就说明还有更多，后面的不必再读。
        if scan.has_more {
            break;
        }
    }
    Ok(scan)
}

/// 索引只保存摘要行偏移；当前页真的包含对应压缩卡时才读取这一行正文。
fn read_compaction_summary(path: &Path, offset: u64, expected_seq: u64) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    BufReader::new(file).take(MAX_LINE + 1).read_until(b'\n', &mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_LINE { return Err("压缩摘要事件过大".into()); }
    let event: Event = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if event.seq != expected_seq || event.kind != "compaction" { return Err("压缩摘要索引与日志不一致".into()); }
    Ok(event.data["text"].as_str().unwrap_or_default().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use Provider::Codex as TestProvider;
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
    fn append_resyncs_seq_against_interleaved_writers() {
        // 两个 Store 实例同时写一份日志（worker 实例 + 排队状态的新开实例）：
        // B 推进了文件序号之后，A 的下一批必须从文件尾实读对齐，不能按过期缓存回卷重复。
        let base = fixture();
        let mut a = Store::open(&base, "session", "root", TestProvider, "t", "").unwrap();
        a.append("run-a", vec![("text".into(), json!({"id": "m", "text": "one"}))]).unwrap();
        let mut b = Store::open(&base, "session", "root", TestProvider, "t", "").unwrap();
        b.append("run-b", vec![
            ("status".into(), json!({"status": "cancelled"})),
            // 合法长事件超过旧 64 KiB 尾部窗口，仍必须取得完整序号。
            ("user".into(), json!({"text": "长提示词".repeat(20_000)})),
        ]).unwrap();
        a.append("run-a", vec![("tool".into(), json!({"id": "t1", "name": "exec", "status": "running"}))]).unwrap();
        // 重新打开扫描：序号必须连续，没有重复。
        let scan = scan_events(&base.join("session").join("events.jsonl"), false, Window::After(0), 0, "session").unwrap();
        assert_eq!(scan.seq, 4);
        let mut seen = std::collections::HashSet::new();
        for line in io_read_all(&base.join("session").join("events.jsonl")) {
            let e: Event = serde_json::from_slice(&line).unwrap();
            assert!(seen.insert(e.seq), "duplicate seq {}", e.seq);
            assert_eq!(e.seq, seen.len() as u64, "sequence gap at {}", e.seq);
        }
    }

    #[test]
    fn deleted_session_cannot_be_recreated_by_an_old_append_handle() {
        let base = fixture();
        let mut stale = Store::open(&base, "session", "root", TestProvider, "t", "").unwrap();
        fs::remove_dir_all(base.join("session")).unwrap();

        let error = stale.append("run", vec![("status".into(), json!({"status":"queued"}))]).unwrap_err();
        assert!(error.contains("会话不存在"));
        assert!(!base.join("session").exists(), "旧队列不得复活已删除会话");
        assert!(Store::open_for_append(&base, "session", "root", TestProvider, "t", "").is_err());
        assert!(!base.join("session").exists(), "只追加打开也不得创建目录");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn appending_without_a_lease_never_cancels_a_live_run() {
        // 排队一条消息、写一条状态回写，都会重新打开日志，而那一轮往往还活着。
        // 带修复的 open 会把它写成 cancelled：前端的停止按钮和「运行中」随即消失，
        // worker 却还在往同一个 runId 追加事件。真实日志里这样的假取消有八条，
        // 其中六条后面还跟着 948 / 549 / 1843 / 2214 / 422 条事件。
        let p = fixture();
        let mut live = Store::open(&p, "session", "root", Provider::Codex, "t", "").unwrap();
        live.append("run", vec![("status".into(), json!({"status":"running"}))]).unwrap();

        let plain = Store::open_for_append(&p, "session", "root", Provider::Codex, "t", "").unwrap();
        assert_eq!(plain.seq, 1, "只为追加而打开时不能补写任何事件");
        let (_, tasks) = Store::open_for_append_with_tasks(&p, "session", "root", Provider::Codex, "t", "").unwrap();
        assert_eq!(tasks.get("run").unwrap()["status"].as_str(), Some("running"), "活动任务表要能用来挡重复状态");

        // 握着租约的调用方仍然要修复上一次进程被打断留下的 running。
        let repaired = Store::open(&p, "session", "root", Provider::Codex, "t", "").unwrap();
        assert_eq!(repaired.seq, 2);
        let tail = scan_events(&p.join("session").join("events.jsonl"), false, Window::After(0), 0, "session").unwrap();
        assert_eq!(tail.last_status.unwrap().data["status"].as_str(), Some("cancelled"));
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn already_stored_system_injections_never_reach_a_page() {
        // 旧版本把 CLI 注入的 user 记录原样写进了日志（本机 9 份日志里有 7 条）。
        // 日志只追加、不改旧行，所以只能在读出来分页的这一层挡掉。
        let p = fixture();
        let mut s = Store::open(&p, "session", "root", Provider::Codex, "t", "").unwrap();
        s.append(
            "native",
            vec![
                ("user".into(), json!({"id":"a","text":"# AGENTS.md instructions <INSTRUCTIONS>始终使用简体中文</INSTRUCTIONS>"})),
                ("user".into(), json!({"id":"b","text":"真人说的那句话"})),
            ],
        )
        .unwrap();
        let page = Store::page(&p, "session", "root", Window::Before(u64::MAX), 10, false).unwrap();
        let spoken: Vec<_> = page
            .events
            .iter()
            .filter(|event| event.kind == "user")
            .map(|event| event.data["text"].as_str().unwrap_or_default().to_owned())
            .collect();
        assert_eq!(spoken, ["真人说的那句话"], "整条都是注入的 user 事件不该进页");
        assert_eq!(page.latest_seq, 2, "挡掉一条不能改动日志序号");

        // 活动任务摘要里的提示词同样只留人话：注入被追加在真人消息后面时不能一起端上去。
        let mut mixed = Store::open(&p, "mixed", "root", Provider::Codex, "t", "").unwrap();
        mixed
            .append(
                "run",
                vec![
                    ("user".into(), json!({"text":"继续 <turn_aborted>The user interrupted the previous turn.</turn_aborted>"})),
                    ("status".into(), json!({"status":"queued"})),
                ],
            )
            .unwrap();
        let queued = Store::page(&p, "mixed", "root", Window::After(0), 10, true).unwrap();
        assert_eq!(queued.active_tasks[0]["prompt"], "继续");
        assert_eq!(queued.events.iter().find(|event| event.kind == "user").unwrap().data["text"], "继续");
        fs::remove_dir_all(p).unwrap();
    }

    fn io_read_all(path: &Path) -> Vec<Vec<u8>> {
        std::fs::read(path)
            .unwrap()
            .split(|b| *b == b'\n')
            .filter(|l| !l.is_empty())
            .map(|l| l.to_vec())
            .collect()
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
        queued.append("queued-run", vec![("status".into(), json!({"status":"queued","prompt":"edited","queueIndex":1}))]).unwrap();
        let edited = Store::page(&p, "queued-session", "root", Window::After(0), 10, true).unwrap();
        let task = edited.active_tasks.iter().find(|task| task["runId"] == "queued-run").unwrap();
        assert_eq!(task["prompt"], "edited");
        assert_eq!(task["queueIndex"], 1);
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
    fn oversized_event_is_truncated_instead_of_rejected() {
        let p = fixture();
        let mut s = Store::open(&p, "session", "root", Provider::Claude, "title", "1").unwrap();
        let events = s
            .append(
                "run",
                vec![(
                    "tool".into(),
                    serde_json::json!({
                        "name": "Bash",
                        "status": "completed",
                        "output": "x".repeat(5 * 1024 * 1024),
                    }),
                )],
            )
            .unwrap();
        assert_eq!(events.len(), 1);
        // 结构性字段留着，只有超长正文被裁：工具卡还能渲染，输出末尾有截断标记。
        assert_eq!(events[0].data["name"], "Bash");
        let text = events[0].data["output"].as_str().unwrap();
        assert!(text.ends_with(CUT_MARK));
        assert!(text.len() < MAX_LINE as usize);
        // 落盘与广播是同一份内容：重新打开读到的是裁剪后的那条。
        let page = Store::page(&p, "session", "root", Window::After(0), 10, false).unwrap();
        assert_eq!(page.events[0].data["output"].as_str().unwrap(), text);
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

    /// 三次压缩：第一次自带正文，后两次等着原生摘要补。摘要按追加顺序落在日志末尾。
    fn compaction_log(p: &Path) {
        let mut s = Store::open(p, "session", "root", Provider::Claude, "t", "").unwrap();
        s.append("run-1", vec![
            ("compaction".into(), json!({"status":"compacting","text":"第一次的摘要"})),
            ("compaction".into(), json!({"status":"compacting"})),
            ("compaction".into(), json!({"metadata":{"pre_tokens":10},"status":null})),
        ]).unwrap();
        s.append("run-2", vec![
            ("compaction".into(), json!({"status":"compacting"})),
            ("compaction".into(), json!({"metadata":{"pre_tokens":20},"status":null})),
        ]).unwrap();
        s.append("run-3", vec![
            ("compaction".into(), json!({"status":"compacting"})),
            ("compaction".into(), json!({"metadata":{"pre_tokens":30},"status":null})),
        ]).unwrap();
        s.append("native", vec![
            ("compaction".into(), json!({"status":"completed","summaryId":"native-5886238","text":"第二次的摘要"})),
            ("compaction".into(), json!({"status":"completed","summaryId":"native-7768463","text":"第三次的摘要"})),
        ]).unwrap();
    }

    #[test]
    fn a_recovered_summary_fills_the_compaction_it_belongs_to() {
        // 实时协议不带摘要正文，正文只存在于原生历史里，而捞回来是追加到日志末尾的：
        // 拿到最大序号、渲染到时间线最下面。本机 c3314013 就是这样——实时压缩在
        // 1183/2379/4013/5262，捞回的摘要在 5366/5367（全日志 5370 条），同一次压缩显示两遍。
        // 前端修不了：它只看得到当前这一页，两张卡很少同页。
        let p = fixture();
        compaction_log(&p);
        let page = Store::page(&p, "session", "root", Window::Before(u64::MAX), 500, false).unwrap();
        let compactions: Vec<_> = page.events.iter().filter(|event| event.kind == "compaction").collect();
        // 摘要事件不再单独出现，七条实时事件就是三次压缩。
        assert_eq!(compactions.len(), 7);
        assert!(compactions.iter().all(|event| !event.data["summaryId"].is_string()));
        let text_at = |seq: u64| compactions.iter().find(|event| event.seq == seq)
            .and_then(|event| event.data["text"].as_str()).unwrap_or_default().to_owned();
        // 正文并到每一段末尾那一条：首屏只装得下日志尾部时也带得上。
        assert_eq!(text_at(1), "第一次的摘要", "自带正文的那次不能被别人的摘要盖掉");
        assert_eq!(text_at(5), "第二次的摘要");
        assert_eq!(text_at(7), "第三次的摘要");
        // 页预算按并宽之后的行算，游标仍按日志真实的最新一条走。
        assert_eq!(page.latest_seq, 9);
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn the_fold_does_not_depend_on_which_page_you_asked_for() {
        // 往前翻到只剩第二次压缩那一段：摘要事件根本不在这一页里，正文照样要在。
        let p = fixture();
        compaction_log(&p);
        let page = Store::page(&p, "session", "root", Window::Before(6), 500, false).unwrap();
        assert_eq!(page.events.iter().map(|event| event.seq).collect::<Vec<_>>(), vec![1, 2, 3, 4, 5]);
        let anchor = page.events.iter().find(|event| event.seq == 5).unwrap();
        assert_eq!(anchor.data["text"].as_str(), Some("第二次的摘要"));
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn an_episode_id_outranks_the_order_of_arrival() {
        // 后端盖过段落标识时按标识认亲：一条摘要排在两次压缩之后，
        // 只按顺序会把它配给第一次，标识必须把它配回它真正属于的那一次。
        let p = fixture();
        let mut s = Store::open(&p, "session", "root", Provider::Codex, "t", "").unwrap();
        s.append("run", vec![
            ("compaction".into(), json!({"episodeId":"run:1","sourceStart":10,"status":"running"})),
            ("compaction".into(), json!({"episodeId":"run:1","sourceStart":10,"status":"completed"})),
            ("compaction".into(), json!({"episodeId":"run:2","sourceStart":10,"status":"running"})),
            ("compaction".into(), json!({"episodeId":"run:2","sourceStart":10,"status":"completed"})),
            ("compaction".into(), json!({"episodeId":"run:2","status":"completed","summaryId":"native-900","text":"第二次的摘要"})),
        ]).unwrap();
        let page = Store::page(&p, "session", "root", Window::Before(u64::MAX), 500, false).unwrap();
        assert_eq!(page.events.iter().map(|event| event.seq).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
        assert!(page.events.iter().all(|event| event.data["text"].as_str().unwrap_or_default().is_empty() || event.seq == 4));
        assert_eq!(page.events.iter().find(|event| event.seq == 4).unwrap().data["text"].as_str(), Some("第二次的摘要"));
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn a_summary_from_before_the_run_never_fills_its_compaction() {
        // 摘要的 summaryId 里带着它在原生历史里的字节偏移，实时事件记着那一轮开始时的偏移。
        // 偏移落在起点之前，说明这条摘要不是这一轮捞出来的：没有段落标识也不许按顺序硬凑。
        let p = fixture();
        let mut s = Store::open(&p, "session", "root", Provider::Claude, "t", "").unwrap();
        s.append("run-1", vec![
            ("compaction".into(), json!({"status":"compacting","sourceStart":5000})),
            ("compaction".into(), json!({"status":"completed","sourceStart":5000})),
        ]).unwrap();
        s.append("native", vec![
            ("compaction".into(), json!({"status":"completed","summaryId":"native-1000","text":"更早的摘要"})),
        ]).unwrap();
        let page = Store::page(&p, "session", "root", Window::Before(u64::MAX), 500, false).unwrap();
        assert_eq!(page.events.len(), 3, "认不上就原样留着");
        assert_eq!(page.events[2].data["text"].as_str(), Some("更早的摘要"));
        assert!(page.events[0].data["text"].as_str().unwrap_or_default().is_empty());
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn a_summary_with_no_compaction_to_fill_stays_on_its_own() {
        // 整段从原生日志导入的会话里，Codex 的 compacted 记录就是那次压缩的唯一记录，
        // 没有实时事件可并。找不到锚就原样留着：宁可多一张卡，也不能把正文丢掉。
        let p = fixture();
        let mut s = Store::open(&p, "session", "root", Provider::Codex, "t", "").unwrap();
        s.append("native", vec![
            ("compaction".into(), json!({"status":"completed","summaryId":"native-100","text":"导入的摘要"})),
        ]).unwrap();
        let page = Store::page(&p, "session", "root", Window::Before(u64::MAX), 500, false).unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].data["text"].as_str(), Some("导入的摘要"));
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn a_summary_never_fills_a_compaction_that_comes_after_it() {
        // 摘要追加在日志末尾，能并的只有排在它之前的压缩；往后的那一段不可能是它的出处。
        let p = fixture();
        let mut s = Store::open(&p, "session", "root", Provider::Claude, "t", "").unwrap();
        s.append("native", vec![
            ("compaction".into(), json!({"status":"completed","summaryId":"native-100","text":"早先的摘要"})),
        ]).unwrap();
        s.append("run-1", vec![
            ("compaction".into(), json!({"status":"compacting"})),
        ]).unwrap();
        let page = Store::page(&p, "session", "root", Window::Before(u64::MAX), 500, false).unwrap();
        assert_eq!(page.events.len(), 2);
        assert_eq!(page.events[0].data["text"].as_str(), Some("早先的摘要"));
        assert!(page.events[1].data["text"].as_str().unwrap_or_default().is_empty());
        fs::remove_dir_all(p).unwrap();
    }

    /// 够长的日志：25 轮 × 4 条 = 100 条事件，锚点因此不止一个。
    fn long_log(p: &Path) {
        let mut s = Store::open(p, "session", "root", TestProvider, "t", "").unwrap();
        for run in 0..25 {
            s.append(&format!("run-{run}"), vec![
                ("user".into(), json!({"text": format!("第 {run} 轮")})),
                ("status".into(), json!({"status":"running"})),
                ("text".into(), json!({"text": "正文"})),
                ("status".into(), json!({"status":"completed"})),
            ]).unwrap();
        }
    }

    #[test]
    fn the_index_serves_exactly_what_a_full_scan_would() {
        // 索引只是省掉了「从头读一遍」，读出来的东西必须和全量扫描一模一样：
        // 窗口两侧的边界、还有没有更早/更多、最新序号，一项都不能差。
        let p = fixture();
        long_log(&p);
        let path = p.join("session").join("events.jsonl");
        let plain = CompactionFold::default();
        for (label, window) in [
            ("latest", Window::Before(u64::MAX)),
            ("before-61", Window::Before(61)),
            ("before-65", Window::Before(65)),
            ("before-2", Window::Before(2)),
            ("after-0", Window::After(0)),
            ("after-60", Window::After(60)),
            ("after-100", Window::After(100)),
        ] {
            for limit in [7usize, 500] {
                let page = Store::page(&p, "session", "root", window, limit, true).unwrap();
                let full = scan_events_folded(&path, false, window, limit, "session", &plain).unwrap();
                let seqs: Vec<u64> = page.events.iter().map(|event| event.seq).collect();
                let expected: Vec<u64> = full.page.iter().map(|(event, _)| event.seq).collect();
                assert_eq!(seqs, expected, "{label}/{limit}");
                assert_eq!(page.has_older, full.has_older, "{label}/{limit} 还有更早");
                assert_eq!(page.has_more, full.has_more, "{label}/{limit} 还有更多");
                assert_eq!(page.latest_seq, full.seq, "{label}/{limit} 最新序号");
            }
        }
        // 索引确实落盘了，下一次翻页才用得上。
        assert!(LogIndex::read(&p.join("session")).is_some());
        // 打开会话也走同一份索引：最新序号不必再解析整份日志。
        let reopened = Store::open(&p, "session", "root", TestProvider, "t", "").unwrap();
        assert_eq!(reopened.seq, 100);
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn the_index_catches_up_with_events_appended_after_it_was_built() {
        let p = fixture();
        long_log(&p);
        let first = Store::page(&p, "session", "root", Window::Before(u64::MAX), 5, true).unwrap();
        assert_eq!(first.latest_seq, 100);
        let mut s = Store::open(&p, "session", "root", TestProvider, "t", "").unwrap();
        s.append("run-late", vec![("status".into(), json!({"status":"running"}))]).unwrap();
        let second = Store::page(&p, "session", "root", Window::Before(u64::MAX), 5, true).unwrap();
        // 只补读新增的那一段：最新序号、最新一条、活动任务都要跟上。
        assert_eq!(second.latest_seq, 101);
        assert_eq!(second.events.last().unwrap().seq, 101);
        assert_eq!(second.active_tasks.len(), 1);
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn task_list_snapshot_survives_pagination_and_sparse_updates() {
        let p = fixture();
        let mut s = Store::open(&p, "session", "root", TestProvider, "t", "").unwrap();
        s.append("run-a", vec![("task_list".into(), json!({"replace":true,"items":[
            {"id":"1","content":"分析","status":"complete"},
            {"id":"2","content":"实现","status":"active"},
            {"id":"3","content":"验证","status":"pending"}
        ]}))]).unwrap();
        s.append("run-b", vec![("task_list".into(), json!({"replace":false,"items":[
            {"id":"2","status":"complete"},
            {"id":"3","status":"active"}
        ]}))]).unwrap();

        // 最新页故意只装稀疏补丁；完整任务状态必须由会话级摘要独立返回。
        let page = Store::page(&p, "session", "root", Window::Before(u64::MAX), 1, false).unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.task_list, Some(json!({"seq":2,"runId":"run-b","items":[
            {"id":"1","content":"分析","status":"complete"},
            {"id":"2","content":"实现","status":"complete"},
            {"id":"3","content":"验证","status":"active"}
        ]})));
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn a_truncated_log_rebuilds_the_index_instead_of_reading_past_the_end() {
        let p = fixture();
        long_log(&p);
        let _ = Store::page(&p, "session", "root", Window::Before(u64::MAX), 5, true).unwrap();
        let path = p.join("session").join("events.jsonl");
        let kept: Vec<u8> = io_read_all(&path).into_iter().take(40)
            .flat_map(|line| line.into_iter().chain(std::iter::once(b'\n')))
            .collect();
        fs::write(&path, kept).unwrap();
        // 索引比日志长：只能整份重建，照着旧锚点 seek 会读到越界位置。
        let page = Store::page(&p, "session", "root", Window::Before(u64::MAX), 5, true).unwrap();
        assert_eq!(page.latest_seq, 40);
        assert_eq!(page.events.last().unwrap().seq, 40);
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn a_corrupt_index_falls_back_to_the_full_scan() {
        let p = fixture();
        long_log(&p);
        fs::write(p.join("session").join("events.idx"), b"{ not an index").unwrap();
        let page = Store::page(&p, "session", "root", Window::Before(u64::MAX), 5, true).unwrap();
        assert_eq!(page.events.last().unwrap().seq, 100);
        // 兜底扫过之后索引应当重建好，下一次照旧走索引。
        assert!(LogIndex::read(&p.join("session")).is_some());
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn rebuilding_an_index_rejects_an_early_foreign_session_event() {
        let p = fixture();
        long_log(&p);
        let _ = Store::page(&p, "session", "root", Window::Before(u64::MAX), 5, true).unwrap();
        let index_path = p.join("session").join("events.idx");
        let mut stale: serde_json::Value = serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
        stale["version"] = json!(INDEX_VERSION - 1);
        fs::write(&index_path, serde_json::to_vec(&stale).unwrap()).unwrap();

        let log_path = p.join("session").join("events.jsonl");
        let mut lines = io_read_all(&log_path);
        let mut foreign: Event = serde_json::from_slice(&lines[0]).unwrap();
        foreign.session_id = "foreign".into(); // 与 "session" 等长，日志长度不变也必须重建校验。
        lines[0] = serde_json::to_vec(&foreign).unwrap();
        let bytes: Vec<u8> = lines.into_iter().flat_map(|line| line.into_iter().chain(std::iter::once(b'\n'))).collect();
        fs::write(&log_path, bytes).unwrap();

        let error = match Store::page(&p, "session", "root", Window::Before(u64::MAX), 5, true) {
            Ok(_) => panic!("外来会话事件不应被索引接受"),
            Err(error) => error,
        };
        assert!(error.contains("归属不匹配"));
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn an_old_index_version_is_rebuilt_before_it_is_used() {
        let p = fixture();
        long_log(&p);
        let _ = Store::page(&p, "session", "root", Window::Before(u64::MAX), 5, true).unwrap();
        let path = p.join("session").join("events.idx");
        let mut stale: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        // 版本号是磁盘缓存契约；旧布局必须整份重建，不能拿新结构勉强反序列化后继续用。
        stale["version"] = json!(1);
        fs::write(&path, serde_json::to_vec(&stale).unwrap()).unwrap();

        let page = Store::page(&p, "session", "root", Window::Before(u64::MAX), 5, true).unwrap();
        assert_eq!(page.latest_seq, 100);
        let rebuilt: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(rebuilt["version"], INDEX_VERSION);
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn a_run_of_filtered_injections_does_not_make_a_short_page() {
        // 只剩系统注入的一整段 user 记录会被全部挡掉。只按事件数挑锚点会停在这段里，
        // 于是这一页空着，看起来像「历史读不出来」。
        let p = fixture();
        let mut s = Store::open(&p, "session", "root", TestProvider, "t", "").unwrap();
        for round in 0..30 {
            s.append(&format!("run-{round}"), vec![
                ("user".into(), json!({"text": format!("第 {round} 轮")})),
                ("status".into(), json!({"status":"completed"})),
            ]).unwrap();
        }
        s.append("native", (0..80).map(|n| (
            "user".into(),
            json!({"text": format!("<system-reminder>注入{n}</system-reminder>")}),
        )).collect()).unwrap();
        let page = Store::page(&p, "session", "root", Window::Before(u64::MAX), 10, true).unwrap();
        assert_eq!(page.events.len(), 10);
        assert!(page.events.iter().all(|event| event.seq <= 60));
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn the_index_keeps_the_compaction_pairing() {
        let p = fixture();
        compaction_log(&p);
        let _ = Store::page(&p, "session", "root", Window::Before(u64::MAX), 500, true).unwrap();
        assert!(LogIndex::read(&p.join("session")).is_some(), "索引要真的存下来");
        let persisted = fs::read_to_string(p.join("session").join("events.idx")).unwrap();
        // 摘要正文只属于事件日志；索引保存偏移，避免长摘要让缓存再次膨胀到容量上限。
        assert!(!persisted.contains("第二次的摘要"));
        assert!(!persisted.contains("第三次的摘要"));
        let page = Store::page(&p, "session", "root", Window::Before(u64::MAX), 500, true).unwrap();
        let text_at = |seq: u64| page.events.iter().find(|event| event.seq == seq)
            .and_then(|event| event.data["text"].as_str()).unwrap_or_default().to_owned();
        assert_eq!(text_at(5), "第二次的摘要");
        assert_eq!(text_at(7), "第三次的摘要");
        assert_eq!(page.events.iter().filter(|event| event.data["summaryId"].is_string()).count(), 0);
        fs::remove_dir_all(p).unwrap();
    }
}
