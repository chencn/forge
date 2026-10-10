# 文件类型分派与预览视图

打开一份文件先定显示方式，再决定给哪几种视图。判定只有 `docKindOf` 一处，按扩展名分五类。视图落点在
`DocPane`，磁盘那份与手里的文本怎么让位见 `../workspace-watch/`。

## 五类

取文件名最后一个点之后的扩展名并小写。`markdown` 是 `md` / `markdown` / `mdown` / `mkd`；`image` 是 `png` `jpg`
`jpeg` `gif` `webp` `avif` `bmp` `ico` `tif` `tiff` 十种；`svg` 单列一类，它本体既是图也是文本；其余落 `text`
（`.gitignore` 取到的是 `gitignore`）。第五类 `binary` 是看一眼扩展名就知道打不开的那批：可执行文件与库（`exe`
`dll` `so` `dylib` `wasm` 等）、归档与压缩（`zip` `gz` `7z` `jar` 等）、办公文档与 `pdf`、字体、音视频、数据库文件。
判错了不致命，只是少一句明确说明；没列出的（例如没有扩展名的可执行文件）落到读盘那一步再判。

| 类型 | 源码视图 | 预览视图 | 打开先给 | 能切换吗 |
| --- | --- | --- | --- | --- |
| text | 有 | 无 | 源码 | 不画切换 |
| markdown | 有 | 渲染后的 HTML | 预览 | 两视图互切 |
| svg | 有（XML 正文） | `<img>` 读磁盘那份 | 预览 | 两视图互切，虚拟文档只给源码 |
| image | 无正文 | `<img>` 读磁盘那份 | 只有预览可画 | 不画切换 |
| binary | 无正文 | 无 | 正文区一句说明 | 不画切换 |

- 能预览的先给预览：`defaultView` 除 text 和 image 之外都返回 preview。打开 markdown 和 svg 就是来看渲染结果的，
  要看源文再切过去。
- 从搜索命中跳进来的那一次例外：带定位打开时视图直接落到源码，已经开着且停在预览的也一并扳回源码。跳过去要看的
  是那一行文字，不是渲染结果。落点那条链见 [../code-editor/](../code-editor/)，谁来触发见 [../search/](../search/)。
- image 类型是特例：`defaultView` 给它 source，但 `DocPane` 对 image 不看 `view`，直接画预览，这个字段对它没有
  意义。
- binary 在 `open()` 读盘之前就判出来：正文不读，文档设成只读，原因写进 `error`，`DocPane` 摆的是这句说明。
- `canPreview` 只放 markdown 和在磁盘上的 svg。svg 的图片视图经 asset 协议读磁盘，从 git 历史打开的虚拟文档（键
  写成 `绝对路径@短哈希`）盘上没有对应物，只能留在源码；markdown 预览渲染的是手里的正文，虚拟文档照样能看。
- 切换的两个按钮浮在编辑区右上角（`top: 6px`、`right: 16px`），24×24 纯图标，图标 15px，不占正文一条高。悬停文案
  markdown 那侧是「预览」，svg 和 image 是「图片」，另一侧都是「源码」。
- 切视图不丢撤销栈和光标：Monaco 一直挂着，切到预览只是给源码容器加 `hidden`。

## markdown 渲染链

`marked`（`gfm: true`、`breaks: false`）转 HTML，再由 `DOMPurify.sanitize` 洗一遍，去掉脚本与 `on*` 事件处理器。
三个属性例外留下：`data-external` / `data-local` / `target`，点击时读这三个属性决定去处。

`ALLOWED_URI_REGEXP` 被补成认 `asset:`。DOMPurify 默认放行 http(s) / mailto / data 和相对地址，不认这个本地图片
scheme；不补的话 `src` 整条被洗掉，图就没了。`img-src` 那边 CSP 另有一道，同时放 `https:` 和 `http:`，线上图片
直连。

地址改写只做两件事：本地图片换成 asset URL，链接打上标记，好让点击时决定去处。

- 绝对 URL 与 `data:` 原样。
- `#锚点` 原样。
- 相对路径按这份文档所在目录还原成绝对路径；`..` 退到根就停，不再越出去。
- 已经是 Windows 形状的路径（盘符或 UNC）不跟文档目录拼，只把正斜杠归一成反斜杠。git 回的就是 `D:/app/x` 那种写法。
- 查询串和片段先摘出来再解路径，否则会被当成文件名的一部分。
- `decodeURIComponent` 解不开（作者手写的裸 `%`）就按原样用。
- 本地图片与线上图片同一条渲染路径：`src` 在这一步就定好了，组件不再二次改写。`assetUrl(absolute, 0)` 故意不带
  缓存失效串，正文一变整块 HTML 就重出。
