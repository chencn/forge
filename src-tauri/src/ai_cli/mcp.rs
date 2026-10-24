//! 本地 MCP 服务器：Claude 写 `~/.claude.json` 的 `mcpServers`（用户级服务器由 CLI 直接加载，实测不需要额外启用开关），
//! Codex 写 `config.toml` 的 `[mcp_servers.<id>]`。另外接官方 MCP registry 做市场搜索与一键安装。
use super::{home, settings, Provider};
use crate::offload::block;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use toml_edit::{value, Array, DocumentMut, Item, Table};

const MAX_SPEC: usize = 64 * 1024;
const MAX_ID: usize = 128;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub spec: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpList {
    pub path: String,
    pub servers: Vec<McpServer>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= MAX_ID
        && id == id.trim()
        // 市场服务器名带 @、/、:（如 `@scope/name`、`io.github.user/repo`）；
        // JSON 与 toml_edit 都会把键正确转义，只拦控制字符。
        && !id.chars().any(char::is_control)
}

/// `.claude.json` 的位置：设了 `CLAUDE_CONFIG_DIR` 时整份配置目录都会搬过去，
/// 实测 Claude Code 2.1.308 会在该目录下新建 `.claude.json`，此时 `~/.claude.json` 不再被读。
fn resolve_claude_json(config_dir: Option<PathBuf>, home: PathBuf) -> PathBuf {
    match config_dir.filter(|path| path.is_absolute()) {
        Some(dir) => dir.join(".claude.json"),
        None => home.join(".claude.json"),
    }
}

fn claude_json_path() -> Result<PathBuf, String> {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from);
    Ok(resolve_claude_json(dir, home()?))
}

fn valid_env_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 256
        && key.bytes().next().is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && key.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'.' || byte == b'-')
}

fn string_map(value: Option<&Value>, name: &str, env_keys: bool) -> Result<Option<Map<String, Value>>, String> {
    let Some(value) = value else { return Ok(None) };
    let Some(object) = value.as_object() else { return Err(format!("{name} 必须是 JSON 对象")) };
    if object.len() > 128 {
        return Err(format!("{name} 条目过多"));
    }
    let mut out = Map::new();
    for (key, item) in object {
        let Some(text) = item.as_str() else { return Err(format!("{name}.{key} 必须是字符串")) };
        if key.is_empty() || key.len() > 256 || text.len() > 4096 || key.contains('\0') || text.contains('\0') {
            return Err(format!("{name}.{key} 过长或包含非法字符"));
        }
        if env_keys && !valid_env_key(key) {
            return Err(format!("{name}.{key} 不是合法的环境变量名"));
        }
        out.insert(key.clone(), Value::String(text.to_string()));
    }
    Ok(Some(out))
}

