//! 运行配置：一条「跑什么」的描述，以及它从哪来、存在哪。
//!
//! 识别（`detect`）负责从工程目录里的构建文件推出可跑的那几台，落盘（`store`）只存用户自己
//! 建的那批和选中/最近这两条线索。两者在产品根上汇合成同一份列表交给界面。

pub mod detect;
pub mod store;

use serde::{Deserialize, Serialize};

/// 配置类型。界面上按它分组、挑图标，也决定这条能不能编辑。
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum RunKind {
    /// `package.json` 里的一条 scripts。
    Npm,
    /// Maven 目标。
    Maven,
    /// Gradle 任务。
    Gradle,
    /// Spring Boot 应用；启动仍然借道 Maven / Gradle。
    Spring,
    /// JVM 主类。识别出来的走构建工具，裸的走单文件启动器。
    Java,
    /// Go 可执行包：`go run <包路径>`。
    Go,
    /// Wails 桌面工程（v2 与 v3 都是 `wails.json` 这个标志文件）。
    Wails,
    /// Cargo 里的可执行目标。
    Rust,
    /// Python 工程入口：框架起跑或单文件起跑。
    Python,
    /// .NET / F# 可执行项目。
    DotNet,
    /// PHP：Laravel 的 `artisan serve`、composer 脚本、或内置服务器。
    Php,
    /// Ruby：Rails 的 `bin/rails server` 或 rackup。
    Ruby,
    /// Dart / Flutter。
    Dart,
    /// sbt 项目。
    Scala,
    /// Elixir 的 mix 项目（Phoenix 走 `mix phx.server`）。
    Elixir,
    /// C / C++：CMake 配起来再构建，或 Makefile。
    Cpp,
    /// Zig 的 `zig build`。
    Zig,
    /// Deno 的 `deno task`。
    Deno,
    /// Clojure：deps.edn 走 `clojure -M`，Leiningen 走 `lein run`。
    Clojure,
    /// Haskell：Stack 或 Cabal。
    Haskell,
    /// Julia：`--project` 起那个目录。
    Julia,
    /// Lua：LÖVE 工程或一个 `main.lua`。
    Lua,
    /// SwiftPM 里的可执行目标。
    Swift,
    /// 用户手写的命令行。
    Shell,
}

/// 一条键值环境变量。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

/// 起跑前要先落到磁盘上的辅助文件。Gradle 的主类启动靠它：一份 init 脚本，
/// 内容随识别一起算出来，落点永远在系统临时目录，不进工程的目录树。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HelperFile {
    pub path: String,
    pub content: String,
}

/// 本机跑不了这条配置的原因。只回代码与原文，文案由前端按界面语言拼。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Unavailable {
    /// `NO_TOOL` 命令行里没有该构建工具；`NO_JDK` 找不到 java。
    pub code: String,
    /// 找过什么：程序名或路径。
    pub detail: String,
}

/// 装订线上那颗 ▶ 的落点：这条配置在某个源文件里声明在哪一行。
///
/// 一条配置可以有好几个落点——JVM 那边类声明和 `main` 方法各算一个，两处都能点。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunMarker {
    /// 相对工程根的源文件路径，一律用 `/` 分隔（界面按归一后的路径和打开的那篇文档对上）。
    pub file: String,
    /// 1 起的行号，指着声明本身那一行。
    pub line: u32,
}

/// 一条运行配置。识别出来的和用户建的是同一个形状，差别只在 `generated`。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunConfiguration {
    /// 稳定标识。识别出来的按「类型:位置:键」算，同一工程每次扫出来都是同一个值。
    pub id: String,
    /// 列表与页签上显示的名字。
    pub name: String,
    pub kind: RunKind,
    /// 交给进程通道的整行命令。
    pub command: String,
    /// 相对工程根的运行目录；空串是根。识别出来的用系统分隔符。
    pub working_dir: String,
    pub env: Vec<EnvVar>,
    /// 由构建文件推出来的，界面只读；要改得先存成自定义配置。
    #[serde(default)]
    pub generated: bool,
    /// 钉在选择列表最前面那一节。
    #[serde(default)]
    pub pinned: bool,
    /// 有值就等于这条现在跑不了，界面置灰并说明为什么。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<Unavailable>,
    /// 起跑前要先落到磁盘上的那份辅助文件；没有就是空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper: Option<HelperFile>,
    /// 编辑器装订线上的落点。空就等于这条没有可点的地方——构建目标那一类。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub markers: Vec<RunMarker>,
}
