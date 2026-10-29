# 命令契约

逐条对着 `src-tauri/src/lib.rs` 的注册表与各模块签名核过，本文件收录 109 条。出处列给命令自己的行号。
参数一律写前端传的 camelCase 名（映射规则见 [README.md](./README.md)）。
非 AI 命令里发事件的只有六条：`fs_watch_start` 起的每条转发线程发 `fs://change{root,paths}`，
`delete_entry` 降级物理删除时发 `fs://delete-progress{count,current}`（送回收站那条不发），`term_open` 的 reader 线程发
`term://output` / `term://exit`，`proc_start` 的转发与轮询线程发 `proc://output` / `proc://exit`，
`lsp_start` 的两条读线程发 `lsp://message` / `lsp://log` / `lsp://exit`，内置浏览器那八条 `browser_panel_*`
在每次改动页面状态后统一发 `forge-browser-changed{}`（载荷是空的，面板只把它当「重新拉一次 `browser_panel_state`」）。
`app://flush` 由窗口关闭事件和托盘菜单的「退出」触发，不经命令。其余写命令不发事件：磁盘上的动静统一经
`fs://change` 回来，git 状态由前端在写完之后再调一次 `git_status`。
AI 助手另有 `ai_cli` / `ai_runtime` 两族命令，本文件只收录其中的五条；其余命令的行为见
[../features/ai-assistants/](../features/ai-assistants/)。它们统一广播到 `ai-runtime://events`，
载荷由会话日志投影。

## 文件与目录（18）

`find_files` / `search_text` / `find_symbols` 已接进界面：`src/lib/fs.ts` 的 `findFiles` / `searchText` /
`findSymbols` 各包一条，发出调用的只有 `src/components/SearchEverywhere.tsx` 一处（文件档发 `find_files`，
类与符号两档发 `find_symbols`，文本档发 `search_text`，各档并发、各自收口）。底部 `src/components/FindPane.tsx`
不再发查询，画的是弹层交过来的那一整页。挂点与键位见
[../features/search/](../features/search/)。三条都是 `async` 命令，只读，一趟扫完即回，不带游标，也没有取消句柄。

| 命令 | 参数 | 返回 | 副作用 / 事件 | 出处 |
| --- | --- | --- | --- | --- |
| `list_directory` | `path` | `DirectoryListing` | 无 | `fs/mod.rs:150` |
| `read_file` | `path` | `FileContent` | 读；超过 8 MiB 给 `TOO_LARGE`，是目录给 `IS_DIR`；非 UTF-8 里含 NUL 的给 `BINARY`，其余给 `NOT_UTF8` | `fs/mod.rs:195` |
| `write_file` | `path, contents, lineEnding?, hasBom?` | `FileContent` | 写盘，`modifiedMs` 是写完之后的值；监听随即报 `fs://change` | `fs/mod.rs:233` |
| `create_folder` | `path` | `FsEntry` | 单层创建，父目录不在则 `IO` | `fs/mod.rs:267` |
| `create_file` | `path` | `FsEntry` | `create_new`（`O_CREAT \| O_EXCL`）：路径上已有文件报 `TARGET_EXISTS`，不会像 `File::create` 那样把内容截成空的 | `fs/mod.rs:479` |
| `rename_entry` | `from, to` | `FsEntry` | `to` 存在则 `TARGET_EXISTS`，源不动 | `fs/mod.rs:279` |
| `copy_entry` | `from, to` | `FsEntry` | 目录走 `copy_tree` 递归整棵子树，其余（文件、符号链接）交给 `fs::copy` | `fs/mod.rs:305` |
| `move_entry` | `from, to` | `FsEntry` | 同盘即 rename；跨盘复制后删源，删不掉给 `MOVED_WITH_SOURCE` | `fs/mod.rs:316` |
| `delete_entry` | `path` | `()` | 优先移入系统回收站 / 废纸篓（Windows `SHFileOperationW`，macOS `trash` CLI 或 `osascript` 走 Finder，Linux `gio trash` / `trash-put`）；权限不足或被占用（os error 5 / 13 / 32、`not found`、`operation aborted`）直接报错，**不降级**成物理删除；只在介质或桌面环境不支持回收站时才递归硬删，那一趟每 50ms 发一次 `fs://delete-progress{count,current}`。符号链接只送链接本身，不穿透删目标 | `fs/mod.rs:609` |
| `reveal_entry` | `path` | `()` | Windows 起 `explorer /select,<path>` | `fs/mod.rs:343` |
| `file_stamp` | `path` | `FileStamp{size,modifiedMs}` | 不读正文；图片预览靠它换缓存串 | `fs/mod.rs:357` |
| `fs_allow_asset` | `root` | `()` | 把该目录连子树加进 asset 允许名单，不落盘 | `fs/mod.rs:373` |
| `open_external` | `url` | `()` | `ShellExecuteW`，不经 cmd。入参先过白名单：协议只认 `http` / `https` / `mailto` / `tel`，其余写法（`file:` / `ms-msdt:` / `javascript:` …）与盘上不存在的路径、可执行后缀（`.exe` / `.lnk` / `.ps1` …）一律 `EXTERNAL_BLOCKED`。markdown 里的链接是外部输入，不能让它决定执行什么 | `fs/mod.rs:381` |
| `find_files` | `root, query, limit?, filter?{showHidden,ignored[]}` | `FileHits{query,items[],truncated}` | 按名字找文件与目录。名字打分四档：全等 4 > 前缀 3 > 包含 2 > 逐字顺次出现 1；排序按档位降序、路径短的在前、再字典序。剪掉 `.git` / `node_modules` / `target` / `dist` / `build` / `out`，不跟软链，深 24 层、访问 200_000 条目封顶，匹配攒到 2000 条即停，触闸置 `truncated`。`filter` 是可见性闸门（`ScanFilter`）：`showHidden` 为假时剪掉隐藏项，`ignored` 里那些绝对前缀之下的路径整棵剪掉，两者都在扫描层生效、不占条目与命中预算。`limit` 传 0 或缺省走 100 条那档，钳到 1..5000；词全空白回空表不报错；`root` 不是目录给 `NOT_DIR` | `fs/search.rs:253` |
| `find_symbols` | `root, query, kindFilter?("types"\|"all"), limit?, filter?{showHidden,ignored[]}` | `SymbolHits{query,items[],truncated}`，条 `SymbolHit{path,name,kind,container,line,column}` | 按名字找定义，给弹层的「类」「符号」两档供货。按扩展名选一套行锚定的定义正则（ts/tsx/jsx/mjs…、java、kt、rs、py、go、c/cpp、cs），一行一条定义；种类名沿用 openidea（class/interface/struct/enum/trait/typeAlias/function/method/constant/variable/module/record/annotation/object/union）。`kindFilter:"types"` 只回类型那张表（与前端 `seModel.ts` 的 `TYPE_KINDS` 同步）。打分复用 `search.rs:151` 的 `score_name` 四档（4 全等 > 3 前缀 > 2 包含 > 1 逐字顺次出现，词全空白返回 `None` 即不收），关键词带非 ASCII 时再退一层 `score_name_full`（`search.rs:176`）把两边都折成小写再比；排序档位降序 → 目录短 → 名字（`symbols.rs:581`）。单文件超过 2 MiB 不抽符号（`SYMBOL_SIZE_CEILING`，`symbols.rs:27`），一个根最多攒 80_000 条（`MAX_SYMBOLS`，`symbols.rs:29`），触上限或被 `limit` 截时 `truncated` 为真（`symbols.rs:586`）；`limit` 同 `find_files` 那两档（`page_limit`）。整棵结果按根缓存 60 秒（`CACHE_TTL`，`symbols.rs:31`），之后的查询只对着缓存比名字，没有增量失效。`filter` 同 `find_files`，但隐藏项在这一档按目录段名前缀判（`hidden_container`，`symbols.rs:531`：建缓存时没留 metadata，只认点开头那一段，Windows 隐藏属性在这一档不追）。规则以行首锚定，看不见注释的边界：`// fn foo()` 这类行注释自然不收，块注释里自成一行的一条照样算定义（测试 `line_comments_are_skipped_but_block_comments_leak`）；空词回空表不报错，`root` 不是目录给 `NOT_DIR` | `fs/symbols.rs:612`，注册在 `src-tauri/src/lib.rs:110` |
| `search_text` | `root, query, options{caseSensitive,wholeWords,regex,fileMask,limit}, filter?{showHidden,ignored[]}` | `TextPage{query,hits[],files,truncated,skipped}` | 逐文件扫正文。每条命中带 `line`（1 起）、`snippet`、`snippetFrom`（片段首字符在原行里的列号）和这一行的 `ranges{column,length}`（1 起、按字符数）；片段最长 240 字符，整行超过它就以首处命中为中心截。单文件 20 MiB 封顶，开头 4096 字节里见 NUL 当二进制跳过；太大、二进制、非 UTF-8、读不到四类合并计入 `skipped`。`filter` 同 `find_files`，剪掉的项不计入 `skipped`。`fileMask` 逗号或分号分隔、只认 `*`、空表示不限；`wholeWords` 只在非正则下生效；`regex` 为真时词编不成正则给 `BAD_REGEX`；`limit` 同 `find_files` 那两档；`root` 不是目录给 `NOT_DIR` | `fs/search.rs:596` |
| `fs_watch_start` | `root, generation` | `()` | 按根开槽的递归监听：槽是 `HashMap<root, ActiveWatch>`，这条只插入或替换**该根**那一轮，别的根不受影响。`generation` 是前端每次新监听递增的代号，`(root, generation)` 合起来是令牌，锁内比对，慢到的旧请求直接放弃；`.git` 内部噪声在这一层剔（`objects/`、`logs/`、`hooks/`、`info/`、`*.lock` 滤掉，指针文件与 `refs/**` 放行）；去抖 150ms、持续写入满 1s 先放行一轮，之后发 `fs://change{root,paths}`，单批 256 条是发送粒度不是丢弃阈值 | `watch.rs:174` |
| `fs_watch_stop` | `root, generation` | `()` | 令牌与 root 都对上该根槽里那轮才清槽，过期请求什么都不动；丢句柄后那条转发线程随之退出，退出前把剩余路径发完。没有可失败的分支，签名不带 `Result` | `watch.rs:261` |

