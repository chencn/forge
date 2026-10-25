//! Claude Code / Codex 的安装管理。仅运行版本探测和固定管理命令，不建立对话。
mod latest;
pub(crate) mod process;
pub mod codex_catalog;
pub mod mcp;
pub mod providers;
pub mod settings;
pub mod skills;

use crate::offload::block;
use process::{checked, command};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// 官方 npm registry。安装与更新只认它，镜像只用来查版本号。
const NPM_REGISTRY: &str = "https://registry.npmjs.org";
/// 安装/检测的全局互斥。同一时刻只允许一个管理操作，避免两个 npm 进程改同一份全局目录。
static BUSY: AtomicBool = AtomicBool::new(false);
/// 是否有管理操作正在进行；AI 会话启动前据此避让。
pub(crate) fn management_busy() -> bool { BUSY.load(Ordering::Acquire) }

/// 所有会启动 CLI 或修改 CLI 安装的入口先抢这把跨进程门闩；只尝试，不在生命周期锁内等待。
pub(crate) struct RuntimeGate {
    _lock: crate::sys::ExclusiveFileLock,
}
pub(crate) fn runtime_gate(app: &AppHandle) -> Result<RuntimeGate, String> {
    let root = app.path().app_local_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    crate::sys::ExclusiveFileLock::try_acquire(&root.join("ai-cli-management.lock"))?
        .map(|lock| RuntimeGate { _lock: lock })
        .ok_or_else(|| "CLI 管理进行中，请稍后重试".into())
}

/// 管理操作把所有空闲会话租约一并持住：门闩挡新启动，会话锁识别已在其他 Forge 进程运行的任务。
fn lock_idle_sessions(app: &AppHandle) -> Result<Vec<crate::sys::ExclusiveFileLock>, String> {
    let base = app.path().app_local_data_dir().map_err(|error| error.to_string())?.join("ai-sessions-v1");
    let entries = match fs::read_dir(&base) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut locks = Vec::new();
    for entry in entries.take(20_000) {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().map_err(|error| error.to_string())?.is_file() { continue; }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".lock") else { continue; };
        if id.is_empty() || id.len() > 80 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') { continue; }
        match crate::sys::ExclusiveFileLock::try_acquire(&entry.path())? {
            Some(lock) => locks.push(lock),
            None => return Err("请先停止其他 Forge 窗口中的 AI 对话，再修改 CLI 安装".into()),
        }
    }
    Ok(locks)
}

/// 两个受支持的 CLI。序列化成小写字符串，直接对应前端的 provider 值。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider { Claude, Codex }
impl Provider {
    /// 命令行里可执行文件的基名。
    fn program(self) -> &'static str { match self { Self::Claude => "claude", Self::Codex => "codex" } }
    /// 设置文件与前端协议里的键。
    pub(crate) fn key(self) -> &'static str { self.program() }
    /// 固定顺序，不依赖枚举声明。
    pub(crate) fn all() -> [Provider; 2] { [Provider::Claude, Provider::Codex] }
    /// npm 上的包名。
    fn package(self) -> &'static str { match self { Self::Claude => "@anthropic-ai/claude-code", Self::Codex => "@openai/codex" } }
    /// 各自要求的最低 Node 主版本；低于它连 `--version` 都跑不起来。
    fn minimum_node(self) -> u64 { match self { Self::Claude => 22, Self::Codex => 16 } }
    /// 包内 `bin` 字段允许的入口。只认官方布局，挡住把 bin 指到包外或换成自定义脚本的包装器。
    fn accepts_bin(self, bin: &str) -> bool {
        match self {
            Self::Claude => matches!(bin, "cli.js" | "bin/claude" | "bin/claude.exe"),
            Self::Codex => bin == "bin/codex.js",
        }
    }
}
/// 设置页能发起的三种管理动作。反序列化白名单，前端传别的值直接失败。
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Action { Install, Update, Uninstall }
/// 现有安装的来源。只有 `Npm` 归 Forge 管，原生安装与外部安装一律只报告不接管。
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source { Native, Npm, External }

/// 单个 CLI 的检测结果。能力位（canInstall/canUpdate/canUninstall）由后端算好，
/// 前端只按位渲染按钮，不重复判断来源与冲突。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// 这份状态属于哪个 CLI。
    provider: Provider,
    /// PATH 上是否找到了可执行文件；找到不等于版本可用。
    installed: bool,
    /// 解析出的正式版本；探测失败或输出无法解析时为 None。
    version: Option<String>,
    /// 实际使用的启动器路径，直接展示给用户，方便对照自己装在哪。
    path: Option<String>,
    /// 安装来源；未安装或无法判定时为 None。
    source: Option<Source>,
    /// 官方源（或镜像回退）报告的最新稳定版本；查询失败时为 None。
    latest_version: Option<String>,
    /// 上面那个版本号来自哪个源，界面据此提示镜像可能滞后。
    latest_source: Option<latest::VersionSource>,
    /// 最新版本是否高于已装版本；无法比较时为 false，绝不提示降级。
    update_available: bool,
    /// 是否允许安装：未安装、无前置条件错误、无残留占用。
    can_install: bool,
    /// 是否允许更新：可卸载、能解析版本、且确实有更高版本。
    can_update: bool,
    /// 是否允许卸载：唯一一份安装、来源为 npm、无前置条件错误。
    can_uninstall: bool,
    /// 阻止操作的原因（Node 版本不够、多份安装、目录被链接占用等）。
    prerequisite_error: Option<String>,
    /// `--version` 探测失败的原因；与前置条件错误分开，便于用户区分该修什么。
    probe_error: Option<String>,
    /// 最新版本查询失败的原因；本地结论仍然有效。
    latest_error: Option<String>,
    /// 仅供本进程启动对话时判断安装是否唯一，不进入前端协议。
    #[serde(skip)]
    launcher_count: usize,
}
/// 管理动作的结果。`success` 是「事后校验通过」，不是「命令退出码为 0」——
/// npm 可能成功退出却留下半成品，界面必须按校验结果提示。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManageResult {
    /// 安装后回读校验是否通过；命令退出码为 0 但校验不通过时也是 false。
    success: bool,
    /// 命令的原始输出（成功与失败都返回，失败时附一句校验说明）。
    output: String,
    /// 命令退出码；进程被信号杀掉等情况下为 None。
    exit_code: Option<i32>,
}

