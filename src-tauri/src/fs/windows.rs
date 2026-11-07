use super::{io_err, EntryFlags};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::path::Path;
use std::process::Command;

/// Windows 文件属性：只读。
const FILE_ATTRIBUTE_READONLY: u32 = 0x0000_0001;
/// Windows 文件属性：隐藏。
const FILE_ATTRIBUTE_HIDDEN: u32 = 0x0000_0002;
/// Windows 文件属性：系统。
const FILE_ATTRIBUTE_SYSTEM: u32 = 0x0000_0004;
/// Windows 文件属性：重解析点（符号链接/junction）。
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
/// `GetFileAttributesW` 的失败返回值。
const INVALID_FILE_ATTRIBUTES: u32 = u32::MAX;

#[link(name = "kernel32")]
extern "system" {
    fn GetFileAttributesW(path: *const u16) -> u32;
    #[cfg(test)]
    fn SetFileAttributesW(path: *const u16, attributes: u32) -> i32;
}

#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(
        hwnd: *mut std::ffi::c_void,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
    ) -> *mut std::ffi::c_void;
    fn SHFileOperationW(lpFileOp: *mut SHFILEOPSTRUCTW) -> i32;
    fn DragQueryFileW(hdrop: *mut std::ffi::c_void, index: u32, file: *mut u16, cch: u32) -> u32;
}

#[link(name = "user32")]
extern "system" {
    fn OpenClipboard(owner: *mut std::ffi::c_void) -> i32;
    fn GetClipboardData(format: u32) -> *mut std::ffi::c_void;
    fn CloseClipboard() -> i32;
}

/// 剪贴板文件列表格式（CF_HDROP）的注册格式号。
const CF_HDROP: u32 = 15;

/// SHFileOperationW 操作常量与标志位
const FO_DELETE: u32 = 0x0003;
/// SHFileOperationW 标志：静默执行。
const FOF_SILENT: u16 = 0x0004;
/// SHFileOperationW 标志：不弹确认框。
const FOF_NOCONFIRMATION: u16 = 0x0010;
/// SHFileOperationW 标志：可撤销（进回收站）。
const FOF_ALLOWUNDO: u16 = 0x0040;
/// SHFileOperationW 标志：出错不弹 UI。
const FOF_NOERRORUI: u16 = 0x0400;

/// SHFileOperationW 的参数结构（含操作码、来源/目标与标志位）。
#[repr(C)]
#[cfg_attr(target_arch = "x86", repr(packed))]
#[allow(non_snake_case)]
struct SHFILEOPSTRUCTW {
    hwnd: *mut std::ffi::c_void,
    wFunc: u32,
    pFrom: *const u16,
    pTo: *const u16,
    fFlags: u16,
    fAnyOperationsAborted: i32,
    hNameMappings: *mut std::ffi::c_void,
    lpszProgressTitle: *const u16,
}

/// ShellExecuteW 的显示方式：正常窗口。
const SW_SHOWNORMAL: i32 = 1;

/// 路径转以 NUL 结尾的 UTF-16 序列。
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// 字符串转以 NUL 结尾的宽字符，Win32 API 用。
fn wide_str(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 取一条路径的目录项标志（单独查一轮文件属性）。
pub fn flags(path: &Path) -> EntryFlags {
    let raw = wide(path);
    let attrs = unsafe { GetFileAttributesW(raw.as_ptr()) };
    decode(entry_attrs(attrs))
}

/// `read_dir` 那趟已经把属性交给我们了，再按路径查一遍 `GetFileAttributesW` 等于
/// 每条目录项多一次内核往返——5000 条的目录里就是多打 5000 次。
pub fn flags_from(path: &Path, meta: &std::fs::Metadata) -> EntryFlags {
    let _ = path;
    decode(entry_attrs(meta.file_attributes()))
}

/// 这条目录项是不是隐藏项。隐藏位在 `Metadata` 自带的属性里（`read_dir` 那趟就拿到了），
/// 读不到才按路径查一次 `GetFileAttributesW`。
pub fn hidden(_path: &Path, meta: Option<&std::fs::Metadata>) -> bool {
    match meta {
        Some(meta) => decode(entry_attrs(meta.file_attributes())).hidden,
        None => flags(_path).hidden,
    }
}

/// 把原始文件属性位收敛成 `Some`（`INVALID` 置 `None`）。
fn entry_attrs(attrs: u32) -> Option<u32> {
    if attrs == INVALID_FILE_ATTRIBUTES {
        None
    } else {
        Some(attrs)
    }
}

/// 把 Windows 文件属性位解码成 [`EntryFlags`]；属性未知按全假处理。
fn decode(attrs: Option<u32>) -> EntryFlags {
    let Some(attrs) = attrs else {
        return EntryFlags {
            hidden: false,
            readonly: false,
            reparse: false,
        };
    };
    EntryFlags {
        hidden: attrs & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0,
        readonly: attrs & FILE_ATTRIBUTE_READONLY != 0,
        reparse: attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0,
    }
}

/// 在资源管理器里定位该路径（保留链接路径，归一 Win32 前缀与分隔符）。
///
/// # Errors
///
/// 元数据读取或命令启动失败时返回错误串。
pub fn reveal(path: &Path) -> Result<(), String> {
    let metadata = path.metadata().map_err(|e| io_err(&path.to_string_lossy(), e))?;
    // Explorer 不识别混合分隔符和扩展路径前缀；保留链接路径，不解析为链接目标。
    let absolute = std::path::absolute(path).map_err(|e| io_err(&path.to_string_lossy(), e))?;
    let normalized = absolute.to_string_lossy().replace('/', "\\");
    let target = if let Some(unc) = normalized.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", unc)
    } else {
        normalized.strip_prefix(r"\\?\").unwrap_or(&normalized).to_string()
    };
    // 目录直接进入；其他调用方仍可通过文件路径在父目录中定位文件。
    if metadata.is_dir() {
        return open_external(&target);
    }
    Command::new("explorer")
        .arg(format!("/select,{}", target))
        .spawn()
        .map(|_| ())
        .map_err(|e| io_err(&path.to_string_lossy(), e))
}

/// 用系统默认程序打开 URL 或本地路径。
///
/// 走 ShellExecuteW 而不是 `cmd /C start`：cmd 会二次解析命令行，URL 里一个 `&`
/// 就能把后面的内容当成新命令执行（markdown 里的链接是外部输入，不能当可信文本）。
/// ShellExecuteW 直接把字符串交给系统 shell 关联，没有这层解析。
pub fn open_external(url: &str) -> Result<(), String> {
    let operation = wide_str("open");
    let target = wide_str(url);
    // 返回值 <= 32 是 ShellExecute 约定的失败码（0 表示内存不足、2 表示文件不存在等）。
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        return Err(io_err(url, format!("ShellExecute 返回 {}", result as isize)));
    }
    Ok(())
}

