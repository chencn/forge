// 构建并运行真实主 WebView 的 LSP UI 验收程序；所有配置、fixture 和结果只写用户 Temp。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("Native LSP UI verification skipped: this host currently requires Windows WebView2.");
  process.exit(0);
}

const repo = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "forge-lsp-ui-native-"));
for (const folder of ["roaming", "local"]) mkdirSync(join(root, folder));
const workspace = join(root, "workspace");
mkdirSync(workspace);
// 后端的会话根是 canonicalize 过的长路径；Temp 在这台机器上会拿到 SHENGG~1 形式的
// 8.3 短路径，直接比较会误判成外部根。这里统一换成长路径再下传。
const longWorkspace = realpathSync(workspace);
const resultPath = join(root, "result.json");
const targetRoot = resolve(repo, "src-tauri", process.env.CARGO_TARGET_DIR || "target");

if (process.env.FORGE_SKIP_FRONTEND_BUILD !== "1") {
  const buildFrontend = spawnSync("npm", ["run", "build"], { cwd: repo, stdio: "inherit", shell: true });
  if (buildFrontend.status !== 0) process.exit(buildFrontend.status ?? 1);
}

const build = spawnSync(
  process.execPath,
  [resolve(repo, "scripts/run-rust.mjs"), "build", "--features", "lsp-ui-smoke", "--bin", "forge"],
  { cwd: repo, stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);

// Debug Tauri 配置使用 devUrl；原生 UI smoke 必须先提供同一个 Vite 页面，
// 否则 WebView 会正常启动但只显示 localhost 拒绝连接。
const vite = spawn("npm", ["run", "dev"], {
  cwd: repo,
  shell: true,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOutput = "";
vite.stdout.on("data", (data) => { viteOutput = (viteOutput + data).slice(-4000); });
vite.stderr.on("data", (data) => { viteOutput = (viteOutput + data).slice(-4000); });
let viteReady = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const response = await fetch("http://localhost:1420/");
    if (response.ok) {
      viteReady = true;
      break;
    }
  } catch {
    // Vite 正在启动，继续短轮询。
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
}
if (!viteReady) {
  vite.kill();
  console.error(`Vite dev server 未就绪：${viteOutput}`);
  process.exit(1);
}

const binary = resolve(targetRoot, ...(process.env.CARGO_BUILD_TARGET ? [process.env.CARGO_BUILD_TARGET] : []), "debug/forge.exe");
if (!existsSync(binary)) {
  console.error(`Native LSP UI smoke binary missing: ${binary}`);
  process.exit(1);
}

// 主窗口必须可见：这条 smoke 验收的就是用户实际看到的 WebView UI。
const child = spawn(binary, [longWorkspace, join(longWorkspace, "main.ts")], {
  cwd: root,
  windowsHide: false,
  env: {
    ...process.env,
    APPDATA: join(root, "roaming"),
    LOCALAPPDATA: join(root, "local"),
    FORGE_LSP_UI_SMOKE_ROOT: longWorkspace,
    FORGE_LSP_UI_SMOKE_RESULT: resultPath,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-8000); });
child.stdout.resume();
const timer = setTimeout(() => child.kill(), 150000);
const exit = await new Promise((done) => {
  child.on("exit", (code, signal) => done({ code, signal }));
  child.on("error", (error) => done({ code: -1, signal: String(error) }));
});
clearTimeout(timer);
vite.kill();

const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null;
console.log(JSON.stringify({ root, workspace, exit, result, stderr }, null, 2));
process.exitCode = exit.code === 0 && result?.ok === true ? 0 : 1;
