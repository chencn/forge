//! 本地历史按工作区与完整相对路径分桶，保存文本以及行尾、BOM、编码和事件。
//! 打开、保存、外部更改、删除前与标签都会记录；每文件保留最近 50 个不同版本。
//! 写入使用串行锁与原子替换，恢复先保护当前内容，再按所比较的磁盘版本校验写回。

use crate::error::{err, err_parts};
use crate::offload::block;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// 每个文件的有界修订数量。
const KEEP_PER_FILE: usize = 50;
/// 单条快照正文的大小上限；正文超过它的记录直接丢弃。
const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
/// 跨进程桶锁的最长等待；历史写入是毫秒级操作，2 秒还没轮到说明对方卡住了。
const BUCKET_LOCK_WAIT: Duration = Duration::from_secs(2);
/// 跨进程桶锁文件名；与快照同目录，列举时因扩展名不是 `jsonl` 被跳过。
const BUCKET_LOCK_FILE: &str = ".write.lock";
/// 进程内串行写锁；同一进程内所有 JSONL 的读-改-写都持它。跨进程互斥见 [`lock_snapshots`]。
static HISTORY_WRITE: Mutex<()> = Mutex::new(());

/// 一条历史快照：保存那一刻的正文与写盘所需的全部元信息。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// 完整路径让目录历史能发现已删除文件；旧记录按请求路径补齐。
    #[serde(default)]
    pub path: String,
    /// 触发事件：`saved` / `external` / `deleted` / `beforeRestore` / `restored` / `label`
    #[serde(default)]
    pub event: String,
    /// 保存成功那刻的 unix 毫秒，列历史时按它倒序。
    pub saved_at: i64,
    /// 那一刻的正文（已按 line_ending 归一、剥掉 BOM 的最终文本）。
    pub contents: String,
    /// 行尾风格，恢复时带回去才能原样写盘。
    #[serde(default)]
    pub line_ending: String,
    /// 当时带不带 BOM。
    #[serde(default)]
    pub has_bom: bool,
    /// 当时的编码标签（`utf-8` / `gb18030`）。
    #[serde(default)]
    pub encoding: String,
}

/// 历史条目里不含正文的那部分，列清单用——整份正文回传就是几百 KB 的白搭 IPC。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub saved_at: i64,
    /// 这一条有多少个字符，列表里显示大小用。
    pub chars: usize,
    pub line_ending: String,
    pub has_bom: bool,
    pub encoding: String,
}

/// FNV-1a 64 位稳定哈希。与 `DefaultHasher` 不同，它的输出不会随 Rust 实现或版本变化。
pub(crate) fn stable_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// 路径参与持久化哈希前统一分隔符；Windows 文件系统大小写不敏感，也统一成小写。
pub(crate) fn path_key(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

/// 工作区根 → 分桶目录名。带上根路径稳定哈希，避免不同工程重名撞桶。
pub(crate) fn bucket_name(root: &Path) -> String {
    let name = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("workspace");
    let safe: String = name
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    format!("{safe}-{:016x}", stable_hash(&path_key(root)))
}

/// 文件绝对路径 + 工作区根 → 那个文件的 JSONL 路径（在 `history_dir` 之下）。
fn snapshot_file(history_dir: &Path, root: &Path, file: &Path) -> PathBuf {
    let relative = file.strip_prefix(root).unwrap_or(file);
    let key = stable_hash(&path_key(relative));
    history_dir
        .join(bucket_name(root))
        .join("files")
        .join(format!("{key:016x}.jsonl"))
}

/// 取快照所属桶的跨进程写锁，最多等 [`BUCKET_LOCK_WAIT`]。
///
/// 锁文件与快照同目录（`files/.write.lock`），一个桶的全部 JSONL 和 `labels.json`
/// 共用一把；返回的句柄 drop 即释放。进程内的 [`HISTORY_WRITE`] 管不到另一个
/// Forge 实例——两个实例打开同一工程时，靠这把锁把读-改-写真正串行化。
///
/// # Errors
///
/// - 目录或锁文件创建失败：`"IO"` 前缀
/// - 等待超时：返回「另一个实例正在写入」的提示文本
fn lock_snapshots(snapshot: &Path) -> Result<File, String> {
    let lock_path = snapshot.with_file_name(BUCKET_LOCK_FILE);
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| err_parts("IO", &[parent.display().to_string(), error.to_string()]))?;
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&lock_path)
        .map_err(|error| err_parts("IO", &[lock_path.display().to_string(), error.to_string()]))?;
    let deadline = Instant::now() + BUCKET_LOCK_WAIT;
    loop {
        if crate::lock::try_lock_exclusive(&file)? {
            return Ok(file);
        }
        if Instant::now() >= deadline {
            return Err("本地历史正被另一个 Forge 实例写入，请稍后重试".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// 读回一个文件的全部快照（最新在前）。文件不在就是空表，不是错误。
///
/// 落盘时就是「最新在前」整份重写的（见 [`append_snapshot`]），读回来照这个顺序收集即可，不再反。
///
/// # Errors
///
/// [`read_snapshots_checked`] 透传存储读取或反序列化失败。
#[cfg(test)]
fn read_snapshots(path: &Path) -> Vec<Snapshot> {
    read_snapshots_checked(path).unwrap_or_default()
}

/// 读回一个文件的全部快照（最新在前），损坏即报错。
///
/// # Errors
///
/// - 文件存在但读不出来：`"IO"` 前缀
/// - 某一行不是合法 JSON：`"IO"` 前缀
fn read_snapshots_checked(path: &Path) -> Result<Vec<Snapshot>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(err("IO", error)),
    };
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(|error| err("IO", error)))
        .collect()
}

