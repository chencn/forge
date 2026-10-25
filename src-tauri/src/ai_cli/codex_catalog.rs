//! Codex 的可选模型来自它自带的目录。`config.toml` 里的 `model_catalog_json` 一旦指向某个 JSON，
//! 就是**整份替换**那份目录：实测 0.164.0 指到 `{"models":[]}` 时 `thread/start` 直接拒绝
//! `model_catalog_json path … must contain at least one model`——若还能跟内置目录合并，空文件不该报错。
//! 所以 Forge 生成的文件必须在 Codex 原始条目的基础上改，只挑我们关心的字段写会把其它参数丢掉。
//!
//! 原始条目由 `codex debug models` 现场取回并缓存（实测 Codex 0.164.0：11 条、658 KB，其中
//! `model_messages` 428 KB、`base_instructions` 207 KB，投影掉这两个键给界面只剩约 20 KB；
//! 系统提示词按需在展开覆盖面板时单独取，见 `ai_cli_codex_catalog_text`）。
//! 注意这条取回通道不反映 `model_catalog_json`：`codex debug models` 和 `model/list` 都只回内置表
//! （实测把目录裁到只剩一个模型，两者仍回 11 条），真正会解析它的是 `thread/start` 的 `config` 覆盖。
//!
//! 字段合法取值不写死：每次目录刷新都现场问一次 Codex（见 `probe_domains`）——把某个字段写成
//! 非法值再让它解析目录，它自己的 `unknown variant …, expected one of …` 就是取值域，写 `null`
//! 则告我们这个字段能不能清除。下面的常量只是问不到时的兜底表。
//! 已知的失败方式值得记住：枚举写成未知值、或往非 `Option` 字段写 `null`，都会让**整份目录被拒**
//! （`thread/start` 直接返回 `failed to load configuration`）；未知键则被静默忽略
//! （`supports_parallel_tool_calls` 在 0.164 已经是死键，探测会把界面里的对应开关摘掉）。
use super::process::{checked_full as checked, command};
use super::settings::{self, backup_and_write};
use super::{home, resolve, Provider};
use crate::offload::block;
use crate::sys::write_atomic;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
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
/// 生成时必须原样保留、但不随目录整体塞给界面的两个大字段（占整份文件 97%）：
/// 系统提示词在展开某一行时才按 slug 单独取（`ai_cli_codex_catalog_text`）。
const HEAVY_KEYS: [&str; 2] = ["model_messages", "base_instructions"];

/// 兜底取值域：只有问不到 CLI 时才用（取值本身由 `probe_domains` 现问）。
/// 这份表按 Codex 0.164.0 的实测结果抄录，界面上会标成「未核实」。
const TOOL_MODES: [&str; 3] = ["direct", "code_mode", "code_mode_only"];
const MULTI_AGENT_VERSIONS: [&str; 2] = ["v1", "v2"];
const REASONING_SUMMARIES: [&str; 4] = ["auto", "concise", "detailed", "none"];
const VERBOSITIES: [&str; 3] = ["low", "medium", "high"];
/// 0.164 实测接受 5 种写法；`default` / `local` / `shell_command` 与 `unified_exec` 的差别
/// 我们没有任何通道能读回来（目录不回显、`model/list` 不读它），所以照 CLI 的话全给界面，
/// 不替它挑。
const SHELL_TYPES: [&str; 5] = ["default", "local", "shell_command", "unified_exec", "disabled"];
const APPLY_PATCH_TYPES: [&str; 1] = ["freeform"];
const WEB_SEARCH_TYPES: [&str; 2] = ["text", "text_and_image"];
const VISIBILITIES: [&str; 3] = ["list", "hide", "none"];
/// 界面渲染成下拉的目录字段：`(键, 兜底取值域, 兜底能否写 null)`。
const ENUM_FIELDS: [(&str, &[&str], bool); 8] = [
    ("tool_mode", &TOOL_MODES, true),
    ("multi_agent_version", &MULTI_AGENT_VERSIONS, true),
    ("default_reasoning_summary", &REASONING_SUMMARIES, false),
    ("default_verbosity", &VERBOSITIES, true),
    ("shell_type", &SHELL_TYPES, false),
    ("apply_patch_tool_type", &APPLY_PATCH_TYPES, true),
    ("web_search_tool_type", &WEB_SEARCH_TYPES, false),
    ("visibility", &VISIBILITIES, false),
];
/// 探测用的非法值：只会出现在临时探测文件里，且不可能被当成合法取值（含空格）。
const PROBE_BAD_VALUE: &str = "forge probe invalid value";
/// 布尔开关的候选表：Codex 对已知键写错类型会报 `invalid type: string "yes", expected a boolean`，
/// 对已经废弃的键则完全不理——报不报错就是这一版 CLI 还认不认它，界面据此决定显不显示。
const MODEL_FLAGS: [&str; 8] = [
    "use_responses_lite",
    "supports_image_detail_original",
    "support_verbosity",
    "supports_search_tool",
    "include_apps_usage_instructions",
    "include_plugin_usage_instructions",
    "include_skills_usage_instructions",
    "supports_reasoning_summary_parameter",
];
/// 实测取值域单独缓存：探测一次约 1 秒，只在 CLI 版本变了以后重来，不能每次开面板都付。
const DOMAINS_FILE: &str = "ai-codex-catalog-domains.json";

const MAX_CUSTOMS: usize = 32;
const MAX_ENTRIES: usize = 128;
const MAX_SLUG: usize = 64;
const MAX_TEXT: usize = 500;
/// 系统提示词的量级：Codex 自带的就有一两万字，所以它不能跟名称共用同一条上限。
const MAX_INSTRUCTIONS: usize = 200_000;

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
    /// 系统提示词：Codex 条目里最贵的一段文本，界面按需取（见 `ai_cli_codex_catalog_text`）。
    pub base_instructions: Option<String>,
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
            && self.base_instructions.is_none()
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
    /// 作为模板的官方模型 slug。空或对不上快照时，回退到 priority 最小的官方条目。
    pub base: String,
    /// 手写的上下文窗口。有值就写进目录，并把 max_context_window 抬到至少这个数。
    pub context_window: Option<u64>,
    #[serde(rename = "overrides")]
    pub model_override: ModelOverride,
}

/// 用户在 Forge 里表达的完整意图。存在供应商的 `model` 字段里，也镜像到意图文件供选择器读取。
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CatalogIntent {
    /// 被排除的官方模型 slug；整份替换语义下，不写进文件就是消失。
    pub excluded: Vec<String>,
    /// 官方模型的覆盖项，键是 slug。
    pub overrides: BTreeMap<String, ModelOverride>,
    pub customs: Vec<CustomModel>,
    /// 显式默认模型。配置有效时：此值仍被列出 → 第一个 custom → 最高 priority 的未排除 listable 官方。
    #[serde(rename = "default")]
    pub default_model: Option<String>,
}

