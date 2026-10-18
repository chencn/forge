//! 工作区文件监听：把磁盘上的改动按批推给前端，前端再去刷目录树、git 状态和打开的文档。
//!
//! 只做「有事发生」这一件事：不告诉前端是新增还是删除，也不给改动前后的内容。
//! 事件粒度太细会让前端各处都要判类型，而它真正要做的只是「重新读一遍」。

use crate::error::{err, err_parts};
use crate::offload::{block, block_value};
use std::collections::{BTreeSet, HashMap};
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

/// 一次上报：变更所属的工程根与受影响的路径（绝对路径，分隔符按平台原样）。
#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    pub root: String,
    pub paths: Vec<String>,
}

/// 多工作区常驻下按根目录索引的监听表：每个打开的工程根各占一槽，互不顶替。
///
/// 丢掉某个根的句柄 = notify 的回调闭包连同发送端一起释放，转发线程读到通道断开就自己退出，
/// 所以停止不需要额外的标志位。root 与代号合起来是 start/stop 的令牌：命令挪到阻塞
/// 线程池后执行顺序没有保证，只有该根下代号不落伍的请求才准写槽/清槽
/// （见 `fs_watch_start_impl` / `fs_watch_stop_impl`）。
#[derive(Default)]
pub struct WatchSlot {
    inner: Mutex<HashMap<String, ActiveWatch>>,
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

/// 这一条事件会不会改变「目录里有什么」。
///
/// 只认新增、删除和改名（含跨目录移动，两头各报一次）：这三种才换得出构建标志文件。
/// 改文件内容不算——目录清单缓存记的是名字，内容变了名字没变，作废它就是把重列的代价
/// 摊到每次保存上。
fn changes_listing(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_)
            | EventKind::Remove(_)
            | EventKind::Modify(notify::event::ModifyKind::Name(_))
    )
}

/// 判断一条路径是否为应被忽略的 git 内部无用文件。
///
/// 外部 `git commit`、`git add`、`git checkout` 等操作只写 `.git` 内部指针，工作区源码并未变动；
/// 若粗暴地把整个 `.git` 全部丢弃，外部提交后应用将永远无法感知状态变化。
/// 因此：
/// - 放行代表版本库关键状态变化的指针文件（`HEAD`、`refs/`、`index`、`packed-refs`、`MERGE_HEAD` 等）；
/// - 严密过滤高频写入且无前端状态意义的内部海量对象（`objects/`、`logs/`、`hooks/`）与临时锁文件（`*.lock`）。
fn ignorable_git_internal(path: &Path) -> bool {
    let mut after_git = false;
    let mut git_rel = std::path::PathBuf::new();
    for part in path.components() {
        if after_git {
            git_rel.push(part.as_os_str());
        } else if part.as_os_str() == ".git" {
            after_git = true;
        }
    }
    // 不在 .git 目录内，是普通工作区文件，放行（不忽略）
    if !after_git {
        return false;
    }

    // 锁文件（如 index.lock、HEAD.lock）正处于写入未决阶段，过滤避免引发无效的抖动
    if let Some(ext) = git_rel.extension() {
        if ext == "lock" {
            return true;
        }
    }

    // objects、logs、hooks 等包含大量底层对象和日志，过滤掉以防事件风暴
    let mut components = git_rel.components();
    if let Some(first) = components.next() {
        let first_str = first.as_os_str();
        if first_str == "objects"
            || first_str == "logs"
            || first_str == "hooks"
            || first_str == "info"
        {
            return true;
        }
        // refs/heads/*, refs/tags/*, refs/remotes/* 放行
        if first_str == "refs" {
            return false;
        }
        // 工作树 worktrees/<name>/ 下的 HEAD / index / refs 等同样放行
        if first_str == "worktrees" {
            if let Some(filename) = git_rel.file_name() {
                let name = filename.to_string_lossy();
                if is_git_indicator_name(&name) {
                    return false;
                }
            }
            if git_rel.components().any(|c| c.as_os_str() == "refs") {
                return false;
            }
            return true;
        }
    }

    // 关键顶层指针与索引文件放行；其它未知的内部草稿文件默认忽略
    if let Some(filename) = git_rel.file_name() {
        let name = filename.to_string_lossy();
        if is_git_indicator_name(&name) {
            return false;
        }
    }

    true
}