/// 追加一条快照并把超出条数的旧条目裁掉。裁的时候整份重写——JSONL 没有原地删头的操作。
///
/// 先取进程内 [`HISTORY_WRITE`] 再取桶的跨进程锁（[`lock_snapshots`]），与
/// [`restore_snapshot`] 的加锁顺序一致，读-改-写不会与另一个 Forge 实例交错。
///
/// # Errors
///
/// 锁等待超时，或 [`append_snapshot_unlocked`] 的目录创建、读取、原子写失败。
fn append_snapshot(path: &Path, snapshot: &Snapshot) -> Result<(), String> {
    let _guard = HISTORY_WRITE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let _bucket = lock_snapshots(path)?;
    append_snapshot_unlocked(path, snapshot)
}

/// 在已持 [`HISTORY_WRITE`] 锁的前提下追加快照。
///
/// 与最新一条的正文、编码、行尾、BOM 全都相同且事件不是 `deleted` 时跳过——反复存同一个
/// 内容不该把历史刷成一排重复条目。同毫秒的连续保存会把 `saved_at` 推到前一条之后，
/// 保证每条修订可独立寻址（恢复按时间标识查找）。
///
/// # Errors
///
/// - 父目录创建失败：`"IO"` 前缀
/// - 读旧快照或写盘失败：透传 [`read_snapshots_checked`] / [`crate::fs::write_bytes_atomic`]
fn append_snapshot_unlocked(path: &Path, snapshot: &Snapshot) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| err_parts("IO", &[parent.display().to_string(), error.to_string()]))?;
    }
    let mut existing = read_snapshots_checked(path)?;
    // 正文一样就不留：反复存同一个内容不该把历史刷成一排重复条目。
    if let Some(newest) = existing.first() {
        if newest.contents == snapshot.contents
            && newest.encoding == snapshot.encoding
            && newest.line_ending == snapshot.line_ending
            && newest.has_bom == snapshot.has_bom
            && snapshot.event != "deleted"
        {
            return Ok(());
        }
    }
    let mut snapshot = snapshot.clone();
    // 同毫秒的连续保存也必须有独立修订，恢复按时间标识查找。
    snapshot.saved_at = snapshot
        .saved_at
        .max(existing.first().map_or(0, |item| item.saved_at + 1));
    existing.insert(0, snapshot);
    if existing.len() > KEEP_PER_FILE {
        existing.truncate(KEEP_PER_FILE);
    }
    let text = existing
        .iter()
        .map(|item| serde_json::to_string(item).unwrap_or_default())
        .collect::<Vec<String>>()
        .join("\n");
    crate::fs::write_bytes_atomic(path, text.as_bytes())
}

