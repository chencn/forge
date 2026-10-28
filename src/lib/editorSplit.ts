export type EditorSplitDirection = "horizontal" | "vertical";

/** 标签只属于一组；活动项独立于标签目录，避免把整组复制到副栏。 */
export interface EditorSplitState {
  direction: EditorSplitDirection;
  ratio: number;
  tabIds: string[];
  tabId: string;
  primaryActiveId: string | null;
}

export function createEditorSplit(
  tabIds: readonly string[], activeId: string | null, tabId: string,
  direction: EditorSplitDirection, current: EditorSplitState | null = null,
  ratio?: number,
): { split: EditorSplitState; primaryActiveId: string | null } {
  const secondaryIds = [...new Set([...(current?.tabIds ?? []), tabId])];
  const primaryIds = tabIds.filter((id) => !secondaryIds.includes(id));
  const previous = activeId && !secondaryIds.includes(activeId) ? activeId : current?.primaryActiveId;
  const movedAt = tabIds.indexOf(tabId);
  const primaryActiveId = previous && primaryIds.includes(previous)
    ? previous : primaryIds[Math.min(Math.max(0, movedAt), primaryIds.length - 1)] ?? null;
  return {
    split: { direction, ratio: ratio ?? current?.ratio ?? 50, tabIds: secondaryIds, tabId, primaryActiveId },
    primaryActiveId,
  };
}

/** 目录决定标签是否存在，分组只保存归属，异步打开期间也不会复制其他标签。 */
export function partitionEditorTabs<T extends { id: string }>(
  tabs: readonly T[], split: EditorSplitState | null,
): { primary: T[]; secondary: T[] } {
  const secondaryIds = new Set(split?.tabIds ?? []);
  return {
    primary: tabs.filter((tab) => !secondaryIds.has(tab.id)),
    secondary: tabs.filter((tab) => secondaryIds.has(tab.id)),
  };
}

/** 标签栏登记。指针拖动靠它找到另一栏的放下回调；WebView2 会吞掉 HTML5 拖放。 */
export interface EditorTabListRegistration {
  ids: readonly string[];
  onImport?: (id: string, beforeId: string | null) => void;
}
const editorTabLists = new Map<string, EditorTabListRegistration>();
let editorTabListSeq = 0;
export function createEditorTabListId() { editorTabListSeq += 1; return `editor-tabs-${editorTabListSeq}`; }
export function registerEditorTabList(id: string, list: EditorTabListRegistration) { editorTabLists.set(id, list); }
export function unregisterEditorTabList(id: string) { editorTabLists.delete(id); }
export function editorTabList(id: string) { return editorTabLists.get(id) ?? null; }

/**
 * 指针落点换成插入位置。`beforeId` 为空表示接到该栏末尾；返回 null 表示这一下落无效。
 * 落在标签左半边插到它前面，右半边插到它后面。
 */
export function editorTabDropTarget(
  fromId: string,
  ids: readonly string[],
  acceptExternal: boolean,
  tabId: string | null,
  after: boolean,
): { beforeId: string | null } | null {
  const local = ids.includes(fromId);
  if (!local && !acceptExternal) return null;
  if (tabId === fromId) return null;
  const others = ids.filter((id) => id !== fromId);
  if (!tabId || !ids.includes(tabId)) return local && others.length === 0 ? null : { beforeId: null };
  if (!after) return { beforeId: tabId };
  const next = ids[ids.indexOf(tabId) + 1];
  return next && next !== fromId ? { beforeId: next } : { beforeId: null };
}

/**
 * 把一颗标签插进目标栏的顺序。
 * `beforeId` 是目标栏里的落点；为空则接到该栏现有标签的后面。分组归属由调用方改。
 */
export function relocateEditorTab(
  order: readonly string[],
  secondaryIds: readonly string[],
  id: string,
  beforeId: string | null,
  pane: "primary" | "secondary",
): string[] {
  const next = order.filter((tab) => tab !== id);
  if (beforeId && beforeId !== id) {
    const at = next.indexOf(beforeId);
    next.splice(at < 0 ? next.length : at, 0, id);
    return next;
  }
  const secondary = new Set(secondaryIds);
  const destination = next.filter((tab) => pane === "secondary" ? secondary.has(tab) : !secondary.has(tab));
  const last = destination.at(-1);
  if (!last) { next.push(id); return next; }
  next.splice(next.indexOf(last) + 1, 0, id);
  return next;
}

/** 草稿创建为正式会话时只替换身份，分组、活动项和布局原样保留。 */
export function replaceEditorSplitTab(split: EditorSplitState | null, from: string, to: string): EditorSplitState | null {
  if (!split) return null;
  const replace = (id: string) => id === from ? to : id;
  return { ...split, tabIds: split.tabIds.map(replace), tabId: replace(split.tabId),
    primaryActiveId: split.primaryActiveId ? replace(split.primaryActiveId) : null };
}
