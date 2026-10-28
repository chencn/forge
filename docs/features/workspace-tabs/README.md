# 一个窗口常驻多个工程文件夹

一条 `openFolders` 加一颗激活根，切工程只换上下文，不重载窗口、不杀后台。三条硬要求：点一下就能切过去；
切过去时编辑区页签整套换成那个文件夹的，**唯一例外是设置页，跨文件夹保留**；切走那个文件夹的终端会话与运行任务
继续在后台活着。

后端与权限那层的天然多根（终端表按自增 `term-N` 建键、进程表按 `proc-N`、git 每条命令第一个参数就是 root、
asset 授权累积不撤销、运行配置本就按工程根分节）见 [../../backend/commands.md](../../backend/commands.md)；
这一份管前端的状态拆分、切根与关根的语义。

## 状态模型

`openFolders: string[]` 是常驻的文件夹，`workspaceRoot` 是其中激活的那一个。初值取
`history.activeFolder || history.lastFolder || history.openFolders[0]`。

「有任一根」就够的判定（运行区 enabled、搜索按钮 disabled、欢迎页、状态条那一格是否绘制）一律看
`openFolders.length > 0`，不看激活根。

必须按根拆开的，全部落在 `*ByRoot` 这一族状态里：

| 按根存的 | 内容 |
| --- | --- |
| 文档集与激活页签 | 文档每条带自己的 `root`，`belongsToRoot` 按归属判定；`activeTabByRoot` 记每个根看着哪一颗 |
| 页签顺序 | `tabOrderByRoot`，切回来顺序不变 |
| 比对页签与比对链 | `setDiffsByRoot` 与 `diffChainsByRoot`，切根不丢链 |
| 查找与替换 | `findByRoot`，结果按根留着 |
| 资源管理器选中项 | `explorerPickByRoot` |
| 底部面板位置与停靠形态 | `placesByRoot` 与 `lastPlaceByRoot`，分隔条尺寸切根不重置 |
| 通知 | `updateNotifications(updater, root)`：后台根产生的通知落回它自己那份存储，不串进激活根；展示与未读只按激活根算，没有跨根汇总 |
| 运行配置页开合、编辑器分栏、AI 草稿与预览 | `runConfigsTabByRoot` / `editorSplits` / `aiDraftOpen` / `aiFilePreviewsByRoot` |
| 目录树展开态与懒加载缓存 | `expandedByRootRef`，换根不清缓存 |

天然共用、不拆的：Monaco 的 model 与编辑器实例、终端会话表、运行进程表、asset 授权、设置页签。
文档集合本身以绝对路径为唯一键，页签 id 带类型前缀加绝对路径（`doc|<path>`），Monaco 的 model URI 是
`monaco.Uri.file(path)`，本来就跨根唯一。

## 切根与关根是两个动作

- `switchOrAddFolder(picked)` 只做「加一个并切过去」。多工作区模式下已常驻的根不重复追加；
  单工作区模式下所选不是常驻根时，先把当前激活根关掉再就地替换，其它常驻根不动。
  关闭失败（AI 任务停不下来）就不切走，否则新工程顶着一个还在跑旧任务的后端。
  切走时若正停在设置页，那份「激活页签是设置」跟着新根一起写，设置页不被换根清掉。
- `performCloseRoot(root)` 只销毁这一个根的东西：先停该根的 AI 运行时（`ai_runtime_stop_project`），
  收该根的终端（`closeTermsForRoot`）与运行任务（`closeSessionsForRoot`），按文档归属逐条 `disposeModel`
  再 `closeForRoot`，回收忽略清单缓存与该根的比对链、查找结果、选中项、页签顺序、面板位置。
  AI 会话的轮询只在工程真被关闭时注销，切前台工程时必须继续盯后台会话。
- 关之前先按 `savePolicy` 存该根的脏文档，还有未保存改动或在跑的东西就弹确认。在跑的定义是三样：
  运行任务、存活终端会话、该根的 AI 任务；文案按 dirty / running / both 三档给。
  设置页签不属于任何根，不能被连带关掉。

