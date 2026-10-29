# openidea → forge：侧边栏 Git 面板 + Git 文件比较 像素级对齐方案

状态：**对比稿，未改任何代码**。你确认后按批次实施；每条精确值即验收标准。
参照项目：`D:\app\code\openidea`（React + CSS Modules + CodeMirror，PyCharm 2026.1 "Islands" 设计令牌，默认亮色主题）。

---

## 0. 需求复述与例外项

目标：侧边栏 Git 面板（openidea 的 **Commit 工具窗**）和 **git 文件比较（DiffEditor）** 除以下三项 forge 必须保留外，其余视觉与交互全部按 openidea 像素级照抄（明暗两套主题都对齐）：

| 例外项 | openidea 情况 | forge 现状 | 处理 |
|---|---|---|---|
| **树状显示** | 树/平铺可选，默认**平铺**（目录分组默认关） | 树状默认开 | **保持树状默认开**，其余照抄 openidea 的树实现 |
| **那个点**（目录状态圆点 `.change-dot`） | 没有 | 目录行尾 6px 圆点随最高优先级子项变色 | **保留**，点色改用 openidea 状态色 |
| **M/U 状态字母** | 没有字母（`KIND_LETTER` 定义了但全项目未使用，只靠文件名颜色） | 行尾单字母 M/U/A/D/R/! | **保留**，字母颜色改用 openidea 状态色 |

---

## 1. 两边现状总览

| 维度 | forge 现状 | openidea（目标） |
|---|---|---|
| 分组模型 | 未合并 → 已暂存 → 未暂存 → 未版本控制 → 已忽略 → 修正节 | **Merge Conflicts → Changes → Unversioned Files** 三组 + changelist 细分，复选框纳入模型 |
| 变更列表形态 | 树 + 目录聚合圆点 + 行尾字母 | 虚拟化树/平铺 + **复选框** + 文件名状态色，无字母无点 |
| 状态色 | mark-* 琥珀/红/绿/蓝（VS Code 风） | `--vcs-*` IDEA 状态色七种 |
| 提交区 | 盒式输入框 60px、32px 按钮、AI 组、±行数统计 | 平铺无边框消息区 + 右边距参考线、28px 按钮、检查面板 |
| 单击行为 | **单击即开 diff** | 单击仅选中，**双击/Enter** 开 diff（preview 标签） |
| diff 引擎 | `@codemirror/merge`（同款 ✅） | 同款 |
| diff 工具栏 | 上下处 + 跳源码 + 文件箭头 + 关闭 + 计数 + 分段式排法 | 上下处 + 跳源码 + 排法 toggle + **空白/高亮选择器 + 折叠/同步滚动 + Revert/Stage + Refresh** + "N of M differences" |

---

## 2. A 部分：侧边栏 Git 面板

### A1 分组模型（结构性最大差异）

- openidea：固定三层组，顺序 **Merge Conflicts → Changes → Unversioned Files**（`features/vcs/changes.ts:87`、`GROUP_LABEL` :8-12）；有 changelist 时 Changes 拆成每 list 一组；≥2 仓库时组内再按仓库分层；**ignored 完全不显示**；**Unversioned Files 默认折叠**且复选框默认不勾（opt-in，`changes.ts:62-65`）；重命名文件 detail 显示 `from 旧名`。
- forge 现状：按 git index 拆成 已暂存/未暂存 两组（`GitPanel.tsx:1192-1303`）。
- **改动**：换成 openidea 三组模型 + 每行**复选框**（勾选=纳入本次提交，IDEA 式），暂存/取消暂存退到右键菜单（openidea 同款，含部分暂存 `partial` 徽标）。提交逻辑从"提交已暂存"改为"提交勾选项"（实现上：提交前把勾选文件 git add、未勾选的已暂存文件还原，或按路径提交——实施时定）。
- 已一致项：untracked 报 `dir/` 时目录聚合传播、组内文件按名称排序。

### A2 变更树（像素值）

