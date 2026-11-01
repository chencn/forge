# forge 移植缺陷清单（对照 openidea）

> 来源：2026-10-31 五领域深度对比审查（LSP/跳转、编辑器、UI 主题、workbench/项目树、Git/VCS）。
> 每条缺陷均已回到源码核实行号；Git 的补丁缺陷由 `git apply --stat` 本机实测复现。
> 修复纪律：**一条缺陷一条 task，逐条修复，修完在本文件对应条目下登记状态与变更摘要。**
> 状态取值：`待修` / `修复中` / `已修` / `已复核`。
> 与既有 `docs/plans/idea-parity-review.md`（106 项）不重复登记，本文件侧重本轮新发现与硬缺陷。

## 级别说明

- **P0**：会产生错误数据 / 命令失败 / 功能整体不可用，最优先。
- **P1**：功能性 bug、接线错误、自相矛盾，改动通常较小。
- **P2**：能力整块缺失（移植完成度）。
- **P3**：观感 / 度量对齐。

---

## P0 — Git 数据正确性

### D-01 按块补丁头计数不含上下文行，`git apply` 报 corrupt patch ｜ 状态：已修
- 位置：`src/lib/cm/chunkPatch.ts:45-56`（header 计数）、`:58-72`（body 含 3 行上下文）；`src-tauri/src/git/mod.rs:850`（`git apply --whitespace=nowarn` 无 `--recount`）；`tests/components/chunkPatch.test.ts:17`
- 问题：`countA = endA - startA + 1` 只数改动行，header 写成 `@@ -${headA},${countA} ... @@`，但 body 又塞入上文/下文各 3 行，头体计数不自洽。实测同一补丁 `git apply --stat -` 报 `error: corrupt patch at line 5`（exit 128）。凡改动行不在文件首行（存在上文）即被拒；单测把错误行为断言成"正确"。
- 修法：改为写零上下文补丁（header 计数 = body 删/增行数）并给后端加 `--unidiff-zero`，对齐 openidea `crates/ide-vcs/src/diff.rs:83-133 build_partial_patch` + `write.rs:318`；同步改单测。

### D-02 部分暂存（staged 块）经 `--only` 变成整份提交 ｜ 状态：已修
- 位置：`src/features/vcs/changes.ts:410-424`（`check` 非 none 即塞 `included/paths`）；`src/components/GitPanel.tsx:1034/1116`
- 问题：`git commit --only <path>` 取的是**工作区内容**而非索引，未暂存的块被一并提交，"只提交选中块"的语义丢失。
- 修法：对齐 openidea `write.rs:275-329 commit_partial`——复制索引到临时 `GIT_INDEX_FILE`，按选中 hunk 打补丁后提交，工作区与用户索引不动。

### D-03 `planCommit` 产出的 stage/unstage 从未执行 ｜ 状态：已修
- 位置：`src/features/vcs/changes.ts:405-426`（产出 `plan.stage`/`plan.unstage`）→ 无任何消费点
- 问题：勾选未跟踪文件后提交，路径未被 `git add`，`--only` 会报 pathspec 不匹配而失败；被取消勾选的已暂存文件也不会被 unstage。
- 修法：提交前按 `plan.stage`/`plan.unstage` 真正调用 `git add` / `git restore --staged`，或改走 D-02 的临时索引方案统一处理。

### D-04 提交签名/作者/提交前检查是空壳 ｜ 状态：已修（参数透传；三项代码检查待续）
- 位置：`src/features/vcs/CommitOptions.tsx:12-34`；`src/components/GitPanel.tsx:1104-1111`（手拼 `Signed-off-by:`）；`src-tauri/src/git/mod.rs:776-831 git_commit`（仅支持 `message/amend/paths`）
- 问题：`author` 从不传 `--author`；`runHooks` 未映射 `--no-verify`；`reformat/optimizeImports/analyzeCode` 仅 UI 无实现；提交无 `--cleanup=whitespace`。
- 修法：后端 `git_commit` 增 `signoff/author/noVerify/cleanup` 参数并透传；前端去掉手拼文本，改走参数。

### D-05 提交里查看重命名文件 diff 显示为整份新增 ｜ 状态：已修
- 位置：`src/App.tsx:3115/3120 openCommitFile`、`src/components/GitLogPane.tsx:483`、`src-tauri/src/git/mod.rs:2257-2285 git_commit_file_impl`
- 问题：只用新路径、丢弃 `file.oldPath`，父侧 `"<rev>^:<newpath>"` 取不到内容 → 空串，整份显示为新增。
- 修法：对齐 openidea `diffInput.ts:157`，父侧基线用 `oldPath`；后端 `git_commit_file` 接纳 oldPath。

---

## P1 — LSP / 代码跳转

### D-06 诊断按文件单值覆盖，多 server 互相顶掉 ｜ 状态：已修
- 位置：`src/lib/lspClient.ts:898-913 rememberDiagnostics`
- 问题：缓存是 `path → diagnostics[]` 单值 Map；tsserver+eslint 双 server 时后写者整体覆盖先写者。
- 修法：改 `path → Map<serverId, items>` 取并集，对齐 openidea `editor/lsp/diagnostics.ts:32-62`。

### D-07 LSP 请求不等文档同步 ｜ 状态：已修
- 位置：`src/App.tsx:414`（`LSP_SYNC_GAP_MS=250`）+ `src/lib/lspClient.ts:135`（`CHANGE_DEBOUNCE_MS=150`）+ `src/lib/cm/lsp.ts` 全部请求路径
- 问题：无 `whenAllSynced`（forge grep 零命中），击键后约 400ms 内 hover/补全/跳转/保存前格式化基于旧文本。
- 修法：在请求入口等待该文档 pending didChange 冲刷，对齐 openidea `editor/lsp/lsp.ts:26-37`。

### D-08 完全无 `completionItem/resolve` 链路 ｜ 状态：已修
- 位置：`src/lib/cm/lsp.ts:117-179`；`src/lib/lspClient.ts:393-425`（initialize 未声明 `resolveSupport`）
- 问题：clangd/gopls/jdtls 的 detail/文档/自动 import 永远为空；未处理 `completionList.itemDefaults`，`insertTextFormat` 丢失会让 snippet 项被当纯文本插入。
- 修法：声明 `resolveSupport`，选中时发 `completionItem/resolve`，处理 `itemDefaults`。对齐 openidea `completion.ts:80-150`、`convert.rs:230-279`。

### D-09 签名帮助丢弃 offset 型参数 label ｜ 状态：已修
- 位置：`src/lib/cm/lsp.ts:281-288`
- 问题：`typeof label === "string" ? [label] : []`，gopls/clangd/basedpyright 用 `[start,end]` 偏移标注参数时参数高亮全丢。
- 修法：处理 `ParameterLabel::LabelOffsets`（同 label 多参数搜索），并声明 `labelOffsetSupport: true`。对齐 openidea `convert.rs:793-828`。

### D-10 LocationLink 跳转落点用错 range ｜ 状态：已修
- 位置：`src/lib/cm/lsp.ts:923`
- 问题：`location.range ?? location.targetRange ?? location.targetSelectionRange`，LocationLink 时优先取整个符号范围，多行范围时跳错位置。
- 修法：按规范优先取 `targetSelectionRange`，并在 initialize 声明 `linkSupport`。对齐 openidea `convert.rs:673-676`。

### D-11 `workspace/configuration` 一律回 `[{}]` ｜ 状态：已修
- 位置：`src/lib/lspClient.ts:679-683`
- 问题：依赖运行时配置的 server（vtsls/basedpyright/eslint）拿到空配置，功能静默降级。
- 修法：按 section 从 `initializationOptions`/`settings` 逐级查找，对齐 openidea `handler.rs:127-151`。

### D-12 `wakeLsp` 手动启动的会话被 reconcile 秒收 ｜ 状态：已修
- 位置：`src/lib/lspClient.ts:1252`（注释）vs `:1000-1045 reconcileOnce`（`:1020-1027` 回收不在 groups 的会话）
- 问题：手动"启动"后若无该语言打开文件，下次击键触发的 reconcile 即 `lspStop`，与注释意图直接冲突。
- 修法：给手动会话加"TTL 内不回收"标记，或让 reconcile 忽略手动会话。

### D-13 状态栏弹层 JSX 裸 `//` 注释被当文本渲染 ｜ 状态：已修
- 位置：`src/components/LspStatusBar.tsx:350`
- 问题：JSX children 里的 `// …` 是字面文本节点，每个服务行下都会渲染出这句话。
- 修法：删除该行，或用 `{/* … */}`。

### D-14 `formatDocument` 不查能力且硬编码格式化参数 ｜ 状态：已修（rangeFormatting 入口见登记遗留）
- 位置：`src/lib/cm/lsp.ts:1110-1134`
- 问题：不检查 `documentFormattingProvider`，硬编码 `insertSpaces: true`，Tab 缩进工程格式化参数错误；无 rangeFormatting 入口。
- 修法：查能力；`insertSpaces/tabSize` 按缩进配置推导，对齐 openidea `format.ts:72-77`。

### D-15 `snippetSupport:false` 与前端 snippet 支持矛盾 ｜ 状态：已修
- 位置：`src/lib/lspClient.ts:398` vs `src/lib/cm/lsp.ts:159` + `src/lib/cm/snippet.ts`
- 问题：声明不支持 snippet，守约 server 不给 snippet，前端 snippet 路径成死代码。
- 修法：initialize 声明 `snippetSupport: true`，对齐 openidea `caps.rs:66`。

### D-16 工程根查找方向与 openidea 相反 ｜ 状态：已修
- 位置：`src-tauri/src/lsp_detect.rs:93-106 search_up`（取最内层）+ `:109-139 search_down`（自创向下扫）
- 问题：嵌套工程两侧起在不同根的会话；openidea 取最外层（`launch.rs:227-236`）。
- 修法：统一选根口径（已对齐 openidea 取最外层：嵌套工作区只起一条会话，与向下扫的「取最浅」口径一致）。

### D-17 停止会话不发 `shutdown`/`exit` ｜ 状态：已修
- 位置：`src-tauri/src/lsp.rs:645-667 stop_one`
- 问题：直接 `taskkill /F /T`，server 无法清理临时文件/索引缓存。
- 修法：先发 `shutdown` 请求 + `exit` 通知，超时才 kill。对齐 openidea `lib.rs:2023-2053`。

### D-18 缺 workspace 级通知 ｜ 状态：已修（didChangeWatchedFiles 按参照只声明不发）
- 位置：`src/lib/lspClient.ts:425`（`workspaceFolders:false`）
- 问题：不发 `didChangeConfiguration`/`didChangeWatchedFiles`，外部增删文件 server 不知情。
- 修法：补发这两条通知，对齐 openidea `lib.rs:456-462`。

