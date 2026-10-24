//! Codex 的可选模型来自它自带的目录。`config.toml` 里的 `model_catalog_json` 一旦指向某个 JSON，
//! 就是**整份替换**那份目录（实测：指到只含一个模型的文件后，`codex debug models` 只回那一个），
//! 所以 Forge 生成的文件必须在 Codex 原始条目的基础上改，只挑我们关心的字段写会把其它参数丢掉。
//!
//! 原始条目由 `codex debug models` 现场取回并缓存（实测 Codex 0.164.0：11 条、643 KB，
//! 其中 `model_messages` 与 `base_instructions` 占 97%，投影掉这两个键给界面只剩约 20 KB）。
//! 字段合法取值同样是实测出来的：枚举写成未知值会让**整份目录被拒**（`unknown variant`），
//! 未知键则被静默忽略（`supports_parallel_tool_calls`、`supports_reasoning_summary_parameter`
//! 在 0.164 已经是死键，所以这里不提供）。
use super::process::{checked_full as checked, command};
use super::settings::{self, backup_and_write};
use super::{home, resolve, Provider};
use crate::offload::block;
use crate::sys::write_atomic;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use toml_edit::{value as toml_value, DocumentMut};

/// Forge 里保存的用户意图（哪些模型排除、每个模型改了什么、加了哪些自定义模型）。
const INTENT_FILE: &str = "ai-codex-catalog.json";
/// 上一次成功取回的 Codex 原始目录缓存；CLI 调用失败时用它兜底。
const BASE_FILE: &str = "ai-codex-catalog-base.json";
/// 写进 CODEX_HOME 的生成文件；`model_catalog_json` 按 CODEX_HOME 相对解析。
const CATALOG_NAME: &str = "forge-model-catalog.json";
/// 界面用不着、但生成时必须原样保留的两个大字段。
const HEAVY_KEYS: [&str; 2] = ["model_messages", "base_instructions"];

/// 以下枚举全部来自 Codex 0.164.0 的实测回显，不在表内的值会报 `unknown variant` 并毁掉整份目录。
const TOOL_MODES: [&str; 3] = ["direct", "code_mode", "code_mode_only"];
const MULTI_AGENT_VERSIONS: [&str; 2] = ["v1", "v2"];
const REASONING_SUMMARIES: [&str; 4] = ["auto", "concise", "detailed", "none"];
const VERBOSITIES: [&str; 3] = ["low", "medium", "high"];
/// `default` / `local` / `shell_command` 虽然能被接受，但会被规范化成 `unified_exec`，
/// 摆在选项里会让用户以为改了而实际没改，所以只提供能原样回显的两个值。
const SHELL_TYPES: [&str; 2] = ["unified_exec", "disabled"];
const APPLY_PATCH_TYPES: [&str; 1] = ["freeform"];
const WEB_SEARCH_TYPES: [&str; 2] = ["text", "text_and_image"];
const VISIBILITIES: [&str; 2] = ["list", "hide"];
/// 实测会被原样回显的布尔开关；缺省语义由 Codex 自己决定，所以只在用户改动时写。
const MODEL_FLAGS: [&str; 7] = [
    "support_verbosity",
    "supports_search_tool",
    "supports_image_detail_original",
    "include_apps_usage_instructions",
    "include_plugin_usage_instructions",
    "include_skills_usage_instructions",
    "use_responses_lite",
];

const MAX_CUSTOMS: usize = 32;
const MAX_ENTRIES: usize = 128;
const MAX_SLUG: usize = 64;
const MAX_TEXT: usize = 500;

