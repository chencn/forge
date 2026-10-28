use forge_browser::{
    failure,
    mcp::{response, Reply, Server},
    Request, MAX_FRAME, VERSION,
};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("forge-browser-mcp: {e}");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), String> {
    let endpoint =
        std::env::var("FORGE_BROWSER_ENDPOINT").map_err(|_| "missing Forge broker endpoint")?;
    let token = std::env::var("FORGE_BROWSER_TOKEN").map_err(|_| "missing run capability")?;
    // Do not expose the capability to programs launched by the companion.
    std::env::remove_var("FORGE_BROWSER_TOKEN");
    let mut input = BufReader::new(tokio::io::stdin());
    let mut output = tokio::io::stdout();
    let mut server = Server::default();
    loop {
        let mut line = Vec::new();
        let n = (&mut input)
            .take((MAX_FRAME + 1) as u64)
            .read_until(b'\n', &mut line)
            .await
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(());
        }
        if n > MAX_FRAME || !line.ends_with(b"\n") {
            return Err("MCP line exceeds limit or is incomplete".into());
        }
        let reply = match serde_json::from_slice(&line) {
            Ok(v) => server.handle(v),
            Err(_) => Reply::Message(
                serde_json::json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}),
            ),
        };
        let result = match reply {
            Reply::None => continue,
            Reply::Message(v) => v,
            Reply::Call {
                id,
                name,
                arguments,
            } => {
                let call = forge_browser::transport::call(
                    &endpoint,
                    Request {
                        version: VERSION.into(),
                        token: token.clone(),
                        tool: name,
                        arguments,
                    },
                );
                let result = match tokio::time::timeout(Duration::from_secs(45), call).await {
                    Ok(Ok(v)) => v,
                    Ok(Err(e)) => failure("BROKER_UNAVAILABLE", e),
                    Err(_) => failure("TIMEOUT", "browser operation timed out; do not retry a possibly dispatched action blindly"),
                };
                response(id, result)
            }
        };
        let mut bytes = serde_json::to_vec(&result).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        output.write_all(&bytes).await.map_err(|e| e.to_string())?;
        output.flush().await.map_err(|e| e.to_string())?;
    }
}
