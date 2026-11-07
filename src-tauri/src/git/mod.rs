use crate::error::{err, err_parts};
use crate::offload::block_value;
use crate::sys::hide_console;

mod ignore_rules;

pub(crate) use ignore_rules::ignored_names_in_dir;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/// 锁被另一侧 panic 弄脏也要继续探测。
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 仓库根与远端名单的缓存时长。这两样只有加删远端或换工作树才会变，
/// 而每次 stage / commit / checkout 之后前端都要刷一整轮 git。
const PROBE_TTL: Duration = Duration::from_secs(10);

/// 仓库与工作区状态，前端据此决定 Git 面板是否可用。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitProbe {
    /// 能不能执行 git 可执行文件。
    pub available: bool,
    /// 工作区根（`git rev-parse --show-toplevel`）；不在仓库里时为 null。
    pub repo_root: Option<String>,
    /// 是否停在合并冲突中（.git/MERGE_HEAD 存在）。
    pub mid_merge: bool,
    /// 是否停在变基冲突中（.git/rebase-merge 或 rebase-apply 存在）。
    pub mid_rebase: bool,
    /// 是否停在摘取（cherry-pick）冲突中（.git/CHERRY_PICK_HEAD 存在）。
    pub mid_cherry_pick: bool,
    /// 是否停在还原（revert）冲突中（.git/REVERT_HEAD 存在）。
    pub mid_revert: bool,
    /// 配了哪些远端（`git remote`）；一个都没有时抓取那颗要置灰。
    pub remotes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    /// 相对仓库根的路径，一律用正斜杠（git 的输出格式）。
    pub path: String,
    /// 重命名/复制前的路径；其余情况为 null。
    pub old_path: Option<String>,
    /// 索引位（XY 的第一位）；未跟踪时为空串。
    pub index_status: String,
    /// 工作区位（XY 的第二位）；未跟踪时为空串。
    pub work_status: String,
    /// 未跟踪文件。
    pub untracked: bool,
    /// 未合并（冲突）。
    pub conflicted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// 当前分支名；游离 HEAD 时为 `(detached)`。
    pub branch: String,
    /// 是否游离在具名分支之外。
    pub detached: bool,
    /// 上游分支名；没有上游时为 null。
    pub upstream: Option<String>,
    /// 领先上游的提交数；无上游时为 0。
    pub ahead: i64,
    /// 落后上游的提交数；无上游时为 0。
    pub behind: i64,
    /// 变更清单，含未跟踪文件。
    pub changes: Vec<GitChange>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    /// 短名，例如 `main` 或 `origin/main`。
    pub name: String,
    /// 是否为当前分支。
    pub current: bool,
    /// 是否远程分支。
    pub remote: bool,
    /// 跟踪的上游分支短名；没有上游时为空串。
    pub upstream: String,
    /// 相对各自上游的同步数量；一次 for-each-ref 读取，避免逐分支起进程。
    pub ahead: u64,
    pub behind: u64,
    /// 是否为某个远端的默认分支，即 `<远端>/HEAD` 指向的那条。本地分支恒为 false。
    pub default_ref: bool,
}

/// 一个标签，来自 `for-each-ref refs/tags`。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTag {
    pub name: String,
    /// 指向的提交短哈希。
    pub target: String,
    /// 创建时间，Unix 毫秒；annotated 标签取打标签的时间。
    pub created_ms: i64,
}

/// 提交里改到的一个文件。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    /// 变更后的路径，正斜杠。
    pub path: String,
    /// 重命名/复制前的路径；其余为空串。
    pub old_path: String,
    /// porcelain 状态字母：M / A / D / R / T …；未知为空串。
    pub status: String,
    pub added: i64,
    pub removed: i64,
}

/// 一条提交的完整信息，日志右栏用。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetail {
    pub hash: String,
    pub short: String,
    pub author: String,
    /// 作者邮箱。
    pub email: String,
    /// 作者时间，Unix 毫秒。
    pub authored_ms: i64,
    pub subject: String,
    /// 标题行以下的正文。
    pub body: String,
    /// refs 标注，例如 `HEAD -> main, tag: v1.0.4`。
    pub refs: String,
    /// 父提交短哈希；根提交为空列表。
    pub parents: Vec<String>,
    /// 提交者姓名。作者和提交者在变基、代提交时不是同一个人。
    pub committer: String,
    /// 提交者邮箱。
    pub committer_email: String,
    /// 提交时间，Unix 毫秒。
    pub committed_ms: i64,
    pub files: Vec<GitCommitFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    /// 完整哈希。
    pub hash: String,
    /// 短哈希。
    pub short: String,
    /// 作者名。
    pub author: String,
    /// 作者时间，Unix 毫秒。
    pub authored_ms: i64,
    /// 标题行。
    pub subject: String,
    /// refs 标注，例如 `HEAD -> main`；没有时为空串。
    pub refs: String,
    /// 父提交的完整哈希，按 git 给出的顺序；根提交是空列表。合并提交有两条以上。
    pub parents: Vec<String>,
}

struct GitOutput {
    ok: bool,
    stdout: String,
    stderr: String,
}

/// 把一条同步 git 命令挪到阻塞线程池上跑。
///
/// 非 `async` 的 `#[tauri::command]` 在主线程执行：一次 `git status` 就把窗口冻住，
/// 网络那几条能冻好几秒。`Err` 只在线程 panic 时出现，折成 `GIT_SPAWN` 回前端。
async fn block<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| err("GIT_SPAWN", error.to_string()))?
}

/// 会动 index / 工作区 / ref 的子命令。
///
/// 命令改成 `async` 之后就没有「同步命令都在主线程上一条接一条」那层隐性串行：连点两次暂存、
/// 提交还在跑又点丢弃，都会并排放进 `.git` 撞同一个 `index.lock`，于是一次随机的红字报错。
/// 读命令带 `--no-optional-locks`，本来就不抢锁，照常并行，面板那一轮四条并发读不受影响。
/// 纯网络操作（fetch、push）不占本地索引锁，避免网络缓慢时连带锁死本地暂存与提交。
const MUTATING: &[&str] = &[
    "add", "am", "apply", "branch", "checkout", "cherry-pick", "clean", "commit", "gc",
    "init", "merge", "mv", "pull", "rebase", "reset", "restore", "revert", "rm", "stash",
    "switch", "symbolic-ref", "tag", "update-ref", "worktree",
];

/// 会动仓库的那几条排一队。子命令取参数里第一个不像选项的字段
/// （`-c core.editor=true merge --continue` 那种前置项要跳过）。
fn mutates_repo(args: &[&str]) -> bool {
    args.iter()
        .find(|arg| !arg.starts_with('-') && !arg.contains('='))
        .is_some_and(|verb| MUTATING.iter().any(|candidate| *candidate == *verb))
}

/// 写操作共用的排队锁。只在阻塞线程池里持有，不跨 `await`。
fn git_write_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    lock(LOCK.get_or_init(|| Mutex::new(())))
}

fn run_git(root: &Path, args: &[&str]) -> Result<GitOutput, String> {
    run_git_raw(root, args, None)
}

/// 需要把大清单从标准输入递过去的命令用（`--pathspec-from-file=-`）。
fn run_git_stdin(root: &Path, args: &[&str], input: &str) -> Result<GitOutput, String> {
    run_git_raw(root, args, Some(input))
}

/// 单条 git 命令 stdout/stderr 各自的驻留上限。行协议下这个量级意味着
/// 几十万条变更，面板早就渲染不动了——超限回错误码比无界驻留诚实。
const GIT_OUTPUT_CEILING: usize = 64 * 1024 * 1024;

/// 按块抽干一个管道，最多存 `ceiling` 字节；再多就只读不存——必须一路读到 EOF，
/// 否则对端塞满管道缓冲会卡死在写操作上。返回 (字节, 是否超限)。
#[cfg(test)]
fn read_capped(reader: &mut impl std::io::Read, ceiling: usize) -> (Vec<u8>, bool) {
    read_capped_output(reader, ceiling, None)
}

/// Git 用回车覆盖进度行；按字节保留跨块 UTF-8，超长单行丢弃到下个分隔符。
fn read_capped_output(reader: &mut impl std::io::Read, ceiling: usize, on_line: Option<&dyn Fn(String)>) -> (Vec<u8>, bool) {
    let mut bytes: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    let mut overflow = false;
    let mut pending = Vec::new();
    let mut oversized_line = false;
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                if let Some(send) = on_line {
                    for &byte in &chunk[..count] {
                        if byte == b'\r' || byte == b'\n' {
                            if !pending.is_empty() && !oversized_line {
                                send(String::from_utf8_lossy(&pending).into_owned());
                            }
                            pending.clear();
                            oversized_line = false;
                        } else if !oversized_line {
                            if pending.len() < 64 * 1024 { pending.push(byte); }
                            else { pending.clear(); oversized_line = true; }
                        }
                    }
                }
                if !overflow && bytes.len() + count <= ceiling {
                    bytes.extend_from_slice(&chunk[..count]);
                } else {
                    overflow = true;
                }
            }
        }
    }
    if !pending.is_empty() && !oversized_line {
        if let Some(send) = on_line { send(String::from_utf8_lossy(&pending).into_owned()); }
    }
    (bytes, overflow)
}

fn run_git_raw(root: &Path, args: &[&str], stdin: Option<&str>) -> Result<GitOutput, String> {
    run_git_raw_env(root, args, stdin, &[])
}

/// 同 run_git_raw，另注入临时环境变量（shelf 的临时索引用 `GIT_INDEX_FILE`）。
fn run_git_raw_env(
    root: &Path,
    args: &[&str],
    stdin: Option<&str>,
    extra_envs: &[(&str, &std::ffi::OsStr)],
) -> Result<GitOutput, String> {
    run_git_raw_env_output(root, args, stdin, extra_envs, None)
}

fn run_git_raw_env_output(
    root: &Path,
    args: &[&str],
    stdin: Option<&str>,
    extra_envs: &[(&str, &std::ffi::OsStr)],
    on_output: Option<tauri::ipc::Channel<String>>,
) -> Result<GitOutput, String> {
    // 读的一律放行，写的排队，免得两条同时落进 `.git` 撞锁。
    let _queued = mutates_repo(args).then(git_write_lock);
    run_git_unlocked(root, args, stdin, extra_envs, on_output)
}

/// 多步提交事务已持有写锁，内部命令不能再次获取同一把锁。
fn run_git_unlocked(
    root: &Path,
    args: &[&str],
    stdin: Option<&str>,
    extra_envs: &[(&str, &std::ffi::OsStr)],
    on_output: Option<tauri::ipc::Channel<String>>,
) -> Result<GitOutput, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        // 禁止终端交互式询问（账号密码、SSH 主机密钥确认等），缺失凭据时直接报错而不是挂起死锁
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(match stdin {
            // 标准输入置空，避免任何内部读取操作挂起；要喂数据的命令才接管道。
            Some(_) => std::process::Stdio::piped(),
            None => std::process::Stdio::null(),
        })
        // spawn + wait_with_output 不会自动接管管道（.output() 才会）：不显式
        // piped 的话子进程的输出直接漏进宿主终端，wait_with_output 读到的是
        // 空串，整块 git 面板就都「不是仓库」了。
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // 用户 shell 里残留的这几个变量会把子进程指到别的仓库，一律摘掉。
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        // 临时 index 等特殊调用从这里注入（在 env_remove 之后，能覆盖回 GIT_INDEX_FILE）。
        .envs(extra_envs.iter().copied())
        // 中文文件名保持原样输出，不要八进制转义。
        .args(["-c", "core.quotepath=false", "--no-optional-locks"])
        .args(args);
    // 主程序是 windows 子系统、没有控制台可继承：不设这个标志的话每个 git.exe
    // 都要自己新建一个控制台，启动那十几个进程就是十几个一闪而过的黑框。
    hide_console(&mut command);
    let mut child = command.spawn().map_err(|error| err("GIT_SPAWN", error))?;
    // 写 stdin 不能在主线程一次写完再读 stdout：git 的输出超过管道缓冲时，
    // 它卡在写 stdout、我们卡在写 stdin，两头互等就是死锁（文件树批量 check-ignore
    // 大目录必现）。写管道挪去线程，与 stdout/stderr 的抽干并发跑。
    let stdin_task = stdin.map(|input| {
        use std::io::Write;
        let input = input.to_string();
        let mut pipe = child.stdin.take().expect("git stdin piped");
        std::thread::spawn(move || {
            // 写失败（git 提前退出关了管道）不算错：命令的成败以退出码为准。
            let _ = pipe.write_all(input.as_bytes());
        })
    });
    let mut stdout_pipe = child.stdout.take().expect("git stdout piped");
    let mut stderr_pipe = child.stderr.take().expect("git stderr piped");
    // 两条管道都要有人抽干，git 才不会塞满管道卡死在写操作上；stderr 挪去线程，
    // 主线程收 stdout。超限的字节继续读但不再存，落定后再判超限。
    let stderr_channel = on_output.clone();
    let stderr_task = std::thread::spawn(move || {
        let send = |line| { if let Some(channel) = &stderr_channel { let _ = channel.send(line); } };
        read_capped_output(&mut stderr_pipe, GIT_OUTPUT_CEILING, stderr_channel.as_ref().map(|_| &send as &dyn Fn(String)))
    });
    let send = |line| { if let Some(channel) = &on_output { let _ = channel.send(line); } };
    let (stdout_bytes, stdout_over) = read_capped_output(&mut stdout_pipe, GIT_OUTPUT_CEILING, on_output.as_ref().map(|_| &send as &dyn Fn(String)));
    let (stderr_bytes, stderr_over) = match stderr_task.join() {
        Ok(pair) => pair,
        Err(_) => return Err(err("GIT_SPAWN", "git stderr reader panicked")),
    };
    if let Some(task) = stdin_task {
        if task.join().is_err() {
            return Err(err("GIT_SPAWN", "git stdin writer panicked"));
        }
    }
    let status = child.wait().map_err(|error| err("GIT_SPAWN", error))?;
    if stdout_over || stderr_over {
        let stream = if stdout_over { "stdout" } else { "stderr" };
        return Err(err("GIT_OUTPUT_TOO_LARGE", format!("{stream} > {} bytes", GIT_OUTPUT_CEILING)));
    }
    Ok(GitOutput {
        ok: status.success(),
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
    })
}

/// git 非 0 退出的错误体。只回 git 自己的原文，动词交给前端。
///
/// git 有时把说明写在 stdout（例如「nothing to commit」），stderr 是空的，
/// 所以两边都取一次，别把唯一的线索丢掉。
fn fail(output: &GitOutput) -> String {
    let stderr = output.stderr.trim();
    if !stderr.is_empty() {
        return err("GIT", stderr);
    }
    err("GIT", output.stdout.trim())
}

fn trim_line(value: &str) -> String {
    value.trim_end_matches(['\r', '\n']).to_string()
}

fn ensure_root(root: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(root);
    if !path.is_dir() {
        return Err(err("NO_REPO", root));
    }
    Ok(path)
}

/// 分段拆分，保持原始大小写，用于跨「git 给的正斜杠根」和「前端给的反斜杠绝对路径」安全截取。
fn raw_parts(path: &Path) -> Vec<String> {
    path.to_string_lossy()
        .replace('\\', "/")
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(String::from)
        .collect()
}

/// 绝对路径（或已是相对路径）转成相对仓库根的 git pathspec。
fn relative_path(root: &Path, absolute: &str) -> Result<String, String> {
    let target = Path::new(absolute);
    if let Ok(relative) = target.strip_prefix(root) {
        return Ok(relative.to_string_lossy().replace('\\', "/"));
    }
    // 已经是不带 .. 的相对路径时直接放行，避免传相对路径时被误判为不在仓库里。
    if target.is_relative() && !absolute.contains("..") && !absolute.is_empty() {
        return Ok(absolute.replace('\\', "/"));
    }
    let target_parts = raw_parts(target);
    let root_parts = raw_parts(root);
    // 跨盘符大小写（Windows 下 D:\ vs d:\）：比较前缀时忽略 ASCII 大小写，
    // 但截取相对路径必须保留原始大小写（如 App.tsx 而非 app.tsx），否则 Git 树查找会报文件不存在。
    if target_parts.len() > root_parts.len()
        && target_parts[..root_parts.len()]
            .iter()
            .zip(&root_parts)
            .all(|(t, r)| t.eq_ignore_ascii_case(r))
    {
        return Ok(target_parts[root_parts.len()..].join("/"));
    }
    Err(err_parts(
        "NOT_IN_REPO",
        &[absolute.to_string(), root.display().to_string()],
    ))
}

/// 探测仓库身份。
///
/// `rev-parse` 加 `remote` 两个子进程原本挡在每一轮刷新最前面，一次刷新就白多两个进程；
/// 仓库根与远端名单按 TTL 缓存。中间状态那四个标记每轮现查——那才是界面要看的
/// 「现在有没有停在冲突里」，缓存了会把合完的冲突继续报成没合完。
#[tauri::command]
pub async fn git_probe(path: String) -> GitProbe {
    block_value(move || git_probe_cached(path), GitProbe::unavailable).await
}

fn git_probe_cached(path: String) -> GitProbe {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, GitProbe)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    // Windows 下 D:\repo、d:\repo、D:/repo 是同一个目录，不归一的话每种写法
    // 各占一个缓存条目，TTL 内照样反复起 rev-parse。
    let key = probe_cache_key(&path);
    let base = {
        let hit = lock(cache)
            .get(&key)
            .filter(|(at, _)| at.elapsed() < PROBE_TTL)
            .map(|(_, probe)| probe.clone());
        match hit {
            Some(hit) => hit,
            None => {
                let probe = git_probe_impl(&path);
                // 只缓存认出库子的那份：git 临时不在 PATH、目录刚建好、杀毒软件拦一下这类
                // 瞬时失败要是记进表，内置终端里 `git init` 完界面还得挂着「不是仓库」10 秒。
                if probe.available && probe.repo_root.is_some() {
                    let mut cache = lock(cache);
                    // 过期的条目在写入时顺手删掉，而不是躺在表里等同名 key 覆盖：
                    // 关掉的工程再不会来读它，留着就是只增不减。
                    cache.retain(|_, (at, _)| at.elapsed() < PROBE_TTL);
                    cache.insert(key, (Instant::now(), probe.clone()));
                }
                probe
            }
        }
    };
    let mut probe = base;
    let Some(root) = probe.repo_root.clone() else {
        return probe;
    };
    let (mid_merge, mid_rebase, mid_cherry_pick, mid_revert) = in_progress(Path::new(&root));
    probe.mid_merge = mid_merge;
    probe.mid_rebase = mid_rebase;
    probe.mid_cherry_pick = mid_cherry_pick;
    probe.mid_revert = mid_revert;
    probe
}

impl GitProbe {
    /// 后端线程起不来时的兜底：整块 Git 界面按「不可用」画。
    fn unavailable() -> GitProbe {
        GitProbe {
            available: false,
            repo_root: None,
            mid_merge: false,
            mid_rebase: false,
            mid_cherry_pick: false,
            mid_revert: false,
            remotes: Vec::new(),
        }
    }
}

/// probe 缓存的键：Windows 上做斜杠与大小写归一，其余平台原样。
fn probe_cache_key(path: &str) -> String {
    #[cfg(windows)]
    {
        path.replace('/', "\\").to_lowercase()
    }
    #[cfg(not(windows))]
    {
        path.to_string()
    }
}

/// 获取真正的 .git 目录路径（处理 Worktree 与子模块中 .git 是文件的情况）。
fn resolve_git_dir(root: &Path) -> PathBuf {
    let git_path = root.join(".git");
    if git_path.is_file() {
        if let Ok(content) = std::fs::read_to_string(&git_path) {
            for line in content.lines() {
                if let Some(target) = line.trim().strip_prefix("gitdir:") {
                    let target_buf = PathBuf::from(target.trim());
                    return if target_buf.is_absolute() {
                        target_buf
                    } else {
                        root.join(target_buf)
                    };
                }
            }
        }
    }
    git_path
}

/// 四个中间状态一次 `read_dir` 读出来：分开问是五次路径查找。
/// 兼顾普通仓库与 Worktree / 子模块。
fn in_progress(root: &Path) -> (bool, bool, bool, bool) {
    let git_dir = resolve_git_dir(root);
    if let Ok(items) = std::fs::read_dir(&git_dir) {
        let names: HashSet<String> = items
            .filter_map(|item| item.ok())
            .map(|item| item.file_name().to_string_lossy().into_owned())
            .collect();
        return (
            names.contains("MERGE_HEAD"),
            names.contains("rebase-merge") || names.contains("rebase-apply"),
            names.contains("CHERRY_PICK_HEAD"),
            names.contains("REVERT_HEAD"),
        );
    }
    (
        git_dir.join("MERGE_HEAD").is_file(),
        git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir(),
        git_dir.join("CHERRY_PICK_HEAD").is_file(),
        git_dir.join("REVERT_HEAD").is_file(),
    )
}

