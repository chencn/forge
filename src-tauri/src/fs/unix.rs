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

/// 测试用：类 unix 的隐藏约定就是文件名以点开头。
#[cfg(test)]
pub fn mark_hidden(path: &Path) {
    let name = match path.file_name().and_then(|n| n.to_str()) {
        Some(name) if !name.starts_with('.') => format!(".{}", name),
        _ => return,
    };
    let _ = std::fs::rename(path, path.with_file_name(name));
}
