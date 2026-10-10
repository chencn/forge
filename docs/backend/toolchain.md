# 工具链与构建约束

这一层记的是配置约束。改动前先读，别按「通常的 Tauri 项目」改回去。

## GNU 工具链与 crate-type

`src-tauri/Cargo.toml` 的 `crate-type` 只能是 `["rlib"]`。加上 `cdylib` 之后 GNU ld 报
`export ordinal too large: 91796`，PE 导出表的上限是 65535 个序号。桌面端不需要导出符号：`main.rs` 直接
`forge_lib::run()`，把这个 rlib 静态链接进唯一的可执行文件，走普通 exe 那条路，没有导出表这回事。这个库
存在的意义就是被 `main.rs` 链接。真要产 DLL（比如给别的宿主用）才需要换 MSVC 工具链，那时这条限制才值得
重开。

`main.rs` 顶部那条 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` 让 release 版不附
控制台窗口，调试构建留着控制台。

## windres 与构建机依赖

`src-tauri/build.rs` 除了 `tauri_build::build()` 还有 `link_manifest_into_tests()`，见下一节。
tauri-build 在 Windows 上要把 `src-tauri/icons/icon.ico`（`bundle.icon` 列了它和 `icon.png`）编进 PE 资源段，
这一步调 windres。构建机需要完整的 MinGW-w64 GCC 工具链：`gcc` / `windres` / `dlltool` / `ld` 四条齐备，
rustup 的 host 是 `stable-x86_64-pc-windows-gnu`，实际 target triple 是 `x86_64-pc-windows-gnu`。缺 windres
时构建直接失败，不只是缺图标。PATH 是 User 级改的，要新开终端才生效。

## 测试二进制的加载期失败

两道坎各自独立。

DLL 搜索路径：`cargo test` 生成的测试可执行文件落在 `src-tauri/target/debug/deps`，`WebView2Loader.dll`
却只复制到 `target/debug`。`scripts/run-rust.mjs` 把 `target/debug` 拼到 PATH 前面再
`spawnSync("cargo", …)`。那条 `shell: process.platform === "win32"` 是因为 Windows 上 cargo 是 `cargo.exe`，
并且要让 PATH 改动被子进程继承。

清单声明：`tauri_build` 那份资源进不了测试二进制，系统就把 `comctl32.dll` 解析成 v5，而 `tao` / `muda` 要
只有 v6 才有的 `TaskDialogIndirect`，进程在装载阶段直接以 `STATUS_ENTRYPOINT_NOT_FOUND` 退出，一个用例都
跑不起来。`build.rs` 的 `link_manifest_into_tests()` 补这一层：只在设了 `FORGE_TEST_MANIFEST` 且 target 以
`pc-windows-gnu` 结尾时做。它写一份 `test-manifest.rc`（`1 24`，即 `CREATEPROCESS_MANIFEST_RESOURCE_ID` 和
`RT_MANIFEST`），用 `WINDRES`（可用该变量覆盖，缺省 `windres`）编成 coff，再用 `cargo:rustc-link-arg`
交给链接器。正式的 `tauri dev` / `tauri build` 不设这个变量，清单仍由 `tauri_build` 一份给全，不重复。

`npm run test:rs` 也不设这个变量，要跑测试得自己带上：

```bash
FORGE_TEST_MANIFEST=1 npm run test:rs
```

跑这条要先等另一侧构建结束：`target/debug` 被占时 build script 报
「另一个程序正在使用此文件，进程无法访问。 (os error 32)」。全绿与否没在本机复核过，日常验证仍按编译通过算：

```bash
cargo check --tests --all-targets   # 在 src-tauri/ 下，或 npm run check:rs
```

测试代码写了 37 条，只碰纯函数和临时目录：

- `fs/mod.rs` 6 条：目录排在文件前、隐藏项照实返回、新建改名删除往返、列文件当错误、CRLF+BOM 往返（含
  非 UTF-8 给 `NOT_UTF8`、含 NUL 给 `BINARY` 两条断言）、根目录没有父目录。
- `fs/search.rs` 17 条：名字打分四档、`*` 通配的开头 / 结尾 / 中段锚定、`fileMask` 空值当不限、大小写折叠
  不移列号、整词只放独立那次、正则列号按字符数、坏正则是错误不是空结果、长行按首处命中裁、BOM 只在开头剥、
  `container` 的相对路径与正斜杠、`page_limit` 的缺省与上限、按名结果的排序、构建目录被剪掉、二进制跳过且
  同一文件只计一个 `files`、`fileMask` 与 `truncated`、一行多处命中合成一条、空词回空表。
- `git/mod.rs` 14 条：全在解析函数上（`parse_status`、`parse_refs`、`parse_log`、`merge_file_lists`、
  `split_rename`），另有那条「日志里每条哈希都能当修订号用」的断言打在 `valid_rev` 上。

## 链接期的 manifest 告警

带 `FORGE_TEST_MANIFEST` 链接测试二进制时会刷一句
`ld.exe: .rsrc merge failure: multiple non-default manifests`。那是 rustc 自带的默认清单和这份合并时的提示，
`build.rs` 的注释把它记为正常告警，测试二进制照样能起。正式的 dev / build 不设这个变量，也就没有这第二次
合并。看到这句别去关资源段，那会让 exe 没有图标。

## npm 脚本的展开

`package.json` 的九条：

| 脚本 | 展开 | 说明 |
| --- | --- | --- |
| `dev` | `vite` | 只起前端。能在浏览器里看布局和配色，但 `invoke` 全部会失败（没有 Tauri 注入），`src/lib/window.ts` 的窗口动作按这条做了容错 |
| `build` | `tsc --noEmit && vite build` | 先类型检查再打包到 `dist/` |
| `preview` | `vite preview` | 静态预览 `dist/`，同样没有后端 |
| `check:ts` | `tsc --noEmit` | 只做类型检查，不出产物 |
| `test:rs` | `node scripts/run-rust.mjs test --lib` | 见上一节，要带 `FORGE_TEST_MANIFEST` 才编得出清单 |
| `check:rs` | `node scripts/run-rust.mjs check` | 日常验证用的就是它 |
| `tauri` | `tauri` | CLI 直通 |
| `tauri:dev` | `tauri dev` | 先跑 `beforeDevCommand` 起 Vite，devUrl 是 `http://localhost:1420`，再编 Rust 开原生窗口 |
| `tauri:build` | `tauri build` | 先跑 `beforeBuildCommand` 出 `dist/`，再打安装包 |

