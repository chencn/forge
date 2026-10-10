# 运行：与 IDEA 的对账，以及 Debug

**状态**：`方案一已落地`（多构建体系 + 运行配置模型），`Debug 未定`。
**涉及模块**：`run`（`src/components/RunControls.tsx`、`RunConfigsPage.tsx`、`RunPane.tsx`、
`src/hooks/useRunConfigs.ts`、`useRunSessions.ts`、`src/lib/runConfigs.ts`）、
后端 `src-tauri/src/run/`（`detect.rs` 识别、`store.rs` 存取）与 `proc.rs`（进程通道）。
**读这份的顺序**：先「对账表」看差距在哪，再看「已做」确认落到了哪一层，「未做」是下一刀的候选。

## 背景

`docs/features/run/README.md` 原先记着两条边界：运行面板只列 `package.json` 的 `scripts`，
maven / gradle / cargo 要在终端里手敲；主工具栏只有 运行 / 重跑 / 停止 三颗，没有配置这个概念。
对照 IDEA 还差一层结构——那边「跑什么」是一个和工程同级的对象，这边只是一个脚本名加一行命令。

## 已做

**数据模型**：`RunConfiguration { id, name, kind, command, workingDir, env, generated, pinned,
unavailable, helper }`（`src-tauri/src/run/mod.rs`）。这一份就是 IDEA 那个 `RunConfigurationOptions`
的最小形状：名字、类型、命令行、工作目录、环境变量都有了，参数与 VM 参数没有单独成格（写在命令里）。

**状态分两层**：`useRunConfigs` 对应 RunManager（有哪些、选哪条、最近、钉选），`useRunSessions`
对应 ExecutionManager（跑与不跑、缓冲、退出码）。两层都挂 App，控件与面板都不持有它们。

**识别**（`src-tauri/src/run/detect.rs`）：`pom.xml` / `build.gradle(.kts)` / `package.json` /
裸 `.java` 四类标记起步，模块级递归到 4 层；一路补到二十四族——`go.mod`（含 `wails.json` 的 v2·v3）、
`Cargo.toml`、Python 标志文件（`manage.py` / `pyproject.toml` / `requirements.txt` / `Pipfile`）、
`*.csproj` / `*.fsproj`、`composer.json`、`Gemfile`、`pubspec.yaml`、`build.sbt`、`mix.exs`、
`CMakeLists.txt` / `Makefile`、`build.zig`、`deno.json`、`deps.edn` / `project.clj`、
`stack.yaml` / `package.yaml` / `*.cabal`、`Project.toml`、`conf.lua` / `main.lua`、`Package.swift`，
以及没有构建文件时根上的 `main.py` / `run.sh`。Spring 认的是
`spring-boot-maven-plugin` 或 Boot Gradle 插件——只看到 `spring-boot-starter-*` 依赖不算应用。
Gradle 的主类条目走 `--init-script` 造一个 `JavaExec` 任务，配置名 `<Short>.main()`，和 IDEA 那边
`ApplicationConfiguration.getGeneratedName()` 的拼法一致。`mvnw` / `gradlew` 优先于 PATH 上的
`mvn` / `gradle`。JDK 单文件启动只在没有构建文件、且本机 java ≥ 11 时出条目。
非 JVM 那几族的程序名按裸名存（`go` / `cargo` / `dotnet` / `wails` / `php` / `sbt` / `mix` /
`cmake` / `zig` / `deno` / `stack` / `julia` / `swift` 等），不在 PATH 上就标 `unavailable`，
不走 `${…}` 占位那套。长尾那十几族一律只给起跑那一条，构建 / 测试 / 打包命令不进下拉。

