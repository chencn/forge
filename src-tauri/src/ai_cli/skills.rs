//! Claude Code / Codex 的全局 Skills 管理。
//!
//! 技能就是 `<skills 根目录>/<id>/SKILL.md`。这里只读写用户级目录，
//! 项目级 `.claude/skills` / `.codex/skills` 留给仓库自己管理。
use super::{home, Provider};
use crate::offload::block;
use crate::sys::write_atomic;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const MAX_CONTENT: usize = 256 * 1024;
const MAX_READ: usize = 512 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLocation {
    /// `claude` / `codex` / `agents`；前端据此显示名称。
    pub id: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillItem {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub location: String,
    pub path: String,
    pub updated: Option<u64>,
    /// 技能目录是符号链接（常见于把共享技能库链接进 ~/.claude/skills）。
    /// 删除时只移除链接本身，不碰源目录。
    pub linked: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillList {
    pub locations: Vec<SkillLocation>,
    pub skills: Vec<SkillItem>,
}

fn claude_home() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).filter(|path| path.is_absolute()) {
        return Ok(dir);
    }
    Ok(home()?.join(".claude"))
}

fn codex_home() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("CODEX_HOME").map(PathBuf::from).filter(|path| path.is_absolute()) {
        return Ok(dir);
    }
    Ok(home()?.join(".codex"))
}

fn locations(provider: Provider) -> Result<Vec<SkillLocation>, String> {
    match provider {
        Provider::Claude => Ok(vec![SkillLocation {
            id: "claude".into(),
            path: claude_home()?.join("skills").to_string_lossy().into_owned(),
        }]),
        Provider::Codex => Ok(vec![
            SkillLocation { id: "codex".into(), path: codex_home()?.join("skills").to_string_lossy().into_owned() },
            // 与 Codex、Cursor 等共用的用户级技能库；Codex 也会扫描这里。
            SkillLocation { id: "agents".into(), path: home()?.join(".agents/skills").to_string_lossy().into_owned() },
        ]),
    }
}

fn find_location(provider: Provider, id: &str) -> Result<SkillLocation, String> {
    locations(provider)?.into_iter().find(|item| item.id == id).ok_or_else(|| "未知的 Skills 目录".to_string())
}

/// 只接受适合当目录名的 id，顺便挡住 `../` 之类的路径穿越。
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64
        && id.bytes().next().is_some_and(|byte| byte.is_ascii_alphanumeric())
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// 目录本身是链接（符号链接，或 Windows 的 junction）。
/// Windows 上 junction 不会被 `FileType::is_symlink` 识别，但同样是 reparse point，
/// 删除时绝不能递归进去，否则会把共享技能库的源文件一起删掉。
fn is_linked(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        fs::symlink_metadata(path).is_ok_and(|meta| meta.file_attributes() & 0x400 != 0)
    }
    #[cfg(not(windows))]
    {
        fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
    }
}

fn parse_front_matter(content: &str) -> (Option<String>, Option<String>) {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let mut name = None;
    let mut description = None;
    for line in lines.take(64) {
        let line = line.trim();
        if line == "---" {
            break;
        }
        let value = |prefix: &str| line.strip_prefix(prefix).map(|rest| rest.trim().trim_matches('"').trim_matches('\'').to_string()).filter(|rest| !rest.is_empty());
        if name.is_none() {
            name = value("name:");
        }
        if description.is_none() {
            description = value("description:");
        }
    }
    (name, description)
}

fn read_item(location: &SkillLocation, id: &str, dir: &Path) -> Option<SkillItem> {
    let file = dir.join("SKILL.md");
    if !file.is_file() {
        return None;
    }
    let content = fs::read_to_string(&file).ok()?;
    let (name, description) = parse_front_matter(&content);
    let updated = fs::metadata(&file).ok().and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|value| value.as_secs());
    Some(SkillItem {
        id: id.to_string(),
        name: name.unwrap_or_else(|| id.to_string()),
        description,
        location: location.id.clone(),
        path: file.to_string_lossy().into_owned(),
        updated,
        linked: is_linked(dir),
    })
}

