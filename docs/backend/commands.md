# 命令契约

逐条对着 `src-tauri/src/lib.rs` 的注册表与各模块签名核过，共 96 条。出处列给命令自己的行号。
参数一律写前端传的 camelCase 名（映射规则见 [README.md](./README.md)）。
发事件的命令只有四条：`fs_watch_start` 起的那条转发线程发 `fs://change`，`term_open` 的 reader 线程发
`term://output` / `term://exit`，`proc_start` 的转发与轮询线程发 `proc://output` / `proc://exit`，
`lsp_start` 的两条读线程发 `lsp://message` / `lsp://log` / `lsp://exit`。
`app://flush` 由窗口关闭事件和托盘菜单的「退出」触发，不经命令。其余写命令不发事件：磁盘上的动静统一经
`fs://change` 回来，git 状态由前端在写完之后再调一次 `git_status`。

## 文件与目录（17）

`find_files` / `search_text` 已接进界面：`src/lib/fs.ts` 的 `findFiles` / `searchText` 各包一条，发出调用的
只有 `src/components/SearchEverywhere.tsx` 一处（文件页签发 `find_files`，文本页签发 `search_text`，全页签两条
并发）。底部 `src/components/FindPane.tsx` 不再发查询，画的是弹层交过来的那一整页。挂点与键位见
[../features/search/](../features/search/)。两条都是 `async` 命令，只读，一趟扫完即回，不带游标，也没有取消句柄。

