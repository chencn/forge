//! 应用内更新的挂起标记。
//!
//! updater 插件下载的安装包字节只活在本次进程里（install 才落盘），跨不了重启。
//! 「下载过但没装」这件事本身要记下来，下次启动才知道该静默补装哪一版——所以只有
//! 版本号进文件，安装包在下次启动重新下载。放独立文件而不进 `settings.json`：
//! 这是运行状态，不是用户偏好，见 `settings.rs` 头上那段分工说明。

use crate::error::{err, err_parts};
use crate::offload::{block, block_value};
use crate::sys::write_atomic;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

/// 挂起标记的文件名，落在系统配置目录里，与 settings.json 同目录。
const PENDING_FILE: &str = "update-pending.json";

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// 下载过但还没装的更新，记它的版本号与尝试次数。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PendingUpdate {
    /// 挂起的更新版本；与当前版本相同说明已装完，读出来就该清掉。
    pub version: String,
    /// 尝试安装的次数，防止安装失败或被用户取消后开机死循环静默闪退。
    #[serde(skip_serializing_if = "is_zero")]
    pub attempts: u32,
}

fn pending_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| err("CONFIG_DIR", error))?;
    Ok(dir.join(PENDING_FILE))
}

fn read_pending(app: &AppHandle) -> Option<PendingUpdate> {
    let path = pending_path(app).ok()?;
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// 读挂起标记；文件不存在或读坏了都算没有，不挡启动。
#[tauri::command]
pub async fn update_pending_load(app: AppHandle) -> Option<PendingUpdate> {
    block_value(move || read_pending(&app), || None).await
}

/// 记一条挂起标记（覆盖旧的），原子写。支持记录尝试安装的次数。
#[tauri::command]
pub async fn update_pending_save(
    app: AppHandle,
    version: String,
    attempts: Option<u32>,
) -> Result<(), String> {
    block(move || {
        let path = pending_path(&app)?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|error| {
                err_parts("IO", &[dir.display().to_string(), error.to_string()])
            })?;
        }
        let pending = PendingUpdate {
            version,
            attempts: attempts.unwrap_or(0),
        };
        let text = serde_json::to_string(&pending).map_err(|error| error.to_string())?;
        write_atomic(&path, &text)
    })
    .await
}

/// 清掉挂起标记；文件不存在不算错。
#[tauri::command]
pub async fn update_pending_clear(app: AppHandle) -> Result<(), String> {
    block(move || {
        let path = pending_path(&app)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            // NotFound 说明本来就干净；父目录没建过也是同一回事。
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(err_parts("IO", &[path.display().to_string(), error.to_string()])),
        }
    })
    .await
}

/// 暴露给前端的更新元数据，直接兼容 @tauri-apps/plugin-updater 的 Update 构造参数。
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub rid: tauri::ResourceId,
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
    pub raw_json: serde_json::Value,
}

/// 检查更新。支持传入可选的 GitHub 镜像加速前缀（如 https://gh-proxy.com/）。
/// 镜像加速会同时替换检查端点和安装包下载 URL，下载后依然由本地公钥执行 minisign 签名校验。
#[tauri::command]
pub async fn update_check(
    webview: tauri::Webview,
    proxy_url: Option<String>,
) -> Result<Option<UpdateCheckResult>, String> {
    let mut builder = webview.updater_builder();
    let default_endpoint = "https://github.com/chencn/forge/releases/latest/download/latest.json";

    if let Some(ref proxy) = proxy_url {
        let prefix = proxy.trim();
        if !prefix.is_empty() {
            let full_endpoint = if prefix.ends_with('/') {
                format!("{}{}", prefix, default_endpoint)
            } else {
                format!("{}/{}", prefix, default_endpoint)
            };
            if let Ok(parsed) = Url::parse(&full_endpoint) {
                builder = builder.endpoints(vec![parsed]).map_err(|e| e.to_string())?;
            }
        }
    }

    let updater = builder.build().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;

    if let Some(mut update) = update {
        // 如果开启了代理前缀，同时将安装包下载 URL 也拼上代理前缀加速大文件下载
        if let Some(ref proxy) = proxy_url {
            let prefix = proxy.trim();
            if !prefix.is_empty() {
                let download_str = update.download_url.to_string();
                let proxied_str = if prefix.ends_with('/') {
                    format!("{}{}", prefix, download_str)
                } else {
                    format!("{}/{}", prefix, download_str)
                };
                if let Ok(parsed) = Url::parse(&proxied_str) {
                    update.download_url = parsed;
                }
            }
        }

        let formatted_date = update.date.as_ref().map(|d| d.to_string());
        let rid = webview.resources_table().add(update.clone());
        Ok(Some(UpdateCheckResult {
            rid,
            current_version: update.current_version,
            version: update.version,
            date: formatted_date,
            body: update.body,
            raw_json: update.raw_json,
        }))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 标记的落盘契约：camelCase 版本号，前端 invoke 的参数就长这样。
    #[test]
    fn pending_update_roundtrip() {
        let text = r#"{"version":"0.2.0"}"#;
        let pending: PendingUpdate = serde_json::from_str(text).unwrap();
        assert_eq!(pending.version, "0.2.0");
        assert_eq!(pending.attempts, 0);
        assert_eq!(
            serde_json::to_string(&pending).unwrap(),
            r#"{"version":"0.2.0"}"#
        );

        // 尝试次数大于 0 时，序列化出 attempts
        let with_attempts = PendingUpdate {
            version: "0.2.0".to_string(),
            attempts: 1,
        };
        assert_eq!(
            serde_json::to_string(&with_attempts).unwrap(),
            r#"{"version":"0.2.0","attempts":1}"#
        );
        let parsed: PendingUpdate =
            serde_json::from_str(r#"{"version":"0.2.0","attempts":1}"#).unwrap();
        assert_eq!(parsed.attempts, 1);
    }
}