/// 本地历史快照的存储根目录（应用配置目录下的 `local-history/`）。
///
/// # Errors
///
/// 应用配置目录无法确定时返回 `CONFIG_DIR` 错误。
fn history_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| err("CONFIG_DIR", error))?;
    Ok(dir.join("local-history"))
}

/// 保存成功后调这里打一条快照。前端静默调用，历史是兜底，不该因为它把保存这条主路报错。
///
/// # Errors
///
/// 配置目录定位失败（`"CONFIG_DIR"`）或落盘失败（`"IO"`）。
#[tauri::command]
pub async fn local_history_record(
    app: AppHandle,
    root: String,
    path: String,
    mut snapshot: Snapshot,
) -> Result<(), String> {
    block(move || {
        let dir = history_dir(&app)?;
        snapshot.path = path.clone();
        record_snapshot(&dir, &root, &path, snapshot)
    })
    .await
}

/// [`local_history_record`] 的同步体：单份快照超限时（恢复前事件除外）静默丢弃。
///
/// # Errors
///
/// 快照追加写失败时返回 `IO` 错误。
fn record_snapshot(dir: &Path, root: &str, path: &str, snapshot: Snapshot) -> Result<(), String> {
    if snapshot.contents.len() > MAX_SNAPSHOT_BYTES && snapshot.event != "beforeRestore" {
        return Ok(());
    }
    append_snapshot(
        &snapshot_file(dir, Path::new(root), Path::new(path)),
        &snapshot,
    )
}

/// 列单文件历史元数据（不含正文，整份正文回传就是几百 KB 的白搭 IPC）。
///
/// # Errors
///
/// 配置目录定位失败或存储读取失败（`"IO"`）；文件不存在返回空表，不算错。
#[tauri::command]
pub async fn local_history_list(
    app: AppHandle,
    root: String,
    path: String,
) -> Result<Vec<SnapshotInfo>, String> {
    block(move || {
        let dir = history_dir(&app)?;
        let file_path = snapshot_file(&dir, Path::new(&root), Path::new(&path));
        Ok(read_snapshots_checked(&file_path)?
            .into_iter()
            .map(|item| SnapshotInfo {
                saved_at: item.saved_at,
                chars: item.contents.chars().count(),
                line_ending: item.line_ending,
                has_bom: item.has_bom,
                encoding: item.encoding,
            })
            .collect())
    })
    .await
}

/// 取出历史里某一条的完整正文，给 diff 视图用。
///
/// # Errors
///
/// 配置目录定位失败或存储读取失败（`"IO"`）；找不到该条返回 `Ok(None)`，不是错误。
#[tauri::command]
pub async fn local_history_get(
    app: AppHandle,
    root: String,
    path: String,
    saved_at: i64,
) -> Result<Option<Snapshot>, String> {
    block(move || {
        let dir = history_dir(&app)?;
        let file_path = snapshot_file(&dir, Path::new(&root), Path::new(&path));
        Ok(read_snapshots_checked(&file_path)?
            .into_iter()
            .find(|item| item.saved_at == saved_at))
    })
    .await
}

/// 把某一条快照写回那个文件，返回实际写盘内容以同步编辑器。
///
/// 复用普通保存的原子写：认原行尾、原编码、原 BOM。当前文件还在时先把它的内容
/// 以 `beforeRestore` 存进历史——恢复动作本身不丢用户改了没存的东西。
///
/// # Errors
///
/// - 找不到目标修订：`"PATH_GONE"`
/// - 传入 `expect_modified_ms` 而磁盘版本与之不符：`"CONFLICT_ON_WRITE"`，不覆盖磁盘
/// - 目录定位、读取或写盘失败：`"IO"` / `"CONFIG_DIR"`
#[tauri::command]
pub async fn local_history_restore(
    app: AppHandle,
    root: String,
    path: String,
    saved_at: i64,
    expect_modified_ms: Option<i64>,
) -> Result<crate::fs::FileContent, String> {
    block(move || {
        restore_snapshot(
            &history_dir(&app)?,
            &root,
            path,
            saved_at,
            expect_modified_ms,
        )
    })
    .await
}

