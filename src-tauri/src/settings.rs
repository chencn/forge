use crate::error::{err, err_parts};
use crate::offload::{block, block_value};
use crate::sys::write_atomic;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 全局设置的文件名，落在系统配置目录里。
const SETTINGS_FILE: &str = "settings.json";

/// 编辑器相关的偏好。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorSettings {
    /// 字号（px）。
    pub font_size: u32,
    /// 制表宽度。
    pub tab_size: u32,
    /// 是否显示右侧缩略图。
    pub minimap: bool,
    /// 快捷键方案：default / idea / eclipse。
    pub keymap: String,
    /// 代码保存策略：manual（只有手动）/ blur（失去焦点时自动保存）。
    pub save_policy: String,
    /// 退出前是否把没保存的改动写回磁盘。
    pub save_on_exit: bool,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            font_size: 13,
            tab_size: 2,
            minimap: true,
            keymap: "default".to_string(),
            save_policy: "blur".to_string(),
            save_on_exit: true,
        }
    }
}

/// 终端相关的偏好。
#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalSettings {
    /// 起终端用的 shell 程序路径；空串表示用 `shell_probe` 排在第一的那个。
    pub shell: String,
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

/// 一份全局设置。缺字段时按 Default 补，改结构不用迁移旧文件。
///
/// 这里只放偏好：主题、字号这类几个月不动一次的选择。用户做过的流水（上次开的项目、
/// 最近分支、用过的提交说明）住在 `history.json`，那份每次开项目都要重写，跟偏好混在一起
/// 只会让设置文件天天被整份写一遍。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// 外观：light / dark / system。
    pub theme: String,
    /// 界面语言：zh / en。
    pub language: String,
    /// 点关闭做什么：tray 收进托盘，quit 直接退应用。
    pub close_behavior: String,
    pub editor: EditorSettings,
    pub terminal: TerminalSettings,
    pub commit: CommitSettings,
    pub branches: BranchSettings,
    pub explorer: ExplorerSettings,
    /// 通知气泡弹出位置：bottom-right / top-right / bottom-left / top-left。
    pub notification_position: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            language: String::new(),
            close_behavior: "quit".to_string(),
            editor: EditorSettings::default(),
            terminal: TerminalSettings::default(),
            commit: CommitSettings::default(),
            branches: BranchSettings::default(),
            explorer: ExplorerSettings::default(),
            notification_position: "bottom-right".to_string(),
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
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

/// 整份写回，格式化成可读的 JSON。原子写，避免写一半被杀掉留下半截文件。
#[tauri::command]
pub async fn settings_save(app: AppHandle, settings: Settings) -> Result<(), String> {
    block(move || save(&app, &settings)).await
}

fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| err_parts("IO", &[dir.display().to_string(), error.to_string()]))?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    write_atomic(&path, &text)
}
#[cfg(test)]
mod tests {
    use super::*;

    /// 语言服务配置搬去 `lsp.json` 了，旧文件里残留的 `lsp` 段要能读、并且被忽略。
    #[test]
    fn old_lsp_section_is_ignored() {
        let text = r#"{"theme":"dark","lsp":{"servers":{"gopls":{"mode":"lsp"}}}}"#;
        let settings: Settings = serde_json::from_str(text).unwrap();
        assert_eq!(settings.theme, "dark");
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
}

