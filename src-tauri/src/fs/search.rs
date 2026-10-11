//! 工作区搜索：按名字找文件、在正文里找词。
//!
//! 两条命令都只读，一次扫完就回，不带游标。范围、上限、跳过哪些目录都定在这一层，
//! 前端只说「搜什么、怎么搜」，外加一道跟着资源管理器两个开关走的可见性闸门
//! （[`ScanFilter`]：隐藏项与被 .gitignore 忽略的项）。
//!
//! 扫的是磁盘不是索引，所以没有「正在索引」的中间态；代价是必须自己刹车：
//! 深度、条目数、单文件大小各有一道闸，触闸就把「没扫完」如实报出去，不假装是全量。

use crate::error::{err, err_parts};
use crate::offload::block;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// 一次扫描最多访问多少个条目。到数就停，`truncated` 置真。
const SCAN_CAP: usize = 200_000;
/// 最深进到第几层目录。软链不跟随，这一道是防异常深的工程树。
const MAX_DEPTH: usize = 24;
/// 单个文件超过这么多字节就不逐行搜。比编辑器 8 MiB 的读入上限宽：
/// 搜索扫完即弃，不必常驻，但再大下去时间全花在读盘上。
const TEXT_SIZE_CEILING: u64 = 20 * 1024 * 1024;
/// 判定二进制只看开头这些字节里有没有 NUL。
const SNIFF_BYTES: usize = 4096;
/// 一次搜索默认回多少条。
const DEFAULT_PAGE: usize = 100;
/// 能要到的上限，再多就是传输的负担而不是搜索的负担。
const MAX_LIMIT: usize = 5000;
/// 名字匹配攒够这么多就停：排序要在全量上做，先截会把高分的挤掉。
const MATCH_CAP: usize = 2000;
/// 预览片段最长这么多字符。整行超过它时截取以首处命中为中心的一段，
/// 不截的话一行压缩过的 js 就能把整页撑爆。
const SNIPPET_CHARS: usize = 240;

/// 一律不进的目录名：前两个只有噪音，后面几个是构建产物（`dist` 是前端打包输出，
/// 里面全是压缩过的一行代码，搜到的命中没有一条是人写的）。
const PRUNED_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "build", "out"];

/// 这条目录项是不是该整棵剪掉。只看目录名，文件不参与。
fn pruned(entry: &walkdir::DirEntry) -> bool {
    if !entry.file_type().is_dir() {
        return false;
    }
    let Some(name) = entry.file_name().to_str() else {
        return false;
    };
    PRUNED_DIRS.iter().any(|dir| dir.eq_ignore_ascii_case(name))
}

/// 搜索的可见性闸门，跟着资源管理器那两个设置走。
///
/// 隐藏项与被 .gitignore 忽略的项都整棵剪掉，而不是搜完再丢：剪在扫描层，
/// 它们就不占条目数与命中数的预算，`truncated` 与计数才是「在看得见的东西里」的真实值。
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanFilter {
    /// 显示隐藏项（Windows 隐藏/系统属性、类 unix 点开头）。默认关，与设置一致。
    pub show_hidden: bool,
    /// 被忽略项的绝对路径，前端按仓库根算好传进来；空表示「显示忽略项」。
    pub ignored: Vec<String>,
}

/// 路径归一化成比较用的键：正斜杠、小写。Windows 的分隔符与大小写都不敏感，
/// 忽略前缀与目录项路径必须同一套口径才比得准。
fn normalize(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

/// 这条目录项是不是隐藏项，交给平台那一套判。
///
/// Windows 的隐藏位在目录项自带的 `Metadata` 里（`read_dir` 那趟就拿到了），读它不花钱；
/// 类 unix 只看文件名是否点开头，不必碰 metadata——那边 `entry.metadata()` 会走一次 stat，
/// 每个条目都问一次的话，一趟扫描就是二十万次白打。
fn hidden(entry: &walkdir::DirEntry) -> bool {
    #[cfg(windows)]
    let meta = entry.metadata().ok();
    #[cfg(not(windows))]
    let meta: Option<std::fs::Metadata> = None;
    super::platform::hidden(entry.path(), meta.as_ref())
}

/// 这条路径是否落在任一忽略前缀之下。前缀与路径都已归一化。
fn under_any(key: &str, prefixes: &[String]) -> bool {
    prefixes.iter().any(|prefix| {
        key.starts_with(prefix.as_str())
            && (key.len() == prefix.len() || key.as_bytes()[prefix.len()] == b'/')
    })
}

/// 这一条该不该进结果。根（depth 0）永远留，否则起点先被自己剪掉。
/// 目录被剪时整棵子树跟着走，文件被剪只丢它自己。
fn keeps(entry: &walkdir::DirEntry, show_hidden: bool, ignored: &[String]) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    if pruned(entry) {
        return false;
    }
    if !show_hidden && hidden(entry) {
        return false;
    }
    if !ignored.is_empty() && under_any(&normalize(entry.path()), ignored) {
        return false;
    }
    true
}

