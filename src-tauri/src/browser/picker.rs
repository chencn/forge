//! 引擎 Overlay 负责捕获元素，隔离世界负责持久标记；不给网页 IPC 或 AI 任意脚本权限。
use super::{annotation, changed, host, panel_tab, surface};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use std::sync::Arc;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Picker {
    pub active: bool,
    pub pending: bool,
    pub selection: Option<Value>,
    pub error: Option<String>,
    #[serde(skip)]
    generation: u64,
    #[serde(skip)]
    backend: Option<i64>,
    #[serde(skip)]
    queue: Arc<tokio::sync::Mutex<()>>,
}
impl Picker {
    pub fn invalidate(&mut self) {
        self.generation += 1;
        self.active = false;
        self.pending = false;
        self.selection = None;
        self.backend = None;
        self.error = None;
    }
    pub fn in_use(&self) -> bool {
        self.active || self.pending || self.selection.is_some()
    }
}

fn highlight() -> Value {
    json!({"showInfo":true,"contentColor":{"r":79,"g":120,"b":255,"a":0.12},"borderColor":{"r":79,"g":120,"b":255,"a":0.95}})
}
fn inspect_mode(enabled: bool) -> Value {
    // WebView2 即使 mode=none 也要求 highlightConfig；漏掉它会静默留在鼠标悬停选取模式。
    json!({"mode":if enabled {"searchForNode"} else {"none"},"highlightConfig":highlight()})
}

pub async fn set_enabled(app: &AppHandle, id: &str, enabled: bool) -> Result<Value, String> {
    let tab = panel_tab(app, id)?;
    if enabled && (tab.loading || tab.frame.is_empty()) {
        return Err("页面正在加载，请稍后选取元素".into());
    }
    let generation = {
        let mut state = host(app).lock();
        let tab = state.tabs.get_mut(id).ok_or("page closed")?;
        // 进入重选或取消只结束捕获，旧标记直到新元素选定或明确交付后才清理。
        tab.picker.generation += 1;
        tab.picker.pending = false;
        tab.picker.error = None;
        tab.picker.active = enabled;
        tab.picker.generation
    };
    let _queue = tab.picker.queue.lock().await;
    if !current(app, id, generation) { return Ok(Value::Null); }
    let result = async {
        surface::cdp(app, id, "DOM.enable", json!({}), None, false).await?;
        surface::cdp(app, id, "Overlay.enable", json!({}), None, false).await?;
        surface::cdp(app, id, "Overlay.setInspectMode", inspect_mode(enabled), None, false).await.map_err(|e|format!("{}: {e}", if enabled {"开启元素选取"} else {"取消元素选取"}))?;
        if !enabled { paint(app, id).await?; } else { annotation::refresh(app).await?; }
        Ok::<_, String>(Value::Null)
    }.await;
    if !current(app, id, generation) { return Ok(Value::Null); }
    if let Err(error) = &result {
        if let Some(tab) = host(app).lock().tabs.get_mut(id) {
            if tab.picker.generation == generation {
                tab.picker.active = false;
                tab.picker.error = Some(error.clone());
            }
        }
    }
    if result.is_ok() && enabled && current(app, id, generation) {
        follow_hover(app, id, generation);
    }
    changed(app);
    result
}

fn current(app: &AppHandle, id: &str, generation: u64) -> bool {
    host(app).lock().tabs.get(id).is_some_and(|tab| tab.picker.generation == generation)
}

/// 引擎的临时 Overlay 不能保证离开捕获模式后仍可见；持久标记绑定实际节点。
async fn paint(app: &AppHandle, id: &str) -> Result<(), String> {
    let picker = panel_tab(app, id)?.picker;
    if picker.active || picker.pending { return annotation::refresh(app).await; }
    surface::cdp(app, id, "Overlay.hideHighlight", json!({}), None, false).await?;
    // 选定后的蓝框由持久标记负责；悬停框只在选取过程中存在。
    let _ = hover_script(app, id, "globalThis.__forgeHoverMark?.dispose()").await;
    marker(app,id,picker.backend,if picker.backend.is_some(){"show"}else{"clear"}).await?;
    annotation::refresh(app).await
}

