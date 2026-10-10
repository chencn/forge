# 错误模型

后端只发稳定代码加原文，中间用 `\u0001` 分隔，翻成界面文案是前端的事。两端各一份：
`src-tauri/src/error.rs` 发，`src/lib/errors.ts` 收。

## 发的一端

`SEP` 是 `'\u{1}'`，挑它是因为这个字符不会出现在真实文本里，路径和 git 的 stderr 里的任何标点都不会被
误当成分隔符。两个构造函数：`err(code, detail)` 和 `err_parts(code, parts)`，后者带多段细节，前端按顺序取。
detail 为空、或 parts 为空时只发代码本身，不带尾分隔符，所以前端看到「没有 SEP」就当原文处理。

会失败的命令签名一律是 `Result<T, String>`：错误就是那个 `String`，Tauri 把它 reject 成前端的一个 `Error`
样对象，前端用 `errorText()` 取 `.message`。14 条不带 `Result`，因为它们没有可失败的分支：`git_probe`
（探不到就报 `available:false`）、`shell_probe`（扫不到就不列）、`settings_load` 与 `lsp_config_load`（读坏了
退默认值 / 退种子）、`sys_memory`（取不到给 0）、`fs_watch_stop`、`term_reap`、`app_exit`、`lsp_reap`、
`lsp_session_statuses`（表空就给空表）、`lsp_failed`、`lsp_retry`（id 不在就当没事）、`lsp_probe`（探不到只是
`installed:false`）、`lsp_resolve_root`（没命中给 null）。
Rust 侧不定义错误枚举类型、不做 `impl Error`，代码是散在调用点的字符串字面量，加一条错误就是加一个码串
加一条词典。

## 收的一端

`describeError(text, t)` 三步：不含 `SEP` 原样返回；按 `SEP` 切成代码与各段；查 `CODES` 表拼文案。
查不到的代码退回原文拼接（`parts.join(" ")`），认不出代码多半是两端没同时更新，把话说全比猜一句更有用。
`TOO_LARGE` 那一段还本地格式化一次体积（`humanBytes`），因为后端给的是字节数原值。

前端也发同一套码。`codedError(code, ...parts)` 拼出形状相同的文本，走同一条翻译通道，切语言时这些句子
跟着换。用在两处：`BINARY`（已知二进制扩展名在打开之前就说明，不等后端报错）、`NO_DIFF`（比对两侧任一是
图片或二进制时那句说明）。

## Rust 侧不写文案

`error.rs` 的模块注释写的就是这条理由：后端把中文写死，切到英文界面后横幅还是中文，而且同一条错误没法和
界面共用一份措辞（「编辑器最多打开 {max}」这句要和设置页、告示页说一样的话，只能有一份来源）。
托盘菜单那两项文字走的是同一个判断：菜单是系统画的、拿不到前端 i18n，所以由前端把当前语言的文案推进去
（`tray_labels`）。

## git 自己的 stderr 原样显示

`GIT` 这条码不查词典文案：git 的输出已经带 `error:` / `fatal:` 前缀，再套一层「git 命令失败：…」只会重复。
唯一的例外是 stderr 为空的情况，此时才使用 `error.gitBare`「git 命令执行失败」。stderr 为空的来源是 git 有时把说明写在
stdout（例如 `nothing to commit, working tree clean`），所以后端 `fail()` 先取 stderr、为空则取 stdout，
两处都为空才使用该兜底文案。

## 展示位置

`reportError` 不再往底部状态条写一行字（状态条那几格画的是改动计数、语言服务会话数与内存读数）。它把翻译好的文本连同
一个标题写成一条通知，右下角弹气泡，同时进那座「通知」工具窗口留档。标题按调用方给的种类挑：
抓取、拉取、推送各有自己的说法，其余落在「错误」上（`src/App.tsx:207-235`）。

一条通知活多久看级别：error 9000ms，其余 6000ms（`src/components/NotificationCenter.tsx:68`）。
气泡可以自己关掉。历史按工程存在 `localStorage`，读写两侧都把超过 7 天的记录剔掉
（`NOTIFICATION_MAX_AGE_MS`，`src/lib/notifications.ts:24`）。

这条链路是通知那一版改动带过来的，所以后端只要把稳定代码发全，界面这边怎么呈现都不影响契约。

## 现有稳定代码

「段」按 `err_parts` 的顺序记，前端 `p[0]`、`p[1]` 取的就是它。

