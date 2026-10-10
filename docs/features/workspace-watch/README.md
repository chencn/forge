# 文件监听与磁盘同步

打开工作区就递归盯住那个目录，磁盘改动去抖后成批发回前端，目录树、git 状态、开着的文档一起补，不用手点刷新。
后端在 `src-tauri/src/watch.rs`，前端订阅与再并批在 `useFileWatch`，文档那一侧的让位规则在 `useDocuments`。
树侧的缓存代价见 `../file-explorer/`。

## 后端只报「有事发生」

- `notify::recommended_watcher` 配 `RecursiveMode::Recursive` 盯整棵子树。root 不是目录报 `NOT_DIR`。
- 事件只带路径：不区分新增还是删除，也不给改动前后的内容。粒度再细，前端每一处都要判类型，而它要做的只是重新
  读一遍。
- 过滤只排掉 `EventKind::Other`。不能只挑 `Modify(Data)` / `Modify(Metadata)` 这类子类型：Windows 后端把「文件
  内容变了」报成 `Modify(Any)`，挑子类型会把改内容整类漏掉，只剩新建和删除能报上来。

去抖在转发线程里做：第一条到达后继续等 150ms 静默期，这段时间里的路径并进 `BTreeSet`，顺带去重和排序，静默了才
`emit("fs://change", { paths })`。150ms 比人手一次保存的间隔短，又足够把「写临时文件 + 改名」这类连着好几条并成
一次刷新。

单批 256 条上限，`soak()` 攒满之后把剩下的路径丢掉。可以丢，因为树和 git 状态本来就是整份重取，路径只喂给文档
那一步判定。

停止不需要额外标志位：把 `RecommendedWatcher` 从槽里丢掉，回调闭包连同发送端一起释放，转发线程读到通道断开自己
退出，退出前把剩余路径发完。

## 前端这一侧

- `useFileWatch` 在浏览器里再并一次 120ms。一次保存会连着来好几条事件，再并一次就少几轮重读。
- root 一变就重新起监听。换目录时 cleanup 故意不发 `fs_watch_stop`：后端起新的会顺手停掉旧的，而自己发的一次
  「停」可能比新的一次「起」晚到，把刚装好的监听停掉。root 变成 null（关闭工作区）才真的停。
- 起监听失败前端不报错，`watchWorkspace` 里带 `.catch(() => {})`。表现是自动刷新没了，要点头部的刷新按钮。
- 一次改动补三处：`refreshTree()`（`treeSignal++`）、`git.refreshChanges()`、`docs.noteExternalChange(paths)`。
  git 这侧只重取变更清单：文件改动不会动分支、标签和 HEAD 上那条提交，每批事件都把五条命令起八个 git 进程
  太贵。引用真的变了（提交、签出、建删分支标签、重置、推送）由那几条动作自己走 `git.refresh()`。
- git 那侧给每轮刷新编号，只有最新一次允许写状态。监听触发的多轮刷新并发时，五次调用回来的顺序不保证，旧结果会
  把新结果盖掉。转圈状态不跟着编号走，另记在飞条数：全量刷新还在飞时一次暂存把编号抢走，那一轮就永远收不到
  收尾信号，刷新图标会一直转。
- 没有 ignore 名单。整个工作区递归盯着，`node_modules` 里的改动照样触发一次刷新，只是重读目录与 git 状态，不逐条
  处理事件。代价就是上面那条 256 上限。

## 文档侧只有一条规则：不动用户正在编辑的内容

- 「没改」的判定是 `contents === baseline`。干净的文档跟着磁盘重载，正文、行尾、BOM、mtime 一起换。有未保存改动
  的一律不碰：这一轮的筛选不把它列进来，`save()` 写的是 `doc.contents`，不看磁盘 mtime。
