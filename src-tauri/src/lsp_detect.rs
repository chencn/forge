//! 技术栈根解析：语言服务器的 workspace 根不等于工程目录根。
//!
//! 典型反例是 `Cargo.toml` 在子目录、根目录只有 `package.json` 的工程：拿根目录当 `rootUri`，
//! rust-analyzer 认不到 Cargo workspace，退成 detached 单文件模式，跨文件跳转失效、
//! 类型诊断缺失、`dead_code` 误报。这一层把真正的根找出来，monorepo 里每个子根各起一条会话。
//! 参照 `docs/features/lsp-language-servers/README.md` 的「技术栈根解析」。

use crate::offload::block_value;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 结果缓存时长。目录树变动后要等它过期，或者让界面重开一次工程。
const CACHE_TTL: Duration = Duration::from_secs(60);

/// 「这个工程里没找到根标志」只信这几秒：用户随时会补一个 `go.mod` 或 `Cargo.toml` 进来。
const MISS_TTL: Duration = Duration::from_secs(5);
/// 缓存条目上限。键含文件所在目录，多工程 + monorepo 时条目会一路涨。
const CACHE_LIMIT: usize = 512;
/// 向下扫的最大深度。再深就不是「工程根」而是别人的依赖了。
const MAX_DEPTH: usize = 2;
/// 一眼就不可能是工程根的目录名，向下扫时整棵剪掉。
const SKIP_DIRS: [&str; 9] = [
    "node_modules", ".git", "target", "dist", "build", "out", "vendor", "__pycache__", ".venv",
];

/// 命中的一条：真正的根与是靠哪个标志文件认出来的。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RootHit {
    pub root: String,
    pub marker: String,
}

type Cache = Mutex<HashMap<String, (Instant, Option<RootHit>)>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| Cache::new(HashMap::new()))
}

/// `*.csproj` 这类后缀通配按结尾匹配，其余按整个文件名（大小写不敏感）。
fn marker_matches(name: &str, marker: &str) -> bool {
    if marker.is_empty() {
        return false;
    }
    if let Some(suffix) = marker.strip_prefix('*') {
        return name.to_ascii_lowercase().ends_with(&suffix.to_ascii_lowercase());
    }
    name.eq_ignore_ascii_case(marker)
}

/// 这个目录里有没有该语言的标志文件。
fn hit_in(dir: &Path, markers: &[String]) -> Option<RootHit> {
    let exact = markers.iter().filter(|marker| !marker.starts_with('*'));
    for marker in exact {
        if dir.join(marker).is_file() {
            return Some(RootHit {
                root: dir.to_string_lossy().into_owned(),
                marker: marker.clone(),
            });
        }
    }
    let wildcards: Vec<&String> = markers
        .iter()
        .filter(|marker| marker.starts_with('*'))
        .collect();
    if wildcards.is_empty() {
        return None;
    }
    // 通配要列目录才能判，读不动就当没命中。
    let Ok(entries) = std::fs::read_dir(dir) else {
        return None;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !entry.path().is_file() {
            continue;
        }
        if let Some(marker) = wildcards.iter().find(|marker| marker_matches(&name, marker)) {
            return Some(RootHit {
                root: dir.to_string_lossy().into_owned(),
                marker: (*marker).clone(),
            });
        }
    }
    None
}

/// 从一个目录向上找，到 `stop`（含）为止。
fn search_up(start: &Path, stop: &Path, markers: &[String]) -> Option<RootHit> {
    let mut current = Some(start.to_path_buf());
    while let Some(dir) = current {
        if let Some(hit) = hit_in(&dir, markers) {
            return Some(hit);
        }
        // 越出工程范围就停：上层的 Cargo.toml 不是这个工程的。
        if dir == stop || !dir.starts_with(stop) {
            return None;
        }
        current = dir.parent().map(|parent| parent.to_path_buf());
    }
    None
}

/// 从根向下扫，一层层来，取最浅的那个命中。
fn search_down(root: &Path, markers: &[String]) -> Option<RootHit> {
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    queue.push_back((root.to_path_buf(), 0));
    seen.insert(root.to_path_buf());
    while let Some((dir, depth)) = queue.pop_front() {
        if let Some(hit) = hit_in(&dir, markers) {
            return Some(hit);
        }
        if depth >= MAX_DEPTH {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            if seen.insert(path.clone()) {
                queue.push_back((path, depth + 1));
            }
        }
    }
    None
}

/// 找出这条文件（或这个工程）真正的语言服务器根。
///
/// 有文件先按文件所在目录向上找，找不到再从工程根向下扫；没有文件直接向下扫。
/// 两处都没命中返回 `None`，调用方据此不启进程。`markers` 是空的（用户自填的 server 没标标志）
/// 就不做约束，工程根原样返回。
pub fn resolve(markers: &[String], workspace_root: &Path, file: Option<&Path>) -> Option<RootHit> {
    if markers.is_empty() {
        return Some(RootHit {
            root: workspace_root.to_string_lossy().into_owned(),
            marker: String::new(),
        });
    }
    if let Some(file) = file {
        let start = file.parent().unwrap_or(file);
        if let Some(hit) = search_up(start, workspace_root, markers) {
            return Some(hit);
        }
    } else {
        // 工程根本身先判一次，省掉一趟队列。
        if let Some(hit) = hit_in(workspace_root, markers) {
            return Some(hit);
        }
    }
    search_down(workspace_root, markers)
}