/// 统一的扫描配置：不跟软链、限深度、按名排序、剪掉构建目录与不可见项。
/// 单个条目读不到就跳过它，不让一次失败废掉整趟。
fn scan(root: &Path, filter: &ScanFilter) -> impl Iterator<Item = walkdir::DirEntry> {
    let show_hidden = filter.show_hidden;
    let ignored: Vec<String> = filter
        .ignored
        .iter()
        .map(|path| normalize(Path::new(path)))
        .collect();
    WalkDir::new(root)
        .follow_links(false)
        .max_depth(MAX_DEPTH)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(move |entry| keeps(entry, show_hidden, &ignored))
        .filter_map(Result::ok)
}

/// 目录相对工作区根的所在目录，分隔符统一成 `/`；直接挂在根下时为空串。
/// 前端把它和文件名拼在一起显示出处，绝对路径只用来打开。
fn container_of(root: &Path, full: &Path) -> String {
    let Some(parent) = full.parent() else {
        return String::new();
    };
    let Ok(relative) = parent.strip_prefix(root) else {
        return String::new();
    };
    relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// 名字与关键词的相似度档位：4 全等、3 前缀、2 包含、1 逐字顺次出现。
/// 第 1 档是为了 `fdt` 这样的缩写能命中 `FileEditor.tsx`，宁可排最后也别不出现。
///
/// 比较走 ASCII 大小写折叠，不现造小写副本：整棵树要过二十万个目录项，
/// 每个造两份 String 就是四十万次分配，而其中绝大多数连关键词都不含。
/// 关键词含非 ASCII 字符时折叠不等价（西里尔字母的大小写不是 ASCII 规则），
/// 那种由 [`score_name_full`] 退回按 `to_lowercase` 比，一次搜索只有一个关键词。
fn score_name(name: &str, query: &str) -> Option<u8> {
    if query.is_empty() {
        return None;
    }
    if eq_fold(name, query) {
        return Some(4);
    }
    if starts_fold(name, query) {
        return Some(3);
    }
    if contains_fold(name, query) {
        return Some(2);
    }
    let mut cursor = name.bytes().map(|byte| byte.to_ascii_lowercase());
    if query
        .bytes()
        .map(|byte| byte.to_ascii_lowercase())
        .all(|want| cursor.any(|got| got == want))
    {
        return Some(1);
    }
    None
}

/// 非 ASCII 关键词那一档：照旧折整份再比，但只有关键词本身带非 ASCII 时才会走到这里。
fn score_name_full(name: &str, query: &str) -> Option<u8> {
    let name = name.to_lowercase();
    let query = query.to_lowercase();
    if name == query {
        Some(4)
    } else if name.starts_with(&query) {
        Some(3)
    } else if name.contains(&query) {
        Some(2)
    } else {
        score_name(name.as_str(), query.as_str())
    }
}

fn eq_fold(name: &str, query: &str) -> bool {
    let (a, b) = (name.as_bytes(), query.as_bytes());
    a.len() == b.len() && fold_eq(a, b)
}

fn starts_fold(name: &str, query: &str) -> bool {
    let (a, b) = (name.as_bytes(), query.as_bytes());
    a.len() >= b.len() && fold_eq(&a[..b.len()], b)
}

fn contains_fold(name: &str, query: &str) -> bool {
    let (a, b) = (name.as_bytes(), query.as_bytes());
    if b.is_empty() || a.len() < b.len() {
        return false;
    }
    // 首字节折叠后有两个可能写法，其余按折叠逐字节比；窗口滑动不分配。
    a.windows(b.len()).any(|window| fold_eq(window, b))
}

fn fold_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(left, right)| left.to_ascii_lowercase() == right.to_ascii_lowercase())
}

/// 文件名搜索的一条结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    /// 绝对路径，分隔符跟随平台。
    pub path: String,
    /// 显示名，不含路径。
    pub name: String,
    /// 所在目录相对工作区根，`/` 连接；根下为空串。
    pub container: String,
    /// 排档次，见 [`score_name`]。
    pub score: u8,
    /// 目录也算命中，前端要画不一样的图标。
    pub is_dir: bool,
}

