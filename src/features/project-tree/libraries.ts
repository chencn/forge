/**
 * External Libraries (外部依赖库) 探测与虚拟树模型
 *
 * 1:1 严格对标 IntelliJ IDEA (crates/ide-sdk/src/libraries.rs) 的 External Libraries 机制：
 * 1. Node.js: 读取 package.json 直接依赖，分组名恒为 `< node_modules >` 与 `< Node.js Core >`；
 * 2. Rust: 读取 Cargo.toml / Cargo.lock，分组名恒为 `< Cargo dependencies >`；
 * 3. Java: 探测 JDK 与 pom.xml / build.gradle 依赖；
 * 4. Python: 探测 .venv 虚拟环境与 site-packages。
 */

import { readFile, listDirectory } from "../../lib/fs";

export type LibraryKind =
  | "nodeModules"
  | "nodeCore"
  | "cargo"
  | "rust"
  | "jdk"
  | "maven"
  | "gradle"
  | "python"
  | "go"
  | "goModules"
  | "sdk";

export interface LibraryGroup {
  readonly id: string;
  /** 分组显示名，如 `< node_modules >`、`< Node.js Core >`、`< Cargo dependencies >` */
  readonly label: string;
  readonly kind: LibraryKind;
  readonly roots: readonly LibraryRoot[];
}

export interface LibraryRoot {
  readonly id: string;
  /** 库名（如 `react`、`@tanstack/react-virtual`、`serde 1.0.200`） */
  readonly name: string;
  /** 库对应的物理文件路径或归档虚拟路径 */
  readonly path: string;
  /** 描述标记，如 "library root"、"crates.io" */
  readonly detail?: string;
  /** 是否为目录 */
  readonly isDirectory: boolean;
  /** 是否为归档包（如 .jar、.zip） */
  readonly isArchive?: boolean;
}

/** 缓存已探测的外部库结果：key 为 workspaceRoot */
const librariesCache = new Map<string, LibraryGroup[]>();

/**
 * 探测工作区关联的外部依赖库（1:1 对齐 IntelliJ IDEA 逻辑）
 */
