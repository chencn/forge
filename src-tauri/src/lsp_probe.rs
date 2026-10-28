//! 语言服务的安装探测与一键安装。
//!
//! 配置里的档位只表示用户想用哪一档，不代表本机装着。探测把这两件事对上：
//! 没装却又开着外部语言服务档的，档位落回 `off`；`installed` 是在 PATH 与几个常用安装目录里扫出来的，全程不启进程
//! （只有 `rust-analyzer` 多跑一次 `--version`，因为 rustup 的 shim 会占住文件名而组件没装）。
//! 参照 `docs/features/lsp-language-servers/README.md` 的「探测与安装」。

use crate::error::{err, err_parts};
use crate::offload::block;
use crate::sys::hide_console;
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/// 探测结果缓存的有效时长。环境变化后要等它过期，或者让界面手动刷新一次。
const PROBE_TTL: Duration = Duration::from_secs(10);

/// 安装输出保留的尾部长度的字符数上限（约 32KB）。
const OUTPUT_TAIL: usize = 32 * 1024;

/// 一键安装的结果。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub command: String,
    /// 合起来的输出，只留尾部。
    pub output: String,
    /// 退出码；取不到为 null。
    pub exit_code: Option<i32>,
}

type Cache = Mutex<HashMap<String, (Instant, Option<String>)>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| Cache::new(HashMap::new()))
}

/// 锁被另一侧 panic 弄脏也要继续探测，不能让界面卡在「正在探测」。
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 按 `PATHEXT` 造候选文件名。
///
/// Windows 上 PATH 里能起来的程序一定带扩展名。npm 的 cmd-shim 会生成三份 `foo`
/// （无扩展名的 sh 脚本，给 Git Bash 之类用）、`foo.cmd`、`foo.ps1`，其中那份无扩展名的
/// `CreateProcess` 认不了，选中它就报 os error 193。所以裸名字不进候选，一律按 `PATHEXT`
/// 逐个补扩展名。`PATHEXT` 默认不含 `.ps1`，不补就会出现「探测说不存在、spawn 却能起来」。
fn candidates(program: &str) -> Vec<String> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if !cfg!(windows) {
        return vec![trimmed.to_string()];
    }
    if trimmed.contains('\\') || trimmed.contains('/') {
        return vec![trimmed.to_string()];
    }
    let pathext = std::env::var("PATHEXT")
        .ok()
        .filter(|value| value.contains('.'))
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
    let mut out: Vec<String> = Vec::new();
    for ext in pathext.split(';') {
        let ext = ext.trim();
        if !ext.is_empty() {
            out.push(format!("{trimmed}{ext}"));
        }
    }
    if !out
        .iter()
        .any(|item| item.eq_ignore_ascii_case(&format!("{trimmed}.PS1")))
    {
        out.push(format!("{trimmed}.PS1"));
    }
    out
}

/// 真正拿得来的目录列表：进程 PATH，再加上几个装完不会立刻进 PATH 的常用位置。
///
/// 候选表（拼 PATH + 去重）进程内算一次就够，但「这个目录现在在不在」每次现问：
/// `~/.cargo/bin`、`~/go/bin`、`%APPDATA%\npm` 正是装完才出现的，首轮就把它们筛掉的话，
/// 应用自己装进去的东西从此再也认不出来，而且没有恢复入口。
fn search_dirs() -> Vec<PathBuf> {
    static CANDIDATES: OnceLock<Vec<PathBuf>> = OnceLock::new();
    CANDIDATES
        .get_or_init(search_dirs_scan)
        .iter()
        .filter(|dir| dir.is_dir())
        .cloned()
        .collect()
}

/// 候选表保序：PATH 里的那几档要排在补的常用位置前面，命中优先级才和 shell 一致。
fn search_dirs_scan() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    if let Some(home) = home {
        #[cfg(windows)]
        {
            if let Some(app_data) = std::env::var_os("APPDATA") {
                dirs.push(PathBuf::from(app_data).join("npm"));
            }
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                dirs.push(
                    PathBuf::from(&local)
                        .join("Programs")
                        .join("Python")
                        .join("Launcher"),
                );
                dirs.push(
                    PathBuf::from(&local)
                        .join("Microsoft")
                        .join("WindowsApps"),
                );
            }
            dirs.push(home.join(".cargo").join("bin"));
            dirs.push(home.join("go").join("bin"));
        }
        #[cfg(not(windows))]
        {
            dirs.push(home.join(".local").join("bin"));
            dirs.push(home.join(".npm-global").join("bin"));
            dirs.push(home.join(".cargo").join("bin"));
            dirs.push(home.join("go").join("bin"));
            dirs.push(PathBuf::from("/usr/local/bin"));
            dirs.push(PathBuf::from("/opt/homebrew/bin"));
            dirs.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin"));
        }
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| seen.insert(dir.clone()));
    dirs
}

