//! Read-only native history adapters. Only Forge's own mirror/checkpoints are written.
//! CLI 原生历史只读：只有 Forge 自己的镜像与会话检查点会被写入。
use super::store::{self, Store};
use crate::ai_cli::Provider;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 单行上限，与事件存储保持一致；原生历史里也可能混入超长行。
const MAX_LINE: u64 = 2 * 1024 * 1024;
/// 单个原生历史文件上限。超过就跳过，避免为了列个标题去读几百 MB。
const MAX_FILE: u64 = 256 * 1024 * 1024;
/// 历史投影检查点只是可重建缓存；卡住大小，坏文件直接退回事件日志重建。
const MAX_CHECKPOINT_BYTES: u64 = 16 * 1024 * 1024;
const CHECKPOINT_VERSION: u32 = 1;

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
    /// 从历史里提取出的标题；提不出时为空字符串，由界面显示「未命名会话」。
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
/// 早期 Forge 新建会话时把「Claude Code 会话 3」这类占位名写进了 CLI 原生历史
/// （Claude 走 `--name`，Codex 走 `thread/name/set`）。它占着最高优先级，
/// 真正的自动标题永远压不过它，所以识别出来一律忽略。
pub fn is_placeholder_title(text: &str) -> bool {
    static PLACEHOLDER: OnceLock<Regex> = OnceLock::new();
    let pattern = PLACEHOLDER.get_or_init(|| {
        Regex::new(r"(?i)^(claude code|codex)\s+(会话|會話|工作階段|工作阶段|session)\s*\d+$")
            .expect("占位标题的模式必须能编译")
    });
    pattern.is_match(text.trim())
}

/// 会话自动标题：首条真人消息压成一行短标题，两个来源（发送时落库、原生历史解析）
/// 共用同一套规则，否则列表每刷新一次就换一种写法。
/// 取第一个非空行、折叠空白；超过 30 个字符时先按第一句断开，其次断在空格上，
/// 都没有才硬切（按字符计，中文不切半）。
pub fn auto_title(text: &str) -> Option<String> {
    const MAX: usize = 30;
    let collapsed = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let chars = collapsed.chars().collect::<Vec<_>>();
    if chars.len() <= MAX {
        return Some(collapsed);
    }
    if let Some(end) = chars[..MAX].iter().position(|c| matches!(c, '。' | '！' | '？' | '；')) {
        return Some(chars[..=end].iter().collect());
    }
    // 断点太靠前的空格不算（否则标题只剩一两个词）。
    let end = chars[..MAX]
        .iter()
        .rposition(|c| matches!(c, ' ' | ',' | '，' | '、'))
        .filter(|index| *index + 1 >= MAX / 3)
        .unwrap_or(MAX);
    let title = chars[..end].iter().collect::<String>();
    let title = title.trim();
    (!title.is_empty()).then(|| title.to_owned())
}

