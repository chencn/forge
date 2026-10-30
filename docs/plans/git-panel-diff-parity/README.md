# 侧栏 Git 面板与 Git Diff 像素级对齐

**状态**：已终结（diff 部分保留；侧栏部分于 2026-10-30 按用户决定整体回退，见「实施记录」末尾）
**涉及模块**：`git-commit`（侧栏面板）、`code-editor`（diff 渲染与配色）、`themes`（状态色 token）；hunk 级暂存要给后端 git 封装补一条按块 add 的命令
**阻塞点**：侧栏不再对齐；diff 的 Shelf/Stash 页待单独立项

## 背景

把侧栏 Git 面板（提交工具窗）和 git 文件比较（diff 视图）对齐到 IntelliJ IDEA 的像素规格，明暗两套主题都要对齐。规格取值来自一份按 IntelliJ IDEA 复刻的参考工程（React + CSS Modules + CodeMirror，「岛式」圆角设计令牌，默认亮色主题；该工程只作对照用，本仓库的文档与代码一律不写它的名字，对标对象统一写 IntelliJ IDEA）。本文所有颜色、尺寸、文案即验收标准；「出处」一节列参考工程与本仓库的源码位置。

**例外项（forge 必须保留，不照抄）**：

| 例外项 | IntelliJ IDEA 的情况 | forge 现状 | 处理 |
|---|---|---|---|
| 树状显示 | 树/平铺可选，默认**平铺** | 树状默认开 | **保持树状默认开**，树的其余视觉照抄 |
| 目录状态圆点 | 没有 | 目录行尾 6px 圆点随最高优先级子项变色 | **保留**，**颜色沿用 forge 现有 mark 配色，不改** |
| 行尾状态字母 | 没有字母（内部定义了字母表但从未渲染，只靠文件名颜色） | 行尾单字母 M/U/A/D/R/! | **保留**，**颜色沿用 forge 现有 mark 配色（M 琥珀/D 红/A·U 绿/R 蓝），不改**；文件名与字母同色，同样不改 |
| AI 提交按钮 | 没有 | 提交按钮旁的 AI 生成按钮 + 配置齿轮 | **保留**，收进按钮行（齿轮左侧，28px 描边钮，Sparkles 图标 + "AI"，生成中转圈），AI 配置齿轮照抄 IntelliJ IDEA 齿轮的位置与尺寸 |
| 收起提交区 | 没有（提交区是固定上下分割，只有可拖分隔条） | 提交区头部有折叠箭头，可整体收起 | **保留折叠功能**；IntelliJ IDEA 的可拖分隔条照抄（上下最小 120px） |

## 已做（现状确认）

- diff 引擎两边同款（`@codemirror/merge`），forge 的 `src/lib/cm/diffView.ts` 已封装双栏/单栏重建、光标保留。
- forge 已有的底子：树状目录聚合与中间目录压缩、目录圆点、行尾字母、amend 勾选与消息历史、Ctrl+Enter 提交、「走到头换文件」的链式逻辑、行号旁 4px 彩条槽、右侧概览条、可拖提交区分隔条。
- forge 的暗色主题里已有一组文件状态色 token，但取值是 IntelliJ IDEA 的高对比档，需要换成 IntelliJ IDEA 的普通暗色档（见 A3）。
- 状态刷新链路（watcher 防抖 + 聚焦刷新 + 30s 兜底）与本方案无关，不动。

## 方案

### A. 侧栏 Git 面板

#### A1 分组模型（结构性最大差异）