## Git（48）

`root` 是仓库根绝对路径，只有 `git_probe` 收 `path`（可以是子目录，它往里找）、`git_init` 收的那个
目录还谈不上是仓库（就是打开的那个文件夹）。带 `revision` / `branch` / `name` 的都先过字符集校验。

非 `async` 的 `#[tauri::command]` 在主线程执行，一次 `git status` 就把窗口冻住。git 这一节现在
**四十八条全部是 `async`**，命令体一律经 `git::block`（`spawn_blocking`）跑在阻塞线程池上；
新加的那条也要照这个写法，别再留同步的。
每条 git 命令都过 `hide_console`：主程序是 windows 子系统，没有控制台可继承，不设这个标志的话每个 `git.exe`
都要自己新建一个控制台。

| 命令 | 参数 | 返回 | 落到的 git 调用 | 出处 |
| --- | --- | --- | --- | --- |
| `git_probe` | `path` | `GitProbe` | `rev-parse --show-toplevel` + `remote` + 四个 `.git/*` 标志文件；不报错，失败即 `available:false` | `git/mod.rs:224` |
| `git_init` | `root` | `String`（stdout） | `init`；只建 `.git`，不动工作区文件，已有仓库里幂等 | `git/mod.rs:1115` |
| `git_status` | `root` | `GitStatus` | `status --porcelain --branch --untracked-files=all`，含 ahead/behind | `:374` |
| `git_show` | `root, revision, path` | `String` | `show --textconv <rev>:<相对路径>`；该版本没这文件给空串 | `:388` |
| `git_index_show` | `root, path` | `String` | `show :<路径>`（索引那一侧） | `:411` |
| `git_stage` | `root, paths[]` | `()` | `add -- <pathspec>`，未跟踪也能暂存 | `:452` |
| `git_unstage` | `root, paths[]` | `()` | `restore --staged --` | `:457` |
| `git_commit` | `root, message, amend` | `String` | `commit -m` / `commit --amend -m`；`amend` 且说明为空时 `--amend --no-edit` | `:462` |
| `git_fetch` | `root` | `String` | `fetch --all --prune --progress`，返回 stderr（进度都在里面） | `:499` |
| `git_pull` | `root` | `String` | `pull --ff-only` | `:507` |
| `git_push` | `root, setUpstream` | `String` | 有上游且没要求建上游时是裸 `push`，否则 `push --set-upstream <第一个远端> <分支>`；游离 HEAD 给 `DETACHED_PUSH` | `:514` |
| `git_create_tag` | `root, name, message, revision` | `String`（标签名） | 说明非空走 `-a -m`，否则轻量标签；`revision` 空即 HEAD | `:535` |
| `git_branches` | `root` | `GitBranch[]` | `for-each-ref refs/heads` + `refs/remotes`；`<远端>/HEAD` 不列成一支，只把目标标 `defaultRef` | `:609` |
| `git_tags` | `root` | `GitTag[]` | `for-each-ref refs/tags`，附注标签取 `%(*objectname)` | `:640` |
| `git_remotes` | `root` | `String[]` | `remote` | `:686` |
| `git_ignored` | `root` | `String[]` | `status --porcelain --ignored=matching`，只留 `!! ` 行，取的是仓库相对路径 | `:688` |
| `git_checkout` | `root, branch` | `String`（stderr） | `checkout`，分支 / 标签 / 修订号共用这一条 | `:728` |
| `git_create_branch` | `root, name, from, checkout` | `String` | `checkout -b` 或 `branch <name> <起点>` | `:728` |
| `git_merge` | `root, name` | `String`（stdout） | `merge --no-edit` | `:757` |
| `git_rebase` | `root, onto` | `String` | `rebase <onto>`，非交互 | `:785` |
| `git_rename_branch` | `root, name, to` | `String`（新名） | `branch -m` | `:785` |
| `git_delete_branch` | `root, name` | `String` | `branch -d`（没合并的由 git 拦下） | `:799` |
| `git_delete_tag` | `root, name` | `String` | `tag -d` | `:813` |
| `git_push_ref` | `root, name` | `String` | `push <远端> <name>`；远端从引用名前缀或上游推出来 | `:854` |
| `git_delete_remote_branch` | `root, name` | `String` | `push <remote> --delete <branch>`，`name` 形如 `origin/x` | `:865` |
| `git_worktree_add` | `root, path, branch, new_branch` | `String` | `worktree add <path> <branch>`；`new_branch` 非空时先 `-b <new_branch>` 在那条引用上开新分支再签出（当前分支已被本工作树占着，直接签出必被拒）；branch 必须非空，空串是 `BAD_REV` | `:1270` |
| `git_ignore_rule` | `root, path` | `String` | `check-ignore -v` 的原样一行（`来源文件:行号:模式<TAB>路径`）；没被任何规则盖住时 git 退 1，这里回空串 | `:1317` |
| `git_restore_file` | `root, revision, path` | `String`（仓库相对路径） | revision 空时 `restore --worktree --`（从暂存区索引恢复，不碰索引），否则 `restore --source <rev> --worktree --` | `:1337` |
| `git_diff_text` | `root, left, right, path` | `String` | `diff --no-color --no-ext-diff`；`right` 空即工作树，`path` 空即整条提交 | `:921` |
| `git_diff_names` | `root, revision` | `GitNameStatus[]` | `diff --name-status -z <revision>`，即该引用对工作树；R/C 带旧路径 | `:966` |
| `git_rebase_continue` | `root` | `String` | `-c core.editor=true rebase --continue` | `:998` |
| `git_rebase_abort` | `root` | `String` | `rebase --abort` | `:1008` |
| `git_merge_continue` | `root` | `String` | `-c core.editor=true merge --continue` | `:1018` |
| `git_merge_abort` | `root` | `String` | `merge --abort` | `:1028` |
| `git_cherry_pick` | `root, revision` | `String` | `-c core.editor=true cherry-pick`；撞冲突停在 `CHERRY_PICK_HEAD` | `:1039` |
| `git_cherry_pick_continue` | `root` | `String` | `cherry-pick --continue` | `:1055` |
| `git_cherry_pick_abort` | `root` | `String` | `cherry-pick --abort` | `:1065` |
| `git_revert` | `root, revision` | `String` | `-c core.editor=true revert --no-edit`，做一笔相反的提交 | `:1076` |
| `git_revert_continue` | `root` | `String` | `revert --continue` | `:1098` |
| `git_revert_abort` | `root` | `String` | `revert --abort` | `:1108` |
| `git_reset` | `root, revision, mode` | `String` | `reset --soft/--mixed/--hard`；`mode` 只认这三个词 | `:1120` |
| `git_push_up_to` | `root, branch, revision` | `String` | `push <远端> <rev>:refs/heads/<branch>`，不加 `--force` | `:1141` |
| `git_resolve_conflict` | `root, path, side` | `String`（相对路径） | `checkout --ours/--theirs --` 再 `add --`；`side` 只这两个值 | `:1154` |
| `git_log` | `root, query` | `GitCommit[]` | `log --decorate=short -n<limit> --format=…`，`query` 见下 | `:1206` |
| `git_amend_targets` | `root` | `GitCommit[]` | `log -n20 HEAD --not --remotes`，即还没推出去的那几条 | `:1266` |
| `git_authors` | `root, limit` | `String[]` | `log -n<limit> --format=%an`，`limit` 钳到 1..2000，按各人最近一次出现排 | `:1351` |
| `git_commit_detail` | `root, revision` | `GitCommitDetail` | `show --no-patch --format=…` 取元信息，再 `show --format= --find-renames --numstat` 取行数、`diff-tree --no-commit-id --name-status -r -M` 取字母，按路径对齐 | `:1372` |
| `git_commit_file` | `root, revision, path` | `GitFileSides{original,modified}` | `path` 是仓库相对路径（其余文件类命令收绝对路径） | `:1515` |

