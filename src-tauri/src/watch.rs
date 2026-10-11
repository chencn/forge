//! 工作区文件监听：把磁盘上的改动按批推给前端，前端再去刷目录树、git 状态和打开的文档。
//!
//! 只做「有事发生」这一件事：不告诉前端是新增还是删除，也不给改动前后的内容。
//! 事件粒度太细会让前端各处都要判类型，而它真正要做的只是「重新读一遍」。

use crate::error::{err, err_parts};
use crate::offload::block;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{EventKind, RecursiveMode, RecommendedWatcher, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// 安静这么久就把手里的路径一起发出去。取 150ms：比人手一次保存的间隔短，
/// 又足够把「写临时文件 + 改名」这类连着好几条事件并成一次刷新。
const SETTLE: Duration = Duration::from_millis(150);

/// 攒批的最长时限。构建、git checkout 这类连轴写入时每条事件的间隔都短于 SETTLE，
/// 只靠静默期收尾，flush 会被无限推迟——前端最迟 1 秒必能看到一批改动。
const MAX_WAIT: Duration = Duration::from_millis(1000);

/// 单批大小。soak 不丢路径（见 soak），构建工具一口气吐几万条时 flush 按它拆成
/// 多条事件发，别把单条消息撑成几万条路径。
const BATCH_CAP: usize = 256;

/// 一次上报：受影响的路径，绝对路径，分隔符按平台原样。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    pub paths: Vec<String>,
}

/// 当前工作区的监听句柄、它监听的根目录与请求代号，三者必须一起换。
///
/// 丢掉句柄 = notify 的回调闭包连同发送端一起释放，转发线程读到通道断开就自己退出，
/// 所以停止不需要额外的标志位。root 与代号合起来是 start/stop 的令牌：命令挪到阻塞
/// 线程池后执行顺序没有保证，只有根与代号都对得上的请求才准写槽/清槽，落伍的不动
/// （见 `fs_watch_start_impl` / `fs_watch_stop_impl`）。
#[derive(Default)]
pub struct WatchSlot {
    inner: Mutex<Option<ActiveWatch>>,
}

/// 槽里的一条活动监听。
struct ActiveWatch {
    // 只为持有句柄而存在：一丢，notify 就注销系统监听、转发线程跟着收尾；从不读它。
    #[allow(dead_code)]
    watcher: RecommendedWatcher,
    root: String,
    generation: u64,
}

