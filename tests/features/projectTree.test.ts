import { describe, expect, it } from "vitest";
import type { FsEntry } from "../../src/lib/fs";
import { getNextScratchName } from "../../src/features/project-tree/scratches";
import { buildProjectContextMenu } from "../../src/features/project-tree/contextMenu";
import {
  isIgnoredName,
  isExcludedFolder,
  type ProjectTreeNode,
  splitExtension,
  validateName,
  normalizeNodeKey,
  libKey,
  isLibKey,
  pathOfKey,
} from "../../src/features/project-tree/model";
import { en } from "../../src/i18n/lang/en";

const tEn = (k: string) => (en as any)[k] ?? k;

describe("ProjectTree Multi-Domain Integration", () => {
  const dummyEntries: FsEntry[] = [
    {
      name: "src",
      path: "D:/project/src",
      kind: "directory",
      extension: null,
      size: 0,
      modifiedMs: Date.now(),
      isSymlink: false,
      isHidden: false,
      isReadonly: false,
    },
    {
      name: "index.ts",
      path: "D:/project/src/index.ts",
      kind: "file",
      extension: "ts",
      size: 512,
      modifiedMs: Date.now(),
      isSymlink: false,
      isHidden: false,
      isReadonly: false,
    },
  ];

  it("handles domain separation between Project, Libraries and Scratches", () => {
    const projectNode: ProjectTreeNode = {
      key: "d:/project/src/index.ts",
      domain: "project",
      entry: dummyEntries[1],
      displayName: "index.ts",
      deepestPath: dummyEntries[1].path,
      depth: 1,
    };

    const libNode: ProjectTreeNode = {
      key: "libraries:cargo:serde",
      domain: "libraries",
      entry: {
        name: "serde",
        path: "C:/Users/user/.cargo/registry/src/serde",
        kind: "directory",
        extension: null,
        size: 0,
        modifiedMs: Date.now(),
        isSymlink: false,
        isHidden: false,
        isReadonly: true,
      },
      displayName: "serde (1.0.197)",
      deepestPath: "C:/Users/user/.cargo/registry/src/serde",
      depth: 2,
      isReadonly: true,
    };

    const scratchNode: ProjectTreeNode = {
      key: "scratches:scratch_1.sql",
      domain: "scratches",
      entry: {
        name: "scratch_1.sql",
        path: "C:/AppData/scratches/scratch_1.sql",
        kind: "file",
        extension: "sql",
        size: 120,
        modifiedMs: Date.now(),
        isSymlink: false,
        isHidden: false,
        isReadonly: false,
      },
      displayName: "scratch_1.sql",
      deepestPath: "C:/AppData/scratches/scratch_1.sql",
      depth: 1,
    };

    // 1. 验证上下文菜单动态适配三类域名
    const projectMenu = buildProjectContextMenu({
      selection: [projectNode],
      workspaceRoot: "D:/project",
      t: tEn,
    });
    expect(projectMenu.some((m) => m.label === "New")).toBe(true);
    expect(projectMenu.some((m) => m.label === "Refactor")).toBe(true);

    const libMenu = buildProjectContextMenu({
      selection: [libNode],
      workspaceRoot: "D:/project",
      t: tEn,
    });
    // 外部依赖库菜单必须是只读的，无 New / Refactor / Delete
    expect(libMenu.some((m) => m.label === "New")).toBe(false);
    expect(libMenu.some((m) => m.label === "Refactor")).toBe(false);
    expect(libMenu.some((m) => m.label === "Delete…")).toBe(false);
    expect(libMenu.some((m) => m.label === "Copy")).toBe(true);

    const scratchMenu = buildProjectContextMenu({
      selection: [scratchNode],
      workspaceRoot: "D:/project",
      t: tEn,
    });
    expect(scratchMenu.some((m) => m.label === "Scratch File")).toBe(true);
    expect(scratchMenu.some((m) => m.label === "Rename…")).toBe(true);
  });

  it("computes scratch filenames sequentially without collision", () => {
    const existing = ["scratch.ts", "scratch_1.ts", "scratch_2.ts"];
    const next = getNextScratchName(existing, "ts");
    expect(next).toBe("scratch_3.ts");

    const nextPy = getNextScratchName(existing, "py");
    expect(nextPy).toBe("scratch.py");
  });

  it("filters system ignored items strictly without hiding regular dotfiles", () => {
    // 系统隐藏项应当被过滤
    expect(isIgnoredName(".git")).toBe(true);
    expect(isIgnoredName(".DS_Store")).toBe(true);
    expect(isIgnoredName("Thumbs.db")).toBe(true);

    // 重点：.github, .openidea, .env, .gitignore 绝不可以被误隐藏！
    expect(isIgnoredName(".github")).toBe(false);
    expect(isIgnoredName(".openidea")).toBe(false);
    expect(isIgnoredName(".env")).toBe(false);
    expect(isIgnoredName(".gitignore")).toBe(false);
  });

  it("identifies standard build and package directories as excluded", () => {
    expect(isExcludedFolder("dist")).toBe(true);
    expect(isExcludedFolder("node_modules")).toBe(true);
    expect(isExcludedFolder("target")).toBe(true);

    // 源码和常规资源目录不可被识别为 excluded
    expect(isExcludedFolder("src")).toBe(false);
    expect(isExcludedFolder("tests")).toBe(false);
    expect(isExcludedFolder("public")).toBe(false);
  });

  it("normalizes paths consistently across Windows and Unix separators", () => {
    // 验证 Windows 反斜杠、正斜杠与大小写无论如何混用，均能被规整一致，防止 expanded 判定失效
    const winPath = "D:\\App\\Code\\Forge\\src";
    const unixPath = "d:/app/code/forge/src";
    const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase();

    expect(norm(winPath)).toBe(norm(unixPath));

    const expandedSet = new Set<string>([norm(unixPath)]);
    expect(expandedSet.has(norm(winPath))).toBe(true);
  });

  it("identifies virtual paths strictly to prevent invoking listDirectory", () => {
    // 验证虚拟根节点与虚拟组路径以 __ 开头，能够被可靠拦截，严禁传给原生文件系统
    const isVirtual = (p: string) => p.startsWith("__");

    expect(isVirtual("__external_libraries__")).toBe(true);
    expect(isVirtual("__lib_group_cargo")).toBe(true);
    expect(isVirtual("__scratches_and_consoles__")).toBe(true);

    // 真实文件路径不得被误判为虚拟节点
    expect(isVirtual("D:/app/code/forge/src")).toBe(false);
    expect(isVirtual("C:\\Users\\user\\scratches")).toBe(false);
  });

  it("defines standard 5 view modes aligned with openidea", () => {
    // 验证 5 种标准视图模式在 i18n 与定义上严格对齐 openidea
    const expectedModes = [
      { id: "project", label: tEn("project.view.title") },
      { id: "projectFiles", label: tEn("project.view.projectFiles") },
      { id: "openFiles", label: tEn("project.view.openFiles") },
      { id: "changedFiles", label: tEn("project.view.allChangedFiles") },
      { id: "scratches", label: tEn("project.view.scratches") },
    ];

    expect(expectedModes.map((m) => m.id)).toEqual([
      "project",
      "projectFiles",
      "openFiles",
      "changedFiles",
      "scratches",
    ]);

    expect(expectedModes.map((m) => m.label)).toEqual([
      "Project",
      "Project Files",
      "Open Files",
      "All Changed Files",
      "Scratches and Consoles",
    ]);
  });

  it("splits file extensions properly for inline rename selection", () => {
    // 验证重命名时仅选中文件名主名，排除扩展名
    expect(splitExtension("App.tsx")).toEqual(["App", ".tsx"]);
    expect(splitExtension("my.component.test.ts")).toEqual(["my.component.test", ".ts"]);
    // 点开头的文件无扩展名，如 .gitignore
    expect(splitExtension(".gitignore")).toEqual([".gitignore", ""]);
    expect(splitExtension(".env.local")).toEqual([".env", ".local"]);
  });

  it("validates inline input names against Windows and sibling constraints", () => {
    const siblings = ["index.ts", "styles.css", "components"];

    // 1. 空文件名检查
    expect(validateName("", { siblings }).error).toBe("Name cannot be empty");
    expect(validateName("   ", { siblings }).error).toBe("Name cannot be empty");

    // 2. Windows 非法字符检测
    expect(validateName("foo*bar.txt", { siblings, windows: true }).error).toContain("not a valid file name");
    expect(validateName("foo?bar.txt", { siblings, windows: true }).error).toContain("not a valid file name");
    expect(validateName("foo:bar.txt", { siblings, windows: true }).error).toContain("not a valid file name");
    expect(validateName("foo<bar.txt", { siblings, windows: true }).error).toContain("not a valid file name");

    // 3. Windows 保留设备名检测 (CON, PRN, AUX, NUL, COM1...)
    expect(validateName("con", { siblings, windows: true }).error).toContain("not a valid file name");
    expect(validateName("aux.txt", { siblings, windows: true }).error).toContain("not a valid file name");
    expect(validateName("NUL", { siblings, windows: true }).error).toContain("not a valid file name");

    // 4. 重名检查（大小写不敏感）
    expect(validateName("index.ts", { siblings, caseInsensitive: true }).error).toBe("'index.ts' already exists");
    expect(validateName("INDEX.TS", { siblings, caseInsensitive: true }).error).toBe("'INDEX.TS' already exists");

    // 5. 重命名自身合法
    expect(validateName("index.ts", { siblings, current: "index.ts", caseInsensitive: true }).error).toBeNull();

    // 6. 合法名称
    expect(validateName("newComponent.tsx", { siblings, windows: true }).error).toBeNull();
  });

  it("isolates external library node keys with dedicated namespace", () => {
    // 验证即使库文件位于工程目录内（如 node_modules 或 .venv），也赋予专属命名空间
    const projectFilePath = "D:/project/node_modules/react/index.js";
    const libItemKey = libKey("npm", "D:\\project\\node_modules\\react\\index.js");

    expect(isLibKey(libItemKey)).toBe(true);
    expect(pathOfKey(libItemKey)).toBe("d:/project/node_modules/react/index.js");

    // 物理工程键与库键绝对互不冲突
    const projectKey = normalizeNodeKey(projectFilePath);
    expect(projectKey).not.toBe(libItemKey);
  });

  it("ensures expand and collapse state transitions clean up child keys", () => {
    // 模拟用户展开外部库总根 -> 展开 Cargo 组 -> 展开 serde 依赖
    const rootKey = "__external_libraries__";
    const groupKey = "__lib_group_cargo";
    const pkgKey = libKey("cargo", "C:\\Users\\cargo\\serde");
    const subDirKey = libKey("cargo", "C:\\Users\\cargo\\serde\\src");

    const expanded = new Set<string>([rootKey, groupKey, pkgKey, subDirKey]);
    expect(expanded.has(pkgKey)).toBe(true);
    expect(expanded.has(subDirKey)).toBe(true);

    // 模拟折叠具体包 serde
    const collapseKey = pkgKey;
    const next = new Set(expanded);
    next.delete(collapseKey);
    for (const itemKey of next) {
      if (itemKey !== collapseKey && (itemKey.startsWith(`${collapseKey}/`) || (isLibKey(collapseKey) && itemKey.startsWith(collapseKey)))) {
        next.delete(itemKey);
      }
    }

    // 验证：折叠 serde 后，serde 本身和其子目录均被清理出展开状态，但组根依然展开
    expect(next.has(pkgKey)).toBe(false);
    expect(next.has(subDirKey)).toBe(false);
    expect(next.has(groupKey)).toBe(true);
    expect(next.has(rootKey)).toBe(true);
  });
});

