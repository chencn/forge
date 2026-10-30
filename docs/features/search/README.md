# 工作区搜索

三条入口，两种落点：一个居中的「随处搜索」弹层，一座底部「查找」工具窗口。照 IDEA 的
Search Everywhere 与 Find in Files 做，底下是 `src-tauri/src/fs/search.rs` 那两条只读命令加
`src-tauri/src/fs/symbols.rs` 那条按名字找定义的命令。弹层这一整套按 IntelliJ IDEA 的
搜索工程移植：取数编排、结果模型、本地匹配与打分、输入解析、落盘记忆
分别落在 `src/lib/seController.ts`、`seModel.ts`、`seMatch.ts`、`seRank.ts`、`seQuery.ts`、`seStore.ts`。

相关文件：`src/components/SearchEverywhere.tsx`、`src/components/FindPane.tsx`、
`src/components/MatchSnippet.tsx`、`src/lib/editorEnv.ts`、`src/lib/fs.ts`、
`src/hooks/useDocuments.ts`、`src/components/CodeEditor.tsx`、`src-tauri/src/fs/search.rs`、
`src-tauri/src/fs/symbols.rs`。
底部槽的位置规则见 `../shell-layout/`，命中怎么落进那一行见 `../code-editor/`，
树右键那一套见 `../file-explorer/`，命令的契约见 `../../backend/commands.md`。

## 入口

- 主工具栏在 运行 / 重跑 / 停止 之后一颗放大镜，开的是弹层。没有工程时 disabled：三条命令都要一个
  存在的目录，摆出去点了只会报错。再点一次收起。
- 双击 Shift 开弹层，落在全页签。这是 IDEA 那条键盘手势（`$default.xml` 的 `shift SHIFT`），
  这边取两次 keydown 间隔不超过 300ms，中间落了别的键就重新计。
- `Ctrl+Shift+N` 开同一个弹层，落在文件页签。IDEA 的 Go to File 不是另一个框，
  是 `GotoFileAction` 把同一个弹层摆到 Files 上，这边照做。
- `Ctrl+Shift+F` 开在文本页签，词取编辑器选区（`selectedText()`，对应 IDEA
  `FindUtil.initStringToFindWithSelection`：选区超过一万字符就当没选，压缩过的一整行灌进搜索框搜不出东西）。
- 目录树右键「在目录中查找」，见 `../file-explorer/`。
- 这三颗键是应用级的，不走编辑器的键绑定，默认 / IDEA / Eclipse 三个方案里都是同一套。
  `SHORTCUT_HINTS` 顶上三行就是它们，空态那张告示页照着画。
- 焦点在输入框里时双击 Shift 不响应，否则重命名框里连按两下会把弹层盖上去。编辑器那块输入面除外，
  它是编辑器本体，IDEA 在这儿照样生效——判定看 `.cm-content` 这个类，CodeMirror 的键面是 contenteditable
  的 div，不认它就会被「是不是输入框」那条误判掉。终端的辅助 textarea 不除外，那边敲的是 shell。

弹层每次打开都是一个新实例（`App.tsx` 用一个递增序号当 React key），页签、词、掩码都不带上一次的值。
IDEA 会记住上次的词，这边开弹窗时不预填，但每个页签打过的词都落进 localStorage
（`forge:se:searchHistory.v1`，一签 50 条封顶），Alt+↑ / Alt+↓ 在那个页签的历史里翻。

## 弹层

关掉它只有三条路：右上那颗关闭、Enter 或点开一条结果、Esc。点遮罩不关，输入到一半点到旁边就把词丢了。
IDEA 那边靠失焦关闭，这边没有「焦点离开整层」这条判定可依赖，就不拿点击当关闭。

六个页签，Alt+1…Alt+6，或 Tab / Shift+Tab 轮着走，页签焦点上左右箭头也轮换：
全页 / 类 / 文件 / 符号 / 动作 / 文本。底下七个数据分节，另加「最近文件」「最近执行」两档垫在空词页。

- 每节各查各的、各自收口：谁先答上来谁先进列表，不等别人（`SeController`）。空词只列最近那两档，
  一次后端都不打。