/// 单个模型的覆盖项。`None` 表示不碰基础条目；空串表示显式清除（写 JSON null）。
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelOverride {
    pub tool_mode: Option<String>,
    pub multi_agent_version: Option<String>,
    pub default_reasoning_level: Option<String>,
    pub default_reasoning_summary: Option<String>,
    pub default_verbosity: Option<String>,
    pub shell_type: Option<String>,
    pub apply_patch_tool_type: Option<String>,
    pub web_search_tool_type: Option<String>,
    pub visibility: Option<String>,
    pub context_window: Option<u64>,
    pub max_context_window: Option<u64>,
    /// 键必须落在 `MODEL_FLAGS` 里；界面按开关逐个渲染。
    pub flags: BTreeMap<String, bool>,
}

impl ModelOverride {
    fn is_empty(&self) -> bool {
        self.tool_mode.is_none()
            && self.multi_agent_version.is_none()
            && self.default_reasoning_level.is_none()
            && self.default_reasoning_summary.is_none()
            && self.default_verbosity.is_none()
            && self.shell_type.is_none()
            && self.apply_patch_tool_type.is_none()
            && self.web_search_tool_type.is_none()
            && self.visibility.is_none()
            && self.context_window.is_none()
            && self.max_context_window.is_none()
            && self.flags.is_empty()
    }
}

/// 自定义模型：复制一个官方条目的参数再覆盖，避免我们自己猜 Codex 的必填字段。
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomModel {
    pub slug: String,
    pub display_name: String,
    pub description: String,
    /// 作为模板的官方模型 slug。
    pub base: String,
    #[serde(rename = "overrides")]
    pub model_override: ModelOverride,
}

/// 用户在 Forge 里表达的完整意图。
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CatalogIntent {
    /// 被排除的官方模型 slug；整份替换语义下，不写进文件就是消失。
    pub excluded: Vec<String>,
    /// 官方模型的覆盖项，键是 slug。
    pub overrides: BTreeMap<String, ModelOverride>,
    pub customs: Vec<CustomModel>,
}

impl CatalogIntent {
    fn is_empty(&self) -> bool { self.excluded.is_empty() && self.overrides.is_empty() && self.customs.is_empty() }
}

/// 界面要的一切：合并完意图之后的实际目录（投影过）、状态与错误。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogView {
    /// 生成的目录文件绝对路径，界面直接展示，免得用户猜。
    pub path: String,
    /// `config.toml` 目前是否指向这份文件。
    pub active: bool,
    /// 取 Codex 原始目录失败时的说明；失败时用缓存继续渲染。
    pub error: Option<String>,
    pub intent: CatalogIntent,
    /// 合并完意图、投影掉两个大字段后的实际目录。
    pub models: Vec<Value>,
    /// 被排除掉的原始条目（同样投影过），界面靠它显示“已排除 + 放回”。
    pub hidden: Vec<Value>,
}

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|error| error.to_string())
}

fn intent_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(app_dir(app)?.join(INTENT_FILE)) }

fn base_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(app_dir(app)?.join(BASE_FILE)) }

/// CODEX_HOME 与 `~/.codex` 的取舍和 CLI 自己的规则一致，直接复用设置里的解析。
fn codex_home() -> Result<PathBuf, String> {
    let config = settings::config_path(Provider::Codex)?;
    config.parent().map(|dir| dir.to_path_buf()).ok_or_else(|| "Codex 配置目录无效".to_string())
}

fn catalog_path() -> Result<PathBuf, String> { Ok(codex_home()?.join(CATALOG_NAME)) }

/// slug 只进 JSON 字段、不进文件路径，所以允许网关常见的 `/`；空格与 NUL 仍然挡住。
fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SLUG
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/'))
}

fn text_ok(value: &str) -> bool { value.len() <= MAX_TEXT && !value.contains('\0') }

fn run_codex_models() -> Result<Value, String> {
    let path = resolve("codex")?;
    let output = checked(command(&path, &["debug", "models"]))?;
    parse_models_output(&output)
}

