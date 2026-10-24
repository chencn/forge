//! MCP 市场：官方 MCP registry 与 Smithery。
//!
//! 列表只负责展示与选择；落盘的 spec 由安装选项按目标 CLI 生成，
//! 必填参数在解析阶段强制校验，缺值不会写进配置。

use crate::ai_cli::{fetch_text_with, Provider};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::time::Duration;

const OFFICIAL: &str = "official_registry";
const SMITHERY: &str = "smithery";
const OFFICIAL_SERVERS: &str = "https://registry.modelcontextprotocol.io/v0.1/servers";
const SMITHERY_SERVERS: &str = "https://api.smithery.ai/servers";
const LIMIT: u32 = 30;
const MAX_QUERY: usize = 120;
const MAX_SERVER_ID: usize = 512;
// 官方 registry 首包实测要 40 秒以上，慢的时候更久。
const OFFICIAL_TIMEOUT: Duration = Duration::from_secs(120);
const SMITHERY_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketProvider {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketServer {
    pub provider_id: String,
    /// registry / Smithery 的完整服务器名，安装后就是本地配置的键。
    pub server_id: String,
    pub name: String,
    pub description: String,
    pub homepage: Option<String>,
    pub remote: bool,
    pub verified: bool,
    pub icon_url: Option<String>,
    pub latest_version: Option<String>,
    pub protocols: Vec<String>,
    pub owner: Option<String>,
    pub namespace: Option<String>,
    pub downloads: Option<u64>,
    pub score: Option<f64>,
    pub is_deployed: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketParameter {
    pub key: String,
    pub label: String,
    pub description: Option<String>,
    pub required: bool,
    pub secret: bool,
    pub kind: String,
    pub default_value: Option<Value>,
    pub placeholder: Option<String>,
    pub enum_values: Vec<String>,
    pub location: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketOption {
    pub id: String,
    pub protocol: String,
    pub label: String,
    pub description: Option<String>,
    pub spec: Value,
    pub parameters: Vec<MarketParameter>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDetail {
    pub provider_id: String,
    pub server_id: String,
    pub name: String,
    pub description: String,
    pub homepage: Option<String>,
    pub remote: bool,
    pub verified: bool,
    pub icon_url: Option<String>,
    pub latest_version: Option<String>,
    pub protocols: Vec<String>,
    pub owner: Option<String>,
    pub namespace: Option<String>,
    pub downloads: Option<u64>,
    pub score: Option<f64>,
    pub is_deployed: Option<bool>,
    pub default_option_id: Option<String>,
    pub install_options: Vec<MarketOption>,
    /// 默认安装方式的配置；没有任何可安装方式时为空。
    pub spec: Option<Value>,
}

#[tauri::command]
pub fn ai_mcp_market_providers() -> Vec<MarketProvider> {
    vec![
        MarketProvider {
            id: OFFICIAL.into(),
            name: "Official MCP Registry".into(),
            description: "registry.modelcontextprotocol.io 官方 MCP 服务器目录".into(),
        },
        MarketProvider {
            id: SMITHERY.into(),
            name: "Smithery".into(),
            description: "smithery.ai MCP 服务器市场".into(),
        },
    ]
}

/// 只保留 RFC 3986 未保留字符，其余按 UTF-8 百分号编码。
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*byte as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn official_url(query: &str) -> String {
    let mut url = format!("{OFFICIAL_SERVERS}?version=latest&limit={LIMIT}");
    let query = query.trim();
    if !query.is_empty() {
        url.push_str("&search=");
        url.push_str(&encode(query));
    }
    url
}

fn smithery_url(query: &str) -> String {
    format!("{SMITHERY_SERVERS}?limit={LIMIT}&q={}", encode(query.trim()))
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::trim).filter(|item| !item.is_empty()).map(str::to_string)
}

fn field(object: &Map<String, Value>, key: &str) -> Option<String> {
    text(object.get(key))
}

fn string_field(object: &Map<String, Value>, key: &str) -> String {
    field(object, key).unwrap_or_default()
}

fn bool_field(object: &Map<String, Value>, key: &str) -> Option<bool> {
    object.get(key).and_then(Value::as_bool)
}

fn number_field(object: &Map<String, Value>, key: &str) -> Option<u64> {
    object.get(key).and_then(Value::as_u64)
}

fn score_field(object: &Map<String, Value>, key: &str) -> Option<f64> {
    object.get(key).and_then(Value::as_f64)
}

/// `streamable-http` 及各种拼写在两个 CLI 里都归为 http。
fn protocol(raw: &str) -> Option<&'static str> {
    let collapsed: String = raw.trim().to_ascii_lowercase().chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect();
    match collapsed.as_str() {
        "stdio" => Some("stdio"),
        "http" | "streamablehttp" => Some("http"),
        "sse" => Some("sse"),
        _ => None,
    }
}

fn protocol_or_http(raw: &str) -> String {
    protocol(raw).unwrap_or("http").to_string()
}

fn protocol_priority(protocol: &str) -> u8 {
    match protocol {
        "stdio" => 0,
        "http" => 1,
        "sse" => 2,
        _ => 10,
    }
}

fn official_protocols(server: &Map<String, Value>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    for remote in server.get("remotes").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
        if let Some(item) = remote.get("type").and_then(Value::as_str).and_then(protocol) {
            seen.insert(item.to_string());
        }
    }
    for package in server.get("packages").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object) {
        if let Some(item) = package.get("transport").and_then(Value::as_object)
            .and_then(|transport| transport.get("type")).and_then(Value::as_str).and_then(protocol) {
            seen.insert(item.to_string());
        }
    }
    seen.into_iter().collect()
}

