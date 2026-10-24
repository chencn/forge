use super::process::{Input, Process};
use crate::ai_cli::{self, Provider};
use serde_json::{json, Value};
use serde::Deserialize;
use std::time::{Duration, Instant};
use std::path::Path;
use std::sync::Mutex;

// 仅串行化 JSON 读改写；绝不能在此锁内启动 CLI 或等待网络。
static CATALOG_FILE: Mutex<()> = Mutex::new(());

/// 只投影本地项目信任字段，不把完整 TOML 或凭据传给前端。
pub fn codex_project_trusted(workspace: &str) -> bool {
    let home = std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from).or_else(|| {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(|p| std::path::PathBuf::from(p).join(".codex"))
    });
    let Some(home) = home else { return false; };
    let Some(config) = std::fs::read_to_string(home.join("config.toml")).ok().and_then(|s| s.parse::<toml::Value>().ok()) else { return false; };
    // cwd 显式 untrusted/未指定优先于仓库根，不能任意向父目录继承信任。
    if let Some(value) = project_trust(&config, workspace) { return value; }
    git_trust_root(Path::new(workspace)).is_some_and(|root| project_trusted(&config, &root.to_string_lossy()))
}
fn project_trusted(config: &toml::Value, workspace: &str) -> bool {
    project_trust(config, workspace).unwrap_or(false)
}
fn project_trust(config: &toml::Value, workspace: &str) -> Option<bool> {
    let projects = config.get("projects")?.as_table()?;
    let canonical = std::fs::canonicalize(workspace).ok();
    for candidate in canonical.as_ref().map(|p| p.to_string_lossy().into_owned()).into_iter().chain(std::iter::once(workspace.to_owned())) {
        let matched = projects.get(&candidate).or_else(|| projects.iter().find(|(path, _)| super::same_workspace_path(path, &candidate)).map(|(_, value)| value));
        if let Some(project) = matched { return Some(project.get("trust_level").and_then(toml::Value::as_str) == Some("trusted")); }
    }
    None
}
/// 与官方信任查找一致：普通仓库取根；worktree 必须验证双向引用才能继承主库。
fn git_trust_root(workspace: &Path) -> Option<std::path::PathBuf> {
    fn small_file(path: &Path) -> Option<String> {
        let meta = std::fs::symlink_metadata(path).ok()?;
        if !meta.file_type().is_file() || meta.len() > 64 * 1024 { return None; }
        std::fs::read_to_string(path).ok()
    }
    for root in workspace.ancestors() {
        let marker = root.join(".git");
        if marker.is_dir() && marker.join("HEAD").is_file() { return Some(root.into()); }
        if !marker.is_file() { continue; }
        let pointer = small_file(&marker)?;
        let gitdir = std::fs::canonicalize(root.join(pointer.trim().strip_prefix("gitdir:")?.trim())).ok()?;
        if gitdir.parent()?.file_name()? != "worktrees" { return None; }
        let backlink = small_file(&gitdir.join("gitdir"))?;
        if std::fs::canonicalize(gitdir.join(backlink.trim())).ok()? != std::fs::canonicalize(&marker).ok()? { return None; }
        let common = small_file(&gitdir.join("commondir"))?;
        let common = std::fs::canonicalize(gitdir.join(common.trim())).ok()?;
        let main = common.parent()?;
        if std::fs::canonicalize(main.join(".git")).ok()? != common { return None; }
        return Some(main.into());
    }
    None
}

/// 内置列表只是 CLI 别名；未知 Codex 模型使用 CLI 默认或用户自定义 ID。
///
/// `authoritative` 说明这份目录是不是 CLI 自己报的，`remote` 说明取得它要不要走网络，
/// `cliVersion` 记住是哪一版 CLI 报的。三者决定前端能不能把目录当成事实、以及什么时候
/// 该重新探测——缺省一律按「未核实」处理，宁可提示也不冒充。
pub fn defaults(provider: Provider) -> Value {
    if provider == Provider::Claude {
        json!({"models":[
            {"id":"default","name":"Default","efforts":["low","medium","high","xhigh","max"]},
            {"id":"opus","name":"Opus","efforts":["low","medium","high","xhigh","max"]},
            {"id":"fable","name":"Fable","efforts":["low","medium","high","xhigh","max"]},
            {"id":"sonnet","name":"Sonnet","efforts":["low","medium","high","xhigh","max"]},
            {"id":"haiku","name":"Haiku","efforts":[]}
        ],"customModel":true,"efforts":["low","medium","high","xhigh","max"],"authoritative":false,"remote":false,"cliVersion":null})
    } else { json!({"models":[],"customModel":true,"efforts":["none","minimal","low","medium","high","xhigh"],"authoritative":false,"remote":false,"cliVersion":null}) }
}

