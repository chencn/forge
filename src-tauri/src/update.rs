//! 应用内更新的挂起标记与安装包缓存。
//!
//! 挂起标记只装得下版本号，所以「下载过但没装」这件事以前跨不过一次重启：插件把整包
//! 字节攥在后端资源表里，进程一死就没了，下次启动只能原样重下一遍。现在安装包落到
//! `app_cache_dir()/updates/`，同一版本从此只下一次——延后安装、直接退出、补装时安装器
//! 被取消，都不再产生第二次下载。
//!
//! 读回装包前必须用固定公钥重新验签：盘上的字节任何进程都能写，不重验就等于把
//! 「直接拉起任意 exe」的口子开出去。
//!
//! 两者都是运行状态而不是用户偏好，所以不进 `settings.json`，见 `settings.rs` 头上那段分工说明。

use crate::error::{err, err_parts};
use crate::offload::{block, block_value};
use crate::sys::write_atomic;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
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

/// 安装包缓存的子目录名，落在系统缓存目录下。
///
/// 与配置目录里的挂起标记分开放：缓存属于「随手清也不丢用户东西」的那一类。
const CACHE_DIR: &str = "updates";

/// 缓存文件后缀。装的时候是把字节喂给 `Update::install`，插件自己写临时文件并决定
/// 用什么后缀跑安装器，这里存成什么名字都不影响安装。
const CACHE_SUFFIX: &str = ".bin";

/// 下载进度事件。serde 形状与插件自带的 `DownloadEvent` 逐字段一致，
/// 前端那份 `reduceDownloadEvent` 折算函数两边通用。
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum CacheDownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: usize },
    Finished,
}

/// 版本号能不能直接当文件名。
///
/// 版本号是从更新清单里读的，而清单可能来自用户填的镜像代理，所以不能直接拼进路径：
/// `..` 或路径分隔符会把文件写到缓存目录外面去。只放行版本号该有的字符，其余整条拒掉。
fn version_is_safe(version: &str) -> bool {
    !version.is_empty()
        && !version.contains("..")
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

/// 某一版的缓存文件路径。
fn cache_path(app: &AppHandle, version: &str) -> Result<PathBuf, String> {
    if !version_is_safe(version) {
        return Err(err("UPDATE_VERSION_UNSAFE", version));
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| err("CACHE_DIR", error))?;
    Ok(dir.join(CACHE_DIR).join(format!("{version}{CACHE_SUFFIX}")))
}

/// 更新插件配置里的一项布尔开关，没写按 `false`。
///
/// 同时认驼峰和连字符两种写法：插件的 serde 定义两者都收。
fn updater_flag(app: &AppHandle, camel_key: &str, kebab_key: &str) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|cfg| cfg.get(camel_key).or_else(|| cfg.get(kebab_key)))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

/// 钉在 `tauri.conf.json` 里的更新公钥。验签只认这一把。
fn updater_pubkey(app: &AppHandle) -> Result<String, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|cfg| cfg.get("pubkey"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| err("UPDATE_PUBKEY_MISSING", "plugins.updater.pubkey"))
}

/// base64 装的那段文本还原出来（公钥与签名在清单和配置里都是 base64 的一整段）。
fn b64_to_string(value: &str) -> Result<String, String> {
    let decoded = STANDARD
        .decode(value)
        .map_err(|error| err("UPDATE_B64", error))?;
    String::from_utf8(decoded).map_err(|error| err("UPDATE_B64_UTF8", error))
}

/// 签名的 trusted comment 长这样：`timestamp:1700000000\tfile:Forge_setup.exe\tversion:1.2.3`。
fn signed_version(trusted_comment: &str) -> Option<&str> {
    trusted_comment
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
}

/// 签名覆盖的版本与清单说的版本是不是同一版。两边都可能带 `v` 前缀。
fn versions_match(signed: &str, announced: &str) -> bool {
    signed.trim_start_matches('v') == announced.trim_start_matches('v')
}

