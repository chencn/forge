//! 符号搜索：按名字找定义，给随处搜索的「类」与「符号」两档供货。
//!
//! openidea 那边有常驻的 tree-sitter 索引；这边没有等价的底子，退而求其次：
//! 按扩展名选一套「每语言的正则规则」从正文里抠定义行，整个根一次扫出的结果
//! 按根缓存 [`CACHE_TTL`] 这么久，之后的查询只对着缓存比名字。第一条查询付一次
//! 全盘读的代价，后续查询就和文件名搜索一样快。
//!
//! 规则是行锚定的正则，认不出嵌套与作用域，所以只承诺「这是个定义、在第几行」，
//! 不承诺 IDE 级的符号表。看不见注释的边界：行注释因为不以行首开头自然不收，
//! 块注释里自成一行的一条照样算定义（见测试 `line_comments_are_skipped_but_block_comments_leak`）。
//! 缓存那一棵 60 秒内不失效，也没有跟着文件监听的增量失效，所以新建、改名、挪动过的定义
//! 在这一分钟内查不到，行号也可能是旧的；触到 [`MAX_SYMBOLS`] 或这一档被截时 `truncated` 为真。
//! 种类名沿用 openidea 的写法（class/interface/struct/enum/
//! trait/typeAlias/function/method/constant/variable/module…），前端按它发徽章与「类」档过滤。
//! 行号与列号都 1 起，和 [`super::search::TextHit`] 同一口径，前端可以直接交给编辑器落行。

use super::search::{
    container_of, normalize, page_limit, scan, score_name, score_name_full, under_any, ScanFilter,
};
use crate::error::err;
use crate::offload::block;
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 单文件超过这么多字节就不抠符号了（对齐 openidea 的 MAX_SYMBOL_FILE）。
const SYMBOL_SIZE_CEILING: u64 = 2 * 1024 * 1024;
/// 一个根最多收这么多符号，到数就停止扫描：超大仓库里缓存整棵树的定义没有意义。
const MAX_SYMBOLS: usize = 80_000;
/// 每个根的缓存活这么久；过期后的第一条查询重新扫一遍。
const CACHE_TTL: Duration = Duration::from_secs(60);