| 项 | forge 现状 | openidea 目标 | 引用 |
|---|---|---|---|
| 行高 | 24px（工具窗内） | 24px ✅ | `Tree.tsx:145` |
| 缩进 | 每层 13px，起点 28/34 | 每层 **20px**，行 `padding-left = 4 + depth*20`，树左右内边距 **6px** | `Tree.tsx:146,500-501`、`Tree.module.css` |
| chevron 列 | 无固定列 | 固定 **16px** 宽列，图标 16 | `Tree.module.css:74-82` |
| 文件图标 | EntryIcon 13 | **16px** | `CommitView.tsx:537` |
| 行内 gap / 右距 | 6px | **4px** gap、padding-right **8px** | `Tree.module.css:43-49` |
| 行圆角 | 无 | `--radius-selection` **5px** | 同上 |
| 文件名 | ellipsis | `max-width:75%` + ellipsis | `CommitView.module.css:65-71` |
| 目录数量角标 `dir-count` | 有 | **无**（数量只在组行右侧）→ 移除，保留圆点（例外项） | `model.ts:180-182` |
| 组标题 | 12px/600，padding `11px 10px 4px` | 加粗 600 色 `--fg-strong`，右侧计数 "N 个文件" 色 `--fg-subtle`；活动 changelist 加粗、非活动 400 | `CommitView.module.css:72-75,226-228` |
| hover | `--bg-hover` / `--sidebar-hover` | `--bg-tree-hover`：暗 `#ffffff10` / 亮 `#00000008` | `tokens.css:299,603` |
| 选中 | 无持久选中态 | 聚焦 `#2a4371`(暗)/`#d0dffe`(亮)，失焦 `#33353b`/`#e9eaee`；键盘 lead 行 inset 1px focus-ring 50% | `tokens.css:297-298,601-602` |
| 树虚拟化 | 无（全量渲染） | @tanstack/react-virtual，overscan 12 | `Tree.tsx` |
| speed search | 无 | 打字过滤浮条（26px 高、popup 底、radius 4） | `Tree.module.css:101-119` |
| 拖拽 | 无 | 文件/目录拖拽移动 changelist（pointer drag） | `CommitView.tsx:491-521` |

### A3 状态颜色（文件名 + 字母同色）

openidea `KIND_COLOR`（`model.ts:27-45`）内联到文件名；forge 需把 `markClass`（`lib/git.ts:461-467`）的输出换成下表：

| 状态 | openidea 暗 | openidea 亮 | forge 现状（暗/亮） |
|---|---|---|---|
| modified/renamed | `#70aeff` | `#0033b3` | 琥珀 `#fcd34d`/`#92400e` |
| added | `#73bd79` | `#067d17` | 绿 `#86efac`/`#166534` |
| deleted | `#6f737a` | `#6c707e` | 红 `#fca5a5`/`#991b1b` |
| untracked | `#e88f89` | `#b23247` | 绿（同 added） |
| ignored | `#d69a6b` | `#8c4f00` | `--text-muted` |
| conflicted | `#de6a66` | `#de1b2e` | 红（同 deleted） |

- forge `ideaTokens.css` 已有同名 `--vcs-*`（442-447 亮 / 693-698 暗），但**暗色那套值是 openidea 的 dark-hc 档**（如 modified `#92c3ff`），需换成上表 openidea dark 档值；亮色值一致 ✅。
- **删除线**：forge 给删除文件名划线（`styles.css:6446-6451`），openidea 没有 → 移除（决策 D4）。
- 目录圆点（例外项保留）：点色从 forge mark 色改为上表 openidea 色，目录取最高优先级子项色（优先级 conflicted > modified > renamed > added > deleted > untracked，`model.ts:48`）。

### A4 复选框（新组件，CheckMark 照抄）

- 14×14、radius 3、底色暗 `#191a1c`/亮 `#ffffff`、inset 1px `--control-off`（暗 `#5f6269`/亮 `#c3c5cb`）；选中底 `--accent` `#3871e1` 白勾 10px；**半选显示 minus 10px 同蓝底**（`CommitView.tsx:240-268`、CSS :44-61）。
- 聚合：目录=子项聚合三态；unversioned/conflicted 默认不勾；部分暂存默认"仅暂存块"并显示 `partial` 徽标（padding 0 4、radius 4、底 modified 16% 混合、字 11px/14px 高，:82-90）。
- Space 切换勾选、组行复选框联动。