`git_log` 的 `query` 对象：`reference`（分支 / 标签 / `a..b` 区间）、`author`、`text`、`regex`
（true 走 `--extended-regexp`，false 走 `--fixed-strings`）、`sinceMs`（转 `--since=@<秒>`）、
`path`（文件历史，放在 `--` 之后）、`limit`（钳到 1..500）。`author` 与 `text` 同时给时补 `--all-match`
取交集。空仓库那句 `does not have any commits` 不当错误，给空列表。`git_amend_targets` 同一条空仓库
判断也走空列表，遇到第一个合并提交截断。

## 终端与进程（12）

| 命令 | 参数 | 返回 | 副作用 / 事件 | 出处 |
| --- | --- | --- | --- | --- |
| `shell_probe` | — | `ShellInfo[]` | 不报错；第一条即没设置时用的那个 | `term.rs:92` |
| `term_open` | `cwd?, shell?, cols, rows` | `String`（`term-<n>`） | 起 PTY 与 reader 线程；发 `term://output{ id, data(base64) }`，EOF 时发 `term://exit{id,code}` | `term.rs:162` |
| `term_write` | `id, data` | `()` | 原样灌进 PTY，行编辑归 shell | `term.rs:252` |
| `term_resize` | `id, cols, rows` | `()` | 不改列数会让远端按旧宽换行 | `term.rs:262` |
| `term_close` | `id` | `()` | 先 kill 再摘表；`term://exit` 由 reader 线程补发 | `term.rs:279` |
| `term_reap` | — | `()` | 收掉上一回页面留下的全部会话 | `term.rs:294` |
| `proc_start` | `cwd, line, env` | `String`（`proc-<n>`） | `%COMSPEC% /D /C <line>`；`env` 逐条叠在继承来的父环境上，名字为空的条目跳过；两路输出都发 `proc://output`，退出发 `proc://exit{id,code}` | `proc.rs:83` |
| `proc_kill` | `id` | `()` | Windows 走 `taskkill /F /T /PID` 杀整棵树，再 kill 壳 | `proc.rs:162` |
| `run_tools` | — | `RunTools` | `mvn` / `gradle` / `java` 的本机位置与版本。先找 `mvnw` / `gradlew` 这类 wrapper，再退到 PATH。读得到就一直读，取不到给空字段而不是报错 | `run/detect.rs:296` |
| `run_detect` | `root` | `RunDetectOutcome{configs,problems}` | 扫工程出候选配置，二十四族：npm 脚本、pom / gradle 两族、Go 可执行包（`wails.json` 那份出 `wails dev`，并且该模块以下的前端 `package.json` 不再出 npm 条目）、Cargo 可执行目标、Python（框架优先：`manage.py` → fastapi → streamlit → flask → `python -m <包>` → 带入口守卫的脚本）、.NET / F# 可执行项目、PHP（artisan → composer 脚本 → 内置服务器）、Ruby（`bin/rails` → `bundle exec rails` → rackup → Sinatra）、Dart / Flutter、sbt、mix（Phoenix 走 `phx.server`）、C / C++（CMake 把配置那步带上：`cmake -S . -B build && cmake --build build`；Makefile 只在本层没被别的构建文件认领时才喊）、Zig、Deno tasks、Clojure（`clojure -M[:dev]` / `lein run`）、Haskell（Stack / Cabal）、Julia、Lua（LÖVE 或根上 `main.lua`）、Swift 可执行目标，外加没有构建文件时的裸 `.java`（JDK 单文件启动）、根上 `main.py` / `app.py` / `run.py`、根上 `run.sh` / `start.sh` / `dev.sh`。npm 那条出的是 `<包管理器> run <脚本>`（按 `bun.lock` / `pnpm-lock.yaml` / `yarn.lock` / `package-lock.json` 认客户端），不是脚本正文——脚本里的 `vite`、`vue-cli-service` 装在 `node_modules/.bin`，只有包管理器会给子进程加这条 PATH。深度 4 层、跳过构建与依赖目录、读满 4000 个源文件就停手并把 `TOO_MANY_SOURCES` 报进 `problems`，不静默交一份不全的表。非 JVM 那几族的程序名按裸名存，PATH 上没有就标 `unavailable`（`NO_TOOL`）。有六族额外带 `markers`（源文件相对路径 + 1 起行号），给编辑器装订线那颗 ▶ 用：npm 的每条脚本键、Java 主类的类声明行与 `main` 行两处、Spring 继承它盖住的那个注解类的那两处、Go 的 `func main`、Cargo 的 `fn main`、Python 的 `if __name__ == "__main__"`；构建目标那一类（`clean package`、`build`、`cargo build`、`mix run` 这些）不带，它没有「声明它的那一行」| `run/detect.rs:1963` |
| `run_state_load` | `root` | `ProjectRunState` | 按工程键读 `runConfigs.json` 那一份；只落用户自己建的条目与三个 id 列表 | `run/store.rs:72` |
| `run_state_save` | `root, state` | `()` | 写盘前过一遍 `keepable`：识别出来的、没有命令的都不留 | `run/store.rs:87` |

