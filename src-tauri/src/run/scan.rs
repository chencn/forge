//! 目录清单的共享缓存：一条构建标志文件名单，`run_detect` 与 `dep_sync_probe` 都用它。
//!
//! 两条命令是同一次磁盘变动一起叫起来的（各自 600ms 防抖，落在同一个时间窗里），
//! 扫的又是同一棵树。没有这份缓存的话，每一层目录列两遍、每个标志文件各 stat 一遍：
//! 一个几百个目录的工程，一趟就是上万次系统调用。
//!
//! 失效只有两条路，缺一条都会看到旧工程：
//! - 监听报来的新增 / 删除：那才是改了目录内容，立刻作废对应那一层；
//! - TTL：没被监听的根（另一台机器同步、应用没开那个文件夹）兜底，到点重新列。
//! 改文件内容不作废：名单里只有名字，内容变了名字没变。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use std::fs;

/// 一条清单在缓存里能活多久。监听会即时作废该作废的，这个值只兜「没被监听到」的那部分。
const LISTING_TTL: Duration = Duration::from_secs(2);
/// 缓存最多记多少层目录。大仓把上限撑破时整表清空重来，比无限涨着占内存划算。
const MAX_CACHED_DIRS: usize = 8192;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 按名字问得到的构建标志文件。列一次目录只挑这些进名单，其余名字不占内存。
/// 名单外的名字照旧逐个 stat：将来加新探测不会因为忘了登记而认不出工程。
const MARK_NAMES: &[&str] = &[
    "app.py",
    "artisan",
    "build.gradle",
    "build.gradle.kts",
    "build.sbt",
    "build.zig",
    "bun.lock",
    "bun.lockb",
    "CMakeLists.txt",
    "Cargo.toml",
    "composer.json",
    "conf.lua",
    "config.ru",
    "deno.json",
    "deno.jsonc",
    "deps.edn",
    "dev.sh",
    "Gemfile",
    "go.mod",
    "gradlew",
    "gradlew.bat",
    "main.jl",
    "main.lua",
    "main.py",
    "manage.py",
    "Makefile",
    "makefile",
    "mix.exs",
    "mvnw",
    "mvnw.cmd",
    "package.json",
    "package-lock.json",
    "package.yaml",
    "Package.swift",
    "Pipfile",
    "Pipfile.lock",
    "pnpm-lock.yaml",
    "pom.xml",
    "poetry.lock",
    "project.clj",
    "Project.toml",
    "pubspec.yaml",
    "pyproject.toml",
    "requirements.txt",
    "run.py",
    "run.sh",
    "setup.cfg",
    "setup.py",
    "stack.yaml",
    "start.sh",
    "uv.lock",
    "wails.json",
    "yarn.lock",
];

/// 只认后缀的那几类：Haskell 的 `.cabal`、.NET 的项目文件，名字没法预先列全。
const MARK_EXTS: &[&str] = &["cabal", "csproj", "fsproj"];

/// 一层目录列一次的结果。识别每个目录都要问二十来个标志文件在不在，一个一个 stat
/// 就是二十来次系统调用；列一次目录，剩下的全换成查表。
#[derive(Default)]
struct Marks {
    /// 这一层列成了。列不动（不是目录、没权限）时问话退回逐个 stat，
    /// 不能把「读不了」当成「这里一个构建文件都没有」——那会把整个工程看空。
    listed: bool,
    /// `MARK_NAMES` 里在这一层出现的那些名字，按文件系统给的原样存。
    names: Vec<String>,
    /// `MARK_EXTS` 那些后缀在这一层命中的文件名。
    typed: Vec<String>,
}

/// 两个名字是不是同一个文件：Windows 的路径不区分大小写，Unix 区分。
fn same_name(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// 这个名字带的是哪个认得的后缀。
fn mark_ext(name: &str) -> Option<&'static str> {
    let ext = Path::new(name).extension()?.to_str()?;
    MARK_EXTS.iter().find(|want| **want == ext).copied()
}

/// `name` 是不是名单里的构建标志文件。
fn is_mark_name(name: &str) -> bool {
    MARK_NAMES.iter().any(|want| same_name(want, name))
}

