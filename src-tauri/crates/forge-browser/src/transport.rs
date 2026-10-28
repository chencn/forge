//! Length-prefixed JSON is private broker framing, never MCP stdio framing.
use crate::{Request, MAX_FRAME};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub async fn read(stream: &mut (impl AsyncRead + Unpin)) -> Result<Value, String> {
    let len = stream.read_u32_le().await.map_err(|e| e.to_string())? as usize;
    if len == 0 || len > MAX_FRAME {
        return Err("invalid broker frame size".into());
    }
    let mut data = vec![0; len];
    stream
        .read_exact(&mut data)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&data).map_err(|e| e.to_string())
}
pub async fn write(stream: &mut (impl AsyncWrite + Unpin), value: &Value) -> Result<(), String> {
    let data = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if data.len() > MAX_FRAME {
        return Err("broker response exceeds size limit".into());
    }
    stream
        .write_u32_le(data.len() as u32)
        .await
        .map_err(|e| e.to_string())?;
    stream.write_all(&data).await.map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())
}

pub async fn call(endpoint: &str, request: Request) -> Result<Value, String> {
    #[cfg(windows)]
    let mut stream = {
        let mut connected = None;
        for _ in 0..50 {
            match tokio::net::windows::named_pipe::ClientOptions::new().open(endpoint) {
                Ok(s) => {
                    connected = Some(s);
                    break;
                }
                Err(e) if e.raw_os_error() == Some(231) => {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        connected.ok_or("browser broker busy")?
    };
    #[cfg(unix)]
    let mut stream = tokio::net::UnixStream::connect(endpoint)
        .await
        .map_err(|e| e.to_string())?;
    write(
        &mut stream,
        &serde_json::to_value(request).map_err(|e| e.to_string())?,
    )
    .await?;
    read(&mut stream).await
}

#[cfg(windows)]
pub fn server(
    endpoint: &str,
    first: bool,
) -> Result<tokio::net::windows::named_pipe::NamedPipeServer, String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    // Bind the DACL to TokenUser, not OW: an elevated token's default owner can be a group.
    let sid = current_user_sid()?;
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            &HSTRING::from(format!("D:P(A;;GA;;;{sid})")),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
        .map_err(|e| e.to_string())?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        let result = tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(endpoint, &attributes as *const _ as *mut _)
            .map_err(|e| e.to_string());
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        result
    }
}

#[cfg(windows)]
fn current_user_sid() -> Result<String, String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    static SID: std::sync::OnceLock<Result<String, String>> = std::sync::OnceLock::new();
    SID.get_or_init(|| unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|e| e.to_string())?;
        let result = (|| {
            let mut size = 0;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut size);
            if size == 0 {
                return Err("cannot read current user's SID".into());
            }
            // usize storage supplies TOKEN_USER alignment, including the embedded SID pointer.
            let mut bytes = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
            GetTokenInformation(
                token,
                TokenUser,
                Some(bytes.as_mut_ptr().cast()),
                size,
                &mut size,
            )
            .map_err(|e| e.to_string())?;
            let user = &*bytes.as_ptr().cast::<TOKEN_USER>();
            let mut sid = PWSTR::null();
            ConvertSidToStringSidW(user.User.Sid, &mut sid).map_err(|e| e.to_string())?;
            let text = sid.to_string().map_err(|e| e.to_string());
            let _ = LocalFree(Some(HLOCAL(sid.0.cast())));
            text
        })();
        let _ = CloseHandle(token);
        result
    })
    .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn frames_round_trip_and_reject_oversize() {
        let (mut a, mut b) = tokio::io::duplex(4096);
        write(&mut a, &serde_json::json!({"a":[1,"text"]}))
            .await
            .unwrap();
        assert_eq!(read(&mut b).await.unwrap()["a"][0], 1);
        a.write_u32_le((MAX_FRAME + 1) as u32).await.unwrap();
        assert!(read(&mut b).await.is_err());
    }
}