## 语言服务（12）

会话身份是 `<窗口>::<server 键>::<根>` 三段拼接的字符串，它同时就是 `lsp_write` / `lsp_stop` 接收的 id。
`program` / `args` / `root` 由前端按 `lsp.json` 计算后传入，后端不再自行读取配置，避免两处口径不一致。
探测（`lsp_probe`）与安装（`lsp_install`）不触碰会话，只修改配置并执行一次性命令。

| 命令 | 参数 | 返回 | 副作用 / 事件 | 出处 |
| --- | --- | --- | --- | --- |
| `lsp_start` | `window, server, root, program, args` | `String`（会话 id） | 启动进程（三路管道、非 PTY）与两条读线程；启动前先按配置扫描空闲会话与总数上限；身份已在表内时直接返回原 id，不重复启动；同一身份正在启动时后到的请求等待其结果（条件变量，不重复 spawn）。找不到可执行文件返回 `LSP_NOT_FOUND`，spawn 失败返回 `LSP_SPAWN`，管道未建立返回 `LSP_IO`；退避期内返回 `LSP_START_BACKOFF`（剩余等待毫秒数、上次失败原因），连续失败超过 2 次返回 `LSP_START_LIMIT`。发送 `lsp://message{id,body}`、`lsp://log{id,text}`、`lsp://exit{id,code}` | `lsp.rs:341` |
| `lsp_write` | `id, body` | `()` | 补齐 `Content-Length` 头（按字节数）后写入 stdin，同时将该会话的「最后使用时间」更新到当前时刻；会话已回收时返回 `LSP_GONE` | `lsp.rs:616` |
| `lsp_stop` | `id` | `()` | 先执行 `taskkill /F /T /PID` 终止整棵进程树，再结束壳进程；`lsp://exit` 由读线程补发 | `lsp.rs:637` |
| `lsp_reap` | — | `()` | 回收上一次页面遗留的全部会话，不报错 | `lsp.rs:671` |
| `lsp_session_statuses` | `window?` | `SessionStatus[]` | 只读，实时采集：`try_lock` + `try_wait`。`running` 仅表示进程存在，不表示服务器已完成索引；锁被占用时上报 `running` 并附「本轮未采集到」；从未启动成功的条目按失败记录合成一条 `dead`，id 前缀与当前窗口不符时不列出；按 server、根排序 | `lsp.rs:698` |
| `lsp_failed` | `id, message` | `()` | 供前端上报握手超时等情况，计入同一套退避记录，不报错 | `lsp.rs:801` |
| `lsp_retry` | `id` | `()` | 手动重试：回收残留会话并清除失败记录，下一次 `lsp_start` 可立即重试 | `lsp.rs:811` |
| `lsp_config_load` | — | `LspConfig` | 读取 `<app_config_dir>/lsp.json`；文件不存在时按种子生成一份，并顺带迁移同目录 `settings.json` 中的 `lsp` 段；JSON 解析失败同样回退为种子并重写文件，不报错 | `lsp_config.rs:576` |
| `lsp_config_save` | `config` | `()` | 归一化（非法档位与空字段按种子补齐）后 `to_string_pretty` 原子写入 `lsp.json`，目录不存在时先创建 | `lsp_config.rs:582` |
| `lsp_resolve_root` | `server, workspaceRoot, file?` | `RootHit{root,marker}` 或 null | 按配置中的 `rootMarkers` 确定真正的项目根：先从文件所在目录向上查找（不越过 `workspaceRoot`），未命中时再从 `workspaceRoot` 向下扫描 2 层，跳过 `node_modules` / `.git` / `target` / `dist` / `build` / `out` / `vendor` / `__pycache__` / `.venv`；标志表为空时直接返回 `workspaceRoot`；结果缓存 60 秒；目录不存在或未命中一律返回 null，不报错 | `lsp_detect.rs:215` |
| `lsp_probe` | — | `LspProbeReport{config,servers[]}` | 逐项探测是否已安装：进程 PATH 加几个常用安装位置（`%APPDATA%\npm`、`WindowsApps`、`~/.cargo/bin`、`~/go/bin`、`/usr/local/bin`、`/opt/homebrew/bin` 等），按 `PATHEXT` 构造候选并补充 `.ps1`，rust-analyzer 额外执行一次 `--version` 以排除占位垫片；单次结果缓存 10 秒。档位不是 `off` 而本机未安装的一律落回 `off`（编辑器换成 CodeMirror 之后没有「渲染进程里的内置语义」可退，`builtin` 与 `lsp` 都得真起一条进程，故两档同规矩，`lsp_probe.rs:353`），安装完成后不自动启用；确有改动才写回 `lsp.json`（无改动不落盘），校正后的配置随报告带回；不报错 | `lsp_probe.rs:310` |
| `lsp_install` | `server` | `InstallResult{command,output,exitCode}` | 使用系统 shell 执行配置中的 `installCommand`（Windows `%COMSPEC% /D /C`，其余 `/bin/sh -c`），不设超时（全局安装通常需要数分钟）；输出只保留尾部 32 KiB。该项不存在回 `LSP_NO_SERVER`，未配置安装命令回 `LSP_NO_INSTALL`，shell 无法启动回 `LSP_INSTALL_SPAWN` | `lsp_probe.rs:316` |

