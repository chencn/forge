//! 请求的发送：正文拼装、发出去、把响应读回来。
//!
//! `Result<T, String>`，错误统一走 [`crate::error::err`]；
//! 取消用 forge 的 `tokio::sync::watch` 通道。
//!
//! 分工：`.http` 的语法与变量替换（文件变量、环境、`{{name.response…}}`
//! 依赖链、`$dotenv` / `$processEnv`、`# @prompt`、cURL 导入、GraphQL 包）留在前端
//! `src/lib/httpFile.ts`——那边是 forge 既有实现，成套装且有测试，`# @prompt` 还要弹窗，
//! 搬到这边只会多一次往返。这边只负责「把一条已经拼装好的请求发出去」，加上取消、
//! 计时、文本/二进制判定与截断。

use crate::error::err;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::watch;

/// 响应正文最多留这么多字节。超过就停读，避免把超大响应整段拉进内存。
pub const MAX_BODY: usize = 16 * 1024 * 1024;
/// 整次请求的上限：连接、等待响应头、读正文都算在里面。和旧的 `http_exchange` 一样。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// 请求正文上限。超过就拒绝，不把大文件整段塞进内存后再失败。
const MAX_REQUEST: usize = 8 * 1024 * 1024;

/// 正文的一段：字面文本，或按字节读入的文件（`< file`）。
///
/// 前端传 `{"text":"..."}` / `{"file":"..."}`，不带 Rust 枚举名标签。
/// `untagged` 按声明次序试，所以带 `file` 的必须排在前面：`{"file":"a"}` 只有 `File`
/// 能匹配，`{"text":"b"}` 才落到 `Text`。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum BodyPart {
    File { file: String },
    Text { text: String },
    /// 历史重发二进制正文时使用，不能从展示用的有损文本还原。
    Base64 { base64: String },
}

/// 前端送来的一条可直接发送的请求：变量已替换、include 已解析成路径。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestCall {
    /// `# @name` / `### 标题`，只进历史与列表，不参与发送。
    #[serde(default)]
    pub name: Option<String>,
    pub method: String,
    pub url: String,
    /// 表头按 `[[name, value]]` 传，与 [`HttpResponse::headers`] 同一形状。
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Vec<BodyPart>,
}

/// 实际发出去的那条请求的可展示形状（历史详情用）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentRequest {
    pub name: Option<String>,
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    /// 首次发送时补全默认值的头；原始 headers 单独保留，避免历史重发固化传输头。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_headers: Option<Vec<(String, String)>>,
    /// 拼装后的正文文本；正文文件不是 UTF-8 时按有损转换。
    pub body: Option<String>,
    /// 非 UTF-8 正文保留原始字节，文本请求不重复存储。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_base64: Option<String>,
}

/// 一次 HTTP 请求的完整响应（含实际发送的头与请求体记录）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub version: String,
    pub headers: Vec<(String, String)>,
    pub content_type: Option<String>,
    /// 文本正文件（有损 UTF-8）；二进制正文为 `None`。
    pub body: Option<String>,
    /// PDF 保留原始字节供前端预览和历史回放，不能经过有损 UTF-8 转换。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_base64: Option<String>,
    /// 解压后实际收到的字节数。
    pub size: f64,
    pub truncated: bool,
    /// 请求开始 → 收到响应头。
    pub ttfb_ms: f64,
    /// 请求开始 → 正文读完。
    pub total_ms: f64,
    /// 跟随重定向之后的最终地址（Cookie 归位用）。
    pub final_url: String,
}

/// 拼装请求：校验地址、读入正文文件、算出可展示的形状与待发字节。
pub fn assemble(
    call: &HttpRequestCall,
    base_dir: Option<&Path>,
) -> Result<(SentRequest, Vec<u8>), String> {
    let url = normalize_url(&call.url)?;
    let body = assemble_body(&call.body, base_dir)?;
    let sent = SentRequest {
        name: call.name.clone(),
        method: call.method.trim().to_uppercase(),
        url,
        headers: call.headers.clone(),
        sent_headers: None,
        body: if body.is_empty() {
            None
        } else {
            Some(String::from_utf8_lossy(&body).into_owned())
        },
        body_base64: std::str::from_utf8(&body).is_err().then(|| STANDARD.encode(&body)),
    };
    Ok((sent, body))
}

