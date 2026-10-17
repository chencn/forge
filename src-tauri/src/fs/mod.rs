use crate::error::{err, err_parts};
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{Emitter, Manager};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// 改动文件系统的命令共用的排队锁。
///
/// 这些命令转 `async` 之前都排在主线程上一条接一条，天然串行；转完之后「保存」和「重命名」
/// 能同时落盘：同一份文件的两次保存谁后到没有保证，旧的快照可能盖掉新的改动；Windows 上
/// 撞同一个文件还是一次随机的「另一个程序正在使用此文件」。锁只盖改动，读（列目录、读文件）
/// 照常并行。守卫一律取在命令那层的闭包里，不在 `*_impl` 里取——`move_entry_impl` 会转调
/// `delete_entry_impl`，两处都取就是同线程重入死锁。
fn fs_write_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 系统调用失败：只带路径和操作系统给的原因，怎么说由前端定。
fn io_err(path: &str, source: impl std::fmt::Display) -> String {
    err_parts("IO", &[path.to_string(), source.to_string()])
}

#[cfg(windows)]
mod windows;

#[cfg(not(windows))]
mod unix;

mod search;

pub use search::*;

#[cfg(windows)]
use windows as platform;

#[cfg(not(windows))]
use unix as platform;
use crate::offload::{block, block_value};

/// 编辑器一次读入的上限，超过就拒绝打开，避免把大文件灌进 webview。
const EDITOR_CEILING: u64 = 8 * 1024 * 1024;
const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Directory,
    File,
    Other,
}

pub struct EntryFlags {
    pub hidden: bool,
    pub readonly: bool,
    pub reparse: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub extension: Option<String>,
    pub size: u64,
    pub modified_ms: i64,
    pub is_symlink: bool,
    pub is_hidden: bool,
    pub is_readonly: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FsEntry>,
    pub unreadable: Vec<String>,
}

/// 交给编辑器的一份完整文本。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    /// 打开的绝对路径，原样回传。
    pub path: String,
    /// 已去掉行尾与 BOM 影响的正文字符串。
    pub contents: String,
    /// 磁盘上的字节数（含 BOM）。
    pub size: u64,
    /// 行尾风格，`crlf` 或 `lf`，保存时按它写回。
    pub line_ending: String,
    /// 原文件是否带 UTF-8 BOM。
    pub has_bom: bool,
    /// 这份内容在磁盘上的修改时间（unix 毫秒）。前端用它认出「只是被 touch 了一下」，
    /// 那种不用重载，也不该动光标。文件不存在时为 0。
    pub modified_ms: i64,
}

/// 取修改时间的毫秒值；读不到（文件没了、权限）按 0 算。
fn modified_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|when| when.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|span| span.as_millis() as i64)
        .unwrap_or(0)
}

fn lossy(value: &Path) -> String {
    value.to_string_lossy().into_owned()
}

/// 按目标行尾归一正文。
///
/// 已经是那一侧的原样交回：monaco 存一份 CRLF 文件时正文本来就带 `\r\n`，
/// 原先那连着两次 `replace` 等于把整份文件白拷两遍。真要改也只走一趟。
fn normalize_endings(text: String, crlf: bool) -> String {
    if already_normalized(&text, crlf) {
        return text;
    }
    let eol = if crlf { "\r\n" } else { "\n" };
    let mut lines = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line));
    let first = lines.next().unwrap_or_default();
    let mut out = String::with_capacity(text.len() + if crlf { 64 } else { 0 });
    out.push_str(first);
    for line in lines {
        out.push_str(eol);
        out.push_str(line);
    }
    out
}

/// 正文是不是已经按目标行尾分行。落单的 `\r` 判为「未规整」，但重排只当行尾分隔用，
/// 它会原样留着——和旧的 replace 写法结果一致。
fn already_normalized(text: &str, crlf: bool) -> bool {
    let bytes = text.as_bytes();
    let mut at = 0usize;
    while at < bytes.len() {
        match bytes[at] {
            b'\r' => {
                if !crlf || bytes.get(at + 1) != Some(&b'\n') {
                    return false;
                }
                at += 2;
            }
            b'\n' => {
                if crlf {
                    return false;
                }
                at += 1;
            }
            _ => at += 1,
        }
    }
    true
}

