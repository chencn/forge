//! Maven 工程探测。
//!
//! 只回答工具窗口要画的那棵树：反应堆、模块、生命周期之外的坐标、直接依赖、
//! 配置文件里写明的 profile。不跑 Maven 进程，所以工程打开时可以放到空闲之后再扫。
//! 依赖树的冲突调解留给真正执行 `dependency:tree` 的那次构建，这里读的是 pom 里声明的那一层。

use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_POM_BYTES: u64 = 2 * 1024 * 1024;
const MAX_MODULES: usize = 400;
const MAX_DEPTH: usize = 24;
const MAX_WALK_ENTRIES: usize = 800;
const MAX_REACTOR_DEPTH: usize = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MavenSourceRoot {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MavenDependency {
    pub group_id: String,
    pub artifact_id: String,
    pub version: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MavenProfile {
    pub id: String,
    pub active_by_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MavenModule {
    pub relative_path: String,
    pub artifact_id: String,
    pub group_id: String,
    pub version: String,
    pub packaging: String,
    pub source_roots: Vec<MavenSourceRoot>,
    pub dependencies: Vec<MavenDependency>,
    pub modules: Vec<MavenModule>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MavenProject {
    pub relative_path: String,
    pub artifact_id: String,
    pub group_id: String,
    pub version: String,
    pub packaging: String,
    /// 跑目标时的命令头：工程里的 `mvnw` / `mvnw.cmd`，否则是 `${mvn}` 占位。
    pub invoke: String,
    pub has_wrapper: bool,
    pub profiles: Vec<MavenProfile>,
    pub source_roots: Vec<MavenSourceRoot>,
    pub dependencies: Vec<MavenDependency>,
    pub modules: Vec<MavenModule>,
}

struct El {
    name: String,
    inner: String,
}

/// 工程根上有没有 Maven 反应堆。没有就返回 `Ok(None)`，状态栏不画图标。
#[tauri::command]
pub async fn maven_scan(root: String) -> Result<Option<MavenProject>, String> {
    crate::offload::block(move || scan(Path::new(&root))).await
}

fn scan(root: &Path) -> Result<Option<MavenProject>, String> {
    if !root.is_dir() {
        return Ok(None);
    }
    let Some(reactor) = find_reactor(root) else {
        return Ok(None);
    };
    let mut visited = Vec::new();
    let mut count = 0usize;
    let node = read_module(&reactor, root, &reactor, "", "", 0, &mut visited, &mut count)?;
    let profiles = read_profiles(&reactor)?;
    let (invoke, has_wrapper) = wrapper_invoke(&reactor);
    Ok(Some(MavenProject {
        // 相对工作区，不是相对反应堆。反应堆自己就是打开的那个文件夹时是 "."。
        relative_path: rel_of(root, &reactor),
        artifact_id: node.artifact_id.clone(),
        group_id: node.group_id.clone(),
        version: node.version.clone(),
        packaging: node.packaging.clone(),
        invoke,
        has_wrapper,
        profiles,
        source_roots: node.source_roots,
        dependencies: node.dependencies,
        modules: node.modules,
    }))
}

fn wrapper_invoke(reactor: &Path) -> (String, bool) {
    let (primary, secondary) = if cfg!(windows) {
        ("mvnw.cmd", "mvnw")
    } else {
        ("mvnw", "mvnw.cmd")
    };
    if reactor.join(primary).is_file() {
        let invoke = if cfg!(windows) {
            primary.to_string()
        } else {
            format!("./{primary}")
        };
        return (invoke, true);
    }
    if reactor.join(secondary).is_file() {
        let invoke = if cfg!(windows) {
            secondary.to_string()
        } else {
            format!("./{secondary}")
        };
        return (invoke, true);
    }
    ("${mvn}".to_string(), false)
}

fn find_reactor(root: &Path) -> Option<PathBuf> {
    if root.join("pom.xml").is_file() {
        return Some(root.to_path_buf());
    }
    let mut found = Vec::new();
    let mut walked = 0usize;
    walk_for_pom(root, root, 1, &mut walked, &mut found);
    found.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    found.into_iter().next().map(|(_, _, path)| path)
}

fn walk_for_pom(
    workspace: &Path,
    dir: &Path,
    depth: usize,
    walked: &mut usize,
    found: &mut Vec<(usize, String, PathBuf)>,
) {
    if depth > MAX_REACTOR_DEPTH || *walked > MAX_WALK_ENTRIES {
        return;
    }
    if found.iter().any(|(have, _, _)| *have < depth) {
        return;
    }
    let mut children = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        *walked += 1;
        if *walked > MAX_WALK_ENTRIES {
            break;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if skipped_dir(&name) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            children.push(path);
        }
    }
    children.sort_by(|left, right| {
        let l = left.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let r = right.file_name().and_then(|n| n.to_str()).unwrap_or("");
        l.to_lowercase().cmp(&r.to_lowercase()).then(l.cmp(r))
    });
    for child in &children {
        if child.join("pom.xml").is_file() {
            found.push((depth, rel_of(workspace, child), child.clone()));
        }
    }
    if found.iter().any(|(have, _, _)| *have == depth) {
        return;
    }
    for child in children {
        walk_for_pom(workspace, &child, depth + 1, walked, found);
    }
}

fn skipped_dir(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "node_modules" | "target" | "dist" | "build" | "vendor" | "out" | "coverage"
        )
}

fn read_module(
    dir: &Path,
    workspace: &Path,
    reactor: &Path,
    inherited_group: &str,
    inherited_version: &str,
    depth: usize,
    visited: &mut Vec<PathBuf>,
    count: &mut usize,
) -> Result<MavenModule, String> {
    if depth > MAX_DEPTH || *count >= MAX_MODULES {
        return Err("MAVEN_TOO_LARGE".to_string());
    }
    let canonical = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    if visited.iter().any(|seen| seen == &canonical) {
        return Err("MAVEN_CYCLE".to_string());
    }
    visited.push(canonical);
    *count += 1;

    let text = read_pom(&dir.join("pom.xml"))?;
    let project = project_element(&text).ok_or_else(|| "MAVEN_POM".to_string())?;
    let children = elements(&project);
    let parent = children.iter().find(|el| el.name == "parent");
    let parent_group = parent
        .and_then(|el| child_text(&elements(&el.inner), "groupId"))
        .unwrap_or_default();
    let parent_version = parent
        .and_then(|el| child_text(&elements(&el.inner), "version"))
        .unwrap_or_default();
    let props = properties_map(&children);
    let group = expand(
        &first_nonempty(&[
            child_text(&children, "groupId").unwrap_or_default(),
            parent_group,
            inherited_group.to_string(),
        ]),
        &props,
        inherited_group,
        "",
        inherited_version,
    );
    let version = expand(
        &first_nonempty(&[
            child_text(&children, "version").unwrap_or_default(),
            parent_version,
            inherited_version.to_string(),
        ]),
        &props,
        &group,
        "",
        inherited_version,
    );
    let artifact = {
        let raw = child_text(&children, "artifactId").unwrap_or_default();
        let expanded = expand(&raw, &props, &group, &raw, &version);
        if expanded.is_empty() {
            dir.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("module")
                .to_string()
        } else {
            expanded
        }
    };
    let packaging = {
        let raw = child_text(&children, "packaging").unwrap_or_else(|| "jar".to_string());
        let expanded = expand(&raw, &props, &group, &artifact, &version);
        if expanded.is_empty() {
            "jar".to_string()
        } else {
            expanded
        }
    };
    let version = expand(&version, &props, &group, &artifact, &version);
    let group = expand(&group, &props, &group, &artifact, &version);

    let source_directory = children
        .iter()
        .find(|el| el.name == "build")
        .and_then(|el| child_text(&elements(&el.inner), "sourceDirectory"));
    let test_source_directory = children
        .iter()
        .find(|el| el.name == "build")
        .and_then(|el| child_text(&elements(&el.inner), "testSourceDirectory"));
    let source_roots = source_roots(
        dir,
        source_directory
            .as_deref()
            .map(|value| expand(value, &props, &group, &artifact, &version)),
        test_source_directory
            .as_deref()
            .map(|value| expand(value, &props, &group, &artifact, &version)),
    );
    let dependencies = dependencies_of(&children, &props, &group, &artifact, &version);
    let relative_path = rel_of(reactor, dir);

    let mut modules = Vec::new();
    if let Some(modules_el) = children.iter().find(|el| el.name == "modules") {
        for module_el in elements(&modules_el.inner) {
            if module_el.name != "module" {
                continue;
            }
            let raw = plain_text(&module_el.inner);
            let declared = expand(&raw, &props, &group, &artifact, &version);
            if declared.is_empty() || declared.contains("${") {
                continue;
            }
            let Some(child_rel) = join_rel(&relative_path, &declared) else {
                continue;
            };
            let child_dir = if child_rel == "." {
                reactor.to_path_buf()
            } else {
                reactor.join(child_rel.replace('/', std::path::MAIN_SEPARATOR_STR))
            };
            if !child_dir.join("pom.xml").is_file() || !inside_workspace(workspace, &child_dir) {
                continue;
            }
            match read_module(
                &child_dir,
                workspace,
                reactor,
                &group,
                &version,
                depth + 1,
                visited,
                count,
            ) {
                Ok(child) => modules.push(child),
                Err(code) if code == "MAVEN_CYCLE" => continue,
                Err(code) => return Err(code),
            }
        }
    }

    Ok(MavenModule {
        relative_path,
        artifact_id: artifact,
        group_id: group,
        version,
        packaging,
        source_roots,
        dependencies,
        modules,
    })
}

fn read_profiles(reactor: &Path) -> Result<Vec<MavenProfile>, String> {
    let text = read_pom(&reactor.join("pom.xml"))?;
    let Some(project) = project_element(&text) else {
        return Ok(Vec::new());
    };
    let children = elements(&project);
    let Some(profiles) = children.iter().find(|el| el.name == "profiles") else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for profile in elements(&profiles.inner) {
        if profile.name != "profile" {
            continue;
        }
        let body = elements(&profile.inner);
        let Some(id) = child_text(&body, "id") else {
            continue;
        };
        if id.is_empty() || id.contains("${") {
            continue;
        }
        let active = body
            .iter()
            .find(|el| el.name == "activation")
            .and_then(|el| child_text(&elements(&el.inner), "activeByDefault"))
            .is_some_and(|value| value.eq_ignore_ascii_case("true"));
        out.push(MavenProfile {
            id,
            active_by_default: active,
        });
    }
    Ok(out)
}

fn dependencies_of(
    children: &[El],
    props: &BTreeMap<String, String>,
    group: &str,
    artifact: &str,
    version: &str,
) -> Vec<MavenDependency> {
    let Some(block) = children.iter().find(|el| el.name == "dependencies") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for dep in elements(&block.inner) {
        if dep.name != "dependency" {
            continue;
        }
        let body = elements(&dep.inner);
        let artifact_id = child_text(&body, "artifactId").unwrap_or_default();
        if artifact_id.is_empty() {
            continue;
        }
        let group_id = child_text(&body, "groupId").unwrap_or_default();
        let dep_version = child_text(&body, "version").unwrap_or_default();
        let scope = child_text(&body, "scope").unwrap_or_else(|| "compile".to_string());
        out.push(MavenDependency {
            group_id: expand(&group_id, props, group, artifact, version),
            artifact_id: expand(&artifact_id, props, group, artifact, version),
            version: expand(&dep_version, props, group, artifact, version),
            scope: expand(&scope, props, group, artifact, version),
        });
    }
    out
}

fn source_roots(
    dir: &Path,
    source_directory: Option<String>,
    test_source_directory: Option<String>,
) -> Vec<MavenSourceRoot> {
    let mut out = Vec::new();
    push_root(&mut out, dir, source_directory.as_deref(), "src/main/java", "mainJava");
    push_root(&mut out, dir, None, "src/main/resources", "mainResources");
    push_root(
        &mut out,
        dir,
        test_source_directory.as_deref(),
        "src/test/java",
        "testJava",
    );
    push_root(&mut out, dir, None, "src/test/resources", "testResources");
    out
}

fn push_root(
    out: &mut Vec<MavenSourceRoot>,
    dir: &Path,
    declared: Option<&str>,
    fallback: &str,
    kind: &str,
) {
    let rel = declared
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.contains("${"))
        .unwrap_or(fallback);
    let normalized = rel.replace('\\', "/");
    let disk = dir.join(normalized.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !disk.is_dir() {
        return;
    }
    if out.iter().any(|root| root.path == normalized) {
        return;
    }
    out.push(MavenSourceRoot {
        path: normalized,
        kind: kind.to_string(),
    });
}

fn properties_map(children: &[El]) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let Some(block) = children.iter().find(|el| el.name == "properties") else {
        return map;
    };
    for el in elements(&block.inner) {
        let value = plain_text(&el.inner);
        if !el.name.is_empty() && !value.is_empty() {
            map.insert(el.name, value);
        }
    }
    map
}

fn expand(input: &str, props: &BTreeMap<String, String>, group: &str, artifact: &str, version: &str) -> String {
    if !input.contains("${") {
        return input.to_string();
    }
    let mut current = input.to_string();
    for _ in 0..8 {
        if !current.contains("${") {
            break;
        }
        let mut next = String::with_capacity(current.len());
        let mut rest = current.as_str();
        let mut changed = false;
        while let Some(start) = rest.find("${") {
            next.push_str(&rest[..start]);
            let after = &rest[start + 2..];
            let Some(end) = after.find('}') else {
                next.push_str(&rest[start..]);
                rest = "";
                break;
            };
            let key = &after[..end];
            let value = match key {
                "project.groupId" | "pom.groupId" => Some(group),
                "project.artifactId" | "pom.artifactId" => Some(artifact),
                "project.version" | "pom.version" => Some(version),
                other => props.get(other).map(String::as_str),
            };
            if let Some(value) = value {
                if value.contains("${") && value == key {
                    next.push_str(&rest[start..start + 2 + end + 1]);
                } else {
                    next.push_str(value);
                    changed = true;
                }
            } else {
                next.push_str(&rest[start..start + 2 + end + 1]);
            }
            rest = &after[end + 1..];
        }
        next.push_str(rest);
        if !changed {
            return next;
        }
        current = next;
    }
    current
}

fn first_nonempty(values: &[String]) -> String {
    values
        .iter()
        .find(|value| !value.is_empty())
        .cloned()
        .unwrap_or_default()
}

fn child_text(children: &[El], name: &str) -> Option<String> {
    children.iter().find(|el| el.name == name).map(|el| plain_text(&el.inner))
}

fn project_element(text: &str) -> Option<String> {
    elements(text)
        .into_iter()
        .find(|el| el.name == "project")
        .map(|el| el.inner)
}

fn read_pom(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|_| "MAVEN_READ".to_string())?;
    if meta.len() > MAX_POM_BYTES {
        return Err("MAVEN_TOO_LARGE".to_string());
    }
    let text = fs::read_to_string(path).map_err(|_| "MAVEN_READ".to_string())?;
    Ok(text.trim_start_matches('\u{feff}').to_string())
}

