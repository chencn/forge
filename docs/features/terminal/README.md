# 终端工具窗口

一条伪终端 shell 会话，画在底部工具窗口或编辑区页签栏里。会话状态不在组件里，在模块级的
`src/lib/termStore.ts`。面板收起、换位置都不关会话。

## 会话建立

`term_open(cwd, shell, cols, rows)` 用 portable-pty 的 `native_pty_system().openpty(PtySize)` 开一对
读写端，`pixel_width` 和 `pixel_height` 一律 0。起进程时补 `TERM=xterm-256color`。`cwd` 为 null 或空串时
不设工作目录，落在后端进程的当前目录。会话 id 是 `term-<N>`，从 1 自增。

## 输出与输入

- reader 线程每次 `read` 最多 8192 字节，整段按 base64 编码后发 `term://output`，payload 是
  `{ id, data }`。一次 `read` 的边界会切在半个 UTF-8 序列上，套进 JSON 拼不回来，所以传 base64。
  前端 `decodeChunk` 用 `atob` 还原成字节数组，交给 xterm 自己增量解码。
- 键盘输入原样 `term_write` 进 PTY，行编辑、历史、Tab 补全由 shell 负责。
- 视口行列数变了必须 `term_resize` 同步，否则换行位置按旧列数算。
- 读到 EOF（shell 自己退出）就把会话从 Rust 的表里摘掉，发 `term://exit { id, code }`。取不到退出码时
  `code` 为 null；被 `term_close` 收掉的会话同样是 null，那条记录已经从表里摘走了。

## shell 与默认值

`shell_probe` 扫这台机器。Windows 上的扫描次序就是默认值次序：

