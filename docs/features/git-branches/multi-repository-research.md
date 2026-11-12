# 多仓库提交契约

核查日期：2026-11-12。

## IDEA 官方依据

- [提交与推送文档](https://www.jetbrains.com/help/idea/commit-and-push-changes.html)：在 Commit 窗口选择变更并填写提交说明。
- [GitCheckinEnvironment 源码](https://github.com/JetBrains/intellij-community/blob/master/plugins/git4idea/backend/src/checkin/GitCheckinEnvironment.kt)：`commit(changes, commitMessage, ...)` 通过 `sortChangesByGitRoot` 将变更按根分组，`doCommit` 遍历仓库并将同一个 `commitMessage` 传给 `commitRepository`。仓库通过依赖顺序排序，子模块先于父仓库。没有提交错误时才进入提交后推送流程。

结论：同一份说明可以用于多个仓库，但每个仓库分别产生提交；跨仓库操作不是原子事务。

## Forge 实现边界

- 工作区与 Git 根分开建模；递归发现工作区内仓库，并保留打开目录所属的仓库。Git 验证 `.git` 目录或 gitdir 文件，支持嵌套根与独立工作树。
- 提交面板同时列出各仓库，文件身份包含根、相对路径及索引/工作区侧。分支栏所选仓库不改变提交说明或勾选。
- 一份工作区提交说明，按根生成独立请求。空勾选不回退为提交全部。部分暂存的来源选择保持独立。
- 子仓库先提交。部分失败保留说明和失败项，成功项取消选择，重试不会自动重复提交成功项。
- 每个根的提交前检查、提交和分支操作共享锁。读取错误保留最后快照并禁用相关提交；迟到读取不能覆盖新状态。
- 父仓库的未跟踪清单不接管已发现子仓库；回滚删除前再次排除包含已注册仓库的目录。
- 提交后推送绑定来源根。当前复用现有单仓库推送窗口，多个确认排队展示；尚不是 IDEA 同一窗口展示全部推送仓库的布局。
- 扫描不跟随目录符号链接，不扫描 `.git`、`.tmp`、`node_modules`、`.venv`、`venv`。不可读子目录跳过；工作区根不可读时报错。

## 验证方式

前端组件和 Hook 测试验证实际事件、状态和 IPC 参数，覆盖同名文件、空选择、部分暂存、失败重试、切换期间的异步结果和写入互斥。Rust 测试在项目 `.tmp` 中手写最小仓库元数据，通过真实 Git 的只读 `rev-parse` 验证发现及提交根校验，不执行 `git init/add/commit`。
