# 中英词典与 Provider

一份手写词典加一个 React Provider，没有 i18n 依赖、没有 ICU 消息格式（`src/i18n/index.tsx`）。中英两份扁平字典
（`src/i18n/lang/zh.ts`、`src/i18n/lang/en.ts`），键数随词条增删而变。键集由中文那份定义：`zh` 是 `as const`，
`TranslationKey = keyof Dictionary`（`Dictionary = typeof zh`），`en` 声明成 `Record<TranslationKey, string>`。
漏翻一个英文键就是编译错误。这是整套设计里唯一的完备性保证，也是不引第三方包的原因：两份扁平字典能装下的东西，
不需要一个运行时引擎。

`t(key, vars)` 只做一件事：取模板、把 `{token}` 换成传进来的值。缺失键回退到键名本身，宁可看见 `git.commit` 也不要空白。
`useI18n()` 在 Provider 外面直接抛错。Provider 顺带把 `document.documentElement.lang` 写成 `zh-CN` / `en`，
并把 `locale`（`zh-CN` / `en-US`）一起给出去，供 `Intl` 用：提交面板的增删行数（`new Intl.NumberFormat`）、日志里的日期
（`GitLogPane`）、「今天 / 昨天」那种相对日期（`lib/format.ts` 的 `commitStamp`）。切语言连数字和日期格式一起切，不只是文案。

## 语言从哪来

`settings.json` 里的 `language`，类型是 `"zh" | "en" | ""`，空串表示跟随系统，默认就是空串（`lib/settings.ts`）。
`resolveLang` 收到不是 `zh` / `en` 的任何值都当没写过，退回按 `navigator.language` 小写后是否以 `zh` 开头判。
设置页那把下拉只有两档（简体中文 / English，`SettingsPage`），显示的是解析后的语言，所以动过一次下拉就把 `language`
写成显式值、跟随系统这条路从此断掉：下拉里没有「跟随」这一项，选了哪档就显示哪档。切换走 `setLang` → `patch({ language })`
→ 整份写回文件（`hooks/useSettings`）。

## 界面即时、编辑器要重开窗口

Provider 换 `lang` 就重渲染整棵 React 树，界面其余部分当场切换。Monaco 不行，它在模块求值时就把自己的文案固化了，
语言表必须先进去。所以入口 `src/main.tsx` 的次序是硬的：先 `loadSettings()`，`resolveLang` 判出是中文就
`import("monaco-editor/nls/lang/zh-cn.js")`（那份文件只把 `globalThis._VSCODE_NLS_MESSAGES` 写成中文），然后才动态
import `App` 与 `SettingsProvider`。顺序反了就赶不上 monaco 固化文案那一刻。这条约束写在 `main.tsx` 的注释里，也在设置页那句
提示里：「编辑器内置菜单的语言在重新打开窗口后生效」（`zh.ts` 的 `language.note`，渲染处 `SettingsPage`）。同一个入口里还先
`termReap()` 再 import monaco，是因为终端一挂载就会开新会话，那条清理晚了就来不及。

## 后端错误文案在前端

Rust 侧只发「稳定代码加原文片段」，中间用 `\u0001` 分隔（`src-tauri/src/error.rs`，`err` 一段细节、`err_parts` 按序多段），
前端按当前语言拼成人话（`lib/errors.ts`）。不在 Rust 里写好文案，是因为后端写死中文后，切到英文界面底部横幅还是中文，
而且同一条错误在两端没法共用一份措辞，改一句话要改两个仓库位置。

`describeError` 的规则：不含 `\u0001` 的文本原样返回（前端自己抛的 `Error.message` 走这条）。认不出的代码退化成把各段用空格
拼起来，多半是两端没同时更新，把话说全比猜一句更有用。带数字的那条 `TOO_LARGE` 在这边把字节数说成人话（`humanBytes`：
≥1 MiB 给一位小数的 MB、≥1 KiB 给取整的 KB）。上限 8 MiB 是后端常量 `EDITOR_CEILING`（`src-tauri/src/fs/mod.rs`）。

同一套文案过 `describeError` 落到七处：右下角的通知气泡（`App` 的 `reportError`）、比对标签正文顶部的说明（`App` 给
`DiffPane` 的 `notice`）、文档正文中央的说明（`DocPane` 的 `PaneNotice`）、目录树某一行下面（`ExplorerTree`）、
随处搜索弹层里那句失败原因（`SearchEverywhere`）、终端缓冲里一行红字（`TerminalPane`，ANSI `\x1b[31m` 包起来）、
运行面板那行状态（`useRunSessions`）。