/// 解析 `codex debug models` 的输出。npm 启动器/CLI 可能先往 stdout 打一行
/// 警告或日志再输出 JSON 本体，所以直接解析失败时从第一个 `{` 重试；
/// 仍失败就把输出开头带进错误里，用户能直接看到 CLI 到底回了什么。
fn parse_models_output(output: &str) -> Result<Value, String> {
    let direct = serde_json::from_str(output);
    if let Ok(parsed) = direct {
        return require_models(parsed);
    }
    let Some(start) = output.find('{') else {
        return Err(format!("Codex 模型目录输出不是 JSON：{}", preview(output)));
    };
    match serde_json::from_str(&output[start..]) {
        Ok(parsed) => require_models(parsed),
        Err(error) => Err(format!("Codex 模型目录格式错误：{error}；输出开头：{}", preview(output))),
    }
}

fn require_models(parsed: Value) -> Result<Value, String> {
    if parsed.get("models").and_then(Value::as_array).is_none() {
        return Err("Codex 模型目录缺少 models 数组".into());
    }
    Ok(parsed)
}

fn preview(output: &str) -> String {
    let flattened = output.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>();
    let mut preview: String = flattened.chars().take(160).collect();
    if flattened.chars().count() > 160 { preview.push('…'); }
    preview
}

/// 取原始目录：优先现场问 CLI（拿到的是当前版本的真实参数），失败退回上次缓存。
/// 两条路都不通时把 CLI 的错误带回去，界面要能说清为什么没有清单。
fn load_base(app: &AppHandle) -> (Option<Value>, Option<String>) {
    match run_codex_models() {
        Ok(models) => {
            let path = base_path(app);
            if let (Ok(path), Ok(text)) = (path, serde_json::to_string(&models)) {
                let _ = write_atomic(&path, &text);
            }
            (Some(models), None)
        }
        Err(error) => {
            let cached = base_path(app).ok().and_then(|path| fs::read_to_string(path).ok())
                .and_then(|text| serde_json::from_str(&text).ok());
            match cached {
                Some(models) => (Some(models), Some(error)),
                None => (None, Some(error)),
            }
        }
    }
}

fn model_slug(model: &Value) -> Option<&str> { model.get("slug").and_then(Value::as_str) }

fn supported_efforts(template: &Value) -> Vec<String> {
    template.get("supported_reasoning_levels").and_then(Value::as_array)
        .map(|levels| levels.iter().filter_map(|level| level.get("effort").and_then(Value::as_str)).map(str::to_string).collect())
        .unwrap_or_default()
}

fn set_field(entry: &mut Map<String, Value>, key: &str, allowed: &[&str], raw: Option<&String>) -> Result<(), String> {
    let Some(value) = raw else { return Ok(()) };
    let value = value.trim();
    if value.is_empty() {
        entry.insert(key.to_string(), Value::Null);
        return Ok(());
    }
    if !allowed.contains(&value) {
        return Err(format!("{key} 只能是 {}，当前是 {value}", allowed.join(" / ")));
    }
    entry.insert(key.to_string(), Value::String(value.to_string()));
    Ok(())
}