fn assemble(full: &Path, target: Option<fs::Metadata>, link_is_symlink: bool) -> FsEntry {
    let target = target.or_else(|| fs::metadata(full).ok());
    // 属性尽量从手上这份 `Metadata` 里读；读不到（改名竞态之类）才按路径再查一次。
    let flags = match target.as_ref() {
        Some(meta) => platform::flags_from(full, meta),
        None => platform::flags(full),
    };
    let is_dir = target.as_ref().is_some_and(|m| m.is_dir());
    let kind = if is_dir {
        EntryKind::Directory
    } else if target.as_ref().is_some_and(|m| m.is_file()) {
        EntryKind::File
    } else {
        EntryKind::Other
    };
    let modified_ms = target
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    // 盘符根（"C:\"）没有 file_name，退回完整路径当作名字。
    let name = full
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| lossy(full));

    FsEntry {
        path: lossy(full),
        extension: full.extension().map(|e| e.to_string_lossy().into_owned()),
        size: if is_dir { 0 } else { target.map(|m| m.len()).unwrap_or(0) },
        is_symlink: flags.reparse || link_is_symlink,
        is_hidden: flags.hidden,
        is_readonly: flags.readonly,
        name,
        kind,
        modified_ms,
    }
}

pub(crate) fn entry_at(path: &Path) -> Result<FsEntry, String> {
    if !path.exists() {
        return Err(err("PATH_GONE", lossy(path)));
    }
    let link_is_symlink = path
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    Ok(assemble(path, path.metadata().ok(), link_is_symlink))
}

#[tauri::command]
pub async fn list_directory(path: String) -> Result<DirectoryListing, String> {
    block(move || list_directory_impl(path)).await
}

fn list_directory_impl(path: String) -> Result<DirectoryListing, String> {
    let dir = PathBuf::from(&path);
    let read = fs::read_dir(&dir).map_err(|e| io_err(&path, e))?;

    let mut entries = Vec::new();
    let mut unreadable = Vec::new();
    for item in read {
        match item {
            Ok(item) => {
                let link_is_symlink = item
                    .file_type()
                    .map(|ft| ft.is_symlink())
                    .unwrap_or(false);
                entries.push(assemble(&item.path(), item.metadata().ok(), link_is_symlink));
            }
            Err(e) => unreadable.push(e.to_string()),
        }
    }

    // 小写名每项算一次：写在比较函数里的话，5000 条就是约 25000 次比较 × 2 次 String 分配。
    entries.sort_by_cached_key(|entry| {
        (
            if entry.kind == EntryKind::Directory {
                0u8
            } else {
                1u8
            },
            entry.name.to_lowercase(),
        )
    });

    let parent = dir
        .parent()
        .filter(|p| *p != dir.as_path())
        .map(lossy);
    Ok(DirectoryListing {
        path,
        parent,
        entries,
        unreadable,
    })
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<FileContent, String> {
    block(move || read_file_impl(path)).await
}

fn read_file_impl(path: String) -> Result<FileContent, String> {
    let meta = fs::metadata(&path).map_err(|e| io_err(&path, e))?;
    if meta.is_dir() {
        return Err(err("IS_DIR", &path));
    }
    if meta.len() > EDITOR_CEILING {
        return Err(err_parts(
            "TOO_LARGE",
            &[meta.len().to_string(), EDITOR_CEILING.to_string()],
        ));
    }
    let bytes = fs::read(&path).map_err(|e| io_err(&path, e))?;
    let (has_bom, body) = match bytes.strip_prefix(&UTF8_BOM) {
        Some(rest) => (true, rest),
        None => (false, bytes.as_slice()),
    };
    let text = std::str::from_utf8(body).map_err(|_| {
        // 解不成 UTF-8 时再分一层：正文里有 NUL 就当二进制，其余算「别的编码的文本」。
        // 前端据此决定说「二进制，打不开」还是「不是 UTF-8 文本」。
        if body.contains(&0) {
            err("BINARY", &path)
        } else {
            err("NOT_UTF8", &path)
        }
    })?;
    let line_ending = if text.contains("\r\n") { "crlf" } else { "lf" }.to_string();
    Ok(FileContent {
        contents: text.to_string(),
        path,
        size: meta.len(),
        line_ending,
        has_bom,
        modified_ms: modified_ms(&meta),
    })
}

/// 保存走这里：正文按 line_ending 归一，BOM 按原文件保留，字节由 Rust 侧统一组装。
#[tauri::command]
pub async fn write_file(
    path: String,
    contents: String,
    line_ending: Option<String>,
    has_bom: Option<bool>,
) -> Result<FileContent, String> {
    block(move || {
        let _queued = fs_write_lock();
        write_file_impl(path, contents, line_ending, has_bom)
    })
    .await
}

fn write_file_impl(
    path: String,
    contents: String,
    line_ending: Option<String>,
    has_bom: Option<bool>,
) -> Result<FileContent, String> {
    let target = Path::new(&path);
    if target.is_dir() {
        return Err(err("TARGET_DIR", &path));
    }
    let crlf = line_ending.as_deref() == Some("crlf");
    let body = normalize_endings(contents, crlf);
    let keep_bom = has_bom.unwrap_or(false);

    let mut bytes = Vec::with_capacity(body.len() + 3);
    if keep_bom {
        bytes.extend_from_slice(&UTF8_BOM);
    }
    bytes.extend_from_slice(body.as_bytes());
    write_bytes_atomic(target, &bytes)?;

    let written_ms = fs::metadata(target).map(|meta| modified_ms(&meta)).unwrap_or(0);
    Ok(FileContent {
        contents: body,
        path,
        size: bytes.len() as u64,
        line_ending: if crlf { "crlf".to_string() } else { "lf".to_string() },
        has_bom: keep_bom,
        modified_ms: written_ms,
    })
}

/// 落盘走「同目录临时文件 + 改名」：原地 `fs::write` 是截断重写，写一半崩溃或断电就
/// 留半截文件；同目录 rename 在 Windows 和类 unix 上都是原子替换。临时文件带自己的
/// 标记，写坏也只伤它一个，正文不受牵连。调用方已持 `fs_write_lock`，同一目标不会
/// 并发写，固定临时名不会互相踩。
///
/// 临时文件必须 `create_new`：固定临时名是可预知的路径，`File::create` 会跟随已存在的
/// 符号链接——恶意仓库预置 `.foo.txt.forge-tmp → ~/.ssh/id_rsa` 一类的链接，保存就把
/// 用户文件写了进去。类 unix 上还把原文件的权限位抄给临时文件，rename 替换后
/// 可执行位（`deploy.sh`、带 shebang 的脚本）不静默丢失。
fn write_bytes_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = target.file_name().unwrap_or_default().to_string_lossy();
    let temp = target.with_file_name(format!(".{name}.forge-tmp"));
    #[cfg(unix)]
    let prior_mode = target.metadata().ok().map(|meta| meta.permissions().mode());
    let result = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .and_then(|mut file| {
            file.write_all(bytes)?;
            // flush + sync_all 把字节真正压到盘上，改名之后元数据才不会指着一块空数据。
            file.flush()?;
            file.sync_all()?;
            drop(file);
            #[cfg(unix)]
            if let Some(mode) = prior_mode {
                let _ = fs::set_permissions(&temp, std::fs::Permissions::from_mode(mode));
            }
            fs::rename(&temp, target)
        });
    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            // 尽力清掉临时文件再报原始错误；清不掉就算了，不能把真正的失败盖住。
            let _ = fs::remove_file(&temp);
            Err(io_err(&lossy(target), e))
        }
    }
}

