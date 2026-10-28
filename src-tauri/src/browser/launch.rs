//! Per-process configuration only. Never rewrite ~/.codex or ~/.claude.
use super::{host, Lease};
use crate::ai_cli::Provider;
use std::{path::PathBuf, process::Command};

/// Tauri 打包会把 sidecar 改名成 `forge-browser-mcp-<target-triple>[.exe]`，只有 cargo 直接产出时
/// 才和 forge.exe 同名同目录。只认裸名字的话，装出来的 Forge 每次 AI 会话都起不来。
fn companion() -> Result<PathBuf, String> {
    let directory = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("Forge 可执行文件目录不可用".to_string())?
        .to_path_buf();
    let arch = std::env::consts::ARCH;
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let vendor = match std::env::consts::OS {
        "windows" => "pc",
        "macos" => "apple",
        _ => "unknown",
    };
    // std::env::consts 里没有 target env，只能用 cfg! 取；macOS 的标准目标是空串。
    let environment = if cfg!(target_env = "msvc") {
        "msvc"
    } else if cfg!(target_env = "gnu") {
        "gnu"
    } else if cfg!(target_env = "musl") {
        "musl"
    } else {
        ""
    };
    let triple = if environment.is_empty() {
        format!("{arch}-{vendor}-{os}")
    } else {
        format!("{arch}-{vendor}-{os}-{environment}")
    };
    let suffix = std::env::consts::EXE_SUFFIX;
    for name in [format!("forge-browser-mcp-{triple}{suffix}"), format!("forge-browser-mcp{suffix}")] {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!("Forge browser companion missing next to {}. Run npm run browser:prepare before starting the desktop app.",directory.display()))
}

pub fn arguments(provider: Provider) -> Result<Vec<String>, String> {
    let command = companion()?.to_string_lossy().into_owned();
    let quote = |s: &str| serde_json::to_string(s).unwrap();
    match provider {
        Provider::Codex => Ok(vec![
            "-c".into(),format!("mcp_servers.forge_browser.command={}",quote(&command)),
            "-c".into(),"mcp_servers.forge_browser.args=[]".into(),
            "-c".into(),"mcp_servers.forge_browser.env_vars=[\"FORGE_BROWSER_ENDPOINT\",\"FORGE_BROWSER_TOKEN\"]".into(),
            "-c".into(),"mcp_servers.forge_browser.enabled=true".into(),
            "-c".into(),"mcp_servers.forge_browser.required=true".into(),
            "-c".into(),"mcp_servers.forge_browser.startup_timeout_sec=15".into(),
            "-c".into(),"mcp_servers.forge_browser.tool_timeout_sec=45".into(),
        ]),
        Provider::Claude => {
            // Inline JSON avoids token/config files and preserves the user's other MCP servers.
            let config = serde_json::json!({"mcpServers":{"forge_browser":{"type":"stdio","command":command,"args":[]}}});
            Ok(vec!["--mcp-config".into(),config.to_string(),"--append-system-prompt".into(),forge_browser::INSTRUCTIONS.into(),"--append-subagent-system-prompt".into(),forge_browser::INSTRUCTIONS.into(),"--system-prompt-snapshot".into(),"off".into(),"--no-chrome".into()])
        }
    }
}
pub fn environment(command: &mut Command, lease: &Lease) {
    let endpoint = host(&lease.app).lock().endpoint.clone();
    command
        .env("FORGE_BROWSER_ENDPOINT", endpoint)
        .env("FORGE_BROWSER_TOKEN", &lease.token);
}
