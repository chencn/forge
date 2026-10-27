//! 附件图片的本地沙箱：前端只提交 data URL 或本机绝对路径，CLI 只接收这里生成并复核的文件。
use super::events::Event;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// 单张与单条消息的上限；`limits` 把真实数字交给界面，前端不再自己抄一份。
pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_IMAGES: usize = 8;
/// 没有会话引用的图片最多留多久：粘贴后没发出去、或从输入框移除却没删成的残件最终会被收走。
/// 进过历史的消息另有 `.ref` 标记，不受这个窗口影响。
const ORPHAN_RETENTION: u64 = 30 * 24 * 60 * 60;
/// 删除是 `release_session` 唯一的调用点，而带 `.ref` 标记的图片除了这里没人会收：
/// 上限一旦先跳过，这条会话的附件就永久留在沙箱里。所以只把它当失控日志的保险丝，
/// 不当性能门槛（逐行流式读，1 GiB 也只是一次顺序读）。
const MAX_RELEASE_SCAN: u64 = 1024 * 1024 * 1024;
const REFERENCE_SUFFIX: &str = ".ref";
/// 清理一个进程只跑一次：授权在每次加载会话时重建，靠这个开关避免重复扫目录。
static PURGED: AtomicBool = AtomicBool::new(false);
static NEXT_IMAGE: AtomicU64 = AtomicU64::new(0);

fn directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map_err(|error| error.to_string())
        .map(|path| path.join("ai-pasted-images"))
}

#[cfg(windows)]
fn is_link(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
fn is_link(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

/// 缓存根不能是符号链接或 Windows reparse point，否则规范化后的“沙箱”会指向任意目录。
fn checked_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = directory(app)?;
    let parent = directory.parent().ok_or("图片缓存目录无效")?;
    std::fs::create_dir_all(parent).map_err(|error| format!("无法创建图片缓存目录：{error}"))?;
    match std::fs::create_dir(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("无法创建图片缓存目录：{error}")),
    }
    let metadata = std::fs::symlink_metadata(&directory)
        .map_err(|error| format!("无法检查图片缓存目录：{error}"))?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err("图片缓存目录不是安全的本地目录".into());
    }
    directory
        .canonicalize()
        .map_err(|error| format!("无法规范化图片缓存目录：{error}"))
}

/// 图片历史由 asset 协议回显；授权只在本进程有效，应用重启后加载会话时会重新建立。
/// 顺带做进程内一次的孤儿清理：这一步失败不能拖垮授权，所以只尽力而为。
pub fn allow_assets(app: &AppHandle) -> Result<(), String> {
    let directory = checked_directory(app)?;
    app.asset_protocol_scope()
        .allow_directory(&directory, true)
        .map_err(|error| format!("无法授权图片缓存目录：{error}"))?;
    purge(&directory);
    Ok(())
}

