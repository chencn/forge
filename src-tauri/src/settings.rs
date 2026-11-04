use crate::error::{err, err_parts};
use crate::offload::{block, block_value};
use crate::sys::write_atomic;
use json_patch::merge;
use serde::{Deserialize, Serialize};
use std::fs;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 全局设置的文件名，落在系统配置目录里。
const SETTINGS_FILE: &str = "settings.json";

/// 编辑器相关的偏好。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorSettings {
    /// 括号按嵌套深度上色（对标 IDEA 默认关）。
    pub rainbow_brackets: bool,
    /// 正文字体族；空串跟随 `--font-mono`。
    pub font_family: String,
    /// 字号（px）。
    pub font_size: u32,
    /// 制表宽度。
    pub tab_size: u32,
    /// 是否显示右侧缩略图。
    pub minimap: bool,
    /// 内置快捷键方案：idea / vscode / eclipse，默认 idea。
    pub keymap: String,
    /// 代码保存策略：manual（只有手动）/ blur（失去焦点时自动保存）。
    pub save_policy: String,
    /// 退出前是否把没保存的改动写回磁盘。
    pub save_on_exit: bool,
    /// 保存时删除行尾空格和制表符。
    pub trim_trailing_whitespace: bool,
    /// 保存时保证非空文本以换行结束。
    pub insert_final_newline: bool,
    /// 软换行（IDEA 默认关）。
    pub soft_wrap: bool,
    /// 显示空白符（IDEA 默认关）。
    pub show_whitespace: bool,
    /// 行高（px）；0 表示自动按字号 1.69 倍推导。
    pub line_height: u32,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            rainbow_brackets: false,
            font_family: String::new(),
            font_size: 13,
            tab_size: 2,
            minimap: true,
            keymap: "idea".to_string(),
            save_policy: "blur".to_string(),
            save_on_exit: true,
            trim_trailing_whitespace: false,
            insert_final_newline: false,
            soft_wrap: false,
            show_whitespace: false,
            line_height: 0,
        }
    }
}

/// 运行工具窗口的偏好。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct RunSettings {
    /// 给每行输出盖一个收到时刻的时间戳；本来就带时间的行不动。
    pub timestamps: bool,
}

impl Default for RunSettings {
    fn default() -> Self {
        Self { timestamps: true }
    }
}

/// 终端相关的偏好。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalSettings {
    /// 起终端用的 shell：`shell_probe` 那条的 id（多数就是路径）；空串表示用排在第一的那个。
    pub shell: String,
    /// 字号（px），和编辑器字号分开。
    pub font_size: u32,
    /// 字体；空串表示跟编辑器同一套等宽字体。
    pub font_family: String,
    /// 回滚行数。
    pub scrollback: u32,
    /// 光标：bar / block / underline。
    pub cursor_style: String,
    /// 页签排法：horizontal（标题行里）/ vertical（终端左侧一列）。
    pub tab_layout: String,
    /// 响铃：visual（闪一下、页签挂铃铛）/ sound（再响一声）/ none。
    pub bell: String,
    /// 用户自己配的启动方案。
    pub profiles: Vec<TerminalProfile>,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            shell: String::new(),
            font_size: 12,
            font_family: String::new(),
            scrollback: 10_000,
            cursor_style: "bar".to_string(),
            tab_layout: "horizontal".to_string(),
            bell: "visual".to_string(),
            profiles: Vec::new(),
        }
    }
}

/// 终端配置档：在某个 shell 上加参数、环境变量、起始目录和启动命令。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalProfile {
    pub id: String,
    pub name: String,
    /// `ShellInfo.id`；空串表示默认 shell。
    pub shell: String,
    pub args: Vec<String>,
    /// 按插入顺序存成键值对，界面上逐行编辑。
    pub env: Vec<TerminalEnvVar>,
    /// 起始目录；相对路径按工作区根解析，空串就是工作区根。
    pub dir: String,
    /// shell 起来后自动敲进去的命令。
    pub command: String,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalEnvVar {
    pub key: String,
    pub value: String,
}

