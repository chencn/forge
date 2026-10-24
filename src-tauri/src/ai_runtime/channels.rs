//! 自定义渠道：第三方 API 网关的地址、凭据与模型集合。
//!
//! 一条渠道只在 Forge 与 CLI 子进程之间存在：密钥既不返回前端，也不写进用户的
//! `~/.claude/settings.json` 或 `~/.codex/config.toml`。启动 CLI 时才把端点与凭据
//! 注入那一个进程的环境变量（Claude）或 `-c` 覆盖参数（Codex），所以切换渠道
//! 不需要改用户的全局配置，也不会被用户自己的配置改动带偏。
use super::options;
use crate::ai_cli::Provider;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Codex 从哪个环境变量取渠道密钥；名字固定，`env_key` 与注入的变量必须一致。
const CODEX_KEY_VAR: &str = "FORGE_CODEX_CHANNEL_KEY";
/// 只串行化这份 JSON 的读改写；绝不能在此锁内启动 CLI 或等待网络。
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

/// 一条渠道。`api_key` 只存在于磁盘与子进程环境，任何返回前端的路径都必须剔除它。
#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    /// Claude 用它填 `ANTHROPIC_MODEL`；Codex 只作为默认模型候选。
    pub default_model: Option<String>,
    /// 该渠道实际服务的模型 id，来自 `/models` 发现或用户手填。
    pub models: Vec<String>,
    /// Claude 专用：`sonnet`/`opus`/`haiku`/`fable` 别名映射到哪个真实模型。
    pub alias_targets: BTreeMap<String, String>,
    /// 本地或内网网关允许明文 http；默认拒绝。
    pub allows_insecure_http: bool,
}

#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Engine {
    /// 当前启用的渠道 id；`None` 表示用 CLI 自己的官方登录与配置。
    pub active: Option<String>,
    pub items: Vec<Channel>,
}

#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Store {
    pub claude: Engine,
    pub codex: Engine,
}

/// 前端提交的表单。没有 `apiKey` 字段：密钥单独作为参数传，空白表示沿用已存的那把。
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Draft {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub default_model: Option<String>,
    pub models: Vec<String>,
    pub alias_targets: BTreeMap<String, String>,
    pub allows_insecure_http: bool,
}

fn engine_mut(store: &mut Store, provider: Provider) -> &mut Engine {
    if provider == Provider::Claude { &mut store.claude } else { &mut store.codex }
}
fn engine<'a>(store: &'a Store, provider: Provider) -> &'a Engine {
    if provider == Provider::Claude { &store.claude } else { &store.codex }
}

/// 读取渠道表；损坏或旧格式一律按「没有渠道」处理，不能阻塞对话。
pub fn load(path: &Path) -> Store {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}
fn save(path: &Path, store: &Store) -> Result<(), String> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    crate::sys::write_atomic(path, &serde_json::to_string_pretty(store).map_err(|e| e.to_string())?)
}

/// 当前启用的渠道；active 指向已被删除的 id 时按「没有渠道」处理，让对话回到 CLI 自身配置。
pub fn active(store: &Store, provider: Provider) -> Option<Channel> {
    let engine = engine(store, provider);
    engine.active.as_deref().and_then(|id| engine.items.iter().find(|item| item.id == id)).cloned()
}

/// 与 codeg 同款的掩码：按 Unicode 标量切，CJK 输入法打出的全角字符不会让切片 panic。
pub fn mask_api_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    let len = chars.len();
    if len <= 8 { return "•".repeat(len); }
    let prefix: String = chars[..4].iter().collect();
    let suffix: String = chars[len - 4..].iter().collect();
    format!("{}{}{}", prefix, "•".repeat(len.min(20) - 8), suffix)
}

/// 返回给前端的视图：只给掩码和「有没有密钥」，永不含明文。
pub fn public_view(store: &Store) -> Value {
    let engine = |engine: &Engine| json!({
        "active": engine.active,
        "items": engine.items.iter().map(|channel| json!({
            "id": channel.id,
            "name": channel.name,
            "baseUrl": channel.base_url,
            "apiKeyMasked": mask_api_key(&channel.api_key),
            "hasApiKey": !channel.api_key.trim().is_empty(),
            "defaultModel": channel.default_model,
            "models": channel.models,
            "aliasTargets": channel.alias_targets,
            "allowsInsecureHttp": channel.allows_insecure_http,
        })),
    });
    json!({"claude": engine(&store.claude), "codex": engine(&store.codex)})
}

