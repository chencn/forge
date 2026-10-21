# 运行

状态分两层，都挂在 App 上，控件和面板都不拥有它们：`useRunConfigs(workspaceRoot)` 管「跑什么」，
`useRunSessions(configs)` 管「跑成什么样」。主工具栏右侧是配置下拉加 运行 / 重跑 / 停止 三颗按钮，
输出画在底部工具窗口（或编辑器页签）里。「编辑程序配置」开在编辑器页签里，和设置页同一个形态。

## 配置从哪来

三条来源合成一张表（`useRunConfigs` 的 `configs`）：

- **识别**：`run_detect(root)` 扫工程目录出候选。整棵树最多下探 4 层，`node_modules` / `target` /
  `build` / `.git` 这类目录跳过（`detect.rs` 的 `SKIP_DIRS`），源文件读满 4000 个就停手并把
  `TOO_MANY_SOURCES` 报进 `problems`，不静默交一份不全的表说「就这些」。
- **自己建的**：`shell` 类型那几条，存在盘上，可以改可以删。
- **钉选与最近**：只是 id 列表，钉住的排最前，最近按点过的次序排。识别出来的条目也能钉。

识别出来的每一条都带 `generated: true`，界面上不给改本体——构建文件一动它就变，改一份存盘的副本
（「存成自己的一份」）才不会和识别结果打架。

下拉里的次序在识别那一次就定死了，界面只做钉选与体系分组：先按体系（`kind_rank`，前端
`RUN_KIND_ORDER` 必须同序），体系内按运行目录分块（根目录那个空串在最前），块内保持构建文件里的
书写顺序。所以一份 `package.json` 的脚本是连着的一段，次序就是它在文件里写的次序——`npm()` 用文本
扫描那一遍的出现次序定序，不迭代解析出来的 `scripts`：`serde_json::Map` 底下是 BTreeMap，按它迭代
出来的是字母序，两个子项目的 `dev` 会被凑到一起，同一份 `package.json` 的条目反被拆散。

### 各构建体系出什么

