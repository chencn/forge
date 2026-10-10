# 托盘与窗口生命周期

托盘图标和点关闭按钮之后的处理。Rust 侧 `src-tauri/src/tray.rs` 决定拦不拦这次关闭，前端
`src/lib/window.ts` 和 `src/App.tsx` 负责存盘和回话。

## 托盘

托盘在 `setup` 里由 `tray::build` 建。图标 id 是 `forge-tray`，图形直接用打包进去的
`default_window_icon()`，因此不必为托盘额外带一份图片解码依赖。tooltip 是 `Forge`。菜单两项，id 分别是
`show` 和 `quit`。

- 左键：`show_menu_on_left_click(false)`，`TrayIconEvent::Click { button: Left, button_state: Up }` 触发
  `reveal`。左键不挂菜单，否则点图标弹出来的是菜单而不是窗口，托盘应用的常规做法是把恢复窗口留给左键。
  `reveal` 取 `main` 窗口，依次 `unminimize`、`show`、`set_focus`，窗口不在就直接返回。
- 右键菜单：`show` 走 `reveal`，`quit` 走 `quit_now`。

菜单文字是 `MenuItem::with_id` 时写死的英文字面量 `Show Forge` 和 `Quit`。菜单由系统画，走不到前端那套
i18n，所以另开一条 `tray_labels` 命令，把当前语言的两条文案推进去，`t` 一变就重推。中文是「显示主窗口 /
退出」。前端封装 `setTrayLabels` 忽略失败：纯浏览器预览时没有这条命令，托盘文案取不到不该影响界面渲染。

## 点关闭之后

标题栏的关闭按钮走 `useWindowControls` 的 `dismiss`，调 `win.close()`，权限是 `core:window:allow-close`。
事件落到 Rust 的 `WindowEvent::CloseRequested`，转给 `handle_close`。它第一步就调 `settings::read` 重新读盘：
这条路上没有可信的前端 state，能依赖的只有那份永远和界面同步的文件（见 `../settings/`）。判定次序写死：

1. `closeBehavior` 是 `tray`：`prevent_close()` 加 `window.hide()`，然后直接 return。窗口不见了，进程还在：
   终端的 reader 线程、文件监听的转发线程、跑着的运行会话都在后台继续运行，细节见 `../terminal/`、
   `../run/`、`../workspace-watch/`。这条分支不看 `saveOnExit`，`return` 在它前面。默认那档
   `savePolicy: "blur"` 会在窗口失焦时先把脏文档存掉，所以通常看不见差别；选了 `manual` 就什么都不写，
   回到窗口时改动还在。
2. 否则（`quit`）如果 `editor.saveOnExit` 为真：`prevent_close()` 加 `request_flush(app)`。
3. 两条都不成立就不拦，窗口照常销毁；最后一个窗口关掉时应用退出。

出厂默认是 `closeBehavior: "quit"` 加 `saveOnExit: true`，默认走第 2 条：先存再退。托盘菜单的「退出」走
`quit_now`，同一个判定，只是它不需要 `prevent_close`，不用存盘时直接 `app.exit(0)`。

## 退出前强制保存与看门狗

`request_flush` 三件事：

- `FLUSHING` 这个 `AtomicBool` 用 `swap(true)` 去重。上一轮还没回来说明事件已经发出去了，不再重复发，
  否则连点关闭会攒出好几个等待中的退出流程。
- `app.emit("app://flush", ())`。事件名只有这一个，前端在 App 上订阅它。
- 起一条线程 `sleep(FLUSH_TIMEOUT)`，到点检查 `FLUSHING`，仍然是真就 `exit(0)`。看门狗在 Rust 侧而不是
  前端：前端挂了、事件没人应答、`saveAll` 卡住，这三种情况都照样退出，不会关不掉。上限 5 秒。留这么多
  是因为一次写盘本身是毫秒级的事，5 秒是给大文件和慢磁盘的余量。

`app_exit` 命令把 `FLUSHING` 置回 false 再 `app.exit(0)`。

前端这一侧：收到 `app://flush`，`await docs.saveAll()`，然后 `appExit()`。`saveAll` 只写非只读且
`contents !== baseline` 的文档，串行而不是并发：同一份文件可能被两个入口碰到，写盘顺序乱了磁盘上就是
半新半旧。这条路不需要前端回话确认，5 秒的超时兜住没有回音的情况；也不弹框问人，存完就走。

## 保存相关的两个设置项

界面上是两行两个控件，不是一个三值下拉：

| 界面 | 存进文件的键 | 值 |
| --- | --- | --- |
| 代码保存策略 | `editor.savePolicy` | `manual` / `blur`。文件里写了别的值，前端 `merge()` 退回 `blur` |
| 退出前保存未保存的改动 | `editor.saveOnExit` | 布尔，下拉给的是 是 / 否 |

生效点：`blur` 那档挂的是 `window` 的 `blur` 事件，窗口一失焦就 `saveAll()`；`saveOnExit` 是上面那条 flush
流程的开关（`wants_flush` 只看它）。`manual` 下只有 Ctrl+S。Ctrl+S 绑在 monaco 的命令里，存的是当前文档，
所以不管选哪档、选 tray 还是 quit，只要编辑器有焦点它都照样当场存。光标在终端或目录树里时按下去没有效果。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src-tauri/src/tray.rs` | `FLUSHING` 与 `FLUSH_TIMEOUT` `:23-26`、`build` `:35-65`、`tray_labels` `:68-76`、`handle_close` `:79-90`、`quit_now` `:93-99`、`wants_flush` `:101-103`、`request_flush` 与看门狗 `:106-119`、`app_exit` `:122-126`、`reveal` `:128-135` |
| `src-tauri/src/lib.rs` | `setup` 里建托盘 `:17-20`、`CloseRequested` 转给 `handle_close` `:22-26`、命令注册 `:100-103` |
| `src/lib/window.ts` | `setTrayLabels` `:14-16`、`appExit` `:19-21`、`useWindowControls` 与 `dismiss` `:30-56` |
| `src/components/TitleBar.tsx` | 关闭按钮 `:111-118` |
| `src/App.tsx` | 托盘文案重推 `:297-300`、失焦自动保存 `:302-308`、`app://flush` 监听 `:310-318`、`saveActive` `:481-486` |
| `src/hooks/useDocuments.ts` | `saveAll` 的筛选与串行 `:255-263` |
| `src/components/SettingsPage.tsx` | 点击关闭那一行 `:124-136`、保存策略与退出前保存两行 `:196-221` |
| `src/components/CodeEditor.tsx` | Ctrl+S 绑定 `:60` |
| `src-tauri/capabilities/default.json` | `core:window:allow-close` `:8` |
| `src/i18n/lang/zh.ts` | 关闭行为与保存策略文案 `:165-172`、托盘两条文案 `:175-176` |
| `src-tauri/src/term.rs` | reader 线程与 `read_loop` `:215`、`:220-248` |
| `src-tauri/src/watch.rs` | 监听转发线程 `:69` |