**识别的验收方式**：`C:\Users\shengganbao\Desktop\test` 那套按语言分的语料（25 个语言目录 / 64 个
工程 / 单目录·多模块·常用框架都铺了），根上 `expect.json` 是「该认出什么」。仓库外那个宿主里
`cargo run --bin sweep -- <语料根>` 逐工程跑 `run_detect` 并与期望对账，出「按语言汇总 + 未命中清单 +
零条目工程数」。最新一轮：64 个工程识到 **114 条**，89 项期望未命中 **1 项**（就是「没有
`package.json` 的裸 `.js`」那项，刻意不给），零条目的工程 2 个（那一项加一个纯静态目录）。
只接完 JVM 与 npm 那两族时这三个数是 70 / 74 / 42。

**程序解析**：命令行里存 `${mvn}` / `${gradle}` / `${java}` 占位，起进程那一刻才展开。缺工具时那条
标 `unavailable` 并带原因，界面上不给人点它。

**存取**：`<app_config_dir>/runConfigs.json`，按工程分键，只落用户自己建的条目加 `selected` /
`recent` / `pinned` 三个 id 列表。识别出来的不落盘，重扫会得到。

**控件**：配置下拉 + 运行 / 重跑 / 停止 + 选择下拉里的筛选框、分组（钉选 / 最近 / 类型）、行内 `▶`
与 `⋮` 菜单、底部「编辑程序配置…」与「重新识别」。

**编辑程序配置页**：整页开在编辑器页签里，和设置页同一形态（左侧列表 + 右侧字段），不是弹窗。

**快捷键**：`Shift+F10` / `Ctrl+F5` / `Ctrl+F2` / `Alt+Shift+F10` / `Alt+4`，应用级注册。

**进程通道**：`proc_start(cwd, line, env)` 新增环境变量入参，父环境照常继承。

## 对账表

`●` = 有，`◐` = 形状在但只做了一半，`○` = 没有。IDEA 侧的行号取
`D:\app\code\intellij-community`（本机检出，2026-10 对过）。

