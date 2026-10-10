# 辅助脚本

`scripts/` 下的东西直接 `node scripts/<name>.mjs` 跑，`package.json` 里没有为它们建脚本条目；只有
`run-rust.mjs` 被 npm 脚本调（`test:rs`、`check:rs`）。`make-icons.mjs` 和 `cdp-*.mjs` 只用 `node:`
内置模块。`make-file-icons.mjs` 要读 `node_modules/material-icon-theme`，那是 devDependency，没装会抛错，
得先 `npm install`。

## make-icons.mjs：应用图标

`node scripts/make-icons.mjs` 写四组文件到 `src-tauri/icons/`：`icon.ico`（7 个尺寸：16 / 24 / 32 / 48 /
64 / 128 / 256）、`icon.png`（512）、`32x32.png` 与 `128x128.png`（Tauri 按尺寸取图的命名约定；
`bundle.icon` 里只列了 `icon.ico` 和 `icon.png`）。

手写编码而不引库，因为 windres 只认未压缩的 DIB。`toBmpIconImage` 产出 `BITMAPINFOHEADER`（40 字节，
`biHeight` 写成 `size * 2` 好让 AND 掩码占位）+ 32bpp BGRA 像素（自底向上）+ 1bpp AND 掩码（alpha < 128 的
那些位置置 1）。`toIco` 再拼 ICONDIR / ICONDIRENTRY，256 那档的宽高字节写 0。PNG 那侧同样手搓：`crc32`
自己算，`pngChunk` 自己发，IDAT 走 `deflateSync`。

图形只在 `raster` 一处定义，坐标全部归一化到 0..1，所以任何尺寸都是同一个形状：圆角方块 `half = 0.46` /
`radius = 0.2` / 羽化 `0.012`；蓝色渐变按 y 从 `rgb(37,99,235)` 走到 `rgb(49,123,215)`，再叠一层左上高光
（中心 `0.3, 0.24`、半径 `0.95`）。白色大写 F 的骨架常数是 `F`：三笔同宽 `weight = 0.13`，竖笔
`x 0.25..0.38` 贯通 `y 0.15..0.85`，上横到 `x 0.75`、中横到 `x 0.67` 落在 `y 0.42..0.55`。

矢量母版 `src-tauri/icons/icon.svg` 不由这个脚本生成，它手工维护，标题栏直接引它。改字形要改母版、改 `F`
那组常数、再跑一次脚本。两处同源的数值对照见
[../features/shell-layout/tool-window-icons.md](../features/shell-layout/tool-window-icons.md)。

## make-file-icons.mjs：文件图标数据

`node scripts/make-file-icons.mjs` 读两级数据源，产出 `src/lib/fileIconData.ts`，文件头写着「生成文件 ·
禁止手改」。两级来源是 IDEA 优先、material 兜底：

- `scripts/idea-icons/`：`mappings.json` + `expui/**` + `language/**` 的 SVG，移植自 IntelliJ（Apache 2.0），
  授权统一落在 `scripts/idea-icons/LICENSE.txt` 与 `NOTICE.txt`。
- `node_modules/material-icon-theme`（devDependency，当前 5.39.0）：`dist/material-icons.json` 的
  `fileExtensions` / `fileNames` / `iconDefinitions`，补 IDEA 没有的那些（`package.json`、`pom.xml`、
  `yarn.lock`）。找不到这个 JSON 就抛错，要先 `npm install`。

做法四条：

- `listSvgs` 递归列出所有 `.svg`，按文件名后缀 `_dark.svg` 分浅色 / 深色两张表：深色表沿用带后缀的
  原文件名当键，所以前端查深色版要先给路径补上 `_dark` 再查，缺项时才回退到浅色那份。
- `compact` 剥掉 XML 注释与 `<title>`、去掉换行、把 `>\s+<` 压成 `><`。行上已经有 tooltip，装饰图标不该再带
  `title`；JetBrains 的版权注释每份都重复，压掉省体积。
- IDEA 映射里指向通用图标（`defaultFile` / `unknown`）的条目不算「有这个类型的专属图标」，跳过，让 material
  的专属图标补上来，否则 `avi`、`mp4` 会一直顶着灰色文本图标。material 的图标键统一加 `material/` 前缀，
  和 IDEA 那套隔开。