fn git_probe_impl(path: &str) -> GitProbe {
    let start = PathBuf::from(path);
    // remote 不依赖仓库根：`git -C <子目录> remote` 与在根上跑结果一致。
    // Windows 上每条命令的进程启动就要 ~85ms，两条并行，探测不再串行付两次。
    let (root_result, remote_result) = std::thread::scope(|scope| {
        let root = scope.spawn(|| run_git(&start, &["rev-parse", "--show-toplevel"]));
        let remotes = scope.spawn(|| run_git(&start, &["remote"]));
        (root.join(), remotes.join())
    });
    let Some(probe) = root_result.ok().and_then(|result| result.ok()) else {
        return GitProbe::unavailable();
    };
    if !probe.ok {
        return GitProbe {
            available: true,
            repo_root: None,
            mid_merge: false,
            mid_rebase: false,
            mid_cherry_pick: false,
            mid_revert: false,
            remotes: Vec::new(),
        };
    }
    let root = trim_line(&probe.stdout);
    let remotes = remote_result
        .ok()
        .and_then(|result| result.ok())
        .map(|list| {
            list.stdout
                .lines()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    GitProbe {
        available: true,
        mid_merge: false,
        mid_rebase: false,
        mid_cherry_pick: false,
        mid_revert: false,
        repo_root: (!root.is_empty()).then_some(root),
        remotes,
    }
}

/// 解析 `git status --porcelain=v1 -z --branch` 的完整输出。
///
/// -z 下条目以 NUL 结尾，路径不做任何引号转义——含空格的文件名是原样字节而不是
/// C 字符串写法，porcelain v1 的非 z 模式从 git 2.29 起会给这类名字整段加引号，
/// 解析出带引号的路径回传 `git add` 就直接 pathspec 不匹配。重命名是
/// `R 新路径\0旧路径\0`：新路径跟在状态码后面，旧路径是下一个 NUL token。
fn parse_status(stdout: &str) -> GitStatus {
    let mut branch = String::from("(未知)");
    let mut detached = false;
    let mut upstream: Option<String> = None;
    let mut ahead = 0i64;
    let mut behind = 0i64;
    let mut changes: Vec<GitChange> = Vec::new();

    let mut tokens = stdout.split('\0').filter(|token| !token.is_empty());
    while let Some(token) = tokens.next() {
        // 分支头是一条 NUL token：`## master`、`## master...origin/main [ahead 1]`、
        // `## HEAD (no branch)`、`## No commits yet on master`。上游用 "..." 接在分支名后。
        if let Some(header) = token.strip_prefix("## ") {
            // 只领先或只落后时 git 只写那一项，所以按「词 数字」成对读，不假定顺序。
            if let Some((_, marks)) = header.split_once('[') {
                for part in marks.trim_end_matches(']').split(',') {
                    let mut fields = part.trim().split_whitespace();
                    let count = match (fields.next(), fields.next()) {
                        (Some(word), Some(value)) => (word, value.parse::<i64>().ok()),
                        _ => continue,
                    };
                    match count {
                        ("ahead", Some(value)) => ahead = value,
                        ("behind", Some(value)) => behind = value,
                        _ => {}
                    }
                }
            }
            let subject = header.split_once('[').map_or(header, |(before, _)| before);
            let (local, tracked) = match subject.split_once("...") {
                Some((name, up)) => (name, Some(up.trim())),
                None => (subject, None),
            };
            if let Some(value) = tracked.filter(|name| !name.is_empty()) {
                upstream = Some(value.to_string());
            }
            let tokens: Vec<&str> = local.split_whitespace().collect();
            match tokens.as_slice() {
                [] => {}
                ["HEAD", ..] => {
                    detached = true;
                    branch = "HEAD".to_string();
                }
                ["No", "commits", "yet", "on", name] => branch = (*name).to_string(),
                [name] => branch = (*name).to_string(),
                _ => {}
            }
            continue;
        }

        // porcelain v1 条目：两字状态 + 空格 + 路径。
        let codes = token.get(..2).unwrap_or("  ");
        let payload = token.get(3..).unwrap_or("");
        let conflicted = matches!(codes, "UU" | "AA" | "DD" | "AU" | "UA" | "DU" | "UD");

        let (path, old_path) = if codes.starts_with('R') || codes.starts_with('C') {
            // 重命名/复制：旧路径在下一个 NUL token 里，取不到就当普通条目。
            match tokens.next() {
                Some(old) => (payload, Some(old)),
                None => (payload, None),
            }
        } else {
            (payload, None)
        };

        // `!!` 是「被忽略」条目（`--ignored=matching` 带出来的），不是工作区变更：
        // 它由 parse_ignored 单独取走当忽略清单，这里必须丢掉，否则会被画成一条变更。
        if codes == "!!" {
            continue;
        }

        if codes == "??" {
            changes.push(GitChange {
                path: payload.to_string(),
                old_path: None,
                index_status: String::new(),
                work_status: String::new(),
                untracked: true,
                conflicted: false,
            });
            continue;
        }

        changes.push(GitChange {
            path: path.to_string(),
            old_path: old_path.map(str::to_string),
            index_status: codes.chars().next().unwrap_or(' ').to_string(),
            work_status: codes.chars().nth(1).unwrap_or(' ').to_string(),
            untracked: false,
            conflicted,
        });
    }

    changes.sort_by(|a, b| a.path.cmp(&b.path));

    GitStatus {
        branch,
        detached,
        upstream,
        ahead,
        behind,
        changes,
    }
}

/// 从 `git status --porcelain=v1 -z` 的输出里取被忽略的条目（`!! <路径>`）。
fn parse_ignored(stdout: &str) -> Vec<String> {
    stdout
        .split('\0')
        .filter(|token| token.len() > 3 && token.starts_with("!! "))
        .map(|token| token[3..].to_string())
        .collect()
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<GitStatus, String> {
    block(move || git_status_impl(root)).await
}

/// 读取一条 Git 配置。目前只开放提交检查用到的 `core.autocrlf`。
#[tauri::command]
pub async fn git_config_get(root: String, key: String) -> Result<String, String> {
    block(move || {
        if key != "core.autocrlf" {
            return Err(err("GIT", "unsupported config key"));
        }
        let root = ensure_root(&root)?;
        let output = run_git(&root, &["config", "--get", &key])?;
        if !output.ok {
            return Ok(String::new());
        }
        Ok(trim_line(&output.stdout))
    })
    .await
}

fn git_status_impl(root: String) -> Result<GitStatus, String> {
    let root = ensure_root(&root)?;
    let output = run_git(
        &root,
        &[
            "status",
            "--porcelain=v1",
            // -z：条目按 NUL 分隔且路径不做引号转义，含空格的文件名才不会变成带引号的字面量。
            "-z",
            "--branch",
            "--untracked-files=all",
            // 顺带把忽略清单带回来给 git_ignored 用：这趟目录遍历是两条命令共有的开销，
            // 实测单独跑 `--untracked-files=all` 与 `--ignored=matching` 各约 125ms，
            // 一起跑仍是 125ms。忽略清单不是变更，parse_status 会丢掉 `!!` 条目。
            "--ignored=matching",
        ],
    )?;
    if !output.ok {
        return Err(fail(&output));
    }
    // 先从原始输出里取忽略清单再解析变更：解析会消耗掉一份迭代器，两者互不影响。
    remember_ignored(&root, parse_ignored(&output.stdout));
    Ok(parse_status(&output.stdout))
}

/// 取某个版本下的文件内容，作为 diff 编辑器的基线一侧。
#[tauri::command]
pub async fn git_show(root: String, revision: String, path: String) -> Result<String, String> {
    block(move || git_show_impl(root, revision, path)).await
}

fn git_show_impl(root: String, revision: String, path: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    if !valid_rev(&revision) {
        return Err(err("BAD_REV", &revision));
    }
    let relative = relative_path(&root, &path)?;
    let spec = format!("{revision}:{relative}");
    let output = run_git(&root, &["show", "--textconv", spec.as_str()])?;
    if !output.ok {
        // 新增文件在基线里本就不存在，给空内容而不是报错。git 的报错文案随 locale
        // 翻译，不能嗅探「does not exist」；用退出码区分「rev 无效」与「rev 有效但文件不在」。
        let rev_alive = run_git(&root, &["cat-file", "-e", revision.as_str()])
            .map(|probe| probe.ok)
            .unwrap_or(false);
        let spec_missing = !run_git(&root, &["cat-file", "-e", spec.as_str()])
            .map(|probe| probe.ok)
            .unwrap_or(true);
        if rev_alive && spec_missing {
            return Ok(String::new());
        }
        return Err(fail(&output));
    }
    // git 对二进制 blob 一样往外吐字节：按内容实际探测（前 8KB 有 NUL 即二进制），
    // 别把乱码当正文端给比对视图。无扩展名、.gitattributes 标记的二进制都靠这里拦住。
    if output.stdout.as_bytes()[..output.stdout.len().min(8192)].contains(&0) {
        return Err(err("BINARY", &path));
    }
    Ok(output.stdout)
}

/// 索引里的内容（`git show :path`），「已暂存」那一侧的对比基线。
#[tauri::command]
pub async fn git_index_show(root: String, path: String) -> Result<String, String> {
    block(move || git_index_show_impl(root, path)).await
}

fn git_index_show_impl(root: String, path: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let relative = relative_path(&root, &path)?;
    let spec = format!(":{relative}");
    let output = run_git(&root, &["show", spec.as_str()])?;
    if !output.ok {
        // 报错文案随 locale 翻译不能嗅探；索引里没有这个文件时 cat-file 的退出码就是答案。
        let spec_missing = !run_git(&root, &["cat-file", "-e", spec.as_str()])
            .map(|probe| probe.ok)
            .unwrap_or(true);
        if spec_missing {
            return Ok(String::new());
        }
        return Err(fail(&output));
    }
    // 同 git_show：二进制 blob 按内容探测（前 8KB 有 NUL），不给比对视图端乱码。
    if output.stdout.as_bytes()[..output.stdout.len().min(8192)].contains(&0) {
        return Err(err("BINARY", &path));
    }
    Ok(output.stdout)
}

/// 超过这个条数就不再把路径拼进命令行：Windows 的 CreateProcess 有 32K 字符上限，
/// 「暂存全部」遇上几千个未跟踪文件会直接 spawn 失败。
const PATHSPEC_ARGV_LIMIT: usize = 100;

fn stage_paths(root: String, paths: &[String], unstage: bool) -> Result<(), String> {
    let root = ensure_root(&root)?;
    if paths.is_empty() {
        return Ok(());
    }
    let relatives: Vec<String> = paths
        .iter()
        .map(|path| relative_path(&root, path))
        .collect::<Result<_, _>>()?;
    // 未跟踪文件也要能暂存，所以用 add 而不是 add -u。
    let verb: &[&str] = if unstage {
        &["restore", "--staged"]
    } else {
        &["add"]
    };
    // 大清单走 stdin 的 pathspec 文件（NUL 分隔），git 2.26 起支持，路径原样传递。
    if relatives.len() > PATHSPEC_ARGV_LIMIT {
        let mut args: Vec<&str> = verb.to_vec();
        args.push("--pathspec-from-file=-");
        args.push("--pathspec-file-nul");
        let mut payload = String::new();
        for relative in &relatives {
            payload.push_str(relative);
            payload.push('\0');
        }
        let output = run_git_stdin(&root, &args, &payload)?;
        if !output.ok {
            return Err(fail(&output));
        }
        return Ok(());
    }
    let mut args: Vec<&str> = verb.to_vec();
    args.push("--");
    args.extend(relatives.iter().map(String::as_str));
    let output = run_git(&root, &args)?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    block(move || git_stage_impl(root, paths)).await
}

fn git_stage_impl(root: String, paths: Vec<String>) -> Result<(), String> {
    stage_paths(root, &paths, false)
}

#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    block(move || git_unstage_impl(root, paths)).await
}

fn git_unstage_impl(root: String, paths: Vec<String>) -> Result<(), String> {
    stage_paths(root, &paths, true)
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommitSource { Index, Worktree, WorktreeOnly }

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSelection {
    path: String,
    old_path: Option<String>,
    source: CommitSource,
}

#[tauri::command]
pub async fn git_commit(
    root: String,
    message: String,
    amend: bool,
    paths: Option<Vec<String>>,
    signoff: Option<bool>,
    author: Option<String>,
    no_verify: Option<bool>,
    selections: Option<Vec<CommitSelection>>,
) -> Result<String, String> {
    block(move || {
        git_commit_impl(
            root,
            message,
            amend,
            paths,
            signoff.unwrap_or(false),
            author,
            no_verify.unwrap_or(false),
            selections,
        )
    })
    .await
}

fn git_commit_impl(
    root: String,
    message: String,
    amend: bool,
    paths: Option<Vec<String>>,
    signoff: bool,
    author: Option<String>,
    no_verify: bool,
    selections: Option<Vec<CommitSelection>>,
) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let message = message.trim();
    // amend 可以只改父提交不带新说明（--no-edit），所以只有非 amend 才要求非空。
    if message.is_empty() && !amend {
        return Err(err("EMPTY_MESSAGE", ""));
    }
    let mut args: Vec<String> = if message.is_empty() {
        vec!["commit".into(), "--amend".into(), "--no-edit".into()]
    } else if amend {
        // 少了这个 -m，git 会把说明当成 pathspec 报「did not match any file(s)」。
        vec!["commit".into(), "--amend".into(), "-m".into(), message.to_string()]
    } else {
        vec!["commit".into(), "-m".into(), message.to_string()]
    };
    // 只透传 Sign-off、作者与跳过 hooks；提交说明清洗沿用 Git 配置。
    if signoff {
        args.push("--signoff".into());
    }
    if let Some(author) = author.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        args.push(format!("--author={author}"));
    }
    if no_verify {
        args.push("--no-verify".into());
    }
    if let Some(selections) = selections {
        if paths.as_ref().is_some_and(|paths| !paths.is_empty()) {
            return Err(err("BAD_COMMIT_SELECTION", "paths and selections are mutually exclusive"));
        }
        return commit_selected(&root, &args, &selections);
    }
    // --only：只提交点名的那几条路径（取工作区内容），索引里其它文件的已暂存块不动——
    // 提交面板的复选框勾选语义就是它：勾了的提交，没勾的连索引都不碰。
    let relatives: Vec<String>;
    if let Some(paths) = paths.filter(|list| !list.is_empty()) {
        args.push("--only".into());
        relatives = paths
            .iter()
            .map(|path| relative_path(&root, path))
            .collect::<Result<_, _>>()?;
        if relatives.len() > PATHSPEC_ARGV_LIMIT {
            args.push("--pathspec-from-file=-".into());
            args.push("--pathspec-file-nul".into());
            let mut payload = String::new();
            for relative in &relatives {
                payload.push_str(relative);
                payload.push('\0');
            }
            let refs: Vec<&str> = args.iter().map(String::as_str).collect();
            let output = run_git_stdin(&root, &refs, &payload)?;
            if !output.ok {
                return Err(fail(&output));
            }
            return Ok(trim_line(&output.stdout));
        }
        args.push("--".into());
        for relative in &relatives {
            args.push(relative.clone());
        }
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = run_git(&root, &refs)?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

/// 事务内部统一检查 Git 的退出码，不能把补丁失败当作空选择继续提交。
fn selected_git(root: &Path, args: &[&str], input: Option<&str>, index: Option<&TempIndex>) -> Result<String, String> {
    let env = index.map(TempIndex::envs);
    let output = run_git_unlocked(root, args, input, env.as_ref().map_or(&[], |env| &env[..]), None)?;
    if !output.ok { return Err(fail(&output)); }
    Ok(output.stdout)
}

fn real_index_path(root: &Path) -> Result<PathBuf, String> {
    let path = selected_git(root, &["rev-parse", "--git-path", "index"], None, None)?;
    let path = PathBuf::from(path.trim());
    Ok(if path.is_absolute() { path } else { root.join(path) })
}

/// 直接取选中来源的索引项，避免改名的旧路径与另一个新文件相互覆盖。
fn selected_path(root: &Path, index: &TempIndex, tree: &str, path: &str) -> Result<(), String> {
    let entry = selected_git(root, &["--literal-pathspecs", "ls-tree", "-rz", "--full-tree", tree, "--", path], None, None)?;
    let entry = if entry.is_empty() { format!("0 {}\t{path}\0", "0".repeat(tree.len())) } else { entry };
    selected_git(root, &["update-index", "-z", "--index-info"], Some(&entry), Some(index))?;
    Ok(())
}

/// C 是本次提交，J 是提交后的索引；J 保留未选内容，工作区文件不需要来回覆盖。
/// 调用方必须持有 git_write_lock，真实提交还须独占 Git 的 index.lock。
fn selected_indexes(root: &Path, selections: &[CommitSelection]) -> Result<(TempIndex, TempIndex), String> {
    let committed = TempIndex::new(root);
    let remaining = TempIndex::new(root);
    let index_path = real_index_path(root)?;
    match std::fs::copy(&index_path, &remaining.0) {
        Ok(_) => {},
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            selected_git(root, &["read-tree", "--empty"], None, Some(&remaining))?;
        },
        Err(error) => return Err(err("FS", error)),
    }
    let index_tree = selected_git(root, &["write-tree"], None, Some(&remaining))?;
    let mut seen = HashSet::new();
    let mut paths = Vec::with_capacity(selections.len());
    let mut working_paths = String::new();
    for selection in selections {
        let path = relative_path(root, &selection.path)?;
        if !seen.insert(path.clone()) { return Err(err("BAD_COMMIT_SELECTION", "duplicate path")); }
        let mut relatives = vec![path];
        if let Some(old) = selection.old_path.as_deref().filter(|old| !old.is_empty()) {
            let old = relative_path(root, old)?;
            if old != relatives[0] { relatives.push(old); }
        }
        if !matches!(selection.source, CommitSource::Index) {
            for (index, path) in relatives.iter().enumerate() {
                // 已暂存的改名在原索引中已没有旧路径，不把不存在的 pathspec 再交给 add。
                let tracked = index == 0 || run_git_unlocked(root, &["cat-file", "-e", &format!("{}:{path}", index_tree.trim())], None, &[], None)?.ok;
                if tracked { working_paths.push_str(path); working_paths.push('\0'); }
            }
        }
        paths.push(relatives);
    }
    // 只读一次所选工作区内容，C 与 J 从相同快照构造，避免分别 add 读到两份内容。
    if !working_paths.is_empty() {
        selected_git(root, &["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"], Some(&working_paths), Some(&remaining))?;
    }
    let working_tree = selected_git(root, &["write-tree"], None, Some(&remaining))?;
    if has_head(root)? {
        selected_git(root, &["read-tree", "HEAD"], None, Some(&committed))?;
    } else {
        selected_git(root, &["read-tree", "--empty"], None, Some(&committed))?;
    }
    for (selection, paths) in selections.iter().zip(&paths) {
        let tree = match selection.source {
            CommitSource::Index => index_tree.trim(),
            CommitSource::Worktree => working_tree.trim(),
            CommitSource::WorktreeOnly => continue,
        };
        selected_path(root, &committed, tree, &paths[0])?;
        for old in paths.iter().skip(1).filter(|old| !seen.contains(*old)) {
            selected_path(root, &committed, tree, old)?;
        }
    }
    for (selection, paths) in selections.iter().zip(&paths) {
        if !matches!(selection.source, CommitSource::WorktreeOnly) { continue; }
        let mut args = vec!["--literal-pathspecs", "diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", index_tree.trim(), working_tree.trim(), "--"];
        args.extend(paths.iter().map(String::as_str));
        let patch = selected_git(root, &args, None, None)?;
        if patch.is_empty() { continue; }
        if selected_git(root, &["apply", "--cached", "--whitespace=nowarn", "-"], Some(&patch), Some(&committed)).is_ok() { continue; }
        // 以原索引为基准重放 B，允许补丁上下文含 A；union/custom driver 不能把冲突变成成功。
        for path in paths {
            let attributes = selected_git(root, &["--literal-pathspecs", "check-attr", "-z", "merge", "--", path], None, None)?;
            if !matches!(attributes.split('\0').nth(2), Some("unspecified" | "set" | "text")) {
                return Err(err("PARTIAL_COMMIT_CONFLICT", &selection.path));
            }
        }
        let custom_text = run_git_unlocked(root, &["config", "--get", "merge.text.driver"], None, &[], None)?.ok;
        if custom_text || selected_git(root, &["-c", "merge.default=text", "-c", "merge.renormalize=false", "apply", "--cached", "--3way", "--whitespace=nowarn", "-"], Some(&patch), Some(&committed)).is_err() {
            return Err(err("PARTIAL_COMMIT_CONFLICT", &selection.path));
        }
    }
    Ok((committed, remaining))
}

/// 使用 Git 的锁文件协议，防止事务期间其他进程写真实索引。
struct CommitIndexLock { path: PathBuf, file: Option<std::fs::File>, installed: bool }

impl CommitIndexLock {
    fn acquire(index_path: &Path) -> Result<Self, String> {
        let mut name = index_path.as_os_str().to_os_string();
        name.push(".lock");
        let path = PathBuf::from(name);
        let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|error| err("GIT_INDEX_LOCK", error))?;
        Ok(Self { path, file: Some(file), installed: false })
    }
    fn prepare(&mut self, remaining: &TempIndex) -> Result<(), String> {
        let mut source = std::fs::File::open(&remaining.0).map_err(|error| err("FS", error))?;
        let file = self.file.as_mut().expect("index lock is open");
        file.set_len(0).map_err(|error| err("FS", error))?;
        std::io::Seek::seek(file, std::io::SeekFrom::Start(0)).map_err(|error| err("FS", error))?;
        std::io::copy(&mut source, file).map_err(|error| err("FS", error))?;
        file.sync_all().map_err(|error| err("FS", error))
    }
    fn install(mut self, index_path: &Path) -> Result<(), String> {
        self.file.take();
        std::fs::rename(&self.path, index_path).map_err(|error| err("COMMIT_INDEX_INSTALL", error))?;
        self.installed = true;
        Ok(())
    }
}

impl Drop for CommitIndexLock {
    fn drop(&mut self) {
        self.file.take();
        if !self.installed { let _ = std::fs::remove_file(&self.path); }
    }
}

fn commit_selected(root: &Path, args: &[String], selections: &[CommitSelection]) -> Result<String, String> {
    let _queued = git_write_lock();
    let index_path = real_index_path(root)?;
    let mut index_lock = CommitIndexLock::acquire(&index_path)?;
    let (committed, mut remaining) = selected_indexes(root, selections)?;
    let expected_tree = selected_git(root, &["write-tree"], None, Some(&committed))?;
    // 提交前准备好剩余索引并落盘，hooks 或 commit 失败时只移除我们自己的锁文件。
    index_lock.prepare(&remaining)?;
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = selected_git(root, &refs, None, Some(&committed))?;
    // 提交已经完成：后续失败必须保留恢复索引，不能把它随临时文件一起清掉。
    remaining.1 = true;
    let finish = || -> Result<(), String> {
        let actual_tree = selected_git(root, &["write-tree"], None, Some(&committed))?;
        if actual_tree != expected_tree {
            // 保留 hook 对索引的修改，同时保留未被选中的原暂存内容。
            let patch = selected_git(root, &["diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", expected_tree.trim(), actual_tree.trim()], None, None)?;
            selected_git(root, &["apply", "--cached", "--whitespace=nowarn", "-"], Some(&patch), Some(&remaining))?;
            index_lock.prepare(&remaining)?;
        }
        index_lock.install(&index_path)
    };
    finish().map_err(|error| err_parts("COMMIT_INDEX_RECOVERY", &[remaining.0.to_string_lossy().into_owned(), error]))?;
    remaining.1 = false;
    Ok(trim_line(&output))
}

/// 把一份统一差异打进去：cached=true 只动索引（按块暂存），false 落到工作区（按块回退）；
/// reverse=true 反着打（`-R`，把补丁里的新增删回去）。
#[tauri::command]
pub async fn git_apply_patch(
    root: String,
    patch: String,
    cached: bool,
    reverse: bool,
) -> Result<(), String> {
    block(move || git_apply_patch_impl(root, patch, cached, reverse)).await
}

fn git_apply_patch_impl(root: String, patch: String, cached: bool, reverse: bool) -> Result<(), String> {
    let root = ensure_root(&root)?;
    if patch.trim().is_empty() {
        return Ok(());
    }
    // 按块补丁是零上下文的（见 src/lib/cm/chunkPatch.ts）：没有上下文行时 git 的模糊
    // 定位会失效并报 "patch does not apply"，必须显式声明 `--unidiff-zero`。
    let mut args: Vec<&str> = vec!["apply", "--whitespace=nowarn", "--unidiff-zero"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    args.push("-");
    let output = run_git_stdin(&root, &args, &patch)?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(())
}

/// 网络类操作共用的执行体：把 stderr 一并回给前端，进度文案都在那里。
fn remote_op(root: &Path, args: &[&str]) -> Result<String, String> {
    remote_op_output(root, args, None)
}

fn remote_op_output(root: &Path, args: &[&str], on_output: Option<tauri::ipc::Channel<String>>) -> Result<String, String> {
    let output = run_git_raw_env_output(root, args, None, &[], on_output)?;
    if !output.ok {
        return Err(fail(&output));
    }
    let detail = output.stderr.trim();
    Ok(if detail.is_empty() {
        trim_line(&output.stdout)
    } else {
        detail.to_string()
    })
}

#[tauri::command]
pub async fn git_fetch(webview: tauri::Webview, root: String, on_output: Option<tauri::ipc::JavaScriptChannelId>) -> Result<String, String> {
    // 可选 Channel 先反序列化为 ID；Option<Channel<T>> 不实现 Tauri 的 CommandArg。
    let on_output = on_output.map(|id| id.channel_on::<_, String>(webview));
    block(move || git_fetch_impl(root, on_output)).await
}

fn git_fetch_impl(root: String, on_output: Option<tauri::ipc::Channel<String>>) -> Result<String, String> {
    let root = ensure_root(&root)?;
    // IDEA 的抓取也是每个远端一次并带 --prune；标签不单独强拉，跟着 git 的默认走。
    remote_op_output(&root, &["fetch", "--all", "--prune", "--progress"], on_output)
}

/// 拉取。没有上游的分支 git 会直接拒绝，把原因回给用户而不是替他猜。
#[tauri::command]
pub async fn git_pull(webview: tauri::Webview, root: String, method: Option<String>, on_output: Option<tauri::ipc::JavaScriptChannelId>) -> Result<String, String> {
    let on_output = on_output.map(|id| id.channel_on::<_, String>(webview));
    block(move || git_pull_output(root, method.as_deref().unwrap_or("merge"), on_output)).await
}

#[cfg(test)]
fn git_pull_impl(root: String, method: &str) -> Result<String, String> {
    git_pull_output(root, method, None)
}

fn git_pull_output(root: String, method: &str, on_output: Option<tauri::ipc::Channel<String>>) -> Result<String, String> {
    let root = ensure_root(&root)?;
    // 只允许表单公开的三种策略；先校验再抓取，非法参数不能产生远端副作用。
    let integrate: &[&str] = match method {
        "ff-only" => &["merge", "--ff-only", "--autostash", "@{upstream}"],
        "merge" => &["merge", "--ff", "--no-edit", "--autostash", "@{upstream}"],
        "rebase" => &["rebase", "--autostash", "@{upstream}"],
        _ => return Err(err("BAD_UPDATE_METHOD", method)),
    };
    // 拆成 fetch + merge 两段：fetch 不在 MUTATING 名单里、不占本地写锁，
    // 网络再慢也只是它自己在等；整条 `pull` 占着写锁的话，一次凭据弹窗
    // 能把全应用的暂存 / 提交 / 切分支全部堵在队列里。语义与 pull --ff-only 一致。
    let fetched = remote_op_output(&root, &["fetch", "--all", "--prune", "--progress"], on_output.clone())?;
    let merged = remote_op_output(&root, integrate, on_output)?;
    // merge 的自动暂存恢复冲突可能仍返回 0；此时不能报告成功或继续重推。
    let unresolved = run_git(&root, &["diff", "--name-only", "--diff-filter=U"])?;
    if !unresolved.ok { return Err(fail(&unresolved)); }
    if !unresolved.stdout.trim().is_empty() { return Err(err("GIT", &merged)); }
    let mut parts: Vec<&str> = vec![fetched.trim(), merged.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect();
    parts.dedup();
    Ok(parts.join("\n"))
}

/// 未签出的分支只快进引用；Git 同时拒绝更新任一工作树中已签出的分支。
#[tauri::command]
pub async fn git_update_branch(webview: tauri::Webview, root: String, branch: String, on_output: Option<tauri::ipc::JavaScriptChannelId>) -> Result<String, String> {
    let on_output = on_output.map(|id| id.channel_on::<_, String>(webview));
    block(move || git_update_branch_impl(root, branch, on_output)).await
}

fn git_update_branch_impl(root: String, branch: String, on_output: Option<tauri::ipc::Channel<String>>) -> Result<String, String> {
    let root = ensure_root(&root)?;
    if !valid_branch_name(&branch) { return Err(err("BAD_BRANCH", &branch)); }
    let destination = resolve_push_target(&root, Some(&branch))?;
    if !destination.tracked { return Err(err("GIT", "Branch has no tracked branch")); }
    let refspec = format!("refs/heads/{}:refs/heads/{branch}", destination.target);
    remote_op_output(&root, &["fetch", "--progress", "--", &destination.remote, &refspec], on_output)
}

#[derive(Default, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct GitPushOptions {
    branch: Option<String>,
    remote: Option<String>,
    target: Option<String>,
    revision: Option<String>,
    force_with_lease: bool,
    set_upstream: bool,
    tags: Option<PushTags>,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum PushTags { All, CurrentBranch }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushTarget {
    branch: String,
    remote: String,
    target: String,
    tracked: bool,
}

/// 目标来自 Git 的配置字段，不能按 upstream 的显示短名拆分远端。
#[tauri::command]
pub async fn git_push_target(root: String, branch: Option<String>) -> Result<GitPushTarget, String> {
    block(move || resolve_push_target(&ensure_root(&root)?, branch.as_deref())).await
}

fn resolve_push_target(root: &Path, branch: Option<&str>) -> Result<GitPushTarget, String> {
    let head = run_git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    let branch = branch.map(str::to_string).unwrap_or_else(|| trim_line(&head.stdout));
    if branch.is_empty() { return Err(err("DETACHED_PUSH", "")); }
    let source = format!("refs/heads/{branch}");
    let head = run_git(root, &["show-ref", "--verify", &source])?;
    if !head.ok {
        return Err(fail(&head));
    }
    let configured_remote = run_git(root, &["config", "--get", &format!("branch.{branch}.remote")])?;
    let configured_merge = run_git(root, &["config", "--get", &format!("branch.{branch}.merge")])?;
    let remote = trim_line(&configured_remote.stdout);
    let merge = trim_line(&configured_merge.stdout);
    let remotes = git_remotes_impl(root.to_string_lossy().into_owned())?;
    let tracked = configured_remote.ok && configured_merge.ok && remote != "." &&
        remotes.contains(&remote) && merge.starts_with("refs/heads/");
    let remote = if tracked { remote } else {
        remotes.iter().find(|name| name.as_str() == "origin").or_else(|| remotes.first())
            .cloned().ok_or_else(|| err("NO_REMOTE", ""))?
    };
    // 只接受已配置远端；禁止把 URL、路径或命令选项当作远端透传。
    if !remotes.contains(&remote) { return Err(err("NO_REMOTE", &remote)); }
    let target = if tracked { merge["refs/heads/".len()..].to_string() } else { branch.clone() };
    Ok(GitPushTarget { branch, remote, target, tracked })
}

#[tauri::command]
pub async fn git_push(webview: tauri::Webview, root: String, options: GitPushOptions, on_output: Option<tauri::ipc::JavaScriptChannelId>) -> Result<String, String> {
    let on_output = on_output.map(|id| id.channel_on::<_, String>(webview));
    block(move || git_push_output(root, options, on_output)).await
}

fn git_push_impl(root: String, options: GitPushOptions) -> Result<String, String> {
    git_push_output(root, options, None)
}

fn git_push_output(root: String, options: GitPushOptions, on_output: Option<tauri::ipc::Channel<String>>) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let destination = resolve_push_target(&root, options.branch.as_deref())?;
    let remote = options.remote.as_deref().unwrap_or(&destination.remote);
    let target = options.target.as_deref().unwrap_or(&destination.target);
    let remotes = git_remotes_impl(root.to_string_lossy().into_owned())?;
    if !remotes.iter().any(|name| name == remote) { return Err(err("NO_REMOTE", remote)); }
    let target_ref = format!("refs/heads/{target}");
    if !valid_branch_name(target) || !run_git(&root, &["check-ref-format", &target_ref])?.ok {
        return Err(err("BAD_BRANCH", target));
    }
    let branch_ref = format!("refs/heads/{}", destination.branch);
    let mut source = branch_ref.clone();
    if let Some(revision) = &options.revision {
        if !valid_rev(revision) { return Err(err("BAD_REV", revision)); }
        let resolved = run_git(&root, &["rev-parse", "--verify", &format!("{revision}^{{commit}}")])?;
        if !resolved.ok { return Err(fail(&resolved)); }
        source = trim_line(&resolved.stdout);
        if !run_git(&root, &["merge-base", "--is-ancestor", &source, &branch_ref])?.ok {
            return Err(err("BAD_REV", revision));
        }
    }
    let spec = format!("{source}:{target_ref}");
    let mut args = vec!["push", "--progress"];
    if options.force_with_lease { args.push("--force-with-lease"); }
    // 部分历史推送不能把较早的提交误设为整条本地分支的跟踪关系。
    if options.revision.is_none() && (options.set_upstream || !destination.tracked) { args.push("--set-upstream"); }
    if matches!(options.tags, Some(PushTags::CurrentBranch)) { args.push("--follow-tags"); }
    args.extend(["--", remote, &spec]);
    let detail = remote_op_output(&root, &args, on_output.clone())?;
    // 全部标签单独推送，分支强制选项不传播给标签。
    if matches!(options.tags, Some(PushTags::All)) {
        let tags = remote_op_output(&root, &["push", "--progress", "--tags", "--", remote], on_output)?;
        return Ok(format!("{detail}\n{tags}"));
    }
    Ok(detail)
}

/// 打标签。`revision` 空串打在 HEAD 上；annotated 消息为空时退回轻量标签。
#[tauri::command]
pub async fn git_create_tag(
    root: String,
    name: String,
    message: String,
    revision: String,
) -> Result<String, String> {
    block(move || git_create_tag_impl(root, name, message, revision)).await
}

fn git_create_tag_impl(
    root: String,
    name: String,
    message: String,
    revision: String,
) -> Result<String, String> {
    let root = ensure_root(&root)?;
    if !valid_branch_name(&name) {
        return Err(err("BAD_TAG", &name));
    }
    if !revision.is_empty() && !valid_rev(&revision) {
        return Err(err("BAD_REV", &revision));
    }
    let message = message.trim();
    let mut args: Vec<&str> = vec!["tag"];
    if !message.is_empty() {
        args.push("-a");
    }
    args.push(name.as_str());
    if !message.is_empty() {
        args.extend(["-m", message]);
    }
    if !revision.is_empty() {
        args.push(revision.as_str());
    }
    let output = run_git(&root, &args)?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(name)
}

/// 一次 `for-each-ref` 取回的全部分支与标签。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRefs {
    pub branches: Vec<GitBranch>,
    pub tags: Vec<GitTag>,
}

/// 解析分支与标签合并的 `for-each-ref` 输出，每行
/// `HEAD 标记<SEP>全名<SEP>上游短名<SEP>符号引用目标<SEP>目标对象<SEP>创建时间`。
///
/// 这里不能图省事用 `%(refname:short)` 认分支：git 会把 `refs/remotes/origin/HEAD`
/// 折成 `origin`，那条符号引用就冒充成一支远程分支，每个远端都多出一条不存在的分支。
/// `<远端>/HEAD` 只用来标默认分支，不进列表。
///
/// 字段第一位是 `%(HEAD)`：当前分支那行是 `*`，其余是空格。之前要再补一条
/// `rev-parse --abbrev-ref HEAD` 才知道哪支是当前，而本地/远程/标签还得各起一轮
/// `for-each-ref`——凑齐这张表要三个 git 进程，每次刷新都付一遍（Windows 上每起一个
/// 进程约 100ms，并发也省不掉那三次进程创建）。
fn parse_refs(stdout: &str) -> GitRefs {
    let mut branches: Vec<GitBranch> = Vec::new();
    let mut tags: Vec<GitTag> = Vec::new();
    let mut defaults: Vec<String> = Vec::new();
    for line in stdout.lines() {
        // 逐字段 trim：整行 trim 会把开头那个代表「不是当前」的空格字段一起吃掉，字段就错位了。
        let mut fields = line.split('\u{1f}').map(str::trim);
        let (Some(mark), Some(full), Some(upstream), Some(symref)) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        // 标签那两列缺失就是空串，分支行用不到它们，别因此把分支整行丢掉。
        let target = fields.next().unwrap_or("");
        let created = fields.next().unwrap_or("");
        let track = fields.next().unwrap_or("");
        let count = |key: &str| track.trim_matches(['[', ']']).split(',')
            .find_map(|part| part.trim().strip_prefix(key)?.parse::<u64>().ok()).unwrap_or(0);

        if let Some(name) = full.strip_prefix("refs/tags/").filter(|name| !name.is_empty()) {
            // 附注标签的 objectname 是标签对象自己的哈希，点层（*objectname）才是它指向的提交；
            // 轻量标签没有标签对象，点层为空，退回原值。目标或时间读不出来就不展示这一条。
            let Ok(created) = created.parse::<i64>() else {
                continue;
            };
            if target.is_empty() {
                continue;
            }
            tags.push(GitTag {
                name: name.to_string(),
                target: target.to_string(),
                created_ms: created * 1000,
            });
            continue;
        }

        let is_current = mark == "*";
        let (prefix, remote) = if full.starts_with("refs/heads/") {
            ("refs/heads/", false)
        } else if full.starts_with("refs/remotes/") {
            ("refs/remotes/", true)
        } else {
            continue;
        };
        let Some(name) = full.strip_prefix(prefix).filter(|name| !name.is_empty()) else {
            continue;
        };
        if remote && name.ends_with("/HEAD") {
            // 目标同样是全名，切完才是列表里那支的名字。
            if let Some(target) = symref.strip_prefix(prefix) {
                if !target.is_empty() {
                    defaults.push(target.to_string());
                }
            }
            continue;
        }
        branches.push(GitBranch {
            name: name.to_string(),
            current: !remote && is_current,
            remote,
            upstream: upstream.to_string(),
            ahead: if remote { 0 } else { count("ahead ") },
            behind: if remote { 0 } else { count("behind ") },
            default_ref: false,
        });
    }
    for branch in &mut branches {
        branch.default_ref = defaults.contains(&branch.name);
    }
    GitRefs { branches, tags }
}

#[tauri::command]
pub async fn git_refs(root: String) -> Result<GitRefs, String> {
    block(move || git_refs_impl(root)).await
}

fn git_refs_impl(root: String) -> Result<GitRefs, String> {
    let root = ensure_root(&root)?;
    // for-each-ref 没有 -z；ref 名不会含换行。字段之间用 %1F 分隔，
    // 上游、符号引用、目标对象、创建时间缺失时该字段就是空串，正好落到后面的解析里。
    // 分支与标签共用一趟：两类格式串拼在一起，按全名前缀分流。
    let output = run_git(
        &root,
        &[
            "for-each-ref",
            "--format=%(HEAD)%1F%(refname)%1F%(upstream:short)%1F%(symref)%1F%(if)%(*objectname)%(then)%(*objectname:short)%(else)%(objectname:short)%(end)%1F%(creatordate:unix)%1F%(upstream:track)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(parse_refs(&output.stdout))
}

/// 远端名列表，推送时取第一个作缺省目标。
#[tauri::command]
pub async fn git_remotes(root: String) -> Result<Vec<String>, String> {
    block(move || git_remotes_impl(root)).await
}

fn git_remotes_impl(root: String) -> Result<Vec<String>, String> {
    let root = ensure_root(&root)?;
    let output = run_git(&root, &["remote"])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(output
        .stdout
        .lines()
        .map(trim_line)
        .filter(|name| !name.is_empty())
        .collect())
}

/// 忽略清单的时效兜底。规则文件变动由前端显式作废（`git_forget_ignored`）；
/// 万一那次作废没送到（前端没起来、调用失败），最多陈旧这么久。
const IGNORED_TTL: Duration = Duration::from_secs(10);

fn ignored_cache() -> &'static Mutex<HashMap<String, (Instant, Vec<String>)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Vec<String>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 记下这趟扫描看到的忽略清单；过期的条目顺手清掉（关掉的工程不会再来读它）。
fn remember_ignored(root: &Path, list: Vec<String>) {
    let key = probe_cache_key(&root.to_string_lossy());
    let mut cache = lock(ignored_cache());
    cache.retain(|_, (at, _)| at.elapsed() < IGNORED_TTL);
    cache.insert(key, (Instant::now(), list));
}

/// 取最近一趟扫描留下的忽略清单；没有或过期给 None。
fn cached_ignored(root: &Path) -> Option<Vec<String>> {
    let key = probe_cache_key(&root.to_string_lossy());
    lock(ignored_cache())
        .get(&key)
        .filter(|(at, _)| at.elapsed() < IGNORED_TTL)
        .map(|(_, list)| list.clone())
}

/// 规则文件变了：丢掉这份清单，下次 `git_ignored` 重新扫。
fn forget_ignored(root: &Path) {
    let key = probe_cache_key(&root.to_string_lossy());
    lock(ignored_cache()).remove(&key);
}

/// 被 .gitignore 忽略的路径，「显示忽略文件」开关用。
#[tauri::command]
pub async fn git_ignored(root: String) -> Result<Vec<String>, String> {
    block(move || git_ignored_impl(root)).await
}

fn git_ignored_impl(root: String) -> Result<Vec<String>, String> {
    let root = ensure_root(&root)?;
    // 刚刷过的 git_status 已经把清单带回来了，别再起一个进程走第二趟遍历。
    if let Some(list) = cached_ignored(&root) {
        return Ok(list);
    }
    // -z：与 git_status 同理，含空格的忽略路径不做引号转义。
    let output = run_git(&root, &["status", "--porcelain=v1", "-z", "--ignored=matching"])?;
    if !output.ok {
        return Err(fail(&output));
    }
    let list = parse_ignored(&output.stdout);
    // 自己扫的这一趟也记下来：同一份不变式——缓存就是「最近一趟扫描看到的东西」。
    remember_ignored(&root, list.clone());
    Ok(list)
}

/// `.gitignore` / `.git/info/exclude` 一类规则文件变了：作废忽略清单，下次重新扫。
#[tauri::command]
pub async fn git_forget_ignored(root: String) -> Result<(), String> {
    block(move || {
        forget_ignored(&ensure_root(&root)?);
        Ok(())
    })
    .await
}

/// 分支名字符集校验：只放常见写法，且不能以 - 或 . 开头被当成选项或非法 ref。
fn valid_branch_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && !name.starts_with('.')
        && !name.contains("..")
        && !name.ends_with('/')
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
}

#[tauri::command]
pub async fn git_checkout(root: String, branch: String) -> Result<String, String> {
    block(move || git_checkout_impl(root, branch)).await
}

fn git_checkout_impl(root: String, branch: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    // 分支名或版本引用（commit hash / 标签 / 相对引用）均可检出
    if !valid_branch_name(&branch) && !valid_rev(&branch) {
        return Err(err("BAD_BRANCH", &branch));
    }
    let output = run_git(&root, &["checkout", branch.as_str()])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stderr))
}

