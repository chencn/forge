# 快捷键方案与实际覆盖范围

设置页只提供 IntelliJ IDEA、VS Code、Eclipse 三个方案选择，不展示键位清单或说明列表。
按键数据与动作实现分开：导入完整 keymap 不等于实现该 IDE 的全部功能。

## 数据来源

`src/lib/keymaps/` 保存 JetBrains IntelliJ Community 固定提交
`14e2fff0a9b351e49e1b4d0fded5d261ba235738` 的完整键表：

| 方案 | 上游文件 | 继承后动作数 | 有键盘绑定的动作数 | 原始键盘绑定数 |
| --- | --- | ---: | ---: | ---: |
| IDEA Windows/Linux | `platform/platform-resources/src/keymaps/$default.xml` | 422 | 400 | 443 |
| VS Code 兼容方案 | `plugins/keymaps/vscode-keymap/resources/keymaps/VSCode.xml` | 526 | 377 | 422 |
| Eclipse 兼容方案 | `plugins/keymaps/eclipse-keymap/resources/keymaps/Eclipse.xml` | 438 | 362 | 401 |

后两套是 JetBrains 的兼容方案，并非各产品原生键表的完整替代品。
`idea.ts` 中的 `nativeKeys` 记录已核对的原生修正，例如 VS Code 的选择整行、添加/取消行注释、
差异导航，Eclipse 的查找入口、移动行、匹配括号与重做。不能由兼容表的条目数推断原生产品覆盖率。

每个 JSON 保留来源 URL、父表、全部动作 id、键盘别名、多段键、鼠标与手势数据。
同名动作整体覆盖父表，包括显式空项；动作 id 大小写敏感；重复精确 id 取最后一次声明。
鼠标与手势数据的保留不代表所有对应交互已接通。

更新使用 `scripts/import-idea-keymap.ps1 -Preset idea|vscode|eclipse`，
也可通过 `-InputPath` 使用已下载的原始 XML。默认版本固定，升级须显式给出 `-Revision`。
禁止用手工摘录的常用键清单替换完整来源数据。

## 已接通的行为

当前运行时 `keymapBindings()` 和应用注册表的统计如下，**不是整个 IDEA 的支持率**：

| 方案 | 正文编辑器注册绑定 | 应用级注册绑定 |
| --- | ---: | ---: |
| IDEA | 102 | 31 |
| VS Code | 93 | 21 |
| Eclipse | 89 | 13 |

此表不含目录树、日志、比对、搜索输入框、候选框、系统剪贴板事件与双击修饰键手势；
不同上下文存在相同按键，不能简单相加。编辑器注册的绑定可能在无折叠区、无搜索结果等上下文返回不可执行。

- `cm/keymap.ts`：移动与选择、撤销重做、复制/删除选区或整行、行与语句移动、插行拆行、
  完成语句、代码块与括号导航、多光标、整词出现处、列选择、覆盖输入、注释、缩进、
  查找替换、循环单词补全、普通/递归/选区折叠、改动标记跳转。
- `shortcuts.ts` 与 `App.tsx`：已有应用动作的方案匹配，包括别名、多段键、保存、页签、
  搜索、面板、运行与 Git。IDEA Ctrl+S 保存全部；VS Code Ctrl+F5 普通运行，不能把 F5 调试当作普通运行。
- `ProjectTree.tsx` 与 `ui/Tree.tsx`：新建、行内重命名、移动、删除、复制路径、打开源文件随方案取键。
- `GitLogPane.tsx`：日志复制、分组、创建/重命名分支、打开差异与源文件等按焦点区域匹配。
  监听在面板根节点，先于应用全局分发；旧分支选区不会在文件列触发分支操作。
- `cm/diffView.ts`：改动导航、切换两侧焦点、打开源文件复用方案；没有外层回调也能在当前侧导航。
  普通差异、AI 补丁、本地历史支持热切换；合并冲突的三台编辑器也使用所选方案。

切换方案通过 CodeMirror Compartment 重配，保留正文、选区、撤销历史和滚动位置。
按键归一化处理 Shift 标点、物理键码和多段键；方案切换、失焦、输入法组合和超时取消未完成前缀。

## 尚未接通的范围

当前不能宣称“全部快捷键已支持”。Forge 尚无与 IDEA 对等的语言语义、重构、调试与工程服务，
因此定义/类型/实现跳转、查找用法、智能补全、参数信息、语义重命名/提取/内联、格式化与优化导入、
断点/单步/表达式求值等动作尚无对应实现。书签与层级折叠等动作也尚未接通。
未实现动作不注册空处理器，不以文本搜索、缩进或普通运行冒充原语义。

仅 Windows/Linux 来源表已导入；这些数据不能作为 macOS 原生 IDEA 方案的完整支持声明。

## 验证与归属

行为测试复用 `cmKeymap.test.ts`、`shortcuts.test.ts`、`cmDiffView.test.ts`、
`projectTreeLocate.test.ts`；日志焦点隔离由 `components/GitLogPane.test.ts` 验证。
测试检查文档、选区、撤销、只读、方案切换、多段键和上下文动作，不以绑定数量证明行为正确。

部分编辑命令的出处与许可见 `public/licenses/keymaps-NOTICE.txt`；Apache 2.0 正文在同目录。
Vite 将这些材料复制到 `dist/licenses/`，随桌面前端发行。
