# 文件侧与监听侧的四条边界

**状态**：`待做`。第 3 条可直接动手，第 1、4 条要先拍取舍，第 2 条已经落地。
**涉及模块**：`file-explorer`、`workspace-watch`、`settings`；后端 `src-tauri/src/fs/mod.rs`、
`src-tauri/src/fs/windows.rs`、`src-tauri/src/watch.rs`、`src-tauri/src/settings.rs`。
**阻塞点**：第 1 条缺一个跨平台的「送进回收站」决定，第 4 条缺「排除清单从哪来」的决定。
第 3 条没有分歧，只是没人动手。

## 一、删除不进回收站

现状：`delete_entry` 是 `fs::remove_file` / `fs::remove_dir_all`。确认框三条文案都写着「此操作无法撤销」
（单条、多条、目录）。目录树的多选删除和提交窗口删未跟踪文件走的是 App 里同一个 delete 分支，
每条删完 `dropDocument`，这批清完重读目录树。

方案：命令签名不动，后端内部换实现，`platform::trash(path)`。Windows 侧和现有 `ShellExecuteW` 是同一套裸 FFI：
在 `fs/windows.rs` 那个 `#[link(name = "shell32")]` 块里补 `SHFileOperationW`，`wFunc = FO_DELETE`，
`fFlags` 带 `FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI`，`pFrom` 是双 NUL 结尾的
宽字符（现有 `wide()` 正好用），返回非 0 视为失败。不引 `windows` crate，理由和现有做法一致（见
[../../backend/toolchain.md](../../backend/toolchain.md) 依赖面那一节）。unix 侧没有可靠的通用 API：
macOS 要 AppleScript 喊 Finder，Linux 看桌面环境有没有 `trash-cli`。倾向 unix 继续硬删，
但确认框文案按平台分开写，不在 mac 上说「会进回收站」。

待定：
- 整棵目录树送回收站可能很慢。`SHFileOperationW` 的进度 UI 能不能被 `FOF_SILENT` 完全压掉要实测；
  压不掉就要考虑后台线程删、先不等结果，但那和「删完立刻重读目录树」的现有配合相冲。
- 失败时降级硬删还是报错：倾向报错。静默降级成不可撤销的删除风险最大。
- 要不要在设置里给一档「删除方式：回收站 / 直接删除」，让脚本产物那种一次性海量文件能选快路。

验收：删一个文件 → 回收站里有它、原路径消失、目录树不再列它。删一个包含只读文件的目录 → 不弹系统框、
不报错（`FOF_WANTNUKEWARNING` 不给）。

## 二、隐藏项过滤开关（已落地）

落成的形状：
- 设置项在 `settings.explorer`，两项：`showHidden`（默认关）与 `showIgnored`（默认开）。
  `ExplorerSettings` 带 `Default`，`Settings` 上是 `#[serde(default)]`，旧文件缺字段自动补默认值，不做迁移。
  写法照同一文件里的 `BranchSettings`。
- 开关摆在设置页「通用」那一栏，两条各一个 Select。资源管理器头部的眼睛按钮跳到设置页，
  不是就地弹层。
- 过滤在前端：`ExplorerTree` 的 `visible` 先判 `!showHidden && entry.isHidden`，再判忽略项；
  被过滤的目录连整棵子树一起不列。
- 后端不裁。`list_directory` 照实返回隐藏项，`isHidden` 在 Windows 取 `FILE_ATTRIBUTE_HIDDEN |
  FILE_ATTRIBUTE_SYSTEM`，类 unix 认点开头的文件名；`hidden_items_are_reported_not_filtered` 那条测试钉的就是这件事。
- 语义走 IDEA 的单条布尔，不是 VSCode 的 `files.exclude` 规则列表。规则列表要有 glob 匹配，
  还要和第四条的监听排除合并成一份才不重复，成本不是一个量级。

剩一件收尾：`docs/features/file-explorer/README.md` 的边界段落还写着「没有过滤开关」，要改成上面这一条。

## 三、新建同名文件会把已有文件截成空的

现状：`create_file` 用 `fs::File::create`，这是 truncate 语义。前端那条调用不查重，直接
`createFile(joinPath(dir, name))`。同文件里的 `rename_entry` / `copy_entry` / `move_entry` 三条都先撞名报
`TARGET_EXISTS`；粘贴撞名也不覆盖，把「已经存在」报回去让人换名，注释写的理由是覆盖找不回来。
四条里只有新建这一条漏了，前后不一致。

方案：一条前置判断，和 rename 完全一致。

```rust
if Path::new(&path).exists() { return Err(err("TARGET_EXISTS", &path)); }
```

文案现成（`error.targetExists`「「{path}」已经存在」），不用加代码、不用改前端。这条没有设计分歧，
列在这里只因为它是删改同类里唯一漏的那个。

验收：新建 `a.txt` 时目录里已有非空 `a.txt` → 报错、原文件字节数不变、树不刷新出一个空文件。

