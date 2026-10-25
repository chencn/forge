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
///
/// `modes` 是探测失败时的兜底模式表，只够界面渲染，不能当成这版 CLI 的事实；
/// 真实取值由 `discover_modes` 现问 CLI，见 `modesAuthoritative`。
pub fn defaults(provider: Provider) -> Value {
    if provider == Provider::Claude {
        json!({"models":[
            {"id":"default","name":"Default","efforts":["low","medium","high","xhigh","max"]},
            {"id":"opus","name":"Opus","efforts":["low","medium","high","xhigh","max"]},
            {"id":"fable","name":"Fable","efforts":["low","medium","high","xhigh","max"]},
            {"id":"sonnet","name":"Sonnet","efforts":["low","medium","high","xhigh","max"]},
            {"id":"haiku","name":"Haiku","efforts":[]}
        ],"customModel":true,"efforts":["low","medium","high","xhigh","max"],"authoritative":false,"remote":false,"cliVersion":null,
            "modes":["manual","plan","acceptEdits","auto","dontAsk","bypassPermissions"],"modesAuthoritative":false})
    } else { json!({"models":[],"customModel":true,"efforts":["none","minimal","low","medium","high","xhigh"],"authoritative":false,"remote":false,"cliVersion":null,
        "modes":["default","plan"],"modesAuthoritative":false}) }
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
            if validate(Some(&id), None).is_err() { continue; }
            // 用户保存集合独立于发现目录，后台目录重叠不能删除用户配置。
            if !custom_models.contains(&id) { custom_models.push(id.clone()); }
            if !catalog["models"].as_array().unwrap().iter().any(|m| m["id"] == id) {
                // Claude 的 `--effort` 是会话级参数，别名照给；Codex 的档位属于模型自己，
                // 我们不知道一个陌生 slug 支持什么，宁可给空列表也不替 CLI 编一份。
                let efforts = match provider {
                    Provider::Claude => defaults(provider)["efforts"].clone(),
                    Provider::Codex => json!([]),
                };
                catalog["models"].as_array_mut().unwrap().push(json!({"id":id,"name":id,"efforts":efforts}));
            }
        }
    }
    catalog["customModels"] = json!(custom_models);
    // 模式表跟模型表同一套规矩：只留合法的 id，整表坏掉就退回内置兜底，
    // 不能让手改过的缓存把任意字符串送进 CLI 参数。
    let modes = catalog["modes"].as_array().and_then(|items| {
        let ids = items.iter().filter_map(Value::as_str).filter(|id| valid_mode_id(id)).map(str::to_owned).collect::<Vec<_>>();
        (!ids.is_empty()).then_some(ids)
    });
    catalog["modes"] = match modes {
        Some(ids) => json!(ids),
        None => defaults(provider)["modes"].clone(),
    };
    // 来源两位加版本号是可选字段：旧缓存或手改的缓存没有它们时按「未核实」补齐，
    // 缺省不能看起来像事实。`remote` 只描述这一次怎么拿到的，不跟着列表落盘。
    catalog["authoritative"] = json!(catalog["authoritative"].as_bool().unwrap_or(false));
    catalog["remote"] = json!(catalog["remote"].as_bool().unwrap_or(false));
    catalog["modesAuthoritative"] = json!(catalog["modesAuthoritative"].as_bool().unwrap_or(false));
    if !catalog["cliVersion"].as_str().is_some_and(|value| !value.trim().is_empty()) { catalog["cliVersion"] = json!(null); }
    catalog
}
/// 「模型清单」里的定制必须在选模型的地方看得见：被排除的官方模型从列表里去掉，
/// 清单新增的自定义模型按它自己条目的档位补进来。
/// 这层合并非做不可：Codex 的 `model/list` 根本不读 `model_catalog_json`
/// （实测把目录裁到只剩一个模型，它照样回 11 条内置项）。
pub fn apply_picker_patch(catalog: Value, patch: Option<Value>) -> Value {
    let Some(patch) = patch else { return catalog };
    let excluded = patch["excluded"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>();
    let customs = patch["customs"].as_array().cloned().unwrap_or_default();
    let mut catalog = catalog;
    let Some(models) = catalog["models"].as_array().cloned() else { return catalog };
    let mut kept: Vec<Value> = models.into_iter()
        .filter(|model| !excluded.iter().any(|slug| model["id"].as_str() == Some(slug)))
        .collect();
    for custom in customs {
        let Some(id) = custom["id"].as_str() else { continue };
        if kept.iter().any(|model| model["id"].as_str() == Some(id)) { continue; }
        kept.push(json!({"id": id, "name": custom["name"].as_str().unwrap_or(id), "efforts": custom["efforts"].clone()}));
    }
    catalog["models"] = json!(kept);
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
        // Codex 的目录是整份替换：一个能用的高级模型条目要带上下文长度、档位、协议开关，
        // 裸 ID 只能靠我们猜。所以新增一律走「模型清单」，那里是复制官方条目再改。
        if provider == Provider::Codex {
            return Err("Codex 的自定义模型请在下方「模型清单」里添加：复制一个官方条目再改，裸 ID 没有可核实的参数".into());
        }
        let id = canonical_model(&catalog_from(&document, provider), id);
        validate(Some(&id), None)?;
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
    validate(Some(model), None)?;
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

/// 模式 id 会原样进 CLI 参数，所以只收 CLI 亲口报过的那种形状：首字符是字母，
/// 其后限字母/数字/下划线/连字符，最长 40。靠白名单不收，而不是靠转义硬塞。
fn valid_mode_id(value: &str) -> bool {
    value.len() <= 40
        && value.chars().next().is_some_and(|first| first.is_ascii_alphabetic())
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 这版 CLI 报出的模式取值；探测没成功时退回内置兜底。
pub fn mode_ids(catalog: &Value, provider: Provider) -> Vec<String> {
    let discovered = catalog["modes"].as_array().into_iter().flatten()
        .filter_map(Value::as_str).filter(|id| valid_mode_id(id)).map(str::to_owned).collect::<Vec<_>>();
    if !discovered.is_empty() { return discovered; }
    defaults(provider)["modes"].as_array().unwrap().iter().filter_map(Value::as_str).map(str::to_owned).collect()
}

/// 「正常」档的 id：用户记住的模式被 CLI 撤掉时回落到它，而不是回落到 Forge 自己的档名。
pub fn default_mode_id(provider: Provider) -> &'static str {
    match provider { Provider::Claude => "manual", Provider::Codex => "default" }
}

/// 把前端选的档位折成这版 CLI 认的一个模式 id；`requested` 为空表示这是旧请求
/// （只有 permission/planMode），按旧语义映射。用户明确选过的模式不在 CLI 报过的
/// 取值里时宁可报错让他重选，也不悄悄换成另一档权限跑起来。
pub fn canonical_mode(catalog: &Value, provider: Provider, requested: Option<&str>, legacy_plan: bool, legacy: PermissionMode) -> Result<String, String> {
    let ids = mode_ids(catalog, provider);
    let allowed = |value: &str| ids.iter().any(|id| id == value);
    if let Some(value) = requested.map(str::trim).filter(|value| !value.is_empty()) {
        if !valid_mode_id(value) || !allowed(value) { return Err("当前 CLI 不提供所选模式，请重新选择".into()); }
        return Ok(value.to_owned());
    }
    // Codex 的计划模式过去只有 plan_mode 这一个布尔，权限档是另一条轴，与此无关。
    let preferred = match provider {
        Provider::Codex => if legacy_plan { "plan" } else { default_mode_id(provider) },
        Provider::Claude => if legacy_plan { "plan" } else { legacy.claude() },
    };
    let fallback = default_mode_id(provider);
    Ok(if allowed(preferred) { preferred.to_owned() } else if allowed(fallback) { fallback.to_owned() } else { ids[0].clone() })
}

/// Codex 的协作模式取值只认 CLI 的「序列化侧」：它能报出什么名字，就真有几个模式。
///
/// 反序列化接受的名字不能用。`code`/`custom`/`execute`/`pair_programming` 只是 `default`
/// 的 serde 别名——实测朝 ephemeral 线程发 `pair_programming`，CLI 回报的是
/// `mode:"default"` 并注入 "Collaboration Mode: Default" 指令；照收下的名字摆按钮，
/// 等于给用户四个假的「正常」。`generate-json-schema` 导出的正是序列化侧，
/// 所以现问一次、读完就删，取值也跟着 CLI 版本一起变。
fn codex_mode_ids() -> Result<Vec<String>, String> {
    let dir = std::env::temp_dir().join(format!("forge-codex-schema-{}", std::process::id()));
    let _cleanup = TempSchemaDir(dir.clone());
    let out = dir.to_string_lossy().into_owned();
    let (command, _) = ai_cli::runtime_command(Provider::Codex, &["app-server", "generate-json-schema", "--out", &out])?;
    crate::ai_cli::process::checked_full(command)?;
    let schema = read_document(&std::path::Path::new(&out).join("codex_app_server_protocol.v2.schemas.json"));
    let ids = mode_ids_from_schema(&schema);
    if ids.is_empty() { return Err("Codex 未报出可用的协作模式".into()); }
    Ok(ids)
}

/// `collaborationMode.mode` 的序列化取值就是这版 CLI 真正区分的模式；取不到时交回空表，
/// 由调用方退回内置档位并把来源写成「未核实」。
fn mode_ids_from_schema(schema: &Value) -> Vec<String> {
    schema["definitions"]["ModeKind"]["enum"].as_array().into_iter().flatten()
        .filter_map(Value::as_str).filter(|id| valid_mode_id(id)).map(str::to_owned).collect()
}

/// 探测目录用完即删：它只是问 CLI 要一份契约文本，不该在临时目录里留 4MB。
struct TempSchemaDir(std::path::PathBuf);
impl Drop for TempSchemaDir {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

/// Claude 把可选模式写在 `--help` 的 choices 里；照抄它，CLI 增删档位界面就跟着变。
fn claude_mode_ids(help: &str) -> Option<Vec<String>> {
    let block = &help[help.find("--permission-mode")?..].split("\n  --").next()?;
    let at = block.find("(choices:")? + "(choices:".len();
    let ids = block[at..].split(')').next()?.split(',')
        .filter_map(|item| {
            let id = item.trim().trim_matches('"').trim();
            valid_mode_id(id).then(|| id.to_owned())
        })
        .collect::<Vec<_>>();
    (!ids.is_empty()).then_some(ids)
}

/// Claude 的思考强度同样写在 `--help`：`--effort <level> … (low, medium, high, xhigh, max)`。
/// 和模式一样照抄，CLI 增删档位时界面跟着变，不在这里另存一份会过期的枚举。
fn claude_effort_ids(help: &str) -> Option<Vec<String>> {
    let block = &help[help.find("--effort")?..].split("\n  --").next()?;
    let at = block.find('(')? + 1;
    let ids = block[at..].split(')').next()?.split(',')
        .filter_map(|item| {
            let id = item.trim().trim_matches('"').trim();
            valid_mode_id(id).then(|| id.to_owned())
        })
        .collect::<Vec<_>>();
    (!ids.is_empty()).then_some(ids)
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

/// 只校验形状，不校验取值：模型与强度档位以 CLI 当场报出的清单为准（界面只列它认的），
/// 在 Forge 里再存一份枚举，CLI 新增档位就会被这里拒掉。
pub fn validate(model: Option<&str>, effort: Option<&str>) -> Result<(), String> {
    let shape_ok = |value: &str, max: usize| {
        !value.trim().is_empty()
            && value.len() <= max
            && !value.starts_with('-')
            && !value.chars().any(|c| c.is_control() || c.is_whitespace())
    };
    if model.is_some_and(|m| !shape_ok(m, 200)) {
        return Err("模型名称无效".into());
    }
    if effort.is_some_and(|e| !shape_ok(e, 40)) {
        return Err("思考强度无效".into());
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
fn codex_management_process_with_experimental(cwd: &str, operation: &str, experimental: bool) -> Result<(Process, Instant), String> {
    let (command, _) = ai_cli::runtime_command(Provider::Codex, &["app-server"])?;
    let mut process = Process::spawn(command, cwd)?;
    let deadline = Instant::now() + Duration::from_secs(15);
    process.write(&json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"forge","title":"Forge","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":experimental}}}))?;
    response(&mut process, 1, deadline, operation)?;
    process.write(&json!({"method":"initialized","params":{}}))?;
    Ok((process, deadline))
}
fn codex_management_process(cwd: &str, operation: &str) -> Result<(Process, Instant), String> {
    codex_management_process_with_experimental(cwd, operation, false)
}

/// 让 Codex 现场读一份模型目录，把它的判决原样带回来：`Ok(())` = 这份目录被接受，
/// `Err` = CLI 的报错原文（`unknown variant …, expected one of …` / `invalid type: null, …`）。
///
/// 只有 `thread/start` 的 `config` 覆盖会真正解析 `model_catalog_json`：实测 0.164.0 里
/// `codex debug models` 和 `model/list` 都完全不读它（把目录裁到只剩一个模型，两者仍回整份内置表）。
/// 探测用 `ephemeral` 会话，不落 `~/.codex/sessions`（实测探测前后计数不变）。
/// `prepare(index)` 负责写出第 index 份目录并返回其绝对路径，这样调用方能一次跑完所有字段而只起一个进程。
pub fn codex_catalog_probe(cwd: &str, count: usize, prepare: &mut dyn FnMut(usize) -> Result<String, String>) -> Result<Vec<Result<(), String>>, String> {
    let mut answers = Vec::with_capacity(count);
    let (mut process, mut deadline) = codex_management_process(cwd, "初始化 Codex 字段探测")?;
    let mut request_id = 2_u64;
    for index in 0..count {
        let outcome = match prepare(index) {
            Err(error) => Err(error),
            Ok(path) => {
                let sent = process.write(&json!({"id":request_id,"method":"thread/start","params":{"cwd":cwd,"ephemeral":true,"config":{"model_catalog_json":path}}}));
                match sent {
                    Err(error) => Err(error),
                    Ok(()) => response(&mut process, request_id, deadline, "探测 Codex 模型目录").map(|_| ()),
                }
            }
        };
        request_id += 1;
        // 一轮可能耗掉原来的时限，每轮把截止点往后推，别让最后一个字段背整轮的锅。
        deadline = Instant::now() + Duration::from_secs(15);
        answers.push(outcome);
    }
    Ok(answers)
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
            // 只认 CLI 里真实存在过的线程名。`preview` 是首条消息的裸片段、没有名字时更不能
            // 拿 ID 冒充标题：那两个都和 Forge 的自动标题写法不同，列表每刷新一次就换一种字。
            let title = thread["name"].as_str().map(str::trim).filter(|name| !name.is_empty())
                .map(|name| name.chars().take(120).collect::<String>())
                .unwrap_or_default();
            Some(json!({"id":id,"title":title,"createdAt":thread["createdAt"].as_i64().unwrap_or_default().max(0) as u64 * 1000,"status":thread["status"]}))
        }));
        cursor = result["nextCursor"].clone();
        if cursor.is_null() { return Ok(threads); }
        if !cursor.is_string() || !cursors.insert(cursor.to_string()) { return Err("Codex 会话分页游标无效".into()); }
    }
    Err("Codex 会话列表超过分页上限".into())
}

