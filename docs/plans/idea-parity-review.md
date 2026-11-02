# forge ↔ IDEA 三模块对齐审查报告

> 审查范围：通知系统、文件管理器（项目树）、文本编辑器，前端到后台全链路。
> 共 **106 项差异**。原则：IDEA 为准，像素级/逻辑级对齐；用户已拍板项不计入。
> 本报告只列差异与修法，**未改任何代码**，等逐项拍板。
> 证据行号均为实读核实，标「待验证」的需实机确认。

## 已拍板例外（不算差异）

1. 通知 header 不画分隔线（横线/红线）
2. 通知 header 整排图标 hover 才显现（IDEA 原版为常显 trash）
3. 资源管理器「选择已打开的文件」仅按钮触发定位（IDEA 的动作会拉起面板——forge 已拍板不拉起、无目标置灰）
4. 右键自绘「复制」菜单（已抄 IDEA browserGuards，判定改用 computed user-select，覆盖面更广，视为已接受）
5. 切换标签不自动定位（autoscrollFromSource=false，IDEA 默认同为 false，一致）

---

## A. P0 功能性 bug（不涉及方向选择，建议必修）

| ID | 模块 | 问题 | 修法 | 代价 |
|----|------|------|------|------|
| T-15 | 树 | picked 原始路径直查小写 byKey → Shift+F6 静默失效、Alt+Insert/右键 New/粘贴落到工程根而非所选目录 | 4 处 `byKey.get(p)` 补 normalizeNodeKey | S |
| T-14 | 树 | 键盘 Delete / F6 整组失效（App 三处 ProjectTree 未传 onMove/onDelete） | App 接线 onDelete/onMove | S |
| T-05 | 后端 | copy_entry 无「复制进自身」防护 → 粘贴目录进其子目录无限递归直至崩溃 | canonicalize 检查 + 权限位/symlink 语义（对齐 ide-vfs ops.rs） | M |
| E-16 | 编辑器 | IDEA 键位方案在 Windows 下没有任何重做键（Ctrl+Y 被 deleteLine 占、Ctrl+Shift+Z 未绑） | 补 `win: Ctrl-Shift-z → redo`（对齐 IDEA baseKeymap.ts:34） | S |
| E-31 | 编辑器 | 14 门自补语法 + 多数 language-data 语言 Ctrl+/ 失效（commentTokens 未注入） | extraGrammars 补 languageData commentTokens | S |
| E-38 | 编辑器 | 正文缺 `spellcheck:false/autocorrect:off`，系统拼写检查给代码画红点 | 补 contentAttributes | S |
| T-13 | 树 | previewTab 默认 true 且无 preview 语义 → 单击即开正式标签（IDEA/IDEA 默认单击仅选中） | 默认值改 false（交互默认对齐）；preview 通道另立拍板项 | S |

## B. 通知系统（29 项）

### 逻辑（IDEA 为准）
- **N-02+N-03（高）**：通知组配置（display/log）只在 App.tsx 两条路径生效，直连 notify 的调用全部绕过 → 设置页大半开关是摆设。修：组配置读取下沉到 `lib/notifications.ts` notify()。
- **N-01（高）**：超时 6s/9s vs IDEA 10s/10s；sticky 永不淡出 vs 5 分钟淡出。修：`lib/notifications.ts:72`。
- **N-08（中高）**：缺 suppressGroup/canSuppress/「不再显示」整组关闭入口。
- **N-07（中）**：缺 key 去重与 expireNotification（同类错误连发会堆叠）。
- **N-10（中）**：气泡第 4 条起被丢弃 vs IDEA 排队补位。修：store 全量、渲染处 slice。
- **N-09（低）**：markAllAsRead 后未 logged 气泡应一并收走（`lib/notifications.ts:349`）。

### 像素/UI
- **N-13/N-14/N-15（低）**：Feedback.module.css 多处 token 换写死（meta 11px vs --fs-small、badge/link/empty 字号字重、tone 类缺 --icon-color）。
- **N-16（低）**：Toast 缺 error→alert 语义/data-level/关闭钮 iconSize 12、title 应走 i18n。
- **N-18（中）**：`notificationPosition` 设置只对依赖同步气泡生效，工作台 Balloons 恒右下，且两者同位叠放冲突。
- **N-19（低）**：rail 未读徽标未用 `useUnreadNotifications()`（口径：不看 logged）。