#[tauri::command]
pub async fn create_folder(path: String) -> Result<FsEntry, String> {
    block(move || {
        let _queued = fs_write_lock();
        create_folder_impl(path)
    })
    .await
}

fn create_folder_impl(path: String) -> Result<FsEntry, String> {
    fs::create_dir(&path).map_err(|e| io_err(&path, e))?;
    entry_at(Path::new(&path))
}

#[tauri::command]
pub async fn create_file(path: String) -> Result<FsEntry, String> {
    block(move || {
        let _queued = fs_write_lock();
        create_file_impl(path)
    })
    .await
}

fn create_file_impl(path: String) -> Result<FsEntry, String> {
    // create_new = O_CREAT | O_EXCL：已存在直接失败。不能用 File::create——那是
    // create+truncate，撞上已有文件会把人家的内容整个清空，等于一次静默数据丢失。
    match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(_) => entry_at(Path::new(&path)),
        // 已存在按 rename_entry 的口径报 TARGET_EXISTS，让前端走同一套「换名重试」。
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(err("TARGET_EXISTS", &path)),
        Err(e) => Err(io_err(&path, e)),
    }
}

#[tauri::command]
pub async fn rename_entry(from: String, to: String) -> Result<FsEntry, String> {
    block(move || {
        let _queued = fs_write_lock();
        rename_entry_impl(from, to)
    })
    .await
}

/// 判断源路径与目标路径是否指向同一个文件实体（处理仅大小写不同的重命名）。
fn is_same_file(from: &Path, to: &Path) -> bool {
    if let (Ok(f), Ok(t)) = (fs::canonicalize(from), fs::canonicalize(to)) {
        f == t
    } else {
        from.to_string_lossy().eq_ignore_ascii_case(&to.to_string_lossy())
    }
}

