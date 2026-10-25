//! 会话正文搜索：直接扫 Forge 的 JSONL 原文，不另建倒排索引。
//!
//! 为什么不建索引：事件日志是唯一的真相。索引一旦和日志不同步，搜到的就是一句
//! 实际上没人说过的话；而这份日志是追加式的，还可能被判定损坏后只读，同步点很多。
//! 代价是每次搜索都要扫一遍，所以把扫描量钉死在几个上限里，并在结果里如实说明
//! 「没扫完」，而不是让用户以为这就是全部结果。
//!
//! 匹配规则只对 ASCII 大小写不敏感：折叠一个 ASCII 字节仍是一个字节，偏移量永远
//! 对得上原文。其他文字按原样比较——中文没有大小写，而少数语言的大小写变体会改变
//! 字节长度，宁可漏一条匹配，也不能把片段切错位置、假装它匹配过。

use super::events::Event;
use super::store;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::Path;

/// 最多扫这么多个会话目录。
const MAX_SESSIONS: usize = 2000;
/// 单个会话最多读这么多字节日志；读到上限就停，并说明这个会话没扫完。
const MAX_SESSION_BYTES: u64 = 32 * 1024 * 1024;
/// 一次搜索最多读这么多字节；用完后剩余会话不再打开，整体标记为不完整。
const MAX_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
/// 合并流式分段后，单个会话可搜索文本的总量上限。
const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;
/// 命中片段左右各保留这么多字符：搜索结果不该变成第二份聊天记录。
const SNIPPET_PADDING: usize = 60;
/// 单个会话最多贡献几条命中，免得一条长对话挤掉其他会话。
const HITS_PER_SESSION: usize = 5;
/// 一次返回的命中上限；前端也按这个数量画列表。
pub const MAX_HITS: usize = 200;

/// 只折叠 ASCII 大写，长度与逐字节对齐都有保证。
fn fold(value: &str) -> String {
    // 折叠后仍是合法 UTF-8：非 ASCII 字节一律原样保留，所以一个折叠字节正好对应
    // 原文一个字节，`find` 返回的偏移可以直接当原文的字节索引用。
    let folded: Vec<u8> = value.bytes().map(|byte| byte.to_ascii_lowercase()).collect();
    String::from_utf8(folded).unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
}

/// 一条命中片段：`text` 是截过窗口的原文，`start`/`length` 标出命中在 `text` 里的位置。
///
/// 偏移按 UTF-16 码元计数——那正是前端 JS `slice` 用的单位。emoji 这类增补字符在
/// JS 里占两格、在 Rust 的 `chars()` 里占一个，所以必须按前端的世界来报数，
/// 否则高亮会切歪半格。
#[derive(Debug, PartialEq)]
pub struct Snippet {
    pub text: String,
    pub start: usize,
    pub length: usize,
    /// 片段前面还有没显示出来的内容。
    pub leading: bool,
    pub trailing: bool,
}

fn units(value: &[char]) -> usize {
    value.iter().map(|c| c.len_utf16()).sum()
}

/// 找出第一条匹配。空白查询不算匹配，免得整段正文被当成命中刷屏。
pub fn find_snippet(text: &str, needle: &str) -> Option<Snippet> {
    let needle = needle.trim();
    if needle.is_empty() {
        return None;
    }
    let byte = fold(text).find(&fold(needle))?;
    let chars: Vec<char> = text.chars().collect();
    // 折叠逐字节对齐，且命中的首字节不可能是 UTF-8 续字节，所以这里落在字符起点上。
    let before = text[..byte].chars().count();
    let matched = needle.chars().count();
    let start = before.saturating_sub(SNIPPET_PADDING);
    let end = (before + matched + SNIPPET_PADDING).min(chars.len());
    Some(Snippet {
        text: chars[start..end].iter().collect(),
        start: units(&chars[start..before]),
        length: units(&chars[before..before + matched]),
        leading: start > 0,
        trailing: end < chars.len(),
    })
}

/// 一段可搜索正文：从哪个序号开始、属于哪一类内容、拼好的文本。
struct Fragment {
    seq: u64,
    kind: String,
    text: String,
}

/// 事件里有没有可搜索的正文。工具入参与返回不算正文：那里搜出来的是 JSON 噪声。
fn fragment(event: &Event) -> Option<Fragment> {
    let text = event.data["text"].as_str()?;
    // user 记录里的系统注入不是正文：搜出来的是 CLI 自己写的提示词，
    // 点进去还会跳到一条界面上根本不存在的气泡。
    let text = match event.kind.as_str() {
        "user" => super::history::human_text(text)?,
        _ => text.to_owned(),
    };
    Some(Fragment {
        seq: event.seq,
        kind: event.kind.clone(),
        text,
    })
}

