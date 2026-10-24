use super::{
    claude::Claude,
    codex::Codex,
    process::{Input, Process},
    protocol::{Action, Protocol},
};
use serde_json::json;
use std::{path::PathBuf, process::Command, time::Duration};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "forge-ai-pipe-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn node() -> String {
    crate::lsp_probe::resolve_command("node").expect("mock CLI tests require Node.js")
}
fn process(fixture: &Fixture, provider: &str, scenario: &str) -> Process {
    let mut cmd = Command::new(node());
    cmd.arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/ai-runtime-cli.mjs"))
        .args([provider, scenario]);
    Process::spawn(cmd, &fixture.0.to_string_lossy()).unwrap()
}
#[test]
fn both_protocols_real_pipes_deny_allow_resume_and_interrupt() {
    for provider in ["codex", "claude"] {
        for scenario in ["deny", "allow", "interrupt", "resume"] {
            let fixture = Fixture::new();
            let mut process = process(&fixture, provider, scenario);
            let native = if scenario == "resume" {
                Some("native-session".into())
            } else {
                None
            };
            let mut protocol: Box<dyn Protocol> = if provider == "codex" {
                Box::new(Codex::new(
                    fixture.0.to_string_lossy().into_owned(),
                    "hello".into(),
                    native,
                ))
            } else {
                Box::new(Claude::new(
                    fixture.0.to_string_lossy().into_owned(),
                    "hello".into(),
                    native,
                ))
            };
            let mut actions = protocol.start().unwrap();
            let mut text = String::new();
            let mut finished = false;
            let mut bound = false;
            for _ in 0..40 {
                for action in std::mem::take(&mut actions) {
                    match action {
                        Action::Write(value) => process.write(&value).unwrap(),
                        Action::Bind(id) => {
                            assert_eq!(id, "native-session");
                            bound = true;
                        }
                        Action::Emit { kind: "text", data } => {
                            text.push_str(data["text"].as_str().unwrap())
                        }
                        Action::Emit {
                            kind: "message",
                            data,
                        } => text = data["text"].as_str().unwrap().into(),
                        Action::Request { key, .. } => actions.extend(if scenario == "interrupt" {
                            protocol.interrupt()
                        } else {
                            protocol
                                .respond(&key, json!({"allow":scenario=="allow"}))
                                .unwrap()
                        }),
                        Action::Finish { status, error } => {
                            assert!(error.is_none());
                            assert_eq!(
                                status,
                                if scenario == "interrupt" {
                                    "cancelled"
                                } else {
                                    "completed"
                                }
                            );
                            finished = true;
                        }
                        _ => {}
                    }
                }
                if finished {
                    break;
                }
                if !actions.is_empty() {
                    continue;
                }
                match process
                    .incoming
                    .recv_timeout(Duration::from_secs(10))
                    .unwrap()
                {
                    Input::Json(value) => actions = protocol.receive(value).unwrap(),
                    Input::Error(e) => panic!("{e}"),
                    Input::Eof => panic!("premature EOF"),
                }
            }
            assert!(finished && bound, "{provider}/{scenario}");
            assert_eq!(text, "中文😀");
            process.terminate();
            assert_eq!(
                fixture.0.join("allowed-marker.txt").exists(),
                scenario == "allow",
                "{provider}/{scenario}"
            );
        }
    }
}
#[test]
fn claude_context_snapshot_refreshes_during_the_turn_and_never_blocks_completion() {
    for scenario in ["context", "context-timeout", "context-unsupported"] {
        let f = Fixture::new();
        let mut process = process(&f, "claude", scenario);
        let mut p = Claude::new(f.0.to_string_lossy().into_owned(), "fixture".into(), None);
        let mut actions = p.start().unwrap();
        let mut result = None;
        let mut context = None;
        let mut unavailable = false;
        let started = std::time::Instant::now();
        loop {
            assert!(started.elapsed() < Duration::from_secs(10));
            for action in std::mem::take(&mut actions) {
                match action {
                    Action::Write(v) => process.write(&v).unwrap(),
                    Action::Request { key, .. } => actions.extend(p.respond(&key, json!({"allow":false})).unwrap()),
                    Action::Finish { status, error } => {
                        assert!(error.is_none());
                        result = Some(status);
                        actions.extend(p.context_timeout());
                    }
                    Action::Emit { kind: "context", data } => context = Some(data),
                    Action::Emit { kind: "context_unavailable", .. } => unavailable = true,
                    _ => {}
                }
            }
            if !actions.is_empty() { continue; }
            if result.is_some() && !p.context_pending() {
                process.close_input();
                if let Some(exit) = process.status().unwrap() { assert!(exit.success()); break; }
            }
            match process.incoming.recv_timeout(Duration::from_millis(20)) {
                Ok(Input::Json(value)) => actions = p.receive(value).unwrap(),
                Ok(Input::Eof) => actions = p.context_timeout(),
                Ok(Input::Error(e)) => panic!("{e}"),
                Err(_) => {}
            }
        }
        assert_eq!(result, Some("completed"));
        if scenario == "context" {
            let context = context.unwrap();
            assert_eq!(context["totalTokens"], 6000);
            assert_eq!(context["categories"][1]["name"], "MCP tools");
            assert!(context.get("apiUsage").is_none());
            assert!(!unavailable);
        } else { assert!(context.is_none() && unavailable, "{scenario}"); }
    }
}
#[test]
fn slash_commands_use_real_pipes_without_model_fallback_or_argument_rewriting() {
    use super::commands::CommandIntent;
    for (provider, scenario, prompt, intent) in [
        ("codex", "slash-compact", "/compact", CommandIntent::CodexCompact),
        ("codex", "slash-review", "/review  \"a b\" --flag\n第二行  ", CommandIntent::CodexReview),
        ("codex", "slash-review-default", "/review", CommandIntent::CodexReview),
        ("claude", "slash-claude", "/fixture:check  \"a b\" --flag\n第二行  ", CommandIntent::ClaudeSlash),
        ("claude", "slash-missing", "/removed args", CommandIntent::ClaudeSlash),
    ] {
        let f = Fixture::new();
        let mut process = process(&f, provider, scenario);
        let root = f.0.to_string_lossy().into_owned();
        let mut p: Box<dyn Protocol> = if provider == "codex" {
            Box::new(Codex::new(root, prompt.into(), Some("native-session".into())).with_command(Some(intent)))
        } else { Box::new(Claude::new(root, prompt.into(), None).with_command(Some(intent))) };
        let mut actions = p.start().unwrap();
        let mut finished = None;
        let mut outputs = Vec::new();
        let mut catalog = None;
        let mut compacted = false;
        let mut completion_received = false;
        for _ in 0..40 {
            for action in std::mem::take(&mut actions) {
                match action {
                    Action::Write(v) => {
                        assert_ne!(v["method"], "turn/start");
                        if scenario == "slash-missing" { assert_ne!(v["type"], "user"); }
                        process.write(&v).unwrap();
                    }
                    Action::Emit { kind: "commands", data } => {
                        assert!(!data.to_string().contains("discard-fixture-secret"));
                        catalog = Some(data);
                    }
                    Action::Emit { kind: "message" | "command_output", data } => outputs.push(data["text"].as_str().unwrap().to_owned()),
                    Action::Emit { kind: "compaction", .. } => compacted = true,
                    Action::Finish { status, error } => {
                        assert_eq!(error.is_some(), scenario == "slash-missing");
                        if provider == "codex" { assert!(completion_received, "ack/item must not finish a command"); }
                        finished = Some(status);
                    }
                    _ => {}
                }
            }
            if finished.is_some() { break; }
            match process.incoming.recv_timeout(Duration::from_secs(10)).unwrap() {
                Input::Json(v) => { completion_received |= v["method"] == "turn/completed"; actions = p.receive(v).unwrap(); }
                Input::Error(e) => panic!("{scenario}: {e}"),
                Input::Eof => panic!("{scenario}: premature EOF"),
            }
        }
        assert_eq!(finished, Some(if scenario == "slash-missing" { "failed" } else { "completed" }), "{scenario}");
        if scenario == "slash-compact" { assert!(compacted); }
        if scenario.starts_with("slash-review") { assert_eq!(outputs, ["fixture review 中文😀"]); }
        if scenario == "slash-claude" {
            assert_eq!(outputs, ["fixture output 中文😀"]);
            let catalog = catalog.unwrap();
            assert_eq!(catalog["commands"].as_array().unwrap().len(), 1);
            assert_eq!(catalog["commands"][0]["name"], "replacement");
            assert_eq!(catalog["terminal"], json!(["exit"]));
        }
        process.terminate();
    }
}
#[test]
fn oversized_output_is_rejected_without_unbounded_capture() {
    let f = Fixture::new();
    let mut p = process(&f, "codex", "oversize");
    p.write(&json!({})).unwrap();
    assert!(matches!(
        p.incoming.recv_timeout(Duration::from_secs(10)).unwrap(),
        Input::Error(_)
    ));
    p.terminate();
}
#[test]
fn crashes_and_truncated_protocol_are_not_success() {
    let f = Fixture::new();
    let mut p = process(&f, "claude", "crash");
    p.write(&json!({})).unwrap();
    assert!(matches!(
        p.incoming.recv_timeout(Duration::from_secs(10)).unwrap(),
        Input::Eof
    ));
    let start = std::time::Instant::now();
    let status = loop {
        if let Some(status) = p.status().unwrap() {
            break status;
        }
        assert!(start.elapsed() < Duration::from_secs(5));
        std::thread::yield_now();
    };
    assert!(!status.success());
    p.terminate();
    assert!(p.diagnostics().contains("fixture crash"));
    let mut p = process(&f, "claude", "truncated");
    p.write(&json!({})).unwrap();
    assert!(matches!(
        p.incoming.recv_timeout(Duration::from_secs(10)).unwrap(),
        Input::Error(_)
    ));
    p.terminate();
}
#[test]
fn saturated_reader_can_be_stopped_without_draining_all_output() {
    let f = Fixture::new();
    let mut p = process(&f, "codex", "flood");
    p.write(&json!({})).unwrap();
    assert!(matches!(
        p.incoming.recv_timeout(Duration::from_secs(10)).unwrap(),
        Input::Json(_)
    ));
    let start = std::time::Instant::now();
    p.terminate();
    assert!(start.elapsed() < Duration::from_secs(5));
    assert!(p.status().unwrap().is_some());
}
#[test]
fn process_tree_cleanup_reaps_pipe_holding_descendant() {
    let f = Fixture::new();
    let mut p = process(&f, "codex", "child");
    p.write(&json!({})).unwrap();
    let pid = match p.incoming.recv_timeout(Duration::from_secs(10)).unwrap() {
        Input::Json(v) => v["childPid"].as_u64().unwrap(),
        _ => panic!("missing descendant"),
    };
    p.terminate();
    let mut check = Command::new(node());
    check.args([
        "-e",
        &format!("try {{process.kill({pid},0);process.exit(1)}} catch {{process.exit(0)}}"),
    ]);
    assert!(
        check.status().unwrap().success(),
        "CLI descendant survived cleanup"
    );
}