/// 提交工具窗口的偏好，对应 IDEA 的 CommitView.GearActions 那两项。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct CommitSettings {
    /// 双击变更行打开什么：preview（比对）/ source（源文件）。
    pub show_on_double_click: String,
    /// 一件都没暂存时，提交按钮是否直接提交全部已跟踪改动。
    pub commit_all_when_nothing_staged: bool,
}

impl Default for CommitSettings {
    fn default() -> Self {
        Self {
            show_on_double_click: "preview".to_string(),
            commit_all_when_nothing_staged: true,
        }
    }
}

/// 分支弹层与日志分支面板齿轮里那几条显示开关。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct BranchSettings {
    /// 搜索时把动作也列进结果。
    pub actions_in_search: bool,
    /// 列「最近使用」那一节。
    pub show_recent: bool,
    /// 列标签那一节。
    pub show_tags: bool,
    /// 分支名按斜杠嵌成目录层级；关掉就是平铺一条。
    pub group_by_directory: bool,
    /// 点一下树里某条引用做什么：none 只选中，filter 顺手把日志筛到这条。
    pub on_single_click: String,
    /// 收藏的引用全名（本地分支不带前缀，远端带 `origin/`）；排在同层前面。
    pub favorites: Vec<String>,
    /// 提交图折叠线性链（Collapse Linear Branches）。
    #[serde(default)]
    pub collapse_linear: bool,
    /// 提交图画长边（Show Long Edges），默认开。
    #[serde(default = "default_true")]
    pub show_long_edges: bool,
}

impl Default for BranchSettings {
    fn default() -> Self {
        Self {
            actions_in_search: true,
            show_recent: true,
            show_tags: true,
            group_by_directory: true,
            on_single_click: "none".to_string(),
            favorites: Vec::new(),
            collapse_linear: false,
            show_long_edges: true,
        }
    }
}

/// 资源管理器的显示偏好。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ExplorerSettings {
    /// 显示被 .gitignore 忽略的文件/目录。
    pub show_ignored: bool,
    /// 显示隐藏文件（Windows 隐藏属性 / 点开头）。
    pub show_hidden: bool,
}

impl Default for ExplorerSettings {
    fn default() -> Self {
        Self {
            show_ignored: true,
            show_hidden: false,
        }
    }
}

/// 应用内更新的偏好。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateSettings {
    /// 发现新版本后是否自动下载；关掉就只走设置页里的手动检查。
    pub auto_download: bool,
    /// 自动下载完成后是否弹窗询问安装；关掉就是下载完直接静默安装。
    /// 只在 auto_download 开着时有意义。
    pub auto_prompt_install: bool,
    /// 是否开启 GitHub 镜像加速更新。
    pub proxy_enabled: bool,
    /// 镜像加速前缀地址，如 https://gh-proxy.com/。
    pub proxy_url: String,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            auto_download: false,
            // 默认问一句：Windows 上静默安装会直接拉起安装器并退出应用，不打招呼太吓人。
            auto_prompt_install: true,
            proxy_enabled: false,
            proxy_url: "https://gh-proxy.com/".to_string(),
        }
    }
}

/// 资源管理器右键「通过 Forge 打开」。两个开关都默认关，要用户自己勾上。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ShellSettings {
    /// 文件夹右键菜单。打开后按添加项目处理。
    pub open_folder: bool,
    /// 文本文件右键菜单。只登记白名单里的文本格式，打开后暂时进编辑区。
    pub open_file: bool,
    /// 这些文本文件的双击默认程序。关掉就交还给原来的程序。
    pub default_file: bool,
    /// 用户追加的扩展名。内置名单不在这里，重复项由写入前的归一去掉。
    pub extra_extensions: Vec<String>,
}

impl Default for ShellSettings {
    fn default() -> Self {
        Self {
            open_folder: false,
            open_file: false,
            default_file: false,
            extra_extensions: Vec::new(),
        }
    }
}

/// 事务工单规则项（对标 IDEA Issue Navigation 规范）
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct IssueNavigationPattern {
    pub id: String,
    pub issue_id: String,
    pub issue_link: String,
}

