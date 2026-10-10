# 搜索剩下的几件

**状态**：`进行中`。入口、弹层、查找窗口、作用域、命中落点都已经做完并验过，
稳定部分在 `../../features/search/`，这里只留还没做的。
**涉及模块**：`search`（主）、`file-explorer`（树右键那条已经接好，替换要跟着改）、`code-editor`、`settings`；
后端 `src-tauri/src/fs/search.rs`，很可能要新增写命令。
**阻塞点**：替换需要一条能改盘的后端命令，而改盘和「编辑器那份赢」这条规矩正面冲突，取舍还没拍。

## 一、替换

IDEA 的 Replace in Path 是 `Ctrl+Shift+R`，和 `FindInPathAction` 同一族，
`ReplaceInPathAction.update` 直接复用后者的判定（`LI/find/actions/ReplaceInPathAction.java:17`）。

- 后端两条搜索命令都是只读的，一次扫完即回，没有任何写入通道。
- 冲突点：搜索结果里的文件可能正开在编辑器里且有未保存改动，而本项目定的规矩是编辑器那份赢，
  保存时才写盘（`../../features/workspace-watch/`）。直接往文件里替换会绕过这条规矩，把人手里那份覆盖掉。
- 两条路：A 落盘前逐条比对文件当前内容，和搜到那一份不一致就跳过并报告；
  B 只替换没打开的文件，打开着的要求先存或先关。A 更像 IDEA，B 更少惊喜。倾向 B，先拍这个。
- 验收：选中文本按 `Ctrl+Shift+R` 能带词开替换面板；逐条预览改哪几行；
  替换完文件树与编辑器同步；正在编辑且脏的文件不动它并说明为什么没改。

## 二、扫描能不能中断

一次搜索就是一趟全树扫描，没有取消句柄。改一个字扫一遍，打字快的时候连着扫十几遍，
现在只靠 260ms 去抖压住，仍然没有「这版我不要了」的通道。

- 方案是在后端给每个搜索挂一个可取消的句柄（和终端会话那张表同样的路子），前端换词时先取消上一趟。
- 也要定「取消」算不算一次失败：现在 `seq` 令牌只是丢结果，扫盘那趟还在跑完才回。
- 验收：连打十个字符，磁盘上没有十趟全扫；后台线程数不随打字涨。

## 三、历史与记忆

IDEA 那边有三样记忆：搜索词历史（`Alt+Down` 的 ShowSearchHistory，
`FindUsagesManager.addToHistory`）、文件掩码历史（`FindSettings.getRecentFileMasks`）、
以及作用域记忆开关 `ide.remember.last.search.scope`（`FindInProjectUtil.java:110-117`）。
这边一个都没有：弹层每次打开都是空的，词、掩码、作用域都不带上一次的。

- 词与掩码历史存哪：本项目的 `history.json` 里已经有 `recentFolders` / `recentBranches` / `commitMessages`
  三条各留 8 条的先例，加 `searchQueries` 与 `searchMasks` 是同一形状，不用新机制。
- 键位：`Alt+Down` 在输入框里给下拉，不与现有键位冲突（`Ctrl+Alt+P` / `Ctrl+Alt+M` 是分组依据）。
- 作用域记忆要拍：记住上次搜过的那一层，还是每次回工程根。IDEA 是可选项，这边先只做「不记」。
- 验收：搜过的词下次 `Alt+Down` 能选到；掩码同理。

## 四、多趟结果并存

IDEA 的 Find 工具窗口可以同时摆好几趟结果，各是一个 tab，
由 `FindSettings.isShowResultsInSeparateView()` 和弹层那颗 "Open in new tab" 决定新开窗还是就地换
（`FindPopupPanel.java:930`）。这边 `find` 那块窗口一次只装一趟，重跑就地覆盖。

- 本项目已经有「页签栏可以并存、底部槽一次只坐一块」这套位置规则（`../../features/shell-layout/`），
  多趟结果最自然的做法是每趟一个 `pane|find-<n>` 页签，而不是自己再造一套 tab 条。
- 要先解决的是命名：IDEA 的 tab 标题是「查找 \'词\' - 掩码」这个形状（`FindInProjectUtil.java:371-392`），
  光叫「查找」分不出哪是哪。
- 验收：连搜两次能各留一个结果页签，标题能看出词与掩码，关掉一个不影响另一个。

## 五、文件名的命中高亮

IDEA 的文件名命中也把匹配片段涂亮，做法是后端回区间：`MinusculeMatcher.calcMatchedRanges`
算好后随 `SeTargetItemPresentation` 一起交给界面（`SEW/shared/src/presentations/SeTargetItemPresentation.kt:132-186`）。
这边 `find_files` 只回一个 `score` 档位，所以弹层里文件行涂不亮，正文行才有高亮。

- 要给 `FileHit` 加一个 `ranges`，用和正文一样的字符列基准，免得两边列号口径不同。
- 顺手能定的：文件行要不要把匹配段所在的名字部分和容器路径分开涂（IDEA 是分开算两段的）。
- 验收：搜 `refmenu` 时 `refMenu.ts` 里被匹配的那几段是亮的，且和 `MatchSnippet` 的折算规则一致。

## 六、多行选区

`Ctrl+Shift+F` 预填选区这条照 IDEA 做了，但多选了几行会把带换行的整串当搜索词送进去，
后端按一行一行匹配，必然搜不到。IDEA 有 `ide.find.escape.selected.text.for.regex` 与多行模式来处理这一类。
先拍：多行选区只取第一行，还是直接不预填。

## 出处

| 位置 | 内容 |
| --- | --- |
| `src-tauri/src/fs/search.rs` | 两条只读命令与全部扫描闸门；模块头注释写明扫盘不建索引这条设计 |
| `src/components/SearchEverywhere.tsx` | `seq` 丢旧结果、`TYPE_DELAY`、三个页签；替换与历史要加的东西都落在这个文件 |
| `src/components/FindPane.tsx` | 一次一趟结果的形状 |
| `src/App.tsx` | `openEverywhere` / `openSearchHit` / `find` 状态与那三颗键位 |
| `docs/features/search/README.md` | 已经做完的那部分，本文档不重复 |
| IDEA `platform/lang-impl/src/com/intellij/find/` | `ReplaceInPathAction`、`FindPopupPanel`、`FindInProjectUtil`、`FindSettings`，本文各条的对照出处 |
