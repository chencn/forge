# 工作区搜索

三条入口，两种落点：一个居中的「随处搜索」弹层，一座底部「查找」工具窗口。照 IDEA 的
Search Everywhere 与 Find in Files 做，底下是 `src-tauri/src/fs/search.rs` 那两条只读命令。

相关文件：`src/components/SearchEverywhere.tsx`、`src/components/FindPane.tsx`、
`src/components/MatchSnippet.tsx`、`src/lib/monacoEditor.ts`、`src/lib/fs.ts`、
`src/hooks/useDocuments.ts`、`src/components/CodeEditor.tsx`、`src-tauri/src/fs/search.rs`。
底部槽的位置规则见 `../shell-layout/`，命中怎么落进那一行见 `../code-editor/`，
树右键那一套见 `../file-explorer/`，两条命令的契约见 `../../backend/commands.md`。

## 入口

- 主工具栏在 运行 / 重跑 / 停止 之后一颗放大镜，开的是弹层。没有工程时 disabled：两条命令都要一个
  存在的目录，摆出去点了只会报错。再点一次收起。
- 双击 Shift 开弹层，落在全页签。这是 IDEA 那条键盘手势（`$default.xml` 的 `shift SHIFT`），
  这边取两次 keydown 间隔不超过 300ms，中间落了别的键就重新计。
- `Ctrl+Shift+N` 开同一个弹层，落在文件页签。IDEA 的 Go to File 不是另一个框，
  是 `GotoFileAction` 把同一个弹层摆到 Files 上，这边照做。
- `Ctrl+Shift+F` 开在文本页签，词取编辑器选区（`selectedText()`，对应 IDEA
  `FindUtil.initStringToFindWithSelection`：选区超过一万字符就当没选，压缩过的一整行灌进搜索框搜不出东西）。
- 目录树右键「在目录中查找」，见 `../file-explorer/`。
- 这三颗键是应用级的，不走 monaco 的键绑定，默认 / IDEA / Eclipse 三个方案里都是同一套。
  `SHORTCUT_HINTS` 顶上三行就是它们，空态那张告示页照着画。
- 焦点在输入框里时双击 Shift 不响应，否则重命名框里连按两下会把弹层盖上去。monaco 那块输入面除外，
  它是编辑器本体，IDEA 在这儿照样生效；终端的辅助 textarea 不除外，那边敲的是 shell。

弹层每次打开都是一个新实例（`App.tsx` 用一个递增序号当 React key），页签、词、掩码都不带上一次的值。
IDEA 会记住上次的词，这边没记，因为记了就要顺带处理「上次的词在这个工程里搜不出东西」那种情况。

## 弹层

关掉它只有三条路：右上那颗关闭、Enter 或点开一条结果、Esc。点遮罩不关，输入到一半点到旁边就把词丢了。
IDEA 那边靠失焦关闭，这边没有「焦点离开整层」这条判定可依赖，就不拿点击当关闭。

四个页签，Alt+1 / Alt+2 / Alt+3 / Alt+4 或点页签切换：全页 / 文件 / 文本 / 动作。IDEA 那边还有
Classes / Symbols，靠 PSI 符号索引，这边没有等价数据，不做；动作页签用前端自己的动作表，不依赖索引。

- 全页签同时发两条命令，文件名与正文各取前 20 条，混在一列里：文件行在前，正文行在后，动作行接在最后（最多 50 条）。
- 文件页签只发 `find_files`，此时大小写 / 整词 / 正则三颗开关和文件名掩码都不画，它们只对正文有效。
- 文本页签只发 `search_text`，带三颗开关与掩码。
- 动作页签不发查询：空词列出动作表前 50 条，有词时先匹配前缀、再匹配包含；回车执行并关闭弹层。
- 少于 2 个字符什么都不搜，否则整棵树被第一个字母刷一遍。停止打字 260ms 才发查询。
- 只认最后一次发出的查询：每次自增一个序号，早发的那份回来晚了直接丢，不会盖掉新结果。
- 底行说清这次拿到多少：`N 个文件` / `N 处命中，M 个文件`，触到上限追加「还有更多」。
  后端扫到条目上限或结果被截时 `truncated` 为真，界面必须显式说这不是全部。
- ↑↓ 走选中行，回车开选中的那条，Esc 收起。选中行走出列表边缘时滚一下，只在键盘走的时候动。

