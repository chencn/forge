# 文件监听与磁盘同步

打开工作区就递归盯住那个目录，磁盘改动去抖后成批发回前端，目录树、git 状态、开着的文档一起补，不用手点刷新。
后端在 `src-tauri/src/watch.rs`，前端订阅与再并批在 `useFileWatch`，文档那一侧的让位规则在 `useDocuments`。
保存时的乐观锁、三向冲突与退出握手见 [保存冲突与磁盘版本校验](./save-conflicts.md)。
树侧的缓存代价见 `../file-explorer/`。

## 后端只报「有事发生」

- `notify::recommended_watcher` 配 `RecursiveMode::Recursive` 盯整棵子树。root 不是目录报 `NOT_DIR`。
- 槽位是 `HashMap<root, ActiveWatch>`，一个根一条 watcher，后台根与激活根同时在盯。起新的只顶掉**同一个根**上一轮
  的句柄，别的根不受影响（多根切换见 `../workspace-tabs/`）。
- `(root, generation)` 合起来是令牌：代号由前端每次新监听递增，start 与 stop 都带着它，后端只认与槽内记录完全一致
  的那一轮。换目录时前端那次「停」可能比新的一次「起」晚到，代号对不上就整条忽略，不会把刚装好的监听停掉。
- 事件只带路径与所属 root：不区分新增还是删除，也不给改动前后的内容。粒度再细，前端每一处都要判类型，而它要做的只是重新
  读一遍。
- 过滤只排掉 `EventKind::Other`。不能只挑 `Modify(Data)` / `Modify(Metadata)` 这类子类型：Windows 后端把「文件
  内容变了」报成 `Modify(Any)`，挑子类型会把改内容整类漏掉，只剩新建和删除能报上来。
- `.git` 不做整棵排除，只剔内部噪声：放行代表版本库状态变化的指针（`HEAD`、`index`、`packed-refs`、
  `MERGE_HEAD`、`CHERRY_PICK_HEAD`、`REBASE_HEAD`、`BISECT_HEAD`、`refs/**`、各工作树下的同名文件），
  滤掉高频写入的 `objects/`、`logs/`、`hooks/`、`info/` 与任何 `*.lock`。整棵丢掉的话，外部 `git commit`
  就永远传不进应用。

去抖在每条 watcher 自己的转发线程里做：第一条到达后继续等 150ms 静默期，这段时间里的路径并进 `BTreeSet`，顺带去重和
排序，静默了才 `emit("fs://change", { root, paths })`；持续写入时最长攒 1 秒就先放行一轮，不让人一直等下去。
150ms 比人手一次保存的间隔短，又足够把「写临时文件 + 改名」这类连着好几条并成一次刷新。攒批的 `pending` 是线程局部，
不是全局表，多根之间不串味。

单批 256 条是**发送**的粒度，不是丢弃的阈值：`soak()` 全收不丢（满了就丢等于把用户刚保存的那条路径丢掉，
前端从此认不出那个文件变了），`flush()` 把攒下的路径按 256 拆成多条事件发出去。前端那边的精确作废
（见下）就靠这条不丢路径才敢用。

停止不需要额外标志位：把 `RecommendedWatcher` 从该根的槽里丢掉，回调闭包连同发送端一起释放，转发线程读到通道断开自己
退出，退出前把剩余路径发完。

## 前端这一侧

- `useFileWatch` 收的是 `watchedRoots` 这一串：新进来的根起监听、被关掉的根停监听，已经在了的不重启，
  卸载时把残余全部停掉。监听范围因此等于常驻的文件夹数，后台根的改动一样进得来（`../workspace-tabs/`）。
- 浏览器这一侧按 `payload.root` 分桶，每桶各一份去抖：普通批次并 120ms，一次保存会连着来好几条事件，
  再并一次就少几轮重读。判定为批量增删风暴的那一桶改等 1200ms 静默，最长挂 6000ms 后强制放行一轮，
  免得 `npm install` 期间一直刷。风暴的判据是去重后的路径数到 10 条、或这批里出现产物与依赖目录的特征路径，
  **不看批次条数**——单文件保存被拆成两条通知不该被误判成风暴。
