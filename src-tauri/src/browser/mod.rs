//! Rust owns grants and run identity; a web page is never an authority.
pub mod launch;
#[cfg(feature = "browser-smoke")]
pub mod smoke;
mod surface;
mod tools;
mod picker;
mod emulation;
mod annotation;

use forge_browser::{failure, Request, VERSION};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct BrowserSettings {
    pub enabled: bool,
    pub rendered_pixels: bool,
    pub unsafe_evaluate: bool,
    pub file_upload: bool,
    /// 用户元素标记的交付偏好，独立于 AI 的额外权限。
    pub element_content: ElementContent,
}
#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ElementContent { Code, Screenshot, #[default] Both }
impl Default for BrowserSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            rendered_pixels: true,
            unsafe_evaluate: false,
            file_upload: false,
            element_content: ElementContent::Both,
        }
    }
}
#[derive(Clone)]
pub struct Scope {
    pub workspace: String,
    pub session: String,
    pub run: String,
    pub read_only: bool,
}
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Grant {
    None,
    Read,
    Control,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub id: String,
    pub order: u64,
    pub session_id: String,
    pub workspace: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub load_error: Option<String>,
    pub zoom: f64,
    pub emulation: emulation::Emulation,
    pub preview_scale: f64,
    #[serde(skip)]
    pub preview_bounds: Bounds,
    pub grant: Grant,
    pub epoch: u64,
    pub revision: u64,
    pub managed: bool,
    pub allowed_origin: Option<String>,
    #[serde(skip)]
    pub frame: String,
    #[serde(skip)]
    pub refs: HashMap<String, NodeRef>,
    #[serde(skip)]
    pub console: VecDeque<Value>,
    #[serde(skip)]
    pub network: VecDeque<Value>,
    #[serde(skip)]
    pub contexts: HashMap<i64, String>,
    #[serde(skip)]
    pub dialog: Option<Value>,
    #[serde(skip)]
    pub picker: picker::Picker,
    #[serde(skip)]
    pub queue: Arc<tokio::sync::Mutex<()>>,
}
#[derive(Clone)]
pub struct NodeRef {
    pub backend: i64,
    pub epoch: u64,
    pub snapshot: u64,
    pub dom_revision: u64,
    pub role: String,
    pub name: String,
}
#[derive(Default)]
struct State {
    scopes: HashMap<String, Scope>,
    tabs: HashMap<String, Tab>,
    working: HashMap<(String, String), String>,
    snapshot: u64,
    next_tab_order: u64,
    stopped: bool,
}
pub struct Host {
    state: Mutex<State>,
    endpoint: String,
}
impl Host {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}
pub fn host(app: &AppHandle) -> &Host {
    app.state::<Host>().inner()
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    if VERSION != env!("CARGO_PKG_VERSION") {
        return Err("Forge browser companion and desktop manifest versions differ".into());
    }
    let nonce = forge_browser::secret()?;
    #[cfg(windows)]
    let endpoint = format!(
        r"\\.\pipe\forge-browser-{}-{}",
        std::process::id(),
        &nonce[..24]
    );
    #[cfg(not(windows))]
    let endpoint = String::new();
    app.manage(Host {
        state: Mutex::new(State::default()),
        endpoint: endpoint.clone(),
    });
    #[cfg(windows)]
    {
        // Create before publishing the endpoint: startup errors cannot look like a healthy service.
        let first = {
            // setup runs on the UI thread, outside Tokio's reactor context.
            let runtime = tauri::async_runtime::handle();
            let _entered = runtime.inner().enter();
            forge_browser::transport::server(&endpoint, true)?
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut listener = first;
            let slots = Arc::new(tokio::sync::Semaphore::new(16));
            loop {
                if listener.connect().await.is_err() {
                    break;
                }
                let next = match forge_browser::transport::server(&endpoint, false) {
                    Ok(v) => v,
                    Err(_) => break,
                };
                let mut stream = std::mem::replace(&mut listener, next);
                let Ok(permit) = slots.clone().try_acquire_owned() else {
                    continue;
                };
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _permit = permit;
                    let request = tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        forge_browser::transport::read(&mut stream),
                    )
                    .await;
                    let value = match request {
                        Ok(Ok(v)) => match serde_json::from_value::<Request>(v) {
                            Ok(req) => dispatch(&app, req).await,
                            Err(e) => failure("INVALID_REQUEST", e.to_string()),
                        },
                        _ => return,
                    };
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        forge_browser::transport::write(&mut stream, &value),
                    )
                    .await;
                });
            }
            // Listener failure revokes capability use; a dead broker must not look healthy.
            host(&app).lock().stopped = true;
            revoke_all(&app);
        });
    }
    Ok(())
}

