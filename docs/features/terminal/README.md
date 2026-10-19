# 终端工具窗口

伪终端 shell 会话，画在底部工具窗口或编辑区页签栏里。一个页签一条会话，多工作区时每个根各有一组。
会话状态不在组件里，在模块级的 `src/lib/termStore.ts`；面板收起、换位置、切工作区都不关会话。

## 分层

- `src-tauri/src/term.rs`：PTY 会话表、shell 探测、读线程、写入、尺寸、停读、关闭。
- `src-tauri/src/term_long_input.rs`：Windows 上超长命令改道成临时脚本。
- `src-tauri/src/term_layout.rs`：页签布局存盘与读回（`term_layout_load` / `term_layout_save`，写进 app 数据目录的 `terminal-tabs.json`，按根分键，原子写）。
- `src/lib/termStore.ts`：会话列表、各根的激活页签、分屏组、原始输出历史、退出处理、布局防抖存盘与恢复。
- `src/lib/termProfiles.ts`：配置档到 `TermSpec` 的解析（目录展开、参数、环境变量）。
- `src/components/TerminalHost.tsx`：每条会话一个 xterm，活在面板外面，按插槽挪进挪出。
- `src/components/TerminalPane.tsx`：插槽、分屏面板与拖拽分隔条、查找浮层、右键菜单、空状态、退出条；`TerminalTabs.tsx`：页签栏（横排 / 竖排）；`TerminalProfilesEditor.tsx`：设置里的配置档编辑。

## 会话建立

`term_open(cwd, shell, cols, rows, launch?)` 用 portable-pty 开一对读写端。`shell` 是 `ShellInfo.id`，
按 id 认、认不到再按路径认（老设置存的是路径），都认不到就当路径直接执行。会话 id 是 `term-<N>`，从 1 自增。
`launch` 是配置档带过来的附加参数与环境变量：参数追加在 shell 自带参数之后；环境变量在补完全局环境之后覆盖，
值为空等于删掉这一项，键为空或带 `=` 的行忽略。

起进程前补的环境：

- `TERM=xterm-256color`、`COLORTERM=truecolor`、`TERM_PROGRAM=forge`、`TERM_PROGRAM_VERSION`、`CLICOLOR=1`。
- 摘掉外层终端留下的身份标记：`WT_SESSION`、`TMUX`、`VTE_VERSION`、`KITTY_*`、`WEZTERM_*` 等，
  以及 `NO_COLOR`、`FORCE_COLOR`、`CLICOLOR_FORCE`。从别的终端里启动 Forge 时它们会跟进来。
- Windows 上没有 `HOME` 时按 `USERPROFILE` 补。可执行文件是 `bash.exe`（Git Bash、MSYS2、Cygwin）时设
  `CHERE_INVOKING=1`，登录 shell 才不会 cd 回家目录。
- 程序是 `wsl.exe` 且有 `cwd` 时追加 `--cd <cwd>`：wsl 不认进程的工作目录。

## shell 探测

`shell_probe` 扫这台机器，Windows 上的次序就是默认值次序：

- `%ProgramFiles%\PowerShell\8|7|6\pwsh.exe`，再是系统的 `powershell.exe`，再是 PATH 里的 `pwsh.exe`，都带 `-NoLogo`。
- cmd：`ComSpec`。
- Git Bash：`%ProgramFiles%\Git\bin\bash.exe`，带 `--login -i`。不退回 PATH 上的裸 `bash.exe`，
  System32 里那个是 WSL 的入口。
- nu：PATH 里的 `nu.exe`。
- MSYS2（`<系统盘>\msys64|msys32`，认 `msys2_shell.cmd`）与 Cygwin（`cygwin64|cygwin`，认 `bin\cygwin1.dll`），带 `--login -i`。
- WSL：默认发行版一条，再按 `HKCU\...\Lxss` 里登记的发行版各一条，id 是 `wsl:<发行版>`，参数
  `--distribution <发行版>`。只读注册表，不跑 `wsl -l`，打开菜单不会把虚拟机拉起来。
  Docker Desktop、Rancher Desktop 的服务发行版不列。

非 Windows 的次序是 `SHELL`、`/bin/bash`、`/bin/zsh`、`/usr/bin/fish`、`/bin/sh`。只列真实存在的，同一 id 不重复列。

## 输出

- reader 线程每次 `read` 最多 64 KiB，攒到 32 KiB 或这一趟没读满就发一条 `term://output`（base64）。
- 前端按会话留一份原始字节历史，xterm 重建时整段重放；单条 8 MB、合计 24 MB 封顶。ConPTY 发的 `CSI 3 J`
  从历史里剥掉，否则重放会把滚屏擦掉。