| 认到 | 出什么条目 |
| --- | --- |
| `package.json` 的 `scripts` | 每个脚本一条（`npm`），命令是 `<包管理器> run <脚本>`，客户端按 `bun.lock` / `pnpm-lock.yaml` / `yarn.lock` / `package-lock.json` 认，认不出来用 npm；不跑脚本正文，因为 `vite`、`vue-cli-service` 只装在 `node_modules/.bin`，那条 PATH 是包管理器加的。嵌套目录里的 `package.json` 也算；几个子项目都有同名脚本时，界面上按 `<工作目录>: <脚本>` 显示（`configLabel`），条目的 `name` 仍是脚本名 |
| `pom.xml` | 有 `spring-boot-maven-plugin` 时一条 `spring-boot:run`（`spring`），否则一条 `clean package`（`maven`）；再给每个带 `main` 方法的类一条 `compile exec:java -Dexec.mainClass=…`（`java`） |
| `build.gradle` / `build.gradle.kts` | 应用插件在时一条 `bootRun` 或 `run`（`spring` / `gradle`），另加一条 `build`；每个主类一条 `--init-script` 起的 `JavaExec`（`java`） |
| `go.mod` | 每个「`package main` + `func main(`」的目录一条 `go run ./<相对包路径>`（`go`），模块根那条用模块路径末段当名字；库包、`_test.go` 不出条目。嵌在另一份 `go.mod` 下面的目录归那份模块自己管 |
| `wails.json`（v2 与 v3 同一个标志文件） | 一条 `wails dev`（`wails`），并且**这个模块目录以下的 `package.json` 不再出 npm 条目**：那份前端是 `wails dev` 自己按 `frontend:dev:watcher` 起的，摆出来是重影 |
| `Cargo.toml` | 有可执行目标的 crate 一条 `cargo run -p <包名>`（`rust`）；`[[bin]]` 多于一个时点 `--bin`，没写 `[[bin]]` 就认 `src/main.rs` 与 `src/bin/*.rs`。只有 `[lib]` 的成员 crate 一条都不出 |
| Python 标志文件 | 一个工程只给一条（`python`），按优先级：`manage.py` → `<解释器> manage.py runserver`；依赖里有 fastapi → `fastapi dev <含 FastAPI( 的那个文件>`；streamlit → `streamlit run <入口>`；flask → `flask --app <文件> run`；否则有 `__main__.py` 的包 → `<解释器> -m <包名>`；再否则第一个带 `if __name__ == "__main__"` 的脚本。解释器名现问（`python` 或 `python3`） |
| `*.csproj` / `*.fsproj` | `Microsoft.NET.Sdk.Web` / Blazor 或有 `<OutputType>Exe</OutputType>` 的项目一条 `dotnet run --project <相对路径>`（`dotnet`），类库不出条目 |
| `composer.json` | 有 `artisan` 就 `php artisan serve`（`php`）；否则 `scripts` 里按 `serve` / `start` / `dev` / `watch` / `run` 挑一个出 `composer <名字>`；都没有但 `public/index.php` 在，就 `php -S localhost:8000 -t public` |
| `Gemfile` | `bin/rails` 在就 `bin/rails server`（`ruby`）；Rails 没 binstub 就 `bundle exec rails server`；不是 Rails 但有 `config.ru` 走 `bundle exec rackup`，再退一步是那个引 Sinatra 的脚本 |
| `pubspec.yaml` | 依赖里有 Flutter SDK 就 `flutter run`，否则 `dart run`（`dart`） |
| `build.sbt` | 一条 `sbt run`（`scala`）；多模块也先给根上这一条，`sbt` 自己挑主类 |
| `mix.exs` | 提到 Phoenix 就 `mix phx.server`，否则 `mix run --no-halt` 把 supervision tree 起来（`elixir`） |
| `CMakeLists.txt` / `Makefile` | CMake 一条 `cmake -S . -B build && cmake --build build`（`cpp`）——没配过的目录光喊 `cmake --build build` 必失败，所以把配置那步带上。Makefile 只在**这一层没被别的构建文件认领**时才喊 `make`（有 `run:` 目标就 `make run`），不然那是别的体系顺手包的壳 |
| `build.zig` | 声明了 `b.step("run")` 就 `zig build run`，否则 `zig build`（`zig`） |
| `deno.json` / `deno.jsonc` | `tasks` 里每条一个 `deno task <名>`（`deno`）；读不成 JSON 报 `BAD_JSON`，不冒充「这个工程没有任务」 |
| `deps.edn` / `project.clj` | `project.clj` 是 Leiningen 的工程，出 `lein run`；`deps.edn` 出 `clojure -M`，写了 `:dev` 别名就带上（`clojure`） |
| `stack.yaml` / `package.yaml` / `*.cabal` | Stack 的工程 `stack run`，只有 `.cabal` 的 `cabal run`（`haskell`） |
| `Project.toml` | 找 `src/main.jl` 或根上 `main.jl`，出 `julia --project=. <文件>`（`julia`）；两个都没有就当库，不给条目 |
| `conf.lua` / 根上 `main.lua` | 那两个文件是 LÖVE 的骨架，出 `love .`；只有根上一个 `main.lua`、且这一层没被别的项目认领，才出 `lua main.lua`（`lua`） |
| `Package.swift` | 每个 `.executableTarget` 出一条（`swift`）：只有一个时 `swift run` 不点名，多了必须 `swift run <目标>` |
| 没有构建文件、但有带 `main` 的 `.java` | 一条 JDK 单文件启动 `${java} "<file>"`（`java`） |
| 没有构建文件、根上有 `main.py` / `app.py` / `run.py` | 一条 `<解释器> <file>`（`python`） |
| 没有构建文件、根上有 `run.sh` / `start.sh` / `dev.sh` | 一条 `<sh> <file>`（`shell`）。`build.sh` 是构建步骤不是起跑，其余 `.sh` 按库文件看，都不摆进下拉 |

