// Build the small stdio sidecar before Tauri validates bundle inputs.
import { spawnSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const release = args.includes("--release");
const target = process.env.CARGO_BUILD_TARGET || process.env.TAURI_ENV_TARGET_TRIPLE;
const run = (program, argv, cwd = root) => {
  const result = spawnSync(program, argv, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const compiler = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
if (compiler.status !== 0) throw new Error("rustc unavailable");
const triple = target || compiler.stdout.match(/^host: (.+)$/m)?.[1]?.trim();
if (!triple) throw new Error("Rust target triple unavailable");
const suffix = triple.includes("windows") ? ".exe" : "";
const targetRoot = resolve(root, "src-tauri", process.env.CARGO_TARGET_DIR || "target");
const binaries = resolve(root, "src-tauri/binaries");
mkdirSync(binaries, { recursive: true });
// Tauri's universal target is a bundle target, not a Rust compiler target.
const targets = triple === "universal-apple-darwin" ? ["aarch64-apple-darwin", "x86_64-apple-darwin"] : [target];
const sources = targets.map((buildTarget) => {
  run("cargo", ["build", "-p", "forge-browser", "--bin", "forge-browser-mcp", ...(release ? ["--release"] : []), ...(buildTarget ? ["--target", buildTarget] : [])], resolve(root, "src-tauri"));
  return resolve(targetRoot, ...(buildTarget ? [buildTarget] : []), release ? "release" : "debug", `forge-browser-mcp${suffix}`);
});
const destination = resolve(binaries, `forge-browser-mcp-${triple}${suffix}`);
if (sources.length === 2) run("lipo", ["-create", ...sources, "-output", destination]);
else copyFileSync(sources[0], destination);
if (args.includes("--frontend")) run("npm", ["run", "build"]);
if (args.includes("--vite")) {
  const child = spawn("npm", ["run", "dev"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  child.on("exit", (status) => process.exit(status ?? 1));
}
