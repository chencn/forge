//! 语言服务配置。独立一份 `lsp.json`，与 `settings.json` 同目录，整表落盘。
//!
//! 默认表在这里，不在前端：文件本身就是全貌，手改的人不用再去代码里翻缺省值。
//! 读写都归一化一遍，非法档位在前端拿不到。

use crate::error::{err, err_parts};
use crate::offload::{block, block_value};
use crate::sys::write_atomic;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::SystemTime;
use tauri::{AppHandle, Manager};

/// 锁被另一侧 panic 弄脏也要继续读配置。
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 读一次配置的真实代价：读盘 + 解析二十个 server + 逐项归一化，约四百次分配。
/// 而起一趟会话前要 `sweep` 读一遍、探测一轮读一遍、前端每次解析根读一遍——
/// 全是同一个文件。按修改时间缓存，写回时同步更新。
type ConfigCache = Mutex<Option<(PathBuf, Option<Fingerprint>, LspConfig)>>;

/// 文件的「改没改」凭据：改动时间 + 字节数。只看时间不够——exFAT 和网络盘的粒度是 2 秒，
/// 同一格里手改完的文件会被判成没改，缓存一直回改前那份，下一次保存还顺手把用户手改的覆盖掉。
type Fingerprint = (Option<SystemTime>, u64);

fn fingerprint(path: &Path) -> Option<Fingerprint> {
    let meta = fs::metadata(path).ok()?;
    Some((meta.modified().ok(), meta.len()))
}

fn config_cache() -> &'static ConfigCache {
    static CACHE: OnceLock<ConfigCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// 语言服务配置的文件名。
const LSP_FILE: &str = "lsp.json";
/// 旧配置所在的那份通用设置，只为一次性迁移而读。
const SETTINGS_FILE: &str = "settings.json";

/// 一个语言服务的配置。键是 `servers` 里的 server 名（`typescript` / `rust-analyzer` / …）。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct LspServerConfig {
    /// off 全关 / builtin 用应用预置的那条服务 / lsp 用用户自己填的那条。启用与关闭只看这一项。
    /// 编辑器是 CodeMirror，两档起的都是同一个外部进程，区别只在「命令谁配的」与缺省档位。
    pub mode: String,
    /// 在 PATH 里找的那个可执行文件名。
    pub program: String,
    /// 用户填的绝对路径；空串表示用探测结果。
    pub path: String,
    /// 启动参数，一行文本，含空格的片段用双引号包住；拆分在 `lsp.rs::parse_args`。
    pub args: String,
    /// 这个 server 管哪些语言 id。一个 server 可管多个（ts 管 typescript 与 javascript）。
    pub languages: Vec<String>,
    /// 技术栈标志文件名，认工程根用。支持 `*.csproj` 这类后缀通配。
    pub root_markers: Vec<String>,
    /// 一键安装要跑的那行命令；空串表示没有（跟着语言工具链一起装，比如 sourcekit-lsp）。
    pub install_command: String,
    /// initialize 握手的超时（毫秒）。JVM 系那两个给到 120000，其余 30000。
    pub startup_timeout_ms: u64,
    /// 交给 server 的 initializationOptions；null 表示不传。
    pub init_options: serde_json::Value,
    /// 是否允许 `builtin` 档。只有 ts 系有这一档可退（起的仍是本机装的 typescript-language-server）。
    pub supports_builtin: bool,
}

/// 整份语言服务配置。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct LspConfig {
    pub version: u32,
    /// 跨 server 与工程根的进程总数上限；超了按最近最少用淘汰。0 按缺省算。
    pub max_sessions: usize,
    /// 多久没读写就回收会话（分钟）。0 按缺省算。
    pub idle_timeout_min: u64,
    /// 键是 server 名。用 `BTreeMap` 让键有序，同一份配置每次写出的字节一样。
    /// 结构体上的 `rename_all = "camelCase"` 只改字段名，不能碰 map 的键。
    pub servers: BTreeMap<String, LspServerConfig>,
}

/// 三档里合法的那些。`builtin` 只在允许内置语义的 server 上算合法。
fn allowed_modes(supports_builtin: bool) -> &'static [&'static str] {
    if supports_builtin {
        &["off", "builtin", "lsp"]
    } else {
        &["off", "lsp"]
    }
}