/// 新建空 Codex thread，返回 CLI 原生 ID。不命名：占位名会写进 `session_index.jsonl`，
/// 而线程名在标题规则里优先级最高，等于把自动命名永久锁死成「Codex 会话 N」。
fn codex_thread_start_params(cwd: &str) -> Value {
    json!({"cwd":cwd,"dynamicTools":super::codex::Codex::task_tools()})
}
pub fn codex_create_thread(cwd: &str) -> Result<Value, String> {
    // dynamicTools 受 experimentalApi 门控，而且只能在 thread/start 注册；resume 无法补挂。
    let (mut process, deadline) = codex_management_process_with_experimental(cwd, "初始化 Codex 新会话", true)?;
    process.write(&json!({"id":2,"method":"thread/start","params":codex_thread_start_params(cwd)}))?;
    let result = response(&mut process, 2, deadline, "创建 Codex 会话")?;
    let id = result["thread"]["id"].as_str().ok_or("Codex 未返回 thread ID")?;
    Ok(json!({"id":id,"createdAt":result["thread"]["createdAt"].as_i64().unwrap_or_default().max(0) as u64 * 1000}))
}

pub fn codex_set_thread_name(cwd: &str, id: &str, title: &str) -> Result<(), String> {
    let (mut process, deadline) = codex_management_process(cwd, "初始化 Codex 会话重命名")?;
    process.write(&json!({"id":2,"method":"thread/name/set","params":{"threadId":id,"name":title}}))?;
    response(&mut process, 2, deadline, "重命名 Codex 会话")?;
    Ok(())
}
/// 在没有活动回合时通过短生命周期 app-server 修改 Goal，并回读服务端完整快照。
pub fn codex_set_goal_status(cwd: &str, thread_id: &str, status: &str) -> Result<Value, String> {
    if !matches!(status, "active" | "paused") {
        return Err("Goal 状态只允许 active 或 paused".into());
    }
    let (mut process, deadline) = codex_management_process(cwd, "初始化 Codex Goal 控制")?;
    process.write(&json!({"id":2,"method":"thread/goal/set","params":{
        "threadId":thread_id,"status":status,"origin":"user"
    }}))?;
    response(&mut process, 2, deadline, "修改 Codex Goal 状态")?;
    process.write(&json!({"id":3,"method":"thread/goal/get","params":{"threadId":thread_id}}))?;
    let result = response(&mut process, 3, deadline, "读取 Codex Goal 状态")?;
    result.get("goal").filter(|goal| goal.is_object()).cloned().ok_or("Codex 未返回 Goal".into())
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
        // 附加目录要并进生效策略而不是替换它，所以这几项也得读回来。
        "sandboxWritableRoots":config["sandbox_workspace_write"]["writable_roots"],
        "sandboxNetworkAccess":config["sandbox_workspace_write"]["network_access"],
        "sandboxExcludeTmpdir":config["sandbox_workspace_write"]["exclude_tmpdir_env_var"],
        "sandboxExcludeSlashTmp":config["sandbox_workspace_write"]["exclude_slash_tmp"],
    })
}