fn official_item(server: &Map<String, Value>, meta: Option<&Value>) -> Option<MarketServer> {
    let server_id = field(server, "name")?;
    let verified = meta
        .and_then(|value| value.get("io.modelcontextprotocol.registry/official"))
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str) == Some("active");
    Some(MarketServer {
        provider_id: OFFICIAL.into(),
        server_id: server_id.clone(),
        name: field(server, "title").unwrap_or_else(|| server_id.clone()),
        description: string_field(server, "description"),
        homepage: field(server, "websiteUrl").or_else(|| {
            server.get("repository").and_then(Value::as_object).and_then(|repo| field(repo, "url"))
        }),
        remote: server.get("remotes").and_then(Value::as_array).is_some_and(|items| !items.is_empty()),
        verified,
        icon_url: server.get("icons").and_then(Value::as_array)
            .and_then(|items| items.iter().filter_map(Value::as_object).find_map(|icon| field(icon, "src"))),
        latest_version: field(server, "version"),
        protocols: official_protocols(server),
        owner: None,
        namespace: None,
        downloads: None,
        score: None,
        is_deployed: None,
    })
}

fn smithery_item(server: &Map<String, Value>) -> Option<MarketServer> {
    let server_id = field(server, "qualifiedName")?;
    let remote = bool_field(server, "remote").unwrap_or(false);
    Some(MarketServer {
        provider_id: SMITHERY.into(),
        server_id: server_id.clone(),
        name: field(server, "displayName").unwrap_or_else(|| server_id.clone()),
        description: string_field(server, "description"),
        homepage: field(server, "homepage"),
        remote,
        verified: bool_field(server, "verified").unwrap_or(false),
        icon_url: field(server, "iconUrl"),
        latest_version: None,
        protocols: if remote { vec!["http".into()] } else { Vec::new() },
        owner: field(server, "owner"),
        namespace: field(server, "namespace"),
        downloads: number_field(server, "useCount"),
        score: score_field(server, "score"),
        is_deployed: bool_field(server, "isDeployed"),
    })
}

fn parse_official_list(body: &Value) -> Result<Vec<MarketServer>, String> {
    let items = body.get("servers").and_then(Value::as_array)
        .ok_or("市场返回内容格式错误：缺少 servers 数组")?;
    if items.len() > 200 { return Err("市场返回条目过多".into()); }
    Ok(items.iter().filter_map(Value::as_object)
        .filter_map(|raw| raw.get("server").and_then(Value::as_object)
            .and_then(|server| official_item(server, raw.get("_meta"))))
        .collect())
}

fn parse_smithery_list(body: &Value) -> Result<Vec<MarketServer>, String> {
    let items = body.get("servers").and_then(Value::as_array)
        .ok_or("市场返回内容格式错误：缺少 servers 数组")?;
    if items.len() > 200 { return Err("市场返回条目过多".into()); }
    Ok(items.iter().filter_map(Value::as_object).filter_map(smithery_item).collect())
}

async fn fetch_json(url: &str, timeout: Duration, label: &str) -> Result<Value, String> {
    let body = fetch_text_with(url, timeout).await.map_err(|error| format!("{label}：{error}"))?;
    serde_json::from_str(&body).map_err(|error| format!("{label}返回格式错误：{error}"))
}

fn valid_market(market: &str) -> Result<(), String> {
    if market == OFFICIAL || market == SMITHERY { Ok(()) } else { Err("未知的 MCP 市场来源".into()) }
}

