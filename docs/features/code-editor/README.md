# Monaco 接入

编辑器区唯一的正文表面是 Monaco（`CodeEditor.tsx`），比对页用的是它的 diff 编辑器（`DiffPane.tsx`）。
这一份管五件事：worker 与语言映射、颜色怎么从 CSS 令牌喂进去、三套快捷键方案、编辑器自带浮层（右键菜单）怎么同时拿到
中文文案和应用配色、搜索命中怎么落成光标与选区。页签栏见 [../shell-layout/](../shell-layout/)，视图按扩展名分派见
[../documents-preview/](../documents-preview/)，语言那侧见 [../localization/](../localization/)，谁来触发这些命中见
[../search/](../search/)。保存冲突的三向结果编辑器与不进 Git 的文件快照见
[三向合并与本地历史](./merge-and-local-history.md)。

## 启动路径上的模块拆分

`monaco-editor` 只被 `src/lib/monacoEditor.ts` 一处 import。扩展名表、等宽字体串、语言显示名、model 释放与
选区读取这四条门面放在 `src/lib/monacoEnv.ts`，那个模块不引 monaco；终端与运行窗口只要一个字体串，
不该为此把 2.7MB 的 `editor.api` 拖进依赖图。编辑器模块加载时通过 `attachMonacoBridge` 把这四条实现挂回
env，没挂上时释放 model 是无意义操作（盘上的东西还没进内存），取选区回空串（没有编辑器就没有选区）。

编辑区与工具窗口在 `App.tsx` 里是 `React.lazy`：`DocPane`、`DiffPane`、`GitPanel`、`GitLogPane`、
`TerminalPane`、`RunPane`、`SearchEverywhere`、`SettingsPage`。首屏（空白页或目录树）用不到它们，
实测产物首屏前需下载并求值约 0.39MB，首次打开文档才取 `monacoEditor`（1.26MB）与 `editor.api`（2.74MB）。
xterm 跟着终端与运行那两片 chunk，marked 与 DOMPurify 跟着 `MarkdownPreview` 那一片。

键位方案因此拆成两步：`App` 只往 env 里存值，装绑定发生在编辑器模块加载时，换方案由那边撤掉上一套再装。
中文 nls 仍在首屏前 `await`：monaco 在模块求值时就固化自己的文案，懒加载之后补不回这个顺序。
图标数据是同一套做法的先例（挂载后异步取，到位后订阅者重渲染，见 [../file-explorer/](../file-explorer/)）。

## worker 与语言映射

`MonacoEnvironment.getWorker` 按 label 分派五个本地 worker：`json` / `css|scss|less` /
`html|handlebars|razor|xml` / `typescript|javascript` / 其余落到通用 `editorWorker`。worker 用 Vite 的 `?worker`
后缀直接 import，不走 CDN，因为桌面应用离线也要有补全和高亮。路径写成 `monaco-editor/editor/editor.worker.js`，
是因为 0.57 的 `exports` 映射把 `./esm/vs/*` 挂在包根下。`vite.config.ts` 因此不用加 monaco 插件。

语义有两个来源，同一个语言只能留一个。默认走上面那批 worker；某一档切到外部语言服务之后，`lspClient.ts`
把这门语言的内置语义配置关掉（`configureBuiltin`），补全、hover、跳定义改由那个独立进程答，诊断以
`setModelMarkers` 写成另一份 marker。为什么要让位、以及配置与进程那一套见
[../../plans/lsp-language-servers/](../../plans/lsp-language-servers/README.md)。

语言靠两张表认：51 条扩展名加 4 条文件名特例（`Dockerfile`、`Makefile`、`.gitignore`→ini、`.env`→ini）。
`languageForPath` 先按文件名查、再取最后一个点之后的扩展名，没点或查不到一律 `plaintext`，不嗅探内容。几张不显然的映射：
`tsx|mts|cts`→typescript、`vue|svelte`→html（借 HTML 的语言服务，而不是落回没有高亮）、`ps1`→powershell。
底部状态条给人看的是 Monaco 的别名而不是内部 id。别名表在 `monacoEditor.ts` 里第一次用时建好缓存；
编辑器还没加载过（只看图片或还没开过文件）时读的是 `monacoEnv.ts` 那张手写表，取值与 monaco 的第一条别名对齐。

