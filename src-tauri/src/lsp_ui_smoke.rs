//! 真实主 WebView 的语言服务 UI 验收入口。
//!
//! 这条路径只在 `lsp-ui-smoke` feature 下编译。它把测试配置和 Node stdio
//! fixture 写到用户 Temp，启动正常主窗口，再从同一个 WebView 驱动公开 UI。
//! 生产构建不会注册回传命令，也不会读取这些环境变量。

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
use tokio::time::Duration;

const FIXTURE: &str = r#"
const process = require('node:process');
let buffer = Buffer.alloc(0);
let currentText = '';
console.error('fixture started');

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function handle(message) {
  console.error(`fixture ${message.method || ''}`);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      capabilities: {
        textDocumentSync: { openClose: true, change: 1, willSave: true, willSaveWaitUntil: true, save: { includeText: true } },
        completionProvider: {},
        definitionProvider: true,
        renameProvider: true,
        codeActionProvider: {},
        signatureHelpProvider: { triggerCharacters: ['('] },
        referencesProvider: true,
        documentFormattingProvider: true
      }
    }});
    return;
  }
  if (message.method === 'textDocument/didOpen') {
    currentText = message.params.textDocument.text;
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {
      uri: message.params.textDocument.uri, diagnostics: []
    }});
    return;
  }
  if (message.method === 'textDocument/didChange') {
    const changes = message.params.contentChanges || [];
    const last = changes[changes.length - 1];
    if (last && typeof last.text === 'string') currentText = last.text;
    return;
  }
  if (message.method === 'textDocument/codeAction') {
    const uri = message.params.textDocument.uri;
    send({ jsonrpc: '2.0', id: message.id, result: [{
      title: 'Forge Smoke: 追加标记',
      kind: 'refactor',
      edit: { changes: { [uri]: [{ range: fullRange(), newText: currentText + '\n// smoke-action-applied' }] } }
    }]});
    return;
  }
  if (message.method === 'textDocument/signatureHelp') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      signatures: [{ label: 'smoke(a: string): number', parameters: [{ label: [6, 15] }] }],
      activeSignature: 0,
      activeParameter: 0
    }});
    return;
  }
  if (message.method === 'textDocument/references') {
    const uri = message.params.textDocument.uri;
    send({ jsonrpc: '2.0', id: message.id, result: wordRanges('fixtureValue').map((range) => ({ uri, range })) });
    return;
  }
  if (message.method === 'textDocument/rename') {
    const uri = message.params.textDocument.uri;
    send({ jsonrpc: '2.0', id: message.id, result: {
      changes: { [uri]: wordRanges('fixtureValue').map((range) => ({ range, newText: message.params.newName })) }
    }});
    return;
  }
  if (message.method === 'textDocument/formatting') {
    const uri = message.params.textDocument.uri;
    send({ jsonrpc: '2.0', id: message.id, result: [{ range: fullRange(), newText: currentText + '\n' }] });
    return;
  }
  if (message.method === 'textDocument/willSaveWaitUntil') {
    send({ jsonrpc: '2.0', id: message.id, result: [] });
    return;
  }
  if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null });
    return;
  }
  if (message.method === 'exit') process.exit(0);
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

function rangeAt(start, end) {
  const posOf = (offset) => {
    const before = currentText.slice(0, offset).split('\n');
    return { line: before.length - 1, character: before[before.length - 1].length };
  };
  return { start: posOf(start), end: posOf(end) };
}

function fullRange() {
  return rangeAt(0, currentText.length);
}

function wordRanges(word) {
  const ranges = [];
  let index = 0;
  while ((index = currentText.indexOf(word, index)) >= 0) {
    ranges.push(rangeAt(index, index + word.length));
    index += word.length;
  }
  return ranges;
}
"#;

