//! 环境文件（`http-client.env.json`、`http-client.private.env.json`）。
//!
//! `Result<T, String>`，错误统一走 [`crate::error::err`]。
//!
//! ```json
//! { "$shared": { "version": "v1" }, "dev": { "host": "localhost:8080" } }
//! ```
//!
//! 这边只负责「哪些环境、每个环境有哪些变量」，并把结果交给前端；`{{name}}` 的替换
//! 在前端 `src/lib/httpFile.ts` 里做，和文件变量、`{{name.response…}}` 依赖链、动态变量
//! 走同一条路径，避免两处各替换一半。变量合并顺序：private 环境 → public 环境 →
//! private `$shared` → public `$shared`（先到先得）。

use crate::error::err;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// 公开环境文件名（可入库）。
pub const PUBLIC_FILE: &str = "http-client.env.json";
/// 私有环境文件名（.gitignore 挡住，放密钥）。
pub const PRIVATE_FILE: &str = "http-client.private.env.json";
/// 请求文件私有环境的共享段键名（`$shared`）。
const SHARED: &str = "$shared";

type EnvMap = BTreeMap<String, BTreeMap<String, String>>;

/// 作用于某个请求文件的环境集合。
#[derive(Debug, Default, Clone)]
pub struct Environments {
    public: EnvMap,
    private: EnvMap,
}

/// 用来比较路径的分量。Windows 上盘符和目录名大小写不敏感，
/// `Path::starts_with` 却是按字节比的：工作区根是 `D:\Work`、文件却从 `d:\work\...`
/// 走进来时，会把「还在根里面」看成「已经走出根」，中间目录的环境文件就被跳过。
fn path_key(path: &Path) -> Vec<String> {
    path.components()
        .map(|component| {
            let text = component.as_os_str().to_string_lossy().into_owned();
            #[cfg(windows)]
            {
                text.to_ascii_lowercase()
            }
            #[cfg(not(windows))]
            {
                text
            }
        })
        .collect()
}

/// 目录等价比较（Windows 大小写不敏感、统一斜杠）。
fn same_dir(a: &Path, b: &Path) -> bool {
    path_key(a) == path_key(b)
}

/// 已经走到 `root`，或者这条目录并不在 `root` 下面（文件在工作区外）。
fn at_root_or_outside(dir: &Path, root: &Path) -> bool {
    let dir = path_key(dir);
    let root = path_key(root);
    if dir == root {
        return true;
    }
    dir.len() < root.len() || dir[..root.len()] != root[..]
}

/// 搜索环境文件的目录：请求文件所在目录及其祖先，直到（含）`root`；
/// 文件在 `root` 之外时，再把 `root` 本身补进来。
fn search_dirs(file: Option<&Path>, root: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(mut dir) = file.and_then(Path::parent) {
        loop {
            dirs.push(dir.to_path_buf());
            let stop = match root {
                Some(r) => at_root_or_outside(dir, r),
                None => true,
            };
            if stop {
                break;
            }
            match dir.parent() {
                Some(p) => dir = p,
                None => break,
            }
        }
    }
    if let Some(r) = root {
        if !dirs.iter().any(|d| same_dir(d, r)) {
            dirs.push(r.to_path_buf());
        }
    }
    dirs
}

/// 解析环境 JSON。返回纯文本错误细节，由调用方统一套错误码。
fn parse_env(text: &str) -> Result<EnvMap, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("invalid environment file: {e}"))?;
    let mut out = EnvMap::new();
    let Some(envs) = value.as_object() else {
        return Ok(out);
    };
    for (env, vars) in envs {
        let Some(vars) = vars.as_object() else {
            continue;
        };
        let mut map = BTreeMap::new();
        for (k, v) in vars {
            let s = match v {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::Bool(b) => b.to_string(),
                // 对象走专用的 SSL / auth 配置，不当变量。
                _ => continue,
            };
            map.insert(k.clone(), s);
        }
        out.insert(env.clone(), map);
    }
    Ok(out)
}

/// 沿目录链向上找第一份存在的环境文件并解析；都不存在返回空表。
///
/// # Errors
///
/// 找到的文件解析失败时返回错误。
fn read_first(dirs: &[PathBuf], name: &str) -> Result<EnvMap, String> {
    for d in dirs {
        let p = d.join(name);
        if let Ok(text) = std::fs::read_to_string(&p) {
            return parse_env(&text)
                .map_err(|detail| err("HTTP_ENV", format!("{}: {}", p.display(), detail)));
        }
    }
    Ok(EnvMap::new())
}