/// 互斥的 RAII 守卫：无论正常返回还是提前 `?` 退出，Drop 都会把 `BUSY` 放回去。
struct BusyGuard;
impl BusyGuard {
    fn acquire() -> Result<Self, String> {
        BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self).map_err(|_| "另一个 CLI 检测或安装操作尚未结束，请稍后重试".to_string())
    }
}
impl Drop for BusyGuard { fn drop(&mut self) { BUSY.store(false, Ordering::Release); } }

/// 固定三段正式版本；拒绝预发布、shell 字符和无限长输入。
fn version_parts(value: &str) -> Option<[u64; 3]> {
    if value.len() > 40 { return None; }
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3 { return None; }
    let mut result = [0; 3];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() || (part.len() > 1 && part.starts_with('0')) || !part.bytes().all(|c| c.is_ascii_digit()) { return None; }
        result[index] = part.parse().ok()?;
    }
    Some(result)
}
fn parse_version(provider: Provider, output: &str) -> Option<String> {
    let line = output.lines().find(|line| !line.trim().is_empty())?.trim();
    let value = match provider {
        Provider::Claude => line.strip_suffix(" (Claude Code)").unwrap_or(line),
        Provider::Codex => line.strip_prefix("codex-cli ").or_else(|| line.strip_prefix("codex ")).unwrap_or(line),
    };
    version_parts(value).map(|_| value.to_string())
}
fn newer(latest: &str, installed: &str) -> bool {
    match (version_parts(latest), version_parts(installed)) { (Some(a), Some(b)) => a > b, _ => false }
}
/// 用户主目录。必须是绝对路径且真实存在，否则返回错误而不是拼一个假路径。
fn home() -> Result<PathBuf, String> {
    let value = if cfg!(windows) { std::env::var_os("USERPROFILE") } else { std::env::var_os("HOME") };
    value.map(PathBuf::from).filter(|path| path.is_absolute() && path.is_dir())
        .ok_or_else(|| "无法确定用户主目录".to_string())
}
/// 比较两条路径是否指向同一位置。统一分隔符后，Windows 忽略大小写、Unix 不忽略。
fn same_path(a: &Path, b: &Path) -> bool {
    let a = a.to_string_lossy().replace('\\', "/");
    let b = b.to_string_lossy().replace('\\', "/");
    if cfg!(windows) { a.eq_ignore_ascii_case(&b) } else { a == b }
}
/// 先解析符号链接再比较。任一侧解析失败就判为不同，宁可漏认也不误认。
fn same_target(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) { (Ok(a), Ok(b)) => same_path(&a, &b), _ => false }
}
/// 是否是可执行的普通文件。Windows 只要求存在（靠扩展名判定），Unix 还要有执行位。
fn executable(path: &Path) -> bool {
    if !path.is_file() { return false; }
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; return fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0); }
    #[cfg(windows)]
    true
}
/// 在 PATH（以及 `~/.local/bin`）里找出该 CLI 的所有启动器。
///
/// 返回的是「候选集合」而不是单个路径：数量大于 1 本身就是一种需要报告的状态，
/// 调用方据此拒绝操作，而不是替用户挑一个。
fn launchers(provider: Provider) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&crate::lsp_probe::augmented_path()).collect();
    if let Ok(home) = home() { dirs.push(home.join(".local/bin")); }
    let mut found: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        if !dir.is_absolute() { continue; }
        let names = if cfg!(windows) {
            vec![format!("{}.exe", provider.program()), format!("{}.cmd", provider.program()), format!("{}.bat", provider.program()), format!("{}.ps1", provider.program())]
        } else { vec![provider.program().to_string()] };
        // 同一 npm 安装的 .cmd / .ps1 是同一个启动器，仅取优先的一份。
        if let Some(path) = names.iter().map(|name| dir.join(name)).find(|path| executable(path)) {
            if !found.iter().any(|item| same_target(item, &path)) { found.push(path); }
        }
    }
    found
}
fn resolve(program: &str) -> Result<PathBuf, String> {
    crate::lsp_probe::resolve_command(program).map(PathBuf::from)
        .ok_or_else(|| format!("未找到 {program}，请安装并在重启 Forge 后重试"))
}
/// 判断是不是「干净目录」：符号链接与 Windows 重解析点都算不安全。
///
/// 安装器会往这些路径写文件，若其中一环是指向别处的链接，写入就落到预期之外的位置。
fn is_plain_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| {
        #[cfg(windows)]
        { use std::os::windows::fs::MetadataExt; if meta.file_attributes() & 0x400 != 0 { return false; } }
        meta.is_dir() && !meta.file_type().is_symlink()
    })
}
/// 用文件头魔数确认是可执行文件。只看扩展名不够——`claude.exe` 可以是个文本壳。
fn binary_file(path: &Path) -> bool {
    let mut magic = [0; 4];
    if fs::File::open(path).and_then(|mut file| file.read_exact(&mut magic)).is_err() { return false; }
    magic.starts_with(b"MZ") || magic == *b"\x7fELF" ||
        matches!(magic, [0xcf, 0xfa, 0xed, 0xfe] | [0xce, 0xfa, 0xed, 0xfe] | [0xca, 0xfe, 0xba, 0xbe] | [0xfe, 0xed, 0xfa, 0xcf])
}
/// 官方原生安装把可执行文件放在这个固定位置。
fn native_launcher(home: &Path) -> PathBuf { home.join(if cfg!(windows) { ".local/bin/claude.exe" } else { ".local/bin/claude" }) }
/// 逐级检查原生安装用到的目录，任何一层被链接或占用都判为不安全。
fn native_directories_safe(home: &Path) -> bool {
    [".local", ".local/bin", ".local/share", ".local/share/claude", ".local/share/claude/versions"]
        .iter().all(|name| {
            let path = home.join(name);
            // dangling symlink 也算占用，不能让安装器顺着它写到别处。
            fs::symlink_metadata(&path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) || is_plain_directory(&path)
        })
}

