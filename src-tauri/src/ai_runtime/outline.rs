//! 消息导航用的轮次索引：只捞每条用户消息的开头一行，外加那一轮改过几个文件。
//!
//! 为什么不能直接用 `store::page()` 的结果：正文一页最多 500 条事件，长会话里一轮工具
//! 输出就能把它填满，导航于是只剩一条记录。索引每轮只带两个短字段，两千轮也就几百 KB，
//! 一次取回，导航才敢列出整个会话并按 seq 跳过去。
//!
//! 从文件尾往前读：导航首先关心最近聊了什么，倒着读到够数就停，不必为了索引把整份
//! 256 MiB 的日志从头扫到尾。读不到文件开头就如实报 `complete=false`，
//! 让用户知道列表只覆盖了最近这一段，而不是假装对话只有这么长。

use super::events::Event;
use super::store;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// 一次最多给这么多轮。再多说明会话长得离谱，导航只索引最近这一段并如实说明。
pub const MAX_TURNS: usize = 2000;
/// 倒着读每次取这么大一块；行边界跨块时靠上一块的尾巴接回去。
const BLOCK: u64 = 1024 * 1024;
/// 最多倒着读这么多字节。到顶就停，并把「没读全」交给界面说明。
const MAX_BYTES: u64 = 64 * 1024 * 1024;
/// 摘要保留这么多字符：一行导航放不下，完整内容本来就在正文里。
const LABEL_CHARS: usize = 120;
/// 只有这两类事件进索引。工具事件动辄上百 KB，为了让索引去解析它们等于把正文再读一遍。
const USER_MARK: &[u8] = b"\"kind\":\"user\"";
const FILES_MARK: &[u8] = b"\"kind\":\"files\"";

/// 一轮用户消息在导航里的一行。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    /// 该轮 `user` 事件的序号；跳转要靠它判断正文有没有加载到那里。
    pub seq: u64,
    /// 与前端投影同意的条目 id（见 `aiRuntime.ts` 的 `key`）：有 `data.id` 用它，
    /// 否则用 seq。原生历史导入的 `user` 事件带 id，实时写入的不带，两种都得对上，
    /// 否则同一条消息会在导航里出现两次。
    pub entry_id: String,
    /// 该轮的 run id。
    pub run_id: String,
    /// 首行摘要。
    pub label: String,
    /// 该轮改过的文件数，按路径去重；口径与 `summarizeAiFileEdits` 一致。
    pub files: usize,
}

/// 取第一行非空文本作摘要，并按字符截断。
fn summarize(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    line.chars().take(LABEL_CHARS).collect()
}

/// 这一行值不值得解析。整份日志逐行做字节比较，命中才付反序列化的代价。
fn worth_parsing(line: &[u8]) -> bool {
    line.windows(USER_MARK.len()).any(|w| w == USER_MARK)
        || line.windows(FILES_MARK.len()).any(|w| w == FILES_MARK)
}