git 自己的 stderr 原样显示、不翻译（`errors.ts` 的 `GIT`）：它已经带 `error:` / `fatal:` 开头，再套一层只会重复一遍。
命令跑失败但一个字都没输出时才给那句兜底的「git 命令没成功」（`error.gitBare`）。

## 托盘菜单

托盘那两项不是 DOM，是原生菜单，`t()` 管不到它。所以由前端把当前语言的文案推进去：`App` 在 `t` 变化时调
`setTrayLabels(t("tray.show"), t("tray.quit"))`（`lib/window.ts`），落到 `tray_labels` 命令改那两个 `MenuItem` 的文字
（`src-tauri/src/tray.rs`）。两个事实值得记：建托盘时写的是英文 `"Show Forge"` / `"Quit"`，所以前端推过去之前那一小段是英文；
`setTrayLabels` 的失败被 `catch` 掉，纯浏览器跑前端时托盘文案就一直停在英文。Rust 侧也不写死中文，跟错误文案是同一回事，
写死了切到英文界面后托盘还是中文，而这两处都在应用外面的系统表面上，前端看不见。

## 已知边界

- monaco 只有 `zh-cn` 一份语言表，其它语言下编辑器内置菜单保持英文（`src/main.tsx` 只在 zh 时 import）。
- 后端有两条代码还没有对应文案：`BAD_MODE` 与 `BAD_SIDE`（`src-tauri/src/git/mod.rs`），落到前端就是那个裸的非法值本身
  （`describeError` 的退化路径），不带上下文。
- 开发者日志不进词典：`lib/keymap.ts` 那句 `console.error` 是硬编码中文，只在控制台出现。
- 托盘 tooltip 写死 `"Forge"`（`tray.rs`），那是应用名不是句子。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src/i18n/index.tsx` | `Lang` 与词典 `:7-9`；`resolveLang` `:12-15`；`t` 模板替换 `:44-53`；`locale` 与 value `:55-58`；`useI18n` 抛错 `:63-66` |
| `src/i18n/lang/zh.ts` | 全 615 行，`as const` `:612`；`Dictionary` / `TranslationKey` `:614-615`；`language.note` `:116`；`status.memory` 一组四条 `:571-574`；`error.gitBare` `:75` |
| `src/i18n/lang/en.ts` | `Record<TranslationKey, string>` `:3` |
| `src/lib/settings.ts` | `language` 类型 `:79`；默认空串 `:99` |
| `src/hooks/useSettings.tsx` | `patch` 与整份落盘 `:36-43`；`lang` / `onLangChange` `:67-72` |
| `src/main.tsx` | 次序与注释 `:9-24`；`termReap` `:15-17`；zh 语言表 `:18-20` |
| `src/components/SettingsPage.tsx` | `LANG_OPTIONS` 两档 `:29-32`；下拉显示解析后语言 `:113-121`；`language.note` 渲染 `:144` |
| `src/lib/errors.ts` | `SEP` `:4`；`humanBytes` `:19-25`；`GIT` 原样 `:54-57`；`describeError` `:99-105` |
| `src/lib/format.ts` | `commitStamp` 相对日期 `:117-127` |
| `src/lib/window.ts` | `setTrayLabels` `:14-16` |
| `src/lib/keymap.ts` | 硬编码 `console.error` `:153` |
| `src/App.tsx` | `reportError` 走 `describeError` `:257`；托盘文案同步 effect `:493-496`；比对正文说明 `:2771-2773` |
| `src/components/GitPanel.tsx` | 增删行数 `new Intl.NumberFormat` `:688` |
| `src/components/GitLogPane.tsx` | 日期 `new Intl.DateTimeFormat` `:331` |
| `src/components/DocPane.tsx` | `describeError` 落正文 `:63` |
| `src/components/ExplorerTree.tsx` | 行下错误 `:353`、`:361` |
| `src/components/SearchEverywhere.tsx` | 搜索失败那句 `:158` |
| `src/components/TerminalPane.tsx` | 红字 `:138` |
| `src/hooks/useRunSessions.ts` | 状态行 `:136`、`:159` |
| `src-tauri/src/error.rs` | `SEP` `:7`；`err` `:10-16`；`err_parts` `:19-24` |
| `src-tauri/src/tray.rs` | 注释 `:6-7`；英文标签 `:36-37`；tooltip `:43`；`tray_labels` `:69-76` |
| `src-tauri/src/fs/mod.rs` | `EDITOR_CEILING` `:30` |
| `src-tauri/src/git/mod.rs` | `BAD_MODE` `:1129`；`BAD_SIDE` `:1158` |
