//! 构建依赖自动检测与语义 CRC32 基线计算（参照 IDEA `externalSystem.autoimport`）。
//!
//! 坚持两条底线：
//! 1. 零本地写盘：不在工程目录或应用配置目录下生成任何缓存文件，仅向前端返回各构建单元
//!    当前受控清单文件的语义 CRC32 字典与本地依赖目录就绪状态。
//! 2. 去注释、去空白的语义 CRC32（参照 IDEA `DefaultCrcCalculator`）：用户在 `pom.xml`、
//!    `build.gradle`、`package.json`、`Cargo.toml` 等文件中增删空格、空行或注释时，
//!    语义 CRC32 保持不变，绝不误报；修改依赖后若 `Ctrl+Z` 撤销回原状，CRC32 恢复原值，
//!    前端提示据此自动消隐（Auto-Expire）。

use super::detect::{
    gradle_wrapper_names, is_skipped, line, maven_wrapper_names, nearest_ancestor_with, npm_client,
    program_missing, python_program, quote, rel_path, slashes,
};
use super::{RunConfiguration, RunKind, Unavailable};
use crate::offload::block_value;
use crate::sys;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// 单个构建清单算 CRC32 的最大读取上限（16 MiB），防止异常超大文件阻塞探测。
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;

/// 编译期生成的标准 IEEE 802.3 CRC32 查找表（多项式 0xEDB88320）。
const CRC32_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut crc = i as u32;
        let mut bit = 0;
        while bit < 8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xEDB8_8320;
            } else {
                crc >>= 1;
            }
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
};

/// 零分配流式 CRC32 累加器。
#[derive(Clone, Copy)]
struct Crc32(u32);

impl Crc32 {
    #[inline]
    fn new() -> Self {
        Self(0xFFFF_FFFF)
    }

    #[inline]
    fn update_byte(&mut self, byte: u8) {
        let idx = ((self.0 ^ (byte as u32)) & 0xFF) as usize;
        self.0 = (self.0 >> 8) ^ CRC32_TABLE[idx];
    }

    #[inline]
    fn finalize(self) -> u32 {
        !self.0
    }
}

/// 构建文件的注释语法类别。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommentSyntax {
    /// XML 类（`pom.xml`, `*.csproj`, `*.fsproj`, `Directory.Packages.props`）：忽略 `<!-- ... -->` 与空白。
    Xml,
    /// `#` 行注释类（`Cargo.toml`, `pyproject.toml`, `requirements.txt`, `pubspec.yaml`, `Gemfile`, `mix.exs`, `pnpm-workspace.yaml` 等）：
    /// 忽略字符串字面量外的 `# ... \n` 与空白。
    HashComment,
    /// `//` 与 `/* ... */` 注释类（`build.gradle(.kts)`, `settings.gradle(.kts)`, `go.mod`, `package.json`, `composer.json` 等）：
    /// 忽略字符串字面量外的行/块注释与空白。
    SlashComment,
    /// 原生二进制类（如 `bun.lockb`）：不对内容做文本去注释/去空白，直接计算 CRC32。
    Raw,
}

/// 对字节切片计算去注释、去空白的语义 CRC32。
pub fn semantic_crc32_bytes(bytes: &[u8], syntax: CommentSyntax) -> u32 {
    let mut crc = Crc32::new();
    match syntax {
        CommentSyntax::Raw => {
            for &b in bytes {
                crc.update_byte(b);
            }
        }
        CommentSyntax::Xml => {
            let mut i = 0usize;
            let len = bytes.len();
            while i < len {
                // 识别 <!-- 注释起点，一直跳到匹配的 -->
                if i + 4 <= len && &bytes[i..i + 4] == b"<!--" {
                    i += 4;
                    while i + 3 <= len && &bytes[i..i + 3] != b"-->" {
                        i += 1;
                    }
                    i = if i + 3 <= len { i + 3 } else { len };
                    continue;
                }
                let b = bytes[i];
                if !b.is_ascii_whitespace() {
                    crc.update_byte(b);
                }
                i += 1;
            }
        }
        CommentSyntax::HashComment => {
            let mut i = 0usize;
            let len = bytes.len();
            let mut in_quote: Option<u8> = None;
            while i < len {
                let b = bytes[i];
                // 换行时自动闭合单行引号，避免 YAML 等非严格引号文本吞掉后续行的 # 注释
                if b == b'\n' || b == b'\r' {
                    in_quote = None;
                    i += 1;
                    continue;
                }
                if let Some(q) = in_quote {
                    if b == b'\\' && i + 1 < len {
                        if !b.is_ascii_whitespace() {
                            crc.update_byte(b);
                        }
                        let next = bytes[i + 1];
                        if !next.is_ascii_whitespace() {
                            crc.update_byte(next);
                        }
                        i += 2;
                        continue;
                    }
                    if b == q {
                        in_quote = None;
                    }
                    if !b.is_ascii_whitespace() {
                        crc.update_byte(b);
                    }
                    i += 1;
                    continue;
                }
                if b == b'#' {
                    i += 1;
                    while i < len && bytes[i] != b'\n' {
                        i += 1;
                    }
                    continue;
                }
                if b == b'"' || b == b'\'' {
                    in_quote = Some(b);
                }
                if !b.is_ascii_whitespace() {
                    crc.update_byte(b);
                }
                i += 1;
            }
        }
        CommentSyntax::SlashComment => {
            let mut i = 0usize;
            let len = bytes.len();
            let mut in_quote: Option<u8> = None;
            while i < len {
                let b = bytes[i];
                if b == b'\n' || b == b'\r' {
                    in_quote = None;
                    i += 1;
                    continue;
                }
                if let Some(q) = in_quote {
                    if b == b'\\' && i + 1 < len {
                        if !b.is_ascii_whitespace() {
                            crc.update_byte(b);
                        }
                        let next = bytes[i + 1];
                        if !next.is_ascii_whitespace() {
                            crc.update_byte(next);
                        }
                        i += 2;
                        continue;
                    }
                    if b == q {
                        in_quote = None;
                    }
                    if !b.is_ascii_whitespace() {
                        crc.update_byte(b);
                    }
                    i += 1;
                    continue;
                }
                // 行注释 // ... \n
                if i + 2 <= len && &bytes[i..i + 2] == b"//" {
                    i += 2;
                    while i < len && bytes[i] != b'\n' {
                        i += 1;
                    }
                    continue;
                }
                // 块注释 /* ... */
                if i + 2 <= len && &bytes[i..i + 2] == b"/*" {
                    i += 2;
                    while i + 2 <= len && &bytes[i..i + 2] != b"*/" {
                        i += 1;
                    }
                    i = if i + 2 <= len { i + 2 } else { len };
                    continue;
                }
                if b == b'"' || b == b'\'' {
                    in_quote = Some(b);
                }
                if !b.is_ascii_whitespace() {
                    crc.update_byte(b);
                }
                i += 1;
            }
        }
    }
    crc.finalize()
}