动作表在 `App.tsx` 的 `paletteCommands` 里拼：打开弹层、开文件 / 文本页签、保存、保存全部、运行四件、
新建 AI 会话、打开设置与快捷键设置，再加底部面板与活动栏的入口。只收能独立执行的动作，
依赖当前选中的（关某个标签、重命名某个文件）不进表，点了没反应的条目比少一条更糟。
行尾显示当前生效的组合键，仅作提示，真正匹配仍在各自的 keydown 监听。

点开文件行只把它开进编辑区，光标不动，IDEA 的 Files 页就是这个行为（`offset = -1`）。
点开正文行除了跳进那一行，还把这一整页结果交给底部查找窗口：IDEA 那边 Enter 之后弹层关掉，
结果还留在 Find 窗口里，可以接着逐个跳。

三种落点都带着目录树一起走：侧栏收着就打开，停在 Git 面板就扳回资源管理器，再沿那条路径逐层摊开、
选中这一条并滚到它。目录那一条没有正文可开，落点全在树上，连它自己一起摊开。IDEA 的 Project 视图用
「Always Select Opened File」跟着编辑器走并滚动。这边蓝底只来自选中：切到别的页签后，如果只选中了另一个文件，选中拿掉，当前打开的文件不再另涂一档颜色。不自动展开，也不滚动。
树那侧的展开规则见 `../file-explorer/`。

## 作用域

两条命令的第一个参数就是一个目录的绝对路径，所以 IDEA 的 Look in Directory 不用新命令，换个 root 就行。

- 从工具栏或键位打开时 root 是工程根，等价 IDEA 的 Project scope。
- 树右键那一项带过来的层按 IDEA 的 `FindInProjectUtil.setDirectoryName` 取：目录取自身，
  文件取父目录，空白处取工程根。取到工程根时把 scope 置空，不传那个路径本身，
  省得「在整个工程里搜一个子目录」这种既绕又和工程根不一致的写法。
- 弹层底部那句命中数是按这一层算的。IDEA 的 Module / Custom scope 这边没有对应概念，不做。
- 作用域不记忆。IDEA 有个 `ide.remember.last.search.scope` 开关，这边每次开弹层都回到工程根。

## 可见性

搜索跟资源管理器那两个开关走：设置里关了「显示隐藏文件」，隐藏项就不搜；关了「显示忽略的文件」，
被 `.gitignore` 忽略的范围也不搜。开着则照样搜。

- 剪枝在后端扫描层（`ScanFilter`），不是搜完再丢：这样隐藏项与忽略项不占条目数与命中数的预算，
  `truncated` 与计数才是「在看得见的东西里」的真实值。
- 忽略前缀由前端按仓库根折算成绝对路径下发（`git.ts` 的 `ignoredRoots`，与文件树染色共用一份），
  弹层只在「显示忽略项」关着时才去取这一份——这一趟要走完整棵工作树的 git，开着就不必问。
- 没有仓库（`repoRoot` 为空）时忽略清单为空，只有隐藏项那道闸生效。

## 查找结果窗口

`find` 是底部那一排的第五块（终端 / 运行 / Git 日志 / 查找 / 通知），照 IDEA 那座名为 Find 的工具窗口。
它只在点开正文命中时出现，自己不主动开。

活动栏下端没有它那颗入口，IDEA 也没给 Find 留活动栏入口。代价是：把它最小化之后，
只能再搜一条正文命中把它叫回来，没有单独一颗按钮可点。`BOTTOM_ORDER` 里有它（底部槽的排他、
切到页签栏都按这块走），`RAIL_BOTTOM` 里没有它，这两个名单不是一回事。

- 状态行左边回显这次搜的词，后面跟启用的开关与掩码，右边是 `N 处命中，M 个文件`。
- 命中按文件分组：文件名一行，下面每条命中一行，带行号和以首处命中为中心截出来的预览片段，
  片段里命中的那几段涂亮（`--accent-amber-bg`）。分组靠的是相邻判断，后端本来就是一个文件扫完才下一个。
- `truncated` 与 `skipped` 各出一条告示，跳过的文件数把太大、二进制、非 UTF-8、读不到四类合在一起计。
- 双击某一行或按 Enter 跳进编辑器，弹层不参与；查找窗口留着，可以接着跳下一条。
- 一次只显示一趟结果，重跑就地覆盖。IDEA 允许多趟结果以 tab 并存（看 `isShowResultsInSeparateView`），
  这边这条还没做，在 `../../plans/global-search/`。
- 扫描中不出现：结果是从弹层交过来的，弹层那边已经把扫盘这件事做完了。

