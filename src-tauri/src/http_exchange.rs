//! 在本机发出 `.http` / `.rest` 里的一条请求。
//!
//! 页面的 CSP 只允许连自己，浏览器里的 `fetch` 到不了任意接口，所以发送放在这边。
//! 4xx / 5xx 也把状态和正文带回去：对 REST 客户端来说那就是结果，不是失败。

use crate::error::err;
use reqwest::header::{HeaderName, HeaderValue};
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// 响应正文最多留下这么多字节，再多就截断，避免一次大响应把编辑器撑满。
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
/// 请求正文上限。超过就拒绝，不把大文件整段塞进内存后再失败。
const MAX_BODY: usize = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpExchangeRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<HttpHeader>,
    /// 按顺序拼成正文。`text` 是已经替换完变量的文本，`file` 是要按字节读入的路径。
    #[serde(default)]
    pub body: Vec<HttpBodyPiece>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpBodyPiece {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpExchangeResponse {
    pub status: u16,
    pub reason: String,
    pub headers: Vec<HttpHeader>,
    /// 文本正文。二进制响应时为空，由 `binary` 说明。
    pub body: String,
    pub binary: bool,
    pub truncated: bool,
    pub body_bytes: u64,
    pub elapsed_ms: u64,
    /// 跟随重定向之后的最终地址。
    pub final_url: String,
}

#[tauri::command]
pub async fn http_exchange(request: HttpExchangeRequest) -> Result<HttpExchangeResponse, String> {
    let method = Method::from_bytes(request.method.trim().as_bytes())
        .map_err(|_| err("HTTP_METHOD", request.method.trim()))?;
    let url = normalize_url(&request.url)?;
    let body = assemble_body(&request.body)?;
    let client = shared_client()?;

    let mut builder = client.request(method.clone(), url);
    let mut accept_encoding = false;
    let mut user_agent = false;
    for header in &request.headers {
        if header.name.eq_ignore_ascii_case("accept-encoding") {
            accept_encoding = true;
        }
        if header.name.eq_ignore_ascii_case("user-agent") {
            user_agent = true;
        }
        let name = HeaderName::from_bytes(header.name.as_bytes())
            .map_err(|_| err("HTTP_HEADER", &header.name))?;
        let value = HeaderValue::from_bytes(header.value.as_bytes())
            .map_err(|_| err("HTTP_HEADER", &header.name))?;
        builder = builder.header(name, value);
    }
    // 没有 gzip 特性时压过的正文解不开，除非文件里自己写了 Accept-Encoding，否则要求原文。
    if !accept_encoding {
        builder = builder.header("accept-encoding", "identity");
    }
    if !user_agent {
        builder = builder.header("user-agent", "Forge");
    }
    if !body.is_empty() || (method != Method::GET && method != Method::HEAD) {
        builder = builder.body(body);
    }

    let started = Instant::now();
    let mut response = builder.send().await.map_err(exchange_err)?;
    let status = response.status();
    let final_url = response.url().to_string();
    let reason = status.canonical_reason().unwrap_or("").to_string();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| HttpHeader {
            name: name.to_string(),
            value: header_text(value),
        })
        .collect::<Vec<_>>();
    let content_type = headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case("content-type"))
        .map(|header| header.value.clone())
        .unwrap_or_default();

    let mut buf = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = response.chunk().await.map_err(exchange_err)? {
        let room = MAX_RESPONSE.saturating_sub(buf.len());
        if chunk.len() > room {
            buf.extend_from_slice(&chunk[..room]);
            truncated = true;
            break;
        }
        buf.extend_from_slice(&chunk);
    }
    let binary = is_binary(&content_type, &buf);
    let text = if binary {
        String::new()
    } else {
        String::from_utf8_lossy(&buf).into_owned()
    };

    Ok(HttpExchangeResponse {
        status: status.as_u16(),
        reason,
        headers,
        body: text,
        binary,
        truncated,
        body_bytes: buf.len() as u64,
        elapsed_ms: started.elapsed().as_millis() as u64,
        final_url,
    })
}

