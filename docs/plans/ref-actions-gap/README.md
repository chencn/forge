# 引用侧没接的几样动作

**状态**：`待做`。四样，各自独立，都是差一条只读命令的量级。
**涉及模块**：`git-branches`（`src/lib/refMenu.ts`、`src/components/BranchPicker.tsx`）、`git-log`
（分支树那栏）、后端 `src-tauri/src/git/mod.rs`；第三样牵到 `documents-preview`（外链开浏览器的现成通道）。
**阻塞点**：`git worktree list` 和 `git remote get-url` 两条命令都没有。网页那样缺的是「认不出托管方就拼不出
正确链接」这层判断。标签那样只差一层子菜单，数据够了。

## 一、打开工作树（Open Worktree）

`refMenu.ts` 里的注释就是这条的现状：「打开工作树」要等 `git worktree list` 能查到别的工作树里检出了谁，
先不摆。`docs/features/git-branches/ref-action-matrix.md` 的「未落地的」一节记的是同一条判断：按矩阵，
这一项只在「该分支检出在别处」时才出现，判断不了就不出现。矩阵里 Open Worktree 与 New Worktree 两行
是这份可见性的来源。

已做：新建工作树是通的。`git_worktree_add(root, path, branch)` 落 `worktree add <path> <branch>`，
分支名过 `valid_branch_name`，空路径回 `BAD_PATH`。菜单项在 `refMenu` 的引用动作表里，对话框是
`PromptDialog.tsx` 的 `worktree` 形态，落点在 `App.tsx` 的对话框确认分支。

方案：加一条 `git_worktree_list(root) -> Vec<GitWorktree{path, head, branch, isBare}>`，读
`git worktree list --porcelain`。`--porcelain` 是稳定的机器格式：`worktree <路径>` / `HEAD <hash>` /
`branch refs/heads/<name>` / `bare` 若干行一组，组间空行分隔。结果并进 `git_branches` 的解析：给
`GitBranch` 加一个可选 `worktreePath`，前端在 `refMenu` 里按「该分支有值且不是当前工作树」决定出现与否，
照 IDEA 隐藏而不是置灰。

待定：点下去做什么。(i) 换当前工程。`history.json` 的 `lastFolder` 与 `recentFolders` 那条路已经现成，
但要先问未保存文档，还要停旧监听开新监听（`fs_watch_start` 换目录时新的顶掉旧的）。
(ii) 新开一个窗口指向那个目录，需要多窗口能力，`capabilities/default.json` 的 `windows` 只放行了 `"main"`。
倾向先 (i)，(ii) 另立需求。

验收：`git worktree add ../wt-x feature-x` 之后，`feature-x` 那行的菜单出现「打开工作树」，别的不出现；
点了之后标题栏工程芯片变成 `wt-x`，`fs://change` 跟着换到新根。

## 二、远端分支的 Pull into Selected Using Merge / Rebase

`refMenu.ts` 那两项现在是 `disabled: true` 加 `hint: t("git.pullNeedsCheckout")`
（「要先切到那条分支才能拉取」）。矩阵的源码结论是这两项在本地分支隐藏、只在远端分支出现，
现状也记在同一份矩阵的「未落地的」一节：可见性对了，动作还没落地。

已做：`git_pull(root)` 只有 `pull --ff-only`，且只能作用于当前分支；`git_checkout` 能切分支、标签、修订。

方案：不新增 git 语义，做成两步串联：`git_checkout(name)` → `git_pull(root)`。rebase 那档换成
`pull --rebase`，要给 `git_pull` 加一个 `mode` 参数，白名单只认 `ffOnly` / `rebase`，写法照 `git_reset`
的 `mode` 判定。约束：第一步成功、第二步失败时仓库已经切过去了，提示必须说清这一点，否则界面状态和 git 状态
不一致，横幅与分支芯片都读 `git_status`，会跟着变。

待定：保留「置灰 + 提示切过去」，还是做成「出现就自动切过去」。前者状态准确但点了没反应，后者改变 HEAD，
是个有后果的动作。这条要人拍板。

## 三、「在修订版中显示仓库」

`GitLogPane.tsx` 的菜单注释记着这条缺什么：要拼远端网页地址，没有落点就不出现。