/// 版本控制完整配置，1:1 对标 IDEA VCS 设置规范
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct VcsSettings {
    pub non_modal_commit: bool,
    pub clear_initial_commit_message: bool,
    pub blank_line_after_subject: bool,
    pub limit_subject_line: bool,
    pub subject_line_limit: u32,
    pub limit_body_line: bool,
    pub body_line_limit: u32,
    pub show_right_margin: bool,
    pub wrap_right_margin: bool,
    // 提交代码检查已移除；这里只保留不依赖语言服务的 TODO 检查。
    pub check_todo: bool,
    pub show_update_options: bool,
    /// 更新弹窗与直接更新共用的默认策略。
    pub update_method: String,
    pub auto_update_on_push_rejected: bool,
    pub highlight_dirty_directories: bool,
    pub on_patch_created: String,
    pub limit_history_rows: u32,
    pub warn_crlf: bool,
    pub warn_detached_head: bool,
    pub sign_off_commit: bool,
    pub warn_large_files: bool,
    pub large_files_limit_mb: u32,
    pub warn_bad_file_names: bool,
    pub show_push_dialog: String,
    pub protected_branches: String,
    pub issue_navigation_patterns: Vec<IssueNavigationPattern>,
}

impl Default for VcsSettings {
    fn default() -> Self {
        Self {
            non_modal_commit: true,
            clear_initial_commit_message: false,
            blank_line_after_subject: true,
            limit_subject_line: true,
            subject_line_limit: 72,
            limit_body_line: true,
            body_line_limit: 72,
            show_right_margin: true,
            wrap_right_margin: false,
            check_todo: true,
            show_update_options: true,
            update_method: "merge".to_string(),
            auto_update_on_push_rejected: false,
            highlight_dirty_directories: true,
            on_patch_created: "clipboard".to_string(),
            limit_history_rows: 1000,
            warn_crlf: true,
            warn_detached_head: true,
            sign_off_commit: false,
            warn_large_files: true,
            large_files_limit_mb: 50,
            warn_bad_file_names: true,
            show_push_dialog: "protected".to_string(),
            protected_branches: "master;main;release/*".to_string(),
            issue_navigation_patterns: vec![IssueNavigationPattern {
                id: "1".to_string(),
                issue_id: "([A-Z]+-\\d+)".to_string(),
                issue_link: "https://jira.example.com/browse/$1".to_string(),
            }],
        }
    }
}

/// 一份全局设置。缺字段时按 Default 补，改结构不用迁移旧文件。
///
/// 这里只放偏好：主题、字号这类几个月不动一次的选择。用户做过的流水（上次开的项目、
/// 最近分支、用过的提交说明）住在 `history.json`，那份每次开项目都要重写，跟偏好混在一起
/// 只会让设置文件天天被整份写一遍。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// AI 编程助手总开关，默认关闭。只决定菜单与侧栏入口显不显示，不拦截任何功能。
    pub ai_assistants_enabled: bool,