/// 一次文件名搜索的结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHits {
    /// 传进来的原词，回显用。
    pub query: String,
    /// 已按档位排好，同档位再按路径短的在前。
    pub items: Vec<FileHit>,
    /// 扫到条目上限、或匹配数被截时为真：结果不是全量，前端要说「还有更多」。
    pub truncated: bool,
}

/// 把分页参数收成实际条数：0 走默认档，超上限按上限。
fn page_limit(limit: usize) -> usize {
    if limit == 0 {
        DEFAULT_PAGE
    } else {
        limit.clamp(1, MAX_LIMIT)
    }
}

/// 按名字找文件和目录的实际一趟。
fn find_files_at(base: &Path, query: &str, cap: usize, filter: &ScanFilter) -> FileHits {
    let needle = query.trim();
    if needle.is_empty() {
        return FileHits {
            query: query.to_string(),
            items: Vec::new(),
            truncated: false,
        };
    }

    // 关键词带非 ASCII 时折叠规则不一样，那种退回造副本的比法；一次搜索只有一个关键词。
    let plain = needle.is_ascii();
    let mut matched: Vec<FileHit> = Vec::new();
    let mut truncated = false;
    for (index, entry) in scan(base, filter).enumerate() {
        if index >= SCAN_CAP {
            truncated = true;
            break;
        }
        if entry.depth() == 0 {
            continue;
        }
        let full = entry.path();
        // 名字先按借用读，命中了才拷成 String：整棵树每个条目拷一次的话就是二十万次分配。
        let lossy;
        let raw = match entry.file_name().to_str() {
            Some(name) => name,
            None => {
                lossy = entry.file_name().to_string_lossy();
                &lossy
            }
        };
        let score = match score_name(raw, needle) {
            Some(score) => Some(score),
            None if plain => None,
            None => score_name_full(raw, needle),
        };
        let Some(score) = score else {
            continue;
        };
        let is_dir = entry.file_type().is_dir();
        matched.push(FileHit {
            path: full.to_string_lossy().into_owned(),
            container: container_of(base, full),
            name: raw.to_string(),
            score,
            is_dir,
        });
        if matched.len() >= MATCH_CAP {
            truncated = true;
            break;
        }
    }

    matched.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(a.path.len().cmp(&b.path.len()))
            .then(a.path.cmp(&b.path))
    });
    if matched.len() > cap {
        matched.truncate(cap);
        truncated = true;
    }
    FileHits {
        query: query.to_string(),
        items: matched,
        truncated,
    }
}

/// 在工作区里按名字找文件和目录。
///
/// 走阻塞线程池而不是 async worker：一趟扫二十万个条目是纯 IO，
/// 占住 tokio 的工作线程，别的异步命令排队就跟着一起慢。
#[tauri::command]
pub async fn find_files(
    root: String,
    query: String,
    limit: Option<usize>,
    filter: Option<ScanFilter>,
) -> Result<FileHits, String> {
    block(move || {
        let base = PathBuf::from(&root);
        if !base.is_dir() {
            return Err(err("NOT_DIR", &root));
        }
        let filter = filter.unwrap_or_default();
        Ok(find_files_at(
            &base,
            &query,
            page_limit(limit.unwrap_or(0)),
            &filter,
        ))
    })
    .await
}

/// 全文搜索的开关，前端一次传齐。字段可缺，缺了按默认值。
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TextOptions {
    /// 区分大小写。
    pub case_sensitive: bool,
    /// 整词匹配。只在非正则下生效，正则自己写边界。
    pub whole_words: bool,
    /// 把搜索词当正则。
    pub regex: bool,
    /// 文件名过滤，逗号或分号分隔的多个模式，认 `*`；空表示不限。
    pub file_mask: String,
    /// 最多回多少行；0 走默认档。
    pub limit: usize,
}

/// 一行上的一处命中，列号与长度都按整行的字符数算。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    /// 起始列，1 起。
    pub column: usize,
    /// 命中长度，按字符数；正则空匹配时为 0。
    pub length: usize,
}

/// 一行正文命中。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextHit {
    /// 所在文件绝对路径。
    pub path: String,
    /// 文件名。
    pub name: String,
    /// 所在目录相对工作区根，`/` 连接。
    pub container: String,
    /// 行号，1 起。
    pub line: usize,
    /// `snippet` 的第一个字符在原行里的列号，1 起；整行没被裁时是 1。
    pub snippet_from: usize,
    /// 预览片段。
    pub snippet: String,
    /// 这一行里的所有命中，按出现顺序。
    pub ranges: Vec<Range>,
}

