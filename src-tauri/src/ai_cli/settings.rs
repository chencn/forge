//! CLI 的启用状态、排序、环境变量与原生配置文件。
//!
//! 这里是「设置页管得住 CLI」的落点：启停与顺序是 Forge 自己的数据，
//! 环境变量在启动对话时注入，原生配置则直接读写 CLI 自己的配置文件，
//! 免得用户在 Forge 和 CLI 之间改两遍。
use super::process::{checked, command};
use super::{cached_status, home, Provider};
use crate::offload::block;
use crate::sys::write_atomic;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use tauri::{AppHandle, Manager};
use toml_edit::{value, Array, DocumentMut, Item, Table, Value};

/// Forge 自己的 CLI 设置文件，和全局设置放在同一个配置目录。
const SETTINGS_FILE: &str = "ai-cli.json";
/// 由 Forge 或系统掌管、不允许被用户覆盖的变量：改掉它们会让 Node/npm 解析不到。
const RESERVED_ENV: [&str; 7] = ["PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"];
/// 单个环境变量上限，挡住误粘贴的整份文件。
const MAX_ENV_VALUE: usize = 8 * 1024;

/// 一个 CLI 在设置页里的可编辑状态。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentSetting {
    /// 是否出现在会话工具条里；停用只影响新建，不打断已有会话。
    pub enabled: bool,
    /// 列表顺序；越小越靠前。
    pub sort_order: u32,
    /// 启动 CLI 时追加的环境变量。
    pub env: BTreeMap<String, String>,
    /// 绑定的模型供应商 id；空表示没绑定。绑定只记录来源，端点与密钥由「应用」写进 CLI 配置。
    pub provider: String,
}

impl Default for AgentSetting {
    fn default() -> Self {
        Self { enabled: true, sort_order: 0, env: BTreeMap::new(), provider: String::new() }
    }
}

/// 整份 CLI 设置。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    pub agents: BTreeMap<String, AgentSetting>,
}

impl Default for Settings {
    fn default() -> Self { Self { version: 1, agents: BTreeMap::new() } }
}

/// 原生配置文件的内容。读失败时 `error` 非空，界面据此提示而不是当成空文件。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    pub path: String,
    pub exists: bool,
    pub content: String,
    pub error: Option<String>,
}

/// Claude Code 的 `settings.json` 里由设置页管理的 `env` 对象。
/// `env` 是原生文件与 Forge 覆盖层合并后的有效值，同名时以原生文件为准——
/// CLI 会把自己 settings 里的 env 应用到进程，比父进程注入的变量更晚生效。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSettings {
    pub path: String,
    pub exists: bool,
    pub error: Option<String>,
    pub env: BTreeMap<String, String>,
}

/// 一条本地检查；`id` 由前端换成当前语言的标题。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub id: &'static str,
    pub status: &'static str,
    pub value: Option<String>,
    pub hint: Option<String>,
}

/// `approval_policy = "granular"` 时展开的五个开关。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CodexGranular {
    pub sandbox_approval: bool,
    pub rules: bool,
    pub skill_approval: bool,
    pub request_permissions: bool,
    pub mcp_elicitations: bool,
}

impl Default for CodexGranular {
    fn default() -> Self {
        Self { sandbox_approval: true, rules: true, skill_approval: false, request_permissions: false, mcp_elicitations: true }
    }
}

/// Codex 的 config.toml 里由设置页结构化管理的字段。
/// 空字符串表示「没有写这个键」，让 Codex 用自己的默认值。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CodexSettings {
    pub model: String,
    pub model_provider: Option<String>,
    pub approval_policy: String,
    pub sandbox_mode: String,
    pub writable_roots: Vec<String>,
    pub network_access: bool,
    pub exclude_tmpdir_env_var: bool,
    pub exclude_slash_tmp: bool,
    pub granular: CodexGranular,
    pub default_mode_request_user_input: bool,
    /// 推理档位。合法值由 `codex debug models` 的 `supported_reasoning_levels` 给出，
    /// 这里只限字符集与长度，避免把界面上拿到的真实档位写坏。
    pub model_reasoning_effort: String,
    pub model_reasoning_summary: String,
    pub model_verbosity: String,
    pub model_context_window: Option<i64>,
    pub model_auto_compact_token_limit: Option<i64>,
    pub web_search: String,
    pub history_persistence: String,
    pub history_max_bytes: Option<i64>,
    pub shell_env_inherit: String,
    /// 仅 Windows：`[windows].sandbox`。
    pub windows_sandbox: String,
    /// 配置文件里的 provider 有 `supports_websockets` 时才有值。
    pub supports_websockets: Option<bool>,
    /// `[model_providers.<id>]` 是否已在文件里。不在时不能替用户新建：
    /// 内置 ID（openai / ollama / lmstudio）一旦被写进 model_providers，Codex 会拒绝整份配置。
    pub provider_defined: bool,
    /// `default_permissions` 存在时 Codex 会忽略 `sandbox_mode`，界面据此提示。
    pub shadowed: bool,
    /// 文件里是否有 `[permissions]` 段落：它和 `sandbox_mode` 同属两套权限表达，不能并存。
    pub permissions_defined: bool,
    /// 生效的 API 端点：config.toml 里 provider 的 base_url 优先，其次才是 Forge 覆盖层。
    pub api_base_url: String,
    /// 生效的 API Key：Forge 覆盖层优先，其次是 `auth.json` 里的 OPENAI_API_KEY。
    pub api_key: String,
    /// `auth.json` 读不出来时非空；界面提示用户手动修复，不把它当成未登录。
    pub auth_error: Option<String>,
}

impl Default for CodexSettings {
    fn default() -> Self {
        Self {
            model: String::new(),
            model_provider: None,
            approval_policy: String::new(),
            sandbox_mode: String::new(),
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
            granular: CodexGranular::default(),
            default_mode_request_user_input: false,
            model_reasoning_effort: String::new(),
            model_reasoning_summary: String::new(),
            model_verbosity: String::new(),
            model_context_window: None,
            model_auto_compact_token_limit: None,
            web_search: String::new(),
            history_persistence: String::new(),
            history_max_bytes: None,
            shell_env_inherit: String::new(),
            windows_sandbox: String::new(),
            supports_websockets: None,
            provider_defined: false,
            shadowed: false,
            permissions_defined: false,
            api_base_url: String::new(),
            api_key: String::new(),
            auth_error: None,
        }
    }
}

fn diagnostic(id: &'static str, status: &'static str, value: Option<String>, hint: Option<String>) -> Diagnostic {
    Diagnostic { id, status, value, hint }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
    Ok(dir.join(SETTINGS_FILE))
}

/// 补齐缺失的 provider、丢弃未知键，并按顺序写回默认 sortOrder。
fn normalize(settings: &mut Settings) {
    settings.version = 1;
    let mut agents = BTreeMap::new();
    for (index, provider) in Provider::all().into_iter().enumerate() {
        // 只在缺少条目时补默认顺序；用户把 Codex 拖到第一位（sortOrder 0）不能被改回去。
        let item = settings.agents.remove(provider.key()).unwrap_or_else(|| AgentSetting { sort_order: index as u32, ..AgentSetting::default() });
        agents.insert(provider.key().to_string(), item);
    }
    settings.agents = agents;
}

/// 读设置。文件不存在或读坏了都退回默认值：坏一份设置不能把 CLI 全锁死。
pub fn load(app: &AppHandle) -> Result<Settings, String> {
    let path = settings_path(app)?;
    let mut settings = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .unwrap_or_default();
    normalize(&mut settings);
    Ok(settings)
}