## 四、监听整棵递归，`node_modules` 也触发

现状：`RecursiveMode::Recursive`，没有任何排除。去抖 150ms（`SETTLE`），单批最多 256 条路径（`BATCH_CAP`），
`soak` 攒满就把剩下的路径丢掉。后果不是逐条处理，而是每次刷新都重跑一遍 `refreshTree()` + `git.refresh()`，
前端还多并一次 120ms（`COALESCE_MS`）。`docs/features/workspace-watch/README.md` 写的「只是重读目录与
git 状态，不逐条处理」是真的，但一次 `npm install` 能连着重读几十轮。

方案：在后端过滤，不在前端。前端拿到的是已经并好批的 256 条，真正的开销（notify 回调、通道、`BTreeSet`
插入）已经花在前端看不见的地方。落点是在 `soak` 之前加一次路径前缀判定，命令签名扩成
`fs_watch_start(root, exclude: Vec<String>)`，参数从前端来，前端知道当前工程根。`.git` 可以放心排掉：
git 状态刷新走写操作后的显式 `git.refresh()`，不依赖监听。

待定：排除清单的来源，三条路。
(i) 后端写死 `node_modules` / `.git` / `target` / `dist`。
(ii) 读 `.gitignore`。要引 crate，而且「被忽略」不等于「不该刷新」，构建产物恰恰是要看的。
(iii) 复用设置里那栏排除规则。这和第二条的隐藏项开关是同一处 UI，但要先在布尔与规则列表之间定下来。
倾向 (i) 加一个 `exclude` 入参：清单由前端给，前端先用那份写死的，决定权留给调用方。

验收：`npm install` 期间状态条的改动计数不闪；改一个 `src/**` 下的文件仍然一次刷新都不少。
反向验收更要紧：删掉 `node_modules` 里某个被 markdown 引用的图片，不需要它触发任何东西。
「排除了就永远不报」与「排除了只是不报路径」的差别要在监听语义上写清。现在报来的整批路径只喂给文档判定，
树和 git 状态本来就是整份重取，所以丢弃路径不丢正确性。

## 出处

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `src-tauri/src/fs/mod.rs` | `delete_entry` 的 `remove_dir_all` / `remove_file` | `:328-340` |
| `src-tauri/src/fs/mod.rs` | `create_file` 的 `File::create` | `:272-276` |
| `src-tauri/src/fs/mod.rs` | `rename_entry` / `copy_entry` / `move_entry` 的撞名判断 | `:280-282`、`:306-308`、`:317-319` |
| `src-tauri/src/fs/mod.rs` | `list_directory` 不裁隐藏项；`hidden_items_are_reported_not_filtered` | `:150-192`、`:421-439` |
| `src-tauri/src/fs/windows.rs` | `#[link(name = "shell32")]` 块、`wide()`、隐藏位判定 | `:19-30`、`:34-40`、`:7-8`、`:46-60` |
| `src-tauri/src/fs/unix.rs` | 点开头文件名判隐藏 | `:5-20` |
| `src-tauri/src/settings.rs` | `ExplorerSettings` 与 `Default`；`Settings` 的 `#[serde(default)]` 与字段 | `:100-115`、`:118-122`、`:140` |
| `src-tauri/src/watch.rs` | `SETTLE` 150ms、`BATCH_CAP` 256、`interesting` | `:19`、`:22`、`:38-44` |
| `src-tauri/src/watch.rs` | `fs_watch_start` 与 `RecursiveMode::Recursive`；`pump`、`soak` | `:46-73`、`:66`、`:82-103`、`:105-112` |
| `src/hooks/useFileWatch.ts` | `COALESCE_MS` 120ms、前端再并批、`watchWorkspace(root)` | `:6`、`:26`、`:28-41` |
| `src/lib/fs.ts` | `watchWorkspace` 封装 | `:70-73` |
| `src/App.tsx` | `onDiskChange` 三处一起补 | `:351-362` |
| `src/App.tsx` | 新建文件、粘贴撞名不覆盖、删除分支 | `:1229-1233`、`:827-831`、`:1280-1292` |
| `src/App.tsx` | 眼睛按钮跳设置页；两个开关传进树 | `:1916-1924`、`:2012-2013` |
| `src/components/ExplorerTree.tsx` | `visible` 的两个开关与整棵子树一起藏 | `:26-29`、`:153-156`、`:183` |
| `src/components/SettingsPage.tsx` | 「通用」栏里那两条 Select | `:145-169` |
| `src/i18n/lang/zh.ts` | 三条「此操作无法撤销」文案、`error.targetExists` | `:46-48`、`:63` |
| `src/lib/errors.ts` | `TARGET_EXISTS` 映射 | `:45` |
| `docs/features/file-explorer/README.md` | 「没有过滤开关」那句，待改 | `:11` |
| `docs/features/workspace-watch/README.md` | 「没有 ignore 名单」那句 | `:34` |