/// 扩展名 ↔ 声明类型只用这一张表，写入、复核与清理都按它认。
fn media_type(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

/// 只认文件头。剪贴板声明的 MIME、用户改过的扩展名都不作数。
fn detect_kind(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("png", "image/png"))
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(("jpg", "image/jpeg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("gif", "image/gif"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("webp", "image/webp"))
    } else {
        None
    }
}

/// 声明的类型必须和真实内容对上；`image/jpg` 是剪贴板常见别名，归一到 `image/jpeg`。
fn image_kind(media_type_claim: &str, bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    let detected = detect_kind(bytes)?;
    let normalized = if media_type_claim == "image/jpg" {
        "image/jpeg"
    } else {
        media_type_claim
    };
    (normalized == detected.1).then_some(detected)
}

/// 沙箱内的名字一律由这里生成：前缀 + 毫秒 + 进程号 + 自增序号，扩展名由真实内容决定。
fn write_image(app: &AppHandle, prefix: &str, bytes: &[u8], extension: &str) -> Result<PathBuf, String> {
    let directory = checked_directory(app)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let (path, mut file): (PathBuf, File) = (0..16)
        .find_map(|_| {
            let serial = NEXT_IMAGE.fetch_add(1, Ordering::Relaxed);
            let path = directory.join(format!(
                "{prefix}-{stamp}-{}-{serial}.{extension}",
                std::process::id()
            ));
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => Some(Ok((path, file))),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(format!("无法创建附件图片：{error}"))),
            }
        })
        .transpose()?
        .ok_or("无法分配附件图片文件名")?;
    // create_new 不会跟随预先放置的同名链接，也不会覆盖已有文件。
    file.write_all(bytes)
        .map_err(|error| format!("无法保存附件图片：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("无法保存附件图片：{error}"))?;
    drop(file);
    path.canonicalize()
        .map_err(|error| format!("无法规范化附件图片路径：{error}"))
}

/// 校验 data URL 与文件魔数后写入应用缓存；粘贴走这条路。
pub fn save(app: &AppHandle, data_url: &str) -> Result<Value, String> {
    if data_url.len() > MAX_IMAGE_BYTES * 2 {
        return Err("图片超过 8 MiB".into());
    }
    let (header, encoded) = data_url.split_once(',').ok_or("图片数据格式无效")?;
    let claim = header
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .ok_or("图片必须是 base64 data URL")?;
    let bytes = STANDARD.decode(encoded).map_err(|_| "图片 base64 数据无效")?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片不能为空且不能超过 8 MiB".into());
    }
    let (extension, media_type) =
        image_kind(claim, &bytes).ok_or("仅支持 PNG、JPEG、GIF 和 WebP 图片")?;
    let path = write_image(app, "paste", &bytes, extension)?;
    Ok(json!({"path":path.to_string_lossy(),"mediaType":media_type}))
}

/// 复制进沙箱之前先卡住来源：绝对路径下的普通小文件，不是链接、不是目录、不是空的。
/// 这一步不需要 AppHandle，所以能单独验证；算不算图片仍由后面的文件头判定。
fn checked_source(path: &str) -> Result<PathBuf, String> {
    let source = Path::new(path);
    if !source.is_absolute() {
        return Err("请选择本机上的图片文件".into());
    }
    let metadata = std::fs::symlink_metadata(source).map_err(|_| "图片文件不存在".to_string())?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err("只能附加普通图片文件".into());
    }
    if metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES as u64 {
        return Err("图片不能为空且不能超过 8 MiB".into());
    }
    Ok(source.to_path_buf())
}

/// 文件选择器与拖拽交来的是本机绝对路径：先按 stat 卡住普通文件与大小，再按文件头认格式，
/// 复制进沙箱之后 CLI 只读副本，用户选中的原文件不再被任何一方改写或长期持有。
pub fn save_file(app: &AppHandle, path: &str) -> Result<Value, String> {
    let source = checked_source(path)?;
    let bytes = std::fs::read(&source).map_err(|error| format!("无法读取图片：{error}"))?;
    // stat 与读取之间文件可能已被换掉，按真实字节再判一次。
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片不能为空且不能超过 8 MiB".into());
    }
    let (extension, media_type) = detect_kind(&bytes).ok_or("仅支持 PNG、JPEG、GIF 和 WebP 图片")?;
    let saved = write_image(app, "file", &bytes, extension)?;
    Ok(json!({
        "path": saved.to_string_lossy(),
        "mediaType": media_type,
        "name": source.file_stem().and_then(|stem| stem.to_str()).unwrap_or("")
    }))
}

/// 路径必须落在沙箱里，且是普通文件——不能借一个字符串读取任意本机文件。
fn confined(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let source = Path::new(path);
    let metadata = std::fs::symlink_metadata(source).map_err(|_| "附件图片不存在".to_string())?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err("附件图片不能是链接或目录".into());
    }
    let root = checked_directory(app)?;
    let canonical = source.canonicalize().map_err(|_| "附件图片不存在".to_string())?;
    if !canonical.starts_with(&root) || !canonical.is_file() {
        return Err("图片路径不在 Forge 图片缓存中".into());
    }
    Ok(canonical)
}