fn valid_server_id(server_id: &str) -> Result<(), String> {
    if server_id.trim().is_empty() || server_id.chars().count() > MAX_SERVER_ID || server_id.chars().any(char::is_control) {
        Err("服务器标识无效".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn ai_mcp_market_search(market: String, query: String) -> Result<Vec<MarketServer>, String> {
    valid_market(&market)?;
    if query.chars().count() > MAX_QUERY {
        return Err(format!("搜索关键词不能超过 {MAX_QUERY} 个字符"));
    }
    match market.as_str() {
        OFFICIAL => {
            let body = fetch_json(&official_url(&query), OFFICIAL_TIMEOUT, "市场搜索失败").await?;
            parse_official_list(&body)
        }
        _ => {
            let body = fetch_json(&smithery_url(&query), SMITHERY_TIMEOUT, "市场搜索失败").await?;
            parse_smithery_list(&body)
        }
    }
}

#[tauri::command]
pub async fn ai_mcp_market_detail(provider: Provider, market: String, server_id: String) -> Result<MarketDetail, String> {
    valid_market(&market)?;
    valid_server_id(&server_id)?;
    match market.as_str() {
        OFFICIAL => {
            let url = format!("{OFFICIAL_SERVERS}/{}/versions/latest", encode(&server_id));
            let body = fetch_json(&url, OFFICIAL_TIMEOUT, "读取服务器详情失败").await?;
            let server = body.get("server").and_then(Value::as_object).ok_or("服务器详情格式错误：缺少 server")?;
            official_detail(provider, server, body.get("_meta"))
        }
        _ => {
            let url = format!("{SMITHERY_SERVERS}/{}", encode(&server_id));
            let body = fetch_json(&url, SMITHERY_TIMEOUT, "读取服务器详情失败").await?;
            let server = body.as_object().ok_or("服务器详情格式错误")?;
            Ok(smithery_detail(provider, server))
        }
    }
}

#[tauri::command]
pub async fn ai_mcp_market_resolve(
    provider: Provider,
    market: String,
    server_id: String,
    option_id: String,
    values: Option<Value>,
) -> Result<Value, String> {
    valid_market(&market)?;
    valid_server_id(&server_id)?;
    let values = values.and_then(|value| value.as_object().cloned()).unwrap_or_default();
    match market.as_str() {
        OFFICIAL => {
            let url = format!("{OFFICIAL_SERVERS}/{}/versions/latest", encode(&server_id));
            let body = fetch_json(&url, OFFICIAL_TIMEOUT, "读取服务器详情失败").await?;
            let server = body.get("server").and_then(Value::as_object).ok_or("服务器详情格式错误：缺少 server")?;
            resolve_official(provider, server, &option_id, &values)
        }
        _ => {
            let url = format!("{SMITHERY_SERVERS}/{}", encode(&server_id));
            let body = fetch_json(&url, SMITHERY_TIMEOUT, "读取服务器详情失败").await?;
            let server = body.as_object().ok_or("服务器详情格式错误")?;
            resolve_smithery(provider, server, &option_id, &values)
        }
    }
}

// ---------- 官方 registry：包 / 远程 ----------

#[derive(Clone, Default)]
struct KeyValue {
    name: String,
    value: Option<String>,
    default: Option<String>,
    description: Option<String>,
    format: Option<String>,
    required: bool,
    secret: bool,
    hint: Option<String>,
}

fn key_value_from_object(name: &str, object: &Map<String, Value>) -> KeyValue {
    KeyValue {
        name: name.to_string(),
        value: field(object, "value"),
        default: field(object, "default"),
        description: field(object, "description"),
        format: field(object, "format"),
        required: bool_field(object, "isRequired").unwrap_or(false),
        secret: bool_field(object, "isSecret").unwrap_or(false),
        hint: field(object, "valueHint"),
    }
}

/// registry 里同一字段可能是数组，也可能是 `{NAME: "value" | {...}}` 对象。
fn key_values(value: Option<&Value>) -> Vec<KeyValue> {
    let Some(value) = value else { return Vec::new() };
    if let Some(items) = value.as_array() {
        return items.iter().filter_map(Value::as_object).filter_map(|item| {
            let name = field(item, "name")?;
            Some(key_value_from_object(&name, item))
        }).collect();
    }
    let Some(map) = value.as_object() else { return Vec::new() };
    map.iter().filter_map(|(name, item)| {
        let name = name.trim();
        if name.is_empty() { return None; }
        if let Some(text) = item.as_str() {
            let text = text.trim();
            return Some(KeyValue { name: name.into(), value: (!text.is_empty()).then(|| text.to_string()), ..Default::default() });
        }
        let object = item.as_object()?;
        Some(key_value_from_object(name, object))
    }).collect()
}

#[derive(Clone, Default)]
struct Argument {
    name: Option<String>,
    named: bool,
    value: Option<String>,
    default: Option<String>,
    description: Option<String>,
    format: Option<String>,
    required: bool,
    hint: Option<String>,
}

fn arguments(value: Option<&Value>) -> Vec<Argument> {
    value.and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_object).map(|object| Argument {
        name: field(object, "name"),
        named: object.get("type").and_then(Value::as_str) == Some("named"),
        value: field(object, "value"),
        default: field(object, "default"),
        description: field(object, "description"),
        format: field(object, "format"),
        required: bool_field(object, "isRequired").unwrap_or(false),
        hint: field(object, "valueHint"),
    }).collect()).unwrap_or_default()
}

#[derive(Clone)]
struct Transport {
    protocol: String,
    url: Option<String>,
    headers: Vec<KeyValue>,
    variables: Vec<KeyValue>,
}

fn transport(value: Option<&Value>) -> Option<Transport> {
    let object = value?.as_object()?;
    let protocol = protocol(object.get("type").and_then(Value::as_str)?)?;
    Some(Transport {
        protocol: protocol.into(),
        url: field(object, "url"),
        headers: key_values(object.get("headers")),
        variables: key_values(object.get("variables")),
    })
}

#[derive(Clone)]
struct Package {
    registry_type: String,
    identifier: String,
    version: Option<String>,
    runtime_hint: Option<String>,
    runtime_arguments: Vec<Argument>,
    package_arguments: Vec<Argument>,
    environment_variables: Vec<KeyValue>,
    transport: Option<Transport>,
}

fn package(value: &Value) -> Option<Package> {
    let object = value.as_object()?;
    Some(Package {
        registry_type: string_field(object, "registryType"),
        identifier: field(object, "identifier")?,
        version: field(object, "version"),
        runtime_hint: field(object, "runtimeHint"),
        runtime_arguments: arguments(object.get("runtimeArguments")),
        package_arguments: arguments(object.get("packageArguments")),
        environment_variables: key_values(object.get("environmentVariables")),
        transport: transport(object.get("transport")),
    })
}

fn unresolved(value: &str) -> bool {
    // registry 用 `Bearer {smithery_api_key}` 这种占位符表示「必须自己填」；
    // 任何同时含花括号的默认值都不能原样写进配置。
    value.contains('{') && value.contains('}')
}

fn key_value_default(item: &KeyValue) -> Option<String> {
    let value = item.value.as_deref().or(item.default.as_deref())?.trim();
    (!value.is_empty() && !unresolved(value)).then(|| value.to_string())
}

fn key_value_required(item: &KeyValue) -> bool {
    item.required
        || item.value.as_deref().is_some_and(unresolved)
        || item.default.as_deref().is_some_and(unresolved)
        || key_value_default(item).is_none()
}

fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let text = text.trim();
            (!text.is_empty()).then(|| text.to_string())
        }
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(value).ok(),
        Value::Null => None,
    }
}

fn read_value(values: &Map<String, Value>, key: &str) -> Option<String> {
    values.get(key).and_then(value_text)
}

fn argument_default(argument: &Argument) -> Option<String> {
    let value = argument.value.as_deref().or(argument.default.as_deref())?.trim();
    (!value.is_empty() && !unresolved(value)).then(|| value.to_string())
}

fn argument_kind(argument: &Argument) -> String {
    match argument.format.as_deref().unwrap_or("string") {
        "boolean" => "boolean",
        "number" => "number",
        "integer" => "integer",
        "object" | "array" => "json",
        _ => "string",
    }.into()
}

