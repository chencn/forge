//! 可复用的模型供应商：保存名字、端点、密钥与模型，一键写进某个 CLI。
//!
//! 供应商本身存在 Forge 的配置目录。应用时写 CLI 真正读取的位置：
//! Claude 的 settings.json 会覆盖父进程注入的变量，所以必须落到它的 env；
//! Codex 的端点/密钥走环境变量与 auth.json，模型走 config.toml。
use super::{settings, Provider};
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

/// Claude Code 的模型槽位与对应环境变量。Codex 只用一个 `model`。
const CLAUDE_MODEL_KEYS: [(&str, &str); 6] = [
    ("main", "ANTHROPIC_MODEL"),
    ("reasoning", "ANTHROPIC_REASONING_MODEL"),
    ("haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
    ("sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"),
    ("opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"),
    ("fable", "ANTHROPIC_DEFAULT_FABLE_MODEL"),
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
    if provider.api_key.len() > MAX_KEY || provider.api_key.contains('\0') {
        return Err("API Key 过长或包含非法字符".into());
    }
    if provider.model.len() > MAX_MODEL || provider.model.contains('\0') {
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

fn save(app: &AppHandle, mut providers: Vec<ModelProvider>) -> Result<Vec<ModelProvider>, String> {
    if providers.len() > MAX_PROVIDERS {
        return Err(format!("最多保存 {MAX_PROVIDERS} 个供应商"));
    }
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
        // config.toml 里已有的 provider 会被 Codex 优先使用，端点与密钥同步写过去。
        settings::apply_codex_endpoint(&provider.model, provider.api_url.trim(), provider.api_key.trim())?;
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
}