fn apply_override(entry: &mut Map<String, Value>, override_fields: &ModelOverride, template: &Value) -> Result<(), String> {
    set_field(entry, "tool_mode", &TOOL_MODES, override_fields.tool_mode.as_ref())?;
    set_field(entry, "multi_agent_version", &MULTI_AGENT_VERSIONS, override_fields.multi_agent_version.as_ref())?;
    set_field(entry, "default_reasoning_summary", &REASONING_SUMMARIES, override_fields.default_reasoning_summary.as_ref())?;
    set_field(entry, "default_verbosity", &VERBOSITIES, override_fields.default_verbosity.as_ref())?;
    set_field(entry, "shell_type", &SHELL_TYPES, override_fields.shell_type.as_ref())?;
    set_field(entry, "apply_patch_tool_type", &APPLY_PATCH_TYPES, override_fields.apply_patch_tool_type.as_ref())?;
    set_field(entry, "web_search_tool_type", &WEB_SEARCH_TYPES, override_fields.web_search_tool_type.as_ref())?;
    set_field(entry, "visibility", &VISIBILITIES, override_fields.visibility.as_ref())?;

    // 推理档位 Codex 不校验（实测写个错值也照样回显），所以由我们限制在该模型支持的档位里。
    if let Some(level) = override_fields.default_reasoning_level.as_ref().map(|value| value.trim()) {
        if !level.is_empty() {
            let efforts = supported_efforts(template);
            if efforts.is_empty() {
                return Err("该模型没有可选推理档位，不能设默认档位".to_string());
            }
            if !efforts.iter().any(|effort| effort == level) {
                return Err(format!("默认推理档位只能是 {}，当前是 {level}", efforts.join(" / ")));
            }
            entry.insert("default_reasoning_level".to_string(), Value::String(level.to_string()));
        }
    }

    if let Some(window) = override_fields.context_window {
        if window == 0 { return Err("上下文长度必须大于 0".into()); }
        entry.insert("context_window".to_string(), Value::from(window));
    }
    if let Some(window) = override_fields.max_context_window {
        if window == 0 { return Err("最大上下文长度必须大于 0".into()); }
        entry.insert("max_context_window".to_string(), Value::from(window));
    }
    for (key, value) in &override_fields.flags {
        if !MODEL_FLAGS.contains(&key.as_str()) {
            return Err(format!("未知的模型开关：{key}"));
        }
        entry.insert(key.clone(), Value::Bool(*value));
    }
    Ok(())
}

/// 基础条目 + 意图 = 实际交给 Codex 的目录。排除即从文件里去掉，自定义即复制模板再覆盖。
fn generate(base: &Value, intent: &CatalogIntent) -> Result<Vec<Value>, String> {
    let models = base.get("models").and_then(Value::as_array).ok_or("Codex 模型目录缺少 models 数组")?;
    if models.len() > MAX_ENTRIES {
        return Err(format!("模型条目过多（{}）", models.len()));
    }
    let mut out: Vec<Value> = Vec::with_capacity(models.len());
    for model in models {
        let Some(slug) = model_slug(model) else { continue };
        if intent.excluded.iter().any(|item| item == slug) { continue; }
        let mut entry = model.as_object().cloned().unwrap_or_else(|| {
            let mut map = Map::new();
            map.insert("slug".to_string(), Value::String(slug.to_string()));
            map
        });
        if let Some(override_fields) = intent.overrides.get(slug) {
            apply_override(&mut entry, override_fields, model)?;
        }
        out.push(Value::Object(entry));
    }
    for custom in &intent.customs {
        let slug = custom.slug.trim();
        if !valid_slug(slug) {
            return Err(format!("自定义模型 slug 只能包含字母、数字、-、_、.、: 和 /，且不超过 {MAX_SLUG} 个字符：{}", custom.slug));
        }
        if !text_ok(&custom.display_name) || !text_ok(&custom.description) {
            return Err(format!("自定义模型 {slug} 的名称或描述过长"));
        }
        let template = models.iter().find(|model| model_slug(model) == Some(custom.base.trim()))
            .ok_or_else(|| format!("自定义模型 {slug} 的模板模型不存在：{}", custom.base))?;
        let mut entry = template.as_object().cloned().unwrap_or_default();
        entry.insert("slug".to_string(), Value::String(slug.to_string()));
        entry.insert("display_name".to_string(), Value::String(custom.display_name.clone()));
        entry.insert("description".to_string(), Value::String(custom.description.clone()));
        entry.insert("visibility".to_string(), Value::String("list".to_string()));
        entry.insert("supported_in_api".to_string(), Value::Bool(true));
        entry.insert("upgrade".to_string(), Value::Null);
        apply_override(&mut entry, &custom.model_override, template)?;
        if out.iter().any(|model| model_slug(model) == Some(slug)) {
            return Err(format!("自定义模型 {slug} 与现有模型重名"));
        }
        out.push(Value::Object(entry));
    }
    if out.is_empty() {
        return Err("模型清单不能为空：Codex 的目录是整份替换，全排除会让它没有可用模型".into());
    }
    Ok(out)
}