/// 读取磁盘上的构建文件字节；文件不存在或超长时返回 `None`。
fn read_manifest_bytes(path: &Path) -> Option<Vec<u8>> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_MANIFEST_BYTES {
        return None;
    }
    fs::read(path).ok()
}

/// 读取磁盘上的构建文件并计算语义 CRC32；文件不存在或超长时返回 `None`。
fn file_semantic_crc32(path: &Path, syntax: CommentSyntax) -> Option<u32> {
    let bytes = read_manifest_bytes(path)?;
    let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if filename.eq_ignore_ascii_case("package-lock.json") {
        return Some(package_lock_semantic_crc32(&bytes));
    }
    if filename.eq_ignore_ascii_case("Cargo.toml") {
        return Some(cargo_toml_semantic_crc32(&bytes));
    }
    Some(semantic_crc32_bytes(&bytes, syntax))
}

/// 针对 `package-lock.json`：
/// 忽略工程自身的版本修改（顶层 `version` 以及 `packages[""].version`）；
/// 第三方依赖包的 `version` 完整保留；
/// 若文件无法解析为 JSON，则回退到去注释/去空白的全文语义 CRC32。
pub fn package_lock_semantic_crc32(bytes: &[u8]) -> u32 {
    if let Ok(mut val) = serde_json::from_slice::<serde_json::Value>(bytes) {
        if let Some(obj) = val.as_object_mut() {
            // 忽略顶层 version
            obj.remove("version");
            // 忽略 packages[""].version（lockfileVersion 2 & 3 中当前工程自身的版本镜像）
            if let Some(packages) = obj.get_mut("packages").and_then(|p| p.as_object_mut()) {
                if let Some(root_pkg) = packages.get_mut("").and_then(|r| r.as_object_mut()) {
                    root_pkg.remove("version");
                }
            }
            if let Ok(serialized) = serde_json::to_vec(&obj) {
                let mut crc = Crc32::new();
                for &b in &serialized {
                    crc.update_byte(b);
                }
                return crc.finalize();
            }
        }
    }
    semantic_crc32_bytes(bytes, CommentSyntax::SlashComment)
}

/// 针对 `Cargo.toml`：
/// 忽略 `[package]`（以及 `[workspace.package]`）中的非依赖元数据字段
/// （如 `version`、`description`、`authors`、`readme`、`license` 等）；
/// 仅保留与构建与依赖解析相关的核心配置（如各种 `dependencies`、`workspace`、`patch` 等）；
/// 若语法错误无法解析为 TOML，则回退到去注释/去空白的全文语义 CRC32。
pub fn cargo_toml_semantic_crc32(bytes: &[u8]) -> u32 {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return semantic_crc32_bytes(bytes, CommentSyntax::HashComment);
    };
    if let Ok(mut val) = toml::from_str::<toml::Value>(text) {
        if let Some(table) = val.as_table_mut() {
            const NON_DEP_PACKAGE_KEYS: &[&str] = &[
                "version",
                "description",
                "authors",
                "homepage",
                "repository",
                "documentation",
                "readme",
                "keywords",
                "categories",
                "license",
                "license-file",
                "publish",
                "edition",
                "rust-version",
                "exclude",
                "include",
                "default-run",
            ];

            if let Some(pkg) = table.get_mut("package").and_then(|p| p.as_table_mut()) {
                for &k in NON_DEP_PACKAGE_KEYS {
                    pkg.remove(k);
                }
            }

            if let Some(ws) = table.get_mut("workspace").and_then(|w| w.as_table_mut()) {
                if let Some(ws_pkg) = ws.get_mut("package").and_then(|p| p.as_table_mut()) {
                    for &k in NON_DEP_PACKAGE_KEYS {
                        ws_pkg.remove(k);
                    }
                }
            }

            if let Ok(serialized) = toml::to_string(&table) {
                let mut crc = Crc32::new();
                for &b in serialized.as_bytes() {
                    if !b.is_ascii_whitespace() {
                        crc.update_byte(b);
                    }
                }
                return crc.finalize();
            }
        }
    }
    semantic_crc32_bytes(bytes, CommentSyntax::HashComment)
}

/// 针对 `package.json` / `composer.json` 等 JSON 构建清单：
/// 仅提取与依赖解析相关的字段计算 CRC32（忽略 `scripts`、`version`、`description` 等无关字段的修改）；
/// 若文件存在语法错误暂时无法解析为 JSON 对象，则回退到去空白/去注释的全文语义 CRC32。
pub fn json_dep_semantic_crc32(bytes: &[u8], dep_keys: &[&str]) -> (u32, Option<serde_json::Value>) {
    if let Ok(val) = serde_json::from_slice::<serde_json::Value>(bytes) {
        if let Some(obj) = val.as_object() {
            let mut crc = Crc32::new();
            for &key in dep_keys {
                if let Some(sub) = obj.get(key) {
                    // serde_json::Value 的 Map 默认按 BTreeMap 字典序存储（或稳定序列化），写入字段名与紧凑 JSON 字节
                    for &b in key.as_bytes() {
                        crc.update_byte(b);
                    }
                    crc.update_byte(b':');
                    if let Ok(serialized) = serde_json::to_vec(sub) {
                        for &b in &serialized {
                            crc.update_byte(b);
                        }
                    }
                    crc.update_byte(b';');
                }
            }
            return (crc.finalize(), Some(val));
        }
    }
    (semantic_crc32_bytes(bytes, CommentSyntax::SlashComment), None)
}