- 起监听失败前端不报错，`watchWorkspace` 里带 `.catch(() => {})`。表现是自动刷新没了，要点头部的刷新按钮。
- 一批事件该刷哪几处，全在 `src/lib/watchBatch.ts` 的 `planWorkspaceFlush` 里定，`App.tsx` 的
  `flushWorkspace` 只负责照着执行；监听来的批次和包管理会话收尾攒下的那批都走这一条路，不再各写一套。
  - 目录树分三档：`full` 整棵作废、`precise` 只作废与这批路径相干的目录、`none` 不动。只有「整棵树结构
    可能变了」才算 full——路径数到风暴阈值、或这批里出现依赖目录（`node_modules`、`.pnpm`、`vendor`、
    `.venv`）。全是构建产物（`target/`、`dist/`、`build/`、`.next/`）时只精确作废：那是覆盖写，目录里
    有什么名字基本没变，重读整棵树是白花钱。精确作废不会漏：它会重列每一个包含被改路径、或位于被改路径
    之下的缓存目录。
  - git 分两档：`changes` 只重取变更清单，`full` 连分支与提交记录一起重取（这批里出现 `HEAD`、`refs/`、
    `packed-refs`、`MERGE_HEAD`）。文件改动不会动分支，每批都把五条命令起八个 git 进程太贵。
  - 构建声明文件（`package.json`、`pom.xml`、`Cargo.toml`）变了才防抖 600ms 重扫顶栏运行配置。
  - 本地 git / 保存动作会主动刷一轮，并开一个 800ms 回声窗口：窗口内的纯回声直接丢掉，省一趟进程。
    引用类变动不丢，挪到窗口尾巴补一次——30s 轮询只重取变更清单，分支名不会自己回来。
- 包管理会话（`npm install`、`cargo build` 等）运行期间，工作区与 `.git` 两路路径都按根暂存，会话结束时
  一并补刷；另有 3000ms 防饥饿上限，超上限先放行一次并重置积攒。安装期间从外部终端来的一次 checkout 也
  靠这里落地，不会因风暴被整批扔掉。
- 后端把报来的新增 / 删除 / 改名顺手作废构建标志文件名单缓存（`changes_listing` → `run::scan`）：
  顶栏识别与依赖探测共用那一份名单。改文件内容不作废——名单里只有名字，内容变了名字没变。
- git 那侧给每轮刷新编号，只有最新一次允许写状态。监听触发的多轮刷新并发时，五次调用回来的顺序不保证，旧结果会
  把新结果盖掉。转圈状态不跟着编号走，另记在飞条数：全量刷新还在飞时一次暂存把编号抢走，那一轮就永远收不到
  收尾信号，刷新图标会一直转。
- 后端没有排除入参，也没有 ignore 名单：`node_modules` 里的改动照样报上来，只是事件不带类型、前端不逐条处理，
  代价由上面两处挡着——`.git` 内部噪声在后端剔，批次分档决定重读多少目录，风暴静默决定多久读一次。
  丢弃路径不丢正确性：报来的整批只喂给文档判定，目录树与 git 状态本来就是整份重取。

## 文档侧：监听不覆盖编辑内容，保存时校验磁盘版本

- 「没改」的判定是 `contents === baseline`。干净的文档跟着磁盘重载，正文、行尾、BOM、mtime 一起换。有未保存改动
  的一律不被监听回调覆盖，继续保留编辑器中的文本。
- 两边都改时由保存乐观锁阻止覆盖并打开三向合并。合并结果写回前还会按对话框读到的磁盘 mtime 再校验一次；
  磁盘若再次变化就保留当前合并结果并重开冲突。完整流程见 [保存冲突与磁盘版本校验](./save-conflicts.md)。
- 跳过重载的条件是「正文相同且 mtime 相同」。只有 mtime 变了（构建工具常 touch）仍走一遍写回，但 model 里的文本
  没变，Monaco 不 `setValue`，光标位置不动。
- 位图没有正文可重载：只比指纹 `modifiedMs || size`，没变就什么都不做，变了就换 asset URL 上的 `?v=`，让 webview
  丢掉旧缓存图。
- 磁盘那份读不回来（多半是被删了）：留着手里这份文本，转成只读，原因写在正文区。
- 之前打不开的文档正文和基线都是空串，判成「没改」，同样在这一轮里重试：文件改小或转成 UTF-8 就自动转成可编辑。
  哪些情况算打不开见 `../documents-preview/`。
