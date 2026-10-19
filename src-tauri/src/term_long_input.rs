//! Windows 上 cmd / PowerShell 一次能吃下的命令行有上限（cmd 的文档写 8191 个字符）。
//! 超长又带回车的一段输入整段写进 PTY 会被截断，这里把它落成一份临时脚本，
//! 再往 PTY 写一句调用这份脚本的短命令。

use crate::error::err;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// 比 cmd 的 8191 留出余量，给调用那一句自己的长度。
const INPUT_LIMIT: usize = 7_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LongInputShell {
    Cmd,
    PowerShell,
}

/// 按可执行文件名认 shell；只有这两种需要改道。
pub fn shell_kind(program: &str) -> Option<LongInputShell> {
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program).to_ascii_lowercase();
    match name.as_str() {
        "cmd.exe" | "cmd" => Some(LongInputShell::Cmd),
        "powershell.exe" | "powershell" | "pwsh.exe" | "pwsh" => Some(LongInputShell::PowerShell),
        _ => None,
    }
}

/// 超过上限且带回车，才算「一次提交的长命令」。
///
/// 带 ESC 的不改道：括号粘贴的起止标记、方向键之类的序列落进脚本就成了乱码。
fn is_submitted_long_input(input: &str) -> bool {
    (input.len() > INPUT_LIMIT || input.encode_utf16().count() > INPUT_LIMIT)
        && input.contains(['\r', '\n'])
        && !input.contains('\u{1b}')
}

/// cmd 只有多行合计超长才改道；单独一行超长时 cmd 本身就执行不了，直接报错。
fn cmd_can_use_script(input: &str) -> Result<bool, String> {
    if !is_submitted_long_input(input) {
        return Ok(false);
    }
    let lines: Vec<&str> = input.lines().collect();
    let mut total = 0;
    for line in &lines {
        let encoded = encode_cmd_script(line)?.len();
        if encoded > INPUT_LIMIT {
            return Err(err("TERM_LONG_INPUT", INPUT_LIMIT));
        }
        total += encoded;
    }
    Ok(lines.len() > 1 && total > INPUT_LIMIT)
}

/// 需要改道时把脚本写好，返回要真正写进 PTY 的那句调用和脚本路径；不需要改道返回 None。
pub fn prepare(
    shell: LongInputShell,
    input: &str,
    directory: &Path,
) -> Result<Option<(String, PathBuf)>, String> {
    let needed = match shell {
        LongInputShell::Cmd => cmd_can_use_script(input)?,
        LongInputShell::PowerShell => is_submitted_long_input(input),
    };
    if !needed {
        return Ok(None);
    }

    let (extension, suffix) = match shell {
        LongInputShell::Cmd => ("cmd", "\r\n"),
        LongInputShell::PowerShell => ("ps1", "\n"),
    };
    let path = directory.join(format!("forge-terminal-{}.{extension}", unique_suffix()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| err("TERM_IO", error))?;
    let written = (|| {
        if shell == LongInputShell::PowerShell {
            // Windows PowerShell 5.1 不带 BOM 时按本地代码页读脚本，中文会坏。
            file.write_all(&[0xEF, 0xBB, 0xBF])?;
        }
        let body = match shell {
            LongInputShell::Cmd => encode_cmd_script(input).map_err(std::io::Error::other)?,
            LongInputShell::PowerShell => input.as_bytes().to_vec(),
        };
        file.write_all(&body)?;
        file.write_all(suffix.as_bytes())?;
        file.flush()
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&path);
        return Err(err("TERM_IO", error));
    }

    let invocation = match shell {
        LongInputShell::Cmd => format!("call \"{}\"\r\n", path.display()),
        LongInputShell::PowerShell => {
            let escaped = path.to_string_lossy().replace('\'', "''");
            format!(
                "try {{ Get-Content -Raw -LiteralPath '{escaped}' | Invoke-Expression }} finally {{ Remove-Item -LiteralPath '{escaped}' -Force -ErrorAction SilentlyContinue }}\n"
            )
        }
    };
    Ok(Some((invocation, path)))
}

fn unique_suffix() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed))
}