/// 用固定公钥验一份安装包字节。
///
/// 语义与插件 2.13.3 的 `verify_signature` 对齐：先验全局签名，验过之后 trusted comment
/// 里的版本号才可信——在那之前读它，等于信攻击者写的数据。
fn verify_package(
    bytes: &[u8],
    release_signature: &str,
    pub_key: &str,
    announced_version: &str,
    require_signed_version: bool,
) -> Result<(), String> {
    let key_text = b64_to_string(pub_key)?;
    let public_key = PublicKey::decode(&key_text).map_err(|error| err("UPDATE_PUBKEY_BAD", error))?;
    let signature_text = b64_to_string(release_signature)?;
    let signature =
        Signature::decode(&signature_text).map_err(|error| err("UPDATE_SIGNATURE_BAD", error))?;
    public_key.verify(bytes, &signature, true).map_err(|error| {
        err_parts("UPDATE_CACHE_INVALID", &[announced_version.to_string(), error.to_string()])
    })?;

    let comment = signature.trusted_comment();
    let Some(signed) = signed_version(comment) else {
        // 老版本 CLI 签出来的包不带版本号，只有显式要求时才拒。
        return if require_signed_version {
            Err(err("UPDATE_CACHE_UNSIGNED", announced_version))
        } else {
            Ok(())
        };
    };
    // 清单说的版本与签名覆盖的版本必须是同一版。
    if versions_match(signed, announced_version) {
        Ok(())
    } else {
        Err(err_parts("UPDATE_CACHE_VERSION_MISMATCH", &[
            signed.to_string(),
            announced_version.to_string(),
        ]))
    }
}

/// 原子写入缓存文件，并清掉其它版本的缓存。
///
/// 同一时刻只有一版是「下载完没装」的状态，留着旧版只会一份份攒安装包。
fn write_cache_and_prune(path: &Path, bytes: &[u8]) -> Result<u64, String> {
    let dir = path
        .parent()
        .ok_or_else(|| err("CACHE_DIR", path.display().to_string()))?;
    fs::create_dir_all(dir).map_err(|error| {
        err_parts("IO", &[dir.display().to_string(), error.to_string()])
    })?;
    let keep = path.file_name().map(|name| name.to_os_string());
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if keep.as_deref() == Some(entry.file_name().as_os_str()) {
                continue;
            }
            let _ = fs::remove_file(entry.path());
        }
    }
    let tmp = PathBuf::from(format!("{}.tmp", path.display()));
    fs::write(&tmp, bytes).map_err(|error| {
        err_parts("IO", &[tmp.display().to_string(), error.to_string()])
    })?;
    fs::rename(&tmp, path).map_err(|error| {
        err_parts("IO", &[path.display().to_string(), error.to_string()])
    })?;
    Ok(bytes.len() as u64)
}