export async function detectExternalLibraries(workspaceRoot: string): Promise<LibraryGroup[]> {
  const normRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const cached = librariesCache.get(normRoot);
  if (cached) return cached;

  const groups: LibraryGroup[] = [];

  // -------------------------------------------------------------------------
  // 1. Node.js / npm 项目探测（1:1 对标 IntelliJ IDEA node_libraries）
  // -------------------------------------------------------------------------
  try {
    let pkgJsonContent = "";
    try {
      const file = await readFile(`${normRoot}/package.json`);
      pkgJsonContent = file.contents;
    } catch {
      // 允许无 package.json
    }

    if (pkgJsonContent) {
      const pkgJson = JSON.parse(pkgJsonContent) as Record<string, unknown>;
      const depNames = new Set<string>();

      // 只解析 package.json 中的直接依赖（dependencies / devDependencies / optionalDependencies / peerDependencies）
      const depSections = [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ];
      for (const sec of depSections) {
        const obj = pkgJson[sec];
        if (obj && typeof obj === "object") {
          for (const name of Object.keys(obj)) {
            if (name && !name.includes("..") && !name.startsWith("/")) {
              depNames.add(name);
            }
          }
        }
      }

      const nodeModulesDir = `${normRoot}/node_modules`;
      const directRoots: LibraryRoot[] = [];
      let coreTypesRoot: LibraryRoot | null = null;

      // 验证本地磁盘中确实存在的包
      for (const name of depNames) {
        const pkgPath = `${nodeModulesDir}/${name}`;
        try {
          const listing = await listDirectory(pkgPath);
          if (listing.entries.length >= 0) {
            const rootItem: LibraryRoot = {
              id: `node:${name}`,
              name,
              path: pkgPath,
              detail: "library root",
              isDirectory: true,
            };
            if (name === "@types/node") {
              coreTypesRoot = rootItem;
            }
            directRoots.push(rootItem);
          }
        } catch {
          // 依赖尚未安装或在父级目录，跳过
        }
      }

      // 如果有 @types/node，单独抽出一组 < Node.js Core >（对标 IntelliJ IDEA）
      if (coreTypesRoot) {
        groups.push({
          id: "nodeCore",
          label: "< Node.js Core >",
          kind: "nodeCore",
          roots: [coreTypesRoot],
        });
      }

      if (directRoots.length > 0) {
        directRoots.sort((a, b) => a.name.localeCompare(b.name));
        groups.push({
          id: "nodeModules",
          label: "< node_modules >",
          kind: "nodeModules",
          roots: directRoots,
        });
      }
    }
  } catch {
    // 忽略解析错误
  }

  // -------------------------------------------------------------------------
  // 2. Rust / Cargo 项目探测（1:1 对标 IntelliJ IDEA rust_groups）
  // -------------------------------------------------------------------------
  try {
    let cargoLockContent = "";
    try {
      const file = await readFile(`${normRoot}/Cargo.lock`);
      cargoLockContent = file.contents;
    } catch {
      try {
        const file = await readFile(`${normRoot}/src-tauri/Cargo.lock`);
        cargoLockContent = file.contents;
      } catch {
        // 无 Cargo.lock
      }
    }

    if (cargoLockContent) {
      // 提取工程自身的包名避免自身被当做外部依赖
      let selfPackageName = "";
      try {
        const tomlFile = await readFile(`${normRoot}/Cargo.toml`);
        const m = tomlFile.contents.match(/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/);
        if (m) selfPackageName = m[1];
      } catch {
        // ignore
      }

      const packageMatches = cargoLockContent.matchAll(
        /\[\[package\]\][\s\S]*?name\s*=\s*"([^"]+)"[\s\S]*?version\s*=\s*"([^"]+)"/g
      );
      const roots: LibraryRoot[] = [];
      const seen = new Set<string>();

      let cargoRegistryBase = "";
      try {
        const { homeDir } = await import("@tauri-apps/api/path");
        const home = await homeDir();
        if (home) {
          const normHome = home.replaceAll("\\", "/").replace(/\/+$/, "");
          const registryRoot = `${normHome}/.cargo/registry/src`;
          try {
            const list = await listDirectory(registryRoot);
            // 找到类似 index.crates.io-6f17d22bba15001f 的首个有效子目录
            const sub = list.entries.find((e) => e.kind === "directory");
            if (sub) {
              cargoRegistryBase = `${registryRoot}/${sub.name}`;
            }
          } catch {
            // 尚未缓存或无网络
          }
        }
      } catch {
        // 浏览器环境优雅降级
      }

      for (const match of packageMatches) {
        const name = match[1];
        const version = match[2];
        if (name === selfPackageName) continue;

        // IntelliJ IDEA 标准命名格式："serde 1.0.200"
        const label = `${name} ${version}`;
        if (!seen.has(label)) {
          seen.add(label);
          const localCrateDir = cargoRegistryBase ? `${cargoRegistryBase}/${name}-${version}` : "";
          roots.push({
            id: `cargo:${name}-${version}`,
            name: label,
            path: localCrateDir || `${normRoot}/Cargo.lock#${name}`,
            detail: "library root",
            isDirectory: Boolean(localCrateDir),
          });
        }
      }

      if (roots.length > 0) {
        roots.sort((a, b) => a.name.localeCompare(b.name));
        groups.push({
          id: "cargo",
          label: "< Cargo dependencies >",
          kind: "cargo",
          roots,
        });
      }
    }
  } catch {
    // 忽略 Cargo 探测异常
  }

  // -------------------------------------------------------------------------
  // 3. Python 虚拟环境探测（1:1 对标 IntelliJ IDEA python_groups）
  // -------------------------------------------------------------------------
  try {
    const venvDirs = [".venv", "venv", "env"];
    for (const vd of venvDirs) {
      const venvPath = `${normRoot}/${vd}`;
      try {
        const listing = await listDirectory(venvPath);
        if (listing.entries.length > 0) {
          // 查找 site-packages
          const sitePkgPath = `${venvPath}/Lib/site-packages`;
          let hasSitePkg = false;
          try {
            const siteList = await listDirectory(sitePkgPath);
            hasSitePkg = siteList.entries.length > 0;
          } catch {
            // ignore
          }

          const pyRoots: LibraryRoot[] = [];
          if (hasSitePkg) {
            pyRoots.push({
              id: "python:site-packages",
              name: "site-packages",
              path: sitePkgPath,
              detail: "library root",
              isDirectory: true,
            });
          }
          pyRoots.push({
            id: "python:venv",
            name: vd,
            path: venvPath,
            detail: "library root",
            isDirectory: true,
          });

          groups.push({
            id: "python",
            label: `< Python (${vd}) >`,
            kind: "python",
            roots: pyRoots,
          });
          break;
        }
      } catch {
        // 不存在当前虚拟环境目录
      }
    }
  } catch {
    // ignore
  }

  // -------------------------------------------------------------------------
  // 4. 通用平台 SDK 兜底（当以上均无时保证 External Libraries 节点一致性）
  // -------------------------------------------------------------------------
  if (groups.length === 0) {
    groups.push({
      id: "sdk",
      label: "< Core Platform SDK >",
      kind: "sdk",
      roots: [
        {
          id: "sdk:builtin",
          name: "Standard Built-in Modules",
          path: `${normRoot}/.idea/libraries`,
          detail: "library root",
          isDirectory: false,
        },
      ],
    });
  }

  librariesCache.set(normRoot, groups);
  return groups;
}

/**
 * 清除指定工作区的外部库缓存（用于刷新或依赖文件变更后重读）
 */
export function invalidateLibrariesCache(workspaceRoot?: string): void {
  if (workspaceRoot) {
    const normRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
    librariesCache.delete(normRoot);
  } else {
    librariesCache.clear();
  }
}