- material 的键分两张表装：单段扩展名进 `EXTENSION_ICONS`，含点的多段后缀（`d.ts`、`schema.json`）进
  `SUFFIX_ICONS`。单段表只取最后一个点之后，`foo.d.ts` 匹配不到 `d.ts`，所以查的顺序是完整文件名 → 多段后缀
  → 单段扩展名（`src/lib/fileIcons.ts` 的 `resolveIconPath`）。目录名只认 IDEA 那份（`mappings.folders`），
  不接 material 的目录映射，目录图标保持 IDEA 一套。

当前产物实测：`EXTENSION_ICONS` 1178 条、`SUFFIX_ICONS` 212 条、`FILE_NAME_ICONS` 2148 条、`FOLDER_ICONS`
9 条，浅色 647 张、深色 58 张，文件 844556 字节（约 0.8 MB）。缺省文件图标是 `expui/fileTypes/text.svg`，
缺省目录图标是 `expui/nodes/folder.svg`。升级上游 = 替换 `scripts/idea-icons/` 下的 SVG 与映射表，或升级
material-icon-theme，再跑一次脚本，不手改产物。运行期是懒加载的独立 chunk：`src/main.tsx` 在界面挂载后调
`ensureFileIcons()`，`src/lib/fileIcons.ts` 里动态 import 该模块，首屏不等它；数据到位前先画单色占位，到位后
订阅者重渲染成彩色。

## cdp-\*.mjs：WebView2 远程调试端口

这一族 7 个脚本做的是同一件事：连上正在跑的窗口，读或动真实 DOM，不依赖桌面截屏权限。

前置条件只有一个，脚本不代设：启动前带上环境变量
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 再跑 `npm run tauri:dev`。端口从
`FORGE_CDP_PORT` 读，缺省 9222；`cdp-console.mjs` 额外允许把端口当第一个命令行参数。每个脚本都先
`fetch http://localhost:9222/json/list`，挑 `type === "page"` 且 url 含 `localhost` 的目标，再连它的
`webSocketDebuggerUrl`。Host 必须写 `localhost`，写 `127.0.0.1` 会被 WebView2 拒成 404。找不到页面目标就
直接退出，并把现有 targets 打出来。

| 脚本 | 干什么 | 用法 |
| --- | --- | --- |
| `cdp-shot.mjs` | `Page.captureScreenshot`（png、`captureBeyondViewport: true`），同时 evaluate 一段状态 JSON：`innerWidth` / `devicePixelRatio` / `document.title` / `.rail-button` 数量 / `.tree-row` 数量 / `localStorage` 里的 `forge.workspace` / `.error-banner p` 的文本 | `node scripts/cdp-shot.mjs [输出路径]`，默认写 `D:/app/soft/_download/forge-shot.png` |
| `cdp-console.mjs` | `Runtime.enable` + `Log.enable` + `Page.enable`，然后 `Page.reload`，攒 4 秒的 `consoleAPICalled` / `exceptionThrown` / `Log.entryAdded` 再一次性打印 | `node scripts/cdp-console.mjs [端口]` |
| `cdp-eval.mjs` | `Runtime.evaluate`，`returnByValue` + `awaitPromise`；`--click <选择器>` 是内置的一段 `el.click()`，没匹配到回 `NO_MATCH` | `node scripts/cdp-eval.mjs "document.querySelector('.x').textContent"` |
| `cdp-key.mjs` | 发一次带修饰键的按键，验的是真键位绑定；末尾打印 `code` / `vk` / `modifiers` | `node scripts/cdp-key.mjs "Ctrl+Shift+A"` |
| `cdp-type.mjs` | `Input.insertText` 整段落字，和真实打字一样进输入框；`--enter` 再补一次回车 | `node scripts/cdp-type.mjs "文本" [--enter]` |
| `cdp-wheel.mjs` | 先 evaluate 取元素中心，`mouseMoved` 后连发 3 次 `mouseWheel`（间隔 120ms） | `node scripts/cdp-wheel.mjs <选择器> <deltaY>`，默认 `-300` |
| `cdp-rightclick.mjs` | `Input.dispatchMouseEvent` 的 press/release，浏览器自己合成 `contextmenu`；取点时纵坐标最多往下偏 40px | `node scripts/cdp-rightclick.mjs <选择器> [--left] [--press\|--release]` |