model 的生命周期跟着标签。一份文件一个 model（`monaco.Uri.file(path)`），同一个 model 才保得住撤销栈。关标签
`disposeModel`，否则切回来还是旧内容。换工程 / 关项目 `disposeAllModels`。内容还没从磁盘读回来时不建 model，
因为建了就是一个再也更新不到的空模型。重载进来的文本要显式落到 model，不落这一步下一次 `onDidChangeModelContent`
会把 model 里的旧文本当成用户的修改写回去，等于把刚读回来那份覆盖掉。`tabSize` 跟设置、`insertSpaces` 恒真、
行尾按磁盘那份设 `EOL`、只读或打开失败的连 `domReadOnly` 一起关。切预览视图时 Monaco 被 `hidden` 而不是卸载，
撤销栈和光标才留得住（`DocPane`，视图分派见 [../documents-preview/](../documents-preview/)）。

## 搜索命中的落点

弹层和底部查找窗口交出来的命中是 `{path, line, column, length}`。`useDocuments` 把它排成一份 `reveal`：一次只挂一处，
带一个自增的 `token`，同一个位置连点两次也要再跳一回。`DocPane` 原样透传给 `CodeEditor`，编辑器那个 effect 落完行与
选区就调 `revealDone` 把它清掉，同一次定位不会重放。effect 先比对 `reveal.path` 与当前文档（`samePath`，大小写和
分隔符不参与），不是这一篇就不动。

后端给的列号按字符数算，monaco 的列按 UTF-16 码元算，行里有代理对（emoji 这类）时两者错开，所以落点先取真实行内容
（`getLineContent` 按码点展开）再折算，起点和终点都夹在这一行的长度之内。文档还在读的时候 model 不存在，effect 直接返回；
读回来那一次 `document` 变了，这个 effect 跟着再走一遍，落点不会丢。

跳的是用户手里那份，不是磁盘那份：`openHit` 见文件已经开着且不在读，就只切过去排定位，不走 `open`。
`open` 会把磁盘文本写回文档，没保存的改动当场没了，而命中要落的正是眼前这些字。带定位打开 markdown 或 svg 时视图落到
源码，跳过去看的是那一行文字，不是渲染结果（见 [../documents-preview/](../documents-preview/)）。

## 颜色：CSS 令牌 → 十六进制

Monaco 与 xterm 的配色接口只认十六进制，而 `tokens.css` 里大量令牌是 `rgb()` / `rgba()`，所以要过一层 `toHex`
（百分比写法的 alpha 也一起处理，`tokenColor` 那步顺带读变量）。深浅色切换后重读一次就换一套。两条主链路是 monaco 主题
和 xterm 主题那 6 个键（`terminalColors`：`background` / `foreground` / `cursor` / `selectionBackground` /
`black` / `white`）。界面、编辑器、终端在深浅色下必须同色，只留一份来源，是因为在主题里再抄一遍字面量就是留一份会过时的常量。

`toHex` 还要把**三位 / 四位简写**（`#fff` / `#fff8`）展开成六位 / 八位。这条不是洁癖：生产构建的 CSS 压缩会把
`#ffffff` 压成 `#fff`，而 monaco 的颜色表只匹配六位，喂简写进去会**抛异常**（`Illegal value for token color`）。
那个异常从 `applyMonacoTheme` 抛出、无人接住，而界面没有错误边界，结果是**整棵 React 树被卸载、界面白屏**——
打开任意一篇文档（触发 monaco 模块加载 → `applyMonacoTheme`）就必然发生。dev 模式不压 CSS，所以只在生产复现。
`monacoEnv` 的 `themeToken` 也过这道 `toHex`，保证喂给 monaco / xterm 的每个颜色都规范化过。