| IDEA 有什么 | 出处 | forge | 说明 |
| --- | --- | --- | --- |
| 运行配置是一个对象，能改名、能改命令、能存盘 | `platform/execution/src/com/intellij/execution/actions/RunConfigurationProducer.java:34` | ● | `RunConfiguration` + `runConfigs.json` |
| 从上下文当场生成临时配置（右键一个类「Run 'X.main()'」） | 同上 `:98`、`:207`；命名 `.main()` 见 `java/execution/impl/src/com/intellij/execution/application/ApplicationConfiguration.java:197` | ◐ | 扫描出全部主类列进下拉，不认「当前选中的那个类」优先；配置名同款 |
| 配置列表与最近运行、钉选分开排 | `platform/execution-impl/src/com/intellij/execution/impl/RCInArbitraryFileManager.kt:19`（`.idea/runConfigurations`） | ● | 钉选 / 最近 / 类型三节 |
| 编辑器装订线上那颗 ▶：指着能跑的声明，点一下就跑 | `platform/execution-impl/src/com/intellij/execution/lineMarker/RunLineMarkerProvider.java:220`（`Alignment.CENTER`）、`:237-238`（只有一个动作时点击直接跑）；JVM 那侧给哪两处见 `java/execution/impl/src/com/intellij/execution/application/JvmApplicationRunLineMarkerContributor.java:26-29`；文案 `Run ''{0}''` 见 `platform/execution/resources/messages/ExecutionBundle.properties:305` | ● | 六族有落点：npm 脚本键、Java 主类（类声明与 `main` 各一处）、Spring（继承注解类那两处）、Go `func main`、Cargo `fn main`、Python 入口守卫。构建目标那一类刻意不给——`clean package` 没有「声明它的那一行」 |
| Run / Rerun 是两个动作，重跑先把同一条正在跑的停掉 | `platform/execution-impl/src/com/intellij/execution/impl/ExecutionManagerImpl.kt:166`、`:629`、`:1196`（`TERMINATING_FOR_RERUN`） | ● | 重跑按配置 id 匹配要停的那几条；被重跑停掉的会话报「已停止」不说成失败 |
| 停止一颗按钮管全部在跑的进程，条数写进文案 | `platform/execution-impl/src/com/intellij/execution/actions/StopAction.java:80`、`:139`、`:159` | ◐ | 一次全停、tooltip 带条数；没有那个「停哪几条」的候选清单弹窗 |
| 跑之前先保存所有改动 | `platform/execution-impl/src/com/intellij/execution/runners/DefaultRunProgramRunner.kt:20` | ○ | forge 的保存策略是手动/失焦两档，跑之前不插手 |
| before-run 任务（构建、另存、脚本，可排序） | `platform/execution/src/com/intellij/execution/Executor.java:72` 与 runners 一层 | ○ | 要它得先有「任务」这个概念，现在一条配置只起一个进程 |
| executor 分档：Run / Debug / Cover 各一套 UI | `platform/execution/src/com/intellij/execution/executors/DefaultRunExecutor.java:18` | ◐ | 只有 Run 一档，Debug 见下面方案二 |
| 配置存进工程目录随 git 走（`.run/`、`.idea/runConfigurations`） | `platform/execution-impl/src/com/intellij/execution/RunConfigurationStorageUi.java:165`、`:198-200` | ○ | 存在应用配置目录，按工程分键；不入库、不共享 |
| 类路径由 IDE 算，`ShortenCommandLine` 四种打包方式 | `platform/execution/src/com/intellij/execution/ShortenCommandLine.java:20-29`、`:62-64` | ○ | 见下面「刻意不做」那条 |
| 可选 JRE / 模块路径 / VM 参数 | `ApplicationConfiguration.java:87-89`（`ALTERNATIVE_JRE_PATH` 已废弃） | ○ | 用这台机器上 PATH 里的 java，一工程一档 |
| 各语言体系的运行支持 | community 仓里只有 `plugins/kotlin` 这一支语言插件在树内，Go / Rust / Python / .NET / PHP / Ruby 的运行支持都在外部插件仓库（本仓能看到的只有按语言分目录的 `.env` 支持：`plugins/env-files-support/{go,python,rust}`），平台层不认语言 | ● | forge 认二十四族：npm / Maven / Gradle / Spring / Java 主类 / Go 包 / Wails(v2·v3) / Cargo / Python / .NET·F# / PHP / Ruby / Dart·Flutter / Scala / Elixir / C·C++(CMake·Make) / Zig / Deno / Clojure / Haskell / Julia / Lua / Swift / 裸脚本；只有「没有 `package.json` 的裸 `.js`」是刻意不给 |
| Spring Boot 运行配置与 Run Dashboard 状态列 | community 里没有 Maven 插件也没有 Spring 插件（无 `plugins/maven`、无 spring 目录）；只剩提示装插件的嗅探 `java/java-promo/src/com/intellij/java/promo/FrameworkSuggestionProvider.kt:22-26` | ◐ | 认插件标记出 `spring-boot:run` / `bootRun` 条目；Dashboard 那种按进程归组的面板没有 |
| Gradle 委托运行：`--init-script` 造 `JavaExec` | `plugins/gradle/tooling-proxy/src/org/jetbrains/plugins/gradle/tooling/proxy/Main.kt:150`；长选项见 `plugins/gradle/testSources/.../GradleCommandLineOptionsProviderTest.kt:70` | ● | 同款做法，脚本内容随配置走，起进程前才落盘 |
| 控制台尾部 `Process finished with exit code N` | `platform/execution-impl/src/com/intellij/execution/ExecutionHelper.java:214` | ● | 同一句话，主动停过的写「已被终止」 |
| 控制台输出节流与环形缓冲 | `platform/consoleView/impl/src/com/intellij/execution/impl/ConsoleViewImpl.kt:596`；两路合并的坑见 `ProcessStreamsSynchronizer.java:123` | ● | 8192 字节一块 base64 流给前端 xterm，环形缓冲在 xterm 那侧（`scrollback: 8000` 行） |
| 控制台工具条：Pause Output / Scroll to End / Soft-Wrap / Print / 过滤与超链接 | `platform/execution-impl/src/com/intellij/execution/actions/PauseOutputAction.java:21` | ○ | 只读 xterm，没有那排动作；异常行折叠成可点跳转最接近「超链接」，这边没有 |
| 标准输入：进程能读键盘，还带 SendEOF | 进程通道一层 | ○ | `stdin` 是 null。要交互就去终端 |
| Run Anything（`Alt+Shift+F10` 那层选择器 / 双击 Shift 输入命令） | `platform/execution-impl/src/com/intellij/ide/actions/runAnything/RunAnythingAction.java` | ◐ | `Alt+Shift+F10` 开的是配置下拉带筛选框；不能当场敲一条新命令跑 |
| 键位 | `platform/platform-resources/src/keymaps/$Default.xml`：Run `:572`、Rerun `:1030`、Stop `:556`、ChooseRunConfiguration `:1018`、ActivateRunToolWindow `:931`、Debug `:980` | ● | 五条照抄；`Shift+F9`（Debug）留给方案二 |

