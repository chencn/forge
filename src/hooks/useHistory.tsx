import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { saveHistory, withRemembered } from "../lib/history";
import type { History } from "../lib/history";

/** 那三份「最近」列表的键；`lastFolder` 是单值，不走 `remember`。 */
export type RecentKey = "recentFolders" | "recentBranches" | "commitMessages";

interface HistoryValue {
  /** 当前生效的历史记录。 */
  history: History;
  /** 局部覆盖后整份写回文件。 */
  patch: (next: Partial<History>) => void;
  /** 往一份「最近」列表前面插一条，重复的挪到最前，超出上限截掉。 */
  remember: (key: RecentKey, value: string) => void;
}

const HistoryContext = createContext<HistoryValue | null>(null);

/** 读历史记录；提供者拿不到就直接报错，历史是渲染工作区的前提。 */
export function useHistory(): HistoryValue {
  const value = useContext(HistoryContext);
  if (!value) throw new Error("useHistory 必须在 HistoryProvider 内使用");
  return value;
}

interface HistoryProviderProps {
  /** 入口在渲染前读好的那份记录，工作区根的第一帧就要用它。 */
  initial: History;
  children: ReactNode;
}

export function HistoryProvider({ initial, children }: HistoryProviderProps) {
  const [history, setHistory] = useState<History>(initial);

  const patch = useCallback((next: Partial<History>) => {
    setHistory((current) => ({ ...current, ...next }));
  }, []);

  const remember = useCallback(
    (key: RecentKey, value: string) => {
      if (!value) return;
      setHistory((current) => ({ ...current, [key]: withRemembered(current[key], value) }));
    },
    []
  );

  // 任何一处改动都整份落盘，文件始终是最新状态。
  useEffect(() => {
    void saveHistory(history);
  }, [history]);

  return (
    <HistoryContext.Provider value={{ history, patch, remember }}>{children}</HistoryContext.Provider>
  );
}