fn list_at(locations: &[SkillLocation]) -> SkillList {
    let mut skills = Vec::new();
    for location in locations {
        let Ok(entries) = fs::read_dir(&location.path) else { continue };
        for entry in entries.flatten() {
            let id = entry.file_name().to_string_lossy().into_owned();
            if id.starts_with('.') || !valid_id(&id) {
                continue;
            }
            // DirEntry::metadata 不跟随链接，必须用 fs::metadata 才能识别共享技能库的目录链接。
            let Ok(meta) = fs::metadata(entry.path()) else { continue };
            if !meta.is_dir() {
                continue;
            }
            if let Some(item) = read_item(location, &id, &entry.path()) {
                skills.push(item);
            }
        }
    }
    skills.sort_by(|a, b| a.id.cmp(&b.id).then(a.location.cmp(&b.location)));
    SkillList { locations: locations.to_vec(), skills }
}

fn read_skill(provider: Provider, location: &str, id: &str) -> Result<String, String> {
    if !valid_id(id) {
        return Err("技能 ID 只能包含字母、数字、- 和 _".into());
    }
    let location = find_location(provider, location)?;
    let file = Path::new(&location.path).join(id).join("SKILL.md");
    let meta = fs::symlink_metadata(&file).map_err(|error| format!("技能不存在：{error}"))?;
    if meta.len() as usize > MAX_READ || !meta.is_file() {
        return Err("技能文件过大或不是普通文件".into());
    }
    fs::read_to_string(&file).map_err(|error| format!("读取技能失败：{error}"))
}

fn ensure_writable(location: &SkillLocation, id: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(&location.path);
    fs::create_dir_all(&root).map_err(|error| format!("无法创建技能目录：{error}"))?;
    let dir = root.join(id);
    // metadata 会跟随链接：共享技能库常通过目录链接挂进来，允许写穿到源目录。
    match fs::metadata(&dir) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err("同名技能路径不是目录，拒绝覆盖".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&dir).map_err(|error| format!("无法创建技能目录：{error}"))?;
        }
        Err(error) => return Err(format!("无法访问技能目录：{error}")),
    }
    let file = dir.join("SKILL.md");
    if let Ok(meta) = fs::symlink_metadata(&file) {
        if meta.file_type().is_symlink() {
            return Err("技能文件是符号链接，拒绝写入".into());
        }
        if !meta.is_file() {
            return Err("技能路径不是普通文件，拒绝写入".into());
        }
    }
    Ok(dir)
}

fn save_at(location: &SkillLocation, id: &str, content: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("技能 ID 只能包含字母、数字、- 和 _".into());
    }
    if content.trim().is_empty() {
        return Err("技能内容不能为空".into());
    }
    if content.len() > MAX_CONTENT {
        return Err("技能内容不能超过 256 KB".into());
    }
    let dir = ensure_writable(location, id)?;
    write_atomic(&dir.join("SKILL.md"), content)
}

fn delete_at(location: &SkillLocation, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("技能 ID 只能包含字母、数字、- 和 _".into());
    }
    let dir = Path::new(&location.path).join(id);
    let meta = fs::symlink_metadata(&dir).map_err(|_| "技能不存在".to_string())?;
    if is_linked(&dir) {
        // 共享技能库的链接：只摘链接，源目录必须原样保留。
        fs::remove_file(&dir).or_else(|_| fs::remove_dir(&dir))
            .map_err(|error| format!("删除技能链接失败：{error}"))
    } else if meta.is_dir() {
        fs::remove_dir_all(&dir).map_err(|error| format!("删除技能失败：{error}"))
    } else {
        Err("技能路径不是目录，拒绝删除".into())
    }
}

fn save_skill(provider: Provider, location: &str, id: &str, content: &str) -> Result<SkillList, String> {
    let location = find_location(provider, location)?;
    save_at(&location, id, content)?;
    Ok(list_at(&locations(provider)?))
}

fn delete_skill(provider: Provider, location: &str, id: &str) -> Result<SkillList, String> {
    let location = find_location(provider, location)?;
    delete_at(&location, id)?;
    Ok(list_at(&locations(provider)?))
}

#[tauri::command]
pub async fn ai_skills_list(provider: Provider) -> Result<SkillList, String> {
    block(move || Ok(list_at(&locations(provider)?))).await
}

#[tauri::command]
pub async fn ai_skill_read(provider: Provider, location: String, id: String) -> Result<String, String> {
    block(move || read_skill(provider, &location, &id)).await
}

#[tauri::command]
pub async fn ai_skill_save(provider: Provider, location: String, id: String, content: String) -> Result<SkillList, String> {
    block(move || save_skill(provider, &location, &id, &content)).await
}