- IntelliJ IDEA：固定三层组，顺序 **Merge Conflicts → Changes → Unversioned Files**；有 changelist 时 Changes 拆成每个变更列表一组，≥2 仓库时组内再按仓库分层；**ignored 完全不显示**；**Unversioned Files 默认折叠**且复选框默认不勾；重命名文件右侧 detail 显示 `from 旧名`。
- forge 现状：按 git index 拆成 已暂存/未暂存 两组，另有未合并、未进行版本控制、已忽略、修正节。
- **改法**：换成 IntelliJ IDEA 的三组模型，每行加**复选框**（勾选 = 纳入本次提交），目录行复选框按子项聚合三态；暂存/取消暂存退到右键菜单（IntelliJ IDEA 同款）。提交逻辑从「提交已暂存」改为「提交勾选项」：提交前把勾选文件入索引、把未勾选但已暂存的还原，再走一次普通提交（具体口径实施时定）。部分暂存的文件显示 `partial` 徽标，勾选态默认「仅暂存块」。

#### A2 变更树（像素值）

| 项 | forge 现状 | 目标值 |
|---|---|---|
| 行高 | 24px（工具窗内） | 24px（一致，不动） |
| 缩进 | 每层 13px，起点 28/34 | 每层 **20px**，行 `padding-left = 4 + depth×20`，树左右内边距 **6px** |
| chevron 列 | 无固定列 | 固定 **16px** 宽列，图标 16 |
| 文件图标 | 13px | **16px** |
| 行内 gap / 右距 | 6px | **4px** gap、padding-right **8px** |
| 行圆角 | 无 | **5px** |
| 文件名 | ellipsis | `max-width:75%` + ellipsis |
| 目录数量角标 | 有（`dir-count`） | **移除**（计数只在组行右侧）；圆点按例外项保留 |
| 组标题 | 12px/600，padding `11px 10px 4px` | 加粗 600、色 `--fg-strong`，右侧计数「N 个文件」色 `--fg-subtle`；活动 changelist 加粗、非活动 400 |
| hover | `--bg-hover` / `--sidebar-hover` | 暗 `#ffffff10` / 亮 `#00000008` |
| 选中态 | 无持久选中 | 聚焦暗 `#2a4371` / 亮 `#d0dffe`，失焦暗 `#33353b` / 亮 `#e9eaee`；键盘 lead 行 inset 1px 50% 焦点环 |
| 虚拟化 | 全量渲染 | 虚拟列表，overscan 12 |
| 打字过滤 | 无 | speed search 浮条：高 26px、popup 底色、1px popup 边、radius 4 |

#### A3 状态颜色（文件名与字母同色，目录圆点同源）

| 状态 | 暗色 | 亮色 |
|---|---|---|
| modified / renamed | `#70aeff` | `#0033b3` |
| added | `#73bd79` | `#067d17` |
| deleted | `#6f737a` | `#6c707e` |
| untracked | `#e88f89` | `#b23247` |
| ignored | `#d69a6b` | `#8c4f00` |
| conflicted | `#de6a66` | `#de1b2e` |

- forge 的 mark-* 琥珀/红/绿/蓝整套换成上表；目录聚合优先级 `conflicted > modified > renamed > added > deleted > untracked`。
- **删除线**：forge 给删除文件名划线，IntelliJ IDEA 没有 → 移除（待拍板 D4）。

#### A4 复选框（新组件）

14×14、radius 3、底色暗 `#191a1c` / 亮 `#ffffff`、inset 1px 描边暗 `#5f6269` / 亮 `#c3c5cb`；选中底 `#3871e1` 白勾 10px；**半选显示 minus 10px，同蓝底**。默认值：unversioned/conflicted 不勾；多变更列表时非活动列表的文件默认不勾。Space 切换勾选。

#### A5 树上方工具栏

- IntelliJ IDEA：条高 **32px**、gap 2、padding `0 6px`，按钮 **20×20**（radius 4），顺序：
  **刷新 → 回滚(Rollback) → 更新项目(拉取) → 视图选项(eye) ｜ 分隔线(1×16px，margin 0 4px) ｜ 定位已打开文件 → 全部展开 → 全部折叠**。