| 命令 | 参数 | 返回 | 副作用 / 事件 | 出处 |
| --- | --- | --- | --- | --- |
| `list_directory` | `path` | `DirectoryListing` | 无 | `fs/mod.rs:150` |
| `read_file` | `path` | `FileContent` | 读；超过 8 MiB 给 `TOO_LARGE`，是目录给 `IS_DIR`；非 UTF-8 里含 NUL 的给 `BINARY`，其余给 `NOT_UTF8` | `fs/mod.rs:195` |
| `write_file` | `path, contents, lineEnding?, hasBom?` | `FileContent` | 写盘，`modifiedMs` 是写完之后的值；监听随即报 `fs://change` | `fs/mod.rs:233` |
| `create_folder` | `path` | `FsEntry` | 单层创建，父目录不在则 `IO` | `fs/mod.rs:267` |
| `create_file` | `path` | `FsEntry` | `File::create` 语义：路径上已有文件会被截成空文件，前后端都不查重名 | `fs/mod.rs:273` |
| `rename_entry` | `from, to` | `FsEntry` | `to` 存在则 `TARGET_EXISTS`，源不动 | `fs/mod.rs:279` |
| `copy_entry` | `from, to` | `FsEntry` | 目录走 `copy_tree` 递归整棵子树，其余（文件、符号链接）交给 `fs::copy` | `fs/mod.rs:305` |
| `move_entry` | `from, to` | `FsEntry` | 同盘即 rename；跨盘复制后删源，删不掉给 `MOVED_WITH_SOURCE` | `fs/mod.rs:316` |
| `delete_entry` | `path` | `()` | 永久删除，目录递归；不进回收站 | `fs/mod.rs:329` |
| `reveal_entry` | `path` | `()` | Windows 起 `explorer /select,<path>` | `fs/mod.rs:343` |
| `file_stamp` | `path` | `FileStamp{size,modifiedMs}` | 不读正文；图片预览靠它换缓存串 | `fs/mod.rs:357` |
| `fs_allow_asset` | `root` | `()` | 把该目录连子树加进 asset 允许名单，不落盘 | `fs/mod.rs:373` |
| `open_external` | `url` | `()` | `ShellExecuteW`，不经 cmd。入参先过白名单：协议只认 `http` / `https` / `mailto` / `tel`，其余写法（`file:` / `ms-msdt:` / `javascript:` …）与盘上不存在的路径、可执行后缀（`.exe` / `.lnk` / `.ps1` …）一律 `EXTERNAL_BLOCKED`。markdown 里的链接是外部输入，不能让它决定执行什么 | `fs/mod.rs:381` |
| `find_files` | `root, query, limit?, filter?{showHidden,ignored[]}` | `FileHits{query,items[],truncated}` | 按名字找文件与目录。名字打分四档：全等 4 > 前缀 3 > 包含 2 > 逐字顺次出现 1；排序按档位降序、路径短的在前、再字典序。剪掉 `.git` / `node_modules` / `target` / `dist` / `build` / `out`，不跟软链，深 24 层、访问 200_000 条目封顶，匹配攒到 2000 条即停，触闸置 `truncated`。`filter` 是可见性闸门（`ScanFilter`）：`showHidden` 为假时剪掉隐藏项，`ignored` 里那些绝对前缀之下的路径整棵剪掉，两者都在扫描层生效、不占条目与命中预算。`limit` 传 0 或缺省走 100 条那档，钳到 1..5000；词全空白回空表不报错；`root` 不是目录给 `NOT_DIR` | `fs/search.rs:253` |
| `search_text` | `root, query, options{caseSensitive,wholeWords,regex,fileMask,limit}, filter?{showHidden,ignored[]}` | `TextPage{query,hits[],files,truncated,skipped}` | 逐文件扫正文。每条命中带 `line`（1 起）、`snippet`、`snippetFrom`（片段首字符在原行里的列号）和这一行的 `ranges{column,length}`（1 起、按字符数）；片段最长 240 字符，整行超过它就以首处命中为中心截。单文件 20 MiB 封顶，开头 4096 字节里见 NUL 当二进制跳过；太大、二进制、非 UTF-8、读不到四类合并计入 `skipped`。`filter` 同 `find_files`，剪掉的项不计入 `skipped`。`fileMask` 逗号或分号分隔、只认 `*`、空表示不限；`wholeWords` 只在非正则下生效；`regex` 为真时词编不成正则给 `BAD_REGEX`；`limit` 同 `find_files` 那两档；`root` 不是目录给 `NOT_DIR` | `fs/search.rs:596` |
| `fs_watch_start` | `root, generation` | `()` | 递归监听；已有监听先停；`generation` 是前端每次换根递增的代号令牌，锁内比对，慢到的旧请求直接放弃；去抖 150ms 后发 `fs://change{paths}` | `watch.rs:83` |
| `fs_watch_stop` | `root, generation` | `()` | 令牌与 root 都对上槽里那轮才清槽，过期请求什么都不动；丢句柄后转发线程随之退出。没有可失败的分支，签名不带 `Result` | `watch.rs:153` |

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
| `git_remotes` | `root` | `String[]` | `remote` | `:672` |
| `git_ignored` | `root` | `String[]` | `status --porcelain --ignored=matching`，只留 `!! ` 行，取的是仓库相对路径 | `:688` |
| `git_checkout` | `root, branch` | `String`（stderr） | `checkout`，分支 / 标签 / 修订号共用这一条 | `:714` |
| `git_create_branch` | `root, name, from, checkout` | `String` | `checkout -b` 或 `branch <name> <起点>` | `:728` |
| `git_merge` | `root, name` | `String`（stdout） | `merge --no-edit` | `:757` |
| `git_rebase` | `root, onto` | `String` | `rebase <onto>`，非交互 | `:771` |
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
| `lsp_start` | `window, server, root, program, args` | `String`（会话 id） | 启动进程（三路管道、非 PTY）与两条读线程；启动前先按配置扫描空闲会话与总数上限；身份已在表内时直接返回原 id，不重复启动；同一身份正在启动时后到的请求等待其结果（条件变量，不重复 spawn）。找不到可执行文件返回 `LSP_NOT_FOUND`，spawn 失败返回 `LSP_SPAWN`，管道未建立返回 `LSP_IO`；退避期内返回 `LSP_START_BACKOFF`（剩余等待毫秒数、上次失败原因），连续失败超过 2 次返回 `LSP_START_LIMIT`。发送 `lsp://message{id,body}`、`lsp://log{id,text}`、`lsp://exit{id,code}` | `lsp.rs:307` |
| `lsp_write` | `id, body` | `()` | 补齐 `Content-Length` 头（按字节数）后写入 stdin，同时将该会话的「最后使用时间」更新到当前时刻；会话已回收时返回 `LSP_GONE` | `lsp.rs:491` |
| `lsp_stop` | `id` | `()` | 先执行 `taskkill /F /T /PID` 终止整棵进程树，再结束壳进程；`lsp://exit` 由读线程补发 | `lsp.rs:505` |
| `lsp_reap` | — | `()` | 回收上一次页面遗留的全部会话，不报错 | `lsp.rs:532` |
| `lsp_session_statuses` | `window?` | `SessionStatus[]` | 只读，实时采集：`try_lock` + `try_wait`。`running` 仅表示进程存在，不表示服务器已完成索引；锁被占用时上报 `running` 并附「本轮未采集到」；从未启动成功的条目按失败记录合成一条 `dead`，id 前缀与当前窗口不符时不列出；按 server、根排序 | `lsp.rs:544` |
| `lsp_failed` | `id, message` | `()` | 供前端上报握手超时等情况，计入同一套退避记录，不报错 | `lsp.rs:633` |
| `lsp_retry` | `id` | `()` | 手动重试：回收残留会话并清除失败记录，下一次 `lsp_start` 可立即重试 | `lsp.rs:639` |
| `lsp_config_load` | — | `LspConfig` | 读取 `<app_config_dir>/lsp.json`；文件不存在时按种子生成一份，并顺带迁移同目录 `settings.json` 中的 `lsp` 段；JSON 解析失败同样回退为种子并重写文件，不报错 | `lsp_config.rs:528` |
| `lsp_config_save` | `config` | `()` | 归一化（非法档位与空字段按种子补齐）后 `to_string_pretty` 原子写入 `lsp.json`，目录不存在时先创建 | `lsp_config.rs:534` |
| `lsp_resolve_root` | `server, workspaceRoot, file?` | `RootHit{root,marker}` 或 null | 按配置中的 `rootMarkers` 确定真正的项目根：先从文件所在目录向上查找（不越过 `workspaceRoot`），未命中时再从 `workspaceRoot` 向下扫描 2 层，跳过 `node_modules` / `.git` / `target` / `dist` / `build` / `out` / `vendor` / `__pycache__` / `.venv`；标志表为空时直接返回 `workspaceRoot`；结果缓存 60 秒；目录不存在或未命中一律返回 null，不报错 | `lsp_detect.rs:188` |
| `lsp_probe` | — | `LspProbeReport{config,servers[]}` | 逐项探测是否已安装：进程 PATH 加几个常用安装位置（`%APPDATA%\npm`、`WindowsApps`、`~/.cargo/bin`、`~/go/bin`、`/usr/local/bin`、`/opt/homebrew/bin` 等），按 `PATHEXT` 构造候选并补充 `.ps1`，rust-analyzer 额外执行一次 `--version` 以排除占位垫片；单次结果缓存 10 秒。只把「启用外部档但本机未安装」的档位回退为 `off`（`builtin` 使用 Monaco 自带语义，与是否安装无关，不做调整），安装完成后不自动启用；确有改动才写回 `lsp.json`（无改动不落盘），校正后的配置随报告带回；不报错 | `lsp_probe.rs:253` |
| `lsp_install` | `server` | `InstallResult{command,output,exitCode}` | 使用系统 shell 执行配置中的 `installCommand`（Windows `%COMSPEC% /D /C`，其余 `/bin/sh -c`），不设超时（全局安装通常需要数分钟）；输出只保留尾部 32 KiB。该项不存在回 `LSP_NO_SERVER`，未配置安装命令回 `LSP_NO_INSTALL`，shell 无法启动回 `LSP_INSTALL_SPAWN` | `lsp_probe.rs:259` |