/// 一条提取规则怎么定种类。捕获组 1 恒为符号名。
enum Kind {
    /// 固定的种类。
    Fixed(&'static str),
    /// 命中行行首是空白就取第二个种类（缩进的 def 是方法，顶格的是函数）。
    Indented(&'static str, &'static str),
    /// 行首到名字之间出现了这段文本就取第二个种类（Go 的 `func (r T) Name` 是方法）。
    Between(&'static str, &'static str, &'static str),
}

struct Compiled {
    pattern: Regex,
    kind: Kind,
}

/// 由字面量表编译一套规则；写错的规则直接丢，不拖垮整门语言。
fn compile(rules: &[(&str, Kind)]) -> Vec<Compiled> {
    rules
        .iter()
        .filter_map(|(pattern, kind)| {
            Regex::new(pattern).ok().map(|pattern| Compiled {
                pattern,
                kind: match kind {
                    Kind::Fixed(k) => Kind::Fixed(k),
                    Kind::Indented(a, b) => Kind::Indented(a, b),
                    Kind::Between(m, a, b) => Kind::Between(m, a, b),
                },
            })
        })
        .collect()
}

/// 循环生成的模式借 `'static` 用：规则表在 OnceLock 里一辈子只建一次，
/// 泄漏几条模式串换掉一层 Vec<String> 中转，值。
fn leak_rules(pairs: Vec<(String, Kind)>) -> Vec<(&'static str, Kind)> {
    pairs
        .into_iter()
        .map(|(pattern, kind)| (Box::leak(pattern.into_boxed_str()) as &'static str, kind))
        .collect()
}

fn ts_rules() -> &'static [Compiled] {
    static RULES: OnceLock<Vec<Compiled>> = OnceLock::new();
    RULES
        .get_or_init(|| {
            compile(&[
                (
                    r"(?m)^[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?(?:abstract[ \t]+)?class[ \t]+([A-Za-z_$][\w$]*)",
                    Kind::Fixed("class"),
                ),
                (
                    r"(?m)^[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?interface[ \t]+([A-Za-z_$][\w$]*)",
                    Kind::Fixed("interface"),
                ),
                (
                    r"(?m)^[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?enum[ \t]+([A-Za-z_$][\w$]*)",
                    Kind::Fixed("enum"),
                ),
                (
                    r"(?m)^[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?type[ \t]+([A-Za-z_$][\w$]*)",
                    Kind::Fixed("typeAlias"),
                ),
                (
                    r"(?m)^[ \t]*(?:export[ \t]+default[ \t]+|export[ \t]+)?(?:async[ \t]+)?function[ \t]*\*?[ \t]*([A-Za-z_$][\w$]*)",
                    Kind::Fixed("function"),
                ),
                (
                    r"(?m)^(?:export[ \t]+)?const[ \t]+([A-Z][\w$]*)[ \t]*(?::[^\n=]+)?=",
                    Kind::Fixed("constant"),
                ),
            ])
        })
        .as_slice()
}

fn java_rules() -> &'static [Compiled] {
    static RULES: OnceLock<Vec<Compiled>> = OnceLock::new();
    RULES
        .get_or_init(|| {
            let mut pairs: Vec<(String, Kind)> = Vec::new();
            let mods = r"(?:public[ \t]+|private[ \t]+|protected[ \t]+|static[ \t]+|final[ \t]+|abstract[ \t]+|sealed[ \t]+|non-sealed[ \t]+|strictfp[ \t]+)*";
            for (word, kind) in [
                ("class", "class"),
                ("interface", "interface"),
                ("enum", "enum"),
                ("record", "record"),
            ] {
                pairs.push((
                    format!(r"(?m)^[ \t]*(?:@[\w.]+[ \t]*)*{mods}{word}[ \t]+([A-Za-z_]\w*)"),
                    Kind::Fixed(kind),
                ));
            }
            pairs.push((
                format!(r"(?m)^[ \t]*(?:public[ \t]+|private[ \t]+|protected[ \t]+|static[ \t]+|final[ \t]+|abstract[ \t]+)*@[ \t]*interface[ \t]+([A-Za-z_]\w*)"),
                Kind::Fixed("annotation"),
            ));
            pairs.push((
                r"(?m)^[ \t]{4,}(?:@[\w.]+[ \t]*)*(?:public[ \t]+|private[ \t]+|protected[ \t]+|static[ \t]+|final[ \t]+|abstract[ \t]+|synchronized[ \t]+|default[ \t]+)*[\w$][\w$<>\[\],. ?]*?[ \t]+([a-z][\w$]*)[ \t]*\([^;{)]*\)[ \t]*(?:throws[ \t]+[\w$,. ]+)?[ \t]*\{".to_string(),
                Kind::Fixed("method"),
            ));
            compile(&leak_rules(pairs))
        })
        .as_slice()
}

fn kotlin_rules() -> &'static [Compiled] {
    static RULES: OnceLock<Vec<Compiled>> = OnceLock::new();
    RULES
        .get_or_init(|| {
            let mut pairs: Vec<(String, Kind)> = Vec::new();
            let mods = r"(?:public[ \t]+|private[ \t]+|internal[ \t]+|protected[ \t]+|open[ \t]+|abstract[ \t]+|sealed[ \t]+|data[ \t]+|value[ \t]+|inner[ \t]+|annotation[ \t]+|enum[ \t]+)*";
            for (word, kind) in [("class", "class"), ("interface", "interface"), ("object", "object")] {
                pairs.push((
                    format!(r"(?m)^[ \t]*{mods}{word}[ \t]+([A-Za-z_][\w$]*)"),
                    Kind::Fixed(kind),
                ));
            }
            pairs.push((
                r"(?m)^[ \t]*(?:public[ \t]+|private[ \t]+|internal[ \t]+|protected[ \t]+|open[ \t]+|override[ \t]+|suspend[ \t]+|inline[ \t]+|operator[ \t]+|infix[ \t]+|enum[ \t]+)*fun[ \t]+(?:[A-Za-z_][\w.]*\.)?([A-Za-z_][\w$]*)".to_string(),
                Kind::Indented("function", "method"),
            ));
            pairs.push((
                r"(?m)^(?:public[ \t]+|private[ \t]+|internal[ \t]+|const[ \t]+)*(?:val|var)[ \t]+([A-Za-z_][\w$]*)".to_string(),
                Kind::Fixed("variable"),
            ));
            compile(&leak_rules(pairs))
        })
        .as_slice()
}

fn rust_rules() -> &'static [Compiled] {
    static RULES: OnceLock<Vec<Compiled>> = OnceLock::new();
    RULES
        .get_or_init(|| {
            compile(&[
                (
                    r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)*(?:unsafe[ \t]+)?struct[ \t]+([A-Za-z_]\w*)",
                    Kind::Fixed("struct"),
                ),
                (
                    r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)*enum[ \t]+([A-Za-z_]\w*)",
                    Kind::Fixed("enum"),
                ),
                (
                    r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)*(?:unsafe[ \t]+)?trait[ \t]+([A-Za-z_]\w*)",
                    Kind::Fixed("trait"),
                ),
                (
                    r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)*union[ \t]+([A-Za-z_]\w*)",
                    Kind::Fixed("union"),
                ),
                (
                    r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)*(?:default[ \t]+|const[ \t]+|async[ \t]+|unsafe[ \t]+|extern[ \t]+)*fn[ \t]+([A-Za-z_]\w*)",
                    Kind::Indented("function", "method"),
                ),
                (
                    r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)*type[ \t]+([A-Za-z_]\w*)",
                    Kind::Fixed("typeAlias"),
                ),
                (
                    r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)*const[ \t]+([A-Z_][\w]*)",
                    Kind::Fixed("constant"),
                ),
                (
                    r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)*static[ \t]+(?:mut[ \t]+)?([A-Za-z_]\w*)",
                    Kind::Fixed("variable"),
                ),
                (
                    r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)*mod[ \t]+([a-z][\w]*)[ \t]*(?:;|\{)",
                    Kind::Fixed("module"),
                ),
            ])
        })
        .as_slice()
}