/// 新建分支。`from` 非空时从那条引用起，否则从当前 HEAD 起；checkout=true 顺带切过去。
#[tauri::command]
pub async fn git_create_branch(
    root: String,
    name: String,
    from: String,
    checkout: bool,
) -> Result<String, String> {
    block(move || git_create_branch_impl(root, name, from, checkout)).await
}

fn git_create_branch_impl(
    root: String,
    name: String,
    from: String,
    checkout: bool,
) -> Result<String, String> {
    let root = ensure_root(&root)?;
    if !valid_branch_name(&name) {
        return Err(err("BAD_BRANCH", &name));
    }
    if !from.is_empty() && !valid_rev(&from) {
        return Err(err("BAD_REV", &from));
    }
    let start = if from.is_empty() { None } else { Some(from.as_str()) };
    let args: Vec<&str> = match (checkout, start) {
        (true, Some(at)) => vec!["checkout", "-b", name.as_str(), at],
        (true, None) => vec!["checkout", "-b", name.as_str()],
        (false, Some(at)) => vec!["branch", name.as_str(), at],
        (false, None) => vec!["branch", name.as_str()],
    };
    let output = run_git(&root, &args)?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(if checkout { &output.stderr } else { &output.stdout }))
}

/// 把 `name` 合并进当前分支。`--no-edit` 让 git 用自己的合并说明，不弹编辑器。
#[tauri::command]
pub async fn git_merge(root: String, name: String) -> Result<String, String> {
    block(move || git_merge_impl(root, name)).await
}