- PowerShell：`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，带 `-NoLogo`。
- `%ProgramFiles%\PowerShell\8\pwsh.exe`、`7`、`6`，带 `-NoLogo`。
- PATH 里的 `pwsh.exe`，带 `-NoLogo`。
- cmd：`ComSpec` 的值，不带参数。
- Git Bash：`%ProgramFiles%\Git\bin\bash.exe`，没有再看 PATH 里的 `bash.exe`，不带参数。
- WSL：`%SystemRoot%\System32\wsl.exe`，不带参数。

非 Windows 的次序是 `SHELL` 指向的程序、`/bin/bash`、`/bin/zsh`、`/usr/bin/fish`、`/bin/sh`。
`push_shell` 只列真实存在的文件，同一路径不重复列。

`resolve_shell` 三种取值：`terminal.shell` 留空就用排在第一的那条，连参数一起；填了但不在这张表里就把它
当路径直接执行，不带参数；一条都没扫到才退回字面量 `powershell.exe`。默认 shell 的准确写法是
`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo`。

设置页那一栏的选项来自 `shell_probe`，界面上选不到没被扫到的 shell。写回设置的是 `path`，不是显示名。
`terminal.shell` 为空时下拉显示表里第一条的 `path`，存下来的仍是空串。

## 会话存活与销毁

收起、在底部和页签栏之间来回切，改的只有 `places` 这一份状态（`dockPane`、`hidePane`、`tabPane`）。
`TerminalPane` 卸载时不关会话，只断订阅。

- 输出按到达顺序攒在 `session.chunks`（base64 片段数组），没有条数上限。攒下来是因为跑着的任务在后台继续
  产生输出，回到面板时要能看见之前打印的内容，这一点照 IDEA。
- 面板重新挂上时先 `term.reset()`，再从第 0 段起逐段补画。
- `watchTermSession` 的退订只摘掉订阅者，PTY 和缓冲都不动。

收掉一条 shell 只有三条路：

- 重开会话：头部的 `RotateCcw` 图标按钮，或右键菜单里的「重开会话」，走 `restartTermSession`。
- 换工程或关闭工程：`openFolder`、`closeFolder`、工程下拉选中三处都显式调 `dropTermSession`。
  `needTermSession` 另有一道判断：会话的起点目录和当前 `cwd` 不一致就收掉重开，留着它跑的是别处的命令。
- 退出应用。

`close_one` 先给 reader 线程发停止信号，再 `kill` 子进程。shell 自己退出（敲 `exit`）时界面停在最后一屏，
`session.exited` 让按键不再写 PTY，下次面板挂载才起新的一条。

前端只认一条会话：`termStore.ts` 里那个模块级 `session` 是单值，不是表。`needTermSession` 和
`restartTermSession` 在建新会话前都先 `dropTermSession`，所以这一侧同时只有一条。Rust 侧的表是 HashMap，
可以同时挂着多条，残留的那些靠 `term_reap` 清。

## 启动时的 reap

`src/main.tsx` 在读完设置之后、import 界面之前 `await termReap()`。重载时那条 `term_close` 往往来不及送达，
旧 shell 留在 Rust 侧的表里（Rust 进程跨重载存活），而终端一挂载就会开新会话，晚了就是新旧两条同时在跑。
`term_reap` 把表里现有的键全走一遍 `close_one`，开发时热重载因此不攒旧 shell。

## 界面与尺寸

- xterm 实例只建一次：`monoFont()`、`fontSize: 12`（写死，不跟设置里的编辑器字号）、`lineHeight: 1.45`、
  `scrollback: 4000`、`cursorBlink`。
- 配色全部来自 `terminalColors`，即设计令牌。深浅色切换只改 `theme`，不碰会话。
- FitAddon 配 `ResizeObserver` 做自适应。宿主宽或高不足 20px 时直接返回，不 `fit()`，也不报 `term_resize`。
  0×0 的行列会把 ConPTY 带进不可用的状态。
- 会话起不来时把原因用红字写进终端本身（`term.writeln` 带 `\x1b[31m`），不留一块没有解释的空白。
- 右键四项：复制（没有选区时禁用）、粘贴、清屏、重开会话。
- 工具窗口头部两颗：清屏、重开会话。再往右是「在选项卡中显示 / 放回底部」和「最小化」，这两颗和其他工具
  窗口共用同一套外壳。
- 换语言不重开 shell：翻译函数存在 ref 里，报错文案现取。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src-tauri/src/term.rs` | `shell_probe` 的次序与参数 `:92-130`、`push_shell` 去重 `:133-142`、`resolve_shell` 三种取值 `:145-158`、`term_open` 开 PTY 与会话 id `:162-217`、`read_loop` 的 8192 与退出事件 `:220-248`、`term_write` `:252-259`、`term_resize` `:262-275`、`term_close` 与 `close_one` `:279-289`、`term_reap` `:294-299` |
| `src/lib/term.ts` | `termOpen` `:36-43`、`termReap` `:60-62`、`decodeChunk` `:65-72`、`terminalColors` `:75-84` |
| `src/lib/termStore.ts` | `TermSession` 与 `chunks` `:12-20`、模块级 `session` `:24`、`watchTermSession` `:42-48`、`open` `:57-80`、`dropTermSession` `:83-89`、`needTermSession` `:95-105`、`restartTermSession` `:108-116` |
| `src/components/TerminalPane.tsx` | xterm 参数 `:69-76`、输入闸门 `:82-85`、20px 门槛 `:86-96`、卸载不关会话 `:98-106`、补画与重开 `:109-134`、失败原因写进终端 `:135-139`、换主题 `:147-150`、右键菜单 `:152-188` |
| `src/App.tsx` | `places` `:204-208`、`dockPane` / `hidePane` / `tabPane` `:376-401`、`openFolder` 与 `closeFolder` `:432-462`、`paneBody` `:1435-1437`、终端头部两颗 `:1473-1492`、位置切换与最小化 `:1507-1522`、工程下拉 `:1746-1764` |
| `src/components/SettingsPage.tsx` | `shellProbe` 取下拉选项 `:62-74`、终端那一栏 `:236-254` |
| `src/main.tsx` | `term_reap` 的时机 `:13-21` |
| `src/styles.css` | `.term-host` `:1445-1453` |