- forge 现状：刷新/暂存所有/全部取消暂存/折叠/展开/eye 六颗 24×24。
- 改动：新增回滚、更新项目、定位已打开文件；图标换 IntelliJ IDEA 的 16px SVG（暗 `#CED0D6` / 亮 `#6C707E`）；分隔线样式对齐；暂存所有/全部取消暂存两颗 → 移除（待拍板 D2）。视图选项菜单 IntelliJ IDEA 为「分组依据 + 目录勾选」，forge 的「按模块分组 / 显示忽略文件」保留在菜单后段（待拍板 D3）。
- 变基/合并进行中的横幅：min-height 28、padding `4px 10px`、底 `warning 12%` 混合色、1px 下边线、12px 字。

#### A6 提交区（整体重做，AI 与收起按例外项保留）

| 项 | forge 现状 | 目标值 |
|---|---|---|
| 消息行 | 修正 checkbox + 历史 + ±统计 + 折叠箭头 | **Amend checkbox + 历史 + 行宽计数**（mono 11px，超限转警示色）；折叠箭头按例外项保留在同一行 |
| 输入框 | 盒式：1px 边框 + 圆角、min-height 60、12.5px | **平铺无边框**：仅 `border-top: 1px`，min-height **40**，padding `6px 10px`，mono **13px/22px**，右侧**边距参考线**（渐变画的竖线，列宽可配、可关），placeholder 用 UI 字体 |
| 空消息 | 无提示 | inset 1px `--danger` 描边 + 「请指定提交消息」 |
| 检查失败 | 无 | 提示条（12px 警示色）+ 主按钮文案变 **「仍然提交」** |
| 按钮 | 提交(I) 32px + 提交并推送(P) + AI 组 + 齿轮 24 | **提交** primary：高 **28**、min-width **72**、padding 0 16、radius **4**、13px；**提交并推送…** secondary 描边钮；右端**齿轮 20×20**；行 padding `8px 6px 10px 10px`、gap 8；AI 按钮按例外项放齿轮左侧 |
| 齿轮弹层 | AI 提交配置 | IntelliJ IDEA 为 340px 宽选项弹层：Git（Author/Sign-off）/ 提交检查 / 高级检查三段，段标题带右横线；AI 配置并入此弹层或保留独立入口（实施时定） |
| 快捷键 | Ctrl+Enter 提交 | Ctrl+Enter 提交、**Ctrl+Alt+Enter 提交并推送**、Esc 失焦 |
| ±行数统计 | 有 | IntelliJ IDEA 没有 → 移除（待拍板 D5） |

#### A7 交互行为

| 行为 | forge 现状 | 目标 |
|---|---|---|
| 单击 | **直接开 diff** | **仅选中**（Ctrl/Shift 多选、Ctrl+A 全选） |
| 双击 / Enter | 按设置开 diff 或源文件 | **开 diff，以 preview 标签**（会被下一个 preview 顶替；preview 机制 forge 没有，待拍板 D6） |
| F4 | 无 | 跳到源文件 |
| Space | 无 | 切换勾选 |
| Delete | 无 | 删除选中的 changelist 组（A10 落地后） |
| 拖拽 | 无 | 文件/目录拖拽移动 changelist |
| Esc | 无 | 输入框失焦 |

#### A8 右键菜单（照抄顺序与图标）

IntelliJ IDEA 顺序：`显示差异 ｜ 跳到源码 (F4) ｜ — ｜ 解决冲突… ｜ 回滚… ｜ 加入版本控制 ｜ 暂存 ｜ 取消暂存 ｜ — ｜ 移到其他变更列表… ｜ 搁置 ｜ 创建补丁 ｜ — ｜ 显示历史记录 ｜ 本地历史 ｜ 注解 ｜ — ｜ 复制路径`。
forge 顺序不同且多出「三向比对/创建补丁到剪贴板/忽略文件/独立窗口差异」等 → 按 IntelliJ IDEA 重排，多出项排在后段用分隔线隔开（待拍板 D7）。目录行、空白行、忽略行菜单同样对齐。

#### A9 空态 / 徽章 / 滚动条 / 壳层

