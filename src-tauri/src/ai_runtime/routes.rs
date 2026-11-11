//! 会话供应商快照：入队时冻结，启动时只覆盖当前子进程，不写全局 CLI 配置。
use crate::ai_cli::{codex_catalog, providers, Provider};
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager};

/// Codex 子进程内独有的供应商标识，线程启动与恢复都必须显式使用它。
pub(super) const CODEX_PROVIDER: &str = "forge_session";
/// 本轮供应商配置及已生成的目录；不序列化到事件或 IPC。
#[derive(Clone)]
pub(super) struct Route {
    /// 包含凭据的后端内存快照。
    supplier: providers::ModelProvider,
    /// 当前供应商可选模型与能力。
    pub catalog: Value,
    /// 不含凭据的不可变模型目录缓存。
    catalog_path: Option<PathBuf>,
}

/// 构建当前供应商的模型与凭据快照；None 表示沿用 Agent 配置。
///
/// # Errors
///
/// 供应商删除、跨引擎引用、目录生成或缓存写入失败时返回错误。
pub(super) fn resolve(app: &AppHandle, provider: Provider, id: Option<&str>, mut catalog: Value) -> Result<Option<Route>, String> {
    let Some(id) = id else { return Ok(None); };
    // 校验后读出的完整供应商快照；排队后不再回读配置。
    let supplier = providers::runtime_provider(app, provider, id)?;
    // 仅 Codex 使用目录文件，Claude 的模型槽位直接随进程注入。
    let mut catalog_path = None;
    if provider == Provider::Codex {
        // 供应商的模型字段保存完整目录意图。
        let intent = codex_catalog::parse_provider_model(Some(&supplier.model));
        // 运行目录与选择器模型来自同一次生成。
        let (document, choices) = codex_catalog::session_catalog(app, &intent)?;
        catalog["models"] = choices;
        catalog["customModels"] = json!([]);
        // 目录没有凭据；按内容寻址，使并行会话及排队回合不会覆盖彼此。
        let text = serde_json::to_string(&document).map_err(|error| error.to_string())?;
        // 内容哈希仅用于本地缓存命名，不用于安全校验。
        let mut hash = DefaultHasher::new();
        text.hash(&mut hash);
        // 应用缓存与用户的 Codex 全局目录分开保存。
        let directory = app.path().app_cache_dir().map_err(|error| error.to_string())?.join("session-model-catalogs");
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        // 同一份目录复用文件，不在每次打开模型菜单时重写。
        let path = directory.join(format!("{:016x}.json", hash.finish()));
        if std::fs::read_to_string(&path).ok().as_deref() != Some(&text) { crate::sys::write_atomic(&path, &text)?; }
        catalog_path = Some(path);
    } else {
        catalog["models"] = super::options::defaults(Provider::Claude)["models"].clone();
        // 从未应用全局映射的基础目录开始，避免残留其他供应商的模型别名。
        let mappings = serde_json::to_value(providers::claude_native_env(&supplier)).map_err(|error| error.to_string())?;
        super::options::apply_claude_mappings(&mut catalog, &mappings);
        if let Some(models) = catalog["models"].as_array_mut() {
            for model in models { model["isDefault"] = json!(model["id"] == "default"); }
        }
        catalog["customModels"] = json!([]);
    }
    Ok(Some(Route { supplier, catalog, catalog_path }))
}

impl Route {
    /// 当前供应商的默认模型；空配置让调用方沿用引擎默认。
    pub fn default_model(&self) -> Option<String> {
        if self.supplier.kind == "claude" {
            return Some(super::options::configured_model(&self.catalog, "default")).filter(|model| !model.is_empty() && model != "default");
        }
        self.catalog["models"].as_array()?.iter().find(|model| model["isDefault"] == true)?["id"].as_str().map(str::to_owned)
    }