只有 `spring-boot-maven-plugin` / Spring Boot Gradle 插件才算 Spring 应用：依赖里有
`spring-boot-starter-*` 只能说明它用了 Spring，不代表能独立启动，那种模块照旧只出 `clean package`
和主类条目。Android 模块（`com.android.application`）一条都不出——那边跑的是 `adb install`，不是这条命令。

**非 JVM 那几族的程序名不写占位符**：`go run` / `cargo run` / `dotnet run` / `wails dev` /
`fastapi dev` / `flask` / `php` / `composer` / `bundle` / `flutter` / `dart` / `sbt` / `mix` /
`cmake` / `make` / `zig` / `deno` / `lein` / `clojure` / `stack` / `cabal` / `julia` / `lua` /
`love` / `swift` / 解释器名都按裸程序名存，本机 PATH 上找不到就把这条标 `unavailable`
（`NO_TOOL`，`detail` 是那个程序名），条目仍然列得出来。`${mvn}` 那三个占位是给
「同一行命令可能在别的 JDK / 别的 wrapper 上跑」准备的，这些体系没有那种二义性，
npm 那边也是同一个口径（`detect.rs` 的 `program_missing`）。

长尾那十几族的条目名是 `{目录} [{目标}]`（`push_simple` 一口出的），只给**起跑**那一条：
`wails build`、`dotnet watch`、`flutter test`、`dart compile`、`zig build test`、`sbt assembly`、
`ctest`、`manage.py migrate` 这类构建 / 打包 / 测试命令一律不进下拉——它们不是「跑什么」。
只有 C / C++ 例外：那种工程不配不编就跑不起来，所以那一条把配置和构建带上。

刻意不给条目的只剩一类：**没有 `package.json` 的裸 `.js`**——那种文件多半是片段而不是一个工程，
起不来什么服务，与其猜一个入口不如不给。纯静态目录（只有 `index.html`）也不给。

识别这件事有个语料库兜着：`C:\Users\shengganbao\Desktop\test` 按语言分目录，每个语言放单目录 /
多目录 / 多模块几种形态和常用框架依赖，根上 `expect.json` 写「一个 IDE 该认出什么」。
仓库外那个宿主里 `cargo run --bin sweep -- <语料根>` 逐目录跑 `run_detect` 并和期望对账，
生成语料的是 `D:\app\tmp\forge-corpus\gen.mjs`。

### 命令里那三个占位符

命令行存的是 `${mvn}` / `${gradle}` / `${java}` 加相对参数，不是绝对路径——工程整棵挪盘子、
换一台机器，配置不用重写。落盘前不展开，起进程那一刻才由 `resolveCommand` 换成实际程序
（`src/lib/runConfigs.ts:96`）。

程序本体由 `run_tools()` 现问：`mvnw` / `gradlew` 包装脚本优先（离得最近的那个祖先目录，Windows 用
`.cmd`、其余用无后缀那份，工作目录取包装脚本所在目录），没有再查 PATH 上的 `mvn` / `gradle` / `java`。
Windows 上 PATH 查询要带扩展名候选，`where mvn` 命中的是 `mvn.cmd`，只查 `mvn` 永远找不到
（`sys::which_program`）。PATH 上也没有就把这条标成 `unavailable`，说清缺的是哪个程序。

Gradle 的主类条目需要一份 init 脚本。识别是只读的，不写盘：脚本内容跟着配置走
（`helper`），只在点运行那一刻由前端用现成的 `write_file` 落到 `<临时目录>/forge-run/`
（`ensureHelper`，`src/lib/runConfigs.ts:162`）。文件名按内容哈希，重复跑同一条不产生新文件。

## 主工具栏那组控件

