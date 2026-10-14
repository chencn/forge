use super::{io_err, EntryFlags};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::path::Path;
use std::process::Command;

const FILE_ATTRIBUTE_READONLY: u32 = 0x0000_0001;
const FILE_ATTRIBUTE_HIDDEN: u32 = 0x0000_0002;
const FILE_ATTRIBUTE_SYSTEM: u32 = 0x0000_0004;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
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
}

/// SHFileOperationW 操作常量与标志位
const FO_DELETE: u32 = 0x0003;
const FOF_SILENT: u16 = 0x0004;
const FOF_NOCONFIRMATION: u16 = 0x0010;
const FOF_ALLOWUNDO: u16 = 0x0040;
const FOF_NOERRORUI: u16 = 0x0400;

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

fn entry_attrs(attrs: u32) -> Option<u32> {
    if attrs == INVALID_FILE_ATTRIBUTES {
        None
    } else {
        Some(attrs)
    }
}

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

pub fn reveal(path: &Path) -> Result<(), String> {
    Command::new("explorer")
        .arg(format!("/select,{}", path.to_string_lossy()))
        .spawn()
        .map(|_| ())
        .map_err(|e| io_err(&path.to_string_lossy(), e))
}

/// 用系统默认程序打开一个 URL。
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