三条限制都写在脚本注释里：

1. `cdp-key.mjs` 只发 `rawKeyDown` / `keyUp` 不产生 DOM 的 `input` 事件，monaco 的 textarea 收不到字符。
   往输入框落字的那一档叫 `char`，`keyPress` 不是合法类型、发了会被丢，且 `char` 只在无修饰键时补发。
2. 中间那档 vk 不能给 `?? 0` 兜底：那样字母键的 `windowsVirtualKeyCode` 全是 0，浏览器认不出按的哪个键，
   monaco 的 `CtrlCmd|KeyS` 这类匹配永远不会触发。F 键是 `111 + 序号`，字母取 `code` 第 4 个字符的码点，
   数字取 `48 + 值`。修饰位掩码是 alt=1 / ctrl=2 / meta=4 / shift=8，`cmd` 当 meta。
3. `cdp-rightclick.mjs` 的 `--press` 只按下不松开：松开那一下会被菜单自己的「点外面就关」逻辑立刻吃掉，
   看完结果再单独 `--release` 收尾。`--left` 存在的理由是左键真能把焦点放进编辑器。

## 代码

| 文件 | 内容 |
| --- | --- |
| `scripts/make-icons.mjs` | 尺寸常量 `:4-5`、输出目录 `:7`、`crc32` `:9-19`、`pngChunk` `:21-28`、`toPng` 的 IDAT `:30-48`、`F` 骨架常数 `:68-76`、`raster` `:82-126`、`toBmpIconImage` 的 DIB 与 AND 掩码 `:129-159`、`toIco` 与 256 那档写 0 `:161-181`、四个写出 `:183-188` |
| `scripts/make-file-icons.mjs` | 两级来源的说明 `:1-15`、路径常量与 material JSON `:19-23`、`mappings.json` `:25`、`listSvgs` `:28-36`、`compact` `:38-50`、深浅两张表 `:52-59`、`IDEA_GENERIC` `:61-65`、material 缺失抛错 `:67-73`、`material/` 前缀 `:75-76`、扩展名与后缀分表 `:91-108`、`fileNames` `:110-118`、目录只认 IDEA `:120-122`、产出模板与各张表 `:124-156`、写出与统计 `:158-163` |
| `scripts/run-rust.mjs` | PATH 补齐与 `spawnSync` `:4-14` |
| `scripts/cdp-shot.mjs` | 前置与端口 `:1-6`、localhost 那条约束 `:8-14`、截图与状态 JSON `:38-42` |
| `scripts/cdp-console.mjs` | 端口参数 `:3`、三个 enable 与 reload `:50-53`、4 秒窗口 `:54` |
| `scripts/cdp-eval.mjs` | 用法与 `--click` `:1-15`、`returnByValue` / `awaitPromise` `:31-37` |
| `scripts/cdp-key.mjs` | 修饰位掩码 `:10`、VK 表 `:11-16`、`code` 的推导 `:27-37`、vk 不做 0 兜底 `:39-48`、`char` 那一档 `:78-83` |
| `scripts/cdp-type.mjs` | `--enter` 参数 `:4-6`、`insertText` 与补回车 `:40-45` |
| `scripts/cdp-wheel.mjs` | `deltaY` 默认 `-300` `:5`、取元素中心 `:39-48`、3 次滚轮与 120ms 间隔 `:49-61` |
| `scripts/cdp-rightclick.mjs` | `--press` / `--release` 的说明 `:1-8`、取点 `:48-55`、press / release 的发送 `:57-63` |
| `src-tauri/icons/icon.svg` | 矢量母版，手工维护，不由脚本生成 |
| `src/components/TitleBar.tsx` | 引 `icon.svg` `:5` |
| `src/lib/fileIcons.ts` | 懒加载与订阅 `:24-48`、解析顺序 `:62-83`、深色回退浅色 `:91-95` |
| `src/main.tsx` | 挂载后 `ensureFileIcons()` `:32-34` |
| `package.json` | `material-icon-theme` 依赖 `:36`、两条 npm 脚本 `:12-13` |
| `src-tauri/tauri.conf.json` | `bundle.icon` 列的两项 `:41` |