`RunControls` 由 App 递进 `TitleBar` 的 `run` 槽。放在主工具栏是因为 IDEA 把「跑什么」当成和工程
同级的上下文；侧栏收起时工程与分支芯片跟着收起，这一组不收。

- 触发器是「类型图标 + 配置名 + 三角」，最高 240px，名字长了截断。没有工作区、或一条配置都没有时禁用。
- 下拉里从上到下：筛选框（打开就抢焦点，`Enter` 直接跑匹配到的第一条）、分组列表、底部
  「编辑程序配置…」与「重新识别」。分组按 钉选 → 最近 → 类型 排，同一条不摆两处。
- 点条目只是选中，要跑点行右那颗 `▶`；行上 `⋮` 开的是这一条的菜单（编辑 / 钉选 / 存成自己的一份），
  右键同一个菜单。**行上只有图标与名字**，命令行不进这张列表：IDEA 的弹层就名字那么宽，
  命令是详情里的东西。整行命令在悬停提示里（提示第一行是完整名字），也能进「编辑程序配置」那页看全；
  只有跑不了的行把原因写在名字后面，那是要当场看见的。
- 行上那两颗（`▶`／正跑着时的 `■` 与 `⋮`）**只在悬停或选中的那一行出现**，正跑着的那行常驻。
  位置用透明度收放，不做 `display: none`，否则悬停时名字会横向跳一下；收起的那两颗不吃点击。
  IDEA 新 UI 就是这个口径：`platform/platform-impl/src/com/intellij/ui/popup/list/PopupInlineActionsSupportImpl.kt:68`
  （`isSelected` 才画 inline 动作，`INLINE_BUTTON_WIDTH = 16` 在 `platform/platform-impl/src/com/intellij/ui/popup/list/InlineActionsUtil.kt:16`），
  经典弹层（Alt+Shift+F10 那个）干脆一颗行内按钮都没有。
- 弹层三个闸，谁都不许长成横幅：面板宽度跟着最长那行收缩（`width: max-content`）；名字到 210px、
  原因到 130px 各自省略号截断；列表最高 320px（且不超过 45vh）超出自己滚，底部两条动作常驻不跟着滚。
  对应 IDEA：名字自己截（`platform/execution-impl/src/com/intellij/execution/ui/RedesignedRunWidget.kt:651`
  `trimRunConfigurationName`）、弹层宽夹在 310–500（同文件 `:323-324`）、列表最多 30 行再滚
  （`platform/execution-impl/src/com/intellij/execution/ui/RunToolbarPopup.kt:281` `maxRowCount = 30`）。我们没有名字后面那段灰色副文案
  （命令行按你说的收进详情了），所以不跟它 310 的下限，面板收到内容宽。
- 三颗按钮：`▶` 跑当前选中，`↻` 重跑（先把这一条正在跑的会话停掉再开新的），`■` 停止。
  跑与重跑是绿的、停是红的（`--run-icon` / `--stop-solid`，和 IDEA 那三颗一个配色），
  禁用时才退回灰色；行里那颗 `▶` 与 `■` 同色。
  `■` 管的是「现在还在跑的那几台」，不止一条时 tooltip 报出条数，一次全停。
- 跑不了的原因不藏：`blockedOf` 把 `unavailable` 的 code 交给 `describeError`，缺程序则现算
  （`RunControls.tsx:53`）。整条禁用，tooltip 与行上那列文字都是同一句话。
- 点运行或重跑之后 `onStarted` 把运行面板放到底部。底部是排他的，原来待在那一块的（比如终端）跟着收起。
- 工具窗口关着也能跑：`proc://output` 和 `proc://exit` 两个监听在 hook 挂载时注册一次，不跟面板开关走，
  面板只画输出。

## 编辑器装订线上的那颗 ▶