## release 配置与依赖面

`[profile.release]`：`codegen-units = 1`、`lto = "thin"`、`strip = "symbols"`。`edition = "2021"`，
`rust-version = "1.80"`。依赖 9 条：`tauri`（带 `tray-icon` 与 `protocol-asset` 两个特性，后者是本地图片进
webview 的前提，见 [README.md](./README.md) 的 asset 一节）、`tauri-plugin-dialog`、`serde`、`serde_json`、
`portable-pty 0.9.0`、`base64 0.23.1`、`notify 8`、`regex 1`、`walkdir 2`。后两条给工作区搜索用，
`Cargo.toml` 的注释写明它们已经在依赖树里，不额外下载。

没有 `windows` / `winapi` crate，所有 Win32 调用都是 `extern "system"` 裸声明：
`fs/windows.rs` 的 kernel32 两个函数和 shell32 的 `ShellExecuteW`，`sys.rs` 的
`K32GetProcessMemoryInfo` 与 `GlobalMemoryStatusEx`。多一个绑定期就多一处和 GNU 工具链的摩擦面，这里只需要
三四个函数。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src-tauri/Cargo.toml` | `crate-type` 与那句注释 `:8-11`、依赖与 `protocol-asset` 注释 `:16-27`、`[profile.release]` `:29-32` |
| `src-tauri/src/main.rs` | `windows_subsystem` 那条 `:1`、`forge_lib::run()` `:3-5` |
| `src-tauri/build.rs` | `tauri_build::build()` `:1-4`、注释里的 v5/v6 与 `TaskDialogIndirect` `:6-16`、`link_manifest_into_tests` `:17-68`、清单文本与 `1 24` `:33-48`、`WINDRES` 与 `cargo:rustc-link-arg` `:54-67` |
| `scripts/run-rust.mjs` | PATH 那段注释与拼接 `:4-7`、`spawnSync` 的 `cwd` / `env` / `shell` `:9-14` |
| `src-tauri/tauri.conf.json` | `bundle.icon` `:41`、`build` 那四条 `:6-11` |
| `src-tauri/src/fs/search.rs` | `regex` 的用点 `:272-364`、`walkdir` 的扫描配置 `:50-58`、17 条单测 `:551-794` |
| `src-tauri/src/fs/windows.rs` | kernel32 / shell32 的裸声明 `:12-29` |
| `src-tauri/src/sys.rs` | kernel32 的两个函数 `:45-53` |
| `src-tauri/src/fs/mod.rs` | 6 条单测 `:385-534` |
| `src-tauri/src/git/mod.rs` | 14 条单测 `:1538-1727` |
| `package.json` | 九条脚本 `:7-17`、`material-icon-theme` 是 devDependency `:36` |
| `src/lib/window.ts` | 纯浏览器下的容错 `:33-49` |