## 后端给的约束

扫盘不建索引，一趟扫完就回，代价是自己刹车。这些闸门都在 `search.rs` 里，界面不能假装能绕过：

- 单次扫描最多访问 200_000 个条目，最深 24 层，单个文件超过 20 MiB 不逐行搜，
  开头 4096 字节里出现 NUL 判为二进制跳过。
- 一律剪掉 `.git` / `node_modules` / `target` / `dist` / `build` / `out`，不跟随软链。
  `dist` 是后来加的：前端打包产物里全是压缩过的一行代码，搜到的命中没有一条是人写的。
  这一条和文件监听「不排除 node_modules」是相反的取舍，监听只重读目录与 git 状态，搜索要逐文件读正文。
- 可见性闸门（`ScanFilter`）：`showHidden` 为假剪隐藏项、`ignored` 里那些绝对前缀之下的路径整棵剪掉，
  都并进 `filter_entry`。与固定剪枝的区别是它随设置变，代价是每条目录项多读一次自带 metadata 判隐藏位。
- 文件名匹配四档：4 全等、3 前缀、2 包含、1 逐字顺次出现，攒够 2000 条才停；
  排序是档位降序 → 路径短 → 字典序。先截会把高分的挤掉，所以截断在排序之后。
- 正文命中带 `line`（1 起）、`snippet`、`snippetFrom`（片段首字符在原行里的列号）和这一行所有
  `ranges{column, length}`，列号都按字符数算，1 起。一行里多处命中合成一条返回。
- 正则编不成时后端报 `BAD_REGEX`，不给你一张空结果页。

## 还没做的

替换、扫描中断、搜索历史（IDEA 的 Alt+Down）、多趟结果并存、文件名命中的高亮（IDEA 那边
后端会回匹配区间，`find_files` 只回档位，所以文件名的命中段涂不亮）、把弹层的词与掩码记进历史。
都在 `../../plans/global-search/`。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src/App.tsx` | `everywhere` 与 `find` 两份状态、`searchSeq`；`openEverywhere` / `openSearchFile` / `openSearchHit` / `revealHit` / `revealInTree`；双击 Shift 与两颗组合键的那个 effect；顶栏那颗按钮；`paneBody` 里的 `find` 分支；树右键的「在目录中查找」；`paletteCommands` 动作表；渲染弹层时把 `git.root` 与 `settings.explorer` 两个开关传进去 |
| `src/components/SearchEverywhere.tsx` | 四个页签、两路并发查询、动作表过滤与执行、`seq` 丢旧结果、底行计数、`MIN_QUERY` 与 `TYPE_DELAY`、键位处理；按需取忽略前缀拼 `ScanFilter` 下发 |
| `src/components/ExplorerTree.tsx` | `reveal` 入参与那条逐层摊开的 effect：`covers()` 连包链中间层一起认、`openDir` 只往开里改、`pathKey` 折分隔符与大小写；忽略判定复用 `ignoredRoots` |
| `src/components/FindPane.tsx` | 状态行、按文件分组、`truncated` 与 `skipped` 告示、双击与 Enter |
| `src/components/MatchSnippet.tsx` | 按 `snippetFrom` 把列号折算回片段内、零宽命中垫一个不换行空格 |
| `src/lib/fs.ts` | `findFiles` / `searchText` 两个封装与 `FileHits` / `TextPage` / `SearchOptions` / `ScanFilter` 类型 |
| `src/lib/git.ts` | `gitIgnored` 与 `ignoredRoots`：把忽略清单折成绝对前缀，文件树染色与搜索剪枝共用 |
| `src/lib/monacoEditor.ts` | `selectedText()`：取有文字焦点那台编辑器的选区（门面与空选区兜底在 `monacoEnv.ts`） |
| `src/hooks/useDocuments.ts` | `openHit`（已开着的脏文件不重读磁盘）、`reveal` 状态与 `revealDone`、带 `at` 时把视图扳回源码 |
| `src/components/CodeEditor.tsx` | reveal effect：按真实行内容把字符列折算成 UTF-16 码元，落到行与选区并抢焦点 |
| `src/lib/keymapHints.ts` | `SHORTCUT_HINTS` 顶上三行搜索键位 |
| `src-tauri/src/fs/search.rs` | 阈值常量、`PRUNED_DIRS`、`score_name` 四档、`TextOptions`、片段截法、`skipped` 四类；单测 `scan_prunes_build_directories` 覆盖剪掉的目录 |