**画在哪一栏**：行号右边、代码左边那条窄带（monaco 布局里的 `decorationsLeft..contentLeft`，默认宽
10px）——IDEA 那颗 ▶ 就在那儿。monaco 自带的 `glyphMargin` 只能待在行号**左边**，布局顺序改不动，
所以这一栏不用它的装饰 API，改由编辑器上叠一层浮层：每个落点用 `getScrolledVisiblePosition` 换算成
屏幕坐标摆上去，滚动 / 改行高 / 换 model / 正文增减行四种时机各重算一遍。整层 `pointer-events: none`，
只有那颗 ▶ 吃指针；不做裁剪，好让提示气泡出到代码区上面。

好处是这条带本来就存在，**所有文件的排版一个字都没动**（早先用 `glyphMargin` 那版会把行号整体右移
一个行高，已经废掉）。

**哪些行有**：npm 的每条脚本键；Java 主类的类声明那一行和 `main` 那一行（两处各一个，和 IDEA 一样）；
Spring 那条继承它盖住的那个注解类的那两处；Go 的 `func main`；Cargo 的 `fn main`；Python 的
`if __name__ == "__main__"`。

**哪些行没有**：构建目标那一类（`clean package`、`bootRun` 之外的 `build`、`cargo build`、`mix run`
这些）。IDEA 也不在 `pom.xml` 的 `<goal>` 行画图标——一条构建目标没有「声明它的那一行」，硬造一个
落点只会指错地方。同理，只有一句 `app = FastAPI()` 而没有入口守卫的脚本不给。

**跑不了的那几条不给图标**：`unavailable` 有值的（本机缺 `go` / 缺 JDK / 缺 `npm`）在弹层里是灰的
带一句原因，装订线上直接不画——点一下只回一句「跑不了」的控件不该摆在那儿。

**一行落进好几条配置时**：图标只画一个，但点下去不替瞎猜——只有一条时直接跑，多条时先把位次最
靠前的那条选中、再把主工具栏那个配置下拉打开让他改（`App.tsx` 的 `onRunConfig` 那条分支）。tooltip
在这种行上写「运行「dev」等 3 条」。IDEA 的判据是同一个：动作组里恰好一个动作时点击才直接跑
（`RunLineMarkerProvider.java:237-238`），多了就给出选择。

真工程的 `package.json` 是逐行展开的，一条脚本一行；`@SpringBootApplication` 那个类上 Spring 与主类
两条并到同一行也已经被「盖住就不重复出条目」那条规则消掉了。语料里原先有 14 处并列，是我自己把
scripts 写成了一行内联对象，`gen.mjs` 已经改成落盘时摊开，现在 81 处落点里并列 0 处。

**点了之后**：跑完把运行面板放到底部，和 `Shift+F10` 那条同一个收尾。

## 快捷键

应用级的，和搜索那几颗同一个规矩：工具窗口收着、焦点在终端里都按得到；模态弹窗开着时整条不认
（`src/App.tsx:703`）。键位取 IDEA 默认键位表，三个快捷键方案里都是同一套。

| 键 | 动作 |
| --- | --- |
| `Shift+F10` | 运行当前选中。没选配置时不空跑，打开选择下拉 |
| `Ctrl+F5` | 重跑当前选中 |
| `Ctrl+F2` | 停止（在跑的都停） |
| `Alt+Shift+F10` | 打开配置选择下拉 |
| `Alt+4` | Run 工具窗口，收起的那档再按一次收回 |

`Ctrl+F5` 在 WebView2 里本来是强制重载。`preventDefault` 之后走的是运行那条，但这条键位是两端抢的，
真机上如果还是被重载吃掉，就改控件里的键位而别改 IDEA 那套语义。

## 编辑程序配置页

整页开在编辑器页签里（`RunConfigsPage.tsx`），左栏两节：自己的配置 / 识别到的配置，右边一行一个字段。

- 名称、类型、命令行、运行目录、环境变量五项。识别来的那五条全部只读，上面一句话说明为什么。
- 运行目录存的是相对工程根的写法，整棵目录挪盘子配置不用跟着改；空就是根。
- 环境变量一行一对，名字空的行不算数。这比 IDEA 那栏 `A=1; B=2` 好改，值一样交给进程。
- 改一处就写一次盘，不设「确定 / 取消」。右上角三颗是新建 / 复制 / 删除，识别来的那条上复制就是
  「存成自己的一份」，删除对它们禁用。