fn read_document(path: &Path) -> Value {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .filter(Value::is_object).unwrap_or_else(|| json!({}))
}
fn provider_key(provider: Provider) -> &'static str {
    match provider { Provider::Claude => "claude", Provider::Codex => "codex" }
}
/// 官方 model 是调用参数，displayName/name 与目录项 id 只能用于定位它。
pub fn canonical_model(catalog: &Value, input: &str) -> String {
    let value = input.trim();
    let Some(models) = catalog["models"].as_array() else { return value.into(); };
    if models.iter().any(|m| m["id"] == value) { return value.into(); }
    let mut ids = std::collections::HashSet::new();
    for model in models {
        if ["id", "name", "catalogId"].iter().any(|key| model[*key].as_str().is_some_and(|name| name.eq_ignore_ascii_case(value))) {
            if let Some(id) = model["id"].as_str() { ids.insert(id); }
        }
    }
    if ids.len() == 1 { ids.into_iter().next().unwrap().into() } else { value.into() }
}
fn catalog_from(document: &Value, provider: Provider) -> Value {
    let key = provider_key(provider);
    let mut catalog = document["catalogs"][key].clone();
    // 损坏或旧格式缓存不能阻塞使用；回退到本地默认。
    if !catalog["models"].as_array().is_some_and(|items| items.iter().all(|m| m["id"].is_string() && m["name"].is_string() && m["efforts"].is_array())) || !catalog["efforts"].is_array() {
        catalog = defaults(provider);
    }
    catalog["customModel"] = json!(true);
    let mut custom_models = Vec::<String>::new();
    if let Some(custom) = document["customModels"][key].as_array() {
        for raw in custom.iter().filter_map(Value::as_str) {
            let id = canonical_model(&catalog, raw);
            if validate(provider, Some(&id), None).is_err() { continue; }
            // 用户保存集合独立于发现目录，后台目录重叠不能删除用户配置。
            if !custom_models.contains(&id) { custom_models.push(id.clone()); }
            if !catalog["models"].as_array().unwrap().iter().any(|m| m["id"] == id) {
                let efforts = defaults(provider)["efforts"].clone();
                catalog["models"].as_array_mut().unwrap().push(json!({"id":id,"name":id,"efforts":efforts}));
            }
        }
    }
    catalog["customModels"] = json!(custom_models);
    // 来源两位加版本号是可选字段：旧缓存或手改的缓存没有它们时按「未核实」补齐，
    // 缺省不能看起来像事实。`remote` 只描述这一次怎么拿到的，不跟着列表落盘。
    catalog["authoritative"] = json!(catalog["authoritative"].as_bool().unwrap_or(false));
    catalog["remote"] = json!(catalog["remote"].as_bool().unwrap_or(false));
    if !catalog["cliVersion"].as_str().is_some_and(|value| !value.trim().is_empty()) { catalog["cliVersion"] = json!(null); }
    catalog
}
/// 缓存目录是否就是当前这版 CLI 报的：版本一变即失效，升级带出的新模型不必等用户手动刷新。
pub fn is_current(path: &Path, provider: Provider, version: &str) -> bool {
    let _guard = CATALOG_FILE.lock().unwrap_or_else(|e| e.into_inner());
    let catalog = catalog_from(&read_document(path), provider);
    catalog["authoritative"].as_bool() == Some(true) && catalog["cliVersion"].as_str() == Some(version)
}
/// 读缓存不探测 CLI，也不依赖当前工程。
pub fn cached_models(path: &Path, provider: Provider) -> Value {
    let _guard = CATALOG_FILE.lock().unwrap_or_else(|e| e.into_inner());
    catalog_from(&read_document(path), provider)
}
/// 自定义列表与自动目录分开保存，后台写回时重新合并磁盘状态。
pub fn save_models(path: &Path, provider: Provider, catalog: Option<Value>, custom: Option<&str>) -> Result<Value, String> {
    let _guard = CATALOG_FILE.lock().map_err(|e| e.to_string())?;
    let mut document = read_document(path);
    let key = provider_key(provider);
    if let Some(catalog) = catalog { document["catalogs"][key] = catalog; }
    if let Some(id) = custom {
        let id = canonical_model(&catalog_from(&document, provider), id);
        validate(provider, Some(&id), None)?;
        if !document["customModels"][key].is_array() { document["customModels"][key] = json!([]); }
        let items = document["customModels"][key].as_array_mut().unwrap();
        if !items.iter().any(|item| item == &id) { items.push(json!(id)); }
    }
    // 顺带清除旧版本误存的显示名/大小写重复项，保持用户 JSON 本身也一致。
    document["customModels"][key] = catalog_from(&document, provider)["customModels"].clone();
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    crate::sys::write_atomic(path, &serde_json::to_string_pretty(&document).map_err(|e| e.to_string())?)?;
    Ok(catalog_from(&document, provider))
}

/// 只删除 Forge 自定义列表中的条目，不修改 CLI 配置或自动发现目录。
pub fn remove_model(path: &Path, provider: Provider, model: &str) -> Result<(), String> {
    validate(provider, Some(model), None)?;
    let _guard = CATALOG_FILE.lock().map_err(|e| e.to_string())?;
    let mut document = read_document(path);
    if let Some(items) = document["customModels"][provider_key(provider)].as_array_mut() { items.retain(|item| item != model); }
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    crate::sys::write_atomic(path, &serde_json::to_string_pretty(&document).map_err(|e| e.to_string())?)
}

