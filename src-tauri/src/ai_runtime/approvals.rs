//! 审批深度：一次允许、本轮始终允许、按目录允许、改完再允许。
//!
//! 规则只活在本次运行里——不落盘、不跨重启、不跨新会话，也绝不写进 CLI 自己的配置文件。
//! 这和「扩大权限的授权不跨重启或新会话继承」是同一条约定，只是把用户已经点过的那次
//! 授权在同一个任务里复用掉。
//!
//! 匹配一律失败关闭：认不出路径、路径解析不了、目录规则碰上没有路径的入参，全都当作
//! 「不覆盖」，回到问用户那条路。宁可多点一次按钮，不能多放一个动作。

use serde_json::Value;
use std::path::{Component, Path, PathBuf};

/// 一条被记住的允许规则。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StandingRule {
    /// 适配器报上来的工具名，逐字匹配；不做前缀或模糊匹配。
    pub tool: String,
    /// 有目录时只覆盖落在这个目录之内的操作；None 表示这个工具本轮不再问。
    pub root: Option<PathBuf>,
}

impl StandingRule {
    /// 时间线上要说清「这条是谁替谁放的」。
    pub fn explain(&self) -> String {
        match &self.root {
            None => format!("本轮内 {} 的操作不再询问", self.tool),
            Some(root) => format!(
                "本轮内 {} 仅在 {} 之内的操作不再询问",
                self.tool,
                root.display()
            ),
        }
    }
}

/// 工具入参里要动的那个文件。取不到就返回 None——按目录的规则必须失败关闭。
///
/// 命令类入参（`command`/`cwd`）故意不在这里：命令能写到哪看不出来，
/// 所以目录规则永远不覆盖它，只有「这个工具本轮不再问」那种规则才可能覆盖。
pub fn request_target(input: &Value) -> Option<&str> {
    ["file_path", "notebook_path", "path", "absolute_path", "target_file"]
        .iter()
        .find_map(|key| input[*key].as_str().filter(|value| !value.is_empty()))
}

/// 把路径解析成「没有符号链接、没有 `..` 的真身」，允许末尾的段还不存在。
///
/// 逐段往上找到第一个存在的祖先再 canonicalize，然后把剩下的段拼回去。带 `..` 的路径
/// 直接不给解析：祖先里一出现 `..`，canonicalize 会在中途把它吃掉，剩下的段拼回去
/// 之后位置就错了——`项目\src\..\..\x` 可能落回项目内，也可能跑到项目外，谁也不能保证。
/// 所以带 `..` 的入参一律按「认不出来」处理，回到问用户那条路。
pub fn resolve(path: &Path) -> Option<PathBuf> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return None;
    }
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = path;
    loop {
        if let Ok(base) = cursor.canonicalize() {
            let mut resolved = base;
            for part in tail.into_iter().rev() {
                resolved.push(part);
            }
            return Some(resolved);
        }
        let name = cursor.file_name()?;
        tail.push(name.to_os_string());
        cursor = cursor.parent()?;
    }
}

/// 目标在目录之内吗？两边都先解析真身；解析不了就算不在（多问一次）。
pub fn within(root: &Path, target: &Path) -> bool {
    match (resolve(root), resolve(target)) {
        (Some(base), Some(path)) => path.starts_with(base),
        _ => false,
    }
}

/// 本次运行里攒下的允许规则。
#[derive(Default)]
pub struct ApprovalMemory {
    rules: Vec<StandingRule>,
}

impl ApprovalMemory {
    /// 记一条规则；重复记同一条不叠加。返回是否真的新增了。
    pub fn remember(&mut self, rule: StandingRule) -> bool {
        if rule.tool.trim().is_empty() || self.rules.contains(&rule) {
            return false;
        }
        self.rules.push(rule);
        true
    }