/// Claude 的标题记录。用户的 `/rename` 和 CLI 自动标题都按追加写，最新一条生效。
fn capture_titles(value: &Value, custom: &mut Option<String>, ai: &mut Option<String>) {
    if let Some(text) = value["customTitle"].as_str().filter(|text| !text.trim().is_empty() && !is_placeholder_title(text)) {
        *custom = Some(text.to_owned());
    }
    if let Some(text) = value["aiTitle"].as_str().filter(|text| !text.trim().is_empty() && !is_placeholder_title(text)) {
        *ai = Some(text.to_owned());
    }
}
/// 长会话的改名记录追加在文件末尾，头部窗口看不到；只补读尾部这一段，
/// 保持「列表发现不整份读」的边界。起点落在半行上时丢掉第一段。
fn capture_tail_titles(path: &Path, custom: &mut Option<String>, ai: &mut Option<String>) {
    const TAIL: u64 = 64 * 1024;
    let Ok(mut file) = File::open(path) else {
        return;
    };
    let Ok(length) = file.metadata().map(|meta| meta.len()) else {
        return;
    };
    let start = length.saturating_sub(TAIL);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut bytes = Vec::new();
    if file.take(TAIL).read_to_end(&mut bytes).is_err() {
        return;
    }
    let text = String::from_utf8_lossy(&bytes);
    let body = if start == 0 {
        text.as_ref()
    } else {
        text.split_once('\n').map_or("", |(_, rest)| rest)
    };
    for line in body.lines() {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            capture_titles(&value, custom, ai);
        }
    }
}
/// Codex 把线程名单独写在 `session_index.jsonl`：在 Codex CLI 里改名只追加这一行，
/// rollout 文件本身不变，所以只看历史文件永远读不到新标题。同一个 id 后写覆盖先写。
fn codex_thread_names(codex_home: &Path) -> HashMap<String, String> {
    let Ok(file) = File::open(codex_home.join("session_index.jsonl")) else {
        return HashMap::new();
    };
    let mut names = HashMap::new();
    for line in BufReader::new(file).lines().take(20000).flatten() {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let (Some(id), Some(name)) = (value["id"].as_str(), value["thread_name"].as_str()) else {
            continue;
        };
        let name = name.trim();
        if !id.is_empty() && !name.is_empty() && !is_placeholder_title(name) {
            names.insert(id.to_owned(), name.chars().take(120).collect());
        }
    }
    names
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
    // Claude 会把自定义标题和 CLI 生成的标题追加在首条用户消息之后；必须继续扫描，
    // 不能拿提示词冒充 CLI 标题。两个字段都可能重复写，各自后写覆盖先写。
    let mut custom_title = None;
    let mut ai_title = None;
    let mut belongs = false;
    let mut head_bytes = 0u64;
    for _ in 0..64 {
        let Some((value, count)) = bounded_line(&mut reader)? else {
            break;
        };
        head_bytes += count;
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
            if value["type"] == "response_item" && value["payload"]["role"] == "user" && title.is_none() {
                // 标题只认真人说的话：Codex 的第一条 user 记录往往就是它自己注入的
                // 「# AGENTS.md instructions」，拿它当标题就会在会话列表里挂一条系统提示词。
                title = human_text(&text(&value["payload"]["content"]));
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
                // 压缩续篇摘要（isCompactSummary）是机器生成的上下文说明，任务通知也一样：
                // 都不拿当标题素材，继续往下找真人说的那一句。
                if value["isCompactSummary"] != true {
                    title = human_text(&text(&value["message"]["content"]));
                }
            }
            capture_titles(&value, &mut custom_title, &mut ai_title);
        }
        if provider == Provider::Codex && belongs && native.is_some() && title.as_ref().is_some_and(|s| !s.trim().is_empty()) {
            break;
        }
    }
    // 头部已经读到文件尾就不用再补读；没读到的部分才是改名可能落下的位置。
    if provider == Provider::Claude && head_bytes < metadata.len() {
        capture_tail_titles(path, &mut custom_title, &mut ai_title);
    }
    let Some(native_id) = native.filter(|id| store::valid_id(id) && id.len() <= 60) else {
        return Ok(None);
    };
    if !belongs {
        return Ok(None);
    }
    // 用户改过的标题（Claude 的 /rename）优先，其次 CLI 自己生成的标题，
    // 最后才是首条真人消息。都提不出来就留空，不再拿 UUID 冒充标题。
    // 三种来源都过 auto_title，与发送时落的自动标题同一种写法。
    let title = custom_title
        .or(ai_title)
        .or(title)
        .and_then(|text| auto_title(&text))
        .unwrap_or_default();
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
                // 绑定按原生 ID 认人。Forge 自建会话的目录名是客户端 UUID，线程要等首条
                // 消息才建出来，绑上之后两者必然不同——不登记就会在下一条消息后多出一份重复镜像。
                // 旧版包装过 ID 的目录可能仍和真实 ID 目录并存，那种情况让名字等于原生 ID 的那个赢。
                let key = binding_key(meta.provider, &native);
                if meta.session_id == native || !known.contains_key(&key) {
                    known.insert(key, meta.session_id);
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
        // 索引在 CODEX_HOME 根下，两个 sessions 目录共享同一份，读一次就够。
        let codex_names = if provider == Provider::Codex {
            directory.parent().map(codex_thread_names).unwrap_or_default()
        } else {
            HashMap::new()
        };
        for path in paths {
            // 某一份历史损坏不该连累其他历史：跳过它，继续扫下一个。
            let Ok(Some(mut candidate)) = inspect(&path, provider, root) else {
                // Codex 的子代理 rollout（source.subagent）会被 inspect 跳过；
                // 父镜像存在时把它导入成子会话。
                if provider == Provider::Codex {
                    import_codex_subagent(base, &path, root, &known);
                }
                continue;
            };
            // 标题到底出自线程名，决定已有镜像跟不跟着改（下面 follows 用）。
            let mut title_from_thread_name = false;
            if let Some(name) = codex_names.get(&candidate.source.native_id) {
                // 早期 Forge 把整条首条消息原样写成了线程名，这种名字按 auto_title 收窄就行；
                // 从首条消息标题起不来的（用户在 CLI 里自己改的）原样保留，一个字不动。
                if candidate.title.is_empty() || !name.starts_with(&candidate.title) {
                    candidate.title = name.clone();
                    title_from_thread_name = true;
                }
            }
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
                // Codex 的线程名以 session_index.jsonl 为准（在 CLI 里改名不会改 rollout）。
                // 非人话的旧标题（早期版本把注入的 AGENTS.md 指令存成了标题）也要纠正。
                // 用户手动改过并锁定过的标题，任何自动同步都不覆盖。
                if let Ok(_lease) = store::Lease::acquire(&base.join(format!("{id}.lock"))) {
                    if let Ok(mut meta) = Store::metadata(&base.join(id), root) {
                        // 占位名、原生 ID 当标题、剥完注入不剩人话的旧标题，都是早期版本自己写坏的，
                        // 不是用户起的名字，必须让位给自动标题。
                        // 已经加锁的用户标题一律不动；没锁但明显是同一条首句消息换过写法截出来的
                        // （旧版本按 60 / 120 字硬截），也按自动标题纠正——人自己起的名字对不上这个形状。
                        let follows = !meta.title_locked
                            && (provider == Provider::Claude
                                || meta.title == source.native_id
                                || is_placeholder_title(&meta.title)
                                || human_text(&meta.title).is_none()
                                || title_from_thread_name
                                || (!candidate.title.is_empty()
                                    && auto_title(&meta.title).as_deref() == Some(candidate.title.as_str())));
                        if follows && meta.title != candidate.title {
                            meta.title = candidate.title.clone();
                            Store { dir: base.join(id), meta, seq: 0, poisoned: false }.save()?;
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
                if provider == Provider::Claude {
                    import_claude_subagents(base, id, &source.path, &source.native_id, root);
                }
                continue;
            }
            let _lease = store::Lease::acquire(&base.join(format!("{key}.lock")))?;
            let mut target = Store::open(base, &key, root, provider, &candidate.title, "")?;
            target.bind(source.native_id.clone())?;
            target.meta.created_at = candidate.modified;
            target.save()?;
            save_source(base, &key, &source)?;
            known.insert(binding, key.clone());
            if provider == Provider::Claude {
                import_claude_subagents(base, &key, &source.path, &source.native_id, root);
            }
        }
    }
    Ok(())
}

/// 子代理文件里的行都是它自己的对话（`isSidechain:true` 只是标记）；投影时剥掉
/// 标记复用主解析器，其余规则（meta 过滤、工具配对）与父会话完全一致。
fn project_sidechain(provider: Provider, value: &Value, offset: u64, projection: &mut ProjectionState) -> Vec<(String, Value)> {
    if provider == Provider::Claude && value["isSidechain"] == true {
        let mut stripped = value.clone();
        if let Some(object) = stripped.as_object_mut() { object.remove("isSidechain"); }
        return project_with_state(provider, &stripped, offset, projection);
    }
    project_with_state(provider, value, offset, projection)
}

/// 导入 Claude 的 `subagents/agent-*.jsonl`：每个文件是一个子代理的完整对话，
/// 同名 `.meta.json` 带归属（toolUseId/agentType/description/finished）。
/// 子会话 id 与 live 路由用同一规则派生，目录已存在（正在运行或已导入）就跳过。
fn import_claude_subagents(base: &Path, parent_id: &str, native_path: &Path, native_id: &str, root: &str) {
    let Some(project_dir) = native_path.parent() else { return };
    let dir = project_dir.join(native_id).join("subagents");
    let Ok(entries) = fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.extension().is_some_and(|extension| extension == "jsonl") { continue; }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("agent-") { continue; }
        if fs::metadata(&path).map(|meta| meta.len() > MAX_FILE).unwrap_or(true) { continue; }
        let agent_id = name.trim_start_matches("agent-").trim_end_matches(".jsonl").to_owned();
        if agent_id.is_empty() { continue; }
        let info: Value = fs::read(path.with_file_name(format!("agent-{agent_id}.meta.json")))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or(Value::Null);
        let key = info["toolUseId"].as_str().filter(|value| !value.is_empty()).unwrap_or(&agent_id).to_owned();
        let child = super::child_session_id(parent_id, &key);
        if base.join(&child).exists() { continue; }
        let title = info["description"].as_str().map(str::trim).filter(|text| !text.is_empty()).unwrap_or("子代理").to_owned();
        let Ok(mut target) = Store::open(base, &child, root, Provider::Claude, &title, "") else { continue };
        let modified = fs::metadata(&path).and_then(|meta| meta.modified()).ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |duration| duration.as_millis() as u64);
        target.meta.parent_session_id = Some(parent_id.to_owned());
        target.meta.agent = Some(store::AgentInfo {
            native_agent_id: Some(agent_id.clone()),
            agent_type: info["agentType"].as_str().map(str::to_owned),
            title: title.clone(),
            tool_id: key.clone(),
            model: None,
            status: if info["finished"] == true { "completed".into() } else { "stopped".into() },
            started_at: modified,
            ended_at: None,
        });
        let _ = target.save();
        let Ok(file) = File::open(&path) else { continue };
        let mut reader = BufReader::new(file);
        let mut projection = ProjectionState::default();
        let mut batch = vec![];
        let mut lines = 0u64;
        while let Ok(Some((value, _))) = bounded_line(&mut reader) {
            // 子代理文件里每行的 sessionId 仍是父会话；对不上说明这不是它的记录。
            if value["sessionId"].as_str().is_some_and(|session| session != native_id) { continue; }
            batch.extend(project_sidechain(Provider::Claude, &value, lines, &mut projection));
            lines += 1;
            if batch.len() >= 128 {
                if target.append("native", std::mem::take(&mut batch)).is_err() { break; }
            }
            if lines >= 20000 { break; }
        }
        let _ = target.append("native", batch);
        let _ = target.append("native", vec![("agent".into(), json!({"key":key,"status":"completed","imported":true}))]);
    }
}