## 存在哪里

`<app_config_dir>/runConfigs.json`，和 `settings.json` 同目录，按工程路径分键（只归一分隔符，大小写留着）。
每个工程一条 `ProjectRunState`：

- `configs`：只存用户自己建的 `shell` 条目，且命令行非空（`keepable`，`run/store.rs:81`）。识别出来的、
  Gradle 那条带 helper 脚本的都不落盘——重扫会得到，存下来只会留下过期副本。
- `selected`、`pinned`：都是 id。工程改了识别不出这条，那个 id 自然落空，不报错。

换工作区：会话层只负责把正在跑的收掉，配置层重新扫盘并重读存盘的那份，两边不共享这决定。

## 面板第二行的动作条

运行面板顶部第一行是「标题 + 会话页签」，第二行是一排动作图标（`RunPaneToolbar`）：重跑 / 停止 / 清空 /
更多，照 IDEA 的 Run 工具窗口。装配对应 IDEA 的 `RunContentExecutor`（`RerunAction` + `StopAction` +
`CloseAction`）。

配色与主工具栏那三颗**不是一套**，别混：

- 主工具栏（`RunControls`，`.run-controls`）是 IDEA 的 RunWidget：跑绿 / 停红**圆角实心底 + 白图标**。
- 动作条（`.run-pane-toolbar`）是 IDEA 运行窗口那排：**无底 + 彩色描边图标**——重跑绿、停止红、
  清空与更多保持灰。

重跑图标 `expui/run/rerun.svg` 本身是**双色**的（外圈弧线灰、箭头绿），两个 path 各带一个 class
（`rerun-arrow` / `rerun-arc`）由 CSS 分开上色；主工具栏那颗压在实心底上，两段都取 `currentColor` 白。
停止用 lucide 的空心 `Square`（红描边方块），对齐 IDEA 的 `expui/run/stop.svg`。禁用时红绿退回灰
（`--text-muted`），与 IDEA 一致——颜色只在真能用的时候才亮。

## 会话标签与输出

- 每次 `start` 开一条会话，标签名是配置名，标签左侧是那条配置的类型图标，跑完的留在列表里直到手动关。
- 会话记着自己那份配置（`RunSession.config`），页签上重跑用的是它，不是当前选中那条。
- 标签排成内容区上方的一行。每条带一个状态点：`running` 琥珀、`done` 绿、`failed` 红、`stopped` 三级灰。
  标签右侧是一个 18px 的关闭按钮，平时 `opacity: 0`，鼠标进入这条标签或它是当前会话时显示。
- 头部只有一颗「清空全部」（会话表为空时禁用），右侧一行状态：`正在运行…` / `已停止` / `退出码 N`。
  启动失败或本机缺工具时这一行换成原因。
- 控制台是一台只读 xterm。`@xterm/xterm/css/xterm.css` 由这块面板自己 import：终端那块是懒加载的，
  没开过终端就没有人往页面上装过这张表，那时 xterm 拿默认样式排版，行会叠成一片看着像乱码。
  原始字节是干净的（同一条 mvn 命令抓过五份、约 230 KB，零 ESC 零非 ASCII），所以那种「乱码」只可能是样式没到位。`disableStdin`、`scrollback: 8000`、`convertEol`、`fontSize: 12`、
  `lineHeight: 1.45`。用 xterm 而不是 `<pre>`，因为构建工具打的是 ANSI 彩色文本。
- 只有一台，切会话等于 `term.reset()` 之后把那条会话的缓冲整体重放。新输出只有在被看着的那条上落笔，
  其余会话只进缓冲。
