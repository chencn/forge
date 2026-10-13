import { invoke } from "@tauri-apps/api/core";
import type { RunConfiguration, RunKind } from "./runConfigs";

/** 后端 `dep_sync_probe` 返回的单个构建单元依赖快照。 */
export interface DepSyncItem {
  /** 稳定单元标识，如 `"npm::package.json"`、`"maven::sub/pom.xml"`。 */
  id: string;
  /** 构建工具类型，供界面复用 `RunKindIcon`。 */
  kind: RunKind;
  /** 展示用的主构建文件相对路径（以 `/` 分隔）。 */
  manifest: string;
  /** 该单元关联的所有受控构建文件（相对路径 -> 语义 CRC32）。 */
  filesCrc: Record<string, number>;
  /** 本地依赖目录是否缺失（如 `node_modules` 不存在或为空）。 */
  missingInstalled: boolean;
  /** 预生成的标准运行配置，可直接传给 `run.start(item.installConfig, root)` 运行。 */
  installConfig: RunConfiguration;
}

/** 触发依赖同步提示的原因：首次打开缺失本地依赖目录，或受控构建清单发生了语义修改。 */
export type DepSyncReason = "missing" | "modified";

/** 前端挂在当前工作区待显示的依赖同步提示项。 */
export interface DepSyncPrompt extends DepSyncItem {
  /** 所属工作区根路径。 */
  root: string;
  reason: DepSyncReason;
  signature: string;
}

/** 扫描指定工作区根目录下的构建依赖状态与语义 CRC32。 */
export function depSyncProbe(root: string): Promise<DepSyncItem[]> {
  return invoke<DepSyncItem[]>("dep_sync_probe", { root });
}

/** 受控构建声明与包锁文件名集合（统一小写匹配；排除 `Cargo.lock` 与 `go.sum` 等编译期自动改写的副产物以避免误报）。 */
const WATCH_BUILD_FILES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "libs.versions.toml",
  "cargo.toml",
  "rust-toolchain.toml",
  "config.toml",
  "go.mod",
  "go.work",
  "pyproject.toml",
  "pipfile",
  "pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "requirements.txt",
  "composer.json",
  "composer.lock",
  "gemfile",
  "gemfile.lock",
  "pubspec.yaml",
  "pubspec.lock",
  "mix.exs",
  "mix.lock",
  "directory.packages.props",
]);

/** 产物目录内部深层文件不应被误判为工程构建清单（如 `node_modules/foo/package.json`）。 */
const IGNORED_ANCESTOR_DIRS = new Set([
  "node_modules",
  ".git",
  ".idea",
  ".gradle",
  ".mvn",
  ".venv",
  "venv",
  "__pycache__",
  "bin",
  "build",
  "dist",
  "out",
  "target",
  "vendor",
  ".dart_tool",
]);

/** 本地依赖安装完成/移除时的生态分类。 */
export type InstalledEcosystem = "npm" | "python" | "php" | "dart";

/** Node 包管理器安装就绪标志文件名（npm / pnpm / yarn v1 / yarn berry / bun）。 */
const NODE_INSTALL_MARKERS = new Set([
  "node_modules",
  ".modules.yaml",
  ".package-lock.json",
  ".yarn-integrity",
  ".yarn-state.yml",
  ".bun",
]);

/** 将绝对路径归一化为相对于 `root` 的路径段数组；若路径不落在指定 `root` 下则返回空数组。 */
function toRelativeSegments(path: string, root?: string): string[] {
  const normPath = path.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normPath) return [];

  if (root) {
    const normRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
    if (!normPath.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) {
      // 严禁将非当前工作区根的路径作为相对路径切片，防止后台跨工程事件误判
      return [];
    }
    return normPath.slice(normRoot.length + 1).split("/").filter(Boolean);
  }
  return normPath.split("/").filter(Boolean);
}

/**
 * 识别一条变更路径是否代表某类包管理器完成了本地依赖目录安装或清理，
 * 并返回其所属生态（`"npm" | "python" | "php" | "dart"`）；非安装标志路径返回 `null`。
 *
 * 排除 `node_modules/.vite/...`、`node_modules/.cache/...` 等开发期缓存写入，
 * 同时确保混合工程（如 Tauri 的 `npm` + `rust`）中外部执行 `npm install` 只晋升 `npm` 基线，不误清 `Cargo.toml` 提示。
 */