### 结构/i18n
- **N-26（中高）**：通知 UI 写死中文（「暂无通知」「清空全部通知」「关闭」），切英文仍中文；现成键 `notifications.empty/clearAll` 未用。
- **N-27（中）**：设置页缺两个全局开关（气泡总开关/声音）、未接入设置搜索、默认值落库策略不同。
- **N-28（清理）**：`components/NotificationCenter.tsx` ~450 行死代码 + 闲置 CSS。

## C. 文件管理器（35 项）

### 后端 fs（IDEA 的 VFS 语义缺失）
- **T-01（P1）**：后端 list_directory 不算 gitignore/excluded/hidden 标记（IDEA 在后端算好回填），forge 默认视图 ignored 条目无任何标记。
- **T-03（P1）**：create_folder 不支持嵌套 `a/b/c`、已存在错误码错 → 行内嵌套新建必败。
- **T-04（P2）**：create_file 不 ensure parent、不按 EditorConfig 建 BOM、删除无 Local History 快照。
- **T-02（P2）**：FsEntry 缺 targetKind（悬空链接区分）、symlink→目录语义。
- **T-10（低）**：loadDir 失败一律缓存空列表 vs IDEA 区分 notFound 与其他错误。

### 交互/键位
- **T-17（P1，已完成）**：粘贴冲突改为 Copy 对话框并生成唯一名称；App、项目树和 Windows `CF_HDROP` 文件剪贴板统一接线。
- **T-24（P1，当前契约已完成）**：本轮收口右键菜单的 Fetch、Reformat、Find Usages、Optimize Imports、Put Label，以及 rollback、Compare With、Terminal、Mark Directory 的接线。Package、Annotate、Stash 等更宽的菜单扩展不属于本轮契约，另行排期。
- **T-16（P2）**：开启「单击展开」后双击目录 toggle 两次（净效果未变）。
- **T-11（P2）**：reveal 单槽覆盖（连续两次定位丢第一次）；scratches 模式定位被误切回 project。
- **T-21（P2）**：行内新建后不 reveal、不自动打开新文件（IDEA 都做）。
- **T-22（P2）**：Expand All 只展开已加载层级（IDEA BFS 逐层加载，上限 400）。
- **T-18（P2）**：拖拽缺 Esc 取消、复制修饰键应为仅 Alt、无拖出/拖入导入。
- **T-19/T-20（P3）**：safe-delete 无 usage 搜索（对话框不可达）；删除后不选中下一行。

### 像素/UI
- **T-27（P2，方向拍板）**：git 徽章是 VS Code 式「字母+圆点」，IDEA/IDEA 是**文件名染色**。
- **T-28（P2）**：gitignored 混用了 excluded 橙图标（IDEA：ignored 暗名+普通图标、excluded 才橙图标）。
- **T-29/T-30/T-31（低）**：忽略名单缺 5 项、图标 15 vs 16、「正在加载...」硬编码、JVM 包链分隔符 `/` vs `.`。

### 结构
- **T-32（P1，已完成）**：展开状态、视图选项和模式按工程根持久化；展开集合上限 3000，根目录切换不会串状态。
- **T-33（P2）**：changedFiles 视图包含已删除文件（磁盘上不存在）。
- **T-34（P2）**：i18n：revealLabel 应按 OS（Finder/Explorer/Files）、Move 动态标签、Unmark 动态、快捷键标签硬编码不读键位。

## D. 文本编辑器（42 项）

### 像素/主题
- **E-05（S）**：搜索命中色未消费已拷贝的 IDEA token（--bg-search-match/-current），描边画在所有命中上（应只在当前项）。
- **E-02（S）**：默认行高 20px vs IDEA 22px（13px 字号下整篇密度不同）。
- **E-01（S，方向拍板）**：内容区留白 10/12 vs IDEA 4/8（forge 注释称刻意保留 Monaco 间距）。
- **E-03/E-04/E-06/E-07/E-15（S）**：匹配括号加粗、HTML 标签匹配 mark、折叠 chip/当前词/参考线 token 断链、rainbow 缺开关（IDEA 默认关）。
- **E-08（S）**：当前行高亮用内置版（非空选区也画、盖住选区色），IDEA 空选区才画。
- **E-09（M）**：概览条只画改动（IDEA 汇聚改动+搜索命中+诊断，且画光标位置线）。
- **E-10（S）**：色带无 tooltip、删除三角锚法语义。
- **E-11/E-12/E-13（M）**：软折行悬挂缩进、空白符可视化、硬换行参考线——整组缺失。
- **E-14（L）**：外观开关组（块光标/连字/方法分隔线/专注模式/滚轮缩放/scrollPastEnd）整组缺失。

