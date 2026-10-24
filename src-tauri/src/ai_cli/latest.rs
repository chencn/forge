//! 官方版本查询失败后，仅回退读取国内镜像元数据；不使用镜像里的下载地址。
use super::{version_parts, Provider};
use serde::Serialize;
use std::future::Future;

// Claude 用 npm 的 `stable` 标签（`latest` 可能指向预发布），Codex 的正式版本就发在 `latest` 上。
// 镜像只用于「查版本号」：安装与更新始终走官方 registry，避免引入镜像的下载地址。
const CLAUDE_STABLE: &str = "https://registry.npmjs.org/@anthropic-ai/claude-code/stable";
const CODEX_LATEST: &str = "https://registry.npmjs.org/@openai/codex/latest";
const CLAUDE_MIRROR: &str = "https://registry.npmmirror.com/@anthropic-ai/claude-code/stable";
const CODEX_MIRROR: &str = "https://registry.npmmirror.com/@openai/codex/latest";

/// 版本号是从哪个源拿到的。界面要如实标注，避免把镜像的滞后版本当成官方最新。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum VersionSource { Official, Npmmirror }

/// 查询结果连同来源一起返回：安装时必须用官方源，来源也要给前端做提示。
#[derive(Debug)]
pub(super) struct LatestVersion {
    /// 校验过的三段正式版本号，例如 `2.1.308`；预发布版本不会走到这里。
    pub version: String,
    /// 这个版本号是从官方源还是国内镜像读到的，界面据此提示同步延迟。
    pub source: VersionSource,
}

/// 解析 npm registry 的包元数据，只取 `version` 字段。
///
/// 这里做的是「拒绝」而非「纠正」：包名必须与所查工具一致，版本必须是三段正式版本。
/// 镜像可能被劫持或返回 HTML 错误页，因此连 `dist.tarball` 都不读——镜像只用来查版本号，
/// 下载地址一律走官方源。
fn parse(provider: Provider, text: &str) -> Result<String, String> {
    let metadata: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if metadata["name"] != provider.package() { return Err("版本服务器返回的包名不匹配".into()); }
    let version = metadata["version"].as_str().ok_or("版本服务器没有返回版本号")?.to_string();
    if version_parts(&version).is_none() { return Err("版本服务器未返回有效的正式版本；已拒绝预发布版本".into()); }
    Ok(version)
}

/// 先查官方源，只有官方失败（网络不通、返回非法内容）才退到国内镜像。
///
/// 用泛型 `fetch` 而非直接发请求，是为了测试能在不联网的前提下断言请求顺序：
/// 官方成功时不该碰镜像，官方失败时也必须带着两个错误一起报出来。
async fn query_with<F, Fut>(provider: Provider, mut fetch: F) -> Result<LatestVersion, String>
where
    F: FnMut(&'static str) -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    let (official, mirror) = match provider {
        Provider::Claude => (CLAUDE_STABLE, CLAUDE_MIRROR),
        Provider::Codex => (CODEX_LATEST, CODEX_MIRROR),
    };
    let official_error = match fetch(official).await.and_then(|text| parse(provider, &text)) {
        Ok(version) => return Ok(LatestVersion { version, source: VersionSource::Official }),
        Err(error) => error,
    };
    match fetch(mirror).await.and_then(|text| parse(provider, &text)) {
        Ok(version) => Ok(LatestVersion { version, source: VersionSource::Npmmirror }),
        Err(error) => Err(format!("官方源查询失败：{official_error}\n国内镜像（npmmirror）查询也失败：{error}")),
    }
}

/// 正式版本查询入口，网络请求由 `super::fetch_text` 提供。
pub(super) async fn query(provider: Provider) -> Result<LatestVersion, String> {
    query_with(provider, super::fetch_text).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// 用预设的响应序列替掉真实网络，并断言请求顺序与数量完全符合预期。
    async fn responses(provider: Provider, steps: Vec<(&'static str, Result<&str, &str>)>) -> Result<LatestVersion, String> {
        let mut steps: VecDeque<_> = steps.into();
        let result = query_with(provider, |url| {
            let (expected, response) = steps.pop_front().expect("不应请求额外来源");
            assert_eq!(url, expected);
            std::future::ready(response.map(str::to_string).map_err(str::to_string))
        }).await;
        assert!(steps.is_empty());
        result
    }

    #[tokio::test(flavor = "current_thread")]
    async fn official_success_does_not_contact_mirror() {
        let result = responses(Provider::Codex, vec![(CODEX_LATEST, Ok(r#"{"name":"@openai/codex","version":"0.163.0"}"#))]).await.unwrap();
        assert_eq!(result.version, "0.163.0");
        assert_eq!(result.source, VersionSource::Official);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn network_failure_falls_back_to_mirror() {
        let result = responses(Provider::Codex, vec![
            (CODEX_LATEST, Err("timeout")),
            (CODEX_MIRROR, Ok(r#"{"name":"@openai/codex","version":"0.163.0","dist":{"tarball":"https://untrusted.invalid/package"}}"#)),
        ]).await.unwrap();
        assert_eq!(result.version, "0.163.0");
        assert_eq!(result.source, VersionSource::Npmmirror);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn malformed_official_response_also_falls_back() {
        let result = responses(Provider::Codex, vec![
            (CODEX_LATEST, Ok("<html>unavailable</html>")),
            (CODEX_MIRROR, Ok(r#"{"name":"@openai/codex","version":"0.163.0"}"#)),
        ]).await.unwrap();
        assert_eq!(result.source, VersionSource::Npmmirror);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn claude_official_uses_npm_stable_tag() {
        let result = responses(Provider::Claude, vec![(CLAUDE_STABLE, Ok(r#"{"name":"@anthropic-ai/claude-code","version":"2.1.308"}"#))]).await.unwrap();
        assert_eq!(result.version, "2.1.308");
        assert_eq!(result.source, VersionSource::Official);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn claude_mirror_uses_stable_tag_not_latest() {
        let result = responses(Provider::Claude, vec![
            (CLAUDE_STABLE, Err("offline")),
            (CLAUDE_MIRROR, Ok(r#"{"name":"@anthropic-ai/claude-code","version":"2.1.308"}"#)),
        ]).await.unwrap();
        assert_eq!(result.version, "2.1.308");
        assert_eq!(result.source, VersionSource::Npmmirror);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn both_failures_are_reported() {
        let error = responses(Provider::Codex, vec![(CODEX_LATEST, Err("official timeout")), (CODEX_MIRROR, Err("mirror HTTP 503"))]).await.unwrap_err();
        assert!(error.contains("official timeout"));
        assert!(error.contains("mirror HTTP 503"));
    }

    #[test]
    fn mirror_requires_correct_package_and_stable_version() {
        for text in [r#"{"name":"other","version":"1.2.3"}"#, r#"{"name":"@openai/codex","version":"1.2.3-beta.1"}"#,
            r#"{"name":"@openai/codex","version":"1.2.3;exit"}"#, r#"{"name":"@openai/codex"}"#, "<html>error</html>"] {
            assert!(parse(Provider::Codex, text).is_err());
        }
        assert!(parse(Provider::Claude, r#"{"name":"@openai/codex","version":"1.2.3"}"#).is_err());
    }
}
