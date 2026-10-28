//! 可信本地注释视图与网页完全分离；网页没有此视图的 IPC，也不能读取用户评论。
use super::{panel_tab, picker, surface};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    request_id: u64,
    tab_id: String,
    selection_id: u64,
    action: String,
    #[serde(default)]
    patch: Value,
    #[serde(default)]
    problem: String,
    #[serde(default)]
    expanded: bool,
    #[serde(default)]
    delta_x: f64,
    #[serde(default)]
    delta_y: f64,
}

fn receive(app: AppHandle, raw: &str) {
    if raw.len() > 16 * 1024 { return; }
    let Ok(request) = serde_json::from_str::<Request>(raw) else { return; };
    tauri::async_runtime::spawn(async move {
        let result = handle(&app, &request).await;
        let reply = match result { Ok(value) => json!({"requestId":request.request_id,"value":value}), Err(error) => json!({"requestId":request.request_id,"error":error}) };
        let _ = native_reply(&app, reply).await;
    });
}

async fn handle(app: &AppHandle, request: &Request) -> Result<Value, String> {
    // 所有事件都重新校验页面和选取身份；旧面板回包不能修改新页面。
    let tab = panel_tab(app, &request.tab_id)?;
    if tab.picker.active || tab.picker.pending || tab.picker.selection.as_ref().and_then(|s|s["selectionId"].as_u64()) != Some(request.selection_id) { return Err("元素标记已变化，请重新选取".into()); }
    match request.action.as_str() {
        "preview" => picker::edit(app, &request.tab_id, request.selection_id, "preview", request.patch.clone()).await,
        "reset" => picker::edit(app, &request.tab_id, request.selection_id, "reset", json!({})).await,
        // 收起评论不等于取消选取；选中框和草稿一直保留到交付成功或有效重选。
        "close" | "open" => { minimize(app,format!("{}:{}",request.tab_id,request.selection_id),request.action=="close").await?;Ok(Value::Null) }
        // 叉号明确取消当前标记，并直接进入下一轮选取，不要求用户再点工具栏箭头。
        "repick" => {
            picker::clear(app, &request.tab_id, request.selection_id).await?;
            picker::set_enabled(app, &request.tab_id, true).await
        }
        "expand" => { expand(app, format!("{}:{}",request.tab_id,request.selection_id), request.expanded).await?; Ok(Value::Null) }
        "move" => {
            if [request.delta_x,request.delta_y].iter().any(|n|!n.is_finite() || n.abs()>20000.0) {return Err("无效的面板位置".into());}
            move_panel(app,format!("{}:{}",request.tab_id,request.selection_id),request.delta_x,request.delta_y).await?;Ok(Value::Null)
        }
        "submit" => {
            // 评论可选；元素身份已在入口验证，仍限制评论长度。
            if request.problem.chars().count() > 2000 { return Err("评论最多 2000 字".into()); }
            app.emit_to("main", "forge-browser-annotation-submit", json!({"workspace":tab.workspace,"selection":tab.picker.selection,"problem":request.problem})).map_err(|e|e.to_string())?;
            Ok(Value::Null)
        }
        _ => Err("不支持的注释操作".into()),
    }
}

pub async fn feedback(app: &AppHandle, tab_id: &str, selection_id: u64, error: Option<String>) -> Result<(), String> {
    native_reply(app, json!({"feedback":true,"tabId":tab_id,"selectionId":selection_id,"error":error})).await
}

