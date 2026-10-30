/**
 * 变更列表（changelist）：把一批变更归成组，方便只提交其中一部分。
 *
 * 模型照 IntelliJ IDEA 的 Local Changes：有一个默认列表（永远存在、删不掉），
 * 文件可以挪到别的列表，其中一个列表是「活动」的——新出现的变更默认落进它，
 * 树里它加粗。勾选提交的口径在提交面板那边，这里只管归组。
 *
 * 持久化走 localStorage，键按仓库根分开：搬机器或换工作区互不串。
 */

/** 一个变更列表；`default` 那条由代码兜底，不落盘也行。 */
export interface Changelist {
  id: string;
  name: string;
  /** 说明（IDEA 的 Comment）；空串没有。 */
  comment: string;
}

/** 每仓库的持久化形状：列表定义 + 「路径 → 列表」的归属 + 活动列表。 */
export interface ChangelistsState {
  lists: Changelist[];
  /** 仓库相对路径 → 列表 id；没记录的路径视为默认列表。 */
  moves: Record<string, string>;
  activeId: string;
}

export const DEFAULT_LIST_ID = "default";

/** 界面上默认列表的显示名走 i18n；落盘里不存这条的名字。 */
export function defaultChangelist(): Changelist {
  return { id: DEFAULT_LIST_ID, name: "", comment: "" };
}

const storageKey = (root: string) => `forge:vcs:changelists:v1:${root}`;

export function loadChangelists(root: string): ChangelistsState {
  try {
    const raw = localStorage.getItem(storageKey(root));
    if (!raw) return { lists: [], moves: {}, activeId: DEFAULT_LIST_ID };
    const parsed = JSON.parse(raw) as Partial<ChangelistsState>;
    const lists = Array.isArray(parsed.lists)
      ? parsed.lists.filter(
          (list): list is Changelist =>
            !!list && typeof list.id === "string" && list.id !== DEFAULT_LIST_ID
        )
      : [];
    const moves: Record<string, string> = {};
    if (parsed.moves && typeof parsed.moves === "object") {
      const ids = new Set([DEFAULT_LIST_ID, ...lists.map((list) => list.id)]);
      for (const [path, id] of Object.entries(parsed.moves)) {
        if (typeof id === "string" && ids.has(id)) moves[path] = id;
      }
    }
    const activeId =
      parsed.activeId === DEFAULT_LIST_ID || lists.some((list) => list.id === parsed.activeId)
        ? parsed.activeId!
        : DEFAULT_LIST_ID;
    return { lists, moves, activeId };
  } catch {
    return { lists: [], moves: {}, activeId: DEFAULT_LIST_ID };
  }
}

export function saveChangelists(root: string, state: ChangelistsState): void {
  try {
    localStorage.setItem(storageKey(root), JSON.stringify(state));
  } catch {
    // 存不下就算了（隐私模式/超配额）：内存里的那份还管着本次会话。
  }
}

/** 新列表的 id：可读、够唯一（同毫秒两条的概率不必防）。 */
export function newChangelistId(): string {
  return `cl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 路径归属的列表 id；没有显式记录就归默认列表。 */
export function listIdOf(state: ChangelistsState, path: string): string {
  return state.moves[path] ?? DEFAULT_LIST_ID;
}

/** 把一组路径挪进某个列表（覆盖旧归属）。 */
export function moveTo(state: ChangelistsState, paths: string[], listId: string): ChangelistsState {
  const moves = { ...state.moves };
  if (listId === DEFAULT_LIST_ID) {
    for (const path of paths) delete moves[path];
  } else {
    for (const path of paths) moves[path] = listId;
  }
  return { ...state, moves };
}

/** 文件从清单里消失后回收它的归属记录，免得 moves 只增不减。 */
export function pruneMoves(state: ChangelistsState, alive: string[]): ChangelistsState {
  const aliveSet = new Set(alive);
  const moves: Record<string, string> = {};
  let dropped = false;
  for (const [path, id] of Object.entries(state.moves)) {
    if (aliveSet.has(path)) moves[path] = id;
    else dropped = true;
  }
  return dropped ? { ...state, moves } : state;
}

/**
 * 新出现的变更落进活动列表：把还没记录归属的路径补上 `activeId`。
 * 前提是调用方已用 {@link pruneMoves} 清过亡者，才分得清「新文件」和「没挪过窝」。
 */
export function assignNew(state: ChangelistsState, paths: string[]): ChangelistsState {
  let changed = false;
  const moves = { ...state.moves };
  for (const path of paths) {
    if (!(path in state.moves)) {
      if (state.activeId === DEFAULT_LIST_ID) continue;
      moves[path] = state.activeId;
      changed = true;
    }
  }
  return changed ? { ...state, moves } : state;
}
