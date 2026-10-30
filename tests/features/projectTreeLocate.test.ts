// @vitest-environment jsdom
/**
 * 资源管理器选中回归（原 bug：selectedSet 未做 normalizeNodeKey 规范化，
 * Windows 原始大小写/反斜杠路径与 Tree 行 key 永远对不上，整棵树点不出选中态）：
 * 1. 头部「选择已打开的文件」按钮（project.view.locate）在树全折叠时点击后应展开祖先并选中目标行；
 * 2. 单击文件行应经 onPick 回流后呈现选中态。
 * 路径形态按真实后端返回（反斜杠 + 大写盘符）构造。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FsEntry } from "../../src/lib/fs";

const h = vi.hoisted(() => ({
  listing: new Map<string, FsEntry[]>(),
  loadCalls: [] as string[],
}));

vi.mock("../../src/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

vi.mock("../../src/lib/fs", async (original) => {
  const mod = await original<typeof import("../../src/lib/fs")>();
  return {
    ...mod,
    listDirectory: (path: string) => {
      h.loadCalls.push(path);
      const key = path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
      return Promise.resolve({ entries: h.listing.get(key) ?? [] });
    },
  };
});

vi.mock("../../src/lib/ignoredCache", () => ({
  loadIgnored: () => Promise.resolve([]),
  subscribeIgnored: () => () => {},
}));

vi.mock("../../src/features/project-tree/libraries", () => ({
  detectExternalLibraries: () => Promise.resolve([]),
}));

vi.mock("../../src/features/project-tree/scratches", () => ({
  SCRATCH_LANGUAGES: [],
  getScratchesDir: () => Promise.resolve(null),
  createScratchFile: () => Promise.reject(new Error("unused")),
}));

vi.mock("../../src/components/EntryIcon", () => ({
  default: () => null,
}));

import { ProjectTree, type ProjectTreeProps } from "../../src/features/project-tree/ProjectTree";

const ROOT = "D:\\proj";

/** 与 App.tsx 同构：onPick 的结果回流到 picked（受控选中） */
function Harness(props: Omit<ProjectTreeProps, "picked">) {
  const [picked, setPicked] = useState<string[]>([]);
  return createElement(ProjectTree, {
    ...props,
    picked,
    onPick: (entries: FsEntry[]) => {
      setPicked(entries.map((e) => e.path));
      props.onPick?.(entries);
    },
  });
}

function entry(name: string, path: string, kind: "file" | "directory"): FsEntry {
  return {
    name,
    path,
    kind,
    extension: kind === "file" ? name.split(".").pop() ?? null : null,
    size: 0,
    modifiedMs: 0,
    isSymlink: false,
    isHidden: false,
    isReadonly: false,
  };
}

function seedTree() {
  // 真实后端返回反斜杠 + 大写盘符的路径
  h.listing.set("d:/proj", [
    entry("src", "D:\\proj\\src", "directory"),
    entry("README.md", "D:\\proj\\README.md", "file"),
  ]);
  h.listing.set("d:/proj/src", [
    entry("components", "D:\\proj\\src\\components", "directory"),
    entry("App.tsx", "D:\\proj\\src\\App.tsx", "file"),
    entry("main.tsx", "D:\\proj\\src\\main.tsx", "file"),
  ]);
  h.listing.set("d:/proj/src/components", [
    entry("Header.tsx", "D:\\proj\\src\\components\\Header.tsx", "file"),
  ]);
}

let container: HTMLElement;
let root: Root;
const pickCalls: FsEntry[][] = [];