const UI_SCRIPT: &str = r#"
(async () => {
  const expectedRoot = __FORGE_EXPECTED_ROOT__;
  const checks = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (node) => node ? (node.innerText || node.textContent || '') : '';
  const fail = (message) => { throw new Error(message); };
  async function waitFor(label, finder, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = finder();
      if (value) return value;
      await sleep(100);
    }
    fail(`等待 UI 元素超时：${label}`);
  }
  async function report(result) {
    // 结果由 Rust 侧 eval_with_callback 读取，避免 UI 断言失败时再依赖同一条
    // 前端 invoke 链回传错误，导致真正的失败原因被吞掉。
    window.__FORGE_LSP_UI_SMOKE_RESULT__ = result;
  }

  try {
    await waitFor('主界面', () => document.querySelector('body') && text(document.body).length > 0);
    await waitFor('启动文件稳定', () =>
      [...document.querySelectorAll('[data-editor-tab^="doc|"]')].find((tab) =>
        tab.getAttribute('aria-selected') === 'true'
      )
    );
    const settings = await waitFor('设置按钮', () =>
      [...document.querySelectorAll('button')].find((button) =>
        (button.title || '').includes('设置') || (button.getAttribute('aria-label') || '').includes('设置'))
    );
    settings.click();
    // 启动参数打开文件是异步的，可能在第一次点击后把活动标签切回文档；
    // 等设置标签真正进入标签栏后再选一次，避免把启动竞态误报成设置页缺失。
    await waitFor('设置标签激活', () => {
      const tabs = [...document.querySelectorAll('[data-editor-tab="settings"]')];
      const tab = tabs.find((item) => item.getAttribute('aria-selected') === 'true') || tabs[0];
      if (!tab) return null;
      if (tab.getAttribute('aria-selected') !== 'true') {
        // 顶部工具栏和标签本身都走同一个公开导航动作；重复触发可抵御
        // 启动文件异步打开对 activeTab 的最后一次覆盖。
        const currentSettings = [...document.querySelectorAll('button')].find((button) =>
          (button.title || '').includes('设置') || (button.getAttribute('aria-label') || '').includes('设置'));
        currentSettings?.click();
        for (const item of tabs) item.click();
      }
      return tab.getAttribute('aria-selected') === 'true' ? tab : null;
    });
    const nav = await waitFor('设置导航', () => document.querySelector('nav[aria-label="设置导航树"]'));
    let lspNav = [...nav.querySelectorAll('button')].find((button) => text(button).includes('语言服务器'));
    if (!lspNav) {
      const languagesGroup = [...nav.querySelectorAll('button')].find((button) => text(button).trim() === '语言与框架');
      languagesGroup?.click();
      lspNav = await waitFor('语言服务器导航项', () =>
        [...nav.querySelectorAll('button')].find((button) => text(button).includes('语言服务器'))
      );
    }
    if (!lspNav) fail('设置导航中缺少语言服务器页面');
    lspNav.click();

    await waitFor('语言服务列表', () => document.querySelector('.lsps-row-main'));
    const missingRow = await waitFor('缺失服务行', () =>
      [...document.querySelectorAll('.lsps-row-main')].find((row) =>
        row.getAttribute('data-tool') === 'missing-fixture')
    );
    missingRow.click();
    const missingInstall = await waitFor('缺失服务安装按钮', () => {
      // 详情面板按选中项重挂载，每轮都从 document 重新定位，别抓着旧节点不放。
      const details = [...document.querySelectorAll('.lsps-details')].find((panel) =>
        text(panel.querySelector('.lsps-title')).startsWith('missing-fixture'));
      if (!details) return null;
      return [...details.querySelectorAll('.lsps-actions button')].find(
        (item) => text(item).trim() === '安装') ?? null;
    });
    missingInstall.click();
    // 对标 IDE：安装立即执行，失败信息直接落在详情栏里。
    await waitFor('安装非零退出反馈', () => {
      const error = document.querySelector('.lsps-details .lsps-error');
      return error && text(error).includes('退出码 7') ? error : null;
    });
    checks.push('设置页自动探测和缺失服务一键安装反馈通过');

    const fixtureRow = await waitFor('fixture 服务行', () =>
      [...document.querySelectorAll('.lsps-row-main')].find((row) => row.getAttribute('data-tool') === 'fixture'));
    fixtureRow.click();
    const logButton = await waitFor('日志按钮', () =>
    {
      const details = [...document.querySelectorAll('.lsps-details')].find((panel) =>
        text(panel.querySelector('.lsps-title')).startsWith('fixture'));
      if (!details) return null;
      return [...details.querySelectorAll('button.lsps-link-button')].find((item) => /日志/.test(text(item))) ?? null;
    });
    logButton.click();
    const logPre = await waitFor('日志面板', () => document.querySelector('.lsps-log'));
    await waitFor('fixture stderr 日志', () => text(logPre).includes('fixture started'));
    checks.push('语言服务日志面板显示 stderr 通过');

    const restart = await waitFor('手动启动或重启按钮', () => {
      const buttons = [...document.querySelectorAll('.lsps-actions button')];
      return buttons.find((item) => ['启动', '重启'].includes(text(item).trim())) ?? null;
    });
    restart.click();
    await waitFor('手动启动状态', () => {
      const subtitle = document.querySelector('.lsps-subtitle');
      return subtitle && text(subtitle).includes('运行中') ? subtitle : null;
    });
    checks.push('设置页手动启动/重启和运行状态通过');

    const docTab = await waitFor('当前文件标签', () => document.querySelector('[data-editor-tab^="doc|"]'));
    docTab.click();
    const status = await waitFor('语言服务状态栏按钮', () => document.querySelector('.status-lsp-button'));
    status.click();
    // 对标 IDE：浮层按服务名列行；根与项目根相同那一行省略根，只显示语言。
    const serverRow = await waitFor('当前文件服务行', () => {
      const row = [...document.querySelectorAll('.lsp-panel .lsp-server')].find(
        (item) => text(item.querySelector('.lsp-name')) === 'node');
      return row ?? null;
    });
    const rowText = text(serverRow);
    if (!rowText.includes('运行中')) fail(`状态栏服务行没有显示运行状态：${rowText}`);
    if (!rowText.toLowerCase().includes('typescript')) fail(`状态栏服务行没有显示语言：${rowText}`);
    checks.push('右下角当前文件自动识别、服务与状态通过');

    // 真实编辑器工作流：签名帮助、查找用法、格式化、代码动作、重命名。
    docTab.click();
    const editorText = () => {
      const node = document.querySelector('.cm-content');
      return node ? node.innerText : '';
    };
    const press = (key, mods = {}) => {
      const target = document.querySelector('.cm-content');
      if (!target) fail('编辑器正文不存在');
      target.focus();
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));
    };

    press('p', { ctrlKey: true });
    await waitFor('签名帮助浮层', () => {
      const tip = document.querySelector('.lsp-signature-help');
      return tip && text(tip).includes('smoke(a: string)') ? tip : null;
    });
    checks.push('签名帮助浮层通过');
    press('Escape');

    press('F7', { altKey: true });
    const usages = await waitFor('查找用法面板', () => {
      const panel = document.querySelector('.lsp-locations');
      return panel && panel.querySelectorAll('.lsp-locations-row').length === 2 ? panel : null;
    });
    checks.push('查找用法列表面板通过');
    const closeUsages = usages.querySelector('.lsp-locations-close');
    if (closeUsages) closeUsages.click();

    const linesBefore = document.querySelectorAll('.cm-line').length;
    press('l', { ctrlKey: true, altKey: true });
    await waitFor('格式化已应用', () => (document.querySelectorAll('.cm-line').length > linesBefore ? true : null));
    checks.push('格式化整篇通过');

    press('Enter', { altKey: true });
    const actions = await waitFor('代码动作浮层', () => document.querySelector('.lsp-code-actions'));
    const actionButton = [...actions.querySelectorAll('.lsp-code-action')].find((button) =>
      text(button).includes('追加标记'));
    if (!actionButton) fail('代码动作浮层缺少 fixture 动作');
    actionButton.click();
    await waitFor('代码动作已应用', () => (editorText().includes('smoke-action-applied') ? true : null));
    checks.push('Alt+Enter 代码动作经 WorkspaceEdit 应用通过');

    press('F6', { shiftKey: true });
    const renameInput = await waitFor('重命名输入框', () => document.querySelector('.lsp-rename-input'));
    renameInput.value = 'renamedValue';
    renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await waitFor('重命名已应用', () => {
      const current = editorText();
      return current.includes('renamedValue = 1') && current.includes('renamedValue * 2') ? true : null;
    });
    checks.push('重命名经 WorkspaceEdit 应用通过');

    await report({ ok: true, checks });
  } catch (error) {
    await report({
      ok: false,
      checks,
      error: `${String(error && error.stack || error)}\n设置标签 active=${document.querySelector('[data-editor-tab="settings"]')?.getAttribute('aria-selected')}\n设置导航数量=${document.querySelectorAll('nav[aria-label="设置导航树"]').length}\n页面文本：${(document.body && document.body.innerText || '').slice(0, 3000)}`,
    });
  }
})().catch((error) => {
  window.__FORGE_LSP_UI_SMOKE_RESULT__ = {
    ok: false,
    checks: [],
    error: `${String(error && error.stack || error)}\n设置标签 active=${document.querySelector('[data-editor-tab="settings"]')?.getAttribute('aria-selected')}\n设置导航数量=${document.querySelectorAll('nav[aria-label="设置导航树"]').length}\n页面文本：${(document.body && document.body.innerText || '').slice(0, 3000)}`,
  };
});
"#;

