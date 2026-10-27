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
    let mut known_subagents = std::collections::HashMap::new();
    for entry in fs::read_dir(base)
        .map_err(|e| e.to_string())?
        .take(20000)
        .flatten()
    {
        if let Ok(meta) = Store::metadata(&entry.path(), root) {
            if let Some(native) = &meta.native_id {
                // 绑定按原生 ID 认人。Forge 自建会话的目录名是客户端 UUID，线程要等首条
                // 消息才建出来，绑上之后两者必然不同——不登记就会在下一条消息后多出一份重复镜像。
                // 旧版包装过 ID 的目录可能仍和真实 ID 目录并存，那种情况让名字等于原生 ID 的那个赢。
                let key = binding_key(meta.provider, native);
                if &meta.session_id == native || !known.contains_key(&key) {
                    known.insert(key, meta.session_id.clone());
                }
            }
            // 补充已持久化 source 的历史 native_id，避免长会话因后续轮次更换 nativeId 丢失旧 thread 绑定
            if let Ok(Some(src)) = self::source(base, &meta.session_id, root) {
                let key = binding_key(meta.provider, &src.native_id);
                known.entry(key).or_insert_with(|| meta.session_id.clone());
            }
            // 记录已知子代理会话与其父会话关联，按子代理 tool_id 直连匹配，摆脱脆弱的父 thread 反查
            if let (Some(parent), Some(agent)) = (&meta.parent_session_id, &meta.agent) {
                if !agent.tool_id.is_empty() {
                    known_subagents.insert(agent.tool_id.clone(), (meta.session_id.clone(), parent.clone()));
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
                    import_codex_subagent(base, &path, root, &known, &known_subagents);
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
            // 若当前历史正在被其他进程使用而无法获得租约，跳过本条继续导入其他项，不连累整个列表。
            let Ok(_lease) = store::Lease::acquire(&base.join(format!("{key}.lock"))) else {
                continue;
            };
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
    if provider == Provider::Claude {
        let mut stripped = value.clone();
        if let Some(object) = stripped.as_object_mut() { object.remove("isSidechain"); }
        // 实时协议使用 message.id，原生 uuid 是信封 ID；两者必须投影成同一条消息。
        if value["type"] == "assistant" {
            if let Some(id) = value["message"]["id"].as_str() { stripped["uuid"] = json!(id); }
        }
        let mut events = project_with_state(provider, &stripped, offset, projection);
        if let Some(id) = value["message"]["id"].as_str() {
            // 思考块也沿用实时的 message.id-index，补采才能修正原条目。
            for (kind, data) in &mut events {
                if kind == "reasoning" {
                    if let Some(index) = data["id"].as_str().and_then(|id| id.rsplit('-').next()) {
                        data["id"] = json!(format!("{id}-{index}"));
                    }
                }
            }
        }
        return events;
    }
    project_with_state(provider, value, offset, projection)
}

/// 父会话已删除（墓碑在案）：子会话随父一起走，别再为孤儿回填或重建。
fn parent_deleted(base: &Path, parent_id: &str) -> bool {
    store::is_tombstoned(base, parent_id)
}

/// 导入 Claude 的 `subagents/agent-*.jsonl`：每个文件是一个子代理的完整对话，
/// 同名 `.meta.json` 带归属（toolUseId/agentType/description/finished）。
/// 子会话 id 与 live 路由用同一规则派生；已有部分实时事件也继续补齐。
fn import_claude_subagents(base: &Path, parent_id: &str, native_path: &Path, native_id: &str, root: &str) {
    if parent_deleted(base, parent_id) { return; }
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
        // 只导入已终态（finished）的子代理。正在写的半截正文一旦落盘，exists() 的
        // 跳过会让它永远冻住；meta 缺失时 toolUseId 也提不出来，派生的目录名会和
        // live 路由按 toolUseId 建的对不上。等终态出现后的下一次发现再导。
        if info["finished"] != true { continue; }
        let key = info["toolUseId"].as_str().filter(|value| !value.is_empty()).unwrap_or(&agent_id).to_owned();
        let child = super::child_session_id(parent_id, &key);
        // 运行中的镜像游标由 Worker 独占；列表发现不能抢先消费却不广播。
        if super::registry::for_session(parent_id).is_some() { continue; }
        let title = info["description"].as_str().map(str::trim).filter(|text| !text.is_empty()).unwrap_or("子代理").to_owned();
        let Ok(mut target) = Store::open(base, &child, root, Provider::Claude, &title, "") else { continue };
        let modified = fs::metadata(&path).and_then(|meta| meta.modified()).ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |duration| duration.as_millis() as u64);
        target.meta.parent_session_id = Some(parent_id.to_owned());
        target.meta.agent.get_or_insert_with(|| store::AgentInfo {
            native_agent_id: Some(agent_id.clone()),
            agent_type: info["agentType"].as_str().map(str::to_owned),
            title: title.clone(),
            tool_id: key.clone(),
            model: None,
            status: "starting".into(),
            started_at: modified,
            ended_at: None,
        });
        if target.save().is_err() { continue; }
        let source = Source { provider: Provider::Claude, native_id: agent_id, path, workspace: root.to_owned() };
        let _ = sync_claude_source(&mut target, &source, native_id, info["finished"] == true);
    }
}

/// 导入 Codex 的子代理 rollout（`session_meta.source.subagent`）。当前协议的首条 meta
/// 就是子代理自身，父线程只能从 `thread_spawn.parent_thread_id` 取；后面的记录可能仍
/// 带 fork 进来的父历史。实时事件会先创建空子会话，所以这里必须回填已有目录。
fn import_codex_subagent(
    base: &Path,
    path: &Path,
    root: &str,
    known: &std::collections::HashMap<String, String>,
    known_subagents: &std::collections::HashMap<String, (String, String)>,
) {
    let Ok(file) = File::open(path) else { return };
    let mut reader = BufReader::new(file.take(256 * 1024));
    let mut child_meta: Option<(Value, u64)> = None;
    let mut scanned = 0u64;
    while let Ok(Some((value, count))) = bounded_line(&mut reader) {
        if value["type"] == "session_meta" {
            let p = &value["payload"];
            let spawn = &p["source"]["subagent"]["thread_spawn"];
            if spawn.is_object() {
                child_meta = Some((p.clone(), scanned + count));
                break;
            }
        }
        scanned += count;
        if scanned > 256 * 1024 { return; }
    }
    let Some((meta, _)) = child_meta else { return };
    let spawn = &meta["source"]["subagent"]["thread_spawn"];
    let Some(parent_native) = spawn["parent_thread_id"].as_str().filter(|id| !id.is_empty()) else { return };
    if meta["cwd"].as_str().is_some_and(|cwd| !same_root(cwd, root)) { return; }
    let Some(child_id) = meta["id"].as_str().filter(|id| !id.is_empty()) else { return };
    let (child, parent_forge) = if let Some((existing_child, p)) = known_subagents.get(child_id) {
        (existing_child.clone(), p.clone())
    } else {
        let Some(parent_forge) = known.get(&binding_key(Provider::Codex, parent_native)) else { return };
        (super::child_session_id(parent_forge, child_id), parent_forge.clone())
    };
    if parent_deleted(base, &parent_forge) { return; }
    let agent_path = spawn["agent_path"].as_str().unwrap_or_default().to_owned();
    let agent_role = spawn["agent_role"].as_str().filter(|value| !value.trim().is_empty());
    // rollout 没有 spawn_agent 的 arguments；只能从持久化 path/role 恢复，随机 nickname 永不展示。
    let discovered_title = super::codex::subagent_title(None, (!agent_path.is_empty()).then_some(agent_path.as_str()), agent_role);
    let Ok(mut target) = Store::open(base, &child, root, Provider::Codex, discovered_title.as_deref().unwrap_or("子代理"), "") else { return };
    if target.meta.parent_session_id.as_deref().is_some_and(|id| id != parent_forge)
        || target.meta.native_id.as_deref().is_some_and(|id| id != child_id)
    {
        return;
    }
    target.meta.parent_session_id = Some(parent_forge.clone());
    if let Some(title) = discovered_title.as_ref() {
        if !target.meta.title_locked
            && (target.meta.title.trim().is_empty() || target.meta.title == "子代理")
        {
            target.meta.title = title.clone();
        }
    }
    let info = target.meta.agent.get_or_insert_with(store::AgentInfo::default);
    // 实时阶段可能已保存更准确的 task_name；历史 path/role 只能填空，不能反向降级标题。
    if info.title.trim().is_empty() || info.title == "子代理" {
        info.title = discovered_title.unwrap_or_else(|| "子代理".into());
    }
    info.tool_id = child_id.to_owned();
    if info.status.is_empty() { info.status = "running".into(); }
    if !agent_path.is_empty() { info.native_agent_id = Some(agent_path); }
    // 清掉旧版本落盘的随机 nickname；只有协议明确给出的 role 才能作为类型展示。
    info.agent_type = agent_role.map(str::to_owned);
    // 旧版已完成的一次性导入没有游标，不能从头再灌一次正文。
    if target.meta.native_id.as_deref() == Some(child_id) && !source_path(base, &child).exists() {
        let _ = target.save();
        return;
    }
    let source = Source { provider: Provider::Codex, native_id: child_id.to_owned(), path: path.to_path_buf(), workspace: root.to_owned() };
    if save_source(base, &child, &source).is_err() || target.bind(child_id.to_owned()).is_err() { return; }
    // 列表发现只能登记路径；运行中的游标由 Worker 独占并广播，避免抢先消费而漏通知。
    if super::registry::for_session(&parent_forge).is_some() { return; }
    // 离线发现没有实时刷新循环，读完当前完整尾部再返回。
    while let Ok(events) = poll_codex_subagent(&mut target, &source, true) {
        if events.is_empty() { break; }
    }
}

/// 调用方持有 IO_LOCK。只读取完整行，正文和恢复状态同批提交，返回本批供实时广播。
fn poll_codex_subagent(target: &mut Store, source: &Source, follow_lifecycle: bool) -> Result<Vec<super::events::Event>, String> {
    let base = target.dir.parent().ok_or("子会话路径无效")?.to_path_buf();
    let id = target.meta.session_id.clone();
    if target.meta.provider != Provider::Codex || target.meta.native_id.as_deref() != Some(&source.native_id) {
        return Err("子代理原生标识不匹配".into());
    }
    let (mut offset, mut projection) = checkpoint(&base, &id)?;
    let length = fs::metadata(&source.path).map_err(|e| e.to_string())?.len();
    if length > MAX_FILE || length < offset { return Err("子代理历史过大或已被截断；保留现有镜像".into()); }
    if length == offset { return Ok(vec![]); }
    let mut file = File::open(&source.path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file.take(length - offset));
    let start = offset;
    let mut batch = vec![];
    let mut status = None;
    while let Some((value, count)) = bounded_line(&mut reader)? {
        let seed = offset;
        offset += count;
        let payload = &value["payload"];
        let lifecycle = payload["type"].as_str().or_else(|| value["type"].as_str());
        if seed == 0 {
            if value["type"] == "session_meta" {
                if payload["id"].as_str() != Some(&source.native_id)
                    || payload["cwd"].as_str().is_some_and(|cwd| !same_root(cwd, &source.workspace)) {
                    return Err("子代理历史归属不一致".into());
                }
                projection.codex_parent = payload["source"]["subagent"]["thread_spawn"]["parent_thread_id"].as_str().map(str::to_owned);
                if projection.codex_parent.is_none() { return Err("子代理历史缺少父线程".into()); }
            } else { return Err("子代理历史缺少线程元数据".into()); }
        } else if projection.codex_snapshot_depth > 0 {
            // 父代理也可能继承祖先快照，每层都以 turn_aborted 封口，深度须跨批保留。
            if value["type"] == "session_meta" && payload["id"].as_str() != Some(&source.native_id) {
                projection.codex_snapshot_depth += 1;
            } else if lifecycle == Some("turn_aborted") { projection.codex_snapshot_depth -= 1; }
        } else if value["type"] == "session_meta" {
            if payload["id"].as_str() == projection.codex_parent.as_deref() {
                projection.codex_snapshot_depth = 1;
            } else if payload["id"].as_str() != Some(&source.native_id) {
                return Err("子代理历史线程发生变化".into());
            }
        } else {
            if value["type"] == "turn_context" && payload["cwd"].as_str().is_some_and(|cwd| !same_root(cwd, &source.workspace)) {
                return Err("子代理历史工作区发生变化".into());
            }
            let next_status = match lifecycle {
                Some("task_started") => Some("running"),
                Some("task_complete") => Some("completed"),
                Some("task_failed") => Some("failed"),
                Some("turn_aborted") => Some("stopped"),
                _ => None,
            };
            // 运行时状态由父连接维护；补采的旧 task_started 不能覆盖已到达的 completed。
            if let Some(next) = next_status.filter(|_| follow_lifecycle) {
                status = Some(next);
                batch.push(("agent".into(), json!({"key":source.native_id,"sessionId":id,"status":next})));
            }
            batch.extend(project_with_state(Provider::Codex, &value, seed, &mut projection));
        }
        if batch.len() >= 128 || offset - start >= 4 * 1024 * 1024 { break; }
    }
    if offset == start { return Ok(vec![]); }
    batch.push(("history_checkpoint".into(), json!({"offset":offset,"projection":projection})));
    let events = target.append("native", batch)?;
    if let (Some(status), Some(info)) = (status, target.meta.agent.as_mut()) {
        info.status = status.into();
        info.ended_at = (status != "running").then(super::now_ms);
        // 日志已经提交，元数据失败不能吞掉本批广播；下次仍按日志游标继续。
        let _ = target.save();
    }
    let _ = save_checkpoint(&base, &id, offset, &projection);
    Ok(events)
}
fn save_source(base: &Path, id: &str, source: &Source) -> Result<(), String> {
    crate::sys::write_atomic(
        &source_path(base, id),
        &serde_json::to_string(source).map_err(|e| e.to_string())?,
    )
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct ProjectionState {
    pending_task_creates: HashMap<String, Value>,
    #[serde(default)]
    codex_parent: Option<String>,
    #[serde(default)]
    codex_snapshot_depth: u32,
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
            if let Some(projection) = event["data"].get("projection") {
                state = serde_json::from_value(projection.clone()).map_err(|e| e.to_string())?;
            }
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
        projection: projection.clone(),
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

/// 按需同步 Claude 子代理的原生历史记录（从父会话关联目录下的 subagents 提取）。
/// 同一 ID 的补全文写回实时 runId，避免前端以 runId:id 生成第二个气泡。
fn sync_claude_source(target: &mut Store, source: &Source, parent_native: &str, finished: bool) -> Result<Vec<super::events::Event>, String> {
    let base = target.dir.parent().ok_or("子会话路径无效")?.to_path_buf();
    let id = target.meta.session_id.clone();
    save_source(&base, &id, source)?;
    if target.meta.native_id.as_deref() != Some(&source.native_id) { target.bind(source.native_id.clone())?; }
    let (mut offset, mut projection) = checkpoint(&base, &id)?;
    let length = fs::metadata(&source.path).map_err(|e| e.to_string())?.len();
    if length > MAX_FILE || length < offset { return Err("子代理历史过大或已被截断；保留现有镜像".into()); }

    // 镜像包含实时及旧版原生事件；按公开消息/工具 ID 合并，不以日志大小猜测完整性。
    let mut seen: HashMap<(String, String), (String, Value)> = HashMap::new();
    let mut task_prompt = None;
    let mut mirror = BufReader::new(File::open(target.dir.join("events.jsonl")).map_err(|e| e.to_string())?);
    while let Some((event, _)) = bounded_line(&mut mirror)? {
        let data = &event["data"];
        let kind = match event["kind"].as_str().unwrap_or("") { "text" => "message", "reasoning_delta" => "reasoning", kind => kind };
        if event["kind"] == "user" && data["agentTask"] == true { task_prompt = data["text"].as_str().map(str::to_owned); }
        let Some(key) = data["id"].as_str() else { continue; };
        let entry = seen.entry((kind.to_owned(), key.to_owned())).or_insert_with(|| (event["runId"].as_str().unwrap_or("native").to_owned(), json!({})));
        if let Some(fields) = data.as_object() {
            for (field, value) in fields {
                if matches!(event["kind"].as_str(), Some("text" | "reasoning_delta")) && field == "text" {
                    let text = format!("{}{}", entry.1["text"].as_str().unwrap_or(""), value.as_str().unwrap_or(""));
                    entry.1["text"] = json!(text);
                } else { entry.1[field] = value.clone(); }
            }
        }
    }
    let mut file = File::open(&source.path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file.take(length - offset));
    let mut emitted = vec![];
    let mut batch = vec![];
    let mut batch_run = "native".to_owned();
    while let Some((value, count)) = bounded_line(&mut reader)? {
        let seed = offset;
        offset += count;
        // 子文件仍记录父 sessionId；串错文件必须报错而不是静默推进游标。
        if value["sessionId"].as_str().is_some_and(|session| session != parent_native)
            || value["cwd"].as_str().is_some_and(|cwd| !same_root(cwd, &source.workspace)) {
            return Err("子代理历史归属不一致".into());
        }
        for (kind, mut data) in project_sidechain(Provider::Claude, &value, seed, &mut projection) {
            if kind == "user" && seed == 0 && task_prompt.as_deref().is_some_and(|prompt| data["text"].as_str().is_some_and(|text| text == prompt || text.chars().take(4000).collect::<String>() == prompt)) { continue; }
            let mut run = "native".to_owned();
            if let Some(key) = data["id"].as_str().map(str::to_owned) {
                let identity = (kind.clone(), key);
                if let Some((existing_run, existing)) = seen.get(&identity) {
                    run = existing_run.clone();
                    if kind == "message" || kind == "reasoning" {
                        let text = data["text"].as_str().unwrap_or("");
                        if existing["text"].as_str().is_some_and(|old| old == text || old.starts_with(text)) { continue; }
                    } else if kind == "tool" {
                        // 原生 recorded 不能覆盖实时 completed；只补缺失/变化的协议字段。
                        if let Some(fields) = data.as_object_mut() {
                            fields.retain(|field, value| !value.is_null() && existing.get(field) != Some(value) && !(field == "status" && value == "recorded"));
                            if fields.keys().all(|field| field == "id") || fields.is_empty() { continue; }
                        }
                        data["id"] = identity.1.clone().into();
                    }
                }
                let entry = seen.entry(identity).or_insert_with(|| (run.clone(), json!({})));
                if let Some(fields) = data.as_object() { for (field, value) in fields { entry.1[field] = value.clone(); } }
            }
            if run != batch_run || batch.len() >= 128 {
                if !batch.is_empty() { emitted.extend(target.append(&batch_run, std::mem::take(&mut batch))?); }
                batch_run = run;
            }
            batch.push((kind, data));
        }
    }
    if !batch.is_empty() { emitted.extend(target.append(&batch_run, batch)?); }
    let previous = checkpoint(&base, &id)?.0;
    if offset != previous {
        emitted.extend(target.append("native", vec![("history_checkpoint".into(), json!({"offset":offset,"projection":projection}))])?);
        let _ = save_checkpoint(&base, &id, offset, &projection);
    }
    // finished 是完成凭据；半行尚未落齐时不结算，也不覆盖协议给出的 failed/stopped。
    if finished && offset == length {
        if let Some(info) = target.meta.agent.as_mut() {
            if matches!(info.status.as_str(), "" | "starting" | "running") {
                info.status = "completed".into();
                info.ended_at = Some(super::now_ms());
                let data = json!({"key":info.tool_id,"sessionId":id,"status":"completed","imported":true});
                emitted.extend(target.append("native", vec![("agent".into(), data)])?);
                target.save()?;
            }
        }
    }
    Ok(emitted)
}

fn sync_claude_subagent(
    base: &Path,
    child_id: &str,
    meta: &store::Metadata,
    root: &str,
) -> Result<bool, String> {
    let parent_id = meta.parent_session_id.as_deref().unwrap_or_default();
    if parent_id.is_empty() { return Ok(false); }
    let Some(agent) = &meta.agent else { return Ok(false); };

    // 获取父会话原生 ID：优先读取父会话 metadata.native_id，若无再从 native-source 查
    let source_opt = source(base, parent_id, root).ok().flatten();
    let parent_meta = Store::metadata(&base.join(parent_id), root).ok();
    let parent_native_id = parent_meta
        .as_ref()
        .and_then(|m| m.native_id.clone())
        .or_else(|| source_opt.as_ref().map(|s| s.native_id.clone()));
    let Some(parent_native_id) = parent_native_id else { return Ok(false); };

    // 收集所有可能的 subagents 目录路径（包含本地创建与外部发现的项目目录）
    let mut candidate_dirs = Vec::new();
    if let Some(src) = &source_opt {
        if let Some(parent) = src.path.parent() {
            candidate_dirs.push(parent.join(&parent_native_id).join("subagents"));
            candidate_dirs.push(parent.join("subagents"));
        }
    }
    if let Ok(all_roots) = roots() {
        for (provider, projects_dir) in all_roots {
            if provider == Provider::Claude && projects_dir.is_dir() {
                if let Ok(entries) = fs::read_dir(&projects_dir) {
                    for entry in entries.flatten() {
                        let project_path = entry.path();
                        if project_path.is_dir() {
                            candidate_dirs.push(project_path.join(&parent_native_id).join("subagents"));
                            candidate_dirs.push(project_path.join("subagents"));
                        }
                    }
                }
            }
        }
    }

    for subagents_dir in candidate_dirs {
        if !subagents_dir.is_dir() { continue; }
        let Ok(entries) = fs::read_dir(&subagents_dir) else { continue; };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.extension().is_some_and(|extension| extension == "jsonl") { continue; }
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("agent-") { continue; }
            let agent_id = name.trim_start_matches("agent-").trim_end_matches(".jsonl").to_owned();
            if agent_id.is_empty() { continue; }
            let info: Value = fs::read(path.with_file_name(format!("agent-{agent_id}.meta.json")))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or(Value::Null);
            let key = info["toolUseId"].as_str().filter(|v| !v.is_empty()).unwrap_or(&agent_id);
            if key != agent.tool_id && Some(&agent_id) != agent.native_agent_id.as_ref() {
                continue;
            }

            let title = info["description"].as_str().map(str::trim).filter(|text| !text.is_empty()).unwrap_or(&meta.title).to_owned();
            let mut target = Store::open_for_append(base, child_id, root, Provider::Claude, &title, "")?;
            let source = Source { provider: Provider::Claude, native_id: agent_id, path, workspace: root.to_owned() };
            return Ok(!sync_claude_source(&mut target, &source, &parent_native_id, info["finished"] == true)?.is_empty());
        }
    }
    Ok(false)
}

/// 按需同步子代理（Claude/Codex）的原生历史 rollout。
pub fn sync_subagent(base: &Path, id: &str, root: &str) -> Result<bool, String> {
    let dir = base.join(id);
    let Ok(meta) = Store::metadata(&dir, root) else { return Ok(false); };
    if meta.provider == Provider::Claude {
        return sync_claude_subagent(base, id, &meta, root);
    }
    Ok(!sync_codex_subagent(base, id, root, true, true)?.is_empty())
}

/// 已定位的 rollout 只 seek 新增尾部；找不到路径时由 Worker 限频允许发现扫描。
pub fn sync_codex_subagent(base: &Path, id: &str, root: &str, discover: bool, drain: bool) -> Result<Vec<super::events::Event>, String> {
    let meta = Store::metadata(&base.join(id), root)?;
    if meta.provider != Provider::Codex { return Ok(vec![]); }
    let Some(agent) = &meta.agent else { return Ok(vec![]); };
    if agent.tool_id.is_empty() { return Ok(vec![]); }
    if let Some(source) = source(base, id, root)? {
        let mut target = Store::open(base, id, root, Provider::Codex, &meta.title, "")?;
        let follow_lifecycle = !meta.parent_session_id.as_deref().is_some_and(|parent| super::registry::for_session(parent).is_some());
        let mut events = vec![];
        loop {
            let batch = match poll_codex_subagent(&mut target, &source, follow_lifecycle) {
                Ok(batch) => batch,
                // 前批已经持久化，必须先交给调用方广播；错误留到下一次空批重试报告。
                Err(_) if !events.is_empty() => return Ok(events),
                Err(error) => return Err(error),
            };
            let done = batch.is_empty();
            events.extend(batch);
            if !drain || done { return Ok(events); }
        }
    }
    if !discover || meta.native_id.as_deref() == Some(&agent.tool_id) { return Ok(vec![]); }
    let Some(sessions_dir) = roots()?.into_iter().find_map(|(p, d)| if p == Provider::Codex { Some(d) } else { None }) else {
        return Ok(vec![]);
    };
    let mut target_path = None;
    // 与 discover 同一预算：大历史目录下 5000 可能扫不到子代理的 rollout，回填就静默失败。
    let mut budget = 30000usize;
    let mut paths = vec![];
    let _ = files(&sessions_dir, 4, &mut budget, &mut paths);
    for path in paths {
        if path.file_name().and_then(|n| n.to_str()).is_some_and(|name| name.contains(&agent.tool_id)) {
            target_path = Some(path);
            break;
        }
    }
    let Some(path) = target_path else { return Ok(vec![]); };
    let parent_id = meta.parent_session_id.clone().unwrap_or_default();
    let known = std::collections::HashMap::new();
    let mut known_subagents = std::collections::HashMap::new();
    known_subagents.insert(agent.tool_id.clone(), (id.to_string(), parent_id));
    import_codex_subagent(base, &path, root, &known, &known_subagents);
    // 运行中 importer 只登记路径，由本调用消费并返回可广播事件。
    if source(base, id, root)?.is_none() { return Ok(vec![]); }
    sync_codex_subagent(base, id, root, false, drain)
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
    fn codex_subagent_history_fills_an_existing_live_session() {
        let temp = std::env::temp_dir().join(format!(
            "forge-history-codex-subagent-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = temp.join("project");
        let base = temp.join("mirror");
        let native = temp.join("subagent.jsonl");
        for path in [&root, &base] { fs::create_dir_all(path).unwrap(); }
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let parent_native = "01a-parent";
        let parent_forge = "parent-forge";
        let child_native = "01a-child";

        let mut parent = Store::open(&base, parent_forge, &workspace, Provider::Codex, "父会话", "").unwrap();
        parent.bind(parent_native.into()).unwrap();
        let child = super::super::child_session_id(parent_forge, child_native);
        let mut live = Store::open(&base, &child, &workspace, Provider::Codex, "review backend", "").unwrap();
        live.meta.parent_session_id = Some(parent_forge.into());
        live.meta.agent = Some(store::AgentInfo {
            title: "review backend".into(),
            tool_id: child_native.into(),
            status: "running".into(),
            agent_type: Some("Kepler".into()),
            ..Default::default()
        });
        live.save().unwrap();

        // 当前 Codex 的首条 meta 本身就是子代理；父线程只存在于 thread_spawn 中。
        let records = [
            json!({"type":"session_meta","payload":{"id":child_native,"cwd":root,"source":{"subagent":{"thread_spawn":{
                "parent_thread_id":parent_native,"agent_path":"/root/backend_trace","agent_nickname":"审查者"
            }}}}}),
            // fork_turns=all 会把父线程快照接在子 meta 后，以 turn_aborted 封口。
            json!({"type":"session_meta","payload":{"id":parent_native,"cwd":root,"source":"vscode"}}),
            // 父代理也可能 fork 过祖先；内层封口不能提前结束外层父快照。
            json!({"type":"session_meta","payload":{"id":"grandparent","cwd":root,"source":"vscode"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"祖先消息"}]}}),
            json!({"type":"turn_aborted"}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","id":"parent-u","content":[{"type":"input_text","text":"父会话内容"}]}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","id":"parent-a","content":[{"type":"output_text","text":"父会话回复"}]}}),
            json!({"type":"event_msg","payload":{"type":"task_complete"}}),
            json!({"type":"turn_aborted"}),
            json!({"type":"event_msg","payload":{"type":"task_started"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","id":"u1","content":[{"type":"input_text","text":"检查导入链路"}]}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","id":"a1","content":[{"type":"output_text","text":"链路正常"}]}}),
            json!({"type":"event_msg","payload":{"type":"task_complete"}}),
        ];
        let known = HashMap::from([(binding_key(Provider::Codex, parent_native), parent_forge.into())]);

        // 父快照跨轮询，且旁路缓存损坏时，恢复后仍不能泄漏父消息或父终态。
        fs::write(&native, records[..4].iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n").unwrap();
        import_codex_subagent(&base, &native, &workspace, &known, &HashMap::new());
        fs::write(checkpoint_path(&base, &child), "invalid cache").unwrap();
        let answer_index = records.len() - 2;
        let partial = records[answer_index].to_string();
        fs::write(&native, records[..answer_index].iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n" + &partial[..30]).unwrap();
        import_codex_subagent(&base, &native, &workspace, &known, &HashMap::new());
        let page = Store::page(&base, &child, &workspace, Window::After(0), 100, true).unwrap();
        assert_eq!(page.events.iter().filter(|event| event.kind == "user").count(), 1);
        assert!(!page.events.iter().any(|event| event.kind == "message" || event.data["status"] == "completed"));

        // 父快照里的终态不能污染子代理；正文应在子回合结束前就可读取。
        fs::write(&native, records[..records.len() - 1].iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n").unwrap();
        import_codex_subagent(&base, &native, &workspace, &known, &HashMap::new());
        let running = Store::metadata(&base.join(&child), &workspace).unwrap();
        assert_eq!(running.agent.unwrap().status, "running");
        assert_eq!(running.native_id.as_deref(), Some(child_native));
        let page = Store::page(&base, &child, &workspace, Window::After(0), 100, true).unwrap();
        assert!(page.events.iter().any(|event| event.kind == "message" && event.data["text"] == "链路正常"));
        assert!(!page.events.iter().any(|event| event.data["text"] == "父会话内容"));

        fs::write(&native, records.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n").unwrap();
        import_codex_subagent(&base, &native, &workspace, &known, &HashMap::new());
        // 重复发现同一份 rollout 不能把子代理对话再追加一遍。
        import_codex_subagent(&base, &native, &workspace, &known, &HashMap::new());

        let meta = Store::metadata(&base.join(&child), &workspace).unwrap();
        // agent_nickname 是随机代号，agent_path 也只是后备；必须保留实时阶段落盘的 task_name。
        assert_eq!(meta.title, "review backend");
        let agent = meta.agent.expect("agent metadata");
        assert_eq!(agent.title, "review backend");
        assert!(agent.agent_type.is_none());
        assert_eq!(agent.status, "completed");
        let page = Store::page(&base, &child, &workspace, Window::After(0), 100, false).unwrap();
        assert_eq!(page.events.iter().filter(|event| event.kind == "user" && event.data["text"] == "检查导入链路").count(), 1);
        assert_eq!(page.events.iter().filter(|event| event.kind == "message" && event.data["text"] == "链路正常").count(), 1);
        assert!(!page.events.iter().any(|event| matches!(event.data["text"].as_str(), Some("父会话内容" | "父会话回复" | "祖先消息"))));

        // 终态后迟到的输出仍能增量广播；同一子线程续聊会重新进入 running。
        let late = json!({"type":"response_item","payload":{"type":"message","role":"assistant","id":"late","content":[{"type":"output_text","text":"迟到的正文"}]}});
        let complete = records.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n";
        let started = json!({"type":"event_msg","payload":{"type":"task_started"}}).to_string() + "\n";
        let complete = complete + &started + &late.to_string() + "\n";
        fs::write(&native, &complete).unwrap();
        let (run, _) = super::super::registry::Run::reserve("codex-history-live".into(), parent_forge.into(), workspace.clone(), workspace.clone()).unwrap();
        // 列表发现不能抢 Worker 游标；延迟的 task_started 也不能覆盖协议已知终态。
        import_codex_subagent(&base, &native, &workspace, &known, &HashMap::new());
        let page = Store::page(&base, &child, &workspace, Window::After(0), 100, false).unwrap();
        assert!(!page.events.iter().any(|event| event.data["text"] == "迟到的正文"));
        let events = sync_codex_subagent(&base, &child, &workspace, false, false).unwrap();
        assert_eq!(events.iter().filter(|event| event.kind == "message" && event.data["text"] == "迟到的正文").count(), 1);
        assert!(!events.iter().any(|event| event.kind == "agent"));
        assert_eq!(Store::metadata(&base.join(&child), &workspace).unwrap().agent.unwrap().status, "completed");
        assert!(sync_codex_subagent(&base, &child, &workspace, false, false).unwrap().is_empty());
        run.finish();
        let mut resumed = complete + &started;
        fs::write(&native, &resumed).unwrap();
        let events = sync_codex_subagent(&base, &child, &workspace, false, false).unwrap();
        assert!(events.iter().any(|event| event.kind == "agent" && event.data["status"] == "running"));
        assert_eq!(Store::metadata(&base.join(&child), &workspace).unwrap().agent.unwrap().status, "running");

        // 多批收尾后遇到坏行，仍要返回已提交批供广播；修复坏行后接着读，不重复。
        for index in 0..130 {
            resumed.push_str(&json!({"type":"response_item","payload":{"type":"message","role":"assistant","id":format!("batch-{index}"),"content":[{"type":"output_text","text":"分批正文"}]}}).to_string());
            resumed.push('\n');
        }
        fs::write(&native, resumed.clone() + "{broken}\n").unwrap();
        let committed = sync_codex_subagent(&base, &child, &workspace, false, true).unwrap();
        assert_eq!(committed.iter().filter(|event| event.kind == "message").count(), 128);
        assert!(sync_codex_subagent(&base, &child, &workspace, false, true).is_err());
        fs::write(&native, resumed).unwrap();
        let remaining = sync_codex_subagent(&base, &child, &workspace, false, true).unwrap();
        assert_eq!(remaining.iter().filter(|event| event.kind == "message").count(), 2);
        // 原生日志被截断必须报错，已有正文不能被清空或从头重复导入。
        fs::write(&native, "{}\n").unwrap();
        assert!(sync_codex_subagent(&base, &child, &workspace, false, false).is_err());
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn unfinished_claude_subagent_is_never_imported() {
        let temp = std::env::temp_dir().join(format!(
            "forge-history-claude-subagent-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = temp.join("project");
        let base = temp.join("mirror");
        let native = temp.join("native");
        for path in [&root, &base] { fs::create_dir_all(path).unwrap(); }
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let parent_forge = "claude-parent";
        let parent_native = "claude-native-parent";
        let mut parent = Store::open(&base, parent_forge, &workspace, Provider::Claude, "父会话", "").unwrap();
        parent.bind(parent_native.into()).unwrap();

        let subagents = native.join(parent_native).join("subagents");
        fs::create_dir_all(&subagents).unwrap();
        // native_path 的契约是「父会话自己的 jsonl 文件」：project_dir 取它的父目录。
        let native_path = native.join("session.jsonl");
        let lines = [
            json!({"type":"user","sessionId":parent_native,"isSidechain":true,"message":{"role":"user","content":"从 1 输出到 100"}}),
            json!({"type":"assistant","sessionId":parent_native,"isSidechain":true,"message":{"id":"child-a","content":[{"type":"text","text":"1 到 100 输出完毕"}]}}),
        ];
        fs::write(subagents.join("agent-abc123.jsonl"), lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n").unwrap();

        // 未完成（finished 缺失/false）不导入：半截正文一旦落盘就永远冻住。
        fs::write(subagents.join("agent-abc123.meta.json"), json!({
            "toolUseId":"toolu_01","agentType":"general-purpose","description":"输出数字","finished":false
        }).to_string()).unwrap();
        import_claude_subagents(&base, parent_forge, &native_path, parent_native, &workspace);
        assert!(!base.join(super::super::child_session_id(parent_forge, "toolu_01")).exists());

        // meta 缺失同样不导入：toolUseId 提不出来，派生的目录名会和 live 路由对不上。
        fs::remove_file(subagents.join("agent-abc123.meta.json")).unwrap();
        import_claude_subagents(&base, parent_forge, &native_path, parent_native, &workspace);
        assert!(!base.join(super::super::child_session_id(parent_forge, "toolu_01")).exists());

        // 终态出现后正常导入；重复发现不再追加第二遍。
        fs::write(subagents.join("agent-abc123.meta.json"), json!({
            "toolUseId":"toolu_01","agentType":"general-purpose","description":"输出数字","finished":true
        }).to_string()).unwrap();
        import_claude_subagents(&base, parent_forge, &native_path, parent_native, &workspace);
        import_claude_subagents(&base, parent_forge, &native_path, parent_native, &workspace);

        let child = super::super::child_session_id(parent_forge, "toolu_01");
        let meta = Store::metadata(&base.join(&child), &workspace).unwrap();
        assert_eq!(meta.parent_session_id.as_deref(), Some(parent_forge));
        let agent = meta.agent.expect("agent metadata");
        assert_eq!(agent.tool_id, "toolu_01");
        assert_eq!(agent.status, "completed");
        assert_eq!(agent.agent_type.as_deref(), Some("general-purpose"));
        let page = Store::page(&base, &child, &workspace, Window::After(0), 100, false).unwrap();
        assert_eq!(page.events.iter().filter(|event| event.kind == "user" && event.data["text"] == "从 1 输出到 100").count(), 1);
        assert_eq!(page.events.iter().filter(|event| event.kind == "message" && event.data["text"] == "1 到 100 输出完毕").count(), 1);
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn claude_subagent_history_fills_an_existing_live_session() {
        let temp = std::env::temp_dir().join(format!(
            "forge-history-claude-live-subagent-{}",
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
        let parent_forge = "claude-parent-live";
        let parent_native = "claude-native-live";
        let mut parent = Store::open(&base, parent_forge, &workspace, Provider::Claude, "父会话", "").unwrap();
        parent.bind(parent_native.into()).unwrap();

        // 模拟真实 Claude projects 目录结构，且父会话绝不落盘 native-source.json（纯本地新建会话场景）
        let claude_home = temp.join("claude_home");
        let project_dir = claude_home.join("projects").join("dummy-project");
        let subagents = project_dir.join(parent_native).join("subagents");
        fs::create_dir_all(&subagents).unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", &claude_home);

        // 模拟 live 阶段预先创建了空子代理会话
        let tool_id = "toolu_live_99";
        let child = super::super::child_session_id(parent_forge, tool_id);
        let mut child_store = Store::open(&base, &child, &workspace, Provider::Claude, "子代理任务", "").unwrap();
        child_store.meta.parent_session_id = Some(parent_forge.into());
        child_store.meta.agent = Some(store::AgentInfo {
            native_agent_id: Some("agent-live-1".into()),
            agent_type: Some("general-purpose".into()),
            title: "子代理任务".into(),
            tool_id: tool_id.into(),
            model: None,
            status: "running".into(),
            started_at: 100,
            ended_at: None,
        });
        child_store.save().unwrap();

        // 准备 Claude CLI 落盘的子代理 native 文件到 Claude 项目目录下
        let lines = [
            json!({"type":"user","sessionId":parent_native,"isSidechain":true,"message":{"role":"user","content":"执行子任务"}}),
            json!({"type":"assistant","sessionId":parent_native,"isSidechain":true,"message":{"id":"m-1","content":[{"type":"text","text":"子任务完成"}]}}),
        ];
        fs::write(subagents.join("agent-live-1.jsonl"), lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n").unwrap();
        fs::write(subagents.join("agent-live-1.meta.json"), json!({
            "toolUseId": tool_id, "agentType": "general-purpose", "description": "执行子任务", "finished": true
        }).to_string()).unwrap();

        // 按需同步执行回填
        let synced = sync_claude_subagent(&base, &child, &child_store.meta, &workspace).unwrap();
        assert!(synced, "应成功同步子代理历史");

        // 再次同步应被幂等保护忽略
        let meta_after = Store::metadata(&base.join(&child), &workspace).unwrap();
        assert_eq!(meta_after.agent.as_ref().unwrap().status, "completed");
        let synced_again = sync_claude_subagent(&base, &child, &meta_after, &workspace).unwrap();
        assert!(!synced_again, "重复同步不应重复追加");

        let page = Store::page(&base, &child, &workspace, Window::After(0), 100, false).unwrap();
        assert_eq!(page.events.iter().filter(|e| e.kind == "user" && e.data["text"] == "执行子任务").count(), 1);
        assert_eq!(page.events.iter().filter(|e| e.kind == "message" && e.data["text"] == "子任务完成").count(), 1);
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn subagent_import_skips_tombstoned_parents() {
        let temp = std::env::temp_dir().join(format!(
            "forge-history-subagent-tombstone-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = temp.join("project");
        let base = temp.join("mirror");
        let native = temp.join("subagent.jsonl");
        for path in [&root, &base] { fs::create_dir_all(path).unwrap(); }
        let workspace = store::workspace(root.to_str().unwrap()).unwrap();
        let parent_forge = "deleted-parent";
        let child_native = "01a-child";
        {
            let _io = store::IO_LOCK.lock().unwrap();
            store::record_tombstone(&base, parent_forge).unwrap();
        }
        let records = [
            json!({"type":"session_meta","payload":{"id":child_native,"cwd":root,"source":{"subagent":{"thread_spawn":{
                "parent_thread_id":"01a-parent","agent_path":"/root/backend_trace"
            }}}}}),
            json!({"type":"event_msg","payload":{"type":"task_complete"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","id":"a1","content":[{"type":"output_text","text":"孤儿不应复活"}]}}),
        ];
        fs::write(&native, records.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n").unwrap();
        let known = HashMap::from([(binding_key(Provider::Codex, "01a-parent"), parent_forge.into())]);
        import_codex_subagent(&base, &native, &workspace, &known, &HashMap::new());
        assert!(!base.join(super::super::child_session_id(parent_forge, child_native)).exists(), "已删除父会话的子代理不得被回填重建");
        fs::remove_dir_all(temp).unwrap();
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
