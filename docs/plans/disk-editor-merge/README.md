# 双向改动的合并与三向视图

**状态**：`设计中`，带一个开放分歧：要不要做合并本身还没定，不是只做没做完。
**涉及模块**：`workspace-watch`（磁盘改动那批）、`code-editor`（比对与合并视图）、`file-explorer`（保存那条路）、
`git-commit`（三向比对那个置灰项）；后端 `src-tauri/src/fs/mod.rs`、`src-tauri/src/watch.rs`，前端
`src/hooks/useDocuments.ts`、`src/components/DiffPane.tsx`。
**阻塞点**：合并结果的编辑权在谁手上没定（Monaco 模型还是自己拼字符串）；冲突算在「磁盘一动」还是
「真要保存那一刻」发生也没定。

## 背景

现状是 `useDocuments.ts` 里 `noteExternalChange` 的一条规则：不动用户正在写的东西。没改过的跟着磁盘重载；
有未保存改动的保持原样，下一次保存就是他手里那份。两边都改过同一个文件时不合并也不问：以编辑器那份为准，
保存即覆盖磁盘那份，没提交过的外部改动找不回来。注释把取舍写明了：两边都改的内容合并不了，
所以选「编辑器赢」，不弹一张要人当场选边界的框。

这是一次有意的取舍，翻它要连着解决下面两个时机问题。

## 已做

- 基线在手上：每份文档存 `baseline`，也就是上次与磁盘一致的那份文本，脏判定是 `contents !== baseline`。
  三路合并要的「共同祖先」已经有了。
- 磁盘那一侧的时间戳在手上：`read_file` / `write_file` 都回 `modifiedMs`，而且已经用来认「只是被 touch 了一下」
  不重载。它还没用来判断磁盘正文是否等于基线，那个比较现在只在 `content.contents === doc.baseline`
  这一步做掉。
- 两边取一边的冲突处理已经有：git 冲突文件走 `git_resolve_conflict(root, path, side)`，`side` 只认
  `ours` / `theirs`，取 stage 2 或 stage 3 覆盖工作区再 `add`。界面是 `ConflictWidget.tsx` 与
  `ResolveConflictsDialog.tsx`。这是两边的界面，不是三边的。
- 界面上的位置：提交窗口文件行右键里「三向比对」置灰。同一处的「在独立窗口显示差异」是另一件事，
  要的是多窗口，不在这份里。

## 方案

触发时机两条路。

A. 保存那一刻才判（倾向）。给 `write_file` 加一个可选 `expectModifiedMs`，后端写之前 `metadata()` 一比，
不等就拒，回 `CONFLICT_ON_WRITE{path, diskMs, baseMs}`，新代码进 `src/lib/errors.ts` 的 `CODES`。
前端拿到这条才开三向视图。好处：判定只发生在真正会覆盖磁盘内容的那一刻，不和监听抢，和现有「不动用户正在写的东西」
完全兼容。代价：命令签名要变，后端 `write_file` 与前端 `writeFile` 一起改；`write_file` 现在被 `saveAll`
串行调用，一份被拒时后面那些还写不写要定，倾向继续写，把被拒那份留在脏状态。

B. 监听一动就判。`fs://change` 到达时读磁盘、与基线比，不等且本地脏就标冲突。代价是误报：现在监听是整棵目录
递归、没有任何排除（`RecursiveMode::Recursive`），构建工具批量 touch 和 `node_modules` 的动静都会进来。
B 必须先做 [../fs-and-watch-boundaries/README.md](../fs-and-watch-boundaries/README.md) 里的排除规则，
否则误报会天天出现。这是倾向 A 的第二个理由。

呈现层两条路也没定。

- 用 Monaco 自带的 merge editor。0.5x 有这块能力，但能不能吃下这套模型（`lib/monacoEnv.ts` 建的语言映射、`lib/monacoEditor.ts` 的主题、
  `baseline` 这份文本的注入方式）没试过。动手前第一件事是试这个。
- 自己拼：三格「本地 / 结果 / 对方」，两侧比对复用 `DiffPane.tsx`，结果格是一个普通编辑器模型。
  好处是可控，和现有页签体系一致（比对标签带文件差异图标、文件名斜体那条规矩不用改）。代价是结果格的
  undo 栈，以及结果怎么回写进 `contents`。分歧在这个回写：结果如果是独立字符串，保存时 `contents` 从哪份来、
  脏判定还成不成立，会牵到 `useDocuments` 的基线语义。

还有一件必须定的：`write_file` 是整份覆盖（`fs::write`），没有追加式或「原子换 + 保留对方改动」的选项。
做 A 时顺手加 `O_TRUNC` 之外的写法不在这份文档的范围。如果将来要做「保存时磁盘那份先合并」，
原子写（写临时文件再 rename）是前提，那时监听会多报一次 rename 事件，这条链现在没人想过。

## 未做与验收

- A 的验收：外部改一行、编辑器改另一行 → 保存被拒，状态条给出新代码的文案（含两个修改时间）。三条出路各一条
  用例：接受磁盘（基线更新、不再二次弹）、保留我的（覆盖并刷新 `diskMs`）、打开三向（结果格可编辑，
  保存后磁盘等于结果格）。
- 三向视图的验收：两侧各有独立改动的文件，合并结果与手期望一致；只有一侧改时结果等于那一侧。
- `src/lib/errors.ts` 与 `src/i18n/lang/zh.ts`、`en.ts` 三处同步，否则退回原文（见
  [../../backend/error-model.md](../../backend/error-model.md)）。
- 「三向比对」改挂实装；「独立窗口显示差异」另议。
- 定稿后并进 `docs/features/workspace-watch/` 与 `docs/features/code-editor/`，删掉这份。

## 出处

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `src/hooks/useDocuments.ts` | `baseline` 字段 | `:25` |
| `src/hooks/useDocuments.ts` | 脏判定：`contents !== baseline` | `:257`、`:361` |
| `src/hooks/useDocuments.ts` | 外部改动那条规则与取舍注释 | `:266-271` |
| `src/hooks/useDocuments.ts` | `noteExternalChange` 只挑没改过的文档 | `:272-276` |
| `src/hooks/useDocuments.ts` | 磁盘正文与基线的那次比较 | `:293` |
| `src/hooks/useDocuments.ts` | `saveAll` 串行写回 | `:249-264` |
| `src-tauri/src/fs/mod.rs` | `FileContent.modified_ms` 与 `read_file` 回时间戳 | `:86`、`:195-229` |
| `src-tauri/src/fs/mod.rs` | `write_file` 签名与整份覆盖 | `:231-262` |
| `src/lib/fs.ts` | `writeFile` 前端封装 | `:61-68` |
| `src-tauri/src/watch.rs` | 整棵递归、无排除 | `:66` |
| `src-tauri/src/git/mod.rs` | `git_resolve_conflict` 的 `--ours` / `--theirs` 加 `add` | `:1150-1174` |
| `src/components/GitPanel.tsx` | 三向比对与独立窗口显示差异两个置灰项 | `:389-390` |
| `src/components/ConflictWidget.tsx` | 顶栏的继续 / 中止 | `:14-42` |
| `src/components/ResolveConflictsDialog.tsx` | 逐个冲突按一边了结 | — |
| `docs/features/workspace-watch/README.md` | 现状边界陈述 | — |
