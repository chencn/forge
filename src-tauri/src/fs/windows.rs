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

/// 测试用：把文件标记为隐藏属性。
#[cfg(test)]
pub fn mark_hidden(path: &Path) {
    let raw = wide(path);
    let current = unsafe { GetFileAttributesW(raw.as_ptr()) };
    let current = if current == INVALID_FILE_ATTRIBUTES { 0 } else { current };
    unsafe { SetFileAttributesW(raw.as_ptr(), current | FILE_ATTRIBUTE_HIDDEN) };
}