fn install(windows: &str, macos: &str, linux: &str) -> String {
    if cfg!(windows) {
        windows.to_string()
    } else if cfg!(target_os = "macos") {
        macos.to_string()
    } else {
        linux.to_string()
    }
}

fn server(
    program: &str,
    args: &str,
    mode: &str,
    languages: &[&str],
    root_markers: &[&str],
    install_command: String,
    startup_timeout_ms: u64,
    supports_builtin: bool,
) -> LspServerConfig {
    LspServerConfig {
        mode: mode.to_string(),
        program: program.to_string(),
        path: String::new(),
        args: args.to_string(),
        languages: languages.iter().map(|item| item.to_string()).collect(),
        root_markers: root_markers.iter().map(|item| item.to_string()).collect(),
        install_command,
        startup_timeout_ms,
        init_options: serde_json::Value::Null,
        supports_builtin,
    }
}

/// 认识的语言服务。加一个语言就往这里加一行。
///
/// typescript 缺省走 `builtin`。编辑器换成 CodeMirror 之后，这一档起的也是表里预置的
/// `typescript-language-server`（Monaco 那份渲染进程里的 tsserver 不再是智能来源），
/// 所以它和 `lsp` 一样要求本机真装着，没装会被探测回退成 `off`。其余语言缺省 `off`。
fn seed() -> BTreeMap<String, LspServerConfig> {
    let mut servers = BTreeMap::new();
    let mut put = |id: &str, config: LspServerConfig| {
        servers.insert(id.to_string(), config);
    };

    put(
        "clangd",
        server(
            "clangd",
            "--background-index",
            "off",
            &["c", "cpp"],
            &["compile_commands.json", "CMakeLists.txt", "meson.build"],
            install(
                "winget install LLVM.LLVM || scoop install llvm || choco install llvm",
                "brew install llvm",
                "apt install -y clangd || dnf install -y clang-tools-extra || pacman -S --noconfirm clang",
            ),
            30_000,
            false,
        ),
    );
    put(
        "csharp-ls",
        server(
            "csharp-ls",
            "",
            "off",
            &["csharp"],
            &["*.csproj", "*.sln", "*.fsproj"],
            install(
                "dotnet tool install --global csharp-ls || dotnet tool update --global csharp-ls",
                "dotnet tool install --global csharp-ls || dotnet tool update --global csharp-ls",
                "dotnet tool install --global csharp-ls || dotnet tool update --global csharp-ls",
            ),
            30_000,
            false,
        ),
    );
    put(
        "gopls",
        server(
            "gopls",
            "",
            "off",
            &["go"],
            &["go.mod", "go.work"],
            install(
                "(go env -w GOPROXY=https://goproxy.cn,direct) && go install golang.org/x/tools/gopls@latest",
                "brew install gopls || go install golang.org/x/tools/gopls@latest",
                "go install golang.org/x/tools/gopls@latest || apt install -y gopls",
            ),
            30_000,
            false,
        ),
    );
    put(
        "intelephense",
        server(
            "intelephense",
            "--stdio",
            "off",
            &["php"],
            &["composer.json"],
            install(
                "npm install -g intelephense || pnpm add -g intelephense || yarn global add intelephense",
                "npm install -g intelephense || pnpm add -g intelephense || brew install intelephense",
                "npm install -g intelephense || pnpm add -g intelephense",
            ),
            30_000,
            false,
        ),
    );
    put(
        "jdtls",
        server(
            "jdtls",
            "",
            "off",
            &["java"],
            &["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle.kts"],
            install(
                "scoop install jdtls || choco install eclipse-jdtls",
                "brew install jdtls",
                "apt install -y eclipse-jdtls || pacman -S --noconfirm jdtls",
            ),
            120_000,
            false,
        ),
    );
    put(
        "kotlin-lsp",
        server(
            "kotlin-language-server",
            "--stdio",
            "off",
            &["kotlin"],
            &["build.gradle.kts", "*.kt"],
            install(
                "scoop install kotlin-language-server || choco install kotlin-language-server",
                "brew install kotlin-language-server",
                "pacman -S --noconfirm kotlin-language-server || snap install kotlin-language-server --classic",
            ),
            120_000,
            false,
        ),
    );
    put(
        "lua-language-server",
        server(
            "lua-language-server",
            "",
            "off",
            &["lua"],
            &[".luarc.json", ".luacheckrc"],
            install(
                "winget install lua-language-server || scoop install lua-language-server",
                "brew install lua-language-server",
                "apt install -y lua-language-server || pacman -S --noconfirm lua-language-server",
            ),
            30_000,
            false,
        ),
    );
    put(
        "pyright",
        server(
            "pyright-langserver",
            "--stdio",
            "off",
            &["python"],
            &[
                "pyproject.toml",
                "setup.py",
                "setup.cfg",
                "requirements.txt",
                "Pipfile",
            ],
            install(
                "npm install -g pyright || pip install pyright",
                "brew install pyright || npm install -g pyright",
                "npm install -g pyright || pipx install pyright",
            ),
            30_000,
            false,
        ),
    );
    put(
        "ruby-lsp",
        server(
            "ruby-lsp",
            "--stdio",
            "off",
            &["ruby"],
            &["Gemfile", "*.gemspec"],
            install(
                "gem install ruby-lsp || gem install --user-install ruby-lsp",
                "gem install ruby-lsp || brew install ruby-lsp",
                "gem install ruby-lsp || apt install -y ruby-lsp",
            ),
            30_000,
            false,
        ),
    );
    put(
        "rust-analyzer",
        server(
            "rust-analyzer",
            "",
            "off",
            &["rust"],
            &["Cargo.toml"],
            install(
                "rustup component add rust-analyzer || cargo install --locked rust-analyzer || winget install Rustlang.Rustup",
                "rustup component add rust-analyzer || brew install rust-analyzer",
                "rustup component add rust-analyzer || apt install -y rust-analyzer || dnf install -y rust-analyzer",
            ),
            30_000,
            false,
        ),
    );
    put(
        "typescript",
        server(
            "typescript-language-server",
            "--stdio",
            "builtin",
            &["typescript", "javascript"],
            &["tsconfig.json", "jsconfig.json", "package.json"],
            install(
                "npm install -g typescript-language-server typescript || pnpm add -g typescript-language-server typescript || yarn global add typescript-language-server typescript",
                "npm install -g typescript-language-server typescript || pnpm add -g typescript-language-server typescript",
                "npm install -g typescript-language-server typescript || pnpm add -g typescript-language-server typescript",
            ),
            30_000,
            true,
        ),
    );

    // Windows 上不列 sourcekit-lsp：附录 B 那句 Windows 支持不成熟在这里落地。
    if !cfg!(windows) {
        put(
            "sourcekit-lsp",
            server(
                "sourcekit-lsp",
                "",
                "off",
                &["swift"],
                &["Package.swift", "*.xcodeproj"],
                String::new(),
                30_000,
                false,
            ),
        );
    }

    servers
}

