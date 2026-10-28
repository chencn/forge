//! Per-process configuration only. Never rewrite ~/.codex or ~/.claude.
use super::{host, Lease};
use crate::ai_cli::Provider;
use std::process::Command;

pub fn arguments(provider: Provider) -> Result<Vec<String>, String> {
    let executable = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name(if cfg!(windows) {
            "forge-browser-mcp.exe"
        } else {
            "forge-browser-mcp"
        });
    if !executable.is_file() {
        return Err(format!("Forge browser companion missing: {}. Run npm run browser:prepare before starting the desktop app.",executable.display()));
    }
    let command = executable.to_string_lossy();
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
    command
        .env("FORGE_BROWSER_ENDPOINT", &host(&lease.app).endpoint)
        .env("FORGE_BROWSER_TOKEN", &lease.token);
}
