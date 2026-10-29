import { describe, expect, it } from "vitest";
import type { FsEntry, TextPage } from "../../src/lib/fs";
import { parentPath, pathWithin, samePath } from "../../src/lib/format";
import { recentFileItem, SeController } from "../../src/lib/seController";
import { matchActions } from "../../src/lib/seModel";

/**
 * 模拟 App.tsx 中的当前活跃工程或目录判定算法
 */
function resolveActiveDirectory({
  explicitScope,
  explorerPick = [],
  activeDocPath = null,
  openFolders = [],
  workspaceRoot = null,
}: {
  explicitScope?: string | null;
  explorerPick?: FsEntry[];
  activeDocPath?: string | null;
  openFolders?: string[];
  workspaceRoot?: string | null;
}): string | null {
  if (explicitScope) return explicitScope;

  if (activeDocPath) {
    const matchedRoot = openFolders.find(
      (folder) => pathWithin(folder, activeDocPath) || samePath(folder, activeDocPath)
    );
    if (matchedRoot) return matchedRoot;
  }

  if (explorerPick.length > 0) {
    const picked = explorerPick[0];
    const matchedRoot = openFolders.find(
      (folder) => pathWithin(folder, picked.path) || samePath(folder, picked.path)
    );
    if (matchedRoot) return matchedRoot;
    if (picked.kind === "directory") return picked.path;
    const parent = parentPath(picked.path);
    if (parent) return parent;
    return picked.path;
  }

  if (activeDocPath) {
    const parent = parentPath(activeDocPath);
    if (parent) return parent;
  }

  return workspaceRoot ?? (openFolders.length > 0 ? openFolders[0] : null);
}

describe("SearchEverywhere 多项目与多目录作用域解析", () => {
  const rootA = "D:/projects/project-alpha";
  const rootB = "D:/projects/project-beta";
  const allFolders = [rootA, rootB];

  const createEntry = (path: string, name: string, kind: "file" | "directory"): FsEntry => ({
    path,
    name,
    kind,
    extension: kind === "file" ? "ts" : null,
    size: 1024,
    modifiedMs: Date.now(),
    isSymlink: false,
    isHidden: false,
    isReadonly: false,
  });

  it("当右键菜单传入显式 scope 时，直接以该 scope 目录为准", () => {
    const explicit = "D:/projects/project-beta/src/components";
    const res = resolveActiveDirectory({
      explicitScope: explicit,
      openFolders: allFolders,
      workspaceRoot: rootA,
    });
    expect(res).toBe(explicit);
  });

  it("当用户正在编辑第二个工程的文件时，即便资源管理器有第一个工程的历史选区，随处搜索也必须精准命中第二个工程根", () => {
    const oldPickFromA = createEntry("D:/projects/project-alpha/src/old.ts", "old.ts", "file");
    const activeInB = "D:/projects/project-beta/src/components/Header.tsx";
    const res = resolveActiveDirectory({
      explorerPick: [oldPickFromA],
      activeDocPath: activeInB,
      openFolders: allFolders,
      workspaceRoot: rootA,
    });
    expect(res).toBe(rootB);
  });

  it("当无活动编辑文档，但资源管理器选中第二个工程的文件或子目录时，随处搜索必须锁定到第二个工程根", () => {
    const selectedFile = createEntry("D:/projects/project-beta/src/index.ts", "index.ts", "file");
    const res = resolveActiveDirectory({
      explorerPick: [selectedFile],
      openFolders: allFolders,
      workspaceRoot: rootA,
    });
    expect(res).toBe(rootB);
  });

  it("当既无选区也无打开文件时，正常回退到当前激活工作区根", () => {
    const res = resolveActiveDirectory({
      openFolders: allFolders,
      workspaceRoot: rootA,
    });
    expect(res).toBe(rootA);
  });
});

