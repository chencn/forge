// 构建并运行真实 Tauri LSP IPC 验收程序；所有配置、fixture 和结果只写用户 Temp。
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("Native LSP verification skipped: this host currently requires Windows WebView2.");
  process.exit(0);
}

const repo = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "forge-lsp-native-"));
for (const folder of ["roaming", "local"]) mkdirSync(join(root, folder));
const resultPath = join(root, "result.json");
const targetRoot = resolve(repo, "src-tauri", process.env.CARGO_TARGET_DIR || "target");

const build = spawnSync(
  process.execPath,
  [resolve(repo, "scripts/run-rust.mjs"), "build", "--features", "lsp-smoke", "--bin", "lsp-smoke"],
  { cwd: repo, stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const binary = resolve(targetRoot, ...(process.env.CARGO_BUILD_TARGET ? [process.env.CARGO_BUILD_TARGET] : []), "debug/lsp-smoke.exe");
if (!existsSync(binary)) {
  console.error(`Native LSP smoke binary missing: ${binary}`);
  process.exit(1);
}

const child = spawn(binary, [], {
  cwd: root,
  windowsHide: true,
  env: {
    ...process.env,
    APPDATA: join(root, "roaming"),
    LOCALAPPDATA: join(root, "local"),
    FORGE_LSP_SMOKE_ROOT: root,
    FORGE_LSP_SMOKE_RESULT: resultPath,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-6000); });
child.stdout.resume();
const timer = setTimeout(() => child.kill(), 110000);
const exit = await new Promise((done) => {
  child.on("exit", (code, signal) => done({ code, signal }));
  child.on("error", (error) => done({ code: -1, signal: String(error) }));
});
clearTimeout(timer);

const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null;
console.log(JSON.stringify({ root, exit, result, stderr }, null, 2));
process.exitCode = exit.code === 0 && result?.ok === true ? 0 : 1;