/// 只识别官方原生目录布局，符号链接不可指向目录之外；Windows 再核验 Authenticode。
fn native_source(path: &Path, home: &Path) -> bool {
    if !native_directories_safe(home) || !same_path(path, &native_launcher(home)) || !is_plain_directory(&home.join(".local/bin")) { return false; }
    #[cfg(unix)]
    {
        let versions = home.join(".local/share/claude/versions");
        let Ok(target) = fs::canonicalize(path) else { return false; };
        let Ok(versions) = fs::canonicalize(versions) else { return false; };
        fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) &&
            target.parent() == Some(versions.as_path()) &&
            target.file_name().and_then(|name| name.to_str()).and_then(version_parts).is_some() && binary_file(&target)
    }
    #[cfg(windows)]
    {
        if fs::symlink_metadata(path).is_ok_and(|meta| {
            use std::os::windows::fs::MetadataExt;
            meta.file_attributes() & 0x400 != 0
        }) || !binary_file(path) { return false; }
        let mut command = process::powershell();
        command.args(["-Command", "$s=Get-AuthenticodeSignature -LiteralPath $env:FORGE_AI_PROGRAM; if ($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -match '(^|, )O=\"?Anthropic(,? PBC|,? Inc\\.)?\"?(,|$)') { 'verified' } else { exit 1 }"])
            .env("FORGE_AI_PROGRAM", path);
        checked(command).is_ok_and(|output| output == "verified")
    }
}

/// npm 全局安装的位置与 npm 自身路径。查一次就够，调用方复用。
struct Npm {
    /// npm 可执行文件本身；Windows 上通常是 `npm.cmd`。
    program: PathBuf,
    /// npm 的全局前缀：Unix 的可执行文件在 `<prefix>/bin`，Windows 直接在 `<prefix>`。
    prefix: PathBuf,
    /// 全局模块根，包目录在 `<root>/<package>`。
    root: PathBuf,
}
/// 读取 npm 环境：先验 Node 版本（不够就直接报前置条件错误），再问 npm 要全局前缀与模块根。
fn npm_info(provider: Provider) -> Result<Npm, String> {
    let node = resolve("node")?;
    let node_version = checked(command(&node, &["--version"]))?;
    let node_version = version_parts(node_version.trim_start_matches('v')).ok_or("无法解析 Node.js 版本")?;
    if node_version[0] < provider.minimum_node() { return Err(format!("{} 需要 Node.js {} 或更高版本，请先更新 Node.js", provider.program(), provider.minimum_node())); }
    let program = resolve("npm")?;
    let prefix = PathBuf::from(checked(command(&program, &["prefix", "--global"]))?);
    let root = PathBuf::from(checked(command(&program, &["root", "--global"]))?);
    if !prefix.is_absolute() || !root.is_absolute() { return Err("npm 返回的全局安装路径无效".into()); }
    Ok(Npm { program, prefix, root })
}
/// 核对 PATH 上那个启动器确实来自 npm 全局目录，并且指向官方包的官方入口。
///
/// 光看路径在全局前缀下不够：`.cmd` 可以手写一个转发脚本，`bin` 也可以指向包外。
/// 所以还要读 `package.json` 核对包名与 bin，Windows 上再比对 shim 里写的相对路径。
fn npm_source(provider: Provider, path: &Path, npm: &Npm) -> bool {
    let package = npm.root.join(provider.package());
    let Some(metadata) = fs::read(package.join("package.json")).ok()
        .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok()) else { return false; };
    let Some(bin) = metadata["bin"][provider.program()].as_str() else { return false; };
    if metadata["name"] != provider.package() || !provider.accepts_bin(bin) { return false; }
    let target = package.join(bin);
    #[cfg(unix)]
    { same_path(path, &npm.prefix.join("bin").join(provider.program())) && same_target(path, &target) }
    #[cfg(windows)]
    {
        if !same_path(path, &npm.prefix.join(format!("{}.cmd", provider.program()))) { return false; }
        let Ok(shim) = fs::read_to_string(path) else { return false; };
        let shim = shim.replace('\\', "/");
        target.is_file() && shim.contains(&format!("%dp0%/node_modules/{}/{bin}\"", provider.package())) &&
            same_target(&npm.root, &npm.prefix.join("node_modules"))
    }
}