fn validate_env(env: &BTreeMap<String, String>) -> Result<BTreeMap<String, String>, String> {
    let mut clean = BTreeMap::new();
    for (key, value) in env {
        let key = key.trim();
        let valid_key = !key.is_empty() && key.len() <= 128
            && key.bytes().enumerate().all(|(index, byte)| {
                byte.is_ascii_alphabetic() || byte == b'_' || (index > 0 && (byte.is_ascii_digit() || byte == b'.' || byte == b'-'))
            });
        if !valid_key {
            return Err(format!("环境变量名无效：{key}"));
        }
        if RESERVED_ENV.iter().any(|reserved| reserved.eq_ignore_ascii_case(key)) {
            return Err(format!("{} 由 Forge 或系统管理，不能覆盖", key.to_ascii_uppercase()));
        }
        if value.len() > MAX_ENV_VALUE || value.contains('\0') {
            return Err(format!("环境变量 {key} 的值过长或包含非法字符"));
        }
        clean.insert(key.to_string(), value.clone());
    }
    Ok(clean)
}

/// 供应商绑定只记录来源，真正写盘由 `ai_providers_apply` 负责；
/// id 由前端从清单里选，这里去空白并按供应商存储的上限挡住，别让它变成任意长字符串的落脚点。
fn validate_binding(item: &mut AgentSetting) -> Result<(), String> {
    item.provider = item.provider.trim().to_string();
    if item.provider.len() > 64 {
        return Err("绑定的供应商 ID 过长".into());
    }
    Ok(())
}

pub(crate) fn save(app: &AppHandle, mut settings: Settings) -> Result<Settings, String> {
    normalize(&mut settings);
    for item in settings.agents.values_mut() {
        item.env = validate_env(&item.env)?;
        validate_binding(item)?;
    }
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("无法创建设置目录：{error}"))?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    write_atomic(&path, &text)?;
    // 环境变量在启动对话时从这里取，保存后立刻生效，不必等重启。
    for provider in Provider::all() {
        if let Some(item) = settings.agents.get(provider.key()) {
            publish(provider, item.env.clone());
        }
    }
    Ok(settings)
}

#[tauri::command]
pub async fn ai_cli_settings_load(app: AppHandle) -> Result<Settings, String> {
    block(move || load(&app)).await
}

#[tauri::command]
pub async fn ai_cli_settings_save(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    block(move || save(&app, settings)).await
}

/// 环境变量缓存：`runtime_command` 拿不到 AppHandle，启动命令时从这里读。
static ENVIRONMENT: RwLock<Vec<(Provider, BTreeMap<String, String>)>> = RwLock::new(Vec::new());

fn publish(provider: Provider, env: BTreeMap<String, String>) {
    let mut cache = ENVIRONMENT.write().unwrap_or_else(|error| error.into_inner());
    cache.retain(|(item, _)| *item != provider);
    cache.push((provider, env));
}

/// 启动时把已保存的环境变量装进缓存；后续保存会覆盖。
pub(crate) fn init(app: &AppHandle) {
    if let Ok(settings) = load(app) {
        for provider in Provider::all() {
            publish(provider, settings.agents.get(provider.key()).map(|item| item.env.clone()).unwrap_or_default());
        }
    }
}

/// 某个 CLI 启动时要注入的变量。克隆一份，避免调用方持锁跨进程操作。
pub(crate) fn environment(provider: Provider) -> Vec<(String, String)> {
    let cache = ENVIRONMENT.read().unwrap_or_else(|error| error.into_inner());
    cache.iter().find(|(item, _)| *item == provider)
        .map(|(_, env)| env.iter()
            .filter(|(key, _)| !RESERVED_ENV.iter().any(|reserved| reserved.eq_ignore_ascii_case(key.as_str())))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect())
        .unwrap_or_default()
}

/// 该 CLI 是否启用。读失败按启用处理，宁可多一个入口也不让设置故障挡住会话。
pub(crate) fn enabled(app: &AppHandle, provider: Provider) -> bool {
    load(app).ok().and_then(|settings| settings.agents.get(provider.key()).map(|item| item.enabled)).unwrap_or(true)
}

/// CLI 自己的配置文件：Claude 是 settings.json，Codex 是 config.toml，
/// 目录可通过 CLAUDE_CONFIG_DIR / CODEX_HOME 改写，和 CLI 的解析规则一致。
pub(crate) fn config_path(provider: Provider) -> Result<PathBuf, String> {
    match provider {
        Provider::Claude => {
            if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).filter(|path| path.is_absolute()) {
                return Ok(dir.join("settings.json"));
            }
            Ok(home()?.join(".claude/settings.json"))
        }
        Provider::Codex => {
            if let Some(dir) = std::env::var_os("CODEX_HOME").map(PathBuf::from).filter(|path| path.is_absolute()) {
                return Ok(dir.join("config.toml"));
            }
            Ok(home()?.join(".codex/config.toml"))
        }
    }
}

fn read_config(provider: Provider) -> ConfigFile {
    let path = match config_path(provider) {
        Ok(path) => path,
        Err(error) => return ConfigFile { path: String::new(), exists: false, content: String::new(), error: Some(error) },
    };
    let shown = path.to_string_lossy().into_owned();
    if !path.exists() {
        return ConfigFile { path: shown, exists: false, content: String::new(), error: None };
    }
    match fs::read_to_string(&path) {
        Ok(content) => ConfigFile { path: shown, exists: true, content, error: None },
        Err(error) => ConfigFile { path: shown, exists: true, content: String::new(), error: Some(format!("读取配置失败：{error}")) },
    }
}

/// 保存前先按文件格式解析一遍：写坏了 CLI 下次启动就会报错，不如在这里挡住。
fn validate_config(provider: Provider, content: &str) -> Result<(), String> {
    match provider {
        Provider::Claude => {
            let value: serde_json::Value = serde_json::from_str(content).map_err(|error| format!("JSON 格式错误：{error}"))?;
            if !value.is_object() { return Err("Claude 配置必须是 JSON 对象".into()); }
        }
        Provider::Codex => {
            let value: toml::Value = toml::from_str(content).map_err(|error| format!("TOML 格式错误：{error}"))?;
            if !value.is_table() { return Err("Codex 配置必须是 TOML 表".into()); }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_cli_config_read(provider: Provider) -> Result<ConfigFile, String> {
    block(move || Ok(read_config(provider))).await
}

/// 覆盖 CLI 自己的全局配置前留一份备份，改错时用户能退回去。
pub(crate) fn backup_and_write(path: &Path, content: &str) -> Result<(), String> {
    if path.exists() {
        let backup = PathBuf::from(format!("{}.forge.bak", path.display()));
        fs::copy(path, &backup).map_err(|error| format!("备份原配置失败：{error}"))?;
    }
    write_atomic(path, content)
}

#[tauri::command]
pub async fn ai_cli_config_write(provider: Provider, content: String) -> Result<ConfigFile, String> {
    block(move || {
        if content.trim().is_empty() { return Err("配置内容不能为空".into()); }
        validate_config(provider, &content)?;
        let path = config_path(provider)?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|error| format!("无法创建配置目录：{error}"))?;
        }
        backup_and_write(&path, &content)?;
        Ok(read_config(provider))
    }).await
}

/// 只取 `env` 里的字符串值；其他类型保持原样留在文件中，但设置页不展示也不改写。
fn parse_claude_env(text: &str) -> Result<BTreeMap<String, String>, String> {
    if text.trim().is_empty() { return Ok(BTreeMap::new()); }
    let value: serde_json::Value = serde_json::from_str(text).map_err(|error| format!("JSON 格式错误：{error}"))?;
    let Some(object) = value.as_object() else { return Err("Claude 配置必须是 JSON 对象".into()) };
    let Some(env) = object.get("env") else { return Ok(BTreeMap::new()) };
    let Some(table) = env.as_object() else { return Err("settings.json 的 env 必须是对象".into()) };
    Ok(table.iter().filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), text.to_string()))).collect())
}

