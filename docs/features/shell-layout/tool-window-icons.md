# 活动栏入口图标的出处

外壳各处的字形与标记资产。主工具栏 / 活动栏 / 页签栏见 [README.md](README.md)。

## 照 IDEA 画的三个字形

`src/components/ToolWindowIcons.tsx` 里导出 `ProjectIcon`、`CommitIcon`、`VcsIcon`，路径数据取自这些文件
（Apache 2.0，Copyright 2000-2022 JetBrains s.r.o. and contributors）：

- 资源管理器 → `ProjectIcon` ← `platform/icons/src/expui/toolwindows/project@20x20.svg`
- 提交 → `CommitIcon` ← `platform/icons/src/expui/toolwindows/commit@20x20.svg`
- Git 日志 → `VcsIcon` ← `platform/icons/src/expui/toolwindows/vcs@20x20.svg`

相对原资产只改了两处：写死的 `#6C707E` 换成 `currentColor`；`viewBox` 保持 20，边长由调用方的 `size` 定，
缺省 18（活动栏那一档）。路径数值一字未动。`ProjectIcon` 是描边（`strokeWidth` 1.5），`CommitIcon` 与
`VcsIcon` 是填充。描边与填充都吃 `currentColor`，才会跟 lucide 图标一样随主题与选中态变色。

`VcsIcon` 用的是 Git 工具窗口的分支图。IDEA 的 expui 资产里没有单独的 "log" 图标，`general/history.svg`
是一枚时钟，语义是「显示历史」这个动作，不是这个窗口。

## 活动栏其余的图标

活动栏上端两颗：资源管理器（`ProjectIcon` 18）、提交（`CommitIcon` 18）。下端四颗：终端
（`SquareTerminal` 18）、运行（`Play` 17）、Git 日志（`VcsIcon` 18）、通知（lucide `Bell` 18）。终端和运行仍是
lucide 字形，没跟着换。查找不在活动栏摆入口，IDEA 没给 Find 工具窗口留一颗，它是点开正文命中时自己开出来的；
`SearchIcon` 只出现在两处：主工具栏「随处搜索」那颗（17）和页签栏里查找那块面板的标签（13）。它不在 JetBrains
那三份资产里，镜片接手柄是自绘的，`viewBox` 同为 20、填 `currentColor`，随主题与选中态变色。
设置入口不在活动栏，在主工具栏右段，是 lucide 的 `Settings` 17。

终端 / 运行 / 日志 / 查找 / 通知这五块的字形也出现在编辑区页签栏的面板标签上，那一档是 13px 并挂 `entry-icon`
拿灰字色（`PANE_ICON` 与活动栏下端读的是同一组），所以底部和页签栏两处认得出是同一块工具窗口。

## 应用标记

矢量母版是 `src-tauri/icons/icon.svg`，蓝色渐变圆角方块加白色大写 F。标题栏图标直接引这个文件，18×18，
缩到这么小也不糊，因为是矢量。窗口、任务栏、exe 那几枚由 `scripts/make-icons.mjs` 栅格化。

母版和脚本共用同一套骨架数值：

- 方块 `half=0.46`、`radius=0.2`。
- 渐变 `rgb(37,99,235) → rgb(49,123,215)`，叠一枚左上高光。高光在母版里是 `radialGradient`，`cx 0.3`、
  `cy 0.24`，白色 0.11 不透明度。
- F 三笔同宽 `weight=0.13`。竖笔 `x 0.25..0.38`，贯通 `y 0.15..0.85`；上横到 `x 0.75`；中横到 `x 0.67`，
  落在 `y 0.42..0.55`。

母版是 24 的画框，即这套 0..1 数乘 24；脚本里用的是 0..1 原值。改字形要改母版、改脚本里那组常数
（`F` 对象），再跑一次 `node scripts/make-icons.mjs`。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src/components/ToolWindowIcons.tsx` | `ProjectIcon` 描边 `:13-30`；`CommitIcon` 填充 `:33-51`；`VcsIcon` 填充 `:54-72`；`size` 缺省 18 与 `currentColor` 说明 `:1-10` |
| `src/App.tsx` | 活动栏五个入口 `:1808-1859`；`PANE_ICON` 面板标签 13px `:142-146` |
| `src-tauri/icons/icon.svg` | 母版全 18 行；`radialGradient` 高光 `:8-11`；F 三笔 `:15-17` |
| `scripts/make-icons.mjs` | `F` 常数 `:68-76`；`half / radius` `:84-85`；渐变与高光 `:100-113` |