- 链接打标记用的是原始 href，不是改写后的 url。本地文件那份 url 已经变成 `asset:`，拿它判 `isExternal` 会把本地
  文档错当外链。

## 预览里的三种点击

在容器上拦一次点击。

- `data-local`：开进编辑区，由类型决定落到哪个视图。
- `data-external` 且 href 以 `http(s):` / `mailto:` / `tel:` 开头：交给系统默认浏览器。外链不在应用内开，webview
  里跳走就回不来。
- 页内锚点不 `preventDefault`，留给浏览器滚。

只放行这三条协议。`javascript:` 之类早被 DOMPurify 洗掉了 href，不能再拿空串去起进程。

Windows 侧的落点是 `ShellExecuteW`，不是 `cmd /C start`。cmd 会二次解析命令行，URL 里一个 `&` 就能把后面的内容当
成新命令执行；markdown 里的链接是外部输入，不能当可信文本。返回值 `<= 32` 按失败处理。「用关联应用打开」在目录树
菜单上走的是同一条命令。

## 图片预览

一张居中、可缩放的 `<img>`。

- 倍率档位 `0.25 / 0.5 / 0.75 / 1 / 1.5 / 2 / 3 / 4 / 6`，加号和减号在档位之间跳，到两端各自置灰。中间显示当前
  百分比，取到原图尺寸之前显示省略号。第三个按钮把倍率退回基准档 `zoom = 1`，已经在基准档时置灰。
- 基准是适应窗口：`min(1, 可用宽 / 原宽, 可用高 / 原高)`。容器装得下就按原尺寸，不放大。可用宽高从画布的
  `clientWidth` / `clientHeight` 各扣 48px，对应 CSS 每边 24px 内边距。
- `ResizeObserver` 盯着画布，窗口一改比例就重算。
- 缩放落成真实的 `width` / `height`，不是 `transform`。`transform` 不改布局盒，放大后多出来的部分落在滚动区之外，
  滚不到。
- 画布用 `justify-items: safe center` 和 `align-items: safe center`。普通 `center` 在内容比容器大时会把左上角顶出
  滚动区。
- 换一张图或指纹一变就把倍率、失败态和原图尺寸复位。`onError` 时给一句「这张图片读不出来」。

svg 与位图共用这一份组件：用 `<img>` 加载 svg 时脚本不会执行，预览这一侧是安全的，要看图里的逻辑就切到源码视图。

`src` 尾上的 `?v=` 是磁盘指纹 `modifiedMs || size`。内容换了而 URL 一模一样时 webview 会拿旧图，换个值才重取。指纹
取自 `file_stamp`，打开时取一次，外部改动时再取一次。

## 差异页与读写约束

`DiffPane` 不属于文档视图：monaco 的 `createDiffEditor`，只读、默认并排、`fontSize: 13`、关 minimap，另带
`automaticLayout: true`、`scrollBeyondLastLine: false`、`renderOverviewRuler: false`、`diffWordWrap: "off"`，字体
走 `monoFont()`。`editContext: false` 让右键菜单由 monaco 自己画，才吃得到应用的中文文案。并排与统一由顶栏那一对
开关切换 `renderSideBySide`，两侧的版本名各自挂在自己那一栏的上沿——顶栏与门控见
[../code-editor/](../code-editor/) 的「比对页的顶栏」。

每次挂载发一个 `diffSeq`，拼进两条 model 的 URI（`inmemory://forge/diff-<seq>-<side>`）。编辑区和日志窗口可以同时
各开一份 diff，共用一对 URI 会撞 model。

开比对前先按扩展名判一次，`canDiff` 排除 image 和 binary：图片能打开但没有可逐行比对的文本，binary 两样都不行。
这类理由不读盘，标签正文直接写这条原因（`NO_DIFF`，按类型挑文案），标签留着，能看到为什么打不开。错误码原文
存进标签，渲染时才翻，切语言这句跟着换。目录树「比较文件」开进去的就是这两份磁盘文本，见 `../file-explorer/`。

只编辑 UTF-8 文本。整份读入时超过 8 MiB（`EDITOR_CEILING = 8 * 1024 * 1024`）报 `TOO_LARGE`；解不成 UTF-8 时再分
一层，正文里有 NUL 算 `BINARY`，其余算 `NOT_UTF8`。这几种都不给半份内容。界面有两条出口：右下角那条错误气泡
（停留多久、怎么进历史见 [../shell-layout/](../shell-layout/)），正文区中央一条常驻说明（一个图标加一句翻好的话）。
用中央说明而不是气泡，是因为气泡一闪就走，打不开的原因得一直留在正文区，直到关掉标签。同时文档设为只读，读取失败的
文档同样按只读处理。