/// Browser access has its own enable switch; unsafe features need explicit opt-in.
    pub browser: crate::browser::BrowserSettings,
    /// 外观：light / dark / system。
    pub theme: String,
    /// 界面语言：zh / en。
    pub language: String,
    /// 工作区模式：multi（多工作区常驻）/ single（单工作区）。
    pub workspace_mode: String,
    /// HTTP 响应放哪：bottom 底部面板，tab 单独页签。
    #[serde(default = "default_http_response")]
    pub http_response: String,
    /// HTTP 历史保留天数；0 表示永不清理。启动时清掉超过这个天数的条目。
    pub http_history_retention_days: u32,
    /// 点关闭做什么：tray 收进托盘，quit 直接退应用。
    pub close_behavior: String,
    pub editor: EditorSettings,
    pub terminal: TerminalSettings,
    pub commit: CommitSettings,
    pub branches: BranchSettings,
    pub explorer: ExplorerSettings,
    /// 资源管理器右键菜单。默认都不开。
    pub shell: ShellSettings,
    /// 应用内更新：自动下载与安装前是否询问。
    pub updates: UpdateSettings,
    /// 运行工具窗口。
    pub run: RunSettings,
    /// 按项目根保存的目录角色；相对路径到角色名的映射。
    pub project_directory_roles: HashMap<String, HashMap<String, String>>,
    /// 版本控制完整配置
    pub vcs: VcsSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ai_assistants_enabled: false,
            browser: crate::browser::BrowserSettings::default(),
            theme: "system".to_string(),
            language: String::new(),
            workspace_mode: "multi".to_string(),
            http_response: default_http_response(),
            http_history_retention_days: 31,
            close_behavior: "tray".to_string(),
            editor: EditorSettings::default(),
            terminal: TerminalSettings::default(),
            commit: CommitSettings::default(),
            branches: BranchSettings::default(),
            explorer: ExplorerSettings::default(),
            shell: ShellSettings::default(),
            updates: UpdateSettings::default(),
            run: RunSettings::default(),
            project_directory_roles: HashMap::new(),
            vcs: VcsSettings::default(),
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_http_response() -> String {
    "bottom".to_string()
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    // The opt-in native harness must never read or write a real user's settings.
    #[cfg(feature = "browser-smoke")]
    if app.config().identifier == "app.forge.browser-smoke" {
        return Ok(PathBuf::from(std::env::var("FORGE_BROWSER_SMOKE_ROOT").map_err(|e| e.to_string())?).join("settings.json"));
    }
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| err("CONFIG_DIR", error))?;
    Ok(dir.join(SETTINGS_FILE))
}

/// 读一份设置。托盘和关闭那条路也要看它，所以留个不带命令壳的入口。
/// 文件不存在或读坏了都退回默认值，不让应用起不来。
pub fn read(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .unwrap_or_default()
}

/// 读全局设置；文件不存在或读坏了都退回默认值，不让应用起不来。
#[tauri::command]
pub async fn settings_load(app: AppHandle) -> Settings {
    block_value(move || read(&app), Settings::default).await
}

/// 进程内互斥减少同进程争用；跨进程原子性由 settings.lock 覆盖完整读改写。
static SETTINGS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 读文件里的原始 JSON。与 `read` 相反，这里**不**退回默认值：
/// 合并要以它为底稿，读不出来还照样写，等于把别人存过的设置整份抹掉。
fn read_document(app: &AppHandle) -> Result<serde_json::Value, String> {
    let path = settings_path(app)?;
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        // 还没有配置文件：从空对象起步，合并结果就是本次改的那几个字段。
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::Value::Object(Default::default())),
        Err(error) => return Err(err_parts("IO", &[path.display().to_string(), error.to_string()])),
    };
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Object(Default::default()));
    }
    let document: serde_json::Value = serde_json::from_str(&text).map_err(|error| err_parts("SETTINGS_JSON", &[path.display().to_string(), error.to_string()]))?;
    if !document.is_object() {
        return Err(err("SETTINGS_JSON", format!("设置文件 {} 不是一个对象", path.display())));
    }
    Ok(document)
}

/// 把一份 **JSON Merge Patch（RFC 7396）** 合并进现有文档，并按结构校验结果。
/// 不碰磁盘，方便单测；返回合并后的文档与校验过的设置。
fn apply_patch(document: serde_json::Value, patch: &serde_json::Value) -> Result<(serde_json::Value, Settings), String> {
    if !patch.is_object() {
        return Err(err("SETTINGS_PATCH", "设置补丁必须是一个对象"));
    }
    let mut document = document;
    merge(&mut document, patch);
    // 先校验再落盘：类型不对的字段不能留下半份配置。
    let merged: Settings = serde_json::from_value(document.clone()).map_err(|error| err("SETTINGS_PATCH", error))?;
    Ok((document, merged))
}

