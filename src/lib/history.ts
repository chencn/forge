import { invoke } from "@tauri-apps/api/core";

/**
 * 用户做过的那些事，落在系统配置目录的 history.json。
 *
 * 和 `settings.json` 分开：那里面是偏好（主题、字号），几个月不动一次；这四项每次开项目、
 * 每次切分支、每次提交都要整份重写。混在一份文件里，设置文件就天天被重写一遍。
 */
export interface History {
  /** 上次打开的文件夹；空串表示没有。启动时据此恢复工作区。 */
  lastFolder: string;
  /** 最近打开过的文件夹，新的在前；主工具栏的工程下拉列这份。 */
  recentFolders: string[];
  /** 最近签出过的分支，新的在前。 */
  recentBranches: string[];
  /** 用过的提交说明，新的在前；提交框的历史菜单列这份。 */
  commitMessages: string[];
}

export const DEFAULT_HISTORY: History = {
  lastFolder: "",
  recentFolders: [],
  recentBranches: [],
  commitMessages: [],
};

/** 每份列表只留最近若干条，久了会把弹层撑满。 */
export const RECENT_CAP = 8;

/** 往一份「最近」列表前面插一条：重复的挪到最前，超出上限的尾部截掉。 */
export function withRemembered(list: string[], value: string): string[] {
  return [value, ...list.filter((item) => item !== value)].slice(0, RECENT_CAP);
}

/** 老文件缺字段时逐层补默认值，改结构不用迁移。 */
function merge(raw: Partial<History> | null): History {
  return {
    lastFolder: raw?.lastFolder ?? "",
    recentFolders: raw?.recentFolders ?? [],
    recentBranches: raw?.recentBranches ?? [],
    commitMessages: raw?.commitMessages ?? [],
  };
}

/** 读历史记录；没有 Tauri 注入（纯浏览器跑前端）时退回空表。 */
export async function loadHistory(): Promise<History> {
  try {
    return merge(await invoke<Partial<History>>("history_load"));
  } catch {
    return DEFAULT_HISTORY;
  }
}

/** 整份写回；纯浏览器里失败就忽略。 */
export function saveHistory(history: History): Promise<void> {
  return invoke<void>("history_save", { history }).catch(() => {});
}
