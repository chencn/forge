use crate::offload::block_value;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Windows 上别为控制台程序弹出一闪而过的窗口。其余平台什么都不做。
pub fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// 路径指向一个存在的普通文件。
pub fn is_file(path: &str) -> bool {
    !path.is_empty() && std::path::Path::new(path).is_file()
}

/// 原子写一份文本：先写同目录的 `.tmp`，再改名盖过去。
///
/// 直接 `fs::write` 覆盖，进程在写一半时被杀掉就留下半截 JSON，
/// 下一次启动解析失败只能退回默认值，用户填的全丢。
pub fn write_atomic(path: &std::path::Path, text: &str) -> Result<(), String> {
    let tmp = std::path::PathBuf::from(format!("{}.tmp", path.display()));
    std::fs::write(&tmp, text).map_err(|error| {
        crate::error::err_parts("IO", &[tmp.display().to_string(), error.to_string()])
    })?;
    std::fs::rename(&tmp, path).map_err(|error| {
        crate::error::err_parts("IO", &[path.display().to_string(), error.to_string()])
    })
}

/// 拿一个环境变量拼出候选路径；变量没设就返回空串。
pub fn env_path(key: &str, tail: &str) -> String {
    match std::env::var(key) {
        Ok(root) if !root.is_empty() => {
            format!("{}{}{}", root.trim_end_matches(['\\', '/']), std::path::MAIN_SEPARATOR, tail)
        }
        _ => String::new(),
    }
}

/// 变量本身就是一条完整路径时用这个（ComSpec 之类），别再往后面接分隔符。
pub fn env_raw(key: &str) -> String {
    std::env::var(key).unwrap_or_default()
}

/// 在 PATH 里找一个程序，找到就返回全路径。
///
/// 目录表只切一次：`split_paths` 一趟约 40 次分配，每次查找都重切纯属白做。
pub fn which(name: &str) -> String {
    path_dirs()
        .iter()
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
        .map(|found| found.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn path_dirs() -> &'static [std::path::PathBuf] {
    static DIRS: OnceLock<Vec<std::path::PathBuf>> = OnceLock::new();
    DIRS.get_or_init(|| {
        std::env::var("PATH")
            .map(|list| std::env::split_paths(&list).collect())
            .unwrap_or_default()
    })
}

/// 未命中的结果只信这么久。装完一个工具（进的是本来就在 PATH 上的目录，如 `%APPDATA%\npm`）
/// 不该一直报「没装」，更不该把 `${mvn}` 这类占位符一直判成缺工具而拒跑。
const WHICH_MISS_TTL: Duration = Duration::from_secs(60);

/// 按「程序名」在 PATH 里找，Windows 上把 `.exe`/`.cmd`/`.bat` 这几档后缀都试一遍。
///
/// `where mvn` 命中的是 `mvn.cmd`，只按裸名拼路径会永远找不到；`java` 同理是 `java.exe`。
pub fn which_program(base: &str) -> String {
    // 找过的结果留着：未命中要试 4 档后缀 × 全部 PATH 目录，
    // 上百个 npm 包的工程能磨出上万次路径 stat，Windows 上每一次都过一遍杀毒过滤。
    // 命中那次也要现验一遍文件还在（一次 stat，远低于一整轮 PATH 扫描），卸载了才不至于继续给旧路径。
    static FOUND: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();
    let memo = FOUND.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((at, hit)) = memo
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(base)
    {
        let still_there = if hit.is_empty() {
            at.elapsed() < WHICH_MISS_TTL
        } else {
            std::path::Path::new(hit).is_file()
        };
        if still_there {
            return hit.clone();
        }
    }
    let found = search_program(base);
    memo.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(base.to_string(), (Instant::now(), found.clone()));
    found
}

/// 非 Windows 上按进程组杀整棵树：给负 pid 发 SIGKILL，组里所有进程一起收。
/// 组不存在（进程已退）或调用失败回 false，调用方据此回退到杀直接子进程。
/// 只对 spawn 时用 `process_group(0)` 自建的组发信号，不触碰别的进程。
#[cfg(not(windows))]
pub fn kill_process_group(pid: u32) -> bool {
    let pid = i32::try_from(pid).unwrap_or(0);
    pid > 0 && unsafe { libc::kill(-pid, libc::SIGKILL) == 0 }
}

fn search_program(base: &str) -> String {
    if !cfg!(windows) {
        return which(base);
    }
    for suffix in ["", ".exe", ".cmd", ".bat"] {
        let found = which(&format!("{base}{suffix}"));
        if !found.is_empty() {
            return found;
        }
    }
    String::new()
}

/// 跑一条命令取一行文本输出。`java -version` 这类写在 stderr 的也算：先取 stdout，
/// 空了就取 stderr。取不到回空串。
pub fn capture_text(program: &str, args: &[&str]) -> String {
    if program.is_empty() {
        return String::new();
    }
    let mut command = Command::new(program);
    command.args(args);
    hide_console(&mut command);
    let Ok(output) = command.output() else {
        return String::new();
    };
    let pick = |bytes: &Vec<u8>| {
        String::from_utf8_lossy(bytes)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or_default()
            .to_string()
    };
    let stdout = pick(&output.stdout);
    if stdout.is_empty() {
        pick(&output.stderr)
    } else {
        stdout
    }
}

/// 状态栏右下角的内存读数，单位 MB。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    /// 本应用及其全部后代进程的合计私有工作集。用私有工作集而不是工作集：后者把映射进来的
    /// 共享 DLL 页算进每个进程，WebView2 那六七个进程相加会虚高几百 MB。
    pub app_mb: u64,
    /// 物理内存总量；取不到时为 0，前端据此决定要不要画这条。
    pub total_mb: u64,
    /// 分组明细，占用降序。每档先按 MB 取整再相加，所以 `app_mb` 恒等于各档之和，
    /// 与真实字节数最多差几 MB——hover 里用户能把各行自己加回核对。
    pub parts: Vec<MemoryPart>,
}