/// 按字段保存设置：把传来的补丁合并进文件里现有的内容，只覆盖出现过的字段。
///
/// 为什么不能整份写回：每个窗口都把自己那份内存里的 Settings 全量落盘，任何一次改动都写
/// 整个文件。dev 与安装版（或两个窗口）同时开着时，内存副本旧的那个一保存，就把新设置——
/// 包括 AI 助手开关——连同别的字段一起抹回旧值。按字段合并之后，「改一个字段」只可能
/// 影响那一个字段；返回值是合并后的全量设置，调用方跟着它走，窗口之间不再各留一份真相。
///
/// 写的是合并后的文档而不是结构体，所以文件里我们不认识的段落（例如搬去 `lsp.json`
/// 之前残留的 `lsp`）会原样留着——读不懂的东西不该顺手删掉。
///
/// AI 总开关只决定菜单与侧边栏入口显不显示，不在保存路径上停任务、不动浏览器授权：
/// 多开窗口共享同一份设置，一个窗口把开关关掉，不该杀掉别的窗口里正在跑的会话，
/// 也不该把已经渲染出来的功能面板锁死。开关落盘即可，其余状态各归各的开关管。
#[tauri::command]
pub async fn settings_save(app: AppHandle, patch: serde_json::Value) -> Result<Settings, String> {
    block(move || {
        let _guard = SETTINGS_LOCK.lock().map_err(|error| error.to_string())?;
        let path = settings_path(&app)?;
        let dir = path.parent().ok_or_else(|| err("CONFIG_DIR", "设置路径没有父目录"))?;
        fs::create_dir_all(dir).map_err(|error| err_parts("IO", &[dir.display().to_string(), error.to_string()]))?;
        let _file_guard = crate::sys::ExclusiveFileLock::acquire(&dir.join("settings.lock"))?;
        let before = read(&app);
        let (document, merged) = apply_patch(read_document(&app)?, &patch)?;
        save_document(&app, &document)?;
        // Revoke synchronously after persistence and before returning to any UI caller.
        crate::browser::settings_saved(&app, &merged);
        if before.browser != merged.browser {
            crate::browser::permissions_changed(&app, !merged.browser.enabled);
        }
        Ok(merged)
    })
    .await
}

fn save_document(app: &AppHandle, document: &serde_json::Value) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| err_parts("IO", &[dir.display().to_string(), error.to_string()]))?;
    }
    let text = serde_json::to_string_pretty(document).map_err(|error| error.to_string())?;
    // 原子写，避免写一半被杀掉留下半截文件。
    write_atomic(&path, &text)
}
#[cfg(test)]
mod tests {
    use super::*;

    /// 旧检查字段不进入运行时设置和 IPC 返回值，其余 VCS 偏好保持原值。
    #[test]
    fn vcs_ignores_removed_commit_checks() {
        let raw = serde_json::json!({
            "checkAnalyzeCode": true, "checkReformatCode": true,
            "checkOptimizeImports": true, "checkCleanup": true,
            "checkTodo": false, "signOffCommit": true, "subjectLineLimit": 60,
        });
        let settings: VcsSettings = serde_json::from_value(raw).unwrap();
        let expected = VcsSettings {
            check_todo: false, sign_off_commit: true, subject_line_limit: 60,
            ..VcsSettings::default()
        };
        assert_eq!(serde_json::to_value(settings).unwrap(), serde_json::to_value(expected).unwrap());
    }