/// 一次全文搜索的结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPage {
    /// 传进来的原词，回显用。
    pub query: String,
    /// 命中行，按遍历顺序。
    pub hits: Vec<TextHit>,
    /// 这一页里出现过命中的文件数。
    pub files: usize,
    /// 命中行被条数上限切断，或扫描触到条目上限时为真。
    pub truncated: bool,
    /// 跳过的文件数：太大、二进制、非 UTF-8、读不到，四类合并计数。
    pub skipped: usize,
}

/// 怎么在一行里找。
#[derive(Debug)]
enum Matcher {
    /// 逐字符比较。搜索词在建成匹配器时就折好大小写——一行折一次的话，
    /// 一个长文件等于把同一个词折几千遍。
    Plain {
        key: Vec<char>,
        /// 行必须按同一档折：只折关键词、行原样比，大小写敏感那一档搜「Foo」就永远对不上，
        /// 搜「foo」又白捡一堆 `Foo` 的命中。
        case_sensitive: bool,
        whole_words: bool,
    },
    /// 正则按字节位置匹配，再折算回字符序号交给前端。
    Pattern(regex::Regex),
}

/// 单字符大小写折叠。只取折叠结果的第一码，长度不变，列号才不会和原文错位。
fn fold_char(value: char, case_sensitive: bool) -> char {
    if case_sensitive {
        value
    } else {
        value.to_lowercase().next().unwrap_or(value)
    }
}

/// 词的边界：字母、数字、下划线之外都算断开。
fn is_word(value: char) -> bool {
    value.is_alphanumeric() || value == '_'
}

impl Matcher {
    /// 一行之内的全部命中，不重叠，按出现顺序。
    ///
    /// `scratch` 是折叠后的那一行，跨行复用：原先每行现造三份 `Vec<char>`
    /// （原行、折过的行、折过的关键词），一万行的文件就是三万次分配。
    fn find(&self, line: &str, found: &mut Vec<Range>, scratch: &mut Vec<char>) {
        match self {
            Matcher::Plain {
                key,
                case_sensitive,
                whole_words,
            } => {
                if key.is_empty() {
                    return;
                }
                // 快速短路剪枝：若行内连搜索词的首字符都不包含，直接跳过，
                // 避免对整库成千上万行无相干文本无条件执行 line.chars() 与 scratch 内存填充。
                let first = key[0];
                if *case_sensitive {
                    if !line.contains(first) {
                        return;
                    }
                } else if first.is_ascii() {
                    let lo = (first as u8).to_ascii_lowercase();
                    let up = (first as u8).to_ascii_uppercase();
                    if !line.as_bytes().iter().any(|&b| b == lo || b == up) {
                        return;
                    }
                } else if !line.contains(first)
                    && !line
                        .to_lowercase()
                        .contains(&first.to_lowercase().to_string())
                {
                    return;
                }
                scratch.clear();
                scratch.extend(
                    line.chars()
                        .map(|value| fold_char(value, *case_sensitive)),
                );
                let haystack = &scratch[..];
                let mut start = 0usize;
                while start + key.len() <= haystack.len() {
                    let end = start + key.len();
                    if haystack[start..end] == key[..] {
                        let whole = !whole_words
                            || (start == 0 || !is_word(haystack[start - 1]))
                                && (end == haystack.len() || !is_word(haystack[end]));
                        if whole {
                            found.push(Range {
                                column: start + 1,
                                length: key.len(),
                            });
                            start = end;
                            continue;
                        }
                    }
                    start += 1;
                }
            }
            Matcher::Pattern(pattern) => {
                for hit in pattern.find_iter(line) {
                    found.push(Range {
                        column: line[..hit.start()].chars().count() + 1,
                        length: line[hit.start()..hit.end()].chars().count(),
                    });
                }
            }
        }
    }
}

/// 把搜索词做成匹配器。正则写错不是「没结果」而是「没跑起来」，必须报出去。
fn build_matcher(query: &str, options: &TextOptions) -> Result<Matcher, String> {
    if options.regex {
        let pattern = regex::RegexBuilder::new(query)
            .case_insensitive(!options.case_sensitive)
            .build()
            .map_err(|error| err_parts("BAD_REGEX", &[query.to_string(), error.to_string()]))?;
        return Ok(Matcher::Pattern(pattern));
    }
    Ok(Matcher::Plain {
        key: query
            .chars()
            .map(|value| fold_char(value, options.case_sensitive))
            .collect(),
        case_sensitive: options.case_sensitive,
        whole_words: options.whole_words,
    })
}