### 行为/键位
- **E-17（L）**：smartKeys 整组缺（Tab 跳出括号、引号跳过、粘贴自动缩进、智能退格、camelHumps、smartHome…）。
- **E-18（L）**：行操作命令面缺（选区重复、语句移动、joinLines、toggleCase、sortLines、unwrap、completeStatement、选区栈 Ctrl+W、Alt+/ 词补全…）。
- **E-19（M）**：多光标手势（Ctrl+Alt+↑↓ 应为出现处导航、Alt+Shift+click、列选开关；forge Ctrl+click 加选漏出）。
- **E-20（M）**：注释行为（caret 停位、行注释风格可配、行注释内回车续注释）。
- **E-21（M/L）**：折叠（无后端折叠、Ctrl+- 不向上找包含光标的折叠区、无选区折叠/递归）。
- **E-22（L）**：查找缺范围/排除/注释字符串过滤/保大小写/命中进概览条（自研 FindBar vs CM 内置面板）。
- **E-23（M）**：Ctrl+G 跳行、Ctrl+Enter=Split Line、Ctrl+M=滚到中间、Ctrl+[ ]=块跳转——键位语义全不同。
- **E-24/E-25/E-26/E-27/E-28/E-29（S–M）**：overwrite/stickyScroll（IDEA 默认开）/codeLens/装订线右键菜单/装订线拖选/剪贴板历史。

### 语言
- **E-30（M）**：缺 15 门语言（zig/nix/haskell/ocaml/erlang/latex/gdscript/diff/dotenv/git*…；forge 反而多 14 门）。
- **E-32（S）**：Java 注解/CSS/YAML 的配色补丁缺失。

### 后台
- **E-33（M）**：保存卫生缺（formatOnSave/裁尾随空白/末换行）。CRLF/BOM/冲突处理两边等价（forge 不弱）。
- **E-35（M）**：诊断缺 tags 专属样式/info 点线；forge 挂了 lintGutter（IDEA 明确「无 lint gutter」）。
- **E-36（S，待验证）**：大文件 8MB 降级开关。

### 结构
- **E-39（M）**：tabSize 默认 2 vs 4；indentUnit 恒空格（无 tab 缩进文件、无 .editorconfig/缩进探测）；设置面缺 softWrap/whitespace/stickyScroll/fontFamily。

---

## 需要拍板的方向性决策（非 bug，是取舍）

1. **git 徽章**（T-27）：IDEA 式文件名染色（对齐 IDEA）还是保留 VS Code 式字母+圆点？
2. **通知持久化**（N-06）：IDEA 重启即清空。forge 的 localStorage 持久化是增量——保留（需剥离 actions/body 防僵尸按钮）还是删除对齐？
3. **previewTab**（T-13）：默认改 false 对齐 IDEA？preview 单击开预览标签的机制要不要实现（forge 目前无预览标签概念）？
4. **通知声音 + 全局气泡总开关**（N-04/N-05）：补齐还是放弃？
5. **内容区留白**（E-01）：改回 IDEA 的 4/8 还是保留 10/12（改了行高密度会变）？
6. **默认行高**（E-02）：13px 字号配 22px（IDEA）还是 20px？
7. **tabSize 默认**（E-39）：2 还是 4？要不要缩进探测 + .editorconfig？
8. **forge 独有增强去留**：勿扰模式、原生系统通知、删除进度框、Escape 取消剪切、danger 红样式——建议全部保留（IDEA 无对应物，均为增量），默认不动，除非你想删。
9. **编辑器大功能**（E-17/E-18/E-22/E-25/E-26/E-34 各 L 级）：smartKeys/行操作命令面/自研 FindBar/stickyScroll/codeLens——按批拍板做不做、先做哪批。

## 建议执行批次（拍板后按批做）

- **批次 1（P0 速修，全部 S）**：T-15、T-14、E-16、E-31、E-38、T-13 默认值。
- **批次 2（后端 fs 语义）**：T-05、T-03、T-01、T-04。
- **批次 3（通知逻辑对齐）**：N-02/03、N-01、N-08、N-07、N-10、N-09、N-26、N-28。
- **批次 4（编辑器像素）**：E-05、E-03/04/06/07/15、E-08、E-02/E-01、E-30/E-32。
- **批次 5（交互大件）**：T-17、T-24、T-32、E-19/20/21/23、E-33、E-35、E-39。
- **批次 6（L 级大功能，逐项拍板）**：E-17、E-18、E-22、E-25、E-26、E-34、E-14、E-11~13。


---

## 执行状态（2026-10-31 拍板后第一批）

