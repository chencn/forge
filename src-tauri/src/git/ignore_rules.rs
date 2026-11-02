//! 进程内 Git 忽略规则匹配。
//!
//! 文件树列目录原本每层 spawn 一次 `git check-ignore --stdin -z`。Windows 上
//! 一次子进程实测约 104ms，链式预取最多 24 层，展开一个深目录要 2.5s 以上，
//! 叠加杀软扫描就是用户看到的 7-8s；而真正的 read_dir + 逐项 stat 只要 <1ms。
//! 这里把判定搬进进程：读取目录祖先链上的 `.gitignore`、`.git/info/exclude`
//! 与 `core.excludesFile`，交给 ripgrep 同源的 `ignore` crate 做匹配。
//!
//! 语义与 `git check-ignore` 对齐的几点：
//! - 从仓库根到目标目录逐级匹配，深层 `.gitignore` 优先；
//! - 同一文件内由 ignore crate 保证「最后一条匹配的规则胜出」，`!` 取反同样成立；
//! - 仓库根之外（外部库、普通文件树）没有仓库就不做忽略判定，返回空集。

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::Match;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// 一条作用在某个目录上的忽略规则集。
struct RuleSet {
    /// 规则文件所在目录；待匹配路径要相对它取。
    base: PathBuf,
    matcher: Arc<Gitignore>,
}

/// 单层目录的规则集缓存项。
struct CachedLevel {
    /// 规则文件的指纹。文件被增删改都会换指纹，缓存于是自然失效，
    /// 不需要额外的失效通知，也就不会出现「改了 .gitignore 但树还按老规则灰着」。
    fingerprint: u64,
    /// 该层没有规则文件时是 None（空 matcher 的 matched 永远返回 None）。
    matcher: Option<Arc<Gitignore>>,
}

/// 目录 → 该层的规则集。
///
/// 列一个目录要沿祖先链逐层匹配，而每一层都要读一遍自己的 `.gitignore` 再编译 glob。
/// 展开一棵 20 层的树等于上千次冗余文件读，层级越深重复越多（O(depth²)）。
fn level_cache() -> &'static Mutex<HashMap<PathBuf, CachedLevel>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedLevel>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 缓存条目上限：换过几个工作区之后，旧仓库的层级条目就没有意义了，满了直接清空。
const LEVEL_CACHE_CAP: usize = 8192;

/// 规则文件的指纹：路径 + 长度 + 修改时间。文件不存在也算一种状态（创建它必须换指纹）。
fn file_stamp(path: &Path) -> u64 {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    match std::fs::metadata(path) {
        Ok(meta) => {
            meta.len().hash(&mut hasher);
            match meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            {
                Some(since) => since.as_nanos().hash(&mut hasher),
                None => 0u8.hash(&mut hasher),
            }
        }
        Err(_) => 1u8.hash(&mut hasher),
    }
    hasher.finish()
}

fn level_fingerprint(level: &Path, shared: &[PathBuf]) -> u64 {
    let mut hasher = DefaultHasher::new();
    file_stamp(&level.join(".gitignore")).hash(&mut hasher);
    for file in shared {
        file_stamp(file).hash(&mut hasher);
    }
    hasher.finish()
}

/// 构建一层的规则集。`shared` 只在仓库根层非空（`info/exclude` 与全局 excludesFile）。
fn build_level(level: &Path, shared: &[PathBuf]) -> Option<Arc<Gitignore>> {
    let mut builder = GitignoreBuilder::new(level);
    // Windows 文件系统大小写不敏感，Git 侧 core.ignoreCase 默认也为真。
    // 该设置只会失败于 builder 已冻结，此处尚无规则，忽略返回值即可。
    let _ = builder.case_insensitive(cfg!(windows));

    let mut loaded = false;
    for file in shared {
        loaded |= add_rule_file(&mut builder, file);
    }
    let local = level.join(".gitignore");
    if local.is_file() {
        loaded |= add_rule_file(&mut builder, &local);
    }
    if !loaded {
        return None;
    }
    builder.build().ok().map(Arc::new)
}

