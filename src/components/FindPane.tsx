import { useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { readFile, searchText, writeFile, type SearchOptions, type TextHit, type TextPage } from "../lib/fs";
import EntryIcon from "./EntryIcon";
import MatchSnippet from "./MatchSnippet";

/** 一个文件连同它在本次结果里的所有命中行。 */
interface FileGroup {
  /** 绝对路径，同一个文件的多行命中靠它归到一起。 */
  path: string;
  /** 显示名。 */
  name: string;
  /** 所在目录相对工作区根，`/` 连接。 */
  container: string;
  /** 命中行，按后端给的顺序。 */
  hits: TextHit[];
}

interface FindPaneProps {
  /** 工作区根；替换时按它重扫全量命中。没有工程时替换不可用。 */
  root: string | null;
  /** 这次搜的词，原样回显。 */
  query: string;
  /** 这次的开关，状态行要说清是按哪一档搜的。 */
  options: SearchOptions;
  /** 结果；还在搜或一次都没搜过时为 null。 */
  page: TextPage | null;
  /** 非空表示这趟来自「在文件中替换」：多出替换栏与「全部替换」。 */
  replaceWith: string | null;
  /** 正在扫盘，这一档要把旧结果压暗而不是清空。 */
  running: boolean;
  /** 这一趟失败的原因，已经翻成界面语言；为空表示没失败。 */
  error: string | null;
  /** 打开某一行命中：落进编辑器并停到那一行。 */
  onOpen: (hit: TextHit) => void;
}

/** 全量重扫的命中行上限：替换要覆盖整个作用域，不能只认结果页里的那一截。 */
const REPLACE_SCAN_LIMIT = 200_000;

/**
 * 把一行的命中区间（列号 1 起、按出现顺序）替换成 `replacement`，返回新行。
 * 从右往左改，前面的列号才不会因为前面的改动而漂移；零长度命中（正则 `^` 之类）按插入处理。
 */
function replaceInLine(
  line: string,
  ranges: ReadonlyArray<{ column: number; length: number }>,
  replacement: string
): string {
  let out = line;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const start = ranges[i]!.column - 1;
    const end = start + ranges[i]!.length;
    if (start < 0 || end > out.length) continue;
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  return out;
}

/**
 * 底部「查找」工具窗口：按文件分组的正文命中。
 *
 * IDEA 的 Find 窗口就是这个形状——文件名一行，底下每条命中带着行号和那一行的预览，
 * 命中的片段涂亮；双击落进编辑器。替换模式（Replace in Files）下多一条替换栏，
 * 「全部替换」按后端算好的命中区间逐文件改写——区间口径天然兼容大小写/整词/正则。
 */
export default function FindPane({
  root,
  query,
  options,
  page,
  replaceWith,
  running,
  error,
  onOpen
}: FindPaneProps) {
  const { t } = useI18n();
  const [caret, setCaret] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  // 替换是异步长活：跑完时如果这趟结果已被新一趟覆盖，就地收手不写文件。
  const runIdRef = useRef(0);

  const groups = useMemo<FileGroup[]>(() => {
    const out: FileGroup[] = [];
    for (const hit of page?.hits ?? []) {
      const last = out[out.length - 1];
      if (last && last.path === hit.path) last.hits.push(hit);
      else out.push({ path: hit.path, name: hit.name, container: hit.container, hits: [hit] });
    }
    return out;
  }, [page]);

  const flags = () => {
    const parts: string[] = [];
    if (options.caseSensitive) parts.push(t("search.option.case"));
    if (options.wholeWords) parts.push(t("search.option.words"));
    if (options.regex) parts.push(t("search.option.regex"));
    const mask = (options.fileMask ?? "").trim();
    if (mask) parts.push(t("find.fileMask", { mask }));
    return parts;
  };

  const occurrences = groups.reduce((sum, group) => sum + group.hits.length, 0);

  /** 全部替换：重扫全量命中 → 逐文件读改写；打开中的干净文档由 watcher 回声刷新。 */
  const replaceAll = async () => {
    if (!root || !page || replacing) return;
    const runId = ++runIdRef.current;
    // 先按当前作用域重扫一遍拿全量命中；结果页只是分页片段，直接替换会漏。
    let full: TextPage;
    try {
      full = await searchText(root, page.query, { ...options, limit: REPLACE_SCAN_LIMIT });
    } catch (err) {
      setSummary(String(err));
      return;
    }
    if (runIdRef.current !== runId) return;

    const byPath = new Map<string, TextHit[]>();
    for (const hit of full.hits) {
      const list = byPath.get(hit.path);
      if (list) list.push(hit);
      else byPath.set(hit.path, [hit]);
    }

    let replacements = 0;
    let files = 0;
    const failures: string[] = [];
    setReplacing(true);
    try {
      for (const [path, hits] of byPath) {
        if (runIdRef.current !== runId) return;
        try {
          const file = await readFile(path);
          const lines = file.contents.split("\n");
          let count = 0;
          for (const hit of hits) {
            const line = lines[hit.line - 1];
            if (line === undefined) continue;
            lines[hit.line - 1] = replaceInLine(line, hit.ranges, replaceWith ?? "");
            count += hit.ranges.length;
          }
          if (count === 0) continue;
          await writeFile(path, lines.join("\n"), file.lineEnding, file.hasBom, file.encoding, file.modifiedMs);
          replacements += count;
          files += 1;
        } catch (err) {
          failures.push(`${path}: ${String(err)}`);
        }
      }
    } finally {
      setReplacing(false);
    }
    if (runIdRef.current !== runId) return;
    setSummary(
      failures.length > 0
        ? t("find.replace.doneWithFailures", { occurrences: replacements, files, failures: failures.length })
        : t("find.replace.done", { occurrences: replacements, files })
    );
  };

  const confirmReplace = () => {
    if (!page) return;
    const total = groups.reduce((sum, group) => sum + group.hits.reduce((n, hit) => n + hit.ranges.length, 0), 0);
    const confirmed = window.confirm(
      t("find.replace.confirm", {
        occurrences: total,
        files: page.files,
        query: page.query,
        replacement: replaceWith ?? ""
      })
    );
    if (confirmed) void replaceAll();
  };

  return (
    <div className={`find-pane${running ? " is-busy" : ""}`}>
      <p className="find-status">
        <span className="find-query">{query}</span>
        {flags().map((flag) => (
          <span key={flag} className="find-flag">
            {flag}
          </span>
        ))}
        <span className="find-count">
          {error
            ? error
            : running
              ? t("search.busy")
              : t("find.summary", { occurrences, files: page?.files ?? 0 })}
        </span>
      </p>

      {replaceWith !== null && !error ? (
        <div className="find-replace-bar">
          <span className="find-replace-label">{t("find.replace.with")}</span>
          <code className="find-replace-text">{replaceWith}</code>
          <button
            type="button"
            className="find-replace-button"
            disabled={replacing || occurrences === 0}
            onClick={confirmReplace}
          >
            {replacing ? t("find.replace.running") : t("find.replace.all")}
          </button>
          {summary ? <span className="find-replace-summary">{summary}</span> : null}
        </div>
      ) : null}

      {!error && page?.truncated ? <p className="find-note">{t("find.truncated")}</p> : null}
      {!error && page && page.skipped > 0 ? (
        <p className="find-note">{t("find.skipped", { count: page.skipped })}</p>
      ) : null}

      {!error && occurrences === 0 && !running ? (
        <p className="find-note">{t("find.none", { query })}</p>
      ) : null}

      {groups.map((group) => (
        <section className="find-file" key={group.path}>
          <h3 className="find-file-head">
            <EntryIcon name={group.name} size={14} />
            <span className="find-file-name">{group.name}</span>
            {group.container ? <span className="find-file-dir">{group.container}</span> : null}
            <span className="find-file-count">
              {t("find.fileCount", { count: group.hits.length })}
            </span>
          </h3>
          <ul className="find-rows">
            {group.hits.map((hit) => {
              const id = `${hit.path}|${hit.line}`;
              return (
                <li key={id}>
                  <div
                    className={`find-row${caret === id ? " is-active" : ""}`}
                    tabIndex={0}
                    onMouseEnter={() => setCaret(id)}
                    onDoubleClick={() => onOpen(hit)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        onOpen(hit);
                      }
                    }}
                  >
                    <span className="find-line-no">{hit.line}</span>
                    <span className="find-line-text">
                      <MatchSnippet hit={hit} />
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