/// 只认 `http` / `https`；没写协议就补 `http://`（`localhost:8080` 的冒号是端口，不是协议）。
fn normalize_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(err("HTTP_URL", trimmed));
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("http://{trimmed}")
    };
    let url = reqwest::Url::parse(&with_scheme).map_err(|_| err("HTTP_URL", trimmed))?;
    match url.scheme() {
        "http" | "https" => Ok(with_scheme),
        _ => Err(err("HTTP_URL", trimmed)),
    }
}

/// 按顺序拼正文。先算总尺寸再落第一趟读：文件指到几百 MB 时，「整读再拒」会先把
/// 内存吃掉。读的时候也按剩余额度封顶，预检之后文件又长胖照样按超限处理。
fn assemble_body(pieces: &[BodyPart], base_dir: Option<&Path>) -> Result<Vec<u8>, String> {
    use std::io::Read as _;
    let paths: Vec<Option<PathBuf>> = pieces
        .iter()
        .map(|piece| match piece {
            BodyPart::Text { .. } | BodyPart::Base64 { .. } => Ok(None),
            BodyPart::File { file } => resolve_body_file(file, base_dir).map(Some),
        })
        .collect::<Result<_, String>>()?;
    let mut total: u64 = 0;
    for (piece, path) in pieces.iter().zip(&paths) {
        total += match (piece, path) {
            (BodyPart::Text { text }, _) => text.len() as u64,
            (BodyPart::Base64 { base64 }, _) => {
                // 先限制编码长度，避免解码前分配超大缓冲区。
                if base64.len() > MAX_REQUEST.div_ceil(3) * 4 {
                    return Err(err("HTTP_BODY", "encoded request body is too large"));
                }
                STANDARD.decode(base64).map_err(|e| err("HTTP_BODY", e))?.len() as u64
            }
            (_, Some(path)) => std::fs::metadata(path)
                .map_err(|e| err("IO", format!("{}: {e}", path.display())))?
                .len(),
            _ => unreachable!("file piece without a path"),
        };
        if total > MAX_REQUEST as u64 {
            return Err(err(
                "HTTP_BODY",
                format!("{total} > {MAX_REQUEST} bytes"),
            ));
        }
    }
    let mut out = Vec::with_capacity(total as usize);
    for (piece, path) in pieces.iter().zip(&paths) {
        match (piece, path) {
            (BodyPart::Text { text }, _) => out.extend_from_slice(text.as_bytes()),
            (BodyPart::Base64 { base64 }, _) => {
                out.extend(STANDARD.decode(base64).map_err(|e| err("HTTP_BODY", e))?);
            }
            (_, Some(path)) => {
                // 多读一字节即超限，且最坏只多读一字节。
                let room = (MAX_REQUEST - out.len()) as u64 + 1;
                let mut bytes = Vec::new();
                std::fs::File::open(path)
                    .and_then(|f| f.take(room).read_to_end(&mut bytes))
                    .map_err(|e| err("IO", format!("{}: {e}", path.display())))?;
                out.extend(bytes);
            }
            _ => unreachable!("file piece without a path"),
        }
        if out.len() > MAX_REQUEST {
            return Err(err(
                "HTTP_BODY",
                format!("{} > {MAX_REQUEST} bytes", out.len()),
            ));
        }
    }
    Ok(out)
}

/// 正文文件相对请求文件所在目录；写绝对路径就按绝对路径读。
fn resolve_body_file(raw: &str, base_dir: Option<&Path>) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err(err("HTTP_BODY", "empty body file path"));
    }
    let path = Path::new(raw);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    match base_dir {
        Some(dir) => Ok(dir.join(path)),
        None => Err(err("HTTP_BODY", format!("relative body file {raw} without a base dir"))),
    }
}

/// 进程级共享的 reqwest 客户端（带连接/总超时与 Forge UA），只构建一次。
///
/// # Errors
///
/// 客户端构建失败时返回 `HTTP_NETWORK` 错误。
fn client() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(30))
                .timeout(REQUEST_TIMEOUT)
                .user_agent(concat!("Forge-HttpClient/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|e| err("HTTP_NETWORK", e))
        })
        .clone()
}