/// 四个 Claude 官方别名 → 决定其真实目标的环境变量。渠道注入与目录展示共用这一张表。
pub(super) const CLAUDE_MODELS: [(&str, &str); 4] = [
    ("sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"),
    ("opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"),
    ("haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
    ("fable", "ANTHROPIC_DEFAULT_FABLE_MODEL"),
];
/// CLI 自己支持在模型菜单里追加一个自定义选项；设置页展示它，避免配了却选不到。
const CLAUDE_CUSTOM_OPTION: [(&str, &str); 3] = [
    ("id", "ANTHROPIC_CUSTOM_MODEL_OPTION"),
    ("name", "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"),
    ("description", "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION"),
];
/// 只提取模型字段，绝不把 API key 或完整 env 返回前端。
pub fn claude_configured_models(mut catalog: Value, workspace: &str) -> Value {
    let home = std::env::var_os("CLAUDE_CONFIG_DIR").map(std::path::PathBuf::from).or_else(|| {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(|home| std::path::PathBuf::from(home).join(".claude"))
    });
    let mut mappings = serde_json::Map::new();
    let process_default = std::env::var("ANTHROPIC_MODEL").ok();
    let mut env_default = None;
    let mut model_default = None;
    let mut paths = vec![];
    if let Some(home) = home { paths.extend([home.join("settings.json"), home.join("settings.local.json")]); }
    paths.extend([Path::new(workspace).join(".claude/settings.json"), Path::new(workspace).join(".claude/settings.local.json")]);
    for path in paths {
        let settings = read_document(&path);
        // 两个字段分别按 settings.local / 项目层覆盖；最后 env 始终优先于顶层 model。
        if let Some(value) = settings["model"].as_str().filter(|value| !value.trim().is_empty()) { model_default = Some(value.trim().to_owned()); }
        if let Some(value) = settings["env"]["ANTHROPIC_MODEL"].as_str().filter(|value| !value.trim().is_empty()) { env_default = Some(value.trim().to_owned()); }
        for (_, key) in CLAUDE_MODELS {
            if let Some(value) = settings["env"][key].as_str().filter(|value| !value.trim().is_empty()) { mappings.insert(key.into(), json!(value)); }
        }
        for (_, key) in CLAUDE_CUSTOM_OPTION {
            if let Some(value) = settings["env"][key].as_str().filter(|value| !value.trim().is_empty()) { mappings.insert(key.into(), json!(value)); }
        }
    }
    // 真实进程环境优先级最高，和 CLI 启动时看到的值一致。
    for (_, key) in CLAUDE_MODELS { if let Ok(value) = std::env::var(key) { mappings.insert(key.into(), json!(value)); } }
    for (_, key) in CLAUDE_CUSTOM_OPTION { if let Ok(value) = std::env::var(key) { mappings.insert(key.into(), json!(value)); } }
    let configured_default = process_default.or(env_default).or(model_default);
    if let Some(value) = configured_default {
        let (bare, suffix) = value.strip_suffix("[1m]").map_or((value.as_str(), ""), |bare| (bare, "[1m]"));
        let resolved = CLAUDE_MODELS.iter().find(|(alias, _)| *alias == bare)
            .and_then(|(_, key)| mappings[*key].as_str()).unwrap_or(bare);
        mappings.insert("ANTHROPIC_MODEL".into(), json!(format!("{resolved}{suffix}")));
    }
    let mappings = Value::Object(mappings);
    apply_claude_mappings(&mut catalog, &mappings);
    apply_claude_custom_option(&mut catalog, &mappings);
    catalog
}
/// 把 CLI 支持的自定义模型选项放进目录，否则设置里配了却在选择器里永远看不到。
/// 同一个 id 已在目录里时只补名称/说明，不再造一条重复项。
fn apply_claude_custom_option(catalog: &mut Value, mappings: &Value) {
    let Some(id) = mappings["ANTHROPIC_CUSTOM_MODEL_OPTION"].as_str().map(str::trim).filter(|value| !value.is_empty()) else { return; };
    let name = mappings["ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"].as_str().map(str::trim).filter(|value| !value.is_empty());
    let description = mappings["ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION"].as_str().map(str::trim).filter(|value| !value.is_empty());
    let Some(models) = catalog["models"].as_array_mut() else { return; };
    if let Some(model) = models.iter_mut().find(|model| model["id"] == id) {
        model["customOption"] = json!(true);
        if let Some(name) = name { model["name"] = json!(name); }
        if let Some(description) = description { model["description"] = json!(description); }
        return;
    }
    let mut model = json!({"id": id, "name": name.unwrap_or(id), "efforts": defaults(Provider::Claude)["efforts"], "customOption": true});
    if let Some(description) = description { model["description"] = json!(description); }
    models.push(model);
}
fn apply_claude_mappings(catalog: &mut Value, mappings: &Value) {
    if let Some(models) = catalog["models"].as_array_mut() {
        for model in models {
            if model["id"] == "default" {
                if let Some(target) = mappings["ANTHROPIC_MODEL"].as_str() { model["configuredModel"] = json!(target); }
                continue;
            }
            for (alias, key) in CLAUDE_MODELS {
                if model["id"] == alias {
                    if let Some(target) = mappings[key].as_str().map(str::trim).filter(|value| !value.is_empty()) {
                        // 槽位被配置后，显示名就是用户填的模型（对照参考实现），
                        // 槽位本身留给前端做「自定义 {slot} 模型」的说明。
                        model["name"] = json!(target);
                        model["configuredModel"] = json!(target);
                        model["customSlot"] = json!(alias);
                    }
                }
            }
        }
    }
}

/// Claude 的别名在启动前解析为当前工作区配置目标，保持参考实现的真实调用语义。
pub fn configured_model(catalog: &Value, selector: &str) -> String {
    let (bare, suffix) = selector.strip_suffix("[1m]").map_or((selector, ""), |bare| (bare, "[1m]"));
    let target = catalog["models"].as_array().and_then(|models| models.iter().find(|model| model["id"] == bare))
        .and_then(|model| model["configuredModel"].as_str()).unwrap_or(bare);
    if suffix.is_empty() || target.ends_with(suffix) { target.into() } else { format!("{target}{suffix}") }
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    /// 不发送覆盖参数，由 Codex 按 cwd 加载自己的配置层。
    Inherit,
    /// 只读沙箱；需要越权时仍走人工审批。
    Read,
    #[default]
    Ask,
    Auto,
    Full,
}
impl PermissionMode {
    pub fn claude(self) -> &'static str {
        match self { Self::Inherit | Self::Ask => "manual", Self::Read => "plan", Self::Auto => "acceptEdits", Self::Full => "bypassPermissions" }
    }
    pub fn codex_policy(self) -> &'static str {
        match self { Self::Inherit | Self::Read | Self::Ask => "on-request", Self::Auto | Self::Full => "never" }
    }
    pub fn codex_sandbox(self) -> &'static str {
        match self { Self::Full => "danger-full-access", Self::Read => "read-only", _ => "workspace-write" }
    }
    pub fn codex_sandbox_type(self) -> &'static str {
        match self { Self::Full => "dangerFullAccess", Self::Read => "readOnly", _ => "workspaceWrite" }
    }
}

