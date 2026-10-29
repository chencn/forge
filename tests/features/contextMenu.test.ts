import { describe, expect, it } from "vitest";
import { buildProjectContextMenu } from "../../src/features/project-tree/contextMenu";
import type { ProjectTreeNode } from "../../src/features/project-tree/model";
import { en } from "../../src/i18n/lang/en";
import { zh } from "../../src/i18n/lang/zh";

const tEn = (k: string) => (en as any)[k] ?? k;
const tZh = (k: string) => (zh as any)[k] ?? k;

describe("Project Tree Context Menu", () => {
  const dummyFileNode: ProjectTreeNode = {
    key: "d:/app/code/forge/src/main.tsx",
    domain: "project",
    entry: {
      name: "main.tsx",
      path: "D:/app/code/forge/src/main.tsx",
      kind: "file",
      extension: "tsx",
      size: 1024,
      modifiedMs: Date.now(),
      isSymlink: false,
      isHidden: false,
      isReadonly: false,
    },
    displayName: "main.tsx",
    deepestPath: "D:/app/code/forge/src/main.tsx",
    depth: 1,
  };

  it("builds complete IDEA right-click menu for project file with English i18n", () => {
    const items = buildProjectContextMenu({
      selection: [dummyFileNode],
      workspaceRoot: "D:/app/code/forge",
      git: {
        root: "D:/app/code/forge",
        changes: [],
      },
      t: tEn,
    });

    const labels = items.map((i) => i.label).filter(Boolean);
    expect(labels).toContain("New");
    expect(labels).toContain("Cut");
    expect(labels).toContain("Copy");
    expect(labels).toContain("Copy Path/Reference…");
    expect(labels).toContain("Find in Files…");
    expect(labels).toContain("Refactor");
    expect(labels).toContain("Delete…");
    expect(labels).toContain("Open In");
    expect(labels).toContain("Local History");
    expect(labels).toContain("Git");
  });

  it("builds complete IDEA right-click menu for project file with Chinese i18n", () => {
    const items = buildProjectContextMenu({
      selection: [dummyFileNode],
      workspaceRoot: "D:/app/code/forge",
      git: {
        root: "D:/app/code/forge",
        changes: [],
      },
      t: tZh,
    });

    const labels = items.map((i) => i.label).filter(Boolean);
    expect(labels).toContain("新建");
    expect(labels).toContain("剪切");
    expect(labels).toContain("复制");
    expect(labels).toContain("复制路径/引用…");
    expect(labels).toContain("在文件中查找…");
    expect(labels).toContain("重构");
    expect(labels).toContain("删除…");
    expect(labels).toContain("打开方式");
    expect(labels).toContain("本地历史");
    expect(labels).toContain("Git");
  });

  it("builds read-only menu for External Libraries node", () => {
    const libNode: ProjectTreeNode = {
      key: "libraries:react",
      domain: "libraries",
      entry: {
        name: "react",
        path: "D:/app/code/forge/node_modules/react",
        kind: "directory",
        extension: null,
        size: 0,
        modifiedMs: Date.now(),
        isSymlink: false,
        isHidden: false,
        isReadonly: true,
      },
      displayName: "react",
      deepestPath: "D:/app/code/forge/node_modules/react",
      depth: 1,
    };

    const items = buildProjectContextMenu({
      selection: [libNode],
      workspaceRoot: "D:/app/code/forge",
      t: tEn,
    });

    const labels = items.map((i) => i.label).filter(Boolean);
    expect(labels).toContain("Copy");
    expect(labels).toContain("Find in Files…");
    expect(labels).not.toContain("Refactor");
    expect(labels).not.toContain("Delete…");
    expect(labels).not.toContain("New");
  });

  it("builds scratch menu for Scratches node", () => {
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

    const items = buildProjectContextMenu({
      selection: [scratchNode],
      workspaceRoot: "D:/app/code/forge",
      t: tEn,
    });

    const labels = items.map((i) => i.label).filter(Boolean);
    expect(labels).toContain("Scratch File");
    expect(labels).toContain("Rename…");
    expect(labels).toContain("Delete…");
    expect(labels).toContain("Cut");
    expect(labels).toContain("Copy");
  });
});
