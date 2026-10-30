/**
 * 项目侧边栏 1:1 复刻上下文右键菜单系统
 *
 * 对标 IntelliJ IDEA ProjectViewPopupMenu / IntelliJ IDEA 规范：
 * 1. New › (File, Directory/Package, Scratch File, 常用语言模板)
 * 2. Cut / Copy / Copy Path/Reference… › / Paste
 * 3. Find in Files… / Replace in Files…
 * 4. Refactor › (Rename…, Move…, Safe Delete…)
 * 5. Delete… (带危险色提示)
 * 6. Open In › (Terminal, System Explorer)
 * 7. Local History › (Show History) / Reload from Disk
 * 8. Git › (Commit…, Add, Show Diff, Show History, Rollback…, Push…, Pull…, Branches…)
 * 9. Compare With… / Compare Files
 * 10. Mark Directory as › (Sources, Test Sources, Resources, Excluded, Unmark)
 * 11. AI 助手操作 (放入上下文等)
 * 12. 外部依赖库专用只读菜单 (External Libraries)
 * 13. Scratches 临时文件专属菜单
 *
 * 国际化规范：所有展示标签必须 100% 经由 t() 解析。
 */

import type { MenuItem } from "../../components/ContextMenu";
import { flatMenu } from "../../components/ContextMenu";
import type { FsEntry } from "../../lib/fs";
import type { GitChange } from "../../lib/git";
import { SCRATCH_LANGUAGES, type ScratchLanguage } from "./scratches";
import type { ProjectTreeNode } from "./model";

export interface GitMenuHandlers {
  readonly root: string | null;
  readonly changes: readonly GitChange[];
  readonly stage?: (paths: string[]) => void | Promise<void>;
  readonly history?: (relative: string) => void;
  readonly commit?: () => void;
  readonly diff?: (paths: string[]) => void;
  readonly rollback?: (paths: string[]) => void;
  readonly push?: () => void;
  readonly pull?: () => void;
  readonly branches?: () => void;
}

export interface ProjectMenuContext {
  /** 选中的树节点 */
  readonly selection: readonly ProjectTreeNode[];
  /** 工作区项目物理根目录 */
  readonly workspaceRoot: string;
  /** Git 管理句柄 */
  readonly git?: GitMenuHandlers;
  /** 剪贴板中是否有待粘贴的文件条目 */
  readonly hasClipboard?: boolean;
  /** 快捷键前缀修饰符（Mac 为 ⌘，Windows/Linux 为 Ctrl） */
  readonly modKey?: string;
  /** 翻译文案函数 */
  readonly t?: (...args: any[]) => string;

  // 动作回调
  readonly onNewFile?: (targetDir: string, templateExt?: string) => void;
  readonly onNewFolder?: (targetDir: string) => void;
  readonly onNewScratch?: (lang: ScratchLanguage) => void;
  readonly onCut?: (entries: FsEntry[]) => void;
  readonly onCopy?: (entries: FsEntry[]) => void;
  readonly onCopyPath?: (type: "absolute" | "name" | "relative", entries: FsEntry[]) => void;
  readonly onPaste?: (targetDir: string) => void;
  readonly onOpenFile?: (entry: FsEntry) => void;
  readonly onRename?: (entry: FsEntry) => void;
  readonly onMove?: (entries: FsEntry[]) => void;
  readonly onDelete?: (entries: FsEntry[]) => void;
  readonly onReveal?: (path: string) => void;
  readonly onOpenTerminal?: (dir: string) => void;
  readonly onOpenExternal?: (path: string) => void;
  readonly onFindInFiles?: (dir: string) => void;
  readonly onReplaceInFiles?: (dir: string) => void;
  readonly onLocalHistory?: (path: string) => void;
  readonly onReload?: () => void;
  readonly onCompareWith?: (entry: FsEntry) => void;
  readonly onCompareFiles?: (entries: FsEntry[]) => void;
  readonly onMarkDirectory?: (dir: string, role: string | null) => void;
  readonly onAiInput?: (entry: FsEntry) => void;
}

/** 规范取目录：如果是目录取自身，如果是文件取其所在父目录，空白处取工程根 */
function resolveTargetDirectory(nodes: readonly ProjectTreeNode[], fallbackRoot: string): string {
  if (nodes.length === 0) return fallbackRoot;
  const lead = nodes[0];
  if (lead.entry.kind === "directory") return lead.entry.path;
  const p = lead.entry.path.replaceAll("\\", "/");
  const idx = p.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : fallbackRoot;
}

/**
 * 构建 1:1 项目树右键菜单
 */