    /// 只向当前命令注入供应商；Claude 用最高优先级 settings 覆盖用户/项目 env。
    pub fn apply(&self, command: &mut Command) {
        if self.supplier.kind == "claude" {
            // 空槽位也传入，清掉之前供应商的模型或 API Key 残留。
            let env = providers::claude_native_env(&self.supplier);
            command.envs(&env).arg("--settings").arg(json!({"env":env}).to_string());
        } else {
            command.env("FORGE_SESSION_API_KEY", &self.supplier.api_key);
            // TOML 值通过序列化转义；密钥仅通过环境传递，不进入命令行或目录。
            command.arg("-c").arg(format!("model_provider={}", json!(CODEX_PROVIDER)));
            command.arg("-c").arg(format!("model_providers.{CODEX_PROVIDER}={{ name = \"Forge session\", base_url = {}, env_key = \"FORGE_SESSION_API_KEY\", wire_api = \"responses\", requires_openai_auth = false }}", json!(self.supplier.api_url.trim_end_matches('/'))));
            if let Some(path) = &self.catalog_path {
                command.arg("-c").arg(format!("model_catalog_json={}", json!(path.to_string_lossy())));
            }
            if let Some(model) = self.default_model() { command.arg("-c").arg(format!("model={}", json!(model))); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 命令边界验证：两个会话的环境和 CLI 覆盖独立，不读取或改写全局配置。
    #[test]
    fn route_overrides_are_isolated_per_process() {
        for kind in ["claude", "codex"] {
            for id in ["a", "b"] {
                let route = Route {
                    supplier: providers::ModelProvider { id: id.into(), kind: kind.into(), name: id.into(),
                        api_url: format!("https://{id}.example/v1"), api_key: format!("fixture-{id}"), model: "opus[1m]".into(),
                        models: std::collections::BTreeMap::from([("sonnet".into(), format!("{id}-sonnet[1m]"))]) },
                    catalog: json!({"models":[{"id":"test-model","isDefault":true}]}),
                    catalog_path: Some(PathBuf::from(format!("C:/cache/{id}.json"))),
                };
                let mut command = Command::new("fixture-cli");
                command.env("ANTHROPIC_API_KEY", "previous");
                route.apply(&mut command);
                let env: std::collections::BTreeMap<_, _> = command.get_envs().map(|(key, value)| (key.to_string_lossy().into_owned(), value.map(|value| value.to_string_lossy().into_owned()))).collect();
                let args: Vec<_> = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
                if kind == "claude" {
                    let settings: Value = serde_json::from_str(&args[args.iter().position(|arg| arg == "--settings").unwrap() + 1]).unwrap();
                    assert_eq!(settings["env"]["ANTHROPIC_AUTH_TOKEN"], format!("fixture-{id}"));
                    assert_eq!(settings["env"]["ANTHROPIC_BASE_URL"], format!("https://{id}.example/v1"));
                    assert_eq!(settings["env"]["ANTHROPIC_MODEL"], "opus[1m]");
                    assert_eq!(settings["env"]["ANTHROPIC_API_KEY"], "");
                    assert_eq!(env["ANTHROPIC_AUTH_TOKEN"].as_deref(), Some(format!("fixture-{id}").as_str()));
                } else {
                    let overrides: Vec<toml::Value> = args.chunks_exact(2).map(|pair| {
                        assert_eq!(pair[0], "-c");
                        toml::from_str(&pair[1]).unwrap()
                    }).collect();
                    assert!(overrides.iter().any(|value| value.get("model_provider").and_then(toml::Value::as_str) == Some(CODEX_PROVIDER)));
                    let supplier = overrides.iter().find_map(|value| value.get("model_providers")).unwrap().get(CODEX_PROVIDER).unwrap();
                    assert_eq!(supplier["base_url"].as_str(), Some(format!("https://{id}.example/v1").as_str()));
                    assert_eq!(supplier["env_key"].as_str(), Some("FORGE_SESSION_API_KEY"));
                    assert_eq!(env["FORGE_SESSION_API_KEY"].as_deref(), Some(format!("fixture-{id}").as_str()));
                    assert!(!args.iter().any(|arg| arg.contains("fixture-")));
                }
            }
        }
    }
}