- DEC 2026 同步输出在交给 xterm 之前合成一次写入（`termOutputBuffer.ts`），清屏重画的半帧不画出来。
- 反压：交给 xterm 还没解析完的字节到 500 KB 就 `term_set_paused(true)`，降到 100 KB 再放开。
  停住时读线程停在下一次 `read` 之前，PTY 管道写满，shell 的写入跟着阻塞。同步输出攒着的那部分不计入，
  不会因为等结束标记而停读卡死。xterm 拆掉时一律放开。

## 输入

- 键盘输入走 `term_write`（文本）；xterm 的 `onBinary`（老式鼠标上报）走 `term_write_bytes`，按字节原样写。
- Windows 上 cmd / PowerShell 会话里，超过 7000 字符又带回车的一段输入落成临时脚本，PTY 只收到调用它的那一句。
  PowerShell 脚本带 BOM，执行完自己删；cmd 脚本按 OEM 代码页编码，转不回原文就拒收，会话结束时删。
  cmd 单独一行超长本身执行不了，直接报错。带 ESC 的输入（括号粘贴、方向键）不改道。
- 粘贴：Ctrl/Cmd+V、Ctrl+Shift+V、Shift+Insert 和右键「粘贴」都走 xterm 的 `paste()`，程序开了括号粘贴时
  多行不会被逐行执行。五行以上或一千字以上先弹确认。
- 有选区时 Ctrl/Cmd+C 复制，不发 SIGINT；Ctrl+Shift+C 总是复制。快捷键都在 `termKeys.ts`，xterm 只认一个处理器。

## 链接、标题与当前目录

- http(s) 链接单击交给系统浏览器（`termUrl.ts`）。
- 文件路径（`termFileLinks.ts`）：绝对路径、相对路径、`file://`、Git Bash 的 `/d/...`，可带 `:行:列` 或 tsc 的
  `(行,列)`。必须带目录分隔符、文件名像文件。单击时先确认是文件，再开进编辑器并跳到那一行。
- 相对路径按 shell 用 OSC 7 报的当前目录解析，没报过就按会话起始目录。
- 程序用 OSC 0/2 报的标题；ConPTY 报的可执行文件全路径只留程序名。

## 页签

- 名字：用户重命名过的优先；其次是标题，但超过 32 字、带 `@` 或路径分隔符的不用（`user@host: ~/dir` 这种）；
  再其次是 shell 名。悬停提示里有名字、完整标题、当前目录和状态。
- 页签多了横向滚动，竖滚轮也能滚；激活页签自动滚进视野。
- 单击切换；双击或 F2 就地重命名，Enter 确认、Esc 取消，清空恢复自动取名。中键关闭。
  获得焦点时 ←/→/Home/End 切换，Delete 关闭，Shift+F10 或菜单键开右键菜单。
- 右键菜单：固定 / 取消固定、向右 / 向下拆分、取消拆分、再开一个同样的（放在旁边，落在 shell 当前所在目录）、
  清屏、重命名、导出输出（整段滚屏转纯文本，软换行接回）、移到编辑区 / 停靠到底部、重启会话、关闭、关闭其他、关闭右侧、关闭全部。
- 固定的排在最前，关闭按钮换成图钉（点了取消固定）；中键、关闭其他 / 右侧 / 全部都跳过它。固定 / 取消固定作用于整组。
- 拖拽排序：组内拖动排组内顺序，拖到别的组上把整组带走。
- 拖到编辑区（面板停靠状态时）把终端整个挪进编辑区页签；在编辑区里拖回底部反过来停靠回来。这是整个工具窗口的移动
  （带的是被拖的那条成为激活页签），单条会话不能单独占一个编辑区页签。
- 后台页签来了新输出画蓝点，切过去清掉；进程退出画红点；响铃时页签上闪一下铃铛。当前页签是浅蓝底加淡边，和编辑器页签一致。
- 名字、固定、分组、顺序、拆分方向、目录通过 `term_layout_save` 防抖 600ms 写进数据目录的 `terminal-tabs.json`，
  按根（小写、正斜杠）分键。面板第一次要会话时整组恢复（`needTermSession`）；用户主动清空过的根不恢复。
  恢复的是页签和目录，滚屏内容不重放、启动命令不重跑。

## 竖排页签

`terminal.tabLayout` 选 `vertical` 时页签栏竖着摆在终端左侧（可以拖宽窄，120–420px），动作按钮留在原横条上。
每个根各有一组页签，互不影响。

## 分屏

一条会话可以向右 / 向下拆出同级面板，同组页签在页签栏里挨在一起（横排布局时带组分隔）。

