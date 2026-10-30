# Forge 设置系统架构与生效清单 (树形分层模式)

## 1. 架构概述

Forge 设置系统完整复刻并采用了 IntelliJ IDEA 的商业级设置架构，替代了原有的单层扁平选项列表。系统具备以下核心能力：
- **两级/三级树形层级导航**：覆盖 8 大标准分类，结构清晰、层级分明；
- **打字即搜 (Speed Search)**：支持中英文名称、关键词与拼音首字母即时过滤搜索，自动展开命中的父级分类；
- **面包屑路径指引**：顶部动态计算当前页面层级路径；
- **旧版路由平滑兼容**：通过 `resolvePageId` / `toLegacyModule` 兼容已有 13 个 `SettingsModule`，全局状态栏/快捷键直达无阻碍；
- **AI 模块深度归拢**：原先散落的 7 个 AI 子设置面板，完整收拢进“工具 › AI 助理”子分类树中。

---

## 2. 菜单项与生效状态对照表

> **生效标记说明**：
> - ✅ **真实生效**：已与 Tauri 后端配置 store、系统环境变量或 LSP/终端真实运行时完全打通并实时持久化保存。
> - ⚠️ **预留呈现（待后端接入）**：依据需求已完整抄录呈现菜单界面与交互框架，供后期按需剔除或实现底层支持。

| 一级分类 | 二级分类 / 子菜单 | PageId | 生效状态 | 说明与数据持久化通道 |
| :--- | :--- | :--- | :---: | :--- |
| **外观与行为** | 外观 (Theme) | `appearance.theme` | ✅ **真实生效** | 切换 3 套精选主题 (Dark / Light / High Contrast) 与系统跟随、Accent 强调色及界面语言，实时存盘生效 |
| | 系统设置 (System) | `appearance.system` | ✅ **真实生效** | 多工作区模式 (`multi`/`single`)、关闭行为 (`quit`/`tray`)、HTTP 响应布局，实时持久化 |
| | 通知 (Notifications) | `appearance.notifications` | ✅ **真实生效** | 通知弹窗显示位置（左上/右上/左下/右下），实时生效 |
| **按键映射** | 快捷键列表 (Keymap) | `keymap` | ✅ **真实生效** | 全局快捷键查看、冲突检测与快捷键偏好方案 |
| **编辑器** | 常规 (General) | `editor.general` | ✅ **真实生效** | 代码保存策略（手动/失焦）、退出前保存、光标闪烁及闪烁周期 (ms) |
| | 字体 (Font) | `editor.font` | ✅ **真实生效** | 终端与代码字体族 (Font Family)、字号大小 (Font Size) |
| | 配色方案 (Color Scheme) | `editor.colorScheme` | ✅ **真实生效** | 代码语法高亮遵循外观配色配方 |
| | 代码样式 (Code Style) | `editor.codeStyle` | ✅ **真实生效** | 制表宽度 (`tabSize`: 2/4/8) 与快捷键方案 (`default`/`idea`/`eclipse`) |
| | 文件类型 (File Types) | `editor.fileTypes` | ✅ **真实生效** | 文件树是否显示忽略文件 (`showIgnored`)、是否显示隐藏文件 (`showHidden`) |
| | 缩略图 (Minimap) | `editor.minimap` | ✅ **真实生效** | 代码编辑器右侧代码缩略图显示/隐藏开关 |
| **版本控制** | 常规 (General) | `vcs.general` | ✅ **真实生效** | 自动探测工作区 Git 仓库根目录与变更状态 |
| | Git (Git Executable) | `vcs.git` | ⚠️ **预留呈现** | 默认继承系统 `PATH` 中的 git，自定义 git 二进制文件绝对路径待后端扩充参数接收 |
| | 确认弹窗 (Confirmation) | `vcs.confirmation` | ✅ **真实生效** | 文件回滚、硬重置等危险操作二次确认机制 |
| **项目结构** | SDK 与工具链 | `project.sdk` | ✅ **真实生效** | 自动感知当前工程路径与关联的 Cargo/Node/Maven 开发工具链 |
| | 内容根 (Roots) | `project.roots` | ✅ **真实生效** | 多工作区挂载根目录与活动工程管理 |
| **构建、执行、部署** | 构建工具 (Tools) | `build.tools` | ⚠️ **预留呈现** | 当前脚本由 `RunPane` / `Cargo` 托管，集中式构建器参数配置待后端统一存储 |
| | 运行配置 (Run Configurations) | `build.runConfigs` | ✅ **真实生效** | 顶部“运行/调试配置”独立浮层管理各个 Run Config |
| | 部署 (Deployment) | `build.deployment` | ⚠️ **预留呈现** | 远端 SSH / SFTP 路径同步映射规划中，界面已预留 |
| **语言与框架** | 语言服务器 (LSP) | `languages.lsp` | ✅ **真实生效** | 语言服务卡片式管理、自动探针检测、命令行安装、进程手动唤醒重启、实时标准错误日志 |
| | 架构与语法 (Schemas) | `languages.schemas` | ⚠️ **预留呈现** | 针对 JSON/YAML/Toml 模式语法的自定义 Schema 映射配置 |
| **工具** | 终端 (Terminal) | `tools.terminal` | ✅ **真实生效** | Shell 探针选取、终端字体/字号、回滚行数、光标形状、页签布局、响铃提示、配置档 Profiles |
| | 差异比较 (Diff & Merge) | `tools.diff` | ✅ **真实生效** | 高性能双栏/三方冲突合并、行内内联高亮差异 |
| | **AI 助理：命令行助手** | `tools.ai.cli` | ✅ **真实生效** | AI 助手总开关、CLI 进程路径、权限与系统提示词 |
| | **AI 助理：模型提供商** | `tools.ai.providers` | ✅ **真实生效** | 模型服务商增删改查、API Key 凭据、联通性连通测试 |
| | **AI 助理：智能提交** | `tools.ai.commit` | ✅ **真实生效** | Git 变更智能生成 Commit Message、提示词模板定制 |
| | **AI 助理：技能与提示词** | `tools.ai.skills` | ✅ **真实生效** | 自定义 Skill 技能库创建、编辑与参数模板管理 |
| | **AI 助理：MCP 协议** | `tools.ai.mcp` | ✅ **真实生效** | MCP Model Context Protocol 服务端连接、工具挂载与资源读取 |
| | **AI 助理：自动化钩子** | `tools.ai.hooks` | ✅ **真实生效** | 生命周期与工具调用前后自动化 Hook 脚本 |
| | **AI 助理：已归档会话** | `tools.ai.archived` | ✅ **真实生效** | 历史归档会话查阅、搜索与恢复 |
| | 关于与更新 (About) | `tools.about` | ✅ **真实生效** | 应用版本号获取、自动下载、询问安装、GitHub 代理镜像前缀配置、手动检查更新 |

---

## 3. 后续裁剪与扩充指引

如果需要剔除某项暂未实现后端的菜单：
1. 打开 `src/features/settings/model/settingsModel.ts`；
2. 在 `SETTINGS_TREE` 中直接删除对应节点（例如 `build.deployment` 或 `languages.schemas`）；
3. 导航树与打字搜索将自动更新，无须改动任何其他代码。