### A5 树上方工具栏

- 现状 forge：刷新/暂存所有/全部取消暂存/折叠全部/展开全部/eye 六颗 24×24（`GitPanel.tsx:1106-1164`）。
- openidea：高 **32px**、gap 2、padding `0 6px`，按钮 **20×20**（IconButton small，radius 4），顺序：
  **refresh(刷新) → undo(回滚 Rollback) → git-pull(更新项目) → eye(View Options) ｜ sep(1×16px，margin 0 4px) ｜ locate(定位已打开文件) → expand-all → collapse-all**（`CommitView.tsx:379-409`）。
- 改动：新增 回滚/更新项目/定位已打开文件 三颗；图标换 openidea expui SVG（16px，暗 `#CED0D6`/亮 `#6C707E`）；分隔线样式对齐。暂存所有/取消暂存两颗 → 移除（决策 D2）。
- View Options 弹出菜单：openidea 为 header "Group By" + Directory 勾选项（锚 bottomLeft+2px）；forge 的"按模块分组/显示忽略文件"为 forge 附加功能 → 保留与否（决策 D3）。
- 进行中操作横幅（rebase/merge）：对齐 `.banner`——min-height 28、padding `4px 10px`、底 `warning 12%` 混合色、1px 下边线、12px 字（`common.module.css:152-170`）。

### A6 提交区（整体重做）

| 项 | forge 现状 | openidea 目标 | 引用 |
|---|---|---|---|
| 消息行 | 修正checkbox+历史+±统计+折叠箭头 | **Amend checkbox + 历史 + 行宽计数**（mono 11px，超限变 warning 色） | `CommitView.tsx:783-823` |
| 输入框 | 盒式：1px 边框+圆角、min-h 60、12.5px | **平铺无边框**：仅 `border-top:1px`，min-height **40**，padding `6px 10px`，mono **13/22**，右侧**边距参考线**（渐变画的竖线，位置可配、可关），placeholder 用 UI 字体 | CSS :124-156 |
| 空消息 | 无提示 | inset 1px `--danger` 描边 + "请指定提交消息" | :229-231 |
| 检查失败 | 无 | 提示条（`--fs-small` warning）+ 按钮文案变 **"仍然提交 (Commit Anyway)"** | :296-329 |
| 按钮 | 提交(I) 32px + 提交并推送(P) + AI 组 + 齿轮24 | **Commit** primary：高 **28**、min-width **72**、padding 0 16、radius **4**、13px；**Commit and Push…** secondary（描边钮）；右端**齿轮 20×20**；行 padding `8px 6px 10px 10px` gap 8 | `Button.module.css:2-19,51-56` |
| 齿轮弹层 | AI 提交配置 | CommitOptions 弹层 **340px** 宽：Git（Author/Sign-off）/ Commit Checks / Advanced 三段，段标题带右横线 | `CommitOptions.tsx:58-84` |
| 快捷键 | Ctrl+Enter 提交 | Ctrl+Enter 提交、**Ctrl+Alt+Enter 提交并推送**、Esc 失焦 | :730-737 |
| 冲突提示条 | `.commit-note is-conflict` | openidea 无此项，样式并入检查提示条形态 | — |

forge 独有项处置：±行数统计（openidea 没有 → D5）、AI 生成按钮（forge 特色 → D5，建议保留但收进 openidea 布局）、修正节只读列表改为 openidea Amend 形态。

### A7 交互行为

| 行为 | forge 现状 | openidea 目标 |
|---|---|---|
| 单击 | **直接开 diff** | **仅选中**（Ctrl/Shift 多选、Ctrl+A 全选） |
| 双击 / Enter | 按设置开 diff 或源文件 | **开 diff，以 preview 标签**（会被下一个 preview 顶替；preview 机制 forge 没有，D6） |
| F4 | 无 | 跳到源文件 |
| Space | 无 | 切换勾选 |
| Delete | 无 | 删除选中 changelist 组（A10 落地后） |
| Esc | 无 | 输入框失焦 |