## 刻意不做

- **不自己拼 java 命令行**。IDEA 那侧是它自己算 classpath、自己决定 `ShortenCommandLine`，
  前提是有依赖解析和索引。forge 没有，也不该为了跑一个 Spring 应用去装一套。所以「启动应用」在这里
  交给构建工具：`mvn spring-boot:run` / `gradle bootRun`。代价是第一次要下依赖、比 classpath 启动慢，
  改一个类要重跑而不是热重启。
- **Maven 与 Spring 都不在 community 基线里**（上面那行对账是实测：没有 `plugins/maven`，没有任何
  spring 目录，只有一个提示装插件的嗅探）。forge 这一版做的是「认出工程该跑哪条命令」，
  不是「实现 Maven/Spring 集成」。名字和图标长得像 IDEA 的 Ultimate 那套，逻辑上是外一条。
- **不做配置模板、不做继承、不做出错时的 checkBeforeRun**。一个工程几十个配置时才需要那些。

## 未做（下一刀的候选，按改动量排）

1. **正在跑的那条要有活标记**：IDEA 在下拉里给运行中的配置把图标换成带绿点的版本
   （`ChooseRunConfigurationPopup.java:383` → `RunManagerImpl.kt:1276-1279` 的
   `ExecutionUtil.withLiveIndicator`）。这边现在只有行尾那颗红的 `■` 在悬停时才露出来，
   不悬停就看不出哪条是活的。
2. **跑之前先保存**：`docs/features/settings/` 那侧已经有 savePolicy，运行层缺一个调用点。
   做之前先定「失焦自动保存」和「跑前保存」两档不打架的写法。
3. **停止的候选清单**：现在一次全停。`StopAction.java:139`、`:199` 那套「列出在跑的、勾哪几条」
   是它的完整版，会话表已经带 `config`，缺的只是一层弹窗。
4. **下拉里的上下文优先**：装订线那颗 ▶ 已经能「跑眼前这一篇里点到的那一条」，缺的只是
   下拉排序还不看当前编辑器——打开某个带 `main` 的类时，它该排到最前而不是按类型档。
   对账表里 `◐` 那一行缺的就是这半句。
5. **控制台那排动作**：Pause Output、Scroll to End、Soft-Wrap 三个在 xterm 上都有现成开关，
   缺的是宿主工具栏那几颗钮；过滤与超链接要另做。
6. **stdin**：`proc_start` 现在是 `Stdio::null()`，要交互得加一条写入通道和一个 SendEOF。
7. **配置随工程走**：`<工程>/.forge/runConfigs.json` 这类落点，和 `.run/` 是同一个需求。

## 方案二：Debug（DAP）

完全没有，也不在这份里定细节。必须先回答三件事：

1. adapter 从哪来。让用户在设置里填可执行文件路径（`lldb-dap` / `codelldb` / `node --inspect` 那条要个
   intermediary），还是随安装包带一个。这条决定后面所有工作量：带的话打包体积和平台分架构要重算；
   不带的话第一次用就要面对填路径，填错的报错走 `SPAWN` 那类代码。