export function buildProjectContextMenu(ctx: ProjectMenuContext): MenuItem[] {
  const {
    selection,
    workspaceRoot,
    git,
    hasClipboard = false,
    modKey = "Ctrl",
    t = (k: string) => k,
  } = ctx;

  const entries = selection.map((n) => n.entry);
  const files = entries.filter((e) => e.kind !== "directory");
  const singleNode = selection.length === 1 ? selection[0] : null;
  const singleEntry = singleNode ? singleNode.entry : null;
  const singleFile = singleEntry && singleEntry.kind !== "directory" ? singleEntry : null;
  const singleDir = singleEntry && singleEntry.kind === "directory" ? singleEntry : null;
  const hasSelection = selection.length > 0;
  const targetDir = resolveTargetDirectory(selection, workspaceRoot);

  // 1. 若选中了 External Libraries 下的节点，展示只读库专属菜单
  const isLibrariesDomain = selection.some((n) => n.domain === "libraries");
  if (isLibrariesDomain) {
    return buildExternalLibraryContextMenu(ctx);
  }

  // 2. 若选中了 Scratches 树下的节点，展示临时文件菜单
  const isScratchesDomain = selection.some((n) => n.domain === "scratches");
  if (isScratchesDomain) {
    return buildScratchesContextMenu(ctx);
  }

  // 3. 主工程源码树完整 1:1 右键菜单
  const groups: MenuItem[][] = [];

  // Group 1: New ›
  const newSubmenu: MenuItem[] = [
    {
      label: t("project.view.newFile"),
      shortcut: `${modKey}+Alt+N`,
      onSelect: () => ctx.onNewFile?.(targetDir),
    },
    {
      label: t("project.view.newDirectory"),
      onSelect: () => ctx.onNewFolder?.(targetDir),
    },
    {
      label: t("project.view.newScratch"),
      shortcut: `${modKey}+Shift+Alt+N`,
      onSelect: () => ctx.onNewScratch?.(SCRATCH_LANGUAGES[0]),
    },
    { separator: true },
    {
      label: "JavaScript File",
      onSelect: () => ctx.onNewFile?.(targetDir, "js"),
    },
    {
      label: "TypeScript File",
      onSelect: () => ctx.onNewFile?.(targetDir, "ts"),
    },
    {
      label: "Rust File",
      onSelect: () => ctx.onNewFile?.(targetDir, "rs"),
    },
    {
      label: "Python File",
      onSelect: () => ctx.onNewFile?.(targetDir, "py"),
    },
    {
      label: "Markdown Document",
      onSelect: () => ctx.onNewFile?.(targetDir, "md"),
    },
    {
      label: "JSON File",
      onSelect: () => ctx.onNewFile?.(targetDir, "json"),
    },
    {
      label: "HTML File",
      onSelect: () => ctx.onNewFile?.(targetDir, "html"),
    },
    {
      label: "CSS Stylesheet",
      onSelect: () => ctx.onNewFile?.(targetDir, "css"),
    },
  ];
  groups.push([{ label: t("project.view.new"), children: newSubmenu }]);

  // Group 2: Cut / Copy / Copy Path / Paste
  const copyPathSubmenu: MenuItem[] = [
    {
      label: t("project.view.copyAbsolutePath"),
      shortcut: `${modKey}+Shift+C`,
      disabled: !hasSelection,
      onSelect: () => ctx.onCopyPath?.("absolute", entries),
    },
    {
      label: t("project.view.copyFileName"),
      disabled: !hasSelection,
      onSelect: () => ctx.onCopyPath?.("name", entries),
    },
    {
      label: t("project.view.copyRelativePath"),
      disabled: !hasSelection,
      onSelect: () => ctx.onCopyPath?.("relative", entries),
    },
  ];

  groups.push([
    {
      label: t("project.view.cut"),
      shortcut: `${modKey}+X`,
      disabled: !hasSelection,
      onSelect: () => ctx.onCut?.(entries),
    },
    {
      label: t("project.view.copy"),
      shortcut: `${modKey}+C`,
      disabled: !hasSelection,
      onSelect: () => ctx.onCopy?.(entries),
    },
    {
      label: t("project.view.copyPathRef"),
      children: copyPathSubmenu,
    },
    {
      label: t("project.view.paste"),
      shortcut: `${modKey}+V`,
      disabled: !hasClipboard,
      onSelect: () => ctx.onPaste?.(targetDir),
    },
  ]);

  // Group 3: Find in Files… / Replace in Files…
  groups.push([
    {
      label: t("project.view.findInFiles"),
      shortcut: `${modKey}+Shift+F`,
      onSelect: () => ctx.onFindInFiles?.(targetDir),
    },
    {
      label: t("project.view.replaceInFiles"),
      shortcut: `${modKey}+Shift+R`,
      onSelect: () => ctx.onReplaceInFiles?.(targetDir),
    },
  ]);

  // Group 4: Refactor › (Rename, Move, Safe Delete)
  const refactorSubmenu: MenuItem[] = [
    {
      label: t("project.view.rename"),
      shortcut: "Shift+F6",
      disabled: !singleEntry,
      onSelect: () => singleEntry && ctx.onRename?.(singleEntry),
    },
    {
      label: t("project.view.move"),
      shortcut: "F6",
      disabled: !hasSelection,
      onSelect: () => ctx.onMove?.(entries),
    },
    {
      label: t("project.view.safeDelete"),
      shortcut: "Delete",
      disabled: !hasSelection,
      onSelect: () => ctx.onDelete?.(entries),
    },
  ];
  groups.push([{ label: t("project.view.refactor"), children: refactorSubmenu }]);

  // Group 5: Delete… (危险删除项)
  groups.push([
    {
      label: t("project.view.delete"),
      shortcut: "Delete",
      danger: true,
      disabled: !hasSelection,
      onSelect: () => ctx.onDelete?.(entries),
    },
  ]);

  // Group 6: Open In › (Terminal, Explorer)
  const openInSubmenu: MenuItem[] = [
    {
      label: t("project.view.systemExplorer"),
      onSelect: () => singleEntry && ctx.onReveal?.(singleEntry.path),
    },
    {
      label: t("project.view.terminal"),
      shortcut: "Alt+F12",
      onSelect: () => ctx.onOpenTerminal?.(targetDir),
    },
  ];
  groups.push([{ label: t("project.view.openIn"), children: openInSubmenu }]);

  // Group 7: Local History / Reload from Disk
  const historyGroup: MenuItem[] = [];
  if (singleEntry) {
    historyGroup.push({
      label: t("project.view.localHistory"),
      children: [
        {
          label: t("project.view.showHistory"),
          onSelect: () => ctx.onLocalHistory?.(singleEntry.path),
        },
      ],
    });
  }
  historyGroup.push({
    label: t("project.view.reloadFromDisk"),
    shortcut: `${modKey}+Alt+Y`,
    onSelect: () => ctx.onReload?.(),
  });
  groups.push(historyGroup);

  // Group 8: Git › (当位于 Git 仓库中时)
  if (git?.root) {
    const gitSubmenu: MenuItem[] = [
      {
        label: t("git.commit"),
        shortcut: `${modKey}+K`,
        onSelect: () => git.commit?.(),
      },
      {
        label: t("git.stage"),
        disabled: files.length === 0,
        onSelect: () => void git.stage?.(files.map((f) => f.path)),
      },
      { separator: true },
      {
        label: t("git.diff"),
        disabled: files.length === 0,
        onSelect: () => git.diff?.(files.map((f) => f.path)),
      },
      ...(singleFile
        ? [
            {
              label: t("project.view.showHistory"),
              onSelect: () => {
                const prefix = git.root?.replaceAll("\\", "/").replace(/\/+$/, "") ?? "";
                const abs = singleFile.path.replaceAll("\\", "/");
                const rel = abs.startsWith(prefix) ? abs.slice(prefix.length + 1) : abs;
                git.history?.(rel);
              },
            },
          ]
        : []),
      {
        label: t("dialog.rollback"),
        disabled: files.length === 0,
        onSelect: () => git.rollback?.(files.map((f) => f.path)),
      },
      { separator: true },
      {
        label: t("git.push"),
        shortcut: `${modKey}+Shift+K`,
        onSelect: () => git.push?.(),
      },
      {
        label: t("git.pull"),
        onSelect: () => git.pull?.(),
      },
      {
        label: t("git.branches"),
        onSelect: () => git.branches?.(),
      },
    ];
    groups.push([{ label: "Git", children: gitSubmenu }]);
  }

  // Group 9: Compare With… / Compare Files
  if (files.length === 2) {
    groups.push([
      {
        label: t("project.view.compareFiles"),
        shortcut: `${modKey}+D`,
        onSelect: () => ctx.onCompareFiles?.(files),
      },
    ]);
  } else if (singleFile) {
    groups.push([
      {
        label: t("project.view.compareWith"),
        onSelect: () => ctx.onCompareWith?.(singleFile),
      },
    ]);
  }

  // Group 10: Mark Directory as ›
  if (singleDir && !singleNode?.isRoot) {
    const markSubmenu: MenuItem[] = [
      {
        label: t("project.view.markSource"),
        onSelect: () => ctx.onMarkDirectory?.(singleDir.path, "source"),
      },
      {
        label: t("project.view.markTest"),
        onSelect: () => ctx.onMarkDirectory?.(singleDir.path, "test"),
      },
      {
        label: t("project.view.markResources"),
        onSelect: () => ctx.onMarkDirectory?.(singleDir.path, "resources"),
      },
      {
        label: t("project.view.markExcluded"),
        onSelect: () => ctx.onMarkDirectory?.(singleDir.path, "excluded"),
      },
      { separator: true },
      {
        label: t("project.view.unmark"),
        onSelect: () => ctx.onMarkDirectory?.(singleDir.path, null),
      },
    ];
    groups.push([{ label: t("project.view.markDirectory"), children: markSubmenu }]);
  }

  // Group 11: AI 助手操作 (Forge 原生集成)
  if (singleFile) {
    groups.push([
      {
        label: "Send to AI Chat",
        shortcut: `${modKey}+L`,
        onSelect: () => ctx.onAiInput?.(singleFile),
      },
    ]);
  }

  return flatMenu(groups);
}

