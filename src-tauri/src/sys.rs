use crate::offload::block_value;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
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

/// 跨进程独占文件锁。锁对象必须活过完整的读—改—写区间；关闭句柄即释放。
pub struct ExclusiveFileLock {
    _file: std::fs::File,
}
impl ExclusiveFileLock {
    pub fn acquire(path: &std::path::Path) -> Result<Self, String> {
        let file = std::fs::OpenOptions::new().read(true).write(true).create(true).open(path)
            .map_err(|error| crate::error::err_parts("IO", &[path.display().to_string(), error.to_string()]))?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::{LockFileEx, LOCKFILE_EXCLUSIVE_LOCK}, System::IO::OVERLAPPED};
            let mut overlapped = OVERLAPPED::default();
            unsafe { LockFileEx(HANDLE(file.as_raw_handle()), LOCKFILE_EXCLUSIVE_LOCK, Some(0), u32::MAX, u32::MAX, &mut overlapped) }
                .map_err(|error| error.to_string())?;
        }
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        Ok(Self { _file: file })
    }

    /// 非阻塞尝试独占锁；`None` 只表示另一个进程已持有，权限/路径等真实错误必须上抛。
    pub fn try_acquire(path: &std::path::Path) -> Result<Option<Self>, String> {
        let file = match std::fs::OpenOptions::new().read(true).write(true).create(true).open(path) {
            Ok(file) => file,
            Err(error) => {
                #[cfg(windows)]
                if matches!(error.raw_os_error(), Some(32 | 33)) { return Ok(None); }
                return Err(crate::error::err_parts("IO", &[path.display().to_string(), error.to_string()]));
            }
        };
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::{Foundation::{ERROR_LOCK_VIOLATION, HANDLE}, Storage::FileSystem::{LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY}, System::IO::OVERLAPPED};
            let mut overlapped = OVERLAPPED::default();
            if let Err(error) = unsafe { LockFileEx(HANDLE(file.as_raw_handle()), LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, Some(0), u32::MAX, u32::MAX, &mut overlapped) } {
                // windows-core 把 Win32 错误包装成 FACILITY_WIN32 HRESULT；0x8007 是固定前缀。
                let lock_violation = 0x8007_0000u32 | ERROR_LOCK_VIOLATION.0;
                if error.code().0 as u32 == lock_violation { return Ok(None); }
                return Err(error.to_string());
            }
        }
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                let error = std::io::Error::last_os_error();
                if matches!(error.raw_os_error(), Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN) {
                    return Ok(None);
                }
                return Err(error.to_string());
            }
        }
        Ok(Some(Self { _file: file }))
    }
}

/// 原子写一份文本：先写同目录的 `.tmp`，再改名盖过去。
///
/// 直接 `fs::write` 覆盖，进程在写一半时被杀掉就留下半截 JSON，
/// 下一次启动解析失败只能退回默认值，用户填的全丢。
pub fn write_atomic(path: &std::path::Path, text: &str) -> Result<(), String> {
    static TEMP_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    // 多个 Forge 进程不能共用固定 .tmp；唯一名只解决临时文件冲突，RMW 原子性由调用方文件锁保证。
    let tmp = std::path::PathBuf::from(format!("{}.{}.{}.tmp", path.display(), std::process::id(), TEMP_ID.fetch_add(1, Ordering::Relaxed)));
    std::fs::write(&tmp, text).map_err(|error| {
        crate::error::err_parts("IO", &[tmp.display().to_string(), error.to_string()])
    })?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            // 唯一临时名不会被下次写覆盖；失败路径必须主动收掉，避免反复失败持续堆积完整副本。
            let _ = std::fs::remove_file(&tmp);
            Err(crate::error::err_parts("IO", &[path.display().to_string(), error.to_string()]))
        }
    }
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

/// 全局记录的本实例所连接的 WebView2 Browser 进程 PID。
/// 当运行多个应用实例时，WebView2 默认共享同一套 Browser 进程树。通过它能准确定位整个 WebView 环境。
static WEBVIEW_BROWSER_PID: AtomicU32 = AtomicU32::new(0);