/// 进程总数上限的缺省。rust-analyzer 单进程实测 500MB 到 1GB，这条是内存兜底。
const DEFAULT_MAX_SESSIONS: usize = 5;
/// 空闲回收阈值的缺省（分钟）。调太小会让重服务器反复付冷启动与重建索引的成本。
const DEFAULT_IDLE_TIMEOUT_MIN: u64 = 30;

impl LspServerConfig {
    /// 真正拿去探测与起进程的那条：用户填了路径就用路径，否则用可执行文件名。
    pub fn effective_program(&self) -> String {
        let path = self.path.trim();
        if path.is_empty() {
            self.program.trim().to_string()
        } else {
            path.to_string()
        }
    }
}

/// 整份缺省配置。
pub fn default_config() -> LspConfig {
    LspConfig {
        version: 1,
        max_sessions: DEFAULT_MAX_SESSIONS,
        idle_timeout_min: DEFAULT_IDLE_TIMEOUT_MIN,
        servers: seed(),
    }
}

/// 把读来的配置对着种子修一遍：缺的 server 用种子补，非法档位与空字段退回种子那一项。
/// 用户自己加的 server（种子里没有的键）保留。
fn normalize(mut config: LspConfig) -> LspConfig {
    let seeds = seed();
    let mut merged: BTreeMap<String, LspServerConfig> = BTreeMap::new();
    for (id, fallback) in &seeds {
        let entry = config.servers.remove(id).unwrap_or_else(|| fallback.clone());
        merged.insert(id.clone(), clamp(entry, fallback));
    }
    for (id, extra) in config.servers {
        // 自填的 server 没有种子可对，档位按它自己声明的 supportsBuiltin 校验，其余字段留原值。
        let fallback = LspServerConfig {
            mode: "off".to_string(),
            startup_timeout_ms: 30_000,
            ..LspServerConfig::default()
        };
        merged.insert(id, clamp(extra, &fallback));
    }
    config.servers = merged;
    if config.version == 0 {
        config.version = 1;
    }
    if config.max_sessions == 0 {
        config.max_sessions = DEFAULT_MAX_SESSIONS;
    }
    if config.idle_timeout_min == 0 {
        config.idle_timeout_min = DEFAULT_IDLE_TIMEOUT_MIN;
    }
    config
}