/**
 * 外部依赖库专用只读菜单 (External Libraries)
 */
function buildExternalLibraryContextMenu(ctx: ProjectMenuContext): MenuItem[] {
  const { selection, modKey = "Ctrl", t = (k: string) => k } = ctx;
  const entries = selection.map((n) => n.entry);
  const single = entries.length === 1 ? entries[0] : null;
  const targetDir = resolveTargetDirectory(selection, ctx.workspaceRoot);

  const groups: MenuItem[][] = [];

  groups.push([
    {
      label: t("project.view.copy"),
      shortcut: `${modKey}+C`,
      disabled: !single,
      onSelect: () => ctx.onCopy?.(entries),
    },
    {
      label: t("project.view.copyPathRef"),
      children: [
        {
          label: t("project.view.copyAbsolutePath"),
          shortcut: `${modKey}+Shift+C`,
          onSelect: () => ctx.onCopyPath?.("absolute", entries),
        },
        {
          label: t("project.view.copyFileName"),
          onSelect: () => ctx.onCopyPath?.("name", entries),
        },
      ],
    },
  ]);

  groups.push([
    {
      label: t("project.view.findInFiles"),
      shortcut: `${modKey}+Shift+F`,
      onSelect: () => ctx.onFindInFiles?.(targetDir),
    },
  ]);

  if (single) {
    groups.push([
      {
        label: t("project.view.openIn"),
        children: [
          {
            label: t("project.view.systemExplorer"),
            onSelect: () => ctx.onReveal?.(single.path),
          },
        ],
      },
      {
        label: t("project.view.compareWith"),
        onSelect: () => ctx.onCompareWith?.(single),
      },
    ]);
  }

  return flatMenu(groups);
}