- 失焦自动保存与退出前强制保存都走 `saveAll()`，串行写盘。同一路径的前端保存请求还会复用在飞 Promise；后端普通保存
  与本地历史恢复共同取得全局写锁。退出保存后若仍有脏文档，前端取消退出而不是丢弃冲突内容。

## asset 协议授权

CSP 是 `default-src 'self'`，`file://` 进不了 webview；位图也没法整份经 `invoke` 返回值交给 `<img>`。本地图片
只能走 asset 协议。

这条协议的授权不落盘，重启即失效，所以每个根在成为激活根时重授一次。`fs_allow_asset` 授的是整棵子树：
`allow_directory(root, true)`。只授根目录的话，文档里引用的子目录图片读不到。授权是累积式的、没有撤销入口，
所以新根授权不会让旧根的图片失效，关掉一个根也收不回那份授权。配置里 `scope.allow` 是空表，
没有授权时一个字节都读不到。

markdown 正文里的图片怎么用这条协议见 `../documents-preview/`。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src-tauri/src/watch.rs` | `SETTLE` 150ms `:20`；`MAX_WAIT` 1s 封顶 `:24`；`BATCH_CAP` 256 只是发送粒度 `:28`；`FsChange.root` `:34`；`WatchSlot` 按根集合 `:45`；`interesting` 只排 `Other` `:64`；`changes_listing` 认新增/删除/改名 `:73`；`ignorable_git_internal` `:89`；`is_git_indicator_name` `:152`；`fs_watch_start` `:174`；`allow_start_for_root` `:184`；`allow_stop_for_root` `:190`；`fs_watch_stop` `:261`；作废名单缓存 `:226`；`soak` 全收不丢 `:330`；`flush` 拆批发 `:339` |
| `src/lib/watchBatch.ts` | 判据的前提写在文件头 `:1-13`；`isPackageInstallPath` `:38`；`isBuildOutputPath` `:43`；`isBulkArtifactPath` `:48`；`needsFullTreeRefresh` `:61`；`planWorkspaceFlush` `:109` |
| `src-tauri/src/run/scan.rs` | 共享的构建标志文件名单缓存：`LISTING_TTL` `:19`；`marks` 带在飞竞态守卫 `:173`；`invalidate_many` `:246` |
| `src/hooks/useFileWatch.ts` | `COALESCE_MS` 120ms `:7`；`STORM_SETTLE_MS` 1200ms `:14`；`STORM_MAX_WAIT_MS` 6000ms `:16`；`STORM_PATH_THRESHOLD` 10 条 `:18`；入参是 `roots[]` `:38`；`generation` `:45` 与已注册根的 `activeMap` `:47`；按根分桶 `:52`；bulk 判定（路径数或产物特征）`:85-88`；风暴期的等待 `:97-99`；增量启停 `:125` 与卸载清场 `:146` |
| `src/hooks/useDocuments.ts` | `canPreview` 与 `defaultView` `:51-66`；`save` 取 `doc.contents` `:228-247`；`saveAll` 串行 `:249-264`；`noteExternalChange` 的干净判定、touch 跳过、位图指纹、读不回 `:266-324` |
| `src/App.tsx` | 回声窗口 `:534`；按根暂存 `:1413`；`flushWorkspace` `:1443`；`onDiskChange` `:1515`；会话收尾补刷 `:1601-1608` |
| `src/hooks/useGitState.ts` | 刷新编号与 `stale` 判定 `:77-98` |
| `src/lib/fs.ts` | `watchWorkspace` / `stopWorkspaceWatch` 吞错 `:94-104`；`assetUrl` 的 `?v=` `:169`；`allowAssetDir` `:175` |
| `src-tauri/src/fs/mod.rs` | `read_file` 的上限与编码判定 `:271-275`；`file_stamp` 指纹 `:762`；`fs_allow_asset` 递归授权 `:809` |
| `src/lib/docKind.ts` | `hasTextContent` 与 `previewsFromDisk` `:66-82` |
| `src/components/CodeEditor.tsx` | 文本没变不 `setValue` `:96-104` |
| `src-tauri/tauri.conf.json` | CSP `:27`；`assetProtocol` 空 scope `:28-34` |