fn append_argument(
    target: &mut Vec<String>,
    argument: &Argument,
    scope: &str,
    index: usize,
    values: &Map<String, Value>,
    enforce: bool,
) -> Result<(), String> {
    let key = format!("{scope}.{index}");
    let value = read_value(values, &key).or_else(|| argument_default(argument));
    if argument.named {
        let Some(name) = argument.name.as_deref().map(str::trim).filter(|name| !name.is_empty()) else { return Ok(()) };
        if let Some(value) = value {
            target.push(name.to_string());
            target.push(value);
            return Ok(());
        }
        if enforce && argument.required {
            return Err(format!("缺少必填参数「{name}」"));
        }
        return Ok(());
    }
    if let Some(value) = value {
        target.push(value);
        return Ok(());
    }
    if enforce && argument.required {
        return Err(format!("缺少必填参数「{}」", argument.name.as_deref().unwrap_or("positional")));
    }
    Ok(())
}

fn runtime_of(item: &Package) -> Option<String> {
    item.runtime_hint.clone().or_else(|| match item.registry_type.trim() {
        "npm" => Some("npx".into()),
        "pypi" => Some("uvx".into()),
        _ => None,
    })
}

fn package_target(item: &Package, runtime: &str) -> String {
    let identifier = item.identifier.trim();
    let Some(version) = item.version.as_deref().map(str::trim).filter(|version| !version.is_empty() && *version != "latest") else {
        return identifier.to_string();
    };
    if runtime == "uvx" {
        if item.registry_type.trim() == "pypi" {
            return format!("{identifier}=={version}");
        }
        return identifier.to_string();
    }
    if runtime == "npx" {
        if identifier.contains('@') || identifier.starts_with("http") {
            return identifier.to_string();
        }
        return format!("{identifier}@{version}");
    }
    identifier.to_string()
}

fn stdio_spec(item: &Package, values: &Map<String, Value>, enforce: bool) -> Result<Value, String> {
    let runtime = runtime_of(item).ok_or_else(|| format!("包「{}」没有可用的运行方式", item.identifier))?;
    let mut args = Vec::new();
    if runtime == "npx" { args.push("-y".into()); }
    for (index, argument) in item.runtime_arguments.iter().enumerate() {
        append_argument(&mut args, argument, "runtime_arguments", index, values, enforce)?;
    }
    args.push(package_target(item, &runtime));
    for (index, argument) in item.package_arguments.iter().enumerate() {
        append_argument(&mut args, argument, "package_arguments", index, values, enforce)?;
    }
    let mut env = Map::new();
    for item in &item.environment_variables {
        let name = item.name.trim();
        if name.is_empty() { continue; }
        let key = format!("env.{name}");
        if let Some(value) = read_value(values, &key).or_else(|| key_value_default(item)) {
            env.insert(name.to_string(), Value::String(value));
            continue;
        }
        if enforce && key_value_required(item) {
            return Err(format!("缺少必填环境变量「{name}」"));
        }
    }
    let mut spec = Map::new();
    spec.insert("type".into(), json!("stdio"));
    spec.insert("command".into(), json!(runtime));
    spec.insert("args".into(), Value::Array(args.into_iter().map(Value::String).collect()));
    if !env.is_empty() { spec.insert("env".into(), Value::Object(env)); }
    Ok(Value::Object(spec))
}

fn append_query(url: &mut String, key: &str, value: &str) {
    url.push(if url.contains('?') { '&' } else { '?' });
    url.push_str(&encode(key));
    url.push('=');
    url.push_str(&encode(value));
}

fn remote_spec(item: &Transport, values: &Map<String, Value>, enforce: bool) -> Result<Value, String> {
    let base = item.url.as_deref().map(str::trim)
        .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
        .ok_or("远程条目缺少 http(s) 地址")?;
    let mut url = base.to_string();
    for variable in &item.variables {
        let name = variable.name.trim();
        if name.is_empty() { continue; }
        let key = format!("variables.{name}");
        if let Some(value) = read_value(values, &key).or_else(|| key_value_default(variable)) {
            let brace = format!("{{{name}}}");
            let moustache = format!("{{{{{name}}}}}");
            if url.contains(&brace) {
                url = url.replace(&brace, &encode(&value));
            } else if url.contains(&moustache) {
                url = url.replace(&moustache, &encode(&value));
            } else {
                append_query(&mut url, name, &value);
            }
            continue;
        }
        if enforce && key_value_required(variable) {
            return Err(format!("缺少必填变量「{name}」"));
        }
    }
    let mut headers = Map::new();
    for header in &item.headers {
        let name = header.name.trim();
        if name.is_empty() { continue; }
        let key = format!("headers.{name}");
        if let Some(value) = read_value(values, &key).or_else(|| key_value_default(header)) {
            headers.insert(name.to_string(), Value::String(value));
            continue;
        }
        if enforce && key_value_required(header) {
            return Err(format!("缺少必填请求头「{name}」"));
        }
    }
    let mut spec = Map::new();
    spec.insert("type".into(), json!(item.protocol));
    spec.insert("url".into(), json!(url));
    if !headers.is_empty() { spec.insert("headers".into(), Value::Object(headers)); }
    Ok(Value::Object(spec))
}

fn parameter(key: String, label: String, description: Option<String>, required: bool, secret: bool, kind: String, default_value: Option<String>, placeholder: Option<String>, location: &str) -> MarketParameter {
    MarketParameter {
        key,
        label,
        description,
        required,
        secret,
        kind,
        default_value: default_value.map(Value::String),
        placeholder,
        enum_values: Vec::new(),
        location: Some(location.into()),
    }
}

