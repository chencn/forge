//! 终端页签布局：每个工作区根开着哪几条、各自的 shell、名字、固定、分组、目录。
//! 独立一份 `terminal-tabs.json`，与 `history.json` 同目录。shell 进程本身没法跨重启留下，
//! 下次打开同一个根时按这份重新起一遍。
//!
//! 内容由前端定义，这里只原样存取；读坏了当成没有，大不了开一条默认终端。

use crate::error::{err, err_parts};
use crate::offload::{block, block_value};
use crate::sys::write_atomic;
use serde_json::Value;
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Manager};

const LAYOUT_FILE: &str = "terminal-tabs.json";

fn load_in(dir: &Path) -> Value {
    fs::read_to_string(dir.join(LAYOUT_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Default::default()))
}

fn save_in(dir: &Path, layout: &Value) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|error| err_parts("IO", &[dir.display().to_string(), error.to_string()]))?;
    let text = serde_json::to_string_pretty(layout).map_err(|error| error.to_string())?;
    write_atomic(&dir.join(LAYOUT_FILE), &text)
}

#[tauri::command]
pub async fn term_layout_load(app: AppHandle) -> Value {
    block_value(
        move || match app.path().app_config_dir() {
            Ok(dir) => load_in(&dir),
            Err(_) => Value::Object(Default::default()),
        },
        || Value::Object(Default::default()),
    )
    .await
}

#[tauri::command]
pub async fn term_layout_save(app: AppHandle, layout: Value) -> Result<(), String> {
    block(move || {
        let dir = app
            .path()
            .app_config_dir()
            .map_err(|error| err("CONFIG_DIR", error))?;
        save_in(&dir, &layout)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_ignores_garbage() {
        let nanos = std::time::UNIX_EPOCH.elapsed().map(|since| since.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("forge-term-layout-{}-{nanos}", std::process::id()));
        assert_eq!(load_in(&dir), Value::Object(Default::default()));

        let layout = serde_json::json!({ "d:/repo": { "tabs": [{ "shell": "cmd" }], "active": 0 } });
        save_in(&dir, &layout).unwrap();
        assert_eq!(load_in(&dir), layout);

        fs::write(dir.join(LAYOUT_FILE), "not json").unwrap();
        assert_eq!(load_in(&dir), Value::Object(Default::default()));
        let _ = fs::remove_dir_all(&dir);
    }
}