impl CatalogIntent {
    /// 单独的 default 不算非空：没有自定义、覆盖、排除就等于没改过目录。
    fn is_empty(&self) -> bool { self.excluded.is_empty() && self.overrides.is_empty() && self.customs.is_empty() }
}

/// 一个字段的取值域。`verified` 为真表示这份列表是**这一版 Codex 亲口报的**；
/// 为假时用的是兜底表，界面必须标成未核实，不能冒充事实。
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FieldDomain {
    pub values: Vec<String>,
    /// Codex 是否接受这个字段写 `null`（即界面上的「清除」）。往非 `Option` 字段写 null
    /// 会让整份目录被拒，所以这不是「体验取舍」而是硬约束。
    pub nullable: bool,
    pub verified: bool,
}

/// 取值域缓存：按 CLI 版本失效。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct DomainCache {
    cli_version: String,
    fields: BTreeMap<String, FieldDomain>,
    flags: Vec<String>,
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
    /// 每个枚举字段的取值域（问得到就用 Codex 亲口报的，问不到用兜底表并标未核实）。
    pub domains: BTreeMap<String, FieldDomain>,
    /// 这一版 Codex 还认的布尔开关；界面只渲染这些。
    pub flags: Vec<String>,
    /// `flags` 是不是现问的；为假时按候选全给，界面要标「未核实」。
    pub flags_verified: bool,
}

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|error| error.to_string())
}

fn intent_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(app_dir(app)?.join(INTENT_FILE)) }

fn base_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(app_dir(app)?.join(BASE_FILE)) }

fn domains_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(app_dir(app)?.join(DOMAINS_FILE)) }

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

/// 兜底：取值域抄 0.164 的实测结果并全部标成未核实，开关按候选全给。
/// 只在问不到 CLI 时用——界面上必须看得出来这不是这一版的事实。
fn fallback_domains() -> (BTreeMap<String, FieldDomain>, Vec<String>, bool) {
    let mut fields = BTreeMap::new();
    for (key, values, nullable) in ENUM_FIELDS {
        fields.insert(key.to_string(), FieldDomain { values: values.iter().map(|value| (*value).to_string()).collect(), nullable, verified: false });
    }
    (fields, MODEL_FLAGS.iter().map(|key| (*key).to_string()).collect(), false)
}

/// 从 Codex 的报错原文里取出反引号包住的合法值。
/// 只认 `expected` 之后的部分：路径本身也在反引号里，整段扫会把文件名当成取值。
fn values_from_error(message: &str) -> Vec<String> {
    let Some(anchor) = message.rfind("expected") else { return Vec::new(); };
    let mut values = Vec::new();
    let mut current = String::new();
    let mut inside = false;
    for ch in message[anchor + "expected".len()..].chars() {
        if ch == '`' {
            if inside && !current.is_empty() { values.push(std::mem::take(&mut current)); }
            inside = !inside;
        } else if inside { current.push(ch); }
    }
    // 探测值本身带空格，任何含空格的东西都不是枚举值（含被截断的半句）。
    values.retain(|value| !value.is_empty() && !value.contains(' ') && value != PROBE_BAD_VALUE);
    values
}

/// 现问 Codex：每个枚举字段两趟（非法值 → 取值域，`null` → 能不能清除），
/// 每个开关一趟（写错类型 → 这一版还认不认这个键）。实测 0.164.0 全部 24 趟约 1 秒。
/// 只改一条官方条目、只起一个 app-server、会话用 `ephemeral` 不落盘。
fn probe_domains(base: &Value) -> Result<(BTreeMap<String, FieldDomain>, Vec<String>), String> {
    let template = base.get("models").and_then(Value::as_array)
        .and_then(|models| models.first().and_then(Value::as_object).cloned())
        .ok_or("Codex 模型目录为空，无法探测字段")?;
    let dir = std::env::temp_dir().join(format!("forge-codex-probe-{}", std::process::id()));
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建探测临时目录：{error}"))?;
    let file = dir.join("probe-catalog.json");
    // Windows 下 `thread/start` 会把路径原样写进 JSON；分隔符统一成正斜杠，报错里也更好读。
    let path_text = file.display().to_string().replace('\\', "/");
    let cwd = dir.display().to_string();
    let mut slots: Vec<(&str, Probe)> = Vec::new();
    for (key, _, _) in ENUM_FIELDS { slots.push((key, Probe::Bogus)); slots.push((key, Probe::Null)); }
    for key in MODEL_FLAGS { slots.push((key, Probe::WrongType)); }
    let answers = crate::ai_runtime::options::codex_catalog_probe(&cwd, slots.len(), &mut |index| {
        let (key, probe) = slots[index];
        let mut entry = template.clone();
        match probe {
            Probe::Bogus => entry.insert(key.to_string(), Value::String(PROBE_BAD_VALUE.to_string())),
            Probe::Null => entry.insert(key.to_string(), Value::Null),
            Probe::WrongType => entry.insert(key.to_string(), Value::String("yes".to_string())),
        };
        let document = Value::Object(Map::from_iter([("models".to_string(), Value::Array(vec![Value::Object(entry)]))]));
        fs::write(&file, serde_json::to_string(&document).map_err(|error| format!("写入探测目录失败：{error}"))?)
            .map_err(|error| format!("写入探测目录失败：{error}"))?;
        Ok(path_text.clone())
    });
    let _ = fs::remove_dir_all(&dir);
    let answers = answers?;
    let (mut fields, _, _) = fallback_domains();
    let mut live: Vec<String> = Vec::new();
    let mut index = 0usize;
    for (key, _, _) in ENUM_FIELDS {
        let bogus = answers.get(index).cloned().transpose();
        let null = answers.get(index + 1).cloned().transpose();
        index += 2;
        // 只有「写非法值被拒」才算问到了取值域；写非法值也被接受说明这一版不校验这个字段，
        // 那更不能拿我们的表冒充它的答案。
        let Err(message) = bogus else { continue };
        let values = values_from_error(&message);
        if values.is_empty() { continue; }
        let nullable = matches!(null, Ok(Some(())));
        fields.insert(key.to_string(), FieldDomain { values, nullable, verified: true });
    }
    for key in MODEL_FLAGS {
        // 报类型错 = 这个键仍在被解析；被静默忽略 = 这一版已经不需要它，界面上也就没必要留。
        if answers.get(index).map(|answer| answer.is_err()).unwrap_or(true) { live.push(key.to_string()); }
        index += 1;
    }
    Ok((fields, live))
}