### A8 右键菜单（照抄顺序与图标）

openidea 顺序：`Show Diff ｜ Jump to Source (F4) ｜ sep ｜ Resolve Conflicts… ｜ Rollback… ｜ Add to VCS ｜ Stage ｜ Unstage ｜ sep ｜ Move to Another Changelist… ｜ Shelve ｜ Create Patch ｜ sep ｜ Show History ｜ Local History ｜ Annotate ｜ sep ｜ Copy Path`（`CommitView.tsx:184-238`）。
forge 顺序不同且多了"三向比对/创建补丁到剪贴板/忽略文件/在独立窗口显示差异"等 → 按 openidea 重排，多出项去留（决策 D7）。目录行、空白行、忽略行菜单同样对齐。

### A9 空态 / 徽章 / 滚动条

- 空态："没有本地更改" **垂直水平居中**、`--fg-subtle`（forge 现左上 `panel-note` 左对齐）；VCS 未配置用 EmptyState（标题+正文居中，body max-width 320）。
- 活动栏徽章：openidea `min-width:13px; height:13px; font-size:9px/600; radius 7; background:--bg-active; color:--fg-emphasis; top:-5px; left:10px`（`ToolWindows.module.css:318-334`）；forge 现蓝色 15px pill 在右下 → 照抄样式与位置。
- 滚动条：宽 **10px**、thumb `#ffffff33`(暗)/`#00000033`(亮)、border 2px transparent、radius 6（`global.css:158-176`）。
- 分支 widget：openidea 在**窗口标题栏左侧**（TitleItem，max-width 280、高 30、radius 6）；forge 在主工具栏 BranchPicker → 属壳层差异，**默认不动**（决策 D11）。

### A10 openidea 有、forge 没有（功能新增，分批）

1. **changelist 体系**：默认 "Changes"；新建/改名/编辑(注释)/设为活动/删除/移动文件(F6)；持久化 JSON；组右键整组操作；活动 list 加粗。建议批次 4。
2. **Stage/Unstage/部分暂存/partial 徽标**（随复选框模型落地）。
3. **定位已打开文件**（locate 按钮）。
4. Shelf / Stash 标签页（openidea header 上 Commit/Shelf/Stash 三 tab、计数、apply/pop 等）→ 体量大，**暂缓**（决策 D8）。

---

## 3. B 部分：Git 文件比较（DiffEditor）

### B1 工具栏（重排 + 增补）

openidea 顺序（`DiffEditor.tsx:545-651`，条高 `--h-header` 40、gap 2、padding 0 6，按钮 20×20 图标 14）：

```
上一处(⇧F7) 下一处(F7) | 跳到源码(铅笔) ‖ [双栏 toggle] [统一 toggle] ‖ [忽略空白 ▾] [高亮 ▾] 折叠未更改(⇧) 同步滚动(🔒 仅双栏) ‖ Revert Change Stage Change ‖ Refresh …… 右端 "N of M differences"
```

- forge 现状（`DiffPane.tsx:135-257`）：上一处/下一处 | sep | 跳源码(ExternalLink) | sep | 上一篇/下一篇 + "{i}/{total} 个文件" | sep | 关闭X | 右端 计数 + 分段式排法控件。
- 改动：
  - **新增**：忽略空白下拉（4 档：不忽略/去尾空白/忽略空白/忽略空白与空行）、高亮下拉（词/行/不高亮）、折叠未更改 toggle、同步滚动 toggle（仅双栏）、Revert Change、Stage Change、Refresh。
  - **移除/替换**：上一篇/下一篇文件箭头与 {i}/{total} 计数、关闭X、分段式排法控件 → 换成两颗 aria-pressed toggle（split/list 图标）；文件间移动改走 F7 链（见 B6）。
  - 计数文案：`N of M differences` / `1 difference` / `Contents are identical`（内容相同）/ `No differences`，右对齐 12px `--fg-subtle`。
  - 跳源码图标换**铅笔**（openidea `edit`），仅当工作区存在该文件时显示。