    #[test]
    fn ai_assistants_default_off_and_round_trip() {
        assert!(!Settings::default().ai_assistants_enabled);
        let old: Settings = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert!(!old.ai_assistants_enabled);
        let enabled: Settings = serde_json::from_str(r#"{"aiAssistantsEnabled":true}"#).unwrap();
        assert!(enabled.ai_assistants_enabled);
        let serialized = serde_json::to_string(&enabled).unwrap();
        assert!(serialized.contains(r#""aiAssistantsEnabled":true"#));
        let restored: Settings = serde_json::from_str(&serialized).unwrap();
        assert!(restored.ai_assistants_enabled);
    }

    /// 浏览器与截图默认可用，上传和任意脚本仅在显式保存 true 后启用。
    #[test]
    fn browser_defaults_and_permission_patches() {
        for document in [serde_json::json!({}), serde_json::json!({"browser":{"enabled":true}})] {
            let settings: Settings = serde_json::from_value(document.clone()).unwrap();
            assert!(settings.browser.enabled);
            assert!(settings.browser.rendered_pixels);
            assert!(!settings.browser.file_upload);
            assert!(!settings.browser.unsafe_evaluate);
            let (saved, settings) = apply_patch(document, &serde_json::json!({"browser":{"renderedPixels":false,"fileUpload":true}})).unwrap();
            assert!(!settings.browser.rendered_pixels);
            assert!(settings.browser.file_upload);
            assert!(!settings.browser.unsafe_evaluate);
            let restored: Settings = serde_json::from_value(saved).unwrap();
            assert!(!restored.browser.rendered_pixels);
            assert!(restored.browser.file_upload);
            assert!(!restored.browser.unsafe_evaluate);
        }
        let (_, settings) = apply_patch(
            serde_json::json!({"browser":{"renderedPixels":true,"fileUpload":false,"unsafeEvaluate":false}}),
            &serde_json::json!({"browser":{"renderedPixels":false}}),
        ).unwrap();
        assert!(!settings.browser.rendered_pixels);
        assert!(!settings.browser.file_upload);
        assert!(!settings.browser.unsafe_evaluate);
        for field in ["fileUpload", "unsafeEvaluate"] {
            assert!(apply_patch(serde_json::json!({}), &serde_json::json!({"browser":{(field):"true"}})).is_err());
        }
    }

    /// 元素交付偏好单独落盘，不得顺带改变上传、脚本或截图授权。
    #[test]
    fn browser_element_content_persistence() {
        let initial = serde_json::json!({"browser":{"renderedPixels":false,"fileUpload":false,"unsafeEvaluate":false}});
        let settings: Settings = serde_json::from_value(initial.clone()).unwrap();
        assert_eq!(serde_json::to_value(settings).unwrap()["browser"]["elementContent"], "both");
        for mode in ["code", "screenshot", "both"] {
            let (saved, settings) = apply_patch(initial.clone(), &serde_json::json!({"browser":{"elementContent":mode}})).unwrap();
            let restored: Settings = serde_json::from_value(saved).unwrap();
            assert_eq!(serde_json::to_value(restored).unwrap()["browser"]["elementContent"], mode);
            assert!(!settings.browser.rendered_pixels);
            assert!(!settings.browser.file_upload);
            assert!(!settings.browser.unsafe_evaluate);
        }
        assert!(apply_patch(initial, &serde_json::json!({"browser":{"elementContent":"unknown"}})).is_err());
    }

    /// TODO(v1.4.0)：三版本后删除本测试。
    ///
    /// 语言服务（LSP）已在 1.1.2 整组移除，但老用户的 `settings.json` 里还残留着
    /// 当年的 `lsp` 段。读入靠的是「结构体不认识的段落原样保留」这条通用容错
    /// （见 `read_document`），这条测试只是给它钉的回归钉子。等 v1.1.2 之前的
    /// 老配置基本换代完毕（约三个版本），这条测试就没有存在意义了；届时顺手把
    /// `patch_touches_only_the_fields_it_names` 里的 `lsp` 夹具换成别的示例段。
    #[test]
    fn old_lsp_section_is_ignored() {
        let text = r#"{"theme":"dark","lsp":{"servers":{"gopls":{"mode":"lsp"}}}}"#;
        let settings: Settings = serde_json::from_str(text).unwrap();
        assert_eq!(settings.theme, "dark");
    }

    /// 补丁只动它写出来的那几个字段：没出现的字段照原样留着，连结构体不认识的段落也不删。
    #[test]
    fn patch_touches_only_the_fields_it_names() {
        let file = serde_json::json!({
            "aiAssistantsEnabled": true, "theme": "dark",
            "editor": { "fontSize": 15, "tabSize": 4 },
            "lsp": { "servers": { "gopls": { "mode": "lsp" } } },
        });
        let (document, merged) = apply_patch(file, &serde_json::json!({ "editor": { "fontSize": 13 } })).unwrap();
        assert!(merged.ai_assistants_enabled);
        assert_eq!(merged.theme, "dark");
        assert_eq!(merged.editor.font_size, 13);
        assert_eq!(merged.editor.tab_size, 4);
        // 另一个窗口存过的开关、以及我们读不懂的旧段落，都不能被这次保存带走。
        assert_eq!(document["aiAssistantsEnabled"], serde_json::json!(true));
        assert!(document.get("lsp").is_some());
    }

    /// 没有配置文件时从空对象起步：合并结果就是本次改的那几个字段，其余仍是默认值。
    #[test]
    fn patch_on_a_missing_file_keeps_other_defaults() {
        let (_, merged) = apply_patch(serde_json::Value::Object(Default::default()), &serde_json::json!({ "aiAssistantsEnabled": true })).unwrap();
        assert!(merged.ai_assistants_enabled);
        assert_eq!(merged.workspace_mode, "multi");
    }

    /// 类型不对或不是对象的补丁直接拒收，不落半份配置。
    #[test]
    fn patch_with_a_bad_shape_is_rejected() {
        assert!(apply_patch(serde_json::json!({ "theme": "dark" }), &serde_json::json!({ "theme": 5 })).is_err());
        assert!(apply_patch(serde_json::json!({}), &serde_json::json!("nope")).is_err());
    }

    /// 历史记录搬去 `history.json` 了，旧文件里残留的那四项同样要能被忽略掉。
    #[test]
    fn old_history_fields_are_ignored() {
        let text = r#"{"theme":"dark","lastFolder":"D:/app/x",
            "recentFolders":["D:/app/x"],"recentBranches":["main"],"commitMessages":["x"]}"#;
        let settings: Settings = serde_json::from_str(text).unwrap();
        assert!(settings == theme_of("dark"), "残留的历史字段没有读成默认值");
    }

    /// 测试用的构造：只换主题，其余取默认值。
    fn theme_of(theme: &str) -> Settings {
        Settings {
            theme: theme.to_string(),
            ..Settings::default()
        }
    }

    /// 工作区模式缺省为 `multi`（是），点击关闭时缺省为 `tray`（最小化到托盘）。
    #[test]
    fn workspace_mode_and_close_behavior_defaults() {
        let def: Settings = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(def.workspace_mode, "multi");
        assert_eq!(def.http_response, "bottom");
        assert_eq!(def.http_history_retention_days, 31);
        assert_eq!(def.close_behavior, "tray");

        let custom: Settings = serde_json::from_str(
            r#"{"theme":"dark","workspaceMode":"single","closeBehavior":"quit"}"#,
        )
        .unwrap();
        assert_eq!(custom.workspace_mode, "single");
        assert_eq!(custom.close_behavior, "quit");
    }

    /// 历史保留天数缺省 31 天；0 表示永不清理，设置文件往返后保持原值。
    #[test]
    fn http_history_retention_defaults_and_round_trips() {
        let custom: Settings = serde_json::from_str(r#"{"httpHistoryRetentionDays":0}"#).unwrap();
        assert_eq!(custom.http_history_retention_days, 0);
        assert_eq!(serde_json::to_value(custom).unwrap()["httpHistoryRetentionDays"], 0);
    }

    /// 项目目录角色是设置文件的一部分，重启后必须保留项目根与相对目录映射。
    #[test]
    fn project_directory_roles_round_trip() {
        let settings: Settings = serde_json::from_str(
            r#"{"projectDirectoryRoles":{"d:/app/forge":{"src":"source","tests":"test"}}}"#,
        )
        .unwrap();
        assert_eq!(settings.project_directory_roles["d:/app/forge"]["src"], "source");
        let encoded = serde_json::to_value(settings).unwrap();
        assert_eq!(encoded["projectDirectoryRoles"]["d:/app/forge"]["tests"], "test");
    }

    /// 资源管理器菜单两个开关缺省都是关。旧文件没有这段时不能被读成打开。
    #[test]
    fn shell_open_defaults_off() {
        let def: Settings = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert!(!def.shell.open_folder);
        assert!(!def.shell.open_file);
        assert!(!def.shell.default_file);
        assert!(def.shell.extra_extensions.is_empty());

        let custom: Settings = serde_json::from_str(
            r#"{"shell":{"openFolder":true,"openFile":false}}"#,
        )
        .unwrap();
        assert!(custom.shell.open_folder);
        assert!(!custom.shell.open_file);
    }
}

