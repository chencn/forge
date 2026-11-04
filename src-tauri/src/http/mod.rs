//! HTTP 客户端：IDEA 风格的 `.http` / `.rest` 请求文件。
//!
//! 分层移植自 openidea `crates/ide-http`：[`env`] 读 `http-client(.private).env.json`，
//! [`exec`] 发送请求（可取消、计时、文本/二进制判定），[`history`] 保留响应。
//! 命令层在这里，取消沿用 `ai_commit` 的 watch 注册表。
//!
//! 分工：`.http` 的解析、变量替换、依赖链、cURL 导入留在前端 `src/lib/httpFile.ts`；
//! 这边负责环境文件、发送与历史。理由见 [`exec`] 的模块注释。

pub mod env;
pub mod exec;
pub mod history;

use crate::error::err;
use crate::offload::{block, block_value};
use exec::HttpRequestCall;
use history::{History, HistoryEntry, HttpExchange};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or_default()
}

/// `path`（`.http` 文件）可用的环境名。
pub fn environments(path: Option<&Path>, root: Option<&Path>) -> Result<Vec<String>, String> {
    Ok(env::Environments::load(path, root)?.names())
}

// ---------------------------------------------------------------- 取消注册表

/// 正在发送的通道，以及「已经点了停止、但此刻没有发送在飞」的 id。
///
/// 一次运行会按依赖拆成多次 `http_send`。前一次的通道在返回时就拆掉了，
/// 停止若正好落在读环境、或两条依赖的间隙，只发一次 `watch` 会被丢掉，
/// 下一条照样发出去。`pending` 把这次停止留到下一次同 id 的发送。
struct Cancels {
    live: HashMap<String, watch::Sender<bool>>,
    pending: HashSet<String>,
}

static CANCELS: OnceLock<Mutex<Cancels>> = OnceLock::new();

fn cancels() -> &'static Mutex<Cancels> {
    CANCELS.get_or_init(|| {
        Mutex::new(Cancels {
            live: HashMap::new(),
            pending: HashSet::new(),
        })
    })
}

/// 登记这次发送。这个 id 已经点过停止就直接拒绝，不再建通道。
fn begin_send(id: &str) -> Result<watch::Receiver<bool>, String> {
    let mut table = cancels().lock().unwrap_or_else(|e| e.into_inner());
    if table.pending.remove(id) {
        return Err(err("HTTP_CANCELLED", ""));
    }
    let (tx, rx) = watch::channel(false);
    table.live.insert(id.to_owned(), tx);
    Ok(rx)
}

/// 请求离开作用域时从注册表摘掉自己。不碰 `pending`：停止要留给下一次同 id 的发送。
struct CancelGuard(String);
impl Drop for CancelGuard {
    fn drop(&mut self) {
        let mut table = cancels().lock().unwrap_or_else(|e| e.into_inner());
        table.live.remove(&self.0);
    }
}

// ---------------------------------------------------------------- 历史目录

/// `app_config_dir()/http-history/<工作区分桶>/`。与 [`crate::local_history`] 同构：
/// 按工作区根稳定哈希分桶，不往用户工程目录写东西。
fn history_dir(app: &AppHandle, root: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| err("CONFIG_DIR", e))?;
    Ok(base
        .join("http-history")
        .join(crate::local_history::bucket_name(Path::new(root))))
}

fn history_for(app: &AppHandle, root: &str) -> Result<History, String> {
    Ok(History::new(history_dir(app, root)?))
}

/// 启动时清理各工作区分桶里超过保留天数的历史；`days == 0` 表示保留全部。
/// 清理失败不阻塞启动，删不掉的条目下次启动再试。
pub fn purge_history(app: &AppHandle, days: u32) {
    if days == 0 {
        return;
    }
    let Ok(base) = app.path().app_config_dir() else { return };
    let Ok(entries) = std::fs::read_dir(base.join("http-history")) else { return };
    let cutoff_ms = now_ms() - f64::from(days) * 86_400_000.0;
    for entry in entries.flatten() {
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            let _ = History::new(entry.path()).purge_before(cutoff_ms);
        }
    }
}

