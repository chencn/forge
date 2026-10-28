// Native public-workflow regression harness. All profiles, uploads and results live in user temp.
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("Native browser verification skipped: this host currently requires Windows WebView2.");
  process.exit(0);
}
const repo = fileURLToPath(new URL("..", import.meta.url));
const run = (script, args = []) => {
  const built = spawnSync(process.execPath, [resolve(repo, script), ...args], { cwd: repo, stdio: "inherit" });
  if (built.status !== 0) process.exit(built.status ?? 1);
};
run("scripts/prepare-browser.mjs");
run("scripts/run-rust.mjs", ["build", "--features", "browser-smoke", "--bin", "forge-browser-smoke"]);
const root = mkdtempSync(join(tmpdir(), "forge-browser-native-"));
for (const folder of ["roaming", "local"]) mkdirSync(join(root, folder));
let frameRequests = 0;
const frame = http.createServer((_, res) => {
  frameRequests++;
  res.setHeader("content-type", "text/html");
  res.end("<button>FRAME_SECRET</button><script>console.log('FRAME_SECRET')</script>");
});
await new Promise((ready) => frame.listen(0, "127.0.0.1", ready));
const page = http.createServer((request, res) => {
  res.setHeader("cache-control", "no-store");
  if (request.url.startsWith("/network-probe")) {
    res.setHeader("content-type", "application/octet-stream");
    res.end(Buffer.alloc(96 * 1024, 1));
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Forge browser fixture</title>
<button onclick="document.getElementById('result').textContent='Action complete'">Run action</button>
<input aria-label="Name" oninput="document.getElementById('result').textContent=(event.isTrusted?'Trusted input: ':'Synthetic input: ')+this.value">
<input type="file" aria-label="Upload" onchange="document.getElementById('result').textContent='Uploaded: '+this.files[0].name">
<p id="result">Waiting</p><p id="frame-state">Waiting for frame</p><div role="button" aria-label="Frame cover" style="width:304px;height:154px"><iframe src="http://127.0.0.1:${frame.address().port}/" onload="document.getElementById('frame-state').textContent='Frame loaded'"></iframe></div>
<script>console.log('main console');document.addEventListener('click',e=>{window.lastFixtureClick={x:e.clientX,y:e.clientY,tag:e.target.tagName,text:e.target.textContent};},true);</script>`);
});
await new Promise((ready) => page.listen(0, "127.0.0.1", ready));
const resultPath = join(root, "result.json");
const targetRoot = resolve(repo, "src-tauri", process.env.CARGO_TARGET_DIR || "target");
const binary = resolve(targetRoot, ...(process.env.CARGO_BUILD_TARGET ? [process.env.CARGO_BUILD_TARGET] : []), "debug/forge-browser-smoke.exe");
const child = spawn(binary, [], {
  cwd: root, windowsHide: true,
  env: { ...process.env, APPDATA: join(root, "roaming"), LOCALAPPDATA: join(root, "local"), FORGE_BROWSER_SMOKE_ROOT: root, FORGE_BROWSER_SMOKE_RESULT: resultPath, FORGE_BROWSER_SMOKE_URL: `http://127.0.0.1:${page.address().port}/` },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-3000); });
child.stdout.resume();
const timer = setTimeout(() => child.kill(), 125000);
const exit = await new Promise((done) => { child.on("exit", done); child.on("error", (error) => { stderr += String(error); done(-1); }); });
clearTimeout(timer); page.close(); frame.close();
const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null;
console.log(JSON.stringify({ root, exit, frameRequests, result, stderr }, null, 2));
process.exitCode = exit === 0 && result?.ok === true && frameRequests > 0 ? 0 : 1;