fn git_merge_impl(root: String, name: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    if !valid_branch_name(&name) {
        return Err(err("BAD_REV", &name));
    }
    let output = run_git(&root, &["merge", "--no-edit", name.as_str()])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

/// 当前分支变基到 `onto`。
#[tauri::command]
pub async fn git_rebase(root: String, onto: String) -> Result<String, String> {
    block(move || git_rebase_impl(root, onto)).await
}

fn git_rebase_impl(root: String, onto: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    if !valid_branch_name(&onto) {
        return Err(err("BAD_REV", &onto));
    }
    let output = run_git(&root, &["rebase", onto.as_str()])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

/// Stash 列表，最新在前（stash@{0}）：
/// 一条 reflog 读出来拆字段，消息里自带的分隔符用单元分隔符（%x1f）隔开不受干扰。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStash {
    /// 序号，即 `stash@{index}` 里的 index。
    pub index: u32,
    /// reflog subject，git 自己的「WIP on main: 1a2b3c4 …」或用户消息。
    pub message: String,
    /// 入栈时间（Unix 秒）。
    pub time_ms: i64,
}

fn git_stash_list_impl(root: String) -> Result<Vec<GitStash>, String> {
    let root = ensure_root(&root)?;
    let output = run_git(&root, &["stash", "list", "--format=%gd%x1f%gs%x1f%ct"])?;
    if !output.ok {
        return Err(fail(&output));
    }
    let mut out = Vec::new();
    for line in output.stdout.lines() {
        let mut parts = line.split('\u{1f}');
        let (Some(rev), Some(message), Some(time)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        // rev 形如 stash@{3}：只留花括号里的序号。
        let index: u32 = rev
            .split_once('{')
            .and_then(|(_, tail)| tail.trim_end_matches('}').parse().ok())
            .unwrap_or(out.len() as u32);
        out.push(GitStash {
            index,
            message: message.to_string(),
            time_ms: time.trim().parse::<i64>().unwrap_or(0) * 1000,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn git_stash_list(root: String) -> Result<Vec<GitStash>, String> {
    block(move || git_stash_list_impl(root)).await
}

/// 存 stash。
fn git_stash_push_impl(
    root: String,
    message: String,
    include_untracked: bool,
    keep_index: bool,
) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let mut args = vec!["stash", "push", "-q"];
    if include_untracked {
        args.push("--include-untracked");
    }
    if keep_index {
        args.push("--keep-index");
    }
    let message = message.trim().to_string();
    let extra: Vec<&str> = if message.is_empty() {
        Vec::new()
    } else {
        vec!["-m", message.as_str()]
    };
    args.extend(extra);
    let output = run_git(&root, &args)?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(String::new())
}

#[tauri::command]
pub async fn git_stash_push(
    root: String,
    message: String,
    include_untracked: bool,
    keep_index: bool,
) -> Result<String, String> {
    block(move || git_stash_push_impl(root, message, include_untracked, keep_index)).await
}

/// 取 stash。`pop` 为真取完即删（git stash pop），否则留着（apply）；
/// `reinstate_index` 同时恢复当时的暂存状态。
fn git_stash_apply_impl(root: String, index: u32, pop: bool, reinstate_index: bool) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let spec = format!("stash@{{{index}}}");
    let mut args = vec!["stash", if pop { "pop" } else { "apply" }, "-q"];
    if reinstate_index {
        args.push("--index");
    }
    args.push(spec.as_str());
    let output = run_git(&root, &args)?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(String::new())
}

#[tauri::command]
pub async fn git_stash_apply(
    root: String,
    index: u32,
    pop: bool,
    reinstate_index: bool,
) -> Result<String, String> {
    block(move || git_stash_apply_impl(root, index, pop, reinstate_index)).await
}

/// 从某条 stash 上开出新分支并应用它。
fn git_stash_branch_impl(root: String, index: u32, branch: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    if !valid_branch_name(&branch) {
        return Err(err("BAD_BRANCH", &branch));
    }
    let spec = format!("stash@{{{index}}}");
    let output = run_git(&root, &["stash", "branch", branch.as_str(), spec.as_str()])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(String::new())
}

#[tauri::command]
pub async fn git_stash_branch(root: String, index: u32, branch: String) -> Result<String, String> {
    block(move || git_stash_branch_impl(root, index, branch)).await
}

/// 丢弃一条 stash。不可恢复，确认由前端负责。
fn git_stash_drop_impl(root: String, index: u32) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let spec = format!("stash@{{{index}}}");
    let output = run_git(&root, &["stash", "drop", "-q", spec.as_str()])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(String::new())
}

#[tauri::command]
pub async fn git_stash_drop(root: String, index: u32) -> Result<String, String> {
    block(move || git_stash_drop_impl(root, index)).await
}

// ---------------------------------------------------------------- shelf（搁置区）

/// 搁置区（Shelf，对齐 IDEA 的 Shelve Changes / Unshelve）：把选中文件的未提交改动
/// 存成命名补丁并把工作区恢复到 HEAD；随时可以 unshelve 放回来（有冲突就留标记）。
/// 存储在 `<repo>/.git/forge-shelf/<id>/`：`shelved.patch` + `shelf.json`，跟仓库走、
/// 永不进版本控制。

/// 一条搁置清单里的一个文件。
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitShelfFile {
    /// 相对仓库根的路径，正斜杠。
    pub path: String,
    /// A / D / M / R / T 之一（name-status 的字母）。
    pub kind: String,
    /// 改名前的路径；其余为空串。
    #[serde(default)]
    pub old_path: String,
}

/// 一条搁置清单（不含补丁正文）。
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitShelvedChangeList {
    pub id: String,
    pub name: String,
    /// 搁置时刻的 unix 毫秒。
    pub time_ms: i64,
    /// 搁置时所在的分支；取不到为 null。
    pub branch: Option<String>,
    pub files: Vec<GitShelfFile>,
}

/// unshelve 的结果：干净落地的文件与带冲突标记留下的文件。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitShelfApplyOutcome {
    pub applied: Vec<String>,
    pub conflicts: Vec<String>,
}

const SHELF_PATCH: &str = "shelved.patch";
const SHELF_INFO: &str = "shelf.json";

fn shelf_dir(root: &Path) -> PathBuf {
    root.join(".git").join("forge-shelf")
}

/// 搁置区条目目录：id 只能是单段普通名字，patch 文件必须真的在。
fn shelf_entry(shelf: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.starts_with('.') {
        return Err(err("BAD_SHELF_ID", id));
    }
    let dir = shelf.join(id);
    if !dir.join(SHELF_PATCH).is_file() {
        return Err(err("SHELF_NOT_FOUND", id));
    }
    Ok(dir)
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShelfInfo {
    name: String,
    time_ms: f64,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    files: Vec<GitShelfFile>,
}

fn shelf_now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// 名字 → 目录 id：非字母数字压成下划线、去空段、截到 60 字符；空了给 "shelf"。
fn shelf_slug(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    let joined = mapped
        .split('_')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    let cut = joined.char_indices().nth(60).map(|(i, _)| i).unwrap_or(joined.len());
    let s = &joined[..cut];
    if s.is_empty() { "shelf".to_string() } else { s.to_string() }
}

/// 临时索引放在用户 temp，兼容 .git 是文件的 linked worktree。
struct TempIndex(PathBuf, bool);

impl TempIndex {
    fn new(_root: &Path) -> Self {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        TempIndex(std::env::temp_dir().join(format!("forge-index-{}-{stamp}-{n}", std::process::id())), false)
    }
    fn envs(&self) -> [(&str, &std::ffi::OsStr); 1] {
        [("GIT_INDEX_FILE", self.0.as_os_str())]
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        if !self.1 { let _ = std::fs::remove_file(&self.0); }
        let _ = std::fs::remove_file(self.0.with_extension("lock"));
    }
}

fn has_head(root: &Path) -> Result<bool, String> {
    Ok(run_git(root, &["rev-parse", "--verify", "-q", "HEAD"])?.ok)
}

/// 选中文件的二进制安全补丁（工作区相对 HEAD，含暂存与未跟踪，改名拆成删+增），
/// 外加补丁触及的文件清单。用临时索引比对，真实索引不动。
fn working_patch(root: &Path, rel_paths: &[String]) -> Result<(String, Vec<GitShelfFile>), String> {
    if rel_paths.is_empty() {
        return Err(err("BAD_SHELF_ID", "no files selected"));
    }
    let tmp = TempIndex::new(root);
    let env = tmp.envs();
    if has_head(root)? {
        run_git_raw_env(root, &["read-tree", "HEAD"], None, &env)?;
    } else {
        run_git_raw_env(root, &["read-tree", "--empty"], None, &env)?;
    }
    let mut add: Vec<&str> = vec!["--literal-pathspecs", "add", "-A", "--"];
    add.extend(rel_paths.iter().map(String::as_str));
    let add_out = run_git_raw_env(root, &add, None, &env)?;
    if !add_out.ok {
        return Err(fail(&add_out));
    }
    let diff = run_git_raw_env(
        root,
        &["diff", "--cached", "--binary", "--full-index", "-M", "--no-color", "--no-ext-diff"],
        None,
        &env,
    )?;
    let names = run_git_raw_env(
        root,
        &["diff", "--cached", "--name-status", "-z", "--no-renames", "--no-color"],
        None,
        &env,
    )?;
    // name-status 的 -z 流：`code` + `path` 两个 token，R/C 多一条旧路径。
    let mut files = Vec::new();
    let mut tokens = names.stdout.split('\0').filter(|t| !t.is_empty());
    while let Some(code) = tokens.next() {
        let kind = code.chars().next().unwrap_or('M').to_string();
        let (old_path, path) = if kind == "R" || kind == "C" {
            let (Some(old), Some(new)) = (tokens.next(), tokens.next()) else { break };
            (old.to_string(), new.to_string())
        } else {
            let Some(path) = tokens.next() else { break };
            (String::new(), path.to_string())
        };
        files.push(GitShelfFile { path, kind, old_path });
    }
    Ok((diff.stdout, files))
}

/// 恢复 `files` 到 HEAD（索引与工作区一起）；HEAD 里没有的（新增文件）从索引与磁盘移除。
fn shelf_revert_files(root: &Path, files: &[GitShelfFile]) -> Result<(), String> {
    let head = has_head(root)?;
    let (in_head, new): (Vec<&GitShelfFile>, Vec<&GitShelfFile>) =
        files.iter().partition(|f| head && f.kind != "A");
    if !in_head.is_empty() {
        let mut args = vec!["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--"];
        args.extend(in_head.iter().map(|f| f.path.as_str()));
        let out = run_git(root, &args)?;
        if !out.ok {
            return Err(fail(&out));
        }
    }
    if !new.is_empty() {
        let mut args = vec!["--literal-pathspecs", "rm", "--cached", "-q", "-r", "--ignore-unmatch", "--"];
        args.extend(new.iter().map(|f| f.path.as_str()));
        let out = run_git(root, &args)?;
        if !out.ok {
            return Err(fail(&out));
        }
        for f in new {
            let abs = root.join(&f.path);
            if abs.is_file() || abs.is_symlink() {
                std::fs::remove_file(&abs).map_err(|e| err("FS", e.to_string()))?;
            }
        }
    }
    Ok(())
}

/// 一份补丁按干净落地/冲突两路应用：先试普通应用，不行退到 --3way（冲突文件留
/// 标记与未合并索引位，交给三向合并 UI）。
fn shelf_apply_patch(root: &Path, patch: &str) -> Result<(Vec<String>, Vec<String>), String> {
    let patch = patch.trim_end();
    if patch.is_empty() {
        return Err(err("BAD_PATCH", "patch is empty"));
    }
    let paths: Vec<String> = patch
        .lines()
        .filter_map(|line| line.strip_prefix("+++ b/").map(|p| p.to_string()))
        .collect();
    let stdin_patch = format!("{patch}\n");
    let check = run_git_stdin(root, &["apply", "--check", "--binary", "-"], &stdin_patch)?;
    if check.ok {
        let out = run_git_stdin(root, &["apply", "--binary", "-"], &stdin_patch)?;
        if !out.ok {
            return Err(fail(&out));
        }
        return Ok((paths, Vec::new()));
    }
    let out = run_git_stdin(root, &["apply", "--3way", "--binary", "-"], &stdin_patch)?;
    let unmerged = run_git(root, &["diff", "--name-only", "--diff-filter=U", "-z"])?;
    let conflicts: Vec<String> = unmerged
        .stdout
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if !out.ok && conflicts.is_empty() {
        return Err(fail(&out));
    }
    // --3way 会把它成功应用的部分写进索引；干净文件保持索引原样。
    let clean: Vec<String> = paths.iter().filter(|p| !conflicts.contains(p)).cloned().collect();
    if !clean.is_empty() && has_head(root)? {
        let mut args = vec!["--literal-pathspecs", "reset", "-q", "--"];
        args.extend(clean.iter().map(String::as_str));
        let reset = run_git(root, &args)?;
        if !reset.ok {
            return Err(fail(&reset));
        }
    }
    Ok((clean, conflicts))
}

/// 搁置：把 `paths` 的未提交改动存成一条命名清单并恢复工作区。
fn git_shelve_impl(root: String, name: String, paths: Vec<String>) -> Result<GitShelvedChangeList, String> {
    let root = ensure_root(&root)?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(err("BAD_SHELF_NAME", &name));
    }
    // 绝对路径 → 相对仓库根（前端传来的是 absoluteOf 的绝对路径）。
    let root_prefix = format!("{}/", root.to_string_lossy().replace('\\', "/"));
    let rel_paths: Vec<String> = paths
        .iter()
        .map(|p| p.replace('\\', "/"))
        .map(|p| p.strip_prefix(&root_prefix).map(str::to_string).unwrap_or(p))
        .collect();
    let (patch, files) = working_patch(&root, &rel_paths)?;
    if files.is_empty() || patch.trim().is_empty() {
        return Err(err("EMPTY_SHELF", &name));
    }
    let shelf = shelf_dir(&root);
    std::fs::create_dir_all(&shelf).map_err(|e| err("FS", e.to_string()))?;
    let base = shelf_slug(&name);
    let mut id = base.clone();
    let mut n = 1;
    while shelf.join(&id).exists() {
        n += 1;
        id = format!("{base}_{n}");
    }
    let dir = shelf.join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| err("FS", e.to_string()))?;
    let info = ShelfInfo {
        name: name.clone(),
        time_ms: shelf_now_ms(),
        branch: None,
        files: files.clone(),
    };
    let write = || -> Result<(), String> {
        std::fs::write(dir.join(SHELF_PATCH), patch.as_bytes()).map_err(|e| err("FS", e.to_string()))?;
        std::fs::write(
            dir.join(SHELF_INFO),
            serde_json::to_vec_pretty(&info).map_err(|e| err("FS", e.to_string()))?,
        )
        .map_err(|e| err("FS", e.to_string()))?;
        Ok(())
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    shelf_revert_files(&root, &files)?;
    Ok(GitShelvedChangeList {
        id,
        name: info.name,
        time_ms: info.time_ms as i64,
        branch: info.branch,
        files,
    })
}

/// 搁置区清单，最新在前。
fn git_shelves_impl(root: String) -> Result<Vec<GitShelvedChangeList>, String> {
    let root = ensure_root(&root)?;
    let shelf = shelf_dir(&root);
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&shelf) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.join(SHELF_PATCH).is_file() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        let info = std::fs::read(dir.join(SHELF_INFO))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ShelfInfo>(&bytes).ok())
            .unwrap_or_else(|| ShelfInfo {
                name: id.clone(),
                time_ms: 0.0,
                branch: None,
                files: Vec::new(),
            });
        out.push(GitShelvedChangeList {
            id,
            name: info.name,
            time_ms: info.time_ms as i64,
            branch: info.branch,
            files: info.files,
        });
    }
    out.sort_by(|a, b| b.time_ms.cmp(&a.time_ms).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// 放回搁置的改动；`remove` 在无冲突时顺带删除条目（有冲突条目保留）。
fn git_unshelve_impl(root: String, id: String, remove: bool) -> Result<GitShelfApplyOutcome, String> {
    let root = ensure_root(&root)?;
    let patch = std::fs::read_to_string(shelf_entry(&shelf_dir(&root), &id)?.join(SHELF_PATCH))
        .map_err(|e| err("FS", e.to_string()))?;
    let (applied, conflicts) = shelf_apply_patch(&root, &patch)?;
    if remove && conflicts.is_empty() {
        std::fs::remove_dir_all(shelf_dir(&root).join(&id)).map_err(|e| err("FS", e.to_string()))?;
    }
    Ok(GitShelfApplyOutcome { applied, conflicts })
}

fn git_shelf_delete_impl(root: String, id: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    std::fs::remove_dir_all(shelf_entry(&shelf_dir(&root), &id)?).map_err(|e| err("FS", e.to_string()))?;
    Ok(String::new())
}

fn git_shelf_rename_impl(root: String, id: String, name: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(err("BAD_SHELF_NAME", &name));
    }
    let dir = shelf_entry(&shelf_dir(&root), &id)?;
    let mut info: ShelfInfo = std::fs::read(dir.join(SHELF_INFO))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(ShelfInfo {
            name: String::new(),
            time_ms: shelf_now_ms(),
            branch: None,
            files: Vec::new(),
        });
    info.name = name;
    std::fs::write(
        dir.join(SHELF_INFO),
        serde_json::to_vec_pretty(&info).map_err(|e| err("FS", e.to_string()))?,
    )
    .map_err(|e| err("FS", e.to_string()))?;
    Ok(String::new())
}

/// 冲突文件的三个版本（index stage）：ours=2、theirs=3、base=1（stage 1 可能没有）。
/// `reversed`：变基/恢复 stash 撞出的冲突里 git 把「别人的」写进 stage 2、你的写进
/// stage 3，两侧语义对调。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictVersions {
    pub ours: String,
    pub theirs: String,
    pub base: Option<String>,
    pub reversed: bool,
}

fn show_conflict_stage(root: &Path, relative: &str, stage: u32, path: &str) -> Result<Option<String>, String> {
    let spec = format!(":{stage}:{relative}");
    let output = run_git(root, &["show", spec.as_str()])?;
    if !output.ok {
        // stage 不存在（比如新增文件没有 base）不是错；别的失败照实报。
        let missing = !run_git(root, &["cat-file", "-e", spec.as_str()])
            .map(|probe| probe.ok)
            .unwrap_or(true);
        if missing {
            return Ok(None);
        }
        return Err(fail(&output));
    }
    // 同 git_index_show：二进制 blob 按内容探测（前 8KB 有 NUL）。
    if output.stdout.as_bytes()[..output.stdout.len().min(8192)].contains(&0) {
        return Err(err("BINARY", path));
    }
    Ok(Some(output.stdout))
}