async fn marker(app: &AppHandle, id: &str, backend: Option<i64>, action: &str) -> Result<(), String> {
    let tab=panel_tab(app,id)?;
    if tab.frame.is_empty(){return Ok(());}
    let world=surface::cdp(app,id,"Page.createIsolatedWorld",json!({"frameId":tab.frame,"worldName":"forge-user-picker","grantUniveralAccess":false}),None,false).await?;
    let result=if let Some(backend)=backend.filter(|_|action=="show") {
        let node=surface::cdp(app,id,"DOM.resolveNode",json!({"backendNodeId":backend,"executionContextId":world["executionContextId"],"objectGroup":"forge-user-marker"}),None,false).await?;
        let result=surface::cdp(app,id,"Runtime.callFunctionOn",json!({"objectId":node["object"]["objectId"],"functionDeclaration":SELECTION_MARK,"returnByValue":true}),None,false).await;
        let _=surface::cdp(app,id,"Runtime.releaseObjectGroup",json!({"objectGroup":"forge-user-marker"}),None,false).await;
        result?
    }else{
        let expression=if action=="hide" {"globalThis.__forgeSelectionMark?.hide()"}else{"globalThis.__forgeSelectionMark?.dispose()"};
        surface::cdp(app,id,"Runtime.evaluate",json!({"contextId":world["executionContextId"],"expression":expression,"returnByValue":true}),None,false).await?
    };
    if result.get("exceptionDetails").is_some(){return Err("无法呈现所选元素标记，请重新选取".into());}
    Ok(())
}

