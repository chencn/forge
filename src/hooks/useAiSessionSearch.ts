import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { AI_SEARCH_DEBOUNCE_MS, AI_SEARCH_MIN_QUERY, createAiSearchTracker, normalizeSearchQuery, searchAiSessions } from "../lib/aiSearch";
import type { AiSearchResult } from "../lib/aiSearch";

/** 一次搜索的进行状态。`status` 与结果必须成对出现，不能各说各话。 */
export interface AiSearchState {
  /**
   * `idle` 没在查（空输入、太短、或不在桌面端）；`loading` 已决定要扫盘，还没回来；
   * `ready` 有结论；`failed` 是没搜成——它和「没有命中」是两件事，界面必须分开说。
   */
  status: "idle" | "loading" | "ready" | "failed";
  result: AiSearchResult | null;
  error: string | null;
  /** 这份结论对应哪个查询词…… */
  query: string;
  /** ……以及对应哪一档搜索范围（含不含已归档）。 */
  archived: boolean;
}

const IDLE: AiSearchState = { status: "idle", result: null, error: null, query: "", archived: false };

/**
 * 会话正文搜索的节流与归属判定。
 *
 * 后端每次查询都要重扫会话日志，所以这里做三件事：等输入停下来再发；
 * 用令牌丢掉晚到的旧结果；把结论和它所属的（查询词、范围）绑在一起交给界面。
 * 少了第三件，切换「含已归档」的瞬间会拿旧范围的命中冒充新范围的结论。
 */
export function useAiSessionSearch(workspace: string | null, raw: string, includeArchived: boolean): AiSearchState {
  const [state, setState] = useState<AiSearchState>(IDLE);
  const tracker = useRef(createAiSearchTracker()).current;
  const query = normalizeSearchQuery(raw);
  useEffect(() => {
    if (!workspace || !isTauri() || query.length < AI_SEARCH_MIN_QUERY) {
      setState((current) => (current === IDLE ? current : IDLE));
      return;
    }
    // 查询词或范围一变，旧结果立刻不再作数：先落到 loading，别让上一条命中继续显示。
    setState((current) => (current.status === "loading" && current.query === query && current.archived === includeArchived
      ? current
      : { status: "loading", result: null, error: null, query, archived: includeArchived }));
    const timer = setTimeout(() => {
      const token = tracker.begin(query);
      void searchAiSessions(workspace, query, includeArchived).then((result) => {
        if (!tracker.settle(token)) return;
        setState({ status: "ready", result, error: null, query, archived: includeArchived });
      }).catch((error) => {
        if (!tracker.settle(token)) return;
        setState({ status: "failed", result: null, error: String(error), query, archived: includeArchived });
      });
    }, AI_SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [includeArchived, query, tracker, workspace]);
  return state;
}