fn inside_workspace(workspace: &Path, child: &Path) -> bool {
    let Ok(root) = workspace.canonicalize() else {
        return child.starts_with(workspace);
    };
    child
        .canonicalize()
        .is_ok_and(|canon| canon.starts_with(&root))
}

fn rel_of(root: &Path, dir: &Path) -> String {
    dir.strip_prefix(root)
        .ok()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ".".to_string())
}

/// 把模块声明接到反应堆相对路径上。`..` 越出反应堆就丢掉，不跟到工作区外面。
fn join_rel(base: &str, child: &str) -> Option<String> {
    let mut parts: Vec<String> = if base == "." {
        Vec::new()
    } else {
        base.split('/').filter(|seg| !seg.is_empty()).map(str::to_string).collect()
    };
    for seg in child.replace('\\', "/").split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            parts.pop()?;
            continue;
        }
        if seg.contains(':') || seg.contains('\0') {
            return None;
        }
        parts.push(seg.to_string());
    }
    if parts.is_empty() {
        Some(".".to_string())
    } else {
        Some(parts.join("/"))
    }
}

fn plain_text(inner: &str) -> String {
    let stripped = strip_comments(inner);
    let cut = stripped.find('<').unwrap_or(stripped.len());
    decode_entities(stripped[..cut].trim())
}

fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        if let Some(end) = rest[start + 4..].find("-->") {
            rest = &rest[start + 4 + end + 3..];
        } else {
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out
}

fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// 这一层的直接子元素。注释、声明、同名嵌套都按深度配平，不会把
/// `<dependencyManagement>` 里的依赖认成工程自己的。
fn elements(text: &str) -> Vec<El> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i] != b'<' {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let rest = &text[i..];
        if rest.starts_with("<!--") {
            i += rest.find("-->").map(|end| end + 3).unwrap_or(rest.len());
            continue;
        }
        if rest.starts_with("<?") {
            i += rest.find("?>").map(|end| end + 2).unwrap_or(rest.len());
            continue;
        }
        if rest.starts_with("<!") {
            i += rest.find('>').map(|end| end + 1).unwrap_or(rest.len());
            continue;
        }
        if rest.starts_with("</") {
            i += rest.find('>').map(|end| end + 1).unwrap_or(rest.len());
            continue;
        }
        let name_start = i + 1;
        let mut name_end = name_start;
        while name_end < bytes.len() && is_name(bytes[name_end]) {
            name_end += 1;
        }
        if name_end == name_start {
            i += 1;
            continue;
        }
        let name = text[name_start..name_end].to_string();
        let mut cursor = name_end;
        let mut quote = 0u8;
        let mut self_close = false;
        let mut closed = false;
        while cursor < bytes.len() {
            let ch = bytes[cursor];
            if quote != 0 {
                if ch == quote {
                    quote = 0;
                }
                cursor += 1;
                continue;
            }
            if ch == b'"' || ch == b'\'' {
                quote = ch;
                cursor += 1;
                continue;
            }
            if ch == b'>' {
                self_close = cursor > name_end && bytes[cursor - 1] == b'/';
                closed = true;
                break;
            }
            cursor += 1;
        }
        if !closed {
            break;
        }
        let content_at = cursor + 1;
        if self_close {
            out.push(El {
                name,
                inner: String::new(),
            });
            i = content_at;
            continue;
        }
        let Some((inner_end, next)) = matching_close(text, content_at, &name) else {
            break;
        };
        out.push(El {
            name,
            inner: text[content_at..inner_end].to_string(),
        });
        i = next;
    }
    out
}

