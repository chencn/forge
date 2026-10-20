# 选中更改的动作（行 / 块级）

**状态**：`设计中`。
**涉及模块**：`git-commit`（变更树右键）、`git-log`（第三栏文件行右键）；后端 `src-tauri/src/git/mod.rs`，
前端 `src/lib/git.ts`、`src/components/GitPanel.tsx`、`src/components/GitLogPane.tsx`。
**阻塞点**：后端只有整文件粒度。暂存是 `git add -- <path>`，取消暂存是 `git restore --staged --`，
还原是 `git restore --source <rev> --worktree -- <path>`。「一次改动里的某一段」这个概念在 Rust 侧不存在。

## 背景

界面上已经出现的置灰项，全在这一族：

| 位置 | 文字 |
| --- | --- |
| 提交窗口文件行 | 不带内容暂存 |
| 提交窗口文件行 | 搁置 |
| 提交窗口文件行 | 从版本控制移除 |
| 提交窗口文件行 | 在独立窗口显示差异 |
| 提交窗口文件行 | 三向比对（保存冲突的三向合并已落地，见 [../../features/code-editor/merge-and-local-history.md](../../features/code-editor/merge-and-local-history.md)；此处 Git 变更入口另议） |
| 日志文件行 | 优选所选更改、将所选更改提取到单独的提交、删除所选更改 |

日志那三项旁边的注释说的是同一件事：它们是 IDEA 变更清单侧的动作，日志里对着一次提交没有对应落点。
`docs/features/git-log/README.md` 的边界段落记的也是这件事。提交窗口那侧的菜单注释更直白：后端做不到
的几项照 IDEA 摆出来但点不动。

## 已做

- 整文件级全部到位：暂存 / 取消暂存 / 提交 / 修正 / 按版本整份还原。日志里「还原所选更改」和「从修订中获取」
  共用 App 侧的 `writeBack`，两条都落 `git_restore_file`。
- 按段的数据已经在手上：`git_diff_text(root, left, right, path)` 能取任意一侧到工作树的统一差异，
  补丁能落成文件也能进剪贴板。拿得到 hunk 不是问题，缺的是喂回去的通道。
- 未跟踪判定（`GitChange.untracked`）与两个状态位都在，`parse_status` 把 `??` 直接落成未跟踪项。
  「不带内容暂存」要区分的两种状态，前端已经读得到。

## 方案

三条新命令，都是 git 现成能力，仍然参数数组 spawn、不过 shell。

1. `git_diff_hunks(root, left, right, path)` → `git diff --unified=3 -- <相对路径>`。与 `git_diff_text`
   的差别只是后端按 `@@` 把文本切成 `{header, lines, kind}` 段列表返回。这条可以不要，前端自己切，
   但切分规则要有唯出处，不能两处各写一遍。
2. `git_apply_patch(root, text, cached, threeWay)` → `git apply [--cached] [--3way] --whitespace=nowarn -`，
   从 stdin 读。现有 `run_git` 用 `.output()` 一次性取结果，从没往子进程写过东西，要加一个带
   `Stdio::piped()` + `write_all` 的变体，并且两路管道边读边写：只写不读时，大补丁会卡在缓冲区上。
3. `git_add_intent(root, paths)` → `git add --intent-to-add -- <paths>`。未跟踪文件先进索引占位，
   才能对它出 diff。「不带内容暂存」落这一步，之后的按段暂存才走命令 2 的 `--cached`。

动作映射：

- 优选所选更改：把选中段的补丁应用到工作区（`cached: false`）。
- 提取到单独的提交：先 `cached: true` 应用，再 `git_commit` 一条，剩下的段留在工作区。
- 删除所选更改：反向应用子补丁（`git apply -R`）。这条最容易失效：反向应用要求上下文完全匹配，用户在编辑器里
  再改一行就失效。失败时不猜，把 git 的 `error:` 原样报回（`GIT` 那套，见
  [../../backend/error-model.md](../../backend/error-model.md)）。
- 不带内容暂存：命令 3。
- 搁置：`git stash push -m` / `list` / `apply` / `drop` 四条。后端很小，但界面要一个新的工具窗口槽位才谈得上
  放那叠搁置。这份文档只把「后端先能存能取」列为可先行，UI 待定。
- 从版本控制移除：`git rm --cached -- <path>`，一条命令，但要先定后果。它把文件变成未跟踪，和 `delete_entry`
  （永久删除）撞在一起时，IDEA 弹框二选一：只从版本控制移除 / 连磁盘文件一起删。forge 现在没有这个框，
  也没有「这条文件是否已跟踪」的查询。

## 未做与验收

- 后端三条命令加单测，`cargo check --tests --all-targets` 先过（见
  [../../backend/toolchain.md](../../backend/toolchain.md)）。验收：同一文件改两个 hunk，只勾一个暂存 →
  `git diff --cached --numstat` 的行数等于那一段，`git diff --numstat` 等于另一段。
- 按段勾选的界面：在比对标签页里勾（复用 `src/components/DiffPane.tsx`）还是新开一个改动清单面板，没定。
  这条决定命令 1 要不要真返回结构化的段。
- `intent-to-add` 之后变更树的显示要复核：那行的 `indexStatus` 会从空变成 `A`。现在分组的判据是 `isStaged`，
  未跟踪与已暂存可能归进同一组。先跑一遍看真实 porcelain 输出再定。
- 搁置的验收：存起来 → 工作区干净 → 取回 → 行数与状态字母一致；两条搁置能按序取。
- 稳定后并进 `docs/features/git-commit/`，把这几项从 `disabled` 改成实装，删掉这份。

## 出处

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `src-tauri/src/git/mod.rs` | `stage_paths`：`add --` 与 `restore --staged --` | `:428-448` |
| `src-tauri/src/git/mod.rs` | `git_restore_file`：`restore --source <rev> --worktree --` | `:894-917` |
| `src-tauri/src/git/mod.rs` | `git_diff_text` | `:919-952` |
| `src-tauri/src/git/mod.rs` | `run_git`：`Command::output()`，无 stdin 通道 | `:152-166` |
| `src-tauri/src/git/mod.rs` | `GitChange` 的 `untracked` 字段；`parse_status` 对 `??` 的处理 | `:28-44`、`:335-345` |
| `src-tauri/src/fs/mod.rs` | `delete_entry` 的永久删除 | `:328-340` |
| `src/components/GitPanel.tsx` | 菜单注释与五项置灰 | `:338-343`、`:369`、`:372`、`:384`、`:389-390` |
| `src/components/GitLogPane.tsx` | 文件行菜单注释与三项置灰 | `:960-985` |
| `src/App.tsx` | `writeBack` 共用 `git.restoreFile`；日志文件行的两个动作 | `:1042-1050`、`:1142-1147` |
| `src/App.tsx` | 创建补丁到剪贴板走 `gitDiffText` | `:1471` |
| `src/lib/git.ts` | `isStaged` | `:462` |
| `docs/features/git-log/README.md` | 边界段落：日志侧没有对应落点 | — |
