// Dedicated validation entrypoint avoids single-instance forwarding and live AI sessions.
fn main() {
    forge_lib::run_browser_smoke();
}