fn is_git_indicator_name(name: &str) -> bool {
    matches!(
        name,
        "HEAD"
            | "index"
            | "packed-refs"
            | "config"
            | "FETCH_HEAD"
            | "ORIG_HEAD"
            | "MERGE_HEAD"
            | "CHERRY_PICK_HEAD"
            | "REBASE_HEAD"
            | "BISECT_HEAD"
    )
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

/// 判断某个根的 `fs_watch_start` 请求是否被允许写入槽位：
/// 只有当该根尚无活动监听，或新请求的 `generation` 不落后于当前槽内代号时才放行。
fn allow_start_for_root(active_generation: Option<u64>, incoming_generation: u64) -> bool {
    !active_generation.is_some_and(|current| current > incoming_generation)
}

/// 判断某个根的 `fs_watch_stop` 请求是否命中当前槽位：
/// 只有当该根存在且 `(root, generation)` 与槽内记录完全一致时才移除，过期 stop 直接忽略。
fn allow_stop_for_root(active: Option<(&str, u64)>, root: &str, generation: u64) -> bool {
    active.is_some_and(|(active_root, active_gen)| active_root == root && active_gen == generation)
}

fn fs_watch_start_impl(app: AppHandle, root: String, generation: u64) -> Result<(), String> {
    let dir = Path::new(&root);
    if !dir.is_dir() {
        return Err(err("NOT_DIR", &root));
    }

    // 锁罩住「判过期 → 建 watcher → watch → 写槽」整段：转 async 后两次快速 start 能并发跑，
    // 同一根代号落后于槽里那轮的请求在这里直接让路——线程池乱序时慢到的旧 start 不能覆盖新监听。
    // 仅替换该根的旧句柄，其它常驻根的监听句柄保持不动。
    let slot = app.state::<WatchSlot>();
    let mut guard = slot.inner.lock().expect("监听槽位锁");
    if !allow_start_for_root(guard.get(&root).map(|active| active.generation), generation) {
        return Ok(());
    }

    let (sender, receiver) = mpsc::channel::<Vec<std::path::PathBuf>>();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            if !interesting(&event.kind) {
                return;
            }
            // 关键的 Git 指针（如 HEAD、refs、index 等）与普通工作区文件均予放行，
            // 过滤无意义的内部对象（objects/）、提交日志（logs/）与未决的临时锁（*.lock）。
            let paths: Vec<std::path::PathBuf> = event
                .paths
                .into_iter()
                .filter(|path| !ignorable_git_internal(path))
                .collect();
            if !paths.is_empty() {
                // 动到目录内容的那些事件顺手作废构建清单缓存：识别与依赖探测共用那一份，
                // 不等它自己过期就把旧工程留在缓存里，新加的 `pom.xml` 会看不见。
                if changes_listing(&event.kind) {
                    crate::run::scan::invalidate_many(&paths);
                }
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
    let pump_root = root.clone();
    std::thread::spawn(move || pump(pump_app, pump_root, receiver));
    // 插入或替换当前根的句柄；若该根有旧句柄，被替换后自动 drop 并收尾其转发线程。
    guard.insert(
        root.clone(),
        ActiveWatch {
            watcher,
            root,
            generation,
        },
    );
    Ok(())
}

/// 停止指定工程根的监听（关闭某工作区根时调用）。
///
/// root 与代号合起来是令牌：两者都对得上该根槽里那轮才真的移除。stop 走阻塞线程池，
/// 可能比同一根重新打开后的新 start 晚到——不看令牌就无条件删，会把刚装好的
/// 新监听掐死；对不上说明这条 stop 已经过期，什么都不动。
/// 没有可失败的分支（过期即忽略），签名不带 `Result`（error-model 的无失败分支清单）。
#[tauri::command]
pub async fn fs_watch_stop(app: AppHandle, root: String, generation: u64) {
    block_value(
        move || fs_watch_stop_impl(app, root, generation),
        || (),
    )
    .await
}

fn fs_watch_stop_impl(app: AppHandle, root: String, generation: u64) {
    let slot = app.state::<WatchSlot>();
    let mut guard = slot.inner.lock().expect("监听槽位锁");
    let matches = allow_stop_for_root(
        guard
            .get(&root)
            .map(|active| (active.root.as_str(), active.generation)),
        &root,
        generation,
    );
    if matches {
        guard.remove(&root);
    }
}

/// 攒批并发的转发线程。收到第一条后继续等静默期，把这段时间内的都并进来再发。
fn pump(app: AppHandle, root: String, receiver: mpsc::Receiver<Vec<std::path::PathBuf>>) {
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
                    flush(&app, &root, &mut pending);
                    return;
                }
            }
        }
        flush(&app, &root, &mut pending);
        first_pending_at = None;
    }
    flush(&app, &root, &mut pending);
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

fn flush(app: &AppHandle, root: &str, pending: &mut BTreeSet<String>) {
    if pending.is_empty() {
        return;
    }
    let all: Vec<String> = std::mem::take(pending).into_iter().collect();
    // soak 全收不丢，这里按 BATCH_CAP 拆开发，别把单条事件撑成几万条路径。
    for batch in all.chunks(BATCH_CAP) {
        let _ = app.emit(
            "fs://change",
            FsChange {
                root: root.to_string(),
                paths: batch.to_vec(),
            },
        );
    }
}
#[cfg(test)]
mod tests {
    use super::ignorable_git_internal;
    use super::{
        allow_start_for_root, allow_stop_for_root, changes_listing, interesting, soak,
        wait_duration, FsChange, BATCH_CAP, MAX_WAIT, SETTLE,
    };
    use notify::event::{
        AccessKind, AccessMode, CreateKind, DataChange, ModifyKind, RemoveKind, RenameMode,
    };
    use std::collections::BTreeSet;
    use std::path::Path;
    use std::time::{Duration, Instant};

