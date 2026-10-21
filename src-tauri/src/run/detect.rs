//! 构建体系识别：从工程目录里的构建文件推出「这里有什么可跑的」。
//!
//! 只认标志文件，不解析依赖树、不建索引：`package.json` 出 npm 脚本，`pom.xml` 出 Maven 与
//! Spring Boot，`build.gradle(.kts)` 出 Gradle 任务与主类，什么构建文件都没有的 Java 源码走
//! JDK 的单文件启动器。识别结果一律落成一行命令，交给进程通道原样跑。
//!
//! 主类这一路的落点是「借构建工具起跑」：Maven 用 `compile exec:java -Dexec.mainClass=`，
//! Gradle 用一份 init 脚本在里面造一个 `JavaExec` 任务，任务名是主类全名加 `.main()`。
//! 这么做是因为没有后台编译，自己拼 classpath 就得解析依赖；交给构建工具，它认自己的产物。
//!
//! 命令行里允许三个占位：`${mvn}`、`${gradle}`、`${java}`。工程自带的 wrapper 直接写脚本名，
//! 占位只用于「本机 PATH 上那个工具」——把绝对路径烤进配置里，换台机器或挪个 JDK 就全废了，
//! 起跑前由界面按 `run_tools` 报回来的实际路径展开（见 `docs/features/run/README.md`）。

use super::scan;
use super::{HelperFile, RunConfiguration, RunKind, RunMarker, Unavailable};
use crate::error::{err, err_parts};
use crate::offload::{block, block_value};
use crate::sys;
use regex::Regex;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use std::fs;
use walkdir::WalkDir;

/// 锁被另一侧 panic 弄脏也要继续识别。
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 按字面模式取那条正则。构建文件的探测每个目录都要问好几条模式，
/// `Regex::new` 一次上百微秒，每问一遍重编一次的话扫描时间全花在编译上。
fn regex(pattern: &str) -> Option<Regex> {
    static CACHE: OnceLock<Mutex<HashMap<String, Regex>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(built) = lock(cache).get(pattern) {
        return Some(built.clone());
    }
    let built = Regex::new(pattern).ok()?;
    let mut cache = lock(cache);
    // 这个缓存只该装源码里写死的字面模式。万一哪天又被喂了按名字拼的动态
    // 模式（一个类名一条、永久驻留），封顶清空比泄漏便宜。
    if cache.len() >= 512 {
        cache.clear();
    }
    cache.insert(pattern.to_string(), built.clone());
    Some(built)
}

/// 找构建文件的最大深度。再深就不是这个工程的模块了。
const MAX_DEPTH: usize = 4;
/// 整棵剪掉的目录名：构建产物、依赖、缓存。
pub(super) const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".idea",
    ".gradle",
    ".mvn",
    ".venv",
    "__pycache__",
    "bin",
    "build",
    "dist",
    "out",
    "target",
    "vendor",
];
/// 一颗源码树最多翻多少个源文件，防住把别人的大仓扫穿。
const MAX_SOURCE_FILES: usize = 4000;
/// 单个源文件最多读这么多字节，超出就不判内容。
const MAX_FILE_BYTES: u64 = 64 * 1024;
/// 单文件启动器要求的最低 JDK 大版本。
const MIN_SINGLE_FILE_JDK: u16 = 11;

/// 一次识别的结果：可跑的那几台，以及扫的过程中读到了什么坏东西。
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunDetectOutcome {
    pub configs: Vec<RunConfiguration>,
    /// 每条都是「稳定代码 + 原文」的错误串，文案由前端按界面语言拼。读不到东西不能闷声报空表。
    pub problems: Vec<String>,
}

/// 本机跑 JVM 系列要用的那三个工具。空串表示这台机器上没有。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    /// PATH 上的 mvn 全路径；`${mvn}` 展开成它，新建 Maven 配置时目录候选也从这里推。
    pub maven: String,
    pub gradle: String,
    /// java 可执行文件的全路径，`${java}` 展开成它。
    pub java: String,
    /// `java -version` 里的大版本号；取不到为 0。
    pub java_feature: u16,
}

impl Tools {
    /// 后端线程起不来时的兜底：三个工具都算「本机没有」，条目照样列出来并标 `NO_TOOL`。
    fn empty() -> Tools {
        Tools {
            maven: String::new(),
            gradle: String::new(),
            java: String::new(),
            java_feature: 0,
        }
    }
}

/// 一个候选主类。
struct MainClass {
    /// 全限定名。
    name: String,
    /// 相对工程根的源文件路径。
    file: String,
    /// 类上有没有 `@SpringBootApplication`。
    spring: bool,
    /// 装订线上的落点：类声明那一行加 `main` 那一行，两处都能点。
    markers: Vec<RunMarker>,
}

/// 该用哪个构建工具，以及从哪儿喊它。
struct Tool {
    /// 写在命令行最前面那段，已经按需加引号。
    invoke: String,
    /// 跑这条命令的目录。
    dir: PathBuf,
    /// 本机找不到这个工具时的说明；有它就跑不了。
    missing: Option<Unavailable>,
}

/// 扫描过程的可变状态。
struct Detector {
    root: PathBuf,
    configs: Vec<RunConfiguration>,
    problems: Vec<String>,
    /// 被某个构建文件认领过的目录；一个都没有才把源文件当独立 Java 程序看。
    owned: Vec<PathBuf>,
    /// 认出来是 Wails 工程的那些目录；它们里面的 `package.json` 是前端资源，不是运行入口。
    wails: Vec<PathBuf>,
    java: String,
    java_feature: u16,
}

/// 把非空的片段用空格接成一行命令。
pub(super) fn line(parts: &[&str]) -> String {
    parts
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<&str>>()
        .join(" ")
}

/// 跑 `package.json` 脚本该喊哪个包管理器：按锁文件认，认不出来用 npm。
/// 锁文件从脚本所在目录往上找到根——monorepo 里 `pnpm-lock.yaml` 常摆在仓库根而不是子包目录。
pub(super) fn npm_client(dir: &Path, root: &Path) -> &'static str {
    for (lock, client) in [
        ("bun.lockb", "bun"),
        ("bun.lock", "bun"),
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("package-lock.json", "npm"),
    ] {
        if scan::nearest_ancestor_with(dir, root, &[lock]).is_some() {
            return client;
        }
    }
    "npm"
}

/// 相对根目录的路径；根目录本身给空串。分隔符跟系统一致，前端拿到就能拼绝对路径。
pub(super) fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}

/// 字节偏移换成 1 起的行号；界面那边装订线按行认人。
fn line_at(text: &str, offset: usize) -> u32 {
    1 + text[..offset.min(text.len())].matches('\n').count() as u32
}

/// 相对路径统一成 `/` 分隔：装订线那侧只认这一种写法。
pub(super) fn slashes(path: &str) -> String {
    path.replace('\\', "/")
}

/// 第一条命中该模式的行号。
fn line_of(text: &str, pattern: &str) -> Option<u32> {
    let found = regex(pattern)?.find(text)?;
    Some(line_at(text, found.start()))
}

/// `parent` 那个对象一开头的 `{`。
///
/// 模式固定、键名从捕获里比对——把父名拼进 pattern 的话，每个唯一键名
/// 都会在进程级缓存里留下一条永久驻留的正则。
fn object_open(text: &str, parent: &str) -> Option<usize> {
    let pattern = regex(r#""([^"]*)"\s*:\s*\{"#)?;
    for cap in pattern.captures_iter(text) {
        if &cap[1] == parent {
            return Some(cap.get(0)?.end() - 1);
        }
    }
    None
}

/// `name` 是否作为独立单词出现在 `text` 里（`\b name \b` 的字面量语义）。
/// 供按名字拼模式的场合替代动态正则，免得把名字喂进缓存。
fn mentions_word(text: &str, name: &str) -> bool {
    let word_char = |ch: char| ch.is_alphanumeric() || ch == '_';
    let mut from = 0;
    while let Some(offset) = text[from..].find(name) {
        let start = from + offset;
        let end = start + name.len();
        let before_free = text[..start].chars().next_back().is_none_or(|ch| !word_char(ch));
        let after_free = text[end..].chars().next().is_none_or(|ch| !word_char(ch));
        if before_free && after_free {
            return true;
        }
        from = end;
    }
    false
}

/// 数出 `parent` 那个对象直接下一层的每一个键，连同它主张所在的那一行。
///
/// JSON 解析完位置就没了，所以文本再走一遍：串里的花括号与转义都要跳过，
/// 不然一个脚本正文里带了 `{` 就把后面整份文件的层数带歪。
fn object_key_lines(text: &str, parent: &str) -> Vec<(String, u32)> {
    let Some(open) = object_open(text, parent) else {
        return Vec::new();
    };
    let tail = &text[open + 1..];
    let mut out: Vec<(String, u32)> = Vec::new();
    let mut depth = 1usize;
    let mut chars = tail.char_indices();
    while let Some((at, ch)) = chars.next() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            '"' => {
                let key_start = at + 1;
                loop {
                    match chars.next() {
                        Some((_, '\\')) => {
                            chars.next();
                        }
                        Some((end, '"')) => {
                            let after = tail[end + 1..].trim_start();
                            if depth == 1 && after.starts_with(':') {
                                let line = line_at(text, open + 1 + key_start);
                                out.push((tail[key_start..end].to_string(), line));
                            }
                            break;
                        }
                        Some(_) => continue,
                        None => break,
                    };
                }
            }
            _ => {}
        }
    }
    out
}

/// 命令行里需要裹引号的那些字符。不需要的就不裹：`cmd` 对带引号的程序名处理起来更挑。
fn needs_quote(value: &str) -> bool {
    value
        .chars()
        .any(|ch| ch.is_whitespace() || matches!(ch, '&' | '(' | ')' | '%' | '^' | '<' | '>' | '|'))
}

/// 路径写成命令行里的一串，带空格或 cmd 的保留字符时才裹引号。
pub(super) fn quote(path: &str) -> String {
    if path.is_empty() || path.starts_with('"') || !needs_quote(path) {
        return path.to_string();
    }
    format!("\"{path}\"")
}

/// Groovy 字符串字面量里的内容：反斜杠和引号都要逃。
fn groovy_text(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// 深度受限、按目录名剪枝的遍历；返回根和它下面的所有目录。
fn sub_dirs(root: &Path) -> Vec<PathBuf> {
    WalkDir::new(root)
        .follow_links(false)
        .max_depth(MAX_DEPTH + 1)
        .into_iter()
        .filter_entry(|entry| entry.depth() == 0 || !is_skipped(entry))
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_dir())
        .map(|entry| entry.path().to_path_buf())
        .collect()
}

pub(super) fn is_skipped(entry: &walkdir::DirEntry) -> bool {
    let name = entry.file_name();
    // 遍历里每个条目都要问一次，别为它现造一个小写 String。
    SKIP_DIRS
        .iter()
        .any(|skip| name.eq_ignore_ascii_case(std::ffi::OsStr::new(skip)))
}

/// 读一个构建文件。读不动就记下原因并回 None，不把它当成「这个目录没有构建文件」。
fn read_build_file(path: &Path, problems: &mut Vec<String>) -> Option<String> {
    match fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(error) => {
            problems.push(err_parts(
                "READ",
                &[path.display().to_string(), error.to_string()],
            ));
            None
        }
    }
}

fn dir_name(dir: &Path) -> String {
    dir.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir.display().to_string())
}

/// 全名取最后一段，界面上的主类项就叫 `GytApplication.main()`。
fn short_name(fqcn: &str) -> &str {
    fqcn.rsplit('.').next().unwrap_or(fqcn)
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_alphabetic() || first == '_' || first == '$' => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_alphanumeric() || ch == '_' || ch == '$')
}

/// 仓库文件里读来的名字能不能原样拼进一行 shell 命令。
///
/// 识别结果整行交给 `cmd /C` 或 `sh -c` 跑，`&`、`|`、`$()`、引号这些一拼进去就是命令注入；
/// 这些名字（npm 脚本键、cargo 包名、go 包路径……）全部来自仓库文件，恶意仓库想借运行入口
/// 执行任意命令只隔这一层。白名单外的名字宁可少给一条运行配置，也不开这条通道：
/// 放行 Unicode 字母数字与 `_ - . / @ :`（`@scope/pkg`、`cmd/api`、`tauri:dev` 这类带分隔的名字要能通过），
/// 拒绝空白、shell 元字符、引号、`$` 与反引号，以及任何一段 `..`（不得逃出工程目录）。
fn safe_component(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let allowed = s
        .chars()
        .all(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | '@' | ':'));
    // 单独的 `.` 与 `..` 也不是可跑的目标；`..` 夹在相对路径中间同样要拒。
    // 前导 `-` 也不能放：`npm run -o` 会被 npm 当成自家旗标解析，这是参数注入
    // 而不是命令注入，但拒绝的成本就一个字符的判断。
    allowed
        && !s.starts_with('-')
        && s != "."
        && s != ".."
        && !s.split('/').any(|seg| seg == "..")
}

