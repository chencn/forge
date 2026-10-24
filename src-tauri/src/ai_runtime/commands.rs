//! Explicit command intent. Never interpret arbitrary slash text as a model prompt.
use crate::ai_cli::Provider;
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CommandIntent { ClaudeSlash, CodexCompact, CodexReview }

pub fn parse(prompt: &str) -> Option<(&str, &str)> {
    let text = prompt.trim_start().strip_prefix('/')?;
    if text.starts_with('/') { return None; }
    let boundary = text.find(char::is_whitespace).unwrap_or(text.len());
    let args = text[boundary..].chars().next().map(|separator| &text[boundary + separator.len_utf8()..]).unwrap_or("");
    Some((&text[..boundary], args))
}

pub fn validate(provider: Provider, prompt: &str, intent: Option<CommandIntent>) -> Result<(), String> {
    match (parse(prompt), intent) {
        (None, None) => Ok(()),
        (Some((name, _)), Some(CommandIntent::ClaudeSlash)) if provider == Provider::Claude && !name.is_empty() => Ok(()),
        (Some(("compact", args)), Some(CommandIntent::CodexCompact)) if provider == Provider::Codex && args.trim().is_empty() => Ok(()),
        (Some(("review", _)), Some(CommandIntent::CodexReview)) if provider == Provider::Codex => Ok(()),
        _ => Err("命令类型或参数不受支持；未作为普通消息发送".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn intent_must_match_provider_and_exact_command() {
        assert!(validate(Provider::Codex, "/compact extra", Some(CommandIntent::CodexCompact)).is_err());
        assert!(validate(Provider::Codex, "/compact", None).is_err());
        assert!(validate(Provider::Claude, "/compact", Some(CommandIntent::CodexCompact)).is_err());
        assert!(validate(Provider::Codex, "/unknown", Some(CommandIntent::CodexReview)).is_err());
        assert!(validate(Provider::Codex, "/compact", Some(CommandIntent::CodexCompact)).is_ok());
        assert_eq!(parse(" /review 检查 \"参数\"\n第二行"), Some(("review", "检查 \"参数\"\n第二行")));
        assert_eq!(parse("/review  \"a b\"\n第二行  "), Some(("review", " \"a b\"\n第二行  ")));
        assert_eq!(parse("/review\u{3000}检查"), Some(("review", "检查")));
        assert_eq!(parse("//literal"), None);
    }
}