/// 一个构建单元的依赖同步探测快照。
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DepSyncItem {
    /// 稳定单元标识，如 `"npm::package.json"`、`"maven::sub/pom.xml"`。
    pub id: String,
    /// 构建工具类型，供前端复用 `RunKindIcon`。
    pub kind: RunKind,
    /// 展示用的主构建清单相对路径（统一用 `/` 分隔）。
    pub manifest: String,
    /// 该单元关联的所有受控构建文件（相对工程根路径 `/` 分隔 -> 语义 CRC32）。
    pub files_crc: BTreeMap<String, u32>,
    /// 本地依赖目录是否缺失（如 `node_modules` 不存在或为空目录）。
    pub missing_installed: bool,
    /// 预生成的标准运行配置，前端直接传给 `run.start(item.installConfig, root)` 即可运行。
    pub install_config: RunConfiguration,
}

/// 判断目录是否存在且至少含有一个条目。
fn has_non_empty_dir(dir: &Path) -> bool {
    let Ok(mut entries) = fs::read_dir(dir) else {
        return false;
    };
    entries.next().is_some()
}

/// 判断 JSON 对象里的指定字段是否是非空对象。
fn has_non_empty_json_object(value: &serde_json::Value, keys: &[&str]) -> bool {
    keys.iter().any(|key| {
        value
            .get(*key)
            .and_then(|v| v.as_object())
            .is_some_and(|obj| !obj.is_empty())
    })
}

/// 扫描工作区根目录及一级子目录（深度上限 1，跳过 `SKIP_DIRS` 与隐藏目录）。
fn candidate_dirs(root: &Path) -> Vec<PathBuf> {
    // 扫描深度设为 4，与 detect.rs 保持一致，支持 Monorepo 深层子模块依赖同步
    WalkDir::new(root)
        .follow_links(false)
        .max_depth(4)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            if is_skipped(entry) {
                return false;
            }
            !entry.file_name().to_string_lossy().starts_with('.')
        })
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_dir())
        .map(|entry| entry.path().to_path_buf())
        .collect()
}

/// 将存在的文件登记进 `files_crc` 表。
fn record_crc(
    root: &Path,
    files_crc: &mut BTreeMap<String, u32>,
    path: &Path,
    syntax: CommentSyntax,
) {
    if let Some(crc) = file_semantic_crc32(path, syntax) {
        files_crc.insert(slashes(&rel_path(root, path)), crc);
    }
}

/// 构造一条依赖同步专用的 `RunConfiguration`。
fn make_install_config(
    item_id: &str,
    name: String,
    kind: RunKind,
    command: String,
    working_dir: String,
    unavailable: Option<Unavailable>,
) -> RunConfiguration {
    RunConfiguration {
        id: format!("dep-sync::{item_id}"),
        name,
        kind,
        command,
        working_dir,
        env: Vec::new(),
        generated: true,
        pinned: false,
        unavailable,
        helper: None,
        markers: Vec::new(),
    }
}

/// 供页签展示的同步任务名：根目录直接显示命令，子目录前缀模块名。
fn display_sync_name(root: &Path, dir: &Path, cmd_label: &str) -> String {
    let rel = slashes(&rel_path(root, dir));
    if rel.is_empty() {
        cmd_label.to_string()
    } else {
        format!("{rel} [{cmd_label}]")
    }
}

/// 解析 JVM 构建工具（优先 wrapper，否则回退本机 PATH 上的 `${mvn}` / `${gradle}`）。
fn resolve_jvm_tool(
    root: &Path,
    dir: &Path,
    win_wrapper: &str,
    unix_wrapper: &str,
    program: &str,
) -> (String, PathBuf, Option<Unavailable>) {
    if let Some(at) = nearest_ancestor_with(dir, root, &[win_wrapper, unix_wrapper]) {
        let invoke = if cfg!(windows) {
            win_wrapper.to_string()
        } else {
            // 类 Unix 下用 sh 引导执行，兼容 Windows 签出或解压时丢失 +x 执行位的场景
            format!("sh ./{unix_wrapper}")
        };
        return (invoke, at, None);
    }
    let missing = if sys::which_program(program).is_empty() {
        Some(Unavailable {
            code: "NO_TOOL".to_string(),
            detail: program.to_string(),
        })
    } else {
        None
    };
    (format!("${{{program}}}"), root.to_path_buf(), missing)
}

/// 探测 Node.js (`package.json`)。
fn probe_npm(root: &Path, dir: &Path, out: &mut Vec<DepSyncItem>) {
    let manifest_path = dir.join("package.json");
    let Some(bytes) = read_manifest_bytes(&manifest_path) else {
        return;
    };
    let (pkg_crc, parsed) = json_dep_semantic_crc32(
        &bytes,
        &[
            "dependencies",
            "devDependencies",
            "optionalDependencies",
            "peerDependencies",
            "peerDependenciesMeta",
            "bundledDependencies",
            "bundleDependencies",
            "overrides",
            "resolutions",
            "workspaces",
            "packageManager",
            "pnpm",
        ],
    );
    let manifest = slashes(&rel_path(root, &manifest_path));
    let mut files_crc = BTreeMap::new();
    files_crc.insert(manifest.clone(), pkg_crc);
    for (file, syntax) in [
        ("package-lock.json", CommentSyntax::SlashComment),
        ("pnpm-lock.yaml", CommentSyntax::HashComment),
        ("pnpm-workspace.yaml", CommentSyntax::HashComment),
        ("yarn.lock", CommentSyntax::HashComment),
        ("bun.lock", CommentSyntax::SlashComment),
        ("bun.lockb", CommentSyntax::Raw),
    ] {
        record_crc(root, &mut files_crc, &dir.join(file), syntax);
    }

    let has_deps = parsed.is_some_and(|val| {
        has_non_empty_json_object(
            &val,
            &[
                "dependencies",
                "devDependencies",
                "optionalDependencies",
                "peerDependencies",
            ],
        ) || val
            .get("workspaces")
            .is_some_and(|w| w.as_array().is_some_and(|a| !a.is_empty()) || w.as_object().is_some_and(|o| !o.is_empty()))
    });

    // 若是子包且根上已有 node_modules（monorepo hoist），也视为已安装。
    let missing_installed = has_deps
        && !has_non_empty_dir(&dir.join("node_modules"))
        && !has_non_empty_dir(&root.join("node_modules"));

    let client = npm_client(dir, root);
    let cmd = format!("{client} install");
    let id = format!("npm::{manifest}");
    let install_config = make_install_config(
        &id,
        display_sync_name(root, dir, &cmd),
        RunKind::Npm,
        cmd,
        rel_path(root, dir),
        program_missing(client),
    );
    out.push(DepSyncItem {
        id,
        kind: RunKind::Npm,
        manifest,
        files_crc,
        missing_installed,
        install_config,
    });
}