fn rename_entry_impl(from: String, to: String) -> Result<FsEntry, String> {
    let from_path = Path::new(&from);
    let to_path = Path::new(&to);
    let is_case_change = is_same_file(from_path, to_path);
    // 目标已存在且不是同文件大小写更名时才报 TARGET_EXISTS
    if to_path.exists() && !is_case_change {
        return Err(err("TARGET_EXISTS", &to));
    }
    if is_case_change {
        // Windows NTFS 支持直接修改大小写；若文件系统/驱动器拒绝直接覆盖，则借临时名过渡
        if fs::rename(&from, &to).is_err() {
            let parent = from_path.parent().unwrap_or_else(|| Path::new(""));
            let temp_name = format!(
                ".{}.__forge_case_tmp__",
                from_path.file_name().unwrap_or_default().to_string_lossy()
            );
            let temp_path = parent.join(temp_name);
            fs::rename(&from, &temp_path).map_err(|e| io_err(&format!("{from} → temp"), e))?;
            fs::rename(&temp_path, &to).map_err(|e| io_err(&format!("temp → {to}"), e))?;
        }
    } else {
        fs::rename(&from, &to).map_err(|e| io_err(&format!("{from} → {to}"), e))?;
    }
    entry_at(Path::new(&to))
}

/// 把一条连目录里的内容一起搬到 `to`。撞名不让 std 覆盖，前端换名重试。
fn copy_tree(from: &Path, to: &Path) -> Result<(), std::io::Error> {
    let meta = from.symlink_metadata()?;
    if !(meta.is_dir() && !meta.file_type().is_symlink()) {
        return fs::copy(from, to).map(|_| ());
    }
    fs::create_dir(to)?;
    for item in fs::read_dir(from)? {
        let child = item?.path();
        let Some(name) = child.file_name() else {
            continue;
        };
        copy_tree(&child, &to.join(name))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn copy_entry(from: String, to: String) -> Result<FsEntry, String> {
    block(move || {
        let _queued = fs_write_lock();
        copy_entry_impl(from, to)
    })
    .await
}

fn copy_entry_impl(from: String, to: String) -> Result<FsEntry, String> {
    if Path::new(&to).exists() {
        return Err(err("TARGET_EXISTS", &to));
    }
    copy_tree(Path::new(&from), Path::new(&to)).map_err(|e| io_err(&format!("{from} → {to}"), e))?;
    entry_at(Path::new(&to))
}

/// 挪一条：同盘就是一次 rename；跨盘 rename 必失败，那时整份复制完再把原来那条删掉。
/// 复制成了却删不掉源，盘上会留下两份，这不能算成功——给一条专门的码，让前端把两份都在说清楚。
#[tauri::command]
pub async fn move_entry(from: String, to: String) -> Result<FsEntry, String> {
    block(move || {
        let _queued = fs_write_lock();
        move_entry_impl(from, to)
    })
    .await
}

fn move_entry_impl(from: String, to: String) -> Result<FsEntry, String> {
    if Path::new(&to).exists() {
        return Err(err("TARGET_EXISTS", &to));
    }
    if fs::rename(&from, &to).is_ok() {
        return entry_at(Path::new(&to));
    }
    copy_tree(Path::new(&from), Path::new(&to)).map_err(|e| io_err(&format!("{from} → {to}"), e))?;
    delete_entry_impl(from.clone()).map_err(|_| err_parts("MOVED_WITH_SOURCE", &[to.clone(), from]))?;
    entry_at(Path::new(&to))
}

/// 删除进度事件载荷：对齐 IDEA `DeleteHandlerHelper.kt` + `LocalFileSystem.DELETE_CALLBACK`，
/// 递归删除每删掉一个底层文件或目录就递增 `count`，按 50ms（20 FPS）节流推给前端模态进度框。
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct DeleteProgressPayload {
    count: usize,
    current: String,
}

#[tauri::command]
pub async fn delete_entry(app: tauri::AppHandle, path: String) -> Result<(), String> {
    block(move || {
        let _queued = fs_write_lock();
        let target = Path::new(&path);

        // 校验目标本身是否存在（支持符号链接）
        if !target.exists() && target.symlink_metadata().is_err() {
            return Err(io_err(&path, std::io::Error::from(std::io::ErrorKind::NotFound)));
        }

        // 优先移入系统回收站 / 废纸篓，安全防误删
        match platform::trash(target) {
            Ok(()) => {
                // 回收站操作通常为瞬间完成的单次原子调用，不发送 fs://delete-progress 避免打断前端 180ms 延时造成进度模态框闪烁
                return Ok(());
            }
            Err(err) => {
                // 若失败原因为权限不足或被其他进程占用锁定，直接阻断报错，严禁降级物理递归删除导致子树部分损毁
                if err.contains("os error 5")          // ERROR_ACCESS_DENIED (Windows) / EACCES (Unix)
                    || err.contains("os error 13")      // EACCES (Unix)
                    || err.contains("os error 32")      // ERROR_SHARING_VIOLATION (Windows)
                    || err.contains("Permission denied")
                    || err.contains("not found")
                    || err.contains("operation aborted")
                {
                    return Err(err);
                }
                // 仅在因介质或桌面环境不支持回收站时（如网络共享 UNC 或无桌面环境服务器），降级为物理递归删除兜底
            }
        }

        // 若系统回收站不可用（例如网络共享 UNC 或无桌面环境），降级为物理递归删除
        let mut count: usize = 0;
        let mut last_emit = Instant::now()
            .checked_sub(Duration::from_millis(60))
            .unwrap_or_else(Instant::now);
        let result = delete_entry_with_progress(&path, &mut |deleted_path| {
            count += 1;
            let now = Instant::now();
            if now.duration_since(last_emit).as_millis() >= 50 {
                last_emit = now;
                let current = deleted_path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| deleted_path.to_string_lossy().into_owned());
                let _ = app.emit(
                    "fs://delete-progress",
                    DeleteProgressPayload { count, current },
                );
            }
        });
        if count > 0 {
            let current = Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            let _ = app.emit(
                "fs://delete-progress",
                DeleteProgressPayload { count, current },
            );
        }
        result
    })
    .await
}

fn delete_entry_impl(path: String) -> Result<(), String> {
    delete_entry_with_progress(&path, &mut |_| {})
}

/// 递归删除文件或目录，每删掉一个底层文件或子目录就回调 `on_deleted`（对应 IDEA `NioFiles.deleteRecursively`）。
fn delete_entry_with_progress(
    path: &str,
    on_deleted: &mut dyn FnMut(&Path),
) -> Result<(), String> {
    let target = Path::new(path);
    let meta = target
        .symlink_metadata()
        .map_err(|e| io_err(path, e))?;
    if meta.is_dir() && !meta.file_type().is_symlink() {
        remove_dir_recursive(target, on_deleted).map_err(|e| io_err(path, e))
    } else {
        remove_single_file_or_symlink(target).map_err(|e| io_err(path, e))?;
        on_deleted(target);
        Ok(())
    }
}

/// 删除单个文件或符号链接（兼容 Windows 目录软链 / junction）。
/// 注意：必须先根据元数据区分文件与目录软链，严禁无条件 fallback 调 remove_dir，
/// 否则普通文件被占用或权限不足时会被篡改为“目录名称无效 (os error 267)”。
fn remove_single_file_or_symlink(target: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if let Ok(meta) = target.symlink_metadata() {
            // Windows 下真实目录、目录软链接（mklink /D）与联接点（mklink /J）均具备 0x10 (FILE_ATTRIBUTE_DIRECTORY)，
            // 必须使用 RemoveDirectoryW (fs::remove_dir) 删除；调用 DeleteFileW 会被系统拒绝并报拒绝访问 (os error 5)。
            if meta.file_attributes() & 0x10 != 0 {
                return fs::remove_dir(target);
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(meta) = target.symlink_metadata() {
            if meta.is_dir() {
                return fs::remove_dir(target);
            }
        }
    }
    fs::remove_file(target)
}

fn remove_dir_recursive(
    dir: &Path,
    on_deleted: &mut dyn FnMut(&Path),
) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let child_path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() && !file_type.is_symlink() {
            remove_dir_recursive(&child_path, on_deleted)?;
        } else {
            remove_single_file_or_symlink(&child_path)?;
            on_deleted(&child_path);
        }
    }
    fs::remove_dir(dir)?;
    on_deleted(dir);
    Ok(())
}

