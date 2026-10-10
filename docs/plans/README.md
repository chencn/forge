# 规划区（未完成的设计）

一份需求一个目录，kebab 英文目录名，主文档叫 `README.md`；题目需要拆时在同目录里另加文件。
这里不放已完成项。需求做完或定稿，把结论并进 `docs/features/<模块>/`，删掉这里那一份
（[../README.md](../README.md) 的流转规则）。留下来的文档，默认下一次读到它时仍然有效。

## 每份文档的格式

文档头三行，用粗体小标题：

- **状态**：`设计中`（方案还在挑路）/ `进行中`（已经在改代码，文档跟着改）/ `待做`（方案定了，没人动手）。
- **涉及模块**：features 那层的模块名（`git-log`、`file-explorer`…），加上要动的后端文件。
- **阻塞点**：一句话说清卡在哪。写不出这句的，通常还不该进 plans。

正文按 背景 / 已做 / 方案 / 未做与验收 / 出处 五段。四条要求：

1. 「未做」写成可验收的句子：跑什么命令、看什么状态字母，不写「完善 X」。
2. 每条先在代码里确认现状。「已做」记的是已经存在的底子，避免下一个人在同一条路上再造一遍。
3. 不确定的写成待定，把分歧点摆出来，不下编出来的结论。取舍反直觉的，附一句理由。
4. 出处列 文件 + 内容 + 行号范围，正文不夹行号。

## 现在挂着这几份

| 目录 | 主题 | 状态 | 阻塞点 |
| --- | --- | --- | --- |
| [git-rebase-todo/](./git-rebase-todo/README.md) | 变基待办通道：修补 / 压缩到 / 删除提交 / 压缩提交 / 交互式变基 | 设计中 | 没有把 todo 清单交给界面再写回的通道；`sequence.editor` 那个钩子怎么回到应用 |
| [change-selection-actions/](./change-selection-actions/README.md) | 选中更改的动作：优选 / 提取到单独提交 / 删除所选 / 不带内容暂存 / 搁置 / 从版本控制移除 | 设计中 | 后端只有整文件粒度，没有按段 apply 与 intent-to-add |
| [ref-actions-gap/](./ref-actions-gap/README.md) | 引用侧四样：打开工作树、远端分支 Pull into Selected、「在修订版中显示仓库」、推送标签的逐远端子项 | 待做 | `git worktree list` 与 `git remote get-url` 都没有；远端网页地址认不出托管方 |
| [disk-editor-merge/](./disk-editor-merge/README.md) | 磁盘与编辑器双向改动的三路合并 | 设计中 | 合并结果的编辑权在谁手上；冲突在哪一刻才算发生 |
| [fs-and-watch-boundaries/](./fs-and-watch-boundaries/README.md) | 文件侧与监听侧四条边界：回收站、隐藏项开关、新建重名截空、监听排除 | 待做 | 隐藏项那一条已落地，回收站与排除规则两条还没定取舍 |
| [run-and-debug/](./run-and-debug/README.md) | 运行配置与 IDEA 的对账，以及 Debug(DAP) | 方案一已落地 | Debug 那半边的 DAP 适配层完全没有；adapter 可执行文件从哪来没定。cargo 那条识别还没加 |
| [global-search/](./global-search/README.md) | 搜索剩下的几件：替换、扫描中断、历史与作用域记忆、多趟结果并存、文件名高亮 | 进行中 | 替换要一条能写盘的后端命令，而写盘和「编辑器那份赢」这条规矩正面冲突，取舍未拍 |
| [lsp-language-servers/](./lsp-language-servers/README.md) | 外挂 LSP：多语言语言服务的通道与开关 | 待验收 | 两轮八块代码都已落地，23 条 Rust 单测在独立工程跑绿；剩人工在 forge 界面里过一遍 |

## 不进这里的那些

这几样不是没做完，是没有落点：要么需要另一个后端（全局索引、本地历史存储），要么在别的产品边界之外
（插件）。这类只写边界陈述，归 `docs/features/<模块>/` 各自主文档的边界段落。在 plans 里立文档，
攒下的是不会动的计划。

- 查找用法 / 检查代码：要符号索引加一整条分析后端，还要结果面板这块界面，两头都没有。
  「按名字找文件」和「在正文里找词」不属于这里：后端两条只读命令已注册（`src-tauri/src/fs/search.rs`），
  前端已有调用点，挂在 [global-search/](./global-search/README.md)。
- 本地历史记录：要 IDEA 自己那份版本库，也就是不进 git 的历史存储。
- 标记目录为源根 / 测试根 / 已排除：要工程模型。forge 现在只有一个打开的文件夹。
- git bisect：没有 UI 挂点，也没人认领。
- 书签、便签文件、外部工具、文件类型关联：IDEA 那边由插件提供，不属于这层。

置灰摆着的控件属于 plans，界面上已经有位置。十项，分三处：

| 文件 | 置灰项 | 归属 |
| --- | --- | --- |
| `src/components/GitPanel.tsx` | 不带内容暂存、搁置、从版本控制移除、在独立窗口显示差异、三向比对 | 前四条 [change-selection-actions/](./change-selection-actions/README.md)；三向比对 [disk-editor-merge/](./disk-editor-merge/README.md) |
| `src/components/GitLogPane.tsx` | 优选所选更改、将所选更改提取到单独的提交、删除所选更改 | [change-selection-actions/](./change-selection-actions/README.md) |
| `src/lib/refMenu.ts` | 远端分支的 Pull into Selected Using Merge / Rebase | [ref-actions-gap/](./ref-actions-gap/README.md) |

## 出处

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `src/components/GitPanel.tsx` | 变更行菜单与点不动项的说明注释 | `:338-343`、`:369`、`:372`、`:384`、`:389-390` |
| `src/components/GitLogPane.tsx` | 提交行菜单注释（不摆的理由）；文件行三条置灰项与注释 | `:679-685`、`:982-985` |
| `src/lib/refMenu.ts` | 远端分支两条拉取项 | `:167-181` |
| `docs/features/git-branches/ref-action-matrix.md` | 「未落地的」一节，同一类判断 | `:77-90` |