| 代码 | 发出位置 | 段 | 文案键 |
| --- | --- | --- | --- |
| `IO` | `fs/mod.rs:10` 那个 `io_err` 的全部调用点，另有 `settings.rs:195`、`lsp_config.rs:487`、`sys.rs:28`、`:31`（`write_atomic` 的写临时名两步） | 路径、系统原因 | `error.io` |
| `PATH_GONE` | `fs/mod.rs:140` | 路径 | `error.pathGone` |
| `IS_DIR` | `fs/mod.rs:198`、`:360` | 路径 | `error.isDir` |
| `TOO_LARGE` | `fs/mod.rs:202` | 实际字节数、上限（`8388608`） | `error.tooLarge` |
| `NOT_UTF8` | `fs/mod.rs:217` | 路径 | `error.notUtf8` |
| `BINARY` | `fs/mod.rs:215`；前端 `useDocuments.ts:157`、`App.tsx:891` 自发同一条码 | 路径 | `error.binary` |
| `NO_DIFF` | 只有前端发：`App.tsx:709` | 显示用的路径、`docKind`（`image` / `binary`） | `error.noDiffImage`、`error.noDiffBinary` |
| `TARGET_DIR` | `fs/mod.rs:241` | 目标路径 | `error.targetDir` |
| `TARGET_EXISTS` | `fs/mod.rs:281`、`:307`、`:318` | 目标路径 | `error.targetExists` |
| `MOVED_WITH_SOURCE` | `fs/mod.rs:324` | 新位置、没删掉的源 | `error.moveCopied` |
| `NOT_DIR` | `watch.rs:51`、`fs/search.rs:204`、`:546` | 路径 | `error.notDir` |
| `WATCH_START` | `watch.rs:63` | notify 的原因 | `error.watchStart` |
| `WATCH_DIR` | `watch.rs:67` | 路径、原因 | `error.watchDir` |
| `GIT` | `git/mod.rs:175`、`:177` | git 的 stderr（空则 stdout） | 原样，空时才用 `error.gitBare` |
| `GIT_SPAWN` | `git/mod.rs:160` | 起不了 git 的原因 | `error.gitSpawn` |
| `NO_REPO` | `git/mod.rs:187` | 传入的 root | `error.noRepo` |
| `NOT_IN_REPO` | `git/mod.rs:218` | 路径、仓库根 | `error.notInRepo` |
| `BAD_REV` | `git/mod.rs:391`、`:546`、`:739`、`:760`、`:774`、`:857`、`:882`、`:899`、`:929`、`:969`、`:1042`、`:1079`、`:1123`、`:1144`、`:1215`、`:1374`、`:1521` | 引用 | `error.badRev` |
| `BAD_LOG_PATH` | 当前后端不发（引用与路径的校验都并到 `BAD_REV` / `BAD_REPO_PATH`） | 路径 | `error.badLogPath` |
| `BAD_REPO_PATH` | `git/mod.rs:1524` | 仓库相对路径 | `error.badRepoPath` |
| `BAD_BRANCH` | `git/mod.rs:717`、`:736`、`:788`、`:802`、`:870`、`:872` | 名字 | `error.badBranch` |
| `BAD_TAG` | `git/mod.rs:543`、`:816` | 名字 | `error.badTag` |
| `BAD_PATH` | `git/mod.rs:885` | 工作树目录 | `error.badPath` |
| `BAD_REGEX` | `fs/search.rs:356` | 搜索词、regex 的原因 | `error.badRegex` |
| `EMPTY_MESSAGE` | `git/mod.rs:467` | 无 | `error.emptyMessage` |
| `DETACHED_PUSH` | `git/mod.rs:519` | 无 | `error.detachedPush` |
| `NO_REMOTE` | `git/mod.rs:528`、`:849` | 无 | `error.noRemote` |
| `NO_COMMAND` | `proc.rs:90` | 无 | `error.noCommand` |
| `SPAWN` | `proc.rs:109`、`term.rs:162` | 程序名、原因 | `error.spawn` |
| `TERM_OPEN` | `term.rs:147`、`:166`、`:170` | 原因 | `error.termOpen` |
| `TERM_GONE` | `term.rs:224`、`:234` | 会话 id（词典那行不读这个段） | `error.termGone` |
| `TERM_IO` | `term.rs:227`、`:243` | 原因 | `error.termIo` |
| `NO_TOOL` | `run/detect.rs:360`；前端 `RunControls.tsx:60`、`useRunSessions.ts:146` 自发同一条码 | 缺的那个程序名（不带路径） | `error.noTool` |
| `NO_JDK` | `run/detect.rs:587` | `java` | `error.noJdk` |
| `JDK_TOO_OLD` | `run/detect.rs:592` | `java -version` 里的大版本号 | `error.jdkTooOld` |
| `TOO_MANY_SOURCES` | `run/detect.rs:660` | 那个源文件路径 | `error.tooManySources` |
| `CONFIG_DIR` | `settings.rs:170`、`lsp_config.rs:458`、`run/store.rs:58` | 原因 | `error.configDir` |
| `BAD_JSON` | `run/detect.rs:399` | 文件路径、原因 | `error.badJson` |
| `LSP_NOT_FOUND` | `lsp.rs:347` | 配置里的程序名 | `error.lspNotFound` |
| `LSP_SPAWN` | `lsp.rs:367` | 解析出的完整路径、系统原因 | `error.lspSpawn` |
| `LSP_GONE` | `lsp.rs:493` | 会话 id（词典那行不读这个段） | `error.lspGone` |
| `LSP_IO` | `lsp.rs:370-372`、`:499` | 管道名或系统原因 | `error.lspIo` |
| `LSP_START_BACKOFF` | `lsp.rs:232` | 还能等的毫秒数、上次失败原因 | `error.lspBackoff` |
| `LSP_START_LIMIT` | `lsp.rs:238` | 连续失败次数、上次失败原因 | `error.lspStartLimit` |
| `LSP_NO_SERVER` | `lsp_probe.rs:266`、`:270` | 配置里没有的那个键（空名时不带段） | `error.lspNoServer` |
| `LSP_NO_INSTALL` | `lsp_probe.rs:274` | 键 | `error.lspNoInstall` |
| `LSP_INSTALL_SPAWN` | `lsp_probe.rs:234` | 壳程序名、系统原因 | `error.lspInstallSpawn` |

