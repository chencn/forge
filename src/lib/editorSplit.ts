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
): { split: EditorSplitState; primaryActiveId: string | null } {
  const secondaryIds = [...new Set([...(current?.tabIds ?? []), tabId])];
  const primaryIds = tabIds.filter((id) => !secondaryIds.includes(id));
  const previous = activeId && !secondaryIds.includes(activeId) ? activeId : current?.primaryActiveId;
  const movedAt = tabIds.indexOf(tabId);
  const primaryActiveId = previous && primaryIds.includes(previous)
    ? previous : primaryIds[Math.min(Math.max(0, movedAt), primaryIds.length - 1)] ?? null;
  return {
    split: { direction, ratio: current?.ratio ?? 50, tabIds: secondaryIds, tabId, primaryActiveId },
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

/** 草稿创建为正式会话时只替换身份，分组、活动项和布局原样保留。 */
export function replaceEditorSplitTab(split: EditorSplitState | null, from: string, to: string): EditorSplitState | null {
  if (!split) return null;
  const replace = (id: string) => id === from ? to : id;
  return { ...split, tabIds: split.tabIds.map(replace), tabId: replace(split.tabId),
    primaryActiveId: split.primaryActiveId ? replace(split.primaryActiveId) : null };
}