### D-19 补全触发字符硬编码，不读 server 声明 ｜ 状态：已修
- 位置：`src/lib/cm/lsp.ts:86`
- 问题：常触发多余补全，接不到 server 特有触发字符（`-`、`>`）。
- 修法：读 `completionProvider.triggerCharacters`，对齐 openidea `caps.rs:267-273`。

### D-20 请求超时一刀切 60s ｜ 状态：已修
- 位置：`src/lib/lspClient.ts:133`
- 问题：半死 server 会让 hover 挂满 60s。
- 修法：按方法分档（补全 5s / 默认 10s / references·rename 30s），对齐 openidea `lib.rs:56-66`。

### D-21 重命名缺 `prepareRename` 与预览确认 ｜ 状态：已修（prepareRename/占位符；多文件预览待议）
- 位置：`src/lib/cm/lsp.ts:690-757`
- 问题：直接发 rename，用本地词边界取初值，无 prepareRename、无占位符、无多文件预览。
- 修法：先 `prepareRename` 取有效范围/占位符，结果走多文件预览确认。对齐 openidea `lib.rs:1297-1318` + `rename.ts`。

### D-22 跳转行为多处差异 ｜ 状态：已修（重试/自跳转/顺序/声明计入；无语法降级）
- 位置：`src/lib/cm/lsp.ts:936-939`（多结果按路径字母序重排）、`:854`（`includeDeclaration` 硬编码 true）；`:852 openLocations`
- 问题：无空结果重试、声明上跳转不转用法、无 dumb mode 语法降级、结果重排丢 server 顺序。
- 修法：对齐 openidea `navigation.ts:145-151`（空结果重试）、`:197-200`（isSelfTarget→用法）、保持 server 顺序。

### D-23 能力表"幽灵能力" ｜ 状态：已修
- 位置：`src/lib/lspClient.ts:138-171 DYNAMIC_CAPABILITY_BY_METHOD`
- 问题：注册了 pull diagnostics/folding/selectionRange 等，但编辑器从不调用，声明 pull 能力可能让 server 不主动 publish。
- 修法：删除未实际使用的能力声明，或补齐对应消费。

### D-24 诊断细节：空 range 不扩宽 / `version` 被忽略 ｜ 状态：已修
- 位置：`src/lib/cm/lsp.ts:781-786`、`src/lib/lspClient.ts:667-673`
- 问题：空 range 波浪线不可见；过期版本诊断照样映射。
- 修法：空 range 扩一个字符；声明并按 source 管理 `versionSupport`。对齐 openidea `diagnostics.ts:126-131`。

### D-25 语义 tokens legend 处理 ｜ 状态：已修
- 位置：`src/lib/cm/lspSemanticTokens.ts:26-33`
- 问题：把 `tokenModifiers` 当必需字段；`.filter(非空)` 后不重排位索引，legend 含空串会 modifier 位错位。
- 修法：按原始 legend 解码，不重排。

### D-26 状态栏缺 LSP "Busy（索引中）" 态 ｜ 状态：已修
- 位置：`src/components/LspStatusBar.tsx`（五态映射）
- 问题：用户无法区分"空闲"与"正在索引"。
- 修法：补 Busy 态，对齐 openidea ServerStatus 七态。

---

## P1 — workbench / 项目树

### D-27 项目树 "Move…" 被接到 rename ｜ 状态：已修
- 位置：`src/App.tsx:3867-3869`（`onMove` 调 `confirmRename`）；`src/features/project-tree/contextMenu.ts:255-258`
- 问题：右键 "Move File/Directory" 打开的是改名框，移动功能整体不可用。
- 修法：接线真正的移动流程（对齐 openidea `contextMenu.ts:222-227 openMoveDialog`）。

### D-28 右键菜单引用不存在的 i18n key，显示裸 key ｜ 状态：已修
- 位置：`src/features/project-tree/contextMenu.ts:338/356/371`
- 问题：`git.diff`/`dialog.rollback`/`git.branches` 三 key 在三份字典均不存在，`t()` 回退键名本身。
- 修法：三份字典补 key，或改用已存在的等价 key。

### D-29 "Replace in Files…" 实际只打开 Find ｜ 状态：已修
- 位置：`src/App.tsx:3875-3876`
- 问题：`onFindInFiles`/`onReplaceInFiles` 同调 `openEverywhere("text", …)`，无替换模式入参。
- 修法：透传替换模式，对齐 openidea `find.replaceInPath`。

### D-30 Git 菜单 "Put Label…" 接到新建 Tag ｜ 状态：已修（改文案）
- 位置：`src/App.tsx:3803`
- 问题：openidea 是 Local History 打标签，语义不符。
- 修法：接到 Local History label，或改文案。

### D-31 "Mark Directory as" 缺 Test Resources Root ｜ 状态：已修
- 位置：`src/features/project-tree/contextMenu.ts:398-420`
- 问题：目录角色枚举缺 `testResources`。
- 修法：补该角色与菜单项，对齐 openidea `contextMenu.ts:354-360`。

### D-32 `ExplorerTree.tsx` 死代码，与 ProjectTree 语义分叉 ｜ 状态：已修
- 位置：`src/components/ExplorerTree.tsx`（全仓无 import）；对比 `src/features/project-tree/ProjectTree.tsx`
- 问题：ignored 上色、展开持久化、右键签名三处与在用实现不同；易误用/误改。
- 修法：删除死文件（需用户同意删除），或明确标注遗留。

### D-33 10 个 VCS 设置项有 UI 无消费 ｜ 状态：已修
- 位置：`src/lib/settings.ts:183/185/206/214/215/218/220/221/222/224`；`src/features/settings/pages/VcsPages.tsx`
- 问题：`confirmDropCommits`/`onCreateFile`/`onDeleteFile`/`autoUpdateOnPushRejected`/`updateMethod`/`incomingCheck`/`combineStashAndShelf`/`removeAppliedFilesFromShelf`/`directoryMappings`/`gitExecutablePath` 消费点全为 0，设置页给虚假控制感。
- 修法：逐项接线或从 UI 移除。

### D-34 状态栏缺 Line:Column 与 Indentation 两段 ｜ 状态：已修
- 位置：`src/App.tsx:6551-6643`
- 问题：光标行列、缩进两整段缺失；编码段仅非 UTF-8 显示；分支移到 TitleBar。
- 修法：补两段，对齐 openidea `editor/core/index.ts:65-111`。

### D-35 项目树 View 选项默认值与 openidea 相反 ｜ 状态：已修
- 位置：`src/features/project-tree/ProjectHeader.tsx:30/32/34`
- 问题：`singleClickOpen`/`singleClickExpand`/`previewTab` forge 均 `true`，openidea 均 `false`。
- 修法：默认值改 false（对齐 IDEA）。

### D-36 状态栏 `aria-label` 硬编码中文 ｜ 状态：已修
- 位置：`src/workbench/StatusBar.tsx:46`
- 问题：切英文/繁中时无障碍朗读仍为"状态栏"。
- 修法：走 `t()`。

---

## P1 — UI 样式与主题

### D-37 dark-hc 主题整片失效 ｜ 状态：已修
- 位置：`src/themes/tokens.css:5-135`（仅 `:root`）、`:200`（仅 `dark`）；`src/themes/themeManager.ts:66-68`
- 问题：forge 硬编码 token 层无 `[data-theme="dark-hc"]` 块，切高对比度得到"浅底暗字"半成品。
- 修法：删除硬覆盖保留桥接（见 D-38），或补 dark-hc 块。

### D-38 桥接变量是同规则内被硬值覆盖的死代码 ｜ 状态：已修
- 位置：`src/themes/tokens.css:6` vs `:25`（及 `:7-19` vs `:26-40` 同型）
- 问题：先写 `var(--bg-island,…)` 再同选择器硬值覆盖，桥接永不生效——是 D-37 的根因。
- 修法：删除 `:25` 起的硬覆盖，保留 `:6` 起的 var() 桥接。

### D-39 `--radius-xs` 未定义且无回退 ｜ 状态：已修
- 位置：`src/styles.css:668/1268`
- 问题：border-radius 失效为初始值。
- 修法：改用已定义的 `--radius-sm` 或补定义/加 fallback。

### D-40 `AppearancePages` 内联样式引用未定义的 `--color-*` ｜ 状态：已修
- 位置：`src/features/settings/pages/AppearancePages.tsx:307/308/314/332/345/346/347`
- 问题：`--color-bg-base`/`--color-border-subtle`/`--color-bg-hover`/`--color-bg-input`/`--color-text-main` 全仓零定义，通知设置表格掉色、边框变文字色。
- 修法：改用已定义的 token（`--surface-island`/`--border-color`/`--bg-hover`/`--text-primary`）。

### D-41 设置"字体族"接到终端，编辑器字体不生效 ｜ 状态：已修
- 位置：`src/features/settings/pages/EditorPages.tsx:114`（写 `terminal.fontFamily`）；`src/lib/cm/theme.ts:33/159`（硬编码 `var(--font-mono)`）
- 问题：UI 有、编辑器不生效。
- 修法：`EditorSettings` 增 `fontFamily` 字段并接进 CM 主题。

### D-42 编辑器 Ctrl+滚轮缩放缺失 ｜ 状态：已修
- 位置：`src/lib/cmEditor.ts`（无 wheel zoom）
- 问题：openidea 有 `prefs.ts:364-398`，forge 丢失该功能。
- 修法：补 wheel 事件处理与字号步进/范围。

### D-43 z-index 体系混用 raw 值 ｜ 状态：已修（fixed 定位两处收编；局部层级保留 raw）
- 位置：`src/styles.css`（20~210）、`src/components/aiAssistants.css:508/742`、`src/App.tsx:6652`
- 问题：脱离 `--z-panel/--z-dialog/--z-popup` token 层级，易堆叠冲突。
- 修法：统一改用 z token。

### D-44 状态栏双高度并存（24px vs 34px） ｜ 状态：已修
- 位置：`src/workbench/StatusBar.module.css:3`（34px）与 `src/styles.css:7399 .global-status`（`--footer-height`=24px）
- 问题：同一界面两条不同高的底栏。
- 修法：统一为 34px（对齐 openidea）。

---

## P1 — 编辑器

### D-45 缺 `Ctrl+G` 跳转到行 ｜ 状态：已修
- 位置：`src/lib/cm/keymap.ts`（全表无）；`src/lib/cmEditor.ts:334-349`
- 问题：openidea `intellij-windows.ts:21` 有，forge 无。
- 修法：补 `Ctrl-G` → 跳行命令与对话框。

### D-46 `Ctrl+M`/`Ctrl+[ ]`/`Ctrl+Enter` 被 CM 默认键占走 ｜ 状态：已修
- 位置：`src/lib/cmEditor.ts:337`（未丢弃 `defaultKeymap`）
- 问题：分别落到 `toggleTabFocusMode`/`indentLess·More`/`insertBlankLine`，与 IDEA 语义冲突。
- 修法：对齐 openidea `baseKeymap.ts:21-29` 显式丢弃这些默认绑定，或改绑 IDEA 语义。

