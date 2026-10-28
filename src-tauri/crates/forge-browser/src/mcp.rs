//! MCP JSONL state machine. stdout is reserved for JSON-RPC responses.
use crate::{failure, tools, VERSION};
use serde_json::{json, Value};

#[derive(Default)]
pub struct Server {
    initialized: bool,
    ready: bool,
}
pub enum Reply {
    Message(Value),
    Call {
        id: Value,
        name: String,
        arguments: Value,
    },
    None,
}
pub fn response(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}
fn error(id: Value, code: i32, message: &str) -> Reply {
    Reply::Message(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}))
}
impl Server {
    pub fn handle(&mut self, request: Value) -> Reply {
        let id = request.get("id").cloned();
        let method = request["method"].as_str().unwrap_or("");
        if request["jsonrpc"] != "2.0" || !request.is_object() {
            return error(
                id.unwrap_or(Value::Null),
                -32600,
                "invalid JSON-RPC request",
            );
        }
        if id.is_none() {
            if method == "notifications/initialized" && self.initialized {
                self.ready = true;
            }
            return Reply::None;
        }
        let id = id.unwrap();
        if !id.is_string() && !id.is_number() {
            return error(Value::Null, -32600, "request id must be a string or number");
        }
        match method {
            "initialize" if !self.initialized => {
                let requested = request["params"]["protocolVersion"].as_str().unwrap_or("");
                let version = if ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]
                    .contains(&requested)
                {
                    requested
                } else {
                    "2025-06-18"
                };
                self.initialized = true;
                Reply::Message(response(
                    id,
                    json!({"protocolVersion":version,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"forge_browser","version":VERSION},"instructions":crate::INSTRUCTIONS}),
                ))
            }
            "ping" => Reply::Message(response(id, json!({}))),
            _ if !self.ready => error(
                id,
                -32002,
                "send initialize and notifications/initialized first",
            ),
            "tools/list" => Reply::Message(response(id, json!({"tools":tools()}))),
            "tools/call" => {
                let name = request["params"]["name"].as_str().unwrap_or("").to_string();
                let arguments = request["params"]
                    .get("arguments")
                    .cloned()
                    .unwrap_or(json!({}));
                match crate::validate(&name, &arguments) {
                    Ok(()) => Reply::Call {
                        id,
                        name,
                        arguments,
                    },
                    Err(e) => Reply::Message(response(id, failure("INVALID_ARGUMENT", e))),
                }
            }
            _ => error(id, -32601, "method not found"),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lifecycle_and_tool_result_contract() {
        let mut server = Server::default();
        let call = json!({"jsonrpc":"2.0","id":2,"method":"tools/list"});
        let Reply::Message(v) = server.handle(call.clone()) else {
            panic!()
        };
        assert_eq!(v["error"]["code"], -32002);
        let Reply::Message(v) = server.handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}})) else { panic!() };
        assert_eq!(v["result"]["protocolVersion"], "2025-06-18");
        server.handle(json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
        let Reply::Message(v) = server.handle(call) else {
            panic!()
        };
        assert_eq!(v["result"]["tools"].as_array().unwrap().len(), 14);
        let Reply::Message(v) = server.handle(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_status","arguments":{"session":"spoofed"}}})) else { panic!() };
        assert_eq!(v["result"]["isError"], true);
    }
}