#[derive(Clone, Copy)]
enum Probe {
    Bogus,
    Null,
    WrongType,
}

/// 取值域从缓存读；缺失或 CLI 版本换了就现探一次并写回。探测失败不阻断界面——
/// 退回上次缓存/兜底表，并把原因并进 `error` 里让用户看得见来源。
fn resolve_domains(app: &AppHandle, base: Option<&Value>) -> (BTreeMap<String, FieldDomain>, Vec<String>, bool, Option<String>) {
    let version = super::installed_version(Provider::Codex).unwrap_or_default();
    let cache = domains_path(app).ok().and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<DomainCache>(&text).ok());
    if let Some(found) = cache.as_ref() {
        if !version.is_empty() && found.cli_version == version && !found.fields.is_empty() {
            return (found.fields.clone(), found.flags.clone(), true, None);
        }
    }
    let probed = match base {
        Some(base) => probe_domains(base),
        // 连原始目录都没有（CLI 不可用且没缓存）：没什么可探测的，照上次缓存或兜底表渲染。
        None => match cache {
            Some(cache) => return (cache.fields, cache.flags, false, None),
            None => { let (fields, flags, _) = fallback_domains(); return (fields, flags, false, None); }
        },
    };
    match probed {
        Ok((fields, flags)) => {
            if let Ok(path) = domains_path(app) {
                // 首次读取时配置目录可能还不存在：写不进去就等于每次都重新探测，白付一秒。
                if let Some(dir) = path.parent() { let _ = fs::create_dir_all(dir); }
                let fresh = DomainCache { cli_version: version, fields: fields.clone(), flags: flags.clone() };
                if let Ok(text) = serde_json::to_string_pretty(&fresh) { let _ = write_atomic(&path, &text); }
            }
            (fields, flags, true, None)
        }
        // 探测失败不阻断界面：退回兜底表，来源标成未核实，并把原因并进展示里。
        Err(error) => {
            let (fields, flags, _) = fallback_domains();
            (fields, flags, false, Some(error))
        }
    }
}


fn supported_efforts(template: &Value) -> Vec<String> {
    template.get("supported_reasoning_levels").and_then(Value::as_array)
        .map(|levels| levels.iter().filter_map(|level| level.get("effort").and_then(Value::as_str)).map(str::to_string).collect())
        .unwrap_or_default()
}

fn set_field(entry: &mut Map<String, Value>, key: &str, domain: &FieldDomain, raw: Option<&String>) -> Result<(), String> {
    let Some(value) = raw else { return Ok(()) };
    let value = value.trim();
    if value.is_empty() {
        // 「清除」= 写 null，而 Codex 只在 `Option` 字段上接受 null：往非可选字段写 null
        // 会让整份目录被拒（实测 `invalid type: null, expected string or map`）。
        if !domain.nullable { return Err(format!("{key} 不支持清除：这一版 Codex 要求它必须有值")); }
        entry.insert(key.to_string(), Value::Null);
        return Ok(());
    }
    if !domain.values.iter().any(|allowed| allowed == value) {
        return Err(format!("{key} 只能是 {}，当前是 {value}", domain.values.join(" / ")));
    }
    entry.insert(key.to_string(), Value::String(value.to_string()));
    Ok(())
}

/// 按目录字段名取覆盖项；`ENUM_FIELDS` 的键必须全部落在这里，否则编译期就该发现。
fn override_of<'a>(key: &str, fields: &'a ModelOverride) -> Option<&'a String> {
    match key {
        "tool_mode" => fields.tool_mode.as_ref(),
        "multi_agent_version" => fields.multi_agent_version.as_ref(),
        "default_reasoning_summary" => fields.default_reasoning_summary.as_ref(),
        "default_verbosity" => fields.default_verbosity.as_ref(),
        "shell_type" => fields.shell_type.as_ref(),
        "apply_patch_tool_type" => fields.apply_patch_tool_type.as_ref(),
        "web_search_tool_type" => fields.web_search_tool_type.as_ref(),
        "visibility" => fields.visibility.as_ref(),
        _ => None,
    }
}

/// 探测没覆盖到的字段沿用兜底表：值域仍然限制得住，只是界面会标成未核实。
fn domain_for(domains: &BTreeMap<String, FieldDomain>, key: &str) -> FieldDomain {
    if let Some(found) = domains.get(key) { return found.clone(); }
    for (name, values, nullable) in ENUM_FIELDS {
        if name == key { return FieldDomain { values: values.iter().map(|value| (*value).to_string()).collect(), nullable, verified: false }; }
    }
    FieldDomain { values: Vec::new(), nullable: true, verified: false }
}

fn apply_override(entry: &mut Map<String, Value>, override_fields: &ModelOverride, template: &Value, domains: &BTreeMap<String, FieldDomain>) -> Result<(), String> {
    for (key, _, _) in ENUM_FIELDS {
        set_field(entry, key, &domain_for(domains, key), override_of(key, override_fields))?;
    }

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
    // 系统提示词清空等于「不覆盖」，而不是「写 null」：生成文件里的条目是官方条目的副本，
    // 键不写就保留 Codex 自带的那段文本，写 null 等于把提示词删了（实测 Codex 接受 null）。
    if let Some(text) = override_fields.base_instructions.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
        if text.chars().count() > MAX_INSTRUCTIONS {
            return Err(format!("系统提示词最长 {MAX_INSTRUCTIONS} 字，当前 {} 字", text.chars().count()));
        }
        entry.insert("base_instructions".to_string(), Value::String(text.to_string()));
    }
    for (key, value) in &override_fields.flags {
        if !MODEL_FLAGS.contains(&key.as_str()) {
            return Err(format!("未知的模型开关：{key}"));
        }
        entry.insert(key.clone(), Value::Bool(*value));
    }
    Ok(())
}

/// 选择器按 priority 升序排，不按文件顺序。缺失时放到最后，避免没写 priority 的条目插到最前。
fn priority_of(model: &Value) -> u64 {
    model.get("priority").and_then(Value::as_u64).unwrap_or(u64::MAX)
}

/// 进菜单的条目：visibility 缺省或正好是 "list"。hide / none 是 Codex 自己的内部模型，排除不能删它们。
fn is_listable_model(model: &Value) -> bool {
    match model.get("visibility").and_then(Value::as_str) {
        None | Some("list") => true,
        _ => false,
    }
}

/// priority 最小（数值最小）的快照条目。模板 slug 对不上时用它，不能自己编一份只有 slug 的空骨架。
fn fallback_template<'a>(models: &'a [Value]) -> Option<&'a Value> {
    models.iter().min_by_key(|model| priority_of(model))
}