- 收起（`display: none`）时量出来是 0，那一趟不量尺寸；回到展开除了重新 fit，还要再重放一次——收起期间
  做过的那次 `reset` 不会重画，行里会留着上一场的残字。
- 首行 `$ <命令>` 是前端补进缓冲的（`unshift`），后端可能在 promise 落地前就吐了第一块输出。补的是
  展开占位符之后的实际命令。
- 会话结束时往缓冲追加一行：主动终止过或取不到退出码写 `进程已被终止`，否则写 `进程已结束，退出代码为 N`。
- 没有会话时内容区显示选择配置的提示。
- 右键四项：重新运行（无当前会话时禁用）/ 停止（非运行中时禁用）/ 清空全部 / 关闭会话。
  关闭一条正在跑的会话会先终止它，再把当前项落到剩下的最后一条。

## 后端跑一条命令

- `proc_start(cwd, line, env)`：`line` 去掉首尾空白后为空直接报 `NO_COMMAND`。Windows 走
  `%COMSPEC% /D /C <line>`，取不到 `COMSPEC` 时用 `cmd.exe`；其余平台 `/bin/sh -c <line>`。
  `env` 是 `Vec<EnvVar>`，逐条 `command.env(name, value)` 叠上去，父进程环境照常继承——
  和 IDEA 默认那档「把父环境变量传下去」是同一个口径，名字为空的条目跳过。
- `stdin` 是 null，`stdout` 和 `stderr` 各起一条 `pump` 线程，8192 字节一段 base64 发 `proc://output`。
  两路交错的先后不保证。
- 会话 id 是 `proc-<N>`，从 1 自增。
- `CREATE_NO_WINDOW`（`0x08000000`）让 npm 与 `cmd` 包装那类脚本不额外弹控制台窗口。
- 退出码由每 80ms 一次的 `try_wait` 轮询取回，发 `proc://exit { id, code }`。**正常退出**时先把两路 `pump`
  各自的 EOF 等完（上限 `DRAIN_GRACE` 400ms）再发这条事件：不等的话收尾那几 KB 还在路上，界面已经写成
  「已结束」，那几行会掉到结束行的下面去，看着就是状态和输出对不上。**主动停止**不等，那本来就是要掐断的
  ——被终止的进程常把管道留给没退干净的子进程，等它就把「停止」的反馈拖到整棵进程树跑完之后。
- 停止 = `proc_kill`：先给轮询线程发停止信号，再 `taskkill /F /T /PID <pid>` 连整棵进程树杀掉，最后
  `child.kill()`。必须带 `/T`：`cmd /D /C` 只是壳，杀它会把真正的子进程留在后台继续占着输出管道。
  非 Windows 只有停止信号加 `child.kill()`。
- 主动终止过的会话进 `killedRef`，退出事件哪怕带回退出码也报「已停止」，不说成脚本自己失败。

## 不提供的动作

没有 Debug。Debug 要接 DAP，Rust 侧没有调试器适配（另见 `../../plans/run-and-debug/`）。

启动一律交给构建工具或 JDK，forge 不自己拼 java 命令行：那要解析模块依赖、算 classpath、
判断 `ShortenCommandLine`，前提是有一个后台索引/依赖解析器，这个应用没有。所以「跑 Spring Boot
应用」在这里是 `mvn spring-boot:run`，第一次要下依赖、比 IDEA 的 classpath 启动慢，改一个类也要重跑。
这是刻意的边界，不是漏掉的一环。

其他不做的：命令行参数与工作目录分开那格（工作目录有，参数直接写在命令里）、before-run 任务、
运行配置模板、把某条配置存进工程目录（`.run/`）随 git 走。空命令行由后端挡着，`proc_start` 报
`NO_COMMAND`；本机缺工具那条前端就拦下，不给后端起一个必挂的进程。

## 代码