    /// 这条请求被哪条规则覆盖；None 表示还要问用户。
    pub fn covers(&self, tool: Option<&str>, input: &Value) -> Option<&StandingRule> {
        let name = tool?;
        self.rules.iter().find(|rule| {
            rule.tool == name
                && match (&rule.root, request_target(input)) {
                    (None, _) => true,
                    (Some(base), Some(target)) => within(base, Path::new(target)),
                    (Some(_), None) => false,
                }
        })
    }
}

/// 授权答复的上限：改过的入参别变成把整个仓库塞进 stdin 的通道。
const MAX_EDITED_INPUT: usize = 64 * 1024;

/// 校验并拆解一条授权答复。
///
/// 形状：`{allow: bool, input?: object, remember?: {tool, root?}}`。
/// `input` 是「改完再允许」，`remember` 是「本轮不再问」——两者都只在 allow 为真时成立，
/// 拒绝就是拒绝，不附带任何授权。
pub fn parse_permission_answer(answer: &Value) -> Result<(bool, Option<Value>, Option<StandingRule>), String> {
    let object = answer.as_object().ok_or("授权回答格式无效")?;
    // 多一个字段就整条拒掉：静默忽略未知键意味着以后加了新选项，旧前端能塞进任何东西
    // 而没人发现——授权答复不接受「看不懂就算通过」。
    if object.len() > 3 || object.keys().any(|key| !matches!(key.as_str(), "allow" | "input" | "remember")) {
        return Err("授权回答字段无效或过多".into());
    }
    let allow = object.get("allow").and_then(Value::as_bool).ok_or("授权回答无效")?;
    if !allow {
        if object.contains_key("input") || object.contains_key("remember") {
            return Err("拒绝时不能附带修改或记住授权".into());
        }
        return Ok((false, None, None));
    }
    let edited = match object.get("input") {
        None => None,
        Some(value) => {
            if !value.is_object() || value.to_string().len() > MAX_EDITED_INPUT {
                return Err("修改后的入参格式无效或过大".into());
            }
            Some(value.clone())
        }
    };
    let rule = match object.get("remember") {
        None => None,
        Some(value) => {
            let tool = value.get("tool").and_then(Value::as_str).ok_or("记住的授权缺少工具名")?;
            if tool.trim().is_empty() || tool.chars().count() > 120 {
                return Err("记住的授权工具名无效".into());
            }
            let root = match value.get("root") {
                None | Some(Value::Null) => None,
                Some(Value::String(path)) if !path.trim().is_empty() => {
                    // 只认绝对路径：相对路径没有基准目录，无从判定「在不在里面」。
                    let candidate = Path::new(path.as_str());
                    if !candidate.is_absolute() {
                        return Err("记住的授权目录必须是绝对路径".into());
                    }
                    Some(candidate.to_path_buf())
                }
                Some(_) => return Err("记住的授权目录格式无效".into()),
            };
            Some(StandingRule { tool: tool.to_string(), root })
        }
    };
    Ok((allow, edited, rule))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("forge-approvals-{tag}-{}-{unique}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn target_reads_file_keys_and_ignores_the_rest() {
        assert_eq!(request_target(&json!({"file_path":"a.rs"})), Some("a.rs"));
        assert_eq!(request_target(&json!({"notebook_path":"n.ipynb"})), Some("n.ipynb"));
        assert_eq!(request_target(&json!({"absolute_path":"x.ts"})), Some("x.ts"));
        // 空串不是路径：按目录的规则遇到它必须当作认不出来。
        assert_eq!(request_target(&json!({"file_path":""})), None);
        assert_eq!(request_target(&json!({"command":"rm -rf /"})), None);
        assert_eq!(request_target(&json!({"cwd":"D:/app"})), None);
        assert_eq!(request_target(&Value::Null), None);
    }

    #[test]
    fn directory_rule_covers_only_inside_the_root_and_never_commands() {
        let root = temp_dir("root");
        let inside = root.join("src").join("new.rs");
        let sibling = temp_dir("outside").join("leak.rs");
        fs::create_dir_all(root.join("src")).unwrap();
        let dir_rule = StandingRule { tool: "Edit".into(), root: Some(root.clone()) };
        let tool_rule = StandingRule { tool: "Edit".into(), root: None };
        assert_eq!(dir_rule.tool, "Edit");
        // 还没写出来的文件也算在目录内：新建是常见情形。
        assert!(within(&root, &inside));
        assert!(!within(&root, &sibling));
        let memory = ApprovalMemory { rules: vec![dir_rule.clone(), tool_rule.clone()] };
        assert_eq!(memory.covers(Some("Edit"), &json!({"file_path": inside.to_string_lossy()})), Some(&dir_rule));
        assert_eq!(memory.covers(Some("Edit"), &json!({"file_path": sibling.to_string_lossy()})), Some(&tool_rule));
        // 目录规则碰上没有路径的入参：不覆盖，交给下一条无目录规则或回到询问。
        let only_dir = ApprovalMemory { rules: vec![dir_rule.clone()] };
        assert_eq!(only_dir.covers(Some("Edit"), &json!({"patch":"--- a\n"})), None);
        assert_eq!(only_dir.covers(Some("Bash"), &json!({"file_path": inside.to_string_lossy()})), None);
        assert_eq!(only_dir.covers(None, &json!({"file_path": inside.to_string_lossy()})), None);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn dot_dot_is_refused_rather_than_guessed() {
        let root = temp_dir("escape-root");
        fs::create_dir_all(root.join("src")).unwrap();
        let escaped = root.join("src").join("..").join("..").join("outside.txt");
        // 字面前缀检查会说「在里面」——它确实从 root 开头。所以我们不信字面前缀。
        assert!(Path::new(&escaped).starts_with(&root));
        // 祖先里一出现 `..`，canonicalize 会在中途把它吃掉，剩下的段拼回去位置就错了，
        // 到底落在项目内还是项目外无人能保证 ⇒ 按「认不出来」处理，回到问用户。
        assert_eq!(resolve(&escaped), None);
        let memory = ApprovalMemory { rules: vec![StandingRule { tool: "Edit".into(), root: Some(root.clone()) }] };
        assert_eq!(memory.covers(Some("Edit"), &json!({"file_path": escaped.to_string_lossy()})), None);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_root_that_simply_has_not_been_created_yet_still_covers() {
        // 目录规则不能要求根已经存在：往还没建出来的目录里写文件正是最常见的目标。
        let missing = std::env::temp_dir().join("forge-approvals-not-created-yet");
        let inside = missing.join("nested").join("new.rs");
        assert!(resolve(&missing).is_some());
        assert!(within(&missing, &inside));
        let rule = StandingRule { tool: "Edit".into(), root: Some(missing.clone()) };
        let memory = ApprovalMemory { rules: vec![rule.clone()] };
        assert_eq!(memory.covers(Some("Edit"), &json!({"file_path": inside.to_string_lossy()})), Some(&rule));
    }

    #[test]
    fn an_unresolvable_root_covers_nothing() {
        // 连基准都拿不到时失败关闭：不覆盖，回到问用户。
        assert_eq!(resolve(Path::new("")), None);
        assert!(!within(Path::new(""), Path::new("src/x.rs")));
        let memory = ApprovalMemory { rules: vec![StandingRule { tool: "Edit".into(), root: Some(PathBuf::new()) }] };
        assert_eq!(memory.covers(Some("Edit"), &json!({"file_path": "src/x.rs"})), None);
    }

    #[test]
    #[cfg(windows)]
    fn a_root_on_a_missing_drive_covers_nothing() {
        // 整条祖先链都不存在（不存在的盘符）才是真实的「解析不了」：临时目录的子孙不是。
        let drive = (b'B'..=b'Z')
            .rev()
            .map(|letter| PathBuf::from(format!("{}:\\", letter as char)))
            .find(|root| root.canonicalize().is_err())
            .expect("找不到一个不存在的盘符");
        let root = drive.join("forge-approvals-missing-drive");
        assert_eq!(resolve(&root), None);
        let memory = ApprovalMemory { rules: vec![StandingRule { tool: "Edit".into(), root: Some(root.clone()) }] };
        assert_eq!(memory.covers(Some("Edit"), &json!({"file_path": root.join("x.rs").to_string_lossy()})), None);
    }

    #[test]
    fn remembering_is_idempotent_and_blanks_are_dropped() {
        let bash = StandingRule { tool: "Bash".into(), root: None };
        let mut memory = ApprovalMemory::default();
        let request = json!({"command":"ls"});
        // 空记忆里什么都不覆盖——「记过一条」之前绝不代答。
        assert_eq!(memory.covers(Some("Bash"), &request), None);
        assert!(memory.remember(bash.clone()));
        assert!(!memory.remember(bash.clone()));
        assert!(!memory.remember(StandingRule { tool: "  ".into(), root: None }));
        assert_eq!(memory.covers(Some("Bash"), &request), Some(&bash));
        // 空白工具名记不进去，也就永远不存在「一条空规则把一切都放行」。
        assert_eq!(memory.covers(Some(""), &request), None);
        assert!(bash.explain().contains("Bash"));
        let scoped = StandingRule { tool: "Edit".into(), root: Some(PathBuf::from("/tmp/project")) };
        assert!(scoped.explain().contains("project"));
        assert_ne!(scoped.explain(), bash.explain());
    }

    #[test]
    fn denial_carries_no_grant_or_edit() {
        assert_eq!(parse_permission_answer(&json!({"allow":false})).unwrap(), (false, None, None));
        assert!(parse_permission_answer(&json!({"allow":false,"remember":{"tool":"Bash"}})).is_err());
        assert!(parse_permission_answer(&json!({"allow":false,"input":{"command":"x"}})).is_err());
        assert!(parse_permission_answer(&json!({"allow":"true"})).is_err());
        assert!(parse_permission_answer(&json!([])).is_err());
        assert!(parse_permission_answer(&json!({"allow":true,"extra":1})).is_err());
    }

    #[test]
    fn edited_input_is_validated_by_shape_and_size() {
        let (allow, edited, rule) = parse_permission_answer(&json!({"allow":true,"input":{"command":"ls -l"}})).unwrap();
        assert!(allow && edited.is_some() && rule.is_none());
        assert_eq!(edited.unwrap()["command"], "ls -l");
        assert!(parse_permission_answer(&json!({"allow":true,"input":"not an object"})).is_err());
        assert!(parse_permission_answer(&json!({"allow":true,"input":{"blob":"x".repeat(70_000)}})).is_err());
    }

    #[test]
    fn standing_grant_needs_a_tool_and_an_absolute_root() {
        let (_, _, rule) = parse_permission_answer(&json!({"allow":true,"remember":{"tool":"Bash"}})).unwrap();
        assert_eq!(rule.unwrap(), StandingRule { tool: "Bash".into(), root: None });
        let (_, _, rule) = parse_permission_answer(&json!({"allow":true,"remember":{"tool":"Edit","root":null}})).unwrap();
        assert_eq!(rule.unwrap().root, None);
        let absolute = temp_dir("grant");
        let (_, _, rule) = parse_permission_answer(&json!({"allow":true,"remember":{"tool":"Edit","root":absolute.to_string_lossy()}})).unwrap();
        assert_eq!(rule.unwrap(), StandingRule { tool: "Edit".into(), root: Some(absolute.clone()) });
        fs::remove_dir_all(absolute).ok();
        for bad in [
            json!({"allow":true,"remember":{}}),
            json!({"allow":true,"remember":{"tool":""}}),
            json!({"allow":true,"remember":{"tool":"  "}}),
            json!({"allow":true,"remember":{"tool":"Edit","root":"src/main.rs"}}),
            json!({"allow":true,"remember":{"tool":"Edit","root":12}}),
            json!({"allow":true,"remember":{"tool":"x".repeat(121)}}),
        ] {
            assert!(parse_permission_answer(&bad).is_err(), "{bad} 不该被接受");
        }
    }
}