/// 规范化并校验一个 API 端点。只认 http/https，且挡住 userinfo/query/fragment：
/// 凭据和额外参数不该藏在一个「基础地址」里被带进子进程环境。
fn normalize_base_url(input: &str, allows_insecure_http: bool) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() { return Err("请填写渠道接口地址".into()); }
    let parsed = url::Url::parse(trimmed).map_err(|_| "渠道接口地址不是合法 URL".to_string())?;
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some()
        || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("渠道接口地址不能包含用户名、密码、查询串或锚点".into());
    }
    if parsed.scheme() == "http" && !allows_insecure_http {
        return Err("明文 HTTP 渠道需要显式勾选允许，仅限本机或内网可信服务".into());
    }
    if parsed.scheme() != "https" && parsed.scheme() != "http" { return Err("渠道接口地址只支持 http/https".into()); }
    let path = parsed.path().trim_end_matches('/');
    let mut rebuilt = parsed.clone();
    rebuilt.set_path(if path.is_empty() { "/" } else { path });
    rebuilt.set_port(None).map_err(|_| "渠道接口地址端口无效".to_string())?;
    Ok(rebuilt.to_string())
}

fn normalize_models(provider: Provider, input: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in input {
        let id = raw.trim();
        if id.is_empty() { continue; }
        options::validate(provider, Some(id), None)?;
        if !out.iter().any(|item| item == id) { out.push(id.to_owned()); }
        if out.len() > 200 { return Err("单个渠道最多登记 200 个模型".into()); }
    }
    Ok(out)
}

fn normalize_aliases(provider: Provider, input: &BTreeMap<String, String>) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    for (alias, target) in input {
        let target = target.trim();
        if target.is_empty() { continue; }
        // 只有 Claude 的四个官方别名可以被改写；Codex 的模型走 models 列表。
        if provider != Provider::Claude || !options::CLAUDE_MODELS.iter().any(|(name, _)| *name == alias.as_str()) {
            return Err("未知的模型别名".into());
        }
        options::validate(provider, Some(target), None)?;
        out.insert(alias.clone(), target.to_owned());
    }
    Ok(out)
}

fn new_id() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or_default();
    format!("ch-{:x}-{:x}", nanos, NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

/// 保存（新增或覆盖）一条渠道。`api_key` 为空白时保留磁盘上已有的那把密钥。
pub fn upsert(path: &Path, provider: Provider, draft: Draft, api_key: Option<&str>) -> Result<Value, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let name = draft.name.trim();
    if name.is_empty() || name.chars().count() > 60 { return Err("渠道名称需为 1–60 个字符".into()); }
    let base_url = normalize_base_url(&draft.base_url, draft.allows_insecure_http)?;
    let models = normalize_models(provider, &draft.models)?;
    let alias_targets = normalize_aliases(provider, &draft.alias_targets)?;
    let default_model = draft.default_model.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned);
    if let Some(model) = default_model.as_deref() {
        options::validate(provider, Some(model), None)?;
        // 默认模型必须在渠道自己的清单里，否则会注入一个该网关根本不服务的 id。
        if !models.iter().any(|item| item == model) { return Err("默认模型要先登记在该渠道的模型列表中".into()); }
    }
    let mut store = load(path);
    let engine = engine_mut(&mut store, provider);
    let id = if draft.id.is_empty() { new_id() } else {
        if !engine.items.iter().any(|item| item.id == draft.id) { return Err("要修改的渠道不存在".into()); }
        draft.id.clone()
    };
    let stored_key = engine.items.iter().find(|item| item.id == id).map(|item| item.api_key.clone()).unwrap_or_default();
    let api_key = match api_key {
        Some(value) if !value.trim().is_empty() => value.trim().to_owned(),
        // 空白输入 = 「不改密钥」。已存在的渠道保留原值，新渠道则留空（本机免密网关）。
        _ => stored_key,
    };
    let channel = Channel { id: id.clone(), name: name.to_owned(), base_url, api_key, default_model, models, alias_targets, allows_insecure_http: draft.allows_insecure_http };
    match engine.items.iter_mut().find(|item| item.id == id) {
        Some(existing) => *existing = channel,
        None => engine.items.push(channel),
    }
    save(path, &store)?;
    Ok(public_view(&store))
}

/// 删除一条渠道；它正被启用时，同一份写入里清掉 active 槽，避免留下悬空引用。
pub fn remove(path: &Path, provider: Provider, id: &str) -> Result<Value, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut store = load(path);
    let engine = engine_mut(&mut store, provider);
    if !engine.items.iter().any(|item| item.id == id) { return Err("渠道不存在".into()); }
    engine.items.retain(|item| item.id != id);
    if engine.active.as_deref() == Some(id) { engine.active = None; }
    save(path, &store)?;
    Ok(public_view(&store))
}

/// 切换当前渠道；`None` 回到 CLI 自身的官方配置。空列表的渠道不能启用。
pub fn set_active(path: &Path, provider: Provider, id: Option<&str>) -> Result<Value, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut store = load(path);
    let engine = engine_mut(&mut store, provider);
    let Some(id) = id.map(str::trim).filter(|value| !value.is_empty()) else {
        engine.active = None;
        save(path, &store)?;
        return Ok(public_view(&store));
    };
    let channel = engine.items.iter().find(|item| item.id == id).ok_or("渠道不存在，无法启用")?;
    if channel.base_url.trim().is_empty() { return Err("该渠道缺少接口地址，无法启用".into()); }
    engine.active = Some(channel.id.clone());
    save(path, &store)?;
    Ok(public_view(&store))
}