/// 判断响应是否适合按文本预览：Content-Type 或字节探测。
fn looks_textual(content_type: Option<&str>, bytes: &[u8]) -> bool {
    if let Some(ct) = content_type {
        let ct = ct.to_ascii_lowercase();
        if ct.starts_with("text/")
            || ["json", "xml", "html", "javascript", "x-www-form-urlencoded", "yaml", "csv", "graphql"]
                .iter()
                .any(|k| ct.contains(k))
        {
            return true;
        }
        if ct.starts_with("image/")
            || ct.starts_with("audio/")
            || ct.starts_with("video/")
            || ct.contains("octet-stream")
        {
            return false;
        }
    }
    // 最多看到 4KB 的合法 UTF-8（可能被截断最后一个字符）。
    match std::str::from_utf8(&bytes[..bytes.len().min(4096)]) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none(),
    }
}

/// 只有显式的 true 才取消；无 requestId 时发送端会直接关闭，仍应正常发送。
async fn wait_cancelled(cancel: &mut watch::Receiver<bool>) {
    if *cancel.borrow() {
        return;
    }
    while cancel.changed().await.is_ok() {
        if *cancel.borrow() {
            return;
        }
    }
    std::future::pending::<()>().await;
}

/// 发送 `req`（正文为 `body`）；`cancel` 触发时中止。
pub async fn send(
    req: &mut SentRequest,
    body: &[u8],
    cancel: &mut watch::Receiver<bool>,
) -> Result<HttpResponse, String> {
    let client = client()?;
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|_| err("HTTP_METHOD", &req.method))?;
    let mut builder = client.request(method.clone(), &req.url);
    let mut user_agent = false;
    for (name, value) in &req.headers {
        // `builder.build()` 把坏头和坏地址都收成同一条 builder error。
        // 头的问题在这里单独成码，地址仍留给后面的 `HTTP_URL`。
        // 使用传输库的真实约束，允许合法非 ASCII 值，同时拒绝 CR/LF 等非法字节。
        let header_name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| err("HTTP_HEADER", name))?;
        let header_value = reqwest::header::HeaderValue::from_bytes(value.as_bytes())
            .map_err(|_| err("HTTP_HEADER", name))?;
        if name.eq_ignore_ascii_case("user-agent") {
            user_agent = true;
        }
        builder = builder.header(header_name, header_value);
    }
    if !user_agent {
        builder = builder.header("user-agent", "Forge");
    }
    if !body.is_empty() || (method != reqwest::Method::GET && method != reqwest::Method::HEAD) {
        builder = builder.body(body.to_vec());
    }
    let mut request = builder
        .build()
        .map_err(|e| err("HTTP_URL", format!("invalid request: {e}")))?;
    // 默认值在 execute/解压中间件里才补齐；先显式设置，让发送和历史共享同一份值。
    use reqwest::header::{HeaderValue, ACCEPT, ACCEPT_ENCODING, CONTENT_LENGTH, HOST, TRANSFER_ENCODING};
    request.headers_mut().entry(ACCEPT).or_insert(HeaderValue::from_static("*/*"));
    // 与 Cargo.toml 启用的 gzip/deflate/brotli 保持一致。
    request.headers_mut().entry(ACCEPT_ENCODING).or_insert(HeaderValue::from_static("gzip,deflate,br"));
    // 正文已完整拼装，发送前固定长度，使 HTTP/1 和 HTTP/2 的记录一致。
    // 显式 chunked 仍优先；空正文没有 chunk 可发送，移除无效的传输编码。
    if body.is_empty() {
        request.headers_mut().remove(TRANSFER_ENCODING);
    }
    if request.headers().contains_key(TRANSFER_ENCODING) {
        request.headers_mut().remove(CONTENT_LENGTH);
    } else if request.body().is_some() {
        request.headers_mut().entry(CONTENT_LENGTH).or_insert(HeaderValue::from(body.len()));
    }
    let mut sent_headers = request.headers().clone();
    // Host 只补到首次请求快照中；写入实际请求会让跨域重定向沿用错误的 Host。
    // HTTP/2 使用对应的 :authority，这里统一按可读的 HTTP 头展示。
    let url = request.url();
    let host = match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or("")),
        None => url.host_str().unwrap_or("").to_owned(),
    };
    sent_headers.entry(HOST).or_insert(HeaderValue::from_str(&host).map_err(|e| err("HTTP_URL", e))?);
    req.sent_headers = Some(sent_headers.iter().map(|(name, value)| (
        name.as_str().to_owned(), String::from_utf8_lossy(value.as_bytes()).into_owned(),
    )).collect());
    let started = Instant::now();
    let sending = client.execute(request);
    let mut response = tokio::select! {
        r = sending => r.map_err(|e| http_err(&e))?,
        _ = wait_cancelled(cancel) => return Err(err("HTTP_CANCELLED", "")),
    };
    let ttfb = started.elapsed();
    let status = response.status();
    let version = format!("{:?}", response.version());
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(k, v)| {
            (
                k.as_str().to_owned(),
                String::from_utf8_lossy(v.as_bytes()).into_owned(),
            )
        })
        .collect();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let final_url = response.url().to_string();
    let mut bytes = Vec::new();
    let mut stopped_early = false;
    loop {
        let chunk = tokio::select! {
            c = response.chunk() => c.map_err(|e| http_err(&e))?,
            _ = wait_cancelled(cancel) => return Err(err("HTTP_CANCELLED", "")),
        };
        let Some(chunk) = chunk else { break };
        if bytes.len() >= MAX_BODY {
            stopped_early = true;
            break;
        }
        let room = MAX_BODY - bytes.len();
        if chunk.len() > room {
            bytes.extend_from_slice(&chunk[..room]);
            stopped_early = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    let total = started.elapsed();
    // PDF 即使只有 ASCII 也必须按二进制处理；下载接口可能只声明 octet-stream。
    let pdf = content_type.as_deref().is_some_and(|ct| {
        ct.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/pdf")
    }) || bytes.starts_with(b"%PDF-");
    let body = if !pdf && looks_textual(content_type.as_deref(), &bytes) {
        Some(String::from_utf8_lossy(&bytes).into_owned())
    } else {
        None
    };
    let size = response_size(&headers, bytes.len(), stopped_early);
    // 截断、206 部分内容和空正文都不是完整 PDF，预览只会报文件损坏；只为能完整渲染的响应保存字节。
    let previewable = pdf
        && !stopped_early
        && !bytes.is_empty()
        && status != reqwest::StatusCode::PARTIAL_CONTENT;
    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_owned(),
        version,
        headers,
        content_type,
        body,
        body_base64: previewable.then(|| STANDARD.encode(&bytes)),
        size,
        truncated: stopped_early,
        ttfb_ms: ttfb.as_secs_f64() * 1000.0,
        total_ms: total.as_secs_f64() * 1000.0,
        final_url,
    })
}