/// 和前端 `key` 同意的合并身份：同一轮里同一个 `id` 就是同一段话。
fn merge_key(event: &Event) -> String {
    match event.data["id"].as_str() {
        Some(id) => format!("{}:{id}", event.run_id),
        None => format!("{}:seq:{}", event.run_id, event.seq),
    }
}

/// 完整快照覆盖先前内容；增量分段接在后面。与前端 `aiRuntime.ts` 的合并规则一致。
fn replaces(kind: &str, append: Option<bool>) -> bool {
    matches!(kind, "message" | "command_output") || (kind != "text" && kind != "reasoning_delta" && append != Some(true))
}

/// 按序号顺序拼出一个会话的可搜索正文；返回读到的字节数和有没有读到底。
fn texts(path: &Path, max_bytes: u64) -> Result<(Vec<Fragment>, u64, bool), String> {
    let mut merged: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<Fragment> = Vec::new();
    let mut used: usize = 0;
    let mut read: u64 = 0;
    let mut truncated = false;
    let file = match File::open(path) {
        Ok(file) => file,
        // 还没写过事件的会话没有日志，这不是错误。
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((out, read, truncated)),
        Err(error) => return Err(error.to_string()),
    };
    let mut reader = BufReader::new(file);
    loop {
        let mut line = String::new();
        let size = reader.read_line(&mut line).map_err(|e| e.to_string())? as u64;
        if size == 0 {
            break;
        }
        read += size;
        if read > max_bytes {
            truncated = true;
            break;
        }
        // 坏行跳过：搜索不该因为一条写坏的历史整体失败。
        let Ok(event) = serde_json::from_str::<Event>(&line) else { continue };
        let Some(piece) = fragment(&event) else { continue };
        if piece.text.is_empty() {
            continue;
        }
        if used + piece.text.len() > MAX_TEXT_BYTES {
            truncated = true;
            break;
        }
        let key = merge_key(&event);
        used += piece.text.len();
        match merged.get(&key) {
            Some(index) => {
                let item = &mut out[*index];
                if replaces(&event.kind, event.data["append"].as_bool()) {
                    used -= item.text.len();
                    item.text = piece.text;
                } else {
                    item.text.push_str(&piece.text);
                }
            }
            None => {
                merged.insert(key, out.len());
                out.push(piece);
            }
        }
    }
    // 从原生日志捞回来的压缩摘要在读事件的那一层已经并进了它发生的位置，正文搜索扫的是原文，
    // 所以命中要按同一份口径改报到那一条上：否则点进去跳的是一条界面上根本不存在的卡片。
    // 只有真出现过压缩正文的会话才值得为这件事再扫一遍。
    if out.iter().any(|piece| piece.kind == "compaction") {
        let fold = store::compaction_fold(path);
        if !fold.merged.is_empty() {
            for piece in out.iter_mut() {
                if let Some(anchor) = fold.merged.get(&piece.seq) {
                    piece.seq = *anchor;
                }
            }
            out.sort_by_key(|piece| piece.seq);
        }
    }
    Ok((out, read, truncated))
}

/// 在一个会话目录里搜索。调用方已经确认过元数据与项目归属。
fn session(dir: &Path, meta: &store::Metadata, needle: &str, limit: usize) -> Option<Value> {
    let (fragments, read, truncated) =
        texts(&dir.join("events.jsonl"), MAX_SESSION_BYTES).ok()?;
    let mut hits = vec![];
    for piece in fragments {
        let Some(snippet) = find_snippet(&piece.text, needle) else { continue };
        hits.push(json!({
            "sessionId": meta.session_id,
            "sessionTitle": meta.title,
            "provider": meta.provider,
            "createdAt": meta.created_at,
            "seq": piece.seq,
            "kind": piece.kind,
            "text": snippet.text,
            "start": snippet.start,
            "length": snippet.length,
            "leading": snippet.leading,
            "trailing": snippet.trailing,
        }));
        if hits.len() >= limit.min(HITS_PER_SESSION) {
            break;
        }
    }
    Some(json!({"hits": hits, "bytes": read, "truncated": truncated}))
}