/// 读 Claude 的有效环境变量：Forge 覆盖层打底，原生 settings.json 覆盖同名键。
/// 文件读坏时保留覆盖层的值并上报错误，界面能显示原因而不是假装没有本地配置。
pub(crate) fn read_claude_settings_at(path: &Path) -> ClaudeSettings {
    let mut env: BTreeMap<String, String> = environment(Provider::Claude).into_iter().collect();
    let exists = path.exists();
    let mut error = None;
    if exists {
        match fs::read_to_string(path) {
            Ok(text) => match parse_claude_env(&text) {
                Ok(native) => env.extend(native),
                Err(message) => error = Some(message),
            },
            Err(read_error) => error = Some(format!("读取 Claude 配置失败：{read_error}")),
        }
    }
    ClaudeSettings { path: path.to_string_lossy().into_owned(), exists, error, env }
}

/// 把设置页管理的变量写进 `settings.json` 的 `env`，其余键（权限、hooks 等）原样保留。
/// 空值表示删除该键；文件不存在且没有要写的值时不会创建文件。
pub(crate) fn save_claude_settings_at(path: &Path, env: BTreeMap<String, String>) -> Result<(), String> {
    let env = validate_env(&env)?;
    let existing = if path.exists() {
        fs::read_to_string(path).map_err(|error| format!("读取 Claude 配置失败：{error}"))?
    } else {
        String::new()
    };
    let mut root: serde_json::Value = if existing.trim().is_empty() {
        serde_json::json!({})
    } else {
        let value: serde_json::Value = serde_json::from_str(&existing).map_err(|error| format!("JSON 格式错误：{error}"))?;
        if !value.is_object() { return Err("Claude 配置必须是 JSON 对象".into()); }
        value
    };
    let object = root.as_object_mut().ok_or("Claude 配置必须是 JSON 对象")?;
    let changed = !env.values().all(|value| value.trim().is_empty());
    if !object.contains_key("env") && !changed { return Ok(()); }
    let entry = object.entry("env").or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let table = entry.as_object_mut().ok_or("settings.json 的 env 必须是对象")?;
    for (key, value) in &env {
        let trimmed = value.trim();
        if trimmed.is_empty() { table.remove(key); } else { table.insert(key.clone(), serde_json::Value::String(trimmed.to_string())); }
    }
    if table.is_empty() { object.remove("env"); }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    backup_and_write(path, &serde_json::to_string_pretty(&root).map_err(|error| error.to_string())?)
}

#[tauri::command]
pub async fn ai_cli_claude_settings_read() -> Result<ClaudeSettings, String> {
    block(move || Ok(read_claude_settings_at(&config_path(Provider::Claude)?))).await
}

#[tauri::command]
pub async fn ai_cli_claude_settings_save(env: BTreeMap<String, String>) -> Result<ClaudeSettings, String> {
    block(move || {
        let path = config_path(Provider::Claude)?;
        save_claude_settings_at(&path, env)?;
        Ok(read_claude_settings_at(&path))
    }).await
}

/// 读 Codex 的 API Key。文件损坏时报错但不阻断其余字段的编辑。
fn read_codex_auth(path: &Path) -> (String, Option<String>) {
    if !path.exists() { return (String::new(), None); }
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => return (String::new(), Some(format!("读取 auth.json 失败：{error}"))),
    };
    if text.trim().is_empty() { return (String::new(), None); }
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => return (String::new(), Some(format!("auth.json 格式错误：{error}"))),
    };
    let Some(object) = value.as_object() else { return (String::new(), Some("auth.json 必须是 JSON 对象".into())) };
    let key = object.get("OPENAI_API_KEY").and_then(|item| item.as_str()).unwrap_or_default().trim().to_string();
    (key, None)
}

/// 预演保存 auth.json 的结果。返回 `None` 表示无需改动：
/// 文件不存在，或文件本来就没在管 OPENAI_API_KEY/auth_mode（例如只有 ChatGPT 登录凭据）。
fn plan_codex_auth(path: &Path, api_key: &str) -> Result<Option<String>, String> {
    if !path.exists() { return Ok(None); }
    let text = fs::read_to_string(path).map_err(|error| format!("读取 auth.json 失败：{error}"))?;
    if text.trim().is_empty() { return Ok(None); }
    let mut value: serde_json::Value = serde_json::from_str(&text).map_err(|error| format!("auth.json 格式错误：{error}"))?;
    let Some(object) = value.as_object_mut() else { return Err("auth.json 必须是 JSON 对象".into()) };
    let key = api_key.trim();
    let has_key = object.contains_key("OPENAI_API_KEY");
    if key.is_empty() {
        if !has_key && !object.contains_key("auth_mode") { return Ok(None); }
        // 订阅模式：Codex 依据 auth_mode 走 ChatGPT 登录；保留 tokens 等其他字段。
        object.insert("auth_mode".into(), serde_json::json!("chatgpt"));
        if has_key { object.insert("OPENAI_API_KEY".into(), serde_json::Value::Null); }
    } else {
        if !has_key { return Ok(None); }
        object.insert("OPENAI_API_KEY".into(), serde_json::json!(key));
        object.remove("auth_mode");
    }
    Ok(Some(serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?))
}

fn codex_auth_path() -> Result<PathBuf, String> {
    let path = config_path(Provider::Codex)?;
    path.parent().map(|dir| dir.join("auth.json")).ok_or_else(|| "Codex 配置目录无效".to_string())
}

/// 读 Codex 的结构化配置。文件不存在时返回全默认值，界面按「留空」展示。
/// 端点优先取 config.toml 里 provider 的 base_url；密钥优先取 Forge 覆盖层，其次 auth.json。
fn read_codex_settings() -> Result<CodexSettings, String> {
    let path = config_path(Provider::Codex)?;
    let mut settings = read_codex_settings_at(&path)?;
    let overlay: BTreeMap<String, String> = environment(Provider::Codex).into_iter().collect();
    let overlay_value = |key: &str| overlay.get(key).map(|value| value.trim().to_string()).unwrap_or_default();
    // config.toml 里显式声明的 provider 优先：Codex 会按它路由，覆盖层的 OPENAI_BASE_URL 只是后备。
    if settings.api_base_url.trim().is_empty() {
        settings.api_base_url = overlay_value("OPENAI_BASE_URL");
    }
    let (key, error) = read_codex_auth(&codex_auth_path()?);
    settings.api_key = if !overlay_value("OPENAI_API_KEY").is_empty() { overlay_value("OPENAI_API_KEY") } else { key };
    settings.auth_error = error;
    Ok(settings)
}