/// 批量判断 `dir` 的直接子项是否命中 Git 忽略规则。
///
/// `entries` 是 `(名字, 是否目录)`：目录规则（`build/`）必须以目录身份匹配，
/// 只凭名字判断会把同名文件误判。非仓库目录与空目录都按空集处理。
pub(crate) fn ignored_names_in_dir(dir: &Path, entries: &[(String, bool)]) -> HashSet<String> {
    let mut ignored = HashSet::new();
    if entries.is_empty() {
        return ignored;
    }
    let Some(repo_root) = find_repo_root(dir) else {
        return ignored;
    };
    let chain = build_chain(&repo_root, dir);
    if chain.is_empty() {
        return ignored;
    }
    for (name, is_dir) in entries {
        if is_ignored(&chain, &dir.join(name.as_str()), *is_dir) {
            ignored.insert(name.clone());
        }
    }
    ignored
}

/// 向上找仓库根：`.git` 既可能是目录（普通仓库）也可能是文件（worktree / 子模块）。
fn find_repo_root(dir: &Path) -> Option<PathBuf> {
    let mut current = dir;
    loop {
        if current.join(".git").exists() {
            return Some(current.to_path_buf());
        }
        current = current.parent()?;
    }
}

/// 从仓库根到目标目录逐级构建规则集，顺序由浅到深。
fn build_chain(repo_root: &Path, dir: &Path) -> Vec<RuleSet> {
    let Ok(inside) = dir.strip_prefix(repo_root) else {
        return Vec::new();
    };
    let shared_files = shared_rule_files_cached(repo_root);

    // repo_root 本身 + inside 的每一级。
    let mut levels = Vec::with_capacity(8);
    let mut current = repo_root.to_path_buf();
    levels.push(current.clone());
    for component in inside.components() {
        current.push(component);
        levels.push(current.clone());
    }

    let mut chain = Vec::with_capacity(levels.len());
    for level in levels {
        let shared: &[PathBuf] = if level.as_path() == repo_root { shared_files.as_slice() } else { &[] };
        let fingerprint = level_fingerprint(&level, shared);
        // 先在锁内查一次；未命中就到锁外构建（构建要读文件，不能占着锁不放）。
        let hit = match level_cache().lock() {
            Ok(guard) => guard
                .get(&level)
                .filter(|item| item.fingerprint == fingerprint)
                .map(|item| item.matcher.clone()),
            Err(_) => None,
        };
        let matcher = match hit {
            Some(matcher) => matcher,
            None => {
                let matcher = build_level(&level, shared);
                if let Ok(mut guard) = level_cache().lock() {
                    if guard.len() >= LEVEL_CACHE_CAP {
                        guard.clear();
                    }
                    guard.insert(level.clone(), CachedLevel { fingerprint, matcher: matcher.clone() });
                }
                matcher
            }
        };
        // 没有规则文件的层级不进链：空 matcher 的 matched 永远返回 None。
        if let Some(matcher) = matcher {
            chain.push(RuleSet { base: level, matcher });
        }
    }
    chain
}

/// 把规则文件逐行喂给 builder，规则相对 builder 的 root 解析。
///
/// 不用 `GitignoreBuilder::add`：`info/exclude` 与全局 excludesFile 位于仓库根
/// 之外，`add` 会按文件所在目录锚定规则，语义与 Git 不符。
fn add_rule_file(builder: &mut GitignoreBuilder, file: &Path) -> bool {
    let Ok(contents) = std::fs::read_to_string(file) else {
        return false;
    };
    let mut added = false;
    for line in contents.lines() {
        // 空行与注释由 add_line 自己跳过；单条非法 glob 不拖垮整份文件。
        if builder.add_line(None, line).is_ok() {
            added = true;
        }
    }
    added
}

/// 从深到浅取第一条匹配：深层 `.gitignore` 优先于浅层。
fn is_ignored(chain: &[RuleSet], path: &Path, is_dir: bool) -> bool {
    for rules in chain.iter().rev() {
        let Ok(relative) = path.strip_prefix(&rules.base) else {
            continue;
        };
        match rules.matcher.matched(relative, is_dir) {
            Match::Ignore(_) => return true,
            Match::Whitelist(_) => return false,
            Match::None => {}
        }
    }
    false
}