/// 把安装包下到缓存目录，返回落盘字节数。
///
/// 验签在插件的 `download` 内部就做了，走到这里的字节一定是当前公钥认过的。
/// 字节只在这一趟短暂存在，落盘即释放——插件自带的 `download` 命令会把整包
/// 攥在资源表里直到 `close`，那份常驻内存就是这么省掉的。
#[tauri::command]
pub async fn update_download_cached(
    webview: tauri::Webview,
    app: AppHandle,
    rid: tauri::ResourceId,
    on_event: Channel<CacheDownloadEvent>,
) -> Result<u64, String> {
    let update = webview
        .resources_table()
        .get::<Update>(rid)
        .map_err(|error| err("UPDATE_RID", error))?;
    let update = (*update).clone();
    let path = cache_path(&app, &update.version)?;
    let mut first_chunk = true;
    let bytes = update
        .download(
            |chunk_length, content_length| {
                if first_chunk {
                    first_chunk = false;
                    let _ = on_event.send(CacheDownloadEvent::Started { content_length });
                }
                let _ = on_event.send(CacheDownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(CacheDownloadEvent::Finished);
            },
        )
        .await
        .map_err(|error| err("UPDATE_DOWNLOAD", error))?;
    block(move || write_cache_and_prune(&path, &bytes)).await
}

/// 从缓存装包，装的是这个句柄自己那一版。
///
/// 版本不另收参数：缓存文件名与验签用的版本号都从 `Update` 上取，两边不可能对不到
/// 另一版去。Windows 上拉起安装器后当前进程直接退出；macOS 与 Linux 由调用方再请求重启。
#[tauri::command]
pub async fn update_install_cached(
    webview: tauri::Webview,
    app: AppHandle,
    rid: tauri::ResourceId,
) -> Result<(), String> {
    let update = webview
        .resources_table()
        .get::<Update>(rid)
        .map_err(|error| err("UPDATE_RID", error))?;
    let update = (*update).clone();
    let path = cache_path(&app, &update.version)?;
    let read_path = path.clone();
    let pubkey = updater_pubkey(&app)?;
    let require_signed_version =
        updater_flag(&app, "requireSignedVersion", "require-signed-version");
    let signature = update.signature.clone();
    let announced = update.version.clone();
    let bytes = block(
        move || match fs::read(&read_path) {
            Ok(bytes) => Ok(bytes),
            Err(error) => Err(err_parts("IO", &[read_path.display().to_string(), error.to_string()])),
        },
    )
    .await?;
    if let Err(error) = verify_package(
        &bytes,
        &signature,
        &pubkey,
        &announced,
        require_signed_version,
    ) {
        // 盘上这份对不上清单：删掉它，让上层按「没缓存」重下一遍，别每次启动都撞同一份坏包。
        let _ = block(move || match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(cleanup) if cleanup.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(cleanup) => Err(err_parts("IO", &[
                path.display().to_string(),
                cleanup.to_string(),
            ])),
        })
        .await;
        return Err(error);
    }
    update
        .install(&bytes)
        .map_err(|error| err("UPDATE_INSTALL", error))
}

/// 这一版在缓存里吗；在就返回字节数。
#[tauri::command]
pub async fn update_cache_state(app: AppHandle, version: String) -> Result<Option<u64>, String> {
    let path = cache_path(&app, &version)?;
    Ok(block_value(
        move || fs::metadata(&path).ok().map(|meta| meta.len()),
        || None,
    )
    .await)
}

/// 删掉某一版的缓存；文件本来就不存在不算错。
#[tauri::command]
pub async fn update_cache_remove(app: AppHandle, version: String) -> Result<(), String> {
    let path = cache_path(&app, &version)?;
    block(move || match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(err_parts("IO", &[
            path.display().to_string(),
            error.to_string(),
        ])),
    })
    .await
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

    /// 版本号直接决定缓存落在哪，清单又可能来自镜像代理，越界的写法必须整条拒。
    #[test]
    fn cache_version_whitelist() {
        for ok in ["1.2.3", "v1.2.3", "1.0.2-beta.1", "1.2.3+build.1", "1_2"] {
            assert!(version_is_safe(ok), "{ok} 该放行");
        }
        for bad in [
            "", "..", "../evil", "..\\evil", "1.2/3", "a\\b", "1.2 3", "1.2:3", "/abs", "*",
        ] {
            assert!(!version_is_safe(bad), "{bad} 该拒");
        }
    }

    #[test]
    fn trusted_comment_carries_version() {
        let comment = "timestamp:1700000000\tfile:Forge_setup.exe\tversion:1.2.3";
        assert_eq!(signed_version(comment), Some("1.2.3"));
        assert_eq!(signed_version("timestamp:1700000000"), None);
    }

    /// 清单与签名两边都可能带或不带 `v`，同一版要认成同一版。
    #[test]
    fn signed_version_matches_announced() {
        assert!(versions_match("1.2.3", "1.2.3"));
        assert!(versions_match("v1.2.3", "1.2.3"));
        assert!(versions_match("1.2.3", "v1.2.3"));
        assert!(!versions_match("1.2.3", "1.2.4"));
        assert!(!versions_match("1.0.2", "9.9.9"));
    }
}