/// 手写上下文写进条目，并把 max_context_window 抬到至少这个值，避免 Codex 用更小的上限把窗口裁掉。
fn apply_handwritten_context(entry: &mut Map<String, Value>, window: u64) -> Result<(), String> {
    if window == 0 { return Err("上下文长度必须大于 0".into()); }
    entry.insert("context_window".to_string(), Value::from(window));
    let max = entry.get("max_context_window").and_then(Value::as_u64).unwrap_or(0);
    if max < window {
        entry.insert("max_context_window".to_string(), Value::from(window));
    }
    Ok(())
}

/// 自定义条目必须能在菜单里看见、能调用、并且不是谁的升级版。
/// visibility 一律改成 list：设成 hide 会让刚加的模型在选择器里消失。
fn force_custom_visible(entry: &mut Map<String, Value>) {
    entry.insert("supported_in_api".to_string(), Value::Bool(true));
    entry.insert("upgrade".to_string(), Value::Null);
    entry.insert("visibility".to_string(), Value::String("list".to_string()));
}

/// 有自定义或排除时，选择器按 priority 排序，写出去的 priority 必须重编号。
fn renumber_priority(models: &mut [Value]) {
    for (index, model) in models.iter_mut().enumerate() {
        if let Some(entry) = model.as_object_mut() {
            entry.insert("priority".to_string(), Value::from(index as u64));
        }
    }
}

/// 基础条目 + 意图 = 实际交给 Codex 的目录。
/// 只有官方覆盖时保持文件顺序和原 priority。一旦有自定义或排除：自定义在前，
/// 官方按 priority 排在后，再把 priority 重编号为 0..n。
fn generate(base: &Value, intent: &CatalogIntent, domains: &BTreeMap<String, FieldDomain>) -> Result<Vec<Value>, String> {
    let models = base.get("models").and_then(Value::as_array).ok_or("Codex 模型目录缺少 models 数组")?;
    if models.len() > MAX_ENTRIES {
        return Err(format!("模型条目过多（{}）", models.len()));
    }
    let reshape = !intent.customs.is_empty() || !intent.excluded.is_empty();
    let mut officials: Vec<Value> = Vec::with_capacity(models.len());
    for model in models {
        let Some(slug) = model_slug(model) else { continue };
        // 排除只拿掉进菜单的官方条目。hide / none 留给 Codex 自己用。
        if intent.excluded.iter().any(|item| item == slug) && is_listable_model(model) { continue; }
        let mut entry = model.as_object().cloned().unwrap_or_else(|| {
            let mut map = Map::new();
            map.insert("slug".to_string(), Value::String(slug.to_string()));
            map
        });
        if let Some(override_fields) = intent.overrides.get(slug) {
            apply_override(&mut entry, override_fields, model, domains)?;
        }
        officials.push(Value::Object(entry));
    }
    if reshape {
        officials.sort_by_key(priority_of);
    }

    let mut customs: Vec<Value> = Vec::with_capacity(intent.customs.len());
    for custom in &intent.customs {
        let slug = custom.slug.trim();
        if !valid_slug(slug) {
            return Err(format!("自定义模型 slug 只能包含字母、数字、-、_、.、: 和 /，且不超过 {MAX_SLUG} 个字符：{}", custom.slug));
        }
        if !text_ok(&custom.display_name) || !text_ok(&custom.description) {
            return Err(format!("自定义模型 {slug} 的名称或描述过长"));
        }
        let named = models.iter().find(|model| model_slug(model) == Some(custom.base.trim()));
        let template = named.or_else(|| fallback_template(models))
            .ok_or_else(|| format!("自定义模型 {slug} 没有可用的官方模型可当模板"))?;
        let mut entry = template.as_object().cloned().unwrap_or_default();
        entry.insert("slug".to_string(), Value::String(slug.to_string()));
        entry.insert("display_name".to_string(), Value::String(custom.display_name.clone()));
        entry.insert("description".to_string(), Value::String(custom.description.clone()));
        apply_override(&mut entry, &custom.model_override, template, domains)?;
        // 一等字段压过覆盖项里的同名窗口：表单第一行写的数才是用户要的上下文。
        if let Some(window) = custom.context_window {
            apply_handwritten_context(&mut entry, window)?;
        }
        force_custom_visible(&mut entry);
        if officials.iter().chain(customs.iter()).any(|model| model_slug(model) == Some(slug)) {
            return Err(format!("自定义模型 {slug} 与现有模型重名"));
        }
        customs.push(Value::Object(entry));
    }

    let mut out = if reshape { [customs, officials].concat() } else { officials };
    if reshape { renumber_priority(&mut out); }
    if out.is_empty() {
        return Err("模型清单不能为空：全排除后这份目录里一个模型都没有，Codex 会直接拒绝启动".into());
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

/// 目录路径与状态只取决于 CODEX_HOME 与 config.toml；取值域要读缓存所以带上 AppHandle。
fn view(app: &AppHandle, intent: CatalogIntent, base: Option<Value>, error: Option<String>) -> Result<CatalogView, String> {
    let path = catalog_path()?;
    let (domains, flags, flags_verified, probe_error) = resolve_domains(app, base.as_ref());
    let (models, hidden) = match &base {
        Some(base) => if intent.is_empty() {
            (base.get("models").and_then(Value::as_array).cloned().unwrap_or_default(), Vec::new())
        } else {
            (generate(base, &intent, &domains)?, hidden_models(base, &intent))
        },
        None => (Vec::new(), Vec::new()),
    };
    Ok(CatalogView {
        path: path.display().to_string(),
        active: config_has_key(),
        error: match (error, probe_error) {
            (Some(error), Some(extra)) => Some(format!("{error}；{extra}")),
            (error, extra) => error.or(extra),
        },
        intent,
        models: project(&models),
        hidden: project(&hidden),
        domains,
        flags,
        flags_verified,
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
        view(&app, read_intent(&app), base, error)
    }).await
}

#[tauri::command]
pub async fn ai_cli_codex_catalog_save(app: AppHandle, intent: CatalogIntent) -> Result<CatalogView, String> {
    block(move || save_intent(&app, intent)).await
}

/// 展开某一行的覆盖面板时按需取它的基础系统提示词。整份目录里 `base_instructions` 占两成体积、
/// `model_messages` 占六成，随列表一起塞给界面不值当，所以界面拿的是投影过的条目，文本单独取。
#[tauri::command]
pub async fn ai_cli_codex_catalog_text(app: AppHandle, slug: String) -> Result<Option<String>, String> {
    block(move || {
        let slug = slug.trim().to_string();
        // 只读缓存，不为取一段文本再起一次 CLI：面板里这一步要的是快。
        let base = base_path(&app).ok().and_then(|path| fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());
        Ok(base.as_ref().and_then(|document| document.get("models")).and_then(Value::as_array)
            .into_iter().flatten()
            .find(|model| model_slug(model) == Some(slug.as_str()))
            .and_then(|model| model.get("base_instructions"))
            .and_then(Value::as_str)
            .map(str::to_string))
    }).await
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
        let (domains, _, _, _) = resolve_domains(app, Some(&source));
        let models = generate(&source, &intent, &domains)?;
        let path = catalog_path()?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|error| format!("无法创建 Codex 配置目录：{error}"))?;
        }
        let document = Value::Object(Map::from_iter([("models".to_string(), Value::Array(models))]));
        write_atomic(&path, &serde_json::to_string_pretty(&document).map_err(|error| error.to_string())?)?;
        set_catalog_key(Some(CATALOG_NAME))?;
    }
    view(app, intent, base, error)
}