/// RAII revocation covers every early return, failed spawn and reconnect.
pub struct Lease {
    app: AppHandle,
    pub token: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        host(&self.app).lock().scopes.remove(&self.token);
        changed(&self.app);
    }
}
pub fn attach(app: &AppHandle, scope: Scope) -> Result<Option<Lease>, String> {
    let settings = crate::settings::read(app);
    if !cfg!(windows) || !settings.ai_assistants_enabled || !settings.browser.enabled {
        return Ok(None);
    }
    let token = forge_browser::secret()?;
    host(app).lock().scopes.insert(token.clone(), scope);
    changed(app);
    Ok(Some(Lease {
        app: app.clone(),
        token,
    }))
}
pub fn revoke_all(app: &AppHandle) {
    permissions_changed(app, true);
}
pub fn permissions_changed(app: &AppHandle, disabled: bool) {
    let mut state = host(app).lock();
    let mut reset_pickers = Vec::new();
    if disabled {
        state.scopes.clear();
    }
    for tab in state.tabs.values_mut() {
        if disabled {
            tab.grant = Grant::None;
            if tab.picker.in_use() {
                tab.picker.invalidate();
                reset_pickers.push(tab.id.clone());
            }
        }
        tab.revision += 1;
        tab.refs.clear();
    }
    drop(state);
    for id in reset_pickers { picker::reset_overlay(app, &id); }
    changed(app);
}
pub fn shutdown(app: &AppHandle) {
    revoke_all(app);
    host(app).lock().stopped = true;
}
fn changed(app: &AppHandle) {
    let _ = app.emit("forge-browser-changed", ());
}

fn scope(app: &AppHandle, token: &str) -> Result<Scope, String> {
    let state = host(app).lock();
    if state.stopped {
        return Err("REVOKED: browser host is stopping".into());
    }
    let scope = state
        .scopes
        .get(token)
        .cloned()
        .ok_or("REVOKED: run capability expired")?;
    drop(state);
    if !crate::ai_runtime::browser_run_active(&scope.run) {
        return Err("REVOKED: run stopped".into());
    }
    let settings = crate::settings::read(app);
    if !settings.ai_assistants_enabled || !settings.browser.enabled {
        return Err("REVOKED: AI browser disabled".into());
    }
    Ok(scope)
}
#[derive(Clone)]
pub struct Ticket {
    token: String,
    pub tab: String,
    revision: u64,
    pub epoch: u64,
    pub write: bool,
    expires: std::time::Instant,
}
impl Ticket {
    pub fn check(&self, app: &AppHandle, document: bool) -> Result<Tab, String> {
        if std::time::Instant::now() >= self.expires {
            return Err("REQUEST_EXPIRED: operation deadline exceeded".into());
        }
        let scope = scope(app, &self.token)?;
        let state = host(app).lock();
        let tab = state
            .tabs
            .get(&self.tab)
            .ok_or("TAB_CLOSED: working page closed")?;
        if tab.workspace != scope.workspace
            || tab.session_id != scope.session
            || tab.revision != self.revision
            || tab.grant == Grant::None
        {
            return Err("REVOKED: page grant changed".into());
        }
        if self.write && (scope.read_only || tab.grant != Grant::Control) {
            return Err("READ_ONLY: control grant required".into());
        }
        if !tab.managed && origin(&tab.url) != tab.allowed_origin {
            return Err("REVOKED: user's page changed origin".into());
        }
        if document && self.epoch != tab.epoch {
            return Err("STALE_DOCUMENT: navigation changed the document".into());
        }
        Ok(tab.clone())
    }
}
fn ticket(app: &AppHandle, token: &str, write: bool) -> Result<Ticket, String> {
    let scope = scope(app, token)?;
    let state = host(app).lock();
    let id = state
        .working
        .get(&(scope.workspace, scope.session))
        .ok_or("NO_WORKING_TAB: create or select a page")?;
    let tab = state
        .tabs
        .get(id)
        .ok_or("TAB_CLOSED: explicitly select another page")?;
    let ticket = Ticket {
        token: token.into(),
        tab: id.clone(),
        revision: tab.revision,
        epoch: tab.epoch,
        write,
        expires: std::time::Instant::now() + std::time::Duration::from_secs(40),
    };
    drop(state);
    ticket.check(app, false)?;
    Ok(ticket)
}
async fn dispatch(app: &AppHandle, request: Request) -> Value {
    if request.version != VERSION {
        return failure(
            "VERSION_MISMATCH",
            "restart Forge and its matching companion",
        );
    }
    if let Err(e) = forge_browser::validate(&request.tool, &request.arguments) {
        return failure("INVALID_ARGUMENT", e);
    }
    let result = tools::call(app, &request.token, &request.tool, request.arguments).await;
    match result {
        Ok(v) => v,
        Err(e) => {
            let code = e
                .split(':')
                .next()
                .filter(|s| s.chars().all(|c| c.is_ascii_uppercase() || c == '_'))
                .unwrap_or("BROWSER_ERROR");
            failure(code, &e)
        }
    }
}