export function detectInstalledEcosystem(
  path: string,
  root?: string
): InstalledEcosystem | null {
  const segments = toRelativeSegments(path, root);
  if (segments.length === 0 || segments.length > 5) return null;
  const lower = segments.map((s) => s.toLowerCase());
  const base = lower[lower.length - 1];

  // Node: node_modules 及其顶层安装状态文件（排除 .vite / .cache / .tmp）
  const nmIdx = lower.indexOf("node_modules");
  if (nmIdx >= 0 && nmIdx <= 2) {
    const afterNm = lower[nmIdx + 1];
    if (afterNm === ".vite" || afterNm === ".cache" || afterNm === ".tmp") {
      return null;
    }
    if (nmIdx === lower.length - 1 || (nmIdx === lower.length - 2 && NODE_INSTALL_MARKERS.has(base))) {
      return "npm";
    }
  }

  // PHP Composer: vendor/autoload.php 或 vendor/composer/installed.json
  const vendorIdx = lower.indexOf("vendor");
  if (vendorIdx >= 0 && vendorIdx <= 2) {
    if (
      (vendorIdx === lower.length - 2 && base === "autoload.php") ||
      (vendorIdx === lower.length - 3 && lower[vendorIdx + 1] === "composer" && base === "installed.json")
    ) {
      return "php";
    }
  }

  // Dart / Flutter: .dart_tool/package_config.json
  const dartIdx = lower.indexOf(".dart_tool");
  if (dartIdx >= 0 && dartIdx <= 2 && dartIdx === lower.length - 2 && base === "package_config.json") {
    return "dart";
  }

  // Python: .venv / venv 创建或 wheel 安装完成标记（pyvenv.cfg / *.dist-info/INSTALLER）
  const venvIdx = lower.findIndex((seg) => seg === ".venv" || seg === "venv");
  if (venvIdx >= 0 && venvIdx <= 2) {
    if (
      venvIdx === lower.length - 1 ||
      (venvIdx === lower.length - 2 && base === "pyvenv.cfg") ||
      base === "installer"
    ) {
      return "python";
    }
  }

  return null;
}

/**
 * 判断单个路径是否为顶层或子模块下的依赖安装就绪标记。
 */
export function isInstallMarkerPath(path: string, root?: string): boolean {
  return detectInstalledEcosystem(path, root) !== null;
}

/**
 * 判断单个路径是否为工程自身的构建声明文件（不含 `node_modules` 等产物目录安装标记）。
 * 供顶栏运行配置自动重扫与依赖变更检测共用。
 */
export function isManifestDeclarationFile(path: string, root?: string): boolean {
  const segments = toRelativeSegments(path, root);
  if (segments.length === 0) return false;
  const base = segments[segments.length - 1].toLowerCase();

  // 排除任何落在 node_modules / target / vendor / build 等产物目录内部的文件
  for (let i = 0; i < segments.length - 1; i++) {
    if (IGNORED_ANCESTOR_DIRS.has(segments[i].toLowerCase())) {
      return false;
    }
  }

  // 与后端 WalkDir max_depth(2) 对齐：允许二级子模块下的 sub1/sub2/gradle/libs.versions.toml 或 sub1/sub2/.cargo/config.toml（共 4 段）
  if (root && segments.length > 4) {
    return false;
  }

  if (WATCH_BUILD_FILES.has(base)) return true;
  if (base.endsWith(".csproj") || base.endsWith(".fsproj")) return true;
  return false;
}

/**
 * 纯内存 $O(1)$ 判断一条磁盘变更路径是否可能影响构建依赖状态。
 *
 * 99.9% 的普通源码文件（`.ts`、`.rs`、`.java` 等）在此直接短路返回 `false`，不产生任何后端 IPC 调用；
 * 同时排除 `node_modules/pkg/package.json`、`target/.../Cargo.toml` 等第三方包内部文件，
 * 但放行顶层依赖目录（如 `node_modules/.modules.yaml`、`vendor/autoload.php`）以便外部终端装完依赖后自动消隐提示。
 */
export function isBuildWatchFile(path: string, root?: string): boolean {
  return isInstallMarkerPath(path, root) || isManifestDeclarationFile(path, root);
}

/** 计算 `filesCrc` 字典的确定性签名串，用于比对与忽略记忆。 */
export function crcSignature(filesCrc: Record<string, number>): string {
  return Object.entries(filesCrc)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, crc]) => `${file}:${crc >>> 0}`)
    .join("|");
}

/** 判断两份语义 CRC32 字典是否完全一致。 */
export function sameFilesCrc(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined
): boolean {
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** 将运行配置里的工具占位（`${mvn}` 等）格式化为按钮上可读的简洁命令。 */
export function formatSyncCommand(command: string): string {
  return command
    .replaceAll("${mvn}", "mvn")
    .replaceAll("${gradle}", "gradle")
    .replaceAll("${java}", "java")
    .replace(/\s+--refresh-dependencies\s+help$/, " --refresh-dependencies")
    .trim();
}