fn git_conflict_versions_impl(root: String, path: String) -> Result<GitConflictVersions, String> {
    let root = ensure_root(&root)?;
    let relative = relative_path(&root, &path)?;
    let ours = show_conflict_stage(&root, &relative, 2, &path)?;
    let theirs = show_conflict_stage(&root, &relative, 3, &path)?;
    let base = show_conflict_stage(&root, &relative, 1, &path)?;
    match (ours, theirs) {
        (Some(ours), Some(theirs)) => {
            // 变基、以及没有进行中操作的未合并（恢复 stash 撞冲突）都要把两侧对调；
            // merge / cherry-pick / revert 的 stage 2 本来就是你的。
            let (merge, rebase, cherry_pick, revert) = in_progress(&root);
            let reversed = rebase || !(merge || cherry_pick || revert);
            Ok(GitConflictVersions { ours, theirs, base, reversed })
        }
        // 没有 stage 2/3 说明这不是未合并文件，三栏编辑器无从谈起。
        _ => Err(err("NOT_CONFLICTED", &path)),
    }
}

#[tauri::command]
pub async fn git_conflict_versions(root: String, path: String) -> Result<GitConflictVersions, String> {
    block(move || git_conflict_versions_impl(root, path)).await
}

#[tauri::command]
pub async fn git_shelve(root: String, name: String, paths: Vec<String>) -> Result<GitShelvedChangeList, String> {
    block(move || git_shelve_impl(root, name, paths)).await
}

#[tauri::command]
pub async fn git_shelves(root: String) -> Result<Vec<GitShelvedChangeList>, String> {
    block(move || git_shelves_impl(root)).await
}

#[tauri::command]
pub async fn git_unshelve(root: String, id: String, remove: bool) -> Result<GitShelfApplyOutcome, String> {
    block(move || git_unshelve_impl(root, id, remove)).await
}

#[tauri::command]
pub async fn git_shelf_delete(root: String, id: String) -> Result<String, String> {
    block(move || git_shelf_delete_impl(root, id)).await
}

#[tauri::command]
pub async fn git_shelf_rename(root: String, id: String, name: String) -> Result<String, String> {
    block(move || git_shelf_rename_impl(root, id, name)).await
}

/// 重命名分支。
#[tauri::command]
pub async fn git_rename_branch(root: String, name: String, to: String) -> Result<String, String> {
    block(move || git_rename_branch_impl(root, name, to)).await
}

fn git_rename_branch_impl(root: String, name: String, to: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    if !valid_branch_name(&name) || !valid_branch_name(&to) {
        return Err(err("BAD_BRANCH", &to));
    }
    let output = run_git(&root, &["branch", "-m", name.as_str(), to.as_str()])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(to)
}

/// 删除分支。用 `-d`：还没合并的分支 git 自己会拦，这里不替用户硬删。
#[tauri::command]
pub async fn git_delete_branch(root: String, name: String) -> Result<String, String> {
    block(move || git_delete_branch_impl(root, name)).await
}