三条「换根顺手杀后台」的老路已经拆掉：换根不再调 `dropTermSession`（它遍历前端全部会话逐条 `term_close`）；
`useRunSessions` 里那条依赖 `cwd` 的 effect 改成会话自己记 `root`、缓冲按根存；语言服务见下。

## 文件监听按根开槽

`WatchSlot` 是 `Mutex<HashMap<root, ActiveWatch>>`，`fs_watch_start` 是「插入或替换该根」，
`fs_watch_stop` 只删该根。事件体 `FsChange` 带 `root`，前端一份全局订阅按 `payload.root` 分桶去抖再派发。

`(root, generation)` 合起来是令牌：代号每次新监听递增，start 与 stop 都带着它，后端只认不落伍的请求——
换目录时前端那次「停」可能比新的一次「起」晚到，代号对不上就整条忽略，不会把刚装好的监听停掉。
攒批的 `pending` 是每条 watcher 自己 pump 线程的局部变量，不是全局表，多根之间不串味。
改名事件 notify 会同时报新旧两条路径，两条都收进批里按整串去重。

监听范围是 `watchedRoots`（`openFolders`，没有它时退化成激活根那一颗），后台根的磁盘改动一样进得来。

## 语言服务只跟激活根

`reconcileLsp` 的入参仍是「一个根 + 该根的文档」，切根时未激活那几根的会话在「不再需要的会话收掉」这一步被停掉，
这是拍板下来的口径：只加载当前激活项目的语言服务，未激活的自动回收。根解析的 `roots` 缓存跨根保留，
切回去不必重扫标志文件。no-root 的跳过标记按**文件所在目录**记，带 TTL，不拿工作区根把一次「没查到」永久钉死。

## 持久化

`History` 两个字段：`openFolders: string[]` 与 `activeFolder: string`。结构体级带
`#[serde(rename_all = "camelCase", default)]`，改造前生成的 `history.json` 读进来自动是空数组与空串，
不做迁移。`lastFolder` 与 `recentFolders` 语义不变，每次切根把目标根记进最近项目。
模式开关是设置里的 `workspaceMode`（`multi` / `single`，默认 `multi`），旧文件缺字段按默认补。

## 工程芯片与「已打开」列表

芯片仍是原来那一颗（图标 + 名称 + 下拉箭头），多根模式下在名称右边挂计数徽标，**整颗一起点**，
徽标不是第二颗按钮。弹层用现成 `Popover`，在「最近项目」上方加一组「已打开」，行结构与「最近项目」完全同构：
`FolderOpen` + 完整名称 + 等宽小字路径（路径常显，不是只作悬停），当前项加粗，已经在「已打开」里的路径从
「最近项目」中过滤掉，同一文件夹不在弹层里上下重复出现。

状态点两种：绿点 = 该根有运行中的任务或存活的终端会话（AI 任务也算），蓝点 = 该根有未保存改动。
行上的关闭按钮走 `onCloseFolder`，与顶栏那颗「关闭文件夹」同一条路。

单根模式或只有 1 个根时，计数徽标和「已打开」组都不出现，顶栏与弹层与改造前逐像素一致。
切回单根模式不询问、也不关闭后台根：后台根及其页签、终端、运行任务留在内存里，只是前端隐藏多工作区那套 UI，
切回多根或重选该根时原样恢复。

否决过的形态：顶栏下方独立一行项目标签（占垂直空间、与文件页签同族易混）、侧栏面板顶部的工作区横条、
图标上叠首字母角标与色相（名称已经全显，缩写是多余信号）、把折叠那颗挪进标记格或活动栏、
顶栏一排常驻芯片（宽度随根数线性增长）。

## 常驻的实现方式

不重载靠的是「状态按根留着 + 共享的那几样不重建」，非激活根不渲染但也不销毁手里的东西：

- 编辑器只有一台实例且开了 `automaticLayout`，切根时不卸载它，否则装订线上的运行箭头 measure 失效；
  保撤销栈与光标的前提同样是别卸载。文档 model 只在关根时逐条释放，换根不释放。
