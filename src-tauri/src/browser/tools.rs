//! Finite tool operations. No arbitrary CDP passthrough and no model loop.
use super::*;
use forge_browser::success;
use std::time::{Duration, Instant};

fn required<'a>(a: &'a Value, key: &str) -> Result<&'a str, String> {
    a[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("INVALID_ARGUMENT: {key} required"))
}
pub async fn call(app: &AppHandle, token: &str, tool: &str, args: Value) -> Result<Value, String> {
    let current = scope(app, token)?;
    if tool == "browser_status" {
        let browser = crate::settings::read(app).browser;
        // 工具只公布授权边界，用户元素交付偏好不是 AI 权限。
        let settings = json!({"enabled":browser.enabled,"renderedPixels":browser.rendered_pixels,"fileUpload":browser.file_upload,"unsafeEvaluate":browser.unsafe_evaluate});
        return Ok(success(
            json!({"available":cfg!(windows),"version":VERSION,"sessionId":current.session,"runId":current.run,"readOnly":current.read_only,"grants":settings,"capabilities":{"nativeInput":cfg!(windows),"mainFrameAccessibility":true,"crossOriginDOM":false,"screenshots":"explicit-rendered-pixels","downloads":false,"trace":false,"heap":false,"popups":false,"arbitraryCDP":false},"instructions":forge_browser::INSTRUCTIONS}),
        ));
    }
    if tool == "browser_tabs" {
        return tabs(app, token, current, args).await;
    }
    let write = matches!(
        tool,
        "browser_navigate"
            | "browser_act"
            | "browser_emulate"
            | "browser_files"
            | "browser_evaluate"
    ) || tool == "browser_dialog"
        && args["action"].as_str().unwrap_or("status") != "status";
    let mut ticket = ticket(app, token, write)?;
    let tab = ticket.check(app, false)?;
    let _queue = tab.queue.lock().await;
    // Queued calls are re-authorized and bind the document current at dispatch time.
    ticket.epoch = ticket.check(app, false)?.epoch;
    let value = match tool {
        "browser_snapshot" => snapshot(app, &ticket).await?,
        "browser_navigate" => {
            let action = args["action"].as_str().unwrap_or("goto");
            match action {
                "goto" => {
                    let url = forge_browser::navigation_url(required(&args, "url")?)?;
                    let tab = ticket.check(app, true)?;
                    if !tab.managed && tab.allowed_origin != origin(&url) {
                        return Err("ORIGIN_REQUIRED: use the address bar and explicitly share this user's page at the new origin".into());
                    }
                    cdp(app, &ticket, "Page.navigate", json!({"url":url}), false).await?;
                }
                "reload" => {
                    cdp(app, &ticket, "Page.reload", json!({}), false).await?;
                }
                "stop" => {
                    cdp(app, &ticket, "Page.stopLoading", json!({}), false).await?;
                }
                "back" | "forward" => {
                    let history =
                        cdp(app, &ticket, "Page.getNavigationHistory", json!({}), true).await?;
                    let i = history["currentIndex"].as_i64().unwrap_or(0)
                        + if action == "back" { -1 } else { 1 };
                    let entry = history["entries"]
                        .as_array()
                        .and_then(|a| usize::try_from(i).ok().and_then(|i| a.get(i)))
                        .ok_or("NO_HISTORY: no history entry")?;
                    cdp(
                        app,
                        &ticket,
                        "Page.navigateToHistoryEntry",
                        json!({"entryId":entry["id"]}),
                        false,
                    )
                    .await?;
                }
                _ => return Err("INVALID_ARGUMENT: unsupported navigation".into()),
            }
            json!({"dispatch":"dispatched","businessSuccess":null,"observation":"Use browser_snapshot or browser_wait after navigation"})
        }
        "browser_screenshot" => {
            if !crate::settings::read(app).browser.rendered_pixels {
                return Err("GRANT_REQUIRED: enable rendered-pixels in Forge browser settings; visible iframe pixels are included".into());
            }
            let result = super::picker::capture(
                app,
                &ticket.tab,
                json!({"format":"png","captureBeyondViewport":false}),
                Some(ticket.clone()),
                true,
            )
            .await?;
            ticket.check(app, true)?;
            let data = result["data"].as_str().ok_or("screenshot data missing")?;
            if data.len() > 6 * 1024 * 1024 {
                return Err("LIMIT: screenshot exceeds 6 MiB".into());
            }
            return Ok(
                json!({"content":[{"type":"image","mimeType":"image/png","data":data}],"structuredContent":{"tabId":ticket.tab,"epoch":ticket.epoch,"scope":"rendered-pixels","includesVisibleSubframes":true},"isError":false}),
            );
        }
        "browser_act" => act(app, &ticket, args).await?,
        "browser_wait" => {
            let deadline =
                Instant::now() + Duration::from_millis(args["timeoutMs"].as_u64().unwrap_or(10000));
            loop {
                ticket.epoch = ticket.check(app, false)?.epoch;
                let result = snapshot(app, &ticket).await;
                match result {
                    Ok(observation) => {
                        let text = args["text"].as_str();
                        let url = args["url"].as_str();
                        let matches = text.is_none_or(|s| {
                            observation["nodes"].as_array().is_some_and(|nodes| {
                                nodes.iter().any(|node| {
                                    node["name"].as_str().is_some_and(|name| name.contains(s))
                                })
                            })
                        }) && url.is_none_or(|u| {
                            observation["url"].as_str().is_some_and(|s| s.contains(u))
                        }) && (text.is_some()
                            || url.is_some()
                            || matches!(
                                observation["readyState"].as_str(),
                                Some("interactive" | "complete")
                            ));
                        if matches {
                            break json!({"matched":true,"observation":observation});
                        }
                        if Instant::now() >= deadline {
                            break json!({"matched":false,"timedOut":true,"observation":observation});
                        }
                    }
                    Err(e)
                        if (e.starts_with("STALE_DOCUMENT") || e.starts_with("NOT_READY"))
                            && Instant::now() < deadline =>
                    {
                        ()
                    }
                    Err(e) => return Err(e),
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        }
        "browser_console" | "browser_network" => {
            let mut state = host(app).lock();
            let tab = state.tabs.get_mut(&ticket.tab).ok_or("TAB_CLOSED")?;
            let queue = if tool == "browser_console" {
                &mut tab.console
            } else {
                &mut tab.network
            };
            let entries = queue.iter().cloned().collect::<Vec<_>>();
            if args["clear"] == true {
                queue.clear();
            }
            json!({"entries":entries,"limit":200,"scope":"main-frame-only","untrusted":true})
        }
        "browser_dialog" => {
            let action = args["action"].as_str().unwrap_or("status");
            if action != "status" {
                if ticket
                    .check(app, false)?
                    .dialog
                    .as_ref()
                    .is_none_or(|d| d["scope"] != "same-origin")
                {
                    return Err("FRAME_DENIED: dialog source is not authorized".into());
                }
                cdp(app,&ticket,"Page.handleJavaScriptDialog",json!({"accept":action=="accept","promptText":args["text"].as_str().unwrap_or("")}),false).await?;
            }
            json!({"dialog":ticket.check(app,false)?.dialog})
        }
        "browser_emulate" => {
            emulation::apply(app, &tab.id, args, Some(&ticket)).await?
        }
        "browser_files" => {
            if !crate::settings::read(app).browser.file_upload {
                return Err(
                    "GRANT_REQUIRED: enable workspace file uploads in Forge browser settings"
                        .into(),
                );
            }
            let node = node(app, &ticket, required(&args, "ref")?).await?;
            let description = cdp(
                app,
                &ticket,
                "DOM.describeNode",
                json!({"backendNodeId":node.backend}),
                true,
            )
            .await?;
            let attrs = description["node"]["attributes"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if description["node"]["nodeName"] != "INPUT"
                || !attrs.chunks(2).any(|a| {
                    a.len() == 2
                        && a[0] == "type"
                        && a[1]
                            .as_str()
                            .is_some_and(|s| s.eq_ignore_ascii_case("file"))
                })
            {
                return Err("INVALID_TARGET: expected input[type=file]".into());
            }
            let root = std::fs::canonicalize(&current.workspace).map_err(|e| e.to_string())?;
            let mut paths = Vec::new();
            for path in args["paths"]
                .as_array()
                .ok_or("INVALID_ARGUMENT: paths required")?
            {
                let path = std::fs::canonicalize(path.as_str().ok_or("invalid file path")?)
                    .map_err(|e| e.to_string())?;
                if !path.starts_with(&root) || !path.is_file() {
                    return Err("PATH_DENIED: uploads must be files inside this workspace".into());
                }
                paths.push(path.to_string_lossy().into_owned());
            }
            cdp(
                app,
                &ticket,
                "DOM.setFileInputFiles",
                json!({"backendNodeId":node.backend,"files":paths}),
                true,
            )
            .await?;
            json!({"dispatch":"dispatched","businessSuccess":null,"fileCount":paths.len()})
        }
        "browser_evaluate" => {
            if !crate::settings::read(app).browser.unsafe_evaluate {
                return Err(
                    "GRANT_REQUIRED: enable unsafe evaluate in Forge browser settings".into(),
                );
            }
            let context = world(app, &ticket).await?;
            let value = cdp(app,&ticket,"Runtime.evaluate",json!({"expression":required(&args,"expression")?,"contextId":context,"returnByValue":true,"awaitPromise":true,"timeout":5000}),true).await?;
            if value.get("exceptionDetails").is_some() {
                return Err(format!("EVALUATION_ERROR: {}", value["exceptionDetails"]));
            }
            json!({"result":value["result"],"untrusted":true,"unsafeEvaluate":true})
        }
        "browser_debug" => {
            let metrics = cdp(app, &ticket, "Performance.getMetrics", json!({}), true).await?;
            let tab = ticket.check(app, true)?;
            json!({"tabId":tab.id,"epoch":tab.epoch,"url":tab.url,"metrics":metrics["metrics"],"consoleCount":tab.console.len(),"networkCount":tab.network.len(),"refCount":tab.refs.len()})
        }
        _ => return Err("UNKNOWN_TOOL: unsupported browser tool".into()),
    };
    // A reply cannot release observations after a stop, close or takeover.
    ticket.check(app, !write && tool != "browser_wait")?;
    Ok(success(value))
}

async fn tabs(app: &AppHandle, token: &str, current: Scope, args: Value) -> Result<Value, String> {
    match args["action"].as_str().unwrap_or("list") {
        "create" => {
            if current.read_only {
                return Err("READ_ONLY: cannot create a browsing context".into());
            }
            let url = args["url"]
                .as_str()
                .map(forge_browser::navigation_url)
                .transpose()?
                .unwrap_or("about:blank".into());
            let tab = create(app, &current, true).await?;
            let setup = async {
                scope(app, token)?;
                if url != "about:blank" {
                    let ticket = ticket(app, token, true)?;
                    cdp(app, &ticket, "Page.navigate", json!({"url":url}), false).await?;
                }
                Ok::<(), String>(())
            }
            .await;
            if let Err(e) = setup {
                host(app).lock().tabs.remove(&tab.id);
                let _ = surface::close(app, tab.id).await;
                return Err(e);
            }
            let workspace = crate::ai_runtime::browser_requested_workspace(&current.run)
                .unwrap_or_else(|| current.workspace.clone());
            let _ = app.emit(
                "forge-browser-open",
                json!({"workspace":workspace,"tabId":tab.id}),
            );
        }
        "select" | "close" => {
            let id = required(&args, "tabId")?.to_string();
            {
                let mut state = host(app).lock();
                let tab = state.tabs.get(&id).ok_or("TAB_CLOSED: page closed")?;
                if tab.workspace != current.workspace || tab.session_id != current.session {
                    return Err("SCOPE_DENIED: page belongs to another session".into());
                }
                if args["action"] == "close" {
                    if current.read_only || tab.grant != Grant::Control {
                        return Err("READ_ONLY: cannot close page".into());
                    }
                    state.tabs.remove(&id);
                } else {
                    if tab.grant == Grant::None {
                        return Err("GRANT_REQUIRED: page was taken over by user".into());
                    }
                    state.working.insert(
                        (current.workspace.clone(), current.session.clone()),
                        id.clone(),
                    );
                }
            }
            if args["action"] == "close" {
                surface::close(app, id).await?;
            }
            changed(app);
        }
        "list" => (),
        _ => return Err("INVALID_ARGUMENT: invalid tabs action".into()),
    }
    scope(app, token)?;
    let state = host(app).lock();
    let tabs = state
        .tabs
        .values()
        .filter(|t| t.workspace == current.workspace && t.session_id == current.session)
        .map(|t| {
            if t.grant == Grant::None {
                json!({"id":t.id,"grant":"none","managed":t.managed})
            } else {
                serde_json::to_value(t).unwrap_or(Value::Null)
            }
        })
        .collect::<Vec<_>>();
    Ok(success(
        json!({"tabs":tabs,"workingTabId":state.working.get(&(current.workspace,current.session))}),
    ))
}

pub(super) async fn initialize(app: &AppHandle, id: &str) -> Result<(), String> {
    for method in [
        "Page.enable",
        "Runtime.enable",
        "Network.enable",
        "Accessibility.enable",
        "Performance.enable",
    ] {
        surface::cdp(app, id, method, json!({}), None, false).await?;
    }
    let frame = surface::cdp(app, id, "Page.getFrameTree", json!({}), None, false).await?;
    if let Some(t) = host(app).lock().tabs.get_mut(id) {
        t.frame = frame["frameTree"]["frame"]["id"]
            .as_str()
            .unwrap_or_default()
            .into();
    }
    Ok(())
}
async fn cdp(
    app: &AppHandle,
    ticket: &Ticket,
    method: &str,
    params: Value,
    document: bool,
) -> Result<Value, String> {
    ticket.check(app, document)?;
    let value = surface::cdp(
        app,
        &ticket.tab,
        method,
        params,
        Some(ticket.clone()),
        document,
    )
    .await?;
    ticket.check(app, document)?;
    Ok(value)
}
async fn world(app: &AppHandle, ticket: &Ticket) -> Result<i64, String> {
    let tab = ticket.check(app, true)?;
    if tab.frame.is_empty() {
        return Err("NOT_READY: main frame unavailable".into());
    }
    cdp(
        app,
        ticket,
        "Page.createIsolatedWorld",
        json!({"frameId":tab.frame,"worldName":"forge-browser"}),
        true,
    )
    .await?["executionContextId"]
        .as_i64()
        .ok_or("isolated world unavailable".into())
}
async fn snapshot(app: &AppHandle, ticket: &Ticket) -> Result<Value, String> {
    let tab = ticket.check(app, true)?;
    let revision = dom_revision(app, ticket).await?;
    let tree = cdp(
        app,
        ticket,
        "Accessibility.getFullAXTree",
        json!({"frameId":tab.frame,"depth":25}),
        true,
    )
    .await?;
    if dom_revision(app, ticket).await? != revision {
        return Err("STALE_DOCUMENT: DOM changed during snapshot; retry snapshot".into());
    }
    let raw_nodes = tree["nodes"]
        .as_array()
        .ok_or("accessibility tree missing")?;
    let allowed = main_frame_nodes(raw_nodes, &tab.frame)?;
    let context = world(app, ticket).await?;
    let document = cdp(
        app,
        ticket,
        "Runtime.evaluate",
        json!({"contextId":context,"expression":"document.readyState","returnByValue":true}),
        true,
    )
    .await?;
    let mut state = host(app).lock();
    state.snapshot += 1;
    let serial = state.snapshot;
    let tab = state.tabs.get_mut(&ticket.tab).ok_or("TAB_CLOSED")?;
    if tab.epoch != ticket.epoch || tab.revision != ticket.revision {
        return Err("STALE_DOCUMENT: snapshot invalidated".into());
    }
    tab.refs.clear();
    let mut nodes = Vec::new();
    let mut bytes = 0;
    for node in raw_nodes
        .iter()
        .filter(|n| n["nodeId"].as_str().is_some_and(|id| allowed.contains(id)))
        .take(3000)
    {
        if node["ignored"] == true {
            continue;
        }
        if node["frameId"].as_str().is_some_and(|id| id != tab.frame) {
            continue;
        }
        let role = node["role"]["value"].as_str().unwrap_or("");
        let name = node["name"]["value"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(2000)
            .collect::<String>();
        if role == "RootWebArea" {
            tab.title = name.clone();
        }
        let reference = if let Some(backend) = node["backendDOMNodeId"]
            .as_i64()
            .filter(|_| !matches!(role, "Iframe" | "IframePresentational"))
        {
            let reference = format!("s{serial}n{backend}");
            tab.refs.insert(
                reference.clone(),
                NodeRef {
                    backend,
                    epoch: ticket.epoch,
                    snapshot: serial,
                    dom_revision: revision,
                    role: role.into(),
                    name: name.clone(),
                },
            );
            Some(reference)
        } else {
            None
        };
        let protected = node["properties"].as_array().is_some_and(|properties| {
            properties
                .iter()
                .any(|p| p["name"] == "protected" && p["value"]["value"] == true)
        });
        let field_value = if protected {
            json!("[redacted]")
        } else if let Some(text) = node["value"]["value"].as_str() {
            json!(text.chars().take(2000).collect::<String>())
        } else if node["value"]["value"].is_null()
            && matches!(role, "textbox" | "searchbox" | "combobox")
        {
            // Chromium omits AXValue for an empty text field; expose a stable public value.
            json!("")
        } else {
            node["value"]["value"].clone()
        };
        let value = json!({"ref":reference,"role":role,"name":name,"value":field_value,"properties":node["properties"]});
        bytes += value.to_string().len();
        if bytes > 250000 {
            break;
        }
        nodes.push(value);
    }
    Ok(
        json!({"tabId":tab.id,"url":tab.url,"title":tab.title,"epoch":tab.epoch,"snapshotId":serial,"readyState":document["result"]["value"],"nodes":nodes,"truncated":raw_nodes.len()>3000 || bytes>250000,"scope":"main-frame-only","untrusted":true}),
    )
}
async fn node(app: &AppHandle, ticket: &Ticket, reference: &str) -> Result<NodeRef, String> {
    let tab = ticket.check(app, true)?;
    let node = tab
        .refs
        .get(reference)
        .cloned()
        .ok_or("STALE_REF: take a fresh snapshot")?;
    if node.epoch != ticket.epoch {
        return Err("STALE_REF: document changed".into());
    }
    if dom_revision(app, ticket).await? != node.dom_revision {
        return Err("STALE_REF: DOM mutated since snapshot".into());
    }
    let tree = cdp(
        app,
        ticket,
        "Accessibility.getPartialAXTree",
        json!({"backendNodeId":node.backend,"fetchRelatives":false}),
        true,
    )
    .await?;
    let current = tree["nodes"]
        .as_array()
        .and_then(|nodes| nodes.iter().find(|n| n["backendDOMNodeId"] == node.backend))
        .ok_or("STALE_REF: node detached")?;
    if current["role"]["value"] != node.role
        || current["name"]["value"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(2000)
            .collect::<String>()
            != node.name
        || current["ignored"] == true
    {
        return Err("STALE_REF: target semantics changed".into());
    }
    let latest = ticket.check(app, true)?;
    if latest
        .refs
        .get(reference)
        .is_none_or(|r| r.snapshot != node.snapshot)
    {
        return Err("STALE_REF: snapshot superseded".into());
    }
    Ok(node)
}

async fn dom_revision(app: &AppHandle, ticket: &Ticket) -> Result<u64, String> {
    let context = world(app, ticket).await?;
    let result = cdp(app,ticket,"Runtime.evaluate",json!({"contextId":context,"expression":"(()=>{if(!globalThis.__forgeDOM){const s={revision:0};new MutationObserver(()=>s.revision++).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});globalThis.__forgeDOM=s;}return globalThis.__forgeDOM.revision;})()","returnByValue":true}),true).await?;
    result["result"]["value"]
        .as_u64()
        .ok_or("DOM revision unavailable".into())
}

/// AXNode.frameId is optional. Traverse from the main root and stop at frame boundaries.
fn main_frame_nodes(
    nodes: &[Value],
    frame: &str,
) -> Result<std::collections::HashSet<String>, String> {
    let by_id = nodes
        .iter()
        .filter_map(|n| n["nodeId"].as_str().map(|id| (id, n)))
        .collect::<HashMap<_, _>>();
    let root = nodes
        .iter()
        .find(|n| n["frameId"] == frame && n["role"]["value"] == "RootWebArea")
        .ok_or("NOT_READY: main accessibility root missing")?;
    let root_id = root["nodeId"].as_str().ok_or("invalid AX root")?;
    let mut pending = vec![root_id];
    let mut allowed = std::collections::HashSet::new();
    while let Some(id) = pending.pop() {
        let Some(node) = by_id.get(id) else {
            continue;
        };
        if node["frameId"].as_str().is_some_and(|f| f != frame)
            || (id != root_id && node["role"]["value"] == "RootWebArea")
        {
            continue;
        }
        if !allowed.insert(id.to_string()) {
            continue;
        }
        if matches!(
            node["role"]["value"].as_str(),
            Some("Iframe" | "IframePresentational")
        ) {
            continue;
        }
        pending.extend(
            node["childIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str()),
        );
    }
    Ok(allowed)
}
async fn act(app: &AppHandle, ticket: &Ticket, args: Value) -> Result<Value, String> {
    let action = required(&args, "action")?;
    let mut ops = Vec::new();
    if matches!(action, "click" | "hover" | "fill") {
        let node = node(app, ticket, required(&args, "ref")?).await?;
        let context = world(app, ticket).await?;
        let object = cdp(
            app,
            ticket,
            "DOM.resolveNode",
            json!({"backendNodeId":node.backend,"executionContextId":context}),
            true,
        )
        .await?;
        let id = object["object"]["objectId"]
            .as_str()
            .ok_or("STALE_REF: node no longer resolves")?;
        let result = cdp(app,ticket,"Runtime.callFunctionOn",json!({"objectId":id,"functionDeclaration":"function(){if(!this.isConnected)return null;const r=this.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const h=this.ownerDocument.elementFromPoint(x,y);return {x,y,visible:r.width>0&&r.height>0,hit:h===this||this.contains(h),editable:this.isContentEditable||this instanceof HTMLTextAreaElement||this instanceof HTMLInputElement&&!['button','submit','reset','checkbox','radio','file','hidden','image'].includes(this.type),disabled:!!this.disabled||!!this.readOnly};}","returnByValue":true}),true).await;
        let _ = cdp(
            app,
            ticket,
            "Runtime.releaseObject",
            json!({"objectId":id}),
            true,
        )
        .await;
        let point = &result?["result"]["value"];
        if point["visible"] != true || point["hit"] != true {
            return Err("TARGET_OCCLUDED: scroll or refresh snapshot before acting".into());
        }
        let x = point["x"].as_f64().ok_or("invalid target geometry")?;
        let y = point["y"].as_f64().ok_or("invalid target geometry")?;
        if action == "fill" {
            if point["editable"] != true || point["disabled"] == true {
                return Err("INVALID_TARGET: fill requires an enabled editable field".into());
            }
            let text = args["text"]
                .as_str()
                .ok_or("INVALID_ARGUMENT: text required")?;
            ops.push(("DOM.focus", json!({"backendNodeId":node.backend})));
            ops.push(("Input.dispatchKeyEvent",json!({"type":"keyDown","key":"a","code":"KeyA","windowsVirtualKeyCode":65,"modifiers":2})));
            ops.push(("Input.dispatchKeyEvent",json!({"type":"keyUp","key":"a","code":"KeyA","windowsVirtualKeyCode":65,"modifiers":2})));
            if text.is_empty() {
                // insertText("") is a no-op; delete the selected value using trusted input.
                ops.push((
                    "Input.dispatchKeyEvent",
                    json!({"type":"keyDown","key":"Backspace","windowsVirtualKeyCode":8}),
                ));
                ops.push((
                    "Input.dispatchKeyEvent",
                    json!({"type":"keyUp","key":"Backspace","windowsVirtualKeyCode":8}),
                ));
            } else {
                ops.push(("Input.insertText", json!({"text":text})));
            }
        } else {
            ops.push((
                "Input.dispatchMouseEvent",
                json!({"type":"mouseMoved","x":x,"y":y}),
            ));
            if action == "click" {
                ops.push((
                    "Input.dispatchMouseEvent",
                    json!({"type":"mousePressed","x":x,"y":y,"button":"left","clickCount":1}),
                ));
                ops.push((
                    "Input.dispatchMouseEvent",
                    json!({"type":"mouseReleased","x":x,"y":y,"button":"left","clickCount":1}),
                ));
            }
        }
    } else if action == "press" {
        let key = required(&args, "key")?;
        let code = match key {
            "Enter" => 13,
            "Tab" => 9,
            "Escape" => 27,
            "Backspace" => 8,
            "Delete" => 46,
            "ArrowLeft" => 37,
            "ArrowUp" => 38,
            "ArrowRight" => 39,
            "ArrowDown" => 40,
            "Home" => 36,
            "End" => 35,
            "PageUp" => 33,
            "PageDown" => 34,
            _ => return Err("INVALID_ARGUMENT: unsupported key".into()),
        };
        ops.push((
            "Input.dispatchKeyEvent",
            json!({"type":"keyDown","key":key,"windowsVirtualKeyCode":code}),
        ));
        ops.push((
            "Input.dispatchKeyEvent",
            json!({"type":"keyUp","key":key,"windowsVirtualKeyCode":code}),
        ));
    } else if action == "scroll" {
        ops.push(("Input.dispatchMouseEvent",json!({"type":"mouseWheel","x":100,"y":100,"deltaX":args["x"].as_f64().unwrap_or(0.0),"deltaY":args["y"].as_f64().unwrap_or(600.0)})));
    } else {
        return Err("INVALID_ARGUMENT: unsupported action".into());
    }
    let count = ops.len();
    dispatch_sequence(app, ticket, ops).await?;
    if let Some(tab) = host(app).lock().tabs.get_mut(&ticket.tab) {
        tab.refs.clear();
    }
    tokio::time::sleep(Duration::from_millis(150)).await;
    let mut after = ticket.clone();
    after.epoch = after.check(app, false)?.epoch;
    let observation = snapshot(app, &after).await;
    ticket.check(app, false)?;
    Ok(
        json!({"dispatch":"dispatched","input":"trusted-cdp","operations":count,"businessSuccess":null,"observation":observation.as_ref().ok(),"observationError":observation.as_ref().err()}),
    )
}
async fn dispatch_sequence(
    app: &AppHandle,
    ticket: &Ticket,
    ops: Vec<(&str, Value)>,
) -> Result<(), String> {
    let mut dispatched = 0;
    for (method, mut params) in ops {
        let operation=async {
            if method=="Input.dispatchMouseEvent" {
                let hit=cdp(app,ticket,"DOM.getNodeForLocation",json!({"x":params["x"].as_f64().unwrap_or(0.0).floor() as i64,"y":params["y"].as_f64().unwrap_or(0.0).floor() as i64,"includeUserAgentShadowDOM":true}),true).await?;
                if hit["frameId"]!=ticket.check(app,true)?.frame { return Err("FRAME_DENIED: pointer target is inside an unsupported child frame".into()); }
                let hit_node=cdp(app,ticket,"DOM.describeNode",json!({"backendNodeId":hit["backendNodeId"],"depth":0}),true).await?;
                if matches!(hit_node["node"]["nodeName"].as_str(),Some("IFRAME"|"FRAME")) { return Err("FRAME_DENIED: pointer hit an unsupported frame element".into()); }
                // 命中检测使用页面 CSS 坐标；原生输入使用缩小后的视图坐标。
                let scale = ticket.check(app,true)?.preview_scale;
                for axis in ["x", "y"] {
                    if let Some(value) = params[axis].as_f64() { params[axis] = json!(value * scale); }
                }
            }
            if method=="Input.dispatchKeyEvent" || method=="Input.insertText" {
                let context=world(app,ticket).await?;
                let focused=cdp(app,ticket,"Runtime.evaluate",json!({"contextId":context,"expression":"(()=>{const e=document.activeElement;return !!e&&['BODY','INPUT','TEXTAREA','BUTTON','SELECT','OPTION','A'].includes(e.tagName);})()","returnByValue":true}),true).await?;
                // Custom/closed shadow hosts cannot prove main-frame keyboard focus here.
                if focused["result"]["value"]!=true { return Err("FRAME_DENIED: focus a supported main-frame control before keyboard input".into()); }
            }
            cdp(app,ticket,method,params,true).await
        }.await;
        match operation {
            Ok(_) => dispatched += 1,
            Err(e) => return Err(format!("DISPATCH_INTERRUPTED: {e}; completedOperations={dispatched}; current operation may have dispatched; do not retry automatically")),
        }
    }
    Ok(())
}
