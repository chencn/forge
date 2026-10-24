import { Loader2 } from "lucide-react";
import { useI18n } from "../i18n";
import type { AiSearchState } from "../hooks/useAiSessionSearch";
import { groupAiSearchHits, normalizeSearchQuery, splitAiSearchSnippet } from "../lib/aiSearch";
import AiProviderIcon from "./AiProviderIcon";

interface AiSearchResultsProps {
  /** 搜索状态；`query`/`archived` 与当前输入不一致时这里什么都不会显示。 */
  state: AiSearchState;
  /** 当前输入框里的查询词与范围——结果只在两者都对得上时才亮出来。 */
  query: string;
  archived: boolean;
  /** 点一条命中：打开它所属的会话。归档过的会话照样能打开，取消归档在列表里做。 */
  onOpen: (sessionId: string) => void;
}

/**
 * 会话正文搜索的结果区。
 *
 * 三条底线：
 * 一、结果必须标清它属于哪次查询，切换「含已归档」时不拿旧范围的命中冒充新结论；
 * 二、后端说「没扫完」或「有会话读不出」，这里就照说，不让用户以为看到了全部；
 * 三、高亮只按后端给的偏移切，切不出来的部分宁可不标。
 */
export default function AiSearchResults({ state, query, archived, onOpen }: AiSearchResultsProps) {
  const { t } = useI18n();
  // 查询词或范围已经变了：这一次搜索还没重新落地，旧的命中一条都不显示。
  if (state.query !== normalizeSearchQuery(query) || state.archived !== archived) return null;
  if (state.status === "loading") {
    return <p className="ai-search-status"><Loader2 size={13} className="is-spinning" aria-hidden="true" />{t("ai.search.searching")}</p>;
  }
  if (state.status === "failed") return <p className="ai-error" role="alert">{state.error}</p>;
  if (state.status !== "ready" || !state.result) return null;
  const { hits, scanned, skipped, truncated } = state.result;
  if (!hits.length) {
    return <div className="ai-search-results">
      <p className="ai-search-status">{t("ai.search.none", { query })}</p>
      {skipped ? <p className="ai-search-coverage">{t("ai.search.skipped", { count: skipped })}</p> : null}
      {truncated ? <p className="ai-search-coverage">{t("ai.search.partial")}</p> : null}
    </div>;
  }
  const groups = groupAiSearchHits(hits);
  return <div className="ai-search-results">
    <p className="ai-search-count">{t("ai.search.count", { count: hits.length, sessions: groups.length, scanned })}</p>
    {truncated ? <p className="ai-search-coverage">{t("ai.search.partial")}</p> : null}
    {skipped ? <p className="ai-search-coverage">{t("ai.search.skipped", { count: skipped })}</p> : null}
    <ul className="ai-search-group-list" aria-label={t("ai.search.results")}>
      {groups.map((group) => <li key={group.sessionId} className="ai-search-group">
        <button type="button" className="ai-search-group-head" onClick={() => onOpen(group.sessionId)}
          title={`${group.sessionTitle}`} aria-label={`${t("ai.search.open")} ${group.sessionTitle}`}>
          <AiProviderIcon provider={group.provider} size={14} /><span>{group.sessionTitle || t("ai.search.untitled")}</span>
        </button>
        <ul className="ai-search-hit-list">
          {group.hits.map((hit, index) => {
            const snippet = splitAiSearchSnippet(hit);
            return <li key={`${hit.seq}:${index}`}>
              <button type="button" className="ai-search-hit" onClick={() => onOpen(hit.sessionId)}>
                {snippet.leading ? <span className="ai-search-cut" aria-hidden="true">…</span> : null}
                <span>{snippet.before}<mark className="ai-search-mark">{snippet.match}</mark>{snippet.after}</span>
                {snippet.trailing ? <span className="ai-search-cut" aria-hidden="true">…</span> : null}
              </button>
            </li>;
          })}
        </ul>
      </li>)}
    </ul>
  </div>;
}