/// 从已安装版本的模型目录中找 Fast 的真实 ID，而不是猜测 fast/priority。
pub fn fast_tier(catalog: &Value, model: Option<&str>) -> Result<(String, String), String> {
    let item = catalog["models"].as_array().and_then(|items| items.iter().find(|item| {
        model.map_or(item["isDefault"] == true, |id| item["id"] == id)
    })).ok_or("当前模型未出现在 CLI 模型目录中，无法确认 Fast 支持")?;
    let tier = item["serviceTiers"].as_array().and_then(|tiers| tiers.iter().find(|tier| {
        tier["name"].as_str().is_some_and(|name| name.eq_ignore_ascii_case("fast"))
    })).and_then(|tier| tier["id"].as_str()).filter(|id| !id.is_empty())
        .ok_or("当前模型未报告 Fast 服务等级，请关闭 Fast 或刷新模型列表")?;
    Ok((item["id"].as_str().ok_or("模型缺少 ID")?.into(), tier.into()))
}

pub fn validate(
    provider: Provider,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<(), String> {
    if model.is_some_and(|m| {
        m.trim().is_empty()
            || m.len() > 200
            || m.starts_with('-')
            || m.chars().any(|c| c.is_control() || c.is_whitespace())
    }) {
        return Err("模型名称无效".into());
    }
    if let Some(effort) = effort {
        let valid = match provider {
            Provider::Codex => matches!(
                effort,
                "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
            ),
            Provider::Claude => matches!(effort, "low" | "medium" | "high" | "xhigh" | "max"),
        };
        if !valid {
            return Err("此 CLI 不支持所选思考强度".into());
        }
    }
    Ok(())
}
fn response(process: &mut Process, id: u64, deadline: Instant, operation: &str) -> Result<Value, String> {
    loop {
        if Instant::now() >= deadline {
            return Err(format!("{operation}超时；未发送消息"));
        }
        match process.incoming.recv_timeout(Duration::from_millis(50)) {
            Ok(Input::Json(value)) => {
                if value["id"].as_u64() == Some(id) && value.get("method").is_none() {
                    if let Some(error) = value.get("error") {
                        return Err(format!("{operation}失败：{}", error["message"]));
                    }
                    return value
                        .get("result")
                        .cloned()
                        .ok_or("模型响应缺少结果".into());
                }
                // 模型探测只读：即使 CLI 反过来发起请求，也一律拒绝，绝不借机授权。
                if value.get("id").is_some() && value.get("method").is_some() {
                    process.write(&json!({"id":value["id"],"error":{"code":-32601,"message":"Read-only model discovery"}}))?;
                }
            }
            Ok(Input::Error(error)) => return Err(error),
            Ok(Input::Eof) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!("{operation}时 CLI 已退出"))
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}
/// 建立只做管理调用的 Codex app-server 连接；这些请求不会触发模型调用。
fn codex_management_process(cwd: &str, operation: &str) -> Result<(Process, Instant), String> {
    let (command, _) = ai_cli::runtime_command(Provider::Codex, &["app-server"])?;
    let mut process = Process::spawn(command, cwd)?;
    let deadline = Instant::now() + Duration::from_secs(15);
    process.write(&json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"forge","title":"Forge","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":false}}}))?;
    response(&mut process, 1, deadline, operation)?;
    process.write(&json!({"method":"initialized","params":{}}))?;
    Ok((process, deadline))
}

/// 使用 Codex /resume 同源的 thread/list 读取会话身份、标题与运行态。
pub fn codex_threads(cwd: &str) -> Result<Vec<Value>, String> {
    let (mut process, deadline) = codex_management_process(cwd, "初始化 Codex 会话列表")?;
    let mut threads = Vec::new();
    let mut cursor = Value::Null;
    let mut cursors = std::collections::HashSet::new();
    for request_id in 2..=41 {
        process.write(&json!({"id":request_id,"method":"thread/list","params":{"cwd":cwd,"cursor":cursor,"limit":100,"sortKey":"recency_at","sortDirection":"desc"}}))?;
        let result = response(&mut process, request_id, deadline, "读取 Codex 会话列表")?;
        let page = result["data"].as_array().ok_or("Codex 会话列表格式不兼容")?;
        threads.extend(page.iter().filter_map(|thread| {
            let id = thread["id"].as_str()?.to_owned();
            let title = thread["name"].as_str().filter(|s| !s.trim().is_empty())
                .or_else(|| thread["preview"].as_str().filter(|s| !s.trim().is_empty()))
                .unwrap_or(&id).lines().next().unwrap_or(&id).chars().take(120).collect::<String>();
            Some(json!({"id":id,"title":title,"createdAt":thread["createdAt"].as_i64().unwrap_or_default().max(0) as u64 * 1000,"status":thread["status"]}))
        }));
        cursor = result["nextCursor"].clone();
        if cursor.is_null() { return Ok(threads); }
        if !cursor.is_string() || !cursors.insert(cursor.to_string()) { return Err("Codex 会话分页游标无效".into()); }
    }
    Err("Codex 会话列表超过分页上限".into())
}

