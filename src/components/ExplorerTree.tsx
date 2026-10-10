import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { errorText, listDirectory } from "../lib/fs";
import { describeError } from "../lib/errors";
import { useI18n } from "../i18n";
import type { FsEntry } from "../lib/fs";
import type { GitChange } from "../lib/git";
import { changeMark, folderMarks, gitIgnored, ignoredRoots, markClass } from "../lib/git";
import { isPackageSegment, isUnderJvmSourceRoot } from "../lib/jvm";
import EntryIcon from "./EntryIcon";

interface ExplorerTreeProps {
  /** 工作区根目录，树的顶层。 */
  root: string;
  /** 当前编辑器里的文件，用来高亮所在行。 */
  activePath: string | null;
  /** 仓库根；与 root 不同时相对路径按仓库根算。 */
  repoRoot: string | null;
  /** 仓库改动，用来在名字右侧画 M/A/D 标记。 */
  changes: GitChange[];
  /** 递增即折叠全部目录。 */
  collapseSignal: number;
  /**
   * 缓存作废的批次。`paths` 是这一批变更落在哪些路径上，只作废与它们相干的那些缓存；
   * `null` 表示整张表都不要了（git 操作、改名这类改了一片又说不清改了哪儿的）。
   */
  refresh: { paths: string[] | null; seq: number };
  /** 递增即把这一条在树里摊开、选中并滚到它。随处搜索的落点跟着它走。 */
  reveal: { path: string; seq: number } | null;
  /** 显示被 .gitignore 忽略的文件/目录。 */
  showIgnored: boolean;
  /** 显示隐藏文件（Windows 隐藏属性 / 点开头）。 */
  showHidden: boolean;
  /** 选中集里的路径，按点击先后排；状态提在 App，右键菜单和键位都读同一份。 */
  picked: string[];
  onPick: (entries: FsEntry[]) => void;
  onOpenFile: (entry: FsEntry) => void;
  /** 选中的那一批连同位置交给 App 摆菜单；空数组表示右键落在树的空白处。 */
  onContextMenu: (selection: FsEntry[], position: { x: number; y: number }) => void;
}

/** 比较用的路径键：分隔符折成 `/`、大小写折叠，Windows 上后端给的两条写法才比得齐。 */
function pathKey(path: string) {
  return path.replaceAll("\\", "/").toLocaleLowerCase();
}

/**
 * 这一份缓存跟这批变更有没有干系。
 *
 * 两种算有：缓存的那个目录是变更路径的祖先或就是它本身（里面少了一个、多了一个、属性变了），
 * 或者缓存的目录整个落在某条变更路径之下（那是一条目录被改名或删掉）。
 */