/// 只认 `*` 的通配：首段贴开头、末段贴结尾、中间段按顺序出现。
fn wildcard(pattern: &str, name: &str) -> bool {
    if !pattern.contains('*') {
        return name == pattern;
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    let last_index = parts.len() - 1;
    let mut tail = name;
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if index == 0 {
            match tail.strip_prefix(*part) {
                Some(after) => tail = after,
                None => return false,
            }
        } else if index == last_index {
            return tail.ends_with(*part);
        } else {
            match tail.find(*part) {
                Some(at) => tail = &tail[at + part.len()..],
                None => return false,
            }
        }
    }
    true
}

/// 文件名过滤器。空列表等于不限。
struct Mask(Vec<String>);

impl Mask {
    fn parse(spec: &str) -> Mask {
        Mask(
            spec.split([',', ';'])
                .map(|part| part.trim().to_lowercase())
                .filter(|part| !part.is_empty())
                .collect(),
        )
    }

    fn allows(&self, name: &str) -> bool {
        if self.0.is_empty() {
            return true;
        }
        let name = name.to_lowercase();
        self.0.iter().any(|part| wildcard(part, &name))
    }
}

/// 裁出预览片段：整行太长时取以首处命中为中心的一段，返回片段和它在原行里的起始列。
fn snippet(line: &str, first_column: usize) -> (String, usize) {
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= SNIPPET_CHARS {
        return (line.to_string(), 1);
    }
    let center = first_column.saturating_sub(1);
    let from = center.saturating_sub(SNIPPET_CHARS / 3);
    let to = (from + SNIPPET_CHARS).min(chars.len());
    let from = if to >= SNIPPET_CHARS {
        to - SNIPPET_CHARS
    } else {
        0
    };
    (chars[from..to].iter().collect(), from + 1)
}

/// 剥掉 UTF-8 BOM。留着会让首行第一列算错一位。
fn strip_bom(bytes: &[u8]) -> &[u8] {
    if bytes.starts_with(&super::UTF8_BOM) {
        &bytes[super::UTF8_BOM.len()..]
    } else {
        bytes
    }
}

/// 在正文里找词的实际一趟。
fn search_text_at(
    base: &Path,
    query: &str,
    options: &TextOptions,
    filter: &ScanFilter,
) -> Result<TextPage, String> {
    let needle = query.trim();
    if needle.is_empty() {
        return Ok(TextPage {
            query: query.to_string(),
            hits: Vec::new(),
            files: 0,
            truncated: false,
            skipped: 0,
        });
    }
    let matcher = build_matcher(needle, options)?;
    let mask = Mask::parse(&options.file_mask);
    let cap = page_limit(options.limit);

    let mut hits: Vec<TextHit> = Vec::new();
    let mut files = 0usize;
    let mut skipped = 0usize;
    let mut truncated = false;
    let mut found: Vec<Range> = Vec::new();
    let mut scratch: Vec<char> = Vec::new();
    // 跨文件复用字节读取缓冲，避免遍历每个文件时反复在堆上重分配 Vec
    let mut file_bytes: Vec<u8> = Vec::with_capacity(64 * 1024);

    'scan: for (index, entry) in scan(base, filter).enumerate() {
        if index >= SCAN_CAP {
            truncated = true;
            break;
        }
        if entry.depth() == 0 || !entry.file_type().is_file() {
            continue;
        }
        let full = entry.path();
        let Some(name) = full.file_name().and_then(|part| part.to_str()) else {
            continue;
        };
        if !mask.allows(name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            skipped += 1;
            continue;
        };
        if meta.len() > TEXT_SIZE_CEILING {
            skipped += 1;
            continue;
        }
        // 单句柄流式读入：先读开头 SNIFF_BYTES 字节嗅探 NUL，
        // 发现二进制立即短路退出并关闭句柄；若是文本则复用缓冲区继续读完，消除重复打开文件的内核调用与 I/O 翻倍开销。
        file_bytes.clear();
        let Ok(mut file) = fs::File::open(full) else {
            skipped += 1;
            continue;
        };
        let mut head = [0u8; SNIFF_BYTES];
        let Ok(count) = file.read(&mut head) else {
            skipped += 1;
            continue;
        };
        if head[..count].contains(&0) {
            skipped += 1;
            continue;
        }
        file_bytes.extend_from_slice(&head[..count]);
        if count == SNIFF_BYTES && file.read_to_end(&mut file_bytes).is_err() {
            skipped += 1;
            continue;
        }
        // 借读到的那一段来扫，不再 `to_vec()` 拷整份：20 MB 的文件原来要两份同时在内存里。
        let Ok(body) = std::str::from_utf8(strip_bom(&file_bytes)) else {
            skipped += 1;
            continue;
        };

        let hits_before = hits.len();
        for (number, line) in body.lines().enumerate() {
            found.clear();
            matcher.find(line, &mut found, &mut scratch);
            if found.is_empty() {
                continue;
            }
            let (text, from) = snippet(line, found[0].column);
            hits.push(TextHit {
                path: full.to_string_lossy().into_owned(),
                name: name.to_string(),
                container: container_of(base, full),
                line: number + 1,
                snippet_from: from,
                snippet: text,
                ranges: found.clone(),
            });
            if hits.len() >= cap {
                truncated = true;
                break 'scan;
            }
        }
        if hits.len() > hits_before {
            files += 1;
        }
    }

    Ok(TextPage {
        query: query.to_string(),
        hits,
        files,
        truncated,
        skipped,
    })
}