fn stdio_parameters(item: &Package) -> Vec<MarketParameter> {
    let mut out = Vec::new();
    for (index, argument) in item.runtime_arguments.iter().enumerate() {
        let label = argument.name.clone().unwrap_or_else(|| format!("runtime arg {}", index + 1));
        out.push(parameter(format!("runtime_arguments.{index}"), label, argument.description.clone(), argument.required, false, argument_kind(argument), argument_default(argument), argument.hint.clone(), "arg"));
    }
    for (index, argument) in item.package_arguments.iter().enumerate() {
        let label = argument.name.clone().unwrap_or_else(|| format!("package arg {}", index + 1));
        out.push(parameter(format!("package_arguments.{index}"), label, argument.description.clone(), argument.required, false, argument_kind(argument), argument_default(argument), argument.hint.clone(), "arg"));
    }
    for item in &item.environment_variables {
        let name = item.name.trim();
        if name.is_empty() { continue; }
        out.push(parameter(format!("env.{name}"), name.into(), item.description.clone(), key_value_required(item), item.secret || key_looks_secret(name), item.format.clone().map(|format| match format.as_str() { "boolean" => "boolean", "number" => "number", "integer" => "integer", "object" | "array" => "json", _ => "string" }.to_string()).unwrap_or_else(|| "string".into()), key_value_default(item), item.hint.clone(), "env"));
    }
    out
}

fn remote_parameters(item: &Transport) -> Vec<MarketParameter> {
    let mut out = Vec::new();
    for header in &item.headers {
        let name = header.name.trim();
        if name.is_empty() { continue; }
        out.push(parameter(format!("headers.{name}"), name.into(), header.description.clone(), key_value_required(header), header.secret || key_looks_secret(name), header.format.clone().map(|format| format_kind(&format)).unwrap_or_else(|| "string".into()), key_value_default(header), header.hint.clone(), "header"));
    }
    for variable in &item.variables {
        let name = variable.name.trim();
        if name.is_empty() { continue; }
        out.push(parameter(format!("variables.{name}"), name.into(), variable.description.clone(), key_value_required(variable), variable.secret || key_looks_secret(name), variable.format.clone().map(|format| format_kind(&format)).unwrap_or_else(|| "string".into()), key_value_default(variable), variable.hint.clone(), "query"));
    }
    out
}

fn format_kind(format: &str) -> String {
    match format {
        "boolean" => "boolean",
        "number" => "number",
        "integer" => "integer",
        "object" | "array" => "json",
        _ => "string",
    }.into()
}

fn key_looks_secret(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.contains("token") || name.contains("secret") || name.contains("password") || name.contains("api_key") || name.ends_with("key")
}

fn official_options(provider: Provider, server: &Map<String, Value>) -> Vec<MarketOption> {
    let mut options = Vec::new();
    for (index, item) in server.get("packages").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let Some(package) = package(item) else { continue };
        let Some(transport) = package.transport.as_ref() else { continue };
        if provider == Provider::Codex && transport.protocol == "sse" { continue; }
        let protocol = transport.protocol.clone();
        if protocol == "stdio" {
            if let Ok(spec) = stdio_spec(&package, &Map::new(), false) {
                let runtime = runtime_of(&package).unwrap_or_else(|| "runtime".into());
                options.push(MarketOption {
                    id: format!("official:package:{index}:{protocol}"),
                    protocol,
                    label: format!("stdio ({runtime})"),
                    description: Some(format!("运行包 {}", package.identifier)),
                    spec,
                    parameters: stdio_parameters(&package),
                });
            }
        } else if let Ok(spec) = remote_spec(transport, &Map::new(), false) {
            options.push(MarketOption {
                id: format!("official:package:{index}:{protocol}"),
                label: format!("{protocol} (package)"),
                protocol,
                description: Some(format!("远程包 {}", package.identifier)),
                spec,
                parameters: remote_parameters(transport),
            });
        }
    }
    for (index, item) in server.get("remotes").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let Some(transport) = transport(Some(item)) else { continue };
        if provider == Provider::Codex && transport.protocol == "sse" { continue; }
        if let Ok(spec) = remote_spec(&transport, &Map::new(), false) {
            options.push(MarketOption {
                id: format!("official:remote:{index}:{}", transport.protocol),
                protocol: transport.protocol.clone(),
                label: format!("{} (remote)", transport.protocol),
                description: transport.url.clone(),
                spec,
                parameters: remote_parameters(&transport),
            });
        }
    }
    options
}

fn official_detail(provider: Provider, server: &Map<String, Value>, meta: Option<&Value>) -> Result<MarketDetail, String> {
    let item = official_item(server, meta).ok_or("服务器条目缺少名称")?;
    let install_options = official_options(provider, server);
    let default = install_options.iter().min_by_key(|option| protocol_priority(&option.protocol));
    Ok(MarketDetail {
        provider_id: item.provider_id,
        server_id: item.server_id,
        name: item.name,
        description: item.description,
        homepage: item.homepage,
        remote: item.remote,
        verified: item.verified,
        icon_url: item.icon_url,
        latest_version: item.latest_version,
        protocols: item.protocols,
        owner: item.owner,
        namespace: item.namespace,
        downloads: item.downloads,
        score: item.score,
        is_deployed: item.is_deployed,
        default_option_id: default.map(|option| option.id.clone()),
        spec: default.map(|option| option.spec.clone()),
        install_options,
    })
}

fn resolve_official(provider: Provider, server: &Map<String, Value>, option_id: &str, values: &Map<String, Value>) -> Result<Value, String> {
    let mut parts = option_id.split(':');
    let market = parts.next().ok_or("安装方式无效")?;
    let source = parts.next().ok_or("安装方式无效")?;
    let index: usize = parts.next().ok_or("安装方式无效")?.parse().map_err(|_| "安装方式无效")?;
    let protocol = parts.next().ok_or("安装方式无效")?;
    if market != "official" { return Err("安装方式无效".into()); }
    if provider == Provider::Codex && protocol == "sse" { return Err("Codex 不支持 SSE 传输".into()); }
    match source {
        "package" => {
            let item = server.get("packages").and_then(Value::as_array).and_then(|items| items.get(index))
                .and_then(package).ok_or("安装包不存在")?;
            if protocol == "stdio" {
                stdio_spec(&item, values, true)
            } else {
                remote_spec(item.transport.as_ref().ok_or("安装包缺少传输方式")?, values, true)
            }
        }
        "remote" => {
            let item = server.get("remotes").and_then(Value::as_array).and_then(|items| items.get(index))
                .and_then(|value| transport(Some(value))).ok_or("远程条目不存在")?;
            remote_spec(&item, values, true)
        }
        _ => Err("安装方式无效".into()),
    }
}