/// 抓第一个捕获组。构建文件的形状千奇百怪，抓不到回 None，由调用方决定退路。
fn capture(text: &str, pattern: &str) -> Option<String> {
    regex(pattern)?
        .captures(text)
        .and_then(|caps| caps.get(1))
        .map(|found| found.as_str().trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 把第一个匹配（整段，含标签）删掉。取 `<artifactId>` 之前要先把 `<parent>` 那一块摘干净，
/// 否则先命中的是父工程的名字。
fn strip_first(text: &str, pattern: &str) -> String {
    let Some(found) = regex(pattern).and_then(|re| re.find(text).map(|m| (m.start(), m.end()))) else {
        return text.to_string();
    };
    let mut out = String::with_capacity(text.len());
    out.push_str(&text[..found.0]);
    out.push_str(&text[found.1..]);
    out
}

/// 从 `java -version` 那一行（或一个版本号写法）里取大版本号。
///
/// `1.8.0_202` 里前面那个 1 不是版本号，要往后取一段；支持 `21-ea`、`21+35` 等早发/构建版本写法；认不出来回 0，调用方据此判「不知道」。
fn parse_feature(text: &str) -> u16 {
    let token = capture(text, "\"([^\"]+)\"").unwrap_or_else(|| {
        text.trim()
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_string()
    });
    // 兼容 1.8.0、17.0.2、21-ea、21+35 等写法：剥除后缀的非数字字符
    let parse_num = |s: &str| -> u16 {
        let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse().unwrap_or(0)
    };
    let parts: Vec<&str> = token.split('.').collect();
    let first = parts.first().map(|s| parse_num(s)).unwrap_or(0);
    if first > 1 {
        return first;
    }
    parts.get(1).map(|s| parse_num(s)).unwrap_or(0)
}

/// 这个源文件里有没有可当入口的 main。Java 认 `void main(...)`（含实例 main），Kotlin 认 `fun main`。
fn has_main_method(text: &str) -> bool {
    static JAVA_MAIN: &str = r"\bvoid\s+main\s*\(";
    static KOTLIN_MAIN: &str = r"\bfun\s+main\s*[(<]";
    static JAVA: OnceLock<Regex> = OnceLock::new();
    static KOTLIN: OnceLock<Regex> = OnceLock::new();
    // 源码树里每个文件都要问一遍，这两条模式必须只编译一次。
    let java = JAVA.get_or_init(|| Regex::new(JAVA_MAIN).expect("Java main 的模式必须能编译"));
    let kotlin =
        KOTLIN.get_or_init(|| Regex::new(KOTLIN_MAIN).expect("Kotlin main 的模式必须能编译"));
    java.is_match(text) || kotlin.is_match(text)
}

/// JVM 主类在装订线上的落点：类声明那一行加上 `main` 那一行，两处都能点。
///
/// Kotlin 与 Groovy 的顶层 `main` 未必有同名类型，那种就只剩 `main` 这一处。
fn jvm_markers(file: &str, stem: &str, text: &str) -> Vec<RunMarker> {
    // 声明行：固定模式抓捕获，类名与 stem 在代码里比对。拼进 pattern 的话，
    // 扫大仓时每个唯一类名都会在进程级缓存里驻留一条正则。
    let declaration = regex(r"\b(?:class|interface|enum|record|object)\s+(\w+)").and_then(|re| {
        re.captures_iter(text)
            .find(|cap| &cap[1] == stem)
            .and_then(|cap| cap.get(0).map(|found| line_at(text, found.start())))
    });
    let lines = [
        declaration,
        line_of(text, r"\b(?:void|fun)\s+main\s*[(<]"),
    ];
    let mut out: Vec<RunMarker> = Vec::new();
    for line in lines.into_iter().flatten() {
        let at = RunMarker { file: file.to_string(), line };
        if !out.contains(&at) {
            out.push(at);
        }
    }
    out
}

/// Go 的可执行包：包声明是 `main`，且这个包里有 `func main(`。
fn is_go_main_package(text: &str) -> bool {
    static PACKAGE: OnceLock<Regex> = OnceLock::new();
    static MAIN: OnceLock<Regex> = OnceLock::new();
    let package = PACKAGE
        .get_or_init(|| Regex::new(r"(?m)^package[ \t]+main\b").expect("Go 包声明的模式必须能编译"));
    let main = MAIN
        .get_or_init(|| Regex::new(r"(?m)^func[ \t]+main[ \t]*\(").expect("Go main 的模式必须能编译"));
    package.is_match(text) && main.is_match(text)
}

/// 这个 Python 文件自己就是入口：有 `if __name__ == "__main__"` 那一行守卫。
fn is_python_entry(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim_start();
        line.starts_with("if __name__") && line.contains("__main__")
    })
}

/// 非 JVM 那几族一律靠本机 PATH 上那个命令行工具起跑：命令里写裸程序名，
/// 本机没有就标 `NO_TOOL`，和 npm 客户端同一个口径（构建工具不在，条目读得出但跑不动）。
///
/// program 可能带参数（如 Windows 的 `py -3`）：探测只认首个词，整段拿去
/// `which` 的话磁盘上永远不存在叫 `py -3` 的文件，装了启动器反而被标成缺工具。
pub(super) fn program_missing(program: &str) -> Option<Unavailable> {
    let head = program.split_whitespace().next().unwrap_or(program);
    if sys::which_program(head).is_empty() {
        return Some(Unavailable {
            code: "NO_TOOL".to_string(),
            detail: program.to_string(),
        });
    }
    None
}

/// Python 解释器喊哪个名字。返回一整段可执行文本（可能带参数）。
///
/// Windows 上优先官方启动器 `py -3`：`-3` 钉住大版本，装了多套 Python 时不会被老版本抢走。
/// 商店装出来的 `WindowsApps\python.exe` 是 0 字节存根，`which` 拿得到、跑起来只会弹商店，
/// 认出来就跳过。类 UNIX 常只有 `python3`，候选顺序保持原样。
pub(super) fn python_program() -> String {
    if cfg!(windows) {
        if !sys::which_program("py").is_empty() {
            return "py -3".to_string();
        }
        for name in ["python", "python3"] {
            let found = sys::which_program(name);
            if !found.is_empty() && !is_windows_store_stub(&found) {
                return name.to_string();
            }
        }
        return "python".to_string();
    }
    for name in ["python", "python3"] {
        if !sys::which_program(name).is_empty() {
            return name.to_string();
        }
    }
    "python".to_string()
}

/// Microsoft 商店的 python 存根：`WindowsApps` 目录下的占位文件，不是真解释器。
/// 两种分隔符都认——`which` 回系统原样写法，构造测试时也可能给正斜杠写法。
fn is_windows_store_stub(path: &str) -> bool {
    path.contains("Microsoft\\WindowsApps") || path.contains("Microsoft/WindowsApps")
}

/// 极简 TOML 读取：只认 `[表]` / `[[表]]` 头和其下的单行 `键 = 值`。
/// 够读构建文件里的包名与 `[[bin]]` 目标；完整 TOML 语义不是识别该管的事。
fn toml_tables(text: &str) -> Vec<(String, Vec<(String, String)>)> {
    let mut out: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("[[") {
            if let Some(name) = rest.strip_suffix("]]") {
                out.push((name.trim().to_string(), Vec::new()));
                continue;
            }
        }
        if let Some(rest) = line.strip_prefix('[') {
            if let Some(name) = rest.strip_suffix(']') {
                out.push((name.trim().to_string(), Vec::new()));
                continue;
            }
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || out.is_empty() {
            continue;
        }
        let value = value
            .trim()
            .trim_matches(|ch| ch == '"' || ch == '\'')
            .to_string();
        if let Some((_, entries)) = out.last_mut() {
            entries.push((key.to_string(), value));
        }
    }
    out
}

/// 问某一张表里的一个键。
fn toml_value(tables: &[(String, Vec<(String, String)>)], table: &str, key: &str) -> Option<String> {
    tables
        .iter()
        .find(|(name, _)| name == table)
        .and_then(|(_, entries)| entries.iter().find(|(k, _)| k == key))
        .map(|(_, value)| value.clone())
}

/// 问同名多张表里的同一个键：`[[bin]]` 这类数组表就是这么读的。
fn toml_values(
    tables: &[(String, Vec<(String, String)>)],
    table: &str,
    key: &str,
) -> Vec<String> {
    tables
        .iter()
        .filter(|(name, _)| name == table)
        .filter_map(|(_, entries)| {
            entries
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, value)| value.clone())
        })
        .collect()
}

pub(super) fn maven_wrapper_names() -> (&'static str, &'static str) {
    if cfg!(windows) {
        ("mvnw.cmd", "mvnw")
    } else {
        ("mvnw", "mvnw")
    }
}

pub(super) fn gradle_wrapper_names() -> (&'static str, &'static str) {
    if cfg!(windows) {
        ("gradlew.bat", "gradlew")
    } else {
        ("gradlew", "gradlew")
    }
}

/// 本机工具位置在一次会话里不会变（换了 JDK 要重启应用才认），所以算一次就留著。
/// 不缓存的话光 `java -version` 一次开工程就要起两遍：识别一趟、`run_detect` 内部一趟，
/// 每遍 100-300 毫秒，还全在主线程上。
#[tauri::command]
pub async fn run_tools() -> Tools {
    block_value(tools_cached, Tools::empty).await
}

/// 本机工具的位置只信这么久。装进本来就在 PATH 上的目录（`%APPDATA%\npm`、`C:\tools\bin`）
/// 之后，界面上那些 `NO_TOOL` 标记和 `${mvn}` 占位必须能自己恢复，不能整个进程都停在「没装」。
const TOOLS_TTL: Duration = Duration::from_secs(60);

fn tools_cached() -> Tools {
    static CACHE: OnceLock<Mutex<Option<(Instant, Tools)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Some((at, hit)) = &*lock(cache) {
        if at.elapsed() < TOOLS_TTL {
            return hit.clone();
        }
    }
    let found = tools_scan();
    *lock(cache) = Some((Instant::now(), found.clone()));
    found
}

fn tools_scan() -> Tools {
    let java = java_executable();
    Tools {
        maven: sys::which_program("mvn"),
        gradle: sys::which_program("gradle"),
        java_feature: java_feature(&java),
        java,
    }
}

/// JDK 里的 java 可执行文件：先认 JAVA_HOME，再认 PATH。
fn java_executable() -> String {
    let tail = if cfg!(windows) {
        "bin\\java.exe"
    } else {
        "bin/java"
    };
    let from_home = sys::env_path("JAVA_HOME", tail);
    if !from_home.is_empty() && Path::new(&from_home).is_file() {
        return from_home;
    }
    sys::which_program("java")
}

/// 构建脚本里有没有提到某个 Gradle 插件。三种写法都认：
/// `plugins { application java }`（Kotlin/Groovy 里可以不带引号）、`id("application")`、
/// `apply plugin: 'application'`，以及 `org.gradle.application` 这种全名。
fn mentions_plugin(text: &str, name: &str) -> bool {
    if text.contains(&format!("org.gradle.{name}"))
        || text.contains(&format!("\"{name}\""))
        || text.contains(&format!("'{name}'"))
    {
        return true;
    }
    regex(r"(?s)plugins\s*\{([^}]*)\}")
        .and_then(|regex| regex.captures(text).map(|cap| cap[1].to_string()))
        .is_some_and(|block| mentions_word(&block, name))
}

/// 问这个 java 的大版本号。首行形如 `openjdk version "17.0.2" 2022-01-18 LTS`，取不到回 0。
fn java_feature(java: &str) -> u16 {
    parse_feature(&sys::capture_text(java, &["-version"]))
}