/// 检查 npm 全局目录里是否已有该工具的残留（包目录或任一启动器）。
///
/// 用于「PATH 上找不到、但确实装过东西」的情形：直接安装会覆盖别人的文件，
/// 所以先判占用，让用户自己用原来的方式修复。
fn npm_occupied(provider: Provider, npm: &Npm) -> bool {
    let bin_dir = if cfg!(windows) { npm.prefix.clone() } else { npm.prefix.join("bin") };
    let mut paths = vec![npm.root.join(provider.package()), bin_dir.join(provider.program())];
    if cfg!(windows) {
        for extension in ["cmd", "ps1", "exe", "bat"] { paths.push(bin_dir.join(format!("{}.{extension}", provider.program()))); }
    }
    paths.iter().any(|path| fs::symlink_metadata(path).is_ok())
}

/// 只有「唯一一份、且来自 npm 全局安装」才允许 Forge 改写。
/// 多份安装说明用户有别的管理方式，动任何一份都可能破坏那套方式。
fn managed_source(source: Option<Source>, count: usize) -> bool {
    source == Some(Source::Npm) && count == 1
}

/// 管理动作只依赖执行当刻的本机状态；更新额外使用刚查到的远端版本，
/// 不能读取未联网的 `local_status.can_update`，否则可更新按钮会在后端被错误拒绝。
fn action_allowed(status: &Status, action: Action, latest: &str) -> bool {
    match action {
        Action::Install => status.can_install,
        Action::Uninstall => status.can_uninstall,
        Action::Update => status.can_uninstall
            && status.probe_error.is_none()
            && status.version.as_deref().is_some_and(|current| newer(latest, current)),
    }
}

/// 汇总本机状态：PATH 上有没有、来源是什么、版本能不能解析、以及据此允许哪些动作。
///
/// 这里的原则是「拿不准就不授权」。凡是存在多份安装、原生安装、残留文件、
/// 目录含链接的情况，都写进 `prerequisite_error` 并关掉对应能力位，而不是猜一个安全的做法。
fn local_status(provider: Provider) -> Result<Status, String> {
    let mut status = Status {
        provider, installed: false, version: None, path: None, source: None,
        latest_version: None, latest_source: None, update_available: false, can_install: false, can_update: false, can_uninstall: false,
        prerequisite_error: None, probe_error: None, latest_error: None,
        launcher_count: 0,
    };
    let home = home()?;
    let candidates = launchers(provider);
    status.launcher_count = candidates.len();
    let npm = npm_info(provider);
    status.prerequisite_error = npm.as_ref().err().cloned();
    if let Some(path) = candidates.first() {
        status.installed = true;
        status.path = Some(path.to_string_lossy().into_owned());
        status.source = Some(if provider == Provider::Claude && native_source(path, &home) { Source::Native }
            else if npm.as_ref().is_ok_and(|npm| npm_source(provider, path, npm)) { Source::Npm }
            else { Source::External });
        match checked(command(path, &["--version"])) {
            Ok(output) => {
                status.version = parse_version(provider, &output);
                if status.version.is_none() { status.probe_error = Some(format!("无法解析版本（可能是预发布或包装程序）：{output}")); }
            },
            Err(error) => status.probe_error = Some(error),
        }
        if candidates.len() > 1 {
            status.prerequisite_error = Some(format!("发现多份安装，请先用原安装方式解决冲突：{}", candidates.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join("；")));
        }
        if status.source == Some(Source::Native) && candidates.len() == 1 {
            status.prerequisite_error = Some("检测到 Claude Code 原生安装；Forge 现仅管理 npm 全局安装，请使用原安装方式管理。不会自动迁移或删除原生版本".into());
        }
        let managed = managed_source(status.source, candidates.len());
        status.can_uninstall = managed && status.prerequisite_error.is_none();
        status.can_update = status.can_uninstall && status.probe_error.is_none();
    } else {
        // PATH 没找到不等于可覆盖：半成品或隐藏安装仍应保守处理。
        let occupied = npm.as_ref().is_ok_and(|npm| npm_occupied(provider, npm)) ||
            (provider == Provider::Claude && (fs::symlink_metadata(native_launcher(&home)).is_ok() ||
                fs::symlink_metadata(home.join(".local/share/claude")).is_ok()));
        if occupied {
            status.prerequisite_error = Some("发现残留或不在 PATH 中的安装文件，请先用原安装方式修复；Forge 不会覆盖这些文件".into());
        }
        status.can_install = status.prerequisite_error.is_none();
    }
    if provider == Provider::Claude && !status.installed && !native_directories_safe(&home) {
        status.prerequisite_error = Some("原生安装目录含符号链接、重解析点或无法访问的目录；请使用原安装方式管理".into());
        status.can_install = false;
        status.can_update = false;
        status.can_uninstall = false;
    }
    Ok(status)
}

/// 取进程级缓存的安装检测结果；第一次调用时一次性探测两个 CLI，之后所有工程和 WebView 复用。
fn cached_status(provider: Provider) -> Result<Status, String> {
    let mut cache = LOCAL_STATUS.blocking_lock();
    if cache.is_none() {
        *cache = Some([Provider::Claude, Provider::Codex].into_iter()
            .map(|item| local_status(item).unwrap_or_else(|error| failed_status(item, error))).collect());
    }
    cache.as_ref().and_then(|statuses| statuses.iter().find(|status| status.provider == provider)).cloned()
        .ok_or("CLI 安装检测结果缺失".into())
}

