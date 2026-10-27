//! AI 改动快照：批准写入类工具的时刻，把目标文件的当前内容存下来。
//!
//! 为什么在批准时刻取内容：Edit/Write/apply_patch 的授权请求先于执行到达 Forge，
//! 用户点「允许」的那一瞬文件还是旧状态——这是不侵入 CLI 就能拿到的最准时点。
//! 恢复动作本身也先生成一份「现状快照」再写回，时间线上于是形成一条链：
//! 从任意一步都能退回当时的文件状态，多退几步就是回滚链。

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};

use super::store::{self, Store};

/// 单个文件的快照上限：源码文件足够；二进制与巨型文件不值得留。
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// 一次快照最多收多少个文件，防一手异常入参。
const MAX_FILES: usize = 32;

static SNAPSHOT_COUNTER: AtomicU64 = AtomicU64::new(0);

fn checkpoints_dir(base: &Path, session_id: &str) -> PathBuf {
    base.join(session_id).join("checkpoints")
}

fn snapshot_id() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    format!("ckpt-{ms}-{}", SNAPSHOT_COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// 入参文件的归一：只收绝对路径、限数量、去重（大小写不敏感，Windows 同名只留一份）。
fn normalize_paths(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() { return Err("快照文件列表为空".into()); }
    if paths.len() > MAX_FILES { return Err(format!("一次最多快照 {MAX_FILES} 个文件")); }
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for path in paths {
        let trimmed = path.trim();
        if trimmed.is_empty() || !Path::new(trimmed).is_absolute() {
            return Err(format!("快照只支持绝对路径：{trimmed}"));
        }
        let key = trimmed.to_lowercase();
        if seen.insert(key) { out.push(trimmed.to_owned()); }
    }
    if out.is_empty() { return Err("快照文件列表为空".into()); }
    Ok(out)
}

/// 把 paths 的当前内容存进一个新快照目录，返回 checkpoint 事件数据（不写事件日志）。
/// 单文件读不到/超限时跳过该文件；全部跳过则不落盘直接报错。
fn take_snapshot(base: &Path, session_id: &str, paths: &[String], source: &str, restore_of: Option<&str>) -> Result<Value, String> {
    let paths = normalize_paths(paths)?;
    let mut entries: Vec<Value> = Vec::new();
    let mut payloads: Vec<(String, Vec<u8>)> = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        let Ok(content) = std::fs::read(path) else { continue };
        if content.len() as u64 > MAX_FILE_BYTES { continue; }
        payloads.push((format!("{index}.bin"), content));
        entries.push(json!({ "path": path, "file": format!("{index}.bin"), "size": payloads.last().map(|(_, bytes)| bytes.len()).unwrap_or(0) }));
    }
    if entries.is_empty() {
        return Err("没有可快照的文件（不存在或超出大小上限）".into());
    }
    let id = snapshot_id();
    let dir = checkpoints_dir(base, session_id).join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (name, bytes) in &payloads {
        std::fs::write(dir.join(name), bytes).map_err(|e| e.to_string())?;
    }
    let manifest = json!({ "id": id, "source": source, "files": entries });
    let manifest_text = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("snapshot.json"), manifest_text).map_err(|e| e.to_string())?;
    let mut data = json!({
        "id": id,
        "source": source,
        "files": entries.iter().filter_map(|entry| entry["path"].as_str()).collect::<Vec<_>>(),
    });
    if let Some(of) = restore_of {
        data["restoreOf"] = json!(of);
    }
    Ok(data)
}

/// 批准时刻的快照入口：落一个新快照并向事件日志追加一条 checkpoint 事件。
pub fn record(app: Option<&AppHandle>, base: &Path, session_id: &str, root: &str, paths: &[String], source: &str, restore_of: Option<&str>) -> Result<Value, String> {
    if !store::valid_id(session_id) { return Err("无效会话 ID".into()); }
    let data = take_snapshot(base, session_id, paths, source, restore_of)?;
    let id = data["id"].clone();
    let files = data["files"].clone();
    append_event(app, base, session_id, root, data)?;
    Ok(json!({ "id": id, "files": files }))
}

/// 把一份快照写回磁盘：先把相关文件的现状存成新快照（可再退回来），再覆盖。
pub fn restore(app: Option<&AppHandle>, base: &Path, session_id: &str, root: &str, checkpoint_id: &str) -> Result<Value, String> {
    if !store::valid_id(session_id) { return Err("无效会话 ID".into()); }
    if !store::valid_id(checkpoint_id) || !checkpoint_id.starts_with("ckpt-") {
        return Err("无效的快照 ID".into());
    }
    let dir = checkpoints_dir(base, session_id).join(checkpoint_id);
    let manifest_text = std::fs::read(dir.join("snapshot.json")).map_err(|e| format!("快照不存在：{e}"))?;
    let manifest: Value = serde_json::from_slice(&manifest_text).map_err(|e| format!("快照损坏：{e}"))?;
    let files = manifest["files"].as_array().ok_or("快照损坏：文件清单缺失")?;
    // 现状先行：恢复动作自己也是一次快照，链就从这里长出来。
    let current: Vec<String> = files.iter().filter_map(|entry| entry["path"].as_str().map(str::to_owned)).collect();
    let undo = take_snapshot(base, session_id, &current, "restore", Some(checkpoint_id))?;
    let undo_id = undo["id"].clone();
    append_event(app, base, session_id, root, undo)?;
    for entry in files {
        let Some(path) = entry["path"].as_str() else { continue };
        let Some(file) = entry["file"].as_str() else { continue };
        let bytes = std::fs::read(dir.join(file)).map_err(|e| format!("读取快照内容失败：{e}"))?;
        if let Some(parent) = Path::new(path).parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(path, bytes).map_err(|e| format!("写回 {path} 失败：{e}"))?;
    }
    Ok(json!({ "restored": checkpoint_id, "undo": undo_id }))
}