fn python_rules() -> &'static [Compiled] {
    static RULES: OnceLock<Vec<Compiled>> = OnceLock::new();
    RULES
        .get_or_init(|| {
            compile(&[
                (
                    r"(?m)^[ \t]*class[ \t]+([A-Za-z_]\w*)",
                    Kind::Fixed("class"),
                ),
                (
                    r"(?m)^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)",
                    Kind::Indented("function", "method"),
                ),
                (
                    r"(?m)^([A-Z][A-Z0-9_]{2,})[ \t]*=",
                    Kind::Fixed("constant"),
                ),
            ])
        })
        .as_slice()
}

fn go_rules() -> &'static [Compiled] {
    static RULES: OnceLock<Vec<Compiled>> = OnceLock::new();
    RULES
        .get_or_init(|| {
            compile(&[
                (
                    r"(?m)^func(?:[ \t]*\([^)]*\))?[ \t]+([A-Za-z_]\w*)",
                    Kind::Between("(", "function", "method"),
                ),
                (
                    r"(?m)^type[ \t]+([A-Za-z_]\w*)[ \t]+struct",
                    Kind::Fixed("struct"),
                ),
                (
                    r"(?m)^type[ \t]+([A-Za-z_]\w*)[ \t]+interface",
                    Kind::Fixed("interface"),
                ),
                (
                    r"(?m)^type[ \t]+([A-Za-z_]\w*)[ \t]*=",
                    Kind::Fixed("typeAlias"),
                ),
                (
                    r"(?m)^(?:const|var)[ \t]+([A-Za-z_]\w*)",
                    Kind::Fixed("constant"),
                ),
            ])
        })
        .as_slice()
}