- 空态：「没有本地更改」**水平垂直居中**、`--fg-subtle`（forge 现为左上左对齐）；VCS 未配置用标题+正文居中的 EmptyState（正文 max-width 320）。
- 活动栏徽章：`min-width 13px、height 13px、font-size 9px/600、radius 7、底 --bg-active、字 --fg-emphasis、top -5px、left 10px`（forge 现蓝色 15px pill 在右下）。
- 滚动条：宽 **10px**、thumb 暗 `#ffffff33` / 亮 `#00000033`、border 2px 透明、radius 6。
- 分支 widget：IntelliJ IDEA 放在窗口标题栏左侧（max-width 280、高 30、radius 6）；forge 在主工具栏 → 壳层差异，默认不动（待拍板 D11）。

#### A10 IntelliJ IDEA 有、forge 没有（功能新增，分批）

1. **changelist 体系**：默认「Changes」；新建/改名/编辑注释/设为活动/删除/移动文件（F6）；JSON 持久化（落地时用 forge 自己的文件名与目录）；组右键整组操作；活动列表加粗。
2. **部分暂存与 partial 徽标**（随复选框模型落地）。
3. **定位已打开文件**按钮。
4. Shelf / Stash 标签页 → 体量大，暂缓（待拍板 D8）。

### B. Git 文件比较

#### B1 工具栏（重排 + 增补）

IntelliJ IDEA 顺序（条高 40、gap 2、padding `0 6px`，按钮 20×20 图标 14）：

```
上一处(⇧F7) 下一处(F7) | 跳到源码(铅笔) ‖ 双栏toggle 统一toggle ‖ 忽略空白▾ 高亮▾ 折叠未更改(⇧) 同步滚动(🔒仅双栏) ‖ 还原此块 暂存此块 ‖ 刷新 …… 右端「N of M differences」
```

- forge 现状：上一处/下一处 | 跳源码(外链图标) | 上一篇/下一篇 + 「{i}/{total} 个文件」 | 关闭X | 右端计数 + 分段式排法控件。
- 改动：
  - **新增**：忽略空白下拉（不忽略/去尾空白/忽略空白/忽略空白与空行）、高亮下拉（词/行/不高亮）、折叠未更改 toggle、同步滚动 toggle（仅双栏）、还原此块、暂存此块、刷新。
  - **移除/替换**：上一篇/下一篇文件箭头与 {i}/{total} 计数、关闭X、分段式排法控件 → 换成两颗 aria-pressed toggle；文件间移动改走 F7 链（B6）（待拍板 D9）。
  - 计数文案：`N of M differences` / `1 difference` / 内容相同 `Contents are identical` / `No differences`，右对齐 12px `--fg-subtle`。
  - 跳源码图标换**铅笔**，仅当工作区存在该文件时显示。
  - 选项持久化到 localStorage（用 forge 自己的键名）。

#### B2 两侧版本行

- IntelliJ IDEA：无锁图标；两侧各 `flex:1; padding:0 12px; mono 12px; --fg-secondary`，行高 24，中缝 1px 边线；右侧 badge「working copy / editable」（底 `--accent-soft`、字 `--accent`、11px、padding 0 5、radius 4）；单栏模式单条 `左 → 右`；侧名规范：**HEAD / Staged (index) / 短哈希(8位) / Your version / (does not exist) / (deleted)**。
- forge 现状：Lock 图标 + HEAD/索引/工作区 + 路径，11.5px。
- 改动：去掉锁图标、文案改「Staged (index) / Your version」、加 badge、样式对齐；标签标题格式 `文件名 (HEAD ↔ Your version)`。

#### B3 配色（核心像素）