/// 扫描这个项目下的全部会话正文。`truncated` 为真时，界面必须说明结果不全。
/// `scanned` 只数真正读过的本项目会话；`skipped` 是读不出归属或已损坏的目录数。
pub fn search(
    base: &Path,
    root: &str,
    query: &str,
    limit: usize,
    include_archived: bool,
) -> Result<Value, String> {
    let needle = query.trim();
    if needle.is_empty() || needle.chars().count() > 200 {
        return Err("请输入 1 到 200 个字符的搜索内容".into());
    }
    let limit = limit.clamp(1, MAX_HITS);
    let mut scanned = 0;
    let mut skipped = 0;
    let mut bytes = 0_u64;
    let mut truncated = false;
    let mut hits: Vec<Value> = vec![];
    let entries = match fs::read_dir(base) {
        Ok(entries) => entries,
        // 目录还不存在只是说明还没有会话，不是搜索失败。
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({"hits": [], "scanned": 0, "skipped": 0, "bytes": 0, "truncated": false}))
        }
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries.take(MAX_SESSIONS) {
        let entry = entry.map_err(|e| e.to_string())?;
        let dir = entry.path();
        // 会话目录以 id 命名且必有 meta.json；锁文件、原生历史镜像都靠这一步排除，
        // 否则它们会被当成「读不出归属」的会话，虚报 skipped。
        if !store::valid_id(&entry.file_name().to_string_lossy())
            || !dir.join("meta.json").exists()
        {
            continue;
        }
        let Ok(meta) = store::Store::metadata(&dir, root) else {
            // 归属性别的项目、或元数据坏了：没查过就是没查过，不能谎称扫完。
            skipped += 1;
            continue;
        };
        if meta.archived && !include_archived {
            continue;
        }
        if bytes >= MAX_TOTAL_BYTES || hits.len() >= limit {
            truncated = true;
            break;
        }
        scanned += 1;
        let Some(found) = session(&dir, &meta, needle, limit - hits.len()) else {
            skipped += 1;
            continue;
        };
        bytes += found["bytes"].as_u64().unwrap_or_default();
        truncated |= found["truncated"].as_bool().unwrap_or_default();
        if let Some(items) = found["hits"].as_array() {
            hits.extend(items.iter().cloned());
        }
    }
    // 最近的会话排前面：搜索结果首先是「我最近在聊的那件事」。
    hits.sort_by_key(|hit| std::cmp::Reverse(hit["createdAt"].as_u64().unwrap_or_default()));
    hits.truncate(limit);
    Ok(json!({"hits": hits, "scanned": scanned, "skipped": skipped, "bytes": bytes, "truncated": truncated}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_cli::Provider;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "forge-runtime-search-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn hits(value: &Value) -> usize {
        value["hits"].as_array().unwrap().len()
    }

    #[test]
    fn matching_is_ascii_case_insensitive_without_losing_offsets() {
        let snippet = find_snippet("Please FIX the build", "fix").unwrap();
        assert_eq!(snippet.text, "Please FIX the build");
        assert_eq!(snippet.start, 7);
        assert_eq!(snippet.length, 3);
        assert!(!snippet.leading && !snippet.trailing);
        assert_eq!(find_snippet("中文里的 CODE 关键字", "code").unwrap().start, 5);
        // 非 ASCII 按原样比较：不猜变体，也不切错位置。
        assert!(find_snippet("İstanbul", "istanbul").is_none());
        assert!(find_snippet("hello", "").is_none());
        assert!(find_snippet("hello", "   ").is_none());
    }

    #[test]
    fn long_hits_are_windowed_and_marked_as_cut() {
        let text = "头".repeat(200) + "找这里" + &"尾".repeat(200);
        let snippet = find_snippet(&text, "找这里").unwrap();
        assert_eq!(snippet.length, 3);
        assert!(snippet.leading && snippet.trailing);
        assert_eq!(snippet.text.chars().count(), SNIPPET_PADDING + 3 + SNIPPET_PADDING);
        // 这段全是基本平面文字，码元数与字符数相同；高亮片段按前端 slice 的口径取。
        let highlighted: String = snippet
            .text
            .chars()
            .skip(snippet.start)
            .take(snippet.length)
            .collect();
        assert_eq!(highlighted, "找这里");
    }

    #[test]
    fn offsets_use_the_units_the_frontend_slices_with() {
        // 增补平面字符（emoji）在 Rust 里算一个 char，在 JS 里占两个 UTF-16 码元。
        // 偏移按码元报，前端 `text.slice(start, start + length)` 才切得准。
        fn js_slice(text: &str, start: usize, length: usize) -> String {
            let mut units = 0;
            let mut out = String::new();
            for c in text.chars() {
                let size = c.len_utf16();
                if units >= start && units < start + length {
                    out.push(c);
                }
                units += size;
                if units >= start + length {
                    break;
                }
            }
            out
        }
        let hit = find_snippet("前面😀后面 keyword 结尾", "keyword").unwrap();
        assert_eq!(js_slice(&hit.text, hit.start, hit.length), "keyword");
        let emoji = find_snippet("前面😀后面", "😀").unwrap();
        assert_eq!((emoji.start, emoji.length), (2, 2));
        assert_eq!(js_slice(&emoji.text, emoji.start, emoji.length), "😀");
    }

    #[test]
    fn streamed_reply_is_matched_as_one_sentence() {
        let p = fixture();
        let mut handle = store::Store::open(&p, "s1", "root", Provider::Codex, "标题", "1").unwrap();
        // 一次回复被拆成两条增量；按原始行匹配谁也匹配不上。
        handle
            .append(
                "r1",
                vec![
                    ("text".into(), json!({"id": "m1", "text": "编译失败的"})),
                    ("text".into(), json!({"id": "m1", "text": "原因是缺少分号"})),
                ],
            )
            .unwrap();
        let (fragments, _, _) = texts(&p.join("s1/events.jsonl"), MAX_SESSION_BYTES).unwrap();
        assert_eq!(fragments.len(), 1);
        assert_eq!(fragments[0].text, "编译失败的原因是缺少分号");
        let snippet = find_snippet(&fragments[0].text, "缺少分号").unwrap();
        assert_eq!(snippet.start, 8);
        // 这段全是基本平面文字，一个字符正好一个码元，所以 skip/take 就是前端 slice 的效果。
        let highlighted: String = snippet
            .text
            .chars()
            .skip(snippet.start)
            .take(snippet.length)
            .collect();
        assert_eq!(highlighted, "缺少分号");
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn snapshots_replace_earlier_deltas_instead_of_doubling_text() {
        let p = fixture();
        let mut handle = store::Store::open(&p, "s1", "root", Provider::Codex, "标题", "1").unwrap();
        handle
            .append(
                "r1",
                vec![
                    ("text".into(), json!({"id": "m1", "text": "半截"})),
                    ("message".into(), json!({"id": "m1", "text": "完整的一句话"})),
                ],
            )
            .unwrap();
        let (fragments, _, _) = texts(&p.join("s1/events.jsonl"), MAX_SESSION_BYTES).unwrap();
        assert_eq!(fragments[0].text, "完整的一句话");
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn tool_payloads_are_not_conversation_text() {
        let p = fixture();
        let mut handle = store::Store::open(&p, "s1", "root", Provider::Codex, "标题", "1").unwrap();
        handle
            .append(
                "r1",
                vec![("tool".into(), json!({"id": "t1", "name": "read_file", "input": { "path": "needle.txt" }}))],
            )
            .unwrap();
        assert_eq!(hits(&search(&p, "root", "needle", 10, false).unwrap()), 0);
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn only_this_projects_sessions_are_searched() {
        let p = fixture();
        for root in ["root-a", "root-b"] {
            let mut handle = store::Store::open(&p, &format!("s-{root}"), root, Provider::Claude, "标题", "1").unwrap();
            handle
                .append("r1", vec![("user".into(), json!({"text": format!("在 {root} 里说过的那句话")}))])
                .unwrap();
        }
        // 别的项目的目录既不算「搜过」，也不能悄悄消失：skipped 说明还有目录没看。
        let found = search(&p, "root-a", "说过的那句话", 10, false).unwrap();
        assert_eq!(hits(&found), 1);
        assert_eq!(found["hits"][0]["sessionId"], "s-root-a");
        assert_eq!(found["scanned"].as_u64(), Some(1));
        assert_eq!(found["skipped"].as_u64(), Some(1));
        assert_eq!(found["truncated"].as_bool(), Some(false));
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn lock_files_and_native_mirrors_are_not_sessions() {
        let p = fixture();
        let mut handle = store::Store::open(&p, "s1", "root", Provider::Codex, "标题", "1").unwrap();
        handle
            .append("r1", vec![("user".into(), json!({"text": "会话里的话"}))])
            .unwrap();
        // 锁文件与原生历史镜像目录和会话目录同级，都没有 meta.json。
        fs::write(p.join("s1.lock"), "").unwrap();
        fs::create_dir_all(p.join("hidden-native")).unwrap();
        fs::write(p.join("hidden-native/codex-abc"), "root").unwrap();
        let found = search(&p, "root", "会话里的话", 10, false).unwrap();
        assert_eq!(hits(&found), 1);
        assert_eq!(found["scanned"].as_u64(), Some(1));
        assert_eq!(found["skipped"].as_u64(), Some(0));
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn archived_sessions_are_outside_the_default_search() {
        let p = fixture();
        let mut handle = store::Store::open(&p, "s1", "root", Provider::Codex, "标题", "1").unwrap();
        handle
            .append("r1", vec![("user".into(), json!({"text": "归档里的话"}))])
            .unwrap();
        store::Store::set_archived(&p, "s1", "root", true).unwrap();
        assert_eq!(hits(&search(&p, "root", "归档里的话", 10, false).unwrap()), 0);
        assert_eq!(hits(&search(&p, "root", "归档里的话", 10, true).unwrap()), 1);
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn a_broken_line_does_not_fail_the_whole_search() {
        let p = fixture();
        store::Store::open(&p, "s1", "root", Provider::Codex, "标题", "1").unwrap();
        // 手写整份日志，中间夹一条坏行。这种文件 store 会拒绝再追加，
        // 但搜索逐行读原文：坏一条只少一条，不能让整次搜索失败。
        let line = |seq: u64, text: &str| {
            format!("{{\"sessionId\":\"s1\",\"runId\":\"r1\",\"seq\":{seq},\"kind\":\"user\",\"data\":{{\"text\":\"{text}\"}}}}\n")
        };
        fs::write(
            p.join("s1/events.jsonl"),
            format!("{}{{broken\n{}", line(1, "第一条"), line(3, "最后一条线索")),
        )
        .unwrap();
        let found = search(&p, "root", "线索", 10, false).unwrap();
        assert_eq!(hits(&found), 1);
        assert_eq!(found["hits"][0]["seq"], 3);
        // 跳过坏行不算「没扫完」：文件确实读到底了。
        assert_eq!(found["truncated"].as_bool(), Some(false));
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn a_session_that_overruns_its_budget_says_so() {
        let p = fixture();
        let mut handle = store::Store::open(&p, "s1", "root", Provider::Codex, "标题", "1").unwrap();
        handle
            .append(
                "r1",
                vec![
                    ("user".into(), json!({"text": "第一条可搜的话"})),
                    ("user".into(), json!({"text": "第二条可搜的话"})),
                ],
            )
            .unwrap();
        let path = p.join("s1/events.jsonl");
        let size = read_of(&path);
        // 预算正好少一字节：第一行读得下，第二行超了就停，并且如实报 truncated。
        let (fragments, read, truncated) = texts(&path, size - 1).unwrap();
        assert_eq!(fragments.len(), 1);
        assert_eq!(read, size);
        assert!(truncated);
        // 整个会话读得下时，命中的两条都要出现，字节数也要报真实读过的量。
        let found = search(&p, "root", "可搜的话", 10, false).unwrap();
        assert_eq!(hits(&found), 2);
        assert_eq!(found["bytes"].as_u64(), Some(size));
        assert_eq!(found["truncated"].as_bool(), Some(false));
        fs::remove_dir_all(p).unwrap();
    }

    fn read_of(path: &Path) -> u64 {
        fs::metadata(path).unwrap().len()
    }

    #[test]
    fn empty_and_overlong_queries_never_scan_the_disk() {
        let p = fixture();
        assert!(search(&p, "root", "  ", 10, false).is_err());
        assert!(search(&p, "root", &"字".repeat(201), 10, false).is_err());
        assert_eq!(hits(&search(&p.join("missing"), "root", "字", 10, false).unwrap()), 0);
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn events_without_an_id_stay_their_own_fragment() {
        let p = fixture();
        let mut handle = store::Store::open(&p, "s1", "root", Provider::Codex, "标题", "1").unwrap();
        handle
            .append(
                "r1",
                vec![
                    ("notice".into(), json!({"text": "第一条通知"})),
                    ("notice".into(), json!({"text": "第二条通知"})),
                ],
            )
            .unwrap();
        let (fragments, _, _) = texts(&p.join("s1/events.jsonl"), MAX_SESSION_BYTES).unwrap();
        assert_eq!(fragments.len(), 2);
        fs::remove_dir_all(p).unwrap();
    }
}