/// 追加 checkpoint 事件：借现有 open_for_append 通道，序号与并发控制都归 store。
/// 锁在这里整批拿一次，调用方（mod 侧命令）不得外层再持 IO_LOCK——普通 Mutex
/// 不可重入，嵌套即互相等待。app 传 None 只落盘不广播：单测造不出 Tauri 句柄。
fn append_event(app: Option<&AppHandle>, base: &Path, session_id: &str, root: &str, data: Value) -> Result<(), String> {
    let _io = store::IO_LOCK.lock().map_err(|e| e.to_string())?;
    let meta = Store::metadata(&base.join(session_id), root)?;
    let mut store = Store::open_for_append(base, session_id, root, meta.provider, &meta.title, "")?;
    let events = store.append("checkpoint", vec![("checkpoint".into(), data)])?;
    drop(store);
    if let Some(app) = app {
        let _ = app.emit(super::CHANNEL, &events);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_cli::Provider;

    fn fixture() -> PathBuf {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "forge-runtime-checkpoint-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn normalize_paths_dedups_case_insensitively_and_rejects_relative() {
        assert!(normalize_paths(&[]).is_err());
        let text = fixture().join("a.txt").to_string_lossy().into_owned();
        assert!(normalize_paths(&["relative.txt".into()]).is_err());
        assert_eq!(normalize_paths(&[text.clone(), text.to_uppercase()]).unwrap().len(), 1);
    }

    #[test]
    fn snapshot_skips_missing_files_and_errors_when_nothing_left() {
        let base = fixture();
        let work = fixture();
        let keep = work.join("keep.txt");
        std::fs::write(&keep, "v1").unwrap();
        let gone = work.join("gone.txt");
        let data = take_snapshot(&base, "session", &[keep.to_string_lossy().into_owned(), gone.to_string_lossy().into_owned()], "approval", None).unwrap();
        let files = data["files"].as_array().unwrap();
        assert_eq!(files.len(), 1);
        let dir = checkpoints_dir(&base, "session").join(data["id"].as_str().unwrap());
        assert_eq!(std::fs::read(dir.join("0.bin")).unwrap(), b"v1");
        let manifest: Value = serde_json::from_slice(&std::fs::read(dir.join("snapshot.json")).unwrap()).unwrap();
        assert_eq!(manifest["files"][0]["path"], keep.to_string_lossy().as_ref());
        assert!(take_snapshot(&base, "session", &[gone.to_string_lossy().into_owned()], "approval", None).is_err());
    }

    #[test]
    fn restore_writes_back_and_chains_undo_snapshots() {
        let base = fixture();
        let work = fixture();
        Store::open(&base, "session", "root", Provider::Codex, "t", "").unwrap();
        let file = work.join("doc.txt");
        std::fs::write(&file, "v1").unwrap();
        let made = record(None, &base, "session", "root", &[file.to_string_lossy().into_owned()], "approval", None).unwrap();
        let ckpt1 = made["id"].as_str().unwrap().to_owned();

        // 改到 v3 再恢复：文件写回 v1，恢复动作自己生成「现状快照」记下恢复前的 v3。
        std::fs::write(&file, "v3").unwrap();
        let out = restore(None, &base, "session", "root", &ckpt1).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"v1");
        let undo1 = out["undo"].as_str().unwrap().to_owned();
        assert_eq!(std::fs::read(checkpoints_dir(&base, "session").join(&undo1).join("0.bin")).unwrap(), b"v3");

        // 对 undo 快照再 restore：恢复本身也被滚回去，链继续生长。
        let out2 = restore(None, &base, "session", "root", &undo1).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"v3");
        let undo2 = out2["undo"].as_str().unwrap().to_owned();
        assert_ne!(undo1, undo2);

        // 事件日志里三条 checkpoint 事件，restore 快照的 restoreOf 各指回自己的来源。
        let log = std::fs::read_to_string(base.join("session").join("events.jsonl")).unwrap();
        let checkpoints: Vec<Value> = log
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|event| event["kind"] == "checkpoint")
            .collect();
        assert_eq!(checkpoints.len(), 3);
        assert_eq!(checkpoints[1]["data"]["restoreOf"], ckpt1.as_str());
        assert_eq!(checkpoints[1]["data"]["id"], undo1.as_str());
        assert_eq!(checkpoints[2]["data"]["restoreOf"], undo1.as_str());
        assert_eq!(checkpoints[2]["data"]["id"], undo2.as_str());

        // 不存在的快照报错，不静默。
        assert!(restore(None, &base, "session", "root", "ckpt-404").is_err());
    }
}