#[tauri::command]
pub async fn reveal_entry(path: String) -> Result<(), String> {
    block(move || reveal_entry_impl(path)).await
}

fn reveal_entry_impl(path: String) -> Result<(), String> {
    platform::reveal(Path::new(&path))
}

/// 一份文件的「指纹」：体积 + 修改时间。图片预览不读正文，靠它认出磁盘上换过内容，
/// 换过就把 asset URL 的查询串变一下，逼 webview 丢掉旧缓存。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    pub size: u64,
    pub modified_ms: i64,
}

#[tauri::command]
pub async fn file_stamp(path: String) -> Result<FileStamp, String> {
    block(move || file_stamp_impl(path)).await
}

/// 拖放进来的路径各是文件还是文件夹。不存在的条目直接略过。
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PathKind {
    pub path: String,
    pub kind: EntryKind,
}

pub fn stat_entries_impl(paths: Vec<String>) -> Vec<PathKind> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let Ok(entry) = entry_at(Path::new(&path)) else {
            continue;
        };
        out.push(PathKind {
            path,
            kind: entry.kind,
        });
    }
    out
}

#[tauri::command]
pub async fn stat_entries(paths: Vec<String>) -> Vec<PathKind> {
    block_value(move || stat_entries_impl(paths), Vec::new).await
}

fn file_stamp_impl(path: String) -> Result<FileStamp, String> {
    let meta = fs::metadata(&path).map_err(|e| io_err(&path, e))?;
    if meta.is_dir() {
        return Err(err("IS_DIR", &path));
    }
    Ok(FileStamp {
        size: meta.len(),
        modified_ms: modified_ms(&meta),
    })
}