/// 新建空 Codex thread 并让 CLI 保存标题，返回 CLI 原生 ID。
pub fn codex_create_thread(cwd: &str, title: &str) -> Result<Value, String> {
    let (mut process, deadline) = codex_management_process(cwd, "初始化 Codex 新会话")?;
    process.write(&json!({"id":2,"method":"thread/start","params":{"cwd":cwd}}))?;
    let result = response(&mut process, 2, deadline, "创建 Codex 会话")?;
    let id = result["thread"]["id"].as_str().ok_or("Codex 未返回 thread ID")?;
    process.write(&json!({"id":3,"method":"thread/name/set","params":{"threadId":id,"name":title}}))?;
    response(&mut process, 3, deadline, "设置 Codex 会话标题")?;
    Ok(json!({"id":id,"title":title,"createdAt":result["thread"]["createdAt"].as_i64().unwrap_or_default().max(0) as u64 * 1000}))
}

pub fn codex_set_thread_name(cwd: &str, id: &str, title: &str) -> Result<(), String> {
    let (mut process, deadline) = codex_management_process(cwd, "初始化 Codex 会话重命名")?;
    process.write(&json!({"id":2,"method":"thread/name/set","params":{"threadId":id,"name":title}}))?;
    response(&mut process, 2, deadline, "重命名 Codex 会话")?;
    Ok(())
}
/// 官方负责项目层/profile/系统层优先级；前端只获得展示所需的白名单字段。
pub fn codex_project_config(cwd: &str) -> Result<Value, String> {
    let (command, _) = ai_cli::runtime_command(Provider::Codex, &["app-server"])?;
    let mut process = Process::spawn(command, cwd)?;
    let deadline = Instant::now() + Duration::from_secs(15);
    process.write(&json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"forge","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":false}}}))?;
    response(&mut process, 1, deadline, "初始化 Codex 配置")?;
    process.write(&json!({"method":"initialized","params":{}}))?;
    process.write(&json!({"id":2,"method":"config/read","params":{"cwd":cwd,"includeLayers":true}}))?;
    let result = response(&mut process, 2, deadline, "读取 Codex 项目配置")?;
    Ok(project_config_fields(&result))
}
fn project_config_fields(result: &Value) -> Value {
    let config = &result["config"];
    let sandbox = config["sandbox_mode"].as_str().unwrap_or("");
    let approval = config["approval_policy"].as_str().unwrap_or("");
    // 只给完全相同的官方组合一个快捷名；其余组合保留原值展示，绝不压成更宽的权限。
    let permission = match (sandbox, approval) {
        ("read-only", "on-request") => "read",
        ("workspace-write", "on-request") => "ask",
        ("workspace-write", "never") => "auto",
        ("danger-full-access", "never") => "full",
        _ => "custom",
    };
    json!({
        "model":config["model"], "effort":config["model_reasoning_effort"], "serviceTier":config["service_tier"],
        "permission":permission, "sandboxMode":config["sandbox_mode"], "approvalPolicy":config["approval_policy"],
    })
}

fn project_config_target(result: &Value, cwd: &str) -> (std::path::PathBuf, Option<String>) {
    let layer = result["layers"].as_array().and_then(|layers| layers.iter().rev().find(|layer| layer["name"]["type"] == "project"));
    let folder = layer.and_then(|layer| layer["name"]["dotCodexFolder"].as_str()).map(std::path::PathBuf::from)
        .unwrap_or_else(|| Path::new(cwd).join(".codex"));
    (folder.join("config.toml"), layer.and_then(|layer| layer["version"].as_str()).map(str::to_owned))
}