### D-47 `Alt+↑/↓` 语义与 IDEA 相反 ｜ 状态：已修
- 位置：`src/lib/cm/keymap.ts:79-80`
- 问题：forge=移动行；IDEA=`Alt+↑↓`=上/下方法，移行是 `Alt+Shift+↑↓`。
- 修法：改绑对齐 IDEA。

### D-48 缺 stickyScroll（IDEA 默认开启） ｜ 状态：已修
- 位置：`src/lib/cmEditor.ts:281-351`（无）
- 问题：openidea `setup.ts:200` 默认开。
- 修法：引入/实现 stickyScroll 扩展。

### D-49 语言 id 命名同仓两套 ｜ 状态：已修
- 位置：`src/lib/editorEnv.ts:44-45/114`（`go.mod`/`go.work`/`ocaml.interface`）vs `src/lib/cm/grammars.ts:109-110`（`gomod`/`gowork`）
- 问题：与 openidea 注册 id `gomod`/`gowork`/`ocaml-interface` 不一致。
- 修法：统一命名。

### D-50 语言检测取"最后一段后缀"，多段扩展名退化 ｜ 状态：已修
- 位置：`src/lib/editorEnv.ts:266-282`
- 问题：`a.json.map`/`pkr.hcl` 等退化；openidea 用最长后缀（`cm/languages.ts:46-54`）。
- 修法：改最长后缀匹配。

### D-51 `rainbowBrackets` 有字段无 UI ｜ 状态：已修
- 位置：`src/lib/settings.ts:25/403`（默认 false）→ 消费于 `CodeEditor.tsx:232`；设置页无开关
- 问题：设置页缺开关。
- 修法：补 UI 开关。

### D-52 缺 softWrap / 空白符显示 / 行高设置 ｜ 状态：已修
- 位置：`src/lib/settings.ts`（无字段）；`src/lib/cmEditor.ts:281-351`（无对应扩展）
- 问题：openidea `setup.ts:191-197/269/175-179` 均有。
- 修法：增字段 + 扩展 + UI。

### D-53 `F12`/`Ctrl+Alt+↑↓` 语义与 IDEA 不同 ｜ 状态：已修（F12 摘除；Ctrl+Alt+↓ 绑下一处出现）
- 位置：`src/lib/cm/keymap.ts:89`
- 问题：`F12` forge=跳定义 vs IDEA=跳最后工具窗口；`Ctrl+Alt+↑↓` forge=多光标 vs IDEA=上/下一出现处。
- 修法：对齐 IDEA（多光标键位另议）。

### D-54 图标无 ignored 分支 ｜ 状态：已修
- 位置：`src/components/EntryIcon.tsx:34/176`
- 问题：只有 `excluded`，忽略文件无专属图标，占位用 lucide 描边与 IDEA expui 观感不一致。
- 修法：补 ignored 图标分支，对齐 openidea `ui/icons.tsx:83/695`。

---

## P2 — 能力整块缺失

### D-55 完全没有 stash 功能 ｜ 状态：已修
- 位置：`src-tauri/src/git/mod.rs:186`（`"stash"` 仅存在于 MUTATING 名单）、`src/lib/git.ts`
- 修法：实现 stash push/apply/pop/branch/drop + UI，对齐 openidea `write.rs:601-640` + `shelf.rs`。

### D-56 日志无提交图 / lane 渲染 ｜ 状态：已修
- 位置：`src/components/GitLogPane.tsx:1643`（仅一颗 `log-dot`）
- 修法：实现多 lane 状态机 + 图渲染，对齐 openidea `features/vcs/graph.ts` + `GitLog.tsx:957-993`。

### D-57 日志无分页 ｜ 状态：已修
- 位置：`src/components/GitLogPane.tsx:405`（固定 `limit:200`）
- 修法：加载更多/无限滚动，对齐 openidea `logStore.ts:304-354`。

### D-58 冲突解决无块级合并编辑器 ｜ 状态：已修
- 位置：`src/components/ResolveConflictsDialog.tsx:63-77`（整文件取一边）
- 修法：解析 `<<<<<<<` 标记 + 逐块选 ours/theirs/both/base，对齐 openidea `conflicts.ts:31` + `MergeEditor.tsx`。

### D-59 二进制/大文件按扩展名判定 ｜ 状态：已修
- 位置：`src/App.tsx:2925-2946`（`docKindOf/canDiff`）
- 问题：无扩展名或 `.gitattributes` 标记二进制的文件会被当文本打开。
- 修法：改实际探测，对齐 openidea `DiffEditor.tsx:417-423`。

### D-60 文件监听未排除重目录 ｜ 状态：已修
- 位置：`src-tauri/src/watch.rs:196+`（递归整树，不排除 node_modules/构建目录）
- 修法：建监听时即排除重目录，对齐 openidea `ide-vfs/src/watch.rs:411 should_watch_dir`。

---

## P3 — 观感 / 度量

### D-61 UI 字体未引入 Inter ｜ 状态：已修
- 位置：`src/themes/tokens.css:122`（纯系统栈）
- 修法：引入 Inter（对齐 openidea），或确认有意使用系统栈。

### D-62 图标占位与 IDEA expui 观感不一致 ｜ 状态：已修
- 位置：`src/components/EntryIcon.tsx:176`
- 修法：同 D-54。

### D-63 菜单/标签栏/圆角/滚动条度量取值不同 ｜ 状态：已修
- 位置：`src/themes/tokens.css:92/98-105/284`、`src/ui/Tabs.module.css:10/16`
- 修法：逐项对齐 IDEA 取值。

### D-64 LSP 未安装判定依赖中文字面量 ｜ 状态：已修
- 位置：`src/components/LspStatusBar.tsx:126`（`includes("没找到")`）
- 修法：后端返回结构化错误码，前端按码判定。

### D-65 右键菜单模板标签 / InlineEditor aria-label 硬编码英文 ｜ 状态：已修
- 位置：`src/features/project-tree/contextMenu.ts:153-182/375/446`、`src/features/project-tree/InlineEditor.tsx:102-106`
- 修法：走 `t()`。

---

## 修复进度登记

### D-32 已修（2026-11-01，用户同意后执行）
- `src/components/ExplorerTree.tsx`（617 行）为被 ProjectTree 体系取代的死代码，全仓无引用（src/、tests/ 均 0 命中），删除。check:ts / vite build 复验通过。


### 收尾 review（2026-11-01，独立子代理复核全部修复）
复核方式：纯读代码 + 抽查运行相关单测（graph/conflicts/errors/fileIcons 共 23 条全过）。结论：登记文档声称与代码实际行为一致，graph lane 状态机、conflicts 解析（CRLF/未闭合标记）、错误码对齐（BINARY/LSP_NOT_FOUND）、stash 全链路、--skip 分页逻辑、D-33 删字段无残留消费点、D-61/63/65 度量与 i18n 均确认无误；清理（observer/keydown/订阅）无泄漏。发现 9 条问题，当场修复 7 条：