### B2 两侧版本行

- forge：Lock 图标 + 版本名 + 路径，11.5px，padding-left 8，文案 HEAD/索引/工作区。
- openidea：**无锁图标**；两侧各 `flex:1; padding:0 12px; mono 12px; --fg-secondary`，行高 24，中间缝 1px `--border`；右侧 badge `working copy`/`editable`（底 `--accent-soft`、字 `--accent`、11px、padding 0 5、radius 4）；unified 模式单条 `left → right`；侧名规范：**HEAD / Staged (index) / 短哈希(8位) / Your version / (does not exist) / (deleted)**（`diffInput.ts:76-91`）→ forge 的 "索引/工作区" 文案改为 "Staged (index) / Your version"。
- Tab 标题格式：`文件名 (HEAD ↔ Your version)`。

### B3 配色（核心像素）

| 元素 | openidea | forge 现状 |
|---|---|---|
| 左（旧）改动行背景 | `color-mix(--gutter-deleted 12%)` | `--accent-red-bg` |
| 右（新）改动行背景 | `color-mix(--gutter-added 12%)` | `--accent-green-bg` |
| 词级高亮 | 左 `--danger` 26% / 右 `--success` 26% | red/green 30% |
| 整行插入/删除（无对侧） | danger 26% / success 26% | 同上系 |
| gutter 彩条（3px） | 左=`--gutter-deleted` 灰 `#868a91`/`#767a8a`，右=`--gutter-modified` 蓝 `#375fad`/`#88adf7` | 左红右绿 |
| 行号栏 | 底 `--bg-app`、字 `--fg-gutter` `#4b5059`/`#aeb3c2`、padding `0 8px 0 12px`、min-width 32 | `--bg-editor-gutter` |
| 当前行 / 选区 / 搜索匹配 | `--bg-current-line` `#1f2024`/`#f5f8fe`；`--bg-selected-strong`；accent 22% | 有 |
| 关闭高亮 | 所有 changed 背景强制 none | 无此功能 |

需在 forge 新增 `--gutter-modified/added/deleted`、`--danger`、`--success`（openidea 值：danger `#f57e84`/`#c54e58`，success `#6db083`/`#338555`）等 token 并整体替换 diff 段（`styles.css:6041-6081`）。forge 现有 4px change-lane（IDEA 式彩条槽）保留但颜色换上表；**右侧概览条 openidea 的 diff 没有** → 移除（决策 D10）。

### B4 折叠未更改区

margin 3、**minSize 6**（forge 4）；折叠条 `padding:2px 10px`、底 `--bg-elev`、字 `--fg-subtle` 12px UI 字体（forge `3px 10px` 11.5px）。

### B5 每块（chunk）操作——forge 全缺，新增

1. **中缝 revert 竖列**：宽 **22px**、底 `--bg-elev`、左右各 1px 边线；每 chunk 上下排 `››`/`‹‹` 箭头（chevron 12px、16px 高、无边框），把对侧内容拷过来（`diffControls.ts:20-54`）。
2. **hover Revert**：悬停 chunk 首行时行尾浮出按钮（右 8px、高 16、padding 0 6、1px `--border-strong`、radius 4、底 `--bg-elev`、11px，文本 "Revert"）（:58-143）。
3. **unified Revert**：mergeControls 只出 "Revert" 文本按钮。
4. **Stage hunk**：HEAD↔工作区 diff 右栏每 hunk 前置 12×12 checkbox（"Include in commit"），配合工具栏 Stage Change（`hunkInclusion.ts`）。

### B6 键盘与跨文件链