/// 已安装 CLI 的实测版本。模型目录按它失效：升级会带来新模型，不能靠一次探测封住整个进程。
pub(crate) fn installed_version(provider: Provider) -> Result<String, String> {
    cached_status(provider)?.version.ok_or("CLI 版本无法识别，不据此判定模型目录是否最新".into())
}

/// 为对话启动 CLI：返回拼好的命令与实测版本号。
///
/// 两处刻意的选择：
/// - 只认「唯一一份」安装。多份共存时无法确定用户想用哪个，宁可让用户先清理。
/// - Windows 上的 npm 启动器是 `.cmd`/`.ps1` 脚本，直接跑会让 stdin/stdout 经过 PowerShell。
///   双向流式对话必须绕开它：校验通过后直接定位到包内的真实入口（`.js` 用 node 起，
///   原生可执行文件直接起），保证管道里只有协议数据。
pub(crate) fn runtime_command(provider: Provider, args: &[&str]) -> Result<(Command, String), String> {
    let status = cached_status(provider)?;
    if !status.installed || status.launcher_count != 1 { return Err("请保留一份可用的 CLI 安装后重新检测".into()); }
    let path = PathBuf::from(status.path.ok_or("CLI 安装路径缺失")?);
    // 不按版本号做任何拦截：用户升到哪个版本都照常启动，真正不兼容的帧由协议适配器
    // 按实际内容报错。版本只作为展示与缓存键返回；解析不出来时留空，调用方按未知处理。
    let version = status.version.unwrap_or_default();
    #[cfg(windows)]
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat") || e.eq_ignore_ascii_case("ps1")) {
        let prefix = path.parent().ok_or("CLI 安装路径无效")?.to_path_buf();
        let npm = Npm { program: prefix.join("npm.cmd"), root: prefix.join("node_modules"), prefix };
        if status.source != Some(Source::Npm) { return Err("流式对话不支持自定义脚本包装器；请使用官方原生或 npm 安装".into()); }
        let package = npm.root.join(provider.package());
        let metadata: serde_json::Value = serde_json::from_slice(&fs::read(package.join("package.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let bin = metadata["bin"][provider.program()].as_str().filter(|b| provider.accepts_bin(b)).ok_or("CLI 包入口无效")?;
        let target = package.join(bin);
        let mut cmd = if bin.ends_with(".js") { let mut c = Command::new(resolve("node")?); c.arg(target); c } else { Command::new(target) };
        cmd.args(args);
        return Ok((with_environment(cmd, provider), version));
    }
    Ok((with_environment(command(&path, args), provider), version))
}

/// 把设置页保存的环境变量注入每一次 CLI 启动。模型目录查询走同一条路径，
/// 因此自定义的 API 地址/密钥也能被读到。
fn with_environment(mut command: Command, provider: Provider) -> Command {
    for (key, value) in settings::environment(provider) { command.env(key, value); }
    command
}

/// 取版本元数据。只允许 https、限跳转次数、限响应体大小：
/// 出去的地方只有这里和 MCP 市场搜索，不能让它变成任意的 HTTP 客户端。
async fn fetch_text(url: &str) -> Result<String, String> {
    fetch_text_with(url, Duration::from_secs(25)).await
}

/// 同一个客户端策略，只是超时不同：MCP registry 实测首包可能要 30 秒以上，不能沿用 25 秒。
pub(crate) async fn fetch_text_with(url: &str, timeout: Duration) -> Result<String, String> {
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(10))
        .timeout(timeout).https_only(true).redirect(reqwest::redirect::Policy::limited(3))
        .build().map_err(|error| error.to_string())?;
    let mut response = client.get(url).send().await.map_err(|e| e.to_string())?
        .error_for_status().map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 { return Err("远端响应过大".into()); }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|e| e.to_string())
}
/// 联网结果只补充安装管理能力，不改变已检测的 installed 状态。
async fn update_status(mut status: Status) -> Status {
    match latest::query(status.provider).await {
        Ok(latest) => {
            status.update_available = status.version.as_ref().is_some_and(|current| newer(&latest.version, current));
            status.latest_version = Some(latest.version);
            status.latest_source = Some(latest.source);
            status.can_update = status.can_uninstall && status.probe_error.is_none() && status.update_available;
        },
        Err(error) => { status.latest_error = Some(error); status.can_install = false; status.can_update = false; }
    }
    status
}
/// 整个探测失败时仍要回一份结构完整的 `Status`，让前端照常渲染而不用处理 null。
fn failed_status(provider: Provider, error: String) -> Status {
    Status { provider, installed: false, version: None, path: None, source: None, latest_version: None, latest_source: None,
        update_available: false, can_install: false, can_update: false, can_uninstall: false,
        prerequisite_error: None, probe_error: Some(error), latest_error: None, launcher_count: 0 }
}
/// 检测两个 CLI。互斥在这里拿，保证检测期间不会有安装操作改目录；
/// 两个 provider 并发探测，单个失败只影响自己那一份结果。
#[tauri::command]
pub async fn ai_cli_probe(app: AppHandle, force: Option<bool>) -> Result<Vec<Status>, String> {
    // 桌面进程级缓存跨项目、跨 WebView 刷新保留；安装管理后才失效。
    let mut cache = LOCAL_STATUS.lock().await;
    if force == Some(true) { *cache = None; }
    if let Some(statuses) = cache.as_ref() { return Ok(statuses.clone()); }
    let _gate = runtime_gate(&app)?;
    let _guard = BusyGuard::acquire()?;
    let (claude, codex) = tokio::join!(block(|| local_status(Provider::Claude)), block(|| local_status(Provider::Codex)));
    let mut statuses = vec![claude.unwrap_or_else(|error| failed_status(Provider::Claude, error)), codex.unwrap_or_else(|error| failed_status(Provider::Codex, error))];
    for status in &mut statuses { status.can_update = false; }
    *cache = Some(statuses.clone());
    Ok(statuses)
}