fn project(models: &[Value]) -> Vec<Value> {
    models.iter().map(|model| {
        let mut entry = model.clone();
        if let Some(map) = entry.as_object_mut() {
            for key in HEAVY_KEYS { map.remove(key); }
        }
        entry
    }).collect()
}

fn validate_intent(intent: &CatalogIntent) -> Result<(), String> {
    if intent.excluded.len() > MAX_ENTRIES || intent.overrides.len() > MAX_ENTRIES {
        return Err("模型清单的条目过多".into());
    }
    if intent.customs.len() > MAX_CUSTOMS {
        return Err(format!("自定义模型最多 {MAX_CUSTOMS} 个"));
    }
    for slug in &intent.excluded { if !valid_slug(slug) { return Err(format!("无效的模型 slug：{slug}")); } }
    for (slug, override_fields) in &intent.overrides {
        if !valid_slug(slug) { return Err(format!("无效的模型 slug：{slug}")); }
        if override_fields.is_empty() { return Err(format!("模型 {slug} 的覆盖项是空的，请先去掉这条覆盖")); }
    }
    Ok(())
}

/// 把 `model_catalog_json` 写成清单文件名（Codex 按 CODEX_HOME 解析）；`None` 表示删键回到内置目录。
fn set_catalog_key(file_name: Option<&str>) -> Result<(), String> {
    let path = settings::config_path(Provider::Codex)?;
    let existing = if path.exists() { fs::read_to_string(&path).map_err(|error| format!("读取 Codex 配置失败：{error}"))? } else { String::new() };
    let mut doc: DocumentMut = existing.parse().map_err(|error| format!("TOML 格式错误：{error}"))?;
    let changed = match file_name {
        Some(name) => {
            let current = doc.get("model_catalog_json").and_then(|item| item.as_str());
            if current == Some(name) { false } else { doc["model_catalog_json"] = toml_value(name); true }
        }
        None => doc.as_table_mut().remove("model_catalog_json").is_some(),
    };
    if !changed { return Ok(()); }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("无法创建 Codex 配置目录：{error}"))?;
    }
    backup_and_write(&path, &doc.to_string())
}

fn config_has_key() -> bool {
    settings::config_path(Provider::Codex).ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| text.parse::<DocumentMut>().ok())
        .is_some_and(|doc| doc.get("model_catalog_json").and_then(|item| item.as_str()) == Some(CATALOG_NAME))
}

/// 被排除的原始条目仍要交给界面，否则用户看不到「放回」的是哪个模型。
fn hidden_models(base: &Value, intent: &CatalogIntent) -> Vec<Value> {
    base.get("models").and_then(Value::as_array)
        .map(|items| items.iter()
            .filter(|item| model_slug(item).is_some_and(|slug| intent.excluded.iter().any(|excluded| excluded == slug)))
            .cloned()
            .collect())
        .unwrap_or_default()
}

/// 目录路径与状态只取决于 CODEX_HOME 与 config.toml，不需要 AppHandle。
fn view(intent: CatalogIntent, base: Option<Value>, error: Option<String>) -> Result<CatalogView, String> {
    let path = catalog_path()?;
    let (models, hidden) = match &base {
        Some(base) => if intent.is_empty() {
            (base.get("models").and_then(Value::as_array).cloned().unwrap_or_default(), Vec::new())
        } else {
            (generate(base, &intent)?, hidden_models(base, &intent))
        },
        None => (Vec::new(), Vec::new()),
    };
    Ok(CatalogView {
        path: path.display().to_string(),
        active: config_has_key(),
        error,
        intent,
        models: project(&models),
        hidden: project(&hidden),
    })
}