/// 单个 server 的取值兜底。空串是「没填」，不是「填了个空值」，所以按种子补。
fn clamp(entry: LspServerConfig, fallback: &LspServerConfig) -> LspServerConfig {
    let mode_ok = allowed_modes(entry.supports_builtin).contains(&entry.mode.as_str());
    LspServerConfig {
        mode: if mode_ok { entry.mode } else { fallback.mode.clone() },
        program: non_blank(entry.program, &fallback.program),
        path: entry.path.trim().to_string(),
        args: if entry.args.trim().is_empty() && !fallback.args.trim().is_empty() {
            fallback.args.clone()
        } else {
            entry.args.trim().to_string()
        },
        languages: if entry.languages.is_empty() {
            fallback.languages.clone()
        } else {
            entry.languages
        },
        root_markers: if entry.root_markers.is_empty() {
            fallback.root_markers.clone()
        } else {
            entry.root_markers
        },
        install_command: non_blank(entry.install_command, &fallback.install_command),
        startup_timeout_ms: if entry.startup_timeout_ms == 0 {
            fallback.startup_timeout_ms
        } else {
            entry.startup_timeout_ms
        },
        init_options: entry.init_options,
        supports_builtin: entry.supports_builtin || fallback.supports_builtin,
    }
}

fn non_blank(text: String, fallback: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// 第一轮这份配置住在 `settings.json` 的 `lsp.servers` 里。那里读到的只有档位、路径、参数，
/// 其余字段保持种子值。读不到、解析失败都原样退回种子。
fn migrate_from_settings(settings_path: &Path, base: LspConfig) -> LspConfig {
    let Ok(text) = fs::read_to_string(settings_path) else {
        return base;
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&text) else {
        return base;
    };
    let Some(servers) = root.get("lsp").and_then(|lsp| lsp.get("servers")) else {
        return base;
    };
    let mut config = base;
    for (id, entry) in servers.as_object().into_iter().flat_map(|map| map.iter()) {
        let Some(target) = config.servers.get_mut(id) else {
            continue;
        };
        if let Some(mode) = entry.get("mode").and_then(|value| value.as_str()) {
            target.mode = mode.to_string();
        }
        if let Some(path) = entry.get("path").and_then(|value| value.as_str()) {
            target.path = path.trim().to_string();
        }
        if let Some(args) = entry.get("args").and_then(|value| value.as_str()) {
            target.args = args.trim().to_string();
        }
    }
    normalize(config)
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|error| err("CONFIG_DIR", error))
}

/// 读一个目录下的语言服务配置。没有 `lsp.json` 就先生成一份（顺带迁移同目录旧设置里那一段）
/// 写出去，让文件从第一次启动起就是完整的一表。读坏了退回种子并照样补一份，不让应用起不来。
pub fn load_in(dir: &Path) -> LspConfig {
    let path = dir.join(LSP_FILE);
    let stamp = fingerprint(&path);
    let cache = config_cache();
    if let Some((cached_path, cached_stamp, config)) = &*lock(cache) {
        if cached_path == &path && *cached_stamp == stamp {
            return config.clone();
        }
    }
    let config = load_fresh(dir);
    // 时间要在 `load_fresh` 之后再取：那份逻辑发现文件不在会现写一份出去，
    // 取早了缓存里记的是「没有这个文件」，下一遍又白读一次盘。
    *lock(cache) = Some((path, fingerprint(&dir.join(LSP_FILE)), config.clone()));
    config
}

