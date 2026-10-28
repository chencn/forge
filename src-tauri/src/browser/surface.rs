//! All wry and COM objects stay on the UI thread. Await callbacks elsewhere.
use super::{Bounds, Tab, Ticket};
use serde_json::Value;
use tauri::AppHandle;

pub(super) async fn ui<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(15), rx)
        .await
        .map_err(|_| "TIMEOUT: UI thread unavailable")?
        .map_err(|_| "browser UI callback lost")?
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{cell::RefCell, collections::HashMap};
    use tauri::Manager;
    use tauri_runtime_wry::wry::{self, dpi, Rect, WebContext, WebViewBuilder, WebViewExtWindows};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2Controller, ICoreWebView2DevToolsProtocolEventReceiver,
        COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC, COREWEBVIEW2_PERMISSION_STATE_DENY,
        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
    };
    use webview2_com::{
        AcceleratorKeyPressedEventHandler,
        take_pwstr, CallDevToolsProtocolMethodCompletedHandler,
        DevToolsProtocolEventReceivedEventHandler, PermissionRequestedEventHandler,
    };
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::UI::Shell::{
        DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClientRect, GetCursorPos, GetWindowRect, IsChild, SetWindowPos, SIZE_MINIMIZED,
        SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOZORDER, WM_MOVE, WM_MOVING, WM_NCDESTROY,
        WM_SIZE, WindowFromPoint,
    };
    struct Surface {
        view: wry::WebView,
        profile: (String, String, bool),
        width: f64,
        height: f64,
        _receivers: Vec<ICoreWebView2DevToolsProtocolEventReceiver>,
    }
    thread_local! {
        static VIEWS: RefCell<HashMap<String,Surface>> = RefCell::new(HashMap::new());
        static CONTEXTS: RefCell<HashMap<(String,String,bool),WebContext>> = RefCell::new(HashMap::new());
        static PRESENTED: RefCell<Option<String>> = const { RefCell::new(None) };
    }
    pub fn presented() -> Option<String> { PRESENTED.with(|p|p.borrow().clone()) }
    fn rect(b: Bounds) -> Rect {
        Rect {
            position: dpi::LogicalPosition::new(b.x, b.y).into(),
            size: dpi::LogicalSize::new(b.width, b.height).into(),
        }
    }
    fn core(id: &str) -> Result<ICoreWebView2, String> {
        VIEWS.with(|v| {
            v.borrow()
                .get(id)
                .map(|s| s.view.webview())
                .ok_or("TAB_CLOSED: native page closed".into())
        })
    }

    pub async fn create(app: &AppHandle, tab: &Tab) -> Result<(), String> {
        let app2 = app.clone();
        let tab = tab.clone();
        ui(app, move || {
            let parent = app2
                .get_webview_window("main")
                .ok_or("main WebviewWindow missing")?;
            hold_resize(&parent)?;
            let profile_root = app2
                .path()
                .app_local_data_dir()
                .map_err(|e| e.to_string())?
                .join("browser-profiles");
            #[cfg(feature = "browser-smoke")]
            let profile_root = if app2.config().identifier == "app.forge.browser-smoke" {
                std::path::PathBuf::from(
                    std::env::var("FORGE_BROWSER_SMOKE_ROOT").map_err(|e| e.to_string())?,
                )
                .join("browser-profiles")
            } else {
                profile_root
            };
            std::fs::create_dir_all(&profile_root).map_err(|e| e.to_string())?;
            // A persistent random directory is mapped by exact workspace/session keys.
            let index_path = profile_root.join("profiles.json");
            let mut profiles: HashMap<String, String> = match std::fs::read(&index_path) {
                Ok(bytes) => serde_json::from_slice(&bytes)
                    .map_err(|e| format!("invalid browser profile index: {e}"))?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
                Err(e) => return Err(e.to_string()),
            };
            let key = serde_json::to_string(&(
                tab.workspace.clone(),
                tab.session_id.clone(),
                tab.managed,
            ))
            .map_err(|e| e.to_string())?;
            let directory = profiles
                .entry(key)
                .or_insert(forge_browser::secret()?)
                .clone();
            if directory.len() != 64 || !directory.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("invalid browser profile directory".into());
            }
            crate::sys::write_atomic(
                &index_path,
                &serde_json::to_string(&profiles).map_err(|e| e.to_string())?,
            )?;
            let id = tab.id.clone();
            let app_nav = app2.clone();
            let app_title = app2.clone();
            let title_id = id.clone();
            let app_load = app2.clone();
            let load_id = id.clone();
            let view = CONTEXTS.with(|contexts| {
                let mut contexts = contexts.borrow_mut();
                let context = contexts
                    .entry((tab.workspace.clone(), tab.session_id.clone(), tab.managed))
                    .or_insert_with(|| WebContext::new(Some(profile_root.join(directory))));
                WebViewBuilder::new_with_web_context(context)
                    // WebView2 ignores input when IsVisible=false. Background pages render
                    // outside the parent client area so CDP input and screenshots still work.
                    .with_bounds(rect(Bounds {
                        x: -10000.0,
                        y: -10000.0,
                        width: 800.0,
                        height: 600.0,
                    }))
                    .with_visible(true)
                    // 用户工具栏需要在发布版打开网页 DevTools；不开放远程调试端口。
                    .with_devtools(true)
                    .with_url("about:blank")
                    .with_document_title_changed_handler(move |title| {
                        super::super::event(&app_title, &title_id, "titleChanged", Value::String(title));
                    })
                    .with_on_page_load_handler(move |event, url| {
                        if matches!(event, wry::PageLoadEvent::Finished) {
                            super::super::event(&app_load, &load_id, "loadFinished", Value::String(url));
                        }
                    })
                    .with_navigation_handler(move |url| {
                        if url == "about:blank" || forge_browser::navigation_url(&url).is_ok() {
                            super::super::event(
                                &app_nav,
                                &id,
                                "navigationStarting",
                                Value::String(url),
                            );
                            true
                        } else {
                            false
                        }
                    })
                    .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
                    .with_download_started_handler(|_, _| false)
                    // No IPC handler, host objects, custom protocols or Tauri registration.
                    .build_as_child(&parent)
                    .map_err(|e| e.to_string())
            })?;
            let webview = view.webview();
            unsafe {
                let app_key = app2.clone();
                let key_id = tab.id.clone();
                let mut key_token = 0;
                // CDP Overlay 没有 DevTools 前端替它处理 Esc，原生子视图必须自己接管。
                view.controller().add_AcceleratorKeyPressed(
                    &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            let mut key = 0;
                            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                            args.VirtualKey(&mut key)?;
                            args.KeyEventKind(&mut kind)?;
                            if key == 27 && kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                                && super::super::host(&app_key).lock().tabs.get(&key_id).is_some_and(|tab| tab.picker.active) {
                                args.SetHandled(true)?;
                                super::super::event(&app_key, &key_id, "Overlay.inspectModeCanceled", Value::Null);
                            }
                        }
                        Ok(())
                    })), &mut key_token,
                ).map_err(|e| e.to_string())?;
                let settings = webview.Settings().map_err(|e| e.to_string())?;
                settings
                    .SetIsWebMessageEnabled(false)
                    .map_err(|e| e.to_string())?;
                settings
                    .SetAreHostObjectsAllowed(false)
                    .map_err(|e| e.to_string())?;
                settings
                    .SetAreDefaultContextMenusEnabled(false)
                    .map_err(|e| e.to_string())?;
                let mut token = 0;
                webview
                    .add_PermissionRequested(
                        &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                            if let Some(args) = args {
                                args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                            }
                            Ok(())
                        })),
                        &mut token,
                    )
                    .map_err(|e| e.to_string())?;
            }
            let mut receivers = Vec::new();
            for name in [
                "Page.frameNavigated",
                "Page.navigatedWithinDocument",
                "Runtime.executionContextCreated",
                "Runtime.executionContextDestroyed",
                "Runtime.executionContextsCleared",
                "Runtime.consoleAPICalled",
                "Runtime.exceptionThrown",
                "Network.requestWillBeSent",
                "Network.responseReceived",
                "Network.loadingFailed",
                "Page.javascriptDialogOpening",
                "Page.javascriptDialogClosed",
                "Overlay.inspectNodeRequested",
                "Overlay.nodeHighlightRequested",
                "Overlay.inspectModeCanceled",
            ] {
                let receiver =
                    unsafe { webview.GetDevToolsProtocolEventReceiver(&HSTRING::from(name)) }
                        .map_err(|e| e.to_string())?;
                let app = app2.clone();
                let id = tab.id.clone();
                let mut token = 0;
                unsafe {
                    receiver.add_DevToolsProtocolEventReceived(
                        &DevToolsProtocolEventReceivedEventHandler::create(Box::new(
                            move |_, args| {
                                if let Some(args) = args {
                                    let mut raw = PWSTR::null();
                                    if args.ParameterObjectAsJson(&mut raw).is_ok() {
                                        let text = take_pwstr(raw);
                                        if text.len() <= 1024 * 1024 {
                                            if let Ok(value) = serde_json::from_str(&text) {
                                                super::super::event(&app, &id, name, value);
                                            }
                                        }
                                    }
                                }
                                Ok(())
                            },
                        )),
                        &mut token,
                    )
                }
                .map_err(|e| e.to_string())?;
                receivers.push(receiver);
            }
            VIEWS.with(|v| {
                v.borrow_mut().insert(
                    tab.id,
                    Surface {
                        view,
                        profile: (tab.workspace, tab.session_id, tab.managed),
                        width: 800.0,
                        height: 600.0,
                        _receivers: receivers,
                    },
                )
            });
            Ok(())
        })
        .await
    }
    pub async fn cdp(
        app: &AppHandle,
        id: &str,
        method: &str,
        params: Value,
        ticket: Option<Ticket>,
        document: bool,
    ) -> Result<Value, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let app2 = app.clone();
        let id = id.to_string();
        let method = method.to_string();
        // Only schedule the COM call here; never block/pump the UI event loop waiting for it.
        ui(app, move || {
            if let Some(ticket) = ticket {
                ticket.check(&app2, document)?;
            }
            let webview = core(&id)?;
            // 标明失败的方法，WebView2 的“参数错误”本身无法定位具体操作；不记录参数或页面内容。
            let response_method = method.clone();
            let handler =
                CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, raw| {
                    let value = result
                        .map_err(|e| e.to_string())
                        .and_then(|_| {
                            if raw.len() > forge_browser::MAX_FRAME {
                                return Err("LIMIT: CDP response exceeds 8 MiB".into());
                            }
                            serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string())
                        })
                        .and_then(|v| {
                            if v.get("error").is_some() {
                                Err(format!("CDP error: {}", v["error"]))
                            } else {
                                Ok(v)
                            }
                        }).map_err(|e| format!("{response_method}: {e}"));
                    let _ = tx.send(value);
                    Ok(())
                }));
            unsafe {
                webview.CallDevToolsProtocolMethod(
                    &HSTRING::from(method.as_str()),
                    &HSTRING::from(params.to_string()),
                    &handler,
                )
            }
            .map_err(|e| format!("{method}: {e}"))
        })
        .await?;
        tokio::time::timeout(std::time::Duration::from_secs(12), rx)
            .await
            .map_err(|_| "TIMEOUT: CDP callback exceeded deadline; action may have dispatched")?
            .map_err(|_| "CDP callback lost")?
    }
    /// 光标相对页面视口的 CSS 坐标。指针不在这个页面上时返回 None，避免隔着评论框误标。
    pub async fn viewport_cursor(app: &AppHandle, id: &str, zoom: f64, preview_scale: f64) -> Result<Option<(f64, f64)>, String> {
        let app = app.clone();
        let id = id.to_string();
        ui(&app, move || {
            let hwnd = VIEWS.with(|views| views.borrow().get(&id).ok_or("page closed".to_string())?.view.hwnd().map_err(|e| e.to_string()))?;
            let scale = app.get_webview_window("main").and_then(|window| window.scale_factor().ok()).filter(|scale| scale.is_finite() && *scale > 0.0).unwrap_or(1.0);
            let mut cursor = POINT::default();
            unsafe { GetCursorPos(&mut cursor) }.map_err(|e| e.to_string())?;
            let hit = unsafe { WindowFromPoint(cursor) };
            if hit != hwnd && !unsafe { IsChild(hwnd, hit) }.as_bool() { return Ok(None); }
            let mut rect = RECT::default();
            unsafe { GetWindowRect(hwnd, &mut rect) }.map_err(|e| e.to_string())?;
            let x = cursor.x - rect.left;
            let y = cursor.y - rect.top;
            if x < 0 || y < 0 || x >= rect.right - rect.left || y >= rect.bottom - rect.top { return Ok(None); }
            let unit = scale * preview_scale * zoom;
            if !unit.is_finite() || unit <= 0.0 { return Ok(None); }
            Ok(Some((x as f64 / unit, y as f64 / unit)))
        }).await
    }
    /// 仅主界面可以调用的有限浏览器控件，不向 MCP 暴露任意原生方法。
    pub async fn control(app: &AppHandle, id: String, zoom: Option<f64>) -> Result<(), String> {
        ui(app, move || {
            if let Some(factor) = zoom {
                VIEWS.with(|views| views.borrow().get(&id).ok_or("page closed")?.view.zoom(factor).map_err(|e| e.to_string()))
            } else {
                unsafe { core(&id)?.OpenDevToolsWindow().map_err(|e| e.to_string()) }
            }
        }).await
    }
    pub async fn show(app: &AppHandle, id: Option<String>, bounds: Bounds) -> Result<(), String> {
        let app2 = app.clone();
        ui(app, move || {
            let settings = crate::settings::read(&app2);
            // A queued presentation must not reveal a page after the master switch was disabled.
            let id = if settings.ai_assistants_enabled && settings.browser.enabled {
                id.filter(|id| super::super::host(&app2).lock().tabs.contains_key(id))
            } else {
                None
            };
            let previous = PRESENTED.with(|p| p.replace(id.clone()));
            if previous.is_some() && previous != id {
                // A moved-away native child must not retain the user's keyboard focus.
                if let Some(parent) = app2.get_webview_window("main") {
                    let _ = parent.with_webview(|p| unsafe {
                        let _ = p
                            .controller()
                            .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                    });
                }
            }
            VIEWS.with(|views| {
                for (key, surface) in views.borrow_mut().iter_mut() {
                    let visible = id.as_ref() == Some(key);
                    if visible {
                        surface.width = bounds.width;
                        surface.height = bounds.height;
                    }
                    surface
                        .view
                        .set_bounds(rect(Bounds {
                            x: if visible { bounds.x } else { -10000.0 },
                            y: if visible { bounds.y } else { -10000.0 },
                            width: surface.width,
                            height: surface.height,
                        }))
                        .map_err(|e| e.to_string())?;
                    surface.view.set_visible(true).map_err(|e| e.to_string())?;
                }
                Ok::<_,String>(())
            })?;
            super::super::annotation::present(&app2)
        })
        .await
    }
    /// 调整设备外框时保留当前显示状态，不能让设置弹层后面的页面重新出现。
    pub async fn reframe(app: &AppHandle, id: &str, bounds: Bounds) -> Result<(), String> {
        let id = id.to_string();
        ui(app, move || {
            let visible = PRESENTED.with(|current| current.borrow().as_ref() == Some(&id));
            VIEWS.with(|views| {
                let mut views = views.borrow_mut();
                let surface = views.get_mut(&id).ok_or("TAB_CLOSED: native page closed")?;
                surface.view.set_bounds(rect(Bounds {
                    x: if visible { bounds.x } else { -10000.0 },
                    y: if visible { bounds.y } else { -10000.0 },
                    width: bounds.width, height: bounds.height,
                })).map_err(|e| e.to_string())?;
                surface.width = bounds.width;
                surface.height = bounds.height;
                Ok(())
            })
        }).await
    }
    pub async fn close(app: &AppHandle, id: String) -> Result<(), String> {
        let app2 = app.clone();
        ui(app, move || {
            PRESENTED.with(|p| { if p.borrow().as_ref() == Some(&id) {p.replace(None);} });
            let unused = VIEWS.with(|v| {
                let removed = v.borrow_mut().remove(&id);
                let profile = removed.as_ref().map(|v| v.profile.clone());
                drop(removed); // Release controllers before their WebContext.
                profile.filter(|key| !v.borrow().values().any(|s| &s.profile == key))
            });
            if let Some(profile) = unused {
                CONTEXTS.with(|c| {
                    c.borrow_mut().remove(&profile);
                });
            }
            super::super::annotation::present(&app2)
        })
        .await
    }
    const RESIZE_ID: usize = 0x46425253;
    fn hold_resize(parent: &tauri::WebviewWindow) -> Result<(), String> {
        let hwnd = parent.hwnd().map_err(|e| e.to_string())?.0 as isize;
        parent
            .with_webview(move |platform| unsafe {
                let hwnd = HWND(hwnd as _);
                if GetWindowSubclass(hwnd, Some(resize), RESIZE_ID, None).as_bool() {
                    return;
                }
                let controller = Box::into_raw(Box::new(platform.controller()));
                if !SetWindowSubclass(hwnd, Some(resize), RESIZE_ID, controller as usize).as_bool()
                {
                    drop(Box::from_raw(controller));
                }
            })
            .map_err(|e| e.to_string())
    }
    unsafe extern "system" fn resize(
        hwnd: HWND,
        msg: u32,
        w: WPARAM,
        l: LPARAM,
        _id: usize,
        data: usize,
    ) -> LRESULT {
        let controller = data as *mut ICoreWebView2Controller;
        match msg {
            WM_SIZE if w.0 != SIZE_MINIMIZED as usize => {
                let mut rect = RECT::default();
                if GetClientRect(hwnd, &mut rect).is_ok() {
                    let _ = (*controller).SetBounds(rect);
                    let mut host = HWND::default();
                    if (*controller).ParentWindow(&mut host).is_ok() {
                        let _ = SetWindowPos(
                            host,
                            None,
                            0,
                            0,
                            rect.right,
                            rect.bottom,
                            SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOZORDER,
                        );
                    }
                }
            }
            WM_MOVE | WM_MOVING => {
                let _ = (*controller).NotifyParentWindowPositionChanged();
            }
            WM_NCDESTROY => {
                let _ = RemoveWindowSubclass(hwnd, Some(resize), RESIZE_ID);
                drop(Box::from_raw(controller));
            }
            _ => (),
        }
        DefSubclassProc(hwnd, msg, w, l)
    }
}
#[cfg(windows)]
pub use native::*;

