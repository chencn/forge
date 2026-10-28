# 内置浏览器

Windows 上由宿主持有一块原生 WebView2 页面，用户看得见，AI 也能操作，每一步都按「哪个工程、哪个会话、哪一张页」这三层身份授权。设计动机、参考项目对比与完整目标见 [../../plans/browser-use/](../../plans/browser-use/)，本文只写已经跑起来的那部分怎么运作。命令契约见 [../../backend/commands.md](../../backend/commands.md) 的「内置浏览器（8）」，错误码见 [../../backend/error-model.md](../../backend/error-model.md)。

## 一条链路，两个入口

- 用户这一侧只走八条 `browser_panel_*` 命令，都在 `src-tauri/src/browser/mod.rs`。
- AI 这一侧不走命令。`forge-browser-mcp` 子进程（`src-tauri/crates/forge-browser/`）由 Forge 管理的 Codex / Claude 当 MCP server 起，经 `\\.\\pipe\\forge-browser-<pid>-<nonce>` 命名管道回到宿主。管道用 SDDL 只放当前登录用户，握手带一次性 token 与版本闸，版本对不上直接拒。
- 页面本体是 wry 的 child webview，建 / 显 / 关与 CDP 通道在 `src-tauri/src/browser/surface.rs`。COM 只能在 UI 线程碰，所有原生动作经 `ui()` 排到主线程。那条 closure 在超时之后被标志位拦下、不再派发：已经回给模型「失败」的动作不能事后又跑一遍。

主线程那一侧不读磁盘。批注浮层每次呈现都要查页状态、语言与主题，这些走内存镜像：`sync_capability`（入口那条）与 `settings_saved`（保存那条）把磁盘那份写进 `State`，`panel_tab_mirror` 只读镜像。派发复查早就按这份镜像判，同一条规矩。

## 授权按页、按会话，且随时可撤

`Grant` 三档：`none` 私有、`read` 只读、`control` 可操作。AI 自己新建的页起手就是 `control`，并登记成该会话的工作页；用户手动打开的页起手是 `none`，由用户在权限面板里明确交出去。上传工作区文件、跑任意脚本、回传渲染像素这三样是额外的 cap，默认关，须在设置里分别打开。

两道代际是这套授权真正生效的原因。`revision` 是授权代际，任何改权限、导航、缩放、改样式的动作都把它 +1 并清空 `refs`，在途的 AI 请求据此判死。`epoch` 是文档代际，导航即 +1。AI 手里的元素引用形如 `s{序号}n{backendNodeId}`，只在当前代际里有效，过期回 `BROWSER_PICK_STALE`。

设置里关掉 AI 助手会走 `permissions_changed`：所有页撤权、选取遮罩复位、在途请求作废，不等会话结束。这就是热关闭。

## 地址策略

`navigation_url`（`src-tauri/crates/forge-browser/src/lib.rs`）只认 http(s)、不许内嵌凭据，并拦住元数据、链路本地、未指定、组播与 unique-local 地址。

AI 托管页再多一层：`private_literal_target` 覆盖 RFC1918 与 CGNAT 四段，模型不能自己开一张内网页再读回来。要碰内网只能用户自己浏览完再把那张页共享出去，那道复查是 `managed_private_target`（`src-tauri/src/browser/mod.rs`）。127.0.0.1 与 localhost 保持可用，本机开发页是这个功能的主要用途。

## 起不来只让它自己不可用

`browser::init` 先登记状态再起 broker。管道被拒、随机数失败、companion 版本对不上，原因写进 `State::unavailable`，面板显示「浏览器暂不可用」，`attach` 那侧退回不注入。会话照跑，只是没有浏览器工具。broker 的瞬时连接失败不置停，退避 200ms 再听。

companion 的路径解析走两档（`src-tauri/src/browser/launch.rs`）：先试装机那套带 target triple 的名字 `forge-browser-mcp-x86_64-pc-windows-gnu.exe`，这是 Tauri `externalBin` 实际装出来的样子；再试 cargo 的裸名 `forge-browser-mcp.exe`，那是 `tauri:dev` 下 `target/debug/` 里那个。只认一档的结果是开发能用、装机必坏。

## 文案只在能翻译的那一侧写

后端一律回「稳定码 + 英文原文」，中间是 `SEP`。三个读者各自翻译：面板横幅过 `describeError`（`src/lib/errors.ts` 那张表）；批注浮层是宿主画的第二块 webview，拿不到前端 i18n，`src-tauri/src/browser/annotation.html` 自带一份「码 → 三种语言」的表，认不出的码原样显示；模型那侧不翻译，`dispatch()` 把 `SEP` 换成 `": "`，看到的是 `BROWSER_PICK_STALE: reselect` 这样的 token。同一条错误两份说法，但写中文的地方只有前端。

## 怎么验

`npm run test:browser`（`scripts/test-browser.mjs`）跑原生回归：起本机 fixture 页面，用 feature `browser-smoke` 编出的 `forge-browser-smoke` 驱动真 WebView2，28 项检查覆盖建页、可信输入、iframe、上传、截图、选取与批注，产物一律写进用户 temp。地址策略的单测跟着 companion 那条走：`node scripts/run-rust.mjs test -p forge-browser`。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src-tauri/src/browser/mod.rs` | `Grant` `:49-55`、`State` `:104`、`settings_saved` `:290`、`init` `:138`、`start` `:147`、`attach` `:230`、`permissions_changed` `:246`、`sync_capability` `:279`、`dispatch` 取码那段 `:417`、`managed_private_target` `:495`、`create` `:428`、八条命令 `:672-994`、`panel_tab_mirror` `:856` |
| `src-tauri/src/browser/surface.rs` | `ui()` 的放弃标志 `:6`、`cdp` `:298`、`show` `:385`、`close` `:449` |
| `src-tauri/src/browser/launch.rs` | `companion()` 两档文件名 `:8`、`environment()` 注入 endpoint 与 token `:69` |
| `src-tauri/crates/forge-browser/src/lib.rs` | `private_literal_target` `:135`、`navigation_url` `:152` |
| `src-tauri/src/browser/annotation.html` | 浮层那份三语言码表与 `error()` `:41` |
