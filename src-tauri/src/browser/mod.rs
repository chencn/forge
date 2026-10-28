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
    /// AI 总开关与浏览器子开关的内存镜像。派发时的复查读它，不读磁盘；
    /// 每次工具调用的入口和设置保存路径都按磁盘值校验，所以这里不会放宽授权。
    enabled: bool,
    /// surface 关闭失败时留下的页面 id；下一次关闭会再试一次，不让原生视图永久无主。
    pending_close: Vec<String>,
    /// broker 待连接管道地址。起 broker 失败时为空，AI 启动据此不注入。
    endpoint: String,
    /// 浏览器宿主没能起来的原因。面板据此显示不可用，不能假装健康。
    unavailable: Option<String>,
    /// 界面语言与主题的内存镜像。批注浮层每次呈现都要用，那条路跑在 UI 线程上，
    /// 不能为了这两个字段去读磁盘；写入只发生在 `sync_capability` 与设置保存。
    appearance: (String, String),
}
pub struct Host {
    state: Mutex<State>,
}
impl Host {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}
pub fn host(app: &AppHandle) -> &Host {
    app.state::<Host>().inner()
}

/// 浏览器只是 AI 的附属能力：握手版本不一致、随机数失败或管道被拒都不能中止整个应用。
/// 状态先登记，起不来就记进 `unavailable`，由面板显示、由 `attach` 退回不注入。
pub fn init(app: &AppHandle) {
    app.manage(Host { state: Mutex::new(State { stopped: true, ..Default::default() }) });
    #[cfg(windows)]
    if let Err(error) = start(app) {
        host(app).lock().unavailable = Some(error);
    }
}

