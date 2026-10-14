use super::{io_err, EntryFlags};
use std::path::Path;
use std::process::Command;

pub fn flags(path: &Path) -> EntryFlags {
    let meta = path.metadata().ok();
    let reparse = path
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    build(path, meta.as_ref(), reparse)
}

/// 属性从目录项自带的那份 `Metadata` 里取：`flags` 那一路要为每条目录项补两次 stat，
/// 5000 条的目录里就是一万次，而数据本来就在手上。
pub fn flags_from(path: &Path, meta: &std::fs::Metadata) -> EntryFlags {
    build(path, Some(meta), meta.file_type().is_symlink())
}

/// 这条目录项是不是隐藏项。类 unix 的约定就是文件名以点开头，`meta` 用不上——
/// 搜索的可见性闸门每个条目都要问一次，这里不看 metadata 就省掉一次 stat。
pub fn hidden(path: &Path, _meta: Option<&std::fs::Metadata>) -> bool {
    path.file_name()
        .unwrap_or_else(|| path.as_os_str())
        .to_string_lossy()
        .starts_with('.')
}

fn build(path: &Path, meta: Option<&std::fs::Metadata>, reparse: bool) -> EntryFlags {
    let name = path
        .file_name()
        .unwrap_or_else(|| path.as_os_str())
        .to_string_lossy()
        .into_owned();
    EntryFlags {
        hidden: name.starts_with('.'),
        readonly: meta.is_some_and(|m| m.permissions().readonly()),
        reparse,
    }
}

pub fn reveal(path: &Path) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        return Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| io_err(&path.to_string_lossy(), e));
    }
    // Linux 没有通用的「在文件管理器里选中该项」，退化成打开它的父目录。
    let parent = path.parent().unwrap_or(path);
    Command::new("xdg-open")
        .arg(parent)
        .spawn()
        .map(|_| ())
        .map_err(|e| io_err(&path.to_string_lossy(), e))
}

/// 用系统默认程序打开一个 URL。macOS 是 `open`，其余走 `xdg-open`。
pub fn open_external(url: &str) -> Result<(), String> {
    let program = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    Command::new(program)
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| io_err(url, e))
}

/// 将文件或目录安全移入类 Unix 系统废纸篓。
/// macOS 优先尝试 `trash` CLI（基于 Cocoa API），无此工具时通过 `osascript` 走 Finder（采用 argv 传参防注入）；
/// Linux 优先尝试 `gio trash`（GNOME/KDE/XFCE 等默认桌面工具）与 `trash-put`。
pub fn trash(path: &Path) -> Result<(), String> {
    if !path.exists() && path.symlink_metadata().is_err() {
        return Err(io_err(
            &path.to_string_lossy(),
            std::io::Error::from(std::io::ErrorKind::NotFound),
        ));
    }

    // 注意：必须使用 std::path::absolute 而非 canonicalize，防止解析符号链接导致外部真实目标被误删。
    let abs_path = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());

    if cfg!(target_os = "macos") {
        // macOS: 优先尝试 trash 命令行（Cocoa API，无需 Finder 自动化权限）
        if let Ok(status) = Command::new("trash").arg(&abs_path).status() {
            if status.success() {
                return Ok(());
            }
        }

        // 次选：osascript 驱动 Finder。必须通过 argv 参数传递路径，避免字符串拼接造成 AppleScript 注入。
        let status = Command::new("osascript")
            .arg("-e")
            .arg("on run argv")
            .arg("-e")
            .arg("tell application \"Finder\" to delete POSIX file (item 1 of argv)")
            .arg("-e")
            .arg("end run")
            .arg(&abs_path)
            .status()
            .map_err(|e| io_err(&path.to_string_lossy(), e))?;
        if status.success() {
            return Ok(());
        }
        return Err(io_err(&path.to_string_lossy(), "osascript failed"));
    }

    // Linux: 优先 gio trash，次选 trash-put
    if let Ok(status) = Command::new("gio").arg("trash").arg(&abs_path).status() {
        if status.success() {
            return Ok(());
        }
    }
    if let Ok(status) = Command::new("trash-put").arg(&abs_path).status() {
        if status.success() {
            return Ok(());
        }
    }

    Err(io_err(&path.to_string_lossy(), "no trash utility available"))
}

/// 测试用：类 unix 的隐藏约定就是文件名以点开头。
#[cfg(test)]
pub fn mark_hidden(path: &Path) {
    let name = match path.file_name().and_then(|n| n.to_str()) {
        Some(name) if !name.starts_with('.') => format!(".{}", name),
        _ => return,
    };
    let _ = std::fs::rename(path, path.with_file_name(name));
}