/// 把前端的 MCP 配置收敛成 CLI 认识的形态。
/// 传输字段之外的键（cwd、超时、工具过滤等）原样保留，避免编辑一次就丢掉用户手写的选项。
fn canonical_spec(spec: &Value) -> Result<Value, String> {
    if serde_json::to_string(spec).map_err(|error| error.to_string())?.len() > MAX_SPEC {
        return Err("MCP 配置过大".into());
    }
    let object = spec.as_object().ok_or("MCP 配置必须是 JSON 对象")?;
    if object.values().any(Value::is_null) {
        return Err("MCP 配置不支持 null 值".into());
    }
    let url = object.get("url").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
    let command = object.get("command").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
    if url.is_some() && command.is_some() {
        return Err("url 与 command 只能二选一：远程 MCP 用 url，stdio 用 command".into());
    }

    let mut out = object.clone();
    if let Some(url) = url {
        if !(url.starts_with("http://") || url.starts_with("https://")) || url.len() > 2048
            || url.chars().any(|ch| ch.is_whitespace() || ch == '\0') {
            return Err("MCP URL 必须是 http(s) 地址且不能包含空格".into());
        }
        let kind = if object.get("type").and_then(Value::as_str).is_some_and(|kind| kind.eq_ignore_ascii_case("sse")) { "sse" } else { "http" };
        out.insert("type".into(), Value::String(kind.into()));
        out.insert("url".into(), Value::String(url.to_string()));
        match string_map(object.get("headers"), "headers", false)? {
            Some(headers) if !headers.is_empty() => { out.insert("headers".into(), Value::Object(headers)); }
            _ => { out.remove("headers"); }
        }
        // 远程 MCP 不读 env 和 command；保留下来只会让用户误以为生效，界面会提前提示。
        out.remove("env");
        out.remove("command");
        out.remove("http_headers");
    } else {
        let command = command.ok_or("stdio 服务器必须提供 command（或改用 url）")?;
        if command.len() > 1024 || command.contains('\0') {
            return Err("command 过长或包含非法字符".into());
        }
        out.insert("type".into(), Value::String("stdio".into()));
        out.insert("command".into(), Value::String(command.to_string()));
        if let Some(args) = object.get("args") {
            let Some(items) = args.as_array() else { return Err("args 必须是字符串数组".into()) };
            if items.len() > 64 {
                return Err("args 参数过多".into());
            }
            let mut clean = Vec::new();
            for item in items {
                let Some(text) = item.as_str() else { return Err("args 必须是字符串数组".into()) };
                if text.len() > 2048 || text.contains('\0') {
                    return Err("args 参数过长或包含非法字符".into());
                }
                clean.push(Value::String(text.to_string()));
            }
            if clean.is_empty() { out.remove("args"); } else { out.insert("args".into(), Value::Array(clean)); }
        }
        match string_map(object.get("env"), "env", true)? {
            Some(env) if !env.is_empty() => { out.insert("env".into(), Value::Object(env)); }
            _ => { out.remove("env"); }
        }
        out.remove("url");
        out.remove("headers");
        out.remove("http_headers");
    }
    Ok(Value::Object(out))
}

fn read_json(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let text = fs::read_to_string(path).map_err(|error| format!("读取配置失败：{error}"))?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|error| format!("JSON 格式错误：{error}"))
}

fn read_claude_at(path: &Path) -> Result<BTreeMap<String, Value>, String> {
    let root = read_json(path)?;
    let Some(object) = root.as_object() else { return Err("~/.claude.json 不是 JSON 对象".into()) };
    let mut out = BTreeMap::new();
    if let Some(servers) = object.get("mcpServers").and_then(Value::as_object) {
        for (id, spec) in servers {
            if !spec.is_object() { continue; }
            // 校验失败的条目也原样列出：直接隐藏会让用户以为服务器丢了，保存时再给出具体原因。
            out.insert(id.clone(), canonical_spec(spec).unwrap_or_else(|_| spec.clone()));
        }
    }
    Ok(out)
}

