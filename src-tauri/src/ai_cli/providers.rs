//! 可复用的模型供应商：保存名字、端点、密钥与模型，一键写进某个 CLI。
//!
//! 供应商本身存在 Forge 的配置目录。应用时写 CLI 真正读取的位置：
//! Claude 的 settings.json 会覆盖父进程注入的变量，所以必须落到它的 env；
//! Codex 的端点/密钥走环境变量、auth.json 以及 config.toml 的自有 provider 表；模型目录走 forge-model-catalog.json。
use super::{codex_catalog, settings, Provider};
use crate::offload::block;
use crate::sys::write_atomic;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const STORE_FILE: &str = "ai-providers.json";
const MAX_PROVIDERS: usize = 64;
const MAX_NAME: usize = 80;
const MAX_URL: usize = 2048;
const MAX_KEY: usize = 4096;
const MAX_MODEL: usize = 200;
/// Codex 的 `model` 字段存储整份自定义模型意图 JSON，放宽到 256 KB。
const MAX_CODEX_MODEL: usize = 262_144;

/// Claude Code 的模型槽位与对应环境变量。Codex 只用一个 `model`。
/// 后三项是「自定义模型选项」：在 CLI 的 /model 选择器里多出一项，用来点名网关自己提供的模型。
const CLAUDE_MODEL_KEYS: [(&str, &str); 9] = [
    ("main", "ANTHROPIC_MODEL"),
    ("reasoning", "ANTHROPIC_REASONING_MODEL"),
    ("haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
    ("sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"),
    ("opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"),
    ("fable", "ANTHROPIC_DEFAULT_FABLE_MODEL"),
    ("customOption", "ANTHROPIC_CUSTOM_MODEL_OPTION"),
    ("customOptionName", "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"),
    ("customOptionDescription", "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION"),
];

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelProvider {
    pub id: String,
    pub name: String,
    /// `claude` 或 `codex`。
    pub kind: String,
    pub api_url: String,
    pub api_key: String,
    /// Codex 的模型，以及 Claude 的主模型（models.main 的镜像）。
    pub model: String,
    pub models: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Store {
    version: u32,
    providers: Vec<ModelProvider>,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
    Ok(dir.join(STORE_FILE))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn valid_url(value: &str) -> bool {
    value.is_empty() || ((value.starts_with("https://") || value.starts_with("http://"))
        && value.len() <= MAX_URL && !value.chars().any(|ch| ch.is_whitespace() || ch == '\0'))
}

fn validate(provider: &ModelProvider) -> Result<(), String> {
    if !valid_id(&provider.id) {
        return Err("供应商 ID 只能包含字母、数字、- 和 _".into());
    }
    if provider.name.trim().is_empty() || provider.name.chars().count() > MAX_NAME {
        return Err("供应商名称不能为空且不能超过 80 个字符".into());
    }
    if provider.kind != "claude" && provider.kind != "codex" {
        return Err("供应商类型只能是 claude 或 codex".into());
    }
    if !valid_url(provider.api_url.trim()) {
        return Err("API 地址必须是 http(s) URL 且不能包含空格".into());
    }
    // 端点和密钥都是这个供应商存在的意义。留空保存出来的条目一旦「应用」，
    // 会把 CLI 里原本能用的 ANTHROPIC_BASE_URL / AUTH_TOKEN 一起清掉。
    if provider.api_url.trim().is_empty() {
        return Err("API 地址不能为空".into());
    }
    if provider.api_key.trim().is_empty() {
        return Err("API Key 不能为空".into());
    }
    if provider.api_key.len() > MAX_KEY || provider.api_key.contains('\0') {
        return Err("API Key 过长或包含非法字符".into());
    }
    let max_model = if provider.kind == "codex" { MAX_CODEX_MODEL } else { MAX_MODEL };
    if provider.model.len() > max_model || provider.model.contains('\0') {
        return Err("模型名称过长或包含非法字符".into());
    }
    for (key, value) in &provider.models {
        if !CLAUDE_MODEL_KEYS.iter().any(|(slot, _)| slot == key) {
            return Err(format!("未知的模型槽位：{key}"));
        }
        if value.len() > MAX_MODEL || value.contains('\0') {
            return Err("模型名称过长或包含非法字符".into());
        }
    }
    Ok(())
}

fn load(app: &AppHandle) -> Result<Vec<ModelProvider>, String> {
    let path = store_path(app)?;
    let Ok(text) = fs::read_to_string(&path) else { return Ok(Vec::new()) };
    let store: Store = serde_json::from_str(&text).map_err(|error| format!("供应商配置格式错误：{error}"))?;
    Ok(store.providers)
}

/// 保存前的结构性检查：类型创建后不能改，仍被 CLI 绑定的不能删。
/// 这两条与 codeg 的实现一致：改类型会把一种 CLI 的模型写法解释成另一种的，
/// 删掉被绑定的条目只会让绑定那一栏变成「绑定的供应商已不存在」。
fn structural(
    previous: &[ModelProvider],
    next: &[ModelProvider],
    agents: &BTreeMap<String, settings::AgentSetting>,
) -> Result<(), String> {
    for provider in next {
        if let Some(old) = previous.iter().find(|item| item.id == provider.id.trim()) {
            if old.kind != provider.kind {
                return Err("供应商类型创建后不能更改：绑定的 CLI 会按旧类型解释模型与端点，请另建一个供应商".into());
            }
        }
    }
    for old in previous {
        if next.iter().any(|item| item.id.trim() == old.id) {
            continue;
        }
        if let Some((key, _)) = agents.iter().find(|(_, agent)| agent.provider == old.id) {
            let name = match key.as_str() {
                "claude" => "Claude Code",
                "codex" => "Codex",
                other => other,
            };
            return Err(format!("供应商「{}」还被 {name} 绑定着，请先在那里改绑再删除", old.name));
        }
    }
    Ok(())
}

/// 编辑时把密钥清空等于「沿用原值」：界面上是密码框，用户看到的是掩码，清空多半是误操作。
/// 与 codeg 的编辑对话框同一条口径（空密钥不提交，原值保留）。
fn keep_keys(previous: &[ModelProvider], providers: &mut [ModelProvider]) {
    for provider in providers {
        if provider.api_key.trim().is_empty() {
            if let Some(old) = previous.iter().find(|item| item.id == provider.id.trim()) {
                provider.api_key = old.api_key.clone();
            }
        }
    }
}

fn save(app: &AppHandle, mut providers: Vec<ModelProvider>) -> Result<Vec<ModelProvider>, String> {
    if providers.len() > MAX_PROVIDERS {
        return Err(format!("最多保存 {MAX_PROVIDERS} 个供应商"));
    }
    let previous = load(app)?;
    let agents = settings::load(app).map(|settings| settings.agents).unwrap_or_default();
    structural(&previous, &providers, &agents)?;
    keep_keys(&previous, &mut providers);
    let mut seen = std::collections::BTreeSet::new();
    for provider in &mut providers {
        provider.id = provider.id.trim().to_string();
        provider.name = provider.name.trim().to_string();
        provider.api_url = provider.api_url.trim().to_string();
        provider.model = provider.model.trim().to_string();
        provider.models.retain(|_, value| {
            *value = value.trim().to_string();
            !value.is_empty()
        });
        validate(provider)?;
        if !seen.insert(provider.id.clone()) {
            return Err(format!("供应商 ID 重复：{}", provider.id));
        }
    }
    let path = store_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    let store = Store { version: 1, providers: providers.clone() };
    write_atomic(&path, &serde_json::to_string_pretty(&store).map_err(|error| error.to_string())?)?;
    Ok(providers)
}

fn apply_claude(env: &mut BTreeMap<String, String>, provider: &ModelProvider) {
    let set = |env: &mut BTreeMap<String, String>, key: &str, value: &str| {
        if value.is_empty() { env.remove(key); } else { env.insert(key.to_string(), value.to_string()); }
    };
    set(env, "ANTHROPIC_BASE_URL", provider.api_url.trim());
    set(env, "ANTHROPIC_AUTH_TOKEN", provider.api_key.trim());
    // AUTH_TOKEN 优先；残留的 API_KEY 会让用户以为旧密钥还在生效。
    env.remove("ANTHROPIC_API_KEY");
    for (slot, key) in CLAUDE_MODEL_KEYS {
        let value = if slot == "main" {
            if provider.model.is_empty() { provider.models.get("main").map(String::as_str).unwrap_or("") } else { &provider.model }
        } else {
            provider.models.get(slot).map(String::as_str).unwrap_or("")
        };
        set(env, key, value.trim());
    }
}

/// 写进原生 settings.json 的完整托管集合：带上空值，才能把供应商里没填的旧模型键一并清掉。
fn claude_native_env(provider: &ModelProvider) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert("ANTHROPIC_BASE_URL".into(), provider.api_url.trim().to_string());
    env.insert("ANTHROPIC_AUTH_TOKEN".into(), provider.api_key.trim().to_string());
    env.insert("ANTHROPIC_API_KEY".into(), String::new());
    for (slot, key) in CLAUDE_MODEL_KEYS {
        let value = if slot == "main" {
            if provider.model.is_empty() { provider.models.get("main").map(String::as_str).unwrap_or("") } else { &provider.model }
        } else {
            provider.models.get(slot).map(String::as_str).unwrap_or("")
        };
        env.insert(key.into(), value.trim().to_string());
    }
    env
}

fn apply(app: &AppHandle, id: &str) -> Result<(), String> {
    let provider = load(app)?.into_iter().find(|item| item.id == id).ok_or("供应商不存在")?;
    validate(&provider)?;
    let kind = if provider.kind == "claude" { Provider::Claude } else { Provider::Codex };
    let mut settings = settings::load(app)?;
    let agent = settings.agents.get_mut(kind.key()).ok_or("CLI 设置缺失")?;
    match kind {
        Provider::Claude => {
            apply_claude(&mut agent.env, &provider);
            // 原生 env 会压过启动时注入的变量，只写覆盖层等于没应用。
            let path = settings::config_path(Provider::Claude)?;
            settings::save_claude_settings_at(&path, claude_native_env(&provider))?;
        }
        Provider::Codex => {
            let set = |env: &mut BTreeMap<String, String>, key: &str, value: &str| {
                if value.is_empty() { env.remove(key); } else { env.insert(key.to_string(), value.to_string()); }
            };
            set(&mut agent.env, "OPENAI_BASE_URL", provider.api_url.trim());
            set(&mut agent.env, "OPENAI_API_KEY", provider.api_key.trim());
        }
    }
    settings::save(app, settings)?;
    if kind == Provider::Codex {
        // 1. 生成并应用 Codex 模型清单，获得默认模型 slug
        let intent = codex_catalog::parse_provider_model(Some(&provider.model));
        let default_slug = codex_catalog::apply_provider_catalog(app, &intent)?;
        // 2. 写入 config.toml 的自有 provider 表及根 model，并同步写 auth.json
        settings::apply_codex_provider_route(provider.api_url.trim(), default_slug.as_deref(), provider.api_key.trim())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_providers_load(app: AppHandle) -> Result<Vec<ModelProvider>, String> {
    block(move || load(&app)).await
}

#[tauri::command]
pub async fn ai_providers_save(app: AppHandle, providers: Vec<ModelProvider>) -> Result<Vec<ModelProvider>, String> {
    block(move || save(&app, providers)).await
}

#[tauri::command]
pub async fn ai_providers_apply(app: AppHandle, id: String) -> Result<(), String> {
    block(move || apply(&app, &id)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> ModelProvider {
        ModelProvider {
            id: "gw-1".into(),
            name: "Gateway".into(),
            kind: "claude".into(),
            api_url: "https://api.example.com".into(),
            api_key: "sk-test".into(),
            model: "claude-sonnet-4-5".into(),
            models: BTreeMap::from([("haiku".to_string(), "claude-haiku-4-5".to_string())]),
        }
    }

    #[test]
    fn validates_ids_urls_and_unknown_model_slots() {
        assert!(validate(&provider()).is_ok());
        let mut item = provider();
        item.id = "../escape".into();
        assert!(validate(&item).is_err());
        let mut item = provider();
        item.api_url = "file:///etc/passwd".into();
        assert!(validate(&item).is_err());
        let mut item = provider();
        item.models.insert("bogus".into(), "x".into());
        assert!(validate(&item).is_err());
        let mut item = provider();
        item.kind = "gemini".into();
        assert!(validate(&item).is_err());

        // Claude model 限制 200，Codex model 放宽到 256KB
        let mut claude_long = provider();
        claude_long.model = "m".repeat(201);
        assert!(validate(&claude_long).is_err());

        let mut codex_long = provider();
        codex_long.kind = "codex".into();
        codex_long.models.clear();
        codex_long.model = "m".repeat(1000);
        assert!(validate(&codex_long).is_ok());
    }

    #[test]
    fn applying_claude_provider_sets_and_clears_env() {
        let item = provider();
        let mut env = BTreeMap::from([
            ("KEEP".to_string(), "1".to_string()),
            ("ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(), "stale".to_string()),
        ]);
        apply_claude(&mut env, &item);
        assert_eq!(env.get("KEEP").map(String::as_str), Some("1"));
        assert_eq!(env.get("ANTHROPIC_BASE_URL").map(String::as_str), Some("https://api.example.com"));
        assert_eq!(env.get("ANTHROPIC_MODEL").map(String::as_str), Some("claude-sonnet-4-5"));
        assert_eq!(env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL").map(String::as_str), Some("claude-haiku-4-5"));
        assert_eq!(env.get("ANTHROPIC_DEFAULT_OPUS_MODEL"), None);
        let empty = ModelProvider { api_url: String::new(), api_key: String::new(), model: String::new(), models: BTreeMap::new(), ..item };
        apply_claude(&mut env, &empty);
        assert_eq!(env.get("ANTHROPIC_BASE_URL"), None);
        assert_eq!(env.get("ANTHROPIC_MODEL"), None);
    }

    #[test]
    fn claude_native_env_includes_empties_so_stale_keys_are_removed() {
        let env = claude_native_env(&provider());
        assert_eq!(env.get("ANTHROPIC_BASE_URL").map(String::as_str), Some("https://api.example.com"));
        assert_eq!(env.get("ANTHROPIC_AUTH_TOKEN").map(String::as_str), Some("sk-test"));
        assert_eq!(env.get("ANTHROPIC_API_KEY").map(String::as_str), Some(""));
        assert_eq!(env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL").map(String::as_str), Some("claude-haiku-4-5"));
        assert_eq!(env.get("ANTHROPIC_DEFAULT_OPUS_MODEL").map(String::as_str), Some(""));
    }

    #[test]
    fn a_provider_needs_both_an_endpoint_and_a_key() {
        // 留空保存出来的供应商一旦「应用」，会把 CLI 里原本能用的端点与密钥一起清掉。
        let mut item = provider();
        item.api_url = "   ".into();
        assert!(validate(&item).is_err());
        let mut item = provider();
        item.api_key = "".into();
        assert!(validate(&item).is_err());
    }

    #[test]
    fn kind_is_fixed_and_a_bound_provider_cannot_be_removed() {
        let item = provider();
        // 类型改动被拒：另一种 CLI 会把这份供应商的模型当成自己的写法。
        let mut switched = item.clone();
        switched.kind = "codex".into();
        assert!(structural(&[item.clone()], &[switched], &BTreeMap::new()).is_err());
        // 还被 Codex 绑着时不许删，改绑之后才能删。
        let bound = BTreeMap::from([("codex".to_string(), settings::AgentSetting { provider: "gw-1".into(), ..Default::default() })]);
        assert!(structural(&[item.clone()], &[], &bound).is_err());
        let freed = BTreeMap::from([("codex".to_string(), settings::AgentSetting::default())]);
        assert!(structural(&[item], &[], &freed).is_ok());
    }

    #[test]
    fn clearing_the_key_while_editing_keeps_the_stored_one() {
        let item = provider();
        let mut cleared = item.clone();
        cleared.api_key = "  ".into();
        let mut next = vec![cleared];
        keep_keys(&[item], &mut next);
        assert_eq!(next[0].api_key, "sk-test");
        // 新建的供应商没有原值可沿用，空密钥照旧留给 validate 拒。
        let mut fresh = provider();
        fresh.api_key = String::new();
        let mut next = vec![fresh];
        keep_keys(&[], &mut next);
        assert!(validate(&next[0]).is_err());
    }

    #[test]
    fn claude_custom_model_option_travels_with_the_provider() {
        // 自定义模型选项是 /model 选择器里多出来的那一项，和六个槽位一样属于供应商。
        let mut item = provider();
        item.models.insert("customOption".into(), "my-gateway/claude-opus-5-5".into());
        item.models.insert("customOptionName".into(), "Gateway Opus".into());
        item.models.insert("customOptionDescription".into(), "Routed via gateway".into());
        assert!(validate(&item).is_ok());
        let env = claude_native_env(&item);
        assert_eq!(env.get("ANTHROPIC_CUSTOM_MODEL_OPTION").map(String::as_str), Some("my-gateway/claude-opus-5-5"));
        assert_eq!(env.get("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME").map(String::as_str), Some("Gateway Opus"));
        assert_eq!(env.get("ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION").map(String::as_str), Some("Routed via gateway"));
        let mut applied = BTreeMap::new();
        apply_claude(&mut applied, &item);
        assert_eq!(applied.get("ANTHROPIC_CUSTOM_MODEL_OPTION").map(String::as_str), Some("my-gateway/claude-opus-5-5"));
    }
}