pub(crate) fn read_codex_settings_at(path: &Path) -> Result<CodexSettings, String> {
    let mut settings = CodexSettings::default();
    if !path.exists() {
        return Ok(settings);
    }
    let text = fs::read_to_string(&path).map_err(|error| format!("读取 Codex 配置失败：{error}"))?;
    if text.trim().is_empty() {
        return Ok(settings);
    }
    let parsed: toml::Value = toml::from_str(&text).map_err(|error| format!("TOML 格式错误：{error}"))?;
    let Some(root) = parsed.as_table() else { return Ok(settings) };

    settings.model = root.get("model").and_then(|item| item.as_str()).unwrap_or_default().to_string();
    settings.model_provider = root.get("model_provider").and_then(|item| item.as_str()).map(str::to_string);
    match root.get("approval_policy") {
        Some(toml::Value::String(policy)) => settings.approval_policy = policy.clone(),
        Some(toml::Value::Table(table)) => {
            settings.approval_policy = "granular".into();
            let flag = |key: &str, fallback: bool| table.get(key).and_then(|item| item.as_bool()).unwrap_or(fallback);
            settings.granular = CodexGranular {
                sandbox_approval: flag("sandbox_approval", true),
                rules: flag("rules", true),
                skill_approval: flag("skill_approval", false),
                request_permissions: flag("request_permissions", false),
                mcp_elicitations: flag("mcp_elicitations", true),
            };
        }
        _ => {}
    }
    settings.sandbox_mode = root.get("sandbox_mode").and_then(|item| item.as_str()).unwrap_or_default().to_string();
    if let Some(table) = root.get("sandbox_workspace_write").and_then(|item| item.as_table()) {
        settings.writable_roots = table.get("writable_roots")
            .and_then(|item| item.as_array())
            .map(|roots| roots.iter().filter_map(|root| root.as_str()).map(str::to_string).collect())
            .unwrap_or_default();
        let flag = |key: &str| table.get(key).and_then(|item| item.as_bool()).unwrap_or(false);
        settings.network_access = flag("network_access");
        settings.exclude_tmpdir_env_var = flag("exclude_tmpdir_env_var");
        settings.exclude_slash_tmp = flag("exclude_slash_tmp");
    }
    settings.default_mode_request_user_input = root.get("features")
        .and_then(|item| item.as_table())
        .and_then(|table| table.get("default_mode_request_user_input"))
        .and_then(|item| item.as_bool())
        .unwrap_or(false);
    let text = |key: &str| root.get(key).and_then(|item| item.as_str()).unwrap_or_default().to_string();
    settings.model_reasoning_effort = text("model_reasoning_effort");
    settings.model_reasoning_summary = text("model_reasoning_summary");
    settings.model_verbosity = text("model_verbosity");
    settings.web_search = text("web_search");
    let number = |key: &str| root.get(key).and_then(|item| item.as_integer());
    settings.model_context_window = number("model_context_window");
    settings.model_auto_compact_token_limit = number("model_auto_compact_token_limit");
    if let Some(history) = root.get("history").and_then(|item| item.as_table()) {
        settings.history_persistence = history.get("persistence")
            .and_then(|item| item.as_str()).unwrap_or_default().to_string();
        settings.history_max_bytes = history.get("max_bytes").and_then(|item| item.as_integer());
    }
    settings.shell_env_inherit = root.get("shell_environment_policy")
        .and_then(|item| item.as_table())
        .and_then(|table| table.get("inherit"))
        .and_then(|item| item.as_str())
        .unwrap_or_default().to_string();
    settings.windows_sandbox = root.get("windows")
        .and_then(|item| item.as_table())
        .and_then(|table| table.get("sandbox"))
        .and_then(|item| item.as_str())
        .unwrap_or_default().to_string();
    settings.permissions_defined = root.contains_key("permissions");
    settings.shadowed = root.contains_key("default_permissions") || settings.permissions_defined;
    if let Some(provider) = settings.model_provider.as_deref() {
        let table = root.get("model_providers")
            .and_then(|item| item.as_table())
            .and_then(|providers| providers.get(provider))
            .and_then(|item| item.as_table());
        settings.provider_defined = table.is_some();
        settings.supports_websockets = table
            .and_then(|table| table.get("supports_websockets"))
            .and_then(|item| item.as_bool());
        settings.api_base_url = table
            .and_then(|table| table.get("base_url"))
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string();
    }
    Ok(settings)
}

fn is_absolute_root(value: &str) -> bool {
    if value.starts_with('/') || value.starts_with("\\\\") {
        return true;
    }
    let bytes = value.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// 保存前挡住会让 Codex 拒绝启动的值；相对路径会被 Codex 解析到 CODEX_HOME，必须拒绝。
/// 下面的枚举一律以 `codex -c <键>=__probe__` 的报错为准，不猜。
fn validate_codex_settings(settings: &CodexSettings) -> Result<(), String> {
    const POLICIES: [&str; 5] = ["on-request", "on-failure", "untrusted", "never", "granular"];
    const MODES: [&str; 3] = ["read-only", "workspace-write", "danger-full-access"];
    const SUMMARIES: [&str; 4] = ["auto", "concise", "detailed", "none"];
    const VERBOSITIES: [&str; 3] = ["low", "medium", "high"];
    const WEB_SEARCH: [&str; 4] = ["disabled", "cached", "indexed", "live"];
    const PERSISTENCE: [&str; 2] = ["save-all", "none"];
    const INHERIT: [&str; 3] = ["core", "all", "none"];
    const WINDOWS_SANDBOX: [&str; 3] = ["elevated", "unelevated", "mxc"];
    const EFFORT: &str = "low、medium、high 等档位由 Codex 的模型清单给出";
    fn check(value: &str, allowed: &[&str], name: &str) -> Result<(), String> {
        if value.is_empty() || allowed.contains(&value) { return Ok(()); }
        Err(format!("无效的{name}：{value}（可用值：{}）", allowed.join("、")))
    }
    if !settings.approval_policy.is_empty() && !POLICIES.contains(&settings.approval_policy.as_str()) {
        return Err(format!("无效的审批策略：{}", settings.approval_policy));
    }
    if !settings.sandbox_mode.is_empty() && !MODES.contains(&settings.sandbox_mode.as_str()) {
        return Err(format!("无效的沙箱模式：{}", settings.sandbox_mode));
    }
    check(&settings.model_reasoning_summary, &SUMMARIES, "推理摘要")?;
    check(&settings.model_verbosity, &VERBOSITIES, "简洁度")?;
    check(&settings.web_search, &WEB_SEARCH, "联网搜索")?;
    check(&settings.history_persistence, &PERSISTENCE, "历史保存")?;
    check(&settings.shell_env_inherit, &INHERIT, "环境变量继承")?;
    check(&settings.windows_sandbox, &WINDOWS_SANDBOX, "Windows 沙箱")?;
    if settings.model_reasoning_effort.len() > 32
        || !settings.model_reasoning_effort.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')) {
        return Err(format!("无效的推理档位：{}（{EFFORT}，只允许小写字母、数字、- 和 _）", settings.model_reasoning_effort));
    }
    for (name, value) in [("上下文窗口", settings.model_context_window),
        ("自动压缩阈值", settings.model_auto_compact_token_limit),
        ("历史上限字节", settings.history_max_bytes)] {
        if value.is_some_and(|number| number <= 0 || number > 1_000_000_000_000) {
            return Err(format!("无效的{name}：必须是 1 到 10000 亿之间的整数"));
        }
    }
    if settings.model.len() > 200 || settings.model.contains('\0') {
        return Err("模型名称过长或包含非法字符".into());
    }
    if settings.api_base_url.len() > 2048 || settings.api_base_url.contains('\0') {
        return Err("API 地址过长或包含非法字符".into());
    }
    if settings.api_key.len() > MAX_ENV_VALUE || settings.api_key.contains('\0') {
        return Err("API Key 过长或包含非法字符".into());
    }
    if settings.writable_roots.len() > 64 {
        return Err("可写目录过多".into());
    }
    for root in &settings.writable_roots {
        let trimmed = root.trim();
        if trimmed.len() > 1024 || trimmed.contains('\0') {
            return Err("可写目录过长或包含非法字符".into());
        }
        if !is_absolute_root(trimmed) {
            return Err(format!("可写目录必须是绝对路径：{trimmed}"));
        }
    }
    Ok(())
}

fn table_entry<'a>(doc: &'a mut DocumentMut, key: &str) -> Result<&'a mut Table, String> {
    let item = doc.entry(key).or_insert(Item::Table(Table::new()));
    item.as_table_mut().ok_or_else(|| format!("{key} 必须是 TOML 表"))
}

/// 覆盖一个键的值，同时保住它原有的注释和排版：
/// 直接 `insert` 会连前导注释一起换掉，用户手写的说明就没了。
fn put(table: &mut Table, key: &str, next: Value) {
    match table.get_mut(key).and_then(|item| item.as_value_mut()) {
        Some(existing) => {
            let decor = existing.decor().clone();
            *existing = next;
            *existing.decor_mut() = decor;
        },
        None => { table.insert(key.into(), Item::Value(next)); },
    }
}

