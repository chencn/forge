# 一个窗口常驻多个工程文件夹

**状态**：`待验收`。前后端代码与单测均已落地，第 10 节 5 项待拍板点已按确认口径完成实现。
**涉及模块**：新增 `workspace-tabs`；改动 `file-explorer`、`commit-panel`、`git-log`、`run-and-terminal`、
`lsp-language-servers`、`settings`、`notification-center`；后端 `src-tauri/src/watch.rs`、`src-tauri/src/history.rs`、`src-tauri/src/settings.rs`。
**阻塞点**：无阻塞，待界面人工验收。

## 一、背景

现在是单工程：App 里一个 `workspaceRoot`，切文件夹走一整套 destroy-all——收终端、dispose 所有 Monaco
model、关掉全部文档、清比对与查找结果。用户参照的是 Qoder 自身的切工程体验：切工程不该换窗口、不该重载，
而重载式切换会连带杀掉后台的终端会话和运行任务，这正是要消灭的东西。

目标拆成三条硬要求：

1. 一个窗口里同时常驻多个文件夹，点一下就切过去，不重载。
2. 切过去时编辑区页签整套换成那个文件夹的；**唯一例外是设置页，跨文件夹保留**。
3. 切走的那个文件夹，它的终端会话与运行任务必须在后台继续活着，不能被杀。

## 二、已做（底子，别在同一条路上重造一遍）

后端这几处**天然支持多根，零改动**：

- 终端会话表是 `OnceLock<Mutex<HashMap<String, Arc<Session>>>>`，键是自增 `term-N`，**不按 root 分组、与会话所属
  文件夹无关**；`term_close(id)` 只杀指定那一条；`term_reap` 无参数、全清，但只在启动时调一次，用途是收上一回
  页面重载留下的残留，跟切根无关。Windows 走 `portable_pty` + ConPTY。无会话数上限、无闲置超时杀。
- 运行进程表同构：`HashMap<String, Arc<Running>>`，键 `proc-N`，`cwd` 只是启动参数不入键；只有 `proc_kill(id)`
  单杀，`reap_all_for_exit` 仅在应用退出时跑。
- git 每条命令第一个参数就是 root，统一经 `ensure_root` 校验后 `git -C <root>`；唯一的跨调用缓存是 probe 结果，
  键是归一化路径，每根各一条。写操作那把全局锁只防 `.git/index.lock` 撞车，多根并发写是排队不是串味。
- 权限侧没有 `tauri-plugin-fs`，读写全走自定义命令、接受任意路径；asset 协议 scope 配的是空 allow，全靠运行时
  `fs_allow_asset` → `allow_directory(root, true)`，**累积式、不撤销**，所以新根授权不会让旧根的图片失效。
- `History` 结构体级带 `#[serde(rename_all = "camelCase", default)]`，缺字段回落 `Default`，已有单测钉住「旧文件
  缺字段照样读」——加字段不需要迁移。
- 运行配置的存储本来就是多根模型：`BTreeMap<String, ProjectRunState>`，键是归一化工程根。
- 窗口层面：单窗口、label 硬编码 `main`、没装单实例插件；关窗口按设置要么藏进托盘（进程与监听都不受影响），
  要么存盘后 `app.exit(0)`——只有后者会触发那三处 reap_all，跟切根无关。

前端这几处也已经按绝对路径隔离，多根可直接共用，**只要不去主动清它**：

- 文档集合以绝对路径为唯一键，显示名只取路径尾段，保存按绝对路径直写，不做相对裁剪。
- 页签 id 带类型前缀 + 绝对路径（`doc|<path>`），天然跨根唯一。
- Monaco 的 model URI 是 `monaco.Uri.file(path)`，不同根的 model 本来就能并存；`disposeModel(path)` 支持单点释放。
- 终端 store 是模块级的多会话数组，`needTermSession(cwd)` 按 cwd 复用，换根只是换「看着的那条」。
- 目录树换 root 会自己重置懒加载缓存与展开态（这条是「重载」的来源，见方案第 9 条）。

界面事实与预览脚手架：

- 顶栏结构、每颗控件的 class / 图标尺寸 / 可见条件都已在代码里核实（见出处表），**折叠那颗的位置不动**。
- `.tmp/preview.html` + `.tmp/preview.jsx` 是预览脚手架：直接 import 本仓库的 `styles.css`、`tokens.css`、
  lucide 图标、`RunIcons.tsx`、`lib/runIcons`、`Popover`、真实 `icon.svg`，起 dev server 后自己截图比对。
  它不属于产品代码，改界面形态时在里面加一块对比，不要另起一份手绘稿。