#[cfg(not(windows))]
pub async fn create(_app: &AppHandle, _tab: &Tab) -> Result<(), String> {
    Err("UNSUPPORTED: native browser currently requires Windows WebView2".into())
}
#[cfg(not(windows))]
pub async fn cdp(
    _app: &AppHandle,
    _id: &str,
    _method: &str,
    _params: Value,
    _ticket: Option<Ticket>,
    _document: bool,
) -> Result<Value, String> {
    Err("UNSUPPORTED: WebView2 required".into())
}
#[cfg(not(windows))]
pub async fn show(_app: &AppHandle, _id: Option<String>, _bounds: Bounds) -> Result<(), String> {
    Ok(())
}
#[cfg(not(windows))]
pub async fn reframe(_app: &AppHandle, _id: &str, _bounds: Bounds) -> Result<(), String> {
    Err("UNSUPPORTED: WebView2 required".into())
}
#[cfg(not(windows))]
pub async fn close(_app: &AppHandle, _id: String) -> Result<(), String> {
    Ok(())
}
#[cfg(not(windows))]
pub async fn control(_app: &AppHandle, _id: String, _zoom: Option<f64>) -> Result<(), String> {
    Err("UNSUPPORTED: WebView2 required".into())
}
#[cfg(not(windows))]
pub async fn viewport_cursor(_app: &AppHandle, _id: &str, _zoom: f64, _preview_scale: f64) -> Result<Option<(f64, f64)>, String> {
    Ok(None)
}