/// 在正文里找词，逐文件扫过工作区。
#[tauri::command]
pub async fn search_text(
    root: String,
    query: String,
    options: TextOptions,
    filter: Option<ScanFilter>,
) -> Result<TextPage, String> {
    block(move || {
        let base = PathBuf::from(&root);
        if !base.is_dir() {
            return Err(err("NOT_DIR", &root));
        }
        let filter = filter.unwrap_or_default();
        search_text_at(&base, &query, &options, &filter)
    })
    .await
}
#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例一个临时目录，带用例名和进程号，避免用例之间互相踩。
    fn sandbox(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("forge-search-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("创建搜索测试沙盒失败");
        base
    }

    fn names(hits: &[FileHit]) -> Vec<String> {
        hits.iter().map(|hit| hit.name.clone()).collect()
    }

    /// 默认闸门：藏隐藏项、不忽略任何路径。用例里的文件都不可见性问题，等价于旧的无闸门行为。
    fn plain() -> ScanFilter {
        ScanFilter::default()
    }

    #[test]
    fn name_score_has_four_tiers() {
        assert_eq!(score_name("FileEditor.tsx", "FileEditor.tsx"), Some(4));
        assert_eq!(score_name("FileEditor.tsx", "file"), Some(3));
        assert_eq!(score_name("FileEditor.tsx", "edit"), Some(2));
        assert_eq!(score_name("FileEditor.tsx", "fdt"), Some(1));
        assert_eq!(score_name("FileEditor.tsx", "zebra"), None);
        assert_eq!(score_name("anything", ""), None);
    }

    #[test]
    fn wildcard_anchors_head_tail_and_middle() {
        assert!(wildcard("*.rs", "mod.rs"));
        assert!(!wildcard("*.rs", "rs"), "带点的后缀才算尾巴");
        assert!(!wildcard("*.rs", "rsx"));
        assert!(wildcard("Cargo.*", "Cargo.toml"));
        assert!(wildcard("*edit*or*", "fileeditor.tsx"));
        assert!(!wildcard("*or*edit*", "fileeditor.tsx"));
        assert!(wildcard("main.rs", "main.rs"));
        assert!(!wildcard("main.rs", "main2.rs"));
    }

    #[test]
    fn file_mask_treats_empty_spec_as_no_filter() {
        assert!(Mask::parse("").allows("anything.ts"));
        assert!(Mask::parse(" *.TSX , a.rs ").allows("x.tsx"));
        assert!(Mask::parse(" *.TSX , a.rs ").allows("a.rs"));
        assert!(!Mask::parse(" *.TSX , a.rs ").allows("b.css"));
    }

    #[test]
    fn plain_match_folds_case_without_shifting_columns() {
        let matcher = build_matcher("ab", &TextOptions::default()).unwrap();
        let mut found = Vec::new();
        let mut scratch = Vec::new();
        matcher.find("xábABc", &mut found, &mut scratch);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].column, 4, "前面的 á 只占一列");
        assert_eq!(found[0].length, 2);
    }

    #[test]
    fn whole_word_only_drops_glued_occurrences() {
        let glued = TextOptions {
            whole_words: true,
            ..Default::default()
        };
        let mut found = Vec::new();
        let mut scratch = Vec::new();
        build_matcher("cat", &glued)
            .unwrap()
            .find("concat cat cat_ 9cat", &mut found, &mut scratch);
        assert_eq!(found.len(), 1, "只有独立那次算整词");
        assert_eq!(found[0].column, 8);

        let mut loose = Vec::new();
        build_matcher("cat", &TextOptions::default())
            .unwrap()
            .find("concat cat cat_ 9cat", &mut loose, &mut scratch);
        assert_eq!(loose.len(), 4);
    }

    #[test]
    fn regex_columns_are_counted_in_characters() {
        let options = TextOptions {
            regex: true,
            ..Default::default()
        };
        let mut found = Vec::new();
        let mut scratch = Vec::new();
        build_matcher("o+", &options)
            .unwrap()
            .find("一二oo三o", &mut found, &mut scratch);
        assert_eq!(found[0].column, 3);
        assert_eq!(found[0].length, 2);
        assert_eq!(found[1].column, 6);
    }

    #[test]
    fn broken_regex_is_an_error_not_an_empty_page() {
        let options = TextOptions {
            regex: true,
            ..Default::default()
        };
        let error = build_matcher("(", &options).unwrap_err();
        assert!(error.starts_with("BAD_REGEX\u{1}"));
    }

    #[test]
    fn long_lines_are_cut_around_the_first_hit() {
        let line = "x".repeat(300);
        let (text, from) = snippet(&line, 250);
        assert_eq!(text.chars().count(), SNIPPET_CHARS);
        assert_eq!(from + text.chars().count() as usize - 1, 300);

        let (whole, from) = snippet("short", 1);
        assert_eq!(whole, "short");
        assert_eq!(from, 1);
    }

    #[test]
    fn bom_is_stripped_only_at_the_start() {
        assert_eq!(strip_bom(&[0xEF, 0xBB, 0xBF, b'a']), &[b'a']);
        assert_eq!(strip_bom(&[b'a', 0xEF]), &[b'a', 0xEF]);
    }

    #[test]
    fn container_is_relative_to_root_with_forward_slashes() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let deep = root.join("src").join("fs").join("mod.rs");
        assert_eq!(container_of(root, &deep), "src/fs");
        assert_eq!(container_of(root, &root.join("lib.rs")), "");
    }

    #[test]
    fn page_limit_falls_back_and_caps() {
        assert_eq!(page_limit(0), DEFAULT_PAGE);
        assert_eq!(page_limit(1), 1);
        assert_eq!(page_limit(MAX_LIMIT * 9), MAX_LIMIT);
    }

    #[test]
    fn file_name_hits_rank_exact_above_prefix_above_contains() {
        let dir = sandbox("rank");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src").join("App.tsx"), "x").unwrap();
        fs::write(dir.join("App.tsx"), "x").unwrap();
        fs::write(dir.join("App"), "x").unwrap();
        fs::write(dir.join("MyApp.tsx"), "x").unwrap();

        let hits = find_files_at(&dir, "App", 50, &plain());
        assert_eq!(names(&hits.items), vec!["App", "App.tsx", "App.tsx", "MyApp.tsx"]);
        assert_eq!(hits.items[0].score, 4);
        assert_eq!(hits.items[1].container, "", "根下的那档短路径排前");
        assert_eq!(hits.items[2].container, "src");
        assert_eq!(hits.items[3].score, 2);
        assert!(!hits.truncated);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_prunes_build_directories() {
        let dir = sandbox("prune");
        fs::create_dir_all(dir.join("node_modules").join("dep")).unwrap();
        fs::write(
            dir.join("node_modules").join("dep").join("App.tsx"),
            "needle",
        )
        .unwrap();
        fs::create_dir_all(dir.join("dist").join("assets")).unwrap();
        fs::write(dir.join("dist").join("assets").join("App-1a2b3c.js"), "needle")
            .unwrap();
        fs::write(dir.join("App.tsx"), "needle here").unwrap();

        let by_name = find_files_at(&dir, "App", 50, &plain());
        assert_eq!(names(&by_name.items), vec!["App.tsx"]);

        let page = search_text_at(&dir, "needle", &TextOptions::default(), &plain()).unwrap();
        assert_eq!(page.hits.len(), 1, "依赖与打包产物里的那两次不该被搜到");
        assert_eq!(page.files, 1);
        assert!(!page.truncated);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_gate_hides_hidden_and_ignored_entries() {
        let dir = sandbox("gate");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src").join("app.ts"), "needle").unwrap();
        fs::write(dir.join(".env"), "needle").unwrap();
        // 隐藏闸门认的是平台隐藏位（Windows 属性 / 类 unix 点前缀），
        // 文件名带不带点在 Windows 上说了不算，得像 hidden_gate_uses_platform_attribute
        // 那样显式置一次。
        super::super::platform::mark_hidden(&dir.join(".env"));
        fs::create_dir_all(dir.join("build-cache")).unwrap();
        fs::write(dir.join("build-cache").join("out.ts"), "needle").unwrap();

        // 忽略项按绝对路径传：`build-cache` 整棵剪掉，`.env` 靠隐藏闸门剪掉。
        let filter = ScanFilter {
            show_hidden: false,
            ignored: vec![dir.join("build-cache").to_string_lossy().into_owned()],
        };
        let by_name = find_files_at(&dir, "app", 50, &filter);
        assert_eq!(names(&by_name.items), vec!["app.ts"], "只留可见且未被忽略的那条");

        let page = search_text_at(&dir, "needle", &TextOptions::default(), &filter).unwrap();
        assert_eq!(page.hits.len(), 1, "隐藏项与忽略项都不该被搜到");
        assert_eq!(page.hits[0].name, "app.ts");
        assert_eq!(page.skipped, 0, "被闸门剪掉的项不计入 skipped");

        // 打开「显示隐藏」并去掉忽略前缀：两样都该回来。
        let open = ScanFilter {
            show_hidden: true,
            ignored: Vec::new(),
        };
        let page = search_text_at(&dir, "needle", &TextOptions::default(), &open).unwrap();
        assert_eq!(page.hits.len(), 3, "开关打开后隐藏项与忽略项都进来");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hidden_gate_uses_platform_attribute() {
        let dir = sandbox("platform-hidden");
        let visible = dir.join("visible.txt");
        let hidden = dir.join("hidden.txt");
        fs::write(&visible, "needle").unwrap();
        fs::write(&hidden, "needle").unwrap();
        // 走平台那一套：Windows 置隐藏位、类 unix 改名加点前缀。
        super::super::platform::mark_hidden(&hidden);

        let page = search_text_at(&dir, "needle", &TextOptions::default(), &plain()).unwrap();
        assert_eq!(page.hits.len(), 1, "隐藏项被闸门挡住");
        assert_eq!(page.hits[0].name, "visible.txt");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn binary_is_skipped_and_a_file_counts_once() {
        let dir = sandbox("binary");
        fs::write(dir.join("notes.txt"), "needle\nmore needle\n").unwrap();
        fs::write(dir.join("blob.bin"), [0u8, 1, 2, b'n', b'e', b'a', b'd']).unwrap();

        let page = search_text_at(&dir, "needle", &TextOptions::default(), &plain()).unwrap();
        assert_eq!(page.hits.len(), 2, "同一文件的两个命中行都算");
        assert_eq!(page.files, 1, "但只算一个文件");
        assert_eq!(page.skipped, 1, "带 NUL 的不逐行搜");
        assert_eq!(page.hits[0].ranges.len(), 1);
        assert_eq!(page.hits[1].line, 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn text_search_respects_mask_and_reports_truncation() {
        let dir = sandbox("mask");
        fs::write(dir.join("a.rs"), "needle").unwrap();
        fs::write(dir.join("b.md"), "needle").unwrap();

        let only_rs = search_text_at(
            &dir,
            "needle",
            &TextOptions {
                file_mask: "*.rs".into(),
                ..Default::default()
            },
            &plain(),
        )
        .unwrap();
        assert_eq!(only_rs.hits.len(), 1);
        assert_eq!(only_rs.hits[0].name, "a.rs");

        let one = search_text_at(
            &dir,
            "needle",
            &TextOptions {
                limit: 1,
                ..Default::default()
            },
            &plain(),
        )
        .unwrap();
        assert_eq!(one.hits.len(), 1);
        assert!(one.truncated, "被条数上限切断要如实报");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn several_hits_on_one_line_come_back_as_one_row() {
        let dir = sandbox("ranges");
        fs::write(dir.join("l.txt"), "needle needle needle").unwrap();
        let page = search_text_at(&dir, "needle", &TextOptions::default(), &plain()).unwrap();
        assert_eq!(page.hits.len(), 1);
        let columns: Vec<usize> = page.hits[0].ranges.iter().map(|range| range.column).collect();
        assert_eq!(columns, vec![1, 8, 15]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_query_is_no_results_not_no_directory() {
        let dir = sandbox("empty");
        fs::write(dir.join("a.rs"), "needle").unwrap();
        assert!(find_files_at(&dir, "   ", 50, &plain()).items.is_empty());
        assert!(search_text_at(&dir, "   ", &TextOptions::default(), &plain())
            .unwrap()
            .hits
            .is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}

