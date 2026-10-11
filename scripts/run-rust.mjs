import { spawnSync } from "node:child_process";
import { delimiter } from "node:path";

// cargo test 的可执行文件落在 target/debug/deps，而 WebView2Loader.dll 只被复制到
// target/debug；把这个目录放进 PATH，测试进程才加载得到 tauri 依赖的 DLL。
const debugDir = new URL("../src-tauri/target/debug", import.meta.url).pathname.replace(/^\//, "");
const path = [debugDir, process.env.PATH].filter(Boolean).join(delimiter);

// 测试二进制拿不到 tauri_build 嵌进正式 exe 的那份 manifest，comctl32 会被系统解析成
// v5，而 tao/muda 要的 TaskDialogIndirect 只有 v6 有，进程一启动就以
// STATUS_ENTRYPOINT_NOT_FOUND 退出。build.rs 的 link_manifest_into_tests 认这个开关，
// 且只在 windows-gnu 目标下动手，恒开没有副作用（已设过则以调用方为准）。
const env = {
  ...process.env,
  PATH: path,
  FORGE_TEST_MANIFEST: process.env.FORGE_TEST_MANIFEST ?? "1",
};

const result = spawnSync("cargo", process.argv.slice(2), {
  cwd: new URL("../src-tauri", import.meta.url).pathname.replace(/^\//, ""),
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