#[cfg(windows)]
fn start(app: &AppHandle) -> Result<(), String> {
    if VERSION != env!("CARGO_PKG_VERSION") {
        return Err("Forge browser companion and desktop manifest versions differ".into());
    }
    let nonce = forge_browser::secret()?;
    let endpoint = format!(r"\\.\pipe\forge-browser-{}-{}", std::process::id(), &nonce[..24]);
    // Create before publishing the endpoint: startup errors cannot look like a healthy service.
    let mut listener = {
        // setup runs on the UI thread, outside Tokio's reactor context.
        let runtime = tauri::async_runtime::handle();
        let _entered = runtime.inner().enter();
        forge_browser::transport::server(&endpoint, true)?
    };
    {
        let settings = crate::settings::read(app);
        let mut state = host(app).lock();
        state.endpoint = endpoint.clone();
        state.stopped = false;
        state.enabled = settings.ai_assistants_enabled && settings.browser.enabled;
        state.appearance = (settings.language, settings.theme);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let slots = Arc::new(tokio::sync::Semaphore::new(16));
        loop {
            if host(&app).lock().stopped {
                break;
            }
            // 客户端连上又立刻断开（CLI 中途被杀）或实例交接竞态都会让 connect() 报错。
            // 那是这一条连接的事，不能把整个宿主停摆到应用重启为止。
            let accepted = listener.connect().await.is_ok();
            let next = match forge_browser::transport::server(&endpoint, false) {
                Ok(next) => next,
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    continue;
                }
            };
            let mut stream = std::mem::replace(&mut listener, next);
            if !accepted {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                continue;
            }
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
    });
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
    // broker 没能起来时不注入：会话照常跑，只是没有浏览器工具，不能让每条消息都失败。
    if !cfg!(windows) || host(app).lock().stopped || !sync_capability(app) {
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
    state.enabled = !disabled;
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

/// 读一次磁盘上的有效能力，同时把结果写回内存镜像。
/// 只有走过这条的路径才有资格让派发复查读镜像，否则镜像会比磁盘旧一轮。
/// 顺带把语言与主题也存进镜像：批注浮层在 UI 线程上呈现，不能为这两个字段读磁盘。
fn sync_capability(app: &AppHandle) -> bool {
    let settings = crate::settings::read(app);
    let enabled = settings.ai_assistants_enabled && settings.browser.enabled;
    let mut state = host(app).lock();
    state.enabled = enabled;
    state.appearance = (settings.language, settings.theme);
    enabled
}

/// 设置保存那条路调它：把刚写进磁盘那份的开关与呈现字段灌进镜像。
/// 保存发生在阻塞线程上，之后 UI 线程只管读镜像，不再为一次浮层呈现读文件。
pub fn settings_saved(app: &AppHandle, settings: &crate::settings::Settings) {
    let mut state = host(app).lock();
    state.enabled = settings.ai_assistants_enabled && settings.browser.enabled;
    state.appearance = (settings.language.clone(), settings.theme.clone());
}

fn scope(app: &AppHandle, token: &str) -> Result<Scope, String> {
    scope_with(app, token, true)
}
/// 派发时的复查走这条：身份、代际、期限和撤权一律照查，只是有效能力读内存镜像，
/// 免得每次 CDP 调用都在 UI 线程读一遍 settings.json。
fn scope_at_dispatch(app: &AppHandle, token: &str) -> Result<Scope, String> {
    scope_with(app, token, false)
}

fn scope_with(app: &AppHandle, token: &str, fresh: bool) -> Result<Scope, String> {
    let state = host(app).lock();
    if state.stopped {
        return Err("REVOKED: browser host is stopping".into());
    }
    let scope = state
        .scopes
        .get(token)
        .cloned()
        .ok_or("REVOKED: run capability expired")?;
    let enabled = state.enabled;
    drop(state);
    if !crate::ai_runtime::browser_run_active(&scope.run) {
        return Err("REVOKED: run stopped".into());
    }
    if fresh {
        if !sync_capability(app) {
            return Err("REVOKED: AI browser disabled".into());
        }
    } else if !enabled {
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
        self.check_with(app, document, true)
    }
    /// UI 线程派发前的那一次复查。期限、身份、代际、授权全部照查，只有有效能力读镜像。
    pub fn check_dispatch(&self, app: &AppHandle, document: bool) -> Result<Tab, String> {
        self.check_with(app, document, false)
    }
    fn check_with(&self, app: &AppHandle, document: bool, fresh: bool) -> Result<Tab, String> {
        if std::time::Instant::now() >= self.expires {
            return Err("REQUEST_EXPIRED: operation deadline exceeded".into());
        }
        let scope = if fresh {
            scope(app, &self.token)?
        } else {
            scope_at_dispatch(app, &self.token)?
        };
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
            // 面板侧错误带 error::SEP 分段，工具侧沿用 `CODE: detail`；两种写法都取稳定码。
            let head = e.split([':', crate::error::SEP]).next().unwrap_or("");
            let code = (!head.is_empty()
                && head.chars().all(|c| c.is_ascii_uppercase() || c == '_'))
                .then_some(head)
                .unwrap_or("BROWSER_ERROR");
            // 模型读不到控制字符，给它的原文把分段换成冒号。
            failure(code, e.replace(crate::error::SEP, ": "))
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
            return Err(crate::error::err_parts("BROWSER_TAB_LIMIT", &["16".into()]));
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
        let _ = forget_surface(app, id.clone()).await;
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
/// 重定向和页面自跳也吃同一条内网限制：AI 托管页不许进私网 IP 字面量，人工页由用户自己决定。
pub(super) fn managed_private_target(app: &AppHandle, id: &str, url: &str) -> bool {
    host(app).lock().tabs.get(id).is_some_and(|tab| tab.managed)
        && forge_browser::private_literal_target(url)
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
        return Err(crate::error::err("BROWSER_DISABLED", "AI assistants are off"));
    }
    let workspace = crate::ai_runtime::browser_workspace(&workspace)?;
    let state = host(&app).lock();
    let mut tabs = state.tabs.values().filter(|tab| tab.workspace == workspace).collect::<Vec<_>>();
    tabs.sort_by_key(|tab| tab.order);
    Ok(
        json!({"available":cfg!(windows) && !state.stopped && state.unavailable.is_none(),"unavailable":state.unavailable,"version":VERSION,"tabs":tabs,"runs":state.scopes.values().filter(|s| s.workspace == workspace).map(|s| json!({"sessionId":s.session,"runId":s.run,"readOnly":s.read_only})).collect::<Vec<_>>()}),
    )
}

#[tauri::command]
pub async fn browser_panel_open(
    app: AppHandle,
    workspace: String,
    session_id: String,
    url: String,
) -> Result<String, String> {
    if !sync_capability(&app) {
        return Err(crate::error::err("BROWSER_DISABLED", "AI browser disabled"));
    }
    if session_id.len() > 128 || session_id.is_empty() {
        return Err(crate::error::err("BROWSER_SESSION", "invalid session id"));
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
    let opened = async {
        if tab.session_id != "manual" {
            browser_panel_grant(app.clone(), tab.id.clone(), Grant::Control).await?;
        }
        browser_panel_navigate(app.clone(), tab.id.clone(), url).await
    }
    .await;
    if let Err(error) = opened {
        // 页面已经建出来了，后面任何一步失败都要把它收回去：否则会留下一张没有回收入口、
        // 还占着页面配额的孤儿视图。关闭失败时 id 会留在 pending_close 里重试。
        let _ = browser_panel_close(app, tab.id.clone()).await;
        return Err(error);
    }
    Ok(tab.id)
}
#[tauri::command]
pub async fn browser_panel_navigate(
    app: AppHandle,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    if !sync_capability(&app) {
        return Err(crate::error::err("BROWSER_DISABLED", "AI browser disabled"));
    }
    let url = forge_browser::navigation_url(&url)?;
    {
        let mut state = host(&app).lock();
        let tab = state.tabs.get_mut(&tab_id).ok_or_else(|| crate::error::err("TAB_CLOSED", "page closed"))?;
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
    let tab = state.tabs.get_mut(&tab_id).ok_or_else(|| crate::error::err("TAB_CLOSED", "page closed"))?;
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
        return Err(crate::error::err("BROWSER_BOUNDS", "invalid browser bounds"));
    }
    match tab_id {
        Some(id) => emulation::present(&app, id, bounds).await,
        None => surface::show(&app, None, bounds).await,
    }
}
/// 关闭原生视图；失败时记住页面 id，而不是把 id 和视图一起丢掉。
async fn forget_surface(app: &AppHandle, id: String) -> Result<(), String> {
    match surface::close(app, id.clone()).await {
        Ok(()) => Ok(()),
        Err(error) => {
            host(app).lock().pending_close.push(id);
            Err(error)
        }
    }
}

/// 重试上一轮没关掉的 surface。再次失败就放回列表，等下一次关闭，不自旋。
async fn flush_surfaces(app: &AppHandle) {
    let ids = std::mem::take(&mut host(app).lock().pending_close);
    let mut retry = Vec::new();
    for id in ids {
        if surface::close(app, id.clone()).await.is_err() {
            retry.push(id);
        }
    }
    if !retry.is_empty() {
        host(app).lock().pending_close = retry;
    }
}

#[tauri::command]
pub async fn browser_panel_close(app: AppHandle, tab_id: String) -> Result<(), String> {
    // 先撤权再动原生视图：AI 立刻看不见这张页；页面条目要等 surface 真的关掉才移除，
    // 否则一次关闭失败就让这张页永久没有回收入口。
    if let Some(tab) = host(&app).lock().tabs.get_mut(&tab_id) {
        tab.grant = Grant::None;
        tab.refs.clear();
    }
    let closed = forget_surface(&app, tab_id.clone()).await;
    if closed.is_ok() {
        // 只从 tabs 摘掉，`working` 里的那条要留着：关闭工作页后 AI 必须收到 TAB_CLOSED，
        // 而不是悄悄落到当前活动页。
        host(&app).lock().tabs.remove(&tab_id);
    }
    flush_surfaces(&app).await;
    changed(&app);
    closed
}

fn panel_tab(app: &AppHandle, id: &str) -> Result<Tab, String> {
    if !sync_capability(app) {
        return Err(crate::error::err("BROWSER_DISABLED", "AI browser disabled"));
    }
    host(app).lock().tabs.get(id).cloned().ok_or_else(|| crate::error::err("TAB_CLOSED", "page closed"))
}

/// 主线程那一侧的页查询：有效能力读内存镜像。批注浮层每次呈现都要查一次页状态，
/// 那条路不能去读 settings.json；镜像由 `sync_capability` 与 `settings_saved` 写。
pub(super) fn panel_tab_mirror(app: &AppHandle, id: &str) -> Result<Tab, String> {
    let state = host(app).lock();
    if !state.enabled {
        return Err(crate::error::err("BROWSER_DISABLED", "AI browser disabled"));
    }
    state.tabs.get(id).cloned().ok_or_else(|| crate::error::err("TAB_CLOSED", "page closed"))
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
        let tab = state.tabs.get_mut(&tab_id).ok_or_else(|| crate::error::err("TAB_CLOSED", "page closed"))?;
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
            let entry = history["entries"].as_array().and_then(|entries| usize::try_from(index).ok().and_then(|i| entries.get(i))).ok_or(crate::error::err("BROWSER_NO_HISTORY", "no history entry"))?;
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
            if !factor.is_finite() || !(0.5..=2.0).contains(&factor) { return Err(crate::error::err("BROWSER_ZOOM", "zoom must be between 50% and 200%")); }
            surface::control(&app, tab_id.clone(), Some(factor)).await?;
            if let Some(tab) = host(&app).lock().tabs.get_mut(&tab_id) { tab.zoom = factor; tab.revision += 1; tab.refs.clear(); }
        }
        PanelCommand::Devtools => surface::control(&app, tab_id.clone(), None).await?,
        PanelCommand::Find { text, backward } => {
            if text.chars().count() > 256 { return Err(crate::error::err_parts("BROWSER_FIND_LIMIT", &["256".into()])); }
            let world = surface::cdp(&app, &tab_id, "Page.createIsolatedWorld", json!({"frameId":tab.frame,"worldName":"forge-user-find","grantUniveralAccess":false}), None, false).await?;
            let found = surface::cdp(&app, &tab_id, "Runtime.evaluate", json!({"contextId":world["executionContextId"],"expression":format!("window.find({},false,{},true,false,false,false)",serde_json::to_string(&text).map_err(|e|e.to_string())?,backward),"returnByValue":true}), None, false).await?;
            result = json!({"found":found["result"]["value"] == true});
        }
        PanelCommand::Dialog { accept, text } => {
            if text.len() > 4000 { return Err(crate::error::err("BROWSER_DIALOG_LIMIT", "dialog input exceeds 4000 characters")); }
            surface::cdp(&app, &tab_id, "Page.handleJavaScriptDialog", json!({"accept":accept,"promptText":text}), None, false).await?;
        }
        PanelCommand::Screenshot => {
            // 适配缩放只是把设备画面缩小呈现，布局视口始终是设备尺寸。
            // 所以按设备矩形裁一次就是整屏；截图期间不能改设备参数，改了页面会当场跳成 100%。
            let device = {
                let state = host(&app).lock();
                let tab = state.tabs.get(&tab_id).ok_or(crate::error::err("TAB_CLOSED", "page closed"))?;
                tab.emulation.width.map(|width| (width as f64, tab.emulation.height as f64))
            };
            let read = |metrics: &Value| -> Result<(emulation::CssBox, emulation::CssBox, f64, f64), String> {
                let visual = &metrics["cssVisualViewport"];
                let layout = &metrics["cssLayoutViewport"];
                let number = |value: &Value, key: &str| value[key].as_f64().filter(|n| n.is_finite()).ok_or(crate::error::err("BROWSER_VIEWPORT", "page visible area is unavailable"));
                let visual_box = emulation::CssBox {
                    x: number(visual, "pageX")?, y: number(visual, "pageY")?,
                    width: number(visual, "clientWidth")?, height: number(visual, "clientHeight")?,
                };
                let layout_box = emulation::CssBox {
                    x: number(layout, "pageX").unwrap_or(visual_box.x),
                    y: number(layout, "pageY").unwrap_or(visual_box.y),
                    width: number(layout, "clientWidth").unwrap_or(visual_box.width),
                    height: number(layout, "clientHeight").unwrap_or(visual_box.height),
                };
                Ok((visual_box, layout_box, number(visual, "scale")?, number(visual, "zoom")?))
            };
            let metrics = surface::cdp(&app, &tab_id, "Page.getLayoutMetrics", json!({}), None, false).await?;
            let (visual, layout, scale, zoom) = read(&metrics)?;
            if visual.width <= 0.0 || visual.height <= 0.0 || scale <= 0.0 || zoom <= 0.0 { return Err(crate::error::err("BROWSER_VIEWPORT", "page visible area is empty")); }
            let region = emulation::screenshot_region(visual, layout, device);
            if region.width <= 0.0 || region.height <= 0.0 { return Err(crate::error::err("BROWSER_VIEWPORT", "page visible area is empty")); }
            // 默认 surface 截图包含滚动条旁的留白；clip 使用文档坐标，仅取当前设备视口。
            // 保留触摸缩放及设备 DPR，由引擎输出清晰 PNG。CDP clip 使用 DIP，位置和尺寸乘页面 zoom。
            let image = picker::capture(&app, &tab_id, json!({"format":"png","captureBeyondViewport":false,
                "clip":{"x":region.x*zoom,"y":region.y*zoom,"width":region.width*zoom,"height":region.height*zoom,"scale":scale}}), None, false).await?;
            let data = image["data"].as_str().filter(|data| data.len() <= 8 * 1024 * 1024).ok_or(crate::error::err("BROWSER_PICK_LIMIT", "page screenshot exceeds the size limit"))?;
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