- 全页签一带词就把几档按相关度混成一张表，每档先只留 6 行（`ALL_TAB_LIMIT`）；单档每档 50 行。
  页尾那一行「更多」按档加量（全页 +15，单档 +50），加量只重查那一档，别档的结果原样留着。
- 类与符号同吃 `find_symbols`：类档只要类型（class / interface / struct / enum / trait / typeAlias /
  record / annotation / object / union）；符号档在全页签里把类型剪掉——那边已经有一整节类了——
  所以多要一半再筛。可调用符号的展示名带 `()`，行尾那格是所在文件名。
- 动作档不吃后端，拿 `paletteCommands` 那张表本地匹配：词对齐的排前面，散着逐字对上的只垫底，
  标签对不上但 id 包含的收进来给个低分，最近执行过的往上抬。
- 只有正文那一档少于 2 个字符不查，否则整棵树被第一个字母刷一遍。名字、符号、动作都没这个门槛。
  停止打字 260ms 才发查询。
- 大小写 / 整词 / 正则三颗开关和文件名掩码只在全页与文本两个页签画，它们只对正文有效。
- 输入 `/` 列出能跳的分节命令，`/fi` 能筛，`/files foo` 直接跳文件档并搜 `foo`（页签名不分大小写）。
  `File.kt:42`、`File.kt:42:5`、`Foo(42,5)`、带引号的、贴进来的绝对路径、`file://` 链接与 Windows
  反斜杠路径都认：剪掉地点后缀再拿去匹配，行号与列号挂在条目上，1 起。
- 只认最后一次发起的那一趟：每趟自增一个代号（`gen`），对不上现行代号的回话整份丢掉，不会盖掉新结果。
  这一层的后端命令是一次性 Promise，没有「取消」这回事，所以认账只看代号。
- 顶端没收口时按 Enter 先欠着（`pendingEnter`），结果一落地就补上那一次激活：IDEA 开的是新查询的
  第一条，不是上一轮还挂在屏上的残留行。
- 什么都没搜到、又还没勾「包括隐藏与忽略项」时，自己把闸门放开重查一遍（IDEA 同款）。
- ↑↓ / PgUp PgDn / Home / End 走选中行，跨过标题行，↑↓ 到头再绕；回车开选中的那条，
  Shift+Enter 在右侧拆分里开，页脚那颗「在右侧拆分中打开」是同一个动作；Esc 收起。
  选中行走出列表边缘时滚一下，只在键盘走的时候动。
- 底行先说选中那一条（路径、`文件:行`），报错时说的是后端那个原样错误串（`BAD_REGEX` 这类翻成人话），
  再往后按档列计数；后端 `truncated` 为真时追加「还有更多」，界面必须显式说这不是全部。

动作表在 `App.tsx` 的 `paletteCommands` 里拼：打开弹层、开类 / 符号 / 文件 / 文本页签、保存、保存全部、运行四件、
新建 AI 会话、打开设置与快捷键设置，再加底部面板与活动栏的入口。只收能独立执行的动作，
依赖当前选中的（关某个标签、重命名某个文件）不进表，点了没反应的条目比少一条更糟。
行尾显示当前生效的组合键，仅作提示，真正匹配仍在各自的 keydown 监听。

点开文件行只把它开进编辑区，光标不动，IDEA 的 Files 页就是这个行为（`offset = -1`）。
点开符号行跳进定义那一行，选中那一截符号名（长度取符号名本身）。
点开正文行除了跳进那一行，还把这一整页结果交给底部查找窗口：IDEA 那边 Enter 之后弹层关掉，
结果还留在 Find 窗口里，可以接着逐个跳。
按 Shift+Enter 或页脚那颗的这三类落点，开在编辑区右侧那一列拆分里；标签是异步登记的，
所以那个拆分请求先记在 `pendingSplit` 上，等它真出现在页签表里再补一刀。

三种落点都带着目录树一起走：侧栏收着就打开，停在 Git 面板就扳回资源管理器，再沿那条路径逐层摊开、
选中这一条并滚到它。目录那一条没有正文可开，落点全在树上，连它自己一起摊开。IDEA 的 Project 视图用
「Always Select Opened File」跟着编辑器走并滚动。这边蓝底只来自选中：切到别的页签后，如果只选中了另一个文件，选中拿掉，当前打开的文件不再另涂一档颜色。不自动展开，也不滚动。
树那侧的展开规则见 `../file-explorer/`。

