import { describe, expect, it, vi } from "vitest";

// Mock 底层 fs 模块，使单元测试不依赖 Tauri 原生运行时
vi.mock("../../src/lib/fs", () => {
  return {
    readFile: vi.fn(async (path: string) => {
      const norm = path.replaceAll("\\", "/");
      if (!norm.startsWith("D:/mock_workspace")) {
        throw new Error(`File not found: ${path}`);
      }
      if (norm.endsWith("/package.json")) {
        return {
          contents: JSON.stringify({
            dependencies: {
              clsx: "^2.1.1",
              "@tanstack/react-virtual": "^3.13.2",
            },
            devDependencies: {
              "@types/node": "^22.0.0",
              typescript: "^5.5.0",
            },
          }),
        };
      }
      if (norm.endsWith("/Cargo.lock")) {
        return {
          contents: `
[[package]]
name = "forge-desktop"
version = "0.1.0"

[[package]]
name = "serde"
version = "1.0.200"

[[package]]
name = "tokio"
version = "1.38.0"
`,
        };
      }
      if (norm.endsWith("/Cargo.toml")) {
        return {
          contents: `
[package]
name = "forge-desktop"
version = "0.1.0"
`,
        };
      }
      throw new Error(`File not found: ${path}`);
    }),
    listDirectory: vi.fn(async (path: string) => {
      const norm = path.replaceAll("\\", "/");
      if (
        norm.endsWith("/node_modules/clsx") ||
        norm.endsWith("/node_modules/@tanstack/react-virtual") ||
        norm.endsWith("/node_modules/@types/node") ||
        norm.endsWith("/node_modules/typescript")
      ) {
        return { entries: [{ name: "index.js", kind: "file" }] };
      }
      throw new Error(`Directory not found: ${path}`);
    }),
  };
});

import {
  detectExternalLibraries,
  invalidateLibrariesCache,
} from "../../src/features/project-tree/libraries";
import {
  GROUP_PREFIX,
  LIB_PREFIX,
  LIB_SEP,
  isGroupKey,
  isLibKey,
  libKey,
  pathOfKey,
  normalizeNodeKey,
} from "../../src/features/project-tree/model";

describe("External Libraries Model & Detection", () => {
  it("conforms to openidea virtual key contracts", () => {
    // 1. Group key 契约
    const groupKey = `${GROUP_PREFIX}externalLibraries/nodeModules`;
    expect(isGroupKey(groupKey)).toBe(true);
    expect(isLibKey(groupKey)).toBe(false);

    // 2. Library root key 契约
    const rawPath = "D:/app/code/forge/node_modules/react";
    const k = libKey("nodeModules", rawPath);
    expect(isLibKey(k)).toBe(true);
    expect(isGroupKey(k)).toBe(false);
    expect(k).toBe(`${LIB_PREFIX}nodeModules${LIB_SEP}d:/app/code/forge/node_modules/react`);

    // 3. 从 libKey 还原物理路径
    expect(pathOfKey(k)).toBe("d:/app/code/forge/node_modules/react");
    expect(pathOfKey(groupKey)).toBe(groupKey);

    // 4. normalizeNodeKey 规整
    expect(normalizeNodeKey(k)).toBe(k);
    expect(normalizeNodeKey(groupKey)).toBe(groupKey);
  });

  it("detects libraries cache and respects invalidation", async () => {
    const root = "D:/mock_workspace";
    // 首次探测
    const res1 = await detectExternalLibraries(root);
    expect(Array.isArray(res1)).toBe(true);
    expect(res1.length).toBeGreaterThan(0);

    // 再次读取命中缓存
    const res2 = await detectExternalLibraries(root);
    expect(res1).toBe(res2);

    // 清理缓存后重新生成
    invalidateLibrariesCache(root);
    const res3 = await detectExternalLibraries(root);
    expect(res3).not.toBe(res1);
    expect(res3.length).toBe(res1.length);
  });

  it("identifies Node.js dependencies strictly from direct manifests", async () => {
    const root = "D:/mock_workspace";
    const groups = await detectExternalLibraries(root);
    const nodeModulesGroup = groups.find((g) => g.kind === "nodeModules");
    expect(nodeModulesGroup).toBeDefined();
    expect(nodeModulesGroup?.label).toBe("< node_modules >");

    // 必须包含 package.json 声明且安装了的直接依赖（如 clsx）
    const clsxRoot = nodeModulesGroup?.roots.find((r) => r.name === "clsx");
    expect(clsxRoot).toBeDefined();
    expect(clsxRoot?.detail).toBe("library root");
    expect(clsxRoot?.isDirectory).toBe(true);

    // 检测到 @types/node，单独抽为 < Node.js Core >
    const coreGroup = groups.find((g) => g.kind === "nodeCore");
    expect(coreGroup).toBeDefined();
    expect(coreGroup?.label).toBe("< Node.js Core >");
    expect(coreGroup?.roots.some((r) => r.name === "@types/node")).toBe(true);
  });

  it("identifies Cargo dependencies with name and version", async () => {
    const root = "D:/mock_workspace";
    const groups = await detectExternalLibraries(root);
    const cargoGroup = groups.find((g) => g.kind === "cargo");
    expect(cargoGroup).toBeDefined();
    expect(cargoGroup?.label).toBe("< Cargo dependencies >");
    // 依赖项命名严格对齐 openidea 格式："name version"
    expect(cargoGroup?.roots.some((r) => r.name === "serde 1.0.200")).toBe(true);
    expect(cargoGroup?.roots.some((r) => r.name === "tokio 1.38.0")).toBe(true);
    // 不应包含工程自身 (forge-desktop)
    expect(cargoGroup?.roots.some((r) => r.name.startsWith("forge-desktop"))).toBe(false);
  });

  it("provides fallback platform SDK if no manifests exist", async () => {
    // 模拟空工作区
    const fakeEmptyWorkspace = "C:/tmp/empty_workspace_test_for_forge";
    const groups = await detectExternalLibraries(fakeEmptyWorkspace);
    expect(groups.length).toBe(1);
    expect(groups[0]?.kind).toBe("sdk");
    expect(groups[0]?.label).toBe("< Core Platform SDK >");
  });
});
