# 文档规范

三份东西各管一段，别互相写对方的内容：

| 位置 | 给谁看 | 写什么 | 不写什么 |
| --- | --- | --- | --- |
| 根目录 `README.md` | 使用者 | 这软件能干什么、怎么装怎么跑 | 设计细节、实现取舍、代码结构 |
| `docs/features/` | 改这个模块的人 | 一个模块一个文件夹，功能怎么运作 + 为什么这么定 | 还没实现的设想 |
| `docs/backend/` | 动 Rust 侧的人 | 命令契约、错误模型、工具链约束 | 界面文案 |
| `docs/plans/` | 正在做这条需求的人 | 设计了没做完、正在改的东西 | 已经稳定的现状 |

**流转规则**：需求先在 `docs/plans/` 里立一份文档，边做边改；做完或定稿后，把结论并进
`docs/features/<模块>/`，然后删掉 `plans` 里那份。plans 不是归档区——留着的就是还没完的，
稳定了必须清走，否则下次读到的是过时的"计划"。

## features 模块索引

一个模块一个文件夹，主文档就叫 `README.md`；模块内有独立子题目再另开文件（比如
`shell-layout/tool-window-icons.md`）。

| 模块 | 管什么 | 主要代码 |
| --- | --- | --- |
| `shell-layout` | 主工具栏、活动栏、工具窗口槽位与分隔条、编辑器页签栏、底部状态条、图标资产 | `src/App.tsx`、`components/TitleBar.tsx`、`EditorTabs.tsx`、`WelcomeScreen.tsx`、`ToolWindowIcons.tsx` |
| `code-editor` | Monaco 接入、启动路径上的模块拆分、主题着色、三套快捷键方案、空态快捷键告示 | `components/CodeEditor.tsx`、`lib/monacoEnv.ts`、`lib/monacoEditor.ts`、`lib/keymap.ts`、`lib/keymapHints.ts`、`lib/color.ts` |
| `search` | 随处搜索、在文件里查找、查找结果窗口 | `components/SearchEverywhere.tsx`、`FindPane.tsx`、`MatchSnippet.tsx`、`lib/monacoEditor.ts`、`src-tauri/src/fs/search.rs` |
| `file-explorer` | 目录树、多选、右键菜单、新建/改名/复制/移动/删除 | `components/ExplorerTree.tsx`、`components/ContextMenu.tsx`、`lib/fs.ts` |
| `documents-preview` | 文件按扩展名分四类，markdown / svg / 图片 / diff 各给什么视图 | `lib/docKind.ts`、`lib/markdown.ts`、`components/DocPane.tsx`、`MarkdownPreview.tsx`、`ImagePreview.tsx`、`DiffPane.tsx` |
| `workspace-watch` | 磁盘监听、树与 git 状态跟着刷新、未保存改动怎么让位 | `src-tauri/src/watch.rs`、`hooks/useFileWatch.ts`、`hooks/useDocuments.ts` |
| `git-commit` | 提交工具窗口：分组变更树、暂存、提交与修正、停在冲突中间时的横幅 | `components/GitPanel.tsx`、`ConflictWidget.tsx`、`ResolveConflictsDialog.tsx`、`lib/recovery.ts`、`hooks/useGitState.ts` |
| `git-log` | 日志工具窗口：三栏、筛选与多选、两套右键菜单、差异预览 | `components/GitLogPane.tsx` |
| `git-branches` | 分支弹层、引用右键动作、标签与工作树 | `components/BranchPicker.tsx`、`lib/refMenu.ts` |
| `terminal` | 终端会话、换位置与收起都不杀 shell、输出补画 | `components/TerminalPane.tsx`、`lib/term.ts`、`lib/termStore.ts`、`src-tauri/src/term.rs` |
| `run` | 运行配置（二十四族识别：npm / Maven / Gradle / Spring / 裸 java / Go 与 Wails / Cargo / Python / .NET / PHP / Ruby / Dart / Scala / Elixir / C·C++ / Zig / Deno / Clojure / Haskell / Julia / Lua / Swift / 裸脚本）、运行/重跑/停止、编辑程序配置页 | `components/RunControls.tsx`、`RunConfigsPage.tsx`、`RunPane.tsx`、`hooks/useRunConfigs.ts`、`useRunSessions.ts`、`src-tauri/src/run/`、`src-tauri/src/proc.rs` |
| `settings` | 设置页各栏、settings.json 读写与默认值合并 | `components/SettingsPage.tsx`、`lib/settings.ts`、`hooks/useSettings.tsx`、`src-tauri/src/settings.rs` |
| `tray-lifecycle` | 托盘、点关闭是收进托盘还是退应用、退出前强制保存与看门狗 | `src-tauri/src/tray.rs`、`lib/window.ts` |
| `localization` | 中英词典与 Provider、语言怎么带到 Monaco / xterm / 托盘菜单 | `src/i18n/`、`lib/errors.ts` |

## 写作约定

这是给人看的工程文档，不是产品页，也不是对话记录。

- 中文正文，文件名 kebab 英文。
- 只写代码里能证实的东西。改了实现就改文档。
- 短句，事实在前。一条一行，说完就停，不做段落收尾的感想。
- 不写拟人称呼（那颗、这一排、摊开给你改），不写自问自答（"为什么："这种），不用破折号串句，
  不整句加粗。设计原因要写，但压成一句陈述，跟在事实后面，不单独起一段讲心路。
- 具体值要留：键位、尺寸、颜色、阈值、上限、状态字母、命令参数。这些是改代码时要用到的。
- 正文里不夹 `文件:行号`。行号集中在文末的「代码」一节，正文只在必须指名某个函数时写函数名或文件名。
  出处给到文件级就够，行号会随每次提交漂移。
- 链接用相对路径，模块之间互相指（`../git-branches/`），同一份事实不在两处写。
- 不写"TODO 待补"。没做的进 `docs/plans/`，做完再进 `features/`。