## 作用域

三条命令的第一个参数就是一个目录的绝对路径，所以 IDEA 的 Look in Directory 不用新命令，换个 root 就行。

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
- 弹层输入框下面那颗「包括隐藏与忽略项」是这一趟的临时放宽：勾上就无视那两个设置，
  闸门整个放开（`{showHidden:true, ignored:[]}`）。什么也没搜到时界面自己勾上它重查一遍，
  所以「这个工程里没有」那句告示只会出现一次。

## 最近、打分与混排

IntelliJ IDEA 那侧的类与符号来自持久索引，这边没有等价物，靠 `find_symbols` 现扫 + 前端本地打分补平：

- 空词页那两档「最近文件」「最近执行」是 localStorage 里的表（`forge:se:recentFiles.v1` 50 条、
  `forge:se:recentActions.v1` 12 条）。最近文件由编辑区每次换页签补一笔，重复的挪到最前；
  落在当前根之外的旧路径照显示，只是目录格留空。
- 名字与动作没有后端打分，回来在本地现算（`seRank.ts` 的 `scoreIndices`，`src/lib/seRank.ts:60`）：
  全等 1000 > 前缀 800 > 连续 600−位置×2 > 驼峰 / 词首 400+起头数×10 > 散着逐字 200−跨度；
  每档最后再减去 `min(60, 名字长度)`（`src/lib/seRank.ts:73`），所以同档里短名获胜；
  从首个命中起原文照抄查询的大小写另加 5 分（`src/lib/seRank.ts:72`）。
  按空白切开的多词查询：整串对不上就逐词各算，取均分再减 50（`src/lib/seRank.ts:41`），任一词对不上整条不要。
  匹配器三档在 `seMatch.ts`：连着的一段、词首与驼峰的「山尖」、最松的逐字顺次。
- 全页签混排按这个分排，但每一档内部保持后端回来的顺序，所以权重被夹成非递增；
  正文那一档是固定一档 350 分，高于散着对上的名字、低于任何起头对上的名字。

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

「类」与「符号」那两档在 `symbols.rs`，它是现扫现抽，不是索引，代价得说清：

- 单个文件超过 2 MiB 不抽符号；一趟最多攒 80_000 条，触到这个上限或被条数截断时 `truncated` 为真。
- 按根缓存 60 秒（`CACHE_TTL`）：这一分钟内新建、改名、挪动过的定义查不到，命中的行号也可能是旧的。
  缓存整棵重扫才有新表，没有增量失效——文件监听不往这儿报。
- 抽定义靠逐行正则，规则全部以行首锚定：`// fn foo()` 这种行注释不会被收进来，但正则看不见注释的边界，
  块注释里自成一行的一条照样算定义（`symbols.rs` 的 `line_comments_are_skipped_but_block_comments_leak`
  把这个缺口钉在测试里）。IDEA 那边吃 PSI 索引不会这样。所以符号行只当「跳过去看一眼」的入口，
  别当某个文件声明清单的权威答案。
- 语言表与 `is_type_kind` 那一档种类，前后端各写一份、必须同步（`seModel.ts` 的 `TYPE_KINDS`
  就是 Rust `is_type_kind` 那张表）。

## 还没做的