fn git_delete_branch_impl(root: String, name: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    if !valid_branch_name(&name) {
        return Err(err("BAD_BRANCH", &name));
    }
    let output = run_git(&root, &["branch", "-d", name.as_str()])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

/// 删除标签。
#[tauri::command]
pub async fn git_delete_tag(root: String, name: String) -> Result<String, String> {
    block(move || git_delete_tag_impl(root, name)).await
}

fn git_delete_tag_impl(root: String, name: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    if !valid_branch_name(&name) {
        return Err(err("BAD_TAG", &name));
    }
    let output = run_git(&root, &["tag", "-d", name.as_str()])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

/// 这个名字该推给哪个远端：远程分支看前缀，本地分支看上游，都没有就取第一个远端。
fn push_target(root: &Path, name: &str) -> Result<String, String> {
    let remotes = git_remotes_impl(root.to_string_lossy().into_owned())?;
    if let Some((head, tail)) = name.split_once('/') {
        if !tail.is_empty() && remotes.iter().any(|held| held == head) {
            return Ok(head.to_string());
        }
    }
    let tracked = run_git(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            &format!("{name}@{{upstream}}"),
        ],
    )?;
    if let Some(upstream) = tracked.ok.then(|| trim_line(&tracked.stdout)) {
        if let Some((head, tail)) = upstream.split_once('/') {
            if !tail.is_empty() {
                return Ok(head.to_string());
            }
        }
    }
    remotes.into_iter().next().ok_or_else(|| err("NO_REMOTE", ""))
}

/// 推送指定的分支或标签，不碰当前分支的上游设置。
#[tauri::command]
pub async fn git_push_ref(webview: tauri::Webview, root: String, name: String, on_output: Option<tauri::ipc::JavaScriptChannelId>) -> Result<String, String> {
    let on_output = on_output.map(|id| id.channel_on::<_, String>(webview));
    block(move || git_push_ref_output(root, name, on_output)).await
}

#[cfg(test)]
fn git_push_ref_impl(root: String, name: String) -> Result<String, String> {
    git_push_ref_output(root, name, None)
}

fn git_push_ref_output(root: String, name: String, on_output: Option<tauri::ipc::Channel<String>>) -> Result<String, String> {
    let root = ensure_root(&root)?;
    // 分支名或标签版本引用均可推送到远端
    if !valid_branch_name(&name) && !valid_rev(&name) {
        return Err(err("BAD_REV", &name));
    }
    if run_git(&root, &["show-ref", "--verify", &format!("refs/heads/{name}")])?.ok {
        return git_push_output(root.to_string_lossy().into_owned(), GitPushOptions { branch: Some(name), ..Default::default() }, on_output);
    }
    let remote = push_target(&root, &name)?;
    remote_op_output(&root, &["push", "--progress", "--", remote.as_str(), name.as_str()], on_output)
}

/// 删除远端分支：往服务器推一条删除引用，本地的远程跟踪引用跟着消失。
#[tauri::command]
pub async fn git_delete_remote_branch(root: String, name: String) -> Result<String, String> {
    block(move || git_delete_remote_branch_impl(root, name)).await
}

fn git_delete_remote_branch_impl(root: String, name: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let (remote, branch) = name
        .split_once('/')
        .filter(|(head, tail)| !head.is_empty() && !tail.is_empty())
        .ok_or_else(|| err("BAD_BRANCH", &name))?;
    if !valid_branch_name(branch) {
        return Err(err("BAD_BRANCH", &name));
    }
    remote_op(&root, &["push", remote, "--delete", branch])
}

/// 在打开的那个目录上建仓库。只建 `.git`，不动工作区里任何一个文件。
/// 目录已经是仓库的一部分也照跑：`git init` 在已有仓库里是幂等的，会往上找到那个根。
#[tauri::command]
pub async fn git_init(root: String) -> Result<String, String> {
    block(move || git_init_impl(root)).await
}

fn git_init_impl(root: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let output = run_git(&root, &["init"])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

/// 新建工作树：把 `branch` 签出到 `path` 那个目录里。
/// `new_branch` 非空时先在那条引用上开一个新分支再签出——手上这条分支已经在
/// 这个工作树里被占着，直接 `worktree add <路径> <当前分支>` 一定被 git 拒。
#[tauri::command]
pub async fn git_worktree_add(
    root: String,
    path: String,
    branch: String,
    new_branch: String,
) -> Result<String, String> {
    block(move || git_worktree_add_impl(root, path, branch, new_branch)).await
}

fn git_worktree_add_impl(
    root: String,
    path: String,
    branch: String,
    new_branch: String,
) -> Result<String, String> {
    let root = ensure_root(&root)?;
    if !valid_branch_name(&branch) {
        return Err(err("BAD_REV", &branch));
    }
    if !new_branch.is_empty() && !valid_branch_name(&new_branch) {
        return Err(err("BAD_BRANCH", &new_branch));
    }
    if path.trim().is_empty() {
        return Err(err("BAD_PATH", &path));
    }
    let args: Vec<&str> = if new_branch.is_empty() {
        vec!["worktree", "add", path.as_str(), branch.as_str()]
    } else {
        vec![
            "worktree",
            "add",
            "-b",
            new_branch.as_str(),
            path.as_str(),
            branch.as_str(),
        ]
    };
    let output = run_git(&root, &args)?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

/// 查是哪一条忽略规则盖住了这个路径，回 `check-ignore -v` 的原样一行
/// （`来源文件:行号:模式<TAB>路径`）。没被任何规则盖住时 git 退 1 且不写东西，这里回空串。
#[tauri::command]
pub async fn git_ignore_rule(root: String, path: String) -> Result<String, String> {
    block(move || git_ignore_rule_impl(root, path)).await
}

fn git_ignore_rule_impl(root: String, path: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let relative = relative_path(&root, &path)?;
    // --no-index：已跟踪的文件也要能问出它是被哪条规则盖住的，否则 git 一律不回话。
    let output = run_git(&root, &["check-ignore", "-v", "--no-index", relative.as_str()])?;
    if !output.ok {
        if output.stdout.trim().is_empty() && output.stderr.trim().is_empty() {
            return Ok(String::new());
        }
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

/// 把某个版本下的文件内容写回工作区，不动索引；revision 为空时从暂存区恢复。
#[tauri::command]
pub async fn git_restore_file(root: String, revision: String, path: String) -> Result<String, String> {
    block(move || git_restore_file_impl(root, revision, path)).await
}

fn git_restore_file_impl(root: String, revision: String, path: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let relative = relative_path(&root, &path)?;
    let output = if revision.is_empty() {
        // revision 为空时直接从暂存区恢复工作区内容，不碰 index
        run_git(&root, &["restore", "--worktree", "--", relative.as_str()])?
    } else {
        if !valid_rev(&revision) {
            return Err(err("BAD_REV", &revision));
        }
        run_git(
            &root,
            &[
                "restore",
                "--source",
                revision.as_str(),
                "--worktree",
                "--",
                relative.as_str(),
            ],
        )?
    };
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(relative)
}

/// 两侧版本之间的统一差异；`path` 留空取整体，`cached` 时读取索引而非工作区。
#[tauri::command]
pub async fn git_diff_text(
    root: String,
    left: String,
    right: String,
    path: String,
    old_path: Option<String>,
    cached: Option<bool>,
    worktree_only: Option<bool>,
) -> Result<String, String> {
    block(move || {
        if worktree_only.unwrap_or(false) {
            let root = ensure_root(&root)?;
            let _queued = git_write_lock();
            let (index, _) = selected_indexes(&root, &[CommitSelection { path, old_path, source: CommitSource::WorktreeOnly }])?;
            selected_git(&root, &["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3"], None, Some(&index))
        } else {
            git_diff_text_impl(root, left, right, path, old_path, cached.unwrap_or(false))
        }
    }).await
}

fn git_diff_text_impl(
    root: String,
    left: String,
    right: String,
    path: String,
    old_path: Option<String>,
    cached: bool,
) -> Result<String, String> {
    let root = ensure_root(&root)?;
    if !(cached && left.is_empty() || valid_rev(&left))
        || (!right.is_empty() && (cached || !valid_rev(&right)))
    {
        return Err(err("BAD_REV", &left));
    }
    // 空 path 表示整条提交，不加路径限定；其余照旧。
    // 重命名/复制要带上旧路径，`git diff` 才能在两侧都做重命名检测，否则只会显示成整份新增。
    let mut relatives: Vec<String> = Vec::new();
    if !path.is_empty() {
        relatives.push(relative_path(&root, &path)?);
    }
    if let Some(old) = old_path.as_deref() {
        let old = old.trim();
        if !old.is_empty() {
            let relative = relative_path(&root, old)?;
            if !relatives.contains(&relative) {
                relatives.push(relative);
            }
        }
    }
    let mut args: Vec<&str> = vec!["diff", "--no-color", "--no-ext-diff"];
    // --cached 不指定左侧时由 Git 使用 HEAD；未产生首个提交的仓库也能得到新增差异。
    if cached {
        args.push("--cached");
    }
    if !left.is_empty() {
        args.push(left.as_str());
    }
    if !right.is_empty() {
        args.push(right.as_str());
    }
    if !relatives.is_empty() {
        args.push("--");
        for relative in &relatives {
            args.push(relative.as_str());
        }
    }
    let output = run_git(&root, &args)?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(output.stdout)
}

/// 引用与工作树之间改到的文件，「显示与工作树的差异」那棵树靠它列行。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitNameStatus {
    /// 相对仓库根的路径，正斜杠。
    pub path: String,
    /// 重命名/复制的来源路径；其余为空串。
    pub old_path: String,
    /// M / A / D / R / T 之一。
    pub status: String,
}

#[tauri::command]
pub async fn git_diff_names(root: String, revision: String) -> Result<Vec<GitNameStatus>, String> {
    block(move || git_diff_names_impl(root, revision)).await
}

fn git_diff_names_impl(root: String, revision: String) -> Result<Vec<GitNameStatus>, String> {
    let root = ensure_root(&root)?;
    if !valid_rev(&revision) {
        return Err(err("BAD_REV", &revision));
    }
    let output = run_git(&root, &["diff", "--name-status", "-z", revision.as_str()])?;
    if !output.ok {
        return Err(fail(&output));
    }
    let mut list = Vec::new();
    let mut tokens = output.stdout.split('\0').filter(|token| !token.is_empty());
    while let Some(status) = tokens.next() {
        let code = status.chars().next().unwrap_or('M').to_string();
        // R/C 带两条路径：先旧后新；其余只有一条。
        if code == "R" || code == "C" {
            let old_path = tokens.next().unwrap_or("").to_string();
            let path = tokens.next().unwrap_or("").to_string();
            if !path.is_empty() {
                list.push(GitNameStatus { path, old_path, status: code });
            }
        } else {
            let path = tokens.next().unwrap_or("").to_string();
            if !path.is_empty() {
                list.push(GitNameStatus { path, old_path: String::new(), status: code });
            }
        }
    }
    Ok(list)
}

/// 冲突恢复四件套：编辑器换成 true，git 就不会去弹编辑器卡住命令。
#[tauri::command]
pub async fn git_rebase_continue(root: String) -> Result<String, String> {
    block(move || git_rebase_continue_impl(root)).await
}

fn git_rebase_continue_impl(root: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let output = run_git(&root, &["-c", "core.editor=true", "rebase", "--continue"])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

#[tauri::command]
pub async fn git_rebase_abort(root: String) -> Result<String, String> {
    block(move || git_rebase_abort_impl(root)).await
}

fn git_rebase_abort_impl(root: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let output = run_git(&root, &["rebase", "--abort"])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

#[tauri::command]
pub async fn git_merge_continue(root: String) -> Result<String, String> {
    block(move || git_merge_continue_impl(root)).await
}

fn git_merge_continue_impl(root: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let output = run_git(&root, &["-c", "core.editor=true", "merge", "--continue"])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

#[tauri::command]
pub async fn git_merge_abort(root: String) -> Result<String, String> {
    block(move || git_merge_abort_impl(root)).await
}

fn git_merge_abort_impl(root: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let output = run_git(&root, &["merge", "--abort"])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

/// 摘一条提交到当前分支上。撞了冲突 git 自己停在 CHERRY_PICK_HEAD，横幅那两颗接得住。
#[tauri::command]
pub async fn git_cherry_pick(root: String, revision: String) -> Result<String, String> {
    block(move || git_cherry_pick_impl(root, revision)).await
}

fn git_cherry_pick_impl(root: String, revision: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    if !valid_rev(&revision) {
        return Err(err("BAD_REV", &revision));
    }
    let output = run_git(
        &root,
        &["-c", "core.editor=true", "cherry-pick", revision.as_str()],
    )?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

#[tauri::command]
pub async fn git_cherry_pick_continue(root: String) -> Result<String, String> {
    block(move || git_cherry_pick_continue_impl(root)).await
}

fn git_cherry_pick_continue_impl(root: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let output = run_git(&root, &["-c", "core.editor=true", "cherry-pick", "--continue"])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

#[tauri::command]
pub async fn git_cherry_pick_abort(root: String) -> Result<String, String> {
    block(move || git_cherry_pick_abort_impl(root)).await
}

fn git_cherry_pick_abort_impl(root: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let output = run_git(&root, &["cherry-pick", "--abort"])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

/// 还原一条提交：做一笔内容相反的提交。`--no-edit` 用 git 自己那句说明，不弹编辑器。
#[tauri::command]
pub async fn git_revert(root: String, revision: String) -> Result<String, String> {
    block(move || git_revert_impl(root, revision)).await
}

fn git_revert_impl(root: String, revision: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    if !valid_rev(&revision) {
        return Err(err("BAD_REV", &revision));
    }
    let output = run_git(
        &root,
        &[
            "-c",
            "core.editor=true",
            "revert",
            "--no-edit",
            revision.as_str(),
        ],
    )?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

#[tauri::command]
pub async fn git_revert_continue(root: String) -> Result<String, String> {
    block(move || git_revert_continue_impl(root)).await
}

fn git_revert_continue_impl(root: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let output = run_git(&root, &["-c", "core.editor=true", "revert", "--continue"])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

#[tauri::command]
pub async fn git_revert_abort(root: String) -> Result<String, String> {
    block(move || git_revert_abort_impl(root)).await
}

fn git_revert_abort_impl(root: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    let output = run_git(&root, &["revert", "--abort"])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

/// 把当前分支的头挪到某条提交。soft 只挪指针，mixed 再清掉索引（工作区不动），
/// hard 连工作区一起换成那条提交的样子——所以 hard 要前端先问一句。
#[tauri::command]
pub async fn git_reset(root: String, revision: String, mode: String) -> Result<String, String> {
    block(move || git_reset_impl(root, revision, mode)).await
}

fn git_reset_impl(root: String, revision: String, mode: String) -> Result<String, String> {
    let root = ensure_root(&root)?;
    if !valid_rev(&revision) {
        return Err(err("BAD_REV", &revision));
    }
    let flag = match mode.as_str() {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        other => return Err(err("BAD_MODE", other)),
    };
    let output = run_git(&root, &["reset", flag, revision.as_str()])?;
    if !output.ok {
        return Err(fail(&output));
    }
    Ok(trim_line(&output.stdout))
}

/// 只推这条提交（含）以前的那一段：`git push <远端> <修订>:refs/heads/<分支>`。
/// 不加 --force，远端那头要是已经走得比这远了，git 自己会拒。
#[tauri::command]
pub async fn git_push_up_to(root: String, branch: String, revision: String) -> Result<String, String> {
    block(move || git_push_up_to_impl(root, branch, revision)).await
}

fn git_push_up_to_impl(root: String, branch: String, revision: String) -> Result<String, String> {
    // 与完整推送共享上游解析和 refspec 校验，避免忽略上游的实际分支名。
    git_push_impl(root, GitPushOptions { branch: Some(branch), revision: Some(revision), ..Default::default() })
}

/// 按一边了结一个冲突文件：取 stage 2（本地）或 stage 3（对方）覆盖工作区并暂存；
/// 若该 side 已将文件删除（修改/删除冲突），则执行 `git rm -f` 标记解决并删除。
#[tauri::command]
pub async fn git_resolve_conflict(root: String, path: String, side: String) -> Result<String, String> {
    block(move || git_resolve_conflict_impl(root, path, side)).await
}

fn git_resolve_conflict_impl(root: String, path: String, side: String) -> Result<String, String> {
    let (flag, stage) = match side.as_str() {
        "ours" => ("--ours", "2"),
        "theirs" => ("--theirs", "3"),
        _ => return Err(err("BAD_SIDE", &side)),
    };
    let root = ensure_root(&root)?;
    let relative = relative_path(&root, &path)?;
    let stage_spec = format!(":{stage}:{relative}");
    // 探测目标 side 在索引中是否存在（修改/删除冲突时被删除方没有对应 stage）
    let stage_exists = run_git(&root, &["cat-file", "-e", stage_spec.as_str()])
        .map(|probe| probe.ok)
        .unwrap_or(false);

    if stage_exists {
        let picked = run_git(
            &root,
            &["checkout", flag, "--", relative.as_str()],
        )?;
        if !picked.ok {
            return Err(fail(&picked));
        }
        let marked = run_git(&root, &["add", "--", relative.as_str()])?;
        if !marked.ok {
            return Err(fail(&marked));
        }
    } else {
        // 目标侧已删除此文件：执行 rm -f 同步从工作区与暂存区移除，完成冲突解决
        let removed = run_git(&root, &["rm", "-f", "--", relative.as_str()])?;
        if !removed.ok {
            return Err(fail(&removed));
        }
    }
    Ok(relative)
}

/// 日志查询的过滤条件，全空时等于取最近若干条。
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GitLogQuery {
    /// 限定的分支/标签/引用；空串表示当前分支。
    pub reference: String,
    /// 作者子串。
    pub author: String,
    /// 标题与正文里的文本。
    pub text: String,
    /// `text` 按扩展正则解释；false 时按字面量匹配。
    pub regex: bool,
    /// 起始时间，Unix 毫秒；0 表示不限。
    pub since_ms: i64,
    /// 限定改到该路径（仓库相对）的提交；空串表示不限。文件历史用。
    pub path: String,
    /// 跳过前 N 条（「加载更多」分页用）。
    #[serde(default)]
    pub skip: u32,
    /// 条数上限。
    pub limit: u32,
}

/// 时间戳转 git 认的 ISO 风格字符串；0 表示不设这一侧边界。
fn bound(ms: i64) -> Option<String> {
    if ms <= 0 {
        return None;
    }
    // git 接受 `@<unix>` 形式的时间戳，省掉自己格式化。
    Some(format!("@{}", ms / 1000))
}

/// 空仓库（还没有任何提交）的判定：报错文案随 locale 翻译不能嗅探，
/// 用 `rev-parse --verify HEAD` 的退出码认。
fn head_alive(root: &Path) -> bool {
    run_git(root, &["rev-parse", "--verify", "-q", "HEAD"])
        .map(|probe| probe.ok)
        .unwrap_or(false)
}

/// 「与某分支比较」可能是 `a..b`（两点）或 `a...b`（三点对称差），空段合法
/// （`..b` 表示从 HEAD 到 b）。直接 `split("..")` 会把三点拆出 `.b` 这种
/// 以点开头的非法 ref 片段，按完整区间语法拆一遍再逐段校验。
fn valid_range(reference: &str) -> bool {
    let (left, right) = match reference.split_once("...") {
        Some((l, r)) => (l, r),
        None => match reference.split_once("..") {
            Some((l, r)) => (l, r),
            None => (reference, ""),
        },
    };
    (left.is_empty() || valid_branch_name(left)) && (right.is_empty() || valid_branch_name(right))
}

#[tauri::command]
pub async fn git_log(root: String, query: GitLogQuery) -> Result<Vec<GitCommit>, String> {
    block(move || git_log_impl(root, query)).await
}

fn git_log_impl(root: String, query: GitLogQuery) -> Result<Vec<GitCommit>, String> {
    let root = ensure_root(&root)?;
    if !query.reference.is_empty() && !valid_range(&query.reference) {
        return Err(err("BAD_REV", &query.reference));
    }

    let count = query.limit.clamp(1, 500);
    let max_count = format!("-n{count}");
    let mut args: Vec<String> = vec![
        "log".to_string(),
        "--decorate=short".to_string(),
        max_count,
        r"--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%D%x1f%P%x1e".to_string(),
    ];
    if query.regex {
        args.push("--extended-regexp".to_string());
    } else {
        args.push("--fixed-strings".to_string());
    }
    if !query.author.trim().is_empty() {
        args.push(format!("--author={}", query.author.trim()));
    }
    if !query.text.trim().is_empty() {
        args.push(format!("--grep={}", query.text.trim()));
        // --grep 与 --author 同时给时要取交集，git 默认是并集。
        args.push("--all-match".to_string());
    }
    if let Some(since) = bound(query.since_ms) {
        args.push(format!("--since={since}"));
    }
    if query.skip > 0 {
        args.push(format!("--skip={}", query.skip));
    }
    if !query.reference.is_empty() {
        args.push(query.reference.clone());
    }
    // 路径过滤要放在 `--` 后面，否则带斜杠的名字会被 git 当成引用。
    if !query.path.is_empty() {
        args.push("--".to_string());
        args.push(query.path.clone());
    }

    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = run_git(&root, &args)?;
    if !output.ok {
        if !head_alive(&root) {
            return Ok(Vec::new());
        }
        return Err(fail(&output));
    }

    Ok(parse_log(&output.stdout))
}

/// 可以拿去修正的提交：HEAD 往下、还没推到任何远端分支的那几条，遇到合并提交就停。
/// IDEA 的 amend 下拉列的就是这一份（GitAmendCommitService，limit 20）。
#[tauri::command]
pub async fn git_amend_targets(root: String) -> Result<Vec<GitCommit>, String> {
    block(move || git_amend_targets_impl(root)).await
}

fn git_amend_targets_impl(root: String) -> Result<Vec<GitCommit>, String> {
    let root = ensure_root(&root)?;
    let output = run_git(
        &root,
        &[
            "log",
            "-n20",
            r"--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%D%x1f%P%x1e",
            "HEAD",
            "--not",
            "--remotes",
        ],
    )?;
    if !output.ok {
        return Err(fail(&output));
    }
    let mut targets: Vec<GitCommit> = Vec::new();
    for record in output.stdout.split('\u{1e}') {
        let fields: Vec<String> = record
            .trim_start_matches(['\r', '\n'])
            .split('\u{1f}')
            .map(trim_line)
            .collect();
        if fields.len() < 7 || fields[0].is_empty() {
            continue;
        }
        // 遇到第一个合并提交就停：那要改写的不止一条历史，IDEA 也是这么截断的。
        if fields[6].split_whitespace().count() > 1 {
            break;
        }
        targets.push(GitCommit {
            hash: fields[0].clone(),
            short: fields[1].clone(),
            author: fields[2].clone(),
            authored_ms: fields[3].parse::<i64>().unwrap_or_default() * 1000,
            subject: fields[4].clone(),
            refs: fields[5].clone(),
            parents: fields[6].split_whitespace().map(str::to_string).collect(),
        });
    }
    Ok(targets)
}

/// 解析 `git log --format=%H%x1f…%x1e` 的输出。
fn parse_log(stdout: &str) -> Vec<GitCommit> {
    stdout
        .split('\u{1e}')
        .filter(|record| !record.trim().is_empty())
        .filter_map(|record| {
            // 分隔符后面那个换行是 git 自己补的：不剥掉，除第一条外每条的哈希
            // 开头都带一个 \n，拿去当版本引用直接被拒。
            let mut fields = record
                .trim_start_matches(['\r', '\n'])
                .split('\u{1f}')
                .map(trim_line);
            Some(GitCommit {
                hash: fields.next()?,
                short: fields.next()?,
                author: fields.next()?,
                authored_ms: fields.next()?.parse::<i64>().ok()? * 1000,
                subject: fields.next()?,
                refs: fields.next().unwrap_or_default(),
                parents: fields
                    .next()
                    .unwrap_or_default()
                    .split_whitespace()
                    .map(str::to_string)
                    .collect(),
            })
        })
        .collect()
}

/// 校验版本引用：只放常见写法，且不能以 - 开头被当成选项。
fn valid_rev(revision: &str) -> bool {
    !revision.is_empty()
        && !revision.starts_with('-')
        && !revision.contains(':')
        && revision
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | '~' | '^' | '@'))
}

/// 最近 `limit` 条提交里出现过的作者，按各人最近一次出现排，供日志的「用户」下拉。
#[tauri::command]
pub async fn git_authors(root: String, limit: u32) -> Result<Vec<String>, String> {
    block(move || git_authors_impl(root, limit)).await
}

fn git_authors_impl(root: String, limit: u32) -> Result<Vec<String>, String> {
    let root = ensure_root(&root)?;
    let count = limit.clamp(1, 2000);
    let output = run_git(&root, &["log", &format!("-n{count}"), "--format=%an"])?;
    if !output.ok {
        if !head_alive(&root) {
            return Ok(Vec::new());
        }
        return Err(fail(&output));
    }
    // 去重用集合：`seen.iter().any` 是平方量级，两千条提交就是两百万次字符串比较。
    // 出来的次序仍按首次出现排，界面那个下拉的顺序不变。
    let mut seen: HashSet<String> = HashSet::new();
    let mut names: Vec<String> = Vec::new();
    for name in output.stdout.lines().map(trim_line).filter(|name| !name.is_empty()) {
        if seen.insert(name.clone()) {
            names.push(name);
        }
    }
    Ok(names)
}

/// 提交改到的文件清单 + 完整信息，日志右栏上半部分用。
#[tauri::command]
pub async fn git_commit_detail(root: String, revision: String) -> Result<GitCommitDetail, String> {
    block(move || git_commit_detail_impl(root, revision)).await
}

fn git_commit_detail_impl(root: String, revision: String) -> Result<GitCommitDetail, String> {
    if !valid_rev(&revision) {
        return Err(err("BAD_REV", &revision));
    }
    let root = ensure_root(&root)?;
    // 头部信息与行数清单并成一条 show：format 段以 %x1e 收尾，之后全是 numstat
    // 的 NUL token 流（-z 下 format 的终止符 \0\n 也落在那段开头，解析前剥掉）。
    // 少一次进程 spawn（Windows 上每次几十毫秒）；合并提交按第一父取差异
    // （diff-tree 默认不给 merge 出差异，`git show` 默认的 combined diff 在
    // 干净合并时是空的——右栏会整片空白），与 IDEA 一致。
    // 参数顺序有讲究：--no-patch 会取消它前面出现的 diff 输出选项，--numstat
    // 必须排在 --no-patch 之后才出清单，两条谁都不许挪。
    let combined = run_git(
        &root,
        &[
            "show",
            "--no-patch",
            r"--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1f%D%x1f%P%x1f%cn%x1f%ce%x1f%ct%x1e",
            "--numstat",
            "--find-renames",
            "-z",
            "-m",
            "--first-parent",
            revision.as_str(),
        ],
    )?;
    if !combined.ok {
        return Err(fail(&combined));
    }
    let (head_str, numstat) = combined
        .stdout
        .split_once('\u{1e}')
        .unwrap_or((combined.stdout.as_str(), ""));
    // -z 下 format 的终止符（\0\n）跟在 %x1e 后面，属于格式残留不是数据。
    let numstat = numstat.trim_start_matches(['\0', '\n', '\r']);
    let fields: Vec<String> = head_str.split('\u{1f}').map(trim_line).collect();
    let at = |index: usize| fields.get(index).cloned().unwrap_or_default();
    let detail = GitCommitDetail {
        hash: at(0),
        short: at(1),
        author: at(2),
        email: at(3),
        authored_ms: at(4).parse::<i64>().unwrap_or(0) * 1000,
        subject: at(5),
        body: at(6).trim().to_string(),
        refs: at(7),
        parents: at(8)
            .split_whitespace()
            .filter_map(|hash| hash.get(..7).map(str::to_string))
            .collect(),
        committer: at(9),
        committer_email: at(10),
        committed_ms: at(11).parse::<i64>().unwrap_or(0) * 1000,
        files: Vec::new(),
    };

    let name_status = run_git(
        &root,
        &[
            "show",
            "--format=",
            "--name-status",
            "--find-renames",
            "-z",
            "-m",
            "--first-parent",
            revision.as_str(),
        ],
    )?;
    Ok(GitCommitDetail {
        files: merge_file_lists(
            Some(numstat),
            name_status.ok.then_some(name_status.stdout.as_str()),
        ),
        ..detail
    })
}

/// numstat 与 name-status 在 `-z` 下都是 NUL token 流（实测于 git 2.x）：
///
/// - numstat 非改名条目是一个 token：`added\tremoved\tpath`；改名条目的
///   第一个 token 以 `\t` 收尾（第三个字段是空串），旧路径、新路径各占一个 token。
/// - name-status 的非改名条目是 `code` + `path` 两个 token；改名/复制是
///   `code` + `旧路径` + `新路径` 三个 token。
///
/// 两条清单按路径对齐：numstat 给行数，name-status 给字母。
/// 之前 numstat 走文本行，部分目录段变化的重命名在文本模式下是
/// `dir/{old => new}/rest` 括号写法，朴素按 ` => ` 切分会产出两个不存在的路径。
fn merge_file_lists(numstat: Option<&str>, name_status: Option<&str>) -> Vec<GitCommitFile> {
    let mut files: Vec<GitCommitFile> = Vec::new();
    // 路径 → 行号。逐条 `iter().find` 比的是整条路径串：一动一千个文件的提交就是
    // 五十万次字符串比较。键借的是入参那两段文本，所以表可以边填 `files` 边查。
    let mut index: HashMap<&str, usize> = HashMap::new();

    let mut numstat_tokens = numstat.unwrap_or("").split('\0').filter(|t| !t.is_empty());
    while let Some(columns) = numstat_tokens.next() {
        let mut fields = columns.split('\t');
        let (Some(added), Some(removed)) = (fields.next(), fields.next()) else {
            continue;
        };
        // 第三个字段是路径；改名条目这里是空串，旧新路径在随后的两个 token 里。
        let maybe_path = fields.next().unwrap_or("");
        let (old_path, new_path) = if maybe_path.is_empty() {
            let (Some(old), Some(new)) = (numstat_tokens.next(), numstat_tokens.next()) else {
                break;
            };
            (old, new)
        } else {
            ("", maybe_path)
        };
        index.insert(new_path, files.len());
        if !old_path.is_empty() {
            index.insert(old_path, files.len());
        }
        files.push(GitCommitFile {
            path: new_path.to_string(),
            old_path: old_path.to_string(),
            status: String::new(),
            added: added.parse::<i64>().unwrap_or(0),
            removed: removed.parse::<i64>().unwrap_or(0),
        });
    }

    let mut status_tokens = name_status.unwrap_or("").split('\0').filter(|t| !t.is_empty());
    while let Some(code) = status_tokens.next() {
        let letter = code.chars().next().unwrap_or(' ').to_string();
        // 重命名/复制带两条路径，旧路径在前；其余情况只有一条。
        let (old_path, new_path) = if letter == "R" || letter == "C" {
            let (Some(old), Some(new)) = (status_tokens.next(), status_tokens.next()) else {
                break;
            };
            (old, new)
        } else {
            let Some(path) = status_tokens.next() else { break };
            ("", path)
        };
        let at = index
            .get(new_path)
            .or_else(|| {
                if old_path.is_empty() {
                    None
                } else {
                    index.get(old_path)
                }
            })
            .copied();
        match at {
            Some(at) => files[at].status = letter,
            None => {
                index.insert(new_path, files.len());
                if !old_path.is_empty() {
                    index.insert(old_path, files.len());
                }
                files.push(GitCommitFile {
                    path: new_path.to_string(),
                    old_path: old_path.to_string(),
                    status: letter,
                    added: 0,
                    removed: 0,
                })
            }
        }
    }
    files
}

/// 提交里某个文件的两侧内容，日志右栏的 diff 用。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileSides {
    /// 父提交一侧；新增文件或根提交时为空串。
    pub original: String,
    /// 该提交一侧；被删除时为空串。
    pub modified: String,
}

/// 仓库相对路径的字符集校验：不许借 `..` 或绝对路径越出工作区。
fn valid_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(":")
        && path.split('/').all(|segment| !segment.is_empty() && segment != "..")
}

#[tauri::command]
pub async fn git_commit_file(
    root: String,
    revision: String,
    path: String,
    old_path: Option<String>,
) -> Result<GitFileSides, String> {
    block(move || git_commit_file_impl(root, revision, path, old_path)).await
}

fn git_commit_file_impl(
    root: String,
    revision: String,
    path: String,
    old_path: Option<String>,
) -> Result<GitFileSides, String> {
    if !valid_rev(&revision) {
        return Err(err("BAD_REV", &revision));
    }
    if !valid_relative(&path) {
        return Err(err("BAD_REPO_PATH", &path));
    }
    // 重命名/复制时父版本在旧路径下、右侧才是新路径；拿不到旧路径时两侧同路径。
    let old_path = old_path.unwrap_or_default();
    if !old_path.is_empty() && !valid_relative(&old_path) {
        return Err(err("BAD_REPO_PATH", &old_path));
    }
    let parent_path = if old_path.is_empty() { path.clone() } else { old_path };
    let root_path = ensure_root(&root)?;
    let blob = |spec: String| -> String {
        run_git(&root_path, &["show", "--textconv", spec.as_str()])
            .map(|output| if output.ok { output.stdout } else { String::new() })
            .unwrap_or_default()
    };
    Ok(GitFileSides {
        original: blob(format!("{revision}^:{parent_path}")),
        modified: blob(format!("{revision}:{path}")),
    })
}
#[cfg(test)]
mod tests {
    use super::{
        forget_ignored, git_authors_impl, git_commit_detail_impl, git_ignored_impl, git_log_impl,
        git_probe_impl, git_restore_file_impl, git_show_impl, git_status_impl, merge_file_lists,
        parse_log, parse_refs, parse_status, read_capped, read_capped_output, valid_range, valid_rev, GitLogQuery,
        git_push_impl, run_git, GitPushOptions, PushTags,
    };
    // relative_path 的用例直接拿 &Path 当根，这里补上类型导入。
    use std::path::Path;

    #[test]
    fn read_capped_keeps_all_bytes_under_the_ceiling() {
        let data = vec![b'a'; 4096];
        let (bytes, overflow) = read_capped(&mut data.as_slice(), 64 * 1024);
        assert!(!overflow);
        assert_eq!(bytes.len(), 4096);
    }

    #[test]
    fn progress_frames_preserve_utf8_crlf_and_final_line() {
        struct Fragmented<'a>(&'a [u8]);
        impl std::io::Read for Fragmented<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let count = self.0.len().min(buffer.len()).min(2);
                buffer[..count].copy_from_slice(&self.0[..count]);
                self.0 = &self.0[count..];
                Ok(count)
            }
        }
        let data = "接收 25%\r接收 100%\r\n完成";
        let lines = std::cell::RefCell::new(Vec::new());
        let send = |line| lines.borrow_mut().push(line);
        let (bytes, overflow) = read_capped_output(&mut Fragmented(data.as_bytes()), 1024, Some(&send));
        assert_eq!(bytes, data.as_bytes());
        assert!(!overflow);
        assert_eq!(lines.into_inner(), ["接收 25%", "接收 100%", "完成"]);
    }

    #[test]
    fn progress_discards_oversized_lines_and_drains_after_capture_limit() {
        let mut data = vec![b'x'; 128 * 1024];
        data.extend_from_slice(b"\rWriting 25%\nfinal");
        let lines = std::cell::RefCell::new(Vec::new());
        let send = |line| lines.borrow_mut().push(line);
        let mut reader = data.as_slice();
        let (bytes, overflow) = read_capped_output(&mut reader, 1024, Some(&send));
        assert!(overflow);
        assert!(bytes.len() <= 1024);
        assert!(reader.is_empty());
        assert_eq!(lines.into_inner(), ["Writing 25%", "final"]);
    }

    /// 拿真实测试项目走一遍读取链（探根、status、log、blob）。依赖本机路径，
    /// 默认 `#[ignore]`；用 `FORGE_DEMO=<仓库根> cargo test --lib -- --ignored git` 跑。
    #[test]
    #[ignore = "requires FORGE_DEMO pointing at a local git repository"]
    fn smoke_against_forge_demo() {
        let Some(demo) = std::env::var_os("FORGE_DEMO") else {
            panic!("FORGE_DEMO 未设置：指向一个本地 git 仓库根目录");
        };
        let demo = Path::new(&demo);
        assert!(demo.join(".git").exists(), "{} 不是 git 仓库", demo.display());
        let root = demo.to_str().expect("demo path utf8").to_string();

        let probe = git_probe_impl(&root);
        assert!(probe.available, "git 可执行文件不可用");
        assert!(probe.repo_root.is_some(), "没认出仓库根");

        let status = git_status_impl(root.clone()).expect("git status 失败");
        let log = git_log_impl(
            root.clone(),
            GitLogQuery {
                reference: String::new(),
                author: String::new(),
                text: String::new(),
                regex: false,
                since_ms: 0,
                path: String::new(),
                skip: 0,
                limit: 10,
            },
        )
        .expect("git log 失败");
        assert!(!log.is_empty(), "demo 仓库应当有提交");
        // 输出上限改造后（0.1）blob 读取链照常工作。
        let blob = git_show_impl(root, "HEAD".to_string(), "package.json".to_string())
            .expect("git show 失败");
        assert!(blob.contains('"'), "package.json 应当是 JSON");
        drop(status);
    }

    #[test]
    fn read_capped_flags_overflow_but_keeps_draining() {
        // 超限后必须一路读到 EOF（Cursor 会走完），否则真管道里的 git 会卡死在写上。
        let data = vec![b'b'; 100 * 1024];
        let (bytes, overflow) = read_capped(&mut data.as_slice(), 8 * 1024);
        assert!(overflow, "超过上限要置位");
        assert!(bytes.len() <= 8 * 1024, "超限的字节不入库");
    }

    #[test]
    fn remote_head_symref_is_not_listed_as_a_branch() {
        // %(refname:short) 把 refs/remotes/origin/HEAD 折成 "origin"，于是远端凭空多出一支
        // 不存在的分支，界面上「远程分支」的数目也跟着多一条。
        let refs = parse_refs(
            " \u{1f}refs/remotes/origin/HEAD\u{1f}\u{1f}refs/remotes/origin/main\n\
             \u{1f}refs/remotes/origin/dev\u{1f}\u{1f}\n\
             \u{1f}refs/remotes/origin/main\u{1f}\u{1f}\n\
             \u{1f}refs/heads/main\u{1f}origin/main\u{1f}\n",
        );
        let names: Vec<&str> = refs.branches.iter().map(|branch| branch.name.as_str()).collect();
        assert_eq!(names, vec!["origin/dev", "origin/main", "main"]);
    }

    #[test]
    fn remote_head_points_at_the_default_branch() {
        let refs = parse_refs(
            " \u{1f}refs/remotes/origin/HEAD\u{1f}\u{1f}refs/remotes/origin/main\n\
             \u{1f}refs/remotes/origin/main\u{1f}\u{1f}\n",
        );
        assert!(refs.branches[0].default_ref);
        assert!(!refs.branches[0].current, "远端默认分支不是当前分支");
    }

    #[test]
    fn local_branch_keeps_current_flag() {
        let refs = parse_refs(
            "*\u{1f}refs/heads/main\u{1f}origin/main\u{1f}\n \u{1f}refs/heads/dev\u{1f}\u{1f}\n",
        );
        assert_eq!(refs.branches[0].upstream, "origin/main");
        assert!(refs.branches[0].current);
        assert!(!refs.branches[0].default_ref);
        assert!(!refs.branches[1].current);
    }

    #[test]
    fn branch_sync_counts_follow_each_upstream() {
        let refs = parse_refs("*\u{1f}refs/heads/main\u{1f}origin/main\u{1f}\u{1f}abc\u{1f}1\u{1f}[ahead 2, behind 3]\n \u{1f}refs/heads/gone\u{1f}origin/gone\u{1f}\u{1f}abc\u{1f}1\u{1f}[gone]\n \u{1f}refs/remotes/origin/main\u{1f}\u{1f}\u{1f}abc\u{1f}1\u{1f}\n");
        assert_eq!((refs.branches[0].ahead, refs.branches[0].behind), (2, 3));
        assert_eq!((refs.branches[1].ahead, refs.branches[1].behind), (0, 0));
        assert_eq!((refs.branches[2].ahead, refs.branches[2].behind), (0, 0));
    }

    /// 分支与标签共用一趟 `for-each-ref`：同一条输出里两种前缀各归各的，
    /// 别把标签当成分支、也别把分支塞进标签表。附注标签取点层目标而不是标签对象哈希。
    #[test]
    fn tags_and_branches_are_split_from_one_ref_listing() {
        let refs = parse_refs(
            "*\u{1f}refs/heads/main\u{1f}origin/main\u{1f}\u{1f}abc1234\u{1f}1700000000\n\
             \u{1f}refs/tags/v1.0\u{1f}\u{1f}\u{1f}9f8e7d6\u{1f}1700000100\n",
        );
        assert_eq!(refs.branches.len(), 1);
        assert_eq!(refs.branches[0].name, "main");
        assert_eq!(refs.tags.len(), 1);
        assert_eq!(refs.tags[0].name, "v1.0");
        assert_eq!(refs.tags[0].target, "9f8e7d6", "要的是标签指向的提交");
        assert_eq!(refs.tags[0].created_ms, 1_700_000_100_000);
    }

    #[test]
    fn every_log_record_hash_works_as_a_revision() {
        // git 在每条 %x1e 记录后面自己补一个换行。切完每条开头都带着它，
        // 带着换行的哈希过不了 valid_rev —— 日志里从第二条起点不开就是这个。
        let record = |hash: &str, subject: &str, refs: &str| {
            format!(
                "{hash}\u{1f}{}\u{1f}xqchen\u{1f}1778000000\u{1f}{subject}\u{1f}{refs}\u{1e}\n",
                &hash[..7]
            )
        };
        let log = parse_log(&format!(
            "{}{}",
            record("fa5084ab3195a985c52a18a6a6590737aec33d9e", "docs: 补分支说明", ""),
            record(
                "2b7c11d4e5f60718293a4b5c6d7e8f9012345678",
                "feat: 预留 --limit 参数",
                "HEAD -> main"
            )
        ));

        assert_eq!(log.len(), 2);
        for commit in &log {
            assert!(valid_rev(&commit.hash), "哈希该能直接当版本引用用：{:?}", commit.hash);
        }
        assert_eq!(log[1].subject, "feat: 预留 --limit 参数");
        assert_eq!(log[1].refs, "HEAD -> main");
    }

    #[test]
    fn branch_header_splits_local_name_from_upstream() {
        let status = parse_status("## main...origin/main [ahead 2, behind 5]\0");
        assert_eq!(status.branch, "main");
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead, 2);
        assert_eq!(status.behind, 5);
        assert!(!status.detached);
    }

    #[test]
    fn branch_header_says_only_the_side_that_diverged() {
        let behind = parse_status("## master...origin/master [behind 1]\0");
        assert_eq!((behind.ahead, behind.behind), (0, 1));

        let ahead = parse_status("## master...origin/master [ahead 3]\0");
        assert_eq!((ahead.ahead, ahead.behind), (3, 0));
    }

    #[test]
    fn branch_header_without_upstream() {
        let status = parse_status("## feature/x\0");
        assert_eq!(status.branch, "feature/x");
        assert_eq!(status.upstream, None);
        assert_eq!(status.ahead, 0);
    }

    #[test]
    fn detached_and_unborn_headers_are_recognised() {
        let detached = parse_status("## HEAD (no branch)\0");
        assert!(detached.detached);
        assert_eq!(detached.branch, "HEAD");

        let unborn = parse_status("## No commits yet on master\0");
        assert_eq!(unborn.branch, "master");
    }

    #[test]
    fn change_lines_map_codes_and_paths() {
        // -z 的实测格式：条目 `XY<空格>路径\0`，重命名是 `R  新\0旧\0`（新路径在前）。
        let status = parse_status(
            "## main\0 M src/App.tsx\0A  added.txt\0R  new.rs\0old.rs\0?? notes.txt\0UU conflict.rs\0",
        );
        let find = |want: &str| {
            status
                .changes
                .iter()
                .find(|change| change.path == want)
                .unwrap_or_else(|| panic!("输出里应有 {want}"))
        };

        let modified = find("src/App.tsx");
        assert_eq!(modified.index_status, " ");
        assert_eq!(modified.work_status, "M");

        assert_eq!(find("added.txt").index_status, "A");

        let renamed = find("new.rs");
        assert_eq!(renamed.old_path.as_deref(), Some("old.rs"));

        let untracked = find("notes.txt");
        assert!(untracked.untracked);
        assert!(untracked.index_status.is_empty());

        assert!(find("conflict.rs").conflicted);
    }

    #[test]
    fn status_z_keeps_spacey_filenames_verbatim() {
        // porcelain v1 的非 z 模式给含空格的名字整段加 C 字符串引号（git 2.29 起），
        // -z 模式原样输出；解析出的路径若带引号，回传 git add 就 pathspec 不匹配。
        let status = parse_status("## master\0 M my file.txt\0?? new file with space.txt\0");
        let find = |want: &str| {
            status
                .changes
                .iter()
                .find(|change| change.path == want)
                .unwrap_or_else(|| panic!("输出里应有 {want}"))
        };
        assert_eq!(find("my file.txt").path, "my file.txt");
        assert_eq!(find("new file with space.txt").path, "new file with space.txt");
    }

    #[test]
    fn changes_come_back_sorted_by_path() {
        let status = parse_status("## main\0 M z.txt\0 M a.txt\0?? m.txt\0");
        let names: Vec<&str> = status.changes.iter().map(|change| change.path.as_str()).collect();
        assert_eq!(names, vec!["a.txt", "m.txt", "z.txt"]);
    }

    #[test]
    fn file_lists_join_numstat_and_status_letters() {
        // -z 实测格式：numstat 非改名是 `added\tremoved\tpath\0`，改名是
        // `added\tremoved\t\0旧\0新\0`（第三个字段为空，旧路径在前）；
        // name-status 是 `code\0路径\0`，改名是 `code\0旧\0新\0`。
        let numstat = "1\t0\tsrc/new.ts\05\t2\t\0old.rs\0new.rs\0";
        let name_status = "A\0src/new.ts\0R100\0old.rs\0new.rs\0";
        let files = merge_file_lists(Some(numstat), Some(name_status));
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].status, "A");
        assert_eq!(files[0].path, "src/new.ts");
        assert_eq!(files[1].path, "new.rs");
        assert_eq!(files[1].old_path, "old.rs");
        assert_eq!(files[1].status, "R");
        assert_eq!(files[1].added, 5);
    }

    #[test]
    fn file_lists_keep_entries_only_one_side_reported() {
        let files = merge_file_lists(Some(""), Some("M\0solo.txt\0"));
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "solo.txt");
        assert_eq!(files[0].status, "M");
        assert_eq!(files[0].added, 0);
    }

    #[test]
    fn partial_directory_renames_come_back_as_full_paths() {
        // 部分目录段变化的重命名在文本 numstat 里是 `dir/{old => new}/rest` 括号写法，
        // 朴素按 ` => ` 切分会产出两个不存在的路径；-z 下 git 直接给完整路径。
        let files = merge_file_lists(
            Some("0\t0\t\0lib/a/b/deep.txt\0lib/c/deep.txt\0"),
            Some("R100\0lib/a/b/deep.txt\0lib/c/deep.txt\0"),
        );
        assert_eq!(files.len(), 1, "同一文件不该因为括号写法拆成两条");
        assert_eq!(files[0].path, "lib/c/deep.txt");
        assert_eq!(files[0].old_path, "lib/a/b/deep.txt");
        assert_eq!(files[0].status, "R");
    }

    #[test]
    fn binary_numstat_counts_fall_back_to_zero() {
        // 二进制文件的行数位是 "-"，落不到整数上就按 0 记。
        let files = merge_file_lists(Some("-\t-\tlogo.png\0"), Some("M\0logo.png\0"));
        assert_eq!(files[0].added, 0);
        assert_eq!(files[0].removed, 0);
    }

    #[test]
    fn log_ranges_split_on_two_or_three_dots() {
        // 三点是对称差语法：直接 split("..") 会拆出 ".b" 这种以点开头的非法片段。
        assert!(valid_range("master..feature"));
        assert!(valid_range("master...feature"));
        assert!(valid_range("..feature"));
        assert!(valid_range("master.."));
        assert!(valid_range("main"));
        assert!(!valid_range("master..fe ature"));
        assert!(!valid_range("ma ster...feature"));
        assert!(!valid_range("master...-flag"));
    }

    #[test]
    fn log_records_split_on_record_and_field_separators() {
        let commits = parse_log("abc123def\u{1f}abc123d\u{1f}张三\u{1f}1700000000\u{1f}fix: 一处\u{1f}HEAD -> main\u{1e}\n");
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].author, "张三");
        assert_eq!(commits[0].authored_ms, 1_700_000_000_000);
        assert_eq!(commits[0].refs, "HEAD -> main");
    }

    #[test]
    fn relative_path_preserves_casing_when_drive_letters_differ() {
        let root = Path::new(r"D:\App\Code\Forge");
        // 目标路径盘符或中间目录大小写不同时，仍然能够剥离并保留目标文件原本的大小写
        let target = r"d:\app\code\forge\src\Components\AppView.tsx";
        let rel = super::relative_path(root, target).expect("成功解析相对路径");
        assert_eq!(rel, "src/Components/AppView.tsx");

        // 直接是相对路径时也能正确放行
        let direct_rel = "src/Components/AppView.tsx";
        assert_eq!(
            super::relative_path(root, direct_rel).expect("相对路径放行"),
            "src/Components/AppView.tsx"
        );
    }

    #[test]
    fn resolve_git_dir_handles_worktree_file() {
        // 创建临时目录测试 .git 文件解析
        let temp = std::env::temp_dir().join(format!("forge_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&temp).unwrap();
        let target_dir = temp.join("real_git_dir");
        std::fs::create_dir_all(&target_dir).unwrap();

        let git_file = temp.join(".git");
        std::fs::write(&git_file, format!("gitdir: {}\n", target_dir.display())).unwrap();

        let resolved = super::resolve_git_dir(&temp);
        assert_eq!(resolved, target_dir);

        let _ = std::fs::remove_dir_all(&temp);
    }

    /// 忽略清单跟着变更扫描一起回来：`git_status` 跑过之后 `git_ignored` 读的就是那份，
    /// 不再起第二个进程；规则文件改了要显式作废才重扫。
    #[test]
    fn ignored_list_rides_along_with_the_status_scan_until_forgotten() {
        let dir = std::env::temp_dir().join(format!("forge-git-ignored-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |repo: &Path, args: &[&str]| {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(repo)
                .args(args)
                .output()
                .expect("起 git 进程失败（测试机需要装 git）");
            assert!(
                output.status.success(),
                "git {:?} 失败：{}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
        };
        let root = dir.to_string_lossy().into_owned();
        git(&dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join(".gitignore"), "build/\n").unwrap();
        std::fs::create_dir_all(dir.join("build")).unwrap();
        std::fs::write(dir.join("build/out.txt"), "x").unwrap();

        // 变更扫描顺带把忽略条目带回来，但它们不是变更，不能混进清单。
        let status = git_status_impl(root.clone()).unwrap();
        assert!(
            status.changes.iter().all(|change| !change.path.starts_with("build")),
            "被忽略的路径不该算变更：{:?}",
            status.changes.iter().map(|c| c.path.as_str()).collect::<Vec<_>>()
        );
        let ignored = git_ignored_impl(root.clone()).unwrap();
        assert!(
            ignored.iter().any(|path| path.starts_with("build")),
            "应带上被忽略的 build/：{:?}",
            ignored
        );

        // 规则清了但没作废：读到的还是上一趟扫描的清单——证明走的是缓存，没重新扫。
        std::fs::write(dir.join(".gitignore"), "").unwrap();
        assert!(
            git_ignored_impl(root.clone()).unwrap().iter().any(|path| path.starts_with("build")),
            "作废之前读到的仍是上一趟扫描的清单"
        );

        // 显式作废之后重扫，拿到新规则下的清单；这一趟也进缓存。
        forget_ignored(&dir);
        assert!(
            git_ignored_impl(root.clone()).unwrap().is_empty(),
            "规则清空后不该还有忽略项"
        );
        assert!(git_ignored_impl(root.clone()).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 真跑 git 进程的端到端冒烟。上面的解析器测试喂的是手写字符串，真实输出里
    /// `-z` 的 NUL 位置、format 终止符这些字节格式只有真 git 能兜底——porcelain
    /// 引号、numstat 排版这类协议级回归，手写字符串永远抓不住。
    #[test]
    fn end_to_end_against_a_real_repo() {
        let dir = std::env::temp_dir().join(format!("forge-git-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |repo: &Path, args: &[&str]| {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(repo)
                .args(args)
                .output()
                .expect("起 git 进程失败（测试机需要装 git）");
            assert!(
                output.status.success(),
                "git {:?} 失败：{}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.email", "t@forge.local"]);
        git(&dir, &["config", "user.name", "forge"]);
        std::fs::write(dir.join("a.txt"), "one").unwrap();
        std::fs::write(dir.join("with space.txt"), "two").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "init"]);

        // 工作区改动 + 未跟踪：status 的 -z 解析要认出含空格的路径且不带引号。
        std::fs::write(dir.join("a.txt"), "one two").unwrap();
        std::fs::write(dir.join("new file.txt"), "three").unwrap();
        let status = git_status_impl(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(status.branch, "main");
        let find = |want: &str| {
            status
                .changes
                .iter()
                .find(|change| change.path == want)
                .unwrap_or_else(|| {
                    let listed: Vec<&str> = status.changes.iter().map(|c| c.path.as_str()).collect();
                    panic!("变更清单里应有 {want}，实际只有 {:?}", listed)
                })
        };
        assert_eq!(find("a.txt").work_status, "M");
        assert!(find("new file.txt").untracked);
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "second"]);

        // 提交详情走「format + numstat 合并成一条 show」的命令组合，-z 解析要出齐清单。
        let detail = git_commit_detail_impl(dir.to_string_lossy().into_owned(), "HEAD".to_string()).unwrap();
        assert_eq!(detail.subject, "second");
        let paths: Vec<&str> = detail.files.iter().map(|file| file.path.as_str()).collect();
        assert!(paths.contains(&"a.txt"), "清单里应有 a.txt：{:?}", paths);
        // 「new file.txt」带空格：-z 输出不做引号转义，解析出的路径要原样。
        assert!(
            paths.contains(&"new file.txt"),
            "含空格的文件名要原样出现：{:?}",
            paths
        );
        assert!(
            !paths.contains(&"with space.txt"),
            "这次提交没动它的文件不该混进清单：{:?}",
            paths
        );
        assert_eq!(
            detail.files.iter().find(|file| file.path == "a.txt").map(|file| file.added),
            Some(1)
        );

        // 空仓库：log / authors 在还没有提交的仓库上要回空列表而不是报错。
        let empty = std::env::temp_dir().join(format!("forge-git-e2e-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&empty);
        std::fs::create_dir_all(&empty).unwrap();
        git(&empty, &["init", "-q", "-b", "main"]);
        git(&empty, &["config", "user.email", "t@forge.local"]);
        git(&empty, &["config", "user.name", "forge"]);
        let log = git_log_impl(empty.to_string_lossy().into_owned(), GitLogQuery::default()).unwrap();
        assert!(log.is_empty(), "空仓库的日志是空列表，不是报错");
        let authors = git_authors_impl(empty.to_string_lossy().into_owned(), 10).unwrap();
        assert!(authors.is_empty(), "空仓库的作者名单是空列表，不是报错");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&empty);
    }

    /// 起一个真实 git 仓库的测试沙盒：init、身份、关掉换行转换（补丁应用对行尾敏感，
    /// 测试机各自的 autocrlf 不该影响断言）。返回目录与一条跑 git 的闭包。
    fn git_sandbox(name: &str) -> (std::path::PathBuf, impl Fn(&[&str])) {
        let dir = std::env::temp_dir().join(format!("forge-git-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = {
            let dir = dir.clone();
            move |args: &[&str]| {
                let output = std::process::Command::new("git")
                    .arg("-C")
                    .arg(&dir)
                    .args(args)
                    .output()
                    .expect("起 git 进程失败（测试机需要装 git）");
                assert!(
                    output.status.success(),
                    "git {args:?} 失败：{}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@forge.local"]);
        run(&["config", "user.name", "forge"]);
        run(&["config", "core.autocrlf", "false"]);
        (dir, run)
    }

    #[test]
    fn commit_diff_preserves_separate_hunks_and_selected_side() {
        let (dir, git) = git_sandbox("commit-diff");
        let root = dir.to_string_lossy().into_owned();
        let file = dir.join("a.txt");
        let original: Vec<String> = (0..2_000).map(|i| format!("line {i}\n")).collect();
        std::fs::write(&file, original.concat()).unwrap();
        git(&["add", "a.txt"]);
        // 未产生首个提交时，--cached 也要返回真实新增内容。
        let initial = super::git_diff_text_impl(root.clone(), "".into(), "".into(), "a.txt".into(), None, true).unwrap();
        assert!(initial.lines().any(|line| line == "+line 1999"));
        git(&["commit", "-qm", "base"]);

        let mut staged = original.clone();
        staged[0] = "staged first\n".into();
        staged[1_999] = "staged last\n".into();
        std::fs::write(&file, staged.concat()).unwrap();
        git(&["add", "a.txt"]);
        let mut working = staged;
        working[1_000] = "working middle\n".into();
        std::fs::write(&file, working.concat()).unwrap();

        let added_lines = |patch: String| -> Vec<String> {
            patch.lines().filter(|line| line.starts_with('+') && !line.starts_with("+++"))
                .map(str::to_owned).collect()
        };
        let index = super::git_diff_text_impl(root.clone(), "".into(), "".into(), "a.txt".into(), None, true).unwrap();
        assert_eq!(added_lines(index), vec!["+staged first", "+staged last"]);
        let working = super::git_diff_text_impl(root, "HEAD".into(), "".into(), "a.txt".into(), None, false).unwrap();
        assert_eq!(added_lines(working), vec!["+staged first", "+working middle", "+staged last"]);
    }

    fn selected_commit(dir: &Path, source: super::CommitSource, no_verify: bool) -> Result<String, String> {
        super::git_commit_impl(dir.to_string_lossy().into_owned(), "selected changes".into(), false, None, false, None, no_verify,
            Some(vec![super::CommitSelection { path: "a.txt".into(), old_path: None, source }]))
    }

    #[test]
    fn selected_commit_worktree_only_preserves_remaining_staged_changes() {
        let (dir, git) = git_sandbox("selected-commit-worktree");
        let original: Vec<String> = (0..40).map(|i| format!("line {i}\n")).collect();
        std::fs::write(dir.join("a.txt"), original.concat()).unwrap();
        std::fs::write(dir.join("other.txt"), "base\n").unwrap();
        git(&["add", "a.txt", "other.txt"]);
        git(&["commit", "-qm", "base"]);
        let mut staged = original.clone();
        staged[1] = "staged A\n".into();
        std::fs::write(dir.join("a.txt"), staged.concat()).unwrap();
        std::fs::write(dir.join("other.txt"), "unselected staged\n").unwrap();
        git(&["add", "a.txt", "other.txt"]);
        let mut working = staged;
        working[35] = "working B\n".into();
        std::fs::write(dir.join("a.txt"), working.concat()).unwrap();
        let mut expected = original;
        expected[35] = "working B\n".into();

        selected_commit(&dir, super::CommitSource::WorktreeOnly, true).unwrap();
        assert_eq!(git_stdout(&dir, &["show", "HEAD:a.txt"]), expected.concat().trim_end());
        assert_eq!(git_stdout(&dir, &["show", ":a.txt"]), working.concat().trim_end());
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), working.concat());
        assert_eq!(git_stdout(&dir, &["show", "HEAD:other.txt"]), "base");
        assert_eq!(git_stdout(&dir, &["show", ":other.txt"]), "unselected staged");
        assert!(!dir.join(".git/index.lock").exists());
    }

    #[test]
    fn selected_commit_rejects_dependent_worktree_changes_without_mutation() {
        let (dir, git) = git_sandbox("selected-commit-dependent");
        std::fs::write(dir.join("a.txt"), "base\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-qm", "base"]);
        std::fs::write(dir.join("a.txt"), "staged\n").unwrap();
        git(&["add", "a.txt"]);
        std::fs::write(dir.join("a.txt"), "working\n").unwrap();
        let index = std::fs::read(dir.join(".git/index")).unwrap();
        let head = git_stdout(&dir, &["rev-parse", "HEAD"]);
        let error = selected_commit(&dir, super::CommitSource::WorktreeOnly, true).unwrap_err();
        assert_eq!(error.split(crate::error::SEP).next(), Some("PARTIAL_COMMIT_CONFLICT"));
        assert_eq!(git_stdout(&dir, &["rev-parse", "HEAD"]), head);
        assert_eq!(std::fs::read(dir.join(".git/index")).unwrap(), index);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "working\n");
        assert!(!dir.join(".git/index.lock").exists());
    }

    #[test]
    fn selected_commit_nearby_independent_changes_do_not_require_selecting_both_sides() {
        let (dir, git) = git_sandbox("selected-commit-nearby");
        let original: Vec<String> = (0..12).map(|i| format!("line {i}\n")).collect();
        std::fs::write(dir.join("a.txt"), original.concat()).unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-qm", "base"]);
        git(&["config", "diff.noprefix", "true"]);
        let mut working = original.clone();
        working[1] = "staged A\n".into();
        std::fs::write(dir.join("a.txt"), working.concat()).unwrap();
        git(&["add", "a.txt"]);
        working[3] = "working B\n".into();
        std::fs::write(dir.join("a.txt"), working.concat()).unwrap();
        selected_commit(&dir, super::CommitSource::WorktreeOnly, true).unwrap();
        let mut expected = original;
        expected[3] = "working B\n".into();
        assert_eq!(git_stdout(&dir, &["show", "HEAD:a.txt"]), expected.concat().trim_end());
        assert_eq!(git_stdout(&dir, &["show", ":a.txt"]), working.concat().trim_end());
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), working.concat());
    }

    #[test]
    fn selected_commit_merge_drivers_cannot_include_unselected_staged_content() {
        for mode in ["attribute", "default", "custom-text"] {
            let (dir, git) = git_sandbox(&format!("selected-commit-driver-{mode}"));
            std::fs::write(dir.join("a.txt"), "root\ntail\n").unwrap();
            git(&["add", "a.txt"]);
            git(&["commit", "-qm", "base"]);
            std::fs::write(dir.join("a.txt"), "root\nA\ntail\n").unwrap();
            git(&["add", "a.txt"]);
            std::fs::write(dir.join("a.txt"), "root\nA B\ntail\n").unwrap();
            match mode {
                "attribute" => std::fs::write(dir.join(".gitattributes"), "a.txt merge=union\n").unwrap(),
                "default" => git(&["config", "merge.default", "union"]),
                _ => git(&["config", "merge.text.driver", "true"]),
            }
            let index = std::fs::read(dir.join(".git/index")).unwrap();
            let head = git_stdout(&dir, &["rev-parse", "HEAD"]);
            let error = selected_commit(&dir, super::CommitSource::WorktreeOnly, true).unwrap_err();
            assert_eq!(error.split(crate::error::SEP).next(), Some("PARTIAL_COMMIT_CONFLICT"));
            assert_eq!(git_stdout(&dir, &["rev-parse", "HEAD"]), head);
            assert_eq!(std::fs::read(dir.join(".git/index")).unwrap(), index);
            assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "root\nA B\ntail\n");
        }
    }

    #[test]
    fn selected_commit_preserves_index_on_hook_failure_and_honors_both_other_sources() {
        let (dir, git) = git_sandbox("selected-commit-hook");
        std::fs::write(dir.join("a.txt"), "base\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-qm", "base"]);
        std::fs::write(dir.join("a.txt"), "staged\n").unwrap();
        git(&["add", "a.txt"]);
        std::fs::write(dir.join("a.txt"), "working\n").unwrap();
        std::fs::write(dir.join(".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n").unwrap();
        let index = std::fs::read(dir.join(".git/index")).unwrap();
        let head = git_stdout(&dir, &["rev-parse", "HEAD"]);
        assert!(selected_commit(&dir, super::CommitSource::Index, false).is_err());
        assert_eq!(std::fs::read(dir.join(".git/index")).unwrap(), index);
        assert_eq!(git_stdout(&dir, &["rev-parse", "HEAD"]), head);
        selected_commit(&dir, super::CommitSource::Index, true).unwrap();
        assert_eq!(git_stdout(&dir, &["show", "HEAD:a.txt"]), "staged");
        assert_eq!(git_stdout(&dir, &["show", ":a.txt"]), "staged");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "working\n");
        selected_commit(&dir, super::CommitSource::Worktree, true).unwrap();
        assert_eq!(git_stdout(&dir, &["show", "HEAD:a.txt"]), "working");
        assert_eq!(git_stdout(&dir, &["show", ":a.txt"]), "working");
        std::fs::write(dir.join("a.txt"), "needs formatting\n").unwrap();
        std::fs::write(dir.join(".git/hooks/pre-commit"), "#!/bin/sh\nprintf 'formatted\\n' > a.txt\ngit add -- a.txt\n").unwrap();
        selected_commit(&dir, super::CommitSource::Worktree, false).unwrap();
        assert_eq!(git_stdout(&dir, &["show", "HEAD:a.txt"]), "formatted");
        assert_eq!(git_stdout(&dir, &["show", ":a.txt"]), "formatted");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "formatted\n");
    }

    #[test]
    fn selected_commit_handles_unborn_and_linked_worktree_indexes() {
        let (dir, git) = git_sandbox("selected-commit-linked");
        let original: Vec<String> = (0..40).map(|i| format!("line {i}\n")).collect();
        std::fs::write(dir.join("a.txt"), original.concat()).unwrap();
        selected_commit(&dir, super::CommitSource::Worktree, true).unwrap();
        let main_head = git_stdout(&dir, &["rev-parse", "HEAD"]);
        let linked = dir.join("linked");
        let linked_path = linked.to_string_lossy().into_owned();
        git(&["worktree", "add", "-q", "-b", "linked", &linked_path]);
        let mut staged = original.clone();
        staged[1] = "staged A\n".into();
        std::fs::write(linked.join("a.txt"), staged.concat()).unwrap();
        git(&["-C", &linked_path, "add", "a.txt"]);
        let mut working = staged;
        working[35] = "working B\n".into();
        std::fs::write(linked.join("a.txt"), working.concat()).unwrap();
        selected_commit(&linked, super::CommitSource::WorktreeOnly, true).unwrap();
        let mut expected = original;
        expected[35] = "working B\n".into();
        assert_eq!(git_stdout(&linked, &["show", "HEAD:a.txt"]), expected.concat().trim_end());
        assert_eq!(git_stdout(&linked, &["show", ":a.txt"]), working.concat().trim_end());
        assert_eq!(git_stdout(&dir, &["rev-parse", "HEAD"]), main_head);
    }

    #[test]
    fn selected_commit_rename_and_recreated_old_path_do_not_overwrite_each_other() {
        for working in [false, true] {
            let (dir, git) = git_sandbox(if working { "selected-rename-working" } else { "selected-rename-index" });
            std::fs::write(dir.join("a.txt"), "original\n").unwrap();
            git(&["add", "a.txt"]);
            git(&["commit", "-qm", "base"]);
            git(&["mv", "a.txt", "b.txt"]);
            std::fs::write(dir.join("a.txt"), "replacement\n").unwrap();
            let selections = vec![
                super::CommitSelection { path: "b.txt".into(), old_path: Some("a.txt".into()), source: if working { super::CommitSource::Worktree } else { super::CommitSource::Index } },
                super::CommitSelection { path: "a.txt".into(), old_path: None, source: super::CommitSource::Worktree },
            ];
            super::git_commit_impl(dir.to_string_lossy().into_owned(), "rename and recreate".into(), false, None, false, None, true, Some(selections)).unwrap();
            assert_eq!(git_stdout(&dir, &["show", "HEAD:a.txt"]), "replacement");
            assert_eq!(git_stdout(&dir, &["show", "HEAD:b.txt"]), "original");
            assert!(git_stdout(&dir, &["diff", "--cached"]).is_empty());
        }
    }

    #[cfg(windows)]
    #[test]
    fn selected_commit_preserves_recovery_index_after_install_failure() {
        use std::os::windows::fs::OpenOptionsExt;
        let (dir, git) = git_sandbox("selected-commit-recovery");
        std::fs::write(dir.join("a.txt"), "base\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-qm", "base"]);
        std::fs::write(dir.join("a.txt"), "working\n").unwrap();
        // 模拟另一个进程持有真实索引的句柄：可读，但拒绝安装新索引。
        let held = std::fs::OpenOptions::new().read(true).share_mode(1).open(dir.join(".git/index")).unwrap();
        let error = selected_commit(&dir, super::CommitSource::Worktree, true).unwrap_err();
        let parts: Vec<&str> = error.split(crate::error::SEP).collect();
        assert_eq!(parts[0], "COMMIT_INDEX_RECOVERY");
        assert_eq!(git_stdout(&dir, &["show", "HEAD:a.txt"]), "working");
        assert_eq!(git_stdout(&dir, &["show", ":a.txt"]), "base");
        let recovery = super::TempIndex(std::path::PathBuf::from(parts[1]), false);
        assert_eq!(super::selected_git(&dir, &["show", ":a.txt"], None, Some(&recovery)).unwrap(), "working\n");
        assert!(!dir.join(".git/index.lock").exists());
        drop(held);
    }

    #[test]
    fn push_uses_configured_remote_and_target_for_explicit_branch() {
        let (dir, git) = git_sandbox("push-target");
        let remote = dir.join("remote.git").to_string_lossy().into_owned();
        let backup = dir.join("backup.git").to_string_lossy().into_owned();
        git(&["init", "--bare", "-q", &remote]);
        git(&["init", "--bare", "-q", &backup]);
        git(&["commit", "--allow-empty", "-qm", "base"]);
        let base = git_stdout(&dir, &["rev-parse", "HEAD"]);
        git(&["branch", "topic"]);
        git(&["commit", "--allow-empty", "-qm", "head-only"]);
        git(&["remote", "add", "backup", &backup]);
        git(&["remote", "add", "team/origin", &remote]);
        git(&["config", "branch.topic.remote", "team/origin"]);
        git(&["config", "branch.topic.merge", "refs/heads/review/topic"]);
        git(&["config", "push.default", "matching"]);
        let root = dir.to_string_lossy().into_owned();
        git_push_impl(root, GitPushOptions { branch: Some("topic".into()), set_upstream: true, ..Default::default() }).unwrap();
        assert_eq!(git_stdout(&dir, &["--git-dir", &remote, "rev-parse", "refs/heads/review/topic"]), base);
        assert_eq!(git_stdout(&dir, &["--git-dir", &backup, "for-each-ref"]), "");
        assert_eq!(git_stdout(&dir, &["config", "branch.topic.remote"]), "team/origin");
        assert_eq!(git_stdout(&dir, &["config", "branch.topic.merge"]), "refs/heads/review/topic");
    }

    #[test]
    fn updating_other_branch_fast_forwards_without_checkout_and_rejects_divergence() {
        let (dir, git) = git_sandbox("update-other-branch");
        let remote = dir.join("remote.git").to_string_lossy().into_owned();
        git(&["init", "--bare", "-q", &remote]);
        git(&["remote", "add", "team/origin", &remote]);
        std::fs::write(dir.join("local.txt"), "base\n").unwrap();
        git(&["add", "local.txt"]);
        git(&["commit", "-qm", "base"]);
        git(&["branch", "topic"]);
        git(&["config", "branch.topic.remote", "team/origin"]);
        git(&["config", "branch.topic.merge", "refs/heads/main"]);
        git(&["commit", "--allow-empty", "-qm", "remote advance"]);
        git(&["push", "-qu", "team/origin", "main"]);
        let root = dir.to_string_lossy().into_owned();
        let head = git_stdout(&dir, &["rev-parse", "HEAD"]);
        std::fs::write(dir.join("local.txt"), "dirty\n").unwrap();
        super::git_update_branch_impl(root.clone(), "topic".into(), None).unwrap();
        assert_eq!(git_stdout(&dir, &["rev-parse", "topic"]), head);
        assert_eq!(git_stdout(&dir, &["symbolic-ref", "--short", "HEAD"]), "main");
        assert_eq!(std::fs::read_to_string(dir.join("local.txt")).unwrap(), "dirty\n");
        assert!(super::git_update_branch_impl(root.clone(), "main".into(), None).is_err());
        git(&["checkout", "-q", "topic"]);
        git(&["commit", "--allow-empty", "-qm", "local topic"]);
        let topic = git_stdout(&dir, &["rev-parse", "topic"]);
        git(&["checkout", "-q", "main"]);
        git(&["commit", "--allow-empty", "-qm", "remote diverges"]);
        git(&["push", "-q", "team/origin", "main"]);
        assert!(super::git_update_branch_impl(root, "topic".into(), None).is_err());
        assert_eq!(git_stdout(&dir, &["rev-parse", "topic"]), topic);
        assert_eq!(git_stdout(&dir, &["symbolic-ref", "--short", "HEAD"]), "main");
    }

    #[test]
    fn push_tags_modes_and_revision_preserve_ref_contracts() {
        let (dir, git) = git_sandbox("push-tags");
        let remote = dir.join("remote.git").to_string_lossy().into_owned();
        git(&["init", "--bare", "-q", &remote]);
        git(&["remote", "add", "origin", &remote]);
        git(&["commit", "--allow-empty", "-qm", "base"]);
        let base = git_stdout(&dir, &["rev-parse", "HEAD"]);
        git(&["tag", "light"]);
        git(&["tag", "-a", "annotated", "-m", "tag"]);
        git(&["commit", "--allow-empty", "-qm", "tip"]);
        let tip = git_stdout(&dir, &["rev-parse", "HEAD"]);
        let root = dir.to_string_lossy().into_owned();
        git_push_impl(root.clone(), GitPushOptions { revision: Some(base.clone()), ..Default::default() }).unwrap();
        assert_eq!(git_stdout(&dir, &["--git-dir", &remote, "rev-parse", "refs/heads/main"]), base);
        assert!(!run_git(&dir, &["config", "--get", "branch.main.remote"]).unwrap().ok);
        git_push_impl(root.clone(), GitPushOptions { tags: Some(PushTags::CurrentBranch), ..Default::default() }).unwrap();
        assert_eq!(git_stdout(&dir, &["--git-dir", &remote, "tag", "--list"]), "annotated");
        assert_eq!(git_stdout(&dir, &["--git-dir", &remote, "rev-parse", "refs/heads/main"]), tip);
        git_push_impl(root.clone(), GitPushOptions { tags: Some(PushTags::All), ..Default::default() }).unwrap();
        assert_eq!(git_stdout(&dir, &["--git-dir", &remote, "tag", "--list"]), "annotated\nlight");
        for target in ["bad..name", "a//b", "bad.lock", "-option"] {
            assert!(git_push_impl(root.clone(), GitPushOptions { target: Some(target.into()), ..Default::default() }).is_err());
        }
        assert!(git_push_impl(root, GitPushOptions { remote: Some("--all".into()), ..Default::default() }).is_err());
    }

    #[test]
    fn push_never_downgrades_an_expired_lease() {
        let (dir, git) = git_sandbox("push-lease");
        let remote = dir.join("remote.git").to_string_lossy().into_owned();
        git(&["init", "--bare", "-q", &remote]);
        git(&["remote", "add", "origin", &remote]);
        git(&["commit", "--allow-empty", "-qm", "base"]);
        let base = git_stdout(&dir, &["rev-parse", "HEAD"]);
        let root = dir.to_string_lossy().into_owned();
        git_push_impl(root.clone(), GitPushOptions::default()).unwrap();
        git(&["commit", "--allow-empty", "-qm", "remote tip"]);
        let tip = git_stdout(&dir, &["rev-parse", "HEAD"]);
        git_push_impl(root.clone(), GitPushOptions::default()).unwrap();
        git(&["update-ref", "refs/remotes/origin/main", &base]);
        let options = GitPushOptions { revision: Some(base.clone()), ..Default::default() };
        assert!(git_push_impl(root.clone(), options.clone()).is_err());
        assert!(git_push_impl(root.clone(), GitPushOptions { force_with_lease: true, ..options.clone() }).is_err());
        assert_eq!(git_stdout(&dir, &["--git-dir", &remote, "rev-parse", "refs/heads/main"]), tip);
        git(&["fetch", "-q", "origin"]);
        git_push_impl(root, GitPushOptions { force_with_lease: true, ..options }).unwrap();
        assert_eq!(git_stdout(&dir, &["--git-dir", &remote, "rev-parse", "refs/heads/main"]), base);
    }

    #[test]
    fn update_restores_dirty_changes_and_reports_autostash_conflicts() {
        for (name, method, conflict) in [("update-merge", "merge", false), ("update-rebase", "rebase", false), ("update-stash-conflict", "merge", true)] {
            let (dir, git) = git_sandbox(name);
            let root = dir.to_string_lossy().into_owned();
            let remote = dir.join("remote.git").to_string_lossy().into_owned();
            let peer = dir.join("peer").to_string_lossy().into_owned();
            git(&["init", "--bare", "-q", &remote]);
            git(&["remote", "add", "origin", &remote]);
            std::fs::write(dir.join("shared.txt"), "base\n").unwrap();
            std::fs::write(dir.join("local.txt"), "base\n").unwrap();
            git(&["add", "shared.txt", "local.txt"]);
            git(&["commit", "-qm", "base"]);
            git(&["push", "-qu", "origin", "main"]);
            git(&["clone", "-q", "--branch", "main", &remote, &peer]);
            git(&["-C", &peer, "config", "user.email", "peer@forge.local"]);
            git(&["-C", &peer, "config", "user.name", "peer"]);
            std::fs::write(Path::new(&peer).join("shared.txt"), "remote\n").unwrap();
            git(&["-C", &peer, "add", "shared.txt"]);
            git(&["-C", &peer, "commit", "-qm", "remote change"]);
            git(&["-C", &peer, "push", "-q", "origin", "main"]);
            if !conflict { git(&["commit", "--allow-empty", "-qm", "local commit"]); }
            let dirty = if conflict { "shared.txt" } else { "local.txt" };
            std::fs::write(dir.join(dirty), "dirty\n").unwrap();
            let result = super::git_pull_impl(root.clone(), method);
            let status = git_status_impl(root).unwrap();
            if conflict {
                assert!(result.is_err(), "自动暂存恢复冲突不能作为成功更新返回");
                assert!(status.changes.iter().any(|change| change.conflicted));
                assert!(!git_stdout(&dir, &["stash", "list"]).is_empty(), "冲突改动必须保留在 stash");
            } else {
                result.unwrap();
                assert_eq!(std::fs::read_to_string(dir.join(dirty)).unwrap(), "dirty\n");
                assert!(std::fs::read_to_string(dir.join("shared.txt")).unwrap().starts_with("remote"));
                assert!(status.changes.iter().any(|change| change.path == "local.txt"));
                assert!(git_stdout(&dir, &["stash", "list"]).is_empty());
            }
        }
    }

    #[test]
    fn pushing_an_explicit_tag_does_not_push_a_same_named_branch() {
        let (dir, git) = git_sandbox("push-tag-name");
        let remote = dir.join("remote.git").to_string_lossy().into_owned();
        git(&["init", "--bare", "-q", &remote]);
        git(&["remote", "add", "origin", &remote]);
        git(&["commit", "--allow-empty", "-qm", "base"]);
        git(&["branch", "release"]);
        git(&["tag", "release"]);
        super::git_push_ref_impl(dir.to_string_lossy().into_owned(), "refs/tags/release".into()).unwrap();
        assert!(run_git(&dir, &["--git-dir", &remote, "show-ref", "--verify", "refs/tags/release"]).unwrap().ok);
        assert!(!run_git(&dir, &["--git-dir", &remote, "show-ref", "--verify", "refs/heads/release"]).unwrap().ok);
    }

    /// 在沙盒里跑一条有输出的 git 命令并取 stdout（取哈希用）。
    fn git_stdout(dir: &std::path::Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("起 git 进程失败（测试机需要装 git）");
        assert!(
            out.status.success(),
            "git {args:?} 失败：{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn restore_file_empty_revision_restores_from_index_not_head() {
        // 已暂存「two」、工作区又改「three」：空 revision 的回滚丢的只是未暂存那层，
        // 索引内容原样；非空 revision 仍从指定版本取。
        let (dir, git) = git_sandbox("restore-index");
        std::fs::write(dir.join("f.txt"), "one").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "base"]);
        std::fs::write(dir.join("f.txt"), "two").unwrap();
        git(&["add", "f.txt"]);
        std::fs::write(dir.join("f.txt"), "three").unwrap();

        let root = dir.to_string_lossy().into_owned();
        let path = dir.join("f.txt").to_string_lossy().into_owned();
        git_restore_file_impl(root.clone(), String::new(), path.clone()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("f.txt")).unwrap(),
            "two",
            "空 revision 从索引恢复，只丢未暂存那层"
        );
        // 索引那层没被碰：暂存的「two」对 HEAD 仍是已暂存修改，工作区这层已并平。
        let porcelain = git_stdout(&dir, &["status", "--porcelain"]);
        assert!(
            porcelain.contains("M  f.txt"),
            "restore 不碰 index，暂存内容要还在：{porcelain:?}"
        );
        git_restore_file_impl(root, "HEAD".to_string(), path).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("f.txt")).unwrap(),
            "one",
            "非空 revision 仍从指定版本取"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