describe("SeController 与 SeStore 跨工程隔离测试", () => {
  const projectA = "D:/projects/project-alpha";
  const dummyTextPage: TextPage = { query: "", hits: [], files: 0, truncated: false, skipped: 0 };

  it("recentFileItem 正确提取所属工程下的相对目录", () => {
    const item = recentFileItem("D:/projects/project-alpha/src/App.tsx", projectA);
    expect(item.name).toBe("App.tsx");
    expect(item.dir).toBe("src");
    expect(item.path).toBe("D:/projects/project-alpha/src/App.tsx");
  });

  it("在工程 A 下搜索时，SeController 的 recent 推荐列表必须完全过滤掉工程 B 的文件", async () => {
    let capturedItems: any[] = [];
    const controller = new SeController(
      {
        findFiles: async () => [],
        findSymbols: async () => [],
        searchText: async () => dummyTextPage,
        actions: () => [],
        recentFiles: () => [
          "D:/projects/project-alpha/src/App.tsx",
          "D:/projects/project-beta/src/Main.tsx", // 属于工程 B 的文件
          "D:/projects/project-alpha/package.json",
        ],
        recentActions: () => [],
        root: () => projectA, // 当前处于工程 A
        now: () => 1000,
      },
      (snapshot) => {
        const recent = snapshot.sections.get("recent");
        if (recent) capturedItems = recent.items;
      }
    );

    controller.run({
      query: "",
      tab: "all",
      includeIgnored: false,
      filter: { showHidden: false, ignored: [] },
      text: { caseSensitive: false, wholeWords: false, regex: false },
      extra: {},
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(capturedItems.length).toBe(2);
    expect(capturedItems.map((i) => i.path)).toEqual([
      "D:/projects/project-alpha/src/App.tsx",
      "D:/projects/project-alpha/package.json",
    ]);
    expect(capturedItems.some((i) => i.path.includes("project-beta"))).toBe(false);
  });

  it("在工程 A 下搜索文件时，即便外部搜索源异常返回了工程 B 的结果，SeController 也会强制封闭隔离", async () => {
    let fileHits: any[] = [];
    const controller = new SeController(
      {
        findFiles: async () => [
          { path: "D:/projects/project-alpha/src/utils.ts", container: "src", name: "utils.ts", score: 4, isDir: false },
          { path: "D:/projects/project-beta/src/utils.ts", container: "src", name: "utils.ts", score: 4, isDir: false },
        ],
        findSymbols: async () => [],
        searchText: async () => dummyTextPage,
        actions: () => [],
        recentFiles: () => [],
        recentActions: () => [],
        root: () => projectA,
        now: () => 1000,
      },
      (snapshot) => {
        const files = snapshot.sections.get("files");
        if (files) fileHits = files.items;
      }
    );

    controller.run({
      query: "utils",
      tab: "files",
      includeIgnored: false,
      filter: { showHidden: false, ignored: [] },
      text: { caseSensitive: false, wholeWords: false, regex: false },
      extra: {},
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(fileHits.length).toBe(1);
    expect(fileHits[0].path).toBe("D:/projects/project-alpha/src/utils.ts");
  });

  it("随处搜索动作检索必须能命中主菜单命令（新建、保存、终端、Git等）", () => {
    const testMenuCommands = [
      { id: "file.newFile", label: "新建文件 (New File)", run: () => {} },
      { id: "file.saveAll", label: "保存全部 (Save All)", run: () => {} },
      { id: "edit.rename", label: "重命名... (Rename)", run: () => {} },
      { id: "pane.open.terminal", label: "视图: 工具窗口 - 终端", run: () => {} },
      { id: "git.commit", label: "Git: 提交... (Commit...)", run: () => {} },
    ];

    // 中文检索
    const hitsNew = matchActions(testMenuCommands, "新建", []);
    expect(hitsNew.length).toBe(1);
    expect(hitsNew[0].id).toBe("file.newFile");

    // 英文检索
    const hitsSave = matchActions(testMenuCommands, "save", []);
    expect(hitsSave.length).toBe(1);
    expect(hitsSave[0].id).toBe("file.saveAll");

    // 菜单功能检索
    const hitsTerm = matchActions(testMenuCommands, "终端", []);
    expect(hitsTerm.length).toBe(1);
    expect(hitsTerm[0].id).toBe("pane.open.terminal");
  });
});

