/**
 * 项目侧边栏 1:1 复刻树视窗组件 (ProjectTree)
 *
 * 严格 1:1 全量对标 IntelliJ IDEA ProjectView / IntelliJ IDEA 商业级项目视窗：
 * 1. 宿主与视图结构：采用 `.view` 弹性容器，直接承载 `<Tree<ProjectTreeNode>>` 虚拟化树引擎；
 * 2. 真实 IDEA 样式体系：24px 虚拟行高、20px 缩进阶梯、6px inset 浮动选区、聚焦 `--bg-tree-selected` / 失焦 `--bg-tree-selected-inactive`；
 * 3. 树行内部 1:1 CSS：`.content`（gap 5px）、`.icon`、`.folderIcon`、`.rootLabel`、`.excluded`（严格采用 `var(--vcs-ignored)` 专属色）、`.detail`；
 * 4. 就地行内编辑 (InlineEditor)：直接在 `.content` 行内激活 `.inlineInput`，输入非法出现 `.inlineError` 警示气泡，回车提交 Esc 取消；
 * 5. 剪切状态 (Cut State)：`.cut` 赋予 0.45 弱化透明度；
 * 6. 拖拽移动与复制 (Drag & Drop)：指针驱动拖拽，命中目标文件夹赋予 `.dropTarget` 蓝色强调框与微透明底色，跟随 `.dragGhost` 浮窗；
 * 7. 多根域无缝融合：主源码根、External Libraries (外部依赖库)、Scratches and Consoles (临时文件与草稿)；
 * 8. 铁律红线：普通文件与目录图标 100% 复用 EntryIcon，外部依赖库与草稿采用专属矢量图标。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import {
  createFile,
  createFolder,
  errorText,
  listDirectory,
  moveEntry,
  copyEntry,
  renameEntry,
} from "../../lib/fs";
import { useI18n } from "../../i18n";
import type { FsEntry } from "../../lib/fs";
import type { GitChange } from "../../lib/git";
import { changeMark, folderMarks, ignoredRoots, markClass } from "../../lib/git";
import { loadIgnored, subscribeIgnored } from "../../lib/ignoredCache";
import { basenameOf, samePath } from "../../lib/format";
import EntryIcon from "../../components/EntryIcon";
import { Icon } from "../../ui/Icon";
import { notify } from "../../workbench/notificationStore";
import { HighlightedText } from "../../ui/HighlightedText";
import { Tree, type TreeHandle, type TreeRowState } from "../../ui/Tree";
import { detectExternalLibraries, type LibraryGroup } from "./libraries";
import { getScratchesDir, createScratchFile, SCRATCH_LANGUAGES } from "./scratches";
import {
  ProjectHeader,
  type ProjectViewMode,
  type ViewOptions,
} from "./ProjectHeader";
import { NewPopup, type NewPopupItem } from "./NewPopup";
import { FileRefactorDialogs, type RefactorDialogState } from "./FileRefactorDialogs";
import {
  ArchiveIcon,
  CargoIcon,
  JavaIcon,
  JavaScriptIcon,
  LibraryFolderIcon,
  LibraryIcon,
  ModuleIcon,
  NpmIcon,
  PythonIcon,
  ScratchesIcon,
} from "../../ui/icons/ProjectIcons";
import {
  isIgnoredName,
  isExcludedFolder,
  tildify,
  type ProjectTreeNode,
  type EditingState,
  type ClipboardState,
  type DragState,
  normalizeNodeKey,
  normalizePathKey,
  libKey,
  pathOfKey,
  GROUP_PREFIX,
  isGroupKey,
} from "./model";
import { InlineEditor } from "./InlineEditor";
import { loadExpanded, loadViewMode, loadViewOptions, saveExpanded, saveViewMode, saveViewOptions } from "./viewState";
import styles from "./ProjectTree.module.css";

const DRAG_THRESHOLD = 4;

export interface ProjectTreeProps {
  /** 工作区工程根目录（项目顶层） */
  readonly root: string;
  /** Git 仓库根目录 */
  readonly repoRoot: string | null;
  /** Git 仓库变更项列表 */
  readonly changes: readonly GitChange[];
  /** 递增即折叠全部目录 */
  readonly collapseSignal: number;
  /** 缓存作废批次信号 */
  readonly refresh: { paths: string[] | null; seq: number };
  /** 定位并展开聚焦某条路径 */
  readonly reveal: { path: string; seq: number } | null;
  /** 是否显示被 .gitignore 忽略的文件/目录 */
  readonly showIgnored: boolean;
  /** 是否显示系统隐藏/点开头文件 */
  readonly showHidden: boolean;
  /** 当前仍打开着的工作区根列表（用于常驻工程缓存垃圾回收） */
  readonly openRoots: readonly string[];
  /** 当前正在查看/激活的编辑器文档绝对路径 */
  readonly activeFile?: string | null;
  /** 当前编辑器中打开的文件绝对路径集合 */
  readonly openFiles?: readonly string[];
  /** 选中的文件绝对路径集 */
  readonly picked: readonly string[];
  /** 选中状态变更回调 */
  readonly onPick: (entries: FsEntry[]) => void;
  /** 打开文件回调 */
  readonly onOpenFile: (entry: FsEntry) => void;
  /** 唤起右键上下文菜单回调 */
  readonly onContextMenu: (
    selection: FsEntry[],
    position: { x: number; y: number },
    node?: ProjectTreeNode
  ) => void;
  /** 侧边栏隐藏/收起回调 */
  readonly onHide?: () => void;
  /** 是否处于全屏/最大化状态 */
  readonly isExpanded?: boolean;
  /** 切换全屏/最大化状态回调 */
  readonly onToggleExpand?: () => void;
  /** 重命名回调 */
  readonly onRename?: (entry: FsEntry, newName: string) => void;
  /** 移动回调 */
  readonly onMove?: (entries: FsEntry[], targetDir: string) => void;
  /** 删除回调 */
  readonly onDelete?: (entries: FsEntry[]) => void;
  /** 新建文件回调 */
  readonly onNewFile?: (dir: string, ext?: string) => void;
  /** 新建文件夹回调 */
  readonly onNewFolder?: (dir: string) => void;
}

const pathKey = normalizePathKey;

function parentOfPath(path: string): string {
  const norm = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const slash = norm.lastIndexOf("/");
  return slash <= 0 ? "/" : norm.slice(0, slash);
}

function nameOfPath(path: string): string {
  const norm = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const slash = norm.lastIndexOf("/");
  return slash < 0 ? norm : norm.slice(slash + 1);
}

function isInside(child: string, ancestor: string): boolean {
  const c = normalizePathKey(child).replace(/\/+$/, "");
  const a = normalizePathKey(ancestor).replace(/\/+$/, "");
  return c !== a && (c.startsWith(`${a}/`) || c.startsWith(`${a}\\`));
}

/**
 * 递归计算 targetPath 在 ancestor 内部的所有父级祖先目录物理路径。
 * 归属比较用小写折叠；切分保留原文大小写 —— 返回值会传给 listDirectory，
 * 若喂小写化路径，后端拼出的子条目 path 也会带上小写前缀，污染文档路径形态。
 */
function ancestorsWithin(ancestor: string, targetPath: string): string[] {
  const normBase = normalizePathKey(ancestor).replace(/\/+$/, "");
  const normTarget = normalizePathKey(targetPath).replace(/\/+$/, "");
  if (!normTarget.startsWith(normBase)) return [];
  const rawBase = ancestor.replaceAll("\\", "/").replace(/\/+$/, "");
  const folders: string[] = [];
  let cur = targetPath.replaceAll("\\", "/").replace(/\/+$/, "");
  while (cur.length > rawBase.length) {
    const slash = cur.lastIndexOf("/");
    if (slash <= rawBase.length) break;
    cur = cur.slice(0, slash);
    folders.push(cur);
  }
  return folders;
}

