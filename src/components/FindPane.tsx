import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import type { SearchOptions, TextHit, TextPage } from "../lib/fs";
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
  /** 这次搜的词，原样回显。 */
  query: string;
  /** 这次的开关，状态行要说清是按哪一档搜的。 */
  options: SearchOptions;
  /** 结果；还在搜或一次都没搜过时为 null。 */
  page: TextPage | null;
  /** 正在扫盘，这一档要把旧结果压暗而不是清空。 */
  running: boolean;
  /** 这一趟失败的原因，已经翻成界面语言；为空表示没失败。 */
  error: string | null;
  /** 打开某一行命中：落进编辑器并停到那一行。 */
  onOpen: (hit: TextHit) => void;
}

/**
 * 底部「查找」工具窗口：按文件分组的正文命中。
 *
 * IDEA 的 Find 窗口就是这个形状——文件名一行，底下每条命中带着行号和那一行的预览，
 * 命中的片段涂亮；双击落进编辑器。这里不做替换，所以没有替换那一列。
 */
export default function FindPane({ query, options, page, running, error, onOpen }: FindPaneProps) {
  const { t } = useI18n();
  const [caret, setCaret] = useState<string | null>(null);

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