/// 探测 Maven (`pom.xml`)。
fn probe_maven(root: &Path, dir: &Path, out: &mut Vec<DepSyncItem>) {
    let pom = dir.join("pom.xml");
    if !pom.is_file() {
        return;
    }
    let mut files_crc = BTreeMap::new();
    record_crc(root, &mut files_crc, &pom, CommentSyntax::Xml);
    if files_crc.is_empty() {
        return;
    }
    let (win, unix) = maven_wrapper_names();
    let (invoke, tool_dir, missing) = resolve_jvm_tool(root, dir, win, unix, "mvn");
    let location = if tool_dir == dir {
        String::new()
    } else {
        format!("-f {}", quote(&rel_path(&tool_dir, &pom)))
    };
    let command = line(&[&invoke, &location, "dependency:resolve"]);
    let manifest = slashes(&rel_path(root, &pom));
    let id = format!("maven::{manifest}");
    let install_config = make_install_config(
        &id,
        display_sync_name(root, dir, "mvn dependency:resolve"),
        RunKind::Maven,
        command,
        rel_path(root, &tool_dir),
        missing,
    );
    out.push(DepSyncItem {
        id,
        kind: RunKind::Maven,
        manifest,
        files_crc,
        missing_installed: false,
        install_config,
    });
}

/// 探测 Gradle (`build.gradle(.kts)`)。
fn probe_gradle(root: &Path, dir: &Path, out: &mut Vec<DepSyncItem>) {
    let Some(primary) = ["build.gradle.kts", "build.gradle"]
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
    else {
        return;
    };
    let mut files_crc = BTreeMap::new();
    for (file, syntax) in [
        ("build.gradle.kts", CommentSyntax::SlashComment),
        ("build.gradle", CommentSyntax::SlashComment),
        ("settings.gradle.kts", CommentSyntax::SlashComment),
        ("settings.gradle", CommentSyntax::SlashComment),
        ("gradle.properties", CommentSyntax::HashComment),
        ("gradle/libs.versions.toml", CommentSyntax::HashComment),
    ] {
        record_crc(root, &mut files_crc, &dir.join(file), syntax);
    }
    if files_crc.is_empty() {
        return;
    }
    let (win, unix) = gradle_wrapper_names();
    let (invoke, tool_dir, missing) = resolve_jvm_tool(root, dir, win, unix, "gradle");
    let location = if tool_dir == dir {
        String::new()
    } else {
        format!("-p {}", quote(&rel_path(&tool_dir, dir)))
    };
    let command = line(&[&invoke, &location, "--refresh-dependencies", "help"]);
    let manifest = slashes(&rel_path(root, &primary));
    let id = format!("gradle::{manifest}");
    let install_config = make_install_config(
        &id,
        display_sync_name(root, dir, "gradle --refresh-dependencies"),
        RunKind::Gradle,
        command,
        rel_path(root, &tool_dir),
        missing,
    );
    out.push(DepSyncItem {
        id,
        kind: RunKind::Gradle,
        manifest,
        files_crc,
        missing_installed: false,
        install_config,
    });
}

/// 探测 Rust (`Cargo.toml`)。
/// 注意：不将 `Cargo.lock` 计入触发源，因为 `cargo check` / `cargo build` 自身会自动写 `Cargo.lock`，
/// 对齐 IDEA Rust 插件仅跟踪 `Cargo.toml`、`rust-toolchain.toml` 与 `.cargo/config.toml`。
fn probe_rust(root: &Path, dir: &Path, out: &mut Vec<DepSyncItem>) {
    let cargo_toml = dir.join("Cargo.toml");
    if !cargo_toml.is_file() {
        return;
    }
    let mut files_crc = BTreeMap::new();
    record_crc(root, &mut files_crc, &cargo_toml, CommentSyntax::HashComment);
    record_crc(
        root,
        &mut files_crc,
        &dir.join("rust-toolchain.toml"),
        CommentSyntax::HashComment,
    );
    record_crc(
        root,
        &mut files_crc,
        &dir.join(".cargo/config.toml"),
        CommentSyntax::HashComment,
    );
    if files_crc.is_empty() {
        return;
    }
    let manifest = slashes(&rel_path(root, &cargo_toml));
    let id = format!("rust::{manifest}");
    let install_config = make_install_config(
        &id,
        display_sync_name(root, dir, "cargo fetch"),
        RunKind::Rust,
        "cargo fetch".to_string(),
        rel_path(root, dir),
        program_missing("cargo"),
    );
    out.push(DepSyncItem {
        id,
        kind: RunKind::Rust,
        manifest,
        files_crc,
        missing_installed: false,
        install_config,
    });
}

/// 探测 Go (`go.mod`)。
/// 注意：不将 `go.sum` 计入触发源，避免 `go build` / `go test` 更新校验和时引发误报。
fn probe_go(root: &Path, dir: &Path, out: &mut Vec<DepSyncItem>) {
    let go_mod = dir.join("go.mod");
    if !go_mod.is_file() {
        return;
    }
    let mut files_crc = BTreeMap::new();
    record_crc(root, &mut files_crc, &go_mod, CommentSyntax::SlashComment);
    record_crc(
        root,
        &mut files_crc,
        &dir.join("go.work"),
        CommentSyntax::SlashComment,
    );
    if files_crc.is_empty() {
        return;
    }
    let manifest = slashes(&rel_path(root, &go_mod));
    let id = format!("go::{manifest}");
    let install_config = make_install_config(
        &id,
        display_sync_name(root, dir, "go mod download"),
        RunKind::Go,
        "go mod download".to_string(),
        rel_path(root, dir),
        program_missing("go"),
    );
    out.push(DepSyncItem {
        id,
        kind: RunKind::Go,
        manifest,
        files_crc,
        missing_installed: false,
        install_config,
    });
}