- 键位：**F7 / ⇧F7** 下一处/上一处、**F4** 跳源码（forge 现无键位）。
- 跨文件链：本篇走到头再按 F7 → 底部居中气泡 **"再按一次转到下一个文件"**（2.5 秒内再按 → 切到链上相邻文件并落到首/末差异；气泡 bottom 40px、tooltip 同款边框/底色、12px，`DiffEditor.tsx:368-414`）。forge 已有"走到头换文件"逻辑 ✅（`DiffPane.tsx:120-128`），缺的是"再按一次"确认气泡，需把左右文件箭头移除后由键盘链承担。
- 计数随光标所在 chunk 实时更新；跳转 `scrollIntoView` 居中、无平滑动画 ✅。

### B7 字体与杂项

- diff 编辑器字体：mono **13px / 行高 22px**（forge 现 13/20，`lib/cm/theme.ts:32-33` → 22）。
- 加载态 Spinner 14px；错误态文本。
- tooltip：data-tooltip 全局系统、600ms 延迟、快捷键以 62% 透明附显（forge 自绘 `[data-tip]` 320ms → 对齐）。

---

## 4. 需要你拍板的决策点

| # | 问题 | 建议 |
|---|---|---|
| D1 | 分组模型换成 openidea 三组+复选框后，forge 的"已暂存/未暂存"两组消失，暂存操作走右键菜单 | 按像素级要求**换**（推荐），提交流程同步改 |
| D2 | 工具栏"暂存所有/全部取消暂存"两颗按钮 openidea 没有 | 移除（右键菜单保留同功能） |
| D3 | View Options 里 forge 的"按模块分组/显示忽略文件" | 保留，排在 openidea 的 Group By 之后（像素差异仅菜单多两行） |
| D4 | 删除文件的划线 openidea 没有 | 移除划线 |
| D5 | 提交区 forge 独有的 ±行数统计、AI 生成按钮 | AI 保留（收进 openidea 布局），±统计移除 |
| D6 | preview 标签机制（双击打开的 diff 标签被下一个顶替）forge 没有 | 实现（openidea 交互的重要部分） |
| D7 | 右键菜单 forge 多出的项（三向比对、补丁到剪贴板、忽略文件等） | 保留但排到 openidea 项之后，分隔线隔开 |
| D8 | Shelf/Stash 标签页 | 本期暂缓，单独立项 |
| D9 | diff 工具栏移除文件箭头后，纯鼠标用户换文件只能关了再点 | 接受（openidea 就是这样，F7 链+气泡兜底）；不放心可保留箭头 |
| D10 | forge diff 右侧概览条 openidea 没有 | 移除 |
| D11 | 分支 widget：openidea 在窗口标题栏，forge 在主工具栏 | 不动 forge（壳层范围外） |

---

## 5. 建议实施批次

1. **批次 1（纯视觉，不动逻辑）**：状态色/`--vcs-*` token、树行像素（缩进 20/图标 16/chevron 列/圆角/hover 选中色）、组标题、空态、横幅、徽章、滚动条、diff 配色与字体 22px 行高、折叠条、版本行。
2. **批次 2（面板结构）**：三组分组模型 + 复选框（CheckMark 组件）+ partial 徽标 + 提交逻辑改造 + 提交区重做（平铺消息区/参考线/28px 按钮/检查面板）+ 工具栏重排。
3. **批次 3（diff 结构）**：工具栏重排 + 选项器 + Revert 列/hover Revert + Stage hunk + F7/F4 键 + 链气泡。
4. **批次 4（交互）**：单击选中/多选/双击 preview 标签/speed search/定位已打开文件。
5. **批次 5（changelist）**：管理对话框、持久化、移动 F6。
6. 暂缓：Shelf/Stash。

## 6. 验证方案

- 双应用打开同一仓库同一状态，明/暗主题各截一轮：侧栏面板全貌、树展开/折叠、hover、提交区、diff 双栏/统一/折叠条/hover Revert——逐条对照本文档精确值。
- 行为清单：单击选中、双击 preview、Space 勾选、Ctrl+A、F7 链气泡、F4、Ctrl+Enter / Ctrl+Alt+Enter。
- forge 现有测试全绿（注意 FORGE_TEST_MANIFEST 与单实例测试干扰的已知坑）。