/// C 家族：`struct Foo {`、`class Bar`（C++）、命名空间。成员函数认不出来，也不硬认。
fn c_rules() -> &'static [Compiled] {
    static RULES: OnceLock<Vec<Compiled>> = OnceLock::new();
    RULES
        .get_or_init(|| {
            let mut pairs: Vec<(String, Kind)> = Vec::new();
            for (word, kind) in [
                ("struct", "struct"),
                ("class", "class"),
                ("union", "union"),
                ("enum", "enum"),
            ] {
                pairs.push((
                    format!(r"(?m)^(?:typedef[ \t]+)?{word}[ \t]+([A-Za-z_]\w*)"),
                    Kind::Fixed(kind),
                ));
            }
            pairs.push((
                r"(?m)^namespace[ \t]+([A-Za-z_][\w:]*)".to_string(),
                Kind::Fixed("module"),
            ));
            compile(&leak_rules(pairs))
        })
        .as_slice()
}

fn csharp_rules() -> &'static [Compiled] {
    static RULES: OnceLock<Vec<Compiled>> = OnceLock::new();
    RULES
        .get_or_init(|| {
            let mut pairs: Vec<(String, Kind)> = Vec::new();
            let mods = r"(?:public[ \t]+|private[ \t]+|internal[ \t]+|protected[ \t]+|static[ \t]+|sealed[ \t]+|abstract[ \t]+|partial[ \t]+|readonly[ \t]+|file[ \t]+|new[ \t]+|record[ \t]+)*";
            for (word, kind) in [
                ("class", "class"),
                ("interface", "interface"),
                ("struct", "struct"),
                ("enum", "enum"),
                ("namespace", "module"),
            ] {
                pairs.push((
                    format!(r"(?m)^[ \t]*(?:@?[\w.]+[ \t]*)*{mods}{word}[ \t]+([A-Za-z_]\w*)"),
                    Kind::Fixed(kind),
                ));
            }
            pairs.push((
                r"(?m)^[ \t]{4,}(?:public[ \t]+|private[ \t]+|internal[ \t]+|protected[ \t]+|static[ \t]+|virtual[ \t]+|override[ \t]+|abstract[ \t]+|sealed[ \t]+|async[ \t]+)*[\w$][\w$<>\[\],. ?]*?[ \t]+([A-Za-z_]\w*)[ \t]*\([^;{)]*\)[ \t]*(?:=>[^;]*)?\{".to_string(),
                Kind::Fixed("method"),
            ));
            compile(&leak_rules(pairs))
        })
        .as_slice()
}

fn php_rules() -> &'static [Compiled] {
    static RULES: OnceLock<Vec<Compiled>> = OnceLock::new();
    RULES
        .get_or_init(|| {
            let mut pairs: Vec<(String, Kind)> = Vec::new();
            for word in ["class", "interface", "trait", "enum"] {
                pairs.push((
                    format!(
                        r"(?m)^[ \t]*(?:abstract[ \t]+|final[ \t]+|read-only[ \t]+)*{word}[ \t]+([A-Za-z_]\w*)"
                    ),
                    Kind::Fixed(word),
                ));
            }
            pairs.push((
                r"(?m)^[ \t]*(?:public[ \t]+|private[ \t]+|protected[ \t]+|static[ \t]+|abstract[ \t]+|final[ \t]+)*function[ \t]+([a-zA-Z_]\w*)".to_string(),
                Kind::Indented("function", "method"),
            ));
            compile(&leak_rules(pairs))
        })
        .as_slice()
}

/// 按扩展名挑一套规则；认不出的语言不贡献符号。
fn rules_for(extension: &str) -> Option<&'static [Compiled]> {
    match extension {
        "ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs" => Some(ts_rules()),
        "java" => Some(java_rules()),
        "kt" | "kts" => Some(kotlin_rules()),
        "rs" => Some(rust_rules()),
        "py" => Some(python_rules()),
        "go" => Some(go_rules()),
        "c" | "h" | "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" => Some(c_rules()),
        "cs" => Some(csharp_rules()),
        "php" => Some(php_rules()),
        _ => None,
    }
}

/// 缓存里的一条定义。
#[derive(Clone)]
struct SymbolEntry {
    /// 绝对路径，分隔符跟随平台。
    path: String,
    /// 所在目录相对工作区根，`/` 连接；根下为空串。
    container: String,
    name: String,
    kind: &'static str,
    /// 行号，1 起。
    line: usize,
    /// 名字所在列，1 起，按字符数。
    col: usize,
}