/// `config/read` 决定真实项目层；写入只改该层的白名单键，并保留其余 TOML 与注释。
/// Codex 0.163.0 虽在 schema 中暴露 filePath，实际仍拒绝项目层 batchWrite（Only writes to the user config are allowed）。
pub fn update_codex_project_config(cwd: &str, patch: &Value) -> Result<Value, String> {
    let object = patch.as_object().ok_or("项目配置更新格式无效")?;
    if object.is_empty() || object.keys().any(|key| !matches!(key.as_str(), "model" | "effort" | "permission" | "serviceTier")) {
        return Err("项目配置更新包含未知字段".into());
    }
    if let Some(value) = object.get("model") {
        if !value.is_null() { validate(Provider::Codex, value.as_str(), None)?; }
    }
    if let Some(value) = object.get("effort") {
        if !value.is_null() { validate(Provider::Codex, None, value.as_str())?; }
    }
    if let Some(value) = object.get("serviceTier") {
        if !value.is_null() && !value.as_str().is_some_and(|tier| !tier.trim().is_empty() && tier.len() <= 80 && !tier.chars().any(char::is_whitespace)) {
            return Err("Codex 服务等级无效".into());
        }
    }
    if object.get("permission").is_some_and(|value| !value.is_null() && !matches!(value.as_str(), Some("read" | "ask" | "auto" | "full"))) { return Err("Codex 权限模式无效".into()); }
    let (command, _) = ai_cli::runtime_command(Provider::Codex, &["app-server"])?;
    let mut process = Process::spawn(command, cwd)?;
    let deadline = Instant::now() + Duration::from_secs(15);
    process.write(&json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"forge","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":false}}}))?;
    response(&mut process, 1, deadline, "初始化 Codex 配置")?;
    process.write(&json!({"method":"initialized","params":{}}))?;
    process.write(&json!({"id":2,"method":"config/read","params":{"cwd":cwd,"includeLayers":true}}))?;
    let before = response(&mut process, 2, deadline, "读取 Codex 项目配置")?;
    let (config_path, _) = project_config_target(&before, cwd);
    drop(process);
    if let Some(parent) = config_path.parent() { std::fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    let text = std::fs::read_to_string(&config_path).unwrap_or_default();
    let mut document = text.parse::<toml_edit::DocumentMut>().map_err(|error| format!("Codex 项目配置格式无效：{error}"))?;
    let set_string = |document: &mut toml_edit::DocumentMut, key: &str, value: Option<&Value>| {
        if let Some(value) = value {
            if let Some(value) = value.as_str() { document[key] = toml_edit::value(value); }
            else { document.remove(key); }
        }
    };
    set_string(&mut document, "model", object.get("model"));
    set_string(&mut document, "model_reasoning_effort", object.get("effort"));
    set_string(&mut document, "service_tier", object.get("serviceTier"));
    if let Some(permission) = object.get("permission") {
        match permission.as_str() {
            Some("read") => { document["approval_policy"] = toml_edit::value("on-request"); document["sandbox_mode"] = toml_edit::value("read-only"); }
            Some("ask") => { document["approval_policy"] = toml_edit::value("on-request"); document["sandbox_mode"] = toml_edit::value("workspace-write"); }
            Some("auto") => { document["approval_policy"] = toml_edit::value("never"); document["sandbox_mode"] = toml_edit::value("workspace-write"); }
            Some("full") => { document["approval_policy"] = toml_edit::value("never"); document["sandbox_mode"] = toml_edit::value("danger-full-access"); }
            None => { document.remove("approval_policy"); document.remove("sandbox_mode"); }
            _ => unreachable!(),
        }
    }
    crate::sys::write_atomic(&config_path, &document.to_string())?;
    // 写后仍由 CLI 重新计算全部层，返回实际生效值而不是 Forge 的乐观合并。
    codex_project_config(cwd)
}