// 固定函数只画一个不可交互的框，不改元素样式。闭合 Shadow DOM 隔离页面 CSS，
// top layer 避免页面的 transform / z-index 遮住标记；无 IPC、事件输入或任意脚本参数。
const SELECTION_MARK: &str = r#"function(slot) {
  const hover=slot==="hover";
  const key=hover?"__forgeHoverMark":"__forgeSelectionMark";
  const previous=globalThis[key];
  if(previous?.node===this && previous.host.isConnected){previous.show();return;}
  if(!(this instanceof Element)||!this.isConnected||this.hasAttribute("data-forge-mark"))throw new Error('detached');
  previous?.dispose();
  const host=document.createElement('div'), box=document.createElement('div');
  host.setAttribute('aria-hidden','true');host.inert=true;host.setAttribute('popover','manual');host.setAttribute('data-forge-mark',key);
  for(const [name,value] of Object.entries({all:'initial',position:'fixed',inset:'0',width:'100%',height:'100%',margin:'0',padding:'0',border:'0',background:'transparent',overflow:'visible','pointer-events':'none','z-index':'2147483647'}))host.style.setProperty(name,value,'important');
  for(const [name,value] of Object.entries({all:'initial',position:'fixed','box-sizing':'border-box',outline:'2px solid #4f78ff','outline-offset':hover?'2px':'0',background:'rgba(79,120,255,.12)','pointer-events':'none'}))box.style.setProperty(name,value,'important');
  host.attachShadow({mode:'closed'}).append(box);document.documentElement.append(host);
  try{host.showPopover();}catch{}
  const node=this;let frame=0,visible=true,disposed=false;
  // 截图隐藏只修改闭合 shadow 内部，不能使页面的 DOM 引用因标记自身变化而失效。
  const state={node,host,show(){visible=true;box.style.setProperty('visibility','visible','important');},hide(){visible=false;box.style.setProperty('visibility','hidden','important');},dispose(){disposed=true;cancelAnimationFrame(frame);host.remove();if(globalThis[key]===state)delete globalThis[key];}};
  const update=()=>{
    if(disposed)return;
    if(!node.isConnected){state.dispose();return;}
    if(visible){const r=node.getBoundingClientRect();for(const [name,value] of Object.entries({left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px',display:r.width&&r.height?'block':'none'}))box.style.setProperty(name,value,'important');}
    frame=requestAnimationFrame(update);
  };
  globalThis[key]=state;update();
}"#;

async fn hover_script(app: &AppHandle, id: &str, expression: &str) -> Result<(), String> {
    let tab = panel_tab(app, id)?;
    if tab.frame.is_empty() { return Ok(()); }
    let world = surface::cdp(app, id, "Page.createIsolatedWorld", json!({"frameId":tab.frame,"worldName":"forge-user-picker","grantUniveralAccess":false}), None, false).await?;
    let result = surface::cdp(app, id, "Runtime.evaluate", json!({"contextId":world["executionContextId"],"expression":expression,"returnByValue":true}), None, false).await?;
    if result.get("exceptionDetails").is_some() { return Err("无法更新选取悬停框".into()); }
    Ok(())
}

async fn show_hover(app: &AppHandle, id: &str, backend: i64) -> Result<(), String> {
    let tab = panel_tab(app, id)?;
    if tab.frame.is_empty() || !tab.picker.active { return Ok(()); }
    let world = surface::cdp(app, id, "Page.createIsolatedWorld", json!({"frameId":tab.frame,"worldName":"forge-user-picker","grantUniveralAccess":false}), None, false).await?;
    let context = world["executionContextId"].as_i64().ok_or("选取上下文不可用")?;
    let node = surface::cdp(app, id, "DOM.resolveNode", json!({"backendNodeId":backend,"executionContextId":context,"objectGroup":"forge-user-hover"}), None, false).await?;
    let Some(object) = node["object"]["objectId"].as_str() else { return Ok(()) };
    let result = surface::cdp(app, id, "Runtime.callFunctionOn", json!({"objectId":object,"functionDeclaration":SELECTION_MARK,"arguments":[{"value":"hover"}],"returnByValue":true}), None, false).await;
    let _ = surface::cdp(app, id, "Runtime.releaseObjectGroup", json!({"objectGroup":"forge-user-hover"}), None, false).await;
    if result?.get("exceptionDetails").is_some() { return Err("无法呈现悬停框".into()); }
    Ok(())
}

/// 截图只隐藏标记，不结束选取；成功或失败都在返回前恢复。
pub async fn capture(app: &AppHandle,id: &str,params: Value,ticket: Option<super::Ticket>,document: bool) -> Result<Value,String> {
    let tab=panel_tab(app,id)?;
    let _queue=tab.picker.queue.lock().await;
    capture_locked(app,id,params,ticket,document).await
}
async fn capture_locked(app: &AppHandle,id: &str,params: Value,ticket: Option<super::Ticket>,document: bool) -> Result<Value,String> {
    // 没有选取时不创建隔离世界或操作未启用的 Overlay，保持普通截图原有路径。
    if !panel_tab(app,id)?.picker.in_use(){return surface::cdp(app,id,"Page.captureScreenshot",params,ticket,document).await;}
    surface::cdp(app,id,"Overlay.hideHighlight",json!({}),None,false).await?;
    marker(app,id,None,"hide").await?;
    let _ = hover_script(app,id,"globalThis.__forgeHoverMark?.hide()").await;
    let image=surface::cdp(app,id,"Page.captureScreenshot",params,ticket,document).await;
    // 重选尚未完成时仍保留旧标记；paint 此时只更新评论面板，不能负责恢复截图隐藏。
    let restored=async {
        let picker=panel_tab(app,id)?.picker;
        if let Some(backend)=picker.backend {marker(app,id,Some(backend),"show").await?;}
        if picker.active { let _ = hover_script(app,id,"globalThis.__forgeHoverMark?.show()").await; }
        paint(app,id).await
    }.await;
    let image=image?;
    restored?;
    Ok(image)
}

pub async fn restore_highlight(app: &AppHandle, id: &str) -> Result<(), String> {
    let tab = panel_tab(app, id)?;
    if tab.picker.backend.is_none() { return Ok(()); }
    let _queue = tab.picker.queue.lock().await;
    paint(app, id).await
}

/// 带选取身份清理，旧发送回包不能误删用户刚刚重选的新标记。
pub async fn clear(app: &AppHandle, id: &str, selection_id: u64) -> Result<Value, String> {
    end(app, id, selection_id, false).await
}

pub async fn finish(app: &AppHandle, id: &str, selection_id: u64) -> Result<Value, String> {
    end(app, id, selection_id, true).await
}

async fn end(app: &AppHandle, id: &str, selection_id: u64, sent: bool) -> Result<Value, String> {
    let tab = panel_tab(app, id)?;
    let _queue = tab.picker.queue.lock().await;
    let tab = panel_tab(app, id)?;
    if tab.picker.selection.as_ref().and_then(|s|s["selectionId"].as_u64()) != Some(selection_id) { return Ok(Value::Null); }
    // 发送后保留预览结果；取消只恢复已编辑属性。节点已删除时仍允许清掉失效标记。
    if tab.picker.selection.as_ref().is_some_and(|s|s["styleChanges"].is_object()) {
        if let Some(backend) = tab.picker.backend {
            let _ = call_style(app, id, &tab, backend, if sent {"commit"} else {"reset"}, json!({})).await;
        }
    }
    let generation = {
        let mut state = host(app).lock();
        let tab = state.tabs.get_mut(id).ok_or("page closed")?;
        if tab.picker.selection.as_ref().and_then(|s|s["selectionId"].as_u64()) != Some(selection_id) { return Ok(Value::Null); }
        tab.picker.invalidate();
        tab.picker.generation
    };
    if current(app, id, generation) {
        surface::cdp(app, id, "Overlay.setInspectMode", inspect_mode(false), None, false).await?;
        paint(app, id).await?;
    }
    changed(app);
    Ok(Value::Null)
}

/// 导航或关掉总开关时清理 Overlay；旧导航的清理不能取消后来新建的选取。
pub fn reset_overlay(app: &AppHandle, id: &str) {
    let Some(tab) = host(app).lock().tabs.get(id).cloned() else { return; };
    let generation = tab.picker.generation;
    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        let _queue = tab.picker.queue.lock().await;
        if current(&app, &id, generation) {
            let _ = surface::cdp(&app, &id, "Overlay.setInspectMode", inspect_mode(false), None, false).await;
            let _ = surface::cdp(&app, &id, "Overlay.hideHighlight", json!({}), None, false).await;
            let _ = marker(&app,&id,None,"clear").await;
            let _ = hover_script(&app,&id,"globalThis.__forgeHoverMark?.dispose()").await;
            let _ = annotation::refresh(&app).await;
        }
    });
}

/// 选取过程中跟随鼠标画出和选定后相同的蓝框。WebView2 不把悬停节点事件交给宿主，
/// 引擎高亮又只填充内容区，所以按光标采样节点；不结束捕获，也不改已提交的标记。
fn follow_hover(app: &AppHandle, id: &str, generation: u64) {
    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        let mut seen = None;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(32)).await;
            let (queue, zoom, preview_scale) = {
                let state = host(&app).lock();
                let Some(tab) = state.tabs.get(&id).filter(|tab| tab.picker.active && !tab.picker.pending && tab.picker.generation == generation) else { break };
                (tab.picker.queue.clone(), tab.zoom, tab.preview_scale)
            };
            let _queue = queue.lock().await;
            let still = host(&app).lock().tabs.get(&id).is_some_and(|tab| tab.picker.active && !tab.picker.pending && tab.picker.generation == generation);
            if !still { break; }
            let backend = match surface::viewport_cursor(&app, &id, zoom, preview_scale).await {
                Ok(Some((x, y))) => {
                    let (x, y) = (x.round(), y.round());
                    if x.is_finite() && y.is_finite() && x >= 0.0 && y >= 0.0 {
                        surface::cdp(&app, &id, "DOM.getNodeForLocation", json!({"x": x as i64, "y": y as i64}), None, false).await.ok().and_then(|node| node["backendNodeId"].as_i64().filter(|node| *node > 0))
                    } else { None }
                }
                Ok(None) => None,
                Err(_) => continue,
            };
            if backend == seen { continue; }
            if let Some(node) = backend {
                if show_hover(&app, &id, node).await.is_err() { continue; }
            } else {
                let _ = hover_script(&app, &id, "globalThis.__forgeHoverMark?.dispose()").await;
            }
            seen = backend;
        }
        if host(&app).lock().tabs.get(&id).is_some_and(|tab| tab.picker.generation == generation) {
            let _ = hover_script(&app, &id, "globalThis.__forgeHoverMark?.dispose()").await;
        }
    });
}