方案：两步。第一步，新命令 `git_remote_url(root, remote)` → `git remote get-url --push <remote>`，
现在只有拿名字的 `git_remotes`。第二步，把 URL 归一再拼模板：`git@host:owner/repo.git`、
`https://host/owner/repo.git`、`ssh://…` 三种形状都剥掉 `.git` 尾巴，然后按 host 加路径形状匹配 commit 页
拼法。GitHub 是 `<base>/commit/<sha>`，GitLab 与 Gitea 是 `<base>/-/commit/<sha>`，Bitbucket 是
`<base>/commits/<sha>`。认不出托管方就整项不出现，不给一个大概率打不开的链接。开出去用现成的 `open_external`，
Windows 走 `ShellExecuteW`、不经 cmd，`&` 不会被当命令分隔。

待定：自建 GitLab 与企业 GitHub 的路径前缀不标准（`/gitlab/owner/repo`），要不要在设置里给一条
「网页地址前缀」手动覆盖。不做的话私有化仓库这一项永远不出现。

## 四、推送标签的逐远端子项

IDEA 那条是「Push to remote in repo」，按每个远端列一项。forge 现在落成单条「推送标签」，走 `git_push_ref`，
远端由 `push_target` 推出来：引用名前缀 → 该引用的上游 → 第一个远端。数据已经够：远端名有 `git_remotes`，
`GitProbe.remotes` 也带着。词典里 `git.refPushTo`「推送到 {remote}」中英两处都在，没有引用点。

方案：标签那组的单条改成子菜单，一条远端一项。命令是 `git_push_ref` 加一个可选 `remote` 参数，
`push_target` 的三级回退保持为「没指定时」的行为。

待定：只有一个远端时（绝大多数仓库）要不要仍然展开成子菜单。IDEA 照列，forge 的菜单原则是空组不留悬空
分隔线，单子菜单平铺成一条更贴这条原则。

## 出处

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `src/lib/refMenu.ts` | Open Worktree 的注释 | `:75` |
| `src/lib/refMenu.ts` | New Worktree 菜单项 | `:144-146` |
| `src/lib/refMenu.ts` | 远端分支两条拉取项（置灰 + hint） | `:167-181` |
| `src/lib/refMenu.ts` | 标签的推送项 | `:197-207` |
| `src/lib/refMenu.ts` | 空组不留悬空分隔线：注释与实现 | `:52-54`、`:229-233` |
| `src-tauri/src/git/mod.rs` | `GitProbe.remotes` 字段 | `:21-23` |
| `src-tauri/src/git/mod.rs` | `GitBranch` 结构 | `:62-77` |
| `src-tauri/src/git/mod.rs` | `git_pull` 的 `pull --ff-only` | `:505-510` |
| `src-tauri/src/git/mod.rs` | `git_checkout` | `:713-726` |
| `src-tauri/src/git/mod.rs` | `git_remotes`（只有名字） | `:670-686` |
| `src-tauri/src/git/mod.rs` | `push_target` 三级回退、`git_push_ref` | `:825-852`、`:853-863` |
| `src-tauri/src/git/mod.rs` | `git_worktree_add` | `:877-892` |
| `src-tauri/src/git/mod.rs` | `git_reset` 的 `mode` 白名单写法 | `:1125-1130` |
| `src-tauri/src/watch.rs` | `fs_watch_start` 与「新句柄顶掉旧的」 | `:46-73` |
| `src-tauri/src/fs/mod.rs` | `open_external` | `:380-389` |
| `src-tauri/src/fs/windows.rs` | `ShellExecuteW` 与不经 cmd 的理由 | `:73-96` |
| `src-tauri/capabilities/default.json` | `windows: ["main"]` | `:5` |
| `src/App.tsx` | `history.lastFolder` 起工程、`recentFolders` 记录 | `:197-200`、`:445-446`、`:796` |
| `src/App.tsx` | 对话框 `worktree` 分支的落点 | `:1248-1250` |
| `src/components/PromptDialog.tsx` | `worktree` 形态与文案位 | `:12`、`:52`、`:77` |
| `src/components/GitLogPane.tsx` | 「在修订版中显示仓库」的注释 | `:679-685` |
| `src/i18n/lang/zh.ts` | `git.refPushTo`、`git.pullNeedsCheckout` | `:315`、`:323` |
| `src/i18n/lang/en.ts` | 同两条 | `:318`、`:326` |
| `docs/features/git-branches/ref-action-matrix.md` | Open Worktree / New Worktree / Pull into Selected / Push Tag 四行 | `:31`、`:39`、`:43-44`、`:45` |
| `docs/features/git-branches/ref-action-matrix.md` | 「未落地的」一节 | `:77-90` |
| `docs/features/git-log/README.md` | 日志侧边界陈述 | — |