impl Memory {
    /// 后端线程起不来时的兜底值。`total_mb` 为 0，前端本就不画这一格。
    fn empty() -> Memory {
        Memory {
            app_mb: 0,
            total_mb: 0,
            parts: Vec::new(),
        }
    }
}

/// 一组同归属的进程。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPart {
    /// `host` / `webview` / `child`，前端据此取文案。
    pub kind: &'static str,
    /// 可执行文件名，小写；`host` 档为空串。
    pub program: String,
    /// 该档进程私有工作集的合计。
    pub mb: u64,
    /// 该档进程数。
    pub count: u32,
}

/// 进程快照里的一行。
#[derive(Clone, Debug)]
pub struct ProcInfo {
    pub pid: u32,
    pub ppid: u32,
    pub program: String,
}

const MB: u64 = 1024 * 1024;
const HOST: &str = "host";
const WEBVIEW: &str = "webview";
const CHILD: &str = "child";
/// Tauri 的页面代码全跑在这些进程里，宿主进程那次 API 调用读不到，只能按进程名归到一档。
const WEBVIEW_EXE: &str = "msedgewebview2.exe";

/// 挑出 `self_pid` 及其全部后代，按归属归并成几档。
///
/// 后代靠 `ppid` 链推：Windows 在父进程先退出时不会把孩子重挂到别处，那一行的 `ppid`
/// 指向一个已死的 pid，链断在这里，整棵子树就不算了——宁可少报，也不把无关进程记到本应用头上。
/// `seen` 挡的是 PID 复用造成的环，环一旦闭合按 `ppid` 推会无限循环。
fn group(
    rows: &[ProcInfo],
    self_pid: u32,
    mut read_bytes: impl FnMut(u32) -> u64,
) -> Vec<MemoryPart> {
    let mut by_pid: HashMap<u32, &ProcInfo> = HashMap::new();
    let mut kids: HashMap<u32, Vec<u32>> = HashMap::new();
    for row in rows {
        by_pid.insert(row.pid, row);
        kids.entry(row.ppid).or_default().push(row.pid);
    }

    let mut picked: Vec<&ProcInfo> = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut queue: VecDeque<u32> = VecDeque::new();
    queue.push_back(self_pid);
    seen.insert(self_pid);
    while let Some(pid) = queue.pop_front() {
        if let Some(row) = by_pid.get(&pid) {
            picked.push(row);
        }
        if let Some(children) = kids.get(&pid) {
            for child in children {
                if seen.insert(*child) {
                    queue.push_back(*child);
                }
            }
        }
    }

    let mut parts: Vec<MemoryPart> = Vec::new();
    for row in picked {
        let (kind, program) = if row.pid == self_pid {
            (HOST, String::new())
        } else if row.program.eq_ignore_ascii_case(WEBVIEW_EXE) {
            (WEBVIEW, WEBVIEW_EXE.to_string())
        } else {
            (CHILD, row.program.to_ascii_lowercase())
        };
        let mb = read_bytes(row.pid) / MB;
        match parts
            .iter_mut()
            .find(|part| part.kind == kind && part.program == program)
        {
            Some(part) => {
                part.mb += mb;
                part.count += 1;
            }
            None => parts.push(MemoryPart {
                kind,
                program,
                mb,
                count: 1,
            }),
        }
    }
    parts.sort_by(|a, b| b.mb.cmp(&a.mb).then_with(|| a.program.cmp(&b.program)));
    parts
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    use super::{group, MemoryPart, ProcInfo, MB};

    #[repr(C)]
    struct ProcessMemoryCountersEx {
        cb: u32,
        page_fault_count: u32,
        peak_working_set: usize,
        working_set: usize,
        quota_peak_paged_pool: usize,
        quota_paged_pool: usize,
        quota_peak_non_paged_pool: usize,
        quota_non_paged_pool: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
        private_usage: usize,
    }

    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }

    /// `PROCESSENTRY32W`。`szExeFile` 只有文件名不含路径，正好是分组要的那一维。
    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn K32GetProcessMemoryInfo(
            process: *mut c_void,
            counters: *mut ProcessMemoryCountersEx,
            length: u32,
        ) -> i32;
        fn GlobalMemoryStatusEx(status: *mut MemoryStatusEx) -> i32;
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> *mut c_void;
        fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    /// `GetCurrentProcess()` 返回的伪句柄，指向本进程。
    const SELF: *mut c_void = -1isize as *mut c_void;
    /// `CreateToolhelp32Snapshot`/`OpenProcess` 的失败值。两者失败时返回的不是 NULL，
    /// 是 `INVALID_HANDLE_VALUE`（全 1），所以每个句柄这两个值都得判。
    const INVALID: *mut c_void = -1isize as *mut c_void;
    const SNAP_PROCESS: u32 = 0x0000_0002;
    /// `K32GetProcessMemoryInfo` 要读进程的虚拟内存状态，只给 QUERY_LIMITED 在 Win8.1 之前拿不到。
    const QUERY: u32 = 0x0400 | 0x0010 | 0x1000;

    /// 内核返回的 UTF-16 名，NUL 结尾。
    fn wide(text: &[u16]) -> String {
        let end = text.iter().position(|c| *c == 0).unwrap_or(text.len());
        String::from_utf16_lossy(&text[..end])
    }

    fn private_set(handle: *mut c_void) -> u64 {
        let mut counters = unsafe { std::mem::zeroed::<ProcessMemoryCountersEx>() };
        counters.cb = std::mem::size_of::<ProcessMemoryCountersEx>() as u32;
        if unsafe { K32GetProcessMemoryInfo(handle, &mut counters, counters.cb) } == 0 {
            0u64
        } else {
            counters.private_usage as u64
        }
    }

    /// 一个进程的私有工作集。刚退出的、受保护的拿不到句柄，回 0：那部分不记到本应用头上。
    fn private_set_of(pid: u32) -> u64 {
        if pid == std::process::id() {
            return private_set(SELF);
        }
        let handle = unsafe { OpenProcess(QUERY, 0, pid) };
        if handle.is_null() || handle == INVALID {
            return 0;
        }
        let bytes = private_set(handle);
        unsafe { CloseHandle(handle) };
        bytes
    }

    /// 全系统进程快照，只有 pid / ppid / 可执行文件名三项。
    fn snapshot() -> Vec<ProcInfo> {
        let snap = unsafe { CreateToolhelp32Snapshot(SNAP_PROCESS, 0) };
        if snap.is_null() || snap == INVALID {
            return Vec::new();
        }
        let mut rows = Vec::new();
        let mut entry = unsafe { std::mem::zeroed::<ProcessEntry32W>() };
        entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
        if unsafe { Process32FirstW(snap, &mut entry) } != 0 {
            loop {
                rows.push(ProcInfo {
                    pid: entry.th32_process_id,
                    ppid: entry.th32_parent_process_id,
                    program: wide(&entry.sz_exe_file),
                });
                if unsafe { Process32NextW(snap, &mut entry) } == 0 {
                    break;
                }
            }
        }
        unsafe { CloseHandle(snap) };
        rows
    }

    pub fn read() -> (u64, u64, Vec<MemoryPart>) {
        let parts = group(&snapshot(), std::process::id(), private_set_of);
        let app = parts.iter().map(|part| part.mb).sum();
        let total = unsafe {
            let mut status = std::mem::zeroed::<MemoryStatusEx>();
            status.length = std::mem::size_of::<MemoryStatusEx>() as u32;
            if GlobalMemoryStatusEx(&mut status) == 0 {
                0u64
            } else {
                status.total_phys
            }
        };
        (app, total / MB, parts)
    }
}