/// 执行恢复：保护当前内容、乐观校验后按快照原样写盘。
///
/// 与普通保存共用 [`crate::fs`] 写锁和 [`HISTORY_WRITE`]：保护当前版本与写回必须是
/// 一次不可交错的操作。写回成功后索引记录失败只打日志，不能让调用方误判未写盘。
///
/// # Errors
///
/// - 找不到目标修订：`"PATH_GONE"`
/// - `expect_modified_ms` 与磁盘不符：`"CONFLICT_ON_WRITE"`，不覆盖磁盘
/// - 读取或写盘失败：`"IO"`
fn restore_snapshot(
    dir: &Path,
    root: &str,
    path: String,
    saved_at: i64,
    expect_modified_ms: Option<i64>,
) -> Result<crate::fs::FileContent, String> {
    // 与普通保存共用锁：保护当前版本与写回必须是一次不可交错的操作。
    let _fs_guard = crate::fs::fs_write_lock();
    let _history_guard = HISTORY_WRITE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let file_path = snapshot_file(dir, Path::new(root), Path::new(&path));
    let _bucket = lock_snapshots(&file_path)?;
    let Some(snapshot) = read_snapshots_checked(&file_path)?
        .into_iter()
        .find(|item| item.saved_at == saved_at)
    else {
        return Err(err("PATH_GONE", &path));
    };
    if Path::new(&path).exists() {
        let current = crate::fs::read_file_impl(path.clone())?;
        append_snapshot_unlocked(&file_path, &snapshot_from_file(&current, "beforeRestore"))?;
    } else if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|error| err("IO", error))?;
    }
    let written = crate::fs::write_file_impl(
        path.clone(),
        snapshot.contents,
        Some(snapshot.line_ending),
        Some(snapshot.has_bom),
        expect_modified_ms,
        Some(if snapshot.encoding.is_empty() {
            "utf-8".to_string()
        } else {
            snapshot.encoding
        }),
    )?;
    // 写回已成功，后续索引记录失败不能让调用方误判未写盘；目标修订本就仍在历史中。
    if let Err(error) =
        append_snapshot_unlocked(&file_path, &snapshot_from_file(&written, "restored"))
    {
        eprintln!("Local history: failed to record restored revision: {error}");
    }
    Ok(written)
}

/// 列表/历史页共用的单条条目；`kind` 为 `snapshot` 或 `label`。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub path: String,
    pub saved_at: i64,
    pub chars: usize,
    pub label: String,
    pub kind: String,
}

/// 目录范围的历史视图；`deleted` 是出现过但磁盘上已不存在的路径。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryHistory {
    pub entries: Vec<HistoryEntry>,
    pub deleted: Vec<String>,
}