替换、扫描中断、多趟结果并存、把弹层的掩码与开关记进历史、`find_symbols` 的增量失效
（文件监听不告诉符号缓存「这个文件变了」，只靠那 60 秒）、把 `SymbolHits.truncated` 透到弹层
（`SeDeps.findSymbols` 现在只回 `items`，整棵扫到 80_000 上限这件事界面还不知道）。
都在 `../../plans/global-search/`。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src/App.tsx` | `everywhere` 与 `find` 两份状态、`searchSeq`；`openEverywhere` / `openSearchFile` / `openSearchHit` / `openSearchSymbol` / `revealHit` / `revealInTree`；`pendingSplit` 那笔欠着的拆分；双击 Shift 与两颗组合键的那个 effect；编辑区换页签时补记「最近文件」；顶栏那颗按钮；`paneBody` 里的 `find` 分支；树右键的「在目录中查找」；`paletteCommands` 动作表；渲染弹层时把 `git.root` 与 `settings.explorer` 两个开关传进去 |
| `src/components/SearchEverywhere.tsx` | 六个页签与分节标题的译文、`SeController` 的装配、防抖与 `TYPE_DELAY`、`/` 命令列表与跳转、`File:42` 落点、三颗开关与掩码、「包括隐藏与忽略项」与它那次自动放宽、选中位（`stableIndex`）与欠着的 Enter、底行计数与告示、`listNavigate` 键位、按 kinds 画的一行 |
| `src/lib/seController.ts` | 取数编排：每节各查各的、`gen` 认账、`signatures` 不重查、`sectionLimit` 与多要一条、`TEXT_MIN_QUERY` 那道闸、整页 `TextPage` 留给底部窗口、`failed` 原样错误串、`recentFileItem` |
| `src/lib/seModel.ts` | 条目类型、`sectionsFor`、`fileItem` / `symbolItem` / `textItem` / `matchActions`、`itemWeight` 与 `mixItems` 的权重夹取、`buildRows`（标题行 / 「更多」行 / 混排）、`parseCommand`、`topResultSettled`、`stableIndex` |
| `src/lib/seMatch.ts`、`src/lib/seRank.ts` | 三档匹配器（连续 / 词首驼峰 / 逐字）、词对齐判定、四档打分与短名获胜、多词均分、稳定排序 |
| `src/lib/seQuery.ts` | `parseLocationQuery`：`:行` / `:行:列` / `行,列` 括号写法、引号、`file://`、反斜杠路径、按根剪相对出处 |
| `src/lib/seStore.ts` | localStorage 那三份表：最近文件（50）、最近执行（12）、每页签搜索历史（50） |
| `src/components/ExplorerTree.tsx` | `reveal` 入参与那条逐层摊开的 effect：`covers()` 连包链中间层一起认、`openDir` 只往开里改、`pathKey` 折分隔符与大小写；忽略判定复用 `ignoredRoots` |
| `src/components/FindPane.tsx` | 状态行、按文件分组、`truncated` 与 `skipped` 告示、双击与 Enter |
| `src/components/MatchSnippet.tsx` | 按 `snippetFrom` 把列号折算回片段内、零宽命中垫一个不换行空格 |
| `src/lib/fs.ts` | `findFiles` / `searchText` / `findSymbols` 三个封装与 `FileHits` / `TextPage` / `SymbolHits` / `SearchOptions` / `ScanFilter` 类型 |
| `src/lib/git.ts` | `gitIgnored` 与 `ignoredRoots`：把忽略清单折成绝对前缀，文件树染色与搜索剪枝共用 |
| `src/lib/editorEnv.ts` | `selectedText()`：取有文字焦点那台编辑器的选区（桥与空选区兜底在同文件） |
| `src/hooks/useDocuments.ts` | `openHit`（已开着的脏文件不重读磁盘）、`reveal` 状态与 `revealDone`、带 `at` 时把视图扳回源码 |
| `src/components/CodeEditor.tsx` | reveal effect：按真实行内容把字符列折算成 UTF-16 码元，落到行与选区并抢焦点 |
| `src/lib/keymapHints.ts` | `SHORTCUT_HINTS` 顶上三行搜索键位 |
| `src-tauri/src/fs/search.rs` | 阈值常量、`PRUNED_DIRS`、`score_name` 四档、`TextOptions`、片段截法、`skipped` 四类；单测 `scan_prunes_build_directories` 覆盖剪掉的目录 |
| `src-tauri/src/fs/symbols.rs` | 逐语言定义正则、`is_type_kind`、按根 60 秒缓存与 80_000 上限、`SymbolHits`；单测五条覆盖 TS 与 Rust 的抽取（缩进的 `fn` 记成 method）、Go、打分与类型档筛选、注释那道缺口 |
| `tests/lib/seMatch.test.ts`、`seRank.test.ts`、`seQuery.test.ts`、`seModel.test.ts`、`seController.test.ts` | 移植那五块的单测：三档匹配、打分排序、地点解析、结果模型与混排、编排的认账与重查 |