fn write_claude_at(path: &Path, id: &str, spec: Option<&Value>) -> Result<(), String> {
    // 删除时文件本来就不存在：没有可删的内容，也别凭空创建一份空配置。
    if !path.exists() && spec.is_none() { return Ok(()); }
    let mut root = read_json(path)?;
    // 根不是对象时说明文件已被别的东西占用；覆盖会把整份内容冲掉，直接拒绝。
    if !root.is_object() {
        return Err("~/.claude.json 不是 JSON 对象，拒绝覆盖".into());
    }
    let object = root.as_object_mut().ok_or("~/.claude.json 不是 JSON 对象")?;
    let entry = object.entry("mcpServers").or_insert_with(|| json!({}));
    if !entry.is_object() {
        return Err("mcpServers 不是 JSON 对象".into());
    }
    let servers = entry.as_object_mut().ok_or("mcpServers 不是 JSON 对象")?;
    match spec {
        Some(spec) => { servers.insert(id.to_string(), canonical_spec(spec)?); }
        None => { servers.remove(id); }
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    settings::backup_and_write(path, &serde_json::to_string_pretty(&root).map_err(|error| error.to_string())?)
}

fn toml_to_json(value: &toml::Value) -> Value {
    match value {
        toml::Value::String(text) => Value::String(text.clone()),
        toml::Value::Integer(number) => json!(number),
        toml::Value::Float(number) => json!(number),
        toml::Value::Boolean(flag) => Value::Bool(*flag),
        toml::Value::Datetime(time) => Value::String(time.to_string()),
        toml::Value::Array(items) => Value::Array(items.iter().map(toml_to_json).collect()),
        toml::Value::Table(table) => Value::Object(table.iter().map(|(key, item)| (key.clone(), toml_to_json(item))).collect()),
    }
}

/// JSON → TOML 条目；Codex MCP 条目里的额外标量/数组/子表都按原样写回。
fn json_to_item(value: &Value) -> Result<Item, String> {
    Ok(match value {
        Value::String(text) => toml_edit::value(text.as_str()),
        Value::Bool(flag) => toml_edit::value(*flag),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                toml_edit::value(integer)
            } else if let Some(float) = number.as_f64() {
                toml_edit::value(float)
            } else {
                return Err("数值超出 TOML 支持的范围".into());
            }
        }
        Value::Array(items) => {
            let mut array = Array::new();
            for item in items {
                match item {
                    Value::String(text) => array.push(text.as_str()),
                    Value::Number(number) => {
                        if let Some(integer) = number.as_i64() {
                            array.push(integer);
                        } else if let Some(float) = number.as_f64() {
                            array.push(float);
                        } else {
                            return Err("数值超出 TOML 支持的范围".into());
                        }
                    }
                    Value::Bool(flag) => array.push(*flag),
                    _ => return Err("数组只支持字符串、数字或布尔值".into()),
                }
            }
            Item::Value(toml_edit::Value::Array(array))
        }
        Value::Object(object) => {
            let mut table = Table::new();
            for (key, item) in object {
                if item.is_null() { continue; }
                table[key.as_str()] = json_to_item(item)?;
            }
            Item::Table(table)
        }
        Value::Null => return Err("TOML 不支持 null 值".into()),
    })
}

/// Codex 的 TOML 条目 → 统一后的 JSON。除传输字段外的键原样带出，界面能看到并保留。
fn codex_entry_to_spec(item: &toml::Value) -> Option<Value> {
    let table = item.as_table()?;
    let url = table.get("url").and_then(|value| value.as_str()).map(str::trim).filter(|value| !value.is_empty());
    let command = table.get("command").and_then(|value| value.as_str()).map(str::trim).filter(|value| !value.is_empty());
    if url.is_none() && command.is_none() {
        return None;
    }
    let mut spec = toml_to_json(item);
    let object = spec.as_object_mut()?;
    if url.is_some() {
        let kind = if table.get("type").and_then(|value| value.as_str()).is_some_and(|kind| kind.eq_ignore_ascii_case("sse")) { "sse" } else { "http" };
        object.insert("type".into(), Value::String(kind.into()));
        if let Some(headers) = object.remove("http_headers") {
            object.insert("headers".into(), headers);
        }
    } else {
        object.insert("type".into(), Value::String("stdio".into()));
        object.remove("http_headers");
        object.remove("url");
    }
    Some(spec)
}

fn read_codex_at(path: &Path) -> Result<BTreeMap<String, Value>, String> {
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let text = fs::read_to_string(path).map_err(|error| format!("读取 Codex 配置失败：{error}"))?;
    if text.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    let root: toml::Value = toml::from_str(&text).map_err(|error| format!("TOML 格式错误：{error}"))?;
    let Some(table) = root.as_table() else { return Ok(BTreeMap::new()) };
    let servers = table.get("mcp_servers")
        .and_then(|value| value.as_table())
        .or_else(|| table.get("mcp").and_then(|value| value.as_table()).and_then(|legacy| legacy.get("servers")).and_then(|value| value.as_table()));
    let Some(servers) = servers else { return Ok(BTreeMap::new()) };
    Ok(servers.iter().filter_map(|(id, item)| {
        // 无法识别的条目也原样带出，方便用户在面板里修正，而不是从列表里消失。
        let spec = codex_entry_to_spec(item).unwrap_or_else(|| toml_to_json(item));
        spec.is_object().then(|| (id.clone(), spec))
    }).collect())
}