/// 键值为空时删掉键，让 Codex 用自己的默认值——写 `= ""` 会被当成显式空值。
fn patch_str(table: &mut Table, key: &str, text: &str) {
    let trimmed = text.trim();
    if trimmed.is_empty() { table.remove(key); } else { put(table, key, trimmed.into()); }
}

/// 顶层整数键：None 删键。
fn patch_top_int(doc: &mut DocumentMut, key: &str, number: Option<i64>) {
    match number {
        Some(n) => put(doc.as_table_mut(), key, n.into()),
        None => { doc.as_table_mut().remove(key); }
    }
}

/// 写 `[segment].key`：空值删键，段落被清空后连段落一起删，避免留下 Codex 会误读的空表。
fn patch_str_in(doc: &mut DocumentMut, segment: &str, key: &str, text: &str) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() { return prune_key(doc, segment, key); }
    put(table_entry(doc, segment)?, key, trimmed.into());
    Ok(())
}

/// 写 `[segment].key = <bool>`：false 删键（Codex 的开关默认值不一定等于 false）。
fn patch_bool_in(doc: &mut DocumentMut, segment: &str, key: &str, flag: bool) -> Result<(), String> {
    if flag { put(table_entry(doc, segment)?, key, true.into()); } else { prune_key(doc, segment, key)?; }
    Ok(())
}

/// 写 `[segment].key = <整数>`：None 删键并做空段落清理。
fn patch_int_in(doc: &mut DocumentMut, segment: &str, key: &str, number: Option<i64>) -> Result<(), String> {
    match number {
        Some(n) => put(table_entry(doc, segment)?, key, n.into()),
        None => prune_key(doc, segment, key)?,
    }
    Ok(())
}

fn prune_key(doc: &mut DocumentMut, segment: &str, key: &str) -> Result<(), String> {
    let emptied = match doc.get_mut(segment) {
        Some(item) => {
            let Some(table) = item.as_table_mut() else { return Err(format!("{segment} 必须是 TOML 表")); };
            table.remove(key);
            table.is_empty()
        },
        None => false,
    };
    if emptied { doc.as_table_mut().remove(segment); }
    Ok(())
}

/// 只同步文件里已存在的 `[model_providers.<id>]`：内置 ID（openai、ollama、lmstudio）
/// 一旦被写进 model_providers，Codex 会整份配置报错「Built-in providers cannot be overridden」。
fn existing_provider_table<'a>(doc: &'a mut DocumentMut, provider: &str) -> Option<&'a mut Table> {
    doc.get_mut("model_providers")
        .and_then(|item| item.as_table_mut())
        .and_then(|providers| providers.get_mut(provider))
        .and_then(|item| item.as_table_mut())
}

/// 只改动设置页管理的键，保留用户手写的其余内容和注释。
/// auth.json 的改动先预演再落盘：格式错误时不会出现「config.toml 已改、auth 没改」的半成品。
fn save_codex_settings(settings: CodexSettings) -> Result<CodexSettings, String> {
    validate_codex_settings(&settings)?;
    let auth_path = codex_auth_path()?;
    let planned_auth = plan_codex_auth(&auth_path, &settings.api_key)?;
    save_codex_settings_at(&config_path(Provider::Codex)?, settings)?;
    if let Some(content) = planned_auth {
        backup_and_write(&auth_path, &content)?;
    }
    read_codex_settings()
}

pub(crate) fn save_codex_settings_at(path: &Path, settings: CodexSettings) -> Result<CodexSettings, String> {
    validate_codex_settings(&settings)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    let existing = if path.exists() {
        fs::read_to_string(path).map_err(|error| format!("读取 Codex 配置失败：{error}"))?
    } else {
        String::new()
    };
    let mut doc: DocumentMut = existing.parse().map_err(|error| format!("TOML 格式错误：{error}"))?;

    let model = settings.model.trim();
    patch_str(doc.as_table_mut(), "model", model);
    patch_str(doc.as_table_mut(), "model_reasoning_effort", &settings.model_reasoning_effort);

    match settings.approval_policy.as_str() {
        "" => { doc.as_table_mut().remove("approval_policy"); }
        "granular" => {
            let mut granular = Table::new();
            granular["sandbox_approval"] = value(settings.granular.sandbox_approval);
            granular["rules"] = value(settings.granular.rules);
            granular["skill_approval"] = value(settings.granular.skill_approval);
            granular["request_permissions"] = value(settings.granular.request_permissions);
            granular["mcp_elicitations"] = value(settings.granular.mcp_elicitations);
            doc["approval_policy"] = Item::Table(granular);
        }
        policy => put(doc.as_table_mut(), "approval_policy", policy.into()),
    }

    patch_str(doc.as_table_mut(), "sandbox_mode", &settings.sandbox_mode);
    patch_str(doc.as_table_mut(), "model_reasoning_summary", &settings.model_reasoning_summary);
    patch_str(doc.as_table_mut(), "model_verbosity", &settings.model_verbosity);
    patch_str(doc.as_table_mut(), "web_search", &settings.web_search);
    patch_top_int(&mut doc, "model_context_window", settings.model_context_window);
    patch_top_int(&mut doc, "model_auto_compact_token_limit", settings.model_auto_compact_token_limit);
    patch_str_in(&mut doc, "shell_environment_policy", "inherit", &settings.shell_env_inherit)?;
    patch_str_in(&mut doc, "history", "persistence", &settings.history_persistence)?;
    patch_int_in(&mut doc, "history", "max_bytes", settings.history_max_bytes)?;
    // 只在 Windows 上写 `[windows].sandbox`；其它平台写了也不生效，反而留下无意义的段落。
    if cfg!(windows) { patch_str_in(&mut doc, "windows", "sandbox", &settings.windows_sandbox)?; }

    // read-only / danger-full-access 下这组键不生效；此时保留用户原值，不删不改。
    if settings.sandbox_mode.is_empty() || settings.sandbox_mode == "workspace-write" {
        if settings.writable_roots.iter().any(|root| !root.trim().is_empty()) {
            let mut roots = Array::new();
            for root in &settings.writable_roots {
                let trimmed = root.trim();
                if !trimmed.is_empty() { roots.push(trimmed); }
            }
            put(table_entry(&mut doc, "sandbox_workspace_write")?, "writable_roots", roots.into());
        } else { prune_key(&mut doc, "sandbox_workspace_write", "writable_roots")?; }
        patch_bool_in(&mut doc, "sandbox_workspace_write", "network_access", settings.network_access)?;
        patch_bool_in(&mut doc, "sandbox_workspace_write", "exclude_tmpdir_env_var", settings.exclude_tmpdir_env_var)?;
        patch_bool_in(&mut doc, "sandbox_workspace_write", "exclude_slash_tmp", settings.exclude_slash_tmp)?;
    }

    patch_bool_in(&mut doc, "features", "default_mode_request_user_input", settings.default_mode_request_user_input)?;

    let provider = settings.model_provider.as_deref().unwrap_or("").trim().to_string();
    if settings.provider_defined && !provider.is_empty() {
        if !settings.api_base_url.trim().is_empty() {
            if let Some(table) = existing_provider_table(&mut doc, &provider) {
                put(table, "base_url", settings.api_base_url.trim().into());
            }
        }
        // 关闭即删键：`= false` 会把它从「跟随 Codex 默认」变成「显式不支持」。
        if let Some(table) = existing_provider_table(&mut doc, &provider) {
            match settings.supports_websockets {
                Some(true) => put(table, "supports_websockets", true.into()),
                _ => { table.remove("supports_websockets"); },
            }
        }
    }

    backup_and_write(path, &doc.to_string())?;
    read_codex_settings_at(path)
}