/// 把工作区目录加进 asset 协议的允许名单，图片才读得出来。
///
/// 授权不落盘，重启就没了，所以每次打开工作区都要重新授一遍。递归授权整棵子树，
/// 否则文档里引用的子目录图片会被协议挡在门外。
#[tauri::command]
pub async fn fs_allow_asset(app: tauri::AppHandle, root: String) -> Result<(), String> {
    block(move || fs_allow_asset_impl(app, root)).await
}

fn fs_allow_asset_impl(app: tauri::AppHandle, root: String) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_directory(Path::new(&root), true)
        .map_err(|e| io_err(&root, e))
}

/// 用系统默认程序打开一个链接或本地文件。
///
/// 入参有两条来源：目录树右键给的是自己盘上的路径，markdown 里的链接则是文档写什么
/// 就是什么。后者不能原样交给 shell——那等于让一份文档决定这台机器执行什么。
/// 所以先过 `external_allowed`，只放「白名单里的链接协议」与「真实存在的非可执行文件」。
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    block(move || open_external_impl(url)).await
}

fn open_external_impl(url: String) -> Result<(), String> {
    external_allowed(&url)?;
    platform::open_external(&url)
}

/// 能直接交给系统 shell 的那几种链接协议。其余带 scheme 的写法（`file:`、`ms-msdt:`、
/// `javascript:`、`search-ms:`、`data:`）一律拦下。
/// 前端 `MarkdownPreview` 放行的是同一组，两边要一起改。
const OPEN_SCHEMES: [&str; 4] = ["http:", "https:", "mailto:", "tel:"];

/// shell 会直接执行掉的后缀。用关联程序打开一份文档是正常需求，打开一个 `.exe`
/// 或者 `.lnk`（指向哪由文件内容说，看不出来）不是。
const EXECUTABLE_SUFFIXES: [&str; 17] = [
    "exe", "com", "scr", "msi", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf",
    "wsh", "hta", "cpl", "lnk",
];