/// 探测 Python (`pyproject.toml` / `Pipfile` / `requirements.txt`)。
fn probe_python(root: &Path, dir: &Path, out: &mut Vec<DepSyncItem>) {
    let Some(primary) = ["pyproject.toml", "Pipfile", "requirements.txt"]
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
    else {
        return;
    };
    let mut files_crc = BTreeMap::new();
    for (file, syntax) in [
        ("pyproject.toml", CommentSyntax::HashComment),
        ("Pipfile", CommentSyntax::HashComment),
        ("requirements.txt", CommentSyntax::HashComment),
        ("uv.lock", CommentSyntax::HashComment),
        ("poetry.lock", CommentSyntax::HashComment),
        ("Pipfile.lock", CommentSyntax::SlashComment),
    ] {
        record_crc(root, &mut files_crc, &dir.join(file), syntax);
    }
    if files_crc.is_empty() {
        return;
    }

    let has_uv = dir.join("uv.lock").is_file();
    let has_poetry = dir.join("poetry.lock").is_file();
    let has_pipenv = dir.join("Pipfile").is_file() || dir.join("Pipfile.lock").is_file();
    let has_reqs = dir.join("requirements.txt").is_file();

    let (cmd, label, program) = if has_uv {
        ("uv sync".to_string(), "uv sync".to_string(), "uv".to_string())
    } else if has_poetry {
        (
            "poetry install".to_string(),
            "poetry install".to_string(),
            "poetry".to_string(),
        )
    } else if has_pipenv {
        (
            "pipenv install".to_string(),
            "pipenv install".to_string(),
            "pipenv".to_string(),
        )
    } else if has_reqs {
        let py = python_program();
        (
            format!("{py} -m pip install -r requirements.txt"),
            "pip install -r requirements.txt".to_string(),
            py,
        )
    } else {
        let py = python_program();
        (
            format!("{py} -m pip install -e ."),
            "pip install -e .".to_string(),
            py,
        )
    };

    // 探测虚拟环境状态：
    // uv 默认采用项目内 .venv；Poetry 与 Pipenv 默认在全局缓存维护虚拟环境（除非用户显式配置 in-project），
    // 故若未生成项目内 .venv，不可盲目判定为 missing_installed，只有锁文件确实缺失时才推断缺失，
    // 避免对全局 virtualenv 死循环误报。
    let has_venv = dir.join(".venv").is_dir()
        || dir.join("venv").is_dir()
        || root.join(".venv").is_dir()
        || root.join("venv").is_dir();
    let missing_installed = if has_uv {
        !has_venv
    } else if has_poetry {
        !has_venv && !dir.join("poetry.lock").is_file()
    } else if has_pipenv {
        !has_venv && !dir.join("Pipfile.lock").is_file()
    } else {
        false
    };

    let manifest = slashes(&rel_path(root, &primary));
    let id = format!("python::{manifest}");
    let install_config = make_install_config(
        &id,
        display_sync_name(root, dir, &label),
        RunKind::Python,
        cmd,
        rel_path(root, dir),
        program_missing(&program),
    );
    out.push(DepSyncItem {
        id,
        kind: RunKind::Python,
        manifest,
        files_crc,
        missing_installed,
        install_config,
    });
}

/// 探测 PHP (`composer.json`)。
fn probe_php(root: &Path, dir: &Path, out: &mut Vec<DepSyncItem>) {
    let composer_json = dir.join("composer.json");
    let Some(bytes) = read_manifest_bytes(&composer_json) else {
        return;
    };
    let (crc, parsed) = json_dep_semantic_crc32(
        &bytes,
        &[
            "require",
            "require-dev",
            "repositories",
            "config",
            "minimum-stability",
            "prefer-stable",
            "autoload",
            "autoload-dev",
        ],
    );
    let manifest = slashes(&rel_path(root, &composer_json));
    let mut files_crc = BTreeMap::new();
    files_crc.insert(manifest.clone(), crc);
    record_crc(
        root,
        &mut files_crc,
        &dir.join("composer.lock"),
        CommentSyntax::SlashComment,
    );

    let has_deps = parsed.is_some_and(|val| has_non_empty_json_object(&val, &["require", "require-dev"]));
    let missing_installed = has_deps && !dir.join("vendor").join("autoload.php").is_file();
    let id = format!("php::{manifest}");
    let install_config = make_install_config(
        &id,
        display_sync_name(root, dir, "composer install"),
        RunKind::Php,
        "composer install".to_string(),
        rel_path(root, dir),
        program_missing("composer"),
    );
    out.push(DepSyncItem {
        id,
        kind: RunKind::Php,
        manifest,
        files_crc,
        missing_installed,
        install_config,
    });
}

/// 探测 Ruby (`Gemfile`)。
fn probe_ruby(root: &Path, dir: &Path, out: &mut Vec<DepSyncItem>) {
    let gemfile = dir.join("Gemfile");
    if !gemfile.is_file() {
        return;
    }
    let mut files_crc = BTreeMap::new();
    record_crc(root, &mut files_crc, &gemfile, CommentSyntax::HashComment);
    record_crc(
        root,
        &mut files_crc,
        &dir.join("Gemfile.lock"),
        CommentSyntax::HashComment,
    );
    if files_crc.is_empty() {
        return;
    }
    let manifest = slashes(&rel_path(root, &gemfile));
    let id = format!("ruby::{manifest}");
    let install_config = make_install_config(
        &id,
        display_sync_name(root, dir, "bundle install"),
        RunKind::Ruby,
        "bundle install".to_string(),
        rel_path(root, dir),
        program_missing("bundle"),
    );
    out.push(DepSyncItem {
        id,
        kind: RunKind::Ruby,
        manifest,
        files_crc,
        missing_installed: false,
        install_config,
    });
}