function touched(key: string, changed: string) {
  const a = pathKey(key);
  const b = pathKey(changed);
  return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

/**
 * 缓存作废的节流转：构建期间每 150-270 ms 就来一批磁盘事件，一批一起清整张表的话，
 * 每个展开中的目录每批都要重发一次 `list_directory`，读盘的总量跟着展开数往上翻。
 * 改成只清与这批路径相干的那些，一次构建通常只碰到 `target` 底下那几个。
 */
const IGNORE_DEBOUNCE_MS = 800;

/** 展开过的目录；折叠时保留记录，再展开不用重新读盘。 */
function useLazyChildren(refresh: { paths: string[] | null; seq: number }, onError: (message: string) => void) {
  const [children, setChildren] = useState<Map<string, FsEntry[]>>(new Map());
  const [failed, setFailed] = useState<Map<string, string>>(new Map());

  const load = useCallback(
    async (path: string) => {
      if (children.has(path) || failed.has(path)) return;
      try {
        const listing = await listDirectory(path);
        setChildren((current) => new Map(current).set(path, listing.entries));
      } catch (cause) {
        setFailed((current) => new Map(current).set(path, errorText(cause)));
        onError(errorText(cause));
      }
    },
    [children, failed, onError]
  );

  useEffect(() => {
    const drop = <T,>(current: Map<string, T>) => {
      if (refresh.paths === null) return new Map<string, T>();
      const doomed = [...current.keys()].filter((key) =>
        refresh.paths!.some((changed) => touched(key, changed))
      );
      if (doomed.length === 0) return current;
      const next = new Map(current);
      for (const key of doomed) next.delete(key);
      return next;
    };
    setChildren(drop);
    setFailed(drop);
  }, [refresh]);

  return { children, failed, load };
}

/**
 * 拉取被 .gitignore 忽略的路径，返回一个「这个绝对路径是否被忽略」的判定函数。
 *
 * 后端 `git status --ignored=matching` 只回**顶层**忽略项（如 `node_modules/`），
 * 不含它下面的每个文件；所以判定不能只比相等，得看这一行是不是落在某个忽略项之下。
 * 目录与文件用同一套判定：忽略目录下的所有内容都算忽略。
 *
 * 这一条要起一个走完整棵工作树的 git 进程，所以不跟着每批磁盘事件即时发：
 * 事件停手之后再补一次，读到的是最终状态，构建全程不会一直在扫。
 */
function useIgnoredPaths(
  repoRoot: string | null,
  refreshSignal: number,
  /** 只有真要把忽略项藏起来时才需要这一份；「显示忽略项」开着的时候不用问。 */
  needed: boolean
) {
  const [patterns, setPatterns] = useState<string[]>([]);

  useEffect(() => {
    if (!repoRoot || !needed) {
      setPatterns([]);
      return;
    }
    let stale = false;
    const timer = window.setTimeout(() => {
      void gitIgnored(repoRoot)
        .then((list) => {
          if (!stale) setPatterns(list);
        })
        .catch(() => {
          // 纯浏览器预览时没有这条命令，忽略项就都按没忽略画。
        });
    }, IGNORE_DEBOUNCE_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [repoRoot, refreshSignal, needed]);

  return useMemo(() => {
    if (!repoRoot || patterns.length === 0) return () => false;
    const roots = ignoredRoots(repoRoot, patterns);
    return (absolute: string) => {
      const key = absolute.replaceAll("\\", "/").toLocaleLowerCase();
      return roots.some((dir) => key === dir || key.startsWith(`${dir}/`));
    };
  }, [patterns, repoRoot]);
}

interface Row {
  entry: FsEntry;
  /** 显示名。JVM 包链合并后是 `com.example.demo`，普通单子目录链是 `a/b`。 */
  displayName: string;
  /** 这一行展开时要读的目录：合并链的最深那一层。 */
  deepest: string;
  depth: number;
}

export default function ExplorerTree({
  root,
  activePath,
  repoRoot,
  changes,
  collapseSignal,
  refresh,
  reveal,
  picked,
  showIgnored,
  showHidden,
  onPick,
  onOpenFile,
  onContextMenu,
}: ExplorerTreeProps) {
  const [error, setError] = useState<string | null>(null);
  const onError = useCallback((message: string) => setError(message), []);
  const { t } = useI18n();
  const { children, failed, load } = useLazyChildren(refresh, onError);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const treeRef = useRef<HTMLDivElement>(null);
  /** 正在往哪儿定位；目标行没露出来之前一直挂着。 */
  const [revealTo, setRevealTo] = useState<string | null>(null);
  /** 被 .gitignore 忽略的路径判定；命中的行文字变橙棕色（对齐 IDEA）。 */
  const isIgnored = useIgnoredPaths(repoRoot, refresh.seq, !showIgnored);

  useEffect(() => {
    setExpanded(new Set());
  }, [root, collapseSignal]);

  useEffect(() => {
    if (reveal) setRevealTo(reveal.path);
  }, [reveal]);

  /** 文件标记与目录聚合标记，键都是「绝对路径小写 + 正斜杠」，供行的染色与圆点查询。 */
  const { markOf, dotOf } = useMemo(() => {
    const files = new Map<string, string>();
    const dirs = new Map<string, string>();
    if (!repoRoot) return { markOf: files, dotOf: dirs };
    const prefix = repoRoot.replace(/[\\/]+$/, "");
    const key = (relative: string) =>
      `${prefix}/${relative}`.replaceAll("\\", "/").toLocaleLowerCase();
    for (const change of changes) files.set(key(change.path), changeMark(change));
    for (const [dir, mark] of folderMarks(changes)) dirs.set(key(dir), mark);
    return { markOf: files, dotOf: dirs };
  }, [changes, repoRoot]);

  /** 这一条按当前视图选项该不该出现：隐藏文件与忽略文件各由一个开关管。 */
  const visible = (entry: FsEntry) => {
    if (!showHidden && entry.isHidden) return false;
    if (!showIgnored && isIgnored(entry.path)) return false;
    return true;
  };

  /**
   * 沿 JVM 包链合并：一个目录若在源码根之下、没有可见文件、只有一个合法包子目录，
   * 就并进子目录显示成 `com.example.demo`。链只到缓存读得到的地方，没读到的层由下面的
   * 预读 effect 补上，补完再算一次。
   */
  const collapseChain = (start: FsEntry): { displayName: string; deepest: string } => {
    let name = start.name;
    let deepest = start.path;
    while (isUnderJvmSourceRoot(deepest)) {
      const kids = (children.get(deepest) ?? []).filter(visible);
      const dirs = kids.filter((entry) => entry.kind === "directory");
      if (kids.length === 1 && dirs.length === 1 && isPackageSegment(dirs[0].name)) {
        name = `${name}.${dirs[0].name}`;
        deepest = dirs[0].path;
      } else {
        break;
      }
    }
    return { displayName: name, deepest };
  };

  const rows: Row[] = [];
  const walk = (path: string, depth: number) => {
    for (const entry of children.get(path) ?? []) {
      // 过滤掉的目录连整棵子树一起藏，不然会看见孤零零的子项。
      if (!visible(entry)) continue;
      // 目录走包链合并；文件原样。
      const chain =
        entry.kind === "directory"
          ? collapseChain(entry)
          : { displayName: entry.name, deepest: entry.path };
      rows.push({ entry, displayName: chain.displayName, deepest: chain.deepest, depth });
      if (entry.kind === "directory" && expanded.has(chain.deepest)) {
        walk(chain.deepest, depth + 1);
      }
    }
  };
  walk(root, 0);

  /**
   * 预读包链：可见目录若在源码根之下，沿单子目录链逐层读下去，直到分叉或读到文件。
   * 每次加载一层就重算一次，链会收敛；读失败时 load 自己会跳过，不会死循环。
   */
  useEffect(() => {
    const pending = new Set<string>();
    const consider = (startPath: string) => {
      let current = startPath;
      while (isUnderJvmSourceRoot(current)) {
        const kids = children.get(current);
        if (!kids) {
          pending.add(current);
          return;
        }
        const vis = kids.filter(visible);
        const dirs = vis.filter((entry) => entry.kind === "directory");
        if (vis.length === 1 && dirs.length === 1 && isPackageSegment(dirs[0].name)) {
          current = dirs[0].path;
        } else {
          return;
        }
      }
    };
    for (const { entry } of rows) {
      if (entry.kind === "directory" && isUnderJvmSourceRoot(entry.path)) consider(entry.path);
    }
    for (const path of pending) void load(path);
  }, [children, expanded, root, showHidden, showIgnored]);

  /** 把路径换成还看得见的那些条目：选中集里可能留着刚删掉的，或者父目录已经折叠起来的。 */
  const resolve = (paths: string[]) => {
    const byPath = new Map(rows.map((row) => [row.entry.path, row.entry]));
    return paths
      .map((path) => byPath.get(path))
      .filter((entry): entry is FsEntry => entry !== undefined);
  };

  /**
   * 单击只留这一条；Ctrl 加选或取消；Shift 按看得见的行连选。
   * 返回这一句改完之后的选中集，右键那一侧要立刻拿它摆菜单，不能等下一次渲染。
   */
  const pick = (entry: FsEntry, event: ReactMouseEvent): FsEntry[] => {
    let next: string[];
    if (event.ctrlKey || event.metaKey) {
      next = picked.includes(entry.path)
        ? picked.filter((path) => path !== entry.path)
        : [...picked, entry.path];
    } else if (event.shiftKey) {
      const anchor = rows.findIndex((row) => row.entry.path === picked[picked.length - 1]);
      const here = rows.findIndex((row) => row.entry.path === entry.path);
      const [lo, hi] = anchor <= here ? [anchor, here] : [here, anchor];
      next =
        anchor >= 0 && here >= 0
          ? rows.slice(lo, hi + 1).map((row) => row.entry.path)
          : [entry.path];
    } else {
      next = [entry.path];
    }
    const entries = resolve(next);
    onPick(entries);
    return entries;
  };

  /** 展开/折叠一个目录，键是目录绝对路径（包链合并后用链末那层）。 */
  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  /** 只往开里改，已经展开的不动它：重复触发不会把折叠状态顶掉。 */
  const openDir = (path: string) => {
    setExpanded((current) => (current.has(path) ? current : new Set(current).add(path)));
  };

  /**
   * 定位一次只往前推一层：目标行露出来就选中并滚过去，没露出来就把还没展开的那层祖先
   * 摊开，等它的子节点读回来再算一遍。祖先判定比的是 `deepest`——包链合并后一行代表好几层，
   * 展开键是链末那层。
   *
   * 三条收工的路径：这条路径不在工程根下、它被「显示隐藏 / 显示忽略」两个开关挡在外面、
   * 或者祖先都读完了却没有它（刚被删掉）。都只停手不报错，搜索那边刚从同一张盘上扫出它，
   * 再报一遍只会把弹层刚关掉的界面弄脏。
   *
   * 这个 effect 不挂依赖数组：`rows` 是每次渲染现算的，挂不上，而每一层进展都要重算一次才知道
   * 走没走到头。挂着 `revealTo` 为空就立刻返回，平时不做事。
   */
  useEffect(() => {
    const target = revealTo;
    if (!target) return;
    const key = pathKey(target);
    const base = pathKey(root);
    if (key !== base && !key.startsWith(`${base}/`)) {
      setRevealTo(null);
      return;
    }

    // 包链那一行替它中间每一层露面：目标落在链里时，认的就是这一行。
    const covers = (row: Row) => {
      const start = pathKey(row.entry.path);
      if (start === key) return true;
      if (row.entry.kind !== "directory" || !key.startsWith(`${start}/`)) return false;
      return pathKey(row.deepest).startsWith(key);
    };

    const here = rows.findIndex(covers);
    if (here >= 0) {
      const row = rows[here];
      // 目录结果没有正文可开，落点就是把它摊开看一眼。
      if (row.entry.kind === "directory") openDir(row.deepest);
      treeRef.current?.children[here]?.scrollIntoView({ block: "nearest" });
      onPick([row.entry]);
      setRevealTo(null);
      return;
    }

    const ancestors = rows
      .filter(
        (row) => row.entry.kind === "directory" && key.startsWith(`${pathKey(row.deepest)}/`)
      )
      .sort((a, b) => b.deepest.length - a.deepest.length);
    const next = ancestors.find((row) => !expanded.has(row.deepest));
    if (next) {
      openDir(next.deepest);
      return;
    }
    // 祖先都点开了但还在读盘，等 children 到位再算。
    if (ancestors.some((row) => !children.has(row.deepest))) return;
    // 能摊的都摊开、该读的都读回来了，这一层里却没有它：被「显示隐藏 / 显示忽略」挡在
    // 外面，或者刚被删掉。收工。
    setRevealTo(null);
  });

  // 根目录和每个展开中的目录，只要缓存里没有就读一次；refreshSignal 会同时作废两边。
  useEffect(() => {
    void load(root);
    for (const path of expanded) void load(path);
  }, [expanded, load, root]);

  return (
    <div
      className="tree"
      ref={treeRef}
      role="tree"
      aria-label="Explorer"
      onContextMenu={(event) => {
        // 落在任何一行上都不管，那一行自己的处理器会带着选中集来。
        // 判据用 closest 而不是「是不是这个容器本身」：行外面还套着 role=none 的包装层，
        // 严格比 target 会把包链行上的右键也当成空白处。
        if (event.target instanceof Element && event.target.closest(".tree-row")) return;
        event.preventDefault();
        onContextMenu([], { x: event.clientX, y: event.clientY });
      }}
    >
      {rows.map(({ entry, displayName, deepest, depth }) => {
        const isDirectory = entry.kind === "directory";
        // 展开态跟着包链最深那层：合并后的行点开读到的是链末，再展开才是子包。
        const open = isDirectory && expanded.has(deepest);
        const marked = picked.includes(entry.path);
        const lower = pathKey(entry.path);
        // 文件取自身字母标记；目录取子孙聚合标记，画成圆点。
        const mark = isDirectory ? null : markOf.get(lower);
        const dot = isDirectory ? dotOf.get(lower) : undefined;
        const ignored = isIgnored(entry.path);
        // 链末落在 JVM 源码根之下的是包节点，用包图标。
        const isPackage = isDirectory && isUnderJvmSourceRoot(deepest);
        return (
          <div key={entry.path} role="none">
            <div
              role="treeitem"
              aria-selected={marked || activePath === entry.path}
              aria-expanded={isDirectory ? open : undefined}
              className={[
                "tree-row",
                activePath === entry.path ? "is-active" : "",
                marked ? "is-picked" : "",
                entry.isHidden ? "is-hidden-item" : "",
                ignored ? "is-ignored-item" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ paddingLeft: 6 + depth * 13 }}
              onClick={(event) => {
                const selection = pick(entry, event);
                // 目录用链末路径做展开键，包链整体当作一个可展开节点。
                if (isDirectory) toggle(deepest);
                // 只有不带修饰键、选中集就这一条时才开文件：多选那几下不该塞出一串标签页。
                else if (selection.length === 1 && selection[0]?.path === entry.path) onOpenFile(entry);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                // 右键落在没选中的行上时，选中集先换成它自己，和 IDEA 一致。
                const selection = marked ? resolve(picked) : pick(entry, event);
                onContextMenu(selection, { x: event.clientX, y: event.clientY });
              }}
              title={entry.path}
            >
              {isDirectory ? (
                open ? (
                  <ChevronDown size={13} className="tree-chevron" aria-hidden="true" />
                ) : (
                  <ChevronRight size={13} className="tree-chevron" aria-hidden="true" />
                )
              ) : (
                <span className="tree-chevron" />
              )}
              <EntryIcon name={displayName} isDirectory={isDirectory} isPackage={isPackage} size={15} />
              <span className="tree-name">{displayName}</span>
              {mark ? <span className={`tree-mark ${markClass(mark)}`}>{mark}</span> : null}
              {dot ? (
                <span className={`change-dot ${markClass(dot)}`} aria-hidden="true" />
              ) : null}
            </div>
            {isDirectory && open && failed.has(entry.path) ? (
              <p className="tree-error" style={{ paddingLeft: 24 + depth * 13 }}>
                {describeError(failed.get(entry.path) ?? "", t)}
              </p>
            ) : null}
          </div>
        );
      })}
      {rows.length === 0 ? (
        <p className="tree-empty">
          {describeError(failed.get(root) ?? error ?? "—", t)}
        </p>
      ) : null}
    </div>
  );
}