/// 倒着扫 `events.jsonl`，取最近这么多轮用户消息。
///
/// 拿 `IO_LOCK` 会把正在运行的会话的事件写入一起卡住（理由同 `search`）：追加式日志
/// 的最后半行本来就解析不出来，跳过它比冻结对话好。
pub fn turns(base: &Path, id: &str, root: &str) -> Result<Value, String> {
    let dir = base.join(id);
    if !dir.exists() {
        return Err("会话不存在".into());
    }
    // 元数据校验顺带管归属：别把别的项目的会话列进这个项目的导航。
    store::Store::metadata(&dir, root)?;
    let mut file = match std::fs::File::open(dir.join("events.jsonl")) {
        Ok(file) => file,
        // 还没写过事件的会话没有日志，这不是错误。
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(serde_json::json!({ "turns": [], "indexed": 0, "complete": true }))
        }
        Err(error) => return Err(error.to_string()),
    };
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    let mut position = length;
    let mut read: u64 = 0;
    // 已收齐的轮次，新→旧；返回前倒过来。只收 user 事件已读到的轮，
    // 倒着读时 user 事件是这一轮的最后一块拼图，先遇到的是它的 files 事件。
    let mut turns: Vec<Turn> = Vec::new();
    // 当前这一轮（还没遇到它的 user 事件）改过的文件路径。
    let mut paths: HashSet<String> = HashSet::new();
    // 跨块的半行：本次数据的开头那段属于更早一块还没读到的行，留下一次接上。
    let mut residual: Vec<u8> = Vec::new();
    let mut truncated = false;
    while position > 0 {
        if read >= MAX_BYTES {
            truncated = true;
            break;
        }
        let size = BLOCK.min(position).min(MAX_BYTES - read);
        position -= size;
        file.seek(SeekFrom::Start(position)).map_err(|e| e.to_string())?;
        let mut chunk = vec![0u8; size as usize];
        file.read_exact(&mut chunk).map_err(|e| e.to_string())?;
        read += size;
        chunk.extend_from_slice(&residual);
        residual.clear();
        // 第一个换行之前可能是半行，它的前半截在还没读的那一块里。
        let first = chunk.iter().position(|byte| *byte == b'\n');
        let body = match first {
            Some(at) => {
                residual = chunk[..at].to_vec();
                &chunk[at + 1..]
            }
            // 整块都没换行：全是半行，接着往前拼。
            None => {
                residual = chunk;
                continue;
            }
        };
        for line in body.split_inclusive(|byte| *byte == b'\n').rev() {
            let line = match line.split_last() {
                // 末尾的换行不属于事件文本；文件最后一行没写完时原样交给解析器。
                Some((b'\n', head)) => head,
                _ => line,
            };
            if !worth_parsing(line) {
                continue;
            }
            let Ok(event) = serde_json::from_slice::<Event>(line) else {
                continue;
            };
            if event.session_id != id || !store::valid_id(&event.run_id) {
                continue;
            }
            match event.kind.as_str() {
                "files" => {
                    let value = &event.data;
                    if let Some(items) = value["paths"].as_array() {
                        for path in items.iter().filter_map(|path| path.as_str()) {
                            paths.insert(path.to_owned());
                        }
                    }
                }
                "user" => {
                    let text = event.data["text"].as_str().unwrap_or_default();
                    let entry_id = match event.data["id"].as_str() {
                        Some(item) => format!("{}:{}", event.run_id, item),
                        None => format!("{}:{}", event.run_id, event.seq),
                    };
                    turns.push(Turn {
                        seq: event.seq,
                        entry_id,
                        run_id: event.run_id,
                        label: summarize(text),
                        files: std::mem::take(&mut paths).len(),
                    });
                    if turns.len() >= MAX_TURNS {
                        break;
                    }
                }
                _ => {}
            }
        }
        if turns.len() >= MAX_TURNS {
            break;
        }
    }
    // 读到文件开头时，最后一块留下的半行其实就是第一条完整行。够数提前收手的就不是这种情况：
    // 那一行是我们主动没要的，不能在这里补回去。
    if !truncated && position == 0 && turns.len() < MAX_TURNS && !residual.is_empty() && worth_parsing(&residual) {
        if let Ok(event) = serde_json::from_slice::<Event>(&residual) {
            if event.session_id == id && event.kind == "user" && store::valid_id(&event.run_id) {
                let entry_id = match event.data["id"].as_str() {
                    Some(item) => format!("{}:{}", event.run_id, item),
                    None => format!("{}:{}", event.run_id, event.seq),
                };
                turns.push(Turn {
                    seq: event.seq,
                    entry_id,
                    run_id: event.run_id,
                    label: summarize(event.data["text"].as_str().unwrap_or_default()),
                    files: std::mem::take(&mut paths).len(),
                });
            }
        }
    }
    turns.reverse();
    // `complete` 为假时 `indexed` 只是「索引到的轮数」，不是会话总轮数；
    // 界面据此决定序号能不能当「第几条消息」讲。
    let complete = position == 0 && turns.len() < MAX_TURNS;
    Ok(serde_json::json!({
        "turns": turns,
        "indexed": turns.len(),
        "complete": complete,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_cli::Provider;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "forge-runtime-outline-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn turns_of(value: &Value) -> Vec<(u64, String, String, usize)> {
        value["turns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|turn| (
                turn["seq"].as_u64().unwrap(),
                turn["entryId"].as_str().unwrap().to_owned(),
                turn["label"].as_str().unwrap().to_owned(),
                turn["files"].as_u64().unwrap() as usize,
            ))
            .collect()
    }

    #[test]
    fn every_user_turn_is_indexed_not_only_the_loaded_page() {
        let p = fixture();
        let mut handle = store::Store::open(&p, "s1", "root", Provider::Codex, "标题", "1").unwrap();
        handle
            .append("r1", vec![
                ("user".into(), json!({"text": "\n  第一轮说了什么\n后面还有"})),
                ("files".into(), json!({"paths": ["a.ts", "a.ts"]})),
            ])
            .unwrap();
        handle
            .append("r2", vec![
                ("user".into(), json!({"text": "第二轮"})),
                ("tool".into(), json!({"id": "t", "name": "exec", "output": "x".repeat(4000)})),
                ("files".into(), json!({"paths": ["b.ts", "c.ts"]})),
            ])
            .unwrap();
        handle.append("r3", vec![("user".into(), json!({"text": "第三轮"}))]).unwrap();
        let found = turns(&p, "s1", "root").unwrap();
        // 一条 4 KB 的工具输出不会把中间的轮次挤掉：导航看到的从来不只是最后一页。
        assert_eq!(turns_of(&found), vec![
            (1, "r1:1".to_owned(), "第一轮说了什么".to_owned(), 1),
            (3, "r2:3".to_owned(), "第二轮".to_owned(), 2),
            (6, "r3:6".to_owned(), "第三轮".to_owned(), 0),
        ]);
        assert_eq!(found["complete"].as_bool(), Some(true));
        assert_eq!(found["indexed"].as_u64(), Some(3));
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn imported_prompts_are_addressed_by_their_provider_item_id() {
        let p = fixture();
        let mut handle = store::Store::open(&p, "s1", "root", Provider::Claude, "标题", "1").unwrap();
        // 实时写入的 user 事件没有 id，原生历史导入的有；两边的 id 都必须和前端投影对得上，
        // 否则同一条消息会在导航里出现两次。
        handle
            .append("r1", vec![
                ("user".into(), json!({"text": "实时发的那句话"})),
                ("user".into(), json!({"id": "native-9", "text": "导入的那句话"})),
            ])
            .unwrap();
        let found = turns(&p, "s1", "root").unwrap();
        assert_eq!(turns_of(&found).iter().map(|t| t.1.clone()).collect::<Vec<_>>(), vec!["r1:1", "r1:native-9"]);
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn a_label_keeps_the_first_line_only() {
        let p = fixture();
        let mut handle = store::Store::open(&p, "s1", "root", Provider::Codex, "标题", "1").unwrap();
        let long = "开".repeat(LABEL_CHARS + 40);
        handle
            .append("r1", vec![("user".into(), json!({"text": format!("{long}\n后面那些")}))])
            .unwrap();
        let found = turns(&p, "s1", "root").unwrap();
        let label = &turns_of(&found)[0].2;
        assert_eq!(label.chars().count(), LABEL_CHARS);
        assert!(!label.contains("后面那些"));
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn a_half_written_tail_line_is_skipped() {
        let p = fixture();
        store::Store::open(&p, "s1", "root", Provider::Codex, "标题", "1").unwrap();
        let line = |seq: u64, text: &str| {
            format!("{{\"sessionId\":\"s1\",\"runId\":\"r1\",\"seq\":{seq},\"kind\":\"user\",\"data\":{{\"text\":\"{text}\"}}}}\n")
        };
        // 最后一行只写了一半：导航宁可少一条，也不能把对话卡住。
        fs::write(p.join("s1/events.jsonl"), format!("{}{{\"seq\":2", line(1, "完整的一条"))).unwrap();
        let found = turns(&p, "s1", "root").unwrap();
        assert_eq!(turns_of(&found).len(), 1);
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn lines_split_across_blocks_are_not_lost() {
        let p = fixture();
        store::Store::open(&p, "s1", "root", Provider::Codex, "标题", "1").unwrap();
        // 每行 900 字节、共 1500 行：超过一块 1 MiB，逼读取跨块拼接半行。
        let body = "字".repeat(300);
        let line = |seq: u64| {
            format!("{{\"sessionId\":\"s1\",\"runId\":\"r1\",\"seq\":{seq},\"kind\":\"user\",\"data\":{{\"text\":\"{body}-{seq}\"}}}}\n")
        };
        let mut content = String::new();
        for seq in 1..=1500 {
            content.push_str(&line(seq));
        }
        fs::write(p.join("s1/events.jsonl"), content).unwrap();
        let found = turns(&p, "s1", "root").unwrap();
        let items = turns_of(&found);
        assert_eq!(items.len(), 1500);
        assert_eq!(found["complete"].as_bool(), Some(true));
        // 首尾都在，序号升序：块边界没把最老或最新那条切掉。
        assert_eq!((items.first().unwrap().0, items.last().unwrap().0), (1, 1500));
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn a_session_older_than_the_budget_reports_what_it_covered() {
        let p = fixture();
        store::Store::open(&p, "s1", "root", Provider::Codex, "标题", "1").unwrap();
        let line = |seq: u64| {
            format!("{{\"sessionId\":\"s1\",\"runId\":\"r1\",\"seq\":{seq},\"kind\":\"user\",\"data\":{{\"text\":\"第{seq}条\"}}}}\n")
        };
        let mut content = String::new();
        for seq in 1..=(MAX_TURNS + 3) as u64 {
            content.push_str(&line(seq));
        }
        fs::write(p.join("s1/events.jsonl"), content).unwrap();
        let found = turns(&p, "s1", "root").unwrap();
        let items = turns_of(&found);
        assert_eq!(items.len(), MAX_TURNS);
        // 够数就停：留下的是最近这些轮，并如实说「更早的没读」。
        assert_eq!((items.first().unwrap().0, items.last().unwrap().0), (4, (MAX_TURNS + 3) as u64));
        assert_eq!(found["complete"].as_bool(), Some(false));
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn another_projects_session_is_not_indexed_here() {
        let p = fixture();
        store::Store::open(&p, "s1", "root-a", Provider::Codex, "标题", "1").unwrap();
        assert!(turns(&p, "s1", "root-b").is_err());
        // 目录都没有时是错误，不是「这个会话没有消息」。
        assert!(turns(&p, "missing", "root-a").is_err());
        fs::remove_dir_all(p).unwrap();
    }
}