/// 探测 Dart / Flutter (`pubspec.yaml`)。
fn probe_dart(root: &Path, dir: &Path, out: &mut Vec<DepSyncItem>) {
    let pubspec = dir.join("pubspec.yaml");
    let Some(bytes) = read_manifest_bytes(&pubspec) else {
        return;
    };
    let manifest = slashes(&rel_path(root, &pubspec));
    let mut files_crc = BTreeMap::new();
    files_crc.insert(
        manifest.clone(),
        semantic_crc32_bytes(&bytes, CommentSyntax::HashComment),
    );
    record_crc(
        root,
        &mut files_crc,
        &dir.join("pubspec.lock"),
        CommentSyntax::HashComment,
    );
    let text = String::from_utf8_lossy(&bytes);
    let is_flutter = text.contains("flutter:") || text.contains("sdk: flutter");
    let (cmd, program) = if is_flutter {
        ("flutter pub get", "flutter")
    } else {
        ("dart pub get", "dart")
    };
    let missing_installed = !dir.join(".dart_tool").join("package_config.json").is_file();
    let id = format!("dart::{manifest}");
    let install_config = make_install_config(
        &id,
        display_sync_name(root, dir, cmd),
        RunKind::Dart,
        cmd.to_string(),
        rel_path(root, dir),
        program_missing(program),
    );
    out.push(DepSyncItem {
        id,
        kind: RunKind::Dart,
        manifest,
        files_crc,
        missing_installed,
        install_config,
    });
}

/// 探测 Elixir (`mix.exs`)。
fn probe_elixir(root: &Path, dir: &Path, out: &mut Vec<DepSyncItem>) {
    let mix_exs = dir.join("mix.exs");
    if !mix_exs.is_file() {
        return;
    }
    let mut files_crc = BTreeMap::new();
    record_crc(root, &mut files_crc, &mix_exs, CommentSyntax::HashComment);
    record_crc(
        root,
        &mut files_crc,
        &dir.join("mix.lock"),
        CommentSyntax::HashComment,
    );
    if files_crc.is_empty() {
        return;
    }
    let manifest = slashes(&rel_path(root, &mix_exs));
    let id = format!("elixir::{manifest}");
    let install_config = make_install_config(
        &id,
        display_sync_name(root, dir, "mix deps.get"),
        RunKind::Elixir,
        "mix deps.get".to_string(),
        rel_path(root, dir),
        program_missing("mix"),
    );
    out.push(DepSyncItem {
        id,
        kind: RunKind::Elixir,
        manifest,
        files_crc,
        missing_installed: false,
        install_config,
    });
}

/// 探测 .NET (`*.csproj` / `*.fsproj`)。
fn probe_dotnet(root: &Path, dir: &Path, out: &mut Vec<DepSyncItem>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut projects: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            matches!(
                path.extension().and_then(|ext| ext.to_str()),
                Some("csproj") | Some("fsproj")
            )
        })
        .collect();
    if projects.is_empty() {
        return;
    }
    projects.sort();
    for proj in projects {
        let mut files_crc = BTreeMap::new();
        record_crc(root, &mut files_crc, &proj, CommentSyntax::Xml);
        record_crc(
            root,
            &mut files_crc,
            &dir.join("Directory.Packages.props"),
            CommentSyntax::Xml,
        );
        if files_crc.is_empty() {
            continue;
        }
        let manifest = slashes(&rel_path(root, &proj));
        let id = format!("dotnet::{manifest}");
        let install_config = make_install_config(
            &id,
            display_sync_name(root, dir, "dotnet restore"),
            RunKind::DotNet,
            "dotnet restore".to_string(),
            rel_path(root, dir),
            program_missing("dotnet"),
        );
        out.push(DepSyncItem {
            id,
            kind: RunKind::DotNet,
            manifest,
            files_crc,
            missing_installed: false,
            install_config,
        });
    }
}

/// 扫描工作区根及一级子目录下的构建依赖状态。
#[tauri::command]
pub async fn dep_sync_probe(root: String) -> Vec<DepSyncItem> {
    block_value(move || dep_sync_probe_impl(&root), Vec::new).await
}

