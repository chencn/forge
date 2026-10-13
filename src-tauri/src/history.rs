//! 历史记录。独立一份 `history.json`，与 `settings.json` 同目录，整表落盘。
//!
//! 这四项不是偏好，是「用户做过什么」的流水：上次开的项目、打开过的项目、签出过的分支、
//! 用过的提交说明。它们每次开项目、每次切分支、每次提交都要整份写一遍，和主题、字号那种
//! 几个月不动一次的偏好混在一份文件里，只会让设置文件天天被重写。
//!
//! 读坏了退回空表，不退回半份：记的是流水，丢了顶多重新打开一次项目，不该把应用卡在启动上。

use crate::error::{err, err_parts};
use crate::offload::{block, block_value};
use crate::sys::write_atomic;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Manager};

/// 历史记录的文件名。
const HISTORY_FILE: &str = "history.json";
/// 旧记录所在的那份通用设置，只为一次性迁移而读。
const SETTINGS_FILE: &str = "settings.json";

/// 用户做过的那些事。
#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct History {
    /// 上次打开的文件夹；空串表示没有。兼容单根模式与旧配置。
    pub last_folder: String,
    /// 当前窗口常驻打开的全部文件夹，按打开顺序排；启动时据此恢复多工作区。
    pub open_folders: Vec<String>,
    /// 多工作区中当前激活的那一个文件夹；空串表示没有。
    pub active_folder: String,
    /// 最近打开过的文件夹，新的在前；主工具栏的工程下拉列这份。
    pub recent_folders: Vec<String>,
    /// 最近签出过的分支，新的在前。
    pub recent_branches: Vec<String>,
    /// 用过的提交说明，新的在前；提交框的历史时钟列这份。
    pub commit_messages: Vec<String>,
}

/// 这四项原先住在 `settings.json` 里。第一次读不到 `history.json` 时把它们搬过来。
/// 之后那份设置里还留着这四个键，`Settings` 已经不再声明它们，读到时直接忽略。
fn migrate_from_settings(settings_path: &Path) -> History {
    let Ok(text) = fs::read_to_string(settings_path) else {
        return History::default();
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&text) else {
        return History::default();
    };
    let list = |key: &str| -> Vec<String> {
        root.get(key)
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    History {
        last_folder: root
            .get("lastFolder")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
        open_folders: list("openFolders"),
        active_folder: root
            .get("activeFolder")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
        recent_folders: list("recentFolders"),
        recent_branches: list("recentBranches"),
        commit_messages: list("commitMessages"),
    }
}

/// 读一个目录下的历史记录。文件不在时从同目录的旧设置里迁移一次并立刻落盘，
/// 下一遍读的就是 `history.json` 自己那份。
pub fn load_in(dir: &Path) -> History {
    let path = dir.join(HISTORY_FILE);
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(history) = serde_json::from_str::<History>(&text) {
            return history;
        }
    }
    let migrated = migrate_from_settings(&dir.join(SETTINGS_FILE));
    let _ = save_in(dir, &migrated);
    migrated
}

/// 整份写回一个目录下的历史记录，格式化便于手改。原子写：半截文件会让下一次启动退回空表。
pub fn save_in(dir: &Path, history: &History) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|error| err_parts("IO", &[dir.display().to_string(), error.to_string()]))?;
    let text = serde_json::to_string_pretty(history).map_err(|error| error.to_string())?;
    write_atomic(&dir.join(HISTORY_FILE), &text)
}

/// 读历史记录；拿不到配置目录就给空表，不让界面卡在启动那一步。
pub fn read(app: &AppHandle) -> History {
    match app.path().app_config_dir() {
        Ok(dir) => load_in(&dir),
        Err(_) => History::default(),
    }
}

/// 读历史记录。
#[tauri::command]
pub async fn history_load(app: AppHandle) -> History {
    block_value(move || read(&app), History::default).await
}

/// 整份写回。
#[tauri::command]
pub async fn history_save(app: AppHandle, history: History) -> Result<(), String> {
    block(move || {
        let dir = app
            .path()
            .app_config_dir()
            .map_err(|error| err("CONFIG_DIR", error))?;
        save_in(&dir, &history)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 每个测试独占一个临时目录，跑完就删。
    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::UNIX_EPOCH
            .elapsed()
            .map(|since| since.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "forge-history-{name}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 第一次读时旧 `settings.json` 里那四项搬进 `history.json`，并立刻落盘。
    #[test]
    fn first_load_migrates_sibling_settings() {
        let dir = temp_dir("migrate");
        fs::write(
            dir.join(SETTINGS_FILE),
            r#"{"theme":"dark","lastFolder":"D:/app/x",
                "recentFolders":["D:/app/x","D:/app/y"],
                "recentBranches":["main"],
                "commitMessages":["修一个 bug"]}"#,
        )
        .unwrap();

        let history = load_in(&dir);
        assert_eq!(history.last_folder, "D:/app/x");
        assert_eq!(history.recent_folders, vec!["D:/app/x", "D:/app/y"]);
        assert_eq!(history.recent_branches, vec!["main"]);
        assert_eq!(history.commit_messages, vec!["修一个 bug"]);
        assert!(dir.join(HISTORY_FILE).is_file(), "没有生成 {HISTORY_FILE}");
        // 第二次读走的是自己那份文件，不再看旧设置。
        fs::remove_file(dir.join(SETTINGS_FILE)).unwrap();
        assert!(load_in(&dir) == history);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 没有旧设置可搬时给空表，照样把文件写出来。
    #[test]
    fn first_load_without_settings_writes_empty() {
        let dir = temp_dir("empty");
        assert!(load_in(&dir) == History::default());
        let back: History = serde_json::from_str(&fs::read_to_string(dir.join(HISTORY_FILE)).unwrap()).unwrap();
        assert!(back == History::default());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 手改坏的文件不该把应用带崩：退回空表，同时重新写一份能用的。
    #[test]
    fn broken_file_is_replaced() {
        let dir = temp_dir("broken");
        fs::write(dir.join(HISTORY_FILE), "{ not json").unwrap();
        assert!(load_in(&dir) == History::default());
        let back: History = serde_json::from_str(&fs::read_to_string(dir.join(HISTORY_FILE)).unwrap()).unwrap();
        assert!(back == History::default());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 旧文件缺字段时按 `Default` 补，改结构不用迁移旧文件。
    #[test]
    fn missing_fields_default() {
        let back: History = serde_json::from_str(r#"{"recentBranches":["dev"]}"#).unwrap();
        assert_eq!(back.recent_branches, vec!["dev"]);
        assert!(back.recent_folders.is_empty());
        assert!(back.open_folders.is_empty());
        assert_eq!(back.active_folder, "");
        assert_eq!(back.last_folder, "");
    }

    /// 多工作区常驻字段 `openFolders` 与 `activeFolder` 能完整落盘并读回。
    #[test]
    fn multi_workspace_open_and_active_folders_roundtrip() {
        let dir = temp_dir("multi-ws");
        let expected = History {
            last_folder: "D:/app/b".to_string(),
            open_folders: vec!["D:/app/a".to_string(), "D:/app/b".to_string()],
            active_folder: "D:/app/b".to_string(),
            recent_folders: vec!["D:/app/b".to_string(), "D:/app/a".to_string()],
            recent_branches: vec!["main".to_string()],
            commit_messages: vec![],
        };
        save_in(&dir, &expected).unwrap();
        let actual = load_in(&dir);
        assert!(actual == expected);
        let _ = fs::remove_dir_all(&dir);
    }
}
