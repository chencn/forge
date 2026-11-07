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

/** 全局搜索窗格的入参。 */
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
 * 命中行唯一键：行粒度（一行多命中一起 Replace/Skip）。
 */
const hitKey = (path: string, line: number) => `${path}|${line}`;

/**
 * Preserve Case：按命中词的形态调整替换词——全大写命中给全大写替换，
 * 首字母大写命中给首字母大写替换，其余原样。
 */
function applyCase(replacement: string, matched: string): string {
  if (!replacement) return replacement;
  const letters = matched.replace(/\P{L}/gu, "");
  if (letters.length > 1 && letters === letters.toUpperCase()) {
    return replacement.toUpperCase();
  }
  const first = letters[0];
  if (first && first !== first.toLowerCase() && first === first.toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * 把一行的命中区间（列号 1 起、按出现顺序）替换掉，`replacement` 按每个命中原文
 * 现算（preserveCase 用）。从右往左改，前面的列号才不会因为前面的改动而漂移；
 * 零长度命中（正则 `^` 之类）按插入处理。
 */
function replaceInLine(
  line: string,
  ranges: ReadonlyArray<{ column: number; length: number }>,
  replacementOf: (matched: string) => string
): string {
  let out = line;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const start = ranges[i]!.column - 1;
    const end = start + ranges[i]!.length;
    if (start < 0 || end > out.length) continue;
    out = out.slice(0, start) + replacementOf(out.slice(start, end)) + out.slice(end);
  }
  return out;
}

/** 替换预览里的一行：一个文件和它的全量命中。 */
interface PreviewFile {
  path: string;
  name: string;
  container: string;
  /** 该文件的命中行数（不含被逐处跳过的）。 */
  count: number;
}

/**
 * 底部「查找」工具窗口：按文件分组的正文命中。
 *
 * 命中按文件分组：文件名一行，底下每条命中带着行号和那一行的预览，
 * 命中的片段涂亮；双击落进编辑器。替换模式（Replace in Files）下多一条替换栏：
 * 「全部替换」先开受影响文件预览（可按文件排除），确认后按后端算好的命中区间逐文件
 * 改写——区间口径天然兼容大小写/整词/正则；每条命中行可逐处 Replace/Skip。
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
  // Preserve Case 与逐处跳过：会话级状态，新一轮搜索自然失效（key 带行号，结果变了就失配）。
  const [preserveCase, setPreserveCase] = useState(false);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [replacedRows, setReplacedRows] = useState<Set<string>>(new Set());
  // 替换预览：null 表示没开；开了展示受影响文件清单，确认才落盘。
  const [preview, setPreview] = useState<PreviewFile[] | null>(null);
  const [previewTotal, setPreviewTotal] = useState(0);
  const [previewExcluded, setPreviewExcluded] = useState<Set<string>>(new Set());
  // 替换是异步长活：跑完时如果这趟结果已被新一趟覆盖，就地收手不写文件。
  const runIdRef = useRef(0);
  // 预览确认时要用的全量命中（path → hits）；预览开着期间不会被新一轮搜索覆盖（runId 挡）。
  const fullHitsRef = useRef<Map<string, TextHit[]>>(new Map());

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

  const occurrences = groups.reduce(
    (sum, group) => sum + group.hits.filter((hit) => !skipped.has(hitKey(hit.path, hit.line)) && !replacedRows.has(hitKey(hit.path, hit.line))).reduce((n, hit) => n + hit.ranges.length, 0),
    0
  );

  /** 替换词的现算口径：preserveCase 按每个命中的原文调形态。 */
  const replacementOf = (matched: string) =>
    preserveCase ? applyCase(replaceWith ?? "", matched) : (replaceWith ?? "");

  /**
   * 改写一个文件的一批行并写盘；返回替换的命中数。跳过 skipped/replaced 的行。
   * 失败抛错，由调用方记账。
   */
  const rewriteFile = async (path: string, hits: TextHit[], excluded: Set<string>): Promise<number> => {
    const usable = hits.filter((hit) => {
      const key = hitKey(hit.path, hit.line);
      return !skipped.has(key) && !replacedRows.has(key) && !excluded.has(path);
    });
    if (usable.length === 0) return 0;
    const file = await readFile(path);
    const lines = file.contents.split("\n");
    let count = 0;
    for (const hit of usable) {
      const line = lines[hit.line - 1];
      if (line === undefined) continue;
      lines[hit.line - 1] = replaceInLine(line, hit.ranges, replacementOf);
      count += hit.ranges.length;
    }
    if (count === 0) return 0;
    await writeFile(path, lines.join("\n"), file.lineEnding, file.hasBom, file.encoding, file.modifiedMs);
    return count;
  };

  /** 预览确认后的执行：按文件逐个读改写（带各自的全量命中）。 */
  const runPreview = async (byPath: Map<string, TextHit[]>) => {
    if (!page || replacing) return;
    const runId = ++runIdRef.current;
    let replacements = 0;
    let files = 0;
    const failures: string[] = [];
    setReplacing(true);
    try {
      for (const entry of preview ?? []) {
        if (runIdRef.current !== runId) return;
        if (previewExcluded.has(entry.path)) continue;
        try {
          const count = await rewriteFile(entry.path, byPath.get(entry.path) ?? [], new Set());
          if (count === 0) continue;
          replacements += count;
          files += 1;
        } catch (err) {
          failures.push(`${entry.path}: ${String(err)}`);
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

  /** 点「全部替换」：重扫全量命中，开受影响文件预览（可按文件排除）。 */
  const openPreview = async () => {
    if (!root || !page || replacing) return;
    const runId = ++runIdRef.current;
    let full: TextPage;
    try {
      full = await searchText(root, page.query, { ...options, limit: REPLACE_SCAN_LIMIT });
    } catch (err) {
      setSummary(String(err));
      return;
    }
    if (runIdRef.current !== runId) return;

    const byPath = new Map<string, TextHit[]>();
    let total = 0;
    for (const hit of full.hits) {
      const key = hitKey(hit.path, hit.line);
      if (skipped.has(key) || replacedRows.has(key)) continue;
      const list = byPath.get(hit.path);
      if (list) list.push(hit);
      else byPath.set(hit.path, [hit]);
    }
    const files: PreviewFile[] = [];
    for (const [path, hits] of byPath) {
      let count = 0;
      for (const hit of hits) count += hit.ranges.length;
      if (count === 0) continue;
      total += count;
      files.push({ path, name: hits[0]!.name, container: hits[0]!.container, count });
    }
    if (files.length === 0) {
      setSummary(t("find.none", { query: page.query }));
      return;
    }
    fullHitsRef.current = byPath;
    setPreviewExcluded(new Set());
    setPreviewTotal(total);
    setPreview(files);
  };

  /** 预览里点「替换」：落盘。 */
  const confirmPreview = () => {
    void runPreview(fullHitsRef.current);
    setPreview(null);
  };

  /** 逐处替换：只改这一行，行从结果里标成已替换。 */
  const replaceRow = async (hit: TextHit) => {
    const key = hitKey(hit.path, hit.line);
    try {
      const count = await rewriteFile(hit.path, [hit], new Set());
      if (count > 0) setReplacedRows((current) => new Set(current).add(key));
    } catch (err) {
      setSummary(String(err));
    }
  };

  /** 逐处跳过：这一行从替换与统计里排除（结果列表划掉显示）。 */
  const skipRow = (hit: TextHit) => {
    const key = hitKey(hit.path, hit.line);
    setSkipped((current) => new Set(current).add(key));
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
            className={`find-replace-case${preserveCase ? " is-on" : ""}`}
            title={t("find.replace.preserveCase")}
            aria-pressed={preserveCase}
            onClick={() => setPreserveCase((current) => !current)}
          >
            Aa
          </button>
          <button
            type="button"
            className="find-replace-button"
            disabled={replacing || occurrences === 0}
            onClick={() => void openPreview()}
          >
            {replacing ? t("find.replace.running") : t("find.replace.all")}
          </button>
          {summary ? <span className="find-replace-summary">{summary}</span> : null}
        </div>
      ) : null}

      {preview ? (
        <div className="find-preview" role="dialog" aria-label={t("find.replace.previewTitle")}>
          <p className="find-preview-head">
            {t("find.replace.previewTitle", {
              occurrences: previewTotal,
              files: preview.length
            })}
          </p>
          <ul className="find-preview-list">
            {preview.map((entry) => (
              <li key={entry.path} className="find-preview-row">
                <label>
                  <input
                    type="checkbox"
                    checked={!previewExcluded.has(entry.path)}
                    onChange={(event) => {
                      setPreviewExcluded((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.delete(entry.path);
                        else next.add(entry.path);
                        return next;
                      });
                    }}
                  />
                  <EntryIcon name={entry.name} size={13} />
                  <span className="find-file-name">{entry.name}</span>
                  {entry.container ? <span className="find-file-dir">{entry.container}</span> : null}
                  <span className="find-file-count">{entry.count}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="find-preview-actions">
            <button type="button" className="button" onClick={() => setPreview(null)}>
              {t("dialog.cancel")}
            </button>
            <button type="button" className="button is-primary" onClick={confirmPreview}>
              {t("find.replace.previewGo")}
            </button>
          </div>
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
              const isSkipped = skipped.has(id);
              const isReplaced = replacedRows.has(id);
              return (
                <li key={id}>
                  <div
                    className={`find-row${caret === id ? " is-active" : ""}${isSkipped ? " is-skipped" : ""}${isReplaced ? " is-replaced" : ""}`}
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
                    {replaceWith !== null && !isReplaced ? (
                      <span className="find-row-actions">
                        {isSkipped ? (
                          <button
                            type="button"
                            className="find-row-action"
                            title={t("find.replace.include")}
                            onClick={() =>
                              setSkipped((current) => {
                                const next = new Set(current);
                                next.delete(id);
                                return next;
                              })
                            }
                          >
                            {t("find.replace.include")}
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="find-row-action"
                              onClick={() => void replaceRow(hit)}
                            >
                              {t("find.replace.one")}
                            </button>
                            <button
                              type="button"
                              className="find-row-action"
                              onClick={() => skipRow(hit)}
                            >
                              {t("find.replace.skip")}
                            </button>
                          </>
                        )}
                      </span>
                    ) : null}
                    {isReplaced ? (
                      <span className="find-row-done">{t("find.replace.replacedMark")}</span>
                    ) : null}
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
