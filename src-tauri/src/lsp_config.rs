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
    /// 一键卸载要跑的那行命令；空串表示没有可靠的卸载路径（brew/apt/go install 装的不在这条链里）。
    pub uninstall_command: String,
    /// initialize 握手的超时（毫秒）。JVM 系那两个给到 120000，其余 30000。
    pub startup_timeout_ms: u64,
    /// 交给 server 的 initializationOptions；null 表示不传。
    pub init_options: serde_json::Value,
    /// 是否允许 `builtin` 档。只有 ts 系有这一档可退（起的仍是本机装的 typescript-language-server）。
    pub supports_builtin: bool,
    /// 服务主页；设置页详情头部展示。
    pub homepage: String,
    /// 没有受管安装命令时的官方安装提示；空串表示没有（有 installCommand 就不需要）。
    pub install_hint: String,
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

fn base_server() -> LspServerConfig {
    LspServerConfig {
        mode: "off".to_string(),
        startup_timeout_ms: 30_000,
        ..LspServerConfig::default()
    }
}

/// 认识的语言服务。整表是对标 IDE 语言目录（`languages/*.toml` 的
/// `[[language-servers]]` 并集）的 1:1 抄本：program、args、root markers 与
/// initialization options 逐字取自各语言 toml；安装命令由对标 IDE 受管安装方式
/// （其 tools registry）渲染成三平台命令，没有受管安装的服务留空 `install_command`，
/// 把官方提示写进 `install_hint`。
///
/// 档位：toml 里非 fallback 的主服务缺省 `lsp`，fallback 服务缺省 `off`——Forge
/// 还没有运行时 fallback 机制，两项同开会在同一门语言上双起进程。`godot` 走 TCP
/// connect、`powershell-editor-services` 需要环境变量注入，两条 Forge 暂时起不来，
/// 目录保留但缺省 `off`（偏差记录见 docs/plans/lsp-tools-parity/README.md）。
fn seed() -> BTreeMap<String, LspServerConfig> {
    let mut servers = BTreeMap::new();
    let mut put = |id: &str, config: LspServerConfig| {
        servers.insert(id.to_string(), config);
    };

    put(
        "basedpyright",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "basedpyright-langserver".to_string(),
            args: "--stdio".to_string(),
            languages: vec!["python".to_string()],
            root_markers: vec![
                "pyproject.toml".to_string(),
                "setup.py".to_string(),
                "setup.cfg".to_string(),
                "requirements.txt".to_string(),
                "Pipfile".to_string(),
                "pyrightconfig.json".to_string(),
            ],
            install_command: install(
                "pip install basedpyright || pipx install basedpyright",
                "pip install basedpyright || pipx install basedpyright",
                "pip install basedpyright || pipx install basedpyright",
            ),
            homepage: "https://docs.basedpyright.com".to_string(),
            init_options: serde_json::json!({
                "settings": {
                    "basedpyright": {
                        "analysis": { "typeCheckingMode": "standard", "autoSearchPaths": true }
                    }
                }
            }),
            ..base_server()
        },
    );
    put(
        "pyright",
        LspServerConfig {
            program: "pyright-langserver".to_string(),
            args: "--stdio".to_string(),
            languages: vec!["python".to_string()],
            root_markers: vec![
                "pyproject.toml".to_string(),
                "setup.py".to_string(),
                "setup.cfg".to_string(),
                "requirements.txt".to_string(),
                "Pipfile".to_string(),
                "pyrightconfig.json".to_string(),
            ],
            install_command: install(
                "npm install -g pyright || pip install pyright",
                "brew install pyright || npm install -g pyright",
                "npm install -g pyright || pipx install pyright",
            ),
            homepage: "https://github.com/microsoft/pyright".to_string(),
            ..base_server()
        },
    );
    put(
        "ty",
        LspServerConfig {
            program: "ty".to_string(),
            args: "server".to_string(),
            languages: vec!["python".to_string()],
            root_markers: vec![
                "ty.toml".to_string(),
                "pyproject.toml".to_string(),
                "setup.py".to_string(),
                "setup.cfg".to_string(),
                "requirements.txt".to_string(),
                "Pipfile".to_string(),
            ],
            install_command: install(
                "uv tool install ty || pip install ty",
                "uv tool install ty || pip install ty",
                "uv tool install ty || pip install ty",
            ),
            homepage: "https://docs.astral.sh/ty/".to_string(),
            ..base_server()
        },
    );
    put(
        "vtsls",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "vtsls".to_string(),
            args: "--stdio".to_string(),
            languages: vec![
                "typescript".to_string(),
                "typescriptreact".to_string(),
                "javascript".to_string(),
                "javascriptreact".to_string(),
            ],
            root_markers: vec![
                "tsconfig.json".to_string(),
                "jsconfig.json".to_string(),
                "package.json".to_string(),
            ],
            install_command: install(
                "npm install -g @vtsls/language-server || pnpm add -g @vtsls/language-server",
                "npm install -g @vtsls/language-server || pnpm add -g @vtsls/language-server",
                "npm install -g @vtsls/language-server || pnpm add -g @vtsls/language-server",
            ),
            homepage: "https://github.com/yioneko/vtsls".to_string(),
            ..base_server()
        },
    );
    put(
        "typescript-language-server",
        LspServerConfig {
            program: "typescript-language-server".to_string(),
            args: "--stdio".to_string(),
            languages: vec![
                "typescript".to_string(),
                "typescriptreact".to_string(),
                "javascript".to_string(),
                "javascriptreact".to_string(),
            ],
            root_markers: vec![
                "tsconfig.json".to_string(),
                "jsconfig.json".to_string(),
                "package.json".to_string(),
            ],
            install_command: install(
                "npm install -g typescript-language-server typescript || pnpm add -g typescript-language-server typescript",
                "npm install -g typescript-language-server typescript || pnpm add -g typescript-language-server typescript",
                "npm install -g typescript-language-server typescript || pnpm add -g typescript-language-server typescript",
            ),
            homepage: "https://github.com/typescript-language-server/typescript-language-server".to_string(),
            supports_builtin: true,
            ..base_server()
        },
    );    put(
        "vscode-json-language-server",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "vscode-json-language-server".to_string(),
            args: "--stdio".to_string(),
            languages: vec!["json".to_string(), "jsonc".to_string()],
            install_command: install(
                "npm install -g vscode-langservers-extracted || pnpm add -g vscode-langservers-extracted",
                "npm install -g vscode-langservers-extracted || pnpm add -g vscode-langservers-extracted",
                "npm install -g vscode-langservers-extracted || pnpm add -g vscode-langservers-extracted",
            ),
            homepage: "https://github.com/hrsh7th/vscode-langservers-extracted".to_string(),
            init_options: serde_json::json!({ "provideFormatter": true }),
            ..base_server()
        },
    );
    put(
        "vscode-css-language-server",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "vscode-css-language-server".to_string(),
            args: "--stdio".to_string(),
            languages: vec!["css".to_string(), "scss".to_string(), "less".to_string()],
            install_command: install(
                "npm install -g vscode-langservers-extracted || pnpm add -g vscode-langservers-extracted",
                "npm install -g vscode-langservers-extracted || pnpm add -g vscode-langservers-extracted",
                "npm install -g vscode-langservers-extracted || pnpm add -g vscode-langservers-extracted",
            ),
            homepage: "https://github.com/hrsh7th/vscode-langservers-extracted".to_string(),
            init_options: serde_json::json!({
                "provideFormatter": true, "css": {}, "scss": {}, "less": {}
            }),
            ..base_server()
        },
    );
    put(
        "vscode-html-language-server",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "vscode-html-language-server".to_string(),
            args: "--stdio".to_string(),
            languages: vec!["html".to_string()],
            install_command: install(
                "npm install -g vscode-langservers-extracted || pnpm add -g vscode-langservers-extracted",
                "npm install -g vscode-langservers-extracted || pnpm add -g vscode-langservers-extracted",
                "npm install -g vscode-langservers-extracted || pnpm add -g vscode-langservers-extracted",
            ),
            homepage: "https://github.com/hrsh7th/vscode-langservers-extracted".to_string(),
            init_options: serde_json::json!({
                "provideFormatter": true,
                "embeddedLanguages": { "css": true, "javascript": true }
            }),
            ..base_server()
        },
    );
    put(
        "bash-language-server",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "bash-language-server".to_string(),
            args: "start".to_string(),
            languages: vec!["shellscript".to_string()],
            install_command: install(
                "npm install -g bash-language-server || pnpm add -g bash-language-server",
                "npm install -g bash-language-server || pnpm add -g bash-language-server",
                "npm install -g bash-language-server || pnpm add -g bash-language-server",
            ),
            homepage: "https://github.com/bash-lsp/bash-language-server".to_string(),
            ..base_server()
        },
    );
    put(
        "yaml-language-server",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "yaml-language-server".to_string(),
            args: "--stdio".to_string(),
            languages: vec!["yaml".to_string()],
            install_command: install(
                "npm install -g yaml-language-server || pnpm add -g yaml-language-server",
                "npm install -g yaml-language-server || pnpm add -g yaml-language-server",
                "npm install -g yaml-language-server || pnpm add -g yaml-language-server",
            ),
            homepage: "https://github.com/redhat-developer/yaml-language-server".to_string(),
            ..base_server()
        },
    );
    put(
        "dockerfile-language-server",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "docker-langserver".to_string(),
            args: "--stdio".to_string(),
            languages: vec!["dockerfile".to_string()],
            install_command: install(
                "npm install -g dockerfile-language-server-nodejs || pnpm add -g dockerfile-language-server-nodejs",
                "npm install -g dockerfile-language-server-nodejs || pnpm add -g dockerfile-language-server-nodejs",
                "npm install -g dockerfile-language-server-nodejs || pnpm add -g dockerfile-language-server-nodejs",
            ),
            homepage: "https://github.com/rcjsuen/dockerfile-language-server".to_string(),
            ..base_server()
        },
    );
    put(
        "svelte-language-server",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "svelteserver".to_string(),
            args: "--stdio".to_string(),
            languages: vec!["svelte".to_string()],
            root_markers: vec![
                "svelte.config.js".to_string(),
                "svelte.config.mjs".to_string(),
                "svelte.config.ts".to_string(),
                "package.json".to_string(),
            ],
            install_command: install(
                "npm install -g svelte-language-server typescript || pnpm add -g svelte-language-server typescript",
                "npm install -g svelte-language-server typescript || pnpm add -g svelte-language-server typescript",
                "npm install -g svelte-language-server typescript || pnpm add -g svelte-language-server typescript",
            ),
            homepage: "https://github.com/sveltejs/language-tools".to_string(),
            ..base_server()
        },
    );
    put(
        "vue-language-server",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "vue-language-server".to_string(),
            args: "--stdio".to_string(),
            languages: vec!["vue".to_string()],
            root_markers: vec![
                "package.json".to_string(),
                "vite.config.ts".to_string(),
                "vite.config.js".to_string(),
                "nuxt.config.ts".to_string(),
                "tsconfig.json".to_string(),
            ],
            install_command: install(
                "npm install -g @vue/language-server typescript || pnpm add -g @vue/language-server typescript",
                "npm install -g @vue/language-server typescript || pnpm add -g @vue/language-server typescript",
                "npm install -g @vue/language-server typescript || pnpm add -g @vue/language-server typescript",
            ),
            homepage: "https://github.com/vuejs/language-tools".to_string(),
            ..base_server()
        },
    );
    put(
        "graphql-lsp",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "graphql-lsp".to_string(),
            args: "server -m stream".to_string(),
            languages: vec!["graphql".to_string()],
            root_markers: vec![
                ".graphqlrc".to_string(),
                ".graphqlrc.yml".to_string(),
                ".graphqlrc.yaml".to_string(),
                ".graphqlrc.json".to_string(),
                "graphql.config.js".to_string(),
                "graphql.config.ts".to_string(),
                "graphql.config.yml".to_string(),
            ],
            install_command: install(
                "npm install -g graphql-language-service-cli || pnpm add -g graphql-language-service-cli",
                "npm install -g graphql-language-service-cli || pnpm add -g graphql-language-service-cli",
                "npm install -g graphql-language-service-cli || pnpm add -g graphql-language-service-cli",
            ),
            homepage: "https://github.com/graphql/graphiql".to_string(),
            ..base_server()
        },
    );
    put(
        "intelephense",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "intelephense".to_string(),
            args: "--stdio".to_string(),
            languages: vec!["php".to_string()],
            root_markers: vec![
                "composer.json".to_string(),
                ".phpactor.json".to_string(),
                "index.php".to_string(),
            ],
            install_command: install(
                "npm install -g intelephense || pnpm add -g intelephense",
                "npm install -g intelephense || pnpm add -g intelephense",
                "npm install -g intelephense || pnpm add -g intelephense",
            ),
            homepage: "https://intelephense.com".to_string(),
            ..base_server()
        },
    );
    put(
        "phpactor",
        LspServerConfig {
            program: "phpactor".to_string(),
            args: "language-server".to_string(),
            languages: vec!["php".to_string()],
            root_markers: vec!["composer.json".to_string(), ".phpactor.json".to_string()],
            homepage: "https://github.com/phpactor/phpactor".to_string(),
            install_hint: "Install phpactor (https://phpactor.readthedocs.io/en/master/usage/standalone.html)".to_string(),
            ..base_server()
        },
    );
    put(
        "clangd",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "clangd".to_string(),
            args: "--background-index --header-insertion=never".to_string(),
            languages: vec![
                "c".to_string(),
                "cpp".to_string(),
                "objective-c".to_string(),
                "objective-cpp".to_string(),
            ],
            root_markers: vec![
                "compile_commands.json".to_string(),
                "compile_flags.txt".to_string(),
                ".clangd".to_string(),
                "CMakeLists.txt".to_string(),
                "meson.build".to_string(),
                "Makefile".to_string(),
            ],
            install_command: install(
                "winget install LLVM.LLVM || scoop install llvm || choco install llvm",
                "brew install llvm",
                "apt install -y clangd || dnf install -y clang-tools-extra || pacman -S --noconfirm clang",
            ),
            homepage: "https://clangd.llvm.org".to_string(),
            ..base_server()
        },
    );
    put(
        "gopls",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "gopls".to_string(),
            languages: vec![
                "go".to_string(),
                "go.mod".to_string(),
                "go.work".to_string(),
            ],
            root_markers: vec!["go.work".to_string(), "go.mod".to_string()],
            install_command: install(
                "go install golang.org/x/tools/gopls@latest",
                "brew install gopls || go install golang.org/x/tools/gopls@latest",
                "go install golang.org/x/tools/gopls@latest || apt install -y gopls",
            ),
            homepage: "https://pkg.go.dev/golang.org/x/tools/gopls".to_string(),
            ..base_server()
        },
    );
    put(
        "rust-analyzer",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "rust-analyzer".to_string(),
            languages: vec!["rust".to_string()],
            root_markers: vec!["Cargo.toml".to_string(), "rust-project.json".to_string()],
            install_command: install(
                "rustup component add rust-analyzer || cargo install --locked rust-analyzer || winget install Rustlang.Rustup",
                "rustup component add rust-analyzer || brew install rust-analyzer",
                "rustup component add rust-analyzer || apt install -y rust-analyzer || dnf install -y rust-analyzer",
            ),
            homepage: "https://rust-analyzer.github.io".to_string(),
            ..base_server()
        },
    );    put(
        "jdtls",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "jdtls".to_string(),
            languages: vec!["java".to_string()],
            root_markers: vec![
                "pom.xml".to_string(),
                "build.gradle".to_string(),
                "build.gradle.kts".to_string(),
                "settings.gradle".to_string(),
                "settings.gradle.kts".to_string(),
                "build.xml".to_string(),
                ".project".to_string(),
            ],
            install_command: install(
                "scoop install jdtls || choco install eclipse-jdtls",
                "brew install jdtls",
                "apt install -y eclipse-jdtls || pacman -S --noconfirm jdtls",
            ),
            homepage: "https://github.com/eclipse-jdtls/eclipse.jdt.ls".to_string(),
            startup_timeout_ms: 120_000,
            init_options: serde_json::json!({
                "bundles": [],
                "extendedClientCapabilities": {
                    "classFileContentsSupport": true,
                    "resolveAdditionalTextEditsSupport": true
                },
                "settings": {
                    "java": {
                        "autobuild": { "enabled": true },
                        "contentProvider": { "preferred": "fernflower" },
                        "maven": { "downloadSources": true, "updateSnapshots": false },
                        "eclipse": { "downloadSources": true },
                        "references": { "includeDecompiledSources": true },
                        "signatureHelp": { "enabled": true },
                        "configuration": { "updateBuildConfiguration": "automatic" },
                        "format": { "insertSpaces": true, "tabSize": 4 },
                        "completion": {
                            "guessMethodArguments": "off",
                            "filteredTypes": [
                                "java.awt.List", "com.sun.*", "sun.*", "jdk.*",
                                "org.graalvm.*", "io.micrometer.shaded.*"
                            ]
                        },
                        "import": {
                            "generatesMetadataFilesAtProjectRoot": false,
                            "exclusions": [
                                "**/node_modules/**", "**/.metadata/**",
                                "**/archetype-resources/**", "**/META-INF/maven/**"
                            ],
                            "maven": { "enabled": true },
                            "gradle": { "enabled": true, "wrapper": { "enabled": true } }
                        }
                    }
                }
            }),
            ..base_server()
        },
    );
    put(
        "kotlin-lsp",
        LspServerConfig {
            program: "kotlin-lsp".to_string(),
            args: "--stdio".to_string(),
            languages: vec!["kotlin".to_string()],
            root_markers: vec![
                "settings.gradle.kts".to_string(),
                "settings.gradle".to_string(),
                "build.gradle.kts".to_string(),
                "build.gradle".to_string(),
                "pom.xml".to_string(),
            ],
            homepage: "https://github.com/Kotlin/kotlin-lsp".to_string(),
            startup_timeout_ms: 120_000,
            install_hint: "Install JetBrains Kotlin LSP: brew install JetBrains/utils/kotlin-lsp (https://github.com/Kotlin/kotlin-lsp)".to_string(),
            ..base_server()
        },
    );
    put(
        "kotlin-language-server",
        LspServerConfig {
            program: "kotlin-language-server".to_string(),
            languages: vec!["kotlin".to_string()],
            root_markers: vec![
                "settings.gradle.kts".to_string(),
                "settings.gradle".to_string(),
                "build.gradle.kts".to_string(),
                "build.gradle".to_string(),
                "pom.xml".to_string(),
            ],
            install_command: install(
                "scoop install kotlin-language-server || choco install kotlin-language-server",
                "brew install kotlin-language-server",
                "pacman -S --noconfirm kotlin-language-server || snap install kotlin-language-server --classic",
            ),
            homepage: "https://github.com/fwcd/kotlin-language-server".to_string(),
            startup_timeout_ms: 120_000,
            ..base_server()
        },
    );
    put(
        "dart",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "dart".to_string(),
            args: "language-server --protocol=lsp".to_string(),
            languages: vec!["dart".to_string()],
            root_markers: vec!["pubspec.yaml".to_string(), "analysis_options.yaml".to_string()],
            homepage: "https://dart.dev/get-dart".to_string(),
            install_hint: "Install the Dart SDK (https://dart.dev/get-dart) or Flutter".to_string(),
            ..base_server()
        },
    );
    put(
        "lua-language-server",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "lua-language-server".to_string(),
            languages: vec!["lua".to_string()],
            root_markers: vec![
                ".luarc.json".to_string(),
                ".luarc.jsonc".to_string(),
                ".luacheckrc".to_string(),
                ".stylua.toml".to_string(),
                "stylua.toml".to_string(),
            ],
            install_command: install(
                "winget install lua-language-server || scoop install lua-language-server",
                "brew install lua-language-server",
                "apt install -y lua-language-server || pacman -S --noconfirm lua-language-server",
            ),
            homepage: "https://luals.github.io".to_string(),
            ..base_server()
        },
    );
    put(
        "clojure-lsp",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "clojure-lsp".to_string(),
            languages: vec!["clojure".to_string()],
            root_markers: vec![
                "deps.edn".to_string(),
                "project.clj".to_string(),
                "shadow-cljs.edn".to_string(),
                "bb.edn".to_string(),
                "build.boot".to_string(),
            ],
            install_command: install(
                "scoop install clojure-lsp || choco install clojure-lsp",
                "brew install clojure-lsp/brew/clojure-lsp",
                "bash -c \"$(curl -fsSL https://raw.githubusercontent.com/clojure-lsp/clojure-lsp/master/cli/install)\"",
            ),
            homepage: "https://clojure-lsp.io".to_string(),
            ..base_server()
        },
    );
    put(
        "neocmakelsp",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "neocmakelsp".to_string(),
            args: "stdio".to_string(),
            languages: vec!["cmake".to_string()],
            root_markers: vec!["CMakeLists.txt".to_string(), "CMakePresets.json".to_string()],
            install_command: install(
                "cargo install neocmakelsp",
                "cargo install neocmakelsp || brew install neocmakelsp",
                "cargo install neocmakelsp",
            ),
            homepage: "https://github.com/Decodetalkers/neocmakelsp".to_string(),
            ..base_server()
        },
    );
    put(
        "cmake-language-server",
        LspServerConfig {
            program: "cmake-language-server".to_string(),
            languages: vec!["cmake".to_string()],
            root_markers: vec!["CMakeLists.txt".to_string(), "CMakePresets.json".to_string()],
            install_command: install(
                "pip install cmake-language-server || pipx install cmake-language-server",
                "pip install cmake-language-server || pipx install cmake-language-server",
                "pip install cmake-language-server || pipx install cmake-language-server",
            ),
            homepage: "https://github.com/regen100/cmake-language-server".to_string(),
            ..base_server()
        },
    );
    put(
        "marksman",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "marksman".to_string(),
            args: "server".to_string(),
            languages: vec!["markdown".to_string()],
            root_markers: vec![".marksman.toml".to_string()],
            install_command: install(
                "winget install ArtemPyanykh.Marksman || scoop install marksman",
                "brew install marksman",
                "mkdir -p ~/.local/bin && curl -fsSL https://github.com/artempyanykh/marksman/releases/latest/download/marksman-linux-x64 -o ~/.local/bin/marksman && chmod +x ~/.local/bin/marksman",
            ),
            homepage: "https://github.com/artempyanykh/marksman".to_string(),
            ..base_server()
        },
    );
    put(
        "texlab",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "texlab".to_string(),
            languages: vec!["latex".to_string()],
            root_markers: vec![
                ".latexmkrc".to_string(),
                "latexmkrc".to_string(),
                ".texlabroot".to_string(),
                "texlabroot".to_string(),
                "Tectonic.toml".to_string(),
            ],
            install_command: install(
                "cargo install --locked texlab",
                "cargo install --locked texlab || brew install texlab",
                "cargo install --locked texlab",
            ),
            homepage: "https://github.com/latex-lsp/texlab".to_string(),
            ..base_server()
        },
    );
    put(
        "haskell-language-server",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "haskell-language-server-wrapper".to_string(),
            args: "--lsp".to_string(),
            languages: vec!["haskell".to_string()],
            root_markers: vec![
                "hie.yaml".to_string(),
                "stack.yaml".to_string(),
                "cabal.project".to_string(),
                "*.cabal".to_string(),
                "package.yaml".to_string(),
            ],
            homepage: "https://github.com/haskell/haskell-language-server".to_string(),
            startup_timeout_ms: 120_000,
            install_hint: "ghcup install hls".to_string(),
            ..base_server()
        },
    );
    put(
        "elixir-ls",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "elixir-ls".to_string(),
            languages: vec!["elixir".to_string()],
            root_markers: vec!["mix.exs".to_string()],
            homepage: "https://github.com/elixir-lsp/elixir-ls".to_string(),
            install_hint: "Install ElixirLS (https://github.com/elixir-lsp/elixir-ls/releases) and expose language_server.sh as `elixir-ls`".to_string(),
            ..base_server()
        },
    );
    put(
        "elp",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "elp".to_string(),
            args: "server".to_string(),
            languages: vec!["erlang".to_string()],
            root_markers: vec![
                "rebar.config".to_string(),
                "erlang.mk".to_string(),
                ".elp.toml".to_string(),
            ],
            homepage: "https://github.com/WhatsApp/erlang-language-platform".to_string(),
            install_hint: "Install Erlang Language Platform (https://github.com/WhatsApp/erlang-language-platform/releases)".to_string(),
            ..base_server()
        },
    );    put(
        "fsautocomplete",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "fsautocomplete".to_string(),
            languages: vec!["fsharp".to_string()],
            root_markers: vec!["*.sln".to_string(), "*.fsproj".to_string(), "global.json".to_string()],
            install_command: install(
                "dotnet tool install --global fsautocomplete || dotnet tool update --global fsautocomplete",
                "dotnet tool install --global fsautocomplete || dotnet tool update --global fsautocomplete",
                "dotnet tool install --global fsautocomplete || dotnet tool update --global fsautocomplete",
            ),
            homepage: "https://github.com/ionide/FsAutoComplete".to_string(),
            ..base_server()
        },
    );
    put(
        "csharp-ls",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "csharp-ls".to_string(),
            languages: vec!["csharp".to_string()],
            root_markers: vec![
                "*.sln".to_string(),
                "*.slnx".to_string(),
                "*.csproj".to_string(),
                "global.json".to_string(),
                "Directory.Build.props".to_string(),
            ],
            install_command: install(
                "dotnet tool install --global csharp-ls || dotnet tool update --global csharp-ls",
                "dotnet tool install --global csharp-ls || dotnet tool update --global csharp-ls",
                "dotnet tool install --global csharp-ls || dotnet tool update --global csharp-ls",
            ),
            homepage: "https://github.com/razzmatazz/csharp-language-server".to_string(),
            ..base_server()
        },
    );
    put(
        "julia-languageserver",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "julia".to_string(),
            args: "--startup-file=no --history-file=no --quiet -e \"using LanguageServer; runserver()\"".to_string(),
            languages: vec!["julia".to_string()],
            root_markers: vec!["Project.toml".to_string(), "JuliaProject.toml".to_string()],
            homepage: "https://github.com/julia-vscode/LanguageServer.jl".to_string(),
            install_hint: "In Julia: ] add LanguageServer".to_string(),
            ..base_server()
        },
    );
    put(
        "groovy-language-server",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "groovy-language-server".to_string(),
            languages: vec!["groovy".to_string()],
            root_markers: vec![
                "build.gradle".to_string(),
                "settings.gradle".to_string(),
                "pom.xml".to_string(),
            ],
            homepage: "https://github.com/GroovyLanguageServer/groovy-language-server".to_string(),
            install_hint: "Build the Groovy Language Server (https://github.com/GroovyLanguageServer/groovy-language-server) and expose it as `groovy-language-server`".to_string(),
            ..base_server()
        },
    );
    put(
        "metals",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "metals".to_string(),
            languages: vec!["scala".to_string()],
            root_markers: vec![
                "build.sbt".to_string(),
                "build.sc".to_string(),
                "build.mill".to_string(),
                "project.scala".to_string(),
                "pom.xml".to_string(),
                "build.gradle".to_string(),
            ],
            homepage: "https://scalameta.org/metals/".to_string(),
            startup_timeout_ms: 120_000,
            install_hint: "cs install metals (Coursier: https://get-coursier.io)".to_string(),
            ..base_server()
        },
    );
    put(
        "nil",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "nil".to_string(),
            languages: vec!["nix".to_string()],
            root_markers: vec![
                "flake.nix".to_string(),
                "default.nix".to_string(),
                "shell.nix".to_string(),
            ],
            homepage: "https://github.com/oxalica/nil".to_string(),
            install_hint: "nix profile install github:oxalica/nil".to_string(),
            ..base_server()
        },
    );
    put(
        "nixd",
        LspServerConfig {
            program: "nixd".to_string(),
            languages: vec!["nix".to_string()],
            root_markers: vec![
                "flake.nix".to_string(),
                "default.nix".to_string(),
                "shell.nix".to_string(),
            ],
            homepage: "https://github.com/nix-community/nixd".to_string(),
            install_hint: "nix profile install nixpkgs#nixd".to_string(),
            ..base_server()
        },
    );
    put(
        "ocamllsp",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "ocamllsp".to_string(),
            languages: vec!["ocaml".to_string(), "ocaml.interface".to_string()],
            root_markers: vec![
                "dune-project".to_string(),
                "dune-workspace".to_string(),
                "*.opam".to_string(),
                "esy.json".to_string(),
                "package.json".to_string(),
            ],
            homepage: "https://github.com/ocaml/ocaml-lsp".to_string(),
            install_hint: "opam install ocaml-lsp-server".to_string(),
            ..base_server()
        },
    );
    put(
        "perlnavigator",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "perlnavigator".to_string(),
            args: "--stdio".to_string(),
            languages: vec!["perl".to_string()],
            install_command: install(
                "npm install -g perlnavigator-server || pnpm add -g perlnavigator-server",
                "npm install -g perlnavigator-server || pnpm add -g perlnavigator-server",
                "npm install -g perlnavigator-server || pnpm add -g perlnavigator-server",
            ),
            homepage: "https://github.com/bscan/PerlNavigator".to_string(),
            ..base_server()
        },
    );
    put(
        "powershell-editor-services",
        LspServerConfig {
            program: "pwsh".to_string(),
            args: "-NoLogo -NoProfile -NonInteractive -Command \"& \\\"$env:PSES_BUNDLE_PATH/PowerShellEditorServices/Start-EditorServices.ps1\\\" -BundledModulesPath $env:PSES_BUNDLE_PATH -LogPath ([IO.Path]::Combine([IO.Path]::GetTempPath(), 'forge-pses.log')) -SessionDetailsPath ([IO.Path]::Combine([IO.Path]::GetTempPath(), 'forge-pses.json')) -FeatureFlags @() -AdditionalModules @() -HostName forge -HostProfileId forge -HostVersion 1.0.0 -Stdio -LogLevel Normal\"".to_string(),
            languages: vec!["powershell".to_string()],
            homepage: "https://github.com/PowerShell/PowerShellEditorServices".to_string(),
            install_hint: "Install PowerShell 7 (pwsh), unzip PowerShellEditorServices.zip (https://github.com/PowerShell/PowerShellEditorServices/releases) and set PSES_BUNDLE_PATH to that folder".to_string(),
            ..base_server()
        },
    );
    put(
        "godot",
        LspServerConfig {
            program: "godot".to_string(),
            args: "--headless --editor --path ${root} --lsp-port ${port}".to_string(),
            languages: vec!["gdscript".to_string()],
            root_markers: vec!["project.godot".to_string()],
            homepage: "https://godotengine.org".to_string(),
            install_hint: "Open the project in the Godot editor; its language server speaks LSP over TCP (127.0.0.1:6005) and is not launched by Forge yet".to_string(),
            ..base_server()
        },
    );
    put(
        "r-languageserver",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "R".to_string(),
            args: "--no-echo -e \"languageserver::run()\"".to_string(),
            languages: vec!["r".to_string()],
            root_markers: vec![
                "DESCRIPTION".to_string(),
                ".Rproj.user".to_string(),
                "renv.lock".to_string(),
            ],
            homepage: "https://github.com/REditorSupport/languageserver".to_string(),
            install_hint: "In R: install.packages(\"languageserver\")".to_string(),
            ..base_server()
        },
    );
    put(
        "ruby-lsp",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "ruby-lsp".to_string(),
            languages: vec!["ruby".to_string()],
            root_markers: vec![
                "Gemfile".to_string(),
                ".ruby-version".to_string(),
                ".rubocop.yml".to_string(),
            ],
            install_command: install(
                "gem install ruby-lsp || gem install --user-install ruby-lsp",
                "gem install ruby-lsp || brew install ruby-lsp",
                "gem install ruby-lsp || apt install -y ruby-lsp",
            ),
            homepage: "https://shopify.github.io/ruby-lsp".to_string(),
            ..base_server()
        },
    );
    put(
        "solargraph",
        LspServerConfig {
            program: "solargraph".to_string(),
            args: "stdio".to_string(),
            languages: vec!["ruby".to_string()],
            root_markers: vec!["Gemfile".to_string(), ".solargraph.yml".to_string()],
            install_command: install(
                "gem install solargraph || gem install --user-install solargraph",
                "gem install solargraph || brew install solargraph",
                "gem install solargraph || apt install -y solargraph",
            ),
            homepage: "https://solargraph.org".to_string(),
            ..base_server()
        },
    );
    put(
        "sqls",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "sqls".to_string(),
            languages: vec!["sql".to_string()],
            install_command: install(
                "go install github.com/sqls-server/sqls@latest",
                "go install github.com/sqls-server/sqls@latest",
                "go install github.com/sqls-server/sqls@latest",
            ),
            homepage: "https://github.com/sqls-server/sqls".to_string(),
            ..base_server()
        },
    );
    put(
        "buf",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "buf".to_string(),
            args: "lsp serve".to_string(),
            languages: vec!["proto".to_string()],
            root_markers: vec![
                "buf.yaml".to_string(),
                "buf.work.yaml".to_string(),
                "buf.gen.yaml".to_string(),
            ],
            install_command: install(
                "scoop install buf || go install github.com/bufbuild/buf/cmd/buf@latest",
                "brew install bufbuild/buf/buf",
                "curl -fsSL https://buf.build/install.sh | bash",
            ),
            homepage: "https://buf.build".to_string(),
            ..base_server()
        },
    );
    put(
        "terraform-ls",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "terraform-ls".to_string(),
            args: "serve".to_string(),
            languages: vec!["terraform".to_string(), "terraform-vars".to_string()],
            root_markers: vec![
                ".terraform".to_string(),
                ".terraform.lock.hcl".to_string(),
            ],
            install_command: install(
                "scoop install terraform-ls",
                "brew install hashicorp/tap/terraform-ls",
                "snap install terraform-ls",
            ),
            homepage: "https://github.com/hashicorp/terraform-ls".to_string(),
            ..base_server()
        },
    );
    put(
        "taplo",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "taplo".to_string(),
            args: "lsp stdio".to_string(),
            languages: vec!["toml".to_string()],
            install_command: install(
                "cargo install taplo-cli --locked --features lsp || npm install -g @taplo/cli",
                "cargo install taplo-cli --locked --features lsp || brew install taplo",
                "cargo install taplo-cli --locked --features lsp || npm install -g @taplo/cli",
            ),
            homepage: "https://taplo.tamasfe.dev".to_string(),
            ..base_server()
        },
    );
    put(
        "lemminx",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "lemminx".to_string(),
            languages: vec!["xml".to_string()],
            homepage: "https://github.com/eclipse/lemminx".to_string(),
            install_hint: "Install LemMinX (https://github.com/redhat-developer/vscode-xml/releases, binary `lemminx`)".to_string(),
            ..base_server()
        },
    );
    put(
        "zls",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "zls".to_string(),
            languages: vec!["zig".to_string()],
            root_markers: vec!["build.zig".to_string(), "build.zig.zon".to_string()],
            homepage: "https://github.com/zigtools/zls".to_string(),
            install_hint: "Install ZLS matching your Zig version (https://github.com/zigtools/zls/releases)".to_string(),
            ..base_server()
        },
    );
    put(
        "sourcekit-lsp",
        LspServerConfig {
            mode: "lsp".to_string(),
            program: "sourcekit-lsp".to_string(),
            languages: vec!["swift".to_string()],
            root_markers: vec![
                "Package.swift".to_string(),
                "buildServer.json".to_string(),
                "compile_commands.json".to_string(),
                ".sourcekit-lsp".to_string(),
            ],
            homepage: "https://www.swift.org/install".to_string(),
            install_hint: "Ships with the Swift toolchain / Xcode (xcrun sourcekit-lsp); https://www.swift.org/install".to_string(),
            ..base_server()
        },
    );

    servers
}