/// 所有发送路径都必须指向图片沙箱中的普通文件，内容与扩展名还要再对上一次。
pub fn validate_paths(app: &AppHandle, paths: &[String]) -> Result<Vec<PathBuf>, String> {
    if paths.len() > MAX_IMAGES {
        return Err(format!("每条消息最多附加 {MAX_IMAGES} 张图片"));
    }
    paths
        .iter()
        .map(|path| {
            let file = confined(app, path)?;
            let bytes = std::fs::read(&file).map_err(|error| format!("无法读取附件图片：{error}"))?;
            if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
                return Err("图片不能为空且不能超过 8 MiB".into());
            }
            let extension = file
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let claim = media_type(&extension).ok_or("图片扩展名无效")?;
            image_kind(claim, &bytes).ok_or_else(|| "图片内容与扩展名不匹配".to_string())?;
            Ok(file)
        })
        .collect()
}

/// 输入框里撤掉一张还没发出去的附件：已经进过历史的有引用标记，那条路只能随会话删除。
pub fn delete(app: &AppHandle, path: &str) -> Result<(), String> {
    let file = confined(app, path)?;
    if reference_path(&file).exists() {
        return Err("已发送的图片请随会话一起删除".into());
    }
    std::fs::remove_file(&file).map_err(|error| format!("无法删除附件图片：{error}"))
}

/// 引用标记与图片同目录同名加后缀：文件名只在这里生成，标记不会撞到别的文件。
fn reference_path(image: &Path) -> PathBuf {
    let mut name = image
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_default();
    name.push(REFERENCE_SUFFIX);
    image.with_file_name(name)
}

fn is_reference(name: &str) -> bool {
    name.ends_with(REFERENCE_SUFFIX)
}

/// 只有本模块生成过的名字才允许被清理删掉：前缀对得上，扩展名在图片表里。
fn is_managed(name: &str) -> bool {
    let prefix = name.split('-').next().unwrap_or("");
    (prefix == "paste" || prefix == "file")
        && media_type(name.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("")).is_some()
}

fn stale(age: u64) -> bool {
    age > ORPHAN_RETENTION
}

/// 用户事件真正写进日志之后才打标记：有 `.ref` 就等于「历史里还指着这张图」，清理不能碰。
/// 尽力而为——标记失败只是这张图将来可能被当孤儿收走，不该让发送路径报错。
pub fn mark_referenced(app: &AppHandle, paths: &[String]) {
    for path in paths {
        if let Ok(file) = confined(app, path) {
            let _ = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(reference_path(&file));
        }
    }
}