async function mountTree(props: Partial<Omit<ProjectTreeProps, "picked">> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(Harness, {
        root: ROOT,
        repoRoot: null,
        changes: [],
        collapseSignal: 0,
        refresh: { paths: null, seq: 0 },
        reveal: null,
        showIgnored: false,
        showHidden: false,
        openRoots: [ROOT],
        // activeFile 留空：模拟「当前不在编辑器文档页」，定位按钮走 openFiles 兜底，
        // 同时避免 autoscrollFromSource 在挂载时抢先展开，保持树全折叠的真实起点。
        activeFile: null,
        openFiles: ["D:\\proj\\src\\App.tsx"],
        onPick: (entries: FsEntry[]) => pickCalls.push(entries),
        onOpenFile: vi.fn(),
        onContextMenu: vi.fn(),
        ...props,
      })
    );
  });
  // 等初始 load(root) 的 listDirectory 微任务落盘
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function findRow(text: string): HTMLElement | null {
  for (const row of container.querySelectorAll('[role="treeitem"]')) {
    if ((row.textContent ?? "").includes(text)) return row as HTMLElement;
  }
  return null;
}

function locateButton(): HTMLElement {
  const btn = container.querySelector('button[title="project.view.locate"]');
  if (!btn) throw new Error("locate button not found");
  return btn as HTMLElement;
}

beforeEach(() => {
  h.listing.clear();
  h.loadCalls.length = 0;
  pickCalls.length = 0;
  // jsdom 没有 ResizeObserver，TanStack Virtual 需要它测量视口
  vi.stubGlobal("ResizeObserver", class {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe() {
      this.cb([], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  });
  // jsdom 的 clientWidth/Height 恒为 0，虚拟列表量不到视口就不渲染任何行
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 600; } });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return 300; } });
  Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo;
  seedTree();
});

describe("ProjectTree 选中回归", () => {
  it("树全折叠时点击「选择已打开的文件」：展开祖先并选中目标文件行", { timeout: 15000 }, async () => {
    await mountTree();

    // 起点全折叠：App.tsx 不可见
    expect(findRow("App.tsx")).toBeNull();

    await act(async () => {
      locateButton().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    // 等祖先目录 listDirectory 落盘并触发 treeModel 重建
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const row = findRow("App.tsx");
    expect(row).not.toBeNull();
    expect(row!.getAttribute("aria-selected")).toBe("true");
    expect(pickCalls.some((entries) => entries.some((e) => e.name === "App.tsx"))).toBe(true);
  });

  it("单击文件行：选中高亮随 onPick 回流生效", { timeout: 15000 }, async () => {
    await mountTree();

    const row = findRow("README.md");
    expect(row).not.toBeNull();
    expect(row!.getAttribute("aria-selected")).toBe("false");

    await act(async () => {
      row!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    await act(async () => {});

    expect(row!.getAttribute("aria-selected")).toBe("true");
    expect(pickCalls.some((entries) => entries.some((e) => e.name === "README.md"))).toBe(true);
  });

  it("小写盘符 + 反斜杠的文档路径（真实后端污染形态）也能定位选中", { timeout: 15000 }, async () => {
    // 复刻真实报障形态：root 原始大写，文档路径被后端按小写目录拼出（d:/proj\src\main.tsx）
    const smallTarget = "d:\\proj\\src\\main.tsx";
    h.listing.set("d:/proj", [
      entry("src", "d:\\proj\\src", "directory"),
      entry("package.json", "d:\\proj\\package.json", "file"),
    ]);
    await mountTree({ activeFile: null, openFiles: [smallTarget] });

    // 起点全折叠：目标不可见
    expect(findRow("main.tsx")).toBeNull();

    await act(async () => {
      locateButton().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const row = findRow("main.tsx");
    expect(row).not.toBeNull();
    expect(row!.getAttribute("aria-selected")).toBe("true");
  });

  it("reveal 展开祖先时按原文大小写调 listDirectory，不再小写化污染子条目", { timeout: 15000 }, async () => {
    await mountTree({ activeFile: null, openFiles: [`${ROOT}\\src\\App.tsx`] });
    // 只观察点击后的加载：挂载期根目录存在一次既有的重复加载，与本回归无关
    h.loadCalls.length = 0;

    await act(async () => {
      locateButton().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // 祖先 src 应以原文形态（大写盘符、正斜杠）加载，而非小写化路径
    expect(h.loadCalls).toContain("D:/proj/src");
    expect(h.loadCalls).not.toContain("d:/proj/src");
  });
});