## 设置与系统（7）

| 命令 | 参数 | 返回 | 副作用 / 事件 | 出处 |
| --- | --- | --- | --- | --- |
| `settings_load` | — | `Settings` | 文件缺失或 JSON 坏都静默退回默认值，不报错（读宽容，只为应用起得来；写的那条路严格，见 `settings_save`） | `settings.rs:330` |
| `settings_save` | `patch` | `Settings` | 把这份 JSON Merge Patch（RFC 7396）合并进 `<app_config_dir>/settings.json` 现有内容：只覆盖出现的键，读不懂的旧段落原样留着；底稿读不出来就报错，不拿空对象覆盖。合并结果先按结构校验，再 `to_string_pretty` 经 `write_atomic` 原子写（先 `.tmp` 再改名），进程内用 `SETTINGS_LOCK` 串起读-合并-写。只在本次合并把 AI 助手从开变成关时先 `stop_for_disable`。返回合并后的全量设置，调用方跟着它走 | `settings.rs:384` |
| `history_load` | — | `History` | 读 `<app_config_dir>/history.json`；文件不存在时从同目录 `settings.json` 迁移那四项并立刻落盘；JSON 坏同样退回空表并重写，不报错 | `history.rs:111` |
| `history_save` | `history` | `()` | 整份 `to_string_pretty` 经 `write_atomic` 写 `history.json`，目录不存在先建 | `history.rs:107` |
| `tray_labels` | `show, quit` | `()` | 改托盘两项文字；菜单是系统画的 | `tray.rs:69` |
| `app_exit` | — | `()` | 清看门狗标志后 `app.exit(0)`；由前端存完盘调用 | `tray.rs:123` |
| `sys_memory` | — | `Memory{appMb,totalMb,parts[]}`，`parts` 一档 `{kind,program,mb,count}` | kernel32 一次进程快照，按 `ppid` 从自身往外收全部后代，逐个读**私有工作集**（不是工作集：工作集含共享页，WebView2 那几台进程相加会虚高几百 MB）后归并成 host / webview / child 三档，单位 MB。读不到的进程按 0 计，父进程先退导致 `ppid` 链断掉的子树不计；非 Windows 三个值全为 0 | `sys.rs:369` |

## AI 运行时与 Claude 配置（5）

五条都是 `async`，命令体经 `block` 跑在阻塞线程池上；参数沿 IPC 用 camelCase。
checkpoint 的两条不在外层拿 `IO_LOCK`：锁由 `checkpoint::append_event` 整批拿一次，
普通 `Mutex` 不可重入，外层再拿会挂死批准动作。

| 命令 | 参数 | 返回 | 副作用 / 事件 | 出处 |
| --- | --- | --- | --- | --- |
| `ai_cli_hooks_read` | `provider` | `{path, hooks}` | Claude 读 settings.json，Codex 读 CODEX_HOME/hooks.json；缺文件或键回空对象，坏文件/树结构报错 | `ai_cli/settings.rs` |
| `ai_cli_hooks_save` | `provider, hooks, expected` | `{path, hooks}` | 校验命令字段和 Codex 事件约束；比较基线 expected，外部改动拒绝覆盖；只替换 hooks，其余字段保留，写前备份并原子落盘 | `ai_cli/settings.rs` |
| `ai_cli_codex_hooks_status` | — | 原生 `HooksListResponse`（data 含 hooks/errors/warnings） | 只读 hooks/list，返回来源、启停、信任与诊断；不创建线程、不调用模型、不写信任配置 | `ai_cli/settings.rs`、`ai_runtime/options.rs::codex_hooks` |
| `ai_session_checkpoint_save` | `sessionId, workspace, paths[]` | `{id, files[]}` | 把目标文件的当前内容存成快照：单文件 8 MiB、一次最多 32 个文件、只收绝对路径、按大小写不敏感去重；落 `checkpoints/<id>/`，向会话日志追加 `checkpoint` 事件并广播 | `ai_runtime/mod.rs:2781` |
| `ai_session_checkpoint_restore` | `sessionId, workspace, checkpointId` | `{restored, undo}` | 先把相关文件现状存成新快照（`source: "restore"`、`restoreOf` 指回来源）并追加事件，再写回目标文件；`checkpointId` 必须以 `ckpt-` 开头 | `ai_runtime/mod.rs:2801` |

## 内置浏览器（8）

八条都是 `async`，是界面这一侧唯一的入口。AI 那一侧不走命令：`forge-browser-mcp` 子进程经命名管道向宿主发请求
（管道名 `\\\\.\\pipe\\forge-browser-<pid>-<nonce>`，SDDL 只放当前登录用户），两端共用同一套 `Grant` 与票据语义，
方案与取舍见 [../plans/browser-use/](../plans/browser-use/)。每次改动页面状态后统一发 `forge-browser-changed{}`，
载荷是空的，面板只把它当「重新拉一次 `browser_panel_state`」的信号；AI 自己开页时另发一条
`forge-browser-open{workspace,tabId}`，那条不经命令，由管道那头的 `browser_tabs{action:"open"}` 发，
面板据此把侧栏切到这张页（`src/App.tsx:4029`）。