#[cfg(windows)]
mod native {
    use super::*;
    use crate::browser::Bounds;
    use std::cell::RefCell;
    use tauri::Manager;
    use tauri_runtime_wry::wry::{self, dpi, Rect, WebContext, WebViewBuilder, WebViewExtWindows};
    use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::{SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE}};

    struct Panel { view: wry::WebView, expanded: bool, minimized: bool, key: String, position: Option<(f64,f64)>, last_position: (f64,f64) }
    thread_local! {
        static PANEL: RefCell<Option<Panel>> = const { RefCell::new(None) };
        static CONTEXT: RefCell<Option<WebContext>> = const { RefCell::new(None) };
    }
    fn rect(bounds: Bounds) -> Rect {
        Rect { position:dpi::LogicalPosition::new(bounds.x,bounds.y).into(), size:dpi::LogicalSize::new(bounds.width,bounds.height).into() }
    }

    /// 在主线程调用，直接跟随原生网页的呈现状态，宿主弹层打开时同步隐藏。
    pub(crate) fn present(app: &AppHandle) -> Result<(), String> {
        let shown = surface::presented();
        let tab = shown.as_deref().and_then(|id|panel_tab(app,id).ok()).filter(|t|!t.picker.active && !t.picker.pending && t.picker.selection.is_some());
        PANEL.with(|slot| {
            let mut slot = slot.borrow_mut();
            let Some(tab) = tab else {
                if let Some(panel) = slot.as_ref() { panel.view.set_visible(false).map_err(|e|e.to_string())?; }
                return Ok(());
            };
            let selection = tab.picker.selection.as_ref().unwrap();
            let key = format!("{}:{}",tab.id,selection["selectionId"]);
            if slot.is_none() {
                let parent = app.get_webview_window("main").ok_or("main window missing")?;
                let ipc_app = app.clone();
                let load_app = app.clone();
                // 唯一内容来自编译进程序的 HTML，拒绝导航、外链、新窗口和下载。
                let profile=app.path().app_local_data_dir().map_err(|e|e.to_string())?.join("browser-annotation");
                std::fs::create_dir_all(&profile).map_err(|e|e.to_string())?;
                // NavigateToString 的 NavigationStarting 使用合成 data URI，Source 仍为 about:blank。
                // 必须匹配编译内置内容，不能为修复首次加载而允许任意 data 页面访问 IPC。
                let allowed_html=format!("data:text/html;charset=utf-8;base64,{}",base64::Engine::encode(&base64::engine::general_purpose::STANDARD,include_str!("annotation.html")));
                let view = CONTEXT.with(|context| {
                    let mut context=context.borrow_mut();
                    let context=context.get_or_insert_with(||WebContext::new(Some(profile)));
                    WebViewBuilder::new_with_web_context(context)
                    .with_incognito(true)
                    .with_focused(false)
                    .with_bounds(rect(Bounds{x:-10000.0,y:-10000.0,width:360.0,height:100.0}))
                    .with_html(include_str!("annotation.html"))
                    .with_on_page_load_handler(move |event,_| {
                        if matches!(event,wry::PageLoadEvent::Finished) {
                            let app = load_app.clone();
                            tauri::async_runtime::spawn(async move {let _=refresh(&app).await;});
                        }
                    })
                    .with_navigation_handler(move |url|url == allowed_html)
                    .with_new_window_req_handler(|_,_|wry::NewWindowResponse::Deny)
                    .with_download_started_handler(|_,_|false)
                    .with_ipc_handler(move |request|receive(ipc_app.clone(),request.body()))
                    .build_as_child(&parent).map_err(|e|e.to_string())
                })?;
                *slot = Some(Panel{view,expanded:false,minimized:false,key:String::new(),position:None,last_position:(0.0,0.0)});
            }
            let panel = slot.as_mut().unwrap();
            let fresh = panel.key != key;
            if fresh { panel.expanded = false; panel.minimized=false; panel.key = key; panel.position=None; }
            let available = tab.preview_bounds;
            let width = (if panel.minimized {132.0_f64}else{360.0_f64}).min((available.width-16.0).max(1.0));
            let mut height = (if panel.minimized {32.0_f64}else if panel.expanded { 520.0_f64 } else { 110.0_f64 }).min((available.height-16.0).max(1.0));
            let b = &selection["bounds"];
            let scale = tab.preview_scale * tab.zoom;
            let page = tab.emulation.bounds(&available);
            let anchor_x = page.x + b["x"].as_f64().unwrap_or(0.0)*scale;
            let below = page.y + (b["y"].as_f64().unwrap_or(0.0)+b["height"].as_f64().unwrap_or(0.0))*scale + 10.0;
            let above=page.y+b["y"].as_f64().unwrap_or(0.0)*scale-10.0;
            let below_room=(available.y+available.height-8.0-below).max(0.0);
            let above_room=(above-available.y-8.0).max(0.0);
            let use_below=below_room>=height || below_room>=above_room;
            // 自动展开时在元素上下较宽的一侧滚动表单，不能把面板钳回元素上方盖住选中框。
            if panel.position.is_none() {
                let room=if use_below {below_room}else{above_room};
                height=height.min(room.max(if panel.minimized {32.0}else{110.0}));
            }
            let y=if use_below {below}else{above-height};
            let (x,y)=panel.position.unwrap_or((anchor_x,y));
            let x=x.clamp(available.x+8.0,(available.x+available.width-width-8.0).max(available.x+8.0));
            let y=y.clamp(available.y+8.0,(available.y+available.height-height-8.0).max(available.y+8.0));
            panel.last_position=(x,y);
            panel.view.set_bounds(rect(Bounds{x,y,width,height})).map_err(|e|e.to_string())?;
            let settings = crate::settings::read(app);
            let payload = json!({"selection":selection,"expanded":panel.expanded,"minimized":panel.minimized,"language":settings.language,"theme":settings.theme});
            panel.view.evaluate_script(&format!("window.renderAnnotation({payload})")).map_err(|e|e.to_string())?;
            panel.view.set_visible(true).map_err(|e|e.to_string())?;
            if fresh { panel.view.focus().map_err(|e|e.to_string())?; }
            // 原生兄弟窗口不能靠 CSS z-index；显式提升注释窗口，但不抢网页焦点。
            unsafe {
                let mut hwnd = HWND::default();
                panel.view.controller().ParentWindow(&mut hwnd).map_err(|e|e.to_string())?;
                SetWindowPos(hwnd,Some(HWND_TOP),0,0,0,0,SWP_NOACTIVATE|SWP_NOMOVE|SWP_NOSIZE).map_err(|e|e.to_string())?;
            }
            Ok(())
        })
    }
    pub async fn refresh(app: &AppHandle) -> Result<(), String> {
        let handle = app.clone();
        surface::ui(app,move ||present(&handle)).await
    }
    pub async fn expand(app: &AppHandle, key: String, expanded: bool) -> Result<(), String> {
        let handle = app.clone();
        surface::ui(app,move || {
            PANEL.with(|slot| {
                let mut slot=slot.borrow_mut();let panel=slot.as_mut().filter(|p|p.key==key).ok_or("元素标记已变化")?;
                panel.expanded=expanded;Ok::<_,String>(())
            })?;
            present(&handle)
        }).await
    }
    pub async fn minimize(app: &AppHandle, key: String, minimized: bool) -> Result<(), String> {
        let handle=app.clone();
        surface::ui(app,move || {
            PANEL.with(|slot| {
                let mut slot=slot.borrow_mut();let panel=slot.as_mut().filter(|p|p.key==key).ok_or("元素标记已变化")?;
                panel.minimized=minimized;Ok::<_,String>(())
            })?;
            present(&handle)
        }).await
    }
    pub async fn move_panel(app: &AppHandle, key: String, dx: f64, dy: f64) -> Result<(), String> {
        let handle=app.clone();
        surface::ui(app,move || {
            PANEL.with(|slot| {
                let mut slot=slot.borrow_mut();let panel=slot.as_mut().filter(|p|p.key==key).ok_or("元素标记已变化")?;
                panel.position=Some((panel.last_position.0+dx,panel.last_position.1+dy));Ok::<_,String>(())
            })?;
            present(&handle)
        }).await
    }
    pub async fn native_reply(app: &AppHandle, value: Value) -> Result<(), String> {
        surface::ui(app,move || PANEL.with(|slot| {
            if let Some(panel) = slot.borrow().as_ref() { panel.view.evaluate_script(&format!("window.annotationReply({value})")).map_err(|e|e.to_string())?; }
            Ok(())
        })).await
    }
    #[cfg(feature = "browser-smoke")]
    pub async fn capture(app: &AppHandle) -> Result<Vec<u8>, String> {
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows::core::HSTRING;
        let (tx,rx)=tokio::sync::oneshot::channel();
        surface::ui(app,move ||PANEL.with(|slot| {
            let slot=slot.borrow();
            let view=slot.as_ref().ok_or("annotation panel missing")?.view.webview();
            let callback=CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status,raw| {
                let result=status.map_err(|e|e.to_string()).and_then(|_|serde_json::from_str::<Value>(&raw).map_err(|e|e.to_string()));
                let _=tx.send(result);Ok(())
            }));
            unsafe { view.CallDevToolsProtocolMethod(&HSTRING::from("Page.captureScreenshot"),&HSTRING::from("{\"format\":\"png\"}"),&callback).map_err(|e|e.to_string()) }
        })).await?;
        let image=tokio::time::timeout(std::time::Duration::from_secs(5),rx).await.map_err(|_|"annotation capture timeout")?.map_err(|_|"annotation capture lost")??;
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD,image["data"].as_str().ok_or("annotation PNG missing")?).map_err(|e|e.to_string())
    }
    // 固定的原生指针回归入口，避免 DOM click 掩盖按钮不可点击的问题。
    #[cfg(feature = "browser-smoke")]
    pub async fn pointer_click(app: &AppHandle, x: f64, y: f64) -> Result<(), String> {
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows::core::HSTRING;
        for kind in ["mouseMoved", "mousePressed", "mouseReleased"] {
            let (tx,rx)=tokio::sync::oneshot::channel();
            surface::ui(app,move ||PANEL.with(|slot| {
                let slot=slot.borrow();
                let view=slot.as_ref().ok_or("annotation panel missing")?.view.webview();
                let mut params=json!({"type":kind,"x":x,"y":y});
                if kind!="mouseMoved" {params["button"]=json!("left");params["clickCount"]=json!(1);}
                let callback=CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status,_| {
                    let _=tx.send(status.map_err(|e|e.to_string()));Ok(())
                }));
                unsafe {view.CallDevToolsProtocolMethod(&HSTRING::from("Input.dispatchMouseEvent"),&HSTRING::from(params.to_string()),&callback).map_err(|e|e.to_string())}
            })).await?;
            tokio::time::timeout(std::time::Duration::from_secs(5),rx).await.map_err(|_|"annotation click timeout")?.map_err(|_|"annotation click lost")??;
        }
        Ok(())
    }
    #[cfg(feature = "browser-smoke")]
    pub async fn geometry(app: &AppHandle) -> Result<Value,String> {
        let handle=app.clone();
        surface::ui(app,move ||PANEL.with(|slot| {
            let slot=slot.borrow();let panel=slot.as_ref().ok_or("annotation panel missing")?;
            let mut visible=Default::default();
            unsafe {panel.view.controller().IsVisible(&mut visible).map_err(|e|e.to_string())?;}
            let bounds=panel.view.bounds().map_err(|e|e.to_string())?;
            let scale=handle.get_webview_window("main").ok_or("main window missing")?.scale_factor().map_err(|e|e.to_string())?;
            let position=bounds.position.to_logical::<f64>(scale);let size=bounds.size.to_logical::<f64>(scale);
            Ok(json!({"visible":visible.as_bool(),"x":position.x,"y":position.y,"width":size.width,"height":size.height}))
        })).await
    }
    // 仅隔离的原生回归可以操作本地面板，生产 MCP 无此入口。
    #[cfg(feature = "browser-smoke")]
    pub async fn probe(app: &AppHandle, script: String) -> Result<Value, String> {
        let (tx,rx) = tokio::sync::oneshot::channel();
        let tx = std::sync::Mutex::new(Some(tx));
        surface::ui(app,move || PANEL.with(|slot| {
            let slot = slot.borrow();
            let panel = slot.as_ref().ok_or("annotation panel missing")?;
            panel.view.evaluate_script_with_callback(&script,move |raw| {
                if let Some(tx) = tx.lock().unwrap().take() {let _=tx.send(serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null));}
            }).map_err(|e|e.to_string())
        })).await?;
        tokio::time::timeout(std::time::Duration::from_secs(5),rx).await.map_err(|_|"annotation probe timeout")?.map_err(|_|"annotation probe lost".into())
    }
}
#[cfg(windows)]
pub use native::*;
#[cfg(windows)]
pub(super) use native::present;
#[cfg(not(windows))]
pub async fn refresh(_: &AppHandle) -> Result<(), String> { Ok(()) }
#[cfg(not(windows))]
async fn expand(_: &AppHandle, _: String, _: bool) -> Result<(), String> { Err("UNSUPPORTED".into()) }
#[cfg(not(windows))]
async fn minimize(_: &AppHandle, _: String, _: bool) -> Result<(), String> { Err("UNSUPPORTED".into()) }
#[cfg(not(windows))]
async fn move_panel(_: &AppHandle, _: String, _: f64, _: f64) -> Result<(), String> { Err("UNSUPPORTED".into()) }
#[cfg(not(windows))]
async fn native_reply(_: &AppHandle, _: Value) -> Result<(), String> { Ok(()) }