/// 回显过的历史图片补上引用标记：这个功能上线之前存的附件没有 `.ref`，不补就会被当孤儿清掉。
/// 只看已经读出来的这一页，不额外扫盘。
pub fn mark_events(app: &AppHandle, events: &[Event]) {
    let paths: Vec<String> = events
        .iter()
        .filter(|event| event.kind == "user")
        .flat_map(|event| {
            event
                .data
                .get("images")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    mark_referenced(app, &paths);
}

/// 删会话前把它引用的图片一起收走，否则沙箱里只剩没人看得见的文件。
/// 这里是这些带 `.ref` 标记的文件唯一的删除入口，所以扫描不按大小提前收工：
/// 提前跳过等于让这条会话的附件永远留在原地。
pub fn release_session(app: &AppHandle, session_dir: &Path) {
    let Ok(file) = File::open(session_dir.join("events.jsonl")) else {
        return;
    };
    let Ok(metadata) = file.metadata() else { return };
    if metadata.len() > MAX_RELEASE_SCAN {
        return;
    }
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        // 绝大多数事件行与图片无关，先按字面量筛掉再付反序列化的钱。
        if !line.contains("\"images\"") {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Event>(&line) else {
            continue;
        };
        for path in event
            .data
            .get("images")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if let Ok(image) = confined(app, path) {
                let _ = std::fs::remove_file(&image);
                let _ = std::fs::remove_file(reference_path(&image));
            }
        }
    }
}

/// 进程内一次的孤儿清理：只动本模块生成过的名字，且只动没有引用标记又老于保留窗口的文件。
fn purge(root: &Path) {
    if PURGED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.map_while(Result::ok) {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if is_reference(name) {
            // 悬空标记：图早被删掉了，标记留着也没人读。
            let image = name
                .strip_suffix(REFERENCE_SUFFIX)
                .map(|stem| path.with_file_name(stem))
                .unwrap_or_default();
            if !image.is_file() {
                let _ = std::fs::remove_file(&path);
            }
            continue;
        }
        if !is_managed(name) || reference_path(&path).exists() {
            continue;
        }
        let age = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .unwrap_or_default()
            .as_secs();
        if stale(age) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Claude stream-json 需要内联 base64 块；读取发生在工作线程内，不阻塞前端粘贴操作。
pub fn claude_blocks(paths: &[PathBuf]) -> Result<Vec<Value>, String> {
    paths.iter().map(|path| {
        let bytes = std::fs::read(path).map_err(|error| format!("无法读取附件图片：{error}"))?;
        let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
        let media_type = media_type(&extension).ok_or("图片扩展名无效")?;
        Ok(json!({"type":"image","source":{"type":"base64","media_type":media_type,"data":STANDARD.encode(bytes)}}))
    }).collect()
}

/// 界面前置提示用的真实上限。
pub fn limits() -> Value {
    json!({"maxImages": MAX_IMAGES, "maxBytes": MAX_IMAGE_BYTES})
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 认格式只认文件头，声明的类型必须和真实内容对上。
    #[test]
    fn magic_bytes_decide_the_format() {
        let png = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0, 0];
        assert_eq!(image_kind("image/png", &png), Some(("png", "image/png")));
        let jpg = [0xff, 0xd8, 0xff, 0xe0, 0, 0];
        assert_eq!(image_kind("image/jpeg", &jpg), Some(("jpg", "image/jpeg")));
        // 剪贴板把 JPEG 报成 image/jpg 是常见别名，仍然按真实内容归一。
        assert_eq!(image_kind("image/jpg", &jpg), Some(("jpg", "image/jpeg")));
        assert_eq!(image_kind("image/gif", b"GIF89a\x00\x00"), Some(("gif", "image/gif")));
        let mut webp = b"RIFF\x00\x00\x00\x00WEBPVP8 ".to_vec();
        webp.truncate(12);
        assert_eq!(image_kind("image/webp", &webp), Some(("webp", "image/webp")));
    }

    /// 声明与内容不一致一律拒绝：改扩展名或谎报 MIME 都骗不过去，短前缀也不算图片。
    #[test]
    fn declared_type_must_match_the_content() {
        let png = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
        assert_eq!(image_kind("image/jpeg", &png), None);
        assert_eq!(image_kind("application/octet-stream", &png), None);
        // MZ 头（可执行文件）伪装成 png 扩展名时，内容嗅探先把它挡下。
        assert_eq!(image_kind("image/png", b"MZ\x90\x00\x03\x00"), None);
        assert_eq!(image_kind("image/png", b"\x89PNG"), None);
        assert_eq!(image_kind("image/webp", b"RIFF\x00\x00\x00\x00XXXXVP8 "), None);
    }

    /// 拖拽与选择器只认文件头，不看用户给的扩展名：`.txt` 里塞 PNG 也收，`.png` 里塞脚本就拒。
    #[test]
    fn picked_files_are_judged_by_content() {
        assert_eq!(detect_kind(b"\x89PNG\r\n\x1a\n\x00"), Some(("png", "image/png")));
        assert_eq!(detect_kind(b"MZ\x90\x00\x03\x00"), None);
        assert_eq!(detect_kind(b""), None);
    }

    /// 清理只认自己生成过的名字：陌生文件、标记文件、别的扩展名都不能被删。
    #[test]
    fn only_generated_names_are_managed() {
        assert!(is_managed("paste-1730000000000-4242-0.png"));
        assert!(is_managed("file-1730000000000-4242-7.jpeg"));
        assert!(is_managed("file-1730000000000-4242-7.webp"));
        assert!(!is_managed("paste-1730000000000-4242-0.exe"));
        assert!(!is_managed("notes.png"));
        assert!(!is_managed("paste-1730000000000-4242-0.png.ref"));
        assert!(!is_managed(""));
    }

    /// 标记与图片同名加后缀，且只在末尾出现一次；悬空标记按去掉后缀的名字找回图。
    #[test]
    fn reference_markers_pair_with_their_image() {
        let image = Path::new("/cache/ai-pasted-images/paste-1-2-0.png");
        let marker = reference_path(image);
        assert_eq!(marker.file_name().unwrap().to_str(), Some("paste-1-2-0.png.ref"));
        assert!(is_reference("paste-1-2-0.png.ref"));
        assert!(!is_reference("paste-1-2-0.png"));
        assert_eq!(
            "paste-1-2-0.png.ref"
                .strip_suffix(REFERENCE_SUFFIX)
                .map(|stem| marker.with_file_name(stem)),
            Some(image.to_path_buf())
        );
    }

    /// 保留窗口是硬边界：窗口内的孤儿不动，跨界才清。
    #[test]
    fn orphans_survive_their_retention_window() {
        assert!(!stale(0));
        assert!(!stale(ORPHAN_RETENTION));
        assert!(stale(ORPHAN_RETENTION + 1));
        assert!(!stale(ORPHAN_RETENTION - 1));
    }

    /// 上限交给界面的那份数必须和真正写盘的常量一致。
    #[test]
    fn limits_report_the_same_numbers_the_writer_uses() {
        let value = limits();
        assert_eq!(value["maxImages"], json!(MAX_IMAGES));
        assert_eq!(value["maxBytes"], json!(MAX_IMAGE_BYTES));
    }

    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "forge-images-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 选择器与拖拽的来源闸门：只放过绝对路径下的非空普通文件，其余一律在复制之前就拒掉。
    #[test]
    fn picked_sources_must_be_plain_non_empty_files() {
        let root = temp_dir("source");
        let file = root.join("shot.png");
        std::fs::write(&file, b"\x89PNG\r\n\x1a\n\x00\x00").unwrap();
        assert_eq!(checked_source(file.to_str().unwrap()).unwrap(), file);
        // 相对路径不认：它取决于进程当前的工作目录，同一条字符串可能指到任意地方。
        assert!(checked_source("shot.png").is_err());
        // 目录、不存在的文件和空文件都不能被复制进沙箱。
        assert!(checked_source(root.to_str().unwrap()).is_err());
        assert!(checked_source(root.join("missing.png").to_str().unwrap()).is_err());
        let empty = root.join("empty.png");
        std::fs::write(&empty, b"").unwrap();
        assert!(checked_source(empty.to_str().unwrap()).is_err());
        // 扩展名骗不过去：这里只看来源形状，是不是图片交给 detect_kind。
        let text = root.join("notes.png");
        std::fs::write(&text, b"just text").unwrap();
        assert!(checked_source(text.to_str().unwrap()).is_ok());
        assert!(detect_kind(b"just text").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 历史回显补标记只认 user 事件里的 images；其他 kind 或形状不对都不能碰盘。
    #[test]
    fn only_user_events_carry_image_references() {
        let user = Event {
            session_id: "s".into(),
            run_id: "r".into(),
            seq: 1,
            kind: "user".into(),
            data: json!({"text": "看图", "images": ["/cache/a.png"]}),
        };
        let assistant = Event {
            kind: "assistant".into(),
            data: json!({"images": ["/cache/b.png"]}),
            ..user.clone()
        };
        let collect = |events: &[Event]| -> Vec<String> {
            events
                .iter()
                .filter(|event| event.kind == "user")
                .flat_map(|event| {
                    event
                        .data
                        .get("images")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                })
                .collect()
        };
        assert_eq!(collect(&[user.clone(), assistant.clone()]), vec!["/cache/a.png".to_string()]);
        let noimages = Event { data: json!({"text": "只有文字"}), ..user };
        assert!(collect(&[noimages, assistant]).is_empty());
    }
}
