import { spawnSync } from "node:child_process";
import { delimiter } from "node:path";

// cargo test 的可执行文件落在 target/debug/deps，而 WebView2Loader.dll 只被复制到
// target/debug；把这个目录放进 PATH，测试进程才加载得到 tauri 依赖的 DLL。
const debugDir = new URL("../src-tauri/target/debug", import.meta.url).pathname.replace(/^\//, "");
const path = [debugDir, process.env.PATH].filter(Boolean).join(delimiter);

const result = spawnSync("cargo", process.argv.slice(2), {
  cwd: new URL("../src-tauri", import.meta.url).pathname.replace(/^\//, ""),
  stdio: "inherit",
  env: { ...process.env, PATH: path },
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