/// 选择器要的三件事：被排除的官方 slug、清单里新增的自定义模型（带它自己条目的档位）。
/// 没有定制就返回 `None`，让调用方原样使用 Codex 报上来的目录。
pub fn picker_patch(app: &AppHandle) -> Option<Value> {
    let intent = read_intent(app);
    if intent.is_empty() { return None; }
    let base = base_path(app).ok().and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let mut customs = Vec::new();
    for custom in &intent.customs {
        let slug = custom.slug.trim();
        if slug.is_empty() { continue; }
        let display = custom.display_name.trim();
        // 档位只能来自模板条目；猜一份 Codex 没报过的档位列表比不给更糟。
        let efforts = base.as_ref()
            .and_then(|document| document.get("models").and_then(Value::as_array))
            .map(|models| {
                models.iter().find(|model| model_slug(model) == Some(custom.base.trim()))
                    .or_else(|| fallback_template(models))
                    .map(supported_efforts)
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        customs.push(json!({"id": slug, "name": if display.is_empty() { slug } else { display }, "efforts": efforts}));
    }
    Some(json!({"excluded": intent.excluded, "customs": customs}))
}

/// 将存储在 provider.model 里的字符串解析为完整意图。
/// 容错与迁移规则：
/// - 空白 / None -> 默认空意图
/// - 包含 `customs` / `excluded` / `overrides` 的 JSON 对象 -> 反序列化为 CatalogIntent
/// - 包含 `models` 数组的老格式 -> 每条迁移为 CustomModel
/// - 裸 slug（普通字符串或 JSON 字符串） -> 一条 custom（slug、base、default 均为该 slug）
pub fn parse_provider_model(raw: Option<&str>) -> CatalogIntent {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return CatalogIntent::default();
    };

    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        if let Some(obj) = value.as_object() {
            if obj.contains_key("customs") || obj.contains_key("excluded") || obj.contains_key("overrides") {
                return serde_json::from_value(value).unwrap_or_default();
            }
            if let Some(models) = obj.get("models").and_then(Value::as_array) {
                let customs: Vec<CustomModel> = models.iter().filter_map(|m| {
                    let obj = m.as_object()?;
                    let slug = obj.get("slug").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())?;
                    let base = obj.get("base").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(slug);
                    let display_name = obj.get("displayName").or_else(|| obj.get("display_name")).and_then(Value::as_str).unwrap_or("").to_string();
                    let description = obj.get("description").and_then(Value::as_str).unwrap_or("").to_string();
                    let context_window = obj.get("contextWindow").or_else(|| obj.get("context_window")).and_then(Value::as_u64);
                    let model_override = obj.get("overrides").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
                    Some(CustomModel {
                        slug: slug.to_string(),
                        display_name,
                        description,
                        base: base.to_string(),
                        context_window,
                        model_override,
                    })
                }).collect();
                return CatalogIntent {
                    excluded: Vec::new(),
                    overrides: BTreeMap::new(),
                    customs,
                    default_model: obj.get("default").and_then(Value::as_str).map(str::to_string),
                };
            }
            return CatalogIntent::default();
        }
        if let Some(s) = value.as_str() {
            return single_custom_intent(s);
        }
    }
    single_custom_intent(raw)
}

fn single_custom_intent(slug: &str) -> CatalogIntent {
    let slug = slug.trim().to_string();
    if slug.is_empty() {
        return CatalogIntent::default();
    }
    CatalogIntent {
        excluded: Vec::new(),
        overrides: BTreeMap::new(),
        customs: vec![CustomModel {
            slug: slug.clone(),
            display_name: String::new(),
            description: String::new(),
            base: slug.clone(),
            context_window: None,
            model_override: ModelOverride::default(),
        }],
        default_model: Some(slug),
    }
}

/// 意图是否在实际作用上等于“没有偏离官方默认目录”。
/// 如果没有 customs 且没有 overrides：
/// - 若快照能拿到：当所有 excluded 条目都不在当前 listable 的官方模型中时（比如排除了已退役模型），
///   等于没有任何真正排除，算作空；
/// - 若快照拿不到：保守判断，只要 excluded 为空就算空。
pub fn is_effectively_empty(intent: &CatalogIntent, base: Option<&Value>) -> bool {
    if !intent.customs.is_empty() || !intent.overrides.is_empty() {
        return false;
    }
    let Some(models) = base.and_then(|b| b.get("models")).and_then(Value::as_array) else {
        return intent.excluded.is_empty();
    };
    let listable_slugs: std::collections::BTreeSet<&str> = models.iter()
        .filter(|m| is_listable_model(m))
        .filter_map(model_slug)
        .collect();
    if listable_slugs.is_empty() {
        return intent.excluded.is_empty();
    }
    !intent.excluded.iter().any(|slug| listable_slugs.contains(slug.as_str()))
}

/// 计算根 model 的默认 slug：
/// 1. 显式 default_model（若仍被列出：在 customs 中或在未被排除且 listable 的官方模型中）
/// 2. 第一个 custom
/// 3. 未被排除且 listable 的官方模型中 priority 最小（数值最小）的那个
/// 4. None
pub fn default_slug(intent: &CatalogIntent, base: Option<&Value>) -> Option<String> {
    let models = base.and_then(|b| b.get("models")).and_then(Value::as_array);
    let is_listed = |slug: &str| -> bool {
        intent.customs.iter().any(|c| c.slug == slug)
            || models.is_some_and(|list| {
                list.iter().any(|m| {
                    model_slug(m) == Some(slug)
                        && is_listable_model(m)
                        && !intent.excluded.iter().any(|ex| ex == slug)
                })
            })
    };
    if let Some(d) = &intent.default_model {
        if is_listed(d) {
            return Some(d.clone());
        }
    }
    if let Some(first) = intent.customs.first() {
        return Some(first.slug.clone());
    }
    models.and_then(|list| {
        list.iter()
            .filter(|m| is_listable_model(m) && model_slug(m).is_some_and(|s| !intent.excluded.iter().any(|ex| ex == s)))
            .min_by_key(|m| priority_of(m))
            .and_then(model_slug)
            .map(str::to_string)
    })
}