function touched(key: string, changed: string): boolean {
  const a = normalizePathKey(key).replace(/\/+$/, "");
  const b = normalizePathKey(changed).replace(/\/+$/, "");
  return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

function makeVirtualDirectoryEntry(name: string, path: string): FsEntry {
  return {
    name,
    path,
    kind: "directory",
    extension: null,
    size: 0,
    modifiedMs: 0,
    isSymlink: false,
    isHidden: false,
    isReadonly: true,
  };
}

/**
 * 递归收集某个节点在树中的所有子孙节点 key
 * 确保折叠节点时（尤其是 External Libraries 与 Scratches 虚拟分支）能够彻底递归清理所有子孙项
 */
function collectDescendantKeys(
  key: string,
  childrenMap: Map<string, ProjectTreeNode[]>
): string[] {
  const result: string[] = [];
  const queue = [key];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const children = childrenMap.get(cur);
    if (children) {
      for (const child of children) {
        result.push(child.key);
        if (child.hasChildren) {
          queue.push(child.key);
        }
      }
    }
  }
  return result;
}

function isVirtualPath(path: string): boolean {
  return (
    path.startsWith("__") ||
    path.startsWith("\u0000") ||
    path.startsWith("virtual:") ||
    isGroupKey(path)
  );
}

/** 惰性目录缓存 Hook */
function useLazyChildren(
  refresh: { paths: string[] | null; seq: number }
) {
  const [children, setChildren] = useState<Map<string, FsEntry[]>>(new Map());
  const childrenRef = useRef(children);
  childrenRef.current = children;
  // 小写缓存 key → 首次登记的原文形态路径。expanded/行 key 都是小写契约，
  // 若按 key 还原出的小写路径去 listDirectory，后端拼出的子条目 path 会带上小写前缀。
  const rawPathByKey = useRef<Map<string, string>>(new Map());

  const reloadDir = useCallback(
    (dir: string) => {
      // 虚拟目录（外部库根、分组等）不发起物理文件系统读取
      if (!dir || isVirtualPath(dir)) return;
      const key = pathKey(dir);
      rawPathByKey.current.set(key, dir);
      void listDirectory(dir)
        .then((listing) => {
          setChildren((prev) => new Map(prev).set(key, listing.entries));
        })
        .catch(() => {
          // 首次读取失败（不存在/受限）：置空列表显示空目录，不触发红色横条；
          // 已有缓存时刷新失败：保留旧内容（对齐 openidea loadDir 的错误分级）。
          setChildren((prev) => (prev.has(key) ? prev : new Map(prev).set(key, [])));
        });
    },
    []
  );

  const load = useCallback(
    (dir: string) => {
      if (!dir || isVirtualPath(dir)) return;
      const key = pathKey(dir);
      if (childrenRef.current.has(key)) return;
      // 优先还原原文形态（调用方可能只拿得到小写化的行 key）
      reloadDir(rawPathByKey.current.get(key) ?? dir);
    },
    [reloadDir]
  );

  useEffect(() => {
    if (refresh.seq === 0) return;
    const { paths } = refresh;

    if (paths === null) {
      setChildren(new Map());
      return;
    }

    setChildren((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const p of paths) {
        for (const k of next.keys()) {
          if (touched(k, p)) {
            next.delete(k);
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [refresh]);

  return { children, load, reloadDir };
}

export function ProjectTree({
  root,
  repoRoot,
  changes,
  collapseSignal,
  refresh,
  reveal,
  showIgnored: propShowIgnored,
  showHidden: propShowHidden,
  openRoots: _openRoots,
  activeFile,
  openFiles = [],
  picked,
  onPick,
  onOpenFile,
  onContextMenu,
  onHide,
  isExpanded,
  onToggleExpand,
  onRename: _onRename,
  onMove,
  onDelete,
  onNewFile: _onNewFile,
  onNewFolder: _onNewFolder,
}: ProjectTreeProps) {
  const { t } = useI18n();

  // 1. 顶部 Header 状态（视图模式 + 选项）
  // 视图选项/模式/展开状态按工程根持久化（对齐 openidea store 的 localStorage 层）
  const [viewMode, setViewModeRaw] = useState<ProjectViewMode>(() => loadViewMode(pathKey(root)));
  const [options, setOptionsRaw] = useState<ViewOptions>(() => ({
    ...loadViewOptions(pathKey(root)),
    showHidden: propShowHidden,
    showExcluded: propShowIgnored,
  }));

  const setViewMode = useCallback((mode: ProjectViewMode) => {
    setViewModeRaw(mode);
    saveViewMode(pathKey(root), mode);
  }, [root]);

  const setOptions = useCallback((next: ViewOptions) => {
    setOptionsRaw(next);
    saveViewOptions(pathKey(root), next);
  }, [root]);

  // 2. 弹窗状态 (NewPopup & FileRefactorDialogs)
  const [newPopupOpen, setNewPopupOpen] = useState(false);
  const [newPopupAnchor, setNewPopupAnchor] = useState<{ x: number; y: number } | null>(null);
  const [refactorDialog, setRefactorDialog] = useState<RefactorDialogState>(null);

  // 3. 行内编辑状态 (InlineEditor)
  const [editing, setEditing] = useState<EditingState | null>(null);

  // 4. 剪贴板状态 (Ctrl+X 剪切 / Ctrl+C 复制)
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);

  // 5. 拖拽交互状态 (Drag & Drop)
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragActiveRef = useRef(false);
  const dragStartPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // 树引用与展开/选中状态
  const treeHandleRef = useRef<TreeHandle | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpandedRaw] = useState<Set<string>>(() => {
    const saved = loadExpanded(pathKey(root));
    return saved ?? new Set([normalizeNodeKey(root)]);
  });
  const expandedSaveTimer = useRef<number | null>(null);
  const setExpanded = useCallback((value: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setExpandedRaw((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      if (expandedSaveTimer.current !== null) window.clearTimeout(expandedSaveTimer.current);
      expandedSaveTimer.current = window.setTimeout(() => saveExpanded(pathKey(root), next), 300);
      return next;
    });
  }, [root]);
  // 待执行的滚动/聚焦定位请求引用 (1:1 对标 IntelliJ IDEA revealRequest)
  const pendingRevealRef = useRef<{
    path: string;
    focus: boolean;
    timestamp: number;
  } | null>(null);
  const lastCollapseSignal = useRef(collapseSignal);

  // 外部依赖库与临时草稿状态
  const [libraries, setLibraries] = useState<LibraryGroup[]>([]);
  const [scratchesDir, setScratchesDir] = useState<string | null>(null);
  const [home, setHome] = useState<string | null>(null);

  // 异步获取用户 Home 目录供根路径波浪号缩写 (tildify)
  useEffect(() => {
    let active = true;
    import("@tauri-apps/api/path")
      .then(({ homeDir }) => homeDir())
      .then((h) => {
        if (active && h) setHome(h.replaceAll("\\", "/").replace(/\/+$/, ""));
      })
      .catch(() => {
        // 浏览器环境优雅降级
      });
    return () => {
      active = false;
    };
  }, []);

  const { children, load, reloadDir } = useLazyChildren(refresh);

  // 初始加载工作区物理根
  useEffect(() => {
    load(root);
  }, [root, load]);

  // 展开集合状态驱动加载真实目录
  useEffect(() => {
    for (const key of expanded) {
      if (!isVirtualPath(key)) {
        const rawPath = pathOfKey(key);
        if (!isVirtualPath(rawPath) && !children.has(pathKey(rawPath))) {
          load(rawPath);
        }
      }
    }
  }, [expanded, children, load]);

  useEffect(() => {
    let active = true;
    void detectExternalLibraries(root).then((libs) => {
      if (active) setLibraries(libs);
    });
    void getScratchesDir().then((sDir) => {
      if (active) setScratchesDir(sDir);
    });
    return () => {
      active = false;
    };
  }, [root, refresh.seq]);

  useEffect(() => {
    if (collapseSignal !== lastCollapseSignal.current) {
      lastCollapseSignal.current = collapseSignal;
      setExpanded(new Set([normalizeNodeKey(root)]));
    }
  }, [collapseSignal, root]);

  // 订阅被 .gitignore 忽略的文件/目录
  const [ignoredPatterns, setIgnoredPatterns] = useState<string[]>([]);
  useEffect(() => {
    if (!repoRoot || options.showExcluded) {
      setIgnoredPatterns([]);
      return;
    }
    let stale = false;
    const unsubscribe = subscribeIgnored(repoRoot, (list) => {
      if (!stale) setIgnoredPatterns(list);
    });
    void loadIgnored(repoRoot).then((list) => {
      if (!stale) setIgnoredPatterns(list);
    });
    return () => {
      stale = true;
      unsubscribe();
    };
  }, [repoRoot, options.showExcluded]);

  const isIgnored = useCallback(
    (path: string) => {
      if (options.showExcluded || !repoRoot || ignoredPatterns.length === 0) return false;
      const roots = ignoredRoots(repoRoot, ignoredPatterns);
      const key = pathKey(path);
      return roots.some((dir) => key === dir || key.startsWith(`${dir}/`));
    },
    [repoRoot, ignoredPatterns, options.showExcluded]
  );

  const { markOf, dotOf } = useMemo(() => {
    const files = new Map<string, string>();
    const dirs = new Map<string, string>();
    if (!repoRoot) return { markOf: files, dotOf: dirs };
    const prefix = repoRoot.replace(/[\\/]+$/, "");
    const key = (rel: string) => `${prefix}/${rel}`.replaceAll("\\", "/").toLowerCase();
    for (const c of changes) files.set(key(c.path), changeMark(c));
    const dm = folderMarks([...changes]);
    for (const [rel, kind] of dm) dirs.set(key(rel), kind);
    return { markOf: files, dotOf: dirs };
  }, [changes, repoRoot]);

  /**
   * 1:1 对标 IntelliJ IDEA revealPath 规范：展开祖先目录、异步加载并在可见后滚动定位
   */
  const revealPath = useCallback(
    (targetPath: string, focus = true): boolean => {
      if (!targetPath) return false;
      const targetNorm = targetPath.replaceAll("\\", "/").replace(/\/+$/, "");
      const baseNorm = root.replaceAll("\\", "/").replace(/\/+$/, "");

      // 1. 判断属于主工程、草稿还是外部库
      // 归属判定必须大小写不敏感：文档路径可能来自后端按小写化目录拼出的子路径
      // （如 d:/proj\file.ts），与原始盘符大写的 root 直接字符串比对永远撞不上。
      const fold = (p: string) => normalizePathKey(p).replace(/\/+$/, "");
      const targetFold = fold(targetNorm);
      let inProject = false;
      let inScratches = false;
      let inLibrary: {
        groupId: string;
        groupKey: string;
        rootKey: string;
        rootDir: string;
      } | null = null;

      if (targetFold === fold(baseNorm) || targetFold.startsWith(`${fold(baseNorm)}/`)) {
        inProject = true;
      } else if (scratchesDir) {
        const scratchFold = fold(scratchesDir);
        if (targetFold === scratchFold || targetFold.startsWith(`${scratchFold}/`)) {
          inScratches = true;
        }
      }

      if (!inProject && !inScratches && libraries.length > 0) {
        for (const lib of libraries) {
          for (const libRoot of lib.roots) {
            const rootFold = fold(libRoot.path);
            if (targetFold === rootFold || targetFold.startsWith(`${rootFold}/`)) {
              inLibrary = {
                groupId: lib.id,
                groupKey: `${GROUP_PREFIX}${lib.id}`,
                rootKey: libKey(lib.id, libRoot.path),
                rootDir: libRoot.path,
              };
              break;
            }
          }
          if (inLibrary) break;
        }
      }

      if (!inProject && !inScratches && !inLibrary) {
        return false;
      }

      // 2. 模式联动（对齐 openidea modeShows）：只有目标在主工程、而当前停在过滤视图时才切回 Project；
      // 在 Scratches 模式定位草稿文件不该被拉走。
      if (viewMode !== "project" && (inProject || inLibrary || (inScratches && viewMode !== "scratches"))) {
        setViewMode("project");
      }

      // 3. 计算物理祖先目录与虚拟祖先 key
      const keysToExpand = new Set<string>();
      const dirsToLoad: string[] = [];

      if (inProject) {
        keysToExpand.add(normalizeNodeKey(root));
        const folders = ancestorsWithin(root, targetNorm);
        for (const dir of folders) {
          keysToExpand.add(pathKey(dir));
          dirsToLoad.push(dir);
        }
      } else if (inScratches && scratchesDir) {
        keysToExpand.add(normalizeNodeKey(root));
        keysToExpand.add("__scratches_and_consoles__");
        const folders = ancestorsWithin(scratchesDir, targetNorm);
        for (const dir of folders) {
          keysToExpand.add(pathKey(dir));
          dirsToLoad.push(dir);
        }
        dirsToLoad.push(scratchesDir);
      } else if (inLibrary) {
        keysToExpand.add(normalizeNodeKey(root));
        keysToExpand.add("__external_libraries__");
        keysToExpand.add(inLibrary.groupKey);
        keysToExpand.add(inLibrary.rootKey);
        const folders = ancestorsWithin(inLibrary.rootDir, targetNorm);
        for (const dir of folders) {
          keysToExpand.add(libKey(inLibrary.groupId, dir));
          dirsToLoad.push(dir);
        }
        dirsToLoad.push(inLibrary.rootDir);
      }

      // 4. 将祖先加入展开集合并触发未加载目录读取
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const k of keysToExpand) {
          next.add(k);
        }
        return next;
      });

      for (const dir of dirsToLoad) {
        load(dir);
      }

      // 5. 登记待定位目标
      pendingRevealRef.current = {
        path: targetNorm,
        focus,
        timestamp: Date.now(),
      };

      return true;
    },
    [root, scratchesDir, libraries, viewMode, load]
  );

  // 外部 reveal 属性联动触发定位
  useEffect(() => {
    if (reveal && reveal.path) {
      revealPath(reveal.path, true);
    }
  }, [reveal, revealPath]);

  // 从源文件自动滚动 (Autoscroll from Source) 联动
  useEffect(() => {
    if (options.autoscrollFromSource && activeFile) {
      revealPath(activeFile, false);
    }
  }, [options.autoscrollFromSource, activeFile, revealPath]);

  // 过滤视图模式（Open Files / All Changed Files）的目标文件集合
  const targetFiles = useMemo(() => {
    if (viewMode === "openFiles") {
      return new Set((openFiles || []).map((f) => pathKey(f)));
    }
    if (viewMode === "changedFiles") {
      const prefix = repoRoot ? repoRoot.replace(/[\\/]+$/, "") : root.replace(/[\\/]+$/, "");
      // 已删除（D）的文件磁盘上不存在，树上只会展开成空壳，剔除掉（对齐 openidea localChangedPaths）。
      return new Set(
        changes
          .filter((c) => c.workStatus !== "D" && c.indexStatus !== "D")
          .map((c) => pathKey(`${prefix}/${c.path}`))
      );
    }
    return null;
  }, [viewMode, openFiles, changes, repoRoot, root]);

  const visibleAncestors = useMemo(() => {
    if (!targetFiles) return null;
    const set = new Set<string>();
    for (const f of targetFiles) {
      let cur = f;
      while (cur.length > 0) {
        const slash = cur.lastIndexOf("/");
        if (slash <= 0) break;
        cur = cur.slice(0, slash);
        set.add(cur);
      }
    }
    return set;
  }, [targetFiles]);

  // 构建完整的层次树模型 (TreeModel: roots + childrenMap)
  const treeModel = useMemo(() => {
    const roots: ProjectTreeNode[] = [];
    const childrenMap = new Map<string, ProjectTreeNode[]>();
    const byKey = new Map<string, ProjectTreeNode>();
    const isFiltered = targetFiles !== null;

    const buildChildrenForDir = (
      dirPath: string,
      depth: number,
      domain: "project" | "libraries" | "scratches",
      groupNamespace?: string
    ): ProjectTreeNode[] | undefined => {
      const pKey = pathKey(dirPath);
      // 关键契约：未完成加载的物理目录必须返回 undefined！
      // Tree.tsx 收到 undefined 会渲染稳定固高(24px)的 loading 占位行，
      // 彻底消除异步加载前后虚拟列表高度突变导致的重影与拉扯！
      if (!children.has(pKey)) {
        return undefined;
      }

      const list = children.get(pKey) ?? [];
      const filtered = list.filter((e) => {
        if (isFiltered) {
          const k = pathKey(e.path);
          if (e.kind === "directory") {
            if (!visibleAncestors?.has(k)) return false;
          } else {
            if (!targetFiles.has(k)) return false;
          }
        }
        if (!options.showHidden && isIgnoredName(e.name)) return false;
        if (!options.showExcluded && isIgnored(e.path)) return false;
        return true;
      });

      filtered.sort((a, b) => {
        if (options.foldersFirst) {
          if (a.kind === "directory" && b.kind !== "directory") return -1;
          if (a.kind !== "directory" && b.kind === "directory") return 1;
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
      });

      const res: ProjectTreeNode[] = [];

      // 若处于新建状态，在其父文件夹顶部插入新建占位行
      if (editing?.kind === "new" && pathKey(editing.parent) === pathKey(dirPath)) {
        const placeholderEntry = makeVirtualDirectoryEntry("", `${dirPath}/__new_item__`);
        placeholderEntry.kind = editing.nodeKind === "dir" ? "directory" : "file";
        const placeholderKey = groupNamespace
          ? libKey(groupNamespace, `${dirPath}/__new_item__`)
          : `__new_placeholder__:${dirPath}`;
        const placeholderNode: ProjectTreeNode = {
          key: placeholderKey,
          displayName: "",
          entry: placeholderEntry,
          domain,
          deepestPath: placeholderEntry.path,
          depth,
          isExpanded: false,
          hasChildren: editing.nodeKind === "dir",
        };
        res.push(placeholderNode);
        byKey.set(placeholderNode.key, placeholderNode);
      }

      for (const entry of filtered) {
        if (entry.kind === "directory") {
          let chainNames = [entry.name];
          let endEntry = entry;

          if (options.compact && !isFiltered) {
            let cur = entry;
            while (true) {
              const subList = children.get(pathKey(cur.path));
              if (!subList) break;
              const subVisible = subList.filter((e) => {
                if (!options.showHidden && isIgnoredName(e.name)) return false;
                if (!options.showExcluded && isIgnored(e.path)) return false;
                return true;
              });
              if (subVisible.length === 1 && subVisible[0].kind === "directory") {
                const only = subVisible[0];
                const onlyEx = isExcludedFolder(only.name) || isIgnored(only.path);
                const curEx = isExcludedFolder(cur.name) || isIgnored(cur.path);
                if (onlyEx === curEx) {
                  chainNames.push(only.name);
                  cur = only;
                  endEntry = only;
                  continue;
                }
              }
              break;
            }
          }

          const displayName = chainNames.join("/");
          const itemKey = groupNamespace
            ? libKey(groupNamespace, entry.path)
            : normalizeNodeKey(entry.path);
          const endKey = groupNamespace
            ? libKey(groupNamespace, endEntry.path)
            : normalizeNodeKey(endEntry.path);
          const isExp = expanded.has(itemKey) || expanded.has(endKey);
          const isExcluded = isExcludedFolder(endEntry.name) || isIgnored(endEntry.path);

          const node: ProjectTreeNode = {
            key: itemKey,
            displayName,
            entry: endEntry,
            domain,
            deepestPath: endEntry.path,
            depth,
            isExpanded: isExp,
            hasChildren: true,
            isExcluded,
            isReadonly: domain === "libraries",
          };
          res.push(node);
          byKey.set(node.key, node);

          // 递归构建并记录子节点列表
          const subChildren = buildChildrenForDir(endEntry.path, depth + 1, domain, groupNamespace);
          if (subChildren !== undefined) {
            childrenMap.set(node.key, subChildren);
          }
        } else {
          const fileKey = groupNamespace
            ? libKey(groupNamespace, entry.path)
            : normalizeNodeKey(entry.path);
          const isExcluded = isIgnored(entry.path);
          const node: ProjectTreeNode = {
            key: fileKey,
            displayName: entry.name,
            entry,
            domain,
            deepestPath: entry.path,
            depth,
            isExpanded: false,
            hasChildren: false,
            isExcluded,
            isReadonly: domain === "libraries",
          };
          res.push(node);
          byKey.set(node.key, node);
        }
      }

      return res;
    };

    // 1. Project 物理根节点
    if (viewMode !== "scratches") {
      const rootKey = normalizeNodeKey(root);
      const isRootExp = isFiltered || expanded.has(rootKey);
      const projectRootNode: ProjectTreeNode = {
        key: rootKey,
        displayName: basenameOf(root) || root,
        entry: makeVirtualDirectoryEntry(basenameOf(root) || root, root),
        domain: "project",
        deepestPath: root,
        depth: 0,
        isRoot: true,
        isExpanded: isRootExp,
        hasChildren: true,
        locationDetail: tildify(root, home),
      };
      roots.push(projectRootNode);
      byKey.set(projectRootNode.key, projectRootNode);

      const projectChildren = buildChildrenForDir(root, 1, "project");
      if (projectChildren !== undefined) {
        childrenMap.set(projectRootNode.key, projectChildren);
      }
    }

    // 2. External Libraries 根节点 (1:1 严格对标 IntelliJ IDEA librariesRoot)
    if (viewMode === "project" && libraries.length > 0) {
      const libRootKey = `${GROUP_PREFIX}externalLibraries`;
      const isLibExp = expanded.has(libRootKey);
      const libRootNode: ProjectTreeNode = {
        key: libRootKey,
        displayName: t("project.view.externalLibraries") || "External Libraries",
        entry: makeVirtualDirectoryEntry("External Libraries", libRootKey),
        domain: "libraries",
        deepestPath: libRootKey,
        depth: 0,
        isRoot: true,
        isExpanded: isLibExp,
        hasChildren: true,
        isReadonly: true,
        icon: "library",
      };
      roots.push(libRootNode);
      byKey.set(libRootNode.key, libRootNode);

      const groupNodes: ProjectTreeNode[] = [];
      for (const group of libraries) {
        const groupKey = `${GROUP_PREFIX}externalLibraries/${group.id}`;
        const groupExp = expanded.has(groupKey);

        // 1:1 对标 IntelliJ IDEA 的 GROUP_ICONS 映射
        const groupIcon =
          group.kind === "nodeModules"
            ? "file-npm"
            : group.kind === "cargo"
            ? "file-cargo"
            : group.kind === "nodeCore"
            ? "file-js"
            : group.kind === "python"
            ? "file-python"
            : group.kind === "jdk" || group.kind === "maven" || group.kind === "gradle"
            ? "file-java"
            : "library";

        const groupNode: ProjectTreeNode = {
          key: groupKey,
          displayName: group.label,
          entry: makeVirtualDirectoryEntry(group.label, groupKey),
          domain: "libraries",
          deepestPath: groupKey,
          depth: 1,
          isGroup: true,
          isExpanded: groupExp,
          hasChildren: group.roots.length > 0,
          isReadonly: true,
          icon: groupIcon,
        };
        groupNodes.push(groupNode);
        byKey.set(groupNode.key, groupNode);

        const libNodes: ProjectTreeNode[] = [];
        for (const libRoot of group.roots) {
          const itemKey = libKey(group.id, libRoot.path);
          const rootExp = expanded.has(itemKey);
          const libNode: ProjectTreeNode = {
            key: itemKey,
            displayName: libRoot.name,
            entry: makeVirtualDirectoryEntry(libRoot.name, libRoot.path),
            domain: "libraries",
            deepestPath: libRoot.path,
            depth: 2,
            isExpanded: rootExp,
            hasChildren: libRoot.isDirectory,
            isReadonly: true,
            locationDetail: libRoot.detail || "library root",
            // 1:1 对标 IntelliJ IDEA librariesRoot：依赖项统一赋予库文件夹或归档图标
            icon: libRoot.isArchive ? "file-archive" : "folder-library",
          };
          libNodes.push(libNode);
          byKey.set(libNode.key, libNode);

          if (libRoot.isDirectory) {
            const subLibChildren = buildChildrenForDir(libRoot.path, 3, "libraries", group.id);
            if (subLibChildren !== undefined) {
              childrenMap.set(libNode.key, subLibChildren);
            }
          }
        }
        childrenMap.set(groupNode.key, libNodes);
      }
      childrenMap.set(libRootNode.key, groupNodes);
    }

    // 3. Scratches and Consoles 根节点
    if ((viewMode === "project" || viewMode === "scratches") && scratchesDir) {
      const scRootKey = "__scratches_and_consoles__";
      const isScExp = viewMode === "scratches" || expanded.has(scRootKey);
      const scRootNode: ProjectTreeNode = {
        key: scRootKey,
        displayName: t("project.view.scratches") || "Scratches and Consoles",
        entry: makeVirtualDirectoryEntry("Scratches and Consoles", scRootKey),
        domain: "scratches",
        deepestPath: scRootKey,
        depth: 0,
        isRoot: true,
        isExpanded: isScExp,
        hasChildren: true,
      };
      roots.push(scRootNode);
      byKey.set(scRootNode.key, scRootNode);

      const scratchesChildren = buildChildrenForDir(scratchesDir, 1, "scratches");
      if (scratchesChildren !== undefined) {
        childrenMap.set(scRootNode.key, scratchesChildren);
      }
    }

    return { roots, childrenMap, byKey };
  }, [
    root,
    viewMode,
    libraries,
    scratchesDir,
    expanded,
    children,
    options,
    isIgnored,
    targetFiles,
    visibleAncestors,
    editing,
    t,
  ]);

  // 响应 pendingRevealRef：当树节点在 treeModel 中生成并可见时，平滑滚动至视口中央并高亮选中
  useEffect(() => {
    if (!pendingRevealRef.current) return;
    const { path: targetPath, focus } = pendingRevealRef.current;
    const targetKey = normalizeNodeKey(targetPath);
    const targetPathKey = pathKey(targetPath);

    // 尝试根据绝对 key 或规范化路径 key 检索节点
    const node =
      treeModel.byKey.get(targetKey) ||
      treeModel.byKey.get(targetPathKey) ||
      [...treeModel.byKey.values()].find(
        (n) => samePath(n.entry.path, targetPath) || samePath(n.deepestPath, targetPath)
      );

    if (node) {
      pendingRevealRef.current = null;
      // 1. 触发 TreeHandle 虚拟列表居中滚动与高亮
      treeHandleRef.current?.reveal(node.key);
      // 2. 触发选中状态同步到外部
      onPick([node.entry]);
      // 3. 聚焦树组件
      if (focus) {
        requestAnimationFrame(() => {
          treeHandleRef.current?.focus();
        });
      }
    }
  }, [treeModel, onPick]);

  /** 新建条目落盘后的 FsEntry（后端已返回过一次，这里按路径规格重建给树与编辑器用）。 */
function makeEntryFor(fullPath: string, name: string): FsEntry {
  return {
    name,
    path: fullPath,
    kind: "file",
    extension: name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : null,
    size: 0,
    modifiedMs: Date.now(),
    isSymlink: false,
    isHidden: false,
    isReadonly: false,
  };
}

  // 最新 childrenMap 的 ref：Expand All 的轮询在回调里读，不能吃渲染闭包的旧值。
  const childrenMapRef = useRef(treeModel.childrenMap);
  childrenMapRef.current = treeModel.childrenMap;

// 获取同级项名称集合供 InlineEditor 实时校验重名
  const editingSiblings = useMemo(() => {
    if (!editing) return [];
    const parentDir = editing.kind === "new" ? editing.parent : parentOfPath(editing.path);
    const list = children.get(pathKey(parentDir)) ?? [];
    return list.map((e) => e.name);
  }, [editing, children]);

  // 提交就地行内编辑
  const handleCommitEditing = useCallback(
    async (value: string): Promise<boolean> => {
      if (!editing) return true;
      if (editing.kind === "new") {
        const fullPath = `${editing.parent.replace(/[/\\]+$/, "")}/${value}`;
        try {
          if (editing.nodeKind === "dir") {
            await createFolder(fullPath);
          } else {
            await createFile(fullPath);
            // 新建文件随后在编辑器里打开（对齐 openidea commitEditing → openFile）
            onOpenFile(makeEntryFor(fullPath, value));
          }
          reloadDir(editing.parent);
          setEditing(null);
          // 新条目露出来并定位（对齐 openidea refreshAfterCreate → revealPath）
          revealPath(fullPath, true);
          return true;
        } catch (err) {
          // 操作失败发布通知气泡，避免破坏树形结构
          notify({ level: "error", title: "Create Entry Failed", body: errorText(err) });
          return false;
        }
      } else {
        const parentDir = parentOfPath(editing.path);
        const newPath = `${parentDir.replace(/[/\\]+$/, "")}/${value}`;
        if (newPath === editing.path) {
          setEditing(null);
          return true;
        }
        try {
          await renameEntry(editing.path, newPath);
          reloadDir(parentDir);
          setEditing(null);
          return true;
        } catch (err) {
          // 重命名失败发布通知气泡
          notify({ level: "error", title: "Rename Failed", body: errorText(err) });
          return false;
        }
      }
    },
    [editing, reloadDir, revealPath, onOpenFile]
  );

  const handleCancelEditing = useCallback(() => {
    setEditing(null);
  }, []);

  // 获得选中节点中最高优先级的目标文件夹
  const getSelectedTargetFolder = useCallback((): string => {
    if (picked.length > 0) {
      // picked 存的是原始大小写/反斜杠路径，byKey 的 key 是 normalizeNodeKey（小写正斜杠）
      const leadPath = normalizeNodeKey(picked[0]);
      const found = treeModel.byKey.get(leadPath);
      if (found) {
        return found.entry.kind === "directory" ? found.entry.path : parentOfPath(found.entry.path);
      }
    }
    return root;
  }, [picked, treeModel.byKey, root]);

  // 快捷新建文件/目录
  const startNewItem = useCallback(
    (nodeKind: "file" | "dir") => {
      const targetDir = getSelectedTargetFolder();
      setExpanded((prev) => new Set(prev).add(pathKey(targetDir)));
      load(targetDir);
      setEditing({ kind: "new", parent: targetDir, nodeKind });
    },
    [getSelectedTargetFolder, load]
  );

  // 快捷重命名
  const startRenameItem = useCallback(() => {
    if (picked.length !== 1) return;
    const targetPath = normalizeNodeKey(picked[0]);
    const node = treeModel.byKey.get(targetPath);
    if (!node || node.isRoot || node.entry.isReadonly) return;
    setEditing({
      kind: "rename",
      path: node.entry.path,
      currentName: node.entry.name,
      isDir: node.entry.kind === "directory",
    });
  }, [picked, treeModel.byKey]);

  // 复制与剪切
  const handleCopy = useCallback(
    (cut: boolean) => {
      if (picked.length === 0) return;
      setClipboard({ paths: [...picked], cut });
    },
    [picked]
  );

  // 粘贴
  const handlePaste = useCallback(async () => {
    if (!clipboard || clipboard.paths.length === 0) return;
    const targetDir = getSelectedTargetFolder();
    const isCut = clipboard.cut;
    for (const src of clipboard.paths) {
      const name = nameOfPath(src);
      const dest = `${targetDir.replace(/[/\\]+$/, "")}/${name}`;
      try {
        if (isCut) {
          await moveEntry(src, dest);
          reloadDir(parentOfPath(src));
        } else {
          await copyEntry(src, dest);
        }
      } catch (err) {
        // 粘贴移动/复制失败发布通知气泡
        notify({ level: "error", title: "Paste Failed", body: errorText(err) });
      }
    }
    reloadDir(targetDir);
    if (isCut) {
      setClipboard(null);
    }
  }, [clipboard, getSelectedTargetFolder, reloadDir]);

  // 快捷键映射拦截
  const handleContainerKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (editing) return;

    // Alt+Insert / Command+N: 呼出新建悬浮窗
    if ((e.altKey && e.key === "Insert") || (e.metaKey && e.key === "n")) {
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      setNewPopupAnchor(
        rect
          ? { x: rect.left + 24, y: rect.top + 36 }
          : { x: window.innerWidth / 3, y: window.innerHeight / 3 }
      );
      setNewPopupOpen(true);
      return;
    }

    // Shift+F6: 行内就地激活重命名
    if (e.shiftKey && e.key === "F6") {
      e.preventDefault();
      startRenameItem();
      return;
    }

    // Ctrl+C / Cmd+C: 复制
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      handleCopy(false);
      return;
    }

    // Ctrl+X / Cmd+X: 剪切
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "x") {
      e.preventDefault();
      handleCopy(true);
      return;
    }

    // Ctrl+V / Cmd+V: 粘贴
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      e.preventDefault();
      void handlePaste();
      return;
    }

    // Ctrl+Shift+C: 复制绝对路径
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      if (picked.length > 0) {
        void navigator.clipboard.writeText(picked.join("\n"));
      }
      return;
    }

    // F6: 移动选中的条目
    if (!e.shiftKey && e.key === "F6") {
      const selectedEntries = picked
        .map((p) => treeModel.byKey.get(normalizeNodeKey(p))?.entry)
        .filter((e): e is FsEntry => !!e);
      if (selectedEntries.length > 0 && onMove) {
        e.preventDefault();
        setRefactorDialog({
          kind: "move",
          entries: selectedEntries,
          targetDir: root,
          onConfirm: (targetDir) => onMove(selectedEntries, targetDir),
        });
        return;
      }
    }

    // Delete: 安全删除选中的条目
    if (e.key === "Delete") {
      const selectedEntries = picked
        .map((p) => treeModel.byKey.get(normalizeNodeKey(p))?.entry)
        .filter((e): e is FsEntry => !!e);
      if (selectedEntries.length > 0 && onDelete) {
        e.preventDefault();
        setRefactorDialog({
          kind: "safeDelete",
          entries: selectedEntries,
          onConfirm: () => onDelete(selectedEntries),
        });
        return;
      }
    }

    // Esc: 取消剪贴板剪切态与进行中的拖拽
    if (e.key === "Escape") {
      if (clipboard?.cut) setClipboard(null);
      if (dragActiveRef.current) {
        dragActiveRef.current = false;
        setDrag(null);
        setDropTarget(null);
      }
    }
  };

  // 统一的展开/折叠核心调度函数（1:1 对标 IntelliJ IDEA toggleExpanded 规范）
  const toggleNodeExpanded = useCallback(
    (node: ProjectTreeNode) => {
      if (!node.hasChildren) return;
      const k = node.key;
      let willOpen = false;
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(k)) {
          // 折叠：从集合中移除该 key
          next.delete(k);
          // 彻底递归清理子孙展开项，支持物理目录与外部库/草稿虚拟节点
          const descendants = collectDescendantKeys(k, treeModel.childrenMap);
          for (const itemKey of descendants) {
            next.delete(itemKey);
          }
        } else {
          next.add(k);
          willOpen = true;
        }
        return next;
      });

      // 仅在展开时异步加载真实目录内容
      if (willOpen) {
        if (!isVirtualPath(node.deepestPath)) {
          load(node.deepestPath);
        } else if (node.deepestPath === "__scratches_and_consoles__" && scratchesDir) {
          load(scratchesDir);
        }
      }
    },
    [scratchesDir, load, treeModel.childrenMap]
  );

  // 单击行交互逻辑（与 options 配置严格联动）
  const onRowClick = useCallback(
    (node: ProjectTreeNode, e: ReactMouseEvent) => {
      if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      if (editing) return;

      if (node.hasChildren) {
        if (options.singleClickExpand) {
          toggleNodeExpanded(node);
        }
      } else {
        if (options.singleClickOpen || options.previewTab) {
          onOpenFile(node.entry);
        }
      }
    },
    [editing, options, toggleNodeExpanded, onOpenFile]
  );

  // 指针拖拽 DnD 交互
  const onRowPointerDown = useCallback(
    (node: ProjectTreeNode, e: ReactPointerEvent) => {
      if (
        e.button !== 0 ||
        node.isRoot ||
        node.entry.isReadonly ||
        node.domain === "libraries" ||
        editing
      )
        return;

      dragStartPos.current = { x: e.clientX, y: e.clientY };
      dragActiveRef.current = false;
      const paths = picked.includes(node.entry.path) ? [...picked] : [node.entry.path];

      const move = (ev: PointerEvent) => {
        if (!dragActiveRef.current) {
          if (Math.hypot(ev.clientX - dragStartPos.current.x, ev.clientY - dragStartPos.current.y) < DRAG_THRESHOLD) {
            return;
          }
          dragActiveRef.current = true;
        }

        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const contentEl = el?.closest<HTMLElement>("[data-project-path]");
        const targetPath = contentEl?.dataset.projectPath;
        const isDir = !!contentEl?.dataset.dir;

        const destDir = isDir ? targetPath : targetPath ? parentOfPath(targetPath) : null;
        const isValid =
          destDir &&
          !isVirtualPath(destDir) &&
          !paths.some((p) => samePath(destDir, p) || isInside(destDir, p));

        setDropTarget(isValid ? destDir : null);
        setDrag({
          paths,
          label: paths.length === 1 ? nameOfPath(paths[0]) : `${paths.length} items`,
          x: ev.clientX,
          y: ev.clientY,
          copy: ev.altKey,
        });
      };

      const up = async (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);

        if (dragActiveRef.current) {
          const el = document.elementFromPoint(ev.clientX, ev.clientY);
          const contentEl = el?.closest<HTMLElement>("[data-project-path]");
          const targetPath = contentEl?.dataset.projectPath;
          const isDir = !!contentEl?.dataset.dir;

          const destDir = isDir ? targetPath : targetPath ? parentOfPath(targetPath) : null;
          const isValid =
            destDir &&
            !isVirtualPath(destDir) &&
            !paths.some((p) => samePath(destDir, p) || isInside(destDir, p));

          if (isValid) {
            const isCopy = ev.altKey;
            for (const src of paths) {
              const name = nameOfPath(src);
              const dest = `${destDir.replace(/[/\\]+$/, "")}/${name}`;
              try {
                if (isCopy) {
                  await copyEntry(src, dest);
                } else {
                  await moveEntry(src, dest);
                  reloadDir(parentOfPath(src));
                }
              } catch (err) {
                // 拖拽移动/复制失败发布通知气泡
                notify({ level: "error", title: "Move/Copy Failed", body: errorText(err) });
              }
            }
            reloadDir(destDir);
          }
        }

        setDrag(null);
        setDropTarget(null);
        dragActiveRef.current = false;
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [picked, editing, reloadDir]
  );

  // 选区变更处理
  const handleSelectionChange = useCallback(
    (selectedKeys: Set<string>, lead: ProjectTreeNode | null) => {
      const entries = [...selectedKeys]
        .map((k) => treeModel.byKey.get(k)?.entry)
        .filter((e): e is FsEntry => !!e);
      onPick(entries.length ? entries : lead ? [lead.entry] : []);
    },
    [treeModel.byKey, onPick]
  );

  // 展开折叠变更处理（Tree 的 Chevron 鼠标点击或键盘方向键触发）
  const handleExpandedChange = useCallback(
    (nextExpanded: Set<string>, node: ProjectTreeNode, open: boolean) => {
      const k = node.key;
      const next = new Set(nextExpanded);
      if (open) {
        next.add(k);
        if (!isVirtualPath(node.deepestPath)) {
          load(node.deepestPath);
        } else if (node.deepestPath === "__scratches_and_consoles__" && scratchesDir) {
          load(scratchesDir);
        }
      } else {
        next.delete(k);
        // 彻底递归清理子孙展开项，支持物理目录与外部库/草稿虚拟节点
        const descendants = collectDescendantKeys(k, treeModel.childrenMap);
        for (const itemKey of descendants) {
          next.delete(itemKey);
        }
      }
      setExpanded(next);
    },
    [scratchesDir, load, treeModel.childrenMap]
  );

  // 节点激活（双击或按回车由 Tree 统一调度）
  const handleActivate = useCallback(
    (node: ProjectTreeNode) => {
      if (node.hasChildren) {
        // 「单击展开」开启时，双击的第一段单击已经切过一次，这里再切就等于没变（对齐 openidea 的 stopPropagation 语义）。
        if (options.singleClickExpand) return;
        toggleNodeExpanded(node);
      } else {
        onOpenFile(node.entry);
      }
    },
    [options.singleClickExpand, toggleNodeExpanded, onOpenFile]
  );

  // 右键菜单
  const handleContextMenu = useCallback(
    (node: ProjectTreeNode | null, selection: Set<string>, e: ReactMouseEvent) => {
      e.preventDefault();
      const entries = [...selection]
        .map((k) => treeModel.byKey.get(k)?.entry)
        .filter((entry): entry is FsEntry => !!entry);
      const target = entries.length ? entries : node ? [node.entry] : [];
      onContextMenu(target, { x: e.clientX, y: e.clientY }, node ?? undefined);
    },
    [treeModel.byKey, onContextMenu]
  );

  // 1:1 renderNode 渲染回调
  const renderNode = useCallback(
    (node: ProjectTreeNode, state: TreeRowState) => {
      const isCut = clipboard?.cut && clipboard.paths.includes(node.entry.path);
      const isTarget = dropTarget === node.entry.path;
      const isCurrentEditing =
        editing &&
        ((editing.kind === "rename" && samePath(editing.path, node.entry.path)) ||
          (editing.kind === "new" && node.key.startsWith("__new_placeholder__")));

      const isDirectory = node.entry.kind === "directory";
      const gitMark = !isDirectory && node.domain === "project" ? markOf.get(pathKey(node.entry.path)) : null;
      const gitDot = isDirectory && node.domain === "project" ? dotOf.get(pathKey(node.entry.path)) : null;

      return (
        <span
          className={clsx(
            styles.content,
            isCut && styles.cut,
            isTarget && styles.dropTarget
          )}
          data-project-path={node.entry.path}
          data-project-key={node.key}
          data-dir={node.entry.kind === "directory" ? true : undefined}
          onClick={(e) => onRowClick(node, e)}
          onPointerDown={(e) => onRowPointerDown(node, e)}
        >
          {/* 图标渲染：普通文件/目录 100% 沿用 EntryIcon，根节点使用专属矢量图标 */}
          <span
            className={clsx(
              styles.icon,
              node.hasChildren && styles.folderIcon,
              node.isExcluded && styles.faded
            )}
          >
            {node.isRoot && node.domain === "project" ? (
              <ModuleIcon />
            ) : node.isRoot && node.domain === "libraries" ? (
              <LibraryIcon />
            ) : node.isRoot && node.domain === "scratches" ? (
              <ScratchesIcon />
            ) : node.icon === "file-npm" ? (
              <NpmIcon />
            ) : node.icon === "file-cargo" ? (
              <CargoIcon />
            ) : node.icon === "file-java" ? (
              <JavaIcon />
            ) : node.icon === "file-python" ? (
              <PythonIcon />
            ) : node.icon === "file-js" ? (
              <JavaScriptIcon />
            ) : node.icon === "file-archive" ? (
              <ArchiveIcon />
            ) : node.icon === "folder-library" ? (
              <LibraryFolderIcon />
            ) : (
              <EntryIcon
                name={node.entry.name}
                isDirectory={node.entry.kind === "directory"}
                isPackage={node.isPackage}
                path={node.entry.path}
                excluded={node.isExcluded}
                size={16}
              />
            )}
          </span>

          {isCurrentEditing ? (
            <InlineEditor
              editing={editing}
              siblings={editingSiblings}
              onCommit={handleCommitEditing}
              onCancel={handleCancelEditing}
            />
          ) : (
            <>
              <span className={styles.nameWrapper}>
                <HighlightedText
                  className={clsx(
                    styles.label,
                    node.isRoot && node.domain === "project" && styles.rootLabel,
                    gitMark || gitDot
                      ? markClass(gitMark ?? gitDot ?? "")
                      : node.isExcluded && styles.excluded
                  )}
                  text={node.displayName}
                  indices={state.matches}
                  tone="accent"
                />
                {node.locationDetail && (
                  <span className={styles.detail}>{node.locationDetail}</span>
                )}
              </span>
              {/* 文件自身单字母标记（M/A/U/D/R/!）：严格使用全局 tree-mark 类，靠行尾最右侧对齐 */}
              {gitMark ? (
                <span className={clsx("tree-mark", markClass(gitMark))}>
                  {gitMark}
                </span>
              ) : null}
              {/* 目录子孙聚合变更圆点：严格使用全局 change-dot 类，随 markClass 颜色透明度 0.4 */}
              {gitDot ? (
                <span
                  className={clsx("change-dot", markClass(gitDot))}
                  aria-hidden="true"
                />
              ) : null}
            </>
          )}
        </span>
      );
    },
    [
      clipboard,
      dropTarget,
      editing,
      markOf,
      dotOf,
      onRowClick,
      onRowPointerDown,
      editingSiblings,
      handleCommitEditing,
      handleCancelEditing,
    ]
  );

  // 新建悬浮框预设数据项
  const newPopupItems: NewPopupItem[] = useMemo(() => {
    return [
      {
        id: "file",
        label: t("project.view.newFile"),
        icon: "file",
        shortcut: "Alt+N",
        onSelect: () => startNewItem("file"),
      },
      {
        id: "dir",
        label: t("project.view.newDirectory"),
        icon: "folder",
        onSelect: () => startNewItem("dir"),
      },
      {
        id: "scratch",
        label: t("project.view.newScratch"),
        icon: "scratches",
        onSelect: () => {
          void createScratchFile(SCRATCH_LANGUAGES[0]).then((f) => onOpenFile(f));
        },
      },
      { id: "sep-1", label: "", separator: true, onSelect: () => {} },
      {
        id: "js",
        label: "JavaScript File",
        icon: "file",
        onSelect: () => {
          const targetDir = getSelectedTargetFolder();
          setEditing({ kind: "new", parent: targetDir, nodeKind: "file", initial: ".js" });
        },
      },
      {
        id: "ts",
        label: "TypeScript File",
        icon: "file",
        onSelect: () => {
          const targetDir = getSelectedTargetFolder();
          setEditing({ kind: "new", parent: targetDir, nodeKind: "file", initial: ".ts" });
        },
      },
      {
        id: "rs",
        label: "Rust File",
        icon: "file",
        onSelect: () => {
          const targetDir = getSelectedTargetFolder();
          setEditing({ kind: "new", parent: targetDir, nodeKind: "file", initial: ".rs" });
        },
      },
      {
        id: "py",
        label: "Python File",
        icon: "file",
        onSelect: () => {
          const targetDir = getSelectedTargetFolder();
          setEditing({ kind: "new", parent: targetDir, nodeKind: "file", initial: ".py" });
        },
      },
      {
        id: "md",
        label: "Markdown File",
        icon: "file",
        onSelect: () => {
          const targetDir = getSelectedTargetFolder();
          setEditing({ kind: "new", parent: targetDir, nodeKind: "file", initial: ".md" });
        },
      },
    ];
  }, [t, startNewItem, getSelectedTargetFolder, onOpenFile]);

  // Tree 的受控选中按行 key（normalizeNodeKey 小写正斜杠）比对，picked 是原始大小写路径，
  // 必须先规范化，否则 Windows 盘符大写/反斜杠永远对不上，整棵树点不出选中态。
  const selectedSet = useMemo(() => new Set(picked.map((p) => normalizeNodeKey(p))), [picked]);

  return (
    <div
      ref={containerRef}
      className={styles.view}
      onKeyDown={handleContainerKeyDown}
    >
      {/* 顶部 Header 工具栏 (单层 1:1 工具视窗标准) */}
      <ProjectHeader
        mode={viewMode}
        onModeChange={setViewMode}
        options={options}
        onOptionsChange={setOptions}
        onLocate={() => {
          const target = activeFile || (openFiles && openFiles.length > 0 ? openFiles[0] : null);
              if (target) {
            revealPath(target, true);
          }
        }}
        locateDisabled={!activeFile && openFiles.length === 0}
        onExpandAll={() => {
          // BFS 逐层展开：深层目录还没读到 childrenMap 里，只收已加载层会漏；
          // 按队列加载（上限 400 个目录，对齐 openidea expandAll），加载完的下一轮补进展开集。
          const all = new Set<string>([normalizeNodeKey(root)]);
          for (const k of treeModel.childrenMap.keys()) {
            all.add(k);
          }
          setExpanded(all);
          const queue = [...all];
          let loaded = 0;
          const step = () => {
            while (queue.length > 0 && loaded < 400) {
              const dir = queue.shift()!;
              if (isVirtualPath(dir) || children.has(pathKey(dir))) continue;
              loaded += 1;
              load(dir);
              return;
            }
            if (queue.length > 0) {
              window.setTimeout(step, 50);
            }
          };
          // 已加载层的 children 到位后，treeModel 会把新目录填进 childrenMap——
          // 轮询把新出现的目录 key 补进展开集与队列。
          const poll = window.setInterval(() => {
            if (loaded >= 400) {
              window.clearInterval(poll);
              return;
            }
            for (const k of treeModel.childrenMap.keys()) {
              if (!all.has(k)) {
                all.add(k);
                setExpanded((prev) => new Set(prev).add(k));
                queue.push(k);
              }
            }
            step();
            if (queue.length === 0 && loaded > 0) {
              // 队列空了不代表加载完——等两轮没新目录再收
              window.clearInterval(poll);
            }
          }, 120);
        }}
        onCollapseAll={() => setExpanded(new Set([normalizeNodeKey(root)]))}
        onHide={onHide}
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
      />

      {/* 1:1 虚拟化树主体 */}
      <Tree<ProjectTreeNode>
        aria-label="Project"
        handleRef={treeHandleRef}
        roots={treeModel.roots}
        getKey={(n) => n.key}
        getLabel={(n) => n.displayName}
        getChildren={(n) => treeModel.childrenMap.get(n.key)}
        isExpandable={(n) => !!n.hasChildren}
        activateExpandable={true}
        renderNode={renderNode}
        expanded={expanded}
        onExpandedChange={handleExpandedChange}
        selected={selectedSet}
        onSelectionChange={handleSelectionChange}
        onActivate={handleActivate}
        onContextMenu={handleContextMenu}
        empty={
          <div className={styles.empty}>
            {t("project.view.empty") || "Nothing to show in this view"}
          </div>
        }
      />

      {/* 拖拽幽灵指示窗 */}
      {drag &&
        createPortal(
          <div
            className={styles.dragGhost}
            style={{ left: drag.x + 12, top: drag.y + 8 }}
            aria-hidden
          >
            <Icon name={drag.paths.length > 1 ? "list" : "file"} size={14} />
            <span>{drag.label}</span>
            {drag.copy && <Icon name="plus" size={12} />}
          </div>,
          document.body
        )}

      {/* Alt+Insert 快速新建浮窗 */}
      {newPopupOpen && (
        <NewPopup
          open={newPopupOpen}
          anchor={newPopupAnchor}
          items={newPopupItems}
          onClose={() => setNewPopupOpen(false)}
        />
      )}

      {/* 重构弹窗体系 (Rename / Move / Safe Delete) */}
      {refactorDialog && (
        <FileRefactorDialogs
          state={refactorDialog}
          onClose={() => {
            setRefactorDialog(null);
          }}
        />
      )}
    </div>
  );
}
