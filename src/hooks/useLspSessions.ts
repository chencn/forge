import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lspSessionStatuses } from "../lib/lsp";
import type { LspSessionStatus } from "../lib/lsp";
import { windowLabel } from "../lib/window";

/** 轮询间隔。底部状态条与设置页共用这一份结果，不再各排各的定时器。 */
const POLL_MS = 3000;

export interface LspSessions {
  /** 按 server 键归组的会话。一条 server 因为多个工程根可以同时有多条。 */
  byServer: Record<string, LspSessionStatus[]>;
  /** 最近一轮没读到。留着上一轮的数据，只把这个标志置起来，不清空列表。 */
  stale: boolean;
  /** 立刻补一轮：重启过进程之后不想等下一个间隔。 */
  refresh: () => void;
}

/** 判断两组会话状态列表的关键业务字段是否一致，避免无变动时刷新引用触发重渲染。 */
function sameGrouped(
  a: Record<string, LspSessionStatus[]>,
  b: Record<string, LspSessionStatus[]>
): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    const listA = a[key];
    const listB = b[key];
    if (!listB || listA.length !== listB.length) return false;
    for (let i = 0; i < listA.length; i += 1) {
      const itemA = listA[i];
      const itemB = listB[i];
      if (
        itemA.id !== itemB.id ||
        itemA.status !== itemB.status ||
        itemA.restartCount !== itemB.restartCount ||
        itemA.error !== itemB.error
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * 当前窗口的语言服务会话状态。
 *
 * 采的是进程存活，不是索引就绪。`active` 为假时不占请求（没开工程、或一栏都没显示时）。
 */
export function useLspSessions(active: boolean): LspSessions {
  const [byServer, setByServer] = useState<Record<string, LspSessionStatus[]>>({});
  const [stale, setStale] = useState(false);
  // 每一轮一个序号：慢响应回来时若已被更新的一轮超过，直接丢掉，旧快照盖不掉新快照。
  const epoch = useRef(0);

  const fetchOnce = useCallback(async (): Promise<void> => {
    const mine = ++epoch.current;
    try {
      const items = await lspSessionStatuses(windowLabel);
      if (mine !== epoch.current) return;
      const grouped: Record<string, LspSessionStatus[]> = {};
      for (const item of items) {
        const list = grouped[item.server] ?? [];
        list.push(item);
        grouped[item.server] = list;
      }
      setByServer((prev) => (sameGrouped(prev, grouped) ? prev : grouped));
      setStale(false);
    } catch {
      if (mine === epoch.current) setStale(true);
    }
  }, []);

  useEffect(() => {
    if (!active) {
      epoch.current += 1;
      setByServer({});
      setStale(false);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 上一次落定之后再排下一次，不在慢响应上叠发。
    const loop = async (): Promise<void> => {
      await fetchOnce();
      if (!disposed) timer = setTimeout(() => void loop(), POLL_MS);
    };
    void loop();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, fetchOnce]);

  const refresh = useCallback(() => void fetchOnce(), [fetchOnce]);

  return useMemo(() => ({ byServer, stale, refresh }), [byServer, refresh, stale]);
}