/// 要不要把这条事件转给前端。
///
/// Windows 后端把「文件内容变了」直接报成 `Modify(Any)`，不细分 Data / Metadata，
/// 所以这里不能只挑几个子类型收 —— 那样改文件内容整类被丢掉，只剩新建和删除看得见。
/// Access 整类排除：inotify 把「打开文件」「没写就关闭」都报成 Access，一次全文搜索、
/// 一次编辑器读盘就是几十万条，放行等于监听器自己触发自己，前端跟着刷到死。
fn interesting(kind: &EventKind) -> bool {
    !matches!(kind, EventKind::Other | EventKind::Access(_))
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
///
/// 主体挪到阻塞线程池：Linux 的 inotify 建递归监听要同步遍历整棵树，大仓库在主线程
/// 上做会把窗口冻住几秒。`generation` 由前端每次换根递增，锁内比对——慢到的旧请求
/// 直接放弃，槽里永远是最新那轮监听。
#[tauri::command]
pub async fn fs_watch_start(
    app: AppHandle,
    root: String,
    generation: u64,
) -> Result<(), String> {
    block(move || fs_watch_start_impl(app, root, generation)).await
}

fn fs_watch_start_impl(app: AppHandle, root: String, generation: u64) -> Result<(), String> {
    let dir = Path::new(&root);
    if !dir.is_dir() {
        return Err(err("NOT_DIR", &root));
    }

    // 锁罩住「判过期 → 建 watcher → watch → 写槽」整段：转 async 后两次快速 start 能并发跑，
    // 代号落后于槽里那轮的请求在这里直接让路——线程池乱序时慢到的旧 start 不能覆盖新监听。
    // 旧句柄在覆盖赋值时 drop——drop 只注销系统监听、把发送端丢给转发线程，不回调进这把锁，
    // 在临界区里丢它没有死锁风险。
    let slot = app.state::<WatchSlot>();
    let mut guard = slot.inner.lock().expect("监听槽位锁");
    if guard
        .as_ref()
        .is_some_and(|active| active.generation > generation)
    {
        return Ok(());
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

    let pump_app = app.clone();
    std::thread::spawn(move || pump(pump_app, receiver));
    // 覆盖即停旧句柄；旧句柄一丢，它那条转发线程也就走到头了。
    *guard = Some(ActiveWatch {
        watcher,
        root,
        generation,
    });
    Ok(())
}

/// 停止监听（关闭工作区时调用）。
///
/// root 与代号合起来是令牌：两者都对得上槽里那轮才真的清槽。stop 走阻塞线程池，
/// 可能比用户随手换目录后那次新 start 晚到——不看令牌就无条件清，会把刚装好的
/// 新监听掐死；对不上说明这条 stop 已经过期，什么都不动。
#[tauri::command]
pub async fn fs_watch_stop(app: AppHandle, root: String, generation: u64) -> Result<(), String> {
    block(move || fs_watch_stop_impl(app, root, generation)).await
}

fn fs_watch_stop_impl(app: AppHandle, root: String, generation: u64) -> Result<(), String> {
    let slot = app.state::<WatchSlot>();
    let mut guard = slot.inner.lock().expect("监听槽位锁");
    let matches = guard.as_ref().is_some_and(|active| {
        active.generation == generation && active.root == root
    });
    if matches {
        *guard = None;
    }
    Ok(())
}

/// 攒批并发的转发线程。收到第一条后继续等静默期，把这段时间内的都并进来再发。
fn pump(app: AppHandle, receiver: mpsc::Receiver<Vec<std::path::PathBuf>>) {
    let mut pending: BTreeSet<String> = BTreeSet::new();
    // 首批路径进集合的时刻，MAX_WAIT 从它起算：事件一直来时静默期永远打不满，
    // 没有这个起点就算不出「已经拖了多久」。
    let mut first_pending_at: Option<Instant> = None;
    loop {
        match receiver.recv() {
            Ok(paths) => {
                if first_pending_at.is_none() {
                    first_pending_at = Some(Instant::now());
                }
                soak(&mut pending, paths);
            }
            // 发送端随 watcher 一起没了：把最后一点攒着的发出去再收工。
            Err(_) => break,
        }
        loop {
            match receiver.recv_timeout(wait_duration(first_pending_at, Instant::now())) {
                Ok(paths) => soak(&mut pending, paths),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    flush(&app, &mut pending);
                    return;
                }
            }
        }
        flush(&app, &mut pending);
        first_pending_at = None;
    }
    flush(&app, &mut pending);
}

/// 这一轮该等多久再收下一条事件。
///
/// 手里没攒东西就按静默期等；攒着的从首批算起已过 MAX_WAIT 就别再等（返回 0，
/// `recv_timeout` 立刻回来把批发掉），临近时限只等剩下的量。事件连轴转时每条间隔
/// 都小于 SETTLE，没有这个上限 flush 会被饿死。判定抽成纯函数，单测好拿假时钟喂。
fn wait_duration(first_pending_at: Option<Instant>, now: Instant) -> Duration {
    match first_pending_at {
        Some(at) if now.duration_since(at) >= MAX_WAIT => Duration::ZERO,
        Some(at) => SETTLE.min(MAX_WAIT - now.duration_since(at)),
        None => SETTLE,
    }
}

fn soak(pending: &mut BTreeSet<String>, paths: Vec<std::path::PathBuf>) {
    for path in paths {
        // 不设提前 return：满了就丢等于把用户刚保存的那条路径丢掉，前端从此认不出
        // 那个文件变了。BTreeSet 天然去重，真超上限也只是多占点内存，flush 按
        // BATCH_CAP 拆批发。
        pending.insert(path.to_string_lossy().into_owned());
    }
}

fn flush(app: &AppHandle, pending: &mut BTreeSet<String>) {
    if pending.is_empty() {
        return;
    }
    let all: Vec<String> = std::mem::take(pending).into_iter().collect();
    // soak 全收不丢，这里按 BATCH_CAP 拆开发，别把单条事件撑成几万条路径。
    for batch in all.chunks(BATCH_CAP) {
        let _ = app.emit("fs://change", FsChange { paths: batch.to_vec() });
    }
}
#[cfg(test)]
mod tests {
    use super::inside_git_dir;
    use super::{interesting, soak, wait_duration, BATCH_CAP, MAX_WAIT, SETTLE};
    use notify::event::{AccessKind, AccessMode, CreateKind, DataChange, ModifyKind, RemoveKind};
    use std::collections::BTreeSet;
    use std::path::Path;
    use std::time::{Duration, Instant};

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

    #[test]
    fn access_events_are_dropped_but_changes_are_kept() {
        use notify::EventKind;
        // inotify 把「打开文件」「没写就关闭」都报成 Access：搜索一遍仓库就是几十万条，
        // 放行等于监听器自己触发自己。
        assert!(!interesting(&EventKind::Access(AccessKind::Close(AccessMode::Read))));
        assert!(!interesting(&EventKind::Access(AccessKind::Open(AccessMode::Any))));
        assert!(!interesting(&EventKind::Other));
        // 内容变了、新建了、删掉了——这三类前端都要刷新；Windows 上内容变更就是
        // Modify(Any)，必须照旧放行。
        assert!(interesting(&EventKind::Modify(ModifyKind::Data(DataChange::Any))));
        assert!(interesting(&EventKind::Create(CreateKind::Any)));
        assert!(interesting(&EventKind::Remove(RemoveKind::Any)));
    }

    #[test]
    fn wait_duration_caps_how_long_a_flush_can_be_postponed() {
        let now = Instant::now();
        assert_eq!(wait_duration(None, now), SETTLE, "手里没攒东西，按静默期等");
        assert_eq!(wait_duration(Some(now), now), SETTLE, "首批刚到，照常等静默期");

        // 攒着的东西快拖满时限：只等剩下的那点量，让下一轮收完立刻发。
        let almost = now - (MAX_WAIT - Duration::from_millis(50));
        assert_eq!(
            wait_duration(Some(almost), now),
            Duration::from_millis(50),
            "临近时限只等剩下的量"
        );
        // 已经拖过时限：事件还在来也别等了，立刻 flush。
        let expired = now - (MAX_WAIT + SETTLE);
        assert_eq!(
            wait_duration(Some(expired), now),
            Duration::ZERO,
            "超过时限就别再等，事件一直来也强制 flush"
        );
    }

    #[test]
    fn soak_keeps_paths_that_arrive_after_the_batch_cap() {
        let mut pending: BTreeSet<String> = BTreeSet::new();
        let full: Vec<std::path::PathBuf> = (0..BATCH_CAP)
            .map(|i| std::path::PathBuf::from(format!("/repo/file-{i}.txt")))
            .collect();
        soak(&mut pending, full);
        assert_eq!(pending.len(), BATCH_CAP);

        // 满了再来的可能是用户刚保存的路径，丢了前端就永远不知道这个文件变了。
        soak(&mut pending, vec![std::path::PathBuf::from("/repo/just-saved.txt")]);
        assert!(pending.contains("/repo/just-saved.txt"), "超上限不能丢新路径");
        assert_eq!(pending.len(), BATCH_CAP + 1);

        // 集合天然去重：重复到达的路径不该翻倍。
        soak(&mut pending, vec![std::path::PathBuf::from("/repo/just-saved.txt")]);
        assert_eq!(pending.len(), BATCH_CAP + 1);
    }
}