async fn create(app: &AppHandle, scope: &Scope, managed: bool) -> Result<Tab, String> {
    let id = forge_browser::secret()?[..24].to_string();
    // Privacy is set before insertion, never as a follow-up after asynchronous WebView creation.
    let mut tab = Tab {
        id: id.clone(),
        order: 0,
        session_id: scope.session.clone(),
        workspace: scope.workspace.clone(),
        url: "about:blank".into(),
        title: String::new(),
        loading: false,
        load_error: None,
        zoom: 1.0,
        emulation: emulation::Emulation::default(),
        preview_scale: 1.0,
        preview_bounds: Bounds { x: 0.0, y: 0.0, width: 800.0, height: 600.0 },
        grant: if managed { Grant::Control } else { Grant::None },
        managed,
        allowed_origin: None,
        epoch: 0,
        revision: 0,
        frame: String::new(),
        refs: HashMap::new(),
        console: VecDeque::new(),
        network: VecDeque::new(),
        contexts: HashMap::new(),
        dialog: None,
        picker: picker::Picker::default(),
        queue: Arc::default(),
    };
    {
        let mut state = host(app).lock();
        if state.tabs.len() >= 16 {
            return Err("LIMIT: at most 16 browser pages".into());
        }
        // HashMap 的迭代顺序不是标签顺序；创建序号保证关闭、插入和重开侧栏时不跳位。
        tab.order = state.next_tab_order;
        state.next_tab_order += 1;
        state.tabs.insert(id.clone(), tab.clone());
    }
    if let Err(e) = surface::create(app, &tab).await {
        host(app).lock().tabs.remove(&id);
        return Err(e);
    }
    if let Err(e) = tools::initialize(app, &id).await {
        host(app).lock().tabs.remove(&id);
        let _ = surface::close(app, id).await;
        return Err(e);
    }
    if managed {
        host(app).lock().working.insert((scope.workspace.clone(), scope.session.clone()), id);
    }
    changed(app);
    Ok(tab)
}
fn invalidate(tab: &mut Tab) {
    tab.epoch += 1;
    tab.refs.clear();
    tab.picker.invalidate();
}
fn origin(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .map(|u| u.origin().ascii_serialization())
}
pub(super) fn event(app: &AppHandle, id: &str, name: &str, value: Value) {
    // WebView2 只在引擎内部绘制悬停高亮，不会把 nodeHighlightRequested 交给宿主。
    // 若落到下面的 Overlay 分支，这次悬停会被当成结束选取。
    if name == "Overlay.nodeHighlightRequested" {
        return;
    }
    if name.starts_with("Overlay.") {
        picker::event(app, id, name, value);
        return;
    }
    let mut state = host(app).lock();
    let Some(tab) = state.tabs.get_mut(id) else {
        return;
    };
    let previous_epoch = tab.epoch;
    let had_picker = tab.picker.in_use();
    match name {
        "titleChanged" => tab.title = value.as_str().unwrap_or_default().chars().take(500).collect(),
        "loadFinished" if value.as_str() == Some(tab.url.as_str()) => tab.loading = false,
        "navigationStarting" => {
            tab.loading = true;
            tab.load_error = None;
            invalidate(tab);
            let url = value.as_str().unwrap_or_default();
            if !tab.managed && tab.allowed_origin != origin(url) {
                tab.grant = Grant::None;
                tab.revision += 1;
            }
            tab.url = url.into();
            tab.contexts.clear();
            tab.console.clear();
            tab.network.clear();
            tab.dialog = None;
        }
        "Page.frameNavigated" if value["frame"]["parentId"].is_null() => {
            invalidate(tab);
            tab.frame = value["frame"]["id"].as_str().unwrap_or_default().into();
            tab.url = value["frame"]["url"].as_str().unwrap_or_default().into();
            tab.contexts.clear();
            if !tab.managed && origin(&tab.url) != tab.allowed_origin {
                tab.grant = Grant::None;
                tab.revision += 1;
                tab.console.clear();
                tab.network.clear();
                tab.dialog = None;
            }
        }
        "Page.navigatedWithinDocument" if value["frameId"] == tab.frame => {
            invalidate(tab);
            tab.url = value["url"].as_str().unwrap_or_default().into();
        }
        "Runtime.executionContextCreated" => {
            if let (Some(context), Some(frame)) = (
                value["context"]["id"].as_i64(),
                value["context"]["auxData"]["frameId"].as_str(),
            ) {
                tab.contexts.insert(context, frame.into());
            }
        }
        "Runtime.executionContextDestroyed" => {
            if let Some(id) = value["executionContextId"].as_i64() {
                tab.contexts.remove(&id);
            }
        }
        "Runtime.executionContextsCleared" => {
            tab.contexts.clear();
        }
        "Runtime.consoleAPICalled" | "Runtime.exceptionThrown" => {
            let context = value["executionContextId"]
                .as_i64()
                .or_else(|| value["exceptionDetails"]["executionContextId"].as_i64());
            if context
                .and_then(|id| tab.contexts.get(&id))
                .is_some_and(|frame| frame == &tab.frame)
            {
                let text = if name == "Runtime.consoleAPICalled" {
                    value["args"].as_array().map(|args| {
                        args.iter()
                            .take(20)
                            .map(|a| a.get("value").unwrap_or(&a["description"]).to_string())
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                } else {
                    Some(value["exceptionDetails"]["text"].to_string())
                }
                .unwrap_or_default();
                bounded_push(
                    &mut tab.console,
                    json!({"type":value["type"],"text":text.chars().take(4000).collect::<String>(),"epoch":tab.epoch}),
                );
            }
        }
        "Network.requestWillBeSent" if value["frameId"] == tab.frame => {
            // Query values and headers can contain credentials; keep only the origin/path.
            let url = value["request"]["url"]
                .as_str()
                .and_then(|s| url::Url::parse(s).ok())
                .map(|mut u| {
                    u.set_query(None);
                    u.set_fragment(None);
                    let _ = u.set_username("");
                    let _ = u.set_password(None);
                    u.to_string()
                });
            bounded_push(
                &mut tab.network,
                json!({"id":value["requestId"],"method":value["request"]["method"],"url":url.map(|s|s.chars().take(4000).collect::<String>()),"type":value["type"],"epoch":tab.epoch}),
            );
        }
        "Network.responseReceived" | "Network.loadingFailed" => {
            if let Some(entry) = tab
                .network
                .iter_mut()
                .rev()
                .find(|entry| entry["id"] == value["requestId"])
            {
                if name == "Network.responseReceived" {
                    entry["status"] = value["response"]["status"].clone();
                    entry["mimeType"] = value["response"]["mimeType"].clone();
                } else {
                    entry["failed"] = json!(true);
                    entry["error"] = json!(value["errorText"]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .take(1000)
                        .collect::<String>());
                    if entry["type"] == "Document" && value["canceled"] != true {
                        tab.load_error = Some(value["errorText"].as_str().unwrap_or("Navigation failed").chars().take(1000).collect());
                        tab.loading = false;
                    }
                }
            }
        }
        "Page.javascriptDialogOpening" => {
            let main_origin = url::Url::parse(&tab.url).ok().map(|u| u.origin());
            let dialog_origin = value["url"]
                .as_str()
                .and_then(|s| url::Url::parse(s).ok())
                .map(|u| u.origin());
            tab.dialog = Some(if main_origin.is_some() && main_origin == dialog_origin {
                json!({"type":value["type"],"message":value["message"].as_str().unwrap_or("").chars().take(4000).collect::<String>(),"scope":"same-origin"})
            } else {
                json!({"type":value["type"],"scope":"denied-frame","message":null})
            });
        }
        "Page.javascriptDialogClosed" => {
            tab.dialog = None;
        }
        _ => (),
    }
    let reset_picker = had_picker && previous_epoch != tab.epoch;
    drop(state);
    if reset_picker { picker::reset_overlay(app, id); }
    changed(app);
}
fn bounded_push(queue: &mut VecDeque<Value>, value: Value) {
    if queue.len() >= 200 {
        queue.pop_front();
    }
    queue.push_back(value);
}

#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[tauri::command]
pub async fn browser_panel_state(app: AppHandle, workspace: String) -> Result<Value, String> {
    if !crate::settings::read(&app).ai_assistants_enabled {
        return Err("AI disabled".into());
    }
    let workspace = crate::ai_runtime::browser_workspace(&workspace)?;
    let state = host(&app).lock();
    let mut tabs = state.tabs.values().filter(|tab| tab.workspace == workspace).collect::<Vec<_>>();
    tabs.sort_by_key(|tab| tab.order);
    Ok(
        json!({"available":cfg!(windows),"version":VERSION,"tabs":tabs,"runs":state.scopes.values().filter(|s| s.workspace == workspace).map(|s| json!({"sessionId":s.session,"runId":s.run,"readOnly":s.read_only})).collect::<Vec<_>>()}),
    )
}

#[tauri::command]
pub async fn browser_panel_open(
    app: AppHandle,
    workspace: String,
    session_id: String,
    url: String,
) -> Result<String, String> {
    let settings = crate::settings::read(&app);
    if !settings.ai_assistants_enabled || !settings.browser.enabled {
        return Err("AI browser disabled".into());
    }
    if session_id.len() > 128 || session_id.is_empty() {
        return Err("invalid session id".into());
    }
    let workspace = crate::ai_runtime::browser_workspace(&workspace)?;
    forge_browser::navigation_url(&url)?;
    let tab = create(
        &app,
        &Scope {
            workspace,
            session: session_id,
            run: String::new(),
            read_only: false,
        },
        false,
    )
    .await?;
    // 有所属会话的手动页默认可操作；无会话页面保持私有，profile 仍与 AI 新建页隔离。
    if tab.session_id != "manual" {
        browser_panel_grant(app.clone(), tab.id.clone(), Grant::Control).await?;
    }
    browser_panel_navigate(app, tab.id.clone(), url).await?;
    Ok(tab.id)
}
#[tauri::command]
pub async fn browser_panel_navigate(
    app: AppHandle,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    let settings = crate::settings::read(&app);
    if !settings.ai_assistants_enabled || !settings.browser.enabled {
        return Err("AI browser disabled".into());
    }
    let url = forge_browser::navigation_url(&url)?;
    {
        let mut state = host(&app).lock();
        let tab = state.tabs.get_mut(&tab_id).ok_or("page closed")?;
        // 用户导航打断在途 AI 请求，但保留用户选择的权限；私有页不会自动重新共享。
        tab.revision += 1;
        tab.refs.clear();
        if !tab.managed && tab.grant != Grant::None {
            tab.allowed_origin = origin(&url);
        }
    }
    changed(&app);
    let tab = panel_tab(&app, &tab_id)?;
    let _queue = tab.queue.lock().await;
    panel_tab(&app, &tab_id)?;
    surface::cdp(
        &app,
        &tab_id,
        "Page.navigate",
        json!({"url":url}),
        None,
        false,
    )
    .await?;
    Ok(())
}
#[tauri::command]
pub async fn browser_panel_grant(
    app: AppHandle,
    tab_id: String,
    grant: Grant,
) -> Result<(), String> {
    let mut state = host(&app).lock();
    let tab = state.tabs.get_mut(&tab_id).ok_or("page closed")?;
    tab.grant = grant;
    tab.revision += 1;
    tab.refs.clear();
    if !tab.managed {
        tab.allowed_origin = if grant == Grant::None {
            None
        } else {
            origin(&tab.url)
        };
    }
    drop(state);
    changed(&app);
    Ok(())
}
#[tauri::command]
pub async fn browser_panel_show(
    app: AppHandle,
    tab_id: Option<String>,
    bounds: Bounds,
) -> Result<(), String> {
    if [bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .any(|n| !n.is_finite() || n.abs() > 20000.0)
        || bounds.width < 1.0
        || bounds.height < 1.0
    {
        return Err("invalid browser bounds".into());
    }
    match tab_id {
        Some(id) => emulation::present(&app, id, bounds).await,
        None => surface::show(&app, None, bounds).await,
    }
}
#[tauri::command]
pub async fn browser_panel_close(app: AppHandle, tab_id: String) -> Result<(), String> {
    host(&app).lock().tabs.remove(&tab_id); // Revoke before touching a native view.
    surface::close(&app, tab_id).await?;
    changed(&app);
    Ok(())
}

fn panel_tab(app: &AppHandle, id: &str) -> Result<Tab, String> {
    let settings = crate::settings::read(app);
    if !settings.ai_assistants_enabled || !settings.browser.enabled {
        return Err("AI browser disabled".into());
    }
    host(app).lock().tabs.get(id).cloned().ok_or("page closed".into())
}

/// 用户界面的诊断与历史状态；页面本身没有调用此 IPC 的权限。
#[tauri::command]
pub async fn browser_panel_details(app: AppHandle, tab_id: String) -> Result<Value, String> {
    panel_tab(&app, &tab_id)?;
    // 只读工具栏状态不占动作队列，AI 等待期间也能显示接管和停止按钮。
    let history = surface::cdp(&app, &tab_id, "Page.getNavigationHistory", json!({}), None, false).await?;
    let tab = panel_tab(&app, &tab_id)?;
    let index = history["currentIndex"].as_i64().unwrap_or(0);
    let count = history["entries"].as_array().map_or(0, Vec::len) as i64;
    Ok(json!({"canGoBack":index>0,"canGoForward":index+1<count,"console":tab.console,"network":tab.network,"dialog":tab.dialog,"picker":tab.picker}))
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum PanelCommand {
    Back, Forward, Reload, Stop, ClearConsole, ClearNetwork, Devtools,
    Zoom { factor: f64 },
    Find { text: String, backward: bool },
    Dialog { accept: bool, text: String },
    Screenshot,
    ElementScreenshot { selection_id: u64 },
    ClearSelection { selection_id: u64 },
    AnnotationResult { selection_id: u64, error: Option<String> },
    Inspect { enabled: bool },
    Emulate { options: Value },
}

/// 地址栏、查找和调试按钮复用同一页队列；不接受任意 CDP 命令。
#[tauri::command]
pub async fn browser_panel_command(app: AppHandle, tab_id: String, command: PanelCommand) -> Result<Value, String> {
    let tab = panel_tab(&app, &tab_id)?;
    // 选取控制不等待 AI 的页面动作队列；取消必须能够立即响应。
    if let PanelCommand::Inspect { enabled } = command {
        return picker::set_enabled(&app, &tab_id, enabled).await;
    }
    if let PanelCommand::ClearSelection { selection_id } = command {
        return picker::clear(&app, &tab_id, selection_id).await;
    }
    if let PanelCommand::AnnotationResult { selection_id, error } = command {
        if error.is_none() {
            return picker::finish(&app, &tab_id, selection_id).await;
        }
        annotation::feedback(&app, &tab_id, selection_id, error.clone()).await?;
        return Ok(Value::Null);
    }
    if let PanelCommand::Emulate { ref options } = command {
        // 先校验再打断请求，非法输入不能改变授权代际或页面状态。
        tab.emulation.patched(options)?;
        let mut state = host(&app).lock();
        let tab = state.tabs.get_mut(&tab_id).ok_or("page closed")?;
        tab.revision += 1;
        tab.refs.clear();
    }
    if matches!(command, PanelCommand::Back | PanelCommand::Forward | PanelCommand::Reload | PanelCommand::Stop) {
        // 提升授权代际先取消在途请求；只有停止明确撤权，同站历史和刷新保留权限。
        let grant = if matches!(command, PanelCommand::Stop) { Grant::None } else { tab.grant };
        browser_panel_grant(app.clone(), tab_id.clone(), grant).await?;
    }
    let _queue = tab.queue.lock().await;
    panel_tab(&app, &tab_id)?;
    let mut result = Value::Null;
    match command {
        PanelCommand::Back | PanelCommand::Forward => {
            let history = surface::cdp(&app, &tab_id, "Page.getNavigationHistory", json!({}), None, false).await?;
            let index = history["currentIndex"].as_i64().unwrap_or(0) + if matches!(command, PanelCommand::Back) { -1 } else { 1 };
            let entry = history["entries"].as_array().and_then(|entries| usize::try_from(index).ok().and_then(|i| entries.get(i))).ok_or("NO_HISTORY: no history entry")?;
            surface::cdp(&app, &tab_id, "Page.navigateToHistoryEntry", json!({"entryId":entry["id"]}), None, false).await?;
        }
        PanelCommand::Reload | PanelCommand::Stop => {
            let stop = matches!(command, PanelCommand::Stop);
            surface::cdp(&app, &tab_id, if stop { "Page.stopLoading" } else { "Page.reload" }, json!({}), None, false).await?;
            if stop { if let Some(tab) = host(&app).lock().tabs.get_mut(&tab_id) { tab.loading = false; } }
        }
        PanelCommand::ClearConsole | PanelCommand::ClearNetwork => {
            if let Some(tab) = host(&app).lock().tabs.get_mut(&tab_id) {
                if matches!(command, PanelCommand::ClearConsole) { tab.console.clear(); } else { tab.network.clear(); }
            }
        }
        PanelCommand::Zoom { factor } => {
            if !factor.is_finite() || !(0.5..=2.0).contains(&factor) { return Err("zoom must be between 50% and 200%".into()); }
            surface::control(&app, tab_id.clone(), Some(factor)).await?;
            if let Some(tab) = host(&app).lock().tabs.get_mut(&tab_id) { tab.zoom = factor; tab.revision += 1; tab.refs.clear(); }
        }
        PanelCommand::Devtools => surface::control(&app, tab_id.clone(), None).await?,
        PanelCommand::Find { text, backward } => {
            if text.chars().count() > 256 { return Err("find query exceeds 256 characters".into()); }
            let world = surface::cdp(&app, &tab_id, "Page.createIsolatedWorld", json!({"frameId":tab.frame,"worldName":"forge-user-find","grantUniveralAccess":false}), None, false).await?;
            let found = surface::cdp(&app, &tab_id, "Runtime.evaluate", json!({"contextId":world["executionContextId"],"expression":format!("window.find({},false,{},true,false,false,false)",serde_json::to_string(&text).map_err(|e|e.to_string())?,backward),"returnByValue":true}), None, false).await?;
            result = json!({"found":found["result"]["value"] == true});
        }
        PanelCommand::Dialog { accept, text } => {
            if text.len() > 4000 { return Err("dialog input exceeds limit".into()); }
            surface::cdp(&app, &tab_id, "Page.handleJavaScriptDialog", json!({"accept":accept,"promptText":text}), None, false).await?;
        }
        PanelCommand::Screenshot => {
            let metrics = surface::cdp(&app, &tab_id, "Page.getLayoutMetrics", json!({}), None, false).await?;
            let viewport = &metrics["cssVisualViewport"];
            let number = |key: &str| viewport[key].as_f64().filter(|n|n.is_finite()).ok_or("页面可视区域不可用");
            let (x, y, width, height, scale) = (number("pageX")?, number("pageY")?, number("clientWidth")?, number("clientHeight")?, number("scale")?);
            let zoom = number("zoom")?;
            if width <= 0.0 || height <= 0.0 || scale <= 0.0 || zoom <= 0.0 { return Err("页面可视区域为空".into()); }
            // 默认 surface 截图包含滚动条旁的留白；clip 使用文档坐标，仅取当前可视网页。
            // 保留触摸缩放及设备 DPR，由引擎输出清晰 PNG，不截宿主或自动裁白色网页内容。
            // CDP clip 使用 DIP；文档位置和尺寸都乘页面 zoom，触摸 scale 独立保留。
            let image = picker::capture(&app, &tab_id, json!({"format":"png","captureBeyondViewport":false,
                "clip":{"x":x*zoom,"y":y*zoom,"width":width*zoom,"height":height*zoom,"scale":scale}}), None, false).await?;
            let data = image["data"].as_str().filter(|data|data.len()<=8*1024*1024).ok_or("screenshot exceeds limit")?;
            // 用户截图交给现有会话附件沙箱和剪贴板，不再接受任意写盘路径，也不改变 AI 授权。
            result = json!({"dataUrl":format!("data:image/png;base64,{data}")});
        }
        PanelCommand::ElementScreenshot { selection_id } => {
            result = picker::screenshot(&app, &tab_id, selection_id).await?;
        }
        PanelCommand::Inspect { .. } => unreachable!(),
        PanelCommand::ClearSelection { .. } => unreachable!(),
        PanelCommand::AnnotationResult { .. } => unreachable!(),
        PanelCommand::Emulate { options } => { result = emulation::apply(&app, &tab_id, options, None).await?; }
    }
    changed(&app);
    Ok(result)
}