    #[test]
    fn multi_root_slot_tokens_isolate_start_and_stop_per_root() {
        assert!(allow_start_for_root(None, 1), "新根首次启动应放行");
        assert!(allow_start_for_root(Some(1), 2), "同一根更高代号应覆盖旧监听");
        assert!(!allow_start_for_root(Some(3), 2), "乱序晚到的旧代号不能覆盖新监听");

        assert!(
            allow_stop_for_root(Some(("D:/repo-a", 2)), "D:/repo-a", 2),
            "根与代号都匹配时才停止"
        );
        assert!(
            !allow_stop_for_root(Some(("D:/repo-a", 3)), "D:/repo-a", 2),
            "同一根重开后旧代号的晚到 stop 必须忽略"
        );
        assert!(
            !allow_stop_for_root(Some(("D:/repo-b", 2)), "D:/repo-a", 2),
            "不同根互不干扰"
        );
    }

    #[test]
    fn fs_change_carries_root_and_paths() {
        let change = FsChange {
            root: "D:/repo-a".to_string(),
            paths: vec!["D:/repo-a/src/main.rs".to_string()],
        };
        let json = serde_json::to_string(&change).unwrap();
        assert!(json.contains(r#""root":"D:/repo-a""#));
        assert!(json.contains(r#""paths":["D:/repo-a/src/main.rs"]"#));
    }

    #[test]
    fn git_internals_are_filtered_out() {
        // 外部 git commit 会写 objects/ 与 logs/，这些高频日志与底层对象必须过滤；
        // 锁文件（如 index.lock）未决阶段也不该推给前端。
        assert!(ignorable_git_internal(Path::new("/repo/.git/objects/ab/cdef")));
        assert!(ignorable_git_internal(Path::new("/repo/.git/logs/HEAD")));
        assert!(ignorable_git_internal(Path::new("/repo/.git/logs/refs/heads/main")));
        assert!(ignorable_git_internal(Path::new("/repo/.git/hooks/pre-commit")));
        assert!(ignorable_git_internal(Path::new("/repo/.git/index.lock")));
        assert!(ignorable_git_internal(Path::new(r"C:\repo\.git\HEAD.lock")));
        assert!(ignorable_git_internal(Path::new("/repo/.git/COMMIT_EDITMSG")));

        // 关键版本库状态指针必须放行，以便外部提交、切分支、暂存后能及时感知
        assert!(!ignorable_git_internal(Path::new("/repo/.git/index")));
        assert!(!ignorable_git_internal(Path::new("/repo/.git/HEAD")));
        assert!(!ignorable_git_internal(Path::new("/repo/.git/refs/heads/main")));
        assert!(!ignorable_git_internal(Path::new("/repo/.git/refs/tags/v1.0.0")));
        assert!(!ignorable_git_internal(Path::new(r"C:\repo\.git\index")));
        assert!(!ignorable_git_internal(Path::new("/repo/sub/.git/config")), "子模块配置放行");
        assert!(!ignorable_git_internal(Path::new("/repo/.git/packed-refs")));
        assert!(!ignorable_git_internal(Path::new("/repo/.git/MERGE_HEAD")));
        assert!(!ignorable_git_internal(Path::new("/repo/.git/worktrees/wt1/HEAD")));
    }

    #[test]
    fn working_tree_files_are_kept() {
        assert!(!ignorable_git_internal(Path::new("/repo/src/App.tsx")));
        assert!(!ignorable_git_internal(Path::new("/repo/package.json")));
        // 名字里带 git 的普通文件不该被误伤。
        assert!(!ignorable_git_internal(Path::new("/repo/.gitignore")));
        assert!(!ignorable_git_internal(Path::new("/repo/git-notes.txt")));
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
    fn only_listing_changes_wake_the_directory_cache() {
        use notify::EventKind;
        // 目录清单缓存记的是「这一层有哪些标志文件名字」。新增、删除、改名（含跨目录移动，
        // 两头各一条）才会换掉这份名单，才值得作废它。
        assert!(changes_listing(&EventKind::Create(CreateKind::File)));
        assert!(changes_listing(&EventKind::Remove(RemoveKind::File)));
        assert!(changes_listing(&EventKind::Modify(ModifyKind::Name(
            RenameMode::Any
        ))));
        // 保存只改内容：名字没变，跟着作废等于把重列目录的代价摊到每次敲字上。
        assert!(!changes_listing(&EventKind::Modify(ModifyKind::Data(DataChange::Any))));
        assert!(!changes_listing(&EventKind::Access(AccessKind::Open(AccessMode::Any))));
        assert!(!changes_listing(&EventKind::Other));
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

