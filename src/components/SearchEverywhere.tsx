import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as FieldKeyEvent } from "react";
import { X } from "lucide-react";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/lang/zh";
import { describeError } from "../lib/errors";
import {
  errorText,
  findFiles,
  searchText,
  type FileHits,
  type ScanFilter,
  type SearchOptions,
  type TextHit,
  type TextPage,
} from "../lib/fs";
import { ignoredRoots } from "../lib/git";
import { loadIgnored } from "../lib/ignoredCache";
import EntryIcon from "./EntryIcon";
import MatchSnippet from "./MatchSnippet";

/** 弹窗上那三个页签。 */
export type SearchTab = "all" | "files" | "text";
type Tab = SearchTab;

const TABS: { key: Tab; label: TranslationKey }[] = [
  { key: "all", label: "search.tab.all" },
  { key: "files", label: "search.tab.files" },
  { key: "text", label: "search.tab.text" },
];

/** 列表里的一行：要么是个文件，要么是一处正文命中。 */
type Row =
  | {
      kind: "file";
      path: string;
      name: string;
      container: string;
      isDir: boolean;
      hit?: undefined;
    }
  | {
      kind: "text";
      path: string;
      name: string;
      container: string;
      isDir: boolean;
      hit: TextHit;
    };

/** 弹窗里正文只回这么多行：整页结果要点开底部那块工具窗口看。 */
const POPUP_TEXT_PAGE = 20;

/** 弹窗里文件只回这么多条。 */
const POPUP_FILE_PAGE = 20;

/** 打字途中不碰磁盘，停这么久而不发新查询。 */
const TYPE_DELAY = 260;

/** 少于这么多字符就什么都不搜，否则整棵树都被第一个字母刷一遍。 */
const MIN_QUERY = 2;

interface SearchEverywhereProps {
  /** 搜索范围：IDEA 的 Look in Directory，这边就是传给两条命令的那个根。 */
  root: string;
  /** 仓库根；与 root 不同时忽略项按仓库根折算，没有仓库时为 null。 */
  repoRoot: string | null;
  /** 显示隐藏项（Windows 隐藏属性 / 点开头），跟着设置里的资源管理器开关走。 */
  showHidden: boolean;
  /** 显示被 .gitignore 忽略的项；关着时忽略范围不搜。 */
  showIgnored: boolean;
  onClose: () => void;
  /** 打开一个文件；目录也走这一条，`isDir` 告诉外面它没有正文可开。 */
  onOpenFile: (path: string, isDir: boolean) => void;
  /** 打开一处正文命中，并把这一整页结果交给底部的查找窗口。 */
  onOpenHit: (hit: TextHit, page: TextPage, options: SearchOptions) => void;
  /** 打开时停在哪个页签。IDEA 的 Goto File 不是另一个框，是同一弹层落在 Files 页签上。 */
  initialTab?: SearchTab;
  /** 预填的搜索词，取的是编辑器选区，对应 IDEA 的 `PREDEFINED_TEXT`。 */
  initialQuery?: string;
}

/**
 * IDEA 的「随处搜索」：居中弹窗，上面页签、中间输入框、下面结果。
 *
 * 只有三处能关掉它：右上那颗关闭、Enter 或点开一条结果、Esc。点遮罩不关——
 * 输入到一半手滑点到旁边就把词丢了，这一下没人想要。IDEA 那边靠失焦关闭，
 * 这边没有「焦点离开整层」这条判定可依赖，就不拿点击当关闭。
 *
 * IDEA 那侧还有 Classes / Symbols / Actions 三档，靠的是它自己的符号索引和动作注册表；
 * 这边没有等价数据，就不摆一颗点了没反应的页签。
 */