impl Environments {
    /// 按搜索目录顺序加载公开与私有环境文件；文件缺失视为空。
    ///
    /// # Errors
    ///
    /// 环境文件解析失败时返回 `HTTP_ENV` 错误串。
    pub fn load(file: Option<&Path>, root: Option<&Path>) -> Result<Self, String> {
        let dirs = search_dirs(file, root);
        Ok(Self {
            public: read_first(&dirs, PUBLIC_FILE)?,
            private: read_first(&dirs, PRIVATE_FILE)?,
        })
    }

    /// 从 JSON 字符串构造（仅测试用）。
    ///
    /// # Errors
    ///
    /// 解析失败时返回 `HTTP_ENV` 错误串。
    #[cfg(test)]
    pub fn from_json(public: &str, private: &str) -> Result<Self, String> {
        let p = |s: &str| -> Result<EnvMap, String> {
            if s.trim().is_empty() {
                Ok(EnvMap::new())
            } else {
                parse_env(s).map_err(|detail| err("HTTP_ENV", detail))
            }
        };
        Ok(Self { public: p(public)?, private: p(private)? })
    }

    /// 环境名（不含 `$shared`），已排序。
    pub fn names(&self) -> Vec<String> {
        let set: BTreeSet<&String> = self
            .public
            .keys()
            .chain(self.private.keys())
            .filter(|k| *k != SHARED)
            .collect();
        set.into_iter().cloned().collect()
    }

    /// `env` 的变量，按查找顺序合并（先到先得）。`BTreeMap` 是为了序列化顺序稳定。
    pub fn variables(&self, env: Option<&str>) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        let mut layer = |m: Option<&BTreeMap<String, String>>| {
            if let Some(m) = m {
                for (k, v) in m {
                    out.entry(k.clone()).or_insert_with(|| v.clone());
                }
            }
        };
        if let Some(env) = env {
            layer(self.private.get(env));
            layer(self.public.get(env));
        }
        layer(self.private.get(SHARED));
        layer(self.public.get(SHARED));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_private_public_and_shared() {
        let envs = Environments::from_json(
            r#"{"$shared":{"v":"1","host":"shared"},"dev":{"host":"localhost","port":8080,"ssl":{"x":1}},"prod":{}}"#,
            r#"{"dev":{"token":"secret"},"$shared":{"v":"2"}}"#,
        )
        .unwrap();
        assert_eq!(envs.names(), vec!["dev", "prod"]);
        let vars = envs.variables(Some("dev"));
        assert_eq!(vars["host"], "localhost");
        assert_eq!(vars["port"], "8080");
        assert_eq!(vars["token"], "secret");
        assert_eq!(vars["v"], "2");
        assert!(!vars.contains_key("ssl"));
        assert_eq!(envs.variables(None)["host"], "shared");
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let nanos = std::time::UNIX_EPOCH.elapsed().map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "forge-http-env-{name}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_env_files_in_ancestors_up_to_root() {
        let tmp = temp_dir("ancestors");
        let root = tmp.as_path();
        std::fs::create_dir_all(root.join("api/v1")).unwrap();
        std::fs::write(root.join(PUBLIC_FILE), r#"{"dev":{"host":"root"}}"#).unwrap();
        std::fs::write(root.join("api").join(PRIVATE_FILE), r#"{"dev":{"token":"t"}}"#).unwrap();
        let envs = Environments::load(Some(&root.join("api/v1/a.http")), Some(root)).unwrap();
        let vars = envs.variables(Some("dev"));
        assert_eq!(vars["host"], "root");
        assert_eq!(vars["token"], "t");
        // 项目外的 scratch 文件依然能看到项目环境。
        let other = temp_dir("outside");
        let envs = Environments::load(Some(&other.join("s.http")), Some(root)).unwrap();
        assert_eq!(envs.names(), vec!["dev"]);
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_dir_all(&other);
    }

    /// 盘符大小写不同仍要走进每一层祖先。只在 Windows 上有意义。
    #[cfg(windows)]
    #[test]
    fn ancestor_walk_ignores_ascii_case() {
        let file = Path::new(r"D:\Work\api\v1\a.http");
        let root = Path::new(r"d:\work");
        let dirs = search_dirs(Some(file), Some(root));
        assert_eq!(dirs.len(), 3, "{dirs:?}");
        assert!(same_dir(&dirs[0], Path::new(r"D:\Work\api\v1")));
        assert!(same_dir(&dirs[1], Path::new(r"D:\Work\api")));
        assert!(same_dir(&dirs[2], Path::new(r"d:\work")));
    }
}