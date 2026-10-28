//! Real WebView2 workflow verification. Requires isolated APPDATA/LOCALAPPDATA.
//! No existing test executable owns a native event loop, hence this opt-in harness.
use super::*;
use std::time::Duration;

pub fn run() {
    let output = std::env::var("FORGE_BROWSER_SMOKE_RESULT").expect("smoke result path required");
    let isolated = std::env::var("FORGE_BROWSER_SMOKE_ROOT").expect("isolated temp root required");
    let root = std::fs::canonicalize(&isolated).expect("smoke root missing");
    assert!(root.starts_with(std::fs::canonicalize(std::env::temp_dir()).expect("temp missing")));
    for key in ["APPDATA", "LOCALAPPDATA"] {
        assert!(std::fs::canonicalize(
            std::env::var(key).expect("isolated data directory required")
        )
        .unwrap()
        .starts_with(&root));
    }
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "app.forge.browser-smoke".into();
    context.config_mut().app.windows[0].visible = false;
    context.config_mut().app.windows[0].data_directory = Some(root.join("host-webview"));
    context.config_mut().app.windows[0].title = "Forge browser verification".into();
    let app = tauri::Builder::default()
        .setup(move |app| {
            init(app.handle())?;
            let app = app.handle().clone();
            let output = output.clone();
            tauri::async_runtime::spawn(async move {
                let result = tokio::time::timeout(Duration::from_secs(110), verify(&app)).await;
                let value = match result {
                    Ok(Ok(checks)) => json!({"ok":true,"checks":checks}),
                    Ok(Err(e)) => json!({"ok":false,"error":e}),
                    Err(_) => json!({"ok":false,"error":"native workflow deadline exceeded"}),
                };
                let _ = std::fs::write(output, serde_json::to_vec_pretty(&value).unwrap());
                shutdown(&app);
                app.exit(if value["ok"] == true { 0 } else { 1 });
            });
            Ok(())
        })
        .build(context)
        .expect("native verification app failed");
    app.run(|_, _| {});
}
async fn invoke(app: &AppHandle, lease: &Lease, tool: &str, args: Value) -> Result<Value, String> {
    let mut result = forge_browser::transport::call(
        &host(app).endpoint,
        Request {
            version: VERSION.into(),
            token: lease.token.clone(),
            tool: tool.into(),
            arguments: args,
        },
    )
    .await?;
    if result["isError"] == true {
        result["structuredContent"]["verificationTool"] = json!(tool);
    }
    Ok(result)
}
fn ok(result: Value) -> Result<Value, String> {
    if result["isError"] == true {
        return Err(result["structuredContent"].to_string());
    }
    Ok(result["structuredContent"].clone())
}
fn expect_error(result: Value, code: &str) -> Result<(), String> {
    if result["isError"] == true && result["structuredContent"]["code"] == code {
        Ok(())
    } else {
        Err(format!("expected {code}, got {result}"))
    }
}
async fn verify(app: &AppHandle) -> Result<Vec<String>, String> {
    let workspace = std::env::var("FORGE_BROWSER_SMOKE_ROOT").map_err(|e| e.to_string())?;
    let url = std::env::var("FORGE_BROWSER_SMOKE_URL").map_err(|e| e.to_string())?;
    crate::settings::settings_save(app.clone(), json!({"aiAssistantsEnabled":true})).await?;
    let run = crate::ai_runtime::browser_smoke_reserve(&workspace, "native-one")?;
    let current = Scope {
        workspace: run.workspace.clone(),
        session: run.session_id.clone(),
        run: run.id.clone(),
        read_only: false,
    };
    let lease = attach(app, current.clone())?.ok_or("browser disabled")?;
    let mut checks = Vec::new();
    let cli_workspace = workspace.clone();
    let cli_run = run.id.clone();
    let (lease, cli) = tauri::async_runtime::spawn_blocking(move || {
        let result = crate::ai_runtime::browser_smoke_cli(&cli_workspace, &lease, &cli_run);
        (lease, result)
    })
    .await
    .map_err(|e| e.to_string())?;
    checks.extend(cli?);
    let status = ok(invoke(app, &lease, "browser_status", json!({})).await?)?;
    if status["grants"] != json!({"enabled":true,"renderedPixels":true,"unsafeEvaluate":false,"fileUpload":false}) {
        return Err(format!("unexpected default browser permissions: {status}"));
    }
    expect_error(
        forge_browser::transport::call(
            &host(app).endpoint,
            Request {
                version: VERSION.into(),
                token: "spoofed".into(),
                tool: "browser_status".into(),
                arguments: json!({}),
            },
        )
        .await?,
        "REVOKED",
    )?;
    checks.push("owner-only broker capability accepted; spoofed token rejected".into());
    let tabs = ok(invoke(
        app,
        &lease,
        "browser_tabs",
        json!({"action":"create","url":url}),
    )
    .await?)?;
    let tab_id = tabs["workingTabId"]
        .as_str()
        .ok_or("working tab missing")?
        .to_string();
    browser_panel_show(
        app.clone(),
        Some(tab_id.clone()),
        Bounds {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        },
    )
    .await?;
    browser_panel_show(
        app.clone(),
        None,
        Bounds {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        },
    )
    .await?;
    let observed = ok(invoke(
        app,
        &lease,
        "browser_wait",
        json!({"text":"Frame loaded","timeoutMs":10000}),
    )
    .await?)?;
    if observed["matched"] != true {
        return Err(format!("fixture not loaded: {observed}"));
    }
    let snapshot = &observed["observation"];
    if snapshot["nodes"].as_array().unwrap().iter().any(|n| {
        n["name"]
            .as_str()
            .is_some_and(|s| s.contains("FRAME_SECRET"))
    }) {
        return Err("cross-origin frame content leaked".into());
    }
    checks.push("main-frame accessibility excludes iframe content".into());
    let cover = snapshot["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["name"] == "Frame cover" && n["role"] == "button")
        .and_then(|n| n["ref"].as_str())
        .ok_or("frame cover missing")?;
    let blocked = invoke(
        app,
        &lease,
        "browser_act",
        json!({"action":"click","ref":cover}),
    )
    .await?;
    if blocked["isError"] != true
        || !blocked["structuredContent"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("FRAME_DENIED")
    {
        return Err("main-frame container allowed pointer dispatch into a child frame".into());
    }
    checks.push(
        "pointer hit testing refuses child frames even through a main-frame container ref".into(),
    );
    let reference = snapshot["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["role"] == "button" && n["name"] == "Run action")
        .and_then(|n| n["ref"].as_str())
        .ok_or("fixture action ref missing")?
        .to_string();
    ok(invoke(
        app,
        &lease,
        "browser_act",
        json!({"action":"click","ref":reference}),
    )
    .await?)?;
    let result = ok(invoke(
        app,
        &lease,
        "browser_wait",
        json!({"text":"Action complete","timeoutMs":5000}),
    )
    .await?)?;
    if result["matched"] != true {
        return Err(format!("trusted click did not change page: {result}"));
    }
    checks.push("trusted CDP click produces observable page change".into());
    expect_error(
        invoke(
            app,
            &lease,
            "browser_act",
            json!({"action":"click","ref":reference}),
        )
        .await?,
        "STALE_REF",
    )?;
    let default_shot = invoke(app, &lease, "browser_screenshot", json!({})).await?;
    let encoded = default_shot["content"][0]["data"].as_str().ok_or_else(|| format!("default screenshot missing: {default_shot}"))?;
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).map_err(|e|e.to_string())?;
    if default_shot["content"][0]["mimeType"] != "image/png" || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("default screenshot did not return MCP PNG image content".into());
    }
    expect_error(
        invoke(app, &lease, "browser_files", json!({"ref":"ungranted","paths":["upload.txt"]})).await?,
        "GRANT_REQUIRED",
    )?;
    expect_error(
        invoke(
            app,
            &lease,
            "browser_evaluate",
            json!({"expression":"document.title"}),
        )
        .await?,
        "GRANT_REQUIRED",
    )?;
    crate::settings::settings_save(app.clone(), json!({"browser":{"renderedPixels":false}})).await?;
    expect_error(
        invoke(app, &lease, "browser_screenshot", json!({})).await?,
        "GRANT_REQUIRED",
    )?;
    checks.push("screenshots default to MCP PNG; uploads and evaluate require authorization; explicit screenshot revocation works".into());
    let snapshot = ok(invoke(app, &lease, "browser_snapshot", json!({})).await?)?;
    let name = snapshot["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["role"] == "textbox" && n["name"] == "Name")
        .and_then(|n| n["ref"].as_str())
        .ok_or("input ref missing")?;
    ok(invoke(
        app,
        &lease,
        "browser_act",
        json!({"action":"fill","ref":name,"text":"Forge input"}),
    )
    .await?)?;
    let filled = ok(invoke(
        app,
        &lease,
        "browser_wait",
        json!({"text":"Trusted input: Forge input","timeoutMs":3000}),
    )
    .await?)?;
    if filled["matched"] != true {
        return Err(format!("trusted fill did not fire input: {filled}"));
    }
    checks.push("fill uses trusted input and fires the page's input handler".into());
    let field = filled["observation"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["role"] == "textbox" && n["name"] == "Name")
        .ok_or("filled textbox missing")?;
    if field["value"] != "Forge input" {
        return Err("AX snapshot omitted the current input value".into());
    }
    let cleared = ok(invoke(
        app,
        &lease,
        "browser_act",
        json!({"action":"fill","ref":field["ref"],"text":""}),
    )
    .await?)?;
    let field = cleared["observation"]["nodes"]
        .as_array()
        .ok_or("clear observation missing")?
        .iter()
        .find(|n| n["role"] == "textbox" && n["name"] == "Name")
        .ok_or("cleared textbox missing")?;
    if field["value"] != "" {
        return Err(format!("empty fill did not clear the real input: {field}"));
    }
    if !cleared["observation"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n["name"] == "Trusted input:")
    {
        return Err("empty fill did not dispatch the trusted page input event".into());
    }
    checks.push("AX exposes current form value; empty fill clears the field".into());
    let read = attach(
        app,
        Scope {
            read_only: true,
            ..current.clone()
        },
    )?
    .unwrap();
    expect_error(
        invoke(app, &read, "browser_navigate", json!({"url":url})).await?,
        "READ_ONLY",
    )?;
    expect_error(
        invoke(app, &read, "browser_tabs", json!({"action":"create"})).await?,
        "READ_ONLY",
    )?;
    expect_error(invoke(app, &read, "browser_emulate", json!({"width":390,"height":844})).await?, "READ_ONLY")?;
    ok(invoke(app, &read, "browser_snapshot", json!({})).await?)?;
    checks.push("read-only scope observes but cannot navigate or create".into());
    browser_panel_grant(app.clone(), tab_id.clone(), Grant::None).await?;
    expect_error(
        invoke(app, &lease, "browser_snapshot", json!({})).await?,
        "REVOKED",
    )?;
    browser_panel_grant(app.clone(), tab_id.clone(), Grant::Control).await?;
    let foreign_run = crate::ai_runtime::browser_smoke_reserve(&workspace, "native-two")?;
    let foreign = attach(
        app,
        Scope {
            workspace: foreign_run.workspace.clone(),
            session: foreign_run.session_id.clone(),
            run: foreign_run.id.clone(),
            read_only: false,
        },
    )?
    .unwrap();
    expect_error(
        invoke(
            app,
            &foreign,
            "browser_tabs",
            json!({"action":"select","tabId":tab_id}),
        )
        .await?,
        "SCOPE_DENIED",
    )?;
    checks.push("takeover revokes access; other sessions cannot select the page".into());
    let pending = invoke(
        app,
        &lease,
        "browser_wait",
        json!({"text":"never appears","timeoutMs":5000}),
    );
    let revoke = async {
        tokio::time::sleep(Duration::from_millis(150)).await;
        browser_panel_grant(app.clone(), tab_id.clone(), Grant::None)
            .await
            .unwrap();
    };
    let (response, _) = tokio::join!(pending, revoke);
    expect_error(response?, "REVOKED")?;
    checks.push("in-flight wait cannot return data after revoke".into());
    browser_panel_grant(app.clone(), tab_id.clone(), Grant::Control).await?;
    for tool in ["browser_network", "browser_console", "browser_debug"] {
        ok(invoke(app, &lease, tool, json!({})).await?)?;
    }
    verify_emulation(app, &lease, &tab_id, &url).await?;
    checks.push("phone/tablet/desktop metrics, orientation, DPR/touch, fitted AI clicks, per-page state and reset execute against WebView2".into());
    checks.push("network bandwidth and latency delay a real fetch; offline rejects requests; UI and MCP share settings".into());
    crate::settings::settings_save(
        app.clone(),
        json!({"browser":{"renderedPixels":true,"unsafeEvaluate":true,"fileUpload":true}}),
    )
    .await?;
    ok(invoke(app, &lease, "browser_status", json!({})).await?)?;
    let pixels = attach(app, current)?.unwrap();
    browser_panel_grant(app.clone(), tab_id.clone(), Grant::Control).await?;
    let shot = invoke(app, &pixels, "browser_screenshot", json!({})).await?;
    if shot["isError"] == true
        || shot["content"][0]["type"] != "image"
        || !shot["content"][0]["data"]
            .as_str()
            .is_some_and(|s| s.starts_with("iVBOR"))
    {
        return Err("PNG MCP image missing".into());
    }
    checks.push("explicit pixels grant returns MCP PNG image content".into());
    let isolated = ok(invoke(
        app,
        &pixels,
        "browser_evaluate",
        json!({"expression":"typeof globalThis.__TAURI_INTERNALS__"}),
    )
    .await?)?;
    if isolated["result"]["value"] != "undefined" {
        return Err("page has Forge IPC globals".into());
    }
    let before = ok(invoke(app, &pixels, "browser_snapshot", json!({})).await?)?;
    let stale = before["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["role"] == "button" && n["name"] == "Run action")
        .and_then(|n| n["ref"].as_str())
        .unwrap();
    ok(invoke(
        app,
        &pixels,
        "browser_evaluate",
        json!({"expression":"document.querySelector('button').setAttribute('data-row','reused')"}),
    )
    .await?)?;
    expect_error(
        invoke(
            app,
            &pixels,
            "browser_act",
            json!({"action":"click","ref":stale}),
        )
        .await?,
        "STALE_REF",
    )?;
    let before = ok(invoke(app, &pixels, "browser_snapshot", json!({})).await?)?;
    let stale = before["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["role"] == "button" && n["name"] == "Run action")
        .and_then(|n| n["ref"].as_str())
        .unwrap();
    let navigation = invoke(
        app,
        &pixels,
        "browser_evaluate",
        json!({"expression":"history.pushState({},'', '#B');history.pushState({},'', '#A');true"}),
    )
    .await?;
    // A script can navigate before its result returns. Never retry that dispatched expression.
    if navigation["isError"] == true && navigation["structuredContent"]["code"] != "STALE_DOCUMENT"
    {
        ok(navigation)?;
    }
    expect_error(
        invoke(
            app,
            &pixels,
            "browser_act",
            json!({"action":"click","ref":stale}),
        )
        .await?,
        "STALE_REF",
    )?;
    checks.push("page has no Forge IPC; DOM reuse and SPA A-B-A invalidate refs".into());
    ok(invoke(
        app,
        &pixels,
        "browser_evaluate",
        json!({"expression":"document.querySelector('iframe').focus();true"}),
    )
    .await?)?;
    let denied = invoke(
        app,
        &pixels,
        "browser_act",
        json!({"action":"press","key":"Enter"}),
    )
    .await?;
    if denied["isError"] != true
        || !denied["structuredContent"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("FRAME_DENIED")
    {
        return Err("keyboard input escaped into child frame".into());
    }
    checks.push("keyboard dispatch refuses focus inside a child frame".into());
    let before = ok(invoke(app, &pixels, "browser_snapshot", json!({})).await?)?;
    let upload = before["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["name"] == "Upload" && n["ref"].is_string())
        .and_then(|n| n["ref"].as_str())
        .ok_or("file input ref missing")?;
    let outside = std::env::current_exe().map_err(|e| e.to_string())?;
    expect_error(
        invoke(
            app,
            &pixels,
            "browser_files",
            json!({"ref":upload,"paths":[outside]}),
        )
        .await?,
        "PATH_DENIED",
    )?;
    let file = std::path::Path::new(&workspace).join("upload.txt");
    std::fs::write(&file, "native upload fixture").map_err(|e| e.to_string())?;
    ok(invoke(
        app,
        &pixels,
        "browser_files",
        json!({"ref":upload,"paths":[file]}),
    )
    .await?)?;
    let uploaded = ok(invoke(
        app,
        &pixels,
        "browser_wait",
        json!({"text":"Uploaded: upload.txt","timeoutMs":3000}),
    )
    .await?)?;
    if uploaded["matched"] != true {
        return Err("file upload did not reach page".into());
    }
    checks.push("workspace upload reaches input; outside files are denied".into());
    ok(invoke(
        app,
        &pixels,
        "browser_evaluate",
        json!({"expression":"setTimeout(()=>alert('Forge dialog'),100);true"}),
    )
    .await?)?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let dialog = ok(invoke(app, &pixels, "browser_dialog", json!({"action":"status"})).await?)?;
    if dialog["dialog"]["message"] != "Forge dialog" {
        return Err(format!("dialog event missing: {dialog}"));
    }
    ok(invoke(app, &pixels, "browser_dialog", json!({"action":"dismiss"})).await?)?;
    checks.push("JavaScript dialog is observed and dismissed through CDP".into());
    browser_panel_open(
        app.clone(),
        workspace.clone(),
        run.session_id.clone(),
        url.clone(),
    )
    .await?;
    let panel = browser_panel_state(app.clone(), workspace.clone()).await?;
    let human = panel["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["managed"] == false)
        .ok_or("human page missing")?["id"]
        .as_str()
        .unwrap()
        .to_string();
    let listed = ok(invoke(app, &pixels, "browser_tabs", json!({})).await?)?;
    if listed["workingTabId"] != tab_id {
        return Err("opening a human page changed the AI working tab".into());
    }
    wait_user_page(app, &workspace, &human, &url).await?;
    ok(invoke(app, &pixels, "browser_tabs", json!({"action":"select","tabId":human})).await?)?;
    ok(invoke(app, &pixels, "browser_wait", json!({"text":"Run action","timeoutMs":5000})).await?)?;
    let snapshot = ok(invoke(app, &pixels, "browser_snapshot", json!({})).await?)?;
    let action = snapshot["nodes"].as_array().unwrap().iter().find(|n| n["role"] == "button" && n["name"] == "Run action").and_then(|n| n["ref"].as_str()).ok_or("default shared page action missing")?;
    ok(invoke(app, &pixels, "browser_act", json!({"action":"click","ref":action})).await?)?;
    let result = ok(invoke(app, &pixels, "browser_wait", json!({"text":"Action complete","timeoutMs":5000})).await?)?;
    if result["matched"] != true { return Err("default shared page could not be controlled".into()); }
    // 显式撤权后导航仍保持私有；默认授权不能覆盖用户选择。
    browser_panel_grant(app.clone(), human.clone(), Grant::None).await?;
    browser_panel_navigate(app.clone(), human.clone(), url.clone()).await?;
    wait_user_page(app, &workspace, &human, &url).await?;
    let listed = ok(invoke(app, &pixels, "browser_tabs", json!({})).await?)?;
    let private = listed["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == human)
        .unwrap();
    if private.get("url").is_some() || private.get("title").is_some() {
        return Err("private page metadata leaked".into());
    }
    expect_error(
        invoke(
            app,
            &pixels,
            "browser_tabs",
            json!({"action":"select","tabId":human}),
        )
        .await?,
        "GRANT_REQUIRED",
    )?;
    // 只读选择同样必须跨用户导航保留，不能被新默认值升级成可操作。
    browser_panel_grant(app.clone(), human.clone(), Grant::Read).await?;
    let read_url = format!("{url}?shared=read");
    browser_panel_navigate(app.clone(), human.clone(), read_url.clone()).await?;
    wait_user_page(app, &workspace, &human, &read_url).await?;
    ok(invoke(app, &pixels, "browser_tabs", json!({"action":"select","tabId":human})).await?)?;
    let observed = ok(invoke(app, &pixels, "browser_snapshot", json!({})).await?)?;
    let action = observed["nodes"].as_array().unwrap().iter().find(|n| n["role"] == "button" && n["name"] == "Run action").and_then(|n| n["ref"].as_str()).ok_or("read-only page action missing")?;
    expect_error(invoke(app, &pixels, "browser_act", json!({"action":"click","ref":action})).await?, "READ_ONLY")?;
    browser_panel_grant(app.clone(), human.clone(), Grant::Control).await?;
    let same_origin = format!("{url}?shared=1");
    browser_panel_navigate(app.clone(), human.clone(), same_origin.clone()).await?;
    wait_user_page(app, &workspace, &human, &same_origin).await?;
    ok(invoke(
        app,
        &pixels,
        "browser_tabs",
        json!({"action":"select","tabId":human}),
    )
    .await?)?;
    ok(invoke(
        app,
        &pixels,
        "browser_wait",
        json!({"text":"Run action","timeoutMs":5000}),
    )
    .await?)?;
    ok(invoke(
        app,
        &pixels,
        "browser_evaluate",
        json!({"expression":"document.cookie='forge_human=private;path=/';true"}),
    )
    .await?)?;
    let cross = url.replace("127.0.0.1", "localhost");
    expect_error(
        invoke(app, &pixels, "browser_navigate", json!({"url":cross})).await?,
        "ORIGIN_REQUIRED",
    )?;
    ok(invoke(
        app,
        &pixels,
        "browser_tabs",
        json!({"action":"select","tabId":tab_id}),
    )
    .await?)?;
    let cookie = ok(invoke(
        app,
        &pixels,
        "browser_evaluate",
        json!({"expression":"document.cookie"}),
    )
    .await?)?;
    if cookie["result"]["value"]
        .as_str()
        .unwrap_or("")
        .contains("forge_human=private")
    {
        return Err("human cookies leaked to managed AI profile".into());
    }
    browser_panel_close(app.clone(), human).await?;
    checks.push("session pages default to AI control, preserve navigation grants and explicit privacy, restrict origin and isolate cookies".into());
    browser_panel_close(app.clone(), tab_id).await?;
    expect_error(
        invoke(app, &pixels, "browser_snapshot", json!({})).await?,
        "TAB_CLOSED",
    )?;
    run.request_stop();
    expect_error(
        invoke(app, &pixels, "browser_status", json!({})).await?,
        "REVOKED",
    )?;
    run.finish();
    foreign_run.finish();
    checks.push("closed working tab never falls back; stopped run is rejected".into());

    // 验证用户工具栏的真实行为；不依赖 AI run，也不通过私有状态伪造按钮成功。
    let manual = browser_panel_open(app.clone(), workspace.clone(), "manual".into(), url.clone()).await?;
    wait_user_page(app, &workspace, &manual, &url).await?;
    let user_state = browser_panel_state(app.clone(), workspace.clone()).await?;
    let page = user_state["tabs"].as_array().unwrap().iter().find(|tab| tab["id"] == manual).unwrap();
    if page["title"] != "Forge browser fixture" || page["grant"] != "none" || page["loading"] != false {
        return Err(format!("manual page state did not settle: {page}"));
    }
    let next = browser_panel_open(app.clone(), workspace.clone(), "manual".into(), url.clone()).await?;
    let order = browser_panel_state(app.clone(), workspace.clone()).await?;
    let ids = order["tabs"].as_array().unwrap().iter().filter_map(|tab|tab["id"].as_str()).collect::<Vec<_>>();
    if ids != vec![manual.as_str(), next.as_str()] { return Err("user tabs lost their creation order".into()); }
    browser_panel_close(app.clone(), next).await?;
    checks.push("standalone user page reports actual title and load completion without an AI run".into());

    verify_picker(app, &manual).await.map_err(|e|format!("picker workflow: {e}"))?;
    checks.push("native element picker and annotation panel: clipped PNG, style preview/reset, close-to-repick, session payload, failed delivery retry, narrow sidebar and native overlay visibility work".into());

    let second = format!("{url}?panel=second");
    browser_panel_navigate(app.clone(), manual.clone(), second.clone()).await?;
    wait_user_page(app, &workspace, &manual, &second).await?;
    if !browser_panel_details(app.clone(), manual.clone()).await?["picker"]["selection"].is_null() {
        return Err("navigation retained a stale element annotation".into());
    }
    checks.push("navigation invalidates the selected element and its marker".into());
    let history = browser_panel_details(app.clone(), manual.clone()).await?;
    if history["canGoBack"] != true { return Err("back button unavailable after navigation".into()); }
    browser_panel_grant(app.clone(), manual.clone(), Grant::Control).await?;
    browser_panel_command(app.clone(), manual.clone(), PanelCommand::Back).await?;
    wait_user_page(app, &workspace, &manual, &url).await?;
    let history = browser_panel_details(app.clone(), manual.clone()).await?;
    if history["canGoForward"] != true { return Err("forward button unavailable after going back".into()); }
    browser_panel_command(app.clone(), manual.clone(), PanelCommand::Forward).await?;
    wait_user_page(app, &workspace, &manual, &second).await?;
    browser_panel_command(app.clone(), manual.clone(), PanelCommand::Reload).await?;
    wait_user_page(app, &workspace, &manual, &second).await?;
    let shared = browser_panel_state(app.clone(), workspace.clone()).await?;
    if !shared["tabs"].as_array().unwrap().iter().any(|tab| tab["id"] == manual && tab["grant"] == "control") {
        return Err("same-origin history or reload unexpectedly revoked AI control".into());
    }
    browser_panel_command(app.clone(), manual.clone(), PanelCommand::Stop).await?;
    let user_state = browser_panel_state(app.clone(), workspace.clone()).await?;
    let page = user_state["tabs"].as_array().unwrap().iter().find(|tab| tab["id"] == manual).unwrap();
    if page["grant"] != "none" || page["loading"] != false { return Err("manual navigation did not revoke AI access / finish loading".into()); }
    checks.push("user history and reload preserve AI permissions; stop revokes access".into());

    browser_panel_command(app.clone(), manual.clone(), PanelCommand::Zoom { factor: 1.2 }).await?;
    if browser_panel_command(app.clone(), manual.clone(), PanelCommand::Zoom { factor: 5.0 }).await.is_ok() { return Err("toolbar zoom exceeded bounds".into()); }
    browser_panel_command(app.clone(), manual.clone(), PanelCommand::Zoom { factor: 1.0 }).await?;
    let found = browser_panel_command(app.clone(), manual.clone(), PanelCommand::Find { text: "Run action".into(), backward: false }).await?;
    let missing = browser_panel_command(app.clone(), manual.clone(), PanelCommand::Find { text: "NO_SUCH_TOOLBAR_TEXT".into(), backward: false }).await?;
    if found["found"] != true || missing["found"] != false { return Err(format!("native find failed: {found}, {missing}")); }
    for factor in [0.8, 1.2, 1.0] {
        browser_panel_command(app.clone(), manual.clone(), PanelCommand::Zoom { factor }).await?;
        verify_viewport_screenshot(app, &manual, &format!("adaptive zoom {factor}")).await?;
    }
    checks.push("user zoom applies bounded native scaling and find searches actual rendered text".into());
    // 同时出现两条滚动条，并偏离文档原点，覆盖右侧／底部留白及截图起点。
    surface::cdp(app, &manual, "Runtime.evaluate", json!({"expression":"document.documentElement.style.minHeight='2000px';document.documentElement.style.minWidth='2000px';scrollTo(350,500)"}), None, false).await?;
    for factor in [1.0, 0.8, 1.2] {
        browser_panel_command(app.clone(), manual.clone(), PanelCommand::Zoom { factor }).await?;
        verify_viewport_screenshot(app, &manual, &format!("adaptive scrolled zoom {factor}")).await?;
    }
    browser_panel_command(app.clone(), manual.clone(), PanelCommand::Zoom { factor: 1.0 }).await?;
    surface::cdp(app, &manual, "Runtime.evaluate", json!({"expression":"document.documentElement.style.minHeight='';document.documentElement.style.minWidth='';scrollTo(0,0)"}), None, false).await?;

    let screenshot = browser_panel_command(app.clone(), manual.clone(), PanelCommand::Screenshot).await?;
    let encoded = screenshot["dataUrl"].as_str().and_then(|url| url.strip_prefix("data:image/png;base64,")).ok_or("toolbar screenshot did not return a PNG data URL")?;
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).map_err(|e|e.to_string())?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Err("toolbar screenshot is not PNG".into()); }
    checks.push("user screenshot returns actual native PNG for chat and clipboard without granting AI control".into());

    let diagnostics = browser_panel_details(app.clone(), manual.clone()).await?;
    if diagnostics["console"].as_array().unwrap().is_empty() || diagnostics["network"].as_array().unwrap().is_empty() { return Err("toolbar diagnostics did not receive real page events".into()); }
    browser_panel_command(app.clone(), manual.clone(), PanelCommand::ClearConsole).await?;
    browser_panel_command(app.clone(), manual.clone(), PanelCommand::ClearNetwork).await?;
    let cleared = browser_panel_details(app.clone(), manual.clone()).await?;
    if cleared["console"] != json!([]) || cleared["network"] != json!([]) { return Err("toolbar clear did not clear diagnostic records".into()); }
    browser_panel_close(app.clone(), manual).await?;
    checks.push("user diagnostics expose real console/network records and clear them".into());
    Ok(checks)
}

/// 只探测测试 fixture 的公开浏览器属性；不改变生产环境的任意脚本授权。
async fn emulation_probe(app: &AppHandle, id: &str) -> Result<Value, String> {
    let result = surface::cdp(app, id, "Runtime.evaluate", json!({"expression":"({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,touch:navigator.maxTouchPoints,agent:navigator.userAgent,screenWidth:screen.width,orientation:screen.orientation.type,dark:matchMedia('(prefers-color-scheme: dark)').matches})","returnByValue":true}), None, false).await?;
    Ok(result["result"]["value"].clone())
}
async fn verify_emulation(app: &AppHandle, lease: &Lease, id: &str, url: &str) -> Result<(), String> {
    let original = emulation_probe(app, id).await?;
    let apply = |options| browser_panel_command(app.clone(), id.into(), PanelCommand::Emulate { options });
    apply(json!({"width":390,"height":844,"mobile":true,"touch":true,"deviceScaleFactor":3,"userAgent":"Forge Mobile Test","colorScheme":"dark"})).await?;
    browser_panel_show(app.clone(), Some(id.into()), Bounds{x:0.0,y:0.0,width:320.0,height:500.0}).await?;
    let phone = emulation_probe(app, id).await?;
    if phone["width"] != 390 || phone["height"] != 844 || phone["dpr"] != 3 || phone["touch"] != 5 || phone["agent"] != "Forge Mobile Test" || phone["dark"] != true || phone["screenWidth"] != 390 {
        return Err(format!("mobile emulation did not reach the engine: {phone}"));
    }
    expect_error(invoke(app, lease, "browser_screenshot", json!({})).await?, "GRANT_REQUIRED")?;
    let image = browser_panel_command(app.clone(), id.into(), PanelCommand::Screenshot).await?;
    let png = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, image["dataUrl"].as_str().and_then(|url|url.strip_prefix("data:image/png;base64,")).ok_or("emulated screenshot missing")?).map_err(|e|e.to_string())?;
    let width = u32::from_be_bytes(png.get(16..20).ok_or("PNG width missing")?.try_into().unwrap());
    let height = u32::from_be_bytes(png.get(20..24).ok_or("PNG height missing")?.try_into().unwrap());
    if width != 1170 || height != 2532 { return Err(format!("fitted device screenshot cropped or lost DPR: {width}x{height}")); }
    verify_viewport_screenshot(app, id, "phone").await?;
    // 触摸缩放后的可视区域小于布局视口，仍需保留当前可视范围及输出分辨率。
    surface::cdp(app, id, "Emulation.setPageScaleFactor", json!({"pageScaleFactor":1.5}), None, false).await?;
    verify_viewport_screenshot(app, id, "phone pinch zoom").await?;
    surface::cdp(app, id, "Emulation.setPageScaleFactor", json!({"pageScaleFactor":1}), None, false).await?;
    let snapshot = ok(invoke(app, lease, "browser_snapshot", json!({})).await?)?;
    let action = snapshot["nodes"].as_array().unwrap().iter().find(|n| n["name"] == "Run action" && n["role"] == "button").and_then(|n|n["ref"].as_str()).ok_or("emulated action missing")?;
    ok(invoke(app, lease, "browser_act", json!({"action":"click","ref":action})).await?)?;
    let result = ok(invoke(app, lease, "browser_wait", json!({"text":"Action complete","timeoutMs":5000})).await?)?;
    if result["matched"] != true {
        let click = surface::cdp(app, id, "Runtime.evaluate", json!({"expression":"({click:window.lastFixtureClick,scale:visualViewport.scale,target:document.querySelector('button').getBoundingClientRect().toJSON()})","returnByValue":true}), None, false).await?;
        return Err(format!("fitted mobile preview broke trusted AI click coordinates: {}",click["result"]["value"]));
    }
    let selected = pick_element(app, id, "button").await?;
    if selected["text"] != "Run action" { return Err(format!("fitted preview picker selected wrong element: {selected}")); }
    // 预览虽然缩小，元素附件仍须保持真实 CSS 尺寸 × DPR。
    let shot = browser_panel_command(app.clone(), id.into(), PanelCommand::ElementScreenshot { selection_id: selected["selectionId"].as_u64().ok_or("selection identity missing")? }).await?;
    let png = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, shot["dataUrl"].as_str().and_then(|url|url.strip_prefix("data:image/png;base64,")).ok_or("mobile element PNG missing")?).map_err(|e|e.to_string())?;
    let width = u32::from_be_bytes(png.get(16..20).ok_or("mobile element width missing")?.try_into().unwrap());
    let height = u32::from_be_bytes(png.get(20..24).ok_or("mobile element height missing")?.try_into().unwrap());
    if (width as f64 - selected["bounds"]["width"].as_f64().unwrap()*3.0).abs() > 3.0 || (height as f64 - selected["bounds"]["height"].as_f64().unwrap()*3.0).abs() > 3.0 {
        return Err(format!("mobile element screenshot lost scale or DPR: {width}x{height}, {selected}"));
    }
    browser_panel_command(app.clone(), id.into(), PanelCommand::Inspect { enabled: false }).await?;
    let snapshot = ok(invoke(app, lease, "browser_snapshot", json!({})).await?)?;
    let cover = snapshot["nodes"].as_array().unwrap().iter().find(|n|n["name"] == "Frame cover").and_then(|n|n["ref"].as_str()).ok_or("emulated frame cover missing")?;
    // 标记的截图隐藏／恢复不能污染网页 DOM 代际，已有 AI 引用仍应通过校验。
    browser_panel_command(app.clone(),id.into(),PanelCommand::Screenshot).await?;
    let denied = invoke(app, lease, "browser_act", json!({"action":"click","ref":cover})).await?;
    expect_error(denied.clone(), "DISPATCH_INTERRUPTED")?;
    if !denied["structuredContent"]["message"].as_str().unwrap_or("").contains("FRAME_DENIED") { return Err(format!("emulated frame rejection was not a frame boundary: {denied}")); }
    apply(json!({"width":844,"height":390})).await?;
    let rotated = emulation_probe(app, id).await?;
    if rotated["width"] != 844 || rotated["height"] != 390 || rotated["orientation"] != "landscape-primary" { return Err(format!("orientation did not rotate: {rotated}")); }
    apply(json!({"resetDevice":true,"width":1366,"height":768})).await?;
    let desktop = emulation_probe(app, id).await?;
    // 关闭触屏模拟恢复宿主能力；带触摸屏的 PC 本身仍可能有 maxTouchPoints。
    if desktop["width"] != 1366 || desktop["height"] != 768 || desktop["touch"] != original["touch"] || desktop["dpr"] != 1 { return Err(format!("desktop device reset failed: {desktop}")); }
    verify_viewport_screenshot(app, id, "desktop").await?;
    let tablet = ok(invoke(app, lease, "browser_emulate", json!({"width":820,"height":1180,"mobile":true,"touch":true,"deviceScaleFactor":2})).await?)?;
    if tablet["emulation"]["width"] != 820 { return Err(format!("MCP emulation state missing: {tablet}")); }
    let value = emulation_probe(app, id).await?;
    if value["width"] != 820 || value["height"] != 1180 || value["dpr"] != 2 || value["touch"] != 5 { return Err(format!("tablet emulation failed: {value}")); }
    verify_viewport_screenshot(app, id, "tablet").await?;
    browser_panel_command(app.clone(), id.into(), PanelCommand::Zoom { factor: 0.8 }).await?;
    verify_viewport_screenshot(app, id, "tablet zoom 80%").await?;
    browser_panel_command(app.clone(), id.into(), PanelCommand::Zoom { factor: 1.2 }).await?;
    verify_viewport_screenshot(app, id, "tablet zoom 120%").await?;
    browser_panel_command(app.clone(), id.into(), PanelCommand::Zoom { factor: 1.0 }).await?;
    apply(json!({"downloadMbps":0.75,"uploadMbps":0.25,"latencyMs":120})).await?;
    let workspace = host(app).lock().tabs[id].workspace.clone();
    let before = browser_panel_state(app.clone(), workspace).await?;
    let page = before["tabs"].as_array().unwrap().iter().find(|tab|tab["id"] == id).unwrap();
    if page["emulation"]["width"] != 820 || page["emulation"]["downloadMbps"] != 0.75 { return Err("network patch overwrote device state".into()); }
    for options in [json!({"width":0}),json!({"deviceScaleFactor":5}),json!({"uploadMbps":-1}),json!({"userAgent":"bad\nagent"})] {
        if apply(options).await.is_ok() { return Err("invalid emulation settings were accepted".into()); }
    }
    let fetch = "(async()=>{const start=performance.now();try{const r=await fetch('/network-probe?nonce='+Date.now(),{cache:'no-store'});return {bytes:(await r.arrayBuffer()).byteLength,elapsed:performance.now()-start,ok:true};}catch(e){return {ok:false};}})()";
    let request = || surface::cdp(app, id, "Runtime.evaluate", json!({"expression":fetch,"awaitPromise":true,"returnByValue":true}), None, false);
    let slowed = request().await?;
    let slowed = &slowed["result"]["value"];
    if slowed["ok"] != true || slowed["bytes"] != 96*1024 || slowed["elapsed"].as_f64().unwrap_or(0.0) < 350.0 { return Err(format!("network limits did not slow a real request: {slowed}")); }
    ok(invoke(app, lease, "browser_emulate", json!({"offline":true})).await?)?;
    let offline = request().await?;
    if offline["result"]["value"]["ok"] != false { return Err(format!("offline emulation allowed fetch: {offline}")); }
    apply(json!({"resetDevice":true})).await?;
    let snapshot = ok(invoke(app, lease, "browser_tabs", json!({})).await?)?;
    let page = snapshot["tabs"].as_array().unwrap().iter().find(|tab|tab["id"] == id).unwrap();
    if page["emulation"]["offline"] != true || !page["emulation"]["width"].is_null() { return Err("adaptive device reset changed network profile".into()); }
    apply(json!({"reset":true})).await?;
    let recovered = request().await?;
    if recovered["result"]["value"]["ok"] != true { return Err("network reset did not reconnect".into()); }
    let reset = emulation_probe(app, id).await?;
    if reset["agent"] != original["agent"] || reset["touch"] != original["touch"] || reset["dpr"] != original["dpr"] { return Err(format!("device reset left overrides: {reset}")); }
    apply(json!({"width":390,"height":844,"mobile":true,"touch":true})).await?;
    browser_panel_command(app.clone(), id.into(), PanelCommand::Reload).await?;
    let workspace = host(app).lock().tabs[id].workspace.clone();
    wait_user_page(app, &workspace, id, url).await?;
    let after_reload = emulation_probe(app, id).await?;
    if after_reload["width"] != 390 { return Err("reload lost device emulation".into()); }
    let other = browser_panel_open(app.clone(), workspace.clone(), "manual".into(), url.into()).await?;
    let pages = browser_panel_state(app.clone(), workspace).await?;
    let other_state = pages["tabs"].as_array().unwrap().iter().find(|tab|tab["id"] == other).unwrap();
    if !other_state["emulation"]["width"].is_null() || other_state["emulation"]["offline"] != false { return Err("emulation leaked across tabs".into()); }
    browser_panel_close(app.clone(), other).await?;
    apply(json!({"reset":true})).await?;
    browser_panel_show(app.clone(), Some(id.into()), Bounds{x:0.0,y:0.0,width:800.0,height:600.0}).await?;
    browser_panel_show(app.clone(), None, Bounds{x:0.0,y:0.0,width:1.0,height:1.0}).await?;
    Ok(())
}

/// 整张 PNG 的边缘必须是网页像素；仅断言尺寸发现不了缩小预览产生的白边。
async fn verify_viewport_screenshot(app: &AppHandle, id: &str, label: &str) -> Result<(), String> {
    // 引擎高亮随截图的临时视口重新定位，像素比较只检查网页本身。
    surface::cdp(app, id, "Overlay.hideHighlight", json!({}), None, false).await?;
    // 原生 zoom 返回只表示派发完成；等布局与合成帧更新后再验证截图结果。
    surface::cdp(app, id, "Runtime.evaluate", json!({"expression":"new Promise(requestAnimationFrame)","awaitPromise":true}), None, false).await?;
    let metrics = surface::cdp(app, id, "Page.getLayoutMetrics", json!({}), None, false).await?;
    let viewport = &metrics["cssVisualViewport"];
    let center = json!({"x":viewport["pageX"].as_f64().ok_or("viewport x missing")? + viewport["clientWidth"].as_f64().ok_or("viewport width missing")?/2.0,
        "y":viewport["pageY"].as_f64().ok_or("viewport y missing")? + viewport["clientHeight"].as_f64().ok_or("viewport height missing")?/2.0});
    // 用引擎的 CSS 文档坐标放置中心标记；原生缩放时 JS visualViewport 混用 DIP。
    let paint = r#"async function(center){
        const root=document.documentElement;
        window.screenshotProbe=document.createElement('div');
        screenshotProbe.style.cssText=`position:absolute;left:0;top:0;width:${root.scrollWidth}px;height:${root.scrollHeight}px;background:rgb(18,52,86);z-index:2147483647;pointer-events:none`;
        const marker=document.createElement('div');
        marker.style.cssText=`position:absolute;left:${center.x-10}px;top:${center.y-10}px;width:20px;height:20px;background:rgb(200,30,60)`;
        screenshotProbe.append(marker);root.append(screenshotProbe);
        await new Promise(requestAnimationFrame);
    }"#;
    surface::cdp(app, id, "Runtime.evaluate", json!({"expression":format!("({paint})({center})"),"awaitPromise":true}), None, false).await?;
    // 参考图也只包含网页像素；持久选中框在截图前隐藏、截图后恢复。
    let reference = picker::capture(app, id, json!({"format":"png","captureBeyondViewport":false}), None, false).await?;
    let reference_url = format!("data:image/png;base64,{}",reference["data"].as_str().ok_or("reference PNG missing")?);
    let shot = browser_panel_command(app.clone(), id.into(), PanelCommand::Screenshot).await?;
    let metrics = surface::cdp(app, id, "Page.getLayoutMetrics", json!({}), None, false).await?;
    let data_url = shot["dataUrl"].as_str().ok_or("viewport screenshot missing")?;
    // 在隔离 fixture 中解码实际 PNG，不增加生产图片处理依赖，也不检查实现文本。
    let compare = r#"async function(actual, reference){
        const decode=async(url)=>{const image=new Image();image.src=url;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return {c,ctx};};
        const {c,ctx}=await decode(actual), baseline=await decode(reference);
        const width=c.width, height=c.height;
        const pixels=[[2,2],[width-3,2],[2,height-3],[width-3,height-3]].map(([x,y])=>Array.from(ctx.getImageData(x,y,1,1).data));
        let matchesViewport=baseline.c.width>=width && baseline.c.height>=height;
        if(matchesViewport){
            const a=ctx.getImageData(0,0,width,height).data, b=baseline.ctx.getImageData(0,0,width,height).data;
            // 比较整个内容，包括文档上的位置标记；略过一圈缩放舍入可能影响的边缘。
            outer:for(let y=2;y<height-2;y++)for(let x=2;x<width-2;x++)for(let k=0;k<4;k++){
                const i=(y*width+x)*4+k;if(a[i]!==b[i]){matchesViewport=false;break outer;}
            }
        }
        return {width,height,pixels,matchesViewport};
    }"#;
    let probe = surface::cdp(app, id, "Runtime.evaluate", json!({"expression":format!("({compare})({},{})",json!(data_url),json!(reference_url)),"awaitPromise":true,"returnByValue":true}), None, false).await?;
    let pixels = &probe["result"]["value"];
    let device = emulation_probe(app, id).await?;
    let viewport = &metrics["cssVisualViewport"];
    let ratio = device["dpr"].as_f64().ok_or("screenshot DPR missing")? * viewport["scale"].as_f64().ok_or("screenshot scale missing")?;
    for (dimension, key) in [("width", "clientWidth"), ("height", "clientHeight")] {
        let expected = viewport[key].as_f64().ok_or("screenshot viewport missing")? * ratio;
        if (pixels[dimension].as_f64().ok_or("PNG dimensions missing")? - expected).abs() > 2.0 {
            return Err(format!("{label} screenshot does not match visible viewport: {pixels}; metrics={metrics}; DPR={}",device["dpr"]));
        }
    }
    if pixels["pixels"] != json!([[18,52,86,255],[18,52,86,255],[18,52,86,255],[18,52,86,255]]) || pixels["matchesViewport"] != true {
        // 失败时仅把隔离 fixture 的诊断图写到本次 TEMP，便于核对引擎裁剪坐标。
        let root = std::env::var("FORGE_BROWSER_SMOKE_ROOT").map_err(|e|e.to_string())?;
        let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data_url.strip_prefix("data:image/png;base64,").ok_or("PNG prefix missing")?).map_err(|e|e.to_string())?;
        std::fs::write(std::path::Path::new(&root).join("viewport-failure.png"), bytes).map_err(|e|e.to_string())?;
        return Err(format!("{label} screenshot includes pixels outside visible page: {pixels}; metrics={metrics}"));
    }
    surface::cdp(app, id, "Runtime.evaluate", json!({"expression":"screenshotProbe.remove();delete window.screenshotProbe"}), None, false).await?;
    picker::restore_highlight(app, id).await?;
    Ok(())
}

// 断言最终网页像素，而不是仅检查 selection 状态或高亮命令返回成功。
async fn verify_selection_marker(app: &AppHandle, id: &str, selection: &Value, stage: &str, visible: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    tokio::time::sleep(Duration::from_millis(120)).await;
    let main=app.get_webview_window("main").ok_or("main window missing")?;
    let window_size=main.inner_size().map_err(|e|e.to_string())?;
    let hwnd=main.hwnd().map_err(|e|e.to_string())?.0 as usize;
    let scale=main.scale_factor().map_err(|e|e.to_string())?;
    let tab=panel_tab(app,id)?;
    let bounds=tab.emulation.bounds(&tab.preview_bounds);
    let root=std::path::PathBuf::from(std::env::var("FORGE_BROWSER_SMOKE_ROOT").map_err(|e|e.to_string())?);
    let path=root.join(format!("selection-{stage}.png"));
    let output=path.clone();
    // PrintWindow 捕获指定原生窗口的合成内容，不依赖前台窗口或屏幕是否被其他窗口遮挡。
    tokio::task::spawn_blocking(move || {
        let result=std::process::Command::new("powershell.exe").creation_flags(0x08000000)
            .args(["-NoProfile","-NonInteractive","-Command",r#"$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class ForgeWindowCapture { [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags); }
'@
$bitmap=New-Object Drawing.Bitmap([int]$env:FORGE_WINDOW_W,[int]$env:FORGE_WINDOW_H); $graphics=[Drawing.Graphics]::FromImage($bitmap); $dc=$graphics.GetHdc()
try { if(-not [ForgeWindowCapture]::PrintWindow([IntPtr]([long]$env:FORGE_WINDOW_HANDLE),$dc,3)) { throw 'PrintWindow failed' } } finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
$crop=$bitmap.Clone((New-Object Drawing.Rectangle([int]$env:FORGE_SHOT_X,[int]$env:FORGE_SHOT_Y,[int]$env:FORGE_SHOT_W,[int]$env:FORGE_SHOT_H)),$bitmap.PixelFormat)
try { $crop.Save($env:FORGE_SHOT_PATH,[Drawing.Imaging.ImageFormat]::Png) } finally { $crop.Dispose(); $bitmap.Dispose() }"#])
            .env("FORGE_WINDOW_HANDLE",hwnd.to_string())
            .env("FORGE_WINDOW_W",window_size.width.to_string())
            .env("FORGE_WINDOW_H",window_size.height.to_string())
            .env("FORGE_SHOT_X",(bounds.x*scale).round().to_string())
            .env("FORGE_SHOT_Y",(bounds.y*scale).round().to_string())
            .env("FORGE_SHOT_W",(bounds.width*scale).round().to_string())
            .env("FORGE_SHOT_H",(bounds.height*scale).round().to_string())
            .env("FORGE_SHOT_PATH",output).output().map_err(|e|e.to_string())?;
        if !result.status.success(){return Err(String::from_utf8_lossy(&result.stderr).into_owned());}Ok::<_,String>(())
    }).await.map_err(|e|e.to_string())??;
    let data=base64::Engine::encode(&base64::engine::general_purpose::STANDARD,std::fs::read(path).map_err(|e|e.to_string())?);
    let b=&selection["bounds"];
    let factor=scale*tab.preview_scale*tab.zoom;
    let region=json!({"x":b["x"].as_f64().unwrap()*factor,"y":b["y"].as_f64().unwrap()*factor,"width":b["width"].as_f64().unwrap()*factor,"height":b["height"].as_f64().unwrap()*factor});
    let expression=format!(r#"(async()=>{{const image=new Image();image.src={};await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const p=ctx.getImageData(0,0,canvas.width,canvas.height).data,b={};let blue=0;for(let y=Math.max(0,Math.floor(b.y-4));y<Math.min(canvas.height,b.y+b.height+4);y++)for(let x=Math.max(0,Math.floor(b.x-4));x<Math.min(canvas.width,b.x+b.width+4);x++){{if(x>b.x+3&&x<b.x+b.width-3&&y>b.y+3&&y<b.y+b.height-3)continue;const i=(y*canvas.width+x)*4;if(p[i]>65&&p[i]<110&&p[i+1]>100&&p[i+1]<155&&p[i+2]>220)blue++;}}return blue;}})()"#,json!(format!("data:image/png;base64,{data}")),region);
    let pixels=surface::cdp(app,id,"Runtime.evaluate",json!({"expression":expression,"awaitPromise":true,"returnByValue":true}),None,false).await?;
    let blue=pixels["result"]["value"].as_u64().ok_or("marker pixel count missing")?;
    // 至少覆盖约一半边框，防止原生评论窗口遮住元素后只露出一条边仍被当作通过。
    let minimum=((b["width"].as_f64().unwrap()+b["height"].as_f64().unwrap())*factor*2.0).max(20.0) as u64;
    if (blue>=minimum)!=visible {
        let page=surface::cdp(app,id,"Page.captureScreenshot",json!({"format":"png","captureBeyondViewport":false}),None,false).await?;
        let bytes=base64::Engine::decode(&base64::engine::general_purpose::STANDARD,page["data"].as_str().ok_or("page PNG missing")?).map_err(|e|e.to_string())?;
        std::fs::write(root.join(format!("selection-{stage}-page.png")),bytes).map_err(|e|e.to_string())?;
        return Err(format!("selected element marker visibility expected {visible} after {stage}: {pixels}"));
    }
    Ok(())
}

async fn verify_picker(app: &AppHandle, id: &str) -> Result<(), String> {
    let main=app.get_webview_window("main").ok_or("main window missing")?;
    main.show().map_err(|e|e.to_string())?;
    main.set_focus().map_err(|e|e.to_string())?;
    let selected = pick_element(app, id, "button").await?;
    if selected["tag"] != "button" || selected["text"] != "Run action" || selected["selector"].as_str().unwrap_or("").is_empty() || selected["bounds"]["width"].as_i64().unwrap_or(0) <= 0 {
        return Err(format!("native click did not select element metadata: {selected}"));
    }
    let action = surface::cdp(app, id, "Runtime.evaluate", json!({"expression":"document.getElementById('result').textContent","returnByValue":true}), None, false).await?;
    if action["result"]["value"] != "Waiting" { return Err("selecting an element triggered its page action".into()); }
    // 鼠标离开选中元素后，普通点击必须交给网页，证明引擎确实退出了悬停选取。
    browser_panel_show(app.clone(), Some(id.into()), Bounds{x:0.0,y:0.0,width:800.0,height:600.0}).await?;
    surface::cdp(app, id, "Input.dispatchMouseEvent", json!({"type":"mouseMoved","x":700,"y":350}), None, false).await?;
    verify_selection_marker(app,id,&selected,"pointer-leave",true).await?;
    let x = selected["bounds"]["x"].as_f64().unwrap() + selected["bounds"]["width"].as_f64().unwrap()/2.0;
    let y = selected["bounds"]["y"].as_f64().unwrap() + selected["bounds"]["height"].as_f64().unwrap()/2.0;
    for kind in ["mouseMoved", "mousePressed", "mouseReleased"] {
        let mut params = json!({"type":kind,"x":x,"y":y});
        if kind != "mouseMoved" { params["button"] = json!("left"); params["clickCount"] = json!(1); }
        surface::cdp(app, id, "Input.dispatchMouseEvent", params, None, false).await?;
    }
    let action = surface::cdp(app, id, "Runtime.evaluate", json!({"expression":"document.getElementById('result').textContent","returnByValue":true}), None, false).await?;
    if action["result"]["value"] != "Action complete" { return Err("engine stayed in inspect mode after selecting an element".into()); }
    if browser_panel_details(app.clone(), id.into()).await?["picker"]["selection"] != selected { return Err("moving the pointer discarded selected element".into()); }
    // 开始重选、取消和备注面板引起的 resize 都不能丢掉原标记。
    browser_panel_command(app.clone(), id.into(), PanelCommand::Inspect { enabled: true }).await?;
    browser_panel_command(app.clone(), id.into(), PanelCommand::Inspect { enabled: false }).await?;
    browser_panel_show(app.clone(), Some(id.into()), Bounds{x:0.0,y:0.0,width:800.0,height:400.0}).await?;
    if browser_panel_details(app.clone(), id.into()).await?["picker"]["selection"] != selected {
        return Err("canceling repick or resizing discarded the selected element".into());
    }
    verify_selection_marker(app,id,&selected,"cancel-repick-resize",true).await?;
    // 右上角叉号是取消当前标记并连续选取，不是收起面板；用真实指针覆盖 UI 与窄 IPC。
    let close = annotation::probe(app,"(() => {const r=document.getElementById('close').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()".into()).await?;
    annotation::pointer_click(app,close["x"].as_f64().ok_or("close x missing")?,close["y"].as_f64().ok_or("close y missing")?).await?;
    let mut repicking=false;
    for _ in 0..80 {
        let details=browser_panel_details(app.clone(),id.into()).await?;
        if details["picker"]["active"]==true && details["picker"]["selection"].is_null() {repicking=true;break;}
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if !repicking {return Err("annotation close did not clear the selection and resume picking".into());}
    verify_selection_marker(app,id,&selected,"close-repick",false).await?;
    // 此处禁止再次发送 Inspect 命令：直接点页面仍能选中，才证明用户不必重按工具栏箭头。
    let selected = pick_element_while_active(app,id,"button").await?;
    let selection_id = selected["selectionId"].as_u64().ok_or("selection identity missing")?;
    // 从前端相同的 JSON 边界进入命令，覆盖 serde 字段命名与真实 PNG 裁剪。
    let command: PanelCommand = serde_json::from_value(json!({"action":"elementScreenshot","selectionId":selection_id})).map_err(|e|e.to_string())?;
    let shot = browser_panel_command(app.clone(), id.into(), command).await?;
    let png = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, shot["dataUrl"].as_str().and_then(|url|url.strip_prefix("data:image/png;base64,")).ok_or("element screenshot missing")?).map_err(|e|e.to_string())?;
    let width = u32::from_be_bytes(png.get(16..20).ok_or("element PNG width missing")?.try_into().unwrap());
    let height = u32::from_be_bytes(png.get(20..24).ok_or("element PNG height missing")?.try_into().unwrap());
    let dpr = emulation_probe(app, id).await?["dpr"].as_f64().ok_or("DPR missing")?;
    if (width as f64 - selected["bounds"]["width"].as_f64().unwrap()*dpr).abs() > 2.0 || (height as f64 - selected["bounds"]["height"].as_f64().unwrap()*dpr).abs() > 2.0 {
        return Err(format!("element PNG did not crop to selected bounds: {width}x{height}, {selected}"));
    }
    if browser_panel_details(app.clone(), id.into()).await?["picker"]["selection"] != selected { return Err("screenshot cleared element before delivery".into()); }
    verify_selection_marker(app,id,&selected,"element-screenshot",true).await?;
    verify_annotation(app, id, selection_id).await?;
    browser_panel_command(app.clone(), id.into(), PanelCommand::ClearSelection { selection_id }).await?;
    let clear = browser_panel_details(app.clone(), id.into()).await?;
    if clear["picker"]["active"] != false || !clear["picker"]["selection"].is_null() { return Err("clear selection failed".into()); }
    browser_panel_command(app.clone(), id.into(), PanelCommand::Inspect { enabled: true }).await?;
    browser_panel_command(app.clone(), id.into(), PanelCommand::Inspect { enabled: false }).await?;
    if browser_panel_details(app.clone(), id.into()).await?["picker"]["active"] != false { return Err("explicit cancel failed".into()); }
    // 页面滚动后的元素截图必须使用文档坐标，不能把视口坐标当成整页坐标。
    surface::cdp(app, id, "Runtime.evaluate", json!({"expression":"document.documentElement.style.minHeight='2000px';document.querySelector('button').style.marginTop='500px';scrollTo(0,480)"}), None, false).await?;
    let scrolled = pick_element(app, id, "button").await?;
    let scrolled_shot = browser_panel_command(app.clone(), id.into(), PanelCommand::ElementScreenshot { selection_id: scrolled["selectionId"].as_u64().unwrap() }).await?;
    if !scrolled_shot["dataUrl"].as_str().is_some_and(|url|url.starts_with("data:image/png;base64,")) { return Err("scrolled element screenshot missing".into()); }
    surface::cdp(app, id, "Runtime.evaluate", json!({"expression":"document.documentElement.style.minHeight='';document.querySelector('button').style.marginTop='';scrollTo(0,0)"}), None, false).await?;
    surface::cdp(app, id, "Runtime.evaluate", json!({"expression":"document.querySelector('input').value='PICKER_FORM_SECRET'; document.getElementById('result').innerHTML='<span>Visible label</span><textarea>PICKER_EDIT_SECRET</textarea><span hidden>PICKER_HIDDEN_SECRET</span>';"}), None, false).await?;
    let field = pick_element(app, id, "input[aria-label=Name]").await?;
    if field["tag"] != "input" || field["text"] != "" || field.get("value").is_some() { return Err(format!("picker leaked form data: {field}")); }
    // 留下一份真实标记，让后续导航回归能发现未清理的旧文档数据。
    let container = pick_element(app, id, "#result").await?;
    if container["tag"] != "p" || container["text"] != "Visible label" { return Err(format!("container selection leaked hidden or editable content: {container}")); }
    browser_panel_command(app.clone(), id.into(), PanelCommand::ClearSelection { selection_id: field["selectionId"].as_u64().unwrap() }).await?;
    if browser_panel_details(app.clone(), id.into()).await?["picker"]["selection"] != container { return Err("stale delivery cleared newer selection".into()); }
    if browser_panel_command(app.clone(), id.into(), PanelCommand::ElementScreenshot { selection_id }).await.is_ok() { return Err("stale selection screenshot was accepted".into()); }
    Ok(())
}

async fn verify_annotation(app: &AppHandle, id: &str, selection_id: u64) -> Result<(), String> {
    use tauri::Listener;
    let selected=panel_tab(app,id)?.picker.selection.ok_or("annotation selection missing")?;
    // 真正操作本地原生面板，覆盖 UI → 窄 IPC → 页面预览 → 会话事件与失败恢复。
    let mut ready = false;
    for _ in 0..80 {
        let value = annotation::probe(app, "typeof window.renderAnnotation === 'function' && document.getElementById('selector').textContent.length > 0".into()).await?;
        if value == true { ready=true;break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    if !ready {
        let diagnostic=annotation::probe(app,"({ready:document.readyState,url:location.href,render:typeof window.renderAnnotation,body:document.body?.innerText.slice(0,500)})".into()).await?;
        return Err(format!("annotation panel did not render selected element: {diagnostic}"));
    }
    let root=std::path::PathBuf::from(std::env::var("FORGE_BROWSER_SMOKE_ROOT").map_err(|e|e.to_string())?);
    std::fs::write(root.join("annotation-compact.png"),annotation::capture(app).await?).map_err(|e|e.to_string())?;
    annotation::probe(app,"document.getElementById('comment').focus();true".into()).await?;
    verify_selection_marker(app,id,&selected,"comment-focus",true).await?;
    annotation::probe(app, "document.getElementById('toggle').click();true".into()).await?;
    for _ in 0..60 {
        if annotation::probe(app, "document.getElementById('toggle').getAttribute('aria-expanded')".into()).await? == "true" {break;}
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // 保留原有 important 和其他内联属性，恢复不能覆盖网页在预览期间的新修改。
    surface::cdp(app,id,"Runtime.evaluate",json!({"expression":"document.querySelector('button').style.setProperty('color','rgb(10, 20, 30)','important')"}),None,false).await?;
    annotation::probe(app, "(() => { const input=document.querySelector('[data-property=color]');input.value='rgb(220, 30, 40)';input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()".into()).await?;
    let mut applied = false;
    for _ in 0..80 {
        let details=browser_panel_details(app.clone(),id.into()).await?;
        if details["picker"]["selection"]["styleChanges"]["color"]["after"] == "rgb(220, 30, 40)" {applied=true;break;}
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if !applied {return Err("annotation color preview did not reach webpage".into());}
    let rejected_frame=pick_element(app,id,"iframe").await;
    if rejected_frame.is_ok() {return Err("unsupported iframe selection was accepted".into());}
    let retained_color=surface::cdp(app,id,"Runtime.evaluate",json!({"expression":"getComputedStyle(document.querySelector('button')).color","returnByValue":true}),None,false).await?;
    if retained_color["result"]["value"] != "rgb(220, 30, 40)" {return Err("failed repick rolled back original annotation preview".into());}
    let image=annotation::capture(app).await?;
    std::fs::write(root.join("annotation-expanded.png"),image).map_err(|e|e.to_string())?;
    // 原生窗口的隐藏／重新呈现属于交互契约，不能只检查 React 的显示状态。
    annotation::probe(app,"(() => {const input=document.getElementById('comment');input.value='保留这份评论';input.dispatchEvent(new Event('input'));return true;})()".into()).await?;
    // Esc 和底部收起按钮只收起评论，不能在发送前移除选中框或草稿。
    for action in ["document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true", "document.getElementById('cancel').click();true"] {
        annotation::probe(app,action.into()).await?;
        let mut minimized=false;
        for _ in 0..60 {
            if annotation::probe(app,"document.body.classList.contains('minimized')".into()).await?==true {minimized=true;break;}
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        if !minimized || panel_tab(app,id)?.picker.selection.as_ref().and_then(|s|s["selectionId"].as_u64())!=Some(selection_id) {return Err("closing annotation discarded selection instead of minimizing".into());}
        verify_selection_marker(app,id,&selected,"minimized-comment",true).await?;
        annotation::probe(app,"document.getElementById('resume').click();true".into()).await?;
        for _ in 0..60 {
            if annotation::probe(app,"document.body.classList.contains('minimized')".into()).await?==false {break;}
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        if annotation::probe(app,"document.getElementById('comment').value".into()).await?!="保留这份评论" {return Err("minimizing annotation lost comment draft".into());}
    }
    browser_panel_show(app.clone(),None,Bounds{x:0.0,y:0.0,width:1.0,height:1.0}).await?;
    if annotation::geometry(app).await?["visible"] != false {return Err("annotation remained over host overlay after page hidden".into());}
    browser_panel_show(app.clone(),Some(id.into()),Bounds{x:100.0,y:80.0,width:320.0,height:360.0}).await?;
    let geometry=annotation::geometry(app).await?;
    let n=|key:&str|geometry[key].as_f64().unwrap_or(f64::INFINITY);
    if geometry["visible"] != true || n("x")<100.0 || n("y")<80.0 || n("x")+n("width")>421.0 || n("y")+n("height")>441.0 {return Err(format!("annotation escaped narrow sidebar: {geometry}"));}
    if annotation::probe(app,"document.getElementById('comment').value".into()).await? != "保留这份评论" {return Err("hiding annotation discarded comment".into());}
    browser_panel_show(app.clone(),Some(id.into()),Bounds{x:0.0,y:0.0,width:800.0,height:400.0}).await?;
    let main=app.get_webview_window("main").ok_or("main window missing")?;
    let submitted=Arc::new(Mutex::new(None::<Value>));
    let sink=submitted.clone();
    let listener=main.listen("forge-browser-annotation-submit",move |event| { *sink.lock().unwrap()=serde_json::from_str(event.payload()).ok(); });
    // 原生 set_bounds 返回时渲染器可能仍是旧侧栏尺寸；等视口同步后再计算点击坐标。
    let expected=annotation::geometry(app).await?;
    let mut resized=false;
    for _ in 0..80 {
        let viewport=annotation::probe(app,"({width:innerWidth,height:innerHeight})".into()).await?;
        if (viewport["width"].as_f64().unwrap_or(0.0)-expected["width"].as_f64().unwrap_or(-10.0)).abs()<=1.0 && (viewport["height"].as_f64().unwrap_or(0.0)-expected["height"].as_f64().unwrap_or(-10.0)).abs()<=1.0 {resized=true;break;}
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if !resized {return Err(format!("annotation viewport did not settle after sidebar resize: {expected}"));}
    // 评论可选；通过实际指针命中按钮验证 UI、IPC 和会话载荷，发送中不能重复投递。
    let point=annotation::probe(app,"(() => {document.addEventListener('click',event=>{window.lastAnnotationClick={id:event.target.closest('button')?.id,trusted:event.isTrusted};},true);const input=document.getElementById('comment');input.value='';input.dispatchEvent(new Event('input'));const r=document.getElementById('send').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()".into()).await?;
    annotation::pointer_click(app,point["x"].as_f64().ok_or("send x missing")?,point["y"].as_f64().ok_or("send y missing")?).await?;
    let mut empty_payload=None;
    for _ in 0..80 {
        empty_payload=submitted.lock().unwrap().take();if empty_payload.is_some(){break;}
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let empty_payload=match empty_payload {
        Some(payload)=>payload,
        None=>{
            std::fs::write(root.join("annotation-send-failed.png"),annotation::capture(app).await?).map_err(|e|e.to_string())?;
            let diagnostic=annotation::probe(app,"({click:window.lastAnnotationClick,disabled:document.getElementById('send').disabled,error:document.getElementById('error').textContent,button:document.getElementById('send').getBoundingClientRect().toJSON(),width:innerWidth,height:innerHeight})".into()).await?;
            return Err(format!("empty comment blocked native send button: point={point}, observation={diagnostic}"));
        }
    };
    if empty_payload["problem"]!="" || empty_payload["selection"]["selectionId"]!=selection_id {return Err(format!("empty comment lost selected element: {empty_payload}"));}
    annotation::pointer_click(app,point["x"].as_f64().unwrap(),point["y"].as_f64().unwrap()).await?;
    tokio::time::sleep(Duration::from_millis(80)).await;
    if submitted.lock().unwrap().is_some() {return Err("annotation submitted twice while delivery pending".into());}
    let empty_failure:PanelCommand=serde_json::from_value(json!({"action":"annotationResult","selectionId":selection_id,"error":"附件数量已满"})).map_err(|e|e.to_string())?;
    browser_panel_command(app.clone(),id.into(),empty_failure).await?;
    if annotation::probe(app,"document.getElementById('send').disabled".into()).await?!=false {return Err("empty comment could not retry after failed delivery".into());}
    annotation::probe(app,"(() => {const input=document.getElementById('comment');input.value='修复颜色，按预览修改';input.dispatchEvent(new Event('input'));return true;})()".into()).await?;
    annotation::pointer_click(app,point["x"].as_f64().unwrap(),point["y"].as_f64().unwrap()).await?;
    let mut payload=None;
    for _ in 0..80 {
        payload=submitted.lock().unwrap().clone();if payload.is_some(){break;}
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let payload=payload.ok_or("annotation did not deliver a session event")?;
    if payload["problem"] != "修复颜色，按预览修改" || payload["selection"]["selectionId"] != selection_id || payload["selection"]["styleChanges"]["color"]["before"] != "rgb(10, 20, 30)" {return Err(format!("annotation payload lost comment or style delta: {payload}"));}
    let failure:PanelCommand=serde_json::from_value(json!({"action":"annotationResult","selectionId":selection_id,"error":"附件数量已满"})).map_err(|e|e.to_string())?;
    browser_panel_command(app.clone(),id.into(),failure).await?;
    let retained=annotation::probe(app,"({comment:document.getElementById('comment').value,disabled:document.getElementById('send').disabled,error:document.getElementById('error').textContent})".into()).await?;
    if retained != json!({"comment":"修复颜色，按预览修改","disabled":false,"error":"附件数量已满"}) {return Err(format!("failed annotation lost draft or blocked retry: {retained}"));}
    verify_selection_marker(app,id,&selected,"delivery-failure",true).await?;
    annotation::probe(app,"document.getElementById('reset').click();true".into()).await?;
    for _ in 0..80 {
        if browser_panel_details(app.clone(),id.into()).await?["picker"]["selection"]["styleChanges"].is_null(){break;}
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let restored=surface::cdp(app,id,"Runtime.evaluate",json!({"expression":"({color:document.querySelector('button').style.color,priority:document.querySelector('button').style.getPropertyPriority('color')})","returnByValue":true}),None,false).await?;
    if restored["result"]["value"] != json!({"color":"rgb(10, 20, 30)","priority":"important"}) {return Err(format!("annotation reset lost original inline priority: {restored}"));}
    // 非法 CSS 必须拒绝，不能导致其他属性产生部分修改。
    annotation::probe(app,"(() => {const input=document.querySelector('[data-property=color]');input.value='not-a-color';input.dispatchEvent(new Event('change'));return true;})()".into()).await?;
    let mut rejected=false;
    for _ in 0..80 {
        if annotation::probe(app,"document.getElementById('error').textContent.length>0".into()).await? == true {rejected=true;break;}
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if !rejected {return Err("invalid annotation CSS was not reported".into());}
    annotation::probe(app,"(() => {const input=document.querySelector('[data-property=color]');input.value='rgb(50, 60, 70)';input.dispatchEvent(new Event('change'));return true;})()".into()).await?;
    for _ in 0..80 {
        if browser_panel_details(app.clone(),id.into()).await?["picker"]["selection"]["styleChanges"]["color"]["after"] == "rgb(50, 60, 70)" {break;}
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let success:PanelCommand=serde_json::from_value(json!({"action":"annotationResult","selectionId":selection_id,"error":null})).map_err(|e|e.to_string())?;
    browser_panel_command(app.clone(),id.into(),success).await?;
    main.unlisten(listener);
    let committed=surface::cdp(app,id,"Runtime.evaluate",json!({"expression":"document.querySelector('button').style.color","returnByValue":true}),None,false).await?;
    if committed["result"]["value"] != "rgb(50, 60, 70)" || !browser_panel_details(app.clone(),id.into()).await?["picker"]["selection"].is_null() {return Err("successful annotation did not commit preview and clear selection".into());}
    verify_selection_marker(app,id,&selected,"delivery-success",false).await?;
    Ok(())
}

async fn pick_element(app: &AppHandle, id: &str, selector: &str) -> Result<Value, String> {
    pick_element_with_mode(app,id,selector,true).await
}

async fn pick_element_while_active(app: &AppHandle, id: &str, selector: &str) -> Result<Value, String> {
    pick_element_with_mode(app,id,selector,false).await
}

async fn pick_element_with_mode(app: &AppHandle, id: &str, selector: &str, enable: bool) -> Result<Value, String> {
    let target = surface::cdp(app, id, "Runtime.evaluate", json!({"expression":format!("(() => {{ const r = document.querySelector({}).getBoundingClientRect(); return {{x:r.x+r.width/2,y:r.y+r.height/2}}; }})()", json!(selector)),"returnByValue":true}), None, false).await?;
    let point = &target["result"]["value"];
    let previous = browser_panel_details(app.clone(), id.into()).await?["picker"]["selection"]["selectionId"].clone();
    if enable { browser_panel_command(app.clone(), id.into(), PanelCommand::Inspect { enabled: true }).await?; }
    for kind in ["mouseMoved", "mousePressed", "mouseReleased"] {
        // 与用户点击同一预览坐标；Overlay 应选中相应 CSS 元素。
        let scale = host(app).lock().tabs[id].preview_scale;
        let mut params = json!({"type":kind,"x":point["x"].as_f64().unwrap()*scale,"y":point["y"].as_f64().unwrap()*scale});
        if kind != "mouseMoved" { params["button"] = json!("left"); params["clickCount"] = json!(1); }
        surface::cdp(app, id, "Input.dispatchMouseEvent", params, None, false).await?;
    }
    let mut selected = Value::Null;
    for _ in 0..100 {
        let details = browser_panel_details(app.clone(), id.into()).await?;
        if let Some(error) = details["picker"]["error"].as_str() { return Err(format!("element picker: {error}")); }
        if details["picker"]["selection"].is_object() && details["picker"]["selection"]["selectionId"] != previous { selected = details["picker"]["selection"].clone(); break; }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    if selected.is_null() { return Err(format!("element picker did not select {selector}")); }
    Ok(selected)
}

async fn wait_user_page(app: &AppHandle, workspace: &str, id: &str, url: &str) -> Result<(), String> {
    for _ in 0..100 {
        let state = browser_panel_state(app.clone(), workspace.into()).await?;
        if state["tabs"].as_array().unwrap().iter().any(|tab| tab["id"] == id && tab["url"] == url && tab["loading"] == false && tab["title"] == "Forge browser fixture") { return Ok(()); }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    Err(format!("user page failed to settle at {url}"))
}
