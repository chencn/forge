import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as TabKeyEvent,
  type KeyboardEvent as FieldKeyEvent,
  type ReactNode
} from "react";
import {
  ArrowUpRight,
  ChevronDown,
  Command,
  FileText,
  List,
  Loader2,
  Search
} from "lucide-react";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/lang/zh";
import type { ForgeCommand } from "../lib/commands";
import {
  findFiles,
  findSymbols,
  readFile,
  searchText,
  type ScanFilter,
  type SearchOptions,
  type TextHit,
  type TextPage
} from "../lib/fs";
import { ignoredRoots } from "../lib/git";
import { loadIgnored } from "../lib/ignoredCache";
import { indexRuns } from "../lib/seMatch";
import { parseLocationQuery } from "../lib/seQuery";
import { SeController, type SeSnapshot } from "../lib/seController";
import {
  MORE_STEP_ALL,
  MORE_STEP_TAB,
  TABS,
  buildRows,
  isSectionRow,
  parseCommand,
  stableIndex,
  topResultSettled,
  type SeRow,
  type SeTab,
  type SectionId
} from "../lib/seModel";
import {
  pushRecentAction,
  pushSearchHistory,
  recentActions,
  recentFiles,
  searchHistory
} from "../lib/seStore";
import { applyFontMetrics, detachedState, EditorView, highlightRange, scrollToPos } from "../lib/cmEditor";
import { languageForPath } from "../lib/editorEnv";
import { basenameOf, samePath } from "../lib/format";
import { ensureFileIcons } from "../lib/fileIcons";
import EntryIcon from "./EntryIcon";
import SymbolIcon from "./SymbolIcon";
import styles from "./SearchEverywhere.module.css";

/** 弹窗页签。openidea 的六档：全部 / 类 / 文件 / 符号 / 动作 / 文本。 */
export type SearchTab = SeTab;

const TAB_LABELS: Record<SeTab, TranslationKey> = {
  all: "search.tab.all",
  classes: "search.tab.classes",
  files: "search.tab.files",
  symbols: "search.tab.symbols",
  actions: "search.tab.actions",
  text: "search.tab.text"
};

const SECTION_LABELS: Record<SectionId, TranslationKey> = {
  recent: "search.section.recent",
  recentActions: "search.section.recentActions",
  classes: "search.tab.classes",
  files: "search.tab.files",
  symbols: "search.tab.symbols",
  actions: "search.tab.actions",
  text: "search.tab.text"
};

const ROW = 24;
const MAX_LIST = 672;
const MAX_LIST_PREVIEW = 312;
const MIN_LIST = 10 * ROW;
const TYPE_DELAY = 60;

export interface SearchEverywhereProps {
  /** 搜索范围：当前选中的目录（如用户右键的目录、在资源管理器高亮的目录）或工程根。 */
  root: string;
  /** 所有打开的项目根列表（多项目模式），用于在弹窗顶部展示和切换作用域。 */
  openFolders?: string[];
  /** 仓库根；与 root 不同时忽略项按仓库根折算，没有仓库时为 null。 */
  repoRoot: string | null;
  /** 显示隐藏项（Windows 隐藏属性 / 点开头），跟着设置里的资源管理器开关走。 */
  showHidden: boolean;
  /** 显示被 .gitignore 忽略的项；关着时忽略范围不搜。 */
  showIgnored: boolean;
  onClose: () => void;
  /** 打开一个文件；目录也走这一条，`isDir` 告诉外面它没有正文可开。`side` 要新的拆分。 */
  onOpenFile: (path: string, isDir: boolean, side?: boolean) => void;
  /** 打开一处正文命中，并把这一整页结果交给底部的查找窗口。`side` 要新的拆分。 */
  onOpenHit: (hit: TextHit, page: TextPage, options: SearchOptions, side?: boolean) => void;
  /** 打开一处符号定义：落到那一行并把名字选住。 */
  onOpenSymbol: (path: string, line: number, column: number, length: number, side?: boolean) => void;
  /** 打开时停在哪个页签。IDEA 的 Goto File 不是另一个框，是同一弹层落在 Files 页签上。 */
  initialTab?: SearchTab;
  /** 预填的搜索词，取的是编辑器选区，对应 IDEA 的 `PREDEFINED_TEXT`。 */
  initialQuery?: string;
  /** 可执行动作表（命令面板的数据源）；「动作」档与最近动作都从它取。 */
  commands?: ForgeCommand[];
}