#[cfg(not(windows))]
mod win {
    use super::MemoryPart;

    pub fn read() -> (u64, u64, Vec<MemoryPart>) {
        (0, 0, Vec::new())
    }
}

#[tauri::command]
pub async fn sys_memory() -> Memory {
    block_value(
        || {
            let (app_mb, total_mb, parts) = win::read();
            Memory {
                app_mb,
                total_mb,
                parts,
            }
        },
        Memory::empty,
    )
    .await
}
#[cfg(test)]
mod tests {
    use super::{group, ProcInfo, MB};

    fn row(pid: u32, ppid: u32, program: &str) -> ProcInfo {
        ProcInfo {
            pid,
            ppid,
            program: program.to_string(),
        }
    }

    /// 便于断言：把分组压成 (kind, program, mb, count)。
    fn shape(rows: &[ProcInfo], self_pid: u32) -> Vec<(String, String, u64, u32)> {
        // pid 号即 MB 数，好核对归并后的合计。
        group(rows, self_pid, |pid| u64::from(pid) * MB)
            .into_iter()
            .map(|part| (part.kind.to_string(), part.program, part.mb, part.count))
            .collect()
    }

    #[test]
    fn groups_the_whole_tree_by_program() {
        let rows = [
            row(1, 0, "forge.exe"),
            row(2, 1, "msedgewebview2.exe"),
            row(3, 2, "MSedgewebview2.EXE"),
            row(4, 1, "node.exe"),
            row(5, 4, "node.exe"),
            // 不是后代：ppid 指向本应用之外的进程。
            row(9, 700, "chrome.exe"),
        ];
        assert_eq!(
            shape(&rows, 1),
            vec![
                ("child".to_string(), "node.exe".to_string(), 9, 2),
                ("webview".to_string(), "msedgewebview2.exe".to_string(), 5, 2),
                ("host".to_string(), String::new(), 1, 1),
            ]
        );
    }