- 两边都改了：不合并，也不弹框要人当场选边界，以编辑器里的版本为准。这种框没法自动判，内容又合并不了。代价写明：
  磁盘上那次外部改动被覆盖之后，没提交过就找不回来。只读预览那一侧（没有未保存改动）永远跟着磁盘走。
- 跳过重载的条件是「正文相同且 mtime 相同」。只有 mtime 变了（构建工具常 touch）仍走一遍写回，但 model 里的文本
  没变，Monaco 不 `setValue`，光标位置不动。
- 位图没有正文可重载：只比指纹 `modifiedMs || size`，没变就什么都不做，变了就换 asset URL 上的 `?v=`，让 webview
  丢掉旧缓存图。
- 磁盘那份读不回来（多半是被删了）：留着手里这份文本，转成只读，原因写在正文区。
- 之前打不开的文档正文和基线都是空串，判成「没改」，同样在这一轮里重试：文件改小或转成 UTF-8 就自动转成可编辑。
  哪些情况算打不开见 `../documents-preview/`。
- 失焦自动保存与退出前强制保存都走 `saveAll()`，串行写盘。同一份文件可能被两个入口碰到，并发写的顺序乱了，磁盘
  上就是半新半旧。

## asset 协议授权

CSP 是 `default-src 'self'`，`file://` 进不了 webview；位图也没法整份经 `invoke` 返回值交给 `<img>`。本地图片
只能走 asset 协议。

这条协议的授权不落盘，重启即失效，所以每次 `workspaceRoot` 一变就重授一次。`fs_allow_asset` 授的是整棵子树：
`allow_directory(root, true)`。只授根目录的话，文档里引用的子目录图片读不到。配置里 `scope.allow` 是空表，
没有授权时一个字节都读不到。

markdown 正文里的图片怎么用这条协议见 `../documents-preview/`。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src-tauri/src/watch.rs` | 设计前提 `:1-4`；`SETTLE` 150ms 与取值理由 `:17-19`；`BATCH_CAP` 256 `:21-22`；`FsChange` 载荷 `:24-29`；`WatchSlot` 与停止方式 `:31-36`；`interesting` 只排 `Other` `:38-44`；`fs_watch_start` 与 `NOT_DIR` `:46-73`；`fs_watch_stop` `:75-79`；`pump` 静默期与退场 `:81-103`；`soak` 上限 `:105-112`；`flush` 发 `fs://change` `:114-120` |
| `src/hooks/useFileWatch.ts` | `COALESCE_MS` 120ms `:5-6`；root 为 null 才停 `:21-25`；再并批 `:28-41`；订阅建立前的竞态 `:42-46`；cleanup 不送 stop `:48-54` |
| `src/hooks/useDocuments.ts` | `canPreview` 与 `defaultView` `:51-66`；`save` 取 `doc.contents` `:228-247`；`saveAll` 串行 `:249-264`；`noteExternalChange` 的干净判定、touch 跳过、位图指纹、读不回 `:266-324` |
| `src/App.tsx` | 磁盘改动补三处 `:350-363`；asset 授权重授 `:286-289`；失焦与退出前保存 `:302-318` |
| `src/hooks/useGitState.ts` | 刷新编号与 `stale` 判定 `:77-98` |
| `src/lib/fs.ts` | `watchWorkspace` / `stopWorkspaceWatch` 吞错 `:70-78`；`assetUrl` 的 `?v=` `:126-135`；`allowAssetDir` `:137-140` |
| `src-tauri/src/fs/mod.rs` | `read_file` 的上限与编码判定 `:194-229`；`file_stamp` 指纹 `:356-366`；`fs_allow_asset` 递归授权 `:368-377` |
| `src/lib/docKind.ts` | `hasTextContent` 与 `previewsFromDisk` `:66-82` |
| `src/components/CodeEditor.tsx` | 文本没变不 `setValue` `:96-104` |
| `src-tauri/tauri.conf.json` | CSP `:27`；`assetProtocol` 空 scope `:28-34` |