/// 从规整的安装命令推导卸载命令；认不出的包管理器（winget/brew/apt/go/scoop/snap/curl）
/// 返回空串——没有可靠卸载路径就如实不给按钮，不猜。
fn derive_uninstall(install: &str) -> String {
    let line = install.trim();
    let first = line.split(" || ").next().unwrap_or("").trim();
    let package = first
        .strip_prefix("npm install -g ")
        .or_else(|| first.strip_prefix("pip install "))
        .or_else(|| first.strip_prefix("gem install "))
        .or_else(|| first.strip_prefix("dotnet tool install --global "))
        .and_then(|rest| rest.split_whitespace().next())
        .map(str::to_string);
    if let Some(package) = package {
        return if let Some(component) = first.strip_prefix("rustup component add ") {
            format!("rustup component remove {}", component.split_whitespace().next().unwrap_or(""))
        } else if let Some(crate_name) = first.strip_prefix("cargo install") {
            let name = crate_name
                .split_whitespace()
                .filter(|token| !token.starts_with('-'))
                .next_back()
                .unwrap_or("");
            if name.is_empty() { String::new() } else { format!("cargo uninstall {name}") }
        } else if first.starts_with("dotnet tool install") {
            format!("dotnet tool uninstall --global {package}")
        } else if first.starts_with("npm install") {
            format!("npm uninstall -g {package}")
        } else if first.starts_with("gem install") {
            format!("gem uninstall -x {package}")
        } else {
            format!("pip uninstall -y {package} || pipx uninstall {package}")
        };
    }
    String::new()
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
        servers: {
            let mut servers = seed();
            for entry in servers.values_mut() {
                entry.uninstall_command = derive_uninstall(&entry.install_command);
            }
            servers
        },
    }
}