pub fn set_webview_browser_pid(pid: u32) {
    if pid != 0 {
        WEBVIEW_BROWSER_PID.store(pid, Ordering::Relaxed);
    }
}

/// 挑出 `self_pid` 及其后代，按归属归并成 host / child / webview 几档。
///
/// 多实例感知：
/// 当系统运行了多个本应用实例（如打开两个 Forge 窗口/进程）时，WebView2 默认复用同一个
/// Browser / GPU 进程树。导致在操作系统进程树中，WebView2 的 ppid 父进程只挂在首个启动的实例上，
/// 后续实例在 ppid 链上没有 WebView 子进程。
/// 此处通过 `WEBVIEW_BROWSER_PID` 或同名宿主实例定位属于本应用的 WebView2 进程树，
/// 并按活跃宿主实例数进行内存均摊，使各实例都能准确反映各自的内存消耗。
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

    let Some(self_info) = by_pid.get(&self_pid) else {
        return Vec::new();
    };
    let self_program = &self_info.program;

    // 统计当前系统中所有与本应用同名的活跃宿主实例（如开了多个 forge.exe）
    let host_instances: Vec<u32> = rows
        .iter()
        .filter(|r| r.program.eq_ignore_ascii_case(self_program))
        .map(|r| r.pid)
        .collect();
    let host_count = host_instances.len().max(1) as u64;

    // 1) 收集属于本实例独占的普通子进程（终端、LSP 等，排除 webview）
    let mut child_picked: Vec<&ProcInfo> = Vec::new();
    let mut child_seen: HashSet<u32> = HashSet::new();
    let mut child_queue: VecDeque<u32> = VecDeque::new();
    child_seen.insert(self_pid);

    if let Some(children) = kids.get(&self_pid) {
        for child_pid in children {
            if let Some(child_row) = by_pid.get(child_pid) {
                if !child_row.program.eq_ignore_ascii_case(WEBVIEW_EXE) {
                    if child_seen.insert(*child_pid) {
                        child_queue.push_back(*child_pid);
                    }
                }
            }
        }
    }

    while let Some(pid) = child_queue.pop_front() {
        if let Some(row) = by_pid.get(&pid) {
            child_picked.push(row);
        }
        if let Some(children) = kids.get(&pid) {
            for child in children {
                if child_seen.insert(*child) {
                    child_queue.push_back(*child);
                }
            }
        }
    }

    // 2) 确定属于本应用家族的 WebView2 Browser 根进程：
    //    a) 优先使用运行时记录的 WEBVIEW_BROWSER_PID；
    //    b) 兜底：快照中寻找 ppid 为本应用同名宿主实例的 msedgewebview2.exe。
    let mut browser_pids: Vec<u32> = Vec::new();
    let known_browser_pid = WEBVIEW_BROWSER_PID.load(Ordering::Relaxed);
    if known_browser_pid != 0 {
        if let Some(row) = by_pid.get(&known_browser_pid) {
            if row.program.eq_ignore_ascii_case(WEBVIEW_EXE) {
                browser_pids.push(known_browser_pid);
            }
        }
    }

    if browser_pids.is_empty() {
        for row in rows {
            if row.program.eq_ignore_ascii_case(WEBVIEW_EXE) && host_instances.contains(&row.ppid) {
                if !browser_pids.contains(&row.pid) {
                    browser_pids.push(row.pid);
                }
            }
        }
    }

    // 3) 遍历收集 WebView2 根进程及其所有子孙进程（GPU、渲染器、网络服务等）
    let mut webview_picked: Vec<&ProcInfo> = Vec::new();
    let mut webview_seen: HashSet<u32> = HashSet::new();
    let mut webview_queue: VecDeque<u32> = VecDeque::new();

    for browser_pid in browser_pids {
        if webview_seen.insert(browser_pid) {
            webview_queue.push_back(browser_pid);
        }
    }

    while let Some(pid) = webview_queue.pop_front() {
        if let Some(row) = by_pid.get(&pid) {
            if row.program.eq_ignore_ascii_case(WEBVIEW_EXE) {
                webview_picked.push(row);
                if let Some(children) = kids.get(&pid) {
                    for child in children {
                        if webview_seen.insert(*child) {
                            webview_queue.push_back(*child);
                        }
                    }
                }
            }
        }
    }

    // 4) 汇总结算各档占用
    let mut parts: Vec<MemoryPart> = Vec::new();

    // 宿主进程
    parts.push(MemoryPart {
        kind: HOST,
        program: String::new(),
        mb: read_bytes(self_pid) / MB,
        count: 1,
    });

    // 独占子进程（如终端、LSP）
    for row in child_picked {
        let program = row.program.to_ascii_lowercase();
        let mb = read_bytes(row.pid) / MB;
        match parts.iter_mut().find(|part| part.kind == CHILD && part.program == program) {
            Some(part) => {
                part.mb += mb;
                part.count += 1;
            }
            None => parts.push(MemoryPart {
                kind: CHILD,
                program,
                mb,
                count: 1,
            }),
        }
    }

    // WebView 进程（均摊）
    if !webview_picked.is_empty() {
        let total_webview_bytes: u64 = webview_picked.iter().map(|r| read_bytes(r.pid)).sum();
        let total_webview_count = webview_picked.len() as u32;
        let mb = (total_webview_bytes / MB) / host_count;
        let count = (total_webview_count + host_count as u32 - 1) / (host_count as u32);
        parts.push(MemoryPart {
            kind: WEBVIEW,
            program: WEBVIEW_EXE.to_string(),
            mb,
            count: count.max(1),
        });
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

/// 唤起操作系统原生通知中心（Windows 10/11 Toast / macOS / Linux）
///
/// 当应用在后台、最小化或被遮挡时，通过操作系统通知中心向用户展示重要事件。
#[tauri::command]
pub async fn sys_notify(title: String, body: String) -> Result<(), String> {
    block_value(
        move || {
            notify_native(&title, &body)
        },
        || Err("系统通知线程池不可用".to_string()),
    )
    .await
}

fn notify_native(title: &str, body: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        // Windows 10/11: 使用 PowerShell 后台派发 Windows.UI.Notifications Action Center Toast
        // 使用与应用主窗口相同的 AppUserModelID "app.forge.desktop" 进行归组展示
        let escaped_title = title.replace('`', "``").replace('"', "`\"").replace('$', "`$");
        let escaped_body = body.replace('`', "``").replace('"', "`\"").replace('$', "`$");
        let script = format!(
            concat!(
                "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; ",
                "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); ",
                "$textNodes = $template.GetElementsByTagName('text'); ",
                "$textNodes.Item(0).AppendChild($template.CreateTextNode(\"{}\")) > $null; ",
                "$textNodes.Item(1).AppendChild($template.CreateTextNode(\"{}\")) > $null; ",
                "$toast = [Windows.UI.Notifications.ToastNotification]::new($template); ",
                "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('app.forge.desktop').Show($toast);"
            ),
            escaped_title, escaped_body
        );

        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script]);
        hide_console(&mut cmd);
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        let escaped_title = title.replace('\\', "\\\\").replace('"', "\\\"");
        let escaped_body = body.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            r#"display notification "{}" with title "{}""#,
            escaped_body, escaped_title
        );
        let mut cmd = Command::new("osascript");
        cmd.args(["-e", &script]);
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut cmd = Command::new("notify-send");
        cmd.args([title, body]);
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::{group, ExclusiveFileLock, ProcInfo, MB};
    use std::path::Path;
    use std::process::{Child, Command};
    use std::time::{Duration, Instant};

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

    fn wait_for(path: &Path, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if path.exists() { return true; }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    fn wait_child(child: &mut Child) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Some(status) = child.try_wait().expect("读取锁测试子进程状态") { return status.success(); }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = child.kill();
        false
    }

    #[test]
    fn exclusive_file_lock_process_helper() {
        let Ok(mode) = std::env::var("FORGE_LOCK_TEST_MODE") else { return; };
        let root = std::path::PathBuf::from(std::env::var("FORGE_LOCK_TEST_ROOT").expect("锁测试目录"));
        let lock_path = root.join("shared.lock");
        match mode.as_str() {
            "holder" => {
                let _lock = ExclusiveFileLock::acquire(&lock_path).expect("holder 取得锁");
                std::fs::write(root.join("ready"), b"ready").expect("holder 发 ready");
                assert!(wait_for(&root.join("release"), Duration::from_secs(10)), "父进程没有释放 holder");
            }
            "contender" => {
                std::fs::write(root.join("attempting"), b"attempting").expect("contender 发 attempting");
                let _lock = ExclusiveFileLock::acquire(&lock_path).expect("contender 取得锁");
                std::fs::write(root.join("acquired"), b"acquired").expect("contender 发 acquired");
            }
            _ => panic!("未知锁测试模式"),
        }
    }

    #[test]
    fn exclusive_file_lock_serializes_real_processes() {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!("forge-file-lock-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir_all(&root).unwrap();
        let executable = std::env::current_exe().expect("当前测试二进制");
        let spawn = |mode: &str| {
            let mut command = Command::new(&executable);
            command.args(["--exact", "sys::tests::exclusive_file_lock_process_helper", "--nocapture"])
                .env("FORGE_LOCK_TEST_MODE", mode)
                .env("FORGE_LOCK_TEST_ROOT", &root);
            super::hide_console(&mut command);
            command.spawn().expect("启动锁测试子进程")
        };

        let mut holder = spawn("holder");
        assert!(wait_for(&root.join("ready"), Duration::from_secs(10)), "holder 未取得锁");
        let mut contender = spawn("contender");
        assert!(wait_for(&root.join("attempting"), Duration::from_secs(10)), "contender 未开始取锁");
        std::thread::sleep(Duration::from_millis(100));
        assert!(!root.join("acquired").exists(), "holder 释放前 contender 不得取得锁");

        std::fs::write(root.join("release"), b"release").unwrap();
        assert!(wait_for(&root.join("acquired"), Duration::from_secs(10)), "holder 释放后 contender 应取得锁");
        assert!(wait_child(&mut holder));
        assert!(wait_child(&mut contender));
        std::fs::remove_dir_all(root).unwrap();
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
    fn shares_webview_memory_across_multiple_forge_instances() {
        let rows = [
            // 实例 1
            row(10, 0, "forge.exe"),
            // 实例 2（在 Windows 下复用已有的 WebView2 运行时）
            row(20, 0, "forge.exe"),
            // WebView2 Browser 根进程（由首个实例 10 唤起，ppid 为 10）
            row(2, 10, "msedgewebview2.exe"),
            // GPU 进程与两个实例的渲染器子进程（ppid 均指向 Browser 进程 2）
            row(3, 2, "msedgewebview2.exe"),
            row(4, 2, "msedgewebview2.exe"),
            row(5, 2, "msedgewebview2.exe"),
        ];
        // WebView 总体私有工作集 = 2 + 3 + 4 + 5 = 14 MB，共 4 个进程
        // 2 个活跃的 forge 实例各均摊一半：7 MB，2 个进程
        assert_eq!(
            shape(&rows, 10),
            vec![
                ("host".to_string(), String::new(), 10, 1),
                ("webview".to_string(), "msedgewebview2.exe".to_string(), 7, 2),
            ]
        );
        // 关键断言：实例 2 同样能正确均摊到 7 MB WebView 内存，不再为 0！
        assert_eq!(
            shape(&rows, 20),
            vec![
                ("host".to_string(), String::new(), 20, 1),
                ("webview".to_string(), "msedgewebview2.exe".to_string(), 7, 2),
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

