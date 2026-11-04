//! 响应历史：每次交换都存一份，最新在前，超过上限裁掉。
//!
//! 移植自 openidea `crates/ide-http/src/history.rs`，按 forge 约定调整：
//! 存储目录改由命令层算好（`app_config_dir()/http-history/<工作区分桶>/`，与
//! [`crate::local_history`] 同构），`IpcPath` 换成 `String`，去 specta。
//!
//! IDEA 把历史放在项目的 `.idea/httpRequests`；forge 与本地历史一样放应用配置目录，
//! 不往用户工程里写东西。

use super::exec::{HttpResponse, SentRequest};
use crate::error::err;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

/// 历史条目里不含正文的那部分（列表用）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    /// Unix 纪元毫秒。
    pub time_ms: f64,
    pub name: Option<String>,
    pub method: String,
    pub url: String,
    /// 请求失败时为 `None`。
    pub status: Option<u16>,
    pub total_ms: Option<f64>,
    /// 请求来自哪个 `.http` 文件。
    pub file: Option<String>,
    pub error: Option<String>,
}

/// 一次请求及其结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpExchange {
    pub entry: HistoryEntry,
    pub request: SentRequest,
    pub response: Option<HttpResponse>,
}

pub const MAX_ENTRIES: usize = 100;
const INDEX: &str = "index.json";

/// 每个命令都会 `History::new`，实例上的锁挡不住另一次 `http_send`。
/// 历史文件按目录分桶，但写入都走这一把进程级锁。
fn history_io() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

/// 一个工作区的历史存储。`dir` 由调用方算好。
pub struct History {
    dir: PathBuf,
}

impl History {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn read_index(&self) -> Vec<HistoryEntry> {
        std::fs::read_to_string(self.dir.join(INDEX))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn file(&self, id: &str) -> Result<PathBuf, String> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(err("HTTP_HISTORY", "invalid history id"));
        }
        Ok(self.dir.join(format!("{id}.json")))
    }

    pub fn list(&self) -> Vec<HistoryEntry> {
        let _g = history_io();
        self.read_index()
    }

    pub fn get(&self, id: &str) -> Result<HttpExchange, String> {
        let _g = history_io();
        let path = self.file(id)?;
        if !self.read_index().iter().any(|entry| entry.id == id) {
            return Err(err("HTTP_HISTORY", "history entry no longer exists"));
        }
        let text = std::fs::read_to_string(&path)
            .map_err(|e| err("IO", format!("{}: {e}", path.display())))?;
        serde_json::from_str(&text)
            .map_err(|e| err("HTTP_HISTORY", format!("corrupt history entry: {e}")))
    }

    /// 存下 `exchange`，裁掉超出 [`MAX_ENTRIES`] 的最旧条目。
    pub fn add(&self, exchange: &HttpExchange) -> Result<(), String> {
        let _g = history_io();
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| err("IO", format!("{}: {e}", self.dir.display())))?;
        let json = serde_json::to_string(exchange).map_err(|e| err("HTTP_HISTORY", e))?;
        let path = self.file(&exchange.entry.id)?;
        std::fs::write(&path, json).map_err(|e| err("IO", format!("{}: {e}", path.display())))?;
        let mut index = self.read_index();
        index.insert(0, exchange.entry.clone());
        let cut = MAX_ENTRIES.min(index.len());
        for old in index.drain(cut..) {
            if let Ok(p) = self.file(&old.id) {
                let _ = std::fs::remove_file(p);
            }
        }
        self.write_index(&index)
    }

    fn write_index(&self, index: &[HistoryEntry]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(index).map_err(|e| err("HTTP_HISTORY", e))?;
        let path = self.dir.join(INDEX);
        std::fs::write(&path, json).map_err(|e| err("IO", format!("{}: {e}", path.display())))?;
        Ok(())
    }

    /// 删除 `time_ms` 早于 `cutoff_ms` 的条目，返回删掉的条数。
    /// 目录不存在或索引读不出来时什么也不做，启动清理不能因此报错。
    pub fn purge_before(&self, cutoff_ms: f64) -> Result<usize, String> {
        let _g = history_io();
        let (kept, removed): (Vec<_>, Vec<_>) = self
            .read_index()
            .into_iter()
            .partition(|entry| entry.time_ms >= cutoff_ms);
        if removed.is_empty() {
            return Ok(0);
        }
        for old in &removed {
            if let Ok(path) = self.file(&old.id) {
                let _ = std::fs::remove_file(path);
            }
        }
        self.write_index(&kept)?;
        Ok(removed.len())
    }

    pub fn clear(&self) -> Result<(), String> {
        let _g = history_io();
        for e in self.read_index() {
            if let Ok(p) = self.file(&e.id) {
                let _ = std::fs::remove_file(p);
            }
        }
        if self.dir.exists() {
            self.write_index(&[])?;
        }
        Ok(())
    }

    /// 单条删除与写入共用锁，避免并发发送把已删除的条目写回索引。
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let _g = history_io();
        let path = self.file(id)?;
        if !self.dir.exists() {
            return Ok(());
        }
        let mut index = self.read_index();
        index.retain(|entry| entry.id != id);
        self.write_index(&index)?;
        // 索引提交即删除成功；与 clear 一样尽力清理文件，残留文件也不能再经 get 读取。
        let _ = std::fs::remove_file(&path);
        Ok(())
    }
}