fn matching_close(text: &str, from: usize, name: &str) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut depth = 1usize;
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let rest = &text[i..];
        if rest.starts_with("<!--") {
            i += rest.find("-->").map(|end| end + 3).unwrap_or(rest.len());
            continue;
        }
        if rest.starts_with("<?") || rest.starts_with("<!") {
            i += rest.find('>').map(|end| end + 1).unwrap_or(rest.len());
            continue;
        }
        let closing = rest.starts_with("</");
        let name_at = if closing { i + 2 } else { i + 1 };
        if text[name_at..].starts_with(name) {
            let boundary = bytes.get(name_at + name.len()).copied().unwrap_or(b'>');
            if boundary == b'>' || boundary == b'/' || boundary.is_ascii_whitespace() {
                if closing {
                    depth -= 1;
                    if depth == 0 {
                        let after_name = name_at + name.len();
                        let gt = text[after_name..].find('>')?;
                        return Some((i, after_name + gt + 1));
                    }
                } else if let Some(gt) = text[i..].find('>') {
                    let tag = &text[i..=i + gt];
                    if !tag.ends_with("/>") {
                        depth += 1;
                    }
                    i += gt + 1;
                    continue;
                }
            }
        }
        i += 1;
    }
    None
}

fn is_name(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' || byte == b'.' || byte == b':'
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("forge-maven-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, rel: &str, text: &str) {
        let path = dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, text).unwrap();
    }

    #[test]
    fn absent_without_pom() {
        let dir = temp_project("absent");
        let found = scan(&dir).unwrap();
        assert!(found.is_none());
    }

    #[test]
    fn reads_reactor_ignoring_parent_and_managed_deps() {
        let dir = temp_project("reactor");
        write(
            &dir,
            "pom.xml",
            r#"<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <parent>
    <groupId>com.example</groupId>
    <artifactId>parent-art</artifactId>
    <version>1.2.3</version>
  </parent>
  <artifactId>demo</artifactId>
  <properties>
    <slf4j.version>2.0.9</slf4j.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
      <version>${slf4j.version}</version>
    </dependency>
  </dependencies>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>should.not</groupId>
        <artifactId>appear</artifactId>
        <version>9</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <modules>
    <!-- <module>ghost</module> -->
    <module>mod-a</module>
  </modules>
  <profiles>
    <profile>
      <id>dev</id>
      <activation><activeByDefault>true</activeByDefault></activation>
    </profile>
  </profiles>
</project>"#,
        );
        write(
            &dir,
            "mod-a/pom.xml",
            r#"<project>
  <artifactId>mod-a</artifactId>
  <dependencies>
    <dependency>
      <groupId>${project.groupId}</groupId>
      <artifactId>lib</artifactId>
      <version>${project.version}</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>"#,
        );
        fs::create_dir_all(dir.join("src/main/java")).unwrap();
        fs::create_dir_all(dir.join("mod-a/src/test/java")).unwrap();

        let project = scan(&dir).unwrap().unwrap();
        assert_eq!(project.artifact_id, "demo");
        assert_eq!(project.group_id, "com.example");
        assert_eq!(project.version, "1.2.3");
        assert_eq!(project.packaging, "jar");
        assert_eq!(project.dependencies.len(), 1);
        assert_eq!(project.dependencies[0].artifact_id, "slf4j-api");
        assert_eq!(project.dependencies[0].version, "2.0.9");
        assert!(project.profiles.iter().any(|profile| profile.id == "dev" && profile.active_by_default));
        assert!(project.source_roots.iter().any(|root| root.kind == "mainJava"));
        assert_eq!(project.modules.len(), 1);
        assert_eq!(project.modules[0].artifact_id, "mod-a");
        assert_eq!(project.modules[0].relative_path, "mod-a");
        assert_eq!(project.modules[0].group_id, "com.example");
        assert_eq!(project.modules[0].dependencies[0].version, "1.2.3");
        assert_eq!(project.modules[0].dependencies[0].scope, "test");
        assert!(project.modules[0].source_roots.iter().any(|root| root.kind == "testJava"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_module_that_escapes_the_reactor() {
        let dir = temp_project("escape");
        write(
            &dir,
            "pom.xml",
            r#"<project><artifactId>root</artifactId><modules><module>../outside</module></modules></project>"#,
        );
        let project = scan(&dir).unwrap().unwrap();
        assert!(project.modules.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scans_open_workspace_quickly() {
        let path = PathBuf::from(r"D:\app\code\nzygyt-vue-plus");
        if !path.join("pom.xml").is_file() {
            return;
        }
        let started = std::time::Instant::now();
        let project = scan(&path).expect("scan");
        let elapsed = started.elapsed();
        assert!(
            elapsed.as_secs() < 2,
            "scan took {elapsed:?}, project={project:?}"
        );
        assert!(project.is_some());
    }

    #[test]
    fn finds_pom_one_level_down() {
        let dir = temp_project("nested");
        write(&dir, "service/pom.xml", r#"<project><artifactId>service</artifactId></project>"#);
        let project = scan(&dir).unwrap().unwrap();
        assert_eq!(project.artifact_id, "service");
        assert_eq!(project.relative_path, "service");
        let _ = fs::remove_dir_all(&dir);
    }
}