## 两个没有词典的代码

`BAD_MODE`（`git_reset` 的 mode 只认 soft / mixed / hard）和 `BAD_SIDE`（`git_resolve_conflict` 的 side
只认 ours / theirs）不进词典。这两个参数在前端是字面量联合类型（`ResetMode`、`"ours" | "theirs"`），
只有手敲错值才会撞到，落到「退回原文」那条路上正好把错值本身显示出来。

另外还有两类不带代码的裸字符串：`settings_save` 里 `to_string_pretty` 失败，和 `tray_labels` 里 `set_text`
失败，直接发 `error.to_string()`。它们没有分隔符，`describeError` 原样返回；这两条路都是本机环境坏了，
包一层代码也说不出更多。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src-tauri/src/error.rs` | 模块注释里那条理由 `:1-4`、`SEP` `:7`、`err` 空 detail 只发代码 `:10-16`、`err_parts` `:19-24` |
| `src/lib/errors.ts` | `SEP` `:4`、`codedError` `:12-14`、`humanBytes` `:19-25`、`CODES` 表 `:33-96`、`GIT` 那一行 `:54-57`、run 那四条 `:73-77`、LSP 九条 `:84-95`、`describeError` 的三步与退回原文 `:99-105` |
| `src/lib/fs.ts` | `errorText` `:236-239` |
| `src-tauri/src/fs/mod.rs` | `io_err` `:9-11`、`EDITOR_CEILING` 与 `TOO_LARGE` 的字节数 `:30`、`:200-205`、BINARY / NOT_UTF8 那层分流 `:211-219` |
| `src-tauri/src/fs/search.rs` | `NOT_DIR` 两处 `:203-205`、`:545-547`、`BAD_REGEX` `:351-364` |
| `src-tauri/src/git/mod.rs` | `fail()` 先 stderr 后 stdout `:168-178`、`GIT_SPAWN` `:152-166`、`BAD_MODE` `:1125-1130`、`BAD_SIDE` `:1155-1159` |
| `src-tauri/src/lsp.rs` | `backoff_error` 的两条码 `:226-244`、`LSP_NOT_FOUND` `:347`、`LSP_SPAWN` `:367`、三路管道取不到的 `LSP_IO` `:370-372`、`lsp_write` 的 `LSP_GONE` 与写失败 `:491-500` |
| `src-tauri/src/lsp_probe.rs` | `LSP_INSTALL_SPAWN` `:228-230`、`lsp_install` 的两条码 `:259-272` |
| `src-tauri/src/lsp_config.rs` | `config_dir` 的 `CONFIG_DIR` `:455-460`、`save_in` 的 `IO` `:485-491`、`load_in` 读坏退种子不发错误 `:463-483` |
| `src/lib/git.ts` | `ResetMode` `:362`、`side` 的字面量联合 `:375` |
| `src/App.tsx` | `reportError` `:255-281`、`NO_DIFF` 那段判定 `:888-923`、`BINARY` 的告示 `:1172-1191`、状态条那一格与计数 `:2854-2904` |
| `src/hooks/useDocuments.ts` | 打开前就发 `BINARY` `:151-159` |
| `src-tauri/src/tray.rs` | `tray_labels` 的两处 `set_text` `:68-76` |
| `src-tauri/src/settings.rs` | `to_string_pretty` 那段 `:192-198` |
| `src-tauri/src/sys.rs` | `write_atomic` 两步各发一条 `IO` `:25-33` |
