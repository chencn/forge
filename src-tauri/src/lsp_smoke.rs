//! 本机 LSP IPC 验收入口。
//!
//! 这个模块只在 `lsp-smoke` feature 下编译。它启动一个最小 Tauri 事件循环，
//! 通过真实 `AppHandle` 调用 LSP command，并把标准输入输出测试 server 放在用户 Temp。
//! 生产应用不注册这条入口，也不读取用户真实语言服务配置。

use crate::lsp;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Listener};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

const FIXTURE: &str = r#"
const process = require('node:process');
const fs = require('node:fs');
let buffer = Buffer.alloc(0);
console.error('fixture started');
fs.appendFileSync('fixture.trace', 'started\n');

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function handle(message) {
  fs.appendFileSync('fixture.trace', `method=${message.method || ''} id=${message.id || ''}\n`);
  if (message.method === 'initialize') {
    console.error('fixture initialize');
    send({ jsonrpc: '2.0', id: message.id, result: {
      capabilities: {
        textDocumentSync: { openClose: true, change: 1, willSave: true, willSaveWaitUntil: true, save: { includeText: true } },
        completionProvider: {},
        definitionProvider: true,
        renameProvider: true
      }
    }});
    return;
  }
  if (message.method === 'textDocument/didOpen') {
    console.error('fixture didOpen');
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {
      uri: message.params.textDocument.uri, diagnostics: []
    }});
    send({ jsonrpc: '2.0', id: 'fixture-edit', method: 'workspace/applyEdit', params: { edit: { changes: {} } } });
    return;
  }
  if (message.method === 'textDocument/willSaveWaitUntil') {
    send({ jsonrpc: '2.0', id: message.id, result: [] });
    return;
  }
  if (message.method === 'textDocument/didSave') {
    console.error('fixture didSave');
    return;
  }
  if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null });
    return;
  }
  if (message.method === 'exit') {
    process.exit(0);
    return;
  }
  if (message.id === 'fixture-edit' && message.result) {
    console.error('fixture applyEdit response');
  }
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const boundary = buffer.indexOf('\r\n\r\n');
    if (boundary < 0) return;
    const header = buffer.subarray(0, boundary).toString('ascii');
    const match = header.match(/content-length\s*:\s*(\d+)/i);
    if (!match) process.exit(12);
    const length = Number(match[1]);
    const start = boundary + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString('utf8');
    buffer = buffer.subarray(start + length);
    handle(JSON.parse(body));
  }
});
"#;

#[derive(Debug, Deserialize)]
struct MessageEvent {
    id: String,
    body: String,
}

#[derive(Debug, Deserialize)]
struct LogEvent {
    id: String,
    text: String,
}

#[derive(Debug, Deserialize)]
struct ExitEvent {
    id: String,
    code: Option<i32>,
}

pub fn run() {
    let output = std::env::var("FORGE_LSP_SMOKE_RESULT").expect("smoke result path required");
    let root = std::env::var("FORGE_LSP_SMOKE_ROOT").expect("smoke root required");
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows[0].visible = false;
    context.config_mut().app.windows[0].title = "LSP native verification".into();
    let app = tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            let output = output.clone();
            let root = root.clone();
            tauri::async_runtime::spawn(async move {
                let result = tokio::time::timeout(Duration::from_secs(90), verify(&handle, &root)).await;
                let value = match result {
                    Ok(Ok(checks)) => json!({ "ok": true, "checks": checks }),
                    Ok(Err(error)) => json!({ "ok": false, "error": error }),
                    Err(_) => json!({ "ok": false, "error": "LSP native smoke deadline exceeded" }),
                };
                let _ = std::fs::write(&output, serde_json::to_vec_pretty(&value).unwrap());
                // 无论断言成功或失败都要收掉真实子进程，不能让验收程序留下语言服务孤儿。
                lsp::reap_all_for_exit();
                handle.exit(if value["ok"] == true { 0 } else { 1 });
            });
            Ok(())
        })
        .build(context)
        .expect("native LSP smoke app failed");
    app.run(|_, _| {});
}