static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Claude 侧的注入：网关地址 + 凭据 + 别名目标，全部走子进程环境。
///
/// `ANTHROPIC_AUTH_TOKEN` 而非 `ANTHROPIC_API_KEY`：第三方网关普遍用 Bearer 校验，
/// 后者会让 CLI 走 `x-api-key` 分支并顺带触发官方登录态。
pub fn claude_env(channel: &Channel) -> Vec<(String, String)> {
    let mut env = vec![("ANTHROPIC_BASE_URL".to_owned(), channel.base_url.clone())];
    if !channel.api_key.trim().is_empty() { env.push(("ANTHROPIC_AUTH_TOKEN".to_owned(), channel.api_key.clone())); }
    if let Some(model) = channel.default_model.as_deref() { env.push(("ANTHROPIC_MODEL".to_owned(), model.to_owned())); }
    for (alias, target) in &channel.alias_targets {
        if let Some((_, key)) = options::CLAUDE_MODELS.iter().find(|(name, _)| *name == alias.as_str()) {
            env.push(((*key).to_owned(), target.clone()));
        }
    }
    env
}

/// Codex 的渠道键写进 TOML 的表名，只用生成 id 里的安全字符。
fn codex_key(channel: &Channel) -> String {
    let slug: String = channel.id.chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect();
    format!("forge-{slug}")
}
/// TOML 字符串字面量：双引号与反斜杠转义，控制字符已在校验阶段被挡住。
fn toml_str(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Codex 侧的注入：`-c` 覆盖渠道定义与选择，密钥通过 `env_key` 指向的变量交付。
///
/// `wire_api` 固定为 `responses`：0.163.0 明确拒绝 `"chat"`，写错会让整个 app-server 起不来。
pub fn codex_overrides(channel: &Channel) -> (Vec<String>, Vec<(String, String)>) {
    let key = codex_key(channel);
    let table = format!("model_providers.{key}");
    let mut args = vec![
        format!("model_provider={key}"),
        format!("{table}.name={}", toml_str(&channel.name)),
        format!("{table}.base_url={}", toml_str(&channel.base_url)),
        format!("{table}.wire_api=\"responses\""),
    ];
    let mut env = Vec::new();
    args.push(format!("{table}.env_key={}", toml_str(CODEX_KEY_VAR)));
    if !channel.api_key.trim().is_empty() { env.push((CODEX_KEY_VAR.to_owned(), channel.api_key.clone())); }
    (args, env)
}

/// 把渠道并进模型目录：模型清单、渠道名，以及 Claude 别名的真实调用目标。
///
/// 调用顺序固定在 `claude_configured_models` 之后——Forge 注入的环境变量在 CLI 里也排在
/// settings.json 之上，目录展示必须跟着实际生效的那一份走。
pub fn apply_catalog(catalog: &mut Value, provider: Provider, channel: Option<&Channel>) {
    let Some(channel) = channel else { return; };
    catalog["channel"] = json!({"id": channel.id, "name": channel.name, "baseUrl": channel.base_url});
    let Some(models) = catalog["models"].as_array_mut() else { return; };
    let efforts = catalog["efforts"].as_array().cloned().unwrap_or_default();
    let mut add = |id: &str, default: bool| {
        if id.is_empty() || models.iter().any(|item| item["id"].as_str() == Some(id)) { return; }
        models.push(json!({"id": id, "name": id, "efforts": efforts.clone(), "isDefault": default}));
    };
    add(channel.default_model.as_deref().unwrap_or(""), true);
    for id in &channel.models { add(id, false); }
    if provider == Provider::Claude {
        for (alias, target) in &channel.alias_targets {
            if let Some(model) = models.iter_mut().find(|model| model["id"].as_str() == Some(alias.as_str())) {
                model["configuredModel"] = json!(target);
            }
        }
        if let Some(default) = channel.default_model.as_deref() {
            if let Some(model) = models.iter_mut().find(|model| model["id"].as_str() == Some("default")) {
                model["configuredModel"] = json!(default);
            }
        }
    }
    // 渠道清单并进本次视图的自定义列表：模型下拉要选得到网关实际提供的那些 id。
    // 只影响这一次读取，不落盘——切回官方渠道后重新投影，它们自然消失。
    if let Some(custom) = catalog["customModels"].as_array_mut() {
        for id in &channel.models {
            if !custom.iter().any(|item| item.as_str() == Some(id.as_str())) { custom.push(json!(id)); }
        }
    }
}
/// 已启用渠道的模型清单，供前端解释「这些模型 id 从哪来」。
pub fn channel_models(store: &Store) -> Value {
    let list = |engine: &Engine| engine.active.as_deref()
        .and_then(|id| engine.items.iter().find(|item| item.id == id))
        .map(|channel| json!({"id": channel.id, "name": channel.name, "models": channel.models}))
        .unwrap_or(Value::Null);
    json!({"claude": list(&store.claude), "codex": list(&store.codex)})
}