/// `$processEnv` 用。只接受普通环境变量名，不把空字节或 `=` 传进查找。
#[tauri::command]
pub fn http_env(name: String) -> Option<String> {
    if !is_env_name(&name) {
        return None;
    }
    std::env::var(name).ok()
}

fn shared_client() -> Result<&'static Client, String> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(net_err)?;
    Ok(CLIENT.get_or_init(|| client))
}

fn normalize_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(err("HTTP_URL", trimmed));
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let url = Url::parse(&with_scheme).map_err(|_| err("HTTP_URL", trimmed))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err(err("HTTP_URL", trimmed)),
    }
}

fn assemble_body(pieces: &[HttpBodyPiece]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    for piece in pieces {
        if let Some(text) = &piece.text {
            out.extend(text.as_bytes());
        }
        if let Some(path) = &piece.file {
            if path.is_empty() {
                return Err(err("HTTP_BODY", path));
            }
            let bytes = std::fs::read(path).map_err(|error| {
                crate::error::err_parts("IO", &[path.clone(), error.to_string()])
            })?;
            out.extend(bytes);
        }
        if out.len() > MAX_BODY {
            return Err(err("HTTP_BODY", MAX_BODY.to_string()));
        }
    }
    Ok(out)
}

fn header_text(value: &HeaderValue) -> String {
    value
        .to_str()
        .map(str::to_string)
        .unwrap_or_else(|_| String::from_utf8_lossy(value.as_bytes()).into_owned())
}

fn is_binary(content_type: &str, bytes: &[u8]) -> bool {
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if ct.starts_with("image/")
        || ct.starts_with("audio/")
        || ct.starts_with("video/")
        || ct.contains("octet-stream")
    {
        return true;
    }
    let textual = ct.is_empty()
        || ct.starts_with("text/")
        || ct.contains("json")
        || ct.contains("xml")
        || ct.contains("javascript")
        || ct.contains("yaml")
        || ct.contains("graphql")
        || ct.contains("x-www-form-urlencoded");
    if textual {
        return false;
    }
    std::str::from_utf8(bytes).is_err()
}

fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(ch) if ch.is_ascii_alphabetic() || ch == '_' => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn exchange_err(error: reqwest::Error) -> String {
    if error.is_timeout() {
        return err("HTTP_TIMEOUT", error);
    }
    err("HTTP_NETWORK", error)
}

fn net_err(error: impl std::fmt::Display) -> String {
    let text = error.to_string();
    if text.to_ascii_lowercase().contains("timed out") || text.to_ascii_lowercase().contains("timeout")
    {
        return err("HTTP_TIMEOUT", text);
    }
    err("HTTP_NETWORK", text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_must_be_http() {
        assert!(normalize_url("https://example.com/a").is_ok());
        assert_eq!(
            normalize_url("example.com/a").unwrap().as_str(),
            "http://example.com/a"
        );
        assert!(normalize_url("file:///etc/passwd").is_err());
        assert!(normalize_url("javascript:alert(1)").is_err());
        assert!(normalize_url("").is_err());
    }

    #[test]
    fn binary_follows_content_type() {
        assert!(is_binary("image/png", b"\x89PNG"));
        assert!(!is_binary("application/json", b"{\"a\":1}"));
        assert!(!is_binary("", b"plain"));
        assert!(is_binary("application/octet-stream", b"abc"));
        assert!(is_binary("application/pdf", b"\xff\xfe"));
    }

    #[test]
    fn env_name_is_a_token() {
        assert!(is_env_name("USERNAME"));
        assert!(is_env_name("_A1"));
        assert!(!is_env_name(""));
        assert!(!is_env_name("A=B"));
        assert!(!is_env_name("1NAME"));
    }
}