/// FNV-1a。init 脚本按主类寻址，同一处每次扫都落在同一个临时文件上。
fn fnv1a(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

impl Detector {
    /// 相对工程根的运行目录；根目录本身给空串。
    fn workdir(&self, dir: &Path) -> String {
        rel_path(&self.root, dir)
    }

    /// 工程自带的构建脚本在最前面。没有 wrapper 就喊 PATH 上那个工具，用占位写它，
    /// 命令一律从工程根起跑。
    fn tool(&mut self, dir: &Path, win_wrapper: &str, unix_wrapper: &str, program: &str) -> Tool {
        if let Some(at) = scan::nearest_ancestor_with(dir, &self.root, &[win_wrapper, unix_wrapper]) {
            // 从脚本所在层起跑，命令行里只写脚本名，不受路径上的空格影响。
            let invoke = if cfg!(windows) {
                win_wrapper.to_string()
            } else {
                format!("./{unix_wrapper}")
            };
            return Tool {
                invoke,
                dir: at,
                missing: None,
            };
        }
        if sys::which_program(program).is_empty() {
            return Tool {
                invoke: format!("${{{program}}}"),
                dir: self.root.clone(),
                missing: Some(Unavailable {
                    code: "NO_TOOL".to_string(),
                    detail: program.to_string(),
                }),
            };
        }
        Tool {
            invoke: format!("${{{program}}}"),
            dir: self.root.clone(),
            missing: None,
        }
    }

    /// 工具不在模块那一层时指过去：Maven 认 `-f <pom>`，Gradle 认 `-p <目录>`。
    /// 喊的永远是工具自己那层往下数的相对路径，工程挪盘子也不用改配置。
    fn location(&self, tool: &Tool, flag: &str, target: &Path) -> String {
        if tool.dir == target || target == tool.dir.join("pom.xml") {
            return String::new();
        }
        format!("{flag} {}", quote(&rel_path(&tool.dir, target)))
    }

    fn push(&mut self, config: RunConfiguration) {
        self.configs.push(config);
    }

    /// 扫一个目录里的 `package.json`。
    fn npm(&mut self, dir: &Path) {
        // Wails 模块里的 `package.json` 是嵌进桌面程序的前端资源，`wails dev` 自己会喊，
        // 不该在这儿变成用户的运行入口。
        if self.wails.iter().any(|at| dir.starts_with(at)) {
            return;
        }
        let path = dir.join("package.json");
        if !scan::has_file(dir, "package.json") {
            return;
        }
        self.owned.push(dir.to_path_buf());
        let Ok(text) = fs::read_to_string(&path) else {
            self.problems
                .push(err_parts("READ", &[path.display().to_string()]));
            return;
        };
        // 文件在但读不成 JSON 是另一回事，报出来，不冒充「这个工程没有脚本」。
        let parsed = serde_json::from_str::<serde_json::Value>(&text)
            .map_err(|error| err_parts("BAD_JSON", &[path.display().to_string(), error.to_string()]));
        let Ok(value) = parsed else {
            if let Err(problem) = parsed {
                self.problems.push(problem);
            }
            return;
        };
        let Some(scripts) = value.get("scripts").and_then(|item| item.as_object()) else {
            return;
        };
        let workdir = self.workdir(dir);
        let file = slashes(&rel_path(&self.root, &path));
        // 脚本键各占一行，装订线就指着它主张所在的那一行。这一遍还带着键在文件里的出现次序，
        // 条目就按它排：`serde_json::Map` 底下是 BTreeMap，直接迭代 `scripts` 出来的是字母序，
        // 和 `package.json` 里写的对不上。
        let keyed = object_key_lines(&text, "scripts");
        let lines = keyed.iter().cloned().collect::<HashMap<_, _>>();
        let mut order: Vec<&str> = Vec::new();
        for (name, _) in &keyed {
            // 成员资格以解析出来的 `scripts` 为准；重复的键（JSON 允许）只留头一次。
            if scripts.contains_key(name) && !order.contains(&name.as_str()) {
                order.push(name);
            }
        }
        // 文本扫描理论上不会漏键，真漏了也不能把脚本吞掉：补在末尾，次序差一条比少一条强。
        for name in scripts.keys() {
            if !order.contains(&name.as_str()) {
                order.push(name);
            }
        }
        // 必须经包管理器跑，不能把脚本正文直接丢给 cmd：`vue-cli-service`、`vite` 这些装在
        // `node_modules/.bin`，只有 npm 会给子进程加上这一条 PATH，裸 cmd 找不到程序就是退出码 1。
        let client = npm_client(dir, &self.root);
        let missing = if sys::which_program(client).is_empty() {
            Some(Unavailable {
                code: "NO_TOOL".to_string(),
                detail: client.to_string(),
            })
        } else {
            None
        };
        for name in order {
            // 脚本键是 package.json 里的任意 JSON 字符串，先过白名单再拼命令行。
            if !safe_component(name) {
                continue;
            }
            let markers = match lines.get(name) {
                Some(line) => vec![RunMarker { file: file.clone(), line: *line }],
                None => Vec::new(),
            };
            self.push(RunConfiguration {
                id: format!("npm:{workdir}:{name}"),
                name: name.to_string(),
                kind: RunKind::Npm,
                command: line(&[client, "run", name]),
                working_dir: workdir.clone(),
                env: Vec::new(),
                generated: true,
                pinned: false,
                unavailable: missing.clone(),
                helper: None,
                markers,
            });
        }
    }

    /// 扫一个目录里的 `pom.xml`。
    fn maven(&mut self, dir: &Path) {
        let pom = dir.join("pom.xml");
        if !scan::has_file(dir, "pom.xml") {
            return;
        }
        self.owned.push(dir.to_path_buf());
        let Some(text) = read_build_file(&pom, &mut self.problems) else {
            return;
        };
        // 聚合模块（packaging=pom）自己不出运行项，但 wrapper 可能就在它那一层。
        let aggregator = capture(&text, r"(?s)<packaging>\s*([^<]+?)\s*</packaging>")
            .as_deref()
            == Some("pom")
            || text.contains("<modules>");
        // `<parent>` 块里也有 artifactId，先摘掉再取本工程自己的那个。
        let stripped = strip_first(&text, r"(?s)<parent>.*?</parent>");
        let artifact = capture(&stripped, r"(?s)<artifactId>\s*([^<]+?)\s*</artifactId>")
            .unwrap_or_else(|| dir_name(dir));
        // `spring-boot:run` 这个目标只有在 pom 里绑了 spring-boot-maven-plugin 才存在：
        // 光依赖 spring-boot-starter 的那些是库模块，前缀解析不到插件，报成 Spring 就是条跑不通的配置。
        let spring = text.contains("spring-boot-maven-plugin");
        let declared_main = capture(&text, r"(?s)<mainClass>\s*([^<]+?)\s*</mainClass>");

        let (win, unix) = maven_wrapper_names();
        let tool = self.tool(dir, win, unix, "mvn");
        let location = self.location(&tool, "-f", &pom);

        let classes = if aggregator { Vec::new() } else { self.main_classes(dir) };
        // `spring-boot:run` 这条没有自己的源文件，装订线上那个落点就是带注解的那个启动类。
        let spring_marks: Vec<RunMarker> = if spring {
            classes
                .iter()
                .filter(|class| class.spring)
                .flat_map(|class| class.markers.clone())
                .collect()
        } else {
            Vec::new()
        };

        // 聚合模块（packaging=pom）没有应用启动类，但通常作为整个多模块项目的构建打包入口（clean package）。
        let (goals, kind) = if !aggregator && spring {
            ("spring-boot:run", RunKind::Spring)
        } else {
            ("clean package", RunKind::Maven)
        };
        self.push(RunConfiguration {
            id: format!("{kind:?}:{}/{goals}", self.workdir(dir)),
            name: format!("{artifact} [{goals}]"),
            kind,
            command: line(&[&tool.invoke, &location, goals]),
            working_dir: self.workdir(&tool.dir),
            env: Vec::new(),
            generated: true,
            pinned: false,
            unavailable: tool.missing.clone(),
            helper: None,
            markers: spring_marks,
        });

        if aggregator {
            return;
        }

        for class in classes {
            // pom 里写明的那个启动类、以及插件已绑好时带注解的那个，都由上面一条盖住了。
            // 没绑插件的模块不能喊 spring-boot:run，注解类照样得给一条 exec:java 的入口。
            if (spring && class.spring) || declared_main.as_deref() == Some(class.name.as_str()) {
                continue;
            }
            let fqcn = class.name;
            let property = format!("-Dexec.mainClass={fqcn}");
            self.push(RunConfiguration {
                id: format!("java:{}/{}", self.workdir(dir), fqcn),
                name: format!("{}.main()", short_name(&fqcn)),
                kind: RunKind::Java,
                command: line(&[&tool.invoke, &location, "compile", "exec:java", &property]),
                working_dir: self.workdir(&tool.dir),
                env: Vec::new(),
                generated: true,
                pinned: false,
                unavailable: tool.missing.clone(),
                helper: None,
                markers: class.markers,
            });
        }
    }

    /// 扫一个目录里的 `build.gradle` / `build.gradle.kts`。
    fn gradle(&mut self, dir: &Path) {
        let Some(name) = scan::first_file(dir, &["build.gradle.kts", "build.gradle"]) else {
            return;
        };
        let script = dir.join(name);
        self.owned.push(dir.to_path_buf());
        let Some(text) = read_build_file(&script, &mut self.problems) else {
            return;
        };
        // Android 应用不是「起一个 JVM 进程」这一类，这里不给。
        if text.contains("com.android.application") || text.contains("com.android.library") {
            return;
        }
        let module = dir_name(dir);
        // bootRun 这个任务只有 Spring Boot 插件真的 applied 才存在。依赖坐标
        // `org.springframework.boot:spring-boot-starter-web` 里也含这一段字符串，但它不是插件声明。
        let spring = mentions_plugin(&text, "org.springframework.boot");
        let application = mentions_plugin(&text, "application");
        let java_like = spring
            || application
            || mentions_plugin(&text, "java")
            || mentions_plugin(&text, "groovy")
            || text.contains("org.jetbrains.kotlin.jvm")
            || text.contains("kotlin(\"jvm\")")
            || text.contains("kotlin-jvm");

        let (win, unix) = gradle_wrapper_names();
        let tool = self.tool(dir, win, unix, "gradle");
        let location = self.location(&tool, "-p", dir);

        let goal = match (spring, application) {
            (true, _) => Some(("bootRun", RunKind::Spring)),
            (false, true) => Some(("run", RunKind::Gradle)),
            // 既不是应用也不是 Boot 服务的 JVM 模块：给一条构建，和 Maven 那边对称。
            (false, false) if java_like => Some(("build", RunKind::Gradle)),
            (false, false) => None,
        };
        let classes = if java_like { self.main_classes(dir) } else { Vec::new() };
        // `bootRun` 这条的落点同样是那个带注解的启动类。
        let spring_marks: Vec<RunMarker> = if spring {
            classes
                .iter()
                .filter(|class| class.spring)
                .flat_map(|class| class.markers.clone())
                .collect()
        } else {
            Vec::new()
        };

        if let Some((goal, kind)) = goal {
            self.push(RunConfiguration {
                id: format!("{kind:?}:{}/{goal}", self.workdir(dir)),
                name: format!("{module} [{goal}]"),
                kind,
                command: line(&[&tool.invoke, &location, goal]),
                working_dir: self.workdir(&tool.dir),
                env: Vec::new(),
                generated: true,
                pinned: false,
                unavailable: tool.missing.clone(),
                helper: None,
                markers: spring_marks,
            });
        }
        if !java_like {
            return;
        }
        for class in classes {
            // bootRun 那条盖住了带注解的启动类；没绑插件的模块里它仍然是个能跑的 main，要留入口。
            if spring && class.spring {
                continue;
            }
            // 借 Gradle 的运行时 classpath：一份 init 脚本在那个模块上造一个 JavaExec 任务，
            // 任务名是主类全名加 `.main()`。自己拼 classpath 就得解析依赖，那是另一件事。
            let fqcn = class.name;
            let task = format!("{fqcn}.main()");
            let helper = self.java_exec_script(dir, &task, &fqcn);
            let flag = format!("--init-script {}", quote(&helper.path));
            self.push(RunConfiguration {
                id: format!("java:{}/{fqcn}", self.workdir(dir)),
                name: format!("{}.main()", short_name(&fqcn)),
                kind: RunKind::Java,
                command: line(&[&tool.invoke, &location, &flag, &quote(&task)]),
                working_dir: self.workdir(&tool.dir),
                env: Vec::new(),
                generated: true,
                pinned: false,
                unavailable: tool.missing.clone(),
                helper: Some(helper),
                markers: class.markers,
            });
        }
    }

    /// 没有构建文件的工程：把带主类的那个源文件交给 JDK 的单文件启动器。
    fn bare_java(&mut self) {
        let missing = if self.java.is_empty() {
            Some(Unavailable {
                code: "NO_JDK".to_string(),
                detail: "java".to_string(),
            })
        } else if self.java_feature < MIN_SINGLE_FILE_JDK {
            Some(Unavailable {
                code: "JDK_TOO_OLD".to_string(),
                detail: self.java_feature.to_string(),
            })
        } else {
            None
        };
        let mut roots = vec![self.root.join("src").join("main").join("java"), self.root.clone()];
        roots.retain(|root| root.is_dir());
        for root in roots {
            let found = self.main_classes_in(&root, MAX_SOURCE_FILES);
            if found.is_empty() {
                continue;
            }
            for class in found {
                // 单文件启动器只编它自己；多文件工程该有构建文件，交给上面那两条路。
                let short = short_name(&class.name).to_string();
                let file = quote(&class.file);
                self.push(RunConfiguration {
                    id: format!("java:{}", class.file),
                    name: format!("{short}.main()"),
                    kind: RunKind::Java,
                    command: line(&["${java}", &file]),
                    working_dir: String::new(),
                    env: Vec::new(),
                    generated: true,
                    pinned: false,
                    unavailable: missing.clone(),
                    helper: None,
                    markers: class.markers,
                });
            }
            break;
        }
    }

    /// 一个模块下的主类：`src/main/{java,kotlin,groovy}`。
    fn main_classes(&mut self, module: &Path) -> Vec<MainClass> {
        let mut found = Vec::new();
        for language in ["java", "kotlin", "groovy"] {
            let source = module.join("src").join("main").join(language);
            if source.is_dir() {
                found.extend(self.main_classes_in(&source, MAX_SOURCE_FILES));
            }
        }
        found
    }

    /// 翻一颗源码树找带 main 的文件，超过上限就停下并记下这件事。
    fn main_classes_in(&mut self, source: &Path, limit: usize) -> Vec<MainClass> {
        let mut found = Vec::new();
        let walker = WalkDir::new(source)
            .follow_links(false)
            .max_depth(24)
            .into_iter()
            .filter_entry(|entry| entry.depth() == 0 || !is_skipped(entry));
        let mut visited = 0usize;
        for entry in walker
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file())
            .filter(|entry| {
                matches!(
                    entry.path().extension().and_then(|ext| ext.to_str()),
                    Some("java" | "kt" | "groovy")
                )
            })
        {
            visited += 1;
            if visited > limit {
                self.problems
                    .push(err_parts("TOO_MANY_SOURCES", &[source.display().to_string()]));
                break;
            }
            if entry
                .metadata()
                .map(|meta| meta.len() > MAX_FILE_BYTES)
                .unwrap_or(true)
            {
                continue;
            }
            let path = entry.path();
            let Ok(text) = fs::read_to_string(path) else {
                continue;
            };
            if !has_main_method(&text) {
                continue;
            }
            let stem = path
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_default();
            if !is_identifier(&stem) {
                continue;
            }
            let rel = rel_path(&self.root, path);
            let package = capture(&text, r"(?m)^\s*package\s+([A-Za-z_][\w.]*)");
            let name = match package {
                Some(package) => format!("{package}.{stem}"),
                None => stem.clone(),
            };
            let markers = jvm_markers(&slashes(&rel), &stem, &text);
            found.push(MainClass {
                spring: text.contains("@SpringBootApplication"),
                file: rel,
                name,
                markers,
            });
        }
        found
    }

    /// Gradle init 脚本的内容：在指定目录那个项目上造一个 JavaExec 任务，任务名是主类全名。
    /// 文件落在系统临时目录，起跑前由界面写下去（构建文件本身一个字都不碰）。
    fn java_exec_script(&self, module: &Path, task: &str, main_class: &str) -> HelperFile {
        let body = format!(
            "def moduleDir = new File(\"{module}\")\n\
             def mainClassToRun = \"{main}\"\n\
             def taskName = \"{task}\"\n\n\
             gradle.afterProject {{ project ->\n\
             \x20 if (project.projectDir.canonicalFile == moduleDir.canonicalFile && project.plugins.hasPlugin('java')) {{\n\
             \x20\x20 project.tasks.create(name: taskName, type: JavaExec) {{ exec ->\n\
             \x20\x20\x20 exec.classpath = project.sourceSets.main.runtimeClasspath\n\
             \x20\x20\x20 exec.mainClass = mainClassToRun\n\
             \x20\x20\x20 exec.standardInput = System.in\n\
             \x20\x20 }}\n\
             \x20 }}\n\
             }}\n",
            module = groovy_text(&module.display().to_string()),
            main = groovy_text(main_class),
            task = groovy_text(task),
        );
        let dir = std::env::temp_dir().join("forge-run");
        HelperFile {
            path: dir
                .join(format!("run-{}.gradle", fnv1a(task)))
                .display()
                .to_string(),
            content: body,
        }
    }

    /// 扫一个目录里的 `go.mod`。Wails 另有标志文件；其余按「哪些目录是可执行包」出条目。
    fn golang(&mut self, dir: &Path) {
        let manifest = dir.join("go.mod");
        if !scan::has_file(dir, "go.mod") {
            return;
        }
        self.owned.push(dir.to_path_buf());
        let Some(text) = read_build_file(&manifest, &mut self.problems) else {
            return;
        };
        let module = capture(&text, r"(?m)^module[ \t]+(\S+)").unwrap_or_else(|| dir_name(dir));
        let base = module
            .rsplit('/')
            .next()
            .unwrap_or(module.as_str())
            .to_string();
        let workdir = self.workdir(dir);

        // Wails v2 与 v3 都用 `wails.json`，起跑命令也一样：`wails dev` 自己起前端。
        if scan::has_file(dir, "wails.json") {
            self.wails.push(dir.to_path_buf());
            self.push(RunConfiguration {
                id: format!("wails:{workdir}:dev"),
                name: format!("{base} [wails dev]"),
                kind: RunKind::Wails,
                command: "wails dev".to_string(),
                working_dir: workdir,
                env: Vec::new(),
                generated: true,
                pinned: false,
                unavailable: program_missing("wails"),
                helper: None,
                markers: Vec::new(),
            });
            return;
        }

        let missing = program_missing("go");
        for (pkg, markers) in self.go_main_packages(dir) {
            // 目标一律写成模块根往下数的相对包路径，工程挪盘子不用改配置。
            // `.` 是模块根的字面量（代码自己给的，不是文件里来的），不在校验列；
            // 其余包路径来自目录名，先过白名单再拼 `./{pkg}`。
            let (name, target) = if pkg == "." {
                (base.clone(), ".".to_string())
            } else {
                if !safe_component(&pkg) {
                    continue;
                }
                (pkg.clone(), format!("./{pkg}"))
            };
            self.push(RunConfiguration {
                id: format!("go:{workdir}:{pkg}"),
                name: format!("{name} [go run]"),
                kind: RunKind::Go,
                command: format!("go run {target}"),
                working_dir: workdir.clone(),
                env: Vec::new(),
                generated: true,
                pinned: false,
                unavailable: missing.clone(),
                helper: None,
                markers,
            });
        }
    }

    /// 模块里哪些目录是可执行包，回相对模块根的斜杠目录（模块根本身是 `.`），
    /// 连同该包里 `func main` 的落点。嵌在另一份 `go.mod` 底下的那些归那个模块管，这里跳过。
    fn go_main_packages(&mut self, module: &Path) -> Vec<(String, Vec<RunMarker>)> {
        let mut found: BTreeMap<String, Vec<RunMarker>> = BTreeMap::new();
        let walker = WalkDir::new(module)
            .follow_links(false)
            .max_depth(24)
            .into_iter()
            .filter_entry(|entry| entry.depth() == 0 || !is_skipped(entry));
        let mut visited = 0usize;
        // 「这个目录是不是嵌在另一份 go.mod 底下」是按目录算的性质，不是按文件算的。
        // 不记下来的话每个 .go 文件都要往上逐层 stat 一遍，两千个文件乘上深度就是一万次白做的 stat。
        let mut nested_of: HashMap<PathBuf, bool> = HashMap::new();
        for entry in walker
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file())
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                name.ends_with(".go") && !name.ends_with("_test.go")
            })
        {
            visited += 1;
            if visited > MAX_SOURCE_FILES {
                self.problems
                    .push(err_parts("TOO_MANY_SOURCES", &[module.display().to_string()]));
                break;
            }
            let path = entry.path();
            let Some(parent) = path.parent() else {
                continue;
            };
            let nested = *nested_of
                .entry(parent.to_path_buf())
                .or_insert_with(|| {
                    parent != module
                        && scan::nearest_ancestor_with(parent, module, &["go.mod"])
                            .is_some_and(|at| at != module)
                });
            if nested {
                continue;
            }
            if path
                .metadata()
                .map(|meta| meta.len() > MAX_FILE_BYTES)
                .unwrap_or(true)
            {
                continue;
            }
            let Ok(text) = fs::read_to_string(path) else {
                continue;
            };
            if !is_go_main_package(&text) {
                continue;
            }
            let rel = rel_path(module, parent).replace('\\', "/");
            let dir = if rel.is_empty() { ".".to_string() } else { rel };
            if found.contains_key(&dir) {
                continue;
            }
            let markers = match line_of(&text, r"(?m)^func\s+main\s*\(") {
                Some(line) => vec![RunMarker { file: slashes(&rel_path(&self.root, path)), line }],
                None => Vec::new(),
            };
            found.insert(dir, markers);
        }
        found.into_iter().collect()
    }

    /// 一个源文件里那条模式所在的行，换算成装订线上的落点；读不到或没命中就不给。
    fn marker_at(&self, path: &Path, pattern: &str) -> Vec<RunMarker> {
        let Ok(text) = fs::read_to_string(path) else {
            return Vec::new();
        };
        match line_of(&text, pattern) {
            Some(line) => vec![RunMarker { file: slashes(&rel_path(&self.root, path)), line }],
            None => Vec::new(),
        }
    }

    /// 扫一个目录里的 `Cargo.toml`：有可执行目标的 crate 给一条 `cargo run -p`。
    /// 工作区根那份通常只有 `[workspace]`，成员 crate 由遍历到它们各自那层时认。
    fn rust(&mut self, dir: &Path) {
        let manifest = dir.join("Cargo.toml");
        if !scan::has_file(dir, "Cargo.toml") {
            return;
        }
        self.owned.push(dir.to_path_buf());
        let Some(text) = read_build_file(&manifest, &mut self.problems) else {
            return;
        };
        let tables = toml_tables(&text);
        let Some(package) = toml_value(&tables, "package", "name") else {
            return;
        };
        // 包名要拼进这个 crate 的每一条 `cargo run -p`，不合法的整个 crate 都不给。
        if !safe_component(&package) {
            return;
        }
        let mut bins = toml_values(&tables, "bin", "name");
        if bins.is_empty() {
            if dir.join("src").join("main.rs").is_file() {
                bins.push(package.clone());
            }
            if let Some(entries) = fs::read_dir(dir.join("src").join("bin")).ok() {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
                        if let Some(stem) = path.file_stem() {
                            bins.push(stem.to_string_lossy().into_owned());
                        }
                    }
                }
            }
        }
        // 只有库的 crate 没有可跑的东西，和 JVM 那边「库模块不给运行项」同一个道理。
        if bins.is_empty() {
            return;
        }
        // 每个可执行目标对应哪个源文件：`[[bin]]` 自带 path 就按它，
        // 其余按 cargo 的默认目录约定，装订线要指的就是那个文件里的 `fn main`。
        let mut sources: HashMap<String, PathBuf> = HashMap::new();
        for (table, pairs) in &tables {
            if table != "bin" {
                continue;
            }
            let get = |key: &str| {
                pairs.iter().find(|(name, _)| name == key).map(|(_, value)| value.clone())
            };
            if let (Some(name), Some(path)) = (get("name"), get("path")) {
                sources.insert(name, dir.join(path));
            }
        }
        for bin in &bins {
            sources.entry(bin.clone()).or_insert_with(|| {
                if bin == &package {
                    dir.join("src").join("main.rs")
                } else {
                    dir.join("src").join("bin").join(format!("{bin}.rs"))
                }
            });
        }
        let multiple = bins.len() > 1;
        let missing = program_missing("cargo");
        let workdir = self.workdir(dir);
        for bin in bins {
            // bin 名来自 `[[bin]]` 或 src/bin 的文件名，同为仓库里来的标识符，一起过白名单。
            if !safe_component(&bin) {
                continue;
            }
            let flag = if multiple && bin != package {
                format!(" --bin {bin}")
            } else {
                String::new()
            };
            let markers = self.marker_at(&sources[&bin], r"\bfn\s+main\s*\(");
            self.push(RunConfiguration {
                id: format!("cargo:{workdir}:{bin}"),
                name: format!("{bin} [cargo run]"),
                kind: RunKind::Rust,
                command: format!("cargo run -p {package}{flag}"),
                working_dir: workdir.clone(),
                env: Vec::new(),
                generated: true,
                pinned: false,
                unavailable: missing.clone(),
                helper: None,
                markers,
            });
        }
    }

    /// 扫一个目录里的 Python 工程标志。一个工程只给一条：框架优先，其次带 `__main__.py` 的包。
    fn python(&mut self, dir: &Path) {
        let mut manifests: Vec<PathBuf> = Vec::new();
        for name in [
            "pyproject.toml",
            "setup.py",
            "setup.cfg",
            "Pipfile",
            "requirements.txt",
        ] {
            if scan::has_file(dir, name) {
                manifests.push(dir.join(name));
            }
        }
        if manifests.is_empty() {
            return;
        }
        self.owned.push(dir.to_path_buf());
        let mut deps = String::new();
        for path in &manifests {
            if let Some(text) = read_build_file(path, &mut self.problems) {
                deps.push_str(&text.to_lowercase());
            }
        }
        let program = python_program();
        let missing = program_missing(&program);
        let workdir = self.workdir(dir);
        let base = dir_name(dir);

        // Django 的 `manage.py` 是硬标志；其余框架先看依赖，再从源文件里找那个构造调用。
        // 第三个那一项是入口所在的源文件，装订线就指它；认不出文件的是 None。
        let entry = if scan::has_file(dir, "manage.py") {
            Some((
                "runserver".to_string(),
                format!("{program} manage.py runserver"),
                slashes(&rel_path(&self.root, &dir.join("manage.py"))),
            ))
        } else if deps.contains("fastapi") {
            self.source_where(dir, "py", |text| text.to_lowercase().contains("fastapi("))
                .map(|file| ("fastapi dev".to_string(), format!("fastapi dev {file}"), file))
        } else if deps.contains("streamlit") {
            // Streamlit 的脚本通常只写 `st.` 这个别名，源码里未必出现库名。
            self.source_where(dir, "py", |text| {
                let lower = text.to_lowercase();
                lower.contains("streamlit") || text.contains("st.")
            })
            .map(|file| ("streamlit run".to_string(), format!("streamlit run {file}"), file))
        } else if deps.contains("flask") {
            match self.source_where(dir, "py", |text| text.to_lowercase().contains("flask(")) {
                Some(file) => Some((
                    "flask run".to_string(),
                    format!("flask --app {file} run"),
                    file,
                )),
                None => Some((
                    "flask run".to_string(),
                    "flask run".to_string(),
                    String::new(),
                )),
            }
        } else {
            None
        };
        // 没有可认的框架时：能 `python -m <包>` 就喊包名，再不行就挑第一个带入口守卫的脚本。
        let entry = entry
            .or_else(|| self.python_package_entry(dir, &program))
            .or_else(|| {
                self.source_where(dir, "py", is_python_entry)
                    .map(|file| (file.clone(), format!("{program} {file}"), file))
            });
        let Some((goal, command, source)) = entry else {
            return;
        };
        let markers = if source.is_empty() {
            Vec::new()
        } else {
            self.python_marker(&source)
        };
        self.push(RunConfiguration {
            id: format!("py:{workdir}:{goal}"),
            name: format!("{base} [{goal}]"),
            kind: RunKind::Python,
            command,
            working_dir: workdir,
            env: Vec::new(),
            generated: true,
            pinned: false,
            unavailable: missing,
            helper: None,
            markers,
        });
    }

    /// Python 的落点：入口文件里那条 `if __name__ == "__main__"` 所在的行。
    ///
    /// 只有一句 `app = FastAPI()`、没有入口守卫的脚本，PyCharm 那侧也不画装订线图标，这里跟着不给。
    fn python_marker(&self, rel_file: &str) -> Vec<RunMarker> {
        self.marker_at(
            &self.root.join(rel_file),
            r#"(?m)^[ \t]*if\s+__name__\s*==\s*["']__main__["']"#,
        )
    }

    fn python_package_entry(
        &self,
        dir: &Path,
        program: &str,
    ) -> Option<(String, String, String)> {
        let found = WalkDir::new(dir)
            .follow_links(false)
            .max_depth(8)
            .into_iter()
            .filter_entry(|entry| entry.depth() == 0 || !is_skipped(entry))
            .filter_map(|entry| entry.ok())
            .find(|entry| entry.file_name() == "__main__.py")?;
        let package = found.path().parent()?.file_name()?.to_string_lossy().into_owned();
        Some((
            format!("-m {package}"),
            format!("{program} -m {package}"),
            slashes(&rel_path(&self.root, found.path())),
        ))
    }

    /// 什么构建文件都没有的目录：根上有常用入口名的 `.py` 就交给解释器直接跑那个文件。
    fn bare_python(&mut self) {
        let program = python_program();
        for name in ["main.py", "app.py", "run.py"] {
            if scan::has_file(&self.root, name) {
                self.push(RunConfiguration {
                    id: format!("py::script:{name}"),
                    name: name.to_string(),
                    kind: RunKind::Python,
                    command: format!("{program} {name}"),
                    working_dir: String::new(),
                    env: Vec::new(),
                    generated: true,
                    pinned: false,
                    unavailable: program_missing(&program),
                    helper: None,
                    markers: self.python_marker(name),
                });
                return;
            }
        }
    }

    /// 扫一个目录里的 `.csproj` / `.fsproj`：可执行的项目给 `dotnet run --project`，类库不给。
    fn dotnet(&mut self, dir: &Path) {
        let mut projects: Vec<PathBuf> = scan::typed_files(dir, &["csproj", "fsproj"])
            .into_iter()
            .map(|name| dir.join(name))
            .collect();
        if projects.is_empty() {
            return;
        }
        projects.sort();
        self.owned.push(dir.to_path_buf());
        let missing = program_missing("dotnet");
        for path in projects {
            let Some(text) = read_build_file(&path, &mut self.problems) else {
                continue;
            };
            // Web / Blazor 这套 SDK 一定是起进程的，其余看 `<OutputType>` 是不是 Exe。
            let executable = text.contains("Microsoft.NET.Sdk.Web")
                || text.contains("BlazorWebAssembly")
                || capture(&text, r"(?is)<OutputType>\s*([^<]+?)\s*</OutputType>")
                    .is_some_and(|kind| matches!(kind.to_lowercase().as_str(), "exe" | "winexe"));
            if !executable {
                continue;
            }
            let stem = path
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_default();
            let rel = rel_path(&self.root, &path).replace('\\', "/");
            self.push(RunConfiguration {
                id: format!("dotnet:{rel}"),
                name: format!("{stem} [dotnet run]"),
                kind: RunKind::DotNet,
                command: format!("dotnet run --project {rel}"),
                working_dir: String::new(),
                env: Vec::new(),
                generated: true,
                pinned: false,
                unavailable: missing.clone(),
                helper: None,
                markers: Vec::new(),
            });
        }
    }

    /// 「一个工程就一条起跑命令」那几族共用这一口：条目名 `{目录} [{目标}]`，缺工具一起判掉。
    fn push_simple(&mut self, kind: RunKind, dir: &Path, goal: &str, command: String, program: &str) {
        let workdir = self.workdir(dir);
        self.owned.push(dir.to_path_buf());
        self.push(RunConfiguration {
            id: format!("{kind:?}:{workdir}:{goal}"),
            name: format!("{} [{goal}]", dir_name(dir)),
            kind,
            command,
            working_dir: workdir,
            env: Vec::new(),
            generated: true,
            pinned: false,
            unavailable: program_missing(program),
            helper: None,
            markers: Vec::new(),
        });
    }

    /// `composer.json`：Laravel 认 `artisan`，其次 composer 自己的 serve / start / dev 脚本，
    /// 再退一步才是 PHP 内置服务器顶到 `public/index.php` 前面。
    fn php(&mut self, dir: &Path) {
        let manifest = dir.join("composer.json");
        if !scan::has_file(dir, "composer.json") {
            return;
        }
        if scan::has_file(dir, "artisan") {
            self.push_simple(RunKind::Php, dir, "artisan serve", "php artisan serve".to_string(), "php");
            return;
        }
        let Some(text) = read_build_file(&manifest, &mut self.problems) else {
            return;
        };
        let parsed = serde_json::from_str::<serde_json::Value>(&text);
        let scripts = parsed
            .as_ref()
            .ok()
            .and_then(|value| value.get("scripts"))
            .and_then(|scripts| scripts.as_object());
        if parsed.is_err() {
            self.problems
                .push(err_parts("BAD_JSON", &[manifest.display().to_string()]));
        }
        let picked = ["serve", "start", "dev", "watch", "run"]
            .iter()
            .filter_map(|name| {
                scripts
                    .as_ref()
                    .filter(|table| table.contains_key(*name))
                    .map(|_| name.to_string())
            })
            .next();
        if let Some(name) = picked {
            self.push_simple(
                RunKind::Php,
                dir,
                &name,
                format!("composer {name}"),
                "composer",
            );
            return;
        }
        if dir.join("public").join("index.php").is_file() {
            self.push_simple(
                RunKind::Php,
                dir,
                "serve",
                "php -S localhost:8000 -t public".to_string(),
                "php",
            );
        }
    }

    /// `Gemfile`：Rails 有 binstub 就 `bin/rails server`，否则 `bundle exec rails server`；
    /// 不是 Rails 但有 `config.ru` 走 rackup，再退一步是那个引 Sinatra 的脚本。
    fn ruby(&mut self, dir: &Path) {
        let manifest = dir.join("Gemfile");
        if !scan::has_file(dir, "Gemfile") {
            return;
        }
        let Some(text) = read_build_file(&manifest, &mut self.problems) else {
            return;
        };
        if dir.join("bin").join("rails").is_file() {
            self.push_simple(
                RunKind::Ruby,
                dir,
                "rails server",
                "bin/rails server".to_string(),
                "ruby",
            );
            return;
        }
        let rails = text.contains("\"rails\"") || text.contains("'rails'");
        if rails {
            self.push_simple(
                RunKind::Ruby,
                dir,
                "rails server",
                "bundle exec rails server".to_string(),
                "bundle",
            );
        } else if scan::has_file(dir, "config.ru") {
            self.push_simple(RunKind::Ruby, dir, "rackup", "bundle exec rackup".to_string(), "bundle");
        } else if let Some(file) = self.source_where(dir, "rb", |text| text.contains("Sinatra")) {
            self.push_simple(
                RunKind::Ruby,
                dir,
                "ruby",
                format!("bundle exec ruby {file}"),
                "bundle",
            );
        }
    }

    /// `pubspec.yaml`：带 Flutter SDK 依赖的是移动应用，其余按 Dart 工程起。
    fn dart(&mut self, dir: &Path) {
        let manifest = dir.join("pubspec.yaml");
        if !scan::has_file(dir, "pubspec.yaml") {
            return;
        }
        let Some(text) = read_build_file(&manifest, &mut self.problems) else {
            return;
        };
        if text.contains("flutter:") || text.contains("sdk: flutter") {
            self.push_simple(RunKind::Dart, dir, "flutter run", "flutter run".to_string(), "flutter");
        } else {
            self.push_simple(RunKind::Dart, dir, "dart run", "dart run".to_string(), "dart");
        }
    }

    /// `build.sbt`：多模块也先给根上这一条，`sbt run` 自己会挑主类。
    fn scala(&mut self, dir: &Path) {
        if scan::has_file(dir, "build.sbt") {
            self.push_simple(RunKind::Scala, dir, "sbt run", "sbt run".to_string(), "sbt");
        }
    }

    /// `mix.exs`：Phoenix 走 `mix phx.server`，普通 OTP 应用 `mix run --no-halt` 把 supervision tree 起来。
    fn elixir(&mut self, dir: &Path) {
        let manifest = dir.join("mix.exs");
        if !scan::has_file(dir, "mix.exs") {
            return;
        }
        let Some(text) = read_build_file(&manifest, &mut self.problems) else {
            return;
        };
        if text.contains("phoenix") {
            self.push_simple(
                RunKind::Elixir,
                dir,
                "phx.server",
                "mix phx.server".to_string(),
                "mix",
            );
        } else {
            self.push_simple(
                RunKind::Elixir,
                dir,
                "run",
                "mix run --no-halt".to_string(),
                "mix",
            );
        }
    }

    /// C / C++：`CMakeLists.txt` 先配再编（没配过的工程直接 `cmake --build build` 会失败，
    /// 所以这一条把配置那步带上）；只有 Makefile 的目录才喊 `make`。
    fn native(&mut self, dir: &Path) {
        let cmake = scan::has_file(dir, "CMakeLists.txt");
        let makefile = scan::first_file(dir, &["Makefile", "makefile"])
            .map(|name| dir.join(name));
        if cmake {
            self.push_simple(
                RunKind::Cpp,
                dir,
                "cmake build",
                "cmake -S . -B build && cmake --build build".to_string(),
                "cmake",
            );
            return;
        }
        let Some(path) = makefile else {
            return;
        };
        // Makefile 在别的体系里太常见了（npm、go、cargo 工程都爱包一层），这一层已经被认出来就不插一脚。
        if self.owned.iter().any(|at| at == dir) {
            return;
        }
        let Some(text) = read_build_file(&path, &mut self.problems) else {
            return;
        };
        let has_run = regex(r"(?m)^[\w./-]*\brun\s*:")
            .map(|regex| regex.is_match(&text))
            .unwrap_or(false);
        let command = if has_run { "make run" } else { "make" };
        self.push_simple(RunKind::Cpp, dir, command, command.to_string(), "make");
    }

    /// `build.zig`：声明了 run 步骤就 `zig build run`。
    fn zig(&mut self, dir: &Path) {
        let manifest = dir.join("build.zig");
        if !scan::has_file(dir, "build.zig") {
            return;
        }
        let Some(text) = read_build_file(&manifest, &mut self.problems) else {
            return;
        };
        let goal = if text.contains("b.step(\"run\"") { "run" } else { "build" };
        self.push_simple(
            RunKind::Zig,
            dir,
            goal,
            format!("zig build {goal}"),
            "zig",
        );
    }

    /// `deno.json` / `deno.jsonc` 的 `tasks`：每条一个 `deno task <名>`，和 npm 脚本同一个口径。
    fn deno(&mut self, dir: &Path) {
        let Some(name) = scan::first_file(dir, &["deno.json", "deno.jsonc"]) else {
            return;
        };
        let path = dir.join(name);
        self.owned.push(dir.to_path_buf());
        let Some(text) = read_build_file(&path, &mut self.problems) else {
            return;
        };
        // jsonc 里的注释读不成 JSON：报出来，别冒充「这个工程没有任务」。
        let parsed = serde_json::from_str::<serde_json::Value>(&text)
            .map_err(|error| err_parts("BAD_JSON", &[path.display().to_string(), error.to_string()]));
        let Ok(value) = parsed else {
            if let Err(problem) = parsed {
                self.problems.push(problem);
            }
            return;
        };
        let Some(tasks) = value.get("tasks").and_then(|item| item.as_object()) else {
            return;
        };
        let workdir = self.workdir(dir);
        let missing = program_missing("deno");
        for name in tasks.keys() {
            // 任务名是 deno.json 里的任意 JSON 键，先过白名单再拼命令行。
            if !safe_component(name) {
                continue;
            }
            self.push(RunConfiguration {
                id: format!("deno:{workdir}:{name}"),
                name: name.clone(),
                kind: RunKind::Deno,
                command: format!("deno task {name}"),
                working_dir: workdir.clone(),
                env: Vec::new(),
                generated: true,
                pinned: false,
                unavailable: missing.clone(),
                helper: None,
                markers: Vec::new(),
            });
        }
    }

    /// Clojure：`project.clj` 是 Leiningen 的工程走 `lein run`；`deps.edn` 走 `clojure -M`，
    /// 有 `:dev` 别名就带上（那别名通常就是 `-main` 的落点）。
    fn clojure(&mut self, dir: &Path) {
        if scan::has_file(dir, "project.clj") {
            self.push_simple(RunKind::Clojure, dir, "lein run", "lein run".to_string(), "lein");
            return;
        }
        let manifest = dir.join("deps.edn");
        if !scan::has_file(dir, "deps.edn") {
            return;
        }
        let Some(text) = read_build_file(&manifest, &mut self.problems) else {
            return;
        };
        let has_dev = text.contains(":dev");
        let command = if has_dev { "clojure -M:dev" } else { "clojure -M" };
        self.push_simple(RunKind::Clojure, dir, command, command.to_string(), "clojure");
    }

    /// Haskell：Stack 的工程（`stack.yaml` 或它的 `package.yaml`）走 `stack run`，只有 `.cabal` 的走 `cabal run`。
    fn haskell(&mut self, dir: &Path) {
        let stack = scan::has_file(dir, "stack.yaml") || scan::has_file(dir, "package.yaml");
        let cabal = !scan::typed_files(dir, &["cabal"]).is_empty();
        if stack {
            self.push_simple(RunKind::Haskell, dir, "stack run", "stack run".to_string(), "stack");
        } else if cabal {
            self.push_simple(RunKind::Haskell, dir, "cabal run", "cabal run".to_string(), "cabal");
        }
    }

    /// Julia：`Project.toml` 那层找 `src/main.jl` 或根上的 `main.jl`，`--project=.` 把环境钉在这个目录。
    /// 两个都没有就当库——不给条目比猜一个入口诚实。
    fn julia(&mut self, dir: &Path) {
        if !scan::has_file(dir, "Project.toml") {
            return;
        }
        for name in ["src/main.jl", "main.jl"] {
            if scan::has_file(dir, name) {
                self.push_simple(
                    RunKind::Julia,
                    dir,
                    name,
                    format!("julia --project=. {name}"),
                    "julia",
                );
                return;
            }
        }
    }

    /// Lua：有 `conf.lua` 就是 LÖVE 工程（那两个文件是它的骨架）；工程根上单一个 `main.lua`
    /// 才交给 lua 解释器，别的目录里的 `.lua` 多半是嵌进去的脚本。
    fn lua(&mut self, dir: &Path) {
        if scan::has_file(dir, "conf.lua") {
            self.push_simple(RunKind::Lua, dir, "love", "love .".to_string(), "love");
            return;
        }
        if dir == self.root
            && scan::has_file(&self.root, "main.lua")
            && !self.owned.iter().any(|at| at == dir)
        {
            self.push_simple(RunKind::Lua, dir, "main.lua", "lua main.lua".to_string(), "lua");
        }
    }

    /// `Package.swift`：可执行目标挨个出一条；只有一个时 `swift run` 不用点名。
    fn swift(&mut self, dir: &Path) {
        let manifest = dir.join("Package.swift");
        if !scan::has_file(dir, "Package.swift") {
            return;
        }
        let Some(text) = read_build_file(&manifest, &mut self.problems) else {
            return;
        };
        let targets: Vec<String> = regex(r#"executableTarget\(\s*name:\s*"([^"]+)""#)
            .map(|regex| {
                regex
                    .captures_iter(&text)
                    .filter_map(|cap| cap.get(1))
                    .map(|found| found.as_str().to_string())
                    .collect()
            })
            .unwrap_or_default();
        if targets.is_empty() {
            self.push_simple(RunKind::Swift, dir, "swift run", "swift run".to_string(), "swift");
            return;
        }
        let workdir = self.workdir(dir);
        let missing = program_missing("swift");
        let count = targets.len();
        self.owned.push(dir.to_path_buf());
        for target in targets {
            // target 名是 Package.swift 引号里的任意串，先过白名单再拼命令行。
            if !safe_component(&target) {
                continue;
            }
            // 只有一个可执行目标时 `swift run` 不用点名，多了必须点。
            let command = if count == 1 {
                "swift run".to_string()
            } else {
                format!("swift run {target}")
            };
            self.push(RunConfiguration {
                id: format!("Swift:{workdir}:{target}"),
                name: format!("{target} [swift run]"),
                kind: RunKind::Swift,
                command,
                working_dir: workdir.clone(),
                env: Vec::new(),
                generated: true,
                pinned: false,
                unavailable: missing.clone(),
                helper: None,
                markers: Vec::new(),
            });
        }
    }

    /// 这一棵目录里第一个「后缀对、正文符合条件」的源文件，回相对工程根的斜杠路径。
    /// Python 找入口、Ruby 找 Sinatra 用的都是这一口。
    fn source_where<F>(&self, dir: &Path, extension: &str, accept: F) -> Option<String>
    where
        F: Fn(&str) -> bool,
    {
        let walker = WalkDir::new(dir)
            .follow_links(false)
            .max_depth(12)
            .into_iter()
            .filter_entry(|entry| entry.depth() == 0 || !is_skipped(entry));
        for entry in walker
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file())
            .filter(|entry| {
                entry.path().extension().and_then(|ext| ext.to_str()) == Some(extension)
            })
            .take(MAX_SOURCE_FILES)
        {
            let path = entry.path();
            if path
                .metadata()
                .map(|meta| meta.len() > MAX_FILE_BYTES)
                .unwrap_or(true)
            {
                continue;
            }
            let Ok(text) = fs::read_to_string(path) else {
                continue;
            };
            if accept(&text) {
                return Some(rel_path(&self.root, path).replace('\\', "/"));
            }
        }
        None
    }

    /// 整棵树没有构建文件、根上却有常用名字的脚本：`run.sh` / `start.sh` / `dev.sh` 当运行入口。
    /// `build.sh` 是构建步骤不是起跑，其余 `.sh` 按库文件看，都不摆进下拉。
    fn bare_shell(&mut self) {
        let program = if cfg!(windows) { "bash" } else { "sh" };
        for name in ["run.sh", "start.sh", "dev.sh"] {
            if !scan::has_file(&self.root, name) {
                continue;
            }
            self.push(RunConfiguration {
                id: format!("sh:{name}"),
                name: name.to_string(),
                kind: RunKind::Shell,
                command: format!("{program} {name}"),
                working_dir: String::new(),
                env: Vec::new(),
                generated: true,
                pinned: false,
                unavailable: program_missing(program),
                helper: None,
                markers: Vec::new(),
            });
            return;
        }
    }
}