/// 超时单独成码，其余连同原因一起回到 `HTTP_NETWORK`。
fn http_err(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        err("HTTP_TIMEOUT", describe(error))
    } else {
        err("HTTP_NETWORK", describe(error))
    }
}

/// 提前停读时，有 `Content-Length` 就报声明的长度，否则报已经留下的字节数。
fn response_size(headers: &[(String, String)], stored: usize, stopped_early: bool) -> f64 {
    let stored = stored as u64;
    if !stopped_early {
        return stored as f64;
    }
    let declared = headers.iter().find_map(|(name, value)| {
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<u64>().ok())
            .flatten()
    });
    declared.filter(|len| *len > stored).unwrap_or(stored) as f64
}

/// reqwest 错误连同原因一起说（"error sending request: … connection refused"）。
fn describe(e: &reqwest::Error) -> String {
    use std::error::Error;
    let mut msg = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        let s_msg = s.to_string();
        if !msg.contains(&s_msg) {
            msg.push_str(": ");
            msg.push_str(&s_msg);
        }
        source = s.source();
    }
    msg
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::UNIX_EPOCH.elapsed().map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "forge-http-exec-{name}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn call(method: &str, url: &str) -> HttpRequestCall {
        HttpRequestCall {
            name: None,
            method: method.into(),
            url: url.into(),
            headers: vec![],
            body: vec![],
        }
    }

    #[test]
    fn replays_binary_body_without_lossy_text_conversion() {
        let tmp = temp_dir("replay");
        let bytes = [0, 255, 128, 13, 10, 42];
        std::fs::write(tmp.join("body.bin"), bytes).unwrap();
        let original: HttpRequestCall = serde_json::from_value(serde_json::json!({
            "method": "POST", "url": "http://api.test/upload",
            "body": [{ "file": "body.bin" }]
        })).unwrap();
        let (sent, original_body) = assemble(&original, Some(&tmp)).unwrap();
        // 经过历史 JSON 的实际序列化合同再重发，不依赖磁盘上的上传文件。
        let saved: SentRequest = serde_json::from_str(&serde_json::to_string(&sent).unwrap()).unwrap();
        let replay: HttpRequestCall = serde_json::from_value(serde_json::json!({
            "method": saved.method, "url": saved.url, "headers": saved.headers,
            "body": [{ "base64": saved.body_base64.unwrap() }]
        })).unwrap();
        let (_, replay_body) = assemble(&replay, None).unwrap();
        assert_eq!(original_body, bytes);
        assert_eq!(replay_body, bytes);
        let invalid: HttpRequestCall = serde_json::from_value(serde_json::json!({
            "method": "POST", "url": "http://api.test/upload", "body": [{ "base64": "!!" }]
        })).unwrap();
        assert!(assemble(&invalid, None).unwrap_err().starts_with("HTTP_BODY"));
    }

    #[test]
    fn assembles_text_and_file_pieces_in_order() {
        let tmp = temp_dir("include");
        std::fs::write(tmp.join("body.json"), "{\"id\": 7}\n").unwrap();
        // 从前端 JSON 入参开始，避免直接构造枚举绕过命令的反序列化契约。
        let c: HttpRequestCall = serde_json::from_value(serde_json::json!({
            "method": "post",
            "url": "api.test/items",
            "body": [{ "text": "head\n" }, { "file": "body.json" }],
        }))
        .unwrap();
        let (sent, body) = assemble(&c, Some(tmp.as_path())).unwrap();
        assert_eq!(sent.method, "POST");
        assert_eq!(sent.url, "http://api.test/items");
        assert_eq!(String::from_utf8(body).unwrap(), "head\n{\"id\": 7}\n");
        assert_eq!(sent.body.as_deref(), Some("head\n{\"id\": 7}\n"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn relative_body_file_needs_a_base_dir() {
        let mut c = call("POST", "http://x/");
        c.body = vec![BodyPart::File { file: "a.json".into() }];
        assert!(assemble(&c, None).unwrap_err().starts_with("HTTP_BODY"));
    }

    #[test]
    fn rejects_urls_without_http() {
        assert!(assemble(&call("GET", "ftp://x/"), None)
            .unwrap_err()
            .starts_with("HTTP_URL"));
        assert!(assemble(&call("GET", "  "), None)
            .unwrap_err()
            .starts_with("HTTP_URL"));
    }

    #[tokio::test]
    async fn sends_against_a_local_server() {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert_eq!(line, "POST /echo HTTP/1.1\r\n");
            let mut length = None;
            let mut headers = Vec::new();
            // 按 Content-Length 读完整正文，避免依赖 TCP 一次 read 恰好收到整条请求。
            loop {
                line.clear();
                assert_ne!(reader.read_line(&mut line).await.unwrap(), 0);
                if line == "\r\n" { break; }
                let (name, value) = line.split_once(':').unwrap();
                if name.eq_ignore_ascii_case("content-length") {
                    length = Some(value.trim().parse::<usize>().unwrap());
                }
                headers.push((name.to_ascii_lowercase(), value.trim().to_owned()));
            }
            let mut payload = vec![0; length.unwrap()];
            reader.read_exact(&mut payload).await.unwrap();
            assert!(headers.contains(&("content-type".into(), "application/json".into())));
            assert!(headers.contains(&("x-name".into(), "中文".into())));
            let body = "{\"ok\":true}";
            let resp = format!(
                "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-A: b\r\n\r\n{body}",
                body.len()
            );
            reader.get_mut().write_all(resp.as_bytes()).await.unwrap();
            (serde_json::from_slice::<serde_json::Value>(&payload).unwrap(), headers)
        });
        // 与 http_send 接收的正文格式一致，覆盖 JSON 解码到实际 POST 的路径。
        let c: HttpRequestCall = serde_json::from_value(serde_json::json!({
            "method": "POST",
            "url": format!("http://{addr}/echo"),
            "headers": [["Content-Type", "application/json"], ["X-Name", "中文"],
                ["X-Item", "one"], ["X-Item", "two"]],
            "body": [{ "text": "{\"id\":7}" }],
        }))
        .unwrap();
        let (mut sent, body) = assemble(&c, None).unwrap();
        // 无 requestId 的命令不会保留取消发送端，关闭通道不代表用户取消。
        let mut rx = watch::channel(false).1;
        let r = send(&mut sent, &body, &mut rx).await.unwrap();
        let (payload, mut wire_headers) = server.await.unwrap();
        assert_eq!(payload, serde_json::json!({ "id": 7 }));
        let mut recorded = sent.sent_headers.clone().unwrap();
        recorded.sort();
        wire_headers.sort();
        assert_eq!(recorded, wire_headers);
        assert!(recorded.contains(&("host".into(), addr.to_string())));
        assert!(recorded.contains(&("accept".into(), "*/*".into())));
        assert!(recorded.contains(&("user-agent".into(), "Forge".into())));
        assert!(recorded.contains(&("accept-encoding".into(), "gzip,deflate,br".into())));
        assert_eq!(recorded.iter().filter(|(name, _)| name == "x-item").count(), 2);
        // 历史 JSON 同时保留实际头和原始头，不能把默认值混进重发配置。
        let saved: SentRequest = serde_json::from_value(serde_json::to_value(&sent).unwrap()).unwrap();
        assert_eq!(saved.sent_headers, sent.sent_headers);
        assert_eq!(saved.headers, c.headers);
        assert_eq!(r.status, 201);
        assert_eq!(r.status_text, "Created");
        assert_eq!(r.body.as_deref(), Some("{\"ok\":true}"));
        assert!(r.headers.iter().any(|(k, v)| k == "x-a" && v == "b"));
        assert_eq!(r.final_url, format!("http://{addr}/echo"));
        assert!(r.total_ms >= r.ttfb_ms);
    }

    #[tokio::test]
    async fn records_empty_requests_and_explicit_header_overrides() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        for method in ["GET", "POST", "HEAD"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let mut reader = BufReader::new(socket);
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let mut headers = Vec::new();
                loop {
                    line.clear();
                    assert_ne!(reader.read_line(&mut line).await.unwrap(), 0);
                    if line == "\r\n" { break; }
                    let (name, value) = line.split_once(':').unwrap();
                    headers.push((name.to_ascii_lowercase(), value.trim().to_owned()));
                }
                reader.get_mut().write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await.unwrap();
                headers
            });
            let mut c = call(method, &format!("http://user:password@{addr}/"));
            c.headers = vec![
                ("User-Agent".into(), "custom-agent".into()),
                ("Accept".into(), "application/pdf".into()),
                ("Accept-Encoding".into(), "identity".into()),
                ("Range".into(), "bytes=0-99".into()),
            ];
            let (mut sent, body) = assemble(&c, None).unwrap();
            let mut rx = watch::channel(false).1;
            send(&mut sent, &body, &mut rx).await.unwrap();
            let mut wire = server.await.unwrap();
            let mut recorded = sent.sent_headers.unwrap();
            wire.sort();
            recorded.sort();
            assert_eq!(recorded, wire, "{method}");
            assert!(recorded.contains(&("authorization".into(), "Basic dXNlcjpwYXNzd29yZA==".into())));
            assert!(recorded.contains(&("user-agent".into(), "custom-agent".into())));
            assert!(recorded.contains(&("accept-encoding".into(), "identity".into())));
            assert_eq!(sent.headers, c.headers);
        }
    }

    #[tokio::test]
    async fn keeps_initial_headers_without_leaking_host_or_auth_to_redirects() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        async fn serve(listener: tokio::net::TcpListener, response: String) -> Vec<(String, String)> {
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let mut headers = Vec::new();
            loop {
                line.clear();
                assert_ne!(reader.read_line(&mut line).await.unwrap(), 0);
                if line == "\r\n" { break; }
                let (name, value) = line.split_once(':').unwrap();
                headers.push((name.to_ascii_lowercase(), value.trim().to_owned()));
            }
            reader.get_mut().write_all(response.as_bytes()).await.unwrap();
            headers
        }
        let initial = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let initial_addr = initial.local_addr().unwrap();
        let target_addr = target.local_addr().unwrap();
        let target_url = format!("http://{target_addr}/final");
        let first = tokio::spawn(serve(initial, format!(
            "HTTP/1.1 302 Found\r\nLocation: {target_url}\r\nContent-Length: 0\r\n\r\n"
        )));
        let last = tokio::spawn(serve(target, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".into()));
        let mut c = call("GET", &format!("http://{initial_addr}/start"));
        c.headers = vec![("Authorization".into(), "Bearer fixture".into())];
        let (mut sent, body) = assemble(&c, None).unwrap();
        let mut rx = watch::channel(false).1;
        let response = send(&mut sent, &body, &mut rx).await.unwrap();
        let mut first_headers = first.await.unwrap();
        let mut recorded = sent.sent_headers.unwrap();
        first_headers.sort();
        recorded.sort();
        assert_eq!(recorded, first_headers);
        let final_headers = last.await.unwrap();
        assert!(final_headers.contains(&("host".into(), target_addr.to_string())));
        assert!(!final_headers.iter().any(|(name, _)| name == "authorization"));
        assert_eq!(response.final_url, target_url);
    }

    #[tokio::test]
    async fn decodes_compressed_responses() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // 固定压缩后的 JSON，验证真实传输和解压，不在测试里复刻解码实现。
        let cases: &[(&str, &[u8])] = &[
            ("gzip", &[31,139,8,0,0,0,0,0,0,10,171,86,202,207,86,178,42,41,42,77,173,5,0,144,95,212,167,11,0,0,0]),
            ("deflate", &[120,156,171,86,202,207,86,178,42,41,42,77,173,5,0,22,227,4,17]),
            ("br", &[11,5,128,123,34,111,107,34,58,116,114,117,101,125,3]),
        ];
        for &(encoding, compressed) in cases {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let n = socket.read(&mut buf).await.unwrap();
                let request = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: {encoding}\r\nContent-Length: {}\r\n\r\n",
                    compressed.len()
                );
                socket.write_all(headers.as_bytes()).await.unwrap();
                socket.write_all(compressed).await.unwrap();
                request
            });
            let (mut sent, body) = assemble(&call("GET", &format!("http://{addr}/")), None).unwrap();
            // 显式声明编码时仍解压；未声明时由 reqwest 自动协商。
            if encoding == "gzip" {
                sent.headers.push(("Accept-Encoding".into(), "gzip".into()));
            }
            let (_tx, mut rx) = watch::channel(false);
            let response = send(&mut sent, &body, &mut rx).await.unwrap();
            let request = server.await.unwrap();
            let accept = request.lines().find_map(|line| line.strip_prefix("accept-encoding: ")).unwrap();
            assert!(accept.split(',').any(|value| value.trim() == encoding), "{accept}");
            assert_eq!(serde_json::from_str::<serde_json::Value>(response.body.as_deref().unwrap()).unwrap(), serde_json::json!({ "ok": true }));
            assert_eq!(response.size, 11.0);
        }
    }

    #[tokio::test]
    async fn preserves_complete_pdf_bytes_through_wire_and_history() {
        use super::super::history::{History, HttpExchange};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // 包含 ASCII PDF、二进制 PDF、下载接口、错误类型、截断、部分内容和空正文。
        // (类型, 字节, 是否按 PDF 处理, 是否截断, 状态码, 是否保存可预览字节)
        let cases = [
            ("Application/PDF; version=1.7", b"%PDF-1.7\nASCII PDF".to_vec(), true, false, 200, true),
            ("application/pdf", b"%PDF-1.7\n\xff\x00\x80".to_vec(), true, false, 200, true),
            ("application/octet-stream", b"%PDF-1.7\nDownloaded PDF".to_vec(), true, false, 200, true),
            ("application/json", br#"{"ok":true}"#.to_vec(), false, false, 200, false),
            ("application/octet-stream", vec![0, 255, 128], false, false, 200, false),
            ("application/pdf", vec![b'x'; MAX_BODY + 1], true, true, 200, false),
            // Range 请求只拿到片段，不能当完整 PDF 预览。
            ("application/pdf", b"%PDF-1.7\npartial".to_vec(), true, false, 206, false),
            ("application/pdf", Vec::new(), true, false, 200, false),
        ];
        let tmp = temp_dir("pdf-history");
        for (index, (content_type, bytes, pdf, truncated, status, previewable)) in cases.into_iter().enumerate() {
            let expected = bytes.clone();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                socket.read(&mut buf).await.unwrap();
                let reason = if status == 206 { "Partial Content" } else { "OK" };
                let headers = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n", bytes.len());
                socket.write_all(headers.as_bytes()).await.unwrap();
                // 截断时客户端主动停读，服务端可能收到连接关闭。
                let _ = socket.write_all(&bytes).await;
            });
            let (mut sent, body) = assemble(&call("GET", &format!("http://{addr}/")), None).unwrap();
            let (_tx, mut rx) = watch::channel(false);
            let response = send(&mut sent, &body, &mut rx).await.unwrap();
            server.await.unwrap();
            assert_eq!(response.truncated, truncated);
            assert_eq!(response.status, status);
            assert_eq!(response.size, expected.len() as f64);
            if pdf { assert!(response.body.is_none()); }
            let wire = serde_json::to_value(&response).unwrap();
            if previewable {
                assert_eq!(STANDARD.decode(wire["bodyBase64"].as_str().unwrap()).unwrap(), expected);
            } else {
                assert!(wire.get("bodyBase64").is_none());
            }
            let id = format!("pdf-{index}");
            let exchange: HttpExchange = serde_json::from_value(serde_json::json!({
                "entry": {"id": id, "timeMs": 1, "name": null, "method": "GET", "url": sent.url,
                    "status": status, "totalMs": 1, "file": null, "error": null},
                "request": sent, "response": wire,
            })).unwrap();
            History::new(tmp.clone()).add(&exchange).unwrap();
            let reopened = History::new(tmp.clone()).get(&id).unwrap().response.unwrap();
            assert_eq!(reopened.body_base64, response.body_base64);
            assert_eq!(reopened.body, response.body);
            assert_eq!(reopened.truncated, response.truncated);
            assert_eq!(reopened.size, response.size);
            assert_eq!(History::new(tmp.clone()).get(&id).unwrap().request.sent_headers, sent.sent_headers);
            // 已存在的历史不含 bodyBase64，仍可读取且不会伪造原始字节。
            let mut old = wire;
            old.as_object_mut().unwrap().remove("bodyBase64");
            assert!(serde_json::from_value::<HttpResponse>(old).unwrap().body_base64.is_none());
        }
    }

    #[tokio::test]
    async fn cancels() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // 接受连接但从不作答。
        tokio::spawn(async move {
            let _conn = listener.accept().await;
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        });
        let (mut sent, body) = assemble(&call("GET", &format!("http://{addr}/")), None).unwrap();
        let (tx, mut rx) = watch::channel(false);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let _ = tx.send(true);
        });
        let error = send(&mut sent, &body, &mut rx).await.unwrap_err();
        assert!(error.starts_with("HTTP_CANCELLED"), "{error}");
    }

    #[tokio::test]
    async fn invalid_header_is_not_reported_as_a_bad_url() {
        for (name, value) in [("Bad Header", "x"), ("X-Name", "a\r\nX-Injected: b"), ("X-Name", "\u{7f}")] {
            let (mut sent, body) = assemble(&call("GET", "http://example.com/"), None).unwrap();
            sent.headers.push((name.into(), value.into()));
            let (_tx, mut rx) = watch::channel(false);
            let error = send(&mut sent, &body, &mut rx).await.unwrap_err();
            assert!(error.starts_with("HTTP_HEADER"), "{error}");
            assert!(error.contains(name), "{error}");
        }
    }
}