2. 协议通道和输出通道不能混用。adapter 的 stdout 是协议字节（`Content-Length` 头 + JSON body），
   不能进 `proc://output`。要一个独立的双向通道：起进程、按帧读写，把 `initialize` → `launch` / `attach` →
   `stackTrace` / `scopes` / `variables` → `continue` / `stepIn` / `setBreakpoints` 映射成命令。命令是纯新增，
   但状态是长活的：一次 debug session 要被多个命令操作。进程表那套 `Mutex<HashMap<..>>` 结构可以照抄，
   协议帧的读写循环不行，那是请求与响应配对的，要一张按 `seq` 排的等待表。
3. Monaco 侧没有 DAP 客户端。断点（装订线字形加单击切换）、调用栈、变量表、悬挂求值全要自己接。
   UI 工作量比后端大，而且要新的工具窗口槽位；底部那条槽现在一次只放一块。

最小闭环验收：一个 Node 脚本，能在一个断点上停住、看到一条变量、能单步一次、能停。
这条走不通就不谈 rust 调试支持。

## 出处

本机 IDEA 社区版检出的路径都写在上面那张对账表里（`D:\app\code\intellij-community`，2026-10 逐条 grep 过）。
forge 这侧的实现细节与行号在 `docs/features/run/README.md` 的「代码」表。

| 文件 | 内容 | 行号 |
| --- | --- | --- |
| `src-tauri/src/run/mod.rs` | 数据模型六个类型（含 `RunMarker`） | `:14-133` |
| `src-tauri/src/run/detect.rs` | 边界常量（深度 4、跳过目录、4000 个源文件、JDK 11） | `:47-104` |
| `src-tauri/src/run/detect.rs` | 程序解析：wrapper 优先、PATH 候选、缺工具时的 `unavailable` | `:560-653` |
| `src-tauri/src/run/detect.rs` | maven / gradle / npm / 裸 java 四条分支 | `:655-961` |
| `src-tauri/src/run/detect.rs` | Gradle init 脚本内容与哈希文件名 | `:1033-1059` |
| `src-tauri/src/run/detect.rs` | 装订线落点：行号换算、JSON 键的行、各族入口行 | `:176-241`、`:390-403`、`:1185-1195`、`:1374-1385` |
| `src/lib/runMarkers.ts` | 一行归哪条配置、同一行的取舍、跑不了的不给图标 | 全文 |
| `src/components/CodeEditor.tsx` | 装订线浮层：落点换算屏幕坐标、四个重算时机、点击 | `:132-137`、`:260-287`、`:324` |
| `src-tauri/src/run/store.rs` | 分工程存与 `keepable` 那道筛 | `:72-117` |
| `src-tauri/src/proc.rs` | `proc_start` 的环境变量入参 | `:83-102` |
| `src-tauri/src/sys.rs` | `which_program`（Windows 扩展名候选）与 `capture_text`（`java -version` 在 stderr） | — |
| `src/lib/runConfigs.ts` | 占位符展开与 helper 落盘 | `:96-131` |
| `src/hooks/useRunConfigs.ts` | 配置层：识别、合并、选择、钉选、写盘 | `:33-232` |
| `src/hooks/useRunSessions.ts` | 会话层：`start` 前置检查、`rerun` 按配置 id 停 | `:140-232` |
| `src/components/RunControls.tsx` | 控件为什么在主工具栏、禁用条件怎么算 | `:31-158` |
| `src/App.tsx` | 五条运行快捷键 | `:703-751` |
| `src/lib/errors.ts` | `NO_TOOL` / `NO_JDK` / `JDK_TOO_OLD` / `TOO_MANY_SOURCES` | `:73-77` |
| `docs/features/run/README.md` | 现在的边界陈述（无 Debug、不拼 classpath） | — |