- 终端容器宽度归 0 会把 ConPTY 弄死，现有实现靠「宿主小于 20px 就直接 return」挡；重新显示时必须重算 fit 的
  cols / rows 并同步回 PTY，重挂还要 `term.reset()` 加全量重放缓冲。终端页签订阅全部会话不按 cwd 过滤。
- 目录树换根不再清懒加载缓存与展开态：`expandedByRootRef` 按根存，只在根被关时剪掉落在他之外的键。

同名文件的页签消歧保持取路径尾段 `basename`：页签本身按根隔离，不会并排显示不同根的页签。

## 已知边界

- 切根会关掉手上开着的浮层：随处搜索弹层、对话框、右键菜单、日志引用与比对起点那几格筛选一起清空。
  留住的是页签、文档、比对链与查找结果，不是浮层。
- 变更计数、分支名与日志只反映激活根：`useGitState` 收的是 `workspaceRoot`。后台根给的是「有没有在跑」与
  「有没有未保存」两种状态点，不是精确的 VCS 数字。
- 关根不撤销 asset 授权：那条协议只有累积式的 `fs_allow_directory`，没有撤销入口，被关掉的根在退出应用前
  仍可读图片。
- `dropTermSession` 这条全清前端的入口已经不在换根路径上，只剩单测在用。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src/App.tsx` | `openFolders` `:394` 与激活根 `:397`、初值 `:393`；`rootKey` / `rootKeyRef` `:675-677`；`explorerPickByRoot` `:685`、`diffChainsByRoot` `:707`、`runConfigsTabByRoot` `:748`、`activeTabByRoot` `:753-754`、`tabOrderByRoot` `:907-913`、`findByRoot` `:1016`、`lastPlaceByRoot` `:1031`、按根暂存的监听批次 `:1413`；通知按根写回 `:410`；`reconcileLsp` effect `:597`；`watchedRoots` `:1628-1633`；`performCloseRoot` `:2097`、`requestCloseRoot` `:2194`、`switchOrAddFolder` `:2224`、`openFolder` `:2273`、`closeFolder` `:2284`、`folderStatusList` `:2290-2303`；`closeRoot` 确认分支 `:3757` |
| `src/components/ProjectPicker.tsx` | `FolderStatusItem` `:10`、「已打开」分组与计数徽标的可见条件 `:60-64`、芯片上的绿点与徽标 `:96-97`、行结构 `:103-165` |
| `src/hooks/useDocuments.ts` | `doc.root` 的归属判定 `belongsToRoot` `:115`、打开时记归属根 `:191-220`、`saveAllForRoot` `:584`、`closeForRoot` `:726`、`hasDirtyForRoot` `:757` |
| `src/hooks/useFileWatch.ts` | 按根起停与代号 `generation`、一份全局订阅按 `payload.root` 分桶去抖 |
| `src/hooks/useRunSessions.ts` | 会话带 `root` `:23`、`rootKey` `:55`、按根过滤停止与清缓冲 `:317-342`、`hasRunningSessionsForRoot` `:378` |
| `src/hooks/useGitState.ts` | 单根快照（边界那条） |
| `src/lib/termStore.ts` | `hasAliveTermsForRoot` `:335`、`closeTermsForRoot` `:708`、`dropTermSession` `:732` |
| `src/components/ExplorerTree.tsx` | `expandedByRootRef` 按根留展开态 `:306-316`、按常驻根剪缓存 `:196` 与 `:337-345` |
| `src-tauri/src/watch.rs` | `WatchSlot` 按根集合 `:45`、`FsChange.root` `:34`、`allow_start_for_root` `:184`、`allow_stop_for_root` `:190`、start `:174` / stop `:261` |
| `src-tauri/src/history.rs` | `open_folders` `:29` 与 `active_folder` `:31`、读取 `:67-69`、多根往返单测 `:206` |
| `src-tauri/src/settings.rs` | `workspace_mode` `:257`、默认 `multi` `:285` |
| `src-tauri/src/run/store.rs` | 运行配置按归一化工程根分节 `:35` |