pub fn event(app: &AppHandle, id: &str, name: &str, value: Value) {
    let mut state = host(app).lock();
    let Some(tab) = state.tabs.get_mut(id) else { return; };
    if !tab.picker.active { return; }
    tab.picker.active = false;
    let generation = tab.picker.generation;
    let epoch = tab.epoch;
    let queue = tab.picker.queue.clone();
    if name == "Overlay.inspectModeCanceled" {
        // 在事件入队时推进代际，过期 Esc 回调不能取消后来开始的新一轮选取。
        tab.picker.generation += 1;
        tab.picker.pending = false;
        let canceled = tab.picker.generation;
        drop(state);
        let app = app.clone();
        let id = id.to_string();
        tauri::async_runtime::spawn(async move {
            let _queue = queue.lock().await;
            if current(&app, &id, canceled) {
                let _ = surface::cdp(&app, &id, "Overlay.setInspectMode", inspect_mode(false), None, false).await;
                let _ = paint(&app, &id).await;
                changed(&app);
            }
        });
        return;
    }
    let Some(backend) = value["backendNodeId"].as_i64() else { return; };
    tab.picker.pending = true;
    drop(state);
    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        let _queue = queue.lock().await;
        if !current(&app, &id, generation) { return; }
        let result = async {
            // 先验证新节点；误选 iframe 等不支持的元素不能撤销旧标记的预览。
            let mut selection=collect(&app,&id,backend,epoch).await?;
            if !current(&app,&id,generation) {return Err("选取已取消".into());}
            if let Ok(tab) = panel_tab(&app, &id) {
                if tab.picker.selection.as_ref().is_some_and(|s|s["styleChanges"].is_object()) {
                    if let Some(previous) = tab.picker.backend {
                        call_style(&app, &id, &tab, previous, "reset", json!({})).await?;
                        selection=collect(&app,&id,backend,epoch).await?;
                    }
                }
            }
            selection["selectionId"] = json!(generation);
            Ok::<_,String>(selection)
        }.await;
        // 取消、重选和导航后，旧异步结果不准重新出现。
        let accepted = {
            let mut state = host(&app).lock();
            if let Some(tab) = state.tabs.get_mut(&id).filter(|t| t.epoch == epoch && t.picker.generation == generation) {
                tab.picker.pending = false;
                match &result {
                    Ok(selection) => { tab.picker.selection = Some(selection.clone()); tab.picker.backend = Some(backend); }
                    Err(error) => tab.picker.error = Some(error.clone()),
                }
                true
            } else { false }
        };
        if accepted && current(&app, &id, generation) {
            let result = async {
                surface::cdp(&app, &id, "Overlay.setInspectMode", inspect_mode(false), None, false).await?;
                paint(&app, &id).await
            }.await;
            if let Err(error) = result {
                if let Some(tab) = host(&app).lock().tabs.get_mut(&id).filter(|t|t.picker.generation == generation) {
                    tab.picker.error = Some(error);
                }
            }
            changed(&app);
        }
    });
}