/// 列一层目录，只留标志文件那几个名字。
fn list_marks(dir: &Path) -> Marks {
    let Ok(entries) = fs::read_dir(dir) else {
        return Marks::default();
    };
    let mut marks = Marks {
        listed: true,
        names: Vec::new(),
        typed: Vec::new(),
    };
    for entry in entries.flatten() {
        // 符号链接指向的是不是文件得单独问；一次 stat 只花在这一类条目上，罕见。
        let is_file = match entry.file_type() {
            Ok(kind) if kind.is_file() => true,
            Ok(kind) if kind.is_symlink() => entry.path().is_file(),
            _ => false,
        };
        if !is_file {
            continue;
        }
        let Some(text) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if is_mark_name(&text) {
            marks.names.push(text);
        } else if mark_ext(&text).is_some() {
            marks.typed.push(text);
        }
    }
    marks
}

/// 缓存本体。`invalidated_at` 和名单放在一起锁，是为了拦住这一种竞态：
/// 识别正列某一层目录，列到一半监听报来说这层变了。那份列到一半的名单可能不含刚加进来的
/// `pom.xml`，写回缓存就把旧名单盖满整个 TTL。开始列的时刻早于最近一次作废就不入库。
struct Cache {
    entries: HashMap<PathBuf, (Instant, Marks)>,
    invalidated_at: Instant,
}

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Cache {
        entries: HashMap::new(),
        invalidated_at: Instant::now(),
    }))
}

/// 问到的那一条名单：过期和缺项都在这里重新列。
///
/// 锁只在取数那几行握着：`list_marks` 要遍历整个目录，攥着锁去列目录会把并发的另一条
/// 命令一起堵住。
fn marks(dir: &Path) -> Marks {
    if let Some((at, found)) = lock(cache()).entries.get(dir) {
        if at.elapsed() < LISTING_TTL {
            return clone_marks(found);
        }
    }
    let started = Instant::now();
    let fresh = list_marks(dir);
    let mut guard = lock(cache());
    if guard.invalidated_at > started {
        return fresh;
    }
    if guard.entries.len() >= MAX_CACHED_DIRS {
        guard.entries.clear();
    }
    guard
        .entries
        .insert(dir.to_path_buf(), (Instant::now(), clone_marks(&fresh)));
    fresh
}

fn clone_marks(found: &Marks) -> Marks {
    Marks {
        listed: found.listed,
        names: found.names.clone(),
        typed: found.typed.clone(),
    }
}

/// `dir` 这一层有没有名为 `name` 的文件。名单外的名字不查缓存，直接 stat。
pub(super) fn has_file(dir: &Path, name: &str) -> bool {
    if !is_mark_name(name) {
        return dir.join(name).is_file();
    }
    let listed = marks(dir);
    if !listed.listed {
        return dir.join(name).is_file();
    }
    listed.names.iter().any(|at| same_name(at, name))
}

/// 按给定顺序问第一个存在的标志文件，回那个名字。
pub(super) fn first_file<'a>(dir: &Path, names: &[&'a str]) -> Option<&'a str> {
    names.iter().copied().find(|name| has_file(dir, name))
}

/// 这一层里带那些后缀的标志文件名。
pub(super) fn typed_files(dir: &Path, exts: &[&str]) -> Vec<String> {
    let listed = marks(dir);
    listed
        .typed
        .iter()
        .filter(|name| mark_ext(name).is_some_and(|ext| exts.contains(&ext)))
        .cloned()
        .collect()
}

/// 往上找最近的那个自带这些文件的目录：构建工具 wrapper 就在那一层。
pub(super) fn nearest_ancestor_with(dir: &Path, root: &Path, names: &[&str]) -> Option<PathBuf> {
    let mut current = Some(dir.to_path_buf());
    while let Some(path) = current {
        if names.iter().any(|name| has_file(&path, name)) {
            return Some(path);
        }
        if path == root {
            return None;
        }
        current = path.parent().map(Path::to_path_buf);
    }
    None
}

