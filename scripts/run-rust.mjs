import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const cwd = fileURLToPath(new URL("../src-tauri", import.meta.url));
/** 读 `--name value` 或 `--name=value` 两种写法；未出现时返回 undefined，交给调用方取默认值。 */
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}
// cargo test 的二进制在 deps 下，WebView2Loader.dll 则在 profile 目录。
// 独立 --target-dir / CARGO_TARGET_DIR 必须使用自己的 DLL，不能依赖正在运行的 debug 目录。
const targetDir = resolve(cwd, option("--target-dir") ?? process.env.CARGO_TARGET_DIR ?? "target");
const triple = option("--target") ?? process.env.CARGO_BUILD_TARGET;
const profile = option("--profile") ?? (args.includes("--release") ? "release" : "debug");
// cargo 的 `--profile test`/`dev` 产物仍落在 debug 目录，其余 profile 用同名目录。
const binaryDir = resolve(targetDir, ...(triple ? [triple] : []), profile === "dev" || profile === "test" ? "debug" : profile);
const path = [binaryDir, process.env.PATH].filter(Boolean).join(delimiter);

// 测试二进制拿不到 tauri_build 嵌进正式 exe 的那份 manifest，comctl32 会被系统解析成
// v5，而 tao/muda 要的 TaskDialogIndirect 只有 v6 有，进程一启动就以
// STATUS_ENTRYPOINT_NOT_FOUND 退出。build.rs 的 link_manifest_into_tests 认这个开关，
// 且只在 windows-gnu 目标下动手，恒开没有副作用（已设过则以调用方为准）。
const env = {
  ...process.env,
  PATH: path,
  FORGE_TEST_MANIFEST: process.env.FORGE_TEST_MANIFEST ?? "1",
};

const result = spawnSync("cargo", args, {
  cwd,
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