## 三、方案

### 1. 界面形态（已定，不得改）

工程芯片仍是现在那一颗（`PanelTop` + 名称 + `ChevronDown`），多根模式下在名称右边挂一颗计数徽标，
**整颗一起点**，计数徽标不是第二颗按钮。弹层用现成 `Popover`，在「最近项目」上方加一组「已打开」，
行结构与「最近项目」完全同构：`FolderOpen` + 完整名称 + 等宽小字路径（路径在 `.popover-item-detail`
里是常显的，不是只作悬停）。单根模式下计数徽标和「已打开」组都不出现，顶栏与弹层和现状零差异。

已否决、不得再进稿子的零件：

- 顶栏下方独立一行项目标签（占垂直空间、与文件页签同族易混）。
- 侧栏面板顶部的工作区横条；图标上叠首字母角标与色相（名称已经全显，缩写是多余信号）。
- 把折叠那颗挪进 44px 标记格或挪进活动栏。
- 顶栏一排常驻工程芯片（宽度随根数线性增长）。

### 2. 状态模型

`workspaceRoot: string | null` 换成 `openFolders: string[]` + `activeFolder: string | null`。
「有任一根」就够的判定（运行区 enabled、搜索按钮 disabled、欢迎页、LSP 状态条是否显示）一律改成
`openFolders.length > 0`。

必须按根拆成 `Map<root, …>` 的：文档集与 `activePath`、`tabOrder` 与 `activeTab`、比对页签与比对链、
查找/替换状态与结果、通知（见第 8 条）、资源管理器选中项、底部面板的位置与停靠形态、git 快照（若要后台根的
变更数也准）。

天然共用、不要拆的：Monaco model 与编辑器实例、终端会话表、运行进程表、asset 授权、设置页签。

### 3. 切根与关根

`openFolder` / 弹层选中 / `closeFolder` 三处 destroy-all 拆成两个动作：

- `activate(root)`：只换上下文。不 dispose model、不 closeAll、不收终端、不清比对与查找。
- `closeRoot(root)`：只销毁这一个根的东西——它的终端会话、它的运行任务、它的 LSP 会话、它的 model 与文档。
  有未保存文档先问；有任务在跑要明说「终端会话与运行任务会一起结束」。设置页签不属于任何根，不能被连带关掉。

### 4. 后台不杀（三条杀手逐个去掉）

1. 换根不再调 `dropTermSession()`——它遍历前端全部会话逐条 `termClose`，是把别的根的 shell 一起杀掉的那一刀。
2. `useRunSessions` 里那条依赖 `cwd` 的 effect——换根会把所有 running 会话逐个 `procKill` 并清空缓冲，
   改成按根保留（会话要记住自己属于哪个根，缓冲也按根存）。
3. `reconcileLsp` 见第 6 条。

### 5. 文件监听要动 Rust

`WatchSlot` 现在是 `Mutex<Option<ActiveWatch>>` 单槽，`fs_watch_start` 里覆盖赋值会直接 drop 掉旧句柄，
换根后旧根的磁盘事件彻底收不到。改法：

- 槽换成按 root 索引的集合，start 是「插入或替换该根」，stop 只删该根。`ActiveWatch` 本身已带 root。
- 事件体 `FsChange` 加 `root` 字段，emit 时带上；前端 `useFileWatch` 从「一份全局订阅」改成按 root 分诊到对应根。
- 攒批的 `pending` 是每条 watcher 自己的 pump 线程局部，不是全局表，多根之间不会互相污染，不用动。
- 改名事件 notify 会同时报新旧两条路径，现有实现把两条都收进批里、按整串去重，多根后维持原样即可。

### 6. 语言服务对账

会话键本来就是 `server id + 归一化 root`，每根一条，能共存。要改的是对账口径：

- `reconcileLsp` 的入参从「一个 root + 该根的文档」改成「按根分组的文档集」，让每个根各自成组。
- 「不在本次 groups 里就 stop」改成「只 stop 被显式 `closeRoot` 的根的会话」。
- 文档归属哪个根不能再拿唯一的 workspaceRoot 去问后端，要用文档自己的路径解析，否则会把 B 根的文件按 A 根
  去找标志文件，起出错会话或误判成 no-root。