## 设置与系统（7）

| 命令 | 参数 | 返回 | 副作用 / 事件 | 出处 |
| --- | --- | --- | --- | --- |
| `settings_load` | — | `Settings` | 文件缺失或 JSON 坏都静默退回默认值，不报错 | `settings.rs:179` |
| `settings_save` | `settings` | `()` | 整份 `to_string_pretty` 经 `write_atomic` 写 `<app_config_dir>/settings.json`（先 `.tmp` 再改名），目录不存在先建 | `settings.rs:185` |
| `history_load` | — | `History` | 读 `<app_config_dir>/history.json`；文件不存在时从同目录 `settings.json` 迁移那四项并立刻落盘；JSON 坏同样退回空表并重写，不报错 | `history.rs:101` |
| `history_save` | `history` | `()` | 整份 `to_string_pretty` 经 `write_atomic` 写 `history.json`，目录不存在先建 | `history.rs:107` |
| `tray_labels` | `show, quit` | `()` | 改托盘两项文字；菜单是系统画的 | `tray.rs:69` |
| `app_exit` | — | `()` | 清看门狗标志后 `app.exit(0)`；由前端存完盘调用 | `tray.rs:123` |
| `sys_memory` | — | `Memory{appMb,totalMb,parts[]}`，`parts` 一档 `{kind,program,mb,count}` | kernel32 一次进程快照，按 `ppid` 从自身往外收全部后代，逐个读**私有工作集**（不是工作集：工作集含共享页，WebView2 那几台进程相加会虚高几百 MB）后归并成 host / webview / child 三档，单位 MB。读不到的进程按 0 计，父进程先退导致 `ppid` 链断掉的子树不计；非 Windows 三个值全为 0 | `sys.rs:369` |