/// 把上面那些目录拼成一条 PATH，起进程时用它覆盖继承来的那份。
/// 每次现拼：里面装的目录会随安装动作变多，钉死了新装好的工具就进不了 server 的 PATH。
pub fn augmented_path() -> OsString {
    let dirs = search_dirs();
    if dirs.is_empty() {
        return std::env::var_os("PATH").unwrap_or_default();
    }
    std::env::join_paths(dirs.iter())
        .unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

/// 文件在，而且真能跑。
///
/// `rust-analyzer` 是唯一一个还要再问一次的：rustup 的 shim 占住文件名，
/// 组件没装时它启动就报 `Unknown binary` / `is not installed`。
fn is_functional(path: &Path, program: &str) -> bool {
    let name = program.trim();
    let looks_like_rust_analyzer = name == "rust-analyzer"
        || name.ends_with("/rust-analyzer")
        || name.ends_with("\\rust-analyzer")
        || name.ends_with("\\rust-analyzer.exe");
    if !looks_like_rust_analyzer {
        return true;
    }
    let mut command = Command::new(path);
    command
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    hide_console(&mut command);
    let Ok(output) = command.output() else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    !(stderr.contains("Unknown binary") || stderr.contains("is not installed"))
}

/// 解析出一个程序的可执行路径，没装着返回 `None`。带 10 秒缓存。
pub fn resolve_command(program: &str) -> Option<String> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return None;
    }
    let guard = lock(cache());
    if let Some((at, hit)) = guard.get(trimmed) {
        if at.elapsed() < PROBE_TTL {
            return hit.clone();
        }
    }
    drop(guard);

    let found = search_command(trimmed);
    lock(cache())
        .insert(trimmed.to_string(), (Instant::now(), found.clone()));
    found
}

