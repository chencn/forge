//! 本地历史按工作区与完整相对路径分桶，保存文本以及行尾、BOM、编码和事件。
//! 打开、保存、外部更改、删除前与标签都会记录；每文件保留最近 50 个不同版本。
//! 写入使用串行锁与原子替换，恢复先保护当前内容，再按所比较的磁盘版本校验写回。

use crate::error::{err, err_parts};
use crate::offload::block;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// 每个文件的有界修订数量。
const KEEP_PER_FILE: usize = 50;
const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
static HISTORY_WRITE: Mutex<()> = Mutex::new(());

/// 一条历史快照：保存那一刻的正文与写盘所需的全部元信息。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// 完整路径让目录历史能发现已删除文件；旧记录按请求路径补齐。
    #[serde(default)]
    pub path: String,
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

/// 读回一个文件的全部快照（最新在前）。文件不在就是空表，不是错误。
///
/// 落盘时就是「最新在前」整份重写的（见 [`append_snapshot`]），读回来照这个顺序收集即可，不再反。
#[cfg(test)]
fn read_snapshots(path: &Path) -> Vec<Snapshot> {
    read_snapshots_checked(path).unwrap_or_default()
}

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
fn append_snapshot(path: &Path, snapshot: &Snapshot) -> Result<(), String> {
    let _guard = HISTORY_WRITE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    append_snapshot_unlocked(path, snapshot)
}

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

fn history_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| err("CONFIG_DIR", error))?;
    Ok(dir.join("local-history"))
}

/// 保存成功后调这里打一条快照。前端静默调用，历史是兜底，不该因为它把保存这条主路报错。
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

fn record_snapshot(dir: &Path, root: &str, path: &str, snapshot: Snapshot) -> Result<(), String> {
    if snapshot.contents.len() > MAX_SNAPSHOT_BYTES && snapshot.event != "beforeRestore" {
        return Ok(());
    }
    append_snapshot(
        &snapshot_file(dir, Path::new(root), Path::new(path)),
        &snapshot,
    )
}

/// 列单文件元数据；不存在与存储读取失败分别处理。
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

/// 取出历史里某一条的完整正文，给 diff 视图用。找不到时回 None（不是错误）。
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

/// 把某一条快照写回那个文件（复用保存那条原子写：认原行尾、原编码、原 BOM）。
/// 使用比较时的磁盘版本进行乐观校验，返回实际写盘内容以同步编辑器。
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

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub path: String,
    pub saved_at: i64,
    pub chars: usize,
    pub label: String,
    pub kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryHistory {
    pub entries: Vec<HistoryEntry>,
    pub deleted: Vec<String>,
}

fn now_ms() -> i64 {
    std::time::UNIX_EPOCH
        .elapsed()
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

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

fn under(scope: &str, path: &str) -> bool {
    let scope = path_key(Path::new(scope));
    let path = path_key(Path::new(path));
    path == scope || path.starts_with(&format!("{}/", scope.trim_end_matches('/')))
}

/// 读取元数据时不依赖磁盘文件仍然存在，因此父目录中也能恢复已删除的文件。
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

#[tauri::command]
pub async fn local_history_list_dir(
    app: AppHandle,
    root: String,
    path: String,
) -> Result<DirectoryHistory, String> {
    block(move || list_directory(&history_dir(&app)?, &root, &path)).await
}

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

#[tauri::command]
pub async fn local_history_capture(
    app: AppHandle,
    root: String,
    path: String,
    event: String,
) -> Result<(), String> {
    block(move || capture_path(&history_dir(&app)?, &root, Path::new(&path), &event)).await
}

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