interface Selection {
  key: string | null;
  index: number;
  moved: boolean;
}

/** 文本高亮组件：将匹配到的字符区间使用带有背景色的高亮标签渲染。 */
function HighlightedText({ text, indices }: { text: string; indices?: readonly number[] | null }) {
  if (!indices || indices.length === 0) {
    return <span>{text}</span>;
  }
  const parts: ReactNode[] = [];
  let pos = 0;
  for (const [s, e] of indexRuns(indices)) {
    if (s >= text.length) break;
    if (s > pos) parts.push(text.slice(pos, s));
    parts.push(
      <mark key={s} className={styles.matchHighlight}>
        {text.slice(s, e)}
      </mark>
    );
    pos = e;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return <span>{parts}</span>;
}

/** 代码预览面板：使用 CodeMirror 渲染只读文件内容，并在高亮命中行居中定位。 */
function CodePreviewPane({
  path,
  line
}: {
  path: string | null;
  line: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setContent(null);
      setError(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      readFile(path)
        .then((file) => {
          if (alive) {
            setContent(file.contents);
            setError(null);
          }
        })
        .catch((err) => {
          if (alive) {
            setContent(null);
            setError(String(err));
          }
        });
    }, 60);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [path]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || content === null || !path) {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
      return;
    }
    applyFontMetrics(el, 12);
    const targetLine = Math.max(1, line);
    const state = detachedState(
      {
        path,
        contents: content,
        language: languageForPath(path),
        readOnly: true,
        tabSize: 2,
        showLineNumbers: true
      },
      [highlightRange(targetLine, targetLine)]
    );
    const view = new EditorView({ state, parent: el });
    viewRef.current = view;

    try {
      const pos = state.doc.line(Math.min(targetLine, state.doc.lines)).from;
      scrollToPos(view, pos);
    } catch {
      // 容错防止行越界
    }

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [content, path, line]);

  const hasDoc = !!path && content !== null;
  const placeholder = !path ? "选择条目以预览代码" : error && !hasDoc ? error : null;

  return (
    <div className={styles.preview} role="region" aria-label="代码预览">
      <div
        ref={hostRef}
        className={`${styles.previewEditor}${!hasDoc || placeholder ? ` ${styles.previewHidden}` : ""}`}
      />
      {placeholder && <div className={styles.previewEmpty}>{placeholder}</div>}
    </div>
  );
}

/** 判断两条文本命中是否在同一个文件（若是则弱化第二条的文件名展示） */
function sameFile(prev: SeRow | undefined, row: SeRow): boolean {
  return row.kind === "text" && prev?.kind === "text" && prev.path === row.path;
}

/**
 * 随处搜索（Search Everywhere）
 * 100% 对齐 openidea everywhere 交互与布局体系：
 * - 顶栏：TabList、Scope 下拉、Preview 切换、Filter、转到底部 Find 窗口；
 * - 搜索行：放大镜历史下拉、自适应无边框输入框、Spinner 与提示；
 * - 列表区：分节渲染、多类型条目高亮、同文件合并、底部键盘导航；
 * - 预览区：支持 CodeMirror 代码语法高亮与行居中滚动；
 * - 多项目处理：精准定位至当前选中目录，并支持在各个工程与当前目录间秒切。
 */