`applyMonacoTheme(dark)` 每次深浅色变化都重新 `defineTheme("forge")` 再 `setTheme`。深浅色变化由
`monacoEditor.ts` 自己盯 `<html data-theme>` 触发（`useSettings` 把算好的主题写在那儿），**不挂在任何组件的
挂载状态上**：先前它挂在 `CodeEditor` 的 effect 上，开着比对页时那台编辑器没挂载，切主题就没人重设，
比对两侧的底色停在旧主题上。属性一变就重取 CSS 变量再定义一遍，两台编辑器（`CodeEditor` 与
`DiffPane`）跟着一起翻。基础 `vs` / `vs-dark` 加
`inherit: true`，语法着色继续用 monaco 自带的规则，只换表面色。几个不在令牌里的值：行高亮浅色 `#f3f4f6` / 深色
`#1a1a1a`、diff 四色 `#22c55e22` / `#ef444422`（文字）与 `…14`（整行）、阴影 `#0f172a40` / `#000000aa`。
等宽字体取 `--font-mono` 再补一层 CJK 等宽回退（`"Microsoft YaHei Mono", "Noto Sans Mono CJK SC", "MS Gothic"`）。
补这层回退，是因为拉丁等宽字体没有全角括号和引号这些标点，Monaco 量不到字形就画方框。

编辑器固定参数：`lineHeight` 20、滚动条 11px 不用阴影、`minimap.maxColumn` 90、`fixedOverflowWidgets`
（补全与 hover 浮层不被容器裁掉）。`hover.above: false`，是因为 monaco 只留一档位置偏好，偏上时若上方放不下它不翻到下方，
而是把整块夹到窗口顶上 22px 处，浮框就跟波浪线彻底脱开。偏下没这条夹取，落点始终贴着那一行。设置里的字号（10…28，默认 13）
只在编辑器这一处生效。比对页写死 13，终端写死 12。

## 三套快捷键方案

`default` / `idea` / `eclipse`。默认方案不装任何绑定，`applyKeymap` 查不到表就返回 `null`，剩下全交给 monaco 内置。
IDEA 那套 26 条、Eclipse 那套 19 条，每条的 `command` 都是 monaco 已有的命令 id。表里只收 monaco 里有对应命令的那部分，
IDEA 里有而 monaco 没对应命令的（重构那一族：抽取方法 / 内联变量）不进表，没列出来的键保持 monaco 默认。走的是动态键绑定服务
`addKeybindingRules`，权重高于内置，所以同名键被覆盖而不是并存。换方案时先把上一套的 disposable 整体 `dispose()` 再装新的。
`when` 子句分两类：会改文本的挂 `editorTextFocus && !editorReadonly`，跳转 / hover / quick fix 只要求 `editorTextFocus`
（只读文档也能用），折叠那四条额外要 `foldingEnabled`。改的只是编辑器内的键位，终端和运行面板不受影响，那些键在 xterm
与窗口级 handler 那里。

搜索那三个入口（双击 Shift、`Ctrl+Shift+N`、`Ctrl+Shift+F`）不进这两张表：它们不是 monaco 命令，由窗口级 handler 接，
三套方案里同一套键。`SHORTCUT_HINTS` 顶上三条就是它们，空态那张告示页照这三条画，见 [../search/](../search/)。
`Ctrl+Shift+F` 在这两张表之外还占着 Eclipse 的格式化，焦点在编辑器内时按上面那张表走。

键位字符串自己解析（`parseKey`）：`ctrl` / `cmd` 都映射到 `CtrlCmd`，26 条具名键（`NAMED`），其余按规则推，单字母 →
`Key<X>`、单数字 → `Digit<n>`、`f1`…`f12` → 大写后查 `KeyCode`。光有修饰键不算一条绑定。解析不出来的条目报一条
`console.error` 就跳过，不让整套方案崩掉。

几处刻意跟 monaco 默认不同的键：`Ctrl+D` 在 IDEA 是复制行、在 Eclipse 是删行。IDEA 的 `Ctrl+R` 是替换（monaco 默认
`Ctrl+H`）、`Ctrl+Y` 删行、`Ctrl+Shift+A` 开命令面板（对 IDEA 的 Find Action）。Eclipse 的 `F2` 是 hover 而不是重命名
（重命名 `Alt+Shift+R`）、`Ctrl+1` quick fix。空态那张告示页读的就是这三档的键位，当前方案没绑的那条命令整行不画
（见 [../shell-layout/](../shell-layout/)）。保存不在任何方案里，是因为 monaco 没有保存这条命令，所以 `Ctrl+S`
由编辑器自己用 `addCommand` 接，三套方案下都当场存得下去。

## 编辑器内的右键菜单