fn table_entry<'a>(doc: &'a mut DocumentMut, key: &str) -> Result<&'a mut Table, String> {
    let item = doc.entry(key).or_insert(Item::Table(Table::new()));
    item.as_table_mut().ok_or_else(|| format!("{key} 必须是 TOML 表"))
}

fn toml_string_map(object: &Map<String, Value>) -> Table {
    let mut table = Table::new();
    for (key, entry) in object {
        if let Some(text) = entry.as_str() {
            table[key] = toml_edit::value(text);
        }
    }
    table
}

fn write_codex_at(path: &Path, id: &str, spec: Option<&Value>) -> Result<(), String> {
    if !path.exists() && spec.is_none() { return Ok(()); }
    let existing = if path.exists() { fs::read_to_string(path).map_err(|error| format!("读取 Codex 配置失败：{error}"))? } else { String::new() };
    let mut doc: DocumentMut = existing.parse().map_err(|error| format!("TOML 格式错误：{error}"))?;
    let servers = table_entry(&mut doc, "mcp_servers")?;
    match spec {
        Some(spec) => {
            let canonical = canonical_spec(spec)?;
            let object = canonical.as_object().ok_or("MCP 配置必须是 JSON 对象")?;
            let item = servers.entry(id).or_insert(Item::Table(Table::new()));
            let table = item.as_table_mut().ok_or("mcp_servers 条目必须是 TOML 表")?;
            const MANAGED: [&str; 7] = ["type", "command", "args", "env", "url", "headers", "http_headers"];
            for key in MANAGED {
                table.remove(key);
            }
            let remote = object.get("type").and_then(Value::as_str).is_some_and(|kind| kind == "http" || kind == "sse");
            if remote {
                if let Some(url) = object.get("url").and_then(Value::as_str) {
                    table["url"] = value(url);
                }
                if let Some(headers) = object.get("headers").and_then(Value::as_object) {
                    table["http_headers"] = Item::Table(toml_string_map(headers));
                }
            } else {
                if let Some(command) = object.get("command").and_then(Value::as_str) {
                    table["command"] = value(command);
                }
                if let Some(args) = object.get("args").and_then(Value::as_array) {
                    let mut array = Array::new();
                    for arg in args.iter().filter_map(Value::as_str) {
                        array.push(arg);
                    }
                    table["args"] = value(array);
                }
                if let Some(env) = object.get("env").and_then(Value::as_object) {
                    table["env"] = Item::Table(toml_string_map(env));
                }
            }
            // cwd、超时、bearer_token_env_var、工具过滤等 Codex 自己的键原样保留。
            for (key, entry) in object {
                if MANAGED.contains(&key.as_str()) || entry.is_null() { continue; }
                table[key.as_str()] = json_to_item(entry)?;
            }
        }
        None => { servers.remove(id); }
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    settings::backup_and_write(path, &doc.to_string())
}

fn list(provider: Provider) -> Result<McpList, String> {
    let (path, servers) = match provider {
        Provider::Claude => {
            let path = claude_json_path()?;
            let servers = read_claude_at(&path)?;
            (path, servers)
        }
        Provider::Codex => {
            let path = settings::config_path(Provider::Codex)?;
            let servers = read_codex_at(&path)?;
            (path, servers)
        }
    };
    Ok(McpList {
        path: path.to_string_lossy().into_owned(),
        servers: servers.into_iter().map(|(id, spec)| McpServer { id, spec }).collect(),
    })
}

fn save(provider: Provider, id: &str, spec: &Value) -> Result<McpList, String> {
    if !valid_id(id) {
        return Err("服务器 ID 不能为空、不能超过 128 个字符，且首尾不能有空白。".into());
    }
    canonical_spec(spec)?;
    match provider {
        Provider::Claude => write_claude_at(&claude_json_path()?, id, Some(spec))?,
        Provider::Codex => write_codex_at(&settings::config_path(Provider::Codex)?, id, Some(spec))?,
    }
    list(provider)
}

fn remove(provider: Provider, id: &str) -> Result<McpList, String> {
    if !valid_id(id) {
        return Err("服务器 ID 不能为空、不能超过 128 个字符，且首尾不能有空白。".into());
    }
    match provider {
        Provider::Claude => write_claude_at(&claude_json_path()?, id, None)?,
        Provider::Codex => write_codex_at(&settings::config_path(Provider::Codex)?, id, None)?,
    }
    list(provider)
}

#[tauri::command]
pub async fn ai_mcp_list(provider: Provider) -> Result<McpList, String> {
    block(move || list(provider)).await
}

#[tauri::command]
pub async fn ai_mcp_save(provider: Provider, id: String, spec: Value) -> Result<McpList, String> {
    block(move || save(provider, &id, &spec)).await
}

#[tauri::command]
pub async fn ai_mcp_delete(provider: Provider, id: String) -> Result<McpList, String> {
    block(move || remove(provider, &id)).await
}


#[path = "mcp_market.rs"]
mod market;
pub use market::*;

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("forge-mcp-{name}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.join("config.json")
    }

    #[test]
    fn canonicalizes_stdio_and_http_specs() {
        let stdio = canonical_spec(&json!({
            "command": "npx", "args": ["-y", "server"], "env": { "TOKEN": "x" }
        })).unwrap();
        assert_eq!(stdio["type"], "stdio");
        assert_eq!(stdio["command"], "npx");
        assert_eq!(stdio["args"][1], "server");

        let http = canonical_spec(&json!({"type": "sse", "url": "https://example.com/sse", "headers": {"Authorization": "Bearer x"}})).unwrap();
        assert_eq!(http["type"], "sse");
        assert_eq!(http["headers"]["Authorization"], "Bearer x");

        assert!(canonical_spec(&json!({"command": "x", "env": {"A B": "x"}})).is_err());
        assert!(canonical_spec(&json!({"url": "ftp://example.com"})).is_err());
        assert!(canonical_spec(&json!({})).is_err());
        // url 与 command 同时出现无法判断传输方式，拒绝而不是悄悄丢掉一边。
        assert!(canonical_spec(&json!({"command": "x", "url": "https://example.com"})).is_err());

        // 远程 MCP 不读 env；保留额外字段供 CLI 自己解释。
        let remote = canonical_spec(&json!({"url": "https://example.com", "env": {"A": "1"}})).unwrap();
        assert!(remote.get("env").is_none());
        let extra = canonical_spec(&json!({"command": "npx", "cwd": "/tmp", "startup_timeout_sec": 10})).unwrap();
        assert_eq!(extra["cwd"], "/tmp");
        assert_eq!(extra["startup_timeout_sec"], 10);
    }

    #[test]
    fn claude_write_preserves_other_keys_and_servers() {
        let path = temp_file("claude");
        fs::write(&path, r#"{"theme":"dark","mcpServers":{"keep":{"command":"keep"}}}"#).unwrap();
        write_claude_at(&path, "demo", Some(&json!({"command":"npx","args":["x"]}))).unwrap();
        let root: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(root["theme"], "dark");
        let servers = read_claude_at(&path).unwrap();
        assert_eq!(servers.len(), 2);
        assert_eq!(servers["demo"]["command"], "npx");
        assert_eq!(servers["keep"]["command"], "keep");
        write_claude_at(&path, "demo", None).unwrap();
        assert_eq!(read_claude_at(&path).unwrap().len(), 1);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn codex_round_trip_and_delete() {
        let path = temp_file("codex");
        fs::write(&path, "model = \"gpt-5\"\n").unwrap();
        write_codex_at(&path, "demo", Some(&json!({"command":"npx","args":["-y","server"],"env":{"TOKEN":"x"}}))).unwrap();
        let servers = read_codex_at(&path).unwrap();
        assert_eq!(servers["demo"]["type"], "stdio");
        assert_eq!(servers["demo"]["args"][1], "server");
        assert_eq!(servers["demo"]["env"]["TOKEN"], "x");
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("model = \"gpt-5\""));
        write_codex_at(&path, "demo", None).unwrap();
        assert!(read_codex_at(&path).unwrap().is_empty());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn codex_extra_fields_and_headers_survive_round_trip() {
        let path = temp_file("codex-extra");
        write_codex_at(&path, "demo", Some(&json!({
            "url": "https://example.com/mcp",
            "headers": {"Authorization": "Bearer x"},
            "bearer_token_env_var": "TOKEN",
            "startup_timeout_sec": 20,
            "enabled": true
        }))).unwrap();

        let servers = read_codex_at(&path).unwrap();
        assert_eq!(servers["demo"]["type"], "http");
        assert_eq!(servers["demo"]["headers"]["Authorization"], "Bearer x");
        assert_eq!(servers["demo"]["bearer_token_env_var"], "TOKEN");
        assert_eq!(servers["demo"]["startup_timeout_sec"], 20);
        assert_eq!(servers["demo"]["enabled"], true);
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("[mcp_servers.demo.http_headers]"));

        // 用户在面板里原样保存一次，额外字段不能丢。
        write_codex_at(&path, "demo", Some(&servers["demo"])).unwrap();
        let again = read_codex_at(&path).unwrap();
        assert_eq!(again["demo"]["bearer_token_env_var"], "TOKEN");
        assert_eq!(again["demo"]["startup_timeout_sec"], 20);
        assert_eq!(again["demo"]["headers"]["Authorization"], "Bearer x");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn claude_write_preserves_unknown_server_keys() {
        let path = temp_file("claude-extra");
        write_claude_at(&path, "demo", Some(&json!({"command":"npx","disabled":true,"timeout":30}))).unwrap();
        let servers = read_claude_at(&path).unwrap();
        assert_eq!(servers["demo"]["disabled"], true);
        assert_eq!(servers["demo"]["timeout"], 30);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn claude_json_follows_claude_config_dir() {
        let home = std::env::temp_dir();
        assert_eq!(resolve_claude_json(None, home.clone()), home.join(".claude.json"));
        let dir = home.join("forge-claude-profile");
        assert_eq!(resolve_claude_json(Some(dir.clone()), home.clone()), dir.join(".claude.json"));
        // 相对路径不认：CLI 只在绝对路径时使用该目录，避免读写到意外位置。
        assert_eq!(resolve_claude_json(Some(PathBuf::from("relative-dir")), home.clone()), home.join(".claude.json"));
    }


    #[test]
    fn market_ids_with_scope_and_slash_round_trip() {
        let path = temp_file("market-codex");
        write_codex_at(&path, "@acme/files", Some(&json!({"url": "https://example.com/mcp"}))).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("[mcp_servers.\"@acme/files\"]"), "{text}");
        assert_eq!(read_codex_at(&path).unwrap()["@acme/files"]["url"], "https://example.com/mcp");
        let json = temp_file("market-claude");
        write_claude_at(&json, "io.github.user/repo", Some(&json!({"command": "npx"}))).unwrap();
        assert!(read_claude_at(&json).unwrap().contains_key("io.github.user/repo"));
        assert!(valid_id("@acme/files") && valid_id("io.github.user/repo"));
        assert!(!valid_id(" padded") && !valid_id(""));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
        fs::remove_dir_all(json.parent().unwrap()).unwrap();
    }

    #[test]
    fn dotted_ids_round_trip_in_codex_toml() {
        let path = temp_file("dotted");
        write_codex_at(&path, "my.server", Some(&json!({"command": "npx"}))).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("[mcp_servers.\"my.server\"]"));
        let servers = read_codex_at(&path).unwrap();
        assert_eq!(servers["my.server"]["command"], "npx");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