/// 读取 Windows 资源管理器复制到剪贴板的文件路径（CF_HDROP）。只读，不触碰文本剪贴板。
pub fn clipboard_files() -> Result<Vec<String>, String> {
    if unsafe { OpenClipboard(std::ptr::null_mut()) } == 0 {
        return Err("无法打开系统剪贴板".to_string());
    }

    let result = (|| {
        let data = unsafe { GetClipboardData(CF_HDROP) };
        if data.is_null() {
            return Ok(Vec::new());
        }
        let count = unsafe { DragQueryFileW(data, u32::MAX, std::ptr::null_mut(), 0) };
        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            let length = unsafe { DragQueryFileW(data, index, std::ptr::null_mut(), 0) };
            let mut buffer = vec![0u16; length as usize + 1];
            let written = unsafe { DragQueryFileW(data, index, buffer.as_mut_ptr(), buffer.len() as u32) };
            paths.push(String::from_utf16_lossy(&buffer[..written as usize]));
        }
        Ok(paths)
    })();

    let _ = unsafe { CloseClipboard() };
    result
}

/// 将文件或目录安全移入 Windows 回收站（Recycle Bin），支持系统级一键“放回原处”。
pub fn trash(path: &Path) -> Result<(), String> {
    if !path.exists() && path.symlink_metadata().is_err() {
        return Err(io_err(
            &path.to_string_lossy(),
            std::io::Error::from(std::io::ErrorKind::NotFound),
        ));
    }

    // SHFileOperationW 必须使用规范绝对路径，但严禁包含 `\\?\` 或 `\\?\UNC\` 扩展前缀
    // （否则 Shell API 无法识别，会返回 124/0x7C 错误）。
    // 注意：必须使用 std::path::absolute 而非 canonicalize，防止解析符号链接导致外部真实目标被误删。
    let full_path = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let path_str = full_path.to_string_lossy();
    let clean_path = if let Some(stripped) = path_str.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", stripped)
    } else if let Some(stripped) = path_str.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        path_str.into_owned()
    };
    // Win32 Shell API 要求路径必须使用反斜杠
    let clean_path = clean_path.replace('/', "\\");

    // pFrom 字段要求双 NUL（\0\0）结尾的宽字符缓冲
    let mut wide_buf: Vec<u16> = clean_path.encode_utf16().collect();
    wide_buf.push(0);
    wide_buf.push(0);

    let mut op = SHFILEOPSTRUCTW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE,
        pFrom: wide_buf.as_ptr(),
        pTo: std::ptr::null(),
        fFlags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };

    let ret = unsafe { SHFileOperationW(&mut op) };
    if ret == 0 {
        if op.fAnyOperationsAborted != 0 {
            return Err(io_err(&path.to_string_lossy(), "operation aborted"));
        }
        Ok(())
    } else {
        Err(io_err(
            &path.to_string_lossy(),
            std::io::Error::from_raw_os_error(ret),
        ))
    }
}

/// 测试用：把文件标记为隐藏属性。
#[cfg(test)]
pub fn mark_hidden(path: &Path) {
    let raw = wide(path);
    let current = unsafe { GetFileAttributesW(raw.as_ptr()) };
    let current = if current == INVALID_FILE_ATTRIBUTES { 0 } else { current };
    unsafe { SetFileAttributesW(raw.as_ptr(), current | FILE_ATTRIBUTE_HIDDEN) };
}