/// 供供应商「应用」调用：
/// - 若 effectively empty：清理 catalog 文件，删除 config.toml 的 model_catalog_json 键，
///   清空意图文件以同步 picker_patch，返回 Ok(None)（告知调用方清掉根 model）。
/// - 若非空：解析或加载 base 快照，生成完整模型列表，写入 forge-model-catalog.json，
///   写 config.toml 的 model_catalog_json 键，保存意图文件到 ai-codex-catalog.json，
///   返回 Ok(Some(default_slug))。
pub fn apply_provider_catalog(app: &AppHandle, intent: &CatalogIntent) -> Result<Option<String>, String> {
    let (base, error) = load_base(app);
    let dir = app_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建配置目录：{e}"))?;

    if is_effectively_empty(intent, base.as_ref()) {
        set_catalog_key(None)?;
        if let Ok(path) = catalog_path() {
            let _ = fs::remove_file(path);
        }
        let _ = write_atomic(&intent_path(app)?, &serde_json::to_string_pretty(&CatalogIntent::default()).map_err(|e| e.to_string())?);
        return Ok(None);
    }

    validate_intent(intent)?;
    let source = base.clone().ok_or_else(|| error.clone().unwrap_or_else(|| "无法读取 Codex 模型目录".to_string()))?;
    let (domains, _, _, _) = resolve_domains(app, Some(&source));
    let models = generate(&source, intent, &domains)?;
    let path = catalog_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建 Codex 配置目录：{e}"))?;
    }
    let document = Value::Object(Map::from_iter([("models".to_string(), Value::Array(models))]));
    write_atomic(&path, &serde_json::to_string_pretty(&document).map_err(|e| e.to_string())?)?;
    set_catalog_key(Some(CATALOG_NAME))?;
    write_atomic(&intent_path(app)?, &serde_json::to_string_pretty(intent).map_err(|e| e.to_string())?)?;
    Ok(default_slug(intent, Some(&source)))
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

    /// 测试用取值域：直接拿兜底表，等价于「探测成功且结果与 0.164 实测一致」。
    fn domains() -> BTreeMap<String, FieldDomain> { fallback_domains().0 }

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
            default_model: None,
        };
        let models = generate(&base(), &intent, &domains()).unwrap();
        let first = models[0].as_object().unwrap();
        assert_eq!(first.get("default_verbosity").unwrap().as_str(), Some("high"));
        assert_eq!(first.get("tool_mode").unwrap(), &Value::Null, "可空的枚举按显式清除写成 null");
        assert_eq!(first.get("use_responses_lite").unwrap().as_bool(), Some(true));
        assert_eq!(first.get("context_window").unwrap().as_u64(), Some(272000), "没改的字段必须原样留着");
        assert!(first.contains_key("comp_hash"), "未知但存在的键不能被丢掉");
        assert_eq!(models[1].as_object().unwrap().get("priority").unwrap().as_u64(), Some(2));
    }

    #[test]
    fn clearing_a_required_enum_would_poison_the_catalog_so_it_is_refused() {
        // 实测 0.164：往 shell_type / visibility / web_search_tool_type / default_reasoning_summary
        // 写 null 换来 `invalid type: null, expected string or map`，整份目录一起倒。
        for key in ["shell_type", "visibility", "web_search_tool_type", "default_reasoning_summary"] {
            let mut fields = ModelOverride::default();
            set_override(&mut fields, key, Some(String::new()));
            let intent = CatalogIntent {
                overrides: BTreeMap::from([("gpt-5.5".to_string(), fields)]),
                ..CatalogIntent::default()
            };
            let error = generate(&base(), &intent, &domains()).unwrap_err();
            assert!(error.contains(key) && error.contains("清除"), "{key} 应拒绝清除，实际：{error}");
        }
        // 反过来：可空字段清了就是写 null，Codex 接受。
        let intent = CatalogIntent {
            overrides: BTreeMap::from([("gpt-5.5".to_string(), ModelOverride { default_verbosity: Some(String::new()), ..ModelOverride::default() })]),
            ..CatalogIntent::default()
        };
        let models = generate(&base(), &intent, &domains()).unwrap();
        assert_eq!(models[0].as_object().unwrap().get("default_verbosity"), Some(&Value::Null));
    }

    /// 按字段名写覆盖项，好让上面那条测试覆盖到全部四个必填枚举。
    fn set_override(fields: &mut ModelOverride, key: &str, value: Option<String>) {
        match key {
            "shell_type" => fields.shell_type = value,
            "visibility" => fields.visibility = value,
            "web_search_tool_type" => fields.web_search_tool_type = value,
            "default_reasoning_summary" => fields.default_reasoning_summary = value,
            _ => unreachable!(),
        }
    }

    #[test]
    fn unknown_enum_values_are_rejected_before_they_can_poison_the_catalog() {
        // 实测：Codex 遇到未知枚举会拒掉整份目录，所以这一层必须自己挡。
        let intent = CatalogIntent {
            overrides: BTreeMap::from([("gpt-5.5".to_string(), ModelOverride { shell_type: Some("unified-exec".into()), ..ModelOverride::default() })]),
            ..CatalogIntent::default()
        };
        assert!(generate(&base(), &intent, &domains()).is_err(), "连字符写法不是 Codex 接受的拼写");
        let intent = CatalogIntent {
            overrides: BTreeMap::from([("gpt-5.5".to_string(), ModelOverride { default_reasoning_level: Some("ultra".into()), ..ModelOverride::default() })]),
            ..CatalogIntent::default()
        };
        assert!(generate(&base(), &intent, &domains()).is_err(), "推理档位必须落在该模型支持的档位里");
        let intent = CatalogIntent {
            overrides: BTreeMap::from([("gpt-5.5".to_string(), ModelOverride {
                default_reasoning_level: Some("high".into()),
                flags: BTreeMap::from([("supports_parallel_tool_calls".to_string(), true)]),
                ..ModelOverride::default()
            })]),
            ..CatalogIntent::default()
        };
        assert!(generate(&base(), &intent, &domains()).is_err(), "0.164 已忽略的死键不再提供");
    }

    #[test]
    fn excluding_puts_customs_first_and_they_copy_their_template() {
        let intent = CatalogIntent {
            excluded: vec!["gpt-6-astra".into()],
            overrides: BTreeMap::new(),
            customs: vec![CustomModel {
                slug: "gw/claude-opus".into(),
                display_name: "Gateway Opus".into(),
                description: "routed".into(),
                base: "gpt-5.5".into(),
                context_window: None,
                model_override: ModelOverride { visibility: Some("list".into()), ..ModelOverride::default() },
            }],
            default_model: None,
        };
        let models = generate(&base(), &intent, &domains()).unwrap();
        assert_eq!(models.len(), 2);
        // 有自定义或排除时自定义在前，官方按 priority 排在后，priority 重编号。
        let custom = models[0].as_object().unwrap();
        assert_eq!(custom.get("slug").unwrap().as_str(), Some("gw/claude-opus"));
        assert_eq!(custom.get("display_name").unwrap().as_str(), Some("Gateway Opus"));
        assert_eq!(custom.get("context_window").unwrap().as_u64(), Some(272000), "自定义模型继承模板参数");
        assert!(custom.contains_key("supported_reasoning_levels"));
        assert_eq!(custom.get("upgrade"), Some(&Value::Null));
        assert_eq!(custom.get("priority").unwrap().as_u64(), Some(0));
        assert_eq!(model_slug(&models[1]), Some("gpt-5.5"));
        assert_eq!(models[1].as_object().unwrap().get("priority").unwrap().as_u64(), Some(1));
    }

    #[test]
    fn handwritten_context_window_raises_the_max_so_codex_cannot_clip_it() {
        let intent = CatalogIntent {
            customs: vec![CustomModel {
                slug: "gw/claude-opus".into(),
                base: "gpt-5.5".into(),
                context_window: Some(400_000),
                ..CustomModel::default()
            }],
            ..CatalogIntent::default()
        };
        let models = generate(&base(), &intent, &domains()).unwrap();
        let custom = models[0].as_object().unwrap();
        assert_eq!(custom.get("context_window").unwrap().as_u64(), Some(400_000));
        assert_eq!(custom.get("max_context_window").unwrap().as_u64(), Some(400_000), "上限必须至少等于手写窗口");
        let zero = CatalogIntent {
            customs: vec![CustomModel {
                slug: "gw/zero".into(),
                base: "gpt-5.5".into(),
                context_window: Some(0),
                ..CustomModel::default()
            }],
            ..CatalogIntent::default()
        };
        assert!(generate(&base(), &zero, &domains()).is_err(), "0 窗口会被 Codex 当成无效值");
    }

    #[test]
    fn bad_customs_are_blocked() {
        let mut intent = CatalogIntent {
            customs: vec![CustomModel { slug: "bad slug".into(), base: "gpt-5.5".into(), ..CustomModel::default() }],
            ..CatalogIntent::default()
        };
        assert!(generate(&base(), &intent, &domains()).is_err());
        intent = CatalogIntent {
            customs: vec![CustomModel { slug: "mine".into(), base: "ghost".into(), ..CustomModel::default() }],
            ..CatalogIntent::default()
        };
        // base 对不上时回退到 priority 最小的官方条目，而不是整份拒绝。
        let models = generate(&base(), &intent, &domains()).unwrap();
        let custom = models.iter().find(|model| model_slug(model) == Some("mine")).unwrap();
        assert_eq!(custom.as_object().unwrap().get("context_window").unwrap().as_u64(), Some(272000), "ghost 回退到 gpt-5.5");
        intent = CatalogIntent {
            customs: vec![CustomModel { slug: "gpt-5.5".into(), base: "gpt-5.5".into(), ..CustomModel::default() }],
            ..CatalogIntent::default()
        };
        assert!(generate(&base(), &intent, &domains()).is_err(), "不能和现有模型重名");
        intent = CatalogIntent { excluded: vec!["gpt-5.5".into(), "gpt-6-astra".into()], ..CatalogIntent::default() };
        assert!(generate(&base(), &intent, &domains()).is_err(), "全排除会让 Codex 没有可用模型");
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
    fn domains_are_read_out_of_codex_s_own_error_text() {
        // 这两种句式都是 0.164 实测回来的原文，第二种（`expected \`a\` or \`b\``）只有一个值时也常见。
        let one = "failed to load configuration: failed to parse model_catalog_json path `C:\\tmp\\probe.json` as JSON: unknown variant `forge probe invalid value`, expected one of `default`, `local`, `shell_command`, `unified_exec`, `disabled` at line 1 column 85459";
        assert_eq!(values_from_error(one), vec!["default", "local", "shell_command", "unified_exec", "disabled"]);
        let two = "... unknown variant `forge probe invalid value`, expected `freeform` at line 1 column 85463";
        assert_eq!(values_from_error(two), vec!["freeform"]);
        // 反引号里的路径不能被当成取值。
        let none = "failed to parse model_catalog_json path `C:\\tmp\\probe.json` as JSON: invalid type: null, expected string or map at line 1 column 8";
        assert_eq!(values_from_error(none), Vec::<String>::new());
        assert_eq!(values_from_error("no keyword here"), Vec::<String>::new());
    }

    #[test]
    fn base_instructions_override_replaces_the_copied_text_and_empty_means_inherit() {
        let with_text = CatalogIntent {
            overrides: BTreeMap::from([("gpt-5.5".to_string(), ModelOverride {
                base_instructions: Some("只允许只读操作".into()),
                ..ModelOverride::default()
            })]),
            ..CatalogIntent::default()
        };
        let models = generate(&base(), &with_text, &domains()).unwrap();
        assert_eq!(models[0].as_object().unwrap().get("base_instructions").unwrap().as_str(), Some("只允许只读操作"));
        // 清空文本框 = 不写这个键，条目仍是官方条目自带的那段；写 null 会把提示词直接删掉。
        let cleared = CatalogIntent {
            overrides: BTreeMap::from([("gpt-5.5".to_string(), ModelOverride {
                base_instructions: Some("   ".into()),
                ..ModelOverride::default()
            })]),
            ..CatalogIntent::default()
        };
        let models = generate(&base(), &cleared, &domains()).unwrap();
        assert_eq!(models[0].as_object().unwrap().get("base_instructions").unwrap().as_str(), Some("instructions"));
        let too_long = CatalogIntent {
            overrides: BTreeMap::from([("gpt-5.5".to_string(), ModelOverride {
                base_instructions: Some("字".repeat(MAX_INSTRUCTIONS + 1)),
                ..ModelOverride::default()
            })]),
            ..CatalogIntent::default()
        };
        assert!(generate(&base(), &too_long, &domains()).is_err(), "系统提示词也要有上限，不能整份日志塞进去");
    }

    #[test]
    fn a_custom_is_always_listed_even_when_the_override_says_hide() {
        let hidden = CatalogIntent {
            customs: vec![CustomModel {
                slug: "gw/claude-opus".into(),
                base: "gpt-5.5".into(),
                model_override: ModelOverride { visibility: Some("hide".into()), ..ModelOverride::default() },
                ..CustomModel::default()
            }],
            ..CatalogIntent::default()
        };
        let models = generate(&base(), &hidden, &domains()).unwrap();
        let custom = models.iter().find(|model| model_slug(model) == Some("gw/claude-opus")).unwrap();
        assert_eq!(custom.as_object().unwrap().get("visibility").unwrap().as_str(), Some("list"), "自定义模型必须进选择器，hide 会被顶掉");
        let plain = CatalogIntent {
            customs: vec![CustomModel { slug: "gw/claude-opus".into(), base: "gpt-5.5".into(), ..CustomModel::default() }],
            ..CatalogIntent::default()
        };
        let models = generate(&base(), &plain, &domains()).unwrap();
        let custom = models.iter().find(|model| model_slug(model) == Some("gw/claude-opus")).unwrap();
        assert_eq!(custom.as_object().unwrap().get("visibility").unwrap().as_str(), Some("list"), "自定义模型默认要在菜单里看得见");
    }

    #[test]
    fn excluded_entries_stay_visible_to_the_ui_so_it_can_offer_restore() {
        let intent = CatalogIntent { excluded: vec!["gpt-6-astra".into()], ..CatalogIntent::default() };
        let hidden = hidden_models(&base(), &intent);
        assert_eq!(hidden.len(), 1);
        assert_eq!(model_slug(&hidden[0]), Some("gpt-6-astra"));
        let kept = generate(&base(), &intent, &domains()).unwrap();
        assert_eq!(kept.len(), 1, "排除的条目不能出现在实际目录里");
    }

    #[test]
    fn projection_strips_the_payload_but_generation_keeps_it() {
        let models = generate(&base(), &CatalogIntent::default(), &domains()).unwrap();
        assert_eq!(models[0].as_object().unwrap().get("base_instructions").unwrap().as_str(), Some("instructions"));
        let shown = project(&models);
        assert!(!shown[0].as_object().unwrap().contains_key("model_messages"));
        assert!(!shown[0].as_object().unwrap().contains_key("base_instructions"));
        assert!(shown[0].as_object().unwrap().contains_key("context_window"));
    }

    /// 真机冒烟：`cargo test -- --ignored`。这条会起 Codex 问字段规则，用来验证探测本身，
    /// 不进常规测试（CI 上没有 CLI，而且一次约 1 秒）。
    #[test]
    #[ignore]
    fn domains_probe_reads_the_installed_codex() {
        let base = run_codex_models().expect("需要本机装好 Codex 才能跑这条");
        let (fields, live) = probe_domains(&base).expect("探测失败");
        let shell = &fields["shell_type"];
        assert!(shell.verified, "取值域必须标成 CLI 亲口报的");
        assert!(shell.values.iter().any(|value| value == "unified_exec"), "{:?}", shell.values);
        assert!(!shell.nullable, "shell_type 写 null 会被整份拒掉");
        assert!(fields["default_verbosity"].nullable, "default_verbosity 是可空枚举");
        assert!(live.contains(&"use_responses_lite".to_string()), "{live:?}");
        assert!(live.iter().all(|key| MODEL_FLAGS.contains(&key.as_str())), "探测不能凭空造出候选外的键：{live:?}");
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

    #[test]
    fn parse_provider_model_supports_legacy_and_bare_slugs() {
        assert_eq!(parse_provider_model(None), CatalogIntent::default());
        assert_eq!(parse_provider_model(Some("")), CatalogIntent::default());
        // 裸 slug 转换为 custom
        let bare = parse_provider_model(Some("gpt-5.5"));
        assert_eq!(bare.customs.len(), 1);
        assert_eq!(bare.customs[0].slug, "gpt-5.5");
        assert_eq!(bare.default_model, Some("gpt-5.5".to_string()));

        // 老格式 {"models":[{"slug":"m1","base":"gpt-5.5"}]}
        let legacy = parse_provider_model(Some(r#"{"models":[{"slug":"m1","base":"gpt-5.5","displayName":"M1"}],"default":"m1"}"#));
        assert_eq!(legacy.customs.len(), 1);
        assert_eq!(legacy.customs[0].slug, "m1");
        assert_eq!(legacy.customs[0].display_name, "M1");
        assert_eq!(legacy.default_model, Some("m1".to_string()));

        // 新意图 JSON 完整解析
        let json_intent = parse_provider_model(Some(r#"{"customs":[{"slug":"c1","base":"gpt-5.5","contextWindow":128000}],"excluded":["gpt-6-astra"],"default":"c1"}"#));
        assert_eq!(json_intent.customs.len(), 1);
        assert_eq!(json_intent.customs[0].context_window, Some(128000));
        assert_eq!(json_intent.excluded, vec!["gpt-6-astra".to_string()]);
        assert_eq!(json_intent.default_model, Some("c1".to_string()));
    }

    #[test]
    fn default_slug_and_effectively_empty_rules() {
        let snapshot = base();
        // 有 custom 时不是 empty，default 首选显式 default 或首个 custom
        let custom_intent = CatalogIntent {
            customs: vec![CustomModel { slug: "c1".into(), base: "gpt-5.5".into(), ..CustomModel::default() }],
            default_model: Some("c1".into()),
            ..CatalogIntent::default()
        };
        assert!(!is_effectively_empty(&custom_intent, Some(&snapshot)));
        assert_eq!(default_slug(&custom_intent, Some(&snapshot)), Some("c1".to_string()));

        // 无 custom、只排除了幽灵模型（不在 listable 里）时算 effectively empty
        let ghost_intent = CatalogIntent {
            excluded: vec!["retired-model-stub".into()],
            ..CatalogIntent::default()
        };
        assert!(is_effectively_empty(&ghost_intent, Some(&snapshot)));

        // 排除掉 listable 官方模型时不是 effectively empty，且 default 选择未被排除的最高 priority 官方
        let exclude_top = CatalogIntent {
            excluded: vec!["gpt-5.5".into()],
            ..CatalogIntent::default()
        };
        assert!(!is_effectively_empty(&exclude_top, Some(&snapshot)));
        assert_eq!(default_slug(&exclude_top, Some(&snapshot)), Some("gpt-6-astra".to_string()));
    }
}