/// 当前 unix 毫秒；时钟回拨等异常时返回 0。
fn now_ms() -> i64 {
    std::time::UNIX_EPOCH
        .elapsed()
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// 从一份已读文件内容构造快照，`saved_at` 取当前时刻。
fn snapshot_from_file(file: &crate::fs::FileContent, event: &str) -> Snapshot {
    Snapshot {
        path: file.path.clone(),
        event: event.into(),
        saved_at: now_ms(),
        contents: file.contents.clone(),
        line_ending: file.line_ending.clone(),
        has_bom: file.has_bom,
        encoding: file.encoding.clone(),
    }
}

/// 域包含判定：`path` 等于 `scope` 或落在它之下（路径键归一后比较）。
fn under(scope: &str, path: &str) -> bool {
    let scope = path_key(Path::new(scope));
    let path = path_key(Path::new(path));
    path == scope || path.starts_with(&format!("{}/", scope.trim_end_matches('/')))
}

/// 列一个目录范围下的历史条目（快照与标签合并、按时间倒序）与已删除文件。
///
/// 旧单文件历史没有路径字段，直接查询那个文件时按请求路径补齐，仍可读取。
///
/// # Errors
///
/// 存储读取或反序列化失败（`"IO"`）。
fn list_directory(dir: &Path, root: &str, scope: &str) -> Result<DirectoryHistory, String> {
    let bucket = dir.join(bucket_name(Path::new(root)));
    let files = bucket.join("files");
    let mut entries = Vec::new();
    let mut deleted = Vec::new();
    if files.exists() {
        for item in fs::read_dir(&files).map_err(|error| err("IO", error))? {
            let item = item.map_err(|error| err("IO", error))?;
            if item.path().extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let snapshots = read_snapshots_checked(&item.path())?;
            for mut snapshot in snapshots {
                // 旧单文件历史没有路径，直接查询该文件时仍可读取。
                if snapshot.path.is_empty()
                    && item.path() == snapshot_file(dir, Path::new(root), Path::new(scope))
                {
                    snapshot.path = scope.into();
                }
                if snapshot.path.is_empty() || !under(scope, &snapshot.path) {
                    continue;
                }
                if !Path::new(&snapshot.path).exists() && !deleted.contains(&snapshot.path) {
                    deleted.push(snapshot.path.clone());
                }
                entries.push(HistoryEntry {
                    path: snapshot.path,
                    saved_at: snapshot.saved_at,
                    chars: snapshot.contents.len(),
                    label: if snapshot.event.is_empty() {
                        "saved".into()
                    } else {
                        snapshot.event
                    },
                    kind: "snapshot".into(),
                });
            }
        }
    }
    let labels = bucket.join("labels.json");
    if labels.exists() {
        let text = fs::read_to_string(labels).map_err(|error| err("IO", error))?;
        let labels: Vec<HistoryEntry> =
            serde_json::from_str(&text).map_err(|error| err("IO", error))?;
        entries.extend(
            labels
                .into_iter()
                .filter(|entry| under(&entry.path, scope) || under(scope, &entry.path)),
        );
    }
    entries.sort_by(|left, right| {
        right
            .saved_at
            .cmp(&left.saved_at)
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(DirectoryHistory { entries, deleted })
}

/// 列一个目录范围下的全部历史条目与已删除文件。
///
/// 读取元数据时不依赖磁盘文件仍然存在，因此父目录中也能恢复已删除的文件。
///
/// # Errors
///
/// 配置目录定位失败或存储读取失败（`"IO"`）。
#[tauri::command]
pub async fn local_history_list_dir(
    app: AppHandle,
    root: String,
    path: String,
) -> Result<DirectoryHistory, String> {
    block(move || list_directory(&history_dir(&app)?, &root, &path)).await
}

/// 给路径打快照；目录递归，文件不存在时改记 `deleted` 事件。
///
/// 超过 [`MAX_SNAPSHOT_BYTES`] 的正文只在 `beforeRestore` 保护场景放行——
/// 兜底历史不收大文件，但恢复前保护当前内容不能省。
///
/// # Errors
///
/// 存储读写失败（`"IO"`）；二进制与超限文件静默跳过。
fn capture_path(dir: &Path, root: &str, path: &Path, event: &str) -> Result<(), String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let file = snapshot_file(dir, Path::new(root), path);
            if let Some(mut snapshot) = read_snapshots_checked(&file)?.into_iter().next() {
                if snapshot.event != "deleted" {
                    snapshot.event = "deleted".into();
                    snapshot.saved_at = now_ms();
                    append_snapshot(&file, &snapshot)?;
                }
            }
            return Ok(());
        }
        Err(error) => return Err(err("IO", error)),
    };
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_dir() {
        if event == "external" {
            return Ok(());
        }
        for entry in fs::read_dir(path).map_err(|error| err("IO", error))? {
            let entry = entry.map_err(|error| err("IO", error))?;
            if matches!(
                entry.file_name().to_str(),
                Some(".git" | "node_modules" | "target")
            ) {
                continue;
            }
            capture_path(dir, root, &entry.path(), event)?;
        }
    } else if meta.is_file() && meta.len() <= MAX_SNAPSHOT_BYTES as u64 {
        match crate::fs::read_file_impl(path.to_string_lossy().into_owned()) {
            Ok(file) if !file.contents.contains('\0') => {
                let snapshot = snapshot_from_file(&file, event);
                append_snapshot(&snapshot_file(dir, Path::new(root), path), &snapshot)?;
            }
            Err(error) if error.starts_with("BINARY") || error.starts_with("NOT_UTF8") => {}
            Err(error) => return Err(error),
            _ => {}
        }
    }
    Ok(())
}

