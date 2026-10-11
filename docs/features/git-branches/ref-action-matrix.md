# 引用动作适用矩阵

从 IDEA 源码逐条读出来的「哪种引用上该出现哪一项动作」的适用矩阵，用来定 forge 引用右键菜单里每一项该在哪种引用
（本地分支 / 远端分支 / 标签 / 当前分支那一行）上出现、哪一项整项消失、哪一项才真的置灰。菜单项的取舍看这份矩阵，
菜单不摆出来的那部分决定见 [`README.md`](./README.md)。

来源 `D:\app\code\intellij-community`（build 271.SNAPSHOT），逐条读动作类的 `refClass` 与 `isEnabledForRef`。
forge 侧的菜单顺序与分组在 `src/lib/refMenu.ts`，同一份菜单被顶栏分支弹层和日志左边的引用树共用。

## 两条判定规则

规则一，置灰还是隐藏。`GitSingleRefAction.update` 走的是 `e.presentation.isEnabledAndVisible = ...`，所以
`refClass` 不匹配、`isEnabledForRef` 返回 false、`disabledForLocal` / `disabledForRemote` 命中，全都是整项隐藏。
真正的置灰只有两处：仓库还没有第一次提交（`DvcsUtil.disableActionIfAnyRepositoryIsFresh`），以及动作自己在
`updateIfEnabledAndVisible` 里写 `isEnabled = false`。

规则二，类型闸门。`GitSingleBranchAction` 的 `refClass = GitBranch::class.java`，而 `GitBranch` 与 `GitTag` 是
`GitReference` 的两个兄弟类。`getRef` 里 `refClass.isInstance(ref)` 不过就返回 null。所以凡
`GitSingleBranchAction`，标签上一律不出现，跟它 `isEnabledForRef` 写了什么无关。

`GitBranchesTreeActionPromoter` 只在快捷键派发那条路上生效（`rearrangeByPromotersImpl` 的唯一调用点在
`runUpdateSessionForInputEvent` 里）。右键菜单按注册顺序画，Rename 保持在倒数第二。

## 矩阵

「当前」指当前分支那一行，HEAD 行在单根时等价。

| 动作 | 本地 | 远端 | 标签 | 当前 | 依据 |
| --- | --- | --- | --- | --- | --- |
| Checkout | 可点 | 可点 | 可点 | 隐藏 | `ref/GitCheckoutAction.kt:19-23` |
| Open Worktree | 仅当该分支检出在别的工作树 | 隐藏 | 隐藏 | 隐藏 | `workingTrees/actions/GitOpenExistingWorkingTreeForLocalBranchAction.kt:16-18` |
| New Branch from | 可点 | 可点 | 隐藏 | 可点 | `branch/GitCheckoutAsNewBranch.kt:14`（GitSingleBranchAction） |
| Checkout and Rebase onto Current | 可点 | 可点 | 隐藏 | 隐藏 | `branch/GitCheckoutWithRebaseAction.kt:24-25` |
| Checkout and Update | 有上游则可点，无上游置灰 | 隐藏 | 隐藏 | 隐藏 | `shared/src/com/intellij/vcs/git/actions/branch/GitCheckoutWithUpdateAction.kt:36-46,69,76` |
| Compare with Current | 可点 | 可点 | 隐藏 | 隐藏 | `branch/GitCompareWithBranchAction.kt:15-18` |
| Show Diff with Working Tree | 可点 | 可点 | 可点 | 可点 | `ref/GitShowDiffWithRefAction.kt:13-27`，无类型闸门 |
| Rebase Current onto Selected | 可点（游离 HEAD 时置灰） | 可点（同） | 隐藏 | 隐藏 | `branch/GitRebaseBranchAction.kt:18,27-34` |
| Merge into Current | 可点 | 可点 | 可点 | 隐藏 | `ref/GitMergeRefAction.kt:14-16`，`refClass` 是宽的 GitReference |
| New Worktree | 可点 | 可点 | 可点 | 可点 | `workingTrees/actions/GitCreateWorkingTreeAction.kt:31-40`，不是 GitSingleRefAction |
| Update | 可点（正在抓取或无上游时置灰） | 隐藏 | 隐藏 | 可点 | `branch/GitUpdateSelectedBranchAction.kt:21`（disabledForRemote 即隐藏） |
| Push | 可点 | 隐藏 | 隐藏 | 可点 | `branch/GitPushBranchAction.kt:13-22`，`disabledForRemote` |
| Tracked Branch 子菜单 | 有上游时出现 | 隐藏 | 隐藏 | 有上游时出现 | `branch/GitTrackedBranchActionGroup.kt:84`；子菜单里是同一套动作换成跟踪的那条远端分支 |
| Pull into Selected Using Rebase | 隐藏 | 可点 | 隐藏 | 隐藏 | `branch/GitPullBranchAction.kt:21`（disabledForLocal 即隐藏） |
| Pull into Selected Using Merge | 隐藏 | 可点 | 隐藏 | 隐藏 | 同上 |
| Push Tag | 隐藏 | 隐藏 | 出现 | 隐藏 | `tag/GitPushTagsActionGroup.kt:22-32`；子项文字 Push to remote in repo |
| Rename | 可点 | 隐藏 | 隐藏 | 可点 | `branch/GitRenameBranchAction.kt:14-16`，没有当前分支闸门 |
| Delete | 可点 | 可点（受保护分支置灰，无提示） | 可点 | 隐藏 | `ref/GitDeleteRefAction.kt:15-22` |