/// 只截取当前标记的可见区域；截图失败或取消时保留标记，不降级成整页截图。
pub async fn screenshot(app: &AppHandle, id: &str, selection_id: u64) -> Result<Value, String> {
    let tab = panel_tab(app, id)?;
    let _queue = tab.picker.queue.lock().await;
    let selected = panel_tab(app, id)?;
    let valid = |picker: &Picker| !picker.active && !picker.pending && picker.selection.as_ref().and_then(|s|s["selectionId"].as_u64()) == Some(selection_id);
    if !valid(&selected.picker) { return Err("元素标记已变化，请重新发送".into()); }
    let backend = selected.picker.backend.ok_or("元素标记已失效，请重新选取")?;
    let model = surface::cdp(app, id, "DOM.getBoxModel", json!({"backendNodeId":backend}), None, false).await.map_err(|e|format!("读取元素边界失败: {e}"))?;
    let quad = model["model"]["border"].as_array().filter(|q|q.len()==8).ok_or("元素已移除或不可见，请重新选取")?;
    let values: Vec<f64> = quad.iter().map(|v|v.as_f64().filter(|v|v.is_finite()).ok_or("元素尺寸无效")).collect::<Result<_,_>>()?;
    let metrics = surface::cdp(app, id, "Page.getLayoutMetrics", json!({}), None, false).await.map_err(|e|format!("读取页面边界失败: {e}"))?;
    let viewport = &metrics["cssVisualViewport"];
    let vx = viewport["pageX"].as_f64().ok_or("页面尺寸不可用")?;
    let vy = viewport["pageY"].as_f64().ok_or("页面尺寸不可用")?;
    // DOM box 是视口坐标，截图 clip 是文档坐标；先加滚动量，再与可见区域求交。
    let sx = metrics["cssLayoutViewport"]["pageX"].as_f64().ok_or("页面滚动位置不可用")?;
    let sy = metrics["cssLayoutViewport"]["pageY"].as_f64().ok_or("页面滚动位置不可用")?;
    let x = (values.iter().step_by(2).copied().fold(f64::INFINITY, f64::min) + sx).max(vx);
    let y = (values.iter().skip(1).step_by(2).copied().fold(f64::INFINITY, f64::min) + sy).max(vy);
    let right = (values.iter().step_by(2).copied().fold(f64::NEG_INFINITY, f64::max) + sx).min(vx + viewport["clientWidth"].as_f64().ok_or("页面尺寸不可用")?);
    let bottom = (values.iter().skip(1).step_by(2).copied().fold(f64::NEG_INFINITY, f64::max) + sy).min(vy + viewport["clientHeight"].as_f64().ok_or("页面尺寸不可用")?);
    if right - x < 1.0 || bottom - y < 1.0 { return Err("选中元素已离开可见区域，请滚动到元素后重试".into()); }
    let image = capture_locked(app,id,json!({"format":"png","captureBeyondViewport":false,"clip":{"x":x,"y":y,"width":right-x,"height":bottom-y,"scale":1}}),None,false).await.map_err(|e|format!("截取元素区域失败: {e}"))?;
    let current = panel_tab(app, id)?;
    if current.epoch != selected.epoch || !valid(&current.picker) { return Err("页面或元素已变化，请重新发送".into()); }
    let data = image["data"].as_str().filter(|data|data.len()<=8*1024*1024).ok_or("元素截图超过大小限制")?;
    Ok(json!({"dataUrl":format!("data:image/png;base64,{data}")}))
}

