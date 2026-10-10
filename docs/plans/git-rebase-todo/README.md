# 变基待办通道

**状态**：`设计中`。两条路都在纸上，倾向 B 的一部分，没拍板。
**涉及模块**：`git-log`（提交行右键菜单）、`git-branches`（引用上的变基）、`git-commit`（停在变基中间时的横幅）；
后端 `src-tauri/src/git/mod.rs`，前端 `src/lib/git.ts`、`src/lib/errors.ts`。
**阻塞点**：没有把交互式变基的待办清单交给界面、改完再写回的通道。`git -i` 靠 `sequence.editor` 起一个外部进程
编辑那个文件，而这个应用和 git 子进程之间除 invoke 之外没有第二条路。

## 背景

IDEA 日志的提交行右键有一族改写历史的动作：修补（fixup）、压缩到（squash onto）、删除提交、压缩提交、
交互式变基。forge 这五项都不出现，理由写在 `GitLogPane.tsx` 的菜单注释里：这几项要的是变基待办那条通道，
没有落点就不摆，摆了是点不动的项。相邻两项「在修订版中显示仓库」与「Open Worktree」缺的是别的东西，归
[../ref-actions-gap/README.md](../ref-actions-gap/README.md)。

## 已做

改写历史的原料已经在了，缺的是把多条提交排成一次执行：

- 非交互变基：`git_rebase(root, onto)` 落 `git rebase <onto>`，`onto` 过 `valid_branch_name` 校验，
  不合法回 `BAD_REV`。
- 停在变基中间认得出来：`mid_rebase` 读 `.git/rebase-merge` 或 `.git/rebase-apply` 目录，继续与中止走
  `git_rebase_continue` / `git_rebase_abort`。
- 三档重置 `git_reset`（soft 只挪指针 / mixed 再清索引 / hard 连工作区，`mode` 用白名单判定，不认回
  `BAD_MODE`）、`git_revert`、`git_commit(amend)`，以及「能拿去修正的提交」列表 `git_amend_targets`
  （`log -n20 HEAD --not --remotes`）。
- 修订号校验现成：`valid_rev` 供 `git_reset` / `git_revert` / `git_diff_text` 用。
- 菜单门控现成：合并提交（`parents.length > 1`）已被排除在优选与还原之外，「只在 HEAD 那条上生效」的
  `needHead` 也在。

## 方案

A. 真开 `-i`，外挂一个 todo 编辑器。命令形如 `git -c sequence.editor=<helper> rebase -i <base>`，
helper 被 git 起起来、拿到 todo 文件路径，把路径报回应用并阻塞等前端写完。新增命令至少两条：
`git_rebase_interactive(root, base)` 与 `git_rebase_todo_done(root, lines[])`；新增事件一条
（如 `git://rebase-todo`）。形态最接近 IDEA，IDEA 自己实现的就是一个 todo 编辑器。
分歧：helper 是独立进程，它怎么回到还在跑的应用没有干净选项。本机端口、命名管道、轮询临时文件三种都要引
新依赖或新失败模式，比如应用没起来、两个实例抢同一个管道。`git_rebase_continue` 现在用
`-c core.editor=true` 把编辑器钉成 no-op，`sequence.editor` 是另一个钩子，两者不冲突，
但「git 反过来调用应用」这条路在这套架构里目前是零。

B. 每个动作编译成一次性命令序列，不碰 `-i`。

- 删除提交：`git rebase --onto <rev>^ <rev> <当前分支>`，一条 `run_git`，`<rev>` 走现成的 `valid_rev`。
- 压缩到紧邻的下一条：`git log -1 --format=%B` 取两条说明，再 `git reset --soft HEAD~2`，
  最后 `git commit -m <合并后的说明>`。三步都是已有命令，要按顺序跑，中途失败要说清停在哪。
- 修补（fixup）：`git commit --fixup <rev>` 可以直接落，但接着的 `rebase --autosquash` 只在 `-i` 路径上生效，
  非交互那档要靠 `GIT_SEQUENCE_EDITOR=:` 把编辑器换成 true。这仍是 A 的那个钩子，只是不需要读内容。
- 交互式变基本身：B 做不出来，这一项继续不出现。
- 压缩到的通用形态（压到任意一条、跨合并提交）：B 也做不出来。

倾向先做 B 里两条干净的（删除提交、压缩到紧邻下一条），fixup 等 A 的钩子定了再说。这不是结论。

待定的一件事：半途失败会落在 `mid_rebase`，而横幅现在的语义是「停在冲突中间」。`recoveryOf` 一次只认一个动作，
四档文案在 `recovery.ts`，「非冲突的 rebase 失败」接不接得住没验证过。B 那三步序列第二步失败就是这种状态。
工作区脏时 git 自己会拒，返回 `GIT` 原文（见 [../../backend/error-model.md](../../backend/error-model.md)），
不额外拦，但要能解释清楚。

## 未做与验收

- 后端：选定路线的命令。A 是两条命令加一个事件，B 是三条纯命令序列。
  验收在一条测试分支上做 5 条提交：删除中间那条 → 日志少一条、`git status --porcelain` 干净、
  `mid_rebase` 回 `false`；压缩相邻两条 → `git log -1 --format=%P` 的父提交指向被压那两条的父。
- 前端：`commitMenu` 加项与门控。要判的有合并提交、当前分支、游离 HEAD、已推送与未推送的分界。
  已推出去的提交要不要警告，IDEA 是警告的，forge 现在没有这条判定。
- 错误：新代码要同时进 `src/lib/errors.ts` 的 `CODES` 和 `src/i18n/lang/zh.ts` / `en.ts` 两份语言表，
  否则只能退回原文显示。
- 做完把这份并进 `docs/features/git-log/`，删掉这里。

## 出处

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `src/components/GitLogPane.tsx` | `commitMenu` 与「这几项要的是变基待办那条通道」的注释 | `:679-686` |
| `src/components/GitLogPane.tsx` | 菜单门控：`atHead`、`merged`、`detached` | `:690-702` |
| `src/components/GitLogPane.tsx` | 提交行的挂点 `onContextMenu` | `:1555` |
| `src-tauri/src/git/mod.rs` | `git_rebase` | `:769-781` |
| `src-tauri/src/git/mod.rs` | `mid_rebase` 的两个目录判定 | `:263-264` |
| `src-tauri/src/git/mod.rs` | `git_rebase_continue`（含 `-c core.editor=true`）与 `git_rebase_abort` | `:997-1015` |
| `src-tauri/src/git/mod.rs` | `git_reset` 的三档与 `BAD_MODE` | `:1119-1138` |
| `src-tauri/src/git/mod.rs` | `git_revert` | `:1075-1096` |
| `src-tauri/src/git/mod.rs` | `git_commit` 的 amend 分支 | `:461-482` |
| `src-tauri/src/git/mod.rs` | `git_amend_targets` 的 `log -n20 HEAD --not --remotes` | `:1263-1289` |
| `src-tauri/src/git/mod.rs` | `valid_rev` | `:1340` |
| `src/lib/git.ts` | `recoveryOf` | `:28` |
| `src/lib/recovery.ts` | 四种中间态的继续 / 中止文案 | `:8-28` |
| `docs/features/git-log/README.md` | 边界陈述：这一族动作不出现 | — |