/// `shared_rule_files` 的结果按仓库根缓存。
///
/// 它每次都要读一遍 `.git/config` 解析 `core.excludesFile`，而列一个目录就会调一次，
/// 深目录展开时这是白读几十遍同一份配置。指纹只取仓库级配置与 `info/exclude`——
/// 全局 excludesFile 本身已是进程内只读一次（见 `global_excludes_file`），不会再变。
fn shared_rule_files_cached(repo_root: &Path) -> Arc<Vec<PathBuf>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (u64, Arc<Vec<PathBuf>>)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut hasher = DefaultHasher::new();
    file_stamp(&repo_root.join(".git").join("config")).hash(&mut hasher);
    file_stamp(&repo_root.join(".git").join("info").join("exclude")).hash(&mut hasher);
    let fingerprint = hasher.finish();
    if let Ok(guard) = cache.lock() {
        if let Some((stamp, files)) = guard.get(repo_root) {
            if *stamp == fingerprint {
                return files.clone();
            }
        }
    }
    let files = Arc::new(shared_rule_files(repo_root));
    if let Ok(mut guard) = cache.lock() {
        if guard.len() >= LEVEL_CACHE_CAP {
            guard.clear();
        }
        guard.insert(repo_root.to_path_buf(), (fingerprint, files.clone()));
    }
    files
}

/// 与仓库根同级生效的忽略规则文件：`.git/info/exclude`、仓库级与全局
/// `core.excludesFile`。
fn shared_rule_files(repo_root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let info_exclude = repo_root.join(".git").join("info").join("exclude");
    if info_exclude.is_file() {
        files.push(info_exclude);
    }
    let repo_config = repo_root.join(".git").join("config");
    if let Some(path) = excludes_file_in(&repo_config, Some(repo_root)) {
        if path.is_file() {
            files.push(path);
        }
    }
    if let Some(path) = global_excludes_file() {
        if path.is_file() {
            files.push(path);
        }
    }
    files
}

/// 全局 excludesFile。进程内只读一次：运行期改全局配置的频率远低于刷新目录。
fn global_excludes_file() -> Option<PathBuf> {
    static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            // GIT_CONFIG_GLOBAL 指到 null 设备表示禁用全局配置。
            if let Some(path) = std::env::var_os("GIT_CONFIG_GLOBAL") {
                let path = PathBuf::from(path);
                if is_null_device(&path) {
                    return None;
                }
                return excludes_file_in(&path, None);
            }
            let home = home_dir()?;
            let mut candidates = vec![home.join(".gitconfig")];
            match std::env::var_os("XDG_CONFIG_HOME") {
                Some(xdg) if !xdg.is_empty() => {
                    candidates.push(PathBuf::from(xdg).join("git").join("config"));
                }
                _ => candidates.push(home.join(".config").join("git").join("config")),
            }
            candidates
                .iter()
                .find_map(|config| excludes_file_in(config, None))
        })
        .clone()
}

fn is_null_device(path: &Path) -> bool {
    path == Path::new("/dev/null")
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("nul"))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

/// 从 git config 里取 `core.excludesFile`。只做「按段落找键」这一层，
/// 不引入完整的 config 解析：这里只关心一个键。
fn excludes_file_in(config: &Path, relative_to: Option<&Path>) -> Option<PathBuf> {
    let text = std::fs::read_to_string(config).ok()?;
    let mut in_core = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(section) = line.strip_prefix('[') {
            let name = section.trim_end_matches(']').trim();
            // `[core "x"]` 是另一个 section，只认裸 `[core]`。
            in_core = name.eq_ignore_ascii_case("core");
            continue;
        }
        if !in_core {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("excludesfile") {
            continue;
        }
        let value = value.trim().trim_matches('"');
        if value.is_empty() {
            return None;
        }
        return Some(resolve_config_path(value, relative_to));
    }
    None
}

fn resolve_config_path(value: &str, relative_to: Option<&Path>) -> PathBuf {
    if let Some(rest) = value.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    let path = PathBuf::from(value);
    if path.is_absolute() {
        return path;
    }
    // Git 对 config 里的相对路径按当前工作目录解析；仓库级配置以仓库根近似。
    match relative_to {
        Some(base) => base.join(path),
        None => path,
    }
}