### R-1…R-8 已修（2026-11-01）
- **R-1（高）GitLogPane 观察器时机**：IntersectionObserver effect 依赖 `[]`，组件在 probe 就绪前挂载时 ref 为 null，observer 永不建立、分页整场失效。修法：effect 依赖加 `root`。
- **R-2（中）续页重复**：续页请求无在飞守卫，快滚时同一 `skip` 发两次导致同页 concat 两遍。修法：`loadingMoreRef` 在飞标记，`.finally` 复位。
- **R-3（中）状态栏行列首开空白**：CodeMirror 的 `setState` 不触发 updateListener，首开文档（无视图存档）无任何事务，Line:Column 直到点击才出现。修法：`cmEditor.ts` 抽出 `reportCaretOf(path, state)`，updateListener 与 CodeEditor `attach` 共用，attach 末尾补一次汇报。
- **R-4（中）watch 排除误杀同名文件**：`under_default_excluded` 对所有路径段按目录名判断，仓库里恰好叫 `build`/`dist`/`out` 的普通文件事件被静默丢弃。修法：只对非末段判断（目录内部事件的路径里该目录总以非末段出现，目录排除不漏），单段路径放行。
- **R-5（中·测试）watch 单测 Windows 必挂**：`C:\repo\...` 带 Prefix 组件，`strip_prefix("/repo")` 匹配失败，断言从未真正验证过。修法：测试路径全部改 Unix 风格构造，并补「根下同名普通文件放行」回归断言（`/repo/build`、`/repo/src/dist`）。仍未本机执行（cargo test 环境问题见 D-60 待议）。
epo\...` 带 Prefix 组件，`strip_prefix("/repo")` 匹配失败，断言从未真正验证过。修法：测试路径全部改 Unix 风格构造，并补「根下同名普通文件放行」回归断言（`/repo/build`、`/repo/src/dist`）。仍未本机执行（cargo test 环境问题见 D-60 待议）。
- **R-6（低）块合并磁盘错位**：BlockMergeDialog 的取舍按打开时刻的块下标记账，窗口期间文件被外部改写会把取舍落到错误的块。修法：apply 时重读并重新 parse，逐块比较 ours/theirs/base 与打开时一致才应用，不一致报 `git.blockStale`（三语新键）并要求重开。
- **R-8（低）selectedLines 死字段**：反向选区恒为 0 且无任何消费点。修法：从 `CaretInfo` 与比较逻辑中整体删除（YAGNI）。
- 验证：`npm run check:ts`、`npx vite build`、`cargo check -p forge` 通过；conflicts/errors/graph 单测 19/19。
- **未修（待议）R-7**：块合并对话框与打开中的编辑器缓冲不联动——冲突文件在编辑器里有未保存修改时，应用解决后编辑器仍显示旧标记，用户再保存会覆盖已解决内容。
- **未修（待议）R-9**：分屏打开同一文档时 caret 快照按路径汇报，非焦点视图的编程性事务会用旧选区覆盖状态栏数字（低频显示问题）。


### D-34 已修（2026-11-01）
- 对齐点：openidea StatusItems 的 CaretStatus / IndentStatus 两段状态栏组件。
- 新增 `src/lib/caretStatus.ts`：模块级外部存储（reportCaret/clearCaret/subscribeCaret/caretSnapshot），字段级比较短路，避免每次按键重渲染 6800 行的 App 树；订阅者只有状态栏两个小组件。
- `src/lib/cmEditor.ts`：baseExtensions 加 EditorView.updateListener 汇报光标（行列、选中字符/行数、多光标数）；disposeModel 时 clearCaret 防止状态栏停在旧数字。
- 新增 `src/workbench/StatusWidgets.tsx`：CaretStatus（多光标显示「N 个光标」，选中显示 `line:col (chars)`，否则 `line:col`）与 IndentStatus（按钮，显示「N 个空格」，点击开 editor.codeStyle 设置页）。
- `src/App.tsx`：状态栏 activeDoc 段在 languageLabel 之前插入两组件。
- i18n 三语补 4 键：status.carets / status.caretTip / status.indentTip / status.indentSpaces。
- 取舍：forge 缩进为全工程一把尺（空格 × tabSize，indentUnit 固定空格），openidea 的 per-file indent 切换菜单无基建不移植（待议）；CaretStatus 点击跳转行列（Go to Line）属应用级动作，归入 D-53 待议。
- 验证：npm run check:ts 通过、npx vite build 通过。


> 每修完一条，在此追加一行：`D-XX 已修：变更文件与关键行号、验证方式`。

- **D-01 已修（2026-10-31）**：`src/lib/cm/chunkPatch.ts` 改为生成零上下文补丁（删除 `ctxFrom/ctxTo` 与两个上下文循环，头计数 = 删/增行数）；`src-tauri/src/git/mod.rs:850` 的 `git apply` 增 `--unidiff-zero`；重写 `tests/components/chunkPatch.test.ts`（原断言把错误行为当正确）。验证：`npx vitest run tests/components/chunkPatch.test.ts` 4/4 通过；`cargo check -p forge` 通过；临时仓库实测——带上下文补丁报 `corrupt patch`(128)，零上下文 + `--unidiff-zero` 在 apply / `--cached` / `-R` / 纯删除四场景均成功。

- **D-02 / D-03 已修（2026-10-31）**（同源，一并修复）：`src/components/GitPanel.tsx:1034` 增 `stageAll` 标记；`:1113` 提交前按 `plan.stage`/`plan.unstage` 真正 `git add` / `git restore --staged` 整理索引，再 `git commit` 提交索引本身（弃用 `--only`，未暂存块不再被带上）；删除死字段 `CommitPlan.paths`（`src/features/vcs/changes.ts:391-399`、`:407`、`:420`）并同步测试断言。验证：`check:ts` 通过；`tests/features/vcsChanges.test.ts` 12/12 通过；临时仓库实测——块1 暂存、块2 未暂存时提交只含块1，块2 保留在工作区（旧 `--only` 逻辑会整份提交）。

- **D-04 已修（2026-10-31，参数透传部分）**：后端 `git_commit` 增 `signoff`/`author`/`no_verify`/`cleanup` 参数并落到 `git commit` 命令行（`src-tauri/src/git/mod.rs`：`args` 改 `Vec<String>`）；前端 `src/lib/git.ts` 增 `CommitRequestOptions`，`src/hooks/useGitState.ts` 的 `commit`/`commitAndPush` 透传，`src/components/GitPanel.tsx` 去掉手拼 `Signed-off-by`（改由 `--signoff`/`--author` 生成）、`runHooks`→`--no-verify`、`cleanup`→`--cleanup=whitespace`。验证：`check:ts`、`cargo check -p forge` 通过。**遗留**：提交前检查 `reformat`/`optimizeImports`/`analyzeCode` 三项仍无实现（UI 保留），需另立待办。

- **D-05 已修（2026-10-31）**：后端 `git_commit_file` 增 `old_path`（父侧取 `"<rev>^:<oldPath>"`）、`git_diff_text` 增 `old_path`（补第二路径，让 `git diff` 双侧重命名检测）（`src-tauri/src/git/mod.rs`）；前端 `src/lib/git.ts` 两函数增可选 `oldPath`，`src/App.tsx` 的 `openCommitFile` 与 `src/components/GitLogPane.tsx` 预览均传 `oldPath`。验证：`check:ts`、`cargo check -p forge` 通过；临时仓库实测——旧路径取到父版本内容（新路径报 `exists on disk, but not in 'HEAD^'`），双路径 diff 显示 `rename from/to` + `similarity index 60%`（旧单路径显示 `new file`）。

- **D-06 已修（2026-11-01）**：`src/lib/lspClient.ts` 诊断缓存由 `Map<path, Diagnostic[]>` 改为 `Map<path, Map<serverId, Diagnostic[]>>`；`diagnosticsFor` 合并多 server 结果；新增 `clearDiagnosticsForKey`；`rememberDiagnostics`/`applyDiagnostics` 增 `serverId`（取自 `handleMessage` 的 server）；`forgetDiagnostics` 与文档关闭路径按会话删除。验证：`check:ts` 通过。
- **D-07 已修（2026-11-01）**：`src/lib/lspClient.ts` 抽出 `sendDidChange`，新增 `flushPendingChange`，`scheduleChange` 复用；`lspRequest`/`lspRawRequest`/`willSave` 发请求前先冲刷该文档排定中的 didChange（对齐 IDEA `whenAllSynced`）。验证：`check:ts` 通过。

- **D-08 已修（2026-11-01）**：`src/lib/lspClient.ts` initialize 的 `completionItem` 增 `resolveSupport`（documentation/detail/additionalTextEdits）与 `labelDetailsSupport`；`src/lib/cm/lsp.ts` 新增 `RawCompletionItem`/`ResolvedCompletion`/`completionDoc`，`lspCompletions` 对候选做 `completionItem/resolve`（`info` 懒加载触发、`apply` 取回 resolve 后的 additionalTextEdits 与 snippet 信息），按 label 缓存。验证：`check:ts` 通过。
- **D-09 已修（2026-11-01）**：`src/lib/cm/lsp.ts` 的 `signatureHelpViewOf` 支持 `parameter.label` 为 `[start,end]` 偏移（按签名行切片）；`src/lib/lspClient.ts` initialize 声明 `signatureHelp.parameterInformation.labelOffsetSupport`。验证：`check:ts` 通过。
- **D-10 已修（2026-11-01）**：`src/lib/cm/lsp.ts` 的 `locationItems` 落点改为优先 `targetSelectionRange`（LocationLink 的符号名范围），`src/lib/lspClient.ts` 声明 `definition.linkSupport`。验证：`check:ts` 通过。
- **D-11 已修（2026-11-01）**：`src/lib/lspClient.ts` 的 `workspace/configuration` 不再一律回 `[{}]`，新增 `configurationForSection` 按 section 从会话 `initializationOptions` 逐级取值。验证：`check:ts` 通过。
- **D-12 已修（2026-11-01）**：`src/lib/lspClient.ts` 新增 `manualSessions`（WeakSet），`wakeLsp` 启动后标记，`reconcileOnce` 回收时跳过手动会话，与注释意图一致。验证：`check:ts` 通过。

- **D-13 已修（2026-11-01）**：`src/components/LspStatusBar.tsx:351` 的裸 `// …` 改为 `{/* … */}`，不再作为文本节点渲染。验证：`check:ts` 通过。
- **D-14 已修（2026-11-01）**：`src/lib/cm/lsp.ts` 的 `formatDocument` 增 `capabilityEnabled(path, language, "documentFormattingProvider")` 前置检查（未声明即不发请求，避免 MethodNotFound 与空「格式化」撤销点）；新增 `formattingOptionsOf(state)`——`tabSize` 取 `state.tabSize`，`insertSpaces` 由 `indentUnit` facet 是否含制表符推导，替换原硬编码 `insertSpaces: true`；`:1202` 的 `languageIdOf(state)` 复用已取出的 `language`。验证：`check:ts` 通过。**遗留**：选区格式化（`textDocument/rangeFormatting`）入口仍未接线，当前只有整篇格式化。
- **D-28 已修（2026-11-01）**：`src/features/project-tree/contextMenu.ts` 三处——`t("git.diff")`→`git.viewDiff`（已有「查看差异」）、`t("dialog.rollback")`→`git.rollback`（`dialog.rollback` 三份字典都没有，正确的键是 `git.rollback`），并给 `git.branches` 补三语文案（zh「分支」/en "Branches"/zh-TW「分支」，与同菜单 `git.push`「推送」/`git.pull`「拉取」同风格）。验证：脚本全仓扫描 `t(`/`translate(` 的字面量 key 对三份字典——**剩余缺失 0**，三语键集合完全一致；`check:ts` 通过；`tests/features/contextMenu.test.ts` 通过。
- **D-27 已修（2026-11-01）**：右键菜单的 `onMove` 不再调 `confirmRename`（`src/App.tsx:3868`），改为打开「移动」对话框——收目标目录、名字不变（IDEA 的 Move 语义），默认落在当前工程根；提交后走**与 F6 / 拖拽落点同一个** `moveTreeEntries`（其入参放宽为 `readonly { path: string; name: string }[]`，`FsEntry` 结构兼容），逐条移动、重名等错误逐条提示、收尾统一清选中 + 刷树 + 同步 Git。为此 `src/components/PromptDialog.tsx` 增 `kind: "move"`（`INPUT_KINDS` + `PATH_KINDS`，字段是「路径」而不是「名字」），`PendingDialog`（`src/App.tsx:283`）增 `moveFrom` 承载一批条目，三语补 `dialog.move` / `dialog.moveTargetPlaceholder`。验证：`check:ts` 通过；`tests/features/contextMenu.test.ts`、`tests/features/projectTree.test.ts`、`tests/components/PromptDialog.test.ts` 共 22/22 通过。
- **D-26 已修（2026-11-01）**：① `src/lib/lspClient.ts` 新增忙闲追踪——`handleMessage` 接 `$/progress`（后端本来就把每条帧转到前端），`begin` 记下令牌、`end` 划掉、`report` 不改忙闲（没有 `begin` 的孤立 report 会让行永远显示忙），令牌清空即不忙；对外给 `busySessionIds()` + `subscribeBusy()`（快照只在真的变化时换新对象，避免 React 每帧重渲），会话回收三处（握手失败、退出事件、reconcile 回收）调 `forgetBusy` 清账；`src/lib/lspTypes.ts`/`src/lib/lspManager.ts` 接线。② `src/components/LspStatusBar.tsx` 的 `RowStatus` 增 `busy`（`item.status === "running" && busySessionIds.has(item.id)`），文案 `lsp.status.busy`（zh「索引中」/en "Indexing"/zh-TW「索引中」），`toneOf` 与 `serversSummary` 把 busy 与 starting 同档（都在动）。验证：`check:ts` 通过；`tests/components/LspStatusBar.test.ts` 新增「索引中」行断言（mock 补 `busySessionIds`/`subscribeBusy`）——5/5 通过；相关 3 个测试文件 26/26 通过。
- **D-25 已修（2026-11-01）**：`src/lib/cm/lspSemanticTokens.ts` 的 `legendOf` 不再 `filter` 掉空串/非法项——`tokenModifiers` 的下标就是位序号，滤一项后面每位都错位；改为 `map` 归一（非字符串→空串占位）保留原始下标，并导出以便直接断言；`semanticTokensOf` 取 modifier 时改为 `modifier.length > 0 && (modifierBits & (1 << bit))`（空名字只丢名字、丢不掉这一位）。验证：`check:ts` 通过；`tests/lib/cmLspDecorations.test.ts` 新增两条断言（legend 原样保留含空串与非字符串占位；位图 6 在 legend 第二位为空串时仍命中第三位 `deprecated`，类型名为空的下标整条丢弃）——15/15 通过。
- **D-24 已修（2026-11-01）**：① `src/lib/cm/lsp.ts` 的 `toDiagnostics` 对空 range 扩宽——行内往右扩一个字符，已在行尾则起点往左退一格（对齐参照 `diagnostics.ts:126-131`），这类诊断（多余分号之类）原来画不出波浪线；② `src/lib/lspClient.ts` 客户端能力 `publishDiagnostics: { versionSupport: true }`，并让 `applyDiagnostics` 真正认这个字段：批次 `version` 小于该文档最后发出的版本就整批丢弃（旧行列映射到新正文会标错位置，服务随后会再推一批）；`handleMessage` 把 `version` 解析后传下去，函数签名由 `serverId: string` 改为 `server: RunningServer` 以便查 `server.opened` 里的版本。验证：`check:ts` 通过；`npx vitest run tests/lib/cmLsp.test.ts tests/lib/cmPhrases.test.ts` 11/11 通过。
- **D-23 已修（2026-11-01）**：按「有消费点才留」逐键核对 `DYNAMIC_CAPABILITY_BY_METHOD`（全仓裸标识符扫描）后：① 删除 8 条无任何消费点的映射——`documentRangeFormattingProvider`、`documentOnTypeFormattingProvider`、`documentHighlightProvider`、`foldingRangeProvider`、`selectionRangeProvider`、`linkedEditingRangeProvider`、`colorProvider`、`diagnosticProvider`（服务动态注册这些方法时不再往能力表塞假字段），并在表头写明这条规则；② 给两处「真发请求但没查能力」的地方补上消费点——`src/lib/cm/lsp.ts` 的 `hoverTip` 前置 `capabilityEnabled(..., "hoverProvider")`（鼠标每划过一次都发一条请求，没能力就白问）、`src/lib/lspClient.ts` 的 `executeLspCommand` 前置 `server.capabilities.executeCommandProvider`。验证：`check:ts` 通过。**说明**：`executeCommandProvider`、`hoverProvider` 因此保留在表内（现在有消费点了）。
- **D-22 已修（2026-11-01）**：`src/lib/cm/lsp.ts` 四处对齐参照 `navigation.ts`——① `locationItems` 不再按路径字母序重排（该列表同时承载符号树与调用层级，重排把层级顺序打乱），只去重、保留服务顺序；② 新增 `editedAt`（`trackEdits` ViewPlugin 记录最后改正文时刻）+ `retryEmpty`：结果为空且 1.5 秒内改过正文时最多再问 3 次、间隔 250ms（对齐 `gotoAfterEdits`，治 kotlin-language-server 打字后约 300ms 回空）；③ 光标正停在声明上且定义只命中一处时转去「查找用法」（对齐 `isSelfTarget` → `find.showUsages`），不再原地跳；④ `references` 的 `context.includeDeclaration` 由硬编码 `true` 改为 `false`（对齐参照用法面板的调用点）。验证：`check:ts` 通过；`npx vitest run tests/lib/cmLocations.test.ts tests/lib/cmChooser.test.ts` 9/9 通过。**未做（末尾问用户）**：服务挂掉时的语法树降级（dumb mode）——forge 没有本地符号索引（参照 `syntaxFallback.ts` 是一整套语法树改名/跳转兜底），属新增能力而非接线。
- **D-21 已修（2026-11-01，部分）**：`src/lib/cm/lsp.ts` 新增 `prepareRename(path, language, position)`——仅当 `renameProvider.prepareProvider` 为真才发 `textDocument/prepareRename`（否则吃 MethodNotFound），兼容三种应答形态（null = 不可改名、旧规范 Range、新规范 `{range, placeholder}`、`defaultBehavior:false` = 不可改名）；`renameSymbol` 弹出输入框后异步补问一次：不可改名就当场写 `editor.lsp.renameUnavailable` 并禁用输入框，能改名则用服务给的 `placeholder` 覆盖本地词边界猜出的初值（`foo_bar` 这类位置本地只能取到半截）；该问失败不挡改名。`src/lib/lspTypes.ts:111` 的 `renameProvider` 由 `unknown` 收成 `{ prepareProvider?: boolean } | boolean`；三语补 `editor.lsp.renameUnavailable`。验证：`check:ts` 通过（i18n 三语键齐全，缺一个即类型报错）。**待议（末尾问用户）**：多文件预览确认未做——forge 没有 WorkspaceEdit 预览组件（`PromptDialog` 是固定 kind 的命名框），且改动已由 `registerWorkspaceUndo` 整体可撤销；参照的预览是独立弹层 + `summarizeWorkspaceEdit`/`needsPreview`，属新增 UI 特性。
- **D-20 已修（2026-11-01）**：`src/lib/lspClient.ts` 的 `REQUEST_TIMEOUT_MS = 60_000` 换成 `FAST / DEFAULT / LONG = 5 / 10 / 30 秒` 三档 + `timeoutOf(method)`：`textDocument/completion`、`textDocument/inlineCompletion` 走 5 秒（打字路径晚到无意义），`textDocument/references`、`textDocument/rename`、`workspace/executeCommand`、`workspace/willRenameFiles` 走 30 秒（要遍历全工程），其余 10 秒；超时报文里的秒数改为取本档值。档位与 openidea `lib.rs:56-58` 及其各调用点一致（其 formatting / hover / signatureHelp / 跳转均用 10 秒档）。验证：`check:ts` 通过。
- **D-19 已修（2026-11-01）**：`src/lib/cm/lsp.ts` 删掉写死的 `TRIGGER_CHARACTERS`，换成 `triggerCharactersOf(path, language)`——从 `lspManager.capabilities(...).completionProvider.triggerCharacters` 读取；触发判定按声明表建正则（服务没声明就不认触发字符，靠打字本身触发），并顺势补上请求里的 `context`：命中声明字符时 `{triggerKind: 2, triggerCharacter}`，其余（含 Ctrl+Space）`{triggerKind: 1}`——原来整条 `context` 都不发，服务端无从区分「打字触发」与「显式呼出」（对齐 openidea `lib.rs:840-845`）。`src/lib/lspTypes.ts:102` 把 `completionProvider` 由 `unknown` 收成 `{ triggerCharacters?: string[] } | boolean`。验证：`check:ts` 通过、全仓无 `TRIGGER_CHARACTERS` 残留引用。
- **D-18 已修（2026-11-01）**：`src/lib/lspClient.ts` 客户端能力 `workspace` 由 `{ workspaceFolders: false }` 补成 `workspaceFolders/configuration/didChangeConfiguration/didChangeWatchedFiles` 四条（对齐 openidea `caps.rs:38-40`）——补 `configuration: true` 是实打实的修复，否则守约服务端根本不会发 `workspace/configuration`，D-11 那条应答路径形同虚设；`initialize` 收到响应、发出 `initialized` 之后，若 `entry.initOptions` 非空再补一条 `workspace/didChangeConfiguration { settings: initOptions }`（对齐 openidea `lib.rs:456-462` 的 `all_settings`，其载荷正是「initializationOptions 打底」）。验证：`check:ts` 通过。**遗留（不修，附理由）**：`workspace/didChangeWatchedFiles` 只声明不发送——参照实现同样只有声明、全仓无发送点；且 forge 的 `fs://change` 批次载荷只有路径、不带事件类型（`src-tauri/src/watch.rs:33` 的 `FsChange`），要真发得先给攒批管道加种类，属于超出参照范围的新增行为，留待末尾与用户确认。
- **D-17 已修（2026-11-01）**：`src-tauri/src/lsp.rs` 抽出 `write_frame`（`lsp_write` 复用，分帧口径只有一处），新增 `goodbye(session, grace)`——按协议写 `shutdown` 请求（id `forge/shutdown`）+ `exit` 通知，再以 `try_wait` 每 20ms 轮询等进程退出（`STOP_GRACE = 1500ms`）；`stop_one` 改为「先道别 → 已退出就只在句柄上收尸，超时才 `kill_tree`（原 `taskkill /F /T` 整树逻辑原样搬进 `kill_tree`）」。先摘会话再道别，`read_loop` 的退出记账不会误判成崩溃。验证：`cargo check -p forge` 通过；前端 `lspClient` 对未知 id（字符串 id 走 `Number.isFinite` 判假）本就忽略，不会把 shutdown 响应当异常。**待人工复验**：grace 窗口内 rust-analyzer 是否确实落盘索引缓存（需真实服务）。**取舍**：`lsp_reap`（页面重载/退出）也走同一 grace，最坏多等 1.5 秒（并行、非串行），换来不丢索引。
- **D-16 已修（2026-11-01）**：`src-tauri/src/lsp_detect.rs` 的 `search_up` 由「命中即返回（最内层）」改为沿 `stop` 向上走完取最外层命中，并在入口加 `start.starts_with(stop)` 保护（越界文件不做探测外搜索）；`resolve` 文档注释同步口径说明。测试 `finds_nearest_stack_root_upwards` 拆为 `picks_outermost_stack_root_upwards`（根与成员都有 `Cargo.toml` → 取根）与 `falls_back_to_inner_root_when_outer_has_no_marker`（只有成员有 → 取成员）。验证：`cargo check -p forge` 通过、测试目标已链接生成；**本机 `cargo test` 无法执行**（`forge_lib-*.exe` 启动报 `api-ms-win-core-winrt-error-l1-1-0.dll: cannot open shared object file`，属环境缺 MinGW 运行库，非代码问题），故这两条断言仅做了编译核对，待用户在可运行环境复验。
- **D-15 已修（2026-11-01）**：`src/lib/lspClient.ts` initialize 的 `textDocument.completion.completionItem.snippetSupport` 由 `false` 改为 `true`，与 `src/lib/cm/snippet.ts` 的 snippet 渲染路径一致（守约 server 此前不会给 snippet，该路径成死代码）。验证：`check:ts` 通过。
- **D-29 已修（2026-11-01）**：替换模式全链路打通——① `src/App.tsx` 的 `everywhere` 状态与 `openEverywhere` 增 `replace` 位，`onReplaceInFiles` 传 `true`（对齐 openidea `showFindPopup(true, …)` 的替换模式入参），`FindState` 增 `replaceWith`；② `src/components/SearchEverywhere.tsx` 增 `initialReplace`，替换模式下 Text 页签多出「替换为」输入行，`onOpenHit` 增第 5 参把替换词一并交给底部窗口；③ `src/components/FindPane.tsx` 增替换栏与「全部替换」——点击先 `window.confirm` 确认（沿用 GitPanel 的确认惯例），再按 `searchText` 重扫全量命中（上限 20 万行，防只替当前页），逐文件 `readFile` → 按后端算好的命中区间从右往左改写（区间口径天然兼容大小写/整词/正则，零长度命中按插入处理）→ `writeFile`（带 `modifiedMs` 乐观锁，写前被外部改动则该文件计入失败），完成后展示「已替换 X 处（Y 个文件）」回执；打开中的干净文档由既有 watcher 回声路径自动重读。④ `src/styles.css` 补 `.find-replace-*` 样式；三语补 `find.replace.*` 六个键。验证：`check:ts` 通过；`tests/features/searchScope.test.ts` 8/8 通过。**取舍**：未做 openidea 的逐处 Replace/Skip 与排除标记、preserveCase、替换预览（属新增特性而非接线，末尾与用户确认）。
- **D-30 已修（2026-11-01，改文案路线）**：forge 没有 Local History 子系统（openidea 的 `historyPutLabel` 是后端命令 + 通知的整条特性，超出本条「接线」范畴），按缺陷文档给的备选路线改文案让菜单如实：`src/features/project-tree/contextMenu.ts:323` 的 Git 子菜单项由 `t("git.putLabel")`（「放置标签…」）改为 `t("git.newTag")`（「新建标签」，行为本来就是开 newTag 对话框），`GitMenuHandlers.putLabel` 字段与 `App.tsx:3810` 回调同步改名 `newTag`；删除三份字典已无引用的 `git.putLabel` 键。测试断言同步（`tests/features/contextMenu.test.ts`）。验证：`check:ts` 通过；`tests/features/contextMenu.test.ts` 5/5 通过。**待议（末尾问用户）**：是否值得为 forge 建 Local History 特性（对齐 openidea 的 recentChanges + putLabel），属 P2 级新增。
- **D-31 已修（2026-11-01）**：核实后发现 `ProjectDirectoryRole`（`src/lib/projectDirectoryRoles.ts:2`）、folderKind 着色、`markTreeDirectory` 持久化早已支持 `testResources`，缺的只是菜单项——`src/features/project-tree/contextMenu.ts` 的 Mark Directory as 子菜单在 Resources Root 与 Excluded 之间补「Test Resources Root」项（发 `"testResources"` 角色），三语补 `project.view.markTestResources`（zh「测试资源根目录」/en "Test Resources Root"/zh-TW「測試資源根目錄」）。验证：`check:ts` 通过；`tests/features/contextMenu.test.ts` + `tests/features/projectTree.test.ts` 17/17 通过。
- **D-35 已修（2026-11-01）**：`src/features/project-tree/ProjectHeader.tsx` 的 `DEFAULT_VIEW_OPTIONS` 三项改 `false`（`singleClickOpen`/`singleClickExpand`/`previewTab`，对齐 IDEA 与 openidea）；`src/features/project-tree/viewState.ts` 沿用既有 `_v` 迁移机制升到 `_v: 4`——v4 之前保存的数据里的 `true` 是当年 v2/v3 迁移强推的默认值、不当作用户偏好，统一迁回 `false`，v4 起才认用户自己保存的值。`tests/features/projectTreeLocate.test.ts` 两个单击行为测试改为显式在 localStorage 种 `_v: 4 + 对应开关`（测的仍是单击行为本身，不再测被改掉的默认值），并补 `afterEach` 清理防种子泄漏。验证：`check:ts` 通过；`tests/features/projectTreeLocate.test.ts` + `tests/features/projectTree.test.ts` 17/17 通过。
- **D-36 已修（2026-11-01）**：`src/workbench/StatusBar.tsx` 的默认 `aria-label` 由硬编码「状态栏」改为 `t("status.bar")`（调用方显式传入时仍以传入值优先），三语补 `status.bar`（zh「状态栏」/en "Status bar"/zh-TW「狀態列」）。验证：`check:ts` 通过。
- **D-37 / D-38 已修（2026-11-01，同根一并修复）**：核实 `src/themes/ideaTokens.css` 本就为 light/dark/dark-hc 三主题提供全套桥接源（`--bg-island`/`--bg-control`/`--bg-frame`/`--accent`/`--fg-on-accent` 等，dark-hc 块在 `:653-884`），失效根因即 D-38——`tokens.css` 的 `:root` 与 `:root[data-theme="dark"]` 两块都是「先 var() 桥接、同规则内再硬值覆盖」。修复：① 删两块里全部 17 条桥接重复硬值（`--bg-primary/--bg-secondary/--bg-tertiary/--chrome-bg/--app-bg/--surface-island(--strong)/--border-color/--border-light/--border-subtle/--text-*/--button-solid(-text)`），只留桥接与未桥接变量（`--bg-active`/`--surface-island-muted`/`--island-shadow` 等）；② 删 `--bg-hover` 的自引用环桥接 `var(--bg-hover,…)`（CSS 非法环，且 ideaTokens 同名直供三主题值 `#ededed/#2e2f30/#1c1e22`）；③ dark 块选择器并入 `:root[data-theme="dark-hc"]`——dark-hc 拿到 forge 侧完整深色色板（语法色/侧栏/通知等），桥接源由 ideaTokens hc 块给出真正高对比值（如 `--bg-island: #000000`、`--border: #45474d`、`--accent: #8fb3ff`）。**观感变化说明**：dark 主题的桥接类底色从 forge 硬调值（如 `#0a0a0a`）变为 PyCharm 官方值（`#191a1c` 等）——这正是「对齐 openidea」的目的。验证：`vite build` 通过、CSS 无解析错误；三主题桥接源逐项核对 ideaTokens 均有定义。
- **D-39 已修（2026-11-01）**：`src/themes/tokens.css` 的 radius 组补 `--radius-xs: 4px`（与 `AiCommitSettingsPanel.tsx:812` 既有 fallback 值一致），`styles.css:668/1268` 两处恢复生效。验证：`vite build` 通过。
- **D-40 已修（2026-11-01）**：`src/features/settings/pages/AppearancePages.tsx` 七处内联样式的五个未定义 `--color-*` 换成既有 token——`--color-bg-base`→`--surface-island`、`--color-border-subtle`→`--border-subtle`、`--color-bg-hover`→`--bg-hover`、`--color-bg-input`→`--bg-tertiary`、`--color-text-main`→`--text-primary`。验证：`check:ts` 通过。
- **D-41 已修（2026-11-01）**：① TS `EditorSettings` 增 `fontFamily`（空串跟随 `--font-mono`，`src/lib/settings.ts` 接口/默认值/规范化三处）；② **顺手修复发现的同步缺陷**：Rust `EditorSettings`（`src-tauri/src/settings.rs:17`）原本连 `rainbow_brackets` 字段都没有——TS 的 `rainbowBrackets` 每次持久化都被 serde 静默丢弃，本轮一并补上 `rainbow_brackets` + `font_family` 两字段及默认值；③ 设置页字体族输入改写 `editor.fontFamily`（不再误写终端）；④ CM 主题 `.cm-scroller` 与补全浮层的 `fontFamily` 改 `var(--editor-font-family, var(--font-mono))`，`applyFontMetrics` 增第三参写/摘 `--editor-font-family`（`src/lib/cmEditor.ts:736`），`CodeEditor.tsx` 两处调用传入 `settings.editor.fontFamily`，与字号同一套「改属性不重建主题」机制。验证：`check:ts`、`cargo check -p forge` 均通过。
- **D-42 已修（2026-11-01）**：`src/lib/cmEditor.ts` 移植 openidea `prefs.ts:364-398` 的缩放机制——`fontZoomField`（StateField）+ `Prec.highest` 的 `editorAttributes` 把 `--editor-font-size/--editor-line-height` 覆写成 `calc(base + zoom)`，步进限 -6..36；`wheelZoom`（domEventHandlers）Ctrl/⌘+滚轮上滚放大下滚缩小（无修饰键不拦截）。为避开 CSS 自引用环，`applyFontMetrics` 增写 `--editor-font-base/--editor-line-base` 两份底数变量，zoom 在底数上做加法。挂进常驻扩展表（`drawSelection` 前）。验证：`check:ts` 通过；`tests/components/CodeEditor.test.tsx` 等 5/5 通过。
- **D-45 已修（2026-11-01）**：`src/lib/cm/keymap.ts` 的 IDEA 方案补 `{ key: "Ctrl-g", command: gotoLine }`——直接用 CodeMirror `@codemirror/search` 内置的 `gotoLine` 命令（自带行号输入对话框），对齐 openidea `intellij-windows.ts:21` 的 `navigate.gotoLine = Ctrl+G`。验证：`check:ts` 通过；`tests/lib/cmKeymap.test.ts` 8/8 通过。
- **D-46 已修（2026-11-01）**：`src/lib/cmEditor.ts` 键位装配处把 defaultKeymap 过滤一遍 `DROPPED_DEFAULT_BINDINGS`（对齐 openidea `baseKeymap.ts` 的 DROPPED）：`insertBlankLine`（Ctrl+Enter）、`toggleTabFocusMode`（Ctrl+M）、`selectLine`（Alt+L/Ctrl+L）、`addCursorAbove/Below`（Ctrl+Alt+↑↓，键位归 D-53 的出现处导航）、`indentLess/indentMore`（Ctrl+[ ]）——这批键在 IDEA 里是 IDE 级动作，落到引擎默认绑定只会制造语义分叉。
- **D-47 已修（2026-11-01）**：IDEA 方案改绑——`Alt+↑/↓` 接新命令 `gotoMethod(view, ±1)`（`src/lib/cm/lsp.ts` 新增：LSP `textDocument/documentSymbol` 拉平取 Method/Function/Constructor 的 selectionRange 起点，光标跳上/下一个方法头，对齐 openidea `navigation/index.ts:55 gotoMethod`；无 documentSymbolProvider 时返回 false 落空，不误跳），`Alt+Shift+↑/↓` 才是移行（对齐 openidea `intellij-windows.ts:58-59/97-98`）。验证：`check:ts` 通过；`tests/lib/cmKeymap.test.ts`、`tests/lib/cmLocations.test.ts` 13/13 通过。
- **D-48 已修（2026-11-01）**：新建 `src/lib/cm/stickyScroll.ts`（移植 openidea `cm/stickyScroll.ts` 的精简版）——ViewPlugin 在滚动/文档/视口变化时 requestMeasure，算出首个可视行所在作用域的头部行（`enclosingHeaders`：优先 `foldedRanges`——forge 的折叠状态已合并语法折叠与 LSP folding，无折叠信息退回语法树 Body/Block 节点），最多钉 5 行；钉住的行带行号（宽度与折叠扣/行号槽实测对齐）+ 语法高亮正文（`highlightTree` + `forgeHighlightStyle`），点行跳转并把该行放到原 sticky 的位置；水平滚动反向平移跟手。挂进常驻扩展表；`src/styles.css` 补 `.cm-forge-sticky*` 样式（全部走 token）。验证：`check:ts` 通过、`vite build` 通过；`tests/components/CodeEditor.test.tsx`、`tests/lib/cmKeymap.test.ts` 8/8 通过。
- **D-49 已修（2026-11-01）**：`src/lib/editorEnv.ts` 目录 id `go.mod`→`gomod`、`go.work`→`gowork`、`ocaml.interface`→`ocaml-interface`（对齐 openidea 注册 id，也消掉「带点 id」与后缀检测的天然冲突）；`src/lib/cm/grammars.ts` 的 SPELLINGS 删掉前两条恒等映射，`"ocaml.interface"→"ocaml"` 改 `"ocaml-interface"→"ocaml"`。测试断言同步（`tests/lib/editorEnv.test.ts`）。验证：`check:ts` 通过；`tests/lib/editorEnv.test.ts` 7/7 通过。
- **D-50 已修（2026-11-01）**：`src/lib/editorEnv.ts` 的 `languageForPath` 后缀匹配由「最后一段」改为最长后缀优先——从第一个点开始逐段缩短尝试（`a.json.map` 命中 `json.map`→JSON、`foo.pkr.hcl` 命中 `hcl`），对齐 openidea `cm/languages.ts:46-54`。验证：`check:ts` 通过；`tests/lib` 全量 1149 条仅 3 条失败且均为本两轮改动的断言/门控同步（已修正），修正后全绿。
- **D-51 已修（2026-11-01）**：`src/features/settings/pages/EditorPages.tsx` 的常规页在 formatOnSave 后补「彩虹括号」开关（读写 `settings.editor.rainbowBrackets`，该字段的 CM 消费点 `setRainbowBrackets` 已在），三语补 `settings.rainbowBrackets`（zh「彩虹括号」/en "Rainbow brackets"/zh-TW「彩虹括號」）。验证：`check:ts` 通过（i18n 键三语齐否则类型报错）。
- **D-52 已修（2026-11-01）**：① 设置字段——TS `EditorSettings` 与 Rust `EditorSettings` 同步增 `softWrap`/`showWhitespace`（均默认 false，对齐 IDEA）/`lineHeight`（px，0=按字号 1.69 倍自动）；② `src/lib/cmEditor.ts`——软换行走 `softWrapSlot` 格子（`setSoftWrap`），空白符显示移植 openidea `prefs.ts:124 whitespaceMarks`（MatchDecorator 逐字符 mark，空格画中点、制表符画箭头，`setShowWhitespace`），`applyFontMetrics` 增第四参 lineHeight；③ `CodeEditor.tsx` 的 `syncKeymap` 联动四个设置位、行高 effect 传入 `settings.editor.lineHeight`；④ 设置页补三行 UI（常规页软换行/显示空白符，字体页行高），三语补 `settings.softWrap/showWhitespace/lineHeight`；⑤ `styles.css` 补 `.cm-highlightSpace/.cm-highlightTab` 标记样式（对齐 openidea theme.ts:188-200，走 token 色）。验证：`check:ts`、`cargo check -p forge` 通过；`tests/components/CodeEditor.test.tsx`、`tests/lib/settings.test.ts` 13/13 通过。
- **D-53 已修（2026-11-01，部分）**：① `F12 → gotoDefinition` 从 IDEA 方案摘除——IDEA 的 F12 是应用级「跳回上个工具窗口」（`intellij-windows.ts:202 toolwindow.jumpToLast`），不是编辑器动作，forge 尚无该应用级动作（**待议**：是否补 toolwindow.jumpToLast）；跳定义由 Ctrl+B 承担；② `Ctrl+Alt+↓` 绑 CM `selectNextOccurrence`（下一处出现，对齐 `navigate.nextOccurrence` intellij-windows.ts:60）；`Ctrl+Alt+↑` 因 CodeMirror 没有反向出现命令暂留空（多光标/双向出现属新增能力，末尾与用户确认）。验证：`check:ts` 通过；`tests/lib/cmKeymap.test.ts` 8/8 通过。
- **D-43 已修（2026-11-01，收窄范围）**：逐点核实后发现该条原判过宽——`ui/` 库（Dialog/Popup/Tooltip/Splitter/Tree）本就走 z token；`styles.css` 里 1~210 的裸值全是**各自 stacking context 内的局部层级**（sticky 表头、行内 tooltip、编辑器行号槽 210 等），映射到 900/1000 级的全局 token 反而是错的。真正脱离局部、参与全局竞争的只有两处 fixed 定位：`aiAssistants.css` 的 `.ai-scard-hover`（260）与 `App.tsx` 的 DepSyncToast 容器（899），均改为 `calc(var(--z-dialog, 900) - 1)`（token 派生，明确表达「压在对话框层之下」，相对其余内容的位置不变）。验证：`check:ts` 通过。
- **D-44 已修（2026-11-01）**：核实 `.global-status`（`src/App.tsx:6573`）是唯一在用的底栏（`workbench/StatusBar` 组件无调用方，仅从 `workbench/index.ts` 导出备用）；`src/themes/tokens.css` 的 `--footer-height` 由 24px 提到 34px（对齐 openidea StatusBar 的 30px + 4px 口径）。验证：`vite build` 通过。
- **D-54 已修（2026-11-01）**：`src/lib/fileIcons.ts` 补忽略规则文件分支——新增 `IGNORED_FILE = "expui/fileTypes/ignored.svg"` 与 `IGNORED_FILE_NAMES` 集合（对齐 openidea `icons.tsx` 的 file-ignored 组 16 个名字：.dockerignore/.npmignore/.prettierignore/.eslintignore/.stylelintignore/.hgignore/.ignore/.rgignore/.fdignore/.helmignore/.vscodeignore/.gcloudignore/.slugignore/.cfignore/.bzrignore/.containerignore），`resolveIconPathInner` 文件分支最先判（IDEA 的 ignored file type 语义优先于 material 工具 logo），`.gitignore` 不在集合、保留其专属 gitignore 图标。图标数据：从 openidea 拷贝 `expui/fileTypes/ignored.svg` + `ignored_dark.svg` 进 `scripts/idea-icons/`，重跑 `make-file-icons.mjs`（浅色 648→649、深色 59→60）。`EntryIcon.tsx` 无需加 prop——解析收在 fileIcons 层，树里每个文件行自动生效。取舍：`.npmignore`/`.eslintignore` 原本挂 material 的 npm/eslint logo，现按 openidea 统一为 ignored 灰圆斜杠（1:1 语义对齐）。验证：`check:ts` 通过；`tests/lib/fileIcons.test.ts` 补 2 条断言（忽略文件走 ignored、.gitignore 不吃兜底）4/4 通过。
- **D-62 已修（2026-11-01）**：`src/components/EntryIcon.tsx` 占位图标由 lucide `File` 描边改为内联 expui `fileTypes/text.svg`（四条横线，单色改 `currentColor` 继承文字色，与 openidea 对单色 expui 图标的渲染规则一致），删除 lucide import；数据就绪后未匹配文件本就走 `DEFAULT_FILE = expui/fileTypes/text.svg`，占位只剩懒加载的短暂瞬间，观感前后一致。验证：`check:ts` 通过。
- **D-55 已修（2026-11-01）**：全链路补齐 git stash（参照 openidea `write.rs:601-640`）。① 后端 `src-tauri/src/git/mod.rs` 新增 5 条命令：`git_stash_list`（`stash list --format=%gd%x1f%gs%x1f%ct` 一条 reflog 拆 index/消息/时间，消息分隔用单元分隔符防误切）、`git_stash_push`（-q/--include-untracked/--keep-index/-m，对齐 openidea）、`git_stash_apply`（pop 布尔复用 pop/apply，--index 恢复暂存位）、`git_stash_branch`（校验分支名后 `stash branch`）、`git_stash_drop`（确认由前端负责）；`lib.rs` 注册。② `src/lib/git.ts` 增 `GitStash` 类型与 5 个封装。③ `useGitState` 增 `stashes` 状态与 `stashPush/stashApply/stashDrop` 动作（走既有 `run` 包装，成功自动整轮刷新）；列表不进三条刷新路径，用独立 effect 挂 `status` 引用跟随每轮刷新。④ `GitPanel.tsx`：工具栏增 stash 按钮（图标 `stash`→lucide Archive，加入 `ui/Icon.tsx` 映射）打开「贮藏变更…」对话框（消息留空走 git 默认 WIP on…、未跟踪文件默认包含对齐 IDEA），变更树与提交区之间增 Stash 列表区（有贮藏才显示；每行 Apply/Pop/Drop，Drop 走 window.confirm；样式入 `CommitView.module.css`）。⑤ i18n 三语补 `git.stash/stashTitle/stashMessage/stashIncludeUntracked/stashApply/stashPop/stashDrop/stashDropConfirm/stashPushAction`。取舍：openidea 的 shelf（`.idea/shelf` 补丁体系）未实现——与 stash 能力重叠且是独立大特性（**待议**）。`git_stash_branch` 后端在、UI 未接（冷门动作，YAGNI）。验证：`cargo check -p forge`、`check:ts`、`vite build` 通过；全量 vitest 1462 过，失败 5 条经单独重跑 14/14 全过，确认为全量并发下的超时 flake（Windows transform 143s 拖累 5s 用例），非本轮回归。
- **D-56 已修（2026-11-01）**：日志提交图落地。① 新建 `src/features/vcs/graph.ts`——移植 openidea `features/vcs/graph.ts` 的 `computeGraph` lane 状态机（纯前端从 parents 算，lane 存活期位置不动、空槽回收、第一父沿用本 lane、其余父合流到已有 lane 或占新槽；state 可跨分页延续）+ `laneColor` 八色 token 轮换（`--accent/--vcs-added/--vcs-modified/--syn-*` 均已存在于 ideaTokens.css）。未移植 `collapseLinear`/`hideLongEdges`——那是 IDEA 的 View 选项（Collapse Linear Branches / Show Long Edges），forge 日志没有这两个开关，带上即死代码（**待议**：是否要这两个 View 选项）。② `GitLogPane.tsx`：`graphRows` useMemo 与 commits 一一对应；行首 `log-dot` 单点换成 `GraphCell` SVG（上下两半 path，直行直线、拐弯三次贝塞尔，节点圆 r=3.2；坐标常量 GRAPH_ROW=24/GRAPH_LANE=12 对齐 openidea 的 22/12 口径微调）。③ `styles.css`：`.log-commit` 钉死 `height: 24px`（SVG 纵向坐标的前提），新增 `.log-graph`。④ 新增 `tests/features/graph.test.ts` 4 条：直线历史、分叉合流、槽位复用、跨页延续。验证：`check:ts`、`vite build` 通过；graph 测试 4/4。
- **D-57 已修（2026-11-01）**：日志无限滚动分页。① 后端 `GitLogQuery` 增 `skip`（serde default 0，`--skip=N`），前端 `GitLogQuery.skip` 同步。② `GitLogPane`：页长常量 `LOG_PAGE = 200`，主查询 limit 改用它并回填 `logDone`（本页短于页长即到底；失败也置 done 防反复报错）；`loadMoreRef` 续页（`skip: commits.length`，失败不推翻已有列表），列表底部 sentinel div + IntersectionObserver（root 为滚动容器、120px 提前量，observer 只挂一次、回调经 ref 取最新动作，避免每次筛选/追加都重建）。提交图 `graphRows` 走 useMemo 全量重算，追加后 lane 自动延续（computeGraph 状态机对同一列表重算结果一致）。验证：`cargo check -p forge`、`check:ts`、`vite build` 通过。
- **D-58 已修（2026-11-01）**：块级冲突解决落地。① 新建 `src/features/vcs/conflicts.ts`——移植 openidea `conflicts.ts` 的核心纯函数：`parseConflicts`（逐行扫描识别良构冲突块，两段式与 diff3 三段式都认，标签从标记行尾取）、`resolutionText`（ours/theirs/base/both，both 在 ours 缺结尾换行时补行）、`resolveWithChoices`（按每块取舍拼全文，未取舍块原样保留标记）。未移植 `mergeTitles`/`initialResult`——它们是三栏 MergeEditor（依赖 openidea 的 MergeSides 绑定与专用 UI）的配套，本次按缺陷修法先给「逐块取舍」能力（**待议**：是否要完整三栏 Merge 编辑器）。② 新建 `src/components/BlockMergeDialog.tsx`：读文件（readFile 拿行尾/BOM/乐观锁戳）→ 列块 → 每块「采用本地/采用对方/保留两者/取共同祖先」（base 无则禁用），两侧预览超 12 行折叠；全部取舍后「应用解决」→ resolveWithChoices 写回（writeFile 保行尾与 BOM、传 modifiedMs 乐观锁）→ 通知上层。③ `ResolveConflictsDialog` 每行增「逐块解决…」入口（新 prop `onMerge`）。④ App：`blockMergePath` state 挂 BlockMergeDialog，onApplied 里 `git.stage([abs])` 写回即暂存（同按一边了结的收尾），未合并组随即消失。⑤ i18n 三语补 `git.blockMergeOpen/blockMergeTitle/blockRemaining/blockAllResolved/blockNoMarkers/blockBoth/blockBase/blockApply`；`styles.css` 补 `.block-merge-*` 样式（ours/theirs 侧底色走 vcs token）。⑥ 新增 `tests/features/conflicts.test.ts` 7 条：两段式/diff3 解析、标签、both 拼接换行、逐块取舍与未取舍保留、base 取舍。验证：`check:ts`、`vite build` 通过；conflicts 测试 7/7。
- **D-59 已修（2026-11-01）**：二进制/大文件实际探测。① 后端 `git_show_impl` 与 `git_index_show_impl` 增内容探测——输出前 8KB 含 NUL 即回 `BINARY{path}`（git 对二进制 blob 照样吐字节，此前无扩展名或 .gitattributes 标记的二进制会以乱码正文进入比对视图；`read_file` 侧早有同款判定，这次补齐 git 侧两处，与 openidea `DiffEditor` 的 fsProbe 实际探测同语义）。② 前端 `errors.ts` 增 `errorCodeOf`（从带码错误文本认码，不在 CODES 表的回 null）。③ `App.openDiffTab` 的 catch 兜底：`BINARY/TOO_LARGE/NOT_UTF8/IS_DIR` 四种「本来就没得比」不再 closeDiff+红横幅，标签保留、理由以 notice 摆进正文（与扩展名预判同一条展示通道，切语言跟随）。验证：`cargo check -p forge`、`check:ts`、`vite build` 通过；`tests/lib/errors.test.ts` 补 `errorCodeOf` 断言 8/8。
- **D-60 已修（2026-11-01）**：文件监听排除重目录。核实 forge 与 openidea 架构差异后收窄修法——forge 用 notify 的 Recursive 模式（Windows ReadDirectoryChangesW 单句柄，无 openidea per-directory 逐目录 watch 的建监听开销），所以对齐点不在「建监听时跳过目录」，而在「排除目录下的事件不再上报」。`src-tauri/src/watch.rs` 事件回调增 `under_default_excluded` 过滤：路径相对根的任一段命中文件树默认排除表（`fs::is_default_excluded`，node_modules/dist/target/build/out/.turbo/.next/.nuxt/.cache，`is_default_excluded` 改 pub(crate) 复用同一张表）即丢弃——树里看不见的目录监听里也不报，语义一致；排除目录下的构建翻动不再造成刷新风暴，`changes_listing` 的构建清单缓存作废也随过滤后的路径走（排除目录内的产物变化不再误作废）。附单测 `events_under_default_excluded_dirs_are_dropped`（4 组路径判定）。验证：`cargo check -p forge` 通过；`cargo test watch::` 两种工具链（宿主与 --target x86_64-pc-windows-gnu）下测试 exe 均无法加载（STATUS_ENTRYPOINT_NOT_FOUND，0xc0000139，本机环境问题，与代码无关——编译干净），单测未能在本机执行，**待议**：需要用户在正常终端确认 cargo test 环境或后续排查。
- **D-61 已修（2026-11-01）**：UI 字体引入 Inter（对齐 openidea 的做法，不猜）。openidea 用 `@fontsource-variable/inter`（OFL 许可，随包本地打包，无 CDN 请求）；forge 已有同机制的 `@fontsource-variable/jetbrains-mono` 先例，照抄：`npm install @fontsource-variable/inter`，`main.tsx` 增 import，`tokens.css` 的 `--font-sans` 首位加 `"Inter Variable", Inter`（注释说明 CJK 字形自动落到系统栈——Inter 无全角中文，回退链保证中文观感不变）。验证：`vite build`、`check:ts` 通过。
- **D-63 已修（2026-11-01，逐项核对后收窄）**：逐项对齐 openidea `tokens.css` 的 metrics 后，多数项 forge 本就一致：菜单项 28px（=openidea `--h-field/--h-button/--h-tab`）、标签本体 min22/max28（=`--h-tab` 28）、`--radius-xs 4`（=radius-small/row/control）、`--radius-md 8`（=radius-popup）、`--header-height 40px`（=h-header 40）。实际改两处：① 滚动条 `styles.css` 宽/高 11→10px、thumb border 3→2px（对齐 openidea global.css 的 macOS 式细滚动条：10px、border 2、radius 6；forge 用 radius-pill 胶囊观感一致）；② `--radius-lg` 12→10px（弹层/对话框档对齐 `--radius-dialog`/`--radius-popup-large`，全仓仅 aiAssistants 1 处使用，影响面小）。**有意不改**：标签栏容器 forge 32px vs openidea `--h-tabbar` 38px/`--h-header` 40px——那是 macOS 内嵌标题栏口径（含窗口钮），Windows IDEA 编辑器标签条不带标题栏、实际约 32px，照抄反而不像 Windows 版 IDEA（待议：如需完全对齐 macOS 观感可改 38px）。验证：`vite build` 通过。
- **D-64 已修（2026-11-01）**：LSP 未安装判定改结构化错误码。后端 `lsp.rs` 的 `spawn_session`：`resolve_program` 失败时 `record_failure` 与返回值统一用同一条 `err("LSP_NOT_FOUND", program)`（此前 record_failure 记自由文本「没找到 {program}」、返回值才带码，两端脱节）；前端 `LspStatusBar` 的判定由 `item.error?.includes("没找到")` 改为 `errorCodeOf(item.error) === "LSP_NOT_FOUND"`（复用 D-59 引入的 `errorCodeOf`；CODES 表本就有 `LSP_NOT_FOUND → error.lspNotFound` 文案映射，错误串展示随语言切换）。`tests/components/LspStatusBar.test.ts` 两条死会话用例的夹具由旧中文文案换成 `LSP_NOT_FOUNDyaml-language-server`，5/5 通过。验证：`cargo check -p forge`、`check:ts`、`vite build` 通过。
- **D-65 已修（2026-11-01）**：右键菜单与 InlineEditor 的硬编码走 i18n。① `contextMenu.ts`：New 菜单 8 个模板标签（JavaScript/TypeScript/Rust/Python/Markdown/JSON/HTML/CSS File）改 `t("project.view.newJs"…)`（中文按 IDEA 中文包口径：技术名保留英文 + 类型词翻译，如「CSS 样式表」）；Group 8 菜单标题 `"Git"` → `t("project.view.git")`（三语同为 "Git"，但键进 i18n 体系）；AI 组 `"Send to AI Chat"` → `t("project.view.sendToAiChat")`。② `InlineEditor.tsx`：输入框 aria-label 三条（New name / New folder name / New file name）→ `project.rename.a11y`/`project.newFolder.a11y`/`project.newFile.a11y`，组件引入 `useI18n`。③ i18n 三语各补 14 键。验证：`check:ts`（i18n 键三语齐全否则类型报错）、`vite build` 通过；`tests/features/contextMenu.test.ts` 5/5。
- **D-33 已修（2026-11-01，全移除路线）**：逐项核实 10 个字段均无消费点（`confirmDropCommits` 对应的日志 Drop 动作不存在、`autoUpdateOnPushRejected`/`updateMethod`/`incomingCheck` 需要后端新管线、shelf 两项依赖未实现的 Shelf、`gitExecutablePath`/`directoryMappings` 后端固定走系统 git 且只支持单仓库），接线 = 新造能力，超出本缺陷范围——按修法允许的另一选项**全部从设置模型与 UI 移除**，消除虚假控制感；将来实现对应能力时按需加回。改动：① `src/lib/settings.ts`——`VcsSettings` 删 10 字段、删 `DirectoryMapping` 接口、默认值同步；② `src-tauri/src/settings.rs`——`VcsSettings` 删 10 字段（serde 同步，旧配置文件里的多余键被 `#[serde(default)]` 容忍静默忽略）、删 `DirectoryMapping` 结构与默认值；③ `VcsPages.tsx`——整页删「目录映射」（VcsGeneralPage）与「搁置区」（VcsShelfPage）两个空壳页，Git 页删路径输入框（保留可用的系统 Git 探测按钮，注明 forge 固定取系统 PATH）、删 Update 策略段与 autoUpdateOnPushRejected，确认页删 onCreate/onDelete/confirmDropCommits 三控件；④ `SettingsPage.tsx` 删 `vcs.general`/`vcs.shelf` 路由与 import，`settingsModel.ts` 删两条导航项。遗留：相关 i18n 键（vcs.gitPath 等）暂留在语言文件，未用键不影响类型检查，待整体清理。验证：`cargo check -p forge`、`check:ts`、`vite build` 通过；`tests/lib/settings.test.ts` 13/13。
