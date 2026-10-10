//! 运行配置的落盘。位置和 `settings.json` 同目录，一个文件按工程分节。
//!
//! 存的三样东西都是「用户自己的决定」：自己建的 Shell 配置、当前选中哪条、钉选了哪几条。
//! 识别出来的那批每次扫都有，把它们整份存下来就会留下改不掉的旧记录——
//! 构建文件改了，界面上还得不到新结果。所以这里只按 id 记用户对识别配置做过的动作。

use super::{RunConfiguration, RunKind};
use crate::error::err_parts;
use crate::offload::{block, block_value};
use crate::sys::write_atomic;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const RUN_FILE: &str = "runConfigs.json";

/// 一个工程的运行配置状态。
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectRunState {
    /// 用户自己建的配置。识别出来的不进这里。
    pub configs: Vec<RunConfiguration>,
    /// 下拉当前选中的那条 id；空串表示没选。
    pub selected: String,
    /// 钉选的那批 id。识别出来的配置也能钉，但只在这一节里记着。
    pub pinned: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct RunFileFormat {
    /// 键是归一化后的工程根。
    projects: BTreeMap<String, ProjectRunState>,
}

/// 归一化成能当键用的写法：统一分隔符、去掉尾斜杠。
/// 盘符大小写留给前端归一——那边知道这台机器的路径风格，两台机器共用一份配置文件时
/// 键本来就该不一样。
fn project_key(root: &str) -> String {
    let flat = root.replace('\\', "/");
    let trimmed = flat.trim_matches('/');
    if trimmed.is_empty() {
        return "/".to_string();
    }
    format!("/{trimmed}")
}

fn run_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| crate::error::err("CONFIG_DIR", error))?;
    Ok(dir.join(RUN_FILE))
}

fn read_file(app: &AppHandle) -> RunFileFormat {
    run_file_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<RunFileFormat>(&text).ok())
        .unwrap_or_default()
}

/// 读一个工程的运行配置状态；文件不在或读坏了都给空表，不让界面卡在启动那一步。
#[tauri::command]
pub async fn run_state_load(app: AppHandle, root: String) -> ProjectRunState {
    block_value(
        move || {
            read_file(&app)
                .projects
                .remove(&project_key(&root))
                .unwrap_or_default()
        },
        ProjectRunState::default,
    )
    .await
}

/// 这条配置该不该进文件。识别出来的不存（每次扫都有，存下来就成了改不掉的旧记录），
/// 命令行空着的不存（那是一条死配置，摆出来只会多一个用不了的入口）。
fn keepable(config: &RunConfiguration) -> bool {
    !config.generated && config.kind == RunKind::Shell && !config.command.trim().is_empty()
}

/// 整节写回。
#[tauri::command]
pub async fn run_state_save(
    app: AppHandle,
    root: String,
    state: ProjectRunState,
) -> Result<(), String> {
    block(move || run_state_save_impl(app, root, state)).await
}

fn run_state_save_impl(
    app: AppHandle,
    root: String,
    state: ProjectRunState,
) -> Result<(), String> {
    let path = run_file_path(&app)?;
    let mut file = read_file(&app);
    let kept: Vec<RunConfiguration> = state
        .configs
        .into_iter()
        .filter(|config| keepable(config))
        .collect();
    file.projects.insert(
        project_key(&root),
        ProjectRunState {
            configs: kept,
            selected: state.selected,
            pinned: state.pinned,
        },
    );
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| {
            err_parts("IO", &[dir.display().to_string(), error.to_string()])
        })?;
    }
    let text = serde_json::to_string_pretty(&file)
        .map_err(|error| err_parts("ENCODE", &[error.to_string()]))?;
    write_atomic(&path, &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(id: &str, kind: RunKind, command: &str, generated: bool) -> RunConfiguration {
        RunConfiguration {
            id: id.to_string(),
            name: id.to_string(),
            kind,
            command: command.to_string(),
            working_dir: String::new(),
            env: Vec::new(),
            generated,
            pinned: false,
            unavailable: None,
            helper: None,
            markers: Vec::new(),
        }
    }

    fn keep(state: &ProjectRunState) -> Vec<RunConfiguration> {
        state
            .configs
            .iter()
            .filter(|config| keepable(config))
            .cloned()
            .collect()
    }

    #[test]
    fn keys_ignore_separators_and_edges() {
        assert_eq!(project_key(r"D:/app/x"), project_key(r"D:\app\x"));
        assert_eq!(project_key("/tmp/x/"), project_key("/tmp/x"));
        assert_eq!(project_key("/"), "/");
        assert_eq!(project_key(""), "/");
        assert_ne!(project_key("D:/x"), project_key("d:/x"), "大小写不在这一层归一");
    }

    #[test]
    fn save_keeps_only_user_shell_configs() {
        let state = ProjectRunState {
            configs: vec![
                config("s1", RunKind::Shell, "go run .", false),
                config("s2", RunKind::Shell, "   ", false),
                config("m1", RunKind::Maven, "mvn clean package", true),
                config("n1", RunKind::Npm, "vite", true),
            ],
            selected: "s1".to_string(),
            pinned: vec!["m1".to_string()],
        };
        let kept = keep(&state);
        assert_eq!(kept.len(), 1, "只留用户建的 Shell 那条：{:?}", kept);
        assert_eq!(kept[0].id, "s1");
        // 钉选识别配置靠 pinned 那份 id 列表，不复制配置本体。
        assert_eq!(state.pinned, vec!["m1".to_string()]);
    }

    #[test]
    fn round_trip_keeps_env_and_missing_fields_default() {
        let text = r#"{"configs":[{"id":"s1","name":"后端","kind":"shell","command":"go run .",
            "workingDir":"server","env":[{"name":"PORT","value":"8080"}]}],
            "selected":"s1","pinned":[]}"#;
        let back: ProjectRunState = serde_json::from_str(text).unwrap();
        assert_eq!(back.configs[0].env[0].name, "PORT");
        assert_eq!(back.configs[0].kind, RunKind::Shell);
        // 缺节缺字段都按 Default 补，旧文件不该让整份状态读不出来。
        let partial: ProjectRunState = serde_json::from_str(r#"{"selected":"x"}"#).unwrap();
        assert!(partial.configs.is_empty());
        assert_eq!(partial.selected, "x");
        // 盘上那份旧文件还带着已经不读的 `recent` 那一节，多出来的键要能被忽略掉。
        let legacy: ProjectRunState =
            serde_json::from_str(r#"{"selected":"s1","recent":["s1"],"pinned":[]}"#).unwrap();
        assert_eq!(legacy.selected, "s1");
        assert!(legacy.pinned.is_empty());
    }
}