struct RootCache {
    built: Instant,
    entries: Vec<SymbolEntry>,
}

fn cache() -> &'static Mutex<HashMap<String, RootCache>> {
    static CACHE: OnceLock<Mutex<HashMap<String, RootCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 把一棵树整个扫成定义表。可见性闸门在建缓存这一层不生效（隐藏与忽略项都进表），
/// 查询时按 [`ScanFilter`] 现剪：切换「包括忽略项」就不必重扫磁盘。
fn build_entries(base: &Path) -> Vec<SymbolEntry> {
    let open_filter = ScanFilter {
        show_hidden: true,
        ignored: Vec::new(),
    };
    let mut out: Vec<SymbolEntry> = Vec::new();
    for entry in scan(base, &open_filter) {
        if out.len() >= MAX_SYMBOLS {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let name_os = entry.file_name().to_string_lossy().into_owned();
        let dot = name_os.rfind('.');
        let Some(extension) = dot.map(|at| name_os[at + 1..].to_ascii_lowercase()) else {
            continue;
        };
        let Some(rules) = rules_for(&extension) else {
            continue;
        };
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() > SYMBOL_SIZE_CEILING {
            continue;
        }
        let full = entry.path();
        let Ok(bytes) = fs::read(full) else {
            continue;
        };
        let bytes = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            &bytes[3..]
        } else {
            &bytes[..]
        };
        let Ok(contents) = std::str::from_utf8(bytes) else {
            continue;
        };
        let path = full.to_string_lossy().into_owned();
        let container = container_of(base, full);
        let mut seen: HashSet<(usize, String)> = HashSet::new();
        let mut capped = false;
        for rule in rules {
            // 同一条规则内的命中天然递增：行号跨命中累加，不必每条从头数换行。
            let mut cursor = 0usize;
            let mut line = 1usize;
            for caps in rule.pattern.captures_iter(contents) {
                let whole = caps.get(0).expect("整段必然存在");
                let Some(name_match) = caps.get(1) else { continue };
                line += contents[cursor..whole.start()].matches('\n').count();
                cursor = whole.start();
                let symbol = name_match.as_str().to_string();
                if !seen.insert((line, symbol.clone())) {
                    continue;
                }
                let kind = match &rule.kind {
                    Kind::Fixed(kind) => *kind,
                    Kind::Indented(top, nested) => {
                        let indented = contents
                            .as_bytes()
                            .get(whole.start())
                            .is_some_and(|byte| *byte == b' ' || *byte == b'\t');
                        if indented {
                            *nested
                        } else {
                            *top
                        }
                    }
                    Kind::Between(marker, plain, special) => {
                        let head = &contents[whole.start()..name_match.start()];
                        if head.contains(marker) {
                            *special
                        } else {
                            *plain
                        }
                    }
                };
                let line_start = contents[..name_match.start()]
                    .rfind('\n')
                    .map_or(0, |at| at + 1);
                let col = contents[line_start..name_match.start()].chars().count() + 1;
                out.push(SymbolEntry {
                    path: path.clone(),
                    container: container.clone(),
                    name: symbol,
                    kind,
                    line,
                    col,
                });
                if out.len() >= MAX_SYMBOLS {
                    capped = true;
                    break;
                }
            }
            if capped {
                break;
            }
        }
    }
    out
}

/// 符号搜索的一条结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolHit {
    /// 定义所在文件绝对路径。
    pub path: String,
    /// 显示名。
    pub name: String,
    /// 符号种类；「类」档收录哪些见 [`is_type_kind`]。
    pub kind: String,
    /// 所在目录相对工作区根，`/` 连接；根下为空串。
    pub container: String,
    /// 行号，1 起。
    pub line: usize,
    /// 名字所在列，1 起。
    pub column: usize,
}

/// 一次符号搜索的结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolHits {
    /// 传进来的原词，回显用。
    pub query: String,
    /// 已按档位排好，同档位再按目录短的、名字排的。
    pub items: Vec<SymbolHit>,
    /// 缓存没扫完（触到 MAX_SYMBOLS）、或这一档被截时为真。
    pub truncated: bool,
}