async fn collect(app: &AppHandle, id: &str, backend: i64, epoch: u64) -> Result<Value, String> {
    let tab = panel_tab(app, id)?;
    if tab.epoch != epoch { return Err("页面已变化，请重新选取".into()); }
    let world = surface::cdp(app, id, "Page.createIsolatedWorld", json!({"frameId":tab.frame,"worldName":"forge-user-picker","grantUniveralAccess":false}), None, false).await?;
    let context = world["executionContextId"].as_i64().ok_or("选取上下文不可用")?;
    let node = surface::cdp(app, id, "DOM.resolveNode", json!({"backendNodeId":backend,"executionContextId":context,"objectGroup":"forge-user-picker"}), None, false).await?;
    let object = node["object"]["objectId"].as_str().ok_or("元素已移除，请重新选取")?;
    let result = surface::cdp(app, id, "Runtime.callFunctionOn", json!({"objectId":object,"functionDeclaration":ELEMENT_DETAILS,"returnByValue":true}), None, false).await;
    let _ = surface::cdp(app, id, "Runtime.releaseObjectGroup", json!({"objectGroup":"forge-user-picker"}), None, false).await;
    let mut selection = result?["result"]["value"].clone();
    if !selection.is_object() { return Err("暂不支持选取 iframe 内的元素，请选取主页面元素".into()); }
    let current = panel_tab(app, id)?;
    if current.epoch != epoch { return Err("页面已变化，请重新选取".into()); }
    selection["epoch"] = json!(epoch);
    selection["tabId"] = json!(id);
    selection["url"] = json!(current.url);
    Ok(selection)
}