fn load_fresh(dir: &Path) -> LspConfig {
    let path = dir.join(LSP_FILE);
    if !path.is_file() {
        let base = migrate_from_settings(&dir.join(SETTINGS_FILE), default_config());
        let _ = save_in(dir, base.clone());
        return base;
    }
    match fs::read_to_string(&path)
        .map_err(|error| error.to_string())
        .and_then(|text| serde_json::from_str::<LspConfig>(&text).map_err(|error| error.to_string()))
    {
        Ok(config) => normalize(config),
        Err(_) => {
            let base = default_config();
            let _ = save_in(dir, base.clone());
            base
        }
    }
}

/// 整份写回一个目录下的配置，格式化便于手改。原子写：半截文件会让下一次启动退回种子、
/// 把用户填的全丢掉。
pub fn save_in(dir: &Path, config: LspConfig) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|error| err_parts("IO", &[dir.display().to_string(), error.to_string()]))?;
    let normalized = normalize(config);
    let text = serde_json::to_string_pretty(&normalized).map_err(|error| err("IO", error))?;
    write_atomic(&dir.join(LSP_FILE), &text)?;
    // 缓存跟着这份走：文件系统的时间戳粒度可能比这次写入还粗，靠时间去失效会读到旧的一份。
    let path = dir.join(LSP_FILE);
    *lock(config_cache()) = Some((path.clone(), fingerprint(&path), normalized));
    Ok(())
}

/// 读配置；拿不到配置目录就退回缺省表，不让界面或后端卡在没配置上。
pub fn load(app: &AppHandle) -> LspConfig {
    match config_dir(app) {
        Ok(dir) => load_in(&dir),
        Err(_) => default_config(),
    }
}

/// 写配置到系统配置目录。
pub fn save(app: &AppHandle, config: &LspConfig) -> Result<(), String> {
    save_in(&config_dir(app)?, config.clone())
}

/// 一次探测里一个 server 的结果。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LspServerProbe {
    pub id: String,
    /// 探测用的那条命令名或路径（用户填过路径就是路径）。
    pub program: String,
    pub installed: bool,
    /// 命中的完整路径；没装着是空串。
    pub path: String,
}

/// 探测的完整回报：每一项的结果，加上可能被单向校正过的那份配置。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LspProbeReport {
    pub config: LspConfig,
    pub servers: Vec<LspServerProbe>,
}

/// 读语言服务配置。
#[tauri::command]
pub async fn lsp_config_load(app: AppHandle) -> LspConfig {
    block_value(move || load(&app), default_config).await
}