// ---------- Smithery ----------

#[derive(Clone)]
struct SchemaField {
    key: String,
    description: Option<String>,
    required: bool,
    secret: bool,
    kind: String,
    default: Option<Value>,
    enum_values: Vec<String>,
    location: String,
}

fn schema_kind(property: &Map<String, Value>) -> String {
    match property.get("type") {
        Some(Value::String(kind)) => format_kind(kind),
        Some(Value::Array(kinds)) => kinds.iter().filter_map(Value::as_str).find(|kind| *kind != "null")
            .map(format_kind).unwrap_or_else(|| "string".into()),
        _ => "string".into(),
    }
}

fn schema_fields(schema: Option<&Value>) -> Vec<SchemaField> {
    let Some(root) = schema.and_then(Value::as_object) else { return Vec::new() };
    let required: BTreeSet<String> = root.get("required").and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let Some(properties) = root.get("properties").and_then(Value::as_object) else { return Vec::new() };
    properties.iter().filter_map(|(key, raw)| {
        let property = raw.as_object()?;
        let secret = bool_field(property, "writeOnly").unwrap_or(false) || key_looks_secret(key);
        let explicit = property.get("x-from").and_then(Value::as_str).unwrap_or("").trim();
        let location = if explicit.eq_ignore_ascii_case("header") {
            "header"
        } else if explicit.eq_ignore_ascii_case("query") {
            "query"
        } else if secret {
            "header"
        } else {
            "query"
        };
        Some(SchemaField {
            key: key.clone(),
            description: field(property, "description"),
            required: required.contains(key),
            secret,
            kind: schema_kind(property),
            default: property.get("default").cloned(),
            enum_values: property.get("enum").and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default(),
            location: location.into(),
        })
    }).collect()
}

fn smithery_spec(connection: &Map<String, Value>, fallback: Option<&str>, values: &Map<String, Value>, enforce: bool) -> Result<Value, String> {
    let protocol = connection.get("type").and_then(Value::as_str).map(protocol_or_http).unwrap_or_else(|| "http".into());
    let url = field(connection, "deploymentUrl").or_else(|| fallback.map(str::to_string))
        .ok_or("这个远程条目没有部署地址")?;
    if !(url.starts_with("http://") || url.starts_with("https://")) { return Err("远程条目缺少 http(s) 地址".into()); }
    let mut url = url;
    let mut headers = Map::new();
    for item in schema_fields(connection.get("configSchema")) {
        let value = read_value(values, &item.key).or_else(|| item.default.as_ref().and_then(value_text));
        if let Some(value) = value {
            if item.location == "header" {
                headers.insert(item.key, Value::String(value));
            } else {
                append_query(&mut url, &item.key, &value);
            }
            continue;
        }
        if enforce && item.required {
            return Err(format!("缺少必填参数「{}」", item.key));
        }
    }
    let mut spec = Map::new();
    spec.insert("type".into(), json!(protocol));
    spec.insert("url".into(), json!(url));
    if !headers.is_empty() { spec.insert("headers".into(), Value::Object(headers)); }
    Ok(Value::Object(spec))
}

fn smithery_parameters(connection: &Map<String, Value>) -> Vec<MarketParameter> {
    schema_fields(connection.get("configSchema")).into_iter().map(|item| MarketParameter {
        key: item.key.clone(),
        label: item.key,
        description: item.description,
        required: item.required,
        secret: item.secret,
        kind: item.kind,
        default_value: item.default,
        placeholder: None,
        enum_values: item.enum_values,
        location: Some(item.location),
    }).collect()
}

fn smithery_detail(provider: Provider, server: &Map<String, Value>) -> MarketDetail {
    let item = smithery_item(server).unwrap_or_else(|| MarketServer {
        provider_id: SMITHERY.into(),
        server_id: field(server, "qualifiedName").unwrap_or_default(),
        name: field(server, "displayName").unwrap_or_default(),
        description: string_field(server, "description"),
        homepage: None,
        remote: false,
        verified: false,
        icon_url: None,
        latest_version: None,
        protocols: Vec::new(),
        owner: None,
        namespace: None,
        downloads: None,
        score: None,
        is_deployed: None,
    });
    let fallback = field(server, "deploymentUrl");
    let mut options = Vec::new();
    for (index, connection) in server.get("connections").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let Some(connection) = connection.as_object() else { continue };
        let protocol = connection.get("type").and_then(Value::as_str).map(protocol_or_http).unwrap_or_else(|| "http".into());
        if provider == Provider::Codex && protocol == "sse" { continue; }
        if let Ok(spec) = smithery_spec(connection, fallback.as_deref(), &Map::new(), false) {
            options.push(MarketOption {
                id: format!("smithery:connection:{index}:{protocol}"),
                protocol: protocol.clone(),
                label: format!("{protocol} (remote)"),
                description: field(connection, "deploymentUrl").or_else(|| fallback.clone()),
                spec,
                parameters: smithery_parameters(connection),
            });
        }
    }
    let default = options.iter().min_by_key(|option| protocol_priority(&option.protocol));
    let protocols = if options.is_empty() {
        item.protocols.clone()
    } else {
        let mut seen = BTreeSet::new();
        for option in &options { seen.insert(option.protocol.clone()); }
        seen.into_iter().collect()
    };
    MarketDetail {
        provider_id: item.provider_id,
        server_id: item.server_id,
        name: item.name,
        description: item.description,
        homepage: item.homepage,
        remote: item.remote,
        verified: item.verified,
        icon_url: item.icon_url,
        latest_version: item.latest_version,
        protocols,
        owner: item.owner,
        namespace: item.namespace,
        downloads: item.downloads,
        score: item.score,
        is_deployed: item.is_deployed,
        default_option_id: default.map(|option| option.id.clone()),
        spec: default.map(|option| option.spec.clone()),
        install_options: options,
    }
}