/// 外部变更或显式事件到达时给一个路径打快照；目录会递归。
///
/// 目录递归跳过 `.git`、`node_modules`、`target`；符号链接一律跳过。文件不存在时
/// 若历史里有它的记录，改记一条 `deleted` 事件而不是清空历史。
///
/// # Errors
///
/// 配置目录定位失败或存储读写失败（`"IO"`）；二进制与超限文件静默跳过。
#[tauri::command]
pub async fn local_history_capture(
    app: AppHandle,
    root: String,
    path: String,
    event: String,
) -> Result<(), String> {
    block(move || capture_path(&history_dir(&app)?, &root, Path::new(&path), &event)).await
}

/// 给历史打一个命名标签，标签记录此刻的磁盘状态与编辑器缓冲区。
///
/// 编辑器缓冲区里未保存的修改进历史，但不悄悄写进工作区。
///
/// # Errors
///
/// - 标签去除首尾空白后为空：`"IO"`
/// - 落盘或目录列举失败：`"IO"`
#[tauri::command]
pub async fn local_history_put_label(
    app: AppHandle,
    root: String,
    path: String,
    label: String,
    snapshots: Option<Vec<Snapshot>>,
) -> Result<(), String> {
    block(move || {
        put_label(
            &history_dir(&app)?,
            &root,
            path,
            label,
            snapshots.unwrap_or_default(),
        )
    })
    .await
}