/// 整份写回语言服务配置。
#[tauri::command]
pub async fn lsp_config_save(app: AppHandle, config: LspConfig) -> Result<(), String> {
    block(move || save(&app, &config)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `servers` 的键带着连字符，`rename_all` 只能改字段名，不能把键改写下划线。
    #[test]
    fn server_keys_survive_round_trip() {
        let config = default_config();
        let text = serde_json::to_string(&config).unwrap();
        assert!(text.contains("\"rust-analyzer\""), "键被改名了：{text}");
        assert!(text.contains("\"lua-language-server\""), "键被改名了：{text}");

        let back: LspConfig = serde_json::from_str(&text).unwrap();
        assert_eq!(back.servers["rust-analyzer"].program, "rust-analyzer");
        assert_eq!(back.servers["typescript"].mode, "builtin");
    }

    /// 手改文件把不支持内置语义的 server 写成 builtin，要退回它自己的缺省档位。
    #[test]
    fn illegal_mode_falls_back() {
        let mut config = default_config();
        config.servers.get_mut("gopls").unwrap().mode = "builtin".to_string();
        let fixed = normalize(config);
        assert_eq!(fixed.servers["gopls"].mode, "off");
    }

    /// 只填了档位、别的都空着，其余字段要按种子补回来（`args` 是 server 自己必需的）。
    #[test]
    fn blank_fields_take_seed_values() {
        let mut config = default_config();
        let entry = config.servers.get_mut("pyright").unwrap();
        entry.mode = "lsp".to_string();
        entry.args.clear();
        entry.program.clear();
        entry.root_markers.clear();
        let fixed = normalize(config);
        let pyright = &fixed.servers["pyright"];
        assert_eq!(pyright.mode, "lsp");
        assert_eq!(pyright.args, "--stdio");
        assert_eq!(pyright.program, "pyright-langserver");
        assert!(!pyright.root_markers.is_empty());
    }

    /// 种子里没有的键保留，用户自填的 server 不该被抹掉。
    #[test]
    fn custom_server_keys_are_kept() {
        let mut config = default_config();
        config.servers.insert(
            "my-lsp".to_string(),
            LspServerConfig {
                mode: "lsp".to_string(),
                program: "my-lsp".to_string(),
                languages: vec!["mylang".to_string()],
                startup_timeout_ms: 30_000,
                ..LspServerConfig::default()
            },
        );
        let before = config.servers.len();
        let fixed = normalize(config);
        assert_eq!(fixed.servers["my-lsp"].program, "my-lsp");
        assert_eq!(fixed.servers.len(), before);
    }

    /// 旧 `settings.json` 里那一段读进种子表；读不懂就原样退回种子。
    #[test]
    fn migrate_reads_old_lsp_section() {
        let text = r#"{"theme":"dark","lsp":{"servers":{"gopls":{"mode":"lsp","path":" C:\\gopls ","args":""}}}}"#;
        let dir = std::env::temp_dir().join(format!("forge-lsp-migrate-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(SETTINGS_FILE);
        fs::write(&path, text).unwrap();

        let migrated = migrate_from_settings(&path, default_config());
        let gopls = &migrated.servers["gopls"];
        assert_eq!(gopls.mode, "lsp");
        assert_eq!(gopls.path, "C:\\gopls");
        assert_eq!(migrated.servers["typescript"].mode, "builtin");

        let broken = dir.join("settings-broken.json");
        fs::write(&broken, "{ not json").unwrap();
        assert_eq!(migrate_from_settings(&broken, default_config()), default_config());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 配置里读回来的档位已经合法，界面不用再校验一遍。
    #[test]
    fn seed_modes_are_all_allowed() {
        for (id, entry) in default_config().servers {
            assert!(
                allowed_modes(entry.supports_builtin).contains(&entry.mode.as_str()),
                "{id} 的缺省档位不合法"
            );
        }
    }

    /// 每个测试独占一个临时目录，跑完就删。
    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::UNIX_EPOCH
            .elapsed()
            .map(|since| since.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("forge-lsp-{name}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 第一次读就把整张种子表写出来：文件本身就是完整的一表，手改的人不用再去代码里翻缺省值。
    #[test]
    fn first_load_writes_full_seed() {
        let dir = temp_dir("create");
        let config = load_in(&dir);
        assert_eq!(config.servers, default_config().servers);
        let path = dir.join(LSP_FILE);
        assert!(path.is_file(), "没有生成 {LSP_FILE}");
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("typescript-language-server"), "落盘的不是完整表：{text}");
        assert!(text.contains("\"rootMarkers\""), "种子字段没落盘：{text}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 同目录旧 `settings.json` 里那一段在生成文件时并进来。
    #[test]
    fn first_load_migrates_sibling_settings() {
        let dir = temp_dir("migrate-in-place");
        fs::write(
            dir.join(SETTINGS_FILE),
            r#"{"theme":"dark","lsp":{"servers":{"gopls":{"mode":"lsp","path":"C:\\gopls.exe"}}}}"#,
        )
        .unwrap();
        let config = load_in(&dir);
        assert_eq!(config.servers["gopls"].mode, "lsp");
        assert_eq!(config.servers["gopls"].path, "C:\\gopls.exe");
        assert_eq!(config.servers["typescript"].mode, "builtin");
        assert!(dir.join(LSP_FILE).is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 手改坏的文件不该把应用带崩：退回种子，同时重新写一份能用的。
    #[test]
    fn broken_file_is_replaced() {
        let dir = temp_dir("broken");
        let path = dir.join(LSP_FILE);
        fs::write(&path, "{ not json").unwrap();
        let config = load_in(&dir);
        assert_eq!(config.servers, default_config().servers);
        let back: LspConfig = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back.servers["typescript"].mode, "builtin");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 写出去的档位已归一化：非法值在落盘那一刻就被改成合法值，读回来不必再防。
    #[test]
    fn save_normalizes_before_writing() {
        let dir = temp_dir("normalize-on-save");
        let mut config = default_config();
        config.servers.get_mut("jdtls").unwrap().mode = "builtin".to_string();
        save_in(&dir, config).unwrap();
        let back = load_in(&dir);
        assert_eq!(back.servers["jdtls"].mode, "off");
        let _ = fs::remove_dir_all(&dir);
    }
}