## forge 已对上的部分

`src/lib/refMenu.ts` 已按这份矩阵改过一轮。下面记每项现在落在哪一条判定上。

- 标签：曾经多给的 New Branch from 与 Compare with Current 现在都由 `isBranch`（`kind !== "tag"`）挡掉，整项不出现。
  标签上留下 Checkout / Merge into Current / Show Diff with Working Tree / New Worktree / Push Tag / Delete，
  与矩阵那几行一致。
- 当前分支那行：Checkout 与 Delete 由 `isCurrent` 整项隐藏，不再置灰。Rename 仍在这行上可点，与矩阵一致。
- 远端分支：Push 不出现（更新与推送那一组只给 `kind === "local"`），Checkout and Update 不出现（只给本地），
  Update 同样只给本地。三处都落在 `disabledForRemote` 即隐藏的语义上。
- 本地分支：Checkout and Update 改成「本地、非当前才出现；没有上游才置灰」，不再常置灰。Update 同样只在没有上游时置灰。
- Compare with Current 与 Rebase Current onto Selected：条件都是 `isBranch && !isCurrent`，对应矩阵那两行的
  「本地可点 / 远端可点 / 标签隐藏 / 当前隐藏」。
- 游离 HEAD：`buildRefMenu` 读 `status.detached`，把 Rebase Current onto Selected 与 Checkout and Rebase onto
  Current 一起置灰并给一句原因（矩阵那行的括注）。`refAction` 那侧对这两个动作也各拦一道，不再拿 `branch`
  字面量 `HEAD` 当变基目标。
- 空组不留悬空分隔线，隐藏一串项之后菜单不会剩两条挨着的横线。

## 与矩阵仍不一致的

以下四条都在可见性之外，`docs/plans/` 里还没有对应条目。

- Update 落错了对象。矩阵说的是更新所选那条分支，forge 现在落 `git pull --ff-only`，作用在当前分支上：选中一条
  不在手的本地分支点更新，动的是当前检出的这条。
- Update 少一条置灰前提。矩阵那行还要求「正在抓取时置灰」，forge 只判上游。
- Delete 对受保护分支。IDEA 是置灰且不提示，forge 摆出来让 git 自己拒，差别只在失败前多一次确认框。
- Push 少了那层对话框。菜单文案写「推送...」带省略号，落点是不问一句直接 `push <推出来的远端> <引用>`。

## 未落地的

前三条的方案与验收逐条记在 `../../plans/ref-actions-gap/`。

- Open Worktree。要先有 `git worktree list` 才知道哪条分支检出在别的工作树里，这条命令现在没有。按矩阵，这一项
  只在「该分支检出在别处」时才出现，判断不了就不出现，`refMenu.ts` 里写明「先不摆」。
- Pull into Selected Using Merge / Rebase。两条已在远端分支上出现，但永久置灰，提示「要先切到那条分支才能拉取」。
  forge 的 `git_pull` 只作用于当前分支，没有「按分支拉取」的实现。可见性对了，动作还没落地。
- Push Tag 的逐远端子项。已落地成单条「推送标签」，远端由 `push_target` 推出来：引用名前缀 → 该引用的上游 →
  第一个远端。IDEA 那个「Push to remote in repo」按每个远端一条子项的形态还没做，词典里的 `git.refPushTo`
  （「推送到 {remote}」）没有被引用。
- Tracked Branch 子菜单。已落地，有上游时出现，把同一套动作换成跟踪的那条远端分支再列一遍，并把子菜单自己的
  `upstream` 清空避免递归，与矩阵那行一致，从待做里划掉。

## 代码

forge 侧：

| 文件 | 内容 |
| --- | --- |
| `src/lib/refMenu.ts` | `buildRefMenu` `:56-235`。签出 `:66-74`、从它新建分支 `:76-84`、签出并变基 `:85-93`、检出并更新 `:94-104`、与当前比较 `:107-115`、显示与工作树的差异 `:116-120`、将当前变基到它 `:123-131`、将它合并进当前 `:132-140`、新建工作树 `:142-148`、更新与推送只给本地 `:150-166`、远端两项永久置灰 `:167-181`、跟踪上游子菜单 `:184-195`、推送标签 `:197-207`、重命名只给本地 `:209-218`、删除 `:219-228`；「先不摆」注释 `:75`；空组不留分隔线 `:231-234` |
| `src/App.tsx` | `refAction` 各落点 `:1538-1603`；Update 落当前分支 `:1584-1586`；签出并变基的 `onto` `:1554-1561`；推送不经对话框 `:1587-1589` |
| `src-tauri/src/git/mod.rs` | `push_target` `:825-850`；`git_push_ref` `:852-861`；游离时 `branch` 为 `HEAD` `:314-319` |

IDEA 侧（上面两条判定规则的出处）：

| 文件 | 内容 |
| --- | --- |
| `plugins/git4idea/backend/src/actions/ref/GitSingleRefAction.kt` | `update` 写 `isEnabledAndVisible` `:40`；fresh repo 置灰 `:42`；`getRef` 的 `refClass.isInstance` `:71`；`isEnabledAndVisible` 私有实现 `:74-76` |
| `plugins/git4idea/backend/src/actions/branch/GitSingleBranchAction.kt` | `refClass = GitBranch::class.java` `:12` |
| `platform/platform-impl/src/com/intellij/openapi/actionSystem/impl/Utils.kt` | 快捷键派发路径上的唯一 promoter 调用点 `:1194-1200` |