static LOCAL_STATUS: tokio::sync::Mutex<Option<Vec<Status>>> = tokio::sync::Mutex::const_new(None);

/// 联网更新查询不持有管理锁，不影响已安装工具创建或发送会话。
#[tauri::command]
pub async fn ai_cli_updates(app: AppHandle) -> Result<Vec<Status>, String> {
    let statuses = ai_cli_probe(app, None).await?;
    let (claude, codex) = tokio::join!(update_status(statuses[0].clone()), update_status(statuses[1].clone()));
    Ok(vec![claude, codex])
}

/// 拼 npm 命令。版本号先过 `version_parts`，把 `1.2.3;rm -rf` 这类注入挡在启动之前；
/// 卸载不需要版本，但要显式带上包名，不能靠 `npm uninstall` 自己猜。
fn npm_command(provider: Provider, action: Action, version: &str, home: &Path, npm: &Npm) -> Result<Command, String> {
    if action != Action::Uninstall && version_parts(version).is_none() { return Err("拒绝无效或预发布版本".into()); }
    let package = format!("{}@{version}", provider.package());
    let args = if action == Action::Uninstall { vec!["uninstall", "--global", provider.package(), "--registry", NPM_REGISTRY] }
        else { vec!["install", "--global", &package, "--registry", NPM_REGISTRY, "--include=optional", "--no-audit", "--no-fund"] };
    let mut cmd = command(&npm.program, &args);
    cmd.current_dir(home);
    Ok(cmd)
}

/// 把命令交给 `npm_info` 之后拼出来；版本校验同样在这里统一做。
fn install_command(provider: Provider, action: Action, version: &str, home: &Path) -> Result<Command, String> {
    if action != Action::Uninstall && version_parts(version).is_none() { return Err("拒绝无效或预发布版本".into()); }
    npm_command(provider, action, version, home, &npm_info(provider)?)
}