/// 附加目录在 Codex 侧的落点。`turn/start.sandboxPolicy` 是整份替换而不是追加：
/// 只把自己想加的目录发过去，会把用户项目里已配的 writable_roots 与 network_access 顶掉，
/// 所以这里读的必须是 `config/read` 算出来的生效值。
#[derive(Clone)]
pub enum SandboxGrant {
    /// 本轮按这份策略发送。只有 workspace-write 沙箱才有可写根目录这个位置。
    Policy(Value),
    /// 完全访问本来就覆盖这些目录，无需再发策略。
    AlreadyOpen,
    /// 当前沙箱收不下这些目录。必须把原因说给用户，不能让他点的授权静默蒸发。
    Unapplied(&'static str),
}

pub fn codex_sandbox_grant(config: &Value, permission: PermissionMode, dirs: &[String]) -> SandboxGrant {
    // Inherit 时本轮不发送沙箱覆盖，生效模式只能问 CLI；其余档位由本轮选择直接决定。
    let mode = if permission == PermissionMode::Inherit { config["sandboxMode"].as_str().unwrap_or("") } else { permission.codex_sandbox() };
    match mode {
        "danger-full-access" => SandboxGrant::AlreadyOpen,
        "read-only" => SandboxGrant::Unapplied("当前权限档是只读沙箱，附加目录本轮不会生效；要写入这些目录请改用「询问」或「自动」档。"),
        "workspace-write" => {
            let configured = config["sandboxWritableRoots"].as_array().into_iter().flatten().filter_map(Value::as_str);
            let mut roots: Vec<String> = Vec::new();
            for raw in configured.chain(dirs.iter().map(String::as_str)) {
                let path = raw.trim();
                if !path.is_empty() && !roots.iter().any(|kept| super::same_workspace_path(kept, path)) { roots.push(path.to_owned()); }
            }
            let mut policy = json!({ "type": "workspaceWrite", "writableRoots": roots });
            // 省略的字段由 CLI 按默认值解释，所以只回填项目里真配过的那几项：
            // 网络开关若被我们凭空写成 false，等于替用户关掉了联网。
            if let Some(access) = config["sandboxNetworkAccess"].as_bool() { policy["networkAccess"] = json!(access); }
            if let Some(value) = config["sandboxExcludeTmpdir"].as_bool() { policy["excludeTmpdirEnvVar"] = json!(value); }
            if let Some(value) = config["sandboxExcludeSlashTmp"].as_bool() { policy["excludeSlashTmp"] = json!(value); }
            SandboxGrant::Policy(policy)
        }
        _ => SandboxGrant::Unapplied("无法确认 Codex 当前生效的沙箱模式，附加目录本轮未生效；请重新发送以刷新项目配置。"),
    }
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
        if !value.is_null() { validate(value.as_str(), None)?; }
    }
    if let Some(value) = object.get("effort") {
        if !value.is_null() { validate(None, value.as_str())?; }
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
        // 模式档位是另一回事：`--help` 只是本地打印文本，现问一次就能让档位跟着 CLI 版本变。
        let mut catalog = defaults(provider);
        let discovered = ai_cli::runtime_command(provider, &["--help"])
            .and_then(|(command, version)| crate::ai_cli::process::checked_full(command).map(|help| (help, version)))
            .ok();
        // 模式和强度都是 CLI 亲口报的，各维独立采用；模型仍是别名，authoritative 不能跟着翻真。
        if let Some((help, version)) = discovered {
            if let Some(ids) = claude_mode_ids(&help) {
                catalog["modes"] = json!(ids);
                catalog["modesAuthoritative"] = json!(true);
            }
            if let Some(ids) = claude_effort_ids(&help) {
                catalog["efforts"] = json!(ids);
                catalog["effortsAuthoritative"] = json!(true);
            }
            // 版本只用于标注来源；解析不出来就留空（null），不影响启动。
            if !version.is_empty() { catalog["cliVersion"] = json!(version); }
        }
        return Ok(catalog);
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
            // 模式和模型在同一次刷新里一起问 CLI：CLI 升级后两件事一起跟着变。
            // 探测失败不判死刑，退回内置档位并把来源写成「未核实」。
            let (ids, probed) = match codex_mode_ids() {
                Ok(ids) => (ids, true),
                Err(_) => (mode_ids(&Value::Null, provider), false),
            };
            drop(process);
            let cli_version = if version.is_empty() { Value::Null } else { json!(version) };
            return Ok(json!({"models":models,"customModel":true,"efforts":[],"authoritative":true,"cliVersion":cli_version,
                "modes":ids,"modesAuthoritative":probed}));
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
    fn codex_thread_creation_registers_forge_task_tool() {
        // 预创建线程是 Forge 新会话的真实入口；动态工具必须在这里一次性注册。
        let params = codex_thread_start_params("D:/project");
        assert_eq!(params["cwd"], "D:/project");
        assert_eq!(params["dynamicTools"][0]["name"], "forge");
        assert_eq!(params["dynamicTools"][0]["tools"][0]["name"], "update_tasks");
    }
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
        // 只投影沙箱设置，凭据一律不带出：api_key 与 env 必须继续缺席。
        assert_eq!(project_config_fields(&json!({"config":{"model":"chosen","model_reasoning_effort":"high","sandbox_mode":"read-only","approval_policy":"on-request","api_key":"never-return","env":{"TOKEN":"secret"}}})),
            json!({"model":"chosen","effort":"high","serviceTier":null,"permission":"read","sandboxMode":"read-only","approvalPolicy":"on-request",
                "sandboxWritableRoots":null,"sandboxNetworkAccess":null,"sandboxExcludeTmpdir":null,"sandboxExcludeSlashTmp":null}));
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
    fn an_unknown_codex_model_gets_no_efforts_because_the_cli_never_reported_any() {
        // 档位是模型自己的事：Codex 没报过的档位列表不能由我们编一份给界面选。
        let document = json!({"catalogs":{"codex":{"models":[],"efforts":["none","minimal","low","medium","high","xhigh"]}},"customModels":{"codex":["gw/claude-opus"]}});
        assert_eq!(catalog_from(&document, Provider::Codex)["models"][0]["efforts"], json!([]));
        // Claude 的 `--effort` 是会话级参数，与别名指向哪个模型无关，所以照常给全表。
        let claude = json!({"catalogs":{"claude":{"models":[],"efforts":[]}},"customModels":{"claude":["gw/claude-opus"]}});
        assert_eq!(catalog_from(&claude, Provider::Claude)["models"][0]["efforts"].as_array().unwrap().len(), 5);
    }
    #[test]
    fn saving_a_bare_codex_model_id_is_redirected_to_the_catalog_editor() {
        let dir = std::env::temp_dir().join(format!("forge-codex-bare-id-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ai-models.json");
        let error = save_models(&path, Provider::Codex, None, Some("gw/claude-opus")).unwrap_err();
        assert!(error.contains("模型清单"), "要把用户领到能填参数的那个入口：{error}");
        // 已经存着的裸 ID 不能被这次改动清掉：旧配置继续能用，只是不再有添加入口。
        std::fs::write(&path, r#"{"customModels":{"codex":["gw/claude-opus"]},"catalogs":{"codex":{"models":[],"efforts":[]}}}"#).unwrap();
        assert_eq!(cached_models(&path, Provider::Codex)["customModels"], json!(["gw/claude-opus"]));
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn the_model_picker_follows_the_catalog_editor() {
        let discovered = json!({"models":[{"id":"gpt-5.5","name":"GPT-5.5","efforts":["low"]},{"id":"gpt-6-astra","name":"GPT-6 Astra","efforts":["medium"]}],"efforts":[],"customModels":[]});
        let patched = apply_picker_patch(discovered.clone(), Some(json!({"excluded":["gpt-6-astra"],"customs":[{"id":"gw/claude-opus","name":"网关 Opus","efforts":["low","high"]}]})));
        let ids = patched["models"].as_array().unwrap().iter().map(|model| model["id"].as_str().unwrap()).collect::<Vec<_>>();
        assert_eq!(ids, vec!["gpt-5.5", "gw/claude-opus"], "排除的要消失、新增的要能选");
        assert_eq!(patched["models"][1]["name"], "网关 Opus");
        assert_eq!(patched["models"][1]["efforts"], json!(["low", "high"]));
        // 没有定制时一个字节都不动；没有清单条目也不给编档位。
        assert_eq!(apply_picker_patch(discovered.clone(), None), discovered);
        let bare = apply_picker_patch(discovered.clone(), Some(json!({"excluded":[],"customs":[{"id":"gw/x","name":"X","efforts":[]}]})));
        assert_eq!(bare["models"].as_array().unwrap().len(), 3);
    }
    #[test]
    fn model_cache_preserves_custom_models_across_refresh_and_restart() {
        let dir = std::env::temp_dir().join(format!("forge-model-cache-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let path = dir.join("ai-models.json");
        assert!(cached_models(&path, Provider::Claude)["models"].as_array().unwrap().iter().any(|model| model["id"] == "sonnet"));
        // Codex 的裸 ID 添加入口已经收进「模型清单」，但历史配置必须继续读得到、删得掉。
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, r#"{"customModels":{"codex":["custom-codex"]}}"#).unwrap();
        save_models(&path, Provider::Claude, None, Some("custom-claude")).unwrap();
        assert!(save_models(&path, Provider::Codex, None, Some("another-codex")).is_err());
        assert_eq!(cached_models(&path, Provider::Codex)["customModels"], json!(["custom-codex"]));
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
    /// 帮助文本按列换行，choices 会横跨好几行；必须收全 CLI 报的取值，
    /// 只认第一行等于把新版 CLI 新增的模式永远藏起来。
    #[test]
    fn claude_modes_come_from_the_help_choices_across_wrapped_lines() {
        let help = "  --permission-mode <mode>              Permission mode to use for the session\n                                        (choices: \"acceptEdits\", \"auto\",\n                                        \"bypassPermissions\", \"manual\",\n                                        \"dontAsk\", \"plan\")\n  --profile <name>      another option\n";
        assert_eq!(claude_mode_ids(help).unwrap(), ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
        assert_eq!(claude_mode_ids("no options here"), None);
    }
    /// 强度档位也照抄 `--help`：新增一档不该等 Forge 发版才出现。
    #[test]
    fn claude_efforts_come_from_the_help_choices() {
        let help = "  --effort <level>                      Effort level for the current session\n                                        (low, medium, high, xhigh, max)\n  --environment <id>   another option\n";
        assert_eq!(claude_effort_ids(help).unwrap(), ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(claude_effort_ids("  --model <model>  no choices here\n"), None);
    }
    /// Codex 的模式取自 CLI 的序列化侧：收得下别名不等于那是个模式。
    /// 这份 fixture 就是 0.164.0 导出的形状；`code`/`execute`/`pair_programming`/`custom`
    /// 只在输入侧作为 `default` 的别名存在，混进列表就是给用户摆假档位。
    #[test]
    fn codex_modes_come_from_the_serialized_mode_kind() {
        let schema = json!({"definitions":{
            "ModeKind":{"enum":["plan","default"],"type":"string"},
            "CollaborationMode":{"properties":{"mode":{"$ref":"#/definitions/ModeKind"}}}
        }});
        assert_eq!(mode_ids_from_schema(&schema), ["plan", "default"]);
        assert!(mode_ids_from_schema(&json!({"definitions":{"ModeKind":{"enum":[]}}})).is_empty());
        assert!(mode_ids_from_schema(&json!({})).is_empty());
    }
    #[test]
    fn a_mode_is_sent_only_when_this_cli_reported_it() {
        let catalog = json!({"modes":["manual","plan","bypassPermissions"]});
        assert_eq!(canonical_mode(&catalog, Provider::Claude, Some("plan"), false, PermissionMode::Ask).unwrap(), "plan");
        // 用户记住的模式被新版 CLI 撤掉：报错让他重选，不能悄悄换成另一档权限跑起来。
        assert!(canonical_mode(&catalog, Provider::Claude, Some("dontAsk"), false, PermissionMode::Ask).is_err());
        // 不合白名单形状的字符串不参与任何比较，更进不了 argv。
        assert!(canonical_mode(&catalog, Provider::Claude, Some("--help"), false, PermissionMode::Ask).is_err());
        // 没带 mode 的旧请求按原语义映射；映射不到就退回这版 CLI 的正常档。
        assert_eq!(canonical_mode(&catalog, Provider::Claude, None, true, PermissionMode::Ask).unwrap(), "plan");
        assert_eq!(canonical_mode(&catalog, Provider::Claude, None, false, PermissionMode::Auto).unwrap(), "manual");
        assert_eq!(canonical_mode(&json!({}), Provider::Codex, None, true, PermissionMode::Inherit).unwrap(), "plan");
        assert_eq!(canonical_mode(&json!({}), Provider::Codex, None, false, PermissionMode::Full).unwrap(), "default");
    }
    #[test]
    fn granted_dirs_merge_into_the_effective_sandbox_instead_of_replacing_it() {
        let config = json!({"sandboxMode":"workspace-write","sandboxWritableRoots":["D:\\already"],"sandboxNetworkAccess":true});
        let granted = vec!["D:\\extra".to_owned(), "D:\\already".to_owned()];
        let SandboxGrant::Policy(policy) = codex_sandbox_grant(&config, PermissionMode::Inherit, &granted) else {
            panic!("workspace-write 沙箱必须给出策略");
        };
        // 项目里已配的可写根目录不能被一次授权顶掉，重复的那条只留一份。
        assert_eq!(policy["writableRoots"], json!(["D:\\already", "D:\\extra"]));
        // 省略字段会被 CLI 按默认值解释：网络开关不回填，就等于替用户关掉联网。
        assert_eq!(policy["networkAccess"], json!(true));
        assert!(policy.get("excludeSlashTmp").is_none());
        // 本轮显式选择压过项目配置：只读档收不下这些目录，但要说清楚，不能静默丢弃。
        assert!(matches!(codex_sandbox_grant(&config, PermissionMode::Read, &granted), SandboxGrant::Unapplied(_)));
        // 完全访问本来就覆盖这些目录，再发一份策略是多余且更窄的覆盖。
        assert!(matches!(codex_sandbox_grant(&config, PermissionMode::Full, &granted), SandboxGrant::AlreadyOpen));
        // Inherit 且生效模式读不出来时按最窄处理：不发策略，也不假装成功。
        assert!(matches!(codex_sandbox_grant(&json!({}), PermissionMode::Inherit, &granted), SandboxGrant::Unapplied(_)));
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
        assert!(validate(Some("--dangerous"), None).is_err());
        // 取值由 CLI 亲口报出的清单把关，形状不对才在本地拒绝。
        assert!(validate(Some("custom-model"), Some("has space")).is_err());
        assert!(validate(Some("provider.model-v1"), Some("max")).is_ok());
        let values=parse_models(&json!({"data":[{"model":"real","displayName":"Real","supportedReasoningEfforts":[{"reasoningEffort":"low"}],"defaultReasoningEffort":"low"},{"hidden":true}]})).unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0]["efforts"], json!(["low"]));
    }
}