- 组的方向存在 `directions: Map<group, "row" | "column">`；面板用 flex 权重分配，分隔条可以拖（最窄 80px）。
- 快捷键：Ctrl+Shift+5 向右拆，Ctrl+Shift+- 向下拆；右键菜单里同样有。
- 取消拆分让那条自成一组，留在原位旁边。关掉组里一条焦点留在组内；剩一条时自动回单面板。
- 「移动 / 拖拽」跨组时整组一起走；组内拖动只动这一条。

## 配置档

设置「终端」里可以配任意多个 profile：名字、shell（默认跟随全局）、附加参数、环境变量（一行一个 `KEY=VALUE`）、
起始目录（相对路径拼在工作区根后面）、启动命令（shell 第一次有输出之后敲进去，2 秒兜底）。

- 新终端下拉菜单（页签栏「+」旁的 ⌄）里每个配置档一条，点了按 `profileSpec` 展开成 shell / 参数 / 环境 / 目录。
- 配置档起出的会话带 `profile` 标记，「在终端里运行」（runInTerminal）不会复用这类会话。
- 配置档 id 存在布局里，重启恢复时按 id 找回；配置档被删了则退回默认 shell、只留目录。

## 缩放与响铃

- 缩放：Ctrl+`+` / Ctrl+`-` 放大缩小、Ctrl+`0` 复原（按 `event.code` 认，小键盘同样生效），也支持 Ctrl+滚轮。
  改的是当前终端字号，钳在 `TERMINAL_FONT_SIZE_RANGE` 内，复原回到设置值，跟着重新 fit 并通知 PTY。
- 响铃（`terminal.bell`）：`visual` 页签上闪铃铛、终端边框闪一下；`sound` 在此基础上用 WebAudio 发 880Hz 短音；
  `none` 忽略。xterm 的 `onBell` 触发，`ringTermBell` 记在会话上，切过去即清除。`prefers-reduced-motion` 下边框不动画。

## 查找

Ctrl+F、右键「查找」或页签栏的放大镜打开右上角浮层，有选区（单行）时预填。边打字边找，全部匹配高亮，
当前项另一种颜色，显示「第几个/共几个」。区分大小写、全字、正则三个开关。Enter / Shift+Enter 下一个 / 上一个，
Esc 关掉、清高亮、焦点回终端。切页签时在新的那条上重找。高亮最多 2000 个。

## 退出

- 读到 EOF 就把会话从 Rust 的表里摘掉，等子进程交出退出码，发 `term://exit { id, code }`。
  被 `term_close` 收掉的会话 `code` 为 null。
- 退出码 0：页签直接收掉。非零或取不到：页签留着、变灰带红点，终端末尾补一行「进程已结束，退出码 N 按回车重新启动」，
  底部一条退出条带「重开会话」「关闭终端」。这时在终端里按回车也是重开；其他按键不写 PTY。
- 重开（`restartTerm`）用原来的 shell / 配置档起新会话，页签位置、组、名字、固定状态都留着。
- 一个根下一条都不剩时显示空状态和「新建终端」，焦点落在按钮上，回车就开。面板刚挂上、第一条还在起的时候不显示。

## 设置

`terminal` 一段：`shell`（`ShellInfo.id`）、`fontSize`（8–32，默认 12）、`fontFamily`（空串跟编辑器的等宽字体）、
`scrollback`（1000–100000，默认 10000）、`cursorStyle`（bar / block / underline）、`tabLayout`（horizontal / vertical）、
`bell`（visual / sound / none）、`profiles`（配置档数组）。改了立即作用到已开的终端，字号字体变了会重新 fit 并告诉 PTY。
Rust 的 `TerminalSettings` 要同步加字段，否则存盘时被丢掉。配置档编辑在 `TerminalProfilesEditor.tsx`。

## 尺寸

- FitAddon 配 `ResizeObserver`。插槽宽或高不足 20px 时不 fit、不 `term_resize`：0×0 会把 ConPTY 带进不可用的状态，
  fit 成一两行会把滚屏裁掉。
- `term_resize` 带上 `.xterm-screen` 的像素宽高，给按像素排版的程序用。

## 会话存活与销毁

收掉一条 shell 只有这几条路：关页签、右键「重开会话」、关闭工作区（`closeTermsForRoot`）、shell 以 0 退出、退出应用。

`src/main.tsx` 在 import 界面之前 `await termReap()`：重载时那条 `term_close` 往往来不及送达，旧 shell 留在
Rust 侧的表里。应用退出时 `reap_all_for_exit` 同步收掉全部会话。

## 还没有

- 滚屏内容不跨重启恢复，重启后每条会话是空白的新 shell；配置档的启动命令恢复时也不重跑。
- 单条会话不能单独拖成编辑区页签——拖出去挪的是整个终端窗口。
- 分屏的方向不能从键盘切（右键「向右 / 向下拆分」重拆一次即换向），面板尺寸也不跨重启保存。