// ---------------------------------------------------------------- 命令

/// 作用于 `path` 的 `http-client(.private).env.json` 里的环境名。
#[tauri::command]
pub async fn http_environments(
    path: Option<String>,
    root: Option<String>,
) -> Result<Vec<String>, String> {
    block(move || {
        environments(path.as_deref().map(Path::new), root.as_deref().map(Path::new))
    })
    .await
}

/// `env` 这个环境下的变量；前端把它当作最低优先级的变量源。
#[tauri::command]
pub async fn http_env_variables(
    path: Option<String>,
    root: Option<String>,
    env: Option<String>,
) -> Result<BTreeMap<String, String>, String> {
    block(move || {
        let envs = env::Environments::load(
            path.as_deref().map(Path::new),
            root.as_deref().map(Path::new),
        )?;
        Ok(envs.variables(env.as_deref()))
    })
    .await
}

/// 发送一条已经拼装好的请求；给了 `root` 就顺带把这次交换记入历史。
/// 用 `request_id` + [`http_cancel`] 取消；不打算取消的调用方（AI 供应商的模型清单）
/// 留空即可。
#[tauri::command]
pub async fn http_send(
    app: AppHandle,
    request_id: Option<String>,
    path: Option<String>,
    root: Option<String>,
    call: HttpRequestCall,
) -> Result<HttpExchange, String> {
    let mut rx = match request_id.as_deref() {
        Some(id) => begin_send(id)?,
        None => watch::channel(false).1,
    };
    let _guard = request_id.map(CancelGuard);
    let base = path.as_deref().map(PathBuf::from);
    let (mut sent, body) = block(move || {
        let dir = base.as_deref().and_then(Path::parent);
        exec::assemble(&call, dir)
    })
    .await?;
    let time_ms = now_ms();
    let result = exec::send(&mut sent, &body, &mut rx).await;
    // 取消直接向上抛，不作为一次「失败的交换」记进历史。
    if let Err(e) = &result {
        if e.starts_with("HTTP_CANCELLED") {
            return Err(e.clone());
        }
    }
    let (response, error) = match result {
        Ok(r) => (Some(r), None),
        Err(e) => (None, Some(e)),
    };
    let exchange = HttpExchange {
        entry: HistoryEntry {
            id: history::new_id(),
            time_ms,
            name: sent.name.clone(),
            method: sent.method.clone(),
            url: sent.url.clone(),
            status: response.as_ref().map(|r| r.status),
            total_ms: response.as_ref().map(|r| r.total_ms),
            file: path.clone(),
            error,
        },
        request: sent,
        response,
    };
    // 落历史是兜底，不该因为它把发送这条主路报错。
    if let Some(root) = root.as_deref() {
        if let Ok(history) = history_for(&app, root) {
            let saved = exchange.clone();
            let _ = block(move || history.add(&saved)).await;
        }
    }
    Ok(exchange)
}

/// 取消一条正在发送的请求。眼下没有发送在飞时先记下，下一次同 id 的发送直接拒绝。
#[tauri::command]
pub fn http_cancel(request_id: String) {
    let mut table = cancels().lock().unwrap_or_else(|e| e.into_inner());
    table.pending.insert(request_id.clone());
    if let Some(tx) = table.live.get(&request_id) {
        let _ = tx.send(true);
    }
}

/// 前端整轮运行结束后释放登记；单条依赖的 CancelGuard 不能提前清掉间隙里的取消。
#[tauri::command]
pub fn http_finish(request_id: String) {
    let mut table = cancels().lock().unwrap_or_else(|e| e.into_inner());
    table.live.remove(&request_id);
    table.pending.remove(&request_id);
}

/// 当前工作区的历史条目（最新在前）。
#[tauri::command]
pub async fn http_history(app: AppHandle, root: String) -> Vec<HistoryEntry> {
    block_value(
        move || match history_for(&app, &root) {
            Ok(history) => history.list(),
            Err(_) => Vec::new(),
        },
        Vec::new,
    )
    .await
}