/// 导入 Codex 的子代理 rollout（`session_meta.source.subagent`）。文件头部带一份父
/// 历史副本（fork_turns=all），真正的子代理内容在第二条 session_meta 之后；只在父
/// 镜像已存在、子会话目录还没建过时导入。头部预算与 inspect 一致。
fn import_codex_subagent(base: &Path, path: &Path, root: &str, known: &std::collections::HashMap<String, String>) {
    let Ok(file) = File::open(path) else { return };
    let mut reader = BufReader::new(file.take(256 * 1024));
    let mut first_meta: Option<(String, String)> = None;
    let mut child_meta: Option<(Value, u64)> = None;
    let mut scanned = 0u64;
    while let Ok(Some((value, count))) = bounded_line(&mut reader) {
        if value["type"] == "session_meta" {
            let p = &value["payload"];
            if first_meta.is_none() {
                first_meta = Some((p["id"].as_str().unwrap_or_default().to_owned(), p["cwd"].as_str().unwrap_or_default().to_owned()));
            }
            let spawn = &p["source"]["subagent"]["thread_spawn"];
            if !spawn.is_null() || p["source"] == "subagent" || p["thread_source"] == "subagent" {
                child_meta = Some((p.clone(), scanned + count));
                break;
            }
        }
        scanned += count;
        if scanned > 256 * 1024 { return; }
    }
    let Some((meta, body_start)) = child_meta else { return };
    let Some((parent_native, cwd)) = first_meta else { return };
    if !same_root(&cwd, root) { return; }
    let spawn = &meta["source"]["subagent"]["thread_spawn"];
    let Some(child_id) = meta["id"].as_str().filter(|id| !id.is_empty()) else { return };
    let Some(parent_forge) = known.get(&binding_key(Provider::Codex, &parent_native)) else { return };
    if spawn["parent_thread_id"].as_str().is_some_and(|id| id != parent_native) { return; }
    let child = super::child_session_id(parent_forge, child_id);
    if base.join(&child).exists() { return; }
    let agent_path = spawn["agent_path"].as_str().unwrap_or_default().to_owned();
    let title = if agent_path.is_empty() { "子代理".to_owned() } else { agent_path.trim_start_matches("/root/").to_owned() };
    let Ok(mut target) = Store::open(base, &child, root, Provider::Codex, &title, "") else { return };
    target.meta.parent_session_id = Some(parent_forge.clone());
    target.meta.agent = Some(store::AgentInfo {
        native_agent_id: (!agent_path.is_empty()).then(|| agent_path.clone()),
        agent_type: spawn["agent_nickname"].as_str().map(str::to_owned),
        title: title.clone(),
        tool_id: child_id.to_owned(),
        model: None,
        status: "stopped".into(),
        started_at: 0,
        ended_at: None,
    });
    let _ = target.save();
    let Ok(mut file) = File::open(path) else { return };
    if file.seek(SeekFrom::Start(body_start)).is_err() { return; }
    let length = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    let mut reader = BufReader::new(file.take((length - body_start).min(MAX_FILE)));
    let mut projection = ProjectionState::default();
    let mut batch = vec![];
    let mut lines = 0u64;
    let mut answered = false;
    while let Ok(Some((value, _))) = bounded_line(&mut reader) {
        if value["type"] == "session_meta" {
            // 子代理自己的 meta 已经消费过；出现新 meta 说明文件形状与预期不符。
            continue;
        }
        if value["payload"]["type"].as_str() == Some("agent_message")
            && value["payload"]["content"].to_string().contains("FINAL_ANSWER") {
            answered = true;
        }
        batch.extend(project_with_state(Provider::Codex, &value, lines, &mut projection));
        lines += 1;
        if batch.len() >= 128 {
            if target.append("native", std::mem::take(&mut batch)).is_err() { break; }
        }
        if lines >= 20000 { break; }
    }
    let _ = target.append("native", batch);
    if answered {
        if let Some(info) = target.meta.agent.as_mut() { info.status = "completed".into(); }
        let _ = target.save();
    }
    let _ = target.append("native", vec![("agent".into(), json!({"key":child_id,"status":if answered {"completed"} else {"stopped"},"imported":true}))]);
}
fn save_source(base: &Path, id: &str, source: &Source) -> Result<(), String> {
    crate::sys::write_atomic(
        &source_path(base, id),
        &serde_json::to_string(source).map_err(|e| e.to_string())?,
    )
}
#[derive(Default, Serialize, Deserialize)]
struct ProjectionState {
    pending_task_creates: HashMap<String, Value>,
}

/// 原生游标之外还要保留跨批投影状态；否则 TaskCreate 与结果分属两批时会丢关联。
/// `mirror_length` 让下一次同步只重放 Forge 日志新增的尾巴，而不是每批从 0 扫描。
#[derive(Serialize, Deserialize)]
struct HistoryCheckpoint {
    version: u32,
    session_id: String,
    mirror_length: u64,
    source_offset: u64,
    projection: ProjectionState,
}

fn checkpoint_path(base: &Path, id: &str) -> PathBuf {
    base.join(id).join("history.idx")
}

fn read_checkpoint(base: &Path, id: &str, mirror_length: u64) -> Option<HistoryCheckpoint> {
    let path = checkpoint_path(base, id);
    if fs::metadata(&path).ok()?.len() > MAX_CHECKPOINT_BYTES {
        return None;
    }
    let value: HistoryCheckpoint = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (value.version == CHECKPOINT_VERSION
        && value.session_id == id
        && value.mirror_length <= mirror_length)
        .then_some(value)
}

fn checkpoint(base: &Path, id: &str) -> Result<(u64, ProjectionState), String> {
    let path = base.join(id).join("events.jsonl");
    if !path.exists() {
        return Ok((0, ProjectionState::default()));
    }
    let mirror_length = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let cached = read_checkpoint(base, id, mirror_length);
    let (start, mut offset, mut state) = cached
        .map(|value| (value.mirror_length, value.source_offset, value.projection))
        .unwrap_or_else(|| (0, 0, ProjectionState::default()));
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    while let Some((event, _)) = bounded_line(&mut reader)? {
        if event["kind"] == "history_checkpoint" {
            offset = event["data"]["offset"].as_u64().ok_or("原生历史游标损坏")?;
        }
        if event["kind"] == "tool" {
            let data = &event["data"];
            if let Some(id) = data["id"].as_str() {
                if data["name"] == "TaskCreate" {
                    state
                        .pending_task_creates
                        .insert(id.to_owned(), data.clone());
                } else if data.get("output").is_some() {
                    // 工具结果已经消费了这次创建；无论是否成功提取真实 ID，都不能串到后续结果。
                    state.pending_task_creates.remove(id);
                }
            }
        }
    }
    Ok((offset, state))
}