| 元素 | 目标值 |
|---|---|
| 左（旧）改动行背景 | `color-mix(--gutter-deleted 12%)` |
| 右（新）改动行背景 | `color-mix(--gutter-added 12%)` |
| 词级高亮 | 左 `--danger` 26% / 右 `--success` 26% |
| 整行插入/删除（无对侧） | danger 26% / success 26% |
| gutter 彩条（3px） | 左 = `--gutter-deleted`（暗 `#868a91` / 亮 `#767a8a`），右 = `--gutter-modified`（暗 `#375fad` / 亮 `#88adf7`） |
| 行号栏 | 底 `--bg-app`、字 `--fg-gutter`（暗 `#4b5059` / 亮 `#aeb3c2`）、padding `0 8px 0 12px`、min-width 32 |
| 当前行 / 选区 / 搜索匹配 | 暗 `#1f2024` / 亮 `#f5f8fe`；强选区 token；accent 22% |
| 关闭高亮 | 所有改动背景强制 none（新增开关） |

- 需在 forge 新增 `--gutter-modified/added/deleted`、`--danger`（暗 `#f57e84` / 亮 `#c54e58`）、`--success`（暗 `#6db083` / 亮 `#338555`）等 token，整体替换 diff 段现有红绿配色。
- forge 的 4px 彩条槽保留、颜色换上表；**右侧概览条 IntelliJ IDEA 的 diff 没有** → 移除（待拍板 D10）。

#### B4 折叠未更改区

margin 3、**minSize 6**（forge 现为 4）；折叠条 `padding 2px 10px`、底 `--bg-elev`、字 `--fg-subtle` 12px UI 字体。

#### B5 每块（chunk）操作——forge 全缺，新增

1. **中缝 revert 竖列**：宽 **22px**、底 `--bg-elev`、左右各 1px 边线；每块上下排 `››` / `‹‹` 箭头（chevron 12px、16px 高、无边框），点击把对侧内容拷过来（可撤销编辑）。
2. **hover Revert**：悬停块首行时行尾浮出「Revert」按钮（右 8px、高 16、padding 0 6、1px 强边线、radius 4、底 `--bg-elev`、11px）。
3. **单栏 Revert**：mergeControls 只出「Revert」文本按钮。
4. **暂存此块**：HEAD↔工作区 diff 右栏每块前置 12×12 checkbox（「纳入提交」），配合工具栏「暂存此块」；后端需新增按 hunk add 的命令封装。

#### B6 键盘与跨文件链

- 键位：**F7 / ⇧F7** 下一处/上一处、**F4** 跳源码。
- 跨文件链：本篇走到头再按 F7 → 底部居中气泡「再按一次转到下一个文件」（2.5 秒内再按 → 切到链上相邻文件并落到首/末差异；气泡 bottom 40px、tooltip 同款边框底色、12px）。forge 已有走到头换文件逻辑，缺「再按一次」确认气泡。
- 计数随光标所在块实时更新；跳转滚动居中、无平滑动画（一致）。

#### B7 字体与杂项

- diff 编辑器字体 mono **13px / 行高 22px**（forge 现 13/20，只差行高）。
- 加载态 14px Spinner；错误态文本。
- tooltip 统一走全局系统：600ms 延迟、快捷键以 62% 透明附显（forge 自绘 320ms）。

## 未做与验收

### 待拍板决策点

| # | 问题 | 建议 |
|---|---|---|
| D1 | 分组模型换三组+复选框后，「已暂存/未暂存」两组消失，暂存操作走右键菜单 | 换（照抄的应有之义），提交流程同步改 |
| D2 | 工具栏「暂存所有/全部取消暂存」两颗按钮 IntelliJ IDEA 没有 | 移除（右键菜单保留同功能） |
| D3 | 视图选项里 forge 的「按模块分组/显示忽略文件」 | 保留，排在「分组依据」之后 |
| D4 | 删除文件名的划线 IntelliJ IDEA 没有 | 移除 |
| D5 | 提交区 ±行数统计 IntelliJ IDEA 没有 | 移除（AI 按钮与收起箭头已定为例外项保留） |
| D6 | preview 标签机制 forge 没有 | 实现（双击交互的重要部分） |
| D7 | 右键菜单 forge 多出的项 | 保留，排后段分隔线隔开 |
| D8 | Shelf/Stash 标签页 | 本期暂缓，单独立项 |
| D9 | diff 工具栏移除文件箭头后，纯鼠标换文件要关了再点 | 接受（F7 链 + 气泡兜底） |
| D10 | forge diff 右侧概览条 IntelliJ IDEA 没有 | 移除 |
| D11 | 分支 widget 位置（标题栏 vs 主工具栏） | 不动 forge，壳层范围外 |