export default function SearchEverywhere({
  root,
  repoRoot,
  showHidden,
  showIgnored,
  onClose,
  onOpenFile,
  onOpenHit,
  initialTab,
  initialQuery,
}: SearchEverywhereProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>(initialTab ?? "all");
  const [query, setQuery] = useState(initialQuery ?? "");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWords, setWholeWords] = useState(false);
  const [regex, setRegex] = useState(false);
  const [fileMask, setFileMask] = useState("");
  const [files, setFiles] = useState<FileHits | null>(null);
  const [page, setPage] = useState<TextPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  /** 被忽略项的绝对前缀；「显示忽略项」开着时为空表，不剪任何路径。 */
  const [ignored, setIgnored] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** 只认最后一次发出的查询，早发的那份回来晚了直接丢。 */
  const seq = useRef(0);

  const options = useMemo<SearchOptions>(
    () => ({ caseSensitive, wholeWords, regex, fileMask, limit: POPUP_TEXT_PAGE }),
    [caseSensitive, wholeWords, regex, fileMask]
  );

  /**
   * 取忽略前缀。弹层每次打开都是新实例，所以只取一次；「显示忽略项」开着时不必问，
   * 这一趟要走完整棵工作树的 git，能省则省。取不到（纯浏览器预览、没有仓库）就当没忽略。
   */
  useEffect(() => {
    if (showIgnored || !repoRoot) {
      setIgnored([]);
      return;
    }
    let stale = false;
    // 与目录树、Git 面板共用一份扫描结果：新鲜期内不另起 `git status --ignored` 全仓扫描。
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

  const filter = useMemo<ScanFilter>(
    () => ({ showHidden, ignored }),
    [showHidden, ignored]
  );

  const needle = query.trim();
  const searching = needle.length >= MIN_QUERY;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!searching) {
      setFiles(null);
      setPage(null);
      setFailed(null);
      setBusy(false);
      return;
    }
    const token = ++seq.current;
    setBusy(true);
    const timer = window.setTimeout(() => {
      const jobs: Promise<void>[] = [];
      if (tab !== "text") {
        jobs.push(
          findFiles(root, needle, POPUP_FILE_PAGE, filter)
            .then((result) => {
              if (seq.current === token) {
                setFiles(result);
                setFailed(null);
              }
            })
            .catch((error: unknown) => {
              if (seq.current === token) setFailed(errorText(error));
            })
        );
      }
      if (tab !== "files") {
        jobs.push(
          searchText(root, needle, options, filter)
            .then((result) => {
              if (seq.current === token) {
                setPage(result);
                setFailed(null);
              }
            })
            .catch((error: unknown) => {
              if (seq.current === token) {
                setPage(null);
                setFailed(describeError(errorText(error), t));
              }
            })
        );
      }
      void Promise.all(jobs).finally(() => {
        if (seq.current === token) setBusy(false);
      });
    }, TYPE_DELAY);
    return () => window.clearTimeout(timer);
  }, [filter, needle, options, root, searching, t, tab]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (tab !== "text") {
      for (const hit of files?.items ?? []) {
        out.push({
          kind: "file",
          path: hit.path,
          name: hit.name,
          container: hit.container,
          isDir: hit.isDir,
        });
      }
    }
    if (tab !== "files") {
      for (const hit of page?.hits ?? []) {
        out.push({
          kind: "text",
          path: hit.path,
          name: hit.name,
          container: hit.container,
          isDir: false,
          hit,
        });
      }
    }
    return out;
  }, [files, page, tab]);

  // 换页签或改关键词后行数会变，选中位要夹回来，否则回车落在空位上。
  useEffect(() => {
    setCaret((current) => (rows.length === 0 ? 0 : Math.min(current, rows.length - 1)));
  }, [rows.length]);

  const open = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      if (row.kind === "file") {
        onOpenFile(row.path, row.isDir);
        onClose();
        return;
      }
      if (page) onOpenHit(row.hit, page, options);
      onClose();
    },
    [onClose, onOpenFile, onOpenHit, options, page]
  );

  const step = (delta: number) => {
    setCaret((current) => (rows.length === 0 ? 0 : (current + delta + rows.length) % rows.length));
  };

  /** 选中行露出列表边缘时滚一下，只在键盘走的时候动。 */
  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[caret] as HTMLElement | undefined;
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  }, [caret]);

  const foot = () => {
    if (!searching) return t("search.hint.type");
    if (busy) return t("search.busy");
    const fileCount = files?.items.length ?? 0;
    const hitCount = page?.hits.length ?? 0;
    if (fileCount === 0 && hitCount === 0) return t("search.empty");
    const parts: string[] = [];
    if (tab !== "text" && fileCount > 0) {
      parts.push(t("search.count.files", { count: fileCount }));
      if (files?.truncated) parts.push(t("search.more.files"));
    }
    if (tab !== "files" && hitCount > 0) {
      parts.push(t("search.count.hits", { hits: hitCount, files: page?.files ?? 0 }));
      if (page?.truncated) parts.push(t("search.more.hits"));
    }
    return parts.join(" · ");
  };

  return (
    <div
      className="dialog-backdrop is-search"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        className="search-pop"
        role="dialog"
        aria-modal="true"
        aria-label={t("search.title")}
      >
        <div className="search-tabs" role="tablist">
          {TABS.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              className={`search-tab${tab === item.key ? " is-active" : ""}`}
              title={`${t(item.label)} · Alt+${index + 1}`}
              onClick={() => setTab(item.key)}
            >
              {t(item.label)}
            </button>
          ))}
          {/* 关闭那颗在页签这一行的右端，IDEA 的弹层标题行就是这个位置。 */}
          <button
            type="button"
            className="icon-button is-tiny search-close"
            onClick={onClose}
            title={t("window.close")}
            aria-label={t("window.close")}
          >
            <X size={15} />
          </button>
        </div>

        <div className="search-field">
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            placeholder={t(tab === "files" ? "search.placeholder.files" : "search.placeholder")}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onFieldKey}
          />
          {tab !== "files" ? (
            <div className="search-switches">
              <button
                type="button"
                className={`switch-chip${caseSensitive ? " is-on" : ""}`}
                aria-pressed={caseSensitive}
                title={t("search.option.case")}
                onClick={() => setCaseSensitive((on) => !on)}
              >
                Aa
              </button>
              <button
                type="button"
                className={`switch-chip${wholeWords ? " is-on" : ""}`}
                aria-pressed={wholeWords}
                title={t("search.option.words")}
                onClick={() => setWholeWords((on) => !on)}
              >
                W
              </button>
              <button
                type="button"
                className={`switch-chip${regex ? " is-on" : ""}`}
                aria-pressed={regex}
                title={t("search.option.regex")}
                onClick={() => setRegex((on) => !on)}
              >
                .*
              </button>
            </div>
          ) : null}
        </div>

        {tab !== "files" ? (
          <input
            className="search-mask"
            value={fileMask}
            placeholder={t("search.fileMask")}
            spellCheck={false}
            onChange={(event) => setFileMask(event.target.value)}
            onKeyDown={onFieldKey}
          />
        ) : null}

        <div className="search-list" ref={listRef} role="listbox" aria-label={t("search.title")}>
          {rows.map((row, index) => (
            <div
              key={`${row.kind}|${row.name}|${row.container}|${row.hit?.line ?? 0}`}
              role="option"
              aria-selected={index === caret}
              className={`search-row${index === caret ? " is-active" : ""}`}
              onMouseEnter={() => setCaret(index)}
              onClick={() => open(row)}
            >
              <EntryIcon name={row.name} path={row.isDir ? undefined : row.path} isDirectory={row.isDir} size={16} />
              <span className="search-row-main">
                {row.kind === "text" ? <MatchSnippet hit={row.hit} /> : row.name}
              </span>
              {row.container ? <span className="search-row-dir">{row.container}</span> : null}
              <span className="search-row-tag">
                {row.kind === "text" ? (
                  <>
                    {row.name}
                    <em>{row.hit.line}</em>
                  </>
                ) : (
                  t("search.tab.files")
                )}
              </span>
            </div>
          ))}
          {failed ? <p className="search-failed">{failed}</p> : null}
          {searching && !busy && rows.length === 0 && !failed ? (
            <p className="search-none">{t("search.empty")}</p>
          ) : null}
        </div>

        <div className="search-foot">
          <span>{foot()}</span>
          <span className="search-keys">{t("search.keys")}</span>
        </div>
      </div>
    </div>
  );

  /** 输入框与文件名过滤框共用这条键位。 */
  function onFieldKey(event: FieldKeyEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      onClose();
      return;
    }
    if (event.altKey && /^[1-3]$/.test(event.key)) {
      setTab(TABS[Number(event.key) - 1]?.key ?? "all");
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      open(rows[caret]);
    }
  }
}