用户拍板：T-27 不改，其余全改，方向决策由执行方定。
方向决策记录：通知持久化保留（已剥离 actions/body）；声音+气泡总开关补齐；previewTab 默认 false（preview 标签机制未实现，开启选项时单击仍打开）；留白 4/8、行高 22px、tabSize 维持 2（IDEA 的 4 + 缩进探测列为待续，避免改变现有全部文件的行为）；forge 独有增强全保留。

### 本批已完成（含 T-01、T-17、T-32；全量验证结果见各轮记录）

- P0：T-15、T-14、T-13、E-16、E-31、E-38
- 后端 fs：T-03（嵌套建目录+TARGET_EXISTS）、T-05（copy into-itself 防护+symlink 语义）、T-04（create_file ensure_parent；删除快照按内容去重已覆盖，跳过）
- 通知：N-01、N-02/03（组配置下沉）、N-04、N-05、N-06（剥离 actions/body）、N-07（key 去重+expireNotification）、N-08（suppressGroup+不再显示）、N-09、N-10（排队补位）、N-13、N-14、N-15、N-16、N-18（Balloons 消费 position）、N-19、N-24（guard 补键盘/拖放拦截）、N-26（i18n）、N-28（删死代码+闲置 CSS）
- 编辑器像素：E-01、E-02、E-03、E-04、E-05、E-06、E-07、E-08、E-15（rainbow 开关默认关）、E-30（diff/haskell/erlang/ocaml/latex/sass 六门）、E-32
- 树：T-01、T-16、T-17、T-29、T-30、T-32、T-33

### 待续清单（按优先级）

1. **P1**：已清空；下一批按优先级进入 E-23/E-19/E-20/E-33/E-35/E-39
2. **P2**：T-06、T-10、T-11、T-12、T-18、T-19、T-20、T-21、T-22、T-25、T-26、T-31、T-34、T-35、E-19、E-20、E-23、E-33、E-35、E-39、N-21、N-27
3. **L 级大件**：E-17（smartKeys）、E-18（行操作命令面）、E-21（折叠增强）、E-22（自研 FindBar）、E-25（stickyScroll）、E-26（codeLens）、E-29（剪贴板历史）、E-09（概览条汇聚）、E-11~14（折行悬挂/空白符/硬换行参考线/外观开关组）、E-30 剩余语言（zig/nix/gdscript/dotenv/gitattributes/gowork/godot-resource/terraform-vars/objective-c++——legacy-modes 无源，需自写语法或补 toml 包）、T-04 删除快照（目录级）

### T-24 本轮实施与 Review（2026-10-30）

- `src/features/project-tree/contextMenu.ts` 的 Git 子菜单补齐 Fetch、Put Label；文件动作补齐 Reformat code、Optimize Imports、Find Usages。
- `Put Label…` 复用 App 已有的 `newTag` 对话框和 `git.createTag`，没有新增 Git 状态模型。
- Review 核实 rollback 后端使用 `git restore --worktree`：空 revision 从 index 恢复，未跟踪文件经确认后移入回收站；因此不是 `unstage`。
- Review 核实 Compare With 固定打开 HEAD/工作区差异，Terminal 使用选中目标目录，Mark Directory 的 source/test/resources/excluded 角色写入设置。

### T-01 实施、Review 与下一轮重梳理（2026-10-30）

**实施**：`FsEntry` 统一增加 `isIgnored` 与 `isExcluded`，原有 `isHidden` 继续由后端文件属性组装；`list_directory` 对当前目录的直接子项一次性调用 Git `check-ignore --stdin -z`，不再把全仓库忽略清单交给项目树做前缀匹配。默认排除目录只按目录名计算，用户持久化的项目目录角色仍由项目树叠加，避免把 Git ignored 与 IDEA excluded 混为一谈。项目树过滤和紧凑包链判断均直接消费条目字段。

**Review**：检查了非仓库目录、无匹配、Git 忽略文件、忽略目录、默认 `dist` 排除目录和普通源码文件的边界；确认一次目录读取只启动一个 Git 检查进程，Git 不可用时降级为空忽略集，不影响普通文件树。发现并修复了前端测试 fixture 因契约扩展缺字段的问题；Windows 测试二进制在当前环境启动时报 `STATUS_ENTRYPOINT_NOT_FOUND`，属于测试运行时环境问题，Rust 定向测试已完成编译但未能执行断言。