/// 安装 / 更新 / 卸载。流程是「先判可做、再执行、最后回读校验」，
/// 因为 npm 的退出码不代表结果正确，必须重新探测一遍本机状态才算成功。
///
/// 互斥与对话生命周期在同一临界区里拿：先确认没有正在跑的 AI 对话（否则改 CLI 会打断它们），
/// 再拿管理锁。锁随阻塞任务移动，前端断开或 future 被取消都不会提前释放。
#[tauri::command]
pub async fn ai_cli_manage(app: AppHandle, provider: Provider, action: Action) -> Result<ManageResult, String> {
    let mut cache = LOCAL_STATUS.lock().await;
    // Guard 移入阻塞任务，前端断开或 async future 取消也不能提前解除互斥。
    let guard = {
        let _lifecycle = crate::ai_runtime::lifecycle_lock();
        let gate = runtime_gate(&app).map_err(|_| "另一个 Forge 窗口正在检测或修改 CLI，请稍后重试")?;
        let busy = BusyGuard::acquire()?;
        if crate::ai_runtime::has_runs() { return Err("请先停止 AI 对话，再修改 CLI 安装".into()); }
        let sessions = lock_idle_sessions(&app)?;
        (busy, gate, sessions)
    };
    // 即使管理命令失败也可能留下部分安装，下一次读取必须重新检测。
    *cache = None;
    drop(cache);
    let version = if action == Action::Uninstall { String::new() } else { latest::query(provider).await?.version };
    block(move || {
        let _guard = guard;
        let state = local_status(provider)?;
        let allowed = action_allowed(&state, action, &version);
        if !allowed { return Err(state.prerequisite_error.or(state.probe_error).unwrap_or_else(|| "安装来源或当前状态不允许此操作，请重新检测".into())); }
        if action == Action::Update && !state.version.as_deref().is_some_and(|current| newer(&version, current)) {
            return Err("已是稳定版本或当前版本更新；不会隐式降级".into());
        }
        let home = home()?;
        let output = process::run(install_command(provider, action, &version, &home)?, Duration::from_secs(900))?;
        if !output.success { return Ok(ManageResult { success: false, output: output.text(), exit_code: output.code }); }
        let after = local_status(provider)?;
        let verified = match action {
            Action::Uninstall => !after.installed && after.prerequisite_error.is_none(),
            _ => after.installed && after.source == Some(Source::Npm) && after.can_uninstall && after.version.as_deref() == Some(&version),
        };
        Ok(ManageResult { success: verified, exit_code: output.code,
            output: if verified { output.text() } else { format!("{}\n命令已退出，但安装后校验未通过，请查看本机状态或原始输出。", output.text()) } })
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 只接受三段正式版本：预发布、带构建后缀、含 shell 元字符或超长输入一律拒绝。
    #[test]
    fn accepts_only_stable_versions() {
        for value in ["1.2.3", "0.163.0", "2.1.308"] { assert!(version_parts(value).is_some()); }
        for value in ["1.2", "1.2.3-beta.1", "1.2.3+dev", "01.2.3", "1.2.3;whoami", "$(echo x)", "1.2.3\n", "", "1.2.18446744073709551616"] { assert!(version_parts(value).is_none(), "{value}"); }
    }
    /// 两个 CLI 的 `--version` 输出格式不同，各自剥掉自己的前后缀后再校验。
    #[test]
    fn parses_known_version_output() {
        assert_eq!(parse_version(Provider::Claude, "2.1.3 (Claude Code)\n"), Some("2.1.3".into()));
        assert_eq!(parse_version(Provider::Codex, "codex-cli 0.163.0\n"), Some("0.163.0".into()));
        assert_eq!(parse_version(Provider::Codex, "codex-cli 0.163.0-alpha.1"), None);
        assert_eq!(parse_version(Provider::Claude, "unexpected 2.1.3"), None);
    }
    /// 版本按数字段比较（`2.10.0` 大于 `2.9.99`），且相等或无法解析时都不算「更新」。
    #[test]
    fn compares_numerically_and_never_downgrades() {
        assert!(newer("2.10.0", "2.9.99"));
        assert!(!newer("2.9.0", "2.10.0"));
        assert!(!newer("2.10.0", "2.10.0"));
        assert!(!newer("2.10.0-beta", "2.9.0"));
    }

    /// 本机探测不联网，因此 `can_update` 为 false 不能否决刚完成的版本查询。
    #[test]
    fn update_uses_fresh_remote_version_instead_of_local_update_flag() {
        let status = Status {
            provider: Provider::Codex, installed: true, version: Some("1.0.0".into()), path: Some("codex".into()),
            source: Some(Source::Npm), latest_version: None, latest_source: None, update_available: false,
            can_install: false, can_update: false, can_uninstall: true, prerequisite_error: None,
            probe_error: None, latest_error: None, launcher_count: 1,
        };
        assert!(action_allowed(&status, Action::Update, "1.1.0"));
        assert!(!action_allowed(&status, Action::Update, "1.0.0"));
    }
    /// provider 与 action 是白名单枚举，前端传别的字符串直接反序列化失败，不会走到执行。
    #[test]
    fn command_enums_reject_arbitrary_input() {
        assert!(serde_json::from_str::<Provider>("\"other\"").is_err());
        assert!(serde_json::from_str::<Action>("\"exec\"").is_err());
    }
    /// 注入字符串在拼命令这一步就被挡下，不会真的启动进程。
    #[test]
    fn command_builder_rejects_injection_before_launch() {
        assert!(install_command(Provider::Claude, Action::Install, "1.2.3;exit", Path::new("/")).is_err());
    }

    /// 每个用例独占一个临时目录，Drop 时删干净；不碰真实的 npm 全局目录。
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!("forge-ai-cli-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    /// 只有「唯一一份 npm 安装」才归 Forge 管；原生、外部、多份都不授权改写。
    #[test]
    fn only_single_npm_installation_is_managed() {
        assert!(managed_source(Some(Source::Npm), 1));
        for source in [None, Some(Source::Native), Some(Source::External)] { assert!(!managed_source(source, 1)); }
        assert!(!managed_source(Some(Source::Npm), 2));
    }

    /// 非官方布局（自定义脚本、路径在别处、目录被普通文件占住）都不能认成原生安装。
    #[test]
    fn native_detection_rejects_wrappers_and_nonstandard_paths() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.0.join(".local/bin")).unwrap();
        let launcher = native_launcher(&fixture.0);
        fs::write(&launcher, b"#!/bin/sh\necho fake").unwrap();
        assert!(!native_source(&launcher, &fixture.0));
        assert!(!native_source(&fixture.0.join("external/claude"), &fixture.0));
        fs::write(fixture.0.join(".local/share"), "not a directory").unwrap();
        assert!(!native_directories_safe(&fixture.0));
    }

    /// 断言拼出的参数严格等于白名单：固定版本、官方 registry、不加审计与资金提示，
    /// 且预发布版本在拼装阶段就被拒。Windows 上参数经环境变量传递，故从 env 读回。
    #[test]
    fn npm_commands_use_exact_versions_and_official_registry_for_both_tools() {
        let fixture = Fixture::new();
        let npm = Npm { program: fixture.0.join(if cfg!(windows) { "npm.cmd" } else { "npm" }), prefix: fixture.0.clone(), root: fixture.0.join("node_modules") };
        for provider in [Provider::Claude, Provider::Codex] {
            for action in [Action::Install, Action::Update, Action::Uninstall] {
                let cmd = npm_command(provider, action, "2.1.308", &fixture.0, &npm).unwrap();
                #[cfg(windows)]
                let args: Vec<String> = (0..if action == Action::Uninstall { 5 } else { 8 }).map(|index| {
                    cmd.get_envs().find(|(key, _)| *key == std::ffi::OsStr::new(&format!("FORGE_AI_ARG_{index}")))
                        .unwrap().1.unwrap().to_string_lossy().into_owned()
                }).collect();
                #[cfg(unix)]
                let args: Vec<String> = cmd.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
                assert_eq!(args[0], if action == Action::Uninstall { "uninstall" } else { "install" });
                assert_eq!(args[1], "--global");
                assert_eq!(args[2], if action == Action::Uninstall { provider.package().to_string() } else { format!("{}@2.1.308", provider.package()) });
                assert_eq!(&args[3..5], &["--registry", NPM_REGISTRY]);
                if action != Action::Uninstall { assert_eq!(&args[5..], &["--include=optional", "--no-audit", "--no-fund"]); }
                assert_eq!(cmd.get_current_dir(), Some(fixture.0.as_path()));
            }
            assert!(npm_command(provider, Action::Install, "1.0.0-beta", &fixture.0, &npm).is_err());
        }
        assert_eq!(Provider::Claude.minimum_node(), 22);
        assert_eq!(Provider::Codex.minimum_node(), 16);
    }

    /// Claude 历史版本用过不同的 bin 入口（`cli.js`、`bin/claude`、`bin/claude.exe`），都要认；
    /// 但包名不符或 bin 指向包外时必须判为不合法。
    #[test]
    fn claude_npm_detection_supports_legacy_and_native_package_entries() {
        for bin in ["cli.js", "bin/claude", "bin/claude.exe"] {
            let fixture = Fixture::new();
            let prefix = fixture.0.join("npm");
            let root = prefix.join("node_modules");
            let package = root.join(Provider::Claude.package());
            let target = package.join(bin);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(&target, "fixture").unwrap();
            let metadata = serde_json::json!({"name": Provider::Claude.package(), "bin": {"claude": bin}});
            fs::write(package.join("package.json"), metadata.to_string()).unwrap();
            let npm = Npm { program: prefix.join("npm"), prefix: prefix.clone(), root };
            #[cfg(windows)]
            let launcher = {
                let path = prefix.join("claude.cmd");
                fs::write(&path, format!("\"%dp0%/node_modules/{}/{bin}\" %*", Provider::Claude.package())).unwrap();
                path
            };
            #[cfg(unix)]
            let launcher = {
                fs::create_dir_all(prefix.join("bin")).unwrap();
                let path = prefix.join("bin/claude");
                std::os::unix::fs::symlink(&target, &path).unwrap();
                path
            };
            assert!(npm_source(Provider::Claude, &launcher, &npm), "{bin}");
            assert!(!npm_source(Provider::Codex, &launcher, &npm));
            fs::write(package.join("package.json"), r#"{"name":"other","bin":{"claude":"cli.js"}}"#).unwrap();
            assert!(!npm_source(Provider::Claude, &launcher, &npm));
            fs::write(package.join("package.json"), r#"{"name":"@anthropic-ai/claude-code","bin":{"claude":"../../outside.js"}}"#).unwrap();
            assert!(!npm_source(Provider::Claude, &launcher, &npm));
        }
    }

    /// 包目录或任一启动器残留在全局目录里，都必须挡住安装，避免覆盖别人的文件。
    #[test]
    fn npm_residue_blocks_installation_for_both_providers() {
        for provider in [Provider::Claude, Provider::Codex] {
            let fixture = Fixture::new();
            let npm = Npm { program: fixture.0.join("npm"), prefix: fixture.0.clone(), root: fixture.0.join("node_modules") };
            assert!(!npm_occupied(provider, &npm));
            fs::create_dir_all(npm.root.join(provider.package())).unwrap();
            assert!(npm_occupied(provider, &npm));
            fs::remove_dir(npm.root.join(provider.package())).unwrap();
            let launcher = if cfg!(windows) { npm.prefix.join(format!("{}.ps1", provider.program())) } else { npm.prefix.join("bin").join(provider.program()) };
            fs::create_dir_all(launcher.parent().unwrap()).unwrap();
            fs::write(launcher, "fixture").unwrap();
            assert!(npm_occupied(provider, &npm));
        }
    }

    /// 包名不符、shim 指向别的文件、或启动器不在 npm 前缀下，都不能认成 npm 安装。
    #[test]
    fn npm_detection_requires_package_identity_and_matching_launcher() {
        let fixture = Fixture::new();
        let prefix = fixture.0.join("npm");
        let root = prefix.join("node_modules");
        let package = root.join("@openai/codex");
        fs::create_dir_all(package.join("bin")).unwrap();
        fs::write(package.join("package.json"), r#"{"name":"not-codex","bin":{"codex":"bin/codex.js"}}"#).unwrap();
        let npm = Npm { program: prefix.join("npm.cmd"), prefix: prefix.clone(), root };
        assert!(!npm_source(Provider::Codex, &prefix.join("codex.cmd"), &npm));
        fs::write(package.join("package.json"), r#"{"name":"@openai/codex","bin":{"codex":"bin/codex.js"}}"#).unwrap();
        fs::write(package.join("bin/codex.js"), "// fixture").unwrap();
        #[cfg(windows)]
        {
            fs::write(prefix.join("codex.cmd"), r#"@echo off
"%dp0%\node_modules\@openai\codex\bin\codex.js" %*"#).unwrap();
            assert!(npm_source(Provider::Codex, &prefix.join("codex.cmd"), &npm));
            fs::write(prefix.join("other.cmd"), "custom wrapper").unwrap();
            assert!(!npm_source(Provider::Codex, &prefix.join("other.cmd"), &npm));
        }
        #[cfg(unix)]
        {
            fs::create_dir_all(prefix.join("bin")).unwrap();
            std::os::unix::fs::symlink(package.join("bin/codex.js"), prefix.join("bin/codex")).unwrap();
            assert!(npm_source(Provider::Codex, &prefix.join("bin/codex"), &npm));
        }
    }
}