这一层菜单由 Monaco 自己画，不是应用画的。要点是 `editContext: false`（`CodeEditor`、`DiffPane` 都设了）。开着它时
Chromium 自己画右键菜单，语言走不到 monaco 的中文文案上，主题色也吃不到。文案跟着启动时进去的那份语言表。`src/main.tsx`
在 import 界面之前按语言 import `monaco-editor/nls/lang/zh-cn.js`，那份文件只做一件事：把 `globalThis._VSCODE_NLS_MESSAGES`
写成中文，而 monaco 在模块求值时就把文案固化了。这就是换语言要重开窗口才带到编辑器里的机制，界面其余部分即时切换。

两条补齐都得留着。菜单画在 monaco 自己的 shadow root 里，而 monaco 把 `--vscode-*` 只写在 `.monaco-editor` 上，
浮层宿主是这条链的兄弟节点，穿不进去就成了透明底。靠 `src/styles.css` 那条 `.shadow-root-host` 补，自定义属性能穿过
shadow tree，把菜单底色 / 字色 / 分隔线 / hover 那几档重新指回应用的令牌。主题里那三条 `menu.*` 管的是读得到变量的那条路径。

## 比对页的顶栏

比对页开在编辑区那一格里，标签已经写着文件名，所以顶栏不再重复标题，摆的是 IDEA 那条：左端
`↑ 上一处差异 ↓ 下一处差异`、一竖、`跳到源码`、一竖、`← 3/24 个文件 →`、一竖、`✕`；右端
`N 个差异` 与 `并排 / 统一` 那一对。两处计数念的都是 IDEA 的选择式：
`0#No files|1#1 file|2#{1}/{0} files`、`0#No differences|1#1 difference|2#{0} differences`。

三条门控都取自 IDEA 自己的规则：

- 上下两枚按光标当前落在第几处差异来定能不能走；本篇走到头了转到链上相邻那一篇（IDEA 那条默认，
  `GO_TO_NEXT_FILE_ON_NEXT_DIFFERENCE` 出厂为真），链也走到头才 disable。差异还没算完时四枚都不动、条数也不报：
  `getLineChanges()` 返回 null 是「还没算出来」，把它当「无差异」报出去是假话。走链不换标签，机制见
  [../documents-preview/](../documents-preview/) 的「一条链一个比对标签」。
- 左右两枚只在链条走得动时才画（一串多于一条），计数照画——串里只有一条时 IDEA 也照样写「1 file」。
- 「跳到源码」只在这份比对确实对应一个工作区文件时才画：哪一侧写着删除、或者两侧都取自仓库（提交与提交相比），
  去不了源码，就不摆这颗。

差异清单与走位都来自 monaco：`onDidUpdateDiff` 触发重读 `getLineChanges()`，走位调 `goToDiff()`。
`goToDiff` 在两端会把「找不到下一条」当成「回到第一条」，环绕是它的默认行为——所以能不能走由这一头按当前
位次先判掉，调用只在能走时发生。

`并排 / 统一` 改的是 `renderSideBySide` 这一项选项，编辑器不重建；这一档存在组件里，换一篇文件重建议编辑器时
由 `sideBySideRef` 带进创建参数，跳一篇不会翻回并排。

两侧各自的表头挂在各自那一栏的上沿，不是一条横跨的通栏：左那格按编辑区左栏的实测宽度钉住（取
`getOriginalEditor()` 那台容器的 `getBoundingClientRect().width`），右那格吃掉剩下的；拖动中间那条分界或改窗口
大小都会触发 `onDidLayoutChange` 重量。统一视图只有一栏，两侧名字就叠在那一栏上沿。每行前面那颗锁标是只读标记，
两侧都不能改。根提交那一侧没有版本名，IDEA 给空内容不画表头，这里同样留空。

## 已知边界