**重梳理**：T-01 的代码和稳定契约已收口；下一轮优先处理 T-17 粘贴重名/系统剪贴板边界，完成后仍按“实施 → 定向测试 → Review → 修复 → 下一轮”推进。T-02 的悬空链接 `targetKind` 不在本轮扩大范围。

**当前验证**：项目树相关前端定向测试 30 项通过，TypeScript 检查和 `cargo check -p forge` 通过；Rust 定向测试已编译，但 Windows 测试进程因 `STATUS_ENTRYPOINT_NOT_FOUND` 未能启动。全量前端测试、生产构建和最终 diff review 在本轮结束前继续执行。

### T-17 实施、Review 与下一轮重梳理（2026-10-30）

**实施**：App 统一持有 `ClipboardState`，项目树通过 props 接入，移除树内第二套 Ctrl+C/Ctrl+X/Ctrl+V 处理，避免同一次按键执行两份逻辑。新增 `uniqueName`，按大小写不敏感规则生成 `copy` / `copy N` 名称；后端复制仍以 `TARGET_EXISTS` 拒绝覆盖，前端在冲突时打开 Copy 对话框。Windows 后端通过 `CF_HDROP` 只读获取资源管理器复制的文件路径，窗口激活时刷新；内部剪贴板优先，系统文件剪贴板作为无内部状态时的来源。

**Review**：首轮审查发现多项复制中首个条目冲突后，确认对话框只保存剩余路径、没有继续执行；同时普通复制在冲突确认后被错误清空。已抽出批量粘贴函数：确认当前名称后继续剩余批次，后续冲突逐项打开对话框；普通复制保留、剪切整批完成后清空。还核对了点文件命名、同目录剪切自粘贴跳过、系统剪贴板与内部剪贴板互斥、非 Windows 空实现和剪贴板关闭清理。

**验收**：`npm run check:ts` 通过；前端全量 **140 个测试文件、1441 项通过**；`npm run build` 通过；`src-tauri` 下 `cargo check -p forge` 通过；`git diff --check` 通过。生产构建仍报告既有的大 chunk 与无效动态导入警告，不影响构建成功。Rust 测试运行环境此前存在 `STATUS_ENTRYPOINT_NOT_FOUND`，本轮未将该环境问题误判成断言失败。

**已知边界**：Unix 桌面剪贴板协议未统一，当前只提供空结果；文本剪贴板不参与文件粘贴；系统文件剪贴板不携带剪切/复制意图，因此按复制处理；用户在 Copy 对话框确认后若后端再次返回非重名错误，只报告错误，不自动覆盖或重试。

**下一轮重梳理**：T-17 已收口，下一任务切换到 P1 的 T-32（树展开状态、视图选项和模式按工程持久化）；完成后回到 E-23/E-19/E-20/E-33/E-35/E-39 的键位、编辑器行为和保存卫生批次。T-17 的 `targetKind`、Unix 原生文件剪贴板和剪贴板剪切意图不在本轮扩大范围。

### T-32 实施、Review 与下一轮重梳理（2026-10-30）

**实施**：项目树将视图模式、9 个视图选项和展开键按规范化工程根分别保存到 `localStorage`；展开集合写入上限 3000 项并防抖 300ms。补充工程根切换同步：同一组件切换到另一个工作区时，重新读取该工程自己的模式、选项和展开集合，清理旧工程的未完成展开写入计时器，避免状态串工程。首次没有项目级选项时继续沿用全局隐藏/忽略设置，项目自己保存过选项后以项目状态为准。

**Review**：持久化边界增加了模式白名单、展开键类型过滤和损坏 JSON 回退；修复 `_v` 版本字段泄漏到 `ViewOptions` 的问题。测试覆盖工程隔离、模式回退、3000 项上限、非字符串展开键过滤，以及“无项目数据/已有项目数据”的迁移判定。

**验收**：`tests/lib/projectTreeViewState.test.ts`、项目树定向测试共 **3 个文件、20 项通过**；`npm run check:ts` 通过。T-17 已完成的全量前端 140 个测试文件、1441 项通过、生产构建和 `cargo check -p forge` 结果继续有效；本轮文档修改后另行执行 `git diff --check`。

**已知边界**：localStorage 不可用或满时静默回退内存默认值；当前只持久化项目树自身状态，不把树内选项反向写回设置页的全局 `settings.explorer`。外部库和 Scratches 的节点展开键沿用同一工程命名空间。

**下一轮重梳理**：T-32 收口，进入 E-23/E-19/E-20/E-33/E-35/E-39；每轮仍按实施、定向测试、Review、修复、全量验证和文档归档执行。T-32 不扩大到全局动作注册层（对应 T-35）。