#[tauri::command]
pub async fn ai_cli_codex_settings_read() -> Result<CodexSettings, String> {
    block(read_codex_settings).await
}

#[tauri::command]
pub async fn ai_cli_codex_settings_save(settings: CodexSettings) -> Result<CodexSettings, String> {
    block(move || save_codex_settings(settings)).await
}

/// 供应商「应用」用：只改端点、密钥与模型，其余结构化字段保持磁盘上的原值。
/// auth.json 与已有 provider 的 base_url 通过同一条保存路径同步。
#[allow(dead_code)]
pub(crate) fn apply_codex_endpoint(model: &str, base_url: &str, api_key: &str) -> Result<(), String> {
    let path = config_path(Provider::Codex)?;
    let mut config = read_codex_settings_at(&path)?;
    if !model.trim().is_empty() { config.model = model.trim().to_string(); }
    config.api_base_url = base_url.trim().to_string();
    config.api_key = api_key.trim().to_string();
    save_codex_settings(config).map(|_| ())
}

const CODEX_ACTOR_AUTHORIZATION_HEADER: &str = "x-openai-actor-authorization";

fn provider_uses_actor_authorization(table: &Table) -> bool {
    table.get("http_headers")
        .and_then(|item| item.as_table_like())
        .is_some_and(|headers| {
            headers.iter().any(|(name, val)| {
                name.eq_ignore_ascii_case(CODEX_ACTOR_AUTHORIZATION_HEADER)
                    && val.as_str().is_some_and(|text| !text.trim().is_empty())
            })
        })
}

/// 写入 Codex 的 auth.json（仅供供应商应用时调用）。
/// - 若文件不存在且密钥非空：创建文件并写入 {"OPENAI_API_KEY": key}
/// - 若文件已存在：在现有 JSON 对象中设置或移除 OPENAI_API_KEY，保留其他字段
/// - 若文件不存在且密钥为空：不创建文件
pub(crate) fn write_codex_provider_auth(api_key: &str) -> Result<(), String> {
    let auth_path = codex_auth_path()?;
    let key = api_key.trim();
    if !auth_path.exists() {
        if key.is_empty() {
            return Ok(());
        }
        if let Some(dir) = auth_path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("无法创建 Codex 配置目录：{e}"))?;
        }
        let root = serde_json::json!({ "OPENAI_API_KEY": key });
        return backup_and_write(&auth_path, &serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?);
    }

    let text = fs::read_to_string(&auth_path).map_err(|e| format!("读取 auth.json 失败：{e}"))?;
    let mut value: serde_json::Value = if text.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({}))
    };
    let Some(obj) = value.as_object_mut() else {
        return Err("auth.json 格式错误：根节点不是对象".into());
    };

    if key.is_empty() {
        obj.remove("OPENAI_API_KEY");
    } else {
        obj.insert("OPENAI_API_KEY".to_string(), serde_json::Value::String(key.to_string()));
    }
    backup_and_write(&auth_path, &serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?)
}

/// 供应商「应用」专用的路由配置写入（对齐 codeg 行为，同时用 toml_edit 保留注释）：
/// 1. 设置根 `model`：有效默认模型写入根 `model`，若为 None 或空则移除根 `model`；
/// 2. 检查 `model_provider`：若为空或为内置 ID (openai/ollama/lmstudio)，则换成 "forge"；否则保留用户的自定义 provider 名；
/// 3. 设置 `[model_providers.<name>]` 表的 `base_url`；
/// 4. 若名称为 "forge"，确保 `name = "forge"` 与 `wire_api = "responses"`，且仅在不存在 `requires_openai_auth` 且未开启 actor authorization 时补 `requires_openai_auth = true`；
/// 5. 保存 config.toml 并同步调用 `write_codex_provider_auth(api_key)`。
pub(crate) fn apply_codex_provider_route(base_url: &str, model: Option<&str>, api_key: &str) -> Result<(), String> {
    let path = config_path(Provider::Codex)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    let existing = if path.exists() {
        fs::read_to_string(&path).map_err(|error| format!("读取 Codex 配置失败：{error}"))?
    } else {
        String::new()
    };
    let mut doc: DocumentMut = existing.parse().map_err(|error| format!("TOML 格式错误：{error}"))?;

    // 1. 根 model
    match model.map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) => put(doc.as_table_mut(), "model", m.into()),
        None => { doc.as_table_mut().remove("model"); }
    }

    // 2. model_provider
    let current_provider = doc.get("model_provider")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    let provider_name = if current_provider.is_empty()
        || current_provider == "openai"
        || current_provider == "ollama"
        || current_provider == "lmstudio"
    {
        "forge".to_string()
    } else {
        current_provider.to_string()
    };
    put(doc.as_table_mut(), "model_provider", provider_name.as_str().into());

    // 3. [model_providers.<provider_name>] 表
    let providers_entry = doc.entry("model_providers").or_insert(toml_edit::Item::Table(Table::new()));
    let providers_table = providers_entry.as_table_mut().ok_or("model_providers 必须是 TOML 表")?;
    let provider_entry = providers_table.entry(&provider_name).or_insert(toml_edit::Item::Table(Table::new()));
    let provider_table = provider_entry.as_table_mut().ok_or("供应商条目必须是 TOML 表")?;

    let url = base_url.trim();
    if url.is_empty() {
        provider_table.remove("base_url");
    } else {
        put(provider_table, "base_url", url.into());
    }

    // 4. forge 自有表配置
    if provider_name == "forge" {
        put(provider_table, "name", "forge".into());
        put(provider_table, "wire_api", "responses".into());
        if !provider_table.contains_key("requires_openai_auth") && !provider_uses_actor_authorization(provider_table) {
            put(provider_table, "requires_openai_auth", true.into());
        }
    }

    backup_and_write(&path, &doc.to_string())?;
    write_codex_provider_auth(api_key)?;
    Ok(())
}

fn version_of(program: &str) -> Option<String> {
    let path = super::resolve(program).ok()?;
    checked(command(&path, &["--version"])).ok().map(|value| value.trim().to_string())
}