fn save_checkpoint(
    base: &Path,
    id: &str,
    source_offset: u64,
    projection: &ProjectionState,
) -> Result<(), String> {
    let mirror_length = fs::metadata(base.join(id).join("events.jsonl"))
        .map_err(|e| e.to_string())?
        .len();
    let value = HistoryCheckpoint {
        version: CHECKPOINT_VERSION,
        session_id: id.to_owned(),
        mirror_length,
        source_offset,
        projection: ProjectionState {
            pending_task_creates: projection.pending_task_creates.clone(),
        },
    };
    let text = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    if text.len() as u64 > MAX_CHECKPOINT_BYTES {
        return Err("原生历史检查点超过容量上限".into());
    }
    crate::sys::write_atomic(&checkpoint_path(base, id), &text)
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
    let (mut offset, mut projection) = checkpoint(base, id)?;
    let length = fs::metadata(&source.path).map_err(|e| e.to_string())?.len();
    if length > MAX_FILE || length < offset {
        return Err("原生历史过大或已被截断；保留现有镜像".into());
    }
    let size = complete_offset(&source.path)?;
    if size < offset {
        return Err("原生历史尾部已变化；保留现有镜像".into());
    }
    if size == offset {
        // 旧版本没有旁路检查点：首次重建后也要落缓存，否则已同步完的长会话每次打开仍会全扫。
        let _ = save_checkpoint(base, id, offset, &projection);
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
        let values = project_with_state(source.provider, &value, offset, &mut projection);
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
    // 缓存写失败不改变同步结果：事件日志仍是事实源，下次只会退回全量重建一次。
    let _ = save_checkpoint(base, id, offset, &projection);
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
/// 运行开始前的原生边界，用于限定本轮摘要，避免旧摘要串到新压缩上。
pub fn summary_offset(target: &Store) -> Result<u64, String> {
    let base = target.dir.parent().ok_or("会话路径无效")?;
    match source(base, &target.meta.session_id, &target.meta.workspace)? {
        Some(source) if source.path.exists() => complete_offset(&source.path),
        _ => Ok(0),
    }
}

/// 运行中有新完整行才补采；调用者持有会话租约和 IO_LOCK。
pub fn poll_summaries(target: &mut Store, previous: &mut u64) -> Result<Vec<super::events::Event>, String> {
    let base = target.dir.parent().ok_or("会话路径无效")?;
    let Some(source) = source(base, &target.meta.session_id, &target.meta.workspace)? else { return Ok(vec![]); };
    let offset = complete_offset(&source.path)?;
    if offset == *previous { return Ok(vec![]); }
    let (events, more) = recover_summaries(target, &source, false)?;
    if !more { *previous = offset; }
    Ok(events)
}
/// 跳过刚刚被 Forge 记录过的那段原生内容，避免同一轮消息显示两遍。
pub fn mark_current(target: &mut Store, base: &Path) -> Result<Vec<super::events::Event>, String> {
    let Some(source) = source(base, &target.meta.session_id, &target.meta.workspace)? else {
        return Ok(vec![]);
    };
    if source.path.exists() {
        let offset = complete_offset(&source.path)?;
        // 收尾一次扫描补齐摘要，不按批重复读取整份事件日志和检查点。
        let (mut events, _) = recover_summaries(target, &source, true)?;
        events.extend(target.append(
            "native",
            vec![("history_checkpoint".into(), json!({"offset":offset}))],
        )?);
        return Ok(events);
    }
    Ok(vec![])
}

/// 摘要有独立游标：实时协议不保证携带正文，不能跟随普通历史游标跳到 EOF。
/// 调用方持有会话租约和 IO_LOCK；只消费完整行，失败时不提交扫描进度。
fn recover_summaries(target: &mut Store, source: &Source, complete: bool) -> Result<(Vec<super::events::Event>, bool), String> {
    if target.meta.provider != source.provider || target.meta.native_id.as_deref() != Some(&source.native_id) {
        return Err("原生摘要标识不匹配".into());
    }
    let checked = inspect(&source.path, source.provider, &target.meta.workspace)?.ok_or("原生历史归属变化")?;
    if checked.source.native_id != source.native_id { return Err("原生历史文件被替换".into()); }
    let mut offset = 0;
    let mut known = std::collections::HashSet::new();
    let mut legacy = std::collections::HashSet::new();
    let mut episodes: Vec<(String, u64)> = vec![];
    let mut resolved = std::collections::HashSet::new();
    let path = target.dir.join("events.jsonl");
    if path.exists() {
        let mut reader = BufReader::new(File::open(path).map_err(|e| e.to_string())?);
        while let Some((event, _)) = bounded_line(&mut reader)? {
            if event["kind"] == "summary_checkpoint" {
                // 旧检查点可能已经跳过 meta 摘要，首次升级重扫；已有 summaryId 继续去重。
                offset = if event["data"]["version"] == 1 { event["data"]["offset"].as_u64().ok_or("摘要游标损坏")? } else { 0 };
            }
            if event["kind"] == "compaction" {
                if let Some(id) = event["data"]["episodeId"].as_str() {
                    if let Some(start) = event["data"]["sourceStart"].as_u64() {
                        if !episodes.iter().any(|(old, _)| old == id) { episodes.push((id.to_owned(), start)); }
                    }
                    if event["data"]["summaryId"].is_string() { resolved.insert(id.to_owned()); }
                }
                if let Some(id) = event["data"]["summaryId"].as_str() { known.insert(id.to_owned()); }
                else if let Some(body) = event["data"]["text"].as_str().filter(|s| !s.is_empty()) { legacy.insert(body.to_owned()); }
            }
        }
    }
    let length = fs::metadata(&source.path).map_err(|e| e.to_string())?.len();
    if length > MAX_FILE || length < offset { return Err("原生历史过大或已被截断".into()); }
    let size = complete_offset(&source.path)?;
    if size < offset { return Err("原生历史尾部已变化".into()); }
    if size == offset { return Ok((vec![], false)); }
    let mut file = File::open(&source.path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file.take(size - offset));
    let start = offset;
    let mut batch = vec![];
    while let Some((value, count)) = bounded_line(&mut reader)? {
        if source.provider == Provider::Claude && (value["sessionId"].as_str().is_some_and(|s| s != source.native_id)
            || value["cwd"].as_str().is_some_and(|s| !same_root(s, &target.meta.workspace))) {
            return Err("原生摘要记录归属不一致".into());
        }
        if source.provider == Provider::Codex && matches!(value["type"].as_str(), Some("session_meta" | "turn_context"))
            && (value["payload"]["cwd"].as_str().is_some_and(|s| !same_root(s, &target.meta.workspace))
                || value["type"] == "session_meta" && value["payload"]["id"].as_str() != Some(source.native_id.as_str())) {
            return Err("原生摘要记录归属不一致".into());
        }
        for (kind, mut data) in project(source.provider, &value, offset) {
            if kind == "compaction" && data["text"].as_str().is_some_and(|s| !s.is_empty()) {
                let id = data["summaryId"].as_str().unwrap_or_default();
                if !known.contains(id) {
                    // 同轮压缩按协议顺序与原生摘要对应；先限定最新的运行起点，不能串轮。
                    let start = episodes.iter().filter(|(_, start)| *start <= offset).map(|(_, start)| *start).max();
                    if let Some((episode, _)) = episodes.iter().find(|(id, floor)| Some(*floor) == start && !resolved.contains(id)) {
                        data["episodeId"] = json!(episode);
                        resolved.insert(episode.clone());
                    } else if legacy.contains(data["text"].as_str().unwrap_or_default()) { continue; }
                    batch.push((kind, data));
                }
            }
        }
        offset += count;
        // 界面补采保留分页预算；回合收尾扫描固定的、受 MAX_FILE 限制的快照。
        if !complete && (offset - start >= 4 * 1024 * 1024 || batch.len() >= 128) { break; }
    }
    batch.push(("summary_checkpoint".into(), json!({"offset":offset,"version":1})));
    Ok((target.append("native", batch)?, offset < size))
}

/// 空闲会话重开时补回旧版本已经跳过的摘要。
pub fn repair_summaries(base: &Path, id: &str, root: &str) -> Result<bool, String> {
    let Some(source) = source(base, id, root)? else { return Ok(false); };
    let meta = Store::metadata(&base.join(id), root)?;
    let mut target = Store::open(base, id, root, meta.provider, &meta.title, "")?;
    recover_summaries(&mut target, &source, false).map(|(_, more)| more)
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

/// CLI 以 user 角色写下的系统注入。清单是实测出来的：Codex 的五个包装在本机
/// `~/.codex/sessions` 的 rollout 里出现 51 次（`<INSTRUCTIONS>` 30、
/// `<subagent_notification>` 10、`<codex_internal_context>` 5、`<environment_context>` 4、
/// `<turn_aborted>` 2），Claude 的七个在 `claude.exe` 里能查到字面量
/// （`<system-reminder>` 76、`<local-command-stdout>` 17、`<task-notification>` 14、
/// `<command-name>` 13、`<command-message>`/`<command-args>`/`<user-prompt-submit-hook>` 各 2）。
const SYSTEM_TAGS: [&str; 12] = [
    "environment_context",
    "INSTRUCTIONS",
    "subagent_notification",
    "codex_internal_context",
    "turn_aborted",
    "system-reminder",
    "local-command-stdout",
    "task-notification",
    "command-name",
    "command-message",
    "command-args",
    "user-prompt-submit-hook",
];

/// Codex 把 AGENTS.md 注入成「裸标题 + `<INSTRUCTIONS>` 正文」，标题不带标签，只能按字面量认。
const SYSTEM_HEADING: &str = "# AGENTS.md instructions";

/// 剥掉系统注入之后这条 user 记录里还剩的真人话；整条都是注入（或本来就空）就是 `None`。
///
/// role=user 不代表真人打的字：两个 CLI 都把环境上下文、AGENTS.md 指令、子代理通知、
/// 后台任务完成通知、本地斜杠命令的回显写成 user 记录。照单投影就是把自己的提示词
/// 安到用户头上，还会让「# AGENTS.md instructions」变成会话标题。
///
/// 只整块剥离成对标签：regex 不支持反向引用，而这里每个标签名都是已知字面量，用不上它。
/// 一个标签都没匹配到时原样返回，真人消息里的空白和换行不归我们改。
pub fn human_text(body: &str) -> Option<String> {
    static BLOCKS: OnceLock<Regex> = OnceLock::new();
    let blocks = BLOCKS.get_or_init(|| {
        let pattern = SYSTEM_TAGS
            .iter()
            .map(|tag| format!("<{tag}\\b[\\s\\S]*?</{tag}>"))
            .collect::<Vec<_>>()
            .join("|");
        Regex::new(&pattern).expect("系统注入标签的模式必须能编译")
    });
    let stripped = blocks.replace_all(body, "");
    if matches!(stripped, Cow::Borrowed(_)) && !body.contains(SYSTEM_HEADING) {
        return (!body.trim().is_empty()).then(|| body.to_owned());
    }
    let rest = stripped.replace(SYSTEM_HEADING, "");
    let rest = rest.trim();
    (!rest.is_empty()).then(|| rest.to_owned())
}
fn project(provider: Provider, value: &Value, offset: u64) -> Vec<(String, Value)> {
    project_with_state(provider, value, offset, &mut ProjectionState::default())
}

fn project_with_state(
    provider: Provider,
    value: &Value,
    offset: u64,
    projection: &mut ProjectionState,
) -> Vec<(String, Value)> {
    let mut out = vec![];
    let id = format!("native-{offset}");
    if provider == Provider::Claude {
        if value["isSidechain"] == true {
            return out;
        }
        let message = &value["message"];
        // Claude 压缩后的续篇摘要有专门标记（isCompactSummary）：机器生成的上下文说明。
        // 并进压缩记录当摘要文本（前端折叠可看），绝不冒充用户气泡。
        if value["isCompactSummary"] == true {
            out.push(("compaction".into(), json!({"summaryId":id,"text": text(&message["content"]), "status": "completed"})));
            return out;
        }
        // 压缩摘要本身也可能是 meta；先识别摘要，再过滤其他内部消息。
        if value["isMeta"] == true { return out; }
        match value["type"].as_str().unwrap_or("") {
            "user" | "assistant" => {
                let body = text(&message["content"]);
                // user 角色不等于真人：Claude 把 <task-notification>、<system-reminder>
                // 和本地斜杠命令的回显也写成 user 记录，整块剥掉，全是指令就不发事件。
                let spoken = if value["type"] == "user" {
                    human_text(&body)
                } else {
                    (!body.is_empty()).then_some(body)
                };
                if let Some(spoken) = spoken {
                    out.push((
                        if value["type"] == "user" {
                            "user"
                        } else {
                            "message"
                        }
                        .into(),
                        json!({"id":value["uuid"].as_str().or_else(|| message["id"].as_str()).unwrap_or(&id),"text":spoken}),
                    ));
                }
                let blocks = message["content"].as_array().map(Vec::as_slice).unwrap_or_default();
                let result_count = blocks.iter().filter(|block| block["type"] == "tool_result").count();
                for (index, block) in blocks.iter().enumerate() {
                    match block["type"].as_str().unwrap_or("") {
                        "thinking" => out.push(("reasoning".into(), json!({"id":format!("{id}-{index}"),"text":block["thinking"]}))),
                        "tool_use" => {
                            out.push(("tool".into(), json!({"id":block["id"],"name":block["name"],"input":block["input"],"status":"recorded"})));
                            if block["name"] == "TaskCreate" {
                                if let Some(tool_id) = block["id"].as_str().filter(|id| !id.is_empty()) {
                                    projection.pending_task_creates.insert(tool_id.to_owned(), block.clone());
                                }
                            }
                            // 原生历史回放：TodoWrite / TaskCreate / TaskUpdate 补齐 task_list 事件，确保历史会话恢复后可折叠任务清单可见。
                            if let Some(super::protocol::Action::Emit { kind, data }) = super::claude::task_event(block["id"].as_str().unwrap_or(""), block["name"].as_str().unwrap_or(""), &block["input"]) {
                                out.push((kind.into(), data));
                            }
                        }
                        "tool_result" => {
                            let tool_id = block["tool_use_id"].as_str().unwrap_or_default();
                            let structured = super::structured_tool_result(
                                value.get("toolUseResult").or_else(|| value.get("tool_use_result")),
                                tool_id,
                                result_count,
                            );
                            out.push(("tool".into(), json!({"id":block["tool_use_id"],"output":block["content"],"result":structured,"status":if block["is_error"]==true {"failed"} else {"completed"}})));
                            if let Some(tool) = projection.pending_task_creates.remove(tool_id) {
                                if block["is_error"] != true {
                                    if let Some(super::protocol::Action::Emit { kind, data }) = super::claude::created_task_event(&tool, structured, &block["content"]) {
                                        out.push((kind.into(), data));
                                    }
                                }
                            }
                        }
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
                    // Codex 把 AGENTS.md 指令、环境上下文、子代理通知、中断说明都写成 role=user，
                    // 本机 rollout 里 187 条 user 记录有 51 条是这种注入。
                    let spoken = if p["role"] == "user" {
                        human_text(&body)
                    } else {
                        (!body.is_empty()).then_some(body)
                    };
                    if let Some(spoken) = spoken {
                        out.push((
                            if p["role"] == "user" { "user" } else { "message" }.into(),
                            json!({"id":p["id"].as_str().unwrap_or(&id),"text":spoken}),
                        ));
                    }
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
                // Codex 的完成态 plan item 是待审阅正文，不是 turn/plan/updated 任务清单。
                "plan" => {}
                _ => {}
            },
            "turn_context" => out.push(("configuration".into(), json!({"model":p["model"],"effort":p["effort"]}))),
            "compacted" => out.push(("compaction".into(), json!({"summaryId":id,"status":"completed","text":p["message"].as_str().unwrap_or("")}))),
            // 文件改动只在这条事件里有权威数据（changes 映射带 unified_diff）：
            // 漏了它，导入的 Codex 会话永远聚合不出「改动文件」。
            "event_msg" if p["type"] == "item_completed" && p["item"]["type"] == "FileChange" => {
                let item = &p["item"];
                let changes = item["changes"].as_object().map(|map| {
                    let list: Vec<Value> = map.iter().map(|(path, change)| {
                        json!({"path":path,"kind":change["type"],"diff":change["unified_diff"]})
                    }).collect();
                    json!(list)
                }).unwrap_or_else(|| item["changes"].clone());
                out.push(("tool".into(), json!({
                    "id":item["id"].as_str().unwrap_or(&id),
                    "name":"apply_patch",
                    "input":{"changes":changes},
                    "status":if item["status"] == "completed" { "completed" } else { "recorded" },
                })));
            }
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
    fn codex_file_change_projects_as_patch_tool_with_changes_array() {
        let _root = std::env::temp_dir().join("forge-history-filechange").to_string_lossy().to_string();
        let events = project(Provider::Codex, &json!({
            "timestamp":"2026-10-23T04:26:08.000Z","type":"event_msg",
            "payload":{"type":"item_completed","thread_id":"t","turn_id":"turn",
                "item":{"type":"FileChange","id":"call_1","status":"completed",
                    "changes":{"src/images.rs":{"type":"add","unified_diff":"@@ -0,0 +1,2 @@
+//! a
+//! b"}}}}
        }), 1);
        let tool = events.iter().find(|(kind, _)| kind == "tool").expect("tool event");
        let data = &tool.1;
        assert_eq!(data["name"], "apply_patch");
        assert_eq!(data["status"], "completed");
        let changes = data["input"]["changes"].as_array().expect("changes array");
        assert_eq!(changes[0]["path"], "src/images.rs");
        assert_eq!(changes[0]["kind"], "add");
        assert!(changes[0]["diff"].as_str().unwrap_or("").starts_with("@@"));
    }

    #[test]
    fn claude_compact_summary_joins_the_compaction_record_not_a_user_bubble() {
        let root = std::env::temp_dir().join("forge-history-compact").to_string_lossy().to_string();
        let events = project(Provider::Claude, &json!({
            "type":"user","cwd":root,"sessionId":"s1","isCompactSummary":true,"isMeta":true,
            "message":{"content":"This session is being continued from a previous conversation..."}
        }), 1);
        // 一条压缩事件带摘要文本；不产生任何 user 事件。
        assert!(events.iter().any(|(kind, data)| kind == "compaction" && data["text"].as_str().unwrap_or("").starts_with("This session")));
        assert!(!events.iter().any(|(kind, _)| kind == "user"));
        // 子代理摘要仍不能混进主会话；普通 meta 也仍需过滤。
        assert!(project(Provider::Claude, &json!({"isSidechain":true,"isCompactSummary":true,"message":{"content":"private"}}), 2).is_empty());
        assert!(project(Provider::Claude, &json!({"type":"user","isMeta":true,"message":{"content":"internal"}}), 3).is_empty());
    }

    #[test]
    fn system_injected_user_records_never_become_user_bubbles() {
        // 实测：本机 ~/.codex/sessions 的 187 条 role=user 记录里有 51 条是 CLI 自己写的注入
        // （AGENTS.md 指令 30、子代理通知 10、goal 上下文 5、环境上下文 4、中断说明 2），
        // Forge 自己的 9 份会话日志里也已经躺着 7 条被当成用户消息的事件。
        let codex = |text: &str| {
            project(
                Provider::Codex,
                &json!({"type":"response_item","payload":{"type":"message","role":"user","id":"m","content":[{"type":"input_text","text":text}]}}),
                1,
            )
        };
        let injected = codex(
            "# AGENTS.md instructions\n<INSTRUCTIONS>\n- 始终使用简体中文输出。\n</INSTRUCTIONS>\n<environment_context>\n<current_date>2026-10-23</current_date>\n</environment_context>",
        );
        assert!(!injected.iter().any(|(kind, _)| kind == "user"), "AGENTS.md 指令与环境上下文不是用户说的话");
        assert!(codex("<subagent_notification>\n{\"agent_path\":\"01a16e1e\",\"status\":{\"completed\":\"…\"}}\n</subagent_notification>").is_empty());
        assert!(codex("<codex_internal_context source=\"goal\">\nContinue working toward the active thread goal.\n</codex_internal_context>").is_empty());
        assert!(codex("<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>").is_empty());

        let claude = |text: &str| project(Provider::Claude, &json!({"type":"user","message":{"content":text}}), 2);
        assert!(!claude("<task-notification>\n<task-id>a70f6004</task-id>\n</task-notification>").iter().any(|(kind, _)| kind == "user"));
        assert!(!claude("<system-reminder data-role=\"tool-hint\">hint</system-reminder>").iter().any(|(kind, _)| kind == "user"));
        // 本地斜杠命令的回显带三个成对标签，一起剥掉之后什么都不剩。
        assert!(!claude("<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>").iter().any(|(kind, _)| kind == "user"));

        // 真人消息一个字都不能改：没匹配到注入时连首尾空白都要留着。
        let human = claude("  帮我看下这个 task 有什么问题  \n");
        assert_eq!(human.len(), 1);
        assert_eq!(human[0].0, "user");
        assert_eq!(human[0].1["text"], "  帮我看下这个 task 有什么问题  \n");
        // 注入追加在真人消息后面时，只留人话。
        let mixed = claude("继续 <system-reminder>Caveat: 下面的消息来自本地命令</system-reminder>");
        assert_eq!(mixed[0].1["text"], "继续");
        // 助手引用同样的标签是在讲这段文本，不能删。
        let assistant = project(Provider::Claude, &json!({"type":"assistant","message":{"id":"m","content":"这里的 <system-reminder> 是注入"}}), 3);
        assert_eq!(assistant[0].1["text"], "这里的 <system-reminder> 是注入");
    }

    #[test]
    fn native_title_skips_cli_injected_user_records() {
        // 实测：会话列表里真有一条标题就是「# AGENTS.md instructions」——
        // Codex 的第一条 role=user 记录就是它自己注入的指令。
        let temp = std::env::temp_dir().join(format!(
            "forge-history-title-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let root = temp.join("project");
        let native = temp.join("native");
        for path in [&root, &native] { fs::create_dir_all(path).unwrap(); }
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let path = native.join("injected.jsonl");
        fs::write(
            &path,
            format!(
                "{}\n{}\n{}\n",
                json!({"type":"session_meta","payload":{"id":"injected-session","cwd":root,"source":"cli"}}),
                json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions <INSTRUCTIONS>始终使用简体中文</INSTRUCTIONS>"}]}}),
                json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"已修改的部分可能有些问题 需要优化"}]}})
            ),
        )
        .unwrap();
        let candidate = inspect(&path, Provider::Codex, &workspace).unwrap().expect("候选历史");
        assert_eq!(candidate.title, "已修改的部分可能有些问题 需要优化");
        fs::remove_dir_all(temp).unwrap();
    }

    /// Claude 的标题优先级：用户 /rename > CLI 生成的 ai-title > 首条用户消息。
    #[test]
    fn claude_ai_title_beats_the_first_prompt_and_custom_title_wins() {
        let temp = std::env::temp_dir().join(format!(
            "forge-claude-ai-title-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let root = temp.join("project");
        let native = temp.join("native");
        for path in [&root, &native] { fs::create_dir_all(path).unwrap(); }
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let path = native.join("claude.jsonl");
        let push = |line: Value, extra: &mut String| extra.push_str(&format!("{line}\n"));
        let mut content = String::new();
        push(json!({"type":"user","cwd":root,"sessionId":"claude-ai-title","message":{"content":"first prompt"}}), &mut content);
        push(json!({"type":"ai-title","aiTitle":"CLI 生成的标题"}), &mut content);
        fs::write(&path, &content).unwrap();
        assert_eq!(inspect(&path, Provider::Claude, &workspace).unwrap().unwrap().title, "CLI 生成的标题");

        push(json!({"type":"custom-title","customTitle":"用户改的标题"}), &mut content);
        // 之后 CLI 又生成一次标题也不能盖掉用户的 /rename。
        push(json!({"type":"ai-title","aiTitle":"更新的生成标题"}), &mut content);
        fs::write(&path, &content).unwrap();
        assert_eq!(inspect(&path, Provider::Claude, &workspace).unwrap().unwrap().title, "用户改的标题");

        // 头部只扫 64 条记录：把改名推到窗口之外，尾部补读仍要拿到最新标题。
        for index in 0..80 {
            push(json!({"type":"assistant","message":{"content":format!("filler-{index}")}}), &mut content);
        }
        push(json!({"type":"custom-title","customTitle":"窗口外改的标题"}), &mut content);
        fs::write(&path, &content).unwrap();
        assert_eq!(inspect(&path, Provider::Claude, &workspace).unwrap().unwrap().title, "窗口外改的标题");
        fs::remove_dir_all(temp).unwrap();
    }

    /// 早期 Forge 用 `--name` 把「Claude Code 会话 3」写成了 custom-title 记录，
    /// Codex 那边同理写进 session_index。它占着最高优先级，必须忽略，
    /// 否则首条消息生成的自动标题永远被占位名压住，列表里全是一排「会话 N」。
    #[test]
    fn forge_placeholder_native_titles_lose_to_the_first_prompt() {
        let temp = std::env::temp_dir().join(format!(
            "forge-claude-placeholder-title-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let root = temp.join("project");
        let native = temp.join("native");
        for path in [&root, &native] { fs::create_dir_all(path).unwrap(); }
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let path = native.join("claude.jsonl");
        fs::write(
            &path,
            format!(
                "{}\n{}\n",
                json!({"type":"user","cwd":root,"sessionId":"claude-placeholder","message":{"content":"修复登录页的跨域问题"}}),
                json!({"type":"custom-title","customTitle":"Claude Code 会话 3"})
            ),
        )
        .unwrap();
        assert_eq!(inspect(&path, Provider::Claude, &workspace).unwrap().unwrap().title, "修复登录页的跨域问题");
        // 用户在 CLI 里真的改过名，就不再是占位名，照旧以它为准。
        fs::write(
            &path,
            format!(
                "{}\n{}\n{}\n",
                json!({"type":"user","cwd":root,"sessionId":"claude-placeholder","message":{"content":"修复登录页的跨域问题"}}),
                json!({"type":"custom-title","customTitle":"Claude Code 会话 3"}),
                json!({"type":"custom-title","customTitle":"登录跨域"})
            ),
        )
        .unwrap();
        assert_eq!(inspect(&path, Provider::Claude, &workspace).unwrap().unwrap().title, "登录跨域");
        fs::remove_dir_all(temp).unwrap();
    }

    /// 自动标题要把长消息压成一行短名字：只取第一行、折叠空白，超长时先断在第一句，
    /// 其次断在空格上，都没有才硬切。发送时和解析原生历史都走这一个函数，写法必须一致。
    #[test]
    fn auto_title_cuts_at_a_boundary_and_collapses_whitespace() {
        assert_eq!(auto_title("  修复   登录页\n的跨域问题  ").as_deref(), Some("修复 登录页"));
        assert_eq!(
            auto_title("先修复登录跨域。后面的内容太长就不再进标题里了一直往下堆很多字").as_deref(),
            Some("先修复登录跨域。")
        );
        // 既没句读也没空格：硬切到 30 个字符，中文不切半。
        assert_eq!(
            auto_title(&"分".repeat(40)).as_deref(),
            Some("分".repeat(30).as_str())
        );
        // 空格断点太靠前的不算，否则标题只剩一两个词；还是硬切到 30 个字符。
        let hard = auto_title("改 a 完之后还要回归所有平台的登录与排队流程一起验一遍并且要覆盖旧标签").unwrap();
        assert_eq!(hard.chars().count(), 30);
        assert!(hard.starts_with("改 a 完之后"));
        assert_eq!(auto_title("   "), None);
        assert!(is_placeholder_title("Codex 会话 12"));
        assert!(is_placeholder_title("Claude Code session 3"));
        assert!(!is_placeholder_title("Codex 会话列表"));
    }

    /// Codex 的改名只追加在 session_index.jsonl；用户锁定过的标题不能被它覆盖。
    #[test]
    fn codex_index_names_follow_renames_until_the_user_locks_the_title() {
        let temp = std::env::temp_dir().join(format!(
            "forge-codex-index-title-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let root = temp.join("project");
        let base = temp.join("mirror");
        let codex = temp.join("codex");
        let sessions = codex.join("sessions");
        for path in [&root, &base, &sessions] { fs::create_dir_all(path).unwrap(); }
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let id = "codex-index-title";
        fs::write(
            sessions.join("rollout.jsonl"),
            format!(
                "{}\n{}\n",
                json!({"type":"session_meta","payload":{"id":id,"cwd":root,"source":"cli"}}),
                json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"first prompt"}]}})
            ),
        )
        .unwrap();
        let index = codex.join("session_index.jsonl");
        fs::write(&index, format!("{}\n", json!({"id":id,"thread_name":"CLI 里改的名字"}))).unwrap();
        discover_in(&base, &workspace, vec![(Provider::Codex, sessions.clone())]).unwrap();
        let meta = Store::metadata(&base.join(id), &workspace).unwrap();
        assert_eq!(meta.title, "CLI 里改的名字");
        assert!(!meta.title_locked);

        // 用户在 Forge 里改名：写 meta 并加锁。
        let mut store = Store::open(&base, id, &workspace, Provider::Codex, &meta.title, "").unwrap();
        store.meta.title = "用户改的标题".into();
        store.meta.title_locked = true;
        store.save().unwrap();

        // Codex CLI 再改名，Forge 也不能覆盖用户的标题。
        fs::write(&index, format!("{}\n", json!({"id":id,"thread_name":"CLI 又改了一次"}))).unwrap();
        discover_in(&base, &workspace, vec![(Provider::Codex, sessions)]).unwrap();
        assert_eq!(Store::metadata(&base.join(id), &workspace).unwrap().title, "用户改的标题");
        fs::remove_dir_all(temp).unwrap();
    }

    /// Forge 自建会话的目录名是客户端 UUID，Codex 线程要等首条消息才建出来：
    /// 绑定之后两者必然不同，发现必须认这条绑定，不能按原生 ID 再开一份重复镜像。
    #[test]
    fn discovery_reuses_a_forge_session_bound_to_a_different_native_thread() {
        let temp = std::env::temp_dir().join(format!(
            "forge-codex-divergent-binding-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let root = temp.join("project");
        let base = temp.join("mirror");
        let sessions = temp.join("codex").join("sessions");
        for path in [&root, &base, &sessions] { fs::create_dir_all(path).unwrap(); }
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let native = "01a10000-0000-4000-8000-000000000001";
        let forge_id = "9f3c1e2a-1111-4222-8333-444455556666";
        let mut store = Store::open(&base, forge_id, &workspace, Provider::Codex, "修复登录页的跨域问题", "").unwrap();
        store.bind(native.to_string()).unwrap();
        fs::write(
            sessions.join("rollout.jsonl"),
            format!(
                "{}\n{}\n",
                json!({"type":"session_meta","payload":{"id":native,"cwd":root,"source":"cli"}}),
                json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"修复登录页的跨域问题"}]}})
            ),
        )
        .unwrap();
        discover_in(&base, &workspace, vec![(Provider::Codex, sessions)]).unwrap();
        assert!(!base.join(native).exists(), "按原生 ID 又建了一份重复镜像");
        assert_eq!(Store::metadata(&base.join(forge_id), &workspace).unwrap().native_id.as_deref(), Some(native));
        fs::remove_dir_all(temp).unwrap();
    }

    /// 镜像里还写着早期占位名（Claude 的 custom-title、Codex 的线程名），或者线程名就是
    /// 整条首句消息：下一次发现要把它换成自动标题，用户锁过的名字一个都不动。
    #[test]
    fn discovery_replaces_placeholder_titles_with_the_auto_title() {
        let temp = std::env::temp_dir().join(format!(
            "forge-auto-title-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let root = temp.join("project");
        let base = temp.join("mirror");
        let claude = temp.join("claude");
        let codex = temp.join("codex");
        let sessions = codex.join("sessions");
        for path in [&root, &base, &claude, &sessions] { fs::create_dir_all(path).unwrap(); }
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let prompt = "先修复登录跨域。后面的内容太长就不再进标题里了一直往下堆很多字";
        let want = auto_title(prompt).unwrap();
        fs::write(
            claude.join("claude.jsonl"),
            format!(
                "{}\n{}\n",
                json!({"type":"user","cwd":root,"sessionId":"claude-old","message":{"content":prompt}}),
                json!({"type":"custom-title","customTitle":"Claude Code 会话 3"})
            ),
        )
        .unwrap();
        fs::write(
            sessions.join("codex-placeholder.jsonl"),
            format!(
                "{}\n{}\n",
                json!({"type":"session_meta","payload":{"id":"codex-placeholder","cwd":root,"source":"cli"}}),
                json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":prompt}]}})
            ),
        )
        .unwrap();
        fs::write(
            sessions.join("codex-dump.jsonl"),
            format!(
                "{}\n{}\n",
                json!({"type":"session_meta","payload":{"id":"codex-dump","cwd":root,"source":"cli"}}),
                json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":prompt}]}})
            ),
        )
        .unwrap();
        fs::write(
            sessions.join("codex-named.jsonl"),
            format!(
                "{}\n{}\n",
                json!({"type":"session_meta","payload":{"id":"codex-named","cwd":root,"source":"cli"}}),
                json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":prompt}]}})
            ),
        )
        .unwrap();
        // 占位名那一行按老版本的样子留在索引里；另一条的索引名是整条首句消息。
        fs::write(
            codex.join("session_index.jsonl"),
            format!("{}\n{}\n", json!({"id":"codex-placeholder","thread_name":"Codex 会话 4"}), json!({"id":"codex-dump","thread_name":prompt})),
        )
        .unwrap();
        for (id, provider, title) in [
            ("claude-old", Provider::Claude, "Claude Code 会话 3"),
            ("codex-placeholder", Provider::Codex, "Codex 会话 4"),
            ("codex-dump", Provider::Codex, prompt),
            // 用户自己起的名字（还没加锁的那批旧数据）：对不上首句消息的形状，一个字不动。
            ("codex-named", Provider::Codex, "登录跨域"),
        ] {
            let mut mirror = Store::open(&base, id, &workspace, provider, title, "").unwrap();
            mirror.bind(id.to_owned()).unwrap();
        }
        discover_in(&base, &workspace, vec![(Provider::Claude, claude), (Provider::Codex, sessions)]).unwrap();
        for id in ["claude-old", "codex-placeholder", "codex-dump"] {
            let meta = Store::metadata(&base.join(id), &workspace).unwrap();
            assert_eq!(meta.title, want, "{id}");
            assert!(!meta.title_locked, "{id} 的标题是自动取的，不能加锁");
        }
        assert_eq!(Store::metadata(&base.join("codex-named"), &workspace).unwrap().title, "登录跨域");
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn finish_recovers_all_summary_batches_before_advancing_history() {
        let temp = std::env::temp_dir().join(format!("forge-summary-batches-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let root = temp.join("project");
        let base = temp.join("mirror");
        let native = temp.join("native");
        for path in [&root, &base, &native] { fs::create_dir_all(path).unwrap(); }
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let mut content = format!("{}\n", json!({"type":"user","cwd":root,"sessionId":"summary-session","message":{"content":"hello"}}));
        // 超过单批 128 条：第二批不能靠用户重新打开会话才能恢复。
        for index in 0..129 {
            content.push_str(&format!("{}\n", json!({"type":"user","cwd":root,"sessionId":"summary-session","isCompactSummary":true,"isMeta":true,"message":{"content":format!("summary-{index}")}})));
        }
        let old_offset = content.len();
        fs::write(native.join("session.jsonl"), content).unwrap();
        discover_in(&base, &workspace, vec![(Provider::Claude, native)]).unwrap();
        let mut target = Store::open(&base, "summary-session", &workspace, Provider::Claude, "test", "").unwrap();
        // 模拟旧版本已经扫到 EOF 却漏掉 meta 摘要，升级后仍应恢复。
        target.append("native", vec![("summary_checkpoint".into(), json!({"offset":old_offset}))]).unwrap();
        let events = mark_current(&mut target, &base).unwrap();
        assert_eq!(events.iter().filter(|event| event.kind == "compaction").count(), 129);
        assert!(!mark_current(&mut target, &base).unwrap().iter().any(|event| event.kind == "compaction"));
        fs::remove_dir_all(temp).unwrap();
    }

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
    fn sidechain_lines_project_as_the_agents_own_conversation() {
        let mut projection = ProjectionState::default();
        let line = json!({
            "isSidechain":true,"agentId":"agent-1","sessionId":"parent-session","type":"user",
            "message":{"role":"user","content":"从 1 输出到 100"}
        });
        let events = project_sidechain(Provider::Claude, &line, 0, &mut projection);
        // 剥掉 isSidechain 标记后照常投影：任务正文成为子会话的第一条用户消息。
        assert!(events.iter().any(|(kind, data)| kind == "user" && data["text"] == "从 1 输出到 100"));
        // 主解析器对同一条（未剥标记）仍然保持静默：父会话镜像不收子代理的行。
        assert!(project(Provider::Claude, &line, 0).is_empty());
    }

    #[test]
    fn claude_history_rebinds_task_create_id_before_task_update() {
        let temp = std::env::temp_dir().join(format!(
            "forge-history-task-create-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = temp.join("project");
        let base = temp.join("mirror");
        let native = temp.join("native");
        for path in [&root, &base, &native] { fs::create_dir_all(path).unwrap(); }
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let session = "claude-task-history";
        let mut records = vec![
            json!({"type":"assistant","cwd":root,"sessionId":session,"message":{"content":[{
                "type":"tool_use","id":"tool-create","name":"TaskCreate",
                "input":{"subject":"检查历史任务","description":"保留正文"}
            }]}}),
        ];
        // 强制 TaskCreate 与结果跨过单次同步的 500 个投影事件上限，覆盖进程内状态丢失的边界。
        for index in 0..498 {
            records.push(json!({"type":"assistant","cwd":root,"sessionId":session,"message":{
                "id":format!("filler-{index}"),"content":format!("filler-{index}")
            }}));
        }
        records.extend([
            json!({"type":"user","cwd":root,"sessionId":session,"message":{"content":[{
                "type":"tool_result","tool_use_id":"tool-create","content":"Task #7 created"
            }]}}),
            json!({"type":"assistant","cwd":root,"sessionId":session,"message":{"content":[{
                "type":"tool_use","id":"tool-update","name":"TaskUpdate",
                "input":{"taskId":"7","status":"in_progress"}
            }]}}),
        ]);
        let content = records.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n";
        fs::write(native.join("session.jsonl"), content).unwrap();

        discover_in(&base, &workspace, vec![(Provider::Claude, native)]).unwrap();
        assert!(sync(&base, session, &workspace).unwrap(), "创建结果应留到下一同步批次");
        while sync(&base, session, &workspace).unwrap() {}
        let page = Store::page(&base, session, &workspace, Window::After(0), 500, false).unwrap();
        let items = page.task_list.unwrap()["items"].as_array().unwrap().clone();
        assert_eq!(items, vec![json!({
            "id":"7","content":"检查历史任务","detail":"保留正文","status":"active"
        })]);
        fs::remove_dir_all(temp).unwrap();
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