### 实施批次

1. **批次 1（纯视觉，不动逻辑）**：状态色 token、树行像素、组标题、空态、横幅、徽章、滚动条；diff 配色、行高 22、折叠条、版本行。
2. **批次 2（面板结构）**：三组模型 + 复选框 + partial 徽标 + 提交逻辑改造 + 提交区重做（AI 按钮与收起箭头按例外项保留）+ 工具栏重排。
3. **批次 3（diff 结构）**：工具栏重排 + 选项器 + revert 列 / hover Revert + 暂存此块（含后端命令）+ F7/F4 + 链气泡。
4. **批次 4（交互）**：单击选中/多选/双击 preview 标签/speed search/定位已打开文件。
5. **批次 5（changelist）**：管理对话框、持久化、F6 移动。
6. 暂缓：Shelf/Stash。

### 验收

- 双应用打开同一仓库同一状态，明/暗各截一轮：侧栏全貌、树展开/折叠、hover、提交区、diff 双栏/单栏/折叠条/hover Revert，逐条对照本文数值。
- 行为清单：单击选中、双击 preview、Space 勾选、Ctrl+A、F7 链气泡、F4、Ctrl+Enter / Ctrl+Alt+Enter。
- 现有测试全绿（注意 FORGE_TEST_MANIFEST 与单实例测试被运行中实例干扰的已知坑）。

## 实施记录（2026-10-30）

批次 1-5 全部落地：三组模型 + 复选框（含 partial 徽标）、`--only` 按勾选提交、提交区重做（平铺消息区 + 72ch 参考线 + 28px 按钮）、工具栏重排（回滚/更新项目/定位）、单击选中多选 + 双击/Enter 开 preview 标签、speed search、changelist（默认组/改名/移动/持久化/活动加粗）、diff 配色换血 + 行高 22 + 折叠条、diff 工具栏重排 + 高亮选择器 + F7/F4 + 链气泡 + 按块暂存/还原（`git apply --cached` / `-R`，新命令 `git_apply_patch`）。例外项全按定稿执行：树状默认开、目录圆点保留、M/U 字母保留且**颜色不改**（沿用 forge mark 配色）、AI 提交按钮收进按钮行、收起提交区保留（收起后单行严禁换行，commit-bar nowrap）。

**遗留（2026-10-30 二轮补课后仅剩）**：

- Shelf/Stash 标签页（D8）——待单独立项。
- 「无暂存时提交全部」设置已从齿轮菜单移除（复选框模型取代），settings model 字段保留兼容旧档。

**二轮补课（2026-10-30，用户拍板「抓到的问题改掉」后补齐）**：

- 「忽略空白」下拉四档做成了真的：`lineDiff` 比较前按口径归一化行（首尾 / 全部空白 / 连空行一起扔，扔行走「保留行号」映射折回真实坐标），展示的仍是真实文本；换档重建视图。
- 「同步滚动」开关：双栏默认同步；关掉后两栏各自成滚动列（样式档 `forge-diff-unsynced`），单栏不摆这颗。
- 每块 ›/‹ 行内控件：`revertControls` 这版拿不到块上下文，改用 CM 装饰件自己画——读侧每块首行行尾浮一对箭头（‹ = 把块拷去左侧 = 暂存，› = 拷去右侧 = 还原），块坐标随装饰携带，与工具栏两颗同源。
- 按块还原前先存盘：工作区文件有未保存的编辑器缓冲时先 saveDoc 再 `git apply -R`，补丁不再打在旧文件上。