/// 带缓存的那层：同样的（server, 工程根, 文件）60 秒内只扫一遍盘。
fn cached(markers: &[String], workspace_root: &Path, file: Option<&Path>) -> Option<RootHit> {
    let key = format!(
        "{}|{}|{}",
        markers.join(","),
        workspace_root.display(),
        file.map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default()
    );
    let hit = {
        let guard = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .get(&key)
            .and_then(|(at, cached)| {
                // 没找到根的那次只信几秒：用户随时会在工程里补一个 `go.mod`/`Cargo.toml`，
                // 之后一分钟仍报「没有根」等于没认出来。找到的那种才值得压到 60 秒。
                let window = if cached.is_some() { CACHE_TTL } else { MISS_TTL };
                (at.elapsed() < window).then(|| cached.clone())
            })
    };
    if let Some(hit) = hit {
        return hit;
    }
    // 扫盘放在锁外：握着一把全局锁逐层 stat，并发的根解析就全排在这一条队上，
    // 打开一批文件时前端是同时问过来的。
    let found = resolve(markers, workspace_root, file);
    if let Ok(mut guard) = cache().lock() {
        // 键里带着「文件所在目录」：monorepo 里散落几百个目录、再加上多个常驻工程，
        // 这张表会一路涨。过期的条目已经没人读（TTL 到了就重扫），先清过期的，
        // 还超就整张重开——最坏只是多扫几趟盘。
        if guard.len() >= CACHE_LIMIT {
            let now = Instant::now();
            guard.retain(|_, (at, cached)| {
                let window = if cached.is_some() { CACHE_TTL } else { MISS_TTL };
                now.duration_since(*at) < window
            });
            if guard.len() >= CACHE_LIMIT {
                guard.clear();
            }
        }
        guard.insert(key, (Instant::now(), found.clone()));
    }
    found
}

/// 解析某个 server 在这个工程里的根。文件可给可不给：给的是「这份文件归哪个根」，
/// 不给的是「这个工程里有没有这门语言」。没有标志文件或目录不存在返回 null。
#[tauri::command]
pub async fn lsp_resolve_root(
    app: tauri::AppHandle,
    server: String,
    workspace_root: String,
    file: Option<String>,
) -> Option<RootHit> {
    block_value(
        move || {
            let root = Path::new(workspace_root.trim());
            if !root.is_dir() {
                return None;
            }
            let config = crate::lsp_config::load(&app);
            let entry = config.servers.get(server.trim())?;
            let hit_file = file
                .map(|path| path.trim().to_string())
                .filter(|path| !path.is_empty())
                .map(PathBuf::from);
            cached(&entry.root_markers, root, hit_file.as_deref())
        },
        || None,
    )
    .await
}
#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(name: &str) -> PathBuf {
        let nanos = std::time::UNIX_EPOCH
            .elapsed()
            .map(|since| since.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("forge-lsp-root-{name}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn markers(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    fn touch(dir: &Path, name: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(name), "{}").unwrap();
    }

    /// 精确名与后缀通配都能认。
    #[test]
    fn matches_exact_and_wildcard() {
        assert!(marker_matches("Cargo.toml", "Cargo.toml"));
        assert!(marker_matches("cargo.toml", "Cargo.toml"));
        assert!(marker_matches("App.csproj", "*.csproj"));
        assert!(!marker_matches("App.cs", "*.csproj"));
        assert!(!marker_matches("Cargo.toml", ""));
    }

    /// 文件在子目录里时，向上找到那个子目录而不是工程根。
    #[test]
    fn finds_nearest_stack_root_upwards() {
        let dir = temp_project("up");
        touch(&dir.join("native"), "Cargo.toml");
        let file = dir.join("native").join("src").join("main.rs");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "fn main() {}").unwrap();

        let hit = resolve(&markers(&["Cargo.toml"]), &dir, Some(&file)).unwrap();
        assert_eq!(Path::new(&hit.root), dir.join("native"));
        assert_eq!(hit.marker, "Cargo.toml");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 向上越出工程范围就停：外面那层的 Cargo.toml 不算。
    #[test]
    fn stops_at_workspace_boundary() {
        let dir = temp_project("boundary");
        let src = dir.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let file = src.join("a.rs");
        std::fs::write(&file, "").unwrap();
        assert!(
            resolve(&markers(&["Cargo.toml"]), &src, Some(&file)).is_none(),
            "工程根之外不该命中"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 没有文件时向下扫，取最浅的那一层，并且跳过依赖目录。
    #[test]
    fn scans_down_and_skips_dependency_dirs() {
        let dir = temp_project("down");
        touch(&dir.join("packages").join("web"), "tsconfig.json");
        touch(&dir.join("node_modules").join("lib"), "tsconfig.json");

        let hit = resolve(&markers(&["tsconfig.json"]), &dir, None).unwrap();
        assert_eq!(Path::new(&hit.root), dir.join("packages").join("web"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 后缀通配向下也能认。
    #[test]
    fn wildcard_matches_on_down_scan() {
        let dir = temp_project("wild");
        touch(&dir, "Program.csproj");
        let hit = resolve(&markers(&["*.csproj"]), &dir, None).unwrap();
        assert_eq!(Path::new(&hit.root), dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 没标标志的自填 server 不做约束，工程根原样返回。
    #[test]
    fn empty_markers_pass_root_through() {
        let dir = temp_project("none");
        let hit = resolve(&markers(&[]), &dir, None).unwrap();
        assert_eq!(Path::new(&hit.root), dir);
        assert_eq!(hit.marker, "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 整棵树都没有标志文件时返回 None，调用方据此不启进程。
    #[test]
    fn no_marker_is_no_root() {
        let dir = temp_project("miss");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        assert!(resolve(&markers(&["go.mod", "go.work"]), &dir, None).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