命令只在 AI 助手开着时才干活：`browser_panel_state` 直接读设置里的总开关，其余七条经 `sync_capability`
（`browser/mod.rs:279`）——它读一次磁盘上的有效能力，同时把结果写回内存镜像 `enabled`；派发复查只读那份镜像，
所以「应用起来之后才打开浏览器」必须走过这条才生效。宿主起不来（管道被拒、companion 版本与清单对不上、随机数失败）
不把整个应用一起拖停：原因记进 `State::unavailable`（`browser/mod.rs:104`），由 `available:false` 显示、
由 `attach` 退回不注入（`browser/mod.rs:230`）。

每张页有两把串行锁：`queue` 是 AI 动作与地址栏、查找、缩放、调试按钮共用的那一队；`picker.queue` 是选取与批注那一队，
不等 AI，取消要能立刻响应。`revision` 是授权代际：改权限、导航、缩放、样式都 +1 并清空 `refs`，在途 AI 请求据此判死；
`epoch` 是文档代际，导航即 +1。元素引用（`s{序号}n{backendNodeId}`）只在当前代际里有效。

| 命令 | 参数 | 返回 | 副作用 / 事件 | 出处 |
| --- | --- | --- | --- | --- |
| `browser_panel_state` | `workspace` | `{available,unavailable,version,tabs[],runs[]}` | 只读，不动任何状态。`available` 是「跑在 Windows 上 + broker 没停 + 没有不可用原因」三条与，不是「开没开页」；`tabs` 是 `Tab` 的投影（`id/order/sessionId/workspace/url/title/loading/loadError/zoom/emulation/previewScale/grant/epoch/revision/managed/allowedOrigin`），只列该 workspace 的页、按 `order` 排；`runs` 列该 workspace 现存的授权租约 `{sessionId,runId,readOnly}`。`workspace` 先过 `ai_runtime::browser_workspace`（必须是存在的绝对目录，Windows 上 canonicalize 后取小写）。总开关关着回 `BROWSER_DISABLED` | `browser/mod.rs:672` |
| `browser_panel_open` | `workspace, sessionId, url` | `String`（页面 id） | 建一张**用户页**（`managed:false`），建出来那一刻就是私有（`grant:"none"`）；`sessionId` 长 1..128 字节，否则 `BROWSER_SESSION`，非 `manual` 时随后 `browser_panel_grant(Control)` 再导航；`url` 先过 `forge_browser::navigation_url`（只认 http(s)、不许内嵌凭据、拦元数据与链路本地等地址）；建页、授权、导航任一步失败都调 `browser_panel_close` 回收，不留没有回收入口的孤儿视图；发 `forge-browser-changed` | `:686` |
| `browser_panel_navigate` | `tabId, url` | `()` | 用户主动导航，排在动作队列里；先 `revision += 1` 并清 `refs`（这是在途 AI 请求的取消令牌），授权按用户此前选的留着，私有页不会自动重新共享；非托管页把 `allowedOrigin` 挪到新 URL 的 origin，所以同站历史不会因这条被撤权；页不在回 `TAB_CLOSED`；发 `forge-browser-changed` | `:728` |
| `browser_panel_grant` | `tabId, grant` | `()` | `grant` 三档：`"none"` / `"read"` / `"control"`；改档一律 `revision += 1` + 清 `refs`，AI 手里的元素引用当场作废；非托管页同步 `allowedOrigin`（`none` 清空，其余取当前 URL 的 origin）；只改内存里的授权，不碰原生视图也不导航；发 `forge-browser-changed` | `:763` |
| `browser_panel_show` | `tabId?, bounds{x,y,width,height}` | `()` | 有 id 走 `emulation::present`（把这张页摆到面板让出的那块区域；尺寸真的变了才重设设备指标并发 `forge-browser-changed`），无 id 落到默认 surface 只挪位置；四个数都要有限、绝对值 ≤ 20000，宽高 ≥ 1，否则 `BROWSER_BOUNDS` | `:785` |
| `browser_panel_close` | `tabId` | `()` | 顺序是「先撤权、再关视图」：`grant:"none"` + 清 `refs`，AI 立刻看不见这张页；视图关成功才从 `tabs` 摘掉，关失败就把 id 记进 `pending_close` 等下一次重试而条目留着——一次失败不能让这张页永久没有回收入口；`working` 里那条**故意不清**：关掉工作页之后 AI 必须收到 `TAB_CLOSED`，而不是悄悄落到当前活动页；发 `forge-browser-changed` | `:829` |
| `browser_panel_details` | `tabId` | `{canGoBack,canGoForward,console[],network[],dialog,picker}` | 只读诊断，不进动作队列：AI 正占着页面时工具栏的接管与停止照样点得动；两格历史是现问 `Page.getNavigationHistory` 算出来的。`console` 与 `network` 各是 200 条封顶的队列（满了丢最旧）；`dialog` 只给同源弹窗的正文，跨 origin 的那律只报 `scope:"denied-frame"` 不给内容；`picker` 是选取状态，其中 `error` 是带码原文，界面过一遍 `describeError`。原生页面没有调这条 IPC 的权限 | `:866` |
| `browser_panel_command` | `tabId, command` | `Value`（各档不同，无返回的给 `null`） | 地址栏、查找、缩放、调试按钮共用这一条和那张动作队列，不接受任意 CDP 命令。`command` 是 `{"action":…}` 标签联合（`deny_unknown_fields`，键一律 camelCase）：`back` / `forward`（没有对应条目回 `BROWSER_NO_HISTORY`）、`reload`、`stop`——这四条都先走一遍 `browser_panel_grant` 抬代际打断在途请求，只有 `stop` 把授权降到 `none` 并落 `loading:false`，同站历史与刷新保留权限；`clearConsole` / `clearNetwork` 只清本页那两条队列；`devtools`；`zoom{factor}` 钳在 0.5..2.0，越界 `BROWSER_ZOOM`，改的是设备像素比所以也 +1 代际；`find{text,backward}` 在隔离世界 `forge-user-find` 里调 `window.find`，回 `{found}`，文本 256 字封顶（`BROWSER_FIND_LIMIT`）；`dialog{accept,text}` 输入 4000 字节封顶（`BROWSER_DIALOG_LIMIT`）；`screenshot` 按设备视口裁一次回 `{dataUrl}`，正文 8 MiB 封顶（`BROWSER_PICK_LIMIT`）；`elementScreenshot{selectionId}`；`clearSelection{selectionId}`；`annotationResult{selectionId,error}`——`error` 为空即交付成功、清掉标记，否则把理由回投批注浮层并原地留草稿可重试；`inspect{enabled}`；`emulate{options}`。后三类不进 AI 那一队：取消选取与回投批注结果必须即时响应。`emulate` 先校验再动代际，非法输入改变不了页面状态。末尾发 `forge-browser-changed` | `:893` |