export default function SearchEverywhere({
  root,
  openFolders = [],
  repoRoot,
  showHidden,
  showIgnored,
  onClose,
  onOpenFile,
  onOpenHit,
  onOpenSymbol,
  initialTab,
  initialQuery,
  commands
}: SearchEverywhereProps) {
  const { t } = useI18n();
  const [tab, setTabState] = useState<SeTab>(initialTab ?? "all");
  const [query, setQueryState] = useState(initialQuery ?? "");
  const [debounced, setDebounced] = useState(initialQuery ?? "");
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const [preview, setPreview] = useState(false);

  // 针对多项目多目录：当前生效的搜索目录（默认取外部传入的精确选中目录 root）
  const [activeRoot, setActiveRoot] = useState<string>(root);

  useEffect(() => {
    setActiveRoot(root);
  }, [root]);

  // 作用域候选项列表（当前选中目录、所有已打开工程根）
  const scopeOptions = useMemo(() => {
    const list: Array<{ value: string; label: string }> = [];
    const rootName = basenameOf(activeRoot) || activeRoot;
    list.push({ value: activeRoot, label: `当前目录: ${rootName}` });

    for (const folder of openFolders) {
      if (!samePath(folder, activeRoot)) {
        list.push({ value: folder, label: `工程: ${basenameOf(folder) || folder}` });
      }
    }
    return list;
  }, [activeRoot, openFolders]);

  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [extra, setExtra] = useState<Partial<Record<SectionId, number>>>({});
  const [snap, setSnap] = useState<SeSnapshot | null>(null);
  const [sel, setSel] = useState<Selection>({ key: null, index: -1, moved: false });

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const history = useRef({ pos: -1, draft: "" });
  const pendingEnter = useRef<{ side: boolean } | null>(null);

  const filter = useMemo<ScanFilter>(() => ({ showHidden, ignored }), [showHidden, ignored]);

  // 载入 Git 忽略前缀缓存
  useEffect(() => {
    if (showIgnored || !repoRoot) {
      setIgnored([]);
      return;
    }
    let stale = false;
    void loadIgnored(repoRoot)
      .then((list) => {
        if (!stale) setIgnored(ignoredRoots(repoRoot, list));
      })
      .catch(() => {
        if (!stale) setIgnored([]);
      });
    return () => {
      stale = true;
    };
  }, [repoRoot, showIgnored]);

  // 动态引用：让控制器每次搜索时现取最新的当前选中目录、命令集和过滤闸门
  const live = useRef({ root: activeRoot, commands, filter });
  live.current = { root: activeRoot, commands, filter };

  const [controller] = useState(
    () =>
      new SeController(
        {
          findFiles: (needle, limit, gate) =>
            findFiles(live.current.root, needle, limit, gate).then((hits) => hits.items),
          findSymbols: (needle, kindFilter, limit, gate) =>
            findSymbols(live.current.root, needle, kindFilter, limit, gate).then((hits) => hits.items),
          searchText: (textOptions, gate) =>
            searchText(live.current.root, textOptions, gate),
          actions: () => live.current.commands ?? [],
          recentFiles: () => recentFiles(live.current.root),
          recentActions,
          root: () => live.current.root,
          now: () => performance.now()
        },
        setSnap
      )
  );

  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    // 随处搜索打开时立即预热文件图标资源，杜绝占位闪烁
    void ensureFileIcons();
  }, []);

  // 键入防抖
  useEffect(() => {
    if (query === debounced) return;
    const timer = setTimeout(() => setDebounced(query), TYPE_DELAY);
    return () => clearTimeout(timer);
  }, [query, debounced]);

  // 查询词或页签切换时，重置分页与选区
  const [prevInputs, setPrevInputs] = useState({ debounced, tab, activeRoot });
  if (
    prevInputs.debounced !== debounced ||
    prevInputs.tab !== tab ||
    prevInputs.activeRoot !== activeRoot
  ) {
    setPrevInputs({ debounced, tab, activeRoot });
    setExtra({});
    setSel({ key: null, index: -1, moved: false });
  }

  const getTabLabel = (targetTab: SeTab) => t(TAB_LABELS[targetTab]);

  const listing = useMemo(() => {
    const c = parseCommand(query, getTabLabel);
    return c?.kind === "list" ? c.rows : null;
  }, [query]);
  const searchQuery = parseCommand(debounced, getTabLabel)?.kind === "list" ? "" : debounced;

  useEffect(() => {
    controller.run({
      query: searchQuery,
      tab,
      includeIgnored,
      filter,
      text: { caseSensitive: false, wholeWords: false, regex: false },
      extra
    });
  }, [controller, searchQuery, tab, includeIgnored, filter, extra, activeRoot]);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const parsed = useMemo(() => parseLocationQuery(searchQuery), [searchQuery]);
  const mix = tab === "all" ? parsed.text : undefined;
  const rows = useMemo(
    () => listing ?? (snap ? buildRows(snap.sections, { headers: !parsed.text.trim(), mix }) : []),
    [listing, snap, parsed.text, mix]
  );
  const active = stableIndex(rows, sel.key, sel.index, sel.moved);
  const activeRow = active >= 0 ? rows[active] : undefined;
  const settled =
    !!snap &&
    query === debounced &&
    snap.query === debounced &&
    snap.tab === tab &&
    topResultSettled(snap.sections, mix);

  const select = (index: number) => setSel({ key: rows[index]?.key ?? null, index, moved: true });

  const setQuery = (value: string) => {
    history.current.pos = -1;
    const c = parseCommand(value, getTabLabel);
    if (c?.kind === "run") {
      setTabState(c.tab);
      setQueryState(c.rest);
    } else {
      setQueryState(value);
    }
  };

  const browseHistory = (dir: 1 | -1) => {
    const entries = searchHistory(tab);
    const current = history.current;
    const pos = Math.max(-1, Math.min(entries.length - 1, current.pos + dir));
    if (pos === current.pos) return;
    if (current.pos < 0) current.draft = query;
    current.pos = pos;
    setQueryState(pos < 0 ? current.draft : entries[pos]!);
  };

  const setTab = (next: SeTab) => {
    history.current.pos = -1;
    setTabState(next);
    inputRef.current?.focus();
  };

  const cycleTab = (dir: 1 | -1) => {
    const at = TABS.findIndex((item) => item.id === tab);
    setTab(TABS[(at + dir + TABS.length) % TABS.length]!.id);
  };

  const closeThen = (fn: () => void) => {
    onClose();
    setTimeout(fn, 0);
  };

  const activate = (row: SeRow | undefined, side = false) => {
    if (!row) return;
    if (row.kind === "file" || row.kind === "symbol" || row.kind === "text" || row.kind === "action") {
      pushSearchHistory(tab, query);
    }
    switch (row.kind) {
      case "section":
        return;
      case "command":
        setTab(row.tab);
        setQueryState("");
        return;
      case "more": {
        const step = tab === "all" ? MORE_STEP_ALL : MORE_STEP_TAB;
        setExtra((prev) => ({ ...prev, [row.section]: (prev[row.section] ?? 0) + step }));
        setSel({ key: null, index: rows.indexOf(row), moved: true });
        return;
      }
      case "file":
        closeThen(() => onOpenFile(row.path, row.isDir, side));
        return;
      case "symbol":
        closeThen(() => onOpenSymbol(row.path, row.line, row.col, row.name.length, side));
        return;
      case "text": {
        const page = snap?.textPage;
        if (!page) return;
        closeThen(() => onOpenHit(row.hit, page, { caseSensitive: false, wholeWords: false, regex: false }, side));
        return;
      }
      case "action": {
        pushRecentAction(row.id);
        const cmd = commands?.find((c) => c.id === row.id);
        if (cmd) closeThen(() => cmd.run());
        return;
      }
    }
  };

  useEffect(() => {
    const pending = pendingEnter.current;
    if (!pending || !settled) return;
    pendingEnter.current = null;
    activate(activeRow, pending.side);
  });

  const onFieldKey = (event: FieldKeyEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      onClose();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      cycleTab(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.altKey && /^[1-6]$/.test(event.key)) {
      event.preventDefault();
      setTab(TABS[Number(event.key) - 1]!.id);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (listing) activate(activeRow);
      else if (!settled && !sel.moved) pendingEnter.current = { side: event.shiftKey };
      else activate(activeRow, event.shiftKey);
      return;
    }
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      browseHistory(event.key === "ArrowUp" ? 1 : -1);
      return;
    }
    if (["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(event.key)) {
      const dir = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "PageDown" ? 5 : -5;
      event.preventDefault();
      let next = active + dir;
      while (next >= 0 && next < rows.length && isSectionRow(rows[next]!)) {
        next += dir > 0 ? 1 : -1;
      }
      if (next >= 0 && next < rows.length) select(next);
    }
  };

  const onTabKey = (event: TabKeyEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    cycleTab(event.key === "ArrowRight" ? 1 : -1);
  };

  // 滚动可视区域跟踪
  useEffect(() => {
    const list = listRef.current;
    const item = list?.children[active] as HTMLElement | undefined;
    if (!list || !item) return;
    if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
    }
  }, [active]);

  const emptyQuery = !parsed.text.trim();
  const loading = !!snap?.loading;
  const showEmpty = !rows.length && !!snap && !loading && (!emptyQuery || tab !== "all");

  const listHeight = Math.min(
    preview ? MAX_LIST_PREVIEW : MAX_LIST,
    Math.max(parsed.text.trim() && !listing ? MIN_LIST : 0, rows.length * ROW)
  );

  const canSplit =
    activeRow?.kind === "file" || activeRow?.kind === "symbol" || activeRow?.kind === "text";

  const previewTarget = useMemo(() => {
    if (!preview || !activeRow) return null;
    if (activeRow.kind === "file") return { path: activeRow.path, line: activeRow.line ?? 1 };
    if (activeRow.kind === "symbol") return { path: activeRow.path, line: activeRow.line };
    if (activeRow.kind === "text") return { path: activeRow.path, line: activeRow.line };
    return null;
  }, [preview, activeRow]);

  const describeCurrentRow = (row: SeRow | undefined): string => {
    if (!row) return "";
    switch (row.kind) {
      case "section":
      case "more":
      case "command":
        return "";
      case "action":
        return row.title;
      case "file":
        return row.dir ? `${row.dir}/${row.name}` : row.name;
      case "symbol":
        return `${row.dir ? `${row.dir}/${row.file}` : row.file}:${row.line}`;
      case "text":
        return `${row.dir ? `${row.dir}/${row.name}` : row.name}:${row.line}`;
    }
  };

  return (
    <div
      className={styles.backdrop}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={t("search.title")}>
        {/* 顶部 Header：Tabs 胶囊与右侧 Actions（完全对齐 openidea） */}
        <div className={styles.header}>
          <div role="tablist" aria-label={t("search.title")} className={styles.tabs} onKeyDown={onTabKey}>
            {TABS.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                tabIndex={tab === item.id ? 0 : -1}
                className={`${styles.tab}${tab === item.id ? ` ${styles.tabActive}` : ""}`}
                title={`${t(TAB_LABELS[item.id])} (Alt+${index + 1})`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setTab(item.id)}
              >
                {t(TAB_LABELS[item.id])}
              </button>
            ))}
          </div>

          <div className={styles.headerActions}>
            {/* 对齐 openidea：All 或 Actions 页签显示 Checkbox，其余页签显示 Scope 下拉 */}
            {tab === "all" || tab === "actions" ? (
              <label className={styles.include}>
                <input
                  type="checkbox"
                  checked={includeIgnored}
                  onChange={(e) => {
                    setIncludeIgnored(e.target.checked);
                    inputRef.current?.focus();
                  }}
                />
                <span>{tab === "actions" ? "包含已禁用动作" : "包含非工程项"}</span>
              </label>
            ) : (
              <select
                className={styles.scopeSelect}
                value={activeRoot}
                onChange={(e) => {
                  setActiveRoot(e.target.value);
                  inputRef.current?.focus();
                }}
                title="搜索作用域"
                aria-label="搜索作用域"
              >
                {scopeOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            )}

            {/* 代码预览切换小按钮（size="small" 20px） */}
            <button
              type="button"
              className={`${styles.headerButton}${preview ? ` ${styles.headerButtonActive}` : ""}`}
              title="代码预览"
              aria-pressed={preview}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setPreview((p) => !p)}
            >
              <List size={14} />
            </button>

            {/* 转到底部查找窗口小按钮 */}
            <button
              type="button"
              className={styles.headerButton}
              title="在查找工具窗口中打开 (Ctrl+Enter)"
              onClick={() => {
                if (snap?.textPage) {
                  closeThen(() =>
                    onOpenHit(
                      snap.textPage!.hits[0] ?? {
                        path: "",
                        name: "",
                        container: "",
                        line: 1,
                        snippetFrom: 1,
                        snippet: "",
                        ranges: []
                      },
                      snap.textPage!,
                      { caseSensitive: false, wholeWords: false, regex: false }
                    )
                  );
                } else {
                  setTab("text");
                }
              }}
            >
              <ArrowUpRight size={14} />
            </button>
          </div>
        </div>

        {/* 查询行：放大镜下拉历史 + 复合输入框 + Spinner + 提示 */}
        <div className={styles.queryRow}>
          <div className={styles.field}>
            <button
              type="button"
              className={styles.magnifier}
              title="搜索历史 (Alt+↑ / Alt+↓)"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setHistoryMenuOpen((o) => !o)}
            >
              <Search size={14} />
              <ChevronDown size={10} />
            </button>
            <input
              id="se-query"
              ref={inputRef}
              className={styles.query}
              value={query}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              role="combobox"
              aria-expanded
              aria-controls="se-results"
              aria-autocomplete="list"
              aria-label={t("search.title")}
              placeholder={t("search.placeholder")}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onFieldKey}
            />
            {loading && !emptyQuery ? (
              <Loader2 size={14} className={styles.spinner} aria-hidden />
            ) : null}
            <span className={styles.hint} aria-hidden>
              {tab === "all"
                ? "键入 / 查看命令"
                : tab === "text"
                ? "Ctrl+Enter 在查找工具窗口中打开"
                : "Enter 打开 · Shift+Enter 拆分打开"}
            </span>
          </div>
        </div>

        {/* 搜索历史浮层 */}
        {historyMenuOpen && (
          <div className={styles.historyMenu}>
            <div className={styles.historyHeader}>最近搜索记录</div>
            {searchHistory(tab).length > 0 ? (
              searchHistory(tab).map((h) => (
                <div
                  key={h}
                  className={styles.historyItem}
                  onClick={() => {
                    setQuery(h);
                    setHistoryMenuOpen(false);
                    inputRef.current?.focus();
                  }}
                >
                  {h}
                </div>
              ))
            ) : (
              <div className={styles.historyItem} style={{ color: "var(--fg-muted)" }}>
                无最近搜索
              </div>
            )}
          </div>
        )}

        {/* 结果列表区 */}
        {(rows.length > 0 || showEmpty) && (
          <div
            ref={listRef}
            id="se-results"
            className={styles.results}
            style={{ height: rows.length ? listHeight + 8 : undefined }}
          >
            {rows.map((row, idx) => {
              if (row.kind === "section") {
                return (
                  <div key={row.key} className={styles.section}>
                    {t(SECTION_LABELS[row.section])}
                  </div>
                );
              }
              if (row.kind === "more") {
                return (
                  <div
                    key={row.key}
                    className={`${styles.row} ${styles.more}`}
                    onClick={() => activate(row)}
                  >
                    … 展开更多 {t(SECTION_LABELS[row.section])}
                  </div>
                );
              }
              if (row.kind === "command") {
                return (
                  <div
                    key={row.key}
                    className={`${styles.row}${idx === active ? ` ${styles.rowActive}` : ""}`}
                    onClick={() => activate(row)}
                  >
                    <Search size={14} className={styles.icon} />
                    <span className={styles.main}>
                      <span className={styles.name}>{row.name}</span>
                    </span>
                    <span className={styles.right}>{row.label}</span>
                  </div>
                );
              }

              const isSelected = idx === active;

              if (row.kind === "file") {
                return (
                  <div
                    key={row.key}
                    className={`${styles.row}${isSelected ? ` ${styles.rowActive}` : ""}`}
                    onClick={(e) => activate(row, e.shiftKey)}
                  >
                    <span className={styles.icon}>
                      <EntryIcon name={row.name} isDirectory={row.isDir} path={row.path} size={16} />
                    </span>
                    <span className={styles.main}>
                      <span className={styles.name}>
                        <HighlightedText text={row.name} indices={row.nameIndices} />
                        {row.line !== null ? (
                          <span className={styles.lineSuffix}>:{row.line}</span>
                        ) : null}
                      </span>
                      {row.dir ? <span className={styles.location}>{row.dir}</span> : null}
                    </span>
                  </div>
                );
              }

              if (row.kind === "symbol") {
                return (
                  <div
                    key={row.key}
                    className={`${styles.row}${isSelected ? ` ${styles.rowActive}` : ""}`}
                    onClick={(e) => activate(row, e.shiftKey)}
                  >
                    <span className={styles.icon}>
                      <SymbolIcon kind={row.symbolKind} size={16} />
                    </span>
                    <span className={styles.main}>
                      <span className={styles.name}>
                        <HighlightedText text={row.display} indices={row.indices} />
                      </span>
                      {row.dir ? (
                        <span className={styles.location}>{row.dir}</span>
                      ) : null}
                    </span>
                    <span className={styles.right}>{row.file}</span>
                  </div>
                );
              }

              if (row.kind === "action") {
                return (
                  <div
                    key={row.key}
                    className={`${styles.row}${isSelected ? ` ${styles.rowActive}` : ""}`}
                    onClick={() => activate(row)}
                  >
                    <span className={styles.icon}>
                      <Command size={14} />
                    </span>
                    <span className={styles.main}>
                      <span className={styles.name}>
                        <HighlightedText text={row.title} indices={row.indices} />
                      </span>
                    </span>
                    {row.shortcut ? <span className={styles.right}>{row.shortcut}</span> : null}
                  </div>
                );
              }

              if (row.kind === "text") {
                const repeat = sameFile(rows[idx - 1], row);
                return (
                  <div
                    key={row.key}
                    className={`${styles.row}${isSelected ? ` ${styles.rowActive}` : ""}`}
                    onClick={(e) => activate(row, e.shiftKey)}
                  >
                    <span className={styles.icon}>
                      <FileText size={14} />
                    </span>
                    <span className={styles.main}>
                      <HighlightedText text={row.text} indices={row.indices} />
                    </span>
                    <span className={`${styles.right}${isSelected ? ` ${styles.rightActive}` : ""}`}>
                      <span className={repeat && !isSelected ? styles.repeat : undefined}>
                        {row.name}
                      </span>{" "}
                      :{row.line}
                    </span>
                  </div>
                );
              }

              return null;
            })}

            {showEmpty && (
              <div className={styles.empty}>
                {emptyQuery ? "键入关键字开始搜索" : "未在当前目录或项目中找到匹配结果"}
              </div>
            )}
          </div>
        )}

        {/* 下方代码预览窗格（对齐 openidea CodePreview） */}
        {preview && rows.length > 0 && (
          <CodePreviewPane path={previewTarget?.path ?? null} line={previewTarget?.line ?? 1} />
        )}

        {/* 底部页脚：显示选中条目信息与拆分打开链接 */}
        {rows.length > 0 && (
          <footer className={styles.footer}>
            <span className={styles.footerInfo}>{describeCurrentRow(activeRow)}</span>
            {canSplit && (
              <button
                type="button"
                className={styles.footerLink}
                onClick={() => activate(activeRow, true)}
                title="在右侧拆分中打开 (Shift+Enter)"
              >
                在右侧拆分中打开
              </button>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
