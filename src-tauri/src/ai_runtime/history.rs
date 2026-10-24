//! Read-only native history adapters. Only Forge's own mirror/checkpoints are written.
//! CLI 原生历史只读：只有 Forge 自己的镜像与会话检查点会被写入。
use super::store::{self, Store};
use crate::ai_cli::Provider;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// 单行上限，与事件存储保持一致；原生历史里也可能混入超长行。
const MAX_LINE: u64 = 2 * 1024 * 1024;
/// 单个原生历史文件上限。超过就跳过，避免为了列个标题去读几百 MB。
const MAX_FILE: u64 = 256 * 1024 * 1024;

/// 一份原生历史的定位信息：哪个 CLI、哪个原生会话、文件在哪、属于哪个项目。
#[derive(Clone, Serialize, Deserialize)]
pub struct Source {
    /// 该历史由哪个 CLI 产生，决定用哪套解析规则。
    pub provider: Provider,
    /// CLI 自己的会话 id，恢复对话时原样传回去。
    pub native_id: String,
    /// 历史文件的实际路径；只读，绝不改写。
    pub path: PathBuf,
    /// 规范化后的工作区根，用于筛出当前项目的历史。
    pub workspace: String,
}

/// 扫描时的一条候选历史，带上展示与排序所需的附加信息。
struct Candidate {
    /// 定位信息本体。
    source: Source,
    /// 从历史里提取出的标题；提不出时用占位文案。
    title: String,
    /// 文件修改时间（毫秒），用于「最近优先」排序。
    modified: u64,
}
fn home() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or("无法确定用户目录".into())
}
fn roots() -> Result<Vec<(Provider, PathBuf)>, String> {
    let home = home()?;
    let claude = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"));
    let codex = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    Ok(vec![
        (Provider::Claude, claude.join("projects")),
        (Provider::Codex, codex.join("sessions")),
        (Provider::Codex, codex.join("archived_sessions")),
    ])
}
fn same_root(cwd: &str, root: &str) -> bool {
    super::same_workspace_path(cwd, root) || store::workspace(cwd).is_ok_and(|value| value == root)
}
fn files(
    root: &Path,
    depth: usize,
    budget: &mut usize,
    out: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root).map_err(|e| format!("无法读取原生历史目录：{e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        if *budget == 0 {
            return Err("原生历史超过扫描上限，请缩小 CLI 历史目录后重试".into());
        }
        *budget -= 1;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        // 不跟随目录链接，也不进入 Claude 的子代理记录：那些是内部上下文，不该当成会话展示。
        if kind.is_dir() && depth > 0 && entry.file_name() != "subagents" {
            files(&entry.path(), depth - 1, budget, out)?;
        } else if kind.is_file() && entry.path().extension().is_some_and(|x| x == "jsonl") {
            out.push(entry.path());
        }
    }
    Ok(())
}
fn bounded_line(reader: &mut impl BufRead) -> Result<Option<(Value, u64)>, String> {
    let mut bytes = Vec::new();
    let count = reader
        .take(MAX_LINE + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|e| e.to_string())?;
    if count == 0 {
        return Ok(None);
    }
    if count as u64 > MAX_LINE {
        return Err("原生历史单行超过 2 MiB".into());
    }
    // CLI 可能还在写最后一行；原生文件只读，绝不能替它补全或修复。
    if bytes.last() != Some(&b'\n') {
        return Ok(None);
    }
    let value = serde_json::from_slice(&bytes).map_err(|e| format!("原生历史存在损坏记录：{e}"))?;
    Ok(Some((value, count as u64)))
}
fn inspect(path: &Path, provider: Provider, root: &str) -> Result<Option<Candidate>, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_FILE {
        return Ok(None);
    }
    let mut reader = BufReader::new(
        File::open(path)
            .map_err(|e| e.to_string())?
            .take(256 * 1024),
    );
    let mut native = None;
    let mut title = None;
    // Claude 会把自定义标题追加在首条用户消息之后；必须继续扫描，不能拿提示词冒充 CLI 标题。
    let mut custom_title = None;
    let mut belongs = false;
    for _ in 0..64 {
        let Some((value, _)) = bounded_line(&mut reader)? else {
            break;
        };
        if provider == Provider::Codex {
            if value["type"] == "session_meta" {
                let p = &value["payload"];
                if p["source"].is_object() || p["source"] == "subagent" {
                    return Ok(None);
                }
                belongs = p["cwd"].as_str().is_some_and(|cwd| same_root(cwd, root));
                native = p["id"].as_str().map(str::to_owned);
                if !belongs {
                    return Ok(None);
                }
            }
            if value["type"] == "response_item" && value["payload"]["role"] == "user" {
                title = Some(text(&value["payload"]["content"]));
            }
        } else {
            if value["isSidechain"] == true {
                return Ok(None);
            }
            if let Some(cwd) = value["cwd"].as_str() {
                if !same_root(cwd, root) {
                    return Ok(None);
                }
                belongs = true;
                native = value["sessionId"].as_str().map(str::to_owned).or(native);
            }
            if value["type"] == "user" && value["isMeta"] != true && title.is_none() {
                title = Some(text(&value["message"]["content"]));
            }
            if let Some(custom) = value["customTitle"].as_str() {
                custom_title = Some(custom.into());
            }
        }
        if provider == Provider::Codex && belongs && native.is_some() && title.as_ref().is_some_and(|s| !s.trim().is_empty()) {
            break;
        }
    }
    let Some(native_id) = native.filter(|id| store::valid_id(id) && id.len() <= 60) else {
        return Ok(None);
    };
    if !belongs {
        return Ok(None);
    }
    let title = custom_title
        .or(title)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| native_id.clone())
        .lines()
        .next()
        .unwrap_or("会话")
        .chars()
        .take(120)
        .collect();
    Ok(Some(Candidate {
        source: Source {
            provider,
            native_id,
            path: path.into(),
            workspace: root.into(),
        },
        title,
        modified: metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64),
    }))
}
fn source_path(base: &Path, id: &str) -> PathBuf {
    base.join(id).join("native-source.json")
}
pub fn source(base: &Path, id: &str, root: &str) -> Result<Option<Source>, String> {
    let path = source_path(base, id);
    if !path.exists() {
        return Ok(None);
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 64 * 1024 {
        return Err("原生历史引用过大".into());
    }
    let value: Source = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if value.workspace != root || !store::valid_id(&value.native_id) {
        return Err("原生历史项目不匹配".into());
    }
    Ok(Some(value))
}
fn hidden(base: &Path, native: &str, provider: Provider, root: &str) -> bool {
    let path = base
        .join("hidden-native")
        .join(hidden_key(provider, native));
    fs::read_to_string(path).is_ok_and(|v| v == root)
}
/// Forge 的会话主键就是 CLI 原生会话 ID；供应商只用于查重，不能改写 ID。
fn native_key(_provider: Provider, id: &str) -> String { id.to_owned() }
fn binding_key(provider: Provider, id: &str) -> String {
    format!("{}:{id}", if provider == Provider::Codex { "codex" } else { "claude" })
}
fn hidden_key(provider: Provider, id: &str) -> String {
    format!("{}-{id}", if provider == Provider::Codex { "codex" } else { "claude" })
}
pub fn hide(base: &Path, id: &str, root: &str) -> Result<(), String> {
    let meta = Store::metadata(&base.join(id), root)?;
    if let Some(native) = meta.native_id.filter(|id| store::valid_id(id)) {
        let dir = base.join("hidden-native");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        crate::sys::write_atomic(&dir.join(hidden_key(meta.provider, &native)), root)?;
    }
    Ok(())
}
/// 登记惰性镜像，并复用已有的 provider/native-id 绑定。不发提示词、不起进程。
pub fn discover(base: &Path, root: &str) -> Result<(), String> {
    discover_in(base, root, roots()?)
}
fn discover_in(base: &Path, root: &str, roots: Vec<(Provider, PathBuf)>) -> Result<(), String> {
    let mut known = std::collections::HashMap::new();
    for entry in fs::read_dir(base)
        .map_err(|e| e.to_string())?
        .take(20000)
        .flatten()
    {
        if let Ok(meta) = Store::metadata(&entry.path(), root) {
            if let Some(native) = meta.native_id {
                // 旧版 Forge 包装过 native ID；不再复用，重新建立原生 ID 镜像。
                if meta.session_id == native {
                    known.insert(binding_key(meta.provider, &native), meta.session_id);
                }
            }
        }
    }
    let mut budget = 30000;
    for (provider, directory) in roots {
        let mut paths = vec![];
        files(
            &directory,
            if provider == Provider::Claude { 1 } else { 4 },
            &mut budget,
            &mut paths,
        )?;
        for path in paths {
            // 某一份历史损坏不该连累其他历史：跳过它，继续扫下一个。
            let Ok(Some(candidate)) = inspect(&path, provider, root) else {
                continue;
            };
            let source = candidate.source;
            let binding = binding_key(provider, &source.native_id);
            let key = native_key(provider, &source.native_id);
            if hidden(base, &source.native_id, provider, root) {
                continue;
            }
            if let Some(id) = known.get(&binding) {
                if let Ok(Some(old)) = self::source(base, id, root) {
                    if old.path != source.path && !old.path.exists() {
                        save_source(base, id, &source)?;
                    }
                }
                // Claude 的 /rename 会把 customTitle 追加到原生日志；已有镜像也要跟随 CLI 标题。
                if provider == Provider::Claude {
                    if let Ok(_lease) = store::Lease::acquire(&base.join(format!("{id}.lock"))) {
                        if let Ok(mut meta) = Store::metadata(&base.join(id), root) {
                            if meta.title != candidate.title {
                                meta.title = candidate.title.clone();
                                Store { dir: base.join(id), meta, seq: 0, poisoned: false }.save()?;
                            }
                        }
                    }
                }
                // Forge 里已有的会话自己就带运行记录；把原生游标直接放到文件末尾，
                // 否则发现流程会把同样的消息再导入一遍。
                if !source_path(base, id).exists() {
                    if let Ok(_lease) = store::Lease::acquire(&base.join(format!("{id}.lock"))) {
                        let meta = Store::metadata(&base.join(id), root)?;
                        let mut target = Store::open(base, id, root, provider, &meta.title, "")?;
                        let offset = if target.seq == 0 {
                            0
                        } else {
                            complete_offset(&source.path)?
                        };
                        target.append(
                            "native",
                            vec![("history_checkpoint".into(), json!({"offset":offset}))],
                        )?;
                        save_source(base, id, &source)?;
                    }
                }
                continue;
            }
            let _lease = store::Lease::acquire(&base.join(format!("{key}.lock")))?;
            let mut target = Store::open(base, &key, root, provider, &candidate.title, "")?;
            target.bind(source.native_id.clone())?;
            target.meta.created_at = candidate.modified;
            target.save()?;
            save_source(base, &key, &source)?;
            known.insert(binding, key);
        }
    }
    Ok(())
}
fn save_source(base: &Path, id: &str, source: &Source) -> Result<(), String> {
    crate::sys::write_atomic(
        &source_path(base, id),
        &serde_json::to_string(source).map_err(|e| e.to_string())?,
    )
}
fn checkpoint(base: &Path, id: &str) -> Result<u64, String> {
    let path = base.join(id).join("events.jsonl");
    if !path.exists() {
        return Ok(0);
    }
    let mut reader = BufReader::new(File::open(path).map_err(|e| e.to_string())?);
    let mut offset = 0;
    while let Some((event, _)) = bounded_line(&mut reader)? {
        if event["kind"] == "history_checkpoint" {
            offset = event["data"]["offset"].as_u64().ok_or("原生历史游标损坏")?;
        }
    }
    Ok(offset)
}
/// 调用方需持有 `IO_LOCK` 与会话租约；一批事件与检查点合并成一次持久追加。
pub fn sync(base: &Path, id: &str, root: &str) -> Result<bool, String> {
    let Some(source) = source(base, id, root)? else {
        return Ok(false);
    };
    let meta = Store::metadata(&base.join(id), root)?;
    if meta.provider != source.provider || meta.native_id.as_deref() != Some(&source.native_id) {
        return Err("原生历史标识不匹配".into());
    }
    let checked =
        inspect(&source.path, source.provider, root)?.ok_or("原生历史已移动或归属变化")?;
    if checked.source.native_id != source.native_id {
        return Err("原生历史文件被替换".into());
    }
    let mut offset = checkpoint(base, id)?;
    let length = fs::metadata(&source.path).map_err(|e| e.to_string())?.len();
    if length > MAX_FILE || length < offset {
        return Err("原生历史过大或已被截断；保留现有镜像".into());
    }
    let size = complete_offset(&source.path)?;
    if size < offset {
        return Err("原生历史尾部已变化；保留现有镜像".into());
    }
    if size == offset {
        return Ok(false);
    }
    let mut file = File::open(&source.path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file.take(size - offset));
    let mut target = Store::open(base, id, root, meta.provider, &meta.title, "")?;
    let mut batch = vec![];
    let mut bytes = 0;
    let mut scanned = 0;
    let mut projected = 0;
    while let Some((value, count)) = bounded_line(&mut reader)? {
        // 会话与项目归属每一行都重新核对，不能只信第一行。
        if source.provider == Provider::Claude {
            if value["sessionId"]
                .as_str()
                .is_some_and(|s| s != source.native_id)
                || value["cwd"].as_str().is_some_and(|s| !same_root(s, root))
            {
                return Err("原生历史记录归属不一致".into());
            }
        } else if matches!(
            value["type"].as_str(),
            Some("session_meta" | "turn_context")
        ) {
            let p = &value["payload"];
            if p["cwd"].as_str().is_some_and(|cwd| !same_root(cwd, root))
                || value["type"] == "session_meta"
                    && p["id"].as_str() != Some(source.native_id.as_str())
            {
                return Err("原生历史记录归属不一致".into());
            }
        }
        let values = project(source.provider, &value, offset);
        bytes += values
            .iter()
            .map(|(_, v)| v.to_string().len())
            .sum::<usize>();
        projected += values.len();
        scanned += count;
        batch.extend(values);
        offset += count;
        if bytes >= 256 * 1024 || batch.len() >= 128 {
            batch.push(("history_checkpoint".into(), json!({"offset":offset})));
            target.append("native", std::mem::take(&mut batch))?;
            bytes = 0;
        }
        if projected >= 500 || scanned >= 4 * 1024 * 1024 {
            break;
        }
    }
    batch.push(("history_checkpoint".into(), json!({"offset":offset})));
    target.append("native", batch)?;
    Ok(offset < size)
}
fn complete_offset(path: &Path) -> Result<u64, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    let start = length.saturating_sub(MAX_LINE);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut tail = Vec::new();
    file.take(MAX_LINE)
        .read_to_end(&mut tail)
        .map_err(|e| e.to_string())?;
    match tail.iter().rposition(|b| *b == b'\n') {
        Some(i) => Ok(start + i as u64 + 1),
        None if start > 0 => Err("原生历史末行超过 2 MiB".into()),
        None => Ok(0),
    }
}
/// 跳过刚刚被 Forge 记录过的那段原生内容，避免同一轮消息显示两遍。
pub fn mark_current(target: &mut Store, base: &Path) -> Result<(), String> {
    let Some(source) = source(base, &target.meta.session_id, &target.meta.workspace)? else {
        return Ok(());
    };
    if source.path.exists() {
        let offset = complete_offset(&source.path)?;
        target.append(
            "native",
            vec![("history_checkpoint".into(), json!({"offset":offset}))],
        )?;
    }
    Ok(())
}
fn text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.into();
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| {
            matches!(
                v["type"].as_str(),
                Some("text" | "input_text" | "output_text")
            )
        })
        .filter_map(|v| v["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}
fn project(provider: Provider, value: &Value, offset: u64) -> Vec<(String, Value)> {
    let mut out = vec![];
    let id = format!("native-{offset}");
    if provider == Provider::Claude {
        if value["isSidechain"] == true || value["isMeta"] == true {
            return out;
        }
        let message = &value["message"];
        match value["type"].as_str().unwrap_or("") {
            "user" | "assistant" => {
                let body = text(&message["content"]);
                if !body.is_empty() {
                    out.push((
                        if value["type"] == "user" {
                            "user"
                        } else {
                            "message"
                        }
                        .into(),
                        json!({"id":value["uuid"].as_str().or_else(|| message["id"].as_str()).unwrap_or(&id),"text":body}),
                    ));
                }
                let blocks = message["content"].as_array().map(Vec::as_slice).unwrap_or_default();
                let result_count = blocks.iter().filter(|block| block["type"] == "tool_result").count();
                for (index, block) in blocks.iter().enumerate() {
                    match block["type"].as_str().unwrap_or("") {
                        "thinking" => out.push(("reasoning".into(), json!({"id":format!("{id}-{index}"),"text":block["thinking"]}))),
                        "tool_use" => out.push(("tool".into(), json!({"id":block["id"],"name":block["name"],"input":block["input"],"status":"recorded"}))),
                        "tool_result" => out.push(("tool".into(), json!({"id":block["tool_use_id"],"output":block["content"],"result":super::structured_tool_result(value.get("toolUseResult").or_else(|| value.get("tool_use_result")), block["tool_use_id"].as_str().unwrap_or_default(), result_count),"status":if block["is_error"]==true {"failed"} else {"completed"}}))),
                        _ => {}
                    }
                }
                if value["type"] == "assistant" {
                    if let Some(model) = message["model"].as_str() {
                        out.push(("configuration".into(), json!({"model":model})));
                    }
                    if message["usage"].is_object() {
                        out.push(("usage".into(), message["usage"].clone()));
                    }
                }
            }
            "system" if value["subtype"] == "compact_boundary" => out.push((
                "compaction".into(),
                json!({"text":"","metadata":value["compactMetadata"]}),
            )),
            _ => {}
        }
    } else {
        let p = &value["payload"];
        match value["type"].as_str().unwrap_or("") {
            "response_item" => match p["type"].as_str().unwrap_or("") {
                "message" if p["role"] == "user" || p["role"] == "assistant" => {
                    let body = text(&p["content"]);
                    if !body.is_empty() { out.push((if p["role"] == "user" {"user"} else {"message"}.into(), json!({"id":p["id"].as_str().unwrap_or(&id),"text":body}))); }
                }
                "function_call" | "custom_tool_call" => out.push(("tool".into(), json!({"id":p["call_id"],"name":p["name"],"input":p.get("arguments").or_else(|| p.get("input")),"status":"recorded"}))),
                "function_call_output" | "custom_tool_call_output" => {
                    // rollout 的旧输出通常没有成功标志；缺失时只能记为 recorded，不能把失败补丁算成已写入。
                    let status = match p["status"].as_str() {
                        Some("completed" | "success") => "completed",
                        Some("failed" | "error") => "failed",
                        _ => "recorded",
                    };
                    out.push(("tool".into(), json!({"id":p["call_id"],"output":p["output"],"status":status})))
                },
                "reasoning" => {
                    let summary = p["summary"].as_array().into_iter().flatten().filter_map(|s| s["text"].as_str()).collect::<Vec<_>>().join("\n");
                    if !summary.is_empty() { out.push(("reasoning".into(), json!({"id":id,"text":summary}))); }
                }
                _ => {}
            },
            "turn_context" => out.push(("configuration".into(), json!({"model":p["model"],"effort":p["effort"]}))),
            "compacted" => out.push(("compaction".into(), json!({"text":p["message"].as_str().unwrap_or("")}))),
            "event_msg" if p["type"] == "token_count" => {
                let info=&p["info"]; let last=&info["last_token_usage"]; let total=&info["total_token_usage"];
                out.push(("usage".into(), json!({"tokenUsage":{"last":{"inputTokens":last["input_tokens"],"outputTokens":last["output_tokens"],"cachedInputTokens":last["cached_input_tokens"],"reasoningOutputTokens":last["reasoning_output_tokens"],"totalTokens":last["total_tokens"]},"total":{"totalTokens":total["total_tokens"]},"modelContextWindow":info["model_context_window"]}})));
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::store::Window;
    #[test]
    fn projects_only_public_native_messages_and_never_replays_permissions() {
        let events = project(
            Provider::Claude,
            &json!({"type":"assistant","message":{"id":"m","content":[{"type":"thinking","thinking":"public"},{"type":"redacted_thinking","data":"secret"},{"type":"tool_use","id":"t","name":"Bash","input":{"command":"echo hi"}}]}}),
            0,
        );
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, "reasoning");
        assert_eq!(events[1].0, "tool");
        assert!(project(
            Provider::Claude,
            &json!({"type":"control_request","request_id":"bad"}),
            0
        )
        .is_empty());
        let events = project(
            Provider::Codex,
            &json!({"type":"response_item","payload":{"type":"reasoning","summary":[{"text":"public"}],"encrypted_content":"secret"}}),
            0,
        );
        assert_eq!(events[0].1["text"], "public");
        assert!(!events[0].1.to_string().contains("secret"));
        let recorded = project(Provider::Codex, &json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"patch","output":"unknown"}}), 0);
        let failed = project(Provider::Codex, &json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"patch","output":"denied","status":"failed"}}), 0);
        assert_eq!(recorded[0].1["status"], "recorded");
        assert_eq!(failed[0].1["status"], "failed");
    }
    #[test]
    fn discovery_sync_continuation_and_hiding_are_project_scoped() {
        let temp = std::env::temp_dir().join(format!(
            "forge-history-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = temp.join("project");
        let other = temp.join("other");
        let base = temp.join("mirror");
        let native = temp.join("native");
        for p in [&root, &other, &base, &native] {
            fs::create_dir_all(p).unwrap();
        }
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let path = native.join("test.jsonl");
        let content = format!(
            "{}\n{}\n",
            json!({"type":"session_meta","payload":{"id":"test-session","cwd":root,"source":"cli"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello 中文"}]}})
        );
        fs::write(&path, &content).unwrap();
        discover_in(&base, &workspace, vec![(Provider::Codex, native.clone())]).unwrap();
        let id = "test-session";
        sync(&base, id, &workspace).unwrap();
        sync(&base, id, &workspace).unwrap();
        let page = Store::page(&base, id, &workspace, Window::After(0), 500, false).unwrap();
        assert_eq!(page.events.iter().filter(|e| e.kind == "user").count(), 1);
        assert_eq!(page.native_id.as_deref(), Some("test-session"));
        let extra = format!(
            "{}\n",
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"reply"}]}})
        );
        fs::write(&path, format!("{content}{extra}")).unwrap();
        sync(&base, id, &workspace).unwrap();
        let page = Store::page(&base, id, &workspace, Window::After(0), 500, false).unwrap();
        assert_eq!(
            page.events.iter().filter(|e| e.kind == "message").count(),
            1
        );
        hide(&base, id, &workspace).unwrap();
        fs::remove_dir_all(base.join(id)).unwrap();
        discover_in(&base, &workspace, vec![(Provider::Codex, native.clone())]).unwrap();
        assert!(!base.join(id).exists());
        let other_workspace = store::workspace(other.to_str().unwrap()).unwrap();
        discover_in(&base, &other_workspace, vec![(Provider::Codex, native)]).unwrap();
        assert!(!base.join(id).exists());
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            format!("{content}{extra}")
        );
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn claude_mirroring_is_bounded_and_resumes_after_an_incomplete_tail() {
        let temp = std::env::temp_dir().join(format!(
            "forge-claude-history-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = temp.join("project");
        let base = temp.join("mirror");
        let native = temp.join("native");
        for p in [&root, &base, &native] {
            fs::create_dir_all(p).unwrap();
        }
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let path = native.join("claude.jsonl");
        let mut content = String::new();
        for i in 0..600 {
            content.push_str(&format!("{}\n",json!({"type":"user","cwd":root,"sessionId":"claude-session","uuid":format!("u-{i}"),"message":{"content":format!("message-{i}")}})));
        }
        fs::write(&path, format!("{content}{{\"type\":")).unwrap();
        discover_in(&base, &workspace, vec![(Provider::Claude, native)]).unwrap();
        let id = "claude-session";
        assert!(sync(&base, id, &workspace).unwrap());
        assert!(!sync(&base, id, &workspace).unwrap());
        let mut after = 0;
        let mut users = 0;
        loop {
            let page = Store::page(&base, id, &workspace, Window::After(after), 500, false).unwrap();
            users += page.events.iter().filter(|e| e.kind == "user").count();
            after = page.next_seq;
            if !page.has_more {
                break;
            }
        }
        assert_eq!(users, 600);
        let last = json!({"type":"assistant","cwd":root,"sessionId":"claude-session","uuid":"last","message":{"id":"m","content":[{"type":"text","text":"done"}]}});
        fs::write(&path, format!("{content}{last}\n")).unwrap();
        assert!(!sync(&base, id, &workspace).unwrap());
        let page = Store::page(&base, id, &workspace, Window::After(after), 500, false).unwrap();
        assert_eq!(
            page.events.iter().filter(|e| e.kind == "message").count(),
            1
        );
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            format!("{content}{last}\n")
        );
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn claude_custom_title_overrides_the_first_user_message() {
        let temp = std::env::temp_dir().join(format!(
            "forge-claude-title-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = temp.join("project");
        let base = temp.join("mirror");
        let native = temp.join("native");
        for path in [&root, &base, &native] { fs::create_dir_all(path).unwrap(); }
        let path = native.join("claude.jsonl");
        fs::write(
            &path,
            format!(
                "{}\n{}\n",
                json!({"type":"user","cwd":root,"sessionId":"claude-title-session","message":{"content":"first prompt"}}),
                json!({"type":"system","cwd":root,"sessionId":"claude-title-session","customTitle":"CLI title"})
            ),
        )
        .unwrap();

        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        discover_in(&base, &workspace, vec![(Provider::Claude, native.clone())]).unwrap();
        let first = Store::metadata(&base.join("claude-title-session"), &workspace).unwrap();
        assert_eq!(first.title, "CLI title");
        fs::write(
            &path,
            format!(
                "{}\n{}\n{}\n",
                json!({"type":"user","cwd":root,"sessionId":"claude-title-session","message":{"content":"first prompt"}}),
                json!({"type":"system","cwd":root,"sessionId":"claude-title-session","customTitle":"CLI title"}),
                json!({"type":"system","cwd":root,"sessionId":"claude-title-session","customTitle":"Renamed in CLI"})
            ),
        )
        .unwrap();
        discover_in(&base, &workspace, vec![(Provider::Claude, native)]).unwrap();
        let renamed = Store::metadata(&base.join("claude-title-session"), &workspace).unwrap();
        assert_eq!(renamed.title, "Renamed in CLI");
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn partial_tail_is_left_untouched_and_oversize_is_rejected() {
        assert!(bounded_line(&mut std::io::Cursor::new(b"{\"type\":"))
            .unwrap()
            .is_none());
        assert!(
            bounded_line(&mut std::io::Cursor::new(vec![b'x'; MAX_LINE as usize + 1])).is_err()
        );
    }
}