## 代码

| 文件 | 内容 |
| --- | --- |
| `src-tauri/src/lib.rs` | 注册表全表 `:88-299`；`browser::browser_panel_*` 八条打头 `:89-96`、`fs` 段 `:97-110` 加 `:115-116`、`local_history` 段 `:111-114`、`watch` 段 `:117-118`、`git` 段 `:119-166`、`term` / `term_layout` / `proc` 段 `:167-179`、run 那几条 `:180-185`、`lsp` 族 `:186-197`、`history` / `settings` / `shell_open` / `tray` / `sys` 段 `:198-208`、`update` 段 `:209-216`、AI 那几族 `:217-298`。Tauri 的命令宏不穿 `pub use`，那几条 run 命令按 `run::detect::…` / `run::store::…` / `run::dep_sync::…` 全路径注册；`browser::init` 挂在 setup `:73`，`browser::shutdown` 挂在退出清理 `:309` |
| `src-tauri/src/browser/mod.rs` | `Grant` `:49-55`、`Tab` 与 `#[serde(skip)]` 那几格 `:56-93`、`State`（endpoint / unavailable / pending_close / enabled 四样都在这张表里）`:104-`、`init` 只登记状态 `:138`、`start` 的版本闸与管道名 `:147`、`attach` 的三重早退 `:230`、`permissions_changed` 的撤权与遮罩复位 `:246`、`shutdown` `:268`、`changed` 发的事件 `:272`、`sync_capability` `:279`、`settings_saved` `:290`、`create` 的 16 页上限与两处回滚 `:428-482`、`managed_private_target` `:495`、八条命令 `:672-994`、`panel_tab` `:847` 与主线程只读镜像的 `panel_tab_mirror` `:856`、`PanelCommand` `:878-889`、`Bounds` `:665` |
| `src-tauri/src/browser/surface.rs` | `ui()` 的放弃标志（超时之后 closure 不再派发）`:6-`、`create` `:86`、`cdp` 的派发复查 `:298`、`show` `:385`、`close` `:449`；非 Windows 那一组空实现 `:529-556` |
| `src-tauri/src/browser/launch.rs` | `companion()` 两档文件名（先 `<stem>-<target triple>.exe`，再 cargo 的裸名）`:8`、`environment()` 注入 endpoint 与 token `:69` |
| `src-tauri/crates/forge-browser/src/lib.rs` | `VERSION` 用 `CARGO_PKG_VERSION` `:8`、`private_literal_target`（RFC1918 与 CGNAT 四类）`:135`、`navigation_url` 的协议 / 凭据 / `restricted_host` 三道 `:152-164` |
| `src-tauri/src/fs/mod.rs` | `EDITOR_CEILING` 8 MiB `:50`、`read_file` 与编码判定 `:271-275`、`create_file_impl` 的 `create_new` `:487`、`copy_tree` `:543`、`move_entry_impl` 的跨盘那段 `:587`、`delete_entry` 的回收站与降级 `:609-672`、`fs_allow_asset` 的递归授权 `:809` |
| `src-tauri/src/fs/search.rs` | 阈值常量 `:15-32`（`SCAN_CAP` 200_000、`MAX_DEPTH` 24、`TEXT_SIZE_CEILING` 20 MiB、`SNIFF_BYTES` 4096、`DEFAULT_PAGE` 100、`MAX_LIMIT` 5000、`MATCH_CAP` 2000、`SNIPPET_CHARS` 240）、剪掉的目录名 `:34-47`（含 `dist`）、`score_name` 四档 `:79-99`、`page_limit` `:130-136`、`find_files_at` 的排序与截断 `:179-193`、`TextOptions` `:211-224`、`build_matcher` 的 `BAD_REGEX` `:352-365`、`wildcard` `:368-394`、`snippet` `:419-433`、`skipped` 的四类 `:481-500`、单测 `scan_prunes_build_directories` `:705-727` |
| `src-tauri/src/git/mod.rs` | `run_git` 的三条前缀参数 `:152-166`、`fail` 先 stderr 后 stdout `:172-178`、`relative_path` 与 `NOT_IN_REPO` `:203-221`、`remote_op` 回 stderr `:485-496`、`valid_branch_name` `:702-711`、`parse_refs` 的 `<远端>/HEAD` `:572-606`、`git_ignored` 的 `!! ` 行 `:694-699`、`GitLogQuery` `:1177-1194`、`bound` 的 `@<秒>` `:1197-1203`、`git_log` 的参数拼装与空仓库判断 `:1205-1261`、`valid_rev` `:1340-1347`、`valid_relative` `:1506-1512` |
| `src-tauri/src/term.rs` | `shell_probe` 的探测顺序 `:91-130`、`resolve_shell` `:145-158`、`term_open` `:161-217`、`read_loop` `:220-248`、`term_reap` `:293-299` |
| `src-tauri/src/proc.rs` | `shell_command` `:52-60`、`pump` 的 8192 字节一块 `:62`、`proc_start`（含逐条 `command.env`）`:83-137`、`wait_and_finish` 的 80ms 轮询 `:140-160`、`proc_kill` 的 `taskkill /F /T` `:162-182` |
| `src-tauri/src/run/mod.rs` | `RunKind` `:14-63`（二十四族：npm / maven / gradle / spring / java / go / wails / rust / python / dotnet / php / ruby / dart / scala / elixir / cpp / zig / deno / clojure / haskell / julia / lua / swift / shell）、`EnvVar` `:68`、`HelperFile` `:77`、`Unavailable` `:85`、`RunConfiguration` `:95` |
| `src-tauri/src/run/detect.rs` | 边界常量 `:47-68`、`RunDetectOutcome` `:74-77`、`Tools` `:83-90`、`MainClass`（带装订线落点）`:106-117`、`npm_client` 的锁文件认客户端 `:152`、行号三件套 `line_at :176` / `line_of :186` / `object_key_lines :201`（数 JSON 里每个键主张在哪一行）、`has_main_method :375`、`jvm_markers :390`、`is_go_main_package :407`、`is_python_entry :418`、`program_missing`（非 JVM 那几族的缺工具判定）`:427`、`python_program :438`、`toml_tables :449`、`run_tools`（`async`，命令体经 `offload::block_value`）`:533`、`tools_cached :541`、`tool` 的 wrapper 优先与缺工具 `:616-648`、`location` 的相对参数 `:649`、npm `:661`、maven `:728`、gradle `:815`、`bare_java :913`、主类扫描 `:957`、`java_exec_script :1033`、golang（含 `wails.json` 那条早退）`:1062`、`go_main_packages :1124`、`marker_at`（一个源文件里那条模式所在的行）`:1191`、rust `:1203`、python `:1286`、`python_marker :1380`、`python_package_entry :1387`、`bare_python :1408`、dotnet `:1431`、`push_simple`（长尾那十几族共用的一口）`:1485`、php `:1505`、ruby `:1559`、dart `:1600`、scala `:1616`、elixir `:1623`、native（CMake 与 Makefile）`:1652`、zig `:1686`、deno `:1705`、clojure `:1750`、haskell `:1768`、julia `:1785`、lua `:1805`、swift `:1819`、`source_where :1869`、`bare_shell :1906`、`kind_rank :1932`、`run_detect`（`async`，命令体经 `offload::block`）`:1963`、`run_detect_impl`（真正干活的那层，单测直接调它）`:1967-2015` |
| `src-tauri/src/run/store.rs` | `ProjectRunState` `:24-33`、`run_state_load` `:72`、`keepable` `:81`、`run_state_save` `:87-117` |
| `src-tauri/src/lsp.rs` | 缓冲上限常量、会话表与 `Session`（含 `last_used_ms`）、失败记录 `Failure` 与 `RESTART_LIMIT` 2、`backoff` 的 `5s*2^n` 封顶 300 秒 `:84`、`SessionStatus` `:139`、`parse_args` 的双引号规则 `:168`、`build_command` 的 `.cmd` / `.bat` 走 `cmd /C` `:198`、`session_id` 三段拼接 `:222`、起锁 `:241`、`backoff_error` `:260`、`sweep` 的空闲回收与 LRU 淘汰 `:297`、`spawn_session`（含 `env_remove` 那两条调试器变量）`:382`、`read_loop` 的 `Content-Length` 解帧 `:459`、`stderr_loop`、`take_message` `:575`、`stop_one` 的 `taskkill /F /T`、`lsp_session_statuses` 的现采与合成 `:698`、单测。模块级设计与取舍见 [../features/lsp-language-servers/](../features/lsp-language-servers/) |
| `src-tauri/src/lsp_config.rs` | `LspServerConfig` / `LspConfig`、`allowed_modes`、种子表、`DEFAULT_MAX_SESSIONS` `:354` 与 `DEFAULT_IDLE_TIMEOUT_MIN` `:356`、`default_config` `:371`、`effective_program` 的 path 优先、`normalize`、`clamp`、`migrate_from_settings`、`load_in` `:491`、`save_in` `:529`、探测结构 `LspServerProbe` / `LspProbeReport`、两条命令 `:576` 与 `:582`、单测 |
| `src-tauri/src/lsp_probe.rs` | `PROBE_TTL` 10 秒 `:21`、`OUTPUT_TAIL` 32 KiB `:24`、`candidates` 的 `PATHEXT` 与补 `.ps1`、`search_dirs` 的补目录、`augmented_path` `:150`、`is_functional` 的 rust-analyzer `--version`、`resolve_command` 与缓存 `:190`、`run_install` 的 shell 选择与按字符取尾、`probe_and_reconcile` 的单向校正、两条命令 `:310` 与 `:316`、单测 |
| `src-tauri/src/lsp_detect.rs` | `CACHE_TTL` 60 秒 `:16`、`MISS_TTL` 5 秒 `:19`、`CACHE_LIMIT` 512 `:21`、`MAX_DEPTH` 2 `:23`、`SKIP_DIRS` 九项 `:25`、`marker_matches`（`*` 前缀名）、`hit_in`、`search_up`、`search_down`、`resolve` 的标志表为空原样回根 `:146`、`cached`、命令壳 `:215`、单测 |
| `src-tauri/src/settings.rs` | `read` `:320`、`settings_load` `:330`、`read_document` `:339`、`apply_patch` `:359`、`settings_save` `:384`（按字段合并落盘；`lsp` 段已搬去 `lsp.json`，历史四项已搬去 `history.json`，旧文件里那些键读到就原样留着） |
| `src-tauri/src/history.rs` | `History` 字段（含 `openFolders` / `activeFolder`）、`migrate_from_settings`、`load_in` / `save_in`、`read`、`history_load` `:111` / `history_save` `:117`、单测（缺字段回落默认、多根字段往返） |
| `src-tauri/src/tray.rs` | `tray_labels` `:68-76`、`app_exit` `:122-126` |
| `src-tauri/src/ai_runtime/checkpoint.rs` | 上限 `MAX_FILE_BYTES` 8 MiB 与 `MAX_FILES` 32 `:16-18`、`normalize_paths` `:35`、`take_snapshot` `:54`、`record` `:88`、`restore` `:98`、`append_event` `:127`、链式恢复测试 `:181` |
| `src-tauri/src/ai_cli/settings.rs` | `hooks_path`、`read_hooks_at`、`save_hooks_at`、`ai_cli_hooks_read` / `ai_cli_hooks_save` / `ai_cli_codex_hooks_status` |
| `src-tauri/src/sys.rs` | `hide_console` 的 `CREATE_NO_WINDOW` `:5-11`、`write_atomic` 的 tmp+rename `:25-33`、`which_program` 的 Windows 扩展名候选 `:65-76`、`capture_text`（stdout 空了取 stderr）`:80-101`、`group` 的 ppid 走树与按程序归并 `:154-212`、`win::private_set_of` `:305-316`、`win::snapshot` `:319-341`、`sys_memory` `:369-376`、单测 4 条 `:378` 起 |
| `src-tauri/src/watch.rs` | `SETTLE` 150ms `:20`、`MAX_WAIT` 1s `:24`、`BATCH_CAP` 256 `:28`、`FsChange{root,paths}` `:33-36`、`WatchSlot` `:45`、`ignorable_git_internal` `:89`、`fs_watch_start` `:174-264`、`fs_watch_stop` `:261-283` |
| `src/lib/fs.ts` | `findFiles` / `searchText` `:226-233`、搜索结果的 TS 镜像 `:147-223` |
| `src/lib/lsp.ts` | 会话状态、探测报告、安装结果、根命中的 TS 镜像 `:26-68`、十二条命令的封装 `:71-132`（`lspStart` 收 `window` / `server` / `root` / `program` / `args` `:71`） |
| `src/lib/lspConfig.ts` | `LspMode` 与两份结构的镜像 `:12-46`、`modesFor` `:49`、`programOf` 的 path 优先 `:54`、`serverEntries` / `serverForLanguage` `:59-70`、读写两条封装 `:72-83` |
| `src/lib/errors.ts` | LSP 那九条码（`:78-89`）的文案见 [error-model.md](./error-model.md) 的稳定代码表 |