- no-root 的 `skipped` 键现在用工程根且 `retryAt = ∞`，来回切根会把一次「没查到」永久钉死——键要换成解析出的
  子根，重试时间戳不能无穷。
- `rootsScope` 目前 root 一变就整表 clear，改成按根保留备忘。
- 状态条那份会话列表本来就是全窗口的（每条自带 root），多根后要按激活根过滤或分组，否则计数串味。

### 7. 持久化

`History` 加 `openFolders: string[]` + `activeFolder: string`（Rust struct 一处、TS 类型一处）。因为结构体级已经
带 `#[serde(default)]`，老配置读进来自动是空数组/空串，不需要迁移。启动时用 `openFolders` 决定恢复哪几个根、
哪个是激活的；`lastFolder` 与 `recentFolders` 语义不变。

### 8. 通知按来源根写回

现在内存里只装激活根那份，且写回永远写激活根的 key——后台根产生的通知会落进当前根的存储。改成
`updateNotifications(root, updater)`，展示按激活根过滤，跨根未读数另算。

### 9. 常驻的实现方式（关键取舍）

「不重载」要求非激活根的东西**留在 DOM 里**，用 `hidden` 而不是卸载。三个必须跟着重算的点：

- 编辑器只有一台实例且开了 `automaticLayout`，切根时不能卸载它，否则装订线上的运行箭头 measure 失效；
  保撤销栈与光标的前提同样是别卸载。
- 终端容器宽度归 0 会把 ConPTY 弄死，现有实现靠「宿主小于 20px 就直接 return」挡；重新显示时必须重算
  fit 的 cols/rows 并同步回 PTY，重挂还要 `term.reset()` + 全量重放缓冲。
- 目录树换 root 现在会清懒加载缓存并重置展开态——要做到不重载，缓存得按根留一份。

分隔条与面板尺寸是拖动写行内样式、松手落 state，切根不应重置。

### 10. 已拍板结论

- **「已打开」列表行状态点**：**要**（绿点 = 该根有运行中的任务或存活的终端会话，蓝点 = 该根有未保存改动）。
- **计数徽标**：**多于一个要显示数字**（仅在多工作区模式且 `openFolders.length > 1` 时显示 `.ws-count` 数字徽标与弹层「已打开（{n}）」分组；只有 1 个根或单工作区模式时不显示）。
- **多根切回单根模式时非激活根的处理**：**不询问、也不关闭后台根**（后台根及其页签、终端、运行任务保留在内存中，只是前端隐藏多工作区 UI；切回多工作区或重选该根时原样恢复）。
- **同名文件页签消歧**：**按默认**（保持取路径尾段 `basename`，因为页签本身已按根隔离不会并排显示不同根的页签）。
- **LSP 进程策略**：**只加载当前激活项目的 LSP，未激活项目的 LSP 自动回收**（切根时保留 `roots` 解析缓存以加速重连）。

## 四、未做与验收

1. 顶栏改造：开两个根，工程芯片名称右边出现计数徽标；点开弹层，「已打开」组排在「最近项目」上方，
   当前项加粗，行内路径常显。切到设置里选「单工作区」，顶栏与弹层与改造前逐像素一致（用预览页两块对比截图核）。
2. 切根不重载：在 A 根打开 3 个文件、滚到中间、改一个字不保存；切到 B 再切回 A——3 个页签还在、顺序不变、
   光标与滚动位置还在、未保存标记还在、撤销一次能撤掉刚才那个字。
3. 后台不杀：A 根跑一个持续输出的任务并开一个终端，切到 B 根等 30 秒——A 的任务输出仍在增长（切回 A 看运行
   面板尾部有新行）、终端页签仍在且能输入；B 根里执行停止操作只影响 B 自己的会话。
4. 关根范围：接上一条，`closeRoot(A)` 后只有 A 的终端、任务、LSP 进程消失，B 的三者都还在；A 有未保存文档时
   先弹确认；设置页签不被关闭。
5. 监听多槽：B 根激活时，在资源管理器外面用命令行改 A 根里的一个文件——A 的目录树与已打开文档也要收到变更
   （现在收不到）。A 根里改名后，树里不留旧路径的条目。