/// 把标签与编辑器缓冲区快照落盘。标签记录此刻的磁盘状态；之后保存不会改变标签之前的修订集合。
///
/// # Errors
///
/// - 标签为空白：`"IO"`
/// - 目录列举、序列化或写盘失败：`"IO"`
fn put_label(
    dir: &Path,
    root: &str,
    path: String,
    label: String,
    snapshots: Vec<Snapshot>,
) -> Result<(), String> {
    if label.trim().is_empty() {
        return Err(err("IO", "Empty history label"));
    }
    // 标签记录此刻的磁盘状态；之后保存不会改变标签之前的修订集合。
    capture_path(dir, root, Path::new(&path), "label")?;
    let _guard = HISTORY_WRITE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let _bucket = lock_snapshots(&snapshot_file(dir, Path::new(root), Path::new(&path)))?;
    // 标签捕获编辑器缓冲区，但不把未保存修改悄悄写进工作区。
    for snapshot in snapshots {
        if under(&path, &snapshot.path) {
            append_snapshot_unlocked(
                &snapshot_file(dir, Path::new(root), Path::new(&snapshot.path)),
                &snapshot,
            )?;
        }
    }
    let file = dir.join(bucket_name(Path::new(root))).join("labels.json");
    let mut labels: Vec<HistoryEntry> = if file.exists() {
        serde_json::from_str(&fs::read_to_string(&file).map_err(|error| err("IO", error))?)
            .map_err(|error| err("IO", error))?
    } else {
        Vec::new()
    };
    let latest = list_directory(dir, root, &path)?
        .entries
        .first()
        .map_or(0, |entry| entry.saved_at);
    labels.insert(
        0,
        HistoryEntry {
            path,
            saved_at: now_ms().max(latest + 1),
            chars: 0,
            label: label.trim().into(),
            kind: "label".into(),
        },
    );
    labels.truncate(KEEP_PER_FILE);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| err("IO", error))?;
    }
    crate::fs::write_bytes_atomic(
        &file,
        &serde_json::to_vec(&labels).map_err(|error| err("IO", error))?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::UNIX_EPOCH
            .elapsed()
            .map(|since| since.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "forge-local-history-{name}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn snap(contents: &str, at: i64) -> Snapshot {
        Snapshot {
            path: String::new(),
            event: String::new(),
            saved_at: at,
            contents: contents.to_string(),
            line_ending: "lf".to_string(),
            has_bom: false,
            encoding: "utf-8".to_string(),
        }
    }

    #[test]
    fn snapshots_append_and_rotate() {
        let dir = temp_dir("rotate");
        let file = dir.join("x.jsonl");
        for i in 0..(KEEP_PER_FILE + 10) {
            append_snapshot(&file, &snap(&format!("v{i}"), i as i64)).unwrap();
        }
        let list = read_snapshots(&file);
        assert_eq!(list.len(), KEEP_PER_FILE, "超出保留数要从最旧裁掉");
        assert_eq!(
            list[0].contents,
            format!("v{}", KEEP_PER_FILE + 9),
            "最新在前"
        );
        assert_eq!(
            list[KEEP_PER_FILE - 1].contents,
            "v10",
            "第 10 条之前的被裁掉"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn identical_content_is_not_recorded_twice() {
        let dir = temp_dir("dedupe");
        let file = dir.join("x.jsonl");
        append_snapshot(&file, &snap("same", 1)).unwrap();
        append_snapshot(&file, &snap("same", 2)).unwrap();
        append_snapshot(&file, &snap("other", 3)).unwrap();
        let list = read_snapshots(&file);
        assert_eq!(list.len(), 2, "正文一样就不该再记一条");
        assert_eq!(list[0].contents, "other");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn persistent_hash_is_stable() {
        assert_eq!(stable_hash("hello"), 0xa430_d846_80aa_bd0b);
    }

    #[test]
    fn separator_and_underscore_paths_do_not_collide() {
        let dir = temp_dir("path-key");
        let root = dir.join("project");
        let nested_after_underscore = snapshot_file(&dir, &root, &root.join("a_b").join("c.txt"));
        let underscore_after_nested = snapshot_file(&dir, &root, &root.join("a").join("b_c.txt"));
        assert_ne!(
            nested_after_underscore, underscore_after_nested,
            "完整相对路径必须参与哈希，目录分隔符不能与下划线混为一谈"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_paths_are_isolated_per_file_and_root() {
        let a = temp_dir("bucket-a");
        let root = a.join("project");
        fs::create_dir_all(&root).unwrap();
        let one = snapshot_file(&a, &root, &root.join("src").join("a.rs"));
        let two = snapshot_file(&a, &root, &root.join("src").join("b.rs"));
        assert_ne!(one, two);
        let other_root = a.join("other");
        let three = snapshot_file(&a, &other_root, &other_root.join("a.rs"));
        assert_ne!(one, three, "不同工作区不能同桶");
        let _ = fs::remove_dir_all(&a);
    }

    #[test]
    fn read_of_missing_history_is_empty() {
        let dir = temp_dir("missing");
        assert!(read_snapshots(&dir.join("nope.jsonl")).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn directory_history_survives_deleted_files_and_respects_path_boundaries() {
        let dir = temp_dir("directory");
        let root = dir.join("project");
        let file = root.join("src").join("a.txt");
        let other = root.join("src-extra").join("b.txt");
        for (path, at) in [(&file, 10), (&other, 20)] {
            let mut snapshot = snap("old", at);
            snapshot.path = path.to_string_lossy().into_owned();
            append_snapshot(&snapshot_file(&dir, &root, path), &snapshot).unwrap();
        }
        let view = list_directory(
            &dir,
            &root.to_string_lossy(),
            &root.join("src").to_string_lossy(),
        )
        .unwrap();
        assert_eq!(view.entries.len(), 1);
        assert_eq!(view.deleted, vec![file.to_string_lossy().into_owned()]);
        let restored = restore_snapshot(
            &dir,
            &root.to_string_lossy(),
            file.to_string_lossy().into_owned(),
            10,
            Some(0),
        )
        .unwrap();
        assert_eq!(restored.contents, "old");
        assert_eq!(fs::read_to_string(&file).unwrap(), "old");
        assert!(
            list_directory(&dir, &root.to_string_lossy(), &root.to_string_lossy())
                .unwrap()
                .deleted
                .contains(&other.to_string_lossy().into_owned())
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_preserves_current_disk_contents_and_encoding() {
        let dir = temp_dir("restore");
        let root = dir.join("project");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("a.txt");
        fs::write(&path, "current").unwrap();
        let history = snapshot_file(&dir, &root, &path);
        let mut original = snap("old\r\n", 10);
        original.path = path.to_string_lossy().into_owned();
        original.has_bom = true;
        original.line_ending = "crlf".into();
        append_snapshot(&history, &original).unwrap();
        let written = restore_snapshot(
            &dir,
            &root.to_string_lossy(),
            path.to_string_lossy().into_owned(),
            10,
            None,
        )
        .unwrap();
        assert!(written.has_bom);
        assert_eq!(fs::read(&path).unwrap(), b"\xef\xbb\xbfold\r\n");
        assert!(read_snapshots_checked(&history)
            .unwrap()
            .iter()
            .any(|item| item.contents == "current"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_rejects_changed_disk_and_corrupt_history_without_overwriting() {
        let dir = temp_dir("conflict");
        let root = dir.join("project");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("a.txt");
        fs::write(&path, "new external contents").unwrap();
        let history = snapshot_file(&dir, &root, &path);
        append_snapshot(&history, &snap("old", 10)).unwrap();
        let result = restore_snapshot(
            &dir,
            &root.to_string_lossy(),
            path.to_string_lossy().into_owned(),
            10,
            Some(1),
        );
        assert!(result.err().unwrap().starts_with("CONFLICT_ON_WRITE"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "new external contents");
        fs::write(&history, "invalid JSON").unwrap();
        assert!(restore_snapshot(
            &dir,
            &root.to_string_lossy(),
            path.to_string_lossy().into_owned(),
            10,
            None
        )
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "new external contents");
        assert_eq!(fs::read_to_string(&history).unwrap(), "invalid JSON");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn same_millisecond_revisions_and_metadata_changes_remain_distinct() {
        let dir = temp_dir("timestamps");
        let file = dir.join("versions.jsonl");
        append_snapshot(&file, &snap("one", 10)).unwrap();
        append_snapshot(&file, &snap("two", 10)).unwrap();
        let mut encoded = snap("two", 10);
        encoded.has_bom = true;
        append_snapshot(&file, &encoded).unwrap();
        let snapshots = read_snapshots_checked(&file).unwrap();
        assert_eq!(snapshots.len(), 3);
        assert_eq!(
            snapshots
                .iter()
                .map(|item| item.saved_at)
                .collect::<Vec<_>>(),
            [12, 11, 10]
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn explicit_protection_keeps_large_unsaved_contents() {
        let dir = temp_dir("large-protection");
        let root = dir.join("project");
        let path = root.join("a.txt");
        let mut snapshot = snap(&"x".repeat(MAX_SNAPSHOT_BYTES + 1), 10);
        snapshot.path = path.to_string_lossy().into_owned();
        record_snapshot(
            &dir,
            &root.to_string_lossy(),
            &path.to_string_lossy(),
            snapshot.clone(),
        )
        .unwrap();
        assert!(
            list_directory(&dir, &root.to_string_lossy(), &root.to_string_lossy())
                .unwrap()
                .entries
                .is_empty()
        );
        snapshot.event = "beforeRestore".into();
        record_snapshot(
            &dir,
            &root.to_string_lossy(),
            &path.to_string_lossy(),
            snapshot.clone(),
        )
        .unwrap();
        assert_eq!(
            read_snapshots_checked(&snapshot_file(&dir, &root, &path)).unwrap()[0].contents,
            snapshot.contents
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn labels_persist_scoped_editor_contents_without_saving_the_worktree() {
        let dir = temp_dir("labels");
        let root = dir.join("project");
        fs::create_dir_all(root.join("src")).unwrap();
        let path = root.join("src").join("a.txt");
        fs::write(&path, "disk").unwrap();
        let mut buffer = snap("unsaved", now_ms());
        buffer.path = path.to_string_lossy().into_owned();
        put_label(
            &dir,
            &root.to_string_lossy(),
            root.join("src").to_string_lossy().into_owned(),
            "checkpoint".into(),
            vec![buffer],
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "disk");
        let view = list_directory(&dir, &root.to_string_lossy(), &path.to_string_lossy()).unwrap();
        assert_eq!(view.entries[0].kind, "label");
        assert_eq!(view.entries[0].label, "checkpoint");
        let versions = read_snapshots_checked(&snapshot_file(&dir, &root, &path)).unwrap();
        assert_eq!(versions[0].contents, "unsaved");
        assert!(view.entries[0].saved_at > versions[0].saved_at);
        assert!(list_directory(
            &dir,
            &root.to_string_lossy(),
            &root.join("other").to_string_lossy()
        )
        .unwrap()
        .entries
        .is_empty());
        assert!(put_label(
            &dir,
            &root.to_string_lossy(),
            path.to_string_lossy().into_owned(),
            " ".into(),
            vec![]
        )
        .is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