/// 分组顺序：Spring 与常用体系在前，长尾体系按字母排，手写命令行永远垫底。
/// 前端 `RUN_KIND_ORDER` 必须是这一份的同序，两处不一致会把新族排到最前面去。
fn kind_rank(kind: RunKind) -> u8 {
    match kind {
        RunKind::Spring => 0,
        RunKind::Npm => 1,
        RunKind::Java => 2,
        RunKind::Maven => 3,
        RunKind::Gradle => 4,
        RunKind::Go => 5,
        RunKind::Wails => 6,
        RunKind::Rust => 7,
        RunKind::Python => 8,
        RunKind::DotNet => 9,
        RunKind::Clojure => 10,
        RunKind::Cpp => 11,
        RunKind::Dart => 12,
        RunKind::Deno => 13,
        RunKind::Elixir => 14,
        RunKind::Haskell => 15,
        RunKind::Julia => 16,
        RunKind::Lua => 17,
        RunKind::Php => 18,
        RunKind::Ruby => 19,
        RunKind::Scala => 20,
        RunKind::Swift => 21,
        RunKind::Zig => 22,
        RunKind::Shell => 23,
    }
}

/// 扫一个工程目录，列出所有能跑的东西。
#[tauri::command]
pub async fn run_detect(root: String) -> Result<RunDetectOutcome, String> {
    block(move || run_detect_impl(root)).await
}