fn dep_sync_probe_impl(root: &str) -> Vec<DepSyncItem> {
    let base = PathBuf::from(root);
    if !base.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for dir in candidate_dirs(&base) {
        probe_npm(&base, &dir, &mut out);
        probe_maven(&base, &dir, &mut out);
        probe_gradle(&base, &dir, &mut out);
        probe_rust(&base, &dir, &mut out);
        probe_go(&base, &dir, &mut out);
        probe_python(&base, &dir, &mut out);
        probe_php(&base, &dir, &mut out);
        probe_ruby(&base, &dir, &mut out);
        probe_dart(&base, &dir, &mut out);
        probe_elixir(&base, &dir, &mut out);
        probe_dotnet(&base, &dir, &mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("forge-dep-sync-{tag}"));
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

    #[test]
    fn xml_semantic_crc32_ignores_whitespace_and_comments() {
        let base_pom = r#"
            <project>
                <dependencies>
                    <dependency>
                        <groupId>org.springframework.boot</groupId>
                        <artifactId>spring-boot-starter-web</artifactId>
                        <version>3.2.0</version>
                    </dependency>
                </dependencies>
            </project>
        "#;
        let commented_pom = r#"
            <!-- 顶层注释 -->
            <project>

                <dependencies>
                    <!-- 新增注释与空行，不改任何依赖坐标 -->
                    <dependency>
                        <groupId>  org.springframework.boot  </groupId>
                        <artifactId>spring-boot-starter-web</artifactId>
                        <version>3.2.0</version>
                    </dependency>
                </dependencies>
            </project>
        "#;
        let modified_pom = r#"
            <project>
                <dependencies>
                    <dependency>
                        <groupId>org.springframework.boot</groupId>
                        <artifactId>spring-boot-starter-web</artifactId>
                        <version>3.2.1</version>
                    </dependency>
                </dependencies>
            </project>
        "#;

        let crc_base = semantic_crc32_bytes(base_pom.as_bytes(), CommentSyntax::Xml);
        let crc_commented = semantic_crc32_bytes(commented_pom.as_bytes(), CommentSyntax::Xml);
        let crc_modified = semantic_crc32_bytes(modified_pom.as_bytes(), CommentSyntax::Xml);

        assert_eq!(crc_base, crc_commented, "增删 XML 注释与空白不应改变语义 CRC32");
        assert_ne!(crc_base, crc_modified, "修改依赖版本号必须改变语义 CRC32");
    }

    #[test]
    fn slash_comment_semantic_crc32_ignores_line_and_block_comments() {
        let gradle_a = r#"
            dependencies {
                implementation("com.google.guava:guava:33.0.0-jre")
            }
        "#;
        let gradle_b = r#"
            // 单行注释
            dependencies {
                /* 块注释
                   跨越多行 */
                implementation( "com.google.guava:guava:33.0.0-jre" ) // 行尾注释
            }
        "#;
        let gradle_c = r#"
            dependencies {
                implementation("com.google.guava:guava:33.1.0-jre")
            }
        "#;

        let crc_a = semantic_crc32_bytes(gradle_a.as_bytes(), CommentSyntax::SlashComment);
        let crc_b = semantic_crc32_bytes(gradle_b.as_bytes(), CommentSyntax::SlashComment);
        let crc_c = semantic_crc32_bytes(gradle_c.as_bytes(), CommentSyntax::SlashComment);

        assert_eq!(crc_a, crc_b, "Gradle 增删行/块注释与空白不应改变语义 CRC32");
        assert_ne!(crc_a, crc_c, "修改依赖版本必须改变语义 CRC32");

        // 字符串字面量内部的 //（如仓库 URL）不能被误当作行注释剥掉
        let url_a = r#"repositories { maven { url = uri("https://repo.maven.apache.org/maven2") } }"#;
        let url_b = r#"repositories { maven { url = uri("https://maven.aliyun.com/repository/public") } }"#;
        assert_ne!(
            semantic_crc32_bytes(url_a.as_bytes(), CommentSyntax::SlashComment),
            semantic_crc32_bytes(url_b.as_bytes(), CommentSyntax::SlashComment),
            "引号内的 // 属于字符串内容，修改 URL 后 CRC32 必须不同"
        );
    }

    #[test]
    fn hash_comment_semantic_crc32_ignores_comments_and_preserves_quoted_hash() {
        let cargo_a = r#"
            [dependencies]
            serde = { version = "1.0", features = ["derive"] }
        "#;
        let cargo_b = r#"
            # 增加注释与缩进空白
            [dependencies]

            serde = {   version = "1.0",   features = ["derive"]   } # 尾部注释
        "#;
        let cargo_c = r#"
            [dependencies]
            serde = { version = "1.0.200", features = ["derive"] }
        "#;

        assert_eq!(
            semantic_crc32_bytes(cargo_a.as_bytes(), CommentSyntax::HashComment),
            semantic_crc32_bytes(cargo_b.as_bytes(), CommentSyntax::HashComment)
        );
        assert_ne!(
            semantic_crc32_bytes(cargo_a.as_bytes(), CommentSyntax::HashComment),
            semantic_crc32_bytes(cargo_c.as_bytes(), CommentSyntax::HashComment)
        );
    }

    #[test]
    fn probe_detects_missing_node_modules_and_clears_once_installed() {
        let dir = temp_project("npm-missing");
        write(
            &dir,
            "package.json",
            r#"{"name":"demo","dependencies":{"react":"^19.0.0"}}"#,
        );
        write(&dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");

        let first = dep_sync_probe_impl(&dir.to_string_lossy());
        let npm = first.iter().find(|item| item.id == "npm::package.json").unwrap();
        assert!(npm.missing_installed, "未创建 node_modules 时应报告缺失安装");
        assert_eq!(npm.install_config.command, "pnpm install");
        assert!(npm.files_crc.contains_key("package.json"));

        // 仅修改 package.json 中的 scripts 或 version 字段时，语义 CRC32 应保持不变（不误报依赖更新）
        let crc_before = npm.files_crc["package.json"];
        write(
            &dir,
            "package.json",
            r#"{"name":"demo","version":"2.0.0","scripts":{"dev":"vite --port 4000"},"dependencies":{"react":"^19.0.0"}}"#,
        );
        // 装好 node_modules 后 missing_installed 应变为 false
        write(&dir, "node_modules/.modules.yaml", "hoisted: true\n");
        let second = dep_sync_probe_impl(&dir.to_string_lossy());
        let npm_after = second.iter().find(|item| item.id == "npm::package.json").unwrap();
        assert!(!npm_after.missing_installed, "node_modules 非空后不再报缺失");
        assert_eq!(
            npm_after.files_crc["package.json"], crc_before,
            "修改 scripts/version 等非依赖字段不应改变 package.json 依赖语义 CRC32"
        );

        // 修改 dependencies 版本时，语义 CRC32 必须改变
        write(
            &dir,
            "package.json",
            r#"{"name":"demo","version":"2.0.0","scripts":{"dev":"vite --port 4000"},"dependencies":{"react":"^19.1.0"}}"#,
        );
        let third = dep_sync_probe_impl(&dir.to_string_lossy());
        let npm_changed = third.iter().find(|item| item.id == "npm::package.json").unwrap();
        assert_ne!(
            npm_changed.files_crc["package.json"], crc_before,
            "修改 dependencies 版本必须改变 package.json 依赖语义 CRC32"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn probe_covers_maven_rust_and_go_commands() {
        let dir = temp_project("polyglot");
        write(&dir, "pom.xml", "<project><artifactId>app</artifactId></project>");
        write(&dir, "Cargo.toml", "[package]\nname = \"app\"\nversion = \"0.1.0\"\n");
        write(&dir, "go.mod", "module example.com/app\n\ngo 1.22\n");

        let items = dep_sync_probe_impl(&dir.to_string_lossy());
        let maven = items.iter().find(|i| i.kind == RunKind::Maven).unwrap();
        assert!(maven.install_config.command.ends_with("dependency:resolve"));
        assert!(!maven.missing_installed);

        let rust = items.iter().find(|i| i.kind == RunKind::Rust).unwrap();
        assert_eq!(rust.install_config.command, "cargo fetch");

        let go = items.iter().find(|i| i.kind == RunKind::Go).unwrap();
        assert_eq!(go.install_config.command, "go mod download");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn package_lock_ignores_root_version_but_tracks_dependency_changes() {
        let lock_v1 = r#"{
            "name": "my-app",
            "version": "1.0.0",
            "lockfileVersion": 3,
            "requires": true,
            "packages": {
                "": {
                    "name": "my-app",
                    "version": "1.0.0",
                    "dependencies": { "react": "^19.0.0" }
                },
                "node_modules/react": {
                    "version": "19.0.0",
                    "resolved": "https://registry.npmjs.org/react/-/react-19.0.0.tgz"
                }
            }
        }"#;

        // 仅修改顶层 version 与 packages[""].version
        let lock_v2 = r#"{
            "name": "my-app",
            "version": "1.0.1",
            "lockfileVersion": 3,
            "requires": true,
            "packages": {
                "": {
                    "name": "my-app",
                    "version": "1.0.1",
                    "dependencies": { "react": "^19.0.0" }
                },
                "node_modules/react": {
                    "version": "19.0.0",
                    "resolved": "https://registry.npmjs.org/react/-/react-19.0.0.tgz"
                }
            }
        }"#;

        // 修改第三方依赖版本
        let lock_v3 = r#"{
            "name": "my-app",
            "version": "1.0.1",
            "lockfileVersion": 3,
            "requires": true,
            "packages": {
                "": {
                    "name": "my-app",
                    "version": "1.0.1",
                    "dependencies": { "react": "^19.0.1" }
                },
                "node_modules/react": {
                    "version": "19.0.1",
                    "resolved": "https://registry.npmjs.org/react/-/react-19.0.1.tgz"
                }
            }
        }"#;

        let crc1 = package_lock_semantic_crc32(lock_v1.as_bytes());
        let crc2 = package_lock_semantic_crc32(lock_v2.as_bytes());
        let crc3 = package_lock_semantic_crc32(lock_v3.as_bytes());

        assert_eq!(crc1, crc2, "仅修改 package-lock.json 的项目自身版本号时 CRC32 应保持不变");
        assert_ne!(crc1, crc3, "修改第三方依赖版本时 package-lock.json 的 CRC32 必须改变");

        // 集成探测测试
        let dir = temp_project("npm-lock-test");
        write(&dir, "package.json", r#"{"name":"my-app","version":"1.0.0","dependencies":{"react":"^19.0.0"}}"#);
        write(&dir, "package-lock.json", lock_v1);
        write(&dir, "node_modules/.package-lock.json", "{}");

        let items1 = dep_sync_probe_impl(&dir.to_string_lossy());
        let npm1 = items1.iter().find(|i| i.id == "npm::package.json").unwrap();
        let pkg_crc_before = npm1.files_crc["package.json"];
        let lock_crc_before = npm1.files_crc["package-lock.json"];

        // 模拟 npm version patch：同时修改 package.json 和 package-lock.json 的版本号
        write(&dir, "package.json", r#"{"name":"my-app","version":"1.0.1","dependencies":{"react":"^19.0.0"}}"#);
        write(&dir, "package-lock.json", lock_v2);

        let items2 = dep_sync_probe_impl(&dir.to_string_lossy());
        let npm2 = items2.iter().find(|i| i.id == "npm::package.json").unwrap();
        assert_eq!(npm2.files_crc["package.json"], pkg_crc_before, "package.json CRC 保持不变");
        assert_eq!(npm2.files_crc["package-lock.json"], lock_crc_before, "package-lock.json CRC 保持不变");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cargo_toml_ignores_package_version_and_metadata_but_tracks_dependency_changes() {
        let cargo_v1 = r#"
            [package]
            name = "my-crate"
            version = "0.1.0"
            description = "A demo crate"
            authors = ["Alice <alice@example.com>"]
            edition = "2021"

            [dependencies]
            serde = "1.0"
        "#;

        let cargo_v2 = r#"
            [package]
            name = "my-crate"
            version = "0.2.0"
            description = "Updated description"
            authors = ["Bob <bob@example.com>"]
            edition = "2021"

            [dependencies]
            serde = "1.0"
        "#;

        let cargo_v3 = r#"
            [package]
            name = "my-crate"
            version = "0.2.0"
            edition = "2021"

            [dependencies]
            serde = "2.0"
        "#;

        let crc1 = cargo_toml_semantic_crc32(cargo_v1.as_bytes());
        let crc2 = cargo_toml_semantic_crc32(cargo_v2.as_bytes());
        let crc3 = cargo_toml_semantic_crc32(cargo_v3.as_bytes());

        assert_eq!(crc1, crc2, "仅修改 Cargo.toml [package] 版本号及元数据时 CRC32 应保持不变");
        assert_ne!(crc1, crc3, "修改 Cargo.toml [dependencies] 依赖版本时 CRC32 必须改变");

        // Workspace 支持测试
        let ws_v1 = r#"
            [workspace]
            members = ["crates/*"]

            [workspace.package]
            version = "1.0.0"
            authors = ["Alice"]

            [workspace.dependencies]
            serde = "1.0"
        "#;
        let ws_v2 = r#"
            [workspace]
            members = ["crates/*"]

            [workspace.package]
            version = "1.0.1"
            authors = ["Alice", "Bob"]

            [workspace.dependencies]
            serde = "1.0"
        "#;
        let ws_v3 = r#"
            [workspace]
            members = ["crates/*"]

            [workspace.package]
            version = "1.0.1"

            [workspace.dependencies]
            serde = "2.0"
        "#;

        assert_eq!(
            cargo_toml_semantic_crc32(ws_v1.as_bytes()),
            cargo_toml_semantic_crc32(ws_v2.as_bytes()),
            "修改 [workspace.package] 的 version 不影响语义 CRC32"
        );
        assert_ne!(
            cargo_toml_semantic_crc32(ws_v1.as_bytes()),
            cargo_toml_semantic_crc32(ws_v3.as_bytes()),
            "修改 [workspace.dependencies] 的版本必须影响语义 CRC32"
        );

        // 集成探测测试
        let dir = temp_project("cargo-test");
        write(&dir, "Cargo.toml", cargo_v1);

        let items1 = dep_sync_probe_impl(&dir.to_string_lossy());
        let rust1 = items1.iter().find(|i| i.id == "rust::Cargo.toml").unwrap();
        let cargo_crc_before = rust1.files_crc["Cargo.toml"];

        write(&dir, "Cargo.toml", cargo_v2);
        let items2 = dep_sync_probe_impl(&dir.to_string_lossy());
        let rust2 = items2.iter().find(|i| i.id == "rust::Cargo.toml").unwrap();
        assert_eq!(rust2.files_crc["Cargo.toml"], cargo_crc_before, "修改 Cargo.toml 版本号不改变 CRC");

        write(&dir, "Cargo.toml", cargo_v3);
        let items3 = dep_sync_probe_impl(&dir.to_string_lossy());
        let rust3 = items3.iter().find(|i| i.id == "rust::Cargo.toml").unwrap();
        assert_ne!(rust3.files_crc["Cargo.toml"], cargo_crc_before, "修改 Cargo.toml 依赖版本必须改变 CRC");

        fs::remove_dir_all(&dir).unwrap();
    }
}