文案按语言拼好，字节数换算成可读形式：「这个文件有 12.4 MB，编辑器最多打开 8.0 MB」。MB 保留一位小数，KB 取整。

读写风格成对：读时剥 BOM，正文含 `\r\n` 认 `crlf`，否则 `lf`；写时按那份 `lineEnding` 归一并还原 BOM，存回去的
仍是原文件的风格。

## 一条链一个比对标签

顶栏那两枚左右箭头（`← 3/24 个文件 →`）与上下两枚（上一处 / 下一处差异）**都不新开标签**：一次比对来源的那一串
文件就是一个标签，走链只换它里面的那一篇，标签上的文件名跟着换。这条照的是 IDEA 的机制——它的比对标签宿主
`ChainDiffVirtualFile` 拿的是一整条 `DiffRequestChain` 加一个下标，走链只是 `myIndex += 1` 再重算请求，全程不碰
`FileEditorManager`，标签名取的是当前那条请求的标题，所以标题动、标签不动。

落点是：链条登记在 `diffChains` 里（编号 → 这一串文件 + 按哪种口径比），标签上带 `{ 编号, 第几篇, 共几篇 }`；
走链时开比对那几步拿到 `step`，把**自己那颗标签的 id** 写回去换内容，而不带 `step` 的入口调用照旧新开一颗。
后者也对齐 IDEA：`showDiffBuiltin` 每次调用都 `new` 一个新的链文件，而复用只认 VirtualFile 身份——换了版本对
比同一篇文件，在 IDEA 那里就是另一颗标签。

上下两枚还接了 IDEA 那条默认（`GO_TO_NEXT_FILE_ON_NEXT_DIFFERENCE` 出厂为真）：本篇最后一处差异走完之后再按
下一处，就转到链上下一篇并落在它第一处差异上；上一处对称，落在最后一处。落点由标签上的 `landOn` 带过去，
只在那一篇的差异算出来后认一次。左右两枚本身换篇不带落点，从篇首看起。差异还没算完时四枚都不动——
`getLineChanges()` 返回 `null` 是「还没算出来」，此时既不报条数也不让走。

和 IDEA 有一处对不上，是这边缺能力不是漏抄：IDEA 那串文件取的是**当时选中的那一批**（点的那行标成下标），
`3/24` 的 24 就是选中数；forge 的 Git 面板没有变更多选，单击一行就开比对，所以这一串交给的是整组
（已暂存那一组 / 未暂存那一组 / 那次提交的文件清单 / 那次比较的文件清单）。IDEA 那套「预览签」也没抄：它给
普通文件准备、出厂关着（「Enable preview tab」），比对那条路根本不走它。

IDEA 一侧根目录 `D:\app\code\intellij-community`：

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `platform\diff-impl\src\com\intellij\diff\editor\ChainDiffVirtualFile.kt` | 比对标签装的是整条链；标签名取当前请求的标题 | `:10-21` |
| `platform\diff-impl\src\com\intellij\diff\impl\CacheDiffRequestChainProcessor.java` | `setCurrentRequest`；上下走链只动下标；链条多于一篇才允许走 | `:60-63`、`:80-96` |
| `platform\diff-impl\src\com\intellij\diff\actions\impl\DiffDifferenceNavigationAction.kt` | 本篇走完后转到邻篇那条分支 | `:74-95` |
| `platform\diff-impl\src\com\intellij\diff\impl\DiffSettingsHolder.kt` | `GO_TO_NEXT_FILE_ON_NEXT_DIFFERENCE` 默认 `true` | `:27-30` |
| `platform\diff-impl\src\com\intellij\diff\editor\DiffEditorViewerFileEditor.kt` | 换篇就地刷新那颗标签的名字 | `:76-82` |
| `platform\diff-impl\src\com\intellij\diff\DiffManagerImpl.kt` | 每次发起比对都 new 一个新的链文件 | `:56-87` |
| `platform\platform-impl\src\com\intellij\openapi\fileEditor\impl\EditorWindow.kt` | 复用只比 `composite.file == file` | `:932`、`:950` |
| `platform\vcs-impl\src\com\intellij\openapi\vcs\changes\actions\diff\ShowDiffAction.java` | 那串文件来自当时选中的变更，点的那行标成下标 | `:100-123` |
| `platform\vcs-impl\src\com\intellij\openapi\vcs\changes\PreviewDiffVirtualFile.java` | 唯一覆写 equals / hashCode 的比对文件，差异预览靠它复用同一颗 | `:49-59` |
| `platform\editor-ui-api\src\com\intellij\ide\ui\UISettingsState.kt` | 预览签那条默认关着 | `:74-75` |