fn run_detect_impl(root: String) -> Result<RunDetectOutcome, String> {
    let base = PathBuf::from(&root);
    if !base.is_dir() {
        return Err(err("NO_DIR", root));
    }
    let tools = tools_cached();
    let mut detector = Detector {
        root: base.clone(),
        configs: Vec::new(),
        problems: Vec::new(),
        owned: Vec::new(),
        wails: Vec::new(),
        java: tools.java,
        java_feature: tools.java_feature,
    };
    for dir in sub_dirs(&base) {
        // Go 先问：认出 Wails 模块之后，它下面那份前端 package.json 就不该再当运行入口。
        // 遍历是自上而下的，父目录一定先于子目录处理完。
        detector.golang(&dir);
        detector.rust(&dir);
        detector.python(&dir);
        detector.dotnet(&dir);
        detector.php(&dir);
        detector.ruby(&dir);
        detector.dart(&dir);
        detector.scala(&dir);
        detector.elixir(&dir);
        detector.zig(&dir);
        detector.deno(&dir);
        detector.clojure(&dir);
        detector.haskell(&dir);
        detector.julia(&dir);
        detector.swift(&dir);
        detector.npm(&dir);
        detector.maven(&dir);
        detector.gradle(&dir);
        // Makefile 与裸 `main.lua` 要看「这一层已经被别的构建文件认领没有」，所以排在最后问。
        detector.native(&dir);
        detector.lua(&dir);
    }
    if detector.owned.is_empty() {
        detector.bare_java();
        detector.bare_python();
        detector.bare_shell();
    }
    // 只比到体系这一层，组内保持识别顺序：一份 `package.json` 的脚本是连着 push 进来的，
    // 次序就是它在文件里写的次序。以前在同体系里再按脚本名比一次，两个子项目的 `dev` 会被
    // 凑到一起，同一份 `package.json` 的条目反倒被拆散；名字序也不是文件里的书写顺序。
    // 体系内按运行目录分块（不比大小写，工程根那个空串排最前），这样一眼看得出来是哪几个
    // 子项目；块内仍是识别顺序，因为 `sort_by` 是稳定排序。
    detector.configs.sort_by(|a, b| {
        kind_rank(a.kind)
            .cmp(&kind_rank(b.kind))
            .then_with(|| a.working_dir.to_lowercase().cmp(&b.working_dir.to_lowercase()))
    });
    Ok(RunDetectOutcome {
        configs: detector.configs,
        problems: detector.problems,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 拿本机真实示例工程走一遍完整探测链。
    /// `FORGE_DEMO=<工程根> cargo test --lib -- --ignored run::detect`。
    #[test]
    #[ignore = "requires FORGE_DEMO pointing at the local demo project"]
    fn smoke_against_forge_demo() {
        let demo = std::env::var_os("FORGE_DEMO").expect("FORGE_DEMO 未设置");
        let outcome = run_detect_impl(demo.to_string_lossy().into_owned()).expect("探测失败");
        assert!(outcome.problems.is_empty(), "problems: {:?}", outcome.problems);
        assert!(
            outcome.configs.iter().any(|c| c.command.contains("start")),
            "应当认出 npm scripts：{:?}",
            outcome.configs.iter().map(|c| &c.command).collect::<Vec<_>>()
        );
    }

    fn temp_project(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("forge-run-detect-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, rel: &str, text: &str) {
        let path = dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, text).unwrap();
    }

    fn names(outcome: &RunDetectOutcome) -> Vec<String> {
        outcome.configs.iter().map(|c| c.name.clone()).collect()
    }

    fn find(outcome: &RunDetectOutcome, name: &str) -> RunConfiguration {
        outcome
            .configs
            .iter()
            .find(|config| config.name == name)
            .unwrap_or_else(|| panic!("没有 {name} 这一条：{:?}", names(outcome)))
            .clone()
    }

    #[test]
    fn npm_scripts_include_nested_packages() {
        let dir = temp_project("npm");
        write(&dir, "package.json", r#"{"scripts":{"dev":"vite"}}"#);
        write(&dir, "web/package.json", r#"{"scripts":{"build":"vite build"}}"#);
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(find(&outcome, "dev").working_dir, "");
        // 脚本正文不能直接丢给 cmd：`vite` 装在 node_modules/.bin，裸 shell 找不到它。
        assert_eq!(find(&outcome, "dev").command, "npm run dev");
        let build = find(&outcome, "build");
        assert_eq!(build.working_dir, "web");
        assert_eq!(build.kind, RunKind::Npm);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// 一份 `package.json` 的脚本要连着排，次序就是文件里的书写顺序。
    ///
    /// 排序只比到体系这一层就够，再按脚本名比一次会把两个子项目的 `dev` 凑到一起、
    /// 把同一份 `package.json` 的条目拆散。两个包里的脚本都故意不按字母序写：按名字排
    /// 会得到 api / build / dev / zebra，那正是这条要拦住的。
    #[test]
    fn scripts_of_one_package_json_stay_adjacent_in_file_order() {
        let dir = temp_project("npm-order");
        write(
            &dir,
            "mobile/package.json",
            r#"{"scripts":{"dev":"vite","zebra":"echo z","api":"node ."}}"#,
        );
        write(
            &dir,
            "desktop/package.json",
            r#"{"scripts":{"build":"vite build","dev":"vite"}}"#,
        );
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        let order = outcome
            .configs
            .iter()
            .map(|config| (config.working_dir.as_str(), config.name.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            order,
            [
                ("desktop", "build"),
                ("desktop", "dev"),
                ("mobile", "dev"),
                ("mobile", "zebra"),
                ("mobile", "api"),
            ]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn npm_client_follows_the_lockfile() {
        let dir = temp_project("client");
        write(&dir, "pnpm-lock.yaml", "");
        write(&dir, "web/package.json", r#"{"scripts":{"dev":"vite"}}"#);
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        // 锁文件在根上，子包里没有：仍按根上的包管理器喊。
        assert_eq!(find(&outcome, "dev").command, "pnpm run dev");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn broken_package_json_is_reported_not_hidden() {
        let dir = temp_project("badjson");
        write(&dir, "package.json", "{oops");
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        assert!(outcome.configs.is_empty());
        assert!(
            outcome.problems.iter().any(|p| p.starts_with("BAD_JSON")),
            "读不成 JSON 要报出来：{:?}",
            outcome.problems
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn safe_component_passes_names_and_rejects_shell_payloads() {
        // 放行：普通名、npm 的 scope 包名、go 的相对包路径、带下划线/连字符/点/冒号的名字、Unicode。
        assert!(safe_component("dev"));
        assert!(safe_component("@scope/pkg"));
        assert!(safe_component("cmd/api"));
        assert!(safe_component("my-pkg_2.0"));
        assert!(safe_component("tauri:dev"));
        assert!(safe_component("check:ts"));
        assert!(safe_component("构建脚本"));
        // 拒：空串、点目录、往上跳的路径段、空白、shell 元字符、命令替换、引号与反引号。
        assert!(!safe_component(""));
        assert!(!safe_component("."));
        assert!(!safe_component(".."));
        assert!(!safe_component("a/../b"));
        assert!(!safe_component("a & calc"));
        assert!(!safe_component("a|b"));
        assert!(!safe_component("a;b"));
        assert!(!safe_component("$(calc)"));
        assert!(!safe_component("`calc`"));
        assert!(!safe_component("a\"b"));
        assert!(!safe_component("a\nb"));
        // 前导 `-` 是参数注入面：拼成 `npm run -o` 会被 npm 当自家旗标解析。
        assert!(!safe_component("-o"));
        assert!(!safe_component("--prefix=x"));
    }

    #[test]
    fn hostile_npm_script_names_are_skipped() {
        // 反向验证：脚本键来自 package.json 的任意 JSON 键，带 shell 元字符的一条都不生成。
        let dir = temp_project("npmhostile");
        write(
            &dir,
            "package.json",
            r#"{"scripts":{"dev":"vite","a & calc":"evil","$(pwn)":"evil"}}"#,
        );
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        assert!(outcome.configs.iter().any(|c| c.name == "dev"));
        assert_eq!(
            outcome.configs.len(),
            1,
            "不合法的脚本键一条都不给：{:?}",
            names(&outcome)
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn windows_store_python_stubs_are_filtered() {
        assert!(is_windows_store_stub(
            r"C:\Users\me\AppData\Local\Microsoft\WindowsApps\python.exe"
        ));
        assert!(!is_windows_store_stub(r"C:\Python312\python.exe"));
        assert!(!is_windows_store_stub("/usr/bin/python3"));
    }

    #[test]
    fn spring_maven_module_offers_one_boot_entry() {
        let dir = temp_project("maven");
        write(
            &dir,
            "pom.xml",
            "<project><artifactId>demo-parent</artifactId><packaging>pom</packaging></project>",
        );
        write(
            &dir,
            "admin/pom.xml",
            r#"<project><parent><artifactId>demo-parent</artifactId></parent><artifactId>demo-admin</artifactId>
<build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId>
<configuration><mainClass>com.acme.GytApplication</mainClass></configuration></plugin></plugins></build></project>"#,
        );
        write(
            &dir,
            "admin/src/main/java/com/acme/GytApplication.java",
            "package com.acme;\n@SpringBootApplication\npublic class GytApplication { public static void main(String[] args) {} }",
        );
        write(
            &dir,
            "admin/src/main/java/com/acme/Tool.java",
            "package com.acme;\npublic class Tool { public static void main(String[] args) {} }",
        );
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        let boot = find(&outcome, "demo-admin [spring-boot:run]");
        assert_eq!(boot.kind, RunKind::Spring);
        assert_eq!(
            outcome.configs.iter().filter(|c| c.kind == RunKind::Spring).count(),
            1
        );
        assert!(boot.command.ends_with("spring-boot:run"), "{}", boot.command);
        // 模块的 pom 不在工具那一层，得用 `-f` 指过去；工具本身是本机 PATH 上那个占位。
        assert!(boot.command.contains("-f "), "{}", boot.command);
        assert_eq!(boot.working_dir, "");
        // 带注解的启动类不再单列，普通主类仍然给一条。
        assert!(
            !outcome.configs.iter().any(|c| c.name == "GytApplication.main()"),
            "启动类重复了：{:?}",
            names(&outcome)
        );
        assert!(outcome.configs.iter().any(|c| c.name == "Tool.main()"));
        // 根部聚合模块提供全工程的构建入口
        let parent = find(&outcome, "demo-parent [clean package]");
        assert_eq!(parent.kind, RunKind::Maven);
        assert!(!parent.command.contains("-f"), "根工程在当前目录打包不需要 -f：{}", parent.command);
        assert!(parent.command.ends_with("clean package"), "{}", parent.command);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn wrapper_is_preferred_and_paths_stay_relative() {
        let dir = temp_project("wrapper");
        write(
            &dir,
            "pom.xml",
            "<project><artifactId>one</artifactId><packaging>pom</packaging></project>",
        );
        write(&dir, "mvnw.cmd", "@echo off");
        write(&dir, "mvnw", "#!/bin/sh");
        write(
            &dir,
            "web/pom.xml",
            "<project><artifactId>web-one</artifactId><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>",
        );
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        let boot = find(
            &outcome,
            &format!("web-one [spring-boot:run]"),
        );
        // 从根上那份 wrapper 喊，指模块用相对 pom 路径。
        let expect = if cfg!(windows) { "mvnw.cmd" } else { "./mvnw" };
        assert!(boot.command.starts_with(expect), "{}", boot.command);
        assert!(boot.command.contains("-f "), "{}", boot.command);
        assert!(
            !boot.command.contains("forge-run-detect-wrapper"),
            "绝对路径不该烤进命令：{}",
            boot.command
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn starter_dependency_alone_is_not_an_app() {
        let dir = temp_project("library");
        write(
            &dir,
            "pom.xml",
            "<project><artifactId>lib-one</artifactId><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>",
        );
        write(
            &dir,
            "src/main/java/com/acme/Lib.java",
            "package com.acme;\n@SpringBootApplication\npublic class Lib { public static void main(String[] a) {} }",
        );
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        // 没绑 spring-boot-maven-plugin 就喊不出 spring-boot:run，这个模块只该有构建与 exec:java。
        assert!(
            !outcome.configs.iter().any(|c| c.kind == RunKind::Spring),
            "{:?}",
            names(&outcome)
        );
        assert!(
            outcome.configs.iter().any(|c| c.name == "Lib.main()"),
            "注解类在没绑插件的模块里仍要留入口：{:?}",
            names(&outcome)
        );
        assert!(
            outcome.configs.iter().any(|c| c.name == "lib-one [clean package]"),
            "{:?}",
            names(&outcome)
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn gradle_application_plugin_offers_run() {
        let dir = temp_project("gradle");
        write(&dir, "settings.gradle.kts", "rootProject.name = \"Demo\"");
        write(&dir, "build.gradle.kts", "plugins { application java }");
        write(
            &dir,
            "src/main/java/com/acme/App.java",
            "package com.acme;\npublic class App { public static void main(String[] a) {} }",
        );
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        let run = find(&outcome, &format!("{} [run]", dir_name(&dir)));
        assert_eq!(run.kind, RunKind::Gradle);
        let app = find(&outcome, "App.main()");
        // 模块里的主类一律借构建工具：单文件启动器看不见依赖，跑不了带库的代码。
        assert!(app.command.contains("--init-script"), "{}", app.command);
        assert!(app.command.contains("com.acme.App.main()"), "{}", app.command);
        let helper = app.helper.expect("JavaExec 需要一份 init 脚本");
        assert!(helper.content.contains("def taskName = \"com.acme.App.main()\""));
        assert!(helper.content.contains("exec.mainClass = mainClassToRun"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn android_module_gets_nothing() {
        let dir = temp_project("android");
        write(&dir, "settings.gradle", "include ':app'");
        write(&dir, "app/build.gradle", "plugins { id 'com.android.application' }");
        write(
            &dir,
            "app/src/main/java/com/acme/Main.java",
            "package com.acme;\npublic class Main { public static void main(String[] a) {} }",
        );
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        assert!(
            outcome.configs.is_empty(),
            "Android 不该出现在 JVM 启动项里：{:?}",
            names(&outcome)
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn bare_source_uses_the_single_file_launcher() {
        let dir = temp_project("bare");
        write(
            &dir,
            "src/main/java/Hello.java",
            "public class Hello { public static void main(String[] a) {} }",
        );
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        let hello = find(&outcome, "Hello.main()");
        assert!(hello.command.starts_with("${java}"), "{}", hello.command);
        assert!(hello.command.contains("Hello.java"), "{}", hello.command);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn main_method_shapes_are_recognised() {
        assert!(has_main_method("public static void main(String[] a) {}"));
        assert!(has_main_method("    static void main() {}"));
        assert!(has_main_method("fun main() {}"));
        assert!(has_main_method("fun main(args: Array<String>) {}"));
        assert!(!has_main_method("void helper() {}"));
        assert!(!has_main_method("class A { }"));
    }

    #[test]
    fn feature_versions_parse() {
        assert_eq!(parse_feature("17.0.2"), 17);
        assert_eq!(parse_feature("1.8"), 8);
        assert_eq!(parse_feature("21"), 21);
        assert_eq!(parse_feature("21-ea"), 21);
        assert_eq!(parse_feature("21+35"), 21);
        assert_eq!(parse_feature(r#"openjdk version "1.8.0_202" 2019-01-15"#), 8);
        assert_eq!(parse_feature(r#"openjdk version "17.0.2" 2022-01-18 LTS"#), 17);
        assert_eq!(parse_feature(r#"openjdk version "21-ea" 2023-09-19"#), 21);
        assert_eq!(parse_feature("none"), 0);
        assert_eq!(parse_feature(""), 0);
    }

    #[test]
    fn quoting_helpers() {
        assert_eq!(quote("no-space"), "no-space");
        assert_eq!(
            quote("D:\\Program Files\\mvn.cmd"),
            "\"D:\\Program Files\\mvn.cmd\""
        );
        assert_eq!(quote(""), "");
        assert_eq!(quote("${mvn}"), "${mvn}");
        assert_eq!(groovy_text("a\\b\"c"), "a\\\\b\\\"c");
        assert_eq!(line(&["mvn", "", "spring-boot:run"]), "mvn spring-boot:run");
    }

    #[test]
    fn identifier_and_short_name() {
        assert!(is_identifier("GytApplication"));
        assert!(!is_identifier("1Bad"));
        assert_eq!(short_name("com.acme.Tool"), "Tool");
        assert_eq!(short_name("Tool"), "Tool");
    }

    #[test]
    fn go_module_offers_each_main_package() {
        let dir = temp_project("go");
        write(
            &dir,
            "go.mod",
            "module github.com/acme/shop\n\ngo 1.23.0\n\nrequire github.com/gin-gonic/gin v1.10.0\n",
        );
        write(
            &dir,
            "cmd/api/main.go",
            "package main\n\nfunc main() {\n\tr.Run(\":8080\")\n}\n",
        );
        write(
            &dir,
            "cmd/worker/main.go",
            "package main\n\nfunc main() {}\n",
        );
        // 库包与测试文件不算可执行目标。
        write(&dir, "internal/handler/order.go", "package handler\n\nfunc List() {}\n");
        write(&dir, "cmd/api/main_test.go", "package main\n\nfunc main() {}\n");
        // 嵌在另一份 go.mod 下面的那个目录归它自己管。
        write(&dir, "examples/simple/go.mod", "module github.com/acme/shop/examples/simple\n\ngo 1.23.0\n");
        write(&dir, "examples/simple/main.go", "package main\n\nfunc main() {}\n");
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        let api = find(&outcome, "cmd/api [go run]");
        assert_eq!(api.kind, RunKind::Go);
        assert_eq!(api.command, "go run ./cmd/api");
        assert_eq!(api.working_dir, "");
        assert!(
            outcome
                .configs
                .iter()
                .any(|c| c.name == "cmd/worker [go run]" && c.command == "go run ./cmd/worker"),
            "{:?}",
            names(&outcome)
        );
        // 嵌着的那份 go.mod 由它自己那层认领，父模块不重复报它。
        let simple = find(&outcome, "simple [go run]");
        assert_eq!(simple.command, "go run .");
        assert_eq!(simple.working_dir, "examples\\simple");
        assert_eq!(
            outcome.configs.iter().filter(|c| c.kind == RunKind::Go).count(),
            3,
            "父模块两个包 + 子模块一个包：{:?}",
            names(&outcome)
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn go_module_root_package_uses_module_name() {
        let dir = temp_project("goroot");
        write(&dir, "go.mod", "module github.com/acme/hello\n\ngo 1.23.0\n");
        write(&dir, "main.go", "package main\n\nfunc main() {}\n");
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        let hello = find(&outcome, "hello [go run]");
        assert_eq!(hello.command, "go run .");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn wails_module_is_one_entry_not_its_frontend_scripts() {
        for version in ["v2", "v3"] {
            let dir = temp_project(&format!("wails{version}"));
            write(
                &dir,
                "go.mod",
                &format!("module github.com/acme/desktop\n\ngo 1.23.0\n\nrequire github.com/wailsapp/wails/{version} v2.9.1\n"),
            );
            write(
                &dir,
                "wails.json",
                r#"{"name":"desktop","frontend:build":"npm run build","frontend:dev:watcher":"npm run dev"}"#,
            );
            write(
                &dir,
                "main.go",
                "package main\n\nfunc main() {\n\tapp.Run()\n}\n",
            );
            write(
                &dir,
                "frontend/package.json",
                r#"{"scripts":{"dev":"vite","build":"vite build"}}"#,
            );
            let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
            assert_eq!(outcome.configs.len(), 1, "{version}: {:?}", names(&outcome));
            let dev = &outcome.configs[0];
            assert_eq!(dev.kind, RunKind::Wails);
            assert_eq!(dev.name, "desktop [wails dev]");
            assert_eq!(dev.command, "wails dev");
            fs::remove_dir_all(&dir).unwrap();
        }
    }

    #[test]
    fn cargo_package_offers_its_bins() {
        let dir = temp_project("cargo");
        write(
            &dir,
            "Cargo.toml",
            "[workspace]\nmembers = [\"crates/server\", \"crates/engine\"]\n",
        );
        write(
            &dir,
            "crates/server/Cargo.toml",
            "[package]\nname = \"server\"\n\n[[bin]]\nname = \"server\"\npath = \"src/main.rs\"\n\n[[bin]]\nname = \"migrate\"\npath = \"src/migrate.rs\"\n",
        );
        write(&dir, "crates/server/src/main.rs", "fn main() {}\n");
        write(&dir, "crates/server/src/migrate.rs", "fn main() {}\n");
        // 只有库的成员 crate 没有可跑的东西。
        write(
            &dir,
            "crates/engine/Cargo.toml",
            "[package]\nname = \"engine\"\n\n[lib]\nname = \"engine\"\npath = \"src/lib.rs\"\n",
        );
        write(&dir, "crates/engine/src/lib.rs", "pub fn run() {}\n");
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        let server = find(&outcome, "server [cargo run]");
        assert_eq!(server.kind, RunKind::Rust);
        assert_eq!(server.command, "cargo run -p server");
        assert_eq!(server.working_dir, "crates\\server");
        let migrate = find(&outcome, "migrate [cargo run]");
        assert_eq!(migrate.command, "cargo run -p server --bin migrate");
        assert_eq!(
            outcome.configs.iter().filter(|c| c.kind == RunKind::Rust).count(),
            2,
            "库 crate 不该出条目：{:?}",
            names(&outcome)
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cargo_default_binary_comes_from_src_main() {
        let dir = temp_project("cargoone");
        write(&dir, "Cargo.toml", "[package]\nname = \"probe\"\n\n[dependencies]\nanyhow = \"1\"\n");
        write(&dir, "src/main.rs", "fn main() {}\n");
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(find(&outcome, "probe [cargo run]").command, "cargo run -p probe");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn python_frameworks_win_over_the_plain_script() {
        let dir = temp_project("pydjango");
        write(&dir, "requirements.txt", "Django==5.1\npsycopg[binary]==3.2.1\n");
        write(&dir, "manage.py", "#!/usr/bin/env python\ndef main():\n    pass\n");
        write(&dir, "main.py", "if __name__ == \"__main__\":\n    pass\n");
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        let run = find(&outcome, &format!("{} [runserver]", dir_name(&dir)));
        assert_eq!(run.kind, RunKind::Python);
        assert_eq!(run.command, format!("{} manage.py runserver", python_program()));
        assert_eq!(
            outcome.configs.iter().filter(|c| c.kind == RunKind::Python).count(),
            1,
            "一个 Python 工程只给一条：{:?}",
            names(&outcome)
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn python_fastapi_entry_points_at_the_module_holding_the_app() {
        let dir = temp_project("pyapi");
        write(
            &dir,
            "pyproject.toml",
            "[project]\nname = \"api\"\ndependencies = [\"fastapi>=0.115\", \"uvicorn>=0.30\"]\n",
        );
        write(&dir, "api/main.py", "app = FastAPI()\n");
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            find(&outcome, &format!("{} [fastapi dev]", dir_name(&dir))).command,
            "fastapi dev api/main.py"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn python_package_with_main_module_runs_with_dash_m() {
        let dir = temp_project("pypkg");
        write(
            &dir,
            "pyproject.toml",
            "[project]\nname = \"kit\"\ndependencies = [\"pandas>=2.2\"]\n",
        );
        write(&dir, "src/datakit/__main__.py", "def main():\n    pass\n");
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            find(&outcome, &format!("{} [-m datakit]", dir_name(&dir))).command,
            format!("{} -m datakit", python_program())
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn python_streamlit_entry_survives_the_st_alias() {
        let dir = temp_project("pystream");
        write(
            &dir,
            "pyproject.toml",
            "[project]\nname = \"dash\"\ndependencies = [\"streamlit>=1.37\"]\n",
        );
        // 脚本里只出现 `st.`，没有库名：按库名找入口会找不着。
        write(&dir, "dash_app/app.py", "st.set_page_config(page_title='dash')\nst.plotly_chart(fig)\n");
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            find(&outcome, &format!("{} [streamlit run]", dir_name(&dir))).command,
            "streamlit run dash_app/app.py"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn bare_python_script_without_manifest_still_runs() {
        let dir = temp_project("pybare");
        write(&dir, "main.py", "if __name__ == \"__main__\":\n    print(1)\n");
        write(&dir, "utils.py", "def helper():\n    return 1\n");
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        let run = find(&outcome, "main.py");
        assert_eq!(run.kind, RunKind::Python);
        assert_eq!(run.command, format!("{} main.py", python_program()));
        assert_eq!(run.working_dir, "");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn dotnet_executable_projects_run_but_libraries_do_not() {
        let dir = temp_project("net");
        write(
            &dir,
            "Console.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>",
        );
        write(&dir, "Program.cs", "Console.WriteLine(1);\n");
        write(
            &dir,
            "Core/Core.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>",
        );
        write(
            &dir,
            "Web/Web.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk.Web\"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>",
        );
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        let console = find(&outcome, "Console [dotnet run]");
        assert_eq!(console.kind, RunKind::DotNet);
        assert_eq!(console.command, "dotnet run --project Console.csproj");
        assert_eq!(
            find(&outcome, "Web [dotnet run]").command,
            "dotnet run --project Web/Web.csproj"
        );
        assert!(
            !outcome.configs.iter().any(|c| c.name.contains("Core")),
            "类库不该有运行条目：{:?}",
            names(&outcome)
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn toml_reader_handles_tables_arrays_and_quotes() {
        let tables = toml_tables(
            "# 注释\n[package]\nname = \"probe\"\n\n[[bin]]\nname = \"a\"\npath = \"src/a.rs\"\n\n[[bin]]\nname = \"b\"\n\n[dependencies]\nanyhow = { version = \"1\" }\n",
        );
        assert_eq!(toml_value(&tables, "package", "name").as_deref(), Some("probe"));
        assert_eq!(toml_values(&tables, "bin", "name"), vec!["a", "b"]);
        assert_eq!(
            toml_value(&tables, "bin", "path").as_deref(),
            Some("src/a.rs")
        );
        assert_eq!(toml_value(&tables, "nope", "name"), None);
    }

    #[test]
    fn go_and_python_source_shapes() {
        assert!(is_go_main_package("package main\n\nfunc main() {}"));
        assert!(!is_go_main_package("package handler\n\nfunc main() {}"));
        assert!(!is_go_main_package("package main\n\n// func main() 注释里说的不算"));
        assert!(is_python_entry("if __name__ == \"__main__\":\n    run()\n"));
        assert!(is_python_entry("  if __name__ == '__main__':\n      pass\n"));
        assert!(!is_python_entry("name = \"__main__\"\n"));
    }

    #[test]
    fn php_prefers_artisan_then_composer_scripts() {
        let laravel = temp_project("phplaravel");
        write(
            &laravel,
            "composer.json",
            r#"{"require":{"laravel/framework":"^11.20"},"scripts":{"dev":"php artisan serve"}}"#,
        );
        write(&laravel, "artisan", "#!/usr/bin/env php\n");
        let outcome = run_detect_impl(laravel.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            find(&outcome, &format!("{} [artisan serve]", dir_name(&laravel))).command,
            "php artisan serve"
        );
        fs::remove_dir_all(&laravel).unwrap();

        let slim = temp_project("phpslim");
        write(
            &slim,
            "composer.json",
            r#"{"require":{"slim/slim":"^4.13"},"scripts":{"start":"php -S localhost:8080 -t public"}}"#,
        );
        let outcome = run_detect_impl(slim.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            find(&outcome, &format!("{} [start]", dir_name(&slim))).command,
            "composer start"
        );
        fs::remove_dir_all(&slim).unwrap();

        // 没脚本也没 artisan，但有 public/index.php：退到内置服务器。
        let plain = temp_project("phpplain");
        write(&plain, "composer.json", r#"{"require":{"psr/http-message":"^2.0"}}"#);
        write(&plain, "public/index.php", "<?php\n");
        let outcome = run_detect_impl(plain.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            find(&outcome, &format!("{} [serve]", dir_name(&plain))).command,
            "php -S localhost:8000 -t public"
        );
        fs::remove_dir_all(&plain).unwrap();
    }

    #[test]
    fn ruby_rails_binstub_beats_bundle_then_rackup() {
        let with_binstub = temp_project("railsbin");
        write(&with_binstub, "Gemfile", "source \"https://rubygems.org\"\ngem \"rails\", \"~> 7.2.0\"\n");
        write(&with_binstub, "bin/rails", "#!/usr/bin/env ruby\n");
        let outcome = run_detect_impl(with_binstub.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            find(&outcome, &format!("{} [rails server]", dir_name(&with_binstub))).command,
            "bin/rails server"
        );
        fs::remove_dir_all(&with_binstub).unwrap();

        let sinatra = temp_project("sinatra");
        write(&sinatra, "Gemfile", "gem \"sinatra\", \"~> 4.0\"\ngem \"rackup\"\n");
        write(&sinatra, "config.ru", "run App\n");
        let outcome = run_detect_impl(sinatra.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            find(&outcome, &format!("{} [rackup]", dir_name(&sinatra))).command,
            "bundle exec rackup"
        );
        fs::remove_dir_all(&sinatra).unwrap();
    }

    #[test]
    fn dart_splits_flutter_from_plain_dart() {
        let flutter = temp_project("flutter");
        write(
            &flutter,
            "pubspec.yaml",
            "name: mobile\ndependencies:\n  flutter:\n    sdk: flutter\n  dio: ^5.5.0\n",
        );
        let outcome = run_detect_impl(flutter.to_string_lossy().into_owned()).unwrap();
        let run = find(&outcome, &format!("{} [flutter run]", dir_name(&flutter)));
        assert_eq!(run.kind, RunKind::Dart);
        assert_eq!(run.command, "flutter run");
        fs::remove_dir_all(&flutter).unwrap();

        let cli = temp_project("dartcli");
        write(&cli, "pubspec.yaml", "name: dartkit\ndependencies:\n  args: ^2.5.0\n");
        let outcome = run_detect_impl(cli.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            find(&outcome, &format!("{} [dart run]", dir_name(&cli))).command,
            "dart run"
        );
        fs::remove_dir_all(&cli).unwrap();
    }

    #[test]
    fn scala_and_elixir_get_one_entry_each() {
        let sbt = temp_project("sbt");
        write(&sbt, "build.sbt", "ThisBuild / scalaVersion := \"3.4.3\"\nname := \"stream\"\n");
        write(&sbt, "project/build.properties", "sbt.version=1.10.1\n");
        let outcome = run_detect_impl(sbt.to_string_lossy().into_owned()).unwrap();
        let run = find(&outcome, &format!("{} [sbt run]", dir_name(&sbt)));
        assert_eq!(run.kind, RunKind::Scala);
        fs::remove_dir_all(&sbt).unwrap();

        let phoenix = temp_project("phx");
        write(&phoenix, "mix.exs", "defp deps do\n  [{:phoenix, \"~> 1.7.14\"}, {:bandit, \"~> 1.5\"}]\nend\n");
        let outcome = run_detect_impl(phoenix.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            find(&outcome, &format!("{} [phx.server]", dir_name(&phoenix))).command,
            "mix phx.server"
        );
        fs::remove_dir_all(&phoenix).unwrap();

        let kit = temp_project("mixkit");
        write(&kit, "mix.exs", "defp deps do\n  [{:jason, \"~> 1.4\"}]\nend\n");
        let outcome = run_detect_impl(kit.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            find(&outcome, &format!("{} [run]", dir_name(&kit))).command,
            "mix run --no-halt"
        );
        fs::remove_dir_all(&kit).unwrap();
    }

    #[test]
    fn cmake_configures_before_building_and_makefile_yields_to_other_build_files() {
        let cmake = temp_project("cmake");
        write(
            &cmake,
            "CMakeLists.txt",
            "cmake_minimum_required(VERSION 3.28)\nproject(app LANGUAGES CXX)\nadd_executable(app src/main.cpp)\n",
        );
        let outcome = run_detect_impl(cmake.to_string_lossy().into_owned()).unwrap();
        let run = find(&outcome, &format!("{} [cmake build]", dir_name(&cmake)));
        assert_eq!(run.kind, RunKind::Cpp);
        // 没配过的工程光 `cmake --build build` 会直接失败，这一条把配置那步带上。
        assert_eq!(run.command, "cmake -S . -B build && cmake --build build");
        fs::remove_dir_all(&cmake).unwrap();

        let make = temp_project("makeonly");
        write(&make, "Makefile", "CC=gcc\nall: build/tool\n\t$(CC) $^ -o $@\n");
        let outcome = run_detect_impl(make.to_string_lossy().into_owned()).unwrap();
        assert_eq!(find(&outcome, &format!("{} [make]", dir_name(&make))).command, "make");
        fs::remove_dir_all(&make).unwrap();

        // 反向验证：同一层已经有 package.json，那份 Makefile 只是别的体系的包装，不再插条目。
        let mixed = temp_project("makemixed");
        write(&mixed, "Makefile", "run:\n\tgo run ./cmd/api\n");
        write(&mixed, "package.json", r#"{"scripts":{"dev":"vite"}}"#);
        let outcome = run_detect_impl(mixed.to_string_lossy().into_owned()).unwrap();
        assert!(
            !outcome.configs.iter().any(|c| c.kind == RunKind::Cpp),
            "Makefile 盖不住别的项目：{:?}",
            names(&outcome)
        );
        assert!(outcome.configs.iter().any(|c| c.name == "dev"));
        fs::remove_dir_all(&mixed).unwrap();
    }

    #[test]
    fn zig_deno_clojure_haskell_julia_lua_swift_markers() {
        let zig = temp_project("zig");
        write(&zig, "build.zig", "const run_step = b.step(\"run\", \"Run the app\");\n");
        let outcome = run_detect_impl(zig.to_string_lossy().into_owned()).unwrap();
        assert_eq!(find(&outcome, &format!("{} [run]", dir_name(&zig))).command, "zig build run");
        fs::remove_dir_all(&zig).unwrap();

        let deno = temp_project("denopkg");
        write(&deno, "deno.json", "{ \"tasks\": { \"dev\": \"deno run --watch main.ts\", \"test\": \"deno test\" } }");
        let outcome = run_detect_impl(deno.to_string_lossy().into_owned()).unwrap();
        let dev = find(&outcome, "dev");
        assert_eq!(dev.kind, RunKind::Deno);
        assert_eq!(dev.command, "deno task dev");
        assert!(outcome.configs.iter().any(|c| c.name == "test"));
        fs::remove_dir_all(&deno).unwrap();

        let deps = temp_project("depsedn");
        write(&deps, "deps.edn", "{:deps {org.clojure/clojure {:mvn/version \"1.11.2\"}}\n :aliases {:dev {:main-opts []}}}\n");
        let outcome = run_detect_impl(deps.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            find(&outcome, &format!("{} [clojure -M:dev]", dir_name(&deps))).command,
            "clojure -M:dev"
        );
        fs::remove_dir_all(&deps).unwrap();

        let lein = temp_project("lein");
        write(&lein, "project.clj", "(defn app \"0.1.0\" [:dependencies [[ring \"1.12.1\"]]])\n");
        let outcome = run_detect_impl(lein.to_string_lossy().into_owned()).unwrap();
        assert_eq!(find(&outcome, &format!("{} [lein run]", dir_name(&lein))).command, "lein run");
        fs::remove_dir_all(&lein).unwrap();

        let stack = temp_project("stackhs");
        write(&stack, "stack.yaml", "resolver: lts-22.32\n");
        write(&stack, "package.yaml", "name: server\nexecutables:\n  server:\n    main: Main.hs\n");
        let outcome = run_detect_impl(stack.to_string_lossy().into_owned()).unwrap();
        assert_eq!(find(&outcome, &format!("{} [stack run]", dir_name(&stack))).command, "stack run");
        fs::remove_dir_all(&stack).unwrap();

        // 只有 .cabal 的才走 cabal run。
        let cabal = temp_project("cabalhs");
        write(&cabal, "server.cabal", "executable server\n  main-is: Main.hs\n");
        let outcome = run_detect_impl(cabal.to_string_lossy().into_owned()).unwrap();
        assert_eq!(find(&outcome, &format!("{} [cabal run]", dir_name(&cabal))).command, "cabal run");
        fs::remove_dir_all(&cabal).unwrap();

        let julia = temp_project("julia");
        write(&julia, "Project.toml", "name = \"Analysis\"\n[deps]\nPlots = \"91a5bcdd\"\n");
        write(&julia, "src/main.jl", "function main()\n    plot(df)\nend\n");
        let outcome = run_detect_impl(julia.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            find(&outcome, &format!("{} [src/main.jl]", dir_name(&julia))).command,
            "julia --project=. src/main.jl"
        );
        fs::remove_dir_all(&julia).unwrap();

        // 反向验证：只有 Project.toml（一个库）不给条目。
        let lib = temp_project("julialib");
        write(&lib, "Project.toml", "name = \"Lib\"\n[deps]\n");
        let outcome = run_detect_impl(lib.to_string_lossy().into_owned()).unwrap();
        assert!(outcome.configs.is_empty(), "{:?}", names(&outcome));
        fs::remove_dir_all(&lib).unwrap();

        let love = temp_project("lovey");
        write(&love, "main.lua", "function love.draw() end\n");
        write(&love, "conf.lua", "function love.conf(t) end\n");
        let outcome = run_detect_impl(love.to_string_lossy().into_owned()).unwrap();
        assert_eq!(find(&outcome, &format!("{} [love]", dir_name(&love))).kind, RunKind::Lua);
        fs::remove_dir_all(&love).unwrap();

        let swift = temp_project("swiftpm");
        write(
            &swift,
            "Package.swift",
            "let package = Package(name: \"Weather\", targets: [\n  .executableTarget(name: \"weather\", dependencies: []),\n  .executableTarget(name: \"worker\", dependencies: [])\n])\n",
        );
        let outcome = run_detect_impl(swift.to_string_lossy().into_owned()).unwrap();
        let weather = find(&outcome, "weather [swift run]");
        assert_eq!(weather.kind, RunKind::Swift);
        assert_eq!(weather.command, "swift run weather");
        assert_eq!(find(&outcome, "worker [swift run]").command, "swift run worker");
        fs::remove_dir_all(&swift).unwrap();
    }

    #[test]
    fn bare_shell_scripts_only_when_nothing_else_was_found() {
        let dir = temp_project("shells");
        write(&dir, "run.sh", "#!/usr/bin/env bash\nset -euo pipefail\ndist/app \"$@\"\n");
        write(&dir, "deploy.sh", "#!/usr/bin/env bash\nrsync -a dist/ host:/srv\n");
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        let run = find(&outcome, "run.sh");
        assert_eq!(run.kind, RunKind::Shell);
        assert!(run.command.ends_with(" run.sh"), "{}", run.command);
        assert!(
            !outcome.configs.iter().any(|c| c.name == "deploy.sh"),
            "部署脚本不是运行入口：{:?}",
            names(&outcome)
        );
        fs::remove_dir_all(&dir).unwrap();

        // 反向验证：同一层有构建文件时不摆脚本。
        let mixed = temp_project("shellmixed");
        write(&mixed, "run.sh", "#!/usr/bin/env bash\nnpm run dev\n");
        write(&mixed, "package.json", r#"{"scripts":{"dev":"vite"}}"#);
        let outcome = run_detect_impl(mixed.to_string_lossy().into_owned()).unwrap();
        assert!(
            !outcome.configs.iter().any(|c| c.name == "run.sh"),
            "{:?}",
            names(&outcome)
        );
        fs::remove_dir_all(&mixed).unwrap();
    }

    /// 断言里比这个短的写法：一条配置的落点收成 `(文件, 行号)` 列表。
    fn marks(config: &RunConfiguration) -> Vec<(String, u32)> {
        config
            .markers
            .iter()
            .map(|at| (at.file.clone(), at.line))
            .collect()
    }

    #[test]
    fn npm_script_markers_point_at_their_own_line() {
        let dir = temp_project("marknpm");
        write(
            &dir,
            "package.json",
            r#"{
  "name": "demo",
  "scripts": {
    "dev": "vite",
    "prebuild": "node -e \"const o = {a: 1}\"",
    "build": "vite build"
  },
  "dependencies": { "vite": "^5.0.0" }
}"#,
        );
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        // 脚本正文里那个 `{a: 1}` 不能带歪层数，`dependencies` 里的键也不能当成脚本。
        assert_eq!(marks(&find(&outcome, "dev")), vec![("package.json".into(), 4)]);
        assert_eq!(
            marks(&find(&outcome, "prebuild")),
            vec![("package.json".into(), 5)]
        );
        assert_eq!(
            marks(&find(&outcome, "build")),
            vec![("package.json".into(), 6)]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn java_main_class_marks_both_the_class_and_the_main_line() {
        let dir = temp_project("markjava");
        write(
            &dir,
            "GytApplication.java",
            "package com.acme;\n\n@SpringBootApplication\npublic class GytApplication {\n    static final String P = \"prod\";\n\n    public static void main(String[] args) {\n        System.out.println(P);\n    }\n}\n",
        );
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        let picked = find(&outcome, "GytApplication.main()");
        // 类声明那一行和 main 那一行各给一个落点，两处都能点。
        assert_eq!(
            marks(&picked),
            vec![
                ("GytApplication.java".into(), 4),
                ("GytApplication.java".into(), 7)
            ]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn spring_entry_inherits_the_annotated_class_lines() {
        let dir = temp_project("markspring");
        write(
            &dir,
            "pom.xml",
            r#"<project><artifactId>demo</artifactId>
<build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>"#,
        );
        write(
            &dir,
            "src/main/java/com/acme/GytApplication.java",
            "package com.acme;\n\n@SpringBootApplication\npublic class GytApplication {\n    public static void main(String[] args) {}\n}\n",
        );
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        let boot = find(&outcome, "demo [spring-boot:run]");
        assert_eq!(
            marks(&boot),
            vec![
                ("src/main/java/com/acme/GytApplication.java".into(), 4),
                ("src/main/java/com/acme/GytApplication.java".into(), 5)
            ]
        );
        // 那条盖住了主类自己那一条：同一行不该再出第二个图标。
        assert!(
            !outcome.configs.iter().any(|c| c.name == "GytApplication.main()"),
            "{:?}",
            names(&outcome)
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn go_rust_and_python_markers_point_at_the_entry_line() {
        let go = temp_project("markgo");
        write(&go, "go.mod", "module demo\n\ngo 1.22\n");
        write(&go, "main.go", "package main\n\nfunc main() {}\n");
        let outcome = run_detect_impl(go.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            marks(&find(&outcome, "demo [go run]")),
            vec![("main.go".into(), 3)]
        );
        fs::remove_dir_all(&go).unwrap();

        let rs = temp_project("markrs");
        write(&rs, "Cargo.toml", "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n");
        write(&rs, "src/main.rs", "mod util;\n\nfn main() {}\n");
        let outcome = run_detect_impl(rs.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            marks(&find(&outcome, "demo [cargo run]")),
            vec![("src/main.rs".into(), 3)]
        );
        fs::remove_dir_all(&rs).unwrap();

        let py = temp_project("markpy");
        write(&py, "requirements.txt", "rich\n");
        write(
            &py,
            "app.py",
            "import rich\n\n\ndef run() {}\n\nif __name__ == \"__main__\":\n    run()\n",
        );
        let outcome = run_detect_impl(py.to_string_lossy().into_owned()).unwrap();
        let guard = outcome
            .configs
            .iter()
            .find(|c| c.kind == RunKind::Python)
            .unwrap_or_else(|| panic!("没有 python 条目：{:?}", names(&outcome)));
        assert_eq!(marks(guard), vec![("app.py".into(), 6)]);
        fs::remove_dir_all(&py).unwrap();
    }

    #[test]
    fn a_script_without_an_entry_guard_gets_no_marker() {
        // 反向验证：只有一句构造调用、没有入口守卫的脚本不该凭空长出图标。
        let dir = temp_project("marknoguard");
        write(&dir, "requirements.txt", "fastapi\n");
        write(&dir, "app.py", "from fastapi import FastAPI\n\napp = FastAPI()\n");
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        let picked = outcome
            .configs
            .iter()
            .find(|c| c.kind == RunKind::Python)
            .expect("fastapi 那条要认出来");
        assert!(marks(picked).is_empty(), "{:?}", marks(picked));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn build_goal_entries_get_no_marker() {
        // 反向验证：`clean package` 这种构建目标没有「声明它的那一行」，不该给落点。
        let dir = temp_project("markgoal");
        write(&dir, "pom.xml", "<project><artifactId>lib</artifactId></project>");
        let outcome = run_detect_impl(dir.to_string_lossy().into_owned()).unwrap();
        let picked = find(&outcome, "lib [clean package]");
        assert!(marks(&picked).is_empty(), "{:?}", marks(&picked));
        fs::remove_dir_all(&dir).unwrap();
    }
}