// 隔离世界只读固定元数据；不读取表单值、可编辑内容或整页 HTML。
const ELEMENT_DETAILS: &str = r#"function() {
  const el = this;
  if (!(el instanceof Element) || el.ownerDocument !== document || !el.isConnected || el.tagName === 'IFRAME') return null;
  const part = (node) => {
    const root = node.getRootNode();
    if (node.id && root.querySelectorAll('#' + CSS.escape(node.id)).length === 1) return '#' + CSS.escape(node.id);
    let path = [], current = node;
    while (current && path.length < 16) {
      let p = current.localName;
      const siblings = Array.from(current.parentNode?.children || []).filter(n => n.localName === p);
      if (siblings.length > 1) p += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      path.unshift(p);
      if (root.querySelectorAll(path.join(' > ')).length === 1) break;
      current = current.parentElement;
    }
    const prefix = root instanceof ShadowRoot ? part(root.host) + ' >>> ' : '';
    return prefix + path.join(' > ');
  };
  const editable = el.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
  let text = '', visited = 0;
  if (!editable) {
    // 限制遍历量；选到大型容器也不克隆整棵 DOM，不把隐藏或可编辑子树带出。
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.matches('input,textarea,select,[contenteditable],script,style,noscript,[hidden],[aria-hidden="true"]') || getComputedStyle(node).display === 'none' || getComputedStyle(node).visibility === 'hidden') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    }});
    let node;
    while ((node = walk.nextNode()) && visited++ < 2000 && text.length < 800) text += (node.textContent || '').slice(0,800 - text.length) + ' ';
  }
  const rect = el.getBoundingClientRect(), css = getComputedStyle(el);
  const styles = Object.fromEntries(['display','position','color','background-color','opacity','font-family','font-size','font-weight','border-color','border-radius','border-width','border-style','width','height','margin','padding','gap','align-items','justify-content'].map(k => [k, css.getPropertyValue(k).slice(0,160)]));
  return {tag: el.localName, selector: part(el).slice(0,2000), role: (el.getAttribute('role') || '').slice(0,100), name: (el.getAttribute('aria-label') || '').slice(0,200), text: text.replace(/\s+/g,' ').trim().slice(0,800), bounds: {x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)}, styles};
}"#;

/// 只允许用户面板编辑这些 CSS 属性，不接受脚本、选择器或任意 CDP。
const EDITABLE: &[&str] = &["color", "background-color", "opacity", "font-family", "font-size", "font-weight", "border-color", "border-radius", "border-width", "border-style", "width", "height", "margin", "padding", "gap"];

pub async fn edit(app: &AppHandle, id: &str, selection_id: u64, action: &str, patch: Value) -> Result<Value, String> {
    let tab = panel_tab(app, id)?;
    let _queue = tab.picker.queue.lock().await;
    let result = edit_locked(app, id, selection_id, action, patch).await?;
    paint(app, id).await?;
    changed(app);
    Ok(result)
}