/// 取历史里某一条的完整交换。
#[tauri::command]
pub async fn http_history_get(
    app: AppHandle,
    root: String,
    id: String,
) -> Result<HttpExchange, String> {
    block(move || history_for(&app, &root)?.get(&id)).await
}

/// 清空当前工作区的历史。
#[tauri::command]
pub async fn http_history_clear(app: AppHandle, root: String) -> Result<(), String> {
    block(move || history_for(&app, &root)?.clear()).await
}

/// 只删除当前工作区中指定的一次交换。
#[tauri::command]
pub async fn http_history_remove(app: AppHandle, root: String, id: String) -> Result<(), String> {
    block(move || history_for(&app, &root)?.remove(&id)).await
}

/// `$processEnv` 用。只接受普通环境变量名，不把空字节或 `=` 传进查找。
#[tauri::command]
pub fn http_env(name: String) -> Option<String> {
    if !is_env_name(&name) {
        return None;
    }
    std::env::var(name).ok()
}

fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(ch) if ch.is_ascii_alphabetic() || ch == '_' => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use exec::BodyPart;

    #[test]
    fn env_name_is_a_token() {
        assert!(is_env_name("USERNAME"));
        assert!(is_env_name("_A1"));
        assert!(!is_env_name(""));
        assert!(!is_env_name("A=B"));
        assert!(!is_env_name("1NAME"));
    }

    #[tokio::test]
    async fn sends_a_call_end_to_end() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = s.read(&mut buf).await.unwrap();
            let body = "{\"ok\":true}";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            s.write_all(resp.as_bytes()).await.unwrap();
        });
        let call = HttpRequestCall {
            name: Some("ping".into()),
            method: "GET".into(),
            url: format!("http://{addr}/ping"),
            headers: vec![],
            body: vec![],
        };
        let (mut sent, body) = exec::assemble(&call, None).unwrap();
        let (_tx, mut rx) = watch::channel(false);
        let response = exec::send(&mut sent, &body, &mut rx).await.unwrap();
        assert_eq!(sent.name.as_deref(), Some("ping"));
        assert_eq!(response.status, 200);
        assert_eq!(response.body.as_deref(), Some("{\"ok\":true}"));
    }

    #[test]
    fn missing_body_file_is_reported() {
        let call = HttpRequestCall {
            name: None,
            method: "POST".into(),
            url: "http://x/".into(),
            headers: vec![],
            body: vec![BodyPart::File { file: "definitely-missing.json".into() }],
        };
        let dir = std::env::temp_dir();
        assert!(exec::assemble(&call, Some(dir.as_path()))
            .unwrap_err()
            .starts_with("IO"));
    }

    #[test]
    fn cancel_in_the_gap_rejects_the_next_send() {
        let id = format!("gap-{}-{}", std::process::id(), now_ms() as u64);
        let rx = begin_send(&id).unwrap();
        drop(rx);
        drop(CancelGuard(id.clone()));
        http_cancel(id.clone());
        let error = begin_send(&id).unwrap_err();
        assert!(error.starts_with("HTTP_CANCELLED"), "{error}");
    }

    #[test]
    fn finishing_a_run_releases_its_cancellation() {
        let id = format!("finish-{}-{}", std::process::id(), now_ms() as u64);
        let rx = begin_send(&id).unwrap();
        http_cancel(id.clone());
        assert!(*rx.borrow());
        http_finish(id.clone());
        let next = begin_send(&id).unwrap();
        assert!(!*next.borrow());
        http_finish(id);
    }

    #[test]
    fn cancel_flips_the_live_send() {
        let id = format!("live-{}-{}", std::process::id(), now_ms() as u64);
        let rx = begin_send(&id).unwrap();
        let _guard = CancelGuard(id.clone());
        assert!(!*rx.borrow());
        http_cancel(id);
        assert!(*rx.borrow());
    }
}