## 代码

| 文件 | 内容 |
| --- | --- |
| `src-tauri/src/lib.rs` | 注册表全表 `:32-125`；`fs` 段 `:33-47`（两条搜索命令 `:44-45`）、`watch` 段 `:48-49`、`git` 段 `:50-95`、`term` / `proc` / `run` 段 `:96-107`、`lsp` / `lsp_config` / `lsp_detect` / `lsp_probe` 段 `:108-119`、`settings` / `tray` / `sys` 段 `:120-124`。Tauri 的命令宏不穿 `pub use`，那四条 run 命令按 `run::detect::…` / `run::store::…` 全路径注册 |
| `src-tauri/src/fs/mod.rs` | `EDITOR_CEILING` 8 MiB `:30`、`read_file` 的 BINARY / NOT_UTF8 分支 `:211-219`、`copy_tree` `:288-302`、`move_entry` 的跨盘那段 `:315-326`、`fs_allow_asset` 的递归授权 `:372-377` |
| `src-tauri/src/fs/search.rs` | 阈值常量 `:15-32`（`SCAN_CAP` 200_000、`MAX_DEPTH` 24、`TEXT_SIZE_CEILING` 20 MiB、`SNIFF_BYTES` 4096、`DEFAULT_PAGE` 100、`MAX_LIMIT` 5000、`MATCH_CAP` 2000、`SNIPPET_CHARS` 240）、剪掉的目录名 `:34-47`（含 `dist`）、`score_name` 四档 `:79-99`、`page_limit` `:130-136`、`find_files_at` 的排序与截断 `:179-193`、`TextOptions` `:211-224`、`build_matcher` 的 `BAD_REGEX` `:352-365`、`wildcard` `:368-394`、`snippet` `:419-433`、`skipped` 的四类 `:481-500`、单测 `scan_prunes_build_directories` `:705-727` |
| `src-tauri/src/git/mod.rs` | `run_git` 的三条前缀参数 `:152-166`、`fail` 先 stderr 后 stdout `:172-178`、`relative_path` 与 `NOT_IN_REPO` `:203-221`、`remote_op` 回 stderr `:485-496`、`valid_branch_name` `:702-711`、`parse_refs` 的 `<远端>/HEAD` `:572-606`、`git_ignored` 的 `!! ` 行 `:694-699`、`GitLogQuery` `:1177-1194`、`bound` 的 `@<秒>` `:1197-1203`、`git_log` 的参数拼装与空仓库判断 `:1205-1261`、`valid_rev` `:1340-1347`、`valid_relative` `:1506-1512` |
| `src-tauri/src/term.rs` | `shell_probe` 的探测顺序 `:91-130`、`resolve_shell` `:145-158`、`term_open` `:161-217`、`read_loop` `:220-248`、`term_reap` `:293-299` |
| `src-tauri/src/proc.rs` | `shell_command` `:52-60`、`pump` 的 8192 字节一块 `:62`、`proc_start`（含逐条 `command.env`）`:83-137`、`wait_and_finish` 的 80ms 轮询 `:140-160`、`proc_kill` 的 `taskkill /F /T` `:162-182` |
| `src-tauri/src/run/mod.rs` | `RunKind` `:14-63`（二十四族：npm / maven / gradle / spring / java / go / wails / rust / python / dotnet / php / ruby / dart / scala / elixir / cpp / zig / deno / clojure / haskell / julia / lua / swift / shell）、`EnvVar` `:68`、`HelperFile` `:77`、`Unavailable` `:85`、`RunConfiguration` `:95` |
| `src-tauri/src/run/detect.rs` | 边界常量 `:47-68`、`RunDetectOutcome` `:74-77`、`Tools` `:83-90`、`MainClass`（带装订线落点）`:106-117`、`npm_client` 的锁文件认客户端 `:152`、行号三件套 `line_at :176` / `line_of :186` / `object_key_lines :201`（数 JSON 里每个键主张在哪一行）、`has_main_method :375`、`jvm_markers :390`、`is_go_main_package :407`、`is_python_entry :418`、`program_missing`（非 JVM 那几族的缺工具判定）`:427`、`python_program :438`、`toml_tables :449`、`run_tools`（`async`，命令体经 `offload::block_value`）`:533`、`tools_cached :541`、`tool` 的 wrapper 优先与缺工具 `:616-648`、`location` 的相对参数 `:649`、npm `:661`、maven `:728`、gradle `:815`、`bare_java :913`、主类扫描 `:957`、`java_exec_script :1033`、golang（含 `wails.json` 那条早退）`:1062`、`go_main_packages :1124`、`marker_at`（一个源文件里那条模式所在的行）`:1191`、rust `:1203`、python `:1286`、`python_marker :1380`、`python_package_entry :1387`、`bare_python :1408`、dotnet `:1431`、`push_simple`（长尾那十几族共用的一口）`:1485`、php `:1505`、ruby `:1559`、dart `:1600`、scala `:1616`、elixir `:1623`、native（CMake 与 Makefile）`:1652`、zig `:1686`、deno `:1705`、clojure `:1750`、haskell `:1768`、julia `:1785`、lua `:1805`、swift `:1819`、`source_where :1869`、`bare_shell :1906`、`kind_rank :1932`、`run_detect`（`async`，命令体经 `offload::block`）`:1963`、`run_detect_impl`（真正干活的那层，单测直接调它）`:1967-2015` |
| `src-tauri/src/run/store.rs` | `ProjectRunState` `:24-33`、`run_state_load` `:72`、`keepable` `:81`、`run_state_save` `:87-117` |
| `src-tauri/src/lsp.rs` | 会话表与 `Session`（含 `last_used_ms`）`:23-41`、失败记录 `Failure` 与退避 `RESTART_LIMIT` 2、`backoff` 的 `5s*2^n` 封顶 300 秒 `:51-72`、`SessionStatus` `:110-126`、`parse_args` 的双引号规则 `:142-170`、`build_command` 的 `.cmd` / `.bat` 走 `cmd /C` `:172-186`、`session_id` 三段拼接 `:188`、起锁（`begin_starting` / `wait_for_starting`）`:196-224`、`backoff_error` `:226-244`、`sweep` 的空闲回收与 LRU 淘汰 `:263-299`、`lsp_start` `:307-331`、`spawn_session` 的 PATH 覆盖与 `current_dir` `:334-397`、`read_loop` 的 `Content-Length` 解帧 `:400-433`、`stderr_loop` 按行 `:436-454`、`take_message` `:460`、`stop_one` 的 `taskkill /F /T` `:510-529`、`lsp_session_statuses` 的现采与合成 `:544-629`、单测 `:665` 起 |
| `src-tauri/src/lsp_config.rs` | `LspServerConfig` / `LspConfig` `:18-58`、`allowed_modes` `:60`、种子表 `seed` `:105-324`、`DEFAULT_MAX_SESSIONS` 5 与 `DEFAULT_IDLE_TIMEOUT_MIN` 30 `:326-328`、`effective_program` 的 path 优先 `:332`、`normalize` `:354`、`clamp` 的档位与空字段兜底 `:384-415`、`migrate_from_settings` `:427`、`load_in` `:463`、`save_in` `:485`、`load` / `save` 两个 `AppHandle` 壳 `:494-505`、探测结构 `LspServerProbe` / `LspProbeReport` `:507-524`、两条命令 `:527-536`、单测 10 条 `:539` 起 |
| `src-tauri/src/lsp_probe.rs` | `PROBE_TTL` 10 秒 `:19`、`OUTPUT_TAIL` 32 KiB `:22`、`candidates` 的 `PATHEXT` 与补 `.ps1` `:52-78`、`search_dirs` 的补目录 `:84-128`、`augmented_path` `:131`、`is_functional` 的 rust-analyzer `--version` `:143-168`、`resolve_command` 与缓存 `:170-188`、`run_install` 的 shell 选择与按字符取尾 `:212-246`、`probe_and_reconcile` 的单向校正 `:276`、单测 6 条 `:302` 起 |
| `src-tauri/src/lsp_detect.rs` | `CACHE_TTL` 60 秒 `:15`、`MAX_DEPTH` 2 `:17`、`SKIP_DIRS` 九项 `:19`、`marker_matches`（`*` 前缀名）`:39`、`hit_in` `:50`、`search_up` `:87`、`search_down` `:103`、`resolve` 的标志表为空原样回根 `:140`、`cached` `:162`、命令壳 `:188`、单测 7 条 `:208` 起 |
| `src-tauri/src/settings.rs` | `read` `:160-166`、`settings_load` `:179-182`、`settings_save` `:185-192`（`lsp` 段已搬去 `lsp.json`，历史四项已搬去 `history.json`，旧文件里那些键读到时直接忽略） |
| `src-tauri/src/history.rs` | `History` `:25-33`、`migrate_from_settings` `:38-63`、`load_in` `:71-81`、`save_in` `:84-89`、`read` `:92-97`、`history_load` / `history_save` `:101-117`、单测 4 条 `:119` 起 |
| `src-tauri/src/tray.rs` | `tray_labels` `:68-76`、`app_exit` `:122-126` |
| `src-tauri/src/sys.rs` | `hide_console` 的 `CREATE_NO_WINDOW` `:5-11`、`write_atomic` 的 tmp+rename `:25-33`、`which_program` 的 Windows 扩展名候选 `:65-76`、`capture_text`（stdout 空了取 stderr）`:80-101`、`group` 的 ppid 走树与按程序归并 `:154-212`、`win::private_set_of` `:305-316`、`win::snapshot` `:319-341`、`sys_memory` `:369-376`、单测 4 条 `:378` 起 |
| `src-tauri/src/watch.rs` | `fs_watch_start` `:83-144`、`fs_watch_stop` `:146-169`、`SETTLE` / `BATCH_CAP` `:19-22` |
| `src/lib/fs.ts` | `findFiles` / `searchText` `:226-233`、搜索结果的 TS 镜像 `:147-223` |
| `src/lib/lsp.ts` | 会话状态、探测报告、安装结果、根命中的 TS 镜像 `:26-68`、十二条命令的封装 `:71-132`（`lspStart` 收 `window` / `server` / `root` / `program` / `args` `:71`） |
| `src/lib/lspConfig.ts` | `LspMode` 与两份结构的镜像 `:12-46`、`modesFor` `:49`、`programOf` 的 path 优先 `:54`、`serverEntries` / `serverForLanguage` `:59-70`、读写两条封装 `:72-83` |
| `src/lib/errors.ts` | LSP 那九条码（`:78-89`）的文案见 [error-model.md](./error-model.md) 的稳定代码表 |
