//! 工作区文件监听：把磁盘上的改动按批推给前端，前端再去刷目录树、git 状态和打开的文档。
//!
//! 只做「有事发生」这一件事：不告诉前端是新增还是删除，也不给改动前后的内容。
//! 事件粒度太细会让前端各处都要判类型，而它真正要做的只是「重新读一遍」。

use crate::error::{err, err_parts};
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;

use notify::{EventKind, RecursiveMode, RecommendedWatcher, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// 安静这么久就把手里的路径一起发出去。取 150ms：比人手一次保存的间隔短，
/// 又足够把「写临时文件 + 改名」这类连着好几条事件并成一次刷新。
const SETTLE: Duration = Duration::from_millis(150);

/// 单批上限。构建工具一口气吐几万条时，前端只需要知道「出过事」，不必收全部路径。
const BATCH_CAP: usize = 256;

/// 一次上报：受影响的路径，绝对路径，分隔符按平台原样。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    pub paths: Vec<String>,
}

/// 当前工作区的监听句柄。丢掉它 = notify 的回调闭包连同发送端一起释放，
/// 转发线程读到通道断开就自己退出，所以停止不需要额外的标志位。
#[derive(Default)]
pub struct WatchSlot {
    inner: Mutex<Option<RecommendedWatcher>>,
}

/// 要不要把这条事件转给前端。
///
/// Windows 后端把「文件内容变了」直接报成 `Modify(Any)`，不细分 Data / Metadata，
/// 所以这里不能只挑几个子类型收 —— 那样改文件内容整类被丢掉，只剩新建和删除看得见。
fn interesting(kind: &EventKind) -> bool {
    !matches!(kind, EventKind::Other)
}

/// 这条路径是不是落在 `.git` 里。
///
/// 暂存、提交、切分支都会写 `.git/index`、`.git/HEAD` 这些文件，监听是递归的，
/// 于是每次 git 操作都会再触发一轮「磁盘变了」——前端收到就把目录树、git 状态、
/// 文档重读一遍，等于给每次暂存白加一倍开销，点起来就卡。
/// `.git` 里的变动本来就轮不到用户看，直接不往外发。
fn inside_git_dir(path: &Path) -> bool {
    path.components().any(|part| part.as_os_str() == ".git")
}

/// 开始监听一个目录；已经在监听别的目录就先停掉旧的。
#[tauri::command]
pub fn fs_watch_start(app: AppHandle, slot: State<'_, WatchSlot>, root: String) -> Result<(), String> {
    let dir = Path::new(&root);
    if !dir.is_dir() {
        return Err(err("NOT_DIR", &root));
    }

    let (sender, receiver) = mpsc::channel::<Vec<std::path::PathBuf>>();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            if !interesting(&event.kind) {
                return;
            }
            // 一条事件可能带多个路径（改名就是），只要有一个不在 .git 里就还值得发；
            // 落在 .git 里的那几个剔掉，免得暂存 / 提交顺带把整块界面刷一遍。
            let paths: Vec<std::path::PathBuf> = event
                .paths
                .into_iter()
                .filter(|path| !inside_git_dir(path))
                .collect();
            if !paths.is_empty() {
                // 转发线程已经退了就直接丢事件，不该让 notify 的回调报错。
                let _ = sender.send(paths);
            }
        }
    })
    .map_err(|e| err("WATCH_START", e))?;

    watcher
        .watch(dir, RecursiveMode::Recursive)
        .map_err(|e| err_parts("WATCH_DIR", &[root.clone(), e.to_string()]))?;

    std::thread::spawn(move || pump(app, receiver));
    // 覆盖即停旧句柄；旧句柄一丢，它那条转发线程也就走到头了。
    *slot.inner.lock().expect("监听槽位锁") = Some(watcher);
    Ok(())
}

/// 停止监听（关闭工作区时调用）。
#[tauri::command]
pub fn fs_watch_stop(slot: State<'_, WatchSlot>) {
    *slot.inner.lock().expect("监听槽位锁") = None;
}

/// 攒批并发的转发线程。收到第一条后继续等静默期，把这段时间内的都并进来再发。
fn pump(app: AppHandle, receiver: mpsc::Receiver<Vec<std::path::PathBuf>>) {
    let mut pending: BTreeSet<String> = BTreeSet::new();
    loop {
        match receiver.recv() {
            Ok(paths) => soak(&mut pending, paths),
            // 发送端随 watcher 一起没了：把最后一点攒着的发出去再收工。
            Err(_) => break,
        }
        loop {
            match receiver.recv_timeout(SETTLE) {
                Ok(paths) => soak(&mut pending, paths),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    flush(&app, &mut pending);
                    return;
                }
            }
        }
        flush(&app, &mut pending);
    }
    flush(&app, &mut pending);
}

fn soak(pending: &mut BTreeSet<String>, paths: Vec<std::path::PathBuf>) {
    for path in paths {
        if pending.len() >= BATCH_CAP {
            return;
        }
        pending.insert(path.to_string_lossy().into_owned());
    }
}

fn flush(app: &AppHandle, pending: &mut BTreeSet<String>) {
    if pending.is_empty() {
        return;
    }
    let paths: Vec<String> = std::mem::take(pending).into_iter().collect();
    let _ = app.emit("fs://change", FsChange { paths });
}

#[cfg(test)]
mod tests {
    use super::inside_git_dir;
    use std::path::Path;

    #[test]
    fn git_internals_are_filtered_out() {
        // 暂存写的是 .git/index，提交写 .git/HEAD、.git/objects——这些都不该往外发，
        // 否则每次 git 操作都白搭一轮全量刷新。
        assert!(inside_git_dir(Path::new("/repo/.git/index")));
        assert!(inside_git_dir(Path::new("/repo/.git/HEAD")));
        assert!(inside_git_dir(Path::new("/repo/.git/objects/ab/cdef")));
        assert!(inside_git_dir(Path::new(r"C:\repo\.git\index")));
        assert!(inside_git_dir(Path::new("/repo/sub/.git/config")), "子模块的也算");
    }

    #[test]
    fn working_tree_files_are_kept() {
        assert!(!inside_git_dir(Path::new("/repo/src/App.tsx")));
        assert!(!inside_git_dir(Path::new("/repo/package.json")));
        // 名字里带 git 的普通文件不该被误伤。
        assert!(!inside_git_dir(Path::new("/repo/.gitignore")));
        assert!(!inside_git_dir(Path::new("/repo/git-notes.txt")));
    }
}