fn read_intent(app: &AppHandle) -> CatalogIntent {
    intent_path(app).ok().and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn ai_cli_codex_catalog_read(app: AppHandle) -> Result<CatalogView, String> {
    // 取清单（起进程）、读意图、渲染都在阻塞线程里做，UI 线程不碰磁盘。
    block(move || {
        let (base, error) = load_base(&app);
        view(read_intent(&app), base, error)
    }).await
}

#[tauri::command]
pub async fn ai_cli_codex_catalog_save(app: AppHandle, intent: CatalogIntent) -> Result<CatalogView, String> {
    block(move || save_intent(&app, intent)).await
}

fn save_intent(app: &AppHandle, intent: CatalogIntent) -> Result<CatalogView, String> {
    validate_intent(&intent)?;
    let dir = app_dir(app)?;
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建配置目录：{error}"))?;
    write_atomic(&intent_path(app)?, &serde_json::to_string_pretty(&intent).map_err(|error| error.to_string())?)?;

    let (base, error) = load_base(app);
    if intent.is_empty() {
        // 没有任何定制就退回 Codex 内置目录：删键，文件留着也无害，但清掉更干净。
        set_catalog_key(None)?;
        if let Ok(path) = catalog_path() { let _ = fs::remove_file(path); }
    } else {
        let source = base.clone().ok_or_else(|| error.clone().unwrap_or_else(|| "无法读取 Codex 模型目录".to_string()))?;
        let models = generate(&source, &intent)?;
        let path = catalog_path()?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|error| format!("无法创建 Codex 配置目录：{error}"))?;
        }
        let document = Value::Object(Map::from_iter([("models".to_string(), Value::Array(models))]));
        write_atomic(&path, &serde_json::to_string_pretty(&document).map_err(|error| error.to_string())?)?;
        set_catalog_key(Some(CATALOG_NAME))?;
    }
    view(intent, base, error)
}