/// 不带缓存的那段，方便单测直接喂一个目录列表。
fn search_command(program: &str) -> Option<String> {
    if program.contains('\\') || program.contains('/') {
        let path = Path::new(program);
        return (path.is_file() && is_functional(path, program))
            .then(|| program.to_string());
    }
    let names = candidates(program);
    for dir in search_dirs() {
        for name in &names {
            let full = dir.join(name);
            if full.is_file() && is_functional(&full, program) {
                return Some(full.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// 按块抽干管道，只保留最后 `keep` 字节：超了就丢头保尾，一次结算一批
/// （攒到两倍再裁回），免得每块都 memmove。全局安装几分钟能吐几十 MB
/// 进度输出，不该为了截 32KiB 尾巴把整包收进内存。
fn read_tail(mut reader: impl Read, keep: usize) -> Vec<u8> {
    let mut tail: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                tail.extend_from_slice(&chunk[..count]);
                if tail.len() > keep * 2 {
                    tail.drain(..tail.len() - keep);
                }
            }
        }
    }
    if tail.len() > keep {
        tail.drain(..tail.len() - keep);
    }
    tail
}

/// 用系统 shell 跑一行安装命令，输出只留尾部，不设超时（全局安装可能跑几分钟）。
///
/// 走 shell 是因为配置里那条本身就是多个包管理器串起来的容错链
/// （`npm install -g ... || pnpm add -g ...`），不是单个程序加参数。
fn run_install(line: &str) -> Result<InstallResult, String> {
    let (program, args) = if cfg!(windows) {
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        (comspec, vec!["/D".to_string(), "/C".to_string(), line.to_string()])
    } else {
        ("/bin/sh".to_string(), vec!["-c".to_string(), line.to_string()])
    };
    let mut command = Command::new(&program);
    command
        .args(&args)
        .env("PATH", augmented_path())
        // npm / pnpm / yarn 都是 Node 程序，从 VS Code 系编辑器终端启动时会继承 Node 调试注入
        // （`NODE_OPTIONS` 挂 js-debug bootloader、`VSCODE_INSPECTOR_OPTIONS`），装上后挂在调试
        // 等待上不干活。安装不是调试目标，摘掉这两条。理由同 `lsp.rs` 的 spawn_session。
        .env_remove("NODE_OPTIONS")
        .env_remove("VSCODE_INSPECTOR_OPTIONS")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    hide_console(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| err_parts("LSP_INSTALL_SPAWN", &[program, error.to_string()]))?;
    // 两条管道各由一个「保尾队列」抽干：stderr 挪去线程免得互相塞满，主线程收 stdout。
    let mut stderr_pipe = child.stderr.take().expect("install stderr piped");
    let stderr_task = std::thread::spawn(move || read_tail(&mut stderr_pipe, OUTPUT_TAIL));
    let mut stdout_pipe = child.stdout.take().expect("install stdout piped");
    let stdout_bytes = read_tail(&mut stdout_pipe, OUTPUT_TAIL);
    let stderr_bytes = stderr_task.join().unwrap_or_default();
    let status = child
        .wait()
        .map_err(|error| err_parts("LSP_INSTALL_SPAWN", &[error.to_string()]))?;
    let mut text = String::from_utf8_lossy(&stdout_bytes).to_string();
    let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();
    if !stderr.trim().is_empty() {
        text.push_str(if text.ends_with('\n') { "" } else { "\n" });
        text.push_str(&stderr);
    }
    if text.len() > OUTPUT_TAIL {
        // 按字节切会砍断多字节字符，退回按字符窗口取尾部。
        text = text.chars().rev().take(OUTPUT_TAIL).collect::<Vec<_>>().into_iter().rev().collect();
    }
    Ok(InstallResult {
        command: line.to_string(),
        output: text,
        exit_code: status.code(),
    })
}

/// 探一批 server 装没装，并把「开着外部档但没装」的那几项档位落回 `off`。
///
/// 只做单向校正：没装才关档，装上了不自动打开——用户可能故意留着关着的那一项。
/// 这条只在界面主动要探测时跑，不在应用启动时跑，免得每次开应用都改写配置。
#[tauri::command]
pub async fn lsp_probe(app: tauri::AppHandle) -> Result<crate::lsp_config::LspProbeReport, String> {
    block(move || Ok(probe_and_reconcile(&app))).await
}

/// 跑配置里那条 `installCommand`。没配的回 `LSP_NO_INSTALL`。
#[tauri::command]
pub async fn lsp_install(
    app: tauri::AppHandle,
    server: String,
) -> Result<InstallResult, String> {
    block(move || lsp_install_impl(app, server)).await
}

fn lsp_install_impl(app: tauri::AppHandle, server: String) -> Result<InstallResult, String> {
    let trimmed = server.trim();
    if trimmed.is_empty() {
        return Err(err("LSP_NO_SERVER", ""));
    }
    let config = crate::lsp_config::load(&app);
    let Some(entry) = config.servers.get(trimmed) else {
        return Err(err("LSP_NO_SERVER", trimmed));
    };
    let line = entry.install_command.trim();
    if line.is_empty() {
        return Err(err("LSP_NO_INSTALL", trimmed));
    }
    let done = run_install(line);
    // 跑过安装就把探测表清一次：里面还写着「没装」，前端紧接着那一轮 reprobe 会把档位
    // 改回 off 并写进配置——刚装好的工具等于被应用自己关掉。
    if done.is_ok() {
        lock(cache()).clear();
    }
    done
}

/// 探测并校正的那段，命令壳只做 `AppHandle` 解析。
fn probe_and_reconcile(app: &tauri::AppHandle) -> crate::lsp_config::LspProbeReport {
    let mut config = crate::lsp_config::load(app);
    let mut servers = Vec::new();
    let mut changed = false;
    for (id, entry) in &mut config.servers {
        let probe = resolve_command(&entry.effective_program());
        let installed = probe.is_some();
        // 只有外部档需要本机真装着；`builtin` 用的是 Monaco 自带的语义，不关装没装。
        if !installed && entry.mode == "lsp" {
            entry.mode = "off".to_string();
            changed = true;
        }
        servers.push(crate::lsp_config::LspServerProbe {
            id: id.clone(),
            program: entry.effective_program(),
            installed,
            path: probe.unwrap_or_default(),
        });
    }
    if changed {
        let _ = crate::lsp_config::save(app, &config);
    }
    crate::lsp_config::LspProbeReport { config, servers }
}
#[cfg(test)]
mod tests {
    use super::*;

    /// 丢头保尾：只要最后 `keep` 字节，且保持原顺序。
    #[test]
    fn read_tail_keeps_the_end_of_the_stream() {
        let mut data: Vec<u8> = Vec::new();
        for i in 0..(200 * 1024 / 4) {
            data.extend_from_slice(&(i as u32).to_le_bytes());
        }
        let tail = read_tail(data.as_slice(), 32 * 1024);
        assert_eq!(tail.len(), 32 * 1024);
        assert_eq!(tail, data[data.len() - 32 * 1024..]);
    }

    /// 真起 shell 验证安装输出链（本机有 node 时跑）：
    /// `cargo test --lib -- --ignored lsp_probe`。
    /// 走脚本文件而不是 `-e "…"`：cmd 的引号转义规则与 Command 的 MSVCRT 风格不一致，
    /// 测试要验的是「超大输出只留尾部」，不是引号玄学。
    #[test]
    #[ignore = "spawns node; run locally with --ignored"]
    fn install_output_survives_huge_stream() {
        let script = std::env::temp_dir().join("forge_install_smoke.js");
        std::fs::write(
            &script,
            "console.log('x'.repeat(300000)); console.error('e'.repeat(100));",
        )
        .unwrap();
        let line = format!("node {}", script.display());
        let result = run_install(&line).unwrap();
        let _ = std::fs::remove_file(&script);
        assert_eq!(result.exit_code, Some(0), "输出: {:?}", result.output);
        assert!(result.output.len() <= OUTPUT_TAIL + 8, "只留尾部: {}", result.output.len());
        assert!(result.output.trim_end().ends_with('e') || result.output.contains('x'));
    }

    /// 带路径分隔符的输入按显式路径处理，不去拼扩展名。
    #[test]
    fn explicit_path_is_one_candidate() {
        assert_eq!(candidates("C:\\tools\\gopls.exe"), vec!["C:\\tools\\gopls.exe".to_string()]);
    }

    /// 空串与纯空白不产生候选，省得去拼一个 `.EXE` 之类的怪东西。
    #[test]
    fn blank_program_has_no_candidate() {
        assert!(candidates("   ").is_empty());
    }

    /// 裸名字要能把 `.ps1` 补进候选：`PATHEXT` 默认不含它，npm 的 shim 却会生成它。
    #[test]
    fn ps1_is_added_even_when_pathext_omits_it() {
        let names = candidates("typescript-language-server");
        let has_ps1 = names
            .iter()
            .any(|item| item.eq_ignore_ascii_case("typescript-language-server.PS1"));
        assert!(has_ps1, "候选里没有 .ps1：{names:?}");
    }

    /// 裸名字（无扩展名的 sh 脚本）不进候选：`CreateProcess` 认不了它，选中就报 os error 193。
    #[test]
    fn bare_name_is_not_a_candidate() {
        let names = candidates("typescript-language-server");
        assert!(
            !names.iter().any(|item| item == "typescript-language-server"),
            "候选里混进了无扩展名的裸名字：{names:?}"
        );
        assert!(
            names.iter().all(|item| item.starts_with("typescript-language-server.")),
            "候选里出现了非该程序的项：{names:?}"
        );
    }

    /// 补 `.ps1` 也只补一条，别把同一个后缀重复挂上。
    #[test]
    fn ps1_is_not_duplicated() {
        let names = candidates("gopls");
        let ps1 = names
            .iter()
            .filter(|item| item.to_ascii_lowercase().ends_with(".ps1"))
            .count();
        assert!(ps1 <= 1, "候选里有多个 .ps1：{names:?}");
    }

    /// 增强过的 PATH 目录都是真实存在的目录，且不含空串。
    #[test]
    fn search_dirs_only_existing() {
        let dirs = search_dirs();
        assert!(dirs.iter().all(|dir| dir.is_dir()));
        assert!(!dirs.iter().any(|dir| dir.as_os_str().is_empty()));
    }

    /// 拼出来的 PATH 非空，起进程时拿它覆盖继承来的那份。
    #[test]
    fn augmented_path_is_not_empty() {
        assert!(!augmented_path().is_empty());
    }
}