/// 生成历史 id：UUID v4 的简单形式（无连字符）。
pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exchange(id: &str) -> HttpExchange {
        HttpExchange {
            entry: HistoryEntry {
                id: id.into(),
                time_ms: 1.0,
                name: None,
                method: "GET".into(),
                url: "http://x".into(),
                status: Some(200),
                total_ms: Some(3.0),
                file: None,
                error: None,
            },
            request: SentRequest {
                name: None,
                method: "GET".into(),
                url: "http://x".into(),
                headers: vec![],
                sent_headers: None,
                body: None,
                body_base64: None,
            },
            response: None,
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::UNIX_EPOCH
            .elapsed()
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "forge-http-history-{name}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn deleted_entries_cannot_be_reopened_when_file_cleanup_is_unavailable() {
        let tmp = temp_dir("readonly-remove");
        let history = History::new(tmp.clone());
        history.add(&exchange("readonly")).unwrap();
        let file = tmp.join("readonly.json");
        let mut permissions = std::fs::metadata(&file).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&file, permissions).unwrap();
        history.remove("readonly").unwrap();
        let reopened = History::new(tmp);
        assert!(reopened.list().is_empty());
        assert!(reopened.get("readonly").is_err());
    }

    #[test]
    fn removes_only_the_requested_entry_and_persists() {
        let tmp = temp_dir("remove");
        let history = History::new(tmp.clone());
        history.add(&exchange("first")).unwrap();
        history.add(&exchange("second")).unwrap();
        history.add(&exchange("third")).unwrap();
        history.remove("second").unwrap();
        let reopened = History::new(tmp);
        assert_eq!(reopened.list().iter().map(|entry| entry.id.as_str()).collect::<Vec<_>>(), vec!["third", "first"]);
        assert!(reopened.get("second").is_err());
        assert_eq!(reopened.get("first").unwrap().entry.id, "first");
        assert_eq!(reopened.get("third").unwrap().entry.id, "third");
        reopened.remove("second").unwrap();
        assert!(reopened.remove("../first").is_err());
        assert_eq!(reopened.list().len(), 2);
    }

    #[test]
    fn purges_entries_older_than_cutoff() {
        let tmp = temp_dir("purge");
        let history = History::new(tmp.clone());
        for (id, time) in [("old", 1_000.0), ("edge", 5_000.0), ("new", 9_000.0)] {
            let mut item = exchange(id);
            item.entry.time_ms = time;
            history.add(&item).unwrap();
        }
        assert_eq!(history.purge_before(5_000.0).unwrap(), 1);
        let reopened = History::new(tmp.clone());
        assert_eq!(reopened.list().iter().map(|entry| entry.id.as_str()).collect::<Vec<_>>(), vec!["new", "edge"]);
        assert!(reopened.get("old").is_err());
        assert!(!tmp.join("old.json").exists());
        // 没有可删的条目时既不改索引也不报错。
        assert_eq!(reopened.purge_before(0.0).unwrap(), 0);
        assert_eq!(History::new(tmp.join("missing")).purge_before(1.0).unwrap(), 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn stores_newest_first_and_caps() {
        let tmp = temp_dir("cap");
        let h = History::new(tmp.clone());
        for i in 0..MAX_ENTRIES + 3 {
            h.add(&exchange(&format!("e{i}"))).unwrap();
        }
        let list = h.list();
        assert_eq!(list.len(), MAX_ENTRIES);
        assert_eq!(list[0].id, format!("e{}", MAX_ENTRIES + 2));
        assert!(h.get("e0").is_err());
        assert_eq!(h.get("e5").unwrap().entry.id, "e5");
        assert!(h.get("../x").is_err());
        h.clear().unwrap();
        assert!(h.list().is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