## 代码

| 文件 | 内容 |
| --- | --- |
| `src/lib/docKind.ts` | 五类划分的前提 `:1-11`；`IMAGE_EXTENSIONS` `:13-25`、`MARKDOWN_EXTENSIONS` `:27`、`BINARY_EXTENSIONS` `:29-48`；`extensionOf` 与 `docKindOf` `:50-64`；`hasTextContent` / `previewsFromDisk` / `canDiff` `:66-92` |
| `src/hooks/useDocuments.ts` | `canPreview` 与 `defaultView` `:69-84`；`open()` 里 binary 先说明、位图只取指纹、svg 两样都取 `:149-196`；带命中打开时视图落到源码 `:184`；`openHit` 把已开着的扳回源码 `:216-240`；`openVirtual` 的虚拟文档 `:253-277` |
| `src/components/DocPane.tsx` | 悬停文案表 `:25-34`；分派注释 `:36-44`；`sourceCapable` 与 `showPreview` `:56-57`；错误说明 `:59-66`；源码容器加 `hidden` `:71-73`；`reveal` 透传 `:20-22`、`:79-80`；markdown / svg / image 三个落点 `:85-93`；视图切换条 `:96-119` |
| `src/lib/markdown.ts` | `isExternal` `:5-8`；`resolveHref` 的六条改写规则 `:10-40`；`Marked` 选项 `:60`；图片与链接渲染器 `:64-85`；`DOMPurify.sanitize` 的例外属性与 `ALLOWED_URI_REGEXP` `:89-96` |
| `src/lib/format.ts` | `isWindowsPath` `:3-6`；`nativeSeparators` `:13-19`；`resolveRelative` `:33-51` |
| `src/components/MarkdownPreview.tsx` | `assetUrl(absolute, 0)` `:24-27`；换文档回到顶部 `:29-32`；点击分派与协议白名单 `:38-57` |
| `src/components/ImagePreview.tsx` | 档位与 48px 内边距 `:13-17`；`<img>` 加载 svg 不执行脚本 `:19-28`；指纹复位 `:38-43`；`ResizeObserver` `:45-55`；适应窗口与真实宽高 `:57-63`；`step` `:65-72`；工具条 `:76-108`；画布与失败文案 `:109-128` |
| `src/components/DiffPane.tsx` | `notice` 与 `landOn` 入参 `:35-40`；挂载判断 `:98-101`；`createDiffEditor` 选项 `:103-115`；`diffSeq` 与两条 URI `:46-47`、`:117-121`；落到首 / 末那一处 `:126-141`；上下走到本篇尽头转邻篇 `:186-198`；说明与正文切换 `:332-346` |
| `src/components/PaneNotice.tsx` | 常驻说明的形状 `:8-21` |
| `src/lib/fs.ts` | `assetUrl` 的 `?v=` `:126-135`；`fileStamp` `:116-124`；`openExternal` `:142-145` |
| `src-tauri/src/fs/mod.rs` | `EDITOR_CEILING` 8 MiB `:29-31`；`read_file` 的 `TOO_LARGE` / `BINARY` / `NOT_UTF8` 与行尾判定 `:194-229`；`write_file` 归一行尾与 BOM `:231-264`；`file_stamp` `:356-366`；`open_external` `:380-383` |
| `src-tauri/src/fs/windows.rs` | `ShellExecuteW` 与 `<= 32` 失败码 `:71-94` |
| `src/App.tsx` | 错误写成通知气泡 `:270-297`；`openLocalFile` `:869-875`；`openDiffTab` 先判 `canDiff` `:903-938`；`DiffTab` 的 `chain` 与 `landOn` `:151-165`；`ChainStep` `:168-174`；链条登记表 `:401`；虚拟文档键 `:1178-1197`；比较文件 `:1331-1355`；走链写回同一颗标签 `:1365-1393` |
| `src/lib/errors.ts` | `codedError` `:12-14`；`humanBytes` `:18-25`；`TOO_LARGE` / `BINARY` / `NO_DIFF` 三条文案挑选 `:37-43` |
| `src/components/CodeEditor.tsx` | `error` 也按只读处理 `:112-115` |
| `src/styles.css` | 视图切换条与按钮尺寸 `:1596-1630`；常驻说明 `:1641-1667`；`doc-source[hidden]` `:1669-1679`；markdown 正文 `:1681-1694`；图片画布与缩放条 `:1696-1746` |
| `src-tauri/tauri.conf.json` | CSP 的 `img-src` `:27` |
| `src/i18n/lang/zh.ts` | 视图与缩放文案 `:143-151`；错误文案 `:57-61` |