#[tauri::command]
pub async fn ai_skill_delete(provider: Provider, location: String, id: String) -> Result<SkillList, String> {
    block(move || delete_skill(provider, &location, &id)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_location() -> SkillLocation {
        let stamp = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("forge-skills-{}-{stamp}", std::process::id()));
        SkillLocation { id: "test".into(), path: path.to_string_lossy().into_owned() }
    }

    #[test]
    fn rejects_path_like_ids() {
        for id in ["", ".", "..", "../escape", "a/b", "a\\b", "-leading", "中文"] {
            assert!(!valid_id(id), "{id}");
        }
        for id in ["my-skill", "skill_1", "A1"] {
            assert!(valid_id(id), "{id}");
        }
    }

    #[test]
    fn parses_front_matter_name_and_description() {
        let (name, description) = parse_front_matter("---\nname: Demo Skill\ndescription: \"Does things\"\n---\n# Body");
        assert_eq!(name.as_deref(), Some("Demo Skill"));
        assert_eq!(description.as_deref(), Some("Does things"));
        assert_eq!(parse_front_matter("# No front matter").0, None);
        assert_eq!(parse_front_matter("\u{feff}---\nname: Bom\n---\nBody").0.as_deref(), Some("Bom"));
    }

    #[test]
    fn writes_lists_and_deletes_skills() {
        let location = temp_location();
        let root = PathBuf::from(&location.path);
        save_at(&location, "demo", "---\nname: Demo\ndescription: Desc\n---\nBody").unwrap();
        fs::write(root.join("flat.md"), "not a directory skill").unwrap();

        let list = list_at(std::slice::from_ref(&location));
        assert_eq!(list.skills.len(), 1);
        assert_eq!(list.skills[0].name, "Demo");
        assert_eq!(list.skills[0].description.as_deref(), Some("Desc"));
        assert!(!list.skills[0].linked);

        delete_at(&location, "demo").unwrap();
        assert!(list_at(std::slice::from_ref(&location)).skills.is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn linked_skill_dirs_are_listed_written_through_and_delete_only_the_link() {
        let source = temp_location();
        save_at(&source, "demo", "---\nname: Demo\n---\nBody").unwrap();
        let target = temp_location();
        fs::create_dir_all(&target.path).unwrap();
        let source_dir = Path::new(&source.path).join("demo");
        let link = Path::new(&target.path).join("demo");
        let created = {
            #[cfg(unix)]
            { std::os::unix::fs::symlink(&source_dir, &link).is_ok() }
            #[cfg(windows)]
            { std::os::windows::fs::symlink_dir(&source_dir, &link).is_ok() }
            #[cfg(not(any(unix, windows)))]
            { false }
        };
        if created {
            let list = list_at(std::slice::from_ref(&target));
            assert_eq!(list.skills.len(), 1);
            assert!(list.skills[0].linked);

            save_at(&target, "demo", "---\nname: Demo 2\n---\nUpdated").unwrap();
            assert!(fs::read_to_string(source_dir.join("SKILL.md")).unwrap().contains("Updated"));

            delete_at(&target, "demo").unwrap();
            assert!(fs::symlink_metadata(&link).is_err());
            assert!(source_dir.join("SKILL.md").is_file());
        }
        let _ = fs::remove_dir_all(&source.path);
        let _ = fs::remove_dir_all(&target.path);
    }

    /// Windows junction 是 reparse point，但 `FileType::is_symlink` 认不出来。
    /// 漏判的代价是把共享技能库当成普通目录递归删掉，所以这里用真实的 `mklink /J` 验证。
    #[test]
    #[cfg(windows)]
    fn junction_backed_skill_only_loses_the_link() {
        let source = temp_location();
        save_at(&source, "demo", "---\nname: Demo\n---\nBody").unwrap();
        let target = temp_location();
        fs::create_dir_all(&target.path).unwrap();
        let source_dir = Path::new(&source.path).join("demo");
        let link = Path::new(&target.path).join("demo");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&source_dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        assert!(made, "这台机器上建不出 junction，测试无法验证删除语义");

        assert!(is_linked(&link), "junction 必须识别成链接，否则删除会连源目录一起清掉");
        let list = list_at(std::slice::from_ref(&target));
        assert_eq!(list.skills.len(), 1);
        assert!(list.skills[0].linked);

        delete_at(&target, "demo").unwrap();
        assert!(fs::symlink_metadata(&link).is_err());
        assert!(source_dir.join("SKILL.md").is_file(), "源目录必须原样保留");

        let _ = fs::remove_dir_all(&source.path);
        let _ = fs::remove_dir_all(&target.path);
    }


}