/// 在隔离的应用配置目录和工作区中准备 fixture。路径必须来自用户 Temp，
/// 否则验收入口可能误写真实配置或真实项目。
pub fn prepare(app: &AppHandle, root_text: &str) -> Result<(), String> {
    let root = validate_temp_root(root_text)?;
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    std::fs::write(root.join("package.json"), "{\"private\":true}\n")
        .map_err(|error| error.to_string())?;
    std::fs::write(root.join("main.ts"), "const fixtureValue = 1;\nconst doubled = fixtureValue * 2;")
        .map_err(|error| error.to_string())?;
    std::fs::write(root.join("lsp-fixture.cjs"), FIXTURE)
        .map_err(|error| error.to_string())?;

    let config_dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    let config = json!({
        "version": 1,
        "maxSessions": 5,
        "idleTimeoutMin": 30,
        "servers": {
            "fixture": {
                "mode": "lsp",
                "program": "node",
                "path": "",
                "args": "lsp-fixture.cjs",
                "languages": ["typescript"],
                "rootMarkers": ["package.json"],
                "installCommand": "node -e \"process.exit(0)\"",
                "startupTimeoutMs": 30000,
                "initOptions": null,
                "supportsBuiltin": false
            },
            "missing-fixture": {
                "mode": "off",
                "program": "forge-missing-language-server",
                "path": "",
                "args": "",
                "languages": ["typescript"],
                "rootMarkers": ["package.json"],
                "installCommand": "node -e \"process.exit(7)\"",
                "startupTimeoutMs": 30000,
                "initOptions": null,
                "supportsBuiltin": false
            }
        }
    });
    std::fs::write(
        config_dir.join("lsp.json"),
        serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    // 编辑器工作流要按 IDEA 方案的键位驱动（Alt+F7 / Ctrl+Alt+L 只在这一档有绑定）。
    std::fs::write(
        config_dir.join("settings.json"),
        serde_json::to_vec_pretty(&json!({ "editor": { "keymap": "idea" } })).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// 在主文档 Finished 事件里注入 UI 脚本。Tauri setup 早于 WebView 导航，
/// 因而不能在那里把 `eval` 当成同步的页面操作；使用页面加载钩子才有稳定顺序。
pub fn on_page_load<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    payload: &tauri::webview::PageLoadPayload<'_>,
) {
    if payload.event() != tauri::webview::PageLoadEvent::Finished {
        return;
    }
    let app = webview.window().app_handle().clone();
    let root = match std::env::var("FORGE_LSP_UI_SMOKE_ROOT") {
        Ok(value) => value,
        Err(error) => {
            finish_with_error(&app, format!("读取 UI smoke 工作区失败：{error}"));
            return;
        }
    };
    let root_literal = match serde_json::to_string(&root) {
        Ok(value) => value,
        Err(error) => {
            finish_with_error(&app, format!("编码 UI smoke 工作区失败：{error}"));
            return;
        }
    };
    let script = UI_SCRIPT.replace("__FORGE_EXPECTED_ROOT__", &root_literal);
    let starter = format!(
        "if (!window.__FORGE_LSP_UI_SMOKE_STARTED__) {{ setTimeout(() => {{ if (document.querySelector('#root')) {{ window.__FORGE_LSP_UI_SMOKE_STARTED__ = true; {script} }} }}, 250); }}"
    );
    if let Err(error) = webview.eval(starter) {
        finish_with_error(&app, format!("主 WebView 注入 UI smoke 脚本失败：{error}"));
        return;
    }
    monitor_result(app);
}

/// 从主 WebView 读取脚本写入的结构化结果；回传链与被测页面解耦，失败时仍能落盘。
fn monitor_result<R: tauri::Runtime>(app: AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        finish_with_error(&app, "找不到主 WebView".to_string());
        return;
    };
    tauri::async_runtime::spawn(async move {
        let mut last_probe = Value::Null;
        for _ in 0..240 {
            let (tx, rx) = oneshot::channel();
            let sender = Arc::new(Mutex::new(Some(tx)));
            let callback_sender = sender.clone();
            let callback = move |raw: String| {
                if let Some(tx) = callback_sender.lock().ok().and_then(|mut slot| slot.take()) {
                    let _ = tx.send(raw);
                }
            };
            let script = "JSON.stringify({ready: document.readyState, root: !!document.querySelector('#root'), body: (document.body && document.body.innerText || '').slice(0, 200), bridge: !!window.__TAURI_INTERNALS__, result: window.__FORGE_LSP_UI_SMOKE_RESULT__ || null})";
            if window.eval_with_callback(script, callback).is_ok() {
                if let Ok(Ok(raw)) = tokio::time::timeout(Duration::from_millis(500), rx).await {
                    if let Some(probe) = parse_callback_result(&raw) {
                        last_probe = probe.clone();
                        let result = probe.get("result").cloned().unwrap_or(Value::Null);
                        if !result.is_object() {
                            tokio::time::sleep(Duration::from_millis(500)).await;
                            continue;
                        }
                        let ok = result.get("ok").and_then(Value::as_bool) == Some(true);
                        write_result(&result);
                        window.app_handle().exit(if ok { 0 } else { 1 });
                        return;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        finish_with_error(&app, format!("UI smoke 脚本未回传结构化结果；页面探针：{last_probe}"));
    });
}

fn parse_callback_result(raw: &str) -> Option<Value> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    match value {
        Value::String(text) => serde_json::from_str(&text).ok(),
        other if other.is_object() => Some(other),
        _ => None,
    }
}

fn write_result(result: &Value) {
    if let Ok(output) = std::env::var("FORGE_LSP_UI_SMOKE_RESULT") {
        let _ = std::fs::write(output, serde_json::to_vec_pretty(result).unwrap_or_default());
    }
}

fn finish_with_error<R: tauri::Runtime>(app: &AppHandle<R>, error: String) {
    let result = json!({ "ok": false, "checks": [], "error": error });
    write_result(&result);
    app.exit(1);
}

fn validate_temp_root(text: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(text);
    let temp = std::fs::canonicalize(std::env::temp_dir()).map_err(|error| error.to_string())?;
    let absolute = if root.exists() {
        std::fs::canonicalize(&root).map_err(|error| error.to_string())?
    } else {
        root
    };
    if !absolute.starts_with(&temp) {
        return Err("LSP UI smoke 工作区必须位于用户 Temp".into());
    }
    Ok(absolute)
}

#[allow(dead_code)]
fn _path_is_temp(path: &Path) -> bool {
    std::fs::canonicalize(path)
        .ok()
        .and_then(|value| std::fs::canonicalize(std::env::temp_dir()).ok().map(|temp| value.starts_with(temp)))
        .unwrap_or(false)
}