**验证**：tsc 0 错、cargo check 过、前端 129 文件 1355 用例全绿（新增 changelists 模型、按块补丁生成器、lineDiff 空白口径三组测试）；review 两轮共修掉五个真 bug——补丁行号定位把行数当字符数比、统一差异空区间头未按规范指前一行、speed search 过滤后键盘序残留幽灵行、忽略空行档忘了真的扔行、块补丁生成器搬库后测试引用未跟上。
**回退决定（2026-10-30，用户拍板）**：侧栏新面板（三组模型/复选框/changelist/新提交区/新工具栏/speed search）实测后用户认为不如原版，整体回退——GitPanel.tsx 恢复 git HEAD 原版，styles.css 的面板段、tokens、App 接线（panelOpenCommitFile、commitAllWhenNothingStaged 设置项、按钮文案 (I)/(P)）全部还原；**diff 侧的改造全部保留**（配色/工具栏/空白口径/同步滚动/块控件/preview 标签/F7 链/后端 git_apply_patch）。给侧栏留档的结论：用户在意的是稳定与熟悉感，勾选模型那类结构性重构不要再主动提。
## 出处

**规格出处**（按 IntelliJ IDEA 复刻的参考工程，不具名，相对其仓库根；行号为写稿时的位置，实施前重新核对）：

- `src/features/vcs/CommitView.tsx` — 面板主体、工具栏、提交区、右键菜单（约 1-900）；`CommitView.module.css` — 同区全部样式（约 1-240）
- `src/features/vcs/changes.ts` — 三组模型与树构建、复选框聚合（8-12、42-48、60-65、87、121-130、143、177-205、221-269、354-373）
- `src/features/vcs/model.ts` — 状态色与目录聚合优先级（10-21、27-45、48、59-79、180-182）
- `src/features/vcs/changelists.ts` / `changelistsUi.tsx` — changelist 模型、持久化与管理对话框
- `src/features/vcs/commitStore.ts` / `commitChecks.tsx` / `CommitOptions.tsx` — amend、消息历史、提交选项弹层
- `src/ui/Tree.tsx` / `Tree.module.css` — 虚拟化树、行/缩进/chevron/hover 选中（43-58、68-70、74-82、101-119）
- `src/features/vcs/DiffEditor.tsx` / `DiffEditor.module.css` / `cm.ts` / `diffControls.ts` / `diffOptions.ts` / `diffInput.ts` — diff 主体、配色、工具栏、块操作、选项、标题
- `src/features/vcs/gutter.ts` / `hunkInclusion.ts` / `HunkPopup.tsx` — 彩条槽与按块纳入
- `src/ui/Button.module.css` / `Checkbox.module.css` / `Tabs.module.css` / `Popup.module.css` / `List.module.css` / `Splitter.module.css` / `Tooltip.tsx` — 基础件
- `src/styles/tokens.css` / `src/styles/global.css` — 设计令牌与滚动条（暗 19-75、亮 395-450、滚动条 158-176）
- `src/workbench/toolwindows/ToolWindows.tsx` / `.module.css` — 工具窗壳层与徽章（237-283、318-334、348-413）
- `src/platform/keymaps/intellij-windows.ts` — F7/F4 键位（257-280）

**forge 现状**：

- `src/components/GitPanel.tsx` — 侧栏面板（分组 1192-1303、工具栏 1106-1164、提交区 1306-1596、右键 421-556）
- `src/components/DiffPane.tsx` / `src/lib/cm/diffView.ts` / `lineDiff.ts` / `theme.ts` / `overview.ts` — diff 容器与引擎
- `src/lib/git.ts` — 状态标记与聚合（448-576）；`src/hooks/useGitState.ts` — 刷新链路
- `src/styles.css` — 面板段 6097-6516、diff 段 5837-6096、mark 色 2826-2852、壳层 2449-2596
- `src/themes/tokens.css` / `ideaTokens.css` — 令牌与已有 `--vcs-*`
- `src/App.tsx` — 面板宿主与 diff 打开链路（2705-2810）、刷新触发（1132-1340）