async fn verify(app: &AppHandle, root_text: &str) -> Result<Vec<String>, String> {
    let root = validate_temp_root(root_text)?;
    let first = root.join("project-one");
    let second = root.join("project-two");
    std::fs::create_dir_all(&second).map_err(|error| error.to_string())?;
    let fixture = root.join("lsp-fixture.cjs");
    std::fs::write(&fixture, FIXTURE).map_err(|error| error.to_string())?;
    // Windows 的 canonicalize 会给路径加 `\\?\\` 前缀；Node CLI 不把它当普通脚本路径，
    // 测试参数要还原成用户可执行的 Win32 路径，LSP 生产路径仍保留长路径语义。
    let args = format!("\"{}\"", command_path(&fixture));

    let (message_tx, mut messages) = unbounded_channel();
    let (exit_tx, mut exits) = unbounded_channel();
    let log_history = Arc::new(Mutex::new(Vec::<String>::new()));
    let log_sink = log_history.clone();
    let message_listener = app.listen("lsp://message", move |event| {
        if let Ok(value) = serde_json::from_str::<MessageEvent>(event.payload()) {
            let _ = message_tx.send(value);
        }
    });
    let log_listener = app.listen("lsp://log", move |event| {
        if let Ok(value) = serde_json::from_str::<LogEvent>(event.payload()) {
            log_sink.lock().unwrap().push(format!("{}:{}", value.id, value.text));
        }
    });
    let exit_listener = app.listen("lsp://exit", move |event| {
        if let Ok(value) = serde_json::from_str::<ExitEvent>(event.payload()) {
            let _ = exit_tx.send(value);
        }
    });

    let first_id = lsp::lsp_start(
        app.clone(),
        "lsp-smoke".into(),
        "fixture".into(),
        first.display().to_string(),
        "node".into(),
        args.clone(),
    )
    .await?;
    let second_id = lsp::lsp_start(
        app.clone(),
        "lsp-smoke".into(),
        "fixture".into(),
        second.display().to_string(),
        "node".into(),
        args,
    )
    .await?;
    if first_id == second_id {
        return Err("同一 server 的不同工程根复用了同一个会话".into());
    }
    let statuses = lsp::lsp_session_statuses(Some("lsp-smoke".into())).await;
    for id in [&first_id, &second_id] {
        let status = statuses.iter().find(|item| item.id == *id)
            .ok_or_else(|| format!("启动后找不到 session 状态：{id}"))?;
        if status.status != "running" {
            return Err(format!("LSP session 未运行：{}", serde_json::to_string(status).unwrap_or_default()));
        }
    }

    send(&first_id, json!({
        "jsonrpc":"2.0","id":1,"method":"initialize","params":{}
    })).await?;
    let initialized = match wait_response(&mut messages, &first_id, 1).await {
        Ok(value) => value,
        Err(error) => {
            let trace = read_trace(&first, &second);
            let statuses = lsp::lsp_session_statuses(Some("lsp-smoke".into())).await;
            let logs = log_history.lock().unwrap().join("|");
            return Err(format!("{error}；trace={trace}；logs={logs}；status={}", serde_json::to_string(&statuses).unwrap_or_default()));
        }
    };
    if initialized["result"]["capabilities"].is_null() {
        return Err("initialize 响应缺少 capabilities".into());
    }
    send(&second_id, json!({
        "jsonrpc":"2.0","id":1,"method":"initialize","params":{}
    })).await?;
    wait_response(&mut messages, &second_id, 1).await?;

    for (id, uri) in [(&first_id, "file:///project-one/main.ts"), (&second_id, "file:///project-two/main.ts")] {
        send(id, json!({ "jsonrpc":"2.0", "method":"initialized", "params":{} })).await?;
        send(id, json!({
            "jsonrpc":"2.0","method":"textDocument/didOpen",
            "params":{"textDocument":{"uri":uri,"languageId":"typescript","version":1,"text":"const x = 1;"}}
        })).await?;
        wait_method(&mut messages, id, "textDocument/publishDiagnostics").await?;
        let edit = wait_method(&mut messages, id, "workspace/applyEdit").await?;
        send(id, json!({ "jsonrpc":"2.0", "id":edit["id"], "result":{"applied":true} })).await?;
    }

    send(&first_id, json!({
        "jsonrpc":"2.0","id":2,"method":"textDocument/willSaveWaitUntil",
        "params":{"textDocument":{"uri":"file:///project-one/main.ts"},"reason":1}
    })).await?;
    if wait_response(&mut messages, &first_id, 2).await?["result"] != json!([]) {
        return Err("willSaveWaitUntil 返回了非预期编辑".into());
    }
    send(&first_id, json!({
        "jsonrpc":"2.0","method":"textDocument/didSave",
        "params":{"textDocument":{"uri":"file:///project-one/main.ts"},"text":"const x = 2;"}
    })).await?;
    wait_log(&log_history, &first_id, "fixture didSave").await?;
    wait_log(&log_history, &first_id, "fixture didOpen").await?;

    for id in [&first_id, &second_id] {
        send(id, json!({ "jsonrpc":"2.0","id":3,"method":"shutdown","params":null })).await?;
        wait_response(&mut messages, id, 3).await?;
        send(id, json!({ "jsonrpc":"2.0","method":"exit","params":null })).await?;
        let exit = wait_exit(&mut exits, id).await?;
        if exit.code.is_some_and(|code| code != 0) {
            return Err(format!("测试 server 非零退出：{}", exit.code.unwrap_or_default()));
        }
    }

    app.unlisten(message_listener);
    app.unlisten(log_listener);
    app.unlisten(exit_listener);
    Ok(vec![
        "真实 Tauri AppHandle 启动两个不同 root 的 LSP 会话".into(),
        "initialize、didOpen、诊断、workspace/applyEdit、willSaveWaitUntil、didSave 通过".into(),
        "stderr 日志和零退出码事件通过".into(),
    ])
}