- 语言表只有 `zh-cn` 一份，其它界面语言下 monaco 内置文案保持英文（`src/main.tsx` 只在 zh 时 import）。
- 比对页缩略图关、`diffWordWrap: "off"`。每次挂载发一个序号拼 `inmemory://forge/diff-<seq>-<side>` 两条 URI，
  因为编辑区和日志窗口可以同时各开一份比对，共用一对 URI 会撞 model。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src/lib/monacoEnv.ts` | 扩展名表 `:12-64`；文件名特例 `:67-73`；`languageForPath` `:75-81`；`LANGUAGE_LABELS` 兜底 `:87-123`；`languageLabel` `:125-127`；CJK 回退与 `monoFont` `:137-142`；`themeToken` `:145-147`；`MonacoBridge` 与 `attachMonacoBridge` `:150-162`；`disposeModel` / `disposeAllModels` `:165-171`；`selectedText` 门面 `:179-181`；`setKeymapScheme` / `keymapScheme` / `onKeymapScheme` `:191-206` |
| `src/lib/monacoEditor.ts` | 唯一的 monaco import `:7`；worker 分派 `:19-40`；`modelUri` `:43-45`；`disposeModel` `:48-54`；`selectedText` 实现（取有文字焦点那台编辑器的选区） `:63-72`；别名表 `:76-86`；`applyMonacoTheme` `:88-131`；挂桥 `:133`；盯 `data-theme` 重设主题 `:135-148`；按键位方案并跟着换 `:156-162` |
| `src/components/CodeEditor.tsx` | `PIN_WIDTH` `:12`；`RunGutterPin` `:15-21`；创建参数与 `hover` / `editContext` `:86-109`；重建议时断旧连接 `:111-112`；`addCommand` 保存 `:114`；不建空 model `:150-160`；重载落 model `:190-203`；`tabSize` / `EOL` / `domReadOnly` `:196-203`；装订线落点测量 `:254-278`；命中落点 effect（列号按真实行内容折算、`revealDone`） `:294-313` |
| `src/hooks/useDocuments.ts` | `RevealTarget`（列按字符数算，折算留给编辑器） `:12-28`；`reveal` 状态与 `token` `:91-93`；`open` 带 `at` 时排定位、视图落回源码 `:133-146`、`:192`；`open` 与 `openHit` 都不重读已开着的文档 `:147-156`、`:230-250`；出口 `reveal` / `revealDone` `:443-444` |
| `src/lib/color.ts` | `toHex` `:2-19`；`tokenColor` `:22-24` |
| `src/lib/term.ts` | `terminalColors` `:74-84` |
| `src/lib/keymap.ts` | `MODIFIERS` `:12-20`；`NAMED` `:21-49`；`codeOf` `:52-60`；`parseKey` `:62-80`；`IDEA` `:84-112`；`ECLIPSE` `:114-134`；`BINDINGS` `:136-143`；`applyKeymap` `:145-158` |
| `src/lib/keymapHints.ts` | `ShortcutHint` `:10-13`；`SHORTCUT_HINTS` 12 条 `:19-61`，顶上三条搜索入口 `:20-33`。单独一个模块是因为告示页在启动路径上 |
| `src/components/DiffPane.tsx` | `DiffGroup` `:9-21`；入参 `:23-44`；diffSeq 注释 `:46-47`；`activeChangeIndex` `:49-60`；`sideRow` `:62-71`；挂载判断 `:98-101`；创建参数 `:103-115`；URI 序号与两条 model `:117-121`；读差异与量分界 `:123-125`；落到首 / 末那一处 `:126-141`；三路监听 `:148-157`；`setMode` 与 `sideBySideRef` `:95-96`、`:168-173`；本篇与链上的可走门控 `:175-184`；`goDiff` `:186-198`；顶栏 `:208-330`；差异条数与布局那一对 `:295-329`；两侧表头 `:336-343` |
| `src/components/DocPane.tsx` | `hidden` 不卸载 `:71-73`；`reveal` / `onRevealDone` 透传 `:20-22`、`:79-80` |
| `src/components/TerminalPane.tsx` | 字号 12 `:71` |
| `src/components/SettingsPage.tsx` | 字号 10…28 `:157-165` |
| `src/main.tsx` | 先读设置再 import `:14-31`；中文 nls 在渲染前落定 `:24-26` |
| `src/styles.css` | `.shadow-root-host` 补 shadow tree 变量 `:1561-1572` |
| `src/App.tsx` | 九条 `lazy` `:117-125`；`setKeymapScheme` `:505`；`disposeAllModels` `:838`、`:852`、`:2381`；`disposeModel` `:891`、`:1743`、`:1766`、`:1851`；四处 `Suspense` `:2148`、`:2679`、`:2776`、`:2929` |