/// 供设置页展示清单实际写到哪个 CODEX_HOME（`CODEX_HOME` 变量可改）。
#[tauri::command]
pub async fn ai_cli_codex_catalog_home() -> Result<String, String> {
    block(|| codex_home().or_else(|_| home()).map(|path| path.display().to_string())).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn catalog_parse_tolerates_cli_prefix_noise_and_reports_preview() {
        let clean = r#"{"models":[{"slug":"gpt-5.5"}]}"#;
        assert!(super::parse_models_output(clean).is_ok());
        // npm 启动器先打一行警告再输出 JSON 本体：从前一个 { 起解析。
        let noisy = "npm warn config deprecated
{\"models\":[{\"slug\":\"gpt-5.5\"}]}";
        assert!(super::parse_models_output(noisy).is_ok());
        // 整段都不是 JSON：错误里带上输出开头，用户能看到 CLI 回了什么。
        let broken = "npm error could not resolve";
        let error = super::parse_models_output(broken).unwrap_err();
        assert!(error.contains("npm error could not resolve"), "{error}");
    }

    use super::*;

    fn base() -> Value {
        serde_json::json!({ "models": [
            { "slug": "gpt-5.5", "display_name": "GPT-5.5", "visibility": "list", "supported_in_api": true,
              "shell_type": "unified_exec", "context_window": 272000, "tool_mode": "code_mode_only",
              "default_reasoning_level": "low", "priority": 1, "comp_hash": 3000u64,
              "model_messages": { "huge": "x" }, "base_instructions": "instructions",
              "supported_reasoning_levels": [{ "effort": "low" }, { "effort": "high" }] },
            { "slug": "gpt-6-astra", "display_name": "GPT-6-Astra", "visibility": "list", "supported_in_api": true,
              "shell_type": "unified_exec", "context_window": 400000, "priority": 2,
              "supported_reasoning_levels": [{ "effort": "medium" }] }
        ]})
    }

    #[test]
    fn override_writes_only_touched_fields_and_keeps_the_rest_verbatim() {
        let intent = CatalogIntent {
            excluded: Vec::new(),
            overrides: BTreeMap::from([("gpt-5.5".to_string(), ModelOverride {
                default_verbosity: Some("high".into()),
                tool_mode: Some(String::new()),
                flags: BTreeMap::from([("use_responses_lite".to_string(), true)]),
                ..ModelOverride::default()
            })]),
            customs: Vec::new(),
        };
        let models = generate(&base(), &intent).unwrap();
        let first = models[0].as_object().unwrap();
        assert_eq!(first.get("default_verbosity").unwrap().as_str(), Some("high"));
        assert_eq!(first.get("tool_mode").unwrap(), &Value::Null, "空串按显式清除写成 null");
        assert_eq!(first.get("use_responses_lite").unwrap().as_bool(), Some(true));
        assert_eq!(first.get("context_window").unwrap().as_u64(), Some(272000), "没改的字段必须原样留着");
        assert!(first.contains_key("comp_hash"), "未知但存在的键不能被丢掉");
        assert_eq!(models[1].as_object().unwrap().get("priority").unwrap().as_u64(), Some(2));
    }

    #[test]
    fn unknown_enum_values_are_rejected_before_they_can_poison_the_catalog() {
        // 实测：Codex 遇到未知枚举会拒掉整份目录，所以这一层必须自己挡。
        let intent = CatalogIntent {
            overrides: BTreeMap::from([("gpt-5.5".to_string(), ModelOverride { shell_type: Some("local".into()), ..ModelOverride::default() })]),
            ..CatalogIntent::default()
        };
        assert!(generate(&base(), &intent).is_err(), "default/local/shell_command 会被规范化成 unified_exec，不提供");
        let intent = CatalogIntent {
            overrides: BTreeMap::from([("gpt-5.5".to_string(), ModelOverride { default_reasoning_level: Some("ultra".into()), ..ModelOverride::default() })]),
            ..CatalogIntent::default()
        };
        assert!(generate(&base(), &intent).is_err(), "推理档位必须落在该模型支持的档位里");
        let intent = CatalogIntent {
            overrides: BTreeMap::from([("gpt-5.5".to_string(), ModelOverride {
                default_reasoning_level: Some("high".into()),
                flags: BTreeMap::from([("supports_parallel_tool_calls".to_string(), true)]),
                ..ModelOverride::default()
            })]),
            ..CatalogIntent::default()
        };
        assert!(generate(&base(), &intent).is_err(), "0.164 已忽略的死键不再提供");
    }

    #[test]
    fn excluding_drops_entries_and_customs_copy_their_template() {
        let intent = CatalogIntent {
            excluded: vec!["gpt-6-astra".into()],
            overrides: BTreeMap::new(),
            customs: vec![CustomModel {
                slug: "gw/claude-opus".into(),
                display_name: "Gateway Opus".into(),
                description: "routed".into(),
                base: "gpt-5.5".into(),
                model_override: ModelOverride { visibility: Some("list".into()), ..ModelOverride::default() },
            }],
        };
        let models = generate(&base(), &intent).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(model_slug(&models[0]), Some("gpt-5.5"));
        let custom = models[1].as_object().unwrap();
        assert_eq!(custom.get("slug").unwrap().as_str(), Some("gw/claude-opus"));
        assert_eq!(custom.get("display_name").unwrap().as_str(), Some("Gateway Opus"));
        assert_eq!(custom.get("context_window").unwrap().as_u64(), Some(272000), "自定义模型继承模板参数");
        assert!(custom.contains_key("supported_reasoning_levels"));
        assert_eq!(custom.get("upgrade"), Some(&Value::Null));
    }

    #[test]
    fn bad_customs_are_blocked() {
        let mut intent = CatalogIntent {
            customs: vec![CustomModel { slug: "bad slug".into(), base: "gpt-5.5".into(), ..CustomModel::default() }],
            ..CatalogIntent::default()
        };
        assert!(generate(&base(), &intent).is_err());
        intent = CatalogIntent {
            customs: vec![CustomModel { slug: "mine".into(), base: "ghost".into(), ..CustomModel::default() }],
            ..CatalogIntent::default()
        };
        assert!(generate(&base(), &intent).is_err(), "模板模型不存在要报错，而不是猜一份骨架");
        intent = CatalogIntent {
            customs: vec![CustomModel { slug: "gpt-5.5".into(), base: "gpt-5.5".into(), ..CustomModel::default() }],
            ..CatalogIntent::default()
        };
        assert!(generate(&base(), &intent).is_err(), "不能和现有模型重名");
        intent = CatalogIntent { excluded: vec!["gpt-5.5".into(), "gpt-6-astra".into()], ..CatalogIntent::default() };
        assert!(generate(&base(), &intent).is_err(), "全排除会让 Codex 没有可用模型");
    }

    #[test]
    fn intent_validation_catches_empty_overrides_and_junk_slugs() {
        assert!(validate_intent(&CatalogIntent::default()).is_ok());
        assert!(validate_intent(&CatalogIntent {
            overrides: BTreeMap::from([("gpt-5.5".to_string(), ModelOverride::default())]),
            ..CatalogIntent::default()
        }).is_err());
        // slug 只当 JSON 字段用、从不拼成路径，所以真正要挡的是空白和超长，而不是点号斜杠。
        assert!(validate_intent(&CatalogIntent { excluded: vec!("bad slug".into()), ..CatalogIntent::default() }).is_err());
        assert!(validate_intent(&CatalogIntent { excluded: vec!("g/w-1.0:tag".into()), ..CatalogIntent::default() }).is_ok());
        assert!(CatalogIntent::default().is_empty());
    }

    #[test]
    fn excluded_entries_stay_visible_to_the_ui_so_it_can_offer_restore() {
        let intent = CatalogIntent { excluded: vec!["gpt-6-astra".into()], ..CatalogIntent::default() };
        let hidden = hidden_models(&base(), &intent);
        assert_eq!(hidden.len(), 1);
        assert_eq!(model_slug(&hidden[0]), Some("gpt-6-astra"));
        let kept = generate(&base(), &intent).unwrap();
        assert_eq!(kept.len(), 1, "排除的条目不能出现在实际目录里");
    }

    #[test]
    fn projection_strips_the_payload_but_generation_keeps_it() {
        let models = generate(&base(), &CatalogIntent::default()).unwrap();
        assert_eq!(models[0].as_object().unwrap().get("base_instructions").unwrap().as_str(), Some("instructions"));
        let shown = project(&models);
        assert!(!shown[0].as_object().unwrap().contains_key("model_messages"));
        assert!(!shown[0].as_object().unwrap().contains_key("base_instructions"));
        assert!(shown[0].as_object().unwrap().contains_key("context_window"));
    }

    #[test]
    fn catalog_json_key_is_written_and_removed_without_touching_the_rest() {
        let dir = std::env::temp_dir().join(format!("forge-catalog-toml-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        fs::write(&path, "# 用户的注释\nmodel = \"gpt-5.5\"\n\n[features]\ndefault_mode_request_user_input = true\n").unwrap();
        let write = |name: Option<&str>| -> Result<(), String> {
            let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            let mut doc = text.parse::<DocumentMut>().map_err(|error| error.to_string())?;
            let changed = match name {
                Some(name) => { doc["model_catalog_json"] = toml_value(name); true }
                None => doc.as_table_mut().remove("model_catalog_json").is_some(),
            };
            let _ = changed;
            fs::write(&path, doc.to_string()).map_err(|error| error.to_string())
        };
        write(Some(CATALOG_NAME)).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("# 用户的注释"), "注释必须保住");
        assert!(text.contains(&format!("model_catalog_json = \"{CATALOG_NAME}\"")));
        write(None).unwrap();
        assert!(!fs::read_to_string(&path).unwrap().contains("model_catalog_json"));
        assert!(fs::read_to_string(&path).unwrap().contains("[features]"));
        let _ = fs::remove_dir_all(dir);
    }
}