/// 目录 1:1 对齐后的旧 id 处置：改名把用户改过的档位/路径带到新 id 下。
/// 旧版曾下架过的 dart、metals 等服务随 1:1 目录回归种子表，不再删除。
const RENAMED_SERVERS: &[(&str, &str)] = &[
    ("typescript", "typescript-language-server"),
    ("kotlin-lsp", "kotlin-language-server"),
    ("docker-langserver", "dockerfile-language-server"),
];

fn migrate_legacy_ids(config: &mut LspConfig) {
    for (old, new) in RENAMED_SERVERS {
        if let Some(entry) = config.servers.remove(*old) {
            config.servers.entry((*new).to_string()).or_insert(entry);
        }
    }
}

/// 把读来的配置对着种子修一遍：缺的 server 用种子补，非法档位与空字段退回种子那一项。
/// 用户自己加的 server（种子里没有的键）保留。
fn normalize(mut config: LspConfig) -> LspConfig {
    migrate_legacy_ids(&mut config);
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
        uninstall_command: if entry.uninstall_command.trim().is_empty() {
            fallback.uninstall_command.clone()
        } else {
            entry.uninstall_command.trim().to_string()
        },
        startup_timeout_ms: if entry.startup_timeout_ms == 0 {
            fallback.startup_timeout_ms
        } else {
            entry.startup_timeout_ms
        },
        init_options: entry.init_options,
        supports_builtin: entry.supports_builtin || fallback.supports_builtin,
        homepage: non_blank(entry.homepage, &fallback.homepage),
        install_hint: non_blank(entry.install_hint, &fallback.install_hint),
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
/// 整份缺省配置；设置页「恢复默认」从这取种子，与 lsp.json 解耦。
#[tauri::command]
pub async fn lsp_config_defaults() -> LspConfig {
    default_config()
}

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
        assert_eq!(back.servers["vtsls"].mode, "lsp");
    }

    /// 手改文件把不支持内置语义的 server 写成 builtin，要退回它自己的缺省档位。
    #[test]
    fn illegal_mode_falls_back() {
        let mut config = default_config();
        config.servers.get_mut("gopls").unwrap().mode = "builtin".to_string();
        let fixed = normalize(config);
        // gopls 是目录 1:1 后的主服务，种子缺省档位是 `lsp`：非法档位退回种子值。
        assert_eq!(fixed.servers["gopls"].mode, "lsp");
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

    /// 目录 1:1 对齐后的旧 id：改名的把用户改动带到新 id；曾下架的服务随 1:1
    /// 目录回归种子表，档位按种子补齐，不会以幽灵空条目的形式复活。
    #[test]
    fn legacy_ids_are_renamed_or_dropped() {
        let mut config = default_config();
        // 旧版落盘的文件里有旧键、没有新键：正是改名迁移要接管的场景。
        config.servers.remove("vtsls");
        config.servers.insert("typescript".to_string(), LspServerConfig {
            mode: "off".to_string(),
            startup_timeout_ms: 30_000,
            ..LspServerConfig::default()
        });
        config.servers.insert("my-lsp".to_string(), LspServerConfig {
            mode: "lsp".to_string(),
            program: "my-lsp".to_string(),
            languages: vec!["mylang".to_string()],
            startup_timeout_ms: 30_000,
            ..LspServerConfig::default()
        });
        let fixed = normalize(config);
        assert_eq!(fixed.servers["typescript-language-server"].mode, "off");
        assert!(fixed.servers.get("typescript").is_none(), "旧键不该残留");
        assert_eq!(fixed.servers["metals"].mode, "lsp", "回归种子的服务要有缺省档位");
        assert_eq!(fixed.servers["dart"].mode, "lsp");
        assert_eq!(fixed.servers["my-lsp"].program, "my-lsp", "真正自填的不受影响");
    }

    /// 目录 1:1：种子就是对标 IDE 语言目录的服务并集；关键字一个都不能少。
    #[test]
    fn seed_matches_reference_catalog() {
        let servers = default_config().servers;
        assert_eq!(servers.len(), 53, "服务并集应当有 53 项");
        for id in [
            "basedpyright", "pyright", "ty", "vtsls", "typescript-language-server",
            "vscode-json-language-server", "vscode-css-language-server", "vscode-html-language-server",
            "bash-language-server", "yaml-language-server", "dockerfile-language-server",
            "svelte-language-server", "vue-language-server", "graphql-lsp", "intelephense",
            "phpactor", "clangd", "gopls", "rust-analyzer", "jdtls", "kotlin-lsp",
            "kotlin-language-server", "dart", "lua-language-server", "clojure-lsp",
            "neocmakelsp", "cmake-language-server", "marksman", "texlab",
            "haskell-language-server", "elixir-ls", "elp", "fsautocomplete", "csharp-ls",
            "julia-languageserver", "groovy-language-server", "metals", "nil", "nixd",
            "ocamllsp", "perlnavigator", "powershell-editor-services", "godot",
            "r-languageserver", "ruby-lsp", "solargraph", "sqls", "buf", "terraform-ls",
            "taplo", "lemminx", "zls", "sourcekit-lsp",
        ] {
            assert!(servers.contains_key(id), "种子缺 {id}");
        }
    }

    /// 没有受管安装命令的服务必须带官方安装提示，UI 的手动安装提示才有内容。
    #[test]
    fn manual_servers_have_install_hint() {
        for (id, entry) in default_config().servers {
            if entry.install_command.is_empty() {
                assert!(!entry.install_hint.is_empty(), "{id} 没有安装提示");
            }
        }
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
        assert_eq!(migrated.servers["vtsls"].mode, "lsp");

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
        assert_eq!(config.servers["vtsls"].mode, "lsp");
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
        assert_eq!(back.servers["vtsls"].mode, "lsp");
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
        assert_eq!(back.servers["jdtls"].mode, "lsp");
        let _ = fs::remove_dir_all(&dir);
    }
}