pub fn models(provider: Provider, cwd: &str) -> Result<Value, String> {
    if provider == Provider::Claude {
        // 这些只是 CLI 的别名，不代表账号一定可用、也不保证背后是哪个具体模型。
        // 为了填一个下拉框不去初始化 Claude 会话——初始化会触发 hooks，代价和副作用都太大。
        return Ok(defaults(provider));
    }
    let (command, version) = ai_cli::runtime_command(provider, &["app-server"])?;
    let mut process = Process::spawn(command, cwd)?;
    let deadline = Instant::now() + Duration::from_secs(15);
    process.write(&json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"forge","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":false}}}))?;
    response(&mut process, 1, deadline, "初始化 Codex 模型目录")?;
    process.write(&json!({"method":"initialized","params":{}}))?;
    let mut models = vec![];
    let mut cursor = Value::Null;
    let mut cursors = std::collections::HashSet::new();
    for id in 2..=21 {
        process.write(&json!({"id":id,"method":"model/list","params":{"cursor":cursor,"limit":100,"includeHidden":false}}))?;
        let result = response(&mut process, id, deadline, "读取 Codex 模型目录")?;
        models.extend(parse_models(&result)?);
        cursor = result["nextCursor"].clone();
        if cursor.is_null() {
            // CLI 亲口报的目录才谈得上 authoritative；版本号是它的失效条件。
            return Ok(json!({"models":models,"customModel":true,"efforts":[],"authoritative":true,"cliVersion":version}));
        }
        if !cursor.is_string() || !cursors.insert(cursor.to_string()) {
            return Err("模型分页游标无效".into());
        }
    }
    Err("模型列表超过分页上限".into())
}
fn parse_models(value: &Value) -> Result<Vec<Value>, String> {
    let data = value["data"].as_array().ok_or("模型列表格式不兼容")?;
    data.iter().filter(|m| m["hidden"] != true).map(|model| {
        let id=model["model"].as_str().ok_or("模型缺少调用标识")?;
        let efforts=model["supportedReasoningEfforts"].as_array().ok_or("模型缺少思考强度信息")?.iter().filter_map(|e| e["reasoningEffort"].as_str()).collect::<Vec<_>>();
        // 每档强度的说明文字（CLI 目录自带）：弹层的分段控件按当前档展示。
        let effort_descriptions = model["supportedReasoningEfforts"].as_array().map(|levels| {
            let map: serde_json::Map<String, Value> = levels.iter().filter_map(|e| {
                let key = e["reasoningEffort"].as_str()?;
                let text = e["description"].as_str()?;
                Some((key.to_string(), Value::String(text.to_string())))
            }).collect();
            map
        }).unwrap_or_default();
        Ok(json!({
            "id":id,"catalogId":model["id"],"name":model["displayName"].as_str().unwrap_or(id),
            "description":model["description"].as_str().unwrap_or(""),
            "efforts":efforts,"effortDescriptions":effort_descriptions,
            "defaultEffort":model["defaultReasoningEffort"],"isDefault":model["isDefault"],
            "serviceTiers":model["serviceTiers"]
        }))
    }).collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_trust_reads_only_matching_project_with_normalized_windows_path() {
        let config: toml::Value = "[projects.'D:\\app\\code\\forge']\ntrust_level = 'trusted'\n[projects.'D:\\app\\code\\other']\ntrust_level = 'untrusted'".parse().unwrap();
        assert!(project_trusted(&config, "d:/app/code/forge"));
        assert!(!project_trusted(&config, "D:/app/code/other"));
        assert!(!project_trusted(&config, "D:/app/code/forge-copy"));
        assert_eq!(project_trust(&config, "D:/app/code/other"), Some(false));
        let missing: toml::Value = "[projects.'D:/root']".parse().unwrap();
        assert_eq!(project_trust(&missing, "D:/root"), Some(false));
        assert_eq!(project_trust(&missing, "D:/missing"), None);
        assert_eq!(project_config_fields(&json!({"config":{"model":"chosen","model_reasoning_effort":"high","sandbox_mode":"read-only","approval_policy":"on-request","api_key":"never-return","env":{"TOKEN":"secret"}}})),
            json!({"model":"chosen","effort":"high","serviceTier":null,"permission":"read","sandboxMode":"read-only","approvalPolicy":"on-request"}));
        assert_eq!(project_config_fields(&json!({"config":{"sandbox_mode":"custom-sandbox","approval_policy":"custom-policy"}}))["permission"], "custom");
    }
    #[test]
    fn model_display_names_and_case_variants_resolve_to_the_wire_identifier() {
        let catalog = json!({"models":[{"id":"gpt-6-astra","catalogId":"astra-picker","name":"GPT-6 Astra","efforts":[]}],"efforts":[]});
        for input in ["GPT-6-Astra", "gpt-6-astra", "GPT-6 Astra", "astra-picker"] { assert_eq!(canonical_model(&catalog, input), "gpt-6-astra"); }
        let merged = catalog_from(&json!({"catalogs":{"codex":catalog},"customModels":{"codex":["GPT-6-Astra","gpt-6-astra","Vendor/Custom","vendor/custom"]}}), Provider::Codex);
        assert_eq!(merged["models"].as_array().unwrap().len(), 2);
        assert_eq!(merged["customModels"], json!(["gpt-6-astra", "Vendor/Custom"]));
        assert_eq!(canonical_model(&merged, "unknown/MixedCase"), "unknown/MixedCase");
    }
    #[test]
    fn model_cache_preserves_custom_models_across_refresh_and_restart() {
        let dir = std::env::temp_dir().join(format!("forge-model-cache-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let path = dir.join("ai-models.json");
        assert!(cached_models(&path, Provider::Claude)["models"].as_array().unwrap().iter().any(|model| model["id"] == "sonnet"));
        save_models(&path, Provider::Codex, None, Some("custom-codex")).unwrap();
        save_models(&path, Provider::Claude, None, Some("custom-claude")).unwrap();
        save_models(&path, Provider::Codex, None, Some("custom-codex")).unwrap();
        let discovered = json!({"models":[{"id":"discovered","name":"Discovered","efforts":["high"]}],"efforts":[],"customModel":true});
        let overlap = json!({"models":[{"id":"custom-codex","name":"Custom","efforts":[]}],"efforts":[]});
        save_models(&path, Provider::Codex, Some(overlap), None).unwrap();
        assert_eq!(cached_models(&path, Provider::Codex)["customModels"], json!(["custom-codex"]));
        save_models(&path, Provider::Codex, Some(discovered), None).unwrap();
        // 从磁盘重新读取，验证跨重启、供应商隔离、去重与后台刷新合并。
        let catalog = cached_models(&path, Provider::Codex);
        assert_eq!(catalog["models"].as_array().unwrap().len(), 2);
        assert_eq!(catalog["models"][1]["id"], "custom-codex");
        assert!(cached_models(&path, Provider::Claude)["models"].as_array().unwrap().iter().any(|m| m["id"] == "custom-claude"));
        remove_model(&path, Provider::Codex, "custom-codex").unwrap();
        assert_eq!(cached_models(&path, Provider::Codex)["customModels"], json!([]));
        assert_eq!(cached_models(&path, Provider::Codex)["models"][0]["id"], "discovered");
        assert_eq!(cached_models(&path, Provider::Claude)["customModels"], json!(["custom-claude"]));
        let before = std::fs::read(&path).unwrap();
        assert!(save_models(&path, Provider::Codex, None, Some("--invalid")).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::write(&path, "invalid json").unwrap();
        let mut expected = defaults(Provider::Codex);
        expected["customModels"] = json!([]);
        assert_eq!(cached_models(&path, Provider::Codex), expected);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn catalog_provenance_survives_save_and_invalidates_on_cli_version() {
        let dir = std::env::temp_dir().join(format!("forge-model-source-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let path = dir.join("ai-models.json");
        // 内置别名表不是 CLI 报的，绝不顶着 authoritative。
        assert_eq!(defaults(Provider::Claude)["authoritative"], json!(false));
        assert!(!is_current(&path, Provider::Codex, "1.2.3"));
        let probed = json!({"models":[{"id":"gpt-9","name":"GPT-9","efforts":[]}],"efforts":[],"customModel":true,"authoritative":true,"cliVersion":"1.2.3"});
        save_models(&path, Provider::Codex, Some(probed), None).unwrap();
        let cached = cached_models(&path, Provider::Codex);
        assert_eq!(cached["authoritative"], json!(true));
        assert_eq!(cached["cliVersion"], json!("1.2.3"));
        // 从磁盘读回的不是「现问 CLI」，remote 必须归位 false。
        assert_eq!(cached["remote"], json!(false));
        assert!(is_current(&path, Provider::Codex, "1.2.3"));
        // CLI 一升级旧目录就失效，不必等用户手动刷新。
        assert!(!is_current(&path, Provider::Codex, "1.3.0"));
        // 老缓存没有来源字段时按未核实处理，不能凭空当成 CLI 实测。
        std::fs::write(&path, r#"{"catalogs":{"codex":{"models":[{"id":"legacy","name":"Legacy","efforts":[]}],"efforts":[],"customModel":true}}}"#).unwrap();
        let legacy = cached_models(&path, Provider::Codex);
        assert_eq!(legacy["authoritative"], json!(false));
        assert_eq!(legacy["cliVersion"], json!(null));
        assert!(!is_current(&path, Provider::Codex, "1.2.3"));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn claude_aliases_display_configured_ids_without_changing_wire_aliases() {
        let mut catalog = defaults(Provider::Claude);
        apply_claude_mappings(&mut catalog, &json!({
            "ANTHROPIC_DEFAULT_SONNET_MODEL":"gemini-3.8-flash-high",
            "ANTHROPIC_DEFAULT_OPUS_MODEL":"deepseek-v4.1-flash",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL":"gemini-3.8-flash-high",
            "ANTHROPIC_API_KEY":"must-not-escape"
        }));
        for (alias, target) in [("sonnet","gemini-3.8-flash-high"), ("opus","deepseek-v4.1-flash"), ("haiku","gemini-3.8-flash-high")] {
            let model = catalog["models"].as_array().unwrap().iter().find(|model| model["id"] == alias).unwrap();
            // 槽位被配置后，列表直接显示实际调用的模型；别名留给 customSlot 提示。
            assert_eq!(model["name"], target);
            assert_eq!(model["configuredModel"], target);
            assert_eq!(model["customSlot"], alias);
            assert_eq!(configured_model(&catalog, alias), target);
        }
        assert!(catalog.get("env").is_none());
        assert!(catalog.get("ANTHROPIC_API_KEY").is_none());
    }
    #[test]
    fn fast_uses_catalog_id_and_missing_capability_fails_closed() {
        let catalog = json!({"models":[{"id":"chosen","isDefault":true,"serviceTiers":[{"id":"provider-specific-fast-id","name":"Fast"}]}]});
        assert_eq!(fast_tier(&catalog, None).unwrap(), ("chosen".into(), "provider-specific-fast-id".into()));
        assert!(fast_tier(&catalog, Some("unknown")).is_err());
        assert!(fast_tier(&json!({"models":[{"id":"chosen","isDefault":true}]}), None).is_err());
        assert_eq!(PermissionMode::Ask.claude(), "manual");
        assert_eq!(PermissionMode::Read.claude(), "plan");
        assert_eq!(PermissionMode::Auto.claude(), "acceptEdits");
        assert_eq!(PermissionMode::Full.claude(), "bypassPermissions");
        // 只读档位必须连沙箱一起收紧，不能只改审批策略。
        assert_eq!(PermissionMode::Read.codex_sandbox(), "read-only");
        assert_eq!(PermissionMode::Read.codex_sandbox_type(), "readOnly");
        assert_eq!(PermissionMode::Read.codex_policy(), "on-request");
        assert!(matches!(serde_json::from_value::<PermissionMode>(json!("read")), Ok(PermissionMode::Read)));
        assert!(serde_json::from_value::<PermissionMode>(json!("unknown")).is_err());
    }
    #[test]
    fn claude_custom_models_survive_configured_mappings() {
        let dir = std::env::temp_dir().join(format!("forge-claude-custom-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ai-models.json");
        save_models(&path, Provider::Claude, None, Some("my-gateway/claude-opus")).unwrap();
        let catalog = claude_configured_models(cached_models(&path, Provider::Claude), &dir.to_string_lossy());
        // 环境/工作区里的别名映射只能改显示，不能把用户自己加的模型挤掉。
        assert!(catalog["customModels"].as_array().unwrap().iter().any(|value| value == "my-gateway/claude-opus"));
        assert!(catalog["models"].as_array().unwrap().iter().any(|model| model["id"] == "my-gateway/claude-opus"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn claude_custom_option_is_listed_once_with_its_label() {
        let mut catalog = defaults(Provider::Claude);
        apply_claude_custom_option(&mut catalog, &json!({
            "ANTHROPIC_CUSTOM_MODEL_OPTION": "gw/opus",
            "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "GW Opus",
            "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "via gateway"
        }));
        let model = catalog["models"].as_array().unwrap().iter().find(|model| model["id"] == "gw/opus").unwrap();
        assert_eq!(model["name"], "GW Opus");
        assert_eq!(model["description"], "via gateway");
        assert_eq!(model["customOption"], true);
        // 指向已有 id 时只补标签，不重复造条目。
        apply_claude_custom_option(&mut catalog, &json!({"ANTHROPIC_CUSTOM_MODEL_OPTION": "sonnet", "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "Sonnet gateway"}));
        assert_eq!(catalog["models"].as_array().unwrap().iter().filter(|model| model["id"] == "sonnet").count(), 1);
        assert_eq!(catalog["models"].as_array().unwrap().iter().find(|model| model["id"] == "sonnet").unwrap()["customOption"], true);
    }

    #[test]
    fn validates_cli_arguments_and_preserves_real_capabilities() {
        assert!(validate(Provider::Claude, Some("--dangerous"), None).is_err());
        assert!(validate(Provider::Codex, Some("custom-model"), Some("max")).is_err());
        assert!(validate(Provider::Claude, Some("provider.model-v1"), Some("max")).is_ok());
        let values=parse_models(&json!({"data":[{"model":"real","displayName":"Real","supportedReasoningEfforts":[{"reasoningEffort":"low"}],"defaultReasoningEffort":"low"},{"hidden":true}]})).unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0]["efforts"], json!(["low"]));
    }
}