/// 作废一批：监听线程报来新增 / 改名 / 删除时按改动路径的父目录逐条撤，比整棵扫一遍便宜。
pub(crate) fn invalidate_many(paths: &[PathBuf]) {
    let mut guard = lock(cache());
    guard.invalidated_at = Instant::now();
    for path in paths {
        if let Some(parent) = path.parent() {
            guard.entries.remove(parent);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::MAIN_SEPARATOR_STR;

    /// 这几条用例共用同一份进程级缓存，并行跑时别人作废会把自己刚插进去的条目搅掉，串行才稳。
    fn serialize() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        lock(LOCK.get_or_init(|| Mutex::new(())))
    }

    fn temp_project(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("forge-run-scan-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, rel: &str) -> PathBuf {
        let path = dir.join(rel.replace('/', MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, "x").unwrap();
        path
    }

    #[test]
    fn a_new_manifest_stays_invisible_until_the_watcher_invalidates_its_dir() {
        let _guard = serialize();
        let dir = temp_project("invalidate");
        invalidate_many(&[dir.join("seed")]);
        assert!(!has_file(&dir, "pom.xml"), "空的 Maven 工程本就该认不出来");

        write(&dir, "pom.xml");
        // 清单还在缓存里，这趟认不出刚加的文件——正是监听必须作废它的原因。
        assert!(!has_file(&dir, "pom.xml"), "没作废就该读到旧清单");

        invalidate_many(&[dir.join("pom.xml")]);
        assert!(has_file(&dir, "pom.xml"), "作废后立刻重列，新工程认得出来");
        assert_eq!(first_file(&dir, &["build.gradle", "pom.xml"]), Some("pom.xml"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dropping_a_file_clears_it_once_the_dir_is_invalidated() {
        let _guard = serialize();
        let dir = temp_project("remove");
        write(&dir, "Cargo.toml");
        invalidate_many(&[dir.join("seed")]);
        assert!(has_file(&dir, "Cargo.toml"));

        fs::remove_file(dir.join("Cargo.toml")).unwrap();
        assert!(has_file(&dir, "Cargo.toml"), "删除同样要靠作废才看得到");

        invalidate_many(&[dir.join("Cargo.toml")]);
        assert!(!has_file(&dir, "Cargo.toml"), "作废后不该再把删掉的工程认成 Rust");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn suffixed_marks_are_listed_and_unlisted_names_still_stat() {
        let _guard = serialize();
        let dir = temp_project("typed");
        write(&dir, "App.csproj");
        write(&dir, "Notes.md");
        invalidate_many(&[dir.join("seed")]);

        assert_eq!(typed_files(&dir, &["csproj"]), ["App.csproj".to_string()]);
        assert!(typed_files(&dir, &["fsproj"]).is_empty());
        // 名单外的名字照旧逐个 stat：将来加新探测不会因为忘了登记就认不出工程。
        assert!(has_file(&dir, "Notes.md"));
        assert!(!has_file(&dir, "Absent.md"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unlistable_dir_falls_back_to_stat_instead_of_reading_empty() {
        let _guard = serialize();
        let dir = temp_project("unlistable");
        let absent = dir.join("nope");
        assert!(!marks(&absent).listed, "读不了的目录不能标成列好了");
        // 「读不了」和「一个构建文件都没有」是两回事，前者得退回逐个 stat 问。
        assert!(!has_file(&absent, "pom.xml"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ancestor_walk_finds_the_wrapper_root_and_stops_there() {
        let _guard = serialize();
        let dir = temp_project("ancestor");
        let nested = dir.join("apps").join("desktop");
        fs::create_dir_all(&nested).unwrap();
        invalidate_many(&[dir.join("seed"), nested.join("seed")]);
        assert_eq!(nearest_ancestor_with(&nested, &dir, &["pnpm-lock.yaml"]), None);

        write(&dir, "pnpm-lock.yaml");
        invalidate_many(&[dir.join("pnpm-lock.yaml")]);
        assert_eq!(
            nearest_ancestor_with(&nested, &dir, &["pnpm-lock.yaml"]),
            Some(dir.clone()),
            "锁文件摆在仓库根时，子包的包管理器要从那儿认"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