/// cmd 按控制台的 OEM 代码页读批处理文件。转不回原文的字符宁可拒收，也不让命令被悄悄改掉。
#[cfg(windows)]
fn encode_cmd_script(input: &str) -> Result<Vec<u8>, String> {
    use windows::Win32::Globalization::{
        GetOEMCP, MultiByteToWideChar, WideCharToMultiByte, MULTI_BYTE_TO_WIDE_CHAR_FLAGS,
    };
    let wide: Vec<u16> = input.encode_utf16().collect();
    if wide.is_empty() {
        return Ok(Vec::new());
    }
    let lossy = || err("TERM_LONG_INPUT_ENCODING", "cmd");
    unsafe {
        let code_page = GetOEMCP();
        let size = WideCharToMultiByte(code_page, 0, &wide, None, windows::core::PCSTR::null(), None);
        if size <= 0 {
            return Err(lossy());
        }
        let mut bytes = vec![0u8; size as usize];
        if WideCharToMultiByte(
            code_page,
            0,
            &wide,
            Some(&mut bytes),
            windows::core::PCSTR::null(),
            None,
        ) != size
        {
            return Err(lossy());
        }
        let flags = MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0);
        let decoded_len = MultiByteToWideChar(code_page, flags, &bytes, None);
        if decoded_len <= 0 {
            return Err(lossy());
        }
        let mut decoded = vec![0u16; decoded_len as usize];
        if MultiByteToWideChar(code_page, flags, &bytes, Some(&mut decoded)) != decoded_len
            || decoded != wide
        {
            return Err(lossy());
        }
        Ok(bytes)
    }
}

#[cfg(not(windows))]
fn encode_cmd_script(input: &str) -> Result<Vec<u8>, String> {
    Ok(input.as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn long_lines(count: usize) -> String {
        let line = "echo ".to_string() + &"a".repeat(1_000);
        vec![line; count].join("\r\n") + "\r"
    }

    #[test]
    fn short_or_unsubmitted_input_is_written_as_is() {
        let dir = std::env::temp_dir();
        assert!(prepare(LongInputShell::PowerShell, "dir\r", &dir).unwrap().is_none());
        let no_enter = "a".repeat(INPUT_LIMIT + 10);
        assert!(prepare(LongInputShell::PowerShell, &no_enter, &dir).unwrap().is_none());
    }

    #[test]
    fn bracketed_paste_is_never_rerouted() {
        let pasted = format!("\u{1b}[200~{}\u{1b}[201~", long_lines(10));
        assert!(!is_submitted_long_input(&pasted));
    }

    #[test]
    fn powershell_long_input_becomes_a_self_deleting_script() {
        let dir = std::env::temp_dir();
        let (invocation, path) = prepare(LongInputShell::PowerShell, &long_lines(10), &dir)
            .unwrap()
            .unwrap();
        assert!(invocation.contains("Invoke-Expression"));
        assert!(invocation.contains("Remove-Item"));
        let body = fs::read(&path).unwrap();
        assert_eq!(&body[..3], &[0xEF, 0xBB, 0xBF]);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn cmd_rejects_a_single_line_over_the_limit() {
        let one_line = "echo ".to_string() + &"a".repeat(INPUT_LIMIT + 10) + "\r";
        assert!(prepare(LongInputShell::Cmd, &one_line, &std::env::temp_dir()).is_err());
    }

    #[test]
    fn cmd_multi_line_input_becomes_a_call() {
        let dir = std::env::temp_dir();
        let (invocation, path) = prepare(LongInputShell::Cmd, &long_lines(10), &dir)
            .unwrap()
            .unwrap();
        assert!(invocation.starts_with("call \""));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn recognizes_shells_by_executable_name() {
        assert_eq!(shell_kind(r"C:\Windows\System32\cmd.exe"), Some(LongInputShell::Cmd));
        assert_eq!(
            shell_kind(r"C:\Program Files\PowerShell\7\pwsh.exe"),
            Some(LongInputShell::PowerShell)
        );
        assert_eq!(shell_kind(r"C:\Program Files\Git\bin\bash.exe"), None);
    }
}