6. LSP 不重启：两个根都打开过 Java/TS 文件后，用任务管理器/`ps` 看两个根的 server 进程 pid，来回切根 5 次，
   pid 不变。
7. 恢复：开着 3 个根退出应用再启动，3 个根都回来、激活的是上次那个；用一份改造前生成的 `history.json` 启动
   不报错（新字段走 serde 默认值）。
8. 命令：`npm run check:ts`、`npm run test:front`、`npm run check:rs` 全绿。Rust 侧单测在本机 `cargo test`
   跑不起来（测试二进制 0xc0000139），新增逻辑用独立 `rustc --test` 单文件验证。
9. 回归自查（改完必须逐条过，编译绿不算完工）：App 里所有读 `workspaceRoot` 的点按出处表那份清单逐条核对，
   漏一个就是「切过去了但显示上一个根的数据」；重点看提交补丁落点、文件历史、加进 .gitignore、右键在目录里
   查找、编辑器装订线运行配置这几处用的是「文档所属根」而不是「激活根」。
10. 本仓库没有已提交的基线：HEAD 只有 `.gitignore`，全部代码只存在于 index 与工作区。禁止用
    `git checkout` / `reset --hard` / `stash` 来「恢复」，那等于删代码。

## 五、出处

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `src/App.tsx` | `workspaceRoot` 单值 state 与初值 | `:253-255` |
| `src/App.tsx` | `openFolder` / `closeFolder` 两处 destroy-all | `:983-1012`、`:1014-1029` |
| `src/App.tsx` | ProjectPicker `onPick` 第三处 destroy-all、`onCloseProject` | `:2647-2666` |
| `src/App.tsx` | LSP 对账 effect、`wakeLspServer`、`lspKick` | `:416-442`、`:250` |
| `src/App.tsx` | 通知读写用激活根 | `:258-280`、`:265-274`、`:302`、`:343` |
| `src/App.tsx` | `useGitState` / `useRunConfigs` / `useFileWatch` / `allowAssetDir` / `lastFolder` 落盘 | `:370`、`:551-552`、`:683`、`:570-573`、`:566-568` |
| `src/App.tsx` | 页签目录与顺序、`tabCatalog` 名称取尾段 | `:2143-2195`、`:2198-2221`、`:2237-2283` |
| `src/App.tsx` | 终端面板与页签传激活根 | `:2299`、`:2354` |
| `src/App.tsx` | 工具窗口标题、树、GitPanel、设置页、DocPane `projectRoot`、搜索、状态条 | `:2797-2800`、`:2938-2940`、`:2959-2979`、`:3082`、`:3099`、`:3229-3233`、`:3198` |
| `src/App.tsx` | `repoRelative` 用激活根的 git.root 裁路径；分隔条尺寸落 state | `:1446-1452`、`:539-542`、`:3015-3034` |
| `src/App.tsx` | 侧栏宽初值与拖拽下限 180 | `:496`、`:3026-3027` |
| `src/components/TitleBar.tsx` | 顶栏 DOM 顺序、收起时工程与分支不画 | `:58-124`、`:86-88` |
| `src/components/ProjectPicker.tsx` | 芯片结构与弹层内容 | `:38-57`、`:59-109` |
| `src/components/BranchPicker.tsx` | 分支芯片与同步角标；没仓库时的另一颗 | `:337-355`、`:370-395` |
| `src/components/RunControls.tsx` | 运行配置下拉、运行那颗的两态、停止只在有实例时存在 | `:183-201`、`:310-336`、`:337-361` |
| `src/components/EditorTabs.tsx` | 页签 markup、脏时关闭位显示圆点、右端只有保存那颗 | `:124-191` |
| `src/components/Popover.tsx` | 贴锚点定位、GAP 4、minWidth 取锚点宽与显式值的较大者 | `:26-70`、`:78-110` |
| `src/components/TerminalPane.tsx` | xterm 与 fit 的创建销毁、0×0 挡法、重挂 reset + 重放 | `:79-131`、`:105-116`、`:134-200` |
| `src/components/TerminalTabs.tsx` | 订阅全部会话不按 cwd 过滤 | `:31`、`:42-45`、`:70` |
| `src/components/CodeEditor.tsx` | 单实例、`automaticLayout`、装订线箭头 measure | `:99-157`、`:105`、`:275-324` |
| `src/components/DocPane.tsx` | 切预览用 hidden 不卸载 | `:88-104` |
| `src/components/ExplorerTree.tsx` | 换 root 清缓存与展开态 | `:107-110`、`:230-232`、`:435-437` |
| `src/components/LspStatusBar.tsx` | workspace 只当开关用，列表是全窗口会话 | `:64-66`、`:80-89` |
| `src/hooks/useDocuments.ts` | documents/activePath、dirty、closeAll、reveal | `:31-67`、`:89-92`、`:461-474` |
| `src/hooks/useRunSessions.ts` | 依赖 cwd 换根即杀全部任务并清缓冲 | `:129-145`、`:161` |
| `src/hooks/useFileWatch.ts` | 全局订阅一份 `fs://change`、cleanup 按 root+gen 停 | `:17-62`、`:38-46`、`:53-61` |
| `src/hooks/useGitState.ts` | 单根快照与刷新闭包 | `:70-73`、`:101-105`、`:212-214` |
| `src/hooks/useRunConfigs.ts` | 换根重读与重扫、按根写盘 | `:27-30`、`:71-87`、`:115-125` |
| `src/lib/termStore.ts` | 模块级多会话、`dropTermSession` 全清、按 cwd 复用 | `:6-11`、`:30-31`、`:157-174`、`:195-204`、`:210-226` |
| `src/lib/monacoEditor.ts` | model URI 按绝对路径、`disposeModel` / `disposeAllModels`、theme 同步 | `:96-107`、`:141-201` |
| `src/lib/lspClient.ts` | 会话键含 root、`reconcileLsp` 单根入参、stop 掉不在本次 groups 的会话、`skipped` 键与 `retryAt` | `:33-50`、`:128-133`、`:926-938`、`:952-1016`、`:992-998`、`:970`、`:973-982` |
| `src/lib/lsp.ts` / `src/lib/term.ts` | `lspReap` / `termReap` 只在启动调用 | `lsp.ts:96-103`、`term.ts:60-63` |
| `src/lib/fs.ts` | `allowAssetDir` 无撤销语义 | `:145-148` |
| `src/main.tsx` | 启动时 reap 终端与语言服务残留 | `:23-29` |
| `src/styles.css` | 顶栏各条、芯片、弹层、页签、状态栏 | `:50-204`、`:342-520`、`:1716-1888`、`:2135-2146`、`:2472-2598`、`:3480-3498` |
| `src/i18n/lang/zh.ts` | 工程 / 最近项目 / 打开文件夹… / 关闭文件夹 / 源代码管理 / 设置 等文案 | `:129-137`、`:138`、`:146`、`:176-186`、`:260`、`:275`、`:418` |
| `src-tauri/src/watch.rs` | `WatchSlot` 单槽、start 覆盖赋值 drop 旧句柄、`FsChange` 不带 root、pump 局部攒批 | `:28-55`、`:82-138`、`:153`、`:174`、`:218-234` |
| `src-tauri/src/term.rs` | 会话表与键、`term_close` 单杀、`term_reap` 全清、ConPTY、无上限无超时 | `:5`、`:33-38`、`:147-182`、`:197`、`:244-248`、`:309-336` |
| `src-tauri/src/proc.rs` | 进程表与键、`proc_kill` 单杀、退出才 reap_all | `:30-35`、`:116-138`、`:161`、`:198-230`、`:257-284` |
| `src-tauri/src/git/mod.rs` | 每命令收 root、`ensure_root`、probe 缓存按路径分键、写锁 | `:199-202`、`:219`、`:281`、`:337-398`、`:588`、`:712-721` |
| `src-tauri/src/fs/mod.rs` | `fs_allow_asset` 累积授权 | `:592-600` |
| `src-tauri/src/history.rs` | `History` 字段与结构体级 serde default、load/save、缺字段单测 | `:18-34`、`:71-116`、`:185-190` |
| `src-tauri/src/run/store.rs` | 运行配置按根分节存储 | `:34-48` |
| `src-tauri/src/lib.rs` / `src-tauri/src/tray.rs` | 单窗口 label main、关闭行为、退出时 reap_all | `lib.rs:24-38`、`:149-171`、`tray.rs:79-129` |
| `src-tauri/tauri.conf.json` / `capabilities/default.json` | 窗口与权限声明、asset scope 空 allow | `tauri.conf.json:13-34`、`default.json:5-17` |
| `docs/plans/README.md` | plans 文档格式与流转规则 | 全文 |