/// 「类」档收录的种类；其余都只在「符号」档出现。对齐 openidea 的 isTypeKind 再加
/// record/annotation/object/union 这几种天生就是类型的写法。
fn is_type_kind(kind: &str) -> bool {
    matches!(
        kind,
        "class"
            | "interface"
            | "struct"
            | "enum"
            | "trait"
            | "typeAlias"
            | "record"
            | "annotation"
            | "object"
            | "union"
    )
}

/// 隐藏判定（缓存口径）：相对目录里出现点开头的一段就算隐藏。
/// 建缓存时没留元数据，只能按名判——与资源管理器在类 unix 上的规则一致；
/// Windows 隐藏属性在这一档不追，文件与正文两档仍按真实属性剪。
fn hidden_container(container: &str) -> bool {
    container.split('/').any(|part| part.starts_with('.'))
}

/// 在缓存的符号表里找。
fn find_in_cache(
    entries: &[SymbolEntry],
    query: &str,
    filter: &str,
    scan_filter: &ScanFilter,
    cap: usize,
) -> SymbolHits {
    let needle = query.trim();
    if needle.is_empty() {
        return SymbolHits {
            query: query.to_string(),
            items: Vec::new(),
            truncated: entries.len() >= MAX_SYMBOLS,
        };
    }
    let plain = needle.is_ascii();
    let types_only = filter == "types";
    let ignored: Vec<String> = scan_filter
        .ignored
        .iter()
        .map(|path| normalize(Path::new(path)))
        .collect();
    let mut scored: Vec<(u8, &SymbolEntry)> = Vec::new();
    for entry in entries {
        if types_only && !is_type_kind(entry.kind) {
            continue;
        }
        if !scan_filter.show_hidden && hidden_container(&entry.container) {
            continue;
        }
        if !ignored.is_empty() {
            let key = normalize(Path::new(&entry.path));
            if under_any(&key, &ignored) {
                continue;
            }
        }
        let score = match score_name(&entry.name, needle) {
            Some(score) => Some(score),
            None if plain => None,
            None => score_name_full(&entry.name, needle),
        };
        if let Some(score) = score {
            scored.push((score, entry));
        }
    }
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(a.1.container.len().cmp(&b.1.container.len()))
            .then(a.1.name.cmp(&b.1.name))
    });
    let truncated = scored.len() > cap || entries.len() >= MAX_SYMBOLS;
    if scored.len() > cap {
        scored.truncate(cap);
    }
    SymbolHits {
        query: query.to_string(),
        items: scored
            .into_iter()
            .map(|(_, entry)| SymbolHit {
                path: entry.path.clone(),
                name: entry.name.clone(),
                kind: entry.kind.to_string(),
                container: entry.container.clone(),
                line: entry.line,
                column: entry.col,
            })
            .collect(),
        truncated,
    }
}