| 文件 | 内容 |
| --- | --- |
| `src/App.tsx` | `useRunConfigs` / `useRunSessions` 挂在 App `:430-431`、`runChooser` 信号 `:367`、运行快捷键那条 effect `:740-790`、`run-configs` 页签与开关、`DocPane` 那三颗运行入参 `:2606-2620` |
| `src/components/RunControls.tsx` | 为什么在主工具栏 `:31`、`blockedOf` `:53`、分组与筛选 `:77`、`launch` `:108`、行菜单 `:134`、三颗按钮可用条件 `:155-158` |
| `src/components/RunConfigsPage.tsx` | 整页形态与两节列表 `:84`、字段区 `:133-199`、环境变量行 `:238` |
| `src/components/RunPane.tsx` | 只读 xterm、切会话重放、会话标签行与类型图标、右键菜单 |
| `src/hooks/useRunConfigs.ts` | 两层状态的分界 `:22`、`rescan` `:45`、合并与排序 `:89`、`selected` `:108`、写盘 `:115`、钉选与两份增删 `:136-206` |
| `src/hooks/useRunSessions.ts` | `RunSession` 带配置 `:16`、两个事件监听、`stop` `:118`、`start`（占位符展开、helper 落盘、`$ <命令>` 头行）`:140`、`rerun` `:214`、`rerunSession` `:224`、状态行文案 `:235` |
| `src/lib/runConfigs.ts` | 类型镜像与四个命令、`resolveCommand` `:129`、`displayCommand` `:137`、`missingTool` `:142`、`ensureHelper` `:158`、`newShellConfig` `:165`、`configLabel` `:189` |
| `src/components/CodeEditor.tsx` | 浮层那颗 ▶：`PIN_WIDTH :12`、`RunGutterPin :15`、换实例时清挂接记录 `:117`、四个重算时机 `:132-137`、落点算 `:241`、换算屏幕坐标 `:260-287`、浮层渲染 `:324` |
| `src/lib/runMarkers.ts` | 一行归哪条配置、同一行的取舍、跑不了的不给图标 |
| `src/lib/runIcons.tsx` | 六种类型的图标与分组次序 |
| `src/lib/errors.ts` | `NO_TOOL` / `NO_JDK` / `JDK_TOO_OLD` / `TOO_MANY_SOURCES` 四条文案映射 |
| `src-tauri/src/run/mod.rs` | 数据模型：`RunKind :14`、`EnvVar :68`、`HelperFile :77`、`Unavailable :85`、`RunMarker :97`、`RunConfiguration :107` |
| `src-tauri/src/run/detect.rs` | 边界常量 `:47`、`run_tools :533`、npm `:655`、maven `:722`、gradle `:809`、单文件启动 `:907`、主类扫描 `:963`、init 脚本内容 `:1033`、go `:1056`、rust `:1197`、python `:1280`、dotnet `:1425`、长尾各族 `:1479-1906`、`kind_rank :1926`、`run_detect :1957` |
| `src-tauri/src/run/detect.rs` | 装订线落点怎么算：`line_at :176`、`object_key_lines :201`（数 JSON 里每个键在哪一行）、`jvm_markers :390`、`marker_at :1185`、`python_marker :1374` |
| `src-tauri/src/run/store.rs` | 分工程存、`run_state_load` `:72`、`keepable` `:81`、`run_state_save` `:87` |
| `src-tauri/src/proc.rs` | `proc_start` 与环境变量 `:83-102`、`pump`、80ms 轮询、`proc_kill` |
| `src-tauri/src/sys.rs` | `which_program`（Windows 扩展名候选）、`capture_text`（`java -version` 打在 stderr） |
| `src/styles.css` | 面板与控件 `:1683-1710`、会话标签与状态点 `:1727-1780`、类型图标配色 `:1867-1922`、下拉列表 `:1953-2047`、装订线浮层 `:2049-2085`、三颗按钮配色 `:2087-2138`、配置页字段区 `:2209-2290` |
| `src/i18n/lang/zh.ts` | `run.*` 文案 `:170-212`、四条错误文案 `:90-93`（en 那侧同结构，整体后移 4 行） |