/// 本地检查：不联网，只回答「这台机器上现在是什么状态」。
/// 最新版本那一项由前端用已有的 `AiCliStatus` 拼上，避免两处各查一次网络。
#[tauri::command]
pub async fn ai_cli_diagnostics(provider: Provider) -> Result<Vec<Diagnostic>, String> {
    block(move || {
        let status = cached_status(provider);
        let mut checks = Vec::new();

        checks.push(match &status {
            Ok(item) if item.installed => diagnostic("binary", "pass", item.path.clone(), None),
            Ok(item) => diagnostic("binary", "fail", None, item.probe_error.clone().or_else(|| Some("未在 PATH 中找到可执行文件".into()))),
            Err(error) => diagnostic("binary", "fail", None, Some(error.clone())),
        });

        checks.push(match &status {
            Ok(item) if item.version.is_some() => diagnostic("version", "pass", item.version.clone(), None),
            Ok(item) => diagnostic("version", "fail", None, item.probe_error.clone().or_else(|| Some("无法解析版本".into()))),
            Err(error) => diagnostic("version", "fail", None, Some(error.clone())),
        });

        checks.push(match version_of("node") {
            Some(value) => diagnostic("node", "pass", Some(value), None),
            None => diagnostic("node", "fail", None, Some("未找到 Node.js。npm 安装的 CLI 需要先安装 Node.js".into())),
        });
        checks.push(match version_of("npm") {
            Some(value) => diagnostic("npm", "pass", Some(value), None),
            None => diagnostic("npm", "fail", None, Some("未找到 npm，Forge 无法安装或更新 CLI".into())),
        });

        let config = read_config(provider);
        checks.push(if let Some(error) = config.error.clone() {
            diagnostic("config", "fail", Some(config.path.clone()), Some(error))
        } else if !config.exists {
            diagnostic("config", "warn", Some(config.path.clone()), Some("尚未创建；在下方保存后会生成".into()))
        } else {
            match validate_config(provider, &config.content) {
                Ok(()) => diagnostic("config", "pass", Some(config.path.clone()), None),
                Err(error) => diagnostic("config", "fail", Some(config.path.clone()), Some(error)),
            }
        });

        let stored = environment(provider);
        let reserved: Vec<String> = stored.iter()
            .filter(|(key, _)| RESERVED_ENV.iter().any(|reserved| reserved.eq_ignore_ascii_case(key)))
            .map(|(key, _)| key.clone()).collect();
        // 检查项统计的是 CLI 实际生效的环境变量：Claude 还要算上原生 settings.json 的 env 块
        // （Forge 覆盖层打底、原生覆盖同名键，与启动时的合并规则一致），否则用户写在
        // 原生配置里的变量会被报成 0。
        let (effective, native_error) = match provider {
            Provider::Claude => {
                let settings = read_claude_settings_at(Path::new(&config.path));
                (settings.env.len(), settings.error)
            }
            Provider::Codex => (stored.len(), None),
        };
        let (env_status, env_hint) = match (reserved.is_empty(), native_error) {
            (true, None) => ("pass", None),
            (false, _) => ("fail", Some(format!("以下变量不能覆盖：{}", reserved.join("、")))),
            (_, Some(error)) => ("fail", Some(error)),
        };
        checks.push(diagnostic("env", env_status, Some(effective.to_string()), env_hint));

        if let Ok(item) = &status {
            if item.launcher_count > 1 {
                checks.push(diagnostic("conflict", "warn", None, item.prerequisite_error.clone()));
            }
        }
        Ok(checks)
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_config(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("forge-ai-cli-{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.join("config.toml")
    }

    #[test]
    fn codex_settings_round_trip_keeps_unmanaged_keys() {
        let path = temp_config("roundtrip");
        fs::write(&path, "model = \"old\"\n# keep\n[profiles.x]\nfoo = 1\n").unwrap();
        let mut settings = read_codex_settings_at(&path).unwrap();
        assert_eq!(settings.model, "old");
        assert_eq!(settings.approval_policy, "");
        settings.model = "new".into();
        settings.approval_policy = "granular".into();
        settings.granular.rules = false;
        settings.sandbox_mode = "workspace-write".into();
        settings.writable_roots = vec!["/tmp/shared".into()];
        settings.network_access = true;
        save_codex_settings_at(&path, settings).unwrap();

        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("# keep"));
        assert!(text.contains("[profiles.x]"));
        assert!(path.with_file_name("config.toml.forge.bak").exists());

        let read = read_codex_settings_at(&path).unwrap();
        assert_eq!(read.model, "new");
        assert_eq!(read.approval_policy, "granular");
        assert!(!read.granular.rules);
        assert_eq!(read.sandbox_mode, "workspace-write");
        assert_eq!(read.writable_roots, vec!["/tmp/shared".to_string()]);
        assert!(read.network_access);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn codex_settings_reject_relative_writable_roots() {
        let path = temp_config("relative");
        let mut settings = read_codex_settings_at(&path).unwrap();
        settings.writable_roots = vec!["relative/path".into()];
        assert!(save_codex_settings_at(&path, settings).is_err());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn codex_settings_leave_workspace_keys_alone_outside_workspace_write() {
        let path = temp_config("modes");
        fs::write(&path, "[sandbox_workspace_write]\nnetwork_access = true\n").unwrap();
        let mut settings = read_codex_settings_at(&path).unwrap();
        assert!(settings.network_access);
        settings.sandbox_mode = "read-only".into();
        settings.network_access = false;
        save_codex_settings_at(&path, settings).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("network_access = true"));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    fn temp_file(name: &str, file: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("forge-ai-cli-{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.join(file)
    }

    #[test]
    fn claude_settings_round_trip_keeps_unmanaged_keys() {
        let path = temp_file("claude", "settings.json");
        fs::write(&path, r#"{
  "permissions": { "allow": ["Bash"] },
  "env": { "KEEP_ME": "1", "ANTHROPIC_BASE_URL": "https://old.example.com", "ANTHROPIC_API_KEY": "legacy" }
}"#).unwrap();

        let read = read_claude_settings_at(&path);
        assert_eq!(read.env.get("KEEP_ME").map(String::as_str), Some("1"));
        assert_eq!(read.env.get("ANTHROPIC_BASE_URL").map(String::as_str), Some("https://old.example.com"));

        let mut env = BTreeMap::new();
        env.insert("ANTHROPIC_BASE_URL".into(), "https://new.example.com".into());
        env.insert("ANTHROPIC_AUTH_TOKEN".into(), "sk-token".into());
        env.insert("ANTHROPIC_API_KEY".into(), String::new());
        save_claude_settings_at(&path, env).unwrap();

        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"permissions\""));
        assert!(text.contains("KEEP_ME"));
        assert!(!text.contains("ANTHROPIC_API_KEY"));
        assert!(path.with_file_name("settings.json.forge.bak").exists());

        let read = read_claude_settings_at(&path);
        assert_eq!(read.env.get("ANTHROPIC_BASE_URL").map(String::as_str), Some("https://new.example.com"));
        assert_eq!(read.env.get("ANTHROPIC_AUTH_TOKEN").map(String::as_str), Some("sk-token"));
        assert!(!read.env.contains_key("ANTHROPIC_API_KEY"));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn claude_settings_refuse_to_overwrite_invalid_json() {
        let path = temp_file("claude-broken", "settings.json");
        fs::write(&path, "{ broken").unwrap();
        let mut env = BTreeMap::new();
        env.insert("ANTHROPIC_BASE_URL".into(), "https://example.com".into());
        assert!(save_claude_settings_at(&path, env).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ broken");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn codex_settings_read_provider_base_url() {
        let path = temp_config("provider-url");
        fs::write(&path, "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://gw.example.com/v1\"\nname = \"custom\"\n").unwrap();
        let settings = read_codex_settings_at(&path).unwrap();
        assert_eq!(settings.api_base_url, "https://gw.example.com/v1");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn codex_settings_sync_existing_provider_base_url() {
        let path = temp_config("provider-save");
        fs::write(&path, "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://old.example.com\"\nname = \"custom\"\n").unwrap();
        let mut settings = read_codex_settings_at(&path).unwrap();
        settings.api_base_url = "https://new.example.com".into();
        save_codex_settings_at(&path, settings).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("https://new.example.com"));
        assert!(text.contains("name = \"custom\""));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn provider_binding_is_trimmed_and_length_capped() {
        let mut item = AgentSetting { provider: "  gw-1  ".into(), ..AgentSetting::default() };
        validate_binding(&mut item).unwrap();
        assert_eq!(item.provider, "gw-1");
        // 没绑定就是空串，不能被 trim 之后还当成有值。
        let mut blank = AgentSetting { provider: "   ".into(), ..AgentSetting::default() };
        validate_binding(&mut blank).unwrap();
        assert!(blank.provider.is_empty());
        let mut long = AgentSetting::default();
        long.provider = "p".repeat(65);
        assert!(validate_binding(&mut long).is_err());
    }

    /// 「关闭即删键」：留空的枚举、false 的开关、空数组都不该在文件里留下影子，
    /// 否则 Codex 读到的是显式空值而不是它自己的默认值。
    #[test]
    fn codex_settings_unset_values_remove_keys() {
        let path = temp_config("unset-remove");
        fs::write(&path, concat!(
            "model = \"gpt-5\"\n",
            "[features]\ndefault_mode_request_user_input = true\n",
            "[sandbox_workspace_write]\nnetwork_access = true\nwritable_roots = [\"/srv/x\"]\n",
            "[history]\npersistence = \"none\"\n",
        )).unwrap();
        let mut settings = read_codex_settings_at(&path).unwrap();
        settings.default_mode_request_user_input = false;
        settings.network_access = false;
        settings.writable_roots = Vec::new();
        settings.history_persistence = String::new();
        save_codex_settings_at(&path, settings).unwrap();

        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("default_mode_request_user_input"), "{text}");
        assert!(!text.contains("[features]"), "{text}");
        assert!(!text.contains("[sandbox_workspace_write]"), "{text}");
        assert!(!text.contains("[history]"), "{text}");
        assert!(text.contains("model = \"gpt-5\""));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// 补齐的设置项要真的写进 config.toml 并能读回来，未知键与注释不能丢。
    #[test]
    fn codex_settings_new_keys_round_trip() {
        let path = temp_config("new-keys");
        fs::write(&path, "model = \"gpt-5\"\n# 手写的说明\nweb_search = \"live\"\n").unwrap();
        let mut settings = read_codex_settings_at(&path).unwrap();
        assert_eq!(settings.web_search, "live");
        settings.model_reasoning_effort = "xhigh".into();
        settings.model_reasoning_summary = "concise".into();
        settings.model_verbosity = "low".into();
        settings.model_context_window = Some(272_000);
        settings.model_auto_compact_token_limit = Some(200_000);
        settings.history_persistence = "save-all".into();
        settings.history_max_bytes = Some(40_000_000);
        settings.shell_env_inherit = "core".into();
        settings.windows_sandbox = "elevated".into();
        save_codex_settings_at(&path, settings).unwrap();

        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("# 手写的说明"), "{text}");
        assert!(text.contains("model_reasoning_effort = \"xhigh\""));
        assert!(text.contains("[history]"), "{text}");
        assert!(text.contains("persistence = \"save-all\""));
        let read = read_codex_settings_at(&path).unwrap();
        assert_eq!((read.model_reasoning_effort.as_str(), read.model_reasoning_summary.as_str()), ("xhigh", "concise"));
        assert_eq!(read.model_context_window, Some(272_000));
        assert_eq!(read.model_auto_compact_token_limit, Some(200_000));
        assert_eq!(read.history_max_bytes, Some(40_000_000));
        assert_eq!(read.shell_env_inherit, "core");
        // 非 Windows 上写了也不生效，读得到但界面不显示、保存也不碰。
        if cfg!(windows) { assert_eq!(read.windows_sandbox, "elevated"); }
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// 内置 provider ID 一旦被写进 model_providers，Codex 会整份配置报错，所以绝不替用户建表。
    #[test]
    fn codex_settings_never_create_provider_table() {
        let path = temp_config("provider-guard");
        fs::write(&path, "model_provider = \"openai\"\n").unwrap();
        let mut settings = read_codex_settings_at(&path).unwrap();
        assert!(!settings.provider_defined, "文件里没有 [model_providers.openai] 段落");
        settings.supports_websockets = Some(true);
        settings.api_base_url = "https://api.openai.com/v1".into();
        save_codex_settings_at(&path, settings).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("model_providers"), "{text}");

        // 用户自己建过段落时才同步这两个键。
        fs::write(&path, "model_provider = \"gw\"\n[model_providers.gw]\nname = \"gw\"\nsupports_websockets = true\n").unwrap();
        let mut settings = read_codex_settings_at(&path).unwrap();
        assert!(settings.provider_defined);
        assert_eq!(settings.supports_websockets, Some(true));
        settings.supports_websockets = Some(false);
        save_codex_settings_at(&path, settings).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("supports_websockets"), "{text}");
        assert!(text.contains("name = \"gw\""));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// `[permissions]` 与 sandbox_mode 是两套权限表达，同写会让 Codex 报错，界面要先知道。
    #[test]
    fn codex_settings_detect_permission_profiles() {
        let path = temp_config("permissions-table");
        fs::write(&path, "[permissions.workspace]\nworkspace_write = true\n").unwrap();
        let settings = read_codex_settings_at(&path).unwrap();
        assert!(settings.permissions_defined);
        assert!(settings.shadowed);

        let path2 = temp_config("default-permissions");
        fs::write(&path2, "default_permissions = \"workspace\"\n").unwrap();
        let settings = read_codex_settings_at(&path2).unwrap();
        assert!(!settings.permissions_defined);
        assert!(settings.shadowed);
        let _ = fs::remove_dir_all(path.parent().unwrap());
        let _ = fs::remove_dir_all(path2.parent().unwrap());
    }

    /// 枚举值一律来自 Codex 自己的报错；写坏了 CLI 会拒绝启动，所以保存前必须挡住。
    #[test]
    fn codex_settings_validate_enums_and_numbers() {
        let base = CodexSettings::default();
        assert!(validate_codex_settings(&base).is_ok());
        // on-failure 是 Codex 的真实取值，旧配置里存着它时要能原样保存。
        assert!(validate_codex_settings(&CodexSettings { approval_policy: "on-failure".into(), ..base.clone() }).is_ok());
        for (field, value) in [("summary", "brief"), ("verbosity", "max"), ("web_search", "auto"),
            ("history_persistence", "all"), ("shell_env_inherit", "parent"), ("windows_sandbox", "admin")] {
            let mut settings = base.clone();
            match field {
                "summary" => settings.model_reasoning_summary = value.into(),
                "verbosity" => settings.model_verbosity = value.into(),
                "web_search" => settings.web_search = value.into(),
                "history_persistence" => settings.history_persistence = value.into(),
                "shell_env_inherit" => settings.shell_env_inherit = value.into(),
                _ => settings.windows_sandbox = value.into(),
            }
            assert!(validate_codex_settings(&settings).is_err(), "{field}={value} 不该被放行");
        }
        let mut effort = base.clone();
        effort.model_reasoning_effort = "HIGH!".into();
        assert!(validate_codex_settings(&effort).is_err());
        for number in [Some(0), Some(-5), Some(1_000_000_000_001)] {
            assert!(validate_codex_settings(&CodexSettings { model_context_window: number, ..base.clone() }).is_err());
        }
        assert!(validate_codex_settings(&CodexSettings { web_search: "indexed".into(), ..base }).is_ok());
    }

    #[test]
    fn codex_auth_plan_keeps_chatgpt_login_and_switches_modes() {
        let login = temp_file("auth-login", "auth.json");
        fs::write(&login, r#"{"tokens":{"access_token":"abc"}}"#).unwrap();
        assert!(plan_codex_auth(&login, "").unwrap().is_none());
        assert!(plan_codex_auth(&login, "sk-new").unwrap().is_none());

        let keyed = temp_file("auth-keyed", "auth.json");
        fs::write(&keyed, r#"{"OPENAI_API_KEY":"sk-old","auth_mode":"chatgpt","tokens":{"access_token":"abc"}}"#).unwrap();
        let text = plan_codex_auth(&keyed, "").unwrap().unwrap();
        assert!(text.contains("\"auth_mode\": \"chatgpt\""));
        assert!(text.contains("\"OPENAI_API_KEY\": null"));
        assert!(text.contains("abc"));

        let text = plan_codex_auth(&keyed, "sk-new").unwrap().unwrap();
        assert!(text.contains("sk-new"));
        assert!(!text.contains("auth_mode"));
        assert!(text.contains("abc"));

        let _ = fs::remove_dir_all(login.parent().unwrap());
        let _ = fs::remove_dir_all(keyed.parent().unwrap());
    }

    #[test]
    fn actor_authorization_detection_respects_header() {
        let mut table = Table::new();
        assert!(!provider_uses_actor_authorization(&table));
        let mut headers = Table::new();
        headers.insert(CODEX_ACTOR_AUTHORIZATION_HEADER.into(), value("Bearer test"));
        table.insert("http_headers".into(), toml_edit::Item::Table(headers));
        assert!(provider_uses_actor_authorization(&table));
    }
}