    #[test]
    fn drops_a_subtree_whose_parent_already_exited() {
        // 3 的父进程 2 不在快照里：ppid 链断了，3 及它的孩子都不算。
        let rows = [row(1, 0, "forge.exe"), row(3, 2, "node.exe"), row(4, 3, "python.exe")];
        assert_eq!(
            shape(&rows, 1),
            vec![("host".to_string(), String::new(), 1, 1)]
        );
    }

    #[test]
    fn counts_one_process_once_even_when_the_snapshot_repeats_it() {
        // PID 复用让同一个 pid 在快照里出现两次；seen 集合挡住重复计数。
        let rows = [
            row(1, 0, "forge.exe"),
            row(2, 1, "node.exe"),
            row(2, 1, "node.exe"),
        ];
        assert_eq!(
            shape(&rows, 1),
            vec![
                ("child".to_string(), "node.exe".to_string(), 2, 1),
                ("host".to_string(), String::new(), 1, 1),
            ]
        );
    }

    #[test]
    fn sorts_by_size() {
        let rows = [
            row(1, 0, "forge.exe"),
            row(2, 1, "small.exe"),
            row(3, 1, "big.exe"),
        ];
        let parts = group(&rows, 1, |pid| u64::from(pid) * MB);
        assert_eq!(
            parts.iter().map(|part| part.mb).collect::<Vec<_>>(),
            vec![3, 2, 1]
        );
    }
}

