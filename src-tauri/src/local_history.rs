//! 本地历史（Local History）。
//!
//! IDEA 的招牌功能之一：文件被外部工具改坏了、或者想找回十分钟前那个版本，不用提交到 git，
//! 按保存动作往应用数据目录里的快照区留一份。这里做的是它的轻量版：只在「保存成功」那一刻打快照，
//! 按正文去重（存进去没变化就不多留一份），每个文件最多留 [`KEEP_PER_FILE`] 条，超了从最旧的开始删。
//!
//! 快照区住在 `app_config_dir()/local-history/` 下，按工作区分桶：
//! `local-history/<工作区目录名-根路径稳定哈希>/files/<相对路径稳定哈希>.jsonl`。每行一个 JSON 对象
//! （一条快照：时间戳 + 正文 + 行尾 / BOM / 编码），最新在前；每次追加都是整份重写，
//! 顺带把超出保留数的最旧条目裁掉。不压缩、不单独存正文：一个 JSONL 够人肉排错，
//! 前端也只要「最近 N 条」这一口。
//!
//! 文件名使用完整相对路径的 FNV-1a 64 位稳定哈希：不会再因 `_` 同时充当路径分隔符和文件名字符而
//! 把 `a_b/c.txt`、`a/b_c.txt` 映到同一份历史；固定长度也避开 Windows 路径长度限制。

use crate::error::{err, err_parts};
use crate::offload::{block, block_value};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 一个文件最多留多少条快照。多了不是历史是仓库，该去用 git。
const KEEP_PER_FILE: usize = 50;

/// 一条历史快照：保存那一刻的正文与写盘所需的全部元信息。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
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
fn stable_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// 路径参与持久化哈希前统一分隔符；Windows 文件系统大小写不敏感，也统一成小写。
fn path_key(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

/// 工作区根 → 分桶目录名。带上根路径稳定哈希，避免不同工程重名撞桶。
fn bucket_name(root: &Path) -> String {
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
fn read_snapshots(path: &Path) -> Vec<Snapshot> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// 追加一条快照并把超出条数的旧条目裁掉。裁的时候整份重写——JSONL 没有原地删头的操作。
fn append_snapshot(path: &Path, snapshot: &Snapshot) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| err_parts("IO", &[parent.display().to_string(), error.to_string()]))?;
    }
    let mut existing = read_snapshots(path);
    // 正文一样就不留：反复存同一个内容不该把历史刷成一排重复条目。
    if let Some(newest) = existing.first() {
        if newest.contents == snapshot.contents {
            return Ok(());
        }
    }
    existing.insert(0, snapshot.clone());
    if existing.len() > KEEP_PER_FILE {
        existing.truncate(KEEP_PER_FILE);
    }
    let text = existing
        .iter()
        .map(|item| serde_json::to_string(item).unwrap_or_default())
        .collect::<Vec<String>>()
        .join("\n");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|error| err_parts("IO", &[path.display().to_string(), error.to_string()]))?;
    file.write_all(text.as_bytes())
        .map_err(|error| err_parts("IO", &[path.display().to_string(), error.to_string()]))?;
    Ok(())
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
    snapshot: Snapshot,
) -> Result<(), String> {
    block(move || {
        let Ok(dir) = history_dir(&app) else {
            return Ok(());
        };
        let file_path = snapshot_file(&dir, Path::new(&root), Path::new(&path));
        append_snapshot(&file_path, &snapshot)
    })
    .await
}

/// 列一个文件的历史（不含正文，最新在前）。取不到配置目录就回空表——列不出是「没历史」，
/// 不值得为这一条在界面挂一个错误。
#[tauri::command]
pub async fn local_history_list(app: AppHandle, root: String, path: String) -> Vec<SnapshotInfo> {
    block_value(
        move || match history_dir(&app) {
            Ok(dir) => {
                let file_path = snapshot_file(&dir, Path::new(&root), Path::new(&path));
                read_snapshots(&file_path)
                    .into_iter()
                    .map(|item| SnapshotInfo {
                        saved_at: item.saved_at,
                        chars: item.contents.chars().count(),
                        line_ending: item.line_ending,
                        has_bom: item.has_bom,
                        encoding: item.encoding,
                    })
                    .collect()
            }
            Err(_) => Vec::new(),
        },
        Vec::new,
    )
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
        Ok(read_snapshots(&file_path)
            .into_iter()
            .find(|item| item.saved_at == saved_at))
    })
    .await
}

/// 把某一条快照写回那个文件（复用保存那条原子写：认原行尾、原编码、原 BOM）。
/// 恢复是「就是要盖现在这份」，不带乐观锁。回写盘现状，前端据此刷新基线。
#[tauri::command]
pub async fn local_history_restore(
    app: AppHandle,
    root: String,
    path: String,
    saved_at: i64,
) -> Result<crate::fs::FileContent, String> {
    block(move || {
        let dir = history_dir(&app)?;
        let file_path = snapshot_file(&dir, Path::new(&root), Path::new(&path));
        let Some(snapshot) = read_snapshots(&file_path)
            .into_iter()
            .find(|item| item.saved_at == saved_at)
        else {
            return Err(err("PATH_GONE", &path));
        };
        crate::fs::write_file_locked_impl(
            path.clone(),
            snapshot.contents,
            Some(snapshot.line_ending),
            Some(snapshot.has_bom),
            None,
            Some(if snapshot.encoding.is_empty() {
                "utf-8".to_string()
            } else {
                snapshot.encoding
            }),
        )
    })
    .await
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
}