fn resolve_smithery(provider: Provider, server: &Map<String, Value>, option_id: &str, values: &Map<String, Value>) -> Result<Value, String> {
    let mut parts = option_id.split(':');
    let market = parts.next().ok_or("安装方式无效")?;
    let source = parts.next().ok_or("安装方式无效")?;
    let index: usize = parts.next().ok_or("安装方式无效")?.parse().map_err(|_| "安装方式无效")?;
    let protocol = parts.next().ok_or("安装方式无效")?;
    if market != "smithery" || source != "connection" { return Err("安装方式无效".into()); }
    if provider == Provider::Codex && protocol == "sse" { return Err("Codex 不支持 SSE 传输".into()); }
    let connection = server.get("connections").and_then(Value::as_array).and_then(|items| items.get(index))
        .and_then(Value::as_object).ok_or("远程条目不存在")?;
    smithery_spec(connection, field(server, "deploymentUrl").as_deref(), values, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn official_fixture() -> Value {
        json!({ "servers": [
            { "server": {
                "name": "io.github.acme/files", "title": "Acme Files", "version": "1.2.3",
                "description": "Files over GCS",
                "websiteUrl": "https://acme.dev/files",
                "repository": { "url": "https://github.com/acme/files", "source": "github" },
                "icons": [ { "src": "https://acme.dev/icon.png", "mimeType": "image/png" } ],
                "packages": [
                    {
                        "registryType": "npm", "identifier": "acme-mcp", "version": "1.2.3",
                        "runtimeHint": "npx", "transport": { "type": "stdio" },
                        "runtimeArguments": [ { "type": "positional", "value": "-y" } ],
                        "packageArguments": [ { "type": "named", "name": "--mode", "default": "fast" } ],
                        "environmentVariables": [
                            { "name": "GCS_BUCKET", "description": "bucket", "isRequired": true },
                            { "name": "GCS_KEY", "description": "key", "isSecret": true }
                        ]
                    },
                    {
                        "registryType": "pypi", "identifier": "acme-py", "version": "2.0.0",
                        "runtimeHint": "uvx", "transport": { "type": "stdio" }
                    }
                ],
                "remotes": [
                    { "type": "streamable-http", "url": "https://mcp.acme.dev/{tenant}?key={key}",
                      "headers": [ { "name": "Authorization", "isRequired": true, "isSecret": true } ],
                      "variables": [
                          { "name": "tenant", "isRequired": true },
                          { "name": "key", "isRequired": true, "isSecret": true }
                      ] },
                    { "type": "sse", "url": "https://mcp.acme.dev/sse" }
                ]
            }, "_meta": { "io.modelcontextprotocol.registry/official": { "status": "active" } } },
            { "server": {
                "name": "io.github.acme/second", "version": "0.9.0", "description": "second"
            } }
        ]})
    }

    fn smithery_fixture() -> Value {
        json!({ "servers": [ {
            "qualifiedName": "@acme/files", "displayName": "Acme Files", "description": "Files",
            "homepage": "https://acme.dev", "iconUrl": "https://acme.dev/icon.png",
            "remote": true, "verified": true, "useCount": 42, "score": 4.5, "isDeployed": true,
            "owner": "acme", "namespace": "@acme"
        } ]})
    }

    #[test]
    fn official_list_keeps_full_ids_and_reports_badges() {
        let items = parse_official_list(&official_fixture()).unwrap();
        let item = items.iter().find(|item| item.server_id == "io.github.acme/files").unwrap();
        assert_eq!(item.name, "Acme Files");
        assert_eq!(item.latest_version.as_deref(), Some("1.2.3"));
        assert_eq!(item.homepage.as_deref(), Some("https://acme.dev/files"));
        assert_eq!(item.icon_url.as_deref(), Some("https://acme.dev/icon.png"));
        assert!(item.verified);
        assert!(item.remote);
        assert_eq!(item.protocols, vec!["http".to_string(), "sse".to_string(), "stdio".to_string()]);
        // 未声明标题时用完整服务器名，而不是被截断的本地键。
        assert_eq!(items[1].server_id, "io.github.acme/second");
        assert_eq!(items[1].name, "io.github.acme/second");
    }

    #[test]
    fn official_search_uses_latest_and_has_no_duplicate_versions() {
        let url = official_url("chrome devtools");
        assert!(url.contains("version=latest"), "{url}");
        assert!(url.contains("limit=30"), "{url}");
        assert!(url.ends_with("search=chrome%20devtools"), "{url}");
        let encoded = official_url("a&limit=9999#x");
        assert!(encoded.contains("%26limit%3D9999"), "{encoded}");
        assert_eq!(encoded.matches("limit=").count(), 1, "{encoded}");
        assert_eq!(smithery_url("github"), format!("{SMITHERY_SERVERS}?limit={LIMIT}&q=github"));
    }

    #[test]
    fn official_detail_offers_every_transport_and_skips_sse_for_codex() {
        let root = official_fixture();
        let server = root["servers"][0]["server"].as_object().unwrap();
        let claude = official_detail(Provider::Claude, server, root["servers"][0].get("_meta")).unwrap();
        let ids: Vec<_> = claude.install_options.iter().map(|option| option.id.as_str()).collect();
        assert_eq!(ids, vec![
            "official:package:0:stdio",
            "official:package:1:stdio",
            "official:remote:0:http",
            "official:remote:1:sse",
        ]);
        // 默认选 stdio；配置已钉住版本并带 npx 的 -y。
        assert_eq!(claude.default_option_id.as_deref(), Some("official:package:0:stdio"));
        let spec = claude.spec.unwrap();
        assert_eq!(spec["command"], "npx");
        assert_eq!(spec["args"][2], "acme-mcp@1.2.3");

        let codex = official_detail(Provider::Codex, server, None).unwrap();
        assert!(codex.install_options.iter().all(|option| option.protocol != "sse"));
        assert_eq!(codex.install_options.len(), 3);
    }

    #[test]
    fn stdio_install_applies_required_env_and_arguments() {
        let root = official_fixture();
        let server = root["servers"][0]["server"].as_object().unwrap();
        let mut values = Map::new();
        values.insert("env.GCS_BUCKET".into(), json!("bucket-1"));
        values.insert("env.GCS_KEY".into(), json!("secret"));
        values.insert("package_arguments.0".into(), json!("slow"));
        let spec = resolve_official(Provider::Claude, server, "official:package:0:stdio", &values).unwrap();
        assert_eq!(spec["args"], json!(["-y", "-y", "acme-mcp@1.2.3", "--mode", "slow"]));
        assert_eq!(spec["env"]["GCS_BUCKET"], "bucket-1");
        assert_eq!(spec["env"]["GCS_KEY"], "secret");

        let missing = resolve_official(Provider::Claude, server, "official:package:0:stdio", &Map::new()).unwrap_err();
        // GCS_KEY 没写 isRequired，但既无默认值又像密钥，仍按必填处理。
        assert!(missing.contains("GCS_BUCKET") || missing.contains("GCS_KEY"), "{missing}");
    }

    #[test]
    fn remote_install_replaces_placeholders_and_fills_headers() {
        let root = official_fixture();
        let server = root["servers"][0]["server"].as_object().unwrap();
        let mut values = Map::new();
        values.insert("variables.tenant".into(), json!("team one"));
        values.insert("variables.key".into(), json!("k&1"));
        values.insert("headers.Authorization".into(), json!("Bearer x"));
        let spec = resolve_official(Provider::Claude, server, "official:remote:0:http", &values).unwrap();
        assert_eq!(spec["type"], "http");
        assert_eq!(spec["url"], "https://mcp.acme.dev/team%20one?key=k%261");
        assert_eq!(spec["headers"]["Authorization"], "Bearer x");

        let err = resolve_official(Provider::Claude, server, "official:remote:0:http", &Map::new()).unwrap_err();
        assert!(err.contains("tenant"), "{err}");
    }

    #[test]
    fn codex_rejects_sse_and_pypi_uses_uvx() {
        let root = official_fixture();
        let server = root["servers"][0]["server"].as_object().unwrap();
        assert!(resolve_official(Provider::Codex, server, "official:remote:1:sse", &Map::new()).is_err());
        let spec = resolve_official(Provider::Codex, server, "official:package:1:stdio", &Map::new()).unwrap();
        assert_eq!(spec["command"], "uvx");
        assert_eq!(spec["args"][0], "acme-py==2.0.0");
    }

    #[test]
    fn smithery_list_and_detail_read_schema_parameters() {
        let items = parse_smithery_list(&smithery_fixture()).unwrap();
        assert_eq!(items[0].server_id, "@acme/files");
        assert_eq!(items[0].downloads, Some(42));
        assert_eq!(items[0].protocols, vec!["http".to_string()]);

        let detail = json!({
            "qualifiedName": "@acme/files", "displayName": "Acme Files", "deploymentUrl": "https://srv.acme.dev/mcp",
            "connections": [ {
                "type": "http", "deploymentUrl": "https://srv.acme.dev/mcp",
                "configSchema": {
                    "required": ["token"],
                    "properties": {
                        "token": { "type": "string", "writeOnly": true },
                        "region": { "type": "string", "enum": ["us", "eu"], "default": "us" },
                        "limit": { "type": "integer", "default": 10 }
                    }
                }
            } ]
        });
        let server = detail.as_object().unwrap();
        let parsed = smithery_detail(Provider::Claude, server);
        assert_eq!(parsed.install_options.len(), 1);
        let option = &parsed.install_options[0];
        assert_eq!(option.id, "smithery:connection:0:http");
        assert_eq!(option.parameters.len(), 3);
        let token = option.parameters.iter().find(|item| item.key == "token").unwrap();
        assert!(token.required && token.secret);
        assert_eq!(token.location.as_deref(), Some("header"));
        let mut values = Map::new();
        values.insert("token".into(), json!("secret"));
        let spec = resolve_smithery(Provider::Claude, server, &option.id, &values).unwrap();
        assert_eq!(spec["headers"]["token"], "secret");
        assert_eq!(spec["url"], "https://srv.acme.dev/mcp?limit=10&region=us");
        assert!(resolve_smithery(Provider::Claude, server, &option.id, &Map::new()).is_err());
    }

    #[test]
    fn placeholder_defaults_are_required_and_never_written() {
        let item = KeyValue {
            name: "Authorization".into(),
            value: Some("Bearer {smithery_api_key}".into()),
            ..Default::default()
        };
        assert_eq!(key_value_default(&item), None);
        assert!(key_value_required(&item));
        let literal = KeyValue { name: "MODE".into(), value: Some("fast".into()), ..Default::default() };
        assert_eq!(key_value_default(&literal).as_deref(), Some("fast"));
        assert!(!key_value_required(&literal));
    }

    #[test]
    fn option_ids_from_other_markets_are_rejected() {
        let root = official_fixture();
        let server = root["servers"][0]["server"].as_object().unwrap();
        assert!(resolve_official(Provider::Claude, server, "smithery:connection:0:http", &Map::new()).is_err());
        assert!(resolve_official(Provider::Claude, server, "official:package:99:stdio", &Map::new()).is_err());
    }
}