/// 按名字找符号定义。空词直接回空表。
///
/// `filter` 取 `"types"`（只要类）或 `"all"`（全都要）。第一次查某个根要先整棵扫一遍，
/// 之后的查询吃 [`CACHE_TTL`] 内的缓存。
#[tauri::command]
pub async fn find_symbols(
    root: String,
    query: String,
    kind_filter: Option<String>,
    limit: Option<usize>,
    filter: Option<ScanFilter>,
) -> Result<SymbolHits, String> {
    block(move || {
        let base = PathBuf::from(&root);
        if !base.is_dir() {
            return Err(err("NOT_DIR", &root));
        }
        let key = normalize(&base);
        let kind_filter = kind_filter.unwrap_or_else(|| "all".to_string());
        let scan_filter = filter.unwrap_or_default();
        let cap = page_limit(limit.unwrap_or(0));
        let mut store = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // 过期就重建。拿着锁扫全盘会把别的查询堵在锁上——宁可让并发首查各扫各的，
        // 两份结果一样，后写的覆盖前写的。
        let fresh = store
            .get(&key)
            .is_some_and(|cached| cached.built.elapsed() < CACHE_TTL);
        if !fresh {
            let entries = build_entries(&base);
            store.insert(
                key.clone(),
                RootCache {
                    built: Instant::now(),
                    entries,
                },
            );
        }
        let cached = store.get(&key).expect("刚写入必有");
        Ok(find_in_cache(
            &cached.entries,
            &query,
            &kind_filter,
            &scan_filter,
            cap,
        ))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("forge-symbols-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("创建符号测试沙盒失败");
        base
    }

    fn write(base: &Path, rel: &str, contents: &str) {
        let full = base.join(rel);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, contents).unwrap();
    }

    fn kinds(entries: &[SymbolEntry]) -> Vec<(&str, &str)> {
        entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.kind))
            .collect()
    }

    #[test]
    fn extracts_typescript_definitions() {
        let base = sandbox("ts");
        write(
            &base,
            "src/app.ts",
            "export interface Widget {\n  id: string;\n}\nexport class BigWidget implements Widget {}\nenum Mode { A, B }\ntype Alias = number;\nexport function makeWidget(): Widget { return null!; }\nconst MAX_THINGS = 3;\n",
        );
        let entries = build_entries(&base);
        let list = kinds(&entries);
        assert!(list.contains(&("Widget", "interface")));
        assert!(list.contains(&("BigWidget", "class")));
        assert!(list.contains(&("Mode", "enum")));
        assert!(list.contains(&("Alias", "typeAlias")));
        assert!(list.contains(&("makeWidget", "function")));
        assert!(list.contains(&("MAX_THINGS", "constant")));
        let widget = entries.iter().find(|e| e.name == "BigWidget").unwrap();
        assert_eq!(widget.line, 4);
        assert_eq!(widget.col, 14);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn line_comments_are_skipped_but_block_comments_leak() {
        let base = sandbox("cmt");
        write(
            &base,
            "src/a.ts",
            "// function commentedOut() {}\n/*\nfunction inBlockComment() {}\n*/\nexport function real() {}\n",
        );
        let entries = build_entries(&base);
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert!(names.contains(&"real"));
        assert!(!names.contains(&"commentedOut"));
        // 已知缺口：规则只认行首，看不见注释的边界，所以块注释里自成一行的一条照样收进来。
        assert!(names.contains(&"inBlockComment"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rust_indented_fn_is_method_and_types_are_found() {
        let base = sandbox("rs");
        write(
            &base,
            "src/lib.rs",
            "pub struct Config;\npub enum State { On }\npub trait Runner { fn go(&self); }\npub fn run() {}\nimpl Config {\n    pub fn load(&self) {}\n}\nconst MAX: usize = 2;\nmod inner;\n",
        );
        let entries = build_entries(&base);
        let list = kinds(&entries);
        assert!(list.contains(&("Config", "struct")));
        assert!(list.contains(&("State", "enum")));
        assert!(list.contains(&("Runner", "trait")));
        assert!(list.contains(&("run", "function")));
        assert!(list.contains(&("load", "method")));
        assert!(list.contains(&("MAX", "constant")));
        assert!(list.contains(&("inner", "module")));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn query_scores_types_filter_and_container() {
        let base = sandbox("q");
        write(&base, "src/store.ts", "export class WidgetStore {}\nexport function useWidget() {}\n");
        let entries = build_entries(&base);
        let hits = find_in_cache(
            &entries,
            "widget",
            "types",
            &ScanFilter::default(),
            10,
        );
        assert_eq!(hits.items.len(), 1);
        assert_eq!(hits.items[0].name, "WidgetStore");
        assert_eq!(hits.items[0].container, "src");
        let all = find_in_cache(&entries, "use", "all", &ScanFilter::default(), 10);
        assert_eq!(all.items[0].name, "useWidget");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn go_receiver_functions_are_methods() {
        let base = sandbox("go");
        write(
            &base,
            "main.go",
            "package main\n\ntype Server struct{}\n\nfunc (s *Server) Start() {}\n\nfunc main() {}\n",
        );
        let entries = build_entries(&base);
        let list = kinds(&entries);
        assert!(list.contains(&("Server", "struct")));
        assert!(list.contains(&("Start", "method")));
        assert!(list.contains(&("main", "function")));
        let _ = fs::remove_dir_all(&base);
    }
}