async fn edit_locked(app: &AppHandle, id: &str, selection_id: u64, action: &str, patch: Value) -> Result<Value, String> {
    let tab = panel_tab(app, id)?;
    if tab.picker.active || tab.picker.pending || tab.picker.selection.as_ref().and_then(|s|s["selectionId"].as_u64()) != Some(selection_id) {
        return Err("元素标记已变化，请重新选取".into());
    }
    if !matches!(action, "preview" | "reset" | "commit") { return Err("未知样式操作".into()); }
    let properties = patch.as_object().ok_or("样式必须是对象")?;
    for (key, value) in properties {
        let text = value.as_str().ok_or("样式值必须是字符串")?;
        if !EDITABLE.contains(&key.as_str()) || text.len() > 160 || text.to_ascii_lowercase().contains("url(") {
            return Err("不支持的样式属性或值".into());
        }
    }
    let backend = tab.picker.backend.ok_or("元素已失效")?;
    let changes = call_style(app, id, &tab, backend, action, patch).await?;
    let mut selection = collect(app, id, backend, tab.epoch).await?;
    selection["selectionId"] = json!(selection_id);
    if changes.as_object().is_some_and(|c|!c.is_empty()) { selection["styleChanges"] = changes; }
    let mut state = host(app).lock();
    let current = state.tabs.get_mut(id).filter(|t|t.epoch == tab.epoch && t.picker.selection.as_ref().and_then(|s|s["selectionId"].as_u64()) == Some(selection_id)).ok_or("页面或元素已变化")?;
    current.picker.selection = Some(selection.clone());
    current.revision += 1;
    current.refs.clear();
    Ok(selection)
}

async fn call_style(app: &AppHandle, id: &str, tab: &super::Tab, backend: i64, action: &str, patch: Value) -> Result<Value, String> {
    let world = surface::cdp(app, id, "Page.createIsolatedWorld", json!({"frameId":tab.frame,"worldName":"forge-user-picker","grantUniveralAccess":false}), None, false).await?;
    let node = surface::cdp(app, id, "DOM.resolveNode", json!({"backendNodeId":backend,"executionContextId":world["executionContextId"],"objectGroup":"forge-user-style"}), None, false).await?;
    let result = surface::cdp(app, id, "Runtime.callFunctionOn", json!({"objectId":node["object"]["objectId"],"functionDeclaration":EDIT_STYLES,"arguments":[{"value":action},{"value":patch}],"returnByValue":true}), None, false).await;
    let _ = surface::cdp(app, id, "Runtime.releaseObjectGroup", json!({"objectGroup":"forge-user-style"}), None, false).await;
    let result = result?;
    if result.get("exceptionDetails").is_some() { return Err("元素已移除或样式值无效，请检查后重试".into()); }
    Ok(result["result"]["value"].clone())
}

// WeakMap 留在隔离世界，恢复时逐属性还原值和 !important，不覆盖网页自己的其他修改。
const EDIT_STYLES: &str = r#"function(action, patch) {
  if (!(this instanceof Element) || !this.isConnected) throw new Error('detached');
  const store = globalThis.__forgeStyleDrafts ||= new WeakMap();
  let draft = store.get(this);
  if (!draft) { draft = new Map(); store.set(this, draft); }
  if (action === 'preview') {
    for (const [key, value] of Object.entries(patch)) if (value && !CSS.supports(key, value)) throw new Error('invalid style');
    for (const [key, value] of Object.entries(patch)) {
      if (!draft.has(key)) draft.set(key, {value:this.style.getPropertyValue(key), priority:this.style.getPropertyPriority(key), before:getComputedStyle(this).getPropertyValue(key)});
      if (value) this.style.setProperty(key, value, 'important'); else {
        const old = draft.get(key);
        if (old.value) this.style.setProperty(key, old.value, old.priority); else this.style.removeProperty(key);
        draft.delete(key);
      }
    }
  }
  const changes = Object.fromEntries([...draft].map(([key, old]) => [key, {before:old.before, after:getComputedStyle(this).getPropertyValue(key)}]));
  if (action === 'reset') for (const [key, old] of draft) {
    if (old.value) this.style.setProperty(key, old.value, old.priority); else this.style.removeProperty(key);
  }
  if (action === 'reset' || action === 'commit') store.delete(this);
  return action === 'reset' ? {} : changes;
}"#;