/**
 * Scratches 临时文件专属菜单
 */
function buildScratchesContextMenu(ctx: ProjectMenuContext): MenuItem[] {
  const { selection, modKey = "Ctrl", t = (k: string) => k } = ctx;
  const entries = selection.map((n) => n.entry);
  const single = entries.length === 1 ? entries[0] : null;
  const targetDir = resolveTargetDirectory(selection, ctx.workspaceRoot);

  const groups: MenuItem[][] = [];

  // New Scratch
  groups.push([
    {
      label: t("project.view.newScratch"),
      shortcut: `${modKey}+Shift+Alt+N`,
      onSelect: () => ctx.onNewScratch?.(SCRATCH_LANGUAGES[0]),
    },
    {
      label: t("project.view.newDirectory"),
      onSelect: () => ctx.onNewFolder?.(targetDir),
    },
  ]);

  // Cut / Copy / Paste
  groups.push([
    {
      label: t("project.view.cut"),
      shortcut: `${modKey}+X`,
      disabled: !single,
      onSelect: () => ctx.onCut?.(entries),
    },
    {
      label: t("project.view.copy"),
      shortcut: `${modKey}+C`,
      disabled: !single,
      onSelect: () => ctx.onCopy?.(entries),
    },
    {
      label: t("project.view.copyPath"),
      shortcut: `${modKey}+Shift+C`,
      disabled: !single,
      onSelect: () => ctx.onCopyPath?.("absolute", entries),
    },
    {
      label: t("project.view.paste"),
      shortcut: `${modKey}+V`,
      disabled: !ctx.hasClipboard,
      onSelect: () => ctx.onPaste?.(targetDir),
    },
  ]);

  // Refactor & Delete
  if (single) {
    groups.push([
      {
        label: t("project.view.rename"),
        shortcut: "Shift+F6",
        onSelect: () => ctx.onRename?.(single),
      },
      {
        label: t("project.view.delete"),
        shortcut: "Delete",
        danger: true,
        onSelect: () => ctx.onDelete?.(entries),
      },
    ]);
  }

  // Open In
  groups.push([
    {
      label: t("project.view.openIn"),
      children: [
        {
          label: t("project.view.systemExplorer"),
          onSelect: () => single && ctx.onReveal?.(single.path),
        },
      ],
    },
    {
      label: t("project.view.reloadFromDisk"),
      onSelect: () => ctx.onReload?.(),
    },
  ]);

  return flatMenu(groups);
}