async fn send(id: &str, body: Value) -> Result<(), String> {
    lsp::lsp_write(id.into(), serde_json::to_string(&body).map_err(|error| error.to_string())?).await
}

async fn wait_response(rx: &mut UnboundedReceiver<MessageEvent>, id: &str, expected: i64) -> Result<Value, String> {
    loop {
        let event = next_message(rx).await?;
        if event.id != id { continue; }
        let body: Value = serde_json::from_str(&event.body).map_err(|error| error.to_string())?;
        if body["id"] == expected { return Ok(body); }
    }
}

async fn wait_method(rx: &mut UnboundedReceiver<MessageEvent>, id: &str, method: &str) -> Result<Value, String> {
    loop {
        let event = next_message(rx).await?;
        if event.id != id { continue; }
        let body: Value = serde_json::from_str(&event.body).map_err(|error| error.to_string())?;
        if body["method"] == method { return Ok(body); }
    }
}

async fn next_message(rx: &mut UnboundedReceiver<MessageEvent>) -> Result<MessageEvent, String> {
    tokio::time::timeout(Duration::from_secs(15), rx.recv())
        .await
        .map_err(|_| "等待 LSP 消息超时".to_string())?
        .ok_or_else(|| "LSP 消息通道已关闭".to_string())
}

async fn wait_log(history: &Arc<Mutex<Vec<String>>>, id: &str, text: &str) -> Result<(), String> {
    let expected = format!("{id}:{text}");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if history.lock().unwrap().iter().any(|line| line == &expected) { return Ok(()); }
        if tokio::time::Instant::now() >= deadline {
            return Err("等待 LSP stderr 日志超时".into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn wait_exit(rx: &mut UnboundedReceiver<ExitEvent>, id: &str) -> Result<ExitEvent, String> {
    loop {
        let event = tokio::time::timeout(Duration::from_secs(15), rx.recv())
            .await
            .map_err(|_| "等待 LSP 退出事件超时".to_string())?
            .ok_or_else(|| "LSP 退出通道已关闭".to_string())?;
        if event.id == id { return Ok(event); }
    }
}

fn validate_temp_root(text: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(text).map_err(|error| error.to_string())?;
    let temp = std::fs::canonicalize(std::env::temp_dir()).map_err(|error| error.to_string())?;
    if !root.starts_with(temp) {
        return Err("LSP smoke root 必须位于用户 Temp".into());
    }
    let first = root.join("project-one");
    std::fs::create_dir_all(&first).map_err(|error| error.to_string())?;
    Ok(root)
}

fn read_trace(first: &Path, second: &Path) -> String {
    [first, second]
        .iter()
        .filter_map(|root| std::fs::read_to_string(root.join("fixture.trace")).ok())
        .collect::<Vec<_>>()
        .join("|")
}

fn command_path(path: &Path) -> String {
    let text = path.display().to_string();
    text.strip_prefix("\\\\?\\").unwrap_or(&text).to_string()
}