/// 这条字符串能不能交给 shell。不行的时候回 `EXTERNAL_BLOCKED`，怎么说由前端定。
fn external_allowed(raw: &str) -> Result<(), String> {
    let target = raw.trim();
    if target.is_empty() {
        return Err(err("EXTERNAL_BLOCKED", target));
    }
    if let Some(at) = target.find(':') {
        let scheme = &target[..at];
        let scheme_like = scheme.len() > 1
            && scheme
                .chars()
                .next()
                .is_some_and(|first| first.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
        // 单个字母打头的是盘符（`D:\...`），不是协议，按本地路径继续判。
        if scheme_like {
            return OPEN_SCHEMES
                .iter()
                .find(|allowed| allowed.eq_ignore_ascii_case(&format!("{scheme}:")))
                .map(|_| ())
                .ok_or_else(|| err("EXTERNAL_BLOCKED", target));
        }
    }
    let path = Path::new(target);
    // 盘上没有的字符串不交给 shell：那等于让它去 PATH 里找一个同名的命令。
    if !path.is_file() {
        return Err(err("EXTERNAL_BLOCKED", target));
    }
    let suffix = path
        .extension()
        .map_or("", |ext| ext.to_str().unwrap_or_default())
        .to_ascii_lowercase();
    if EXECUTABLE_SUFFIXES.contains(&suffix.as_str()) {
        return Err(err("EXTERNAL_BLOCKED", target));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("forge-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("创建测试沙盒目录失败");
        base
    }

    fn touch(dir: &Path, name: &str, body: &[u8]) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, body).expect("写测试文件失败");
        path
    }

    #[test]
    fn lists_directories_before_files() {
        let dir = sandbox("order");
        fs::create_dir(dir.join("zeta")).unwrap();
        touch(&dir, "alpha.txt", b"a");
        touch(&dir, "beta.txt", b"bb");

        let listing = list_directory_impl(lossy(&dir)).unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["zeta", "alpha.txt", "beta.txt"]);
        assert_eq!(listing.entries[0].kind, EntryKind::Directory);
        assert_eq!(listing.entries[0].size, 0, "目录不该报告体积");
        assert_eq!(listing.entries[1].size, 1);
        assert_eq!(listing.entries[2].extension.as_deref(), Some("txt"));
        assert_eq!(listing.parent.as_deref(), Some(lossy(dir.parent().unwrap()).as_str()));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stat_entries_splits_files_and_folders() {
        let dir = sandbox("stat");
        fs::create_dir(dir.join("proj")).unwrap();
        touch(&dir, "note.txt", b"hi");

        let kinds = stat_entries_impl(vec![
            lossy(&dir.join("proj")),
            lossy(&dir.join("note.txt")),
            lossy(&dir.join("missing")),
        ]);
        assert_eq!(
            kinds,
            vec![
                PathKind {
                    path: lossy(&dir.join("proj")),
                    kind: EntryKind::Directory,
                },
                PathKind {
                    path: lossy(&dir.join("note.txt")),
                    kind: EntryKind::File,
                },
            ]
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hidden_items_are_reported_not_filtered() {
        let dir = sandbox("hidden");
        touch(&dir, "visible.txt", b"x");
        let secret = touch(&dir, "secret.txt", b"y");
        platform::mark_hidden(&secret);

        let listing = list_directory_impl(lossy(&dir)).unwrap();
        assert_eq!(listing.entries.len(), 2, "隐藏项要照实列进目录树");
        let hidden = listing
            .entries
            .iter()
            .find(|entry| entry.name == "secret.txt")
            .expect("被标记隐藏的文件应在列表里");
        assert!(hidden.is_hidden);
        assert!(listing.entries.iter().any(|entry| entry.name == "visible.txt"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_rename_delete_round_trip() {
        let dir = sandbox("roundtrip");
        let folder = dir.join("folder");
        let created = create_folder_impl(lossy(&folder)).unwrap();
        assert_eq!(created.kind, EntryKind::Directory);
        assert!(folder.is_dir());

        let note = folder.join("note.txt");
        create_file_impl(lossy(&note)).unwrap();
        assert!(note.is_file());

        let moved = folder.join("renamed.txt");
        rename_entry_impl(lossy(&note), lossy(&moved)).unwrap();
        assert!(moved.is_file() && !note.exists());

        let other = create_folder_impl(lossy(&dir.join("other")));
        assert!(other.is_ok());
        let failed = rename_entry_impl(lossy(&moved), lossy(&dir.join("other")));
        assert!(failed.is_err(), "重命名到已存在的目标必须报错");
        assert!(moved.is_file(), "失败的重命名不应动到源文件");

        delete_entry_impl(lossy(&folder)).unwrap();
        assert!(!folder.exists(), "删除目录应连内部文件一起清掉");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_moves_file_and_folder() {
        let dir = sandbox("trash-test");
        let folder = dir.join("trash-sub");
        create_folder_impl(lossy(&folder)).unwrap();
        let file = folder.join("file.txt");
        create_file_impl(lossy(&file)).unwrap();
        assert!(file.exists());

        // 移入回收站
        let result = platform::trash(&file);
        #[cfg(any(windows, target_os = "macos"))]
        {
            assert!(result.is_ok(), "Windows/macOS 上回收站应调用成功: {:?}", result);
            assert!(!file.exists(), "移入回收站后原路径文件应已移除");
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            if result.is_ok() {
                assert!(!file.exists(), "移入回收站后原路径文件应已移除");
            }
        }

        let folder_result = platform::trash(&folder);
        #[cfg(any(windows, target_os = "macos"))]
        {
            assert!(folder_result.is_ok(), "Windows/macOS 上目录移入回收站应调用成功: {:?}", folder_result);
            assert!(!folder.exists(), "移入回收站后原路径文件夹应已移除");
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            if folder_result.is_ok() {
                assert!(!folder.exists(), "移入回收站后原路径文件夹应已移除");
            }
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_symlink_does_not_delete_target() {
        let dir = sandbox("trash-symlink-test");
        let real_dir = dir.join("real_target_dir");
        create_folder_impl(lossy(&real_dir)).unwrap();
        let file_in_real = real_dir.join("payload.txt");
        create_file_impl(lossy(&file_in_real)).unwrap();
        assert!(file_in_real.exists());

        let link_dir = dir.join("link_to_target");

        // 在 Windows 上创建 Junction，在 Unix 上创建目录软链接
        #[cfg(windows)]
        let created = {
            std::process::Command::new("cmd")
                .args(&["/c", "mklink", "/J", &lossy(&link_dir), &lossy(&real_dir)])
                .output()
                .map(|out| out.status.success())
                .unwrap_or(false)
        };
        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(&real_dir, &link_dir).is_ok();

        if created && link_dir.symlink_metadata().is_ok() {
            let res = platform::trash(&link_dir);
            if res.is_ok() {
                // 链接本身应当被移除
                assert!(link_dir.symlink_metadata().is_err(), "软链接本身应被移入回收站");
                // 关键断言：被指向的真实目标必须完好无损，严禁被穿透删除！
                assert!(real_dir.exists(), "软链接指向的真实目录必须完好保留");
                assert!(file_in_real.exists(), "真实目录内的文件必须完好保留");
            }
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_file_refuses_to_truncate_an_existing_one() {
        let dir = sandbox("create-existing");
        let note = touch(&dir, "note.txt", b"precious");
        // File::create 是截断语义，已存在的文件会被静默清零；新建必须 create_new，
        // 撞上同名报错，由前端弹「是否覆盖」再走显式写入。
        let again = create_file_impl(lossy(&note));
        assert!(
            matches!(&again, Err(message) if message.contains("TARGET_EXISTS")),
            "第二次新建要报 TARGET_EXISTS：{:?}",
            again.as_ref().err()
        );
        assert_eq!(fs::read(&note).unwrap(), b"precious", "原内容一个字节都不能少");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_file_lands_atomically_without_temp_leftover() {
        let dir = sandbox("atomic");
        let note = touch(&dir, "note.txt", b"old body");

        let written = write_file_impl(
            lossy(&note),
            "new body".to_string(),
            Some("lf".to_string()),
            Some(false),
        )
        .unwrap();
        assert_eq!(written.contents, "new body");
        assert_eq!(fs::read(&note).unwrap(), b"new body");

        // 落盘走「临时文件 + 改名」：写完目录里不能残留 forge-tmp，否则下次
        // create_new 会被残留名绊住。
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("forge-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不该有临时文件残留：{:?}", leftovers);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn listing_a_file_is_an_error() {
        let dir = sandbox("notdir");
        let file = touch(&dir, "a.txt", b"x");
        assert!(list_directory_impl(lossy(&file)).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn editor_round_trip_keeps_endings_and_bom() {
        let dir = sandbox("editor");
        let source = touch(&dir, "crlf.txt", b"\xEF\xBB\xBFone\r\ntwo\r\n");

        let read = read_file_impl(lossy(&source)).unwrap();
        assert!(!read.contents.starts_with('\u{feff}'), "读出来要剥掉 BOM");
        assert_eq!(read.contents, "one\r\ntwo\r\n");
        assert!(read.has_bom);
        assert_eq!(read.line_ending, "crlf");

        let written = write_file_impl(
            lossy(&source),
            "one\ntwo\n".to_string(),
            Some("crlf".to_string()),
            Some(true),
        )
        .unwrap();
        assert_eq!(written.contents, "one\r\ntwo\r\n");
        let bytes = fs::read(&source).unwrap();
        assert!(bytes.starts_with(&UTF8_BOM), "保存要还原原文件的 BOM");
        assert_eq!(&bytes[UTF8_BOM.len()..], b"one\r\ntwo\r\n");

        let plain = touch(&dir, "lf.txt", b"a\nb\n");
        let read = read_file_impl(lossy(&plain)).unwrap();
        assert!(!read.has_bom);
        assert_eq!(read.line_ending, "lf");

        let not_utf8 = touch(&dir, "utf16.txt", &[0xFF, 0xFE, b'o', b'k']);
        assert!(
            matches!(read_file_impl(lossy(&not_utf8)), Err(message) if message.starts_with("NOT_UTF8")),
            "不含 NUL 的非 UTF-8 按「别的编码的文本」报"
        );

        // 解不成 UTF-8 的字节流里带 NUL 才算二进制，前端据此说「二进制，打不开」。
        let binary = touch(&dir, "blob.bin", &[0xFF, b'E', b'L', b'F', 0x00, 0x01]);
        assert!(
            matches!(read_file_impl(lossy(&binary)), Err(message) if message.starts_with("BINARY")),
            "带 NUL 的非 UTF-8 要报 BINARY"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn filesystem_root_has_no_parent() {
        let cwd = std::env::current_dir().expect("当前工作目录");
        let root = cwd.ancestors().last().expect("文件系统根");
        let listing = list_directory_impl(lossy(root))
            .unwrap_or_else(|error| panic!("列根目录 {} 失败：{}", lossy(root), error));
        assert!(
            listing.parent.is_none(),
            "根目录 {} 不该有父目录，实际拿到 {:?}",
            lossy(root),
            listing.parent
        );
    }

    #[test]
    fn external_open_only_accepts_links_and_real_documents() {
        // 白名单之外的协议：shell 会把它们当命令或当特殊动词执行。
        for raw in [
            "ms-msdt:/id foo",
            "file://C:/Windows/System32/cmd.exe",
            "javascript:alert(1)",
            "search-ms:displayname=x",
            "data:text/html,x",
            "notepad.exe",
        ] {
            assert!(external_allowed(raw).is_err(), "不该放行：{raw}");
        }
        for raw in ["https://example.com/a?b=1", "http://example.com", "mailto:a@b.c"] {
            assert!(external_allowed(raw).is_ok(), "该放行：{raw}");
        }
        // 本地这一路只认盘上真实的非可执行文件。
        let dir = sandbox("external");
        let note = touch(&dir, "note.txt", b"hi");
        let tool = touch(&dir, "tool.exe", b"MZ");
        assert!(external_allowed(&lossy(&note)).is_ok());
        assert!(external_allowed(&lossy(&tool)).is_err());
        assert!(external_allowed("").is_err());
        assert!(external_allowed("   ").is_err());
    }
}

